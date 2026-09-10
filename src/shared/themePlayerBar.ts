import type { PlayerBarMode } from './playerBar.ts'
import type { ThemeProfileV2, ThemeSelection } from './theme.ts'
import { TWILIGHT_DEFAULT_THEME, themeTokensToCssVariables, type ThemeTone } from './theme.ts'

const COMPACT_THEME_IDS = new Set([
  'builtin:aurora-reference',
  'builtin:obsidian-glass',
  'builtin:paper-light'
])

export function sharedPlayerBarStylesheet(tone: ThemeTone): string {
  const tokens = Object.fromEntries(
    Object.entries(TWILIGHT_DEFAULT_THEME.variants[tone].tokens).filter(([id]) =>
      /^(color|surface|typography|playback|shape)\./.test(id)
    )
  )
  const declarations = Object.entries(themeTokensToCssVariables(tokens))
    .map(([name, value]) => `${name}: ${value};`)
    .join('\n')
  return `.player-bar-shell {\n${declarations}\nfont-family: var(--te-font-sans);\nfont-size: var(--te-font-size-body);\ncolor: var(--te-neutral-900);\n}`
}

export function resolveThemePlayerBarMode(
  selection: ThemeSelection | undefined,
  profile: ThemeProfileV2 | null = null
): PlayerBarMode | null {
  if (!selection || selection.kind === 'plugin') return null
  const presetId =
    selection.kind === 'builtin'
      ? selection.id
      : (profile?.source?.presetId ?? profile?.baseThemeId ?? null)
  if (!presetId) return null
  return COMPACT_THEME_IDS.has(presetId) ? 'compact' : 'standard'
}
