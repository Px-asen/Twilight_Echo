<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    value: number
    min: number
    max: number
    step?: number
    suffix?: string
    ariaLabel?: string
    disabled?: boolean
  }>(),
  {
    step: 1,
    suffix: '',
    ariaLabel: '编辑数值',
    disabled: false
  }
)

const emit = defineEmits<{
  change: [value: number]
}>()

const editing = ref(false)
const draft = ref('')

const precision = computed(() => {
  const text = String(props.step)
  const decimalIndex = text.indexOf('.')
  return decimalIndex === -1 ? 0 : text.length - decimalIndex - 1
})

function formatValue(value: number): string {
  return precision.value > 0 ? value.toFixed(precision.value) : String(value)
}

function normalizeValue(value: number): number {
  const clamped = Math.min(props.max, Math.max(props.min, value))
  const stepped = props.min + Math.round((clamped - props.min) / props.step) * props.step
  return Number(Math.min(props.max, Math.max(props.min, stepped)).toFixed(precision.value))
}

function syncDraft(): void {
  draft.value = formatValue(props.value)
}

function startEditing(event: FocusEvent): void {
  editing.value = true
  const input = event.currentTarget as HTMLInputElement
  input.select()
}

function commit(): void {
  if (!editing.value) return
  editing.value = false

  const rawValue = draft.value.trim()
  if (!rawValue) {
    syncDraft()
    return
  }

  const nextValue = Number(rawValue)
  if (!Number.isFinite(nextValue)) {
    syncDraft()
    return
  }

  const normalized = normalizeValue(nextValue)
  draft.value = formatValue(normalized)
  if (normalized !== props.value) emit('change', normalized)
}

function cancel(): void {
  editing.value = false
  syncDraft()
}

function submit(event: KeyboardEvent): void {
  commit()
  ;(event.currentTarget as HTMLInputElement).blur()
}

watch(
  () => props.value,
  () => {
    if (!editing.value) syncDraft()
  },
  { immediate: true }
)
</script>

<template>
  <span class="editable-range-value" :class="{ disabled }">
    <input
      type="number"
      :value="draft"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @focus="startEditing"
      @input="draft = ($event.target as HTMLInputElement).value"
      @blur="commit"
      @keydown.enter.prevent="submit"
      @keydown.esc.prevent="cancel"
    />
    <span v-if="suffix" aria-hidden="true">{{ suffix }}</span>
  </span>
</template>

<style scoped>
.editable-range-value {
  display: inline-flex;
  min-width: 52px;
  height: 28px;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--te-neutral-700);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 650;
  line-height: 1;
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease,
    box-shadow 0.16s ease;
}

.editable-range-value:focus-within {
  border-color: var(--brand-300);
  background: var(--te-card-bg);
  box-shadow: 0 0 0 3px rgba(var(--te-primary-rgb), 0.14);
}

.editable-range-value.disabled {
  opacity: 0.55;
}

.editable-range-value input {
  width: 48px;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: right;
}

.editable-range-value input::-webkit-inner-spin-button,
.editable-range-value input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}
</style>
