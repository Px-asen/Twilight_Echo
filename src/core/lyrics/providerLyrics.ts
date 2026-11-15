import type { TrackData as Track } from '../../shared/track.ts'
import type { LyricProvider, MediaProviderLyrics } from '../../shared/providerLyrics.ts'
interface ProviderLyricsSearchResult {
  lyrics: MediaProviderLyrics | null
  failure: unknown | null
}
export async function resolveLyricsAcrossProviders(
  providers: LyricProvider[],
  track: Track,
  now: () => number,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<MediaProviderLyrics> {
  const timeoutMs = options?.timeoutMs ?? 8_000
  const empty: MediaProviderLyrics = { lyrics: null, translatedLyrics: null, wordLyrics: null }
  const deadline = now() + timeoutMs
  const remainingTimeout = (): number => Math.max(0, deadline - now())

  const direct = providers.find((provider) => provider.id === getTrackProviderId(track))
  let directFailure: unknown = null
  if (direct?.getLyrics) {
    try {
      await assertProviderEnabled(direct)
      const directTimeoutMs = Math.min(5_000, remainingTimeout())
      if (directTimeoutMs <= 0) return empty
      const lyrics = await withTimeout(
        direct.getLyrics(track, { signal: options?.signal }),
        directTimeoutMs,
        options?.signal
      )
      if (hasAnyLyrics(lyrics)) return lyrics
    } catch (error) {
      directFailure = error
      // continue fan-out
    }
  }

  // Local / unmatched tracks: try lyric-capable providers by title search.
  const query = [track.title, track.artist]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ')
  if (!query) return empty

  const candidates = providers
    .filter((provider) => provider.getLyrics && provider.searchSongs)
    .filter((provider) => provider.id !== direct?.id)
    .sort((a, b) => providerLyricPriority(a.id) - providerLyricPriority(b.id))

  const fallbackTimeoutMs = remainingTimeout()
  if (fallbackTimeoutMs <= 0 || options?.signal?.aborted) {
    if (directFailure) throw directFailure
    return empty
  }

  const fallback = await resolveFirstProviderLyrics(
    candidates.map((provider) =>
      resolveLyricsFromProviderSearch(provider, query, track, remainingTimeout, options?.signal)
    ),
    fallbackTimeoutMs,
    options?.signal
  )
  if (fallback.lyrics) return fallback.lyrics
  if (fallback.failure) throw fallback.failure
  if (directFailure) throw directFailure
  return empty
}
export function getTrackProviderId(track: Pick<Track, 'id' | 'source'>): string | null {
  if (track.source) return normalizeProviderId(track.source)
  if (/^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)) return null
  const separatorIndex = track.id.indexOf(':')
  if (separatorIndex <= 0) return null
  return normalizeProviderId(track.id.slice(0, separatorIndex))
}

function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase()
}
export async function assertProviderEnabled(provider: Pick<LyricProvider, 'name' | 'isEnabled'>): Promise<void> {
  if (!provider.isEnabled) return
  if (!(await provider.isEnabled())) {
    throw new Error(`${provider.name} provider is disabled or not logged in`)
  }
}

export async function isProviderAvailable(provider: Pick<LyricProvider, 'isEnabled'>): Promise<boolean> {
  if (!provider.isEnabled) return true
  try {
    return await provider.isEnabled()
  } catch {
    return false
  }
}

function providerLyricPriority(id: string): number {
  const normalized = normalizeProviderId(id)
  if (normalized === 'ncm') return 0
  if (normalized === 'bili') return 2
  return 1
}

function hasAnyLyrics(lyrics: MediaProviderLyrics | null | undefined): boolean {
  if (!lyrics) return false
  return Boolean(lyrics.lyrics || lyrics.translatedLyrics || lyrics.wordLyrics)
}

async function resolveLyricsFromProviderSearch(
  provider: LyricProvider,
  query: string,
  track: Track,
  remainingTimeout: () => number,
  signal?: AbortSignal
): Promise<ProviderLyricsSearchResult> {
  try {
    const availableTimeoutMs = remainingTimeout()
    if (availableTimeoutMs <= 0) return { lyrics: null, failure: null }
    if (!(await withTimeout(isProviderAvailable(provider), availableTimeoutMs, signal))) {
      return { lyrics: null, failure: null }
    }

    const searchTimeoutMs = remainingTimeout()
    if (searchTimeoutMs <= 0) return { lyrics: null, failure: null }
    const search = await withTimeout(
      provider.searchSongs!(query, 5, 0, { signal }),
      searchTimeoutMs,
      signal
    )
    const match = pickBestLyricSearchMatch(track, search.items)
    if (!match || !provider.getLyrics) return { lyrics: null, failure: null }

    const lyricsTimeoutMs = remainingTimeout()
    if (lyricsTimeoutMs <= 0) return { lyrics: null, failure: null }
    const lyrics = await withTimeout(provider.getLyrics(match, { signal }), lyricsTimeoutMs, signal)
    return { lyrics: hasAnyLyrics(lyrics) ? lyrics : null, failure: null }
  } catch (error) {
    return { lyrics: null, failure: error }
  }
}

async function resolveFirstProviderLyrics(
  requests: Array<Promise<ProviderLyricsSearchResult>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProviderLyricsSearchResult> {
  const empty: ProviderLyricsSearchResult = { lyrics: null, failure: null }
  if (requests.length === 0 || timeoutMs <= 0) return empty
  let firstFailure: unknown = null
  try {
    const result = await withTimeout(
      Promise.any(
        requests.map(async (request) => {
          const outcome = await request
          if (outcome.lyrics) return outcome
          if (outcome.failure && firstFailure == null) firstFailure = outcome.failure
          throw new Error('Provider did not return lyrics')
        })
      ),
      timeoutMs,
      signal
    )
    return result
  } catch (error) {
    if (signal?.aborted) return empty
    if (error instanceof AggregateError && firstFailure == null) return empty
    return { lyrics: null, failure: firstFailure ?? new Error('Lyrics provider timed out') }
  }
}

function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function pickBestLyricSearchMatch(local: Track, candidates: Track[]): Track | null {
  const localTitle = normalizeMatchText(local.title)
  const localArtist = normalizeMatchText(local.artist)
  if (!localTitle) return null
  const localCompactTitle = compactLyricMatchText(localTitle)
  const localArtistTokens = lyricArtistTokens(localArtist)
  let best: Track | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    const title = normalizeMatchText(candidate.title)
    const compactTitle = compactLyricMatchText(title)
    if (!title || !compactTitle) continue
    const titleScore =
      title === localTitle
        ? 24
        : compactTitle === localCompactTitle
          ? 20
          : lyricTitleScore(compactTitle, localCompactTitle)
    if (titleScore === 0) continue
    const artist = normalizeMatchText(candidate.artist)
    let artistScore = 0
    if (localArtist && artist) {
      if (artist === localArtist) artistScore = 10
      else if (lyricArtistTokens(artist).some((token) => localArtistTokens.includes(token)))
        artistScore = 8
      else if (artist.includes(localArtist) || localArtist.includes(artist)) artistScore = 4
    }
    let durationScore = 0
    if (
      typeof local.duration === 'number' &&
      local.duration > 0 &&
      typeof candidate.duration === 'number' &&
      candidate.duration > 0
    ) {
      const delta = Math.abs(local.duration - candidate.duration)
      if (delta <= 3) durationScore = 5
      else if (delta <= 8) durationScore = 2
      else if (delta > 30) continue
    }
    if (artistScore === 0 && durationScore === 0) continue
    const score = titleScore + artistScore + durationScore
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore >= 16 ? best : null
}

function compactLyricMatchText(value: string): string {
  return value
    .replace(/[（(][^）)]*(?:feat|ft|with)[^）)]*[）)]/giu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function lyricTitleScore(candidate: string, local: string): number {
  if (candidate.length < 4 || local.length < 4) return 0
  return candidate.includes(local) || local.includes(candidate) ? 14 : 0
}

function lyricArtistTokens(value: string): string[] {
  return value
    .split(/[\\/＆&、,，;；]/u)
    .map((part) => compactLyricMatchText(part))
    .filter((part) => part.length >= 2)
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw new Error('Aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectTimeout: ((reason?: unknown) => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject
    timer = setTimeout(() => reject(new Error('Lyrics provider timed out')), timeoutMs)
  })
  const onAbort = (): void => {
    if (timer) clearTimeout(timer)
    rejectTimeout?.(new Error('Aborted'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
