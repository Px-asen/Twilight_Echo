import type { Track } from '../types/music'
import {
  getRecordingTrackKey as getLogicalTrackKey,
  preferredSourceKey
} from '@renderer/utils/logicalTrackModel.ts'
import { versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import {
  canShareTrackIdentity,
  compareSourceVariants,
  getTrackSource,
  toSourceVariant,
  type SourceVariant
} from './logicalTrackModel.ts'

export interface AggregatePlaylistLike {
  kind?: string
}

export interface AggregatePlaylistOrderLike {
  pinnedAt?: string | null
  createdAt: string
  updatedAt?: string
}

export interface AggregateRow {
  anchorTrackId: string
  title: string
  artist: string
  album: string
  allVariants: SourceVariant[]
  visibleVariants: SourceVariant[]
  selectedVariant: SourceVariant
  variantPinned: boolean
  preferenceUnavailable: boolean
}

export interface AggregateSourceCount {
  source: string
  count: number
  hidden: boolean
}

export interface BuildAggregateRowsInput {
  tracks: Track[]
  hiddenSources?: string[]
  variantPreferences?: Record<string, string>
}

export function isAggregatePlaylist(playlist: AggregatePlaylistLike): boolean {
  return playlist.kind === 'aggregate'
}

export function sortAggregatePlaylists<T extends AggregatePlaylistOrderLike>(playlists: T[]): T[] {
  return playlists
    .map((playlist, index) => ({ playlist, index }))
    .sort((left, right) => {
      const leftPinned = left.playlist.pinnedAt || ''
      const rightPinned = right.playlist.pinnedAt || ''
      if (leftPinned && rightPinned && leftPinned !== rightPinned) {
        return rightPinned.localeCompare(leftPinned)
      }
      if (!!leftPinned !== !!rightPinned) return leftPinned ? -1 : 1
      const leftTouched = left.playlist.updatedAt || left.playlist.createdAt || ''
      const rightTouched = right.playlist.updatedAt || right.playlist.createdAt || ''
      if (leftTouched !== rightTouched) return rightTouched.localeCompare(leftTouched)
      return left.index - right.index
    })
    .map((entry) => entry.playlist)
}

export function buildAggregateRows({
  tracks,
  hiddenSources = [],
  variantPreferences = {}
}: BuildAggregateRowsInput): AggregateRow[] {
  const hidden = new Set(hiddenSources)
  const rows: AggregateRow[] = []

  for (const group of groupTracksByRecording(tracks)) {
    const allVariants = group.slice().sort(compareSourceVariants)
    const anchorTrackId = allVariants.reduce(
      (anchor, variant) => (variant.track.id < anchor ? variant.track.id : anchor),
      allVariants[0].track.id
    )
    const visibleVariants = allVariants.filter((variant) => !hidden.has(variant.source))
    // 一行的所有音源都被隐藏了，这一行就整体消失。
    if (visibleVariants.length === 0) continue

    const preferred = variantPreferences[anchorTrackId]
    const pinnedVariant = preferred
      ? visibleVariants.find((variant) => variant.source === preferred)
      : undefined
    const selectedVariant = pinnedVariant ?? visibleVariants[0]

    rows.push({
      anchorTrackId,
      title: selectedVariant.track.title,
      artist: selectedVariant.track.artist,
      album: selectedVariant.track.album,
      allVariants,
      visibleVariants,
      selectedVariant,
      variantPinned: !!pinnedVariant,
      preferenceUnavailable:
        !pinnedVariant &&
        !!preferredSourceKey(selectedVariant.track) &&
        !visibleVariants.some(
          (variant) => versionSourceKey(variant.track) === preferredSourceKey(selectedVariant.track)
        )
    })
  }

  return rows
}

export function collectAggregateSources(
  tracks: Track[],
  hiddenSources: string[] = []
): AggregateSourceCount[] {
  const hidden = new Set(hiddenSources)
  const counts = new Map<string, number>()
  for (const track of tracks) {
    const source = getTrackSource(track)
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }
  // 被隐藏的音源在歌单里可能已经一首不剩，但仍要出现在筛选条上才能取消隐藏。
  for (const source of hidden) {
    if (!counts.has(source)) counts.set(source, 0)
  }
  return Array.from(counts.entries())
    .map(([source, count]) => ({ source, count, hidden: hidden.has(source) }))
    .sort((left, right) => {
      if (left.source === right.source) return 0
      if (left.source === 'local') return -1
      if (right.source === 'local') return 1
      return left.source.localeCompare(right.source, 'en')
    })
}

export function resolveAggregateQueue(rows: AggregateRow[]): Track[] {
  return rows.filter((row) => !row.preferenceUnavailable).map((row) => row.selectedVariant.track)
}

export function toggleHiddenSource(hiddenSources: string[], source: string): string[] {
  return hiddenSources.includes(source)
    ? hiddenSources.filter((item) => item !== source)
    : [...hiddenSources, source]
}

function groupTracksByRecording(tracks: Track[]): SourceVariant[][] {
  const groups: SourceVariant[][] = []
  const groupsByKey = new Map<string, SourceVariant[][]>()

  for (const track of tracks) {
    const variant = toSourceVariant({ track })
    const key = getLogicalTrackKey(track)
    const candidates = groupsByKey.get(key)
    const existing = candidates?.find((group) =>
      group.every((member) => canShareTrackIdentity(member.track, track))
    )
    if (existing) {
      existing.push(variant)
      continue
    }
    const nextGroup = [variant]
    groups.push(nextGroup)
    if (candidates) candidates.push(nextGroup)
    else groupsByKey.set(key, [nextGroup])
  }

  return groups
}
