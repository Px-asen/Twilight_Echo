import { app } from 'electron'
import { join } from 'path'
import { runtime } from '../core/runtime'
import { setupNcmCloudTransferIpc, shutdownNcmCloudTransfers } from './cloudTransfer.ts'
import { createNcmApiRuntime } from './runtimeAdapter.ts'
import type { NcmApiRequestOptions } from '../../core/providers/ncmApi.ts'
export type { NcmApiRequestOptions } from '../../core/providers/ncmApi.ts'

export {
  NCM_OFFICIAL_LOGIN_TIMEOUT_MS,
  collectNcmOfficialCookie,
  openNcmOfficialLogin
} from './officialLogin.ts'
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
