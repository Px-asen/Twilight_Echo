<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { finishNativeDialog, manageNativeDialog } from '@renderer/composables/useNativeDialog'
import MotionTransition from './MotionTransition.vue'
import './nativeDialogMotion.css'

// Legacy overlays share the same completion, interruption and focus lifecycle.
const props = defineProps<{ overlay?: boolean; restoreFocus?: HTMLElement | null }>()
const overlayFocus = new Map<HTMLElement, HTMLElement | null>()
const dialogs = new Set<HTMLDialogElement>()
function beforeEnter(element: Element): void {
  if (element instanceof HTMLElement) {
    element.inert = false
    if (props.overlay && !overlayFocus.has(element)) {
      overlayFocus.set(
        element,
        props.restoreFocus ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      )
    }
  }
  if (!(element instanceof HTMLDialogElement)) return
  dialogs.add(element)
  manageNativeDialog(element)
  element.inert = false
  element.removeEventListener('cancel', blockCancel, true)
}
function blockCancel(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}
function beforeLeave(element: Element): void {
  if (element instanceof HTMLElement) element.inert = true
  if (element instanceof HTMLDialogElement) {
    element.inert = true
    element.addEventListener('cancel', blockCancel, true)
  }
}
function afterLeave(element: Element): void {
  if (element instanceof HTMLElement && overlayFocus.has(element)) {
    const target = overlayFocus.get(element)
    overlayFocus.delete(element)
    const current = document.activeElement
    if (
      target?.isConnected &&
      (!current || current === document.body || element.contains(current)) &&
      !document.querySelector('dialog:modal')
    ) {
      target.focus({ preventScroll: true })
    }
  }
  if (!(element instanceof HTMLDialogElement)) return
  finishNativeDialog(element)
  dialogs.delete(element)
}
function leaveCancelled(element: Element): void {
  if (element instanceof HTMLElement) element.inert = false
  if (element instanceof HTMLDialogElement) {
    element.inert = false
    element.removeEventListener('cancel', blockCancel, true)
  }
}
onBeforeUnmount(() => {
  for (const dialog of dialogs) finishNativeDialog(dialog)
  dialogs.clear()
  for (const element of overlayFocus.keys()) afterLeave(element)
})
</script>

<template>
  <MotionTransition
    name="dialog"
    :panel="overlay ? '[data-dialog-panel]' : undefined"
    appear
    @before-enter="beforeEnter"
    @before-leave="beforeLeave"
    @after-leave="afterLeave"
    @leave-cancelled="leaveCancelled"
  >
    <slot />
  </MotionTransition>
</template>
