import { app, BrowserWindow, dialog, shell, screen, nativeTheme } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import { is } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime'
import { getWindowBackgroundColor, syncWindowFrameAppearance } from './windowAppearance.ts'
import {
  isWindowsAcrylicBackdropAvailable,
  isWindowsAcrylicBuild,
  supportsNativeWindowTransparency
} from '../core/settings'
import { installAudioDeviceHotplugWatcher } from '../audio/deviceHotplug'
import { destroyDesktopLyrics } from '../integrations/desktopLyrics'
import { registerMiniPlayerMainWindowFactory, showMiniPlayer } from '../integrations/miniPlayer.ts'
import {
  createTaskbarThumbarButtons,
  destroyTaskbarThumbarButtons
} from '../integrations/taskbarThumbar.ts'
import {
  destroyWindowsSmtc,
  initializeWindowsSmtc,
  rebindWindowsSmtc
} from '../integrations/windowsSmtc.ts'
import { getCoreApplication } from './coreApplication.ts'
import {
  createAfterglowAnchorWindow,
  destroyAfterglowAnchorWindow,
  getAfterglowAnchorHandle
} from './afterglowAnchorWindow.ts'
import { ClosePersistenceAttemptGate, closePersistenceDialogOptions } from './closePersistence.ts'
import { resolveLocale } from '../../shared/i18n/locale.ts'
import { isSafeExternalUrl } from '../security/externalUrl.ts'
import { isTrustedIpcSenderUrl } from '../security/electronSecurity.ts'
import type { RendererClosePersistenceOutcome } from '../../shared/closePersistence.ts'
import type { PlaybackSessionSaveOptions } from '../../shared/closePersistence.ts'
import { afterglowRendererRestoreQueryKey } from '../../shared/afterglowMode.ts'
import { readWindowState, restoreWindowSize, saveWindowState } from './windowState.ts'
import { installWindowChromePublisher } from './windowChrome.ts'
import { installWindowCloseShortcut } from './windowShortcuts.ts'
import { installMouseHistoryNavigation } from './windowHistoryNavigation.ts'
import {
  isDspEditorWindowRequest,
  dspEditorWindowOptions,
  registerDspEditorWindow
} from './dspEditorWindow.ts'

const PLAYBACK_SESSION_SAVE_TIMEOUT_MS = 1800
const HIDDEN_MAIN_WINDOW_UNLOAD_DELAY_MS = 30_000
const closePersistenceAttemptGate = new ClosePersistenceAttemptGate()
const pendingPlaybackSessionSaves = new Map<
  string,
  (outcome: RendererClosePersistenceOutcome) => void
>()
let afterglowUnloading = false
let hiddenMainWindowUnloadTimer: ReturnType<typeof setTimeout> | null = null

function clearHiddenMainWindowUnloadTimer(): void {
  if (hiddenMainWindowUnloadTimer) {
    clearTimeout(hiddenMainWindowUnloadTimer)
    hiddenMainWindowUnloadTimer = null
  }
}

/**
 * Marks the next `closed` event as an intentional Afterglow unload so window
 * teardown does not also tear down the surfaces that keep playback controllable.
 */
export function setMainWindowAfterglowUnloading(value: boolean): void {
  afterglowUnloading = value
}

export function resolvePlaybackSessionSave(
  requestId: string,
  outcome: RendererClosePersistenceOutcome
): void {
  const resolvePending = pendingPlaybackSessionSaves.get(requestId)
  if (!resolvePending) return
  pendingPlaybackSessionSaves.delete(requestId)
  resolvePending(outcome)
}

export async function requestRendererPlaybackSessionSave(
  options: PlaybackSessionSaveOptions = {}
): Promise<void> {
  const win = runtime.mainWindow
  if (
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    win.webContents.isLoading?.() ||
    win.webContents.isCrashed?.() ||
    getCoreApplication()?.snapshot?.() === null
  )
    return

  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPlaybackSessionSaves.delete(requestId)
      reject(new Error('Timed out waiting for renderer persistence'))
    }, PLAYBACK_SESSION_SAVE_TIMEOUT_MS)

    pendingPlaybackSessionSaves.set(requestId, (outcome) => {
      clearTimeout(timer)
      if (outcome.status === 'saved') {
        resolve()
        return
      }
      reject(new Error(outcome.error || 'Renderer persistence failed'))
    })

    win.webContents.send('app:save-playback-session', requestId, options)
  })
}

/** The renderer saves navigation/drafts; Core checkpoints the actual music session. */
export async function requestApplicationPersistence(
  options: PlaybackSessionSaveOptions = {}
): Promise<void> {
  await requestRendererPlaybackSessionSave(options)
  await getCoreApplication()?.flush()
}

async function closeMainWindowAfterPlaybackSessionSave(win: BrowserWindow): Promise<void> {
  runtime.savingPlaybackSessionBeforeClose = true
  try {
    await closePersistenceAttemptGate.run({
      requestPersistence: requestApplicationPersistence,
      close: () => closeMainWindowAfterSuccessfulPersistence(win),
      showFailure: async (error) => await showClosePersistenceFailure(win, error)
    })
  } finally {
    runtime.savingPlaybackSessionBeforeClose = false
  }
}

function closeMainWindowAfterSuccessfulPersistence(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  destroyDesktopLyrics()
  const shouldQuitAfterClose = runtime.forceQuit
  if (shouldQuitAfterClose) {
    win.once('closed', () => {
      setTimeout(() => app.quit(), 0)
    })
  }
  runtime.closingAfterPlaybackSessionSave = true
  win.close()
  runtime.closingAfterPlaybackSessionSave = false
}

export async function showClosePersistenceFailure(
  win: BrowserWindow | null,
  error: Error,
  discarding = false
): Promise<'retry' | 'cancel' | 'force'> {
  console.error('[persistence] Close persistence failed:', error)
  try {
    const options = closePersistenceDialogOptions(
      resolveLocale(runtime.appSettings.language, app.getLocale()),
      error,
      discarding
    )
    const response = await (win && !win.isDestroyed()
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options))
    // I3: 提供“仍然退出”逃生出口，避免保存持续失败时对话框循环卡住。
    if (response.response === 0) return 'retry'
    if (response.response === 2) return 'force'
    return 'cancel'
  } catch (dialogError) {
    console.error('[persistence] Failed to present the cancelled-close dialog:', dialogError)
    return 'cancel'
  }
}

export function getAppIconPath(): string {
  if (process.platform === 'win32') {
    return is.dev
      ? join(app.getAppPath(), 'build', 'icon.ico')
      : join(process.resourcesPath, 'icon.ico')
  }
  return is.dev
    ? join(app.getAppPath(), 'build', 'icon.png')
    : join(process.resourcesPath, 'icon.png')
}

// Win11 22H2 (build 22621) 及以上支持原生亚克力背板（DWM systembackdrop）
export function supportsWindowsAcrylic(): boolean {
  return isWindowsAcrylicBuild()
}

export interface CreateWindowOptions {
  /** Recreated after Afterglow: the renderer adopts live engine state. */
  afterglowRestore?: boolean
  /** Keep the existing anchor and its media session until this window is ready. */
  deferAfterglowAnchorHandoff?: boolean
}

export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  let awaitingAfterglowHandoff = options.deferAfterglowAnchorHandoff === true
  const windowStatePath = join(app.getPath('userData'), 'window-state.json')
  const windowState = readWindowState(windowStatePath)
  const requestedTransparency = runtime.appSettings.windowTransparency === true
  // Linux Wayland 上 Electron 透明窗口不受支持（alpha 被忽略、内容可能整窗不渲染），
  // 此时强制回退为不透明窗口，保证应用始终可见。
  const transparencySupported = supportsNativeWindowTransparency()
  const transparent = requestedTransparency && transparencySupported
  if (requestedTransparency && !transparencySupported) {
    console.warn(
      '[window] 当前系统不支持窗口透明（Linux Wayland，或 Windows 未开启系统透明效果），' +
        '已回退为不透明窗口。如需要透明效果请切换 X11 会话或开启系统透明效果。'
    )
  }
  // Windows 上用原生亚克力模糊：backgroundMaterial 与 transparent 互斥，
  // 需保持 transparent: false 并用全透明 backgroundColor 露出背板
  const acrylic = transparent && supportsWindowsAcrylic() && isWindowsAcrylicBackdropAvailable()
  if (transparent && supportsWindowsAcrylic() && !isWindowsAcrylicBackdropAvailable()) {
    console.warn(
      '[window] 系统"透明效果"已关闭，DWM 无法提供亚克力背板，' +
        '已回退为逐像素透明窗口（无模糊）。如需要亚克力效果，请开启系统透明效果。'
    )
  }

  runtime.mainWindow = new BrowserWindow({
    ...restoreWindowSize(windowState, screen.getPrimaryDisplay().workAreaSize),
    minWidth: Math.min(760, screen.getPrimaryDisplay().workAreaSize.width),
    minHeight: Math.min(692, screen.getPrimaryDisplay().workAreaSize.height),
    show: false,
    frame: false,
    ...(process.platform === 'win32' && !nativeTheme.shouldUseHighContrastColors
      ? { accentColor: false }
      : {}),
    transparent: transparent && !acrylic,
    backgroundColor: transparent
      ? '#00000000'
      : getWindowBackgroundColor(runtime.appSettings, nativeTheme.shouldUseDarkColors),
    ...(acrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })
  getCoreApplication()?.register(runtime.mainWindow)

  syncWindowFrameAppearance(runtime.mainWindow, nativeTheme.shouldUseHighContrastColors)
  installWindowChromePublisher(runtime.mainWindow)
  installMouseHistoryNavigation(runtime.mainWindow)
  installWindowCloseShortcut(
    runtime.mainWindow,
    () => runtime.appSettings.shortcutEnabled.closeWindow !== false
  )
  runtime.mainWindow.on('ready-to-show', () => {
    awaitingAfterglowHandoff = false
    if (windowState?.maximized) runtime.mainWindow?.maximize()
    runtime.mainWindow?.show()
    if (windowState?.fullScreen) runtime.mainWindow?.setFullScreen(true)
  })

  clearHiddenMainWindowUnloadTimer()
  const createdMainWindow = runtime.mainWindow
  createdMainWindow.on('show', () => {
    clearHiddenMainWindowUnloadTimer()
  })
  createdMainWindow.on('hide', () => {
    clearHiddenMainWindowUnloadTimer()
    if (
      !getCoreApplication() ||
      runtime.forceQuit ||
      runtime.appSettings.unloadHiddenMainWindow === false
    ) {
      return
    }
    hiddenMainWindowUnloadTimer = setTimeout(() => {
      hiddenMainWindowUnloadTimer = null
      void (async () => {
        if (
          runtime.mainWindow !== createdMainWindow ||
          createdMainWindow.isDestroyed() ||
          createdMainWindow.isVisible() ||
          runtime.forceQuit ||
          afterglowUnloading ||
          !getCoreApplication() ||
          (runtime.appSettings.unloadHiddenMainWindow as boolean | undefined) === false
        ) {
          return
        }
        const afterglow = await import('./AfterglowModeService').catch(() => null)
        if (afterglow?.isAfterglowModeActive()) return
        await requestRendererPlaybackSessionSave().catch(() => undefined)
        if (
          runtime.mainWindow !== createdMainWindow ||
          createdMainWindow.isDestroyed() ||
          createdMainWindow.isVisible() ||
          runtime.forceQuit ||
          afterglowUnloading ||
          !getCoreApplication() ||
          (runtime.appSettings.unloadHiddenMainWindow as boolean | undefined) === false
        ) {
          return
        }
        try {
          const bounds = createdMainWindow.getNormalBounds()
          saveWindowState(windowStatePath, {
            width: bounds.width,
            height: bounds.height,
            maximized: createdMainWindow.isMaximized(),
            fullScreen: createdMainWindow.isFullScreen()
          })
        } catch {
          // Ignore bounds persistence errors during background teardown.
        }
        createdMainWindow.destroy()
      })()
    }, HIDDEN_MAIN_WINDOW_UNLOAD_DELAY_MS)
    hiddenMainWindowUnloadTimer.unref?.()
  })

  runtime.mainWindow.on('minimize', () => {
    // Resolved lazily: the Afterglow service itself imports this module.
    void import('./AfterglowModeService')
      .then((service) => service.handleMainWindowMinimized())
      .catch((error) => console.warn('[afterglow] minimize hook failed:', error))
  })

  runtime.mainWindow.on('close', (event) => {
    const win = runtime.mainWindow!
    const bounds = win.getNormalBounds()
    try {
      saveWindowState(windowStatePath, {
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen()
      })
    } catch (error) {
      console.error('[window] Unable to save window size:', error)
    }
    const closeBehavior =
      runtime.appSettings.closeWindowBehavior ?? (process.platform === 'darwin' ? 'tray' : 'quit')
    const coreUnready = getCoreApplication()?.snapshot?.() === null
    if (
      !runtime.forceQuit &&
      !coreUnready &&
      (closeBehavior === 'tray' || closeBehavior === 'miniPlayer')
    ) {
      event.preventDefault()
      if (closeBehavior === 'miniPlayer') {
        showMiniPlayer()
      } else {
        runtime.mainWindow?.hide()
        void import('./AfterglowModeService')
          .then((service) => service.handleMainWindowHidden())
          .catch((error) => console.warn('[afterglow] hide hook failed:', error))
      }
      return
    }

    if (getCoreApplication()) {
      // Core application quit owns persistence, including repeated closes while
      // its checkpoint or failure dialog is pending. Never start a second flush.
      if (!runtime.closingAfterPlaybackSessionSave) {
        event.preventDefault()
        app.quit()
      }
      return
    }

    if (!runtime.closingAfterPlaybackSessionSave) {
      event.preventDefault()
      if (!runtime.savingPlaybackSessionBeforeClose && runtime.mainWindow) {
        void closeMainWindowAfterPlaybackSessionSave(runtime.mainWindow)
      }
    }
  })

  runtime.mainWindow.on('closed', () => {
    // Afterglow owns the unload: the tray, taskbar anchor and SMTC survive it.
    if (afterglowUnloading || awaitingAfterglowHandoff) {
      afterglowUnloading = false
    } else {
      destroyTaskbarThumbarButtons()
      if (getCoreApplication() && !runtime.forceQuit) {
        createAfterglowAnchorWindow({
          showInTaskbar: false,
          onRestore: () => {
            createWindow()
          }
        })
        rebindWindowsSmtc(getAfterglowAnchorHandle())
      } else destroyWindowsSmtc()
    }
    runtime.mainWindow = null
  })

  if (!getCoreApplication()) installAudioDeviceHotplugWatcher(runtime.mainWindow)

  if (process.platform === 'win32') {
    try {
      if (getCoreApplication() && !options.deferAfterglowAnchorHandoff) {
        rebindWindowsSmtc()
        destroyAfterglowAnchorWindow()
      } else if (!getCoreApplication()) initializeWindowsSmtc()
    } catch (error) {
      console.warn('[smtc] unable to initialize Windows media session:', error)
    }
    // SMTC sets the HWND's explicit AppUserModelID. Bind the thumbnail toolbar
    // only after that identity is stable, otherwise the Shell can regroup the
    // window and discard a toolbar registered under the old identity.
    try {
      if (!options.deferAfterglowAnchorHandoff) createTaskbarThumbarButtons()
    } catch (error) {
      console.warn('[thumbar] unable to initialize taskbar buttons:', error)
    }
  }

  runtime.mainWindow.webContents.setWindowOpenHandler(({ url, frameName, referrer }) => {
    if (
      isDspEditorWindowRequest(url, frameName) &&
      isTrustedIpcSenderUrl(runtime.mainWindow?.webContents.getURL() ?? '') &&
      // App documents deliberately use Referrer-Policy: no-referrer.
      (!referrer.url || referrer.url === runtime.mainWindow?.webContents.getURL())
    )
      return {
        action: 'allow',
        outlivesOpener: false,
        overrideBrowserWindowOptions: dspEditorWindowOptions(
          screen.getDisplayMatching(runtime.mainWindow!.getBounds()).workArea
        )
      }
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  runtime.mainWindow.webContents.on('did-create-window', (child, details) => {
    if (!isDspEditorWindowRequest(details.url, details.frameName)) return
    const owner = runtime.mainWindow!
    registerDspEditorWindow(owner, child)
    getCoreApplication()?.register(child)
    child.setMenu(null)
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', (event) => event.preventDefault())
    child.once('closed', () => {
      if (
        !owner.isDestroyed() &&
        !runtime.forceQuit &&
        !runtime.closingAfterPlaybackSessionSave &&
        !runtime.savingPlaybackSessionBeforeClose
      ) {
        if (owner.isMinimized()) owner.restore()
        owner.show()
        owner.focus()
      }
    })
  })

  runtime.mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (options.afterglowRestore) {
      rendererUrl.searchParams.set(afterglowRendererRestoreQueryKey, '1')
    }
    runtime.mainWindow.loadURL(rendererUrl.toString())
  } else if (options.afterglowRestore) {
    runtime.mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { [afterglowRendererRestoreQueryKey]: '1' }
    })
  } else {
    runtime.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return runtime.mainWindow
}

registerMiniPlayerMainWindowFactory(() => createWindow())

// S4：外部跳转默认仅放行 https:（共享实现见 security/externalUrl.ts）

function isAllowedAppNavigation(url: string): boolean {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    try {
      const target = new URL(url)
      const devServer = new URL(process.env['ELECTRON_RENDERER_URL'])
      return target.origin === devServer.origin
    } catch {
      return false
    }
  }

  const rendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  return url === rendererUrl || url.startsWith(`${rendererUrl}#`)
}
