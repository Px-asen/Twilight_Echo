<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  createEqKnobGesture,
  createEqWheelCommit,
  eqParameterLimits,
  eqParameterPosition,
  normalizeEqParameter,
  nudgeEqParameter
} from '@renderer/utils/parametricEqKnob'
import type { EqParameter } from '@renderer/utils/parametricEqKnob'

const props = defineProps<{ field: EqParameter; value: number; disabled?: boolean }>()
const emit = defineEmits<{
  preview: [value: number]
  commit: []
  interaction: [active: boolean]
}>()
const faceRef = ref<HTMLElement | null>(null)
const displayedValue = ref(props.value)
const heldPointer = ref<number | null>(null)
const labels = { frequency: '频率', gain: '增益', q: 'Q 值' }
const captions = { frequency: 'FREQ', gain: 'GAIN', q: 'Q' }
const limits = computed(() => eqParameterLimits[props.field])
const position = computed(() => eqParameterPosition(props.field, displayedValue.value))
const readout = computed(() =>
  props.field === 'frequency'
    ? String(Math.round(displayedValue.value))
    : displayedValue.value.toFixed(props.field === 'gain' ? 1 : 2)
)

function preview(value: number): void {
  displayedValue.value = value
  emit('preview', value)
}

function commit(): void {
  emit('commit')
  emit('interaction', false)
}

const gesture = createEqKnobGesture({
  field: props.field,
  readValue: () => displayedValue.value,
  preview,
  commit
})
const wheel = createEqWheelCommit(commit)

function beginDrag(event: PointerEvent): void {
  if (props.disabled || event.button !== 0 || gesture.active()) return
  wheel.flush()
  if (!gesture.start(event.pointerId, event.clientY)) return
  heldPointer.value = event.pointerId
  faceRef.value?.focus({ preventScroll: true })
  faceRef.value?.setPointerCapture(event.pointerId)
  emit('interaction', true)
}

function endDrag(event: PointerEvent): void {
  if (!gesture.finish(event.pointerId)) return
  heldPointer.value = null
  if (faceRef.value?.hasPointerCapture(event.pointerId)) {
    faceRef.value.releasePointerCapture(event.pointerId)
  }
  emit('interaction', false)
}

function finishInteraction(): void {
  gesture.finish()
  wheel.flush()
  const pointerId = heldPointer.value
  heldPointer.value = null
  if (pointerId !== null && faceRef.value?.hasPointerCapture(pointerId)) {
    faceRef.value.releasePointerCapture(pointerId)
  }
  emit('interaction', false)
}

function handleWheel(event: WheelEvent): void {
  if (props.disabled || gesture.active() || event.deltaY === 0) return
  const value = nudgeEqParameter(
    props.field,
    displayedValue.value,
    event.deltaY < 0 ? 1 : -1,
    event.shiftKey
  )
  if (value === displayedValue.value) return
  if (!wheel.pending()) emit('interaction', true)
  preview(value)
  wheel.schedule()
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  const direction = ['ArrowUp', 'ArrowRight'].includes(event.key)
    ? 1
    : ['ArrowDown', 'ArrowLeft'].includes(event.key)
      ? -1
      : 0
  if (!direction && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  event.stopPropagation()
  finishInteraction()
  const value = direction
    ? nudgeEqParameter(props.field, displayedValue.value, direction, event.shiftKey)
    : event.key === 'Home'
      ? limits.value.min
      : limits.value.max
  if (value === displayedValue.value) return
  preview(value)
  commit()
}

function updateNumeric(event: Event): void {
  finishInteraction()
  const input = event.target as HTMLInputElement
  if (!Number.isFinite(input.valueAsNumber)) {
    input.value = readout.value
    return
  }
  const value = normalizeEqParameter(props.field, input.valueAsNumber)
  input.value = String(value)
  if (value === displayedValue.value) return
  preview(value)
  commit()
}

watch(
  () => props.value,
  (value) => {
    if (!gesture.active() && !wheel.pending()) displayedValue.value = value
  }
)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) finishInteraction()
  }
)
onBeforeUnmount(finishInteraction)
defineExpose({ finishInteraction })
</script>

<template>
  <div class="eq-parameter-knob" :class="[field, { disabled, dragging: heldPointer !== null }]">
    <div
      ref="faceRef"
      class="knob-face"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      :aria-label="labels[field]"
      :aria-disabled="disabled || undefined"
      :aria-valuemin="limits.min"
      :aria-valuemax="limits.max"
      :aria-valuenow="displayedValue"
      :aria-valuetext="`${readout} ${field === 'frequency' ? 'Hz' : field === 'gain' ? 'dB' : ''}`"
      :data-eq-parameter="field"
      title="上下拖动或滚轮调节 · Shift 精调 · 方向键微调"
      @pointerdown.prevent.stop="beginDrag"
      @pointermove.prevent.stop="gesture.move($event.pointerId, $event.clientY, $event.shiftKey)"
      @pointerup.prevent.stop="endDrag"
      @pointercancel.stop="endDrag"
      @lostpointercapture="endDrag"
      @wheel.prevent.stop="handleWheel"
      @keydown="handleKeydown"
    >
      <svg class="knob-ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle
          class="knob-track"
          cx="32"
          cy="32"
          r="28"
          pathLength="100"
          stroke-dasharray="75 100"
        />
        <circle
          class="knob-value"
          cx="32"
          cy="32"
          r="28"
          pathLength="100"
          :stroke-dasharray="`${position * 75} 100`"
        />
      </svg>
      <span class="knob-disc">
        <i :style="{ transform: `rotate(${position * 270 - 135}deg)` }"></i>
      </span>
    </div>
    <span class="knob-caption">{{ captions[field] }}</span>
    <label class="knob-readout">
      <input
        type="number"
        :aria-label="`${labels[field]}数值`"
        :min="limits.min"
        :max="limits.max"
        :step="limits.step"
        :disabled="disabled"
        :value="readout"
        @change="updateNumeric"
        @blur="updateNumeric"
        @keydown.enter.prevent="updateNumeric"
      />
      <span v-if="field !== 'q'">{{ field === 'frequency' ? 'Hz' : 'dB' }}</span>
    </label>
  </div>
</template>

<style scoped>
.eq-parameter-knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--eq-text);
}
.eq-parameter-knob.disabled {
  opacity: 0.35;
}
.knob-face {
  position: relative;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  cursor: ns-resize;
  touch-action: none;
  outline-offset: 4px;
}
.gain .knob-face {
  width: 78px;
  height: 78px;
}
.disabled .knob-face {
  cursor: default;
}
.knob-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.knob-ring circle {
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  transform: rotate(135deg);
  transform-origin: center;
}
.knob-track {
  stroke: var(--eq-knob-track);
}
.knob-value {
  stroke: var(--eq-response);
}
.knob-disc {
  position: absolute;
  inset: 8px;
  border: 1px solid var(--eq-knob-edge);
  border-radius: 50%;
  background: linear-gradient(145deg, var(--eq-knob-light), var(--eq-knob-dark));
  box-shadow:
    inset 0 1px 1px var(--eq-highlight),
    0 2px 5px var(--eq-shadow);
}
.knob-disc i {
  position: absolute;
  inset: 3px;
}
.knob-disc i::before {
  content: '';
  position: absolute;
  top: 2px;
  left: calc(50% - 1px);
  width: 2px;
  height: 5px;
  border-radius: 1px;
  background: var(--eq-text-muted);
}
.knob-face:focus-visible {
  outline: 2px solid var(--eq-response);
}
.dragging .knob-disc {
  border-color: var(--eq-response);
}
.knob-caption {
  color: var(--eq-text-muted);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.14em;
}
.knob-readout {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 3px;
  min-height: 22px;
  font-family: var(--eq-mono);
  font-size: 10px;
  color: var(--eq-text-muted);
}
.knob-readout input {
  width: 47px;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  border-bottom: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--eq-text);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
}
.q .knob-readout input {
  width: 48px;
  text-align: center;
}
.knob-readout input:focus {
  outline: none;
  border-color: var(--eq-response);
}
.knob-readout input::-webkit-inner-spin-button,
.knob-readout input::-webkit-outer-spin-button {
  appearance: none;
}
@media (hover: hover) and (pointer: fine) {
  .knob-face:hover .knob-disc {
    border-color: var(--eq-text-muted);
  }
}
</style>
