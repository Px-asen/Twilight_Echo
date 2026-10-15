<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  workshopCanvasPoint,
  workshopLayerDrag,
  type WorkshopCanvasBox
} from '@renderer/components/theme-workshop/workshopCanvas'
import type { WorkshopProject } from '../../../../shared/themeWorkshop.ts'
import type { WorkshopLayer, WorkshopSurface } from '../../../../shared/themeWorkshopLayers.ts'
const props = defineProps<{
  boxes: WorkshopCanvasBox[]
  project: WorkshopProject
  tone: 'dark' | 'pureWhite'
  width: number
  height: number
  selected: string
  enabled: boolean
}>()
const emit = defineEmits<{
  select: [id: string, surface: WorkshopSurface]
  region: [x: number, y: number]
  edit: [id: string, surface: WorkshopSurface, patch: Partial<WorkshopLayer>]
  gesture: [action: 'begin' | 'end' | 'cancel']
}>()
const root = ref<HTMLElement>()
let drag:
  | {
      pointer: number
      box: WorkshopCanvasBox
      layer: WorkshopLayer
      x: number
      y: number
      resize: boolean
    }
  | undefined
const active = computed(() => props.boxes.find((box) => box.id === props.selected))
function start(event: PointerEvent, box?: WorkshopCanvasBox, resize = false): void {
  if (!root.value || drag || event.button !== 0 || !event.isPrimary) return
  const point = workshopCanvasPoint(event, root.value.getBoundingClientRect(), props.width)
  if (!box) {
    box = props.boxes
      .toReversed()
      .find(
        (item) =>
          point.x >= item.left &&
          point.x <= item.left + item.width &&
          point.y >= item.top &&
          point.y <= item.top + item.height
      )
    if (!box) {
      emit('region', point.x, point.y)
      return
    }
  }
  const layer = props.project.layers?.[props.tone]?.[box.surface]?.find(
    (item) => item.id === box!.id
  )
  if (!layer) return
  event.preventDefault()
  root.value.focus()
  root.value.setPointerCapture(event.pointerId)
  drag = {
    pointer: event.pointerId,
    box: { ...box },
    layer: { ...layer },
    x: point.x,
    y: point.y,
    resize
  }
  emit('select', box.id, box.surface)
  emit('gesture', 'begin')
}
function move(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointer || !root.value) return
  const point = workshopCanvasPoint(event, root.value.getBoundingClientRect(), props.width)
  const dx = point.x - drag.x,
    dy = point.y - drag.y
  if (Math.abs(dx) + Math.abs(dy) < 0.5) return
  emit(
    'edit',
    drag.box.id,
    drag.box.surface,
    workshopLayerDrag(drag.layer, drag.box, dx, dy, drag.resize)
  )
}
function end(cancel = false): void {
  if (!drag) return
  const pointer = drag.pointer
  drag = undefined
  if (root.value?.hasPointerCapture(pointer)) root.value.releasePointerCapture(pointer)
  emit('gesture', cancel ? 'cancel' : 'end')
}
watch([() => props.enabled, () => props.tone, () => props.project.id], () => end(true))
onBeforeUnmount(() => end(true))
defineExpose({ cancelGesture: () => end(true) })
</script>
<template>
  <div
    v-if="enabled"
    ref="root"
    class="workshop-canvas-overlay"
    :style="{ width: width + 'px', height: height + 'px' }"
    tabindex="0"
    aria-label="点选主题区域，拖动图层，Esc 取消拖拽"
    @pointerdown.stop="start($event)"
    @pointermove.stop="move"
    @pointerup.stop="end()"
    @pointercancel.stop="end(true)"
    @lostpointercapture.stop="end(true)"
    @keydown.esc.prevent.stop="end(true)"
  >
    <div
      v-if="active"
      class="workshop-layer-selection"
      :style="{
        left: active.left + 'px',
        top: active.top + 'px',
        width: active.width + 'px',
        height: active.height + 'px'
      }"
    >
      <span>{{ active.name }}</span
      ><button
        class="workshop-resize-handle"
        aria-label="缩放选中图层"
        @pointerdown.stop="start($event, active, true)"
      />
    </div>
  </div>
</template>
<style scoped>
.workshop-canvas-overlay {
  --workshop-selection-color: var(
    --appearance-selection-color,
    var(--appearance-edit-focus, #087f79)
  );
  position: absolute;
  inset: 0;
  z-index: 10;
  touch-action: none;
  outline: none;
  cursor: crosshair;
}
.workshop-canvas-overlay:focus-visible {
  outline: 2px solid var(--appearance-focus-color, var(--workshop-selection-color));
  outline-offset: -2px;
}
.workshop-layer-selection {
  position: absolute;
  border: 2px solid var(--workshop-selection-color);
  pointer-events: none;
  box-sizing: border-box;
}
.workshop-layer-selection > span {
  position: absolute;
  top: -24px;
  left: -2px;
  padding: 2px 8px;
  background: var(--appearance-edit-primary, var(--workshop-selection-color));
  color: var(--appearance-edit-on-primary, white);
  font: 12px/1.5 system-ui;
  white-space: nowrap;
}
.workshop-resize-handle {
  position: absolute;
  right: -7px;
  bottom: -7px;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 2px solid white;
  background: var(--workshop-selection-color);
  pointer-events: auto;
  cursor: nwse-resize;
}
</style>
