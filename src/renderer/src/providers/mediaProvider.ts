import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary
} from '../../../shared/providerSearch.ts'
export type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary
} from '../../../shared/providerSearch.ts'
import { toRaw } from 'vue'
import type { MediaProviderLyrics } from '../../../shared/providerLyrics.ts'
import type { MediaProviderMvOptions, MediaProviderMvStream } from '../../../shared/providerMv.ts'
import { assertProviderEnabled } from '../../../core/lyrics/providerLyrics.ts'
import type { Track } from '../types/music'
import { getNcmSongId } from './ncmTrack.ts'
import type { CoreMusicSearchPage, CoreMusicSearchQuery } from '../../../shared/coreSearch.ts'

export type MediaProviderCapability =
  | 'search'
  | 'playbackUrl'
  | 'mv'
  | 'lyrics'
  | 'cover'
  | 'playlist'
  | 'library'
  | 'login'
  | 'download'

export type { MediaProviderLyrics } from '../../../shared/providerLyrics.ts'
export type {
  MediaProviderMvOptions,
  MediaProviderMvQuality,
  MediaProviderMvStream
} from '../../../shared/providerMv.ts'

export interface MediaProviderCallOptions {
  signal?: AbortSignal
}

export interface PlaybackUrlOptions {
  force?: boolean
  quality?: string
}

export interface MediaProviderSearchResult<T> {
  items: T[]
  total: number
}

export interface MediaProviderPlaylistCatalogue {
  hotTags: string[]
  groups: Array<{
    id: number
    name: string
    tags: Array<{ name: string; hot: boolean }>
  }>
}

export interface MediaProviderToplistSummary extends MediaProviderPlaylistSummary {
  description?: string
  updateFrequency?: string
  updatedAt?: number
  featured?: boolean
  previewTracks: Array<{ title: string; artist: string }>
}

export interface MediaProviderDiscoveryPlaylistPage {
  items: MediaProviderPlaylistSummary[]
  total: number
  hasMore: boolean
  offset: number
  limit: number
}

export interface MediaProviderHighQualityPlaylistPage {
  items: MediaProviderPlaylistSummary[]
  total: number
  hasMore: boolean
  lasttime: number
}

export interface MediaProviderProfile {
  userId: number | string
  nickname: string
  avatarUrl: string
  avatarUrlSource?: string | null
  signature?: string
  follows?: number
  followeds?: number
}

export interface MediaProviderQrLogin {
  key: string
  qrContent?: string
  imageDataUrl?: string
  expiresInSeconds?: number
}

export interface MediaProviderHealth {
  providerId: string
  pluginId: string
  pluginStatus: string
  available: boolean
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  methodStats?: Record<string, MediaProviderMethodHealth | undefined>
  lastError: string | null
  lastCheckedAt: string | null
}

export interface MediaProviderMethodHealth {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  successRate: number
  lastError: string | null
  lastCheckedAt: string | null
}

export interface MediaProviderUserSummary {
  id: number | string
  name: string
  picUrl: string | null
  picUrlSource?: string | null
  picUrlSmall?: string | null
  picUrlSmallSource?: string | null
  musicSize?: number
  userType?: number
  artistId?: number | string
  followed?: boolean
}

export interface MediaProviderPlaylistTracksPage {
  tracks: Track[]
  total: number | null
  /** Provider cursor, independent of filtered or expanded track count. */
  nextOffset: number
  hasMore: boolean
}

export interface MediaProvider {
  call?: <T>(method: string, args: unknown[], options?: MediaProviderCallOptions) => Promise<T>
  readPlaylistImportPage?: (
    playlistId: string,
    offset: number,
    limit: number,
    options?: MediaProviderCallOptions
  ) => Promise<import('../../../shared/externalPlaylist.ts').PlaylistImportPage>
  id: string
  name: string
  source: 'internal' | 'plugin'
  capabilities: MediaProviderCapability[]
  health?: MediaProviderHealth
  isEnabled?: () => boolean | Promise<boolean>
  getPlaybackUrl?: (track: Track, options?: PlaybackUrlOptions) => Promise<string | null>
  getTrackMv?: (
    track: Track,
    options?: MediaProviderMvOptions,
    callOptions?: MediaProviderCallOptions
  ) => Promise<MediaProviderMvStream | null>
  getLyrics?: (track: Track, options?: MediaProviderCallOptions) => Promise<MediaProviderLyrics>
  searchSongs?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<Track>>
  searchAlbums?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderAlbumSummary>>
  searchPlaylists?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderPlaylistSummary>>
  searchArtists?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderArtistSummary>>
  fetchPlaylistTracks?: (playlistId: number | string, force?: boolean) => Promise<Track[]>
  fetchToplists?: (force?: boolean) => Promise<MediaProviderToplistSummary[]>
  fetchPlaylistTracksPage?: (
    playlistId: number | string,
    offset?: number,
    limit?: number,
    force?: boolean
  ) => Promise<MediaProviderPlaylistTracksPage>
  checkLogin?: () => Promise<{ loggedIn: boolean; profile: MediaProviderProfile | null }>
  getProfile?: () => Promise<MediaProviderProfile | null>
  logout?: () => Promise<void>
  getQrLogin?: () => Promise<MediaProviderQrLogin | null>
  getQrKey?: () => Promise<string | null>
  getQrImage?: (key: string) => Promise<string | null>
  checkQrLogin?: (key: string) => Promise<{ code: number }>
  fetchUserLibrary?: (force?: boolean) => Promise<{
    likedPlaylist: MediaProviderPlaylistSummary | null
    playlists: MediaProviderPlaylistSummary[]
  }>
  fetchLikedTracks?: (force?: boolean) => Promise<Track[]>
  fetchRecommendSongs?: () => Promise<Track[]>
  fetchRecommendPlaylists?: () => Promise<MediaProviderPlaylistSummary[]>
  fetchPlaylistCategories?: () => Promise<MediaProviderPlaylistCatalogue>
  fetchDiscoveryPlaylists?: (
    cat?: string,
    order?: 'hot' | 'new',
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderDiscoveryPlaylistPage>
  fetchHighQualityPlaylists?: (
    cat?: string,
    limit?: number,
    before?: number
  ) => Promise<MediaProviderHighQualityPlaylistPage>
  fetchPersonalFm?: () => Promise<Track[]>
  fetchPrivateContent?: () => Promise<Track[]>
  fetchArtistTopSongs?: (artistId: number | string) => Promise<Track[]>
  fetchArtistAlbums?: (artistId: number | string) => Promise<MediaProviderAlbumSummary[]>
  fetchSavedAlbums?: () => Promise<MediaProviderAlbumSummary[]>
  fetchSavedArtists?: () => Promise<MediaProviderArtistSummary[]>
  fetchArtistIntro?: (artistId: number | string) => Promise<string>
  fetchArtistFollowState?: (artistId: number | string) => Promise<boolean | null>
  fetchAlbumTracks?: (albumId: number | string) => Promise<Track[]>
  fetchArtistPlaylists?: (artistId: number | string) => Promise<MediaProviderPlaylistSummary[]>
  fetchUserPlaylistsByUid?: (
    uid: number | string,
    createdOnly?: boolean
  ) => Promise<MediaProviderPlaylistSummary[]>
  fetchUserFollows?: (
    uid: number | string,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderUserSummary[]>
  fetchUserFolloweds?: (
    uid: number | string,
    limit?: number,
    offset?: number
  ) => Promise<MediaProviderUserSummary[]>
  fetchPlayRecords?: (type?: number) => Promise<Track[]>
  fetchRecentSongs?: (limit?: number) => Promise<Track[]>
  followArtist?: (artistId: number | string, follow: boolean) => Promise<void>
  followUser?: (userId: number | string, follow: boolean) => Promise<void>
  likeTrack?: (trackId: number | string, like: boolean) => Promise<void>
  isTrackLiked?: (trackId: number | string | undefined) => boolean | Promise<boolean>
  createPlaylist?: (
    name: string,
    options?: { privacy?: 0 | 10 }
  ) => Promise<MediaProviderPlaylistSummary>
  deletePlaylist?: (playlistId: number | string) => Promise<void>
  addTracksToPlaylist?: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
  removeTracksFromPlaylist?: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
}

import { isPluginProviderEnabled } from '../../../shared/providerAvailability.ts'
export { isPluginProviderEnabled }

export class MediaProviderRegistry {
  private readonly search?: (query: CoreMusicSearchQuery, signal?: AbortSignal) => Promise<CoreMusicSearchPage>
  constructor(search?: (query: CoreMusicSearchQuery, signal?: AbortSignal) => Promise<CoreMusicSearchPage>) { this.search = search }
  private providers = new Map<string, MediaProvider>()
  private generations = new Map<string, number>()

  getGeneration(id: string): number {
    return this.generations.get(normalizeProviderId(id)) ?? 0
  }

  private invalidate(id: string): void {
    this.generations.set(id, this.getGeneration(id) + 1)
  }

  register(provider: MediaProvider): void {
    const id = normalizeProviderId(provider.id)
    if (!id) throw new Error('MediaProvider id is required')
    if (this.providers.has(id)) throw new Error(`MediaProvider already registered: ${id}`)
    this.providers.set(id, { ...provider, id })
    this.invalidate(id)
  }

  update(id: string, patch: Partial<MediaProvider>): boolean {
    const normalizedId = normalizeProviderId(id)
    const current = this.providers.get(normalizedId)
    if (!current) return false
    if (
      patch.health &&
      isPluginProviderEnabled(current.health) !== isPluginProviderEnabled(patch.health)
    ) {
      this.invalidate(normalizedId)
    }
    this.providers.set(normalizedId, {
      ...current,
      ...patch,
      id: normalizedId
    })
    return true
  }

  unregister(id: string): void {
    const normalizedId = normalizeProviderId(id)
    if (this.providers.delete(normalizedId)) this.invalidate(normalizedId)
  }

  unregisterWhere(predicate: (provider: MediaProvider) => boolean): void {
    for (const provider of this.providers.values()) {
      if (predicate(provider)) {
        this.unregister(provider.id)
      }
    }
  }

  list(): MediaProvider[] {
    return [...this.providers.values()]
  }

  get(id: string): MediaProvider | null {
    return this.providers.get(normalizeProviderId(id)) ?? null
  }

  getForTrack(track: Track): MediaProvider | null {
    const providerId = getTrackProviderId(track)
    return providerId ? this.get(providerId) : null
  }

  async searchSongs(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<Track>> {
    const provider = this.get(providerId)
    if (!provider?.searchSongs) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchSongs(keywords, limit, offset, options)
  }

  async searchAlbums(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<MediaProviderAlbumSummary>> {
    const provider = this.get(providerId)
    if (!provider?.searchAlbums) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchAlbums(keywords, limit, offset, options)
  }

  async searchPlaylists(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<MediaProviderPlaylistSummary>> {
    const provider = this.get(providerId)
    if (!provider?.searchPlaylists) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchPlaylists(keywords, limit, offset, options)
  }

  async searchArtists(
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: MediaProviderCallOptions
  ): Promise<MediaProviderSearchResult<MediaProviderArtistSummary>> {
    const provider = this.get(providerId)
    if (!provider?.searchArtists) return { items: [], total: 0 }
    await assertProviderEnabled(provider)
    return provider.searchArtists(keywords, limit, offset, options)
  }

  searchAllSongs(options: { query: string; limit?: number; offset?: number; signal?: AbortSignal }): Promise<CoreMusicSearchPage> {
    if (!this.search) throw new Error('Core search transport is unavailable')
    const { signal, ...query } = options
    return this.search(query, signal)
  }
  async call<T>(
    providerId: string,
    method: string,
    args: unknown[] = [],
    options?: MediaProviderCallOptions
  ): Promise<T> {
    const provider = this.get(providerId)
    if (!provider) throw new Error('Provider 未启用')
    await assertProviderEnabled(provider)
    if (!provider.call) throw new Error('Provider transport is unavailable')
    if (options?.signal?.aborted) throw new Error('Provider call was cancelled')
    return provider.call<T>(method, toProviderIpcArgs(args), options)
  }
}

export function getTrackProviderId(track: Pick<Track, 'id' | 'source'>): string | null {
  if (track.source) return normalizeProviderId(track.source)
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return null
  const separatorIndex = track.id.indexOf(':')
  if (separatorIndex <= 0) return null
  return normalizeProviderId(track.id.slice(0, separatorIndex))
}

export function getProviderLocalId(trackId: string, providerId: string): string | null {
  const prefix = `${normalizeProviderId(providerId)}:`
  return trackId.startsWith(prefix) ? trackId.slice(prefix.length) : null
}

/**
 * Remote track id a provider's library writes (favorites, playlist adds) expect.
 * NetEase carries a numeric song id; other providers keep it in the `<provider>:`
 * prefixed track id.
 */
export function resolveProviderTrackId(
  track: Pick<Track, 'id' | 'ncmSongId'>,
  providerId: string
): string | number | null {
  if (normalizeProviderId(providerId) === 'ncm') return getNcmSongId(track)
  const localId = getProviderLocalId(track.id, providerId)?.trim()
  return localId || null
}

export function toProviderIpcArgs(args: unknown[]): unknown[] {
  return args.map((arg) => toProviderIpcValue(arg))
}

function toProviderIpcValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value

  const raw = toRaw(value) as object
  if (seen.has(raw)) return null
  seen.add(raw)

  if (Array.isArray(raw)) {
    return raw.map((item) => toProviderIpcValue(item, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(raw)) {
    if (typeof nestedValue === 'function' || typeof nestedValue === 'symbol') continue
    output[key] = toProviderIpcValue(nestedValue, seen)
  }
  return output
}

function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase()
}
