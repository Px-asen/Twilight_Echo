export function isCommandPaletteAccelerator(accelerator: string): boolean {
  const parts = accelerator
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  return (
    parts.length === 2 &&
    parts.includes('k') &&
    parts.some((part) =>
      [
        'commandorcontrol',
        'cmdorctrl',
        'control',
        'ctrl',
        'command',
        'cmd',
        'meta',
        'super'
      ].includes(part)
    )
  )
}

export function isCommandPaletteKey(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
  repeat: boolean
  defaultPrevented: boolean
  keyCode?: number
}): boolean {
  return (
    event.key.toLowerCase() === 'k' &&
    event.ctrlKey !== event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.repeat &&
    !event.defaultPrevented
  )
}
