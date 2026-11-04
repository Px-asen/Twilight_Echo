<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { peerAddress, readBridgeInvitation, shortFingerprint } from './zoneDialogRules.ts'

/**
 * The output-bridge invitation field shared by 新建声区 and 连接输出桥. The
 * invitation carries an access token, so it stays masked unless revealed; a
 * valid one shows only the address and a short certificate fingerprint.
 */
const props = withDefaults(
  defineProps<{
    required?: boolean
    disabled?: boolean
    /** The dialog tried to submit; show every problem, a blank required field included. */
    attempted?: boolean
    /** Quiet guidance shown while the field is empty. */
    hint?: string
    /** Marks the input as the dialog's first focus. */
    initialFocus?: boolean
  }>(),
  { required: false, disabled: false, attempted: false, hint: '', initialFocus: false }
)

const model = defineModel<string>({ required: true })

const inputId = useId()
const messageId = useId()
const input = ref<HTMLInputElement | null>(null)
const revealed = ref(false)
const touched = ref(false)

const reading = computed(() => readBridgeInvitation(model.value))
const error = computed(() => {
  if (reading.value.peer) return null
  if (reading.value.error) return touched.value || props.attempted ? reading.value.error : null
  return props.required && props.attempted ? '请粘贴输出桥邀请' : null
})

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="zones-dialog-field">
    <label :for="inputId" class="zones-dialog-label">
      输出桥邀请<small v-if="!required">（可选）</small>
    </label>
    <div
      class="zones-dialog-input-wrap"
      :class="{ 'is-invalid': error, 'is-unavailable': disabled }"
    >
      <i class="ph ph-link-simple" aria-hidden="true" />
      <input
        :id="inputId"
        ref="input"
        v-model="model"
        class="zones-dialog-input"
        :type="revealed ? 'text' : 'password'"
        maxlength="2048"
        placeholder="twilight-bridge://…"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :disabled="disabled"
        :required="required"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="messageId"
        :data-autofocus="initialFocus ? '' : undefined"
        @blur="touched = true"
        @paste="touched = true"
      />
      <button
        type="button"
        class="zones-dialog-field-action"
        :aria-controls="inputId"
        :aria-label="revealed ? '隐藏邀请' : '显示邀请'"
        :disabled="disabled"
        @click="revealed = !revealed"
      >
        {{ revealed ? '隐藏' : '显示' }}
      </button>
    </div>
    <p
      :id="messageId"
      class="zones-dialog-field-message"
      :class="{ 'is-error': error, 'is-success': reading.peer }"
      aria-live="polite"
    >
      <template v-if="reading.peer">
        <i class="ph ph-shield-check" aria-hidden="true" />
        <span>
          {{ peerAddress(reading.peer) }} · 证书指纹
          <span class="is-tabular">{{ shortFingerprint(reading.peer.fingerprint) }}</span>
        </span>
      </template>
      <template v-else-if="error">
        <i class="ph ph-warning-circle" aria-hidden="true" />
        <span>{{ error }}</span>
      </template>
      <span v-else>{{ hint }}</span>
    </p>
  </div>
</template>
