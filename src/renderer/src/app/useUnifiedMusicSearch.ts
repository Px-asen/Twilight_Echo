import { musicVersionRevision } from '@renderer/stores/musicVersions.ts'
import { buildLogicalTracks } from '@renderer/utils/logicalTrackModel.ts'
import { computed, ref, shallowRef, type Ref } from 'vue'
import { useMediaProviders } from '../providers/index.ts'
import { useMusicStore } from '../stores/useMusicStore.ts'
import type { Track } from '../types/music'
import type { NetworkEntry } from '../../../shared/networkSources.ts'
import type {
  LogicalMusicItem,
  UnifiedSearchProviderHealth,
  UnifiedSearchResult,
  UnifiedSearchTrackItem
} from '../utils/unifiedMusicSearch.ts'

export interface UnifiedMusicSearchDependencies {
  getLocalTracks: () => Track[]
  searchNetworkLibrary?: (
    query: string
  ) => Promise<Array<{ profileName: string; entry: NetworkEntry }>>
  searchAllSongs: (options: {
    query: string
    localTracks: Track[]
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
}

export function useUnifiedMusicSearch(): UnifiedMusicSearchState {
  const musicStore = useMusicStore()
  const providers = useMediaProviders()
  return createUnifiedMusicSearch({
    getLocalTracks: () => musicStore.tracks.value,
    searchNetworkLibrary: async (query) => {
      if (!window.api?.networkSources) return []
      return window.api.networkSources.searchLibrary(query)
    },
    searchAllSongs: (options) => providers.searchAllSongs(options)
  })
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
        localTracks: dependencies.getLocalTracks(),
        networkEntries,
        limit: snapshot.limit,
        offset: snapshot.offset,
        signal: requestController.signal
      })
      if (requestId !== latestRequestId) return
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
    clear
  }
}
