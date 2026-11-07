import { sampleCriticalSpring } from './spring.ts'

export interface MotionSample {
  values: number[]
  velocity: number[]
}

export function restingMotion(values: number[]): MotionSample {
  return { values, velocity: values.map(() => 0) }
}

/** Bake the spring once; the browser plays it without a JavaScript frame loop. */
export function createMotionTrajectory(initial: MotionSample, target: number[], duration: number) {
  const seconds = duration / 1000
  const frequency = 8 / seconds
  const end = target.map((value, i) =>
    sampleCriticalSpring(initial.values[i], initial.velocity[i], value, seconds, frequency)
  )
  function at(progress: number): MotionSample {
    if (progress <= 0) return { values: [...initial.values], velocity: [...initial.velocity] }
    if (progress >= 1) return restingMotion([...target])
    // Remove the spring's tiny remaining tail with a Hermite correction. Both
    // endpoints and their velocities are exact, including an inherited velocity.
    const u = progress,
      u2 = u * u,
      u3 = u2 * u
    const values: number[] = [],
      velocity: number[] = []
    for (let i = 0; i < target.length; i++) {
      const [position, speed] = sampleCriticalSpring(
        initial.values[i],
        initial.velocity[i],
        target[i],
        u * seconds,
        frequency
      )
      const error = end[i][0] - target[i],
        endSpeed = end[i][1]
      values.push(position - error * (3 * u2 - 2 * u3) - endSpeed * seconds * (u3 - u2))
      velocity.push(speed - (error * (6 * u - 6 * u2)) / seconds - endSpeed * (3 * u2 - 2 * u))
    }
    return { values, velocity }
  }
  // Four-millisecond segments also keep retargeting smooth on 120 Hz displays.
  const steps = Math.max(2, Math.ceil(duration / 4))
  const samples = Array.from({ length: steps + 1 }, (_, i) => at(i / steps))
  return {
    duration,
    keyframes(render: (values: number[]) => Keyframe): Keyframe[] {
      return samples.map((sample, i) => ({ ...render(sample.values), offset: i / steps }))
    },
    sample(time: number): MotionSample {
      const position = Math.max(0, time / duration) * steps
      if (position >= steps) return restingMotion([...target])
      const index = Math.floor(position),
        fraction = position - index
      const left = samples[index],
        right = samples[index + 1]
      // Match the compositor's interpolated position, rather than restarting
      // from a nearby analytic position when the user reverses between frames.
      return {
        values: left.values.map((value, i) => value + (right.values[i] - value) * fraction),
        velocity: left.velocity.map((value, i) => value + (right.velocity[i] - value) * fraction)
      }
    }
  }
}
