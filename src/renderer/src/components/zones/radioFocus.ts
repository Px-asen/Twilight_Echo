const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * Arrow keys, Home and End move focus between the enabled radios of a
 * `role="radiogroup"`. Choosing stays on Space and Enter: on this page a choice
 * switches the output or the DSP scene, which a stray arrow press must not do.
 */
export function moveRadioFocus(event: KeyboardEvent): void {
  const step = STEPS[event.key] ?? 0
  if (!step && event.key !== 'Home' && event.key !== 'End') return
  const group = event.currentTarget
  if (!(group instanceof HTMLElement)) return
  const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')]
  if (!radios.length) return
  const current = radios.findIndex((radio) => radio.contains(document.activeElement))
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? radios.length - 1
        : current < 0
          ? 0
          : (current + step + radios.length) % radios.length
  event.preventDefault()
  radios[next].focus()
}
