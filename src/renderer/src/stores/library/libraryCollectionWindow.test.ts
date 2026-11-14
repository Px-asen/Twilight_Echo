import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  LibraryCollectionKind,
  LibraryCollectionPage,
  LibraryQuery
} from '../../../../shared/libraryDatabase.ts'
import { createLibraryCollectionWindow } from './libraryCollectionWindow.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settled(source: ReturnType<typeof createLibraryCollectionWindow>) {
  for (let i = 0; i < 100 && source.state.value.loading; i++) await tick()
  assert.equal(source.state.value.loading, false)
}
function page(
  kind: LibraryCollectionKind,
  query: LibraryQuery = {},
  revision = 1,
  total = 300_000
): LibraryCollectionPage {
  const offset = query.offset ?? 0
  return {
    offset,
    revision,
    total,
    letterOffsets: total ? { A: 0, Z: total - 1 } : {},
    items: Array.from({ length: Math.max(0, Math.min(200, total - offset)) }, (_, i) => ({
      id: `${kind}:${query.search ?? ''}:${offset + i}`,
      name: `${offset + i}`,
      trackCount: 1,
      duration: 180,
      cover: null
    }))
  }
}

test('continuous collection summaries span pages and retain only four cached pages for a 300k result', async (t) => {
  const calls: LibraryQuery[] = []
  const source = createLibraryCollectionWindow({
    queryCollections: async (kind, query) => {
      calls.push(query!)
      return page(kind, query)
    }
  })
  t.after(() => source.dispose())
  source.setQuery('albums', { search: 'moon', direction: 'desc' })
  await settled(source)
  source.setRange(194, 216)
  await settled(source)
  assert.equal(source.itemAt(199)?.id, 'albums:moon:199')
  assert.equal(source.itemAt(200)?.id, 'albums:moon:200')
  assert.equal(source.indexOfItem(source.itemAt(215)!), 215)
  for (let i = 2; i < 22; i++) {
    source.setRange(i * 200 - 4, i * 200 + 18)
    await settled(source)
    assert.ok(source.pages.value.length <= 2)
  }
  assert.equal(source.state.value.total, 300_000)
  assert.equal(source.cacheState.cachedPages, 4)
  assert.equal(source.cacheState.cachedItems, 800)
  assert.equal(source.itemAt(0), undefined)
  assert.ok(calls.every((query) => query.limit === 200 && query.direction === 'desc'))
  assert.deepEqual(source.letterOffsets.value, { A: 0, Z: 299999 })
})

test('kind/search changes and deep jumps share two stale transport slots and only dispatch the latest demand', async (t) => {
  const pending: {
    kind: LibraryCollectionKind
    query: LibraryQuery
    resolve(value: LibraryCollectionPage): void
  }[] = []
  const source = createLibraryCollectionWindow({
    queryCollections: (kind, query) =>
      new Promise((resolve) => pending.push({ kind, query: query!, resolve }))
  })
  t.after(() => source.dispose())
  source.setQuery('albums')
  source.setRange(199, 215)
  for (let i = 0; i < 30; i++) {
    source.setQuery(i % 2 ? 'artists' : 'genres', { search: String(i) })
    source.setRange(20000, 20020)
  }
  assert.equal(pending.length, 2)
  pending[0].resolve(page(pending[0].kind, pending[0].query))
  await tick()
  assert.equal(pending[2].kind, 'artists')
  assert.equal(pending[2].query.search, '29')
  assert.equal(pending[2].query.offset, 20000)
  pending[1].resolve(page(pending[1].kind, pending[1].query))
  pending[2].resolve(page(pending[2].kind, pending[2].query, 5))
  await settled(source)
  assert.equal(source.itemAt(20000)?.id, 'artists:29:20000')
  assert.equal(source.state.value.error, '')
  assert.equal(source.cacheState.activeRequests, 0)
})

test('metadata refresh retains collection cards and letters until their replacement arrives', async (t) => {
  const pending: {
    kind: LibraryCollectionKind
    query: LibraryQuery
    resolve(value: LibraryCollectionPage): void
  }[] = []
  const source = createLibraryCollectionWindow({
    queryCollections: (kind, query) =>
      new Promise((resolve) => pending.push({ kind, query: query!, resolve }))
  })
  t.after(() => source.dispose())
  source.setQuery('albums')
  pending[0].resolve(page(pending[0].kind, pending[0].query))
  await settled(source)
  const album = source.itemAt(0)!
  source.invalidate(2)
  source.setRange(0, 20)
  assert.equal(source.itemAt(0), album)
  assert.deepEqual(source.letterOffsets.value, { A: 0, Z: 299999 })
  assert.equal(source.state.value.loading, true)
  assert.equal(source.cacheState.cachedItems, 0)
  const updated = page(pending[1].kind, pending[1].query, 2)
  updated.items[0] = { ...updated.items[0], name: 'Enriched album' }
  pending[1].resolve(updated)
  await settled(source)
  assert.equal(source.itemAt(0)?.name, 'Enriched album')
  source.setQuery('artists', {}, true)
  assert.equal(
    source.itemAt(0),
    undefined,
    'preserving position cannot carry cards into another query'
  )
  pending[2].resolve(page(pending[2].kind, pending[2].query, 2))
  await settled(source)
})

test('failed pages and lease replacement retain extent and letters, do not retry on overscan, and shrink safely', async (t) => {
  let fail = false,
    total = 300_000,
    revision = 1,
    calls = 0
  const source = createLibraryCollectionWindow({
    queryCollections: async (kind, query) => {
      calls++
      if (fail) throw new Error('disk unavailable')
      return page(kind, query, revision, total)
    }
  })
  t.after(() => source.dispose())
  source.setQuery('playlists')
  await settled(source)
  fail = true
  source.setRange(20000, 20020)
  await settled(source)
  assert.equal(source.state.value.total, 300_000)
  assert.equal(source.pages.value.length, 0)
  assert.deepEqual(source.letterOffsets.value, { A: 0, Z: 299999 })
  for (let i = 0; i < 10; i++) source.setRange(20001, 20021)
  await tick()
  assert.equal(calls, 2)
  assert.match(source.state.value.error, /disk unavailable/)
  fail = false
  source.retry()
  await settled(source)
  source.setQuery(null, {}, true)
  assert.equal(source.state.value.total, 300_000)
  assert.equal(source.itemAt(20001), undefined)
  source.setQuery('playlists', { playlistView: 'replacement' }, true)
  await settled(source)
  assert.equal(source.itemAt(20001)?.id, 'playlists::20001')
  total = 5
  revision++
  source.invalidate(revision)
  await settled(source)
  assert.equal(source.state.value.total, 5)
  assert.equal(source.itemAt(4)?.id, 'playlists::4')
  total = 0
  revision++
  source.invalidate(revision)
  await settled(source)
  assert.equal(source.state.value.total, 0)
  assert.deepEqual(source.letterOffsets.value, {})
})

test('real SQL collections retain complete counts/order and match deep summaries for each local classification', async (t) => {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, i) => ({
      id: String(i),
      filePath: `D:/Music/${i}/one.flac`,
      title: `Song ${i}`,
      artist: `Artist ${i}`,
      album: `Album ${i}`,
      genre: `Genre ${i}`,
      duration: 180
    }))
  })
  const source = createLibraryCollectionWindow({
    queryCollections: async (kind, query) => db.queryCollections(kind, query)
  })
  t.after(() => {
    source.dispose()
    db.close()
  })
  for (const kind of ['albums', 'artists', 'genres', 'folders'] as const) {
    const query: LibraryQuery = { sort: 'title', direction: 'desc' }
    source.setQuery(kind, query)
    await settled(source)
    assert.equal(source.state.value.total, 605)
    source.setRange(397, 419)
    await settled(source)
    const expected = db.queryCollections(kind, { ...query, offset: 397, limit: 22 })
    assert.deepEqual(
      Array.from({ length: 22 }, (_, i) => source.itemAt(397 + i)?.id),
      expected.items.map((item) => item.id)
    )
    assert.deepEqual(source.letterOffsets.value, expected.letterOffsets)
    assert.ok(source.pages.value.every((page) => page.items.every((item) => !('tracks' in item))))
  }
})

test('invalid result counts/indexes and oversized windows are rejected without publishing summaries', async (t) => {
  let invalid = page('albums')
  const source = createLibraryCollectionWindow({ queryCollections: async () => invalid }, 2)
  t.after(() => source.dispose())
  for (const patch of [
    { total: -1 },
    { revision: NaN },
    { offset: 1 },
    { letterOffsets: { A: 300000 } }
  ]) {
    invalid = { ...page('albums'), ...patch }
    source.setQuery('albums')
    await settled(source)
    assert.ok(source.state.value.error)
    assert.equal(source.cacheState.cachedPages, 0)
  }
  assert.throws(() => source.setRange(0, 401), /缓存容量/)
})
