import type { Track } from '@renderer/types/music'
import { cachedSourceMatchesTrack, getTrackAudioSource } from '@renderer/utils/playerTrackUtils.ts'

export function findNativeQueueTrackIndex(
  queue: readonly Track[],
  currentIndex: number,
  info: { queueIndex: number; source: string },
  mappedTrackId: string | undefined,
  delegated: boolean
): number {
  const source = info.source?.trim() ?? ''
  const matches = (track: Track): boolean =>
    !!source &&
    (track.id === mappedTrackId ||
      track.id === source ||
      getTrackAudioSource(track) === source ||
      cachedSourceMatchesTrack(track, source))
  if (delegated && Number.isInteger(info.queueIndex)) {
    const indexed = queue[info.queueIndex]
    if (indexed && (!source || matches(indexed))) return info.queueIndex
  }
  const current = queue[currentIndex]
  if (current && matches(current)) return currentIndex
  return queue.findIndex(matches)
}
