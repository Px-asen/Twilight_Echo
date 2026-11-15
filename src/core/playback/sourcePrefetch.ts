import type { TrackData } from '../../shared/track.ts'
import type { PreparedPlaybackSource } from './sourceRecovery.ts'
import { isSourceCurrent } from './sourceResolver.ts'

/** Occurrences kept warm ahead of the playing one. Provider reads stay serial
 * and every schedule starts a new epoch, so a skip never waits on a stale batch. */
export const SOURCE_PREFETCH_AHEAD = 4

/** A provider that is already slow should not be asked again back to back. */
const PREFETCH_GAP_MS = 250

/** Risk control and offline providers fail every occurrence; two is enough to
 * stop a batch that would otherwise hammer the provider four times per track. */
const MAX_CONSECUTIVE_FAILURES = 2

export interface SourcePrefetchOptions {
  /** Shares the session's own resolution path, including recovery and expiry. */
  prepare(track: TrackData, signal: AbortSignal): Promise<PreparedPlaybackSource>
  /** Occurrence identity: one queue may repeat the same track. */
  key(track: TrackData): string
  now?(): number
  ahead?: number
  gapMs?: number
}

export interface SourcePrefetchQueue {
  /** Replace the warm set. Already prepared occurrences stay usable until consumed. */
  schedule(tracks: readonly TrackData[]): void
  /** Consume one warm occurrence; an expired source is dropped, never returned. */
  take(track: TrackData): PreparedPlaybackSource | null
  clear(): void
  size(): number
}

/** A bounded lookahead cache of resolved sources. It never writes the queue,
 * the native window or the transport; a miss falls back to a normal resolve. */
export function createSourcePrefetchQueue(options: SourcePrefetchOptions): SourcePrefetchQueue {
  const now = options.now ?? Date.now
  const ahead = options.ahead ?? SOURCE_PREFETCH_AHEAD
  const gapMs = options.gapMs ?? PREFETCH_GAP_MS
  const entries = new Map<string, PreparedPlaybackSource>()
  let desired: TrackData[] = []
  let run: AbortController | null = null
  let epoch = 0

  const fresh = (prepared: PreparedPlaybackSource): boolean =>
    isSourceCurrent(prepared.resolved, now())

  async function fill(generation: number, signal: AbortSignal): Promise<void> {
    let failures = 0
    for (const track of desired) {
      if (generation !== epoch || signal.aborted) return
      const key = options.key(track)
      const warm = entries.get(key)
      if (warm && fresh(warm)) continue
      entries.delete(key)
      try {
        const prepared = await options.prepare(track, signal)
        if (generation !== epoch || signal.aborted) return
        if (!fresh(prepared)) {
          failures++
        } else {
          entries.set(key, prepared)
          failures = 0
        }
      } catch {
        if (generation !== epoch || signal.aborted) return
        failures++
      }
      if (failures >= MAX_CONSECUTIVE_FAILURES) return
      if (gapMs > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, gapMs))
    }
  }

  return {
    schedule(tracks) {
      desired = [...tracks].slice(0, ahead)
      // Consumed occurrences fall out of the warm window as playback advances;
      // drop them so their resolved source and any provider-backed file handle
      // ownership are released instead of accumulating per skip.
      const keep = new Set(desired.map((track) => options.key(track)))
      for (const key of [...entries.keys()]) if (!keep.has(key)) entries.delete(key)
      run?.abort()
      run = new AbortController()
      const generation = ++epoch
      void fill(generation, run.signal)
    },
    take(track) {
      const key = options.key(track)
      const warm = entries.get(key)
      if (!warm) return null
      entries.delete(key)
      return fresh(warm) ? warm : null
    },
    clear() {
      epoch++
      run?.abort()
      run = null
      desired = []
      entries.clear()
    },
    size: () => entries.size
  }
}
