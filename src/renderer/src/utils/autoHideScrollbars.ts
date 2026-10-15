const AUTO_SCROLLBAR_CLASS = 'te-auto-scrollbar'
const NEAR_SCROLLBAR_CLASS = 'is-scrollbar-near'
const ACTIVE_SCROLLBAR_CLASS = 'is-scrollbar-active'
const SCROLLBAR_PROXIMITY_PX = 28
const SCROLLBAR_FAR_SKIP_PX = SCROLLBAR_PROXIMITY_PX + 16
const SCROLLBAR_HIDE_DELAY_MS = 900

interface ScrollbarAxes {
  horizontal: boolean
  vertical: boolean
}

interface CachedAncestor {
  generation: number
  element: HTMLElement | null
}

let activeScroller: HTMLElement | null = null
let hideTimer: number | null = null
let pointerFrame: number | null = null
let pendingPointerEvent: PointerEvent | null = null
let cacheGeneration = 0
const ancestorCache = new WeakMap<Element, CachedAncestor>()

export function invalidateAutoHideScrollbarCache(): void {
  cacheGeneration += 1
}

function setScrollbarClass(element: HTMLElement, name: string, enabled: boolean): void {
  // DOMTokenList emits attribute mutations even for some unchanged operations.
  // Root observers must not treat every pointer frame as a new theme/layout.
  if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled)
}

function getScrollbarAxes(element: HTMLElement): ScrollbarAxes {
  const style = window.getComputedStyle(element)
  const canScrollVertical = /(auto|scroll|overlay)/.test(style.overflowY)
  const canScrollHorizontal = /(auto|scroll|overlay)/.test(style.overflowX)
  return {
    vertical: canScrollVertical && element.scrollHeight > element.clientHeight + 1,
    horizontal: canScrollHorizontal && element.scrollWidth > element.clientWidth + 1
  }
}

function findScrollableAncestor(start: Element | null): HTMLElement | null {
  if (!start) {
    return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
  }
  const cached = ancestorCache.get(start)
  if (cached && cached.generation === cacheGeneration) return cached.element

  let current = start instanceof HTMLElement ? start : (start.parentElement ?? null)
  let result: HTMLElement | null = null
  while (current) {
    const axes = getScrollbarAxes(current)
    if (axes.vertical || axes.horizontal) {
      result = current
      break
    }
    current = current.parentElement
  }
  if (!result) {
    result = document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
  }
  ancestorCache.set(start, { generation: cacheGeneration, element: result })
  return result
}

function clearHideTimer(): void {
  if (hideTimer === null) return
  window.clearTimeout(hideTimer)
  hideTimer = null
}

function clearScroller(element: HTMLElement | null, clearActive = true): void {
  if (!element) return
  setScrollbarClass(element, NEAR_SCROLLBAR_CLASS, false)
  if (clearActive) setScrollbarClass(element, ACTIVE_SCROLLBAR_CLASS, false)
  if (activeScroller === element && clearActive) activeScroller = null
}

function scheduleHide(element: HTMLElement): void {
  clearHideTimer()
  hideTimer = window.setTimeout(() => {
    setScrollbarClass(element, ACTIVE_SCROLLBAR_CLASS, false)
    hideTimer = null
    if (!element.classList.contains(NEAR_SCROLLBAR_CLASS) && activeScroller === element) {
      activeScroller = null
    }
  }, SCROLLBAR_HIDE_DELAY_MS)
}

function revealWhileScrolling(element: HTMLElement): void {
  if (activeScroller && activeScroller !== element) clearScroller(activeScroller)
  activeScroller = element
  setScrollbarClass(element, AUTO_SCROLLBAR_CLASS, true)
  setScrollbarClass(element, ACTIVE_SCROLLBAR_CLASS, true)
  scheduleHide(element)
}

function updatePointerProximity(event: PointerEvent): void {
  const element = findScrollableAncestor(event.target instanceof Element ? event.target : null)
  if (!element) {
    clearScroller(activeScroller, false)
    return
  }

  const rect = element.getBoundingClientRect()
  const farFromVertical = rect.right - event.clientX > SCROLLBAR_FAR_SKIP_PX
  const farFromHorizontal = rect.bottom - event.clientY > SCROLLBAR_FAR_SKIP_PX
  if (farFromVertical && farFromHorizontal) {
    if (activeScroller && activeScroller !== element) clearScroller(activeScroller, false)
    setScrollbarClass(element, AUTO_SCROLLBAR_CLASS, true)
    setScrollbarClass(element, NEAR_SCROLLBAR_CLASS, false)
    if (!element.classList.contains(ACTIVE_SCROLLBAR_CLASS) && activeScroller === element) {
      activeScroller = null
    }
    return
  }

  const axes = getScrollbarAxes(element)
  const nearVertical =
    axes.vertical &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom &&
    rect.right - event.clientX >= 0 &&
    rect.right - event.clientX <= SCROLLBAR_PROXIMITY_PX
  const nearHorizontal =
    axes.horizontal &&
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    rect.bottom - event.clientY >= 0 &&
    rect.bottom - event.clientY <= SCROLLBAR_PROXIMITY_PX
  const isNear = nearVertical || nearHorizontal

  if (activeScroller && activeScroller !== element) clearScroller(activeScroller, false)
  setScrollbarClass(element, AUTO_SCROLLBAR_CLASS, true)
  setScrollbarClass(element, NEAR_SCROLLBAR_CLASS, isNear)
  if (isNear) activeScroller = element
  else if (!element.classList.contains(ACTIVE_SCROLLBAR_CLASS) && activeScroller === element) {
    activeScroller = null
  }
}

function onPointerMove(event: PointerEvent): void {
  if (document.hidden) return
  pendingPointerEvent = event
  if (pointerFrame !== null) return
  pointerFrame = window.requestAnimationFrame(() => {
    pointerFrame = null
    if (pendingPointerEvent) updatePointerProximity(pendingPointerEvent)
    pendingPointerEvent = null
  })
}

function cancelPointerUpdate(): void {
  if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
  pointerFrame = null
  pendingPointerEvent = null
}

function onPointerLeaveDocument(): void {
  cancelPointerUpdate()
  clearScroller(activeScroller, false)
}

function onScroll(event: Event): void {
  if (document.hidden) return
  const element =
    event.target instanceof HTMLElement
      ? event.target
      : document.scrollingElement instanceof HTMLElement
        ? document.scrollingElement
        : null
  if (element) revealWhileScrolling(element)
}

function onViewportChange(): void {
  invalidateAutoHideScrollbarCache()
}

function onVisibilityChange(): void {
  if (!document.hidden) return
  clearHideTimer()
  cancelPointerUpdate()
  clearScroller(activeScroller)
}

export function installAutoHideScrollbars(): () => void {
  setScrollbarClass(document.documentElement, AUTO_SCROLLBAR_CLASS, true)
  setScrollbarClass(document.body, AUTO_SCROLLBAR_CLASS, true)
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerleave', onPointerLeaveDocument, { passive: true })
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('orientationchange', onViewportChange)
  window.addEventListener('blur', onPointerLeaveDocument)

  return () => {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerleave', onPointerLeaveDocument)
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('orientationchange', onViewportChange)
    window.removeEventListener('blur', onPointerLeaveDocument)
    clearHideTimer()
    cancelPointerUpdate()
    clearScroller(activeScroller)
  }
}
