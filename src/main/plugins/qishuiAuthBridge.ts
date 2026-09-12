import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const QISHUI_PLUGIN_ID = 'com.twilightecho.provider.qishui'

export interface QishuiAuthModule {
  configure(hooks: {
    getConfig: () => Record<string, string>
    updateConfig: (patch: Record<string, unknown>) => void
  }): void
  getQrCode(): Promise<Record<string, unknown>>
  checkQrConnect(token: string): Promise<Record<string, unknown>>
  clear(): Promise<void>
}

export type QishuiAuthModuleLoader = (entryPath: string) => QishuiAuthModule

export interface QishuiAuthLogin {
  key: string
  qrContent?: string
  imageDataUrl?: string
  expiresInSeconds?: number
}

export interface QishuiAuthCheckResult {
  json: Record<string, unknown>
  cookie?: string
}

const nodeRequire = createRequire(import.meta.url)

function loadQishuiAuthModule(entryPath: string): QishuiAuthModule {
  return nodeRequire(entryPath) as QishuiAuthModule
}

export class QishuiAuthBridge {
  private readonly loadModule: QishuiAuthModuleLoader
  private module: QishuiAuthModule | null = null
  private versionRoot = ''
  private config: Record<string, string> = {}
  private loading: Promise<QishuiAuthModule> | null = null

  constructor(loadModule: QishuiAuthModuleLoader = loadQishuiAuthModule) {
    this.loadModule = loadModule
  }

  async getQrLogin(versionRoot: string): Promise<QishuiAuthLogin> {
    const module = await this.ensureModule(versionRoot)
    this.updateConfig({ cookie: '' })
    const envelope = await module.getQrCode()
    const data = asRecord(envelope.data)
    const key = asText(data.token)
    const qrContent = asText(data.scan_url) || asText(data.qrcode_index_url)
    const imageDataUrl = asText(data.qrcode)
    if (!key || (!qrContent && !/^data:image\//i.test(imageDataUrl))) {
      throw new Error('汽水音乐没有返回有效二维码')
    }

    const expireTime = Number(data.expire_time)
    const result: QishuiAuthLogin = { key }
    if (qrContent) result.qrContent = qrContent
    if (/^data:image\//i.test(imageDataUrl)) result.imageDataUrl = imageDataUrl
    if (Number.isFinite(expireTime) && expireTime > 0) {
      result.expiresInSeconds = Math.max(1, Math.floor(expireTime))
    }
    return result
  }

  async checkQrLogin(versionRoot: string, key: string): Promise<QishuiAuthCheckResult> {
    const module = await this.ensureModule(versionRoot)
    const token = String(key || '').trim()
    if (!token || token.length > 1024) throw new Error('汽水二维码密钥无效')
    const json = await module.checkQrConnect(token)
    const cookie = this.config.cookie?.trim()
    return cookie ? { json, cookie } : { json }
  }

  async clear(versionRoot?: string): Promise<void> {
    const root = versionRoot ? resolve(versionRoot) : ''
    if (root && this.versionRoot && root !== this.versionRoot) return
    if (this.loading) await this.loading.catch(() => undefined)
    const module = this.module
    this.module = null
    this.versionRoot = ''
    this.config = {}
    if (module) await module.clear()
  }

  private async ensureModule(versionRoot: string): Promise<QishuiAuthModule> {
    const root = resolve(versionRoot)
    const entryPath = join(root, 'qishui-auth-v6.cjs')
    if (!existsSync(entryPath)) throw new Error('汽水音乐安全登录组件不存在')
    if (this.module && this.versionRoot === root) return this.module
    if (this.loading) {
      await this.loading
      if (this.module && this.versionRoot === root) return this.module
    }
    if (this.module) await this.clear()

    const loading = Promise.resolve().then(() => {
      const module = this.loadModule(entryPath)
      if (
        typeof module.configure !== 'function' ||
        typeof module.getQrCode !== 'function' ||
        typeof module.checkQrConnect !== 'function' ||
        typeof module.clear !== 'function'
      ) {
        throw new Error('汽水音乐安全登录组件接口不完整')
      }
      this.config = {}
      module.configure({
        getConfig: () => ({ ...this.config }),
        updateConfig: (patch) => this.updateConfig(patch)
      })
      this.module = module
      this.versionRoot = root
      return module
    })
    this.loading = loading
    try {
      return await loading
    } finally {
      if (this.loading === loading) this.loading = null
    }
  }

  private updateConfig(patch: Record<string, unknown>): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'string') this.config[key] = value
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
