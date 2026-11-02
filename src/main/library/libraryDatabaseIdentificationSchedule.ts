import type { DatabaseSync } from 'node:sqlite'
import type {
  IdentificationScheduleRequest,
  IdentificationScheduleResult,
  IdentificationScheduleStatus
} from '../../shared/musicIdentificationSchedule.ts'
import type { LibraryDatabaseEntityMetadata } from './libraryDatabaseEntityMetadata.ts'
import { validMetadataLanguage, type EntityMetadataJob } from '../../shared/entityMetadata.ts'
import { isPublicMetadataSource, metadataProviderReference } from '../../shared/metadataProviders.ts'
import { ncmFileReferences } from '../../shared/ncmFileIdentity.ts'

const mark = (entity: string) => `INSERT INTO metadata_identification_schedule(entity_id,origin)
  SELECT ${entity},'new' WHERE true ON CONFLICT(entity_id) DO UPDATE SET dirty=1;`
const members = (side: string) =>
  `SELECT entity_id FROM catalog_entity_sources WHERE source_id=${side}.source_id`
/** Outbox and cursors, not a second execution queue. Writes share catalog/input transactions. */
export const IDENTIFICATION_SCHEDULE_SCHEMA_SQL = `
CREATE TABLE metadata_identification_schedule(id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL UNIQUE REFERENCES catalog_entities(id), origin TEXT NOT NULL,
  demand_id TEXT NOT NULL UNIQUE DEFAULT ('auto:'||lower(hex(randomblob(16)))),
  dirty INTEGER NOT NULL DEFAULT 1, stamp TEXT NOT NULL DEFAULT '', configuration TEXT NOT NULL DEFAULT '');
CREATE INDEX metadata_identification_schedule_dirty ON metadata_identification_schedule(dirty,id);
CREATE TABLE metadata_identification_schedule_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO metadata_identification_schedule_state VALUES('history_cursor','0');
CREATE TRIGGER metadata_schedule_input_insert AFTER INSERT ON metadata_identification_inputs BEGIN ${mark('new.entity_id')} END;
CREATE TRIGGER metadata_schedule_input_update AFTER UPDATE ON metadata_identification_inputs BEGIN ${mark('new.entity_id')} END;
CREATE TRIGGER metadata_schedule_member_insert AFTER INSERT ON catalog_memberships BEGIN
  INSERT INTO metadata_identification_schedule(entity_id,origin) SELECT entity_id,'new' FROM (${members('new')}) WHERE true
    ON CONFLICT(entity_id) DO UPDATE SET dirty=1; END;
CREATE TRIGGER metadata_schedule_member_delete BEFORE DELETE ON catalog_memberships BEGIN
  INSERT INTO metadata_identification_schedule(entity_id,origin) SELECT entity_id,'new' FROM (${members('old')}) WHERE true
    ON CONFLICT(entity_id) DO UPDATE SET dirty=1; END;
`
type Row = Record<string, string | number | null>
export class LibraryDatabaseIdentificationSchedule {
  private readonly sql: DatabaseSync
  private readonly metadata: LibraryDatabaseEntityMetadata
  private readonly transaction: <T>(action: () => T) => T
  constructor(
    sql: DatabaseSync,
    metadata: LibraryDatabaseEntityMetadata,
    transaction: <T>(action: () => T) => T
  ) {
    this.sql = sql
    this.metadata = metadata
    this.transaction = transaction
  }
  private state(key: string): string | null {
    return (
      (this.sql
        .prepare('SELECT value FROM metadata_identification_schedule_state WHERE key=?')
        .get(key)?.value as string) ?? null
    )
  }
  private set(key: string, value: string | number) {
    this.sql
      .prepare(
        `INSERT INTO metadata_identification_schedule_state VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      )
      .run(key, String(value))
  }
  status(): IdentificationScheduleStatus {
    const horizon = this.state('history_horizon')
    return {
      pending: Number(
        this.sql
          .prepare('SELECT count(*) n FROM metadata_identification_schedule WHERE dirty=1')
          .get()!.n
      ),
      history: {
        cursor: Number(this.state('history_cursor')),
        horizon: horizon === null ? null : Number(horizon)
      }
    }
  }
  advance(request: IdentificationScheduleRequest, now: number): IdentificationScheduleResult {
    if (
      !request ||
      typeof request.enabled !== 'boolean' ||
      typeof request.newImports !== 'boolean' ||
      typeof request.history !== 'boolean' ||
      !Array.isArray(request.providers) ||
      request.providers.length > 16 ||
      new Set(request.providers.map((p) => p.id)).size !== request.providers.length ||
      !request.providers.every(
        (p) =>
          /^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.id) &&
          typeof p.matcherVersion === 'string' &&
          !!p.matcherVersion &&
          p.matcherVersion.length <= 128 &&
          Array.isArray(p.kinds) &&
          p.kinds.length <= 4 &&
          p.kinds.every((k) => ['artist', 'recording', 'release', 'album_project'].includes(k))
      ) ||
      (request.enrichment !== undefined && (
        !validMetadataLanguage(request.enrichment.language) ||
        !Array.isArray(request.enrichment.providers) || request.enrichment.providers.length > 17 ||
        new Set(request.enrichment.providers.map(p => p.id)).size !== request.enrichment.providers.length ||
        !request.enrichment.providers.every(p =>
          (['musicbrainz-details', 'public-artwork'].includes(p.id) || isPublicMetadataSource(p.id) || /^platform\.[a-z0-9][a-z0-9._-]{0,118}$/.test(p.id)) &&
          typeof p.context === 'string' && p.context.length <= 32768 &&
          Array.isArray(p.kinds) && p.kinds.length <= 4 &&
          p.kinds.every(k => ['artist', 'recording', 'release', 'album_project'].includes(k)))
      ))
    )
      throw new Error('Invalid automatic identification configuration')
    return this.transaction(() => {
      // Platform append can refresh existing rows before publishing membership.
      // Wait for commit/abort; a new staged row never counts as a real member.
      if (
        this.sql.prepare('SELECT 1 FROM catalog_imports LIMIT 1').get() ||
        this.sql.prepare('SELECT 1 FROM catalog_pending LIMIT 1').get() ||
        this.sql
          .prepare(
            `SELECT 1 WHERE CAST((SELECT value FROM catalog_state WHERE key='local_cursor') AS INTEGER)<CAST((SELECT value FROM catalog_state WHERE key='local_horizon') AS INTEGER)
          OR CAST((SELECT value FROM catalog_state WHERE key='project_cursor') AS INTEGER)<CAST((SELECT value FROM catalog_state WHERE key='project_horizon') AS INTEGER)`
          )
          .get()
      )
        return { ...this.status(), processed: 0, more: false }
      const configuration = JSON.stringify(request)
      if (this.state('configuration') !== configuration) {
        this.set('configuration', configuration)
        this.set('configuration_cursor', 0)
        this.set(
          'configuration_horizon',
          Number(
            this.sql
              .prepare('SELECT coalesce(max(id),0) n FROM metadata_identification_schedule')
              .get()!.n
          )
        )
      }
      let budget = 200,
        processed = 0
      if (request.enabled && request.history && this.state('history_horizon') === null)
        this.set(
          'history_horizon',
          Number(this.sql.prepare('SELECT coalesce(max(rowid),0) n FROM catalog_entities').get()!.n)
        )
      const cursor = Number(this.state('configuration_cursor')),
        horizon = Number(this.state('configuration_horizon'))
      if (cursor < horizon) {
        const rows = this.sql
          .prepare(
            'SELECT id FROM metadata_identification_schedule WHERE id>? AND id<=? ORDER BY id LIMIT 200'
          )
          .all(cursor, horizon) as Row[]
        for (const row of rows)
          this.sql
            .prepare('UPDATE metadata_identification_schedule SET dirty=1 WHERE id=?')
            .run(row.id)
        this.set('configuration_cursor', rows.length === 200 ? Number(rows.at(-1)!.id) : horizon)
      }
      const process = (row: Row) => {
        const entityId = String(row.entity_id),
          batchId = String(row.demand_id)
        const live = !!this.sql
          .prepare(
            `SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
          WHERE b.entity_id=? AND s.availability<>'missing' AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=b.source_id) LIMIT 1`
          )
          .get(entityId)
        const historical =
          request.history &&
          Number(
            this.sql.prepare('SELECT rowid seq FROM catalog_entities WHERE id=?').get(entityId)!.seq
          ) <= Number(this.state('history_horizon'))
        const permitted =
          live && request.enabled && ((request.newImports && row.origin === 'new') || historical)
        const input = live ? this.metadata.identification.input(entityId) : null
        const stamp = input ? JSON.stringify([input.version, input.linkRevision]) : ''
        const identity = this.metadata.identification.detail(entityId)
        let providers =
          permitted &&
          !['confirmed', 'detached'].includes(identity.link?.state ?? '')
            ? request.providers.filter((p) => p.kinds.includes(input!.kind))
            : []
        // A consistent file-native identity already names the service record.
        // Resolve that first instead of scheduling speculative searches everywhere.
        // Do not suppress alternatives when the selected adapter is unavailable or
        // the file observations disagree about the person/recording/release.
        if (input && providers.some(p => p.id === 'platform.ncm') && ncmFileReferences(input).size === 1)
          providers = providers.filter(p => p.id === 'platform.ncm')
        const enrichment = permitted && identity.link?.state === 'confirmed'
          ? (request.enrichment?.providers ?? []).filter(p => p.kinds.includes(input!.kind)).flatMap(p => {
              const ref = metadataProviderReference(p.id, input!.kind, identity.references)
              return ref ? [{ ...p, externalId: ref.value }] : []
            }) : []
        const wanted = (job: EntityMetadataJob) => job.type === 'identify'
          ? providers.some(p => p.id === job.provider && p.matcherVersion === job.identification?.matcherVersion)
          : job.type === 'enrich' && job.entityId === identity.link?.targetId &&
            job.language === request.enrichment?.language && enrichment.some(p =>
              p.id === job.provider && p.context === (job.providerContext ?? '') && p.externalId === job.externalId)
        const jobs = this.sql.prepare(`SELECT j.id,j.payload FROM metadata_jobs j
          JOIN metadata_demands d ON d.job_id=j.id WHERE d.batch_id=?`).all(batchId)
          .map(row => JSON.parse(String(row.payload)) as EntityMetadataJob)
        // Remove only this automatic consumer. Explicit/shared consumers remain.
        for (const job of jobs) {
          if (wanted(job)) continue
          if (['queued', 'running', 'retry_wait', 'blocked'].includes(job.state))
            this.metadata.cancel(job.id, batchId, now)
          else
            this.sql
              .prepare('DELETE FROM metadata_demands WHERE job_id=? AND batch_id=?')
              .run(job.id, batchId)
        }
        const previousProviders: IdentificationScheduleRequest['providers'] = row.configuration
          ? JSON.parse(String(row.configuration)).providers
          : []
        const changed = providers.filter(
          (p) =>
            row.stamp !== stamp ||
            !previousProviders.some(
              (old) => old.id === p.id && old.matcherVersion === p.matcherVersion
            ) ||
            !this.sql
              .prepare(
                `SELECT 1 FROM metadata_demands d JOIN metadata_jobs j ON j.id=d.job_id
            WHERE d.batch_id=? AND json_extract(j.payload,'$.provider')=? AND json_extract(j.payload,'$.identification.matcherVersion')=?`
              )
              .get(batchId, p.id, p.matcherVersion)
        )
        if (changed.length)
          this.metadata.enqueueIdentification({ entityId, batchId, providers: changed }, now)
        for (const provider of enrichment)
          if (!jobs.some(job => wanted(job) && job.type === 'enrich' && job.provider === provider.id))
            this.metadata.enqueue({ entityId, batchId, type: 'enrich', provider: provider.id,
              providerContext: provider.context, language: request.enrichment!.language }, now)
        this.sql
          .prepare(
            'UPDATE metadata_identification_schedule SET dirty=0,stamp=?,configuration=? WHERE entity_id=?'
          )
          .run(stamp, configuration, entityId)
        processed++
        budget--
      }
      for (const row of this.sql
        // A confirmed identity has exact-ID detail work ready to run. Do not
        // leave its follow-up behind pages of speculative identification input:
        // each page can otherwise be separated by a slow network lookup.
        .prepare(`SELECT s.* FROM metadata_identification_schedule s
          LEFT JOIN metadata_identity_links l ON l.entity_id=s.entity_id
          WHERE s.dirty=1 ORDER BY CASE WHEN l.state='confirmed' THEN 0 ELSE 1 END,s.id LIMIT ?`)
        .all(budget) as Row[])
        process(row)
      if (request.enabled && request.history && budget > 0) {
        const start = Number(this.state('history_cursor')),
          end = Number(this.state('history_horizon'))
        if (start < end) {
          const limit = budget
          const rows = this.sql
            .prepare(
              `SELECT rowid seq,id FROM catalog_entities e WHERE rowid>? AND rowid<=?
            AND kind IN ('artist','recording','release','album_project') AND EXISTS(
              SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
              WHERE b.entity_id=e.id AND s.availability<>'missing' AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=b.source_id))
            ORDER BY rowid LIMIT ?`
            )
            .all(start, end, limit) as Row[]
          for (const row of rows) {
            this.sql
              .prepare(
                "INSERT OR IGNORE INTO metadata_identification_schedule(entity_id,origin) VALUES(?,'history')"
              )
              .run(row.id)
            const scheduled = this.sql
              .prepare('SELECT * FROM metadata_identification_schedule WHERE entity_id=?')
              .get(row.id) as Row
            process(scheduled)
          }
          this.set('history_cursor', rows.length === limit ? Number(rows.at(-1)!.seq) : end)
        }
      }
      const status = this.status()
      return {
        ...status,
        processed,
        more:
          status.pending > 0 ||
          Number(this.state('configuration_cursor')) <
            Number(this.state('configuration_horizon')) ||
          (request.enabled &&
            request.history &&
            status.history.cursor < (status.history.horizon ?? 0))
      }
    })
  }
}
