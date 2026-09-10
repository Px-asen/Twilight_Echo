<script setup lang="ts">
import { onMounted } from 'vue'
import { useLyricsFontPicker } from '@renderer/composables/useLyricsFontPicker'
import MiniPlayerSettingsSection from './MiniPlayerSettingsSection.vue'
import ThemeControlsSettings from './ThemeControlsSettings.vue'
import BackgroundEditorSettings from './BackgroundEditorSettings.vue'
import LyricsStyleSettings from './LyricsStyleSettings.vue'
import PlayerBarSettings from './PlayerBarSettings.vue'
import PlayerBarLayoutSettings from './PlayerBarLayoutSettings.vue'
import LiquidGlassSettings from './LiquidGlassSettings.vue'
import CardAppearanceSettings from './CardAppearanceSettings.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { fontFamilyOptions, uiDensityOptions, type BooleanSettingKey } from './types.ts'
import { normalizeAppFontFamily } from '../../../../shared/appFont.ts'
import type { AppSettings, UiDensity } from '../../types/settings'

const emit = defineEmits<{
  openThemeStudio: []
}>()

const { settings, updateSettings } = useSettingsStore()
const { installed, load: loadFonts } = useLyricsFontPicker()
onMounted(loadFonts)

function setFontFamily(event: Event): void {
  const fontFamily = normalizeAppFontFamily((event.target as HTMLSelectElement).value)
  if (settings.value.fontFamily === fontFamily) return
  void updateSettings({ fontFamily })
}

function setUiDensity(density: UiDensity): void {
  if (settings.value.uiDensity === density) return
  void updateSettings({ uiDensity: density })
}

function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>)
}
</script>

<template>
  <section id="appearance" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-palette"></i>
      <h2>外观 (Appearance)</h2>
    </div>

    <div class="setting-list">
      <ThemeControlsSettings @open-theme-studio="emit('openThemeStudio')" />
      <BackgroundEditorSettings />
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>封面主题色</strong>
          <span>播放页和底栏使用当前专辑封面提取的主题色。</span>
        </div>
        <span
          class="toggle-switch"
          :class="{ active: settings.useCoverTheme, inactive: !settings.useCoverTheme }"
          role="switch"
          :aria-checked="settings.useCoverTheme"
          @click="toggleSetting('useCoverTheme')"
        ></span>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>全局字体 (Typography)</strong>
          <span>更换界面的正文、标题与圆体字体；“默认”跟随当前主题自带的字体。</span>
        </div>
        <select class="preview-select wide" :value="settings.fontFamily" @change="setFontFamily">
          <option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
          <optgroup label="系统已安装字体">
            <option v-for="family in installed" :key="family" :value="`local:${family}`">
              {{ family }}
            </option>
          </optgroup>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>界面排版密度 (UI Density)</strong>
          <span>控制列表项的间距与信息密度。</span>
        </div>
        <div class="segmented-control density">
          <button
            v-for="option in uiDensityOptions"
            :key="option.value"
            type="button"
            :class="{ active: settings.uiDensity === option.value }"
            @click="setUiDensity(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <hr />
      <LyricsStyleSettings />
      <hr />
      <MiniPlayerSettingsSection />
      <hr />
      <PlayerBarSettings />
      <hr />
      <PlayerBarLayoutSettings />
      <hr />
      <LiquidGlassSettings />
      <hr />
      <CardAppearanceSettings />
    </div>
  </section>
</template>
