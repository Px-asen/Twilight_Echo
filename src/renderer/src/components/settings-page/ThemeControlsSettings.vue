<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useThemeStore } from '../../stores/useThemeStore'
import { useExtensionRegistry } from '../../extensions/registry'
import { getPluginThemeKey } from '../../extensions/themeSelection'
import { accentColorOptions, colorModeOptions, motionPreferenceOptions } from './types.ts'
import type { AppTheme, MotionPreference } from '../../types/settings'

const emit = defineEmits<{
  openThemeStudio: []
  openThemeWorkshop: []
}>()

const { settings, updateSettings } = useSettingsStore()
const themeStore = useThemeStore()
const { themeContributions, uiContributions } = useExtensionRegistry()

const workshopEnabled = computed(() =>
  uiContributions.value.some(
    (entry) =>
      entry.pluginId === 'com.twilightecho.tool.theme-workshop' && entry.id === 'theme-workshop'
  )
)

const pluginThemeOptions = computed(() =>
  themeContributions.value.map((theme) => ({
    value: getPluginThemeKey(theme),
    label: theme.name
  }))
)
const selectedPluginThemeKey = computed(() => {
  const selection = themeStore.activeTheme.value
  return selection.kind === 'plugin' ? `${selection.pluginId}:${selection.themeId}` : ''
})

function setTheme(theme: AppTheme): void {
  if (settings.value.theme === theme) return
  void updateSettings({ theme })
}

function setMotionPreference(event: Event): void {
  const motionPreference = (event.target as HTMLSelectElement).value as MotionPreference
  void updateSettings({ motionPreference })
}

function setAccentColor(mode: 'light' | 'dark', color: string): void {
  if (mode === 'light') {
    if (settings.value.lightAccentColor === color) return
    void updateSettings({ accentColor: color, lightAccentColor: color })
    return
  }
  if (settings.value.darkAccentColor === color) return
  void updateSettings({ darkAccentColor: color })
}

async function setPluginTheme(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  if (!value) {
    await themeStore.setActive({ kind: 'builtin', id: 'builtin:twilight-echo-default' })
    return
  }
  const contribution = themeContributions.value.find((theme) => getPluginThemeKey(theme) === value)
  if (!contribution) return
  await themeStore.setActive({
    kind: 'plugin',
    pluginId: contribution.pluginId,
    themeId: contribution.id
  })
}
</script>

<template>
  <div class="setting-item">
    <div class="setting-copy">
      <strong>主题创意工坊</strong>
    </div>
    <button type="button" class="primary-button" @click="emit('openThemeStudio')">
      <i class="ph ph-swatches"></i>
      打开主题创意工坊
    </button>
  </div>
  <div class="setting-item">
    <div class="setting-copy">
      <strong>主题插件工坊</strong
      ><span>{{
        workshopEnabled
          ? '定制已加载的主题插件，管理素材并导出个人主题。'
          : '在插件管理中启用「主题插件工坊」后使用。'
      }}</span>
    </div>
    <button
      type="button"
      class="primary-button"
      :disabled="!workshopEnabled"
      @click="emit('openThemeWorkshop')"
    >
      <i class="ph ph-paint-brush"></i>打开主题插件工坊
    </button>
  </div>
  <hr />
  <div class="setting-item">
    <div class="setting-copy">
      <strong>深浅色</strong>
    </div>
    <div class="theme-segment">
      <button
        v-for="option in colorModeOptions"
        :key="option.value"
        type="button"
        :class="{ active: settings.theme === option.value }"
        @click="setTheme(option.value)"
      >
        <i :class="option.icon"></i>
        {{ option.label }}
      </button>
    </div>
  </div>
  <hr />
  <div class="setting-item">
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
  <hr />
  <div class="setting-item">
    <div class="setting-copy">
      <strong>插件主题</strong>
    </div>
    <select
      class="preview-select wide"
      :value="selectedPluginThemeKey"
      :disabled="pluginThemeOptions.length === 0"
      @change="setPluginTheme"
    >
      <option value="">不使用插件主题</option>
      <option v-for="option in pluginThemeOptions" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </div>
  <hr />
  <div class="setting-item">
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
  <div class="setting-item">
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
</template>
