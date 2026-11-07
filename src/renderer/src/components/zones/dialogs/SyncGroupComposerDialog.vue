<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { SyncGroupCreate } from '../../../../../shared/coreSyncGroups.ts'
import type { ZoneView } from '../../../../../shared/coreZones.ts'
import ZonesDialogFrame from './ZonesDialogFrame.vue'
import ZonesDialogThumb from './ZonesDialogThumb.vue'
import {
  DOWNSTREAM_DELAY_MAX_MS,
  DOWNSTREAM_DELAY_MIN_MS,
  GROUP_MAX_MEMBERS,
  GROUP_MIN_MEMBERS,
  NAME_MAX_LENGTH,
  adoptableQueue,
  clampDelay,
  defaultGroupName,
  formatDelay,
  memberIssue,
  memberReadiness,
  queueIssue,
  queuePosition,
  validateGroupComposer,
  zoneOutputChip,
  zoneOutputLabel,
  zoneTrackLine
} from './zoneDialogRules.ts'
import './zonesDialog.css'

const props = withDefaults(
  defineProps<{
    zones: ZoneView[]
    /** Zone registry revision; Core fences group creation with it. */
    revision: number
    busy?: boolean
    error?: string | null
    initialMemberIds?: string[]
  }>(),
  { busy: false, error: null, initialMemberIds: () => [] }
)

const emit = defineEmits<{
  close: []
  submit: [payload: SyncGroupCreate]
}>()

const membersLabelId = useId()
const queueLabelId = useId()
const queueName = useId()
const nameId = useId()
const nameHintId = useId()
const noteId = useId()

const eligibleIds = computed(
  () => new Set(props.zones.filter((zone) => !memberIssue(zone)).map((zone) => zone.id))
)

function initialMembers(): string[] {
  const picked = new Set<string>()
  for (const id of props.initialMemberIds) {
    if (picked.size >= GROUP_MAX_MEMBERS) break
    if (eligibleIds.value.has(id)) picked.add(id)
  }
  return [...picked]
}

/** Selection order: the first member chosen is the one the page started from. */
const selectedIds = ref<string[]>(initialMembers())
const delays = ref<Record<string, number>>({})
const sourceChoice = ref<string | null>(null)
const name = ref('')

// A zone that is removed or grouped elsewhere leaves the selection.
watch(eligibleIds, (ids) => {
  const kept = selectedIds.value.filter((id) => ids.has(id))
  if (kept.length !== selectedIds.value.length) selectedIds.value = kept
})

const atMax = computed(() => selectedIds.value.length >= GROUP_MAX_MEMBERS)
/** Selected zones in wall order. */
const members = computed(() => props.zones.filter((zone) => selectedIds.value.includes(zone.id)))

const rows = computed(() =>
  props.zones.map((zone) => {
    const issue = memberIssue(zone)
    const selected = selectedIds.value.includes(zone.id)
    const readiness = memberReadiness(zone)
    const output = zoneOutputLabel(zone)
    return {
      zone,
      issue,
      selected,
      locked: Boolean(issue) || (!selected && atMax.value),
      readiness,
      // An offline bridge reads as red, as on the wall; other gaps are warnings.
      tone: readiness.ready ? 'success' : (zoneOutputChip(zone)?.tone ?? 'warning'),
      // When the chip already names the output, the line says what the zone holds instead.
      meta: output === readiness.label ? zoneTrackLine(zone) : output,
      delay: delays.value[zone.id] ?? 0
    }
  })
)
const autofocusId = computed(() => {
  const open = rows.value.filter((row) => !row.locked)
  return (open.find((row) => !row.selected) ?? open[0])?.zone.id ?? null
})
const unready = computed(() => members.value.filter((zone) => !memberReadiness(zone).ready))

/** The user's pick, else the first selected member whose queue can be adopted. */
const sourceId = computed(() => {
  const list = members.value
  const picked = list.find((zone) => zone.id === sourceChoice.value && adoptableQueue(zone))
  if (picked) return picked.id
  for (const id of selectedIds.value) {
    const zone = list.find((candidate) => candidate.id === id)
    if (zone && adoptableQueue(zone)) return zone.id
  }
  return null
})
const queueRows = computed(() =>
  members.value.map((zone) => ({
    zone,
    issue: queueIssue(zone.queue),
    meta: `${zoneTrackLine(zone)} · ${queuePosition(zone.queue)}`
  }))
)

const suggestedName = computed(() => defaultGroupName(members.value.map((zone) => zone.name)))
const groupName = computed(() => name.value.trim() || suggestedName.value)
const nameHint = computed(() =>
  suggestedName.value ? `留空则使用「${suggestedName.value}」` : '留空则用成员的名称组合'
)

const result = computed(() =>
  validateGroupComposer({
    zones: props.zones,
    revision: props.revision,
    name: groupName.value,
    memberIds: selectedIds.value,
    sourceId: sourceId.value,
    delays: delays.value
  })
)

const note = computed(() => {
  const value = result.value
  if (value.ok) return ''
  if (
    members.value.length >= GROUP_MIN_MEMBERS &&
    queueRows.value.every((row) => row.issue) &&
    !sourceId.value
  ) {
    return '所选声区的队列都是空的，先为其中一个选择音乐'
  }
  return value.reason
})

function toggle(id: string, event: Event): void {
  const input = event.target as HTMLInputElement
  if (!input.checked) {
    selectedIds.value = selectedIds.value.filter((selected) => selected !== id)
    return
  }
  if (selectedIds.value.includes(id)) return
  if (atMax.value || !eligibleIds.value.has(id)) {
    input.checked = false
    return
  }
  selectedIds.value = [...selectedIds.value, id]
}

function setDelay(id: string, event: Event): void {
  const value = clampDelay(Number((event.target as HTMLInputElement).value))
  delays.value = { ...delays.value, [id]: value }
}

/** How far the drawn track fills for a delay, as a CSS length. */
function delayFill(value: number): string {
  const span = DOWNSTREAM_DELAY_MAX_MS - DOWNSTREAM_DELAY_MIN_MS
  return `${((clampDelay(value) - DOWNSTREAM_DELAY_MIN_MS) / span) * 100}%`
}

function submit(): void {
  const value = result.value
  if (props.busy || !value.ok) return
  emit('submit', value.payload)
}
</script>

<template>
  <ZonesDialogFrame
    title="建立同步组"
    description="选择 2–4 个声区，采用其中一份队列。编组后暂停待播，各自原队列保留。"
    wide
    :busy="busy"
    :error="error"
    @close="emit('close')"
    @submit="submit"
  >
    <section class="zones-dialog-section">
      <div class="zones-dialog-section-head">
        <h3 :id="membersLabelId" class="zones-dialog-label">成员</h3>
        <span class="zones-dialog-count">已选 {{ selectedIds.length }} / {{ GROUP_MAX_MEMBERS }}</span>
      </div>
      <div class="zones-dialog-choices" role="group" :aria-labelledby="membersLabelId">
        <div
          v-for="row in rows"
          :key="row.zone.id"
          class="zones-dialog-member"
          :class="{ 'is-unavailable': row.issue }"
        >
          <label class="zones-dialog-member-row">
            <input
              class="zones-dialog-sr-input"
              type="checkbox"
              :checked="row.selected"
              :disabled="row.locked"
              :data-autofocus="autofocusId === row.zone.id ? '' : undefined"
              @change="toggle(row.zone.id, $event)"
            />
            <ZonesDialogThumb :zone="row.zone" />
            <span class="zones-dialog-choice-text">
              <span class="zones-dialog-choice-title">
                <span class="zones-dialog-choice-name">{{ row.zone.name }}</span>
                <span
                  v-if="!row.issue"
                  class="zones-dialog-chip"
                  :class="`zones-dialog-chip--${row.tone}`"
                >
                  {{ row.readiness.label }}
                </span>
              </span>
              <span class="zones-dialog-choice-meta">{{ row.meta }}</span>
              <span v-if="row.issue" class="zones-dialog-choice-reason">
                <i class="ph ph-link-simple" aria-hidden="true" />{{ row.issue }}
              </span>
            </span>
            <span class="zones-dialog-indicator zones-dialog-indicator--check" aria-hidden="true">
              <i class="ph-bold ph-check" />
            </span>
          </label>
          <div v-if="row.selected" class="zones-dialog-delay">
            <span class="zones-dialog-delay-label" aria-hidden="true">下游延迟</span>
            <span class="zones-dialog-range" :style="{ '--zones-dialog-range': delayFill(row.delay) }">
              <input
                class="zones-dialog-range-input"
                type="range"
                :min="DOWNSTREAM_DELAY_MIN_MS"
                :max="DOWNSTREAM_DELAY_MAX_MS"
                step="1"
                :value="row.delay"
                :aria-label="`「${row.zone.name}」的下游延迟`"
                :aria-valuetext="formatDelay(row.delay)"
                @input="setDelay(row.zone.id, $event)"
              />
            </span>
            <span
              class="zones-dialog-delay-value"
              :class="{ 'is-uncalibrated': row.delay === 0 }"
              aria-hidden="true"
            >
              {{ formatDelay(row.delay) }}
            </span>
          </div>
        </div>
      </div>
      <ul class="zones-dialog-hints">
        <li>
          <i class="ph ph-timer" aria-hidden="true" />
          <span><strong>下游延迟</strong> 0–250 ms；0 表示 DAC 模拟输出尚未校准。建组后不能再调整。</span>
        </li>
        <li :class="{ 'is-warning': unready.length }">
          <i class="ph" :class="unready.length ? 'ph-warning' : 'ph-info'" aria-hidden="true" />
          <span>同步播放需要每个成员都连接支持时钟自适应的输出桥。</span>
        </li>
      </ul>
    </section>

    <section class="zones-dialog-section">
      <h3 :id="queueLabelId" class="zones-dialog-label">采用哪份队列</h3>
      <div
        v-if="queueRows.length"
        class="zones-dialog-choices"
        role="radiogroup"
        :aria-labelledby="queueLabelId"
      >
        <label
          v-for="row in queueRows"
          :key="row.zone.id"
          class="zones-dialog-choice"
          :class="{ 'is-unavailable': row.issue }"
        >
          <input
            class="zones-dialog-sr-input"
            type="radio"
            :name="queueName"
            :value="row.zone.id"
            :checked="sourceId === row.zone.id"
            :disabled="Boolean(row.issue)"
            @change="sourceChoice = row.zone.id"
          />
          <ZonesDialogThumb :zone="row.zone" music small />
          <span class="zones-dialog-choice-text">
            <span class="zones-dialog-choice-title">
              <span class="zones-dialog-choice-name">{{ row.zone.name }}</span>
            </span>
            <span v-if="row.issue" class="zones-dialog-choice-reason">{{ row.issue }}</span>
            <span v-else class="zones-dialog-choice-meta">{{ row.meta }}</span>
          </span>
          <span class="zones-dialog-indicator zones-dialog-indicator--radio" aria-hidden="true" />
        </label>
      </div>
      <p v-else class="zones-dialog-notice">
        <i class="ph ph-queue" aria-hidden="true" />
        <span>选择成员后，在这里决定从哪份队列开始。</span>
      </p>
    </section>

    <div class="zones-dialog-field">
      <label :for="nameId" class="zones-dialog-label">组名</label>
      <div class="zones-dialog-input-wrap zones-dialog-input-wrap--plain">
        <input
          :id="nameId"
          v-model="name"
          class="zones-dialog-input"
          type="text"
          :maxlength="NAME_MAX_LENGTH"
          :placeholder="suggestedName || '例如：全屋音乐'"
          autocomplete="off"
          spellcheck="false"
          :aria-describedby="nameHintId"
        />
      </div>
      <p :id="nameHintId" class="zones-dialog-field-message">{{ nameHint }}</p>
    </div>

    <template #footer>
      <p v-if="note" :id="noteId" class="zones-dialog-footer-note">{{ note }}</p>
      <button type="button" class="zones-dialog-button" :disabled="busy" @click="emit('close')">
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
          :class="busy ? 'ph-circle-notch zones-dialog-spin' : 'ph-link-simple'"
          aria-hidden="true"
        />
        {{ busy ? '正在建立' : '建立同步组' }}
      </button>
    </template>
  </ZonesDialogFrame>
</template>
