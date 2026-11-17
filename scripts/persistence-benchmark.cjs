/*
 * Persistence backend benchmark (JSON atomic envelope vs SQLite).
 *
 * This is intentionally an evaluation harness, not a production persistence
 * layer. It compares a JSON atomic-envelope model that follows the app's
 * jsonFile/VersionedDataStore semantics with a Node built-in SQLite prototype.
 */
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { DatabaseSync } = require('node:sqlite')

const DEFAULTS = Object.freeze({
  sizes: [5000, 20000, 50000],
  playlistCount: 100,
  playlistSize: 500,
  sessionSize: 20000,
  statsSize: 1000,
  iterations: 7
})

function usage() {
  return `Usage: node --expose-gc scripts/persistence-benchmark.cjs --output <result.json>

Options:
  --sizes <comma-separated tracks>  Default: 5000,20000,50000
  --playlist-count <n>              Default: 100
  --playlist-size <n>               Default: 500
  --session-size <n>                Default: 20000
  --stats-size <n>                  Default: 1000
  --iterations <n>                  Default: 7
  --work-dir <dir>                  Retain generated primary/backup files for inspection
  --help
`
}

function parsePositiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${name} must be a positive integer`)
  return number
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, output: null, workDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') return { help: true }
    const value = argv[index + 1]
    if (!arg.startsWith('--') || value === undefined)
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    index += 1
    if (arg === '--output') options.output = path.resolve(value)
    else if (arg === '--work-dir') options.workDir = path.resolve(value)
    else if (arg === '--sizes') {
      options.sizes = value.split(',').map((entry) => parsePositiveInteger(entry.trim(), '--sizes'))
      if (options.sizes.length === 0) throw new Error('--sizes must not be empty')
    } else if (arg === '--playlist-count') options.playlistCount = parsePositiveInteger(value, arg)
    else if (arg === '--playlist-size') options.playlistSize = parsePositiveInteger(value, arg)
    else if (arg === '--session-size') options.sessionSize = parsePositiveInteger(value, arg)
    else if (arg === '--stats-size') options.statsSize = parsePositiveInteger(value, arg)
    else if (arg === '--iterations') options.iterations = parsePositiveInteger(value, arg)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.output) throw new Error('--output is required')
  return options
}

function nowIso() {
  return new Date().toISOString()
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function emptyDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  for (const entry of fs.readdirSync(directory))
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true })
}

function forceGc() {
  if (typeof global.gc === 'function') global.gc()
}

function rssBytes() {
  return process.memoryUsage().rss
}

function metric(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
  return {
    samplesMs: samples.map((value) => Number(value.toFixed(3))),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3))
  }
}

function measure(iterations, operation, peak, setup, verify) {
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    forceGc()
    const context = setup ? setup(index) : undefined
    const start = performance.now()
    operation(context, index)
    samples.push(performance.now() - start)
    peak.value = Math.max(peak.value, rssBytes())
    verify?.(context, index)
  }
  return metric(samples)
}

function deterministicTrack(index) {
  const padded = String(index).padStart(6, '0')
  return {
    id: `local:benchmark-${padded}`,
    title: `Benchmark Track ${padded}`,
    artist: `Artist ${index % 173}`,
    album: `Album ${index % 419}`,
    duration: 120 + (index % 300),
    source: 'local',
    path: `D:/Benchmark Library/${index % 173}/track-${padded}.flac`,
    addedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    metadata: {
      sampleRate: index % 2 === 0 ? 44100 : 96000,
      bitDepth: index % 3 === 0 ? 24 : 16,
      format: index % 5 === 0 ? 'FLAC' : 'MP3',
      genre: `Genre ${index % 23}`,
      coverKey: `cover-${index % 811}`
    }
  }
}

function makeFixture(trackCount, options) {
  const tracks = Array.from({ length: trackCount }, (_, index) => deterministicTrack(index))
  const playlists = Array.from({ length: options.playlistCount }, (_, playlistIndex) => ({
    id: `playlist-${String(playlistIndex).padStart(3, '0')}`,
    name: `Benchmark Playlist ${playlistIndex}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    trackIds: Array.from(
      { length: options.playlistSize },
      (_, trackIndex) =>
        tracks[(playlistIndex * options.playlistSize + trackIndex) % tracks.length].id
    )
  }))
  const queue = Array.from({ length: options.sessionSize }, (_, index) => {
    const track = tracks[index % tracks.length]
    return {
      trackId: track.id,
      snapshot: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        source: track.source
      }
    }
  })
  const stats = Object.fromEntries(
    Array.from({ length: Math.min(options.statsSize, tracks.length) }, (_, index) => [
      tracks[index].id,
      {
        playCount: index % 31,
        totalSeconds: (index % 31) * 211,
        lastPlayedAt: `2026-02-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`
      }
    ])
  )
  return {
    library: { schemaVersion: 1, tracks },
    playlists: { schemaVersion: 1, playlists },
    session: { schemaVersion: 2, revision: 7, currentIndex: Math.floor(queue.length / 3), queue },
    stats: { schemaVersion: 1, entries: stats }
  }
}

const JSON_DOCUMENTS = Object.freeze(['library', 'playlists', 'session', 'stats'])

function jsonFile(directory, document) {
  return path.join(directory, `${document}.json`)
}

function envelope(document, revision) {
  return {
    version: 2,
    revision,
    savedAt: '2026-07-17T00:00:00.000Z',
    data: document
  }
}

/*
 * This deliberately mirrors the app's jsonFile write shape: validate/encode
 * first, write a sibling temporary file, retain the preceding primary as a
 * backup, then rename the temporary file into place. It is a synchronous Node
 * evaluation model, so it does not claim fsync durability or an atomic commit
 * across the four independent documents.
 */
function writeJsonEnvelopeAtomic(directory, document, value, revision) {
  const filePath = jsonFile(directory, document)
  const temporaryPath = `${filePath}.tmp`
  const backupPath = `${filePath}.bak`
  const encoded = JSON.stringify(envelope(value, revision))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(temporaryPath, encoded, 'utf8')
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath)
  try {
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    if (!fs.existsSync(filePath)) throw error
    fs.rmSync(filePath, { force: true })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
  if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath)
}

function writeJsonDocuments(directory, documents, revisions = {}) {
  for (const document of JSON_DOCUMENTS) {
    writeJsonEnvelopeAtomic(directory, document, documents[document], revisions[document] ?? 0)
  }
}

function loadJsonDocuments(directory) {
  const documents = {}
  for (const document of JSON_DOCUMENTS) {
    const parsed = JSON.parse(fs.readFileSync(jsonFile(directory, document), 'utf8'))
    assert.equal(parsed.version, 2, `${document} envelope version`)
    assert.ok(
      Number.isSafeInteger(parsed.revision) && parsed.revision >= 0,
      `${document} envelope revision`
    )
    documents[document] = parsed.data
  }
  return documents
}

function assertEquivalent(documents, expected, message = 'persistence documents') {
  assert.deepStrictEqual(documents, expected, message)
}

function cloneDocuments(documents) {
  return structuredClone(documents)
}

function mutateSingle(documents) {
  const entry = documents.stats.entries[Object.keys(documents.stats.entries)[0]]
  entry.playCount += 1
  entry.totalSeconds += 210
  entry.lastPlayedAt = '2026-07-17T00:00:00.000Z'
}

function mutateBulk(documents) {
  const tracks = documents.library.tracks
  for (let index = 0; index < Math.min(500, tracks.length); index += 1)
    tracks[index].metadata.genre = `Updated Genre ${index % 13}`
  for (const playlist of documents.playlists.playlists) {
    playlist.trackIds.splice(0, 0, tracks[playlist.trackIds.length % tracks.length].id)
    playlist.trackIds.pop()
  }
  for (const entry of Object.values(documents.stats.entries)) {
    entry.playCount += 1
    entry.totalSeconds += 180
  }
  documents.session.revision += 1
  documents.session.currentIndex =
    (documents.session.currentIndex + 250) % documents.session.queue.length
}

function bulkMutationResult(fixture) {
  const expected = cloneDocuments(fixture)
  mutateBulk(expected)
  return expected
}

function benchmarkJson(directory, fixture, options) {
  emptyDirectory(directory)
  writeJsonDocuments(directory, fixture)
  const peak = { value: rssBytes() }
  const singleExpected = cloneDocuments(fixture)
  mutateSingle(singleExpected)
  const bulkExpected = bulkMutationResult(fixture)
  const metrics = {
    parseLoad: measure(
      options.iterations,
      () => assertEquivalent(loadJsonDocuments(directory), fixture),
      peak
    ),
    serializeFull: measure(
      options.iterations,
      () => {
        for (const document of JSON_DOCUMENTS) JSON.stringify(envelope(fixture[document], 0))
      },
      peak
    ),
    singleUpdate: measure(
      options.iterations,
      (documents) => {
        mutateSingle(documents)
        writeJsonEnvelopeAtomic(directory, 'stats', documents.stats, 1)
      },
      peak,
      () => {
        writeJsonDocuments(directory, fixture)
        return cloneDocuments(fixture)
      },
      () =>
        assertEquivalent(loadJsonDocuments(directory), singleExpected, 'JSON single update result')
    ),
    bulkUpdate: measure(
      options.iterations,
      (documents) => {
        mutateBulk(documents)
        for (const document of JSON_DOCUMENTS)
          writeJsonEnvelopeAtomic(directory, document, documents[document], 1)
      },
      peak,
      () => {
        writeJsonDocuments(directory, fixture)
        return cloneDocuments(fixture)
      },
      () => assertEquivalent(loadJsonDocuments(directory), bulkExpected, 'JSON bulk update result')
    ),
    backupRecovery: measure(
      options.iterations,
      () => {
        fs.writeFileSync(jsonFile(directory, 'session'), '{broken')
        let recovered
        try {
          recovered = JSON.parse(fs.readFileSync(jsonFile(directory, 'session'), 'utf8')).data
        } catch {
          recovered = JSON.parse(
            fs.readFileSync(`${jsonFile(directory, 'session')}.bak`, 'utf8')
          ).data
          fs.copyFileSync(`${jsonFile(directory, 'session')}.bak`, jsonFile(directory, 'session'))
        }
        assert.deepStrictEqual(recovered, fixture.session, 'JSON recovered session')
      },
      peak,
      () => {
        emptyDirectory(directory)
        writeJsonDocuments(directory, fixture)
      }
    )
  }
  return {
    backend: 'json-atomic-envelope-evaluation',
    metrics,
    primaryDiskBytes: JSON_DOCUMENTS.reduce(
      (total, document) => total + fs.statSync(jsonFile(directory, document)).size,
      0
    ),
    backupDiskBytes: JSON_DOCUMENTS.reduce(
      (total, document) => total + fs.statSync(`${jsonFile(directory, document)}.bak`).size,
      0
    ),
    peakRssBytes: peak.value,
    representation:
      'Four renderer-shaped versioned JSON envelopes written through a jsonFile-like temporary-file, backup, and rename path. This measures per-document atomic replacement only; it does not claim fsync durability or a cross-document transaction.'
  }
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL, duration INTEGER NOT NULL, source TEXT NOT NULL, path TEXT NOT NULL, added_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE playlist_tracks (playlist_id TEXT NOT NULL, position INTEGER NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY (playlist_id, position));
    CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE session_queue (position INTEGER PRIMARY KEY, track_id TEXT NOT NULL, snapshot_json TEXT NOT NULL);
    CREATE TABLE stats (track_id TEXT PRIMARY KEY, play_count INTEGER NOT NULL, total_seconds INTEGER NOT NULL, last_played_at TEXT NOT NULL);
  `)
}

function seedSqlite(databasePath, fixture) {
  fs.rmSync(databasePath, { force: true })
  const db = new DatabaseSync(databasePath)
  createSchema(db)
  const insertTrack = db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insertPlaylist = db.prepare('INSERT INTO playlists VALUES (?, ?, ?)')
  const insertPlaylistTrack = db.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?)')
  const insertSessionState = db.prepare('INSERT INTO session_state VALUES (?, ?)')
  const insertQueue = db.prepare('INSERT INTO session_queue VALUES (?, ?, ?)')
  const insertStat = db.prepare('INSERT INTO stats VALUES (?, ?, ?, ?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const track of fixture.library.tracks) {
      insertTrack.run(
        track.id,
        track.title,
        track.artist,
        track.album,
        track.duration,
        track.source,
        track.path,
        track.addedAt,
        JSON.stringify(track.metadata)
      )
    }
    for (const playlist of fixture.playlists.playlists) {
      insertPlaylist.run(playlist.id, playlist.name, playlist.createdAt)
      playlist.trackIds.forEach((trackId, position) =>
        insertPlaylistTrack.run(playlist.id, position, trackId)
      )
    }
    insertSessionState.run('schemaVersion', String(fixture.session.schemaVersion))
    insertSessionState.run('revision', String(fixture.session.revision))
    insertSessionState.run('currentIndex', String(fixture.session.currentIndex))
    fixture.session.queue.forEach((entry, position) =>
      insertQueue.run(position, entry.trackId, JSON.stringify(entry.snapshot))
    )
    for (const [trackId, entry] of Object.entries(fixture.stats.entries))
      insertStat.run(trackId, entry.playCount, entry.totalSeconds, entry.lastPlayedAt)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original SQLite error is more useful than a failed cleanup after
      // an implicit rollback.
    }
    throw error
  } finally {
    db.close()
  }
}

function loadSqliteDocuments(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const tracks = db
      .prepare('SELECT * FROM tracks ORDER BY id')
      .all()
      .map((row) => ({
        id: row.id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        duration: row.duration,
        source: row.source,
        path: row.path,
        addedAt: row.added_at,
        metadata: JSON.parse(row.metadata_json)
      }))
    const memberships = new Map()
    for (const row of db
      .prepare(
        'SELECT playlist_id, position, track_id FROM playlist_tracks ORDER BY playlist_id, position'
      )
      .all()) {
      const ids = memberships.get(row.playlist_id) || []
      ids.push(row.track_id)
      memberships.set(row.playlist_id, ids)
    }
    const playlists = db
      .prepare('SELECT * FROM playlists ORDER BY id')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        trackIds: memberships.get(row.id) || []
      }))
    const sessionState = Object.fromEntries(
      db
        .prepare('SELECT key, value FROM session_state')
        .all()
        .map((row) => [row.key, row.value])
    )
    const queue = db
      .prepare('SELECT track_id, snapshot_json FROM session_queue ORDER BY position')
      .all()
      .map((row) => ({ trackId: row.track_id, snapshot: JSON.parse(row.snapshot_json) }))
    const entries = Object.fromEntries(
      db
        .prepare('SELECT * FROM stats ORDER BY track_id')
        .all()
        .map((row) => [
          row.track_id,
          {
            playCount: row.play_count,
            totalSeconds: row.total_seconds,
            lastPlayedAt: row.last_played_at
          }
        ])
    )
    return {
      library: { schemaVersion: 1, tracks },
      playlists: { schemaVersion: 1, playlists },
      session: {
        schemaVersion: Number(sessionState.schemaVersion),
        revision: Number(sessionState.revision),
        currentIndex: Number(sessionState.currentIndex),
        queue
      },
      stats: { schemaVersion: 1, entries }
    }
  } finally {
    db.close()
  }
}

function updateSqliteSingle(databasePath) {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare(
      "UPDATE stats SET play_count = play_count + 1, total_seconds = total_seconds + 210, last_played_at = '2026-07-17T00:00:00.000Z' WHERE track_id = (SELECT track_id FROM stats ORDER BY track_id LIMIT 1)"
    ).run()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the actual mutation error.
    }
    throw error
  } finally {
    db.close()
  }
}

function updateSqliteBulk(databasePath) {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('BEGIN IMMEDIATE')
    const tracks = db.prepare('SELECT id, metadata_json FROM tracks ORDER BY id LIMIT 500').all()
    const updateTrack = db.prepare('UPDATE tracks SET metadata_json = ? WHERE id = ?')
    for (const [index, track] of tracks.entries()) {
      const metadata = JSON.parse(track.metadata_json)
      metadata.genre = `Updated Genre ${index % 13}`
      updateTrack.run(JSON.stringify(metadata), track.id)
    }
    const playlistRows = db.prepare('SELECT id FROM playlists ORDER BY id').all()
    const totalTrackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks').get().count
    const playlistLength = db.prepare(
      'SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlist_id = ?'
    )
    const insertedTrack = db.prepare('SELECT id FROM tracks ORDER BY id LIMIT 1 OFFSET ?')
    const deleteLastMembership = db.prepare(
      'DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?'
    )
    const shiftMembership = db.prepare(
      'UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = ?'
    )
    const insertMembership = db.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?)')
    for (const playlist of playlistRows) {
      const count = playlistLength.get(playlist.id).count
      const replacementTrackId = insertedTrack.get(count % totalTrackCount).id
      deleteLastMembership.run(playlist.id, count - 1)
      for (let position = count - 2; position >= 0; position -= 1) {
        shiftMembership.run(position + 1, playlist.id, position)
      }
      insertMembership.run(playlist.id, 0, replacementTrackId)
    }
    db.prepare(
      'UPDATE stats SET play_count = play_count + 1, total_seconds = total_seconds + 180'
    ).run()
    db.prepare(
      "UPDATE session_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'"
    ).run()
    db.prepare(
      "UPDATE session_state SET value = CAST((CAST(value AS INTEGER) + 250) % (SELECT COUNT(*) FROM session_queue) AS TEXT) WHERE key = 'currentIndex'"
    ).run()
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

function benchmarkSqlite(directory, fixture, options) {
  emptyDirectory(directory)
  const databasePath = path.join(directory, 'persistence-evaluation.sqlite')
  const backupPath = `${databasePath}.bak`
  const peak = { value: rssBytes() }
  const seedFull = measure(1, () => seedSqlite(databasePath, fixture), peak)
  fs.copyFileSync(databasePath, backupPath)
  const singleExpected = cloneDocuments(fixture)
  mutateSingle(singleExpected)
  const bulkExpected = bulkMutationResult(fixture)
  const metrics = {
    seedFull,
    parseLoad: measure(
      options.iterations,
      () => assertEquivalent(loadSqliteDocuments(databasePath), fixture),
      peak
    ),
    serializeFull: null,
    singleUpdate: measure(
      options.iterations,
      () => {
        updateSqliteSingle(databasePath)
      },
      peak,
      () => seedSqlite(databasePath, fixture),
      () =>
        assertEquivalent(
          loadSqliteDocuments(databasePath),
          singleExpected,
          'SQLite single update result'
        )
    ),
    bulkUpdate: measure(
      options.iterations,
      () => {
        updateSqliteBulk(databasePath)
      },
      peak,
      () => seedSqlite(databasePath, fixture),
      () =>
        assertEquivalent(
          loadSqliteDocuments(databasePath),
          bulkExpected,
          'SQLite bulk update result'
        )
    ),
    backupRecovery: measure(
      options.iterations,
      () => {
        fs.writeFileSync(databasePath, Buffer.from('broken sqlite primary'))
        fs.copyFileSync(backupPath, databasePath)
        assertEquivalent(loadSqliteDocuments(databasePath), fixture, 'SQLite recovered documents')
      },
      peak,
      () => {
        seedSqlite(databasePath, fixture)
        fs.copyFileSync(databasePath, backupPath)
      }
    )
  }
  return {
    backend: 'sqlite-transaction-evaluation',
    metrics,
    primaryDiskBytes: fs.statSync(databasePath).size,
    backupDiskBytes: fs.statSync(backupPath).size,
    peakRssBytes: peak.value,
    representation:
      'Normalized SQLite prototype reconstructed into the same four documents on every parse/load run. The single and bulk logical mutations are identical to the JSON model; SQLite commits each mutation in one database transaction. Not production code, not an Electron dependency, and not a migration proposal.',
    serializeFullNote:
      'Not applicable: SQLite has no full JSON serialization step. seedFull is supplied as the comparable complete structured snapshot write.'
  }
}

function summarizeScenario(trackCount, json, sqlite, options) {
  return {
    trackCount,
    workload: {
      localTracks: trackCount,
      playlists: `${options.playlistCount} x ${options.playlistSize}`,
      sessionQueueEntries: options.sessionSize,
      listeningStatsEntries: options.statsSize
    },
    json,
    sqlite
  }
}

function runBenchmark(options) {
  const startedAt = nowIso()
  const root =
    options.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-persistence-benchmark-'))
  emptyDirectory(root)
  try {
    const scenarios = []
    for (const trackCount of options.sizes) {
      const fixture = makeFixture(trackCount, options)
      const json = benchmarkJson(path.join(root, `json-${trackCount}`), fixture, options)
      const sqlite = benchmarkSqlite(path.join(root, `sqlite-${trackCount}`), fixture, options)
      scenarios.push(summarizeScenario(trackCount, json, sqlite, options))
    }
    return {
      schemaVersion: 1,
      title: 'Twilight Echo persistence benchmark',
      startedAt,
      completedAt: nowIso(),
      provenance: {
        scriptSha256: sha256File(__filename),
        command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)]
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpus: os.cpus().map((cpu) => cpu.model),
        totalMemoryBytes: os.totalmem(),
        gcExposed: typeof global.gc === 'function'
      },
      methodology: {
        iterations: options.iterations,
        percentile: 'nearest-rank',
        workload: {
          localTrackCounts: options.sizes,
          playlistCount: options.playlistCount,
          tracksPerPlaylist: options.playlistSize,
          sessionQueueEntries: options.sessionSize,
          listeningStatsEntries: options.statsSize
        },
        equivalence:
          'Both backends begin with identical generated domain data. Every timed single and bulk update is reset to that same baseline, applies the same logical mutation, then fully reconstructs and deep-compares all four documents against the expected result. SQLite parse/load is not a lazy-query comparison.',
        transactionSemantics:
          'The bulk logical mutation changes 500 track genres, every playlist by inserting the same derived track at position zero and dropping its former last track, every statistics entry, and session revision/current index. SQLite commits that mutation in one database transaction. JSON writes the same four resulting versioned envelopes with per-document temporary-file, backup, and rename replacement; it deliberately does not claim a cross-document transaction or fsync durability.',
        caveats: [
          'Timings are local-machine evidence, not universal performance claims.',
          'Filesystem cache is intentionally warm after initial seeding because normal app restarts also use the OS cache.',
          'RSS is process-wide peak RSS sampled after each operation, not an allocator-level attribution.',
          'The JSON and SQLite write timings are not presented as an equivalent durable-commit comparison: the JSON evaluation model mirrors the production-shaped atomic file path but does not issue fsync, while SQLite uses DELETE journaling and synchronous=FULL.',
          'SQLite uses Node built-in node:sqlite only for evaluation. The packaged Electron runtime compatibility, migration, crash-recovery, and update-cost work has not been accepted by this benchmark.'
        ]
      },
      scenarios,
      retainedWorkDirectory: options.workDir || null
    }
  } finally {
    if (!options.workDir) fs.rmSync(root, { recursive: true, force: true })
  }
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(usage())
    } else {
      const result = runBenchmark(options)
      fs.mkdirSync(path.dirname(options.output), { recursive: true })
      fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`)
      process.stdout.write(`${options.output}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n${usage()}`)
    process.exitCode = 1
  }
}

module.exports = { DEFAULTS, makeFixture, parseArgs, runBenchmark }
