import {
  BODY_CONTROL_SELECTOR,
  CARD_SURFACE_SELECTOR,
  STRUCTURAL_CONTROL_SELECTOR
} from '../../../shared/cardSurfaces.ts'
import type { EditorRect, EditorSize } from './viewportGeometry.ts'

export type AppearanceSurface = {
  id: 'card' | 'controls' | 'navigation'
  element: HTMLElement
  rect: EditorRect
  pose?: string
  /** Attached chrome keeps its module inspector; relief is presentation only. */
  interactive?: boolean
}

/** Read once when the native scene changes, never during a camera/pointer frame. */
export function measureAppearanceSurfaces(
  scene: HTMLElement,
  size: EditorSize
): AppearanceSurface[] {
  const view = scene.ownerDocument.defaultView
  const content = scene.querySelector<HTMLElement>('.app-shell-content')
  if (!view || !content) return []
  const result: AppearanceSurface[] = []
  for (const [id, selector] of [
    ['card', CARD_SURFACE_SELECTOR],
    ['controls', BODY_CONTROL_SELECTOR]
  ] as const) {
    const elements = [...content.querySelectorAll<HTMLElement>(selector)]
    if (id === 'controls')
      elements.push(
        ...[...scene.querySelectorAll<HTMLElement>(selector)].filter(
          (element) => !content.contains(element)
        )
      )
    for (const element of elements) {
      if (element.closest('[data-te-appearance-ignore],.online-skeleton,.online-loading-content'))
        continue
      if (id === 'controls' && element.matches(CARD_SURFACE_SELECTOR)) continue
      if (id === 'controls' && element.matches(STRUCTURAL_CONTROL_SELECTOR)) continue
      if (id === 'card' && element.closest('.title-bar,.side-menu,.player-bar-shell')) continue
      if (id === 'card' && element.parentElement?.closest(CARD_SURFACE_SELECTOR)) continue
      const rect = element.getBoundingClientRect()
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= size.width ||
        rect.top >= size.height
      )
        continue
      const style = view.getComputedStyle(element)
      if (
        (style.visibility !== 'visible' && scene.style.visibility !== 'hidden') ||
        style.display === 'none'
      )
        continue
      result.push({
        id,
        element,
        interactive: !element.closest('.title-bar,.side-menu'),
        pose:
          id === 'controls'
            ? element.closest('.title-bar,.side-menu')
              ? 'chrome-controls'
              : element.closest('.player-bar-shell')
                ? 'player-controls'
                : 'controls'
            : 'card',
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })
    }
  }
  const bookmark = scene.querySelector<HTMLElement>('.sidebar-bookmark')
  if (bookmark) {
    const rect = bookmark.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0 && rect.left < size.width && rect.right > 0)
      result.push({
        id: 'navigation',
        element: bookmark,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })
  }
  return result
}
