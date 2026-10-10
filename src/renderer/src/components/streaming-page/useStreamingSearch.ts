import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import type {
  MediaProviderArtistSummary,
  MediaProviderPlaylistSummary
} from '../../providers/mediaProvider'
import type { PageState } from './types'
import { friendlyStreamingError } from './friendlyStreamingError.ts'
import type { AlbumSearchItem } from './albumSearch.ts'

export type SearchType = 'songs' | 'albums' | 'playlists' | 'artists'
export type SearchSource = 'all' | 'local' | string

export interface SearchSourceOption {
  id: SearchSource
  label: string
  icon?: string
  available: boolean
  supportedTypes: SearchType[]
}

type UseStreamingSearchOptions = {
  searchAlbums?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ albums: AlbumSearchItem[]; total: number }>
  searchLocalAlbums?: (
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<{ albums: AlbumSearchItem[]; total: number }>
  searchProviderAlbums?: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ albums: AlbumSearchItem[]; total: number }>
  searchSongs: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ tracks: Track[]; total: number }>
  searchUnifiedSongs?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ tracks: Track[]; total: number }>
  searchPlaylists: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ playlists: MediaProviderPlaylistSummary[]; total: number }>
  searchArtists: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ artists: MediaProviderArtistSummary[]; total: number }>
  searchProviderSongs?: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ tracks: Track[]; total: number }>
  searchProviderPlaylists?: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ playlists: MediaProviderPlaylistSummary[]; total: number }>
  searchProviderArtists?: (
    providerId: string,
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ artists: MediaProviderArtistSummary[]; total: number }>
  searchLocalSongs?: (
    keywords: string,
    limit?: number,
    offset?: number
  ) => Promise<{ tracks: Track[]; total: number }>
  searchLocalPlaylists?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ playlists: MediaProviderPlaylistSummary[]; total: number }>
  searchLocalArtists?: (
    keywords: string,
    limit?: number,
    offset?: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ artists: MediaProviderArtistSummary[]; total: number }>
  searchSources: Ref<SearchSourceOption[]>
  playTrack: (track: Track, queue?: Track[]) => void
}

interface SearchRequestSnapshot {
  requestId: number
  query: string
  type: SearchType
  source: SearchSource
  offset: number
}

export function useStreamingSearch({
  searchAlbums,
  searchLocalAlbums,
  searchProviderAlbums,
  searchSongs,
  searchUnifiedSongs,
  searchPlaylists,
  searchArtists,
  searchProviderSongs,
  searchProviderPlaylists,
  searchProviderArtists,
  searchLocalSongs,
  searchLocalPlaylists,
  searchLocalArtists,
  searchSources,
  playTrack
}: UseStreamingSearchOptions): {
  searchQuery: Ref<string>
  searchType: Ref<SearchType>
  searchSource: Ref<SearchSource>
  searchResults: Ref<Track[]>
  searchAlbumsResults: Ref<AlbumSearchItem[]>
  searchPlaylistsResults: Ref<MediaProviderPlaylistSummary[]>
  searchArtistsResults: Ref<MediaProviderArtistSummary[]>
  searchTotal: Ref<number>
  searchOffset: Ref<number>
  searchLoading: Ref<boolean>
  searchError: Ref<string>
  searchInputFocused: Ref<boolean>
  isSearching: ComputedRef<boolean>
  availableSearchTypes: ComputedRef<SearchType[]>
  clearSearch: () => void
  performSearch: (keywords: string) => Promise<void>
  onPageChange: (event: PageState) => void
  onSearchTrackClick: (track: Track) => void
} {
  const searchQuery = ref('')
  const searchType = ref<SearchType>('songs')
  const searchSource = ref<SearchSource>('all')
  const searchResults = shallowRef<Track[]>([])
  const searchAlbumsResults = shallowRef<AlbumSearchItem[]>([])
  const searchPlaylistsResults = shallowRef<MediaProviderPlaylistSummary[]>([])
  const searchArtistsResults = shallowRef<MediaProviderArtistSummary[]>([])
  const searchTotal = ref(0)
  const searchOffset = ref(0)
  const searchLoading = ref(false)
  const searchError = ref('')
  const searchInputFocused = ref(false)
  const isSearching = computed(() => searchQuery.value.trim().length > 0)
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let latestRequestId = 0
  let lastRequestFingerprint = ''
  let activeSearchController: AbortController | null = null

  const cancelActiveSearch = (): void => {
    activeSearchController?.abort(new Error('Search request was superseded'))
    activeSearchController = null
  }

  const availableSearchTypes = computed<SearchType[]>(() => {
    const source = searchSources.value.find((s) => s.id === searchSource.value)
    return source?.supportedTypes ?? ['songs']
  })

  function clearSearch(): void {
    latestRequestId += 1
    cancelActiveSearch()
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
    }
    searchQuery.value = ''
    searchResults.value = []
    searchAlbumsResults.value = []
    searchPlaylistsResults.value = []
    searchArtistsResults.value = []
    searchTotal.value = 0
    searchOffset.value = 0
    searchLoading.value = false
    searchError.value = ''
    lastRequestFingerprint = ''
  }

  async function resolveAlbumsSearch(
    source: SearchSource,
    keywords: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<{ albums: AlbumSearchItem[]; total: number }> {
    if (source === 'all' && searchAlbums) return searchAlbums(keywords, limit, offset, { signal })
    if (source === 'local') {
      return searchLocalAlbums?.(keywords, limit, offset) ?? { albums: [], total: 0 }
    }
    if (source !== 'all' && searchProviderAlbums) {
      return searchProviderAlbums(source, keywords, limit, offset, { signal })
    }
    return { albums: [], total: 0 }
  }

  async function resolveSongsSearch(
    source: SearchSource,
    keywords: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<{ tracks: Track[]; total: number }> {
    if (source === 'all') {
      return (searchUnifiedSongs ?? searchSongs)(keywords, limit, offset, { signal })
    }
    if (source === 'local') {
      if (searchLocalSongs) return searchLocalSongs(keywords, limit, offset)
      return { tracks: [], total: 0 }
    }
    if (searchProviderSongs) {
      return searchProviderSongs(source, keywords, limit, offset, { signal })
    }
    return { tracks: [], total: 0 }
  }

  async function resolvePlaylistsSearch(
    source: SearchSource,
    keywords: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<{ playlists: MediaProviderPlaylistSummary[]; total: number }> {
    if (source === 'all') {
      return searchPlaylists(keywords, limit, offset, { signal })
    }
    if (source === 'local') {
      if (searchLocalPlaylists) return searchLocalPlaylists(keywords, limit, offset)
      return { playlists: [], total: 0 }
    }
    if (searchProviderPlaylists) {
      return searchProviderPlaylists(source, keywords, limit, offset, { signal })
    }
    return { playlists: [], total: 0 }
  }

  async function resolveArtistsSearch(
    source: SearchSource,
    keywords: string,
    limit: number,
    offset: number,
    signal?: AbortSignal
  ): Promise<{ artists: MediaProviderArtistSummary[]; total: number }> {
    if (source === 'all') {
      return searchArtists(keywords, limit, offset, { signal })
    }
    if (source === 'local') {
      if (searchLocalArtists) return searchLocalArtists(keywords, limit, offset)
      return { artists: [], total: 0 }
    }
    if (searchProviderArtists) {
      return searchProviderArtists(source, keywords, limit, offset, { signal })
    }
    return { artists: [], total: 0 }
  }

  async function performSearch(keywords: string): Promise<void> {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
    }
    const query = keywords.trim()
    if (!query) {
      latestRequestId += 1
      cancelActiveSearch()
      searchResults.value = []
      searchAlbumsResults.value = []
      searchPlaylistsResults.value = []
      searchArtistsResults.value = []
      searchTotal.value = 0
      searchLoading.value = false
      searchError.value = ''
      return
    }
    cancelActiveSearch()
    const controller = new AbortController()
    activeSearchController = controller
    const snapshot: SearchRequestSnapshot = {
      requestId: ++latestRequestId,
      query,
      type: searchType.value,
      source: searchSource.value,
      offset: searchOffset.value
    }
    lastRequestFingerprint = searchRequestFingerprint(snapshot)
    searchLoading.value = true
    searchError.value = ''
    try {
      if (snapshot.type === 'songs') {
        const { tracks, total } = await resolveSongsSearch(
          snapshot.source,
          snapshot.query,
          30,
          snapshot.offset,
          controller.signal
        )
        if (snapshot.requestId === latestRequestId) {
          searchResults.value = tracks
          searchTotal.value = total
        }
      } else if (snapshot.type === 'albums') {
        const { albums, total } = await resolveAlbumsSearch(
          snapshot.source,
          snapshot.query,
          30,
          snapshot.offset,
          controller.signal
        )
        if (snapshot.requestId === latestRequestId) {
          if (snapshot.offset > 0 && snapshot.offset >= total) {
            searchOffset.value = total > 0 ? Math.floor((total - 1) / 30) * 30 : 0
            if (total > 0) {
              await performSearch(snapshot.query)
              return
            }
          }
          searchAlbumsResults.value = albums
          searchTotal.value = total
        }
      } else if (snapshot.type === 'playlists') {
        const { playlists, total } = await resolvePlaylistsSearch(
          snapshot.source,
          snapshot.query,
          30,
          snapshot.offset,
          controller.signal
        )
        if (snapshot.requestId === latestRequestId) {
          searchPlaylistsResults.value = playlists
          searchTotal.value = total
        }
      } else if (snapshot.type === 'artists') {
        const { artists, total } = await resolveArtistsSearch(
          snapshot.source,
          snapshot.query,
          30,
          snapshot.offset,
          controller.signal
        )
        if (snapshot.requestId === latestRequestId) {
          searchArtistsResults.value = artists
          searchTotal.value = total
        }
      }
    } catch (e) {
      if (snapshot.requestId === latestRequestId) {
        searchError.value = friendlyStreamingError(e, '搜索失败')
        searchResults.value = []
        searchAlbumsResults.value = []
        searchPlaylistsResults.value = []
        searchArtistsResults.value = []
        searchTotal.value = 0
      }
    } finally {
      if (activeSearchController === controller) activeSearchController = null
      if (snapshot.requestId === latestRequestId) {
        searchLoading.value = false
      }
    }
  }

  watch(
    [searchQuery, searchType, searchSource],
    ([newQuery, newType, newSource], [oldQuery, oldType, oldSource]) => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      const q = newQuery.trim()
      if (!q) {
        latestRequestId += 1
        cancelActiveSearch()
        searchResults.value = []
        searchAlbumsResults.value = []
        searchPlaylistsResults.value = []
        searchArtistsResults.value = []
        searchTotal.value = 0
        searchOffset.value = 0
        searchLoading.value = false
        searchError.value = ''
        lastRequestFingerprint = ''
        return
      }

      if (oldQuery !== newQuery || oldType !== newType || oldSource !== newSource) {
        searchOffset.value = 0
        const nextFingerprint = searchRequestFingerprint({
          query: q,
          type: newType,
          source: newSource,
          offset: 0
        })
        if (nextFingerprint === lastRequestFingerprint) return
        latestRequestId += 1
        cancelActiveSearch()
        searchResults.value = []
        searchAlbumsResults.value = []
        searchPlaylistsResults.value = []
        searchArtistsResults.value = []
        searchTotal.value = 0
        searchError.value = ''
        searchLoading.value = true
        searchDebounceTimer = setTimeout(() => {
          searchDebounceTimer = null
          void performSearch(q)
        }, 300)
      }
    }
  )

  // Ensure searchType is valid for the current source
  watch(availableSearchTypes, (types) => {
    if (types.length > 0 && !types.includes(searchType.value)) {
      searchType.value = types[0]
    }
  })

  function onPageChange(event: PageState): void {
    searchOffset.value = event.first
    void performSearch(searchQuery.value.trim())
  }

  function onSearchTrackClick(track: Track): void {
    playTrack(track, searchResults.value)
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
      latestRequestId += 1
      cancelActiveSearch()
    })
  }

  return {
    searchQuery,
    searchType,
    searchSource,
    searchResults,
    searchAlbumsResults,
    searchPlaylistsResults,
    searchArtistsResults,
    searchTotal,
    searchOffset,
    searchLoading,
    searchError,
    searchInputFocused,
    isSearching,
    availableSearchTypes,
    clearSearch,
    performSearch,
    onPageChange,
    onSearchTrackClick
  }
}

function searchRequestFingerprint(snapshot: Omit<SearchRequestSnapshot, 'requestId'>): string {
  return `${snapshot.query}\u001f${snapshot.type}\u001f${snapshot.source}\u001f${snapshot.offset}`
}
