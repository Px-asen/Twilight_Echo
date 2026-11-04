<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { BridgePeer } from '../../../../../shared/audioBridge.ts'
import ZonesDialogFrame from './ZonesDialogFrame.vue'
import ZonesInvitationField from './ZonesInvitationField.vue'
import {
  NAME_MAX_LENGTH,
  readBridgeInvitation,
  validateZoneName,
  zoneCreateBlockedReason
} from './zoneDialogRules.ts'
import './zonesDialog.css'

const props = withDefaults(
  defineProps<{
    count: number
    limit: number
    busy?: boolean
    error?: string | null
    /** Names already on the wall; a duplicate is refused before Core sees it. */
    takenNames?: string[]
  }>(),
  { busy: false, error: null, takenNames: () => [] }
)

const emit = defineEmits<{
  close: []
  submit: [payload: { name: string; peer: BridgePeer | null }]
}>()

const SUGGESTIONS = ['书房', '客厅', '卧室', '厨房', '餐厅', '阳台']

const nameId = useId()
const nameErrorId = useId()
const nameInput = ref<HTMLInputElement | null>(null)
const invitationField = ref<InstanceType<typeof ZonesInvitationField> | null>(null)

const name = ref('')
const invitation = ref('')
const attempted = ref(false)

const blocked = computed(() => zoneCreateBlockedReason(props.count, props.limit))
const nameIssue = computed(() => validateZoneName(name.value, props.takenNames))
// A clash is worth saying at once; an empty name only once the user tries to create.
const nameError = computed(() =>
  nameIssue.value && (attempted.value || name.value.trim()) ? nameIssue.value : null
)
const suggestions = computed(() =>
  SUGGESTIONS.filter((suggestion) => !props.takenNames.some((taken) => taken.trim() === suggestion))
)
const reading = computed(() => readBridgeInvitation(invitation.value))

const slots = computed(() =>
  Array.from({ length: Math.max(0, Math.min(props.limit, 8)) }, (_, index) => index + 1)
)
const capacity = computed(() =>
  blocked.value
    ? `已有 ${props.count} 个声区，最多 ${props.limit} 个`
    : `这是第 ${props.count + 1} 个声区，最多 ${props.limit} 个`
)

function pick(suggestion: string): void {
  name.value = suggestion
}

function submit(): void {
  if (props.busy || blocked.value) return
  attempted.value = true
  if (nameIssue.value) {
    nameInput.value?.focus()
    return
  }
  const { peer, error } = reading.value
  if (error) {
    invitationField.value?.focus()
    return
  }
  emit('submit', { name: name.value.trim(), peer })
}
</script>

<template>
  <ZonesDialogFrame
    title="新建声区"
    description="每个声区有自己的队列、音量与处理，可以和其他声区同时播放不同的音乐。"
    :busy="busy"
    :error="error"
    @close="emit('close')"
    @submit="submit"
  >
    <div class="zones-dialog-capacity">
      <ul class="zones-dialog-capacity-bar" aria-hidden="true">
        <li
          v-for="slot in slots"
          :key="slot"
          :class="{ 'is-used': slot <= count, 'is-new': !blocked && slot === count + 1 }"
        />
      </ul>
      <p class="zones-dialog-field-message">{{ capacity }}</p>
    </div>

    <p v-if="blocked" class="zones-dialog-notice zones-dialog-notice--warning">
      <i class="ph ph-warning" aria-hidden="true" />
      <span>{{ blocked }}</span>
    </p>

    <div class="zones-dialog-field">
      <label :for="nameId" class="zones-dialog-label">名称</label>
      <div
        class="zones-dialog-input-wrap zones-dialog-input-wrap--plain"
        :class="{ 'is-invalid': nameError, 'is-unavailable': blocked }"
      >
        <input
          :id="nameId"
          ref="nameInput"
          v-model="name"
          class="zones-dialog-input"
          type="text"
          :maxlength="NAME_MAX_LENGTH"
          :placeholder="`例如：${suggestions[0] ?? '书房'}`"
          autocomplete="off"
          spellcheck="false"
          required
          :disabled="Boolean(blocked)"
          :aria-invalid="nameError ? 'true' : undefined"
          :aria-describedby="nameError ? nameErrorId : undefined"
          :data-autofocus="blocked ? undefined : ''"
        />
      </div>
      <p v-if="nameError" :id="nameErrorId" class="zones-dialog-field-message is-error">
        <i class="ph ph-warning-circle" aria-hidden="true" />
        <span>{{ nameError }}</span>
      </p>
      <div v-if="suggestions.length" class="zones-dialog-suggestions" role="group" aria-label="常用名称">
        <button
          v-for="suggestion in suggestions"
          :key="suggestion"
          type="button"
          class="zones-dialog-suggestion"
          :aria-pressed="name.trim() === suggestion"
          :disabled="Boolean(blocked)"
          @click="pick(suggestion)"
        >
          {{ suggestion }}
        </button>
      </div>
    </div>

    <ZonesInvitationField
      ref="invitationField"
      v-model="invitation"
      :attempted="attempted"
      :disabled="Boolean(blocked)"
      hint="在输出电脑的「本机输出与输出桥」中复制邀请；也可以先新建，稍后再连接。"
    />

    <p v-if="!blocked && !reading.peer" class="zones-dialog-notice">
      <i class="ph ph-speaker-simple-slash" aria-hidden="true" />
      <span>新声区在连接输出桥之前保持安静，不会借用本机扬声器。</span>
    </p>

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
          :class="busy ? 'ph-circle-notch zones-dialog-spin' : 'ph-plus'"
          aria-hidden="true"
        />
        {{ busy ? '正在创建' : reading.peer ? '创建并连接' : '创建' }}
      </button>
    </template>
  </ZonesDialogFrame>
</template>
