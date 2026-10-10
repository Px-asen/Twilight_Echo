import type { LibraryItem } from '@renderer/stores/library/musicStoreTypes.ts'
import type {
  MediaProvider,
  MediaProviderAlbumSummary,
  MediaProviderCallOptions,
  MediaProviderSearchResult
} from '@renderer/providers/mediaProvider.ts'
import type { Track } from '@renderer/types/music'
import { searchLocalStreamingAlbums } from './localStreamingSearch.ts'
import { searchUnifiedCollections } from './unifiedCollectionSearch.ts'

export interface AlbumSearchItem extends MediaProviderAlbumSummary {
  providerId: string
  providerName: string
}

interface AlbumSearchProvider {
  id: string
  name: string
  capabilities: readonly string[]
  supportedMethods?: readonly string[]
  health?: { available: boolean }
}

export function supportsAlbumSearch(provider: AlbumSearchProvider): boolean {
  return (
    provider.capabilities.includes('search') &&
    provider.supportedMethods?.includes('searchAlbums') === true
  )
}

export function albumSearchKey(album: Pick<AlbumSearchItem, 'id' | 'providerId'>): string {
  return JSON.stringify([album.providerId, String(album.id)])
}

export function createAlbumSearch(options: {
  localAlbums: () => readonly LibraryItem[]
  providers: () => readonly AlbumSearchProvider[]
  searchProvider: (
    providerId: string,
    query: string,
    limit: number,
    offset: number,
    options?: MediaProviderCallOptions
  ) => Promise<MediaProviderSearchResult<MediaProviderAlbumSummary>>
  getProvider: (providerId: string) => MediaProvider | null | undefined
  reportError: (message: string) => void
}) {
  async function searchLocalAlbums(query: string, limit = 30, offset = 0) {
    const result = searchLocalStreamingAlbums(options.localAlbums(), query, limit, offset)
    return {
      albums: result.albums.map(
        (album): AlbumSearchItem => ({
          ...album,
          providerId: 'local',
          providerName: '本地音乐'
        })
      ),
      total: result.total
    }
  }

  async function searchProviderAlbums(
    providerId: string,
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const provider = options.providers().find((item) => item.id === providerId)
    if (!provider || provider.health?.available === false || !supportsAlbumSearch(provider)) {
      throw new Error(`${provider?.name ?? providerId} 的专辑搜索不可用`)
    }
    const result = await options.searchProvider(providerId, query, limit, offset, callOptions)
    return {
      albums: result.items.map(
        (album): AlbumSearchItem => ({
          ...album,
          providerId,
          providerName: provider.name
        })
      ),
      total: result.total
    }
  }

  async function searchAlbums(
    query: string,
    limit = 30,
    offset = 0,
    callOptions?: MediaProviderCallOptions
  ) {
    const local = await searchLocalAlbums(query, limit, 0)
    const result = await searchUnifiedCollections({
      local: { items: local.albums, total: local.total },
      searchLocal: async (pageLimit, pageOffset) => {
        const page = await searchLocalAlbums(query, pageLimit, pageOffset)
        return { items: page.albums, total: page.total }
      },
      providers: options
        .providers()
        .filter(
          (provider) => supportsAlbumSearch(provider) && provider.health?.available !== false
        ),
      search: async (providerId, pageLimit, pageOffset) => {
        const page = await searchProviderAlbums(
          providerId,
          query,
          pageLimit,
          pageOffset,
          callOptions
        )
        return { items: page.albums, total: page.total }
      },
      limit,
      offset,
      reportError: (message) => {
        if (!callOptions?.signal?.aborted) options.reportError(message)
      }
    })
    return { albums: result.items, total: result.total }
  }

  async function loadAlbumTracks(
    album: Pick<AlbumSearchItem, 'id' | 'providerId'>
  ): Promise<Track[]> {
    if (album.providerId === 'local') {
      const local = options.localAlbums().find((item) => item.id === album.id)
      if (!local) throw new Error('这张专辑已不在本地音乐库中，请重新搜索')
      return local.tracks
    }
    const provider = options.getProvider(album.providerId)
    if (!provider?.fetchAlbumTracks) {
      throw new Error(`${provider?.name ?? album.providerId} 的专辑详情不可用`)
    }
    if (provider.isEnabled && !(await provider.isEnabled())) {
      throw new Error(`${provider.name} 音源当前不可用`)
    }
    return provider.fetchAlbumTracks(album.id)
  }

  return { searchAlbums, searchLocalAlbums, searchProviderAlbums, loadAlbumTracks }
}
