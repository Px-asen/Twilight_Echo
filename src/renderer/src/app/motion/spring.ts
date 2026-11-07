/** Position and velocity after `seconds`; velocity is measured in units/second. */
export function sampleCriticalSpring(
  value: number,
  velocity: number,
  target: number,
  seconds: number,
  frequency: number
): [number, number] {
  const distance = value - target
  const tangent = velocity + frequency * distance
  const decay = Math.exp(-frequency * seconds)
  return [
    target + (distance + tangent * seconds) * decay,
    (velocity - frequency * tangent * seconds) * decay
  ]
}

/** A critically damped spring. Retargeting keeps both position and velocity. */
export function createMotionSpring(render: (values: number[]) => void, frequency = 24) {
  let value: number[] = [],
    velocity: number[] = [],
    target: number[] = []
  let frame = 0,
    last = 0
  const stop = (): void => {
    cancelAnimationFrame(frame)
    frame = 0
  }
  const settle = (): void => {
    stop()
    value = [...target]
    velocity = target.map(() => 0)
    render(value)
  }
  function tick(time: number): void {
    frame = 0
    const dt = Math.min((time - last) / 1000, 0.064)
    last = time
    let moving = false
    for (let i = 0; i < value.length; i++) {
      ;[value[i], velocity[i]] = sampleCriticalSpring(
        value[i],
        velocity[i],
        target[i],
        dt,
        frequency
      )
      if (Math.abs(value[i] - target[i]) > 0.1 || Math.abs(velocity[i]) > 0.5) moving = true
    }
    if (!moving) {
      settle()
      return
    }
    render(value)
    frame = requestAnimationFrame(tick)
  }
  return {
    to(next: number[], animate = true): void {
      target = [...next]
      if (!animate || value.length !== next.length) {
        settle()
        return
      }
      if (!frame) {
        last = performance.now()
        frame = requestAnimationFrame(tick)
      }
    },
    finish: settle,
    dispose: stop
  }
}
