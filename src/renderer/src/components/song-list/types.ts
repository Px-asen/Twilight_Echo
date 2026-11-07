import type { Track } from '../../types/music'
import type { LibraryPlaylistSourceSummary } from '../../../../shared/libraryDatabase'

export type LocalTransitionName = `local-${import('../../app/motion/policy').PageMotionName}`

export type GridItem = {
  imported?: import('../../../../shared/corePlaylists.ts').CorePlaylistDescriptor['imported']
  id?: string
  name: string
  count?: number
  trackCount?: number
  sourceSummary?: LibraryPlaylistSourceSummary
  cover?: string | null
  coverSource?: string | null
  releaseDate?: string
  metadataReleaseDate?: import('../../../../shared/libraryDatabase.ts').LibraryCollectionSummary['metadataReleaseDate']
  duration?: number
  genre?: string | null
  compilation?: boolean
  path?: string
  artist?: string
  tracks?: Track[]
  trackIds?: string[]
  trackSnapshots?: Record<string, Track>
  isDefault?: boolean
}

export type PlaylistActions = {
  removeTrack: (trackId: string) => void
  addToPlaylist: (playlistName: string, trackId: string, trackSnapshot?: Track) => void
  removeFromPlaylist: (playlistName: string, trackId: string) => void
  rematchTrack?: (track: Track) => Promise<void> | void
  rematchMetadata?: (track: Track) => Promise<void> | void
  clearMetadataMatch?: (track: Track) => Promise<void> | void
  createPlaylist: (name: string) => void
  deletePlaylist: (playlistId: string) => void
  playNext?: (track: Track) => void
  viewArtist?: (track: Track) => void
  viewAlbum?: (track: Track) => void
  /** 把右键选中的曲目加进某个聚合歌单。 */
  addToAggregatePlaylist?: (playlistId: string) => void
  /** 打开「新建聚合歌单并加入」对话框。 */
  createAggregatePlaylist?: () => void
}

export type TrackPlayback = {
  playTrack: (track: Track, queue?: Track[]) => void
}
