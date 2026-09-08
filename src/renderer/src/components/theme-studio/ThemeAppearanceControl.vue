<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { ThemeTokenDefinition } from '../../../../shared/theme.ts'
import ThemeColorControl from '@renderer/components/theme-studio/ThemeColorControl.vue'
import {
  gradientAngle,
  gradientColors,
  replaceGradientAngle,
  replaceGradientColor,
  studioEasingOptions,
  studioShadowOptions,
  studioTokenLabel
} from '@renderer/components/theme-studio/themeVisualControls'

const props = defineProps<{
  definition: ThemeTokenDefinition
  value: string
  source: string
  disabled: boolean
  unavailable?: boolean
  modified: boolean
  hint?: string
}>()
const emit = defineEmits<{ change: [value: string]; reset: [] }>()
const label = computed(() => studioTokenLabel(props.definition.label, props.definition.id))
const codeVisible = ref(false)
const controlId = useId()
const colors = computed(() => gradientColors(props.value))
const choices = computed(() =>
  props.definition.kind === 'shadow' ? studioShadowOptions : studioEasingOptions
)
const isGradient = computed(
  () =>
    props.definition.kind === 'gradient' &&
    props.value.startsWith('linear-gradient(') &&
    colors.value.length > 0
)
const numericValue = computed(() => Number.parseFloat(props.value))
const percent = computed(
  () => props.definition.kind === 'number' && props.definition.max === 1 && !props.definition.unit
)
function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}
function filterValue(name: string, fallback: number): number {
  const match = props.value.match(new RegExp(`${name}\\(([\\d.]+)`))
  return match ? Number(match[1]) : fallback
}
function updateFilter(name: string, unit: string, event: Event): void {
  const next = `${name}(${inputValue(event)}${unit})`
  const pattern = new RegExp(`${name}\\([^)]*\\)`)
  emit(
    'change',
    pattern.test(props.value)
      ? props.value.replace(pattern, next)
      : `${props.value === 'none' ? '' : props.value} ${next}`.trim()
  )
}
</script>

<template>
  <section class="studio-appearance-control" :data-studio-setting="definition.id" tabindex="-1">
    <div class="studio-appearance-heading">
      <strong>{{ label }}</strong>
      <span v-if="modified" class="token-source">已修改</span>
      <button
        type="button"
        class="studio-icon-button studio-code-button"
        :title="'编辑' + label + '的 CSS 值'"
        :aria-label="'编辑' + label + '的 CSS 值'"
        :aria-expanded="codeVisible"
        :aria-controls="controlId"
        :disabled="disabled || unavailable"
        @click="codeVisible = !codeVisible"
      >
        <i class="ph ph-code" aria-hidden="true"></i>
      </button>
      <button
        type="button"
        class="studio-icon-button"
        :disabled="disabled || !modified"
        :title="'恢复' + label"
        :aria-label="'恢复' + label"
        @click="emit('reset')"
      >
        <i class="ph ph-arrow-u-up-left"></i>
      </button>
    </div>
    <p v-if="hint" class="studio-control-hint">{{ hint }}</p>
    <div v-if="definition.min != null && definition.max != null" class="studio-value-slider">
      <input
        :aria-label="label"
        type="range"
        :min="definition.min"
        :max="definition.max"
        :step="definition.step ?? 1"
        :value="numericValue"
        :disabled="disabled || unavailable"
        @input="emit('change', inputValue($event) + (definition.unit ?? ''))"
      />
      <output>{{ percent ? Math.round(numericValue * 100) + '%' : value }}</output>
    </div>
    <ThemeColorControl
      class="studio-single-color"
      v-else-if="definition.kind === 'color'"
      :value="value"
      :label="label"
      :disabled="disabled || unavailable"
      @change="emit('change', $event)"
    />
    <template v-else-if="isGradient">
      <div class="studio-fill-preview" :style="{ background: value }" aria-hidden="true"></div>
      <ThemeColorControl
        v-for="(color, index) in colors"
        :key="index"
        :value="color"
        :label="
          colors.length === 2 ? (index === 0 ? '起始颜色' : '结束颜色') : '颜色 ' + (index + 1)
        "
        :disabled="disabled || unavailable"
        @change="emit('change', replaceGradientColor(value, index, $event))"
      />
      <label class="studio-value-slider"
        ><span>方向</span
        ><input
          type="range"
          min="0"
          max="360"
          :value="gradientAngle(value)"
          :disabled="disabled || unavailable"
          :aria-label="label + '渐变方向'"
          @input="emit('change', replaceGradientAngle(value, Number(inputValue($event))))"
        /><output>{{ gradientAngle(value) }}°</output></label
      >
    </template>
    <template v-else-if="definition.kind === 'shadow' || definition.kind === 'easing'">
      <div v-if="definition.kind === 'shadow'" class="studio-shadow-preview" aria-hidden="true">
        <span :style="{ boxShadow: value }">Aa</span>
      </div>
      <div class="studio-choice-grid" :aria-label="label">
        <button
          v-for="choice in choices"
          :key="choice.value"
          type="button"
          :aria-pressed="value === choice.value"
          :disabled="disabled || unavailable"
          @click="emit('change', choice.value)"
        >
          {{ choice.label }}
        </button>
      </div>
      <small v-if="!choices.some((choice) => choice.value === value)" class="studio-control-hint">{{
        source === '已自定义' ? '自定义效果' : '主题原有效果'
      }}</small>
    </template>
    <template v-else-if="definition.kind === 'filter'">
      <label
        v-for="filter in [
          { name: 'blur', label: '模糊', max: 100, step: 1, fallback: 0, unit: 'px' },
          { name: 'saturate', label: '鲜艳度', max: 2, step: 0.01, fallback: 1, unit: '' },
          { name: 'brightness', label: '亮度', max: 2, step: 0.01, fallback: 1, unit: '' }
        ]"
        :key="filter.name"
        class="studio-value-slider"
        ><span>{{ filter.label }}</span
        ><input
          type="range"
          min="0"
          :max="filter.max"
          :step="filter.step"
          :value="filterValue(filter.name, filter.fallback)"
          :disabled="disabled || unavailable"
          :aria-label="label + filter.label"
          @input="updateFilter(filter.name, filter.unit, $event)"
        /><output>{{
          filter.unit
            ? filterValue(filter.name, filter.fallback) + filter.unit
            : Math.round(filterValue(filter.name, filter.fallback) * 100) + '%'
        }}</output></label
      >
    </template>
    <select
      v-else-if="definition.options"
      :aria-label="label"
      :value="value"
      :disabled="disabled || unavailable"
      @change="emit('change', inputValue($event))"
    >
      <option v-for="option in definition.options" :key="option" :value="option">
        {{ option }}
      </option>
    </select>
    <div v-if="codeVisible" :id="controlId" class="studio-style-details">
      <label
        ><span>{{ label }} · CSS</span
        ><input
          type="text"
          :value="value"
          :disabled="disabled || unavailable"
          spellcheck="false"
          :aria-label="label + '样式值'"
          @change="emit('change', inputValue($event))"
      /></label>
    </div>
  </section>
</template>
