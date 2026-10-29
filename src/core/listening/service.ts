import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { TrackData } from '../../shared/track.ts'
import type { ListeningStats, ListeningTrackStatWithId } from '../../shared/listeningStats.ts'
import type { ListeningStatsClearRange } from '../../shared/listeningStatsHistory.ts'
import {
  clearListeningStatsHistory,
  isListeningStatsClearRange,
  previewListeningStatsClear
} from '../../shared/listeningStatsHistory.ts'
import type {
  CoreStatisticsQuery,
  CoreStatisticsPage,
  CoreStatisticsSummary
} from '../../shared/coreStatistics.ts'
import type { CoreStatisticsOverview } from '../../shared/coreStatistics.ts'
import { summarizeRecordedTracks } from '../../shared/listeningRecordedSummary.ts'
import { projectCoreError, projectCoreTrack } from '../projections.ts'
import { CoreStatisticsRepository, type StatisticsCheckpoint } from './repository.ts'
import { createLibraryListeningProjection } from './libraryProjection.ts'
import {
  LISTENING_TICK_SECONDS,
  LISTENING_STATS_FLUSH_DELAY_MS,
  LISTENING_STATS_RETRY_DELAY_MS,
  LISTENING_STATS_MAX_TRACKS,
  applyRecoveredListeningArtwork,
  buildLastPlayedByTrackId,
  buildLastPlayedBySource,
  cloneTrack,
  compactListeningStatsForPersistence,
  compareMostListenedTracks,
  compareRecentTracks,
  compareTopTracks,
  dayKey,
  pickCoverFields,
  recordListeningOutcome,
  recordListeningSeconds,
  selectTopArtists
} from './model.ts'

const ARTWORK_CACHE_TTL_MS = 10 * 60 * 1000
const ARTWORK_NEGATIVE_CACHE_TTL_MS = 30 * 1000
const ARTWORK_CACHE_MAX_ENTRIES = 512
const ARTWORK_RECOVERY_PAGE_BUDGET = 12
const ARTWORK_RECOVERY_ATTEMPT_MAX = 2048

const SYNTHETIC_ARTWORK_TRACK: TrackData = {
  id: 'statistics:artwork',
  title: '',
  artist: '',
  album: '',
  filePath: '',
  fileName: '',
  duration: 0,
  size: 0,
  cover: null,
  lyrics: null
}

interface Capture {
  generation: number
  replacement: number
  checkpoint: StatisticsCheckpoint
}
export interface CoreStatisticsOptions {
  repository: CoreStatisticsRepository
  now(): number
  timers: {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(handle: unknown): void
  }
  history?: ReturnType<typeof createLibraryListeningProjection>
  artwork?(track: TrackData, signal: AbortSignal): Promise<{ cover: string | null }>
  recoverArtwork?: {
    canRecover(track: TrackData): boolean
    recover(
      track: TrackData,
      signal: AbortSignal
    ): Promise<{ cover: string | null; coverSource: string | null } | null>
  }
  changed(): void
}

/** Only the authoritative playback session can record listening. Client
 * attachment, queries and window lifecycle never start trackers or add counts. */
export class CoreStatisticsService {
  private stats: ListeningStats = { days: {}, tracks: {} }
  private initialized = false
  private stopped = false
  private generation = 0
  private revision = 0
  private replace = 0
  private savedReplacement = 0
  private readonly dirtyTracks = new Map<string, number>()
  private readonly dirtyDays = new Map<string, number>()
  private readonly projectedCoverCache = new Map<
    string,
    { cover: string | null; expiresAt: number }
  >()
  private readonly inflightCoverProjections = new Map<string, Promise<string | null>>()
  private readonly attemptedArtworkRecovery = new Set<string>()
  private readonly shutdownController = new AbortController()
  private recoveryWork: Promise<void> = Promise.resolve()
  private pending: Capture | null = null
  private work: Promise<void> | null = null
  private flushTimer: unknown = null
  private tickTimer: unknown = null
  private lastCompactedDay = ''
  private lastCountedId = ''
  private lastCountedAt = 0
  private current: {
    track: TrackData | null
    info: Pick<PlaybackInfo, 'state' | 'position' | 'duration'>
  } | null = null
  private failureCount = 0
  private error: string | null = null
  private readonly options: CoreStatisticsOptions
  constructor(options: CoreStatisticsOptions) {
    this.options = options
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.stats = await this.options.repository.load()
    this.initialized = true
    this.compact()
    await this.options.history?.ensure()
    this.updateTimer()
  }
  getRevision(): number {
    return this.revision
  }
  historySnapshot(): ReadonlyMap<string, number> {
    return new Map([...buildLastPlayedByTrackId(this.stats), ...buildLastPlayedBySource(this.stats)])
  }
  exportData(): ListeningStats {
    return structuredClone(this.stats)
  }
  summary(): CoreStatisticsSummary {
    return {
      revision: this.revision,
      trackCount: Object.keys(this.stats.tracks).length,
      days: { ...this.stats.days },
      persistence: {
        dirty: this.isDirty(),
        failureCount: this.failureCount,
        error: this.error ? projectCoreError(this.error) : null
      }
    }
  }
  async overview(signal?: AbortSignal): Promise<CoreStatisticsOverview> {
    await this.options.history?.ensure()
    signal?.throwIfAborted()
    const summary = this.summary()
    const recorded = summarizeRecordedTracks(this.stats.tracks)
    const providerByArtist = new Map<string, string>()
    for (const stat of Object.values(this.stats.tracks)) {
      const provider = stat.sourceIds?.find((source) => source.source !== 'local')?.source
      if (provider && !providerByArtist.has(stat.artist)) providerByArtist.set(stat.artist, provider)
    }
    const topArtists = selectTopArtists(this.stats, 50)
    const artists = await Promise.all(
      topArtists.map(async (artist) => ({
        ...artist,
        cover: await this.projectCover(
          artist.cover,
          artist.coverSource ?? null,
          undefined,
          signal
        ),
        coverSource: null,
        sourceIds: artist.sourceIds.slice(0, 200),
        providerId: providerByArtist.get(artist.name) ?? null
      }))
    )
    signal?.throwIfAborted()
    return {
      ...summary,
      recorded,
      artists,
      history: {
        ...(this.options.history?.state.value ?? {
          mode: null,
          ready: false,
          pending: false,
          revision: null,
          error: ''
        })
      }
    }
  }
  previewClear(range: ListeningStatsClearRange, revision: number) {
    if (revision !== this.revision)
      throw Object.assign(new Error('Listening history changed'), { code: 'STALE_REVISION' })
    return { ...previewListeningStatsClear(this.stats, range), revision }
  }
  private selectPageEntries(query: CoreStatisticsQuery): {
    revision: number
    total: number
    offset: number
    slice: ListeningTrackStatWithId[]
  } {
    if (query.revision !== undefined && query.revision !== this.revision)
      throw Object.assign(new Error('Listening history changed; restart the paged query'), {
        code: 'STALE_REVISION'
      })
    const offset = query.offset ?? 0,
      limit = query.limit ?? 100
    const sort = query.sort ?? 'recent'
    const entries: ListeningTrackStatWithId[] = Object.entries(this.stats.tracks)
      .filter(([, stat]) =>
        sort === 'recent'
          ? stat.lastPlayed > 0
          : sort === 'seconds'
            ? stat.seconds > 0
            : stat.seconds > 0 || stat.plays > 0
      )
      .map(([id, stat]) => ({ id, ...stat }))
    entries.sort(
      sort === 'recent'
        ? compareRecentTracks
        : sort === 'seconds'
          ? compareMostListenedTracks
          : compareTopTracks
    )
    return {
      revision: this.revision,
      total: entries.length,
      offset,
      slice: entries.slice(offset, offset + limit)
    }
  }
  page(query: CoreStatisticsQuery): CoreStatisticsPage {
    const { revision, total, offset, slice } = this.selectPageEntries(query)
    return {
      revision,
      total,
      offset,
      items: slice.map((stat) => ({
        cover: cachedCover(stat.cover ?? stat.track?.cover ?? null),
        sourceIds: (stat.sourceIds ?? []).slice(0, 200),
        id: stat.id,
        seconds: stat.seconds,
        plays: stat.plays,
        skips: stat.skips,
        completions: stat.completions,
        lastPlayed: stat.lastPlayed,
        title: stat.title,
        artist: stat.artist,
        track: stat.track ? projectCoreTrack(stat.track) : null
      }))
    }
  }
  async projectPage(query: CoreStatisticsQuery, signal?: AbortSignal): Promise<CoreStatisticsPage> {
    signal?.throwIfAborted()
    const { revision, total, offset, slice } = this.selectPageEntries(query)
    this.enqueueArtworkRecovery(slice)
    const items = await Promise.all(
      slice.map(async (stat) => ({
        cover: await this.projectCover(
          stat.cover ?? stat.track?.cover ?? null,
          stat.coverSource ?? stat.track?.coverSource ?? null,
          stat.track,
          signal
        ),
        sourceIds: (stat.sourceIds ?? []).slice(0, 200),
        id: stat.id,
        seconds: stat.seconds,
        plays: stat.plays,
        skips: stat.skips,
        completions: stat.completions,
        lastPlayed: stat.lastPlayed,
        title: stat.title,
        artist: stat.artist,
        track: stat.track ? projectCoreTrack(stat.track) : null
      }))
    )
    signal?.throwIfAborted()
    return {
      revision,
      total,
      offset,
      items
    }
  }
  artworkTracks(ids: ReadonlySet<string>): Map<string, TrackData> {
    const found = new Map<string, TrackData>()
    if (ids.size === 0) return found
    for (const stat of Object.values(this.stats.tracks)) {
      const cover = stat.cover ?? stat.track?.cover ?? null
      const coverSource = stat.coverSource ?? stat.track?.coverSource ?? null
      const networkSource = stat.track?.networkSource
      if (!cover && !coverSource && !networkSource) continue
      const candidateIds: string[] = []
      if (stat.track?.id && ids.has(stat.track.id) && !found.has(stat.track.id))
        candidateIds.push(stat.track.id)
      for (const source of stat.sourceIds ?? []) {
        if (ids.has(source.trackId) && !found.has(source.trackId))
          candidateIds.push(source.trackId)
      }
      for (const matchedId of candidateIds) {
        found.set(matchedId, {
          ...(stat.track ?? SYNTHETIC_ARTWORK_TRACK),
          id: matchedId,
          title: stat.track?.title ?? stat.title,
          artist: stat.track?.artist ?? stat.artist,
          cover,
          coverSource,
          ...(networkSource ? { networkSource } : {})
        })
        if (found.size === ids.size) return found
      }
    }
    return found
  }
  rememberArtwork(
    track: TrackData,
    artwork: { cover: string | null; coverSource: string | null },
    statKey?: string
  ): void {
    if (this.stopped || (!artwork.cover && !artwork.coverSource)) return
    if (this.current?.track && this.current.track.id === track.id) {
      const coverFields = pickCoverFields({
        ...this.current.track,
        cover: artwork.cover ?? this.current.track.cover ?? null,
        coverSource: artwork.coverSource ?? this.current.track.coverSource ?? null
      })
      this.current = {
        ...this.current,
        track: cloneTrack({
          ...this.current.track,
          cover: coverFields.cover ?? this.current.track.cover ?? null,
          coverSource: coverFields.coverSource ?? this.current.track.coverSource ?? null
        })
      }
    }
    if (!this.initialized) return
    const key = applyRecoveredListeningArtwork(this.stats, track, artwork, statKey)
    if (key) this.markArtwork(key)
  }
  private async projectCover(
    rawCover: string | null | undefined,
    rawCoverSource: string | null | undefined,
    baseTrack?: TrackData,
    signal?: AbortSignal
  ): Promise<string | null> {
    signal?.throwIfAborted()
    const cover = rawCover?.trim() || null
    const coverSource = rawCoverSource?.trim() || null
    const networkSource = baseTrack?.networkSource
    if (!cover && !coverSource && !networkSource) return null
    if (!this.options.artwork) return cachedCover(cover)

    const cacheKey = networkSource
      ? `net:${networkSource.profileId}:${networkSource.entry.id}:${cover ?? ''}\0${coverSource ?? ''}`
      : `art:${cover ?? ''}\0${coverSource ?? ''}`
    const now = this.options.now()
    const cached = this.projectedCoverCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      this.projectedCoverCache.delete(cacheKey)
      this.projectedCoverCache.set(cacheKey, cached)
      return cached.cover
    }

    let pending = this.inflightCoverProjections.get(cacheKey)
    if (!pending) {
      const artwork = this.options.artwork
      const syntheticTrack: TrackData = {
        ...(baseTrack ?? SYNTHETIC_ARTWORK_TRACK),
        cover,
        coverSource,
        ...(networkSource ? { networkSource } : {})
      }
      pending = artwork(syntheticTrack, this.shutdownController.signal)
        .then((projected) => {
          const safe = displaySafeCover(projected.cover)
          const ttl = safe ? ARTWORK_CACHE_TTL_MS : ARTWORK_NEGATIVE_CACHE_TTL_MS
          this.projectedCoverCache.delete(cacheKey)
          this.projectedCoverCache.set(cacheKey, {
            cover: safe,
            expiresAt: this.options.now() + ttl
          })
          if (this.projectedCoverCache.size > ARTWORK_CACHE_MAX_ENTRIES) {
            const oldest = this.projectedCoverCache.keys().next().value
            if (oldest !== undefined) this.projectedCoverCache.delete(oldest)
          }
          return safe
        })
        .catch(() => cachedCover(cover))
        .finally(() => {
          this.inflightCoverProjections.delete(cacheKey)
        })
      this.inflightCoverProjections.set(cacheKey, pending)
    }

    const result = await pending
    signal?.throwIfAborted()
    return result
  }
  private enqueueArtworkRecovery(entries: readonly ListeningTrackStatWithId[]): void {
    const recoverArtwork = this.options.recoverArtwork
    if (!this.initialized || this.stopped || !recoverArtwork) return
    let scheduled = 0
    for (const stat of entries) {
      if (scheduled >= ARTWORK_RECOVERY_PAGE_BUDGET) break
      if (
        stat.cover ||
        stat.coverSource ||
        stat.track?.cover ||
        stat.track?.coverSource ||
        stat.track?.networkSource
      ) {
        continue
      }
      if (this.attemptedArtworkRecovery.has(stat.id)) continue
      const candidate = recoveryCandidateTrack(stat)
      if (!candidate || !recoverArtwork.canRecover(candidate)) continue

      this.attemptedArtworkRecovery.add(stat.id)
      if (this.attemptedArtworkRecovery.size > ARTWORK_RECOVERY_ATTEMPT_MAX) {
        const oldest = this.attemptedArtworkRecovery.values().next().value
        if (oldest !== undefined) this.attemptedArtworkRecovery.delete(oldest)
      }
      scheduled++
      const statId = stat.id
      this.recoveryWork = this.recoveryWork
        .catch(() => undefined)
        .then(async () => {
          if (this.stopped || this.shutdownController.signal.aborted) return
          try {
            const recovered = await recoverArtwork.recover(
              candidate,
              this.shutdownController.signal
            )
            if (this.stopped || this.shutdownController.signal.aborted || !recovered) return
            this.rememberArtwork(candidate, recovered, statId)
          } catch {
            // Best-effort background recovery must never fail queries or crash Core.
          }
        })
    }
  }
  observe(
    track: TrackData | null,
    info: Pick<PlaybackInfo, 'state' | 'position' | 'duration'>
  ): void {
    if (this.stopped) return
    const previous = this.current
    if (this.initialized && previous?.track && previous.track.id !== track?.id) {
      const key = recordListeningOutcome(
        this.stats,
        previous.track,
        previous.info.position,
        previous.info.duration,
        this.options.now()
      )
      if (key) this.mark(key)
    }
    // Keep the full CUE/SACD identity inside Core; public pages have allowlisted DTOs.
    this.current = { track: track ? cloneTrack(track) : null, info: { ...info } }
    const changedTrack = previous?.track?.id !== track?.id
    if (changedTrack) this.clearTick()
    this.updateTimer()
    if (this.initialized && info.state !== 'playing' && previous?.info.state === 'playing')
      void this.flush().catch(() => {})
  }
  private updateTimer(): void {
    if (
      !this.initialized ||
      this.stopped ||
      !this.current?.track ||
      this.current.info.state !== 'playing'
    ) {
      this.clearTick()
      return
    }
    if (this.tickTimer !== null) return
    this.tickTimer = this.options.timers.setTimeout(() => {
      this.tickTimer = null
      const current = this.current
      if (current?.track && current.info.state === 'playing' && !this.stopped) {
        const now = this.options.now()
        const key = recordListeningSeconds(
          this.stats,
          current.track,
          LISTENING_TICK_SECONDS,
          now,
          this.lastCountedId === current.track.id ? 0 : 1
        )
        this.lastCountedId = current.track.id
        this.lastCountedAt = now
        this.mark(key, dayKey(now))
      }
      this.updateTimer()
    }, LISTENING_TICK_SECONDS * 1000)
  }
  private mark(track: string, day?: string): void {
    const version = ++this.generation
    this.dirtyTracks.set(track, version)
    if (day) this.dirtyDays.set(day, version)
    this.revision++
    this.options.history?.refresh()
    this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
    this.options.changed()
  }
  private markArtwork(track: string): void {
    const version = ++this.generation
    this.dirtyTracks.set(track, version)
    this.revision++
    this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
    this.options.changed()
  }
  private compact(): void {
    const today = dayKey(this.options.now())
    if (
      today === this.lastCompactedDay &&
      Object.keys(this.stats.tracks).length <= LISTENING_STATS_MAX_TRACKS
    )
      return
    if (compactListeningStatsForPersistence(this.stats, this.options.now())) {
      this.replace = ++this.generation
      this.revision++
      this.options.history?.refresh()
      this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
    }
    this.lastCompactedDay = today
  }
  async clear(range: ListeningStatsClearRange, expectedRevision: number): Promise<void> {
    if (!isListeningStatsClearRange(range)) throw new Error('请选择有效的开始和结束日期')
    if (expectedRevision !== this.revision)
      throw Object.assign(new Error('Listening history changed; refresh before clearing'), {
        code: 'STALE_REVISION'
      })
    clearListeningStatsHistory(this.stats, range)
    this.projectedCoverCache.clear()
    this.attemptedArtworkRecovery.clear()
    this.replace = ++this.generation
    this.revision++
    const countedDay = dayKey(this.lastCountedAt)
    if (range === null || (countedDay >= range.startDay && countedDay <= range.endDay)) {
      this.lastCountedId = ''
      this.lastCountedAt = 0
    }
    this.options.history?.refresh()
    this.options.changed()
    await this.flush()
  }
  private isDirty(): boolean {
    return (
      this.replace !== this.savedReplacement ||
      this.dirtyTracks.size > 0 ||
      this.dirtyDays.size > 0 ||
      this.pending !== null
    )
  }
  private capture(): Capture {
    const replacement = this.replace,
      replace = replacement !== this.savedReplacement
    const tracks = replace
      ? Object.entries(this.stats.tracks)
      : [...this.dirtyTracks.keys()]
          .filter((key) => Object.hasOwn(this.stats.tracks, key))
          .map((key) => [key, this.stats.tracks[key]] as const)
    const days = replace
      ? Object.entries(this.stats.days)
      : [...this.dirtyDays.keys()]
          .filter((key) => Object.hasOwn(this.stats.days, key))
          .map((key) => [key, this.stats.days[key]] as const)
    return {
      generation: this.generation,
      replacement,
      checkpoint: structuredClone({
        replace,
        tracks: tracks.map(([key, value]) => ({ key, value })),
        days: days.map(([key, value]) => ({ key, value }))
      })
    }
  }
  private acknowledge(capture: Capture): void {
    for (const [key, version] of this.dirtyTracks)
      if (version <= capture.generation) this.dirtyTracks.delete(key)
    for (const [key, version] of this.dirtyDays)
      if (version <= capture.generation) this.dirtyDays.delete(key)
    this.savedReplacement = capture.replacement
  }
  flush(): Promise<void> {
    this.clearFlush()
    if (this.work) return this.work.then(() => (this.isDirty() ? this.flush() : undefined))
    if (!this.initialized) return Promise.resolve()
    this.work = (async () => {
      try {
        if (this.pending) {
          const committed = await this.options.repository.recover()
          if (committed) this.acknowledge(this.pending)
          this.pending = null
        }
        this.compact()
        if (this.isDirty()) {
          this.pending = this.capture()
          await this.options.repository.publish(this.pending.checkpoint)
          this.acknowledge(this.pending)
          this.pending = null
        }
        this.failureCount = 0
        this.error = null
        if (this.isDirty()) this.schedule(LISTENING_STATS_FLUSH_DELAY_MS)
      } catch (error) {
        this.failureCount++
        this.error = projectCoreError(error)
        this.clearFlush()
        this.schedule(LISTENING_STATS_RETRY_DELAY_MS)
        throw error
      } finally {
        this.options.changed()
      }
    })().finally(() => {
      this.work = null
    })
    return this.work
  }
  private schedule(delay: number): void {
    if (this.flushTimer !== null || this.stopped) return
    this.flushTimer = this.options.timers.setTimeout(() => {
      this.flushTimer = null
      void this.flush().catch(() => {})
    }, delay)
  }
  private clearFlush(): void {
    if (this.flushTimer !== null) this.options.timers.clearTimeout(this.flushTimer)
    this.flushTimer = null
  }
  private clearTick(): void {
    if (this.tickTimer !== null) this.options.timers.clearTimeout(this.tickTimer)
    this.tickTimer = null
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.shutdownController.abort()
    this.clearTick()
    this.clearFlush()
    await this.recoveryWork.catch(() => undefined)
    await Promise.allSettled([...this.inflightCoverProjections.values()])
    await this.flush()
    await this.options.history?.drain()
    this.options.history?.dispose()
  }
}

function cachedCover(cover: string | null): string | null {
  return cover?.startsWith('cover://') ? cover.split(/[?#]/, 1)[0] : null
}

function displaySafeCover(cover: string | null | undefined): string | null {
  const value = cover?.trim()
  if (!value) return null
  if (value.startsWith('cover://')) return value.split(/[?#]/, 1)[0]
  if (value.startsWith('twilight-media://image/')) return value
  return null
}

function recoveryCandidateTrack(stat: ListeningTrackStatWithId): TrackData | null {
  if (stat.track) return stat.track
  const nonLocal = stat.sourceIds?.find((item) => item.source && item.source !== 'local')
  if (!nonLocal) return null
  return {
    ...SYNTHETIC_ARTWORK_TRACK,
    id: nonLocal.trackId,
    source: nonLocal.source,
    title: stat.title,
    artist: stat.artist,
    filePath: nonLocal.trackId,
    fileName: nonLocal.trackId
  }
}
