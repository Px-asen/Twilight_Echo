import type { LyricSource, Track } from '../types/music'
import type { MediaProviderLyrics } from '../providers/mediaProvider'
import { getNcmSongId } from '../providers/ncmTrack.ts'

export type LyricResolverSource = 'automatic' | 'local' | 'amll' | 'provider'

type AutomaticOriginalCandidate = 'local' | 'amll' | 'provider'

const AUTOMATIC_ORIGINAL_PRIORITY: Record<LyricSource, number> = {
  manual: 5,
  embedded: 4,
  local: 4,
  amll: 3,
  provider: 2,
  online: 1
}

export interface ResolvedLyricsWithSources {
  lyrics: string | null
  translatedLyrics: string | null
  romanizedLyrics: string | null
  lyricsSource: LyricSource | null
  translatedLyricsSource: LyricSource | null
  romanizedLyricsSource: LyricSource | null
  /**
   * A source was requested but could not be reached. This is deliberately
   * distinct from a successful request that found no lyrics, so callers can
   * keep the track eligible for retry instead of permanently caching emptiness.
   */
  failure?: 'local' | 'amll' | 'provider' | 'online'
}

export interface ResolveLyricsWithSourcesOptions {
  track: Track
  loadLocalLyrics?: () => Promise<string | null>
  loadLocalTranslatedLyrics?: () => Promise<string | null>
  loadLocalRomanizedLyrics?: () => Promise<string | null>
  loadProviderLyrics?: () => Promise<MediaProviderLyrics>
  loadAmlTtml?: () => Promise<string | null>
  originalSource?: LyricResolverSource
  translationSource?: LyricResolverSource
  romanizationSource?: LyricResolverSource
  /** Final fallback when embedded/local/provider all miss. */
  loadOnlineLyrics?: () => Promise<string | null>
  /**
   * Companion translation lookup for the online fallback (e.g. NetEase
   * tlyric). Called only when online lyrics were applied and no translation
   * is available yet; a miss keeps the translation layer hidden.
   */
  loadOnlineTranslation?: () => Promise<string | null>
}

function defaultExistingLyricSource(track: Track): LyricSource {
  return track.source === 'ncm' || track.id.startsWith('ncm:') ? 'provider' : 'embedded'
}

function automaticCandidateCanReplace(
  currentSource: LyricSource | null,
  candidate: AutomaticOriginalCandidate
): boolean {
  return (
    currentSource == null ||
    AUTOMATIC_ORIGINAL_PRIORITY[candidate] > AUTOMATIC_ORIGINAL_PRIORITY[currentSource]
  )
}

export function shouldLoadAutomaticOriginal(
  track: Track,
  candidate: AutomaticOriginalCandidate
): boolean {
  const lyrics = normalizeLyricValue(track.lyrics)
  const source = lyrics ? (track.lyricsSource ?? defaultExistingLyricSource(track)) : null
  return automaticCandidateCanReplace(source, candidate)
}

export async function resolveLyricsWithSources(
  options: ResolveLyricsWithSourcesOptions
): Promise<ResolvedLyricsWithSources> {
  const track = options.track
  const originalSource = options.originalSource ?? 'automatic'
  const translationSource = options.translationSource ?? 'automatic'
  let lyrics = normalizeLyricValue(track.lyrics)
  let translatedLyrics = normalizeLyricValue(track.translatedLyrics)
  let romanizedLyrics = normalizeLyricValue(track.romanizedLyrics)
  let lyricsSource = lyrics ? (track.lyricsSource ?? defaultExistingLyricSource(track)) : null
  let translatedLyricsSource = translatedLyrics
    ? (track.translatedLyricsSource ?? defaultExistingLyricSource(track))
    : null
  let romanizedLyricsSource = romanizedLyrics
    ? (track.romanizedLyricsSource ?? defaultExistingLyricSource(track))
    : null

  const shouldLoadLocal =
    originalSource === 'local' ||
    (originalSource === 'automatic' && automaticCandidateCanReplace(lyricsSource, 'local'))
  const localResult =
    shouldLoadLocal && options.loadLocalLyrics
      ? await loadOptionalLyrics(options.loadLocalLyrics)
      : { value: null, failed: false }
  const localLyrics = normalizeLyricValue(localResult.value)

  if (originalSource === 'local') {
    lyrics = localLyrics
    lyricsSource = localLyrics ? 'local' : null
  } else if (
    originalSource === 'automatic' &&
    localLyrics &&
    automaticCandidateCanReplace(lyricsSource, 'local')
  ) {
    lyrics = localLyrics
    lyricsSource = 'local'
  }

  // Load local translated lyrics (_trans.lrc)
  const shouldLoadLocalTranslation =
    translationSource === 'local' ||
    (translationSource === 'automatic' && !translatedLyrics)
  const localTranslationResult =
    shouldLoadLocalTranslation && options.loadLocalTranslatedLyrics
      ? await loadOptionalLyrics(options.loadLocalTranslatedLyrics)
      : { value: null, failed: false }
  const localTranslation = normalizeLyricValue(localTranslationResult.value)
  if (localTranslation && (!translatedLyrics || translationSource === 'local')) {
    translatedLyrics = localTranslation
    translatedLyricsSource = 'local'
  }

  // Load local romanized lyrics (_roma.lrc)
  const romanizationSource = options.romanizationSource ?? 'automatic'
  const shouldLoadLocalRomanization =
    romanizationSource === 'local' ||
    (romanizationSource === 'automatic' && !track.romanizedLyrics)
  const localRomanizationResult =
    shouldLoadLocalRomanization && options.loadLocalRomanizedLyrics
      ? await loadOptionalLyrics(options.loadLocalRomanizedLyrics)
      : { value: null, failed: false }
  const localRomanization = normalizeLyricValue(localRomanizationResult.value)
  if (localRomanization && (!romanizedLyrics || romanizationSource === 'local')) {
    romanizedLyrics = localRomanization
    romanizedLyricsSource = 'local'
  }

  const shouldLoadAml =
    eligibleForAml(track) &&
    options.loadAmlTtml &&
    (originalSource === 'amll' ||
      translationSource === 'amll' ||
      (originalSource === 'automatic' && automaticCandidateCanReplace(lyricsSource, 'amll')))
  const amlResult = shouldLoadAml
    ? await loadOptionalLyrics(options.loadAmlTtml!)
    : { value: null, failed: false }
  const amlLyrics = normalizeLyricValue(amlResult.value)
  const applyAmlLyrics = (): void => {
    lyrics = amlLyrics
    lyricsSource = 'amll'
    if (
      translationSource === 'amll' ||
      (translationSource === 'automatic' &&
        (translatedLyricsSource === 'provider' || translatedLyricsSource === 'online'))
    ) {
      translatedLyrics = null
      translatedLyricsSource = null
    }
  }
  if ((originalSource === 'amll' || translationSource === 'amll') && amlLyrics) {
    applyAmlLyrics()
  } else if (originalSource === 'amll') {
    lyrics = null
    lyricsSource = null
  } else if (
    originalSource === 'automatic' &&
    amlLyrics &&
    automaticCandidateCanReplace(lyricsSource, 'amll')
  ) {
    applyAmlLyrics()
  }

  const shouldLoadProvider =
    originalSource === 'provider' ||
    translationSource === 'provider' ||
    (originalSource === 'automatic' && automaticCandidateCanReplace(lyricsSource, 'provider')) ||
    (translationSource === 'automatic' && !translatedLyrics && lyricsSource !== 'amll')
  const providerResult =
    shouldLoadProvider && options.loadProviderLyrics
      ? await loadOptionalProviderLyrics(options.loadProviderLyrics)
      : { value: null, failed: false }
  const providerLyrics = providerResult.value
  const providerOriginal = normalizeLyricValue(providerLyrics?.lyrics)
  const providerWordLyrics = normalizeLyricValue(providerLyrics?.wordLyrics)
  const providerTranslation = normalizeLyricValue(providerLyrics?.translatedLyrics)

  if (originalSource === 'provider') {
    lyrics = providerWordLyrics ?? providerOriginal
    lyricsSource = lyrics ? 'provider' : null
  }

  if (
    originalSource === 'automatic' &&
    providerLyrics &&
    automaticCandidateCanReplace(lyricsSource, 'provider')
  ) {
    const providerBest = providerWordLyrics ?? providerOriginal
    if (providerBest) {
      lyrics = providerBest
      lyricsSource = 'provider'
    }
  }

  if (translationSource === 'provider') {
    translatedLyrics = providerTranslation
    translatedLyricsSource = providerTranslation ? 'provider' : null
  } else if (translationSource === 'local') {
    if (translatedLyricsSource !== 'local') {
      translatedLyrics = null
      translatedLyricsSource = null
    }
  } else if (!translatedLyrics && providerTranslation) {
    translatedLyrics = providerTranslation
    translatedLyricsSource = 'provider'
  }

  if (!lyrics && options.loadOnlineLyrics) {
    const onlineResult = await loadOptionalLyrics(options.loadOnlineLyrics)
    const onlineLyrics = normalizeLyricValue(onlineResult.value)
    if (onlineLyrics) {
      lyrics = onlineLyrics
      lyricsSource = 'online'
      if (!translatedLyrics && options.loadOnlineTranslation) {
        const onlineTranslationResult = await loadOptionalLyrics(options.loadOnlineTranslation)
        const onlineTranslation = normalizeLyricValue(onlineTranslationResult.value)
        if (onlineTranslation) {
          translatedLyrics = onlineTranslation
          translatedLyricsSource = 'online'
        }
      }
    }

    if (!lyrics && onlineResult.failed) {
      return {
        lyrics,
        translatedLyrics,
        romanizedLyrics: null,
        lyricsSource,
        translatedLyricsSource,
        romanizedLyricsSource: null,
        failure: 'online'
      }
    }
  }

  const resolved = {
    lyrics,
    translatedLyrics,
    romanizedLyrics,
    lyricsSource,
    translatedLyricsSource,
    romanizedLyricsSource
  }
  if (lyrics || translatedLyrics) return resolved
  if (amlResult.failed) return { ...resolved, failure: 'amll' as const }
  if (providerResult.failed) return { ...resolved, failure: 'provider' as const }
  if (localResult.failed) return { ...resolved, failure: 'local' as const }
  return resolved
}

export function eligibleForAml(track: Track): boolean {
  const source = track.source ?? (track.id.startsWith('ncm:') ? 'ncm' : 'local')
  if (source === 'ncm') {
    const id = getNcmSongId(track)
    return id != null && Number.isSafeInteger(id) && id > 0
  }
  if (source !== 'local') return false
  const match = track.metadataMatch
  if (!match || match.providerId !== 'ncm' || match.confidence !== 'high') return false
  const id = Number(match.trackId)
  return Number.isSafeInteger(id) && id > 0
}

function normalizeLyricValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  return value.length > 0 ? value : null
}

interface OptionalLyricsLoad<T> {
  value: T | null
  failed: boolean
}

async function loadOptionalLyrics(
  loader: () => Promise<string | null>
): Promise<OptionalLyricsLoad<string>> {
  try {
    return { value: await loader(), failed: false }
  } catch {
    return { value: null, failed: true }
  }
}

async function loadOptionalProviderLyrics(
  loader: () => Promise<MediaProviderLyrics>
): Promise<OptionalLyricsLoad<MediaProviderLyrics>> {
  try {
    return { value: await loader(), failed: false }
  } catch {
    return { value: null, failed: true }
  }
}