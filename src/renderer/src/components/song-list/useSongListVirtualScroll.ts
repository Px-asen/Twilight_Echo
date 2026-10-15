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

const ROW_HEIGHT = 56
const savedScrollPositions = new Map<string, { top: number; rowHeight: number; offset: number }>()

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
  rowHeight: ComputedRef<number>
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
  const renderedFontSize = ref(14)
  const renderedRowHeight = ref(ROW_HEIGHT)
  // Keep the DOM row, spacer and virtual range on the same scale. A larger
  // type setting must never leave two text lines inside a fixed-height box.
  // Density is read from the rendered surface so theme previews stay in sync.
  const rowHeight = computed(() => {
    const size = renderedFontSize.value
    const base = renderedRowHeight.value
    return Math.max(base, Math.ceil(((Number.isFinite(size) ? size : 14) * base) / 14))
  })
  let pendingRow: number | undefined
  let restoreRevision = 0
  function savedPosition(key: string): number {
    const saved = savedScrollPositions.get(key)
    pendingRow =
      saved && saved.top > saved.offset ? (saved.top - saved.offset) / saved.rowHeight : undefined
    if (!saved) return 0
    return saved.top > saved.offset
      ? saved.offset + ((saved.top - saved.offset) * rowHeight.value) / saved.rowHeight
      : saved.top
  }
  const scrollTop = ref(viewKey ? savedPosition(viewKey.value) : 0)
  let restorePending = !!viewKey
  let activeKey = viewKey?.value
  let activeIdentity = viewIdentity?.value
  const viewportHeight = ref(0)
  const tableOffsetTop = ref(0)
  let previousFontOffset: number | undefined

  const visibleRange = computed(() =>
    getSongListVirtualRange({
      trackCount: displayTracks.value.length,
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value,
      tableOffsetTop: tableOffsetTop.value,
      rowHeight: rowHeight.value
    })
  )

  const visibleTracks = computed(() => {
    return displayTracks.value.slice(visibleRange.value.start, visibleRange.value.end)
  })

  const totalHeight = computed(() => displayTracks.value.length * rowHeight.value)
  const paddingTop = computed(() => visibleRange.value.start * rowHeight.value)

  watch(
    rowHeight,
    (_height, previous) => {
      // Preserve the first visible recording, including the fraction within its
      // row, when a theme preview or the global text size changes.
      const offset = previousFontOffset ?? tableOffsetTop.value
      previousFontOffset = undefined
      const row =
        pendingRow ?? (scrollTop.value > offset ? (scrollTop.value - offset) / previous : undefined)
      restorePending = true
      restoreScrollAndMeasure(row)
    },
    { flush: 'pre' }
  )

  function onScroll(e: Event): void {
    if (restorePending) return
    const target = e.target as HTMLElement
    scrollTop.value = target.scrollTop
  }

  function updateViewportHeight(): void {
    if (containerRef.value) {
      viewportHeight.value = containerRef.value.clientHeight
      // Read the actual surface, including an iframe or unapplied local theme
      // draft. The application-wide theme store can describe a different font.
      const view = containerRef.value.ownerDocument?.defaultView
      if (view) {
        const style = view.getComputedStyle(containerRef.value)
        const size = Number.parseFloat(style.getPropertyValue('--te-font-size-body'))
        const height = Number.parseFloat(style.getPropertyValue('--te-library-row-height'))
        const nextSize = Number.isFinite(size) && size > 0 ? size : 14
        const nextHeight = Number.isFinite(height) && height >= 48 ? height : ROW_HEIGHT
        if (nextSize !== renderedFontSize.value || nextHeight !== renderedRowHeight.value) {
          previousFontOffset ??= tableOffsetTop.value
        }
        renderedFontSize.value = nextSize
        renderedRowHeight.value = nextHeight
      }
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
    restoreRevision++
    pendingRow = undefined
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
    savedScrollPositions.set(activeKey, {
      top:
        pendingRow === undefined
          ? scrollTop.value
          : tableOffsetTop.value + pendingRow * rowHeight.value,
      rowHeight: rowHeight.value,
      offset: tableOffsetTop.value
    })
    if (savedScrollPositions.size > 100) {
      savedScrollPositions.delete(savedScrollPositions.keys().next().value!)
    }
  }

  function restoreScrollAndMeasure(row = pendingRow): void {
    const revision = ++restoreRevision
    pendingRow = row
    void nextTick(() => {
      if (revision !== restoreRevision) return
      updateViewportHeight()
      if (row !== undefined) scrollTop.value = tableOffsetTop.value + row * rowHeight.value
      if (containerRef.value) containerRef.value.scrollTop = scrollTop.value
      if (containerRef.value) scrollTop.value = containerRef.value.scrollTop
      restorePending = false
      pendingRow = undefined
    })
  }

  if (viewKey) {
    watch(
      viewKey,
      (key) => {
        savePosition()
        restoreRevision++
        activeKey = key
        restorePending = true
        scrollTop.value = savedPosition(key)
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
  let typographyObserver: MutationObserver | undefined
  watch(
    [containerRef, tbodyRef, viewKey ?? computed(() => '')],
    () => {
      void nextTick(() => {
        resizeObserver?.disconnect()
        typographyObserver?.disconnect()
        updateViewportHeight()
        if (containerRef.value && typeof MutationObserver !== 'undefined') {
          const fonts = new Map<HTMLElement, string>()
          const layoutSignature = (element: HTMLElement): string =>
            ['--te-font-size-body', '--te-library-row-height']
              .map((property) => element.style.getPropertyValue(property))
              .join('|')
          typographyObserver = new MutationObserver((mutations) => {
            let changed = false
            for (const mutation of mutations) {
              const element = mutation.target as HTMLElement
              const font = layoutSignature(element)
              const previous = fonts.get(element)
              fonts.set(element, font)
              changed ||= mutation.attributeName !== 'style' || font !== previous
            }
            if (changed) updateViewportHeight()
          })
          for (
            let element: HTMLElement | null = containerRef.value;
            element;
            element = element.parentElement
          ) {
            fonts.set(element, layoutSignature(element))
            typographyObserver.observe(element, {
              attributes: true,
              attributeFilter: ['style', 'class', 'data-theme', 'data-te-library-density']
            })
          }
        }
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
    typographyObserver?.disconnect()
    savePosition()
    restoreRevision++
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
