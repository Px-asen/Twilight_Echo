<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import SmoothedProgressFill from '../SmoothedProgressFill.vue'

const props = defineProps<{
  position: number
  duration: number
  live: boolean
  abStart: number | null
  abEnd: number | null
  formatTime: (seconds: number) => string
}>()
const emit = defineEmits<{ seek: [seconds: number] }>()
const preview = ref<number | null>(null)
const keyboardFocus = ref(false)
let activePointer: number | null = null
let dragLeft = 0
let dragWidth = 1
const disabled = computed(() => props.live || props.duration <= 0)
const position = computed(() => preview.value ?? props.position)
const percent = computed(() =>
  props.live
    ? 100
    : props.duration > 0
      ? Math.min(100, Math.max(0, (position.value / props.duration) * 100))
      : 0
)
const loopStyle = computed(() => {
  const total = props.duration || 1
  const start = Math.min(total, Math.max(0, props.abStart ?? 0))
  const end = Math.min(total, Math.max(start, props.abEnd ?? start))
  return { left: `${(start / total) * 100}%`, width: `${((end - start) / total) * 100}%` }
})
watch(disabled, cancel)
onBeforeUnmount(cancel)

function onInput(event: Event): void {
  if (disabled.value) return
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) preview.value = Math.min(props.duration, Math.max(0, value))
}

function startPointer(event: PointerEvent): void {
  if (disabled.value || event.button !== 0) return
  event.preventDefault()
  const slider = event.currentTarget as HTMLInputElement
  const bounds = slider.getBoundingClientRect()
  dragLeft = bounds.left
  dragWidth = Math.max(1, bounds.width)
  activePointer = event.pointerId
  slider.focus({ preventScroll: true })
  keyboardFocus.value = false
  slider.setPointerCapture(event.pointerId)
  // Keep release reliable when Chromium hands capture to its native slider.
  window.addEventListener('pointermove', movePointer, true)
  window.addEventListener('pointerup', endPointer, true)
  window.addEventListener('pointercancel', cancelPointer, true)
  window.addEventListener('blur', cancel)
  movePointer(event)
}

function movePointer(event: PointerEvent): void {
  if (event.pointerId !== activePointer || disabled.value) return
  // Cache geometry once on press; moving never measures layout or invokes IPC.
  preview.value = Math.min(1, Math.max(0, (event.clientX - dragLeft) / dragWidth)) * props.duration
}

function cancel(): void {
  activePointer = null
  preview.value = null
  window.removeEventListener('pointermove', movePointer, true)
  window.removeEventListener('pointerup', endPointer, true)
  window.removeEventListener('pointercancel', cancelPointer, true)
  window.removeEventListener('blur', cancel)
}

function cancelPointer(event: PointerEvent): void {
  if (event.pointerId === activePointer) cancel()
}

function endPointer(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return
  movePointer(event)
  commit()
}

function commit(): void {
  // Pointer capture also commits releases outside the bar; native change
  // handles keyboard actions and cannot duplicate an already cleared preview.
  // Playback ticks cannot pull the thumb back while the pointer is dragging.
  if (!disabled.value && preview.value !== null) emit('seek', preview.value)
  cancel()
}

function onFocus(event: FocusEvent): void {
  keyboardFocus.value = (event.target as HTMLInputElement).matches(':focus-visible')
}

function onBlur(): void {
  keyboardFocus.value = false
  cancel()
}
</script>

<template>
  <div
    class="progress-area"
    :class="{ 'is-scrubbing': preview !== null, 'is-keyboard-focus': keyboardFocus }"
  >
    <span class="time-label">{{ live ? 'LIVE' : formatTime(position) }}</span>
    <div class="progress-slider-wrap" :class="{ 'is-disabled': disabled }">
      <div class="progress-track" aria-hidden="true">
        <div
          v-if="preview !== null"
          class="progress-fill"
          :style="{ transform: `scaleX(${percent / 100})` }"
        ></div>
        <SmoothedProgressFill v-else class="progress-fill" :class="{ live }" :percent="percent" />
      </div>
      <div
        v-if="abStart != null && abEnd != null && duration > 0 && !live"
        class="ab-loop-range"
        :style="loopStyle"
        aria-hidden="true"
      ></div>
      <input
        type="range"
        class="progress-slider"
        :class="{ live }"
        :value="live ? 0 : position"
        min="0"
        :max="duration || 1"
        step="0.1"
        :disabled="disabled"
        aria-label="播放进度"
        :aria-valuetext="live ? 'LIVE' : `${formatTime(position)} / ${formatTime(duration)}`"
        @pointerdown.stop="startPointer"
        @pointermove.stop
        @pointerup="endPointer"
        @input="onInput"
        @change="commit"
        @pointercancel="cancel"
        @focus="onFocus"
        @keydown="keyboardFocus = true"
        @blur="onBlur"
      />
    </div>
    <span class="time-label">{{ live ? 'LIVE' : formatTime(duration) }}</span>
  </div>
</template>
