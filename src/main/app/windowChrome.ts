import type { BrowserWindow } from 'electron'
import type { WindowChromeState } from '../../shared/windowChrome.ts'

export function readWindowChromeState(
  win: Pick<BrowserWindow, 'isMaximized' | 'isFullScreen'>,
  platform: NodeJS.Platform = process.platform
): WindowChromeState {
  return {
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    maximizeBehavior: platform === 'darwin' ? 'fullscreen' : 'maximize'
  }
}

export function toggleWindowMaximize(
  win: BrowserWindow,
  platform: NodeJS.Platform = process.platform
): void {
  if (win.isDestroyed()) return
  const fullScreen = win.isFullScreen()
  if (platform === 'darwin' || fullScreen) {
    win.setFullScreen(!fullScreen)
  } else if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
}

export function installWindowChromePublisher(win: BrowserWindow): () => void {
  const publish = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('window:state-changed', readWindowChromeState(win))
  }
  const dispose = (): void => {
    win.off('maximize', publish)
    win.off('unmaximize', publish)
    win.off('enter-full-screen', publish)
    win.off('leave-full-screen', publish)
    win.off('closed', dispose)
  }
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  // macOS completes native fullscreen asynchronously; publish only the actual state.
  win.on('enter-full-screen', publish)
  win.on('leave-full-screen', publish)
  win.once('closed', dispose)
  return dispose
}
