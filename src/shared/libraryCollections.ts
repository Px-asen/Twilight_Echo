import { normalizeLibraryPath, parentDirectoryOf } from './libraryIdentity.ts'
import { getPinyinInitial } from './pinyinInitials.ts'
import { fileArtistCredits, type TrackIdentityTags } from './trackIdentification.ts'

export function libraryArtistCredits(track: {
  artist?: string
  artists?: readonly { name: string; id?: string | number }[]
  identityTags?: TrackIdentityTags
}): { name: string; id?: string | number }[] {
  const artists = Array.isArray(track.artists)
    ? track.artists.filter(
        (artist) => artist && typeof artist.name === 'string' && artist.name.trim()
      )
    : undefined
  if (artists?.length && (artists.length > 1 || artists[0].id !== undefined)) return [...artists]
  const fileCredits = fileArtistCredits(track.identityTags)
  // Older scans copied a single joined ARTIST tag into `artists`. It is still
  // display text, unlike explicit members or credits with provider identities.
  const copiedFileCredit =
    artists?.length === 1 && fileCredits.length === 1 &&
    artists[0].name.trim() === fileCredits[0].name
  if (artists?.length && !copiedFileCredit) return [...artists]
  if (fileCredits.length > 1 || track.identityTags?.ncm?.artists?.length) return fileCredits
  const displayArtist = typeof track.artist === 'string' ? track.artist : ''
  return splitJoinedArtistNames(fileCredits[0]?.name ?? displayArtist).map((name) => ({ name }))
}

/** Display credits use slashes or a spaced ampersand; structured provider names stay literal. */
function splitJoinedArtistNames(value: string): string[] {
  const names: string[] = []
  for (const credit of value.split(/\s+[&＆]\s+/u)) {
    const parts = credit.split(/[/／]/u).map((name) => name.trim()).filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
      // This band's slash is part of its name, including in AC/DC/Guest credits.
      const name =
        /^ac$/i.test(parts[index]) && /^dc$/i.test(parts[index + 1] ?? '')
          ? `${parts[index]}/${parts[++index]}`
          : parts[index]
      names.push(name)
    }
  }
  return [...new Set(names)]
}

/** One collection per credited member; never add the joined display credit. */
export function libraryArtistNames(track: {
  artist: string
  artists?: readonly { name: string }[]
  identityTags?: TrackIdentityTags
}): string[] {
  const credits = libraryArtistCredits(track).map((artist) => artist.name.trim()).filter(Boolean)
  return credits.length ? [...new Set(credits)] : ['未知艺术家']
}

export function collectionIndexLetter(name: string): string | null {
  const first = name.trim().normalize('NFKD').replace(/\p{M}/gu, '').charAt(0).toUpperCase()
  if (/^[A-Z]$/.test(first)) return first
  return getPinyinInitial(first).toUpperCase() || null
}

/** Keep full display-name links as well as individual credited artists usable. */
export function isLibraryArtistMember(
  track: { artist: string; artists?: readonly { name: string }[]; identityTags?: TrackIdentityTags },
  name: string
): boolean {
  const artistName = name.trim()
  if (!artistName) return false
  if ((track.artist.trim() || '未知艺术家') === artistName) return true
  return libraryArtistNames(track).some((name) => name.trim() === artistName)
}

export function resolveAlbumArtist(
  tracks: readonly { artist?: string; albumArtist?: string }[]
): string {
  return resolveAlbumArtistNames(
    tracks.map((track) => track.albumArtist ?? ''),
    tracks.map((track) => track.artist ?? '')
  )
}

export function resolveAlbumArtistNames(
  owners: Iterable<string>,
  artists: Iterable<string>
): string {
  const meaningful = (values: Iterable<string>): Set<string> =>
    new Set(
      [...values]
        .map((value) => value.trim())
        .filter((value) => value && !/^(?:unknown(?: artist)?|未知(?:艺术家|歌手))$/i.test(value))
    )
  const ownerNames = meaningful(owners),
    artistNames = meaningful(artists)
  if (ownerNames.size === 1) return [...ownerNames][0]!
  if (artistNames.size === 1) return [...artistNames][0]!
  return artistNames.size > 1 ? '群星' : '未知歌手'
}

const underRoot = (filePath: string, root: string): boolean => {
  const path = normalizeLibraryPath(filePath),
    normalizedRoot = normalizeLibraryPath(root)
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}\\`)
}

/** Untrusted legacy `dir` tags cannot place a file outside its configured roots. */
export function getCollectionDirectory(
  filePath: string,
  metadataDirectory: string | undefined,
  roots: readonly string[]
): string {
  const directory = metadataDirectory?.trim() || parentDirectoryOf(filePath)
  if (!roots.length) return directory
  const matching = roots.filter((root) => underRoot(filePath, root))
  if (!matching.length) return ''
  return matching.every((root) => underRoot(directory, root))
    ? directory
    : parentDirectoryOf(filePath)
}

/** One folder bucket contributes to each ancestor up to all containing scan roots. */
export function getCollectionAncestors(directory: string, roots: readonly string[]): string[] {
  if (!roots.length) return directory ? [directory] : []
  const remaining = new Set(
    roots.filter((root) => underRoot(directory, root)).map(normalizeLibraryPath)
  )
  if (!remaining.size) return []
  const result: string[] = []
  let current = directory
  while (current) {
    result.push(current)
    remaining.delete(normalizeLibraryPath(current))
    if (!remaining.size) break
    const parent = parentDirectoryOf(current)
    if (parent === current) break
    current = parent
  }
  return result
}
