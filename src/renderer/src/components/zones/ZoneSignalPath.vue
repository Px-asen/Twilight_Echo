<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import {
  PATH_TONE_LABEL,
  signalPathFocus,
  signalPathStages,
  signalPathVerdict,
  type PathNode,
  type PathTone
} from './zonesPresentation.ts'

const props = defineProps<{
  path: CoreSignalPath | null
  /** Bridge peer shown in the last stage caption. */
  peerName?: string | null
  /** Whose path this is: a zone name, or the group member being inspected. */
  owner: string
  grouped?: boolean
}>()

const stages = computed(() =>
  props.path ? signalPathStages(props.path, { peerName: props.peerName }) : []
)
const nodes = computed(() => stages.value.flatMap((stage) => stage.nodes))
const verdict = computed(() => signalPathVerdict(stages.value))
const chosen = ref<string | null>(null)
const focusId = computed(() =>
  chosen.value && nodes.value.some((node) => node.id === chosen.value)
    ? chosen.value
    : signalPathFocus(stages.value)
)
const focused = computed<PathNode | null>(
  () => nodes.value.find((node) => node.id === focusId.value) ?? null
)
const firstNodeId = computed(() => nodes.value[0]?.id)

watch(
  () => props.path?.zoneId,
  () => {
    chosen.value = null
  }
)

const TONE_CHIP: Record<PathTone, string> = {
  exact: 'is-success',
  adapted: 'is-info',
  enhanced: 'is-warning',
  fault: 'is-danger',
  idle: 'is-neutral'
}
const LEGEND: PathTone[] = ['exact', 'adapted', 'enhanced', 'fault']

/** "FLAC · 96 kHz / 24 bit" → a bold lead and a quieter remainder; units never wrap off their number. */
const UNIT_SPACE = /(\d) (?=(?:kHz|Hz|bit|ms|ppm|dB)\b)/g
function valueLines(value: string): { lead: string; rest: string } {
  const [lead = '', ...rest] = value.replace(UNIT_SPACE, '$1\u00a0').split(' · ')
  return { lead, rest: rest.join(' · ') }
}
const readings = computed(() => new Map(nodes.value.map((node) => [node.id, valueLines(node.value)])))
</script>

<template>
  <section class="zones-panel zone-path" aria-labelledby="zone-path-title">
    <header class="zones-panel-head">
      <div>
        <h3 id="zone-path-title">信号链</h3>
        <p v-if="grouped">正在查看成员「{{ owner }}」，点选成员可切换</p>
        <p v-else>{{ owner }} · 从音源到发声设备的每一处变化</p>
      </div>
      <span v-if="path" class="zones-chip" :class="`is-${verdict.tone}`">{{ verdict.label }}</span>
    </header>

    <div v-if="!path" class="zone-path-loading" aria-busy="true">
      <span v-for="index in 5" :key="index" class="zone-path-ghost" />
    </div>

    <template v-else>
      <ol class="zone-path-stages" :data-stage-count="stages.length">
        <li
          v-for="stage in stages"
          :key="stage.id"
          class="zone-path-stage"
          :style="{ '--zone-path-nodes': stage.nodes.length }"
          :data-stage="stage.id"
        >
          <span class="zone-path-stage-label">{{ stage.label }}</span>
          <ol class="zone-path-nodes">
            <li
              v-for="node in stage.nodes"
              :key="node.id"
              class="zone-path-node"
              :class="[
                `is-${node.tone}`,
                { 'is-focused': node.id === focusId, 'is-first': node.id === firstNodeId }
              ]"
            >
              <button
                type="button"
                :aria-pressed="node.id === focusId"
                :aria-label="`${node.label}：${node.value}，${PATH_TONE_LABEL[node.tone]}`"
                @click="chosen = node.id"
              >
                <span class="zone-path-icon" aria-hidden="true"><i class="ph" :class="node.icon" /></span>
                <span class="zone-path-label">{{ node.label }}</span>
                <span class="zone-path-reading" aria-hidden="true">
                  <strong class="zone-path-value">{{ readings.get(node.id)?.lead }}</strong>
                  <small v-if="readings.get(node.id)?.rest" class="zone-path-value-rest">
                    {{ readings.get(node.id)?.rest }}
                  </small>
                </span>
              </button>
            </li>
          </ol>
        </li>
      </ol>

      <div v-if="focused" class="zone-path-focus" aria-live="polite">
        <span class="zone-path-focus-icon" :class="`is-${focused.tone}`" aria-hidden="true">
          <i class="ph" :class="focused.icon" />
        </span>
        <div class="zone-path-focus-copy">
          <div class="zone-path-focus-title">
            <strong>{{ focused.label }}</strong>
            <span class="zones-chip" :class="TONE_CHIP[focused.tone]">
              {{ PATH_TONE_LABEL[focused.tone] }}
            </span>
          </div>
          <p class="zone-path-focus-value">{{ focused.value }}</p>
          <ul v-if="focused.detail.length">
            <li v-for="line in focused.detail" :key="line">{{ line }}</li>
          </ul>
        </div>
      </div>

      <ul class="zone-path-legend" aria-label="图例">
        <li v-for="tone in LEGEND" :key="tone" :class="`is-${tone}`">
          <span aria-hidden="true" />{{ PATH_TONE_LABEL[tone] }}
        </li>
        <li class="zone-path-legend-note">驱动回报的格式；DAC 内部处理未知</li>
      </ul>
    </template>
  </section>
</template>
