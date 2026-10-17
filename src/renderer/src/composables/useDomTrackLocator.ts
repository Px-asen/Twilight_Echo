import { onBeforeUnmount, onUpdated, useTemplateRef, watch, type Ref } from 'vue'
import { registerTrackLocator, type TrackBounds } from './useTrackLocator'

const ROW_SELECTOR = '[data-te-track-id]'
const SKIP_SELECTOR = '[inert], [data-te-scroll-top="off"]'

interface DomRegistration {
  rows: HTMLElement[]
  handle: ReturnType<typeof registerTrackLocator>
}

function scrollParent(element: HTMLElement, includeSelf = false): HTMLElement | null {
  let fallback: HTMLElement | null = null
  for (
    let parent: HTMLElement | null = includeSelf ? element : element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) continue
    fallback ??= parent
    if (parent.scrollHeight > parent.clientHeight + 1) return parent
  }
  return fallback ?? (document.scrollingElement as HTMLElement | null)
}

/** Mark actual song rows; filters and pagination naturally remove their targets. */
export function useDomTrackLocator(
  templateRefKey: string,
  currentTrackId: () => string | null | undefined
): Readonly<Ref<HTMLElement | null>> {
  const root = useTemplateRef<HTMLElement>(templateRefKey)
  const registrations = new Map<HTMLElement, DomRegistration>()
  let frame: number | null = null
  let disposed = false

  function refresh(): void {
    frame = null
    const element = root.value
    const targets = new Map<HTMLElement, HTMLElement[]>()
    if (element && !element.closest(SKIP_SELECTOR)) {
      // Reserve the same button slots even when this page has no current song.
      const first = element.querySelector<HTMLElement>(ROW_SELECTOR)
      const container = scrollParent(first ?? element, !first)
      if (container) targets.set(container, [])
      const id = currentTrackId()
      if (id) {
        for (const row of element.querySelectorAll<HTMLElement>(
          `[data-te-track-id="${CSS.escape(id)}"]`
        )) {
          if (row.closest(SKIP_SELECTOR)) continue
          const target = scrollParent(row)
          if (!target) continue
          const rows = targets.get(target) ?? []
          rows.push(row)
          targets.set(target, rows)
        }
      }
    }
    for (const [container, registration] of registrations) {
      if (targets.has(container)) continue
      registration.handle.dispose()
      registrations.delete(container)
    }
    for (const [container, rows] of targets) {
      let registration = registrations.get(container)
      if (!registration) {
        const entry: DomRegistration = {
          rows,
          handle: registerTrackLocator(container, {
            bounds: () =>
              entry.rows.flatMap((row): TrackBounds[] => {
                if (!row.isConnected || !row.getClientRects().length) return []
                const rect = row.getBoundingClientRect()
                if (!rect.height || !rect.width) return []
                const heading = row.closest('table')?.tHead
                return [
                  {
                    top: rect.top,
                    bottom: rect.bottom,
                    visibleTop: heading?.getBoundingClientRect().bottom
                  }
                ]
              })
          })
        }
        registration = entry
        registrations.set(container, registration)
      }
      registration.rows = rows
      registration.handle.refresh()
    }
  }

  function schedule(): void {
    if (!disposed && frame === null) frame = requestAnimationFrame(refresh)
  }

  watch(
    root,
    (element, _previous, onCleanup) => {
      schedule()
      if (!element) return
      const mutations = new MutationObserver(schedule)
      mutations.observe(element, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-te-track-id', 'hidden', 'style', 'inert']
      })
      const resize = new ResizeObserver(schedule)
      resize.observe(element)
      onCleanup(() => {
        mutations.disconnect()
        resize.disconnect()
      })
    },
    { immediate: true, flush: 'post' }
  )
  watch(currentTrackId, schedule, { flush: 'post' })
  onUpdated(schedule)
  onBeforeUnmount(() => {
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    for (const registration of registrations.values()) registration.handle.dispose()
    registrations.clear()
  })
  return root
}
