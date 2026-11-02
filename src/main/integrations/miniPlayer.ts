import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  EMPTY_MINI_PLAYER_STATE,
  normalizeMiniPlayerCommand,
  normalizeMiniPlayerSettings,
  normalizeMiniPlayerStateSnapshot,
  type MiniPlayerBootstrap,
  type MiniPlayerSettings,
  type MiniPlayerSettingsPatch,
  type MiniPlayerStateSnapshot,
  type MiniPlayerWindowSize
} from '../../shared/miniPlayer'
import type { MotionPreference } from '../../shared/motion.ts'
import {
  normalizeExperienceWindowTheme,
  type ExperienceWindowOptions,
  type ExperienceWindowTheme
} from '../../shared/experienceWindow.ts'
import { runtime } from '../core/runtime'
import { createSettingsSnapshot, writeAppSettings } from '../core/settings'
import { getCoreSettingsBridge } from '../coreProcess/settingsBridge.ts'
import { getCoreSystemPlayer } from '../coreProcess/systemPlayerBridge.ts'
import { getCoreApplication } from '../app/coreApplication.ts'
import { CORE_WINDOW_POLICIES } from '../coreProcess/windowBridge.ts'
import { importBackgroundImage } from '../library/coverCache'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import { publishDynamicIslandLyrics, publishDynamicIslandState } from './dynamicIsland.ts'
import { normalizeDynamicIslandLyrics } from '../../shared/dynamicIsland.ts'
import {
  MINI_PLAYER_MAX_HEIGHT,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  clampMiniPlayerBoundsToWorkArea,
  isMiniPlayerBoundsEcho,
  miniPlayerBoundsPatch,
  parseMiniPlayerMoveTarget,
  resizeMiniPlayerBounds
} from './miniPlayerWindow'

const MINI_PLAYER_EDGE_GAP = 22
const MINI_PLAYER_BOUNDS_SAVE_DELAY_MS = 350

let boundsSaveTimer: NodeJS.Timeout | null = null
let programmedBounds: Electron.Rectangle | null = null
let dragSize: MiniPlayerWindowSize | null = null
let miniPlayerExperienceTheme: ExperienceWindowTheme = 'default'
let createMainWindowFactory: (() => BrowserWindow) | null = null

export function registerMiniPlayerMainWindowFactory(factory: () => BrowserWindow): void {
  createMainWindowFactory = factory
}

function getMiniPlayerIconPath(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          is.dev
            ? join(app.getAppPath(), 'build', 'icon.ico')
            : join(process.resourcesPath, 'icon.ico')
        ]
      : [
          is.dev
            ? join(app.getAppPath(), 'build', 'icon.png')
            : join(process.resourcesPath, 'icon.png')
        ]
  return candidates.find((candidate) => existsSync(candidate))
}

function currentMiniPlayerSettings(): MiniPlayerSettings {
  return normalizeMiniPlayerSettings(runtime.appSettings.miniPlayer)
}

function resolveInitialBounds(settings: MiniPlayerSettings): Electron.Rectangle {
  const hasSavedPosition = !(settings.windowX === -1 && settings.windowY === -1)
  const display = hasSavedPosition
    ? screen.getDisplayNearestPoint({ x: settings.windowX, y: settings.windowY })
    : runtime.mainWindow && !runtime.mainWindow.isDestroyed()
      ? screen.getDisplayMatching(runtime.mainWindow.getBounds())
      : screen.getPrimaryDisplay()
  const workArea = display.workArea
  const preferredX = hasSavedPosition
    ? settings.windowX
    : workArea.x + workArea.width - settings.windowWidth - MINI_PLAYER_EDGE_GAP
  const preferredY = hasSavedPosition
    ? settings.windowY
    : workArea.y + workArea.height - settings.windowHeight - MINI_PLAYER_EDGE_GAP

  return clampMiniPlayerBoundsToWorkArea(
    {
      x: clampNumber(preferredX, workArea.x, workArea.x + workArea.width - settings.windowWidth),
      y: clampNumber(preferredY, workArea.y, workArea.y + workArea.height - settings.windowHeight),
      width: settings.windowWidth,
      height: settings.windowHeight
    },
    workArea
  )
}

/** The bounds the window was given, while its rounded read-back is only an echo of them. */
function settledMiniPlayerBounds(win: BrowserWindow): Electron.Rectangle {
  const actual = win.getBounds()
  return programmedBounds && isMiniPlayerBoundsEcho(actual, programmedBounds)
    ? programmedBounds
    : actual
}

function fitMiniPlayerToWorkArea(win: BrowserWindow, settings: MiniPlayerSettings): void {
  const current = settledMiniPlayerBounds(win)
  const display = screen.getDisplayMatching(current)
  const next = resizeMiniPlayerBounds(
    current,
    { width: settings.windowWidth, height: settings.windowHeight },
    display.workArea
  )
  if (rectanglesEqual(win.getBounds(), next)) return
  programmedBounds = next
  win.setBounds(next, false)
}

function applyMiniPlayerWindowSettings(settings: MiniPlayerSettings): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed()) return

  if (settings.alwaysOnTop) {
    win.setAlwaysOnTop(true, 'screen-saver')
  } else {
    win.setAlwaysOnTop(false)
  }
  win.setBackgroundColor('#00000000')
  win.setMovable(!settings.positionLocked)
  win.setSkipTaskbar(!settings.showInTaskbar)
  if (dragSize) dragSize = { width: settings.windowWidth, height: settings.windowHeight }
  fitMiniPlayerToWorkArea(win, settings)
}

function persistMiniPlayerBounds(win: BrowserWindow, bounds?: Electron.Rectangle): void {
  if (win.isDestroyed() || runtime.miniPlayerWindow !== win) return
  const boundsPatch = miniPlayerBoundsPatch(bounds ?? settledMiniPlayerBounds(win))
  const core = getCoreSettingsBridge()
  if (core) {
    void core
      .update((current) => ({ miniPlayer: { ...current.miniPlayer, ...boundsPatch } }))
      .catch((error) => console.warn('[miniPlayer] bounds save failed', error))
    return
  }
  runtime.appSettings = {
    ...runtime.appSettings,
    miniPlayer: {
      ...currentMiniPlayerSettings(),
      ...boundsPatch
    }
  }
  writeAppSettings(runtime.appSettings)
  sendMiniPlayerSettings(runtime.appSettings.miniPlayer)
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  )
}

function isMiniPlayerBoundsSaved(bounds: Electron.Rectangle): boolean {
  const saved = currentMiniPlayerSettings()
  const patch = miniPlayerBoundsPatch(bounds)
  return (
    patch.windowX === saved.windowX &&
    patch.windowY === saved.windowY &&
    patch.windowWidth === saved.windowWidth &&
    patch.windowHeight === saved.windowHeight
  )
}

function scheduleMiniPlayerBoundsSave(win: BrowserWindow): void {
  if (dragSize) return
  if (programmedBounds && !isMiniPlayerBoundsEcho(win.getBounds(), programmedBounds)) {
    programmedBounds = null
  }
  // Programmatic resizes still move the window (corner anchoring, work-area
  // clamps); those land here as echoes and save the bounds that were asked for.
  if (isMiniPlayerBoundsSaved(settledMiniPlayerBounds(win))) return
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    persistMiniPlayerBounds(win)
  }, MINI_PLAYER_BOUNDS_SAVE_DELAY_MS)
}

function moveMiniPlayerWindow(win: BrowserWindow, target: { x: number; y: number }): void {
  if (!dragSize && boundsSaveTimer) {
    clearTimeout(boundsSaveTimer)
    boundsSaveTimer = null
    persistMiniPlayerBounds(win)
  }
  const settings = currentMiniPlayerSettings()
  if (settings.positionLocked) return
  // At fractional scale factors this frameless thick-frame window reads back a
  // pixel or two larger than it was set to, and setPosition grows it the same
  // way. Every step re-sends the configured size, never getBounds(), and the
  // gesture persists once on moveEnd with that size. A pending edge-resize save
  // is flushed first so the gesture keeps the size the user just chose.
  dragSize ??= { width: settings.windowWidth, height: settings.windowHeight }
  const { width, height } = dragSize
  const display = screen.getDisplayNearestPoint({
    x: target.x + Math.round(width / 2),
    y: target.y + Math.round(height / 2)
  })
  const next = clampMiniPlayerBoundsToWorkArea(
    { x: target.x, y: target.y, width, height },
    display.workArea
  )
  programmedBounds = next
  win.setBounds(next, false)
}

function sendMiniPlayerState(state: MiniPlayerStateSnapshot): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:state', state)
}

export function publishCoreMiniPlayerState(state: MiniPlayerStateSnapshot): void {
  runtime.latestMiniPlayerState = state
  publishDynamicIslandState(state)
  sendMiniPlayerState(state)
  runtime.refreshTrayMenu?.()
  runtime.refreshTaskbarThumbarButtons?.()
  runtime.refreshWindowsSmtc?.()
  const tray = runtime.trayPlayerWindow
  if (tray && !tray.isDestroyed() && !tray.webContents.isDestroyed())
    tray.webContents.send('trayPlayer:state', state)
}

function sendMiniPlayerSettings(settings = currentMiniPlayerSettings()): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:settings', settings)
}

function sendMiniPlayerMotionPreference(preference = runtime.appSettings.motionPreference): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('miniPlayer:motionPreference', preference)
}

function sendMiniPlayerExperienceTheme(): void {
  const win = runtime.miniPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('experience:windowTheme', miniPlayerExperienceTheme)
}

export function applyMiniPlayerSettingsFromApp(settings: MiniPlayerSettings): void {
  applyMiniPlayerWindowSettings(settings)
  sendMiniPlayerSettings(settings)
}

export function applyMiniPlayerMotionPreferenceFromApp(preference: MotionPreference): void {
  sendMiniPlayerMotionPreference(preference)
}

function enterMiniPlayerMode(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  runtime.mainWindow?.hide()
  sendMiniPlayerSettings()
  sendMiniPlayerMotionPreference()
  sendMiniPlayerExperienceTheme()
  sendMiniPlayerState(runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE })
}

function createMiniPlayerWindow(): BrowserWindow {
  const settings = currentMiniPlayerSettings()
  const bounds = resolveInitialBounds(settings)
  const core = getCoreSettingsBridge()
  if (core)
    void core
      .update((current) => ({
        miniPlayer: { ...current.miniPlayer, ...miniPlayerBoundsPatch(bounds) }
      }))
      .catch((error) => console.warn('[miniPlayer] initial bounds save failed', error))
  else
    runtime.appSettings = {
      ...runtime.appSettings,
      miniPlayer: {
        ...settings,
        ...miniPlayerBoundsPatch(bounds)
      }
    }

  const win = new BrowserWindow({
    ...bounds,
    title: 'Twilight Echo Mini Player',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: settings.alwaysOnTop,
    movable: !settings.positionLocked,
    resizable: true,
    minWidth: MINI_PLAYER_MIN_WIDTH,
    minHeight: MINI_PLAYER_MIN_HEIGHT,
    maxWidth: MINI_PLAYER_MAX_WIDTH,
    maxHeight: MINI_PLAYER_MAX_HEIGHT,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !settings.showInTaskbar,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: process.platform === 'win32',
    autoHideMenuBar: true,
    icon: getMiniPlayerIconPath(),
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
  runtime.miniPlayerWindow = win
  getCoreApplication()?.register(win, CORE_WINDOW_POLICIES.playback)
  programmedBounds = bounds

  win.setBackgroundColor('#00000000')

  applyMiniPlayerWindowSettings(settings)

  win.on('ready-to-show', () => {
    if (runtime.miniPlayerWindow !== win || win.isDestroyed()) return
    enterMiniPlayerMode(win)
  })

  win.on('move', () => scheduleMiniPlayerBoundsSave(win))
  win.on('resize', () => scheduleMiniPlayerBoundsSave(win))

  win.on('close', (event) => {
    if (runtime.forceQuit) {
      persistMiniPlayerBounds(win)
      return
    }
    event.preventDefault()
    restoreMainWindowFromMiniPlayer()
  })

  win.on('closed', () => {
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer)
      boundsSaveTimer = null
    }
    programmedBounds = null
    dragSize = null
    if (runtime.miniPlayerWindow === win) runtime.miniPlayerWindow = null
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('did-finish-load', () => {
    dragSize = null
    sendMiniPlayerSettings()
    sendMiniPlayerMotionPreference()
    sendMiniPlayerExperienceTheme()
    sendMiniPlayerState(runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE })
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    console.error(`[mini-player] renderer load failed: ${errorCode} ${errorDescription}`)
    restoreMainWindowFromMiniPlayer()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('window', 'mini-player')
    rendererUrl.searchParams.set('experienceTheme', miniPlayerExperienceTheme)
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'mini-player', experienceTheme: miniPlayerExperienceTheme }
    })
  }

  return win
}

export function showMiniPlayer(options?: ExperienceWindowOptions): MiniPlayerSettings {
  miniPlayerExperienceTheme = normalizeExperienceWindowTheme(options?.theme)
  const existing = runtime.miniPlayerWindow
  if (existing && !existing.isDestroyed()) {
    if (!existing.webContents.isLoadingMainFrame()) enterMiniPlayerMode(existing)
  } else {
    createMiniPlayerWindow()
  }
  return currentMiniPlayerSettings()
}

export function hideMiniPlayerWindow(): void {
  const win = runtime.miniPlayerWindow
  if (win && !win.isDestroyed()) win.hide()
}

export function restoreMainWindowFromMiniPlayer(): void {
  destroyMiniPlayerWindow()

  const mainWindow =
    runtime.mainWindow && !runtime.mainWindow.isDestroyed()
      ? runtime.mainWindow
      : getCoreApplication()
        ? (createMainWindowFactory?.() ?? null)
        : null
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Capture pending bounds before renderer teardown, including app exit and Afterglow. */
export function destroyMiniPlayerWindow(): void {
  const window = runtime.miniPlayerWindow
  if (window && !window.isDestroyed()) {
    persistMiniPlayerBounds(window)
    window.destroy()
  }
  runtime.miniPlayerWindow = null
}

function updateMiniPlayerSettings(
  patch: unknown
): MiniPlayerSettings | Promise<MiniPlayerSettings> {
  const current = currentMiniPlayerSettings()
  const value =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const candidate: Record<string, unknown> = { ...current }
  const allowedKeys: (keyof MiniPlayerSettingsPatch)[] = [
    'alwaysOnTop',
    'showInTaskbar',
    'positionLocked',
    'activeStyleId',
    'profiles',
    'windowWidth',
    'windowHeight'
  ]
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) candidate[key] = value[key]
  }
  const core = getCoreSettingsBridge()
  if (core)
    return core
      .update((latest) => {
        const next: Record<string, unknown> = { ...latest.miniPlayer }
        for (const key of allowedKeys) if (Object.hasOwn(value, key)) next[key] = value[key]
        return { miniPlayer: normalizeMiniPlayerSettings(next) }
      })
      .then((snapshot) => snapshot.settings.miniPlayer)

  const settings = normalizeMiniPlayerSettings(candidate)
  runtime.appSettings = { ...runtime.appSettings, miniPlayer: settings }
  writeAppSettings(runtime.appSettings)
  applyMiniPlayerSettingsFromApp(settings)
  runtime.mainWindow?.webContents.send(
    'settings:changed',
    createSettingsSnapshot(runtime.appSettings, runtime.launchSettings)
  )
  return settings
}

function assertSenderWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
  expectedWindow: BrowserWindow | null,
  capability: string
): void {
  assertTrustedIpcSender(event, capability)
  if (
    !expectedWindow ||
    expectedWindow.isDestroyed() ||
    event.sender.id !== expectedWindow.webContents.id
  ) {
    throw new Error(`${capability} rejected from unexpected window`)
  }
}

function shouldAcceptSenderWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
  expectedWindow: BrowserWindow | null,
  capability: string
): boolean {
  if (!shouldAcceptIpcEvent(event, capability)) return false
  if (
    expectedWindow &&
    !expectedWindow.isDestroyed() &&
    event.sender.id === expectedWindow.webContents.id
  ) {
    return true
  }
  console.warn(`${capability} rejected from unexpected window`)
  return false
}

export function setupMiniPlayerIpc(): void {
  ipcMain.handle('miniPlayer:open', (event, rawOptions: unknown) => {
    assertSenderWindow(event, runtime.mainWindow, 'mini player host IPC')
    const options =
      rawOptions && typeof rawOptions === 'object' ? (rawOptions as ExperienceWindowOptions) : {}
    return showMiniPlayer(options)
  })

  ipcMain.on('miniPlayer:publishState', (event, rawState: unknown) => {
    if (!shouldAcceptSenderWindow(event, runtime.mainWindow, 'mini player state IPC')) return
    if (getCoreSystemPlayer()) return
    const state = normalizeMiniPlayerStateSnapshot(rawState)
    runtime.latestMiniPlayerState = state
    publishDynamicIslandState(state)
    sendMiniPlayerState(state)
    runtime.refreshTrayMenu?.()
    runtime.refreshTaskbarThumbarButtons?.()
    runtime.refreshWindowsSmtc?.()
    const trayPlayerWindow = runtime.trayPlayerWindow
    if (
      trayPlayerWindow &&
      !trayPlayerWindow.isDestroyed() &&
      !trayPlayerWindow.webContents.isDestroyed()
    ) {
      trayPlayerWindow.webContents.send('trayPlayer:state', state)
    }
  })

  // Island-only lyric channel: keeps the shared snapshot lyric-free while the
  // main renderer still owns lyric parsing.
  ipcMain.on('miniPlayer:publishLyrics', (event, rawLyrics: unknown) => {
    if (!shouldAcceptSenderWindow(event, runtime.mainWindow, 'dynamic island lyrics IPC')) return
    if (getCoreSystemPlayer()) return
    publishDynamicIslandLyrics(normalizeDynamicIslandLyrics(rawLyrics))
  })

  ipcMain.handle('miniPlayer:getBootstrap', (event): MiniPlayerBootstrap => {
    assertSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')
    return {
      state: runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE },
      settings: currentMiniPlayerSettings(),
      motionPreference: runtime.appSettings.motionPreference
    }
  })

  ipcMain.on('miniPlayer:command', (event, rawCommand: unknown) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player command IPC')) {
      return
    }
    const command = normalizeMiniPlayerCommand(rawCommand)
    if (!command) return
    const core = getCoreSystemPlayer()
    if (core) {
      core.dispatch(command)
      return
    }
    const mainWindow = runtime.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('miniPlayer:command', command)
  })

  ipcMain.handle('miniPlayer:updateSettings', (event, patch: MiniPlayerSettingsPatch) => {
    assertSenderWindow(event, runtime.miniPlayerWindow, 'mini player settings IPC')
    return updateMiniPlayerSettings(patch)
  })

  ipcMain.handle('miniPlayer:chooseBackgroundImage', async (event) => {
    assertSenderWindow(event, runtime.miniPlayerWindow, 'mini player background image IPC')
    const win = runtime.miniPlayerWindow
    if (!win || win.isDestroyed()) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '背景图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return importBackgroundImage(result.filePaths[0])
  })

  ipcMain.on('miniPlayer:minimize', (event) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')) {
      return
    }
    runtime.miniPlayerWindow?.minimize()
  })

  ipcMain.on('miniPlayer:moveTo', (event, payload: unknown) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')) {
      return
    }
    const target = parseMiniPlayerMoveTarget(payload)
    const win = runtime.miniPlayerWindow
    if (!target || !win || win.isDestroyed()) return
    moveMiniPlayerWindow(win, target)
  })

  ipcMain.on('miniPlayer:moveEnd', (event) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')) {
      return
    }
    const win = runtime.miniPlayerWindow
    const settings = currentMiniPlayerSettings()
    const size = dragSize ?? { width: settings.windowWidth, height: settings.windowHeight }
    dragSize = null
    if (!win || win.isDestroyed()) return
    persistMiniPlayerBounds(win, { ...settledMiniPlayerBounds(win), ...size })
  })

  ipcMain.on('miniPlayer:returnToMain', (event) => {
    if (!shouldAcceptSenderWindow(event, runtime.miniPlayerWindow, 'mini player window IPC')) {
      return
    }
    restoreMainWindowFromMiniPlayer()
  })
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)))
}

function rectanglesEqual(first: Electron.Rectangle, second: Electron.Rectangle): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  )
}
