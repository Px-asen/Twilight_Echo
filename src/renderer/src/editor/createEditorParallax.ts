import { APPEARANCE_LAYER_TILT_LIMITS, type AppearanceLayerTilt } from './appearanceLayerView.ts'
import type { EditorFrameClock } from './createEditorViewport.ts'
import type { EditorPoint } from './viewportGeometry.ts'

const neutral = (): AppearanceLayerTilt => ({ x: 0, y: 0 })
const equal = (a: AppearanceLayerTilt, b: AppearanceLayerTilt) => a.x === b.x && a.y === b.y
const inside = (point: EditorPoint) =>
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  Math.abs(point.x) <= 1 &&
  Math.abs(point.y) <= 1
const pointerTilt = (point: EditorPoint): AppearanceLayerTilt => ({
  x: -point.y * APPEARANCE_LAYER_TILT_LIMITS.x || 0,
  y: point.x * APPEARANCE_LAYER_TILT_LIMITS.y || 0
})

/** Follow the latest pointer once per frame; only entry and exit have a bounded easing. */
export function createEditorParallax(options: {
  clock: EditorFrameClock
  render: (tilt: AppearanceLayerTilt) => void
}) {
  let current = neutral(),
    goal = neutral()
  let active = true,
    disposed = false
  let frame: number | undefined,
    generation = 0
  let easing:
    | {
        kind: 'entry' | 'exit'
        from: AppearanceLayerTilt
        to: AppearanceLayerTilt
        started: number
      }
    | undefined

  function stop(): void {
    generation++
    if (frame !== undefined) options.clock.cancel(frame)
    frame = undefined
  }
  function publish(value: AppearanceLayerTilt): void {
    if (equal(current, value)) return
    current = value
    options.render({ ...value })
  }
  function request(): void {
    if (!active || disposed || frame !== undefined) return
    const revision = generation
    frame = options.clock.request((time) => tick(time, revision))
  }
  function tick(time: number, revision: number): void {
    if (revision !== generation || !active || disposed) return
    frame = undefined
    const transition = easing
    if (!transition) {
      publish({ ...goal })
      return
    }
    const progress = Math.max(0, Math.min(1, (time - transition.started) / 120))
    const weight = 1 - (1 - progress) ** 3
    if (progress === 1) easing = undefined
    publish({
      x:
        progress === 1
          ? transition.to.x
          : transition.from.x + (transition.to.x - transition.from.x) * weight,
      y:
        progress === 1
          ? transition.to.y
          : transition.from.y + (transition.to.y - transition.from.y) * weight
    })
    if (revision === generation && easing === transition) request()
  }
  function target(value: AppearanceLayerTilt, animate?: 'entry' | 'exit'): void {
    if (!active || disposed) return
    // High-rate native move events keep one bounded entry envelope instead of
    // repeatedly restarting it, or cancelling it before its first frame.
    if (equal(goal, value) && (!easing || equal(easing.to, value))) return
    goal = value
    if (!animate && easing?.kind === 'entry') {
      easing.to = { ...goal }
      request()
      return
    }
    if (equal(current, goal)) {
      stop()
      easing = undefined
      return
    }
    if (animate) {
      stop()
      easing = {
        kind: animate,
        from: { ...current },
        to: { ...goal },
        started: options.clock.now()
      }
    } else easing = undefined
    request()
  }
  return {
    enter(point: EditorPoint): void {
      if (inside(point)) target(pointerTilt(point), 'entry')
      else target(neutral(), 'exit')
    },
    setPointer(point: EditorPoint): void {
      if (inside(point)) target(pointerTilt(point))
      else target(neutral(), 'exit')
    },
    reset(animate = true): void {
      if (animate) target(neutral(), 'exit')
      else if (active && !disposed) {
        stop()
        easing = undefined
        goal = neutral()
        publish(neutral())
      }
    },
    setActive(value: boolean): void {
      if (disposed || active === value) return
      active = value
      if (!value) {
        stop()
        easing = undefined
        goal = neutral()
        publish(neutral())
      }
    },
    dispose(): void {
      disposed = true
      active = false
      stop()
      easing = undefined
      current = goal = neutral()
    }
  }
}
