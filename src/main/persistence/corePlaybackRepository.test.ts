import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { createPlaybackSessionStoreBundle } from './playbackSessionRepository.ts'
import { createCorePlaybackRepository } from './corePlaybackRepository.ts'
import { libraryQueueTrack } from '../../core/playback/libraryTrack.ts'

test('persisted Zone owners never replace another session queue reference', async t => {
  const root = mkdtempSync(join(tmpdir(), 'core-zone-repository-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [{ id: 'one', filePath: 'D:/one.flac' }] })
  const repositories = ['core:persisted-playback', 'zone:a:persisted', 'zone:b:persisted'].map((owner, i) =>
    createCorePlaybackRepository(createPlaybackSessionStoreBundle(join(root, String(i))), {
      syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
    }, owner))
  const ids: string[] = []
  for (const repository of repositories) {
    const queue = db.createLibraryQueue({}); ids.push(queue.id)
    const row = db.readLibraryQueue(queue.id).items[0]
    await repository.save({ version: 1, savedAt: new Date().toISOString(), mode: 'trackAndPosition', position: 0,
      track: libraryQueueTrack(row.track!, row.queueEntryId), libraryQueue: { id: queue.id, revision: queue.revision, index: queue.index, entryId: queue.selectedEntryId! } }, 0)
  }
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(db.collectLibraryQueueGarbage(1), 0)
  assert.ok(ids.every(id => db.getLibraryQueue(id).total === 1))
  assert.deepEqual((await Promise.all(repositories.map(r => r.load()))).map(r => r?.data?.libraryQueue?.id), ids)
})

test('current and last-good playback files retain their SQL queues across owner disposal and GC', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-session-repository-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: 'D:/one.flac' }]
  })
  const bundle = createPlaybackSessionStoreBundle(root)
  const repository = createCorePlaybackRepository(bundle, {
    syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
  })
  let revision = 0
  const queues: string[] = []
  for (let i = 0; i < 3; i++) {
    const queue = db.createLibraryQueue({})
    queues.push(queue.id)
    const row = db.readLibraryQueue(queue.id).items[0]
    const saved = await repository.save(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        mode: 'trackAndPosition',
        position: 12,
        track: libraryQueueTrack(row.track!, row.queueEntryId),
        libraryQueue: {
          id: queue.id,
          revision: queue.revision,
          index: queue.index,
          entryId: queue.selectedEntryId!
        }
      },
      revision
    )
    revision = saved.revision
  }
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(db.collectLibraryQueueGarbage(1), 1)
  assert.throws(() => db.getLibraryQueue(queues[0]), /does not exist/)
  assert.equal(db.getLibraryQueue(queues[1]).total, 1)
  assert.equal(db.getLibraryQueue(queues[2]).total, 1)
  assert.equal((await repository.load())?.data?.libraryQueue?.id, queues[2])
  assert.equal((await bundle.sessionStore.loadBackup())?.data?.libraryQueue?.id, queues[1])
})

test('both active and last-good heart sessions protect their base queue from reference-aware GC', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-heart-repository-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: 'D:/one.flac' }]
  })
  const repository = createCorePlaybackRepository(createPlaybackSessionStoreBundle(root), {
    syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
  })
  const base = db.createLibraryQueue({}),
    heart = db.createLibraryQueue({})
  const reference = (queue: typeof base) => ({
    id: queue.id,
    revision: queue.revision,
    index: queue.index,
    entryId: queue.selectedEntryId!
  })
  const row = db.readLibraryQueue(heart.id).items[0]
  let revision = (
    await repository.save(
      {
        version: 1,
        savedAt: '',
        mode: 'trackAndPosition',
        playMode: 'heart',
        position: 10,
        track: libraryQueueTrack(row.track!, row.queueEntryId),
        libraryQueue: reference(heart),
        heart: { queueId: heart.id, likedPlaylistId: 123, baseQueue: reference(base) }
      },
      0
    )
  ).revision
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(db.collectLibraryQueueGarbage(1), 0)
  assert.equal(db.getLibraryQueue(base.id).total, 1)
  for (let i = 0; i < 2; i++) {
    const queue = db.createLibraryQueue({}),
      entry = db.readLibraryQueue(queue.id).items[0]
    revision = (
      await repository.save(
        {
          version: 1,
          savedAt: '',
          mode: 'track',
          position: 0,
          track: libraryQueueTrack(entry.track!, entry.queueEntryId),
          libraryQueue: reference(queue)
        },
        revision
      )
    ).revision
    db.sql.exec('UPDATE queues SET created_at=0')
    db.collectLibraryQueueGarbage(1)
    if (i === 0) assert.equal(db.getLibraryQueue(base.id).total, 1)
    else assert.throws(() => db.getLibraryQueue(base.id), /does not exist/)
  }
})


test('saved playback tracks without filePath load cleanly and retain their SQL queue reference', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-no-filepath-repository-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: 'D:/one.flac' }]
  })
  const bundle = createPlaybackSessionStoreBundle(root)
  const repository = createCorePlaybackRepository(bundle, {
    syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
  })
  const queue = db.createLibraryQueue({})
  await bundle.sessionStore.save(
    {
      version: 1,
      savedAt: new Date().toISOString(),
      mode: 'trackAndPosition',
      position: 18,
      track: {
        id: 'ncm:42',
        source: 'ncm',
        title: 'Online Song',
        artist: 'Artist',
        album: 'Album',
        duration: 180,
        queueEntryId: queue.selectedEntryId!
      } as any,
      libraryQueue: {
        id: queue.id,
        revision: queue.revision,
        index: queue.index,
        entryId: queue.selectedEntryId!
      }
    },
    0
  )
  const loaded = await repository.load()
  assert.equal(loaded?.data?.track.id, 'ncm:42')
  assert.equal(loaded?.data?.track.filePath, '')
  assert.equal(loaded?.data?.libraryQueue?.id, queue.id)
})
