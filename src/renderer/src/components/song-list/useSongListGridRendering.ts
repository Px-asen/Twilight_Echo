import { computed, nextTick, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { filterLocalGridItems } from '../../utils/localLibrarySearch'
import type { GridItem, LocalTransitionName } from './types'
import {
  estimateGridColumns,
  estimateGridColumnWidth,
  estimateGridRowStride,
  estimateAlbumGridRowStride,
  resolveGridLayoutMetrics,
  getSongListGridScrollTopForIndex,
  getSongListGridVirtualRange,
  GRID_OVERSCAN_ROWS
} from './songListVirtualWindow'

type UseSongListGridRenderingOptions = {
  category: () => string
  filter: () => string | null
  transitionName: () => 'page-down' | 'page-up'
  debouncedSearchQuery: ComputedRef<string> | { value: string }
  currentGridItems: ComputedRef<GridItem[]>
  showGrid: ComputedRef<boolean>
  updateViewportHeight: () => void
  containerRef: Ref<HTMLElement | null>
  scrollTop: Ref<number>
  viewportHeight: Ref<number>
}

export function useSongListGridRendering({
  category,
  filter,
  transitionName,
  debouncedSearchQuery,
  currentGridItems,
  showGrid,
  updateViewportHeight,
  containerRef,
  scrollTop,
  viewportHeight
}: UseSongListGridRenderingOptions): {
  renderedGridCount: ComputedRef<number>
  filteredGridItems: ComputedRef<GridItem[]>
  visibleGridItems: ComputedRef<GridItem[]>
  gridTotalCount: ComputedRef<number>
  gridWindowStart: ComputedRef<number>
  gridPaddingTop: ComputedRef<number>
  gridPaddingBottom: ComputedRef<number>
  showPlaylistCreateCard: ComputedRef<boolean>
  visibleArtists: ComputedRef<GridItem[]>
  visibleAlbums: ComputedRef<GridItem[]>
  visibleGenres: ComputedRef<GridItem[]>
  visiblePlaylists: ComputedRef<GridItem[]>
  visibleFolders: ComputedRef<GridItem[]>
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
  const gridOffsetTop = ref(0)
  let measureFrame: number | null = null
  let layoutObserver: ResizeObserver | null = null
  let observedGrid: HTMLElement | null = null
  let observedCard: HTMLElement | null = null

  const filteredGridItems = computed(() =>
    filterLocalGridItems(currentGridItems.value, debouncedSearchQuery.value)
  )
  const leadingSlotCount = computed(() => 0)
  const virtualItemCount = computed(() => filteredGridItems.value.length + leadingSlotCount.value)
  const gridTotalCount = computed(() => filteredGridItems.value.length)
  const localTransitionName = computed<LocalTransitionName>(() =>
    transitionName() === 'page-up' ? 'local-page-up' : 'local-page-down'
  )
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
  const visibleGridItems = computed(() =>
    filteredGridItems.value.slice(dataStart.value, dataEnd.value)
  )
  const gridWindowStart = computed(() => dataStart.value)
  const renderedGridCount = computed(() => dataEnd.value)
  const showPlaylistCreateCard = computed(
    () => leadingSlotCount.value > 0 && gridRange.value.start === 0
  )
  const gridPaddingTop = computed(() => gridRange.value.startRow * gridRange.value.rowStride)
  const totalRows = computed(() =>
    Math.ceil(virtualItemCount.value / Math.max(1, gridRange.value.columns))
  )
  const gridPaddingBottom = computed(() =>
    Math.max(0, (totalRows.value - gridRange.value.endRow) * gridRange.value.rowStride)
  )
  const visibleArtists = computed(() => (category() === 'artists' ? visibleGridItems.value : []))
  const visibleAlbums = computed(() => (category() === 'albums' ? visibleGridItems.value : []))
  const visibleGenres = computed(() => (category() === 'genres' ? visibleGridItems.value : []))
  const visiblePlaylists = computed(() =>
    category() === 'playlists' ? visibleGridItems.value : []
  )
  const visibleFolders = computed(() => (category() === 'folders' ? visibleGridItems.value : []))

  function estimateFromContainer(grid: HTMLElement | null = null, measuredColumns = 0): void {
    const container = containerRef.value
    const containerStyle = container ? window.getComputedStyle(container) : null
    const pixels = (
      style: CSSStyleDeclaration | null,
      property: string,
      fallback: number
    ): number => {
      const value = Number.parseFloat(style?.getPropertyValue(property) ?? '')
      return Number.isFinite(value) && value >= 0 ? value : fallback
    }
    const contentWidth = Math.max(
      1,
      (container?.clientWidth || 960) -
        pixels(containerStyle, 'padding-left', 0) -
        pixels(containerStyle, 'padding-right', 0)
    )
    const compact = document.documentElement.dataset.teLibraryDensity === 'compact'
    const metrics = resolveGridLayoutMetrics(contentWidth, compact)
    const gridStyle = grid ? window.getComputedStyle(grid) : null
    const width = grid
      ? Math.max(
          1,
          grid.clientWidth -
            pixels(gridStyle, 'padding-left', 0) -
            pixels(gridStyle, 'padding-right', 0)
        )
      : contentWidth
    metrics.minColumnWidth = pixels(gridStyle, '--te-grid-card-min', metrics.minColumnWidth)
    metrics.maxColumnWidth = pixels(gridStyle, '--te-grid-card-max', metrics.maxColumnWidth)
    metrics.padX = pixels(gridStyle, '--te-grid-card-pad-x', metrics.padX)
    metrics.padY = pixels(gridStyle, '--te-grid-card-pad-y', metrics.padY)
    metrics.columnGap = pixels(gridStyle, 'column-gap', metrics.columnGap)
    metrics.rowGap = pixels(gridStyle, 'row-gap', metrics.rowGap)
    gridColumns.value =
      measuredColumns || estimateGridColumns(width, metrics, virtualItemCount.value)
    const columnWidth = estimateGridColumnWidth(width, gridColumns.value, metrics)
    const fontSize = pixels(containerStyle, '--te-font-size-body', 14) || 14
    gridRowStride.value =
      category() === 'albums'
        ? estimateAlbumGridRowStride(columnWidth, metrics, fontSize)
        : estimateGridRowStride(columnWidth, metrics, fontSize)
  }

  function measureGridMetrics(): void {
    const container = containerRef.value
    if (!container || !showGrid.value) {
      estimateFromContainer()
      return
    }
    const grid = container.querySelector<HTMLElement>('.card-grid')
    if (!grid) {
      estimateFromContainer()
      return
    }
    gridOffsetTop.value = grid.offsetTop
    const previousColumns = gridColumns.value
    estimateFromContainer(grid)
    if (gridColumns.value !== previousColumns) {
      // Let the column binding lay out the cards before measuring their height.
      void nextTick(scheduleMeasure)
      return
    }
    const gridStyle = window.getComputedStyle(grid)
    const columns = gridStyle.gridTemplateColumns
      .split(/\s+/)
      .filter((track) => Number.isFinite(Number.parseFloat(track))).length
    if (columns > 0) gridColumns.value = columns
    else estimateFromContainer(grid)
    const firstCard = grid.querySelector<HTMLElement>('.artist-card, .album-card, .playlist-card')
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
      const rowGap = Number.parseFloat(gridStyle.rowGap)
      const gap = Number.isFinite(rowGap) ? rowGap : 22
      gridRowStride.value = Math.max(1, firstCard.getBoundingClientRect().height + gap)
      return
    }
    estimateFromContainer(grid, columns)
  }

  function scheduleMeasure(): void {
    if (measureFrame !== null) return
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

  watch([scrollTop, viewportHeight], () => {
    if (showGrid.value && gridOffsetTop.value === 0) scheduleMeasure()
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleMeasure)
  }

  onUnmounted(() => {
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
