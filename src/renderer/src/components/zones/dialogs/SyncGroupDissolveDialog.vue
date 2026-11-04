<script setup lang="ts">
import { computed, useId } from 'vue'
import type { SyncGroupView } from '../../../../../shared/coreSyncGroups.ts'
import type { ZoneView } from '../../../../../shared/coreZones.ts'
import ZonesDialogFrame from './ZonesDialogFrame.vue'
import ZonesDialogThumb from './ZonesDialogThumb.vue'
import { queuePosition, zoneTrackLine } from './zoneDialogRules.ts'
import './zonesDialog.css'

const props = withDefaults(
  defineProps<{
    group: SyncGroupView
    zones: ZoneView[]
    busy?: boolean
    error?: string | null
  }>(),
  { busy: false, error: null }
)

const emit = defineEmits<{
  close: []
  submit: [payload: { groupId: string; revision: number }]
}>()

const membersLabelId = useId()

/** Each member returns to its own queue, which waited untouched while grouped. */
const rows = computed(() =>
  props.group.members.map((member) => {
    const zone = props.zones.find((candidate) => candidate.id === member.zoneId) ?? null
    let back = '声区已移除'
    if (zone) {
      back =
        zone.queue && zone.queue.total > 0
          ? `回到：${zoneTrackLine(zone)} · ${queuePosition(zone.queue)}`
          : '回到空队列'
    }
    return { id: member.zoneId, name: zone?.name ?? '已移除的声区', zone, back }
  })
)

const groupQueue = computed(() => {
  const queue = props.group.queue
  if (!queue || queue.total <= 0) return null
  return props.group.track
    ? `${queue.total} 首 · 当前：${zoneTrackLine(props.group)}`
    : `${queue.total} 首`
})

function submit(): void {
  if (props.busy) return
  emit('submit', { groupId: props.group.id, revision: props.group.revision })
}
</script>

<template>
  <ZonesDialogFrame
    :title="`解除「${group.name}」？`"
    description="所有成员停止，回到各自原来的队列并保持暂停，不保留组队列。"
    :busy="busy"
    :error="error"
    @close="emit('close')"
    @submit="submit"
  >
    <section class="zones-dialog-section">
      <h3 :id="membersLabelId" class="zones-dialog-label">成员</h3>
      <ul class="zones-dialog-list" :aria-labelledby="membersLabelId">
        <li v-for="row in rows" :key="row.id">
          <ZonesDialogThumb :zone="row.zone" music small />
          <span class="zones-dialog-choice-text">
            <span class="zones-dialog-choice-title">
              <span class="zones-dialog-choice-name">{{ row.name }}</span>
            </span>
            <span class="zones-dialog-choice-meta">{{ row.back }}</span>
          </span>
        </li>
      </ul>
    </section>

    <div v-if="groupQueue" class="zones-dialog-summary">
      <span class="zones-dialog-thumb zones-dialog-thumb--sm" aria-hidden="true">
        <i class="ph ph-queue" />
      </span>
      <span class="zones-dialog-choice-text">
        <span class="zones-dialog-choice-title">
          <span class="zones-dialog-choice-name">组队列</span>
          <span class="zones-dialog-chip">不保留</span>
        </span>
        <span class="zones-dialog-choice-meta">{{ groupQueue }}</span>
      </span>
    </div>

    <template #footer>
      <button
        type="button"
        class="zones-dialog-button"
        :disabled="busy"
        data-autofocus
        @click="emit('close')"
      >
        取消
      </button>
      <button
        type="submit"
        class="zones-dialog-button zones-dialog-button--danger"
        :disabled="busy"
      >
        <i
          class="ph"
          :class="busy ? 'ph-circle-notch zones-dialog-spin' : 'ph-link-break'"
          aria-hidden="true"
        />
        {{ busy ? '正在解除' : '停止并解除' }}
      </button>
    </template>
  </ZonesDialogFrame>
</template>
