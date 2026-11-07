import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from './libraryDatabase.ts'
import { CoreStateDatabase } from './coreStateDatabase.ts'
import { reconcileMusicLibrary, reconcileMusicLibraryFile, type MusicLibraryReconciliationReport } from './libraryDatabaseReconciliation.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { MUSIC_BACKUP_MAX_BYTES } from '../../shared/musicPersonalBackup.ts'
import type { TrackData } from '../../shared/track.ts'

const PLUGIN = 'com.twilightecho.experience.rhine-lab'
const song = (id: string, extra: Partial<TrackData> = {}): TrackData => ({
  id, filePath: `D:/Music/${id.replaceAll(':', '_')}.flac`, fileName: 'song.flac', source: 'local',
  title: 'Same title', artist: 'Same artist', album: 'Same album', duration: 200, size: 1, cover: null, lyrics: null, ...extra
})
const check = (report: MusicLibraryReconciliationReport, id: string) => {
  const value = report.checks.find(c => c.id === id)
  assert.ok(value, `Missing check: ${id}`)
  return value
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'music-reconciliation-'))
  const file = join(root, 'library.sqlite'), db = new LibraryDatabase(file)
  const closeBeforeCleanup: Array<() => void> = []
  t.after(() => { for (const close of closeBeforeCleanup) close(); db.close(); rmSync(root, { recursive: true, force: true }) })
  const tracks = [song('a'), song('b'), song('cue', { cueRange: { startSeconds: 10, endSeconds: 100, pregapSeconds: 0 } })]
  db.replaceDocument({ version: 2, revision: 1, tracks, folders: [], exclusions: [] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const online = song('ncm:7', { source: 'ncm', ncmSongId: 7, albumId: 'seven', artists: [{ id: 'native-person', name: 'Same artist' }] })
  let job = db.catalogSync({ kind: 'begin', revision: 1 })
  job = db.catalogSync({ kind: 'append', ...job, tracks: [online] })
  db.catalogSync({ kind: 'commit', ...job })
  let cache = db.catalogSync({ kind: 'begin', revision: 2 })
  cache = db.catalogSync({ kind: 'append', ...cache, tracks: [song('qq:cache', { source: 'qq', albumId: 'cache' })] })
  db.catalogSync({ kind: 'abort', id: cache.id })
  const source = (track: TrackData) => db.sql.prepare('SELECT * FROM catalog_sources WHERE source_key=?').get(versionSourceKey(track))!
  const recording = (track: TrackData) => String(source(track).recording_id)
  const artist = db.catalogQuery({ kind: 'artist' }).items[0].id
  db.metadataOverride({ entityId: artist, revision: 0, mode: 'value', value: 'My handwritten biography', language: 'en' }, 1)
  const secondArtist = db.catalogQuery({ kind: 'artist' }).items.find(i => i.id !== artist)!.id
  db.metadataOverride({ entityId: secondArtist, revision: 0, mode: 'clear', language: 'en' }, 2)
  db.metadataArtworkOverride({ entityId: artist, revision: 1, mode: 'clear', language: 'en' }, 3)
  db.metadataSourcePreference({ entityId: artist, revision: 2, provider: 'wikipedia', language: 'en' }, 4)
  db.ratingsSet({ entityId: recording(tracks[0]), token: db.ratingsDetail(recording(tracks[0])).token, steps: 8 }, 10)
  db.ratingsSet({ entityId: recording(tracks[1]), token: db.ratingsDetail(recording(tracks[1])).token, steps: null }, 11)
  db.preferencesPlaylistsMigrate({ version: 2, revision: 1, savedAt: '2026-10-24T00:00:00.000Z', data: [{
    id: 'favorites', name: 'Favorites', isDefault: true, createdAt: '2026-10-24T00:00:00.000Z',
    trackIds: ['b', 'a', 'a', 'missing-original'], trackSnapshots: { a: tracks[0], b: tracks[1] }
  }] }, 12)
  db.preferencesSet({ entityId: recording(tracks[1]), token: db.preferencesDetail(recording(tracks[1])).token, state: 'none' }, 13)
  db.preferencesSet({ entityId: recording(online), token: db.preferencesDetail(recording(online)).token, state: 'favorite' }, 14)
  const tag = db.tagsCreate({ name: 'Evening', tagsRevision: db.tagsState().tagsRevision }, 15).tag
  assert.ok(tag)
  db.tagsMemberSet({ tagId: tag.id, entityId: recording(tracks[0]), present: true, membersRevision: tag.membersRevision }, 16)
  db.sql.exec("INSERT INTO music_genres VALUES('user:evening','Evening','Evening','genre:jazz',1,1)")
  db.sql.prepare("INSERT INTO music_genre_overrides VALUES('source',?,?)").run(String(source(tracks[0]).id), '["user:evening"]')
  db.sql.prepare("INSERT INTO music_genre_overrides VALUES('source',?,'[]')").run(String(source(tracks[2]).id))
  db.sql.exec("INSERT INTO metadata_entities VALUES('retained-identity','musicbrainz','recording','old-native','Old'); INSERT INTO metadata_identity_links(id,entity_id,kind,revision,target_id,state) SELECT 'detached',recording_id,'recording',1,NULL,'detached' FROM catalog_sources WHERE track_id='a'")
  const versions = emptyMusicVersions()
  versions.tracks.versions = [
    { id: 'studio', label: 'Studio', sources: [versionSourceKey(tracks[0]), versionSourceKey(online)], preferredSource: versionSourceKey(online) },
    { id: 'offline', label: 'Offline', sources: ['["qq","not-yet-in-library"]'], preferredSource: '["qq","not-yet-in-library"]' }
  ]
  versions.tracks.families = [{ id: 'family', versions: ['studio', 'offline'], preferredVersion: 'studio' }]
  db.catalogProjectVersions(versions, 4)
  const revision = db.queryCollections('albums').revision
  db.legacyMusicBegin(PLUGIN, 1, { albums: {} }, 3, revision)
  db.legacyMusicStage({ pluginId: PLUGIN, sourceRevision: 1, contentRevision: revision, entries: [
    { id: 'unknown', value: { title: 'Same album', description: 'Unknown provider body', descriptionSource: { name: 'Old wiki' } } },
    { id: 'manual', value: { title: 'Unassigned album', description: 'Old body' } },
    { id: 'clear', value: { title: 'Unassigned clear', description: 'Old body' } }
  ] })
  db.legacyMusicPublish(PLUGIN, 1, revision)
  const document = db.legacyMusicRead(PLUGIN)!
  const albums = document.value.albums as Record<string, Record<string, unknown>>
  albums.manual.description = 'Handwritten album description'
  delete albums.clear.description
  db.legacyMusicEdit(PLUGIN, document)
  return { root, file, db, tracks, versions, online, source, recording, artist, closeBeforeCleanup }
}

test('mixed library reconciles real members, precise mappings, clears, retained favorites and unknown legacy text without false errors', t => {
  const f = fixture(t)
  const before = f.db.sql.prepare('SELECT total_changes() n').get()!.n
  const report = reconcileMusicLibrary(f.db.sql, { versionsJson: JSON.stringify(f.versions), versionsRevision: 4, exampleLimit: 100 })
  assert.equal(report.summary.errorChecks, 0, JSON.stringify(report.checks.filter(c => c.severity === 'error' && c.count)))
  assert.equal(report.summary.state, 'needs-review', 'uncertain provenance remains a review item')
  assert.equal(check(report, 'catalog.actual-members').count, 4)
  assert.equal(check(report, 'catalog.retained-nonmembers').count, 1)
  assert.equal(check(report, 'catalog.source-mapping').count, 0)
  assert.equal(check(report, 'ratings.clears').count, 1)
  assert.equal(check(report, 'preferences.clears').count, 1)
  assert.equal(check(report, 'metadata.manual-values').count, 1)
  assert.equal(check(report, 'metadata.explicit-clears').count, 2)
  assert.ok(check(report, 'legacy.unknown-provenance').count >= 1)
  assert.equal(check(report, 'legacy.manual-values').count, 1)
  assert.equal(check(report, 'legacy.explicit-clears').count, 1)
  assert.equal(check(report, 'versions.offline-sources').count, 1)
  assert.equal(check(report, 'versions.authority-drift').count, 0)
  assert.equal(check(report, 'genres.user-nodes').count, 1)
  assert.equal(check(report, 'genres.selections').count, 2)
  assert.equal(check(report, 'favorites.duplicate-occurrences').count, 1)
  assert.equal(check(report, 'favorites.suppressed-by-preference').count, 1)
  assert.equal(check(report, 'favorites.unresolved').count, 1)
  assert.deepEqual(check(report, 'favorites.stored-order').examples.map(row => row.track_id), ['b', 'a', 'a', 'missing-original'])
  assert.deepEqual(check(report, 'favorites.retained-order').examples.map(row => row.track_id), ['a', 'a', 'missing-original'])
  assert.equal(check(report, 'favorites.unrepresented-targets').count, 1)
  assert.deepEqual(reconcileMusicLibrary(f.db.sql, { versionsJson: JSON.stringify(f.versions), versionsRevision: 4, exampleLimit: 100 }), report)
  assert.equal(f.db.sql.prepare('SELECT total_changes() n').get()!.n, before)
  const encoded = JSON.stringify(report)
  for (const secret of ['My handwritten biography', 'Unknown provider body', 'Handwritten album description']) assert.equal(encoded.includes(secret), false)
})

test('counts cover all rows while examples are bounded and real broken references, identity keys and version preferences are errors', t => {
  const f = fixture(t)
  f.db.sql.exec('PRAGMA foreign_keys=OFF')
  f.db.sql.exec("INSERT INTO personal_tag_members VALUES('default','missing-tag','missing-entity'); UPDATE catalog_versions SET preferred_source='not-a-member' WHERE id='studio'")
  f.db.sql.prepare("INSERT INTO personal_rating_values VALUES('default',?,'recording',5,1,20)").run('["entity","recording","missing-anchor"]')
  f.db.sql.prepare("INSERT INTO personal_rating_values VALUES('default',?,'recording',5,1,20)").run('[null,"recording","a"]')
  f.db.sql.prepare("UPDATE music_genre_overrides SET genre_ids='[\"missing-genre\"]' WHERE target_id=?").run(String(f.source(f.tracks[0]).id))
  const report = reconcileMusicLibrary(f.db.sql, { exampleLimit: 1 })
  assert.equal(report.summary.state, 'needs-repair')
  assert.ok(check(report, 'references.foreign-key').count >= 2)
  assert.equal(check(report, 'ratings.invalid-target').count, 2)
  assert.equal(check(report, 'versions.invalid-preference').count, 1)
  assert.equal(check(report, 'genres.invalid-selection').count, 1)
  assert.equal(check(report, 'catalog.actual-members').count, 4)
  assert.equal(check(report, 'catalog.actual-members').examples.length, 1)
  for (const c of report.checks) assert.ok(c.examples.length <= 1)
  assert.ok(report.coverage.limits.some(v => v.includes('未指定 versions')))
  assert.equal(reconcileMusicLibrary(f.db.sql, { exampleLimit: 0 }).checks.every(c => c.examples.length === 0), true)
})

test('music-only restore remains offline with personal state preserved and no orphan errors', async t => {
  const f = fixture(t), destination = new LibraryDatabase(join(f.root, 'destination.sqlite'))
  f.closeBeforeCleanup.push(() => destination.close())
  const music = f.db.musicBackupExport(MUSIC_BACKUP_MAX_BYTES)
  await destination.musicBackupRestore({ restoreId: 'reconciliation-offline', music, conflict: 'use-backup', expectedRevision: destination.musicBackupRevision(), now: 100 })
  const report = reconcileMusicLibrary(destination.sql)
  assert.equal(report.summary.errorChecks, 0, JSON.stringify(report.checks.filter(c => c.severity === 'error' && c.count)))
  assert.equal(check(report, 'catalog.actual-members').count, 0)
  assert.equal(check(report, 'restore.offline-sources').count, music.records.sources.length)
  assert.equal(check(report, 'ratings.clears').count, 1)
  assert.equal(check(report, 'metadata.manual-values').count, 1)
  assert.equal(check(report, 'metadata.explicit-clears').count, 2)
  assert.equal(check(report, 'tags.members').count, 1)
  assert.equal(check(report, 'tags.offline-members').count, 1)
  assert.equal(check(report, 'genres.selections').count, 2)
  assert.equal(check(report, 'genres.invalid-selection').count, 0)
})

test('pending index and removed local source are distinguished from broken non-pending membership', t => {
  const f = fixture(t)
  f.db.replaceDocument({ version: 2, revision: 2, tracks: [f.tracks[0], f.tracks[2]], folders: [], exclusions: [] })
  let report = reconcileMusicLibrary(f.db.sql)
  assert.ok(check(report, 'catalog.pending-local').count > 0)
  assert.equal(check(report, 'catalog.members-without-local-track').count, 0)
  while (f.db.catalogStatus().localPending) f.db.catalogAdvance()
  report = reconcileMusicLibrary(f.db.sql)
  assert.equal(check(report, 'catalog.pending-local').count, 0)
  assert.equal(check(report, 'catalog.members-without-local-track').count, 0)
  assert.ok(check(report, 'catalog.retained-nonmembers').count >= 2)
  f.db.sql.prepare("INSERT INTO catalog_memberships VALUES('local',?)").run(String(f.source(f.tracks[1]).id))
  assert.equal(check(reconcileMusicLibrary(f.db.sql), 'catalog.members-without-local-track').count, 1)
})

test('explicit versions authority detects projection drift without inventing unavailable-source errors', t => {
  const f = fixture(t), changed = structuredClone(f.versions)
  changed.tracks.versions[0].label = 'Changed label'
  let report = reconcileMusicLibrary(f.db.sql, { versionsJson: JSON.stringify(changed), versionsRevision: 5 })
  assert.equal(check(report, 'versions.authority-drift').count, 1)
  assert.equal(check(report, 'versions.authority-revision').count, 1)
  assert.equal(check(report, 'versions.invalid-preference').count, 0)
  f.db.sql.exec("DELETE FROM catalog_version_sources WHERE version_id='offline'")
  report = reconcileMusicLibrary(f.db.sql, { versionsJson: JSON.stringify(f.versions) })
  assert.equal(check(report, 'versions.authority-drift').count, 1)
})

test('file and CLI routes read only the selected database and refuse overwriting inputs or existing reports', t => {
  const f = fixture(t)
  const before = statSync(f.file).mtimeMs
  const report = reconcileMusicLibraryFile(f.file, { exampleLimit: 2 })
  assert.equal(report.summary.errorChecks, 0)
  assert.equal(statSync(f.file).mtimeMs, before)
  const output = join(f.root, 'report.json'), versions = join(f.root, 'versions.json')
  writeFileSync(versions, JSON.stringify(f.versions))
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/music-library-reconciliation.ts'), ...args], { encoding: 'utf8' })
  assert.equal(run('--database', f.file, '--versions', versions, '--versions-revision', '4', '--output', output).status, 0)
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).coverage.versionsAuthority, true)
  assert.notEqual(run('--database', f.file, '--output', output).status, 0)
  assert.notEqual(run('--database', f.file, '--output', f.file).status, 0)
  assert.equal(run('--help').status, 0)
  f.db.sql.exec("UPDATE catalog_versions SET preferred_source='broken' WHERE id='studio'")
  const broken = run('--database', f.file, '--examples', '0')
  assert.equal(broken.status, 2, broken.stderr)
  assert.equal(JSON.parse(broken.stdout).summary.state, 'needs-repair')
})

test('schema mismatches, malformed authorities and invalid bounds fail without migration or transaction leakage', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('PRAGMA user_version=27')
  assert.throws(() => reconcileMusicLibrary(db), /schemas 28, 29 and 30/)
  assert.equal(db.isTransaction, false)
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 27)
  assert.throws(() => reconcileMusicLibrary(db, { exampleLimit: 101 }), /exampleLimit/)
  assert.throws(() => reconcileMusicLibrary(db, { versionsRevision: 2 }), /versionsRevision/)
  assert.throws(() => reconcileMusicLibrary(db, { versionsJson: '{"version":100}' }), /版本/)
  const f = fixture(t)
  f.db.sql.exec('BEGIN')
  assert.throws(() => reconcileMusicLibrary(f.db.sql), /own read snapshot/)
  assert.equal(f.db.sql.isTransaction, true)
  f.db.sql.exec('ROLLBACK')
})

test('read-only reconciliation accepts v28 through v30 without upgrading the selected database', t => {
  const f = fixture(t)
  for (const schema of [28, 29, 30]) {
    f.db.sql.exec(`PRAGMA user_version=${schema}`)
    const before = f.db.sql.prepare('SELECT total_changes() n').get()!.n
    assert.equal(reconcileMusicLibrary(f.db.sql).schema, schema)
    assert.equal(f.db.sql.prepare('PRAGMA user_version').get()!.user_version, schema)
    assert.equal(f.db.sql.prepare('SELECT total_changes() n').get()!.n, before)
  }
})

test('production Core state is consumed read-only with its real revision; pending migration and snapshot authority remain distinct', t => {
  const f = fixture(t), path = join(f.root, 'core-state.sqlite'), core = new CoreStateDatabase(path)
  f.closeBeforeCleanup.push(() => core.close())
  for (const scope of ['tracks', 'albums'] as const) for (const kind of ['versions', 'families'] as const)
    for (const value of f.versions[scope][kind]) core.sql.prepare("INSERT INTO core_state VALUES('versions',?,?)").run(`${scope}:${kind}:${value.id}`, JSON.stringify(value))
  core.sql.exec("UPDATE core_domain_revisions SET revision=4 WHERE domain='versions'; INSERT INTO core_migrations VALUES('fixture','{}',0,0,1)")
  const before = core.sql.prepare('SELECT total_changes() n').get()!.n
  let report = reconcileMusicLibraryFile(f.file, { coreStatePath: path, exampleLimit: 2 })
  assert.equal(report.coverage.versionsAuthoritySource, 'core-state')
  assert.equal(report.coverage.coreStateMigration, 'complete')
  assert.equal(report.revisions['versions:core-state'], 4)
  assert.equal(check(report, 'versions.authority-drift').count, 0)
  assert.equal(check(report, 'versions.authority-revision').count, 0)
  assert.equal(core.sql.prepare('SELECT total_changes() n').get()!.n, before)
  // Normal Core state enforces one migration row. An operator-selected older
  // file lacking that index must not hide a second pending row behind a prior
  // complete row merely because of table iteration order.
  core.sql.exec("DROP INDEX one_core_migration; INSERT INTO core_migrations VALUES('pending-fixture','{}',0,0,0)")
  report = reconcileMusicLibraryFile(f.file, { coreStatePath: path })
  assert.equal(check(report, 'versions.core-migration').count, 1)
  assert.equal(check(report, 'versions.core-migration').severity, 'pending')
  const snapshotReport = reconcileMusicLibrary(f.db.sql, { versionsJson: JSON.stringify(f.versions) })
  assert.equal(snapshotReport.coverage.versionsAuthoritySource, 'snapshot')
  assert.ok(snapshotReport.coverage.limits.some(v => v.includes('不是当前生产 Core')))
  assert.throws(() => reconcileMusicLibrary(f.db.sql, { coreStatePath: path, versionsJson: JSON.stringify(f.versions) }), /either/)
  const cli = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/music-library-reconciliation.ts'), '--database', f.file, '--core-state', path, '--examples', '0'], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).coverage.versionsAuthoritySource, 'core-state')
  core.sql.prepare("UPDATE core_state SET key='tracks:versions:wrong-key' WHERE key='tracks:versions:studio'").run()
  assert.throws(() => reconcileMusicLibraryFile(f.file, { coreStatePath: path }), /row identity/)
})
