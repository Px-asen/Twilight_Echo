import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { createFocusTrap } from './focusTrap.ts'

// Shared dismiss/a11y helpers for menus, drawers, and dialogs.

// Calls the handler on Escape while `active` is true. Handlers registered later
// run first, so nested surfaces (menu above dialog) close innermost-first.
const escapeStack: Array<() => void> = []
const activationDialogs = new WeakMap<() => void, HTMLDialogElement | null>()
let escapeListenerAttached = false

function currentNativeDialog(): HTMLDialogElement | null {
  return typeof document === 'undefined' ? null : (document.querySelector?.('dialog:modal') ?? null)
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.key !== 'Escape' || escapeStack.length === 0) return
  const entry = escapeStack[escapeStack.length - 1]
  const nativeDialog = currentNativeDialog()
  // A native modal opened above a sidebar owns Escape through its cancel event.
  // A nested custom surface opened inside that same modal still closes first.
  if (nativeDialog && activationDialogs.get(entry) !== nativeDialog) return
  event.preventDefault()
  entry()
}

export function hasDismissLayer(): boolean {
  return escapeStack.length > 0
}

function ensureEscapeListener(): void {
  if (escapeListenerAttached || typeof window === 'undefined') return
  window.addEventListener('keydown', onWindowKeydown)
  escapeListenerAttached = true
}

export function useEscapeToClose(active: Ref<boolean> | (() => boolean), close: () => void): void {
  const isActive = typeof active === 'function' ? active : () => active.value
  const entry = (): void => close()

  const sync = (value: boolean): void => {
    const index = escapeStack.indexOf(entry)
    if (value && index === -1) {
      ensureEscapeListener()
      activationDialogs.set(entry, currentNativeDialog())
      escapeStack.push(entry)
    } else if (!value && index !== -1) {
      escapeStack.splice(index, 1)
      activationDialogs.delete(entry)
      if (escapeStack.length === 0 && escapeListenerAttached && typeof window !== 'undefined') {
        window.removeEventListener('keydown', onWindowKeydown)
        escapeListenerAttached = false
      }
    }
  }

  onMounted(() => sync(isActive()))
  watch(isActive, sync)
  onBeforeUnmount(() => sync(false))
}

// Keeps Tab focus inside `container` while `active` is true and moves focus to
// the first focusable element when the surface opens (aria-modal made real).
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean> | (() => boolean)
): void {
  const isActive = typeof active === 'function' ? active : () => active.value
  let trap: ReturnType<typeof createFocusTrap> | null = null
  const sync = (): void => {
    if (isActive()) trap?.activate()
    else trap?.deactivate()
  }
  onMounted(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    trap = createFocusTrap(() => container.value, {
      window,
      document,
      requestFrame: requestAnimationFrame,
      cancelFrame: cancelAnimationFrame
    })
    sync()
  })
  watch([isActive, () => container.value], sync, { flush: 'post' })
  onBeforeUnmount(() => trap?.deactivate())
}
