import type {
  EntityMetadataDatabaseApi,
  EntityMetadataDecision,
  EntityMetadataDemand,
  EntityMetadataJobsQuery,
  EntityMetadataLanguage,
  EntityMetadataOverride,
  EntityMetadataSourcePreference,
  EntityMetadataArtworkOverride,
  EntityMetadataPolicy,
  EntityMetadataPolicyView,
  EntityMetadataResolve,
  EntityMetadataResult,
  EntityMetadataWork
} from '../../shared/entityMetadata.ts'
import {
  MetadataIdentityError,
  metadataPolicyView,
  type MetadataProvider
} from './entityMetadataProvider.ts'
import { MetadataHttpError } from './metadataHttp.ts'
import { isPublicMetadataSource, metadataIdentityProvider, metadataProviderReference } from '../../shared/metadataProviders.ts'
import type { IdentificationCandidatesQuery, IdentificationReview, IdentificationDecision, IdentificationStart } from '../../shared/musicIdentification.ts'
import type { IdentificationProvider } from './musicIdentificationProvider.ts'
import type { MusicIdentificationSettings, IdentificationScheduleRequest } from '../../shared/musicIdentificationSchedule.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
import type { MusicCreditsQuery } from '../../shared/musicCredits.ts'
import type { MetadataTasksQuery, MetadataTaskDemandsQuery } from '../../shared/entityMetadataTasks.ts'
import type { MetadataArtworkRecord, MusicArtwork } from '../../shared/musicArtwork.ts'
import type { LegacyMusicLookup, LegacyMusicTaskSeed, LegacyMusicTaskWork } from '../../shared/legacyMusicTasks.ts'

export interface EntityMetadataOptions {
  database: EntityMetadataDatabaseApi
  /** One bounded database request per batch; other library work can interleave. */
  backfillCredits?(): Promise<{ processed: number; pending: boolean }>
  provider: MetadataProvider
  identificationProviders?(): IdentificationProvider[]
  enrichmentProviders?(): MetadataDetailProvider[]
  artwork?(image: MetadataArtworkRecord): Promise<string | null>
  automation?(): MusicIdentificationSettings
  language?(): EntityMetadataLanguage
  policy(): EntityMetadataPolicy
  now(): number
  changed(): void
  failed(error: unknown): void
  taskFailed?(error: unknown, task: { type: string; provider: string }): void
  legacy?(): {
    blockedReason(work: LegacyMusicTaskWork): Promise<string | null>
    lookup(work: LegacyMusicTaskWork, attempts: number, signal: AbortSignal): Promise<Extract<EntityMetadataResult, { state: 'legacy_result' }>>
  }
}
/** Owned by CoreMetadataService, never by a renderer subscription. */
export class CoreEntityMetadataService {
  private started = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private task: Promise<void> | null = null
  private ready: Promise<void> = Promise.resolve()
  private pending = new Set<Promise<unknown>>()
  private active: { id: string; controller: AbortController; automatic: boolean; provider?: string; batchId?: string } | null = null
  private dirty = false
  private needsRecovery = false
  private recoveryDelay = 1000
  private readonly options: EntityMetadataOptions
  private schedulePending = true
  private revision = 0
  private contentRevision = 0
  constructor(options: EntityMetadataOptions) {
    this.options = options
  }
  private notifyChanged(contentChanged = false) {
    this.revision++
    if (contentChanged) this.contentRevision++
    this.options.changed()
  }
  getRevision() { return this.revision }
  /** Task queue progress does not invalidate already displayed music metadata. */
  getContentRevision() { return this.contentRevision }
  policy(): EntityMetadataPolicyView {
    const policy = metadataPolicyView(this.options.policy())
    const providers = this.options.enrichmentProviders?.()
    const artwork = providers?.find((p) => p.id === 'public-artwork')
    const identification = this.options.identificationProviders?.() ?? []
    const sourceId = (id: string) =>
      ['musicbrainz-details', 'public-artwork'].includes(id) ? 'musicbrainz' : id
    const kinds = ['artist', 'recording', 'album_project', 'release'] as const
    const sourceIds = new Set([
      ...identification.map((p) => p.id),
      ...(providers ?? []).map((p) => sourceId(p.id))
    ])
    const sources = [...sourceIds].map((id) => ({
      provider: id,
      identification: identification.filter((p) => p.id === id).flatMap((p) =>
        kinds.filter((k) => p.supports(k)).map((kind) => ({
          kind, reason: !policy.enabled ? 'metadata_disabled' : p.blockedReason(kind)
        }))
      ),
      enrichment: (providers ?? []).filter((p) => sourceId(p.id) === id).flatMap((p) =>
        kinds.filter((k) => p.supports(k)).map((kind) => ({
          provider: p.id, kind, reason: !policy.enabled ? 'metadata_disabled' : p.blockedReason(kind)
        }))
      )
    }))
    return {
      ...policy, sources,
      ...(artwork ? {
        artwork: (['artist', 'release', 'album_project'] as const).map((kind) => ({
          kind, reason: artwork.blockedReason(kind)
        }))
      } : {}),
      ...(providers ? {
        platforms: providers.filter((p) => p.id.startsWith('platform.')).map((provider) => ({
          provider: provider.id,
          kinds: (['artist', 'release'] as const).map((kind) => ({
            kind, reason: !policy.enabled ? 'metadata_disabled' : provider.blockedReason(kind)
          }))
        }))
      } : {})
    }
  }
  activate() {
    if (this.started || this.stopped) return
    this.started = true
    this.ready = this.recover().catch(error => {
      this.needsRecovery = true
      this.options.failed(error)
    })
    void this.ready.then(() => this.wake()).catch(this.options.failed)
  }
  private async recover() {
    await this.options.database.metadataRecover(this.options.now())
    if (this.options.backfillCredits) {
      let pending = true
      while (pending && !this.stopped) pending = (await this.options.backfillCredits()).pending
    }
  }
  private request<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Core metadata service stopped'))
    const task = this.ready.then(action)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => {})
    return task
  }
  platformContexts(): Record<string, string> {
    return Object.fromEntries((this.options.enrichmentProviders?.() ?? [])
        .filter(p => p.id.startsWith('platform.')
          ? !p.blockedReason('artist') || !p.blockedReason('release')
          : isPublicMetadataSource(p.id) &&
          ['artist', 'release', 'album_project'].some(kind => p.supports(kind as 'artist') && !p.blockedReason(kind as 'artist')) && this.options.policy().enabled)
        .map(p => [metadataIdentityProvider(p.id)!, p.context()]))
  }
  private artworkContexts() {
    return Object.fromEntries((this.options.enrichmentProviders?.() ?? []).filter(p =>
      p.id === 'public-artwork' || (isPublicMetadataSource(p.id) ||
        (p.id.startsWith('platform.') && (['artist', 'release'] as const).some(kind => p.supportsArtwork?.(kind)))) && this.options.policy().enabled &&
      (['artist', 'release', 'album_project'] as const).some(kind => p.supports(kind) && !p.blockedReason(kind)))
      .map(p => [p.id, p.context()]))
  }
  detail(entityId: string, language: EntityMetadataLanguage, sourceProvider?: string, includeAutomaticArtwork = false) {
    return this.request(async () => {
      const platformContexts = this.platformContexts()
      const artworkContexts = this.artworkContexts()
      const detail = await this.options.database.metadataDetail(entityId, language, { sourceProvider, platformContexts, now: this.options.now() })
      const assertContext = () => {
        if (JSON.stringify(platformContexts) !== JSON.stringify(this.platformContexts()) ||
          JSON.stringify(artworkContexts) !== JSON.stringify(this.artworkContexts()) ||
          detail.facts.some(f => f.usage?.expiresAt !== undefined && f.usage.expiresAt <= this.options.now()))
          throw Object.assign(new Error('资料授权或有效期已变化，请重新读取'), { code: 'STALE_REVISION' })
      }
      assertContext()
      // User bitmaps and an explicit clear do not depend on public-service deployment or identity.
      // Collection views may share automatic art without sharing this source's
      // personal choice. Ordinary callers keep the original override-only read.
      if (detail.artworkOverride && !includeAutomaticArtwork) return detail
      if (!Object.keys(artworkContexts).length || !this.options.artwork) return detail
      if (!detail.targetId) return detail
      const images = await this.options.database.metadataArtwork(entityId, { artworkContexts,
        artworkTargetId: detail.targetId, artworkRevision: detail.revision, now: this.options.now() })
      const artwork: MusicArtwork[] = []
      for (const image of images) {
        const providerId = image.attribution.provider.startsWith('platform.') ? image.attribution.provider :
          image.targetRef && isPublicMetadataSource(image.targetRef.provider) ? image.targetRef.provider : 'public-artwork'
        const provider = this.options.enrichmentProviders?.().find(p => p.id === providerId)
        if (!provider || provider.blockedReason(image.scope)) continue
        const handle = await this.options.artwork(image)
        if (handle) {
          artwork.push({ scope: image.scope, targetRef: image.targetRef ?? { provider: 'musicbrainz', kind: image.scope, idType: 'mbid', value: image.targetId }, attribution: image.attribution, usage: image.usage,
            ...(image.sourceReleaseId ? { sourceReleaseId: image.sourceReleaseId } : {}), handle })
        }
      }
      // Materializing a portrait can download its bitmap. Recheck this source,
      // not the global content revision: another artist's completion is harmless,
      // but a detach, replacement or personal edit must fence the late image.
      const current = await this.options.database.metadataDetail(entityId, language, {
        sourceProvider, platformContexts, now: this.options.now()
      })
      if (current.targetId !== detail.targetId || current.revision !== detail.revision ||
        current.link?.state !== detail.link?.state)
        throw Object.assign(new Error('音乐身份或资料已变化，请重新读取'), { code: 'STALE_IDENTITY' })
      assertContext()
      if (artwork.some(image => image.usage.expiresAt !== undefined && image.usage.expiresAt <= this.options.now()))
        throw Object.assign(new Error('图片授权已过期，请重新读取'), { code: 'STALE_REVISION' })
      return { ...current, ...(artwork.length ? { artwork } : {}) }
    })
  }
  jobs(query: EntityMetadataJobsQuery) {
    return this.request(() => this.options.database.metadataJobs(query))
  }
  tasks(query: MetadataTasksQuery) {
    return this.request(() => this.options.database.metadataTasks(query))
  }
  demands(query: MetadataTaskDemandsQuery) {
    return this.request(() => this.options.database.metadataTaskDemands(query))
  }
  taskSources(query: import('../../shared/entityMetadataTasks.ts').MetadataTaskSourcesQuery) {
    return this.request(() => this.options.database.metadataTaskSources(query))
  }
  requery(request: import('../../shared/entityMetadataTasks.ts').MetadataTaskRequery) {
    return this.request(async () => {
      const contexts: Record<string, string> = {}
      for (const item of request.items) {
        const job = (await this.options.database.metadataJobs({ jobId: item.jobId })).items[0]
        if (!job || job.type !== 'enrich' || job.generation !== item.generation) throw new Error('任务已变化，请重新读取')
        if (job.provider === 'musicbrainz-wiki') {
          if (!this.policy().identity) throw new Error(this.policy().reason ?? '资料源不可用')
        } else {
          const provider = this.options.enrichmentProviders?.().find(p => p.id === job.provider && p.supports(job.entityKind!))
          const reason = !this.options.policy().enabled ? 'metadata_disabled' :
            !provider ? 'provider_not_available' : provider.blockedReason(job.entityKind!)
          if (reason) throw new Error(reason)
          contexts[job.provider] = provider!.context()
        }
      }
      try {
        const result = await this.options.database.metadataRequery(request, contexts, this.options.now())
        this.notifyChanged()
        this.wake()
        return { batchId: result.batchId, count: result.jobs.length }
      } catch (error) {
        this.needsRecovery = true
        this.wake()
        throw error
      }
    })
  }
  startLegacyMusic(pluginId: string, operation: LegacyMusicLookup, documentRevision: number, entries: LegacyMusicTaskSeed[]) {
    return this.request(async () => {
      const id = globalThis.crypto.randomUUID(), database = this.options.database
      try {
        const batch = await database.legacyMusicBatchBegin({ id, pluginId, operation, expected: entries.length, documentRevision }, this.options.now())
        if (batch.batchId !== id) return batch
        for (let offset = 0; offset < entries.length; offset += 50) {
          if (this.stopped) throw new Error('Core metadata service stopped')
          await database.legacyMusicBatchStage(id, entries.slice(offset, offset + 50), this.options.now())
        }
        const result = await database.legacyMusicBatchPublish(id, this.options.now())
        this.notifyChanged()
        this.wake()
        return result
      } catch (error) {
        // A committed publication may have lost its acknowledgement. Recover
        // stored work; do not replay the source snapshots or start a second batch.
        this.needsRecovery = true
        this.wake()
        throw error
      }
    })
  }
  legacyMusicStatus(pluginId: string) {
    return this.request(async () => Object.fromEntries(await Promise.all(
      (['introductions','credits','enrich'] as const).map(async operation =>
        [operation, await this.options.database.legacyMusicTaskStatus(pluginId, operation)] as const)
    )))
  }
  cancelLegacyMusic(pluginId: string, operation: LegacyMusicLookup) {
    return this.request(async () => {
      const result = await this.options.database.legacyMusicBatchCancel(pluginId, operation, this.options.now())
      if (result?.batchId === this.active?.batchId) this.active?.controller.abort(new Error('Legacy batch cancelled'))
      this.notifyChanged()
      this.wake()
      return result
    })
  }
  credits(query: MusicCreditsQuery) {
    return this.request(() => this.options.database.metadataCredits(query))
  }
  identity(entityId: string) {
    return this.request(() => this.options.database.identificationDetail(entityId))
  }
  /** Internal health read: inspect permitted stored artwork without downloading bitmaps. */
  inspectHealth(entityId: string, language: EntityMetadataLanguage) {
    return this.request(async () => {
      const database = this.options.database, policy = this.policy()
      const identity = await database.identificationDetail(entityId)
      const detail = await database.metadataDetail(entityId, language, {
        platformContexts: this.platformContexts(), now: this.options.now()
      })
      const candidates = await database.identificationCandidates({ entityId, state: 'candidate', limit: 100 })
      if ((identity.link?.targetId ?? null) !== detail.targetId)
        throw Object.assign(new Error('音乐身份已变化，请重新体检'), { code: 'STALE_REVISION' })
      const potentialProviders = (this.options.enrichmentProviders?.() ?? []).filter(p => p.supports(identity.kind))
      const providers = potentialProviders.filter(p => metadataProviderReference(p.id, identity.kind, identity.references))
      const identifiers = (this.options.identificationProviders?.() ?? []).filter(p => p.supports(identity.kind))
      const jobs: import('../../shared/entityMetadata.ts').EntityMetadataJob[] = []
      for (let offset = 0; ; offset += 100) {
        const page = await database.metadataJobs({ entityId, offset, limit: 100 })
        jobs.push(...page.items.filter(job => job.type === 'identify'
          ? identifiers.some(p => p.id === job.provider && p.matcherVersion === job.identification?.matcherVersion)
          : job.type === 'enrich' && job.language === language && providers.some(p =>
            p.id === job.provider && p.context() === job.providerContext &&
              metadataProviderReference(p.id, identity.kind, identity.references)?.value === job.externalId)))
        if (offset + page.items.length >= page.total) break
      }
      const images = policy.enabled ? await database.metadataArtwork(entityId, { artworkContexts: this.artworkContexts(),
          artworkTargetId: detail.targetId, artworkRevision: detail.revision, now: this.options.now() }) : []
      return { identity, detail, jobs, hasArtwork: images.length > 0,
        needsReview: candidates.items.some(c => !c.suppressed && c.linkRevision === (identity.link?.revision ?? 0)),
        potentialEnrichment: potentialProviders.map(p => ({ id: p.id, reason: !policy.enabled ? 'metadata_disabled' : p.blockedReason(identity.kind),
          ...(p.supportsArtwork?.(identity.kind) ? { artwork: true as const } : {}) })),
        identification: identifiers.map(p => ({ id: p.id, reason: !policy.enabled ? 'metadata_disabled' : p.blockedReason(identity.kind) })),
        enrichment: providers.map(p => ({ id: p.id, reason: !policy.enabled ? 'metadata_disabled' : p.blockedReason(identity.kind),
          ...(p.supportsArtwork?.(identity.kind) ? { artwork: true as const } : {}) })) }
    })
  }
  identificationStatus() {
    return this.request(() => this.options.database.identificationScheduleStatus())
  }
  refreshIdentification(cancelAutomatic = false, changedProvider?: string) {
    this.schedulePending = true
    // Account/permission changes also invalidate text already visible in an open page.
    this.notifyChanged(true)
    if (this.active && ((cancelAutomatic && this.active.automatic) ||
      (!!changedProvider && changedProvider === this.active.provider))) {
      this.needsRecovery = true
      this.active.controller.abort(new Error('Identification configuration changed'))
    }
    this.wake()
  }
  private automation(): IdentificationScheduleRequest | undefined {
    const settings = this.options.automation?.()
    if (!settings) return undefined
    return {
      enabled: this.options.policy().enabled && settings.setup !== 'pending',
      newImports: settings.newImports, history: settings.history,
      providers: (this.options.identificationProviders?.() ?? []).filter(p => settings.sources.includes(p.id)).map(p => ({
        id: p.id, matcherVersion: p.matcherVersion,
        kinds: (['album_project','release','recording','artist'] as const).filter(k => p.supports(k) && !p.blockedReason(k))
      })).filter(p => p.kinds.length > 0).sort((a,b) => a.id.localeCompare(b.id)),
      enrichment: {
        language: settings.language ?? this.options.language?.() ?? 'zh-Hans',
        providers: (this.options.enrichmentProviders?.() ?? []).filter(p => settings.sources.includes(
          ['musicbrainz-details', 'public-artwork'].includes(p.id) ? 'musicbrainz' : p.id
        )).flatMap(p => {
          const kinds = (['album_project', 'release', 'recording', 'artist'] as const).filter(k => p.supports(k) && !p.blockedReason(k))
          return kinds.length ? [{ id: p.id, kinds, context: p.context() }] : []
        }).sort((a,b) => a.id.localeCompare(b.id))
      }
    }
  }
  startIdentification(request: IdentificationStart, providerIds?: readonly string[]) {
    return this.request(async () => {
      const input = await this.options.database.identificationInput(request.entityId)
      const providers = (this.options.identificationProviders?.() ?? []).filter(p => p.supports(input.kind) &&
        (!providerIds || providerIds.includes(p.id)))
      if (!providers.length) throw new Error('当前实体没有可用的识别适配器')
      let jobs
      try {
        jobs = await this.options.database.identificationEnqueue({ ...request,
          providers: providers.map(p => ({ id: p.id, matcherVersion: p.matcherVersion }))
        }, this.options.now())
      } catch (error) {
        // An enqueue acknowledgement can be lost after commit. Reconcile stored
        // work, never replay the mutation or manufacture a successful response.
        this.needsRecovery = true
        this.wake()
        throw error
      }
      this.notifyChanged()
      this.wake()
      return { batchId: request.batchId, jobs }
    })
  }
  candidates(query: IdentificationCandidatesQuery) {
    return this.request(() => this.options.database.identificationCandidates(query))
  }
  inbox(query: import('../../shared/musicIdentification.ts').IdentificationInboxQuery) {
    return this.request(() => this.options.database.identificationInbox(query))
  }
  history(query: import('../../shared/musicIdentification.ts').IdentificationHistoryQuery) {
    return this.request(() => this.options.database.identificationHistory(query))
  }
  restorePreview(request: import('../../shared/musicIdentification.ts').IdentificationHistoryReview) {
    return this.request(() => this.options.database.identificationRestorePreview(request))
  }
  restoreIdentity(request: import('../../shared/musicIdentification.ts').IdentificationHistoryReview) {
    return this.request(async () => {
      const result = await this.options.database.identificationRestore(request, this.options.now())
      this.notifyChanged(true)
      this.refreshIdentification()
      return result
    })
  }
  preview(request: IdentificationReview) {
    return this.request(() => this.options.database.identificationPreview(request))
  }
  decideIdentity(request: IdentificationDecision) {
    return this.request(async () => {
      const result = await this.options.database.identificationDecide(request, this.options.now())
      this.notifyChanged(true)
      this.refreshIdentification()
      return result
    })
  }
  detachIdentity(linkId: string, revision: number) {
    return this.request(async () => {
      const result = await this.options.database.identificationDetach(linkId, revision, this.options.now())
      this.notifyChanged(true)
      this.refreshIdentification()
      return result
    })
  }
  resolve(request: EntityMetadataResolve) {
    return this.enqueue({ ...request, type: 'resolve' })
  }
  enrich(request: EntityMetadataDemand) {
    if (request.provider) return this.request(async () => {
      const identity = await this.options.database.identificationDetail(request.entityId)
      const provider = this.options.enrichmentProviders?.().find(p => p.id === request.provider && p.supports(identity.kind))
      if (!provider) throw new Error('当前实体没有该资料适配器')
      const job = await this.options.database.metadataEnqueue({ ...request, type: 'enrich', providerContext: provider.context() }, this.options.now())
      this.notifyChanged()
      this.wake()
      return job
    })
    return this.enqueue({ ...request, type: 'enrich' })
  }
  private enqueue(request: EntityMetadataDemand & { type: 'resolve' | 'enrich'; mbid?: string }) {
    return this.request(async () => {
      const job = await this.options.database.metadataEnqueue(request, this.options.now())
      this.notifyChanged()
      this.wake()
      return job
    })
  }
  decide(request: EntityMetadataDecision) {
    return this.request(async () => {
      const result = await this.options.database.metadataDecide(request, this.options.now())
      this.notifyChanged(true)
      this.refreshIdentification()
      return result
    })
  }
  detach(entityId: string, revision: number) {
    return this.request(async () => {
      const result = await this.options.database.metadataDetach(
        entityId,
        revision,
        this.options.now()
      )
      this.notifyChanged(true)
      this.refreshIdentification()
      return result
    })
  }
  override(request: EntityMetadataOverride) {
    return this.request(async () => {
      const result = await this.options.database.metadataOverride(request, this.options.now())
      this.notifyChanged(true)
      return result
    })
  }
  sourcePreference(request: EntityMetadataSourcePreference) {
    return this.request(async () => {
      const result = await this.options.database.metadataSourcePreference(request, this.options.now())
      this.notifyChanged(true)
      return result
    })
  }
  artworkOverride(request: EntityMetadataArtworkOverride) {
    return this.request(async () => {
      const result = await this.options.database.metadataArtworkOverride(request, this.options.now())
      this.notifyChanged(true)
      return result
    })
  }
  cancel(jobId: string, batchId: string, generation?: number) {
    return this.request(async () => {
      const removed = await this.options.database.metadataCancel(jobId, batchId, this.options.now(), generation)
      const job = (await this.options.database.metadataJobs({ jobId })).items[0]
      if (job?.state === 'cancelled' && this.active?.id === jobId)
        this.active.controller.abort(new Error('Metadata demand cancelled'))
      this.notifyChanged()
      return removed
    })
  }
  private wake() {
    if (!this.started || this.stopped) return
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.task) return
    this.task = this.run()
      .catch(error => {
        this.active?.controller.abort(new Error('Metadata database reconciliation'))
        this.active = null
        this.needsRecovery = true
        this.schedulePending = true
        this.dirty = false
        if (!this.stopped) {
          this.timer = setTimeout(() => {
            this.timer = null
            this.wake()
          }, this.recoveryDelay)
          this.timer.unref?.()
          this.recoveryDelay = Math.min(30000, this.recoveryDelay * 2)
        }
        this.options.failed(error)
      })
      .finally(() => {
        this.task = null
        if (this.dirty && !this.stopped) this.wake()
      })
  }
  private identificationBlock(work: EntityMetadataWork, provider: IdentificationProvider | undefined) {
    if (!this.options.policy().enabled) return 'metadata_disabled'
    if (!provider) return 'provider_not_available'
    if (!work.identification) return 'identification_input_missing'
    if (provider.matcherVersion !== work.job.identification?.matcherVersion) return 'matcher_version_changed'
    if (work.automatic) {
      const automatic = this.automation()
      if (!automatic?.enabled || !(automatic.newImports && work.automatic.origin === 'new' || automatic.history && work.automatic.historical) ||
        !automatic.providers.some(p => p.id === provider.id && p.kinds.includes(work.identification!.kind)))
        return 'automatic_identification_disabled'
    }
    return provider.blockedReason(work.identification.kind)
  }
  private enrichmentBlock(work: EntityMetadataWork, provider: MetadataDetailProvider | undefined, checkAutomatic: boolean) {
    if (!this.options.policy().enabled) return 'metadata_disabled'
    if (!provider) return 'provider_not_available'
    if ((checkAutomatic && work.automatic || work.job.requeryConsumers?.length) &&
      work.job.providerContext !== undefined && work.job.providerContext !== provider.context())
      return 'provider_configuration_changed'
    if (checkAutomatic && work.automatic) {
      const automatic = this.automation()
      if (!automatic?.enabled ||
        !(automatic.newImports && work.automatic.origin === 'new' || automatic.history && work.automatic.historical) ||
        automatic.enrichment?.language !== work.job.language ||
        !automatic.enrichment.providers.some(p => p.id === provider.id && p.context === (work.job.providerContext ?? '') && p.kinds.includes(work.job.entityKind!)))
        return 'automatic_enrichment_disabled'
    }
    return provider.blockedReason(work.job.entityKind!)
  }
  private async run() {
    const { database, provider, now } = this.options
    this.dirty = false
    if (this.needsRecovery) {
      await this.recover()
      this.needsRecovery = false
    }
    while (!this.stopped) {
      if (this.needsRecovery) { await this.recover(); this.needsRecovery = false }
      if (this.schedulePending && this.options.automation) {
        this.schedulePending = false
        const result = await database.identificationSchedule(this.automation()!, now())
        this.schedulePending ||= result.more
        if (this.stopped) return
        if (result.processed) this.notifyChanged()
      }
      const work = await database.metadataClaim(now())
      if (!work) {
        if (this.options.automation && this.schedulePending) { await new Promise(resolve => setTimeout(resolve, 0)); continue }
        break
      }
      this.notifyChanged()
      if (this.stopped) return
      const controller = new AbortController()
      this.active = { id: work.job.id, controller, automatic: !!work.automatic,
        provider: work.job.type === 'resolve' ? undefined : work.job.provider, batchId: work.job.legacy?.batchId }
      const identificationProvider = work.job.type === 'identify'
        ? this.options.identificationProviders?.().find(p => p.id === work.job.provider)
        : undefined
      const identificationContext = identificationProvider?.context()
      const detailEnrich = work.job.type === 'enrich' && work.job.provider !== 'musicbrainz-wiki'
      const detailProvider = detailEnrich ? this.options.enrichmentProviders?.().find(p => p.id === work.job.provider) : undefined
      const detailContext = detailProvider?.context()
      let result: EntityMetadataResult
      try {
        const policy = this.policy()
        if (work.job.type === 'legacy') {
          const legacy = this.options.legacy?.()
          const reason = legacy && work.legacy ? await legacy.blockedReason(work.legacy) : 'legacy_provider_not_available'
          result = reason ? { state: 'blocked', reason } : await legacy!.lookup(work.legacy!, work.job.attempts, controller.signal)
        } else if (work.job.type === 'identify') {
          const reason = this.identificationBlock(work, identificationProvider)
          if (reason) result = { state: 'blocked', reason }
          else result = { state: 'identified', ...await identificationProvider!.recall(work.identification!, controller.signal) }
        } else if (detailEnrich) {
          const reason = this.enrichmentBlock(work, detailProvider, true)
          if (reason) result = { state: 'blocked', reason }
          else {
            const { facts, credits, artwork, exploration, availability } = await detailProvider!.enrich({ kind: work.job.entityKind!, externalId: work.job.externalId, language: work.job.language }, controller.signal)
            result = { state: 'completed', facts, ...(credits ? { credits } : {}), ...(artwork ? { artwork } : {}), ...(exploration ? { exploration } : {}),
              outcome: facts.some(f => f.field === 'introduction') || artwork?.length ? 'matched' : facts.length || credits?.items.length ? 'partial' : 'not_found',
              ...(availability !== 'available' ? { reason: `${work.job.provider.startsWith('platform.') ? 'platform' : 'public'}_metadata_${availability}` } : {}) }
          }
        } else if (!policy.identity) result = { state: 'blocked', reason: policy.reason! }
        else if (work.job.type === 'resolve') {
          const candidate = await provider.resolve(work.job.externalId, controller.signal)
          result = candidate
            ? { state: 'needs_review', candidate }
            : { state: 'completed', outcome: 'not_found', facts: [] }
        } else {
          const facts = await provider.enrich(
            work.job.externalId,
            work.job.language,
            controller.signal
          )
          result = {
            state: 'completed',
            outcome: facts.some((f) => f.field === 'introduction')
              ? 'matched'
              : facts.length
                ? 'partial'
                : 'not_found',
            facts
          }
        }
      } catch (error) {
        if (this.stopped || controller.signal.aborted) {
          this.active = null
          continue
        }
        const message = error instanceof Error ? error.message : ''
        const http = error instanceof MetadataHttpError ? error :
          this.active?.provider === 'platform.ncm' && message.includes('NCM_METADATA_RATE_LIMITED')
            ? new MetadataHttpError('platform_metadata_rate_limited', 429, now() + 60_000) : null
        const transient = !http || [429, 503, 502, 504, 408].includes(http.status)
        result =
          error instanceof MetadataIdentityError && work.job.type !== 'identify'
            ? { state: 'needs_review', candidate: null, reason: error.message }
            : http && [401, 403].includes(http.status)
              ? { state: 'blocked', reason: http.message }
              : transient && (work.job.attempts < 5 || http?.status === 429)
                ? {
                    state: 'retry_wait',
                    reason: http?.message ?? 'metadata_connection_or_response_error',
                    nextAttemptAt: Math.max(
                      http?.retryAt ?? 0,
                      now() + Math.min(300000, 1000 * 2 ** work.job.attempts)
                    )
                  }
                : { state: 'failed', reason: http?.message ?? 'metadata_response_invalid' }
        if (result.state === 'failed') this.options.taskFailed?.(error, {
          type: work.job.type, provider: work.job.provider
        })
      }
      if (!this.stopped && !controller.signal.aborted) {
        // Current deployment permission is a commit fence too. Disabled text does
        // not leak through a provider result that arrived after the setting changed.
        const policy = this.policy()
        if (work.job.type === 'legacy') {
          const legacy = this.options.legacy?.()
          const reason = legacy && work.legacy ? await legacy.blockedReason(work.legacy) : 'legacy_provider_not_available'
          if (reason) result = { state: 'blocked', reason }
        } else if (work.job.type === 'identify') {
          const currentProvider = this.options.identificationProviders?.().find(p => p.id === work.job.provider)
          const reason = this.identificationBlock({ ...work, automatic: undefined }, currentProvider)
          if (reason) result = { state: 'blocked', reason }
          else if (currentProvider!.context() !== identificationContext)
            result = { state: 'blocked', reason: 'provider_configuration_changed' }
        } else if (detailEnrich) {
          const currentProvider = this.options.enrichmentProviders?.().find(p => p.id === work.job.provider)
          const reason = this.enrichmentBlock(work, currentProvider, false)
          if (reason) result = { state: 'blocked', reason }
          else if (currentProvider!.context() !== detailContext) result = { state: 'blocked', reason: 'provider_configuration_changed' }
        } else if (!policy.identity) result = { state: 'blocked', reason: policy.reason! }
        else if (result.state === 'completed' && !policy.introduction)
          result = {
            ...result,
            facts: result.facts.filter((f) => f.field !== 'introduction'),
            outcome: 'partial'
          }
        const committed = await database.metadataFinish(work, result, now(), this.automation())
        if (result.state === 'identified') this.schedulePending = true
        this.notifyChanged(
          committed && ['identified', 'needs_review', 'completed', 'legacy_result'].includes(result.state)
        )
      }
      this.active = null
    }
    if (this.stopped) return
    this.recoveryDelay = 1000
    const next = await database.metadataNextAttempt()
    if (next !== null || this.options.automation) {
      this.timer = setTimeout(
        () => {
          this.timer = null
          this.schedulePending = true
          this.wake()
        },
        Math.max(10, Math.min(this.options.automation ? 5000 : 2147483647, next === null ? 5000 : next - now()))
      )
      this.timer.unref?.()
    }
  }
  async shutdown() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.active?.controller.abort(new Error('Core metadata shutdown'))
    await Promise.allSettled([this.ready, ...this.pending])
    // A claim may have been accepted while shutdown was waiting for the DB.
    this.active?.controller.abort(new Error('Core metadata shutdown'))
    await this.task
  }
}
