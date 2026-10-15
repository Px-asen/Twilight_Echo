import { BrowserWindow, Menu, clipboard, type IpcMain } from 'electron'
import { assertTrustedIpcSender, shouldAcceptIpcEvent } from '../security/electronSecurity.ts'
import { nativeMenuTemplate, registerNativeContextMenuIpc } from './nativeContextMenuIpc.ts'
import { registerEqualizerClipboardIpc } from './equalizerClipboardIpc.ts'
import { readWindowChromeState } from '../app/windowChrome.ts'
import { dspEditorInteractionWindow } from '../app/dspEditorWindow.ts'

export function registerWindowIpc(ipcMain: IpcMain): void {
  ipcMain.handle('window:getState', (event) => {
    if (!shouldAcceptIpcEvent(event, 'window state IPC'))
      throw new Error('Untrusted window request')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) throw new Error('Window is unavailable')
    return readWindowChromeState(win)
  })
  registerEqualizerClipboardIpc(ipcMain, {
    assertTrusted: assertTrustedIpcSender,
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text)
  })
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
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || owner.isDestroyed() || !request.items.length) return Promise.resolve(null)
      const win = dspEditorInteractionWindow(owner, BrowserWindow.getFocusedWindow())
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
