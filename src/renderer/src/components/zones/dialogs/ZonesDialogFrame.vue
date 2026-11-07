<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import './zonesDialog.css'

/**
 * Shell shared by the 声区 dialogs. The native modal <dialog> is the root so
 * NativeDialogTransition can animate it. Below the header the body scrolls on
 * its own; Core's error sits above the footer so it is never scrolled away.
 *
 * While `busy` the dialog cannot be dismissed and its body controls are
 * disabled; afterwards focus returns to where it was.
 */
const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 640px instead of 560px, for the group composer. */
    wide?: boolean
    busy?: boolean
    error?: string | null
  }>(),
  { description: '', wide: false, busy: false, error: null }
)

const emit = defineEmits<{
  close: []
  submit: []
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const body = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const titleId = useId()
const descriptionId = useId()
const scrolled = ref(false)
const clipped = ref(false)

let resizeObserver: ResizeObserver | null = null
let unmounting = false
let backdropPressed = false
let busyFocus: HTMLElement | null = null
let closeAfterBusy = false

useNativeDialog(dialog)

const FOCUSABLE =
  'input:not([type="hidden"]), button, select, textarea, [tabindex]:not([tabindex="-1"])'

function usable(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[inert]') &&
    element.getClientRects().length > 0
  )
}

/** The dialog marks its first control with data-autofocus; else the first usable one. */
function focusInitial(): void {
  const root = dialog.value
  if (!root) return
  const marked = [...root.querySelectorAll<HTMLElement>('[data-autofocus]')].find(usable)
  const first = [...(body.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(usable)
  ;(marked ?? first)?.focus()
}

function measure(): void {
  const element = body.value
  if (!element) return
  scrolled.value = element.scrollTop > 1
  clipped.value = element.scrollTop + element.clientHeight < element.scrollHeight - 1
}

function requestClose(): void {
  if (!props.busy) emit('close')
}

function onSubmit(): void {
  if (!props.busy) emit('submit')
}

/**
 * Chromium force-closes a modal on a repeated Escape without user activation,
 * even though `cancel` is prevented. Keep the page in step with what is shown.
 */
function onNativeClose(): void {
  if (unmounting) return
  if (props.busy) closeAfterBusy = true
  else emit('close')
}

function outside(event: MouseEvent): boolean {
  const rect = dialog.value?.getBoundingClientRect()
  if (!rect) return false
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
}

function onPointerDown(event: PointerEvent): void {
  backdropPressed = event.target === dialog.value && outside(event)
}

function onClick(event: MouseEvent): void {
  const pressed = backdropPressed
  backdropPressed = false
  if (pressed && event.target === dialog.value && outside(event)) requestClose()
}

watch(
  () => props.busy,
  (busy) => {
    const root = dialog.value
    if (!root) return
    if (busy) {
      const active = document.activeElement
      busyFocus = active instanceof HTMLElement && active !== root && root.contains(active) ? active : null
      return
    }
    const previous = busyFocus
    busyFocus = null
    if (closeAfterBusy) {
      closeAfterBusy = false
      emit('close')
      return
    }
    void nextTick(() => {
      if (unmounting) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== root && root.contains(active)) return
      if (previous && root.contains(previous) && usable(previous)) previous.focus()
      else focusInitial()
    })
  }
)

watch(
  () => props.error,
  () => void nextTick(measure)
)

onMounted(() => {
  focusInitial()
  measure()
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(measure)
  if (body.value) resizeObserver.observe(body.value)
  if (content.value) resizeObserver.observe(content.value)
})

onBeforeUnmount(() => {
  unmounting = true
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <dialog
    ref="dialog"
    class="zones-dialog"
    :class="{ 'zones-dialog--wide': wide, 'is-busy': busy }"
    data-te-material="dialog"
    :aria-labelledby="titleId"
    :aria-describedby="description ? descriptionId : undefined"
    :aria-busy="busy ? 'true' : undefined"
    @cancel.prevent="requestClose"
    @close="onNativeClose"
    @pointerdown="onPointerDown"
    @click="onClick"
  >
    <form
      class="zones-dialog-form"
      :class="{ 'is-scrolled': scrolled, 'is-clipped': clipped }"
      novalidate
      @submit.prevent="onSubmit"
    >
      <header class="zones-dialog-header">
        <div class="zones-dialog-heading">
          <h2 :id="titleId" class="zones-dialog-title">{{ title }}</h2>
          <p v-if="description" :id="descriptionId" class="zones-dialog-description">
            {{ description }}
          </p>
        </div>
        <button
          type="button"
          class="zones-dialog-close"
          aria-label="关闭"
          :disabled="busy"
          @click="requestClose"
        >
          <i class="ph ph-x" aria-hidden="true" />
        </button>
      </header>
      <div ref="body" class="zones-dialog-body" @scroll.passive="measure">
        <fieldset class="zones-dialog-fieldset" :disabled="busy">
          <div ref="content" class="zones-dialog-content">
            <slot />
          </div>
        </fieldset>
      </div>
      <div role="alert">
        <p v-if="error" class="zones-dialog-alert">
          <i class="ph ph-warning-circle" aria-hidden="true" />
          <span>{{ error }}</span>
        </p>
      </div>
      <footer class="zones-dialog-footer">
        <slot name="footer" />
      </footer>
    </form>
  </dialog>
</template>
