import {
  computed,
  getCurrentInstance,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  unref,
  watch,
  type Ref
} from 'vue'
import type { Track } from '../../types/music'
import {
  createPlaybackQueueDisplayItems,
  getPlaybackQueueScrollTopForIndex,
  getPlaybackQueueWindow,
  PLAYBACK_QUEUE_ROW_HEIGHT
} from '../../utils/playbackQueueVirtualization.ts'

export function usePlaybackQueueVirtualScroll(
  queue: Ref<Track[]>,
  queueIndex: Ref<number>,
  open: Ref<boolean>,
  rowHeight: number | Ref<number> = PLAYBACK_QUEUE_ROW_HEIGHT,
  listOffset: number | Ref<number> = 0
) {
  const containerRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewportHeight = ref(0)

  const visibleRange = computed(() =>
    getPlaybackQueueWindow(
      queue.value.length,
      Math.max(0, scrollTop.value - unref(listOffset)),
      viewportHeight.value,
      unref(rowHeight)
    )
  )
  const visibleItems = computed(() =>
    createPlaybackQueueDisplayItems(queue.value, visibleRange.value)
  )
  const totalHeight = computed(() => queue.value.length * unref(rowHeight))
  const translateY = computed(() => visibleRange.value.start * unref(rowHeight))

  function updateViewport(): void {
    viewportHeight.value = containerRef.value?.clientHeight ?? 0
  }

  function onScroll(event: Event): void {
    scrollTop.value = (event.target as HTMLElement).scrollTop
  }

  function scrollToIndex(index: number): void {
    const container = containerRef.value
    if (!container || index < 0 || index >= queue.value.length) return
    const nextTop =
      unref(listOffset) +
      getPlaybackQueueScrollTopForIndex(
        index,
        queue.value.length,
        container.clientHeight,
        unref(rowHeight)
      )
    container.scrollTop = nextTop
    scrollTop.value = container.scrollTop
  }

  function scrollToCurrent(): void {
    scrollToIndex(queueIndex.value)
  }

  async function revealCurrent(): Promise<void> {
    await nextTick()
    updateViewport()
    scrollToCurrent()
  }

  let resizeObserver: ResizeObserver | null = null

  if (getCurrentInstance()) {
    onMounted(() => {
      updateViewport()
      window.addEventListener('resize', updateViewport)
      resizeObserver = new ResizeObserver(updateViewport)
      if (containerRef.value) resizeObserver.observe(containerRef.value)
    })

    watch(
      containerRef,
      (container) => {
        resizeObserver?.disconnect()
        if (container) resizeObserver?.observe(container)
        updateViewport()
      },
      { flush: 'post' }
    )
    onUnmounted(() => {
      window.removeEventListener('resize', updateViewport)
      resizeObserver?.disconnect()
    })
  }

  watch(open, (isOpen) => {
    if (isOpen) void revealCurrent()
  })

  watch(queueIndex, () => {
    if (open.value) void revealCurrent()
  })

  watch(
    () => unref(rowHeight),
    () => {
      if (open.value) void revealCurrent()
    }
  )
  watch(() => unref(listOffset), updateViewport)

  return {
    containerRef,
    visibleItems,
    totalHeight,
    translateY,
    onScroll,
    scrollToCurrent,
    scrollToIndex
  }
}
