import { ref, type Ref } from 'vue'

export interface SideMenuClearanceOptions {
  showLocalSidebar: Ref<boolean>
  hasPlayerBar: Ref<boolean>
}

const SIDE_MENU_OVERLAP_GAP = 10

export function useSideMenuClearance(options: SideMenuClearanceOptions) {
  const playerBottomClearance = ref(0)
  const sideMenuBottomOffset = ref(0)
  const sideMenuToolsClearance = ref(0)
  let sideMenuMonitorFrame: number | null = null
  let resizeObserver: ResizeObserver | null = null
  let playbarMutationObserver: MutationObserver | null = null
  let observedSideMenu: HTMLElement | null = null
  let observedPlayerBar: HTMLElement | null = null
  let observedPlayerSurface: HTMLElement | null = null

  function setSideMenuBottomOffset(offset: number): void {
    const nextOffset = Math.max(0, Math.round(offset))
    if (sideMenuBottomOffset.value !== nextOffset) {
      sideMenuBottomOffset.value = nextOffset
    }
  }

  function measureSideMenuClearance(): void {
    const playerBar = document.querySelector<HTMLElement>('.player-bar-shell')
    const playerBarShellRect = playerBar?.getBoundingClientRect()
    // The shell owns shared scroll clearance; only the painted surface can
    // overlap a scanning status. Auto-hidden bars retain a translated box.
    const playerSurface = playerBar?.querySelector<HTMLElement>('.player-bar') ?? playerBar
    const playerBarRect = playerSurface?.getBoundingClientRect()
    const playerVisible =
      options.hasPlayerBar.value && playerBar?.dataset.tePlaybarHidden !== 'true'
    playerBottomClearance.value =
      playerVisible &&
      playerBarShellRect &&
      playerBarShellRect.height > 0 &&
      playerBarShellRect.bottom > 0 &&
      playerBarShellRect.top < window.innerHeight
        ? Math.max(0, Math.ceil(window.innerHeight - playerBarShellRect.top))
        : 0

    // Both built-in and custom shells paint the complete overlay surface.
    // Clearance belongs to its scrollable contents, never to the panel bounds.
    setSideMenuBottomOffset(0)
    sideMenuToolsClearance.value = 0
    if (!options.showLocalSidebar.value || !playerVisible || !playerBar || !playerBarRect) return

    const sideMenu = document.querySelector<HTMLElement>('.side-menu')
    if (!sideMenu) return
    const sideMenuRect = sideMenu.getBoundingClientRect()
    // Both panels are fixed viewport overlays. Resting layout geometry keeps
    // the scan status stable while the horizontal slide is in progress.
    const sideMenuLeft = sideMenu.offsetLeft
    const slideOffset = sideMenuLeft - sideMenuRect.left
    const overlapsToolContent = [
      ...sideMenu.querySelectorAll<HTMLElement>(
        '.menu-toolbar .item-icon, .menu-toolbar .item-label, .scanning-label'
      )
    ].some((content) => {
      const rect = content.getBoundingClientRect()
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        playerBarRect.left < rect.right + slideOffset + SIDE_MENU_OVERLAP_GAP &&
        playerBarRect.right > rect.left + slideOffset - SIDE_MENU_OVERLAP_GAP
      )
    })
    if (
      overlapsToolContent &&
      playerBarRect.height > 0 &&
      playerBarRect.top < sideMenuRect.bottom &&
      playerBarRect.bottom > sideMenuRect.top
    ) {
      sideMenuToolsClearance.value = Math.max(
        0,
        Math.round(window.innerHeight - playerBarRect.top + SIDE_MENU_OVERLAP_GAP)
      )
    }
  }

  function stopSideMenuMonitor(): void {
    if (sideMenuMonitorFrame !== null) {
      cancelAnimationFrame(sideMenuMonitorFrame)
      sideMenuMonitorFrame = null
    }
  }

  function observeGeometry(): void {
    const sideMenu = document.querySelector<HTMLElement>('.side-menu')
    const playerBar = document.querySelector<HTMLElement>('.player-bar-shell')
    const playerSurface = playerBar?.querySelector<HTMLElement>('.player-bar') ?? null
    if (
      sideMenu === observedSideMenu &&
      playerBar === observedPlayerBar &&
      playerSurface === observedPlayerSurface
    )
      return

    observedSideMenu = sideMenu
    observedPlayerBar = playerBar
    observedPlayerSurface = playerSurface
    resizeObserver?.disconnect()
    playbarMutationObserver?.disconnect()

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleMeasure())
      if (sideMenu) resizeObserver.observe(sideMenu)
      if (playerBar) resizeObserver.observe(playerBar)
      if (playerSurface) resizeObserver.observe(playerSurface)
    }
    if (typeof MutationObserver !== 'undefined' && playerBar) {
      playbarMutationObserver = new MutationObserver(() => scheduleMeasure())
      playbarMutationObserver.observe(playerBar, {
        attributes: true,
        // The shape attribute matters as much as the hidden one: standard floats
        // 18px clear of the menu while compact spans the window, so switching
        // shape changes whether the bar overlaps at all. Without it here, a shape
        // switch left the previous shape's offset in place until some other
        // mutation happened to trigger a re-measure.
        attributeFilter: [
          'class',
          'data-te-playbar-hidden',
          'data-te-playbar-visibility',
          'data-te-playbar-mode'
        ]
      })
    }
  }

  function scheduleMeasure(): void {
    if (document.hidden || sideMenuMonitorFrame !== null) return
    sideMenuMonitorFrame = requestAnimationFrame(() => {
      sideMenuMonitorFrame = null
      measureSideMenuClearance()
      observeGeometry()
    })
  }

  function startSideMenuMonitor(): void {
    if (document.hidden) return
    observeGeometry()
    scheduleMeasure()
  }

  function resetSideMenuClearance(): void {
    stopSideMenuMonitor()
    setSideMenuBottomOffset(0)
    sideMenuToolsClearance.value = 0
    playerBottomClearance.value = 0
  }

  function onDocumentVisibilityChange(): void {
    if (document.hidden) {
      stopSideMenuMonitor()
      return
    }
    startSideMenuMonitor()
  }

  const onWindowResize = (): void => scheduleMeasure()
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onWindowResize)
  }
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)

  return {
    playerBottomClearance,
    sideMenuBottomOffset,
    sideMenuToolsClearance,
    startSideMenuMonitor,
    stopSideMenuMonitor,
    resetSideMenuClearance,
    measureSideMenuClearance,
    dispose: () => {
      stopSideMenuMonitor()
      resizeObserver?.disconnect()
      playbarMutationObserver?.disconnect()
      resizeObserver = null
      playbarMutationObserver = null
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onWindowResize)
      }
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
    }
  }
}
