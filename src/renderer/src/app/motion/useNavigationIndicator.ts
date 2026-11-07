import { onBeforeUnmount, onMounted, watch, type Ref, type WatchSource } from 'vue'
import { createMotionSpring } from './spring'
import { observeMotionPolicy, surfaceMotionMode } from './policy'

export function useNavigationIndicator(
  root: Ref<HTMLElement | null>,
  indicator: Ref<HTMLElement | null>,
  source: WatchSource
) {
  let initialized = false,
    frame = 0
  let observer: ResizeObserver | undefined
  let changes: MutationObserver | undefined
  const observed = new Set<Element>()
  let stopPolicy = () => {}
  const spring = createMotionSpring(([x, y, width, height]) => {
    const element = indicator.value
    if (element) {
      element.style.transform = `translate3d(${x}px,${y}px,0) scale(${width},${height})`
      const radius = 'var(--te-navigation-motion-radius, var(--te-radius-global, 8px))'
      element.style.borderRadius = `calc(${radius} / ${Math.max(1, width)}) / calc(${radius} / ${Math.max(1, height)})`
    }
  })
  function update(animate: boolean): void {
    const container = root.value,
      element = indicator.value
    if (!container || !element) return
    const active = [...container.querySelectorAll<HTMLElement>('.menu-item.active')].find(
      (item) => item.getClientRects().length && getComputedStyle(item).display !== 'none'
    )
    if (observer) {
      const items = new Set(container.querySelectorAll('.menu-item'))
      for (const item of observed) {
        if (items.has(item)) continue
        observer.unobserve(item)
        observed.delete(item)
      }
      for (const item of items) {
        if (observed.has(item)) continue
        observer.observe(item)
        observed.add(item)
      }
    }
    if (!active) {
      element.hidden = true
      initialized = false
      return
    }
    // Layout coordinates exclude transient hover/press transforms. Measuring
    // the painted rect would leave the marker shrunk after the pointer lifts.
    let x = active.offsetLeft,
      y = active.offsetTop
    let parent = active.offsetParent as HTMLElement | null
    while (parent && parent !== container) {
      x += parent.offsetLeft + parent.clientLeft - parent.scrollLeft
      y += parent.offsetTop + parent.clientTop - parent.scrollTop
      parent = parent.offsetParent as HTMLElement | null
    }
    element.hidden = false
    spring.to(
      [x, y, active.offsetWidth, active.offsetHeight],
      initialized && animate && surfaceMotionMode(container.ownerDocument) === 'full'
    )
    initialized = true
  }
  function schedule(): void {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = 0
      update(false)
    })
  }
  watch(source, () => update(true), { flush: 'post' })
  onMounted(() => {
    const container = root.value
    if (!container) return
    update(false)
    observer = new ResizeObserver(schedule)
    observer.observe(container)
    update(false)
    // Disclosure can move the selected row without changing its key. ResizeObserver
    // owns size/typography changes; ignore inline press effects on the buttons so
    // their pointerdown writes cannot snap a newly retargeted spring.
    changes = new MutationObserver((records) => {
      if (
        records.some((record) => {
          if (record.target === indicator.value) return false
          if (record.attributeName !== 'class') return true
          const element = record.target as HTMLElement
          return (
            element.classList.contains('expanded') !==
            (record.oldValue ?? '').split(/\s+/).includes('expanded')
          )
        })
      )
        schedule()
    })
    changes.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['hidden', 'class']
    })
    stopPolicy = observeMotionPolicy(container.ownerDocument, () => update(false))
    window.addEventListener('resize', schedule)
  })
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    spring.dispose()
    observer?.disconnect()
    observed.clear()
    changes?.disconnect()
    stopPolicy()
    window.removeEventListener('resize', schedule)
  })
}
