import type { LyricSourcePreference } from '../../../shared/lyricsManagement.ts'

export interface ResolverLyricsState {
  lyrics: string | null
  translatedLyrics?: string | null
  romanizedLyrics?: string | null
  lyricsSource?: string | null
  translatedLyricsSource?: string | null
  romanizedLyricsSource?: string | null
}

/**
 * Forced sources never become the Auto baseline. Auto receives the cached
 * resolver result from before a forced Local/Provider selection.
 */
export function resolverLyricsInput<T extends ResolverLyricsState>(
  current: T,
  automaticBaseline: T | undefined,
  source: Exclude<LyricSourcePreference, 'manual'>
): T {
  const baseline = automaticBaseline ?? current
  if (source === 'auto') return baseline
  return {
    ...baseline,
    lyrics: null,
    translatedLyrics: null,
    romanizedLyrics: null,
    lyricsSource: null,
    translatedLyricsSource: null,
    romanizedLyricsSource: null
  }
}
