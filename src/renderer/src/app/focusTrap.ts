const SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface FocusEnvironment {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'activeElement' | 'body'>
  requestFrame: typeof requestAnimationFrame
  cancelFrame: typeof cancelAnimationFrame
}

const traps: object[] = []

/** Owns listeners, the opening frame and the opener; Vue only controls activation. */
export function createFocusTrap(getRoot: () => HTMLElement | null, environment: FocusEnvironment) {
  const { window, document, requestFrame, cancelFrame } = environment
  const entry = {}
  let active = false
  let opener: HTMLElement | null = null
  let activeRoot: HTMLElement | null = null
  let frame: number | null = null

  function targets(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter(
      (element) => element.getClientRects().length > 0 && !element.closest('[inert]')
    )
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.key !== 'Tab' || traps.at(-1) !== entry) return
    const root = getRoot()
    if (!root) return
    const focusable = targets(root)
    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)!
    const current = document.activeElement
    if (event.shiftKey && (current === first || !root.contains(current))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || !root.contains(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  function cancelOpeningFrame(): void {
    if (frame !== null) cancelFrame(frame)
    frame = null
  }

  return {
    activate(): void {
      if (!active) {
        active = true
        opener = document.activeElement as HTMLElement | null
        traps.push(entry)
        window.addEventListener('keydown', onKeydown, true)
      }
      cancelOpeningFrame()
      frame = requestFrame(() => {
        frame = null
        if (!active || traps.at(-1) !== entry) return
        const root = getRoot()
        activeRoot = root
        if (!root?.isConnected) return
        const current = document.activeElement as HTMLElement | null
        // Search and other explicit entry points can focus their destination
        // before this opening frame runs. Keep that visible, usable target.
        if (
          current &&
          root.contains(current) &&
          current.getClientRects().length > 0 &&
          !current.closest('[inert], [disabled]')
        )
          return
        const destination = targets(root)[0] ?? root
        destination.focus()
      })
    },
    deactivate(): void {
      cancelOpeningFrame()
      if (!active) return
      active = false
      const wasTop = traps.at(-1) === entry
      const index = traps.indexOf(entry)
      if (index !== -1) traps.splice(index, 1)
      window.removeEventListener('keydown', onKeydown, true)
      // Vue clears a v-if ref before a leave transition removes the focused
      // node. Keep its identity so focus can still return to the opener.
      const root = getRoot() ?? activeRoot
      const current = document.activeElement
      if (
        wasTop &&
        opener?.isConnected &&
        (!current || current === document.body || root?.contains(current))
      )
        opener.focus()
      opener = null
      activeRoot = null
    }
  }
}
