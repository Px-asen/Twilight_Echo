import {
  dynamicIslandMotionScale,
  type DynamicIslandComponentsConfig,
  type DynamicIslandConfig,
  type DynamicIslandLayout
} from '../../../shared/dynamicIsland.ts'

/** Fallback for collapse commits when `transitionend` never fires (e.g. reduced motion). */
export const COLLAPSE_COMMIT_FALLBACK_MS = 650

const HEX_COLOR = /^#[\da-f]{6}$/i

/** `#ff8fb6` -> `255 143 182`, for use inside `rgb(var(--x) / alpha)`. */
export function hexToRgbChannels(hex: string): string {
  const value = HEX_COLOR.test(hex) ? hex.slice(1) : '000000'
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).join(' ')
}

export function resolveIslandAccent(
  config: DynamicIslandConfig,
  dominantColor: string,
  hasTrack: boolean
): string {
  return config.appearance.accentSource === 'cover' && hasTrack && HEX_COLOR.test(dominantColor)
    ? dominantColor
    : config.appearance.accentColor
}

export function islandActionCount(components: DynamicIslandComponentsConfig): number {
  // The play/pause toggle is always present.
  return 1 + Number(components.favorite) + Number(components.skip) * 2 + Number(components.volume)
}

export function islandCollapseCommitDelayMs(config: DynamicIslandConfig): number {
  return Math.round(COLLAPSE_COMMIT_FALLBACK_MS * dynamicIslandMotionScale(config))
}

/** CSS custom properties that drive every configurable part of the island stylesheet. */
export function createIslandStyle(
  config: DynamicIslandConfig,
  layout: DynamicIslandLayout,
  accentColor: string
): Record<string, string> {
  const { appearance, components } = config
  const { width, height, collapsed } = layout
  const headingColumns = [
    components.cover ? '17.55cqw' : '',
    'minmax(0, 1fr)',
    components.visualizer ? '7.2cqw' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return {
    '--island-collapsed-x': `${collapsed.x}px`,
    '--island-collapsed-width': `${collapsed.width}px`,
    '--island-collapsed-height': `${collapsed.height}px`,
    '--island-collapsed-inset-right': `${Math.max(0, width - collapsed.x - collapsed.width)}px`,
    '--island-collapsed-inset-bottom': `${Math.max(0, height - collapsed.height)}px`,
    '--island-collapsed-radius': `${collapsed.radius}px`,
    '--island-expanded-radius': `${layout.expandedRadius}px`,
    '--island-origin':
      config.layout.anchor === 'left'
        ? 'top left'
        : config.layout.anchor === 'right'
          ? 'top right'
          : 'top center',
    '--island-bg-rgb': hexToRgbChannels(appearance.backgroundColor),
    '--island-bg-alpha': (appearance.backgroundOpacity / 100).toFixed(2),
    '--island-text-rgb': hexToRgbChannels(appearance.textColor),
    '--island-accent-rgb': hexToRgbChannels(accentColor),
    '--island-visualizer-rgb': hexToRgbChannels(appearance.visualizerColor),
    '--island-font-scale': (appearance.fontScale / 100).toFixed(2),
    '--island-motion': String(dynamicIslandMotionScale(config)),
    '--island-heading-columns': headingColumns,
    '--island-action-count': String(islandActionCount(components))
  }
}
