import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import type { ScrollViewport } from '../../utils/scrollToTopButton'
import {
  getSongListTrackScrollTopForIndex,
  getSongListVirtualRange
} from '@renderer/components/song-list/songListVirtualWindow.ts'

type UseSongListVirtualScrollOptions = {
  displayTracks: ComputedRef<Track[]>
  resetSources: unknown[]
  shouldResetOnSearch: ComputedRef<boolean>
  debouncedSearchQuery: Ref<string>
  viewKey?: ComputedRef<string>
  viewIdentity?: ComputedRef<string>
  /** Start a new query/section at its content controls, without revisiting a tall detail header. */
  resetScrollTop?: () => number
  /** The full query count, independent of the bounded loaded Track window. */
  itemCount?: ComputedRef<number>
  restoreReady?: ComputedRef<boolean>
}

const ROW_HEIGHT = 68
const savedScrollPositions = new Map<string, number>()

export function useSongListVirtualScroll({
  displayTracks,
  resetSources,
  shouldResetOnSearch,
  debouncedSearchQuery,
  viewKey,
  viewIdentity,
  resetScrollTop,
  itemCount,
  restoreReady
}: UseSongListVirtualScrollOptions): {
  containerRef: Ref<HTMLElement | null>
  tbodyRef: Ref<HTMLElement | null>
  rowHeight: number
  visibleRange: ComputedRef<{ start: number; end: number }>
  visibleTracks: ComputedRef<Track[]>
  totalHeight: ComputedRef<number>
  paddingTop: ComputedRef<number>
  onScroll: (e: Event) => void
  updateViewportHeight: () => void
  resetScrollAndMeasure: () => void
  restoreScrollAndMeasure: () => void
  scrollToTrack: (index: number, viewport?: ScrollViewport) => void
  scrollTop: Ref<number>
  viewportHeight: Ref<number>
} {
  const containerRef = ref<HTMLElement | null>(null)
  const tbodyRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(viewKey ? (savedScrollPositions.get(viewKey.value) ?? 0) : 0)
  let restorePending = !!viewKey
  let activeKey = viewKey?.value
  let activeIdentity = viewIdentity?.value
  const viewportHeight = ref(0)
  const tableOffsetTop = ref(0)
  const rowHeight = ROW_HEIGHT
  const trackCount = computed(() => itemCount?.value ?? displayTracks.value.length)

  const visibleRange = computed(() =>
    getSongListVirtualRange({
      trackCount: trackCount.value,
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value,
      tableOffsetTop: tableOffsetTop.value,
      rowHeight
    })
  )

  const visibleTracks = computed(() => {
    return displayTracks.value.slice(visibleRange.value.start, visibleRange.value.end)
  })

  const totalHeight = computed(() => trackCount.value * rowHeight)
  const paddingTop = computed(() => visibleRange.value.start * rowHeight)

  function onScroll(e: Event): void {
    if (restorePending) return
    const target = e.target as HTMLElement
    scrollTop.value = target.scrollTop
  }

  function updateViewportHeight(): void {
    if (containerRef.value) {
      viewportHeight.value = containerRef.value.clientHeight
    }
    if (containerRef.value && tbodyRef.value) {
      const container = containerRef.value
      tableOffsetTop.value =
        tbodyRef.value.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        container.clientTop
    } else {
      tableOffsetTop.value = 0
    }
  }

  function resetScrollAndMeasure(): void {
    restorePending = false
    if (containerRef.value) {
      containerRef.value.scrollTop = 0
    }
    scrollTop.value = 0
    requestAnimationFrame(updateViewportHeight)
  }

  function savePosition(): void {
    if (!activeKey) return
    savedScrollPositions.delete(activeKey)
    savedScrollPositions.set(activeKey, scrollTop.value)
    if (savedScrollPositions.size > 100) {
      savedScrollPositions.delete(savedScrollPositions.keys().next().value!)
    }
  }

  function restoreScrollAndMeasure(): void {
    if (restoreReady && !restoreReady.value) return
    void nextTick(() => {
      if (restoreReady && !restoreReady.value) return
      updateViewportHeight()
      if (containerRef.value) containerRef.value.scrollTop = scrollTop.value
      if (containerRef.value) scrollTop.value = containerRef.value.scrollTop
      restorePending = false
    })
  }

  function scrollToTrack(index: number, viewport?: ScrollViewport): void {
    const container = containerRef.value
    if (!container) return
    updateViewportHeight()
    const nextTop = viewport
      ? tableOffsetTop.value + (index + 0.5) * rowHeight -
        ((viewport.top + viewport.bottom) / 2 - container.getBoundingClientRect().top)
      : getSongListTrackScrollTopForIndex({
      index,
      trackCount: trackCount.value,
      viewportHeight: container.clientHeight,
      tableOffsetTop: tableOffsetTop.value,
      rowHeight
    })
    container.scrollTop = nextTop
    scrollTop.value = container.scrollTop
  }

  if (restoreReady)
    watch(
      restoreReady,
      (ready) => {
        if (ready && restorePending) restoreScrollAndMeasure()
      },
      { flush: 'post' }
    )

  if (viewKey) {
    watch(
      viewKey,
      (key) => {
        savePosition()
        activeKey = key
        restorePending = true
        scrollTop.value =
          savedScrollPositions.get(key) ??
          (activeIdentity === viewIdentity?.value ? Math.max(0, resetScrollTop?.() ?? 0) : 0)
        if (activeIdentity === viewIdentity?.value) restoreScrollAndMeasure()
        activeIdentity = viewIdentity?.value
      },
      { flush: 'pre' }
    )
  }

  onMounted(() => {
    updateViewportHeight()
    restoreScrollAndMeasure()
    window.addEventListener('resize', updateViewportHeight)
  })

  let resizeObserver: ResizeObserver | undefined
  watch(
    [containerRef, tbodyRef, viewKey ?? computed(() => '')],
    () => {
      void nextTick(() => {
        resizeObserver?.disconnect()
        if (typeof ResizeObserver === 'undefined' || !containerRef.value) return
        resizeObserver = new ResizeObserver(updateViewportHeight)
        resizeObserver.observe(containerRef.value)
        if (tbodyRef.value) resizeObserver.observe(tbodyRef.value)
        const view = containerRef.value.firstElementChild
        if (view) resizeObserver.observe(view)
      })
    },
    { flush: 'post' }
  )

  onUnmounted(() => {
    resizeObserver?.disconnect()
    savePosition()
    window.removeEventListener('resize', updateViewportHeight)
  })

  watch(resetSources, resetScrollAndMeasure, { flush: 'post' })

  watch(
    debouncedSearchQuery,
    () => {
      if (!viewKey && shouldResetOnSearch.value) {
        resetScrollAndMeasure()
      }
    },
    { flush: 'post' }
  )

  return {
    containerRef,
    tbodyRef,
    rowHeight,
    visibleRange,
    visibleTracks,
    totalHeight,
    paddingTop,
    onScroll,
    updateViewportHeight,
    resetScrollAndMeasure,
    restoreScrollAndMeasure,
    scrollToTrack,
    scrollTop,
    viewportHeight
  }
}
