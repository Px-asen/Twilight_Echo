import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DYNAMIC_ISLAND_CONFIG,
  DYNAMIC_ISLAND_EDGE_MARGIN,
  cloneDynamicIslandConfig,
  dynamicIslandMotionScale,
  normalizeDynamicIslandConfig,
  resolveDynamicIslandLayout,
  resolveDynamicIslandWindowBounds,
  shouldShowDynamicIsland,
  type DynamicIslandConfig
} from './dynamicIsland.ts'

function configWith(patch: {
  [Section in keyof DynamicIslandConfig]?: Partial<DynamicIslandConfig[Section]>
}): DynamicIslandConfig {
  const base = cloneDynamicIslandConfig(DEFAULT_DYNAMIC_ISLAND_CONFIG)
  return normalizeDynamicIslandConfig({
    appearance: { ...base.appearance, ...patch.appearance },
    layout: { ...base.layout, ...patch.layout },
    components: { ...base.components, ...patch.components },
    behavior: { ...base.behavior, ...patch.behavior }
  })
}

const idle = { track: null, isPlaying: false, isLoading: false }
const paused = { track: { title: 'x' } as never, isPlaying: false, isLoading: false }
const playing = { ...paused, isPlaying: true }

test('missing or malformed input resolves to the defaults', () => {
  assert.deepEqual(normalizeDynamicIslandConfig(undefined), DEFAULT_DYNAMIC_ISLAND_CONFIG)
  assert.deepEqual(normalizeDynamicIslandConfig('nope'), DEFAULT_DYNAMIC_ISLAND_CONFIG)
  assert.deepEqual(
    normalizeDynamicIslandConfig({ appearance: [], layout: null }),
    DEFAULT_DYNAMIC_ISLAND_CONFIG
  )
})

test('numbers are clamped and rounded, invalid values fall back per field', () => {
  const config = normalizeDynamicIslandConfig({
    appearance: {
      backgroundOpacity: 5,
      fontScale: 999,
      collapsedRadius: 12.6,
      backgroundColor: '#ABCDEF',
      textColor: 'red',
      accentSource: 'rainbow',
      audioReactive: 'yes'
    },
    layout: { expandedWidth: Number.NaN, offsetX: -10_000, anchor: 'top' },
    behavior: { collapseDelayMs: 99_999, motion: 'slow' }
  })
  assert.equal(config.appearance.backgroundOpacity, 30)
  assert.equal(config.appearance.fontScale, 130)
  assert.equal(config.appearance.collapsedRadius, 13)
  assert.equal(config.appearance.backgroundColor, '#abcdef')
  assert.equal(config.appearance.textColor, DEFAULT_DYNAMIC_ISLAND_CONFIG.appearance.textColor)
  assert.equal(config.appearance.accentSource, 'custom')
  assert.equal(config.appearance.audioReactive, true)
  assert.equal(config.layout.expandedWidth, 430)
  assert.equal(config.layout.offsetX, -600)
  assert.equal(config.layout.anchor, 'center')
  assert.equal(config.behavior.collapseDelayMs, 3000)
  assert.equal(config.behavior.motion, 'slow')
})

test('default layout reproduces the original 430x223 card with a centred 250x48 pill', () => {
  const layout = resolveDynamicIslandLayout(normalizeDynamicIslandConfig({}))
  assert.equal(layout.width, 430)
  assert.equal(layout.height, 223)
  assert.equal(layout.expandedRadius, 58)
  assert.deepEqual(layout.collapsed, { x: 90, width: 250, height: 48, radius: 24 })
})

test('expanded height follows width and the visible components', () => {
  const full = resolveDynamicIslandLayout(configWith({ layout: { expandedWidth: 520 } }))
  const noTime = resolveDynamicIslandLayout(
    configWith({ layout: { expandedWidth: 520 }, components: { time: false } })
  )
  const noProgress = resolveDynamicIslandLayout(
    configWith({ layout: { expandedWidth: 520 }, components: { progress: false } })
  )
  assert.equal(full.width, 520)
  assert.ok(full.height > noTime.height)
  assert.ok(noTime.height > noProgress.height)
  // Time labels are part of the timeline, so hiding progress hides them too.
  const timeOnly = resolveDynamicIslandLayout(
    configWith({ layout: { expandedWidth: 520 }, components: { progress: false, time: true } })
  )
  assert.equal(timeOnly.height, noProgress.height)
})

test('layout shrinks to fit narrow displays and never exceeds the card', () => {
  const layout = resolveDynamicIslandLayout(
    configWith({ layout: { expandedWidth: 560, collapsedWidth: 360 } }),
    300
  )
  assert.equal(layout.width, 300)
  assert.equal(layout.collapsed.width, 300)
  assert.equal(layout.collapsed.x, 0)
})

test('radii are capped at half the rectangle height', () => {
  const layout = resolveDynamicIslandLayout(
    configWith({
      appearance: { collapsedRadius: 32, expandedRadius: 72 },
      layout: { collapsedHeight: 40, expandedWidth: 360 },
      components: { progress: false }
    })
  )
  assert.equal(layout.collapsed.radius, 20)
  assert.equal(layout.expandedRadius, Math.min(72, Math.floor(layout.height / 2)))
})

test('anchor moves the pill inside the window and the window on the display', () => {
  const display = { x: 100, y: 0, width: 1920, height: 1080 }
  for (const [anchor, pillX, windowX] of [
    ['left', 0, 100 + DYNAMIC_ISLAND_EDGE_MARGIN],
    ['center', 90, 100 + (1920 - 430) / 2],
    ['right', 180, 100 + 1920 - 430 - DYNAMIC_ISLAND_EDGE_MARGIN]
  ] as const) {
    const config = configWith({ layout: { anchor } })
    const layout = resolveDynamicIslandLayout(config)
    assert.equal(layout.collapsed.x, pillX, anchor)
    assert.equal(resolveDynamicIslandWindowBounds(config, layout, display).x, windowX, anchor)
  }
})

test('window offsets are applied and clamped to the display', () => {
  const display = { x: 0, y: 0, width: 1280, height: 720 }
  const config = configWith({ layout: { offsetX: 600, offsetY: 40 } })
  const bounds = resolveDynamicIslandWindowBounds(
    config,
    resolveDynamicIslandLayout(config),
    display
  )
  assert.equal(bounds.x, 1280 - 430)
  assert.equal(bounds.y, 40)
  assert.equal(bounds.width, 430)
  assert.equal(bounds.height, 223)
})

test('visibility policy hides idle or paused islands but never an open one', () => {
  const always = configWith({})
  const whenTrack = configWith({ behavior: { visibility: 'when-track' } })
  const whenPlaying = configWith({ behavior: { visibility: 'when-playing' } })
  assert.equal(shouldShowDynamicIsland(always, idle, false), true)
  assert.equal(shouldShowDynamicIsland(whenTrack, idle, false), false)
  assert.equal(shouldShowDynamicIsland(whenTrack, paused, false), true)
  assert.equal(shouldShowDynamicIsland(whenPlaying, paused, false), false)
  assert.equal(shouldShowDynamicIsland(whenPlaying, playing, false), true)
  assert.equal(shouldShowDynamicIsland(whenPlaying, idle, true), true)
})

test('motion presets scale every transition, "off" disables them', () => {
  assert.equal(dynamicIslandMotionScale(configWith({ behavior: { motion: 'off' } })), 0)
  assert.equal(dynamicIslandMotionScale(configWith({})), 1)
  assert.ok(dynamicIslandMotionScale(configWith({ behavior: { motion: 'slow' } })) > 1)
})

test('clones do not share nested state with the frozen defaults', () => {
  const clone = cloneDynamicIslandConfig(DEFAULT_DYNAMIC_ISLAND_CONFIG)
  clone.layout.expandedWidth = 500
  assert.equal(DEFAULT_DYNAMIC_ISLAND_CONFIG.layout.expandedWidth, 430)
})
