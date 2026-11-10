import type { NcmBindableServer as Server } from './ncmServerBinding.ts'
import { getListeningPort, waitForListeningPort } from './ncmServerBinding.ts'
import { redactSensitiveText } from '../../shared/errors/redactSensitiveText.ts'
export const NCM_API_HOST = '127.0.0.1'
export const NCM_API_REQUEST_TIMEOUT_MS = 25000
const NCM_API_ORIGIN = 'http://' + NCM_API_HOST
const MAX_NCM_API_PATH_LENGTH = 4096
const MAX_NCM_COOKIE_LENGTH = 16 * 1024
const NCM_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export interface NcmApiRequestOptions {
  signal?: AbortSignal
  idempotencyKey?: string
}
export interface NcmApiServiceOptions<TServer extends Server = Server> {
  startServer(): Promise<TServer | any>
  fetch?: (
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> }
  ) => Promise<Pick<Response, 'status' | 'headers' | 'text'>>
  now?: () => number
  closeTransport?(): Promise<void>
}
const TIMESTAMPED_NCM_API_PATHS = [
  '/login',
  '/login/',
  // The gateway caches reads for two minutes. Profile recovery and explicit
  // library refreshes must not reuse incomplete or pre-edit account content.
  '/user/playlist',
  '/user/detail',
  '/user/cloud',
  '/likelist',
  '/playlist/create',
  '/playlist/delete',
  '/playlist/tracks',
  '/like',
  '/follow',
  '/personal_fm',
  '/personal/fm/mode'
]

function shouldTimestampNcmApiPath(path: string): boolean {
  return TIMESTAMPED_NCM_API_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}/`)
  )
}

/** Owns the existing provider API listener, not a new Core control protocol. */
export class NcmApiService<TServer extends Server = Server> {
  private server: TServer | null = null
  private starting: Promise<void> | null = null
  private stopping = false
  private readonly requests = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly options: NcmApiServiceOptions<TServer>
  constructor(options: NcmApiServiceOptions<TServer>) {
    this.options = options
  }
  getServer(): TServer | null {
    return this.server
  }
  ensure(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('NetEase API is shutting down'))
    if (this.server) return Promise.resolve()
    if (this.starting) return this.starting
    const work = this.start()
    this.starting = work
    void work
      .finally(() => {
        if (this.starting === work) this.starting = null
      })
      .catch(() => undefined)
    return work
  }
  private async start(): Promise<void> {
    const server = await this.options.startServer()
    try {
      await waitForListeningPort(server)
      if (this.stopping) throw new Error('NetEase API server startup was cancelled')
      this.server = server
      server.once('close', () => {
        if (this.server === server) this.server = null
      })
    } catch (error) {
      await closeServer(server)
      throw error
    }
  }
  request(path: string, cookie?: string, options: NcmApiRequestOptions = {}): Promise<unknown> {
    if (this.stopping) return Promise.resolve({ code: -1, message: 'NetEase API is shutting down' })
    const controller = new AbortController()
    this.requests.add(controller)
    const abort = (): void => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    const work = this.performRequest(path, cookie, options.idempotencyKey, controller).finally(
      () => {
        this.requests.delete(controller)
        this.pending.delete(work)
        options.signal?.removeEventListener('abort', abort)
      }
    )
    this.pending.add(work)
    return work
  }
  private async performRequest(
    path: string,
    cookie: string | undefined,
    requestKey: string | undefined,
    controller: AbortController
  ): Promise<unknown> {
    const normalizedPath = normalizeNcmApiPath(path)
    if (!normalizedPath) {
      return { code: -1, message: 'Invalid NetEase API path' }
    }
    let port: number
    try {
      controller.signal.throwIfAborted()
      await this.ensure()
      controller.signal.throwIfAborted()
      if (!this.server) throw new Error('NetEase API server did not start')
      port = getListeningPort(this.server)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('网易云音乐服务启动失败：', redactSensitiveText(message))
      return { code: -1, message }
    }
    const separator = normalizedPath.includes('?') ? '&' : '?'
    const timestamp = shouldTimestampNcmApiPath(normalizedPath)
      ? `${separator}timestamp=${(this.options.now ?? Date.now)()}`
      : ''
    const url = `http://${NCM_API_HOST}:${port}${normalizedPath}${timestamp}`
    const headers: Record<string, string> = {}
    const normalizedCookie = normalizeNcmCookie(cookie)
    if (normalizedCookie) {
      headers.Cookie = normalizedCookie
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .join('; ')
    }
    const idempotencyKey = requestKey?.trim()
    if (idempotencyKey && NCM_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      headers['X-Twilight-Idempotency-Key'] = idempotencyKey
    }
    // NCBL submits two uploads, each with a 15-second upstream deadline.
    const timeout = normalizedPath.split('?')[0] === '/scrobble/v1'
      ? 40_000 : NCM_API_REQUEST_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await (this.options.fetch ?? fetch)(url, {
        signal: controller.signal,
        headers
      })
      const responseText = await res.text()
      try {
        return JSON.parse(responseText) as unknown
      } catch {
        const contentType = res.headers.get('content-type') || 'unknown content type'
        throw new Error(`NetEase API returned invalid JSON (HTTP ${res.status}, ${contentType})`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        '网易云请求失败：',
        redactSensitiveText(normalizedPath),
        redactSensitiveText(message)
      )
      return {
        code: -1,
        message
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const controller of this.requests)
      controller.abort(new Error('NetEase API is shutting down'))
    await this.starting?.catch(() => undefined)
    await Promise.allSettled(this.pending)
    // Release the client's pooled sockets before awaiting the listener that owns their other end.
    await this.options.closeTransport?.()
    const server = this.server
    if (server) await closeServer(server)
    this.server = null
  }
}
function normalizeNcmApiPath(path: unknown): string | null {
  let normalized: string
  try {
    normalized = normalizeApiString(path, 'NCM API path', MAX_NCM_API_PATH_LENGTH)
  } catch {
    return null
  }
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('\\'))
    return null
  try {
    const parsed = new URL(normalized, NCM_API_ORIGIN)
    if (parsed.origin !== NCM_API_ORIGIN) return null
    return normalized
  } catch {
    return null
  }
}

function normalizeNcmCookie(cookie: unknown): string | undefined {
  if (cookie == null || cookie === '') return undefined
  try {
    return normalizeApiString(cookie, 'NCM cookie', MAX_NCM_COOKIE_LENGTH)
  } catch {
    return undefined
  }
}

function normalizeApiString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(field + ' must be a string')
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\0\r\n]/.test(normalized))
    throw new Error(field + ' is invalid')
  return normalized
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
