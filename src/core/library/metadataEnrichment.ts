import type { TrackData as Track } from '../../shared/track.ts'
import {
  buildMetadataSearchQueries,
  enrichLocalTrackMetadata,
  findBestMetadataMatch,
  isMetadataPlaceholder,
  type MetadataEnrichmentPolicy
} from '../../shared/musicMetadataMatching.ts'
import { searchMetadataTracks } from './metadataSearch.ts'
import type { LibraryMetadataEnrichmentStatus } from '../../shared/coreMetadata.ts'
export type {
  LibraryMetadataEnrichmentStatus,
  LibraryMetadataEnrichmentState
} from '../../shared/coreMetadata.ts'

export interface LibraryMetadataEnrichmentProvider {
  searchSongs: (
    query: string,
    limit?: number,
    offset?: number,
    signal?: AbortSignal
  ) => Promise<{ items: Track[]; total: number }>
}

export interface LibraryMetadataEnrichmentOptions {
  cachePolicy?: Partial<MetadataEnrichmentPolicy>
}

/**
 * Both values are retained until the owner accepts the update. `source`
 * prevents an older scan snapshot from replacing a newer local-library record.
 */
export interface LibraryMetadataEnrichmentTrackUpdate {
  source: Track
  track: Track
}

type MetadataEnrichmentSink =
  | ((update: LibraryMetadataEnrichmentTrackUpdate) => void)
  | ((update: LibraryMetadataEnrichmentTrackUpdate) => Promise<void>)

export interface LibraryMetadataEnrichmentQueueOptions {
  provider: LibraryMetadataEnrichmentProvider
  concurrency?: number
  retryBaseMs?: number
  retryMaxMs?: number
  now?: () => number
  onStatus?: (status: LibraryMetadataEnrichmentStatus) => void
  onTrackEnriched?: MetadataEnrichmentSink
  /** Batch-capable owners can commit grouped matches without one write per copy. */
  onTracksEnriched?: (updates: LibraryMetadataEnrichmentTrackUpdate[]) => Promise<void>
}

export interface LibraryMetadataEnrichmentBenchmarkResult {
  trackCount: number
  uniqueQueryCount: number
  queryCalls: number
  maxConcurrentQueries: number
  durationMs: number
}

type QueueEntry = {
  key: string
  queryKey: string
  tracks: Map<string, { track: Track; policy: MetadataEnrichmentPolicy }>
}

type FailureBackoff = {
  attempts: number
  retryAt: number
}

const DEFAULT_CONCURRENCY = 6
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 8
const DEFAULT_RETRY_BASE_MS = 15_000
const DEFAULT_RETRY_MAX_MS = 5 * 60_000

export class LibraryMetadataEnrichmentQueue {
  private readonly provider: LibraryMetadataEnrichmentProvider
  private readonly concurrency: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly now: () => number
  private readonly onStatus?: (status: LibraryMetadataEnrichmentStatus) => void
  private readonly onTrackEnriched?: MetadataEnrichmentSink
  private readonly onTracksEnriched?: LibraryMetadataEnrichmentQueueOptions['onTracksEnriched']
  private readonly entries = new Map<string, QueueEntry>()
  private readonly activeEntries = new Map<string, QueueEntry>()
  private readonly failures = new Map<string, FailureBackoff>()
  private failureCleanupTimer: ReturnType<typeof setTimeout> | null = null
  private nextFailureCleanupAt = Infinity
  private readonly waiters = new Map<number, Array<() => void>>()
  private readonly activeAbortControllers = new Map<number, Set<AbortController>>()
  private generation = 0
  private activeWorkers = 0
  private readonly workers = new Set<Promise<void>>()
  private status: LibraryMetadataEnrichmentStatus = createIdleStatus()

  constructor(options: LibraryMetadataEnrichmentQueueOptions) {
    this.provider = options.provider
    this.concurrency = clampConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY)
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
    this.now = options.now ?? Date.now
    this.onStatus = options.onStatus
    this.onTrackEnriched = options.onTrackEnriched
    this.onTracksEnriched = options.onTracksEnriched
  }

  getStatus(): LibraryMetadataEnrichmentStatus {
    return { ...this.status }
  }

  enqueue(
    tracks: Track[],
    cachePolicy: Partial<MetadataEnrichmentPolicy> | undefined = undefined
  ): Promise<void> {
    if (this.now() >= this.nextFailureCleanupAt) this.pruneFailures()
    const policy = normalizeMetadataEnrichmentPolicy(cachePolicy)
    if (!policy.cover && !policy.lyrics && !policy.metadata) return Promise.resolve()

    const shouldStartNewRun =
      this.entries.size === 0 && this.status.active === 0 && this.status.state !== 'enriching'
    if (shouldStartNewRun) this.startNewRun()

    let added = false
    for (const track of tracks) {
      if (!isLocalTrack(track) || !needsMetadataEnrichment(track, policy)) continue
      const query = buildMetadataSearchQuery(track)
      const queryKey = normalizeMetadataQuery(query)
      if (!queryKey) continue

      const failure = this.failures.get(queryKey)
      if (failure && failure.retryAt > this.now()) {
        this.status.skipped += 1
        continue
      }

      const entry = this.entries.get(queryKey) ??
        this.activeEntries.get(queryKey) ?? {
          key: queryKey,
          queryKey,
          tracks: new Map<string, { track: Track; policy: MetadataEnrichmentPolicy }>()
        }
      if (!entry.tracks.has(track.id)) {
        entry.tracks.set(track.id, { track, policy })
        this.status.total += 1
        if (!this.activeEntries.has(queryKey)) this.status.queued += 1
        added = true
      }
      if (!this.activeEntries.has(queryKey)) this.entries.set(queryKey, entry)
    }

    if (!added) {
      if (
        this.entries.size === 0 &&
        this.status.active === 0 &&
        this.status.state === 'enriching'
      ) {
        this.finishRun(this.generation)
      } else if (
        this.entries.size === 0 &&
        this.status.active === 0 &&
        this.status.state === 'idle'
      ) {
        this.status.state = 'completed'
        this.emitStatus()
      } else {
        this.emitStatus()
      }
      return this.waitForRun(this.generation)
    }

    this.status.state = 'enriching'
    this.status.error = ''
    this.emitStatus()
    this.pump(this.generation)
    return this.waitForRun(this.generation)
  }

  cancel(): boolean {
    if (this.status.state !== 'enriching') return false
    const cancelledGeneration = this.generation
    this.generation += 1
    for (const controller of this.activeAbortControllers.get(cancelledGeneration) ?? []) {
      controller.abort()
    }
    this.activeAbortControllers.delete(cancelledGeneration)
    this.entries.clear()
    // A new run must not attach work to a request from the cancelled generation.
    this.activeEntries.clear()
    this.status = {
      ...this.status,
      state: 'cancelled',
      queued: 0,
      active: 0,
      error: ''
    }
    this.emitStatus()
    this.resolveWaiters(cancelledGeneration)
    return true
  }

  /** Cancellation acknowledges immediately; shutdown also joins accepted writes. */
  async join(): Promise<void> {
    await Promise.all([...this.workers])
  }

  /** The owning service calls this after cancellation has joined its workers. */
  dispose(): void {
    if (this.failureCleanupTimer !== null) clearTimeout(this.failureCleanupTimer)
    this.failureCleanupTimer = null
    this.nextFailureCleanupAt = Infinity
    this.failures.clear()
  }

  private scheduleFailureCleanup(at: number): void {
    if (this.failureCleanupTimer !== null && at >= this.nextFailureCleanupAt) return
    if (this.failureCleanupTimer !== null) clearTimeout(this.failureCleanupTimer)
    this.nextFailureCleanupAt = at
    this.failureCleanupTimer = setTimeout(() => this.pruneFailures(), Math.max(1, at - this.now()))
    // Node timers must not extend an owner's lifetime; the portable Core also runs in browsers.
    ;(this.failureCleanupTimer as unknown as { unref?: () => void }).unref?.()
  }

  private pruneFailures(): void {
    if (this.failureCleanupTimer !== null) clearTimeout(this.failureCleanupTimer)
    this.failureCleanupTimer = null
    this.nextFailureCleanupAt = Infinity
    const now = this.now()
    let next = Infinity
    for (const [key, failure] of this.failures) {
      const expires = failure.retryAt + this.retryMaxMs
      if (expires <= now && !this.entries.has(key) && !this.activeEntries.has(key)) {
        this.failures.delete(key)
      } else {
        next = Math.min(next, expires <= now ? now + this.retryMaxMs : expires)
      }
    }
    if (next !== Infinity) this.scheduleFailureCleanup(next)
  }

  private startNewRun(): void {
    this.generation += 1
    this.status = createIdleStatus()
  }

  private pump(generation: number): void {
    if (generation !== this.generation || this.status.state !== 'enriching') return
    while (this.activeWorkers < this.concurrency && this.entries.size > 0) {
      const entry = this.entries.values().next().value as QueueEntry | undefined
      if (!entry) break
      this.entries.delete(entry.key)
      this.activeEntries.set(entry.key, entry)
      this.activeWorkers += 1
      this.status.active += 1
      this.status.queued -= entry.tracks.size
      const work = this.processEntry(entry, generation)
      this.workers.add(work)
      void work.then(() => this.workers.delete(work))
    }
    this.emitStatus()
  }

  private async processEntry(entry: QueueEntry, generation: number): Promise<void> {
    let acceptingUpdate = false
    const controller = new AbortController()
    const controllers = this.activeAbortControllers.get(generation) ?? new Set<AbortController>()
    controllers.add(controller)
    this.activeAbortControllers.set(generation, controllers)
    try {
      const candidates = await searchMetadataTracks(
        Array.from(entry.tracks.values(), ({ track }) => track),
        (query, limit, offset, signal) => this.provider.searchSongs(query, limit, offset, signal),
        { signal: controller.signal }
      )
      if (generation !== this.generation) return
      this.failures.delete(entry.queryKey)
      const processed = new Set<string>()
      do {
        const updates: LibraryMetadataEnrichmentTrackUpdate[] = []
        for (const { track, policy } of entry.tracks.values()) {
          if (generation !== this.generation) return
          if (processed.has(track.id)) continue
          processed.add(track.id)
          const match = findBestMetadataMatch(track, candidates)
          const enriched = enrichLocalTrackMetadata(track, match, policy)
          if (enriched === track) continue
          if (this.onTracksEnriched) updates.push({ source: track, track: enriched })
          else {
            acceptingUpdate = true
            const accepted = this.onTrackEnriched?.({ source: track, track: enriched })
            if (accepted && typeof accepted.then === 'function') await accepted
            acceptingUpdate = false
          }
        }
        if (updates.length) {
          acceptingUpdate = true
          await this.onTracksEnriched!(updates)
          acceptingUpdate = false
        }
        // Copies can join an active query while its owner is saving a batch.
      } while (processed.size < entry.tracks.size)
      if (generation !== this.generation) return
      this.status.completed += entry.tracks.size
    } catch {
      if (generation !== this.generation) return
      const previous = this.failures.get(entry.queryKey)
      const attempts = (previous?.attempts ?? 0) + 1
      const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempts - 1))
      const retryAt = this.now() + retryMs
      this.failures.set(entry.queryKey, { attempts, retryAt })
      this.scheduleFailureCleanup(retryAt + this.retryMaxMs)
      this.status.failed += entry.tracks.size
      this.status.error = acceptingUpdate
        ? '元数据保存失败，请稍后重试'
        : '在线元数据服务暂不可用，将在稍后自动重试'
    } finally {
      const activeControllers = this.activeAbortControllers.get(generation)
      activeControllers?.delete(controller)
      if (activeControllers?.size === 0) this.activeAbortControllers.delete(generation)
      if (this.activeEntries.get(entry.key) === entry) this.activeEntries.delete(entry.key)
      this.activeWorkers = Math.max(0, this.activeWorkers - 1)
      if (generation !== this.generation) {
        this.pump(this.generation)
      } else {
        this.status.active = Math.max(0, this.status.active - 1)
        if (this.entries.size > 0) {
          this.pump(generation)
        } else if (this.status.active === 0) {
          this.finishRun(generation)
        } else {
          this.emitStatus()
        }
      }
    }
  }

  private finishRun(generation: number): void {
    if (generation !== this.generation || this.status.state !== 'enriching') return
    this.status.state =
      this.status.completed === 0 && this.status.failed > 0 ? 'failed' : 'completed'
    this.emitStatus()
    this.resolveWaiters(generation)
  }

  private waitForRun(generation: number): Promise<void> {
    if (
      generation !== this.generation ||
      (this.status.state !== 'enriching' && this.entries.size === 0 && this.status.active === 0)
    ) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(generation) ?? []
      waiters.push(resolve)
      this.waiters.set(generation, waiters)
    })
  }

  private resolveWaiters(generation: number): void {
    for (const resolve of this.waiters.get(generation) ?? []) resolve()
    this.waiters.delete(generation)
  }

  private emitStatus(): void {
    this.onStatus?.(this.getStatus())
  }
}

export async function enrichLocalTracksFromProviders(
  tracks: Track[],
  provider: LibraryMetadataEnrichmentProvider | null | undefined,
  options: LibraryMetadataEnrichmentOptions = {}
): Promise<Track[]> {
  if (!provider) return tracks

  const policy = normalizeMetadataEnrichmentPolicy(options.cachePolicy)
  let changed = false
  const enrichedTracks: Track[] = []
  for (const track of tracks) {
    const enriched = await enrichOneLocalTrack(track, provider, policy)
    if (enriched !== track) changed = true
    enrichedTracks.push(enriched)
  }

  return changed ? enrichedTracks : tracks
}

export async function runLibraryMetadataEnrichmentBenchmark(
  options: {
    trackCount?: number
    uniqueQueryCount?: number
    concurrency?: number
  } = {}
): Promise<LibraryMetadataEnrichmentBenchmarkResult> {
  const trackCount = Math.max(1, options.trackCount ?? 2_000)
  const uniqueQueryCount = Math.max(1, Math.min(trackCount, options.uniqueQueryCount ?? 200))
  const tracks = Array.from({ length: trackCount }, (_, index) =>
    createBenchmarkTrack(index, uniqueQueryCount)
  )
  const candidates = new Map<string, Track>()
  for (const track of tracks)
    candidates.set(buildMetadataSearchQuery(track), createBenchmarkCandidate(track))

  let queryCalls = 0
  let activeQueries = 0
  let maxConcurrentQueries = 0
  const startedAt = performance.now()
  const queue = new LibraryMetadataEnrichmentQueue({
    concurrency: options.concurrency,
    provider: {
      searchSongs: async (query) => {
        queryCalls += 1
        activeQueries += 1
        maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries)
        await Promise.resolve()
        activeQueries -= 1
        const candidate = candidates.get(query)
        return { items: candidate ? [candidate] : [], total: candidate ? 1 : 0 }
      }
    }
  })
  await queue.enqueue(tracks)
  return {
    trackCount,
    uniqueQueryCount,
    queryCalls,
    maxConcurrentQueries,
    durationMs: performance.now() - startedAt
  }
}

function createIdleStatus(): LibraryMetadataEnrichmentStatus {
  return {
    state: 'idle',
    total: 0,
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    error: ''
  }
}

function clampConcurrency(value: number): number {
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.round(value)))
}

async function enrichOneLocalTrack(
  track: Track,
  provider: LibraryMetadataEnrichmentProvider,
  policy: MetadataEnrichmentPolicy
): Promise<Track> {
  if (!isLocalTrack(track) || !needsMetadataEnrichment(track, policy)) return track

  try {
    const candidates = await searchMetadataTracks([track], (query, limit, offset, signal) =>
      provider.searchSongs(query, limit, offset, signal)
    )
    const match = findBestMetadataMatch(track, candidates)
    return enrichLocalTrackMetadata(track, match, policy)
  } catch {
    return track
  }
}

function isLocalTrack(track: Track): boolean {
  return track.source === 'local' || track.id.startsWith('local:')
}

function needsMetadataEnrichment(track: Track, policy: MetadataEnrichmentPolicy): boolean {
  return (
    (policy.metadata &&
      (isMetadataPlaceholder(track.artist) ||
        isMetadataPlaceholder(track.album) ||
        !track.genre)) ||
    (policy.cover && !track.cover) ||
    (policy.lyrics && (!track.lyrics || !track.translatedLyrics))
  )
}

function buildMetadataSearchQuery(track: Track): string {
  return buildMetadataSearchQueries(track)[0] ?? ''
}

function normalizeMetadataQuery(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeMetadataEnrichmentPolicy(
  value: Partial<MetadataEnrichmentPolicy> | undefined
): MetadataEnrichmentPolicy {
  return {
    cover: value?.cover !== false,
    lyrics: value?.lyrics !== false,
    metadata: value?.metadata !== false
  }
}

function createBenchmarkTrack(index: number, uniqueQueryCount: number): Track {
  const queryIndex = index % uniqueQueryCount
  return {
    id: `local:benchmark-${index}`,
    title: `Benchmark Track ${queryIndex}`,
    artist: 'Benchmark Artist',
    album: '',
    filePath: `C:\\Benchmark\\${index}.flac`,
    fileName: `${index}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local',
    format: 'flac'
  }
}

function createBenchmarkCandidate(track: Track): Track {
  return {
    ...track,
    id: `provider:${track.id}`,
    filePath: `provider:${track.id}`,
    fileName: track.title,
    album: 'Benchmark Album',
    cover: 'https://cover.invalid/benchmark.jpg',
    lyrics: '[00:00.00]Benchmark',
    source: 'provider'
  }
}
