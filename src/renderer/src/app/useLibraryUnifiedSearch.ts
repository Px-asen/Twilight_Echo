import { onBeforeUnmount, onMounted, watch } from 'vue'
import { musicVersionRevision } from '../stores/musicVersions.ts'
import { useMusicStore } from '../stores/useMusicStore.ts'

/** Lazy, component-owned reads. Rendering an unused search (including previews)
 * must not load a library. All local consumers share the same invalidation rules. */
export function useLibraryUnifiedSearch(
  onInvalidate?: (revision?: number) => void,
  options?: { listen?: boolean }
) {
  const store = useMusicStore()
  let source: ReturnType<typeof store.createUnifiedSearchSource> | null = null
  let minimumRevision = 0
  let disposed = false
  let unsubscribe: (() => void) | undefined
  function getSource() {
    if (disposed) throw new DOMException('Search was cancelled', 'AbortError')
    if (!source) {
      source = store.createUnifiedSearchSource()
      source.invalidate(minimumRevision)
    }
    return source
  }
  onMounted(() => {
    if (options?.listen === false) return
    unsubscribe = window.api?.library?.onChanged?.((change) => {
      if (change?.kind !== 'database' || change.revision <= minimumRevision) return
      minimumRevision = change.revision
      source?.invalidate(change.revision)
      onInvalidate?.(change.revision)
    })
  })
  watch(musicVersionRevision, () => onInvalidate?.())
  onBeforeUnmount(() => {
    disposed = true
    unsubscribe?.()
    source?.dispose()
  })
  return {
    search: (...args: Parameters<ReturnType<typeof getSource>['search']>) =>
      getSource().search(...args),
    searchLocal: (...args: Parameters<ReturnType<typeof getSource>['searchLocal']>) =>
      getSource().searchLocal(...args),
    confirm: (...args: Parameters<ReturnType<typeof getSource>['confirm']>) =>
      getSource().confirm(...args),
    searchAlbums: (...args: Parameters<ReturnType<typeof getSource>['searchAlbums']>) =>
      getSource().searchAlbums(...args),
    searchArtists: (...args: Parameters<ReturnType<typeof getSource>['searchArtists']>) =>
      getSource().searchArtists(...args),
    resolveAlbum: (...args: Parameters<ReturnType<typeof getSource>['resolveAlbum']>) =>
      getSource().resolveAlbum(...args)
  }
}
