import type { AudioEngineQueueItem, AudioEnginePlayResult, PlaybackInfo, PlayMode } from '../../shared/audioEngineTypes.ts'
import type { NativeQueueCommit, NativeQueueRebind } from '../../shared/nativeQueue.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'
import type { DspGraphStatus } from '../../shared/dspGraph.ts'
import type { CorePlaybackEngine } from './session.ts'
import type { SyncGroupEngineState } from '../../shared/coreSyncGroups.ts'
export type { SyncGroupEngineState } from '../../shared/coreSyncGroups.ts'

export interface SyncGroupOutputState { bridge: BridgeRuntimeState; playback: PlaybackInfo; dsp: DspGraphStatus }
export interface SyncGroupOutput {
  id: string
  /** Measured/manual downstream delay; zero leaves the DAC's analog boundary uncalibrated. */
  downstreamDelayMs: number
  read(): Promise<SyncGroupOutputState>
  prepare(item: AudioEngineQueueItem, position: number, current: () => boolean): Promise<void>
  arm(atCoreMs: number, mediaFrame: number): Promise<void>
  silence(): Promise<void>
  volume(value: number): Promise<void>
}
type Listener = (...args: any[]) => void
type EndCheckpoint = NonNullable<ReturnType<CorePlaybackEngine['getPlaybackEnd']>>
interface Options {
  outputs: SyncGroupOutput[]
  initial: PlaybackInfo
  now(): number
  wallNow(): number
  token(): string
  wait(ms: number, signal: AbortSignal): Promise<void>
  schedule(action: () => void, ms: number): () => void
  changed(): void
}
const sameMedia = (a?: AudioEngineQueueItem, b?: AudioEngineQueueItem) => !!a && !!b && a.id === b.id && a.source === b.source &&
  a.cueRange?.startSeconds === b.cueRange?.startSeconds && a.cueRange?.endSeconds === b.cueRange?.endSeconds &&
  (a.cueRange?.virtualPregapSeconds ?? 0) === (b.cueRange?.virtualPregapSeconds ?? 0)
const copyItems = (items: readonly AudioEngineQueueItem[]) => items.map(item => ({ ...item,
  ...(item.cueRange ? { cueRange: { ...item.cueRange } } : {}) }))

/** One native-window authority for a shared CorePlaybackSession. Physical
 * members receive current-only, non-repeating queues; they never select or
 * advance a SQL occurrence. EOF is decided after every DAC presents its tail. */
export class SyncGroupEngine implements CorePlaybackEngine {
  private readonly options: Options
  private info: PlaybackInfo
  private queue: AudioEngineQueueItem[] = []
  private queueToken = ''
  private epoch = 0
  private abort = new AbortController()
  private retiring: Promise<void> = Promise.resolve()
  private quieting = false
  private cancelTick: (() => void) | null = null
  private listeners = new Map<string, Set<Listener>>()
  private end: EndCheckpoint | null = null
  private startPosition = 0
  private request: (() => boolean) | undefined
  private delaySignatures: string[] = []
  private gains = new Map<string, number>()
  private started = false
  private closed = false
  private skewSince: number | null = null
  private status: SyncGroupEngineState
  constructor(options: Options) {
    this.options = options
    if (options.outputs.length < 2 || new Set(options.outputs.map(o => o.id)).size !== options.outputs.length)
      throw new Error('同步组需要至少两个不同的输出')
    this.info = { ...options.initial, state: 'paused', nativePlaybackActive: false,
      outputBackend: 'sync-group', gaplessActive: false, preloadReady: false }
    this.status = { phase: 'paused', error: null, epoch: 0, audibleAtCoreMs: null, estimatedSkewMs: null,
      observationRangeMs: null, members: options.outputs.map(o => ({ id: o.id, dspDelayMs: 0,
        downstreamDelayMs: o.downstreamDelayMs, startAtCoreMs: null })) }
  }
  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener); return this
  }
  off(event: string, listener: Listener): this { this.listeners.get(event)?.delete(listener); return this }
  private emit(event: string, value: unknown): void { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value) }
  private publish(): void { this.emit('playback-info', this.snapshot()); this.options.changed() }
  private snapshot(): PlaybackInfo { return { ...this.info, queueToken: this.queueToken,
    naturalBoundaries: this.info.naturalBoundaries ? { ...this.info.naturalBoundaries } : undefined } }
  state(): SyncGroupEngineState { return { ...this.status, members: this.status.members.map(m => ({ ...m })) } }
  async start(): Promise<void> {
    if (this.started) return
    const states = await Promise.all(this.options.outputs.map(o => o.read()))
    const volume = Math.max(...states.map(s => s.playback.volume))
    this.info.volume = volume
    this.options.outputs.forEach((o, i) => this.gains.set(o.id, volume ? states[i].playback.volume/volume : 1))
    this.started = true
  }
  getPlaybackInfo(): Promise<PlaybackInfo> { return Promise.resolve(this.snapshot()) }
  getQueueSnapshot(): readonly AudioEngineQueueItem[] { return this.queue }
  getQueueToken(): string { return this.queueToken }
  getPlaybackEnd(): EndCheckpoint | null { return this.end ? { ...this.end, selection: { ...this.end.selection } } : null }
  /** Called synchronously when Core revokes an intent, before its async commit
   * lane can be blocked behind a slow prepare/arm. All outstanding ports drain. */
  interrupt(preparingOnly = false): void {
    if (preparingOnly && this.status.phase !== 'preparing') return
    ++this.epoch; this.end = null; this.abort.abort(); this.abort = new AbortController()
    this.cancelTick?.(); this.cancelTick = null
    this.status.epoch = this.epoch; this.status.audibleAtCoreMs = null
    this.status.phase = 'paused'
    // Session revocation and the subsequent committed Pause/Stop share the same
    // joined stop. Sending another native Pause while cancel ACK is pending
    // would flush that very ACK and misreport a healthy stop as unconfirmed.
    if (this.quieting) return
    this.quieting = true
    const stopping = Promise.allSettled(this.options.outputs.map(o => o.silence())).then(results => {
      const failed = results.find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }).finally(() => { this.quieting = false })
    this.retiring = Promise.all([this.retiring.catch(() => {}), stopping]).then(() => {})
    // Keep the rejection observable to pause/stop/next prepare, not unhandled.
    void this.retiring.catch(() => {})
  }
  private async quiet(state: 'paused' | 'stopped'): Promise<void> {
    this.interrupt()
    const ticket = this.epoch
    await this.retiring
    if (ticket !== this.epoch) return
    this.info.state = state; this.info.nativePlaybackActive = false
    if (state === 'stopped') this.info.position = 0
    this.status.phase = 'paused'; this.publish()
  }
  pause(): Promise<void> { return this.quiet('paused') }
  stop(): Promise<void> { return this.quiet('stopped') }
  async recover(): Promise<void> {
    await this.pause()
    this.status.error = null; this.publish()
  }
  async loadQueue(items: AudioEngineQueueItem[], index = 0): Promise<void> {
    const pausing = this.quiet('paused'), ticket = this.epoch
    await pausing; this.guard(ticket)
    this.queue = copyItems(items); this.queueToken = this.options.token()
    this.info.queueIndex = index; this.info.position = 0
    this.info.source = this.queue[index]?.source ?? ''; this.info.duration = this.queue[index]?.duration ?? 0
    this.publish()
  }
  async rebindQueue(request: NativeQueueRebind): Promise<NativeQueueCommit | null> {
    const e = request.expected, selected = this.queue[this.info.queueIndex]
    if (this.end || e.queueToken !== this.queueToken || e.index !== this.info.queueIndex ||
        e.id !== selected?.id || e.source !== selected?.source || !sameMedia(selected, request.items[request.startIndex])) return null
    this.queue = copyItems(request.items); this.queueToken = this.options.token()
    this.info.queueIndex = request.startIndex; this.info.playMode = request.playMode
    return { queueToken: this.queueToken } // Decoder/transport epoch and scheduled media remain untouched.
  }
  async continueAfterPlaybackEnd(request: Parameters<CorePlaybackEngine['continueAfterPlaybackEnd']>[0]): Promise<boolean> {
    const end = this.end, expected = request.expected
    if (!end || !request.isCurrent() || end.intent !== expected.intent ||
        end.selection.queueToken !== expected.selection.queueToken || end.selection.index !== expected.selection.index ||
        end.selection.id !== expected.selection.id || end.selection.source !== expected.selection.source) return false
    await this.loadQueue([request.item], 0)
    request.onSelected()
    if (!request.isCurrent()) return false
    await this.setPlayMode(request.playMode)
    const result = await this.play(request.item.source, 0, request.isCurrent)
    return result.nativeStarted && !result.superseded
  }
  async setPlayMode(mode: PlayMode): Promise<void> { this.info.playMode = mode }
  async setPlaybackRate(rate: number): Promise<void> {
    if (rate !== 1) throw new Error('同步组目前只支持 1 倍速；成员 DSP 保持独立')
    this.info.playbackRate = 1
  }
  async setVolume(volume: number): Promise<void> {
    await this.start()
    await Promise.all(this.options.outputs.map(o => o.volume(Math.min(1, volume*this.gains.get(o.id)!))))
    this.info.volume = volume; this.publish()
  }
  async seek(position: number): Promise<void> {
    const playing = this.info.state === 'playing'
    const pausing = this.pause(), ticket = this.epoch
    await pausing; this.guard(ticket); this.info.position = position
    if (playing) await this.play(this.queue[this.info.queueIndex].source, position)
    else this.publish()
  }
  seekConfirmed(position: number): Promise<void> { return this.seek(position) }
  private guard(ticket: number, requested?: () => boolean): void {
    if (this.closed || ticket !== this.epoch || requested?.() === false)
      throw Object.assign(new Error('同步组播放已取消'), { code: 'CANCELLED' })
  }
  private delay(state: SyncGroupOutputState, output: SyncGroupOutput): number {
    const dsp = state.dsp
    if (dsp.applyState === 'pending' || dsp.applyState === 'failed' || dsp.compileState === 'compiling' || dsp.compileState === 'failed')
      throw new Error(`${output.id} 的 DSP 尚未应用`)
    if (dsp.totalLatencyFrames > 0 && !(dsp.latencySampleRate! > 0)) throw new Error(`${output.id} 未报告 DSP 延迟的采样率`)
    return (dsp.totalLatencyFrames ? dsp.totalLatencyFrames*1000/dsp.latencySampleRate! : 0)+output.downstreamDelayMs
  }
  private delaySignature(state: SyncGroupOutputState): string {
    return `${state.dsp.totalLatencyFrames}/${state.dsp.latencySampleRate ?? 0}`
  }
  async play(source: string, position = this.info.position, requested?: () => boolean): Promise<AudioEnginePlayResult> {
    const selected = this.queue[this.info.queueIndex]
    if (!selected || selected.source !== source) throw new Error('同步组的当前 occurrence 与媒体不匹配')
    this.interrupt()
    const ticket = this.epoch, signal = this.abort.signal
    this.request = requested; this.startPosition = position; this.info.position = position
    this.status.phase = 'preparing'; this.status.error = null; this.skewSince = null; this.end = null
    this.status.estimatedSkewMs = this.status.observationRangeMs = null
    this.options.changed()
    try {
      await this.start(); await this.retiring; this.guard(ticket, requested)
      let states = await Promise.all(this.options.outputs.map(o => o.read()))
      for (const s of states) if (!s.bridge.selected || !s.bridge.connected || !s.bridge.receiver?.adaptiveSupported)
        throw new Error('组内所有输出都需要已授权、已连接的时钟自适应 Bridge')
      const current = () => !signal.aborted && ticket === this.epoch && requested?.() !== false
      await Promise.all(this.options.outputs.map(o => o.prepare(selected, position, current)))
      const expires = this.options.now()+2500
      for (;;) {
        this.guard(ticket, requested)
        states = await Promise.all(this.options.outputs.map(o => o.read()))
        this.guard(ticket, requested)
        if (states.some(s => !s.bridge.connected || s.bridge.receiver?.failed)) throw new Error('组成员准备失败，已取消全部起播')
        if (states.every(s => {
          const r = s.bridge.receiver, timing = s.bridge.timing
          return r?.timedStart?.state === 'prepared' && (r.bufferedFrames >= r.prebufferFrames || (r.timedStart.ended && r.bufferedFrames > 0)) &&
            timing?.network.state === 'ready' && ['warming', 'ready'].includes(timing.output.state) &&
            timing.output.ageMs !== null && timing.output.ageMs <= 250 && s.dsp.applyState !== 'pending' && s.dsp.compileState !== 'compiling'
        })) break
        if (this.options.now() > expires) throw new Error('组成员没有在准备租约内完成预缓冲')
        await this.options.wait(20, signal)
      }
      const delays = states.map((s,i) => this.delay(s, this.options.outputs[i]))
      const lead = Math.max(350, ...states.map(s => s.bridge.receiver!.prebufferFrames*2000/s.bridge.receiver!.sampleRate+100))
      const audible = this.options.now()+lead+Math.max(...delays)
      this.status.audibleAtCoreMs = audible
      this.status.members = this.options.outputs.map((o,i) => ({ id: o.id, dspDelayMs: delays[i]-o.downstreamDelayMs,
        downstreamDelayMs: o.downstreamDelayMs, startAtCoreMs: audible-delays[i] }))
      this.delaySignatures = states.map(s => this.delaySignature(s))
      await Promise.all(this.options.outputs.map((o,i) => o.arm(audible-delays[i], ticket)))
      this.guard(ticket, requested)
      this.status.phase = 'armed'; this.info = { ...states[0].playback, source, position,
        duration: selected.duration ?? states[0].playback.duration, outputBackend: 'sync-group',
        queueIndex: this.info.queueIndex, playMode: this.info.playMode, volume: this.info.volume,
        naturalBoundaries: this.info.naturalBoundaries, gaplessActive: false, preloadReady: false,
        state: 'playing', nativePlaybackActive: true }
      this.request = undefined // Startup intent is consumed; live SQL-only edits must not revoke the decoder.
      this.publish(); this.scheduleTick(ticket)
      return { nativeStarted: true, fallbackReason: '' }
    } catch (error) {
      if (ticket !== this.epoch || requested?.() === false) {
        if (ticket === this.epoch) await this.pause()
        return { nativeStarted: false, superseded: true, fallbackReason: '' }
      }
      await this.fail(error)
      throw error
    }
  }
  private scheduleTick(ticket: number): void {
    if (ticket !== this.epoch || this.closed || this.info.state !== 'playing') return
    this.cancelTick = this.options.schedule(() => {
      this.cancelTick = null
      void this.tick(ticket).catch(error => ticket === this.epoch ? this.fail(error) : undefined).catch(() => {})
    }, 100)
  }
  private async tick(ticket: number): Promise<void> {
    const states = await Promise.all(this.options.outputs.map(o => o.read()))
    if (ticket !== this.epoch || this.closed) return
    if (states.some(s => !s.bridge.connected || s.bridge.receiver?.failed || s.bridge.synchronization?.state === 'failed'))
      throw new Error('组成员已停止或离线；全部输出已暂停，请重连后继续')
    if (states.some(s => s.dsp.applyState === 'failed' || s.dsp.compileState === 'failed'))
      throw new Error('组成员 DSP 应用失败；全部输出已暂停')
    const now = this.options.now(), syncs = states.map(s => s.bridge.synchronization)
    const phases = syncs.flatMap(s => s?.phaseErrorMs !== null && s?.phaseErrorMs !== undefined ? [s.phaseErrorMs] : [])
    if (phases.length === states.length) {
      this.status.estimatedSkewMs = Math.max(...phases)-Math.min(...phases)
      this.status.observationRangeMs = 2*Math.max(...syncs.map(s => s?.uncertaintyMs ?? 0))
      const measured = this.startPosition+(now-this.status.audibleAtCoreMs!+Math.min(...phases))/1000
      this.info.position = Math.max(this.startPosition, Math.min(this.info.duration || Infinity, measured))
      if (now >= this.status.audibleAtCoreMs!) this.status.phase = 'playing'
      if (this.status.estimatedSkewMs-this.status.observationRangeMs > 1) this.skewSince ??= now
      else this.skewSince = null
    }
    if (states.every(s => s.bridge.receiver?.timedStart?.state === 'completed')) {
      const item = this.queue[this.info.queueIndex], boundaries = this.info.naturalBoundaries ?? { trackSerial: 0, queueSerial: 0, trackTimeMs: 0, queueTimeMs: 0 }
      const at = this.options.wallNow(), terminal = item.logicalQueueEnd !== false && this.info.playMode !== 'repeat'
      this.info.naturalBoundaries = { trackSerial: boundaries.trackSerial+1, trackTimeMs: at,
        queueSerial: boundaries.queueSerial+(terminal ? 1 : 0), queueTimeMs: terminal ? at : boundaries.queueTimeMs }
      const next = this.info.playMode === 'repeat' ? this.info.queueIndex : this.info.queueIndex+1 < this.queue.length ? this.info.queueIndex+1 :
        ['listLoop', 'shuffle'].includes(this.info.playMode) ? 0 : -1
      if (next >= 0) {
        this.info.queueIndex = next; this.info.source = this.queue[next].source; this.info.position = 0
        this.publish(); await this.play(this.info.source, 0, this.request); return
      }
      this.info.state = 'stopped'; this.info.position = this.info.duration; this.status.phase = 'completed'
      this.end = { intent: this.epoch, selection: { queueToken: this.queueToken, index: this.info.queueIndex, id: item.id, source: item.source } }
      this.publish(); return
    }
    if (states.some((s,i) => this.delaySignature(s) !== this.delaySignatures[i] || s.dsp.applyState === 'pending' ||
        s.dsp.compileState === 'compiling') || (this.skewSince !== null && now-this.skewSince >= 500)) {
      const position = this.info.position
      this.status.phase = 'rebuffering'; this.options.changed()
      await this.play(this.queue[this.info.queueIndex].source, position, this.request); return
    }
    this.publish(); this.scheduleTick(ticket)
  }
  private async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.interrupt()
    try { await this.retiring }
    catch (stopError) {
      this.status.error = `${message}；停音未确认：${String(stopError)}`
      this.status.phase = 'failed'; this.emit('audio-service-crash', { reason: this.status.error }); this.options.changed(); throw stopError
    }
    this.info.state = 'paused'; this.info.nativePlaybackActive = false
    this.status.error = message; this.status.phase = 'failed'; this.publish()
  }
  async close(): Promise<void> { this.closed = true; await this.pause(); this.listeners.clear() }
}
