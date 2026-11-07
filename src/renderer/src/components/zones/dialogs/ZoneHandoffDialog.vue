<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { ZoneHandoff, ZoneView } from '../../../../../shared/coreZones.ts'
import ZonesDialogFrame from './ZonesDialogFrame.vue'
import ZonesDialogThumb from './ZonesDialogThumb.vue'
import {
  buildHandoff,
  handoffNeedsReplace,
  handoffResume,
  handoffSourceIssue,
  handoffTargets,
  zoneOutputChip,
  zoneOutputLabel,
  zoneTrackLine
} from './zoneDialogRules.ts'
import './zonesDialog.css'

const props = withDefaults(
  defineProps<{
    zones: ZoneView[]
    sourceId: string
    busy?: boolean
    error?: string | null
  }>(),
  { busy: false, error: null }
)

const emit = defineEmits<{
  close: []
  submit: [payload: ZoneHandoff]
}>()

const targetsLabelId = useId()
const radioName = useId()
const noteId = useId()

const source = computed(() => props.zones.find((zone) => zone.id === props.sourceId) ?? null)
const sourceIssue = computed(() => handoffSourceIssue(source.value))
/** 「本机」 inside a sentence; the generic noun when the zone is gone. */
const sourceRef = computed(() => (source.value ? `「${source.value.name}」` : '源声区'))
const description = computed(() => `${sourceRef.value}会先暂停，再把队列和播放位置复制到目标声区。`)

const targets = computed(() =>
  handoffTargets(props.zones, props.sourceId).map((item) => ({
    ...item,
    chip: zoneOutputChip(item.zone),
    meta: `${zoneOutputLabel(item.zone)} · ${zoneTrackLine(item.zone)}`
  }))
)
const eligibleIds = computed(() =>
  targets.value.filter((item) => !item.reason).map((item) => item.zone.id)
)

// With a single possible target there is nothing to choose.
const targetId = ref<string | null>(eligibleIds.value.length === 1 ? eligibleIds.value[0] : null)
const target = computed(
  () => targets.value.find((item) => item.zone.id === targetId.value && !item.reason)?.zone ?? null
)

// A target that leaves, or joins a group, while the dialog is open is dropped.
watch(eligibleIds, (ids) => {
  if (targetId.value && !ids.includes(targetId.value)) targetId.value = null
})

const needsReplace = computed(() => (target.value ? handoffNeedsReplace(target.value) : false))
const replaceConfirmed = ref(false)
// The confirmation belongs to one target queue; a different queue asks again.
watch([targetId, () => target.value?.queue?.id ?? null], () => {
  replaceConfirmed.value = false
})
const replaceDetail = computed(() => {
  const zone = target.value
  if (!zone?.queue) return ''
  return `「${zone.name}」现有 ${zone.queue.total} 首，接力后由${sourceRef.value}的队列取代。`
})

// Follow the source by default: a playing source keeps playing in the target.
const resumeWanted = ref(source.value?.playback?.state === 'playing')
const resume = computed(() =>
  target.value ? handoffResume(target.value) : { available: true, reason: null }
)
const resumeOn = computed(() => resumeWanted.value && resume.value.available)
const resumeDetail = computed(
  () =>
    resume.value.reason ??
    (target.value ? `「${target.value.name}」从同一位置接着播放` : '在目标声区从同一位置接着播放')
)

const result = computed(() =>
  buildHandoff(source.value, target.value, {
    replace: replaceConfirmed.value,
    resume: resumeWanted.value
  })
)

/** Why 接力 is unavailable, unless the body already says so. */
const note = computed(() => {
  const value = result.value
  if (value.ok || sourceIssue.value || !eligibleIds.value.length) return ''
  return value.reason
})

const autofocusId = computed(() => targetId.value ?? eligibleIds.value[0] ?? null)

function onResume(event: Event): void {
  resumeWanted.value = (event.target as HTMLInputElement).checked
}

function submit(): void {
  const value = result.value
  if (props.busy || !value.ok) return
  emit('submit', value.payload)
}
</script>

<template>
  <ZonesDialogFrame
    title="接力到另一个声区"
    :description="description"
    :busy="busy"
    :error="error"
    @close="emit('close')"
    @submit="submit"
  >
    <div class="zones-dialog-route">
      <div class="zones-dialog-route-end">
        <ZonesDialogThumb :zone="source" music />
        <span class="zones-dialog-choice-text">
          <span class="zones-dialog-choice-title">
            <span class="zones-dialog-choice-name">{{ source?.name ?? '源声区' }}</span>
          </span>
          <span class="zones-dialog-choice-meta">{{ source ? zoneTrackLine(source) : '已不存在' }}</span>
        </span>
      </div>
      <span class="zones-dialog-route-arrow" role="img" aria-label="接力到">
        <i class="ph ph-arrow-right" aria-hidden="true" />
      </span>
      <div class="zones-dialog-route-end" :class="{ 'is-placeholder': !target }">
        <ZonesDialogThumb :zone="target" />
        <span class="zones-dialog-choice-text">
          <span class="zones-dialog-choice-title">
            <span class="zones-dialog-choice-name">{{ target?.name ?? '选择目标声区' }}</span>
          </span>
          <span v-if="target" class="zones-dialog-choice-meta">{{ zoneOutputLabel(target) }}</span>
        </span>
      </div>
    </div>

    <p v-if="sourceIssue" class="zones-dialog-notice zones-dialog-notice--warning">
      <i class="ph ph-warning" aria-hidden="true" />
      <span>{{ sourceIssue }}</span>
    </p>

    <section class="zones-dialog-section">
      <h3 :id="targetsLabelId" class="zones-dialog-label">目标声区</h3>
      <div
        v-if="targets.length"
        class="zones-dialog-choices"
        role="radiogroup"
        :aria-labelledby="targetsLabelId"
      >
        <label
          v-for="item in targets"
          :key="item.zone.id"
          class="zones-dialog-choice"
          :class="{ 'is-unavailable': item.reason }"
        >
          <input
            v-model="targetId"
            class="zones-dialog-sr-input"
            type="radio"
            :name="radioName"
            :value="item.zone.id"
            :disabled="Boolean(item.reason)"
            :data-autofocus="autofocusId === item.zone.id ? '' : undefined"
          />
          <ZonesDialogThumb :zone="item.zone" />
          <span class="zones-dialog-choice-text">
            <span class="zones-dialog-choice-title">
              <span class="zones-dialog-choice-name">{{ item.zone.name }}</span>
              <span
                v-if="item.chip"
                class="zones-dialog-chip"
                :class="`zones-dialog-chip--${item.chip.tone}`"
              >
                {{ item.chip.label }}
              </span>
            </span>
            <span class="zones-dialog-choice-meta">{{ item.meta }}</span>
            <span v-if="item.reason" class="zones-dialog-choice-reason">
              <i class="ph ph-link-simple" aria-hidden="true" />{{ item.reason }}
            </span>
          </span>
          <span class="zones-dialog-indicator zones-dialog-indicator--radio" aria-hidden="true" />
        </label>
      </div>
      <div v-else class="zones-dialog-empty">
        <i class="ph ph-speaker-simple-high" aria-hidden="true" />
        <span>还没有其他声区。新建一个声区并连接输出桥后，就可以把音乐接力过去。</span>
      </div>
    </section>

    <div class="zones-dialog-choices">
      <label v-if="target && needsReplace" class="zones-dialog-option zones-dialog-option--confirm">
        <input v-model="replaceConfirmed" class="zones-dialog-sr-input" type="checkbox" />
        <span class="zones-dialog-indicator zones-dialog-indicator--check" aria-hidden="true">
          <i class="ph-bold ph-check" />
        </span>
        <span class="zones-dialog-option-text">
          <span class="zones-dialog-option-title">替换「{{ target.name }}」当前的队列</span>
          <span class="zones-dialog-option-detail">{{ replaceDetail }}</span>
        </span>
      </label>
      <label
        class="zones-dialog-option zones-dialog-option--switch"
        :class="{ 'is-unavailable': !resume.available }"
      >
        <span class="zones-dialog-option-text">
          <span class="zones-dialog-option-title">接力后继续播放</span>
          <span class="zones-dialog-option-detail">{{ resumeDetail }}</span>
        </span>
        <input
          class="zones-dialog-sr-input"
          type="checkbox"
          role="switch"
          :checked="resumeOn"
          :disabled="!resume.available"
          @change="onResume"
        />
        <span class="zones-dialog-switch" aria-hidden="true" />
      </label>
    </div>

    <template #footer>
      <p v-if="note" :id="noteId" class="zones-dialog-footer-note">{{ note }}</p>
      <button
        type="button"
        class="zones-dialog-button"
        :disabled="busy"
        :data-autofocus="eligibleIds.length ? undefined : ''"
        @click="emit('close')"
      >
        取消
      </button>
      <button
        type="submit"
        class="zones-dialog-button zones-dialog-button--primary"
        :disabled="busy || !result.ok"
        :aria-describedby="note ? noteId : undefined"
      >
        <i
          class="ph"
          :class="busy ? 'ph-circle-notch zones-dialog-spin' : 'ph-arrow-bend-up-right'"
          aria-hidden="true"
        />
        {{ busy ? '正在接力' : '接力' }}
      </button>
    </template>
  </ZonesDialogFrame>
</template>
