import { BrowserWindow, Menu, type IpcMain } from 'electron'
import { shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import { nativeMenuTemplate, registerNativeContextMenuIpc } from './nativeContextMenuIpc.ts'

export function registerWindowIpc(ipcMain: IpcMain): void {
  const menus = new Map<number, { requestId: string; close: () => void }>()
  registerNativeContextMenuIpc(ipcMain, {
    assertTrusted: (event, scope) => {
      if (!shouldAcceptIpcEvent(event, scope)) throw new Error('Untrusted context menu request')
    },
    close: (event, requestId) => {
      const active = menus.get(event.sender.id)
      if (active?.requestId === requestId) active.close()
    },
    popup: (event, request) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed() || !request.items.length) return Promise.resolve(null)
      const senderId = event.sender.id
      menus.get(senderId)?.close()
      return new Promise((resolve) => {
        let selected: string | null = null
        const menu = Menu.buildFromTemplate(
          nativeMenuTemplate(request.items, (id) => {
            selected = id
          })
        )
        const finish = (): void => {
          if (menus.get(senderId)?.requestId === request.requestId) menus.delete(senderId)
          event.sender.removeListener('destroyed', close)
          resolve(selected)
        }
        const close = (): void => {
          menu.closePopup(win)
          finish()
        }
        menus.set(senderId, { requestId: request.requestId, close })
        event.sender.once('destroyed', close)
        menu.popup({ window: win, callback: finish })
      })
    }
  })
  ipcMain.on('window:minimize', (event) => {
    if (!shouldAcceptIpcEvent(event, 'window control IPC')) return
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:toggleMaximize', (event) => {
    if (!shouldAcceptIpcEvent(event, 'window control IPC')) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    if (!shouldAcceptIpcEvent(event, 'window control IPC')) return
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
