import assert from 'node:assert/strict'
import test from 'node:test'
import type { LibraryItem } from '@renderer/stores/library/musicStoreTypes.ts'
import type { MediaProvider } from '@renderer/providers/mediaProvider.ts'
import type { Track } from '@renderer/types/music'
import { albumSearchKey, createAlbumSearch } from './albumSearch.ts'

const track: Track = {
  id: 'local:1',
  title: 'One',
  artist: 'Artist',
  album: 'Album',
  filePath: 'C:/Music/1.flac',
  fileName: '1.flac',
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local'
}
const localAlbums: LibraryItem[] = [
  {
    id: '1',
    name: 'Album',
    artist: 'Artist',
    cover: null,
    trackCount: 2,
    tracks: [track, { ...track, id: 'local:2' }]
  },
  {
    id: '2',
    name: 'Album',
    artist: 'Other artist',
    cover: null,
    trackCount: 1,
    tracks: [{ ...track, id: 'local:3' }]
  }
]
const providers = [
  { id: 'ncm', name: '网易云音乐', capabilities: ['search'], supportedMethods: ['searchAlbums'] },
  {
    id: 'songs-only',
    name: 'Songs only',
    capabilities: ['search'],
    supportedMethods: ['searchSongs']
  }
]

test('album pages cross sources without merging same ids or names and propagate cancellation', async () => {
  const controller = new AbortController()
  const calls: Array<[string, number, number]> = []
  const online = Array.from({ length: 33 }, (_, index) => ({
    id: String(index + 1),
    name: 'Album',
    cover: null,
    trackCount: 5
  }))
  const search = createAlbumSearch({
    localAlbums: () => localAlbums,
    providers: () => providers,
    getProvider: () => null,
    searchProvider: async (providerId, query, limit, offset, options) => {
      assert.equal(query, 'Album')
      assert.equal(options?.signal, controller.signal)
      calls.push([providerId, limit, offset])
      return { items: online.slice(offset, offset + limit), total: online.length }
    },
    reportError: (message) => assert.fail(message)
  })
  const first = await search.searchAlbums('Album', 30, 0, { signal: controller.signal })
  const second = await search.searchAlbums('Album', 30, 30, { signal: controller.signal })
  assert.equal(first.total, 35)
  assert.equal(first.albums.length, 30)
  assert.equal(second.albums.length, 5)
  const combined = [...first.albums, ...second.albums]
  assert.equal(new Set(combined.map(albumSearchKey)).size, 35)
  assert.deepEqual(
    combined.slice(0, 3).map((album) => [album.providerId, album.id]),
    [
      ['local', '1'],
      ['local', '2'],
      ['ncm', '1']
    ]
  )
  assert.equal(combined[2].providerName, '网易云音乐')
  assert.ok(calls.every(([provider, limit]) => provider === 'ncm' && limit <= 30))
  assert.ok(calls.some(([, , offset]) => offset === 28))
})

test('local albums remain usable when the provider fails or is disabled', async () => {
  const warnings: string[] = []
  let available = true
  let calls = 0
  const search = createAlbumSearch({
    localAlbums: () => localAlbums,
    providers: () => providers.map((provider) => ({ ...provider, health: { available } })),
    getProvider: () => null,
    searchProvider: async () => {
      calls++
      throw new Error('offline')
    },
    reportError: (message) => warnings.push(message)
  })
  const page = await search.searchAlbums('Album')
  assert.equal(page.albums.length, 2)
  assert.match(warnings[0], /网易云音乐.*offline/)
  await assert.rejects(search.searchAlbums('no local match'), /offline/)
  available = false
  const before = calls
  assert.equal((await search.searchAlbums('Album')).total, 2)
  assert.equal(calls, before)
  await assert.rejects(search.searchProviderAlbums('ncm', 'Album'), /不可用/)
})

test('album details route by source and release id, preserving local disc and track order', async () => {
  const fetched: Array<[string, string | number]> = []
  const search = createAlbumSearch({
    localAlbums: () => localAlbums,
    providers: () => providers,
    searchProvider: async () => ({ items: [], total: 0 }),
    getProvider: (id): MediaProvider | null =>
      id === 'ncm'
        ? {
            id,
            name: id,
            source: 'plugin',
            capabilities: ['playlist'],
            fetchAlbumTracks: async (albumId) => {
              fetched.push([id, albumId])
              return [{ ...track, id: 'ncm:1', source: id }]
            }
          }
        : null,
    reportError: (message) => assert.fail(message)
  })
  const local = await search.loadAlbumTracks({ providerId: 'local', id: '1' })
  assert.equal(local, localAlbums[0].tracks)
  assert.deepEqual(
    local.map((item) => item.id),
    ['local:1', 'local:2']
  )
  assert.equal(fetched.length, 0)
  assert.equal((await search.loadAlbumTracks({ providerId: 'ncm', id: '1' }))[0].source, 'ncm')
  assert.deepEqual(fetched, [['ncm', '1']])
  await assert.rejects(
    search.loadAlbumTracks({ providerId: 'local', id: 'missing' }),
    /已不在本地音乐库/
  )
  await assert.rejects(search.loadAlbumTracks({ providerId: 'removed', id: '1' }), /不可用/)
})
