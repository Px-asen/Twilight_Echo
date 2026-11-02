import type { PlaybackInfo, AudioEngineQueueItem, BpmAnalysisResult } from './audioEngineTypes.ts'
import type { LibraryPage, LibraryQueuePage } from './libraryDatabase.ts'
import type { TrackData } from './track.ts'

/** Display identity, not an authorization to open a source. Artwork, lyrics and
 * technical diagnostics use their own controlled, bounded query/subscription. */
export type CoreTrackView = Pick<
  TrackData,
  | 'id'
  | 'queueEntryId'
  | 'title'
  | 'artist'
  | 'artists'
  | 'album'
  | 'albumId'
  | 'source'
  | 'ncmSongId'
  | 'duration'
  | 'size'
  | 'format'
  | 'sampleRate'
  | 'bitrate'
  | 'bitDepth'
  | 'discNumber'
  | 'trackNumber'
  | 'releaseDate'
  | 'subTrack'
  | 'genre'
  | 'albumArtist'
  | 'addedAt'
  | 'bpm'
  | 'cueRange'
  | 'mediaPart'
  | 'isrc'
> & { bpmAnalysis?: Omit<BpmAnalysisResult, 'tempoMap'> }

export const CORE_PLAYBACK_FIELDS = [
  'streamTitle',
  'dspActive',
  'gaplessBlockedReason',
  'state',
  'position',
  'duration',
  'volume',
  'playbackRate',
  'playMode',
  'queueIndex',
  'queueToken',
  'queueRevision',
  'upcomingQueueIndex',
  'requestedConfigRevision',
  'appliedConfigRevision',
  'nativePlaybackActive',
  'codec',
  'bitrate',
  'sourceSampleRate',
  'sourceChannels',
  'sourceBitDepth',
  'decodedSampleRate',
  'decodedBitDepth',
  'decodedChannels',
  'decodedSampleFormat',
  'outputBackend',
  'actualSampleRate',
  'actualBitDepth',
  'actualChannels',
  'outputPerfect',
  'sourceExact',
  'pcmPassthrough',
  'isDsd',
  'dsdMode',
  'dsdRate',
  'actualDsdRate',
  'dsdRatePolicy',
  'dsdConversion',
  'dsdConversionReason',
  'gaplessActive',
  'preloadReady',
  'crossfadeActive',
  'crossfadeSeconds',
  'crossfadeMixActive',
  'crossfadeEffectiveSeconds',
  'crossfadeCurve',
  'crossfadeBlockedReason',
  'autoMixMode',
  'autoMixState',
  'autoMixDurationSeconds',
  'autoMixStemEnhanced',
  'autoMixDecodeMs',
  'autoMixPrepareMs',
  'autoMixReason',
  'autoMixStrategy',
  'autoMixPlanId',
  'autoMixOutputSeconds',
  'autoMixNextSourceSeconds',
  'renderPerformance',
  'clipCount'
] as const satisfies readonly (keyof PlaybackInfo)[]
export type CoreUpcomingTrack = Pick<
  AudioEngineQueueItem,
  'id' | 'queueEntryId' | 'title' | 'artist' | 'album' | 'duration' | 'cueRange'
>
export type CorePlaybackView = Pick<PlaybackInfo, (typeof CORE_PLAYBACK_FIELDS)[number]> & {
  naturalBoundaries?: PlaybackInfo['naturalBoundaries']
  upcomingTrack: CoreUpcomingTrack | null
}
export type CoreLibraryPage = Omit<LibraryPage, 'tracks'> & {
  tracks: CoreTrackView[]
  /** Original configured identities, parallel to a playlist display page. */
  definitionIds?: string[]
}
export type CoreQueuePage = Omit<LibraryQueuePage, 'items'> & {
  items: Array<Omit<LibraryQueuePage['items'][number], 'track'> & { track: CoreTrackView | null }>
}
