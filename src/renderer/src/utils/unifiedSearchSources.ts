import type { Track } from '@renderer/types/music'
import type { UnifiedSearchTrackItem } from '@renderer/utils/unifiedMusicSearch.ts'
import { getTrackSearchBlob, normalizeSearchText } from '@renderer/utils/localLibrarySearch.ts'
import {
  compareSourceVariantPriority,
  toSourceVariant,
  type SourceVariantInput
} from '@renderer/utils/logicalTrackModel.ts'
import type { NetworkEntry } from '../../../shared/networkSources.ts'

type SearchIndexEntry = { item: UnifiedSearchTrackItem; text: string }
const localIndexes = new WeakMap<readonly Track[], SearchIndexEntry[]>()

export function toSearchItem(
  track: Track,
  options: Omit<SourceVariantInput, 'track'>
): UnifiedSearchTrackItem {
  return { kind: 'track', ...toSourceVariant({ track, ...options }) }
}

export function compareSearchItems(
  left: UnifiedSearchTrackItem,
  right: UnifiedSearchTrackItem
): number {
  return (
    compareSourceVariantPriority(left, right) ||
    left.track.title.localeCompare(right.track.title, 'zh') ||
    left.track.artist.localeCompare(right.track.artist, 'zh') ||
    left.track.id.localeCompare(right.track.id)
  )
}

export function searchUnifiedLocalPage(
  tracks: readonly Track[],
  query: string,
  limit: number,
  offset: number
): { items: UnifiedSearchTrackItem[]; total: number } {
  const q = normalizeSearchText(query)
  if (!q) return { items: [], total: 0 }
  let index = localIndexes.get(tracks)
  if (!index) {
    index = tracks.map((track) => ({
      item: toSearchItem(track, { sourceName: '本地音乐', providerAvailable: true }),
      text: `${getTrackSearchBlob(track)}\u0000${normalizeSearchText(track.fileName)}`
    }))
    index.sort((left, right) => compareSearchItems(left.item, right.item))
    localIndexes.set(tracks, index)
  }
  const items: UnifiedSearchTrackItem[] = []
  let total = 0
  for (const entry of index) {
    if (!entry.text.includes(q)) continue
    if (total >= offset && items.length < limit) items.push(entry.item)
    total += 1
  }
  return { items, total }
}

export function searchUnifiedNetworkPage(
  entries: Array<{ profileName: string; entry: NetworkEntry }>,
  query: string,
  limit: number,
  offset: number
): { items: UnifiedSearchTrackItem[]; total: number } {
  const q = normalizeSearchText(query)
  const items: UnifiedSearchTrackItem[] = []
  let total = 0
  if (!q) return { items, total }
  for (const { profileName, entry } of entries) {
    const metadata = entry.metadata
    if (
      ![metadata?.title, metadata?.artist, metadata?.album, entry.name].some(
        (value) => value && normalizeSearchText(value).includes(q)
      )
    )
      continue
    if (total >= offset && items.length < limit) {
      items.push(
        toSearchItem(
          {
            id: entry.id,
            title: metadata?.title ?? entry.name.replace(/\.[^.]+$/, ''),
            artist: metadata?.artist ?? profileName,
            album: metadata?.album ?? profileName,
            filePath: '',
            fileName: entry.name,
            duration: metadata?.duration ?? 0,
            size: entry.sizeBytes ?? 0,
            cover: null,
            lyrics: null,
            source: 'network',
            format: metadata?.format,
            networkSource: { profileId: entry.profileId, entry }
          },
          { sourceName: '网络源', providerAvailable: true }
        )
      )
    }
    total += 1
  }
  return { items, total }
}
