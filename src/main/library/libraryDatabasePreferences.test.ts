import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from './libraryDatabase.ts'
import { LibraryDatabasePreferences } from './libraryDatabasePreferences.ts'
import { PREFERENCE_SCHEMA_SQL, PREFERENCE_WORK_MIGRATION_SQL } from './libraryDatabasePreferences.ts'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabaseIdentification } from './libraryDatabaseIdentification.ts'
import { LibraryDatabaseCatalog } from './libraryDatabaseCatalog.ts'
import { validMusicPreferencesPayload, validMusicPreferenceChoice, validMusicPreferenceResolution } from '../../shared/musicPreferences.ts'
import type { MusicPreferenceState } from '../../shared/musicPreferences.ts'
import type { TrackData } from '../../shared/track.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
import type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'

const song = (id: string, extra: Partial<TrackData> = {}): TrackData => ({ id, source: 'local', filePath: `D:/${id}/song.flac`, fileName: 'song.flac', title: 'Same song', artist: 'Same artist', album: `Album ${id}`, duration: 180, size: 1, lyrics: null, cover: null, ...extra })
const playlist = (id: string, tracks: TrackData[], extra: Partial<Playlist> = {}): Playlist => ({ id, name: '我收藏的音乐', createdAt: '2026-10-24T00:00:00.000Z', trackIds: tracks.map(t => t.id), trackSnapshots: Object.fromEntries(tracks.map(t => [t.id, t])), ...extra })
function owner(db: LibraryDatabase) {
  return { sql: db.sql, transaction<T>(action: () => T): T { db.sql.exec('BEGIN IMMEDIATE'); try { const v = action(); db.sql.exec('COMMIT'); return v } catch (e) { db.sql.exec('ROLLBACK'); throw e } } }
}
function fixture(t: test.TestContext, file = ':memory:') {
  const db = new LibraryDatabase(file); t.after(() => db.close())
  const tracks = [song('one'), song('two'), song('three'), song('ncm:7', { source: 'ncm', ncmSongId: 7, albumId: 'album-7', artists: [{ id: 'artist-7', name: 'Main' }] })]
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: tracks.slice(0, 3) })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  new LibraryDatabaseCatalog({ ...owner(db), collectionSelection() { throw new Error('unused') } }).retainPersonalSource(tracks[3])
  const pref = new LibraryDatabasePreferences(owner(db)), identity = new LibraryDatabaseIdentification(owner(db))
  const source = (track: TrackData) => db.sql.prepare('SELECT * FROM catalog_sources WHERE track_id=? AND provider=?').get(track.id, track.source!)!
  const rec = (n: number) => String(source(tracks[n]).recording_id)
  const set = (id: string, state: MusicPreferenceState) => pref.set({ entityId: id, state, token: pref.detail(id).token }, 100)
  const publish = (id: string, value = 'shared') => identity.publish(identity.input(id), [{ provider: 'ncm', name: 'Confirmed', summary: '', matcherVersion: 'fixture', references: [{ provider: 'ncm', kind: identity.input(id).kind, idType: 'native', value }], evidence: { origin: 'search', matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' } }], 200)[0]
  const review = (c: ReturnType<typeof publish>) => ({ candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision })
  const confirm = (c: ReturnType<typeof publish>) => identity.decide({ ...review(c), decision: 'confirm' }, 201)
  return { db, tracks, pref, identity, source, rec, set, publish, review, confirm }
}

test('preferences whitelist local profile, exact states, CAS tokens and bounded contexts', () => {
  const token = { preferencesRevision: 0, linkRevision: 0, targetKey: 'opaque' }
  for (const state of ['none', 'favorite', 'ban']) assert.equal(validMusicPreferencesPayload('preferences.set', { entityId: 'e', state, token }), true)
  for (const state of ['like', null, true, undefined]) assert.equal(validMusicPreferencesPayload('preferences.set', { entityId: 'e', state, token }), false)
  assert.equal(validMusicPreferencesPayload('preferences.set', { entityId: 'e', state: 'ban', token, profileId: 'other' }), false)
  assert.equal(validMusicPreferencesPayload('preferences.targets', { entityId: 'e', trackContext: { provider: 'NCM', id: '1' } }), false)
  assert.equal(validMusicPreferencesPayload('preferences.history', { entityId: 'e', limit: 101 }), false)
  assert.equal(validMusicPreferenceResolution({ revision: 1, choice: 'related:exact-id' }), true)
  for (const choice of ['related:', `related:${'x'.repeat(129)}`, 'related:id\0', {}, 1]) assert.equal(validMusicPreferenceResolution({ revision: 1, choice }), false)
  assert.equal(validMusicPreferenceChoice('related:forged', { revision: 1, current: null, target: null, conflict: true, action: 'choose', related: [] }), false)
})

test('work preference schema migration preserves original values, cleared history and deleted audit high water', t => {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close())
  sql.exec(`CREATE TABLE metadata_identity_links(entity_id TEXT,kind TEXT,state TEXT,revision INTEGER,target_id TEXT);
    ${PREFERENCE_SCHEMA_SQL.replaceAll(",'work'", '')}
    INSERT INTO personal_preference_values VALUES('default','original','recording','none',3,30);
    INSERT INTO personal_preference_history VALUES(4,'default','original','recording','favorite',1,10,'set');
    INSERT INTO personal_preference_history VALUES(7,'default','original','recording','none',3,30,'clear');
    INSERT INTO personal_preference_history VALUES(900,'default','deleted','release','ban',1,40,'set');
    DELETE FROM personal_preference_history WHERE seq=900;
    UPDATE personal_preferences_state SET revision=8;
    INSERT INTO personal_preference_playlists VALUES(1,8,'saved','[]',2,'default','receipt');`)
  const values = sql.prepare('SELECT * FROM personal_preference_values').all(), history = sql.prepare('SELECT * FROM personal_preference_history').all()
  sql.exec(`BEGIN IMMEDIATE;${PREFERENCE_WORK_MIGRATION_SQL}COMMIT;`)
  assert.deepEqual(sql.prepare('SELECT * FROM personal_preference_values').all(), values)
  assert.deepEqual(sql.prepare('SELECT * FROM personal_preference_history').all(), history)
  assert.equal(sql.prepare("SELECT revision FROM personal_preferences_state WHERE profile_id='default'").get()!.revision, 8)
  assert.equal(sql.prepare('SELECT migration_receipt FROM personal_preference_playlists').get()!.migration_receipt, 'receipt')
  sql.exec("INSERT INTO personal_preference_values VALUES('default','work','work','ban',1,50); INSERT INTO personal_preference_history(profile_id,target_key,kind,state,revision,updated_at,reason) VALUES('default','work','work','ban',1,50,'set')")
  assert.equal(sql.prepare("SELECT seq FROM personal_preference_history WHERE kind='work'").get()!.seq, 901)
  sql.exec("UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default'")
  assert.equal(sql.prepare('SELECT revision FROM personal_preference_playlists').get()!.revision, 9, 'original playlist revision trigger remains active')
  assert.ok(sql.prepare("SELECT 1 FROM sqlite_master WHERE name='personal_preference_history_target'").get())
})

test('work preference schema migration participates in the outer migration rollback', t => {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close())
  sql.exec(`CREATE TABLE metadata_identity_links(entity_id TEXT,kind TEXT,state TEXT,revision INTEGER,target_id TEXT);
    ${PREFERENCE_SCHEMA_SQL.replaceAll(",'work'", '')}
    INSERT INTO personal_preference_values VALUES('default','original','release','ban',1,10);`)
  sql.exec('BEGIN IMMEDIATE')
  assert.throws(() => sql.exec(`${PREFERENCE_WORK_MIGRATION_SQL} INSERT INTO missing_migration_table VALUES(1);`), /missing_migration_table/)
  sql.exec('ROLLBACK')
  assert.equal(sql.prepare("SELECT state FROM personal_preference_values WHERE target_key='original'").get()!.state, 'ban')
  assert.throws(() => sql.prepare("INSERT INTO personal_preference_values VALUES('default','work','work','ban',1,10)").run(), /CHECK constraint/)
  assert.equal(sql.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%_work'").get()!.n, 0)
})

test('none is an explicit receipt; recording/release are independent and artists require confirmed identity', t => {
  const { db, pref, rec, set, source, tracks } = fixture(t), id = rec(0)
  assert.equal(pref.detail(id).value, null)
  const old = set(id, 'favorite'); set(id, 'ban'); const cleared = set(id, 'none')
  assert.equal(cleared.value!.state, 'none'); assert.equal(cleared.value!.revision, 3)
  assert.deepEqual(pref.history({ entityId: id }).items.map(v => v.state), ['none', 'ban', 'favorite'])
  assert.throws(() => pref.set({ entityId: id, token: old.token, state: 'favorite' }, 101), { code: 'STALE_REVISION' })
  set(String(source(tracks[0]).release_id), 'ban')
  assert.equal(pref.detail(id).value!.state, 'none')
  const artist = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[0]).id))!.artist_id)
  assert.throws(() => pref.detail(artist), /确认艺人身份/)
})

test('exact work/person preferences keep independent values and clear history without banning participant playback', t => {
  const { db, pref, tracks, rec, set } = fixture(t)
  const work = { provider: 'mb', kind: 'work' as const, idType: 'mbid', value: 'work-1' }
  const otherWork = { ...work, value: 'work-2' }
  const person = { provider: 'mb', kind: 'artist' as const, idType: 'mbid', value: 'person-1' }
  db.explorationIngest({ owner: work, provider: 'mb', setKey: 'organization', truncated: false, relations: [],
    nodes: [{ reference: work, title: 'Same work' }, { reference: otherWork, title: 'Same work' }, { reference: person, title: 'Same artist' }] })
  const id = (value: string) => String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(value)!.entity_id)
  const workId = id(work.value), otherId = id(otherWork.value), personId = id(person.value)
  db.explorationPerformanceSave({ workId, title: 'Explicit work participation', recordingIds: [rec(0), rec(1)], revision: db.explorationState().revision })
  assert.equal(pref.detail(workId).scope, 'entity'); assert.equal(pref.detail(workId).kind, 'work')
  assert.equal(pref.detail(personId).scope, 'entity'); assert.equal(pref.detail(personId).kind, 'artist')
  assert.deepEqual(pref.targets({ entityId: workId }).items.map(item => [item.id, item.kind]), [[workId, 'work']])
  assert.equal(pref.targets({ entityId: workId, offset: 1 }).items.length, 0)
  assert.equal(pref.targets({ entityId: personId }).total, 1)
  const old = set(workId, 'favorite')
  set(workId, 'ban'); set(personId, 'ban')
  assert.deepEqual(pref.automaticEligibility(tracks.slice(0, 3)), [true, true, true], 'organization bans do not cascade work/credit participants')
  assert.equal(pref.detail(otherId).value, null, 'same-name works do not share personal values')
  assert.equal(pref.detail(rec(0)).value, null)
  assert.throws(() => pref.set({ entityId: workId, state: 'none', token: old.token }, 101), { code: 'STALE_REVISION' })
  set(workId, 'none')
  assert.deepEqual(pref.history({ entityId: workId }).items.map(item => item.state), ['none', 'ban', 'favorite'])
  assert.equal(pref.detail(workId).value?.state, 'none')
  set(rec(0), 'ban')
  assert.deepEqual(pref.automaticEligibility(tracks.slice(0, 3)), [false, true, true], 'original exact recording ban remains effective')
  assert.equal(pref.detail(personId).value?.state, 'ban')
})

test('exploration people with the same exact identity reuse confirmed artist preference history while same names remain separate', t => {
  const { db, pref, tracks, source, set, publish, confirm } = fixture(t)
  const physical = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[3]).id))!.artist_id)
  confirm(publish(physical, 'artist-7')); set(physical, 'favorite')
  const person = { provider: 'ncm', kind: 'artist' as const, idType: 'native', value: 'artist-7' }
  const other = { ...person, value: 'artist-other' }
  db.explorationIngest({ owner: person, provider: 'ncm', setKey: 'exact-artists', truncated: false, relations: [],
    nodes: [{ reference: person, title: 'Same name' }, { reference: other, title: 'Same name' }] })
  const graphId = String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(person.value)!.entity_id)
  const otherId = String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(other.value)!.entity_id)
  assert.notEqual(graphId, physical)
  assert.equal(pref.detail(graphId).scope, 'identity')
  assert.equal(pref.detail(graphId).token.targetKey, pref.detail(physical).token.targetKey)
  assert.equal(pref.detail(graphId).value?.state, 'favorite')
  assert.equal(pref.detail(otherId).scope, 'entity'); assert.equal(pref.detail(otherId).value, null)
  set(graphId, 'ban')
  assert.equal(pref.detail(physical).value?.state, 'ban')
  assert.deepEqual(pref.history({ entityId: graphId }).items, pref.history({ entityId: physical }).items)
  assert.equal(pref.automaticEligibility([tracks[3]])[0], false, 'confirmed main-artist ban retains its original reach')
  assert.equal(db.sql.prepare('SELECT 1 FROM metadata_identity_links WHERE entity_id=?').get(graphId), undefined, 'exact lookup never manufactures a confirmation link')
  const localArtist = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[0]).id))!.artist_id)
  confirm(publish(localArtist, 'artist-second'))
  db.sql.prepare('INSERT INTO music_exploration_refs VALUES(?,?,?,?,?)').run('ncm', 'artist', 'native', 'artist-second', graphId)
  assert.throws(() => pref.detail(graphId), { code: 'IDENTITY_CONFLICT' })
})

test('first identity confirmation carries an earlier exact graph-person favorite atomically without candidate scope changes', t => {
  const { db, pref, tracks, source, set, publish, review, confirm } = fixture(t)
  const person = { provider: 'ncm', kind: 'artist' as const, idType: 'native', value: 'artist-7' }
  db.explorationIngest({ owner: person, provider: 'ncm', setKey: 'before-identification', nodes: [{ reference: person, title: 'Exact person' }], relations: [], truncated: false })
  const graphId = String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(person.value)!.entity_id)
  const physical = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[3]).id))!.artist_id)
  set(graphId, 'favorite')
  const candidate = publish(physical, person.value)
  assert.equal(pref.detail(graphId).scope, 'entity'); assert.equal(pref.detail(graphId).value?.state, 'favorite')
  const preview = db.identificationPreview(review(candidate))
  assert.equal(preview.preferenceImpact?.action, 'carry'); assert.equal(preview.preferenceImpact?.current?.state, 'favorite')
  assert.equal(preview.preferenceImpact?.related?.[0].entityId, graphId)
  confirm(candidate)
  assert.equal(pref.detail(graphId).scope, 'identity'); assert.equal(pref.detail(graphId).value?.state, 'favorite')
  assert.equal(pref.detail(graphId).token.targetKey, pref.detail(physical).token.targetKey)
  assert.equal(pref.history({ entityId: graphId }).items[0].reason, 'identity_carry')
  assert.equal(db.sql.prepare("SELECT state FROM personal_preference_values WHERE target_key=?").get(JSON.stringify(['entity','artist',graphId]))!.state, 'favorite')
})

test('identity confirmation and history restoration explicitly resolve related exact-person conflicts with revision fencing', t => {
  const { db, pref, identity, tracks, source, set, publish, review } = fixture(t)
  const person = { provider: 'ncm', kind: 'artist' as const, idType: 'native', value: 'artist-7' }
  const otherRef = { provider: 'wikidata', kind: 'artist' as const, idType: 'item', value: 'Q-person' }
  db.explorationIngest({ owner: person, provider: 'ncm', setKey: 'conflicting-person', nodes: [{ reference: person, title: 'Graph person' }, { reference: otherRef, title: 'Other exact anchor' }], relations: [], truncated: false })
  const graphId = String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(person.value)!.entity_id)
  const otherId = String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(otherRef.value)!.entity_id)
  const physical = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[0]).id))!.artist_id)
  set(graphId, 'ban'); set(otherId, 'favorite')
  const original = publish(physical, person.value)
  const candidate = identity.publish(identity.input(physical), [{ provider: 'ncm', name: 'Confirmed', summary: '', matcherVersion: 'fixture', references: [person, otherRef], evidence: original.evidence }], 200)[0]
  const conflict = identity.preview(review(candidate)).preferenceImpact!
  assert.equal(conflict.conflict, true); assert.equal(conflict.related?.length, 2)
  assert.equal(conflict.related?.find(item => item.entityId === graphId)?.value.state, 'ban')
  assert.throws(() => identity.decide({ ...review(candidate), decision: 'confirm' }, 200), { code: 'PREFERENCE_CONFLICT' })
  assert.throws(() => identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: conflict.revision, choice: 'related:forged' } }, 200), { code: 'STALE_REVISION' })
  set(graphId, 'none')
  assert.throws(() => identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: conflict.revision, choice: `related:${graphId}` } }, 200), { code: 'STALE_REVISION' })
  set(graphId, 'ban')
  const current = identity.preview(review(candidate)).preferenceImpact!
  db.sql.exec("CREATE TRIGGER fail_graph_preference_audit BEFORE INSERT ON metadata_identity_history WHEN new.state='confirmed' BEGIN SELECT RAISE(ABORT,'audit failed'); END")
  assert.throws(() => identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: current.revision, choice: `related:${graphId}` } }, 200), /audit failed/)
  assert.equal(pref.detail(graphId).scope, 'entity'); assert.equal(pref.detail(graphId).value?.state, 'ban')
  assert.equal(pref.revision(), current.revision)
  db.sql.exec('DROP TRIGGER fail_graph_preference_audit')
  identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: current.revision, choice: `related:${graphId}` } }, 200)
  assert.equal(pref.detail(physical).value?.state, 'ban'); assert.equal(pref.detail(graphId).value?.state, 'ban')
  const link = identity.detail(physical).link!; identity.detach(link.id, link.revision, 201)
  assert.equal(pref.detail(graphId).scope, 'entity'); assert.equal(pref.detail(graphId).value?.state, 'ban')
  const page = identity.history({ entityId: physical }), historical = page.items.find(item => item.state === 'confirmed')!
  const request = { entityId: physical, historySeq: historical.seq, linkRevision: page.current.link!.revision, inputVersion: page.inputVersion }
  const restore = identity.restorePreview(request).preferenceImpact!
  assert.equal(restore.conflict, true); assert.equal(restore.related?.length, 2)
  identity.restore({ ...request, preferenceResolution: { revision: restore.revision, choice: `related:${otherId}` } }, 202)
  assert.equal(pref.detail(physical).value?.state, 'favorite'); assert.equal(pref.detail(graphId).value?.state, 'favorite')
})

test('new exact graph aliases explicitly resolve against an existing confirmed canonical preference', t => {
  const { db, pref, identity, tracks, source, set, publish, review, confirm } = fixture(t)
  const existing = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[3]).id))!.artist_id)
  confirm(publish(existing, 'artist-7')); set(existing, 'favorite')
  const ref = { provider: 'wikidata', kind: 'artist' as const, idType: 'item', value: 'Q-alias' }
  db.explorationIngest({ owner: ref, provider: 'wikidata', setKey: 'new-alias', nodes: [{ reference: ref, title: 'Explicit alias' }], relations: [], truncated: false })
  const graphId = String(db.sql.prepare('SELECT entity_id FROM music_exploration_refs WHERE value=?').get(ref.value)!.entity_id)
  set(graphId, 'ban')
  const physical = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(source(tracks[0]).id))!.artist_id)
  const original = publish(physical, 'artist-7')
  const candidate = identity.publish(identity.input(physical), [{ provider: 'ncm', name: 'Exact alias', summary: '', matcherVersion: 'fixture', references: [...original.references, ref], evidence: original.evidence }], 200)[0]
  const impact = identity.preview(review(candidate)).preferenceImpact!
  assert.equal(impact.conflict, true); assert.equal(impact.target?.state, 'favorite')
  assert.equal(pref.detail(graphId).scope, 'entity', 'candidate publication does not change graph preference scope')
  identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: impact.revision, choice: `related:${graphId}` } }, 201)
  assert.equal(pref.detail(existing).value?.state, 'ban'); assert.equal(pref.detail(physical).value?.state, 'ban'); assert.equal(pref.detail(graphId).value?.state, 'ban')
})

test('a same-named ordinary playlist is never adopted as default during migration or restore, even if it occupies the legacy system ID', t => {
  const { pref, tracks, rec } = fixture(t), ordinary = playlist('pl_favorites', [tracks[0]])
  const first = pref.playlistsMigrate({ version: 2, revision: 3, savedAt: 'old', data: [ordinary] }, 1)
  assert.deepEqual(first.data.find(p => p.id === ordinary.id), ordinary)
  assert.equal(first.data[0].id, 'pl_favorites_1'); assert.deepEqual(first.data[0].trackIds, [])
  assert.equal(pref.detail(rec(0)).value, null)
  const restored = pref.playlistsRestore([ordinary], 'restore-name-only', first.revision, 2)
  assert.deepEqual(restored.data.find(p => p.id === ordinary.id), ordinary)
  assert.deepEqual(restored.data.find(p => p.isDefault)!.trackIds, [])
})

test('fixed default migration preserves IDs/order/snapshots, ordinary duplicates, same-name and imported occurrences', t => {
  const { db, pref, tracks, rec } = fixture(t)
  const system = playlist('old-favorites', [tracks[1], tracks[0]], { isDefault: true })
  const ordinary = playlist('ordinary', [tracks[0], tracks[0]], { name: '我收藏的音乐' })
  const aggregate = playlist('aggregate', [tracks[2]], { kind: 'aggregate' })
  const saved = pref.playlistsMigrate({ version: 2, revision: 9, savedAt: 'old', data: [ordinary, system, aggregate] }, 1)
  assert.equal(saved.revision, 9); assert.deepEqual(saved.data, [ordinary, system, aggregate])
  assert.equal(pref.detail(rec(0)).value!.state, 'favorite'); assert.equal(pref.detail(rec(2)).value, null)
  assert.equal(db.sql.prepare('SELECT legacy_revision FROM personal_preference_playlists').get()!.legacy_revision, 9)
  setBan(); function setBan() { pref.set({ entityId: rec(0), state: 'ban', token: pref.detail(rec(0)).token }, 2) }
  const latest = pref.playlistsLoad()!
  assert.deepEqual(latest.data.find(p => p.id === system.id)!.trackIds, [tracks[1].id])
  assert.deepEqual(latest.data.find(p => p.id === ordinary.id), ordinary)
  assert.ok(latest.revision > saved.revision)
  assert.deepEqual(pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'ignored', data: [] }, 3), latest, 'completed marker never reimports old JSON')
  assert.throws(() => pref.playlistsSave(saved.data, saved.revision, 4), { code: 'ERR_PERSISTENCE_REVISION_CONFLICT' })
})

test('migration and ordinary persistence roll back preferences/completion on failure and retain missing legacy IDs', t => {
  const { db, pref, tracks } = fixture(t)
  const data = [playlist('system', [tracks[0]], { isDefault: true, trackIds: [tracks[0].id, 'missing'] })]
  db.sql.exec("CREATE TRIGGER fail_preference_migration BEFORE INSERT ON personal_preference_playlists BEGIN SELECT RAISE(ABORT,'publish failure'); END")
  assert.throws(() => pref.playlistsMigrate({ version: 2, revision: 4, savedAt: 'old', data }, 1), /publish failure/)
  assert.equal(pref.playlistsLoad(), null); assert.equal(pref.revision(), 0)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM personal_preference_values').get()!.n, 0)
  db.sql.exec('DROP TRIGGER fail_preference_migration')
  assert.deepEqual(pref.playlistsMigrate({ version: 2, revision: 4, savedAt: 'old', data }, 1).data[0].trackIds, [tracks[0].id, 'missing'])
  const receipt = pref.playlistsMigrationReceipt()!
  assert.equal(receipt.rawRowCount, 2); assert.equal(receipt.resolvedRowCount, 1); assert.equal(receipt.unresolvedRowCount, 1)
  assert.deepEqual(receipt.items[1], { position: 1, trackId: 'missing', status: 'unresolved', reason: 'missing_track' })
  const snapshot = JSON.stringify(receipt)
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [song('missing')] })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  assert.deepEqual(pref.playlistsLoad()!.data[0].trackIds, [tracks[0].id, 'missing'], 'later exact source discovery does not drop the unresolved legacy favorite')
  const doc = pref.playlistsLoad()!; doc.data[0].trackIds = []; doc.data[0].trackSnapshots = undefined
  pref.playlistsSave(doc.data, doc.revision, 2)
  assert.equal(JSON.stringify(pref.playlistsMigrationReceipt()), snapshot, 'ordinary edits do not rewrite the initial mapping receipt')
})

test('unfavorite only clears favorite and cannot erase another source ban', t => {
  const { pref, tracks, rec, set } = fixture(t)
  let doc = pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'old', data: [playlist('favorites', [tracks[0], tracks[1]], { isDefault: true })] }, 1)
  set(rec(1), 'ban'); doc = pref.playlistsLoad()!
  doc.data[0].trackIds = []; doc.data[0].trackSnapshots = undefined
  pref.playlistsSave(doc.data, doc.revision, 2)
  assert.equal(pref.detail(rec(0)).value!.state, 'none'); assert.equal(pref.detail(rec(1)).value!.state, 'ban')
  assert.deepEqual(pref.trackStates(tracks.slice(0, 3)), ['none', 'ban', null])
})

test('a catalog favorite uses the exact private local row before the next ordinary playlist save, never the path-free display snapshot', t => {
  const { db, pref, tracks, rec, set } = fixture(t)
  pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'old', data: [playlist('favorites', [], { isDefault: true })] }, 1)
  set(rec(0), 'favorite')
  const doc = pref.playlistsLoad()!, favorite = doc.data.find(p => p.isDefault)!
  assert.equal(favorite.trackSnapshots![tracks[0].id].filePath, tracks[0].filePath)
  doc.data.push(playlist('ordinary-new', []))
  const saved = pref.playlistsSave(doc.data, doc.revision, 2)
  assert.ok(saved.data.some(p => p.id === 'ordinary-new'))
  assert.equal(pref.detail(rec(0)).value!.state, 'favorite')
  assert.equal(JSON.parse(String(db.sql.prepare('SELECT payload FROM catalog_sources WHERE track_id=?').get(tracks[0].id)!.payload)).filePath, '', 'public catalog snapshots stay path-free')
})

test('an offline or path-replaced local favorite is not rebound to a different source when projecting the default list', t => {
  const { db, pref, tracks, rec, set } = fixture(t)
  pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'old', data: [playlist('favorites', [], { isDefault: true })] }, 1)
  const id = rec(0)
  set(id, 'favorite')
  db.sql.prepare('UPDATE tracks SET payload=? WHERE id=?').run(JSON.stringify({ ...tracks[0], filePath: 'D:/replacement/song.flac' }), tracks[0].id)
  const offline = pref.playlistsLoad()!.data.find(p => p.isDefault)!
  assert.deepEqual(offline.trackIds, [tracks[0].id])
  assert.equal(offline.trackSnapshots![tracks[0].id].filePath, tracks[0].filePath!.replaceAll('\\', '/').toLowerCase())
  assert.equal(pref.detail(id).value!.state, 'favorite', 'the original offline identity keeps its preference')
  db.sql.prepare('DELETE FROM tracks WHERE id=?').run(tracks[0].id)
  const doc = pref.playlistsLoad()!
  assert.deepEqual(doc.data.find(p => p.isDefault)!.trackIds, [tracks[0].id])
  doc.data.push(playlist('ordinary', []))
  assert.ok(pref.playlistsSave(doc.data, doc.revision, 3).data.some(p => p.id === 'ordinary'))
})

test('preference identity conflicts require independent choice, stale previews fail, detach restores original values', t => {
  const { pref, identity, rec, set, publish, review, confirm } = fixture(t), a = rec(0), b = rec(1)
  set(a, 'ban'); confirm(publish(a)); set(b, 'favorite')
  const candidate = publish(b), preview = identity.preview(review(candidate))
  assert.equal(preview.preferenceImpact!.conflict, true)
  assert.throws(() => confirm(candidate), { code: 'PREFERENCE_CONFLICT' })
  set(a, 'none')
  assert.throws(() => identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: preview.preferenceImpact!.revision, choice: 'current' } }, 3), { code: 'STALE_REVISION' })
  const current = identity.preview(review(candidate))
  identity.decide({ ...review(candidate), decision: 'confirm', preferenceResolution: { revision: current.preferenceImpact!.revision, choice: 'target' } }, 4)
  assert.equal(pref.detail(b).value!.state, 'none')
  set(a, 'ban'); const link = identity.detail(b).link!
  identity.detach(link.id, link.revision, 5)
  assert.equal(pref.detail(b).value!.state, 'favorite'); assert.equal(pref.detail(a).value!.state, 'ban')
  const page = identity.history({ entityId: b }), history = page.items.find(v => v.state === 'confirmed')!
  const restore = { entityId: b, historySeq: history.seq, linkRevision: page.current.link!.revision, inputVersion: page.inputVersion }
  assert.equal(identity.restorePreview(restore).preferenceImpact!.conflict, true)
  assert.throws(() => identity.restore(restore, 6), { code: 'PREFERENCE_CONFLICT' })
  identity.restore({ ...restore, preferenceResolution: { revision: pref.revision(), choice: 'clear' } }, 6)
  assert.equal(pref.detail(a).value!.state, 'none')
})

test('late identity audit failure rolls carried preferences and history back atomically', t => {
  const { db, pref, rec, set, publish, confirm } = fixture(t), id = rec(0)
  set(id, 'ban'); const c = publish(id), before = pref.revision()
  db.sql.exec("CREATE TRIGGER fail_preference_identity BEFORE INSERT ON metadata_identity_history WHEN new.state='confirmed' BEGIN SELECT RAISE(ABORT,'audit failure'); END")
  assert.throws(() => confirm(c), /audit failure/)
  assert.equal(pref.detail(id).scope, 'entity'); assert.equal(pref.detail(id).value!.state, 'ban'); assert.equal(pref.revision(), before)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM personal_preference_values').get()!.n, 1)
})

test('automatic eligibility uses precise recording/release/main-artist IDs, not names, credits or manual versions; candidates are pure reads', t => {
  const { db, pref, tracks, rec, set, source, publish, confirm } = fixture(t)
  // retain a remote catalog source through migration without making it a library member.
  pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'old', data: [playlist('f', [tracks[3]], { isDefault: true })] }, 1)
  set(rec(0), 'ban')
  assert.deepEqual(pref.automaticEligibility([tracks[0], tracks[1]]), [false, true])
  const versions = emptyMusicVersions(); versions.tracks.versions = [{ id: 'manual', label: 'same', sources: [String(source(tracks[0]).source_key), String(source(tracks[1]).source_key)], preferredSource: null }]
  db.catalogProjectVersions(versions, 1)
  assert.deepEqual(pref.automaticEligibility([tracks[0], tracks[1]]), [false, true])
  const remote = source(tracks[3]); set(String(remote.release_id), 'ban')
  const before = db.sql.prepare('SELECT total_changes() n').get()!.n
  assert.deepEqual(pref.automaticEligibility([song('ncm:99', { source: 'ncm', ncmSongId: 99, albumId: 'album-7' }), song('qq:99', { source: 'qq', albumId: 'album-7' })]), [false, true])
  assert.equal(db.sql.prepare('SELECT total_changes() n').get()!.n, before)
  set(String(remote.release_id), 'none')
  const artist = String(db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(remote.id))!.artist_id)
  confirm(publish(artist, 'artist-7')); set(artist, 'ban')
  assert.deepEqual(pref.automaticEligibility([song('ncm:100', { source: 'ncm', artists: [{ id: 'artist-7', name: 'renamed' }] }), song('ncm:101', { source: 'ncm', artist: 'Main' })]), [false, true])
  assert.throws(() => pref.detail(db.catalogQuery({ kind: 'recording' }).items.find(e => e.identity === 'manual')!.id), /具体歌曲/)
})

test('recording, release and main-artist detach/replacement never resurrect historical native-reference bans', t => {
  for (const kind of ['recording', 'release', 'artist'] as const) {
    const f = fixture(t), remote = f.source(f.tracks[3])
    const id = kind === 'artist' ? String(f.db.sql.prepare('SELECT artist_id FROM catalog_source_artists WHERE source_id=?').get(String(remote.id))!.artist_id)
      : String(remote[kind === 'recording' ? 'recording_id' : 'release_id'])
    if (kind !== 'artist') f.set(id, 'favorite')
    f.confirm(f.publish(id, kind === 'recording' ? '7' : kind === 'release' ? 'album-7' : 'artist-7'))
    f.set(id, 'ban')
    const link = f.identity.detail(id).link!
    f.identity.detach(link.id, link.revision, 300)
    assert.deepEqual(f.pref.automaticEligibility([f.tracks[3]]), [true], `${kind}: retained source must obey detach`)
    const candidate = song('ncm:unseen', { source: 'ncm', ncmSongId: 99, albumId: 'album-7', artists: [{ id: 'artist-7', name: 'Main' }] })
    assert.deepEqual(f.pref.automaticEligibility([candidate]), [true], `${kind}: native alias must obey detach`)
    f.confirm(f.publish(id, `replacement-${kind}`))
    f.set(id, 'favorite')
    assert.deepEqual(f.pref.automaticEligibility([f.tracks[3], candidate]), [true, true], `${kind}: replacement outranks retained old reference`)
  }
})

test('document migration/save/restore keep the original 20 MiB capacity limit and rollback completion', t => {
  const { pref } = fixture(t), huge = [playlist('f', [], { isDefault: true, name: 'x'.repeat(20 * 1024 * 1024) })]
  assert.throws(() => pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'x', data: huge }, 1), /20 MiB/)
  assert.equal(pref.playlistsLoad(), null)
  const doc = pref.playlistsMigrate({ version: 2, revision: 0, savedAt: 'x', data: [playlist('f', [], { isDefault: true })] }, 1)
  assert.throws(() => pref.playlistsSave(huge, doc.revision, 2), /20 MiB/)
  assert.throws(() => pref.playlistsRestore(huge, 'restore', doc.revision, 2), /20 MiB/)
  assert.equal(pref.playlistsLoad()!.revision, doc.revision)
})

test('v1 backup exports/restores SQLite playlist authority; crash replay is idempotent and retained JSON stays recovery-only', async t => {
  const root = mkdtempSync(join(tmpdir(), 'te-preference-backup-'))
  const { db, pref, tracks } = fixture(t, join(root, 'music-library.sqlite'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const retained = { version: 2 as const, revision: 2, savedAt: 'old', data: [playlist('legacy', [tracks[0]], { isDefault: true })] }
  writeFileSync(join(root, 'playlists.json'), JSON.stringify(retained))
  let doc = pref.playlistsMigrate(retained, 1)
  doc.data[0].trackIds.push(tracks[1].id); doc.data[0].trackSnapshots![tracks[1].id] = tracks[1]
  pref.playlistsSave(doc.data, doc.revision, 2)
  const api: PersonalLibraryDatabase = {
    exportDocument: async (...args) => db.exportDocument(...args), getMetadata: async () => db.getMetadata(),
    restoreDocument: (...args) => db.restoreDocument(...args), restorePersonalLibrary: (...args) => db.restorePersonalLibrary(...args),
    previewPersonalLibrary: async (...args) => db.previewPersonalLibrary(...args), exportPlaybackQueue: async (...args) => db.exportPlaybackQueue(...args),
    preferencesPlaylistsLoad: async () => pref.playlistsLoad(), preferencesPlaylistsRestore: async (...args) => pref.playlistsRestore(...args)
  }
  const repository = createPersonalBackupRepository(), exported = await repository.createPersonalBackupFromDatabase(root, {}, api)
  assert.equal((exported.data.playlists as Playlist[])[0].trackIds.length, 2)
  const backup = { ...exported, data: { playlists: [playlist('backup-default', [tracks[2]], { isDefault: true })] } }
  await repository.stagePersonalRestoreFromDatabase(root, backup, { domains: ['playlists'], conflict: 'use-backup', mappings: [] }, [], api)
  let interrupted = false
  await assert.rejects(repository.applyPendingPersonalRestoreFromDatabase(root, api, name => { if (name !== 'playlists.json' && !interrupted) { interrupted = true; throw new Error('after SQL ACK crash') } }), /crash/)
  doc = pref.playlistsLoad()!
  const revision = doc.revision
  await repository.applyPendingPersonalRestoreFromDatabase(root, api)
  assert.equal(pref.playlistsLoad()!.revision, revision)
  assert.equal((await repository.createPersonalBackupFromDatabase(root, {}, api)).data.playlists !== undefined, true)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'playlists.json'), 'utf8')), retained)
})
