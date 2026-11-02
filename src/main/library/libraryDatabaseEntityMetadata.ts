import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  EntityMetadataDetail,
  EntityMetadataDemand,
  EntityMetadataDecision,
  EntityMetadataFact,
  EntityMetadataJob,
  EntityMetadataJobsQuery,
  EntityMetadataLanguage,
  EntityMetadataReadOptions,
  EntityMetadataOverride,
  EntityMetadataSourcePreference,
  EntityMetadataArtworkOverride,
  EntityMetadataWork,
  EntityMetadataResult
} from '../../shared/entityMetadata.ts'
import { validEntityMetadataPayload } from '../../shared/entityMetadata.ts'
import { METADATA_ACTIVE_STATES, METADATA_REQUERY_STATES, validMetadataTasksPayload,
  type MetadataTaskSourcesQuery, type MetadataTaskSourcesPage, type MetadataTaskRequery } from '../../shared/entityMetadataTasks.ts'
import { LibraryDatabaseIdentification } from './libraryDatabaseIdentification.ts'
import type { IdentificationEnqueue } from '../../shared/musicIdentification.ts'
import { validIdentificationPayload } from '../../shared/musicIdentification.ts'
import { metadataLanguageFamily } from '../../shared/musicMetadata.ts'
import { metadataCacheContextMatches } from '../../shared/metadataCacheContext.ts'
import { normalizeReleaseDate } from '../../shared/releaseDate.ts'
import type { LibraryCollectionPage } from '../../shared/libraryDatabase.ts'
import type { MusicCredit, MusicCreditsQuery, MusicCreditsPage } from '../../shared/musicCredits.ts'
import type { MetadataArtworkRecord } from '../../shared/musicArtwork.ts'
import type { LegacyMusicDetail } from '../../shared/legacyMusicMetadata.ts'
import { legacyMusicDetail } from './legacyMusicDetail.ts'
import { LibraryDatabaseLegacyTasks } from './libraryDatabaseLegacyTasks.ts'
import type { LibraryDatabaseLegacyMusic } from './libraryDatabaseLegacyMusic.ts'
import type { IdentificationScheduleRequest } from '../../shared/musicIdentificationSchedule.ts'
import { parsePersonalMusicArtwork } from '../../shared/personalMusicArtwork.ts'
import { isPublicMetadataSource, metadataProviderReference, selectMetadataIntroduction } from '../../shared/metadataProviders.ts'

export const ENTITY_METADATA_SCHEMA_SQL = `
CREATE TABLE metadata_entities(id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL,
  external_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(provider,kind,external_id));
CREATE TABLE metadata_subjects(id TEXT PRIMARY KEY REFERENCES catalog_entities(id), revision INTEGER NOT NULL DEFAULT 0,
  target_id TEXT REFERENCES metadata_entities(id), mbid TEXT NOT NULL DEFAULT '', state TEXT);
CREATE TABLE metadata_link_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
  target_id TEXT, mbid TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE metadata_facts(target_id TEXT NOT NULL REFERENCES metadata_entities(id), provider TEXT NOT NULL,
  field TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(target_id,provider,field,language));
CREATE TABLE metadata_overrides(entity_id TEXT PRIMARY KEY REFERENCES metadata_subjects(id), payload TEXT NOT NULL);
CREATE TABLE metadata_jobs(id TEXT PRIMARY KEY, task_key TEXT NOT NULL UNIQUE, entity_id TEXT NOT NULL,
  state TEXT NOT NULL, next_attempt INTEGER NOT NULL, input TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX metadata_jobs_due ON metadata_jobs(state,next_attempt,id);
CREATE INDEX metadata_jobs_entity ON metadata_jobs(entity_id,id);
CREATE TABLE metadata_demands(job_id TEXT NOT NULL REFERENCES metadata_jobs(id), batch_id TEXT NOT NULL,
  PRIMARY KEY(job_id,batch_id));
`
export const ENTITY_METADATA_DETAILS_SCHEMA_SQL = `
CREATE TABLE metadata_credit_sets(target_id TEXT NOT NULL REFERENCES metadata_entities(id),provider TEXT NOT NULL,
  revision INTEGER NOT NULL,truncated INTEGER NOT NULL,PRIMARY KEY(target_id,provider));
CREATE TABLE metadata_credits(target_id TEXT NOT NULL,provider TEXT NOT NULL,position INTEGER NOT NULL,
  payload TEXT NOT NULL,PRIMARY KEY(target_id,provider,position),
  FOREIGN KEY(target_id,provider) REFERENCES metadata_credit_sets(target_id,provider) ON DELETE CASCADE);
`
export const ENTITY_METADATA_PERSONAL_SCHEMA_SQL = `
CREATE TABLE metadata_source_preferences(entity_id TEXT PRIMARY KEY REFERENCES metadata_subjects(id),
  provider TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE metadata_artwork_overrides(entity_id TEXT PRIMARY KEY REFERENCES metadata_subjects(id),
  payload TEXT NOT NULL);
`
type Row = Record<string, unknown>
interface Owner {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  contentRevision(): number
  albumAliases(id: string): string[]
  music(): LibraryDatabaseLegacyMusic
  exploration?(): import('./libraryDatabaseExploration.ts').LibraryDatabaseExploration
}
const stale = () =>
  Object.assign(new Error('音乐资料或关联已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const decode = <T>(row: Row | undefined): T | null =>
  row ? (JSON.parse(String(row.payload)) as T) : null

/** Durable entity facts. Catalog/source facts stay untouched and links are reversible. */
export class LibraryDatabaseEntityMetadata {
  readonly identification: LibraryDatabaseIdentification
  readonly legacy: LibraryDatabaseLegacyTasks
  private readonly sql: DatabaseSync
  private readonly owner: Owner
  constructor(owner: Owner) {
    this.owner = owner
    this.sql = owner.sql
    this.identification = new LibraryDatabaseIdentification(owner)
    this.legacy = new LibraryDatabaseLegacyTasks({ ...owner, save: (job, input, key) => this.save(job, input, key) })
  }
  private transaction<T>(action: () => T): T {
    return this.sql.isTransaction ? action() : this.owner.transaction(action)
  }
  private subject(id: string): Row {
    const artist = this.sql
      .prepare('SELECT * FROM catalog_entities WHERE id=?')
      .get(id) as Row | undefined
    if (!artist) throw new Error('音乐实体不存在，请先完成目录索引')
    const subject: Row = { ...artist, ...this.sql.prepare('SELECT * FROM metadata_subjects WHERE id=?').get(id) }
    if (artist.kind !== 'artist') {
      const { link } = this.identification.detail(id)
      subject.state = link?.state === 'unresolved' ? null : link?.state
      subject.target_id = link?.targetId ?? null
      subject.revision = Number(subject.revision ?? 0) + (link?.revision ?? 0)
    }
    if (subject.state === 'confirmed') {
      const ref = this.sql.prepare("SELECT value FROM metadata_identity_refs WHERE target_id=? AND provider='musicbrainz' AND kind='artist' AND id_type='mbid'")
        .get(String(subject.target_id)) as Row | undefined
      subject.mbid = ref?.value ?? ''
    }
    return subject
  }
  private ensure(id: string) {
    this.subject(id)
    this.sql.prepare('INSERT OR IGNORE INTO metadata_subjects(id) VALUES(?)').run(id)
  }
  private input(id: string, type: EntityMetadataJob['type']): string {
    if (type === 'identify') {
      const input = this.identification.input(id)
      if (!input.sources?.length) throw stale()
      return JSON.stringify([input.version, input.linkRevision])
    }
    if (type === 'enrich') {
      const target = this.sql.prepare('SELECT * FROM metadata_entities WHERE id=?').get(id)
      if (!target) throw stale()
      return JSON.stringify(target)
    }
    const subject = this.subject(id)
    // Title/identity/link version, not the global catalog revision. Unrelated scans
    // and facts cannot invalidate this work. Availability is checked independently.
    const active = this.sql
      .prepare(
        `SELECT 1 FROM catalog_source_artists a JOIN catalog_sources s ON s.id=a.source_id
      WHERE a.artist_id=? AND s.availability<>'missing' LIMIT 1`
      )
      .get(id)
    if (!active) throw stale()
    return JSON.stringify([subject.title, subject.artist, subject.revision ?? 0])
  }
  private visibleFact(fact: EntityMetadataFact, options: EntityMetadataReadOptions, sourceProvider: string) {
    if (fact.usage && (!fact.usage.display || !fact.usage.cache ||
      (fact.usage.expiresAt !== undefined && fact.usage.expiresAt <= (options.now ?? Date.now())))) return false
    return !fact.sourceProvider || metadataCacheContextMatches(fact.sourceProvider,
      fact.providerContext, options.platformContexts?.[fact.sourceProvider]) &&
      (fact.usage?.crossSource || sourceProvider === fact.sourceProvider)
  }
  /** Page-only fallback. File dates, playback bindings and saved tags are unchanged. */
  collectionDates(page: LibraryCollectionPage, options: EntityMetadataReadOptions): LibraryCollectionPage {
    const candidates = page.items.filter(item => !normalizeReleaseDate(item.releaseDate) && item.catalog &&
      item.catalog.total === item.catalog.items.length && item.catalog.items.some(ref => ref.kind === 'release'))
    const ids = [...new Set(candidates.flatMap(item => item.catalog!.items.filter(ref => ref.kind === 'release').map(ref => ref.id)))]
    if (!ids.length) return page
    const targets = new Map<string, string>(), facts = new Map<string, EntityMetadataFact[]>()
    for (const row of this.sql.prepare(`SELECT l.entity_id,l.target_id,f.payload FROM metadata_identity_links l
      LEFT JOIN metadata_facts f ON f.target_id=l.target_id AND f.field='releaseDate'
      WHERE l.kind='release' AND l.state='confirmed' AND l.target_id IS NOT NULL
        AND l.entity_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))) {
      const target = String(row.target_id)
      targets.set(String(row.entity_id), target)
      if (row.payload) {
        const fact = decode<EntityMetadataFact>(row)!
        if (normalizeReleaseDate(fact.value) && this.visibleFact(fact, options, 'local')) {
          const values = facts.get(target) ?? []
          values.push(fact)
          facts.set(target, values)
        }
      }
    }
    const eligible = new Set(candidates)
    return { ...page, items: page.items.map(item => {
      if (!eligible.has(item)) return item
      const releases = item.catalog!.items.filter(ref => ref.kind === 'release')
      const target = targets.get(releases[0].id)
      // A collection with unresolved or different releases cannot borrow the first one's date.
      if (!target || releases.some(ref => targets.get(ref.id) !== target)) return item
      const values = facts.get(target) ?? []
      const priority = (fact: EntityMetadataFact) => fact.attribution.provider === 'musicbrainz' ? 0 : fact.sourceProvider ? 2 : 1
      values.sort((a, b) => priority(a) - priority(b) || a.attribution.provider.localeCompare(b.attribution.provider))
      const fact = values[0]
      return fact ? { ...item, metadataReleaseDate: { value: normalizeReleaseDate(fact.value)!,
        attribution: fact.attribution, ...(fact.usage ? { usage: fact.usage } : {}) } } : item
    }) }
  }
  detail(id: string, language: EntityMetadataLanguage, options: EntityMetadataReadOptions = {}): EntityMetadataDetail {
    const subject = this.subject(id)
    const targetId = subject.state === 'confirmed' ? String(subject.target_id) : null
    if (targetId) this.sql.prepare(`DELETE FROM metadata_facts WHERE target_id=?
      AND json_extract(payload,'$.usage.expiresAt')<=?`).run(targetId, options.now ?? Date.now())
    const sourceProviders = this.sql.prepare(`SELECT DISTINCT s.provider FROM catalog_entity_sources b
      JOIN catalog_sources s ON s.id=b.source_id WHERE b.entity_id=?`).all(id).map(r => String(r.provider))
    if (options.sourceProvider && !sourceProviders.includes(options.sourceProvider))
      throw new Error('资料上下文不属于当前来源')
    const sourceProvider = options.sourceProvider ?? (sourceProviders.length === 1 ? sourceProviders[0] : 'local')
    const facts = (targetId
      ? (
          this.sql
            .prepare(
              "SELECT payload FROM metadata_facts WHERE target_id=? AND field<>'artwork' ORDER BY provider,field,language LIMIT 32"
            )
            .all(targetId) as Row[]
        ).map((row) => decode<EntityMetadataFact>(row)!)
      : []).filter(f => this.visibleFact(f, options, sourceProvider))
    const override = decode<EntityMetadataDetail['override']>(
      this.sql.prepare('SELECT payload FROM metadata_overrides WHERE entity_id=?').get(id) as
        | Row
        | undefined
    )
    const preference = this.sql.prepare('SELECT provider FROM metadata_source_preferences WHERE entity_id=?').get(id)
    const preferredProvider = preference?.provider == null ? null : String(preference.provider)
    const artworkOverride = decode<{ mode: 'value' | 'clear'; dataUrl?: string }>(
      this.sql.prepare('SELECT payload FROM metadata_artwork_overrides WHERE entity_id=?').get(id))
    const creditPage = this.credits({ entityId: id, limit: 64 })
    // Historical material is bound to the original local entity, never to the
    // shared target. It remains imported even if the old flag said matched.
    const imports: LegacyMusicDetail[] = sourceProvider === 'local' ? this.sql.prepare(`SELECT a.plugin_id,a.legacy_id,a.payload,a.disposition,d.revision,
      (SELECT p.disposition FROM metadata_legacy_provenance p WHERE p.plugin_id=a.plugin_id AND p.legacy_id=a.legacy_id
        AND p.snapshot_revision=-1 AND p.field='description' AND p.value=json_quote(json_extract(a.payload,'$.description'))) description_disposition
      FROM metadata_legacy_bindings b JOIN metadata_legacy_albums a USING(plugin_id,legacy_id)
      JOIN metadata_legacy_documents d USING(plugin_id)
      WHERE b.entity_id=? AND d.state='published' ORDER BY a.plugin_id,a.legacy_id LIMIT 8`).all(id).map(legacyMusicDetail) : []
    const imported = imports.filter(item => (item.description || item.descriptionCleared) && item.disposition === 'bound')
    const personalImport = (item: LegacyMusicDetail) => item.method === 'manual' || item.method === 'external-ai'
    const preferredImports = imported.some(personalImport) ? imported.filter(personalImport) : imported
    const retainedIntroduction = new Set(preferredImports.map(item => item.description)).size === 1 ? preferredImports[0] : undefined
    const importedClear = imports.some(item => item.descriptionCleared)
    const languages =
      language === 'en'
        ? ['en', 'und', 'ja']
        : language === 'zh-Hant'
          ? ['zh-Hant', 'zh', 'zh-Hans', 'en', 'und', 'ja']
          : ['zh-Hans', 'zh', 'zh-Hant', 'en', 'und', 'ja']
    // Choose language before provider. Platform pages favor their own source;
    // shared local text favors Wikipedia at the same language and field.
    facts.sort((a, b) => {
      const rank = (f: EntityMetadataFact) => sourceProvider !== 'local' && f.sourceProvider === sourceProvider
        ? 0 : f.attribution.provider === 'wikipedia' ? 1 : f.sourceProvider ? 3 : 2
      return rank(a) - rank(b)
    })
    // A preference only ranks the facts already authorised for this source/account.
    // An unavailable source stays saved and falls back; it never starts a request.
    const preferred = preferredProvider ? selectMetadataIntroduction(facts.filter(f => f.attribution.provider === preferredProvider), language) : undefined
    const selected = preferred ?? selectMetadataIntroduction(facts, language, sourceProvider === 'local')
    return {
      entityId: id,
      targetId,
      revision: Number(subject.revision ?? 0),
      name: String(subject.title),
      link: subject.state
        ? {
            state: subject.state as NonNullable<EntityMetadataDetail['link']>['state'],
            mbid: String(subject.mbid),
            revision: Number(subject.revision)
          }
        : null,
      override,
      sourcePreference: { provider: preferredProvider, available: !preferredProvider || !!preferred },
      sourceOptions: [...new Set(facts.filter(f => ['introduction', 'description'].includes(f.field) &&
        languages.includes(metadataLanguageFamily(f.language))).map(f => f.attribution.provider))].sort(),
      artworkOverride: artworkOverride ? { mode: artworkOverride.mode } : null,
      manualArtwork: artworkOverride?.mode === 'value' ? parsePersonalMusicArtwork(artworkOverride.dataUrl) : null,
      facts,
      ...(imports.length ? { imports } : {}),
      ...(creditPage.total || creditPage.truncated ? { credits: { items: creditPage.items, truncated: creditPage.total > creditPage.items.length || creditPage.truncated } } : {}),
      introduction: override
        ? override.mode === 'clear'
          ? null
          : {
              value: override.value,
              language: override.language,
              origin: 'manual',
              attribution: null
            }
        : importedClear ? null
        : retainedIntroduction && (personalImport(retainedIntroduction) || !selected || (!preferred && selected.attribution.provider === 'platform.ncm'))
          ? { value: retainedIntroduction.description!, language: 'und', origin: 'imported', attribution: null }
        : selected
          ? {
              value: selected.value,
              language: selected.language,
              origin: 'external',
              attribution: selected.attribution
            }
          : null
    }
  }
  credits(query: MusicCreditsQuery): MusicCreditsPage {
    if (!validEntityMetadataPayload('metadata.entity.credits', query)) throw new Error('Invalid metadata credits query')
    const subject = this.subject(query.entityId)
    if (query.entityRevision !== undefined && query.entityRevision !== Number(subject.revision ?? 0)) throw stale()
    const targetId = subject.state === 'confirmed' ? String(subject.target_id) : ''
    const sets = this.sql.prepare('SELECT provider,revision,truncated FROM metadata_credit_sets WHERE target_id=? ORDER BY provider').all(targetId)
    const revision = JSON.stringify([targetId, Number(subject.revision ?? 0), sets.map(s => [s.provider, s.revision])])
    if (query.revision !== undefined && query.revision !== revision) throw stale()
    return { revision, offset: query.offset ?? 0, truncated: sets.some(s => !!s.truncated),
      total: Number(this.sql.prepare('SELECT count(*) n FROM metadata_credits WHERE target_id=?').get(targetId)!.n),
      items: (this.sql.prepare('SELECT payload FROM metadata_credits WHERE target_id=? ORDER BY provider,position LIMIT ? OFFSET ?')
        .all(targetId, query.limit ?? 50, query.offset ?? 0) as Row[]).map(row => decode<MusicCredit>(row)!) }
  }
  artwork(id: string, options: EntityMetadataReadOptions): MetadataArtworkRecord[] {
    const subject = this.subject(id)
    if ((options.artworkTargetId !== undefined && options.artworkTargetId !== (subject.state === 'confirmed' ? String(subject.target_id) : null)) ||
      (options.artworkRevision !== undefined && options.artworkRevision !== Number(subject.revision ?? 0))) throw stale()
    const contexts = { ...(options.artworkContext ? { 'public-artwork': options.artworkContext } : {}), ...options.artworkContexts }
    if (subject.state !== 'confirmed' || !Object.keys(contexts).length) return []
    return this.sql.prepare(`SELECT provider,payload FROM metadata_facts WHERE target_id=? AND field='artwork'
      ORDER BY CASE provider WHEN 'public-artwork' THEN 0 WHEN 'platform.ncm' THEN 2 ELSE 1 END,provider,CASE language WHEN 'release' THEN 0 ELSE 1 END LIMIT 16`)
      .all(String(subject.target_id)).flatMap(row => {
        const image = decode<MetadataArtworkRecord>(row)!
        return metadataCacheContextMatches(String(row.provider), image.providerContext, contexts[String(row.provider)]) &&
          image.usage.display && image.usage.cache && image.usage.crossSource &&
          (image.usage.expiresAt === undefined || image.usage.expiresAt > (options.now ?? Date.now())) ? [image] : []
      }).slice(0, 1)
  }
  private save(job: EntityMetadataJob, input?: string, key?: string) {
    this.sql
      .prepare(
        `INSERT INTO metadata_jobs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state,next_attempt=excluded.next_attempt,input=excluded.input,payload=excluded.payload`
      )
      .run(
        job.id,
        key ?? '',
        job.entityId,
        job.state,
        job.nextAttemptAt,
        input ??
          String(
            (this.sql.prepare('SELECT input FROM metadata_jobs WHERE id=?').get(job.id) as Row)
              .input
          ),
        JSON.stringify(job)
      )
  }
  enqueue(
    request: EntityMetadataDemand & { type: 'resolve' | 'enrich'; mbid?: string; providerContext?: string },
    now: number
  ): EntityMetadataJob {
    const { type, mbid, providerContext, ...demand } = request
    if (
      !validEntityMetadataPayload(`metadata.entity.${type}`, {
        ...demand,
        ...(type === 'resolve' ? { mbid } : {})
      })
    )
      throw new Error('Invalid metadata demand')
    return this.transaction(() => {
      this.ensure(request.entityId)
      const subject = this.subject(request.entityId)
      if (type === 'resolve' && subject.kind !== 'artist') throw new Error('明确人物 ID 接口仅接受人物')
      if (type === 'enrich' && subject.state !== 'confirmed') throw new Error('请先确认音乐实体身份')
      const provider = request.provider ?? 'musicbrainz-wiki'
      if (type === 'enrich' && provider === 'musicbrainz-wiki' && (subject.kind !== 'artist' || !subject.mbid))
        throw new Error('当前人物尚未关联 MusicBrainz，不能请求百科资料')
      const entityId = type === 'enrich' ? String(subject.target_id) : request.entityId
      const typedProvider = provider !== 'musicbrainz-wiki'
      const native = typedProvider ? metadataProviderReference(provider, subject.kind as EntityMetadataJob['entityKind'] & string,
        this.identification.detail(request.entityId).references) : undefined
      if (typedProvider && !native) throw new Error('当前实体没有该资料源可验证的身份，请先查找并核对身份')
      const externalId = native ? String(native.value) : type === 'resolve' ? mbid!.toLowerCase() : String(subject.mbid)
      const key = JSON.stringify([entityId, provider, request.language, type, externalId, ...(providerContext ? [providerContext] : [])])
      const input = this.input(entityId, type)
      const previous = this.sql.prepare('SELECT * FROM metadata_jobs WHERE task_key=?').get(key) as
        | Row
        | undefined
      let job = decode<EntityMetadataJob>(previous)
      if (!job)
        job = {
          id: randomUUID(),
          entityId,
          type,
          provider,
          ...(request.provider ? { entityKind: subject.kind as EntityMetadataJob['entityKind'], providerContext } : {}),
          language: request.language,
          externalId,
          state: 'queued',
          generation: 1,
          attempts: 0,
          nextAttemptAt: now,
          outcome: null,
          reason: null,
          candidate: null,
          updatedAt: now
        }
      else if (
        String(previous!.input) !== input ||
        (job.state === 'needs_review' && !job.candidate) ||
        (!['queued', 'running', 'retry_wait'].includes(job.state) &&
          !(job.state === 'completed' && now - job.updatedAt < 86400000) &&
          job.state !== 'needs_review')
      ) {
        job = {
          ...job,
          state: 'queued',
          generation: job.generation + 1,
          attempts: 0,
          reason: null,
          candidate: null,
          outcome: null,
          nextAttemptAt: now,
          updatedAt: now
        }
      }
      this.save(job, input, key)
      this.sql
        .prepare('INSERT OR IGNORE INTO metadata_demands VALUES(?,?)')
        .run(job.id, request.batchId)
      // The established explicit entry point independently authorizes shared
      // target work under its original contract. Do not let an older requery
      // fence make that entry point unusable; automatic demands cannot opt out.
      if (job.requeryConsumers && !this.sql.prepare('SELECT 1 FROM metadata_identification_schedule WHERE demand_id=?').get(request.batchId)) {
        const { requeryConsumers: _previous, ...explicit } = job
        job = explicit
        this.save(job)
      }
      return job
    })
  }
  enqueueIdentification(request: IdentificationEnqueue, now: number): EntityMetadataJob[] {
    if (!validIdentificationPayload('identification.start', { entityId: request.entityId, batchId: request.batchId }) ||
      !Array.isArray(request.providers) || request.providers.length > 16 ||
      !request.providers.every(p => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(p.id) &&
        typeof p.matcherVersion === 'string' && p.matcherVersion.length > 0 && p.matcherVersion.length <= 128) ||
      new Set(request.providers.map(p => p.id)).size !== request.providers.length)
      throw new Error('Invalid identification demand')
    return this.transaction(() => {
      const input = this.input(request.entityId, 'identify')
      return request.providers.map(({ id: provider, matcherVersion }) => {
        const key = JSON.stringify([request.entityId, provider, 'identify', matcherVersion])
        const previous = this.sql.prepare('SELECT * FROM metadata_jobs WHERE task_key=?').get(key) as Row | undefined
        let job = decode<EntityMetadataJob>(previous)
        if (!job) job = {
          id: randomUUID(), entityId: request.entityId, type: 'identify', provider,
          language: 'en', externalId: '', state: 'queued', generation: 1, attempts: 0,
          nextAttemptAt: now, outcome: null, reason: null, candidate: null, updatedAt: now,
          identification: { matcherVersion, candidateIds: [], incomplete: false, reasons: [] }
        }
        else if (String(previous!.input) !== input ||
          ['blocked', 'failed', 'cancelled'].includes(job.state) ||
          (job.state === 'completed' && now - job.updatedAt >= 86400000)) job = {
          ...job, state: 'queued', generation: job.generation + 1, attempts: 0,
          reason: null, outcome: null, nextAttemptAt: now, updatedAt: now,
          identification: { matcherVersion, candidateIds: [], incomplete: false, reasons: [] }
        }
        this.save(job, input, key)
        this.sql.prepare('INSERT OR IGNORE INTO metadata_demands VALUES(?,?)').run(job.id, request.batchId)
        return job
      })
    })
  }
  jobs(query: EntityMetadataJobsQuery) {
    if (!validEntityMetadataPayload('metadata.entity.jobs', query))
      throw new Error('Invalid metadata job query')
    // A source detail includes work on its confirmed shared target.
    const target = query.entityId ? (this.identification.detail(query.entityId).link?.targetId ?? '') : ''
    const conditions = [
      ...(query.entityId ? ['entity_id IN (?,?)'] : []),
      ...(query.jobId ? ['id=?'] : [])
    ]
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const args = [
      ...(query.entityId ? [query.entityId, String(target)] : []),
      ...(query.jobId ? [query.jobId] : [])
    ]
    const total = Number(
      (this.sql.prepare(`SELECT count(*) AS n FROM metadata_jobs${where}`).get(...args) as Row).n
    )
    const items = (
      this.sql
        .prepare(`SELECT payload FROM metadata_jobs${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
        .all(...args, query.limit ?? 50, query.offset ?? 0) as Row[]
    ).map((row) => decode<EntityMetadataJob>(row)!)
    return { total, items }
  }
  decide(request: EntityMetadataDecision, now: number) {
    if (!validEntityMetadataPayload('metadata.entity.decide', request))
      throw new Error('Invalid metadata decision')
    return this.transaction(() => {
      const row = this.sql.prepare('SELECT * FROM metadata_jobs WHERE id=?').get(request.jobId) as
        | Row
        | undefined
      const job = decode<EntityMetadataJob>(row)
      if (
        !job ||
        job.generation !== request.generation ||
        job.type !== 'resolve' || job.state !== 'needs_review' ||
        !job.candidate ||
        String(row!.input) !== this.input(job.entityId, 'resolve')
      )
        throw stale()
      const state = request.decision === 'confirm' ? 'confirmed' : 'rejected'
      this.identification.legacyDecision(job.entityId, job.candidate, request.decision, now)
      this.save({ ...job, state: 'completed', outcome: 'matched', reason: state, updatedAt: now })
      return this.detail(job.entityId, job.language, { now })
    })
  }
  detach(entityId: string, revision: number, now: number) {
    if (!validEntityMetadataPayload('metadata.entity.detach', { entityId, revision }))
      throw new Error('Invalid metadata detach')
    return this.transaction(() => {
      const subject = this.subject(entityId)
      if (Number(subject.revision ?? 0) !== revision) throw stale()
      this.ensure(entityId)
      if (subject.kind === 'artist') this.identification.legacyDetach(entityId, now)
      else {
        const { link } = this.identification.detail(entityId)
        if (!link) throw new Error('当前没有已确认关联')
        this.identification.detach(link.id, link.revision, now)
      }
      return this.detail(entityId, 'zh-Hans', { now })
    })
  }
  override(request: EntityMetadataOverride, now: number) {
    if (!validEntityMetadataPayload('metadata.entity.override', request))
      throw new Error('Invalid metadata override')
    return this.transaction(() => {
      if (Number(this.subject(request.entityId).revision ?? 0) !== request.revision) throw stale()
      this.ensure(request.entityId)
      if (request.mode === 'reset')
        this.sql.prepare('DELETE FROM metadata_overrides WHERE entity_id=?').run(request.entityId)
      else
        this.sql.prepare('INSERT OR REPLACE INTO metadata_overrides VALUES(?,?)').run(
          request.entityId,
          JSON.stringify({
            mode: request.mode,
            value: request.value ?? '',
            language: request.language,
            updatedAt: now
          })
        )
      this.sql
        .prepare('UPDATE metadata_subjects SET revision=revision+1 WHERE id=?')
        .run(request.entityId)
      return this.detail(request.entityId, request.language, { now })
    })
  }
  sourcePreference(request: EntityMetadataSourcePreference, now: number) {
    if (!validEntityMetadataPayload('metadata.entity.sourcePreference', request)) throw new Error('Invalid metadata source preference')
    return this.transaction(() => {
      if (Number(this.subject(request.entityId).revision ?? 0) !== request.revision) throw stale()
      this.ensure(request.entityId)
      this.sql.prepare(`INSERT INTO metadata_source_preferences VALUES(?,?,?) ON CONFLICT(entity_id)
        DO UPDATE SET provider=excluded.provider,updated_at=excluded.updated_at`).run(request.entityId, request.provider, now)
      this.sql.prepare('UPDATE metadata_subjects SET revision=revision+1 WHERE id=?').run(request.entityId)
      return this.detail(request.entityId, request.language, { now })
    })
  }
  artworkOverride(request: EntityMetadataArtworkOverride, now: number) {
    if (!validEntityMetadataPayload('metadata.entity.artworkOverride', request)) throw new Error('Invalid personal artwork')
    return this.transaction(() => {
      const subject = this.subject(request.entityId)
      if (!['artist', 'release', 'album_project'].includes(String(subject.kind))) throw new Error('当前资料类型不支持图片')
      if (Number(subject.revision ?? 0) !== request.revision) throw stale()
      this.ensure(request.entityId)
      if (request.mode === 'reset') this.sql.prepare('DELETE FROM metadata_artwork_overrides WHERE entity_id=?').run(request.entityId)
      else this.sql.prepare('INSERT OR REPLACE INTO metadata_artwork_overrides VALUES(?,?)').run(request.entityId,
        JSON.stringify({ mode: request.mode, ...(request.mode === 'value' ? { dataUrl: request.dataUrl } : {}), updatedAt: now }))
      this.sql.prepare('UPDATE metadata_subjects SET revision=revision+1 WHERE id=?').run(request.entityId)
      return this.detail(request.entityId, request.language, { now })
    })
  }
  cancel(jobId: string, batchId: string, now: number, generation?: number) {
    return this.transaction(() => {
      // New task controls fence a stale cancel against completion/recovery. Original
      // callers without a generation retain their existing cancellation contract.
      if (generation !== undefined) {
        const row = this.sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(jobId)
        const job = row ? decode<EntityMetadataJob>(row)! : null
        if (!job || job.generation !== generation || job.type === 'legacy' ||
          !METADATA_ACTIVE_STATES.some(state => state === job.state)) throw stale()
      }
      const removed = this.sql
        .prepare('DELETE FROM metadata_demands WHERE job_id=? AND batch_id=?')
        .run(jobId, batchId)
      if (!removed.changes) return false
      const current = decode<EntityMetadataJob>(this.sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(jobId))
      if (current?.requeryConsumers?.length) {
        const configuration = this.sql.prepare("SELECT value FROM metadata_identification_schedule_state WHERE key='configuration'").get()?.value
        if (this.requeryBlock(current, configuration ? JSON.parse(String(configuration)) : undefined)) {
          this.save({ ...current, state: 'cancelled', generation: current.generation + 1, reason: 'input_changed', updatedAt: now })
          return true
        }
      }
      if (!this.sql.prepare('SELECT 1 FROM metadata_demands WHERE job_id=? LIMIT 1').get(jobId)) {
        const job = decode<EntityMetadataJob>(
          this.sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(jobId) as
            | Row
            | undefined
        )!
        this.save({ ...job, state: 'cancelled', generation: job.generation + 1, updatedAt: now })
      }
      return true
    })
  }
  taskSources(query: MetadataTaskSourcesQuery): MetadataTaskSourcesPage {
    if (!validMetadataTasksPayload('metadata.entity.sources', query)) throw new Error('Invalid metadata sources query')
    const job = decode<EntityMetadataJob>(this.sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(query.jobId))
    const page: MetadataTaskSourcesPage = { jobId: query.jobId, generation: job?.generation ?? 0,
      offset: query.offset ?? 0, total: 0, items: [] }
    if (!job || job.type !== 'enrich' || !METADATA_REQUERY_STATES.some(s => s === job.state)) return page
    // These are current confirmed consumers, not proof of who originally requested the job.
    const from = `FROM metadata_identity_links l JOIN catalog_entities e ON e.id=l.entity_id
      WHERE l.target_id=? AND l.state='confirmed' AND EXISTS(
        SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
        WHERE b.entity_id=e.id AND s.availability<>'missing' AND EXISTS(
          SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
        AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
          AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id))))`
    page.total = Number(this.sql.prepare(`SELECT count(*) n ${from}`).get(job.entityId)!.n)
    page.items = this.sql.prepare(`SELECT e.id,e.kind,e.title,e.artist ${from} ORDER BY e.id LIMIT ? OFFSET ?`)
      .all(job.entityId, query.limit ?? 6, page.offset).map(row => {
        const input = this.identification.input(String(row.id))
        return { entity: { id: String(row.id), kind: row.kind as NonNullable<EntityMetadataJob['entityKind']>,
          title: String(row.title), artist: String(row.artist) }, inputVersion: input.version, linkRevision: input.linkRevision,
          providers: [...new Set(input.sources?.map(s => s.provider) ?? [])] }
      })
    return page
  }
  requery(request: MetadataTaskRequery, contexts: Record<string, string>, now: number) {
    if (!validMetadataTasksPayload('metadata.entity.requery', request)) throw new Error('Invalid metadata requery')
    return this.transaction(() => {
      if (this.sql.prepare('SELECT 1 FROM metadata_identification_schedule WHERE demand_id=?').get(request.demandId) ||
        this.sql.prepare('SELECT 1 FROM metadata_demands WHERE batch_id=?').get(request.demandId)) throw stale()
      // Validate every selected row before changing any. No partial batch recovery.
      const selected = request.items.map(item => {
        const job = decode<EntityMetadataJob>(this.sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(item.jobId))
        if (!job || job.type !== 'enrich' || job.generation !== item.generation ||
          !METADATA_REQUERY_STATES.some(s => s === job.state) ||
          (request.batchId && !this.sql.prepare('SELECT 1 FROM metadata_demands WHERE job_id=? AND batch_id=?').get(job.id, request.batchId))) throw stale()
        const input = this.identification.input(item.entityId)
        const identity = this.identification.detail(item.entityId)
        if (!input.sources?.length || input.version !== item.inputVersion || input.linkRevision !== item.linkRevision ||
          identity.link?.state !== 'confirmed' || identity.link.targetId !== job.entityId ||
          !this.liveConsumer(item.entityId, job.entityId)) throw stale()
        if (job.provider !== 'musicbrainz-wiki' &&
          (!Object.hasOwn(contexts, job.provider) || (job.providerContext ?? '') !== contexts[job.provider])) throw stale()
        if (metadataProviderReference(job.provider, input.kind, identity.references)?.value !== job.externalId) throw stale()
        return job
      })
      const batchId = request.demandId
      const jobs = selected.map((job, i) => {
        const next: EntityMetadataJob = { ...job, state: 'queued', generation: job.generation + 1,
          attempts: 0, outcome: null, reason: null, candidate: null,
          nextAttemptAt: Math.max(now, job.nextAttemptAt), updatedAt: now,
          requeryConsumers: [{ batchId, entityId: request.items[i].entityId,
            inputVersion: request.items[i].inputVersion, linkRevision: request.items[i].linkRevision }] }
        this.save(next, this.input(job.entityId, 'enrich'))
        this.sql.prepare('INSERT INTO metadata_demands VALUES(?,?)').run(job.id, batchId)
        return next
      })
      return { batchId, jobs }
    })
  }
  private liveConsumer(entityId: string, targetId: string): boolean {
    return !!this.sql.prepare(`SELECT 1 FROM metadata_identity_links l
      WHERE l.entity_id=? AND l.target_id=? AND l.state='confirmed' AND EXISTS(
        SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
        WHERE b.entity_id=l.entity_id AND s.availability<>'missing' AND EXISTS(
          SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
        AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
          AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id))))`).get(entityId, targetId)
  }
  private requeryConsumerValid(job: EntityMetadataJob): boolean {
    return !!job.requeryConsumers?.some(consumer => {
      if (!this.sql.prepare('SELECT 1 FROM metadata_demands WHERE job_id=? AND batch_id=?').get(job.id, consumer.batchId) ||
        !this.liveConsumer(consumer.entityId, job.entityId)) return false
      const input = this.identification.input(consumer.entityId)
      return input.version === consumer.inputVersion && input.linkRevision === consumer.linkRevision
    })
  }
  recover(now: number) {
    this.legacy.recover(now)
    // Bounded per transaction; indexed scan, no entire library hydration.
    for (;;) {
      const jobs = this.sql
        .prepare("SELECT payload FROM metadata_jobs WHERE state='running' LIMIT 100")
        .all() as Row[]
      if (!jobs.length) break
      this.transaction(() => {
        for (const row of jobs) {
          const job = decode<EntityMetadataJob>(row)!
          this.save({ ...job, state: 'queued', generation: job.generation + 1, updatedAt: now })
        }
      })
    }
  }
  private automatic(job: EntityMetadataJob): (NonNullable<EntityMetadataWork['automatic']> & { live: boolean }) | undefined {
    if (job.requeryConsumers?.length && this.requeryConsumerValid(job)) return undefined
    if (!['identify', 'enrich'].includes(job.type) ||
      !this.sql.prepare('SELECT 1 FROM metadata_demands WHERE job_id=? LIMIT 1').get(job.id) ||
      (!job.requeryConsumers?.length && this.sql.prepare(`SELECT 1 FROM metadata_demands d WHERE d.job_id=? AND NOT EXISTS(
        SELECT 1 FROM metadata_identification_schedule a WHERE a.demand_id=d.batch_id) LIMIT 1`).get(job.id))) return undefined
    // A shared target can have many automatic consumers. Test their real links
    // and memberships, not the first consumer or the target UUID as a catalog ID.
    const row = this.sql.prepare(`SELECT count(*) n,coalesce(max(a.origin='new'),0) fresh,
      coalesce(max(e.rowid<=CAST((SELECT value FROM metadata_identification_schedule_state WHERE key='history_horizon') AS INTEGER)),0) historical
      FROM metadata_demands d JOIN metadata_identification_schedule a ON a.demand_id=d.batch_id
      JOIN catalog_entities e ON e.id=a.entity_id
      WHERE d.job_id=? AND (?='identify' AND a.entity_id=? OR ?='enrich' AND EXISTS(
        SELECT 1 FROM metadata_identity_links l WHERE l.entity_id=a.entity_id AND l.target_id=? AND l.state='confirmed'))
      AND EXISTS(SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
        WHERE b.entity_id=a.entity_id AND s.availability<>'missing' AND EXISTS(
          SELECT 1 FROM catalog_memberships m WHERE m.source_id=b.source_id)
        AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
          AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id))))`)
      .get(job.id, job.type, job.entityId, job.type, job.entityId)!
    return { origin: row.fresh ? 'new' : 'history', historical: !!row.historical, live: Number(row.n) > 0 }
  }
  private automaticBlock(job: EntityMetadataJob, request?: IdentificationScheduleRequest): string | null {
    const automatic = this.automatic(job)
    if (!automatic) return null
    if (!automatic.live) return this.pendingAutomaticConsumer(job) ? 'catalog_projection_pending' : 'not_library_member'
    if (!request) return null
    const permitted = request.enabled &&
      (request.newImports && automatic.origin === 'new' || request.history && automatic.historical)
    const provider = job.type === 'identify'
      ? request.providers.some(p => p.id === job.provider && p.matcherVersion === job.identification?.matcherVersion &&
          p.kinds.includes(this.identification.detail(job.entityId).kind))
      : request.enrichment?.language === job.language && request.enrichment.providers.some(p =>
          p.id === job.provider && p.context === (job.providerContext ?? '') && p.kinds.includes(job.entityKind!))
    return permitted && provider ? null : job.type === 'identify' ? 'automatic_identification_disabled' : 'automatic_enrichment_disabled'
  }
  private pendingAutomaticConsumer(job: EntityMetadataJob): boolean {
    // A present local track awaiting projection is not a removed library member.
    // Keep the existing input/membership fences, but defer instead of cancelling
    // permanently when a display-only refresh will leave the input unchanged.
    return !!this.sql.prepare(`SELECT 1 FROM metadata_demands d
      JOIN metadata_identification_schedule a ON a.demand_id=d.batch_id
      JOIN catalog_entity_sources b ON b.entity_id=a.entity_id
      JOIN catalog_sources s ON s.id=b.source_id
      JOIN catalog_memberships m ON m.source_id=s.id
      JOIN tracks t ON t.id=s.track_id JOIN catalog_pending p ON p.track_id=t.id
      WHERE d.job_id=? AND s.provider='local' AND s.availability<>'missing'
      AND (?='identify' AND a.entity_id=? OR ?='enrich' AND EXISTS(
        SELECT 1 FROM metadata_identity_links l WHERE l.entity_id=a.entity_id
          AND l.target_id=? AND l.state='confirmed')) LIMIT 1`)
      .get(job.id, job.type, job.entityId, job.type, job.entityId)
  }
  private requeryBlock(job: EntityMetadataJob, request?: IdentificationScheduleRequest): boolean {
    if (!job.requeryConsumers?.length || this.requeryConsumerValid(job)) return false
    return !this.automatic(job)?.live || !!this.automaticBlock(job, request)
  }
  claim(now: number): EntityMetadataWork | null {
    return this.transaction(() => {
      // Bounded, indexed cache retirement runs even when there are no jobs.
      // Personal overrides and identity mappings are not expiring cache data.
      this.sql.prepare(`DELETE FROM metadata_facts WHERE rowid IN (SELECT rowid FROM metadata_facts
        WHERE json_extract(payload,'$.usage.expiresAt')<=? LIMIT 100)`).run(now)
      const turn = Number(this.sql.prepare("SELECT value FROM metadata_identification_schedule_state WHERE key='claim_turn'").get()?.value ?? 0)
      // A requested profile refresh must not sit behind a library-wide identity
      // backlog. Keep FIFO within updates and the existing fourth-turn fairness.
      for (let checked = 0; checked < 100; checked++) {
        const row = this.sql
          .prepare(
            `SELECT * FROM metadata_jobs j WHERE state IN ('queued','retry_wait') AND next_attempt<=?
            AND (json_extract(payload,'$.type')<>'legacy' OR EXISTS(SELECT 1 FROM metadata_legacy_batches b
              WHERE b.id=json_extract(j.payload,'$.legacy.batchId') AND b.state='published'))
            ORDER BY CASE WHEN ?%4=3 AND next_attempt<=?-60000 AND
              NOT EXISTS(SELECT 1 FROM metadata_demands d WHERE d.job_id=j.id AND NOT EXISTS(SELECT 1 FROM metadata_identification_schedule a WHERE a.demand_id=d.batch_id)) THEN 0
              WHEN EXISTS(SELECT 1 FROM metadata_demands d WHERE d.job_id=j.id AND NOT EXISTS(SELECT 1 FROM metadata_identification_schedule a WHERE a.demand_id=d.batch_id)) THEN 1 ELSE 2 END,
              CASE WHEN json_extract(payload,'$.type')='enrich' AND EXISTS(SELECT 1 FROM metadata_demands d WHERE d.job_id=j.id AND NOT EXISTS(SELECT 1 FROM metadata_identification_schedule a WHERE a.demand_id=d.batch_id)) THEN 0 ELSE 1 END,
              CASE WHEN EXISTS(SELECT 1 FROM metadata_demands d WHERE d.job_id=j.id AND NOT EXISTS(SELECT 1 FROM metadata_identification_schedule a WHERE a.demand_id=d.batch_id)) THEN 0
                WHEN EXISTS(SELECT 1 FROM metadata_demands d JOIN metadata_identification_schedule s ON s.demand_id=d.batch_id WHERE d.job_id=j.id AND s.origin='new') THEN 0 ELSE 1 END,
              CASE WHEN json_extract(payload,'$.type')='enrich' THEN 0
                WHEN json_extract(payload,'$.provider')='platform.ncm' THEN 1 ELSE 2 END,
              CASE WHEN json_extract(payload,'$.type')='enrich' OR EXISTS(SELECT 1 FROM metadata_demands d WHERE d.job_id=j.id AND NOT EXISTS(SELECT 1 FROM metadata_identification_schedule a WHERE a.demand_id=d.batch_id)) THEN 0
                ELSE CASE coalesce(json_extract(payload,'$.entityKind'),(SELECT kind FROM catalog_entities e WHERE e.id=j.entity_id)) WHEN 'album_project' THEN 0 WHEN 'release' THEN 1 ELSE 2 END END,
              next_attempt,rowid LIMIT 1`
          )
          .get(now, turn, now) as Row | undefined
        if (!row) return null
        const previous = decode<EntityMetadataJob>(row)!
        if (previous.type === 'legacy' && !this.legacy.valid(String(row.input))) {
          this.save({ ...previous, state: 'cancelled', generation: previous.generation + 1, reason: 'input_changed', updatedAt: now })
          continue
        }
        const configuration = this.sql.prepare("SELECT value FROM metadata_identification_schedule_state WHERE key='configuration'").get()?.value
        const automaticBlock = this.automaticBlock(previous, configuration ? JSON.parse(String(configuration)) : undefined)
        if (automaticBlock === 'catalog_projection_pending') {
          this.save({ ...previous, nextAttemptAt: now + 100, updatedAt: now })
          continue
        }
        if (this.requeryBlock(previous, configuration ? JSON.parse(String(configuration)) : undefined)) {
          this.save({ ...previous, state: 'cancelled', generation: previous.generation + 1, reason: 'input_changed', updatedAt: now })
          continue
        }
        if (automaticBlock) {
          this.save({ ...previous, state: automaticBlock === 'not_library_member' ? 'cancelled' : 'blocked',
            generation: previous.generation + 1, reason: automaticBlock, updatedAt: now })
          continue
        }
        let identification
        if (previous.type === 'identify') {
          try {
            identification = this.identification.input(previous.entityId)
            if (!identification.sources?.length ||
              JSON.stringify([identification.version, identification.linkRevision]) !== String(row.input)) throw stale()
          } catch {
            this.save({ ...previous, state: 'cancelled', generation: previous.generation + 1, reason: 'input_changed', updatedAt: now })
            continue
          }
        }
        const job = {
          ...previous,
          state: 'running' as const,
          attempts: previous.attempts + 1,
          updatedAt: now
        }
        this.save(job)
          this.sql.prepare("INSERT INTO metadata_identification_schedule_state VALUES('claim_turn',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(turn + 1))
          return { job, input: String(row.input), automatic: this.automatic(job), ...(job.type === 'legacy' ? { legacy: this.legacy.work(String(row.input)) } : {}), ...(identification ? { identification,
          identificationMembers: this.identification.albumMemberSnapshot(identification) } : {}) }
      }
      return null
    })
  }
  nextAttempt(): number | null {
    const row = this.sql
      .prepare(
        `SELECT min(next_attempt) AS due FROM metadata_jobs j WHERE state IN ('queued','retry_wait')
          AND (json_extract(payload,'$.type')<>'legacy' OR EXISTS(SELECT 1 FROM metadata_legacy_batches b
            WHERE b.id=json_extract(j.payload,'$.legacy.batchId') AND b.state='published'))`
      )
      .get() as Row
    const expiry = this.sql.prepare(`SELECT min(json_extract(payload,'$.usage.expiresAt')) due
      FROM metadata_facts WHERE json_extract(payload,'$.usage.expiresAt') IS NOT NULL`).get() as Row
    const due = [row.due, expiry.due].filter(v => v !== null).map(Number)
    return due.length ? Math.min(...due) : null
  }
  finish(work: EntityMetadataWork, result: EntityMetadataResult, now: number,
    automation?: IdentificationScheduleRequest) {
    return this.transaction(() => {
      const job = decode<EntityMetadataJob>(
        this.sql.prepare('SELECT payload FROM metadata_jobs WHERE id=?').get(work.job.id) as
          | Row
          | undefined
      )
      if (!job || job.state !== 'running' || job.generation !== work.job.generation) return false
      const automaticBlock = this.automaticBlock(job, automation)
      if (automaticBlock === 'catalog_projection_pending') {
        this.save({ ...job, state: 'queued', generation: job.generation + 1,
          attempts: Math.max(0, job.attempts - 1), nextAttemptAt: now + 100,
          reason: null, updatedAt: now })
        return false
      }
      if (this.requeryBlock(job, automation)) {
        this.save({ ...job, state: 'cancelled', generation: job.generation + 1, reason: 'input_changed', updatedAt: now })
        return false
      }
      if (job.type === 'legacy') {
        if (!work.legacy || !this.legacy.valid(work.input)) {
          this.save({ ...job, state: 'cancelled', generation: job.generation + 1, reason: 'input_changed', updatedAt: now })
          return false
        }
        if (result.state === 'legacy_result') {
          this.legacy.apply(work, result)
          this.save({ ...job, state: result.taskState, outcome: result.outcome, reason: result.reason,
            nextAttemptAt: result.nextAttemptAt ?? now, updatedAt: now })
          this.legacy.settled(work, result.taskState, result.reason, result.nextAttemptAt, now)
        } else if (['blocked','failed','retry_wait'].includes(result.state)) {
          this.save({ ...job, state: result.state as 'blocked' | 'failed' | 'retry_wait', reason: 'reason' in result ? result.reason ?? null : null,
            nextAttemptAt: result.state === 'retry_wait' ? result.nextAttemptAt ?? now : now, updatedAt: now })
          this.legacy.settled(work, result.state, 'reason' in result ? result.reason ?? null : null,
            result.state === 'retry_wait' ? result.nextAttemptAt : undefined, now)
        } else throw new Error('Legacy tasks require a source-scoped result')
        return true
      }
      if (result.state === 'legacy_result') throw new Error('Invalid legacy result target')
      if (automaticBlock) result = { state: 'blocked', reason: automaticBlock }
      let current = ''
      try {
        current = this.input(job.entityId, job.type)
      } catch {
        /* removed or no longer active */
      }
      if (current !== work.input) {
        this.save({
          ...job,
          state: 'cancelled',
          generation: job.generation + 1,
          reason: 'input_changed',
          updatedAt: now
        })
        return false
      }
      if (result.state === 'identified') {
        if (job.type !== 'identify' || !job.identification || !work.identification ||
          JSON.stringify([work.identification.version, work.identification.linkRevision]) !== work.input)
          throw new Error('Invalid identification result')
        if (typeof result.incomplete !== 'boolean' || result.proposals.some(p => p.matcherVersion !== job.identification!.matcherVersion) ||
          result.reasons.length > 64 || result.reasons.some(r => typeof r !== 'string' || r.length > 2048))
          throw new Error('Invalid identification reasons')
        const candidates = this.identification.publish(work.identification, result.proposals, now)
        const confirmed = this.identification.confirmVerified(work.identification, candidates,
          !result.incomplete, job.provider, now)
        const members = confirmed ? this.identification.confirmAlbumMembers(work.identification, candidates,
          work.identificationMembers, now) : undefined
        this.save({ ...job,
          state: !confirmed && candidates.some(c => c.state === 'candidate') ? 'needs_review' : 'completed',
          outcome: result.incomplete ? 'partial' : candidates.length ? 'matched' : 'not_found',
          reason: confirmed ? 'identity_confirmed_automatically' : null, updatedAt: now, nextAttemptAt: now,
          identification: { ...job.identification, candidateIds: candidates.map(c => c.id), incomplete: result.incomplete, reasons: result.reasons,
            ...(members ? { members, membersTruncated: work.identificationMembers!.truncated } : {}) }
        })
        return true
      }
      if (job.type === 'identify' && ['completed', 'needs_review'].includes(result.state))
        throw new Error('Identification tasks require a recall result')
      if (result.state === 'completed') {
        if (result.facts.length > 32) throw new Error('Too many metadata facts')
        for (const fact of result.facts)
          this.sql
            .prepare('INSERT OR REPLACE INTO metadata_facts VALUES(?,?,?,?,?)')
            .run(
              job.entityId,
              fact.attribution.provider,
              fact.field,
              fact.language,
              JSON.stringify(fact)
            )
        if (result.credits) {
          if (result.credits.items.length > 2048) throw new Error('Too many metadata credits')
          this.sql.prepare(`INSERT INTO metadata_credit_sets VALUES(?,?,1,?) ON CONFLICT(target_id,provider)
            DO UPDATE SET revision=revision+1,truncated=excluded.truncated`).run(job.entityId, job.provider, result.credits.truncated ? 1 : 0)
          this.sql.prepare('DELETE FROM metadata_credits WHERE target_id=? AND provider=?').run(job.entityId, job.provider)
          const put = this.sql.prepare('INSERT INTO metadata_credits VALUES(?,?,?,?)')
          result.credits.items.forEach((credit, position) => put.run(job.entityId, job.provider, position, JSON.stringify(credit)))
          this.owner.exploration?.().syncCredits({ targetId: job.entityId, provider: job.provider })
        }
        if (result.exploration) {
          if (job.provider !== 'musicbrainz-details' || result.exploration.provider !== job.provider ||
              result.exploration.owner.value !== job.externalId || result.exploration.owner.kind !== job.entityKind)
            throw new Error('Invalid exploration metadata owner')
          this.owner.exploration?.().ingest(result.exploration)
        }
        if (result.artwork?.length) {
          if (result.artwork.length > 3 || (job.provider !== 'public-artwork' && !isPublicMetadataSource(job.provider) && !job.provider.startsWith('platform.')) ||
            result.artwork.some(image => image.providerContext !== job.providerContext ||
              (job.provider.startsWith('platform.') && (image.scope !== job.entityKind ||
                image.targetRef?.provider !== job.provider.slice(9) || image.targetRef.kind !== job.entityKind ||
                image.targetRef.idType !== 'native' || image.targetRef.value !== image.targetId ||
                image.attribution.provider !== job.provider || image.attribution.externalId !== image.targetId)) ||
              (isPublicMetadataSource(job.provider) && (image.scope !== job.entityKind || image.targetRef?.provider !== job.provider ||
                image.targetRef.value !== image.targetId)))) throw new Error('Invalid artwork result')
          // Replace this adapter's successful selection. Empty/missing images do
          // not clear old permitted resources, embedded art or personal choices.
          this.sql.prepare("DELETE FROM metadata_facts WHERE target_id=? AND provider=? AND field='artwork'").run(job.entityId, job.provider)
          const put = this.sql.prepare('INSERT INTO metadata_facts VALUES(?,?,?,?,?)')
          result.artwork.forEach(image => put.run(job.entityId, job.provider, 'artwork', image.scope, JSON.stringify(image)))
        }
      }
      const candidateId = result.state === 'needs_review' && result.candidate
        ? this.identification.legacyCandidate(job.entityId, result.candidate, now).id
        : undefined
      this.save({
        ...job,
        state: result.state,
        candidate: result.state === 'needs_review' ? result.candidate : null,
        candidateId,
        outcome: result.state === 'completed' ? result.outcome : null,
        reason: 'reason' in result ? (result.reason ?? null) : null,
        nextAttemptAt: result.state === 'retry_wait' ? (result.nextAttemptAt ?? now) : now,
        updatedAt: now
      })
      return true
    })
  }
}
