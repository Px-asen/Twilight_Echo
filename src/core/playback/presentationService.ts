import type { TrackData } from '../../shared/track.ts'
import type { CorePlayerPresentation } from '../../shared/coreSystemPlayer.ts'
import type { CoreLyricsCurrent } from '../../shared/coreLyrics.ts'
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
  supportedMethods(providerId: string): readonly string[]
  callProvider(
    providerId: string,
    method: 'likeTrack' | 'isTrackLiked' | 'searchSongs',
    args: unknown[],
    signal?: AbortSignal
  ): Promise<unknown>
  changed(): void
  failed(error: unknown): void
}

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
  async shutdown(): Promise<void> {
    this.stopped = true
    this.currentRequest?.abort()
    await this.writes.catch(() => undefined)
    await this.readWork
  }
}
