import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ref } from 'vue'

/**
 * Both bottom-edge geometry consumers measure `.player-bar-shell`. An auto-hidden
 * mini bar is only translated away, so its layout box is unchanged and measuring
 * it would reserve space around nothing — the sidebar would stay pushed up and the
 * lyric centre line would stay offset. Both must read the shell's hidden flag.
 */

interface FakeRect {
  top: number
  bottom: number
  left: number
  right: number
  height: number
}

function installDom(options: {
  playerBarHidden?: 'true' | 'false'
  playerBarMenuOpen?: boolean
  playerBarRect?: FakeRect
  playerSurfaceRect?: FakeRect
  sideMenuRect?: FakeRect
  toolContentRects?: FakeRect[]
  playerBarMissing?: boolean
  /** Untransformed left edge, i.e. how far a preset floats the menu inward. */
  sideMenuInset?: number
  sideMenuParentLeft?: number
  viewportWidth?: number
  viewportHeight?: number
  shellLayout?: 'classic' | 'custom'
}): void {
  const playerBarRect = options.playerBarRect ?? {
    top: 700,
    bottom: 780,
    left: 0,
    right: 1200,
    height: 80
  }
  const sideMenuRect = options.sideMenuRect ?? {
    top: 100,
    bottom: 760,
    left: 0,
    right: 240,
    height: 660
  }
  const playerBar = {
    dataset: { tePlaybarHidden: options.playerBarHidden ?? 'false' },
    querySelector: () =>
      options.playerSurfaceRect ? { getBoundingClientRect: () => options.playerSurfaceRect } : null,
    classList: {
      contains: (name: string) => name === 'menu-open' && options.playerBarMenuOpen === true
    },
    getBoundingClientRect: () => playerBarRect
  }
  /**
   * `offsetLeft`/`offsetWidth` are the untransformed box, which is what the
   * inline-end measurement reads: the menu is laid out in place and merely
   * translated off-screen when closed, so these hold the open edge either way.
   */
  const sideMenu = {
    offsetLeft: options.sideMenuInset ?? 0,
    offsetWidth: 216,
    offsetParent:
      options.sideMenuParentLeft === undefined
        ? null
        : { getBoundingClientRect: () => ({ left: options.sideMenuParentLeft }) },
    getBoundingClientRect: () => sideMenuRect,
    querySelectorAll: () =>
      (
        options.toolContentRects ?? [
          {
            left: sideMenuRect.left + 24,
            right: sideMenuRect.left + 112,
            top: sideMenuRect.bottom - 44,
            bottom: sideMenuRect.bottom - 22,
            height: 22
          }
        ]
      ).map((rect) => ({
        getBoundingClientRect: () => ({ ...rect, width: rect.right - rect.left })
      }))
  }
  const g = globalThis as Record<string, unknown>
  g.window = {
    innerHeight: options.viewportHeight ?? 800,
    innerWidth: options.viewportWidth ?? 1200
  }
  g.document = {
    hidden: false,
    documentElement: { dataset: { teShellLayout: options.shellLayout ?? 'custom' } },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector: string) => {
      if (selector === '.side-menu') return sideMenu
      if (selector === '.player-bar-shell') return options.playerBarMissing ? null : playerBar
      return null
    }
  }
  g.requestAnimationFrame = (): number => 1
  g.cancelAnimationFrame = (): void => {}
}

const { useSideMenuClearance } = (await import(
  new URL('../app/useSideMenuClearance.ts', import.meta.url).href
)) as typeof import('../app/useSideMenuClearance')

function measure(options: Parameters<typeof installDom>[0]): number {
  installDom(options)
  const clearance = useSideMenuClearance({
    showLocalSidebar: ref(true),
    hasPlayerBar: ref(true)
  })
  clearance.measureSideMenuClearance()
  const offset = clearance.sideMenuBottomOffset.value
  clearance.dispose()
  return offset
}

test('custom sidebar keeps its material bounds behind a visible overlapping playbar', () => {
  assert.equal(measure({ playerBarHidden: 'false', shellLayout: 'custom' }), 0)
})

test('default sidebar preserves its content clearance during a slide and repeated toggles', () => {
  for (const right of [240, 160, 80, 0, -4, 0, 80, 160, 240]) {
    installDom({
      shellLayout: 'classic',
      sideMenuInset: 4,
      sideMenuRect: { top: 100, bottom: 796, left: right - 216, right, height: 696 },
      playerBarRect: { top: 700, bottom: 778, left: 94, right: 1106, height: 78 }
    })
    const clearance = useSideMenuClearance({ showLocalSidebar: ref(true), hasPlayerBar: ref(true) })
    clearance.measureSideMenuClearance()
    assert.equal(
      clearance.sideMenuBottomOffset.value,
      0,
      'the material bounds cannot depend on the animated rect'
    )
    assert.equal(
      clearance.sideMenuToolsClearance.value,
      110,
      'sliding past the player cannot resize the scroller'
    )
    clearance.dispose()
  }
})

test('sidebar clearance drops to zero once the mini bar is tucked away', () => {
  assert.equal(measure({ playerBarHidden: 'true' }), 0)
})

test('legacy menu-open state does not bypass actual overlap clearance', () => {
  assert.equal(measure({ playerBarMenuOpen: true }), 0)
})

test('navigation tools clear the overlaid player and remain flush for adjacent custom layouts', () => {
  installDom({ playerBarMenuOpen: true })
  const clearance = useSideMenuClearance({
    showLocalSidebar: ref(true),
    hasPlayerBar: ref(true)
  })
  clearance.measureSideMenuClearance()
  assert.equal(clearance.sideMenuBottomOffset.value, 0)
  assert.equal(clearance.sideMenuToolsClearance.value, 110)

  // Once the transition completes, adjacent bars also need no padding when a
  // custom shell owns their positioning or the menu-open class is absent.
  for (const shellLayout of ['classic', 'custom'] as const) {
    installDom({
      shellLayout,
      playerBarRect: { top: 700, bottom: 780, left: 260, right: 1200, height: 80 }
    })
    clearance.measureSideMenuClearance()
    assert.equal(clearance.sideMenuBottomOffset.value, 0)
    assert.equal(clearance.sideMenuToolsClearance.value, 0)
  }

  installDom({ playerBarMenuOpen: true, viewportWidth: 760 })
  clearance.measureSideMenuClearance()
  assert.equal(clearance.sideMenuToolsClearance.value, 110)

  installDom({ playerBarHidden: 'true' })
  clearance.measureSideMenuClearance()
  assert.equal(clearance.sideMenuToolsClearance.value, 0)

  installDom({ playerBarMenuOpen: true })
  clearance.measureSideMenuClearance()
  clearance.resetSideMenuClearance()
  assert.equal(clearance.sideMenuToolsClearance.value, 0)
  clearance.dispose()
})

test('navigation tools do not reserve the playback band twice in an inset shell', () => {
  installDom({
    shellLayout: 'custom',
    sideMenuRect: { top: 100, bottom: 680, left: 0, right: 240, height: 580 }
  })
  const clearance = useSideMenuClearance({
    showLocalSidebar: ref(true),
    hasPlayerBar: ref(true)
  })
  clearance.measureSideMenuClearance()
  assert.equal(clearance.sideMenuToolsClearance.value, 0)
  clearance.dispose()
})

test('custom overlay navigation at 760px keeps its full surface behind the playbar', () => {
  assert.equal(measure({ playerBarMenuOpen: true, viewportWidth: 760 }), 0)
})

test('temporary navigation in a wide custom shell keeps its overlay bounds', () => {
  assert.equal(measure({ playerBarMenuOpen: true, shellLayout: 'custom' }), 0)
})

test('window tools clear the painted player at every size while the sidebar surface stays full height', () => {
  for (const [viewportWidth, viewportHeight] of [
    [760, 820],
    [960, 820],
    [1280, 720],
    [1920, 1080]
  ]) {
    for (const playerBarHidden of ['false', 'true'] as const) {
      installDom({
        shellLayout: 'classic',
        viewportWidth,
        viewportHeight,
        playerBarHidden,
        playerBarRect: {
          top: viewportHeight - 100,
          bottom: viewportHeight - 20,
          left: 18,
          right: viewportWidth - 18,
          height: 80
        },
        sideMenuRect: {
          top: 40,
          bottom: viewportHeight,
          left: 0,
          right: 216,
          height: viewportHeight - 40
        }
      })
      const clearance = useSideMenuClearance({
        showLocalSidebar: ref(true),
        hasPlayerBar: ref(true)
      })
      clearance.measureSideMenuClearance()
      assert.equal(clearance.sideMenuBottomOffset.value, 0)
      assert.equal(clearance.sideMenuToolsClearance.value, playerBarHidden === 'true' ? 0 : 110)
      assert.equal(clearance.playerBottomClearance.value, playerBarHidden === 'true' ? 0 : 100)
      clearance.dispose()
    }
  }
})

test('a centred player surface leaves tools at the window bottom despite its full-width shell', () => {
  installDom({
    shellLayout: 'classic',
    viewportWidth: 1920,
    viewportHeight: 1080,
    playerBarRect: { top: 980, bottom: 1060, left: 18, right: 1902, height: 80 },
    playerSurfaceRect: { top: 980, bottom: 1060, left: 370, right: 1550, height: 80 }
  })
  const clearance = useSideMenuClearance({ showLocalSidebar: ref(true), hasPlayerBar: ref(true) })
  clearance.measureSideMenuClearance()
  assert.equal(clearance.sideMenuBottomOffset.value, 0)
  assert.equal(clearance.sideMenuToolsClearance.value, 0)
  clearance.dispose()
})

test('player overlap with trailing sidebar whitespace keeps icons and labels at the bottom', () => {
  for (const playerLeft of [150, 122, 110, 18]) {
    installDom({
      shellLayout: 'classic',
      sideMenuRect: { top: 40, bottom: 800, left: 0, right: 216, height: 760 },
      playerSurfaceRect: { top: 700, bottom: 780, left: playerLeft, right: 1182, height: 80 }
    })
    const clearance = useSideMenuClearance({ showLocalSidebar: ref(true), hasPlayerBar: ref(true) })
    for (let pass = 0; pass < 3; pass++) {
      clearance.measureSideMenuClearance()
      assert.equal(clearance.sideMenuBottomOffset.value, 0)
      assert.equal(clearance.sideMenuToolsClearance.value, playerLeft >= 122 ? 0 : 110)
    }
    clearance.dispose()
  }
})

test('sidebar clearance still handles a missing playbar and a non-overlapping one', () => {
  assert.equal(measure({ playerBarMissing: true }), 0)
  assert.equal(
    measure({
      // Bar sits to the right of the sidebar: no horizontal overlap.
      playerBarRect: { top: 700, bottom: 780, left: 400, right: 1200, height: 80 }
    }),
    0
  )
})

test('all sidebar shells retain footer clearance while their surfaces slide', () => {
  for (const shellLayout of ['classic', 'custom'] as const) {
    for (const shift of [0, -24, -120, -215, -216, -120, 0]) {
      const options = {
        shellLayout,
        viewportWidth: 760,
        playerBarRect: { top: 700, bottom: 780, left: 18, right: 1182, height: 80 },
        sideMenuRect: { top: 40, bottom: 800, left: shift, right: 216 + shift, height: 760 }
      }
      installDom(options)
      const clearance = useSideMenuClearance({
        showLocalSidebar: ref(true),
        hasPlayerBar: ref(true)
      })
      clearance.measureSideMenuClearance()
      assert.equal(
        clearance.sideMenuBottomOffset.value,
        0,
        `horizontal translation ${shift}px must follow the ${shellLayout} clearance contract`
      )
      assert.equal(clearance.sideMenuToolsClearance.value, 110)
      clearance.dispose()
    }
  }
})

test('custom sidebar bounds stay independent of a theme parent position', () => {
  assert.equal(
    measure({
      shellLayout: 'custom',
      sideMenuInset: 12,
      sideMenuParentLeft: 300,
      sideMenuRect: { top: 40, bottom: 800, left: 96, right: 312, height: 760 },
      playerBarRect: { top: 700, bottom: 780, left: 300, right: 600, height: 80 }
    }),
    0
  )
  assert.equal(
    measure({
      shellLayout: 'custom',
      sideMenuParentLeft: 300,
      sideMenuRect: { top: 40, bottom: 800, left: 84, right: 300, height: 760 },
      playerBarRect: { top: 700, bottom: 780, left: 18, right: 250, height: 80 }
    }),
    0
  )
})

test('custom sidebar clearance settles without shrinking its full overlay surface', () => {
  installDom({ shellLayout: 'custom' })
  const clearance = useSideMenuClearance({ showLocalSidebar: ref(true), hasPlayerBar: ref(true) })
  const passes: number[] = []
  for (let pass = 0; pass < 4; pass += 1) {
    clearance.measureSideMenuClearance()
    passes.push(clearance.sideMenuBottomOffset.value)
    assert.equal(clearance.sideMenuToolsClearance.value, 110)
  }
  clearance.dispose()
  assert.deepEqual(passes, [0, 0, 0, 0])
})

test('the now-playing lyric centring reads the same hidden flag', () => {
  const playingMusic = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const helper = playingMusic.match(/function measurePlaybarReservedPx\(\)[\s\S]*?\n\}/)
  assert.ok(helper, 'PlayingMusic must resolve the reserved bottom space in one helper')
  assert.match(helper[0], /querySelector<HTMLElement>\('\.player-bar-shell'\)/)
  assert.match(helper[0], /dataset\.tePlaybarHidden === 'true'\) return 0/)
  // The flag check must precede measurement, or the hidden bar's box still counts.
  assert.ok(
    helper[0].indexOf('tePlaybarHidden') < helper[0].indexOf('getBoundingClientRect'),
    'the hidden check must short-circuit before measuring'
  )
  assert.match(playingMusic, /getBottomReservedPx:\s*measurePlaybarReservedPx/)
})

test('the shell is what publishes the flag both consumers query', () => {
  const playerBar = readFileSync(new URL('./PlayerBar.vue', import.meta.url), 'utf8')
  // dataset.tePlaybarHidden is the camelCase view of data-te-playbar-hidden.
  assert.match(playerBar, /'data-te-playbar-hidden':/)
  assert.match(playerBar, /class="player-bar-shell"[\s\S]{0,200}v-bind="shellDataAttrs"/)
})

test('sidebar clearance is event-driven instead of a perpetual rAF loop', () => {
  const source = readFileSync(new URL('../app/useSideMenuClearance.ts', import.meta.url), 'utf8')
  assert.match(source, /new ResizeObserver\(/)
  assert.match(source, /new MutationObserver\(/)
  assert.doesNotMatch(source, /requestAnimationFrame\(tick\)/)
})
