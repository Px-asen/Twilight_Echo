import {
  computed,
  getCurrentInstance,
  nextTick,
  onMounted,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  type Ref
} from 'vue'
import {
  LIBRARY_PAGE_SIZE,
  type LibraryQueuePage,
  type LibraryQueueSnapshot
} from '../../../../shared/libraryDatabase.ts'
import type { CoreQueuePage } from '../../../../shared/coreViews.ts'
import {
  getPlaybackQueueWindow,
  getPlaybackQueueScrollTopForIndex,
  PLAYBACK_QUEUE_ROW_HEIGHT,
  type PlaybackQueueDisplayItem
} from '../../utils/playbackQueueVirtualization.ts'

// Below browser layout height limits even for millions of CUE occurrences.
export const LIBRARY_QUEUE_MAX_SCROLL_HEIGHT = 16_000_000
export interface LibraryQueueRow extends PlaybackQueueDisplayItem {
  state: 'ready' | 'loading' | 'missing'
  queueId: string
  revision: number
}

export function libraryQueueScrollGeometry(
  total: number,
  viewportHeight: number,
  scrollTop: number
) {
  const logicalHeight = total * PLAYBACK_QUEUE_ROW_HEIGHT
  const height = Math.min(logicalHeight, LIBRARY_QUEUE_MAX_SCROLL_HEIGHT)
  const physicalRange = Math.max(0, height - viewportHeight)
  const logicalRange = Math.max(0, logicalHeight - viewportHeight)
  const scale = physicalRange > 0 ? logicalRange / physicalRange : 1
  const top = Math.max(0, Math.min(physicalRange, scrollTop))
  const logicalTop = top * scale
  const range = getPlaybackQueueWindow(total, logicalTop, viewportHeight)
  return {
    height,
    scale,
    range,
    translateY: top + range.start * PLAYBACK_QUEUE_ROW_HEIGHT - logicalTop
  }
}

/** The drawer owns only visible lightweight rows, not another detail cache.
 * Two in-flight page reads are shared with the player's bounded source. */
export function useLibraryQueueViewport(options: {
  snapshot: Readonly<Ref<LibraryQueueSnapshot | null>>
  contentRevision: Readonly<Ref<number>>
  readPage: (page: number) => Promise<LibraryQueuePage | CoreQueuePage | null>
}) {
  const containerRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(0),
    viewportHeight = ref(324)
  const pages = shallowRef(new Map<number, LibraryQueueRow[]>())
  const activeReads = ref(0),
    error = ref('')
  const loading = computed(() => activeReads.value > 0)
  const requests = new Set<string>(),
    failed = new Set<number>()
  let epoch = 0,
    disposed = false,
    observedRevision = options.contentRevision.value
  let observer: ResizeObserver | null = null
  const geometry = computed(() =>
    libraryQueueScrollGeometry(
      options.snapshot.value?.total ?? 0,
      viewportHeight.value,
      scrollTop.value
    )
  )
  const desiredPages = computed(() => {
    const { start, end } = geometry.value.range
    if (end <= start) return []
    return Array.from(
      {
        length:
          Math.floor((end - 1) / LIBRARY_PAGE_SIZE) - Math.floor(start / LIBRARY_PAGE_SIZE) + 1
      },
      (_, index) => Math.floor(start / LIBRARY_PAGE_SIZE) + index
    )
  })
  const visibleItems = computed<LibraryQueueRow[]>(() => {
    const rows: LibraryQueueRow[] = []
    const { start, end } = geometry.value.range
    for (let index = start; index < end; index++) {
      const row = pages.value.get(Math.floor(index / LIBRARY_PAGE_SIZE))?.[
        index % LIBRARY_PAGE_SIZE
      ]
      rows.push(
        row ?? {
          index,
          id: '',
          queueEntryId: `loading:${index}`,
          title: '正在读取歌曲…',
          artist: '',
          cover: null,
          state: 'loading',
          queueId: options.snapshot.value?.id ?? '',
          revision: options.snapshot.value?.revision ?? -1
        }
      )
    }
    return rows
  })

  function pump(): void {
    if (disposed || !options.snapshot.value) return
    const desired = new Set(desiredPages.value)
    if ([...pages.value.keys()].some((page) => !desired.has(page)))
      pages.value = new Map([...pages.value].filter(([page]) => desired.has(page)))
    for (const page of desired) {
      if (requests.size >= 2) break
      const key = `${epoch}:${page}`
      if (pages.value.has(page) || failed.has(page) || requests.has(key)) continue
      const generation = epoch,
        snapshot = { ...options.snapshot.value }
      requests.add(key)
      activeReads.value = requests.size
      void options
        .readPage(page)
        .then((result) => {
          if (disposed || generation !== epoch) return
          if (!result || result.revision !== snapshot.revision) {
            failed.add(page)
            error.value = '播放队列已变化，请刷新后重试'
            return
          }
          if (result.libraryRevision < observedRevision) {
            failed.add(page)
            error.value = '曲库正在更新，请刷新后重试'
            return
          }
          if (result.libraryRevision > observedRevision) {
            observedRevision = result.libraryRevision
            pages.value = new Map()
          }
          if (!desiredPages.value.includes(page)) return
          const rows: LibraryQueueRow[] = result.items.map((item): LibraryQueueRow => ({
            index: item.position,
            queueEntryId: item.queueEntryId,
            id: item.track?.id ?? '',
            title: item.track
              ? String(item.track.title ?? ('fileName' in item.track ? item.track.fileName : null) ?? item.track.id)
              : '曲目已从曲库移除',
            artist: item.track ? String(item.track.artist ?? '未知艺术家') : '可从队列移除',
            cover: typeof item.track?.cover === 'string' ? item.track.cover : null,
            state: item.track ? 'ready' : 'missing',
            queueId: snapshot.id,
            revision: snapshot.revision
          }))
          pages.value = new Map(pages.value).set(page, rows)
        })
        .catch((reason) => {
          if (disposed || generation !== epoch) return
          failed.add(page)
          error.value = reason instanceof Error ? reason.message : String(reason)
        })
        .finally(() => {
          requests.delete(key)
          activeReads.value = requests.size
          pump()
        })
    }
  }

  function reset(): void {
    epoch++
    pages.value = new Map()
    failed.clear()
    error.value = ''
    observedRevision = options.contentRevision.value
    pump()
  }

  function updateViewport(): void {
    const container = containerRef.value
    if (!container) return
    const style = getComputedStyle(container)
    viewportHeight.value =
      container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  }

  function onScroll(event: Event): void {
    scrollTop.value = (event.target as HTMLElement).scrollTop
  }

  function scrollToIndex(index: number): void {
    const container = containerRef.value,
      total = options.snapshot.value?.total ?? 0
    if (!container || index < 0 || index >= total) return
    const logicalTop = getPlaybackQueueScrollTopForIndex(index, total, viewportHeight.value)
    container.scrollTop = logicalTop / geometry.value.scale
    scrollTop.value = container.scrollTop
  }

  function scrollToCurrent(): void {
    scrollToIndex(options.snapshot.value?.index ?? -1)
  }

  watch(
    // Core publishes fresh snapshot objects for progress ticks. Compare the
    // individual versions so unchanged rows and their decoded covers stay mounted.
    [
      () => options.snapshot.value?.id,
      () => options.snapshot.value?.revision,
      () => options.contentRevision.value
    ],
    reset,
    { immediate: true, flush: 'sync' }
  )
  watch(desiredPages, pump)
  watch(
    [() => options.snapshot.value?.id, () => options.snapshot.value?.index],
    () => {
      void nextTick(scrollToCurrent)
    }
  )
  watch(
    containerRef,
    (container) => {
      observer?.disconnect()
      updateViewport()
      if (container && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(updateViewport)
        observer.observe(container)
      }
    },
    { flush: 'post' }
  )
  if (getCurrentInstance())
    onMounted(() => {
      updateViewport()
      void nextTick(scrollToCurrent)
    })
  onScopeDispose(() => {
    disposed = true
    epoch++
    observer?.disconnect()
    pages.value = new Map()
  })

  return {
    containerRef,
    visibleItems,
    loading,
    error,
    onScroll,
    scrollToCurrent,
    scrollToIndex,
    retry: reset,
    totalHeight: computed(() => geometry.value.height),
    translateY: computed(() => geometry.value.translateY),
    diagnostics: computed(() => ({
      pages: pages.value.size,
      rows: [...pages.value.values()].reduce((count, rows) => count + rows.length, 0),
      activeReads: activeReads.value
    }))
  }
}
