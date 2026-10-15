import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  toValue,
  watch,
  type ComponentPublicInstance,
  type ComputedRef,
  type CSSProperties,
  type MaybeRefOrGetter,
  type ShallowRef
} from 'vue'
import {
  estimateGridColumns,
  estimateGridColumnWidth,
  resolveGridLayoutMetrics,
  type GridLayoutMetrics
} from '@renderer/components/song-list/songListVirtualWindow'

/** Bounded cover tracks share available space; a sparse collection stays at the leading edge. */
export function useBoundedGrid(
  itemCount: MaybeRefOrGetter<number>,
  options: {
    compact?: MaybeRefOrGetter<boolean>
    metrics?: (width: number, compact: boolean) => GridLayoutMetrics
  } = {}
): {
  gridElement: ShallowRef<HTMLElement | null>
  setGridElement: (element: Element | ComponentPublicInstance | null) => void
  gridStyle: ComputedRef<CSSProperties>
} {
  const gridElement = shallowRef<HTMLElement | null>(null)
  const width = ref(0)
  const compact = ref(false)
  let resizeObserver: ResizeObserver | undefined
  let densityObserver: MutationObserver | undefined

  function setGridElement(element: Element | ComponentPublicInstance | null): void {
    gridElement.value = element instanceof HTMLElement ? element : null
  }

  function measure(): void {
    const element = gridElement.value
    if (!element) return
    const style = getComputedStyle(element)
    width.value = Math.max(
      0,
      element.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
    )
  }

  const gridStyle = computed<CSSProperties>(() => {
    const metrics = (options.metrics ?? resolveGridLayoutMetrics)(
      width.value,
      options.compact === undefined ? compact.value : toValue(options.compact)
    )
    const count = Math.max(1, Math.floor(toValue(itemCount)) || 1)
    const columns = estimateGridColumns(width.value, metrics, count)
    const columnWidth = estimateGridColumnWidth(width.value, columns, metrics)
    return {
      gridTemplateColumns:
        width.value > 0
          ? `repeat(${columns}, minmax(0, ${columnWidth}px))`
          : `repeat(auto-fill, minmax(min(100%, ${metrics.minColumnWidth}px), ${metrics.maxColumnWidth}px))`,
      columnGap: `${metrics.columnGap}px`,
      rowGap: `${metrics.rowGap}px`
    }
  })

  watch(
    gridElement,
    (element) => {
      resizeObserver?.disconnect()
      if (element) resizeObserver?.observe(element)
      measure()
    },
    { flush: 'post' }
  )
  onMounted(() => {
    resizeObserver = new ResizeObserver(measure)
    if (gridElement.value) resizeObserver.observe(gridElement.value)
    const syncDensity = (): void => {
      compact.value = document.documentElement.dataset.teLibraryDensity === 'compact'
    }
    syncDensity()
    densityObserver = new MutationObserver(syncDensity)
    densityObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-te-library-density']
    })
    measure()
  })
  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    densityObserver?.disconnect()
  })
  return { gridElement, setGridElement, gridStyle }
}
