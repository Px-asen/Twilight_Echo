import { app, nativeTheme } from 'electron'
import { runtime } from '../core/runtime'
import { effectiveAutoMixMode } from '../../shared/twilightAutoMix.ts'
import type { AppSettings, SettingsSnapshot } from '../core/types'
import { createSettingsSnapshot, normalizeAppSettings, writeAppSettings } from '../core/settings'
import type { AudioOutputState } from '../../shared/audioEngineTypes.ts'
import { applyEffectiveAudioProcessingToEngine } from '../audio/state.ts'
import { getWindowBackgroundColor, syncWindowFrameAppearance } from './windowAppearance.ts'
import { ensureMusicCacheDirectories } from '../cache/ncmCache'
import { applyDiscordRpcSetting } from '../integrations/discord'
import {
  applyMiniPlayerMotionPreferenceFromApp,
  applyMiniPlayerSettingsFromApp
} from '../integrations/miniPlayer'
import { syncDesktopLyricsSettings } from '../integrations/desktopLyrics'
import { applyRuntimeSettings } from '../integrations/shortcutsTray'
import { reassertAfterglowShortcuts } from './AfterglowModeService.ts'
import { applyLibraryWatchers } from '../library/watcher'

let settingsUpdateQueue: Promise<void> = Promise.resolve()

export function updateAppSettings(patch: Partial<AppSettings>): Promise<SettingsSnapshot> {
  // All windows and main-process callers share this queue. Build each snapshot
  // only after the preceding update and its asynchronous engine work settle.
  const update = settingsUpdateQueue.then(() => applyAppSettingsPatch(patch))
  settingsUpdateQueue = update.then(
    () => undefined,
    () => undefined
  )
  return update
}

async function applyAppSettingsPatch(patch: Partial<AppSettings>): Promise<SettingsSnapshot> {
  const previousLibraryFolders = runtime.appSettings.libraryFolders ?? []
  let nextSettings = normalizeAppSettings({ ...runtime.appSettings, ...patch })
  if (Object.prototype.hasOwnProperty.call(patch, 'autoMixMode')) {
    const accepted = await runtime.audioEngineManager?.setAutoMixMode(
      effectiveAutoMixMode(nextSettings.autoMixMode)
    )
    if (accepted === false)
      throw new Error('音频引擎未能应用 AutoMix 模式，请检查音频服务状态后重试。')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'audioExclusiveAutoRelease')) {
    await runtime.audioEngineManager?.setExclusiveAutoRelease(
      nextSettings.audioExclusiveAutoRelease
    )
  }
  const previousCachePath = runtime.appSettings.musicCachePath
  const shouldUpdateAudioProcessing = Object.prototype.hasOwnProperty.call(patch, 'audioProcessing')
  const shouldUpdateHeadphoneCompensation = Object.prototype.hasOwnProperty.call(
    patch,
    'headphoneCompensation'
  )
  const shouldUpdateAudioOutputConfig = Object.prototype.hasOwnProperty.call(
    patch,
    'audioOutputConfig'
  )
  const shouldUpdateAudioOutput = Object.prototype.hasOwnProperty.call(patch, 'audioOutput')
  const shouldUpdateAudioDevice = Object.prototype.hasOwnProperty.call(patch, 'audioDevice')
  const shouldUpdateExclusiveMode = Object.prototype.hasOwnProperty.call(
    patch,
    'audioExclusiveMode'
  )
  const shouldUpdateWindowBackground =
    Object.prototype.hasOwnProperty.call(patch, 'theme') ||
    Object.prototype.hasOwnProperty.call(patch, 'appBackground')
  let acknowledgedAudioState: AudioOutputState | undefined
  if (
    runtime.audioEngineManager &&
    (shouldUpdateAudioOutput || shouldUpdateAudioDevice || shouldUpdateExclusiveMode)
  ) {
    let audioState: AudioOutputState
    if (shouldUpdateAudioOutput) {
      audioState = await runtime.audioEngineManager.setAudioOutput(
        nextSettings.audioOutput,
        nextSettings.audioDevice
      )
    } else if (shouldUpdateAudioDevice) {
      audioState = await runtime.audioEngineManager.setAudioDevice(nextSettings.audioDevice)
    } else {
      audioState = await runtime.audioEngineManager.getAudioOutputState()
    }

    if (shouldUpdateExclusiveMode && audioState.exclusiveAvailable) {
      audioState = await runtime.audioEngineManager.setExclusiveMode(
        nextSettings.audioExclusiveMode
      )
    }

    acknowledgedAudioState = audioState
  }

  if (shouldUpdateAudioOutputConfig) {
    await runtime.audioEngineManager?.setOutputConfig(nextSettings.audioOutputConfig)
  }

  // Engine acknowledgements can also persist device-profile customizations.
  // Retain those commits while applying this patch and the effective route.
  nextSettings = normalizeAppSettings({
    ...runtime.appSettings,
    ...patch,
    ...(acknowledgedAudioState
      ? {
          audioOutput: acknowledgedAudioState.output,
          audioDevice: acknowledgedAudioState.device,
          audioExclusiveMode: acknowledgedAudioState.exclusiveMode
        }
      : {})
  })

  // Rejected engine changes must never become the baseline of a later patch.
  // Persist the acknowledged selection before publishing it to runtime consumers.
  writeAppSettings(nextSettings)
  runtime.appSettings = nextSettings
  if (
    Object.prototype.hasOwnProperty.call(patch, 'autoMixStemMode') ||
    Object.prototype.hasOwnProperty.call(patch, 'autoMixStemDevice')
  )
    runtime.audioEngineManager?.invalidateAutoMixSource()
  if (shouldUpdateWindowBackground && runtime.mainWindow) {
    syncWindowFrameAppearance(runtime.mainWindow, nativeTheme.shouldUseHighContrastColors)
  }
  if (shouldUpdateWindowBackground && !runtime.appSettings.windowTransparency) {
    runtime.mainWindow?.setBackgroundColor(
      getWindowBackgroundColor(runtime.appSettings, nativeTheme.shouldUseDarkColors)
    )
  }

  if (
    runtime.appSettings.musicCachePath &&
    runtime.appSettings.musicCachePath !== previousCachePath
  ) {
    try {
      ensureMusicCacheDirectories(runtime.appSettings.musicCachePath)
    } catch (err) {
      console.warn('创建缓存目录失败：', err)
    }
  }

  if (
    (shouldUpdateAudioProcessing || shouldUpdateHeadphoneCompensation) &&
    runtime.audioEngineManager
  ) {
    try {
      await applyEffectiveAudioProcessingToEngine()
    } catch (err) {
      console.warn('应用合成 DSP 设置到音频引擎失败，已保留设置：', err)
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'discordRpcEnabled')) {
    applyDiscordRpcSetting(runtime.appSettings.discordRpcEnabled)
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'taskbarThumbarButtonsEnabled')) {
    runtime.refreshTaskbarThumbarButtons?.()
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'smtcEnabled')) {
    runtime.refreshWindowsSmtc?.()
  }

  if (
    Object.prototype.hasOwnProperty.call(patch, 'remoteControlEnabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'remoteControlPort')
  ) {
    try {
      const { syncRemoteControlWithSettings } = await import('../remote/remoteIpc.ts')
      await syncRemoteControlWithSettings()
    } catch (err) {
      console.warn('[remote] failed to sync remote control with settings:', err)
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(patch, 'libraryFolders') ||
    Object.prototype.hasOwnProperty.call(patch, 'watchLibrary')
  ) {
    // Revoke the database scope before native events or a pending result can
    // observe removed roots. The scan worker rechecks this at commit time.
    await runtime.libraryDatabase?.refreshRoots()
    applyLibraryWatchers(runtime.appSettings.libraryFolders, runtime.appSettings.watchLibrary)
    // Native watchers only report future filesystem changes. Import existing
    // files when a root is added, even when automatic watching is disabled.
    if (Object.prototype.hasOwnProperty.call(patch, 'libraryFolders')) {
      const addedFolders = runtime.appSettings.libraryFolders.filter(
        (folder) => !previousLibraryFolders.includes(folder)
      )
      if (addedFolders.length > 0) {
        ;(runtime.libraryDatabase ?? runtime.localLibraryIndexCoordinator)?.enqueueWatcherChanges(
          addedFolders.map((path) => ({ kind: 'reconcile', path }))
        )
      }
    }
  }

  // Keep already-open lyric controls in sync with the application motion tier.
  if (
    (Object.prototype.hasOwnProperty.call(patch, 'desktopLyrics') ||
      Object.prototype.hasOwnProperty.call(patch, 'lyricsAppearance') ||
      Object.prototype.hasOwnProperty.call(patch, 'motionPreference')) &&
    runtime.desktopLyricsWindow &&
    !runtime.desktopLyricsWindow.isDestroyed()
  ) {
    syncDesktopLyricsSettings()
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'miniPlayer')) {
    applyMiniPlayerSettingsFromApp(runtime.appSettings.miniPlayer)
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'motionPreference')) {
    applyMiniPlayerMotionPreferenceFromApp(runtime.appSettings.motionPreference)
  }

  applyRuntimeSettings()
  // Shortcut re-registration unregisters everything first; restore the
  // Afterglow escape hatch when the UI is currently unloaded.
  reassertAfterglowShortcuts()
  const snapshot = createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  runtime.mainWindow?.webContents.send('settings:changed', snapshot)
  const trayWindow = runtime.trayPlayerWindow
  if (trayWindow && !trayWindow.isDestroyed() && !trayWindow.webContents.isDestroyed()) {
    trayWindow.webContents.send('settings:changed', snapshot)
  }
  return snapshot
}

export function relaunchApplication(): void {
  runtime.forceQuit = true
  app.relaunch({
    args: process.argv.slice(1)
  })
  app.quit()
}
