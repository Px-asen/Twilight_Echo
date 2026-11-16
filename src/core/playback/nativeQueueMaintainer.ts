import type { AudioEngineQueueItem, AudioEngineQueueState } from '../../shared/audioEngineTypes.ts'
import type { CueRange } from '../../shared/cue.ts'
import type { SourceResolver, ResolvedSource } from './sourceResolver.ts'

/** Narrow engine surface the core needs; AudioEngineManager satisfies it. */
export interface NativeQueueMaintainerEngine {
  getPlaybackInfo: () => Promise<{
    queueIndex: number
    upcomingQueueIndex?: number
    state: string
  }>
  getQueueState: () => Promise<AudioEngineQueueState | null>
  appendQueueItems: (items: AudioEngineQueueItem[]) => Promise<number>
  updateQueueItemSource: (index: number, source: string) => Promise<boolean>
}

export interface NativeQueueMaintainerOptions {
  /** Logical queue snapshot handed over by the renderer. */
  queue: readonly unknown[]
  /** SQLite-backed queues provide a bounded loader instead of a full array. */
  queueLength?: number
  loadQueueItem?: (index: number) => Promise<unknown | null>
  /** Logical index the native window currently starts on (usually mapping[0]). */
  currentLogicalIndex: number
  /** Native index -> logical index for the queue already loaded in the engine. */
  nativeQueueIndices: readonly number[]
  engine: NativeQueueMaintainerEngine
  resolver: SourceResolver
  /** How many tracks ahead of the native cursor to keep appended. */
  lookahead?: number
  /** Refresh an upcoming provider URL when it expires within this margin. */
  refreshMarginMs?: number
  now?: () => number
  onMappingChanged?: (mapping: readonly number[]) => void
  onError?: (message: string) => void
}

const DEFAULT_LOOKAHEAD = 2
const DEFAULT_REFRESH_MARGIN_MS = 2 * 60 * 1000
const RESOLVE_RETRY_MS = 30 * 1000
const MAX_APPEND_PER_TICK = 2

const textField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const nativeQueueItem = (
  track: unknown,
  source: string,
  logicalIndex: number,
  logicalQueueEnd?: boolean
): AudioEngineQueueItem => {
  const record = track && typeof track === 'object' ? (track as Record<string, unknown>) : {}
  const cueRange =
    record.cueRange && typeof record.cueRange === 'object'
      ? (record.cueRange as CueRange)
      : undefined
  const item: AudioEngineQueueItem = {
    id: textField(record, 'id') ?? `afterglow:${logicalIndex}`,
    ...(textField(record, 'queueEntryId')
      ? { queueEntryId: textField(record, 'queueEntryId') }
      : {}),
    source,
    ...(logicalQueueEnd !== undefined ? { logicalQueueEnd } : {}),
    ...(textField(record, 'title') ? { title: textField(record, 'title') } : {}),
    ...(textField(record, 'artist') ? { artist: textField(record, 'artist') } : {}),
    ...(textField(record, 'album') ? { album: textField(record, 'album') } : {}),
    ...(numberField(record, 'duration') !== undefined
      ? { duration: numberField(record, 'duration') }
      : {}),
    ...(numberField(record, 'sampleRate') !== undefined
      ? { sampleRate: numberField(record, 'sampleRate') }
      : {}),
    ...(numberField(record, 'bitrate') !== undefined
      ? { bitrate: numberField(record, 'bitrate') }
      : {}),
    ...(numberField(record, 'bitDepth') !== undefined
      ? { bitDepth: numberField(record, 'bitDepth') }
      : {}),
    ...(cueRange ? { cueRange } : {})
  }
  for (const key of [
    'measuredIntegratedLufs',
    'measuredTruePeakDb',
    'replayGainTrackGainDb',
    'replayGainAlbumGainDb',
    'replayGainTrackPeak',
    'replayGainAlbumPeak',
    'r128TrackGainDb',
    'r128AlbumGainDb'
  ] as const) {
    const value = numberField(record, key)
    if (value !== undefined) item[key] = value
  }
  const codec = textField(record, 'codec') ?? textField(record, 'format')
  if (codec) item.codec = codec
  return item
}

/**
 * Renderer-free queue maintenance for Afterglow (Route C).
 *
 * The core never calls LoadQueue. It appends already-resolved entries and
 * refreshes the upcoming provider URL through the native hot-update contract,
 * so the active decoder stream keeps running. All work is serialized; `stop()`
 * cancels undispatched work and drains already dispatched engine commands. The
 * final mapping includes confirmed appends, without publishing stale callbacks.
 */
export class NativeQueueMaintainer {
  private readonly queue: readonly unknown[]
  private readonly queueLength: number
  private readonly loadQueueItem?: (index: number) => Promise<unknown | null>
  private readonly engine: NativeQueueMaintainerEngine
  private readonly resolver: SourceResolver
  private readonly lookahead: number
  private readonly refreshMarginMs: number
  private readonly now: () => number
  private readonly onMappingChanged?: (mapping: readonly number[]) => void
  private readonly onError?: (message: string) => void

  private readonly mapping: number[]
  private readonly sources = new Map<number, ResolvedSource>()
  private readonly retryAfter = new Map<number, number>()
  private nextLogicalIndex: number
  private active = false
  private generation = 0
  private lane: Promise<void> = Promise.resolve()
  private engineDrain: Promise<void> = Promise.resolve()
  private pendingTick: Promise<void> | null = null
  private lastError: string | null = null
  private sourceReads = new AbortController()

  constructor(options: NativeQueueMaintainerOptions) {
    this.queue = options.queue
    this.queueLength = options.queueLength ?? options.queue.length
    this.loadQueueItem = options.loadQueueItem
    this.engine = options.engine
    this.resolver = options.resolver
    this.lookahead = Math.max(1, options.lookahead ?? DEFAULT_LOOKAHEAD)
    this.refreshMarginMs = Math.max(0, options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS)
    this.now = options.now ?? Date.now
    this.onMappingChanged = options.onMappingChanged
    this.onError = options.onError
    this.mapping = [...options.nativeQueueIndices]
    this.nextLogicalIndex = this.mapping.length
      ? Math.max(...this.mapping) + 1
      : options.currentLogicalIndex + 1
    if (
      this.mapping.length === 0 ||
      this.mapping.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= this.queueLength
      )
    ) {
      this.lastError = 'afterglow_core_invalid_initial_mapping'
    }
  }

  isActive(): boolean {
    return this.active
  }

  getLastError(): string | null {
    return this.lastError
  }

  getMapping(): number[] {
    return [...this.mapping]
  }

  async start(): Promise<void> {
    if (this.lastError) {
      this.reportError(this.lastError)
      return
    }
    if (this.active) {
      await this.tick()
      return
    }
    this.active = true
    this.generation += 1
    this.sourceReads = new AbortController()
    await this.tick()
  }

  stop(): Promise<void> {
    this.active = false
    this.generation += 1
    this.sourceReads.abort()
    this.pendingTick = null
    // Provider/SQL reads may be slow: their generation fence is sufficient.
    // Only an engine command already sent can still change the handoff map.
    return this.engineDrain
  }

  /** Coalesces concurrent ticks; provider/append work is serialized through the lane. */
  tick(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.pendingTick) return this.pendingTick
    const generation = this.generation
    const run = this.lane
      .then(() => this.runTick(generation))
      .catch((error) => {
        if (this.isCurrent(generation))
          this.reportError(error instanceof Error ? error.message : String(error))
      })
    this.pendingTick = run
    void run.finally(() => {
      if (this.pendingTick === run) this.pendingTick = null
    })
    this.lane = run.catch(() => undefined)
    return run
  }

  private reportError(message: string): void {
    this.lastError = message
    console.warn('[afterglow] queue core:', message)
    this.onError?.(message)
  }

  private fail(reason: string): void {
    this.reportError(reason)
    this.active = false
    this.generation += 1
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation
  }

  private mutateEngine<T>(command: () => Promise<T>, commit: (result: T) => void): Promise<void> {
    const result = command().then(commit)
    this.engineDrain = result.catch(() => {})
    return result
  }

  private async resolveSource(
    logicalIndex: number,
    generation: number
  ): Promise<{ track: unknown; resolved: ResolvedSource } | null> {
    const retryAt = this.retryAfter.get(logicalIndex) ?? 0
    if (this.now() < retryAt) return null
    const track = this.loadQueueItem
      ? await this.loadQueueItem(logicalIndex)
      : this.queue[logicalIndex]
    if (!track || !this.isCurrent(generation)) return null
    const resolved = await this.resolver.resolve(track, this.sourceReads.signal, {
      autoMixPrepare: true
    })
    if (!this.isCurrent(generation)) return null
    if (!resolved) {
      this.retryAfter.set(logicalIndex, this.now() + RESOLVE_RETRY_MS)
      return null
    }
    this.retryAfter.delete(logicalIndex)
    return { track, resolved }
  }

  private async runTick(generation: number): Promise<void> {
    if (!this.active || generation !== this.generation) return
    const state = await this.engine.getQueueState()
    if (!this.active || generation !== this.generation) return
    if (!state) {
      // Older engine or transient service failure: keep trying on later ticks.
      return
    }
    if (state.size !== this.mapping.length) {
      this.fail(`afterglow_core_mapping_mismatch:${state.size}/${this.mapping.length}`)
      return
    }
    if (state.currentIndex < 0 || state.currentIndex >= this.mapping.length) return

    await this.refreshUpcoming(state, generation)
    if (!this.active || generation !== this.generation) return
    await this.ensureLookahead(state, generation)
  }

  private async refreshUpcoming(state: AudioEngineQueueState, generation: number): Promise<void> {
    const upcomingNative = state.upcomingIndex
    if (upcomingNative < 0 || upcomingNative >= this.mapping.length) return
    if (upcomingNative === state.currentIndex) return
    const logicalIndex = this.mapping[upcomingNative]
    if (logicalIndex < 0) return

    const cached = this.sources.get(logicalIndex)
    const expiresAt = cached?.expiresAt
    const due =
      !cached || (typeof expiresAt === 'number' && expiresAt - this.now() <= this.refreshMarginMs)
    if (!due) return

    const loaded = await this.resolveSource(logicalIndex, generation)
    if (!loaded || !this.isCurrent(generation)) return
    const { resolved } = loaded
    if (cached?.source === resolved.source) {
      this.sources.set(logicalIndex, resolved)
      return
    }
    try {
      await this.mutateEngine(
        () => this.engine.updateQueueItemSource(upcomingNative, resolved.source),
        (updated) => {
          if (!this.isCurrent(generation)) return
          if (!updated) {
            this.reportError(`afterglow_core_source_update_rejected:${upcomingNative}`)
            return
          }
          this.sources.set(logicalIndex, resolved)
        }
      )
    } catch (error) {
      if (this.isCurrent(generation))
        this.reportError(error instanceof Error ? error.message : String(error))
    }
  }

  private async ensureLookahead(state: AudioEngineQueueState, generation: number): Promise<void> {
    let appended = 0
    while (
      this.isCurrent(generation) &&
      appended < MAX_APPEND_PER_TICK &&
      this.mapping.length - state.currentIndex <= this.lookahead
    ) {
      if (this.nextLogicalIndex >= this.queueLength) return
      const logicalIndex = this.nextLogicalIndex
      const loaded = await this.resolveSource(logicalIndex, generation)
      if (!this.isCurrent(generation)) return
      if (!loaded) {
        this.reportError(`afterglow_core_source_unavailable:${logicalIndex}`)
        return
      }
      const { track, resolved } = loaded
      const item = nativeQueueItem(track, resolved.source, logicalIndex)
      try {
        await this.mutateEngine(
          () => this.engine.appendQueueItems([item]),
          (firstIndex) => {
            if (firstIndex !== this.mapping.length) {
              if (this.isCurrent(generation))
                this.fail(
                  `afterglow_core_append_index_mismatch:${firstIndex}/${this.mapping.length}`
                )
              return
            }
            // Keep a confirmed physical append in the final handoff map,
            // even when its owner stopped while the engine was replying.
            this.mapping.push(logicalIndex)
            this.nextLogicalIndex = logicalIndex + 1
            if (!this.isCurrent(generation)) return
            this.sources.set(logicalIndex, resolved)
            this.onMappingChanged?.(this.getMapping())
          }
        )
      } catch (error) {
        if (this.isCurrent(generation))
          this.fail(error instanceof Error ? error.message : String(error))
        return
      }
      if (!this.isCurrent(generation)) return
      appended += 1
    }
  }
}
