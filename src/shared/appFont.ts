/**
 * Global UI typography (设置 → 外观 → 全局字体).
 *
 * `system` is the neutral value: the active theme — or the built-in stacks in
 * `base.css` — keeps its own faces. Every other value is an explicit user
 * choice, so it overrides whatever the theme declares, the same way the
 * settings accent color and surface material outrank a theme profile.
 */
type BuiltinAppFontFamily = 'system' | 'inter' | 'lxgw' | 'sarasa' | 'comic'
export type AppFontFamily = BuiltinAppFontFamily | `local:${string}`

export const APP_FONT_SYSTEM = 'system' as const

export const APP_FONT_FAMILIES: readonly AppFontFamily[] = [
  'system',
  'inter',
  'lxgw',
  'sarasa',
  'comic'
]

/**
 * Kept at the tail of every stack: the picked family may only ship Latin
 * glyphs, and the packaged MiSans subsets still have to cover CJK. Falling
 * straight to a bare `serif`/`cursive` would drop the whole UI onto SimSun.
 */
const FALLBACK_STACK =
  "'MiSans', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif"

export const APP_FONT_FAMILY_STACKS: Readonly<
  Record<Exclude<BuiltinAppFontFamily, 'system'>, string>
> = {
  inter: `'Inter', 'Plus Jakarta Sans', 'Roboto', ${FALLBACK_STACK}`,
  lxgw: `'LXGW WenKai', 'LXGW WenKai GB', '霞鹜文楷', 'KaiTi', 'STKaiti', ${FALLBACK_STACK}`,
  sarasa: `'Sarasa Gothic SC', 'Sarasa Gothic', '更纱黑体 SC', ${FALLBACK_STACK}`,
  comic: `'Comic Sans MS', 'Comic Sans', ${FALLBACK_STACK}`
}

/**
 * The three typography variables every surface renders through. Overriding only
 * `--te-font-sans` leaves titles and rounded chrome on the theme font, which
 * reads as "the setting did nothing" — the bug this contract exists to prevent.
 */
export const APP_FONT_VARIABLES = [
  '--te-font-sans',
  '--te-font-display',
  '--te-font-rounded'
] as const

export function normalizeAppFontFamily(value: unknown): AppFontFamily {
  if (
    typeof value === 'string' &&
    /^local:[^"'\\;{}]{1,96}$/.test(value) &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  ) {
    const name = value.slice(6).trim()
    if (name) return `local:${name}`
  }
  return typeof value === 'string' && APP_FONT_FAMILIES.includes(value as AppFontFamily)
    ? (value as AppFontFamily)
    : APP_FONT_SYSTEM
}

/** `null` means "leave the theme's own typography alone". */
export function resolveAppFontStack(value: unknown): string | null {
  const family = normalizeAppFontFamily(value)
  if (family === APP_FONT_SYSTEM) return null
  if (family.startsWith('local:')) return `"${family.slice(6)}", ${FALLBACK_STACK}`
  return APP_FONT_FAMILY_STACKS[family as Exclude<BuiltinAppFontFamily, 'system'>]
}

/**
 * Settings-owned CSS variables, merged into the theme runtime block so the
 * choice survives a theme re-apply and lands in the startup theme cache
 * (no font flash on launch).
 */
export function appFontCssVariables(value: unknown): Record<string, string> {
  const stack = resolveAppFontStack(value)
  if (!stack) return {}
  return Object.fromEntries(APP_FONT_VARIABLES.map((name) => [name, stack]))
}
