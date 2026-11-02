import { app, BrowserWindow, session, shell } from 'electron'
import { isSafeExternalUrl } from '../security/externalUrl.ts'
import { join } from 'path'
import { runtime } from '../core/runtime'
import { setupNcmCloudTransferIpc, shutdownNcmCloudTransfers } from './cloudTransfer.ts'
import { createNcmApiRuntime } from './runtimeAdapter.ts'
import type { NcmApiRequestOptions } from '../../core/providers/ncmApi.ts'
export type { NcmApiRequestOptions } from '../../core/providers/ncmApi.ts'

export const NCM_OFFICIAL_LOGIN_TIMEOUT_MS = 180000
export { NCM_API_HOST, NCM_API_REQUEST_TIMEOUT_MS } from '../../core/providers/ncmApi.ts'
const ncm = createNcmApiRuntime()

export function bundledPluginPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugins', name)
    : join(process.cwd(), 'resources', 'plugins', name)
}

export function bundledPluginIndexPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugin-index', 'plugins.json')
    : join(process.cwd(), 'resources', 'plugin-index', 'plugins.json')
}

export const requestNcmApi = (
  path: string,
  cookie?: string,
  options: NcmApiRequestOptions = {}
): Promise<unknown> =>
  ncm.request(path, cookie, options).finally(() => {
    runtime.ncmServer = ncm.getServer()
  })

export async function shutdownNcmApi(): Promise<void> {
  await shutdownNcmCloudTransfers()
  await ncm.shutdown()
  runtime.ncmServer = null
  runtime.ncmServerPromise = null
}

export async function collectNcmOfficialCookie(partition: string): Promise<string> {
  const ses = session.fromPartition(partition)
  const cookies = await ses.cookies.get({ domain: '.music.163.com' })
  const names = new Set(['MUSIC_U', '__csrf', 'NMTID', 'MUSIC_A'])
  return cookies
    .filter((cookie) => names.has(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join(';')
}

export async function openNcmOfficialLogin(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  // 内存分区（去掉 persist: 前缀）：登录 Cookie 只存活于登录窗口会话期间，不落盘到 userData/Partitions。
  // 登录完成后 Cookie 已通过 collectNcmOfficialCookie 取回，会话随之销毁。
  const partition = `twilight-ncm-login-${Date.now()}`
  const ses = session.fromPartition(partition)
  await ses.clearStorageData().catch(() => undefined)

  return await new Promise<string>((resolveLogin, rejectLogin) => {
    const owner =
      runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : undefined
    const loginWindow = new BrowserWindow({
      width: 920,
      height: 680,
      minWidth: 720,
      minHeight: 560,
      title: '网易云音乐登录',
      parent: owner,
      modal: false,
      show: false,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false
      }
    })

    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      ses.cookies.removeListener('changed', handleCookieChanged)
      loginWindow.removeAllListeners('closed')
    }
    const finish = (cookie: string): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!loginWindow.isDestroyed()) loginWindow.close()
      resolveLogin(cookie)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!loginWindow.isDestroyed()) loginWindow.close()
      rejectLogin(error)
    }
    const abort = (): void => fail(new Error('网易云官方登录已取消'))
    const checkCookie = async (): Promise<void> => {
      const cookie = await collectNcmOfficialCookie(partition)
      if (cookie.includes('MUSIC_U=')) finish(cookie)
    }
    const handleCookieChanged = (): void => {
      void checkCookie().catch(() => undefined)
    }
    const timer = setTimeout(() => {
      fail(new Error('网易云官方登录超时'))
    }, NCM_OFFICIAL_LOGIN_TIMEOUT_MS)

    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    ses.cookies.on('changed', handleCookieChanged)
    loginWindow.once('closed', () => {
      if (!settled) {
        settled = true
        cleanup()
        rejectLogin(new Error('已取消网易云官方登录'))
      }
    })
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?music\.163\.com\//i.test(url)) return { action: 'allow' }
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    loginWindow.webContents.on('will-navigate', (event, url) => {
      if (/^https?:\/\/([^/]+\.)?music\.163\.com\//i.test(url)) return
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    })
    loginWindow.once('ready-to-show', () => loginWindow.show())
    loginWindow
      .loadURL('https://music.163.com/#/login')
      .then(() => checkCookie())
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

export function setupNcmIpc(): void {
  setupNcmCloudTransferIpc()
}

export function ensureNcmServer(): Promise<void> {
  if (runtime.ncmServerPromise) return runtime.ncmServerPromise
  const work = ncm.ensure().then(() => {
    runtime.ncmServer = ncm.getServer()
  })
  runtime.ncmServerPromise = work
  void work
    .finally(() => {
      if (runtime.ncmServerPromise === work) runtime.ncmServerPromise = null
    })
    .catch(() => undefined)
  return work
}
