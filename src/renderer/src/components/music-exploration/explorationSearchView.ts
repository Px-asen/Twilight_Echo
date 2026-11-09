import { shallowRef } from 'vue'
import type { MusicExplorationPage, MusicExplorationQuery } from '../../../../shared/musicExploration.ts'

export function createExplorationSearchView(read: (query: MusicExplorationQuery, signal: AbortSignal) => Promise<MusicExplorationPage>, clock: {
  now?(): number; schedule?(callback: () => void, delay: number): () => void
} = {}) {
  const state = shallowRef<{ page: MusicExplorationPage | null; loading: boolean; error: string }>({ page: null, loading: false, error: '' })
  let current: AbortController | null = null, text = '', scope: 'library' | 'catalog' = 'library', disposed = false
  let refreshPending = false
  let cancelExpiry: (() => void) | null = null
  const now = clock.now ?? Date.now
  const schedule = clock.schedule ?? ((callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay)
    ;(timer as unknown as { unref?(): void }).unref?.()
    return () => clearTimeout(timer)
  })
  function expire(deadline: number) {
    const remaining = deadline - now()
    if (remaining > 0) { cancelExpiry = schedule(() => expire(deadline), Math.min(remaining, 2147483647)); return }
    current?.abort(); current = null; refreshPending = false; cancelExpiry = null
    state.value = { page: null, loading: false, error: '资料缓存已到期，请重新读取' }
  }
  async function load(offset = 0, options: { keepToken?: boolean; keepPage?: boolean } = {}) {
    if (disposed) return
    refreshPending = false
    current?.abort()
    const previousPage = options.keepPage ? state.value.page : null
    // A retained page keeps its original permission deadline while the new read is pending.
    if (!previousPage) { cancelExpiry?.(); cancelExpiry = null }
    const request = new AbortController(); current = request
    const token = options.keepToken ? state.value.page?.token : undefined
    state.value = { page: previousPage, loading: !!text, error: '' }
    if (!text) { current = null; return }
    try {
      const query: MusicExplorationQuery = { search: text, kinds: ['artist', 'work', 'performance'], scope, offset, limit: 10, ...(token ? { token } : {}) }
      let page = await read(query, request.signal)
      if (current !== request || disposed) return
      if (previousPage && offset > 0 && offset >= page.total) {
        const lastOffset = Math.max(0, Math.floor((page.total - 1) / 10) * 10)
        page = await read({ ...query, offset: lastOffset, token: page.token }, request.signal)
      }
      if (current !== request || disposed) return
      cancelExpiry?.(); cancelExpiry = null
      state.value = { page, loading: false, error: '' }
      if (page.token.expiresAt !== null) expire(page.token.expiresAt)
    } catch (error) {
      if (current === request && !disposed) {
        cancelExpiry?.(); cancelExpiry = null
        state.value = { page: null, loading: false, error: error instanceof Error ? error.message : String(error) }
      }
    } finally {
      if (current === request) {
        current = null
        // Cancelling a renderer request does not cancel SQL already executing.
        // Finish one read before following the latest metadata notification.
        const refresh = refreshPending && !state.value.error && !disposed
        refreshPending = false
        if (refresh) void load(state.value.page?.offset ?? 0, { keepPage: true })
      }
    }
  }
  return { state, setQuery(query: string, nextScope: 'library' | 'catalog' = 'library') { text = query.trim(); scope = nextScope; return load() },
    page(offset: number) { return load(offset, { keepToken: true }) },
    refresh() { return load(state.value.page?.offset ?? 0, { keepPage: true }) },
    invalidate() {
      if (disposed || !text || state.value.error) return
      if (current) refreshPending = true
      else void load(state.value.page?.offset ?? 0, { keepPage: true })
    },
    dispose() { disposed = true; refreshPending = false; current?.abort(); current = null; cancelExpiry?.(); cancelExpiry = null } }
}
