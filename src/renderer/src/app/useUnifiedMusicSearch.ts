import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { useCoreConnection } from '../stores/coreConnection.ts'
import type {
  CoreMusicSearchPage,
  CoreMusicSearchQuery,
  CoreSearchTrackItem
} from '../../../shared/coreSearch.ts'
import type { UnifiedSearchProviderHealth } from '../../../shared/unifiedMusicSearch.ts'

export interface UnifiedMusicSearchDependencies {
  searchAllSongs(
    options: CoreMusicSearchQuery & { signal?: AbortSignal }
  ): Promise<CoreMusicSearchPage>
}
export interface UnifiedMusicSearchState {
  query: Ref<string>
  items: Ref<CoreSearchTrackItem[]>
  logicalItems: Ref<CoreMusicSearchPage['logicalItems']>
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
  const core = useCoreConnection()
  const search = createUnifiedMusicSearch({
    searchAllSongs: ({ signal, ...query }) => core.query('search.songs', query, signal)
  })
  const stop =
    options?.listen === false
      ? () => {}
      : watch(
          [
            () => core.state.value?.epoch,
            () => core.state.value?.libraryRevision,
            () => core.state.value?.versionsRevision,
            () => core.state.value?.network?.revision,
            () => core.state.value?.pluginsRevision
          ],
          () => {
            if (!search.error.value) search.refresh()
          }
        )
  onBeforeUnmount(() => {
    stop()
    search.clear()
  })
  return search
}
export function createUnifiedMusicSearch(
  dependencies: UnifiedMusicSearchDependencies
): UnifiedMusicSearchState {
  const query = ref('')
  const items = shallowRef<CoreSearchTrackItem[]>([])
  const logicalItems = shallowRef<CoreMusicSearchPage['logicalItems']>([])
  const providerHealth = ref<Record<string, UnifiedSearchProviderHealth>>({})
  const loading = ref(false)
  const error = ref('')
  const total = ref(0)
  const hasMore = ref(false)
  let latestRequestId = 0
  let controller: AbortController | null = null
  let lastOptions: { limit?: number; offset?: number } = {}
  let minimumLibraryRevision = 0,
    refreshQueued = false,
    refreshPending = false

  function refresh(): void {
    if (refreshQueued || !query.value.trim()) return
    if (controller) {
      refreshPending = true
      return
    }
    refreshQueued = true
    const requestId = latestRequestId
    queueMicrotask(() => {
      refreshQueued = false
      if (requestId !== latestRequestId || !query.value.trim()) return
      if (controller) {
        refreshPending = true
        return
      }
      void runSearch(query.value, lastOptions, { background: true })
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
    refreshPending = false
    controller?.abort()
    controller = null
    query.value = ''
    items.value = []
    logicalItems.value = []
    providerHealth.value = {}
    loading.value = false
    error.value = ''
    total.value = 0
    hasMore.value = false
  }

  async function runSearch(
    nextQuery: string,
    options: { limit?: number; offset?: number } = {},
    mode: { background?: boolean } = {}
  ): Promise<void> {
    if (!mode.background) refreshPending = false
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
    if (!mode.background) {
      items.value = []
      logicalItems.value = []
      providerHealth.value = {}
      total.value = 0
      hasMore.value = false
    }
    try {
      const result = await dependencies.searchAllSongs({
        query: snapshot.query,
        limit: snapshot.limit,
        offset: snapshot.offset,
        signal: requestController.signal
      })
      if (requestId !== latestRequestId) return
      if (result.libraryRevision !== undefined && result.libraryRevision < minimumLibraryRevision) {
        if (refreshPending) return
        throw new Error('曲库在搜索期间发生变化，请重新搜索')
      }
      items.value = result.items
      logicalItems.value = result.logicalItems
      providerHealth.value = result.health
      total.value = result.total
      hasMore.value =
        result.hasMore ?? result.total > (snapshot.offset ?? 0) + (snapshot.limit ?? 30)
    } catch (caught) {
      if (requestId !== latestRequestId) return
      error.value = caught instanceof Error ? caught.message : '统一搜索失败'
      items.value = []
      logicalItems.value = []
      providerHealth.value = {}
      total.value = 0
      hasMore.value = false
    } finally {
      if (controller === requestController) controller = null
      if (requestId === latestRequestId) {
        const followUp = refreshPending && !error.value && !!query.value.trim()
        refreshPending = false
        if (followUp) {
          void runSearch(query.value, lastOptions, { background: true })
        } else {
          loading.value = false
        }
      }
    }
  }

  function search(
    nextQuery: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<void> {
    return runSearch(nextQuery, options)
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
