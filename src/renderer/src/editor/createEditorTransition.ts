import type { EditorFrameClock } from './createEditorViewport.ts'

/** Frame-driven progress shared by editor view transitions. */
export function createEditorTransition(options: {
  clock: EditorFrameClock
  render: (value: number) => void
  motion?: (running: boolean) => void
  duration?: number
}) {
  const requestedDuration = options.duration ?? 400
  const duration =
    Number.isFinite(requestedDuration) && requestedDuration >= 0 ? requestedDuration : 400
  let value = 0,
    target = 0,
    generation = 0
  let frame: number | undefined
  let velocity = 0
  let active = true,
    animated = true,
    running = false,
    disposed = false

  function markRunning(next: boolean): void {
    if (running === next) return
    running = next
    options.motion?.(next)
  }
  function stop(): number {
    const revision = ++generation
    const pending = frame
    frame = undefined
    if (pending !== undefined) options.clock.cancel(pending)
    markRunning(false)
    return revision
  }
  function publish(next: number): void {
    if (disposed || !active || next === value) return
    value = next
    options.render(next)
  }
  function current(revision: number): boolean {
    return !disposed && active && revision === generation
  }
  function settle(): void {
    const revision = stop()
    velocity = 0
    if (current(revision)) publish(target)
  }
  function move(animate: boolean): void {
    const revision = stop()
    if (!current(revision)) return
    if (!animated || !animate || duration === 0 || value === target) {
      velocity = 0
      publish(target)
      return
    }
    const from = value,
      to = target,
      travelDuration = duration * Math.max(0.35, Math.sqrt(Math.abs(to - from))),
      tangent = Math.max(
        -3 * Math.abs(to - from),
        Math.min(3 * Math.abs(to - from), velocity * travelDuration)
      ),
      started = options.clock.now()
    const tick = (time: number): void => {
      // A cancelled callback may already have been queued by the host.
      if (!current(revision)) return
      frame = undefined
      const p = Math.min(1, Math.max(0, (time - started) / travelDuration))
      // Hermite interpolation retains the visible velocity when a gesture is
      // reversed, rather than restarting a slow ease-in at each click.
      const next =
        from + (to - from) * (3 * p ** 2 - 2 * p ** 3) + tangent * (p ** 3 - 2 * p ** 2 + p)
      velocity =
        ((to - from) * (6 * p - 6 * p ** 2) + tangent * (3 * p ** 2 - 4 * p + 1)) / travelDuration
      publish(p === 1 ? to : Math.max(0, Math.min(1, next)))
      if (!current(revision)) return
      if (p < 1) frame = options.clock.request(tick)
      else markRunning(false)
    }
    markRunning(true)
    if (current(revision)) frame = options.clock.request(tick)
  }

  return {
    setTarget(next: number, animate = true): void {
      if (disposed || !Number.isFinite(next)) return
      next = Math.min(1, Math.max(0, next))
      if (next === target) {
        if (!animate && active && running) settle()
        return
      }
      target = next
      move(animate)
    },
    setActive(next: boolean): void {
      if (disposed || active === next) return
      active = next
      // Resume directly at the latest target rather than replaying hidden changes.
      settle()
    },
    setAnimated(next: boolean): void {
      if (disposed || animated === next) return
      animated = next
      if (!animated) settle()
    },
    finish(): void {
      if (!disposed) settle()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stop()
    },
    get value(): number {
      return value
    },
    get target(): number {
      return target
    },
    get running(): boolean {
      return running
    }
  }
}
