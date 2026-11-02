import { LEGACY_QUEUE_SCHEMA_SQL } from './legacyQueueSchema.fixture.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryDatabase, openLibraryDatabase, getLibraryDatabasePath } from './libraryDatabase.ts'
import type {
  LibraryQuery,
  LibraryScanCommit,
  LibraryTrackRecord
} from '../../shared/libraryDatabase.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'library-db-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, json: join(root, 'music-library.json') }
}
function track(root: string, id = 'one', extra: Record<string, unknown> = {}): LibraryTrackRecord {
  return {
    id,
    filePath: join(root, `${id}.flac`),
    fileName: `${id}.flac`,
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 200,
    addedAt: 42,
    ...extra
  }
}
function seed(db: LibraryDatabase, root: string, tracks: LibraryTrackRecord[]) {
  db.replaceDocument({ version: 2, revision: 1, tracks, folders: [root], exclusions: [] })
}
function memory(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  return db
}
function claimBatch(db: LibraryDatabase, batch: LibraryScanCommit) {
  db.recordScanFiles(
    batch.jobId,
    batch.files.map((file) => file.identity)
  )
  db.claimScanFiles(batch.jobId)
}

test('migration preserves original identities, extension data, revisions and exclusions', async (t) => {
  const { root, json } = fixture(t)
  const kept = track(root, 'a', { versionGroupId: 'release-1', custom: { values: [1, 2, 3] } })
  const removed = track(root, 'excluded')
  const source = JSON.stringify({
    version: 2,
    revision: 71,
    tracks: [kept, removed],
    folders: [root],
    exclusions: [removed.filePath]
  })
  writeFileSync(json, source)
  writeFileSync(`${json}.bak`, 'unchanged-backup')
  const db = await openLibraryDatabase(json)
  try {
    assert.deepEqual(db.getTracksByIds(['a']).tracks, [kept])
    assert.equal(db.getMetadata().revision, 71)
    assert.equal(db.getMetadata().trackCount, 1)
    assert.equal(db.getMetadata().exclusions[0].filePath, removed.filePath)
    assert.equal(readFileSync(json, 'utf8'), source)
    assert.equal(readFileSync(`${json}.bak`, 'utf8'), 'unchanged-backup')
    assert.equal(existsSync(`${getLibraryDatabasePath(json)}.migrating`), false)
  } finally {
    db.close()
  }
})

test('legacy arrays migrate; invalid libraries never install an empty DB or choose a stale backup', async (t) => {
  const { root, json } = fixture(t)
  writeFileSync(json, '[{"id":"broken"}]')
  writeFileSync(`${json}.bak`, JSON.stringify([track(root, 'stale')]))
  await assert.rejects(openLibraryDatabase(json), /migration failed/)
  assert.equal(existsSync(getLibraryDatabasePath(json)), false)
  writeFileSync(json, JSON.stringify([track(root)]))
  const db = await openLibraryDatabase(json)
  try {
    assert.equal(db.getMetadata().trackCount, 1)
  } finally {
    db.close()
  }
})

test('bad or unrelated file indexes cannot invalidate a valid library or authorize metadata skips', async (t) => {
  const { root, json } = fixture(t)
  writeFileSync(
    json,
    JSON.stringify({ version: 2, revision: 9, tracks: [track(root)], folders: [root] })
  )
  writeFileSync(join(root, 'music-library-file-index.json'), '{"entries":[],"version":')
  const db = await openLibraryDatabase(json)
  try {
    assert.equal(db.getMetadata().trackCount, 1)
    assert.deepEqual(db.getFileIdentities(), [])
  } finally {
    db.close()
  }
})

test('only a fully valid same-revision index retains metadata versions; stale indexes provide discovery only', async (t) => {
  const { root, json } = fixture(t),
    item = track(root)
  const source = JSON.stringify({ version: 2, revision: 9, tracks: [item], folders: [root] })
  const index = join(root, 'music-library-file-index.json')
  for (const scenario of [
    { revision: 9, version: 1, updatedAt: '2026-10-18', trusted: true },
    { revision: 8, version: 1, updatedAt: '2026-10-18', trusted: false },
    { revision: 9, version: '1', updatedAt: '2026-10-18', trusted: false },
    { revision: 9, version: 1, updatedAt: undefined, trusted: false }
  ]) {
    writeFileSync(json, source)
    writeFileSync(
      index,
      JSON.stringify({
        entries: [{ filePath: item.filePath, size: 12, mtimeMs: 3, metadataVersion: 1 }],
        libraryRevision: scenario.revision,
        version: scenario.version,
        updatedAt: scenario.updatedAt
      })
    )
    const db = await openLibraryDatabase(json)
    try {
      assert.equal(db.getFileIdentities().length, scenario.trusted ? 1 : 0)
      assert.equal(db.getMetadata().fileCount, 1)
    } finally {
      db.close()
    }
    // Exact test-created files, never the user's library or a recursive parent.
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(`${getLibraryDatabasePath(json)}${suffix}`, { force: true })
  }
})

test('embedded supported covers are externalized while original JSON and extension fields remain intact', async (t) => {
  const { root, json } = fixture(t)
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64'
  )
  const item = track(root, 'image', {
    cover: `data:image/png;base64,${bytes.toString('base64')}`,
    extension: 'kept'
  })
  writeFileSync(json, JSON.stringify([item]))
  const db = await openLibraryDatabase(json)
  try {
    const migrated = db.getTracksByIds(['image']).tracks[0]
    assert.match(String(migrated.cover), /^cover:\/\/[a-f0-9]{24}\.png$/)
    assert.deepEqual(
      readFileSync(join(root, 'cover-cache', String(migrated.cover).replace('cover://', ''))),
      bytes
    )
    assert.equal(migrated.extension, 'kept')
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), [item])
  } finally {
    db.close()
  }
})

test('legacy GIF87a and GIF89a covers migrate without changing source records or image bytes', async (t) => {
  for (const signature of ['GIF87a', 'GIF89a']) {
    await t.test(signature, async (t) => {
      const { root, json } = fixture(t)
      const bytes = Buffer.from(
        'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'base64'
      )
      bytes.write(signature, 0, 'ascii')
      const item = track(root, 'gif', {
        cover: `data:image/gif;base64,${bytes.toString('base64')}`,
        extension: { source: 'legacy' }
      })
      const source = JSON.stringify([item])
      writeFileSync(json, source)
      const db = await openLibraryDatabase(json)
      try {
        const migrated = db.getTracksByIds(['gif']).tracks[0]
        assert.match(String(migrated.cover), /^cover:\/\/[a-f0-9]{24}\.gif$/)
        assert.deepEqual(
          readFileSync(join(root, 'cover-cache', String(migrated.cover).replace('cover://', ''))),
          bytes
        )
        assert.deepEqual(migrated, { ...item, cover: migrated.cover })
        assert.equal(readFileSync(json, 'utf8'), source)
      } finally {
        db.close()
      }
    })
  }
})

test('a GIF MIME label cannot admit an unrecognized image signature during migration', async (t) => {
  const { root, json } = fixture(t)
  const source = JSON.stringify([
    track(root, 'bad-gif', {
      cover: `data:image/gif;base64,${Buffer.from('GIF90a-invalid').toString('base64')}`
    })
  ])
  writeFileSync(json, source)
  await assert.rejects(openLibraryDatabase(json), /Unsupported embedded library cover/)
  assert.equal(existsSync(getLibraryDatabasePath(json)), false)
  assert.equal(readFileSync(json, 'utf8'), source)
})

test('existing database is authoritative and corruption never triggers JSON fallback', async (t) => {
  const { root, json } = fixture(t)
  writeFileSync(json, JSON.stringify([track(root)]))
  const db = await openLibraryDatabase(json)
  db.close()
  writeFileSync(getLibraryDatabasePath(json), 'not a database')
  await assert.rejects(openLibraryDatabase(json), /database/)
  assert.equal(readFileSync(getLibraryDatabasePath(json), 'utf8'), 'not a database')
})

test('queries preserve substring, short Chinese and pinyin matching, and hydrate only a page', (t) => {
  const db = memory(t)
  seed(db, 'C:/music', [
    track('C:/music'),
    track('C:/music', 'two', {
      title: 'Second Song',
      artist: 'Other Artist',
      album: 'Other Album',
      fileName: 'hidden-name.flac'
    })
  ])
  for (const search of ['晴', '晴 天', 'qT', 'zjl', 'econd'])
    assert.equal(db.queryTracks({ search }).total, 1, search)
  assert.equal(db.queryTracks({ search: 'hidden' }).total, 0)
  assert.equal(db.queryTracks({ search: 'hidden', searchFileName: true }).total, 1)
  const page = db.queryTracks({ limit: 1, offset: 1, sort: 'duration' })
  assert.equal(page.total, 2)
  assert.equal(page.tracks.length, 1)
  assert.equal(Object.keys(page.versions).length, 1)
})

test('unfiltered insertion pages skip large payload rows through the sequence index without changing ordering or versions', (t) => {
  const db = memory(t)
  seed(
    db,
    'C:/music',
    Array.from({ length: 605 }, (_, index) =>
      track('C:/music', `t${index}`, {
        title: index % 2 ? 'Selected' : 'Other',
        custom: { index }
      })
    )
  )
  const prepared: string[] = [],
    prepare = db.sql.prepare.bind(db.sql)
  t.mock.method(db.sql, 'prepare', (sql: string) => {
    prepared.push(sql)
    return prepare(sql)
  })
  const queries: LibraryQuery[] = [
    { sort: 'insertion', direction: 'asc' },
    { sort: 'insertion', direction: 'desc' },
    { sort: 'playlist', direction: 'desc' }
  ]
  for (const query of queries) {
    const descending = query.sort !== 'playlist' && query.direction === 'desc'
    const expected = prepare(
      `SELECT id,payload,version FROM tracks ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT 200 OFFSET 401`
    ).all()
    const page = db.queryTracks({ ...query, offset: 401, limit: 200 })
    assert.deepEqual(
      page.tracks,
      expected.map((row) => JSON.parse(String(row.payload)))
    )
    assert.deepEqual(
      Object.entries(page.versions),
      expected.map((row) => [row.id, row.version])
    )
    assert.equal(page.offset, 401)
    assert.equal(page.total, 605)
    assert.equal(page.totalDuration, 605 * 200)
    const sql = prepared.findLast((sql) => sql.startsWith('SELECT id,payload,version FROM tracks'))!
    assert.match(sql, /INDEXED BY tracks_insertion/)
    assert.ok(
      prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(200, 401)
        .some((row) => String(row.detail).includes('USING INDEX tracks_insertion'))
    )
    assert.equal(db.queryTracks({ ...query, offset: 605, limit: 200 }).tracks.length, 0)
  }
  const filtered = db.queryTracks({
    sort: 'insertion',
    direction: 'desc',
    search: 'Selected',
    offset: 5,
    limit: 7
  })
  assert.deepEqual(
    filtered.tracks.map((row) => row.id),
    ['t593', 't591', 't589', 't587', 't585', 't583', 't581']
  )
  assert.deepEqual(
    db.queryTracks({ sort: 'playlist', ids: ['t604', 't1', 't604'] }).tracks.map((row) => row.id),
    ['t604', 't1', 't604']
  )
})

test('metadata counts include pending identities and transaction changes without a content revision bump', (t) => {
  const db = memory(t)
  seed(db, 'C:/music', [track('C:/music')])
  const before = db.getMetadata()
  db.sql.exec('BEGIN')
  try {
    db.sql
      .prepare('INSERT INTO files(file_key,file_path) VALUES(?,?)')
      .run('pending', 'C:/music/pending.flac')
    assert.deepEqual(db.getMetadata(), { ...before, fileCount: before.fileCount + 1 })
    const plan = db.sql.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM files').all()
    assert.ok(plan.some((row) => String(row.detail).includes('COVERING INDEX files_count')))
    db.sql.prepare('DELETE FROM files WHERE file_key=?').run('pending')
    assert.deepEqual(db.getMetadata(), before)
  } finally {
    db.sql.exec('ROLLBACK')
  }
  assert.deepEqual(db.getMetadata(), before)
})

test('opening an existing v9 library adds compact read indexes without changing metadata or stored records', (t) => {
  const { root, json } = fixture(t),
    file = getLibraryDatabasePath(json)
  const original = new LibraryDatabase(file)
  seed(original, root, [track(root, 'retained', { custom: { unchanged: true } })])
  const metadata = original.getMetadata(),
    page = original.getTracksByIds(['retained'])
  original.sql.exec(
    LEGACY_QUEUE_SCHEMA_SQL +
      'DROP INDEX tracks_insertion; DROP INDEX files_count; DROP INDEX scan_checkpoint_cleanup; ALTER TABLE scan_jobs DROP COLUMN checked_files; ALTER TABLE scan_jobs DROP COLUMN checkpoints_reclaimed; PRAGMA user_version=9;'
  )
  original.close()
  const reopened = new LibraryDatabase(file)
  try {
    assert.deepEqual(reopened.getMetadata(), metadata)
    assert.deepEqual(reopened.getTracksByIds(['retained']), page)
    assert.equal(reopened.sql.prepare('PRAGMA user_version').get()!.user_version, 30)
    for (const name of ['tracks_insertion', 'files_count'])
      assert.ok(
        reopened.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name)
      )
  } finally {
    reopened.close()
  }
})

test('optimistic patches are atomic and stale requests cannot overwrite newer metadata', (t) => {
  const db = memory(t)
  seed(db, 'C:/music', [track('C:/music'), track('C:/music', 'two')])
  const version = db.getTracksByIds(['one']).versions.one
  assert.throws(
    () =>
      db.patchTracks([
        { id: 'one', expectedVersion: version, patch: { title: 'must roll back' } },
        { id: 'two', expectedVersion: 99, patch: { title: 'bad' } }
      ]),
    /concurrently/
  )
  assert.equal(db.getTracksByIds(['one']).tracks[0].title, '晴天')
  const changed = db.patchTracks([
    { id: 'one', expectedVersion: version, patch: { title: 'Changed' } }
  ])
  assert.equal(changed.versions.one, version + 1)
  assert.throws(
    () => db.patchTracks([{ id: 'one', expectedVersion: version, patch: { title: 'stale' } }]),
    /concurrently/
  )
  assert.equal(db.queryTracks({ search: 'Changed' }).total, 1)
})

test('CUE rebuilds retain identity/addedAt/extension fields and monotonically increase versions', (t) => {
  const { root } = fixture(t),
    db = memory(t)
  const audio = join(root, 'disc.flac')
  writeFileSync(audio, 'fixture')
  const cue = join(root, 'disc.cue')
  const original = track(root, 'old', {
    filePath: audio,
    cueSheetPath: cue,
    trackNumber: 1,
    cueRange: { startSeconds: 0, endSeconds: 20 },
    custom: 'retained'
  })
  seed(db, root, [original])
  db.startScan({ id: 'job', roots: [root], mode: 'startup' })
  const info = statSync(audio)
  const batch: LibraryScanCommit = {
    jobId: 'job',
    sequence: 1,
    files: [
      {
        identity: { filePath: audio, size: info.size, mtimeMs: info.mtimeMs },
        metadataRead: true,
        tracks: [
          {
            ...original,
            id: 'new-parser-id',
            addedAt: 999,
            cueRange: { startSeconds: 0, endSeconds: 30 },
            title: 'New CUE'
          }
        ]
      }
    ]
  }
  const before = db.getTracksByIds(['old'])
  claimBatch(db, batch)
  const result = db.commitScanBatch(batch)
  const after = db.getTracksByIds(['old'])
  assert.equal(after.tracks[0].addedAt, 42)
  assert.equal(after.tracks[0].custom, 'retained')
  assert.equal(after.versions.old, before.versions.old + 1)
  assert.equal(db.getTracksByIds(['new-parser-id']).tracks.length, 0)
  assert.equal(db.commitScanBatch(batch).revision, result.revision)
  assert.equal(db.listScanJobs()[0].committedFiles, 1)
})

test('stale file results, removed roots and exclusions cannot resurrect songs', (t) => {
  const { root } = fixture(t),
    db = memory(t)
  const item = track(root)
  writeFileSync(item.filePath, 'old')
  seed(db, root, [])
  db.startScan({ id: 'job', roots: [root], mode: 'full' })
  const info = statSync(item.filePath)
  const batch: LibraryScanCommit = {
    jobId: 'job',
    sequence: 1,
    files: [
      {
        identity: { filePath: item.filePath, size: info.size, mtimeMs: info.mtimeMs },
        metadataRead: true,
        tracks: [item]
      }
    ]
  }
  claimBatch(db, batch)
  writeFileSync(item.filePath, 'changed bytes')
  assert.equal(db.commitScanBatch(batch).trackCount, 0)
  seed(db, root, [])
  const nextInfo = statSync(item.filePath)
  batch.files[0].identity = {
    filePath: item.filePath,
    size: nextInfo.size,
    mtimeMs: nextInfo.mtimeMs
  }
  batch.sequence++
  claimBatch(db, batch)
  db.replaceDocument({ version: 2, revision: 1, folders: [], tracks: [], exclusions: [] })
  assert.equal(db.commitScanBatch(batch).trackCount, 0)
})

test('frozen queue retains ordering and entry identity after metadata edits or deletion', (t) => {
  const db = memory(t)
  seed(db, 'C:/music', [
    track('C:/music', 'one', { duration: 1 }),
    track('C:/music', 'two', { duration: 2 })
  ])
  const queue = db.createLibraryQueue({ sort: 'duration', direction: 'desc' }, 'one')
  assert.equal(queue.index, 1)
  const initial = db.readLibraryQueue(queue.id)
  seed(db, 'C:/music', [track('C:/music', 'one', { duration: 10 })])
  const next = db.readLibraryQueue(queue.id)
  assert.equal(next.items[0].track, null)
  assert.deepEqual(
    next.items.map((item) => item.queueEntryId),
    initial.items.map((item) => item.queueEntryId)
  )
  assert.equal(next.items[1].track?.id, 'one')
})

test('online SQLite backup includes committed WAL data and can be opened independently', async (t) => {
  const { root } = fixture(t)
  const db = new LibraryDatabase(join(root, 'source.sqlite'))
  try {
    seed(db, root, [track(root)])
    const path = join(root, 'consistent.sqlite')
    await db.backupTo(path)
    const restored = new LibraryDatabase(path)
    try {
      assert.deepEqual(restored.exportDocument(), db.exportDocument())
    } finally {
      restored.close()
    }
  } finally {
    db.close()
  }
})

test('content-fenced queries freeze the displayed search version and reject stale queues before writing', (t) => {
  const db = memory(t)
  seed(db, 'D:/Music', [track('D:/Music', 'one')])
  const query = {
    search: 'zjl',
    sort: 'playlist' as const,
    contentRevision: db.getMetadata().revision
  }
  assert.equal(db.queryTracks(query).total, 1)
  assert.equal(db.queryCollections('albums', query).total, 1)
  const queue = db.createLibraryQueue(query, 'one')
  assert.equal(queue.total, 1)
  db.patchTracks([{ id: 'one', expectedVersion: 1, patch: { title: 'Edited' } }])
  const before = db.sql.prepare('SELECT count(*) AS n FROM queues').get()?.n
  assert.throws(() => db.queryTracks(query), /发生变化/)
  assert.throws(() => db.queryCollections('albums', query), /发生变化/)
  assert.throws(() => db.createLibraryQueue(query, 'one'), /发生变化/)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM queues').get()?.n, before)
  assert.equal(
    db.queryTracks({ search: 'zjl' }).total,
    1,
    'legacy callers need no new precondition'
  )
  assert.equal(db.createLibraryQueue({ search: 'zjl' }, 'one').total, 1)
  for (const contentRevision of [-1, 1.5, '1', NaN])
    assert.throws(() => db.createLibraryQueue({ contentRevision } as never), /content revision/)
})


test('a 0-byte SQLite file left by an interrupted creation initializes cleanly on next launch', (t) => {
  const { root } = fixture(t)
  const dbPath = join(root, 'empty-after-bsod.sqlite')
  writeFileSync(dbPath, '')
  const db = new LibraryDatabase(dbPath)
  try {
    assert.equal(db.getMetadata().trackCount, 0)
  } finally {
    db.close()
  }
})
