import { onBeforeUnmount, ref } from 'vue'

export function useHoldReorder(move: (from: string, to: string) => void) {
  const active = ref<string | null>(null)
  const over = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  let origin: HTMLElement | null = null
  let group: HTMLElement | null = null
  let scroller: HTMLElement | null = null
  let pointerId = -1
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let suppressClick = false

  function hitTest(): void {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-reorder-id]')
    over.value =
      target?.closest('[data-reorder-group]') === group ? (target?.dataset.reorderId ?? null) : null
  }
  function scroll(): void {
    if (!active.value) return
    if (scroller) {
      const rect = scroller.getBoundingClientRect()
      const delta = y < rect.top + 44 ? -12 : y > rect.bottom - 44 ? 12 : 0
      if (delta) {
        scroller.scrollTop += delta
        hitTest()
      }
    }
    frame = requestAnimationFrame(scroll)
  }
  function cancel(): void {
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    document.removeEventListener('pointermove', pointerMove)
    document.removeEventListener('pointerup', pointerUp)
    document.removeEventListener('pointercancel', cancel)
    document.removeEventListener('keydown', keydown)
    window.removeEventListener('blur', cancel)
    active.value = null
    over.value = null
    origin = null
    group = null
    scroller = null
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cancel()
  }
  function pointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    x = event.clientX
    y = event.clientY
    if (!active.value) {
      if (Math.hypot(x - startX, y - startY) > 8) cancel()
      return
    }
    event.preventDefault()
    hitTest()
  }
  function pointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    const from = active.value
    const to = over.value
    cancel()
    if (from && to && from !== to) move(from, to)
  }
  function start(event: PointerEvent, id: string): void {
    if (event.button !== 0 || !event.isPrimary) return
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
    x = startX = event.clientX
    y = startY = event.clientY
    scroller = origin.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement
    }
    timer = setTimeout(() => {
      active.value = id
      over.value = id
      suppressClick = true
      window.getSelection()?.removeAllRanges()
      frame = requestAnimationFrame(scroll)
    }, 450)
    document.addEventListener('pointermove', pointerMove, { passive: false })
    document.addEventListener('pointerup', pointerUp)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', keydown)
    window.addEventListener('blur', cancel)
  }
  function click(event: MouseEvent): void {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  onBeforeUnmount(cancel)
  return { active, over, start, click, cancel }
}
