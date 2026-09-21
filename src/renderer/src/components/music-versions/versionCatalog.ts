import type { Track } from '@renderer/types/music'
import { getAlbumIdentity } from '@renderer/stores/library/musicStoreData.ts'
import { getTrackSource, versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import type { MusicVersionsDocument, VersionScope } from '@renderer/utils/musicVersions.ts'

export interface VersionCatalogItem {
  key: string
  title: string
  artist: string
  source: string
  tracks: Track[]
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
        : JSON.stringify(['album', source, getAlbumIdentity(track)])
    const existing = items.get(key)
    if (existing) {
      if (scope === 'albums') existing.tracks.push(track)
    } else
      items.set(key, {
        key,
        title: scope === 'tracks' ? track.title : track.album,
        artist: track.albumArtist || track.artist,
        source,
        tracks: [track]
      })
  }
  if (scope === 'albums')
    for (const item of items.values())
      item.tracks.sort(
        (left, right) =>
          (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
          (left.trackNumber ?? 0) - (right.trackNumber ?? 0) ||
          left.fileName.localeCompare(right.fileName)
      )
  return [...items.values()]
}

export function resolvePreferredVersion(
  document: MusicVersionsDocument,
  scope: VersionScope,
  key: string,
  catalog: readonly VersionCatalogItem[]
): Track[] {
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
