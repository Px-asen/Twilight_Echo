/**
 * Display boundary: turn anything caught in a `catch` into copy the user's
 * locale can read.
 *
 * Three tiers, in order:
 *   1. A `[TE-ERR:code:params]` sentinel — the error was raised by our own code
 *      as an `AppError`, so we translate its code into the active locale.
 *   2. A heuristic on raw English from Node/Electron/fetch (`ENOTFOUND`,
 *      `net::ERR_*`, HTTP status words) — no code to translate, but the failure
 *      class is recognizable.
 *   3. The caller's fallback copy.
 *
 * Chinese text with no sentinel is a legacy pre-rendered message from a call
 * site not yet migrated. It passes through unchanged: it is already readable in
 * the default locale, and inventing a translation for prose we cannot key would
 * be worse than showing it.
 */
import type { AppLocale } from '../i18n/locale.ts'
import { hasMessage, translate, type MessageParams } from '../i18n/translate.ts'
import { parseAppError, stripAppErrorSentinel, unwrapRemoteInvokeMessage } from './appError.ts'

/** Recognizable failure classes in raw platform English. */
const NETWORK_PATTERN =
  /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|timed? ?out/i
const UNAUTHORIZED_PATTERN = /\b(?:401|403)\b|unauthoriz|forbidden|need login|not login/i
const RATE_LIMIT_PATTERN =
  /\b429\b|too many requests|rate.?limit|NCM_METADATA_RATE_LIMITED|RPC circuit is (?:open|half-open)|RPC queue is full/i
const HAS_CJK = /[一-鿿]/

export interface PresentErrorOptions {
  /**
   * When set, a recognized network/auth failure renders as
   * `<fallback>：<reason>` — matching how the streaming pages already phrase
   * "loading the playlist failed: check your connection".
   */
  prefixFallback?: boolean
}

export interface PresentedError {
  /** Localized copy safe to show the user. Never empty, never carries a sentinel. */
  display: string
  /** The structured code, when the error carried one. */
  code: string | null
  /** Developer prose (English) for logs and bug reports. */
  developerMessage: string
  params: MessageParams
}

/** Extract a message string from an unknown thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * Localize a caught error for display.
 *
 * Never returns an empty string: an empty result would render as blank chrome
 * with no indication that anything failed.
 */
export function presentError(
  locale: AppLocale,
  error: unknown,
  fallbackKey = 'error.generic.unknown',
  options: PresentErrorOptions = {}
): string {
  return presentErrorDetail(locale, error, fallbackKey, options).display
}

/**
 * Same resolution as {@link presentError}, but also returns the structured
 * fields. Call sites that both show a message and log one use this so the user
 * gets localized copy while the console keeps the original developer prose.
 */
export function presentErrorDetail(
  locale: AppLocale,
  error: unknown,
  fallbackKey = 'error.generic.unknown',
  options: PresentErrorOptions = {}
): PresentedError {
  const fallback = translate(locale, fallbackKey)
  const parsed = parseAppError(error)
  const developerMessage = parsed.message

  if (parsed.code !== null) {
    const key = `error.${parsed.code}`
    // An unknown code must not render as the bare key: that would leak
    // `error.audio.somethingNew` into the UI when the engine ships a code the
    // catalog has not caught up with. Fall through to the fallback instead.
    if (hasMessage(key)) {
      return {
        display: translate(locale, key, parsed.params),
        code: parsed.code,
        developerMessage,
        params: parsed.params
      }
    }
    console.warn('[error] no catalog entry for code:', parsed.code)
  }

  const raw = unwrapRemoteInvokeMessage(messageOf(error).trim())
  const message = stripAppErrorSentinel(raw).trim()
  const base = { code: parsed.code, developerMessage, params: parsed.params }
  if (!message) return { ...base, display: fallback }

  const classified = classifyPlatformError(message, locale)
  if (classified) {
    // The separator comes from the catalog: a fullwidth colon is correct in
    // Chinese and reads as a typo in English.
    const display =
      options.prefixFallback === true && fallbackKey !== 'error.generic.unknown'
        ? `${fallback}${translate(locale, 'punct.labelSeparator')}${classified}`
        : classified
    return { ...base, display }
  }

  // Copy our own code already localized (pre-migration call sites). Showing it
  // beats replacing readable prose with a generic fallback.
  if (HAS_CJK.test(message)) return { ...base, display: message }

  // Unrecognized English from a dependency: keep it out of the UI but preserve
  // it for the console, so a bug report still has the original text.
  console.warn('[error] unclassified failure:', message)
  return { ...base, display: fallback }
}

/** Map raw platform English onto a translated failure class, or null. */
function classifyPlatformError(message: string, locale: AppLocale): string | null {
  if (NETWORK_PATTERN.test(message)) return translate(locale, 'error.network.failed')
  if (UNAUTHORIZED_PATTERN.test(message)) return translate(locale, 'error.network.unauthorized')
  if (RATE_LIMIT_PATTERN.test(message)) return translate(locale, 'error.network.rate_limited')
  if (
    /Audio decoder (?:receive|send|flush) failed|Audio frame conversion failed|Audio source read failed/i.test(
      message
    )
  )
    return translate(locale, 'error.audio.decode_failed')
  return null
}
