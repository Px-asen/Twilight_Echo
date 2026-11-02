import type { CoreTrackView, CoreLibraryPage } from './coreViews.ts'
import type { TrackData } from './track.ts'
import type { Playlist } from './playlists.ts'
import type { PlaylistImportDocument } from './externalPlaylist.ts'
import type {
  ImportedPlaylistData,
  ImportedPlaylistEntry,
  ImportResolutionState
} from './externalPlaylist.ts'
import type { PlaylistPersistenceStatus, PlaylistPersistenceNotice } from './playlists.ts'
import type { PlaylistFileFormat } from './playlistLifecycle.ts'
import type { CoreQueueTrackInput } from './coreQueueSubmission.ts'

/** Read-only history membership. Its revision belongs to statistics, not saved playlists. */
export const CORE_RECENT_PLAYLIST_ID = 'core:recent'

export type CorePlaylistSummary = Pick<
  Playlist,
  'id' | 'name' | 'kind' | 'isDefault' | 'createdAt' | 'updatedAt' | 'pinnedAt'
> & {
  count: number
  imported: boolean
}
export interface CorePlaylistPage {
  revision: number
  total: number
  offset: number
  items: CorePlaylistSummary[]
}
export interface CorePlaylistEntries {
  revision: number
  total: number
  offset: number
  items: Array<{ id: string; track: CoreTrackView | null }>
}
/** Explicit domain actions. Never a property name or arbitrary store method invocation. */
export type CorePlaylistEdit =
  | { kind: 'importCreate'; document: PlaylistImportDocument }
  | { kind: 'importRefresh'; id: string; document: PlaylistImportDocument; overwrite?: boolean }
  | { kind: 'importBind'; id: string; entryId: string; track: TrackData | null }
  | { kind: 'importRemove'; id: string; entryIds: string[] }
  | { kind: 'create'; name: string; aggregate?: boolean }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'copy'; id: string; name: string }
  | { kind: 'delete'; id: string }
  | { kind: 'cover'; id: string; cover: string | null }
  | { kind: 'pin'; id: string; pinned: boolean }
  | { kind: 'hiddenSources'; id: string; sources: string[] }
  | { kind: 'variant'; id: string; anchorId: string; source: string | null }
  | { kind: 'add'; id: string; tracks: TrackData[] }
  | { kind: 'remove'; id: string; ids: string[] }
  | { kind: 'reorder'; id: string; ids: string[]; target: number }
  | { kind: 'move'; id: string; targetId: string; ids: string[] }
  | { kind: 'favorite'; tracks: TrackData[]; favorite: boolean }
export interface CorePlaylistMutation {
  revision: number
  edit: CorePlaylistEdit
}
export interface CorePlaylistRepairStatus {
  id: string
  playlistId: string
  state: 'running' | 'completed' | 'failed'
  relocated: number
  unresolved: number
  ambiguous: number
  error: string | null
}
export interface CorePlaylistViewQuery {
  query?: import('./libraryDatabase.ts').LibraryQuery
  id: string
  revision: number
  versionsRevision: number
  contentRevision?: number
  offset?: number
  limit?: number
  search?: string
  anchorId?: string
  preserveSources?: boolean
  /** Include hidden aggregate variants for a bounded maintenance read. */
  includeHiddenSources?: boolean
  variantRow?: string
  sourceCounts?: boolean
}
export interface CorePlaylistViewPage {
  viewId: string
  revision: number
  versionsRevision: number
  page: CoreLibraryPage
}
export interface CoreImportProgress {
  id: string
  generation: string
  done: number
  total: number
  running: boolean
  error: string | null
}

/** Catalog rows deliberately omit complete membership and source snapshots. */
export type CorePlaylistDescriptor = Omit<CorePlaylistSummary, 'imported'> & {
  cover?: string | null
  hiddenSources?: string[]
  imported?: Omit<ImportedPlaylistData, 'entries'> & {
    counts: Partial<Record<ImportResolutionState, number>>
  }
}
export interface CorePlaylistCatalogPage extends Omit<CorePlaylistPage, 'items'> {
  items: CorePlaylistDescriptor[]
}
export interface CorePlaylistMemberView {
  id: string
  position: number
  track: CoreTrackView | null
  imported?: Omit<ImportedPlaylistEntry, 'manualBinding' | 'resolution' | 'original'> & {
    original: Omit<ImportedPlaylistEntry['original'], 'locations'>
    resolution: Omit<ImportedPlaylistEntry['resolution'], 'track'> & { track?: CoreTrackView }
    manual: boolean
  }
}
export interface CorePlaylistMembersPage {
  revision: number
  offset: number
  total: number
  items: CorePlaylistMemberView[]
  anchorIndex?: number
}
export interface CorePlaylistState {
  revision: number
  persistence: PlaylistPersistenceStatus
  notice: PlaylistPersistenceNotice | null
  repair: CorePlaylistRepairStatus | null
}
export interface CorePlaylistQueries {
  'playlists.favorites': {
    input: { revision: number; items: CoreQueueTrackInput[] }
    output: { revision: number; contains: boolean[] }
  }
  'playlists.collection': {
    input: {
      revision: number
      versionsRevision: number
      aggregate?: boolean
      query?: import('./libraryDatabase.ts').LibraryQuery
    }
    output: import('./libraryDatabase.ts').LibraryCollectionPage
  }
  'playlists.catalog': {
    input: { revision?: number; offset?: number; limit?: number }
    output: CorePlaylistCatalogPage
  }
  'playlists.members': {
    input: {
      id: string
      revision: number
      offset?: number
      limit?: number
      search?: string
      sort?: 'playlist' | 'title' | 'artist' | 'album' | 'duration'
      anchorId?: string
    }
    output: CorePlaylistMembersPage
  }
  'playlists.membership': {
    input: { id: string; revision: number; ids: string[] }
    output: { revision: number; contains: boolean[] }
  }
  'playlists.state': { input: Record<string, never>; output: CorePlaylistState }
  'playlists.export': {
    input: { id: string; revision: number; format: PlaylistFileFormat }
    output: { contents: string; revision: number }
  }
}
export interface CorePlaylistCommands {
  'playlists.importDocument': { id: string; revision: number; fileName: string; contents: string }
  'playlists.flush': Record<string, never>
  'playlists.submit': CorePlaylistSubmitCommand
}
export type CorePlaylistPageEdit =
  | { kind: 'create'; name: string; aggregate?: boolean }
  | { kind: 'add'; id: string; external?: boolean }
  | { kind: 'remove'; id: string }
  | { kind: 'move'; id: string; targetId: string }
  | { kind: 'reorder'; id: string; target: number }
  | { kind: 'favorite'; favorite: boolean }
export interface CorePlaylistSubmitItem {
  id?: string
  input?: CoreQueueTrackInput
}
export type CorePlaylistSubmitCommand =
  | { kind: 'begin'; revision: number; edit: CorePlaylistPageEdit }
  | { kind: 'append'; id: string; sequence: number; items: CorePlaylistSubmitItem[] }
  | { kind: 'commit'; id: string; sequence: number }
  | { kind: 'abort'; id: string }
export interface CorePlaylistSubmitReply {
  id: string
  sequence: number
  total: number
  state: 'building' | 'committed' | 'aborted'
  revision?: number
  result?: unknown
}
export function validCorePlaylistSubmitPayload(
  value: unknown,
  input: (value: unknown) => boolean
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const keys = (row: Record<string, unknown>, allowed: string[]) =>
    Object.keys(row).every((key) => allowed.includes(key))
  const text = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0')
  const uint = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  if (v.kind === 'begin') {
    if (
      !keys(v, ['kind', 'revision', 'edit']) ||
      !uint(v.revision) ||
      !v.edit ||
      typeof v.edit !== 'object' ||
      Array.isArray(v.edit)
    )
      return false
    const edit = v.edit as Record<string, unknown>
    switch (edit.kind) {
      case 'create':
        return (
          keys(edit, ['kind', 'name', 'aggregate']) &&
          text(edit.name) &&
          String(edit.name).length <= 80 &&
          (edit.aggregate === undefined || typeof edit.aggregate === 'boolean')
        )
      case 'add':
        return (
          keys(edit, ['kind', 'id', 'external']) &&
          text(edit.id) &&
          (edit.external === undefined || typeof edit.external === 'boolean')
        )
      case 'remove':
        return keys(edit, ['kind', 'id']) && text(edit.id)
      case 'move':
        return keys(edit, ['kind', 'id', 'targetId']) && text(edit.id) && text(edit.targetId)
      case 'reorder':
        return keys(edit, ['kind', 'id', 'target']) && text(edit.id) && uint(edit.target)
      case 'favorite':
        return keys(edit, ['kind', 'favorite']) && typeof edit.favorite === 'boolean'
      default:
        return false
    }
  }
  if (v.kind === 'abort') return keys(v, ['kind', 'id']) && text(v.id)
  if (v.kind === 'commit')
    return keys(v, ['kind', 'id', 'sequence']) && text(v.id) && uint(v.sequence)
  return (
    v.kind === 'append' &&
    keys(v, ['kind', 'id', 'sequence', 'items']) &&
    text(v.id) &&
    uint(v.sequence) &&
    Array.isArray(v.items) &&
    v.items.length <= 200 &&
    v.items.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        keys(item, ['id', 'input']) &&
        (item.id !== undefined || item.input !== undefined) &&
        (item.id === undefined || text(item.id)) &&
        (item.input === undefined || input(item.input))
    )
  )
}
export type CorePlaylistReadRequest = {
  [K in keyof CorePlaylistQueries]: { name: K; payload: CorePlaylistQueries[K]['input'] }
}[keyof CorePlaylistQueries]

export function validCorePlaylistProjectionPayload(name: string, value: unknown, query: (value: unknown) => boolean = () => false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const keys = (allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key))
  const text = (value: unknown, maximum = 32768): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes('\0')
  const uint = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  const page = () =>
    (v.offset === undefined || uint(v.offset)) &&
    (v.limit === undefined || (uint(v.limit) && Number(v.limit) > 0 && Number(v.limit) <= 200))
  switch (name) {
    case 'playlists.collection':
      return keys(['revision','versionsRevision','aggregate','query']) && uint(v.revision) && uint(v.versionsRevision) && (v.aggregate === undefined || typeof v.aggregate === 'boolean') && (v.query === undefined || query(v.query))
    case 'playlists.catalog':
      return (
        keys(['revision', 'offset', 'limit']) &&
        (v.revision === undefined || uint(v.revision)) &&
        page()
      )
    case 'playlists.state':
    case 'playlists.flush':
      return keys([])
    case 'playlists.members':
      return (
        keys(['id', 'revision', 'offset', 'limit', 'search', 'sort', 'anchorId']) &&
        text(v.id) &&
        uint(v.revision) &&
        page() &&
        (v.search === undefined || (typeof v.search === 'string' && v.search.length <= 4096)) &&
        (v.sort === undefined ||
          ['playlist', 'title', 'artist', 'album', 'duration'].includes(String(v.sort))) &&
        (v.anchorId === undefined || text(v.anchorId))
      )
    case 'playlists.membership':
      return (
        keys(['id', 'revision', 'ids']) &&
        text(v.id) &&
        uint(v.revision) &&
        Array.isArray(v.ids) &&
        v.ids.length <= 200 &&
        v.ids.every((id) => text(id))
      )
    case 'playlists.export':
      return (
        keys(['id', 'revision', 'format']) &&
        text(v.id) &&
        uint(v.revision) &&
        ['m3u', 'm3u8', 'pls'].includes(String(v.format))
      )
    case 'playlists.importDocument':
      return (
        keys(['id', 'revision', 'fileName', 'contents']) &&
        text(v.id) &&
        uint(v.revision) &&
        text(v.fileName, 512) &&
        typeof v.contents === 'string' &&
        new TextEncoder().encode(v.contents).length <= 8 * 1024 * 1024
      )
    default:
      return false
  }
}
