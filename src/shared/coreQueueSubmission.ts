import type { CueRange } from './cue.ts'
import type { TrackData } from './track.ts'

/** Display hints are not source authority. Core looks up local/network/stream
 * identities and resolves provider URLs itself. Each array position is a new occurrence. */
export type CoreQueueTrackInput =
  | { kind: 'occurrence'; queueId: string; revision: number; occurrenceId: string }
  | {
      kind: 'local'
      id: string
      fallback?: Pick<TrackData, 'filePath' | 'title' | 'artist' | 'album' | 'duration'> & {
        subTrack?: string
        cueRange?: CueRange
      }
    }
  | {
      kind: 'provider'
      track: Pick<TrackData, 'id' | 'title' | 'artist' | 'album' | 'duration' | 'ncmSongId'> & {
        source: string
        cover?: string | null
      }
    }
  | { kind: 'network'; revision: number; profileId: string; entryId: string }
  | { kind: 'stream'; source: 'radio' | 'podcast'; id: string }

export const MAX_PROVIDER_QUEUE_COVER_LENGTH = 2 * 1024 * 1024

/** Clients may only forward already-issued media/cache handles or bounded inline
 * raster artwork — never raw remote URLs or local filesystem paths. */
export function isAuthorizedProviderQueueCover(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_PROVIDER_QUEUE_COVER_LENGTH)
    return false
  if (value.includes('\0')) return false
  return (
    /^twilight-media:\/\/image\/[a-zA-Z0-9_-]{1,256}$/.test(value) ||
    /^cover:\/\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)(?:[?#][^\0\r\n]{0,256})?$/i.test(
      value
    ) ||
    /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-zA-Z0-9+/=]+$/i.test(value)
  )
}

export type CoreQueueSubmitCommand =
  | { kind: 'begin'; selectedIndex: number; position?: number; play?: boolean }
  | { kind: 'append'; id: string; sequence: number; items: CoreQueueTrackInput[] }
  | { kind: 'commit'; id: string; sequence: number }
  | { kind: 'abort'; id: string }

export interface CoreQueueSubmitReply {
  id: string
  state: 'building' | 'committed' | 'aborted'
  sequence: number
  total: number
}
export interface CoreQueueInsert {
  id: string
  revision: number
  items: CoreQueueTrackInput[]
  afterEntryId?: string
  beforeEntryId?: string
}
