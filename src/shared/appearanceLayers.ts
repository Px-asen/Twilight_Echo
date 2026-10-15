export const APPEARANCE_LAYER_SCOPES = [
  'inner-panel',
  'outer-panel',
  'controls',
  'navigation',
  'material',
  'player-bar',
  'card'
] as const
export type AppearanceLayerScope = (typeof APPEARANCE_LAYER_SCOPES)[number]
export type AppearanceLayerTone = 'light' | 'dark'
export type AppearanceEffectMotion = 'none' | 'breathe' | 'drift'
export type ComponentMaterialMode = 'theme' | 'solid' | 'frosted' | 'liquidGlass'
export interface ComponentMaterialSettings {
  mode: ComponentMaterialMode
  colorSource: 'auto' | 'custom'
  color: string
  opacity: number
  blur: number
  saturation: number
  refraction: number
}
export function defaultComponentMaterial(
  tone: AppearanceLayerTone = 'light'
): ComponentMaterialSettings {
  return {
    mode: 'theme',
    colorSource: 'auto',
    color: tone === 'dark' ? '#202226' : '#ffffff',
    opacity: 58,
    blur: 20,
    saturation: 115,
    refraction: 2
  }
}
export interface AppearanceBodyLayer {
  enabled: boolean
  color: string
  opacity: number
}
export interface AppearanceEffectLayer extends AppearanceBodyLayer {
  image: string
  imageScale: number
  imageX: number
  imageY: number
  spread: number
  blur: number
  motion: AppearanceEffectMotion
  placement: 'inside' | 'outside'
}
export interface AppearanceSkinLayer {
  enabled: boolean
  image: string
  opacity: number
  scale: number
  x: number
  y: number
  placement: 'inside' | 'outside'
  fit: 'fill' | 'contain' | 'cover'
  /** Percentage of the source image outside its component's body rectangle. */
  frame: { top: number; right: number; bottom: number; left: number }
}
export interface AppearanceControlLayers {
  material: ComponentMaterialSettings
  body: AppearanceBodyLayer
  effect: AppearanceEffectLayer
  skin: AppearanceSkinLayer
}
export interface AppearanceLayersSettings {
  version: 1
  innerRadius: number
  scopes: Record<AppearanceLayerScope, Record<AppearanceLayerTone, AppearanceControlLayers>>
}
export function defaultAppearanceLayers(): AppearanceLayersSettings {
  return {
    version: 1,
    innerRadius: 8,
    scopes: Object.fromEntries(
      APPEARANCE_LAYER_SCOPES.map((scope) => [
        scope,
        Object.fromEntries(
          (['light', 'dark'] as const).map((tone) => [
            tone,
            {
              material: defaultComponentMaterial(tone),
              body: {
                enabled: false,
                color: tone === 'dark' ? '#202226' : '#ffffff',
                opacity: 100
              },
              skin: {
                enabled: false,
                image: '',
                opacity: 100,
                scale: 100,
                x: 0,
                y: 0,
                placement: 'outside',
                fit: 'fill',
                frame: { top: 0, right: 0, bottom: 0, left: 0 }
              },
              effect: {
                enabled: false,
                image: '',
                imageScale: 100,
                imageX: 0,
                imageY: 0,
                color: tone === 'dark' ? '#aab6d2' : '#637695',
                opacity: 30,
                spread: 6,
                blur: 16,
                motion: 'none',
                placement: 'outside'
              }
            }
          ])
        )
      ])
    ) as AppearanceLayersSettings['scopes']
  }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function bounded(value: unknown, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(max, value))
    : fallback
}
function signed(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
}
function normalizeBody(raw: unknown, fallback: AppearanceBodyLayer): AppearanceBodyLayer {
  const value = object(raw)
  return {
    enabled: value.enabled === true,
    color:
      typeof value.color === 'string' && /^#[a-f\d]{6}$/i.test(value.color)
        ? value.color.toLowerCase()
        : fallback.color,
    opacity: bounded(value.opacity, 100, fallback.opacity)
  }
}
function imageHandle(value: unknown): string {
  return typeof value === 'string' &&
    /^background:\/\/[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/i.test(value)
    ? value
    : ''
}
function normalizeSkin(raw: unknown, fallback: AppearanceSkinLayer): AppearanceSkinLayer {
  const value = object(raw)
  const frame = object(value.frame)
  return {
    enabled: value.enabled === true,
    image: imageHandle(value.image),
    opacity: bounded(value.opacity, 100, fallback.opacity),
    scale: signed(value.scale, 20, 300, fallback.scale),
    x: signed(value.x, -100, 100, fallback.x),
    y: signed(value.y, -100, 100, fallback.y),
    placement: value.placement === 'inside' ? 'inside' : 'outside',
    fit: value.fit === 'contain' || value.fit === 'cover' ? value.fit : 'fill',
    frame: {
      top: bounded(frame.top, 45, 0),
      right: bounded(frame.right, 45, 0),
      bottom: bounded(frame.bottom, 45, 0),
      left: bounded(frame.left, 45, 0)
    }
  }
}
export function normalizeAppearanceLayers(raw: unknown): AppearanceLayersSettings {
  const value = object(raw)
  const scopes = object(value.scopes)
  const result = defaultAppearanceLayers()
  result.innerRadius = bounded(value.innerRadius, 48, result.innerRadius)
  for (const scope of APPEARANCE_LAYER_SCOPES) {
    const tones = object(scopes[scope])
    for (const tone of ['light', 'dark'] as const) {
      const layers = object(tones[tone])
      const fallback = result.scopes[scope][tone]
      const effect = object(layers.effect)
      const legacyImage = imageHandle(effect.image)
      const migrateImage = scope !== 'controls' && layers.skin === undefined && !!legacyImage
      result.scopes[scope][tone] = {
        material: normalizeComponentMaterial(layers.material, tone),
        body: normalizeBody(layers.body, fallback.body),
        skin: normalizeSkin(
          migrateImage
            ? {
                enabled: effect.enabled,
                image: legacyImage,
                opacity: effect.opacity,
                scale: effect.imageScale,
                x: effect.imageX,
                y: effect.imageY,
                placement: effect.placement,
                fit: 'contain'
              }
            : layers.skin,
          fallback.skin
        ),
        effect: {
          ...normalizeBody(effect, fallback.effect),
          enabled: migrateImage ? false : effect.enabled === true,
          image: legacyImage,
          imageScale: signed(effect.imageScale, 20, 300, fallback.effect.imageScale),
          imageX: signed(effect.imageX, -100, 100, fallback.effect.imageX),
          imageY: signed(effect.imageY, -100, 100, fallback.effect.imageY),
          spread: bounded(effect.spread, 48, fallback.effect.spread),
          blur: bounded(effect.blur, 64, fallback.effect.blur),
          motion: effect.motion === 'breathe' || effect.motion === 'drift' ? effect.motion : 'none',
          placement: effect.placement === 'inside' ? 'inside' : 'outside'
        }
      }
    }
  }
  return result
}
export function appearanceLayerScope(part: string): AppearanceLayerScope | undefined {
  return APPEARANCE_LAYER_SCOPES.find((scope) => scope === part)
}
export function normalizeComponentMaterial(
  raw: unknown,
  tone: AppearanceLayerTone = 'light'
): ComponentMaterialSettings {
  const value = object(raw)
  const defaults = defaultComponentMaterial(tone)
  return {
    colorSource: value.colorSource === 'custom' ? 'custom' : 'auto',
    color:
      typeof value.color === 'string' && /^#[a-f\d]{6}$/i.test(value.color)
        ? value.color.toLowerCase()
        : defaults.color,
    mode: ['solid', 'frosted', 'liquidGlass'].includes(String(value.mode))
      ? (value.mode as ComponentMaterialMode)
      : 'theme',
    opacity: bounded(value.opacity, 100, defaults.opacity),
    blur: bounded(value.blur, 40, defaults.blur),
    saturation: signed(value.saturation, 50, 180, defaults.saturation),
    refraction: bounded(value.refraction, 8, defaults.refraction)
  }
}
