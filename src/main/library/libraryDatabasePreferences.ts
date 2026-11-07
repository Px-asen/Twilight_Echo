import type { DatabaseSync } from 'node:sqlite'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { MusicExternalReference } from '../../shared/musicIdentification.ts'
import type { TrackData } from '../../shared/track.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { isVersionedDataEnvelope, PersistentDataRevisionConflictError, type VersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import { getTrackSource, versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import { LibraryDatabaseCatalog } from './libraryDatabaseCatalog.ts'
import {
  validMusicPreferencesPayload, validMusicPreferenceResolution, validMusicPreferenceChoice,
  type MusicPreferenceKind, type MusicPreferenceState, type MusicPreferenceValue,
  type MusicPreferencesDetail, type MusicPreferencesSet, type MusicPreferencesHistoryQuery,
  type MusicPreferencesHistoryPage, type MusicPreferencesTargetsQuery, type MusicPreferencesTargetsPage,
  type MusicPreferenceChangeReason, type MusicPreferenceImpact, type MusicPreferenceResolution, type MusicPreferencesMigrationReceipt
} from '../../shared/musicPreferences.ts'

export const PREFERENCE_SCHEMA_OBJECTS = [
  'personal_preferences_state', 'personal_preference_values', 'personal_preference_history',
  'personal_preference_history_target', 'personal_preference_playlists',
  'personal_preferences_identity_insert', 'personal_preferences_identity_update',
  'personal_preferences_identity_delete', 'personal_preferences_playlist_revision', 'personal_preference_restores'
]
const preferenceValuesTable = (name: string) => `CREATE TABLE ${name}(profile_id TEXT NOT NULL CHECK(profile_id='default'),target_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('recording','release','artist','work')),state TEXT NOT NULL CHECK(state IN ('none','favorite','ban')),
 revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(profile_id,target_key));`
const preferenceHistoryTable = (name: string) => `CREATE TABLE ${name}(seq INTEGER PRIMARY KEY AUTOINCREMENT,profile_id TEXT NOT NULL CHECK(profile_id='default'),
 target_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('recording','release','artist','work')),state TEXT NOT NULL CHECK(state IN ('none','favorite','ban')),
 revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,reason TEXT NOT NULL);`
/** Run inside the schema-27 transaction. Personal values and the audit sequence remain the same authority. */
export const PREFERENCE_WORK_MIGRATION_SQL = `
${preferenceValuesTable('personal_preference_values_work')}
INSERT INTO personal_preference_values_work SELECT * FROM personal_preference_values;
DROP TABLE personal_preference_values;
ALTER TABLE personal_preference_values_work RENAME TO personal_preference_values;
${preferenceHistoryTable('personal_preference_history_work')}
INSERT INTO personal_preference_history_work SELECT * FROM personal_preference_history;
INSERT INTO sqlite_sequence(name,seq) SELECT 'personal_preference_history_work',seq FROM sqlite_sequence
 WHERE name='personal_preference_history' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='personal_preference_history_work');
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='personal_preference_history'),0))
 WHERE name='personal_preference_history_work';
DROP TABLE personal_preference_history;
ALTER TABLE personal_preference_history_work RENAME TO personal_preference_history;
CREATE INDEX personal_preference_history_target ON personal_preference_history(profile_id,target_key,seq);
`
export const PREFERENCE_SCHEMA_SQL = `
CREATE TABLE personal_preferences_state(profile_id TEXT PRIMARY KEY CHECK(profile_id='default'),revision INTEGER NOT NULL);
INSERT INTO personal_preferences_state VALUES('default',0);
${preferenceValuesTable('personal_preference_values')}
${preferenceHistoryTable('personal_preference_history')}
CREATE INDEX personal_preference_history_target ON personal_preference_history(profile_id,target_key,seq);
CREATE TABLE personal_preference_playlists(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,saved_at TEXT NOT NULL,
 payload TEXT NOT NULL,legacy_revision INTEGER NOT NULL,default_id TEXT NOT NULL,migration_receipt TEXT NOT NULL);
CREATE TABLE personal_preference_restores(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE TRIGGER personal_preferences_identity_insert AFTER INSERT ON metadata_identity_links
WHEN new.kind IN ('recording','release','artist') AND new.state='confirmed'
BEGIN UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_preferences_identity_update AFTER UPDATE ON metadata_identity_links
WHEN new.kind IN ('recording','release','artist') AND (old.state='confirmed' OR new.state='confirmed')
 AND (old.revision IS NOT new.revision OR old.state IS NOT new.state OR old.target_id IS NOT new.target_id)
BEGIN UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_preferences_identity_delete AFTER DELETE ON metadata_identity_links
WHEN old.kind IN ('recording','release','artist') AND old.state='confirmed'
BEGIN UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default'; END;
CREATE TRIGGER personal_preferences_playlist_revision AFTER UPDATE OF revision ON personal_preferences_state
BEGIN UPDATE personal_preference_playlists SET revision=revision+1 WHERE id=1; END;
`
type Owner = { sql: DatabaseSync; transaction<T>(action: () => T): T }
type Target = { kind: MusicPreferenceKind; scope: 'entity' | 'identity'; key: string; linkRevision: number }
type Row = Record<string, unknown>
const isKind = (v: unknown): v is MusicPreferenceKind => v === 'recording' || v === 'release' || v === 'artist' || v === 'work'
const targetKey = (scope: Target['scope'], kind: MusicPreferenceKind, id: string) => JSON.stringify([scope, kind, id])
const stale = () => Object.assign(new Error('偏好或身份关联已变化，请重新读取后再操作'), { code: 'STALE_REVISION' })
const decode = (row: Row): MusicPreferenceValue => ({ state: row.state as MusicPreferenceState, revision: Number(row.revision), updatedAt: Number(row.updated_at) })
const validPlaylists = (v: unknown): v is Playlist[] => Array.isArray(v) && v.every(p => p && typeof p.id === 'string' && !!p.id &&
  typeof p.name === 'string' && typeof p.createdAt === 'string' && Array.isArray(p.trackIds) && p.trackIds.every(id => typeof id === 'string')) && new Set(v.map(p => p.id)).size === v.length
function assertDocumentCapacity(data: Playlist[], revision: number, savedAt: string) {
  if (Buffer.byteLength(JSON.stringify({ version: 2, revision, savedAt, data })) > 20 * 1024 * 1024)
    throw new Error('playlists 数据超过20 MiB保存容量')
}

/** Sole local preference and default-favorites authority. All publication is one SQLite transaction. */
export class LibraryDatabasePreferences {
  private readonly owner: Owner
  constructor(owner: Owner) { this.owner = owner }
  private get sql() { return this.owner.sql }
  private transaction<T>(action: () => T): T { return this.sql.isTransaction ? action() : this.owner.transaction(action) }
  private read<T>(action: () => T): T {
    if (this.sql.isTransaction) return action()
    this.sql.exec('BEGIN')
    try { const value = action(); this.sql.exec('COMMIT'); return value }
    catch (error) { this.sql.exec('ROLLBACK'); throw error }
  }
  revision(): number { return Number(this.sql.prepare("SELECT revision FROM personal_preferences_state WHERE profile_id='default'").get()!.revision) }
  private target(entityId: string, allowUnconfirmedArtist = false): Target {
    const entity = this.sql.prepare('SELECT kind,identity FROM catalog_entities WHERE id=?').get(entityId)
    if (!entity || !isKind(entity.kind) || entity.identity !== 'source') throw new Error('请先选择具体歌曲、专辑发行版、人物或作品')
    if (entity.kind === 'work') return { kind: 'work', scope: 'entity', key: targetKey('entity', 'work', entityId), linkRevision: 0 }
    const link = this.sql.prepare('SELECT revision,state,target_id FROM metadata_identity_links WHERE entity_id=? AND kind=?').get(entityId, entity.kind)
    if (link?.state === 'confirmed' && link.target_id) {
      if (this.sql.prepare('SELECT kind FROM metadata_entities WHERE id=?').get(String(link.target_id))?.kind !== entity.kind) throw new Error('偏好身份类型不匹配，请重新核对关联')
      return { kind: entity.kind, scope: 'identity', key: targetKey('identity', entity.kind, String(link.target_id)), linkRevision: Number(link.revision) }
    }
    if (entity.kind === 'artist') {
      const matches = this.sql.prepare(`SELECT DISTINCT ir.target_id FROM music_exploration_refs er
        JOIN metadata_identity_refs ir ON ir.provider=er.provider AND ir.kind=er.kind AND ir.id_type=er.id_type AND ir.value=er.value
        JOIN metadata_entities me ON me.id=ir.target_id AND me.kind='artist'
        JOIN metadata_identity_links confirmed ON confirmed.target_id=ir.target_id AND confirmed.kind='artist' AND confirmed.state='confirmed'
        WHERE er.entity_id=? AND er.kind='artist' LIMIT 2`).all(entityId)
      if (matches.length > 1) throw Object.assign(new Error('人物的明确外部引用指向不同身份，请先复核关联'), { code: 'IDENTITY_CONFLICT' })
      if (matches.length === 1) return { kind: 'artist', scope: 'identity', key: targetKey('identity', 'artist', String(matches[0].target_id)), linkRevision: 0 }
    }
    if (entity.kind === 'artist' && !allowUnconfirmedArtist &&
      !this.sql.prepare('SELECT 1 FROM music_exploration_refs WHERE entity_id=? LIMIT 1').get(entityId)) throw new Error('请先确认艺人身份，再设置艺人偏好')
    return { kind: entity.kind, scope: 'entity', key: targetKey('entity', entity.kind, entityId), linkRevision: Number(link?.revision ?? 0) }
  }
  private value(key: string): MusicPreferenceValue | null {
    const row = this.sql.prepare("SELECT * FROM personal_preference_values WHERE profile_id='default' AND target_key=?").get(key)
    return row ? decode(row) : null
  }
  detail(entityId: string): MusicPreferencesDetail {
    if (!validMusicPreferencesPayload('preferences.detail', { entityId })) throw new Error('无效的偏好查询')
    return this.read(() => { const t = this.target(entityId); return { entityId, kind: t.kind, scope: t.scope, value: this.value(t.key),
      token: { preferencesRevision: this.revision(), linkRevision: t.linkRevision, targetKey: t.key } } })
  }
  targets(query: MusicPreferencesTargetsQuery): MusicPreferencesTargetsPage {
    if (!validMusicPreferencesPayload('preferences.targets', query)) throw new Error('无效的偏好对象查询')
    return this.read(() => {
      const e = this.sql.prepare('SELECT * FROM catalog_entities WHERE id=?').get(query.entityId)
      if (!e || !isKind(e.kind)) throw new Error('该对象不支持个人偏好')
      const offset = query.offset ?? 0, c = query.trackContext
      if (e.kind === 'artist' || e.kind === 'work') {
        const eligible = e.identity === 'source' && (e.kind === 'work' ||
          !!this.sql.prepare("SELECT 1 FROM metadata_identity_links WHERE entity_id=? AND kind='artist' AND state='confirmed'").get(query.entityId) ||
          !!this.sql.prepare('SELECT 1 FROM music_exploration_refs WHERE entity_id=? LIMIT 1').get(query.entityId))
        return { entityId: query.entityId, offset, total: eligible ? 1 : 0,
          items: eligible && offset === 0 ? [{ id: query.entityId, kind: e.kind, title: String(e.title), artist: String(e.artist) }] : [] }
      }
      const column = e.kind === 'recording' ? 'recording_id' : 'release_id'
      const sub = e.identity === 'source'
        ? c ? `SELECT ${column} AS id FROM catalog_sources WHERE ${column}=? AND provider=? AND track_id=?` : 'SELECT id FROM catalog_entities WHERE id=?'
        : `SELECT DISTINCT s.${column} AS id FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id WHERE b.entity_id=? ${c ? 'AND s.provider=? AND s.track_id=?' : ''}`
      const args = [query.entityId, ...(c ? [c.provider, c.id] : [])]
      const from = `FROM catalog_entities e WHERE e.identity='source' AND e.kind=? AND e.id IN (${sub})`
      return { entityId: query.entityId, offset, total: Number(this.sql.prepare(`SELECT count(*) n ${from}`).get(e.kind, ...args)!.n),
        items: this.sql.prepare(`SELECT e.id,e.kind,e.title,e.artist ${from} ORDER BY e.id LIMIT ? OFFSET ?`).all(e.kind, ...args, query.limit ?? 20, offset)
          .map(r => ({ id: String(r.id), kind: r.kind as MusicPreferenceKind, title: String(r.title), artist: String(r.artist) })) }
    })
  }
  private write(t: Pick<Target, 'kind' | 'key'>, state: MusicPreferenceState, now: number, reason: MusicPreferenceChangeReason) {
    const old = this.value(t.key), revision = (old?.revision ?? 0) + 1
    this.sql.prepare(`INSERT INTO personal_preference_values VALUES('default',?,?,?,?,?) ON CONFLICT(profile_id,target_key)
      DO UPDATE SET state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at`).run(t.key, t.kind, state, revision, now)
    this.sql.prepare(`INSERT INTO personal_preference_history(profile_id,target_key,kind,state,revision,updated_at,reason) VALUES('default',?,?,?,?,?,?)`)
      .run(t.key, t.kind, state, revision, now, reason)
    this.sql.prepare("UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default'").run()
  }
  set(request: MusicPreferencesSet, now: number): MusicPreferencesDetail {
    if (!validMusicPreferencesPayload('preferences.set', request) || !Number.isSafeInteger(now) || now < 0) throw new Error('无效的个人偏好')
    return this.transaction(() => {
      const t = this.target(request.entityId), token = request.token
      if (token.preferencesRevision !== this.revision() || token.linkRevision !== t.linkRevision || token.targetKey !== t.key) throw stale()
      this.write(t, request.state, now, request.state === 'none' ? 'clear' : 'set')
      const document = this.playlistsLoad()
      if (document) assertDocumentCapacity(document.data, document.revision, document.savedAt)
      return this.detail(request.entityId)
    })
  }
  history(query: MusicPreferencesHistoryQuery): MusicPreferencesHistoryPage {
    if (!validMusicPreferencesPayload('preferences.history', query)) throw new Error('无效的偏好历史查询')
    return this.read(() => {
      const t = this.target(query.entityId), offset = query.offset ?? 0
      return { entityId: query.entityId, kind: t.kind, scope: t.scope, offset,
        total: Number(this.sql.prepare("SELECT count(*) n FROM personal_preference_history WHERE profile_id='default' AND target_key=?").get(t.key)!.n),
        items: this.sql.prepare("SELECT * FROM personal_preference_history WHERE profile_id='default' AND target_key=? ORDER BY seq DESC LIMIT ? OFFSET ?")
          .all(t.key, query.limit ?? 20, offset).map(r => ({ ...decode(r), seq: Number(r.seq), reason: r.reason as MusicPreferenceChangeReason })) }
    })
  }
  identityImpact(entityId: string, kind: CatalogKind, proposedTargetId: string | null, proposedReferences: MusicExternalReference[] = []): MusicPreferenceImpact | undefined {
    if (!isKind(kind) || this.sql.prepare('SELECT identity FROM catalog_entities WHERE id=?').get(entityId)?.identity !== 'source') return undefined
    return this.read(() => {
      const currentKey = this.target(entityId, true).key, own = this.value(currentKey), nextKey = proposedTargetId ? targetKey('identity', kind, proposedTargetId) : null
      const related: NonNullable<MusicPreferenceImpact['related']> = []
      if (kind === 'artist') {
        const refs = [...proposedReferences, ...this.sql.prepare('SELECT provider,kind,id_type,value FROM metadata_identity_refs WHERE target_id=? AND kind=\'artist\'')
          .all(proposedTargetId).map(row => ({ provider: String(row.provider), kind: 'artist' as const, idType: String(row.id_type), value: String(row.value) }))]
        const anchors = this.sql.prepare(`SELECT DISTINCT e.id,e.title FROM music_exploration_refs er JOIN catalog_entities e ON e.id=er.entity_id
          JOIN json_each(?) ref ON er.provider=json_extract(ref.value,'$.provider') AND er.kind=json_extract(ref.value,'$.kind')
            AND er.id_type=json_extract(ref.value,'$.idType') AND er.value=json_extract(ref.value,'$.value')
          WHERE e.kind='artist' AND e.identity='source' AND e.id<>? ORDER BY e.id`).all(JSON.stringify(refs), entityId)
        for (const row of anchors) {
          const target = this.target(String(row.id), true)
          const value = target.scope === 'entity' ? this.value(target.key) : null
          if (value) related.push({ entityId: String(row.id), title: String(row.title), value })
        }
        related.sort((a, b) => b.value.updatedAt - a.value.updatedAt || a.entityId.localeCompare(b.entityId))
      }
      const current = own ?? related[0]?.value ?? null, target = nextKey ? this.value(nextKey) : null
      const conflict = new Set([own, ...related.map(item => item.value), target].filter((value): value is MusicPreferenceValue => !!value).map(value => value.state)).size > 1
      return { revision: this.revision(), current, target, conflict,
        action: conflict ? 'choose' : nextKey === currentKey ? 'keep' : target ? 'share' : current ? 'carry' : 'keep',
        ...(related.length ? { related } : {}) }
    })
  }
  applyIdentity(entityId: string, kind: CatalogKind, proposedTargetId: string, resolution: MusicPreferenceResolution | undefined, now: number, proposedReferences: MusicExternalReference[] = []): void {
    const impact = this.identityImpact(entityId, kind, proposedTargetId, proposedReferences)
    if (!impact || !isKind(kind)) { if (resolution) throw new Error('此身份不支持个人偏好选择'); return }
    if (resolution && (!validMusicPreferenceResolution(resolution) || resolution.revision !== impact.revision)) throw stale()
    if (resolution && !validMusicPreferenceChoice(resolution.choice, impact)) throw stale()
    if (impact.conflict && !resolution) throw Object.assign(new Error('当前条目与目标身份的收藏／禁播偏好不同，请选择保留哪一项'), { code: 'PREFERENCE_CONFLICT' })
    const target = { kind, key: targetKey('identity', kind, proposedTargetId) }
    if (resolution?.choice.startsWith('related:')) {
      const value = impact.related!.find(item => item.entityId === resolution.choice.slice(8))!.value
      if (!impact.target || value.state !== impact.target.state) this.write(target, value.state, now, 'identity_current')
    } else if (resolution?.choice === 'clear') this.write(target, 'none', now, 'identity_clear')
    else if (resolution?.choice === 'current') {
      if (!impact.current) throw new Error('当前条目没有可保留的偏好')
      if (!impact.target || impact.current.state !== impact.target.state) this.write(target, impact.current.state, now, 'identity_current')
    } else if (resolution?.choice !== 'target' && !impact.target && impact.current) this.write(target, impact.current.state, now, 'identity_carry')
  }
  private source(track: TrackData): Row | undefined { return this.sql.prepare('SELECT * FROM catalog_sources WHERE source_key=?').get(versionSourceKey(track)) }
  private retain(track: TrackData): Row | undefined {
    const existing = this.source(track)
    if (existing) return existing
    if (['network', 'radio', 'podcast', 'playlist-import'].includes(getTrackSource(track))) return undefined
    const catalog = new LibraryDatabaseCatalog({ ...this.owner, collectionSelection() { throw new Error('Collection selection is not part of personal-source retention') } })
    const id = catalog.retainPersonalSource(track)
    return this.sql.prepare('SELECT * FROM catalog_sources WHERE id=?').get(id)
  }
  private snapshot(playlist: Playlist, id: string): TrackData | undefined {
    const snapshot = playlist.trackSnapshots?.[id]
    if (snapshot) {
      if (snapshot.id !== id) throw new Error('收藏快照与原曲目ID不一致')
      return snapshot
    }
    const row = this.sql.prepare('SELECT payload FROM tracks WHERE id=?').get(id)
    if (row) return libraryTrack(JSON.parse(String(row.payload)))
    const sources = this.sql.prepare('SELECT payload FROM catalog_sources WHERE track_id=? LIMIT 2').all(id)
    return sources.length === 1 ? JSON.parse(String(sources[0].payload)) as TrackData : undefined
  }
  private defaultPlaylist(data: Playlist[]): Playlist | undefined {
    return data.find(p => p.isDefault)
  }
  private newDefault(data: Playlist[], now: number): Playlist {
    let id = 'pl_favorites', suffix = 0
    while (data.some(p => p.id === id)) id = `pl_favorites_${++suffix}`
    return { id, name: '我收藏的音乐', isDefault: true, createdAt: new Date(now).toISOString(), trackIds: [] }
  }
  private memberTargets(p: Playlist, retain: boolean): Map<string, Target> {
    const result = new Map<string, Target>()
    for (const id of p.trackIds) {
      const track = this.snapshot(p, id)
      if (!track) continue // Missing legacy entries remain visible and recoverable by their original IDs.
      const source = retain ? this.retain(track) : this.source(track)
      if (source) result.set(this.target(String(source.recording_id)).key, this.target(String(source.recording_id)))
    }
    return result
  }
  playlistsLoad(): VersionedDataEnvelope<Playlist[]> | null {
    return this.read(() => {
      const row = this.sql.prepare('SELECT * FROM personal_preference_playlists WHERE id=1').get()
      if (!row) return null
      const data = JSON.parse(String(row.payload)) as Playlist[], p = data.find(p => p.id === row.default_id)
      if (!p) throw new Error('默认收藏权威文档损坏')
      const represented = new Set<string>(), snapshots = { ...p.trackSnapshots }
      p.trackIds = p.trackIds.filter(id => {
        const track = this.snapshot(p, id), source = track ? this.source(track) : undefined
        if (!source) return true
        const target = this.target(String(source.recording_id)), value = this.value(target.key)
        if (!value) return true // An unresolved legacy ID may acquire an exact source after migration.
        if (value.state !== 'favorite') { delete snapshots[id]; return false }
        represented.add(target.key); return true
      })
      // One retained source represents a newly favorited recording identity. Existing order/IDs win.
      const rows = this.sql.prepare(`SELECT s.* FROM catalog_sources s WHERE EXISTS(
        SELECT 1 FROM personal_preference_values v WHERE v.profile_id='default' AND v.kind='recording' AND v.state='favorite'
        AND (v.target_key=json_array('entity','recording',s.recording_id) OR v.target_key IN (
          SELECT json_array('identity','recording',l.target_id) FROM metadata_identity_links l
          WHERE l.entity_id=s.recording_id AND l.kind='recording' AND l.state='confirmed'))) ORDER BY s.id`).all()
      for (const source of rows) {
        const target = this.target(String(source.recording_id))
        if (represented.has(target.key) || this.value(target.key)?.state !== 'favorite') continue
        let track = JSON.parse(String(source.payload)) as TrackData
        if (source.provider === 'local') {
          // Catalog display snapshots deliberately omit file paths. A newly
          // favorited local recording must use its exact current private row,
          // otherwise the next ordinary playlist save cannot retain its source.
          const row = this.sql.prepare('SELECT payload FROM tracks WHERE id=?').get(source.track_id)
          const current = row ? libraryTrack(JSON.parse(String(row.payload))) : undefined
          if (current && versionSourceKey(current) === source.source_key) track = current
          else {
            // Offline favorites retain the original private source identity,
            // not a replacement file that happens to reuse the legacy Track ID.
            const [, filePath, subTrack, cueRange] = JSON.parse(String(source.source_key))
            track = { ...track, filePath, ...(subTrack ? { subTrack } : {}), ...(cueRange ? { cueRange } : {}) }
          }
        }
        if (p.trackIds.includes(track.id)) continue
        p.trackIds.push(track.id); snapshots[track.id] = track; represented.add(target.key)
      }
      p.trackSnapshots = Object.keys(snapshots).length ? snapshots : undefined
      return { version: 2, revision: Number(row.revision), savedAt: String(row.saved_at), data }
    })
  }
  playlistsMigrationReceipt(): MusicPreferencesMigrationReceipt | null {
    const row = this.sql.prepare('SELECT migration_receipt FROM personal_preference_playlists WHERE id=1').get()
    return row ? JSON.parse(String(row.migration_receipt)) as MusicPreferencesMigrationReceipt : null
  }
  playlistsMigrate(envelope: VersionedDataEnvelope<Playlist[]>, now: number, audit?: { logicalMemberCount: number }): VersionedDataEnvelope<Playlist[]> {
    if (!isVersionedDataEnvelope(envelope, validPlaylists) || !Number.isSafeInteger(now) || now < 0) throw new Error('未读取到完整、有版本的原歌单快照，收藏迁移尚未发布')
    if (audit && (!Number.isSafeInteger(audit.logicalMemberCount) || audit.logicalMemberCount < 0)) throw new Error('无效的原收藏逻辑成员数')
    assertDocumentCapacity(envelope.data, envelope.revision, new Date(now).toISOString())
    return this.transaction(() => {
      const current = this.playlistsLoad()
      if (current) return current
      const data = structuredClone(envelope.data)
      let p = this.defaultPlaylist(data)
      if (!p) { p = this.newDefault(data, now); data.unshift(p) }
      // Normalize only the selected system list; never merge same-named ordinary/aggregate lists.
      p.isDefault = true
      assertDocumentCapacity(data, envelope.revision, new Date(now).toISOString())
      const items: MusicPreferencesMigrationReceipt['items'] = p.trackIds.map((trackId, position) => {
        const track = this.snapshot(p!, trackId), source = track ? this.retain(track) : undefined
        if (!source) return { position, trackId, status: 'unresolved', reason: track ? 'unsupported_source' : 'missing_track' }
        const target = this.target(String(source.recording_id))
        if (!this.value(target.key)) this.write(target, 'favorite', now, 'legacy_favorite')
        return { position, trackId, status: 'resolved', sourceId: String(source.id), recordingId: String(source.recording_id), targetKey: target.key }
      })
      const resolvedRowCount = items.filter(item => item.status === 'resolved').length
      const receipt: MusicPreferencesMigrationReceipt = { sourceRevision: envelope.revision, defaultPlaylistId: p.id, migratedAt: now,
        rawRowCount: items.length, logicalMemberCount: audit?.logicalMemberCount ?? null, resolvedRowCount, unresolvedRowCount: items.length - resolvedRowCount, items }
      this.sql.prepare('INSERT INTO personal_preference_playlists VALUES(1,?,?,?,?,?,?)')
        .run(envelope.revision, new Date(now).toISOString(), JSON.stringify(data), envelope.revision, p.id, JSON.stringify(receipt))
      const result = this.playlistsLoad()!
      assertDocumentCapacity(result.data, result.revision, result.savedAt)
      return result
    })
  }
  playlistsSave(data: Playlist[], expectedRevision: number, now: number): VersionedDataEnvelope<Playlist[]> {
    if (!validPlaylists(data) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error('无效的歌单保存请求')
    assertDocumentCapacity(data, expectedRevision + 1, new Date(now).toISOString())
    return this.transaction(() => {
      const current = this.playlistsLoad()
      if (!current) throw new Error('默认收藏迁移尚未完成')
      if (current.revision !== expectedRevision) throw new PersistentDataRevisionConflictError(current, expectedRevision)
      const stored = this.sql.prepare('SELECT default_id FROM personal_preference_playlists WHERE id=1').get()!, id = String(stored.default_id)
      const before = current.data.find(p => p.id === id)!, after = data.find(p => p.id === id)
      if (!after || !after.isDefault) throw new Error('默认收藏不能删除或转成普通歌单')
      const oldTargets = this.memberTargets(before, false), nextTargets = this.memberTargets(after, true)
      for (const [key, t] of oldTargets) if (!nextTargets.has(key) && this.value(key)?.state === 'favorite') this.write(t, 'none', now, 'playlist_unfavorite')
      for (const [key, t] of nextTargets) if (!oldTargets.has(key) && this.value(key)?.state !== 'favorite') this.write(t, 'favorite', now, 'playlist_favorite')
      this.sql.prepare('UPDATE personal_preference_playlists SET payload=?,revision=revision+1,saved_at=? WHERE id=1').run(JSON.stringify(data), new Date(now).toISOString())
      const result = this.playlistsLoad()!
      assertDocumentCapacity(result.data, result.revision, result.savedAt)
      return result
    })
  }
  playlistsRestore(data: Playlist[], restoreId: string, expectedRevision: number, now: number): VersionedDataEnvelope<Playlist[]> {
    if (typeof restoreId !== 'string' || !restoreId || restoreId.length > 128 || restoreId.includes('\0')) throw new Error('无效的歌单恢复标记')
    if (!validPlaylists(data) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error('无效的歌单恢复数据')
    assertDocumentCapacity(data, expectedRevision + 1, new Date(now).toISOString())
    return this.transaction(() => {
      if (this.sql.prepare('SELECT 1 FROM personal_preference_restores WHERE id=?').get(restoreId)) return this.playlistsLoad()!
      const current = this.playlistsLoad()
      if (current && current.revision !== expectedRevision) throw new PersistentDataRevisionConflictError(current, expectedRevision)
      let value: VersionedDataEnvelope<Playlist[]>
      if (!current) value = this.playlistsMigrate({ version: 2, revision: expectedRevision + 1, savedAt: new Date(now).toISOString(), data }, now)
      else {
        const prepared = structuredClone(data), oldId = String(this.sql.prepare('SELECT default_id FROM personal_preference_playlists WHERE id=1').get()!.default_id)
        const oldDefault = current.data.find(p => p.id === oldId)!
        let incoming = this.defaultPlaylist(prepared)
        if (!incoming) { incoming = this.newDefault(prepared, now); prepared.unshift(incoming) }
        incoming.isDefault = true
        const oldTargets = this.memberTargets(oldDefault, false), nextTargets = this.memberTargets(incoming, true)
        for (const [key, t] of oldTargets) if (!nextTargets.has(key) && this.value(key)?.state === 'favorite') this.write(t, 'none', now, 'playlist_unfavorite')
        for (const [key, t] of nextTargets) if (!oldTargets.has(key) && this.value(key)?.state !== 'favorite') this.write(t, 'favorite', now, 'playlist_favorite')
        this.sql.prepare('UPDATE personal_preference_playlists SET payload=?,default_id=?,revision=revision+1,saved_at=? WHERE id=1')
          .run(JSON.stringify(prepared), incoming.id, new Date(now).toISOString())
        value = this.playlistsLoad()!
      }
      assertDocumentCapacity(value.data, value.revision, value.savedAt)
      this.sql.prepare('INSERT INTO personal_preference_restores VALUES(?,?)').run(restoreId, value.revision)
      return value
    })
  }
  trackStates(tracks: TrackData[]): Array<MusicPreferenceState | null> {
    if (!Array.isArray(tracks) || tracks.length > 200) throw new Error('收藏偏好检查每批最多200首')
    return this.read(() => tracks.map(track => {
      const source = this.source(track)
      return source ? this.value(this.target(String(source.recording_id)).key)?.state ?? null : null
    }))
  }
  /** Precise matches only. No catalog writes, artist-name inference, album-project or credits cascade. */
  automaticEligibility(tracks: TrackData[]): boolean[] {
    if (!Array.isArray(tracks) || tracks.length > 200) throw new Error('自动选曲偏好检查每批最多200首')
    return this.read(() => tracks.map(track => {
      const provider = getTrackSource(track), source = this.source(track), targets = new Set<string>()
      const addEntity = (id: unknown, kind: MusicPreferenceKind) => { if (id) { const t = this.target(String(id), true); if (t.kind === kind) targets.add(t.key) } }
      const addNative = (kind: MusicPreferenceKind, native: unknown) => {
        if (native === undefined || native === null || String(native) === '' || provider === 'local') return
        const key = kind === 'release' ? JSON.stringify(['album', provider, `id:${String(native).trim()}`]) : JSON.stringify([provider, String(native)])
        const alias = this.sql.prepare('SELECT entity_id FROM catalog_aliases WHERE namespace=? AND key=?').get(`source.${kind}`, key)
        if (alias) {
          const t = this.target(String(alias.entity_id), true)
          if (kind !== 'artist' || t.scope === 'identity') targets.add(t.key)
          return // The source's current link (including detach/replace) outranks historical references.
        }
        const ref = this.sql.prepare(`SELECT r.target_id FROM metadata_identity_refs r
          WHERE r.provider=? AND r.kind=? AND r.id_type='native' AND r.value=? AND EXISTS(
            SELECT 1 FROM metadata_identity_links l WHERE l.target_id=r.target_id AND l.kind=r.kind AND l.state='confirmed')`).get(provider, kind, String(native))
        if (ref) targets.add(targetKey('identity', kind, String(ref.target_id)))
      }
      addEntity(source?.recording_id, 'recording'); addEntity(source?.release_id, 'release')
      const nativeId = provider === 'ncm' ? track.ncmSongId ?? (track.id.startsWith('ncm:') ? track.id.slice(4) : track.id)
        : track.id.startsWith(provider + ':') ? track.id.slice(provider.length + 1) : track.id
      if (!source) { addNative('recording', nativeId); addNative('release', track.albumId) }
      // Track.artists is the provider/file's explicit main-artist list, not metadata credits.
      if (!source) for (const artist of track.artists ?? []) addNative('artist', artist.id)
      if (source) {
        for (const artist of this.sql.prepare(`SELECT a.artist_id FROM catalog_source_artists a
          JOIN metadata_identity_links l ON l.entity_id=a.artist_id AND l.kind='artist' AND l.state='confirmed' WHERE a.source_id=?`).all(String(source.id))) addEntity(artist.artist_id, 'artist')
      }
      return ![...targets].some(key => this.value(key)?.state === 'ban')
    }))
  }
}
