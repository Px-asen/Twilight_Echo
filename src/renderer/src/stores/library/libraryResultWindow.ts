import { shallowRef } from 'vue'
import {
  LIBRARY_CACHE_PAGES,
  LIBRARY_PAGE_SIZE,
  type LibraryQuery
} from '../../../../shared/libraryDatabase.ts'
import type { LibraryResultPageCache, LibraryResultPage } from './libraryResultPageCache.ts'
export interface LibraryResultWindowState<P> {
  page: P | null
  total: number | null
  requestedPage: number
  loading: boolean
  error: string
  generation: number
}

/** A continuous viewport over the bounded result page cache. Only the latest
 * viewport is queued; stale reads still occupy their two transport slots. */
export function createLibraryResultWindow<P extends LibraryResultPage, Item>(
  cache: LibraryResultPageCache<P>,
  items: (page: P) => readonly Item[]
) {
  const state = shallowRef<LibraryResultWindowState<P>>({
    page: null,
    total: null,
    requestedPage: 0,
    loading: false,
    error: '',
    generation: 0
  })
  const pages = shallowRef<P[]>([])
  const selectionEpoch = shallowRef(0)
  let query: LibraryQuery | null = null
  let epoch = 0
  let minimumRevision = 0
  let presentationRevision: number | null = null
  let range = { start: 0, end: LIBRARY_PAGE_SIZE }
  let disposed = false
  let anchor: string | undefined
  let anchorError = ''
  let anchorResult: P | undefined
  const failures = new Map<number, string>()
  const jobs = new Set<{ epoch: number; page: number; anchor?: string }>()

  const needed = () => {
    const first = Math.floor(range.start / LIBRARY_PAGE_SIZE)
    const last = Math.floor(Math.max(range.start, range.end - 1) / LIBRARY_PAGE_SIZE)
    return Array.from({ length: last - first + 1 }, (_, i) => first + i)
  }
  function publish(located?: P): void {
    if (disposed || !query) return
    const indexes = needed()
    const cached = cache.state
    const missing = indexes.filter((index) => !cache.peek(index))
    // Keep the viewport until its replacement is ready, with row positions and
    // action fences on one revision. Failed pages still expose their read error.
    const retained = pages.value.filter(
      (page) =>
        indexes.includes(page.offset / LIBRARY_PAGE_SIZE) &&
        !failures.has(page.offset / LIBRARY_PAGE_SIZE)
    )
    const retainRevision =
      missing.length > 0 &&
      retained.some(
        (page) =>
          page.revision !== cached.revision || cache.peek(page.offset / LIBRARY_PAGE_SIZE) !== page
      )
    const next = indexes.flatMap((index) => {
      const before = retained.find((page) => page.offset === index * LIBRARY_PAGE_SIZE)
      const page = retainRevision ? before : (cache.peek(index) ?? before)
      return page ? [page] : []
    })
    const nextRevision = next[0]?.revision
    if (nextRevision !== undefined && nextRevision !== presentationRevision) {
      // A selection made on the retained rows must not acquire the replacement
      // page's newer revision when the display catches up.
      if (presentationRevision !== null) selectionEpoch.value++
      presentationRevision = nextRevision
    }
    if (pages.value.length !== next.length || next.some((page, i) => pages.value[i] !== page))
      pages.value = next
    const first = Math.floor(range.start / LIBRARY_PAGE_SIZE)
    const value = {
      ...state.value,
      page:
        located ??
        anchorResult ??
        next.find((page) => page.offset === first * LIBRARY_PAGE_SIZE) ??
        next[0] ??
        null,
      total: cached.revision === null ? state.value.total : cached.total,
      requestedPage: first,
      loading: !!anchor || missing.some((index) => !failures.has(index)),
      error: anchorError || missing.map((index) => failures.get(index)).find(Boolean) || ''
    }
    if (
      value.page !== state.value.page ||
      value.total !== state.value.total ||
      value.requestedPage !== state.value.requestedPage ||
      value.loading !== state.value.loading ||
      value.error !== state.value.error
    )
      state.value = value
  }
  function accept(page: P): void {
    if (page.revision > minimumRevision) selectionEpoch.value++
    minimumRevision = Math.max(minimumRevision, page.revision)
    if (range.start >= page.total && range.start !== 0) {
      range = {
        start: Math.max(0, page.total - 1),
        end: page.total
      }
      state.value = { ...state.value, generation: state.value.generation + 1 }
      failures.clear()
    }
  }
  function pump(): void {
    if (disposed || !query) return
    while (jobs.size < 2) {
      const index = needed().find(
        (index) =>
          !cache.peek(index) &&
          !failures.has(index) &&
          ![...jobs].some((job) => job.epoch === epoch && job.page === index)
      )
      if (anchor === undefined && index === undefined) break
      if (anchor !== undefined && [...jobs].some((job) => job.epoch === epoch && job.anchor)) break
      const job = { epoch, page: anchor === undefined ? index! : state.value.requestedPage, anchor }
      jobs.add(job)
      void (async () => {
        try {
          const page = await (job.anchor
            ? cache.locate(job.anchor, job.page)
            : cache.load(job.page))
          if (disposed || job.epoch !== epoch) return
          if (!page) throw new Error('曲库在读取期间发生变化，请重试')
          accept(page)
          if (job.anchor) {
            anchor = undefined
            anchorError = page.anchorIndex === -1 ? '当前歌曲不在此查询结果中' : ''
            anchorResult = page
            range = {
              start: page.offset,
              end: Math.min(page.total, page.offset + LIBRARY_PAGE_SIZE)
            }
          }
          publish(job.anchor ? page : undefined)
        } catch (error) {
          if (disposed || job.epoch !== epoch) return
          const message = error instanceof Error ? error.message : String(error)
          failures.delete(job.page)
          failures.set(job.page, message)
          while (failures.size > LIBRARY_CACHE_PAGES) failures.delete(failures.keys().next().value!)
          if (job.anchor) {
            anchor = undefined
            anchorError = message
          }
          publish()
        } finally {
          jobs.delete(job)
          if (!disposed) {
            pump()
            publish()
          }
        }
      })()
      // An anchor resolves the viewport itself. Do not issue an ordinary read
      // for the previous position until its authoritative position is known.
      if (anchor !== undefined) break
    }
  }
  function reset(preservePosition: boolean, preservePresentation = false): void {
    epoch++
    selectionEpoch.value++
    anchor = undefined
    anchorError = ''
    anchorResult = undefined
    failures.clear()
    if (!preservePresentation) {
      pages.value = []
      presentationRevision = null
    }
    if (!preservePosition) range = { start: 0, end: LIBRARY_PAGE_SIZE }
    state.value = {
      page: preservePresentation ? state.value.page : null,
      total: preservePosition ? state.value.total : null,
      requestedPage: Math.floor(range.start / LIBRARY_PAGE_SIZE),
      loading: !!query,
      error: '',
      generation: state.value.generation + 1
    }
    if (query) pump()
  }
  function setRange(start: number, end: number): void {
    if (disposed || !query || anchor !== undefined) return
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
      throw new Error('无效的曲库窗口')
    if (state.value.total !== null) {
      start = Math.min(start, Math.max(0, state.value.total - 1))
      end = Math.max(start, Math.min(end, state.value.total))
    }
    const before = needed().join(',')
    const first = Math.floor(start / LIBRARY_PAGE_SIZE)
    const last = Math.floor(Math.max(start, end - 1) / LIBRARY_PAGE_SIZE)
    if (last - first + 1 > cache.pageCapacity) throw new Error('曲库窗口超出缓存容量')
    range = { start, end }
    anchorResult = undefined
    if (before !== needed().join(',')) {
      anchorError = ''
      // Retain recent failures across page edges. Error/status layout changes
      // can move overscan across an edge without a deliberate user retry.
      state.value = { ...state.value, generation: state.value.generation + 1 }
    }
    for (const index of needed()) if (cache.peek(index)) void cache.load(index)
    publish()
    pump()
  }
  function pageForItem(track: Item): P | undefined {
    return pages.value.find((page) => items(page).includes(track))
  }
  return {
    state,
    pages,
    selectionEpoch,
    setQuery(
      value: LibraryQuery | null,
      preservePosition = false,
      preservePresentation = false
    ) {
      query = value ? structuredClone(value) : null
      cache.setQuery(query ?? {})
      reset(preservePosition, preservePresentation)
    },
    setRange,
    itemAt(index: number): Item | undefined {
      const page = pages.value.find(
        (page) => index >= page.offset && index < page.offset + items(page).length
      )
      return page ? items(page)[index - page.offset] : undefined
    },
    pageForItem,
    indexOfItem(track: Item): number {
      const page = pageForItem(track)
      return page ? page.offset + items(page).indexOf(track) : -1
    },
    locate(id: string) {
      if (disposed || !query || !id) return
      epoch++
      anchor = id
      anchorResult = undefined
      anchorError = ''
      failures.clear()
      state.value = {
        ...state.value,
        generation: state.value.generation + 1,
        loading: true,
        error: ''
      }
      pump()
    },
    retry() {
      cache.setQuery(query ?? {})
      reset(true)
    },
    invalidate(revision?: number) {
      if (revision !== undefined && revision <= minimumRevision) return
      if (revision !== undefined) {
        minimumRevision = revision
        cache.invalidate(revision)
      } else cache.setQuery(query ?? {})
      reset(true, true)
    },
    get cacheState() {
      return cache.state
    },
    dispose() {
      disposed = true
      epoch++
      cache.dispose()
      pages.value = []
    }
  }
}
