import type {
  AppBackgroundColorPair,
  AppBackgroundEffect,
  AppBackgroundImagePalette,
  AppBackgroundPage,
  AppBackgroundSettings,
  AppSettings,
  BackgroundEffectSettings,
  BackgroundTextTone,
  CardAppearanceSettings,
  CardAppearanceTheme
} from './appSettings.ts'
import { normalizeLiquidGlass, normalizeSurfaceMaterial } from './liquidGlass.ts'
import { normalizeNavigationPagePreferences } from './navigationPages.ts'
import { normalizePlayerBarSettings } from './playerBar.ts'
import { normalizeAppearanceLayers } from './appearanceLayers.ts'
import { ensureThemeTextContrast, themeContrastRatio } from './theme.ts'
import { MIN_READING_FADE } from './materials.ts'
import { backgroundDisplayUrl } from './backgroundDisplay.ts'

export type AppearanceDraft = Pick<
  AppSettings,
  'appBackground' | 'cardAppearance' | 'surfaceMaterial' | 'liquidGlass'
> &
  Partial<Pick<AppSettings, 'navigationPages' | 'playerBar' | 'appearanceLayers'>>
export type AppearanceTone = 'light' | 'dark'
export type AppearancePreset = 'theme' | 'transparent' | 'frosted' | 'liquidGlass'
export const BACKGROUND_PAGES: readonly AppBackgroundPage[] = [
  'local',
  'settings',
  'streaming',
  'player'
]
export const BACKGROUND_EFFECT_RANGES = {
  blur: { min: 0, max: 30, step: 1, suffix: 'px', label: '背景模糊' },
  dim: { min: 0, max: 80, step: 1, suffix: '%', label: '遮罩浓度' },
  brightness: { min: 50, max: 120, step: 1, suffix: '%', label: '背景亮度' },
  scale: { min: 1, max: 3, step: 0.01, suffix: '×', label: '画面缩放' },
  positionX: { min: 0, max: 100, step: 1, suffix: '%', label: '水平位置' },
  positionY: { min: 0, max: 100, step: 1, suffix: '%', label: '垂直位置' }
} as const

export function defaultBackgroundEffect(): AppBackgroundEffect {
  return {
    blur: 0,
    brightness: 100,
    dim: 0,
    scale: 1,
    positionX: 50,
    positionY: 50,
    textTone: 'theme'
  }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function number(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}
function hex(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#?[a-f\d]{6}$/i.test(value.trim())
    ? `#${value.trim().replace(/^#/, '').toLowerCase()}`
    : fallback
}
export function normalizeBackgroundImagePalette(
  raw: unknown,
  image: string
): AppBackgroundImagePalette | undefined {
  const value = object(raw)
  if (
    !/^background:\/\/[a-zA-Z0-9._-]+$/.test(image) ||
    value.image !== image ||
    typeof value.average !== 'string' ||
    !/^#[a-f\d]{6}$/i.test(value.average) ||
    typeof value.accent !== 'string' ||
    !/^#[a-f\d]{6}$/i.test(value.accent)
  )
    return undefined
  return {
    image,
    average: value.average.toLowerCase(),
    accent: value.accent.toLowerCase(),
    opacity: number(value.opacity, 0, 1, 1)
  }
}
export function normalizeBackgroundEffect(raw: unknown): AppBackgroundEffect {
  const value = object(raw)
  const result = defaultBackgroundEffect()
  for (const field of Object.keys(BACKGROUND_EFFECT_RANGES) as Array<
    keyof typeof BACKGROUND_EFFECT_RANGES
  >) {
    const range = BACKGROUND_EFFECT_RANGES[field]
    result[field] = number(value[field], range.min, range.max, result[field])
  }
  result.textTone =
    value.textTone === 'light' || value.textTone === 'dark' ? value.textTone : 'theme'
  return result
}
export function defaultBackground(
  page: 'global' | AppBackgroundPage = 'global'
): AppBackgroundColorPair {
  const lights = {
    global: '#f4f4f7',
    local: '#ffffff',
    streaming: '#fafbfe',
    settings: '#f4f4f7',
    player: '#080e17'
  }
  return {
    kind: 'color',
    image: '',
    customized: false,
    light: lights[page],
    dark: '#17181a',
    effects: { light: defaultBackgroundEffect(), dark: defaultBackgroundEffect() }
  }
}
export function normalizeAppBackgroundSettings(
  raw: unknown,
  legacy?: BackgroundEffectSettings
): AppBackgroundSettings {
  const value = object(raw)
  const pair = (rawPair: unknown, page: 'global' | AppBackgroundPage): AppBackgroundColorPair => {
    const source = object(rawPair)
    const defaults = defaultBackground(page)
    const effects = object(source.effects)
    const followsTheme = source.kind === 'theme' || source.kind === 'none'
    const image =
      typeof source.image === 'string' && /^background:\/\/[a-zA-Z0-9._-]+$/.test(source.image)
        ? source.image
        : ''
    const imagePalette = normalizeBackgroundImagePalette(source.imagePalette, image)
    return {
      light: hex(source.light, defaults.light),
      dark: hex(source.dark, defaults.dark),
      kind: followsTheme ? 'theme' : source.kind === 'image' ? 'image' : 'color',
      image,
      ...(imagePalette ? { imagePalette } : {}),
      customized:
        !followsTheme &&
        (source.customized === true ||
          hex(source.light, defaults.light) !== defaults.light ||
          hex(source.dark, defaults.dark) !== defaults.dark),
      effects: {
        light: normalizeBackgroundEffect(
          effects.light ?? (source.effects == null && legacy?.enabled ? legacy.light : undefined)
        ),
        dark: normalizeBackgroundEffect(
          effects.dark ?? (source.effects == null && legacy?.enabled ? legacy.dark : undefined)
        )
      }
    }
  }
  const global = pair(value.global, 'global')
  const pages = object(value.pages)
  return {
    global,
    pages: Object.fromEntries(
      BACKGROUND_PAGES.map((page) => [
        page,
        { ...pair(pages[page], page), inherit: object(pages[page]).inherit !== false }
      ])
    ) as AppBackgroundSettings['pages']
  }
}
export function resolveBackground(
  background: AppBackgroundSettings,
  page: AppBackgroundPage
): AppBackgroundColorPair {
  return background.pages[page].inherit ? background.global : background.pages[page]
}
export function backgroundEffect(
  background: AppBackgroundColorPair,
  tone: AppearanceTone
): AppBackgroundEffect {
  return normalizeBackgroundEffect(background.effects?.[tone])
}

export function hasBackgroundImage(background: AppBackgroundColorPair): boolean {
  return background.kind === 'image' && /^background:\/\/[a-zA-Z0-9._-]+$/.test(background.image)
}

/** Image tuning stays saved while a solid color or the theme is being shown. */
export function effectiveBackgroundEffect(
  background: AppBackgroundColorPair,
  tone: AppearanceTone
): AppBackgroundEffect {
  const configured = backgroundEffect(background, tone)
  return hasBackgroundImage(background)
    ? configured
    : { ...defaultBackgroundEffect(), textTone: configured.textTone }
}

export interface ResolvedBackgroundAppearance {
  background: AppBackgroundColorPair
  effect: AppBackgroundEffect
  hasImage: boolean
  colorOverride: boolean
  imageOverride: boolean
  customBackground: boolean
}

/** One ownership decision for the live renderer and the isolated editor preview. */
export function resolveBackgroundAppearance(
  settings: AppBackgroundSettings,
  page: 'app' | AppBackgroundPage,
  tone: AppearanceTone
): ResolvedBackgroundAppearance {
  const background = page === 'app' ? settings.global : resolveBackground(settings, page)
  const hasImage = hasBackgroundImage(background)
  const independent = page !== 'app' && !settings.pages[page].inherit
  const explicitColor =
    background.kind === 'color' && (background.customized === true || independent)
  const customBackground = explicitColor || hasImage
  return {
    background,
    effect: customBackground
      ? effectiveBackgroundEffect(background, tone)
      : defaultBackgroundEffect(),
    hasImage,
    colorOverride: customBackground,
    imageOverride: customBackground,
    customBackground
  }
}
type BackgroundRgb = [number, number, number]
function backgroundRgb(color: string): BackgroundRgb {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16)
  ) as BackgroundRgb
}
function backgroundHex(color: BackgroundRgb): string {
  return `#${color
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}
function mixBackgroundColor(base: string, color: string, amount: number): string {
  const rgb = backgroundRgb(color)
  return backgroundHex(
    backgroundRgb(base).map(
      (channel, index) => channel * (1 - amount) + rgb[index] * amount
    ) as BackgroundRgb
  )
}
export interface ResolvedBackgroundPalette {
  textTone: 'light' | 'dark'
  text: string
  muted: string
  background: string
  controlBackground: string
  controlHover: string
  controlActive: string
  controlForeground: string
  controlMuted: string
  controlBorder: string
  readingText: string
  readingMuted: string
  accent: string
  onAccent: string
}
/** Re-evaluate the saved local sample when brightness, dimming or the solid base changes. */
export function resolveBackgroundPalette(
  background: AppBackgroundColorPair,
  tone: AppearanceTone
): ResolvedBackgroundPalette | null {
  if (background.kind !== 'image') return null
  const palette = normalizeBackgroundImagePalette(background.imagePalette, background.image)
  if (!palette) return null
  const effect = effectiveBackgroundEffect(background, tone)
  const composited = mixBackgroundColor(
    hex(background[tone], tone === 'dark' ? '#17181a' : '#f4f4f7'),
    palette.average,
    palette.opacity ?? 1
  )
  const sampledBackground = backgroundHex(
    backgroundRgb(composited).map(
      (channel) => Math.min(255, (channel * effect.brightness) / 100) * (1 - effect.dim / 100)
    ) as BackgroundRgb
  )
  const light = '#f4f7fb'
  const dark = '#1a202c'
  const automaticTone =
    (themeContrastRatio(light, sampledBackground) ?? 0) >
    (themeContrastRatio(dark, sampledBackground) ?? 0)
      ? 'light'
      : 'dark'
  const textTone = effect.textTone === 'theme' ? automaticTone : effect.textTone
  const preferredText = textTone === 'light' ? light : dark
  const text =
    effect.textTone === 'theme'
      ? ensureThemeTextContrast(preferredText, sampledBackground)
      : preferredText
  const muted =
    effect.textTone === 'theme'
      ? ensureThemeTextContrast(textTone === 'light' ? '#c4cbd5' : '#4b5563', sampledBackground)
      : textTone === 'light'
        ? '#c4cbd5'
        : '#4b5563'
  // Images choose the tint and the ink directly over the wallpaper. Painted
  // surfaces retain the selected day/night mode, independently of that ink.
  const controlBackground = mixBackgroundColor(
    tone === 'dark' ? '#1c1d20' : '#f4f5f7',
    palette.accent,
    0.035
  )
  const controlForeground = ensureThemeTextContrast(
    tone === 'dark' ? light : dark,
    controlBackground
  )
  const accent = ensureThemeTextContrast(palette.accent, controlBackground, 3)
  // Reading pages fade the image toward the mode's surface. Validate against
  // its least favourable pixel, not the average of the unwashed wallpaper.
  const readingLimit = mixBackgroundColor(
    tone === 'dark' ? '#ffffff' : '#000000',
    controlBackground,
    MIN_READING_FADE
  )
  return {
    textTone,
    text,
    muted,
    background: sampledBackground,
    controlBackground,
    controlHover: mixBackgroundColor(controlBackground, controlForeground, 0.08),
    controlActive: mixBackgroundColor(controlBackground, controlForeground, 0.14),
    controlForeground,
    controlMuted: ensureThemeTextContrast(
      tone === 'dark' ? '#c4cbd5' : '#4b5563',
      controlBackground
    ),
    controlBorder: mixBackgroundColor(controlBackground, controlForeground, 0.2),
    readingText: ensureThemeTextContrast(controlForeground, readingLimit),
    readingMuted: ensureThemeTextContrast(tone === 'dark' ? '#c4cbd5' : '#4b5563', readingLimit),
    accent,
    onAccent: ensureThemeTextContrast('#ffffff', accent)
  }
}
/** Effective marker for the existing page foreground rules; explicit user choices win. */
export function resolveBackgroundTextTone(
  background: AppBackgroundColorPair,
  tone: AppearanceTone
): BackgroundTextTone {
  const selected = backgroundEffect(background, tone).textTone
  return selected === 'theme'
    ? (resolveBackgroundPalette(background, tone)?.textTone ?? 'theme')
    : selected
}
export const BACKGROUND_TEXT_PALETTES = {
  light: { text: '#f4f7fb', muted: '#c4cbd5' },
  dark: { text: '#1a202c', muted: '#4b5563' }
} as const

export function backgroundCssVariables(
  background: AppBackgroundColorPair,
  tone: AppearanceTone
): Record<string, string> {
  const effect = effectiveBackgroundEffect(background, tone)
  const palette = resolveBackgroundPalette(background, tone)
  const textLight = effect.textTone === 'theme' ? tone === 'dark' : effect.textTone === 'light'
  return {
    '--appearance-color': background[tone],
    '--appearance-image': hasBackgroundImage(background)
      ? `url("${backgroundDisplayUrl(background.image).replace(/["\\\n\r]/g, '')}")`
      : 'none',
    '--appearance-blur': `${effect.blur}px`,
    '--appearance-brightness': `${effect.brightness}%`,
    '--appearance-dim': `${effect.dim / 100}`,
    '--appearance-scale': `${effect.scale}`,
    '--appearance-position': `${effect.positionX}% ${effect.positionY}%`,
    '--appearance-text': palette?.text ?? (textLight ? '#f4f7fb' : '#1a202c'),
    '--appearance-muted': palette?.muted ?? (textLight ? '#c4cbd5' : '#4b5563'),
    ...(palette
      ? {
          '--appearance-control-surface': palette.controlBackground,
          '--appearance-control-hover': palette.controlHover,
          '--appearance-control-active': palette.controlActive,
          '--appearance-control-text': palette.controlForeground,
          '--appearance-control-muted': palette.controlMuted,
          '--appearance-control-border': palette.controlBorder,
          '--appearance-control-accent': palette.accent,
          '--appearance-control-on-accent': palette.onAccent,
          '--appearance-reading-text': palette.readingText,
          '--appearance-reading-muted': palette.readingMuted
        }
      : {})
  }
}
export function defaultCardTheme(tone: AppearanceTone): CardAppearanceTheme {
  return {
    blurRadius: 20,
    blurSaturation: 150,
    backgroundColor: tone === 'dark' ? '#181818' : '#ffffff',
    backgroundOpacity: 100,
    borderColor: tone === 'dark' ? '#ffffff' : '#0f172a',
    borderOpacity: tone === 'dark' ? 10 : 8,
    borderWidth: 1,
    borderRadius: 16,
    shadowStrength: 'medium',
    hoverEffect: 'lift',
    glassHighlight: true
  }
}
export function defaultCardAppearance(): CardAppearanceSettings {
  return {
    enabled: false,
    light: defaultCardTheme('light'),
    dark: defaultCardTheme('dark'),
    background: {
      enabled: false,
      light: { blur: 0, brightness: 100, dim: 0 },
      dark: { blur: 0, brightness: 100, dim: 0 }
    }
  }
}
export function cloneAppearance(settings: AppearanceDraft): AppearanceDraft {
  // No proxies or shared default references escape the editing session.
  const card = settings.cardAppearance ?? defaultCardAppearance()
  return {
    appBackground: normalizeAppBackgroundSettings(settings.appBackground, card.background),
    cardAppearance: {
      enabled: card.enabled,
      light: { ...card.light },
      dark: { ...card.dark },
      background: { ...defaultCardAppearance().background }
    },
    surfaceMaterial: normalizeSurfaceMaterial(settings.surfaceMaterial),
    liquidGlass: normalizeLiquidGlass(settings.liquidGlass),
    appearanceLayers: normalizeAppearanceLayers(settings.appearanceLayers),
    ...(settings.navigationPages
      ? { navigationPages: normalizeNavigationPagePreferences(settings.navigationPages) }
      : {}),
    ...(settings.playerBar ? { playerBar: normalizePlayerBarSettings(settings.playerBar) } : {})
  }
}
export function applyAppearancePreset(
  draft: AppearanceDraft,
  preset: AppearancePreset
): AppearanceDraft {
  const result = cloneAppearance(draft)
  result.surfaceMaterial =
    preset === 'transparent' || preset === 'liquidGlass' ? preset : 'standard'
  if (preset === 'theme' || preset === 'frosted') {
    result.cardAppearance.enabled = preset === 'frosted'
    result.liquidGlass.navigationEnabled =
      result.liquidGlass.playbarEnabled =
      result.liquidGlass.settingsNavigationEnabled =
        false
    result.liquidGlass.homeCards.enabled = false
    result.liquidGlass.coverage = 'functional'
  }
  if (preset === 'frosted')
    for (const tone of ['light', 'dark'] as const) {
      if (JSON.stringify(result.cardAppearance[tone]) === JSON.stringify(defaultCardTheme(tone))) {
        result.cardAppearance[tone] = { ...defaultCardTheme(tone), backgroundOpacity: 60 }
      }
    }
  return result
}
export function cardCssVariables(card: CardAppearanceTheme): Record<string, string> {
  const color = (value: string, alpha: number): string =>
    `${hex(value, '#ffffff')}${Math.round(alpha * 2.55)
      .toString(16)
      .padStart(2, '0')}`
  const shadows = {
    none: '0 0 0 transparent',
    subtle: '0 4px 16px #00000012',
    medium: '0 12px 32px #00000024',
    strong: '0 20px 48px #00000040'
  }
  const shadow = shadows[card.shadowStrength] ?? 'none'
  return {
    '--te-card-blur': `${card.blurRadius}px`,
    '--te-card-saturate': `${card.blurSaturation}%`,
    '--te-card-bg': color(card.backgroundColor, card.backgroundOpacity),
    '--te-card-bg-solid': card.backgroundColor,
    '--te-card-border': color(card.borderColor, card.borderOpacity),
    '--te-card-border-width': `${card.borderWidth}px`,
    '--te-card-radius': `${card.borderRadius}px`,
    '--te-card-shadow': shadow,
    '--te-card-hover-transform':
      card.hoverEffect === 'lift'
        ? 'translateY(-4px)'
        : card.hoverEffect === 'zoom'
          ? 'scale(1.02)'
          : 'none',
    '--te-card-hover-shadow':
      card.hoverEffect === 'glow' ? `${shadow}, 0 0 24px rgba(var(--te-primary-rgb), .24)` : shadow,
    '--te-card-glass-highlight': card.glassHighlight
      ? 'inset 0 1px 0 #ffffff25'
      : '0 0 0 transparent'
  }
}
