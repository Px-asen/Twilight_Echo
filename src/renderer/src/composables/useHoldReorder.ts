import { nextTick, onBeforeUnmount, ref } from 'vue'
import { createReorderMotion, reorderScrollDelta } from '../app/motion/reorderMotion'
import { observeMotionPolicy } from '../app/motion/policy'

export function useHoldReorder(move: (from: string, to: string) => void, delay = 450) {
  const active = ref<string | null>(null)
  const over = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  let previousFrame = 0
  let scrollRemainder = 0
  let origin: HTMLElement | null = null
  let group: HTMLElement | null = null
  let scroller: HTMLElement | null = null
  let pointerId = -1
  let pointerType = ''
  let pending: string | null = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let suppressClick = false
  let trustedPointer = false
  const motion = createReorderMotion()
  const stopPolicy = observeMotionPolicy(document, motion.settle)

  function hitTest(): void {
    over.value = motion.hit(x, y)
  }
  function scroll(time: number): void {
    if (!active.value) return
    if (!origin?.isConnected) {
      cancel()
      return
    }
    if (scroller) {
      const rect = scroller.getBoundingClientRect()
      const delta = reorderScrollDelta(y, rect.top, rect.bottom, (time - previousFrame) / 1000)
      if (delta) {
        // Chromium may round scrollTop, so carry fractional distance forward.
        const total = delta + scrollRemainder
        const whole = Math.trunc(total)
        scrollRemainder = total - whole
        scroller.scrollTop += whole
        hitTest()
      } else scrollRemainder = 0
    }
    previousFrame = time
    motion.paint(x, y)
    frame = requestAnimationFrame(scroll)
  }
  function release(): void {
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    document.removeEventListener('pointermove', pointerMove)
    document.removeEventListener('pointerup', pointerUp)
    document.removeEventListener('pointercancel', cancel)
    document.removeEventListener('keydown', keydown)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('resize', cancel)
    if (origin?.hasPointerCapture(pointerId)) origin.releasePointerCapture(pointerId)
    active.value = null
    over.value = null
    origin = null
    group = null
    scroller = null
    pending = null
    pointerType = ''
    scrollRemainder = 0
  }
  function cancel(): void {
    const settle = motion.finish()
    release()
    void nextTick(settle)
  }
  function activate(): void {
    if (pending === null || active.value !== null) return
    clearTimeout(timer)
    active.value = pending
    over.value = pending
    suppressClick = true
    window.getSelection()?.removeAllRanges()
    if (origin && group) {
      motion.begin(origin, group, scroller, startX, startY)
      if (trustedPointer) origin.setPointerCapture(pointerId)
      motion.paint(x, y)
    }
    previousFrame = performance.now()
    frame = requestAnimationFrame(scroll)
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cancel()
  }
  function pointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    x = event.clientX
    y = event.clientY
    if (!active.value) {
      if (Math.hypot(x - startX, y - startY) <= 8) return
      // A mouse starts dragging by moving; touch keeps the hold delay so swipes can scroll.
      if (pointerType === 'mouse') activate()
      else cancel()
      if (!active.value) return
    }
    event.preventDefault()
    hitTest()
  }
  function pointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    x = event.clientX
    y = event.clientY
    if (active.value) hitTest()
    const from = active.value
    const to = over.value
    motion.paint(x, y)
    const settle = motion.finish()
    release()
    if (from && to && from !== to) move(from, to)
    void nextTick(settle)
  }
  function start(event: PointerEvent, id: string): void {
    if (event.button !== 0 || !event.isPrimary || active.value) return
    suppressClick = false
    const target = event.target as HTMLElement
    if (
      target.closest(
        'button:not(.metadata-link), input, select, a, label, [contenteditable="true"]'
      )
    )
      return
    cancel()
    origin = event.currentTarget as HTMLElement
    group = origin.closest('[data-reorder-group]')
    pointerId = event.pointerId
    pointerType = event.pointerType
    trustedPointer = event.isTrusted
    pending = id
    x = startX = event.clientX
    y = startY = event.clientY
    scroller = origin.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement
    }
    if (delay === 0) activate()
    else timer = setTimeout(activate, delay)
    document.addEventListener('pointermove', pointerMove, { passive: false })
    document.addEventListener('pointerup', pointerUp)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', keydown)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
  }
  function click(event: MouseEvent): void {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  onBeforeUnmount(() => {
    release()
    motion.dispose()
    stopPolicy()
  })
  return { active, over, start, click, cancel }
}
