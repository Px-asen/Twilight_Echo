import { watch, type Ref, type WatchSource } from 'vue'
import { scrollMotionBehavior } from '@renderer/app/scrollMotion'
import {
  registerScrollToTopCompanion,
  type ScrollViewport
} from '@renderer/utils/scrollToTopButton'

export interface TrackBounds {
  top: number
  bottom: number
  /** A sticky table heading can obscure rows inside the scroll viewport. */
  visibleTop?: number
}

interface TrackLocator {
  bounds: () => TrackBounds[]
}

interface LocatorGroup {
  locators: Set<TrackLocator>
  control: ReturnType<typeof registerScrollToTopCompanion>
}

// Several song shelves may share a page scroller. They own one action together.
const groups = new Map<HTMLElement, LocatorGroup>()

export function registerTrackLocator(container: HTMLElement, locator: TrackLocator) {
  let group = groups.get(container)
  if (!group) {
    const locators = new Set<TrackLocator>()
    const candidates = () => [...locators].flatMap((entry) => entry.bounds())
    const intersects = (bounds: TrackBounds, viewport: ScrollViewport) =>
      bounds.bottom > Math.max(viewport.top, bounds.visibleTop ?? viewport.top) &&
      bounds.top < viewport.bottom
    const control = registerScrollToTopCompanion(container, {
      label: '定位正在播放的歌曲',
      icon: 'ph ph-crosshair',
      isVisible: (viewport) => {
        const rows = candidates()
        return rows.length > 0 && !rows.some((bounds) => intersects(bounds, viewport))
      },
      activate: (viewport) => {
        const rows = candidates()
        if (rows.some((bounds) => intersects(bounds, viewport))) return
        const center = (viewport.top + viewport.bottom) / 2
        // Prefer the closest occurrence when a song appears on multiple shelves.
        const row = rows.sort(
          (a, b) =>
            Math.abs((a.top + a.bottom) / 2 - center) - Math.abs((b.top + b.bottom) / 2 - center)
        )[0]
        if (!row) return
        container.scrollTo({
          top: container.scrollTop + (row.top + row.bottom) / 2 - center,
          behavior: scrollMotionBehavior()
        })
      }
    })
    group = { locators, control }
    groups.set(container, group)
  }
  const owner = group
  owner.locators.add(locator)
  owner.control.refresh()
  return {
    refresh: owner.control.refresh,
    dispose: () => {
      owner.locators.delete(locator)
      if (owner.locators.size) owner.control.refresh()
      else {
        owner.control.dispose()
        if (groups.get(container) === owner) groups.delete(container)
      }
    }
  }
}

/** Virtual lists supply bounds even when their current row is not mounted. */
export function useTrackLocator(
  container: Readonly<Ref<HTMLElement | null>>,
  locator: TrackLocator,
  sources: WatchSource[]
): void {
  watch(
    container,
    (element, _previous, onCleanup) => {
      if (!element) return
      const registration = registerTrackLocator(element, locator)
      const stop = watch(sources, registration.refresh, { flush: 'post' })
      onCleanup(() => {
        stop()
        registration.dispose()
      })
    },
    { immediate: true, flush: 'post' }
  )
}
