import {
  coreFs,
  coreHttp,
  coreHttps,
  coreNet,
  coreStream,
  type PortableHttpServer,
  type PortableIncomingMessage,
  type PortableServerResponse
} from '../ports/index.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'
import { join, extname } from '../../shared/portablePath.ts'
import { parseByteRange } from './byteRange.ts'
import { RemoteAuthSession } from './auth.ts'
import { RemoteDevicePairing } from './devicePairing.ts'
import { MediaStreamGrantStore, guessAudioContentType } from './mediaTokens.ts'
import { remotePairingCode, type RemoteTlsIdentity } from './tlsIdentity.ts'
import {
  createEmptyRemotePlaybackSnapshot,
  isPrivateOrLocalIp,
  parseRemoteBrowseRequest,
  parseRemotePlayerCommand,
  type RemoteBrowseRequest,
  type RemoteBrowseResult,
  type PlayerRemoteCommand,
  type RemoteControlStatus,
  type RemotePlaybackSnapshot
} from '../../shared/remoteControl.ts'
import { REMOTE_SSE_HEARTBEAT_MS } from '../../shared/remoteControl.ts'
import { parseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { mediaSourceVersion } from '../remote/media.ts'
import { REMOTE_STREAM_RANGE_BYTES } from '../../shared/remoteMedia.ts'
import {
  REMOTE_CORE_BRIDGE_VERSION,
  REMOTE_CORE_LOCAL_ZONE,
  REMOTE_CORE_PROTOCOL_RANGE,
  REMOTE_CORE_COMMANDS,
  REMOTE_CORE_QUERIES,
  type RemoteCoreRpcContext
} from '../../shared/remoteCoreBridge.ts'

export type RemoteServerMode = 'full' | 'mediaOnly'

export type RemoteCommandHandler = (command: PlayerRemoteCommand) => Promise<void> | void
export type RemoteBrowseHandler = (request: RemoteBrowseRequest) => Promise<RemoteBrowseResult>
export type RemoteCoreRpcHandler = (
  envelope: Record<string, unknown>, principal?: string, context?: RemoteCoreRpcContext
) => Promise<Record<string, unknown>>

export class RemoteCommandError extends Error {
  readonly status: number

  constructor(message: string, status = 503) {
    super(message)
    this.status = status
  }
}

export interface RemoteHttpServerOptions {
  serverName?: string
  devicePairing?: RemoteDevicePairing
  confirmDevice?(request: import('../../shared/remoteControl.ts').RemotePairingRequest, signal: AbortSignal): Promise<boolean>
  discovery?: {
    start(info: { serverId: string; name: string; port: number; pairingMode?: string }): Promise<void>
    stop(): Promise<void>
  }
  staticRoot: string
  addresses(): readonly string[]
  now?: () => number
  useSource?<T>(action: () => Promise<T>): Promise<T>
  onCommand?: RemoteCommandHandler
  onBrowse?: RemoteBrowseHandler
  onCoreRpc?: RemoteCoreRpcHandler
  auth?: RemoteAuthSession
  mediaGrants?: MediaStreamGrantStore
  preferredPort?: number
  /**
   * Serves TLS on the same port as plain HTTP. Paired phones then reach the Core only over TLS:
   * approval needs the verification-code exchange and device tokens are refused in plain text.
   */
  tls?: RemoteTlsIdentity
}

export class RemoteHttpServer {
  private server: PortableHttpServer | null = null
  private port: number | null = null
  /** Full remote-control surface (pair/UI/commands). False in mediaOnly cast mode. */
  private enabled = false
  private mode: RemoteServerMode = 'full'
  private lastError: string | null = null
  private readonly auth: RemoteAuthSession
  private readonly devicePairing: RemoteDevicePairing
  private discovery: 'advertising' | 'unavailable' | 'off' = 'off'
  private discoveryError: string | null = null
  private readonly sseAuthorization = new Map<PortableServerResponse, string>()
  private readonly approvals = new Map<string, AbortController>()
  private readonly phoneReads = new Map<PortableServerResponse, string>()
  private readonly mediaGrants: MediaStreamGrantStore
  private readonly staticRoot: string
  private readonly options: RemoteHttpServerOptions
  private onCommand: RemoteCommandHandler | null
  private onBrowse: RemoteBrowseHandler | null
  private onCoreRpc: RemoteCoreRpcHandler | null
  private snapshot: RemotePlaybackSnapshot = createEmptyRemotePlaybackSnapshot()
  private coreStateEvent: Record<string, unknown> | null = null
  private readonly sseClients = new Set<PortableServerResponse>()
  /** S3: SSE 长连接上限，防止局域网内开大量 /api/events 耗尽资源。 */
  private readonly sseMaxClients = 8
  private readonly sseMaxBufferedBytes = 1024 * 1024
  private browseInFlight = 0
  private readonly maxBrowseInFlight = 2
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: RemoteHttpServerOptions) {
    this.options = options
    this.auth = options.auth ?? new RemoteAuthSession()
    this.devicePairing = options.devicePairing ?? new RemoteDevicePairing({ now: options.now })
    this.mediaGrants = options.mediaGrants ?? new MediaStreamGrantStore()
    this.staticRoot = options.staticRoot
    this.onCommand = options.onCommand ?? null
    this.onBrowse = options.onBrowse ?? null
    this.onCoreRpc = options.onCoreRpc ?? null
  }

  setCommandHandler(handler: RemoteCommandHandler | null): void {
    this.onCommand = handler
  }

  setBrowseHandler(handler: RemoteBrowseHandler | null): void {
    this.onBrowse = handler
  }

  setCoreRpcHandler(handler: RemoteCoreRpcHandler | null): void {
    this.onCoreRpc = handler
  }

  updateCoreStateEvent(event: Record<string, unknown>): void {
    this.coreStateEvent = event
    this.broadcastSse('core_state', event)
  }

  getAuth(): RemoteAuthSession {
    return this.auth
  }

  getMediaGrants(): MediaStreamGrantStore {
    return this.mediaGrants
  }

  isMediaOnly(): boolean {
    return this.mode === 'mediaOnly' && this.server != null
  }

  getStatus(): RemoteControlStatus {
    const mediaOnly = this.mode === 'mediaOnly' && this.server != null
    return {
      serverId: this.devicePairing.serverId,
      serverName: this.options.serverName ?? 'Twilight Echo',
      discovery: this.discovery,
      discoveryError: this.discoveryError,
      pairingRequests: this.enabled && !mediaOnly ? this.devicePairing.pending() : [],
      trustedDevices: this.devicePairing.devices(),
      // "enabled" means full remote control is on — never true for media-only cast.
      enabled: this.enabled && !mediaOnly,
      running: this.server != null && this.port != null,
      port: this.port,
      pin: this.enabled && !mediaOnly ? this.auth.getPin() : null,
      urls: this.enabled && !mediaOnly && this.port != null ? this.listLanUrls(this.port) : [],
      paired: this.enabled && !mediaOnly ? this.auth.isPaired() || this.devicePairing.devices().length > 0 : false,
      clientCount: this.sseClients.size,
      lastError: this.lastError,
      mediaOnly
    }
  }

  updatePlaybackSnapshot(snapshot: RemotePlaybackSnapshot): void {
    const coverChanged = this.snapshot.coverUrl !== snapshot.coverUrl
    this.snapshot = { ...snapshot, updatedAt: this.options.now?.() ?? Date.now() }
    if (coverChanged) this.broadcastSse('state', this.snapshot)
    else {
      const { coverUrl: _coverUrl, ...state } = this.snapshot
      this.broadcastSse('state', state)
    }
  }

  getPlaybackSnapshot(): RemotePlaybackSnapshot {
    return this.snapshot
  }

  /**
   * Bind the LAN HTTP server.
   * - full: remote UI, PIN pair, command API, media tokens
   * - mediaOnly: media tokens only (cast), no pair/UI/commands; remote stays "off"
   *
   * Mode switches on an already-bound server are in-place: media grants are kept
   * so active cast `/media/{token}` URLs survive remote on/off toggles.
   */
  async start(
    preferredPort = 0,
    options: { mode?: RemoteServerMode } = {}
  ): Promise<RemoteControlStatus> {
    const desiredMode: RemoteServerMode = options.mode ?? 'full'
    if (this.server) {
      if (this.mode === desiredMode) return this.getStatus()
      this.applyMode(desiredMode)
      await this.syncDiscovery()
      return this.getStatus()
    }
    this.applyMode(desiredMode)
    this.lastError = null

    await new Promise<void>((resolve, reject) => {
      const handler = (req: PortableIncomingMessage, res: PortableServerResponse) => {
        void this.handleRequest(req, res)
      }
      const server = this.options.tls ? dualProtocolServer(handler, this.options.tls) : coreHttp.createServer(handler)
      server.on('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        reject(error)
      })
      server.listen(preferredPort, '0.0.0.0', () => {
        const address = server.address()
        this.port = address && typeof address === 'object' ? address.port : preferredPort || null
        this.server = server
        if (desiredMode === 'full') this.startHeartbeat()
        resolve()
      })
    })

    await this.syncDiscovery()
    return this.getStatus()
  }

  private async syncDiscovery(): Promise<void> {
    if (!this.options.discovery) return
    this.discoveryError = null
    try {
      if (this.enabled && this.port && this.onCoreRpc) {
        await this.options.discovery.start({ serverId: this.devicePairing.serverId,
          name: this.options.serverName ?? 'Twilight Echo', port: this.port,
          pairingMode: this.options.tls ? 'approval-v2' : 'approval-v1' })
        this.discovery = 'advertising'
      } else {
        await this.options.discovery.stop()
        this.discovery = 'off'
      }
    } catch {
      this.discovery = 'unavailable'
      this.discoveryError = '局域网发现不可用，请检查防火墙的 UDP 5353 权限；仍可通过地址连接。'
    }
  }

  private resolveAllowedOrigin(origin: string | undefined, host: string): string | null {
    if (!origin) return null
    try {
      const parsed = new URL(origin)
      if (parsed.host === host) return parsed.origin
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return parsed.origin
    } catch {
      return null
    }
    return null
  }

  /**
   * Switch surface mode without closing the socket or clearing media grants.
   * Demoting full → mediaOnly revokes remote pair sessions and drops SSE clients.
   */
  applyMode(desiredMode: RemoteServerMode): void {
    const previous = this.mode
    this.mode = desiredMode
    this.enabled = desiredMode === 'full'
    this.lastError = null
    if (desiredMode === 'full') {
      if (!this.auth.getPin()) this.auth.rotatePin()
      if (this.server) this.startHeartbeat()
      return
    }
    // mediaOnly: close remote-control surface only.
    this.stopHeartbeat()
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()
    // Revoke pair tokens when leaving full mode; keep cast media grants.
    this.sseAuthorization.clear()
    this.revokePhoneStreams()
    this.devicePairing.clearPending()
    this.cancelApprovals()
    if (previous === 'full') this.auth.revokeToken()
  }

  async stop(): Promise<void> {
    this.enabled = false
    this.mode = 'full'
    this.stopHeartbeat()
    await this.syncDiscovery()
    this.devicePairing.clearPending()
    this.cancelApprovals()
    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()
    this.sseAuthorization.clear()
    this.mediaGrants.clear()
    this.auth.revokeToken()

    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      ;(server as PortableHttpServer & { closeAllConnections?: () => void }).closeAllConnections?.()
    })
  }

  rotatePin(): string {
    this.cancelApprovals()
    this.revokePhoneStreams()
    this.devicePairing.revoke()
    const pin = this.auth.rotatePin()
    this.broadcastSse('auth', { paired: false })
    return pin
  }

  decidePairing(requestId: string, allow: boolean): RemoteControlStatus {
    if (!this.devicePairing.decide(requestId, allow)) throw new RemoteCommandError('pair_request_expired', 404)
    this.approvals.get(requestId)?.abort()
    return this.getStatus()
  }

  private confirmPairing(requestId: string): void {
    const pending = this.devicePairing.pending().find(p => p.id === requestId)
    if (!pending || !this.options.confirmDevice) return
    const controller = new AbortController()
    this.approvals.set(requestId, controller)
    const timer = setTimeout(() => controller.abort(), 120_000)
    void this.options.confirmDevice(pending, controller.signal).then(allow => {
      if (!controller.signal.aborted) this.devicePairing.decide(requestId, allow)
    }).catch(() => { this.devicePairing.decide(requestId, false) }).finally(() => {
      clearTimeout(timer); this.approvals.delete(requestId)
    })
  }

  private cancelApprovals(): void {
    for (const controller of this.approvals.values()) controller.abort()
    this.approvals.clear()
  }

  revokeDevice(id: string): RemoteControlStatus {
    this.devicePairing.revoke(id)
    this.revokePhoneStreams(id)
    this.dropUnauthorizedClients()
    return this.getStatus()
  }

  private revokePhoneStreams(principal?: string): void {
    this.mediaGrants.revokeStreams(principal)
    for (const [response, owner] of this.phoneReads)
      if (!principal || owner === principal) response.destroy()
  }

  private dropUnauthorizedClients(): void {
    for (const client of this.sseClients) {
      const bearer = this.sseAuthorization.get(client) ?? ''
      // The transport was checked when the stream was admitted; this only drops revoked credentials.
      if (!this.authorizedBearer(bearer, true)) {
        this.writeSse(client, 'event: auth\ndata: {"paired":false}\n\n')
        client.end()
        this.sseClients.delete(client)
        this.sseAuthorization.delete(client)
      }
    }
  }

  issueMediaUrl(filePath: string, title?: string): string | null {
    if (!this.port) return null
    const token = this.mediaGrants.issueFile(filePath, {
      contentType: guessAudioContentType(filePath),
      title
    })
    return this.mediaUrlForToken(token)
  }

  /** Proxy an upstream http(s) audio URL through the LAN media token endpoint. */
  issueRemoteMediaUrl(
    remoteUrl: string,
    options: { title?: string; contentType?: string } = {}
  ): string | null {
    if (!this.port) return null
    const token = this.mediaGrants.issueRemote(remoteUrl, {
      contentType: options.contentType ?? guessAudioContentType(remoteUrl),
      title: options.title
    })
    return this.mediaUrlForToken(token)
  }

  private mediaUrlForToken(token: string): string | null {
    if (!this.port) return null
    const host = this.listLanUrls(this.port)[0]
    if (!host) return null
    return `${host}/media/${token}`
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.broadcastSse('ping', { t: this.options.now?.() ?? Date.now() })
    }, REMOTE_SSE_HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private listLanUrls(port: number): string[] {
    const urls = new Set<string>()
    for (const address of this.options.addresses()) {
      if (isPrivateOrLocalIp(address)) urls.add(`http://${address}:${port}`)
    }
    if (urls.size === 0) urls.add(`http://127.0.0.1:${port}`)
    return Array.from(urls)
  }

  private async handleRequest(
    req: PortableIncomingMessage,
    res: PortableServerResponse
  ): Promise<void> {
    try {
      const hostHeader = req.headers.host
      const host =
        (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ?? `127.0.0.1:${this.port ?? 0}`
      const url = new URL(req.url ?? '/', `http://${host}`)
      const remoteIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '')
      if (remoteIp && !isPrivateOrLocalIp(remoteIp) && remoteIp !== '::1') {
        this.sendJson(res, 403, { error: 'lan_only' })
        return
      }

      const originHeader = req.headers.origin
      const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
      // S2: CORS 不再无条件 `*`，仅当 Origin 与本服务同源（或本机回环）时回显。
      // 任意第三方网页跨源读取将被浏览器拦截。
      ;(res as PortableServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin =
        this.resolveAllowedOrigin(origin, host)

      if (req.method === 'OPTIONS') {
        res.writeHead(
          204,
          corsHeaders(
            (res as PortableServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin
          )
        )
        res.end()
        return
      }

      // Media-only cast bind: only capability-token media streaming is exposed.
      if (this.mode === 'mediaOnly') {
        if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/media/')) {
          const token = url.pathname.slice('/media/'.length)
          await this.serveMedia(req, res, token)
          return
        }
        this.sendJson(res, 404, { error: 'media_only' })
        return
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        this.serveStatic(res, 'index.html')
        return
      }
      if (req.method === 'GET' && url.pathname === '/remote.js') {
        this.serveStatic(res, 'remote.js', 'application/javascript; charset=utf-8')
        return
      }
      if (req.method === 'GET' && url.pathname === '/remote.css') {
        this.serveStatic(res, 'remote.css', 'text/css; charset=utf-8')
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        this.sendJson(res, 200, {
          requiresPairing: true,
          paired: this.auth.isPaired(),
          serverId: this.devicePairing.serverId,
          serverName: this.options.serverName ?? 'Twilight Echo',
          pairingMode: this.options.tls ? 'approval-v2' : 'approval-v1',
          tls: !!this.options.tls,
          app: 'Twilight Echo',
          coreBridge: this.onCoreRpc !== null,
          // `protocolVersion` stays for clients from before negotiation; newer ones read the range.
          protocolVersion: REMOTE_CORE_PROTOCOL_RANGE.min,
          protocolVersions: REMOTE_CORE_PROTOCOL_RANGE,
          coreBridgeVersion: REMOTE_CORE_BRIDGE_VERSION,
          zones: [{ zoneId: REMOTE_CORE_LOCAL_ZONE, name: this.options.serverName ?? 'Twilight Echo' }],
          capabilities: this.onCoreRpc
            ? { queries: REMOTE_CORE_QUERIES.filter(name => name !== 'providers.session' || req.socket.encrypted === true),
                commands: REMOTE_CORE_COMMANDS }
            : null
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const body = await readJsonBody(req)
        const pin = typeof body?.pin === 'string' ? body.pin : ''
        const result = this.auth.pair(pin)
        if (!result.ok) {
          this.sendJson(res, 401, { error: result.reason })
          return
        }
        this.dropUnauthorizedClients()
        this.sendJson(res, 200, { token: result.token })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/pair/requests') {
        if (origin && this.resolveAllowedOrigin(origin, host) === null) {
          this.sendJson(res, 403, { error: 'origin_not_allowed' }); return
        }
        if (this.options.tls && req.socket.encrypted !== true) {
          this.sendJson(res, 403, { error: 'tls_required' }); return
        }
        const body = await readJsonBody(req)
        try {
          const commitment = this.options.tls ? body?.commitment : undefined
          if (this.options.tls && (typeof commitment !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(commitment)))
            throw new Error('invalid_commitment')
          const ticket = this.devicePairing.request(body?.deviceName, remoteIp, commitment as string | undefined)
          this.sendJson(res, 202, ticket)
          // With TLS the desktop asks only once the phone revealed its nonce and both screens can show the code.
          if (!this.options.tls) this.confirmPairing(ticket.requestId)
        } catch (error) {
          this.sendJson(res, error instanceof Error && ['invalid_device_name', 'invalid_commitment'].includes(error.message) ? 400 : 429,
            { error: error instanceof Error ? error.message : 'pair_request_failed' })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/reveal') {
        const tls = this.options.tls
        if (!tls || req.socket.encrypted !== true) {
          this.sendJson(res, tls ? 403 : 404, { error: tls ? 'tls_required' : 'not_found' }); return
        }
        const body = await readJsonBody(req)
        const revealed = typeof body?.requestId === 'string' && typeof body?.claimSecret === 'string' &&
          typeof body?.nonce === 'string' && body.requestId.length <= 64 && body.claimSecret.length <= 128 &&
          body.nonce.length <= 128 &&
          this.devicePairing.reveal(body.requestId, body.claimSecret, body.nonce,
            (serverNonce) => remotePairingCode(tls.fingerprint, body.nonce as string, serverNonce))
        if (!revealed) { this.sendJson(res, 404, { error: 'pair_request_expired' }); return }
        this.sendJson(res, 200, { state: 'pending' })
        this.confirmPairing(body!.requestId as string)
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/claim') {
        const body = await readJsonBody(req)
        const result = typeof body?.requestId === 'string' && typeof body?.claimSecret === 'string' &&
          body.requestId.length <= 64 && body.claimSecret.length <= 128
          ? this.devicePairing.claim(body.requestId, body.claimSecret) : null
        this.sendJson(res, result ? 200 : 404, result ?? { error: 'pair_request_expired' })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/cancel') {
        const body = await readJsonBody(req)
        const result = typeof body?.requestId === 'string' && typeof body?.claimSecret === 'string' &&
          body.requestId.length <= 64 && body.claimSecret.length <= 128
          ? this.devicePairing.claim(body.requestId, body.claimSecret) : null
        if (result?.state === 'pending') {
          this.devicePairing.decide(body!.requestId as string, false)
          this.approvals.get(body!.requestId as string)?.abort()
        }
        this.sendJson(res, result ? 200 : 404, { cancelled: !!result })
        return
      }

      // A phone that forgets this computer gives up its own credential; it can never revoke another device.
      if (req.method === 'POST' && url.pathname === '/api/pair/forget') {
        const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization
        const token = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined
        const principal = token ? this.devicePrincipal(token, req.socket.encrypted === true) : null
        if (!principal) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        this.revokeDevice(principal)
        this.sendJson(res, 200, { forgotten: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        this.sendJson(res, 200, this.snapshot)
        return
      }

      if (
        req.method === 'GET' &&
        (url.pathname === '/api/events' || url.pathname === '/api/core/events')
      ) {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        const authorization = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization
        this.attachSse(res, authorization ?? `Bearer ${url.searchParams.get('token') ?? ''}`)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/core/rpc') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        if (!this.auth.tryConsumeCommand()) {
          this.sendJson(res, 429, { error: 'rate_limited' })
          return
        }
        const body = await readJsonBody(req)
        if (!body || typeof body.requestId !== 'string' || typeof body.name !== 'string') {
          this.sendJson(res, 400, { error: 'invalid_core_envelope' })
          return
        }
        if (!this.onCoreRpc) {
          this.sendJson(res, 503, { error: 'core_rpc_handler_missing' })
          return
        }
        const responseEnvelope = await this.onCoreRpc(body, this.mediaPrincipal(req) ?? undefined,
          { encrypted: req.socket.encrypted === true, serverId: this.devicePairing.serverId })
        // A credential read may await the provider/keyring. Revocation or disabling remote
        // control while it is pending must also prevent the completed response being sent.
        if (body.name === 'providers.session' && (!this.enabled || !this.authorize(req, url))) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        this.sendJson(res, 200, responseEnvelope)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/browse') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        const browse = parseRemoteBrowseRequest(url.searchParams)
        if (!browse) {
          this.sendJson(res, 400, { error: 'invalid_browse_request' })
          return
        }
        if (!this.onBrowse) {
          this.sendJson(res, 503, { error: 'browse_handler_missing' })
          return
        }
        if (this.browseInFlight >= this.maxBrowseInFlight) {
          this.sendJson(res, 429, { error: 'browse_busy' })
          return
        }
        this.browseInFlight++
        try {
          const result = await this.onBrowse(browse)
          this.sendJson(res, 200, result)
        } finally {
          this.browseInFlight--
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/command') {
        if (!this.authorize(req, url)) {
          this.sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        if (!this.auth.tryConsumeCommand()) {
          this.sendJson(res, 429, { error: 'rate_limited' })
          return
        }
        const body = await readJsonBody(req)
        const command = parseRemotePlayerCommand(body)
        if (!command) {
          this.sendJson(res, 400, { error: 'invalid_command' })
          return
        }
        if (!this.onCommand) {
          this.sendJson(res, 503, { error: 'command_handler_missing' })
          return
        }
        await this.onCommand(command)
        this.sendJson(res, 200, { ok: true })
        return
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/media/')) {
        const token = url.pathname.slice('/media/'.length)
        await this.serveMedia(req, res, token)
        return
      }

      this.sendJson(res, 404, { error: 'not_found' })
    } catch (error) {
      if (error instanceof RemoteCommandError) {
        this.sendJson(res, error.status, { error: error.message })
        return
      }
      this.sendJson(res, 500, { error: 'remote_request_failed' })
    }
  }

  private authorize(req: PortableIncomingMessage, url: URL): boolean {
    const authHeader = req.headers.authorization
    const authorization = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (this.authorizedBearer(authorization, req.socket.encrypted === true)) return true
    return this.auth.authorizeTokenQuery(url.searchParams.get('token'))
  }

  /** Device tokens never travel in plain text once the server offers TLS; PIN sessions serve the browser remote. */
  private devicePrincipal(token: string, encrypted: boolean): string | null {
    return encrypted || !this.options.tls ? this.devicePairing.principal(token) : null
  }

  private authorizedBearer(header: string | undefined, encrypted: boolean): boolean {
    if (this.auth.authorizeBearer(header)) return true
    const token = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined
    return !!token && this.devicePrincipal(token, encrypted) !== null
  }

  private mediaPrincipal(req: PortableIncomingMessage): string | null {
    const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization
    const token = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined
    return token ? this.devicePrincipal(token, req.socket.encrypted === true) ??
      (this.auth.authorizeBearer(header) ? 'pin-session' : null) : null
  }

  private attachSse(res: PortableServerResponse, bearer: string): void {
    // S3: 超过上限直接 429 拒绝，避免无限长连接。
    if (this.sseClients.size >= this.sseMaxClients) {
      this.sendJson(res, 429, { error: 'too_many_event_connections' })
      return
    }
    const origin = (res as PortableServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin
    res.writeHead(200, {
      ...corsHeaders(origin),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    })
    this.sseClients.add(res)
    this.sseAuthorization.set(res, bearer)
    reqOnClose(res, () => {
      this.sseClients.delete(res)
      this.sseAuthorization.delete(res)
    })
    this.writeSse(res, `event: state\ndata: ${JSON.stringify(this.snapshot)}\n\n`)
    if (this.coreStateEvent) {
      this.writeSse(res, `event: core_state\ndata: ${JSON.stringify(this.coreStateEvent)}\n\n`)
    }
  }

  private writeSse(client: PortableServerResponse, payload: string): void {
    const writableLength =
      (client as PortableServerResponse & { writableLength?: number }).writableLength ?? 0
    if (
      client.destroyed ||
      client.writableEnded ||
      writableLength + PortableBuffer.byteLength(payload) > this.sseMaxBufferedBytes
    ) {
      this.sseClients.delete(client)
      this.sseAuthorization.delete(client)
      client.destroy()
      return
    }
    try {
      client.write(payload)
    } catch {
      this.sseClients.delete(client)
      this.sseAuthorization.delete(client)
      client.destroy()
    }
  }

  private broadcastSse(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.sseClients) {
      this.writeSse(client, payload)
    }
  }

  private serveStatic(
    res: PortableServerResponse,
    fileName: string,
    contentType = 'text/html; charset=utf-8'
  ): void {
    const path = join(this.staticRoot, fileName)
    if (!coreFs.existsSync(path)) {
      this.sendJson(res, 404, { error: 'static_missing', fileName })
      return
    }
    const body = coreFs.readFileSync(path)
    res.writeHead(200, {
      ...corsHeaders(
        (res as PortableServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin
      ),
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-cache'
    })
    res.end(body)
  }

  private async serveMedia(
    req: PortableIncomingMessage,
    res: PortableServerResponse,
    token: string
  ): Promise<void> {
    const grant = this.mediaGrants.resolve(token)
    if (!grant) {
      this.sendJson(res, 404, { error: 'media_token_invalid' })
      return
    }

    if (grant.stream) {
      if (!this.enabled || this.mediaPrincipal(req) !== grant.stream.principal) {
        this.sendJson(res, 401, { error: 'unauthorized' }); return
      }
      if (this.phoneReads.size >= 4) {
        this.sendJson(res, 429, { error: 'media_busy' }); return
      }
      this.phoneReads.set(res, grant.stream.principal)
      try {
        const read = async () => {
          if (!this.mediaGrants.resolve(token) || res.destroyed) {
            if (!res.destroyed) this.sendJson(res, 404, { error: 'media_token_invalid' })
            return
          }
          await this.servePhoneFile(req, res, grant.filePath!, grant.contentType, grant.stream!.sourceVersion)
        }
        await (this.options.useSource ? this.options.useSource(read) : read())
      } finally { this.phoneReads.delete(res) }
      return
    }

    if (grant.kind === 'remote' && grant.remoteUrl) {
      await this.proxyRemoteMedia(req, res, grant.remoteUrl, grant.contentType)
      return
    }

    const filePath = grant.filePath
    if (!filePath) {
      this.sendJson(res, 404, { error: 'media_missing' })
      return
    }

    const read = async () => {
      // A token can be revoked while this request waits behind maintenance.
      if (!this.mediaGrants.resolve(token)) {
        this.sendJson(res, 404, { error: 'media_token_invalid' })
        return
      }
      await this.serveFile(req, res, filePath, grant.contentType)
    }
    await (this.options.useSource ? this.options.useSource(read) : read())
  }

  /** Bounded authenticated reads keep renewal/revocation effective during a long phone session.
   * Read one descriptor and check its generation before and after reading: replacement files
   * can never supply the next range of an already-pinned representation. Cast is unchanged. */
  private async servePhoneFile(req: PortableIncomingMessage, res: PortableServerResponse,
    path: string, type: string, version: string): Promise<void> {
    const file = await coreFs.promises.open(path, 'r').catch(() => null)
    if (!file) { this.sendJson(res, 404, { error: 'media_missing' }); return }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || mediaSourceVersion(stat) !== version) {
        this.sendJson(res, 409, { error: 'source_changed' }); return
      }
      const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', etag: `"${version}"` }
      if (req.headers['if-match'] && req.headers['if-match'] !== `"${version}"`) {
        this.sendJson(res, 412, { error: 'source_changed' }); return
      }
      if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'content-length': stat.size }); res.end(); return }
      const range = typeof req.headers.range === 'string' ? parseByteRange(req.headers.range, stat.size) : null
      if (!range || range.end - range.start + 1 > REMOTE_STREAM_RANGE_BYTES) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }); res.end(); return
      }
      const size = range.end - range.start + 1
      const bytes = new Uint8Array(size)
      let read = 0
      while (read < size) {
        const part = await file.read(bytes, read, size - read, range.start + read)
        if (!part.bytesRead) break
        read += part.bytesRead
      }
      if (read !== size || mediaSourceVersion(await file.stat()) !== version) {
        this.sendJson(res, 409, { error: 'source_changed' }); return
      }
      if (res.destroyed) return
      res.writeHead(206, { ...headers, 'content-length': size,
        'content-range': `bytes ${range.start}-${range.end}/${stat.size}` })
      res.end(bytes)
    } finally { await file.close() }
  }

  private async serveFile(
    req: PortableIncomingMessage,
    res: PortableServerResponse,
    filePath: string,
    contentType: string
  ): Promise<void> {
    let stat
    try {
      stat = coreFs.statSync(filePath)
    } catch {
      this.sendJson(res, 404, { error: 'media_missing' })
      return
    }
    if (!stat.isFile()) {
      this.sendJson(res, 404, { error: 'media_missing' })
      return
    }

    const total = stat.size
    const rangeHeader = req.headers.range
    const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader
    const type = contentType || guessAudioContentType(filePath)

    if (range) {
      const parsed = parseByteRange(range, total)
      if (!parsed) {
        res.writeHead(416, { 'content-range': `bytes */${total}` })
        res.end()
        return
      }
      const { start, end } = parsed
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      })
      await coreStream
        .pipeline(coreFs.createReadStream(filePath, { start, end }), res)
        .catch(() => res.destroy())
      return
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': total,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    })
    await coreStream.pipeline(coreFs.createReadStream(filePath), res).catch(() => res.destroy())
  }

  /**
   * Proxy upstream http(s) media to the DLNA renderer. Never expose the
   * original URL (may contain CDN tokens). Rejects redirects and non-audio types.
   */
  private async proxyRemoteMedia(
    req: PortableIncomingMessage,
    res: PortableServerResponse,
    remoteUrl: string,
    fallbackContentType: string
  ): Promise<void> {
    const headers: Record<string, string> = {
      'user-agent': 'TwilightEcho-CastProxy/1.0',
      accept: 'audio/*,application/ogg,application/octet-stream,*/*'
    }
    const range = req.headers.range
    if (typeof range === 'string' && range) headers.range = range

    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.once('close', onClose)
    res.once('error', onClose)
    // Bound connection/header acquisition, not the duration of a radio stream.
    const timeout = setTimeout(() => controller.abort(), 120_000)
    let upstream: Response | undefined
    try {
      if (res.destroyed || res.writableEnded) return
      upstream = await fetch(remoteUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (res.destroyed || res.writableEnded) return
      if (upstream.status >= 300 && upstream.status < 400) {
        this.sendJson(res, 502, { error: 'upstream_redirect_rejected' })
        return
      }
      if (!upstream.ok && upstream.status !== 206) {
        this.sendJson(res, 502, { error: 'upstream_http_error', status: upstream.status })
        return
      }
      const contentType =
        upstream.headers.get('content-type') || fallbackContentType || 'application/octet-stream'
      const outHeaders: Record<string, string | number> = {
        'content-type': contentType,
        'cache-control': 'no-store',
        'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes'
      }
      for (const name of ['content-length', 'content-range'] as const) {
        const value = upstream.headers.get(name)
        if (value) outHeaders[name] = value
      }
      res.writeHead(upstream.status, outHeaders)
      if (!upstream.body) {
        res.end()
        return
      }
      // pipeline handles backpressure, premature close and both stream errors;
      // destroying the converted stream also cancels the upstream reader.
      await coreStream.pipeline(coreStream.Readable.fromWeb!(upstream.body), res, {
        signal: controller.signal
      })
    } catch {
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) this.sendJson(res, 502, { error: 'upstream_fetch_failed' })
        else res.destroy()
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
      res.off('close', onClose)
      res.off('error', onClose)
      if (upstream?.body && !upstream.body.locked) {
        await upstream.body.cancel().catch(() => undefined)
      }
    }
  }

  private sendJson(res: PortableServerResponse, status: number, body: unknown): void {
    const payload = PortableBuffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      ...corsHeaders(
        (res as PortableServerResponse & { teCorsOrigin?: string | null }).teCorsOrigin
      ),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': payload.length
    })
    res.end(payload)
  }
}

/**
 * S2: 仅当 Origin 通过同源/回环校验时回显；无 Origin（curl/原生客户端/同源导航）
 * 不需要 CORS 头。跨源网页读取将被浏览器拦截。
 */
function corsHeaders(origin?: string | null): Record<string, string> {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin'
  }
}

function readJsonBody(req: PortableIncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: PortableBuffer[] = []
    let size = 0
    req.on('data', (chunk: Uint8Array) => {
      const buf = PortableBuffer.from(chunk)
      size += buf.length
      if (size > 64 * 1024) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        const text = PortableBuffer.concat(chunks).toString('utf8')
        const parsed = parseJsonWithNestingLimit(text) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          resolve(null)
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

function reqOnClose(res: PortableServerResponse, cb: () => void): void {
  res.on('close', cb)
  res.on('error', cb)
}

// Silence unused import warning for extname in case static root uses it later.
void extname

/**
 * One port for both protocols: a TLS ClientHello starts with a handshake record (0x16), anything else
 * is plain HTTP for the browser remote and cast receivers that cannot pin a self-signed certificate.
 */
function dualProtocolServer(
  handler: (req: PortableIncomingMessage, res: PortableServerResponse) => void,
  tls: RemoteTlsIdentity
): PortableHttpServer {
  const plain = coreHttp.createServer(handler)
  const secure = coreHttps.createServer({ key: tls.key, cert: tls.cert }, handler)
  const server = coreNet.createServer((socket) => {
    socket.on('error', () => socket.destroy())
    socket.once('data', (chunk: Uint8Array) => {
      socket.pause()
      socket.unshift(chunk)
      ;(chunk[0] === 0x16 ? secure : plain).emit('connection', socket)
      queueMicrotask(() => socket.resume())
    })
  })
  const closeAllConnections = () => {
    for (const inner of [plain, secure]) (inner as { closeAllConnections?: () => void }).closeAllConnections?.()
  }
  return Object.assign(server, { closeAllConnections }) as unknown as PortableHttpServer
}
