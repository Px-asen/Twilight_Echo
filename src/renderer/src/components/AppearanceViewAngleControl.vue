<script setup lang="ts">
import { computed, onUpdated, ref } from 'vue'
import { APPEARANCE_LAYER_DEFAULT_ANGLES } from '../editor/appearanceLayerView'

const props = withDefaults(
  defineProps<{
    modelValue: { x: number; y: number }
    zoom?: number
    disabled?: boolean
  }>(),
  { zoom: 1, disabled: false }
)
const emit = defineEmits<{
  'update:modelValue': [angles: { x: number; y: number }]
  'update:zoom': [zoom: number]
  restore: []
}>()
const zoomRange = ref<HTMLInputElement>()
const zoomMarker = ref<HTMLElement>()
const zoomReading = ref<HTMLElement>()
function normalizeZoom(value: number): number {
  return Number.isFinite(value) ? Math.max(0.35, Math.min(4, value)) : 1
}
const initialZoom = normalizeZoom(props.zoom)
let displayedZoom = initialZoom
function zoomPosition(value: number): string {
  return `${2.4 + ((value - 0.35) / 3.65) * 95.2}%`
}
function zoomPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}
/** Camera frames update only these small controls, never Vue's rendered scene. */
function paintZoom(value: number): void {
  const zoom = normalizeZoom(value)
  displayedZoom = zoom
  const position = zoomPosition(zoom)
  const reading = zoomPercent(zoom)
  if (zoomMarker.value && zoomMarker.value.style.left !== position)
    zoomMarker.value.style.left = position
  if (zoomReading.value && zoomReading.value.textContent !== reading)
    zoomReading.value.textContent = reading
  if (zoomRange.value) {
    if (Math.abs(zoomRange.value.valueAsNumber - zoom) > 0.005) zoomRange.value.value = String(zoom)
    if (zoomRange.value.getAttribute('aria-valuetext') !== reading)
      zoomRange.value.setAttribute('aria-valuetext', reading)
  }
}
function updateZoom(event: Event): void {
  if (props.disabled) return
  const value = Number((event.currentTarget as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('update:zoom', normalizeZoom(value))
}
// Native value bindings are reapplied when angle/disabled props change. Keep
// the camera's last displayed value without making camera frames reactive.
onUpdated(() => paintZoom(displayedZoom))
defineExpose({
  paintZoom,
  focusZoom: () => zoomRange.value?.focus({ preventScroll: true })
})
function angle(value: number, limit: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(Math.max(-limit, Math.min(limit, value))) : fallback
}
const angles = computed(() => ({
  x: angle(props.modelValue.x, 30, APPEARANCE_LAYER_DEFAULT_ANGLES.x),
  y: angle(props.modelValue.y, 60, APPEARANCE_LAYER_DEFAULT_ANGLES.y)
}))
function update(axis: 'x' | 'y', event: Event): void {
  if (props.disabled) return
  const value = Number((event.currentTarget as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  const next = angle(value, axis === 'x' ? 30 : 60, angles.value[axis])
  if (next !== angles.value[axis]) emit('update:modelValue', { ...angles.value, [axis]: next })
}
function degree(value: number): string {
  return `${value < 0 ? '−' : ''}${Math.abs(value)}°`
}
const ticks = Array.from({ length: 13 }, (_, index) => {
  const progress = index / 12
  return {
    position: 24 + progress * 952,
    curve: 42 - 84 * progress + 84 * progress * progress,
    length: index % 3 === 0 ? 8 : 4,
    major: index % 3 === 0
  }
})
const yawMarker = computed(() => {
  const progress = (angles.value.y + 60) / 120
  return {
    left: `${2.4 + progress * 95.2}%`,
    top: `${42 - 84 * progress + 84 * progress * progress}px`
  }
})
const pitchMarker = computed(() => {
  const progress = (30 - angles.value.x) / 60
  return {
    top: `${2.4 + progress * 95.2}%`,
    left: `${42 - 84 * progress + 84 * progress * progress}px`
  }
})
</script>

<template>
  <div
    class="appearance-view-angles"
    :class="{ 'is-disabled': disabled }"
    @click.stop
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @pointercancel.stop
    @wheel.stop
    @keydown.stop
  >
    <div class="appearance-angle-axis appearance-angle-axis--yaw">
      <svg viewBox="0 0 1000 56" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 24 42 Q 500 0 976 42" />
        <line
          v-for="(tick, index) in ticks"
          :key="index"
          :class="{ 'is-major': tick.major }"
          :x1="tick.position"
          :x2="tick.position"
          :y1="tick.curve - tick.length / 2"
          :y2="tick.curve + tick.length / 2"
        />
      </svg>
      <span class="appearance-angle-marker" :style="yawMarker" aria-hidden="true" />
      <input
        class="appearance-angle-range appearance-angle-range--yaw"
        type="range"
        min="-60"
        max="60"
        step="1"
        :value="angles.y"
        :disabled="disabled"
        aria-label="左右视角"
        aria-orientation="horizontal"
        :aria-valuetext="degree(angles.y)"
        @input="update('y', $event)"
      />
      <span class="appearance-angle-reading appearance-angle-reading--yaw" aria-hidden="true">
        <span>左右</span><span>{{ degree(angles.y) }}</span>
      </span>
    </div>
    <div class="appearance-angle-axis appearance-angle-axis--pitch">
      <svg viewBox="0 0 56 1000" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 42 24 Q 0 500 42 976" />
        <line
          v-for="(tick, index) in ticks"
          :key="index"
          :class="{ 'is-major': tick.major }"
          :y1="tick.position"
          :y2="tick.position"
          :x1="tick.curve - tick.length / 2"
          :x2="tick.curve + tick.length / 2"
        />
      </svg>
      <span class="appearance-angle-marker" :style="pitchMarker" aria-hidden="true" />
      <input
        class="appearance-angle-range appearance-angle-range--pitch"
        type="range"
        min="-30"
        max="30"
        step="1"
        :value="angles.x"
        :disabled="disabled"
        aria-label="上下视角"
        aria-orientation="vertical"
        :aria-valuetext="degree(angles.x)"
        @input="update('x', $event)"
      />
      <span class="appearance-angle-reading appearance-angle-reading--pitch" aria-hidden="true">
        <span>上下</span><span>{{ degree(angles.x) }}</span>
      </span>
    </div>
    <div class="appearance-camera-controls">
      <span aria-hidden="true">缩放</span>
      <div class="appearance-camera-scale">
        <svg viewBox="0 0 1000 32" preserveAspectRatio="none" aria-hidden="true">
          <path d="M 24 16 H 976" />
          <line
            v-for="(tick, index) in ticks"
            :key="index"
            :class="{ 'is-major': tick.major }"
            :x1="tick.position"
            :x2="tick.position"
            :y1="16 - tick.length / 2"
            :y2="16 + tick.length / 2"
          />
        </svg>
        <span
          ref="zoomMarker"
          class="appearance-angle-marker appearance-camera-marker"
          :style="{ left: zoomPosition(initialZoom) }"
          aria-hidden="true"
        />
        <input
          ref="zoomRange"
          class="appearance-angle-range appearance-camera-range"
          type="range"
          min="0.35"
          max="4"
          step="0.01"
          :value="initialZoom"
          :disabled="disabled"
          aria-label="相机缩放"
          aria-orientation="horizontal"
          :aria-valuetext="zoomPercent(initialZoom)"
          @input="updateZoom"
        />
      </div>
      <span ref="zoomReading" class="appearance-camera-reading" aria-hidden="true">
        {{ zoomPercent(initialZoom) }}
      </span>
      <button
        class="appearance-camera-restore"
        type="button"
        :disabled="disabled"
        aria-label="返回2D视图"
        @click="emit('restore')"
      >
        返回2D
      </button>
    </div>
  </div>
</template>

<style scoped>
.appearance-view-angles {
  --appearance-ruler-surface: var(
    --appearance-edit-menu,
    var(--editor-bg, var(--te-settings-backplate, #f8f9fb))
  );
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: var(--editor-text, var(--te-settings-text, var(--te-shell-control-text, #24272c)));
  font-family: var(--te-font-sans);
  font-size: var(--te-control-font-size-sm, 12px);
  font-weight: var(--te-control-font-weight, 500);
  line-height: 1.4;
}
.appearance-angle-axis {
  position: absolute;
  pointer-events: none;
}
.appearance-angle-axis--yaw {
  inset: auto 0 44px;
  height: 68px;
}
.appearance-angle-axis--pitch {
  inset: 0 auto calc(116px + var(--appearance-ruler-drop, 0px)) 0;
  width: 100px;
}
.appearance-angle-axis svg {
  position: absolute;
  inset: 0;
  display: block;
  fill: none;
  pointer-events: none;
}
.appearance-angle-axis svg,
.appearance-camera-scale svg {
  filter: drop-shadow(0 1px 0 var(--appearance-ruler-surface))
    drop-shadow(0 -1px 0 var(--appearance-ruler-surface));
}
.appearance-angle-axis--yaw svg {
  width: 100%;
  height: 56px;
}
.appearance-angle-axis--pitch svg {
  width: 56px;
  height: 100%;
}
.appearance-angle-axis path,
.appearance-angle-axis line,
.appearance-camera-scale path,
.appearance-camera-scale line {
  stroke: currentColor;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0.65;
}
.appearance-angle-axis line.is-major,
.appearance-camera-scale line.is-major {
  opacity: 0.85;
}
.appearance-angle-marker {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: var(--te-editor-ruler-marker-shadow);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.appearance-angle-range {
  position: absolute;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  appearance: none;
  accent-color: currentColor;
  pointer-events: auto;
  touch-action: none;
  cursor: ew-resize;
}
.appearance-angle-range--yaw {
  top: 0;
  left: calc(2.4% - 9px);
  width: calc(95.2% + 18px);
  height: 56px;
}
.appearance-angle-range--pitch {
  top: calc(2.4% - 9px);
  left: 0;
  width: 56px;
  height: calc(95.2% + 18px);
  writing-mode: vertical-lr;
  direction: rtl;
  cursor: ns-resize;
}
.appearance-angle-range::-webkit-slider-runnable-track {
  border: 0;
  background: transparent;
}
.appearance-angle-range::-webkit-slider-thumb {
  width: 18px;
  height: 56px;
  border: 0;
  background: transparent;
  box-shadow: none;
  appearance: none;
}
.appearance-angle-range--pitch::-webkit-slider-thumb {
  width: 56px;
  height: 18px;
}
.appearance-angle-range:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
.appearance-angle-reading {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--appearance-ruler-surface);
}
.appearance-angle-reading--yaw {
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
}
.appearance-angle-reading--pitch {
  top: 50%;
  left: 52px;
  flex-direction: column;
  gap: 2px;
  transform: translateY(-50%);
}
.appearance-camera-controls {
  position: absolute;
  inset: auto auto 0 50%;
  transform: translateX(-50%);
  width: min(360px, 100%);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 42px auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  box-sizing: border-box;
  border-radius: 16px;
  background: var(--te-editor-camera-surface);
  backdrop-filter: var(--te-editor-camera-filter);
  -webkit-backdrop-filter: var(--te-editor-camera-filter);
}
.appearance-camera-scale {
  position: relative;
  height: 32px;
}
.appearance-camera-scale svg {
  display: block;
  width: 100%;
  height: 100%;
  fill: none;
}
.appearance-camera-marker {
  top: 50%;
}
.appearance-camera-range {
  inset: 0 auto auto calc(2.4% - 9px);
  width: calc(95.2% + 18px);
  height: 32px;
}
.appearance-camera-range::-webkit-slider-thumb {
  height: 32px;
}
.appearance-camera-reading {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.appearance-camera-restore {
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--te-control-radius, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  pointer-events: auto;
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active) {
  .appearance-camera-controls {
    background: var(--appearance-ruler-surface);
    color: inherit;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
.appearance-camera-restore:hover:not(:disabled) {
  background: var(--te-hover-bg, rgb(127 127 127 / 8%));
}
.appearance-camera-restore:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.appearance-camera-restore:disabled {
  cursor: default;
}
@media (max-width: 480px) {
  .appearance-camera-controls {
    gap: 8px;
  }
}
.is-disabled {
  opacity: 0.4;
}
.appearance-angle-range:disabled {
  cursor: default;
}
@media (forced-colors: active) {
  .appearance-view-angles {
    color: CanvasText;
  }
}
</style>
