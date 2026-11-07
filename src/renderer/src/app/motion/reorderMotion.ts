import { surfaceMotionMode } from './policy.ts'
import { createMotionTrajectory, restingMotion } from './trajectory.ts'

type Slot = { element: HTMLElement; rect: DOMRect; transform: string }
type Motion = { animation: Animation; trajectory: ReturnType<typeof createMotionTrajectory> }

/** Edge speed rises continuously; refresh rate does not change scroll speed. */
export function reorderScrollDelta(
  y: number,
  top: number,
  bottom: number,
  seconds: number
): number {
  const edge = Math.min(44, (bottom - top) / 3)
  if (edge <= 0) return 0
  const proximity =
    y < top + edge ? -(top + edge - y) / edge : y > bottom - edge ? (y - bottom + edge) / edge : 0
  const strength = Math.min(1, Math.abs(proximity))
  return Math.sign(proximity) * strength * strength * 720 * Math.min(0.032, Math.max(0, seconds))
}

/** Projects only the mounted items. Business order changes once, on drop. */
export function createReorderMotion() {
  let slots: Slot[] = [],
    dragged: HTMLElement | null = null,
    scroller: HTMLElement | null = null
  let startX = 0,
    startY = 0,
    scrollX = 0,
    scrollY = 0,
    targetIndex = -1
  const saved = new Map<HTMLElement, Array<[string, string, string]>>()
  const animations = new Map<HTMLElement, Motion>()
  const offsets = new Map<HTMLElement, number[]>()
  let revision = 0
  function clearAnimations(): void {
    for (const { animation } of animations.values()) animation.cancel()
    animations.clear()
  }
  function restore(): void {
    for (const [element, properties] of saved) {
      for (const [property, value, priority] of properties) {
        if (value) element.style.setProperty(property, value, priority)
        else element.style.removeProperty(property)
      }
    }
    saved.clear()
    offsets.clear()
  }
  const transform = (values: number[], base: string): string =>
    `translate3d(${values[0]}px,${values[1]}px,0) ${base === 'none' ? '' : base}`.trim()
  function move(slot: Slot, target: number[], animate: boolean): void {
    const { element } = slot
    const previousOffset = offsets.get(element) ?? [0, 0]
    if (previousOffset.every((value, i) => value === target[i])) return
    const previous = animations.get(element)
    const from =
      previous?.trajectory.sample(Number(previous.animation.currentTime ?? 0)) ??
      restingMotion(previousOffset)
    previous?.animation.cancel()
    animations.delete(element)
    offsets.set(element, target)
    element.style.setProperty('transform', transform(target, slot.transform))
    if (!animate) return
    const trajectory = createMotionTrajectory(from, target, 190)
    const animation = element.animate(
      trajectory.keyframes((values) => ({ transform: transform(values, slot.transform) })),
      {
        duration: trajectory.duration,
        easing: 'linear'
      }
    )
    animations.set(element, { animation, trajectory })
    void animation.finished.then(
      () => {
        if (animations.get(element)?.animation === animation) animations.delete(element)
      },
      () => {}
    )
  }
  function begin(
    element: HTMLElement,
    group: HTMLElement,
    scroll: HTMLElement | null,
    x: number,
    y: number
  ): void {
    revision++
    clearAnimations()
    restore()
    dragged = element
    scroller = scroll
    startX = x
    startY = y
    scrollX = scroll?.scrollLeft ?? 0
    scrollY = scroll?.scrollTop ?? 0
    targetIndex = -1
    slots = [...group.querySelectorAll<HTMLElement>('[data-reorder-id]')]
      .filter(
        (item) => item.closest('[data-reorder-group]') === group && item.getClientRects().length > 0
      )
      .map((item) => ({
        element: item,
        rect: item.getBoundingClientRect(),
        transform: getComputedStyle(item).transform
      }))
    for (const slot of slots) {
      saved.set(
        slot.element,
        ['transform', 'transition', 'z-index', 'position', 'pointer-events'].map((property) => [
          property,
          slot.element.style.getPropertyValue(property),
          slot.element.style.getPropertyPriority(property)
        ])
      )
      slot.element.style.setProperty('transition', 'none', 'important')
    }
    element.style.setProperty('z-index', '20', 'important')
    element.style.setProperty('position', 'relative', 'important')
    element.style.setProperty('pointer-events', 'none', 'important')
  }
  function hit(x: number, y: number): string | null {
    if (!dragged) return null
    if (scroller) {
      const bounds = scroller.getBoundingClientRect()
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
    }
    const dx = (scroller?.scrollLeft ?? 0) - scrollX,
      dy = (scroller?.scrollTop ?? 0) - scrollY
    const index = slots.findIndex(
      ({ rect }) =>
        x >= rect.left - dx && x <= rect.right - dx && y >= rect.top - dy && y <= rect.bottom - dy
    )
    if (index !== targetIndex) {
      targetIndex = index
      const from = slots.findIndex((slot) => slot.element === dragged)
      const ordered = slots.map((_, i) => i)
      if (index >= 0 && from >= 0) ordered.splice(index, 0, ...ordered.splice(from, 1))
      const animated = surfaceMotionMode(dragged.ownerDocument) === 'full'
      // Stable slots drive hit testing. Retarget from the running trajectory;
      // no computed-style read is needed for each moving neighbor.
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (slot.element === dragged) continue
        const target = slots[ordered.indexOf(i)].rect
        move(slot, [target.left - slot.rect.left, target.top - slot.rect.top], animated)
      }
    }
    return slots[index]?.element.dataset.reorderId ?? null
  }
  function paint(x: number, y: number): void {
    if (!dragged) return
    const base = slots.find((slot) => slot.element === dragged)?.transform ?? 'none'
    dragged.style.setProperty(
      'transform',
      `translate3d(${x - startX + (scroller?.scrollLeft ?? 0) - scrollX}px,${y - startY + (scroller?.scrollTop ?? 0) - scrollY}px,0) ${base === 'none' ? '' : base}`.trim(),
      'important'
    )
  }
  function finish(): () => void {
    const generation = ++revision
    const previous = new Map(
      slots.map((slot) => [slot.element, slot.element.getBoundingClientRect()])
    )
    const velocities = new Map(
      [...animations].map(([element, motion]) => [
        element,
        motion.trajectory.sample(Number(motion.animation.currentTime ?? 0)).velocity
      ])
    )
    const animated = dragged && surfaceMotionMode(dragged.ownerDocument) === 'full'
    clearAnimations()
    restore()
    dragged = null
    slots = []
    return () => {
      if (!animated || generation !== revision) return
      const changes = [...previous]
        .filter(([element]) => element.isConnected)
        .map(([element, from]) => ({
          element,
          from,
          to: element.getBoundingClientRect(),
          base: getComputedStyle(element).transform
        }))
      for (const { element, from, to, base } of changes) {
        const x = from.left - to.left,
          y = from.top - to.top
        const velocity = velocities.get(element) ?? [0, 0]
        if (Math.abs(x) + Math.abs(y) < 0.5 && velocity.every((value) => Math.abs(value) < 1))
          continue
        const trajectory = createMotionTrajectory({ values: [x, y], velocity }, [0, 0], 200)
        const animation = element.animate(
          trajectory.keyframes((values) => ({ transform: transform(values, base) })),
          { duration: trajectory.duration, easing: 'linear' }
        )
        animations.set(element, { animation, trajectory })
        void animation.finished.then(
          () => {
            if (animations.get(element)?.animation === animation) animations.delete(element)
          },
          () => {}
        )
      }
    }
  }
  return {
    begin,
    hit,
    paint,
    finish,
    settle: clearAnimations,
    dispose(): void {
      revision++
      clearAnimations()
      restore()
      slots = []
      dragged = null
    }
  }
}
