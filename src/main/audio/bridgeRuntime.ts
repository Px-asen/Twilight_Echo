import { createServer, connect, type Server, type TLSSocket } from 'node:tls'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { NativeAudioBinding } from '../../core/audio/audioEngineTypes.ts'
import type { BridgePeer, BridgePcmBlock, BridgeReceiverFacts, BridgeRuntimeState } from '../../shared/audioBridge.ts'
import { validBridgePeer, readBridgeReceiverFacts } from '../../shared/audioBridge.ts'
import { readBridgePackets, sendBridgeJson, sendBridgePacket } from './bridgeWire.ts'

export interface BridgeNative {
  PullBridgePcm(frames: number): BridgePcmBlock
  OpenBridgeReceiver(backend: string, device: string, rate: number, channels: number): void
  CloseBridgeReceiver(): void
  WriteBridgePcm(data: Uint8Array): void
  StartBridgeReceiver(): void
  GetBridgeReceiverInfo(): string
}
export interface BridgeHostOptions {
  key: string; cert: string; fingerprint: string
  name: string; backend: string; device: string; sampleRate: number
}
const TRANSPORT = new Set(['Play', 'Pause', 'Stop', 'Seek', 'Next', 'Previous', 'SelectQueueIndex', 'LoadQueue'])
const parse = (data: Buffer): Record<string, unknown> => {
  const value: unknown = JSON.parse(data.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bridge control')
  return value as Record<string, unknown>
}

/** The only network/audio owner. Lifecycle commands and packet handlers share
 * Node's event loop; DAC callbacks use only the native SPSC ring. */
export class AudioBridgeRuntime {
  private server: Server | null = null
  private host: BridgeHostOptions | null = null
  private token = ''
  private sockets = new Set<TLSSocket>()
  private receiverSocket: TLSSocket | null = null
  private sender: TLSSocket | null = null
  private selected = false
  private connected = false
  private peerName: string | null = null
  private error: string | null = null
  private facts: BridgeReceiverFacts | null = null
  private epoch = 0
  private savedBackend = ''
  private savedDevice = 'auto'
  private closeSender: (() => void) | null = null
  private readonly bridge: BridgeNative | null
  private readonly native: NativeAudioBinding

  constructor(native: NativeAudioBinding) {
    this.native = native
    this.bridge = ['PullBridgePcm', 'OpenBridgeReceiver', 'CloseBridgeReceiver', 'WriteBridgePcm', 'StartBridgeReceiver', 'GetBridgeReceiverInfo']
      .every(k => typeof (native as unknown as Record<string, unknown>)[k] === 'function')
      ? native as unknown as BridgeNative : null
  }
  state(): BridgeRuntimeState {
    return { supported: !!this.bridge, hosting: !!this.server, receiving: !!this.receiverSocket,
      selected: this.selected, connected: this.connected, peerName: this.peerName,
      error: this.error, receiver: this.facts ? { ...this.facts } : null }
  }
  quarantine(): void {
    this.native.Stop(); this.selected = true; this.connected = false
    this.error = '音频服务已重启；请重新连接输出桥或明确选择此电脑'
  }
  /** Returns substituted arguments. Local route requests are remembered but
   * cannot escape to local hardware while a Bridge is selected, even on failure. */
  beforeCall(method: string, args: unknown[]): unknown[] {
    if (this.host && ['Play', 'Pause', 'Seek', 'Next', 'Previous'].includes(method))
      throw new Error('本机正作为输出桥；请先关闭接收模式')
    if (method === 'SetOutputBackend') {
      this.savedBackend = String(args[0])
      if (this.selected) return ['bridge-pcm']
    }
    if (method === 'SetOutputDevice') {
      this.savedDevice = String(args[0])
      if (this.selected) return [`${this.facts?.sampleRate ?? 48000}/2`]
    }
    if (this.selected && TRANSPORT.has(method)) this.flushSender()
    if (this.selected && !this.connected && ['Play', 'Seek', 'Next', 'Previous'].includes(method))
      throw new Error('输出桥未连接；请重新连接或明确选择本机输出')
    return args
  }
  private flushSender(): void {
    ++this.epoch
    if (this.sender && !this.sender.destroyed) sendBridgeJson(this.sender, { type: 'flush', epoch: this.epoch })
  }
  async startHost(options: BridgeHostOptions): Promise<{ port: number; token: string }> {
    if (!this.bridge) throw new Error('请更新原生音频引擎以启用输出桥')
    if (this.selected) throw new Error('请先选择本机输出，再启用输出桥接收')
    if (!['wasapi', 'wasapi-exclusive', 'asio', 'coreaudio', 'coreaudio-exclusive', 'alsa'].includes(options.backend) ||
        !options.device || ['auto', 'default', 'System Default', 'system default', 'system-default', '系统默认'].includes(options.device) ||
        (options.backend === 'alsa' && !/^(?:alsa:)?(?:hw|plughw):/.test(options.device)) ||
        ![44100, 48000, 88200, 96000, 176400, 192000].includes(options.sampleRate))
      throw new Error('请先在音频设置中明确选择 DAC；输出桥不使用默认扬声器')
    await this.stopHost()
    this.native.Stop()
    // Validate the exact DAC before advertising consent. No playback starts.
    this.bridge.OpenBridgeReceiver(options.backend, options.device, options.sampleRate, 2)
    this.facts = this.receiverFacts()
    this.bridge.CloseBridgeReceiver()
    this.host = options; this.token = randomBytes(24).toString('hex'); this.error = null
    const server = createServer({ key: options.key, cert: options.cert, minVersion: 'TLSv1.2', handshakeTimeout: 3000 }, socket => this.accept(socket))
    this.server = server
    server.maxConnections = 4
    server.on('tlsClientError', () => {})
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '0.0.0.0', () => { server.removeListener('error', reject); resolve() })
      })
      server.on('error', () => { this.error = '输出桥监听失败'; void this.stopHost() })
      return { port: (server.address() as AddressInfo).port, token: this.token }
    } catch (cause) { await this.stopHost(); throw cause }
  }
  private receiverFacts(): BridgeReceiverFacts { return readBridgeReceiverFacts(JSON.parse(this.bridge!.GetBridgeReceiverInfo())) }
  private accept(socket: TLSSocket): void {
    this.sockets.add(socket); socket.setNoDelay(true); socket.setTimeout(3000, () => socket.destroy())
    let authorized = false, waiting = false, generation = '', lastResponse = Date.now(), earliestPull = 0, offered = 0, credit = 0
    const stop = () => { if (this.receiverSocket === socket) {
      this.bridge!.CloseBridgeReceiver(); this.receiverSocket = null; this.facts = null
    } }
    const request = () => {
      if (!authorized || waiting || socket.destroyed || Date.now() < earliestPull) return
      if (generation) {
        this.facts = this.receiverFacts()
        if (this.facts.failed) { this.error = 'DAC 失效，接收已停止'; socket.destroy(); return }
      }
      // A large ASIO callback must be able to reach its startup threshold;
      // a fixed 100 ms credit target could otherwise deadlock before start.
      const target = Math.min(this.facts!.capacityFrames,
        Math.max(Math.round(this.facts!.sampleRate / 10), this.facts!.prebufferFrames))
      offered = Math.min(2048, target - (this.facts?.bufferedFrames ?? 0))
      if (offered <= 0) return
      waiting = true
      sendBridgeJson(socket, { type: 'pull', credit: ++credit, frames: offered, facts: this.facts })
    }
    const timer = setInterval(() => {
      try {
        if (Date.now() - lastResponse > 3000) { socket.destroy(); return }
        request()
      } catch { socket.destroy() }
    }, 10)
    socket.on('error', () => {})
    socket.on('close', () => { clearInterval(timer); this.sockets.delete(socket); stop() })
    readBridgePackets(socket, (kind, data) => {
      if (!authorized) {
        const hello = kind === 0 ? parse(data) : {}
        const token = typeof hello.token === 'string' ? hello.token : ''
        if (hello.type !== 'hello' || hello.version !== 1 || token.length !== 48 ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(this.token)) || this.receiverSocket || !this.host)
          throw new Error('Bridge authorization refused')
        this.bridge!.OpenBridgeReceiver(this.host.backend, this.host.device, this.host.sampleRate, 2)
        this.facts = this.receiverFacts(); this.receiverSocket = socket; authorized = true
        sendBridgeJson(socket, { type: 'ready', version: 1, name: this.host.name, facts: this.facts })
        request(); return
      }
      lastResponse = Date.now()
      if (kind === 0) {
        const message = parse(data)
        if (message.type === 'flush') {
          this.bridge!.CloseBridgeReceiver(); generation = ''; waiting = false
          ++credit // invalidates an already-issued pull before a transport change
          this.facts = { ...this.facts!, bufferedFrames: 0, consumedFrames: 0, underruns: 0, started: false }
          earliestPull = 0
          return
        }
        if (message.type === 'idle') {
          if (message.credit !== credit) return
          // Natural EOF drains the tail. Pause/seek/stop send an explicit flush.
          if (generation) this.bridge!.StartBridgeReceiver()
          waiting = false; earliestPull = Date.now() + 50
          return
        }
        throw new Error('Unexpected Bridge control')
      }
      if (kind !== 1 || data.length < 28) throw new Error('Unexpected PCM')
      if (data.readUInt32BE(24) !== credit) return // an old, revoked credit
      if (!waiting) throw new Error('Unsolicited PCM')
      const epoch = data.readUInt32BE(0), nativeGeneration = data.readDoubleBE(4)
      const rate = data.readUInt32BE(12), channels = data.readUInt32BE(16), frames = data.readUInt32BE(20)
      if (channels !== 2 || rate !== this.facts!.sampleRate || frames < 1 || frames > offered || data.length !== 28 + frames * 8)
        throw new Error('Invalid PCM format or credit')
      const next = `${epoch}/${nativeGeneration}`
      if (next !== generation) {
        this.bridge!.CloseBridgeReceiver()
        this.bridge!.OpenBridgeReceiver(this.host!.backend, this.host!.device, rate, channels)
        if (this.receiverFacts().sampleRate !== rate) throw new Error('DAC format changed; reconnect required')
        generation = next
      }
      this.bridge!.WriteBridgePcm(data.subarray(28)); waiting = false; earliestPull = 0
      request()
    })
  }
  async stopHost(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear(); this.receiverSocket = null
    this.bridge?.CloseBridgeReceiver()
    const server = this.server; this.server = null; this.host = null; this.token = ''; this.facts = null
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
  async connectPeer(peer: BridgePeer): Promise<void> {
    if (!this.bridge || !validBridgePeer(peer)) throw new Error('输出桥邀请或原生引擎无效')
    if (this.host) throw new Error('接收模式下不能连接另一台输出桥')
    this.disconnectPeer(false)
    if (!this.savedBackend && this.native.GetPlaybackInfo) {
      const raw = this.native.GetPlaybackInfo()
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw
      this.savedBackend = info.outputBackend === 'bridge-pcm' ? '' : info.outputBackend
      this.savedDevice = info.outputDevice ?? 'auto'
    }
    this.native.Stop(); this.selected = true; this.error = null
    const socket = connect({ host: peer.host, port: peer.port, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
    this.sender = socket; socket.setNoDelay(true); socket.setTimeout(3500, () => socket.destroy(new Error('Bridge timed out')))
    let accepted = false
    return new Promise<void>((resolve, reject) => {
      const fail = (cause: Error) => {
        this.connected = false; this.error = cause.message; this.native.Stop()
        if (!accepted) reject(cause)
      }
      this.closeSender = () => { socket.removeAllListeners('close'); socket.removeAllListeners('error'); socket.on('error', () => {}); socket.destroy() }
      socket.on('error', fail)
      socket.on('close', () => { if (this.sender === socket) fail(new Error('输出桥连接已关闭；未切换到本机输出')) })
      socket.once('secureConnect', () => {
        const fingerprint = socket.getPeerCertificate().fingerprint256?.replace(/:/g, '').toLowerCase()
        if (fingerprint !== peer.fingerprint) { socket.destroy(new Error('输出桥证书不匹配，请重新取得邀请')); return }
        sendBridgeJson(socket, { type: 'hello', version: 1, token: peer.token })
      })
      readBridgePackets(socket, (kind, data) => {
        if (kind !== 0) throw new Error('Unexpected Bridge response')
        const message = parse(data)
        if (!accepted) {
          if (message.type !== 'ready' || message.version !== 1 || typeof message.name !== 'string' ||
              !message.facts || typeof message.facts !== 'object') throw new Error('Bridge handshake failed')
          this.facts = readBridgeReceiverFacts(message.facts)
          if (this.facts.channels !== 2 || !Number.isInteger(this.facts.sampleRate) ||
              this.facts.sampleRate < 44100 || this.facts.sampleRate > 192000) throw new Error('Invalid negotiated format')
          this.native.SetOutputBackend('bridge-pcm'); this.native.SetOutputDevice(`${this.facts.sampleRate}/2`)
          this.peerName = message.name.slice(0, 100); this.connected = accepted = true; resolve(); return
        }
        if (message.type !== 'pull' || !Number.isInteger(message.credit) || Number(message.credit) < 1 ||
            !Number.isInteger(message.frames) || Number(message.frames) < 1 || Number(message.frames) > 2048)
          throw new Error('Invalid PCM credit')
        this.facts = readBridgeReceiverFacts(message.facts)
        const block = this.bridge!.PullBridgePcm(Number(message.frames))
        if (!block.playing || !block.frames) { sendBridgeJson(socket, { type: 'idle', credit: message.credit }); return }
        const header = Buffer.alloc(28)
        header.writeUInt32BE(this.epoch); header.writeDoubleBE(block.generation, 4)
        header.writeUInt32BE(block.sampleRate, 12); header.writeUInt32BE(block.channels, 16); header.writeUInt32BE(block.frames, 20)
        header.writeUInt32BE(Number(message.credit), 24)
        sendBridgePacket(socket, 1, Buffer.concat([header, Buffer.from(block.pcm)]))
      })
    })
  }
  disconnectPeer(restore = true): void {
    this.closeSender?.(); this.closeSender = null; this.sender = null
    this.native.Stop(); this.connected = false; this.facts = null
    if (restore) {
      this.selected = false; this.error = null
      if (this.savedBackend) this.native.SetOutputBackend(this.savedBackend)
      this.native.SetOutputDevice(this.savedDevice)
    }
  }
  async close(): Promise<void> { this.disconnectPeer(); await this.stopHost() }
}
