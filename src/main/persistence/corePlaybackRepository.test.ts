import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { createPlaybackSessionStoreBundle } from './playbackSessionRepository.ts'
import { createCorePlaybackRepository } from './corePlaybackRepository.ts'
import { libraryQueueTrack } from '../../core/playback/libraryTrack.ts'
import { importLegacyQueue } from '../../core/playback/legacyQueueImport.ts'

test('queue-reference backpressure cannot commit playback without returning its new revision', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-session-backpressure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bundle = createPlaybackSessionStoreBundle(root)
  let blocked = true
  const repository = createCorePlaybackRepository(bundle, {
    syncLibraryQueueReferences: async () => {
      if (blocked) throw new Error('Music library database request queue is full')
    }
  })
  const session = {
    version: 1 as const,
    savedAt: '',
    mode: 'trackAndPosition' as const,
    position: 12,
    track: libraryQueueTrack({ id: 'one', filePath: 'D:/one.flac' }, 'entry'),
    libraryQueue: { id: 'queue', revision: 0, index: 0, entryId: 'entry' }
  }
  await assert.rejects(repository.save(session, 0), /request queue is full/)
  assert.equal(
    await bundle.sessionStore.load(),
    null,
    'a failed prerequisite must leave the durable revision unchanged'
  )
  blocked = false
  const saved = await repository.save(session, 0)
  assert.equal(saved.revision, 1)
  blocked = true
  await assert.rejects(repository.save(session, 0), { code: 'ERR_PERSISTENCE_REVISION_CONFLICT' })
  await assert.rejects(repository.clear(0), { code: 'ERR_PERSISTENCE_REVISION_CONFLICT' })
  blocked = false
  assert.equal((await repository.save({ ...session, position: 15 }, saved.revision)).revision, 2)
})

test('post-commit reference cleanup failures keep recovery queues pinned and acknowledge save and clear', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-session-reference-cleanup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: 'D:/one.flac' }]
  })
  const bundle = createPlaybackSessionStoreBundle(root)
  let failCleanup = false,
    protectedCount = 0
  const warning = t.mock.method(console, 'warn', () => {})
  const repository = createCorePlaybackRepository(bundle, {
    syncLibraryQueueReferences: async (owner, ids) => {
      if (owner === 'core:persisted-playback') {
        if (failCleanup && ids.length < protectedCount)
          throw new Error('Music library database request queue is full')
        protectedCount = ids.length
      }
      db.syncLibraryQueueReferences(owner, ids)
    }
  })
  const queues = Array.from({ length: 3 }, () => db.createLibraryQueue({}))
  const session = (queue: (typeof queues)[number]) => ({
    version: 1 as const,
    savedAt: '',
    mode: 'trackAndPosition' as const,
    position: 12,
    track: libraryQueueTrack(db.readLibraryQueue(queue.id).items[0].track!, queue.selectedEntryId!),
    libraryQueue: {
      id: queue.id,
      revision: queue.revision,
      index: queue.index,
      entryId: queue.selectedEntryId!
    }
  })
  let revision = 0
  for (const queue of queues) {
    failCleanup = queue === queues[2]
    revision = (await repository.save(session(queue), revision)).revision
  }
  assert.equal(revision, 3, 'cleanup failure must not hide the committed revision')
  assert.equal(warning.mock.callCount(), 1)
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(
    db.collectLibraryQueueGarbage(1),
    0,
    'the failed cleanup retains the previous recovery queues'
  )
  assert.equal((await bundle.sessionStore.loadBackup())?.data?.libraryQueue?.id, queues[1].id)
  failCleanup = false
  revision = (await repository.save(session(queues[2]), revision)).revision
  assert.equal(revision, 4)
  assert.equal(db.collectLibraryQueueGarbage(1), 2)
  // Build a distinct backup again so Clear has references to retire after committing.
  const next = db.createLibraryQueue({})
  revision = (await repository.save(session(next), revision)).revision
  failCleanup = true
  const cleared = await repository.clear(revision)
  assert.equal(cleared.revision, revision + 1)
  assert.equal((await bundle.sessionStore.load())?.data, null)
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(db.collectLibraryQueueGarbage(1), 0)
  failCleanup = false
  assert.equal(
    (await repository.save(session(next), cleared.revision)).revision,
    cleared.revision + 1
  )
})

test('persisted Zone owners never replace another session queue reference', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-zone-repository-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: 'D:/one.flac' }]
  })
  const repositories = ['core:persisted-playback', 'zone:a:persisted', 'zone:b:persisted'].map(
    (owner, i) =>
      createCorePlaybackRepository(
        createPlaybackSessionStoreBundle(join(root, String(i))),
        {
          syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
        },
        owner
      )
  )
  const ids: string[] = []
  for (const repository of repositories) {
    const queue = db.createLibraryQueue({})
    ids.push(queue.id)
    const row = db.readLibraryQueue(queue.id).items[0]
    await repository.save(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        mode: 'trackAndPosition',
        position: 0,
        track: libraryQueueTrack(row.track!, row.queueEntryId),
        libraryQueue: {
          id: queue.id,
          revision: queue.revision,
          index: queue.index,
          entryId: queue.selectedEntryId!
        }
      },
      0
    )
  }
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(db.collectLibraryQueueGarbage(1), 0)
  assert.ok(ids.every((id) => db.getLibraryQueue(id).total === 1))
  assert.deepEqual(
    (await Promise.all(repositories.map((r) => r.load()))).map((r) => r?.data?.libraryQueue?.id),
    ids
  )
})

test('publishing a Zone session releases only its scoped import lease, not another Zone or the primary import', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'core-scoped-publication-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: 'D:/one.flac' }]
  })
  const scope = 'zone-11111111-1111-4111-8111-111111111111'
  const imports: Array<{
    queue: Awaited<ReturnType<typeof importLegacyQueue>>['queue']
    track: ReturnType<typeof libraryQueueTrack>
  }> = []
  for (const [i, current] of [
    undefined,
    scope,
    'zone-22222222-2222-4222-8222-222222222222'
  ].entries()) {
    const track = libraryQueueTrack({ id: 'one', filePath: 'D:/one.flac' }, `occurrence-${i}`)
    const result = await importLegacyQueue({
      api: {
        importLegacyPlaybackQueue: async (command) => db.importLegacyPlaybackQueue(command),
        readQueue: async (...args) => db.readLibraryQueue(...args)
      },
      session: {
        version: 1,
        savedAt: '2026-11-03T00:00:00Z',
        mode: 'trackAndPosition',
        track,
        queue: [track],
        queueIndex: 0,
        position: 12
      },
      sessionRevision: 1,
      libraryRevision: db.getMetadata().revision,
      scope: current
    })
    imports.push({ queue: result.queue, track })
  }
  const repository = createCorePlaybackRepository(
    createPlaybackSessionStoreBundle(root),
    {
      syncLibraryQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args)
    },
    `zone:${scope}:persisted`,
    scope
  )
  const { queue, track } = imports[1]
  await repository.save(
    {
      version: 1,
      savedAt: '2026-11-03T00:00:00Z',
      mode: 'trackAndPosition',
      track,
      position: 12,
      libraryQueue: {
        id: queue.id,
        revision: queue.revision,
        index: queue.index,
        entryId: queue.selectedEntryId!
      }
    },
    0
  )
  const owners = db.sql
    .prepare('SELECT DISTINCT owner FROM queue_references ORDER BY owner')
    .all()
    .map((row) => row.owner)
  assert.ok(owners.includes('core:legacy-import'))
  assert.ok(owners.includes('core:legacy-import:zone-22222222-2222-4222-8222-222222222222'))
  assert.ok(!owners.includes(`core:legacy-import:${scope}`))
  db.sql.exec('UPDATE queues SET created_at=0')
  assert.equal(db.collectLibraryQueueGarbage(1), 0)
  assert.ok(imports.every((item) => db.getLibraryQueue(item.queue.id).total === 1))
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
