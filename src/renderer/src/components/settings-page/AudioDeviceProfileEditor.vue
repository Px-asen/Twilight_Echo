<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AudioDeviceOption } from '../../../../shared/audioEngineTypes.ts'
import {
  stableAudioDeviceId,
  type AudioDeviceProfile
} from '../../../../shared/audioDeviceProfiles.ts'
import { deviceOptionsForOutput } from '../../../../shared/audioDeviceRouting.ts'
import {
  DSD_OUTPUT_MODE_OPTIONS,
  DSD_RATE_POLICY_OPTIONS
} from '../../../../shared/audioProcessingOptions.ts'
import {
  DSP_OUTPUT_SAMPLE_RATE_OPTIONS,
  DSP_RESAMPLER_QUALITY_OPTIONS,
  DSP_DITHER_MODE_OPTIONS
} from '../../../../shared/dspGraph.ts'
import { routingModeOptions } from '@renderer/components/settings-page/types.ts'

const draft = defineModel<AudioDeviceProfile>({ required: true })
const props = defineProps<{
  devices: AudioDeviceOption[]
  scenes: Array<{ id: string; name: string }>
  busy: boolean
}>()
const emit = defineEmits<{ save: []; cancel: [] }>()
const nameInput = ref<HTMLInputElement | null>(null)
const devices = computed(() =>
  deviceOptionsForOutput(draft.value.backend, props.devices).filter((device) =>
    stableAudioDeviceId(device)
  )
)
const volumePercent = computed({
  get: () => Math.round(draft.value.volumeCeiling * 100),
  set: (value: number) => {
    draft.value.volumeCeiling = value / 100
  }
})
const exclusiveAvailable = computed(() => ['wasapi', 'coreaudio'].includes(draft.value.backend))
onMounted(() => nameInput.value?.focus())

function changeBackend(): void {
  draft.value.stableDeviceId = ''
  if (!exclusiveAvailable.value) draft.value.exclusiveMode = false
}
</script>

<template>
  <form class="profile-editor" @submit.prevent="emit('save')" @keydown.esc.stop="emit('cancel')">
    <label class="wide"
      >档案名称<input ref="nameInput" v-model="draft.name" required maxlength="100"
    /></label>
    <label
      >输出后端<select v-model="draft.backend" @change="changeBackend">
        <option value="wasapi">WASAPI</option>
        <option value="asio">ASIO</option>
        <option value="coreaudio">CoreAudio</option>
        <option value="alsa">ALSA</option>
      </select></label
    >
    <label
      >绑定设备<select v-model="draft.stableDeviceId" required>
        <option value="" disabled>请选择设备</option>
        <option
          v-if="
            draft.stableDeviceId &&
            !devices.some((device) => stableAudioDeviceId(device) === draft.stableDeviceId)
          "
          :value="draft.stableDeviceId"
        >
          未连接 · {{ draft.stableDeviceId }}
        </option>
        <option v-for="device in devices" :key="device.id" :value="stableAudioDeviceId(device)">
          {{ device.label }}
        </option>
      </select></label
    >
    <label
      >缓冲帧数（0 为自动）<input
        v-model.number="draft.outputConfig.preferredBufferSize"
        type="number"
        min="0"
        max="2048"
        step="1"
        required
    /></label>
    <label
      >声道路由<select v-model="draft.outputConfig.routingMode">
        <option v-for="option in routingModeOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select></label
    >
    <label
      >软件音量上限 (%)<input
        v-model.number="volumePercent"
        type="number"
        min="0"
        max="100"
        step="1"
        required
    /></label>
    <label
      >DSP 场景<select v-model="draft.dspSceneId">
        <option :value="null">按设备与内容规则选择</option>
        <option
          v-if="draft.dspSceneId && !scenes.some((scene) => scene.id === draft.dspSceneId)"
          :value="draft.dspSceneId"
        >
          场景已删除
        </option>
        <option v-for="scene in scenes" :key="scene.id" :value="scene.id">{{ scene.name }}</option>
      </select></label
    >
    <label
      >输出采样率<select v-model="draft.outputStage.targetSampleRate">
        <option
          v-for="option in DSP_OUTPUT_SAMPLE_RATE_OPTIONS"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select></label
    >
    <label
      >SRC 质量<select v-model="draft.outputStage.resamplerQuality">
        <option
          v-for="option in DSP_RESAMPLER_QUALITY_OPTIONS"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select></label
    >
    <label
      >Dither<select v-model="draft.outputStage.dither">
        <option v-for="option in DSP_DITHER_MODE_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select></label
    >
    <label
      >DSD 输出<select v-model="draft.processing.dsdOutputMode">
        <option v-for="option in DSD_OUTPUT_MODE_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select></label
    >
    <label
      >DSD 倍率策略<select v-model="draft.processing.dsdRatePolicy">
        <option v-for="option in DSD_RATE_POLICY_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select></label
    >
    <label class="check"
      ><input
        v-model="draft.exclusiveMode"
        type="checkbox"
        :disabled="!exclusiveAvailable"
      />独占模式</label
    >
    <label class="check"
      ><input
        v-model="draft.processing.dspEnabled"
        type="checkbox"
        :disabled="draft.processing.directMode"
      />启用 DSP</label
    >
    <label class="check"
      ><input
        v-model="draft.processing.directMode"
        type="checkbox"
        @change="draft.processing.directMode && (draft.processing.dspEnabled = false)"
      />Direct 直通</label
    >
    <label class="check"
      ><input v-model="draft.processing.eqEnabled" type="checkbox" />启用均衡器</label
    >
    <label class="check"
      ><input v-model="draft.processing.convolverEnabled" type="checkbox" />启用卷积器</label
    >
    <label class="check"
      ><input v-model="draft.processing.crossfeedEnabled" type="checkbox" />启用 Crossfeed</label
    >
    <label
      >Crossfeed 强度<input
        v-model.number="draft.processing.crossfeedStrength"
        type="number"
        min="0"
        max="1"
        step="0.05"
        required
    /></label>
    <label
      >响度处理<select v-model="draft.processing.volumeNormalization">
        <option value="off">关闭</option>
        <option value="track">曲目 ReplayGain</option>
        <option value="album">专辑 ReplayGain</option>
        <option value="loudnorm">实时响度归一化</option>
      </select></label
    >
    <label class="check wide"
      ><input v-model="draft.autoApply" type="checkbox" />绑定设备重新连接时自动应用（仅唯一稳定 ID
      匹配）</label
    >
    <p class="wide hint">
      软件音量上限不代表硬件音量或声压保证。应用时保留当前音量，超过上限才降低。DSP
      场景保持引用，场景编辑会影响后续应用。
    </p>
    <p v-if="draft.processing.dsdRoute.enabled" class="wide hint">
      同时恢复已有 DSD 独立路由：{{ draft.processing.dsdRoute.backend || '跟随主后端' }} ·
      {{
        draft.processing.dsdRoute.device || '跟随主设备'
      }}。可先在播放设置中调整后重新从当前配置创建。
    </p>
    <div class="actions wide">
      <button type="submit" :disabled="busy">{{ busy ? '保存中…' : '保存档案' }}</button
      ><button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>

<style scoped>
.profile-editor {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.wide {
  grid-column: 1 / -1;
}
.check {
  flex-direction: row;
  align-items: center;
}
input,
select,
button {
  font: inherit;
  color: inherit;
  border: 1px solid var(--border-color, #8884);
  border-radius: 8px;
  background: var(--bg-secondary, #8881);
  padding: 8px;
  min-width: 0;
}
input[type='checkbox'] {
  accent-color: var(--accent-color);
}
.hint {
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.7;
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
:is(input, select, button):focus-visible {
  outline: 2px solid var(--accent-color, #7c4dff);
  outline-offset: 2px;
}
@media (max-width: 600px) {
  .profile-editor {
    grid-template-columns: 1fr;
  }
}
</style>
