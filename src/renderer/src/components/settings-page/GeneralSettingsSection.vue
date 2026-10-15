<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import { APP_LOCALES, normalizeLanguagePreference } from '../../../../shared/i18n/locale.ts'
import { useLocale } from '../../app/useLocale.ts'
import type { AppTheme, StartupHomePage } from '../../types/settings'
import { colorModeOptions, type BooleanSettingKey } from './types.ts'
const { settings, saving, lastSettingsError, updateSettings: persistSettings } = useSettingsStore()
const { t } = useLocale()
function setLanguage(event: Event): void {
  const value = normalizeLanguagePreference((event.target as HTMLSelectElement).value)
  void persistSettings({ language: value })
}

async function setColorMode(theme: AppTheme): Promise<void> {
  if (settings.value.theme === theme || saving.value) return
  try {
    await persistSettings({ theme })
  } catch {
    // The shared store restores the confirmed preference and exposes its error.
  }
}

const emit = defineEmits<{ reopenOnboarding: [] }>()
defineProps<{
  startupHomePageOptions: readonly { value: StartupHomePage; label: string; icon: string }[]
  toggleSetting: (key: BooleanSettingKey) => void
  setStartupHomePage: (page: StartupHomePage) => void
  setCloseBehavior: (event: Event) => void
}>()
</script>
<template>
  <section id="general" class="settings-section preview-section">
    <div class="section-title-row">
      <i class="pi pi-sliders-h" aria-hidden="true" />
      <h2>通用</h2>
    </div>
    <div class="section-block">
      <h3>显示</h3>
      <div class="setting-list">
        <div data-setting-id="color-mode" id="setting-color-mode" class="setting-item">
          <div class="setting-copy">
            <strong>配色模式</strong>
            <span>选择跟随系统，或固定使用深色、浅色模式。</span>
          </div>
          <div class="segmented-control" role="group" aria-label="配色模式" :aria-busy="saving">
            <button
              v-for="option in colorModeOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.theme === option.value }"
              :aria-pressed="settings.theme === option.value"
              :aria-disabled="saving"
              @click="setColorMode(option.value)"
            >
              <i :class="option.icon" aria-hidden="true" />
              {{ option.label }}
            </button>
          </div>
        </div>
        <p v-if="lastSettingsError" class="setting-hint" role="alert">{{ lastSettingsError }}</p>
      </div>
    </div>
    <div class="section-block">
      <h3>启动与窗口</h3>
      <div class="setting-list">
        <div data-setting-id="startup-home" id="setting-startup-home" class="setting-item">
          <div class="setting-copy">
            <strong>启动后进入</strong>
            <span>未保存上次页面时使用此主页；重新打开应用会自动回到关闭前的页面。</span>
          </div>
          <div class="segmented-control" role="group" aria-label="启动后进入">
            <button
              v-for="option in startupHomePageOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.startupHomePage === option.value }"
              :aria-pressed="settings.startupHomePage === option.value"
              @click="setStartupHomePage(option.value)"
            >
              <i :class="option.icon"></i>
              {{ option.label }}
            </button>
          </div>
        </div>
        <hr />
        <div data-setting-id="launch-at-login" id="setting-launch-at-login" class="setting-item">
          <div class="setting-copy">
            <strong>开机自动启动</strong>
            <span>在系统启动时自动在后台运行。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{ active: settings.launchAtLogin, inactive: !settings.launchAtLogin }"
            role="switch"
            aria-label="开机启动"
            :aria-checked="settings.launchAtLogin"
            @click="toggleSetting('launchAtLogin')"
          ></button>
        </div>
        <hr />
        <div data-setting-id="language" id="setting-language" class="setting-item">
          <div class="setting-copy">
            <strong>{{ t('settings.language.title') }}</strong>
            <span>{{ t('settings.language.description') }}</span>
          </div>
          <select
            class="preview-select"
            :aria-label="t('settings.language.title')"
            :value="settings.language"
            @change="setLanguage"
          >
            <option value="system">{{ t('settings.language.system') }}</option>
            <option v-for="option in APP_LOCALES" :key="option" :value="option">
              {{ t(`settings.language.${option}`) }}
            </option>
          </select>
        </div>
        <hr />
        <div data-setting-id="close-window" id="setting-close-window" class="setting-item">
          <div class="setting-copy">
            <strong>关闭主窗口时</strong>
            <span>选择点击关闭按钮后的应用行为。</span>
          </div>
          <select
            class="preview-select"
            aria-label="关闭主窗口时"
            :value="settings.closeWindowBehavior"
            @change="setCloseBehavior"
          >
            <option value="tray">最小化到系统托盘</option>
            <option value="miniPlayer">切换为迷你播放器</option>
            <option value="quit">退出应用</option>
          </select>
        </div>
        <hr />
        <div data-setting-id="onboarding" id="setting-onboarding" class="setting-item">
          <div class="setting-copy">
            <strong>欢迎向导</strong>
            <span>重新走一遍首次使用引导：外观、听歌偏好、曲库与声音设置。</span>
          </div>
          <button type="button" class="soft-button" @click="emit('reopenOnboarding')">
            <i class="ph ph-sparkle"></i>
            重新打开
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
