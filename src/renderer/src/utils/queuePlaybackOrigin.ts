import type { Track, QueuePlaybackOrigin } from '../types/music'
import { cloneQueuePlaybackOrigin, isQueuePlaybackOrigin } from '../../../shared/queueWorkspace.ts'

export interface StreamingCollectionNavigationRequest {
  key: number
  origin: Extract<QueuePlaybackOrigin, { scope: 'provider' }>
}

export function resolveQueuePlaybackOrigin(
  track: Pick<Track, 'queuePlaybackOrigin'> | null | undefined
): { label: string; target: QueuePlaybackOrigin } | null {
  const origin = track?.queuePlaybackOrigin
  if (!isQueuePlaybackOrigin(origin)) return null
  return { label: `${origin.kind === 'album' ? '专辑' : '歌单'} · ${origin.name}`, target: origin }
}

export function withQueuePlaybackOrigin(
  track: Track,
  origin: QueuePlaybackOrigin | null | undefined
): Track {
  return { ...track, queuePlaybackOrigin: cloneQueuePlaybackOrigin(origin) }
}

/** Metadata rematches change the audio identity, while this occurrence keeps its queue context. */
export function preserveQueueEntryContext(
  replacement: Track,
  entry: Pick<Track, 'queueEntryId' | 'queuePlaybackOrigin'>
): Track {
  return {
    ...replacement,
    queueEntryId: entry.queueEntryId,
    queuePlaybackOrigin: entry.queuePlaybackOrigin
  }
}

export function queuePlaybackOriginsMatch(
  left: QueuePlaybackOrigin | undefined,
  right: QueuePlaybackOrigin | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.kind === right.kind &&
      left.scope === right.scope &&
      left.id === right.id &&
      left.name === right.name &&
      (left.scope !== 'provider' ||
        (right.scope === 'provider' && left.providerId === right.providerId)))
  )
}
