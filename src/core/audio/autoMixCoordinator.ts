import { createHash } from '../../shared/portableCrypto.ts'
import type {
  AutoMixAnalysisResult,
  AutoMixFeatures,
  AutoMixMode,
  AutoMixSelection
} from '../../shared/twilightAutoMix.ts'
import {
  TWILIGHT_AUTOMIX_MODEL_VERSION,
  TWILIGHT_AUTOMIX_RULE_VERSION
} from '../../shared/twilightAutoMix.ts'
import type { AudioEngineQueueItem, PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import {
  isTwilightAutoMixWindowResult,
  type AutoMixWindowCache,
  type TwilightAutoMixWindowIdentity
} from './autoMixWindowCache.ts'

export interface TwilightAutoMixContext {
  queueToken: string
  current: AudioEngineQueueItem
  next: AudioEngineQueueItem
  info: PlaybackInfo
}
export type AutoMixPrepareStage =
  | 'source'
  | 'analysis'
  | 'cache'
  | 'selection'
  | 'stems'
  | 'decode'
  | 'prepare'
  | 'submit'
export interface AutoMixDiagnosticEntry {
  stage: AutoMixPrepareStage
  outcome: 'ok' | 'retry' | 'fallback' | 'failed'
  reason: string
  elapsedMs: number
  attempt: number
}
export interface TwilightAutoMixCoordinatorDependencies {
  context(): TwilightAutoMixContext | null
  authorize(source: string): Promise<string>
  analyze(
    source: string,
    options: string,
    priority: 'boundary' | 'background',
    signal?: AbortSignal
  ): Promise<AutoMixAnalysisResult>
  cancelAnalysis(source: string): void
  scopedCancellation?: boolean
  select?(request: string): Promise<AutoMixSelection>
  releaseMaterials?(selection?: AutoMixSelection): Promise<void>
  stems?(
    selection: AutoMixSelection,
    request: string,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | null>
  prepare(request: string): Promise<boolean>
  submit(planId: number): Promise<boolean>
  cancel(): Promise<boolean>
  status(): Promise<PlaybackInfo>
  cache: Pick<AutoMixWindowCache, 'get' | 'set'>
  useSources?<T>(action: () => Promise<T>): Promise<T>
  identify?: (source: string, signal?: AbortSignal) => Promise<string>
  allowSourceUris?: boolean
  sourceRevision?(source: string): string
  assertSource?(source: string): void
  onState?(state: 'preparing' | 'ready' | 'degraded' | 'off', reason: string): void
  onDiagnostic?(entry: AutoMixDiagnosticEntry): void
  onNativePreparation?(): void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Mobile hosts can limit work to the boundaries needed for the next plan. */
  backgroundAnalysis?: boolean
}
const PARAMETERS = createHash('sha256')
  .update(
    'twilight-native-v2:50fps:30s:stereo-energy-downmix:onset-bands:' +
      TWILIGHT_AUTOMIX_RULE_VERSION
  )
  .digest('hex')
const TRANSIENT = new Set([
  'preparation_worker_busy',
  'preparation_worker_unavailable',
  'analysis_service_unavailable',
  'analysis_worker_exited',
  'analysis_service_restarting',
  'next_source_not_ready',
  'retired_preparation_budget',
  'analysis_queue_full',
  'audio_service_busy',
  'audio_service_unavailable'
])
export function autoMixFailureReason(error: unknown, stage: AutoMixPrepareStage): string {
  const e = error as { message?: string; code?: string }
  const codes: Record<string, string> = {
    ERR_AUDIO_SERVICE_BUSY: 'audio_service_busy',
    ERR_AUDIO_SERVICE_TIMEOUT: 'audio_service_timeout',
    ERR_AUDIO_ANALYSIS_STARTUP_TIMEOUT: 'analysis_service_restarting',
    ERR_AUDIO_ANALYSIS_SEND_FAILED: 'analysis_worker_exited',
    ERR_AUDIO_ANALYSIS_UNAVAILABLE: 'analysis_service_unavailable',
    ERR_AUDIO_ANALYSIS_WORKER_EXIT: 'analysis_worker_exited',
    ERR_AUDIO_ANALYSIS_WORKER_ERROR: 'analysis_worker_exited',
    ERR_AUDIO_ANALYSIS_TIMEOUT: 'analysis_timeout',
    ERR_AUDIO_ANALYSIS_QUEUE_TIMEOUT: 'analysis_queue_timeout',
    ERR_AUDIO_ANALYSIS_QUEUE_FULL: 'analysis_queue_full',
    ERR_AUDIO_ANALYSIS_CANCELLED: 'analysis_cancelled',
    ERR_AUDIO_ANALYSIS_PREEMPTED: 'background_preempted'
  }
  if (e?.code && codes[e.code]) return codes[e.code]
  if (e?.message && /^[a-z_]{1,80}$/.test(e.message)) return e.message
  return stage === 'source'
    ? 'source_resolution_failed'
    : stage === 'analysis'
      ? 'analysis_failed'
      : stage === 'selection'
        ? 'candidate_selection_failed'
        : stage === 'submit'
          ? 'native_submit_rejected'
          : 'native_preparation_failed'
}
export function autoMixBoundaryStarts(duration: number, mode: AutoMixMode, deck: number): number[] {
  if (mode !== 'dj') return [deck ? 0 : Math.max(0, duration - 30)]
  const from = deck ? 0 : Math.max(0, duration - 100),
    to = deck ? Math.min(60, duration) : duration
  const starts: number[] = []
  for (let start = from; start < to; start += 25) {
    const bounded = Math.max(from, Math.min(start, to - 30))
    if (!starts.includes(bounded)) starts.push(bounded)
    if (bounded + 30 >= to) break
  }
  // Real tail/head windows are prepared first, then the extended phrase search.
  const first = deck ? 0 : Math.max(0, duration - 30)
  return [first, ...starts.filter((s) => Math.abs(s - first) > 0.0001)].sort((a, b) =>
    a === first ? -1 : b === first ? 1 : a - b
  )
}

export class TwilightAutoMixCoordinator {
  private validWindows = new Map<string, AutoMixFeatures>()
  private revision = 0
  private abort: AbortController | null = null
  private backgroundAbort: AbortController | null = null
  private background: Promise<void> | null = null
  private sources = new Set<string>()
  private signature = ''
  private mode: AutoMixMode = 'off'
  private task: Promise<void> | null = null
  private stopped = false
  private suspended = false
  private pendingObserve = false
  private cancellation: Promise<unknown> = Promise.resolve()
  private submittedPlanId = 0
  private stage: AutoMixPrepareStage = 'source'
  private attempt = 0
  reason = ''
  readonly diagnostics: AutoMixDiagnosticEntry[] = []
  private readonly d: TwilightAutoMixCoordinatorDependencies
  constructor(d: TwilightAutoMixCoordinatorDependencies) {
    this.d = d
  }
  setMode(mode: AutoMixMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.invalidate('mode_changed')
    this.observe()
  }
  invalidate(reason: string): void {
    this.validWindows.clear()
    this.revision++
    this.abort?.abort()
    this.backgroundAbort?.abort()
    this.abort = this.backgroundAbort = null
    if (!this.d.scopedCancellation) for (const source of this.sources) this.d.cancelAnalysis(source)
    this.sources.clear()
    this.signature = ''
    this.submittedPlanId = 0
    this.reason = reason
    this.cancellation = this.cancellation.then(() => this.d.cancel()).catch(() => {})
    this.d.onState?.(this.mode === 'off' ? 'off' : 'degraded', reason)
  }
  destroy(): void {
    if (this.stopped) return
    this.stopped = true
    this.invalidate('stopped')
  }
  async shutdown(): Promise<void> {
    this.destroy()
    await this.idle()
    await this.cancellation
  }
  async suspend(): Promise<void> {
    this.suspended = true
    this.invalidate('source_maintenance')
    await this.idle()
    await this.cancellation
  }
  resume(): void {
    this.suspended = false
    this.observe()
  }
  observe(): void {
    if (this.stopped || this.suspended || this.mode === 'off') return
    const c = this.d.context()
    if (!c || c.info.state === 'stopped') return
    const signature = JSON.stringify([
      this.mode,
      c.queueToken,
      ...[c.current, c.next].flatMap((item) => [
        item.id,
        item.source,
        this.d.sourceRevision?.(item.source),
        item.cueRange?.startSeconds,
        item.cueRange?.endSeconds
      ]),
      c.info.actualSampleRate,
      c.info.actualChannels,
      c.info.actualBackend,
      c.info.outputInfo?.actualDeviceId,
      c.info.actualOutputFormat,
      c.info.bufferSizeFrames,
      c.info.playbackRate
    ])
    if (signature === this.signature) {
      if (
        this.submittedPlanId &&
        c.info.autoMixState === 'degraded' &&
        ['output_changed', 'dsp_changed', 'render_plan_invalidated', 'transport_changed'].includes(
          c.info.autoMixReason ?? ''
        )
      ) {
        this.invalidate('native_plan_invalidated')
        this.observe()
      }
      return
    }
    if (this.task) {
      this.pendingObserve = true
      if (this.signature && signature !== this.signature) this.invalidate('source_or_queue_changed')
      return
    }
    this.backgroundAbort?.abort()
    this.signature = signature
    const revision = this.revision,
      abort = new AbortController()
    this.abort = abort
    this.d.onState?.('preparing', '')
    this.task = this.useSources(() => this.run(c, revision, abort.signal))
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.reason = autoMixFailureReason(error, this.stage)
          this.record(this.stage, 'failed', this.reason, 0)
          this.d.onState?.('degraded', this.reason)
          this.cancellation = this.cancellation.then(() => this.d.cancel()).catch(() => {})
        }
      })
      .finally(() => {
        if (this.abort === abort) this.abort = null
        this.task = null
        if (this.pendingObserve) {
          this.pendingObserve = false
          this.observe()
        }
      })
  }
  async idle(): Promise<void> {
    await this.task
    await this.background
  }
  private useSources<T>(action: () => Promise<T>): Promise<T> {
    return this.d.useSources ? this.d.useSources(action) : action()
  }
  private record(
    stage: AutoMixPrepareStage,
    outcome: AutoMixDiagnosticEntry['outcome'],
    reason: string,
    elapsedMs: number
  ): void {
    const entry = {
      stage,
      outcome,
      reason,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      attempt: this.attempt
    }
    this.diagnostics.push(entry)
    if (this.diagnostics.length > 128) this.diagnostics.shift()
    this.d.onDiagnostic?.(entry)
  }
  private async measured<T>(stage: AutoMixPrepareStage, work: () => Promise<T>): Promise<T> {
    this.stage = stage
    const start = (this.d.now ?? Date.now)()
    try {
      const result = await work()
      this.record(stage, 'ok', '', (this.d.now ?? Date.now)() - start)
      return result
    } catch (error) {
      this.record(
        stage,
        'failed',
        autoMixFailureReason(error, stage),
        (this.d.now ?? Date.now)() - start
      )
      throw error
    }
  }
  private current(revision: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (this.stopped || this.revision !== revision) throw new Error('stale_preparation')
  }
  private position(c: TwilightAutoMixContext): number {
    const live = this.d.context()
    return live?.queueToken === c.queueToken && live.current.id === c.current.id
      ? (live.info.position ?? c.info.position ?? 0)
      : (c.info.position ?? 0)
  }
  private timeAvailable(c: TwilightAutoMixContext, start?: number): void {
    const limit = start ?? c.info.duration - (this.mode === 'dj' ? 8 : 4)
    if (!Number.isFinite(limit) || this.position(c) >= limit - 2)
      throw new Error('preparation_missed_boundary')
  }
  private range(item: AudioEngineQueueItem, duration: number): [number, number] {
    const start = item.cueRange?.startSeconds ?? 0,
      end = item.cueRange?.endSeconds ?? duration
    if (
      !(
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end > start &&
        end <= 604800
      ) ||
      (item.cueRange?.virtualPregapSeconds ?? 0) > 0
    )
      throw new Error('unsupported_source_range')
    return [start, end]
  }
  private async run(
    c: TwilightAutoMixContext,
    revision: number,
    signal: AbortSignal
  ): Promise<void> {
    this.attempt = 0
    for (;;) {
      try {
        await this.runOnce(c, revision, signal)
        return
      } catch (error) {
        this.current(revision, signal)
        const reason = autoMixFailureReason(error, this.stage)
        if (this.attempt >= 2 || !TRANSIENT.has(reason)) throw error
        this.timeAvailable(c)
        this.record(this.stage, 'retry', reason, 0)
        this.d.onState?.('preparing', 'retrying')
        await this.d.cancel()
        this.current(revision, signal)
        await (this.d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          [250, 1000][this.attempt++]
        )
        this.current(revision, signal)
      }
    }
  }
  private async runOnce(
    c: TwilightAutoMixContext,
    revision: number,
    signal: AbortSignal
  ): Promise<void> {
    let selection: AutoMixSelection | undefined
    try {
      await this.cancellation
      this.current(revision, signal)
      this.timeAvailable(c)
      if (c.info.isDsd || (c.info.playbackRate ?? 1) !== 1)
        throw new Error('manual_transport_or_dsd')
      const ranges = [
        this.range(c.current, c.info.duration),
        this.range(c.next, c.next.duration ?? 0)
      ]
      const files: string[] = [],
        hashes: string[] = [],
        revisions: string[] = []
      const verifySources = (activeSignal = signal) => {
        this.current(revision, activeSignal)
        files.forEach((source, deck) => {
          this.d.assertSource?.(source)
          if ((this.d.sourceRevision?.(source) ?? '') !== revisions[deck])
            throw new Error('provider_source_resolution_changed')
        })
      }
      await this.measured('source', async () => {
        for (const item of [c.current, c.next]) {
          this.current(revision, signal)
          const source = await this.d.authorize(item.source)
          this.current(revision, signal)
          this.d.assertSource?.(source)
          if (!this.d.allowSourceUris && /^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source))
            throw new Error('actual_online_source_identity_unavailable')
          this.sources.add(source)
          files.push(source)
          revisions.push(this.d.sourceRevision?.(source) ?? '')
          hashes.push(await this.d.identify!(source, signal))
        }
      })
      const window = async (
        deck: number,
        start: number,
        priority: 'boundary' | 'background',
        activeSignal = signal
      ) => {
        verifySources(activeSignal)
        if (priority === 'boundary') this.timeAvailable(c)
        const duration = ranges[deck][1] - ranges[deck][0]
        const identity: TwilightAutoMixWindowIdentity = {
          sourceIdentity: hashes[deck],
          sourceStartSeconds: ranges[deck][0],
          sourceEndSeconds: ranges[deck][1],
          modelVersion: TWILIGHT_AUTOMIX_MODEL_VERSION,
          parametersSha256: revisions[deck]
            ? createHash('sha256')
                .update(JSON.stringify([PARAMETERS, revisions[deck]]))
                .digest('hex')
            : PARAMETERS,
          windowStartSeconds: start,
          windowEndSeconds: Math.min(start + 30, duration)
        }
        const memoryKey = JSON.stringify(identity)
        const reused = this.validWindows.get(memoryKey)
        if (reused) return reused
        try {
          const cached = await this.d.cache.get(identity)
          if (cached) {
            this.validWindows.set(memoryKey, cached)
            return cached
          }
        } catch {
          this.record('cache', 'fallback', 'cache_read_failed', 0)
        }
        const result = await this.d.analyze(
          files[deck],
          JSON.stringify({
            sourceIdentity: hashes[deck],
            sourceStartSeconds: ranges[deck][0],
            sourceEndSeconds: ranges[deck][1],
            rangeStartSeconds: start
          }),
          priority,
          activeSignal
        )
        verifySources(activeSignal)
        if (!result.ok) throw new Error(result.reason)
        if (!isTwilightAutoMixWindowResult(identity, result))
          throw new Error('analysis_coverage_mismatch')
        this.validWindows.set(memoryKey, result)
        while (this.validWindows.size > 64)
          this.validWindows.delete(this.validWindows.keys().next().value!)
        try {
          await this.d.cache.set(identity, result)
        } catch {
          this.record('cache', 'fallback', 'cache_write_failed', 0)
        }
        return result
      }
      const features: AutoMixFeatures[][] = [[], []]
      await this.measured('analysis', async () => {
        // The minimal two boundaries always precede expanded DJ analysis.
        const starts = ranges.map((range, deck) =>
          autoMixBoundaryStarts(range[1] - range[0], this.mode, deck)
        )
        for (let deck = 0; deck < 2; deck++)
          features[deck].push(await window(deck, starts[deck][0], 'boundary'))
        if (this.d.select)
          for (let deck = 0; deck < 2; deck++)
            for (const start of starts[deck].slice(1))
              features[deck].push(await window(deck, start, 'boundary'))
      })
      verifySources()
      const request: Record<string, unknown> = {
        ruleVersion: TWILIGHT_AUTOMIX_RULE_VERSION,
        currentSource: files[0],
        nextSource: files[1],
        currentSourceStartSeconds: ranges[0][0],
        currentSourceEndSeconds: ranges[0][1],
        nextSourceStartSeconds: ranges[1][0],
        nextSourceEndSeconds: ranges[1][1],
        currentFeatures: features[0][0],
        nextFeatures: features[1][0],
        currentWindows: features[0],
        nextWindows: features[1],
        minimumCurrentStartSeconds: this.position(c) + 2
      }
      if (this.d.select) {
        selection = await this.measured('selection', () => this.d.select!(JSON.stringify(request)))
        verifySources()
        if (!selection.ok) throw new Error(selection.reason || 'no_safe_boundary_candidate')
        this.timeAvailable(c, selection.currentStartSeconds)
        request.selectionId = selection.selectionId
        if (this.d.stems) {
          try {
            const material = await this.measured('stems', () =>
              this.d.stems!(selection!, JSON.stringify(request), signal)
            )
            verifySources()
            if (material) Object.assign(request, material)
          } catch (error) {
            verifySources()
            this.record('stems', 'fallback', autoMixFailureReason(error, 'stems'), 0)
          }
        }
      }
      await this.measured('prepare', async () => {
        this.timeAvailable(c, selection?.currentStartSeconds)
        const prepared = await this.d.prepare(JSON.stringify(request))
        this.d.onNativePreparation?.()
        this.current(revision, signal)
        if (!prepared) {
          const status = await this.d.status()
          this.current(revision, signal)
          throw new Error(status.autoMixReason || 'native_preparation_rejected')
        }
        let planId = 0
        for (let attempt = 0; attempt < 220; attempt++) {
          verifySources()
          this.timeAvailable(c, selection?.currentStartSeconds)
          const status = await this.d.status()
          this.current(revision, signal)
          if (status.autoMixState === 'ready') {
            planId = status.autoMixPlanId ?? 0
            if (status.autoMixDecodeMs !== undefined)
              this.record('decode', 'ok', '', status.autoMixDecodeMs)
            break
          }
          if (status.autoMixState !== 'preparing')
            throw new Error(status.autoMixReason || 'native_preparation_failed')
          await (this.d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(100)
        }
        if (!planId) throw new Error('native_preparation_timeout')
        await this.measured('submit', async () => {
          verifySources()
          this.timeAvailable(c, selection?.currentStartSeconds)
          if (!(await this.d.submit(planId))) throw new Error('native_submit_rejected')
          this.current(revision, signal)
          this.submittedPlanId = planId
        })
      })
      this.reason = ''
      this.d.onState?.('ready', '')
      if (this.d.backgroundAnalysis === false) return
      const backgroundAbort = new AbortController()
      this.backgroundAbort = backgroundAbort
      const background = this.useSources(async () => {
        for (let deck = 0; deck < 2; deck++) {
          const duration = ranges[deck][1] - ranges[deck][0]
          for (let start = 0; start < duration; start += 30) {
            verifySources(backgroundAbort.signal)
            try {
              await window(deck, start, 'background', backgroundAbort.signal)
            } catch {
              verifySources(backgroundAbort.signal)
            }
          }
        }
      })
        .catch(() => {})
        .finally(() => {
          if (this.backgroundAbort === backgroundAbort) this.backgroundAbort = null
          if (this.background === background) this.background = null
        })
      this.background = background
    } finally {
      await this.d.releaseMaterials?.(selection)
    }
  }
}
