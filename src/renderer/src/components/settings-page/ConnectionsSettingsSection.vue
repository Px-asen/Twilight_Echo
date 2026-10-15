<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import IntegrationsSettingsSection from './IntegrationsSettingsSection.vue'
import NetworkProxySettingsSection from './NetworkProxySettingsSection.vue'
import type { AppSettings, ProxyMode } from '../../types/settings'
import type { BooleanSettingKey } from './types.ts'
const { settings } = useSettingsStore()

defineProps<{
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  toggleSetting: (key: BooleanSettingKey) => void
}>()
</script>
<template>
  <section id="connections" class="settings-section preview-section">
    <div class="section-title-row">
      <i class="pi pi-link" aria-hidden="true" />
      <h2>连接与控制</h2>
    </div>
    <div class="section-block">
      <h3>播放控制</h3>
      <slot />
      <div class="setting-list">
        <div data-setting-id="system-media" id="setting-system-media" class="setting-item">
          <div class="setting-copy">
            <strong>原生媒体控制 (SMTC)</strong>
            <span
              >响应键盘多媒体按键，在系统媒体面板及 FluentFlyout
              等兼容工具中显示歌曲、封面和播放控制。</span
            >
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{ active: settings.smtcEnabled, inactive: !settings.smtcEnabled }"
            role="switch"
            aria-label="原生媒体控制"
            :aria-checked="settings.smtcEnabled"
            @click="toggleSetting('smtcEnabled')"
          ></button>
        </div>
        <hr />
        <div data-setting-id="taskbar-controls" id="setting-taskbar-controls" class="setting-item">
          <div class="setting-copy">
            <strong>任务栏缩略图按钮</strong>
            <span>在 Windows 任务栏窗口预览中直接控制上一首、播放与下一首。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{
              active: settings.taskbarThumbarButtonsEnabled,
              inactive: !settings.taskbarThumbarButtonsEnabled
            }"
            role="switch"
            aria-label="任务栏缩略图播放按钮"
            :aria-checked="settings.taskbarThumbarButtonsEnabled"
            @click="toggleSetting('taskbarThumbarButtonsEnabled')"
          ></button>
        </div>
      </div>
    </div>
    <div class="section-block">
      <h3>账号状态</h3>
      <div class="setting-list">
        <div data-setting-id="check-login" id="setting-check-login" class="setting-item">
          <div class="setting-copy">
            <strong>启动时检查网易云登录</strong>
            <span>应用启动后自动刷新内置网易云音源的登录状态。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{ active: settings.autoCheckLogin, inactive: !settings.autoCheckLogin }"
            role="switch"
            aria-label="启动时检查网易云登录"
            :aria-checked="settings.autoCheckLogin"
            @click="toggleSetting('autoCheckLogin')"
          ></button>
        </div>
      </div>
    </div>
    <IntegrationsSettingsSection
      :discord-enabled="settings.discordRpcEnabled"
      :remote-enabled="settings.remoteControlEnabled"
      @update:discord-enabled="(value: boolean) => updateSettings({ discordRpcEnabled: value })"
      @update:remote-enabled="(value: boolean) => updateSettings({ remoteControlEnabled: value })"
    />
    <NetworkProxySettingsSection
      :proxy-mode="settings.proxyMode"
      :proxy-host="settings.proxyHost"
      :proxy-port="settings.proxyPort"
      :proxy-allow-direct-fallback="settings.proxyAllowDirectFallback"
      @update:proxy-mode="(value: ProxyMode) => void updateSettings({ proxyMode: value })"
      @update:proxy-host="(value: string) => void updateSettings({ proxyHost: value })"
      @update:proxy-port="(value: number) => void updateSettings({ proxyPort: value })"
      @toggle:allow-direct-fallback="toggleSetting('proxyAllowDirectFallback')"
    />
  </section>
</template>
