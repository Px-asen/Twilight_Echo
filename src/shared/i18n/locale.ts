/**
 * Locale contract shared by main, preload and renderer.
 *
 * The app shipped as Chinese-only, so `zh-CN` stays the source of truth: it is
 * the fallback for every missing key and the default when a system locale maps
 * to nothing we ship. Adding a locale means adding a message catalog, not
 * touching this file's resolution rules.
 */

/** Locales with a shipped message catalog. */
export const APP_LOCALES = ['zh-CN', 'en-US'] as const

export type AppLocale = (typeof APP_LOCALES)[number]

/** What the user picked in settings. `system` defers to the OS locale. */
export type LanguagePreference = 'system' | AppLocale

export const DEFAULT_LOCALE: AppLocale = 'zh-CN'
export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = 'system'

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value)
}

/**
 * Map an arbitrary BCP 47 tag onto a shipped locale.
 *
 * Matching is by primary language subtag, so `zh-Hans-CN`, `zh-TW` and `zh` all
 * land on `zh-CN`, and `en-GB` lands on `en-US`. An unknown language returns
 * null so callers can decide between falling back and keeping a prior value.
 */
export function matchSystemLocale(systemLocale: unknown): AppLocale | null {
  if (typeof systemLocale !== 'string') return null
  const normalized = systemLocale.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized) return null
  if (isAppLocale(systemLocale)) return systemLocale
  const primary = normalized.split('-', 1)[0]
  if (primary === 'zh') return 'zh-CN'
  if (primary === 'en') return 'en-US'
  return null
}

/** Coerce persisted settings into a valid preference, tolerating old values. */
export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  if (value === 'system') return 'system'
  if (isAppLocale(value)) return value
  // Tolerate a region-qualified tag written by an older build or hand-edited
  // settings file: `zh-Hans-CN` should stay Chinese rather than silently reset.
  const matched = matchSystemLocale(value)
  return matched ?? DEFAULT_LANGUAGE_PREFERENCE
}

/**
 * Resolve the locale to render in. `system` consults the OS locale and falls
 * back to `zh-CN` when the OS reports something we do not ship.
 */
export function resolveLocale(
  preference: unknown,
  systemLocale?: unknown,
  fallback: AppLocale = DEFAULT_LOCALE
): AppLocale {
  const normalized = normalizeLanguagePreference(preference)
  if (normalized !== 'system') return normalized
  return matchSystemLocale(systemLocale) ?? fallback
}

/** Native `Intl`/`toLocaleString` tag for a shipped locale. */
export function intlLocale(locale: AppLocale): string {
  return locale
}

export type MessageParams = Record<string, string | number | boolean | null | undefined>

/** A catalog is flat: dotted keys, no nesting, so lookup is one property read. */
export type MessageCatalog = Readonly<Record<string, string>>

const PLACEHOLDER = /\{(\w+)\}/g
const cjkRange = (start: number, end: number): string =>
  `${String.fromCharCode(start)}-${String.fromCharCode(end)}`
const CJK_CLASS = `[${cjkRange(0x3000, 0x303f)}${cjkRange(0x3400, 0x4dbf)}${cjkRange(0x4e00, 0x9fff)}${cjkRange(0xf900, 0xfaff)}]`
// Constructed dynamically so Vite/esbuild IIFE bundles stay pure ASCII when loaded without a UTF-8 meta charset.
const CJK_SPACE_CJK = new RegExp(`(${CJK_CLASS}) +(?=${CJK_CLASS})`, 'g')

/**
 * Substitute `{name}` placeholders and strip inter-script spaces introduced between
 * CJK template fragments and CJK interpolated parameters.
 */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template
  const substituted = template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name]
    if (value === undefined || value === null) return match
    return String(value)
  })
  return substituted === template ? substituted : substituted.replace(CJK_SPACE_CJK, '$1')
}
