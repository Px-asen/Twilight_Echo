/**
 * Player bar control placement — shared contract.
 *
 * Every shape lays its controls out in the same three regions the stylesheets
 * and the preset theme layouts already know by name: `left`, `center`, `right`.
 * A layout is just which controls sit in which region, in which order, stored
 * per shape so the standard bar, the mini strip and the compact bar can each
 * carry their own arrangement.
 *
 * Two things deliberately stay out of this model:
 *
 * - The progress readout. Each shape renders a different one (standard has the
 *   inline `.progress-area`, mini a long middle rail, compact a hairline along
 *   its top edge), so it is shape chrome rather than a movable control. Making
 *   it placeable would only buy arrangements nothing can render — an inline
 *   progress area in the left region of a 40px strip.
 * - Runtime availability. `exitPlayingPage` only means anything on the
 *   now-playing page, and the favourite button needs a provider that supports
 *   it. Those are conditions the bar checks while rendering, not layout rules.
 *
 * Anything else may go anywhere: rather than maintaining a per-shape allowlist
 * of what is "sensible", each shape's stylesheet sizes whatever it is handed.
 */

import type { PlayerBarMode } from './playerBar.ts'

export type PlayerBarControlId =
  /** Album art, opens the now-playing page. */
  | 'cover'
  /** Title, artist, and the live / buffering badges. */
  | 'trackInfo'
  /** Previous / play / next as one `.player-controls` group. */
  | 'transport'
  /** Play-pause on its own, for strip-shaped bars. */
  | 'playPause'
  /** `0:48 / 3:21` readout, or `LIVE`. */
  | 'time'
  | 'favorite'
  /** Sequential / list-loop / repeat / shuffle / heart cycle. */
  | 'playMode'
  | 'volume'
  /** Playback queue drawer. */
  | 'queue'
  /** HiFi console (the faders panel). */
  | 'hifi'
  | 'equalizer'
  | 'desktopLyrics'
  /** Detach into the separate mini player window. */
  | 'miniPlayer'
  /** Leave the now-playing page; rendered only while that page is open. */
  | 'exitPlayingPage'

export const PLAYER_BAR_CONTROL_IDS: readonly PlayerBarControlId[] = [
  'cover',
  'trackInfo',
  'transport',
  'playPause',
  'time',
  'favorite',
  'playMode',
  'volume',
  'queue',
  'hifi',
  'equalizer',
  'desktopLyrics',
  'miniPlayer',
  'exitPlayingPage'
]

export type PlayerBarRegionName = 'left' | 'center' | 'right'

export const PLAYER_BAR_REGION_NAMES: readonly PlayerBarRegionName[] = ['left', 'center', 'right']

export type PlayerBarRegions = Record<PlayerBarRegionName, PlayerBarControlId[]>

/** One arrangement per shape, so switching shape switches arrangement with it. */
export type PlayerBarLayoutSettings = Record<PlayerBarMode, PlayerBarRegions>

/**
 * Ordinary pages keep artwork and metadata on the left. The now-playing page
 * applies its separate desktop arrangement without changing saved layouts.
 */
export const DEFAULT_PLAYER_BAR_LAYOUT: PlayerBarLayoutSettings = {
  standard: {
    left: ['cover', 'trackInfo'],
    center: ['playMode', 'transport', 'volume'],
    right: ['favorite', 'queue', 'miniPlayer', 'desktopLyrics', 'hifi']
  },
  mini: {
    left: ['playMode', 'transport', 'volume'],
    center: [],
    right: ['queue', 'hifi', 'exitPlayingPage']
  },
  compact: {
    // The artwork leads this strip and opens the now-playing page. With a cover placed,
    // `trackTitleOpensPlayingPage` stands down and the title is plain text again.
    left: ['cover', 'trackInfo', 'favorite', 'miniPlayer'],
    center: ['playMode', 'transport', 'volume'],
    // `exitPlayingPage` renders only while the now-playing page is open, so it
    // costs the main window nothing and is what gets you back out. Mini's default
    // carries it for the same reason; without it the page was reachable from the
    // strip but could only be dismissed by clicking the same entry again.
    right: ['time', 'hifi', 'equalizer', 'desktopLyrics', 'queue', 'exitPlayingPage']
  }
}

export const NOW_PLAYING_STANDARD_REGIONS: PlayerBarRegions = {
  left: ['trackInfo', 'favorite', 'miniPlayer'],
  center: ['playMode', 'transport', 'volume'],
  right: ['hifi', 'desktopLyrics', 'queue']
}

const LEGACY_STANDARD_REGIONS: PlayerBarRegions = {
  left: ['cover', 'trackInfo'],
  center: ['transport'],
  right: ['favorite', 'playMode', 'volume', 'queue', 'miniPlayer', 'desktopLyrics', 'hifi']
}

const LEGACY_DENSE_REGIONS: Record<'mini' | 'compact', PlayerBarRegions> = {
  mini: {
    left: ['playPause'],
    center: [],
    right: ['playMode', 'volume', 'queue', 'hifi', 'exitPlayingPage']
  },
  compact: {
    left: ['cover', 'trackInfo', 'favorite', 'miniPlayer'],
    center: ['playMode', 'transport', 'equalizer'],
    right: ['time', 'hifi', 'volume', 'desktopLyrics', 'queue', 'exitPlayingPage']
  }
}

function isLegacyStandardPlayerBar(raw: unknown): boolean {
  return sameRegions(raw, LEGACY_STANDARD_REGIONS) || sameRegions(raw, NOW_PLAYING_STANDARD_REGIONS)
}

function isLegacyPlayerBar(raw: unknown, mode: PlayerBarMode): boolean {
  return mode === 'standard'
    ? isLegacyStandardPlayerBar(raw)
    : sameRegions(raw, LEGACY_DENSE_REGIONS[mode])
}

export function isDefaultStandardPlayerBar(regions: PlayerBarRegions): boolean {
  return sameRegions(regions, DEFAULT_PLAYER_BAR_LAYOUT.standard)
}

function sameRegions(raw: unknown, expected: PlayerBarRegions): boolean {
  if (!isRecord(raw)) return false
  return PLAYER_BAR_REGION_NAMES.every((name) => {
    const items = raw[name]
    return (
      Array.isArray(items) &&
      items.length === expected[name].length &&
      items.every((item, index) => item === expected[name][index])
    )
  })
}

/** Either of these keeps the bar playable; a layout must retain one. */
const PLAY_CONTROL_IDS: readonly PlayerBarControlId[] = ['transport', 'playPause']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isControlId(value: unknown): value is PlayerBarControlId {
  return typeof value === 'string' && PLAYER_BAR_CONTROL_IDS.includes(value as PlayerBarControlId)
}

/**
 * Where this shape's default puts its play control. Used to restore one when a
 * stored layout has dropped every way to start playback — appending blindly to
 * the centre would drop mini's play button into the column its rail occupies.
 */
function defaultPlayControlPlacement(mode: PlayerBarMode): {
  region: PlayerBarRegionName
  id: PlayerBarControlId
} {
  const regions = DEFAULT_PLAYER_BAR_LAYOUT[mode]
  for (const region of PLAYER_BAR_REGION_NAMES) {
    for (const id of regions[region]) {
      if (PLAY_CONTROL_IDS.includes(id)) return { region, id }
    }
  }
  return { region: 'center', id: 'transport' }
}

/**
 * A control belongs to exactly one region, so the first placement wins and
 * later duplicates are dropped. A region that is absent entirely falls back to
 * its default — a partially written layout keeps the rest of its arrangement —
 * while a region stored as an empty array stays empty, because emptying one is
 * a choice the editor lets you make.
 */
function normalizeRegions(
  raw: unknown,
  fallback: PlayerBarRegions,
  mode: PlayerBarMode
): PlayerBarRegions {
  const value = isRecord(raw) ? raw : null
  const placed = new Set<PlayerBarControlId>()
  const result: PlayerBarRegions = { left: [], center: [], right: [] }

  for (const region of PLAYER_BAR_REGION_NAMES) {
    const stored = value?.[region]
    const items = Array.isArray(stored) ? stored : fallback[region]
    for (const item of items) {
      if (!isControlId(item) || placed.has(item)) continue
      placed.add(item)
      result[region].push(item)
    }
  }

  if (!PLAY_CONTROL_IDS.some((id) => placed.has(id))) {
    const placement = defaultPlayControlPlacement(mode)
    result[placement.region].push(placement.id)
  }

  return result
}

export function normalizePlayerBarLayout(raw: unknown): PlayerBarLayoutSettings {
  const value = isRecord(raw) ? raw : {}
  const result = {} as PlayerBarLayoutSettings
  for (const mode of Object.keys(DEFAULT_PLAYER_BAR_LAYOUT) as PlayerBarMode[]) {
    const stored = isLegacyPlayerBar(value[mode], mode) ? undefined : value[mode]
    result[mode] = normalizeRegions(stored, DEFAULT_PLAYER_BAR_LAYOUT[mode], mode)
  }
  return result
}

/** Deep copy: the region arrays must not be shared between two settings objects. */
export function clonePlayerBarLayout(value: PlayerBarLayoutSettings): PlayerBarLayoutSettings {
  const result = {} as PlayerBarLayoutSettings
  for (const mode of Object.keys(DEFAULT_PLAYER_BAR_LAYOUT) as PlayerBarMode[]) {
    const regions = value[mode] ?? DEFAULT_PLAYER_BAR_LAYOUT[mode]
    result[mode] = {
      left: [...regions.left],
      center: [...regions.center],
      right: [...regions.right]
    }
  }
  return result
}

/**
 * Arrangement for the shape the bar is currently rendering. Falls back to the
 * default so a settings object that predates the layout field still renders.
 */
export function resolvePlayerBarRegions(
  layout: PlayerBarLayoutSettings | undefined,
  mode: PlayerBarMode,
  onPlayingPage = false
): PlayerBarRegions {
  const stored = layout?.[mode] ?? DEFAULT_PLAYER_BAR_LAYOUT[mode]
  // Migrate exact former defaults; custom arrangements keep their placement.
  const regions = isLegacyPlayerBar(stored, mode) ? DEFAULT_PLAYER_BAR_LAYOUT[mode] : stored
  return onPlayingPage && mode === 'standard' && isDefaultStandardPlayerBar(regions)
    ? NOW_PLAYING_STANDARD_REGIONS
    : regions
}

/** Controls this shape has not placed anywhere, for the editor's add menu. */
export function unplacedPlayerBarControls(regions: PlayerBarRegions): PlayerBarControlId[] {
  const placed = new Set<PlayerBarControlId>([...regions.left, ...regions.center, ...regions.right])
  return PLAYER_BAR_CONTROL_IDS.filter((id) => !placed.has(id))
}
