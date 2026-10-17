import {
  SCROLL_TOP_BUTTON_SIZE,
  SCROLL_TOP_EDGE_GAP,
  isScrollTopContainerEligible,
  isScrollTopRevealed,
  resolveScrollTopAnchor,
  type ScrollTopAnchor,
  type ScrollTopObstruction
} from './scrollToTopPolicy'
import { scrollMotionBehavior } from '../app/scrollMotion'

/**
 * One shared "back to top" control for every scroll container in the window.
 *
 * The renderer has dozens of independent scroll containers spread across pages,
 * drawers and dialogs, so this is delegated the same way autoHideScrollbars.ts
 * delegates: a document-level listener resolves whichever container the user is
 * scrolling or pointing at, and a single fixed-position button is anchored to
 * that container's bottom-right corner. Containers opt out with
 * `data-te-scroll-top="off"`; `inert` subtrees (the theme studio live preview)
 * are skipped automatically.
 */

const BUTTON_CLASS = 'te-scroll-top'
const SKIP_SELECTOR = '[inert], [data-te-scroll-top="off"]'
/** Geometry and occlusion only change on layout, not while scrolling. */
const GEOMETRY_REFRESH_INTERVAL_MS = 200
/** Outlasts `--te-motion-page` so a page swap cannot leave the control behind. */
const NAVIGATION_SETTLE_MS = 460

let button: HTMLButtonElement | null = null
let controls: HTMLDivElement | null = null
let scroller: HTMLElement | null = null
let anchor: ScrollTopAnchor | null = null
let upperAnchor: ScrollTopAnchor | null = null
let cachedClientHeight = 0
let cachedScrollHeight = 0
let geometryStamp = Number.NEGATIVE_INFINITY
let appliedAnchor = ''
let visible = false
let frame: number | null = null
let pointerFrame: number | null = null
let pendingPointerTarget: Element | null = null
let settleTimer: number | null = null

export interface ScrollViewport {
  top: number
  bottom: number
}

interface ScrollCompanion {
  label: string
  icon: string
  isVisible: (viewport: ScrollViewport) => boolean
  activate: (viewport: ScrollViewport) => void
}

const companions = new Map<HTMLElement, { action: ScrollCompanion; button: HTMLButtonElement }>()
let viewport: ScrollViewport | null = null
const COMPANION_GAP = 16

/** A page owns the action; the shared controls own positioning and occlusion. */
export function registerScrollToTopCompanion(
  target: HTMLElement,
  action: ScrollCompanion
): { refresh: () => void; dispose: () => void } {
  const element = createButton('te-scroll-companion', action.label, action.icon, () => {
    refreshGeometry(target, performance.now())
    if (anchor && viewport && action.isVisible(viewport)) action.activate(viewport)
  })
  element.style.top = `${SCROLL_TOP_BUTTON_SIZE + COMPANION_GAP}px`
  const registration = { action, button: element }
  companions.get(target)?.button.remove()
  companions.set(target, registration)
  setScroller(target)
  return {
    refresh: () => {
      if (!scroller || !scroller.isConnected || scroller.clientHeight === 0) setScroller(target)
      invalidateGeometry()
    },
    dispose: () => {
      element.remove()
      if (companions.get(target) === registration) companions.delete(target)
      invalidateGeometry()
    }
  }
}

function isVerticallyScrollable(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 1) return false
  const overflowY = window.getComputedStyle(element).overflowY
  return /(auto|scroll|overlay)/.test(overflowY)
}

function findScrollTarget(start: Element | null): HTMLElement | null {
  if (!start || start.closest(SKIP_SELECTOR)) return null
  let current: HTMLElement | null =
    start instanceof HTMLElement ? start : (start.parentElement ?? null)
  while (current) {
    if (isVerticallyScrollable(current)) return current
    current = current.parentElement
  }
  return null
}

function ensureButton(): HTMLButtonElement {
  if (button) return button
  button = createButton('', '回到开头', 'ph ph-arrow-up', onButtonClick)
  return button
}

function ensureControls(): HTMLDivElement {
  if (controls) return controls
  controls = document.createElement('div')
  controls.className = 'te-scroll-controls'
  controls.style.width = `${SCROLL_TOP_BUTTON_SIZE}px`
  controls.style.height = `${SCROLL_TOP_BUTTON_SIZE}px`
  document.body.append(controls)
  return controls
}

function createButton(
  className: string,
  label: string,
  iconClass: string,
  activate: () => void
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `${BUTTON_CLASS} ${className}`.trim()
  element.title = label
  element.setAttribute('aria-label', label)
  element.dataset.teScrollTopVisible = 'false'
  // Size stays here rather than in base.css: the anchor math reserves exactly
  // this box, so a theme resizing the control would misplace it.
  element.style.width = `${SCROLL_TOP_BUTTON_SIZE}px`
  element.style.height = `${SCROLL_TOP_BUTTON_SIZE}px`
  const icon = document.createElement('i')
  icon.className = iconClass
  icon.setAttribute('aria-hidden', 'true')
  element.append(icon)
  element.addEventListener('click', activate)
  ensureControls().append(element)
  return element
}

/**
 * The bar overlaps the bottom of every full-height page container, so the
 * control has to stop above it. An auto-hidden mini bar keeps its layout box
 * while translated away — the shell publishes both hidden states as flags.
 */
function resolvePlayerBarObstruction(): ScrollTopObstruction | null {
  const shell = document.querySelector<HTMLElement>('.player-bar-shell')
  if (!shell) return null
  if (shell.dataset.tePlaybarHidden === 'true') return null
  if (shell.dataset.tePlaybarVisibility === 'hidden') return null
  const rect = shell.getBoundingClientRect()
  if (rect.height <= 0) return null
  return { top: rect.top, left: rect.left, right: rect.right }
}

/**
 * Hit-testing the spot the control wants answers the only question that matters
 * — "would a click there land in this container?" — without knowing anybody's
 * z-index. It covers a container left scrolled under a full overlay (the
 * now-playing page, a modal, the settings surface) and a panel that only takes
 * the corner, such as the playback queue drawer above the player bar. The
 * control itself is filtered out of the stack so it cannot mask its own probe.
 */
function isCovered(target: HTMLElement, at: ScrollTopAnchor): boolean {
  const x = Math.round(at.left + SCROLL_TOP_BUTTON_SIZE / 2)
  const y = Math.round(at.top + SCROLL_TOP_BUTTON_SIZE / 2)
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return true
  for (const hit of document.elementsFromPoint(x, y)) {
    if (isControl(hit)) continue
    return !(hit === target || target.contains(hit) || hit.contains(target))
  }
  return true
}

function isControl(target: Element): boolean {
  if (button && (target === button || button.contains(target))) return true
  for (const companion of companions.values()) {
    if (target === companion.button || companion.button.contains(target)) return true
  }
  return false
}

function refreshGeometry(target: HTMLElement, now: number): void {
  geometryStamp = now
  anchor = null
  upperAnchor = null
  viewport = null
  cachedClientHeight = target.clientHeight
  cachedScrollHeight = target.scrollHeight
  const eligible = companions.has(target)
    ? cachedClientHeight >= SCROLL_TOP_BUTTON_SIZE * 2 + COMPANION_GAP + SCROLL_TOP_EDGE_GAP * 2 &&
      cachedScrollHeight - cachedClientHeight >= 8
    : isScrollTopContainerEligible({
        clientHeight: cachedClientHeight,
        scrollHeight: cachedScrollHeight
      })
  if (!eligible) {
    return
  }
  const rect = target.getBoundingClientRect()
  const obstruction = resolvePlayerBarObstruction()
  const candidate = resolveScrollTopAnchor({
    rect,
    clientWidth: target.clientWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    obstruction
  })
  if (!candidate) return
  if (isCovered(target, candidate)) return
  anchor = candidate
  // Song pages extend behind the title bar and publish its clearance as scroll padding.
  const topClearance = Number.parseFloat(window.getComputedStyle(target).scrollPaddingTop) || 0
  viewport = {
    top: Math.max(0, rect.top + target.clientTop + topClearance),
    bottom: Math.min(window.innerHeight, rect.top + target.clientTop + target.clientHeight)
  }
  const titleBar = document.querySelector<HTMLElement>('.title-bar')?.getBoundingClientRect()
  if (
    titleBar &&
    titleBar.left < rect.right &&
    titleBar.right > rect.left &&
    titleBar.top <= viewport.top &&
    titleBar.bottom > viewport.top
  )
    viewport.top = titleBar.bottom
  if (obstruction && obstruction.left < rect.right && obstruction.right > rect.left) {
    viewport.bottom = Math.min(viewport.bottom, obstruction.top)
  }
  if (companions.has(target)) {
    const above = {
      left: candidate.left,
      top: candidate.top - SCROLL_TOP_BUTTON_SIZE - COMPANION_GAP
    }
    if (above.top >= viewport.top && !isCovered(target, above)) upperAnchor = above
  }
}

function applyAnchor(next: ScrollTopAnchor): void {
  const element = ensureControls()
  const key = `${next.left}:${next.top}`
  if (appliedAnchor === key) return
  appliedAnchor = key
  element.style.left = `${next.left}px`
  element.style.top = `${next.top}px`
}

function setVisible(next: boolean): void {
  if (visible === next) return
  visible = next
  if (!next && !button) return
  ensureButton().dataset.teScrollTopVisible = next ? 'true' : 'false'
}

function update(): void {
  const target = scroller
  const companion = target && companions.get(target)
  if (!target || !target.isConnected || target.clientHeight === 0) {
    setVisible(false)
    if (companion) companion.button.dataset.teScrollTopVisible = 'false'
    return
  }
  const now = performance.now()
  if (now - geometryStamp >= GEOMETRY_REFRESH_INTERVAL_MS) refreshGeometry(target, now)
  if (!anchor) {
    setVisible(false)
    if (companion) companion.button.dataset.teScrollTopVisible = 'false'
    return
  }
  const showCompanion = !!(companion && viewport && companion.action.isVisible(viewport))
  // Reserve the lower slot for this page even while its action is hidden.
  // Both absolute-positioned buttons share one anchor, so neither can jump.
  applyAnchor(
    companion
      ? { left: anchor.left, top: anchor.top - SCROLL_TOP_BUTTON_SIZE - COMPANION_GAP }
      : anchor
  )
  if (companion) {
    companion.button.dataset.teScrollTopVisible = String(showCompanion)
  }
  const revealed = isScrollTopRevealed({
    scrollTop: target.scrollTop,
    clientHeight: cachedClientHeight,
    scrollHeight: cachedScrollHeight
  })
  if (!revealed) {
    setVisible(false)
    return
  }
  const topAnchor = companion ? upperAnchor : anchor
  if (!topAnchor) {
    setVisible(false)
    return
  }
  setVisible(true)
}

function scheduleUpdate(): void {
  if (frame !== null || document.hidden) return
  frame = window.requestAnimationFrame(() => {
    frame = null
    update()
  })
}

function setScroller(next: HTMLElement | null): void {
  if (scroller === next) return
  const previous = scroller && companions.get(scroller)
  if (previous) previous.button.dataset.teScrollTopVisible = 'false'
  scroller = next
  anchor = null
  appliedAnchor = ''
  geometryStamp = Number.NEGATIVE_INFINITY
  setVisible(false)
  scheduleUpdate()
}

function invalidateGeometry(): void {
  geometryStamp = Number.NEGATIVE_INFINITY
  scheduleUpdate()
}

/** Page swaps mount and unmount containers without a scroll event of their own. */
function scheduleSettleCheck(): void {
  if (document.hidden) return
  invalidateGeometry()
  if (settleTimer !== null) window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => {
    settleTimer = null
    invalidateGeometry()
  }, NAVIGATION_SETTLE_MS)
}

function onButtonClick(): void {
  const target = scroller
  if (!target) return
  // Visibility is left to the scroll events the animation emits, so the control
  // fades exactly when the offset drops back under the reveal distance.
  target.scrollTo({ top: 0, behavior: scrollMotionBehavior() })
}

function onScroll(event: Event): void {
  if (document.hidden) return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target === scroller) {
    scheduleUpdate()
    return
  }
  if (target.closest(SKIP_SELECTOR)) {
    setScroller(null)
    return
  }
  // A horizontal carousel inside a scrolled page must not steal the control.
  if (!isVerticallyScrollable(target)) return
  setScroller(target)
}

function applyPointerTarget(): void {
  const target = pendingPointerTarget
  pendingPointerTarget = null
  if (!target) return
  // Pointing at the control itself must never retarget or hide it.
  if (isControl(target)) return
  const next = findScrollTarget(target)
  // Hovering non-scrollable chrome keeps whichever container is already active.
  if (next) setScroller(next)
}

function onPointerMove(event: PointerEvent): void {
  if (document.hidden) return
  pendingPointerTarget = event.target instanceof Element ? event.target : null
  if (pointerFrame !== null) return
  pointerFrame = window.requestAnimationFrame(() => {
    pointerFrame = null
    applyPointerTarget()
  })
}

/** Escape closes overlays and Enter activates navigation, both without a scroll. */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Enter') scheduleSettleCheck()
}

function cancelPendingUpdates(): void {
  if (frame !== null) window.cancelAnimationFrame(frame)
  if (pointerFrame !== null) window.cancelAnimationFrame(pointerFrame)
  if (settleTimer !== null) window.clearTimeout(settleTimer)
  frame = null
  pointerFrame = null
  settleTimer = null
  pendingPointerTarget = null
}

function onVisibilityChange(): void {
  if (document.hidden) {
    cancelPendingUpdates()
    setVisible(false)
    for (const companion of companions.values()) {
      companion.button.dataset.teScrollTopVisible = 'false'
    }
  } else invalidateGeometry()
}

export function installScrollToTopButton(): () => void {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('click', scheduleSettleCheck, { capture: true, passive: true })
  document.addEventListener('keydown', onKeyDown, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('resize', invalidateGeometry, { passive: true })

  return () => {
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('click', scheduleSettleCheck, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('resize', invalidateGeometry)
    cancelPendingUpdates()
    button?.removeEventListener('click', onButtonClick)
    button?.remove()
    for (const companion of companions.values()) companion.button.remove()
    companions.clear()
    controls?.remove()
    controls = null
    viewport = null
    button = null
    scroller = null
    anchor = null
    upperAnchor = null
    appliedAnchor = ''
    visible = false
    geometryStamp = Number.NEGATIVE_INFINITY
  }
}
