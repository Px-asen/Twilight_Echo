import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { CoreLibraryReadRequest } from '../../shared/coreLibrary.ts'
import { projectCoreTrack } from '../projections.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import type { TrackData } from '../../shared/track.ts'

export type CoreLibraryReadDatabase = Pick<
  LibraryDatabaseApi,
  'queryCollections' | 'getTracksByIds' | 'lookupTracksByPaths' | 'lookupPlaylistTracks'
>

export async function executeLibraryRead(
  database: CoreLibraryReadDatabase,
  request: Exclude<CoreLibraryReadRequest, { name: 'library.artwork' | 'library.recent.resolve' }>,
  metadata?: import('../../shared/entityMetadata.ts').EntityMetadataReadOptions
) {
  switch (request.name) {
    case 'library.collections':
      return request.payload.kind === 'albums' && metadata
        ? database.queryCollections(request.payload.kind, request.payload.query, metadata)
        : database.queryCollections(request.payload.kind, request.payload.query)
    case 'library.byIds': {
      const page = await database.getTracksByIds(request.payload.ids, request.payload.revision)
      return { ...page, tracks: page.tracks.map((track) => projectCoreTrack(track)) }
    }
    case 'library.paths.lookup':
      return database.lookupTracksByPaths(request.payload.paths, request.payload.revision)
  }
}

export async function executeLibraryArtwork(
  database: Pick<LibraryDatabaseApi, 'getTracksByIds'>,
  request: import('../../shared/coreLibrary.ts').CoreLibraryQueries['library.artwork']['input'],
  present: (track: TrackData, signal: AbortSignal) => Promise<{ cover: string | null }>,
  signal: AbortSignal,
  fallbackTracks?: (
    ids: readonly string[],
    signal: AbortSignal
  ) => Promise<ReadonlyMap<string, TrackData>> | ReadonlyMap<string, TrackData>
) {
  const page = await database.getTracksByIds(request.ids, request.revision)
  const seen = new Set<string>()
  const items: Array<{ id: string; cover: string | null }> = []
  for (const record of page.tracks) {
    signal.throwIfAborted()
    seen.add(record.id)
    const artwork = await present(libraryTrack(record), signal)
    items.push({ id: record.id, cover: artwork.cover })
  }
  if (fallbackTracks) {
    const missing = [...new Set(request.ids.filter((id) => !seen.has(id)))]
    if (missing.length) {
      const resolved = await fallbackTracks(missing, signal)
      for (const id of missing) {
        const track = resolved.get(id)
        if (!track) continue
        signal.throwIfAborted()
        const artwork = await present(track, signal)
        items.push({ id, cover: artwork.cover })
      }
    }
  }
  return { revision: page.revision, items }
}
