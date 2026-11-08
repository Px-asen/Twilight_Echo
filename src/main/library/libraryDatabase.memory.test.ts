import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const database = new LibraryDatabase(':memory:')
  t.after(() => database.close())
  database.replaceDocument({
    version: 2,
    revision: 1,
    folders: ['C:/music'],
    exclusions: [],
    tracks: Array.from({ length: 1000 }, (_, index) => ({
      id: `track-${index}`,
      filePath: `C:/music/${index}.flac`,
      fileName: `${index}.flac`,
      title: `Title ${1000 - index}`,
      artist: `Artist ${index % 20}`,
      album: `Album ${index % 100}`,
      duration: 180,
      addedAt: index
    }))
  })
  const caches = database as unknown as {
    ordered: Map<string, string[]>
    totals: Map<string, unknown>
    statements: Map<string, unknown>
  }
  return { database, caches }
}

test('idle library browsing releases complete sort orders while playback reads keep working', (t) => {
  const { database, caches } = fixture(t)
  const page = database.queryTracks({ sort: 'title', limit: 20 })
  database.queryTracks({ sort: 'artist', limit: 20 })
  database.queryTracks({ sort: 'album', limit: 20 })
  const queue = database.createLibraryQueue({ sort: 'title' })
  const queuePage = database.readLibraryQueue(queue.id)
  const metadata = database.getMetadata()
  assert.equal(caches.ordered.size, 3)
  assert.ok(caches.totals.size > 0)
  const exec = t.mock.method(database.sql, 'exec')
  t.mock.timers.tick(89_000)
  // Normal playback uses queue pages, track hydration and metadata reads.
  // These must not keep a closed library browser's large sorting cache alive.
  assert.deepEqual(database.readLibraryQueue(queue.id), queuePage)
  assert.deepEqual(database.getMetadata(), metadata)
  assert.equal(database.getTracksByIds(['track-0']).tracks[0].id, 'track-0')
  assert.equal(caches.ordered.size, 3)
  t.mock.timers.tick(1_000)
  assert.equal(caches.ordered.size, 0)
  assert.equal(caches.totals.size, 0)
  assert.equal(caches.statements.size, 0)
  assert.ok(exec.mock.calls.some((call) => call.arguments[0] === 'PRAGMA shrink_memory'))
  assert.deepEqual(database.queryTracks({ sort: 'title', limit: 20 }), page)
  assert.deepEqual(database.readLibraryQueue(queue.id), queuePage)
  assert.deepEqual(database.getMetadata(), metadata)
})

test('active paging refreshes the idle deadline and close cancels pending release', (t) => {
  const { database, caches } = fixture(t)
  database.queryTracks({ sort: 'title', limit: 20 })
  t.mock.timers.tick(60_000)
  database.queryTracks({ sort: 'title', offset: 20, limit: 20 })
  t.mock.timers.tick(60_000)
  assert.equal(caches.ordered.size, 1)
  t.mock.timers.tick(30_000)
  assert.equal(caches.ordered.size, 0)
  database.queryTracks({ sort: 'title', limit: 20 })
  database.close()
  assert.equal(caches.ordered.size, 0)
  assert.doesNotThrow(() => t.mock.timers.tick(90_000))
})
