import { onBeforeUnmount } from 'vue'
import { motionDuration, observeMotionPolicy, surfaceMotionMode } from './policy'
import { createMotionTrajectory, restingMotion } from './trajectory'

/** Only the cover moves between surfaces; lyrics and controls keep their size. */
export function useSharedArtwork(source: () => HTMLElement | null) {
  let layer: HTMLDivElement | undefined
  let animation: Animation | undefined
  let trajectory: ReturnType<typeof createMotionTrajectory> | undefined
  let layerSize = 0
  let restore: (() => void)[] = []
  let origin: DOMRect | undefined
  function finish(): void {
    animation?.cancel()
    animation = undefined
    trajectory = undefined
    layer?.remove()
    layer = undefined
    for (const release of restore) release()
    restore = []
    origin = undefined
  }
  const stopPolicy = observeMotionPolicy(document, finish)
  function hide(element: HTMLElement): void {
    const visibility = element.style.getPropertyValue('visibility')
    const priority = element.style.getPropertyPriority('visibility')
    element.style.setProperty('visibility', 'hidden', 'important')
    restore.push(() => {
      if (visibility) element.style.setProperty('visibility', visibility, priority)
      else element.style.removeProperty('visibility')
    })
  }
  function visible(element: HTMLElement | null): element is HTMLElement {
    if (!element?.isConnected || !element.getClientRects().length) return false
    const rect = element.getBoundingClientRect()
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      getComputedStyle(element).display !== 'none'
    )
  }
  function move(root: Element, entering: boolean): void {
    const cover = root.querySelector<HTMLElement>('.cover-frame')
    const small = source()
    const current = animation && trajectory?.sample(Number(animation.currentTime ?? 0))
    const captured = origin
    if (!visible(cover) || !visible(small) || surfaceMotionMode(document) !== 'full') {
      finish()
      return
    }
    const image = (entering ? small : cover).querySelector<HTMLImageElement>('img')
    if (!image?.complete || !image.naturalWidth) {
      finish()
      return
    }
    // Keep this particular cover's ordinary mount animation disabled after the
    // flight; a newly keyed cover on track change still gets its normal arrival.
    cover.dataset.sharedArtwork = 'true'
    const rectValues = (rect: DOMRect): number[] => [rect.left, rect.top, rect.width, rect.height]
    const from =
      current ??
      restingMotion(
        rectValues(
          entering ? (captured ?? small.getBoundingClientRect()) : cover.getBoundingClientRect()
        )
      )
    const to = rectValues(entering ? cover.getBoundingClientRect() : small.getBoundingClientRect())
    const duration = entering ? motionDuration(cover, '--te-motion-artwork', 360) : 260
    if (!duration) {
      finish()
      return
    }
    animation?.cancel()
    for (const release of restore) release()
    restore = []
    origin = undefined
    // A reversal keeps the same painted image and coordinate system. Only the
    // destination changes, so decoding/mounting cannot introduce a flash.
    if (!layer) {
      const size = Math.max(to[2], to[3], from.values[2], from.values[3])
      layerSize = size
      const painter = document.createElement('div')
      painter.className = 'te-shared-artwork'
      painter.setAttribute('aria-hidden', 'true')
      Object.assign(painter.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: `${size}px`,
        height: `${size}px`,
        zIndex: '12000',
        pointerEvents: 'none',
        overflow: 'hidden',
        transformOrigin: '0 0',
        borderRadius: getComputedStyle(entering ? cover : small).borderRadius,
        background: getComputedStyle(cover).backgroundColor
      })
      const copy = image.cloneNode(false) as HTMLImageElement
      copy.removeAttribute('id')
      copy.removeAttribute('class')
      copy.removeAttribute('style')
      copy.removeAttribute('srcset')
      copy.removeAttribute('sizes')
      copy.removeAttribute('loading')
      copy.src = image.currentSrc || image.src
      copy.alt = ''
      Object.assign(copy.style, {
        display: 'block',
        width: '100%',
        height: '100%',
        objectFit: 'cover'
      })
      painter.append(copy)
      document.body.append(painter)
      layer = painter
    }
    hide(cover)
    hide(small)
    trajectory = createMotionTrajectory(from, to, duration)
    const flight = layer.animate(
      trajectory.keyframes(([x, y, width, height]) => ({
        transform: `translate3d(${x}px,${y}px,0) scale(${width / layerSize},${height / layerSize})`
      })),
      {
        duration,
        easing: 'linear',
        fill: 'both'
      }
    )
    animation = flight
    void flight.finished.then(
      () => {
        if (animation === flight) finish()
      },
      () => {}
    )
  }
  window.addEventListener('resize', finish)
  onBeforeUnmount(() => {
    finish()
    stopPolicy()
    window.removeEventListener('resize', finish)
  })
  return {
    capture: () => {
      const element = source()
      origin = visible(element) ? element.getBoundingClientRect() : undefined
    },
    enter: (root: Element) => move(root, true),
    leave: (root: Element) => move(root, false),
    finish
  }
}
