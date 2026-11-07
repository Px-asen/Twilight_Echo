<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import { APP_LOCALES, normalizeLanguagePreference } from '../../../../shared/i18n/locale.ts'
import { useLocale } from '../../app/useLocale.ts'
import type { HomePageMode, TrackActivationMode } from '../../types/settings'
import type { BooleanSettingKey } from './types.ts'
const { settings, platform, updateSettings: persistSettings } = useSettingsStore()
const { t } = useLocale()
function setLanguage(event: Event): void {
  const value = normalizeLanguagePreference((event.target as HTMLSelectElement).value)
  void persistSettings({ language: value })
}

const emit = defineEmits<{ reopenOnboarding: [] }>()
defineProps<{
  trackActivationModeOptions: readonly { value: TrackActivationMode; label: string; icon: string }[]
  homePageModeOptions: readonly { value: HomePageMode; label: string; icon: string }[]
  toggleSetting: (key: BooleanSettingKey) => void
  setTrackActivationMode: (mode: TrackActivationMode) => void
  setHomePageMode: (mode: HomePageMode) => void
  setCloseBehavior: (event: Event) => void
}>()
</script>
<template>
  <section id="general" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-sliders-h" aria-hidden="true" />
      <h2>通用</h2>
    </div>
    <p class="settings-section-description">选择适合你的语言、启动方式和操作习惯。</p>
    <div class="section-block">
      <h3>操作习惯</h3>
      <div class="setting-list">
        <div data-setting-id="track-activation" id="setting-track-activation" class="setting-item">
          <div class="setting-copy">
            <strong>歌曲列表播放方式</strong>
            <span>选择普通左键单击还是双击播放；右键始终只打开菜单，不改变选中状态。</span>
          </div>
          <div class="segmented-control">
            <button
              v-for="option in trackActivationModeOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.trackActivationMode === option.value }"
              @click="setTrackActivationMode(option.value)"
            >
              <i :class="option.icon"></i>
              {{ option.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="section-block">
      <h3>启动与窗口</h3>
      <div class="setting-list">
        <div data-setting-id="home-page-mode" id="setting-home-page-mode" class="setting-item">
          <div class="setting-copy">
            <strong>首页内容模式</strong>
            <span>选择首页展示本地音乐为主还是流媒体为主的内容；自动模式下无本地音乐时显示流媒体首页。</span>
          </div>
          <div class="segmented-control">
            <button
              v-for="option in homePageModeOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.homePageMode === option.value }"
              @click="setHomePageMode(option.value)"
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
          <select class="preview-select" :value="settings.language" @change="setLanguage">
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
            <span v-if="platform === 'darwin'">选择关闭按钮或 ⌘W 的行为；⌘Q 始终退出应用。</span>
            <span v-else>选择点击关闭按钮后的应用行为。</span>
          </div>
          <select
            class="preview-select"
            :value="settings.closeWindowBehavior"
            @change="setCloseBehavior"
          >
            <option value="tray">
              {{ platform === 'darwin' ? '关闭窗口，后台继续播放' : '最小化到系统托盘' }}
            </option>
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
