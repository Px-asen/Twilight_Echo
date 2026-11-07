import { createServer, connect, type Server, type TLSSocket } from 'node:tls'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { NativeAudioBinding } from '../../core/audio/audioEngineTypes.ts'
import type { BridgePeer, BridgePcmBlock, BridgeAudioBlock, BridgeAudioFormat, BridgeStreamOptions, BridgeReceiverFacts, BridgeRuntimeState } from '../../shared/audioBridge.ts'
import { validBridgePeer, readBridgeReceiverFacts, readBridgeAudioFormat, bridgeWireCode, bridgeSampleBytes, bridgeFrameRate, extendedBridgeFormat, bridgeCaptureDevice } from '../../shared/audioBridge.ts'
import { BridgeClockMonitor, readBridgeClockExchange } from '../../shared/audioBridgeClock.ts'
import { BridgeTimelineController, type BridgeSyncStatus, type BridgeSyncSeed } from '../../shared/audioBridgeSync.ts'
import { readBridgePackets, sendBridgeJson, sendBridgePacket } from './bridgeWire.ts'
import { readBridgeSourceTimeline, type BridgeSourceTimeline } from '../../shared/bridgeSourceTimeline.ts'

export interface BridgeNative {
  PullBridgePcm(frames: number): BridgePcmBlock
  OpenBridgeReceiver(backend: string, device: string, rate: number, channels: number): void
  CloseBridgeReceiver(): void
  WriteBridgePcm(data: Uint8Array): void
  StartBridgeReceiver(): void
  GetBridgeReceiverInfo(): string
  PullBridgeAudio?(frames: number): BridgeAudioBlock
  OpenBridgeStreamReceiver?(backend: string, device: string, rate: number, channels: number, code: number, mask: number): void
  WriteBridgeAudio?(data: Uint8Array): void
  PrepareBridgeTimedReceiver?(): void
  ArmBridgeTimedReceiver?(startAtMs: number, generation: number, mediaFrame: number): void
  EndBridgeTimedReceiver?(): void
  PrepareBridgeAdaptiveReceiver?(): void
  SetBridgeTimedCorrection?(ppm: number, generation: number): void
  CommitBridgeSourceControls?(): void
}
export interface BridgeHostOptions extends BridgeStreamOptions {
  key: string; cert: string; fingerprint: string
  name: string; backend: string; device: string; sampleRate: number
}
const TRANSPORT = new Set(['Play', 'Pause', 'Stop', 'Seek', 'Next', 'Previous', 'SelectQueueIndex', 'LoadQueue'])
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6
const hasClock = (value: unknown) => Array.isArray(value) && value.includes('clock-v1')
const hasTimedStart = (value: unknown) => Array.isArray(value) && value.includes('timed-start-v1')
const hasAdaptive = (value: unknown) => Array.isArray(value) && value.includes('adaptive-pcm-v1')
const hasTypedAudio = (value: unknown) => Array.isArray(value) && value.includes('typed-audio-v2')
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
  private clockMonitor = new BridgeClockMonitor()
  private clockEnabled = false
  private resetClockProbes: (() => void) | null = null
  private timedEnabled = false
  private adaptiveEnabled = false
  private timedPlan: { epoch: number; adaptive: boolean; mediaHeld: boolean; phase: 'preparing' | 'prepared' | 'feeding' | 'armed' } | null = null
  private timedSequence = 0
  private synchronizer: BridgeTimelineController | null = null
  private rateSeed: BridgeSyncSeed | null = null
  private syncFailure: BridgeSyncStatus | null = null
  private timedRequest: { id: number; epoch: number; resolve(facts: BridgeReceiverFacts): void;
    reject(cause: Error): void; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly bridge: BridgeNative | null
  private readonly native: NativeAudioBinding
  private extended = false
  private source: BridgeSourceTimeline | null = null
  sourceTimeline(): BridgeSourceTimeline | null { return this.connected && this.source ? { ...this.source } : null }
  private supportsTypedAudio(): boolean { return !!this.bridge?.PullBridgeAudio && !!this.bridge.OpenBridgeStreamReceiver && !!this.bridge.WriteBridgeAudio }
  private openReceiver(options: BridgeHostOptions): void {
    const format = readBridgeAudioFormat(options)
    if (extendedBridgeFormat(format)) {
      if (!this.supportsTypedAudio()) throw new Error('请更新原生引擎以使用 DSD／DoP／多声道输出桥')
      this.bridge!.OpenBridgeStreamReceiver!(options.backend, options.device, format.sampleRate, format.channels, bridgeWireCode(format.wireFormat), format.channelMask)
    } else this.bridge!.OpenBridgeReceiver(options.backend, options.device, format.sampleRate, 2)
  }

  constructor(native: NativeAudioBinding) {
    this.native = native
    this.bridge = ['PullBridgePcm', 'OpenBridgeReceiver', 'CloseBridgeReceiver', 'WriteBridgePcm', 'StartBridgeReceiver', 'GetBridgeReceiverInfo']
      .every(k => typeof (native as unknown as Record<string, unknown>)[k] === 'function')
      ? native as unknown as BridgeNative : null
  }
  state(): BridgeRuntimeState {
    return { supported: !!this.bridge, hosting: !!this.server, receiving: !!this.receiverSocket,
      selected: this.selected, connected: this.connected, peerName: this.peerName,
      error: this.error, receiver: this.facts ? { ...this.facts } : null,
      timing: this.connected && this.clockEnabled ? this.clockMonitor.view(monotonicMs()) : null,
      synchronization: this.synchronizer?.view() ?? this.syncFailure }
  }
  quarantine(): void {
    this.source = null
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
      if (this.selected) return [this.extended ? 'bridge-stream' : 'bridge-pcm']
    }
    if (method === 'SetOutputDevice') {
      this.savedDevice = String(args[0])
      if (this.selected) return [bridgeCaptureDevice(readBridgeAudioFormat(this.facts ?? { sampleRate: 48000 }))]
    }
    if (this.selected && TRANSPORT.has(method)) {
      // The new lane accepts exactly one explicit start intent after preparation.
      // All later transport intents retain the original flush/cancel behavior.
      if (this.timedPlan?.phase === 'prepared' && ['Play', 'SelectQueueIndex'].includes(method)) this.timedPlan.phase = 'feeding'
      else this.flushSender()
    }
    if (this.selected && !this.connected && ['Play', 'Seek', 'Next', 'Previous'].includes(method))
      throw new Error('输出桥未连接；请重新连接或明确选择本机输出')
    return args
  }
  private flushSender(): void {
    this.source = null
    ++this.epoch
    this.cancelTimedRequest(new Error('定时播放已取消'))
    this.timedPlan = null
    this.rateSeed = this.synchronizer?.seed() ?? this.rateSeed
    this.synchronizer = null; this.syncFailure = null
    this.clockMonitor.resetStream(); this.resetClockProbes?.()
    if (this.sender && !this.sender.destroyed) sendBridgeJson(this.sender, { type: 'flush', epoch: this.epoch })
  }
  callFailed(method: string): void {
    if (!this.timedPlan || !TRANSPORT.has(method)) return
    this.flushSender(); this.native.Stop()
  }
  afterCall(method: string): void {
    if (method === 'ApplyDspState' && this.timedPlan?.mediaHeld && this.timedPlan.phase === 'feeding')
      this.bridge!.CommitBridgeSourceControls!()
  }
  releaseTimedMedia(epoch: number): void {
    if (!this.timedPlan?.mediaHeld || this.timedPlan.epoch !== epoch || this.timedPlan.phase !== 'feeding') throw new Error('定时媒体准备已取消')
    this.timedPlan.mediaHeld = false
  }
  private cancelTimedRequest(cause: Error): void {
    const pending = this.timedRequest; this.timedRequest = null
    if (pending) { clearTimeout(pending.timer); pending.reject(cause) }
  }
  private requestTimed(type: string, fields: Record<string, unknown> = {}): Promise<BridgeReceiverFacts> {
    if (!this.sender || !this.connected || this.timedRequest) throw new Error('定时输出未连接或操作尚未完成')
    const id = ++this.timedSequence, epoch = this.epoch, socket = this.sender
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancelTimedRequest(new Error('定时输出请求结果未知；请刷新状态')), 1500)
      this.timedRequest = { id, epoch, resolve, reject, timer }
      try { sendBridgeJson(socket, { type, requestId: id, epoch, ...fields }) }
      catch (cause) { this.cancelTimedRequest(cause as Error) }
    })
  }
  /** Internal coordinator lane. Queue/source preparation must precede this;
   * the next Play/SelectQueueIndex supplies media but cannot sound before arm. */
  async prepareTimedPlayback(adaptive = false, holdMedia = false): Promise<{ epoch: number; coreNowMs: number; receiver: BridgeReceiverFacts }> {
    if (!this.connected || !this.timedEnabled) throw new Error('此输出桥不支持定时起播；原有独立播放仍可使用')
    if (adaptive && !this.adaptiveEnabled) throw new Error('此输出桥不支持时钟自适应 PCM；请更新输出桥')
    if (holdMedia && !this.bridge?.CommitBridgeSourceControls) throw new Error('请更新原生引擎以准备同步组 DSP')
    this.flushSender(); this.native.Stop()
    const epoch = this.epoch
    this.timedPlan = { epoch, adaptive, mediaHeld: holdMedia, phase: 'preparing' }
    try {
      const receiver = await this.requestTimed('timed-prepare', { adaptive })
      if (this.timedPlan?.epoch !== epoch) throw new Error('定时播放已取消')
      if (receiver.timedStart?.state !== 'prepared' || !receiver.started || !receiver.timedStart.supported ||
          (adaptive && !receiver.adaptive))
        throw new Error('输出桥没有确认静音准备状态')
      this.timedPlan.phase = 'prepared'
      this.error = null
      return { epoch, coreNowMs: monotonicMs(), receiver }
    } catch (cause) {
      if (this.timedPlan?.epoch === epoch) { this.flushSender(); this.native.Stop() }
      throw cause
    }
  }
  async armTimedPlayback(startAtCoreMs: number, mediaFrame = 0, synchronize = false): Promise<BridgeReceiverFacts> {
    const timing = this.clockMonitor.view(monotonicMs()), plan = this.timedPlan
    if (synchronize && !plan?.adaptive) throw new Error('闭环校正需要时钟自适应 PCM')
    if (!plan || plan.phase !== 'feeding' || timing.network.state !== 'ready' ||
        !['warming', 'ready'].includes(timing.output.state) || timing.output.ageMs === null || timing.output.ageMs > 250 ||
        timing.network.offsetMs === null || !Number.isFinite(startAtCoreMs) ||
        startAtCoreMs <= monotonicMs() || startAtCoreMs > monotonicMs() + 2000 ||
        !Number.isSafeInteger(mediaFrame) || mediaFrame < 0) throw new Error('定时起播需要新鲜时钟、媒体预缓冲和未来时间')
    try {
      if (synchronize && this.rateSeed) await this.applyTimedCorrection(this.rateSeed.ratePpm)
      const facts = await this.requestTimed('timed-arm', { startAtReceiverMs: this.clockMonitor.receiverTime(startAtCoreMs, monotonicMs()),
        streamGeneration: timing.output.streamGeneration, clockEpoch: timing.output.epoch, mediaFrame })
      if (this.timedPlan !== plan) throw new Error('定时播放已取消')
      if (!facts.timedStart?.supported || !['armed', 'running', 'completed'].includes(facts.timedStart.state) ||
          facts.clock?.streamGeneration !== timing.output.streamGeneration) throw new Error('输出桥没有确认当前流的定时起播')
      plan.phase = 'armed'
      if (synchronize) this.synchronizer = new BridgeTimelineController({ sampleRate: facts.sampleRate, startAtCoreMs,
        streamGeneration: facts.clock!.streamGeneration, clockEpoch: facts.clock!.epoch, mediaFrame }, facts.adaptive!.requestedPpm, this.rateSeed ?? undefined)
      return facts
    } catch (cause) {
      if (this.timedPlan === plan) { this.flushSender(); this.native.Stop() }
      throw cause
    }
  }
  async cancelTimedPlayback(): Promise<BridgeReceiverFacts> {
    if (!this.connected || !this.timedEnabled) throw new Error('定时输出未连接')
    this.flushSender(); this.native.Stop()
    const facts = await this.requestTimed('timed-cancel')
    if (facts.started || facts.timedStart?.state !== 'disabled') throw new Error('输出桥没有确认定时播放已停止')
    return facts
  }
  async setTimedCorrection(ppm: number): Promise<BridgeReceiverFacts> {
    if (this.synchronizer) throw new Error('当前速率由 Core 时间线闭环控制；请先取消并重新准备')
    const facts = await this.applyTimedCorrection(ppm)
    this.rateSeed = null // An acknowledged manual rate supersedes a learned estimate.
    return facts
  }
  private async applyTimedCorrection(ppm: number): Promise<BridgeReceiverFacts> {
    const plan = this.timedPlan, clock = this.facts?.clock
    if (!plan?.adaptive || !['prepared', 'feeding', 'armed'].includes(plan.phase) || !clock?.valid ||
        !Number.isFinite(ppm) || Math.abs(ppm) > 1000) throw new Error('时钟修正需要当前自适应流与 ±1000 ppm 范围')
    try {
      const facts = await this.requestTimed('timed-rate', { ppm, streamGeneration: clock.streamGeneration, clockEpoch: clock.epoch })
      if (this.timedPlan !== plan || !facts.adaptive || facts.clock?.streamGeneration !== clock.streamGeneration ||
          (!facts.timedStart?.ended && facts.adaptive.requestedPpm !== ppm)) throw new Error('输出桥没有确认当前流的时钟修正')
      return facts
    } catch (cause) {
      if (this.timedPlan === plan) {
        this.rateSeed = null
        if (this.synchronizer) this.failSynchronization('rate_request_failed')
        else { this.flushSender(); this.native.Stop() }
      }
      throw cause
    }
  }
  private failSynchronization(reason: string): void {
    const sync = this.synchronizer
    if (!sync) return
    sync.fail(reason)
    this.rateSeed = null
    const status = sync.view()
    this.flushSender(); this.native.Stop()
    this.syncFailure = status; this.error = `时间线校正已停止（${reason}）；需要重新准备起播`
  }
  private watchSynchronization(nowMs: number): void {
    const decision = this.synchronizer?.watch(nowMs)
    if (decision?.kind === 'failed') this.failSynchronization(decision.reason)
  }
  private observeSynchronization(facts: BridgeReceiverFacts, nowMs: number): void {
    const sync = this.synchronizer
    if (!sync) return
    const observation = this.clockMonitor.presentation(facts, nowMs)
    if (!observation) { this.watchSynchronization(nowMs); return }
    const decision = sync.update(observation, nowMs, this.timedRequest === null) // At most one rate request in flight.
    if (decision.kind === 'failed') this.failSynchronization(decision.reason)
    else if (decision.kind === 'rate') void this.applyTimedCorrection(decision.ppm).catch(() => {})
  }
  async startHost(options: BridgeHostOptions): Promise<{ port: number; token: string }> {
    if (!this.bridge) throw new Error('请更新原生音频引擎以启用输出桥')
    if (this.selected) throw new Error('请先选择本机输出，再启用输出桥接收')
    if (!['wasapi', 'wasapi-exclusive', 'asio', 'coreaudio', 'coreaudio-exclusive', 'alsa'].includes(options.backend) ||
        !options.device || ['auto', 'default', 'System Default', 'system default', 'system-default', '系统默认'].includes(options.device) ||
        (options.backend === 'alsa' && !/^(?:alsa:)?(?:hw|plughw):/.test(options.device)))
      throw new Error('请先在音频设置中明确选择 DAC；输出桥不使用默认扬声器')
    await this.stopHost()
    this.native.Stop()
    // Validate the exact DAC before advertising consent. No playback starts.
    const format = readBridgeAudioFormat(options)
    this.openReceiver({ ...options, ...format })
    try { this.facts = this.receiverFacts() }
    finally { this.bridge.CloseBridgeReceiver() }
    this.facts = this.stoppedFacts()
    this.host = { ...options, ...format }; this.token = randomBytes(24).toString('hex'); this.error = null
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
  private stoppedFacts(): BridgeReceiverFacts {
    const facts = this.facts!
    return { ...facts, bufferedFrames: 0, consumedFrames: 0, underruns: 0, started: false, adaptive: null,
      timedStart: facts.timedStart ? { supported: facts.timedStart.supported, state: 'disabled', error: '', ended: false,
        targetAtMs: 0, mediaFrame: 0, deviceStartFrame: null, deviceStartAtMs: null, presentedMediaFrames: null } : null,
      clock: facts.clock ? { ...facts.clock, valid: false, running: false,
        positionFrames: 0, sampledAtMs: 0, callbackRequestedFrames: 0 } : null }
  }
  private accept(socket: TLSSocket): void {
    this.sockets.add(socket); socket.setNoDelay(true); socket.setTimeout(3000, () => socket.destroy())
    let authorized = false, waiting = false, generation = '', lastResponse = Date.now(), earliestPull = 0, offered = 0, credit = 0
    let clockEnabled = false, receiverOpen = false, typedEnabled = false
    let timedEnabled = false, adaptiveEnabled = false, timedEpoch: number | null = null, preparedUntil = 0, timedArmed = false
    let transportEpoch = 0, lastTimedRequest = 0
    const stop = () => { if (this.receiverSocket === socket) {
      this.bridge!.CloseBridgeReceiver(); receiverOpen = false; this.receiverSocket = null; this.facts = null
    } }
    const request = () => {
      if (!authorized || waiting || socket.destroyed || Date.now() < earliestPull) return
      if (generation || timedEpoch !== null) {
        this.facts = this.receiverFacts()
        if (this.facts.failed) { this.error = 'DAC 失效，接收已停止'; socket.destroy(); return }
      }
      // A large ASIO callback must be able to reach its startup threshold;
      // a fixed 100 ms credit target could otherwise deadlock before start.
      const target = Math.min(this.facts!.capacityFrames,
        Math.max(Math.round(bridgeFrameRate(readBridgeAudioFormat(this.facts!)) / 10), this.facts!.prebufferFrames))
      offered = Math.min(2048, target - (this.facts?.bufferedFrames ?? 0))
      if (this.facts?.adaptive) offered = Math.min(offered, this.facts.adaptive.inputCreditFrames)
      if (offered <= 0) return
      waiting = true
      sendBridgeJson(socket, { type: 'pull', credit: ++credit, frames: offered, facts: this.facts })
    }
    const timer = setInterval(() => {
      try {
        if (timedEpoch !== null && !timedArmed && monotonicMs() > preparedUntil) { socket.destroy(); return }
        // After acknowledged EOF adaptive input credit is zero. Clock/status
        // exchanges keep observing the tail; a still-outstanding PCM credit
        // retains its original timeout regardless of clock traffic.
        if (Date.now() - lastResponse > 3000 && (waiting || !this.facts?.timedStart?.ended)) { socket.destroy(); return }
        request()
      } catch { socket.destroy() }
    }, 10)
    socket.on('error', () => {})
    socket.on('close', () => { clearInterval(timer); this.sockets.delete(socket); stop() })
    readBridgePackets(socket, (kind, data) => {
      const remoteReceiveMs = monotonicMs()
      if (!authorized) {
        const hello = kind === 0 ? parse(data) : {}
        const token = typeof hello.token === 'string' ? hello.token : ''
        if (hello.type !== 'hello' || hello.version !== 1 || token.length !== 48 ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(this.token)) || this.receiverSocket || !this.host)
          throw new Error('Bridge authorization refused')
        typedEnabled = hasTypedAudio(hello.capabilities) && this.supportsTypedAudio()
        const extended = extendedBridgeFormat(readBridgeAudioFormat(this.host))
        if (extended && !typedEnabled) throw new Error('Core must be updated for DSD/DoP/multichannel Bridge')
        this.openReceiver(this.host)
        receiverOpen = true; clockEnabled = !extended && hasClock(hello.capabilities)
        this.receiverSocket = socket
        this.facts = this.receiverFacts(); authorized = true
        timedEnabled = clockEnabled && hasTimedStart(hello.capabilities) && this.facts.timedStart?.supported === true &&
          ['PrepareBridgeTimedReceiver', 'ArmBridgeTimedReceiver', 'EndBridgeTimedReceiver'].every(k => typeof (this.bridge as unknown as Record<string, unknown>)[k] === 'function')
        adaptiveEnabled = timedEnabled && hasAdaptive(hello.capabilities) && this.facts.adaptiveSupported === true &&
          typeof this.bridge!.PrepareBridgeAdaptiveReceiver === 'function' && typeof this.bridge!.SetBridgeTimedCorrection === 'function'
        sendBridgeJson(socket, { type: 'ready', version: 1, name: this.host.name, facts: this.facts,
          capabilities: [...(typedEnabled ? ['typed-audio-v2'] : []), ...(clockEnabled ? ['clock-v1'] : []), ...(timedEnabled ? ['timed-start-v1'] : []), ...(adaptiveEnabled ? ['adaptive-pcm-v1'] : [])] })
        request(); return
      }
      if (kind === 0) {
        const message = parse(data)
        if (['timed-prepare', 'timed-arm', 'timed-cancel', 'timed-rate'].includes(String(message.type)) && timedEnabled) {
          if (!Number.isSafeInteger(message.requestId) || Number(message.requestId) < 1 ||
              !Number.isSafeInteger(message.epoch) || Number(message.epoch) < 0) throw new Error('Invalid timed control')
          if (message.epoch !== transportEpoch || Number(message.requestId) <= lastTimedRequest) return
          lastTimedRequest = Number(message.requestId)
          try {
            if (message.type === 'timed-cancel') {
              this.bridge!.CloseBridgeReceiver(); receiverOpen = false; generation = ''; waiting = false; ++credit
              timedEpoch = null; timedArmed = false; this.facts = this.stoppedFacts(); earliestPull = 0
            } else if (message.type === 'timed-prepare') {
              if (timedEpoch !== null) throw new Error('A fresh flush is required before preparing another stream')
              const negotiatedRate = this.facts!.sampleRate
              this.bridge!.CloseBridgeReceiver(); receiverOpen = false; generation = ''; waiting = false; ++credit
              this.bridge!.OpenBridgeReceiver(this.host!.backend, this.host!.device, this.host!.sampleRate, 2)
              receiverOpen = true
              this.facts = this.receiverFacts()
              if (this.facts.sampleRate !== negotiatedRate) throw new Error('DAC format changed; reconnect required')
              if (message.adaptive === true) {
                if (!adaptiveEnabled) throw new Error('Adaptive PCM was not negotiated')
                this.bridge!.PrepareBridgeAdaptiveReceiver!()
              } else this.bridge!.PrepareBridgeTimedReceiver!()
              timedEpoch = Number(message.epoch); preparedUntil = monotonicMs() + 3000; timedArmed = false
              this.facts = this.receiverFacts(); earliestPull = 0; lastResponse = Date.now()
            } else if (message.type === 'timed-rate') {
              if (!adaptiveEnabled || message.epoch !== timedEpoch || !receiverOpen ||
                  typeof message.ppm !== 'number' || !Number.isFinite(message.ppm) || Math.abs(message.ppm) > 1000)
                throw new Error('Invalid timed correction')
              this.facts = this.receiverFacts()
              if (!this.facts.adaptive || !this.facts.clock?.valid ||
                  message.streamGeneration !== this.facts.clock.streamGeneration || message.clockEpoch !== this.facts.clock.epoch)
                throw new Error('Adaptive stream changed')
              // EOF can overtake an in-flight rate command. All remaining PCM
              // already has its ratio: acknowledge the ended stream unchanged,
              // rather than turning normal tail drain into a control failure.
              if (!this.facts.timedStart?.ended) this.bridge!.SetBridgeTimedCorrection!(message.ppm, this.facts.clock.streamGeneration)
              this.facts = this.receiverFacts()
            } else {
              if (message.epoch !== timedEpoch || timedArmed || !receiverOpen ||
                  typeof message.startAtReceiverMs !== 'number' || !Number.isFinite(message.startAtReceiverMs) ||
                  !Number.isSafeInteger(message.mediaFrame) || Number(message.mediaFrame) < 0) throw new Error('Invalid timed arm')
              const before = monotonicMs()
              this.facts = this.receiverFacts()
              const after = monotonicMs(), clock = this.facts.clock
              if (!clock?.valid || message.streamGeneration !== clock.streamGeneration || message.clockEpoch !== clock.epoch)
                throw new Error('Timed stream changed')
              const nativeStart = message.startAtReceiverMs + clock.readAtMs - (before + after) / 2
              this.bridge!.ArmBridgeTimedReceiver!(nativeStart, clock.streamGeneration, Number(message.mediaFrame))
              timedArmed = true; this.facts = this.receiverFacts()
            }
            sendBridgeJson(socket, { type: 'timed-result', requestId: message.requestId, epoch: message.epoch, ok: true, facts: this.facts })
          } catch {
            this.bridge!.CloseBridgeReceiver(); receiverOpen = false; timedEpoch = null; generation = ''; waiting = false; ++credit
            this.facts = this.stoppedFacts()
            sendBridgeJson(socket, { type: 'timed-result', requestId: message.requestId, epoch: message.epoch, ok: false,
              error: '输出桥无法执行定时操作；请刷新状态后重新准备' })
          }
          request(); return
        }
        if (message.type === 'clock-probe' && clockEnabled) {
          if (!Number.isSafeInteger(message.seq) || Number(message.seq) < 1 ||
              !Number.isSafeInteger(message.epoch) || Number(message.epoch) < 0) throw new Error('Invalid clock probe')
          const nativeReadBeforeMs = monotonicMs()
          // flush closes the native handle. Cached stopped facts are sufficient;
          // GetInfo must never be invoked on a closed receiver.
          if (receiverOpen) this.facts = this.receiverFacts()
          const nativeReadAfterMs = monotonicMs()
          sendBridgeJson(socket, { type: 'clock-pong', seq: message.seq, epoch: message.epoch,
            remoteReceiveMs, remoteSendMs: monotonicMs(), nativeReadBeforeMs, nativeReadAfterMs,
            clock: this.facts?.clock ?? null, ...(adaptiveEnabled ? { facts: this.facts } : {}) })
          return
        }
        if (message.type === 'flush') {
          if (timedEnabled) {
            if (!Number.isSafeInteger(message.epoch) || Number(message.epoch) < 0) throw new Error('Invalid timed flush')
            if (Number(message.epoch) < transportEpoch) return
            transportEpoch = Number(message.epoch)
          }
          lastResponse = Date.now()
          this.bridge!.CloseBridgeReceiver(); receiverOpen = false; generation = ''; waiting = false
          timedEpoch = null; timedArmed = false
          ++credit // invalidates an already-issued pull before a transport change
          this.facts = this.stoppedFacts()
          earliestPull = 0
          return
        }
        if (message.type === 'idle') {
          if (message.credit !== credit) return
          lastResponse = Date.now()
          // Natural EOF drains the tail. Pause/seek/stop send an explicit flush.
          if (generation) {
            if (timedEpoch !== null) { if (message.eof === true) this.bridge!.EndBridgeTimedReceiver!() }
            else this.bridge!.StartBridgeReceiver()
          }
          waiting = false; earliestPull = Date.now() + 50
          return
        }
        throw new Error('Unexpected Bridge control')
      }
      if (![1, 2].includes(kind) || data.length < (kind === 2 ? 40 : 28) || (kind === 2 && !typedEnabled)) throw new Error('Unexpected Bridge audio')
      if (data.readUInt32BE(24) !== credit) return // an old, revoked credit
      if (!waiting) throw new Error('Unsolicited PCM')
      lastResponse = Date.now() // Clock traffic must not hide an unanswered PCM credit.
      const epoch = data.readUInt32BE(0), nativeGeneration = data.readDoubleBE(4)
      const rate = data.readUInt32BE(12), channels = data.readUInt32BE(16), frames = data.readUInt32BE(20)
      const format = readBridgeAudioFormat(this.facts!), extended = extendedBridgeFormat(format)
      const head = kind === 2 ? 40 : 28
      if ((extended && kind !== 2) || channels !== format.channels || rate !== format.sampleRate || frames < 1 || frames > offered ||
          !Number.isSafeInteger(nativeGeneration) || nativeGeneration < 0 ||
          (kind === 2 && (data.readUInt32BE(28) !== bridgeWireCode(format.wireFormat) || data.readDoubleBE(32) !== format.channelMask)) ||
          data.length !== head + frames * channels * bridgeSampleBytes(format.wireFormat))
        throw new Error('Invalid Bridge audio format or credit')
      const next = `${epoch}/${nativeGeneration}`
      if (next !== generation) {
        if (timedEpoch !== null) {
          if (epoch !== timedEpoch || generation) throw new Error('Timed media generation changed; reprepare required')
        } else {
          this.bridge!.CloseBridgeReceiver()
          this.openReceiver(this.host!)
          receiverOpen = true
          const actual = readBridgeAudioFormat(this.receiverFacts())
          if (JSON.stringify(actual) !== JSON.stringify(format)) throw new Error('DAC format changed; reconnect required')
        }
        generation = next
      }
      if (kind === 2) this.bridge!.WriteBridgeAudio!(data.subarray(head))
      else this.bridge!.WriteBridgePcm(data.subarray(head))
      waiting = false; earliestPull = 0
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
      this.savedBackend = ['bridge-pcm', 'bridge-stream'].includes(info.outputBackend) ? '' : info.outputBackend
      this.savedDevice = info.outputDevice ?? 'auto'
    }
    this.native.Stop(); this.selected = true; this.error = null
    const socket = connect({ host: peer.host, port: peer.port, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
    this.sender = socket; socket.setNoDelay(true); socket.setTimeout(3500, () => socket.destroy(new Error('Bridge timed out')))
    let accepted = false, sequence = 0
    let negotiated: BridgeAudioFormat | null = null
    let clockTimer: ReturnType<typeof setInterval> | undefined
    const pending = new Map<number, { sentAtMs: number; epoch: number }>()
    const clearClock = () => { clearInterval(clockTimer); pending.clear() }
    const probe = () => {
      const sentAtMs = monotonicMs()
      this.watchSynchronization(sentAtMs)
      for (const [seq, sample] of pending) if (sentAtMs - sample.sentAtMs > 1000) pending.delete(seq)
      if (pending.size >= 4 || socket.destroyed) return
      pending.set(++sequence, { sentAtMs, epoch: this.epoch })
      sendBridgeJson(socket, { type: 'clock-probe', seq: sequence, epoch: this.epoch })
    }
    this.resetClockProbes = () => pending.clear()
    return new Promise<void>((resolve, reject) => {
      const fail = (cause: Error) => {
        clearClock()
        if (this.synchronizer) {
          this.synchronizer.fail('bridge_disconnected'); this.syncFailure = this.synchronizer.view(); this.synchronizer = null
        }
        this.cancelTimedRequest(cause); this.timedPlan = null
        this.source = null; this.connected = false; this.error = cause.message; this.native.Stop()
        if (!accepted) reject(cause)
      }
      this.closeSender = () => { clearClock(); socket.removeAllListeners('close'); socket.removeAllListeners('error'); socket.on('error', () => {}); socket.destroy() }
      socket.on('error', fail)
      socket.on('close', () => { if (this.sender === socket) fail(new Error('输出桥连接已关闭；未切换到本机输出')) })
      socket.once('secureConnect', () => {
        const fingerprint = socket.getPeerCertificate().fingerprint256?.replace(/:/g, '').toLowerCase()
        if (fingerprint !== peer.fingerprint) { socket.destroy(new Error('输出桥证书不匹配，请重新取得邀请')); return }
        sendBridgeJson(socket, { type: 'hello', version: 1, token: peer.token, capabilities: ['clock-v1', 'timed-start-v1', 'adaptive-pcm-v1', ...(this.supportsTypedAudio() ? ['typed-audio-v2'] : [])] })
      })
      readBridgePackets(socket, (kind, data) => {
        const receivedAtMs = monotonicMs()
        if (kind !== 0) throw new Error('Unexpected Bridge response')
        const message = parse(data)
        if (!accepted) {
          if (message.type !== 'ready' || message.version !== 1 || typeof message.name !== 'string' ||
              !message.facts || typeof message.facts !== 'object') throw new Error('Bridge handshake failed')
          this.facts = readBridgeReceiverFacts(message.facts)
          negotiated = readBridgeAudioFormat(this.facts)
          this.extended = extendedBridgeFormat(negotiated)
          if (this.extended && (!this.supportsTypedAudio() || !hasTypedAudio(message.capabilities))) throw new Error('请更新两端以使用 DSD／DoP／多声道输出桥')
          this.native.SetOutputBackend(this.extended ? 'bridge-stream' : 'bridge-pcm'); this.native.SetOutputDevice(bridgeCaptureDevice(negotiated))
          this.clockEnabled = !this.extended && hasClock(message.capabilities)
          this.timedEnabled = this.clockEnabled && hasTimedStart(message.capabilities)
          this.adaptiveEnabled = this.timedEnabled && hasAdaptive(message.capabilities)
          if (this.clockEnabled) {
            probe()
            clockTimer = setInterval(() => { try { probe() } catch (cause) { socket.destroy(cause as Error) } }, 250)
          }
          this.peerName = message.name.slice(0, 100); this.connected = accepted = true; resolve(); return
        }
        if (message.type === 'timed-result' && this.timedEnabled) {
          const pending = this.timedRequest
          if (!pending || message.requestId !== pending.id || message.epoch !== pending.epoch || message.epoch !== this.epoch) return
          this.timedRequest = null; clearTimeout(pending.timer)
          if (message.ok !== true) pending.reject(new Error('输出桥定时操作失败；请刷新后重新准备'))
          else {
            try { this.facts = readBridgeReceiverFacts(message.facts); pending.resolve(this.facts) }
            catch (cause) { pending.reject(cause as Error); throw cause }
          }
          return
        }
        if (message.type === 'clock-pong' && this.clockEnabled) {
          const sample = pending.get(Number(message.seq))
          if (!sample || message.epoch !== sample.epoch || sample.epoch !== this.epoch) return
          pending.delete(Number(message.seq))
          this.clockMonitor.observe(readBridgeClockExchange({ ...message, sentAtMs: sample.sentAtMs, receivedAtMs }))
          if (this.adaptiveEnabled && message.facts) {
            this.facts = readBridgeReceiverFacts(message.facts)
            this.observeSynchronization(this.facts, receivedAtMs)
          }
          return
        }
        if (message.type !== 'pull' || !Number.isInteger(message.credit) || Number(message.credit) < 1 ||
            !Number.isInteger(message.frames) || Number(message.frames) < 1 || Number(message.frames) > 2048)
          throw new Error('Invalid PCM credit')
        this.facts = readBridgeReceiverFacts(message.facts)
        if (JSON.stringify(readBridgeAudioFormat(this.facts)) !== JSON.stringify(negotiated)) throw new Error('Bridge format changed; reconnect required')
        if (this.timedPlan?.mediaHeld) { sendBridgeJson(socket, { type: 'idle', credit: message.credit, eof: false }); return }
        const block = this.extended ? this.bridge!.PullBridgeAudio!(Number(message.frames)) : this.bridge!.PullBridgePcm(Number(message.frames))
        const timeline = readBridgeSourceTimeline(block.sourceTimeline)
        if (timeline && (timeline.generation !== block.generation || timeline.sampleRate !== block.sampleRate || timeline.frames < block.frames))
          throw new Error('Bridge source timeline does not match its audio block')
        if (timeline) this.source = { ...timeline, epoch: this.epoch }
        if (!block.playing || !block.frames) { sendBridgeJson(socket, { type: 'idle', credit: message.credit, eof: !block.playing }); return }
        const bytes = 'audio' in block ? block.audio : block.pcm
        if (!Number.isSafeInteger(block.generation) || block.generation < 0 || !Number.isSafeInteger(block.frames) || block.frames < 1 || block.frames > Number(message.frames) ||
            block.sampleRate !== negotiated!.sampleRate || block.channels !== negotiated!.channels ||
            ('audio' in block && (block.wireCode !== bridgeWireCode(negotiated!.wireFormat) || block.channelMask !== negotiated!.channelMask)) ||
            bytes.byteLength !== block.frames * block.channels * bridgeSampleBytes(negotiated!.wireFormat)) throw new Error('Native Bridge block does not match negotiated format')
        const header = Buffer.alloc(this.extended ? 40 : 28)
        header.writeUInt32BE(this.epoch); header.writeDoubleBE(block.generation, 4)
        header.writeUInt32BE(block.sampleRate, 12); header.writeUInt32BE(block.channels, 16); header.writeUInt32BE(block.frames, 20)
        header.writeUInt32BE(Number(message.credit), 24)
        if (this.extended) { header.writeUInt32BE(bridgeWireCode(negotiated!.wireFormat), 28); header.writeDoubleBE(negotiated!.channelMask, 32) }
        sendBridgePacket(socket, this.extended ? 2 : 1, Buffer.concat([header, Buffer.from(bytes)]))
      })
    })
  }
  disconnectPeer(restore = true): void {
    this.source = null
    this.extended = false
    this.rateSeed = null
    this.cancelTimedRequest(new Error('输出桥已断开')); this.timedPlan = null; this.timedEnabled = this.adaptiveEnabled = false
    this.synchronizer = null; this.syncFailure = null
    this.closeSender?.(); this.closeSender = null; this.sender = null
    this.native.Stop(); this.connected = false; this.facts = null
    this.clockEnabled = false; this.clockMonitor = new BridgeClockMonitor(); this.resetClockProbes = null
    if (restore) {
      this.selected = false; this.error = null
      if (this.savedBackend) this.native.SetOutputBackend(this.savedBackend)
      this.native.SetOutputDevice(this.savedDevice)
    }
  }
  // Shutdown releases the bridge without selecting a local DAC. A bridge-only
  // build may not include the saved local backend; explicit disconnect owns restoration.
  async close(): Promise<void> { this.disconnectPeer(false); await this.stopHost() }
}
