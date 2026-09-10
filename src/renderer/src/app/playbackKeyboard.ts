export function isPlaybackSpace(event: KeyboardEvent): boolean {
  if (
    event.code !== 'Space' ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false
  const target = event.target
  return !(
    target instanceof HTMLElement &&
    target.closest(
      'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [role="button"], [role="switch"], [role="slider"], [role="dialog"], [role="menu"]'
    )
  )
}
