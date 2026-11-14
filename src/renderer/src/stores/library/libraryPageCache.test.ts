import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryPageCache } from './libraryPageCache.ts'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { CoreLibraryPage as LibraryPage } from '../../../../shared/coreViews.ts'
import { projectCoreTrack } from '../../../../core/projections.ts'

const result = (query: LibraryQuery, revision = 1): LibraryPage => ({
  tracks: Array.from({ length: 200 }, (_, i) => ({
    ...projectCoreTrack({ id: `${query.offset}:${i}`, filePath: 'audio.flac' })
  })),
  offset: query.offset ?? 0,
  total: 300_000,
  revision,
  versions: {}
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('page detail cache stays at four pages and evicts least recently used details', async () => {
  let calls = 0
  const cache = new LibraryPageCache({
    queryTracks: async (query) => {
      calls++
      return result(query ?? {})
    }
  })
  for (let page = 0; page < 4; page++) await cache.load(page)
  await cache.load(0)
  await cache.load(4)
  assert.equal(cache.state.cachedPages, 4)
  assert.equal(cache.state.cachedTracks, 800)
  assert.equal(cache.peek(1), undefined)
  assert.ok(cache.peek(0))
  assert.ok(cache.peek(4))
  assert.equal(calls, 5)
  cache.dispose()
})

test('old searches, old failures and old revisions cannot replace the current query', async () => {
  const pending: Array<{
    query: LibraryQuery
    resolve(value: LibraryPage): void
    reject(error: Error): void
  }> = []
  const cache = new LibraryPageCache({
    queryTracks: (query) =>
      new Promise((resolve, reject) => pending.push({ query: query ?? {}, resolve, reject }))
  })
  cache.setQuery({ search: 'old' })
  const old = cache.load(0)
  cache.setQuery({ search: 'new' })
  const next = cache.load(0)
  pending[1].resolve(result(pending[1].query, 4))
  await next
  pending[0].reject(new Error('old failure'))
  assert.equal(await old, null)
  assert.equal(cache.state.revision, 4)
  assert.equal(cache.state.cachedPages, 1)
  cache.invalidate(5)
  const stale = cache.load(0)
  pending[2].resolve(result(pending[2].query, 4))
  assert.equal(await stale, null)
  assert.equal(cache.state.cachedPages, 0)
  cache.dispose()
})

test('rapid search changes keep at most two transport requests and eventually load the latest search', async () => {
  const pending: Array<{ query: LibraryQuery; resolve(value: LibraryPage): void }> = []
  const cache = new LibraryPageCache({
    queryTracks: (query) => new Promise((resolve) => pending.push({ query: query ?? {}, resolve }))
  })
  const old = [cache.load(0), cache.load(1)]
  for (let index = 0; index < 20; index++) {
    cache.setQuery({ search: `${index}` })
    old.push(cache.load(0))
  }
  assert.equal(pending.length, 2)
  assert.equal(cache.state.activeRequests, 2)
  pending[0].resolve(result(pending[0].query))
  await tick()
  assert.equal(pending.length, 3)
  assert.equal(pending[2].query.search, '19')
  pending[1].resolve(result(pending[1].query))
  pending[2].resolve(result(pending[2].query, 5))
  const values = await Promise.all(old)
  assert.equal(values.filter(Boolean).length, 1)
  assert.equal(cache.state.revision, 5)
  cache.dispose()
})

test('concurrent pages from different library revisions are never retained together', async () => {
  const pending: Array<(value: LibraryPage) => void> = []
  const cache = new LibraryPageCache({
    queryTracks: () => new Promise((resolve) => pending.push(resolve))
  })
  const one = cache.load(0),
    two = cache.load(1)
  pending[0](result({ offset: 0 }, 1))
  await one
  pending[1](result({ offset: 200 }, 2))
  await two
  assert.equal(cache.peek(0), undefined)
  assert.equal(cache.peek(1)?.revision, 2)
  cache.dispose()
})

test('playlist pages require complete unique occurrence identities, not unique Track IDs', async () => {
  let entries: string[] | undefined
  const cache = new LibraryPageCache({
    queryTracks: async () => ({
      tracks: [
        projectCoreTrack({ id: 'one', filePath: '' }),
        projectCoreTrack({ id: 'one', filePath: '' })
      ],
      entryIds: entries,
      total: 2,
      offset: 0,
      revision: 1,
      versions: {}
    })
  })
  cache.setQuery({ playlistView: 'view' })
  for (const invalid of [undefined, ['0'], ['0', '0'], ['0', '-1'], ['0', '1.5']]) {
    entries = invalid
    await assert.rejects(cache.load(0), /invalid library page/)
    assert.equal(cache.state.cachedPages, 0)
  }
  entries = ['0', '5']
  assert.deepEqual((await cache.load(0))?.entryIds, entries)
  cache.dispose()
})

test('pending page queue stays bounded at ten waiting reads while allowing custom cache capacities up to ten', async () => {
  assert.throws(
    () => new LibraryPageCache({ queryTracks: async () => result({}) }, 11),
    /Invalid library page cache capacity/
  )
  const custom = new LibraryPageCache({ queryTracks: async (query) => result(query ?? {}) }, 9)
  assert.equal(custom.pageCapacity, 9)
  custom.dispose()

  const pending: Array<{ query: LibraryQuery; resolve(value: LibraryPage): void }> = []
  const cache = new LibraryPageCache({
    queryTracks: (query) => new Promise((resolve) => pending.push({ query: query ?? {}, resolve }))
  })
  const reads = Array.from({ length: 12 }, (_, i) => cache.load(i))
  assert.equal(pending.length, 2)
  assert.equal(cache.state.activeRequests, 2)
  await assert.rejects(cache.load(12), /Too many pending library pages/)
  cache.dispose()
  for (const item of pending) item.resolve(result(item.query))
  assert.ok((await Promise.all(reads)).every((page) => page === null))
})
