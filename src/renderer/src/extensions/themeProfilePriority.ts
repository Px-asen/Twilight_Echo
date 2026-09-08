import {
  isBuiltInThemePresetId,
  themeTokensToCssVariables,
  type ThemeProfileV2,
  type ThemeTone
} from '../../../shared/theme.ts'

export function applyExplicitThemePreferences(
  profile: ThemeProfileV2 | null,
  tone: ThemeTone,
  themed: Record<string, string>,
  variables: Record<string, string>
): void {
  if (!profile || isBuiltInThemePresetId(profile.id)) return
  const explicit = themeTokensToCssVariables(profile.overrides[tone])
  for (const variable of Object.keys(explicit)) {
    variables[variable] = themed[variable] ?? explicit[variable]
  }
  if (profile.modes.appearance?.accentSource === 'cover') {
    for (const variable of [
      '--te-primary-500',
      '--te-primary-400',
      '--te-primary-300',
      '--te-primary-rgb',
      '--te-glow-main',
      '--te-active-bg',
      '--te-navigation-active-text',
      '--te-navigation-indicator',
      '--te-playback-accent'
    ]) {
      if (themed[variable] != null) variables[variable] = themed[variable]
    }
  }
  if (profile.overrides[tone]['library.page.surface'] != null) {
    variables['--te-library-custom-bg'] = themed['--te-library-bg']
  }
  const bindings = profile.assetBindings ?? {}
  for (const [binding, variable] of [
    ['sansFont', '--te-font-sans'],
    ['displayFont', '--te-font-display'],
    ['roundedFont', '--te-font-rounded']
  ] as const) {
    if (bindings[binding] && themed[variable]) variables[variable] = themed[variable]
  }
  const backgroundMode = profile.modes.appearance?.backgroundTreatment
  for (const page of ['app', 'local', 'settings', 'streaming', 'player'] as const) {
    const binding = `${page}Background` as const
    if (
      bindings[binding] ||
      bindings.appBackground ||
      (page !== 'player' && backgroundMode) ||
      profile.overrides[tone][`surface.${page}`] != null
    ) {
      const variable = `--te-${page}-bg-image`
      if (themed[variable] != null) variables[variable] = themed[variable]
    }
  }
}
