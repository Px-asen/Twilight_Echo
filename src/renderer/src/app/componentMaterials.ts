import {
  type AppearanceLayersSettings,
  type AppearanceLayerScope,
  type AppearanceLayerTone
} from '../../../shared/appearanceLayers'
import { CARD_SURFACE_SELECTOR, STRUCTURAL_CONTROL_SELECTOR } from '../../../shared/cardSurfaces'

export const COMPONENT_MATERIAL_SELECTORS: Partial<Record<AppearanceLayerScope, string>> = {
  controls:
    'button,input:not([type="range"],[type="checkbox"],[type="radio"],[type="hidden"],[type="color"]),select,textarea,[role="switch"]',
  navigation: '.side-menu,.queue-sidebar,.playback-queue-sidebar',
  material: '.title-bar-background',
  'player-bar': '.player-bar',
  card: CARD_SURFACE_SELECTOR
}

/** Explicit per-part materials are CSS-only: lists do not acquire observers or raster maps. */
export function componentMaterialStyles(
  settings: AppearanceLayersSettings,
  tone: AppearanceLayerTone
): string {
  const rules: string[] = []
  // A contact shadow and a restrained upper highlight read as outward relief
  // without adding another tinted background over the selected glass material.
  const raisedButton = `:is(.app-shell-content,.app-shell-player) :is(button,[role="button"]):not(:is(.appearance-window-preview *,.appearance-window-region,.appearance-inspector *,.appearance-popover *,[data-te-appearance-ignore],[data-te-appearance-ignore] *,.menu-item,.sidebar-bookmark,.lyric-row,${STRUCTURAL_CONTROL_SELECTOR},${CARD_SURFACE_SELECTOR}))`
  rules.push(
    `${raisedButton}{box-shadow:0 1px 3px rgb(0 0 0 / 12%),inset 0 1px 0 rgb(255 255 255 / 7%)!important;}`,
    `${raisedButton}:active:not(:disabled,[aria-disabled="true"]){box-shadow:0 0 1px rgb(0 0 0 / 10%),inset 0 1px 2px rgb(0 0 0 / 12%)!important;}`,
    `${raisedButton}:is(:disabled,[aria-disabled="true"]){box-shadow:none!important;}`,
    `@media(forced-colors:active){${raisedButton}{box-shadow:none!important;}}`
  )
  for (const [scope, targets] of Object.entries(COMPONENT_MATERIAL_SELECTORS)) {
    const layer = settings.scopes[scope as AppearanceLayerScope][tone]
    const material = layer.material
    if (material.mode === 'theme') continue
    const ignored =
      '.appearance-inspector,.appearance-inspector *,.appearance-popover,.appearance-popover *,[data-te-appearance-ignore],[data-te-appearance-ignore] *,.te-dialog,.te-dialog *' +
      (scope === 'controls' ? ',.title-bar,.title-bar *,' + STRUCTURAL_CONTROL_SELECTOR : '')
    const controls =
      scope === 'controls'
        ? ':not(.menu-item,.sidebar-bookmark,.window-btn,[aria-pressed="true"],[aria-selected="true"],.active,.is-active,.primary,.btn-primary,.transport-play,.player-play-btn)'
        : ''
    const selector = `:is(${targets}):not(:is(${ignored}))${controls}`
    const solid =
      material.colorSource === 'custom'
        ? material.color
        : 'var(--te-image-control-surface,var(--te-chrome-material-solid))'
    const glass = material.mode !== 'solid'
    const background = glass
      ? `color-mix(in srgb,${solid} ${material.opacity}%,transparent)`
      : solid
    const filter = glass
      ? `blur(${material.blur}px) saturate(${material.saturation}%)${material.mode === 'liquidGlass' && material.refraction ? ` url("#te-component-liquid-${scope}")` : ''}`
      : 'none'
    rules.push(
      `${selector}{--te-component-material-solid:${solid};background-color:${background}!important;background-image:none!important;backdrop-filter:${filter}!important;-webkit-backdrop-filter:${filter}!important;}`
    )
    if (scope === 'navigation') {
      // The handle and panel share one surface; no bright, separately mixed SVG tab.
      rules.push(
        `.sidebar-bookmark{--te-bookmark-surface:${background};--te-bookmark-filter:${filter};}`
      )
      rules.push(
        `${selector}::before{background:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}`
      )
    }
    if (scope === 'player-bar')
      rules.push(
        `${selector}::before{background:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}`
      )
    const fallback = `${selector}{background-color:${solid}!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}`
    const handleFallback =
      scope === 'navigation'
        ? `.sidebar-bookmark{--te-bookmark-surface:${solid}!important;--te-bookmark-filter:none!important;}`
        : ''
    rules.push(
      `html[data-te-effects-mode="reduced"] ${selector},body.te-no-blur ${selector}{background-color:${solid}!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}`
    )
    rules.push(
      `@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){${fallback}${handleFallback}}@supports not(backdrop-filter:blur(1px)){${fallback}${handleFallback}}`
    )
    if (handleFallback)
      rules.push(
        `html[data-te-effects-mode="reduced"] .sidebar-bookmark,body.te-no-blur .sidebar-bookmark{--te-bookmark-surface:${solid}!important;--te-bookmark-filter:none!important;}`
      )
    rules.push(
      `@media(forced-colors:active){${selector}{background:Canvas!important;color:CanvasText!important;border-color:CanvasText!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}}`
    )
  }
  return `@layer te-appearance.components {${rules.join('\n')}}`
}

/** One small static filter per opted-in part, shared by every widget. No pointer work. */
export function componentMaterialDefinitions(
  settings: AppearanceLayersSettings,
  tone: AppearanceLayerTone
): string {
  return Object.keys(COMPONENT_MATERIAL_SELECTORS)
    .flatMap((scope) => {
      const material = settings.scopes[scope as AppearanceLayerScope][tone].material
      return material.mode === 'liquidGlass' && material.refraction > 0
        ? [
            `<filter id="te-component-liquid-${scope}" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="1" seed="17" result="surface"/><feDisplacementMap in="SourceGraphic" in2="surface" scale="${material.refraction}" xChannelSelector="R" yChannelSelector="G"/></filter>`
          ]
        : []
    })
    .join('')
}
