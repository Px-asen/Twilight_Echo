import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComputedRef, type Ref} from 'vue'
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
  scrollContainer: Readonly<Ref<HTMLElement | null>>
  itemBounds: (index: number) => { top: number; bottom: number } | null
  scrollToIndex: (index: number) => void
} {
  const rowHeight = ref(options.rowHeight ?? STREAMING_ROW_HEIGHT)
  const overscan = options.overscan ?? STREAMING_OVERSCAN
  const items = computed(source)
  const scrollTop = ref(0)
  const viewportHeight = ref(720)
  const listOffsetTop = ref(0)
  let listInsetTop = 0
  let rowObserver: ResizeObserver | null = null
  let observedRow: Element | null = null
  let listEl: HTMLElement | null = null
  const scrollContainer = shallowRef<HTMLElement | null>(null)
  let listParent: HTMLElement | null = null
  let measureFrame: number | null = null
  let disposed = false
  const layoutElements = new Set<Element>()

  function onScroll(): void {
    const root = scrollContainer.value
    if (!root || document.hidden) return
    scrollTop.value = root.scrollTop
  }

  function bindScrollRoot(element: HTMLElement | null): void {
    const previous = scrollContainer.value
    if (previous === element) return
    if (previous) {
      previous.removeEventListener('scroll', onScroll)
      rowObserver?.unobserve(previous)
    }
    scrollContainer.value = element
    if (element) {
      element.addEventListener('scroll', onScroll, { passive: true })
      rowObserver?.observe(element)
    }
  }

  function observeRow(): void {
    if (!listEl) return
    const firstRow = listEl.firstElementChild
    if (observedRow === firstRow) return
    if (observedRow) rowObserver?.unobserve(observedRow)
    observedRow = firstRow
    if (firstRow) rowObserver?.observe(firstRow)
  }

  function observeLayout(): void {
    const next = new Set<Element>()
    for (let node: Element | null = listEl; node; node = node.parentElement) {
      next.add(node)
      if (node === scrollContainer.value) break
      for (
        let sibling = node.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        next.add(sibling)
    }
    for (const element of layoutElements) {
      if (!next.has(element)) rowObserver?.unobserve(element)
    }
    for (const element of next) {
      if (!layoutElements.has(element)) rowObserver?.observe(element)
    }
    layoutElements.clear()
    for (const element of next) layoutElements.add(element)
  }

  function measure(): void {
    if (!listEl || document.hidden) return
    bindScrollRoot(findScrollParent(listEl))
    const root = scrollContainer.value
    if (!root) return
    observeLayout()
    observeRow()
    const actualRowHeight = observedRow?.getBoundingClientRect().height
    if (actualRowHeight && Math.abs(actualRowHeight - rowHeight.value) > 0.1) {
      rowHeight.value = actualRowHeight
    }
    const listRect = listEl.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    listInsetTop =
      listEl.clientTop + (Number.parseFloat(window.getComputedStyle(listEl).paddingTop) || 0)
    listOffsetTop.value = listRect.top + listInsetTop - rootRect.top + root.scrollTop
    viewportHeight.value = root.clientHeight
    scrollTop.value = root.scrollTop
  }

  function scheduleMeasure(): void {
    if (measureFrame !== null || document.hidden) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = null
      measure()
    })
  }

  function listRef(el: unknown): void {
    if (disposed) return
    const next = el instanceof HTMLElement ? el : null
    if (listEl === next && listParent === next?.parentElement) {
      observeRow()
      return
    }
    if (listEl) rowObserver?.unobserve(listEl)
    listEl = next
    listParent = next?.parentElement ?? null
    if (listEl) rowObserver?.observe(listEl)
    bindScrollRoot(findScrollParent(next))
    measure()
  }

  function itemBounds(index: number): { top: number; bottom: number } | null {
    if (!listEl || index < 0 || index >= items.value.length) return null
    const top = listEl.getBoundingClientRect().top + listInsetTop + index * rowHeight.value
    return { top, bottom: top + rowHeight.value }
  }

  function scrollToIndex(index: number): void {
    measure()
    const root = scrollContainer.value
    if (!root || index < 0 || index >= items.value.length) return
    root.scrollTo({
      top: Math.max(
        0,
        listOffsetTop.value +
          index * rowHeight.value +
          rowHeight.value / 2 -
          viewportHeight.value / 2
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

  function onVisibilityChange(): void {
    if (document.hidden) {
      if (measureFrame !== null) cancelAnimationFrame(measureFrame)
      measureFrame = null
    } else scheduleMeasure()
  }

  watch(items, scheduleMeasure, { flush: 'post' })
  onMounted(() => {
    rowObserver = new ResizeObserver((entries) => {
      if (document.hidden) return
      for (const entry of entries) {
        if (entry.target !== observedRow) {
          scheduleMeasure()
          continue
        }
        const height = entry.borderBoxSize[0]?.blockSize
        if (height && Math.abs(height - rowHeight.value) > 0.1) {
          scheduleMeasure()
        }
      }
    })
    layoutElements.clear()
    observedRow = null
    measure()
    window.addEventListener('resize', scheduleMeasure)
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onBeforeUnmount(() => {
    disposed = true
    rowObserver?.disconnect()
    window.removeEventListener('resize', scheduleMeasure)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (measureFrame !== null) cancelAnimationFrame(measureFrame)
    measureFrame = null
    scrollContainer.value?.removeEventListener('scroll', onScroll)
    scrollContainer.value = null
    listEl = null
    listParent = null
    observedRow = null
    layoutElements.clear()
  })

  return {
    visibleItems,
    visibleStart,
    paddingTop,
    totalHeight,
    hasMoreToRender,
    listRef,
    scrollContainer,
    itemBounds,
    scrollToIndex
  }
}
