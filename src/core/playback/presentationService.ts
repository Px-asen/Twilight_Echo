import type { TrackData } from '../../shared/track.ts'
import type {
  CorePlayerMvRequest,
  CorePlayerMvResult,
  CorePlayerPresentation
} from '../../shared/coreSystemPlayer.ts'
import type { CoreLyricsCurrent } from '../../shared/coreLyrics.ts'
import {
  normalizeProviderMvStream,
  type MediaProviderMvQuality,
  type MediaProviderMvSource,
  type MediaProviderMvStream
} from '../../shared/providerMv.ts'
import { pickBestLyricSearchMatch } from '../lyrics/providerLyrics.ts'
import {
  providerTrackIdentity,
  recoverProviderTrackArtwork,
  type ProviderTrackIdentity
} from './providerArtworkRecovery.ts'

export interface CorePlayerPresentationOptions {
  artwork(
    track: TrackData,
    signal: AbortSignal
  ): Promise<Pick<CorePlayerPresentation, 'cover' | 'coverSource'>>
  artworkRecovered?(
    track: TrackData,
    artwork: { cover: string | null; coverSource: string | null }
  ): void
  playlists: {
    isFavorite(track: TrackData): Promise<boolean>
    toggleFavorite(track: TrackData, assertCurrent: () => void): Promise<boolean>
  }
  listProviderIds?(): readonly string[]
  supportedMethods(providerId: string): readonly string[]
  callProvider(
    providerId: string,
    method: 'likeTrack' | 'isTrackLiked' | 'searchSongs' | 'getTrackMv',
    args: unknown[],
    signal?: AbortSignal
  ): Promise<unknown>
  resolveBilibiliMv?(
    track: Partial<TrackData>,
    options: { quality: MediaProviderMvQuality; force: boolean },
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null>
  now?(): number
  changed(): void
  failed(error: unknown): void
}

const MV_POSITIVE_CACHE_TTL_MS = 10 * 60_000
const MV_NEGATIVE_CACHE_TTL_MS = 3 * 60_000
const MV_CACHE_CAPACITY = 64

/** Current artwork and favorite state, independent of every presentation window. */
export class CorePlayerPresentationService {
  private track: TrackData | null = null
  private state: CorePlayerPresentation = {
    current: null,
    cover: null,
    coverSource: null,
    favorite: { available: false, liked: false, loading: false }
  }
  private revision = 0
  private currentRequest: AbortController | null = null
  private readWork: Promise<void> = Promise.resolve()
  private favoriteRead: Promise<void> = Promise.resolve()
  private writes: Promise<unknown> = Promise.resolve()
  private writing = false
  private stopped = false
  private readonly fallbackArtworkCache = new Map<
    string,
    { cover: string | null; coverSource: string | null }
  >()
  private readonly mvCache = new Map<
    string,
    { stream: MediaProviderMvStream | null; expiresAt: number }
  >()
  private readonly options: CorePlayerPresentationOptions
  constructor(options: CorePlayerPresentationOptions) {
    this.options = options
  }
  getRevision(): number {
    return this.revision
  }
  snapshot(): CorePlayerPresentation {
    return structuredClone(this.state)
  }
  private changed(): void {
    this.revision++
    this.options.changed()
  }
  private current(expected: CoreLyricsCurrent): boolean {
    return (
      this.state.current?.trackId === expected.trackId &&
      this.state.current.occurrenceId === expected.occurrenceId
    )
  }
  observe(
    track: TrackData | null,
    occurrenceId: string | null = track?.queueEntryId ?? null
  ): void {
    if (this.stopped) return
    const identity = track ? { trackId: track.id, occurrenceId } : null
    const same = identity ? this.current(identity) : this.state.current === null
    const artworkChanged =
      this.track?.cover !== track?.cover || this.track?.coverSource !== track?.coverSource
    this.track = track
    if (same) {
      if (artworkChanged) this.refresh()
      return
    }
    this.currentRequest?.abort()
    this.state = {
      current: identity,
      cover: null,
      coverSource: null,
      favorite: { available: false, liked: false, loading: false }
    }
    this.changed()
    if (track) this.refresh()
  }
  refresh(): void {
    const track = this.track
    const expected = this.state.current
    if (!track || !expected || this.stopped || this.writing) return
    this.currentRequest?.abort()
    const request = (this.currentRequest = new AbortController())
    const provider = providerTrackIdentity(track)
    const methods = provider ? this.options.supportedMethods(provider.providerId) : []
    this.state.favorite.available =
      !provider || (provider.trackId != null && methods.includes('likeTrack'))
    this.state.favorite.loading =
      provider?.providerId === 'bili' && methods.includes('isTrackLiked')
    this.changed()
    const active = () => !request.signal.aborted && this.current(expected)
    const artwork = this.resolveTrackArtwork(track, provider, methods, request.signal)
      .then((value) => {
        if (!active()) return
        this.state.cover = value.cover
        this.state.coverSource = value.coverSource
        this.changed()
      })
      .catch((error) => {
        if (active()) this.options.failed(error)
      })
    const liked = !provider
      ? this.options.playlists.isFavorite(track)
      : provider.trackId != null && methods.includes('isTrackLiked')
        ? this.options
            .callProvider(provider.providerId, 'isTrackLiked', [provider.trackId], request.signal)
            .then(Boolean)
        : Promise.resolve(false)
    const favorite = liked
      .then((value) => {
        if (!active()) return
        this.state.favorite.liked = value
      })
      .catch((error) => {
        if (active()) this.options.failed(error)
      })
      .finally(() => {
        if (!active()) return
        this.state.favorite.loading = false
        this.changed()
      })
    this.favoriteRead = favorite
    this.readWork = Promise.all([artwork, favorite]).then(() => undefined)
  }
  toggleFavorite(
    expected: CoreLyricsCurrent,
    signal?: AbortSignal
  ): Promise<CorePlayerPresentation> {
    const work = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped) throw new Error('Player presentation is shutting down')
        const assertCurrent = () => {
          signal?.throwIfAborted()
          if (!this.current(expected))
            throw Object.assign(new Error('Playback occurrence changed'), {
              code: 'STALE_REVISION'
            })
        }
        assertCurrent()
        await this.favoriteRead
        assertCurrent()
        const track = this.track!
        const provider = providerTrackIdentity(track)
        if (!this.state.favorite.available) throw new Error('当前音源不支持收藏')
        this.writing = true
        this.state.favorite.loading = true
        this.changed()
        let failed = false
        try {
          const liked = !this.state.favorite.liked
          if (provider) {
            assertCurrent()
            // Once dispatched the accepted write finishes even if a client disconnects.
            await this.options.callProvider(provider.providerId, 'likeTrack', [
              provider.trackId,
              liked
            ])
            if (this.current(expected)) this.state.favorite.liked = liked
          } else {
            const result = await this.options.playlists.toggleFavorite(track, assertCurrent)
            if (this.current(expected)) this.state.favorite.liked = result
          }
        } catch (error) {
          failed = true
          throw error
        } finally {
          this.writing = false
          if (this.current(expected)) {
            this.state.favorite.loading = false
            this.changed()
          }
          if (failed || !this.current(expected)) this.refresh()
        }
        return this.snapshot()
      })
    this.writes = work
    return work
  }
  private async resolveTrackArtwork(
    track: TrackData,
    provider: ProviderTrackIdentity | null,
    methods: readonly string[],
    signal: AbortSignal
  ): Promise<Pick<CorePlayerPresentation, 'cover' | 'coverSource'>> {
    const direct = await this.options.artwork(track, signal)
    if (direct.cover || direct.coverSource || !provider) return direct
    if (['local', 'network', 'radio', 'podcast'].includes(provider.providerId)) return direct
    const cacheKey = `${provider.providerId}:${track.id}`
    let recovered = this.fallbackArtworkCache.get(cacheKey)
    if (!recovered && methods.includes('searchSongs') && track.title?.trim()) {
      try {
        const candidate = await recoverProviderTrackArtwork(
          track,
          {
            supportedMethods: (id) => (id === provider.providerId ? methods : this.options.supportedMethods(id)),
            callProvider: (id, method, args, currentSignal) =>
              this.options.callProvider(id, method, args, currentSignal)
          },
          signal
        )
        if (candidate) {
          recovered = candidate
          this.fallbackArtworkCache.delete(cacheKey)
          this.fallbackArtworkCache.set(cacheKey, recovered)
          if (this.fallbackArtworkCache.size > 256) {
            const oldest = this.fallbackArtworkCache.keys().next().value
            if (oldest !== undefined) this.fallbackArtworkCache.delete(oldest)
          }
        }
      } catch {
        signal.throwIfAborted()
      }
    }
    if (!recovered) return direct
    signal.throwIfAborted()
    this.options.artworkRecovered?.(track, recovered)
    return this.options.artwork(
      { ...track, cover: recovered.cover, coverSource: recovered.coverSource ?? undefined },
      signal
    )
  }
  async resolveMv(
    request: CorePlayerMvRequest,
    signal?: AbortSignal
  ): Promise<CorePlayerMvResult> {
    if (this.stopped) throw new Error('Player presentation is shutting down')
    signal?.throwIfAborted()
    const expected: CoreLyricsCurrent = {
      trackId: request.trackId,
      occurrenceId: request.occurrenceId
    }
    const track = this.track
    if (!track || !this.state.current || !this.current(expected)) {
      return {
        current: this.state.current ? structuredClone(this.state.current) : null,
        available: false,
        stream: null
      }
    }
    if (track.source === 'radio' || track.source === 'podcast') {
      return { current: structuredClone(expected), available: false, stream: null }
    }

    const quality: MediaProviderMvQuality = request.quality ?? 'auto'
    const source: MediaProviderMvSource = request.source === 'ncm' ? 'ncm' : 'bili'
    const force = request.force === true
    const now = this.options.now ?? Date.now
    const cacheKey = `${track.id}\0${track.metadataMatch?.providerId ?? ''}:${track.metadataMatch?.trackId ?? ''}\0${quality}\0${source}`
    if (!force) {
      const cached = this.mvCache.get(cacheKey)
      if (cached) {
        if (cached.expiresAt > now()) {
          return {
            current: structuredClone(expected),
            available: cached.stream !== null,
            stream: cached.stream ? structuredClone(cached.stream) : null
          }
        }
        this.mvCache.delete(cacheKey)
      }
    }

    const stream = await this.resolveTrackMvUncached(track, quality, source, force, signal)
    signal?.throwIfAborted()
    this.mvCache.delete(cacheKey)
    this.mvCache.set(cacheKey, {
      stream,
      expiresAt: now() + (stream ? MV_POSITIVE_CACHE_TTL_MS : MV_NEGATIVE_CACHE_TTL_MS)
    })
    if (this.mvCache.size > MV_CACHE_CAPACITY) {
      const oldest = this.mvCache.keys().next().value
      if (oldest !== undefined) this.mvCache.delete(oldest)
    }

    if (!this.current(expected)) {
      return {
        current: this.state.current ? structuredClone(this.state.current) : null,
        available: false,
        stream: null
      }
    }
    return {
      current: structuredClone(expected),
      available: stream !== null,
      stream: stream ? structuredClone(stream) : null
    }
  }
  private async resolveTrackMvUncached(
    track: TrackData,
    quality: MediaProviderMvQuality,
    source: MediaProviderMvSource,
    force: boolean,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null> {
    const provider = providerTrackIdentity(track)

    if (source === 'ncm') {
      const ncmStream = await this.resolveNonBilibiliMv(track, provider, quality, force, signal, [
        'ncm'
      ])
      if (ncmStream) return ncmStream
      return this.resolveBilibiliFirstMv(track, provider, quality, force, signal)
    }

    // Default ('auto' / 'bili'): prioritize watermark-free Bilibili MV first;
    // if Bilibili fails or returns no match, automatically fall back to NetEase / installed providers.
    const biliStream = await this.resolveBilibiliFirstMv(track, provider, quality, force, signal)
    if (biliStream) return biliStream

    return this.resolveNonBilibiliMv(track, provider, quality, force, signal)
  }
  private async resolveBilibiliFirstMv(
    track: TrackData,
    provider: ProviderTrackIdentity | null,
    quality: MediaProviderMvQuality,
    force: boolean,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null> {
    if (provider?.providerId === 'bili') {
      const methods = this.options.supportedMethods('bili')
      if (methods.includes('getTrackMv')) {
        const directBili = await this.callProviderMv(
          'bili',
          toProviderMvLookupTrack(track, 'bili', provider.trackId),
          quality,
          force,
          signal
        )
        if (directBili) return directBili
      }
    }
    const builtInBili = await this.callBuiltInBilibiliMv(track, quality, force, signal)
    if (builtInBili) return builtInBili
    return this.searchProviderMv(track, ['bili'], quality, force, signal)
  }
  private async resolveNonBilibiliMv(
    track: TrackData,
    provider: ProviderTrackIdentity | null,
    quality: MediaProviderMvQuality,
    force: boolean,
    signal?: AbortSignal,
    allowedProviderIds?: readonly string[]
  ): Promise<MediaProviderMvStream | null> {
    const allowedSet = allowedProviderIds ? new Set(allowedProviderIds) : null
    const checkedProviders = new Set<string>(['bili'])

    if (
      provider &&
      !checkedProviders.has(provider.providerId) &&
      (!allowedSet || allowedSet.has(provider.providerId)) &&
      !['local', 'network', 'radio', 'podcast'].includes(provider.providerId)
    ) {
      const methods = this.options.supportedMethods(provider.providerId)
      if (methods.includes('getTrackMv')) {
        checkedProviders.add(provider.providerId)
        const direct = await this.callProviderMv(
          provider.providerId,
          toProviderMvLookupTrack(track, provider.providerId, provider.trackId),
          quality,
          force,
          signal
        )
        if (direct) return direct
        if (provider.providerId === 'ncm') return null
      }
    }

    const matched = track.metadataMatch
    if (matched?.providerId && matched.trackId) {
      const matchProviderId = matched.providerId.trim().toLowerCase()
      if (
        !checkedProviders.has(matchProviderId) &&
        (!allowedSet || allowedSet.has(matchProviderId))
      ) {
        const methods = this.options.supportedMethods(matchProviderId)
        if (methods.includes('getTrackMv')) {
          checkedProviders.add(matchProviderId)
          const matchedStream = await this.callProviderMv(
            matchProviderId,
            toProviderMvLookupTrack(track, matchProviderId, matched.trackId),
            quality,
            force,
            signal
          )
          if (matchedStream) return matchedStream
          if (matchProviderId === 'ncm') return null
        }
      }
    }

    const candidateIds = [
      ...new Set(
        allowedProviderIds
          ? [...allowedProviderIds]
          : [...(this.options.listProviderIds?.() ?? []), 'ncm']
      )
    ]
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id && !checkedProviders.has(id) && (!allowedSet || allowedSet.has(id)))
      .sort((a, b) => (a === 'ncm' ? -1 : b === 'ncm' ? 1 : a.localeCompare(b)))

    return this.searchProviderMv(track, candidateIds, quality, force, signal)
  }
  private async searchProviderMv(
    track: TrackData,
    candidateIds: readonly string[],
    quality: MediaProviderMvQuality,
    force: boolean,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null> {
    const query = [track.title, track.artist]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join(' ')
    if (!query) return null

    for (const candidateId of candidateIds) {
      signal?.throwIfAborted()
      const methods = this.options.supportedMethods(candidateId)
      if (!methods.includes('getTrackMv') || !methods.includes('searchSongs')) continue
      try {
        const searchRaw = await this.options.callProvider(
          candidateId,
          'searchSongs',
          [query, 8, 0],
          signal
        )
        signal?.throwIfAborted()
        const items = extractSearchCandidates(searchRaw)
        if (items.length === 0) continue
        const itemsWithMv = items.filter(
          (candidate) => typeof candidate.mvId === 'string' && candidate.mvId.trim().length > 0
        )
        const best =
          (itemsWithMv.length > 0 ? pickBestLyricSearchMatch(track, itemsWithMv) : null) ??
          pickBestLyricSearchMatch(track, items)
        if (!best) continue
        const stream = await this.callProviderMv(candidateId, best, quality, force, signal)
        if (stream) return stream
      } catch {
        signal?.throwIfAborted()
      }
    }
    return null
  }
  private async callBuiltInBilibiliMv(
    track: TrackData,
    quality: MediaProviderMvQuality,
    force: boolean,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null> {
    if (!this.options.resolveBilibiliMv) return null
    try {
      const raw = await this.options.resolveBilibiliMv(track, { quality, force }, signal)
      signal?.throwIfAborted()
      return normalizeProviderMvStream(raw, 'bili')
    } catch (error) {
      signal?.throwIfAborted()
      this.options.failed(error)
      return null
    }
  }
  private async callProviderMv(
    providerId: string,
    lookupTrack: Partial<TrackData>,
    quality: MediaProviderMvQuality,
    force: boolean,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null> {
    try {
      const raw = await this.options.callProvider(
        providerId,
        'getTrackMv',
        [lookupTrack, { quality, force }],
        signal
      )
      signal?.throwIfAborted()
      return normalizeProviderMvStream(raw, providerId)
    } catch (error) {
      signal?.throwIfAborted()
      this.options.failed(error)
      return null
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.currentRequest?.abort()
    this.mvCache.clear()
    await this.writes.catch(() => undefined)
    await this.readWork
  }
}

function toProviderMvLookupTrack(
  track: TrackData,
  providerId: string,
  trackId: string | number | null
): Partial<TrackData> {
  const normalizedId =
    trackId != null && String(trackId).trim()
      ? `${providerId}:${String(trackId).trim()}`
      : track.id
  const numericSongId =
    providerId === 'ncm' && trackId != null && /^[1-9]\d*$/.test(String(trackId).trim())
      ? Number(String(trackId).trim())
      : track.ncmSongId
  return {
    id: normalizedId,
    source: providerId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    ...(numericSongId !== undefined ? { ncmSongId: numericSongId } : {}),
    ...(track.mvId ? { mvId: track.mvId } : {})
  }
}

function extractSearchCandidates(raw: unknown): TrackData[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)
      ? (raw as { items: unknown[] }).items
      : []
  return list.filter(
    (entry): entry is TrackData =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { title?: unknown }).title === 'string'
  )
}
