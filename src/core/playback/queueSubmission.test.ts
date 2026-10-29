import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { buildLibraryQueuePages } from './libraryQueueBuild.ts'
import { CoreQueueSubmission } from './queueSubmission.ts'
import { createQueueInputResolver } from './queueInputResolver.ts'
import type { LibraryQueueSnapshot } from '../../shared/libraryDatabase.ts'
import type { CoreQueueTrackInput } from '../../shared/coreQueueSubmission.ts'
import type { CorePlaybackSession } from './session.ts'

const provider = (id: number): CoreQueueTrackInput => ({
  kind: 'provider',
  track: {
    id: `ncm:${id}`,
    source: 'ncm',
    ncmSongId: id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    duration: 60
  }
})
function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'cue',
        filePath: 'D:/Music/disc.flac',
        title: 'CUE',
        cueRange: { startSeconds: 30, endSeconds: 60 }
      }
    ]
  })
  let serial = 0,
    commits = 0,
    selectedPosition = 0
  let queue: LibraryQueueSnapshot | null = null
  const timers = new Set<() => void>()
  const batches: number[] = []
  const service = new CoreQueueSubmission({
    newId: () => `submission-${++serial}`,
    schedule: (callback) => {
      timers.add(callback)
      return () => {
        timers.delete(callback)
      }
    },
    resolve: createQueueInputResolver({
      database: {
        getTracksByIds: async (ids) => db.getTracksByIds(ids),
        readLibraryQueue: async (...args) => db.readLibraryQueue(...args)
      },
      authorizeLocal: async (source) => {
        if (source.startsWith('denied:')) throw new Error('Access denied')
        return source
      },
      providers: () => new Set(['ncm']),
      streams: () => new Map(),
      resolveProviderCovers: async (covers) =>
        Object.fromEntries(
          covers.map((handle) => [
            handle,
            handle === 'twilight-media://image/granted_cover'
              ? { cover: null, coverSource: 'https://p2.music.126.net/cover.jpg' }
              : handle.startsWith('cover://')
                ? { cover: handle, coverSource: null }
                : { cover: null, coverSource: null }
          ])
        ),
      network: async () => {
        throw new Error('Not indexed')
      }
    }),
    playback: {
      snapshot: () => ({ queue }) as ReturnType<CorePlaybackSession['snapshot']>,
      edit: async (id, revision, edit) => {
        queue = (edit.kind === 'insert'
          ? db.insertCorePlaybackQueue(id, revision, edit)
          : db.editLibraryQueue(id, revision, edit)).queue
      },
      fromPages: async (produce, options = {}, signal) => {
        const ready = await buildLibraryQueuePages(
          {
            buildQueue: async (command) => {
              if (command.kind === 'append') batches.push(command.items.length)
              return db.buildLibraryQueue(command)
            },
            deleteQueue: async (...args) => {
              db.deleteLibraryQueue(...args)
            }
          },
          produce,
          {
            contentRevision: db.getMetadata().revision,
            order: 'original',
            selectedIndex: options.selectedIndex
          },
          { signal }
        )
        queue = ready
        selectedPosition = options.position ?? 0
        commits++
      }
    }
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
  })
  return { db, service, batches, timers, state: () => ({ queue, commits, selectedPosition }) }
}

test('mixed submissions keep bounded SQL pages, duplicate occurrence identity and canonical CUE fields', async (t) => {
  const f = fixture(t)
  const start = await f.service.submit('window', { kind: 'begin', selectedIndex: 202, position: 9 })
  for (let batch = 0; batch < 3; batch++)
    await f.service.submit('window', {
      kind: 'append',
      id: start.id,
      sequence: batch + 1,
      items: Array.from({ length: 200 }, (_, i) =>
        i % 2 ? provider(7) : { kind: 'local', id: 'cue' }
      )
    })
  assert.equal(f.state().queue, null)
  assert.deepEqual(f.batches, [200, 200, 200])
  const result = await f.service.submit('window', { kind: 'commit', id: start.id, sequence: 4 })
  assert.equal(result.total, 600)
  const queue = f.state().queue!
  assert.equal(queue.index, 202)
  assert.equal(f.state().selectedPosition, 9)
  const page = f.db.readLibraryQueue(queue.id, 200, 200)
  assert.equal(new Set(page.items.map((item) => item.queueEntryId)).size, 200)
  assert.deepEqual(page.items[2].track?.cueRange, { startSeconds: 30, endSeconds: 60 })
  assert.equal(page.items[3].track?.filePath, '')
  await assert.rejects(
    f.service.submit('window', { kind: 'commit', id: start.id, sequence: 4 }),
    /已结束/
  )
  assert.equal(f.state().commits, 1)
})

test('client leases reject cross-window use and old batches without replay, detach discards unpublished work', async (t) => {
  const f = fixture(t)
  const { id } = await f.service.submit('one', { kind: 'begin', selectedIndex: 0 })
  await assert.rejects(
    f.service.submit('two', { kind: 'append', id, sequence: 1, items: [provider(1)] }),
    /已结束/
  )
  await f.service.submit('one', { kind: 'append', id, sequence: 1, items: [provider(1)] })
  await assert.rejects(
    f.service.submit('one', { kind: 'append', id, sequence: 1, items: [provider(1)] }),
    /不可重放/
  )
  await f.service.disconnect('one')
  assert.equal(f.state().commits, 0)
  assert.equal(f.db.sql.prepare("SELECT count(*) AS n FROM queues WHERE state IN ('ready','building')").get()!.n, 0)
  assert.equal(f.timers.size, 0)
})

test('temporary file grants and CUE ranges are preserved; a denied file aborts rather than using UI paths', async (t) => {
  const f = fixture(t)
  const fallback = {
    filePath: 'D:/Opened/disc.flac',
    title: 'Opened',
    artist: '',
    album: '',
    duration: 10,
    cueRange: { startSeconds: 5, endSeconds: 15, pregapSeconds: 0 }
  }
  const { id } = await f.service.submit('one', { kind: 'begin', selectedIndex: 0, play: false })
  await f.service.submit('one', {
    kind: 'append',
    id,
    sequence: 1,
    items: [{ kind: 'local', id: 'temporary', fallback }]
  })
  await f.service.submit('one', { kind: 'commit', id, sequence: 2 })
  assert.deepEqual(
    f.db.readLibraryQueue(f.state().queue!.id).items[0].track?.cueRange,
    fallback.cueRange
  )
  const next = await f.service.submit('one', { kind: 'begin', selectedIndex: 0 })
  await assert.rejects(
    f.service.submit('one', {
      kind: 'append',
      id: next.id,
      sequence: 1,
      items: [
        { kind: 'local', id: 'denied', fallback: { ...fallback, filePath: 'denied:private' } }
      ]
    }),
    /Access denied/
  )
  assert.equal(f.state().commits, 1)
})

test('committed submission survives client disconnection and idle unpublished submission expires', async (t) => {
  const f = fixture(t)
  const { id } = await f.service.submit('one', { kind: 'begin', selectedIndex: 0 })
  await f.service.submit('one', { kind: 'append', id, sequence: 1, items: [provider(1)] })
  const committing = f.service.submit('one', { kind: 'commit', id, sequence: 2 })
  await f.service.disconnect('one')
  await committing
  assert.equal(f.state().commits, 1)
  const next = await f.service.submit('one', { kind: 'begin', selectedIndex: 0 })
  for (const expire of f.timers) expire()
  await f.service.disconnect('one')
  await assert.rejects(
    f.service.submit('one', { kind: 'commit', id: next.id, sequence: 1 }),
    /已结束/
  )
  assert.equal(f.state().commits, 1)
})

test('database undo availability follows its durable history revision and navigation retains the existing invalidation rule', (t) => {
  const f = fixture(t)
  let queue = f.db.createLibraryQueue({})
  assert.equal(queue.canUndo, false)
  queue = f.db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'insert',
    trackIds: ['cue']
  }).queue
  assert.equal(queue.canUndo, true)
  assert.equal(queue.undoLabel, '添加歌曲')
  queue = f.db.editLibraryQueue(queue.id, queue.revision, { kind: 'undo' }).queue
  assert.equal(queue.canUndo, false)
  assert.equal(queue.total, 1)
  queue = f.db.editLibraryQueue(queue.id, queue.revision, { kind: 'insert', trackIds: ['cue'] }).queue
  const entry = f.db.readLibraryQueue(queue.id).items[1].queueEntryId
  queue = f.db.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId: entry }).queue
  assert.equal(queue.canUndo, false)
})

test('existing occurrences copy private source identity without accepting a renderer URL and each insert remains undoable', async (t) => {
  const f = fixture(t)
  const start = await f.service.submit('window', { kind: 'begin', selectedIndex: 0 })
  await f.service.submit('window', { kind: 'append', id: start.id, sequence: 1, items: [{ kind: 'local', id: 'cue' }, provider(7)] })
  await f.service.submit('window', { kind: 'commit', id: start.id, sequence: 2 })
  const before = f.state().queue!
  const original = f.db.readLibraryQueue(before.id).items[0]
  const inserted = await f.service.insert({ id: before.id, revision: before.revision, items: [
    { kind: 'occurrence', queueId: before.id, revision: before.revision, occurrenceId: original.queueEntryId },
    provider(7)
  ] }, new AbortController().signal)
  assert.equal(inserted?.canUndo, true)
  const page = f.db.readLibraryQueue(before.id)
  assert.equal(page.total, 4)
  assert.notEqual(page.items[2].queueEntryId, original.queueEntryId)
  assert.deepEqual(page.items[2].track?.cueRange, original.track?.cueRange)
  assert.equal(page.items[3].track?.source, 'ncm')
  assert.equal(page.items[3].track?.filePath, '')
  await assert.rejects(f.service.insert({ id: before.id, revision: before.revision, items: [
    { kind: 'occurrence', queueId: before.id, revision: before.revision, occurrenceId: original.queueEntryId }
  ] }, new AbortController().signal), /changed concurrently/)
  assert.equal(f.db.readLibraryQueue(before.id).total, 4)
  const undone = f.db.editLibraryQueue(before.id, f.state().queue!.revision, { kind: 'undo' })
  assert.equal(undone.queue.total, 2)
})

test('provider queue submissions persist durable coverSource in SQLite snapshots and degrade expired image grants cleanly', async (t) => {
  const f = fixture(t)
  const start = await f.service.submit('window', { kind: 'begin', selectedIndex: 0 })
  await f.service.submit('window', {
    kind: 'append',
    id: start.id,
    sequence: 1,
    items: [
      {
        kind: 'provider',
        track: {
          id: 'ncm:101',
          source: 'ncm',
          ncmSongId: 101,
          title: 'Is this love?',
          artist: 'twenty4-7',
          album: 'Letter',
          duration: 277,
          cover: 'twilight-media://image/granted_cover'
        }
      },
      {
        kind: 'provider',
        track: {
          id: 'ncm:102',
          source: 'ncm',
          ncmSongId: 102,
          title: 'Expired Token Song',
          artist: 'Artist',
          album: 'Album',
          duration: 200,
          cover: 'twilight-media://image/expired_cover'
        }
      }
    ]
  })
  await f.service.submit('window', { kind: 'commit', id: start.id, sequence: 2 })
  const page = f.db.readLibraryQueue(f.state().queue!.id)
  assert.equal(page.items[0].track?.cover, null)
  assert.equal(page.items[0].track?.coverSource, 'https://p2.music.126.net/cover.jpg')
  assert.equal(page.items[1].track?.cover, null)
  assert.equal(page.items[1].track?.coverSource, undefined)
})
