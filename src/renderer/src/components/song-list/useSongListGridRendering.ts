import { computed, nextTick, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { filterLocalGridItems } from '../../utils/localLibrarySearch.ts'
import type { GridItem, LocalTransitionName } from './types'
import type { PageMotionName } from '../../app/motion/policy'
import {
  estimateGridColumns,
  estimateGridRowStride,
  estimateAlbumGridRowStride,
  getSongListGridScrollTopForIndex,
  getSongListGridVirtualRange,
  GRID_OVERSCAN_ROWS
} from './songListVirtualWindow.ts'

type UseSongListGridRenderingOptions<T extends GridItem> = {
  category: () => string
  filter: () => string | null
  transitionName: () => PageMotionName
  debouncedSearchQuery: ComputedRef<string> | { value: string }
  currentGridItems: ComputedRef<T[]>
  itemCount?: ComputedRef<number>
  itemAt?: (index: number) => T | undefined
  /** SQL has already matched complete collection members; summaries have no tracks. */
  serverFiltered?: ComputedRef<boolean>
  showGrid: ComputedRef<boolean>
  updateViewportHeight: () => void
  containerRef: Ref<HTMLElement | null>
  scrollTop: Ref<number>
  viewportHeight: Ref<number>
}

export function useSongListGridRendering<T extends GridItem = GridItem>({
  category,
  filter,
  transitionName,
  debouncedSearchQuery,
  currentGridItems,
  itemCount,
  itemAt,
  serverFiltered,
  showGrid,
  updateViewportHeight,
  containerRef,
  scrollTop,
  viewportHeight
}: UseSongListGridRenderingOptions<T>): {
  renderedGridCount: ComputedRef<number>
  filteredGridItems: ComputedRef<T[]>
  visibleGridItems: ComputedRef<T[]>
  gridTotalCount: ComputedRef<number>
  gridWindowStart: ComputedRef<number>
  gridPaddingTop: ComputedRef<number>
  gridPaddingBottom: ComputedRef<number>
  showPlaylistCreateCard: ComputedRef<boolean>
  visibleArtists: ComputedRef<T[]>
  visibleAlbums: ComputedRef<T[]>
  visibleGenres: ComputedRef<T[]>
  visiblePlaylists: ComputedRef<T[]>
  visibleFolders: ComputedRef<T[]>
  visibleGridSlots: ComputedRef<Array<{ index: number; item: T | undefined }>>
  gridDataRange: ComputedRef<{ start: number; end: number }>
  gridRowGap: Ref<number>
  gridColumns: Ref<number>
  gridRowStride: Ref<number>
  gridOffsetTop: Ref<number>
  renderGridThroughIndex: (index: number) => void
  measureGridMetrics: () => void
  localTransitionName: ComputedRef<LocalTransitionName>
  viewKey: ComputedRef<string>
  isSwitching: Ref<boolean>
  onViewBeforeLeave: () => void
  finishViewSwitch: () => void
} {
  const isSwitching = ref(false)
  const gridColumns = ref(1)
  const gridRowStride = ref(280)
  const gridRowGap = ref(22)
  const gridOffsetTop = ref(0)
  let measureFrame: number | null = null
  let layoutObserver: ResizeObserver | null = null
  let observedGrid: HTMLElement | null = null
  let observedCard: HTMLElement | null = null
  let measuredWidth = -1
  let measuredCategory = ''
  let disposed = false

  const filteredGridItems = computed(() =>
    serverFiltered?.value
      ? currentGridItems.value
      : filterLocalGridItems(currentGridItems.value, debouncedSearchQuery.value)
  )
  const leadingSlotCount = computed(() => (category() === 'playlists' ? 1 : 0))
  const gridTotalCount = computed(() =>
    serverFiltered?.value && itemCount ? itemCount.value : filteredGridItems.value.length
  )
  const virtualItemCount = computed(() => gridTotalCount.value + leadingSlotCount.value)
  const localTransitionName = computed<LocalTransitionName>(() => `local-${transitionName()}`)
  const viewKey = computed(() =>
    showGrid.value ? `grid-${category()}` : `table-${category()}-${filter() ?? 'root'}`
  )

  const gridRange = computed(() =>
    getSongListGridVirtualRange({
      itemCount: virtualItemCount.value,
      scrollTop: scrollTop.value,
      viewportHeight: viewportHeight.value || 720,
      gridOffsetTop: gridOffsetTop.value,
      columns: gridColumns.value,
      rowStride: gridRowStride.value,
      overscanRows: GRID_OVERSCAN_ROWS
    })
  )

  const dataStart = computed(() => Math.max(0, gridRange.value.start - leadingSlotCount.value))
  const dataEnd = computed(() =>
    Math.max(dataStart.value, gridRange.value.end - leadingSlotCount.value)
  )
  const gridDataRange = computed(() => ({ start: dataStart.value, end: dataEnd.value }))
  const visibleGridSlots = computed(() =>
    Array.from({ length: dataEnd.value - dataStart.value }, (_, offset) => {
      const index = dataStart.value + offset
      return {
        index,
        item: serverFiltered?.value && itemAt ? itemAt(index) : filteredGridItems.value[index]
      }
    })
  )
  const visibleGridItems = computed(() =>
    visibleGridSlots.value.flatMap(({ item }) => (item ? [item] : []))
  )
  const gridWindowStart = computed(() => dataStart.value)
  const renderedGridCount = computed(() => dataEnd.value)
  const showPlaylistCreateCard = computed(
    () => leadingSlotCount.value > 0 && gridRange.value.start === 0
  )
  const gridPaddingTop = computed(() =>
    Math.max(0, gridRange.value.startRow * gridRange.value.rowStride - gridRowGap.value)
  )
  const totalRows = computed(() =>
    Math.ceil(virtualItemCount.value / Math.max(1, gridRange.value.columns))
  )
  const gridPaddingBottom = computed(() =>
    Math.max(
      0,
      (totalRows.value - gridRange.value.endRow) * gridRange.value.rowStride - gridRowGap.value
    )
  )
  const visibleArtists = computed(() => (category() === 'artists' ? visibleGridItems.value : []))
  const visibleAlbums = computed(() => (category() === 'albums' ? visibleGridItems.value : []))
  const visibleGenres = computed(() => (category() === 'genres' ? visibleGridItems.value : []))
  const visiblePlaylists = computed(() =>
    category() === 'playlists' ? visibleGridItems.value : []
  )
  const visibleFolders = computed(() => (category() === 'folders' ? visibleGridItems.value : []))

  function estimateFromContainer(preserveColumns = false): void {
    const container = containerRef.value
    const width = container?.clientWidth || 960
    const viewportWidth = window.innerWidth || width
    if (!preserveColumns) gridColumns.value = estimateGridColumns(width, viewportWidth)
    const columnWidth = width / Math.max(1, gridColumns.value)
    const fontSize = container
      ? Number.parseFloat(
          window.getComputedStyle(container).getPropertyValue('--te-font-size-body')
        ) || 14
      : 14
    gridRowStride.value =
      category() === 'albums'
        ? estimateAlbumGridRowStride(columnWidth, viewportWidth, fontSize)
        : estimateGridRowStride(columnWidth, viewportWidth)
  }

  function measureGridMetrics(): void {
    const container = containerRef.value
    if (!container || !showGrid.value) {
      estimateFromContainer()
      return
    }
    const grid = container.querySelector<HTMLElement>(
      ':scope > :not([data-motion-snapshot]) .card-grid'
    )
    if (!grid) {
      estimateFromContainer()
      return
    }
    gridOffsetTop.value =
      grid.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      container.clientTop
    gridRowGap.value = Number.parseFloat(window.getComputedStyle(grid).rowGap) || 0
    const template = window.getComputedStyle(grid).gridTemplateColumns
    const columns = template.split(/\s+/).filter(Boolean).length
    if (columns > 0) gridColumns.value = columns
    const firstCard = grid.querySelector<HTMLElement>(
      '.artist-card, .album-card, .genre-card, .playlist-card, .aggregate-card'
    )
    if (
      typeof ResizeObserver !== 'undefined' &&
      (grid !== observedGrid || firstCard !== observedCard)
    ) {
      layoutObserver ??= new ResizeObserver(() => {
        scheduleMeasure()
        updateViewportHeight()
      })
      layoutObserver.disconnect()
      layoutObserver.observe(container)
      layoutObserver.observe(grid)
      if (container.firstElementChild) layoutObserver.observe(container.firstElementChild)
      if (firstCard) layoutObserver.observe(firstCard)
      observedGrid = grid
      observedCard = firstCard
    }
    if (firstCard) {
      measuredWidth = grid.clientWidth
      measuredCategory = category()
      gridRowStride.value = Math.max(1, firstCard.getBoundingClientRect().height + gridRowGap.value)
      return
    }
    if (measuredWidth !== grid.clientWidth || measuredCategory !== category()) {
      estimateFromContainer(true)
      measuredWidth = grid.clientWidth
      measuredCategory = category()
    }
  }

  function scheduleMeasure(): void {
    if (disposed || measureFrame !== null) return
    measureFrame = window.requestAnimationFrame(() => {
      measureFrame = null
      measureGridMetrics()
    })
  }

  function renderGridThroughIndex(index: number): void {
    if (!showGrid.value || index < 0) return
    const container = containerRef.value
    const virtualIndex = index + leadingSlotCount.value
    const top = getSongListGridScrollTopForIndex(
      virtualIndex,
      virtualItemCount.value,
      gridColumns.value,
      gridRowStride.value,
      gridOffsetTop.value
    )
    if (container) {
      container.scrollTop = top
      scrollTop.value = top
    }
  }

  function onViewBeforeLeave(): void {
    isSwitching.value = true
  }

  function finishViewSwitch(): void {
    isSwitching.value = false
    if (showGrid.value) {
      void nextTick(() => {
        measureGridMetrics()
        updateViewportHeight()
      })
    } else {
      requestAnimationFrame(updateViewportHeight)
    }
  }

  watch(
    [category, filter, gridTotalCount, showGrid],
    () => {
      if (!showGrid.value) return
      void nextTick(scheduleMeasure)
    },
    { immediate: true, flush: 'post' }
  )

  watch(
    () => visibleGridSlots.value.find(({ item }) => item)?.item,
    () => {
      if (showGrid.value) void nextTick(scheduleMeasure)
    },
    { flush: 'post' }
  )

  watch([scrollTop, viewportHeight], () => {
    if (showGrid.value && gridOffsetTop.value === 0) scheduleMeasure()
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleMeasure)
  }

  onScopeDispose(() => {
    disposed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', scheduleMeasure)
    }
    if (measureFrame !== null) window.cancelAnimationFrame(measureFrame)
    layoutObserver?.disconnect()
    measureFrame = null
  })

  return {
    renderedGridCount,
    filteredGridItems,
    visibleGridItems,
    gridTotalCount,
    gridWindowStart,
    visibleGridSlots,
    gridDataRange,
    gridRowGap,
    gridPaddingTop,
    gridPaddingBottom,
    showPlaylistCreateCard,
    visibleArtists,
    visibleAlbums,
    visibleGenres,
    visiblePlaylists,
    visibleFolders,
    gridColumns,
    gridRowStride,
    gridOffsetTop,
    renderGridThroughIndex,
    measureGridMetrics,
    localTransitionName,
    viewKey,
    isSwitching,
    onViewBeforeLeave,
    finishViewSwitch
  }
}
