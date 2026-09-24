<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import DownloadSettingsFields from '@renderer/components/settings-page/DownloadSettingsFields.vue'
import IntegrationsSettingsSection from './IntegrationsSettingsSection.vue'
import BackupAndResetSettingsSection from './BackupAndResetSettingsSection.vue'
import NetworkProxySettingsSection from './NetworkProxySettingsSection.vue'
import PluginSettingsFormView from './PluginSettingsFormView.vue'
import type { UiContribution } from '../../extensions/registry'
import type { LibraryWatcherStatusSnapshot } from '../../../../shared/localLibraryScan.ts'
import type {
  AppSettings,
  ProxyMode,
  StartupHomePage,
  TrackActivationMode
} from '../../types/settings'
import type { BooleanSettingKey, PluginSettingsForm } from './types'
import { APP_LOCALES, normalizeLanguagePreference } from '../../../../shared/i18n/locale.ts'
import { useLocale } from '../../app/useLocale.ts'

const { settings, updateSettings: persistSettings } = useSettingsStore()
const { t } = useLocale()

/**
 * Switching language takes effect immediately: the locale is a computed off this
 * setting, so every surface re-renders without a restart.
 */
function setLanguage(event: Event): void {
  const value = normalizeLanguagePreference((event.target as HTMLSelectElement).value)
  void persistSettings({ language: value })
}

function toggleMiniPlayerShowInTaskbar(): void {
  void persistSettings({
    miniPlayer: {
      ...settings.value.miniPlayer,
      showInTaskbar: !settings.value.miniPlayer.showInTaskbar
    }
  })
}

defineProps<{
  libraryWatcherStatus: LibraryWatcherStatusSnapshot | null
  libraryScanStatus: { state: string; current: number; total: number }
  libraryScanIsActive: boolean
  libraryScanProgressText: string
  libraryMetadataEnrichmentText: string
  libraryMetadataEnrichmentIsActive: boolean
  libraryResetMessage: string
  libraryScanCommandError: string
  libraryResetPending: boolean
  pluginSettingsPanels: UiContribution[]
  pluginSettingsResult: Record<string, string>
  pluginSettingsError: Record<string, string>
  pluginSettingsForms: Record<string, PluginSettingsForm | null>
  pluginSettingsValues: Record<string, Record<string, string>>
  runningPluginSettingsCommand: string
  pluginPanelStateKey: (panel: UiContribution) => string
  trackActivationModeOptions: readonly { value: TrackActivationMode; label: string; icon: string }[]
  startupHomePageOptions: readonly { value: StartupHomePage; label: string; icon: string }[]
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  addLibraryFolder: () => void
  removeLibraryFolder: (folder: string) => void
  chooseDownloadFolder: () => void
  resetDownloadFolder: () => void
  toggleSetting: (key: BooleanSettingKey) => void
  setGenreSeparators: (event: Event) => void
  setTrackActivationMode: (mode: TrackActivationMode) => void
  setStartupHomePage: (page: StartupHomePage) => void
  setCloseBehavior: (event: Event) => void
  watcherStateLabel: (state: string) => string
  watcherModeLabel: (mode: string) => string
  formatWatcherTime: (iso: string | null | undefined) => string
  runFullLibraryScan: () => void
  pauseActiveLibraryScan: () => void
  resumeActiveLibraryScan: () => void
  cancelActiveLibraryScan: () => void
  resetLocalLibrary: () => void
  cancelActiveLibraryMetadataEnrichment: () => void
  exportSettingsBackup: () => void
  importSettingsBackup: () => void
  resetSettingsGroup: (group: 'appearance' | 'playback' | 'desktopLyrics') => void
  runPluginSettingsPanel: (panel: UiContribution) => void
  setPluginSettingsField: (panel: UiContribution, key: string, value: string) => void
  submitPluginSettingsForm: (panel: UiContribution) => void
  resetPluginSettingsForm: (panel: UiContribution) => void
}>()

const emit = defineEmits<{
  reopenOnboarding: []
}>()
</script>
<template>
  <section id="general" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-sliders-h"></i>
      <h2>常规 (General)</h2>
    </div>

    <div v-if="pluginSettingsPanels.length > 0" class="section-block plugin-settings-block">
      <h3>插件设置 (Plugin Settings)</h3>
      <p class="section-hint">已安装插件的可配置项会显示在这里。</p>
      <div class="setting-list">
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
          <PluginSettingsFormView
            v-if="pluginSettingsForms[pluginPanelStateKey(panel)]"
            :form="pluginSettingsForms[pluginPanelStateKey(panel)]!"
            :values="pluginSettingsValues[pluginPanelStateKey(panel)] ?? {}"
            :id-prefix="`plugin-settings-${pluginPanelStateKey(panel)}`"
            :busy="Boolean(runningPluginSettingsCommand)"
            :pending="runningPluginSettingsCommand === pluginPanelStateKey(panel)"
            @update="(key: string, value: string) => setPluginSettingsField(panel, key, value)"
            @submit="submitPluginSettingsForm(panel)"
            @reset="resetPluginSettingsForm(panel)"
          />
        </template>
      </div>
    </div>

    <div class="section-block">
      <h3>媒体库管理 (Library & Sync)</h3>
      <div class="setting-list">
        <div class="setting-item top-align">
          <div class="setting-copy">
            <strong>扫描文件夹</strong>
            <span>添加包含您本地音乐文件的目录。</span>
          </div>
          <div class="folder-list">
            <div v-for="folder in settings.libraryFolders" :key="folder" class="folder-chip">
              <span>{{ folder }}</span>
              <i
                class="pi pi-times"
                data-te-interactive
                role="button"
                tabindex="0"
                :aria-label="`移除文件夹 ${folder}`"
                @click="removeLibraryFolder(folder)"
                @keydown.enter.prevent="removeLibraryFolder(folder)"
                @keydown.space.prevent="removeLibraryFolder(folder)"
              ></i>
            </div>
            <div v-if="settings.libraryFolders.length === 0" class="folder-empty-hint">
              暂未添加任何文件夹
            </div>
            <button type="button" class="dashed-button" @click="addLibraryFolder">
              <i class="pi pi-plus"></i>
              添加文件夹
            </button>
          </div>
        </div>
        <hr />
        <div class="setting-item top-align">
          <div class="setting-copy">
            <strong>下载目录</strong>
            <span>
              流媒体「下载到本地」的保存位置；留空时沿用第一个扫描文件夹。选在扫描文件夹之外时，下载完成的文件不会自动进入媒体库。
            </span>
          </div>
          <div class="path-control">
            <input
              readonly
              aria-label="下载目录"
              :value="settings.downloadFolder || '跟随扫描文件夹'"
            />
            <button type="button" class="soft-button" @click="chooseDownloadFolder">
              选择文件夹
            </button>
            <button
              v-if="settings.downloadFolder"
              type="button"
              class="muted-button"
              @click="resetDownloadFolder"
            >
              清除
            </button>
          </div>
        </div>
        <DownloadSettingsFields />
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>流派分隔符</strong>
            <span>将标签中的多个字符识别为不同流派；默认支持 ,，;；、/。</span>
          </div>
          <input
            class="preview-select"
            type="text"
            maxlength="32"
            :value="settings.genreSeparators"
            aria-label="流派分隔符"
            placeholder=",，;；、/"
            @change="setGenreSeparators"
          />
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>实时监控文件夹变动</strong>
            <span>当添加新音乐时自动同步到媒体库，无需手动刷新。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{ active: settings.watchLibrary, inactive: !settings.watchLibrary }"
            role="switch"
            :aria-checked="settings.watchLibrary"
            @click="toggleSetting('watchLibrary')"
          ></span>
        </div>
        <div class="setting-item">
          <div class="setting-copy">
            <strong>在线歌词回退 (LRCLIB)</strong>
            <span
              >本地与 Provider 均无歌词时，按标题/艺人/时长搜索 LRCLIB
              作为最后回退。默认关闭。</span
            >
          </div>
          <span
            class="toggle-switch"
            :class="{
              active: settings.onlineLyricsFallback,
              inactive: !settings.onlineLyricsFallback
            }"
            role="switch"
            :aria-checked="settings.onlineLyricsFallback"
            @click="toggleSetting('onlineLyricsFallback')"
          ></span>
        </div>
        <div
          v-if="settings.libraryFolders.length > 0"
          class="setting-item top-align watcher-status-panel"
        >
          <div class="setting-copy">
            <strong>媒体库监控状态</strong>
            <span>各根目录的监听状态；Linux 或失败时会自动降级为定时对账扫描。</span>
          </div>
          <div class="watcher-status-list" aria-live="polite">
            <div
              v-for="item in libraryWatcherStatus?.folders ??
              settings.libraryFolders.map((folder) => ({
                folder,
                state: settings.watchLibrary ? 'failed' : 'disabled',
                mode: 'none',
                lastError: null,
                lastEventAt: null,
                lastReconcileAt: null
              }))"
              :key="item.folder"
              class="watcher-status-row"
            >
              <span class="watcher-status-path" :title="item.folder">{{ item.folder }}</span>
              <span class="watcher-status-badge" :data-state="item.state">
                {{ watcherStateLabel(item.state) }}
                · {{ watcherModeLabel(item.mode) }}
              </span>
              <span class="watcher-status-times">
                事件 {{ formatWatcherTime(item.lastEventAt) }} · 对账
                {{ formatWatcherTime(item.lastReconcileAt) }}
              </span>
              <span v-if="item.lastError" class="watcher-status-error">{{ item.lastError }}</span>
            </div>
          </div>
        </div>
        <hr />
        <div class="setting-item top-align">
          <div class="setting-copy">
            <strong>完整重扫</strong>
            <span
              >显式重新解析全部本地文件的 metadata 与封面；可暂停或取消。同目录 CUE：单音频 + 唯一
              `.cue`，≤2 MiB，UTF-8/GBK/GB18030。</span
            >
          </div>
          <div class="library-scan-panel" aria-live="polite">
            <progress
              v-if="libraryScanIsActive"
              class="library-scan-progress"
              :value="libraryScanStatus.total > 0 ? libraryScanStatus.current : undefined"
              :max="libraryScanStatus.total > 0 ? libraryScanStatus.total : 1"
            ></progress>
            <span class="library-scan-copy">{{ libraryScanProgressText }}</span>
            <span class="library-scan-copy">{{ libraryMetadataEnrichmentText }}</span>
            <span v-if="libraryResetMessage" class="library-scan-copy success-copy">
              {{ libraryResetMessage }}
            </span>
            <span v-if="libraryScanCommandError" class="library-scan-error">
              {{ libraryScanCommandError }}
            </span>
            <div class="library-scan-actions">
              <button
                type="button"
                class="brand-soft-button"
                :disabled="libraryScanIsActive"
                @click="runFullLibraryScan"
              >
                完整重扫
              </button>
              <button
                v-if="libraryScanStatus.state === 'running'"
                type="button"
                class="soft-button"
                @click="pauseActiveLibraryScan"
              >
                暂停
              </button>
              <button
                v-if="libraryScanStatus.state === 'paused'"
                type="button"
                class="soft-button"
                @click="resumeActiveLibraryScan"
              >
                继续
              </button>
              <button
                v-if="libraryScanIsActive"
                type="button"
                class="danger-soft-button"
                @click="cancelActiveLibraryScan"
              >
                取消
              </button>
              <button
                type="button"
                class="danger-soft-button"
                data-testid="settings-library-reset"
                :disabled="libraryScanIsActive || libraryResetPending"
                @click="resetLocalLibrary"
              >
                {{ libraryResetPending ? '重置中…' : '重置库' }}
              </button>
              <button
                v-if="libraryMetadataEnrichmentIsActive"
                type="button"
                class="soft-button"
                title="丢弃队列中的富化；已发出的 Provider 请求可能仍会完成但不会写回"
                @click="cancelActiveLibraryMetadataEnrichment"
              >
                取消富化
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-block">
      <h3>集成与社交 (Integration & Social)</h3>
      <div class="setting-list">
        <div class="setting-item">
          <div class="setting-copy">
            <strong>启动时检查网易云登录</strong>
            <span>应用启动后自动刷新内置网易云音源的登录状态。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{ active: settings.autoCheckLogin, inactive: !settings.autoCheckLogin }"
            role="switch"
            :aria-checked="settings.autoCheckLogin"
            @click="toggleSetting('autoCheckLogin')"
          ></span>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>原生媒体控制 (SMTC)</strong>
            <span
              >响应键盘多媒体按键，在系统媒体面板及 FluentFlyout
              等兼容工具中显示歌曲、封面和播放控制。</span
            >
          </div>
          <span
            class="toggle-switch"
            :class="{ active: settings.smtcEnabled, inactive: !settings.smtcEnabled }"
            role="switch"
            :aria-checked="settings.smtcEnabled"
            @click="toggleSetting('smtcEnabled')"
          ></span>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>任务栏缩略图按钮</strong>
            <span>在 Windows 任务栏窗口预览中直接控制上一首、播放与下一首。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{
              active: settings.taskbarThumbarButtonsEnabled,
              inactive: !settings.taskbarThumbarButtonsEnabled
            }"
            role="switch"
            :aria-checked="settings.taskbarThumbarButtonsEnabled"
            @click="toggleSetting('taskbarThumbarButtonsEnabled')"
          ></span>
        </div>
      </div>
    </div>

    <IntegrationsSettingsSection
      :discord-enabled="settings.discordRpcEnabled"
      :remote-enabled="settings.remoteControlEnabled"
      @update:discord-enabled="(value: boolean) => updateSettings({ discordRpcEnabled: value })"
      @update:remote-enabled="(value: boolean) => updateSettings({ remoteControlEnabled: value })"
    />

    <div class="section-block">
      <h3>操作习惯 (Interaction)</h3>
      <div class="setting-list">
        <div class="setting-item">
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
      <h3>启动与窗口 (Startup)</h3>
      <div class="setting-list">
        <div class="setting-item">
          <div class="setting-copy">
            <strong>启动后进入</strong>
            <span>选择每次打开应用时默认显示的主页。</span>
          </div>
          <div class="segmented-control">
            <button
              v-for="option in startupHomePageOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.startupHomePage === option.value }"
              @click="setStartupHomePage(option.value)"
            >
              <i :class="option.icon"></i>
              {{ option.label }}
            </button>
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>开机自动启动</strong>
            <span>在系统启动时自动在后台运行。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{ active: settings.launchAtLogin, inactive: !settings.launchAtLogin }"
            role="switch"
            :aria-checked="settings.launchAtLogin"
            @click="toggleSetting('launchAtLogin')"
          ></span>
        </div>
        <hr />
        <div class="setting-item">
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
        <div class="setting-item">
          <div class="setting-copy">
            <strong>关闭主窗口时</strong>
            <span>选择点击关闭按钮后的应用行为。</span>
          </div>
          <select
            class="preview-select"
            :value="settings.closeWindowBehavior"
            @change="setCloseBehavior"
          >
            <option value="tray">最小化到系统托盘</option>
            <option value="miniPlayer">切换为迷你播放器</option>
            <option value="quit">退出应用</option>
          </select>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>迷你播放器显示在任务栏</strong>
            <span>开启后可从任务栏独立唤回迷你播放器；关闭后仅剩下悬浮小窗。</span>
          </div>
          <span
            class="toggle-switch"
            :class="{
              active: settings.miniPlayer.showInTaskbar,
              inactive: !settings.miniPlayer.showInTaskbar
            }"
            role="switch"
            :aria-checked="settings.miniPlayer.showInTaskbar"
            @click="toggleMiniPlayerShowInTaskbar"
          ></span>
        </div>
        <hr />
        <div class="setting-item">
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

    <BackupAndResetSettingsSection
      @export-settings="exportSettingsBackup"
      @import-settings="importSettingsBackup"
      @reset-group="
        (group: 'appearance' | 'playback' | 'desktopLyrics') => resetSettingsGroup(group)
      "
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

    <div class="section-block">
      <h3>开发者选项 (Developer)</h3>
      <div class="setting-list">
        <div class="setting-item">
          <div class="setting-copy">
            <strong>开发者模式</strong>
            <span>
              解锁插件中心的「从文件夹安装」，可直接装入未打包的插件目录，方便本地调试；关闭时只能安装
              .tep 包。默认关闭。
            </span>
          </div>
          <span
            class="toggle-switch"
            :class="{ active: settings.developerMode, inactive: !settings.developerMode }"
            role="switch"
            :aria-checked="settings.developerMode"
            @click="toggleSetting('developerMode')"
          ></span>
        </div>
      </div>
    </div>
  </section>
</template>
