import {
  isPluginProviderEnabled,
  MediaProviderRegistry,
  toProviderIpcArgs
} from './mediaProvider.ts'
import type {
  MediaProvider,
  MediaProviderArtistSummary,
  MediaProviderAlbumSummary,
  MediaProviderDiscoveryPlaylistPage,
  MediaProviderHealth,
  MediaProviderHighQualityPlaylistPage,
  MediaProviderPlaylistCatalogue,
  MediaProviderPlaylistSummary,
  MediaProviderPlaylistTracksPage,
  MediaProviderProfile,
  MediaProviderSearchResult,
  MediaProviderUserSummary
} from './mediaProvider.ts'
import type { Track } from '../types/music'
import { watch } from 'vue'
import { useCoreConnection } from '../stores/coreConnection.ts'
import type { TwilightMediaProviderMethod } from '../../../shared/mediaProviderMethods.ts'

const mediaProviders = new MediaProviderRegistry((query, signal) => useCoreConnection().query('search.songs', query, signal))
let defaultsRegistered = false
let pluginProvidersSyncing: Promise<void> | null = null
let pluginProviderRevision = 0
let pluginChangeListenerSetup = false
let pluginProviderHealthRefreshing: Promise<void> | null = null
let pluginProviderHealthRefreshedAt = 0
const PLUGIN_PROVIDER_HEALTH_REFRESH_INTERVAL_MS = 5_000

export function useMediaProviders(options?: { sync?: boolean }): MediaProviderRegistry {
  registerDefaultProviders()
  if (options?.sync !== false) void syncPluginProviders().catch(() => undefined)
  return mediaProviders
}

function ensurePluginChangeListener(): void {
  if (pluginChangeListenerSetup) return
  pluginChangeListenerSetup = true
  const core = useCoreConnection()
  watch(
    [
      () => core.state.value?.epoch,
      () => core.state.value?.pluginsRevision,
      () => core.state.value?.phase
    ],
    () => {
      pluginProviderRevision += 1
      pluginProviderHealthRefreshedAt = 0
      if (core.state.value?.phase === 'ready') void syncPluginProviders().catch(() => undefined)
    },
    { flush: 'sync' }
  )
}

export function registerDefaultProviders(): void {
  if (defaultsRegistered) return
  defaultsRegistered = true
}

async function refreshPluginProviderHealth(): Promise<void> {
  if (Date.now() - pluginProviderHealthRefreshedAt < PLUGIN_PROVIDER_HEALTH_REFRESH_INTERVAL_MS) {
    return
  }
  if (pluginProviderHealthRefreshing) return pluginProviderHealthRefreshing
  pluginProviderHealthRefreshing = (async () => {
    try {
      await syncPluginProviders()
    } catch {
      // Health refresh follows provider calls opportunistically; callers should keep their result.
    } finally {
      pluginProviderHealthRefreshing = null
      pluginProviderHealthRefreshedAt = Date.now()
    }
  })()

  return pluginProviderHealthRefreshing
}

export async function syncPluginProviders(): Promise<void> {
  ensurePluginChangeListener()
  if (pluginProvidersSyncing) return pluginProvidersSyncing
  const core = useCoreConnection()

  pluginProvidersSyncing = (async () => {
    try {
      let revision = pluginProviderRevision
      let providers = await core.query('providers.list', {})
      // A registration/disable event can arrive while list() is in flight.
      // Discard that old snapshot and let all waiting callers use the fresh one.
      while (revision !== pluginProviderRevision) {
        revision = pluginProviderRevision
        providers = await core.query('providers.list', {})
      }
      const activePluginProviderIds = new Set(providers.map((provider) => provider.id))
      mediaProviders.unregisterWhere(
        (provider) => provider.source === 'plugin' && !activePluginProviderIds.has(provider.id)
      )
      for (const provider of providers) {
        const callProvider = async <T>(
          method: string,
          args: unknown[] = [],
          options?: { signal?: AbortSignal }
        ): Promise<T> => {
          if (options?.signal?.aborted) throw new Error('Provider call was cancelled')
          try {
            return (await core.command(
              'providers.call',
              {
                providerId: provider.id,
                method: method as TwilightMediaProviderMethod,
                args: toProviderIpcArgs(args)
              },
              options?.signal
            )) as T
          } finally {
            void refreshPluginProviderHealth()
          }
        }
        type SupportedMethod = NonNullable<(typeof provider)['supportedMethods']>[number]
        const supports = (method: SupportedMethod): boolean =>
          provider.supportedMethods?.includes(method) === true
        const searchAlbums: MediaProvider['searchAlbums'] =
          provider.capabilities.includes('search') && supports('searchAlbums')
            ? (keywords, limit, offset, options) =>
                callProvider<MediaProviderSearchResult<MediaProviderAlbumSummary>>(
                  'searchAlbums',
                  [keywords, limit, offset],
                  options
                )
            : undefined
        const searchPlaylists: MediaProvider['searchPlaylists'] =
          provider.capabilities.includes('search') && supports('searchPlaylists')
            ? (keywords, limit, offset, options) =>
                callProvider<MediaProviderSearchResult<MediaProviderPlaylistSummary>>(
                  'searchPlaylists',
                  [keywords, limit, offset],
                  options
                )
            : undefined
        const readPlaylistImportPage: MediaProvider['readPlaylistImportPage'] = supports(
          'readPlaylistImportPage'
        )
          ? (id, offset, limit, options) =>
              callProvider('readPlaylistImportPage', [id, offset, limit], options)
          : undefined
        const getTrackMv: MediaProvider['getTrackMv'] =
          provider.capabilities.includes('mv') && supports('getTrackMv')
            ? (track, mvOptions, callOptions) =>
                callProvider('getTrackMv', [track, mvOptions], callOptions)
            : undefined
        if (mediaProviders.get(provider.id)) {
          mediaProviders.update(provider.id, {
            call: callProvider,
            name: provider.name,
            capabilities: provider.capabilities,
            health: provider.health as MediaProviderHealth | undefined,
            isEnabled: () => isPluginProviderEnabled(provider.health),
            getTrackMv,
            searchAlbums,
            searchPlaylists,
            readPlaylistImportPage
          })
          continue
        }
        mediaProviders.register({
          call: callProvider,
          readPlaylistImportPage,
          id: provider.id,
          name: provider.name,
          source: 'plugin',
          capabilities: provider.capabilities,
          health: provider.health as MediaProviderHealth | undefined,
          isEnabled: () => isPluginProviderEnabled(provider.health),
          getPlaybackUrl: provider.capabilities.includes('playbackUrl')
            ? (track, options) => callProvider<string | null>('getPlaybackUrl', [track, options])
            : undefined,
          getTrackMv,
          getLyrics: provider.capabilities.includes('lyrics')
            ? (track, options) =>
                callProvider<{
                  lyrics: string | null
                  translatedLyrics: string | null
                  wordLyrics?: string | null
                }>('getLyrics', [track], options)
            : undefined,
          searchSongs: provider.capabilities.includes('search')
            ? (keywords, limit, offset, options) =>
                callProvider<MediaProviderSearchResult<Track>>(
                  'searchSongs',
                  [keywords, limit, offset],
                  options
                )
            : undefined,
          searchAlbums,
          searchPlaylists,
          searchArtists: provider.capabilities.includes('search')
            ? (keywords, limit, offset) =>
                callProvider<MediaProviderSearchResult<MediaProviderArtistSummary>>(
                  'searchArtists',
                  [keywords, limit, offset]
                )
            : undefined,
          fetchPlaylistTracks: provider.capabilities.includes('playlist')
            ? (playlistId, force) =>
                callProvider<Track[]>('fetchPlaylistTracks', [playlistId, force])
            : undefined,
          fetchPlaylistTracksPage: supports('fetchPlaylistTracksPage')
            ? (playlistId, offset, limit, force) =>
                callProvider<MediaProviderPlaylistTracksPage>('fetchPlaylistTracksPage', [
                  playlistId,
                  offset,
                  limit,
                  force
                ])
            : undefined,
          checkLogin: provider.capabilities.includes('login')
            ? () =>
                callProvider<{ loggedIn: boolean; profile: MediaProviderProfile | null }>(
                  'checkLogin'
                )
            : undefined,
          getProfile: provider.capabilities.includes('login')
            ? () => callProvider<MediaProviderProfile | null>('getProfile')
            : undefined,
          logout: provider.capabilities.includes('login')
            ? () => callProvider<void>('logout')
            : undefined,
          getQrLogin: provider.capabilities.includes('login')
            ? () =>
                callProvider<{
                  key: string
                  qrContent?: string
                  imageDataUrl?: string
                  expiresInSeconds?: number
                } | null>('getQrLogin')
            : undefined,
          getQrKey: provider.capabilities.includes('login')
            ? () => callProvider<string | null>('getQrKey')
            : undefined,
          getQrImage: provider.capabilities.includes('login')
            ? (key) => callProvider<string | null>('getQrImage', [key])
            : undefined,
          checkQrLogin: provider.capabilities.includes('login')
            ? (key) => callProvider<{ code: number }>('checkQrLogin', [key])
            : undefined,
          fetchUserLibrary: provider.capabilities.includes('library')
            ? (force) =>
                callProvider<{
                  likedPlaylist: MediaProviderPlaylistSummary | null
                  playlists: MediaProviderPlaylistSummary[]
                }>('fetchUserLibrary', [force])
            : undefined,
          fetchLikedTracks: provider.capabilities.includes('library')
            ? (force) => callProvider<Track[]>('fetchLikedTracks', [force])
            : undefined,
          fetchRecommendSongs: supports('fetchRecommendSongs')
            ? () => callProvider<Track[]>('fetchRecommendSongs')
            : undefined,
          fetchRecommendPlaylists: supports('fetchRecommendPlaylists')
            ? () => callProvider<MediaProviderPlaylistSummary[]>('fetchRecommendPlaylists')
            : undefined,
          fetchPlaylistCategories: supports('fetchPlaylistCategories')
            ? () => callProvider<MediaProviderPlaylistCatalogue>('fetchPlaylistCategories')
            : undefined,
          fetchDiscoveryPlaylists: supports('fetchDiscoveryPlaylists')
            ? (cat, order, limit, offset) =>
                callProvider<MediaProviderDiscoveryPlaylistPage>('fetchDiscoveryPlaylists', [
                  cat,
                  order,
                  limit,
                  offset
                ])
            : undefined,
          fetchHighQualityPlaylists: supports('fetchHighQualityPlaylists')
            ? (cat, limit, before) =>
                callProvider<MediaProviderHighQualityPlaylistPage>('fetchHighQualityPlaylists', [
                  cat,
                  limit,
                  before
                ])
            : undefined,
          fetchPersonalFm: supports('fetchPersonalFm')
            ? () => callProvider<Track[]>('fetchPersonalFm')
            : undefined,
          fetchPrivateContent: supports('fetchPrivateContent')
            ? () => callProvider<Track[]>('fetchPrivateContent')
            : undefined,
          fetchArtistTopSongs: provider.capabilities.includes('search')
            ? (artistId) => callProvider<Track[]>('fetchArtistTopSongs', [artistId])
            : undefined,
          fetchArtistAlbums: provider.capabilities.includes('library')
            ? (artistId) =>
                callProvider<MediaProviderAlbumSummary[]>('fetchArtistAlbums', [artistId])
            : undefined,
          fetchSavedAlbums: supports('fetchSavedAlbums')
            ? () => callProvider<MediaProviderAlbumSummary[]>('fetchSavedAlbums')
            : undefined,
          fetchSavedArtists: supports('fetchSavedArtists')
            ? () => callProvider<MediaProviderArtistSummary[]>('fetchSavedArtists')
            : undefined,
          fetchArtistIntro: provider.capabilities.includes('library')
            ? (artistId) => callProvider<string>('fetchArtistIntro', [artistId])
            : undefined,
          fetchArtistFollowState: provider.capabilities.includes('library')
            ? (artistId) => callProvider<boolean | null>('fetchArtistFollowState', [artistId])
            : undefined,
          fetchAlbumTracks: provider.capabilities.includes('playlist')
            ? (albumId) => callProvider<Track[]>('fetchAlbumTracks', [albumId])
            : undefined,
          fetchArtistPlaylists: provider.capabilities.includes('playlist')
            ? (artistId) =>
                callProvider<MediaProviderPlaylistSummary[]>('fetchArtistPlaylists', [artistId])
            : undefined,
          fetchUserPlaylistsByUid: provider.capabilities.includes('library')
            ? (uid, createdOnly) =>
                callProvider<MediaProviderPlaylistSummary[]>('fetchUserPlaylistsByUid', [
                  uid,
                  createdOnly
                ])
            : undefined,
          fetchUserFollows: provider.capabilities.includes('library')
            ? (uid, limit, offset) =>
                callProvider<MediaProviderUserSummary[]>('fetchUserFollows', [uid, limit, offset])
            : undefined,
          fetchUserFolloweds: provider.capabilities.includes('library')
            ? (uid, limit, offset) =>
                callProvider<MediaProviderUserSummary[]>('fetchUserFolloweds', [uid, limit, offset])
            : undefined,
          fetchPlayRecords: provider.capabilities.includes('library')
            ? (type) => callProvider<Track[]>('fetchPlayRecords', [type])
            : undefined,
          fetchRecentSongs: provider.capabilities.includes('library')
            ? (limit) => callProvider<Track[]>('fetchRecentSongs', [limit])
            : undefined,
          followArtist: provider.capabilities.includes('library')
            ? (artistId, follow) => callProvider<void>('followArtist', [artistId, follow])
            : undefined,
          followUser: provider.capabilities.includes('library')
            ? (userId, follow) => callProvider<void>('followUser', [userId, follow])
            : undefined,
          likeTrack: provider.capabilities.includes('library')
            ? (trackId, like) => callProvider<void>('likeTrack', [trackId, like])
            : undefined,
          isTrackLiked: provider.capabilities.includes('library')
            ? (trackId) => callProvider<boolean>('isTrackLiked', [trackId])
            : undefined,
          createPlaylist: provider.capabilities.includes('library')
            ? (name, options) =>
                callProvider<MediaProviderPlaylistSummary>('createPlaylist', [name, options])
            : undefined,
          deletePlaylist: provider.capabilities.includes('library')
            ? (playlistId) => callProvider<void>('deletePlaylist', [playlistId])
            : undefined,
          addTracksToPlaylist: provider.capabilities.includes('library')
            ? (playlistId, trackIds) =>
                callProvider<void>('addTracksToPlaylist', [playlistId, trackIds])
            : undefined,
          removeTracksFromPlaylist: provider.capabilities.includes('library')
            ? (playlistId, trackIds) =>
                callProvider<void>('removeTracksFromPlaylist', [playlistId, trackIds])
            : undefined
        })
      }
    } finally {
      pluginProvidersSyncing = null
    }
  })()

  return pluginProvidersSyncing
}

export * from './mediaProvider.ts'
export * from './ncmTrack.ts'
