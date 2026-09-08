/**
 * Player bar presentation — shared contract.
 *
 * The playbar has three shapes. `standard` is the full bar (cover, inline
 * progress, time labels). `mini` is a compact control strip: play/pause at the
 * far left, a long flat progress rail in the middle and utility tools on the
 * right. `compact` spans the window edge to edge flush with the bottom, keeping
 * a single row of controls with the progress readout as a hairline along its
 * own top edge.
 *
 * Which controls each shape puts where is a separate contract in
 * `playerBarLayout.ts`; this module only decides which shape applies.
 *
 * Visibility is a separate dimension from shape, with three steps: `visible`
 * keeps the bar on screen, `autoHide` tucks it away until the pointer
 * approaches the bottom edge, and `hidden` removes it entirely with no reveal
 * gesture at all. Both dimensions follow the same global + now-playing-override
 * structure, so the now-playing page can use a different shape, a different
 * visibility, or both. `resolvePlayerBarPresentation` is the single place that
 * decides what applies, so the shell only reads the resolved value.
 */

import {
  DEFAULT_PLAYER_BAR_LAYOUT,
  clonePlayerBarLayout,
  normalizePlayerBarLayout,
  type PlayerBarLayoutSettings
} from './playerBarLayout.ts'

export type PlayerBarMode = 'standard' | 'mini' | 'compact'
export type PlayerBarModeSource = 'theme' | 'user'

/** Playing-page shape; `inherit` follows the global `mode`. */
export type PlayerBarPageMode = PlayerBarMode | 'inherit'

export const PLAYER_BAR_MODES: readonly PlayerBarMode[] = ['standard', 'mini', 'compact']

/**
 * `autoHide` needs a shape that carries its own progress readout, so it resolves
 * for `mini` (long middle rail) and `compact` (top-edge hairline) but not for
 * `standard`, whose inline progress row is the only readout it has. `hidden`
 * applies to every shape — nothing is revealed, so nothing is lost.
 */
export type PlayerBarVisibility = 'visible' | 'autoHide' | 'hidden'

/** Playing-page visibility; `inherit` follows the global `visibility`. */
export type PlayerBarPageVisibility = PlayerBarVisibility | 'inherit'

export const PLAYER_BAR_VISIBILITIES: readonly PlayerBarVisibility[] = [
  'visible',
  'autoHide',
  'hidden'
]

export interface PlayerBarSettings {
  /** Shape used everywhere except the now-playing page. */
  mode: PlayerBarMode
  modeSource: PlayerBarModeSource
  /** Shape used on the now-playing page. */
  playingPageMode: PlayerBarPageMode
  /** Visibility used everywhere except the now-playing page. */
  visibility: PlayerBarVisibility
  /** Visibility used on the now-playing page. */
  playingPageVisibility: PlayerBarPageVisibility
  /** Which controls each shape puts in its left / centre / right region. */
  layout: PlayerBarLayoutSettings
  /** Pointer must come within this many px of the viewport bottom to reveal. */
  revealThresholdPx: number
  /** Delay before hiding once the pointer leaves the reveal zone. */
  hideDelayMs: number
}

interface Bound {
  min: number
  max: number
}

export const PLAYER_BAR_BOUNDS: Readonly<Record<'revealThresholdPx' | 'hideDelayMs', Bound>> = {
  revealThresholdPx: { min: 24, max: 400 },
  hideDelayMs: { min: 0, max: 5000 }
}

export const DEFAULT_PLAYER_BAR_SETTINGS: PlayerBarSettings = {
  mode: 'standard',
  modeSource: 'theme',
  playingPageMode: 'inherit',
  visibility: 'visible',
  playingPageVisibility: 'inherit',
  // Cloned rather than aliased: the default layout is reachable from here, and
  // an in-place edit of a settings object would otherwise rewrite the default.
  layout: clonePlayerBarLayout(DEFAULT_PLAYER_BAR_LAYOUT),
  revealThresholdPx: 120,
  hideDelayMs: 900
}

function clamp(value: unknown, bound: Bound, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(bound.max, Math.max(bound.min, value)))
}

export function normalizePlayerBarMode(value: unknown): PlayerBarMode {
  return value === 'mini' || value === 'compact' ? value : 'standard'
}

export function normalizePlayerBarModeSource(value: unknown): PlayerBarModeSource {
  return value === 'user' ? 'user' : 'theme'
}

export function normalizePlayerBarPageMode(value: unknown): PlayerBarPageMode {
  if (value === 'mini' || value === 'standard' || value === 'compact') return value
  return 'inherit'
}

export function normalizePlayerBarVisibility(value: unknown): PlayerBarVisibility {
  return value === 'autoHide' || value === 'hidden' ? value : 'visible'
}

export function normalizePlayerBarPageVisibility(value: unknown): PlayerBarPageVisibility {
  if (value === 'visible' || value === 'autoHide' || value === 'hidden') return value
  return 'inherit'
}

/**
 * Visibility used to be a single `autoHideOnPlayingPage` boolean scoped to the
 * now-playing page. Settings written before the three-step visibility exists
 * still carry it, so migrate a stored `true` onto the playing-page override and
 * leave the global step alone — the bar keeps hiding exactly where it did.
 */
function resolvePlayingPageVisibility(value: Record<string, unknown>): PlayerBarPageVisibility {
  if (value.playingPageVisibility !== undefined) {
    return normalizePlayerBarPageVisibility(value.playingPageVisibility)
  }
  return value.autoHideOnPlayingPage === true ? 'autoHide' : 'inherit'
}

export function normalizePlayerBarSettings(raw: unknown): PlayerBarSettings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    mode: normalizePlayerBarMode(value.mode),
    modeSource: normalizePlayerBarModeSource(value.modeSource),
    playingPageMode: normalizePlayerBarPageMode(value.playingPageMode),
    visibility: normalizePlayerBarVisibility(value.visibility),
    playingPageVisibility: resolvePlayingPageVisibility(value),
    layout: normalizePlayerBarLayout(value.layout),
    revealThresholdPx: clamp(
      value.revealThresholdPx,
      PLAYER_BAR_BOUNDS.revealThresholdPx,
      DEFAULT_PLAYER_BAR_SETTINGS.revealThresholdPx
    ),
    hideDelayMs: clamp(
      value.hideDelayMs,
      PLAYER_BAR_BOUNDS.hideDelayMs,
      DEFAULT_PLAYER_BAR_SETTINGS.hideDelayMs
    )
  }
}

/** The layout holds arrays, so a shallow spread would share them between copies. */
export function clonePlayerBarSettings(value: PlayerBarSettings): PlayerBarSettings {
  return { ...value, layout: clonePlayerBarLayout(value.layout) }
}

export interface PlayerBarPresentation {
  mode: PlayerBarMode
  /** Bar stays tucked away until the pointer approaches the bottom edge. */
  autoHide: boolean
  /** Bar is gone with no reveal gesture; settings is the way back. */
  hidden: boolean
}

export interface PlayerBarContext {
  onPlayingPage: boolean
}

/**
 * Resolve both dimensions for the current page, then narrow the visibility step
 * to what the shape can actually do:
 *
 * - `hidden` always wins and applies to every shape — nothing is revealed, so
 *   the standard bar loses nothing it could have shown.
 * - `autoHide` additionally needs a shape that carries its own progress readout:
 *   mini has its long middle rail, compact its top-edge hairline. On a standard
 *   bar the inline progress row is the only readout there is, so auto-hide
 *   degrades to plainly visible rather than silently hiding the progress.
 *
 * The two flags are mutually exclusive: `hidden` implies not `autoHide`.
 */
export function resolvePlayerBarPresentation(
  settings: PlayerBarSettings,
  context: PlayerBarContext
): PlayerBarPresentation {
  const pageMode = settings.playingPageMode
  const mode: PlayerBarMode = context.onPlayingPage
    ? pageMode === 'inherit'
      ? settings.mode
      : pageMode
    : settings.mode

  const pageVisibility = settings.playingPageVisibility
  const visibility: PlayerBarVisibility = context.onPlayingPage
    ? pageVisibility === 'inherit'
      ? settings.visibility
      : pageVisibility
    : settings.visibility

  const hidden = visibility === 'hidden'
  return {
    mode,
    autoHide: !hidden && visibility === 'autoHide' && playerBarShapeCanAutoHide(mode),
    hidden
  }
}

/** Shapes with their own progress readout, the precondition for auto-hide. */
export function playerBarShapeCanAutoHide(mode: PlayerBarMode): boolean {
  return mode !== 'standard'
}

/** Whether `autoHide` can take effect for a page, for disabling dependent UI. */
export function playerBarAutoHideApplies(
  settings: PlayerBarSettings,
  context: PlayerBarContext
): boolean {
  return resolvePlayerBarPresentation(settings, context).autoHide
}

/**
 * Map a 0..1 rail position to a seek target. Returns null when the timeline has
 * no usable length (live stream, duration not reported yet) so callers skip the
 * seek instead of jumping to 0.
 */
export function resolveSeekTargetSeconds(ratio: number, durationSeconds: number): number | null {
  if (!Number.isFinite(ratio) || !Number.isFinite(durationSeconds)) return null
  if (durationSeconds <= 0) return null
  if (ratio < 0 || ratio > 1) return null
  return Math.min(durationSeconds, Math.max(0, ratio * durationSeconds))
}
