import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { TrackData } from '../../shared/track.ts'
import type { LibraryMetadataEnrichmentTrackUpdate } from './metadataEnrichment.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'

export const METADATA_PATCH_FIELDS = [
  'artist',
  'album',
  'genre',
  'cover',
  'coverSource',
  'lyrics',
  'translatedLyrics',
  'lyricsSource',
  'translatedLyricsSource',
  'metadataMatch'
] as const

const fields = METADATA_PATCH_FIELDS

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

export function hasMetadataPatchChanges(source: TrackData, track: TrackData): boolean {
  if (source === track) return false
  for (const field of fields) {
    if (!equal(source[field], track[field]) && track[field] !== undefined) return true
  }
  return false
}

/** Provider work can outlive a scan/edit. Compare its source with the authority,
 * then use that record's version to fence changes after this read. */
export async function patchLibraryMetadata(
  api: Pick<LibraryDatabaseApi, 'getTracksByIds' | 'patchTracks'>,
  update: LibraryMetadataEnrichmentTrackUpdate,
  isCurrent: () => boolean
) {
  return patchLibraryMetadataBatch(api, [update], isCurrent)
}

/** Read and compare each source independently, then use the existing atomic CAS writer. */
export async function patchLibraryMetadataBatch(
  api: Pick<LibraryDatabaseApi, 'getTracksByIds' | 'patchTracks'>,
  updates: LibraryMetadataEnrichmentTrackUpdate[],
  isCurrent: () => boolean
) {
  if (!isCurrent()) return null
  const changes = updates.flatMap((update) => {
    const patch: Record<string, unknown> = {}
    for (const field of fields) {
      if (!equal(update.source[field], update.track[field]) && update.track[field] !== undefined)
        patch[field] = update.track[field]
    }
    return Object.keys(patch).length ? [{ update, patch }] : []
  })
  if (!changes.length) return null
  const page = await api.getTracksByIds(changes.map(({ update }) => update.source.id))
  if (!isCurrent()) return null
  const currentById = new Map(page.tracks.map((track) => [track.id, libraryTrack(track)]))
  const patches = changes.flatMap(({ update, patch }) => {
    const current = currentById.get(update.source.id)
    if (!current) return []
    for (const field of [
      'filePath',
      'title',
      'artist',
      'album',
      'duration',
      'cueRange',
      ...Object.keys(patch)
    ]) {
      if (
        !equal(
          current[field as keyof typeof current],
          update.source[field as keyof typeof update.source]
        )
      )
        return []
    }
    return [{ id: current.id, expectedVersion: page.versions[current.id], patch }]
  })
  return patches.length ? api.patchTracks(patches) : null
}
