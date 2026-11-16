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
  /** Pin resources owned by a warm entry until evicted, consumed or cleared. */
  retain?(prepared: PreparedPlaybackSource): (() => void) | void
  schedule?(callback: () => void, delayMs: number): () => void
  now?(): number
  ahead?: number
  gapMs?: number
}

export interface SourcePrefetchQueue {
  /** Replace the warm set. Already prepared occurrences stay usable until consumed. */
  schedule(tracks: readonly TrackData[]): void
  /** Adopt an already-prepared successor without starting a provider batch. */
  seed(prepared: PreparedPlaybackSource): void
  /** Consume one warm occurrence; an expired source is dropped, never returned. */
  take(track: TrackData): PreparedPlaybackSource | null
  /** Abort any in-flight lookahead read while keeping already-warm entries available. */
  cancel(): void
  clear(): void
  size(): number
}

type Entry = {
  prepared: PreparedPlaybackSource
  release: (() => void) | undefined
}

/** A bounded lookahead cache of resolved sources. It never writes the queue,
 * the native window or the transport; a miss falls back to a normal resolve. */
export function createSourcePrefetchQueue(options: SourcePrefetchOptions): SourcePrefetchQueue {
  const now = options.now ?? Date.now
  const ahead = options.ahead ?? SOURCE_PREFETCH_AHEAD
  const gapMs = options.gapMs ?? PREFETCH_GAP_MS
  const scheduleTimer =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs)
      ;(timer as { unref?: () => void }).unref?.()
      return () => clearTimeout(timer)
    })
  const entries = new Map<string, Entry>()
  let run: AbortController | null = null
  let epoch = 0

  const usable = (prepared: PreparedPlaybackSource): boolean => {
    if (!isSourceCurrent(prepared.resolved, now())) return false
    try {
      prepared.confirm?.()
      return true
    } catch {
      return false
    }
  }

  const dropEntry = (key: string): void => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    entry.release?.()
  }

  const clearEntries = (): void => {
    for (const key of [...entries.keys()]) dropEntry(key)
  }

  const setEntry = (key: string, prepared: PreparedPlaybackSource): void => {
    dropEntry(key)
    const release = options.retain?.(prepared) ?? undefined
    entries.set(key, { prepared, release })
  }

  const waitGap = (delayMs: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted || delayMs <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      let cancelTimer: (() => void) | null = null
      const finish = () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        cancelTimer?.()
        cancelTimer = null
        resolve()
      }
      const onAbort = () => finish()
      signal.addEventListener('abort', onAbort, { once: true })
      const cancel = scheduleTimer(finish, delayMs)
      if (settled) cancel()
      else cancelTimer = cancel
    })
  }

  async function fill(
    generation: number,
    snapshot: readonly TrackData[],
    signal: AbortSignal
  ): Promise<void> {
    let failures = 0
    for (let index = 0; index < snapshot.length; index++) {
      if (generation !== epoch || signal.aborted) return
      const track = snapshot[index]
      const key = options.key(track)
      const warm = entries.get(key)
      if (warm && usable(warm.prepared)) continue
      dropEntry(key)
      try {
        const prepared = await options.prepare(track, signal)
        if (generation !== epoch || signal.aborted) return
        if (!usable(prepared)) {
          failures++
        } else {
          setEntry(key, prepared)
          failures = 0
        }
      } catch {
        if (generation !== epoch || signal.aborted) return
        failures++
      }
      if (failures >= MAX_CONSECUTIVE_FAILURES) return
      if (gapMs > 0 && index < snapshot.length - 1) await waitGap(gapMs, signal)
    }
  }

  return {
    schedule(tracks) {
      const snapshot = [...tracks].slice(0, ahead)
      // Consumed occurrences fall out of the warm window as playback advances;
      // drop them so their resolved source and any provider-backed file handle
      // ownership are released instead of accumulating per skip.
      const keep = new Set(snapshot.map((track) => options.key(track)))
      for (const key of [...entries.keys()]) {
        if (!keep.has(key)) dropEntry(key)
      }
      run?.abort()
      run = new AbortController()
      const generation = ++epoch
      void fill(generation, snapshot, run.signal)
    },
    seed(prepared) {
      if (!usable(prepared)) return
      const key = options.key(prepared.track)
      const existing = entries.get(key)
      if (existing && usable(existing.prepared)) return
      setEntry(key, prepared)
    },
    take(track) {
      const key = options.key(track)
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      entry.release?.()
      return usable(entry.prepared) ? entry.prepared : null
    },
    cancel() {
      epoch++
      run?.abort()
      run = null
    },
    clear() {
      epoch++
      run?.abort()
      run = null
      clearEntries()
    },
    size: () => entries.size
  }
}
