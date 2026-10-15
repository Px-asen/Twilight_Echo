<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import SettingsGroup from './SettingsGroup.vue'
import BackupAndResetSettingsSection from './BackupAndResetSettingsSection.vue'
import DiagnosticsSettingsSection from './DiagnosticsSettingsSection.vue'
import type { UiContribution } from '../../extensions/registry'
import type { BooleanSettingKey, PluginSettingsForm, SettingsResetGroup } from './types.ts'
const { settings } = useSettingsStore()

defineProps<{
  pluginSettingsPanels: UiContribution[]
  pluginSettingsResult: Record<string, string>
  pluginSettingsError: Record<string, string>
  pluginSettingsForms: Record<string, PluginSettingsForm | null>
  pluginSettingsValues: Record<string, Record<string, string>>
  runningPluginSettingsCommand: string
  pluginPanelStateKey: (panel: UiContribution) => string
  toggleSetting: (key: BooleanSettingKey) => void
  exportSettingsBackup: () => void
  importSettingsBackup: () => void
  resetSettingsGroup: (group: SettingsResetGroup) => void
  runPluginSettingsPanel: (panel: UiContribution) => void
  setPluginSettingsField: (panel: UiContribution, key: string, value: string) => void
  submitPluginSettingsForm: (panel: UiContribution) => void
}>()
</script>
<template>
  <section id="system" class="settings-section preview-section">
    <div class="section-title-row">
      <i class="pi pi-cog" aria-hidden="true" />
      <h2>系统</h2>
    </div>
    <div class="section-block">
      <h3>运行与性能</h3>
      <div class="setting-list">
        <div
          data-setting-id="hardware-acceleration"
          id="setting-hardware-acceleration"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>硬件加速</strong>
            <span>使用 GPU 加速界面渲染、动画与模糊效果。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{
              active: settings.hardwareAcceleration,
              inactive: !settings.hardwareAcceleration
            }"
            role="switch"
            aria-label="硬件加速"
            :aria-checked="settings.hardwareAcceleration"
            @click="toggleSetting('hardwareAcceleration')"
          ></button>
        </div>
      </div>
    </div>
    <DiagnosticsSettingsSection />
    <BackupAndResetSettingsSection
      @export-settings="exportSettingsBackup"
      @import-settings="importSettingsBackup"
      @reset-group="(group: SettingsResetGroup) => resetSettingsGroup(group)"
    />
    <SettingsGroup
      id="plugin-settings"
      title="插件设置"
      :summary="
        pluginSettingsPanels.length
          ? pluginSettingsPanels.length + ' 个设置面板'
          : '暂无插件提供设置面板'
      "
      :attention="
        Object.values(pluginSettingsError).filter(Boolean).join('；') ||
        (runningPluginSettingsCommand ? '正在执行插件操作…' : '')
      "
      ><div class="setting-list">
        <p v-if="!pluginSettingsPanels.length" class="setting-hint">
          已启用的插件没有额外设置；可在插件中心管理插件。
        </p>
        <template
          v-for="(panel, index) in pluginSettingsPanels"
          :key="`${panel.pluginId}:${panel.id}`"
        >
          <hr v-if="index > 0" />
          <div class="setting-item top-align">
            <div class="setting-copy">
              <strong>{{ panel.title }}</strong>
              <span>{{ panel.description || panel.pluginId }}</span>
              <small
                v-if="pluginSettingsResult[pluginPanelStateKey(panel)]"
                class="plugin-command-result"
              >
                {{ pluginSettingsResult[pluginPanelStateKey(panel)] }}
              </small>
              <small
                v-if="pluginSettingsError[pluginPanelStateKey(panel)]"
                class="plugin-command-error"
              >
                {{ pluginSettingsError[pluginPanelStateKey(panel)] }}
              </small>
            </div>
            <button
              type="button"
              class="soft-button"
              :disabled="!panel.command || Boolean(runningPluginSettingsCommand)"
              @click="runPluginSettingsPanel(panel)"
            >
              <i v-if="panel.icon" :class="panel.icon"></i>
              {{
                runningPluginSettingsCommand === pluginPanelStateKey(panel)
                  ? '执行中…'
                  : pluginSettingsForms[pluginPanelStateKey(panel)]
                    ? '重新载入'
                    : '打开设置'
              }}
            </button>
          </div>
          <div v-if="pluginSettingsForms[pluginPanelStateKey(panel)]" class="plugin-settings-form">
            <p
              v-if="pluginSettingsForms[pluginPanelStateKey(panel)]?.notice"
              class="plugin-settings-notice"
            >
              {{ pluginSettingsForms[pluginPanelStateKey(panel)]?.notice }}
            </p>
            <label
              v-for="field in pluginSettingsForms[pluginPanelStateKey(panel)]?.fields"
              :key="field.key"
              class="plugin-settings-field"
            >
              <span>{{ field.label }}<b v-if="field.required"> *</b></span>
              <select
                v-if="field.type === 'select'"
                class="preview-select"
                :value="pluginSettingsValues[pluginPanelStateKey(panel)]?.[field.key] ?? ''"
                @change="
                  setPluginSettingsField(
                    panel,
                    field.key,
                    ($event.target as HTMLSelectElement).value
                  )
                "
              >
                <option v-for="option in field.options" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <input
                v-else
                class="preview-select"
                :type="field.type"
                :required="field.required"
                :placeholder="field.placeholder"
                :autocomplete="field.type === 'password' ? 'new-password' : 'off'"
                :value="pluginSettingsValues[pluginPanelStateKey(panel)]?.[field.key] ?? ''"
                @input="
                  setPluginSettingsField(
                    panel,
                    field.key,
                    ($event.target as HTMLInputElement).value
                  )
                "
              />
            </label>
            <button
              type="button"
              class="soft-button plugin-settings-submit"
              :disabled="Boolean(runningPluginSettingsCommand)"
              @click="submitPluginSettingsForm(panel)"
            >
              {{
                runningPluginSettingsCommand === pluginPanelStateKey(panel) ? '保存中…' : '保存设置'
              }}
            </button>
          </div>
        </template>
      </div></SettingsGroup
    >
    <SettingsGroup
      id="developer-options"
      title="开发者选项"
      :summary="settings.developerMode ? '开发者模式已开启' : '开发者模式已关闭'"
      ><div class="setting-list">
        <div data-setting-id="developer-mode" id="setting-developer-mode" class="setting-item">
          <div class="setting-copy">
            <strong>开发者模式</strong>
            <span>
              解锁插件中心的「从文件夹安装」，可直接装入未打包的插件目录，方便本地调试；关闭时只能安装
              .tep 包。默认关闭。
            </span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{ active: settings.developerMode, inactive: !settings.developerMode }"
            role="switch"
            aria-label="开发者模式"
            :aria-checked="settings.developerMode"
            @click="toggleSetting('developerMode')"
          ></button>
        </div></div
    ></SettingsGroup>
    <slot />
  </section>
</template>
