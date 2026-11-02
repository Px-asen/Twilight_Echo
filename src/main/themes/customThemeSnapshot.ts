import { cloneAppearance } from '../../shared/appAppearance.ts'
import { resolveAppAccentColor } from '../../shared/appAccent.ts'
import { appFontCssVariables, appFontRenderingCssVariables } from '../../shared/appFont.ts'
import {
  normalizeThemeProfile,
  getBuiltInThemePreset,
  isBuiltInThemePresetId,
  createThemeAccentTokenOverrides,
  THEME_TOKEN_DEFINITIONS,
  resolveThemeProfileTokens,
  resolveThemeProfileWindowDefaults,
  resolveThemeProfileModes,
  type ThemeProfileV2
} from '../../shared/theme.ts'
import {
  createWorkshopProject,
  type CustomThemeInput,
  type WorkshopBase,
  type WorkshopProject
} from '../../shared/themeWorkshop.ts'

type AssetReader = (source: string) => Promise<string>

/** Capture the edited values, not just the last saved profile. All images travel with the project. */
export async function customThemeSnapshot(
  id: string,
  input: CustomThemeInput,
  profile: ThemeProfileV2 | undefined,
  base: WorkshopBase | undefined,
  readAsset: AssetReader
): Promise<WorkshopProject> {
  const normalized =
    profile &&
    (isBuiltInThemePresetId(profile.id)
      ? getBuiltInThemePreset(profile.id)
      : normalizeThemeProfile(profile))
  if (profile && !normalized) throw new Error('主题草稿无效')
  const project = createWorkshopProject(id, normalized?.name ?? '自定义主题', base)
  project.description = normalized?.description ?? ''
  const appearance = cloneAppearance(input.appearance)
  const portable = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string' && /^(?:background|theme-asset):\/\//.test(value))
      return readAsset(value)
    if (Array.isArray(value)) return Promise.all(value.map(portable))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [key, await portable(entry)])
        )
      )
    return value
  }
  const structured = normalized
    ? {
        schemaVersion: 3 as const,
        variants: {
          pureWhite: { tokens: resolveThemeProfileTokens(normalized, 'pureWhite') },
          dark: { tokens: resolveThemeProfileTokens(normalized, 'dark') }
        },
        modes: resolveThemeProfileModes(normalized),
        windowDefaults: resolveThemeProfileWindowDefaults(normalized),
        toneSchedule: normalized.toneSchedule
      }
    : { ...base?.structured, schemaVersion: 3 as const, variants: base?.structured?.variants ?? {} }
  project.base.structured = {
    ...structured,
    appearance: (await portable(appearance)) as typeof appearance,
    appearanceLayers: (await portable(
      appearance.appearanceLayers
    )) as typeof appearance.appearanceLayers
  }
  if (input.preferences) {
    const preferences = input.preferences
    for (const tone of ['pureWhite', 'dark'] as const) {
      const tokens = project.base.structured.variants[tone]?.tokens ?? {}
      const accent = tone === 'dark' ? preferences.darkAccentColor : preferences.lightAccentColor
      const palette =
        typeof accent === 'string'
          ? createThemeAccentTokenOverrides(
              resolveAppAccentColor(accent),
              tone,
              tokens['surface.app']
            )
          : {}
      project.base.structured.variants[tone] = {
        tokens: { ...tokens, ...palette, ...normalized?.overrides[tone] }
      }
    }
    const variables = {
      ...appFontCssVariables(preferences.fontFamily),
      ...appFontRenderingCssVariables(preferences.fontRendering)
    }
    for (const definition of THEME_TOKEN_DEFINITIONS) {
      const value = variables[definition.cssVariable]
      if (value === undefined) continue
      for (const tone of ['pureWhite', 'dark'] as const) {
        if (normalized?.overrides[tone][definition.id] === undefined)
          project.base.structured.variants[tone]!.tokens![definition.id] = value
      }
    }
    project.base.css += `\nhtml:root[data-theme]{${Object.entries(variables)
      .filter(([key]) => !THEME_TOKEN_DEFINITIONS.some((d) => d.cssVariable === key))
      .map(([key, value]) => `${key}:${value}!important`)
      .join(';')}}`
  }
  if (normalized) {
    const assets = new Map((normalized.assets ?? []).map((asset) => [asset.id, asset]))
    const data = new Map<string, string>()
    const assetData = async (assetId: string) => {
      const asset = assets.get(assetId)
      if (!asset) throw new Error('主题绑定的素材不存在')
      if (!data.has(assetId))
        data.set(
          assetId,
          await readAsset(`theme-asset://asset/${encodeURIComponent(normalized.id)}/${asset.path}`)
        )
      return data.get(assetId)!
    }
    const backgrounds = {
      appBackground: '--te-app-bg-image',
      localBackground: '--te-local-bg-image',
      settingsBackground: '--te-settings-bg-image',
      streamingBackground: '--te-streaming-bg-image',
      playerBackground: '--te-player-bg-image'
    }
    const rules: string[] = []
    for (const [binding, assetId] of Object.entries(normalized.assetBindings ?? {})) {
      if (!assetId) continue
      if (binding in backgrounds) {
        const variable = backgrounds[binding as keyof typeof backgrounds]
        rules.push(
          `html:root[data-theme]{${variable}:url('${await assetData(assetId)}')!important}`
        )
        if (binding === 'appBackground')
          for (const [other, inherited] of Object.entries(backgrounds)) {
            if (
              other !== binding &&
              !normalized.assetBindings?.[other as keyof typeof normalized.assetBindings]
            )
              rules.push(`html:root[data-theme]{${inherited}:var(${variable})!important}`)
          }
      } else {
        const family = (
          { sansFont: 'sans', displayFont: 'display', roundedFont: 'rounded' } as Record<
            string,
            string
          >
        )[binding]
        if (!family) continue
        const name = `custom-${id}-${family}`
        rules.push(
          `@font-face{font-family:'${name}';src:url('${await assetData(assetId)}') format('woff2');font-display:swap;font-weight:100 900}html:root[data-theme]{--te-font-${family}:'${name}',sans-serif!important}`
        )
      }
    }
    project.base.css += '\n' + rules.join('\n')
    project.base.structured.iconAssets = Object.fromEntries(
      await Promise.all(
        Object.entries(normalized.iconBindings ?? {}).map(async ([slot, assetId]) => [
          slot,
          await assetData(assetId!)
        ])
      )
    )
  }
  return project
}
