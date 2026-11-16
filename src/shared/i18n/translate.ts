/**
 * Minimal message formatter. No runtime dependency, no compile step: the
 * catalogs are plain objects, so main, preload and renderer all use the same
 * `t()` without pulling a framework into the main process.
 *
 * Deliberately not vue-i18n: half the strings that need localizing are thrown
 * from the main process, where a Vue plugin cannot reach.
 */
import {
  DEFAULT_LOCALE,
  formatMessage,
  type AppLocale,
  type MessageCatalog,
  type MessageParams
} from './locale.ts'
import { MESSAGES } from './messages/index.ts'

export { formatMessage, type MessageCatalog, type MessageParams }

export function catalogFor(locale: AppLocale): MessageCatalog {
  return MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]
}

/**
 * Look up `key` in `locale`, falling back to zh-CN and finally to the key
 * itself. Returning the key (never an empty string) keeps a missing entry
 * diagnosable in a screenshot instead of rendering blank chrome.
 */
export function translate(locale: AppLocale, key: string, params?: MessageParams): string {
  const template = catalogFor(locale)[key] ?? MESSAGES[DEFAULT_LOCALE][key]
  if (template === undefined) return key
  return formatMessage(template, params)
}

/** Whether a key exists in any shipped catalog. */
export function hasMessage(key: string): boolean {
  return key in MESSAGES[DEFAULT_LOCALE]
}

/**
 * Translate with an explicit default for a missing key.
 *
 * `translate()` returns the key itself when nothing matches, which is right for
 * a label that must be diagnosable on screen. But some entries are legitimately
 * absent — a reason code with no actionable fix has no `.fix` string — and there
 * the caller wants '' rather than a stray `audio.reason.x.fix` in the UI. Pass
 * `defaultValue` for those.
 */
export function t(
  locale: AppLocale,
  key: string,
  params?: MessageParams,
  defaultValue?: string
): string {
  const template = catalogFor(locale)[key] ?? MESSAGES[DEFAULT_LOCALE][key]
  if (template === undefined) return defaultValue ?? key
  return formatMessage(template, params)
}

/** Bind a locale once, for call sites that translate repeatedly. */
export function createTranslator(
  locale: AppLocale
): (key: string, params?: MessageParams) => string {
  return (key, params) => translate(locale, key, params)
}

export type Translator = ReturnType<typeof createTranslator>

/**
 * Main/Node loads all locale catalogs synchronously, so every catalog is ready
 * on first access. These helpers match `translateRenderer.ts` so callers and
 * `useLocale.ts` typecheck identically across Node and browser builds.
 */
export function isLocaleCatalogLoaded(_locale: AppLocale): boolean {
  return true
}

export function ensureLocaleCatalog(locale: AppLocale): Promise<MessageCatalog> {
  return Promise.resolve(MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE])
}

export function subscribeLocaleCatalog(_listener: () => void): () => void {
  return () => {}
}
