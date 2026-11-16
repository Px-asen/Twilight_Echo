/**
 * The renderer's single source of truth for "what language am I rendering in".
 *
 * Module-level state, matching the other stores here: every component reads the
 * same ref, so switching the setting re-renders the whole UI without a restart.
 *
 * The OS locale comes from `navigator.language` rather than an IPC round-trip —
 * Chromium already knows it, and the value is needed during the first render.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  DEFAULT_LOCALE,
  matchSystemLocale,
  normalizeLanguagePreference,
  resolveLocale,
  type AppLocale,
  type LanguagePreference
} from '../../../shared/i18n/locale.ts'
import {
  ensureLocaleCatalog,
  isLocaleCatalogLoaded,
  subscribeLocaleCatalog,
  translate,
  type MessageParams
} from '../../../shared/i18n/translate.ts'
import {
  presentError,
  presentErrorDetail,
  type PresentedError
} from '../../../shared/errors/presentError.ts'

const catalogRevision = ref(0)
subscribeLocaleCatalog(() => {
  catalogRevision.value += 1
})

function ensureActiveCatalog(target: AppLocale): void {
  if (!isLocaleCatalogLoaded(target)) {
    void ensureLocaleCatalog(target).catch(() => {})
  }
}

function readSystemLocale(): AppLocale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE
  // `languages[0]` is the user's true first preference; `language` can lag it.
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language
  ]
  for (const candidate of candidates) {
    const matched = matchSystemLocale(candidate)
    if (matched) return matched
  }
  return DEFAULT_LOCALE
}

const systemLocale = ref<AppLocale>(readSystemLocale())
const preference = ref<LanguagePreference>('system')

const resolvedLocale = computed<AppLocale>(() =>
  resolveLocale(preference.value, systemLocale.value)
)

/**
 * The locale every display surface should render in.
 *
 * Touching `catalogRevision` when reading `locale.value` ensures Vue templates
 * and computed properties (such as `resolveReasonCode(locale.value, code)`)
 * re-evaluate once a lazily loaded locale catalog arrives.
 */
const locale: ComputedRef<AppLocale> = Object.create(resolvedLocale, {
  value: {
    enumerable: true,
    get() {
      void catalogRevision.value
      return resolvedLocale.value
    }
  }
}) as ComputedRef<AppLocale>

watch(
  resolvedLocale,
  (target) => {
    ensureActiveCatalog(target)
  },
  { immediate: true, flush: 'sync' }
)

/**
 * Push the persisted setting in. Called once the settings snapshot lands and on
 * every subsequent change, so `locale` tracks the user's choice.
 */
export function setLanguagePreference(value: unknown): void {
  preference.value = normalizeLanguagePreference(value)
  ensureActiveCatalog(resolvedLocale.value)
}

export function useLocale(): {
  locale: ComputedRef<AppLocale>
  preference: Ref<LanguagePreference>
  systemLocale: Ref<AppLocale>
  /** Translate a key in the active locale. */
  t: (key: string, params?: MessageParams) => string
  /** Localize a caught error for display. */
  errorText: (error: unknown, fallbackKey?: string) => string
  /** Localize for display while keeping the developer prose for logs. */
  errorDetail: (error: unknown, fallbackKey?: string) => PresentedError
} {
  return {
    locale,
    preference,
    systemLocale,
    t: (key, params) => {
      void catalogRevision.value
      return translate(locale.value, key, params)
    },
    errorText: (error, fallbackKey) => {
      void catalogRevision.value
      return presentError(locale.value, error, fallbackKey)
    },
    errorDetail: (error, fallbackKey) => {
      void catalogRevision.value
      return presentErrorDetail(locale.value, error, fallbackKey)
    }
  }
}

/** Non-reactive read, for module-level code that cannot hold a composable. */
export function currentLocale(): AppLocale {
  return locale.value
}

/**
 * Keep the active locale in step with the persisted setting, and reflect it onto
 * `<html lang>` so the browser picks the right font fallbacks and hyphenation.
 *
 * Mirrors `useMotionPreference`: App.vue passes a computed off the settings
 * store, so every path that writes settings updates the locale without each of
 * them having to know about i18n.
 */
export function useLanguagePreference(
  source: Ref<LanguagePreference> | ComputedRef<unknown>
): void {
  watch(
    source,
    (value) => {
      setLanguagePreference(value)
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('lang', locale.value)
      }
    },
    { immediate: true }
  )
}
