import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { createFrameCoalescer } from '../../utils/liquidGlassPointer.ts'

/**
 * Auto-hide policy for the mini playbar on the now-playing page.
 *
 * The bar slides out when the pointer comes within `revealThresholdPx` of the
 * viewport bottom, and slides back after `hideDelayMs` once the pointer leaves
 * that band. Anything the user is actively engaged with holds it open: an open
 * floating panel (queue drawer, volume, HiFi console), the pointer resting on
 * the bar, or keyboard focus inside it.
 */

/**
 * Pure reveal test. Non-finite input reads as "no pointer information", which
 * must not trigger a reveal — a stray NaN should leave the bar where it is
 * rather than flashing it open.
 */
export function shouldRevealForPointer(
  pointerY: number,
  viewportHeight: number,
  thresholdPx: number
): boolean {
  if (!Number.isFinite(pointerY) || !Number.isFinite(viewportHeight)) return false
  if (!Number.isFinite(thresholdPx) || thresholdPx < 0) return false
  return viewportHeight - pointerY <= thresholdPx
}

export interface PlaybarAutoHideOptions {
  /** Auto-hide is active; when false the bar is always revealed. */
  autoHide: Ref<boolean>
  revealThresholdPx: Ref<number>
  hideDelayMs: Ref<number>
  /** A floating panel is open — never hide underneath it. */
  keepOpen: Ref<boolean>
  /** The bar element, for hover and focus containment checks. */
  barRef: Ref<HTMLElement | null>
}

export interface PlaybarAutoHide {
  revealed: Ref<boolean>
  /** Reveal, then restart the hide countdown. For track / play-state changes. */
  flashReveal: () => void
  onBarPointerEnter: () => void
  onBarPointerLeave: () => void
  onBarFocusIn: (event?: FocusEvent) => void
  onBarFocusOut: (event: FocusEvent) => void
}

export function usePlaybarAutoHide(options: PlaybarAutoHideOptions): PlaybarAutoHide {
  const revealed = ref(true)
  const pointerInside = ref(false)
  let pointerNearBottom = false
  const focusInside = ref(false)
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let listening = false

  function clearHideTimer(): void {
    if (hideTimer !== null) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function holdsOpen(): boolean {
    return options.keepOpen.value || pointerNearBottom || pointerInside.value || focusInside.value
  }

  function scheduleHide(): void {
    if (!options.autoHide.value || holdsOpen() || hideTimer !== null || !revealed.value) return
    const delay = Math.max(0, options.hideDelayMs.value)
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (!options.autoHide.value || holdsOpen()) return
      revealed.value = false
    }, delay)
  }

  function reveal(): void {
    clearHideTimer()
    revealed.value = true
  }

  const pointerCoalescer = createFrameCoalescer<number>((pointerY) => {
    if (!options.autoHide.value) return
    pointerNearBottom = shouldRevealForPointer(
      pointerY,
      window.innerHeight,
      options.revealThresholdPx.value
    )
    if (pointerNearBottom) {
      reveal()
      return
    }
    if (revealed.value) scheduleHide()
  })

  function onPointerMove(event: PointerEvent): void {
    if (!options.autoHide.value) return
    // Skipping while the tab is hidden keeps this off the frame budget when the
    // window is in the background.
    if (document.hidden) return
    pointerCoalescer.schedule(event.clientY)
  }

  function onPointerLeaveDocument(): void {
    if (!options.autoHide.value) return
    pointerInside.value = false
    pointerNearBottom = false
    scheduleHide()
  }

  function onWindowBlur(): void {
    if (!options.autoHide.value) return
    pointerInside.value = false
    pointerNearBottom = false
    focusInside.value = false
    scheduleHide()
  }

  function startListening(): void {
    if (listening) return
    listening = true
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeaveDocument)
    window.addEventListener('blur', onWindowBlur)
  }

  function stopListening(): void {
    if (!listening) return
    listening = false
    window.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerleave', onPointerLeaveDocument)
    window.removeEventListener('blur', onWindowBlur)
    pointerCoalescer.cancel()
  }

  watch(
    options.autoHide,
    (active) => {
      pointerNearBottom = false
      pointerInside.value = false
      focusInside.value = false
      if (active) {
        startListening()
        // Start hidden so enabling the setting reads as "the bar tucked away",
        // not "the bar is stuck open until I move the mouse".
        clearHideTimer()
        revealed.value = false
        return
      }
      stopListening()
      clearHideTimer()
      revealed.value = true
    },
    { immediate: true }
  )

  watch([options.keepOpen, options.revealThresholdPx, options.hideDelayMs], () => {
    if (!options.autoHide.value) return
    if (holdsOpen()) {
      reveal()
      return
    }
    scheduleHide()
  })

  function flashReveal(): void {
    if (!options.autoHide.value) return
    reveal()
    scheduleHide()
  }

  function onBarPointerEnter(): void {
    pointerInside.value = true
    if (options.autoHide.value) reveal()
  }

  function onBarPointerLeave(): void {
    pointerInside.value = false
    scheduleHide()
  }

  function onBarFocusIn(event?: FocusEvent): void {
    focusInside.value = event
      ? (event.target as HTMLElement | null)?.matches(':focus-visible') === true
      : true
    if (options.autoHide.value && focusInside.value) reveal()
  }

  function onBarFocusOut(event: FocusEvent): void {
    const bar = options.barRef.value
    const next = event.relatedTarget
    // Focus moving between children of the bar must not count as leaving it.
    if (bar && next instanceof Node && bar.contains(next)) return
    focusInside.value = false
    scheduleHide()
  }

  onBeforeUnmount(() => {
    stopListening()
    clearHideTimer()
  })

  return {
    revealed,
    flashReveal,
    onBarPointerEnter,
    onBarPointerLeave,
    onBarFocusIn,
    onBarFocusOut
  }
}
