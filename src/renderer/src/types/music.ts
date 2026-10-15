import type { BpmAnalysisResult } from '../../../shared/audioEngineTypes.ts'
import type { TrackSource, TrackMetadataMatch } from '../../../shared/track.ts'
import type { LyricSource } from '../../../shared/lyricsManagement.ts'
export type { BpmTempoSegment, BpmAnalysisResult } from '../../../shared/audioEngineTypes.ts'
export type {
  BuiltInTrackSource,
  TrackSource,
  MetadataMatchConfidence,
  TrackMetadataMatch
} from '../../../shared/track.ts'
export type { LyricSource } from '../../../shared/lyricsManagement.ts'
import type { PlaybackSessionData } from '../../../shared/playbackSession.ts'
import type { NcmPlaybackQuality } from './settings'
import type { CueRange, ParsedCueSheet } from '../../../shared/cue.ts'
import type { NetworkEntry } from '../../../shared/networkSources.ts'
import type { QueuePlaybackOrigin } from '../../../shared/queueWorkspace.ts'
export type { QueuePlaybackOrigin } from '../../../shared/queueWorkspace.ts'

/**
 * 单个歌手的 provider 侧身份。`artist` 展示串是同名歌手无法区分的，跳转歌手页
 * 必须走这里的 id。顺序与 `artist` 的 ' / ' 分段严格一致，`id` 缺失时也保留条目，
 * 否则首位歌手会错位到第二位的 id 上。
 */
export interface TrackArtistRef {
  id?: string | number
  name: string
}

export interface Track {
  id: string
  /**
   * Stable playback-queue entry identity. A track may occur more than once in
   * a queue, so UI commands must not use the provider track id as a row key.
   */
  queueEntryId?: string
  /** Collection selected when this entry joined the queue; never inferred from album text. */
  queuePlaybackOrigin?: QueuePlaybackOrigin
  title: string
  artist: string
  /** 结构化歌手身份（流媒体 provider 提供）；本地扫描曲目没有这个概念。 */
  artists?: TrackArtistRef[]
  album: string
  /** Local release tag, with year/month/day precision preserved. */
  releaseDate?: string
  /** Primary genre tag; multi-value tags keep the first non-empty entry. */
  genre?: string | null
  /** Stable album owner for grouping compilation and guest-artist tracks. */
  albumArtist?: string
  /** Provider or scanner album identifier when one is available. */
  albumId?: string
  /** Disc index from tags (1-based). Used for album order. */
  discNumber?: number
  /** Track index on the disc from tags (1-based). Used for album order. */
  trackNumber?: number
  filePath: string
  fileName: string
  dir?: string
  subTrack?: string
  /** Explicit file segment for a single-file CUE sheet. Positions are relative to filePath. */
  cueRange?: CueRange
  cueSheetPath?: string
  cueEncoding?: ParsedCueSheet['encoding']
  duration: number
  size: number
  cover: string | null
  /** Optional bounded thumbnail URL for list/grid rendering. */
  coverSmall?: string | null
  coverSmallSource?: string | null
  /**
   * Durable remote cover origin (http/https). When `cover` is a twilight-media
   * grant that dies after process restart, display code re-grants from this.
   */
  coverSource?: string | null
  lyrics: string | null
  translatedLyrics?: string | null
  romanizedLyrics?: string | null
  lyricsSource?: LyricSource | null
  translatedLyricsSource?: LyricSource | null
  romanizedLyricsSource?: LyricSource | null
  metadataMatch?: TrackMetadataMatch | null
  source?: TrackSource
  ncmSongId?: number
  /** 网络源条目（统一搜索结果使用；播放时经 resolvePlayback 解析出可播地址）。 */
  networkSource?: { profileId: string; entry: NetworkEntry }
  streamUrl?: string | null
  streamQuality?: NcmPlaybackQuality
  format?: string
  sampleRate?: number
  bitrate?: number
  bitDepth?: number
  /** Versioned acoustic fingerprint extracted from a trusted media tag, when available. */
  audioFingerprint?: { algorithm: string; value: string }
  bpm?: number
  bpmAnalysis?: BpmAnalysisResult
  /** Unix time in milliseconds when this file first entered the local library. */
  addedAt?: number
  /** ReplayGain track gain in dB (from tags; cold-start track mode). */
  replayGainTrackGainDb?: number
  /** ReplayGain album gain in dB. */
  replayGainAlbumGainDb?: number
  /** ReplayGain track peak (linear ratio or dBTP-equivalent tag value). */
  replayGainTrackPeak?: number
  /** ReplayGain album peak. */
  replayGainAlbumPeak?: number
  /** R128 track gain in dB (EBU R128 / Opus style tags). */
  r128TrackGainDb?: number
  /** R128 album gain in dB. */
  r128AlbumGainDb?: number
}

export type PlaybackSession = PlaybackSessionData<Track>

export { SUPPORTED_EXTENSIONS } from '../../../shared/audioFormats.ts'
