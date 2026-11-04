import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import type { LibraryQueueSnapshot } from '../../shared/libraryDatabase.ts'
import type { CoreQueueSourceReplacement } from '../../shared/coreSourceRecovery.ts'

function replacement(
  db: LibraryDatabase,
  queue: LibraryQueueSnapshot,
  patch: Partial<CoreQueueSourceReplacement> = {}
): CoreQueueSourceReplacement {
  return {
    queue: {
      id: queue.id,
      revision: queue.revision,
      index: queue.index,
      entryId: queue.selectedEntryId!
    },
    contentRevision: db.getMetadata().revision,
    occurrenceId: 'same:second',
    expectedTrackId: 'ncm:1',
    replacement: {
      id: 'fixture:new',
      snapshot: {
        id: 'fixture:new',
        source: 'fixture',
        title: 'Replacement',
        artist: 'Artist',
        filePath: '',
        streamUrl: 'https://cdn.test/transient?token=private',
        cover: 'twilight-media://image/session-only'
      }
    },
    ...patch
  }
}

test('Zone SQL clone retains duplicate selection, shuffled/original orders, mode and snapshots without sharing cursor or undo', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    let source = restore(db, 'handoff', 'Source')
    source = db.editLibraryQueue(source.id, source.revision, { kind: 'move', entryId: 'other', beforeEntryId: 'same:first' }).queue
    const reference = { id: source.id, revision: source.revision, index: source.index, entryId: source.selectedEntryId! }
    const sourceRows = db.readLibraryQueue(source.id).items
    const copy = db.clonePlaybackQueue(reference)
    assert.notEqual(copy.id, source.id)
    assert.equal(copy.revision, 0)
    assert.equal(copy.canUndo, false)
    assert.equal(copy.selectedEntryId, source.selectedEntryId)
    assert.equal(copy.playMode, source.playMode)
    assert.equal(copy.order, source.order)
    assert.deepEqual(db.readLibraryQueue(copy.id).items, sourceRows)
    const positions = (id: string) => db.sql.prepare('SELECT position,entry_id,original_position FROM queue_entries WHERE queue_id=? ORDER BY position').all(id)
    assert.deepEqual(positions(copy.id), positions(source.id))
    db.editLibraryQueue(copy.id, copy.revision, { kind: 'select', entryId: 'same:first' })
    assert.deepEqual(db.getLibraryQueue(source.id), source)
    assert.throws(() => db.clonePlaybackQueue({ ...reference, entryId: 'other' }), /selection changed/)
    db.editLibraryQueue(source.id, source.revision, { kind: 'remove', entryIds: ['other'] })
    assert.throws(() => db.clonePlaybackQueue(reference), /changed concurrently/)
    assert.equal(db.readLibraryQueue(copy.id).items.length, 3)
    assert.deepEqual(db.sql.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close() }
})

test('private source replacement retains the occurrence, duplicates, original order and queue-scoped snapshots', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const queue = restore(db, 'source', 'Original'),
      other = restore(db, 'other-source', 'Other')
    const otherBefore = db.readLibraryQueue(other.id)
    const order = db.sql
      .prepare(
        'SELECT entry_id,position,original_position FROM queue_entries WHERE queue_id=? ORDER BY position'
      )
      .all(queue.id)
    const repaired = db.replacePlaybackQueueSource(replacement(db, queue))
    assert.equal(repaired.id, queue.id)
    assert.equal(repaired.revision, queue.revision + 1)
    assert.equal(repaired.index, queue.index)
    assert.equal(repaired.selectedEntryId, queue.selectedEntryId)
    assert.equal(repaired.order, queue.order)
    assert.equal(repaired.playMode, queue.playMode)
    assert.equal(repaired.total, queue.total)
    const rows = db.readLibraryQueue(queue.id).items
    assert.deepEqual(
      rows.map((row) => row.queueEntryId),
      ['same:first', 'same:second', 'other']
    )
    assert.deepEqual(
      rows.map((row) => row.track?.id),
      ['ncm:1', 'fixture:new', 'ncm:2']
    )
    assert.equal(rows[1].track?.title, 'Replacement')
    assert.equal(rows[1].track?.streamUrl, undefined)
    assert.equal(rows[1].track?.cover, undefined)
    assert.deepEqual(
      db.sql
        .prepare(
          'SELECT entry_id,position,original_position FROM queue_entries WHERE queue_id=? ORDER BY position'
        )
        .all(queue.id),
      order
    )
    assert.deepEqual(db.readLibraryQueue(other.id), otherBefore)
    assert.throws(() => db.editLibraryQueue(queue.id, repaired.revision, { kind: 'undo' }), /撤销/)
    assert.throws(
      () => db.replacePlaybackQueueSource(replacement(db, queue)),
      /changed concurrently/i
    )
  } finally {
    db.close()
  }
})

test('source replacement rebases existing undo snapshots without creating a source-edit undo entry', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    let queue = restore(db, 'source-history', 'Original')
    const before = db.readLibraryQueue(queue.id)
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'move',
      entryId: 'same:second',
      beforeEntryId: 'same:first'
    }).queue
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'order',
      order: 'original'
    }).queue
    const count = db.sql
      .prepare('SELECT count(*) AS n FROM queue_history WHERE queue_id=?')
      .get(queue.id)!.n
    queue = db.replacePlaybackQueueSource(replacement(db, queue))
    assert.equal(
      db.sql.prepare('SELECT count(*) AS n FROM queue_history WHERE queue_id=?').get(queue.id)!.n,
      count
    )
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'undo' }).queue
    assert.equal(
      db.readLibraryQueue(queue.id).items.find((row) => row.queueEntryId === 'same:second')?.track
        ?.id,
      'fixture:new'
    )
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'undo' }).queue
    const after = db.readLibraryQueue(queue.id).items
    assert.deepEqual(
      after.map((row) => row.queueEntryId),
      before.items.map((row) => row.queueEntryId)
    )
    assert.deepEqual(
      after.map((row) => row.track?.id),
      ['ncm:1', 'fixture:new', 'ncm:2']
    )
    assert.equal(after[1].track?.title, 'Replacement')
    assert.equal(queue.selectedEntryId, 'same:second')
    assert.deepEqual(db.sql.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('source replacement uses live local library records or explicit temporary CUE/SACD identity', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    db.replaceDocument({
      version: 2,
      revision: 0,
      tracks: [
        {
          id: 'local:cue',
          source: 'local',
          title: 'Cue',
          filePath: 'D:/Music/disc.flac',
          duration: 30,
          cueRange: { startSeconds: 90, endSeconds: 120 }
        }
      ],
      folders: [],
      exclusions: []
    })
    let queue = restore(db, 'source-local', 'Original')
    queue = db.replacePlaybackQueueSource(
      replacement(db, queue, { replacement: { id: 'local:cue' } })
    )
    assert.equal(db.readLibraryQueue(queue.id).items[1].track?.filePath, 'D:/Music/disc.flac')
    assert.deepEqual(db.readLibraryQueue(queue.id).items[1].track?.cueRange, {
      startSeconds: 90,
      endSeconds: 120
    })
    assert.equal(
      db.sql
        .prepare('SELECT count(*) AS n FROM queue_snapshots WHERE queue_id=? AND entry_id=?')
        .get(queue.id, 'same:second')!.n,
      0
    )
    queue = db.replacePlaybackQueueSource(
      replacement(db, queue, {
        expectedTrackId: 'local:cue',
        replacement: {
          id: 'local:sacd',
          localSnapshot: {
            id: 'local:sacd',
            source: 'local',
            filePath: 'D:/Music/disc.iso',
            subTrack: 'D:/Music/disc.iso?area=stereo&track=2'
          }
        }
      })
    )
    assert.equal(
      db.readLibraryQueue(queue.id).items[1].track?.subTrack,
      'D:/Music/disc.iso?area=stereo&track=2'
    )
    assert.equal(db.getTracksByIds(['local:sacd']).tracks.length, 0)
    assert.equal(db.getMetadata().trackCount, 1)
  } finally {
    db.close()
  }
})

test('source replacement fences library, cursor, occurrence and item identity, and rolls back partial writes', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const queue = restore(db, 'source-rollback', 'Original')
    const before = db.readLibraryQueue(queue.id)
    for (const patch of [
      { contentRevision: db.getMetadata().revision + 1 },
      { queue: { ...replacement(db, queue).queue, index: 0 } },
      { occurrenceId: 'missing' },
      { expectedTrackId: 'ncm:wrong' },
      { replacement: { id: 'local:missing' } },
      { replacement: { id: 'bad', snapshot: { id: 'other', source: 'ncm', filePath: '' } } }
    ]) {
      assert.throws(() => db.replacePlaybackQueueSource(replacement(db, queue, patch)))
      assert.deepEqual(db.readLibraryQueue(queue.id), before)
    }
    db.sql.exec(
      "CREATE TRIGGER fail_source_replacement BEFORE INSERT ON queue_snapshots WHEN json_extract(NEW.payload,'$.id')='fixture:new' BEGIN SELECT RAISE(ABORT,'source write failed'); END"
    )
    assert.throws(
      () => db.replacePlaybackQueueSource(replacement(db, queue)),
      /source write failed/
    )
    assert.deepEqual(db.getLibraryQueue(queue.id), queue)
    assert.deepEqual(db.readLibraryQueue(queue.id), before)
    assert.deepEqual(db.sql.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

function restore(db: LibraryDatabase, suffix: string, title: string) {
  const id = `core-restore-${suffix}`
  db.restoreNamedPlaybackQueue({
    kind: 'begin',
    id,
    contentRevision: db.getMetadata().revision,
    order: 'shuffle',
    playMode: 'shuffle'
  })
  db.restoreNamedPlaybackQueue({
    kind: 'append',
    id,
    sequence: 1,
    items: ['same:first', 'same:second', 'other'].map((occurrenceId, index) => ({
      id: index === 2 ? 'ncm:2' : 'ncm:1',
      occurrenceId,
      originalPosition: 2 - index,
      snapshot: {
        id: index === 2 ? 'ncm:2' : 'ncm:1',
        filePath: '',
        source: 'ncm',
        title: `${title}:${index}`,
        artist: 'Artist'
      }
    }))
  })
  const reply = db.restoreNamedPlaybackQueue({ kind: 'commit', id, sequence: 2, selectedIndex: 1 })
  assert.equal(reply.kind, 'ready')
  return (reply as { queue: LibraryQueueSnapshot }).queue
}

test('private automatic extensions deduplicate transactionally without relaxing public insertions or creating undo history', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const queue = restore(db, 'extension', 'Seed')
    const item = (id: string) => ({ id, snapshot: { id, source: 'ncm', filePath: '', title: id } })
    assert.throws(
      () =>
        db.editLibraryQueue(queue.id, queue.revision, { kind: 'insert', items: [item('ncm:3')] }),
      /snapshot/
    )
    const added = db.extendPlaybackQueue(queue.id, queue.revision, [
      item('ncm:1'),
      item('ncm:3'),
      item('ncm:3'),
      item('ncm:4')
    ]).queue
    assert.equal(added.total, queue.total + 2)
    assert.equal(added.selectedEntryId, queue.selectedEntryId)
    assert.deepEqual(
      db.sql
        .prepare(
          'SELECT track_id FROM queue_entries WHERE queue_id=? AND original_position>=? ORDER BY original_position'
        )
        .all(queue.id, queue.total)
        .map((row) => row.track_id),
      ['ncm:3', 'ncm:4']
    )
    assert.throws(() => db.editLibraryQueue(queue.id, added.revision, { kind: 'undo' }), /撤销/)
    assert.throws(
      () => db.extendPlaybackQueue(queue.id, queue.revision, [item('ncm:5')]),
      /changed concurrently/i
    )
    const page = db.readLibraryQueue(queue.id)
    db.sql.exec(
      "CREATE TRIGGER fail_extension BEFORE INSERT ON queue_snapshots WHEN json_extract(NEW.payload,'$.id')='ncm:5' BEGIN SELECT RAISE(ABORT,'extension write failed'); END"
    )
    assert.throws(
      () => db.extendPlaybackQueue(queue.id, added.revision, [item('ncm:5'), item('ncm:6')]),
      /extension write failed/
    )
    assert.deepEqual(db.getLibraryQueue(queue.id), added)
    assert.deepEqual(db.readLibraryQueue(queue.id), page)
    assert.equal(
      db.sql.prepare('SELECT count(*) AS n FROM queue_history WHERE queue_id=?').get(queue.id)!.n,
      0
    )
  } finally {
    db.close()
  }
})

test('overlapping saved occurrences have isolated snapshots, navigation, edits, undo and GC', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    let a = restore(db, 'a', 'A')
    const b = restore(db, 'b', 'B')
    const bPage = db.readLibraryQueue(b.id)
    assert.deepEqual(
      bPage.items.map((row) => row.track?.title),
      ['B:0', 'B:1', 'B:2']
    )
    assert.equal(db.readLibraryQueue(a.id, 0, 200, { search: 'B:' }).total, 0)
    assert.equal(db.readLibraryQueueNeighbor(a.id, a.revision, 1, 1, false)?.track?.title, 'A:2')
    assert.deepEqual(
      db
        .exportPlaybackQueue(
          { id: a.id, revision: a.revision, index: 1, entryId: 'same:second' },
          32768
        )
        .queue.map((row) => row.title),
      ['A:0', 'A:1', 'A:2']
    )
    const original = db.readLibraryQueue(a.id)
    a = db.editLibraryQueue(a.id, a.revision, {
      kind: 'move',
      entryId: 'other',
      beforeEntryId: 'same:first'
    }).queue
    assert.deepEqual(db.readLibraryQueue(b.id), bPage)
    a = db.editLibraryQueue(a.id, a.revision, { kind: 'undo' }).queue
    assert.deepEqual(db.readLibraryQueue(a.id).items, original.items)
    a = db.editLibraryQueue(a.id, a.revision, {
      kind: 'remove',
      entryIds: ['same:first', 'other']
    }).queue
    a = db.editLibraryQueue(a.id, a.revision, { kind: 'undo' }).queue
    assert.deepEqual(db.readLibraryQueue(a.id).items, original.items)
    a = db.editLibraryQueue(a.id, a.revision, { kind: 'clear' }).queue
    assert.equal(db.readLibraryQueue(a.id).lastPlayablePosition, -1)
    assert.equal(db.readLibraryQueue(b.id).lastPlayablePosition, 2)
    a = db.editLibraryQueue(a.id, a.revision, { kind: 'undo' }).queue
    assert.deepEqual(db.readLibraryQueue(a.id).items, original.items)
    assert.deepEqual(db.readLibraryQueue(b.id), bPage)
    db.syncLibraryQueueReferences('session', [b.id])
    assert.equal(
      db.sql
        .prepare("SELECT count(*) AS n FROM queue_references WHERE owner='core:legacy-import'")
        .get()?.n,
      0
    )
    db.sql.exec('UPDATE queues SET created_at=0')
    assert.equal(db.collectLibraryQueueGarbage(0), 1)
    while (db.needsQueryMaintenance) db.maintainQueryState()
    assert.deepEqual(db.readLibraryQueue(b.id), bPage)
    assert.equal(
      db.sql.prepare('SELECT count(*) AS n FROM queue_snapshots WHERE queue_id=?').get(a.id)?.n,
      0
    )
    assert.deepEqual(db.sql.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('named restore keeps an independent original order without reshuffling; duplicate IDs within one queue and ordinary access remain rejected', () => {
  const db = new LibraryDatabase(':memory:')
  try {
    const id = 'core-restore-independent'
    db.restoreNamedPlaybackQueue({
      kind: 'begin',
      id,
      contentRevision: 0,
      order: 'original',
      playMode: 'repeat'
    })
    const item = { id: 'ncm:1', snapshot: { id: 'ncm:1', source: 'ncm', filePath: '' } }
    db.restoreNamedPlaybackQueue({
      kind: 'append',
      id,
      sequence: 1,
      items: [
        { ...item, occurrenceId: 'x', originalPosition: 1 },
        { ...item, occurrenceId: 'y', originalPosition: 0 }
      ]
    })
    const reply = db.restoreNamedPlaybackQueue({
      kind: 'commit',
      id,
      sequence: 2,
      selectedIndex: 1
    })
    assert.equal(reply.kind, 'ready')
    assert.deepEqual(
      db.sql
        .prepare('SELECT entry_id FROM queue_entries WHERE queue_id=? ORDER BY original_position')
        .all(id)
        .map((row) => row.entry_id),
      ['y', 'x']
    )
    assert.equal(db.getLibraryQueue(id).playMode, 'repeat')
    assert.throws(
      () => db.buildLibraryQueue({ kind: 'begin', id, contentRevision: 0, order: 'original' }),
      /reserved/
    )
    const duplicate = 'core-restore-duplicate'
    db.restoreNamedPlaybackQueue({
      kind: 'begin',
      id: duplicate,
      contentRevision: 0,
      order: 'original',
      playMode: 'repeat'
    })
    assert.throws(
      () =>
        db.restoreNamedPlaybackQueue({
          kind: 'append',
          id: duplicate,
          sequence: 1,
          items: [
            { ...item, occurrenceId: 'x' },
            { ...item, occurrenceId: 'x' }
          ]
        }),
      /UNIQUE/
    )
    assert.equal(
      db.sql.prepare('SELECT count(*) AS n FROM queue_entries WHERE queue_id=?').get(duplicate)?.n,
      0
    )
    assert.deepEqual(
      db.readLibraryQueue(id).items.map((row) => row.queueEntryId),
      ['x', 'y']
    )
  } finally {
    db.close()
  }
})

test('v10 migration preserves snapshots, identity, references, undo and WAL backup; partial DDL or backup failure publishes nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'queue-identity-v11-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  const connections = [old]
  t.after(() => {
    for (const connection of connections) connection.close()
    rmSync(root, { recursive: true, force: true })
  })
  let queue = restore(old, 'v10', 'Before')
  queue = old.editLibraryQueue(queue.id, queue.revision, {
    kind: 'remove',
    entryIds: ['same:first']
  }).queue
  old.syncLibraryQueueReferences('workspace', [queue.id])
  const expectedPage = old.readLibraryQueue(queue.id)
  const expectedMeta = old.getMetadata()
  old.sql.exec(LEGACY_QUEUE_SCHEMA_SQL + 'PRAGMA user_version=10;')
  const prepare = DatabaseSync.prototype.prepare
  const backupFailure = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql === 'VACUUM INTO ?') throw new Error('backup full')
      return prepare.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /backup full/)
  backupFailure.mock.restore()
  const exec = DatabaseSync.prototype.exec
  const ddlFailure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('CREATE TABLE queue_entries_v11')) {
        exec.call(this, sql.slice(0, sql.indexOf('CREATE TABLE queue_snapshots_v11')))
        throw new Error('DDL fault')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /DDL fault/)
  ddlFailure.mock.restore()
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 10)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='queue_entries_v11'").get(),
    undefined
  )
  const upgraded = new LibraryDatabase(path)
  connections.push(upgraded)
  assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 30)
  assert.deepEqual(upgraded.readLibraryQueue(queue.id), expectedPage)
  assert.deepEqual(upgraded.getMetadata(), expectedMeta)
  assert.equal(
    upgraded.sql.prepare('SELECT owner FROM queue_references WHERE queue_id=?').get(queue.id)
      ?.owner,
    'workspace'
  )
  queue = upgraded.editLibraryQueue(queue.id, queue.revision, { kind: 'undo' }).queue
  assert.deepEqual(
    upgraded.readLibraryQueue(queue.id).items.map((row) => [row.queueEntryId, row.track?.title]),
    [
      ['same:first', 'Before:0'],
      ['same:second', 'Before:1'],
      ['other', 'Before:2']
    ]
  )
  restore(upgraded, 'overlap', 'After')
  assert.deepEqual(upgraded.sql.prepare('PRAGMA foreign_key_check').all(), [])
  const backup = new DatabaseSync(
    join(root, readdirSync(root).find((name) => name.includes('.v10-backup-'))!),
    { readOnly: true }
  )
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 10)
    assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    assert.equal(backup.prepare('SELECT count(*) AS n FROM queue_history_entries').get()?.n, 1)
    assert.equal(backup.prepare('SELECT count(*) AS n FROM queue_snapshots').get()?.n, 2)
  } finally {
    backup.close()
  }
})
