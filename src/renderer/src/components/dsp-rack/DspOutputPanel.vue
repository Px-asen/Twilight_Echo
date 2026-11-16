<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { formatAudioError } from '@renderer/utils/audioErrorPresentation'
import { dspSampleRate } from '@renderer/utils/dspSignalOverview'
import { describeResampler } from '../../../../shared/resamplerStatus.ts'
import {
  DSP_OUTPUT_SAMPLE_RATE_OPTIONS,
  DSP_TARGET_SAMPLE_RATE_MODE_OPTIONS,
  DSP_RESAMPLER_QUALITY_OPTIONS,
  DSP_RESAMPLER_PHASE_OPTIONS,
  DSP_DITHER_MODE_OPTIONS,
  resolveEffectiveTargetSampleRate,
  type DspOutputStageConfig,
  type DspScene,
  type DspGraphStatus
} from '../../../../shared/dspGraph.ts'

const scene = defineModel<DspScene | null>('scene', { required: true })
const props = defineProps<{ status: DspGraphStatus | null }>()
const emit = defineEmits<{ busy: [busy: boolean] }>()
const store = useAudioOutputDspStore()
const {
  outputInfo,
  playbackInfo,
  audioEngineReady,
  audioOutputConfig,
  audioOutputConfigApplyStatus,
  audioDevice,
  audioDeviceOptions
} = storeToRefs(store)
const bufferDraft = ref(audioOutputConfig.value?.preferredBufferSize ?? 0)
const bufferBusy = ref(false)
const bufferMessage = ref('')
const bufferError = ref('')
const resamplerLabels: Record<string, [string, string]> = {
  native: ['原生', 'Native'],
  high: ['高品质', 'High'],
  ultra: ['超高品质', 'Ultra'],
  soxrHq: ['SoX HQ', 'libsoxr · 需运行时验证'],
  soxrVhq: ['SoX VHQ', '最高品质 · 需运行时验证']
}
const ditherLabels: Record<string, [string, string]> = {
  off: ['关闭', '推荐'],
  tpdf: ['TPDF', '三角分布'],
  highpassTpdf: ['高通 TPDF', '更少可闻噪声'],
  noiseShaped: ['噪声整形', '移至高频']
}
const phaseLabels: Record<string, [string, string]> = {
  linear: ['线性相位 (陡峭)', '零相位失真 · 精确滚降'],
  minimum: ['最小相位 (陡峭)', '零前置振铃 · 瞬态优先'],
  'linear-smooth': ['线性相位 (平缓)', '平滑高频衰减 · 降低振铃'],
  'minimum-smooth': ['最小相位 (平缓)', '自然听感 · 零前置振铃']
}
const clipCount = computed(() => audioEngineReady.value ? props.status?.meter?.clipCount : undefined)
const headroomEnabledModel = computed({
  get: () => scene.value?.graph.outputStage.headroomEnabled === true,
  set: (enabled: boolean) => {
    if (!scene.value) return
    scene.value.graph.outputStage.headroomEnabled = enabled
    if (enabled && scene.value.graph.outputStage.headroomGainDb === undefined) {
      scene.value.graph.outputStage.headroomGainDb = -3
    }
  }
})
const headroomGainModel = computed({
  get: () => scene.value?.graph.outputStage.headroomGainDb ?? -3,
  set: (gainDb: number) => {
    if (!scene.value) return
    scene.value.graph.outputStage.headroomGainDb = Number(gainDb)
  }
})
const selectedDevice = computed(
  () =>
    audioDeviceOptions.value?.find((device) => device.id === audioDevice.value) ??
    audioDeviceOptions.value?.[0] ??
    null
)
const actualRate = computed(
  () =>
    !audioEngineReady.value ? 0 :
    outputInfo.value?.actualSampleRate ||
    outputInfo.value?.outputSampleRate ||
    props.status?.outputStage?.actualSampleRate ||
    playbackInfo.value?.actualSampleRate ||
    playbackInfo.value?.outputSampleRate ||
    0
)
const sourceRate = computed(
  () =>
    playbackInfo.value?.sourceSampleRate ||
    playbackInfo.value?.decodedSampleRate ||
    0
)
const deviceRates = computed(() => selectedDevice.value?.sampleRates)
const targetRateModeModel = computed({
  get: () => {
    const out = scene.value?.graph.outputStage
    if (!out) return 'device'
    if (out.targetSampleRateMode) return out.targetSampleRateMode
    return typeof out.targetSampleRate === 'number' ? 'fixed' : 'device'
  },
  set: (mode) => {
    if (!scene.value) return
    const out = scene.value.graph.outputStage
    out.targetSampleRateMode = mode
    if (mode === 'device') {
      out.targetSampleRate = 'device'
    } else if (mode === 'fixed') {
      if (out.targetSampleRate === 'device' || !out.targetSampleRate) {
        out.targetSampleRate = 96000
      }
    } else {
      const resolved = resolveEffectiveTargetSampleRate(
        { ...out, targetSampleRateMode: mode },
        sourceRate.value,
        deviceRates.value
      )
      out.targetSampleRate = resolved
    }
  }
})
const targetSampleRateModel = computed<DspOutputStageConfig['targetSampleRate']>({
  get: () => scene.value?.graph.outputStage.targetSampleRate ?? 'device',
  set: (value) => {
    if (!scene.value) return
    scene.value.graph.outputStage.targetSampleRate = value
    scene.value.graph.outputStage.targetSampleRateMode = value === 'device' ? 'device' : 'fixed'
  }
})
const resamplerPhaseModel = computed({
  get: () => scene.value?.graph.outputStage.resamplerPhase ?? 'linear',
  set: (phase) => {
    if (!scene.value) return
    scene.value.graph.outputStage.resamplerPhase = phase
  }
})
const bufferOptions = computed(() =>
  [
    ...new Set([
      0,
      64,
      128,
      256,
      512,
      1024,
      2048,
      4096,
      8192,
      16384,
      32768,
      audioOutputConfig.value?.preferredBufferSize ?? 0
    ])
  ].sort((a, b) => a - b)
)
const pending = computed(
  () => bufferBusy.value || audioOutputConfigApplyStatus.value?.state === 'pending'
)
const actualBuffer = computed(() =>
  outputInfo.value && outputInfo.value.bufferSizeFrames > 0
    ? outputInfo.value.bufferSizeFrames
    : playbackInfo.value?.bufferSizeFrames || 0
)
const effectiveLatencyMs = computed(() => {
  if (!audioEngineReady.value) return null
  const direct =
    outputInfo.value?.latencyMs ||
    outputInfo.value?.latencyInfo?.totalLatencyMs ||
    outputInfo.value?.latencyInfo?.outputLatencyMs ||
    outputInfo.value?.latencyInfo?.bufferLatencyMs ||
    playbackInfo.value?.latencyMs ||
    0
  if (direct > 0) return direct
  if (actualBuffer.value > 0 && actualRate.value > 0) {
    return (actualBuffer.value / actualRate.value) * 1000
  }
  return null
})
/** Logarithmic position of a buffer size between 64 and 32768 frames. */
function bufferPosition(frames: number): number {
  if (!frames) return 0
  return Math.max(0, Math.min(100, ((Math.log2(frames) - 6) / 9) * 100))
}
const draftDuration = computed(() =>
  bufferDraft.value && actualRate.value ? (bufferDraft.value / actualRate.value) * 1000 : null
)
const processingCount = computed(
  () => scene.value?.graph.nodes.filter((node) => node.enabled && node.type !== 'meter').length ?? 0
)
const targetLabel = computed(() => {
  const out = scene.value?.graph.outputStage
  if (!out) return '跟随设备'
  const mode = targetRateModeModel.value
  const resolved = resolveEffectiveTargetSampleRate(out, sourceRate.value, deviceRates.value)
  if (mode === 'max-pcm') {
    return typeof resolved === 'number' ? `最高 PCM (${dspSampleRate(resolved)})` : '最高 PCM'
  }
  if (mode === 'power-of-2') {
    return typeof resolved === 'number' ? `2^n 倍频 (${dspSampleRate(resolved)})` : '2^n 倍频'
  }
  const target = out.targetSampleRate
  return target === 'device' || !target ? '跟随设备' : dspSampleRate(target)
})
const outputNoticeText = computed(() => {
  if (!scene.value) return ''
  const out = scene.value.graph.outputStage
  const base = describeResampler(out.resamplerQuality, props.status?.outputStage)
  const phaseLabel = phaseLabels[resamplerPhaseModel.value]?.[0] ?? '线性相位 (陡峭)'
  const headroomLabel = headroomEnabledModel.value
    ? `Headroom ${headroomGainModel.value.toFixed(1)} dB`
    : 'Headroom 关闭'
  return `${base} · 滤波器: ${phaseLabel} · ${headroomLabel}`
})
watch(
  () => audioOutputConfig.value?.preferredBufferSize,
  (value) => {
    bufferDraft.value = value ?? 0
  }
)
async function applyBuffer(): Promise<void> {
  if (pending.value) return
  bufferBusy.value = true
  emit('busy', true)
  bufferMessage.value = ''
  bufferError.value = ''
  try {
    await store.setAudioOutputConfig({ preferredBufferSize: bufferDraft.value })
    if (audioOutputConfigApplyStatus.value?.state !== 'failed')
      bufferMessage.value =
        audioOutputConfigApplyStatus.value?.state === 'pending'
          ? '已提交，等待设备确认。'
          : '缓冲请求已应用；实际值以设备报告为准。'
  } catch (cause) {
    bufferError.value = formatAudioError(cause)
  } finally {
    bufferBusy.value = false
    emit('busy', false)
  }
}
</script>

<template>
  <div class="output-workspace">
    <section v-if="scene" class="output-stage-panel surface-panel">
      <header class="panel-heading">
        <div>
          <h2>场景输出设置</h2>
          <p>属于场景「{{ scene.name }}」，保存更改后应用。</p>
        </div>
        <span class="section-tag" data-mode="draft">保存后生效</span>
      </header>
      <div class="option-group">
        <label class="option-switch">
          <span class="option-copy">
            <strong>Headroom 数字余量管理</strong>
            <small>在 DSP 与重采样前预留衰减余量（推荐 -3.0 dB），消除插值过冲削波 (ISP)。</small>
          </span>
          <input
            v-model="headroomEnabledModel"
            type="checkbox"
            aria-label="Headroom 数字余量管理"
          />
        </label>
        <div v-if="headroomEnabledModel" class="headroom-slider-row">
          <input
            v-model.number="headroomGainModel"
            type="range"
            min="-12"
            max="0"
            step="0.5"
            aria-label="Headroom 衰减分贝"
          />
          <strong>{{ headroomGainModel.toFixed(1) }} dB</strong>
          <span class="clip-indicator" :class="{ active: (clipCount ?? 0) > 0 }">
            {{ clipCount === undefined ? '削波数据未报告' : clipCount > 0 ? `检测到 ${clipCount} 次削波` : '无削波 (0 Clips)' }}
          </span>
        </div>
      </div>
      <div class="option-group">
        <div class="option-copy">
          <strong>升频策略模式</strong
          ><small>跟随设备，或选择固定频率、最高 PCM 与整数倍升频。</small>
        </div>
        <div class="option-chips" role="radiogroup" aria-label="升频策略模式">
          <label
            v-for="mode in DSP_TARGET_SAMPLE_RATE_MODE_OPTIONS"
            :key="mode.value"
            class="option-chip"
          >
            <input
              v-model="targetRateModeModel"
              type="radio"
              name="dsp-output-rate-mode"
              :value="mode.value"
            />
            <span
              ><strong>{{ mode.label }}</strong></span
            >
          </label>
        </div>
      </div>
      <div class="option-group">
        <div class="option-copy">
          <strong>输出采样率</strong><small>默认跟随设备；固定后由 DSP 重采样到目标采样率。</small>
        </div>
        <div class="option-chips" role="radiogroup" aria-label="输出采样率">
          <label
            v-for="item in DSP_OUTPUT_SAMPLE_RATE_OPTIONS"
            :key="item.value"
            class="option-chip"
            :class="{ wide: item.value === 'device' }"
            ><input
              v-model="targetSampleRateModel"
              type="radio"
              name="dsp-output-sample-rate"
              :value="item.value"
            /><span
              ><strong>{{ item.value === 'device' ? '跟随设备' : item.label }}</strong></span
            ></label
          >
        </div>
      </div>
      <div class="option-group">
        <div class="option-copy">
          <strong>重采样质量</strong><small>仅在采样率改变时生效；更高质量需要更多计算资源。</small>
        </div>
        <div class="option-chips" role="radiogroup" aria-label="重采样质量">
          <label
            v-for="item in DSP_RESAMPLER_QUALITY_OPTIONS"
            :key="item.value"
            class="option-chip stacked"
            ><input
              v-model="scene.graph.outputStage.resamplerQuality"
              type="radio"
              name="dsp-output-resampler"
              :value="item.value"
            /><span
              ><strong>{{ resamplerLabels[item.value]?.[0] ?? item.label }}</strong
              ><small>{{ resamplerLabels[item.value]?.[1] }}</small></span
            ></label
          >
        </div>
      </div>
      <label class="option-group option-switch">
        <span class="option-copy"
          ><strong>安全限幅</strong><small>将 PCM 输出限制在数字满幅范围内，防止削波。</small></span
        ><input
          v-model="scene.graph.outputStage.safetyClamp"
          type="checkbox"
          aria-label="安全限幅"
        />
      </label>
      <details class="output-advanced disclosure">
        <summary>
          <span class="summary-copy"
            ><strong>高级设置</strong><small>滤波器相位、抖动与处理顺序</small></span
          ><i class="pi pi-chevron-down summary-chevron" aria-hidden="true"></i>
        </summary>
        <div class="output-advanced-body">
          <div class="option-group">
            <div class="option-copy">
              <strong>滤波器相位</strong>
              <small>线性相位保持群延迟恒定；最小相位消除前置振铃，瞬态响应更凝聚。</small>
            </div>
            <div class="option-chips" role="radiogroup" aria-label="抗混叠滤波器相位">
              <label
                v-for="item in DSP_RESAMPLER_PHASE_OPTIONS"
                :key="item.value"
                class="option-chip stacked"
              >
                <input
                  v-model="resamplerPhaseModel"
                  type="radio"
                  name="dsp-output-resampler-phase"
                  :value="item.value"
                />
                <span>
                  <strong>{{ phaseLabels[item.value]?.[0] ?? item.label }}</strong>
                  <small>{{ phaseLabels[item.value]?.[1] }}</small>
                </span>
              </label>
            </div>
          </div>
          <div class="option-group">
            <div class="option-copy">
              <strong>量化抖动</strong><small>降低输出位深时使用，通常保持关闭。</small>
            </div>
            <div class="option-chips" role="radiogroup" aria-label="量化抖动">
              <label
                v-for="item in DSP_DITHER_MODE_OPTIONS"
                :key="item.value"
                class="option-chip stacked"
                ><input
                  v-model="scene.graph.outputStage.dither"
                  type="radio"
                  name="dsp-output-dither"
                  :value="item.value"
                /><span
                  ><strong>{{ ditherLabels[item.value]?.[0] ?? item.label }}</strong
                  ><small>{{ ditherLabels[item.value]?.[1] }}</small></span
                ></label
              >
            </div>
          </div>
          <ol class="stage-flow" aria-label="输出级处理顺序">
            <li :class="{ off: !headroomEnabledModel }">
              <small>余量管理</small
              ><strong>{{
                headroomEnabledModel ? `${headroomGainModel.toFixed(1)} dB` : '关闭'
              }}</strong>
            </li>
            <li>
              <small>DSP 链</small><strong>{{ processingCount }} 个处理器</strong>
            </li>
            <li>
              <small>目标采样率</small><strong>{{ targetLabel }}</strong>
            </li>
            <li>
              <small>重采样</small
              ><strong>{{ resamplerLabels[scene.graph.outputStage.resamplerQuality]?.[0] }}</strong>
            </li>
            <li>
              <small>滤波器相位</small
              ><strong>{{ phaseLabels[resamplerPhaseModel]?.[0] ?? '线性相位 (陡峭)' }}</strong>
            </li>
            <li>
              <small>抖动</small
              ><strong>{{ ditherLabels[scene.graph.outputStage.dither]?.[0] }}</strong>
            </li>
            <li :class="{ off: !scene.graph.outputStage.safetyClamp }">
              <small>安全限幅</small
              ><strong>{{ scene.graph.outputStage.safetyClamp ? '开启' : '关闭' }}</strong>
            </li>
            <li class="is-device">
              <small>设备实际</small><strong>{{ dspSampleRate(actualRate) }}</strong>
            </li>
          </ol>
        </div>
      </details>
      <p class="notice" aria-live="polite">
        <i class="pi pi-info-circle"></i>{{ outputNoticeText }}
      </p>
    </section>
    <section class="buffer-panel surface-panel">
      <header class="panel-heading">
        <div>
          <h2>设备缓冲</h2>
          <p>在响应速度与播放稳定性之间取得平衡。</p>
        </div>
        <span class="section-tag" data-mode="live">设备 · 立即应用</span>
      </header>
      <div class="buffer-readouts">
        <div>
          <span>实际缓冲</span
          ><strong
            >{{ actualBuffer || '—'
            }}<small>{{ actualBuffer ? 'frames' : '未报告' }}</small></strong
          >
        </div>
        <div>
          <span>输出延迟</span><strong>{{ effectiveLatencyMs?.toFixed(1) ?? '—' }}<small>ms</small></strong>
        </div>
        <div>
          <span>设备采样率</span
          ><strong class="buffer-rate">{{ dspSampleRate(actualRate) }}</strong>
        </div>
      </div>
      <div class="buffer-scale" aria-hidden="true">
        <div class="buffer-track">
          <i
            v-if="actualBuffer"
            class="buffer-marker actual"
            :style="{ left: `${bufferPosition(actualBuffer)}%` }"
            ><b>实际</b></i
          >
          <i
            v-if="bufferDraft"
            class="buffer-marker draft"
            :style="{ left: `${bufferPosition(bufferDraft)}%` }"
            ><b>请求</b></i
          >
        </div>
        <div class="buffer-scale-labels">
          <span>64 · 更低延迟</span><span>32768 · 更高稳定性</span>
        </div>
      </div>
      <div class="buffer-adjustment">
        <label class="field"
          ><span>请求缓冲大小</span
          ><select v-model="bufferDraft" aria-label="请求缓冲大小" :disabled="pending">
            <option v-for="size in bufferOptions" :key="size" :value="size">
              {{ size === 0 ? '自动 · 由驱动决定' : `${size} frames` }}
            </option>
          </select></label
        >
        <span class="buffer-duration">{{
          draftDuration !== null
            ? `缓冲时长 ≈ ${draftDuration.toFixed(1)} ms @ ${dspSampleRate(actualRate)}`
            : '由驱动选择缓冲时长'
        }}</span>
        <button
          class="primary-button"
          :disabled="pending || bufferDraft === (audioOutputConfig?.preferredBufferSize ?? 0)"
          @click="applyBuffer"
        >
          <i :class="pending ? 'pi pi-spinner pi-spin' : 'pi pi-check'"></i
          >{{ pending ? '正在应用…' : '应用缓冲' }}
        </button>
      </div>
      <p class="buffer-notice">
        <i class="pi pi-info-circle"></i
        ><span>应用缓冲会重新打开输出设备，播放可能短暂停顿；驱动可能采用不同于请求的实际值。</span>
      </p>
      <p
        v-if="bufferError || audioOutputConfigApplyStatus?.state === 'failed'"
        class="error"
        role="alert"
      >
        <i class="pi pi-exclamation-triangle"></i
        >{{ bufferError || audioOutputConfigApplyStatus?.error }}
      </p>
      <p v-else-if="bufferMessage" class="buffer-feedback" role="status">
        <i class="pi pi-check-circle"></i>{{ bufferMessage }}
      </p>
    </section>
  </div>
</template>
