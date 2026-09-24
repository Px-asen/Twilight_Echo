import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_DYNAMIC_ISLAND_CONFIG,
  normalizeDynamicIslandConfig,
  resolveDynamicIslandLayout
} from '../../../shared/dynamicIsland.ts'
import {
  COLLAPSE_COMMIT_FALLBACK_MS,
  createIslandStyle,
  hexToRgbChannels,
  islandActionCount,
  islandCollapseCommitDelayMs,
  resolveIslandAccent
} from './islandPresentation.ts'

const appSource = readFileSync(new URL('./DynamicIslandApp.vue', import.meta.url), 'utf8')
const visualizerSource = readFileSync(new URL('./useIslandVisualizer.ts', import.meta.url), 'utf8')
const styleSource = readFileSync(new URL('./dynamicIsland.css', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../../preload/index.ts', import.meta.url), 'utf8')
const integrationSource = readFileSync(
  new URL('../../../main/integrations/dynamicIsland.ts', import.meta.url),
  'utf8'
)

const defaults = normalizeDynamicIslandConfig(undefined)

test('default style variables reproduce the original black 430px card geometry', () => {
  const style = createIslandStyle(defaults, resolveDynamicIslandLayout(defaults), '#ff8fb6')
  assert.equal(style['--island-collapsed-x'], '90px')
  assert.equal(style['--island-collapsed-width'], '250px')
  assert.equal(style['--island-collapsed-inset-right'], '90px')
  assert.equal(style['--island-collapsed-inset-bottom'], '175px')
  assert.equal(style['--island-expanded-radius'], '58px')
  assert.equal(style['--island-bg-rgb'], '0 0 0')
  assert.equal(style['--island-bg-alpha'], '1.00')
  assert.equal(style['--island-accent-rgb'], '255 143 182')
  assert.equal(style['--island-heading-columns'], '17.55cqw minmax(0, 1fr) 7.2cqw')
  assert.equal(style['--island-action-count'], '5')
  assert.equal(style['--island-motion'], '1')
})

test('style follows DIY anchor, colors and hidden components', () => {
  const config = normalizeDynamicIslandConfig({
    appearance: { backgroundColor: '#102030', backgroundOpacity: 80, fontScale: 120 },
    layout: { anchor: 'right' },
    components: { cover: false, visualizer: false, favorite: false, skip: false },
    behavior: { motion: 'off' }
  })
  const layout = resolveDynamicIslandLayout(config)
  const style = createIslandStyle(config, layout, '#00ff00')
  assert.equal(style['--island-collapsed-x'], `${layout.width - layout.collapsed.width}px`)
  assert.equal(style['--island-collapsed-inset-right'], '0px')
  assert.equal(style['--island-origin'], 'top right')
  assert.equal(style['--island-bg-rgb'], '16 32 48')
  assert.equal(style['--island-bg-alpha'], '0.80')
  assert.equal(style['--island-font-scale'], '1.20')
  assert.equal(style['--island-heading-columns'], 'minmax(0, 1fr)')
  assert.equal(style['--island-action-count'], '2')
  assert.equal(style['--island-motion'], '0')
})

test('accent follows the artwork only when requested and a track is loaded', () => {
  const cover = normalizeDynamicIslandConfig({ appearance: { accentSource: 'cover' } })
  assert.equal(resolveIslandAccent(cover, '#123456', true), '#123456')
  assert.equal(resolveIslandAccent(cover, '#123456', false), '#ff8fb6')
  assert.equal(resolveIslandAccent(cover, 'not-a-color', true), '#ff8fb6')
  assert.equal(resolveIslandAccent(defaults, '#123456', true), '#ff8fb6')
})

test('helpers stay total for odd input', () => {
  assert.equal(hexToRgbChannels('#zzzzzz'), '0 0 0')
  assert.equal(islandActionCount(DEFAULT_DYNAMIC_ISLAND_CONFIG.components), 5)
  assert.equal(islandCollapseCommitDelayMs(defaults), COLLAPSE_COMMIT_FALLBACK_MS)
  assert.equal(
    islandCollapseCommitDelayMs(normalizeDynamicIslandConfig({ behavior: { motion: 'off' } })),
    0
  )
})

test('dynamic island bars use the native audio tap instead of a decorative keyframe', () => {
  assert.match(appSource, /window\.api\.dynamicIsland\.getVisualizationData\(/)
  assert.match(visualizerSource, /visualizerBarCount: VISUALIZER_BAR_COUNT/)
  assert.match(visualizerSource, /tapStatus === 'active'/)
  assert.match(visualizerSource, /VISUALIZER_IDLE_POLL_INTERVAL_MS = 250/)
  assert.match(
    visualizerSource,
    /live \? VISUALIZER_POLL_INTERVAL_MS : VISUALIZER_IDLE_POLL_INTERVAL_MS/
  )
  assert.match(visualizerSource, /--visualizer-level/)
  assert.match(styleSource, /scaleY\(calc\(0\.12 \+ var\(--visualizer-level, 0\) \* 0\.88\)\)/)
  assert.doesNotMatch(styleSource, /@keyframes island-(compact|expanded)-wave/)
})

test('visualizer sampling stops when disabled or when the window is hidden', () => {
  assert.match(visualizerSource, /watch\(enabled, sync\)/)
  assert.match(visualizerSource, /document\.visibilityState !== 'hidden'/)
  assert.match(visualizerSource, /addEventListener\('visibilitychange', sync\)/)
  assert.match(appSource, /computed\(\(\) => components\.value\.visualizer\)/)
})

test('album artwork reacts to measured audio energy unless DIY turns it off', () => {
  assert.match(appSource, /config\.value\.appearance\.audioReactive/)
  assert.match(appSource, /visualizer\.energy\.value\.toFixed\(3\)/)
  assert.match(
    styleSource,
    /\.island-player-art\s*\{[\s\S]*?scale\(calc\(1 \+ var\(--visualizer-energy, 0\) \* 0\.035\)\)/
  )
})

test('dynamic island only renders an active timed lyric', () => {
  assert.match(
    appSource,
    /state\.value\.lyrics\.some\(\(line\) => typeof line\.time === 'number'\)/
  )
  assert.match(appSource, /v-if="showExpandedLyric" class="island-player-lyric"/)
})

test('dynamic island exposes the visualization sampler through its restricted window API', () => {
  assert.match(preloadSource, /const dynamicIslandWindowApi = \{[\s\S]*getVisualizationData:/)
  assert.match(preloadSource, /const dynamicIslandWindowApi = \{[\s\S]*onConfig:/)
  assert.doesNotMatch(appSource, /window\.api\.audioEngine\.getVisualizationData\(/)
})

test('dynamic island transport buttons control adjacent tracks', () => {
  assert.match(appSource, /aria-label="上一首"[\s\S]*@click\.stop="send\(\{ type: 'previous' \}\)"/)
  assert.match(appSource, /aria-label="下一首"[\s\S]*@click\.stop="send\(\{ type: 'next' \}\)"/)
})

test('expanded controls keep playback centered with stable utility slots', () => {
  assert.match(styleSource, /\.island-player-actions\s*\{[\s\S]*?grid-template-columns: repeat\(5,/)
  assert.match(styleSource, /\.island-player-favorite\s*\{[\s\S]*?grid-column: 1;/)
  assert.match(styleSource, /\.island-player-skip--previous\s*\{[\s\S]*?grid-column: 2;/)
  assert.match(styleSource, /\.island-player-toggle\s*\{[\s\S]*?grid-column: 3;/)
  assert.match(styleSource, /\.island-player-skip--next\s*\{[\s\S]*?grid-column: 4;/)
  assert.match(styleSource, /\.island-volume-control\s*\{[\s\S]*?grid-column: 5;/)
})

test('card surface is one continuous clipped face driven by layout variables', () => {
  assert.match(
    styleSource,
    /\.island-surface\s*\{[\s\S]*?background-color: rgb\(var\(--island-bg-rgb\) \/ var\(--island-bg-alpha\)\);/
  )
  assert.match(
    styleSource,
    /clip-path: inset\(\s*0 var\(--island-collapsed-inset-right\) var\(--island-collapsed-inset-bottom\)\s*var\(--island-collapsed-x\) round var\(--island-collapsed-radius\)\s*\);/
  )
  assert.match(
    styleSource,
    /\.dynamic-island-root\[data-open='true'\] \.island-surface\s*\{[\s\S]*?clip-path: inset\(0 round var\(--island-expanded-radius\)\);/
  )
  assert.match(styleSource, /clip-path calc\(0\.52s \* var\(--island-motion\)\)/)
  assert.doesNotMatch(styleSource, /width 0\.5s cubic-bezier/)
  assert.match(appSource, /event\.propertyName !== 'clip-path'/)
})

test('card surface has material lighting and state-aware feedback', () => {
  assert.match(styleSource, /\.island-surface::before[\s\S]*?radial-gradient/)
  assert.match(styleSource, /\.island-surface::after[\s\S]*?border: 1px solid/)
  assert.match(
    styleSource,
    /\.music-island\[data-player-state='playing'\] \.island-surface::before[\s\S]*?island-ambient-pulse/
  )
  assert.match(
    styleSource,
    /\.music-island\[data-player-state='loading'\] \.island-surface::before[\s\S]*?island-loading-sheen/
  )
  assert.match(styleSource, /\.island-player-toggle\s*\{[\s\S]*?--island-accent-rgb/)
})

test('card surface expands inside a transparent hit-test shell', () => {
  assert.match(appSource, /ref="islandSurface"/)
  assert.match(appSource, /event\.target !== islandSurface\.value/)
  assert.match(styleSource, /\.dynamic-island-root\s*\{[\s\S]*pointer-events: none;/)
  assert.match(styleSource, /\.island-surface\s*\{[\s\S]*pointer-events: auto;/)
})

test('player card content stays hidden until the surface is nearly expanded', () => {
  assert.match(styleSource, /\.island-panel\s*\{[\s\S]*?opacity: 0;/)
  assert.match(
    styleSource,
    /opacity calc\(0\.22s \* var\(--island-motion\)\) ease calc\(0\.24s \* var\(--island-motion\)\)/
  )
})

test('expand trigger and collapse delay come from the DIY behavior config', () => {
  assert.match(appSource, /config\.value\.behavior\.expandTrigger === 'hover'/)
  assert.match(appSource, /config\.value\.behavior\.collapseDelayMs/)
  assert.match(appSource, /islandCollapseCommitDelayMs\(config\.value\)/)
})

test('native rounded clipping stays outside the antialiased CSS surface', () => {
  assert.match(integrationSource, /DYNAMIC_ISLAND_SHAPE_SAFETY_PX = 6/)
  assert.match(integrationSource, /DYNAMIC_ISLAND_SHAPE_TRANSITION_MS = 520/)
  assert.match(integrationSource, /applyWindowShape\(win, layout, true\)/)
  assert.match(integrationSource, /rect\.radius - DYNAMIC_ISLAND_SHAPE_SAFETY_PX/)
  assert.match(integrationSource, /dynamicIslandMotionScale\(config\)/)
})

test('host validates plugin config and hides the island per the visibility policy', () => {
  assert.match(integrationSource, /config = normalizeDynamicIslandConfig\(rawConfig\)/)
  assert.match(integrationSource, /shouldShowDynamicIsland\(config, currentState\(\), expanded\)/)
  assert.match(integrationSource, /sendToIsland\('dynamicIsland:config', \{ config, layout \}\)/)
})
