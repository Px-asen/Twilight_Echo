import type { TrackData } from './track.ts'
import type { TwilightMediaProviderMethod } from './mediaProviderMethods.ts'

export const BROWSE_PAGE_SIZE = 200
export const BROWSE_WINDOW_PAGES = 5
export const BROWSE_READ_METHODS = [
  'fetchPlaylistTracks',
  'fetchPlaylistTracksPage',
  'fetchLikedTracks',
  'fetchLikedTracksPage',
  'fetchAlbumTracks',
  'fetchArtistTopSongs',
  'fetchRecommendSongs',
  'fetchPersonalFm',
  'fetchRecentSongs',
  'fetchPlayRecords',
  'searchSongs'
] as const satisfies readonly TwilightMediaProviderMethod[]
export type BrowseReadMethod = (typeof BROWSE_READ_METHODS)[number]
export interface BrowseSource {
  providerId: string
  method: BrowseReadMethod
  args: unknown[]
  /** The existing provider cursor and page-size argument positions. */
  paging?: { offsetArg: number; limitArg: number }
}
export interface BrowseSession {
  id: string
  providerId: string
  loaded: number
  total: number | null
  complete: boolean
  duration: number
  revision: number
}
export interface BrowseQuery {
  id: string
  offset?: number
  limit?: number
  query?: string
  sort?: 'default' | 'title' | 'artist' | 'album' | 'duration' | 'random'
  seed?: number
  direction?: 'asc' | 'desc'
  /** Finish the provider result before applying complete-query actions. */
  complete?: boolean
}
export interface BrowsePage extends BrowseSession {
  offset: number
  filteredTotal: number
  items: TrackData[]
  positions: number[]
}
export interface BrowsePartState {
  expanded: boolean
  page: number
}
export interface BrowsePartGroup {
  id: string
  title: string
  count: number
  total: number
  representative: TrackData
  playing: boolean
}
export type BrowseDisplayRow =
  | { kind: 'track'; key: string; track: TrackData; index: number; grouped: boolean }
  | { kind: 'group'; key: string; group: BrowsePartGroup; expanded: boolean }
  | { kind: 'pager'; key: string; group: BrowsePartGroup; page: number; pageCount: number }
export interface BrowseRowsQuery extends BrowseQuery {
  groups?: Record<string, BrowsePartState>
  currentTrackId?: string
}
export interface BrowseRowsPage extends BrowseSession {
  offset: number
  totalRows: number
  filteredTotal: number
  rows: BrowseDisplayRow[]
}
export interface BrowseSnapshot {
  id: string
  value: Record<string, unknown>
}
export interface BrowseContext {
  providerId: string
  token: string
}
export interface CoreBrowseCommands {
  'browse.open': { source?: BrowseSource; providerId?: string }
  'browse.append': { id: string; items: TrackData[]; complete?: boolean }
  'browse.release': { ids: string[] }
  'browse.snapshot.save': {
    id?: string
    providerIds: string[]
    contexts?: BrowseContext[]
    value: Record<string, unknown>
  }
}
export interface CoreBrowseQueries {
  'browse.page': { input: BrowseQuery; output: BrowsePage }
  'browse.rows': { input: BrowseRowsQuery; output: BrowseRowsPage }
  'browse.snapshot': { input: { id: string }; output: BrowseSnapshot }
  'browse.locate': { input: BrowseQuery & { trackId: string }; output: { position: number } }
  'browse.context': { input: { providerIds: string[] }; output: BrowseContext[] }
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256 && !v.includes('\0')
const handle = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
function serializableWithin(value: unknown, budget: number): boolean {
  try {
    const encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint')
        throw new Error('Nonserializable browse payload')
      return item
    })
    return typeof encoded === 'string' && new TextEncoder().encode(encoded).byteLength <= budget
  } catch {
    return false
  }
}
export function validBrowsePayload(name: string, value: unknown): boolean {
  if (!record(value)) return false
  const keys = (allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key))
  if (name === 'browse.open') {
    if (!keys(['source', 'providerId'])) return false
    if (!value.source) return text(value.providerId)
    const source = value.source
    return (
      record(source) &&
      Object.keys(source).every((key) =>
        ['providerId', 'method', 'args', 'paging'].includes(key)
      ) &&
      text(source.providerId) &&
      BROWSE_READ_METHODS.includes(source.method as BrowseReadMethod) &&
      Array.isArray(source.args) &&
      source.args.length <= 16 &&
      serializableWithin(source.args, 256 * 1024) &&
      (!source.paging ||
        (record(source.paging) &&
          uint(source.paging.offsetArg) &&
          uint(source.paging.limitArg) &&
          Object.keys(source.paging).every((key) => ['offsetArg', 'limitArg'].includes(key)) &&
          source.paging.offsetArg < 16 &&
          source.paging.limitArg < 16 &&
          source.paging.offsetArg !== source.paging.limitArg))
    )
  }
  if (name === 'browse.append')
    return (
      keys(['id', 'items', 'complete']) &&
      handle(value.id) &&
      Array.isArray(value.items) &&
      value.items.length <= BROWSE_PAGE_SIZE &&
      value.items.every((item) => record(item) && text(item.id)) &&
      serializableWithin(value.items, 8 * 1024 * 1024) &&
      (value.complete === undefined || typeof value.complete === 'boolean')
    )
  if (name === 'browse.release')
    return (
      keys(['ids']) &&
      Array.isArray(value.ids) &&
      value.ids.length <= 200 &&
      value.ids.every(handle)
    )
  if (name === 'browse.context')
    return (
      keys(['providerIds']) &&
      Array.isArray(value.providerIds) &&
      value.providerIds.length <= 64 &&
      value.providerIds.every(text)
    )
  if (name === 'browse.snapshot.save')
    return (
      keys(['id', 'providerIds', 'contexts', 'value']) &&
      (value.id === undefined || handle(value.id)) &&
      Array.isArray(value.providerIds) &&
      value.providerIds.length <= 64 &&
      value.providerIds.every(text) &&
      (value.contexts === undefined ||
        (Array.isArray(value.contexts) &&
          value.contexts.length <= 64 &&
          value.contexts.every(
            (item) =>
              record(item) &&
              text(item.providerId) &&
              typeof item.token === 'string' &&
              item.token.length <= 65536
          ))) &&
      record(value.value) &&
      serializableWithin(value.value, 4 * 1024 * 1024)
    )
  if (name === 'browse.snapshot') return keys(['id']) && handle(value.id)
  if (name === 'browse.page' || name === 'browse.locate' || name === 'browse.rows')
    return (
      keys([
        'id',
        'offset',
        'limit',
        'query',
        'sort',
        'direction',
        'complete',
        'trackId',
        'groups',
        'currentTrackId',
        'seed'
      ]) &&
      handle(value.id) &&
      (value.offset === undefined || uint(value.offset)) &&
      (value.limit === undefined ||
        (uint(value.limit) && value.limit > 0 && value.limit <= BROWSE_PAGE_SIZE)) &&
      (value.query === undefined ||
        (typeof value.query === 'string' && value.query.length <= 4096)) &&
      (value.sort === undefined ||
        ['default', 'title', 'artist', 'album', 'duration', 'random'].includes(
          String(value.sort)
        )) &&
      (value.seed === undefined || (uint(value.seed) && value.seed <= 0xffffffff)) &&
      (value.direction === undefined || ['asc', 'desc'].includes(String(value.direction))) &&
      (value.complete === undefined || typeof value.complete === 'boolean') &&
      (value.currentTrackId === undefined || text(value.currentTrackId)) &&
      (value.groups === undefined ||
        (name === 'browse.rows' &&
          record(value.groups) &&
          Object.keys(value.groups).length <= 1000 &&
          Object.entries(value.groups).every(
            ([id, item]) =>
              text(id) && record(item) && typeof item.expanded === 'boolean' && uint(item.page)
          ))) &&
      (name !== 'browse.locate' || text(value.trackId))
    )
  return false
}
