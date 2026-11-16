<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { useCoreConnection } from '@renderer/stores/coreConnection.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { formatAudioError } from '@renderer/utils/audioErrorPresentation'
import type { AudioDeviceOption } from '@renderer/types/settings'

const props = defineProps<{ audioExclusiveMode: boolean }>()
const emit = defineEmits<{ 'update:audioExclusiveMode': [value: boolean] }>()

const audioStore = useAudioOutputDspStore()
const core = useCoreConnection()
const { audioDevice, audioOutputDeviceOptions, audioOutput, audioOutputOptions, audioProcessing } =
  storeToRefs(audioStore)
const { setAudioDevice, refreshAudioOutputState, setReplayGainMode } = audioStore
const testToneState = ref<'idle' | 'playing' | 'success' | 'error'>('idle')
const testToneError = ref('')
const deviceChanging = ref(false)
const { volume, setVolume } = usePlayerStore()
let active = true
let testAttempt = 0
onBeforeUnmount(() => {
  active = false
  testAttempt++
  void core.command('audio.outputTest.stop', {}).catch(() => undefined)
})

// Device picks apply immediately (like library folders on the local step) so
// the user hears the change without waiting for the wizard to finish.
onMounted(() => {
  void refreshAudioOutputState()
})

const exclusiveAvailable = computed(
  () =>
    audioOutputOptions.value.find((option) => option.id === audioOutput.value)?.supportsExclusive ??
    false
)

const loudnessMatched = computed(() => audioProcessing.value.volumeNormalization !== 'off')

function toggleLoudnessMatch(): void {
  void setReplayGainMode(loudnessMatched.value ? 'off' : 'track').catch((error) => {
    if (!active) return
    testToneError.value = formatAudioError(error)
    testToneState.value = 'error'
  })
}

async function selectDevice(id: string): Promise<void> {
  if (audioDevice.value === id || deviceChanging.value) return
  deviceChanging.value = true
  testAttempt++
  testToneState.value = 'idle'
  testToneError.value = ''
  try {
    await core.command('audio.outputTest.stop', {})
    await setAudioDevice(id)
    if (audioDevice.value !== id) throw new Error('设备切换未成功，请检查设备连接后重试')
  } catch (error) {
    testToneError.value = formatAudioError(error)
    testToneState.value = 'error'
  } finally {
    deviceChanging.value = false
  }
}

async function testOutput(): Promise<void> {
  if (testToneState.value === 'playing' || deviceChanging.value) return
  testToneState.value = 'playing'
  testToneError.value = ''
  const attempt = ++testAttempt
  try {
    const result = await core.command('audio.outputTest.play', { revision: (await core.query('audio.outputTest', {})).revision, exclusive: props.audioExclusiveMode }) as { cancelled: boolean }
    if (active && attempt === testAttempt)
      testToneState.value = result.cancelled ? 'idle' : 'success'
  } catch (error) {
    if (!active || attempt !== testAttempt) return
    testToneState.value = 'error'
    testToneError.value = formatAudioError(error)
  }
}

async function stopTest(): Promise<boolean> {
  testAttempt++
  try {
    await core.command('audio.outputTest.stop', {})
    if (active) testToneState.value = 'idle'
    return true
  } catch (error) {
    if (active) {
      testToneState.value = 'error'
      testToneError.value = formatAudioError(error)
    }
    return false
  }
}

async function selectMode(exclusive: boolean): Promise<void> {
  if (deviceChanging.value || !(await stopTest()) || !active) return
  testToneError.value = ''
  emit('update:audioExclusiveMode', exclusive)
}

function changeVolume(event: Event): void {
  setVolume(Number((event.target as HTMLInputElement).value) / 100)
}

function deviceIcon(device: AudioDeviceOption): string {
  const text = `${device.id} ${device.label} ${device.backend || ''}`.toLowerCase()
  if (/speaker|soundbar|monitor|音响|音箱|扬声器|喇叭/.test(text)) return 'ph ph-speaker-hifi'
  if (/usb|dac|asio|hifi|exclusive/.test(text)) return 'ph ph-cpu'
  return 'ph ph-headphones'
}

function deviceSpec(device: AudioDeviceOption): string {
  const parts: string[] = []
  if (typeof device.channels === 'number' && device.channels > 0) parts.push(`${device.channels}ch`)
  if (device.sampleRates && device.sampleRates.length > 0) {
    const max = Math.max(...device.sampleRates)
    parts.push(max >= 1000 ? `${(max / 1000).toFixed(max % 1000 === 0 ? 0 : 1)}kHz` : `${max}Hz`)
  }
  if (device.bitDepths && device.bitDepths.length > 0)
    parts.push(`${Math.max(...device.bitDepths)}bit`)
  if (parts.length > 0) return parts.join(' · ')
  if (device.id === 'auto') return '跟随系统默认输出'
  if (device.isDefault) return '系统默认设备'
  return '原生输出设备'
}

function deviceBadges(device: AudioDeviceOption): string[] {
  const badges: string[] = []
  if (device.supportsExclusive) badges.push('独占')
  if (device.nativeDsdSupportState === 'verified' || device.supportsNativeDsd)
    badges.push('Native DSD')
  else if (device.dopSupportState === 'verified' || device.supportsDop) badges.push('DoP')
  return badges
}
</script>

<template>
  <section class="onb-stage" data-scene="06">
    <p class="onb-kicker">声音输出</p>
    <h1 class="onb-title">选择<em>输出设备</em></h1>
    <p class="onb-subtitle">独占模式会占用所选设备，其他应用可能无法使用。</p>
    <div class="onb-panel onb-device-panel" role="radiogroup" aria-label="输出设备">
      <button
        v-for="device in audioOutputDeviceOptions"
        :key="device.id"
        type="button"
        class="onb-device-row"
        :class="{ 'is-selected': audioDevice === device.id }"
        role="radio"
        :aria-checked="audioDevice === device.id"
        :disabled="deviceChanging"
        @click="selectDevice(device.id)"
      >
        <i class="onb-device-icon" :class="deviceIcon(device)"></i>
        <span class="onb-device-copy">
          <strong>{{ device.label }}</strong>
          <small>{{ deviceSpec(device) }}</small>
        </span>
        <span v-for="badge in deviceBadges(device)" :key="badge" class="onb-device-badge">
          {{ badge }}
        </span>
        <span v-if="audioDevice === device.id" class="onb-device-check">
          <i class="ph ph-check"></i>
        </span>
      </button>
    </div>
    <div class="onb-audio-test">
      <button
        type="button"
        class="onb-btn-secondary"
        :disabled="deviceChanging"
        @click="testToneState === 'playing' ? stopTest() : testOutput()"
      >
        <i
          class="ph"
          :class="testToneState === 'playing' ? 'ph-spinner-gap' : 'ph-speaker-high'"
        ></i>
        {{
          testToneState === 'playing'
            ? '停止试听'
            : testToneState === 'error'
              ? '重试试听'
              : '试听当前设备'
        }}
      </button>
      <span v-if="testToneState === 'success'" class="onb-audio-test-ok" role="status"
        >试听结束；没听到声音时可检查音量或更换设备。</span
      >
      <span v-else-if="testToneState === 'error'" class="onb-audio-test-error" role="alert">{{
        testToneError
      }}</span>
      <span v-else role="status">{{
        testToneState === 'playing'
          ? '正在试听：先左声道，再右声道。'
          : '播放约 2 秒测试音：先左声道，再右声道。'
      }}</span>
    </div>
    <label class="onb-test-volume"
      ><i class="ph ph-speaker-high" aria-hidden="true"></i><span>音量</span
      ><input
        type="range"
        min="0"
        max="100"
        :value="Math.round(volume * 100)"
        aria-label="播放器音量"
        :disabled="testToneState === 'playing'"
        @input="changeVolume"
      /><output>{{ Math.round(volume * 100) }}%</output></label
    >
    <div class="onb-cards has-selection" role="radiogroup" aria-label="音频输出模式">
      <button
        type="button"
        class="onb-card is-compact"
        :class="{ 'is-selected': !props.audioExclusiveMode }"
        role="radio"
        :aria-checked="!props.audioExclusiveMode"
        @click="selectMode(false)"
      >
        <span v-if="!props.audioExclusiveMode" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon ph ph-circles-three-plus"></i>
        <span class="onb-card-title">兼容模式</span>
        <span class="onb-card-desc">与其他应用共享声音输出，省心的默认选择</span>
      </button>
      <button
        type="button"
        class="onb-card is-compact"
        :class="{ 'is-selected': props.audioExclusiveMode }"
        role="radio"
        :aria-checked="props.audioExclusiveMode"
        :disabled="!exclusiveAvailable"
        @click="selectMode(true)"
      >
        <span v-if="props.audioExclusiveMode" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon ph ph-lightning"></i>
        <span class="onb-card-title">HiFi 独占</span>
        <span class="onb-card-desc">
          {{
            exclusiveAvailable ? 'WASAPI 独占输出，按位精确、无重采样' : '当前输出后端不支持独占'
          }}
        </span>
      </button>
    </div>
    <div class="onb-panel">
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>响度匹配</strong>
          <span>抹平不同专辑之间的音量差异，深夜切歌不再被吓一跳。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': loudnessMatched }"
          role="switch"
          :aria-checked="loudnessMatched"
          aria-label="响度匹配"
          @click="toggleLoudnessMatch"
        ></button>
      </div>
    </div>
    <p class="onb-hint">设备与链路可随时在 设置 → 播放 中调整；DSD、ASIO 等进阶选项也在那里。</p>
  </section>
</template>
