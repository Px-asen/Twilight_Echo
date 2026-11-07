<script lang="ts">
import type { MotionSample } from '@renderer/app/motion/trajectory'
interface Projection {
  animation: Animation
  sample(): MotionSample
  release(): void
}
// Adjacent disclosures can move the same section. Ownership transfers with
// its visible position and velocity, so they never fight over the transform.
const siblingMotion = new WeakMap<HTMLElement, Projection>()
</script>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { motionDuration, observeMotionPolicy, surfaceMotionMode } from '@renderer/app/motion/policy'
import { createMotionTrajectory, restingMotion } from '@renderer/app/motion/trajectory'
import MotionTransition from '../MotionTransition.vue'

defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    open: boolean
    tag?: string
    boundary?: string
    triggerSelector?: string
    keepMounted?: boolean
  }>(),
  { tag: 'div', boundary: '.settings-preview-stack' }
)
const root = ref<HTMLElement | null>(null)
const rendered = ref(props.open || props.keepMounted)
const movements = new Map<HTMLElement, Projection>()
let before = new Map<HTMLElement, { rect: DOMRect; velocity: number[] }>()

function capture(): void {
  before = new Map()
  let branch = root.value
  // Only siblings are projected: nested descendants must never move twice.
  while (branch && !branch.matches(props.boundary)) {
    let sibling = branch.nextElementSibling
    while (sibling) {
      if (sibling instanceof HTMLElement && sibling.getClientRects().length) {
        before.set(sibling, {
          rect: sibling.getBoundingClientRect(),
          velocity: siblingMotion.get(sibling)?.sample().velocity ?? [0, 0]
        })
      }
      sibling = sibling.nextElementSibling
    }
    branch = branch.parentElement
  }
  for (const element of before.keys()) siblingMotion.get(element)?.release()
  for (const movement of [...movements.values()]) movement.release()
}

function relocate(opening: boolean): void {
  const panel = root.value
  if (!panel || surfaceMotionMode(document) !== 'full') {
    before.clear()
    return
  }
  const duration = motionDuration(
    panel,
    opening ? '--te-motion-surface-enter' : '--te-motion-surface-exit',
    opening ? 200 : 140
  )
  if (!duration) {
    before.clear()
    return
  }
  for (const [element, previous] of before) {
    if (!element.isConnected) continue
    const rect = element.getBoundingClientRect()
    const offset = [previous.rect.left - rect.left, previous.rect.top - rect.top]
    if (
      offset.every((value) => Math.abs(value) < 0.5) &&
      previous.velocity.every((v) => Math.abs(v) < 1)
    )
      continue
    const base = getComputedStyle(element).transform
    const trajectory = createMotionTrajectory(
      { ...restingMotion(offset), velocity: previous.velocity },
      [0, 0],
      duration
    )
    const animation = element.animate(
      trajectory.keyframes(([x, y]) => ({
        transform: `translate3d(${x}px,${y}px,0) ${base === 'none' ? '' : base}`.trim()
      })),
      { duration, easing: 'linear', fill: 'both' }
    )
    const projection: Projection = {
      animation,
      sample: () => trajectory.sample(Number(animation.currentTime ?? 0)),
      release() {
        animation.cancel()
        if (movements.get(element) === projection) movements.delete(element)
        if (siblingMotion.get(element) === projection) siblingMotion.delete(element)
      }
    }
    movements.set(element, projection)
    siblingMotion.set(element, projection)
    void animation.finished.then(projection.release, projection.release)
  }
  before.clear()
}

function restoreTriggerFocus(): void {
  const panel = root.value
  const sibling = panel?.previousElementSibling
  const trigger = props.triggerSelector
    ? panel?.parentElement?.querySelector(props.triggerSelector)
    : sibling?.matches('button, input, [tabindex]')
      ? sibling
      : sibling?.querySelector('button, input, [tabindex]')
  if (trigger instanceof HTMLElement) trigger.focus({ preventScroll: true })
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      capture()
      rendered.value = true
    } else if (root.value?.contains(document.activeElement)) restoreTriggerFocus()
  },
  { flush: 'sync' }
)
function afterLeave(): void {
  relocate(false)
  if (!props.open && !props.keepMounted) rendered.value = false
}
function beforeFinish(_element: HTMLElement, entering: boolean): void {
  // Keep content inside its original card while it fades. Capture immediately
  // before v-show removes its space, then project the following rows together.
  if (!entering) capture()
}
const stopPolicy = observeMotionPolicy(document, () => {
  for (const movement of [...movements.values()]) movement.release()
  before.clear()
})
onBeforeUnmount(() => {
  stopPolicy()
  for (const movement of [...movements.values()]) movement.release()
})
</script>

<template>
  <MotionTransition
    name="disclosure"
    :pin="false"
    @enter="relocate(true)"
    @before-finish="beforeFinish"
    @after-leave="afterLeave"
  >
    <component :is="tag" v-show="open" ref="root" v-bind="$attrs" :inert="!open">
      <slot v-if="rendered" />
    </component>
  </MotionTransition>
</template>
