import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  LibraryCollectionKind,
  LibraryCollectionPage,
  LibraryQuery
} from '../../../../shared/libraryDatabase.ts'
import { createLibraryCollectionPages } from './libraryCollectionPages.ts'
import { libraryDetailScope } from '../../utils/libraryTrackQuery.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settled(pages: ReturnType<typeof createLibraryCollectionPages>) {
  for (let i = 0; i < 50; i++) {
    if (!pages.state.value.loading) return
    await tick()
  }
  assert.fail('summary reader did not settle')
}
function page(query: LibraryQuery = {}, revision = 1, total = 300_000): LibraryCollectionPage {
  const offset = query.offset ?? 0
  return {
    offset,
    total,
    revision,
    letterOffsets: { A: 0, Z: 299_900 },
    items: Array.from(
      { length: Math.max(0, Math.min(query.limit ?? 200, total - offset)) },
      (_, i) => ({
        id: `id:${offset + i}`,
        name: `${query.search ?? 'Album'} ${offset + i}`,
        trackCount: 100,
        duration: 3600,
        cover: null
      })
    )
  }
}

test('summary navigation caches at most four 200-item pages and retains authoritative total and global letters', async (t) => {
  const calls: LibraryQuery[] = []
  const pages = createLibraryCollectionPages({
    queryCollections: async (_kind, query) => {
      calls.push(query!)
      return page(query)
    }
  })
  t.after(() => pages.dispose())
  pages.setQuery('albums', { search: 'song' })
  await settled(pages)
  for (let i = 1; i < 15; i++) {
    pages.goToPage(i)
    assert.equal(pages.state.value.total, 300_000)
    await settled(pages)
    assert.equal(pages.state.value.page?.offset, i * 200)
    assert.equal(pages.state.value.page?.letterOffsets.Z, 299_900)
    assert.ok(pages.state.value.page?.items.every((item) => !('tracks' in item)))
  }
  assert.equal(pages.cacheState.cachedPages, 4)
  assert.equal(pages.cacheState.cachedItems, 800)
  pages.goToPage(14)
  await settled(pages)
  assert.equal(calls.length, 15)
  assert.ok(calls.every((query) => query.limit === 200))
})

test('rapid categories, pages and search changes keep only the latest waiting demand and two active RPCs', async (t) => {
  const pending: {
    kind: LibraryCollectionKind
    query: LibraryQuery
    resolve(page: LibraryCollectionPage): void
  }[] = []
  const pages = createLibraryCollectionPages({
    queryCollections: (kind, query) =>
      new Promise((resolve) => {
        pending.push({ kind, query: query!, resolve })
      })
  })
  t.after(() => pages.dispose())
  pages.setQuery('artists', { search: 'old' })
  pages.goToPage(9)
  for (let i = 0; i < 50; i++) pages.setQuery('albums', { search: `new ${i}` })
  assert.equal(pending.length, 2)
  assert.equal(pages.cacheState.activeRequests, 2)
  pending[0].resolve(page(pending[0].query))
  await tick()
  assert.equal(pending.length, 3)
  assert.equal(pending[2].kind, 'albums')
  assert.equal(pending[2].query.search, 'new 49')
  pending[2].resolve(page(pending[2].query, 8))
  await settled(pages)
  const current = pages.state.value.page
  pending[1].resolve(page(pending[1].query, 1))
  await tick()
  assert.equal(pages.state.value.page, current)
  assert.match(current!.items[0].name, /new 49/)
  assert.equal(pages.cacheState.cachedPages, 1)
})

test('scan revisions invalidate summaries; older in-flight reads and notifications cannot overwrite them', async (t) => {
  const pending: { query: LibraryQuery; resolve(page: LibraryCollectionPage): void }[] = []
  const pages = createLibraryCollectionPages({
    queryCollections: (_kind, query) =>
      new Promise((resolve) => {
        pending.push({ query: query!, resolve })
      })
  })
  t.after(() => pages.dispose())
  pages.setQuery('folders')
  pages.invalidate(5)
  assert.equal(pending.length, 2)
  pending[1].resolve(page(pending[1].query, 5))
  await settled(pages)
  pending[0].resolve(page(pending[0].query, 1))
  await tick()
  pages.invalidate(5)
  pages.invalidate(4)
  assert.equal(pending.length, 2)
  assert.equal(pages.state.value.page?.revision, 5)
  pages.invalidate(6)
  pending[2].resolve(page(pending[2].query, 5))
  await settled(pages)
  assert.equal(pages.state.value.page, null)
  assert.match(pages.state.value.error, /发生变化/)
})

test('background commits retain the album header until its same-page replacement arrives', async (t) => {
  const pending: { query: LibraryQuery; resolve(page: LibraryCollectionPage): void }[] = []
  const pages = createLibraryCollectionPages({
    queryCollections: (_kind, query) => new Promise(resolve => pending.push({ query: query!, resolve }))
  }, 1)
  t.after(pages.dispose)
  pages.setQuery('albums', { albumId: 'album-a' })
  pending[0].resolve(page(pending[0].query, 1, 1))
  await settled(pages)
  const header = pages.state.value.page
  pages.invalidate(2)
  assert.equal(pages.state.value.loading, true)
  assert.equal(pages.state.value.page, header)
  pages.invalidate(3)
  assert.equal(pages.state.value.page, header)
  pending[1].resolve(page(pending[1].query, 2, 1))
  await tick()
  assert.equal(pages.state.value.page, header, 'superseded data cannot repaint the header')
  pending[2].resolve(page(pending[2].query, 3, 1))
  await settled(pages)
  assert.equal(pages.state.value.page?.revision, 3)
  pages.setQuery('albums', { albumId: 'album-b' })
  assert.equal(pages.state.value.page, null, 'navigation never shows another album header')
})

test('errors stay distinct from empty results and explicit retry recovers; disposal fences late failures', async () => {
  let fail = true
  const pages = createLibraryCollectionPages({
    queryCollections: async (_kind, query) => {
      if (fail) throw new Error('worker unavailable')
      return page(query, 1, 0)
    }
  })
  pages.setQuery('genres')
  await settled(pages)
  assert.equal(pages.state.value.total, null)
  assert.match(pages.state.value.error, /unavailable/)
  fail = false
  pages.retry()
  await settled(pages)
  assert.equal(pages.state.value.total, 0)
  assert.equal(pages.state.value.error, '')
  pages.dispose()
  let reject!: (error: Error) => void
  const late = createLibraryCollectionPages({
    queryCollections: () =>
      new Promise((_resolve, no) => {
        reject = no
      })
  })
  late.setQuery('albums')
  late.dispose()
  const checkpoint = late.state.value
  reject(new Error('late failure'))
  await tick()
  assert.equal(late.state.value, checkpoint)
  assert.equal(late.cacheState.activeRequests, 0)
})

test('deletions clamp deep pages to the last existing page and an empty library to page zero', async (t) => {
  let total = 1000,
    revision = 1
  const pages = createLibraryCollectionPages({
    queryCollections: async (_kind, query) => page(query, revision, total)
  })
  t.after(() => pages.dispose())
  pages.setQuery('albums')
  await settled(pages)
  pages.goToPage(4)
  await settled(pages)
  total = 210
  pages.invalidate(++revision)
  await settled(pages)
  assert.equal(pages.state.value.requestedPage, 1)
  assert.equal(pages.state.value.page?.items.length, 10)
  total = 0
  pages.invalidate(++revision)
  await settled(pages)
  assert.equal(pages.state.value.requestedPage, 0)
  assert.equal(pages.state.value.page?.total, 0)
})

test('detail links resolve complete SQL scopes and freeze their full queues beyond the loaded page', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: ['D:/Music'],
    exclusions: [],
    tracks: Array.from({ length: 405 }, (_, i) => ({
      id: `${i}`,
      filePath: `D:/Music/disc/sub/${i}.flac`,
      title: `Song ${i}`,
      artist: 'A / B',
      artists: [{ name: 'A' }, { name: 'B' }],
      album: 'Release',
      genre: 'Pop/Rock',
      duration: 60
    }))
  })
  const albumId = db.queryCollections('albums').items[0].id
  for (const [kind, filter] of [
    ['albums', `album:${albumId}`],
    ['artists', 'artist:A'],
    ['genres', 'genre:Rock'],
    ['folders', 'folder:D:/Music/disc']
  ]) {
    const scope = libraryDetailScope(kind, filter)!
    const query = { ...scope, genreSeparators: '/', sort: 'title' as const }
    assert.equal(db.queryTracks(query).tracks.length, 200)
    assert.equal(db.queryTracks(query).total, 405)
    assert.equal(db.queryTracks(query).totalDuration, 24_300)
    const queue = db.createLibraryQueue(query, '404')
    assert.equal(queue.total, 405)
    assert.ok(queue.index >= 200)
    assert.equal(db.readLibraryQueue(queue.id, queue.index, 1).items[0].track?.id, '404')
  }
  assert.deepEqual(libraryDetailScope('allSongs', null), {})
  assert.equal(libraryDetailScope('playlists', 'playlist:A'), null)
  assert.equal(libraryDetailScope('albums', 'album:'), null)
  assert.equal(libraryDetailScope('recent', null), null)
})
