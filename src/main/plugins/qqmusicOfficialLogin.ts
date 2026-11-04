import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { isQqMusicLoginUrl, qqMusicCredentialFromCookies } from '../../shared/qqmusicLogin.ts'
import type { QqMusicOfficialCredential } from '../../shared/qqmusicLogin.ts'

export function openQqMusicOfficialLogin(
  signal?: AbortSignal,
  owner?: BrowserWindow
): Promise<QqMusicOfficialCredential> {
  signal?.throwIfAborted()
  const loginSession = session.fromPartition(`twilight-qq-login-${randomUUID()}`)
  const loginWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 760,
    minHeight: 600,
    title: 'QQ 音乐官方登录',
    parent: owner,
    show: false,
    webPreferences: {
      session: loginSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const windows = new Set([loginWindow])
    const finish = (error?: Error, credential?: QqMusicOfficialCredential): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      loginSession.cookies.removeListener('changed', changed)
      for (const window of windows) if (!window.isDestroyed()) window.destroy()
      void loginSession.clearStorageData().catch(() => undefined)
      if (error) reject(error)
      else resolve(credential!)
    }
    const abort = (): void => finish(new Error('QQ 音乐官方登录已取消'))
    const changed = (): void => {
      void loginSession.cookies
        .get({ url: 'https://y.qq.com/' })
        .then((cookies) => {
          const credential = qqMusicCredentialFromCookies(cookies)
          if (credential) finish(undefined, credential)
        })
        .catch(() => finish(new Error('读取 QQ 音乐登录会话失败')))
    }
    const protectWindow = (window: BrowserWindow): void => {
      windows.add(window)
      window.webContents.setWindowOpenHandler(({ url }) =>
        isQqMusicLoginUrl(url)
          ? {
              action: 'allow',
              overrideBrowserWindowOptions: {
                webPreferences: {
                  session: loginSession,
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: true
                }
              }
            }
          : { action: 'deny' }
      )
      window.webContents.on('will-navigate', (event, url) => {
        if (!isQqMusicLoginUrl(url)) event.preventDefault()
      })
      window.webContents.on('will-redirect', (event, url) => {
        if (!isQqMusicLoginUrl(url)) event.preventDefault()
      })
      window.webContents.on('did-create-window', (child) => protectWindow(child))
      window.once('closed', () => windows.delete(window))
    }
    const timer = setTimeout(
      () => finish(new Error('QQ 音乐官方登录超时，请重新打开登录窗口')),
      180_000
    )
    protectWindow(loginWindow)
    loginWindow.once('closed', abort)
    loginWindow.once('ready-to-show', () => {
      if (!settled) loginWindow.show()
    })
    loginSession.cookies.on('changed', changed)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    void loginWindow
      .loadURL('https://y.qq.com/n/ryqq/')
      .catch(() => finish(new Error('QQ 音乐官方登录页加载失败')))
  })
}
