import type { LibraryPlaybackQueueReference } from './playbackSession.ts'
import type { LibraryQueueSnapshot } from './libraryDatabase.ts'

/** Only Core can establish this context by reading the authenticated NCM library. */
export interface CoreHeartContext {
  queueId: string
  likedPlaylistId: number
  baseQueue?: LibraryPlaybackQueueReference
}
export interface CoreHeartState {
  available: boolean
  active: boolean
  loading: boolean
  remaining: number
  error: string | null
}
export interface CoreLikedPlayback {
  selectedId?: string
  play?: boolean
  /** Shuffle the complete authenticated list; mutually exclusive with selectedId. */
  shuffle?: boolean
}
/** Private database capability; preserves holes and queue-scoped occurrence IDs. */
export interface CoreHeartQueueApi {
  restoreHeartBaseQueue(
    base: LibraryPlaybackQueueReference,
    selectedTrackId: string
  ): Promise<{ queue: LibraryQueueSnapshot; matched: boolean }>
}
