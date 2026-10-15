import type { Track } from '../types/music'
import { isQueuePlaybackOrigin } from '../../../shared/queueWorkspace.ts'
import { preserveQueueEntryContext, queuePlaybackOriginsMatch } from './queuePlaybackOrigin.ts'

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
    // Origins are immutable queue context. Keep the reference so native playback
    // updates do not replace a 20k queue solely because the origin was cloned.
    queuePlaybackOrigin: isQueuePlaybackOrigin(track.queuePlaybackOrigin)
      ? track.queuePlaybackOrigin
      : undefined,
    title: track.title,
    artist: track.artist,
    artists: track.artists,
    album: track.album,
    albumId: track.albumId,
    albumArtist: track.albumArtist,
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
    const snapshot = toPlaybackQueueSnapshot(track)
    snapshot.queueEntryId = queueEntryId
    return snapshot
  })
}

export function patchPlaybackQueueTrack(tracks: Track[], updatedTrack: Track): Track[] {
  const snapshot = toPlaybackQueueSnapshot(updatedTrack)
  let updated: Track[] | null = null
  for (let index = 0; index < tracks.length; ++index) {
    const track = tracks[index]
    if (
      track.id !== updatedTrack.id ||
      matchesPlaybackQueueSnapshot(track, {
        ...snapshot,
        queuePlaybackOrigin: track.queuePlaybackOrigin
      })
    )
      continue
    updated ??= tracks.slice()
    updated[index] = preserveQueueEntryContext(snapshot, track)
  }
  return updated ?? tracks
}

// Explicit field reads keep version validation inexpensive on large queues.
export function matchesPlaybackQueueSnapshot(track: Track, snapshot: Track): boolean {
  return (
    track.id === snapshot.id &&
    queuePlaybackOriginsMatch(track.queuePlaybackOrigin, snapshot.queuePlaybackOrigin) &&
    track.title === snapshot.title &&
    track.artist === snapshot.artist &&
    (track.artists === snapshot.artists ||
      (track.artists?.length === snapshot.artists?.length &&
        !!track.artists?.every(
          (artist, i) =>
            artist.id === snapshot.artists![i].id && artist.name === snapshot.artists![i].name
        ))) &&
    track.album === snapshot.album &&
    track.albumId === snapshot.albumId &&
    track.albumArtist === snapshot.albumArtist &&
    track.filePath === snapshot.filePath &&
    track.fileName === snapshot.fileName &&
    track.dir === snapshot.dir &&
    track.subTrack === snapshot.subTrack &&
    (track.cueRange === snapshot.cueRange ||
      (!!track.cueRange &&
        !!snapshot.cueRange &&
        track.cueRange.startSeconds === snapshot.cueRange.startSeconds &&
        track.cueRange.endSeconds === snapshot.cueRange.endSeconds &&
        track.cueRange.pregapSeconds === snapshot.cueRange.pregapSeconds &&
        track.cueRange.virtualPregapSeconds === snapshot.cueRange.virtualPregapSeconds &&
        track.cueRange.sourcePregapSeconds === snapshot.cueRange.sourcePregapSeconds)) &&
    track.cueSheetPath === snapshot.cueSheetPath &&
    track.cueEncoding === snapshot.cueEncoding &&
    track.duration === snapshot.duration &&
    track.size === snapshot.size &&
    track.cover === snapshot.cover &&
    (track.coverSource ?? null) === snapshot.coverSource &&
    track.source === snapshot.source &&
    track.ncmSongId === snapshot.ncmSongId &&
    track.networkSource === snapshot.networkSource &&
    (track.streamUrl ?? null) === snapshot.streamUrl &&
    track.streamQuality === snapshot.streamQuality &&
    track.format === snapshot.format &&
    track.sampleRate === snapshot.sampleRate &&
    track.bitrate === snapshot.bitrate &&
    track.bitDepth === snapshot.bitDepth &&
    track.bpm === snapshot.bpm &&
    track.replayGainTrackGainDb === snapshot.replayGainTrackGainDb &&
    track.replayGainAlbumGainDb === snapshot.replayGainAlbumGainDb &&
    track.replayGainTrackPeak === snapshot.replayGainTrackPeak &&
    track.replayGainAlbumPeak === snapshot.replayGainAlbumPeak &&
    track.r128TrackGainDb === snapshot.r128TrackGainDb &&
    track.r128AlbumGainDb === snapshot.r128AlbumGainDb
  )
}

/** One retained lightweight queue version; mutable library lists are checked too. */
export function createPlaybackQueueSnapshotCache() {
  let snapshots: Track[] | null = null
  let sourceEntryIds: (string | undefined)[] = []
  return (tracks: readonly Track[]): Track[] => {
    const unchanged =
      snapshots?.length === tracks.length &&
      tracks.every((track, index) => {
        const snapshot = snapshots![index]!
        if (track.queueEntryId !== sourceEntryIds[index]) return false
        return matchesPlaybackQueueSnapshot(track, snapshot)
      })
    if (!unchanged) {
      snapshots = toPlaybackQueueSnapshots(tracks)
      sourceEntryIds = tracks.map((track) => track.queueEntryId)
    }
    return snapshots!
  }
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
