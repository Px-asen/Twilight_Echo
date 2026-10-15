<script setup lang="ts">
import SettingsDisclosure from './SettingsDisclosure.vue'
import SettingsGroup from './SettingsGroup.vue'
import { useSettingsDisclosure } from './settingsDisclosureRegistry.ts'
import { storeToRefs } from 'pinia'
import AudioDeviceProfilesPanel from '@renderer/components/settings-page/AudioDeviceProfilesPanel.vue'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useAudioOutputDspStore } from '../../stores/useAudioOutputDspStore'
import { usePlayerStore } from '../../stores/usePlayerStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  HIFI_STATUS_COPY,
  gaplessRuntimeStatusCopy,
  crossfadeBlockedReasonCopy,
  dsdRouteTargetsDistinctRoute,
  withDsdRoutePatch,
  type DsdRouteSettings
} from '../../../../shared/audioProcessingOptions.ts'
import { isDsdProxyDevice } from '../../../../shared/dsdProxyDrivers.ts'
import { resolveReasonCode } from '../../../../shared/audio/reasonCodes.ts'
import { useLocale } from '../../app/useLocale.ts'
import {
  normalizeAutoMixMode,
  normalizeAutoMixStemCacheMiB,
  normalizeAutoMixStemDevice,
  type AutoMixStemCapabilities,
  type AutoMixMode,
  type AutoMixStemInstallStatus,
  autoMixStemInstallBusy,
  autoMixStatusKeys,
  effectiveAutoMixMode,
  TWILIGHT_AUTOMIX_AVAILABLE,
  TWILIGHT_AUTOMIX_EVALUATION_AVAILABLE,
  TWILIGHT_AUTOMIX_RELEASE_READY
} from '../../../../shared/twilightAutoMix.ts'
import {
  type AudioCapabilitySupportState,
  type AudioDeviceOption,
  type AudioOutputId,
  type AudioProcessingSettings,
  type ChannelRoutingMode,
  type DsdOutputMode,
  type NcmPlaybackQuality,
  type OutputConfig,
  type PcmToDsdMode,
  type PlaybackResumeMode,
  type PreviousButtonAction
} from '../../types/settings'
import {
  bufferSizeOptions,
  dsdOutputModeOptions,
  ncmPlaybackQualityOptions,
  pcmToDsdModeOptions,
  playbackResumeOptions,
  previousButtonActionOptions,
  routingModeOptions,
  trackActivationModeOptions
} from './types.ts'

withDefaults(defineProps<{ autoAnalyzeBpm?: boolean; view?: 'all' | 'playback' | 'audio' }>(), {
  autoAnalyzeBpm: false,
  view: 'all'
})
const emit = defineEmits<{ toggleAutoAnalyzeBpm: [] }>()

const { settings, updateSettings } = useSettingsStore()
const { locale, t } = useLocale()
const audioOutputDspStore = useAudioOutputDspStore()
const playbackQueueStore = usePlayerStore()
const {
  exclusiveMode,
  audioOutput,
  audioDevice,
  audioOutputOptions,
  audioDeviceOptions,
  audioOutputDeviceOptions,
  audioProcessing,
  audioOutputConfig,
  audioOutputConfigApplyStatus,
  playbackInfo,
  outputInfo,
  audioEngineError
} = storeToRefs(audioOutputDspStore)

const { volume } = playbackQueueStore

const {
  toggleExclusiveMode,
  setAudioOutput,
  setAudioDevice,
  setAudioOutputConfig,
  setAudioProcessing,
  refreshAudioOutputState,
  toggleGapless
} = audioOutputDspStore

const { setVolume, setUnityVolume } = playbackQueueStore

const volumePercent = computed({
  get: () => Math.round(volume.value * 100),
  set: (value: number) => {
    setVolume(value / 100)
  }
})

const selectedAudioOutput = computed(() =>
  audioOutputOptions.value.find((option) => option.id === audioOutput.value)
)
const exclusiveAvailable = computed(() => selectedAudioOutput.value?.supportsExclusive ?? false)
const profileAttention = ref('')
function setProfileAttention(message: string): void {
  profileAttention.value = message
}
const exclusiveAutoReleaseApplying = ref(false)
const autoMixModeApplying = ref(false)
const stemCapabilities = ref<AutoMixStemCapabilities>({
  status: 'missing',
  cpu: false,
  gpu: false,
  packs: []
})
const stemChecking = ref(false)
const stemApplying = ref(false)
const stemInstallDialog = ref<HTMLDialogElement>()
const djModeDialog = ref<HTMLDialogElement>()
const enableStemsAfterInstall = ref(false)
function chooseStemInstall(): void {
  if (stemInstalling.value) return
  enableStemsAfterInstall.value = settings.value.autoMixStemMode === 'auto'
  stemInstallDialog.value?.showModal()
}
const stemInstallStatus = ref<AutoMixStemInstallStatus>({
  phase: 'idle',
  completedBytes: 0,
  totalBytes: 0
})
const stemInstalling = computed(() => autoMixStemInstallBusy(stemInstallStatus.value))
const stemInstallPercent = computed(() =>
  stemInstallStatus.value.totalBytes
    ? Math.min(
        100,
        Math.floor(
          (stemInstallStatus.value.completedBytes / stemInstallStatus.value.totalBytes) * 100
        )
      )
    : 0
)
const stemInstallText = computed(() => {
  const status = stemInstallStatus.value
  if (status.phase === 'idle') return ''
  if (status.phase === 'failed') return t(`automix.stems.install.error.${status.reason ?? 'io'}`)
  const text = t(`automix.stems.install.${status.phase}`)
  return text + (status.phase === 'extracting' ? ` ${stemInstallPercent.value}%` : '')
})
let stemInstallPoll: ReturnType<typeof setTimeout> | undefined
let stemComponentMounted = false
async function acceptStemInstallStatus(status: AutoMixStemInstallStatus): Promise<void> {
  if (!stemComponentMounted) return
  const wasReady = stemInstallStatus.value.phase === 'ready'
  stemInstallStatus.value = status
  if (status.phase === 'ready' && !wasReady) await detectStems(true)
}
async function pollStemInstall(): Promise<void> {
  if (!stemComponentMounted) return
  try {
    await acceptStemInstallStatus(await window.api.audioEngine.getAutoMixStemInstallStatus())
  } catch {
    /* The install invocation reports IPC failures to the user. */
  }
  if (stemComponentMounted && stemInstalling.value)
    stemInstallPoll = setTimeout(() => void pollStemInstall(), 400)
}
async function installStemPack(): Promise<void> {
  if (stemInstalling.value) return
  const enableAfterInstall = enableStemsAfterInstall.value
  stemInstallDialog.value?.close()
  stemInstallStatus.value = { phase: 'selecting', completedBytes: 0, totalBytes: 0 }
  clearTimeout(stemInstallPoll)
  stemInstallPoll = setTimeout(() => void pollStemInstall(), 400)
  try {
    const status = await window.api.audioEngine.installAutoMixStemPack()
    await acceptStemInstallStatus(status)
    if (status.phase === 'ready') {
      try {
        await updateSettings(
          enableAfterInstall
            ? { autoMixStemMode: 'auto', autoMixStemDevice: 'auto' }
            : { autoMixStemMode: 'off' }
        )
      } catch (error) {
        audioEngineError.value = error instanceof Error ? error.message : String(error)
      }
    }
  } catch {
    await acceptStemInstallStatus({
      phase: 'failed',
      completedBytes: 0,
      totalBytes: 0,
      reason: 'io'
    })
  }
}
async function cancelStemInstall(): Promise<void> {
  try {
    await acceptStemInstallStatus(await window.api.audioEngine.cancelAutoMixStemInstall())
  } catch {
    /* Keep polling the main process until installation completes. */
  }
}
const stemAvailable = computed(() => stemCapabilities.value.status === 'ready')
const stemDeviceAvailable = computed(() =>
  settings.value.autoMixStemDevice === 'gpu'
    ? stemCapabilities.value.gpu
    : settings.value.autoMixStemDevice === 'cpu'
      ? stemCapabilities.value.cpu
      : stemAvailable.value
)
const stemEnabled = computed(
  () => settings.value.autoMixStemMode === 'auto' && stemDeviceAvailable.value
)
const stemDetectionText = computed(() => {
  if (stemChecking.value) return t('automix.stems.checking')
  const capabilities = stemCapabilities.value
  if (capabilities.status === 'missing') return t('automix.stems.missing')
  if (capabilities.status === 'unavailable')
    return t(`automix.stems.${capabilities.reason ?? 'runtime_unavailable'}`)
  if (!stemDeviceAvailable.value) return t('automix.stems.deviceUnavailable')
  if (!capabilities.gpu) return t('automix.stems.cpuReady')
  const names = [
    ...new Set(
      capabilities.packs
        .filter((pack) => pack.gpu)
        .map((pack) => pack.gpuName)
        .filter(Boolean)
    )
  ]
  return `${t('automix.stems.gpuReady')}${names.length ? ' · ' + names.join(', ') : ''}`
})
async function detectStems(refresh = false): Promise<void> {
  if (stemChecking.value) return
  stemChecking.value = true
  try {
    stemCapabilities.value = await window.api.audioEngine.getAutoMixStemCapabilities(refresh)
  } catch {
    stemCapabilities.value = {
      status: 'unavailable',
      cpu: false,
      gpu: false,
      packs: [],
      reason: 'runtime_unavailable'
    }
  } finally {
    stemChecking.value = false
  }
}
onMounted(() => {
  stemComponentMounted = true
  if (TWILIGHT_AUTOMIX_AVAILABLE) {
    void detectStems()
    void pollStemInstall()
  }
})
onUnmounted(() => {
  stemComponentMounted = false
  clearTimeout(stemInstallPoll)
})
async function toggleStems(): Promise<void> {
  if (stemChecking.value || stemApplying.value || !stemDeviceAvailable.value) return
  stemApplying.value = true
  try {
    await updateSettings({
      autoMixStemMode: settings.value.autoMixStemMode === 'off' ? 'auto' : 'off'
    })
  } catch (error) {
    audioEngineError.value = error instanceof Error ? error.message : String(error)
  } finally {
    stemApplying.value = false
  }
}
async function setStemDevice(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const device = normalizeAutoMixStemDevice(select.value)
  if (
    stemChecking.value ||
    stemApplying.value ||
    !stemAvailable.value ||
    (device === 'gpu' && !stemCapabilities.value.gpu) ||
    (device === 'cpu' && !stemCapabilities.value.cpu)
  ) {
    select.value = settings.value.autoMixStemDevice
    return
  }
  stemApplying.value = true
  try {
    await updateSettings({ autoMixStemDevice: device })
  } catch (error) {
    audioEngineError.value = error instanceof Error ? error.message : String(error)
    select.value = settings.value.autoMixStemDevice
  } finally {
    stemApplying.value = false
  }
}
const autoMixStatusText = computed(() => {
  const info = playbackInfo.value
  if (!info?.autoMixState) return ''
  const keys = autoMixStatusKeys(info.autoMixState, info.autoMixReason, info.autoMixStrategy)
  return [
    t(keys.phase),
    keys.strategy ? t(keys.strategy) : '',
    info.autoMixDurationSeconds ? info.autoMixDurationSeconds.toFixed(1) + 's' : '',
    info.autoMixStemEnhanced ? t('automix.stems.active') : '',
    keys.reason ? t(keys.reason) : ''
  ]
    .filter(Boolean)
    .join(' · ')
})
async function setAutoMixMode(event: Event): Promise<void> {
  if (!TWILIGHT_AUTOMIX_AVAILABLE || autoMixModeApplying.value) return
  const select = event.target as HTMLSelectElement
  const mode = normalizeAutoMixMode(select.value)
  if (mode === 'dj' && effectiveAutoMixMode(settings.value.autoMixMode) !== 'dj') {
    select.value = effectiveAutoMixMode(settings.value.autoMixMode)
    djModeDialog.value?.showModal()
    return
  }
  await applyAutoMixMode(mode)
  select.value = effectiveAutoMixMode(settings.value.autoMixMode)
}
async function applyAutoMixMode(mode: AutoMixMode): Promise<void> {
  autoMixModeApplying.value = true
  try {
    await updateSettings({ autoMixMode: mode })
    djModeDialog.value?.close()
  } catch (error) {
    audioEngineError.value = error instanceof Error ? error.message : String(error)
  } finally {
    autoMixModeApplying.value = false
  }
}

async function toggleExclusiveAutoRelease(): Promise<void> {
  if (!exclusiveAvailable.value || !exclusiveMode.value || exclusiveAutoReleaseApplying.value)
    return
  exclusiveAutoReleaseApplying.value = true
  try {
    await updateSettings({
      audioExclusiveAutoRelease: !settings.value.audioExclusiveAutoRelease
    })
  } catch (error) {
    audioEngineError.value = error instanceof Error ? error.message : String(error)
  } finally {
    exclusiveAutoReleaseApplying.value = false
  }
}
const isUpmixActive = computed(
  () =>
    audioOutputConfig.value.routingMode === 'stereo-to-5.1' ||
    audioOutputConfig.value.routingMode === 'stereo-to-7.1'
)
const showWasapiPushMode = computed(() => audioOutput.value === 'wasapi' && exclusiveMode.value)

const audioOutputPanelExpanded = useSettingsDisclosure('audio-output-device-panel')
const outputChainText = computed(() => {
  const info = playbackInfo.value
  if (!info) return '等待音频引擎'
  const codec = info.codec || 'Source'
  const depth = info.sourceBitDepth > 0 ? `${info.sourceBitDepth}bit` : ''
  const rate = info.sourceSampleRate > 0 ? compactRate(info.sourceSampleRate) : ''
  const src = [codec, depth, rate].filter(Boolean).join(' ')
  const out = outputInfo.value
  const backend = out?.actualBackend || info.actualBackend || audioOutput.value
  const actualDepth =
    (out?.actualBitDepth || info.actualBitDepth || 0) > 0
      ? `${out?.actualBitDepth || info.actualBitDepth}bit`
      : ''
  const actualRate =
    (out?.actualSampleRate || info.actualSampleRate || 0) > 0
      ? compactRate(out?.actualSampleRate || info.actualSampleRate)
      : ''
  return `${src} -> ${backend.toUpperCase()} ${actualDepth} ${actualRate}`.trim()
})

const outputLatencyText = computed(() => {
  const info = outputInfo.value
  if (!info) return ''
  const total = info.latencyInfo?.totalLatencyMs ?? info.latencyMs ?? 0
  return `Latency ${total.toFixed(1)} ms`
})

const outputDiagnosticsText = computed(() => {
  const diagnostics = outputInfo.value?.diagnostics ?? playbackInfo.value?.diagnostics
  if (!diagnostics) return 'Underrun 0 · Drop 0'
  return `Underrun ${diagnostics.sessionUnderrunCount} · Drop ${diagnostics.sessionBufferDropCount}`
})

const outputProviderImplementation = computed(() => outputInfo.value?.providerImplementation ?? '')

/**
 * Why the output chain is not bit-perfect, in prose.
 *
 * The panel used to render `outputDiagnosticsText` twice — once as the status and
 * again under a warning triangle — so it showed underrun counters twice and never
 * said why passthrough was not achieved. The engine has always reported a reason
 * code; nothing resolved it into an explanation the user could act on.
 */
const outputReason = computed(() => {
  const code = outputInfo.value?.perfectReasonCode || playbackInfo.value?.perfectReasonCode || ''
  if (!code) return null
  const resolved = resolveReasonCode(locale.value, code)
  return resolved.known ? resolved : null
})

/** Free-text capability note from the driver, when there is no code to resolve. */
const outputReasonFallback = computed(() => {
  if (outputReason.value) return ''
  return (
    outputInfo.value?.capabilityReason?.trim() ||
    outputInfo.value?.perfectReason?.trim() ||
    playbackInfo.value?.perfectReason?.trim() ||
    ''
  )
})

const outputIsPerfect = computed(
  () => outputInfo.value?.sourceExact === true && outputInfo.value?.outputPerfect === true
)

/**
 * The headline verdict: "verified bit-exact" or the single reason it is not.
 *
 * This replaces the underrun counters that used to sit here. Counters still show
 * in the meta row below, where they belong — a stream health statistic is not an
 * answer to "is my audio bit-perfect".
 */
const outputVerdictText = computed(() => {
  if (outputIsPerfect.value) return t('diagnostics.panel.perfect')
  if (outputReason.value) return outputReason.value.label
  if (outputReasonFallback.value) return outputReasonFallback.value
  return t('diagnostics.panel.noBlockers')
})

const outputVerdictTone = computed(() => {
  if (outputIsPerfect.value) return 'success'
  if (!outputReason.value) return 'muted'
  return outputReason.value.severity === 'info' ? 'muted' : 'warning'
})

function compactRate(rate: number): string {
  return rate > 0 ? `${Math.round(rate / 100) / 10}kHz` : ''
}

function deviceIcon(device: AudioDeviceOption): string {
  const text = `${device.id} ${device.label} ${device.backend || ''}`.toLowerCase()
  if (/speaker|soundbar|monitor|音响|音箱|扬声器|喇叭/.test(text)) return 'pi pi-volume-up'
  if (/usb|dac|asio|hifi|exclusive/.test(text)) return 'pi pi-microchip'
  return 'pi pi-headphones'
}

function deviceSpecText(device: AudioDeviceOption): string {
  const parts = [
    device.backend || audioOutput.value,
    typeof device.channels === 'number' && device.channels > 0 ? `${device.channels}ch` : '',
    device.sampleRates && device.sampleRates.length > 0
      ? compactRate(Math.max(...device.sampleRates))
      : '',
    device.bitDepths && device.bitDepths.length > 0 ? `${Math.max(...device.bitDepths)}bit` : ''
  ].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  if (device.id === 'auto') return '跟随系统默认输出'
  if (device.isDefault) return '系统默认设备'
  return '原生输出设备'
}

function normalizeCapabilityState(
  state: AudioCapabilitySupportState | undefined
): AudioCapabilitySupportState {
  return state ?? 'unknown'
}

function capabilityStateLabel(state: AudioCapabilitySupportState | undefined): string {
  return {
    verified: '已验证',
    'runtime-probed': '运行时探测',
    unsupported: '不支持',
    unknown: '未知'
  }[normalizeCapabilityState(state)]
}

function capabilityStateTone(state: AudioCapabilitySupportState | undefined): string {
  return {
    verified: 'verified',
    'runtime-probed': 'runtime',
    unsupported: 'unsupported',
    unknown: 'unknown'
  }[normalizeCapabilityState(state)]
}

function capabilityStateTitle(device: AudioDeviceOption, label: string): string {
  const reason = device.capabilityReason?.trim()
  return reason ? `${label}: ${reason}` : label
}

function setPlaybackResumeMode(playbackResumeMode: PlaybackResumeMode): void {
  if (settings.value.playbackResumeMode === playbackResumeMode) return
  void updateSettings({ playbackResumeMode })
}

function setPlaybackResumeModeFromSelect(event: Event): void {
  setPlaybackResumeMode((event.target as HTMLSelectElement).value as PlaybackResumeMode)
}

function setPreviousButtonActionFromSelect(event: Event): void {
  const previousButtonAction = (event.target as HTMLSelectElement).value as PreviousButtonAction
  if (settings.value.previousButtonAction === previousButtonAction) return
  void updateSettings({ previousButtonAction })
}

function setSleepTimerDefaultMinutes(event: Event): void {
  const value = Math.trunc(Number((event.target as HTMLInputElement).value))
  if (!Number.isFinite(value)) return
  void updateSettings({
    sleepTimer: { ...settings.value.sleepTimer, defaultMinutes: Math.max(1, Math.min(720, value)) }
  })
}

function setSleepTimerFadeSeconds(event: Event): void {
  const value = Math.trunc(Number((event.target as HTMLInputElement).value))
  if (!Number.isFinite(value)) return
  void updateSettings({
    sleepTimer: { ...settings.value.sleepTimer, fadeSeconds: Math.max(0, Math.min(120, value)) }
  })
}

function setNcmPlaybackQuality(event: Event): void {
  void updateSettings({
    ncmPlaybackQuality: (event.target as HTMLSelectElement).value as NcmPlaybackQuality
  })
}

function selectAudioOutput(output: AudioOutputId): void {
  if (audioOutput.value === output) return
  void setAudioOutput(output)
}

function selectAudioDevice(deviceId: string): void {
  if (audioDevice.value === deviceId) return
  void setAudioDevice(deviceId)
}

function setPreferredBufferSize(event: Event): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  const value = Number((event.target as HTMLSelectElement).value)
  if (audioOutputConfig.value.preferredBufferSize === value) return
  void setAudioOutputConfig({ preferredBufferSize: value })
}

function setAsioOutputChannelStart(event: Event): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  void setAudioOutputConfig({ asioOutputChannelStart: Math.min(255, Math.max(0, Math.trunc(value) - 1)) })
}

function setRoutingMode(event: Event): void {
  const target = event.target as HTMLSelectElement
  void setAudioOutputConfig({ routingMode: target.value as ChannelRoutingMode })
}

function setPcmToDsdMode(event: Event): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  const value = (event.target as HTMLSelectElement).value as PcmToDsdMode
  if ((audioOutputConfig.value.pcmToDsdMode ?? 'off') === value) return
  void setAudioOutputConfig({ pcmToDsdMode: value })
}

function setUpmixParam(field: keyof OutputConfig, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  void setAudioOutputConfig({ [field]: value } as Partial<OutputConfig>)
}

function toggleWasapiExclusivePushMode(): void {
  if (audioOutputConfigApplyStatus.value.state === 'pending') return
  void setAudioOutputConfig({
    wasapiExclusivePushMode: !audioOutputConfig.value.wasapiExclusivePushMode
  })
}

function updateAudioProcessing(patch: Partial<AudioProcessingSettings>): void {
  void setAudioProcessing(patch)
}

async function selectDsdOutputMode(value: DsdOutputMode): Promise<void> {
  await setAudioProcessing({ dsdOutputMode: value, dsdToPcm: value === 'pcm' })
}

const dsdRoute = computed<DsdRouteSettings>(() => audioProcessing.value.dsdRoute)
const dsdRouteActive = computed(() => dsdRouteTargetsDistinctRoute(dsdRoute.value))

const dsdRouteBackendOptions = computed(() =>
  audioOutputOptions.value.filter((option) => option.id === 'asio' || option.id === 'alsa')
)

const dsdRouteDeviceOptions = computed(() => {
  const backend = dsdRoute.value.backend || audioOutput.value
  return audioDeviceOptions.value.filter((device) => {
    const id = (device.id ?? '').toLowerCase()
    const deviceBackend = device.backend ?? (id.startsWith('asio:') ? 'asio' : '')
    return deviceBackend === backend || id.startsWith(`${backend}:`)
  })
})

const dsdRouteProxyDevices = computed(() =>
  dsdRouteDeviceOptions.value.filter((device) => isDsdProxyDevice(device))
)

const dsdRouteRuntimeText = computed(() => {
  const diagnostics = outputInfo.value?.diagnostics
  if (!diagnostics) return ''
  if (diagnostics.dsdRouteOverrideActive) {
    const target = [diagnostics.dsdRouteBackend, diagnostics.dsdRouteDevice]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' / ')
    return target ? `DSD 正经由兼容层路由输出：${target}` : 'DSD 正经由兼容层路由输出'
  }
  if (diagnostics.dsdRouteFallbackReason) {
    return `兼容层路由未生效，已回退主输出：${diagnostics.dsdRouteFallbackReason}`
  }
  return ''
})

function patchDsdRoute(patch: Partial<DsdRouteSettings>): void {
  updateAudioProcessing({ dsdRoute: withDsdRoutePatch(dsdRoute.value, patch) })
}

function toggleDsdRouteEnabled(): void {
  patchDsdRoute({ enabled: !dsdRoute.value.enabled })
}

function setDsdRouteBackend(event: Event): void {
  const backend = (event.target as HTMLSelectElement).value
  patchDsdRoute({ backend, device: '' })
}

function setDsdRouteDevice(event: Event): void {
  patchDsdRoute({ device: (event.target as HTMLSelectElement).value })
}

function toggleDsdRoutePcmToDsd(): void {
  patchDsdRoute({ applyToPcmToDsd: !dsdRoute.value.applyToPcmToDsd })
}

function toggleDsdRouteStrict(): void {
  patchDsdRoute({ strictPassthrough: !dsdRoute.value.strictPassthrough })
}

function setVolumeFromInput(event: Event): void {
  volumePercent.value = Number((event.target as HTMLInputElement).value)
}

function toggleClipGuard(): void {
  updateAudioProcessing({ clipGuard: !audioProcessing.value.clipGuard })
}

function toggleGaplessPlayback(): void {
  void toggleGapless()
}

function setCrossfadeSeconds(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  updateAudioProcessing({ crossfadeSeconds: value })
}

function setCrossfadeCurve(event: Event): void {
  updateAudioProcessing({
    crossfadeCurve: (event.target as HTMLSelectElement)
      .value as AudioProcessingSettings['crossfadeCurve']
  })
}

function setCrossfadeContent(event: Event): void {
  updateAudioProcessing({
    crossfadeContent: (event.target as HTMLSelectElement)
      .value as AudioProcessingSettings['crossfadeContent']
  })
}

function setPlaybackPolicy(event: Event): void {
  void setAudioOutputConfig({
    playbackPolicy: (event.target as HTMLSelectElement).value as OutputConfig['playbackPolicy']
  })
}

function setContinuitySampleRate(event: Event): void {
  void setAudioOutputConfig({
    continuitySampleRate: Number(
      (event.target as HTMLSelectElement).value
    ) as OutputConfig['continuitySampleRate']
  })
}
</script>

<template>
  <div id="playback-basics" class="settings-playback-content">
    <div v-show="view !== 'audio'" class="section-block">
      <h3>播放习惯</h3>
      <div class="setting-list">
        <div data-setting-id="track-activation" id="setting-track-activation" class="setting-item">
          <div class="setting-copy">
            <strong>歌曲列表播放方式</strong>
            <span>选择普通左键单击还是双击播放；右键始终只打开菜单，不改变选中状态。</span>
          </div>
          <div class="segmented-control" role="group" aria-label="歌曲列表播放方式">
            <button
              v-for="option in trackActivationModeOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.trackActivationMode === option.value }"
              :aria-pressed="settings.trackActivationMode === option.value"
              @click="updateSettings({ trackActivationMode: option.value })"
            >
              <i :class="option.icon"></i>
              {{ option.label }}
            </button>
          </div>
        </div>
        <div data-setting-id="playback-resume" id="setting-playback-resume" class="setting-item">
          <div class="setting-copy">
            <strong>启动时恢复播放</strong>
            <span
              >默认关闭。开启后下次启动会恢复队列与曲目（可选进度）；不会自动开始播放，需手动点播放。</span
            >
          </div>
          <select
            class="preview-select"
            aria-label="启动时恢复播放"
            :value="settings.playbackResumeMode"
            @change="setPlaybackResumeModeFromSelect"
          >
            <option
              v-for="option in playbackResumeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <hr />
        <div data-setting-id="previous-action" id="setting-previous-action" class="setting-item">
          <div class="setting-copy">
            <strong>上一首按钮行为</strong>
            <span
              >播放超过 3 秒时点击“上一首”，是回到当前歌曲开头，还是直接切到上一首曲目；不超过 3
              秒时总是切歌。</span
            >
          </div>
          <select
            class="preview-select"
            aria-label="上一首按钮行为"
            :value="settings.previousButtonAction"
            @change="setPreviousButtonActionFromSelect"
          >
            <option
              v-for="option in previousButtonActionOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <hr />
        <div
          data-setting-id="sleep-timer"
          id="setting-sleep-timer"
          class="setting-item compact-row"
        >
          <div class="setting-copy">
            <strong>睡眠定时器</strong>
            <span>播放器可按默认时长停止，或等待当前曲目、队列结束。</span>
          </div>
          <div class="inline-controls">
            <label class="crossfade-group">
              <span>默认分钟</span>
              <input
                class="number-input"
                type="number"
                min="1"
                max="720"
                :value="settings.sleepTimer.defaultMinutes"
                @input="setSleepTimerDefaultMinutes"
              />
            </label>
            <label class="crossfade-group">
              <span>淡出秒数</span>
              <input
                class="number-input"
                type="number"
                min="0"
                max="120"
                :value="settings.sleepTimer.fadeSeconds"
                @input="setSleepTimerFadeSeconds"
              />
            </label>
          </div>
        </div>
        <hr />
        <div
          data-setting-id="streaming-quality"
          id="setting-streaming-quality"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>网易云播放音质</strong>
            <span>自动按 Hi-Res、无损、极高和标准依次回退；也可固定为其中一档。</span>
          </div>
          <select
            class="preview-select"
            aria-label="网易云播放音质"
            :value="settings.ncmPlaybackQuality"
            @change="setNcmPlaybackQuality"
          >
            <option
              v-for="option in ncmPlaybackQualityOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>
    </div>
    <div v-if="audioEngineError" class="engine-error">{{ audioEngineError }}</div>
    <div v-show="view !== 'playback'" class="section-block">
      <h3>声音输出</h3>
      <div data-setting-id="audio-device" id="setting-audio-device" class="setting-item">
        <div class="setting-copy">
          <strong>输出设备</strong
          ><span>通常保持跟随系统即可；连接耳机、音箱或解码器后，可以在这里切换。</span>
        </div>
        <div class="inline-controls">
          <select
            class="preview-select wide"
            aria-label="输出设备"
            :value="audioDevice"
            @change="selectAudioDevice(($event.target as HTMLSelectElement).value)"
          >
            <option value="auto">跟随系统默认设备</option>
            <option
              v-if="
                audioDevice !== 'auto' &&
                !audioOutputDeviceOptions.some((device) => device.id === audioDevice)
              "
              :value="audioDevice"
            >
              {{ audioDevice }}（暂不可用）
            </option>
            <option
              v-for="device in audioOutputDeviceOptions.filter((device) => device.id !== 'auto')"
              :key="device.id"
              :value="device.id"
            >
              {{ device.label }}
            </option>
          </select>
          <button
            type="button"
            class="icon-button"
            aria-label="刷新设备列表"
            title="刷新设备列表"
            @click="refreshAudioOutputState"
          >
            <i class="pi pi-refresh" aria-hidden="true" />
          </button>
        </div>
      </div>
      <SettingsGroup
        id="output-advanced"
        title="进阶输出"
        description="使用专业声卡、独占输出，或需要排查声音问题时展开；日常播放可以保持现有设置。"
        :summary="
          (selectedAudioOutput?.label ?? audioOutput) +
          ' · ' +
          (exclusiveMode ? '独占输出' : '共享输出')
        "
        :attention="
          audioEngineError ||
          profileAttention ||
          (audioOutputConfigApplyStatus.state === 'pending' ? '正在应用输出参数…' : '')
        "
      >
        <div class="section-block">
          <h3>输出方式</h3>
          <div class="setting-list">
            <div data-setting-id="audio-output" id="setting-audio-output" class="setting-item">
              <div class="setting-copy">
                <strong>输出模式</strong>
                <span>选择音频后端和系统混音路径。</span>
              </div>
              <div class="segmented-control" role="group" aria-label="输出模式">
                <button
                  v-for="option in audioOutputOptions"
                  :key="option.id"
                  type="button"
                  :class="{ active: audioOutput === option.id }"
                  :aria-pressed="audioOutput === option.id"
                  @click="selectAudioOutput(option.id)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <hr />
            <div data-setting-id="exclusive-mode" id="setting-exclusive-mode" class="setting-item">
              <div class="setting-copy">
                <strong>独占模式</strong>
                <span>尝试绕过系统混音器以获得更直接的输出链路。</span>
              </div>
              <button
                type="button"
                aria-label="独占模式"
                class="toggle-switch"
                :class="{ active: exclusiveMode, inactive: !exclusiveMode }"
                role="switch"
                :aria-checked="exclusiveMode"
                :disabled="!exclusiveAvailable"
                :title="exclusiveAvailable ? '' : '当前后端不支持独占模式'"
                @click="exclusiveAvailable && toggleExclusiveMode()"
              ></button>
            </div>
            <hr />
            <div
              data-setting-id="exclusive-release"
              id="setting-exclusive-release"
              class="setting-item"
            >
              <div class="setting-copy">
                <strong>独占模式自动启停</strong>
                <span>暂停时释放音频设备，继续播放时重新获取。</span>
                <span v-if="outputInfo?.outputReleased && playbackInfo?.state === 'paused'">
                  已暂停，音频设备已释放。
                </span>
              </div>
              <button
                type="button"
                class="toggle-switch"
                :class="{
                  active: settings.audioExclusiveAutoRelease,
                  inactive: !settings.audioExclusiveAutoRelease
                }"
                role="switch"
                aria-label="独占模式自动启停"
                :aria-checked="settings.audioExclusiveAutoRelease"
                :disabled="!exclusiveAvailable || !exclusiveMode || exclusiveAutoReleaseApplying"
                :title="
                  !exclusiveAvailable
                    ? '当前后端不支持独占模式'
                    : !exclusiveMode
                      ? '请先开启独占模式'
                      : ''
                "
                @click="toggleExclusiveAutoRelease"
              ></button>
            </div>
          </div>
        </div>
        <div class="section-block">
          <h3>音量与保护</h3>
          <div class="setting-list">
            <div
              data-setting-id="software-volume"
              id="setting-software-volume"
              class="setting-item compact-row"
            >
              <div class="setting-copy">
                <strong>软件音量</strong>
                <span> {{ HIFI_STATUS_COPY.volumeNotUnityHint }}。低于 100% 会改变样本值。 </span>
              </div>
              <div class="inline-controls">
                <input
                  class="number-input"
                  type="number"
                  aria-label="软件音量（百分比）"
                  min="0"
                  max="100"
                  :value="volumePercent"
                  @input="setVolumeFromInput"
                />
                <button
                  type="button"
                  class="soft-button"
                  :disabled="volumePercent >= 100"
                  title="将软件音量固定为 100%（Unity）"
                  @click="setUnityVolume"
                >
                  {{ HIFI_STATUS_COPY.unityButton }}
                </button>
              </div>
            </div>
            <div data-setting-id="clip-guard" id="setting-clip-guard" class="setting-item">
              <div class="setting-copy">
                <strong>防破音保护</strong><span>压缩过载信号，减少数字削波失真。</span>
              </div>
              <button
                type="button"
                class="toggle-switch"
                role="switch"
                aria-label="防破音保护"
                :aria-checked="audioProcessing.clipGuard"
                :class="{ active: audioProcessing.clipGuard, inactive: !audioProcessing.clipGuard }"
                @click="toggleClipGuard"
              />
            </div>
          </div>
        </div>
        <AudioDeviceProfilesPanel @attention="setProfileAttention" />
        <div v-if="playbackInfo" class="output-diagnostic-panel">
          <div class="diagnostic-head">
            <span class="diagnostic-label">{{ t('diagnostics.panel.title') }}</span>
            <span class="diagnostic-status" :data-tone="outputVerdictTone">
              {{ outputVerdictText }}
            </span>
          </div>
          <div class="diagnostic-chain">{{ outputChainText }}</div>

          <!-- The reason the chain is not bit-perfect, with what is happening and
           what to do. This panel previously printed the underrun counters twice
           and never showed the reason at all. -->
          <div v-if="outputReason" class="diagnostic-reason">
            <p class="diagnostic-reason-label">
              <span class="diagnostic-severity" :data-severity="outputReason.severity">
                {{ t(`diagnostics.severity.${outputReason.severity}`) }}
              </span>
              {{ outputReason.label }}
            </p>
            <p v-if="outputReason.explain" class="diagnostic-reason-explain">
              {{ outputReason.explain }}
            </p>
            <p v-if="outputReason.fix" class="diagnostic-reason-fix">
              <i class="pi pi-wrench" aria-hidden="true"></i> {{ outputReason.fix }}
            </p>
          </div>

          <div class="diagnostic-meta">
            <span v-if="outputLatencyText"
              ><i class="pi pi-clock"></i> {{ outputLatencyText }}</span
            >
            <span><i class="pi pi-chart-bar"></i> {{ outputDiagnosticsText }}</span>
            <span v-if="outputProviderImplementation">
              <i class="pi pi-cog"></i> Provider {{ outputProviderImplementation }}
            </span>
          </div>
        </div>
        <div class="device-panel">
          <div class="device-panel-head">
            <div>
              <p>Audio Output</p>
              <h3>设备能力与链路</h3>
            </div>
            <div class="device-panel-actions">
              <label class="device-panel-disclosure">
                <input
                  v-model="audioOutputPanelExpanded"
                  type="checkbox"
                  aria-controls="audio-output-device-panel"
                  :aria-expanded="audioOutputPanelExpanded"
                />
                <span>{{ audioOutputPanelExpanded ? '收起设备列表' : '展开设备列表' }}</span>
              </label>
              <button
                type="button"
                class="icon-button"
                title="刷新设备列表"
                @click="refreshAudioOutputState"
              >
                <i class="pi pi-refresh"></i>
              </button>
            </div>
          </div>
          <SettingsDisclosure
            :open="audioOutputPanelExpanded"
            keep-mounted
            trigger-selector='input[aria-controls="audio-output-device-panel"]'
            id="audio-output-device-panel"
            class="device-panel-content"
          >
            <div class="device-grid">
              <button
                v-for="device in audioOutputDeviceOptions"
                :key="device.id"
                type="button"
                class="device-card"
                :class="{ active: audioDevice === device.id }"
                :aria-pressed="audioDevice === device.id"
                @click="selectAudioDevice(device.id)"
              >
                <i :class="deviceIcon(device)"></i>
                <span>{{ device.label }}</span>
                <small>{{ deviceSpecText(device) }}</small>
                <div
                  v-if="
                    normalizeCapabilityState(device.dopSupportState) !== 'unsupported' ||
                    normalizeCapabilityState(device.nativeDsdSupportState) !== 'unsupported'
                  "
                  class="device-capability-row"
                >
                  <span
                    v-if="normalizeCapabilityState(device.dopSupportState) !== 'unsupported'"
                    class="device-capability-chip"
                    :class="capabilityStateTone(device.dopSupportState)"
                    :title="capabilityStateTitle(device, 'DoP')"
                  >
                    DoP {{ capabilityStateLabel(device.dopSupportState) }}
                  </span>
                  <span
                    v-if="normalizeCapabilityState(device.nativeDsdSupportState) !== 'unsupported'"
                    class="device-capability-chip"
                    :class="capabilityStateTone(device.nativeDsdSupportState)"
                    :title="capabilityStateTitle(device, 'Native DSD')"
                  >
                    Native DSD {{ capabilityStateLabel(device.nativeDsdSupportState) }}
                  </span>
                </div>
                <b v-if="audioDevice === device.id">当前</b>
              </button>
            </div>
            <p class="device-capability-note">
              列表为设备能力声明；是否 Native DSD / DoP 以播放时 HiFi
              状态为准（筛选≠当前输出模式）。
            </p>
          </SettingsDisclosure>
        </div>
      </SettingsGroup>
    </div>
    <SettingsGroup
      v-show="view !== 'audio'"
      id="playback-transitions"
      title="歌曲衔接"
      description="想让歌曲之间更连贯，或尝试自动混音时，再调整这些选项。无缝播放、淡化与 AutoMix 分别配置。"
      :summary="
        (audioProcessing.gapless ? '无缝播放已开启' : '无缝播放已关闭') +
        ' · 淡化 ' +
        audioProcessing.crossfadeSeconds +
        ' 秒 · AutoMix ' +
        { off: '关闭', natural: '自然', dj: 'DJ' }[effectiveAutoMixMode(settings.autoMixMode)]
      "
      :attention="
        stemInstalling
          ? stemInstallText || '正在安装分轨包…'
          : stemInstallStatus.phase === 'failed'
            ? stemInstallText
            : ''
      "
    >
      <div class="setting-list">
        <div data-setting-id="autoMixMode" class="setting-item">
          <div class="setting-copy">
            <strong>Twilight AutoMix</strong>
            <span>自然模式保留歌曲内容；DJ 模式加入更长对拍和退出效果。</span>
            <span v-if="TWILIGHT_AUTOMIX_EVALUATION_AVAILABLE && !TWILIGHT_AUTOMIX_RELEASE_READY"
              >人工验收版本：可以开启试听，正式验收尚未完成。请先选择模式，再开始播放队列。</span
            >
            <span v-else-if="TWILIGHT_AUTOMIX_AVAILABLE && !TWILIGHT_AUTOMIX_RELEASE_READY"
              >AutoMix 已开放试用。分轨增强需要另外安装分轨包；请先选择模式，再开始播放队列。</span
            >
            <span v-else-if="!TWILIGHT_AUTOMIX_AVAILABLE"
              >正式验收尚未完成，请使用人工验收版本试听。</span
            >
            <span v-if="TWILIGHT_AUTOMIX_AVAILABLE && playbackInfo?.autoMixState">{{
              autoMixStatusText
            }}</span>
          </div>
          <div class="inline-controls automix-mode-controls">
            <button
              v-if="TWILIGHT_AUTOMIX_AVAILABLE"
              type="button"
              class="preset-btn"
              data-action="install-stem-pack"
              :disabled="stemInstalling"
              @click="chooseStemInstall"
            >
              {{ t('automix.stems.install.button') }}
            </button>
            <select
              :value="effectiveAutoMixMode(settings.autoMixMode)"
              :disabled="!TWILIGHT_AUTOMIX_AVAILABLE || autoMixModeApplying"
              aria-label="Twilight AutoMix 模式"
              @change="setAutoMixMode"
            >
              <option value="off">关闭</option>
              <option value="natural">自然</option>
              <option value="dj">DJ</option>
            </select>
          </div>
        </div>
        <div
          v-if="TWILIGHT_AUTOMIX_AVAILABLE"
          data-setting-id="autoMixStemMode"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>{{ t('automix.stems.title') }}</strong>
            <span>{{ t('automix.stems.description') }}</span>
            <span role="status" aria-live="polite">{{ stemDetectionText }}</span>
            <span v-if="stemEnabled" role="status">{{ t('automix.stems.resourceNotice') }}</span>
            <span
              v-if="stemInstallText"
              :role="stemInstallStatus.phase === 'failed' ? 'alert' : 'status'"
              aria-live="polite"
              >{{ stemInstallText }}</span
            >
            <span v-if="stemInstalling && stemInstallStatus.fileName">{{
              stemInstallStatus.fileName
            }}</span>
            <progress
              v-if="stemInstallStatus.phase === 'extracting'"
              class="automix-install-progress"
              :value="stemInstallStatus.completedBytes"
              :max="stemInstallStatus.totalBytes || 1"
              :aria-label="t('automix.stems.install.extracting')"
            ></progress>
          </div>
          <div class="inline-controls">
            <button
              v-if="stemInstalling && stemInstallStatus.phase !== 'selecting'"
              type="button"
              class="preset-btn"
              @click="cancelStemInstall"
            >
              {{ t('automix.stems.install.cancel') }}
            </button>
            <button
              type="button"
              class="preset-btn"
              :disabled="stemChecking || stemApplying || stemInstalling"
              @click="detectStems(true)"
            >
              {{ t('automix.stems.refresh') }}
            </button>
            <button
              type="button"
              class="toggle-switch"
              :class="{ active: stemEnabled, inactive: !stemEnabled }"
              role="switch"
              :aria-label="t('automix.stems.title')"
              :aria-checked="stemEnabled"
              :disabled="stemChecking || stemApplying || !stemDeviceAvailable"
              :title="stemDetectionText"
              @click="toggleStems"
            ></button>
          </div>
        </div>
        <div
          v-if="TWILIGHT_AUTOMIX_AVAILABLE"
          data-setting-id="autoMixStemDevice"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>{{ t('automix.stems.device') }}</strong>
            <span>{{ t('automix.stems.deviceDescription') }}</span>
          </div>
          <select
            class="preview-select"
            :value="settings.autoMixStemDevice"
            :aria-label="t('automix.stems.device')"
            :disabled="!stemAvailable || stemChecking || stemApplying"
            @change="setStemDevice"
          >
            <option value="auto">{{ t('automix.stems.deviceAuto') }}</option>
            <option value="gpu" :disabled="!stemCapabilities.gpu">GPU</option>
            <option value="cpu" :disabled="!stemCapabilities.cpu">CPU</option>
          </select>
        </div>
        <div
          v-if="TWILIGHT_AUTOMIX_AVAILABLE"
          data-setting-id="autoMixStemCacheMiB"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>{{ t('automix.stems.cache.title') }}</strong>
            <span>{{ t('automix.stems.cache.description') }}</span>
          </div>
          <select
            :value="settings.autoMixStemCacheMiB"
            :aria-label="t('automix.stems.cache.title')"
            @change="
              updateSettings({
                autoMixStemCacheMiB: normalizeAutoMixStemCacheMiB(
                  Number(($event.target as HTMLSelectElement).value)
                )
              })
            "
          >
            <option :value="0">{{ t('automix.stems.off') }}</option>
            <option v-for="capacity in [256, 512, 1024, 2048]" :key="capacity" :value="capacity">
              {{ capacity }} MiB
            </option>
          </select>
        </div>
        <div data-setting-id="gapless" id="setting-gapless" class="setting-item">
          <div class="setting-copy">
            <strong>无缝播放</strong>
            <span>{{ HIFI_STATUS_COPY.gaplessNote }}</span>
            <span
              >交叉淡化会改变 PCM
              信号。等功率曲线仍可能削波；CUE、未知时长和变速播放始终保留边界。</span
            >
            <span v-if="audioProcessing.crossfadeSeconds > 0 && playbackInfo">
              {{ playbackInfo.crossfadeCurve === 'equal-power' ? '等功率' : '线性' }} ·
              {{ playbackInfo.crossfadeMixActive ? '正在混合' : '等待交接' }} · 可用重叠
              {{ playbackInfo.crossfadeEffectiveSeconds ?? 0 }} 秒。
              {{ crossfadeBlockedReasonCopy(playbackInfo.crossfadeBlockedReason) }}
            </span>
          </div>
          <div class="inline-controls continuity-controls">
            <div class="crossfade-group">
              <span>交叉淡入淡出 (秒)</span>
              <input
                class="number-input"
                type="number"
                aria-label="交叉淡入淡出（秒）"
                min="0"
                max="12"
                step="0.5"
                :value="audioProcessing.crossfadeSeconds"
                @input="setCrossfadeSeconds"
              />
            </div>
            <select
              class="preview-select"
              aria-label="交叉淡化曲线"
              :value="audioProcessing.crossfadeCurve ?? 'linear'"
              @change="setCrossfadeCurve"
            >
              <option value="linear">线性</option>
              <option value="equal-power">等功率</option>
            </select>
            <select
              class="preview-select"
              aria-label="交叉淡化内容规则"
              :value="audioProcessing.crossfadeContent ?? 'conservative'"
              @change="setCrossfadeContent"
            >
              <option value="conservative">保留同专辑与短曲边界</option>
              <option value="all">允许同专辑与短曲淡化</option>
              <option value="live">现场内容：保留边界</option>
            </select>
            <button
              type="button"
              aria-label="无缝播放"
              class="toggle-switch"
              :class="{ active: audioProcessing.gapless, inactive: !audioProcessing.gapless }"
              role="switch"
              :aria-checked="audioProcessing.gapless"
              @click="toggleGaplessPlayback"
            ></button>
          </div>
        </div>
        <hr />
        <div data-setting-id="bpm-analysis" id="setting-bpm-analysis" class="setting-item">
          <div class="setting-copy">
            <strong>BPM 自动分析</strong
            ><span>首次播放本地歌曲时在后台分析节拍，并保存结果供下次使用。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            role="switch"
            aria-label="BPM 自动分析"
            :aria-checked="autoAnalyzeBpm"
            :class="{ active: autoAnalyzeBpm, inactive: !autoAnalyzeBpm }"
            @click="emit('toggleAutoAnalyzeBpm')"
          />
        </div>
      </div>
      <div class="section-block">
        <h3 data-setting-id="playback-policy" id="setting-playback-policy">连续播放策略</h3>
        <div class="setting-list">
          <div class="setting-item">
            <div class="setting-copy">
              <strong>连续播放策略</strong>
              <span
                >原样优先保留来源格式；连续优先将 PCM 统一为双声道 Float32，允许重采样，不保证
                bit-perfect。DSD 单独切换。</span
              >
              <span v-if="audioOutputConfig.playbackPolicy === 'continuity-first'">
                目标：{{ audioOutputConfig.continuitySampleRate ?? 48000 }} Hz / 32 bit / 2 声道。
                需自动声道路由并关闭 PCM 转 DSD；切换策略会保留进度重新打开输出。
              </span>
              <span v-if="playbackInfo?.source">
                来源：{{ playbackInfo.sourceSampleRate }} Hz / {{ playbackInfo.sourceBitDepth }} bit
                / {{ playbackInfo.sourceChannels ?? '—' }} 声道； 实际：{{
                  playbackInfo.outputSampleRate
                }}
                Hz / {{ playbackInfo.outputBitDepth }} bit / {{ playbackInfo.channelCount }} 声道。
                {{
                  gaplessRuntimeStatusCopy({
                    intentEnabled: audioProcessing.gapless,
                    ...playbackInfo
                  })
                }}
              </span>
            </div>
            <div class="inline-controls continuity-controls">
              <select
                class="preview-select"
                aria-label="连续播放策略"
                :value="audioOutputConfig.playbackPolicy ?? 'bit-perfect-first'"
                :disabled="audioOutputConfigApplyStatus.state === 'pending'"
                @change="setPlaybackPolicy"
              >
                <option value="bit-perfect-first">原样优先</option>
                <option value="continuity-first">连续优先</option>
              </select>
              <select
                v-if="audioOutputConfig.playbackPolicy === 'continuity-first'"
                class="preview-select"
                aria-label="连续播放目标采样率"
                :value="audioOutputConfig.continuitySampleRate ?? 48000"
                :disabled="audioOutputConfigApplyStatus.state === 'pending'"
                @change="setContinuitySampleRate"
              >
                <option :value="44100">44.1 kHz</option>
                <option :value="48000">48 kHz</option>
                <option :value="96000">96 kHz</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </SettingsGroup>
    <SettingsGroup
      v-show="view !== 'playback'"
      id="dsd-routing"
      title="DSD 播放"
      description="播放 DSD 文件或使用支持 DSD 的解码器时，再调整直通与兼容层路由。"
      :summary="
        audioProcessing.dsdOutputMode + (dsdRoute.enabled ? ' · 已启用兼容层路由' : ' · 主输出路由')
      "
      :attention="dsdRouteRuntimeText"
      ><div class="setting-list">
        <div
          data-setting-id="dsd-output-mode"
          id="setting-dsd-output-mode"
          class="setting-item top-align dsd-route-setting"
        >
          <div class="setting-copy">
            <strong>DSD 直通路由</strong>
          </div>
          <div
            class="segmented-control dsd-route-control"
            role="radiogroup"
            aria-label="DSD 直通路由"
          >
            <button
              v-for="option in dsdOutputModeOptions"
              :key="option.value"
              type="button"
              role="radio"
              :class="{ active: audioProcessing.dsdOutputMode === option.value }"
              :aria-checked="audioProcessing.dsdOutputMode === option.value"
              :title="option.description"
              @click="selectDsdOutputMode(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div
          data-setting-id="dsd-compatible-route"
          id="setting-dsd-compatible-route"
          class="setting-item top-align dsd-compat-route"
        >
          <div class="setting-copy">
            <strong>DSD 兼容层路由</strong>
            <span>
              DAC 自带 ASIO 驱动不接受 DSD 采样类型（或只有 WASAPI）时，DSD 会被迫降级为 DoP /
              PCM。把 DSD 单独路由到已注册的 DSD 代理 ASIO 驱动可以恢复直通，PCM
              仍走主输出、不受影响。
            </span>
            <small>
              代理驱动（如 foo_dsd_asio）是独立的系统级 ASIO 驱动，与是否安装 foobar2000
              无关；本软件不加载任何第三方组件，只按你选定的 后端与设备协商。
            </small>
            <span
              v-if="dsdRouteRuntimeText"
              class="setting-substatus"
              :class="{ available: outputInfo?.diagnostics?.dsdRouteOverrideActive }"
            >
              {{ dsdRouteRuntimeText }}
            </span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            :class="{ active: dsdRoute.enabled, inactive: !dsdRoute.enabled }"
            role="switch"
            :aria-checked="dsdRoute.enabled"
            aria-label="启用 DSD 兼容层路由"
            @click="toggleDsdRouteEnabled()"
          ></button>
        </div>
        <template v-if="dsdRoute.enabled">
          <div
            data-setting-id="dsd-route-backend"
            id="setting-dsd-route-backend"
            class="setting-item compact-row"
          >
            <div class="setting-copy">
              <strong>路由后端</strong>
              <span>留空则沿用主输出后端。</span>
            </div>
            <select
              class="settings-select"
              :value="dsdRoute.backend"
              aria-label="DSD 兼容层路由后端"
              @change="setDsdRouteBackend"
            >
              <option value="">跟随主输出（{{ audioOutput }}）</option>
              <option v-for="option in dsdRouteBackendOptions" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div
            data-setting-id="dsd-route-device"
            id="setting-dsd-route-device"
            class="setting-item compact-row"
          >
            <div class="setting-copy">
              <strong>路由设备</strong>
              <span v-if="dsdRouteProxyDevices.length > 0">
                检测到 {{ dsdRouteProxyDevices.length }} 个疑似 DSD 代理驱动。
              </span>
              <span v-else> 未检测到疑似代理驱动；若已安装仍可手动选择对应设备。 </span>
            </div>
            <select
              class="settings-select"
              :value="dsdRoute.device"
              aria-label="DSD 兼容层路由设备"
              @change="setDsdRouteDevice"
            >
              <option value="">跟随主输出设备</option>
              <option v-for="device in dsdRouteDeviceOptions" :key="device.id" :value="device.id">
                {{ device.label }}{{ isDsdProxyDevice(device) ? '（DSD 代理）' : '' }}
              </option>
            </select>
          </div>
          <div
            data-setting-id="dsd-route-upsampling"
            id="setting-dsd-route-upsampling"
            class="setting-item"
          >
            <div class="setting-copy">
              <strong>PCM→DSD 上采样也走此路由</strong>
              <span>关闭则仅 DSD 源使用兼容层，上采样仍走主输出。</span>
            </div>
            <button
              type="button"
              class="toggle-switch"
              :class="{
                active: dsdRoute.applyToPcmToDsd,
                inactive: !dsdRoute.applyToPcmToDsd
              }"
              role="switch"
              :aria-checked="dsdRoute.applyToPcmToDsd"
              aria-label="PCM 转 DSD 上采样使用兼容层路由"
              @click="toggleDsdRoutePcmToDsd()"
            ></button>
          </div>
          <div
            data-setting-id="dsd-route-strict"
            id="setting-dsd-route-strict"
            class="setting-item"
          >
            <div class="setting-copy">
              <strong>严格直通模式</strong>
              <span>
                开启后无法建立 DSD 直通时报错停止，不静默降级为 PCM。默认关闭，保持自动回退。
              </span>
            </div>
            <button
              type="button"
              class="toggle-switch"
              :class="{
                active: dsdRoute.strictPassthrough,
                inactive: !dsdRoute.strictPassthrough
              }"
              role="switch"
              :aria-checked="dsdRoute.strictPassthrough"
              aria-label="DSD 严格直通模式"
              @click="toggleDsdRouteStrict()"
            ></button>
          </div>
          <div v-if="!dsdRouteActive" class="setting-item">
            <div class="setting-copy">
              <span class="setting-substatus">
                已启用但未指定后端或设备，当前等同于沿用主输出。
              </span>
            </div>
          </div>
        </template>
        <div class="advanced-grid">
          <label data-setting-id="pcm-to-dsd">
            <span>PCM → DSD</span>
            <select
              class="preview-select"
              :value="audioOutputConfig.pcmToDsdMode ?? 'off'"
              :disabled="audioOutputConfigApplyStatus.state === 'pending'"
              @change="setPcmToDsdMode"
            >
              <option
                v-for="option in pcmToDsdModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
        <p class="setting-hint">
          PCM → DSD 在解码/DSP 之后将 PCM 调制为 DSD，经 Native DSD 或 DoP 输出；源文件已是 DSD
          时不受影响。
        </p>
      </div></SettingsGroup
    ><SettingsGroup
      v-show="view !== 'playback'"
      id="advanced-engine-parameters"
      title="高级引擎参数"
      description="使用专业声卡、独占输出，或需要排查声音问题时展开；日常播放可以保持默认设置。"
      :summary="
        (audioOutputConfig.preferredBufferSize || '自动缓冲') +
        ' · ' +
        audioOutputConfig.routingMode +
        ' · ' +
        audioProcessing.dsdOutputMode
      "
      :attention="
        audioEngineError ||
        (audioOutputConfigApplyStatus.state === 'pending' ? '正在应用输出参数…' : '')
      "
    >
      <div class="engine-warning">
        <i class="pi pi-exclamation-triangle"></i>
        <span>警告：以下参数直接与声卡底层交互，调节不当可能导致音频卡顿、无声或爆音。</span>
      </div>
      <div class="advanced-grid">
        <label data-setting-id="buffer-size">
          <span>Buffer Size</span>
          <select
            class="preview-select"
            :value="audioOutputConfig.preferredBufferSize"
            :disabled="audioOutputConfigApplyStatus.state === 'pending'"
            @change="setPreferredBufferSize"
          >
            <option v-for="option in bufferSizeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label v-if="audioOutput === 'asio'" data-setting-id="asio-output-channel-start">
          <span>ASIO 起始输出通道</span>
          <input
            class="preview-select"
            type="number"
            min="1"
            max="256"
            step="1"
            :value="(audioOutputConfig.asioOutputChannelStart ?? 0) + 1"
            :disabled="audioOutputConfigApplyStatus.state === 'pending'"
            @change="setAsioOutputChannelStart"
          />
        </label>
        <label data-setting-id="channel-routing">
          <span>Routing</span>
          <select
            class="preview-select"
            :value="audioOutputConfig.routingMode"
            @change="setRoutingMode"
          >
            <option v-for="option in routingModeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
      </div>

      <div v-if="isUpmixActive" class="advanced-grid">
        <label>
          <span>Center Gain</span>
          <input
            class="number-input"
            type="number"
            step="0.1"
            :value="audioOutputConfig.upmixCenterGain ?? 0"
            @input="(e) => setUpmixParam('upmixCenterGain', e)"
          />
        </label>
        <label>
          <span>LFE Gain</span>
          <input
            class="number-input"
            type="number"
            step="0.1"
            :value="audioOutputConfig.upmixLfeGain ?? 0"
            @input="(e) => setUpmixParam('upmixLfeGain', e)"
          />
        </label>
        <label>
          <span>LFE Lowpass (Hz)</span>
          <input
            class="number-input"
            type="number"
            step="1"
            :value="audioOutputConfig.upmixLfeLowpassHz ?? 80"
            @input="(e) => setUpmixParam('upmixLfeLowpassHz', e)"
          />
        </label>
        <label>
          <span>Surround Gain</span>
          <input
            class="number-input"
            type="number"
            step="0.1"
            :value="audioOutputConfig.upmixSurroundGain ?? 0"
            @input="(e) => setUpmixParam('upmixSurroundGain', e)"
          />
        </label>
        <label>
          <span>Side Gain</span>
          <input
            class="number-input"
            type="number"
            step="0.1"
            :value="audioOutputConfig.upmixSideGain ?? 0"
            @input="(e) => setUpmixParam('upmixSideGain', e)"
          />
        </label>
        <label>
          <span>Surround Delay (ms)</span>
          <input
            class="number-input"
            type="number"
            step="0.1"
            :value="audioOutputConfig.upmixSurroundDelayMs ?? 0"
            @input="(e) => setUpmixParam('upmixSurroundDelayMs', e)"
          />
        </label>
      </div>
      <div
        data-setting-id="wasapi-push"
        id="setting-wasapi-push"
        v-if="showWasapiPushMode"
        class="setting-item wasapi-push-row"
      >
        <div class="setting-copy">
          <strong>WASAPI 独占推送模式</strong>
          <span>事件驱动不兼容时切换到定时器驱动，可解决部分声卡无声/爆音。</span>
        </div>
        <button
          type="button"
          aria-label="WASAPI 独占推送模式"
          :disabled="audioOutputConfigApplyStatus.state === 'pending'"
          class="toggle-switch"
          :class="{
            active: !!audioOutputConfig.wasapiExclusivePushMode,
            inactive: !audioOutputConfig.wasapiExclusivePushMode
          }"
          role="switch"
          :aria-checked="!!audioOutputConfig.wasapiExclusivePushMode"
          :aria-disabled="audioOutputConfigApplyStatus.state === 'pending'"
          @click="toggleWasapiExclusivePushMode"
        ></button>
      </div>
    </SettingsGroup>
  </div>
  <dialog
    ref="stemInstallDialog"
    class="automix-notice-dialog"
    aria-labelledby="automix-install-title"
    aria-describedby="automix-install-description"
  >
    <h3 id="automix-install-title">{{ t('automix.stems.install.button') }}</h3>
    <p id="automix-install-description">{{ t('automix.stems.resourceNotice') }}</p>
    <label class="automix-install-choice">
      <input
        v-model="enableStemsAfterInstall"
        type="checkbox"
        data-action="enable-stems-after-install"
      />
      {{ t('automix.stems.install.enableAfter') }}
    </label>
    <p>{{ t('automix.stems.install.enableDescription') }}</p>
    <div class="inline-controls">
      <button type="button" class="preset-btn" autofocus @click="stemInstallDialog?.close()">
        {{ t('automix.notice.cancel') }}
      </button>
      <button
        type="button"
        class="preset-btn"
        data-action="choose-stem-zip"
        @click="installStemPack"
      >
        {{ t('automix.stems.install.choose') }}
      </button>
    </div>
  </dialog>
  <dialog
    ref="djModeDialog"
    class="automix-notice-dialog"
    aria-labelledby="automix-dj-title"
    aria-describedby="automix-dj-description"
  >
    <h3 id="automix-dj-title">{{ t('automix.djNotice.title') }}</h3>
    <p id="automix-dj-description">{{ t('automix.djNotice.description') }}</p>
    <div class="inline-controls">
      <button
        type="button"
        class="preset-btn"
        autofocus
        :disabled="autoMixModeApplying"
        @click="djModeDialog?.close()"
      >
        {{ t('automix.notice.cancel') }}
      </button>
      <button
        type="button"
        class="preset-btn"
        data-action="confirm-dj-mode"
        :disabled="autoMixModeApplying"
        @click="applyAutoMixMode('dj')"
      >
        {{ t('automix.djNotice.confirm') }}
      </button>
    </div>
  </dialog>
</template>
