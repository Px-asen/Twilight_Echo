import { onBeforeUnmount, watch, type Ref } from 'vue'
import type {
  MiniPlayerCommand,
  MiniPlayerLyricLineSnapshot,
  MiniPlayerStateSnapshot
} from '../../../shared/miniPlayer'
import type { Track } from '../types/music'
import type { PlayMode } from '../types/settings'
import { buildLyricLines, findActiveLyricIndex } from '../utils/lyrics.ts'

function compactLyricLine(line: ReturnType<typeof buildLyricLines>[number]): {
  original: string
  translation: string | null
} {
  const leads = line.voices?.filter((voice) => voice.role === 'lead') ?? []
  const primary = leads[0] ?? line.voices?.[0]
  return {
    original: leads.length
      ? leads
          .map((voice) => voice.text)
          .filter(Boolean)
          .join(' · ')
      : line.text,
    translation: primary?.translation?.text ?? line.translation
  }
}

interface MiniPlayerStateSource {
  track: Track | null
  isPlaying: boolean
  isLoading: boolean
  currentTime: number
  duration: number
  playbackRate: number
  volume: number
  playMode: PlayMode
  favoriteAvailable: boolean
  favoriteLiked: boolean
  favoriteLoading: boolean
  dominantColor: string
  queueIndex: number
  queueLength: number
}

interface MiniPlayerSyncOptions {
  positionAt?: () => number
  currentTrack: Ref<Track | null>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  currentTime: Ref<number>
  duration: Ref<number>
  playbackRate: Ref<number>
  volume: Ref<number>
  playMode: Ref<PlayMode>
  favoriteAvailable: Ref<boolean>
  favoriteLiked: Ref<boolean>
  favoriteLoading: Ref<boolean>
  dominantColor: Ref<string>
  queueIndex: Ref<number>
  queue: Ref<Track[]>
  togglePlay: () => Promise<void>
  next: () => void
  prev: () => void
  seek: (time: number) => void
  setVolume: (volume: number) => void
  cyclePlayMode: () => void
  setPlayMode: (mode: PlayMode) => void
  toggleFavorite: () => Promise<void>
}

export function buildMiniPlayerStateSnapshot(
  source: MiniPlayerStateSource
): MiniPlayerStateSnapshot {
  const track = source.track
  const lyrics = buildMiniPlayerLyricLines(track)
  return {
    capturedAtMs: Date.now(),
    track: track
      ? {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          albumArtist: track.albumArtist ?? '',
          trackNumber: typeof track.trackNumber === 'number' ? track.trackNumber : 0,
          cover: track.cover,
          format: track.format ?? null,
          sampleRate: typeof track.sampleRate === 'number' ? track.sampleRate : null,
          bitDepth: typeof track.bitDepth === 'number' ? track.bitDepth : null,
          coverSource: track.coverSource ?? null
        }
      : null,
    currentLyric: resolveCurrentLyricForMiniPlayer(track, source.currentTime),
    lyrics,
    isPlaying: source.isPlaying,
    isLoading: source.isLoading,
    currentTime: source.currentTime,
    duration: source.duration,
    playbackRate: source.playbackRate,
    volume: source.volume,
    playMode: source.playMode,
    favoriteAvailable: source.favoriteAvailable,
    favoriteLiked: source.favoriteLiked,
    favoriteLoading: source.favoriteLoading,
    dominantColor: source.dominantColor,
    queueIndex: source.queueIndex,
    queueLength: source.queueLength
  }
}

/**
 * Timed lyric lines for the mini player's multi-line view. Plain untimed
 * lyrics are excluded because the mini player switches lines by timestamp.
 */
export function buildMiniPlayerLyricLines(track: Track | null): MiniPlayerLyricLineSnapshot[] {
  return resolveCachedLyrics(track).snapshotLines
}

type ParsedLyricLine = ReturnType<typeof buildLyricLines>[number]

interface CachedMiniPlayerLyrics {
  trackId: string
  lyrics: string | null | undefined
  translatedLyrics: string | null | undefined
  lines: ParsedLyricLine[]
  snapshotLines: MiniPlayerLyricLineSnapshot[]
}

const EMPTY_CACHED_LYRICS: CachedMiniPlayerLyrics = {
  trackId: '',
  lyrics: null,
  translatedLyrics: null,
  lines: [],
  snapshotLines: []
}

/**
 * Single-slot parse cache. The playback clock republishes the mini player
 * snapshot several times per second, and parsing LRC/TTML for every tick was
 * the dominant cost of that path; the parse only changes when the track (or
 * its lyric text) does.
 */
let cachedLyrics: CachedMiniPlayerLyrics = EMPTY_CACHED_LYRICS

function resolveCachedLyrics(track: Track | null): CachedMiniPlayerLyrics {
  if (!track) return EMPTY_CACHED_LYRICS
  if (
    cachedLyrics.trackId === track.id &&
    cachedLyrics.lyrics === track.lyrics &&
    cachedLyrics.translatedLyrics === track.translatedLyrics
  ) {
    return cachedLyrics
  }
  const lines = buildLyricLines(track.lyrics, track.translatedLyrics)
  cachedLyrics = {
    trackId: track.id,
    lyrics: track.lyrics,
    translatedLyrics: track.translatedLyrics,
    lines,
    snapshotLines: lines
      .filter((line) => line.time != null && line.text.trim().length > 0)
      .map((line) => ({ time: line.time, ...compactLyricLine(line) }))
  }
  return cachedLyrics
}

/** Test hook: drop the parse cache so cache-hit assertions start clean. */
export function resetMiniPlayerLyricCache(): void {
  cachedLyrics = EMPTY_CACHED_LYRICS
}

/**
 * Coarse progress identity for the throttled currentTime path: the mini
 * player only needs a fresh snapshot when the active lyric line or the whole
 * second changes, not on every 250 ms clock tick.
 */
export function miniPlayerProgressKey(track: Track | null, currentTime: number): string {
  const lines = resolveCachedLyrics(track).lines
  const lineIndex = lines.length ? findActiveLyricIndex(lines, currentTime) : -1
  const second = Number.isFinite(currentTime) ? Math.floor(Math.max(0, currentTime)) : -1
  return `${lineIndex}:${second}`
}

/**
 * Binary search for the line whose timestamp is the latest one <= currentTime
 * (lines are sorted by time). Mirrors findActiveLyricIndex for the snapshot
 * shape so the mini player can highlight the current line on its own clock.
 */
export function findActiveMiniPlayerLyricIndex(
  lines: readonly MiniPlayerLyricLineSnapshot[],
  currentTime: number
): number {
  if (lines.length === 0 || !Number.isFinite(currentTime)) return -1
  let low = 0
  let high = lines.length - 1
  let activeIndex = -1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const lineTime = lines[mid].time
    if (lineTime == null) {
      high = mid - 1
      continue
    }
    if (lineTime <= currentTime) {
      activeIndex = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return activeIndex
}

/**
 * Resolves the lyric line active at `time` for the mini player idle display.
 * Only timed lyrics count; before the first line (or without lyrics) the
 * snapshot carries null so the mini player falls back to track metadata.
 */
export function resolveCurrentLyricForMiniPlayer(
  track: Track | null,
  time: number
): { original: string; translation: string | null } | null {
  if (!track) return null
  const lines = resolveCachedLyrics(track).lines
  if (lines.length === 0) return null
  const index = findActiveLyricIndex(lines, time)
  if (index < 0) return null
  const line = lines[index]
  const compact = compactLyricLine(line)
  if (!compact.original) return null
  return compact
}

export const MINI_PLAYER_PROGRESS_THROTTLE_MS = 500

export interface MiniPlayerPublishSchedulerOptions {
  publish: () => void
  progressKey: () => string
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (handle: unknown) => void
  throttleMs?: number
}

export interface MiniPlayerPublishScheduler {
  /** Metadata / transport change: publish immediately and drop any pending progress publish. */
  publishNow: () => void
  /** Playback clock tick: publish only when the progress key changed, trailing-throttled. */
  notifyProgress: () => void
  dispose: () => void
}

/**
 * Splits mini player publishing into an immediate path (track, transport,
 * favourite, volume...) and a throttled progress path so the 250 ms playback
 * clock no longer fans out a full snapshot (with every lyric line) four times
 * a second to the main process, SMTC, tray and satellite windows.
 */
export function createMiniPlayerPublishScheduler(
  options: MiniPlayerPublishSchedulerOptions
): MiniPlayerPublishScheduler {
  const now = options.now ?? (() => Date.now())
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as number))
  const throttleMs = Math.max(0, options.throttleMs ?? MINI_PLAYER_PROGRESS_THROTTLE_MS)
  let timer: unknown = null
  let lastPublishedAt = Number.NEGATIVE_INFINITY
  let lastProgressKey = ''
  let disposed = false

  function clearTimer(): void {
    if (timer === null) return
    cancel(timer)
    timer = null
  }

  function publishNow(): void {
    if (disposed) return
    clearTimer()
    lastProgressKey = options.progressKey()
    lastPublishedAt = now()
    options.publish()
  }

  function notifyProgress(): void {
    if (disposed || timer !== null) return
    if (options.progressKey() === lastProgressKey) return
    const elapsed = now() - lastPublishedAt
    if (elapsed >= throttleMs) {
      publishNow()
      return
    }
    timer = schedule(() => {
      timer = null
      if (disposed) return
      if (options.progressKey() !== lastProgressKey) publishNow()
    }, throttleMs - elapsed)
  }

  return {
    publishNow,
    notifyProgress,
    dispose: () => {
      disposed = true
      clearTimer()
    }
  }
}

export function useMiniPlayerSync(options: MiniPlayerSyncOptions): void {
  function publishState(): void {
    window.api.miniPlayer.publishState(
      buildMiniPlayerStateSnapshot({
        track: options.currentTrack.value,
        isPlaying: options.isPlaying.value,
        isLoading: options.isLoading.value,
        currentTime: options.positionAt?.() ?? options.currentTime.value,
        duration: options.duration.value,
        playbackRate: options.playbackRate.value,
        volume: options.volume.value,
        playMode: options.playMode.value,
        favoriteAvailable: options.favoriteAvailable.value,
        favoriteLiked: options.favoriteLiked.value,
        favoriteLoading: options.favoriteLoading.value,
        dominantColor: options.dominantColor.value,
        queueIndex: options.queueIndex.value,
        queueLength: options.queue.value.length
      })
    )
  }

  function runCommand(command: MiniPlayerCommand): void {
    switch (command.type) {
      case 'toggle-play':
        void options.togglePlay().catch((error) => {
          console.error('[mini-player] Failed to toggle playback:', error)
        })
        break
      case 'play':
        if (!options.isPlaying.value) {
          void options.togglePlay().catch((error) => {
            console.error('[mini-player] Failed to start playback:', error)
          })
        }
        break
      case 'pause':
        if (options.isPlaying.value) {
          void options.togglePlay().catch((error) => {
            console.error('[mini-player] Failed to pause playback:', error)
          })
        }
        break
      case 'previous':
        options.prev()
        break
      case 'next':
        options.next()
        break
      case 'seek':
        options.seek(command.value)
        break
      case 'set-volume':
        options.setVolume(command.value)
        break
      case 'cycle-play-mode':
        options.cyclePlayMode()
        break
      case 'set-play-mode':
        options.setPlayMode(command.value)
        break
      case 'toggle-favorite':
        void options.toggleFavorite().catch((error) => {
          console.error('[tray] Failed to toggle favorite:', error)
        })
        break
    }
  }

  const scheduler = createMiniPlayerPublishScheduler({
    publish: publishState,
    progressKey: () => miniPlayerProgressKey(options.currentTrack.value, options.currentTime.value)
  })

  const stopStateWatch = watch(
    [
      () => options.currentTrack.value?.id,
      () => options.currentTrack.value?.title,
      () => options.currentTrack.value?.artist,
      () => options.currentTrack.value?.album,
      () => options.currentTrack.value?.cover,
      () => options.currentTrack.value?.coverSource,
      () => options.currentTrack.value?.lyrics,
      () => options.currentTrack.value?.translatedLyrics,
      options.isPlaying,
      options.isLoading,
      options.duration,
      options.playbackRate,
      options.volume,
      options.playMode,
      options.favoriteAvailable,
      options.favoriteLiked,
      options.favoriteLoading,
      options.dominantColor,
      options.queueIndex,
      () => options.queue.value.length
    ],
    () => scheduler.publishNow(),
    { immediate: true }
  )
  const stopProgressWatch = watch(options.currentTime, () => scheduler.notifyProgress())
  const removeCommandListener = window.api.miniPlayer.onCommand(runCommand)

  onBeforeUnmount(() => {
    stopStateWatch()
    stopProgressWatch()
    scheduler.dispose()
    removeCommandListener()
  })
}
