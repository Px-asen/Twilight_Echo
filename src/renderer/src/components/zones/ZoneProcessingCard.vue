<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CoreDspState } from '../../../../shared/coreDsp.ts'
import type { AudioProcessingSettings } from '../../../../shared/audioEngineTypes.ts'
import { moveRadioFocus } from './radioFocus.ts'

const props = defineProps<{
  dsp: CoreDspState | null
  error: string | null
  busy: boolean
  owner: string
  /** Editing a member's processing briefly pauses its sync group. */
  grouped: boolean
}>()
const emit = defineEmits<{
  edit: [settings: Partial<AudioProcessingSettings>]
  scene: [id: string | null]
}>()

type SwitchKey = 'dspEnabled' | 'directMode' | 'eqEnabled' | 'crossfeedEnabled'
const processing = computed(() => props.dsp?.processing ?? null)
const switches = computed(() => {
  const value = processing.value
  if (!value) return []
  const bands = value.eqBands?.filter((band) => band.enabled !== false).length ?? 0
  return [
    {
      key: 'dspEnabled' as SwitchKey,
      label: 'DSP 处理',
      hint: '关闭后不运行任何处理节点',
      on: value.dspEnabled,
      disabled: false
    },
    {
      key: 'directMode' as SwitchKey,
      label: '直通',
      hint: '保留设置，暂时输出未经处理的信号',
      on: value.directMode,
      disabled: false
    },
    {
      key: 'eqEnabled' as SwitchKey,
      label: '均衡器',
      hint: `${value.eqMode === 'parametric' ? '参量' : '图示'}均衡 · ${bands} 段`,
      on: value.eqEnabled,
      disabled: !value.dspEnabled || value.directMode
    },
    {
      key: 'crossfeedEnabled' as SwitchKey,
      label: '交叉馈送',
      hint: '让耳机的声像更接近音箱',
      on: value.crossfeedEnabled,
      disabled: !value.dspEnabled || value.directMode
    }
  ]
})
const state = computed(() => {
  const value = processing.value
  if (!value) return { label: '读取中', tone: 'neutral' }
  if (value.directMode) return { label: '直通', tone: 'info' }
  if (!value.dspEnabled) return { label: '未处理', tone: 'neutral' }
  return { label: '处理中', tone: 'warning' }
})

/** Preamp follows the slider locally and is sent when the drag ends. */
const preampDraft = ref<number | null>(null)
const preamp = computed(() => preampDraft.value ?? processing.value?.eqPreamp ?? 0)
watch(
  () => processing.value?.eqPreamp,
  () => {
    preampDraft.value = null
  }
)
const preampLocked = computed(
  () =>
    props.busy ||
    !processing.value?.eqEnabled ||
    !processing.value?.dspEnabled ||
    Boolean(processing.value?.directMode)
)
/** The fill grows from 0 dB in either direction, so a cut reads as a cut. */
const PREAMP_MIN = -24
const PREAMP_MAX = 12
const preampPercent = (value: number): number => ((value - PREAMP_MIN) / (PREAMP_MAX - PREAMP_MIN)) * 100
const preampFill = computed(() => {
  const zero = preampPercent(0)
  const value = preampPercent(preamp.value)
  return {
    '--zone-range-zero': `${zero.toFixed(2)}%`,
    '--zone-range-left': `${Math.min(zero, value).toFixed(2)}%`,
    '--zone-range': `${Math.abs(value - zero).toFixed(2)}%`
  }
})
function formatDb(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`
}
function onPreampInput(event: Event): void {
  preampDraft.value = Number((event.target as HTMLInputElement).value)
}
function onPreampChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('edit', { eqPreamp: value })
}

const scenes = computed(() => props.dsp?.scenes.scenes ?? [])
const activeScene = computed(() => props.dsp?.scenes.activeSceneId ?? null)
const pinnedScene = computed(() => props.dsp?.scenes.pinnedSceneId ?? null)
</script>

<template>
  <section class="zones-panel zone-processing" aria-labelledby="zone-processing-title">
    <header class="zones-panel-head">
      <div>
        <h3 id="zone-processing-title">处理</h3>
        <p>「{{ owner }}」的 DSP 设置，各声区互不影响</p>
      </div>
      <span class="zones-chip" :class="`is-${state.tone}`">{{ state.label }}</span>
    </header>

    <p v-if="error" class="zones-inline-error" role="status">
      <i class="ph ph-warning-circle" aria-hidden="true" />{{ error }}
    </p>
    <div v-if="!dsp && !error" class="zone-processing-loading" aria-busy="true">
      <span v-for="index in 3" :key="index" class="zone-path-ghost" />
    </div>

    <template v-if="dsp">
      <ul class="zone-switches">
        <li v-for="entry in switches" :key="entry.key" :class="{ 'is-disabled': entry.disabled }">
          <span class="zone-switch-copy">
            <strong :id="`zone-switch-${entry.key}`">{{ entry.label }}</strong>
            <small>{{ entry.hint }}</small>
          </span>
          <button
            type="button"
            role="switch"
            class="zones-switch"
            :aria-checked="entry.on"
            :aria-labelledby="`zone-switch-${entry.key}`"
            :disabled="busy || entry.disabled"
            @click="emit('edit', { [entry.key]: !entry.on })"
          >
            <span aria-hidden="true" />
          </button>
        </li>
      </ul>

      <div class="zone-preamp" :class="{ 'is-disabled': preampLocked && !busy }">
        <span class="zone-preamp-copy">
          <label for="zone-preamp">前级增益</label>
          <small>均衡器之前的整体增益</small>
        </span>
        <span class="zone-range is-bipolar" :style="preampFill">
          <input
            id="zone-preamp"
            type="range"
            :min="PREAMP_MIN"
            :max="PREAMP_MAX"
            step="0.5"
            :value="preamp"
            :disabled="preampLocked"
            :aria-valuetext="formatDb(preamp)"
            @input="onPreampInput"
            @change="onPreampChange"
          />
        </span>
        <output for="zone-preamp">{{ formatDb(preamp) }}</output>
      </div>

      <div v-if="scenes.length" class="zone-scenes">
        <h4>场景</h4>
        <div
          class="zone-scene-list"
          role="radiogroup"
          aria-label="DSP 场景"
          @keydown="moveRadioFocus"
        >
          <button
            type="button"
            role="radio"
            class="zone-scene"
            :aria-checked="activeScene === null"
            :disabled="busy"
            @click="emit('scene', null)"
          >
            不使用场景
          </button>
          <button
            v-for="scene in scenes"
            :key="scene.id"
            type="button"
            role="radio"
            class="zone-scene"
            :aria-checked="activeScene === scene.id"
            :disabled="busy || !scene.enabled"
            :title="scene.enabled ? undefined : '该场景已停用'"
            @click="emit('scene', scene.id)"
          >
            <i v-if="pinnedScene === scene.id" class="ph ph-push-pin" aria-hidden="true" />
            {{ scene.name }}
          </button>
        </div>
      </div>
      <p class="zones-hint">
        {{
          grouped
            ? '调整成员的处理时，同步组会短暂暂停，完成后自动继续。'
            : '只作用于此声区；其他声区和输出桥不会重复处理。'
        }}
      </p>
    </template>
  </section>
</template>
