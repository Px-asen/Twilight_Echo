<script setup lang="ts">
import { computed } from 'vue'
import type { ZoneView } from '../../../../../shared/coreZones.ts'
import ZonesDialogFrame from './ZonesDialogFrame.vue'
import ZonesDialogThumb from './ZonesDialogThumb.vue'
import {
  playbackLabel,
  zoneOutputChip,
  zoneOutputLabel,
  zoneRemoveBlockedReason,
  zoneTrackLine
} from './zoneDialogRules.ts'
import './zonesDialog.css'

const props = withDefaults(
  defineProps<{
    zone: ZoneView
    busy?: boolean
    error?: string | null
  }>(),
  { busy: false, error: null }
)

const emit = defineEmits<{
  close: []
  submit: []
}>()

const blocked = computed(() => zoneRemoveBlockedReason(props.zone))
const chip = computed(() => zoneOutputChip(props.zone))
const queued = computed(() => props.zone.queue?.total ?? 0)

function submit(): void {
  if (props.busy || blocked.value) return
  emit('submit')
}
</script>

<template>
  <ZonesDialogFrame
    :title="`移除「${zone.name}」？`"
    description="停止该声区并断开它的输出桥。"
    :busy="busy"
    :error="error"
    @close="emit('close')"
    @submit="submit"
  >
    <div class="zones-dialog-summary">
      <ZonesDialogThumb :zone="zone" />
      <span class="zones-dialog-choice-text">
        <span class="zones-dialog-choice-title">
          <span class="zones-dialog-choice-name">{{ zone.name }}</span>
          <span v-if="chip" class="zones-dialog-chip" :class="`zones-dialog-chip--${chip.tone}`">
            {{ chip.label }}
          </span>
        </span>
        <span class="zones-dialog-choice-meta">{{ zoneOutputLabel(zone) }}</span>
        <span class="zones-dialog-choice-meta">{{ playbackLabel(zone) }} · {{ zoneTrackLine(zone) }}</span>
      </span>
    </div>

    <p v-if="blocked" class="zones-dialog-notice zones-dialog-notice--warning">
      <i class="ph ph-warning" aria-hidden="true" />
      <span>{{ blocked }}</span>
    </p>
    <ul v-else-if="queued > 0" class="zones-dialog-hints">
      <li>
        <i class="ph ph-info" aria-hidden="true" />
        <span>「{{ zone.name }}」队列里的 {{ queued }} 首不会保留；想接着听，先把它接力到另一个声区。</span>
      </li>
    </ul>

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
        :disabled="busy || Boolean(blocked)"
      >
        <i
          class="ph"
          :class="busy ? 'ph-circle-notch zones-dialog-spin' : 'ph-trash'"
          aria-hidden="true"
        />
        {{ busy ? '正在移除' : '移除' }}
      </button>
    </template>
  </ZonesDialogFrame>
</template>
