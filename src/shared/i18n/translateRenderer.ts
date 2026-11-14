/**
 * Renderer-only message formatter with on-demand catalog loading.
 *
 * The renderer starts with `zh-CN` statically bundled and dynamically imports
 * secondary locale catalogs (`en-US`) when selected or requested, so startup
 * chunks do not pay for unused translation dictionaries. While an async catalog
 * is still loading, lookups fall back to `zh-CN` so no label renders blank.
 */
import { DEFAULT_LOCALE, type AppLocale } from './locale.ts'
import { ZH_CN_MESSAGES } from './messages/zh-CN.ts'

export type MessageParams = Record<string, string | number | boolean | null | undefined>

/** A catalog is flat: dotted keys, no nesting, so lookup is one property read. */
export type MessageCatalog = Readonly<Record<string, string>>

const PLACEHOLDER = /\{(\w+)\}/g
const cjkRange = (start: number, end: number): string =>
  `${String.fromCharCode(start)}-${String.fromCharCode(end)}`
const CJK_CLASS = `[${cjkRange(0x3000, 0x303f)}${cjkRange(0x3400, 0x4dbf)}${cjkRange(0x4e00, 0x9fff)}${cjkRange(0xf900, 0xfaff)}]`
const CJK_SPACE_CJK = new RegExp(`(${CJK_CLASS}) +(?=${CJK_CLASS})`, 'g')

const loadedCatalogs: Partial<Record<AppLocale, MessageCatalog>> = {
  [DEFAULT_LOCALE]: ZH_CN_MESSAGES
}
const inFlightCatalogs = new Map<AppLocale, Promise<MessageCatalog>>()
const listeners = new Set<() => void>()

export function isLocaleCatalogLoaded(locale: AppLocale): boolean {
  return loadedCatalogs[locale] !== undefined
}

export function ensureLocaleCatalog(locale: AppLocale): Promise<MessageCatalog> {
  const loaded = loadedCatalogs[locale]
  if (loaded) return Promise.resolve(loaded)

  const existing = inFlightCatalogs.get(locale)
  if (existing) return existing

  const loader =
    locale === 'en-US'
      ? import('./messages/en-US.ts').then((mod) => mod.EN_US_MESSAGES)
      : Promise.resolve(ZH_CN_MESSAGES)

  const pending = loader.then(
    (catalog) => {
      inFlightCatalogs.delete(locale)
      loadedCatalogs[locale] = catalog
      for (const listener of [...listeners]) {
        listener()
      }
      return catalog
    },
    (error) => {
      inFlightCatalogs.delete(locale)
      throw error
    }
  )

  inFlightCatalogs.set(locale, pending)
  return pending
}

export function subscribeLocaleCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template
  const substituted = template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name]
    if (value === undefined || value === null) return match
    return String(value)
  })
  return substituted === template ? substituted : substituted.replace(CJK_SPACE_CJK, '$1')
}

export function catalogFor(locale: AppLocale): MessageCatalog {
  return loadedCatalogs[locale] ?? ZH_CN_MESSAGES
}

function lookupTemplate(locale: AppLocale, key: string): string | undefined {
  const catalog = loadedCatalogs[locale]
  if (!catalog && locale !== DEFAULT_LOCALE) {
    void ensureLocaleCatalog(locale).catch(() => {})
  }
  return catalog?.[key] ?? ZH_CN_MESSAGES[key]
}

export function translate(locale: AppLocale, key: string, params?: MessageParams): string {
  const template = lookupTemplate(locale, key)
  if (template === undefined) return key
  return formatMessage(template, params)
}

export function hasMessage(key: string): boolean {
  return key in ZH_CN_MESSAGES
}

export function t(
  locale: AppLocale,
  key: string,
  params?: MessageParams,
  defaultValue?: string
): string {
  const template = lookupTemplate(locale, key)
  if (template === undefined) return defaultValue ?? key
  return formatMessage(template, params)
}

export function createTranslator(
  locale: AppLocale
): (key: string, params?: MessageParams) => string {
  return (key, params) => translate(locale, key, params)
}

export type Translator = ReturnType<typeof createTranslator>
