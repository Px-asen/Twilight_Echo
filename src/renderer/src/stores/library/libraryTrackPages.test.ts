import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { CoreLibraryPage as LibraryPage } from '../../../../shared/coreViews.ts'
import { coreLibraryPage } from '../coreTestFixtures.ts'
import { projectCoreTrack } from '../../../../core/projections.ts'
import { createLibraryStorageState } from './libraryStorageState.ts'
import { createLibraryTrackPages } from './libraryTrackPages.ts'
import { createLibraryPlaybackController } from '../player/libraryPlaybackController.ts'
import { libraryTrackQuery } from '../../utils/libraryTrackQuery.ts'
import { createDefaultLibraryViewState } from '../../utils/libraryViewPreferences.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import { libraryTrack as privateLibraryTrack } from '../../../../core/playback/libraryTrack.ts'
import { useTrackMultiSelect } from '../../components/song-list/useTrackMultiSelect.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function settled(pages: ReturnType<typeof createLibraryTrackPages>) {
  for (let tries = 0; tries < 50; tries++) {
    if (!pages.state.value.loading) return
    await tick()
  }
  assert.fail('page reader did not settle')
}
function page(query: LibraryQuery = {}, revision = 1, total = 300_000): LibraryPage {
  const offset = query.offset ?? 0
  return {
    offset,
    revision,
    total,
    tracks: Array.from({ length: Math.max(0, Math.min(200, total - offset)) }, (_, i) => ({
      ...projectCoreTrack({
        id: `${query.search ?? 'song'}:${offset + i}`,
        filePath: 'D:/Music/disc.flac'
      })
    })),
    versions: {}
  }
}

test('a new history projection keeps the visible page and total while replacing its cached sort order', async (t) => {
  const calls: LibraryQuery[] = []
  const pages = createLibraryTrackPages({
    queryTracks: async (query) => {
      calls.push(query!)
      return page(query)
    }
  })
  t.after(() => pages.dispose())
  pages.setQuery({ sort: 'lastPlayed', historyRevision: 1 })
  await settled(pages)
  pages.goToPage(20)
  await settled(pages)
  pages.setQuery({ sort: 'lastPlayed', historyRevision: 2 }, true)
  assert.equal(pages.state.value.requestedPage, 20)
  assert.equal(pages.state.value.total, 300_000)
  await settled(pages)
  assert.equal(calls.at(-1)?.offset, 4000)
  assert.equal(calls.at(-1)?.historyRevision, 2)
  assert.equal(pages.cacheState.cachedPages, 1)
})

test('storage discovery rejects invalid modes and failures without falling back to JSON, then retries', async () => {
  let attempts = 0
  const storage = createLibraryStorageState({
    getStorageMode: async () => {
      if (++attempts === 1) throw new Error('worker unavailable')
      if (attempts === 2) return 'other' as never
      return 'sqlite'
    }
  })
  await Promise.all([storage.load(), storage.load()])
  assert.equal(attempts, 1)
  assert.equal(storage.mode.value, null)
  assert.match(storage.error.value, /unavailable/)
  await storage.load()
  assert.equal(storage.mode.value, null)
  assert.match(storage.error.value, /模式无效/)
  await storage.load()
  assert.equal(storage.mode.value, 'sqlite')
  assert.equal(storage.error.value, '')
  await storage.load()
  assert.equal(attempts, 3)
})

test('explicit 200-song pages retain total and stay within the four-page detail bound', async (t) => {
  const calls: LibraryQuery[] = []
  const pages = createLibraryTrackPages({
    queryTracks: async (query) => {
      calls.push(query!)
      return page(query)
    }
  })
  t.after(() => pages.dispose())
  pages.setQuery({ search: 'moon', sort: 'title' })
  await settled(pages)
  assert.equal(pages.state.value.page?.tracks.length, 200)
  assert.equal(pages.state.value.total, 300_000)
  for (let index = 1; index < 15; index++) {
    pages.goToPage(index)
    assert.equal(
      pages.state.value.total,
      300_000,
      'known total must not collapse to one while loading'
    )
    await settled(pages)
    assert.equal(pages.state.value.page?.offset, index * 200)
  }
  assert.equal(pages.cacheState.cachedPages, 4)
  assert.equal(pages.cacheState.cachedTracks, 800)
  assert.ok(calls.every((query) => query.limit === 200))
  pages.goToPage(14)
  await settled(pages)
  assert.equal(calls.length, 15, 'ordinary revisit should use the page cache')
})

test('selection fences distinguish page navigation from content changes, retry and query replacement', async (t) => {
  let revision = 1
  const pages = createLibraryTrackPages({ queryTracks: async (query) => page(query, revision) })
  t.after(() => pages.dispose())
  pages.setQuery({})
  await settled(pages)
  const initial = pages.selectionEpoch.value
  pages.goToPage(1)
  await settled(pages)
  assert.equal(pages.selectionEpoch.value, initial)
  // A newer response can precede its notification; selection must still expire.
  revision = 2
  pages.goToPage(2)
  await settled(pages)
  assert.ok(pages.selectionEpoch.value > initial)
  const updated = pages.selectionEpoch.value
  pages.invalidate(1)
  pages.invalidate(2)
  assert.equal(pages.selectionEpoch.value, updated)
  pages.retry()
  assert.ok(pages.selectionEpoch.value > updated)
  await settled(pages)
  const retried = pages.selectionEpoch.value
  pages.invalidate()
  assert.ok(pages.selectionEpoch.value > retried)
  await settled(pages)
  const invalidated = pages.selectionEpoch.value
  pages.setQuery({ search: 'different' })
  assert.ok(pages.selectionEpoch.value > invalidated)
  await settled(pages)
})

test('selected compact rows survive four-page cache eviction, while unselected page traversal retains no action records', async (t) => {
  let revision = 1
  const pages = createLibraryTrackPages({
    queryTracks: async (query) => page(query, revision)
  })
  const scope = effectScope()
  const tracks = computed(() => (pages.state.value.page?.tracks ?? []).map(libraryTrack))
  const multi = scope.run(() =>
    useTrackMultiSelect({
      tracks,
      preserveSelectedTracks: () => true,
      snapshotTrack: (track) => ({ ...track }),
      selectionOrder: (_track, index) => (pages.state.value.page?.offset ?? 0) + index,
      resetSources: [pages.selectionEpoch],
      rangeContext: () => pages.state.value.requestedPage
    })
  )!
  t.after(() => {
    scope.stop()
    pages.dispose()
  })
  pages.setQuery({})
  await settled(pages)
  multi.toggle('song:0', 0)
  for (let index = 1; index < 15; index++) {
    pages.goToPage(index)
    await settled(pages)
  }
  assert.equal(pages.cacheState.cachedTracks, 800)
  assert.deepEqual(multi.getSelectedTrackIds(), ['song:0'])
  const selected = multi.getSelectedTracks()[0]
  assert.equal(selected.lyrics, undefined)
  assert.equal((selected as unknown as Record<string, unknown>).custom, undefined)
  multi.toggle('song:2801', 1)
  assert.deepEqual(
    multi.getSelectedTracks().map((track) => track.id),
    ['song:0', 'song:2801']
  )
  revision++
  pages.goToPage(15) // New revision without a prior event also expires off-page rows.
  await settled(pages)
  assert.equal(multi.selectedCount.value, 0)
})

test('rapid pages and searches share two transport slots and skip obsolete waiting demands', async (t) => {
  const pending: {
    query: LibraryQuery
    resolve(page: LibraryPage): void
    reject(error: Error): void
  }[] = []
  const pages = createLibraryTrackPages({
    queryTracks: (query) =>
      new Promise((resolve, reject) => {
        pending.push({ query: query!, resolve, reject })
      })
  })
  t.after(() => pages.dispose())
  pages.setQuery({ search: 'old' })
  pages.goToPage(1)
  for (let i = 0; i < 100; i++) {
    pages.setQuery({ search: `new-${i}` })
    pages.goToPage(i)
  }
  assert.equal(pending.length, 2)
  pending[0].resolve(page(pending[0].query))
  await tick()
  assert.equal(pending.length, 3)
  assert.equal(pending[2].query.search, 'new-99')
  assert.equal(pending[2].query.offset, 99 * 200)
  pending[1].reject(new Error('old failure'))
  pending[2].resolve(page(pending[2].query, 9))
  await settled(pages)
  assert.equal(pages.state.value.page?.revision, 9)
  assert.equal(pages.state.value.page?.tracks[0].id, 'new-99:19800')
  assert.equal(pages.state.value.error, '')
})

test('read failures are not empty results, retry is explicit, and older notifications do not reread', async (t) => {
  let fail = true,
    calls = 0
  const pages = createLibraryTrackPages({
    queryTracks: async (query) => {
      calls++
      if (fail) throw new Error('disk unavailable')
      return page(query, 7)
    }
  })
  t.after(() => pages.dispose())
  pages.setQuery({})
  await settled(pages)
  assert.equal(pages.state.value.page, null)
  assert.equal(pages.state.value.total, null)
  assert.match(pages.state.value.error, /disk unavailable/)
  fail = false
  pages.retry()
  await settled(pages)
  assert.equal(pages.state.value.error, '')
  pages.invalidate(6)
  pages.invalidate(7)
  await tick()
  assert.equal(calls, 2)
  pages.invalidate(8)
  await settled(pages)
  assert.equal(pages.state.value.page, null, 'a reply below the advertised revision is stale')
  assert.match(pages.state.value.error, /读取期间发生变化/)
})

test('shrinking or clearing a library on a deep page clamps to a real page, including zero tracks', async (t) => {
  let total = 605,
    revision = 1
  const pages = createLibraryTrackPages({
    queryTracks: async (query) => page(query, revision, total)
  })
  t.after(() => pages.dispose())
  pages.setQuery({})
  await settled(pages)
  pages.goToPage(3)
  await settled(pages)
  assert.equal(pages.state.value.page?.tracks.length, 5)
  total = 5
  revision++
  pages.invalidate(revision)
  await settled(pages)
  assert.equal(pages.state.value.page?.offset, 0)
  assert.equal(pages.state.value.page?.tracks.length, 5)
  total = 605
  revision++
  pages.invalidate(revision)
  await settled(pages)
  pages.goToPage(3)
  await settled(pages)
  total = 0
  revision++
  pages.invalidate(revision)
  await settled(pages)
  assert.equal(pages.state.value.requestedPage, 0)
  assert.equal(pages.state.value.page?.total, 0)
  assert.equal(pages.state.value.error, '')
})

function databaseFixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, i) => ({
      id: String(i),
      filePath: `D:/Music/${i}.flac`,
      title: `月光 ${String(i).padStart(4, '0')}`,
      artist: '周杰伦',
      album: '合辑',
      duration: i,
      sampleRate: 48000,
      bitDepth: 24,
      format: 'flac',
      custom: { keep: true },
      ...(i === 420 ? { cueRange: { startSeconds: 10, endSeconds: 20 } } : {})
    }))
  })
  const queries: LibraryQuery[] = []
  const pages = createLibraryTrackPages({
    queryTracks: async (query = {}) => {
      queries.push(query)
      return coreLibraryPage(db.queryTracks(query))
    }
  })
  t.after(() => {
    pages.dispose()
    db.close()
  })
  return { db, pages, queries }
}

test('locate uses authoritative complete query order beyond unloaded pages and does not make an anchor sticky', async (t) => {
  const { db, pages, queries } = databaseFixture(t)
  pages.setQuery({ sort: 'duration', direction: 'desc', search: 'zjl' })
  await settled(pages)
  assert.equal(
    pages.state.value.page?.tracks.some((track) => track.id === '20'),
    false
  )
  pages.locate('20')
  await settled(pages)
  assert.equal(pages.state.value.page?.anchorIndex, 584)
  assert.equal(pages.state.value.page?.offset, 400)
  assert.equal(pages.state.value.page?.total, 605)
  assert.equal(queries.at(-1)?.anchorId, '20')
  assert.equal(pages.state.value.requestedPage, 2)
  pages.goToPage(2)
  await settled(pages)
  assert.equal(pages.state.value.page?.anchorIndex, undefined)
  assert.equal(queries.length, 2)
  pages.locate('not-in-result')
  await settled(pages)
  assert.equal(pages.state.value.page?.anchorIndex, -1)
  assert.equal(
    pages.state.value.page?.offset,
    400,
    'missing anchor must not jump back to page zero'
  )
  assert.match(pages.state.value.error, /不在此查询结果/)
  const ascending = db.queryTracks({ sort: 'title', anchorId: '420' })
  assert.equal(ascending.anchorIndex, 420)
  assert.equal(ascending.offset, 400)
  assert.equal(
    ascending.tracks[20].custom && (ascending.tracks[20].custom as { keep: boolean }).keep,
    true
  )
})

test('view preferences and a page action freeze all matching IDs, not just the current page', async (t) => {
  const { db, pages } = databaseFixture(t)
  const view = createDefaultLibraryViewState()
  view.sortKey = 'duration'
  view.sortDirection = 'desc'
  view.filters = {
    ...view.filters,
    lossless: true,
    sampleRate: 48000,
    bitDepth: 24,
    provider: 'local'
  }
  const query = libraryTrackQuery(view, '  zjl  ')
  pages.setQuery(query)
  await settled(pages)
  pages.goToPage(2)
  await settled(pages)
  assert.equal(pages.state.value.page?.tracks.length, 200)
  const player = createLibraryPlaybackController({
    createQueue: async (...args) => db.createLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  })
  t.after(() => player.dispose())
  await player.create(query, '199', 'sequential')
  assert.equal(player.snapshot.value?.total, 605)
  assert.equal(player.track()?.id, '199')
  assert.equal(player.reference()?.index, 405)
  const ref = player.reference()!
  db.patchTracks([
    {
      id: '199',
      expectedVersion: db.getTracksByIds(['199']).versions['199'],
      patch: { duration: 1000 }
    }
  ])
  assert.equal(
    db.readLibraryQueue(ref.id, 405, 1).items[0].track?.id,
    '199',
    'playback order is frozen after a sort-key edit'
  )
})

test('query changes or disposal fence successful late reads and preserve the last safe state', async () => {
  let resolve!: (page: LibraryPage) => void
  const pages = createLibraryTrackPages({
    queryTracks: () =>
      new Promise((done) => {
        resolve = done
      })
  })
  pages.setQuery({})
  const state = pages.state.value
  pages.dispose()
  resolve(page())
  await tick()
  assert.equal(pages.state.value, state)
  assert.equal(pages.cacheState.cachedTracks, 0)
})

test('legacy display defaults preserve CUE and extension data but never inherit a queue occurrence', () => {
  const track = privateLibraryTrack({
    id: 'cue',
    filePath: 'D:/disc.flac',
    queueEntryId: 'old',
    cueRange: { startSeconds: 30, endSeconds: 40, pregapSeconds: 0 },
    custom: { keep: true }
  })
  assert.equal(track.title, 'disc.flac')
  assert.equal(track.artist, '未知艺术家')
  assert.equal(track.duration, 0)
  assert.equal(track.queueEntryId, undefined)
  assert.equal(track.cueRange?.startSeconds, 30)
  assert.deepEqual((track as unknown as { custom: unknown }).custom, { keep: true })
})
