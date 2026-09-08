<script setup lang="ts">
import { computed } from 'vue'
import {
  parseStudioColor,
  studioColorValue
} from '@renderer/components/theme-studio/themeVisualControls'

const props = defineProps<{ value: string; label: string; disabled?: boolean }>()
const emit = defineEmits<{ change: [value: string] }>()
const color = computed(() => parseStudioColor(props.value))
function update(key: 'hex' | 'opacity', event: Event): void {
  if (!color.value) return
  const value = (event.target as HTMLInputElement).value
  emit(
    'change',
    studioColorValue({ ...color.value, [key]: key === 'opacity' ? Number(value) : value })
  )
}
</script>

<template>
  <div v-if="color" class="studio-color-control">
    <label class="studio-color-swatch">
      <input
        type="color"
        :value="color.hex"
        :disabled="disabled"
        :aria-label="label.endsWith('颜色') ? label : label + '颜色'"
        @input="update('hex', $event)"
      />
      <span>{{ label }}</span>
    </label>
    <label class="studio-opacity-control">
      <span>不透明度</span>
      <input
        type="range"
        min="0"
        max="100"
        :value="color.opacity"
        :disabled="disabled"
        :aria-label="label + '不透明度'"
        @input="update('opacity', $event)"
      />
      <output>{{ color.opacity }}%</output>
    </label>
  </div>
  <span v-else class="studio-control-hint">自定义颜色</span>
</template>
