import type { CoreHeartContext, CoreHeartState } from '../../shared/coreHeart.ts'
import type { CoreQueueReference } from '../../shared/coreProtocol.ts'
import type { TrackData } from '../../shared/track.ts'
import type {
  LibraryQueueSeedBatch,
  LibraryQueueSeedPage,
  LibraryQueueSeedProducer
} from './libraryQueueBuild.ts'
import { libraryTrack } from './libraryTrack.ts'
import { toPlaybackQueueSnapshot } from './queueSnapshots.ts'
import { projectCoreError } from '../projections.ts'
import { automaticPlaybackTracks, type AutomaticPlaybackAllowed } from './automaticPlayback.ts'

export interface HeartProviders {
  call(
    method: 'fetchUserLibrary' | 'fetchLikedTracksPage' | 'fetchIntelligenceList',
    args: unknown[],
    signal: AbortSignal
  ): Promise<unknown>
}
interface Options extends HeartProviders {
  automaticPlaybackAllowed?: AutomaticPlaybackAllowed
  queue(): CoreQueueReference | null
  track(): TrackData | null
  append(queueId: string, tracks: TrackData[], current: () => boolean): Promise<number>
  now(): number
  changed(): void
}

function tracks(value: unknown): TrackData[] {
  if (!Array.isArray(value)) throw new Error('Invalid NCM track batch')
  return value.flatMap((value) => {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string') return []
    const track = toPlaybackQueueSnapshot(libraryTrack({ ...value, source: 'ncm', filePath: '' }))
    track.streamUrl = null
    return track.ncmSongId && track.ncmSongId > 0 ? [track] : []
  })
}

/** Owns the authenticated liked-list context and recommendation lifetime, not audio callbacks. */
export class HeartQueue {
  private context: CoreHeartContext | null = null
  private controller = new AbortController()
  private pending: Promise<number> | null = null
  private failedWrite = false
  private retryAfter = 0
  private error: string | null = null
  private closed = false
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }

  attach(context: CoreHeartContext): void {
    this.stop()
    this.context = structuredClone(context)
  }
  stop(): void {
    this.controller.abort(new Error('Heart queue changed'))
    this.controller = new AbortController()
    this.context = null
    this.failedWrite = false
    this.retryAfter = 0
    this.error = null
  }
  persisted(): CoreHeartContext | undefined {
    return this.context ? structuredClone(this.context) : undefined
  }
  recover(): void {
    this.failedWrite = false
    this.retryAfter = 0
    this.error = null
  }
  state(): CoreHeartState {
    const queue = this.options.queue(),
      track = this.options.track()
    const attached = !!this.context && this.context.queueId === queue?.id
    const available = attached && track?.source === 'ncm'
    return {
      available,
      active: attached && !!this.context?.baseQueue,
      loading: this.pending !== null,
      remaining: queue ? Math.max(0, queue.total - queue.index - 1) : 0,
      error: this.error
    }
  }
  observe(playing: boolean): void {
    if (this.closed) return
    if (this.context && this.context.queueId !== this.options.queue()?.id) this.stop()
    const state = this.state()
    if (playing && state.active && state.available && state.remaining < 3)
      void this.refill().catch(() => {})
  }

  async liked(
    signal: AbortSignal,
    selectedId?: string
  ): Promise<{
    playlistId: number
    hasSelected(): boolean
    selectedIndex(): number
    produce: LibraryQueueSeedProducer
    /** Reads the next 200-song page; null once the playlist is exhausted. */
    nextBatch: LibraryQueueSeedBatch
    /** Rebinds the page cursor to a longer-lived signal once the queue that
     *  streams it is already playing and no longer owned by the start command. */
    useSignal(signal: AbortSignal): void
  }> {
    const library = (await this.options.call('fetchUserLibrary', [], signal)) as {
      likedPlaylist?: { id?: unknown }
    }
    signal.throwIfAborted()
    const playlistId = Number(library?.likedPlaylist?.id)
    if (!Number.isSafeInteger(playlistId) || playlistId <= 0)
      throw new Error('NCM liked playlist is unavailable')
    let selected = selectedId ? -1 : 0
    let offset = 0,
      position = 0,
      exhausted = false,
      pageSignal = signal
    // The cursor lives in this closure so a first page can start playing while
    // the remaining pages keep streaming in behind it.
    const nextBatch = async (): Promise<LibraryQueueSeedPage | null> => {
      if (exhausted) return null
      pageSignal.throwIfAborted()
      const page = (await this.options.call(
        'fetchLikedTracksPage',
        [offset, 200, false],
        pageSignal
      )) as {
        tracks: unknown
        nextOffset: number
        hasMore: boolean
      }
      pageSignal.throwIfAborted()
      const batch = tracks(page.tracks)
      if (selectedId && selected < 0) {
        const index = batch.findIndex((track) => track.id === selectedId)
        if (index >= 0) selected = position + index
      }
      position += batch.length
      if (!page.hasMore) exhausted = true
      else {
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
          throw new Error('NCM liked playlist cursor did not advance')
        offset = page.nextOffset
      }
      return batch.map((track) => ({ id: track.id, snapshot: { ...track } }))
    }
    return {
      playlistId,
      hasSelected: () => !selectedId || selected >= 0,
      selectedIndex: () => {
        if (selected < 0) throw new Error('Selected liked song is unavailable')
        return selected
      },
      produce: async (append) => {
        for (;;) {
          const batch = await nextBatch()
          if (!batch) break
          if (batch.length) await append(batch)
        }
      },
      nextBatch,
      useSignal: (next) => {
        pageSignal = next
      }
    }
  }
  async fetch(playlistId: number, seed: TrackData, signal: AbortSignal): Promise<TrackData[]> {
    if (seed.source !== 'ncm' || !seed.ncmSongId) throw new Error('Heart mode requires an NCM seed')
    const result = await this.options.call(
      'fetchIntelligenceList',
      [
        {
          songId: seed.ncmSongId,
          playlistId,
          startSongId: seed.ncmSongId,
          count: 20
        }
      ],
      signal
    )
    signal.throwIfAborted()
    return automaticPlaybackTracks(tracks(result), this.options.automaticPlaybackAllowed, signal)
  }
  refill(explicit = false): Promise<number> {
    if (this.pending) return this.pending
    if (explicit && this.failedWrite)
      throw new Error('Refresh stopped playback before another heart refill')
    const context = this.context,
      seed = this.options.track(),
      signal = this.controller.signal
    if (
      this.closed ||
      !context?.baseQueue ||
      !seed ||
      this.failedWrite ||
      (!explicit && this.options.now() < this.retryAfter)
    )
      return Promise.resolve(0)
    // Source recovery can keep this recommendation occurrence playing locally.
    // It remains an automatic queue, but a local decoder is not a provider seed.
    if (seed.source !== 'ncm' || !seed.ncmSongId) {
      if (explicit) return Promise.reject(new Error('Heart mode requires an NCM seed'))
      return Promise.resolve(0)
    }
    const current = () =>
      !signal.aborted && context === this.context && this.options.queue()?.id === context.queueId
    const work = Promise.resolve()
      .then(async () => {
        const batch = await this.fetch(context.likedPlaylistId, seed, signal)
        if (!current()) return 0
        let added: number
        try {
          added = await this.options.append(context.queueId, batch, current)
        } catch (error) {
          if (current()) this.failedWrite = true
          throw error
        }
        if (current()) {
          this.error = null
          this.retryAfter = added ? 0 : this.options.now() + 15_000
        }
        return added
      })
      .catch((error) => {
        if (current()) {
          this.error = projectCoreError(error)
          this.retryAfter = this.options.now() + 15_000
        }
        throw error
      })
      .finally(() => {
        if (this.pending === work) this.pending = null
        this.options.changed()
      })
    this.pending = work
    this.options.changed()
    return work
  }
  async shutdown(): Promise<void> {
    this.closed = true
    this.controller.abort(new Error('Heart queue is shutting down'))
    await this.pending?.catch(() => {})
  }
}
