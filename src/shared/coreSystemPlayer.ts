import type { MiniPlayerCommand } from './miniPlayer.ts'
import type { CoreLyricsCurrent, CoreLyricsContent, CoreLyricsState } from './coreLyrics.ts'
import type {
  MediaProviderMvQuality,
  MediaProviderMvSource,
  MediaProviderMvStream
} from './providerMv.ts'

export type CoreSystemPlaybackAction =
  | MiniPlayerCommand
  | { type: 'stop' }
  | { type: 'volume-step'; direction: 'volumeUp' | 'volumeDown' }
  | { type: 'queue-jump'; id: string; revision: number; index: number; occurrenceId: string }

export interface CorePlayerPresentation {
  current: CoreLyricsCurrent | null
  cover: string | null
  coverSource: string | null
  favorite: { available: boolean; liked: boolean; loading: boolean }
}

export interface CorePlayerMvRequest {
  trackId: string
  occurrenceId: string | null
  quality?: MediaProviderMvQuality
  source?: MediaProviderMvSource
  force?: boolean
}

export interface CorePlayerMvResult {
  current: CoreLyricsCurrent | null
  available: boolean
  stream: MediaProviderMvStream | null
}

export interface CoreSystemLyrics {
  state: CoreLyricsState
  content: CoreLyricsContent
}
