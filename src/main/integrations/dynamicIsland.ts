import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  DEFAULT_DYNAMIC_ISLAND_CONFIG,
  DYNAMIC_ISLAND_EDGE_MARGIN,
  cloneDynamicIslandConfig,
  dynamicIslandMotionScale,
  normalizeDynamicIslandConfig,
  resolveDynamicIslandLayout,
  resolveDynamicIslandWindowBounds,
  shouldShowDynamicIsland,
  type DynamicIslandBootstrap,
  type DynamicIslandConfig,
  type DynamicIslandLayout
} from '../../shared/dynamicIsland.ts'
import {
  EMPTY_MINI_PLAYER_STATE,
  normalizeMiniPlayerCommand,
  type MiniPlayerStateSnapshot
} from '../../shared/miniPlayer'
import { runtime } from '../core/runtime'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import { createMiniPlayerWindowShape } from './miniPlayerWindow'

// Windows regions are binary 1px stair-steps. Leave a wider transparent rim
// around the antialiased CSS clip so a rounded native region can never become
// the visible edge after DPI scaling or a mid-transition bounds refresh.
const DYNAMIC_ISLAND_SHAPE_SAFETY_PX = 6
const DYNAMIC_ISLAND_SHAPE_TRANSITION_MS = 520

let expanded = false
let ownerId: string | null = null
// The plugin whose configuration is loaded. It survives hide/show so toggling
// the overlay keeps the user's DIY settings; another plugin starts from defaults.
let configOwnerId: string | null = null
let config: DynamicIslandConfig = cloneDynamicIslandConfig(DEFAULT_DYNAMIC_ISLAND_CONFIG)
let windowReady = false
let ipcBound = false
let expandedShapeTimer: NodeJS.Timeout | null = null

function liveWindow(): BrowserWindow | null {
  const win = runtime.dynamicIslandWindow
  return win && !win.isDestroyed() ? win : null
}

function isDynamicIslandSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
): boolean {
  const win = liveWindow()
  return Boolean(win && event.sender.id === win.webContents.id)
}

function assertDynamicIslandSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  capability: string
): void {
  assertTrustedIpcSender(event, capability)
  if (!isDynamicIslandSender(event)) {
    throw new Error(`${capability} rejected from unexpected window`)
  }
}

function currentState(): MiniPlayerStateSnapshot {
  return runtime.latestMiniPlayerState ?? { ...EMPTY_MINI_PLAYER_STATE }
}

function targetDisplayBounds(): Electron.Rectangle {
  const mainWindow = runtime.mainWindow
  if (config.layout.display === 'main-window' && mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds()).bounds
  }
  return screen.getPrimaryDisplay().bounds
}

function currentLayout(display = targetDisplayBounds()): DynamicIslandLayout {
  return resolveDynamicIslandLayout(config, display.width - DYNAMIC_ISLAND_EDGE_MARGIN * 2)
}

function sendToIsland(channel: string, payload: unknown): void {
  const win = liveWindow()
  if (!win || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function applyWindowShape(
  win: BrowserWindow,
  layout: DynamicIslandLayout,
  squareCorners = false
): void {
  if (process.platform !== 'win32') return
  const rect = expanded
    ? { x: 0, width: layout.width, height: layout.height, radius: layout.expandedRadius }
    : layout.collapsed
  const radius = squareCorners ? 0 : Math.max(0, rect.radius - DYNAMIC_ISLAND_SHAPE_SAFETY_PX)
  win.setShape(
    createMiniPlayerWindowShape(rect.width, rect.height, radius).map((rectangle) => ({
      ...rectangle,
      x: rectangle.x + rect.x
    }))
  )
}

function clearExpandedShapeTimer(): void {
  if (expandedShapeTimer === null) return
  clearTimeout(expandedShapeTimer)
  expandedShapeTimer = null
}

/**
 * Size and place the window for the current config. The native window always
 * keeps the expanded size: resizing a transparent Windows window at the last
 * animation frame produces a visible compositor twitch, so the collapsed pill
 * is carved out with `setShape` and a CSS clip-path instead.
 */
function applyWindowLayout(win: BrowserWindow): DynamicIslandLayout {
  const display = targetDisplayBounds()
  const layout = currentLayout(display)
  win.setBounds(resolveDynamicIslandWindowBounds(config, layout, display), false)
  applyWindowShape(win, layout, expanded && expandedShapeTimer !== null)
  return layout
}

function syncVisibility(win: BrowserWindow): void {
  if (!windowReady || runtime.forceQuit) return
  const visible = shouldShowDynamicIsland(config, currentState(), expanded)
  if (visible && !win.isVisible()) win.showInactive()
  else if (!visible && win.isVisible()) win.hide()
}

/** Push geometry, config, state and visibility to an existing window. */
function refreshWindow(win: BrowserWindow): void {
  const layout = applyWindowLayout(win)
  sendToIsland('dynamicIsland:config', { config, layout })
  sendToIsland('dynamicIsland:state', currentState())
  sendToIsland('dynamicIsland:expanded', expanded)
  syncVisibility(win)
}

function createDynamicIslandWindow(): BrowserWindow {
  const display = targetDisplayBounds()
  const bounds = resolveDynamicIslandWindowBounds(config, currentLayout(display), display)
  const win = new BrowserWindow({
    ...bounds,
    title: 'Twilight Echo Dynamic Island',
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    thickFrame: process.platform === 'win32',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  runtime.dynamicIslandWindow = win
  windowReady = false
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setBackgroundColor('#00000000')
  applyWindowLayout(win)

  win.on('ready-to-show', () => {
    if (runtime.dynamicIslandWindow !== win || win.isDestroyed() || runtime.forceQuit) return
    windowReady = true
    refreshWindow(win)
  })

  win.on('closed', () => {
    // A quick hide/show replaces the window; never touch the successor's state.
    if (runtime.dynamicIslandWindow !== win) return
    clearExpandedShapeTimer()
    runtime.dynamicIslandWindow = null
    windowReady = false
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('did-finish-load', () => {
    if (runtime.dynamicIslandWindow === win && !win.isDestroyed()) refreshWindow(win)
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    console.error(`[dynamic-island] renderer load failed: ${errorCode} ${errorDescription}`)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
    rendererUrl.searchParams.set('window', 'dynamic-island')
    void win.loadURL(rendererUrl.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'dynamic-island' }
    })
  }

  return win
}

function assertNotOwnedByOther(pluginId: string): void {
  if (ownerId && ownerId !== pluginId) {
    throw new Error(`灵动岛已被插件 ${ownerId} 使用`)
  }
}

function releaseWindow(): void {
  ownerId = null
  expanded = false
  windowReady = false
  clearExpandedShapeTimer()
  const win = liveWindow()
  if (win) win.destroy()
  runtime.dynamicIslandWindow = null
}

export function showDynamicIsland(pluginId: string): void {
  assertNotOwnedByOther(pluginId)
  ownerId = pluginId
  if (configOwnerId !== pluginId) {
    configOwnerId = pluginId
    config = cloneDynamicIslandConfig(DEFAULT_DYNAMIC_ISLAND_CONFIG)
  }
  const existing = liveWindow()
  if (existing) {
    refreshWindow(existing)
    return
  }
  createDynamicIslandWindow()
}

/**
 * Validate and apply a plugin-supplied DIY config. Works whether or not the
 * overlay is currently shown, and returns the normalized config the host will
 * actually render so the plugin can persist exactly that.
 */
export function configureDynamicIsland(pluginId: string, rawConfig: unknown): DynamicIslandConfig {
  assertNotOwnedByOther(pluginId)
  config = normalizeDynamicIslandConfig(rawConfig)
  configOwnerId = pluginId
  const win = liveWindow()
  if (win && ownerId === pluginId) refreshWindow(win)
  return cloneDynamicIslandConfig(config)
}

export function hideDynamicIsland(pluginId: string): void {
  if (ownerId !== pluginId) return
  releaseWindow()
}

export function isDynamicIslandOwner(pluginId: string): boolean {
  return ownerId === pluginId
}

export function destroyDynamicIsland(): void {
  releaseWindow()
}

export function publishDynamicIslandState(state: MiniPlayerStateSnapshot): void {
  const win = liveWindow()
  if (!win) return
  sendToIsland('dynamicIsland:state', state)
  syncVisibility(win)
}

function setExpanded(next: boolean): boolean {
  expanded = next
  const win = liveWindow()
  if (!win) return expanded
  clearExpandedShapeTimer()
  const layout = currentLayout()
  const shapeTransitionMs = DYNAMIC_ISLAND_SHAPE_TRANSITION_MS * dynamicIslandMotionScale(config)
  if (next && shapeTransitionMs > 0) {
    // The CSS surface starts as the small pill. Keep the native region square
    // while the surface is still expanding so the OS's binary corner mask
    // cannot clip the antialiased CSS radius.
    applyWindowShape(win, layout, true)
    expandedShapeTimer = setTimeout(() => {
      expandedShapeTimer = null
      if (liveWindow() !== win || !expanded) return
      applyWindowShape(win, currentLayout())
    }, shapeTransitionMs)
  } else {
    applyWindowShape(win, layout)
  }
  sendToIsland('dynamicIsland:expanded', expanded)
  syncVisibility(win)
  return expanded
}

export function setupDynamicIslandIpc(): void {
  if (ipcBound) return
  ipcBound = true

  screen.on('display-metrics-changed', () => {
    const win = liveWindow()
    if (win) refreshWindow(win)
  })

  ipcMain.handle('dynamicIsland:getBootstrap', (event): DynamicIslandBootstrap => {
    assertDynamicIslandSender(event, 'dynamic island bootstrap IPC')
    return {
      state: currentState(),
      expanded,
      config: cloneDynamicIslandConfig(config),
      layout: currentLayout()
    }
  })

  ipcMain.handle('dynamicIsland:setExpanded', (event, next: unknown) => {
    assertDynamicIslandSender(event, 'dynamic island state IPC')
    return setExpanded(next === true)
  })

  ipcMain.on('dynamicIsland:command', (event, rawCommand: unknown) => {
    if (!shouldAcceptIpcEvent(event, 'dynamic island command IPC')) return
    if (!isDynamicIslandSender(event)) {
      console.warn('dynamic island command IPC rejected from unexpected window')
      return
    }
    const command = normalizeMiniPlayerCommand(rawCommand)
    if (!command) return
    const mainWindow = runtime.mainWindow
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send('miniPlayer:command', command)
  })
}
