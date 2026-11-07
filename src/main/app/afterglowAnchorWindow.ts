import { app, BaseWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { runtime } from '../core/runtime.ts'

export interface AfterglowAnchorOptions {
  /** Keep a taskbar entry the user can click to restore (minimize entry). */
  showInTaskbar: boolean
  onRestore: () => void
}

let restoreHandler: (() => void) | null = null

function getAfterglowAnchorIconPath(): string {
  if (process.platform === 'win32') {
    return is.dev
      ? join(app.getAppPath(), 'build', 'icon.ico')
      : join(process.resourcesPath, 'icon.ico')
  }
  return is.dev
    ? join(app.getAppPath(), 'build', 'icon.png')
    : join(process.resourcesPath, 'icon.png')
}

/**
 * Renderer-free Windows window that survives the Afterglow unload.
 *
 * It gives the app a taskbar entry (restore affordance) and a native window
 * handle the SMTC addon can be created against while the real main window is
 * gone. It never loads a page, so it costs no renderer process.
 */
export function createAfterglowAnchorWindow(options: AfterglowAnchorOptions): BaseWindow | null {
  if (process.platform !== 'win32') return null
  destroyAfterglowAnchorWindow()

  const window = new BaseWindow({
    width: 320,
    height: 180,
    x: -32_000,
    y: -32_000,
    show: false,
    title: 'Twilight Echo',
    icon: getAfterglowAnchorIconPath(),
    skipTaskbar: !options.showInTaskbar,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    movable: false,
    closable: false,
    hasShadow: false,
    opacity: 0
  })
  runtime.afterglowAnchorWindow = window
  restoreHandler = options.onRestore

  window.on('restore', () => {
    // Windows is still dispatching the anchor's native restore message here.
    // Replacing the window in that callback can destroy its HWND reentrantly.
    setImmediate(() => {
      if (runtime.afterglowAnchorWindow === window && !window.isDestroyed()) restoreHandler?.()
    })
  })
  window.on('closed', () => {
    if (runtime.afterglowAnchorWindow === window) {
      runtime.afterglowAnchorWindow = null
      restoreHandler = null
    }
  })

  if (options.showInTaskbar) {
    window.setSkipTaskbar(false)
    window.showInactive()
    window.minimize()
  }
  return window
}

/** Keep the taskbar restore affordance usable if recreating the UI fails. */
export function minimizeAfterglowAnchorWindow(): void {
  const window = runtime.afterglowAnchorWindow
  if (window && !window.isDestroyed() && !window.isMinimized()) window.minimize()
}

export function destroyAfterglowAnchorWindow(): void {
  restoreHandler = null
  const window = runtime.afterglowAnchorWindow
  runtime.afterglowAnchorWindow = null
  if (window && !window.isDestroyed()) window.destroy()
}

export function hasAfterglowAnchorWindow(): boolean {
  const window = runtime.afterglowAnchorWindow
  return Boolean(window && !window.isDestroyed())
}

/** Native handle used to recreate the Windows media session while unloaded. */
export function getAfterglowAnchorHandle(): Buffer | null {
  const window = runtime.afterglowAnchorWindow
  return window && !window.isDestroyed() ? window.getNativeWindowHandle() : null
}
