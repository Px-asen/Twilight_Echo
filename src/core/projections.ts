import type { PlaybackInfo } from '../shared/audioEngineTypes.ts'
import type { LibraryTrackRecord } from '../shared/libraryDatabase.ts'
import {
  CORE_PLAYBACK_FIELDS,
  type CorePlaybackView,
  type CoreTrackView
} from '../shared/coreViews.ts'
import type { TrackData } from '../shared/track.ts'
import { libraryTrack } from './playback/libraryTrack.ts'
import { normalizeCueRange } from '../shared/cue.ts'
import { redactSensitiveText } from '../shared/errors/redactSensitiveText.ts'
import type { CoreScanStatus } from '../shared/coreScan.ts'

const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.slice(0, 32_768) : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const cueRange = (range: unknown) => normalizeCueRange(range) ?? undefined

function projectBpm(analysis: TrackData['bpmAnalysis']): CoreTrackView['bpmAnalysis'] {
  if (
    !analysis ||
    number(analysis.bpm) === undefined ||
    number(analysis.confidence) === undefined ||
    number(analysis.algorithmVersion) === undefined ||
    typeof analysis.analyzedAt !== 'string'
  )
    return undefined
  return {
    bpm: analysis.bpm,
    confidence: analysis.confidence,
    source: 'analyzed',
    analyzedAt: analysis.analyzedAt.slice(0, 128),
    algorithmVersion: analysis.algorithmVersion,
    variableTempo: typeof analysis.variableTempo === 'boolean' ? analysis.variableTempo : undefined,
    bpmRange:
      Array.isArray(analysis.bpmRange) &&
      number(analysis.bpmRange[0]) !== undefined &&
      number(analysis.bpmRange[1]) !== undefined
        ? [analysis.bpmRange[0], analysis.bpmRange[1]]
        : undefined
  }
}

export function projectCoreError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Source authorization stays private even when a native/provider error
  // embeds the entire signed URL, userinfo or cookie in its message.
  return redactSensitiveText(
    message.replace(/\b(?:https?|smb|sftp|ftp):\/\/[^\s"'<>]+/gi, '<media-url>')
  ).slice(0, 4096)
}
export function projectCoreScan(status: CoreScanStatus | null): CoreScanStatus | null {
  return status ? { ...status, error: status.error ? projectCoreError(status.error) : '' } : null
}

/** All public track paths use the same allowlist, including queue/library
 * queries. Never spread provider extensions or cached authorization metadata. */
export function projectCoreTrack(
  record: TrackData | LibraryTrackRecord,
  occurrenceId?: string
): CoreTrackView {
  const track = libraryTrack({ ...record })
  return {
    id: track.id,
    queueEntryId:
      occurrenceId ?? (typeof record.queueEntryId === 'string' ? record.queueEntryId : undefined),
    title: track.title.slice(0, 32_768),
    artist: track.artist.slice(0, 32_768),
    album: track.album.slice(0, 32_768),
    albumId: string(track.albumId),
    artists: Array.isArray(track.artists)
      ? track.artists
          .slice(0, 128)
          .filter((artist) => artist && typeof artist.name === 'string')
          .map((artist) => ({
            id: typeof artist.id === 'number' ? number(artist.id) : string(artist.id),
            name: artist.name.slice(0, 32_768)
          }))
      : undefined,
    source: string(track.source),
    ncmSongId: number(track.ncmSongId),
    mvId: typeof track.mvId === 'string' && track.mvId.trim() ? track.mvId.trim().slice(0, 128) : undefined,
    duration: track.duration,
    size: track.size,
    format: string(track.format),
    sampleRate: number(track.sampleRate),
    bitrate: number(track.bitrate),
    bitDepth: number(track.bitDepth),
    discNumber: number(track.discNumber),
    trackNumber: number(track.trackNumber),
    releaseDate: string(track.releaseDate),
    subTrack: string(track.subTrack),
    genre: track.genre === null ? null : string(track.genre),
    albumArtist: string(track.albumArtist),
    addedAt: number(track.addedAt),
    bpm: number(track.bpm),
    bpmAnalysis: projectBpm(track.bpmAnalysis),
    isrc: string(track.isrc),
    cueRange: cueRange(track.cueRange),
    mediaPart:
      track.mediaPart &&
      typeof track.mediaPart.groupId === 'string' &&
      typeof track.mediaPart.groupTitle === 'string' &&
      typeof track.mediaPart.title === 'string' &&
      number(track.mediaPart.index) !== undefined &&
      number(track.mediaPart.count) !== undefined
        ? {
            groupId: track.mediaPart.groupId.slice(0, 32_768),
            groupTitle: track.mediaPart.groupTitle.slice(0, 32_768),
            title: track.mediaPart.title.slice(0, 32_768),
            index: track.mediaPart.index,
            count: track.mediaPart.count
          }
        : undefined
  }
}

export function projectCorePlayback(info: PlaybackInfo): CorePlaybackView {
  const result = Object.fromEntries(CORE_PLAYBACK_FIELDS.map((key) => [key, info[key]])) as Pick<
    CorePlaybackView,
    (typeof CORE_PLAYBACK_FIELDS)[number]
  >
  const next = info.upcomingTrack
  return {
    ...result,
    streamTitle: info.streamTitle ? projectCoreError(info.streamTitle) : info.streamTitle,
    gaplessBlockedReason: info.gaplessBlockedReason ? projectCoreError(info.gaplessBlockedReason) : info.gaplessBlockedReason,
    crossfadeBlockedReason: info.crossfadeBlockedReason ? projectCoreError(info.crossfadeBlockedReason) : info.crossfadeBlockedReason,
    autoMixReason: info.autoMixReason ? projectCoreError(info.autoMixReason) : info.autoMixReason,
    naturalBoundaries: info.naturalBoundaries
      ? {
          trackSerial: info.naturalBoundaries.trackSerial,
          queueSerial: info.naturalBoundaries.queueSerial,
          trackTimeMs: info.naturalBoundaries.trackTimeMs,
          queueTimeMs: info.naturalBoundaries.queueTimeMs
        }
      : undefined,
    upcomingTrack: next
      ? {
          id: next.id,
          queueEntryId: next.queueEntryId,
          title: next.title,
          artist: next.artist,
          album: next.album,
          duration: next.duration,
          cueRange: cueRange(next.cueRange)
        }
      : null
  }
}
