import type { Track } from '@renderer/types/music'

export type StreamingTrackSort = 'default' | 'title' | 'artist' | 'album' | 'duration'
export type StreamingSortDirection = 'asc' | 'desc'

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function indexStreamingTracks(tracks: readonly Track[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const track of tracks) {
    index.set(track.id, `${track.title}\n${track.artist}\n${track.album ?? ''}`.toLocaleLowerCase())
  }
  return index
}

export function buildStreamingTrackView(
  tracks: readonly Track[],
  index: ReadonlyMap<string, string>,
  query: string,
  sort: StreamingTrackSort,
  direction: StreamingSortDirection
): Track[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const result: Track[] = []
  for (const track of tracks) {
    if (terms.length && !terms.every((term) => index.get(track.id)?.includes(term))) continue
    result.push(track)
  }
  if (sort !== 'default') {
    const sign = direction === 'asc' ? 1 : -1
    result.sort(
      (left, right) =>
        sign *
        (sort === 'duration'
          ? (Number(left.duration) || 0) - (Number(right.duration) || 0)
          : collator.compare(left[sort] ?? '', right[sort] ?? ''))
    )
  }
  return result
}
