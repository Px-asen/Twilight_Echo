import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { LEGACY_QUEUE_SCHEMA_SQL } from '../../../../main/library/legacyQueueSchema.fixture.ts'
import type {
  LibraryPlaylistViewSync,
  LibraryTrackRecord
} from '../../../../shared/libraryDatabase.ts'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shallowRef } from 'vue'
import { createPlaylistTrackResolver } from './playlistTrackResolver.ts'
import {
  applyLibraryView,
  createDefaultLibraryViewState,
  type LibrarySortKey
} from '../../utils/libraryViewPreferences.ts'
import { getTrackSearchBlob, normalizeSearchText } from '../../utils/localLibrarySearch.ts'
import type { TrackData as Track } from '../../../../shared/track.ts'
import { versionSourceKey } from '../../../../shared/trackSourceIdentity.ts'

// The track resolver warms the Core-backed version store on every resolve.
// Unit tests have no window, so install a benign bridge before any import
// chain reaches it; a failed background load is swallowed by the store.
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { core: { onMessage: () => () => {}, onStatus: () => () => {} } } }
  })
}

function track(id: string, patch: Record<string, unknown> = {}): LibraryTrackRecord {
  return {
    id,
    filePath: `D:/Music/${id}.flac`,
    title: id,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'local',
    ...patch
  }
}
function fixture(t: TestContext, tracks = [track('one'), track('two')]) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({ version: 2, revision: 0, tracks, folders: [], exclusions: [] })
  return db
}
function upload(
  db: LibraryDatabase,
  entries: Extract<LibraryPlaylistViewSync, { kind: 'append' }>['entries'],
  id = 'view',
  preserveSources = false
) {
  db.syncPlaylistView({ kind: 'begin', id, versions: [], preserveSources })
  let sequence = 0
  for (let i = 0; i < entries.length; i += 200)
    db.syncPlaylistView({
      kind: 'append',
      id,
      sequence: ++sequence,
      entries: entries.slice(i, i + 200)
    })
  db.syncPlaylistView({ kind: 'commit', id, sequence: ++sequence })
  return { playlistView: id, sort: 'playlist' as const }
}
test('playlist views preserve local replacements, missing members, remote snapshots and duplicate occurrences', (t) => {
  const db = fixture(t)
  const remote = track('ncm:7', {
    title: 'Remote',
    source: 'ncm',
    streamUrl: 'https://expired',
    lyrics: 'heavy',
    extension: { large: 'x' }
  })
  const query = upload(db, [
    { id: 'old', snapshot: track('old', { title: 'one' }) },
    { id: 'two' },
    { id: 'two' },
    { id: 'missing', snapshot: track('missing', { title: 'Missing' }) },
    { id: remote.id, snapshot: remote },
    { id: 'absent' }
  ])
  const page = db.queryTracks(query)
  assert.deepEqual(
    page.tracks.map((t) => t.id),
    ['one', 'two', 'two', 'ncm:7']
  )
  assert.deepEqual(page.entryIds, ['0', '1', '2', '4'])
  assert.equal(page.total, 4)
  assert.equal(page.totalDuration, 720)
  assert.equal(page.tracks.at(-1)?.lyrics, null)
  assert.equal(page.tracks.at(-1)?.streamUrl, undefined)
  assert.equal(page.tracks.at(-1)?.extension, undefined)
  const queue = db.createLibraryQueue({ ...query, playlistEntryId: '2' }, 'two')
  assert.equal(queue.index, 2)
  const items = db.readLibraryQueue(queue.id).items
  assert.equal(new Set(items.map((t) => t.queueEntryId)).size, 4)
  assert.deepEqual(
    items.map((t) => t.track?.id),
    page.tracks.map((t) => t.id)
  )
  db.syncPlaylistView({ kind: 'drop', id: 'view' })
  assert.equal(db.readLibraryQueue(queue.id).items.at(-1)?.track?.source, 'ncm')
  assert.throws(() => db.queryTracks(query), /expired/)
})
test('query order, search and filters cover every page and retain stable occurrence anchors', (t) => {
  const db = fixture(
    t,
    Array.from({ length: 450 }, (_, i) =>
      track(String(i), {
        title: `月光 ${450 - i}`,
        fileName: `track${i}.flac`,
        duration: i,
        addedAt: i
      })
    )
  )
  const query = upload(
    db,
    Array.from({ length: 450 }, (_, i) => ({ id: String(i) }))
  )
  assert.equal(db.queryTracks({ ...query, offset: 400 }).tracks.length, 50)
  assert.equal(
    db.queryTracks({ ...query, sort: 'duration', direction: 'desc', offset: 400 }).tracks[0].id,
    '49'
  )
  const anchor = db.queryTracks({
    ...query,
    sort: 'duration',
    direction: 'desc',
    playlistEntryId: '49'
  })
  assert.equal(anchor.offset, 400)
  assert.equal(anchor.anchorIndex, 400)
  assert.equal(anchor.entryIds?.[0], '49')
  assert.equal(db.queryTracks({ ...query, search: 'yueguang' }).total, 0)
  assert.equal(db.queryTracks({ ...query, search: 'yg' }).total, 450)
  assert.equal(db.queryTracks({ ...query, search: '月光' }).total, 450)
  assert.equal(db.queryTracks({ ...query, search: 'yg4' }).total, 0)
  assert.equal(db.queryTracks({ ...query, search: 'track449', searchFileName: true }).total, 1)
  assert.equal(db.queryTracks({ ...query, filters: { provider: 'ncm' } }).total, 0)
})
test('membership is immutable but local metadata and identity resolution refresh at the current content revision', (t) => {
  const db = fixture(t),
    query = upload(db, [
      { id: 'one' },
      { id: 'ncm:7', snapshot: track('ncm:7', { title: 'Later', source: 'ncm' }) }
    ])
  const first = db.queryTracks(query)
  db.patchTracks([{ id: 'one', expectedVersion: first.versions.one, patch: { title: 'Updated' } }])
  assert.equal(db.queryTracks(query).tracks[0].title, 'Updated')
  assert.throws(() => db.createLibraryQueue({ ...query, contentRevision: first.revision }), /变化/)
  const doc = db.exportDocument()
  doc.tracks.push(track('later', { title: 'Later' }))
  db.replaceDocument(doc)
  assert.deepEqual(
    db.queryTracks(query).tracks.map((t) => t.id),
    ['one', 'later']
  )
  assert.throws(
    () => db.syncPlaylistView({ kind: 'append', id: 'view', sequence: 3, entries: [] }),
    /changed/
  )
})
test('staging, resource limits and malformed inputs fail explicitly without publishing partial membership', (t) => {
  const db = fixture(t)
  db.syncPlaylistView({ kind: 'begin', id: 'v', versions: [] })
  assert.throws(() => db.queryTracks({ playlistView: 'v' }), /incomplete/)
  assert.throws(
    () => db.syncPlaylistView({ kind: 'append', id: 'v', sequence: 2, entries: [] }),
    /out-of-order/
  )
  assert.throws(
    () =>
      db.syncPlaylistView({
        kind: 'append',
        id: 'v',
        sequence: 1,
        entries: Array.from({ length: 201 }, () => ({ id: 'one' }))
      }),
    /oversized/
  )
  db.syncPlaylistView({ kind: 'append', id: 'v', sequence: 1, entries: [{ id: 'one' }] })
  db.syncPlaylistView({ kind: 'commit', id: 'v', sequence: 2 })
  assert.equal(db.queryTracks({ playlistView: 'v' }).total, 1)
  assert.throws(() => db.syncPlaylistView({ kind: 'begin', id: 'v', versions: [] }), /exists/)
  assert.throws(() => db.queryTracks({ playlistView: 'v', playlistEntryId: '-1' }), /occurrence/)
  for (const id of ['v2', 'v3', 'v4']) db.syncPlaylistView({ kind: 'begin', id, versions: [] })
  assert.throws(() => db.syncPlaylistView({ kind: 'begin', id: 'v5', versions: [] }), /Too many/)
  db.syncPlaylistView({ kind: 'drop', id: 'v2' })
  db.syncPlaylistView({ kind: 'begin', id: 'v5', versions: [] })
  assert.throws(() => db.queryCollections('albums', { playlistView: 'v' }), /not collection/)
})

test('abandoned view leases expire and release staging and query rows without touching durable queues', (t) => {
  const db = fixture(t),
    query = upload(db, [{ id: 'one' }])
  const queue = db.createLibraryQueue(query)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 11 * 60_000)
  assert.throws(() => db.queryTracks(query), /expired/)
  db.syncPlaylistView({ kind: 'begin', id: 'replacement', versions: [] })
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_definitions WHERE view_id=?').get('view')?.n,
    0
  )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_members WHERE view_id=?').get('view')?.n,
    0
  )
  assert.equal(db.readLibraryQueue(queue.id).items[0].track?.id, 'one')
})

test('complete mixed-source orders, search and filters match the existing resolver and view rules', (t) => {
  const tracks = Array.from({ length: 405 }, (_, i) => ({
    ...track(String(i), {
      title: [' 月光 ', '晴天', 'Live 10', 'Live 2'][i % 4] + i,
      artist: '歌手' + (i % 6),
      album: '专辑' + (i % 12),
      format: i % 2 ? 'FLAC' : 'mp3',
      sampleRate: i % 3 ? 44100 : 96000,
      fileName: `track${i % 11}.flac`,
      discNumber: i % 3 ? 1 : undefined,
      trackNumber: i % 15,
      bitDepth: i % 2 ? 16 : undefined,
      duration: 10 + (i % 30),
      addedAt: i % 10,
      size: 1,
      cover: null,
      lyrics: null
    })
  })) as unknown as Track[]
  const db = fixture(t, tracks as unknown as LibraryTrackRecord[])
  const snapshots = [
    ...tracks,
    tracks[8],
    { ...tracks[3], id: 'old:3', source: 'remote' },
    { ...tracks[0], id: 'ncm:7', title: '远程 1', source: 'ncm', sampleRate: 192000 },
    { ...tracks[0], id: 'gone', title: 'gone', source: 'local' }
  ] as Track[]
  const playlist = {
    id: 'p',
    name: 'p',
    createdAt: '',
    trackIds: snapshots.map((t) => t.id),
    trackSnapshots: Object.fromEntries(snapshots.map((t) => [t.id, t]))
  }
  const resolver = createPlaylistTrackResolver({
    tracks: shallowRef(tracks),
    trackById: new Map(tracks.map((t) => [t.id, t])),
    getTracksRevision: () => 1
  })
  const expected = resolver.resolvePlaylistTracks(playlist)
  const query = upload(
    db,
    snapshots.map((s) => ({ id: s.id, snapshot: s as unknown as LibraryTrackRecord }))
  )
  const history = new Map([
    ['8', 200],
    ['ncm:7', 400]
  ])
  db.syncListeningHistory({ kind: 'begin', id: 'history', mode: 'replace' })
  db.syncListeningHistory({
    kind: 'append',
    id: 'history',
    sequence: 1,
    entries: [...history].map(([id, lastPlayed]) => ({ id, lastPlayed }))
  })
  db.syncListeningHistory({ kind: 'commit', id: 'history', sequence: 2 })
  for (const sortKey of [
    'playlist',
    'title',
    'artist',
    'album',
    'format',
    'duration',
    'sampleRate',
    'addedAt',
    'lastPlayed',
    'trackNumber'
  ] as LibrarySortKey[])
    for (const direction of ['asc', 'desc'] as const) {
      const state = {
        ...createDefaultLibraryViewState('playlists'),
        sortKey,
        sortDirection: direction
      }
      const ordered = applyLibraryView(expected, state, history)
      const actual: string[] = []
      for (let offset = 0; offset < ordered.length; offset += 200)
        actual.push(
          ...db.queryTracks({ ...query, sort: sortKey, direction, offset }).tracks.map((t) => t.id)
        )
      assert.deepEqual(
        actual,
        ordered.map((t) => t.id),
        `${sortKey} ${direction}`
      )
    }
  for (const search of ['月', '月光', 'yg', 'zj1', 'Live 1', '!!!']) {
    const normalized = normalizeSearchText(search)
    const matches = expected.filter(
      (t) => !normalized || getTrackSearchBlob(t).includes(normalized)
    )
    assert.equal(db.queryTracks({ ...query, search }).total, matches.length, search)
  }
  for (const filters of [
    { provider: 'ncm' },
    { sampleRate: 96000 },
    { bitDepth: 16 },
    { lossless: true }
  ]) {
    const state = createDefaultLibraryViewState('playlists')
    Object.assign(state.filters, filters)
    const ordered = applyLibraryView(expected, state, history)
    const result = db.queryTracks({ ...query, filters })
    assert.equal(result.total, ordered.length)
    assert.deepEqual(
      result.tracks.map((t) => t.id),
      ordered.slice(0, 200).map((t) => t.id)
    )
  }
})

test('explicit versions reuse CUE identities and aggregate views keep provider snapshots', (t) => {
  const cue = track('cue:2', {
      title: 'Local title',
      subTrack: 'cue:2',
      cueRange: { startSeconds: 30, endSeconds: 60 }
    }),
    remote = track('ncm:7', { title: 'Remote title', source: 'ncm' })
  const db = fixture(t, [cue]),
    versions = [
      {
        id: 'v',
        sources: [versionSourceKey(cue), versionSourceKey(remote)],
        preferredSource: versionSourceKey(cue)
      }
    ]
  for (const preserveSources of [false, true]) {
    const id = String(preserveSources)
    db.syncPlaylistView({ kind: 'begin', id, versions, preserveSources })
    db.syncPlaylistView({
      kind: 'append',
      id,
      sequence: 1,
      entries: [{ id: remote.id, snapshot: remote }]
    })
    db.syncPlaylistView({ kind: 'commit', id, sequence: 2 })
    assert.equal(
      db.queryTracks({ playlistView: id }).tracks[0].id,
      preserveSources ? remote.id : cue.id
    )
  }
})

test('failed append, materialization and queue snapshot transactions roll back and can be retried explicitly', (t) => {
  const db = fixture(t),
    revision = db.getMetadata().revision
  db.syncPlaylistView({ kind: 'begin', id: 'v', versions: [] })
  db.sql.exec(
    `CREATE TEMP TRIGGER fail_append BEFORE INSERT ON playlist_definitions WHEN new.seq=1 BEGIN SELECT RAISE(ABORT,'append disk fault'); END`
  )
  assert.throws(
    () =>
      db.syncPlaylistView({
        kind: 'append',
        id: 'v',
        sequence: 1,
        entries: [{ id: 'one' }, { id: 'two' }]
      }),
    /disk fault/
  )
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_definitions').get()?.n, 0)
  db.sql.exec('DROP TRIGGER fail_append')
  db.syncPlaylistView({
    kind: 'append',
    id: 'v',
    sequence: 1,
    entries: [{ id: 'one' }, { id: 'two' }]
  })
  db.syncPlaylistView({ kind: 'commit', id: 'v', sequence: 2 })
  db.sql.exec(
    `CREATE TEMP TRIGGER fail_materialize BEFORE INSERT ON playlist_members WHEN new.seq=1 BEGIN SELECT RAISE(ABORT,'materialization disk fault'); END`
  )
  assert.throws(() => db.queryTracks({ playlistView: 'v' }), /disk fault/)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_members').get()?.n, 0)
  db.sql.exec('DROP TRIGGER fail_materialize')
  assert.equal(db.queryTracks({ playlistView: 'v' }).total, 2)
  const query = upload(db, [
    { id: 'remote:1', snapshot: track('remote:1', { title: 'Remote', source: 'remote' }) }
  ])
  db.sql.exec(
    `CREATE TRIGGER fail_snapshot BEFORE INSERT ON queue_snapshots BEGIN SELECT RAISE(ABORT,'snapshot disk fault'); END`
  )
  assert.throws(() => db.createLibraryQueue(query), /disk fault/)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queues').get()?.n, 0)
  db.sql.exec('DROP TRIGGER fail_snapshot')
  assert.equal(db.createLibraryQueue(query).total, 1)
  assert.equal(db.getMetadata().revision, revision)
})

test('mixed queue cursor, shuffle, edits and export survive reopen; later local ID collisions cannot replace remote entries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'playlist-queue-')),
    path = join(root, 'library.sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let db = new LibraryDatabase(path)
  try {
    db.replaceDocument({
      version: 2,
      revision: 0,
      tracks: [track('one'), track('two')],
      folders: [],
      exclusions: []
    })
    const remote = track('ncm:7', { title: 'Remote', source: 'ncm', streamUrl: 'https://expired' })
    const query = upload(db, [
      { id: 'one' },
      { id: remote.id, snapshot: remote },
      { id: 'two' },
      { id: remote.id, snapshot: remote }
    ])
    let queue = db.createLibraryQueue({ ...query, playlistEntryId: '3' }, remote.id)
    const original = db.readLibraryQueue(queue.id).items
    queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' }).queue
    assert.equal(db.readLibraryQueue(queue.id).items[0].queueEntryId, original[3].queueEntryId)
    const document = db.exportDocument()
    document.tracks = [track('one'), track(remote.id, { title: 'Collision' })]
    db.replaceDocument(document)
    db.close()
    db = new LibraryDatabase(path)
    assert.throws(() => db.queryTracks(query), /expired/)
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'order',
      order: 'original'
    }).queue
    assert.equal(queue.index, 3)
    const items = db.readLibraryQueue(queue.id).items
    assert.deepEqual(
      items.map((t) => t.track?.title),
      ['one', 'Remote', undefined, 'Remote']
    )
    assert.equal(items[1].track?.streamUrl, undefined)
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'step',
      direction: -1,
      wrap: false
    }).queue
    assert.equal(queue.index, 1, 'step skips the deleted local file but not a remote member')
    const exported = db.exportPlaybackQueue(
      {
        id: queue.id,
        revision: queue.revision,
        entryId: queue.selectedEntryId!,
        index: queue.index
      },
      32000
    )
    assert.equal(exported.queue[1].source, 'ncm')
    assert.throws(
      () =>
        db.exportPlaybackQueue(
          {
            id: queue.id,
            revision: queue.revision,
            entryId: queue.selectedEntryId!,
            index: queue.index
          },
          100
        ),
      /未截断/
    )
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'remove',
      entryIds: [items[3].queueEntryId]
    }).queue
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queue_snapshots').get()?.n, 1)
    db.deleteLibraryQueue(queue.id, queue.revision)
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queue_snapshots').get()?.n, 0)
  } finally {
    db.close()
  }
})

test('v6 upgrade takes a WAL-consistent snapshot and preserves every old queue occurrence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'playlist-queue-upgrade-')),
    path = join(root, 'library.sqlite')
  const old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.replaceDocument({
    version: 2,
    revision: 6,
    tracks: [track('one')],
    folders: [],
    exclusions: []
  })
  const queue = old.createLibraryQueue({ ids: ['one', 'one'], sort: 'playlist' })
  const before = old.readLibraryQueue(queue.id)
  // Downgrade through the shared legacy fixture so the schema really looks
  // pre-v11 (catalog/metadata tables included); a bare user_version pragma
  // would collide with the v12 catalog DDL during the re-upgrade.
  old.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      // A real v6 file predates queue snapshots and the v8 queue/scan columns;
      // dropping them lets the v7/v8 upgrade steps recreate them.
      'DROP TABLE queue_snapshots; DROP INDEX IF EXISTS queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=6;'
  )
  const upgraded = new LibraryDatabase(path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()?.user_version, 30)
    assert.deepEqual(upgraded.readLibraryQueue(queue.id), before)
    const snapshot = new DatabaseSync(
      join(root, readdirSync(root).find((name) => name.includes('.v6-backup-'))!),
      { readOnly: true }
    )
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 6)
      assert.equal(snapshot.prepare('SELECT count(*) AS n FROM queue_entries').get()?.n, 2)
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})

test('v7 DDL errors roll back and snapshot failure prevents upgrades', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'playlist-queue-fault-')),
    path = join(root, 'library.sqlite'),
    old = new LibraryDatabase(path)
  t.after(() => {
    old.close()
    rmSync(root, { recursive: true, force: true })
  })
  old.sql.exec(
    'DROP TABLE queue_snapshots; DROP INDEX queues_state; ALTER TABLE queues DROP COLUMN state; ALTER TABLE queues DROP COLUMN play_mode; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=6;'
  )
  const exec = DatabaseSync.prototype.exec
  const fail = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('CREATE TABLE queue_snapshots')) {
        exec.call(this, 'CREATE TABLE partial_upgrade(id TEXT)')
        throw new Error('queue snapshot DDL fault')
      }
      return exec.call(this, sql)
    }
  )
  assert.throws(() => new LibraryDatabase(path), /DDL fault/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 6)
  assert.equal(
    old.sql.prepare("SELECT name FROM sqlite_master WHERE name='partial_upgrade'").get(),
    undefined
  )
  fail.mock.restore()
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'VACUUM INTO ?') throw new Error('SQLITE_FULL: backup failed')
    return prepare.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(path), /SQLITE_FULL/)
  assert.equal(old.sql.prepare('PRAGMA user_version').get()?.user_version, 6)
})

test('metadata commits rebuild only affected definitions and recording buckets, not unrelated playlist members', (t) => {
  const db = fixture(
    t,
    Array.from({ length: 405 }, (_, i) => track(String(i)))
  )
  const query = upload(
    db,
    Array.from({ length: 405 }, (_, i) => ({ id: String(i) }))
  )
  db.queryTracks(query)
  db.sql.exec(`CREATE TEMP TABLE member_insertions(seq INTEGER);
    CREATE TEMP TRIGGER record_insertions AFTER INSERT ON playlist_members BEGIN INSERT INTO member_insertions VALUES(new.seq); END;`)
  db.patchTracks([{ id: '300', expectedVersion: 1, patch: { title: 'Updated' } }])
  assert.equal(db.queryTracks({ ...query, offset: 200 }).tracks[100].title, 'Updated')
  assert.deepEqual(
    db.sql
      .prepare('SELECT seq FROM member_insertions')
      .all()
      .map((row) => row.seq),
    [300]
  )
  db.sql.exec('DELETE FROM member_insertions')
  // Listening projection does not dirty metadata or re-resolve the membership.
  db.syncListeningHistory({ kind: 'begin', id: 'h', mode: 'replace' })
  db.syncListeningHistory({
    kind: 'append',
    id: 'h',
    sequence: 1,
    entries: [{ id: '300', lastPlayed: 123 }]
  })
  db.syncListeningHistory({ kind: 'commit', id: 'h', sequence: 2 })
  assert.equal(
    db.queryTracks({ ...query, sort: 'lastPlayed', direction: 'desc' }).tracks[0].id,
    '300'
  )
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM member_insertions').get()?.n, 0)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_changes').get()?.n, 2)
  // Unrelated configuration versions must not cause an O(playlist size) rewrite.
  db.setLibraryRoots(['D:/Music'])
  db.queryTracks(query)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM member_insertions').get()?.n, 0)
})

test('recording fallback changes re-evaluate candidates without overwriting the immutable definition', (t) => {
  const db = fixture(t, [
    track('one', { title: 'Same', format: 'mp3' }),
    track('two', { title: 'Same', format: 'flac' })
  ])
  const query = upload(db, [
    { id: 'remote:1', snapshot: track('remote:1', { title: 'Same', source: 'remote' }) }
  ])
  assert.equal(db.queryTracks(query).tracks[0].id, 'two')
  db.patchTracks([{ id: 'two', expectedVersion: 1, patch: { title: 'Other' } }])
  assert.equal(db.queryTracks(query).tracks[0].id, 'one')
  db.patchTracks([{ id: 'two', expectedVersion: 2, patch: { title: 'Same' } }])
  assert.equal(db.queryTracks(query).tracks[0].id, 'two')
})

test('bounded change journal falls back to a complete rebuild after an old view misses its retained window', (t) => {
  const db = fixture(t),
    query = upload(db, [{ id: 'one' }, { id: 'two' }])
  db.queryTracks(query)
  // This is an intentional burst on the same file; only 4096 compact journal rows survive.
  db.sql.exec('BEGIN')
  const update = db.sql.prepare(
    "UPDATE tracks SET payload=json_set(payload,'$.custom',?) WHERE id='one'"
  )
  for (let i = 0; i < 2200; i++) update.run(i)
  db.sql.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'; COMMIT;")
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_changes').get()?.n, 4096)
  assert.equal(db.queryTracks(query).tracks[0].custom, 2199)
  assert.equal(db.queryTracks(query).total, 2)
})

test('cold preparation and duplicate-heavy deltas write at most 200 members per closed transaction', (t) => {
  const db = fixture(t),
    entries = Array.from({ length: 605 }, () => ({ id: 'one' })),
    first = upload(db, entries, 'first'),
    second = upload(
      db,
      entries.map(() => ({ id: 'two' })),
      'second'
    )
  db.sql.exec(`CREATE TEMP TABLE writes(kind TEXT);
    CREATE TEMP TRIGGER count_members_ai AFTER INSERT ON playlist_members BEGIN INSERT INTO writes VALUES('insert'); END;
    CREATE TEMP TRIGGER count_members_ad AFTER DELETE ON playlist_members BEGIN INSERT INTO writes VALUES('delete'); END;`)
  for (const query of [first, second]) {
    const prepared = db.preparePlaylistQuery(query)
    assert.equal(prepared.ready, false)
    assert.equal(db.sql.isTransaction, false)
  }
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_members').get()?.n, 400)
  // Two pending readers can help the same build without restarting its cursor.
  for (const query of [second, first]) {
    let ready = false
    for (let i = 0; i < 10 && !ready; i++) {
      db.sql.exec('DELETE FROM writes')
      ready = db.preparePlaylistQuery(query).ready
      const counts = db.sql.prepare('SELECT kind,count(*) AS n FROM writes GROUP BY kind').all()
      for (const count of counts) assert.ok(Number(count.n) <= 200)
      assert.equal(db.sql.isTransaction, false)
    }
    assert.equal(ready, true)
    assert.equal(db.queryTracks(query).total, 605)
    assert.equal(db.queryTracks(query).tracks[0].id, query === first ? 'one' : 'two')
  }
  db.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Updated' } }])
  let ready = false
  for (let i = 0; i < 10 && !ready; i++) {
    db.sql.exec('DELETE FROM writes')
    ready = db.preparePlaylistQuery(first).ready
    for (const row of db.sql.prepare('SELECT kind,count(*) AS n FROM writes GROUP BY kind').all())
      assert.ok(Number(row.n) <= 200, 'one changed ID can have more than one batch of occurrences')
    assert.equal(db.sql.isTransaction, false)
  }
  assert.equal(ready, true)
  assert.equal(db.queryTracks({ ...first, search: 'Updated' }).total, 605)
  db.sql.exec('DELETE FROM writes')
  db.queryTracks(second)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM writes').get()?.n, 0)
})

test('content changes and a later-batch failure cannot publish or reuse a partial projection', (t) => {
  const db = fixture(t),
    query = upload(
      db,
      Array.from({ length: 605 }, () => ({ id: 'one' }))
    )
  const first = db.preparePlaylistQuery(query)
  assert.equal(first.ready, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_members').get()?.n, 200)
  db.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'New revision' } }])
  assert.throws(
    () => db.preparePlaylistQuery({ ...query, contentRevision: first.revision }, first.token),
    /变化/
  )
  assert.equal(db.queryTracks().tracks[0].title, 'New revision')
  // A fresh request must start again, replacing even the first committed batch.
  assert.equal(db.preparePlaylistQuery(query).ready, false)
  db.sql.exec(`CREATE TEMP TRIGGER fail_later_batch BEFORE INSERT ON playlist_members
    WHEN new.seq=250 BEGIN SELECT RAISE(ABORT,'later batch fault'); END;`)
  assert.throws(() => db.queryTracks(query), /later batch fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_members').get()?.n, 200)
  db.sql.exec('DROP TRIGGER fail_later_batch')
  const result = db.queryTracks({ ...query, search: 'New revision' })
  assert.equal(result.total, 605)
  assert.equal(
    result.tracks.every((track) => track.title === 'New revision'),
    true
  )
})

test('drop cleanup is bounded, occupies a resource slot until complete, and fences a reused handle', (t) => {
  const db = fixture(t),
    query = upload(
      db,
      Array.from({ length: 605 }, () => ({ id: 'one' }))
    )
  const prepared = db.preparePlaylistQuery(query)
  assert.equal(prepared.ready, false)
  const token = prepared.token
  const queue = db.createLibraryQueue(query)
  const countRows = () =>
    Number(
      db.sql
        .prepare(
          `SELECT
    (SELECT count(*) FROM playlist_members)+(SELECT count(*) FROM playlist_definitions) AS n`
        )
        .get()?.n
    )
  const before = countRows()
  db.syncPlaylistView({ kind: 'drop', id: 'view' })
  assert.equal(before - countRows(), 200)
  assert.throws(() => db.queryTracks(query), /expired/)
  // An unknown drop must not reserve a tombstone behind another large release.
  db.syncPlaylistView({ kind: 'drop', id: 'never-uploaded' })
  assert.doesNotThrow(() =>
    db.syncPlaylistView({ kind: 'begin', id: 'never-uploaded', versions: [] })
  )
  assert.throws(() => db.syncPlaylistView({ kind: 'begin', id: 'view', versions: [] }), /released/)
  let steps = 0
  while (db.needsQueryMaintenance && steps++ < 10) {
    const previous = countRows()
    db.maintainQueryState()
    assert.ok(previous - countRows() <= 200)
    assert.equal(db.sql.isTransaction, false)
  }
  assert.equal(db.needsQueryMaintenance, false)
  assert.equal(countRows(), 0)
  assert.equal(db.readLibraryQueue(queue.id).total, 605)
  upload(db, [{ id: 'two' }])
  assert.throws(() => db.preparePlaylistQuery(query, token), /expired/)
  assert.equal(db.queryTracks(query).tracks[0].id, 'two')
})

test('expired builds and failed cleanup retain no queryable partial view or reusable dirty identity', (t) => {
  const db = fixture(t),
    query = upload(
      db,
      Array.from({ length: 605 }, () => ({ id: 'one' }))
    )
  db.preparePlaylistQuery(query)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 11 * 60_000)
  assert.throws(() => db.preparePlaylistQuery(query), /expired/)
  db.sql.exec(`CREATE TEMP TRIGGER fail_cleanup BEFORE DELETE ON playlist_members
    BEGIN SELECT RAISE(ABORT,'cleanup fault'); END;`)
  assert.throws(() => db.maintainQueryState(), /cleanup fault/)
  assert.equal(db.sql.isTransaction, false)
  assert.equal(db.needsQueryMaintenance, true)
  db.sql.exec('DROP TRIGGER fail_cleanup')
  for (let steps = 0; steps < 10 && db.needsQueryMaintenance; steps++) db.maintainQueryState()
  assert.equal(db.needsQueryMaintenance, false)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM playlist_members').get()?.n, 0)
})
