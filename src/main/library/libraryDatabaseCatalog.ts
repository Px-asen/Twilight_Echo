import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  CatalogDetail,
  CatalogEntity,
  CatalogKind,
  CatalogPage,
  CatalogQuery,
  CatalogSourcePage,
  CatalogSourceQuery,
  CatalogStatus,
  CatalogSync,
  CatalogSyncResult
} from '../../shared/musicCatalog.ts'
import { validCatalogPayload, CATALOG_MAX_BATCH_BYTES } from '../../shared/musicCatalog.ts'
import { parseMusicVersions, type MusicVersionsDocument } from '../../shared/musicVersions.ts'
import { getTrackSource, versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { getAlbumIdentity } from '../../shared/libraryIdentity.ts'
import type { TrackArtistRef, TrackData } from '../../shared/track.ts'
import { projectCoreTrack } from '../../core/projections.ts'
import { normalizeCueRange } from '../../shared/cue.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import { fileArtistCredits, normalizeTrackIdentityTags } from '../../shared/trackIdentification.ts'
import { libraryArtistCredits } from '../../shared/libraryCollections.ts'
import { catalogArtistAlias } from './catalogArtistAlias.ts'

/** First actual catalog membership publication, not Track.addedAt or cached-source time. */
export const CATALOG_MEMBERSHIP_ADDED_PREFIX = 'membership_added:'

/** Created in the same schema transaction as user_version. Backfill is deliberately not DDL. */
export const CATALOG_SCHEMA_SQL = `
CREATE TABLE catalog_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO catalog_state VALUES('revision','0'),('local_cursor','0'),
  ('local_horizon',CAST((SELECT coalesce(max(seq),0) FROM tracks) AS TEXT));
CREATE TABLE catalog_entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,
  artist TEXT NOT NULL,identity TEXT NOT NULL CHECK(identity IN ('source','manual')));
CREATE TABLE catalog_aliases(namespace TEXT NOT NULL,key TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),PRIMARY KEY(namespace,key));
CREATE TABLE catalog_sources(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,
  track_id TEXT NOT NULL,recording_id TEXT NOT NULL REFERENCES catalog_entities(id),
  release_id TEXT REFERENCES catalog_entities(id),album_key TEXT,payload TEXT NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('indexed','unknown','missing')));
CREATE INDEX catalog_source_track ON catalog_sources(provider,track_id);
CREATE INDEX catalog_source_recording ON catalog_sources(recording_id);
CREATE INDEX catalog_source_release ON catalog_sources(release_id);
CREATE TABLE catalog_source_artists(source_id TEXT NOT NULL REFERENCES catalog_sources(id),
  artist_id TEXT NOT NULL REFERENCES catalog_entities(id),PRIMARY KEY(source_id,artist_id));
CREATE INDEX catalog_artist_sources ON catalog_source_artists(artist_id,source_id);
CREATE TABLE catalog_memberships(owner TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES catalog_sources(id),
  PRIMARY KEY(owner,source_id));
CREATE INDEX catalog_membership_sources ON catalog_memberships(source_id);
CREATE TABLE catalog_facts(source_id TEXT NOT NULL REFERENCES catalog_sources(id),
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),field TEXT NOT NULL,value TEXT NOT NULL,
  origin TEXT NOT NULL,PRIMARY KEY(source_id,entity_id,field));
CREATE INDEX catalog_entity_facts ON catalog_facts(entity_id,source_id);
CREATE TABLE catalog_pending(track_id TEXT PRIMARY KEY);
CREATE TRIGGER catalog_tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO catalog_pending SELECT new.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=new.id); END;
CREATE TRIGGER catalog_tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO catalog_pending SELECT old.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=old.id);
  INSERT INTO catalog_pending SELECT new.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=new.id); END;
CREATE TRIGGER catalog_tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO catalog_pending SELECT old.id WHERE NOT EXISTS(SELECT 1 FROM catalog_pending WHERE track_id=old.id); END;
CREATE TABLE catalog_imports(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,sequence INTEGER NOT NULL);
CREATE TABLE catalog_import_members(import_id TEXT NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES catalog_sources(id),PRIMARY KEY(import_id,source_id));
CREATE TABLE catalog_versions(scope TEXT NOT NULL,id TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES catalog_entities(id),label TEXT NOT NULL,
  preferred_source TEXT,family_id TEXT,preferred_version TEXT,PRIMARY KEY(scope,id));
CREATE TABLE catalog_version_sources(scope TEXT NOT NULL,source_key TEXT NOT NULL,version_id TEXT NOT NULL,
  PRIMARY KEY(scope,source_key),FOREIGN KEY(scope,version_id) REFERENCES catalog_versions(scope,id) ON DELETE CASCADE);
CREATE VIEW catalog_bindings AS SELECT s.*,
  coalesce(tv.entity_id,s.recording_id) AS recording,
  coalesce(av.entity_id,s.release_id) AS release,
  CASE WHEN tv.preferred_source=s.source_key THEN 1 ELSE 0 END AS preferred_recording,
  CASE WHEN av.preferred_source=s.album_key THEN 1 ELSE 0 END AS preferred_release
  FROM catalog_sources s
  LEFT JOIN catalog_version_sources ts ON ts.scope='tracks' AND ts.source_key=s.source_key
  LEFT JOIN catalog_versions tv ON tv.scope=ts.scope AND tv.id=ts.version_id
  LEFT JOIN catalog_version_sources als ON als.scope='albums' AND als.source_key=s.album_key
  LEFT JOIN catalog_versions av ON av.scope=als.scope AND av.id=als.version_id;
CREATE VIEW catalog_entity_sources AS
  SELECT recording AS entity_id,id AS source_id FROM catalog_bindings
  UNION ALL SELECT release,id FROM catalog_bindings WHERE release IS NOT NULL
  UNION ALL SELECT artist_id,source_id FROM catalog_source_artists;
`

/** A source album project is a new layer, not a relabelled release/version. */
export const CATALOG_PROJECT_SCHEMA_SQL = `
CREATE TABLE catalog_release_projects(release_id TEXT PRIMARY KEY REFERENCES catalog_entities(id),
  project_id TEXT NOT NULL UNIQUE REFERENCES catalog_entities(id));
CREATE INDEX catalog_entities_kind ON catalog_entities(kind,id);
INSERT INTO catalog_state VALUES('project_cursor','0'),
  ('project_horizon',CAST((SELECT coalesce(max(rowid),0) FROM catalog_entities) AS TEXT));
DROP VIEW catalog_entity_sources;
CREATE VIEW catalog_entity_sources AS
  SELECT recording AS entity_id,id AS source_id FROM catalog_bindings
  UNION ALL SELECT release,id FROM catalog_bindings WHERE release IS NOT NULL
  UNION ALL SELECT artist_id,source_id FROM catalog_source_artists
  UNION ALL SELECT p.project_id,s.id FROM catalog_bindings s
    JOIN catalog_release_projects p ON p.release_id=s.release;
`

type Row = Record<string, string | number | null>
type Owner = { sql: DatabaseSync; transaction<T>(action: () => T): T;
  collectionSelection(collection: 'artists' | 'albums', id: string): { sql: string; params: SQLInputValue[] }
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const stale = () =>
  Object.assign(new Error('音乐资料已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Stores source identity, never guesses recording equality from names. All writes are bounded. */
export class LibraryDatabaseCatalog {
  private readonly owner: Owner
  private readonly totalCache = new Map<string, number>()
  private readonly queryCache = new Map<string, CatalogPage>()
  constructor(owner: Owner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }
  private state(key: string): string | null {
    return (
      ((this.sql.prepare('SELECT value FROM catalog_state WHERE key=?').get(key) as Row | undefined)
        ?.value as string) ?? null
    )
  }
  private set(key: string, value: string | number) {
    this.sql
      .prepare(
        'INSERT INTO catalog_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, String(value))
  }
  private bump() {
    this.set('revision', Number(this.state('revision')) + 1)
  }
  private fence(revision?: number) {
    if (revision !== undefined && revision !== Number(this.state('revision'))) throw stale()
  }
  /** Existing members without historical evidence remain unknown, including after re-add. */
  private preserveMembershipHistory(owner: 'local' | 'playlists', trackId?: string) {
    if (owner === 'local' && trackId !== undefined) {
      // Local maintenance publishes one exact Track at a time. Start with its
      // indexed source pair, not all prior local members for every new file.
      this.sql.prepare(`INSERT OR IGNORE INTO catalog_state(key,value)
        SELECT ?||s.id,'unknown' FROM catalog_sources s CROSS JOIN catalog_memberships m
        ON m.source_id=s.id AND m.owner='local' WHERE s.provider='local' AND s.track_id=?`)
        .run(CATALOG_MEMBERSHIP_ADDED_PREFIX, trackId)
      return
    }
    this.sql.prepare(`INSERT OR IGNORE INTO catalog_state(key,value)
      SELECT ?||m.source_id,'unknown' FROM catalog_memberships m
      JOIN catalog_sources s ON s.id=m.source_id
      WHERE m.owner=? AND (? IS NULL OR s.track_id=?)`)
      .run(CATALOG_MEMBERSHIP_ADDED_PREFIX, owner, trackId ?? null, trackId ?? null)
  }
  private rememberMembership(sourceId: string) {
    this.sql.prepare(`INSERT OR IGNORE INTO catalog_state(key,value)
      VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM catalog_memberships WHERE source_id=?)
        THEN 'unknown' ELSE ? END)`)
      .run(CATALOG_MEMBERSHIP_ADDED_PREFIX + sourceId, sourceId, String(Date.now()))
  }
  /** A portable music-only restore retains personal source references, not playable sources.
   * Attach them only when the ordinary catalog ingests that exact real source again. */
  private reattachPortablePersonalSource(sourceId: string, sourceKey: string) {
    const retained = (key: string): Record<string, string | number | null> | null => {
      const row = this.sql.prepare('SELECT value FROM meta WHERE key=?').get(key)
      if (!row) return null
      const value = JSON.parse(String(row.value))
      return value as Record<string, string | number | null>
    }
    const restored = retained('music_backup_offline_source:' + sourceKey)
    if (restored && restored.id !== sourceId) {
      this.sql.prepare(`INSERT OR IGNORE INTO music_genre_overrides(target_kind,target_id,genre_ids)
        SELECT target_kind,?,genre_ids FROM music_genre_overrides WHERE target_kind='source' AND target_id=?`).run(sourceId, restored.id)
      this.sql.prepare(`INSERT OR IGNORE INTO music_genre_import_overrides(target_kind,target_id,import_key,genre_ids)
        SELECT target_kind,?,import_key,genre_ids FROM music_genre_import_overrides WHERE target_kind='source' AND target_id=?`).run(sourceId, restored.id)
      this.sql.prepare("DELETE FROM music_genre_overrides WHERE target_kind='source' AND target_id=?").run(restored.id)
      this.sql.prepare("DELETE FROM music_genre_import_overrides WHERE target_kind='source' AND target_id=?").run(restored.id)
    }
    const history = retained('music_backup_offline_membership:' + sourceKey)
    if (history) this.sql.prepare('INSERT OR IGNORE INTO catalog_state VALUES(?,?)').run(CATALOG_MEMBERSHIP_ADDED_PREFIX + sourceId, String(history.added_at))
    const favorite = this.sql.prepare('SELECT value FROM meta WHERE key=?').get('music_backup_offline_favorites:' + sourceKey)
    if (favorite) {
      const placeholders = JSON.parse(JSON.parse(String(favorite.value))) as Array<{ id: string }>, row = this.sql.prepare('SELECT payload,default_id FROM personal_preference_playlists WHERE id=1').get()
      const source = this.sql.prepare(`SELECT s.track_id,s.provider,s.payload,t.payload AS local_payload
        FROM catalog_sources s LEFT JOIN tracks t ON s.provider='local' AND t.id=s.track_id WHERE s.id=?`).get(sourceId)
      if (row && source) {
        const lists = JSON.parse(String(row.payload)) as Array<{ id: string; trackIds: string[]; trackSnapshots?: Record<string, unknown> }>, view = lists.find(list => list.id === row.default_id)
        if (view && placeholders.some(p => view.trackIds.includes(p.id))) {
          const ids = new Set(placeholders.map(p => p.id)), snapshots = { ...view.trackSnapshots }
          const track = source.provider === 'local' && source.local_payload
            ? libraryTrack(JSON.parse(String(source.local_payload))) : JSON.parse(String(source.payload)) as TrackData
          const existing = snapshots[String(source.track_id)] as TrackData | undefined
          // A Track ID from another provider cannot replace this exact source's
          // retained occurrence or overwrite the other source's saved snapshot.
          if (existing && versionSourceKey(existing) !== sourceKey) return
          view.trackIds = view.trackIds.map(id => ids.has(id) ? String(source.track_id) : id)
          for (const id of ids) delete snapshots[id]
          snapshots[String(source.track_id)] = track; view.trackSnapshots = snapshots
          this.sql.prepare('UPDATE personal_preference_playlists SET payload=? WHERE id=1').run(JSON.stringify(lists))
          // Publish through the existing preference event boundary. Its trigger
          // advances the playlist revision in this same catalog transaction.
          this.sql.prepare("UPDATE personal_preferences_state SET revision=revision+1 WHERE profile_id='default'").run()
        }
      }
    }
  }
  status(): CatalogStatus {
    const cursor = Number(this.state('local_cursor')),
      horizon = Number(this.state('local_horizon'))
    const dirty = Number(
      (this.sql.prepare('SELECT count(*) AS n FROM catalog_pending').get() as Row).n
    )
    const playlists = this.state('playlists_revision'),
      versions = this.state('versions_revision')
    return {
      revision: Number(this.state('revision')),
      localCursor: cursor,
      localHorizon: horizon,
      localPending:
        cursor < horizon || dirty > 0 ||
        Number(this.state('file_artist_cursor_v3')) < Number(this.state('file_artist_horizon_v3')) ||
        Number(this.state('project_cursor')) < Number(this.state('project_horizon')),
      dirtySources: dirty,
      playlistsRevision: playlists === null ? null : Number(playlists),
      versionsRevision: versions === null ? null : Number(versions)
    }
  }
  advance(limit = 200): CatalogStatus {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid catalog batch size')
    return this.owner.transaction(() => {
      const cursor = Number(this.state('local_cursor')),
        horizon = Number(this.state('local_horizon'))
      let processed = 0
      if (cursor < horizon) {
        const rows = this.sql
          .prepare('SELECT seq,payload FROM tracks WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?')
          .all(cursor, horizon, limit) as Row[]
        for (const row of rows) {
          const raw = JSON.parse(str(row.payload))
          const track = libraryTrack(raw)
          this.upsert(track, 'local', raw)
          this.sql.prepare('DELETE FROM catalog_pending WHERE track_id=?').run(track.id)
        }
        this.set('local_cursor', rows.length === limit ? Number(rows.at(-1)!.seq) : horizon)
        processed += rows.length
      }
      const pending = this.sql
        .prepare('SELECT track_id FROM catalog_pending ORDER BY track_id LIMIT ?')
        .all(limit - processed) as Row[]
      for (const item of pending) {
        const row = this.sql.prepare('SELECT payload FROM tracks WHERE id=?').get(item.track_id) as
          | Row
          | undefined
        if (row) {
          const raw = JSON.parse(str(row.payload))
          this.upsert(libraryTrack(raw), 'local', raw)
        } else {
          this.preserveMembershipHistory('local', str(item.track_id))
          this.sql
            .prepare(
              "DELETE FROM catalog_memberships WHERE owner='local' AND source_id IN (SELECT id FROM catalog_sources WHERE provider='local' AND track_id=?)"
            )
            .run(item.track_id)
          this.sql
            .prepare(
              "UPDATE catalog_sources SET availability='missing' WHERE provider='local' AND track_id=?"
            )
            .run(item.track_id)
        }
        this.sql.prepare('DELETE FROM catalog_pending WHERE track_id=?').run(item.track_id)
      }
      const projectCursor = Number(this.state('project_cursor')),
        projectHorizon = Number(this.state('project_horizon'))
      let remaining = limit - processed - pending.length
      const creditCursor = Number(this.state('file_artist_cursor_v3')),
        creditHorizon = Number(this.state('file_artist_horizon_v3'))
      let creditsVisited = 0
      if (creditCursor < creditHorizon && remaining > 0) {
        const rows = this.sql.prepare('SELECT seq,payload FROM tracks WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?')
          .all(creditCursor, creditHorizon, remaining) as Row[]
        for (const row of rows) {
          const raw = JSON.parse(str(row.payload))
          const credits = libraryArtistCredits(raw)
          const previous = raw.artists?.length ? raw.artists : [{ name: str(raw.artist) }]
          const missingFileCredits = !raw.artists?.length && fileArtistCredits(raw.identityTags).length > 0
          const changed = credits.length !== previous.length ||
            credits.some((credit, index) => credit.name.trim() !== str(previous[index]?.name).trim())
          if (credits.length && (missingFileCredits || changed))
            this.upsert(libraryTrack(raw), 'local', raw)
        }
        this.set('file_artist_cursor_v3', rows.length === remaining ? Number(rows.at(-1)!.seq) : creditHorizon)
        creditsVisited = rows.length
        remaining -= rows.length
      }
      if (projectCursor < projectHorizon && remaining > 0) {
        const rows = this.sql
          .prepare("SELECT rowid AS seq,id FROM catalog_entities WHERE rowid>? AND rowid<=? AND kind='release' ORDER BY rowid LIMIT ?")
          .all(projectCursor, projectHorizon, remaining) as Row[]
        for (const row of rows) this.project(str(row.id))
        this.set('project_cursor', rows.length === remaining ? Number(rows.at(-1)!.seq) : projectHorizon)
      }
      if (processed || pending.length || creditsVisited || cursor < horizon || projectCursor < projectHorizon) this.bump()
      return this.status()
    })
  }
  private entity(
    namespace: string,
    key: string,
    kind: CatalogKind,
    title: string,
    artist = '',
    identity: 'source' | 'manual' = 'source'
  ): string {
    const found = this.sql
      .prepare('SELECT entity_id FROM catalog_aliases WHERE namespace=? AND key=?')
      .get(namespace, key) as Row | undefined
    const id = found ? str(found.entity_id) : `music_${randomUUID()}`
    if (!found) {
      this.sql
        .prepare('INSERT INTO catalog_entities VALUES(?,?,?,?,?)')
        .run(id, kind, title, artist, identity)
      this.sql.prepare('INSERT INTO catalog_aliases VALUES(?,?,?)').run(namespace, key, id)
    } else
      this.sql
        .prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id=?')
        .run(title, artist, id)
    return id
  }
  private project(releaseId: string): string {
    const release = this.sql
      .prepare('SELECT title,artist,identity FROM catalog_entities WHERE id=?')
      .get(releaseId) as Row
    const found = this.sql
      .prepare('SELECT project_id FROM catalog_release_projects WHERE release_id=?')
      .get(releaseId) as Row | undefined
    const id = found ? str(found.project_id) : `music_${randomUUID()}`
    if (!found) {
      this.sql.prepare("INSERT INTO catalog_entities VALUES(?,'album_project',?,?,?)")
        .run(id, release.title, release.artist, release.identity)
      this.sql.prepare('INSERT INTO catalog_release_projects VALUES(?,?)').run(releaseId, id)
    } else this.sql.prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id=?')
      .run(release.title, release.artist, id)
    return id
  }
  /** Personal data may retain a precise source without making it a library member. */
  retainPersonalSource(track: TrackData): string {
    const existing = this.sql.prepare('SELECT id FROM catalog_sources WHERE source_key=?').get(versionSourceKey(track))
    if (existing) return String(existing.id)
    const id = this.upsert(track)
    this.bump()
    return id
  }
  private upsert(input: TrackData, owner?: 'local', raw: Partial<TrackData> = input): string {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 8192 ||
      (input.source !== undefined &&
        (typeof input.source !== 'string' || input.source.length > 128)) ||
      (input.filePath !== undefined && typeof input.filePath !== 'string')
    )
      throw new Error('Invalid catalog source')
    const provider = getTrackSource(input)
    if (
      !input.id ||
      !provider ||
      ['network', 'radio', 'podcast'].includes(provider) ||
      (owner === 'local' && provider !== 'local') ||
      (provider === 'local' && !input.filePath)
    )
      throw new Error('Unsupported catalog music source')
    const key = versionSourceKey(input)
    if (key.length > 16384) throw new Error('Catalog source identity too long')
    const previous = this.sql
      .prepare('SELECT * FROM catalog_sources WHERE source_key=?')
      .get(key) as Row | undefined
    const id = previous ? str(previous.id) : `source_${randomUUID()}`
    const recording = this.entity(
      'source.recording',
      key,
      'recording',
      str(input.title),
      str(input.artist)
    )
    const albumIdentity = getAlbumIdentity(input)
    const albumKey = JSON.stringify(['album', provider, albumIdentity])
    // A provider's title alone is not a release ID. Keep the legacy album key
    // for explicit version mappings, but do not automatically group these items.
    const releaseKey =
      provider !== 'local' && !str(input.albumId).trim()
        ? JSON.stringify([provider, 'track', key])
        : albumKey
    let release: string | null = null
    if (str(raw.album).trim()) {
      // A tag-only rename retains its source's existing album identity. Explicit
      // provider/album IDs use the new declared identity instead.
      const alias = this.sql
        .prepare("SELECT entity_id FROM catalog_aliases WHERE namespace='source.release' AND key=?")
        .get(releaseKey) as Row | undefined
      if (!alias && previous?.release_id && !input.albumId) {
        release = str(previous.release_id)
        this.sql
          .prepare("INSERT INTO catalog_aliases VALUES('source.release',?,?)")
          .run(releaseKey, release)
        this.sql
          .prepare('UPDATE catalog_entities SET title=?,artist=? WHERE id=?')
          .run(input.album, input.albumArtist || input.artist || '', release)
      } else
        release = this.entity(
          'source.release',
          releaseKey,
          'release',
          input.album,
          input.albumArtist || input.artist || ''
        )
    }
    if (release) this.project(release)
    const track = snapshot(input, provider, libraryArtistCredits(raw))
    if (owner) {
      // A changed selector/path is a different source. Retain its offline record,
      // but do not keep it as a live library member under the same Track ID.
      this.preserveMembershipHistory(owner, input.id)
      this.sql
        .prepare(
          `DELETE FROM catalog_memberships WHERE owner='local' AND source_id IN
        (SELECT id FROM catalog_sources WHERE provider='local' AND track_id=? AND source_key<>?)`
        )
        .run(input.id, key)
      this.sql
        .prepare(
          "UPDATE catalog_sources SET availability='missing' WHERE provider='local' AND track_id=? AND source_key<>?"
        )
        .run(input.id, key)
    }
    const availability = provider === 'local' ? 'indexed' : 'unknown'
    if (previous) {
      // An UPSERT DO UPDATE's conflict policy also governs writes in triggers.
      // Use the known source branch so a queued genre invalidation stays idempotent.
      this.sql.prepare(`UPDATE catalog_sources SET track_id=?,release_id=?,album_key=?,
        payload=?,availability=? WHERE source_key=?`)
        .run(input.id, release, release ? albumKey : null, JSON.stringify(track), availability, key)
    } else {
      this.sql.prepare('INSERT INTO catalog_sources VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, key, provider, input.id, recording, release, release ? albumKey : null,
          JSON.stringify(track), availability)
    }
    this.reattachPortablePersonalSource(id, key)
    this.sql.prepare('DELETE FROM catalog_facts WHERE source_id=?').run(id)
    const fact = (entityId: string, field: string, value: string) =>
      this.sql
        .prepare('INSERT OR REPLACE INTO catalog_facts VALUES(?,?,?,?,?)')
        .run(id, entityId, field, value, provider === 'local' ? 'file' : 'provider')
    if (str(raw.title).trim()) fact(recording, 'title', str(raw.title))
    if (str(raw.artist).trim()) fact(recording, 'artist', str(raw.artist))
    if (release) fact(release, 'album', input.album)
    const artists = track.artists ?? []
    const performerIds: string[] = []
    for (const [index, artist] of artists.entries()) {
      if (!str(artist.name).trim()) continue
      // A compilation's first credit need not be the same person on every track.
      // Without provider IDs, keep source-scoped credits until identification.
      const alias = catalogArtistAlias(this.sql, provider, recording, index, artist)
      if (alias.entityId) this.sql.prepare("INSERT OR IGNORE INTO catalog_aliases VALUES('source.artist',?,?)")
        .run(alias.key, alias.entityId)
      const performer = this.entity('source.artist', alias.key, 'artist', artist.name)
      performerIds.push(performer)
      this.sql
        .prepare('INSERT OR IGNORE INTO catalog_source_artists VALUES(?,?)')
        .run(id, performer)
      fact(performer, 'artist', artist.name)
    }
    this.sql.prepare(`DELETE FROM catalog_source_artists WHERE source_id=?
      AND artist_id NOT IN (SELECT value FROM json_each(?))`).run(id, JSON.stringify(performerIds))
    if (owner) {
      this.rememberMembership(id)
      this.sql.prepare('INSERT OR IGNORE INTO catalog_memberships VALUES(?,?)').run(owner, id)
    }
    return id
  }
  sync(request: CatalogSync): CatalogSyncResult {
    if (!request || !['begin', 'append', 'commit', 'abort'].includes(request.kind))
      throw new Error('Invalid catalog import')
    if (request.kind !== 'begin' && (typeof request.id !== 'string' || request.id.length > 128))
      throw new Error('Invalid catalog import ID')
    return this.owner.transaction(() => {
      if (request.kind === 'begin') {
        if (!Number.isSafeInteger(request.revision) || request.revision < 0)
          throw new Error('Invalid playlist catalog revision')
        this.sql.exec('DELETE FROM catalog_imports')
        const id = randomUUID()
        this.sql.prepare('INSERT INTO catalog_imports VALUES(?,?,0)').run(id, request.revision)
        return { id, sequence: 0 }
      }
      const job = this.sql.prepare('SELECT * FROM catalog_imports WHERE id=?').get(request.id) as
        | Row
        | undefined
      if (request.kind === 'abort') {
        this.sql.prepare('DELETE FROM catalog_imports WHERE id=?').run(request.id)
        return { id: request.id, sequence: Number(job?.sequence ?? 0) }
      }
      if (!job || request.sequence !== Number(job.sequence)) throw stale()
      if (request.kind === 'append') {
        if (!Array.isArray(request.tracks) || request.tracks.length > 200)
          throw new Error('Catalog source page exceeds 200')
        if (Buffer.byteLength(JSON.stringify(request.tracks), 'utf8') > CATALOG_MAX_BATCH_BYTES)
          throw new Error('Catalog source page exceeds 1 MiB')
        for (const track of request.tracks) {
          if (getTrackSource(track) === 'local') continue
          const source = this.upsert(track)
          this.sql
            .prepare('INSERT OR IGNORE INTO catalog_import_members VALUES(?,?)')
            .run(request.id, source)
        }
        this.sql
          .prepare('UPDATE catalog_imports SET sequence=sequence+1 WHERE id=?')
          .run(request.id)
        // Existing sources may have received new metadata, even before this
        // membership generation is published. Fence readers of those changes.
        if (request.tracks.length) this.bump()
        return { id: request.id, sequence: request.sequence + 1 }
      }
      this.preserveMembershipHistory('playlists')
      // Only this publication makes staged platform sources library members. An
      // aborted append never records a time, and re-projection never changes it.
      this.sql.prepare(`INSERT OR IGNORE INTO catalog_state(key,value)
        SELECT ?||i.source_id,CASE WHEN EXISTS(SELECT 1 FROM catalog_memberships m
          WHERE m.source_id=i.source_id) THEN 'unknown' ELSE ? END
        FROM catalog_import_members i WHERE i.import_id=?`)
        .run(CATALOG_MEMBERSHIP_ADDED_PREFIX, String(Date.now()), request.id)
      this.sql.prepare("DELETE FROM catalog_memberships WHERE owner='playlists'").run()
      this.sql
        .prepare(
          "INSERT INTO catalog_memberships SELECT 'playlists',source_id FROM catalog_import_members WHERE import_id=?"
        )
        .run(request.id)
      this.set('playlists_revision', Number(job.revision))
      this.sql.prepare('DELETE FROM catalog_imports WHERE id=?').run(request.id)
      this.bump()
      return { id: request.id, sequence: request.sequence }
    })
  }
  projectVersions(document: MusicVersionsDocument, revision: number): void {
    const parsed = parseMusicVersions(JSON.stringify(document))
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid version revision')
    this.owner.transaction(() => {
      const bindings = () => new Map((this.sql.prepare(`SELECT s.scope,s.source_key,v.entity_id
        FROM catalog_version_sources s JOIN catalog_versions v ON v.scope=s.scope AND v.id=s.version_id`)
        .all() as Row[]).map((row) => [JSON.stringify([row.scope, row.source_key]), str(row.entity_id)]))
      const before = bindings()
      this.sql.exec('DELETE FROM catalog_version_sources; DELETE FROM catalog_versions;')
      for (const scope of ['tracks', 'albums'] as const) {
        const families = new Map(
          parsed[scope].families.flatMap((f) => f.versions.map((id) => [id, f] as const))
        )
        for (const version of parsed[scope].versions) {
          const kind = scope === 'tracks' ? 'recording' : 'release'
          const id = this.entity(
            'manual.version',
            JSON.stringify([scope, version.id]),
            kind,
            version.label,
            '',
            'manual'
          )
          const family = families.get(version.id)
          if (kind === 'release') this.project(id)
          this.sql
            .prepare('INSERT INTO catalog_versions VALUES(?,?,?,?,?,?,?)')
            .run(
              scope,
              version.id,
              id,
              version.label,
              version.preferredSource,
              family?.id ?? null,
              family?.preferredVersion ?? null
            )
          for (const source of version.sources)
            this.sql
              .prepare('INSERT INTO catalog_version_sources VALUES(?,?,?)')
              .run(scope, source, version.id)
        }
      }
      const after = bindings()
      const touched = new Set<string>()
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(key) === after.get(key)) continue
        if (before.has(key)) touched.add(before.get(key)!)
        if (after.has(key)) touched.add(after.get(key)!)
        const [scope, sourceKey] = JSON.parse(key) as string[]
        const column = scope === 'tracks' ? 'source_key' : 'album_key'
        const rows = this.sql.prepare(`SELECT recording_id,release_id FROM catalog_sources WHERE ${column}=?`)
          .all(sourceKey) as Row[]
        for (const row of rows) {
          const id = scope === 'tracks' ? row.recording_id : row.release_id
          if (id) touched.add(str(id))
        }
      }
      const touch = this.sql.prepare(`INSERT INTO metadata_identification_inputs VALUES(?,1)
        ON CONFLICT(entity_id) DO UPDATE SET revision=revision+1`)
      for (const id of touched) {
        touch.run(id)
        const project = this.sql.prepare('SELECT project_id FROM catalog_release_projects WHERE release_id=?')
          .get(id) as Row | undefined
        if (project) touch.run(project.project_id)
      }
      this.set('versions_revision', revision)
      this.bump()
    })
  }
  query(query: CatalogQuery): CatalogPage {
    if (!validCatalogPayload('catalog.query', query)) throw new Error('Invalid catalog query')
    this.fence(query.revision)
    const params: SQLInputValue[] = []
    const conditions = ['1=1']
    const artist = query.kind === 'artist'
    const recording = query.kind === 'recording'
    const scope = recording ? 'tracks' : 'albums'
    const sourceKey = recording ? 'source_key' : 'album_key'
    const effective = `coalesce(v.entity_id,s.${recording ? 'recording_id' : 'release_id'})`
    const entity = artist ? 'a.artist_id' : query.kind === 'album_project' ? 'p.project_id' : effective
    // Read each source once and resolve only the binding layer this kind uses.
    // catalog_bindings plus another source join repeats the source lookup and
    // resolves both track and album versions even when only one is consumed.
    const relation = artist
      ? 'catalog_sources s JOIN catalog_source_artists a ON a.source_id=s.id'
      : `catalog_sources s
        LEFT JOIN catalog_version_sources b ON b.scope='${scope}' AND b.source_key=s.${sourceKey}
        LEFT JOIN catalog_versions v ON v.scope=b.scope AND v.id=b.version_id
        ${query.kind === 'album_project' ? `JOIN catalog_release_projects p ON p.release_id=${effective}` : ''}`
    if (query.kind === 'release') conditions.push(`${effective} IS NOT NULL`)
    if (query.scope !== 'all')
      conditions.push('EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)')
    if (query.source) {
      conditions.push('s.provider=?')
      params.push(query.source)
    }
    const context = query.context
    if (context) {
      conditions.push("s.availability<>'missing'", `s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
        AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id))`)
      if (context.type === 'track') {
        conditions.push('s.provider=? AND s.track_id=?')
        params.push(context.provider, context.id)
      } else if (context.type === 'collection') {
        const selection = this.owner.collectionSelection(context.collection, context.id)
        conditions.push(`s.provider='local' AND s.track_id IN (SELECT id FROM tracks ${selection.sql})`)
        params.push(...selection.params)
      } else if (query.kind === 'artist') {
        conditions.push("a.artist_id IN (SELECT entity_id FROM catalog_aliases WHERE namespace='source.artist' AND key=?)")
        params.push(JSON.stringify([context.provider, context.id]))
      } else {
        conditions.push("s.release_id IN (SELECT entity_id FROM catalog_aliases WHERE namespace='source.release' AND key=?)")
        params.push(JSON.stringify(['album', context.provider, `id:${context.id}`]))
      }
    }
    const cte = `WITH candidates AS (SELECT ${entity} entity_id,count(*) AS source_count
      FROM ${relation}
      WHERE ${conditions.map(c => `(${c})`).join(' AND ')} GROUP BY ${entity})`
    params.push(query.kind)
    let where = 'e.kind=?'
    if (query.artistName !== undefined) {
      where += ' AND trim(e.title)=?'
      params.push(query.artistName.trim())
    }
    if (query.search) {
      where += " AND instr(lower(e.title || ' ' || e.artist),lower(?))>0"
      params.push(query.search)
    }
    const from = `FROM candidates c CROSS JOIN catalog_entities e ON e.id=c.entity_id WHERE ${where}`
    const offset = query.offset ?? 0,
      limit = query.limit ?? 200,
      revision = Number(this.state('revision')),
      changes = Number((this.sql.prepare('SELECT total_changes() AS c').get() as Row)?.c ?? 0),
      filterKey = JSON.stringify([changes, revision, conditions, where, params]),
      pageKey = `${filterKey}:${offset}:${limit}`,
      cached = this.queryCache.get(pageKey)
    if (cached) return cached
    const knownTotal = this.totalCache.get(filterKey),
      reverse = knownTotal !== undefined && offset > knownTotal / 2 && offset < knownTotal,
      pageLimit = reverse ? Math.min(limit, Math.max(0, knownTotal - offset)) : limit,
      pageOffset = reverse ? Math.max(0, knownTotal - offset - limit) : offset
    const rows = this.sql
      .prepare(
        `${cte}, matched AS MATERIALIZED (SELECT e.id,e.title,c.source_count ${from}),
        page AS (SELECT * FROM matched ORDER BY title COLLATE NOCASE ${reverse ? 'DESC' : 'ASC'},id ${reverse ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?)
        SELECT e.*,p.source_count,t.total FROM (SELECT count(*) total FROM matched) t
          LEFT JOIN page p ON 1 LEFT JOIN catalog_entities e ON e.id=p.id
        ORDER BY e.title COLLATE NOCASE,e.id`
      )
      .all(...params, pageLimit, pageOffset) as Row[]
    const total = Number(rows[0].total),
      result: CatalogPage = { revision, offset, total, items: rows.filter(row => row.id !== null).map(entityView) }
    this.totalCache.set(filterKey, total)
    while (this.totalCache.size > 32) this.totalCache.delete(this.totalCache.keys().next().value!)
    this.queryCache.set(pageKey, result)
    while (this.queryCache.size > 32) this.queryCache.delete(this.queryCache.keys().next().value!)
    return result
  }
  detail(id: string, revision?: number): CatalogDetail {
    if (!validCatalogPayload('catalog.detail', { id, revision }))
      throw new Error('Invalid catalog entity')
    this.fence(revision)
    const row = this.sql
      .prepare(
        `SELECT e.*,(SELECT count(*) FROM catalog_entity_sources b WHERE b.entity_id=e.id) AS source_count
      FROM catalog_entities e WHERE e.id=?`
      )
      .get(id) as Row | undefined
    const mapped =
      row?.kind === 'recording'
        ? 'recording_id'
        : row?.kind === 'release' || row?.kind === 'album_project' ? 'release_id' : null
    const args: SQLInputValue[] = [id]
    const projection = mapped
      ? `UNION ALL SELECT f.source_id,f.field,f.value,f.origin
      FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      JOIN catalog_facts f ON f.source_id=s.id AND f.entity_id=s.${mapped}
      WHERE b.entity_id=? AND f.entity_id<>?`
      : ''
    if (mapped) args.push(id, id)
    const facts = this.sql
      .prepare(
        `SELECT f.source_id,f.field,f.value,f.origin FROM catalog_facts f
      WHERE f.entity_id=? ${projection}
      ORDER BY source_id,field LIMIT 201`
      )
      .all(...args) as Row[]
    return {
      revision: Number(this.state('revision')),
      entity: row ? entityView(row) : null,
      factsTruncated: facts.length > 200,
      facts: facts.slice(0, 200).map((f) => ({
        sourceId: str(f.source_id),
        field: f.field as 'title' | 'artist' | 'album',
        value: str(f.value),
        origin: f.origin as 'file' | 'provider'
      }))
    }
  }
  sources(query: CatalogSourceQuery): CatalogSourcePage {
    if (!validCatalogPayload('catalog.sources', query))
      throw new Error('Invalid catalog sources query')
    this.fence(query.revision)
    const from =
      'FROM catalog_entity_sources b JOIN catalog_bindings s ON s.id=b.source_id WHERE b.entity_id=?'
    const total = Number(
      (this.sql.prepare(`SELECT count(*) AS n ${from}`).get(query.entityId) as Row).n
    )
    const offset = query.offset ?? 0
    const rows = this.sql
      .prepare(
        `SELECT s.*,EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id) AS member,
      CASE WHEN b.entity_id=s.recording THEN s.preferred_recording WHEN b.entity_id=s.release THEN s.preferred_release ELSE 0 END AS preferred
      ${from} ORDER BY s.id LIMIT ? OFFSET ?`
      )
      .all(query.entityId, query.limit ?? 200, offset) as Row[]
    return {
      revision: Number(this.state('revision')),
      offset,
      total,
      items: rows.map((s) => ({
        id: str(s.id),
        provider: str(s.provider),
        recordingId: str(s.recording),
        releaseId: s.release as string | null,
        availability: s.availability as 'indexed' | 'unknown' | 'missing',
        inLibrary: !!s.member,
        preferred: !!s.preferred,
        track: displayTrack(JSON.parse(str(s.payload)))
      }))
    }
  }
  resolve(sourceId: string, revision: number): TrackData | null {
    if (!validCatalogPayload('catalog.play', { sourceId, revision }))
      throw new Error('Invalid catalog source reference')
    this.fence(revision)
    const source = this.sql.prepare('SELECT * FROM catalog_sources WHERE id=?').get(sourceId) as
      | Row
      | undefined
    if (!source) return null
    if (source.provider !== 'local') return JSON.parse(str(source.payload)) as TrackData
    const current = this.sql
      .prepare('SELECT payload FROM tracks WHERE id=?')
      .get(source.track_id) as Row | undefined
    if (!current) return null
    const track = libraryTrack(JSON.parse(str(current.payload)))
    return versionSourceKey(track) === source.source_key ? track : null
  }
}

function entityView(row: Row): CatalogEntity {
  return {
    id: str(row.id),
    kind: row.kind as CatalogKind,
    title: str(row.title),
    artist: str(row.artist),
    identity: row.identity as 'source' | 'manual',
    sourceCount: Number(row.source_count)
  }
}

function displayTrack(track: TrackData) {
  const {
    id: _id,
    queueEntryId: _occurrence,
    subTrack: _selector,
    ...display
  } = projectCoreTrack(track)
  return display
}

/** A safe durable provider reference, never a captured URL, credential or analysis payload. */
function snapshot(track: TrackData, provider: string, credits: readonly TrackArtistRef[]): TrackData {
  const result: TrackData = {
    id: track.id,
    title: str(track.title),
    artist: str(track.artist),
    album: str(track.album),
    source: provider,
    duration: finite(track.duration),
    size: finite(track.size),
    filePath: '',
    fileName: '',
    cover: null,
    lyrics: null
  }
  for (const field of [
    'albumId',
    'albumArtist',
    'releaseDate',
    'genre',
    'isrc',
    'format',
    'sampleRate',
    'bitDepth',
    'bitrate',
    'discNumber',
    'trackNumber',
    'cueRange',
    'ncmSongId',
    'addedAt'
  ] as const)
    if (typeof track[field] === 'string')
      Object.assign(result, { [field]: (track[field] as string).slice(0, 32768) })
    else if (typeof track[field] === 'number' && Number.isFinite(track[field]))
      Object.assign(result, { [field]: track[field] })
  if (track.cueRange) result.cueRange = normalizeCueRange(track.cueRange) ?? undefined
  result.identityTags = normalizeTrackIdentityTags(track.identityTags)
  if (credits.length)
    result.artists = credits
      .slice(0, 128)
      .filter((a) => a && typeof a.name === 'string')
      .map((a) => ({
        name: a.name.slice(0, 32768),
        ...(typeof a.id === 'string'
          ? { id: a.id.slice(0, 8192) }
          : typeof a.id === 'number' && Number.isFinite(a.id)
            ? { id: a.id }
            : {})
      }))
  return result
}
