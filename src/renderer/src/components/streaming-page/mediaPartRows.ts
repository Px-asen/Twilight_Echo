import type { Track } from '../../types/music'

export const MEDIA_PART_PAGE_SIZE = 20
export interface PartGroup {
  id: string
  title: string
  count: number
  total?: number
  playing?: boolean
  tracks: Array<{ track: Track; index: number }>
}
export interface PartGroupState {
  expanded: boolean
  page: number
}
export type MediaPartRow =
  | { kind: 'track'; key: string; track: Track; index: number; grouped: boolean }
  | { kind: 'group'; key: string; group: PartGroup; expanded: boolean }
  | { kind: 'pager'; key: string; group: PartGroup; page: number; pageCount: number }

/** Preserve provider identities and queue indices even when the view is folded or filtered. */
export function buildMediaPartRows(
  tracks: readonly Track[],
  state: Readonly<Record<string, PartGroupState>>,
  searching = false
): MediaPartRow[] {
  const groups = new Map<string, PartGroup>()
  const order: Array<PartGroup | { track: Track; index: number }> = []
  tracks.forEach((track, index) => {
    const part = track.mediaPart
    if (!part?.groupId || part.count <= 1) {
      order.push({ track, index })
      return
    }
    let group = groups.get(part.groupId)
    if (!group) {
      group = { id: part.groupId, title: part.groupTitle, count: part.count, tracks: [] }
      groups.set(part.groupId, group)
      order.push(group)
    }
    group.tracks.push({ track, index })
  })
  return order.flatMap((entry): MediaPartRow[] => {
    if ('track' in entry) return [{ kind: 'track', key: entry.track.id, ...entry, grouped: false }]
    const saved = state[entry.id]
    const expanded = saved?.expanded ?? searching
    const pageCount = Math.ceil(entry.tracks.length / MEDIA_PART_PAGE_SIZE)
    const page = Math.max(0, Math.min(saved?.page ?? 0, pageCount - 1))
    const rows: MediaPartRow[] = [
      { kind: 'group', key: `group:${entry.id}`, group: entry, expanded }
    ]
    if (expanded) {
      rows.push(
        ...entry.tracks.slice(page * MEDIA_PART_PAGE_SIZE, (page + 1) * MEDIA_PART_PAGE_SIZE).map(
          ({ track, index }): MediaPartRow => ({
            kind: 'track',
            key: track.id,
            track,
            index,
            grouped: true
          })
        )
      )
      rows.push({ kind: 'pager', key: `pager:${entry.id}`, group: entry, page, pageCount })
    }
    return rows
  })
}
