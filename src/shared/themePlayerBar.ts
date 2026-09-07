import type { PlayerBarMode } from './playerBar.ts'
import type { ThemeProfileV2, ThemeSelection } from './theme.ts'

const AURORA_REFERENCE_THEME_ID = 'builtin:aurora-reference'

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
  return presetId === AURORA_REFERENCE_THEME_ID ? 'compact' : 'standard'
}
