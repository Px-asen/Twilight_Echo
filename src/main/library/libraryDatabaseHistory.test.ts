import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryDatabase } from './libraryDatabase.ts'
import type { LibraryHistorySyncRequest } from '../../shared/libraryDatabase.ts'

function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 7,
    folders: [],
    exclusions: [],
    tracks: [
      { id: 'one', filePath: 'D:/Music/one.flac', title: 'First' },
      { id: 'two', filePath: 'D:/Music/two.flac', title: 'Second' },
      { id: 'three', filePath: 'D:/Music/three.flac', title: 'Third' }
    ]
  })
  return db
}
function replace(
  db: LibraryDatabase,
  entries: Array<{ id: string; lastPlayed: number }>,
  id = 'snapshot'
) {
  db.syncListeningHistory({ kind: 'begin', id, mode: 'replace' })
  let sequence = 0
  for (let i = 0; i < entries.length; i += 1000)
    db.syncListeningHistory({
      kind: 'append',
      id,
      sequence: ++sequence,
      entries: entries.slice(i, i + 1000)
    })
  return db.syncListeningHistory({ kind: 'commit', id, sequence: ++sequence })
}
const ids = (db: LibraryDatabase) =>
  db.queryTracks({ sort: 'lastPlayed', direction: 'desc' }).tracks.map((track) => track.id)

test('staged history becomes visible atomically and cannot alter payload, track versions, file checkpoints or library revision', (t) => {
  const db = fixture(t),
    metadata = db.getMetadata(),
    tracks = db.exportDocument()
  const versions = db.getTracksByIds(['one', 'two', 'three']).versions
  const files = db.sql.prepare('SELECT file_key,content_version FROM files ORDER BY file_key').all()
  db.syncListeningHistory({ kind: 'begin', id: 'a', mode: 'replace' })
  db.syncListeningHistory({
    kind: 'append',
    id: 'a',
    sequence: 1,
    entries: [{ id: 'two', lastPlayed: 100 }]
  })
  assert.deepEqual(ids(db), ['one', 'two', 'three'])
  const result = db.syncListeningHistory({ kind: 'commit', id: 'a', sequence: 2 })
  assert.equal(result.revision, 1)
  assert.deepEqual(ids(db), ['two', 'one', 'three'])
  assert.deepEqual(db.getMetadata(), metadata)
  assert.deepEqual(db.exportDocument(), tracks)
  assert.deepEqual(db.getTracksByIds(['one', 'two', 'three']).versions, versions)
  assert.deepEqual(
    db.sql.prepare('SELECT file_key,content_version FROM files ORDER BY file_key').all(),
    files
  )
  assert.deepEqual(
    db.queryTracks({ search: 'First' }).tracks.map((track) => track.id),
    ['one']
  )
  assert.deepEqual(db.syncListeningHistory({ kind: 'commit', id: 'a', sequence: 2 }), result)
  assert.equal(
    replace(db, [{ id: 'two', lastPlayed: 100 }]).revision,
    1,
    'identical snapshot is a no-op'
  )
})

test('patches, clear and cache invalidation preserve ordering ties and reject stale query/queue revisions', (t) => {
  const db = fixture(t)
  const first = replace(db, [
    { id: 'one', lastPlayed: 100 },
    { id: 'two', lastPlayed: 50 }
  ])
  db.queryTracks({ sort: 'lastPlayed', anchorId: 'three' })
  const queue = db.createLibraryQueue({
    sort: 'lastPlayed',
    direction: 'desc',
    historyRevision: first.revision
  })
  db.syncListeningHistory({
    kind: 'begin',
    id: 'patch',
    mode: 'patch',
    expectedRevision: first.revision
  })
  db.syncListeningHistory({
    kind: 'append',
    id: 'patch',
    sequence: 1,
    entries: [{ id: 'two', lastPlayed: 150 }]
  })
  const next = db.syncListeningHistory({ kind: 'commit', id: 'patch', sequence: 2 })
  assert.deepEqual(ids(db), ['two', 'one', 'three'])
  assert.equal(
    db.queryTracks({ sort: 'lastPlayed', anchorId: 'two', direction: 'desc' }).anchorIndex,
    0
  )
  assert.deepEqual(
    db.readLibraryQueue(queue.id).items.map((entry) => entry.track?.id),
    ['one', 'two', 'three']
  )
  assert.throws(
    () => db.queryTracks({ sort: 'lastPlayed', historyRevision: first.revision }),
    { code: 'STALE_HISTORY_REVISION', message: /history changed/ }
  )
  assert.throws(
    () => db.createLibraryQueue({ sort: 'lastPlayed', historyRevision: first.revision }),
    { code: 'STALE_HISTORY_REVISION', message: /history changed/ }
  )
  assert.throws(
    () =>
      db.syncListeningHistory({
        kind: 'begin',
        id: 'old',
        mode: 'patch',
        expectedRevision: first.revision
      }),
    /concurrently/
  )
  assert.equal(
    db.queryTracks({ sort: 'lastPlayed', historyRevision: next.revision }).historyRevision,
    next.revision
  )
  replace(db, [])
  assert.deepEqual(ids(db), ['one', 'two', 'three'])
  const plan = db.sql
    .prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM tracks ORDER BY last_played DESC,seq DESC LIMIT 200'
    )
    .all()
  assert.match(plan.map((row) => row.detail).join(' '), /tracks_played/)
})

test('one staged session and strict sequences bound batches; a fresh begin supersedes incomplete work', (t) => {
  const db = fixture(t)
  const bad: unknown[] = [
    null,
    { kind: 'begin', id: '', mode: 'replace' },
    { kind: 'begin', id: 'p', mode: 'patch' },
    {
      kind: 'append',
      id: 'a',
      sequence: 1,
      entries: Array(1001).fill({ id: 'one', lastPlayed: 1 })
    },
    { kind: 'append', id: 'a', sequence: 1, entries: [{ id: 'one', lastPlayed: Infinity }] },
    { kind: 'append', id: 'a', sequence: 1, entries: [{ id: 'one', lastPlayed: -1 }] }
  ]
  for (const request of bad)
    assert.throws(() => db.syncListeningHistory(request as LibraryHistorySyncRequest), /Invalid/)
  db.syncListeningHistory({ kind: 'begin', id: 'a', mode: 'replace' })
  assert.throws(
    () => db.syncListeningHistory({ kind: 'commit', id: 'a', sequence: 2 }),
    /sequence expired/
  )
  db.syncListeningHistory({
    kind: 'append',
    id: 'a',
    sequence: 1,
    entries: [{ id: 'one', lastPlayed: 1 }]
  })
  db.syncListeningHistory({ kind: 'begin', id: 'b', mode: 'replace' })
  assert.throws(
    () => db.syncListeningHistory({ kind: 'commit', id: 'a', sequence: 2 }),
    /session or sequence expired/
  )
  db.syncListeningHistory({ kind: 'commit', id: 'b', sequence: 1 })
  assert.deepEqual(ids(db), ['one', 'two', 'three'])
})

test('listening ticks keep cached text orders and unchanged totals while refreshing history orders', (t) => {
  const db = fixture(t)
  const prototype = Object.getPrototypeOf(db.sql.prepare('SELECT 1'))
  const original = prototype.all
  let textReads = 0
  t.mock.method(prototype, 'all', function (this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL.includes(' AS value')) textReads++
    return original.apply(this, args)
  })
  db.queryTracks({ sort: 'title' })
  assert.equal(textReads, 1)
  for (let i = 1; i <= 5; i++) {
    replace(db, [{ id: 'two', lastPlayed: i }], `tick:${i}`)
    assert.equal(db.queryTracks({ sort: 'title' }).total, 3)
    assert.equal(
      db.queryTracks({ sort: 'lastPlayed', anchorId: 'two', direction: 'desc' }).anchorIndex,
      0
    )
  }
  assert.equal(textReads, 1, 'a listening tick must not repeat the full-library text sort')
})

test('failed history commit rolls back the index, projected identities and history revision together', (t) => {
  const db = fixture(t)
  const original = replace(db, [{ id: 'one', lastPlayed: 100 }])
  db.sql.exec(
    "CREATE TRIGGER fail_history BEFORE UPDATE OF last_played ON tracks BEGIN SELECT RAISE(ABORT,'history fault'); END"
  )
  assert.throws(() => replace(db, [{ id: 'two', lastPlayed: 200 }], 'next'), /history fault/)
  assert.deepEqual(ids(db), ['one', 'two', 'three'])
  assert.equal(db.queryTracks().historyRevision, original.revision)
  assert.equal(db.sql.prepare('SELECT id FROM library_history').get()?.id, 'one')
  db.sql.exec('DROP TRIGGER fail_history')
  const retry = db.syncListeningHistory({ kind: 'commit', id: 'next', sequence: 2 })
  assert.equal(retry.revision, 2)
  assert.deepEqual(ids(db), ['two', 'one', 'three'])
})

test('projected missing IDs apply to later imports; metadata edits and remove/reimport retain history semantics', (t) => {
  const db = fixture(t)
  replace(db, [
    { id: 'future', lastPlayed: 500 },
    { id: 'two', lastPlayed: 100 }
  ])
  const document = db.exportDocument()
  db.replaceDocument({
    ...document,
    tracks: [
      ...document.tracks,
      { id: 'future', filePath: 'D:/Music/future.flac', title: 'Future' }
    ]
  })
  assert.deepEqual(ids(db), ['future', 'two', 'one', 'three'])
  const version = db.getTracksByIds(['two']).versions.two
  db.patchTracks([{ id: 'two', expectedVersion: version, patch: { title: 'Changed' } }])
  assert.deepEqual(ids(db), ['future', 'two', 'one', 'three'])
  db.replaceDocument(document)
  db.replaceDocument({
    ...document,
    tracks: [...document.tracks, { id: 'future', filePath: 'D:/Music/future.flac' }]
  })
  assert.equal(ids(db)[0], 'future')
})

test('v3 upgrade saves a consistent snapshot, preserves tracks and queues, and installs the non-content history trigger', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-history-upgrade-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.replaceDocument({
    version: 2,
    revision: 7,
    folders: [],
    exclusions: [],
    tracks: [{ id: 'one', filePath: join(root, 'one.flac') }]
  })
  const queue = old.createLibraryQueue({ sort: 'playlist', ids: ['one', 'one'] })
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      `DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP TABLE library_history; DELETE FROM meta WHERE key='history_revision';
    DROP INDEX tracks_recording; DROP INDEX tracks_playlist_path; DROP INDEX tracks_playlist_suffix;
    ALTER TABLE tracks DROP COLUMN playlist_path; ALTER TABLE tracks DROP COLUMN playlist_path_reverse;
    DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=3;`
  )
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 30)
    assert.equal(upgraded.readLibraryQueue(queue.id).total, 2)
    replace(upgraded, [{ id: 'one', lastPlayed: 100 }])
    assert.equal(upgraded.queryTracks().historyRevision, 1)
    const snapshot = new DatabaseSync(
      join(root, readdirSync(root).find((name) => name.includes('.v3-backup-'))!),
      { readOnly: true }
    )
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 3)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM tracks').get()?.n, 1)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 2)
      assert.equal(
        snapshot.prepare("SELECT name FROM sqlite_master WHERE name='library_history'").get(),
        undefined
      )
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})

test('history schema upgrade rolls back partial DDL and refuses to upgrade when the safety snapshot fails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'library-history-upgrade-fault-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      `DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP TABLE library_history; DELETE FROM meta WHERE key='history_revision';
    DROP INDEX tracks_recording; DROP INDEX tracks_playlist_path; DROP INDEX tracks_playlist_suffix;
    ALTER TABLE tracks DROP COLUMN playlist_path; ALTER TABLE tracks DROP COLUMN playlist_path_reverse;
    DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=3;`
  )
  const exec = DatabaseSync.prototype.exec
  const failure = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS library_history')) {
        exec.call(
          this,
          'CREATE TABLE library_history(id TEXT PRIMARY KEY,last_played REAL NOT NULL)'
        )
        throw new Error('history schema fault')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /history schema fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 3)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='library_history'").get(),
    undefined
  )
  failure.mock.restore()
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'VACUUM INTO ?') throw new Error('SQLITE_FULL: snapshot failed')
    return prepare.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /SQLITE_FULL/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 3)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='library_history'").get(),
    undefined
  )
})
