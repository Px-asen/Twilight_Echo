import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { executeLibraryRead, executeLibraryArtwork } from './readOperations.ts'
import { validCoreLibraryReadPayload } from '../../shared/coreLibrary.ts'

test('bounded library projections retain row versions and identities without returning source authorization', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: ['D:/Music'],
    exclusions: [],
    tracks: [
      {
        id: 'cue:1',
        filePath: 'D:/Music/album.flac',
        fileName: 'album.flac',
        title: 'First',
        artist: 'Artist',
        album: 'Album',
        duration: 20,
        size: 10,
        cover: null,
        lyrics: 'private',
        playbackUrl: 'https://user:secret@host/music?token=private',
        cueRange: { startSeconds: 0, endSeconds: 20, pregapSeconds: 0 }
      }
    ]
  })
  const database = {
    getTracksByIds: async (ids: string[], revision?: number) => db.getTracksByIds(ids, revision),
    lookupTracksByPaths: async (paths: string[], revision?: number) =>
      db.lookupTracksByPaths(paths, revision),
    lookupPlaylistTracks: async (...args: Parameters<typeof db.lookupPlaylistTracks>) =>
      db.lookupPlaylistTracks(...args),
    queryCollections: async (...args: Parameters<typeof db.queryCollections>) =>
      db.queryCollections(...args)
  }
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const byIds = await executeLibraryRead(database, {
    name: 'library.byIds',
    payload: { ids: ['cue:1'] }
  })
  assert.ok(byIds && 'tracks' in byIds)
  if (!byIds || !('tracks' in byIds)) return
  assert.equal(byIds.tracks[0].id, 'cue:1')
  assert.deepEqual(byIds.tracks[0].cueRange, {
    startSeconds: 0,
    endSeconds: 20,
    pregapSeconds: 0,
    virtualPregapSeconds: 0,
    sourcePregapSeconds: 0
  })
  for (const key of ['filePath', 'fileName', 'lyrics', 'playbackUrl'])
    assert.equal(key in byIds.tracks[0], false)
  assert.equal(byIds.versions['cue:1'], 1)
  assert.deepEqual(byIds.catalog, db.getTracksByIds(['cue:1']).catalog)
  assert.equal(byIds.catalog!.tracks[0]!.items.find(i => i.kind === 'recording')!.title, 'First')
  assert.equal(JSON.stringify(byIds.catalog).includes('D:/Music'), false)
  assert.equal(JSON.stringify(byIds).includes('user:secret'), false)
  const lookup = await executeLibraryRead(database, {
    name: 'library.paths.lookup',
    payload: { paths: ['D:/Music/album.flac'], revision: byIds.revision }
  })
  assert.deepEqual(lookup, { ids: ['cue:1'], revision: byIds.revision })
  await assert.rejects(
    executeLibraryRead(database, {
      name: 'library.byIds',
      payload: { ids: ['cue:1'], revision: byIds.revision + 1 }
    }),
    /曲库在读取期间发生变化/
  )
})

test('library read boundary keeps query semantics and bounds IDs and paths to one page', () => {
  const query = (value: unknown) => JSON.stringify(value) === '{"limit":200}'
  assert.equal(
    validCoreLibraryReadPayload(
      'library.collections',
      { kind: 'albums', query: { limit: 200 } },
      query
    ),
    true
  )
  assert.equal(
    validCoreLibraryReadPayload(
      'library.collections',
      { kind: 'albums', query: { limit: 201 } },
      query
    ),
    false
  )
  assert.equal(validCoreLibraryReadPayload('library.collections', {
    kind: 'albums', query: { limit: 200 }, platformContexts: { ncm: 'caller-injected' }
  }, query), false)
  for (const name of ['library.byIds', 'library.paths.lookup']) {
    const key = name === 'library.byIds' ? 'ids' : 'paths'
    assert.equal(
      validCoreLibraryReadPayload(name, { [key]: Array(200).fill('id'), revision: 1 }, query),
      true
    )
    assert.equal(validCoreLibraryReadPayload(name, { [key]: Array(201).fill('id') }, query), false)
    assert.equal(
      validCoreLibraryReadPayload(name, { [key]: ['id'], path: 'arbitrary' }, query),
      false
    )
    assert.equal(validCoreLibraryReadPayload(name, { [key]: ['id\0tail'] }, query), false)
  }
})

test('collection reads forward Core-owned metadata options only for albums', async () => {
  const calls: unknown[][] = []
  const database = { queryCollections: async (...args: unknown[]) => {
    calls.push(args)
    return { items: [], offset: 0, total: 0, revision: 1 }
  } } as unknown as Parameters<typeof executeLibraryRead>[0]
  const options = { platformContexts: { ncm: 'trusted' }, now: 2000 }
  await executeLibraryRead(database, { name: 'library.collections', payload: { kind: 'albums' } }, options)
  await executeLibraryRead(database, { name: 'library.collections', payload: { kind: 'artists' } }, options)
  assert.deepEqual(calls, [['albums', undefined, options], ['artists', undefined]])
})

test('artwork resolves database-owned origins through the platform and returns display handles only', async () => {
  const requests: unknown[] = []
  const signal = new AbortController().signal
  const result = await executeLibraryArtwork(
    {
      getTracksByIds: async () => ({
        revision: 3,
        offset: 0,
        total: 1,
        versions: { song: 1 },
        tracks: [
          {
            id: 'song',
            filePath: 'D:/private.flac',
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            duration: 1,
            cover: 'expired-handle',
            coverSource: 'https://private-cdn/image?token=secret'
          }
        ]
      })
    },
    { ids: ['song'], revision: 3 },
    async (track, current) => {
      assert.equal(current, signal)
      requests.push(track.coverSource)
      return { cover: 'twilight-media://image/granted' }
    },
    signal
  )
  assert.deepEqual(requests, ['https://private-cdn/image?token=secret'])
  assert.deepEqual(result, {
    revision: 3,
    items: [{ id: 'song', cover: 'twilight-media://image/granted' }]
  })
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('artwork resolves fallback streaming snapshot tracks not stored in the local tracks table', async () => {
  const signal = new AbortController().signal
  const result = await executeLibraryArtwork(
    {
      getTracksByIds: async () => ({
        revision: 5,
        offset: 0,
        total: 0,
        versions: {},
        tracks: []
      })
    },
    { ids: ['ncm:42'], revision: 5 },
    async (track) => ({
      cover: track.coverSource ? 'twilight-media://image/streaming_42' : null
    }),
    signal,
    async () =>
      new Map([
        [
          'ncm:42',
          {
            id: 'ncm:42',
            source: 'ncm',
            title: 'Is this love?',
            artist: 'twenty4-7',
            album: 'Letter',
            filePath: '',
            fileName: 'Is this love?',
            duration: 277,
            size: 0,
            cover: null,
            coverSource: 'https://p2.music.126.net/private.jpg',
            lyrics: null
          }
        ]
      ])
  )
  assert.deepEqual(result, {
    revision: 5,
    items: [{ id: 'ncm:42', cover: 'twilight-media://image/streaming_42' }]
  })
  assert.equal(JSON.stringify(result).includes('private.jpg'), false)
})
