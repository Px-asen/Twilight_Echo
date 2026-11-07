import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../../shared/track.ts'
import {
  buildVersionCatalog,
  queryVersionCatalogPage,
  resolvePreferredSourceKey,
  resolvePreferredVersion,
  versionDescriptions
} from './versionCatalog.ts'
import { emptyMusicVersions, editMusicVersions } from '@renderer/utils/musicVersions.ts'
import type { LibraryDatabaseApi, LibraryTrackRecord } from '../../../../shared/libraryDatabase.ts'
import type { Track as ViewTrack } from '@renderer/types/music'

test('projected provider albums work without a private file path', () => {
  const projected: ViewTrack = {
    id: 'ncm:1', source: 'ncm', title: 'Song', artist: 'Artist', album: 'Album', duration: 180,
    cover: null, lyrics: null, size: 0
  }
  const [album] = buildVersionCatalog([projected], 'albums')
  assert.equal(album.key, JSON.stringify(['album', 'ncm', 'name:artist\u001falbum']))
  assert.equal(album.tracks[0], projected)
})

function track(id: string, album: string, disc = 1, index = 1): Track {
  return {
    id,
    title: id,
    artist: 'Artist',
    album,
    albumId: album,
    filePath: `D:/music/${id}.flac`,
    fileName: `${id}.flac`,
    source: 'local',
    duration: 180,
    size: 100,
    cover: null,
    lyrics: null,
    discNumber: disc,
    trackNumber: index
  }
}
test('album versions preserve disc/track order and refuse to play unavailable preferred releases', () => {
  const tracks = [track('b2', 'B', 2), track('b1', 'B'), track('a', 'A')]
  const catalog = buildVersionCatalog(tracks, 'albums')
  assert.deepEqual(
    catalog[0].tracks.map((item) => item.id),
    ['b1', 'b2']
  )
  const [b, a] = catalog
  let doc = editMusicVersions(emptyMusicVersions(), 'albums', 'family', [a.key, b.key], '')
  doc = editMusicVersions(doc, 'albums', 'label', [b.key], 'Live 2024')
  doc = editMusicVersions(doc, 'albums', 'prefer-version', [b.key], '')
  assert.deepEqual(
    resolvePreferredVersion(doc, 'albums', a.key, catalog).map((item) => item.id),
    ['b1', 'b2']
  )
  assert.throws(() => resolvePreferredVersion(doc, 'albums', a.key, [a]), /未载入/)
  assert.match(versionDescriptions(doc, 'albums').get(b.key)!, /Live 2024.*偏好版本/)
  assert.deepEqual(
    tracks.map((item) => item.id),
    ['b2', 'b1', 'a']
  )
})

test('a preferred source never silently falls back and changes do not rewrite track payloads', () => {
  const tracks = [track('a', 'A'), track('b', 'A')]
  const [a, b] = buildVersionCatalog(tracks, 'tracks')
  let doc = editMusicVersions(emptyMusicVersions(), 'tracks', 'sources', [a.key, b.key], 'Studio')
  doc = editMusicVersions(doc, 'tracks', 'prefer-source', [b.key], '')
  assert.equal(resolvePreferredSourceKey(doc, 'tracks', a.key), b.key)
  assert.equal(resolvePreferredVersion(doc, 'tracks', a.key, [a, b])[0], tracks[1])
  assert.throws(() => resolvePreferredVersion(doc, 'tracks', a.key, [a]), /未载入/)
  assert.equal(tracks[0].album, 'A')
})

test('SQLite track catalog returns only the requested bounded page for a large library', async () => {
  let request: Parameters<LibraryDatabaseApi['queryTracks']>[0] | undefined
  const records = [track('200', 'Album'), track('201', 'Album')] as unknown as LibraryTrackRecord[]
  const api: Pick<LibraryDatabaseApi, 'queryTracks' | 'queryCollections'> = {
    queryTracks: async (query) => {
      request = query
      return {
        tracks: records,
        versions: { '200': 1, '201': 1 },
        total: 300_000,
        revision: 17,
        offset: query?.offset ?? 0
      }
    },
    queryCollections: async () => {
      throw new Error('track scope must not query collections')
    }
  }

  const page = await queryVersionCatalogPage(api, 'tracks', {
    search: 'needle',
    offset: 200,
    limit: 50
  })

  assert.deepEqual(request, { search: 'needle', offset: 200, limit: 50, sort: 'insertion' })
  assert.equal(page.total, 300_000)
  assert.equal(page.items.length, 2)
  assert.equal(page.items[0].trackId, '200')
  assert.equal(page.items[1].tracks[0].title, '201')
})

test('SQLite album catalog pages summaries without transferring member tracks', async () => {
  let requestedKind: string | undefined
  let request: Parameters<LibraryDatabaseApi['queryCollections']>[1] | undefined
  const api: Pick<LibraryDatabaseApi, 'queryTracks' | 'queryCollections'> = {
    queryTracks: async () => {
      throw new Error('album scope must not query tracks for its catalog')
    },
    queryCollections: async (kind, query) => {
      requestedKind = kind
      request = query
      return {
        items: [
          {
            id: 'id:release-201',
            name: 'Release 201',
            artist: 'Artist',
            trackCount: 14,
            duration: 1_800,
            cover: null
          }
        ],
        total: 12_000,
        revision: 23,
        offset: query?.offset ?? 0,
        letterOffsets: {}
      }
    }
  }

  const page = await queryVersionCatalogPage(api, 'albums', { offset: 400, limit: 50 })

  assert.equal(requestedKind, 'albums')
  assert.deepEqual(request, { offset: 400, limit: 50 })
  assert.equal(page.total, 12_000)
  assert.equal(page.items[0].key, JSON.stringify(['album', 'local', 'id:release-201']))
  assert.equal(page.items[0].trackCount, 14)
  assert.deepEqual(page.items[0].tracks, [])
})
