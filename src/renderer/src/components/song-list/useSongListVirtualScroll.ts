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
import { getSongListVirtualRange } from '@renderer/components/song-list/songListVirtualWindow.ts'

type UseSongListVirtualScrollOptions = {
  displayTracks: ComputedRef<Track[]>
  resetSources: unknown[]
  shouldResetOnSearch: ComputedRef<boolean>
  debouncedSearchQuery: Ref<string>
  viewKey?: ComputedRef<string>
  viewIdentity?: ComputedRef<string>
}

const ROW_HEIGHT = 68
const savedScrollPositions = new Map<string, number>()

export function useSongListVirtualScroll({
  displayTracks,
  resetSources,
  shouldResetOnSearch,
  debouncedSearchQuery,
  viewKey,
  viewIdentity
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

  const visibleRange = computed(() =>
    getSongListVirtualRange({
      trackCount: displayTracks.value.length,
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value,
      tableOffsetTop: tableOffsetTop.value,
      rowHeight
    })
  )

  const visibleTracks = computed(() => {
    return displayTracks.value.slice(visibleRange.value.start, visibleRange.value.end)
  })

  const totalHeight = computed(() => displayTracks.value.length * rowHeight)
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
      tableOffsetTop.value = tbodyRef.value.offsetTop
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
    void nextTick(() => {
      updateViewportHeight()
      if (containerRef.value) containerRef.value.scrollTop = scrollTop.value
      restorePending = false
    })
  }

  if (viewKey) {
    watch(
      viewKey,
      (key) => {
        savePosition()
        activeKey = key
        restorePending = true
        scrollTop.value = savedScrollPositions.get(key) ?? 0
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

  onUnmounted(() => {
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
    scrollTop,
    viewportHeight
  }
}
