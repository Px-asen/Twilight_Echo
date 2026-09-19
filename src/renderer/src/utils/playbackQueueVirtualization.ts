import type { Track } from '../types/music'

export const PLAYBACK_QUEUE_ROW_HEIGHT = 54
export const PLAYBACK_QUEUE_OVERSCAN = 6

export interface PlaybackQueueDisplayItem {
  index: number
  id: string
  queueEntryId: string
  title: string
  artist: string
  cover: string | null
}

export interface PlaybackQueueWindow {
  start: number
  end: number
}

/**
 * Playback only needs a stable identity, routing fields, and compact display
 * metadata. Lyrics and matching payloads remain on the active track/library.
 */
export function toPlaybackQueueSnapshot(track: Track): Track {
  return {
    id: track.id,
    queueEntryId: track.queueEntryId,
    title: track.title,
    artist: track.artist,
    artists: track.artists,
    album: track.album,
    filePath: track.filePath,
    fileName: track.fileName,
    dir: track.dir,
    subTrack: track.subTrack,
    cueRange: track.cueRange,
    cueSheetPath: track.cueSheetPath,
    cueEncoding: track.cueEncoding,
    duration: track.duration,
    size: track.size,
    cover: track.cover,
    coverSource: track.coverSource ?? null,
    lyrics: null,
    source: track.source,
    ncmSongId: track.ncmSongId,
    networkSource: track.networkSource,
    streamUrl: track.streamUrl ?? null,
    streamQuality: track.streamQuality,
    format: track.format,
    sampleRate: track.sampleRate,
    bitrate: track.bitrate,
    bitDepth: track.bitDepth,
    bpm: track.bpm,
    replayGainTrackGainDb: track.replayGainTrackGainDb,
    replayGainAlbumGainDb: track.replayGainAlbumGainDb,
    replayGainTrackPeak: track.replayGainTrackPeak,
    replayGainAlbumPeak: track.replayGainAlbumPeak,
    r128TrackGainDb: track.r128TrackGainDb,
    r128AlbumGainDb: track.r128AlbumGainDb
  }
}

export function toPlaybackQueueSnapshots(tracks: readonly Track[]): Track[] {
  const assignedIds = new Set<string>()
  const occurrenceByTrack = new Map<string, number>()

  return tracks.map((track) => {
    const occurrence = occurrenceByTrack.get(track.id) ?? 0
    occurrenceByTrack.set(track.id, occurrence + 1)
    const base = track.queueEntryId?.trim() || `queue:${track.id}:${occurrence}`
    let queueEntryId = base
    let suffix = 1
    while (assignedIds.has(queueEntryId)) {
      queueEntryId = `${base}:${suffix}`
      suffix += 1
    }
    assignedIds.add(queueEntryId)
    return toPlaybackQueueSnapshot({ ...track, queueEntryId })
  })
}

export function getPlaybackQueueWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = PLAYBACK_QUEUE_ROW_HEIGHT,
  overscan = PLAYBACK_QUEUE_OVERSCAN
): PlaybackQueueWindow {
  const safeTotal = Math.max(0, Math.floor(total))
  const safeRowHeight = Math.max(1, rowHeight)
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / safeRowHeight) - overscan)
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / safeRowHeight) + overscan * 2
  return { start: Math.min(safeTotal, start), end: Math.min(safeTotal, start + visibleCount) }
}

export function getPlaybackQueueScrollTopForIndex(
  index: number,
  total: number,
  viewportHeight: number,
  rowHeight = PLAYBACK_QUEUE_ROW_HEIGHT
): number {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0) return 0
  const safeRowHeight = Math.max(1, rowHeight)
  const safeIndex = Math.min(safeTotal - 1, Math.max(0, Math.floor(index)))
  const maxScrollTop = Math.max(0, safeTotal * safeRowHeight - Math.max(0, viewportHeight))
  const centered = safeIndex * safeRowHeight - (viewportHeight - safeRowHeight) / 2
  return Math.min(maxScrollTop, Math.max(0, centered))
}

export function createPlaybackQueueDisplayItems(
  tracks: readonly Track[],
  window: PlaybackQueueWindow
): PlaybackQueueDisplayItem[] {
  const items: PlaybackQueueDisplayItem[] = []
  for (let index = window.start; index < window.end; index += 1) {
    const track = tracks[index]
    if (!track) continue
    items.push({
      index,
      id: track.id,
      queueEntryId: track.queueEntryId ?? `queue:${track.id}:${index}`,
      title: track.title,
      artist: track.artist,
      cover: track.cover
    })
  }
  return items
}
