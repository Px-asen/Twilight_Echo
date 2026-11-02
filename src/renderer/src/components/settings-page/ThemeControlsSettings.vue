<script setup lang="ts">
import SettingsGroup from './SettingsGroup.vue'
import ExperienceSettings from './ExperienceSettings.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { accentColorOptions, colorModeOptions, motionPreferenceOptions } from './types.ts'
import type { AppTheme, MotionPreference } from '../../types/settings'
const props = defineProps<{ integrated?: boolean; colorMode?: AppTheme; paletteOnly?: boolean }>()

const emit = defineEmits<{
  'update:colorMode': [value: AppTheme]
}>()

const { settings, updateSettings, lastSettingsError } = useSettingsStore()
function setTheme(theme: AppTheme): void {
  if ((props.colorMode ?? settings.value.theme) === theme) return
  if (props.colorMode !== undefined) emit('update:colorMode', theme)
  else void updateSettings({ theme }).catch(() => undefined)
}

function setMotionPreference(event: Event): void {
  const motionPreference = (event.target as HTMLSelectElement).value as MotionPreference
  void updateSettings({ motionPreference }).catch(() => undefined)
}

function setAccentColor(mode: 'light' | 'dark', color: string): void {
  if (mode === 'light') {
    if (settings.value.lightAccentColor === color) return
    void updateSettings({ accentColor: color, lightAccentColor: color }).catch(() => undefined)
    return
  }
  if (settings.value.darkAccentColor === color) return
  void updateSettings({ darkAccentColor: color }).catch(() => undefined)
}
</script>

<template>
  <p v-if="!integrated && lastSettingsError" role="alert">{{ lastSettingsError }}</p>
  <div data-setting-id="color-mode" id="setting-color-mode" class="setting-item">
    <div class="setting-copy">
      <strong>深浅色</strong>
    </div>
    <div class="theme-segment" role="group" aria-label="配色模式">
      <button
        v-for="option in colorModeOptions"
        :key="option.value"
        type="button"
        :class="{ active: (colorMode ?? settings.theme) === option.value }"
        :aria-pressed="(colorMode ?? settings.theme) === option.value"
        @click="setTheme(option.value)"
      >
        <i :class="option.icon"></i>
        {{ option.label }}
      </button>
    </div>
  </div>
  <hr />
  <ExperienceSettings v-if="!paletteOnly" />
  <hr v-if="!paletteOnly" />
  <div v-if="!paletteOnly" data-setting-id="motion" id="setting-motion" class="setting-item">
    <div class="setting-copy">
      <strong>界面动画</strong>
    </div>
    <select
      class="preview-select wide"
      :value="settings.motionPreference"
      @change="setMotionPreference"
    >
      <option v-for="option in motionPreferenceOptions" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </div>
  <SettingsGroup
    id="theme-customization"
    :title="integrated ? '强调色' : '自定义主题与配色'"
    :description="
      integrated
        ? '分别设置当前窗口的浅色和深色强调色。'
        : '需要独立设置深浅色配色、创建或编辑主题时展开。'
    "
    :summary="
      '浅色：' +
      (accentColorOptions.find((option) => option.value === settings.lightAccentColor)?.label ??
        settings.lightAccentColor) +
      ' · 深色：' +
      (accentColorOptions.find((option) => option.value === settings.darkAccentColor)?.label ??
        settings.darkAccentColor)
    "
  >
    <div data-setting-id="accent-light" id="setting-accent-light" class="setting-item">
      <div class="setting-copy">
        <strong>浅色强调色</strong>
        <span>浅色模式下设置、本地主页和主要控件使用的主题色。</span>
      </div>
      <div class="swatch-row">
        <span
          v-for="option in accentColorOptions"
          :key="option.value"
          class="swatch"
          data-te-interactive
          role="button"
          tabindex="0"
          :aria-label="option.label"
          :aria-pressed="settings.lightAccentColor === option.value"
          :class="[option.class, { active: settings.lightAccentColor === option.value }]"
          :title="option.label"
          @click="setAccentColor('light', option.value)"
          @keydown.enter.prevent="setAccentColor('light', option.value)"
          @keydown.space.prevent="setAccentColor('light', option.value)"
        >
          <i v-if="settings.lightAccentColor === option.value" class="pi pi-check"></i>
        </span>
      </div>
    </div>
    <hr />
    <div data-setting-id="accent-dark" id="setting-accent-dark" class="setting-item">
      <div class="setting-copy">
        <strong>深色强调色</strong>
        <span>深色模式下复用同一组选项，可与浅色模式独立保存。</span>
      </div>
      <div class="swatch-row">
        <span
          v-for="option in accentColorOptions"
          :key="option.value"
          class="swatch"
          data-te-interactive
          role="button"
          tabindex="0"
          :aria-label="option.label"
          :aria-pressed="settings.darkAccentColor === option.value"
          :class="[option.class, { active: settings.darkAccentColor === option.value }]"
          :title="option.label"
          @click="setAccentColor('dark', option.value)"
          @keydown.enter.prevent="setAccentColor('dark', option.value)"
          @keydown.space.prevent="setAccentColor('dark', option.value)"
        >
          <i v-if="settings.darkAccentColor === option.value" class="pi pi-check"></i>
        </span>
      </div>
    </div>
  </SettingsGroup>
</template>

<style scoped></style>
