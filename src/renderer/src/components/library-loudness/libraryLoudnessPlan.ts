import type { Track } from '@renderer/types/music.ts'
import type { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import { getTrackSource } from '@renderer/utils/logicalTrackModel.ts'
import {
  MAX_LOUDNESS_ALBUM_TRACKS,
  MAX_LOUDNESS_BATCH_TRACKS,
  type LoudnessInputGroup,
  type LoudnessInputTrack
} from '../../../../shared/libraryLoudness.ts'

export type LoudnessAlbum = ReturnType<typeof useMusicStore>['albums']['value'][number]

const albumIndexes = new WeakMap<readonly LoudnessAlbum[], Map<string, LoudnessAlbum>>()

export function buildLibraryLoudnessPlan(
  selection: readonly Track[],
  albums: readonly LoudnessAlbum[],
  mode: 'track' | 'album'
): { groups: LoudnessInputGroup[]; trackCount: number; skipped: number; error: string } {
  const groups: LoudnessInputGroup[] = []
  const selectedIds = new Set<string>()
  const albumIds = new Set<string>()
  let skipped = 0
  let trackCount = 0
  let albumIndex = albumIndexes.get(albums)
  if (mode === 'album' && !albumIndex) {
    albumIndex = new Map()
    for (const album of albums) {
      for (const track of album.tracks) albumIndex.set(track.id, album)
    }
    albumIndexes.set(albums, albumIndex)
  }
  for (const track of selection) {
    if (selectedIds.has(track.id)) continue
    selectedIds.add(track.id)
    if (getTrackSource(track) !== 'local') {
      skipped++
      continue
    }
    if (mode === 'track') {
      groups.push({
        id: `track:${track.id}`,
        title: track.title.slice(0, 1024),
        mode,
        tracks: [inputTrack(track)]
      })
      trackCount++
    } else {
      const album = albumIndex?.get(track.id)
      if (!album?.id) {
        skipped++
        continue
      }
      if (albumIds.has(album.id)) continue
      albumIds.add(album.id)
      if (album.tracks.length > MAX_LOUDNESS_ALBUM_TRACKS)
        return {
          groups: [],
          trackCount: 0,
          skipped,
          error: `「${album.name}」超过单张专辑 256 首的上限，请改用曲目模式`
        }
      groups.push({
        id: `album:${album.id}`,
        title: album.name.slice(0, 1024),
        mode,
        tracks: album.tracks.map(inputTrack)
      })
      trackCount += album.tracks.length
    }
    if (trackCount > MAX_LOUDNESS_BATCH_TRACKS)
      return { groups: [], trackCount, skipped, error: '单次最多分析 10,000 首，请缩小选择范围' }
  }
  return { groups, trackCount, skipped, error: '' }
}

function inputTrack(track: Track): LoudnessInputTrack {
  return {
    id: track.id,
    title: track.title.slice(0, 1024),
    filePath: track.filePath,
    ...(track.cueRange ? { cueRange: { ...track.cueRange } } : {}),
    ...(track.subTrack ? { subTrack: track.subTrack } : {})
  }
}
