<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { motionDuration, observeMotionPolicy, surfaceMotionMode } from '../app/motion/policy'
import { createMotionTrajectory, restingMotion, type MotionSample } from '../app/motion/trajectory'

defineOptions({ inheritAttrs: false })
const emit = defineEmits<{ beforeFinish: [element: HTMLElement, entering: boolean] }>()
const props = withDefaults(
  defineProps<{
    name?: string
    pin?: boolean
    appear?: boolean
    immediateLeave?: boolean
    snapshot?: boolean
    waitForEnter?: boolean
    panel?: string
    disabled?: boolean
  }>(),
  {
    name: 'page-down',
    pin: true,
    appear: false,
    immediateLeave: false,
    snapshot: false,
    waitForEnter: false
  }
)
interface Job {
  animation: Animation
  animations: Animation[]
  base: string
  name: string
  sample(): MotionSample
  finish(): void
}
interface Handoff {
  identity: string
  name: string
  base: string
  frame: MotionSample
}
const jobs = new Map<HTMLElement, Job>()
const bases = new Map<HTMLElement, string>()
const arrivals = new Map<HTMLElement, MotionSample>()
const restorers = new Map<HTMLElement, () => void>()
const snapshots = new Set<HTMLElement>()
const pending = new Map<HTMLElement, { start(): void; remove(): void }>()
let leaving: HTMLElement | undefined
let handoff: Handoff | undefined
const stopPolicy = observeMotionPolicy(document, () => {
  handoff = undefined
  for (const painter of [...pending.values()]) painter.remove()
  for (const job of [...jobs.values()]) job.finish()
})

function identity(element: HTMLElement): string {
  return `${element.tagName}:${element.classList[0] ?? ''}`
}

function vector(entering: boolean): [number, number] {
  const name = props.name
  // These roots own viewport-fixed chrome. A transform, even an identity
  // transform, would temporarily change its containing block.
  if (name === 'playing-page' || name === 'settings-page') return [0, 0]
  if (name === 'dialog' || name === 'popover') return [0, 0]
  if (name === 'disclosure') return [0, entering ? 6 : 4]
  const sign = entering ? 1 : -1
  if (name === 'drawer-right') return [entering ? 28 : 20, 0]
  if (name === 'drawer-left') return [entering ? -28 : -20, 0]
  if (name.endsWith('forward')) return [sign * 20, 0]
  if (name.endsWith('back')) return [-sign * 20, 0]
  if (name.includes('drawer')) return [0, entering ? 18 : 12]
  if (name.includes('settings') || name.includes('login')) return [0, entering ? 10 : 6]
  return [0, (name.endsWith('up') ? -1 : 1) * sign * (entering ? 16 : 10)]
}
function movementTarget(element: HTMLElement): HTMLElement {
  return (props.panel && element.querySelector<HTMLElement>(props.panel)) || element
}
function translated(values: number[], base: string): string {
  const movement = values[0] || values[1] ? `translate3d(${values[0]}px,${values[1]}px,0)` : ''
  const scale = values[3] !== undefined && values[3] !== 1 ? `scale(${values[3]})` : ''
  return `${movement} ${base === 'none' ? '' : base} ${scale}`.trim() || 'none'
}
function opacity(values: number[]): number {
  return Math.min(1, Math.max(0, values[2]))
}
function pinLeavingSurface(element: HTMLElement, original = element): void {
  if (!props.pin || restorers.has(element)) return
  const style = getComputedStyle(original)
  if (style.position === 'fixed' || style.position === 'absolute') return
  const rect = original.getBoundingClientRect()
  const transform = new DOMMatrix(style.transform)
  const parent = original.offsetParent as HTMLElement | null
  if (!parent) return
  const container = parent.getBoundingClientRect()
  const keys = [
    'position',
    'left',
    'top',
    'width',
    'height',
    'min-height',
    'max-height',
    'margin',
    'box-sizing',
    'grid-area',
    'overflow',
    'z-index'
  ]
  const previous = keys.map((key) => [
    key,
    element.style.getPropertyValue(key),
    element.style.getPropertyPriority(key)
  ])
  const values: Record<string, string> = {
    position: 'absolute',
    left: `${rect.left - transform.m41 - container.left - parent.clientLeft + parent.scrollLeft}px`,
    top: `${rect.top - transform.m42 - container.top - parent.clientTop + parent.scrollTop}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    'min-height': '0',
    'max-height': 'none',
    margin: '0',
    'box-sizing': 'border-box',
    'grid-area': 'auto',
    overflow: 'hidden',
    'z-index': '0'
  }
  for (const [key, value] of Object.entries(values))
    element.style.setProperty(key, value, 'important')
  restorers.set(element, () => {
    for (const [key, value, priority] of previous) {
      if (value) element.style.setProperty(key, value, priority)
      else element.style.removeProperty(key)
    }
    restorers.delete(element)
  })
}
function beforeEnter(node: Element): void {
  for (const painter of [...pending.values()]) painter.start()
  const element = node as HTMLElement
  if (handoff && handoff.name === props.name && handoff.identity === identity(element)) {
    bases.set(element, handoff.base)
    arrivals.set(element, handoff.frame)
  }
  handoff = undefined
  restorers.get(element)?.()
  element.inert = false
}
function afterLeave(node: Element): void {
  const element = node as HTMLElement
  const job = jobs.get(element)
  if (!job) return
  // A v-if reopen replaces the DOM node. Vue completes the old leave before
  // before-enter, so sample its still-running WAAPI effect rather than reading
  // computed styles from the now-detached node. Normal completion has no job.
  if (!props.snapshot) {
    handoff = { identity: identity(element), name: job.name, base: job.base, frame: job.sample() }
  }
  job.finish()
}
function beforeLeave(node: Element): void {
  for (const painter of [...pending.values()]) painter.remove()
  const element = node as HTMLElement
  if (leaving && leaving !== element) jobs.get(leaving)?.finish()
  leaving = element
  element.inert = true
  if (!props.snapshot) pinLeavingSurface(element)
}
function play(node: Element, done: () => void, entering: boolean, initial?: MotionSample): void {
  const element = node as HTMLElement
  const previous = jobs.get(element)
  const from = initial ?? previous?.sample()
  previous?.animations.forEach((animation) => animation.cancel())
  jobs.delete(element)
  const mode = props.disabled ? 'off' : surfaceMotionMode(element.ownerDocument)
  const moving = movementTarget(element)
  const base = bases.get(element) ?? getComputedStyle(moving).transform
  bases.set(element, base)
  const displaced = mode === 'full' ? vector(entering) : [0, 0]
  const compact = props.name === 'popover' || props.name === 'dialog' || props.name === 'disclosure'
  const scale = mode === 'full' && (props.name === 'popover' || props.name === 'dialog') ? 0.97 : 1
  const duration =
    mode === 'off' || (!entering && props.immediateLeave)
      ? 0
      : mode === 'reduced'
        ? 100
        : motionDuration(
            element,
            compact
              ? entering
                ? '--te-motion-surface-enter'
                : props.name === 'disclosure'
                  ? '--te-motion-disclosure-exit'
                  : '--te-motion-surface-exit'
              : props.name.includes('drawer')
                ? entering
                  ? '--te-motion-panel'
                  : '--te-motion-exit'
                : entering
                  ? '--te-motion-page-enter'
                  : '--te-motion-page-exit',
            entering ? (compact ? 200 : 240) : props.name === 'disclosure' ? 100 : 140
          )
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    jobs.get(element)?.animations.forEach((animation) => animation.cancel())
    jobs.delete(element)
    delete element.dataset.motionPhase
    delete element.dataset.motionSurface
    emit('beforeFinish', element, entering)
    done()
    restorers.get(element)?.()
    bases.delete(element)
    if (leaving === element) leaving = undefined
  }
  if (!duration) {
    finish()
    return
  }
  element.dataset.motionPhase = entering ? 'enter' : 'leave'
  element.dataset.motionSurface = props.name
  const trajectory = createMotionTrajectory(
    from ?? restingMotion(entering ? [...displaced, 0, scale] : [0, 0, 1, 1]),
    entering ? [0, 0, 1, 1] : [...displaced, 0, scale],
    duration
  )
  const timing: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'both' }
  const animation = element.animate(
    trajectory.keyframes((values) => ({
      opacity: opacity(values),
      ...(moving === element ? { transform: translated(values, base) } : {})
    })),
    timing
  )
  const animations = [animation]
  if (moving !== element) {
    animations.push(
      moving.animate(
        trajectory.keyframes((values) => ({
          transform: translated(values, base)
        })),
        timing
      )
    )
  }
  const job: Job = {
    animation,
    animations,
    base,
    name: props.name,
    sample() {
      const state = trajectory.sample(Number(animation.currentTime ?? 0))
      const visibleOpacity = opacity(state.values)
      if (visibleOpacity !== state.values[2]) {
        state.values[2] = visibleOpacity
        state.velocity[2] = 0
      }
      return state
    },
    finish
  }
  jobs.set(element, job)
  if (element instanceof HTMLDialogElement) {
    // showModal runs in the child's mounted hook, after enter. Animating a
    // backdrop before it exists loses that effect when the top layer is created.
    // This microtask still installs the inherited first frame before paint.
    const backdrop = (): void => {
      if (jobs.get(element) !== job || !element.matches(':modal')) return
      const effect = element.animate(
        trajectory.keyframes((values) => ({ opacity: opacity(values) })),
        { ...timing, pseudoElement: '::backdrop' }
      )
      effect.currentTime = animation.currentTime
      animations.push(effect)
    }
    if (element.matches(':modal')) backdrop()
    else queueMicrotask(backdrop)
  }
  void animation.finished.then(
    () => {
      if (jobs.get(element) === job) finish()
    },
    () => {}
  )
}
function enter(node: Element, done: () => void): void {
  const element = node as HTMLElement
  const arrival = arrivals.get(element)
  arrivals.delete(element)
  play(node, done, true, arrival)
}
function leave(node: Element, done: () => void): void {
  const element = node as HTMLElement
  if (!props.snapshot || props.immediateLeave || surfaceMotionMode(document) === 'off') {
    play(element, done, false)
    return
  }
  // The outgoing view is a frozen painter. Its Vue refs, queries and scroll
  // observers are released immediately, before the next view mounts.
  const style = getComputedStyle(element)
  const from = jobs.get(element)?.sample() ?? restingMotion([0, 0, Number(style.opacity), 1])
  const base = bases.get(element) ?? style.transform
  const copy = element.cloneNode(true) as HTMLElement
  const scrollPositions = [element, ...element.querySelectorAll<HTMLElement>('*')].map((child) => ({
    top: child.scrollTop,
    left: child.scrollLeft
  }))
  copy.inert = true
  copy.setAttribute('aria-hidden', 'true')
  copy.dataset.motionSnapshot = 'true'
  copy.removeAttribute('id')
  copy.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'))
  element.before(copy)
  pinLeavingSurface(copy, element)
  ;[copy, ...copy.querySelectorAll<HTMLElement>('*')].forEach((child, index) => {
    if (scrollPositions[index].top) child.scrollTop = scrollPositions[index].top
    if (scrollPositions[index].left) child.scrollLeft = scrollPositions[index].left
  })
  jobs.get(element)?.animations.forEach((animation) => animation.cancel())
  jobs.delete(element)
  bases.delete(element)
  snapshots.add(copy)
  bases.set(copy, base)
  leaving = copy
  done()
  const remove = (): void => {
    pending.delete(copy)
    bases.delete(copy)
    restorers.get(copy)?.()
    copy.remove()
    snapshots.delete(copy)
  }
  const start = (): void => {
    pending.delete(copy)
    if (copy.isConnected) play(copy, remove, false, from)
  }
  // before-enter fires on the actual destination, including lazy components.
  // The caller distinguishes a pending destination from hiding this surface.
  if (props.waitForEnter) {
    copy.style.opacity = String(opacity(from.values))
    copy.style.transform = translated(from.values, base)
    pending.set(copy, { start, remove })
  } else start()
}
// Vue invokes cancellation immediately before the opposite hook. Keep the
// running effect until that hook samples it, so reversals never restart at zero.
onBeforeUnmount(() => {
  stopPolicy()
  for (const [element, job] of jobs) {
    job.animations.forEach((animation) => animation.cancel())
    restorers.get(element)?.()
  }
  jobs.clear()
  bases.clear()
  arrivals.clear()
  handoff = undefined
  for (const copy of snapshots) copy.remove()
  snapshots.clear()
  for (const painter of [...pending.values()]) painter.remove()
  pending.clear()
})
</script>

<template>
  <Transition
    v-bind="$attrs"
    :css="false"
    :appear="appear"
    @before-enter="beforeEnter"
    @before-leave="beforeLeave"
    @enter="enter"
    @leave="leave"
    @after-leave="afterLeave"
  >
    <slot />
  </Transition>
</template>
