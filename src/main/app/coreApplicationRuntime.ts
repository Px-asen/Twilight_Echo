import { app, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { setupThemeWorkshopIpc } from '../ipc/themeWorkshop.ts'
import { runtime } from '../core/runtime.ts'
import { createSettingsSnapshot } from '../core/settings.ts'
import { getCoverCacheDir } from '../library/coverCache.ts'
import { createElectronCoreSupervisor } from '../coreProcess/electronSupervisor.ts'
import { CoreWindowBridge } from '../coreProcess/windowBridge.ts'
import { installCoreSettingsBridge } from '../coreProcess/settingsBridge.ts'
import { projectCoreSettings } from '../coreProcess/settingsProjection.ts'
import { installCoreSystemPlayer } from '../integrations/coreSystemPlayer.ts'
import { isTrustedIpcSenderUrl } from '../security/electronSecurity.ts'
import { resolvePluginIndexUrl } from '../plugins/indexService.ts'
import { TWILIGHT_AUTOMIX_AVAILABLE } from '../../shared/twilightAutoMix.ts'
import { CoreApplicationRuntime, installCoreApplication } from './coreApplication.ts'
import { getCoreAfterglowMode } from './coreAfterglowRuntime.ts'

/** Explicit cutover composition. Does not create any legacy music service owner. */
export function createCoreApplication(): CoreApplicationRuntime {
  setupThemeWorkshopIpc()
  const root = app.getPath('userData')
  const settings = runtime.launchSettings
  const bundledRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const supervisor = createElectronCoreSupervisor({
    root,
    libraryFilePath: join(root, 'music-library.json'),
    coverCacheDir: getCoverCacheDir(),
    libraryStorage: 'sqlite',
    musicCachePath: settings.musicCachePath,
    resumeMode: settings.playbackResumeMode,
    autoMixEnabled: TWILIGHT_AUTOMIX_AVAILABLE,
    plugins: {
      appVersion: app.getVersion(),
      index: {
        localPath: join(bundledRoot, 'plugin-index', 'plugins.json'),
        remoteUrl: resolvePluginIndexUrl(process.env.TWILIGHT_PLUGIN_INDEX_URL)
      },
      developerMode: settings.developerMode,
      proxy: {
        proxyMode: settings.proxyMode,
        proxyHost: settings.proxyHost,
        proxyPort: settings.proxyPort,
        proxyAllowDirectFallback: settings.proxyAllowDirectFallback
      },
      bundledPlugins: [
        {
          id: 'com.twilightecho.provider.ncm',
          sourcePath: join(bundledRoot, 'plugins', 'ncm-provider'),
          defaultEnabled: true
        }
      ]
    }
  })
  const windows = new CoreWindowBridge({
    supervisor,
    ipc: ipcMain,
    trustedUrl: isTrustedIpcSenderUrl
  })
  const settingsBridge = installCoreSettingsBridge({
    request: (name, payload) => application.request(name, payload as never) as never,
    project: projectCoreSettings,
    snapshot: () => createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  })
  const system = installCoreSystemPlayer({
    command: (action) => application.request('playback.control', action),
    presentation: (signal) => application.request('player.presentation', {}, signal),
    lyrics: (signal) => application.request('player.lyrics', {}, signal),
    queuePage: (payload) => application.request('queue.page', payload),
    now: Date.now,
    failed: (error) => console.error('[core.system]', error)
  })
  const application = new CoreApplicationRuntime({
    supervisor,
    windows,
    settings: settingsBridge,
    system
  })
  installCoreApplication(application)
  supervisor.on('settings', () => getCoreAfterglowMode()?.reassertShortcuts())
  let retryPromptOpen = false
  supervisor.on('status', (status) => {
    if (status.phase !== 'failed' || runtime.forceQuit || retryPromptOpen) return
    retryPromptOpen = true
    const detail = supervisor.getLastError()
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'Music Core 已停止',
        message: '后台核心未能恢复，播放已停止。',
        ...(detail ? { detail: `故障原因：${detail}` } : {}),
        buttons: ['重试 Core', '稍后重试'],
        defaultId: 0,
        cancelId: 1
      })
      .then(async ({ response }) => {
        retryPromptOpen = false
        if (response === 0 && !runtime.forceQuit) await application.retry()
      })
      .catch((error) => {
        retryPromptOpen = false
        console.error('[core.retry]', error)
      })
  })
  return application
}
