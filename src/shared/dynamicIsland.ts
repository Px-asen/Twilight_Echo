import type { MiniPlayerStateSnapshot } from './miniPlayer.ts'

export type DynamicIslandAccentSource = 'custom' | 'cover'
export type DynamicIslandAnchor = 'left' | 'center' | 'right'
export type DynamicIslandDisplayTarget = 'main-window' | 'primary'
export type DynamicIslandCollapsedContent = 'artwork' | 'track' | 'lyric'
export type DynamicIslandExpandTrigger = 'hover' | 'click'
export type DynamicIslandMotion = 'off' | 'fast' | 'normal' | 'slow'
export type DynamicIslandVisibility = 'always' | 'when-track' | 'when-playing'

export interface DynamicIslandAppearanceConfig {
  backgroundColor: string
  /** Surface opacity in percent. */
  backgroundOpacity: number
  textColor: string
  accentColor: string
  accentSource: DynamicIslandAccentSource
  visualizerColor: string
  /** Text scale in percent. */
  fontScale: number
  collapsedRadius: number
  expandedRadius: number
  /** Let artwork glow and scale with measured audio energy. */
  audioReactive: boolean
}

export interface DynamicIslandLayoutConfig {
  collapsedWidth: number
  collapsedHeight: number
  expandedWidth: number
  anchor: DynamicIslandAnchor
  offsetX: number
  offsetY: number
  display: DynamicIslandDisplayTarget
}

export interface DynamicIslandComponentsConfig {
  collapsedContent: DynamicIslandCollapsedContent
  cover: boolean
  visualizer: boolean
  lyric: boolean
  progress: boolean
  time: boolean
  favorite: boolean
  skip: boolean
  volume: boolean
}

export interface DynamicIslandBehaviorConfig {
  expandTrigger: DynamicIslandExpandTrigger
  collapseDelayMs: number
  motion: DynamicIslandMotion
  visibility: DynamicIslandVisibility
}

export interface DynamicIslandConfig {
  appearance: DynamicIslandAppearanceConfig
  layout: DynamicIslandLayoutConfig
  components: DynamicIslandComponentsConfig
  behavior: DynamicIslandBehaviorConfig
}

/** Inclusive numeric bounds enforced by the host for every plugin-supplied value. */
export const DYNAMIC_ISLAND_LIMITS = {
  backgroundOpacity: { min: 30, max: 100 },
  fontScale: { min: 80, max: 130 },
  collapsedRadius: { min: 0, max: 32 },
  expandedRadius: { min: 16, max: 72 },
  collapsedWidth: { min: 160, max: 360 },
  collapsedHeight: { min: 36, max: 64 },
  expandedWidth: { min: 360, max: 560 },
  offsetX: { min: -600, max: 600 },
  offsetY: { min: 0, max: 200 },
  collapseDelayMs: { min: 0, max: 3000 }
} as const satisfies Record<string, { min: number; max: number }>

export const DEFAULT_DYNAMIC_ISLAND_CONFIG: Readonly<DynamicIslandConfig> = Object.freeze({
  appearance: Object.freeze({
    backgroundColor: '#000000',
    backgroundOpacity: 100,
    textColor: '#ffffff',
    accentColor: '#ff8fb6',
    accentSource: 'custom',
    visualizerColor: '#a89de3',
    fontScale: 100,
    collapsedRadius: 25,
    expandedRadius: 58,
    audioReactive: true
  }),
  layout: Object.freeze({
    collapsedWidth: 250,
    collapsedHeight: 48,
    expandedWidth: 430,
    anchor: 'center',
    offsetX: 0,
    offsetY: 12,
    display: 'main-window'
  }),
  components: Object.freeze({
    collapsedContent: 'artwork',
    cover: true,
    visualizer: true,
    lyric: true,
    progress: true,
    time: true,
    favorite: true,
    skip: true,
    volume: true
  }),
  behavior: Object.freeze({
    expandTrigger: 'hover',
    collapseDelayMs: 420,
    motion: 'normal',
    visibility: 'always'
  })
}) as Readonly<DynamicIslandConfig>

const MOTION_SCALE: Record<DynamicIslandMotion, number> = {
  off: 0,
  fast: 0.65,
  normal: 1,
  slow: 1.45
}

/** Horizontal gap kept between an edge-anchored island and the display edge. */
export const DYNAMIC_ISLAND_EDGE_MARGIN = 12

// Vertical rhythm of the expanded card in container-width units (cqw). The
// renderer styles the card with the same numbers, so the native window height
// and the CSS content always agree.
const EXPANDED_FRAME_CQW = 6.2 + 17.55 + 2.2 + 12.8 + 4.2
const EXPANDED_PROGRESS_CQW = 3.2 + 1.9
const EXPANDED_TIME_GAP_CQW = 0.7
const EXPANDED_TIME_TEXT_CQW = 3

export interface DynamicIslandCollapsedRect {
  /** Left edge of the pill inside the overlay window. */
  x: number
  width: number
  height: number
  radius: number
}

export interface DynamicIslandLayout {
  /** Window width; the expanded card always fills it. */
  width: number
  /** Window height; the expanded card always fills it. */
  height: number
  expandedRadius: number
  collapsed: DynamicIslandCollapsedRect
}

export interface DynamicIslandPresentation {
  config: DynamicIslandConfig
  layout: DynamicIslandLayout
}

export interface DynamicIslandBootstrap extends DynamicIslandPresentation {
  state: MiniPlayerStateSnapshot
  expanded: boolean
}

export interface DynamicIslandDisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

export function cloneDynamicIslandConfig(config: DynamicIslandConfig): DynamicIslandConfig {
  return {
    appearance: { ...config.appearance },
    layout: { ...config.layout },
    components: { ...config.components },
    behavior: { ...config.behavior }
  }
}

export function normalizeDynamicIslandConfig(raw: unknown): DynamicIslandConfig {
  const value = asRecord(raw)
  const appearance = asRecord(value.appearance)
  const layout = asRecord(value.layout)
  const components = asRecord(value.components)
  const behavior = asRecord(value.behavior)
  const defaults = DEFAULT_DYNAMIC_ISLAND_CONFIG

  return {
    appearance: {
      backgroundColor: normalizeHexColor(
        appearance.backgroundColor,
        defaults.appearance.backgroundColor
      ),
      backgroundOpacity: clampLimit(
        appearance.backgroundOpacity,
        'backgroundOpacity',
        defaults.appearance.backgroundOpacity
      ),
      textColor: normalizeHexColor(appearance.textColor, defaults.appearance.textColor),
      accentColor: normalizeHexColor(appearance.accentColor, defaults.appearance.accentColor),
      accentSource: pickEnum(
        appearance.accentSource,
        ['custom', 'cover'],
        defaults.appearance.accentSource
      ),
      visualizerColor: normalizeHexColor(
        appearance.visualizerColor,
        defaults.appearance.visualizerColor
      ),
      fontScale: clampLimit(appearance.fontScale, 'fontScale', defaults.appearance.fontScale),
      collapsedRadius: clampLimit(
        appearance.collapsedRadius,
        'collapsedRadius',
        defaults.appearance.collapsedRadius
      ),
      expandedRadius: clampLimit(
        appearance.expandedRadius,
        'expandedRadius',
        defaults.appearance.expandedRadius
      ),
      audioReactive: normalizeBoolean(
        appearance.audioReactive,
        defaults.appearance.audioReactive
      )
    },
    layout: {
      collapsedWidth: clampLimit(
        layout.collapsedWidth,
        'collapsedWidth',
        defaults.layout.collapsedWidth
      ),
      collapsedHeight: clampLimit(
        layout.collapsedHeight,
        'collapsedHeight',
        defaults.layout.collapsedHeight
      ),
      expandedWidth: clampLimit(layout.expandedWidth, 'expandedWidth', defaults.layout.expandedWidth),
      anchor: pickEnum(layout.anchor, ['left', 'center', 'right'], defaults.layout.anchor),
      offsetX: clampLimit(layout.offsetX, 'offsetX', defaults.layout.offsetX),
      offsetY: clampLimit(layout.offsetY, 'offsetY', defaults.layout.offsetY),
      display: pickEnum(layout.display, ['main-window', 'primary'], defaults.layout.display)
    },
    components: {
      collapsedContent: pickEnum(
        components.collapsedContent,
        ['artwork', 'track', 'lyric'],
        defaults.components.collapsedContent
      ),
      cover: normalizeBoolean(components.cover, defaults.components.cover),
      visualizer: normalizeBoolean(components.visualizer, defaults.components.visualizer),
      lyric: normalizeBoolean(components.lyric, defaults.components.lyric),
      progress: normalizeBoolean(components.progress, defaults.components.progress),
      time: normalizeBoolean(components.time, defaults.components.time),
      favorite: normalizeBoolean(components.favorite, defaults.components.favorite),
      skip: normalizeBoolean(components.skip, defaults.components.skip),
      volume: normalizeBoolean(components.volume, defaults.components.volume)
    },
    behavior: {
      expandTrigger: pickEnum(
        behavior.expandTrigger,
        ['hover', 'click'],
        defaults.behavior.expandTrigger
      ),
      collapseDelayMs: clampLimit(
        behavior.collapseDelayMs,
        'collapseDelayMs',
        defaults.behavior.collapseDelayMs
      ),
      motion: pickEnum(
        behavior.motion,
        ['off', 'fast', 'normal', 'slow'],
        defaults.behavior.motion
      ),
      visibility: pickEnum(
        behavior.visibility,
        ['always', 'when-track', 'when-playing'],
        defaults.behavior.visibility
      )
    }
  }
}

export function dynamicIslandMotionScale(config: DynamicIslandConfig): number {
  return MOTION_SCALE[config.behavior.motion]
}

/**
 * Resolve the pixel geometry shared by the native window (bounds + shape) and
 * the renderer (clip-path). `maxWidth` lets the host shrink the card on narrow
 * displays; everything else scales from the resulting width.
 */
export function resolveDynamicIslandLayout(
  config: DynamicIslandConfig,
  maxWidth = Number.POSITIVE_INFINITY
): DynamicIslandLayout {
  const width = Math.max(1, Math.round(Math.min(config.layout.expandedWidth, maxWidth)))
  const { progress, time } = config.components
  const textScale = config.appearance.fontScale / 100
  const heightCqw =
    EXPANDED_FRAME_CQW +
    (progress ? EXPANDED_PROGRESS_CQW : 0) +
    (progress && time ? EXPANDED_TIME_GAP_CQW + EXPANDED_TIME_TEXT_CQW * textScale : 0)
  const height = Math.round((width * heightCqw) / 100)

  const collapsedWidth = Math.min(config.layout.collapsedWidth, width)
  const collapsedHeight = Math.min(config.layout.collapsedHeight, height)
  const collapsedX =
    config.layout.anchor === 'left'
      ? 0
      : config.layout.anchor === 'right'
        ? width - collapsedWidth
        : Math.round((width - collapsedWidth) / 2)

  return {
    width,
    height,
    expandedRadius: Math.min(config.appearance.expandedRadius, Math.floor(height / 2)),
    collapsed: {
      x: collapsedX,
      width: collapsedWidth,
      height: collapsedHeight,
      radius: Math.min(config.appearance.collapsedRadius, Math.floor(collapsedHeight / 2))
    }
  }
}

export function resolveDynamicIslandWindowBounds(
  config: DynamicIslandConfig,
  layout: DynamicIslandLayout,
  display: DynamicIslandDisplayBounds
): DynamicIslandDisplayBounds {
  const { anchor, offsetX, offsetY } = config.layout
  const baseX =
    anchor === 'left'
      ? display.x + DYNAMIC_ISLAND_EDGE_MARGIN
      : anchor === 'right'
        ? display.x + display.width - layout.width - DYNAMIC_ISLAND_EDGE_MARGIN
        : display.x + (display.width - layout.width) / 2
  const minX = display.x
  const maxX = Math.max(minX, display.x + display.width - layout.width)
  const maxY = Math.max(display.y, display.y + display.height - layout.height)
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, baseX + offsetX))),
    y: Math.round(Math.min(maxY, display.y + offsetY)),
    width: layout.width,
    height: layout.height
  }
}

/**
 * Whether the overlay should currently be on screen. An open island never
 * disappears under the pointer; it is re-evaluated once it collapses.
 */
export function shouldShowDynamicIsland(
  config: DynamicIslandConfig,
  state: Pick<MiniPlayerStateSnapshot, 'track' | 'isPlaying' | 'isLoading'>,
  expanded: boolean
): boolean {
  if (expanded) return true
  switch (config.behavior.visibility) {
    case 'when-track':
      return state.track !== null
    case 'when-playing':
      return state.track !== null && (state.isPlaying || state.isLoading)
    default:
      return true
  }
}

function clampLimit(
  value: unknown,
  key: keyof typeof DYNAMIC_ISLAND_LIMITS,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const { min, max } = DYNAMIC_ISLAND_LIMITS[key]
  return Math.min(max, Math.max(min, Math.round(value)))
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
