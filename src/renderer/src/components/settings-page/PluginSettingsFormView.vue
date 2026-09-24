<script setup lang="ts">
import { computed } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import type { PluginSettingsField, PluginSettingsForm } from './types'
import { groupPluginSettingsFields } from './pluginSettingsForm.ts'

const props = defineProps<{
  form: PluginSettingsForm
  values: Record<string, string>
  /** Unique per panel; keeps generated element ids distinct across plugins. */
  idPrefix: string
  /** Another settings command is running, so blocking actions are disabled. */
  busy: boolean
  /** This panel's own blocking command is running. */
  pending: boolean
}>()

const emit = defineEmits<{
  update: [key: string, value: string]
  submit: []
  reset: []
}>()

const groups = computed(() => groupPluginSettingsFields(props.form.fields))
const safePrefix = computed(() => props.idPrefix.replace(/[^A-Za-z0-9_-]/g, '-'))

function fieldId(field: PluginSettingsField): string {
  return `${safePrefix.value}-${field.key.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function valueOf(field: PluginSettingsField): string {
  return props.values[field.key] ?? field.value
}

function numberOf(field: PluginSettingsField): number {
  const value = Number(valueOf(field))
  return Number.isFinite(value) ? Math.min(field.max, Math.max(field.min, value)) : field.min
}

function isOn(field: PluginSettingsField): boolean {
  return valueOf(field) === 'true'
}

function update(field: PluginSettingsField, value: string): void {
  emit('update', field.key, value)
}

function toggle(field: PluginSettingsField): void {
  update(field, isOn(field) ? 'false' : 'true')
}
</script>

<template>
  <div class="plugin-settings-form">
    <p v-if="form.notice" class="plugin-settings-notice">{{ form.notice }}</p>
    <section
      v-for="(group, groupIndex) in groups"
      :key="`${groupIndex}:${group.title}`"
      class="plugin-settings-group"
    >
      <h4 v-if="group.title" class="plugin-settings-group-title">{{ group.title }}</h4>
      <div v-for="field in group.fields" :key="field.key" class="plugin-settings-field">
        <div class="plugin-settings-label">
          <label :id="`${fieldId(field)}-label`" :for="fieldId(field)">
            {{ field.label }}<b v-if="field.required"> *</b>
          </label>
          <small v-if="field.description">{{ field.description }}</small>
        </div>

        <span
          v-if="field.type === 'toggle'"
          :id="fieldId(field)"
          class="toggle-switch plugin-settings-toggle"
          :class="{ active: isOn(field), inactive: !isOn(field) }"
          role="switch"
          tabindex="0"
          :aria-checked="isOn(field)"
          :aria-labelledby="`${fieldId(field)}-label`"
          @click="toggle(field)"
          @keydown.enter.prevent="toggle(field)"
          @keydown.space.prevent="toggle(field)"
        ></span>

        <div v-else-if="field.type === 'range'" class="range-pill plugin-settings-range">
          <input
            :id="fieldId(field)"
            class="range-input"
            type="range"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            :value="numberOf(field)"
            @input="update(field, ($event.target as HTMLInputElement).value)"
          />
          <EditableRangeValue
            :value="numberOf(field)"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            :suffix="field.unit"
            :aria-label="`编辑${field.label}`"
            @change="update(field, String($event))"
          />
        </div>

        <div v-else-if="field.type === 'color'" class="plugin-settings-color">
          <input
            :id="fieldId(field)"
            type="color"
            class="color-picker"
            :value="valueOf(field)"
            @input="update(field, ($event.target as HTMLInputElement).value)"
          />
          <code>{{ valueOf(field) }}</code>
        </div>

        <select
          v-else-if="field.type === 'select'"
          :id="fieldId(field)"
          class="preview-select"
          :value="valueOf(field)"
          @change="update(field, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in field.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <input
          v-else
          :id="fieldId(field)"
          class="preview-select"
          :type="field.type"
          :required="field.required"
          :placeholder="field.placeholder"
          :autocomplete="field.type === 'password' ? 'new-password' : 'off'"
          :value="valueOf(field)"
          @input="update(field, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </section>

    <div class="plugin-settings-actions">
      <small v-if="form.live" class="plugin-settings-live-hint">修改后会自动保存并立即生效</small>
      <button
        v-if="form.resetCommand"
        type="button"
        class="soft-button"
        :disabled="busy"
        @click="emit('reset')"
      >
        {{ pending ? '处理中…' : '恢复默认' }}
      </button>
      <button
        v-if="!form.live"
        type="button"
        class="soft-button plugin-settings-submit"
        :disabled="busy"
        @click="emit('submit')"
      >
        {{ pending ? '保存中…' : '保存设置' }}
      </button>
    </div>
  </div>
</template>

<style>
.plugin-settings-form {
  display: grid;
  gap: 12px;
  margin: 0 0 14px;
  padding: 16px;
  border: 1px solid var(--te-settings-border);
  border-radius: 12px;
  background: var(--te-settings-card-bg);
}

.plugin-settings-notice {
  margin: 0;
  color: var(--te-settings-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  line-height: 1.6;
}

.plugin-settings-group {
  display: grid;
  gap: 12px;
}

.plugin-settings-group + .plugin-settings-group {
  padding-top: 14px;
  border-top: 1px solid var(--te-settings-border);
}

.plugin-settings-group-title {
  margin: 0;
  color: var(--te-settings-text);
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 700;
}

.plugin-settings-field {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(220px, 1fr);
  align-items: center;
  gap: 16px;
}

.plugin-settings-label {
  display: grid;
  gap: 2px;
}

.plugin-settings-label > label {
  color: var(--te-settings-text);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
}

.plugin-settings-label > small {
  color: var(--te-settings-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 11.5 / 14);
  line-height: 1.45;
}

.plugin-settings-label b {
  color: var(--te-danger, #ef4444);
}

.plugin-settings-field .preview-select {
  width: 100%;
  max-width: none;
}

.plugin-settings-toggle {
  justify-self: start;
}

.plugin-settings-toggle:focus-visible {
  outline: 2px solid var(--brand-500);
  outline-offset: 2px;
}

.plugin-settings-range {
  justify-self: stretch;
}

.plugin-settings-range .range-input {
  flex: 1;
  min-width: 0;
}

.plugin-settings-color {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.plugin-settings-color code {
  color: var(--te-settings-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}

.plugin-settings-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.plugin-settings-live-hint {
  margin-right: auto;
  color: var(--te-settings-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}

@media (max-width: 760px) {
  .plugin-settings-field {
    grid-template-columns: 1fr;
    gap: 7px;
  }
}
</style>
