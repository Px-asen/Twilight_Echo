import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { TrackData } from '../../shared/track.ts'
import type { ListeningSyncStatus, NcmListeningReport } from '../../shared/listeningSync.ts'
import { getNcmSongId } from '../../shared/ncmTrack.ts'
import { projectCoreError } from '../projections.ts'

type Sample = Pick<
  PlaybackInfo,
  'state' | 'position' | 'duration' | 'playbackRate' | 'naturalBoundaries'
>
interface ListeningAttempt {
  key: string
  id: string
  context: string
  generation: number
  account: Promise<number | null>
  track: TrackData
  songId: number
  sample: Sample
  at: number
  seconds: number
}
export interface NcmListeningSyncOptions {
  enabled: boolean
  available(): boolean
  context(): string
  account(signal: AbortSignal): Promise<number | null>
  submit(report: NcmListeningReport, idempotencyKey: string, signal: AbortSignal): Promise<void>
  now(): number
  newId(): string
  changed(): void
}

/** One observer per authoritative session. Windows never submit listening data.
 * Only observed progress counts; pauses, buffering and seeks cannot add their
 * skipped duration. Completed attempts are sent once, with no ambiguous retries. */
export class CoreNcmListeningSync {
  private enabled: boolean
  private stopped = false
  private generation = 0
  private controller = new AbortController()
  private readonly sessions = new Map<string, ListeningAttempt>()
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private lastSubmitted: ListeningSyncStatus['lastSubmitted'] = null
  private error: string | null = null
  private readonly options: NcmListeningSyncOptions

  constructor(options: NcmListeningSyncOptions) {
    this.options = options
    this.enabled = options.enabled
  }

  status(): ListeningSyncStatus {
    return {
      enabled: this.enabled,
      available: this.options.available(),
      pending: this.pending,
      lastSubmitted: this.lastSubmitted,
      error: this.error
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.reset()
  }

  accountChanged(): void {
    this.lastSubmitted = null
    this.reset()
  }

  private reset(): void {
    this.generation++
    this.sessions.clear()
    this.controller.abort()
    this.controller = new AbortController()
    this.error = null
    this.options.changed()
  }

  observe(sessionId: string, track: TrackData | null, sample: Sample): void {
    if (this.stopped || !this.enabled) return
    if (!this.options.available()) {
      this.sessions.delete(sessionId)
      return
    }
    const now = this.options.now()
    const context = this.options.context()
    let previous = this.sessions.get(sessionId)
    if (previous && previous.context !== context) {
      this.sessions.delete(sessionId)
      previous = undefined
    }
    const songId = track ? getNcmSongId(track) : null
    const validSong = songId !== null && Number.isSafeInteger(songId) && songId > 0
    const key = track && validSong ? `${track.id}\0${track.queueEntryId ?? ''}` : ''
    const changed = previous && previous.key !== key
    const boundary =
      !!previous &&
      sample.naturalBoundaries !== undefined &&
      previous.sample.naturalBoundaries !== undefined &&
      sample.naturalBoundaries.trackSerial > previous.sample.naturalBoundaries.trackSerial

    // Core can publish the same cached sample while preparing a transport
    // command, then publish the fresh native sample in the same turn. Keep
    // the original clock baseline until progress or state actually changes.
    if (
      previous &&
      !changed &&
      !boundary &&
      previous.sample.state === sample.state &&
      previous.sample.position === sample.position &&
      previous.sample.playbackRate === sample.playbackRate
    )
      return

    if (previous) {
      this.accrue(previous, sample, now, !!changed || boundary)
      if (changed || boundary || sample.state === 'stopped') {
        this.sessions.delete(sessionId)
        this.finish(previous)
        previous = undefined
      } else {
        previous.sample = { ...sample }
        previous.at = now
      }
    }
    if (!previous && track && validSong && sample.state === 'playing') {
      const generation = this.generation
      const signal = this.controller.signal
      const attempt: ListeningAttempt = {
        key,
        id: this.options.newId(),
        context,
        generation,
        track: { ...track },
        songId: songId!,
        sample: { ...sample },
        at: now,
        seconds: 0,
        account: Promise.resolve(null)
      }
      attempt.account = this.options
        .account(signal)
        .then((account) => {
          if (this.current(attempt) && !account) {
            this.error = '请先登录网易云音乐，登录后播放的歌曲会自动同步。'
            this.options.changed()
          }
          return account
        })
        .catch((error) => {
          if (!signal.aborted && this.current(attempt)) this.failed(error)
          return null
        })
      this.sessions.set(sessionId, attempt)
    }
  }

  private accrue(attempt: ListeningAttempt, next: Sample, now: number, boundary: boolean): void {
    const previous = attempt.sample
    if (previous.state !== 'playing') return
    const elapsed = Math.max(0, (now - attempt.at) / 1000)
    const duration = previous.duration || attempt.track.duration
    const progress = boundary
      ? Math.max(0, duration - previous.position)
      : Math.max(0, next.position - previous.position)
    const rate = previous.playbackRate && previous.playbackRate > 0 ? previous.playbackRate : 1
    // The clock bounds forward seeks; progress bounds pauses/stalls and process sleep.
    if (Number.isFinite(elapsed) && Number.isFinite(progress))
      attempt.seconds += Math.min(elapsed, progress / rate)
  }

  /** A confirmed seek changes position without contributing listening time. */
  seeked(sessionId: string, sample: Sample): void {
    const attempt = this.sessions.get(sessionId)
    if (!attempt) return
    attempt.sample = { ...sample }
    attempt.at = this.options.now()
  }

  private current(attempt: ListeningAttempt): boolean {
    return (
      this.enabled &&
      attempt.generation === this.generation &&
      attempt.context === this.options.context() &&
      this.options.available()
    )
  }

  private finish(attempt: ListeningAttempt): void {
    const total = attempt.sample.duration || attempt.track.duration
    const time = Math.floor(Math.min(attempt.seconds, total))
    if (!Number.isFinite(total) || total <= 0 || time < 1 || !this.current(attempt)) return
    const signal = this.controller.signal
    this.pending++
    this.options.changed()
    this.tail = this.tail
      .then(async () => {
        const accountId = await attempt.account
        if (!accountId || signal.aborted || !this.current(attempt)) return
        await this.options.submit(
          {
            id: attempt.songId,
            accountId,
            time,
            total,
            name: attempt.track.title,
            artist: attempt.track.artist,
            ...(attempt.track.streamQuality && attempt.track.streamQuality !== 'auto'
              ? { level: attempt.track.streamQuality }
              : {}),
            // TrackData uses bits/s; the NCBL endpoint expects kilobits/s.
            ...(attempt.track.bitrate && attempt.track.bitrate >= 1000
              ? { bitrate: Math.round(attempt.track.bitrate / 1000) }
              : {})
          },
          attempt.id,
          signal
        )
        if (signal.aborted || !this.current(attempt)) return
        this.lastSubmitted = { title: attempt.track.title, seconds: time, at: this.options.now() }
        this.error = null
      })
      .catch((error) => {
        if (!signal.aborted && this.current(attempt)) this.failed(error)
      })
      .finally(() => {
        this.pending--
        this.options.changed()
      })
  }

  private failed(error: unknown): void {
    this.error = projectCoreError(error instanceof Error ? error.message : String(error))
    this.options.changed()
  }

  /** A removed zone owns a final attempt even though no next song will arrive. */
  closeSession(sessionId: string): void {
    const attempt = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (attempt) this.finish(attempt)
  }

  /** Await already submitted work without turning a normal flush into a new play. */
  async flush(): Promise<void> {
    await this.tail
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const id of this.sessions.keys()) this.closeSession(id)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.tail,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000)
        })
      ])
    } finally {
      clearTimeout(timer)
      this.controller.abort()
    }
  }
}
