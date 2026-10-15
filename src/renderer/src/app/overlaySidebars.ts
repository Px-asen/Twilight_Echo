/** The same painted width serves both panels, including large-font themes. */
export function overlaySidebarsNeedExclusiveMode(): boolean {
  if (window.innerWidth < 640) return true
  const panel = document.querySelector<HTMLElement>('.side-menu.overlay-side-panel')
  const width = panel?.getBoundingClientRect().width || 260
  const inset = panel ? parseFloat(getComputedStyle(panel).left) || 0 : 0
  return window.innerWidth < width * 2 + inset * 2 + 8
}
