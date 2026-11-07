<script setup lang="ts">
import { onBeforeUnmount, onBeforeUpdate, onUpdated, ref } from 'vue'
import { motionDuration, observeMotionPolicy, surfaceMotionMode } from '../app/motion/policy'
import { createMotionTrajectory, restingMotion, type MotionSample } from '../app/motion/trajectory'

defineOptions({ inheritAttrs: false })
// Slot contents can update inside TransitionGroup without updating this owner.
// Track the collection explicitly so geometry is captured before that patch.
defineProps<{ items: readonly unknown[] }>()
interface Job {
  animation: Animation
  sample(): MotionSample
  done(): void
  finish(): void
}
const root = ref<HTMLElement | null>(null)
const jobs = new Map<HTMLElement, Job>()
const leaving = new Map<HTMLElement, () => void>()
let before = new Map<HTMLElement, { rect: DOMRect; frame: MotionSample }>()
let minimumHeight: string | undefined

function play(element: HTMLElement, from: MotionSample, exit = false, done?: () => void): void {
  const complete = done ?? jobs.get(element)?.done ?? (() => {})
  jobs.get(element)?.animation.cancel()
  jobs.delete(element)
  const mode = surfaceMotionMode(document)
  const duration =
    mode === 'off' || !element.getClientRects().length
      ? 0
      : mode === 'reduced'
        ? 100
        : Math.min(
            280,
            motionDuration(
              element,
              exit ? '--te-motion-surface-exit' : '--te-toast-motion-duration',
              exit ? 140 : 240
            )
          )
  const finish = (): void => {
    jobs.get(element)?.animation.cancel()
    jobs.delete(element)
    delete element.dataset.motionPhase
    complete()
  }
  if (!duration) return finish()
  if (mode !== 'full') {
    from.values[0] = from.values[1] = 0
    from.velocity[0] = from.velocity[1] = 0
  }
  const trajectory = createMotionTrajectory(
    from,
    [exit && mode === 'full' ? 16 : 0, 0, exit ? 0 : 1],
    duration
  )
  const animation = element.animate(
    trajectory.keyframes(([x, y, alpha]) => ({
      transform: x || y ? `translate3d(${x}px,${y}px,0)` : 'none',
      opacity: Math.max(0, Math.min(1, alpha))
    })),
    { duration, easing: 'linear', fill: 'both' }
  )
  const job: Job = {
    animation,
    sample: () => trajectory.sample(Number(animation.currentTime ?? 0)),
    finish,
    done: complete
  }
  element.dataset.motionPhase = exit ? 'leave' : 'enter'
  jobs.set(element, job)
  void animation.finished.then(
    () => {
      if (jobs.get(element) === job) finish()
    },
    () => {}
  )
}

onBeforeUpdate(() => {
  before = new Map()
  for (const child of root.value?.children ?? []) {
    if (!(child instanceof HTMLElement) || leaving.has(child) || !child.getClientRects().length)
      continue
    before.set(child, {
      rect: child.getBoundingClientRect(),
      frame: jobs.get(child)?.sample() ?? restingMotion([0, 0, 1])
    })
  }
})
onUpdated(() => {
  for (const [element, previous] of before) {
    if (!element.isConnected || leaving.has(element)) continue
    const frame = jobs.get(element)?.sample() ?? restingMotion([0, 0, 1])
    const rect = element.getBoundingClientRect()
    const x = previous.rect.left - rect.left + frame.values[0]
    const y = previous.rect.top - rect.top + frame.values[1]
    if (
      Math.abs(x - previous.frame.values[0]) < 0.5 &&
      Math.abs(y - previous.frame.values[1]) < 0.5
    )
      continue
    play(element, { values: [x, y, frame.values[2]], velocity: previous.frame.velocity })
  }
  before.clear()
})
function enter(node: Element, done: () => void): void {
  const element = node as HTMLElement
  element.inert = false
  play(
    element,
    restingMotion([0, surfaceMotionMode(document) === 'full' ? -10 : 0, 0]),
    false,
    done
  )
}
function beforeLeave(node: Element): void {
  const element = node as HTMLElement
  const parent = root.value!
  const frame = jobs.get(element)?.sample() ?? restingMotion([0, 0, 1])
  const rect = element.getBoundingClientRect(),
    container = parent.getBoundingClientRect()
  // Retain the scroll viewport while the final row fades; absolute leavers
  // otherwise collapse the host and are clipped on their first exit frame.
  if (minimumHeight === undefined) {
    minimumHeight = parent.style.minHeight
    const style = getComputedStyle(parent)
    const height =
      style.boxSizing === 'border-box'
        ? parent.offsetHeight
        : parent.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    parent.style.minHeight = `${height}px`
  }
  const previous = element.getAttribute('style')
  element.style.position = 'absolute'
  element.style.left = `${rect.left - frame.values[0] - container.left - parent.clientLeft + parent.scrollLeft}px`
  element.style.top = `${rect.top - frame.values[1] - container.top - parent.clientTop + parent.scrollTop}px`
  element.style.width = `${rect.width}px`
  element.inert = true
  leaving.set(element, () => {
    if (previous === null) element.removeAttribute('style')
    else element.setAttribute('style', previous)
    leaving.delete(element)
    if (!leaving.size) {
      parent.style.minHeight = minimumHeight ?? ''
      minimumHeight = undefined
    }
  })
}
function leave(node: Element, done: () => void): void {
  const element = node as HTMLElement
  play(element, jobs.get(element)?.sample() ?? restingMotion([0, 0, 1]), true, () => {
    done()
    leaving.get(element)?.()
  })
}
const stopPolicy = observeMotionPolicy(document, () => {
  for (const job of [...jobs.values()]) job.finish()
})
onBeforeUnmount(() => {
  stopPolicy()
  for (const job of jobs.values()) job.animation.cancel()
  jobs.clear()
  for (const restore of [...leaving.values()]) restore()
})
</script>

<template>
  <div ref="root" v-bind="$attrs">
    <TransitionGroup :css="false" @enter="enter" @before-leave="beforeLeave" @leave="leave">
      <slot />
    </TransitionGroup>
  </div>
</template>
