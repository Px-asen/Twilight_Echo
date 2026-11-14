import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { LibraryQueueSource, type LibraryQueueApi } from './libraryQueueSource.ts'
import type { LibraryQueuePage, LibraryQueueSnapshot } from '../../../../shared/libraryDatabase.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(t: test.TestContext, count = 600) {
  const db = new LibraryDatabase(':memory:')
  const reads: number[] = []
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: count }, (_, i) => ({
      id: `${i}`,
      title: `Title ${i}`,
      filePath: `C:/Music/${i}.flac`,
      duration: 180
    }))
  })
  const api: LibraryQueueApi = {
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => {
      reads.push(args[1] ?? 0)
      return db.readLibraryQueue(...args)
    },
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args)
  }
  const source = new LibraryQueueSource(api)
  t.after(() => {
    source.dispose()
    db.close()
  })
  return { db, api, source, reads }
}

test('300k queue occurrences expose bounded deep pages, not a global replacement array', async (t) => {
  const f = fixture(t, 5)
  const queue = await f.source.create({})
  f.db.sql
    .prepare(
      `WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<299994)
    INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position) SELECT ?,x+5,'extra-'||x,'0',x+5 FROM n`
    )
    .run(queue!.id)
  f.db.sql.prepare('UPDATE queues SET total_count=300000 WHERE id=?').run(queue!.id)
  await f.source.refresh()
  for (let index = 0; index < 11; index++) {
    const page = await f.source.loadPage(1400 + index)
    assert.equal(page?.items.length, 200)
    assert.equal(page.total, 300_000)
    assert.equal(page.offset, (1400 + index) * 200)
  }
  assert.equal(f.source.state.cachedPages, 4)
  assert.equal(f.source.state.cachedTracks, 800)
  assert.equal(f.source.state.queue?.total, 300_000)
  assert.equal(f.source.state.queue?.index, 0)
  await tick()
  assert.equal(f.source.state.activeReads, 0)
})

test('concurrent user edits serialize CAS, keep duplicate occurrence cursors and invalidate pages', async (t) => {
  const f = fixture(t, 5)
  await f.source.create({ ids: ['0', '1', '0'], sort: 'playlist' })
  const page = (await f.source.loadPage(0))!
  const selected = page.items[2].queueEntryId
  await Promise.all([
    f.source.edit({ kind: 'select', entryId: selected }),
    f.source.edit({ kind: 'insert', afterEntryId: selected, trackIds: ['2'] }),
    f.source.edit({ kind: 'order', order: 'shuffle' })
  ])
  assert.equal(f.source.state.queue?.revision, 3)
  assert.equal(f.source.state.queue?.index, 0)
  assert.equal(f.source.state.queue?.selectedEntryId, selected)
  assert.equal(f.source.state.cachedPages, 0)
  await f.source.edit({ kind: 'order', order: 'original' })
  assert.equal(f.source.state.queue?.index, 2)
  assert.deepEqual(
    (await f.source.loadPage(0))?.items.map((item) => item.track?.id),
    ['0', '1', '0', '2']
  )
  const saved = f.source.state.queue!
  f.source.detach()
  assert.deepEqual(await f.source.restore(saved.id), saved)
  assert.equal(f.source.state.cachedPages, 0)
  assert.equal(await f.source.delete(), true)
  assert.throws(() => f.db.getLibraryQueue(saved.id), /does not exist/)
})

test('live source ownership is registered in SQLite and cleared on detach', async (t) => {
  const f = fixture(t)
  f.api.syncQueueReferences = async (owner, ids) => {
    f.db.syncLibraryQueueReferences(owner, ids)
  }
  const queue = await f.source.create({})
  assert.equal(
    f.db.sql.prepare('SELECT count(*) AS n FROM queue_references WHERE queue_id=?').get(queue!.id)
      ?.n,
    1
  )
  f.source.detach()
  await tick()
  assert.equal(
    f.db.sql.prepare('SELECT count(*) AS n FROM queue_references WHERE queue_id=?').get(queue!.id)
      ?.n,
    0
  )
})

test('a refused delete restores the live owner before exposing the failed source', async (t) => {
  const f = fixture(t)
  f.api.syncQueueReferences = async (owner, ids) => {
    f.db.syncLibraryQueueReferences(owner, ids)
  }
  const queue = await f.source.create({})
  f.db.syncLibraryQueueReferences('workspace', [queue!.id])
  await assert.rejects(f.source.delete(), /still referenced/)
  assert.equal(
    f.db.sql
      .prepare("SELECT count(*) AS n FROM queue_references WHERE owner LIKE 'playback:%' AND queue_id=?")
      .get(queue!.id)?.n,
    1
  )
})

test('playback windows preserve CUE ranges, absolute positions and occurrence IDs across a page boundary', async (t) => {
  const f = fixture(t)
  f.db.patchTracks([
    { id: '199', expectedVersion: 1, patch: { cueRange: { startSeconds: 0, endSeconds: 90 } } },
    { id: '200', expectedVersion: 1, patch: { cueRange: { startSeconds: 90, endSeconds: 180 } } }
  ])
  const queue = await f.source.create({ sort: 'playlist' }, '199')
  const window = await f.source.playbackWindow()
  assert.equal(window?.queue.id, queue?.id)
  assert.deepEqual(
    window?.items.map((item) => item.position),
    [199, 200]
  )
  assert.deepEqual(
    window?.items.map((item) => item.track?.cueRange),
    [
      { startSeconds: 0, endSeconds: 90 },
      { startSeconds: 90, endSeconds: 180 }
    ]
  )
  assert.equal(window?.items[0].queueEntryId, queue?.selectedEntryId)
  assert.deepEqual(f.reads, [0, 200])
  assert.equal((await f.source.playbackWindow({ repeat: true }))?.items.length, 1)
})

test('sequential and wrapped windows differ at EOF, while missing tracks remain frozen holes', async (t) => {
  const f = fixture(t, 5)
  const queue = (await f.source.create({ sort: 'playlist' }, '4'))!
  assert.deepEqual(
    (await f.source.playbackWindow())?.items.map((item) => item.track?.id),
    ['4']
  )
  assert.deepEqual(
    (await f.source.playbackWindow({ wrap: true }))?.items.map((item) => item.track?.id),
    ['4', '0']
  )
  f.db.sql.exec("DELETE FROM tracks WHERE id='1'; DELETE FROM tracks WHERE id='2';")
  await f.source.edit({ kind: 'step', direction: 1, wrap: true })
  assert.equal(f.source.state.queue?.index, 0)
  const window = await f.source.playbackWindow()
  assert.deepEqual(
    window?.items.map((item) => item.position),
    [0, 3]
  )
  assert.equal(window?.queue.total, queue.total)
  assert.equal((await f.source.loadPage(0))?.items[1].track, null)
})

test('long runs of deleted tracks do not trigger an unbounded detail walk before playback', async (t) => {
  const f = fixture(t)
  await f.source.create({ sort: 'playlist' })
  f.db.sql.exec("DELETE FROM tracks WHERE id NOT IN ('0','599')")
  assert.equal((await f.source.playbackWindow())?.items.length, 1)
  assert.deepEqual(f.reads, [0, 200])
  // Navigation uses an indexed SQL lookup rather than hydrating the intervening holes.
  await f.source.edit({ kind: 'step', direction: 1, wrap: false })
  assert.equal(f.source.state.queue?.index, 599)
  assert.equal((await f.source.playbackWindow())?.items[0].track?.id, '599')
})

test('replacement queues cannot bypass the two-read limit or consume stale pages and failures', async (t) => {
  const f = fixture(t)
  const pending: Array<ReturnType<typeof deferred<LibraryQueuePage>>> = []
  f.api.readQueue = () => {
    const task = deferred<LibraryQueuePage>()
    pending.push(task)
    return task.promise
  }
  await f.source.create({})
  const old = [f.source.loadPage(0), f.source.loadPage(1), f.source.loadPage(2)]
  for (let i = 0; i < 20; i++) {
    await f.source.create({})
    old.push(f.source.loadPage(0))
  }
  assert.equal(pending.length, 2)
  assert.equal(f.source.state.activeReads, 2)
  pending[0].reject(new Error('obsolete read failure'))
  await tick()
  assert.equal(pending.length, 3)
  pending[1].reject(new Error('obsolete second failure'))
  pending[2].resolve(f.db.readLibraryQueue(f.source.state.queue!.id))
  const pages = await Promise.all(old)
  assert.equal(pages.filter(Boolean).length, 1)
  assert.equal(f.source.state.cachedPages, 1)
})

test('a superseded create releases only its unexposed queue; detach preserves resumable queues', async (t) => {
  const f = fixture(t),
    pending = deferred<LibraryQueueSnapshot>()
  const originalCreate = f.api.createQueue
  let calls = 0,
    abandoned: LibraryQueueSnapshot | undefined
  f.api.createQueue = async (...args) => {
    calls++
    if (calls > 1) return originalCreate(...args)
    abandoned = await originalCreate(...args)
    return pending.promise
  }
  const first = f.source.create({})
  await tick()
  const second = f.source.create({})
  pending.resolve(abandoned!)
  assert.equal(await first, null)
  assert.throws(() => f.db.getLibraryQueue(abandoned!.id), /does not exist/)
  const queue = await second
  f.source.detach()
  assert.deepEqual(f.db.getLibraryQueue(queue!.id), queue)
})

test('mutations with an unknown outcome are never replayed; queued edits require explicit refresh', async (t) => {
  const f = fixture(t, 5)
  await f.source.create({})
  const edit = f.api.editQueue
  let calls = 0
  f.api.editQueue = async (...args) => {
    calls++
    await edit(...args)
    throw new Error('lost response')
  }
  const results = await Promise.allSettled([
    f.source.edit({ kind: 'step', direction: 1, wrap: false }),
    f.source.edit({ kind: 'clear' })
  ])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'rejected')
  assert.equal(calls, 1)
  assert.equal(f.source.state.requiresRefresh, true)
  await assert.rejects(f.source.loadPage(0), /Refresh/)
  assert.equal((await f.source.refresh())?.index, 1)
  f.api.editQueue = edit
  await f.source.edit({ kind: 'step', direction: 1, wrap: false })
  assert.equal(f.source.state.queue?.index, 2)
})

test('a concurrent owner revision cannot silently mix page order and old cursor', async (t) => {
  const f = fixture(t, 5)
  const queue = (await f.source.create({}))!
  f.db.editLibraryQueue(queue.id, queue.revision, { kind: 'step', direction: 1, wrap: false })
  assert.equal(await f.source.loadPage(0), null)
  assert.equal(f.source.state.requiresRefresh, true)
  await f.source.refresh()
  assert.equal((await f.source.playbackWindow())?.items[0].position, 1)
})

test('library notifications invalidate details without changing queue membership or accepting older results', async (t) => {
  const f = fixture(t, 5)
  await f.source.create({})
  const stale = (await f.source.loadPage(0))!
  f.source.invalidateLibrary(stale.libraryRevision + 1)
  f.api.readQueue = async () => stale
  assert.equal(await f.source.loadPage(0), null)
  assert.equal(f.source.state.cachedPages, 0)
  f.db.patchTracks([{ id: '0', expectedVersion: 1, patch: { title: 'new title' } }])
  f.api.readQueue = async (...args) => f.db.readLibraryQueue(...args)
  assert.equal((await f.source.loadPage(0))?.items[0].track?.title, 'new title')
  assert.equal(f.source.state.queue?.revision, 0)
  assert.equal(f.source.state.queue?.total, 5)
})

test('controls and pending reads are bounded, and disposal does not kill shared database ownership', async (t) => {
  const f = fixture(t),
    pending = deferred<LibraryQueuePage>()
  await f.source.create({})
  f.api.readQueue = () => pending.promise
  const reads = Array.from({ length: 12 }, (_, i) => f.source.loadPage(i))
  await assert.rejects(f.source.loadPage(12), /Too many pending/)
  const control = deferred<LibraryQueueSnapshot>()
  f.api.getQueue = () => control.promise
  const queue = f.source.state.queue!
  const controls = Array.from({ length: 8 }, () => f.source.refresh())
  await assert.rejects(f.source.create({}), /Too many pending/)
  assert.equal(f.source.state.queue?.id, queue.id)
  await tick()
  f.source.dispose()
  control.resolve(queue)
  pending.reject(new Error('old worker failure'))
  assert.ok((await Promise.all(reads)).every((page) => page === null))
  assert.ok((await Promise.all(controls)).every((value) => value === null))
  assert.equal(f.db.getMetadata().trackCount, 600)
  await assert.rejects(f.source.loadPage(0), /disposed/)
})
