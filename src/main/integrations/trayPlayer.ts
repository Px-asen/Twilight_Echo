import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  EMPTY_MINI_PLAYER_STATE,
  normalizeMiniPlayerCommand,
  type MiniPlayerCommand,
  type MiniPlayerStateSnapshot
} from '../../shared/miniPlayer.ts'
import {
  normalizeTrayNavigationTarget,
  type TrayNavigationTarget,
  type TrayPlayerBootstrap
} from '../../shared/trayPlayer.ts'
import { runtime } from '../core/runtime'
import { getCoreSystemPlayer } from '../coreProcess/systemPlayerBridge.ts'
import { getCoreApplication } from '../app/coreApplication.ts'
import { CORE_WINDOW_POLICIES } from '../coreProcess/windowBridge.ts'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import { getAppIconPath } from '../app/window'
import { hideMiniPlayerWindow, restoreMainWindowFromMiniPlayer } from './miniPlayer'
import {
  normalizeExperienceWindowTheme,
  type ExperienceWindowOptions,
  type ExperienceWindowTheme
} from '../../shared/experienceWindow.ts'

const TRAY_PLAYER_WIDTH = 360
const TRAY_PLAYER_HEIGHT = 176
const TRAY_PLAYER_EDGE_GAP = 10
let trayPlayerExperienceTheme: ExperienceWindowTheme = 'default'

function sendTrayPlayerState(state: MiniPlayerStateSnapshot): void {
  const win = runtime.trayPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('trayPlayer:state', state)
}

function sendTrayPlayerExperienceTheme(): void {
  const win = runtime.trayPlayerWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('experience:windowTheme', trayPlayerExperienceTheme)
}

export function publishTrayPlayerState(state: MiniPlayerStateSnapshot): void {
  if (getCoreSystemPlayer()) return
  runtime.latestMiniPlayerState = state
  sendTrayPlayerState(state)
}

function forwardPlayerCommand(command: MiniPlayerCommand): void {
  const core = getCoreSystemPlayer()
  if (core) {
    core.dispatch(command)
    return
  }
  const mainWindow = runtime.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('miniPlayer:command', command)
}

function assertTrayPlayerSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  capability: string
): void {
  assertTrustedIpcSender(event, capability)
  const win = runtime.trayPlayerWindow
  if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
    throw new Error(`${capability} rejected from unexpected window`)
  }
}

function shouldAcceptTrayPlayerSender(event: IpcMainEvent, capability: string): boolean {
  if (!shouldAcceptIpcEvent(event, capability)) return false
  const win = runtime.trayPlayerWindow
  if (win && !win.isDestroyed() && event.sender.id === win.webContents.id) return true
  console.warn(`${capability} rejected from unexpected window`)
  return false
}

function positionTrayPlayerWindow(win: BrowserWindow): void {
  const trayBounds = runtime.tray?.getBounds()
  const display = trayBounds
    ? screen.getDisplayNearestPoint({
        x: Math.round(trayBounds.x + trayBounds.width / 2),
        y: Math.round(trayBounds.y + trayBounds.height / 2)
      })
    : screen.getPrimaryDisplay()
  const workArea = display.workArea
  const anchorX = trayBounds ? trayBounds.x + trayBounds.width / 2 : workArea.x + workArea.width
  const preferredX = Math.round(anchorX - TRAY_PLAYER_WIDTH / 2)
  const x = Math.min(
    Math.max(preferredX, workArea.x + TRAY_PLAYER_EDGE_GAP),
    workArea.x + workArea.width - TRAY_PLAYER_WIDTH - TRAY_PLAYER_EDGE_GAP
  )
  const y =
    trayBounds && trayBounds.y < workArea.y + workArea.height / 2
      ? workArea.y + TRAY_PLAYER_EDGE_GAP
      : workArea.y + workArea.height - TRAY_PLAYER_HEIGHT - TRAY_PLAYER_EDGE_GAP
  win.setBounds({ x, y, width: TRAY_PLAYER_WIDTH, height: TRAY_PLAYER_HEIGHT }, false)
}

const TRAY_PLAYER_IDLE_UNLOAD_MS = 15_000
let trayPlayerUnloadTimer: ReturnType<typeof setTimeout> | null = null

function clearTrayPlayerUnloadTimer(): void {
  if (trayPlayerUnloadTimer) {
    clearTimeout(trayPlayerUnloadTimer)
    trayPlayerUnloadTimer = null
  }
}

function scheduleTrayPlayerUnload(): void {
  clearTrayPlayerUnloadTimer()
  trayPlayerUnloadTimer = setTimeout(() => {
    trayPlayerUnloadTimer = null
    const win = runtime.trayPlayerWindow
    if (win && !win.isDestroyed() && !win.isVisible() && !win.webContents.isDevToolsOpened()) {
      destroyTrayPlayerWindow()
    }
  }, TRAY_PLAYER_IDLE_UNLOAD_MS)
  trayPlayerUnloadTimer.unref?.()
}

function createTrayPlayerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: TRAY_PLAYER_WIDTH,
    height: TRAY_PLAYER_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    autoHideMenuBar: true,
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
  runtime.trayPlayerWindow = win

  win.on('show', () => {
    clearTrayPlayerUnloadTimer()
  })
  win.on('hide', () => {
    scheduleTrayPlayerUnload()
  })
  win.on('blur', () => {
    if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) win.hide()
  })
  win.on('closed', () => {
    clearTrayPlayerUnloadTimer()
    if (runtime.trayPlayerWindow === win) runtime.trayPlayerWindow = null
  })
  getCoreApplication()?.register(win, CORE_WINDOW_POLICIES.playback)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('did-finish-load', () => {
    sendTrayPlayerState(runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE })
    sendTrayPlayerExperienceTheme()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('window', 'tray-player')
    rendererUrl.searchParams.set('experienceTheme', trayPlayerExperienceTheme)
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'tray-player', experienceTheme: trayPlayerExperienceTheme }
    })
  }
  return win
}

export function showTrayPlayerWindow(options?: ExperienceWindowOptions): void {
  clearTrayPlayerUnloadTimer()
  trayPlayerExperienceTheme = normalizeExperienceWindowTheme(options?.theme)
  const win =
    runtime.trayPlayerWindow && !runtime.trayPlayerWindow.isDestroyed()
      ? runtime.trayPlayerWindow
      : createTrayPlayerWindow()
  positionTrayPlayerWindow(win)
  win.showInactive()
  win.focus()
  sendTrayPlayerExperienceTheme()
  sendTrayPlayerState(runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE })
}

export function toggleTrayPlayerWindow(): void {
  const existing = runtime.trayPlayerWindow
  if (existing && !existing.isDestroyed() && existing.isVisible()) {
    existing.hide()
    return
  }
  showTrayPlayerWindow()
}

export function hideTrayPlayerWindow(): void {
  const win = runtime.trayPlayerWindow
  if (win && !win.isDestroyed()) win.hide()
}

export function destroyTrayPlayerWindow(): void {
  clearTrayPlayerUnloadTimer()
  const win = runtime.trayPlayerWindow
  runtime.trayPlayerWindow = null
  if (win && !win.isDestroyed()) win.destroy()
}

export function openMainWindowAt(target: TrayNavigationTarget): void {
  restoreMainWindowFromMiniPlayer()
  hideMiniPlayerWindow()
  hideTrayPlayerWindow()
  const mainWindow = runtime.mainWindow
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  runtime.pendingTrayNavigation = target
  if (!mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('app:navigate', target)
  }
}

export function consumePendingTrayNavigation(): TrayNavigationTarget | null {
  const target = runtime.pendingTrayNavigation
  runtime.pendingTrayNavigation = null
  return target
}

export function setupTrayPlayerIpc(): void {
  ipcMain.handle('trayPlayer:getBootstrap', (event): TrayPlayerBootstrap => {
    assertTrayPlayerSender(event, 'tray player window IPC')
    return {
      state: runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE },
      motionPreference: runtime.appSettings.motionPreference
    }
  })

  ipcMain.on('trayPlayer:command', (event, rawCommand: unknown) => {
    if (!shouldAcceptTrayPlayerSender(event, 'tray player command IPC')) return
    const command = normalizeMiniPlayerCommand(rawCommand)
    if (command) forwardPlayerCommand(command)
  })

  ipcMain.on('trayPlayer:navigate', (event, rawTarget: unknown) => {
    if (!shouldAcceptTrayPlayerSender(event, 'tray player navigation IPC')) return
    const target = normalizeTrayNavigationTarget(rawTarget)
    if (target) openMainWindowAt(target)
  })

  ipcMain.on('trayPlayer:hide', (event) => {
    if (!shouldAcceptTrayPlayerSender(event, 'tray player window IPC')) return
    hideTrayPlayerWindow()
  })
}
