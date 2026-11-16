import type { AudioOutputFallbackNotice } from '../../../shared/coreAudio.ts'
import { isAppError, parseAppError } from '../../../shared/errors/appError.ts'
import { presentError } from '../../../shared/errors/presentError.ts'
import type { AppLocale } from '../../../shared/i18n/locale.ts'
import { translate } from '../../../shared/i18n/translate.ts'
import { currentLocale } from '../app/useLocale.ts'

/**
 * Localize an audio command/engine error when it carries a `[TE-ERR:...]`
 * sentinel while preserving non-coded driver/runtime diagnostic messages.
 */
export function formatAudioError(error: unknown, locale: AppLocale = currentLocale()): string {
  if (isAppError(error)) {
    return presentError(locale, error)
  }
  const parsed = parseAppError(error)
  if (parsed.message) {
    return parsed.message
  }
  return presentError(locale, error)
}

export function formatAudioOutputFallbackNotice(
  notice: AudioOutputFallbackNotice,
  locale: AppLocale = currentLocale()
): string {
  const reason = formatAudioError(notice.reason, locale)
  if (notice.fromOutput === 'asio' && notice.toOutput === 'wasapi') {
    return translate(locale, 'audio.outputFallback.asioToWasapi', { reason })
  }
  return translate(locale, 'audio.outputFallback.generic', {
    reason,
    target: notice.toOutput.toUpperCase()
  })
}
