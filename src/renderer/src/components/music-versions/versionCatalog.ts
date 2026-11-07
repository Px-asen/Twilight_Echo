import type { Track } from '@renderer/types/music'
import type { useCoreConnection } from '../../stores/coreConnection.ts'
import { getAlbumIdentity } from '@renderer/stores/library/musicStoreData.ts'
import type { LibraryDatabaseApi, LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'
import { getTrackSource, versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import type { MusicVersionsDocument, VersionScope } from '@renderer/utils/musicVersions.ts'

export interface VersionCatalogItem {
  key: string
  title: string
  artist: string
  source: string
  tracks: Track[]
  trackCount?: number
  trackId?: string
  albumId?: string
}

export interface VersionCatalogPage {
  items: VersionCatalogItem[]
  total: number
  revision: number
  offset: number
}

export function buildVersionCatalog(
  tracks: readonly Track[],
  scope: VersionScope
): VersionCatalogItem[] {
  const items = new Map<string, VersionCatalogItem>()
  for (const track of tracks) {
    const source = getTrackSource(track)
    const key =
      scope === 'tracks'
        ? versionSourceKey(track)
        : JSON.stringify(['album', source, getAlbumIdentity({ ...track, filePath: track.filePath ?? '' })])
    const existing = items.get(key)
    if (existing) {
      if (scope === 'albums') {
        existing.tracks.push(track)
        existing.trackCount = existing.tracks.length
      }
    } else
      items.set(key, {
        key,
        title: scope === 'tracks' ? track.title : track.album,
        artist: track.albumArtist || track.artist,
        source,
        tracks: [track],
        trackCount: 1,
        ...(scope === 'tracks' ? { trackId: track.id } : {})
      })
  }
  if (scope === 'albums')
    for (const item of items.values())
      item.tracks.sort(
        (left, right) =>
          (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
          (left.trackNumber ?? 0) - (right.trackNumber ?? 0) ||
          (left.fileName ?? left.title).localeCompare(right.fileName ?? right.title)
      )
  return [...items.values()]
}

/** Read only the requested local catalog window; track payloads stay page-sized. */
export async function queryVersionCatalogPage(
  api: Pick<LibraryDatabaseApi, 'queryTracks' | 'queryCollections'>,
  scope: VersionScope,
  query: LibraryQuery
): Promise<VersionCatalogPage> {
  if (scope === 'tracks') {
    const page = await api.queryTracks({ ...query, sort: 'insertion' })
    const tracks = page.tracks.map(libraryTrack)
    return {
      items: buildVersionCatalog(tracks, 'tracks'),
      total: page.total,
      revision: page.revision,
      offset: page.offset
    }
  }

  const page = await api.queryCollections('albums', query)
  return {
    items: page.items.map((album) => ({
      key: JSON.stringify(['album', 'local', album.id]),
      title: album.name,
      artist: album.artist || '未知歌手',
      source: 'local',
      tracks: [],
      trackCount: album.trackCount,
      albumId: album.id
    })),
    total: page.total,
    revision: page.revision,
    offset: page.offset
  }
}

export function localAlbumIdFromVersionKey(key: string): string | null {
  try {
    const value: unknown = JSON.parse(key)
    if (
      Array.isArray(value) &&
      value[0] === 'album' &&
      value[1] === 'local' &&
      typeof value[2] === 'string'
    )
      return value[2]
  } catch {
    // Older or hand-edited keys remain available as unresolved entries.
  }
  return null
}

export async function resolveLocalTrackVersionKey(
  api: Pick<LibraryDatabaseApi, 'queryTracks'>,
  key: string
): Promise<Track | null> {
  let value: unknown
  try {
    value = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(value) || value[0] !== 'local' || typeof value[1] !== 'string') return null
  const filePath = value[1]
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const fileName = filePath.slice(slash + 1)
  const folder = slash > 0 ? filePath.slice(0, slash) : undefined
  if (!fileName) return null
  const page = await api.queryTracks({
    ...(folder ? { folder } : {}),
    search: fileName,
    searchFileName: true,
    offset: 0,
    limit: 1_000
  })
  return page.tracks.map(libraryTrack).find((track) => versionSourceKey(track) === key) ?? null
}

export function resolvePreferredSourceKey(
  document: MusicVersionsDocument,
  scope: VersionScope,
  key: string
): string {
  const domain = document[scope]
  const current = domain.versions.find((version) => version.sources.includes(key))
  const family = current && domain.families.find((item) => item.versions.includes(current.id))
  const version = family?.preferredVersion
    ? domain.versions.find((item) => item.id === family.preferredVersion)
    : current
  const source =
    version?.preferredSource ??
    (version?.sources.includes(key)
      ? key
      : version?.sources.length === 1
        ? version.sources[0]
        : null)
  if (version && !source) throw new Error('该版本有多个来源，请先明确选择偏好来源')
  return source ?? key
}

export function resolvePreferredVersion(
  document: MusicVersionsDocument,
  scope: VersionScope,
  key: string,
  catalog: readonly VersionCatalogItem[]
): Track[] {
  const source = resolvePreferredSourceKey(document, scope, key)
  const selected = catalog.find((item) => item.key === (source ?? key))
  if (!selected?.tracks.length)
    throw new Error('偏好版本或来源未载入，请重新连接来源、选择其他版本或清除偏好')
  return selected.tracks
}

export function versionDescriptions(
  document: MusicVersionsDocument,
  scope: VersionScope
): Map<string, string> {
  const domain = document[scope]
  const families = new Map(
    domain.families.flatMap((family) => family.versions.map((id) => [id, family] as const))
  )
  const descriptions = new Map<string, string>()
  for (const version of domain.versions) {
    const family = families.get(version.id)
    for (const key of version.sources)
      descriptions.set(
        key,
        `${version.label} · ${version.sources.length} 个来源${family ? ` · ${family.versions.length} 个关联版本` : ''}${version.preferredSource === key ? ' · 偏好来源' : ''}${family?.preferredVersion === version.id ? ' · 偏好版本' : ''}`
      )
  }
  return descriptions
}

export async function queryCoreVersionCatalog(
  core: ReturnType<typeof useCoreConnection>,
  scope: VersionScope,
  query: import('../../../../shared/coreVersions.ts').CoreVersionsCatalogQuery
): Promise<VersionCatalogPage> {
  const page = await core.query('versions.catalog', { ...query, scope })
  return {
    ...page,
    items: page.items.map((item) => ({
      key: item.key,
      title: scope === 'tracks' ? item.track.title : item.track.album,
      artist: item.track.albumArtist || item.track.artist,
      source: item.track.source ?? 'local',
      tracks: [item.track],
      trackCount: item.trackCount ?? 1,
      trackId: item.track.id,
      albumId: item.albumId
    }))
  }
}
