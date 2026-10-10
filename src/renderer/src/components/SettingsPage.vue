<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { scrollMotionBehavior } from '../app/scrollMotion'
import GeneralSettingsSection from './settings-page/GeneralSettingsSection.vue'
import AppearanceSettingsSection from './settings-page/AppearanceSettingsSection.vue'
import { openAppearanceEditor } from '../composables/appearanceEditorState.ts'
import PlaybackSettingsSection from './settings-page/PlaybackSettingsSection.vue'
import DspSettingsSection from './settings-page/DspSettingsSection.vue'
import LibrarySettingsSection from './settings-page/LibrarySettingsSection.vue'
import ConnectionsSettingsSection from './settings-page/ConnectionsSettingsSection.vue'
import SystemSettingsSection from './settings-page/SystemSettingsSection.vue'
import LyricsStyleSettings from './settings-page/LyricsStyleSettings.vue'
import CacheSettingsSection from './settings-page/CacheSettingsSection.vue'
import DesktopLyricsSettingsSection from './settings-page/DesktopLyricsSettingsSection.vue'
import AboutSettingsSection from './settings-page/AboutSettingsSection.vue'
import ShortcutsSettingsSection from './settings-page/ShortcutsSettingsSection.vue'
import { provideSettingsDisclosures } from './settings-page/settingsDisclosureRegistry.ts'
import {
  type SectionKey,
  type SettingsSectionInput,
  type SettingsResetGroup,
  LEGACY_SETTINGS_TARGETS,
  normalizeSettingsSection,
  resolveSettingsSearchEntry,
  type BooleanSettingKey,
  type SettingsSearchEntry,
  sections,
  startupHomePageOptions,
  trackActivationModeOptions,
  streamingAudioCachePolicyOptions,
  SETTINGS_SEARCH_INDEX,
  type PluginSettingsFieldType,
  type PluginSettingsOption,
  type PluginSettingsField,
  type PluginSettingsForm,
  RESET_DESKTOP_LYRICS
} from './settings-page/types.ts'
import { useAudioOutputDspStore } from '../stores/useAudioOutputDspStore'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'
import { useLocale } from '../app/useLocale.ts'
import { useThemeStore } from '../stores/useThemeStore'
import { useMusicStore } from '../stores/useMusicStore'
import { useExtensionRegistry, type UiContribution } from '../extensions/registry'
import type {
  AppSettings,
  DesktopLyricsSettings,
  MusicCachePolicySettings,
  PlayerShortcutStatus,
  GlobalShortcutSettings,
  StartupHomePage,
  TrackActivationMode,
  StreamingAudioCachePolicy
} from '../types/settings'
import type { LibraryWatcherStatusSnapshot } from '../../../shared/localLibraryScan.ts'
import type { SettingsNavigationTarget } from '@renderer/app/useAppNavigation.ts'
import {
  DEFAULT_LYRICS_APPEARANCE,
  cloneLyricsAppearance
} from '../../../shared/lyricsAppearance.ts'
import { DEFAULT_PLAYER_BAR_SETTINGS, clonePlayerBarSettings } from '../../../shared/playerBar.ts'

const props = defineProps<{
  initialSection?: SettingsSectionInput
  navigationTarget?: SettingsNavigationTarget
}>()

const emit = defineEmits<{
  sectionChange: [section: SectionKey]
  openEqualizer: []
  openDspRack: []
  openThemeStudio: []
  openThemeWorkshop: []
  reopenOnboarding: []
}>()

const runningPluginSettingsCommand = ref('')
const pluginSettingsResult = ref<Record<string, string>>({})
const pluginSettingsError = ref<Record<string, string>>({})

const pluginSettingsForms = ref<Record<string, PluginSettingsForm | null>>({})
const pluginSettingsValues = ref<Record<string, Record<string, string>>>({})
const settingsSearchQuery = ref('')
const settingsNotice = ref('')
const settingsError = ref('')
const importSettingsInputRef = ref<HTMLInputElement | null>(null)
const shortcutStatuses = ref<PlayerShortcutStatus[]>([])

const disclosures = provideSettingsDisclosures()
const activeSection = ref<SectionKey>(normalizeSettingsSection(props.initialSection))
const activeSectionInfo = computed(
  () => sections.find((section) => section.key === activeSection.value) ?? sections[0]
)
watch(activeSection, (section) => emit('sectionChange', section), { flush: 'sync' })
const pageRef = ref<HTMLElement | null>(null)

function setNavigationPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  button.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
}

const {
  settings,
  paths,
  appVersion,
  clearingCache,
  formattedCacheSize,
  clearingBpmAnalysisCache,
  formattedBpmAnalysisCacheSize,
  clearingLoudnessAnalysisCache,
  formattedLoudnessAnalysisCacheSize,
  restartRequired,
  restartReasons,
  windowTransparencySupported,
  lastSettingsError,
  loadSettings,
  updateSettings,
  chooseCacheFolder,
  exportSettingsBackup: exportSettingsBackupFile,
  importSettingsBackup: importSettingsBackupFile,
  resetCacheFolder,
  refreshCacheSize,
  clearCache,
  refreshBpmAnalysisCacheSize,
  clearBpmAnalysisCache,
  refreshLoudnessAnalysisCacheSize,
  clearLoudnessAnalysisCache,
  getShortcutStatuses,
  relaunch,
  addLibraryFolder,
  removeLibraryFolder,
  chooseDownloadFolder,
  resetDownloadFolder
} = useSettingsStore()

const audioOutputDspStore = useAudioOutputDspStore()
const {
  libraryScanStatus,
  libraryScanProgress,
  libraryMetadataEnrichmentStatus,
  startFullLibraryScan,
  resetLibrary,
  pauseLibraryScan,
  resumeLibraryScan,
  cancelLibraryScan,
  cancelLibraryMetadataEnrichment,
  refreshLibraryIndex
} = useMusicStore()
const libraryScanCommandError = ref('')
const libraryResetPending = ref(false)
const libraryResetMessage = ref('')
const libraryWatcherStatus = ref<LibraryWatcherStatusSnapshot | null>(null)
let libraryWatcherStatusTimer: number | null = null

const libraryScanIsActive = computed(
  () => libraryScanStatus.value.state === 'running' || libraryScanStatus.value.state === 'paused'
)
const libraryMetadataEnrichmentIsActive = computed(
  () => libraryMetadataEnrichmentStatus.value.state === 'enriching'
)
const libraryScanProgressText = computed(() => {
  const status = libraryScanStatus.value
  if (status.state === 'failed') return status.error || '后台扫描失败'
  if (status.state === 'paused') return `已暂停：${status.current} / ${status.total || '?'} 项`
  if (status.state === 'running') {
    const phase = libraryScanProgress.value?.phase === 'parsing' ? '解析元数据' : '检查文件'
    return `${phase}：${status.current} / ${status.total || '?'} 项`
  }
  if (status.state === 'completed') {
    return `已完成：解析 ${status.parsedFileCount} 个文件，跳过 ${status.skippedUnchanged} 个未变化文件`
  }
  if (status.state === 'cancelled') return '扫描已取消，未提交未完成的结果'
  return '启动时仅核对 path、size 与 mtime；完整元数据重扫只由此处触发。'
})
const libraryMetadataEnrichmentText = computed(() => {
  const status = libraryMetadataEnrichmentStatus.value
  if (status.state === 'enriching') {
    return `后台富化中：已处理 ${status.completed + status.failed} / ${status.total} 首，${status.active} 项并发`
  }
  if (status.state === 'failed') return status.error || '后台元数据富化失败'
  if (status.state === 'completed') {
    return `后台富化完成：成功 ${status.completed} 首，跳过 ${status.skipped} 首`
  }
  if (status.state === 'cancelled') return '后台元数据富化已取消，迟到结果不会写回媒体库'
  return '新曲目会先显示，再在后台补齐封面、歌词和在线 metadata。'
})

function watcherStateLabel(state: string): string {
  switch (state) {
    case 'active':
      return '活跃'
    case 'degraded':
      return '降级轮询'
    case 'failed':
      return '失败'
    case 'disabled':
      return '已关闭'
    default:
      return state
  }
}

function watcherModeLabel(mode: string): string {
  switch (mode) {
    case 'recursive':
      return '递归监听'
    case 'polling':
      return '定时对账'
    case 'none':
      return '未监听'
    default:
      return mode
  }
}

function formatWatcherTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const delta = Date.now() - ms
  if (delta < 0) return '刚刚'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return new Date(ms).toLocaleString()
}

async function refreshLibraryWatcherStatus(): Promise<void> {
  try {
    libraryWatcherStatus.value = await window.api.library.getWatcherStatus()
  } catch {
    libraryWatcherStatus.value = null
  }
}

async function runFullLibraryScan(): Promise<void> {
  libraryScanCommandError.value = ''
  try {
    await startFullLibraryScan()
  } catch (error) {
    libraryScanCommandError.value = scanCommandErrorMessage(error)
  }
}

async function resetLocalLibrary(): Promise<void> {
  libraryScanCommandError.value = ''
  libraryResetMessage.value = ''
  if (
    !window.confirm(
      '将清空本地媒体库索引和当前界面中的全部本地曲目。\n\n不会删除磁盘上的音乐文件，也不会删除播放列表；之后可通过“完整重扫”重新建立媒体库。\n\n确定重置吗？'
    )
  ) {
    return
  }

  libraryResetPending.value = true
  try {
    const removedCount = await resetLibrary()
    libraryResetMessage.value = `媒体库已重置，已从索引移除 ${removedCount} 首曲目；磁盘文件未删除。`
  } catch (error) {
    libraryScanCommandError.value = scanCommandErrorMessage(error)
  } finally {
    libraryResetPending.value = false
  }
}

async function pauseActiveLibraryScan(): Promise<void> {
  libraryScanCommandError.value = ''
  try {
    if (!(await pauseLibraryScan())) libraryScanCommandError.value = '当前没有可暂停的扫描'
  } catch (error) {
    libraryScanCommandError.value = scanCommandErrorMessage(error)
  }
}

async function resumeActiveLibraryScan(): Promise<void> {
  libraryScanCommandError.value = ''
  try {
    if (!(await resumeLibraryScan())) libraryScanCommandError.value = '当前没有可继续的扫描'
  } catch (error) {
    libraryScanCommandError.value = scanCommandErrorMessage(error)
  }
}

async function cancelActiveLibraryScan(): Promise<void> {
  libraryScanCommandError.value = ''
  try {
    if (!(await cancelLibraryScan())) libraryScanCommandError.value = '当前没有可取消的扫描'
  } catch (error) {
    libraryScanCommandError.value = scanCommandErrorMessage(error)
  }
}

function cancelActiveLibraryMetadataEnrichment(): void {
  libraryScanCommandError.value = ''
  if (!cancelLibraryMetadataEnrichment()) {
    libraryScanCommandError.value = '当前没有可取消的后台富化任务'
  }
}

function scanCommandErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '后台扫描操作失败'
}

const { setAudioProcessing, refreshAudioOutputState, clearBpmAnalysisFromPlaybackState } =
  audioOutputDspStore

const { syncExtensions, uiContributions } = useExtensionRegistry()
const themeStore = useThemeStore()

const activeCachePath = computed(
  () => paths.value?.activeCachePath ?? settings.value.cachePath ?? ''
)
const pluginSettingsPanels = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'settingsPanel')
)
const activeSearchIndex = ref(-1)
const filteredSearchResults = computed(() => {
  const query = settingsSearchQuery.value.trim().toLowerCase()
  if (!query) return []
  const matches = SETTINGS_SEARCH_INDEX.map((entry) => {
    const title = entry.title.toLowerCase()
    const terms = entry.terms.toLowerCase()
    let score = 0
    if (title === query) score = 4
    else if (title.startsWith(query)) score = 3
    else if (title.includes(query)) score = 2
    else if (terms.includes(query)) score = 1
    return { entry, score }
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry)
  return matches
})
// 结果集变化时修正选中索引，避免越界
watch(filteredSearchResults, (matches) => {
  activeSearchIndex.value = matches.length > 0 ? 0 : -1
})
const hasSettingsSearchResults = computed(
  () => settingsSearchQuery.value.trim().length > 0 && filteredSearchResults.value.length > 0
)
const hasSettingsSearchNoResults = computed(
  () => settingsSearchQuery.value.trim().length > 0 && filteredSearchResults.value.length === 0
)

async function setGenreSeparators(event: Event): Promise<void> {
  const value = (event.target as HTMLInputElement).value
  await updateSettings({ genreSeparators: value })
  refreshLibraryIndex()
}

function toggleSetting(key: BooleanSettingKey): void {
  if (key === 'windowTransparency' && !windowTransparencySupported.value) {
    settingsNotice.value =
      '当前系统不支持窗口透明（Linux Wayland，或 Windows 未开启系统透明效果），已自动使用不透明窗口。'
    return
  }
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>)
}

const { pushNotice } = useAppNoticeStore()
const { t, errorText } = useLocale()
watch(lastSettingsError, (error) => {
  if (!error) return
  settingsError.value = error
  pushNotice({
    kind: 'error',
    message: `设置保存失败：${error}`
  })
})

async function toggleGlobalShortcuts(): Promise<void> {
  await updateSettings({ globalShortcuts: !settings.value.globalShortcuts })
  await refreshShortcutStatuses()
}

async function onUpdateShortcutBindings(patch: Partial<GlobalShortcutSettings>): Promise<void> {
  await updateSettings({
    globalShortcutBindings: { ...settings.value.globalShortcutBindings, ...patch }
  })
  await refreshShortcutStatuses()
}

function toggleCacheArtifact(key: keyof MusicCachePolicySettings): void {
  if (key === 'streamingAudio') return
  void updateSettings({
    cachePolicy: {
      ...settings.value.cachePolicy,
      [key]: !settings.value.cachePolicy[key]
    }
  })
}

function setStreamingAudioCachePolicy(event: Event): void {
  const streamingAudio = (event.target as HTMLSelectElement).value as StreamingAudioCachePolicy
  void updateSettings({
    cachePolicy: {
      ...settings.value.cachePolicy,
      streamingAudio
    }
  })
}

function toggleAutoAnalyzeBpm(): void {
  void updateSettings({ autoAnalyzeBpm: !settings.value.autoAnalyzeBpm })
}

async function toggleDesktopLyrics(): Promise<void> {
  const enabled = await window.api.desktopLyrics.setEnabled(!settings.value.desktopLyrics.enabled)
  await updateSettings({ desktopLyrics: { ...settings.value.desktopLyrics, enabled } })
}

function resetSettingsGroup(group: SettingsResetGroup): void {
  if (
    !window.confirm(
      `恢复${{ appearance: '外观与播放条', playback: '播放与音效', lyrics: '播放页歌词', desktopLyrics: '桌面歌词' }[group]}设置为默认值？`
    )
  )
    return
  settingsNotice.value = ''
  settingsError.value = ''
  if (group === 'appearance') {
    void (async () => {
      await themeStore.setActive({ kind: 'builtin', id: 'builtin:twilight-echo-default' })
      await updateSettings({
        theme: 'system',
        motionPreference: 'system',
        blurEffect: true,
        useCoverTheme: true,
        playerBar: clonePlayerBarSettings(DEFAULT_PLAYER_BAR_SETTINGS),
        fontFamily: 'system',
        fontRendering: 'auto',
        uiDensity: 'standard'
      })
      settingsNotice.value = '外观设置已恢复默认'
    })().catch((cause) => {
      settingsError.value = cause instanceof Error ? cause.message : '外观设置恢复失败'
    })
    return
  }
  if (group === 'lyrics') {
    void updateSettings({ lyricsAppearance: cloneLyricsAppearance(DEFAULT_LYRICS_APPEARANCE) })
      .then(() => {
        settingsNotice.value = '播放页歌词已恢复默认'
      })
      .catch((cause) => {
        settingsError.value = cause instanceof Error ? cause.message : '歌词设置恢复失败'
      })
    return
  }
  if (group === 'playback') {
    void updateSettings({
      playbackResumeMode: 'off',
      previousButtonAction: 'restart',
      sleepTimer: { defaultMinutes: 30, fadeSeconds: 10 },
      ncmPlaybackQuality: 'auto',
      audioExclusiveMode: false,
      audioExclusiveAutoRelease: false,
      audioOutputConfig: {
        preferredBufferSize: 0,
        routingMode: 'auto',
        wasapiExclusivePushMode: false,
        pcmToDsdMode: 'off'
      }
    }).then(() => {
      settingsNotice.value = '播放设置已恢复默认'
    })
    void setAudioProcessing({
      dspEnabled: false,
      clipGuard: true,
      fftEnabled: true,
      fftResolution: 8192,
      highResolution: true,
      dsdToPcm: false,
      dsdOutputMode: 'auto',
      dsdRatePolicy: 'pcm-fallback',
      sacdProgramMode: 'auto',
      eqEnabled: false,
      volumeNormalization: 'off',
      replayGainPreamp: 0,
      replayGainFallback: 0,
      replayGainClip: true,
      convolverEnabled: false,
      convolverIrPath: '',
      crossfeedEnabled: false,
      crossfeedStrength: 0,
      crossfeedDelayMs: 0.35,
      crossfeedCutoffHz: 700,
      gapless: true,
      crossfadeSeconds: 0
    })
    return
  }
  void updateSettings({ desktopLyrics: { ...RESET_DESKTOP_LYRICS } }).then(() => {
    settingsNotice.value = '桌面歌词设置已恢复默认'
  })
}

function updateDesktopLyrics(patch: Partial<DesktopLyricsSettings>): void {
  if (settings.value.desktopLyrics) {
    Object.assign(settings.value.desktopLyrics, patch)
  }
  const dl = { ...settings.value.desktopLyrics, ...patch }
  void updateSettings({ desktopLyrics: dl })
}

function setStartupHomePage(startupHomePage: StartupHomePage): void {
  if (settings.value.startupHomePage === startupHomePage) return
  void updateSettings({ startupHomePage })
}

function setTrackActivationMode(trackActivationMode: TrackActivationMode): void {
  if (settings.value.trackActivationMode === trackActivationMode) return
  void updateSettings({ trackActivationMode })
}

function setCloseBehavior(event: Event): void {
  const closeWindowBehavior = (event.target as HTMLSelectElement).value as
    | 'quit'
    | 'tray'
    | 'miniPlayer'
  void updateSettings({
    closeWindowBehavior,
    closeToTray: closeWindowBehavior === 'tray'
  })
}

function pluginPanelStateKey(panel: UiContribution): string {
  return `${panel.pluginId}:${panel.id}`
}

function normalizePluginSettingsForm(value: unknown): PluginSettingsForm | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'settings-form') return null
  const submitCommand = typeof record.submitCommand === 'string' ? record.submitCommand.trim() : ''
  if (!submitCommand || submitCommand.length > 160 || !Array.isArray(record.fields)) return null
  const fields = record.fields.slice(0, 20).flatMap((raw): PluginSettingsField[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const field = raw as Record<string, unknown>
    const key = typeof field.key === 'string' ? field.key.trim() : ''
    const label = typeof field.label === 'string' ? field.label.trim() : ''
    const type = field.type
    if (
      !/^[A-Za-z0-9_.:-]{1,80}$/.test(key) ||
      !label ||
      label.length > 100 ||
      !['text', 'password', 'url', 'select'].includes(String(type))
    ) {
      return []
    }
    const options = Array.isArray(field.options)
      ? field.options.slice(0, 30).flatMap((rawOption): PluginSettingsOption[] => {
          if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return []
          const option = rawOption as Record<string, unknown>
          const optionLabel = typeof option.label === 'string' ? option.label.trim() : ''
          const optionValue = typeof option.value === 'string' ? option.value : ''
          if (!optionLabel || optionLabel.length > 100 || optionValue.length > 200) return []
          return [{ label: optionLabel, value: optionValue }]
        })
      : []
    if (type === 'select' && options.length === 0) return []
    return [
      {
        key,
        label,
        type: type as PluginSettingsFieldType,
        required: field.required === true,
        placeholder: typeof field.placeholder === 'string' ? field.placeholder.slice(0, 200) : '',
        value:
          type === 'password'
            ? ''
            : typeof field.value === 'string'
              ? field.value.slice(0, 4096)
              : '',
        options
      }
    ]
  })
  if (fields.length === 0) return null
  return {
    submitCommand,
    fields,
    notice: typeof record.notice === 'string' ? record.notice.slice(0, 500) : ''
  }
}

function setPluginSettingsField(panel: UiContribution, key: string, value: string): void {
  const stateKey = pluginPanelStateKey(panel)
  pluginSettingsValues.value = {
    ...pluginSettingsValues.value,
    [stateKey]: {
      ...(pluginSettingsValues.value[stateKey] ?? {}),
      [key]: value.slice(0, 4096)
    }
  }
}

async function runPluginSettingsPanel(panel: UiContribution): Promise<void> {
  const stateKey = pluginPanelStateKey(panel)
  if (!panel.command || runningPluginSettingsCommand.value) return
  runningPluginSettingsCommand.value = stateKey
  pluginSettingsError.value = { ...pluginSettingsError.value, [stateKey]: '' }
  pluginSettingsResult.value = { ...pluginSettingsResult.value, [stateKey]: '' }
  try {
    const result = await window.api.extensions.executeCommand(panel.command, [
      {
        source: 'settingsPanel',
        panelId: panel.id
      }
    ])
    const form = normalizePluginSettingsForm(result)
    if (form) {
      pluginSettingsForms.value = { ...pluginSettingsForms.value, [stateKey]: form }
      pluginSettingsValues.value = {
        ...pluginSettingsValues.value,
        [stateKey]: Object.fromEntries(form.fields.map((field) => [field.key, field.value]))
      }
      pluginSettingsResult.value = { ...pluginSettingsResult.value, [stateKey]: '' }
      return
    }
    pluginSettingsForms.value = { ...pluginSettingsForms.value, [stateKey]: null }
    pluginSettingsResult.value = {
      ...pluginSettingsResult.value,
      [stateKey]:
        result == null ? '已执行' : typeof result === 'string' ? result : JSON.stringify(result)
    }
  } catch (err) {
    pluginSettingsError.value = {
      ...pluginSettingsError.value,
      [stateKey]: err instanceof Error ? err.message : String(err)
    }
  } finally {
    runningPluginSettingsCommand.value = ''
  }
}

async function submitPluginSettingsForm(panel: UiContribution): Promise<void> {
  const stateKey = pluginPanelStateKey(panel)
  const form = pluginSettingsForms.value[stateKey]
  if (!form || runningPluginSettingsCommand.value) return
  const values = pluginSettingsValues.value[stateKey] ?? {}
  const missingField = form.fields.find((field) => field.required && !values[field.key]?.trim())
  if (missingField) {
    pluginSettingsError.value = {
      ...pluginSettingsError.value,
      [stateKey]: `请填写${missingField.label}`
    }
    return
  }
  runningPluginSettingsCommand.value = stateKey
  pluginSettingsError.value = { ...pluginSettingsError.value, [stateKey]: '' }
  pluginSettingsResult.value = { ...pluginSettingsResult.value, [stateKey]: '' }
  try {
    const plainValues = JSON.parse(JSON.stringify(values)) as Record<string, string>
    const result = await window.api.extensions.executeCommand(form.submitCommand, [plainValues])
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    const refreshedForm = normalizePluginSettingsForm(record?.form)
    if (refreshedForm) {
      pluginSettingsForms.value = { ...pluginSettingsForms.value, [stateKey]: refreshedForm }
      pluginSettingsValues.value = {
        ...pluginSettingsValues.value,
        [stateKey]: Object.fromEntries(
          refreshedForm.fields.map((field) => [field.key, field.value])
        )
      }
    } else {
      pluginSettingsValues.value = {
        ...pluginSettingsValues.value,
        [stateKey]: Object.fromEntries(
          form.fields.map((field) => [
            field.key,
            field.type === 'password' ? '' : (values[field.key] ?? '')
          ])
        )
      }
    }
    pluginSettingsResult.value = {
      ...pluginSettingsResult.value,
      [stateKey]:
        typeof record?.message === 'string'
          ? record.message.slice(0, 500)
          : result == null
            ? '设置已保存'
            : typeof result === 'string'
              ? result
              : '设置已保存'
    }
  } catch (err) {
    pluginSettingsError.value = {
      ...pluginSettingsError.value,
      [stateKey]: err instanceof Error ? err.message : String(err)
    }
  } finally {
    runningPluginSettingsCommand.value = ''
  }
}

function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

async function exportSettingsBackup(): Promise<void> {
  settingsNotice.value = ''
  settingsError.value = ''
  try {
    const json = await exportSettingsBackupFile()
    downloadTextFile(`twilight-echo-settings-${new Date().toISOString().slice(0, 10)}.json`, json)
    settingsNotice.value = '设置备份已导出'
  } catch (err) {
    settingsError.value = err instanceof Error ? err.message : String(err)
  }
}

function importSettingsBackup(): void {
  importSettingsInputRef.value?.click()
}

async function handleSettingsBackupSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!window.confirm('导入设置备份会覆盖当前设置。确认继续？')) return
  settingsNotice.value = ''
  settingsError.value = ''
  try {
    await importSettingsBackupFile(await file.text())
    await refreshShortcutStatuses()
    settingsNotice.value = '设置备份已导入'
  } catch (err) {
    settingsError.value = err instanceof Error ? err.message : String(err)
  }
}

async function confirmClearCache(): Promise<void> {
  if (
    !window.confirm(
      `确认清理缓存？\n\n当前估算：${formattedCacheSize.value}\n将删除封面、歌词、元数据和可复用流媒体缓存。用户固定的离线下载不会被删除。此操作不可恢复。`
    )
  ) {
    return
  }
  await clearCache()
}

async function confirmClearBpmAnalysisCache(): Promise<void> {
  if (
    !window.confirm(
      `确认清理 BPM 分析缓存？\n\n当前估算：${formattedBpmAnalysisCacheSize.value}\n已分析的歌曲下次播放时会重新后台分析。此操作不可恢复。`
    )
  ) {
    return
  }
  await clearBpmAnalysisCache()
  clearBpmAnalysisFromPlaybackState()
}

async function confirmClearLoudnessAnalysisCache(): Promise<void> {
  if (
    !window.confirm(
      `确认清理 Loudnorm / 响度分析缓存？\n\n当前估算：${formattedLoudnessAnalysisCacheSize.value}\n已测量的响度下次播放时会重新后台分析。此操作不可恢复。`
    )
  ) {
    return
  }
  await clearLoudnessAnalysisCache()
}

/**
 * The export now writes a readable Markdown report next to the raw JSON, so the
 * notice offers to reveal it instead of telling the user to find and forward a
 * file they cannot read. A blocking `window.alert` was also the only modal in
 * this flow; the toast host already handles this kind of confirmation.
 */
async function exportAudioDiagnostics(): Promise<void> {
  try {
    const result = await window.api.audioEngine.exportDiagnostics()
    if (!result.filePath) return
    const savedPath = result.filePath
    pushNotice({
      kind: 'success',
      message: `${t('diagnostics.export.savedNotice')}\n${savedPath}`,
      action: {
        label: t('action.openFolder'),
        run: () => void window.api.shell.showItemInFolder(savedPath)
      },
      durationMs: 12000
    })
  } catch (error) {
    pushNotice({ kind: 'error', message: errorText(error, 'diagnostics.export.failed') })
  }
}

const SETTINGS_SECTION_SCROLL_OFFSET = 24

function scrollPageToElement(
  target: HTMLElement,
  options: { block?: 'start' | 'center'; behavior?: ScrollBehavior } = {}
): void {
  const page = pageRef.value
  if (!page) return

  const block = options.block ?? 'start'
  const behavior = scrollMotionBehavior(
    options.behavior ?? 'smooth',
    Boolean(page.querySelector(':focus-visible'))
  )
  const pageRect = page.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const targetTop = targetRect.top - pageRect.top + page.scrollTop
  const navigation = page.querySelector<HTMLElement>('.settings-preview-nav')
  const scrollOffset =
    SETTINGS_SECTION_SCROLL_OFFSET +
    (navigation && navigation.getBoundingClientRect().right > targetRect.left
      ? navigation.getBoundingClientRect().height
      : 0)
  const maxScrollTop = Math.max(0, page.scrollHeight - page.clientHeight)
  const category = target.closest<HTMLElement>('.preview-section')
  const categoryTop = category
    ? category.getBoundingClientRect().top - pageRect.top + page.scrollTop - scrollOffset
    : 0
  const nextTop =
    block === 'center'
      ? targetTop -
        scrollOffset -
        Math.max(0, (page.clientHeight - scrollOffset - targetRect.height) / 2)
      : targetTop - scrollOffset

  page.scrollTo({
    // Keep early rows with their category heading.
    top: Math.max(0, Math.min(maxScrollTop, Math.max(categoryTop, nextTop))),
    behavior
  })
}

function scrollToSection(section: SectionKey): void {
  const revision = ++settingsNavigationRevision
  settingsSearchQuery.value = ''
  settingsNotice.value = ''
  highlightSettingItem(null)
  activeSection.value = section
  void nextTick(() => {
    if (revision === settingsNavigationRevision)
      pageRef.value?.scrollTo({ top: 0, behavior: 'instant' })
  })
  revealActiveNavigationItem()
}

function revealActiveNavigationItem(): void {
  void nextTick(() => {
    const strip = pageRef.value?.querySelector<HTMLElement>('.settings-nav-categories')
    const item = strip?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!strip || !item || !strip.getClientRects().length) return
    const containerRect = strip.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    if (itemRect.top < containerRect.top) strip.scrollTop += itemRect.top - containerRect.top
    else if (itemRect.bottom > containerRect.bottom)
      strip.scrollTop += itemRect.bottom - containerRect.bottom
    if (itemRect.left < containerRect.left) strip.scrollLeft += itemRect.left - containerRect.left
    else if (itemRect.right > containerRect.right)
      strip.scrollLeft += itemRect.right - containerRect.right
  })
}
watch(activeSection, revealActiveNavigationItem)

function onCategoryKeydown(event: KeyboardEvent, section: SectionKey): void {
  const index = sections.findIndex((item) => item.key === section)
  let nextIndex: number
  if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = sections.length - 1
  else if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
    nextIndex = (index + 1) % sections.length
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
    nextIndex = (index - 1 + sections.length) % sections.length
  else return
  event.preventDefault()
  const next = sections[nextIndex].key
  scrollToSection(next)
  void nextTick(() => {
    pageRef.value
      ?.querySelector<HTMLElement>(`[data-settings-category="${next}"]`)
      ?.focus({ preventScroll: true })
    revealActiveNavigationItem()
  })
}

function onCategorySelect(event: Event): void {
  scrollToSection(normalizeSettingsSection((event.target as HTMLSelectElement).value))
}

async function applyNavigationTarget(): Promise<void> {
  if (!pageRef.value) return
  const revision = ++settingsNavigationRevision
  settingsNotice.value = ''
  const target = props.navigationTarget
  const legacy =
    props.initialSection && Object.hasOwn(LEGACY_SETTINGS_TARGETS, props.initialSection)
      ? LEGACY_SETTINGS_TARGETS[props.initialSection as keyof typeof LEGACY_SETTINGS_TARGETS]
      : null
  const anchor = target?.anchor ?? (!target?.entry ? legacy?.anchor : undefined)
  if (anchor) {
    activeSection.value = normalizeSettingsSection(props.initialSection)
    await nextTick()
    if (revision !== settingsNavigationRevision || !pageRef.value) return
    await disclosures.reveal(anchor)
    if (revision !== settingsNavigationRevision || !pageRef.value) return
    const element = pageRef.value.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)
    if (element) {
      if (element instanceof HTMLDetailsElement) element.open = true
      await settleSettingsNavigation(element)
      if (revision !== settingsNavigationRevision || !pageRef.value) return
      scrollPageToElement(element, { block: 'center' })
      focusSetting(element)
      return
    }
  }
  if (target?.entry) await scrollToSearchResult(target.entry)
  else scrollToSection(normalizeSettingsSection(props.initialSection))
}

watch([() => props.initialSection, () => props.navigationTarget], applyNavigationTarget, {
  flush: 'post'
})

let settingsNavigationRevision = 0
async function settleSettingsNavigation(scope: HTMLElement | null): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const animations =
    scope?.getAnimations({ subtree: true }).filter((animation) => {
      const timing = animation.effect?.getComputedTiming()
      return timing && timing.iterations !== Infinity && Number(timing.duration) <= 300
    }) ?? []
  // Offscreen CSS transitions can remain pending until their surface is painted.
  // Bound the layout wait to the disclosure duration, and ignore unrelated UI.
  if (animations.length) {
    let timer: number | undefined
    await Promise.race([
      Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, 300)
      })
    ])
    window.clearTimeout(timer)
  }
}

function focusSetting(target: HTMLElement): void {
  const selector =
    'summary, button:not(:disabled), select:not(:disabled), input:not(:disabled):not([readonly]), [tabindex="0"]'
  const control = [
    target,
    target.closest<HTMLElement>(selector),
    ...target.querySelectorAll<HTMLElement>(selector)
  ].find(
    (element) =>
      element?.matches(selector) && element.getClientRects().length && !element.closest('[inert]')
  )
  if (control) control.focus({ preventScroll: true })
  else {
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
}

async function scrollToSearchResult(input: SettingsSearchEntry): Promise<void> {
  const revision = ++settingsNavigationRevision
  const entry = resolveSettingsSearchEntry(input)
  settingsSearchQuery.value = ''
  settingsNotice.value = ''
  activeSection.value = normalizeSettingsSection(entry.section)
  revealActiveNavigationItem()
  if (entry.appearanceArea) {
    openAppearanceEditor(entry.appearanceArea)
    return
  }
  await nextTick()
  if (revision !== settingsNavigationRevision || !pageRef.value) return
  if (entry.disclosureId) await disclosures.reveal(entry.disclosureId)
  await settleSettingsNavigation(
    entry.disclosureId
      ? (pageRef.value?.querySelector<HTMLElement>(`#${CSS.escape(entry.disclosureId)}`) ?? null)
      : null
  )
  if (revision !== settingsNavigationRevision || !pageRef.value) return
  const sectionEl = pageRef.value.querySelector<HTMLElement>(
    `#${normalizeSettingsSection(entry.section)}`
  )
  if (!sectionEl) return
  const exact = findSettingItem(sectionEl, entry)
  const fallback = entry.fallbackId
    ? findSettingItem(sectionEl, { ...entry, id: entry.fallbackId })
    : null
  const group = entry.disclosureId
    ? sectionEl.querySelector<HTMLElement>(`#${CSS.escape(entry.disclosureId)}`)
    : null
  const target =
    exact?.getClientRects().length && !exact.closest('[inert]')
      ? exact
      : fallback?.getClientRects().length
        ? fallback
        : (group ?? sectionEl)
  if (target !== exact)
    settingsNotice.value =
      entry.fallbackReason ?? `“${entry.title}”需要先启用或配置相关功能，请查看此处的说明。`
  else {
    const reason = exact.querySelector<HTMLElement>(':disabled[title]')?.title
    if (reason) settingsNotice.value = `“${entry.title}”：${reason}。`
  }
  scrollPageToElement(target, { block: target === sectionEl ? 'start' : 'center' })
  highlightSettingItem(target === sectionEl ? null : target)
  focusSetting(target)
}

function findSettingItem(sectionEl: HTMLElement, entry: SettingsSearchEntry): HTMLElement | null {
  if (entry.id)
    return sectionEl.querySelector<HTMLElement>(
      `[data-setting-id="${CSS.escape(entry.id)}"], #${CSS.escape(entry.id)}`
    )
  const matchText = (entry.match ?? entry.title).trim().toLowerCase()
  // 优先匹配 .setting-item（常规设置项）
  const settingItems = sectionEl.querySelectorAll<HTMLElement>('.setting-item')
  for (const item of settingItems) {
    const copy = item.querySelector('.setting-copy')
    const strong = copy?.querySelector('strong')
    if (strong && strong.textContent?.trim().toLowerCase().includes(matchText)) {
      return item
    }
  }
  // 回退：匹配 h3 区块标题（如 about 分区）
  const headings = sectionEl.querySelectorAll<HTMLElement>('h3')
  for (const heading of headings) {
    if (heading.textContent?.trim().toLowerCase().includes(matchText)) {
      return heading
    }
  }
  // 再回退：匹配任意 strong / span / button 文本（about 的更新卡、赞助卡等）
  const fallbacks = sectionEl.querySelectorAll<HTMLElement>('strong, span, button')
  for (const el of fallbacks) {
    if (el.textContent?.trim().toLowerCase().includes(matchText)) {
      return el
    }
  }
  return null
}

let searchHighlightTimer: number | null = null

function highlightSettingItem(item: HTMLElement | null): void {
  if (searchHighlightTimer !== null) {
    window.clearTimeout(searchHighlightTimer)
    searchHighlightTimer = null
  }
  pageRef.value?.querySelectorAll('.search-target-flash').forEach((el) => {
    el.classList.remove('search-target-flash')
  })
  if (!item) return
  item.classList.add('search-target-flash')
  searchHighlightTimer = window.setTimeout(() => {
    item.classList.remove('search-target-flash')
    searchHighlightTimer = null
  }, 2200)
}

function moveSearchSelection(delta: number): void {
  const results = filteredSearchResults.value
  if (results.length === 0) return
  const next = activeSearchIndex.value + delta
  activeSearchIndex.value = ((next % results.length) + results.length) % results.length
  void nextTick(() => {
    pageRef.value
      ?.querySelector(`#settings-search-result-${activeSearchIndex.value}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

function handleSettingsSearchEnter(): void {
  const results = filteredSearchResults.value
  if (results.length === 0) return
  const target =
    activeSearchIndex.value >= 0 && activeSearchIndex.value < results.length
      ? results[activeSearchIndex.value]
      : results[0]
  scrollToSearchResult(target)
}

function clearSettingsSearch(): void {
  settingsSearchQuery.value = ''
  activeSearchIndex.value = -1
  pageRef.value?.querySelector<HTMLInputElement>('#settings-search-input')?.focus()
}

async function refreshShortcutStatuses(): Promise<void> {
  try {
    shortcutStatuses.value = await getShortcutStatuses()
  } catch (err) {
    shortcutStatuses.value = []
    settingsError.value = err instanceof Error ? err.message : String(err)
  }
}

let settingsDisposed = false
onMounted(async () => {
  // Select the initial category before asynchronous native startup completes.
  void applyNavigationTarget()
  await Promise.all([loadSettings(), refreshAudioOutputState(), themeStore.load()])
  if (settingsDisposed) return
  await Promise.all([
    refreshCacheSize(),
    refreshBpmAnalysisCacheSize(),
    refreshLoudnessAnalysisCacheSize()
  ])
  if (settingsDisposed) return
  await refreshShortcutStatuses()
  if (settingsDisposed) return
  await syncExtensions()
  if (settingsDisposed) return
  await refreshLibraryWatcherStatus()
  if (settingsDisposed) return
  libraryWatcherStatusTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void refreshLibraryWatcherStatus()
  }, 5_000)
  await nextTick()
  if (settingsDisposed) return
})

onBeforeUnmount(() => {
  settingsDisposed = true
  ++settingsNavigationRevision
  if (searchHighlightTimer !== null) window.clearTimeout(searchHighlightTimer)
  if (libraryWatcherStatusTimer !== null) {
    window.clearInterval(libraryWatcherStatusTimer)
    libraryWatcherStatusTimer = null
  }
})
</script>

<template>
  <main ref="pageRef" class="settings-preview-page" data-settings-layout="categories">
    <input
      ref="importSettingsInputRef"
      class="visually-hidden-file-input"
      type="file"
      accept="application/json,.json"
      @change="handleSettingsBackupSelected"
    />
    <div class="settings-preview-layout">
      <nav
        class="settings-preview-nav"
        aria-label="设置分区"
        @pointerdown="setNavigationPressOrigin"
      >
        <div class="settings-nav-search-wrap">
          <div class="settings-search-box settings-nav-search">
            <i class="pi pi-search"></i>
            <input
              id="settings-search-input"
              v-model="settingsSearchQuery"
              type="text"
              class="settings-search-input"
              placeholder="搜索设置"
              aria-label="搜索设置"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="hasSettingsSearchResults"
              :aria-controls="hasSettingsSearchResults ? 'settings-search-results' : undefined"
              :aria-activedescendant="
                hasSettingsSearchResults && activeSearchIndex >= 0
                  ? `settings-search-result-${activeSearchIndex}`
                  : undefined
              "
              @focus="activeSearchIndex = filteredSearchResults.length > 0 ? 0 : -1"
              @keydown.down.prevent="moveSearchSelection(1)"
              @keydown.up.prevent="moveSearchSelection(-1)"
              @keydown.enter.prevent="handleSettingsSearchEnter"
              @keydown.esc.stop.prevent="clearSettingsSearch"
            />
            <button
              v-if="settingsSearchQuery"
              type="button"
              class="settings-search-clear"
              @click="clearSettingsSearch"
              aria-label="清除搜索"
            >
              <i class="pi pi-times"></i>
            </button>
          </div>
          <div
            v-if="hasSettingsSearchResults"
            id="settings-search-results"
            class="settings-nav-results"
            role="listbox"
            aria-label="搜索结果"
          >
            <button
              v-for="(result, index) in filteredSearchResults"
              :key="`${result.section}:${result.title}`"
              :id="`settings-search-result-${index}`"
              type="button"
              tabindex="-1"
              role="option"
              :aria-selected="activeSearchIndex === index"
              :class="{ active: activeSearchIndex === index }"
              @mouseenter="activeSearchIndex = index"
              @click="scrollToSearchResult(result)"
            >
              <i :class="sections.find((section) => section.key === result.section)?.icon"></i>
              <span class="settings-nav-result-title">{{ result.title }}</span>
              <small>{{ sections.find((section) => section.key === result.section)?.label }}</small>
            </button>
          </div>
          <div v-else-if="hasSettingsSearchNoResults" class="settings-nav-empty" role="status">
            没有找到匹配的设置
          </div>
        </div>
        <select
          class="settings-category-select preview-select"
          aria-label="设置分类"
          :value="activeSection"
          @change="onCategorySelect"
        >
          <option v-for="section in sections" :key="section.key" :value="section.key">
            {{ section.label }}
          </option>
        </select>
        <div class="settings-nav-categories">
          <button
            v-for="section in sections"
            :key="section.key"
            type="button"
            class="preview-nav-item"
            :class="{ active: activeSection === section.key }"
            :aria-current="activeSection === section.key ? 'page' : undefined"
            :tabindex="activeSection === section.key ? 0 : -1"
            :data-settings-category="section.key"
            @keydown="onCategoryKeydown($event, section.key)"
            @click="scrollToSection(section.key)"
          >
            <i :class="section.icon"></i>
            <span>{{ section.label }}</span>
          </button>
        </div>
      </nav>

      <div class="settings-preview-stack">
        <header class="settings-page-header">
          <h1 class="settings-page-title">{{ activeSectionInfo.label }}</h1>
          <p class="settings-page-description">{{ activeSectionInfo.description }}</p>
        </header>
        <section
          v-if="settingsNotice || settingsError"
          class="settings-command-bar"
          aria-live="polite"
        >
          <div v-if="settingsNotice" class="settings-inline-notice">{{ settingsNotice }}</div>
          <div v-if="settingsError" class="settings-inline-error">{{ settingsError }}</div>
        </section>

        <div v-if="restartRequired" class="restart-banner restart-banner-sticky" role="status">
          <div>
            <strong>需要重启以应用更改</strong>
            <span>{{ restartReasons.join('、') }}</span>
          </div>
          <button class="brand-soft-button" type="button" @click="relaunch">
            <i class="pi pi-refresh"></i>
            立即重启
          </button>
        </div>

        <GeneralSettingsSection
          v-show="activeSection === 'general'"
          :track-activation-mode-options="trackActivationModeOptions"
          :startup-home-page-options="startupHomePageOptions"
          :toggle-setting="toggleSetting"
          :set-track-activation-mode="setTrackActivationMode"
          :set-startup-home-page="setStartupHomePage"
          :set-close-behavior="setCloseBehavior"
          @reopen-onboarding="emit('reopenOnboarding')"
        />
        <AppearanceSettingsSection
          v-show="activeSection === 'appearance'"
          @open-theme-studio="emit('openThemeStudio')"
          @open-theme-workshop="emit('openThemeWorkshop')"
        />
        <section
          v-show="activeSection === 'playback'"
          id="playback"
          class="glass-card preview-section"
        >
          <div class="section-title-row">
            <i class="pi pi-volume-up" aria-hidden="true" />
            <h2>播放与音效</h2>
          </div>
          <p class="settings-section-description">调整播放习惯、输出设备和声音处理。</p>
          <PlaybackSettingsSection
            :auto-analyze-bpm="settings.autoAnalyzeBpm"
            @toggle-auto-analyze-bpm="toggleAutoAnalyzeBpm"
          /><DspSettingsSection
            @open-equalizer="emit('openEqualizer')"
            @open-dsp-rack="emit('openDspRack')"
          />
        </section>
        <section v-show="activeSection === 'lyrics'" id="lyrics" class="glass-card preview-section">
          <div class="section-title-row">
            <i class="pi pi-align-left" aria-hidden="true" />
            <h2>歌词</h2>
          </div>
          <p class="settings-section-description">设置歌词来源与播放页、桌面上的显示方式。</p>
          <div class="section-block">
            <h3>歌词来源</h3>
            <div class="setting-list">
              <div
                data-setting-id="lyrics-fallback"
                id="setting-lyrics-fallback"
                class="setting-item"
              >
                <div class="setting-copy">
                  <strong>在线歌词回退</strong>
                  <span>本地歌词不可用时尝试在线搜索，找到后自动显示。默认关闭。</span>
                </div>
                <button
                  type="button"
                  class="toggle-switch"
                  :class="{
                    active: settings.onlineLyricsFallback,
                    inactive: !settings.onlineLyricsFallback
                  }"
                  role="switch"
                  aria-label="在线歌词回退"
                  :aria-checked="settings.onlineLyricsFallback"
                  @click="toggleSetting('onlineLyricsFallback')"
                ></button>
              </div>
            </div>
          </div>
          <LyricsStyleSettings />
          <DesktopLyricsSettingsSection
            :desktop-lyrics="settings.desktopLyrics"
            @toggle="toggleDesktopLyrics"
            @update="updateDesktopLyrics"
          />
        </section>
        <LibrarySettingsSection
          v-show="activeSection === 'library'"
          :library-watcher-status="libraryWatcherStatus"
          :library-scan-status="libraryScanStatus"
          :library-scan-is-active="libraryScanIsActive"
          :library-scan-progress-text="libraryScanProgressText"
          :library-metadata-enrichment-text="libraryMetadataEnrichmentText"
          :library-metadata-enrichment-is-active="libraryMetadataEnrichmentIsActive"
          :library-metadata-enrichment-error="
            libraryMetadataEnrichmentStatus.state === 'failed' ? libraryMetadataEnrichmentText : ''
          "
          :library-reset-message="libraryResetMessage"
          :library-scan-command-error="libraryScanCommandError"
          :library-reset-pending="libraryResetPending"
          :add-library-folder="addLibraryFolder"
          :remove-library-folder="removeLibraryFolder"
          :choose-download-folder="chooseDownloadFolder"
          :reset-download-folder="resetDownloadFolder"
          :toggle-setting="toggleSetting"
          :set-genre-separators="setGenreSeparators"
          :watcher-state-label="watcherStateLabel"
          :watcher-mode-label="watcherModeLabel"
          :format-watcher-time="formatWatcherTime"
          :run-full-library-scan="runFullLibraryScan"
          :pause-active-library-scan="pauseActiveLibraryScan"
          :resume-active-library-scan="resumeActiveLibraryScan"
          :cancel-active-library-scan="cancelActiveLibraryScan"
          :reset-local-library="resetLocalLibrary"
          :cancel-active-library-metadata-enrichment="cancelActiveLibraryMetadataEnrichment"
        >
          <CacheSettingsSection
            :active-cache-path="activeCachePath"
            :cache-policy="settings.cachePolicy"
            :streaming-audio-cache-policy-options="streamingAudioCachePolicyOptions"
            :formatted-bpm-analysis-cache-size="formattedBpmAnalysisCacheSize"
            :clearing-bpm-analysis-cache="clearingBpmAnalysisCache"
            :formatted-loudness-analysis-cache-size="formattedLoudnessAnalysisCacheSize"
            :clearing-loudness-analysis-cache="clearingLoudnessAnalysisCache"
            :formatted-cache-size="formattedCacheSize"
            :clearing-cache="clearingCache"
            @choose-cache-folder="chooseCacheFolder"
            @reset-cache-folder="resetCacheFolder"
            @toggle-cache-artifact="toggleCacheArtifact"
            @set-streaming-audio-cache-policy="setStreamingAudioCachePolicy"
            @confirm-clear-bpm-analysis-cache="confirmClearBpmAnalysisCache"
            @confirm-clear-loudness-analysis-cache="confirmClearLoudnessAnalysisCache"
            @confirm-clear-cache="confirmClearCache"
          />
        </LibrarySettingsSection>
        <ConnectionsSettingsSection
          v-show="activeSection === 'connections'"
          :update-settings="updateSettings"
          :toggle-setting="toggleSetting"
        >
          <ShortcutsSettingsSection
            :global-shortcuts="settings.globalShortcuts"
            :shortcut-statuses="shortcutStatuses"
            :shortcut-bindings="settings.globalShortcutBindings"
            @update:global-shortcuts="toggleGlobalShortcuts"
            @update:shortcut-bindings="onUpdateShortcutBindings"
          />
        </ConnectionsSettingsSection>
        <SystemSettingsSection
          v-show="activeSection === 'system'"
          :plugin-settings-panels="pluginSettingsPanels"
          :plugin-settings-result="pluginSettingsResult"
          :plugin-settings-error="pluginSettingsError"
          :plugin-settings-forms="pluginSettingsForms"
          :plugin-settings-values="pluginSettingsValues"
          :running-plugin-settings-command="runningPluginSettingsCommand"
          :plugin-panel-state-key="pluginPanelStateKey"
          :toggle-setting="toggleSetting"
          :export-settings-backup="exportSettingsBackup"
          :import-settings-backup="importSettingsBackup"
          :reset-settings-group="resetSettingsGroup"
          :run-plugin-settings-panel="runPluginSettingsPanel"
          :set-plugin-settings-field="setPluginSettingsField"
          :submit-plugin-settings-form="submitPluginSettingsForm"
        >
          <AboutSettingsSection
            :app-version="appVersion"
            @export-audio-diagnostics="exportAudioDiagnostics"
          />
        </SystemSettingsSection>
      </div>
    </div>
  </main>
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

.plugin-settings-field {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(220px, 1fr);
  align-items: center;
  gap: 16px;
}

.plugin-settings-field > span {
  color: var(--te-settings-text);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
}

.plugin-settings-field b {
  color: var(--te-danger, #ef4444);
}

.plugin-settings-field .preview-select {
  width: 100%;
  max-width: none;
}

.plugin-settings-submit {
  justify-self: end;
}

@media (max-width: 760px) {
  .plugin-settings-field {
    grid-template-columns: 1fr;
    gap: 7px;
  }
}
</style>

<style src="./settings-page/SettingsPage.css"></style>

<style>
html[data-theme='dark'] .settings-preview-page {
  /* This block is emitted after SettingsPage.css. The overlay root is the
     single settings wallpaper painter, so the page stays transparent in every
     theme — a second image copy here would drift into split bands again. */
  background: transparent;
  color: var(--te-settings-text);
}

html[data-theme='dark'] .settings-preview-page::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.28);
}

html[data-theme='dark'] .settings-preview-page::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.42);
}

html[data-theme='dark'] .settings-preview-page .preview-nav-item {
  color: var(--te-text-muted);
}

html[data-theme='dark'] .settings-preview-page .preview-nav-item:hover,
html[data-theme='dark'] .settings-preview-page .preview-nav-item.active {
  border-color: rgba(var(--te-primary-rgb), 0.28);
  background: var(--te-card-bg);
  color: var(--te-text);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
}

html[data-theme='dark'] .settings-preview-page .glass-card,
html[data-theme='dark'] .settings-preview-page .device-panel,
html[data-theme='dark'] .settings-preview-page .device-card,
html[data-theme='dark'] .settings-preview-page .accordion-preview,
html[data-theme='dark'] .settings-preview-page .dsp-module-card,
html[data-theme='dark'] .settings-preview-page .dsp-meter,
html[data-theme='dark'] .settings-preview-page .folder-chip,
html[data-theme='dark'] .settings-preview-page .preview-select,
html[data-theme='dark'] .settings-preview-page .preview-select.wide,
html[data-theme='dark'] .settings-preview-page .select-control,
html[data-theme='dark'] .settings-preview-page .number-input,
html[data-theme='dark'] .settings-preview-page .path-control input,
html[data-theme='dark'] .settings-preview-page .plugin-empty,
html[data-theme='dark'] .settings-preview-page .range-pill,
html[data-theme='dark'] .settings-preview-page .update-card,
html[data-theme='dark'] .settings-preview-page .about-links button,
html[data-theme='dark'] .settings-preview-page .output-diagnostic-panel,
html[data-theme='dark'] .settings-preview-page .preset-btn,
html[data-theme='dark'] .settings-preview-page .background-accordion,
html[data-theme='dark'] .settings-preview-page .background-editor,
html[data-theme='dark'] .settings-preview-page .background-kind-toggle,
html[data-theme='dark'] .settings-preview-page .color-field,
html[data-theme='dark'] .settings-preview-page .page-background-row,
html[data-theme='dark'] .settings-preview-page .page-background-row.expanded,
html[data-theme='dark'] .settings-preview-page .inherit-toggle,
html[data-theme='dark'] .settings-preview-page .pill-action.ghost,
html[data-theme='dark'] .settings-preview-page .settings-search-box,
html[data-theme='dark'] .settings-preview-page .settings-nav-search,
html[data-theme='dark'] .settings-preview-page .read-only-pill {
  border-color: var(--te-card-border);
  background: var(--te-settings-control-bg);
  color: rgba(226, 232, 240, 0.9);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
}

html[data-theme='dark'] .settings-preview-page .folder-chip,
html[data-theme='dark'] .settings-preview-page .path-control input {
  box-shadow: none;
}

html[data-theme='dark'] .settings-preview-page .settings-nav-results,
html[data-theme='dark'] .settings-preview-page .settings-nav-empty {
  border-color: var(--te-card-border);
  background: var(--te-card-bg);
  color: rgba(226, 232, 240, 0.9);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.42);
}

html[data-theme='dark'] .settings-preview-page .settings-nav-results button {
  color: rgba(226, 232, 240, 0.88);
}

html[data-theme='dark'] .settings-preview-page .settings-nav-results button:hover,
html[data-theme='dark'] .settings-preview-page .settings-nav-results button.active {
  background: rgba(var(--te-primary-rgb), 0.16);
  color: var(--te-primary-300);
}

html[data-theme='dark'] .settings-preview-page .settings-nav-results button small {
  color: rgba(148, 163, 184, 0.72);
}

html[data-theme='dark'] .settings-preview-page .accordion-head,
html[data-theme='dark'] .settings-preview-page .accordion-body,
html[data-theme='dark'] .settings-preview-page .advanced-grid,
html[data-theme='dark'] .settings-preview-page .wasapi-push-row {
  border-color: var(--te-card-border);
  background: transparent;
}

html[data-theme='dark'] .settings-preview-page .setting-list hr,
html[data-theme='dark'] .settings-preview-page .about-section hr {
  background: var(--te-card-border);
}

html[data-theme='dark'] .settings-preview-page .segmented-control,
html[data-theme='dark'] .settings-preview-page .theme-segment {
  border-color: var(--te-card-border);
  background: var(--te-subtle-bg);
  box-shadow: none;
}

html[data-theme='dark'] .settings-preview-page .segmented-control button,
html[data-theme='dark'] .settings-preview-page .theme-segment button,
html[data-theme='dark'] .settings-preview-page .background-options button,
html[data-theme='dark'] .settings-preview-page .background-accordion-trigger,
html[data-theme='dark'] .settings-preview-page .background-kind-toggle button,
html[data-theme='dark'] .settings-preview-page .page-background-header,
html[data-theme='dark'] .settings-preview-page .settings-search-box .settings-search-input {
  color: var(--te-settings-text-muted);
}

html[data-theme='dark'] .settings-preview-page .segmented-control button.active,
html[data-theme='dark'] .settings-preview-page .theme-segment button.active,
html[data-theme='dark'] .settings-preview-page .background-kind-toggle button.active {
  background: var(--te-card-bg);
  color: var(--te-text);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
}

html[data-theme='dark'] .settings-preview-page .dsp-signal-chain {
  border-color: var(--te-card-border);
  background: var(--te-subtle-bg);
}

html[data-theme='dark'] .settings-preview-page .device-card:hover,
html[data-theme='dark'] .settings-preview-page .device-card.active {
  border-color: rgba(var(--te-primary-rgb), 0.42);
  background: rgba(var(--te-primary-rgb), 0.1);
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.32);
}

html[data-theme='dark'] .settings-preview-page .device-card > i {
  display: inline-flex;
  height: 34px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: #07080a;
  color: var(--te-primary-400);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 10px 24px rgba(0, 0, 0, 0.26);
}

html[data-theme='dark'] .settings-preview-page .device-capability-chip {
  border-color: rgba(255, 255, 255, 0.08);
  background: #07080a;
  color: rgba(203, 213, 225, 0.86);
}

html[data-theme='dark'] .settings-preview-page .device-capability-chip.verified {
  border-color: rgba(34, 197, 94, 0.26);
  background: rgba(20, 83, 45, 0.34);
  color: #86efac;
}

html[data-theme='dark'] .settings-preview-page .device-capability-chip.runtime {
  border-color: rgba(var(--te-primary-rgb), 0.28);
  background: rgba(var(--te-primary-rgb), 0.16);
  color: var(--te-primary-300);
}

html[data-theme='dark'] .settings-preview-page .device-capability-chip.unsupported {
  border-color: rgba(248, 113, 113, 0.24);
  background: rgba(127, 29, 29, 0.3);
  color: #fca5a5;
}

html[data-theme='dark'] .settings-preview-page .device-capability-chip.unknown {
  border-color: rgba(148, 163, 184, 0.16);
  background: rgba(15, 23, 42, 0.82);
  color: rgba(203, 213, 225, 0.78);
}

html[data-theme='dark'] .settings-preview-page .device-card > b {
  border: 1px solid rgba(var(--te-primary-rgb), 0.32);
  background: #07080a;
  color: var(--te-primary-300);
}

html[data-theme='dark'] .settings-preview-page .section-title-row h2,
html[data-theme='dark'] .settings-preview-page .setting-copy strong,
html[data-theme='dark'] .settings-preview-page .accordion-head strong,
html[data-theme='dark'] .settings-preview-page .device-panel-head h3,
html[data-theme='dark'] .settings-preview-page .device-card span,
html[data-theme='dark'] .settings-preview-page .dsp-meter strong,
html[data-theme='dark'] .settings-preview-page .mini-setting strong,
html[data-theme='dark'] .settings-preview-page .plugin-empty strong,
html[data-theme='dark'] .settings-preview-page .about-copy h3,
html[data-theme='dark'] .settings-preview-page .update-card strong,
html[data-theme='dark'] .settings-preview-page .background-editor-head strong,
html[data-theme='dark'] .settings-preview-page .page-background-copy strong,
html[data-theme='dark'] .settings-preview-page .signal-node.active .signal-node-name {
  color: var(--te-settings-text);
}

html[data-theme='dark'] .settings-preview-page .setting-copy span,
html[data-theme='dark'] .settings-preview-page .accordion-head span,
html[data-theme='dark'] .settings-preview-page .advanced-grid label span,
html[data-theme='dark'] .settings-preview-page .decode-grid label span,
html[data-theme='dark'] .settings-preview-page .dsp-meter small,
html[data-theme='dark'] .settings-preview-page .mini-setting span,
html[data-theme='dark'] .settings-preview-page .setting-hint,
html[data-theme='dark'] .settings-preview-page .folder-chip,
html[data-theme='dark'] .settings-preview-page .folder-empty-hint,
html[data-theme='dark'] .settings-preview-page .device-card small,
html[data-theme='dark'] .settings-preview-page .plugin-empty,
html[data-theme='dark'] .settings-preview-page .range-pill span,
html[data-theme='dark'] .settings-preview-page .about-copy p,
html[data-theme='dark'] .settings-preview-page .update-card span,
html[data-theme='dark'] .settings-preview-page .background-editor-head span,
html[data-theme='dark'] .settings-preview-page .background-image-actions small,
html[data-theme='dark'] .settings-preview-page .color-field span,
html[data-theme='dark'] .settings-preview-page .color-field code,
html[data-theme='dark'] .settings-preview-page .page-background-copy span,
html[data-theme='dark'] .settings-preview-page .page-background-state,
html[data-theme='dark'] .settings-preview-page .signal-node-name,
html[data-theme='dark'] .settings-preview-page .crossfade-group,
html[data-theme='dark'] .settings-preview-page .crossfeed-percent,
html[data-theme='dark'] .settings-preview-page .diagnostic-chain,
html[data-theme='dark'] .settings-preview-page .diagnostic-meta,
html[data-theme='dark'] .settings-preview-page .mini-highres small {
  color: var(--te-settings-text-muted);
}

html[data-theme='dark'] .settings-preview-page .background-options span {
  border-color: var(--te-card-border);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
}

html[data-theme='dark'] .settings-preview-page .background-options button.active small {
  color: var(--te-primary-300);
}

html[data-theme='dark'] .settings-preview-page .signal-node-circle {
  border-color: rgba(148, 163, 184, 0.34);
  background: var(--te-card-bg);
}

html[data-theme='dark'] .settings-preview-page .signal-node-circle.active {
  border-color: var(--brand-500);
  background: rgba(var(--te-primary-rgb), 0.14);
}

html[data-theme='dark'] .settings-preview-page .signal-line {
  border-bottom-color: rgba(148, 163, 184, 0.34);
}

html[data-theme='dark'] .settings-preview-page .mini-setting + .mini-setting,
html[data-theme='dark'] .settings-preview-page .accordion-body,
html[data-theme='dark'] .settings-preview-page .advanced-grid,
html[data-theme='dark'] .settings-preview-page .wasapi-push-row {
  border-top-color: var(--te-card-border);
}

html[data-theme='dark'] .settings-preview-page .muted-button,
html[data-theme='dark'] .settings-preview-page .soft-button,
html[data-theme='dark'] .settings-preview-page .icon-button,
html[data-theme='dark'] .settings-preview-page .brand-soft-button,
html[data-theme='dark'] .settings-preview-page .inherit-toggle,
html[data-theme='dark'] .settings-preview-page .dashed-button,
html[data-theme='dark'] .settings-preview-page .folder-empty-hint {
  border-color: var(--te-card-border);
  background: var(--te-settings-control-bg);
  color: var(--te-settings-text);
  box-shadow: none;
}

html[data-theme='dark'] .settings-preview-page .folder-empty-hint {
  border: 1px dashed var(--te-card-border);
  border-radius: 12px;
}

html[data-theme='dark'] .settings-preview-page .inherit-toggle.active {
  border-color: rgba(var(--te-primary-rgb), 0.34);
  background: rgba(var(--te-primary-rgb), 0.14);
  color: var(--te-primary-300);
}

html[data-theme='dark'] .settings-preview-page .dashed-button:hover,
html[data-theme='dark'] .settings-preview-page .brand-soft-button:hover,
html[data-theme='dark'] .settings-preview-page .preset-btn:hover,
html[data-theme='dark'] .settings-preview-page .settings-nav-results button.active {
  border-color: rgba(var(--te-primary-rgb), 0.34);
  background: rgba(var(--te-primary-rgb), 0.14);
  color: var(--te-primary-300);
}

html[data-theme='dark'] .settings-preview-page .restart-banner,
html[data-theme='dark'] .settings-preview-page .engine-warning,
html[data-theme='dark'] .settings-preview-page .compute-badge,
html[data-theme='dark'] .settings-preview-page .sponsor-card,
html[data-theme='dark'] .settings-preview-page .sponsor-pending {
  border-color: rgba(245, 158, 11, 0.28);
  background: rgba(245, 158, 11, 0.12);
  color: #fbbf24;
}

html[data-theme='dark'] .settings-preview-page .restart-banner strong,
html[data-theme='dark'] .settings-preview-page .sponsor-card h3 {
  color: #fde68a;
}

html[data-theme='dark'] .settings-preview-page .restart-banner span,
html[data-theme='dark'] .settings-preview-page .sponsor-card p {
  color: rgba(253, 230, 138, 0.78);
}

html[data-theme='dark'] .settings-preview-page .engine-error {
  border-color: rgba(248, 113, 113, 0.34);
  background: rgba(127, 29, 29, 0.26);
  color: #fca5a5;
}

.settings-preview-page .remote-control-panel .remote-pin-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}

.settings-preview-page .remote-pin {
  font-size: 1.35rem;
  letter-spacing: 0.28em;
  font-weight: 700;
  padding: 6px 12px;
  border-radius: 10px;
  background: rgba(var(--te-primary-rgb), 0.12);
}

.settings-preview-page .remote-url-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.settings-preview-page .remote-url-list .linkish {
  border: 0;
  background: transparent;
  color: var(--te-primary-600, #2563eb);
  cursor: pointer;
  padding: 0;
  text-align: left;
  font: inherit;
  text-decoration: underline;
  word-break: break-all;
}

.settings-preview-page .remote-error {
  display: block;
  margin-top: 8px;
  color: #f87171;
  font-size: 0.9rem;
}
</style>

<style src="./settings-page/SettingsLayout.css"></style>
