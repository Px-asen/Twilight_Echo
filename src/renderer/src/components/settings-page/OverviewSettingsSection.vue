<script setup lang="ts">
import { computed } from 'vue'
import {
  colorModeOptions,
  sections,
  settingsSectionGroups,
  type SectionKey
} from './types.ts'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useAudioOutputDspStore } from '../../stores/useAudioOutputDspStore'
import type { AppTheme } from '../../types/settings'

const props = defineProps<{
  themeSummary: string
  deviceSummary: string
  libraryScanIsActive: boolean
  libraryScanProgressText: string
  formattedCacheSize: string
  appVersion: string
  setCloseBehavior: (event: Event) => void
}>()

const emit = defineEmits<{
  selectSection: [section: SectionKey]
  toggleDesktopLyrics: []
  openEqualizer: []
}>()

const { settings, updateSettings } = useSettingsStore()
const audioOutputDspStore = useAudioOutputDspStore()

const directoryGroups = computed(() =>
  settingsSectionGroups
    .map((group) => ({
      key: group.key,
      label: group.label || '常规',
      items: sections.filter(
        (section) => section.group === group.key && section.key !== 'overview'
      )
    }))
    .filter((group) => group.items.length > 0)
)

const uiDensityLabel = computed(
  () =>
    ({ compact: '紧凑密度', standard: '标准密度', comfortable: '宽松密度' })[
      settings.value.uiDensity
    ] ?? '标准密度'
)

const appearanceMeta = computed(
  () =>
    `${settings.value.useCoverTheme ? '封面取色已开启' : '固定主题色'} · ${uiDensityLabel.value}`
)

const audioOutputLabel = computed(() => {
  const activeOption = audioOutputDspStore.audioOutputOptions?.find(
    (option) => option.id === audioOutputDspStore.audioOutput
  )
  const base = activeOption?.label ?? (audioOutputDspStore.audioOutput || '默认引擎')
  return audioOutputDspStore.exclusiveMode ? `${base} 独占` : base
})

const audioMeta = computed(
  () =>
    `${audioOutputLabel.value} · ${audioOutputDspStore.audioProcessing.dspEnabled ? 'DSP 已开启' : 'DSP 直通'}`
)

const librarySummary = computed(() => {
  if (props.libraryScanIsActive) return props.libraryScanProgressText
  const count = settings.value.libraryFolders?.length ?? 0
  return count > 0 ? `已添加 ${count} 个音乐文件夹` : '暂未添加本地文件夹'
})

const storageMeta = computed(
  () =>
    `${settings.value.watchLibrary ? '实时监控已开启' : '实时监控已关闭'} · 缓存 ${props.formattedCacheSize}`
)

const versionTitle = computed(() =>
  props.appVersion ? `Twilight Echo v${props.appVersion}` : 'Twilight Echo'
)

const systemMeta = computed(
  () =>
    `全局快捷键${settings.value.globalShortcuts ? '已开启' : '已关闭'} · 系统媒体控制${settings.value.smtcEnabled ? '已开启' : '已关闭'}`
)

function setColorMode(theme: AppTheme): void {
  if (settings.value.theme === theme) return
  void updateSettings({ theme })
}

function toggleDspMaster(): void {
  void audioOutputDspStore.setAudioProcessing({
    dspEnabled: !audioOutputDspStore.audioProcessing.dspEnabled
  })
}
</script>

<template>
  <section id="overview" class="glass-card preview-section settings-overview-section">
    <div class="section-title-row">
      <i class="pi pi-th-large" aria-hidden="true" />
      <h2>概览</h2>
    </div>
    <p class="settings-section-description">
      一眼看清当前状态，常用开关和全部设置都从这里出发。
    </p>

    <div class="overview-status-grid" role="list" aria-label="当前配置概览">
      <button
        type="button"
        role="listitem"
        class="overview-status-card"
        @click="emit('selectSection', 'appearance')"
      >
        <span class="settings-tone-tile" data-settings-tone="coral">
          <i class="pi pi-palette" aria-hidden="true" />
        </span>
        <span class="overview-status-copy">
          <span class="overview-status-label">外观与主题</span>
          <strong>{{ themeSummary }}</strong>
          <small>{{ appearanceMeta }}</small>
        </span>
        <i class="pi pi-angle-right overview-card-chevron" aria-hidden="true" />
      </button>

      <button
        type="button"
        role="listitem"
        class="overview-status-card"
        @click="emit('selectSection', 'playback')"
      >
        <span class="settings-tone-tile" data-settings-tone="rose">
          <i class="pi pi-volume-up" aria-hidden="true" />
        </span>
        <span class="overview-status-copy">
          <span class="overview-status-label">声音与输出</span>
          <strong>{{ deviceSummary }}</strong>
          <small>{{ audioMeta }}</small>
        </span>
        <i class="pi pi-angle-right overview-card-chevron" aria-hidden="true" />
      </button>

      <button
        type="button"
        role="listitem"
        class="overview-status-card"
        @click="emit('selectSection', 'library')"
      >
        <span class="settings-tone-tile" data-settings-tone="blue">
          <i class="pi pi-folder-open" aria-hidden="true" />
        </span>
        <span class="overview-status-copy">
          <span class="overview-status-label">媒体库与缓存</span>
          <strong>{{ librarySummary }}</strong>
          <small>{{ storageMeta }}</small>
        </span>
        <i class="pi pi-angle-right overview-card-chevron" aria-hidden="true" />
      </button>

      <button
        type="button"
        role="listitem"
        class="overview-status-card"
        @click="emit('selectSection', 'updates')"
      >
        <span class="settings-tone-tile" data-settings-tone="accent">
          <i class="pi pi-info-circle" aria-hidden="true" />
        </span>
        <span class="overview-status-copy">
          <span class="overview-status-label">版本与控制</span>
          <strong>{{ versionTitle }}</strong>
          <small>{{ systemMeta }}</small>
        </span>
        <i class="pi pi-angle-right overview-card-chevron" aria-hidden="true" />
      </button>
    </div>

    <div class="section-block">
      <h3>常用控制</h3>
      <div class="setting-list">
        <div class="setting-item">
          <div class="setting-copy">
            <strong>色彩模式</strong>
            <span>快速切换浅色、深色或跟随系统外观。</span>
          </div>
          <div class="segmented-control" role="group" aria-label="快速切换色彩模式">
            <button
              v-for="option in colorModeOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.theme === option.value }"
              @click="setColorMode(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>桌面歌词</strong>
            <span>在桌面悬浮显示当前播放歌曲的同步歌词。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{
              active: settings.desktopLyrics?.enabled,
              inactive: !settings.desktopLyrics?.enabled
            }"
            role="switch"
            aria-label="桌面歌词快速开关"
            :aria-checked="Boolean(settings.desktopLyrics?.enabled)"
            @click="emit('toggleDesktopLyrics')"
          ></button>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>DSP 声音处理</strong>
            <span>启用均衡器、响度归一化、交叉馈送与脉冲响应卷积。</span>
          </div>
          <div class="inline-controls">
            <button type="button" class="soft-button" @click="emit('openEqualizer')">
              打开均衡器
            </button>
            <button
              type="button"
              class="toggle-switch"
              :class="{
                active: audioOutputDspStore.audioProcessing.dspEnabled,
                inactive: !audioOutputDspStore.audioProcessing.dspEnabled
              }"
              role="switch"
              aria-label="DSP 声音处理快速开关"
              :aria-checked="audioOutputDspStore.audioProcessing.dspEnabled"
              @click="toggleDspMaster"
            ></button>
          </div>
        </div>
        <hr />
        <div class="setting-item">
          <div class="setting-copy">
            <strong>关闭主窗口时</strong>
            <span>选择点击窗口关闭按钮后的默认行为。</span>
          </div>
          <select
            class="preview-select"
            aria-label="概览关闭主窗口行为"
            :value="settings.closeWindowBehavior"
            @change="setCloseBehavior"
          >
            <option value="tray">最小化到系统托盘</option>
            <option value="miniPlayer">切换为迷你播放器</option>
            <option value="quit">直接退出应用</option>
          </select>
        </div>
      </div>
    </div>

    <div class="section-block overview-directory">
      <h3>全部设置</h3>
      <div class="overview-group-list">
        <div v-for="group in directoryGroups" :key="group.key" class="overview-group">
          <h4 class="overview-group-title">{{ group.label }}</h4>
          <div class="overview-category-grid">
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              class="overview-category-card"
              @click="emit('selectSection', item.key)"
            >
              <span class="settings-tone-tile" :data-settings-tone="item.tone">
                <i :class="item.icon" aria-hidden="true" />
              </span>
              <span class="overview-category-copy">
                <strong>{{ item.label }}</strong>
                <small>{{ item.description }}</small>
              </span>
              <i class="pi pi-angle-right overview-card-chevron" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
