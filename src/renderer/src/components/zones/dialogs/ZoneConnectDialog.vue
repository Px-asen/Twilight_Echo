<script setup lang="ts">
import { computed, ref } from 'vue'
import type { BridgePeer } from '../../../../../shared/audioBridge.ts'
import type { ZoneView } from '../../../../../shared/coreZones.ts'
import ZonesDialogFrame from './ZonesDialogFrame.vue'
import ZonesDialogThumb from './ZonesDialogThumb.vue'
import ZonesInvitationField from './ZonesInvitationField.vue'
import {
  readBridgeInvitation,
  zoneConnectBlockedReason,
  zoneOutputChip,
  zoneOutputLabel
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
  submit: [peer: BridgePeer]
}>()

const field = ref<InstanceType<typeof ZonesInvitationField> | null>(null)
const invitation = ref('')
const attempted = ref(false)

const blocked = computed(() => zoneConnectBlockedReason(props.zone))
const chip = computed(() => zoneOutputChip(props.zone))
const reconnect = computed(() => Boolean(props.zone.output?.peerName))
const title = computed(() => (reconnect.value ? '重新连接输出桥' : '连接输出桥'))
const description = computed(
  () => `粘贴输出电脑上复制的邀请，「${props.zone.name}」会通过那台电脑发声。连接后队列保持暂停。`
)
/** Connecting with a new invitation replaces the bridge that is playing now. */
const replacing = computed(() => {
  const output = props.zone.output
  return output?.connected && output.peerName ? output.peerName : null
})
const reading = computed(() => readBridgeInvitation(invitation.value))

function submit(): void {
  if (props.busy || blocked.value) return
  attempted.value = true
  const peer = reading.value.peer
  if (!peer) {
    field.value?.focus()
    return
  }
  emit('submit', peer)
}
</script>

<template>
  <ZonesDialogFrame
    :title="title"
    :description="description"
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
      </span>
    </div>

    <p v-if="blocked" class="zones-dialog-notice zones-dialog-notice--warning">
      <i class="ph ph-warning" aria-hidden="true" />
      <span>{{ blocked }}</span>
    </p>
    <template v-else>
      <ol class="zones-dialog-steps">
        <li>
          <span>
            在输出电脑上打开「声区」页的<strong>本机输出与输出桥</strong>，开启<span
              class="zones-dialog-keep"
              >「允许此电脑作为输出桥」。</span
            >
          </span>
        </li>
        <li><span>点「复制邀请」，把邀请粘贴到下面。</span></li>
      </ol>

      <ZonesInvitationField
        ref="field"
        v-model="invitation"
        required
        initial-focus
        :attempted="attempted"
        hint="邀请以 twilight-bridge:// 开头，包含地址与访问口令。"
      />

      <p v-if="replacing" class="zones-dialog-notice">
        <i class="ph ph-info" aria-hidden="true" />
        <span>「{{ zone.name }}」现在连接着「{{ replacing }}」；用新的邀请连接会替换它。</span>
      </p>
    </template>

    <template #footer>
      <button
        type="button"
        class="zones-dialog-button"
        :disabled="busy"
        :data-autofocus="blocked ? '' : undefined"
        @click="emit('close')"
      >
        取消
      </button>
      <button
        type="submit"
        class="zones-dialog-button zones-dialog-button--primary"
        :disabled="busy || Boolean(blocked)"
      >
        <i
          class="ph"
          :class="busy ? 'ph-circle-notch zones-dialog-spin' : 'ph-link-simple'"
          aria-hidden="true"
        />
        {{ busy ? '正在连接' : reconnect ? '重新连接' : '连接' }}
      </button>
    </template>
  </ZonesDialogFrame>
</template>
