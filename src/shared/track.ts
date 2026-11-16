import type { CueRange, ParsedCueSheet } from './cue.ts'
import type { BpmAnalysisResult } from './audioEngineTypes.ts'
import type { NcmPlaybackQuality } from './appSettings.ts'
import type { LyricSource } from './lyricsManagement.ts'
import type { NetworkEntry } from './networkSources.ts'
import type { TrackIdentityTags } from './trackIdentification.ts'

export type BuiltInTrackSource = 'local' | 'ncm'
export type TrackSource = BuiltInTrackSource | (string & {})
export type MetadataMatchConfidence = 'high' | 'medium'

export interface TrackMetadataMatch {
  providerId: string
  trackId: string
  confidence: MetadataMatchConfidence
  score: number
}

export interface TrackArtistRef {
  id?: string | number
  name: string
}

export interface TrackData {
  /** Source observations retained for identity matching, independent of display enrichment. */
  identityTags?: TrackIdentityTags
  isrc?: string
  id: string
  /** An occurrence is not a track ID: duplicate queue entries retain their identity. */
  queueEntryId?: string
  /** Occurrence routing intent, not a music tag. Explicit source selection must not rematch. */
  sourceSelection?: 'explicit'
  title: string
  mediaPart?: { groupId: string; groupTitle: string; title: string; index: number; count: number }
  artist: string
  artists?: TrackArtistRef[]
  album: string
  releaseDate?: string
  genre?: string | null
  albumArtist?: string
  albumId?: string
  filePath: string
  fileName: string
  dir?: string
  subTrack?: string
  /** Logical source segment for a single-file CUE track. */
  cueRange?: CueRange
  cueSheetPath?: string
  cueEncoding?: ParsedCueSheet['encoding']
  duration: number
  size: number
  cover: string | null
  coverSource?: string | null
  coverSmall?: string | null
  coverSmallSource?: string | null
  lyrics: string | null
  translatedLyrics?: string | null
  romanizedLyrics?: string | null
  lyricsSource?: LyricSource | null
  translatedLyricsSource?: LyricSource | null
  romanizedLyricsSource?: LyricSource | null
  metadataMatch?: TrackMetadataMatch | null
  source?: TrackSource
  ncmSongId?: number
  /** Optional provider MV identifier (e.g. NetEase mvid or Bilibili bvid). */
  mvId?: string
  networkSource?: { profileId: string; entry: NetworkEntry }
  streamUrl?: string | null
  streamQuality?: NcmPlaybackQuality
  format?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  audioFingerprint?: { algorithm: string; value: string }
  addedAt?: number
  bpm?: number
  bpmAnalysis?: BpmAnalysisResult
  discNumber?: number
  trackNumber?: number
  replayGainTrackGainDb?: number
  replayGainAlbumGainDb?: number
  replayGainTrackPeak?: number
  replayGainAlbumPeak?: number
  r128TrackGainDb?: number
  r128AlbumGainDb?: number
}
