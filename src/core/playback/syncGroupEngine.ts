import type { AudioEngineQueueItem, AudioEnginePlayResult, PlaybackInfo, PlayMode } from '../../shared/audioEngineTypes.ts'
import type { NativeQueueCommit, NativeQueueRebind } from '../../shared/nativeQueue.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'
import type { DspGraphStatus } from '../../shared/dspGraph.ts'
import type { CorePlaybackEngine } from './session.ts'
import type { SyncGroupEngineState } from '../../shared/coreSyncGroups.ts'
import type { BridgeSourceTimeline } from '../../shared/bridgeSourceTimeline.ts'
import type { AutoMixMode, AutoMixSelection } from '../../shared/twilightAutoMix.ts'
import { bridgeAutoMixSourceFrame } from '../../shared/bridgeAutoMix.ts'
import { SyncGroupAutoMix, type SyncGroupAutoMixOutput } from './syncGroupAutoMix.ts'
import type { AutoMixMaterialExport, AutoMixMaterialHost } from '../audio/autoMixMaterials.ts'
import type { TwilightAutoMixCoordinator, TwilightAutoMixContext } from '../audio/twilightAutoMixCoordinator.ts'
export type { SyncGroupEngineState } from '../../shared/coreSyncGroups.ts'

export interface SyncGroupOutputState { bridge: BridgeRuntimeState; playback: PlaybackInfo; dsp: DspGraphStatus; sourceTimeline?: BridgeSourceTimeline | null }
export interface SyncGroupContinuousOutput {
  acquire(): Promise<void>
  release(): Promise<void>
  prepare(items: AudioEngineQueueItem[], position: number, current: () => boolean): Promise<void>
  rebind(expected: AudioEngineQueueItem, items: AudioEngineQueueItem[]): Promise<boolean>
  hold(): Promise<void>
  advance(currentEntry: string, nextEntry: string): Promise<void>
}
export interface SyncGroupOutput {
  id: string
  /** Measured/manual downstream delay; zero leaves the DAC's analog boundary uncalibrated. */
  downstreamDelayMs: number
  read(): Promise<SyncGroupOutputState>
  prepare(item: AudioEngineQueueItem, position: number, current: () => boolean): Promise<void>
  arm(atCoreMs: number, mediaFrame: number): Promise<void>
  silence(): Promise<void>
  volume(value: number): Promise<void>
  /** Additive capability: old current-only outputs retain their EOF/re-arm contract. */
  continuous?: SyncGroupContinuousOutput
  autoMix?: SyncGroupAutoMixOutput
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
 * members receive bounded, non-repeating windows; they never select a SQL
 * occurrence. Each preloaded promotion needs one all-member commit. */
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
  private continuous = false
  private windowChanging = false
  private continuousBusy = false
  private advancing: string | null = null
  private timelines: BridgeSourceTimeline[] = []
  private trackOriginMs = 0
  private renewWindow = false
  private autoMixMode: AutoMixMode = 'off'
  private autoMixFallback = false
  private readonly autoMix: SyncGroupAutoMix
  private autoMixCoordinator: TwilightAutoMixCoordinator | null = null
  private memberStates: SyncGroupOutputState[] = []
  private analysisState: { state: 'preparing' | 'ready' | 'degraded' | 'off'; reason: string } | null = null
  // Context already uses the furthest native capture cursor, not audible time.
  // Selection reserves two seconds; retain one at commit so binding/prepare
  // can consume the other. The final all-member submit also checks 0.5 s.
  readonly autoMixCommitMarginSeconds = 1
  readonly autoMixMaterials: AutoMixMaterialHost = {
    select: (request, material) => this.selectAutoMix(request, material),
    prepare: (selection, prepare) => this.autoMix.prepareMaterials(selection, prepare),
    release: selection => this.autoMix.releaseMaterials(selection)
  }
  private status: SyncGroupEngineState
  constructor(options: Options) {
    this.options = options
    this.autoMix = new SyncGroupAutoMix({ outputs: options.outputs,
      context: () => {
        const current = this.queue[this.info.queueIndex], next = this.info.playMode === 'repeat' ? current : this.queue[this.info.queueIndex+1]
        return !this.closed && this.continuous && this.info.state === 'playing' && current?.queueEntryId && next?.queueEntryId
          ? { epoch: this.epoch, queueToken: this.queueToken, currentEntry: current.queueEntryId, nextEntry: next.queueEntryId } : null
      }, states: () => Promise.all(options.outputs.map(o => o.read())), fail: error => this.fail(error) })
    if (options.outputs.length < 2 || new Set(options.outputs.map(o => o.id)).size !== options.outputs.length)
      throw new Error('同步组需要至少两个不同的输出')
    this.info = { ...options.initial, state: 'paused', nativePlaybackActive: false,
      outputBackend: 'sync-group', gaplessActive: false, preloadReady: false,
      autoMixMode: 'off', autoMixState: 'off', autoMixReason: '' }
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
  private publish(): void {
    this.emit('playback-info', this.snapshot()); this.options.changed()
    if (!this.quieting && !this.closed && this.info.state === 'playing') this.autoMixCoordinator?.observe()
  }
  private snapshot(): PlaybackInfo { return { ...this.info, queueToken: this.queueToken,
    autoMixMode: this.autoMixMode,
    ...(this.analysisState && !this.autoMix.submittedPlan ? { autoMixState: this.analysisState.state, autoMixReason: this.analysisState.reason } : {}),
    crossfadeActive: false, crossfadeSeconds: 0, crossfadeMixActive: false, crossfadeEffectiveSeconds: 0,
    gaplessBlockedReason: this.info.gaplessActive ? '' : this.info.gaplessBlockedReason,
    naturalBoundaries: this.info.naturalBoundaries ? { ...this.info.naturalBoundaries } : undefined } }
  state(): SyncGroupEngineState { return { ...this.status, members: this.status.members.map(m => ({ ...m })) } }
  async start(): Promise<void> {
    if (this.started) return
    const states = await Promise.all(this.options.outputs.map(o => o.read()))
    const volume = Math.max(...states.map(s => s.playback.volume))
    this.info.volume = volume
    this.options.outputs.forEach((o, i) => this.gains.set(o.id, volume ? states[i].playback.volume/volume : 1))
    if (this.options.outputs.every(o => o.continuous)) {
      const acquired = await Promise.allSettled(this.options.outputs.map(o => o.continuous!.acquire()))
      const failed = acquired.find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') {
        await Promise.allSettled(this.options.outputs.map(o => o.continuous!.release()))
        throw failed.reason
      }
    }
    this.started = true
  }
  getPlaybackInfo(): Promise<PlaybackInfo> { return Promise.resolve(this.snapshot()) }
  getQueueSnapshot(): readonly AudioEngineQueueItem[] { return this.queue }
  getQueueToken(): string { return this.queueToken }
  supportsAutoMix(): boolean { return !!this.autoMixCoordinator && this.options.outputs.every(o => o.autoMix && o.continuous) }
  setAutoMixCoordinator(coordinator: TwilightAutoMixCoordinator | null): void {
    this.autoMixCoordinator?.destroy()
    this.autoMixCoordinator = coordinator
    coordinator?.setMode(this.autoMixMode)
    if (this.info.state !== 'playing') void coordinator?.suspend()
  }
  getAutoMixContext(): TwilightAutoMixContext | null {
    const current = this.queue[this.info.queueIndex], next = this.info.playMode === 'repeat' ? current : this.queue[this.info.queueIndex+1]
    if (this.closed || this.quieting || !this.continuous || this.info.state !== 'playing' || this.windowChanging || this.renewWindow ||
        !current?.queueEntryId || !next?.queueEntryId || this.memberStates.length !== this.options.outputs.length) return null
    const states = this.memberStates
    if (states.some(s => !s.playback.preloadReady || s.sourceTimeline?.entryId !== current.queueEntryId ||
        s.sourceTimeline?.transitionSerial !== this.timelines[0]?.transitionSerial ||
        s.playback.upcomingTrack?.queueEntryId !== next.queueEntryId || !((s.playback.upcomingTrack?.duration ?? 0) > 0))) return null
    const duration = states[0].playback.duration, nextDuration = states[0].playback.upcomingTrack!.duration!
    if (!(duration > 0) || states.some(s => Math.abs(s.playback.duration-duration) > .021 ||
        Math.abs(s.playback.upcomingTrack!.duration!-nextDuration) > .021)) return null
    const position = Math.max(this.info.position, ...states.map(s => s.sourceTimeline!.positionFrames/s.sourceTimeline!.sampleRate +
      (s.dsp.totalLatencyFrames && s.dsp.latencySampleRate ? s.dsp.totalLatencyFrames/s.dsp.latencySampleRate : 0)))
    return { queueToken: `${this.queueToken}:${this.epoch}:${this.info.naturalBoundaries?.trackSerial ?? 0}`,
      current: { ...current, duration }, next: { ...next, duration: nextDuration },
      info: { ...states[0].playback, ...this.snapshot(), duration, position,
        actualSampleRate: states[0].sourceTimeline!.sampleRate, actualChannels: 2 } }
  }
  reportAutoMixAnalysisState(state: 'preparing' | 'ready' | 'degraded' | 'off', reason: string): void {
    this.analysisState = { state, reason }
    if (state === 'degraded' && !this.autoMix.active && !this.quieting) this.autoMixFallback = true
    // Coordinator state publication must not recursively start another observe.
    this.emit('playback-info', this.snapshot()); this.options.changed()
  }
  clearAutoMixAnalysisState(): void { this.analysisState = null }
  invalidateAutoMixSource(): void {
    this.autoMixCoordinator?.invalidate('provider_source_resolution_changed')
    if (this.autoMix.submittedPlan) void this.pause().catch(error => this.fail(error)).catch(() => {})
    else this.autoMixCoordinator?.observe()
  }
  getPlaybackEnd(): EndCheckpoint | null { return this.end ? { ...this.end, selection: { ...this.end.selection } } : null }
  /** Called synchronously when Core revokes an intent, before its async commit
   * lane can be blocked behind a slow prepare/arm. All outstanding ports drain. */
  interrupt(preparingOnly = false, coordinatorCancellation = false): void {
    if (preparingOnly && this.status.phase !== 'preparing') return
    ++this.epoch; this.end = null; this.abort.abort(); this.abort = new AbortController()
    this.advancing = null; this.timelines = []; this.continuous = false
    this.renewWindow = false
    this.memberStates = []; this.analysisState = null
    this.autoMixFallback = false
    this.info.gaplessActive = this.info.preloadReady = false
    this.info.autoMixState = this.autoMixMode === 'off' ? 'off' : 'degraded'
    this.info.autoMixReason = this.autoMixMode === 'off' ? '' : 'transport_changed'
    this.info.autoMixStemEnhanced = false; this.info.autoMixDurationSeconds = 0; this.info.autoMixStrategy = ''
    this.cancelTick?.(); this.cancelTick = null
    this.status.epoch = this.epoch; this.status.audibleAtCoreMs = null
    this.status.phase = 'paused'
    // Session revocation and the subsequent committed Pause/Stop share the same
    // joined stop. Sending another native Pause while cancel ACK is pending
    // would flush that very ACK and misreport a healthy stop as unconfirmed.
    if (this.quieting) return
    this.quieting = true
    const cancelMix = this.autoMix.cancel() // Revoke native tickets before the coordinator's queued cancellation.
    const coordinatorStop = this.autoMixCoordinator?.suspendControls()
    // A coordinator cancellation can itself be pausing an armed group. Join
    // native silence, not the promise chain currently executing this callback.
    if (coordinatorCancellation) void coordinatorStop?.catch(() => {})
    const stopping = Promise.allSettled([...this.options.outputs.map(o => o.silence()), cancelMix,
      coordinatorCancellation ? undefined : coordinatorStop]).then(results => {
      const failed = results.find(r => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }).finally(() => { this.quieting = false })
    this.retiring = Promise.all([this.retiring.catch(() => {}), stopping]).then(() => {})
    // Keep the rejection observable to pause/stop/next prepare, not unhandled.
    void this.retiring.catch(() => {})
  }
  private async quiet(state: 'paused' | 'stopped', coordinatorCancellation = false): Promise<void> {
    this.interrupt(false, coordinatorCancellation)
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
    if (this.end || this.windowChanging || this.continuousBusy || this.autoMix.active || e.queueToken !== this.queueToken || e.index !== this.info.queueIndex ||
        e.id !== selected?.id || e.source !== selected?.source || !sameMedia(selected, request.items[request.startIndex])) return null
    const ticket = this.epoch
    this.windowChanging = true
    try {
      if (this.continuous) {
        // Do not rebase a window whose next occurrence has already entered any
        // capture buffer; wait for the common audible boundary to adopt it.
        const states = await Promise.all(this.options.outputs.map(o => o.read()))
        if (states.some(s => s.sourceTimeline?.entryId !== selected.queueEntryId)) return null
        await Promise.all(this.options.outputs.map(o => o.continuous!.hold()))
        this.info.gaplessActive = this.info.preloadReady = false
        this.guard(ticket)
        const items = this.window(request.items, request.startIndex, request.playMode)
        const results = await Promise.allSettled(this.options.outputs.map(o => o.continuous!.rebind(selected, items)))
        this.guard(ticket)
        if (results.some(r => r.status === 'rejected' || !r.value)) {
          if (results.every(r => r.status === 'fulfilled' && !r.value)) { this.advancing = null; return null }
          throw new Error('同步组队列交接不一致或结果未知，全部输出已暂停')
        }
        this.advancing = null
        this.renewWindow = false
      }
      this.guard(ticket)
      this.queue = copyItems(request.items); this.queueToken = this.options.token()
      this.info.queueIndex = request.startIndex; this.info.playMode = request.playMode
      return { queueToken: this.queueToken }
    } catch (error) {
      if (ticket === this.epoch) await this.fail(error)
      throw error
    } finally { this.windowChanging = false }
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
  /** Group preference only: member-local saved AutoMix modes remain untouched. */
  async setAutoMixMode(mode: AutoMixMode): Promise<void> {
    if (!['off', 'natural', 'dj'].includes(mode)) throw new Error('Invalid group AutoMix mode')
    if (mode === this.autoMixMode) return
    if (mode !== 'off' && this.options.outputs.some(o => !o.autoMix || !o.continuous)) throw new Error('group_automix_unavailable')
    const playing = this.info.state === 'playing', position = this.info.position
    await this.pause(); await this.start()
    this.autoMixMode = mode
    this.autoMixCoordinator?.setMode(mode)
    try { await Promise.all(this.options.outputs.map(o => o.autoMix?.mode(mode))) }
    catch (error) { await this.fail(error); throw error }
    this.info.autoMixState = mode === 'off' ? 'off' : 'preparing'; this.info.autoMixReason = ''
    if (playing) await this.play(this.queue[this.info.queueIndex].source, position)
    else this.publish()
  }
  async selectAutoMix(request: string, material?: AutoMixMaterialExport): Promise<AutoMixSelection> {
    if (this.autoMixMode === 'off' || this.windowChanging) throw new Error('group_automix_unavailable')
    const ticket = this.epoch
    this.autoMixFallback = false; this.info.gaplessActive = false
    this.info.autoMixState = 'preparing'; this.info.autoMixReason = ''; this.publish()
    try {
      const result = await this.autoMix.select(request, material); this.guard(ticket)
      if (!result.ok) { this.autoMixFallback = true; this.info.autoMixState = 'degraded'; this.info.autoMixReason = result.reason }
      return result
    } catch (error) {
      if (ticket === this.epoch) {
        this.info.autoMixState = 'degraded'; this.info.autoMixReason = String((error as Error).message)
        this.autoMixFallback = true
        if ((error as { code?: string }).code === 'CANCEL_UNCONFIRMED') await this.fail(error)
      }
      throw error
    }
  }
  async prepareAutoMix(request: string): Promise<boolean> {
    const ticket = this.epoch
    try {
      const ready = await this.autoMix.prepare(request)
      this.guard(ticket)
      if (!ready) {
        this.autoMixFallback = true; this.info.autoMixState = 'degraded'; this.info.autoMixReason = this.autoMix.reason
        this.publish()
      }
      return ready
    } catch (error) {
      if (ticket === this.epoch && (error as { code?: string }).code === 'CANCEL_UNCONFIRMED') await this.fail(error)
      throw error
    }
  }
  async getAutoMixNativeStatus(): Promise<PlaybackInfo> {
    if (this.autoMixMode === 'off') return { ...this.snapshot(), autoMixState: 'off', autoMixPlanId: 0, autoMixReason: '' }
    try {
      const state = await this.autoMix.status()
      Object.assign(this.info, state.info)
      return { ...this.snapshot(), autoMixState: state.phase, autoMixPlanId: state.id, autoMixReason: state.reason }
    } catch (error) {
      if ((error as { code?: string }).code === 'CANCEL_UNCONFIRMED') await this.fail(error)
      throw error
    }
  }
  async submitAutoMix(id: number): Promise<boolean> {
    const ok = await this.autoMix.submit(id)
    this.advancing = this.autoMix.submittedPlan?.nextEntryId ?? null
    this.info.autoMixState = 'ready'; this.info.preloadReady = true; this.publish()
    return ok
  }
  async cancelAutoMix(): Promise<boolean> {
    if (this.autoMix.submittedPlan) { await this.quiet('paused', true); return true }
    try {
      const cancelled = await this.autoMix.cancel()
      if (!this.quieting && this.analysisState?.state !== 'preparing') this.autoMixFallback = true
      return cancelled
    } catch (error) { await this.fail(error); throw error }
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
  private window(items = this.queue, index = this.info.queueIndex, mode = this.info.playMode): AudioEngineQueueItem[] {
    if (mode === 'repeat' && items[index]) return copyItems([items[index], items[index]])
    return copyItems(items.slice(index, index + (mode === 'repeat' ? 1 : 2)))
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
      for (const s of states) if (!s.bridge.selected || !s.bridge.connected || !s.bridge.receiver?.adaptiveSupported ||
          s.bridge.receiver.channels !== 2 || (s.bridge.receiver.wireFormat && s.bridge.receiver.wireFormat !== 'float32-le'))
        throw new Error('同步组需要已授权、已连接的双声道 PCM 时钟自适应 Bridge；DSD／DoP／多声道请独立播放')
      const current = () => !signal.aborted && ticket === this.epoch && requested?.() !== false
      this.continuous = !!selected.queueEntryId && this.options.outputs.every(o => o.continuous)
      this.autoMixFallback = false
      await Promise.all(this.options.outputs.map(o => o.autoMix?.mode(this.autoMixMode)))
      await Promise.all(this.options.outputs.map(o => this.continuous
        ? o.continuous!.prepare(this.window(), position, current) : o.prepare(selected, position, current)))
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
      if (this.continuous) {
        if (states.some(s => !s.sourceTimeline || s.sourceTimeline.entryId !== selected.queueEntryId))
          throw new Error('同步组缺少当前 occurrence 的原生时间线；请更新引擎')
        this.timelines = states.map(s => ({ ...s.sourceTimeline! }))
      }
      const lead = Math.max(350, ...states.map(s => s.bridge.receiver!.prebufferFrames*2000/s.bridge.receiver!.sampleRate+100))
      const audible = this.options.now()+lead+Math.max(...delays)
      this.status.audibleAtCoreMs = audible
      this.trackOriginMs = audible-position*1000
      this.status.members = this.options.outputs.map((o,i) => ({ id: o.id, dspDelayMs: delays[i]-o.downstreamDelayMs,
        downstreamDelayMs: o.downstreamDelayMs, startAtCoreMs: audible-delays[i] }))
      this.delaySignatures = states.map(s => this.delaySignature(s))
      await Promise.all(this.options.outputs.map((o,i) => o.arm(audible-delays[i], ticket)))
      this.guard(ticket, requested)
      this.status.phase = 'armed'; this.info = { ...states[0].playback, source, position,
        duration: selected.duration ?? states[0].playback.duration, outputBackend: 'sync-group',
        queueIndex: this.info.queueIndex, playMode: this.info.playMode, volume: this.info.volume,
        naturalBoundaries: this.info.naturalBoundaries, gaplessActive: false, preloadReady: false,
        autoMixMode: this.autoMixMode, autoMixState: this.autoMixMode === 'off' ? 'off' : 'preparing', autoMixReason: '',
        state: 'playing', nativePlaybackActive: true }
      this.request = undefined // Startup intent is consumed; live SQL-only edits must not revoke the decoder.
      this.memberStates = states
      this.autoMixCoordinator?.resume()
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
    this.memberStates = states
    if (states.some(s => !s.bridge.connected || s.bridge.receiver?.failed || s.bridge.synchronization?.state === 'failed'))
      throw new Error('组成员已停止或离线；全部输出已暂停，请重连后继续')
    if (states.some(s => s.dsp.applyState === 'failed' || s.dsp.compileState === 'failed'))
      throw new Error('组成员 DSP 应用失败；全部输出已暂停')
    const now = this.options.now(), syncs = states.map(s => s.bridge.synchronization)
    const phases = syncs.flatMap(s => s?.phaseErrorMs !== null && s?.phaseErrorMs !== undefined ? [s.phaseErrorMs] : [])
    if (phases.length === states.length) {
      this.status.estimatedSkewMs = Math.max(...phases)-Math.min(...phases)
      this.status.observationRangeMs = 2*Math.max(...syncs.map(s => s?.uncertaintyMs ?? 0))
      const measured = (now-this.trackOriginMs+Math.min(...phases))/1000
      const plan = this.autoMix.submittedPlan
      const source = plan && measured*plan.sampleRate >= plan.currentStartFrame
        ? bridgeAutoMixSourceFrame(plan, 0, measured*plan.sampleRate-plan.currentStartFrame)/plan.sampleRate : measured
      this.info.position = Math.max(this.startPosition, Math.min(this.info.duration || Infinity, source))
      if (now >= this.status.audibleAtCoreMs!) this.status.phase = 'playing'
      if (this.status.estimatedSkewMs-this.status.observationRangeMs > 1) this.skewSince ??= now
      else this.skewSince = null
    }
    if (this.windowChanging) { this.scheduleTick(ticket); return }
    if (this.autoMix.submittedPlan) {
      const mix = await this.autoMix.status(); this.guard(ticket)
      Object.assign(this.info, mix.info)
      this.info.autoMixState = mix.phase; this.info.autoMixReason = mix.reason
    }
    if (this.continuous) {
      this.continuousBusy = true
      try { if (await this.observeContinuous(states, ticket, now, phases)) return }
      finally { this.continuousBusy = false }
    }
    if (states.every(s => s.bridge.receiver?.timedStart?.state === 'completed')) {
      const item = this.queue[this.info.queueIndex]
      this.naturalBoundary()
      const next = this.info.playMode === 'repeat' ? this.info.queueIndex : this.info.queueIndex+1 < this.queue.length ? this.info.queueIndex+1 :
        ['listLoop', 'shuffle'].includes(this.info.playMode) ? 0 : -1
      if (next >= 0) {
        this.info.queueIndex = next; this.info.source = this.queue[next].source; this.info.position = 0
        this.publish(); await this.play(this.info.source, 0, this.request); return
      }
      this.info.state = 'stopped'; this.info.nativePlaybackActive = false
      this.info.position = this.info.duration; this.status.phase = 'completed'
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
  private naturalBoundary(): void {
    const item = this.queue[this.info.queueIndex], boundaries = this.info.naturalBoundaries ??
      { trackSerial: 0, queueSerial: 0, trackTimeMs: 0, queueTimeMs: 0 }
    const at = this.options.wallNow(), terminal = item.logicalQueueEnd !== false && this.info.playMode !== 'repeat'
    this.info.naturalBoundaries = { trackSerial: boundaries.trackSerial+1, trackTimeMs: at,
      queueSerial: boundaries.queueSerial+(terminal ? 1 : 0), queueTimeMs: terminal ? at : boundaries.queueTimeMs }
  }
  private async observeContinuous(states: SyncGroupOutputState[], ticket: number, now: number, phases: number[]): Promise<boolean> {
    const current = this.queue[this.info.queueIndex], next = this.info.playMode === 'repeat' ? current : this.queue[this.info.queueIndex+1]
    const timelines = states.map(s => s.sourceTimeline)
    if (timelines.some((s, i) => !s || s.generation !== this.timelines[i].generation || s.epoch !== this.timelines[i].epoch ||
        s.sampleRate !== this.timelines[i].sampleRate || s.frames < this.timelines[i].frames ||
        s.transitionSerial < this.timelines[i].transitionSerial)) throw new Error('同步组原生时间线失效，全部输出已暂停')
    const values = timelines as BridgeSourceTimeline[]
    const promoted = values.map((s,i) => s.transitionSerial !== this.timelines[i].transitionSerial)
    if (this.autoMix.submittedPlan && !promoted.every(Boolean) && phases.length === states.length &&
        now+Math.min(...phases) >= this.status.audibleAtCoreMs!+Math.max(...this.autoMix.expectedBoundaryMs))
      throw new Error('组成员没有在共同 AutoMix 边界完成推进，全部输出已暂停')
    if (values.some((s,i) => promoted[i] ? !this.advancing || s.entryId !== this.advancing ||
        s.transitionSerial !== this.timelines[i].transitionSerial+1 : s.entryId !== current.queueEntryId))
      throw new Error('同步组发生未经共同确认的切曲，全部输出已暂停')
    if (promoted.some(Boolean) && !promoted.every(Boolean) && phases.length === states.length &&
        now+Math.min(...phases) >= this.status.audibleAtCoreMs!+Math.min(...values.filter((_,i) => promoted[i]).map(s => s.transitionFrame*1000/s.sampleRate)))
      throw new Error('组成员未共同到达切曲边界，全部输出已暂停')
    if (this.renewWindow && !promoted.some(Boolean)) {
      const results = await Promise.allSettled(this.options.outputs.map(o => o.continuous!.rebind(current, this.window())))
      this.guard(ticket)
      if (results.every(r => r.status === 'fulfilled' && !r.value)) return false
      if (results.some(r => r.status === 'rejected' || !r.value)) throw new Error('同步组连续窗口续接不一致，全部输出已暂停')
      this.renewWindow = false
      return false
    }
    if (promoted.every(Boolean)) {
      const boundaries = values.map(s => s.transitionFrame*1000/s.sampleRate)
      const plan = this.autoMix.submittedPlan
      // A short incoming source may already be draining DSP zeros. Its real
      // source cursor intentionally stops at EOF, so derive this origin from
      // the common policy, never from physical capture minus that cursor.
      const origins = values.map((s,i) => plan ? boundaries[i]-plan.nextEndFrame*1000/plan.sampleRate :
        (s.frames-s.positionFrames)*1000/s.sampleRate)
      if (!next || next.queueEntryId !== this.advancing || Math.max(...boundaries)-Math.min(...boundaries) > 1 ||
          (plan && boundaries.some((at,i) => Math.abs(at-this.autoMix.expectedBoundaryMs[i]) > 1)) ||
          Math.max(...origins)-Math.min(...origins) > 1) throw new Error('同步组切曲边界不一致，全部输出已暂停')
      // Native preloading leads the DAC. SQL and listening/sleep boundaries
      // move only after every device's shared audible timeline reaches it.
      if (phases.length === states.length && now+Math.min(...phases) >= this.status.audibleAtCoreMs!+Math.max(...boundaries)) {
        this.naturalBoundary()
        if (this.info.playMode !== 'repeat') this.info.queueIndex++
        this.info.source = next.source
        this.startPosition = 0
        this.info.duration = states[0].playback.duration || next.duration || 0
        this.trackOriginMs = this.status.audibleAtCoreMs!+Math.max(...origins)
        this.info.position = Math.max(0, Math.min(this.info.duration || Infinity, (now-this.trackOriginMs+Math.min(...phases))/1000))
        this.timelines = values.map(s => ({ ...s })); this.advancing = null
        this.autoMix.complete(); this.autoMixFallback = false
        this.info.autoMixState = this.autoMixMode === 'off' ? 'off' : 'preparing'; this.info.autoMixReason = ''
        this.info.autoMixStemEnhanced = false; this.info.autoMixDurationSeconds = 0; this.info.autoMixStrategy = ''
        this.renewWindow = true
        this.info.gaplessActive = this.info.preloadReady = false
        this.publish(); this.scheduleTick(ticket); return true
      }
    } else if (!promoted.some(Boolean) && !this.advancing && (this.autoMixMode === 'off' || this.autoMixFallback) &&
        !this.autoMix.active && next?.queueEntryId &&
        states.every(s => s.playback.preloadReady) && values.every((s,i) => s.advanceReady &&
          (states[i].playback.duration || current.duration || 0)-s.positionFrames/s.sampleRate >= .75)) {
      await Promise.all(this.options.outputs.map(o => o.continuous!.advance(current.queueEntryId!, next.queueEntryId!)))
      this.guard(ticket)
      this.advancing = next.queueEntryId
      this.info.gaplessActive = this.info.preloadReady = true
    }
    return false
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
  async close(): Promise<void> {
    this.closed = true
    const [paused] = await Promise.allSettled([this.pause()])
    this.listeners.clear()
    const results = await Promise.allSettled(this.options.outputs.map(o => o.continuous?.release()))
    const failed = results.find(r => r.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    if (paused.status === 'rejected') throw paused.reason
  }
}
