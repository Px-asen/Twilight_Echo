import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { getPlaybackQueueWindow } from '../../utils/playbackQueueVirtualization.ts'

const STREAMING_ROW_HEIGHT = 64
const STREAMING_OVERSCAN = 8

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let current = el?.parentElement ?? null
  while (current) {
    const style = window.getComputedStyle(current)
    if (
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      current.scrollHeight > current.clientHeight
    ) {
      return current
    }
    current = current.parentElement
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

export function useProgressiveList<T>(
  source: () => readonly T[],
  options: { initial?: number; step?: number; rowHeight?: number; overscan?: number } = {}
): {
  visibleItems: ComputedRef<T[]>
  visibleStart: ComputedRef<number>
  paddingTop: ComputedRef<number>
  totalHeight: ComputedRef<number>
  hasMoreToRender: ComputedRef<boolean>
  listRef: (el: unknown) => void
  scrollToIndex: (index: number) => void
} {
  const rowHeight = ref(options.rowHeight ?? STREAMING_ROW_HEIGHT)
  const overscan = options.overscan ?? STREAMING_OVERSCAN
  const items = computed(source)
  const scrollTop = ref(0)
  const viewportHeight = ref(720)
  const listOffsetTop = ref(0)
  let rowObserver: ResizeObserver | null = null
  let observedRow: Element | null = null
  let listEl: HTMLElement | null = null
  let scrollRoot: HTMLElement | null = null

  function onScroll(): void {
    if (!scrollRoot) return
    scrollTop.value = scrollRoot.scrollTop
  }

  function bindScrollRoot(element: HTMLElement | null): void {
    if (scrollRoot === element) return
    if (scrollRoot) scrollRoot.removeEventListener('scroll', onScroll)
    scrollRoot = element
    if (scrollRoot) scrollRoot.addEventListener('scroll', onScroll, { passive: true })
  }

  function measure(): void {
    if (!listEl) return
    if (!scrollRoot) bindScrollRoot(findScrollParent(listEl))
    if (!scrollRoot) return
    const firstRow = listEl.firstElementChild
    if (firstRow && observedRow !== firstRow) {
      rowObserver?.disconnect()
      rowObserver?.observe(firstRow)
      observedRow = firstRow
    }
    const actualRowHeight = firstRow?.getBoundingClientRect().height
    if (actualRowHeight && Math.abs(actualRowHeight - rowHeight.value) > 0.1) {
      rowHeight.value = actualRowHeight
    }
    const listRect = listEl.getBoundingClientRect()
    const rootRect = scrollRoot.getBoundingClientRect()
    listOffsetTop.value = listRect.top - rootRect.top + scrollRoot.scrollTop
    viewportHeight.value = scrollRoot.clientHeight
    scrollTop.value = scrollRoot.scrollTop
  }

  function listRef(el: unknown): void {
    listEl = el instanceof HTMLElement ? el : null
    bindScrollRoot(findScrollParent(listEl))
    measure()
  }

  function scrollToIndex(index: number): void {
    measure()
    if (!scrollRoot || index < 0 || index >= items.value.length) return
    scrollRoot.scrollTo({
      top: Math.max(
        0,
        listOffsetTop.value + index * rowHeight.value - (viewportHeight.value - rowHeight.value) / 2
      ),
      behavior: 'instant'
    })
    onScroll()
  }

  const windowRange = computed(() =>
    getPlaybackQueueWindow(
      items.value.length,
      Math.max(0, scrollTop.value - listOffsetTop.value),
      viewportHeight.value,
      rowHeight.value,
      overscan
    )
  )
  const visibleStart = computed(() => windowRange.value.start)
  const visibleItems = computed(() =>
    items.value.slice(windowRange.value.start, windowRange.value.end)
  )
  const paddingTop = computed(() => windowRange.value.start * rowHeight.value)
  const totalHeight = computed(() => items.value.length * rowHeight.value)
  const hasMoreToRender = computed(() => false)

  watch([items, visibleStart], measure, { flush: 'post' })
  onMounted(() => {
    rowObserver = new ResizeObserver(measure)
    observedRow = null
    measure()
    window.addEventListener('resize', measure)
  })

  onBeforeUnmount(() => {
    rowObserver?.disconnect()
    window.removeEventListener('resize', measure)
    if (scrollRoot) scrollRoot.removeEventListener('scroll', onScroll)
    scrollRoot = null
    listEl = null
  })

  return {
    visibleItems,
    visibleStart,
    paddingTop,
    totalHeight,
    hasMoreToRender,
    listRef,
    scrollToIndex
  }
}
