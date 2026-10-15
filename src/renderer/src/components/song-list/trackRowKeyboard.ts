/** Rows retain table semantics; nested buttons keep their native keyboard
 * behavior. Playback, selection and focus are deliberately separate states. */
export function trackRowKeyAction(
  event: KeyboardEvent,
  selectable = true
): 'play' | 'select' | null {
  if (event.target !== event.currentTarget || event.altKey || event.metaKey) return null
  const action =
    event.key === 'Enter' && !event.ctrlKey && !event.shiftKey
      ? 'play'
      : selectable && event.key === ' ' && !event.shiftKey
        ? 'select'
        : null
  if (action) event.preventDefault()
  return action
}
