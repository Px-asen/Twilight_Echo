import type { TrackData as Track } from './track.ts'

export type MetadataMatchConfidence = 'high' | 'medium'

export interface MetadataMatch {
  track: Track
  confidence: MetadataMatchConfidence
  score: number
}

export interface MetadataMatchCandidate extends MetadataMatch {
  providerId: string
  sourceLabel: string
  fills: {
    cover: boolean
    lyrics: boolean
    translatedLyrics: boolean
    metadata: boolean
  }
}

export interface MetadataEnrichmentPolicy {
  cover: boolean
  lyrics: boolean
  metadata: boolean
}

interface IndexedMetadataMatch extends MetadataMatch {
  index: number
}

const EXACT_DURATION_TOLERANCE_SECONDS = 8
const LOOSE_DURATION_TOLERANCE_SECONDS = 20
const METADATA_PLACEHOLDERS = new Set([
  'unknown',
  'unknown artist',
  'unknown album',
  '未知',
  '未知艺术家',
  '未知歌手',
  '未知专辑'
])

export function isMetadataPlaceholder(value: string | null | undefined): boolean {
  const text = normalizeMetadataText(value ?? '')
  return !text || METADATA_PLACEHOLDERS.has(text)
}

export function buildMetadataSearchQueries(track: Track): string[] {
  const title = track.title.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!title) return []
  const artists = metadataArtistNames(track.artist)
  const queries = [
    [title, ...artists].join(' '),
    [title, artists[0]].filter(Boolean).join(' '),
    title
  ]
  const seen = new Set<string>()
  return queries.filter((query) => {
    const key = normalizeMetadataText(query)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function findBestMetadataMatch(
  localTrack: Track,
  candidates: Track[]
): MetadataMatch | null {
  const matches = candidates
    .map((candidate, index) => {
      const match = scoreMetadataMatch(localTrack, candidate)
      return match ? { ...match, index } : null
    })
    .filter((match): match is IndexedMetadataMatch => match !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)

  return matches[0] ?? null
}

export function buildMetadataMatchCandidates(
  localTrack: Track,
  candidates: Track[]
): MetadataMatchCandidate[] {
  return candidates
    .map((candidate, index) => {
      if (getProviderId(candidate) === 'local') return null
      const match = scoreMetadataMatch(localTrack, candidate)
      if (!match) return null
      const providerId = getProviderId(candidate)
      return {
        ...match,
        providerId,
        sourceLabel: providerId || 'unknown',
        fills: {
          cover:
            !hasUsableTrackCover(localTrack) &&
            (metadataAvailable(candidate.cover) || metadataAvailable(candidate.coverSource)),
          lyrics: !metadataAvailable(localTrack.lyrics) && metadataAvailable(candidate.lyrics),
          translatedLyrics:
            !metadataAvailable(localTrack.translatedLyrics) &&
            metadataAvailable(candidate.translatedLyrics),
          metadata:
            (isMetadataPlaceholder(localTrack.artist) &&
              !isMetadataPlaceholder(candidate.artist)) ||
            (isMetadataPlaceholder(localTrack.album) && !isMetadataPlaceholder(candidate.album))
        },
        index
      }
    })
    .filter((match): match is MetadataMatchCandidate & { index: number } => match !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, ...match }) => match)
}

export function hasUsableTrackCover(
  track: Pick<Track, 'cover' | 'coverSource'>
): boolean {
  if (metadataAvailable(track.coverSource)) return true
  if (typeof track.cover !== 'string' || !metadataAvailable(track.cover)) return false
  // Session-scoped remote media handles expire on restart unless backed by a durable coverSource.
  return !track.cover.trim().startsWith('twilight-media://')
}

export function enrichLocalTrackMetadata(
  localTrack: Track,
  match: MetadataMatch | null,
  policy: MetadataEnrichmentPolicy = DEFAULT_METADATA_ENRICHMENT_POLICY
): Track {
  if (!match) return localTrack
  const metadata = match.track
  const shouldFillCover =
    policy.cover &&
    !hasUsableTrackCover(localTrack) &&
    (metadataAvailable(metadata.cover) || metadataAvailable(metadata.coverSource))
  const nextLyrics = policy.lyrics
    ? (localTrack.lyrics ?? metadata.lyrics ?? null)
    : localTrack.lyrics
  const nextTranslatedLyrics = policy.lyrics
    ? (localTrack.translatedLyrics ?? metadata.translatedLyrics ?? null)
    : localTrack.translatedLyrics
  const enriched: Track = {
    ...localTrack,
    artist:
      policy.metadata &&
      isMetadataPlaceholder(localTrack.artist) &&
      !isMetadataPlaceholder(metadata.artist)
        ? metadata.artist
        : localTrack.artist,
    album:
      policy.metadata &&
      isMetadataPlaceholder(localTrack.album) &&
      !isMetadataPlaceholder(metadata.album)
        ? metadata.album
        : localTrack.album,
    genre: policy.metadata ? localTrack.genre || metadata.genre || null : localTrack.genre,
    cover: shouldFillCover
      ? (metadata.cover ?? metadata.coverSource ?? null)
      : localTrack.cover,
    ...(shouldFillCover && metadataAvailable(metadata.coverSource)
      ? { coverSource: metadata.coverSource }
      : {}),
    lyrics: nextLyrics,
    translatedLyrics: nextTranslatedLyrics,
    lyricsSource: resolveEnrichedLyricSource(
      localTrack.lyrics,
      localTrack.lyricsSource,
      metadata.lyrics,
      nextLyrics,
      policy.lyrics
    ),
    translatedLyricsSource: resolveEnrichedLyricSource(
      localTrack.translatedLyrics,
      localTrack.translatedLyricsSource,
      metadata.translatedLyrics,
      nextTranslatedLyrics,
      policy.lyrics
    ),
    metadataMatch: {
      providerId: getProviderId(metadata),
      trackId: metadata.id,
      confidence: match.confidence,
      score: match.score
    }
  }
  delete enriched.streamUrl
  return enriched
}

const DEFAULT_METADATA_ENRICHMENT_POLICY: MetadataEnrichmentPolicy = {
  cover: true,
  lyrics: true,
  metadata: true
}

function resolveEnrichedLyricSource(
  localValue: string | null | undefined,
  localSource: Track['lyricsSource'],
  providerValue: string | null | undefined,
  nextValue: string | null | undefined,
  enabled: boolean
): Track['lyricsSource'] {
  if (!enabled) return localSource
  if (localValue != null && localValue !== '') return localSource
  if (providerValue != null && providerValue !== '' && nextValue === providerValue)
    return 'provider'
  return localSource ?? null
}

function getProviderId(track: Track): string {
  if (track.source && track.source !== 'local') return track.source
  const separatorIndex = track.id.indexOf(':')
  return separatorIndex > 0 ? track.id.slice(0, separatorIndex) : (track.source ?? '')
}

function scoreMetadataMatch(localTrack: Track, candidate: Track): MetadataMatch | null {
  const localTitle = normalizeMetadataText(localTrack.title)
  const candidateTitle = normalizeMetadataText(candidate.title)
  if (!localTitle || !candidateTitle) return null
  const exactTitle = localTitle === candidateTitle
  // Ignore punctuation variants, but retain every word, including version labels.
  const punctuationTitle = normalizeTitlePunctuation(localTitle)
  if (
    !exactTitle &&
    (!punctuationTitle || punctuationTitle !== normalizeTitlePunctuation(candidateTitle))
  )
    return null
  const localArtists = new Set(metadataArtistNames(localTrack.artist).map(normalizeMetadataText))
  const candidateArtists = new Set(metadataArtistNames(candidate.artist).map(normalizeMetadataText))
  if (candidateArtists.size === 0) return null
  const localSubset = [...localArtists].every((artist) => candidateArtists.has(artist))
  const candidateSubset = [...candidateArtists].every((artist) => localArtists.has(artist))
  if (!localSubset && !candidateSubset) return null
  const exactArtists = localSubset && candidateSubset

  const durationDelta = durationDeltaSeconds(localTrack, candidate)
  if (durationDelta != null && durationDelta > LOOSE_DURATION_TOLERANCE_SECONDS) return null
  // Missing/partial credits require timing evidence; a shared guest is insufficient.
  if (!exactArtists && (durationDelta == null || durationDelta > EXACT_DURATION_TOLERANCE_SECONDS))
    return null

  let score = 70
  if (!exactTitle) score -= 4
  if (!exactArtists) score -= 12
  if (durationDelta == null) {
    score += 5
  } else if (durationDelta <= EXACT_DURATION_TOLERANCE_SECONDS) {
    score += 20
  } else {
    score += 8
  }
  if (metadataAvailable(candidate.cover)) score += 3
  if (metadataAvailable(candidate.lyrics)) score += 2
  if (metadataAvailable(candidate.translatedLyrics)) score += 1

  return {
    track: candidate,
    confidence: exactArtists && score >= 90 ? 'high' : 'medium',
    score
  }
}

function durationDeltaSeconds(left: Track, right: Track): number | null {
  if (
    !Number.isFinite(left.duration) ||
    left.duration <= 0 ||
    !Number.isFinite(right.duration) ||
    right.duration <= 0
  )
    return null
  return Math.abs(left.duration - right.duration)
}

function metadataArtistNames(value: string | undefined): string[] {
  if (isMetadataPlaceholder(value)) return []
  return (value ?? '')
    .normalize('NFKC')
    .split(/[/,&、;]+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)
    .map((artist) => artist.trim().replace(/\s+/g, ' '))
    .filter((artist) => !isMetadataPlaceholder(artist))
}

function normalizeTitlePunctuation(value: string): string {
  return value.replace(/\p{P}/gu, '').replace(/\s+/g, ' ').trim()
}

function metadataAvailable(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeMetadataText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}
