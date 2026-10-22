import { musicVersionRevision } from '@renderer/stores/musicVersions.ts'
import { buildLogicalTracks } from '@renderer/utils/logicalTrackModel.ts'
import { computed, onBeforeUnmount, ref, shallowRef, type Ref } from 'vue'
import { useMediaProviders } from '../providers/index.ts'
import { useLibraryUnifiedSearch } from './useLibraryUnifiedSearch.ts'
import type { Track } from '../types/music'
import type { NetworkEntry } from '../../../shared/networkSources.ts'
import type {
  LogicalMusicItem,
  UnifiedSearchProviderHealth,
  UnifiedSearchResult,
  UnifiedSearchTrackItem
} from '../utils/unifiedMusicSearch.ts'
import type { UnifiedLocalSearch } from '../utils/unifiedMusicSearch.ts'

export interface UnifiedMusicSearchDependencies {
  getLocalTracks: () => Track[]
  localSource?: UnifiedLocalSearch
  searchNetworkLibrary?: (
    query: string
  ) => Promise<Array<{ profileName: string; entry: NetworkEntry }>>
  searchAllSongs: (options: {
    query: string
    localTracks: Track[]
    localSource?: UnifiedLocalSearch
    networkEntries?: Array<{ profileName: string; entry: NetworkEntry }>
    limit?: number
    offset?: number
    signal?: AbortSignal
  }) => Promise<UnifiedSearchResult>
}

export interface UnifiedMusicSearchState {
  query: Ref<string>
  items: Ref<UnifiedSearchTrackItem[]>
  logicalItems: Ref<LogicalMusicItem[]>
  providerHealth: Ref<Record<string, UnifiedSearchProviderHealth>>
  loading: Ref<boolean>
  error: Ref<string>
  total: Ref<number>
  hasMore: Ref<boolean>
  search: (query: string, options?: { limit?: number; offset?: number }) => Promise<void>
  clear: () => void
  refresh: () => void
  invalidateLibrary: (revision: number) => void
}

export function useUnifiedMusicSearch(options?: {
  sync?: boolean
  listen?: boolean
}): UnifiedMusicSearchState {
  const providers = useMediaProviders({ sync: options?.sync })
  const localSource = useLibraryUnifiedSearch(
    (revision) => {
      if (revision === undefined) search.refresh()
      else search.invalidateLibrary(revision)
    },
    { listen: options?.listen }
  )
  const search = createUnifiedMusicSearch({
    getLocalTracks: () => [],
    localSource,
    searchNetworkLibrary: async (query) => {
      if (!window.api?.networkSources) return []
      return window.api.networkSources.searchLibrary(query)
    },
    searchAllSongs: (options) => providers.searchAllSongs(options)
  })
  onBeforeUnmount(search.clear)
  return search
}

export function createUnifiedMusicSearch(
  dependencies: UnifiedMusicSearchDependencies
): UnifiedMusicSearchState {
  const query = ref('')
  const items = shallowRef<UnifiedSearchTrackItem[]>([])
  const resultLogicalItems = shallowRef<LogicalMusicItem[]>([])
  const logicalItems = computed(() => {
    void musicVersionRevision.value
    return items.value.length ? buildLogicalTracks(items.value) : resultLogicalItems.value
  })
  const providerHealth = ref<Record<string, UnifiedSearchProviderHealth>>({})
  const loading = ref(false)
  const error = ref('')
  const total = ref(0)
  const hasMore = ref(false)
  let latestRequestId = 0
  let controller: AbortController | null = null
  let lastOptions: { limit?: number; offset?: number } = {}
  let minimumLibraryRevision = 0,
    refreshQueued = false

  function refresh(): void {
    if (refreshQueued || !query.value.trim()) return
    refreshQueued = true
    const requestId = latestRequestId
    queueMicrotask(() => {
      refreshQueued = false
      if (requestId === latestRequestId && query.value.trim()) void search(query.value, lastOptions)
    })
  }
  function invalidateLibrary(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid library revision')
    if (revision <= minimumLibraryRevision) return
    minimumLibraryRevision = revision
    refresh()
  }

  function clear(): void {
    latestRequestId += 1
    controller?.abort()
    controller = null
    query.value = ''
    items.value = []
    resultLogicalItems.value = []
    providerHealth.value = {}
    loading.value = false
    error.value = ''
    total.value = 0
    hasMore.value = false
  }

  async function search(
    nextQuery: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<void> {
    const normalizedQuery = nextQuery.trim()
    lastOptions = { ...options }
    query.value = nextQuery
    if (!normalizedQuery) {
      clear()
      return
    }

    controller?.abort()
    const requestController = new AbortController()
    controller = requestController
    const requestId = ++latestRequestId
    const snapshot = {
      query: normalizedQuery,
      limit: options.limit,
      offset: options.offset
    }
    loading.value = true
    error.value = ''
    items.value = []
    resultLogicalItems.value = []
    providerHealth.value = {}
    total.value = 0
    hasMore.value = false
    try {
      const networkEntries = dependencies.searchNetworkLibrary
        ? await dependencies.searchNetworkLibrary(normalizedQuery).catch(() => [])
        : []
      if (requestId !== latestRequestId) return
      const result = await dependencies.searchAllSongs({
        query: snapshot.query,
        localTracks: dependencies.localSource ? [] : dependencies.getLocalTracks(),
        ...(dependencies.localSource ? { localSource: dependencies.localSource } : {}),
        networkEntries,
        limit: snapshot.limit,
        offset: snapshot.offset,
        signal: requestController.signal
      })
      if (requestId !== latestRequestId) return
      if (result.libraryRevision !== undefined && result.libraryRevision < minimumLibraryRevision)
        throw new Error('曲库在搜索期间发生变化，请重新搜索')
      items.value = result.items
      resultLogicalItems.value = result.logicalItems
      providerHealth.value = result.health
      total.value = result.total
      hasMore.value =
        result.hasMore ?? result.total > (snapshot.offset ?? 0) + (snapshot.limit ?? 30)
    } catch (caught) {
      if (requestId !== latestRequestId) return
      error.value = caught instanceof Error ? caught.message : '统一搜索失败'
      items.value = []
      resultLogicalItems.value = []
      providerHealth.value = {}
    } finally {
      if (requestId === latestRequestId) {
        loading.value = false
      }
    }
  }

  return {
    query,
    items,
    logicalItems,
    providerHealth,
    loading,
    error,
    total,
    hasMore,
    search,
    clear,
    refresh,
    invalidateLibrary
  }
}
