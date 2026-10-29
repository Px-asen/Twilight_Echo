import type { CoreMusicExplorationService } from './library/explorationService.ts'
import type { CoreCastService } from './cast/service.ts'
import type { CoreQueueSubmission } from './playback/queueSubmission.ts'
import type { CorePlaylistSubmission } from './playlists/submission.ts'
import type { CoreRecordingCatalog } from './playlists/recordingCatalog.ts'
import type { CoreCatalogService } from './catalog/service.ts'
import type { CoreGenresService } from './library/genresService.ts'
import type { CoreMusicRatingsService } from './library/ratingsService.ts'
import type { CoreMusicPreferencesService } from './library/preferencesService.ts'
import type { CoreMusicTagsService } from './library/tagsService.ts'
import type { CoreMusicFocusService } from './library/focusService.ts'
import type { CoreAlbumBrowseService } from './library/albumBrowseService.ts'
import type { CoreUnifiedPlaybackService } from './catalog/unifiedPlayback.ts'
import { getTrackSource } from '../shared/trackSourceIdentity.ts'
import type { CoreRemoteService } from './remote/service.ts'
import type { CorePlaylistSourceEdits } from './playlists/sourceEdits.ts'
import type { CoreQueueTrackInput } from '../shared/coreQueueSubmission.ts'
import type { TrackData } from '../shared/track.ts'
import type { CoreAudioDiagnosticsService } from './audio/diagnosticsService.ts'
import type { CoreAudioRecoveryService } from './audio/recoveryService.ts'
import type { CorePlayerPresentationService } from './playback/presentationService.ts'
import type { OutputInfo } from '../shared/audioEngineTypes.ts'
import { projectCoreOutput } from './audio/outputProjection.ts'
import { libraryQueueTrack } from './playback/libraryTrack.ts'
import type { CoreNcmCloudTransferService } from './ncm/cloudTransferService.ts'
import type { CoreSettingsBackupService } from './settings/backupService.ts'
import type { CoreThemeService } from './settings/themeService.ts'
import type { CoreModelPackService } from './audio/modelPackService.ts'
import type { OpraCatalog } from './audio/opraCatalog.ts'
import type { CoreVisualizationService } from './audio/visualizationService.ts'
import type { CoreVisualizationEvent } from '../shared/coreVisualization.ts'
import { normalizeCloudSongId } from './ncm/cloudTransferHelpers.ts'
import type { CoreSettingsService } from './settings/service.ts'
import type { CoreSleepTimer } from './playback/sleepService.ts'
import type { CoreAutoMixService } from './audio/autoMixService.ts'
import type { CoreAnalysisService } from './audio/analysisService.ts'
import type { CoreLibraryLoudnessService } from './audio/libraryLoudnessService.ts'
import type { CoreLibraryMaintenance } from './library/maintenanceService.ts'
import type { CoreDuplicatesService } from './library/duplicatesService.ts'
import type { CoreInboxService } from './library/inboxService.ts'
import type { CoreLibraryHealthService } from './library/libraryHealthService.ts'
import type { CorePersonalBackupService } from './persistence/personalBackupService.ts'
import type { CoreAuditionService } from './audio/auditionService.ts'
import type { CoreOutputTestService } from './audio/outputTestService.ts'
import type { CoreDspService } from './audio/dspService.ts'
import type { CorePlaylistService } from './playlists/service.ts'
import { executePlaylistProjection } from './playlists/projectionOperations.ts'
import { executeLibraryRead, executeLibraryArtwork, type CoreLibraryReadDatabase } from './library/readOperations.ts'
import type { CoreRecordingVersions } from './playlists/recordingVersions.ts'
import type { CorePlaylistImportJobs } from './playlists/importJobs.ts'
import type { CorePlaylistPreviews } from './playlists/previews.ts'
import type { CoreBookmarksService } from './bookmarks/service.ts'
import type { CoreLyricsService } from './lyrics/service.ts'
import type { CoreWorkspaceService } from './workspace/service.ts'
import type { CoreStreamsService } from './streams/service.ts'
import type { CoreNetworkService } from './network/service.ts'
import type { CoreDownloadsService } from './downloads/service.ts'
import type { CoreMusicSearchService } from './search/service.ts'
import type { CoreMusicCacheService } from './cache/service.ts'
import type { CoreAudioOutputService } from './audio/outputService.ts'
import {
  CORE_PROTOCOL_VERSION,
  coreOperation,
  isCoreRequest,
  type CoreClientIdentity,
  type CoreClientMessage,
  type CoreRequestEnvelope,
  type CoreSnapshot
} from '../shared/coreProtocol.ts'
import type { CoreStateApi } from '../shared/coreState.ts'
import type { LibraryDatabaseApi } from '../shared/libraryDatabase.ts'
import type { CorePlaybackSession } from './playback/session.ts'
import { projectCoreError, projectCoreScan, projectCoreTrack } from './projections.ts'
import type { CoreScanService } from './library/scanService.ts'
import type { CoreLibraryBackground } from './library/background.ts'
import type { CoreMetadataService } from './library/metadataService.ts'
import type { CoreStatisticsService } from './listening/service.ts'
import type { PluginNotice } from '../shared/pluginNotice.ts'
import type { CorePluginExperiences } from './plugins/experiences.ts'
import type { CorePluginMarketplace } from './plugins/marketplace.ts'
import type { TwilightPluginManager } from './plugins/manager.ts'

interface Client {
  identity: CoreClientIdentity
  send(message: CoreClientMessage): void
  requests: Map<string, AbortController>
  seen: Set<string>
}
export interface CoreApplicationDependencies {
  opra?: Pick<OpraCatalog, 'search' | 'getProfile' | 'getStatus' | 'refresh'>
  playlistSources?: CorePlaylistSourceEdits
  revealAudioFile?(path: string): Promise<void>
  remote?: Pick<CoreRemoteService, 'status' | 'setEnabled' | 'rotatePin' | 'decidePairing' | 'revokeDevice' | 'shutdown'>
  recordingCatalog?: CoreRecordingCatalog
  catalog?: CoreCatalogService
  genres?: CoreGenresService
  ratings?: CoreMusicRatingsService
  preferences?: CoreMusicPreferencesService
  tags?: CoreMusicTagsService
  exploration?: CoreMusicExplorationService
  focus?: CoreMusicFocusService
  albums?: CoreAlbumBrowseService
  unifiedPlayback?: CoreUnifiedPlaybackService
  resolvePlaylistInputs?: (inputs: readonly CoreQueueTrackInput[], signal: AbortSignal) => Promise<import('../shared/track.ts').TrackData[]>
  libraryRevision?(): number | null
  diagnostics?: CoreAudioDiagnosticsService
  audioRecovery?: CoreAudioRecoveryService
  artwork?: Parameters<typeof executeLibraryArtwork>[2]
  playlistSubmission?: CorePlaylistSubmission
  presentation?: CorePlayerPresentationService
  outputInfo?(): Promise<OutputInfo>
  queueSubmission?: CoreQueueSubmission
  themes?: CoreThemeService
  visualization?: CoreVisualizationService
  modelPack?: CoreModelPackService
  settingsBackup?: CoreSettingsBackupService
  cloudTransfers?: CoreNcmCloudTransferService
  personalBackup?: CorePersonalBackupService
  duplicates?: CoreDuplicatesService
  inbox?: CoreInboxService
  libraryHealth?: CoreLibraryHealthService
  libraryMaintenance?: CoreLibraryMaintenance
  libraryRepair?: { shutdown(): Promise<void> }
  autoMix?: CoreAutoMixService
  analysis?: CoreAnalysisService
  libraryLoudness?: CoreLibraryLoudnessService
  sleepTimer?: CoreSleepTimer
  settings?: Pick<
    CoreSettingsService,
    'getRevision' | 'state' | 'edit' | 'initialize' | 'flush' | 'rememberVolume'
  >
  epoch: string
  playback: Omit<
    CorePlaybackSession,
    | 'quiesceForSleep'
    | 'stopForSleep'
    | 'resumeAfterSleep'
    | 'setSleepTimerGain'
    | 'applyBpm'
    | 'clearBpm'
  >
  library: Pick<LibraryDatabaseApi, 'getMetadata' | 'queryTracks' | 'readLibraryQueue'> &
    CoreLibraryReadDatabase
  state: CoreStateApi
  scan: Omit<CoreScanService, 'maintain'>
  libraryBackground?: Pick<CoreLibraryBackground, 'activate' | 'snapshot' | 'shutdown'>
  metadata?: CoreMetadataService
  statistics: Omit<CoreStatisticsService, 'exportData' | 'projectPage' | 'rememberArtwork' | 'artworkTracks'> & Partial<Pick<CoreStatisticsService, 'projectPage' | 'rememberArtwork' | 'artworkTracks'>>
  pluginExperiences?: CorePluginExperiences
  pluginMarketplace?: CorePluginMarketplace
  plugins?: TwilightPluginManager
  playlists?: CorePlaylistService
  recordingVersions?: CoreRecordingVersions
  imports?: CorePlaylistImportJobs
  importPreviews?: CorePlaylistPreviews
  bookmarks?: CoreBookmarksService
  lyrics?: CoreLyricsService
  workspace?: CoreWorkspaceService
  streams?: CoreStreamsService
  network?: CoreNetworkService
  cache?: CoreMusicCacheService
  audition?: CoreAuditionService
  outputTest?: CoreOutputTestService
  cast?: CoreCastService
  dsp?: CoreDspService
  output?: Pick<
    CoreAudioOutputService,
    | 'getRevision'
    | 'changed'
    | 'state'
    | 'profiles'
    | 'edit'
    | 'editProfiles'
    | 'flush'
    | 'shutdown'
  >
  downloads?: CoreDownloadsService
  search?: Pick<CoreMusicSearchService, 'page' | 'collections' | 'shutdown'>
  ready(): void
}

/** Portable business endpoint; main is a capability gateway, never a second state owner. */
export class CoreApplication {
  private readonly clients = new Map<string, Client>()
  private phase: CoreSnapshot['phase'] = 'starting'
  private sequence = 0
  private pluginsRevision = 0
  private readonly pluginsChanged = () => {
    this.pluginsRevision++
    this.changed()
  }
  private readonly pluginNotice = (notice: PluginNotice) => {
    for (const client of this.clients.values()) {
      if (client.identity.permissions.includes('plugins:read'))
        client.send({ kind: 'plugin-notice', epoch: this.dependencies.epoch, notice })
    }
  }
  private readonly pluginExperienceEvent = (event: {
    pluginId: string
    event: string
    value: unknown
  }) => {
    for (const client of this.clients.values()) {
      if (client.identity.permissions.includes('extensions:execute'))
        client.send({
          kind: 'plugin-experience',
          epoch: this.dependencies.epoch,
          pluginId: event.pluginId,
          event: event.event,
          value: event.value
        })
    }
  }
  private migrationRequired = true
  private active = 0
  private initialized = false
  private readiness: Promise<void> | null = null
  private shuttingDown = false
  private readonly work = new Set<Promise<void>>()
  private readonly dependencies: CoreApplicationDependencies
  constructor(dependencies: CoreApplicationDependencies) {
    this.dependencies = dependencies
    dependencies.plugins?.on('changed', this.pluginsChanged)
    dependencies.plugins?.on('notice', this.pluginNotice)
    dependencies.plugins?.on('experience-event', this.pluginExperienceEvent)
  }
  private preserveTrustedArtwork(resolved: TrackData, trusted: TrackData): TrackData {
    return {
      ...resolved,
      cover: resolved.cover ?? trusted.cover ?? null,
      ...(resolved.coverSource || trusted.coverSource
        ? { coverSource: resolved.coverSource ?? trusted.coverSource }
        : {})
    }
  }
  private async resolveFallbackArtworkTracks(
    ids: readonly string[],
    signal: AbortSignal
  ): Promise<Map<string, TrackData>> {
    const needed = new Set(ids)
    const found = new Map<string, TrackData>()
    const remember = (candidate: TrackData | null | undefined) => {
      if (!candidate || !needed.has(candidate.id) || found.has(candidate.id)) return
      if (!candidate.cover && !candidate.coverSource && !candidate.networkSource) return
      found.set(candidate.id, candidate)
    }
    if (this.dependencies.playlists) {
      for (const candidate of this.dependencies.playlists.librarySourceTracks()) {
        remember(candidate)
        if (found.size === needed.size) return found
      }
    }
    const queue = this.dependencies.playback.snapshot().queue
    if (queue && queue.total > 0 && found.size < needed.size) {
      const maxWindow = Math.min(queue.total, 2000)
      const startOffset =
        queue.total <= 2000
          ? 0
          : Math.floor(Math.max(0, queue.index) / 200) * 200
      for (let offset = startOffset; offset < startOffset + maxWindow; offset += 200) {
        signal.throwIfAborted()
        try {
          const page = await this.dependencies.library.readLibraryQueue(
            queue.id,
            offset,
            200,
            { expectedRevision: queue.revision }
          )
          for (const item of page.items) {
            if (item.track) remember(libraryQueueTrack(item.track, item.queueEntryId))
          }
          if (found.size === needed.size || queue.total > 2000) break
        } catch {
          break
        }
      }
    }
    if (found.size < needed.size && this.dependencies.statistics.artworkTracks) {
      const remaining = new Set<string>()
      for (const id of needed) {
        if (!found.has(id)) remaining.add(id)
      }
      for (const candidate of this.dependencies.statistics.artworkTracks(remaining).values()) {
        remember(candidate)
        if (found.size === needed.size) break
      }
    }
    return found
  }
  async initialize(): Promise<void> {
    this.migrationRequired = !(await this.dependencies.state.coreStateStatus()).complete
    await this.dependencies.bookmarks?.initialize()
    await this.dependencies.lyrics?.initialize()
    await this.dependencies.workspace?.initialize()
    await this.dependencies.streams?.initialize()
    await this.dependencies.network?.initialize()
    await this.dependencies.dsp?.initialize()
    await this.dependencies.playback.initialize()
    await this.dependencies.visualization?.initialize()
    await this.dependencies.scan.initialize()
    await this.dependencies.libraryMaintenance?.initialize()
    this.initialized = true
    await this.checkReady()
  }
  private async checkReady(): Promise<void> {
    if (!this.initialized || this.migrationRequired || this.phase === 'ready') return
    return (this.readiness ??= (async () => {
      await this.dependencies.personalBackup?.initialize()
      await this.dependencies.statistics.initialize()
      if (this.shuttingDown) return
      await this.dependencies.recordingVersions?.initialize()
      await this.dependencies.inbox?.initialize()
      await this.dependencies.playlists?.initialize()
      await this.dependencies.plugins?.initialize()
      await this.dependencies.themes?.reconcile()
      await this.dependencies.settings?.initialize()
      await this.dependencies.dsp?.activate()
      this.dependencies.autoMix?.activate()
      this.dependencies.analysis?.activate()
      this.dependencies.sleepTimer?.activate()
      await this.dependencies.streams?.activate()
      if (this.shuttingDown || this.phase === 'stopped') return
      this.phase = 'ready'
      this.dependencies.scan.activate()
      this.dependencies.libraryBackground?.activate()
      this.dependencies.catalog?.activate()
      this.dependencies.genres?.activate()
      this.dependencies.metadata?.activate()
      this.dependencies.lyrics?.activate()
      this.dependencies.imports?.activate()
      this.changed()
      this.dependencies.ready()
      await this.dependencies.plugins?.broadcastEvent('app:ready', {})
    })().finally(() => {
      this.readiness = null
    }))
  }
  snapshot(identity?: CoreClientIdentity): CoreSnapshot {
    // Graph transactions advance the same catalog revision without running the
    // derived-index job, which may be paused. Publish the latest observed value.
    const catalogRevisions = [
      this.dependencies.catalog?.getRevision(),
      this.dependencies.exploration?.getCatalogRevision()
    ].filter((revision): revision is number => revision != null)
    return structuredClone({
      libraryRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.libraryRevision?.() ?? null : null,
      catalogRevision: !identity || identity.permissions.includes('library:read')
        ? catalogRevisions.length ? Math.max(...catalogRevisions) : null : null,
      genresRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.genres?.getRevision() ?? null : null,
      classificationMetadataRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.genres?.getMetadataRevision() ?? null : null,
      ratingsRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.ratings?.getRevision() ?? null : null,
      preferencesRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.preferences?.getRevision() ?? null : null,
      explorationRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.exploration?.getRevision() ?? null : null,
      focusRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.focus?.getRevision() ?? null : null,
      focusHistoryRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.focus?.getHistoryRevision() ?? null : null,
      tagsRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.tags?.getRevision() ?? null : null,
      tagsLinkRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.tags?.getLinkRevision() ?? null : null,
      entityMetadataRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.metadata?.entities?.getRevision() ?? null : null,
      entityMetadataContentRevision: !identity || identity.permissions.includes('library:read')
        ? this.dependencies.metadata?.entities?.getContentRevision() ?? null : null,
      pluginsRevision:
        !identity || identity.permissions.includes('plugins:read') ? this.pluginsRevision : null,
      presentationRevision:
        !identity || identity.permissions.includes('playback:read')
          ? (this.dependencies.presentation?.getRevision() ?? null)
          : null,
      modelPack:
        !identity || identity.permissions.includes('settings:read')
          ? (this.dependencies.modelPack?.state() ?? null)
          : null,
      cloudTransfers:
        !identity || identity.permissions.includes('downloads:read')
          ? (this.dependencies.cloudTransfers?.state() ?? null)
          : null,
      inbox:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.inbox?.state() ?? null)
          : null,
      libraryLoudness:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.libraryLoudness?.state() ?? null)
          : null,
      loudness:
        !identity || identity.permissions.includes('settings:read')
          ? (this.dependencies.analysis?.status() ?? null)
          : null,
      protocolVersion: CORE_PROTOCOL_VERSION,
      epoch: this.dependencies.epoch,
      sequence: this.sequence,
      phase: this.phase,
      migrationRequired: this.migrationRequired,
      audioRevision:
        !identity || identity.permissions.includes('settings:read')
          ? (this.dependencies.output?.getRevision() ?? null)
          : null,
      settingsRevision:
        !identity || identity.permissions.includes('settings:read')
          ? (this.dependencies.settings?.getRevision() ?? null)
          : null,
      personalBackupRecovery:
        !identity || identity.permissions.includes('settings:read')
          ? (this.dependencies.personalBackup?.recoveryAvailable() ?? false) : null,
      sleepTimer:
        !identity || identity.permissions.includes('playback:read')
          ? (this.dependencies.sleepTimer?.state() ?? null)
          : null,
      downloads:
        !identity || identity.permissions.includes('downloads:read')
          ? (this.dependencies.downloads?.state() ?? null)
          : null,
      playlistsRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.playlists?.getRevision() ?? null)
          : null,
      versionsRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.recordingVersions?.getRevision() ?? null)
          : null,
      bookmarksRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.bookmarks?.getRevision() ?? null)
          : null,
      lyricsRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.lyrics?.getRevision() ?? null)
          : null,
      lyricsContentRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.lyrics?.getContentRevision() ?? null)
          : null,
      statisticsRevision:
        !identity || identity.permissions.includes('statistics:read')
          ? this.dependencies.statistics.getRevision()
          : null,
      workspaceRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.workspace?.getRevision() ?? null)
          : null,
      workspaceContentRevision:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.workspace?.getContentRevision() ?? null)
          : null,
      streams:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.streams?.state() ?? null)
          : null,
      network:
        !identity || identity.permissions.includes('library:read')
          ? (this.dependencies.network?.state() ?? null)
          : null,
      cast:
        !identity || identity.permissions.includes('playback:read')
          ? (this.dependencies.cast?.state() ?? null)
          : null,
      scan:
        !identity || identity.permissions.includes('library:read')
          ? projectCoreScan(this.dependencies.scan.snapshot())
          : null,
      ...this.dependencies.playback.snapshot(),
      ...(identity && !identity.permissions.includes('playback:read')
        ? {
            playback: null,
            track: null,
            queue: null,
            error: null,
            personalized: null,
            heart: null,
            loading: false,
            isStreamBuffering: false,
            abLoop: null,
            mute: null
          }
        : {})
    })
  }
  connect(identity: CoreClientIdentity, send: (message: CoreClientMessage) => void): void {
    if (this.clients.has(identity.id)) throw new Error('Core client already connected')
    this.clients.set(identity.id, {
      identity: structuredClone(identity),
      send,
      requests: new Map(),
      seen: new Set()
    })
    // Snapshot and subscription registration occur in one JS turn. An event
    // cannot be lost in the snapshot-to-subscription gap.
    this.sendState(this.clients.get(identity.id)!)
  }
  disconnect(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    this.clients.delete(clientId)
    void this.dependencies.visualization
      ?.disconnect(clientId)
      .catch((error) => console.error('[core.visualization]', error))
    this.dependencies.cloudTransfers?.disconnect(clientId)
    void this.dependencies.queueSubmission?.disconnect(clientId)
    void this.dependencies.playlistSubmission?.disconnect(clientId)
    for (const controller of client.requests.values())
      controller.abort(new Error('Core client disconnected'))
  }
  changed(): void {
    this.sequence++
    for (const client of this.clients.values()) this.sendState(client)
  }
  sendVisualization(clientId: string, event: CoreVisualizationEvent): void {
    const client = this.clients.get(clientId)
    if (
      event.epoch === this.dependencies.epoch &&
      client?.identity.permissions.includes('playback:read')
    )
      client.send(event)
  }
  private sendState(client: Client): void {
    if (!client.identity.permissions.includes('playback:read')) return
    client.send({
      kind: 'state',
      epoch: this.dependencies.epoch,
      sequence: this.sequence,
      snapshot: this.snapshot(client.identity)
    })
  }
  cancel(clientId: string, requestId: string, epoch: string): void {
    if (epoch === this.dependencies.epoch)
      this.clients
        .get(clientId)
        ?.requests.get(requestId)
        ?.abort(new Error('Core request cancelled'))
  }
  request(clientId: string, raw: CoreRequestEnvelope): Promise<void> {
    const work = this.handleRequest(clientId, raw)
    this.work.add(work)
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work)
    )
    return work
  }
  private async handleRequest(clientId: string, raw: CoreRequestEnvelope): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) return
    const reply = (
      result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
    ) => {
      if (this.clients.get(clientId) !== client) return
      client.send({
        kind: 'response',
        requestId: typeof raw?.requestId === 'string' ? raw.requestId : '',
        epoch: this.dependencies.epoch,
        ...result
      } as CoreClientMessage)
    }
    let controller: AbortController | null = null
    try {
      if (!isCoreRequest(raw))
        throw failure('INVALID_REQUEST', 'Unknown or malformed Core operation')
      if (raw.epoch !== this.dependencies.epoch)
        throw failure('STALE_EPOCH', 'Core restarted; read a fresh snapshot')
      const operation = coreOperation(raw.name)!
      if (!client.identity.permissions.includes(operation.permission))
        throw failure('FORBIDDEN', 'Core capability is not granted')
      if (client.seen.has(raw.requestId))
        throw failure(
          'OUTCOME_UNKNOWN',
          'Request was already dispatched; refresh state instead of replaying it'
        )
      if (this.active >= 128 || client.requests.size >= 16)
        throw failure('BUSY', 'Core request capacity exceeded')
      if (
        this.phase !== 'ready' &&
        !raw.name.startsWith('migration.') &&
        raw.name !== 'state.snapshot'
      )
        throw failure('NOT_READY', 'Core initialization or browser migration is incomplete')
      if (this.phase === 'stopped' || this.shuttingDown)
        throw failure('NOT_READY', 'Core is shutting down')
      controller = new AbortController()
      client.requests.set(raw.requestId, controller)
      client.seen.add(raw.requestId)
      if (client.seen.size > 1024) client.seen.delete(client.seen.values().next().value!)
      this.active++
      const value = await this.dispatch(raw, controller.signal, client.identity)
      reply({ ok: true, value })
    } catch (error) {
      const e = error as { code?: string; message?: string }
      reply({ ok: false, error: { code: e?.code ?? 'FAILED', message: projectCoreError(error) } })
    } finally {
      if (controller) {
        client.requests.delete(raw.requestId)
        this.active--
      }
    }
  }
  private async dispatch(
    request: CoreRequestEnvelope,
    signal: AbortSignal,
    identity: CoreClientIdentity
  ): Promise<unknown> {
    const playback = this.dependencies.playback
    if (
      request.name === 'liked.play' ||
      request.name === 'heart.refill' ||
      (request.name === 'playback.mode' && request.payload.mode === 'heart')
    ) {
      if (!identity.permissions.includes('providers:call'))
        throw failure('FORBIDDEN', 'Heart provider access is not granted')
      if (request.name === 'liked.play') return playback.startLiked(request.payload, signal)
      if (request.name === 'heart.refill') return playback.refillHeart(request.payload)
    }
    if (request.name === 'personalized.start' || request.name === 'personalized.refill') {
      if (!identity.permissions.includes('providers:call'))
        throw failure('FORBIDDEN', 'Personalized provider access is not granted')
      return request.name === 'personalized.start'
        ? playback.startPersonalized(request.payload, signal)
        : playback.refillPersonalized(request.payload)
    }
    if (request.name.startsWith('playlists.')) {
      await this.dependencies.playlists?.waitForPending()
      signal.throwIfAborted()
    }
    switch (request.name) {
      case 'exploration.query':
      case 'exploration.lookup':
      case 'exploration.detail':
      case 'exploration.relations':
      case 'exploration.participation':
      case 'exploration.performance.save':
      case 'exploration.performance.delete': {
        const service = this.dependencies.exploration
        if (!service) throw failure('NOT_READY', '人物作品探索尚未就绪')
        switch (request.name) {
          case 'exploration.query': return service.query(request.payload)
          case 'exploration.lookup': return service.lookup(request.payload)
          case 'exploration.detail': return service.detail(request.payload)
          case 'exploration.relations': return service.relations(request.payload)
          case 'exploration.participation': return service.participation(request.payload)
          case 'exploration.performance.save': return service.performanceSave(request.payload)
          case 'exploration.performance.delete': return service.performanceDelete(request.payload)
        }
        break
      }
      case 'focus.query':
      case 'focus.play.status':
      case 'focus.facets':
      case 'focus.saved.list':
      case 'focus.saved.create':
      case 'focus.saved.rename':
      case 'focus.saved.update':
      case 'focus.saved.delete':
      case 'focus.play': {
        const focus = this.dependencies.focus
        if (!focus) throw failure('NOT_READY', 'Focus is unavailable')
        switch (request.name) {
          case 'focus.play.status': {
            if (!identity.permissions.includes('library:read')) throw failure('FORBIDDEN', 'Library access is not granted')
            return focus.playStatus(request.payload, identity.id, this.dependencies.epoch)
          }
          case 'focus.query': return focus.query(request.payload)
          case 'focus.facets': return focus.facets(request.payload)
          case 'focus.saved.list': return focus.savedList(request.payload)
          case 'focus.saved.create': return focus.savedCreate(request.payload)
          case 'focus.saved.rename': return focus.savedRename(request.payload)
          case 'focus.saved.update': return focus.savedUpdate(request.payload)
          case 'focus.saved.delete': return focus.savedDelete(request.payload)
          case 'focus.play': {
            if (!identity.permissions.includes('library:read')) throw failure('FORBIDDEN', 'Library access is not granted')
            return focus.play(request.payload, signal, async (track, preparation) => {
              preparation.throwIfAborted()
              if (getTrackSource(track) === 'local') return track
              if (!identity.permissions.includes('providers:call')) throw failure('FORBIDDEN', 'Provider access is not granted')
              const resolve = this.dependencies.resolvePlaylistInputs
              if (!resolve) throw failure('NOT_READY', 'Provider resolution is unavailable')
              const tracks = await resolve([{ kind: 'provider', track: {
                id: track.id, source: getTrackSource(track), ncmSongId: track.ncmSongId,
                title: track.title, artist: track.artist, album: track.album, duration: track.duration
              } }], preparation)
              preparation.throwIfAborted()
              if (!tracks[0]) throw failure('FAILED', '来源不可用')
              return this.preserveTrustedArtwork(tracks[0], track)
            }, { requestId: request.requestId, epoch: this.dependencies.epoch, owner: identity.id })
          }
        }
        break
      }
      case 'tags.list':
      case 'tags.entity':
      case 'tags.members':
      case 'tags.recordings':
      case 'tags.create':
      case 'tags.rename':
      case 'tags.delete':
      case 'tags.member.set':
      case 'tags.play': {
        const tags = this.dependencies.tags
        if (!tags) throw failure('NOT_READY', 'Music tags are unavailable')
        switch (request.name) {
          case 'tags.list': return tags.list(request.payload)
          case 'tags.entity': return tags.entity(request.payload)
          case 'tags.members': return tags.members(request.payload)
          case 'tags.recordings': return tags.recordings(request.payload)
          case 'tags.create': return tags.create(request.payload)
          case 'tags.rename': return tags.rename(request.payload)
          case 'tags.delete': return tags.delete(request.payload)
          case 'tags.member.set': return tags.memberSet(request.payload)
          case 'tags.play': {
            if (!identity.permissions.includes('library:read')) throw failure('FORBIDDEN', 'Library access is not granted')
            return tags.play(request.payload, signal, async (track, preparation) => {
              preparation.throwIfAborted()
              if (getTrackSource(track) === 'local') return track
              if (!identity.permissions.includes('providers:call')) throw failure('FORBIDDEN', 'Provider access is not granted')
              const resolve = this.dependencies.resolvePlaylistInputs
              if (!resolve) throw failure('NOT_READY', 'Provider resolution is unavailable')
              const tracks = await resolve([{ kind: 'provider', track: {
                id: track.id, source: getTrackSource(track), ncmSongId: track.ncmSongId,
                title: track.title, artist: track.artist, album: track.album, duration: track.duration
              } }], preparation)
              preparation.throwIfAborted()
              if (!tracks[0]) throw failure('FAILED', '来源不可用')
              return this.preserveTrustedArtwork(tracks[0], track)
            })
          }
        }
        break
      }
      case 'preferences.detail':
      case 'preferences.targets':
      case 'preferences.history':
      case 'preferences.set': {
        const preferences = this.dependencies.preferences
        if (!preferences) throw failure('NOT_READY', 'Music preferences are unavailable')
        switch (request.name) {
          case 'preferences.detail': return preferences.detail(request.payload.entityId)
          case 'preferences.targets': return preferences.targets(request.payload)
          case 'preferences.history': return preferences.history(request.payload)
          case 'preferences.set': return preferences.set(request.payload)
        }
        break
      }
      case 'ratings.detail':
      case 'ratings.targets':
      case 'ratings.history':
      case 'ratings.set': {
        const ratings = this.dependencies.ratings
        if (!ratings) throw failure('NOT_READY', 'Music ratings are unavailable')
        switch (request.name) {
          case 'ratings.detail': return ratings.detail(request.payload.entityId)
          case 'ratings.targets': return ratings.targets(request.payload)
          case 'ratings.history': return ratings.history(request.payload)
          case 'ratings.set': return ratings.set(request.payload)
        }
        break
      }
      case 'albums.browse':
      case 'albums.sources': {
        const albums = this.dependencies.albums
        if (!albums) throw failure('NOT_READY', 'Album version browsing is unavailable')
        return request.name === 'albums.browse' ? albums.browse(request.payload) : albums.sources(request.payload)
      }
      case 'catalog.playUnified': {
        if (!identity.permissions.includes('library:read')) throw failure('FORBIDDEN', 'Library access is not granted')
        const unified = this.dependencies.unifiedPlayback
        if (!unified) throw failure('NOT_READY', 'Unified music playback is unavailable')
        return unified.play(request.payload, signal, async (track, preparation) => {
          preparation.throwIfAborted()
          if (getTrackSource(track) === 'local') return track
          if (!identity.permissions.includes('providers:call')) throw failure('FORBIDDEN', 'Provider access is not granted')
          const resolve = this.dependencies.resolvePlaylistInputs
          if (!resolve) throw failure('NOT_READY', 'Provider resolution is unavailable')
          const tracks = await resolve([{ kind: 'provider', track: {
            id: track.id, source: getTrackSource(track), ncmSongId: track.ncmSongId,
            title: track.title, artist: track.artist, album: track.album, duration: track.duration
          } }], preparation)
          preparation.throwIfAborted()
          if (!tracks[0]) throw failure('FAILED', '来源不可用')
          return this.preserveTrustedArtwork(tracks[0], track)
        })
      }
      case 'genres.tree':
      case 'genres.browse':
      case 'genres.members':
      case 'genres.facets':
      case 'genres.unmapped':
      case 'genres.evidence':
      case 'genres.edit':
      case 'genres.map':
      case 'genres.override': {
        const genres = this.dependencies.genres
        if (!genres) throw failure('NOT_READY', 'Music classification is unavailable')
        switch (request.name) {
          case 'genres.tree': return genres.tree(request.payload)
          case 'genres.browse': return genres.browse(request.payload)
          case 'genres.members': return genres.members(request.payload)
          case 'genres.facets': return genres.facets(request.payload)
          case 'genres.unmapped': return genres.unmapped(request.payload)
          case 'genres.evidence': return genres.evidence(request.payload)
          case 'genres.edit': return genres.edit(request.payload)
          case 'genres.map': return genres.map(request.payload)
          case 'genres.override': return genres.override(request.payload)
        }
        break
      }
      case 'catalog.query':
      case 'catalog.detail':
      case 'catalog.sources':
      case 'catalog.status':
      case 'catalog.refresh':
      case 'catalog.cancel':
      case 'catalog.play': {
        const catalog = this.dependencies.catalog
        if (!catalog) throw failure('NOT_READY', 'Music catalog is unavailable')
        switch (request.name) {
          case 'catalog.query': return catalog.query(request.payload)
          case 'catalog.detail': return catalog.detail(request.payload.id, request.payload.revision)
          case 'catalog.sources': return catalog.sources(request.payload)
          case 'catalog.status': return catalog.status()
          case 'catalog.refresh':
          case 'catalog.cancel':
            if (identity.role !== 'desktop') throw failure('FORBIDDEN', 'Catalog maintenance requires the desktop window')
            return request.name === 'catalog.refresh' ? catalog.refresh() : catalog.cancel()
          case 'catalog.play':
            if (!identity.permissions.includes('library:read')) throw failure('FORBIDDEN', 'Library access is not granted')
            return playback.fromTrack(async preparation => {
              const track = await catalog.resolve(request.payload.sourceId, request.payload.revision)
              preparation.throwIfAborted()
              if (!track) throw failure('FAILED', '来源已不存在，请刷新音乐库')
              if (getTrackSource(track) === 'local') return { ...track, sourceSelection: 'explicit' }
              if (!identity.permissions.includes('providers:call')) throw failure('FORBIDDEN', 'Provider access is not granted')
              const resolve = this.dependencies.resolvePlaylistInputs
              if (!resolve) throw failure('NOT_READY', 'Provider resolution is unavailable')
              const tracks = await resolve([{ kind: 'provider', track: {
                id: track.id, source: getTrackSource(track), ncmSongId: track.ncmSongId,
                title: track.title, artist: track.artist, album: track.album, duration: track.duration
              } }], preparation)
              if (!tracks[0]) throw failure('FAILED', '来源不可用')
              return { ...this.preserveTrustedArtwork(tracks[0], track), sourceSelection: 'explicit' }
            }, 0, true, signal)
        }
        break
      }
      case 'opra.search':
      case 'opra.profile':
      case 'opra.status':
      case 'opra.refresh': {
        const opra = this.dependencies.opra
        if (!opra) throw failure('NOT_READY', 'OPRA catalog is unavailable')
        switch (request.name) {
          case 'opra.search':
            return opra.search(request.payload.query.trim())
          case 'opra.profile':
            return opra.getProfile(request.payload.id.trim())
          case 'opra.status':
            return opra.getStatus()
          case 'opra.refresh':
            return opra.refresh()
        }
        break
      }
      case 'player.presentation':
        if (!this.dependencies.presentation)
          throw failure('NOT_READY', 'Player presentation is unavailable')
        return this.dependencies.presentation.snapshot()
      case 'player.lyrics':
        if (!this.dependencies.lyrics) throw failure('NOT_READY', 'Lyrics are unavailable')
        return {
          state: this.dependencies.lyrics.state(),
          content: this.dependencies.lyrics.content()
        }
      case 'playback.diagnostics':
        if (!this.dependencies.outputInfo)
          throw failure('NOT_READY', 'Output diagnostics are unavailable')
        return projectCoreOutput(await this.dependencies.outputInfo())
      case 'playback.favorite':
        if (!this.dependencies.presentation)
          throw failure('NOT_READY', 'Player presentation is unavailable')
        return this.dependencies.presentation.toggleFavorite(request.payload, signal)
      case 'playback.control':
        if (request.payload.type === 'toggle-favorite') {
          const expected = this.dependencies.presentation?.snapshot().current
          if (!expected) throw failure('NOT_READY', 'There is no selected track')
          return this.dependencies.presentation!.toggleFavorite(expected, signal)
        }
        return playback.control(request.payload, signal)
      case 'queue.locate': {
        const page = await this.dependencies.library.readLibraryQueue(request.payload.id, 0, 1, {
          expectedRevision: request.payload.revision,
          occurrenceId: request.payload.occurrenceId
        })
        return { position: page.items[0]?.position ?? null }
      }
      case 'queue.insert':
        if (!this.dependencies.queueSubmission)
          throw failure('NOT_READY', 'Queue submission is unavailable')
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Queue insertion requires the desktop window')
        return this.dependencies.queueSubmission.insert(request.payload, signal)
      case 'playlists.addQueueEntries': {
        if (!identity.permissions.includes('playback:read'))
          throw failure('FORBIDDEN', 'Playback access is required')
        if (!this.dependencies.playlists) throw failure('NOT_READY', 'Playlists are unavailable')
        const { id, revision, queue, occurrenceIds } = request.payload
        const tracks = [] as ReturnType<typeof libraryQueueTrack>[]
        let libraryRevision: number | undefined
        for (const occurrenceId of occurrenceIds) {
          signal.throwIfAborted()
          const page = await this.dependencies.library.readLibraryQueue(queue.id, 0, 1, {
            expectedRevision: queue.revision,
            occurrenceId
          })
          libraryRevision ??= page.libraryRevision
          if (page.libraryRevision !== libraryRevision)
            throw failure('STALE_REVISION', 'Library changed while reading the queue')
          const item = page.items[0]
          if (!item?.track) throw failure('STALE_REVISION', '队列中的曲目已不存在，请刷新队列')
          tracks.push(libraryQueueTrack(item.track, item.queueEntryId))
        }
        signal.throwIfAborted()
        return this.dependencies.playlists.edit(revision, { kind: 'add', id, tracks }, signal)
      }
      case 'playlists.saveQueue': {
        if (!identity.permissions.includes('playback:read'))
          throw failure('FORBIDDEN', 'Playback access is required')
        if (!this.dependencies.playlists) throw failure('NOT_READY', 'Playlists are unavailable')
        const { name, revision, queue } = request.payload
        return this.dependencies.playlists.saveTrackPages(
          name,
          revision,
          async (append) => {
            let libraryRevision: number | undefined,
              count = 0
            for (let offset = 0; ; offset += 200) {
              signal.throwIfAborted()
              const page = await this.dependencies.library.readLibraryQueue(queue.id, offset, 200, {
                expectedRevision: queue.revision
              })
              libraryRevision ??= page.libraryRevision
              if (libraryRevision !== page.libraryRevision)
                throw failure('STALE_REVISION', 'Library changed while saving the queue')
              const tracks = page.items.flatMap((item) =>
                item.track ? [libraryQueueTrack(item.track, item.queueEntryId)] : []
              )
              count += tracks.length
              await append(tracks)
              if (offset + 200 >= page.total) break
            }
            if (!count) throw failure('FAILED', '队列中没有可保存的歌曲')
            const current = await this.dependencies.library.readLibraryQueue(queue.id, 0, 1, {
              expectedRevision: queue.revision
            })
            if (current.libraryRevision !== libraryRevision)
              throw failure('STALE_REVISION', 'Library changed while saving the queue')
            return () => {
              signal.throwIfAborted()
            }
          },
          signal
        )
      }
      case 'themes.list':
      case 'themes.bootstrap':
      case 'themes.edit':
      case 'themes.import':
      case 'themes.export':
      case 'themes.importAsset':
      case 'themes.validateAssets':
      case 'themes.copyAssets':
      case 'themes.reconcile': {
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Theme management requires the desktop window')
        const themes = this.dependencies.themes
        if (!themes) throw failure('FAILED', 'Theme management unavailable')
        switch (request.name) {
          case 'themes.list':
            return themes.list()
          case 'themes.bootstrap':
            return themes.bootstrap()
          case 'themes.edit':
            return themes.edit(request.payload, signal)
          case 'themes.import':
            return themes.import(request.payload.revision, signal)
          case 'themes.export':
            return themes.export(request.payload.id, signal)
          case 'themes.importAsset':
            return themes.importAsset(request.payload.id, request.payload.type, signal)
          case 'themes.validateAssets':
            return themes.validateAssets(request.payload.id, request.payload.assets, signal)
          case 'themes.copyAssets':
            return themes.copyAssets(request.payload.sourceId, request.payload.targetId)
          case 'themes.reconcile':
            return themes.reconcile()
        }
        break
      }
      case 'visualization.subscribe':
      case 'visualization.unsubscribe': {
        const visualization = this.dependencies.visualization
        if (!visualization) throw failure('FAILED', 'Visualization unavailable')
        return request.name === 'visualization.subscribe'
          ? visualization.subscribe(identity.id, request.payload)
          : visualization.unsubscribe(identity.id, request.payload.subscriptionId)
      }
      case 'automix.install.start':
      case 'automix.install.cancel':
      case 'automix.install.status': {
        const installer = this.dependencies.modelPack
        if (!installer) throw failure('FAILED', 'AutoMix model installation unavailable')
        if (request.kind === 'command' && identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Model installation requires the desktop window')
        return request.name === 'automix.install.start'
          ? installer.start(request.payload.enableAfterInstall)
          : request.name === 'automix.install.cancel'
            ? installer.cancel()
            : installer.state()
      }
      case 'settings.backup':
      case 'settings.restore': {
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Settings backup requires the desktop window')
        const backup = this.dependencies.settingsBackup
        if (!backup) throw failure('FAILED', 'Settings backup unavailable')
        return request.name === 'settings.backup'
          ? backup.export()
          : backup.import(request.payload, signal)
      }
      case 'ncm.cloud.chooseUploadFiles':
      case 'ncm.cloud.upload':
      case 'ncm.cloud.download':
      case 'ncm.cloud.cancel':
      case 'ncm.cloud.state':
      case 'ncm.cloud.page': {
        const transfers = this.dependencies.cloudTransfers
        if (!transfers) throw failure('FAILED', 'NCM cloud transfers unavailable')
        if (request.kind === 'command' && identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Cloud transfers require the desktop window')
        switch (request.name) {
          case 'ncm.cloud.chooseUploadFiles':
            return transfers.chooseUploadFiles(identity.id, signal)
          case 'ncm.cloud.upload':
            return transfers.upload(identity.id, request.payload.handle)
          case 'ncm.cloud.download':
            if (!identity.permissions.includes('providers:call'))
              throw failure('FORBIDDEN', 'NCM provider access is not granted')
            return transfers.download(
              identity.id,
              {
                ...request.payload,
                cloudSongId: normalizeCloudSongId(request.payload.cloudSongId)
              },
              signal
            )
          case 'ncm.cloud.cancel':
            return transfers.cancel(request.payload.id)
          case 'ncm.cloud.state':
            return transfers.state()
          case 'ncm.cloud.page':
            return transfers.page(request.payload)
        }
        break
      }
      case 'library.health.start':
      case 'library.health.status':
      case 'library.health.page':
      case 'library.health.repair': {
        const health = this.dependencies.libraryHealth
        if (!health) throw failure('FAILED', '音乐库体检服务不可用')
        if (request.kind === 'command' && identity.role !== 'desktop')
          throw failure('FORBIDDEN', '音乐库体检操作需要桌面窗口')
        switch (request.name) {
          case 'library.health.start': return health.start()
          case 'library.health.status': return health.state()
          case 'library.health.page': return health.page(request.payload)
          case 'library.health.repair': return health.repair(request.payload)
        }
        break
      }
      case 'library.inbox.refresh':
      case 'library.inbox.mark':
      case 'library.inbox.page': {
        const inbox = this.dependencies.inbox
        if (!inbox) throw failure('FAILED', 'Library inbox unavailable')
        if (request.kind === 'command' && identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Inbox changes require the desktop window')
        if (request.name === 'library.inbox.refresh')
          return inbox.refresh(request.payload.duplicatesId)
        if (request.name === 'library.inbox.mark') return inbox.mark(request.payload)
        return inbox.page(request.payload)
      }
      case 'library.loudness.prepare':
      case 'library.loudness.start':
      case 'library.loudness.cancel':
      case 'library.loudness.clear':
      case 'library.loudness.state':
      case 'library.loudness.page':
      case 'library.loudness.result': {
        const loudness = this.dependencies.libraryLoudness
        if (!loudness) throw failure('FAILED', 'Library loudness unavailable')
        if (request.kind === 'command' && identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Library loudness changes require the desktop window')
        switch (request.name) {
          case 'library.loudness.prepare':
            return loudness.prepare(request.payload, signal)
          case 'library.loudness.start':
            return loudness.start(request.payload.id)
          case 'library.loudness.cancel':
            return loudness.cancel(request.payload.id)
          case 'library.loudness.clear':
            return loudness.clear(request.payload.id)
          case 'library.loudness.state':
            return loudness.state()
          case 'library.loudness.page':
            return loudness.page(request.payload.id, request.payload.offset, request.payload.limit)
          case 'library.loudness.result':
            return loudness.result(request.payload.id, request.payload.index)
        }
        break
      }
      case 'analysis.request':
      case 'analysis.cache.clear':
      case 'analysis.cache.size':
      case 'analysis.loudness.status': {
        const analysis = this.dependencies.analysis
        if (!analysis) throw failure('FAILED', 'Audio analysis unavailable')
        if (
          (request.name === 'analysis.request' || request.name === 'analysis.cache.clear') &&
          identity.role !== 'desktop'
        )
          throw failure('FORBIDDEN', 'Audio analysis changes require the desktop window')
        switch (request.name) {
          case 'analysis.request': {
            const result = await analysis.request(request.payload)
            return 'reason' in result
              ? { ...result, reason: projectCoreError(result.reason) }
              : result
          }
          case 'analysis.cache.clear':
            return analysis.clearCache(request.payload.kind)
          case 'analysis.cache.size':
            return analysis.cacheSize(request.payload.kind)
          case 'analysis.loudness.status':
            return analysis.status()
        }
        break
      }
      case 'backup.export':
      case 'backup.preview':
      case 'backup.recover':
      case 'backup.repreview':
      case 'backup.stage':
      case 'backup.chooseFolder': {
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Personal backup requires the desktop window')
        const backup = this.dependencies.personalBackup
        if (!backup) throw failure('FAILED', 'Personal backup unavailable')
        switch (request.name) {
          case 'backup.export':
            return backup.export(request.payload, signal)
          case 'backup.preview':
            return backup.preview(signal)
          case 'backup.recover':
            return backup.recoverPreview(signal)
          case 'backup.repreview':
            return backup.repreview(request.payload, signal)
          case 'backup.stage': {
            const result = await backup.stage(request.payload, signal)
            this.changed()
            return result
          }
          case 'backup.chooseFolder':
            return backup.chooseFolder(signal)
        }
        break
      }
      case 'library.duplicates.start':
      case 'library.duplicates.cancel':
      case 'library.duplicates.status':
      case 'library.duplicates.groups':
      case 'library.duplicates.items':
      case 'library.duplicates.unavailable': {
        const duplicates = this.dependencies.duplicates
        if (!duplicates) throw failure('FAILED', 'Duplicate inspection unavailable')
        switch (request.name) {
          case 'library.duplicates.start':
          case 'library.duplicates.cancel':
            if (identity.role !== 'desktop')
              throw failure('FORBIDDEN', 'Duplicate inspection requires the desktop window')
            return request.name === 'library.duplicates.start'
              ? duplicates.start()
              : duplicates.cancel(request.payload.id)
          case 'library.duplicates.status':
            return duplicates.snapshot()
          case 'library.duplicates.groups':
            return duplicates.groups(request.payload)
          case 'library.duplicates.items':
            return duplicates.items(request.payload)
          case 'library.duplicates.unavailable':
            return duplicates.unavailable(request.payload)
        }
        break
      }
      case 'playlists.repair':
      case 'playlists.repair.status': {
        const playlists = this.dependencies.playlists
        if (!playlists) throw failure('FAILED', 'Playlists unavailable')
        if (request.name === 'playlists.repair.status') return playlists.repairSnapshot()
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'File management requires the desktop window')
        return playlists.startRepair(
          request.payload.id,
          request.payload.revision,
          request.payload.folder,
          signal
        )
      }
      case 'library.selection.open':
      case 'library.selection.page':
      case 'library.selection.close':
      case 'library.remove':
      case 'library.reset':
      case 'library.exclusions.clear':
      case 'library.tags.write':
      case 'library.tags.restore': {
        const maintenance = this.dependencies.libraryMaintenance
        if (!maintenance) throw failure('FAILED', 'Library maintenance unavailable')
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'File management requires the desktop window')
        switch (request.name) {
          case 'library.selection.open':
            return maintenance.open(request.payload, signal)
          case 'library.selection.page':
            return maintenance.page(
              request.payload.id,
              request.payload.cursor,
              request.payload.projection
            )
          case 'library.selection.close':
            return maintenance.close(request.payload.id)
          case 'library.remove':
            return maintenance.remove(request.payload.selectionId, request.payload.mode, signal)
          case 'library.reset':
            return maintenance.reset(request.payload.revision, signal)
          case 'library.exclusions.clear':
            return maintenance.clearExclusions(
              request.payload.revision,
              request.payload.paths,
              signal
            )
          case 'library.tags.write':
            return maintenance.writeTags(request.payload, signal)
          case 'library.tags.restore':
            return maintenance.restoreTags(request.payload.selectionId, signal)
        }
        break
      }
      case 'settings.state':
      case 'settings.edit': {
        const settings = this.dependencies.settings
        if (!settings) throw failure('FAILED', 'Settings runtime unavailable')
        return request.name === 'settings.state'
          ? settings.state()
          : settings.edit(request.payload, signal)
      }
      case 'automix.capabilities':
        if (!this.dependencies.autoMix) throw failure('FAILED', 'AutoMix is unavailable')
        return this.dependencies.autoMix.capabilities(request.payload.refresh === true)
      case 'sleep.state':
      case 'sleep.configure':
      case 'sleep.cancel': {
        const timer = this.dependencies.sleepTimer
        if (!timer) throw failure('FAILED', 'Sleep timer unavailable')
        if (request.name === 'sleep.state') return timer.state()
        if (request.name === 'sleep.configure') return timer.configure(request.payload, signal)
        return timer.cancel(request.payload.revision, signal)
      }
      case 'cast.state':
      case 'cast.devices':
      case 'cast.discover':
      case 'cast.start':
      case 'cast.end': {
        const cast = this.dependencies.cast
        if (!cast) throw failure('FAILED', 'Cast runtime unavailable')
        if (request.name === 'cast.state') return cast.state()
        if (request.name === 'cast.devices')
          return cast.page(request.payload.offset, request.payload.limit)
        if (request.name === 'cast.discover') return cast.discover()
        if (request.name === 'cast.start') return playback.startCast(request.payload, signal)
        return playback.endCast(request.payload.revision)
      }
      case 'remote.status':
      case 'remote.setEnabled':
      case 'remote.decidePairing':
      case 'remote.revokeDevice':
      case 'remote.rotatePin': {
        const remote = this.dependencies.remote
        if (!remote) throw failure('NOT_READY', 'Remote control is unavailable')
        if (request.name === 'remote.status') return remote.status()
        if (request.name === 'remote.setEnabled') return remote.setEnabled(request.payload.enabled)
        if (request.name === 'remote.decidePairing') return remote.decidePairing(request.payload.requestId, request.payload.allow)
        if (request.name === 'remote.revokeDevice') return remote.revokeDevice(request.payload.id)
        return remote.rotatePin()
      }
      case 'audio.recovery':
      case 'audio.recovery.start': {
        const recovery = this.dependencies.audioRecovery
        if (!recovery) throw failure('NOT_READY', 'Audio recovery is unavailable')
        if (request.name === 'audio.recovery') return recovery.state()
        if (identity.role !== 'desktop' || !identity.permissions.includes('playback:write'))
          throw failure('FORBIDDEN', 'Audio recovery requires the desktop playback controller')
        return recovery.start(request.payload.kind)
      }
      case 'audio.outputTest':
      case 'audio.outputTest.play':
      case 'audio.outputTest.stop': {
        const test = this.dependencies.outputTest
        if (!test) throw failure('FAILED', 'Output test runtime unavailable')
        if (request.name === 'audio.outputTest') return test.state()
        if (identity.role !== 'desktop') throw failure('FORBIDDEN', '试听仅可从主窗口发起')
        if (request.name === 'audio.outputTest.stop') return test.stop()
        return test.play(request.payload.revision, request.payload.exclusive, signal)
      }
      case 'audio.audition':
      case 'audio.audition.measure':
      case 'audio.audition.select':
      case 'audio.audition.end': {
        const audition = this.dependencies.audition
        if (!audition) throw failure('FAILED', 'DSP audition runtime unavailable')
        switch (request.name) {
          case 'audio.audition':
            return audition.state()
          case 'audio.audition.measure':
            return audition.measure(request.payload, signal)
          case 'audio.audition.select':
            return audition.select(
              request.payload.revision,
              request.payload.id,
              request.payload.side,
              signal
            )
          case 'audio.audition.end':
            return audition.end(request.payload.revision, signal)
        }
        break
      }
      case 'audio.dsp':
      case 'audio.dsp.status':
      case 'audio.dsp.assets':
      case 'audio.dsp.correction':
      case 'audio.dsp.edit':
      case 'audio.dsp.import':
      case 'audio.dsp.export':
      case 'audio.dsp.assetRemove':
      case 'audio.vst3':
      case 'audio.vst3.parameters':
      case 'audio.vst3.edit':
      case 'audio.vst3.chooseDirectory': {
        const dsp = this.dependencies.dsp
        if (!dsp) throw failure('FAILED', 'DSP runtime unavailable')
        switch (request.name) {
          case 'audio.dsp':
            return dsp.state()
          case 'audio.dsp.status':
            return dsp.status()
          case 'audio.dsp.assets':
            return dsp.assets(request.payload.offset, request.payload.limit)
          case 'audio.dsp.correction':
            return dsp.correction(request.payload.id)
          case 'audio.dsp.edit':
            return dsp.edit(request.payload, signal)
          case 'audio.dsp.import':
            return dsp.import(request.payload, signal)
          case 'audio.dsp.export':
            return dsp.export(request.payload.revision, request.payload.name, signal)
          case 'audio.dsp.assetRemove':
            return dsp.removeAsset(request.payload.revision, request.payload.id, signal)
          case 'audio.vst3':
            return dsp.vst3(request.payload.offset, request.payload.limit)
          case 'audio.vst3.parameters':
            return dsp.parameters(
              request.payload.id,
              request.payload.revision,
              request.payload.offset,
              request.payload.limit
            )
          case 'audio.vst3.edit':
            return dsp.editVst3(request.payload, signal)
          case 'audio.vst3.chooseDirectory':
            return dsp.chooseDirectory(signal)
        }
        break
      }
      case 'audio.output':
      case 'audio.profiles':
      case 'audio.output.edit':
      case 'audio.profiles.edit': {
        const output = this.dependencies.output
        if (!output) throw failure('FAILED', 'Audio output runtime unavailable')
        switch (request.name) {
          case 'audio.output':
            return output.state()
          case 'audio.profiles':
            return output.profiles()
          case 'audio.output.edit':
            return output.edit(request.payload, signal)
          case 'audio.profiles.edit':
            return output.editProfiles(request.payload, signal)
        }
        break
      }
      case 'cache.info':
      case 'cache.clear': {
        const cache = this.dependencies.cache
        if (!cache) throw failure('FAILED', 'Music cache runtime unavailable')
        return request.name === 'cache.info' ? cache.info() : cache.clear(signal)
      }
      case 'search.songs':
      case 'search.collections':
        if (request.payload.scope !== 'local' && !identity.permissions.includes('providers:call'))
          throw failure('FORBIDDEN', 'Search provider access is not granted')
        if (!this.dependencies.search) throw failure('FAILED', 'Search runtime unavailable')
        return request.name === 'search.songs'
          ? this.dependencies.search.page(request.payload, signal)
          : this.dependencies.search.collections(request.payload, signal)
      case 'downloads.state':
      case 'downloads.page':
      case 'downloads.create':
      case 'downloads.cancel':
      case 'downloads.retry':
      case 'downloads.result':
      case 'downloads.reveal':
      case 'downloads.indexed':
      case 'downloads.play': {
        const downloads = this.dependencies.downloads
        if (!downloads) throw failure('FAILED', 'Download runtime unavailable')
        switch (request.name) {
            case 'downloads.indexed':
              return downloads.indexed(request.payload.id)
            case 'downloads.reveal':
              return downloads.reveal(request.payload.id)
          case 'downloads.state':
            return downloads.state()
          case 'downloads.page':
            return downloads.page(request.payload)
          case 'downloads.create':
            return downloads.create(request.payload)
          case 'downloads.cancel':
            return downloads.cancel(request.payload.id)
          case 'downloads.retry':
            return downloads.retry(request.payload.id)
          case 'downloads.result':
            if (request.payload.addToLibrary && !identity.permissions.includes('library:write'))
              throw failure('FORBIDDEN', 'Library write capability is not granted')
            return downloads.result(request.payload.id, request.payload.addToLibrary)
          case 'downloads.play': {
            if (!identity.permissions.includes('downloads:read'))
              throw failure('FORBIDDEN', 'Download access is not granted')
            return playback.fromTrack(
              () => downloads.playbackTrack(request.payload.id),
              0,
              request.payload.play !== false,
              signal
            )
          }
        }
        break
      }
      case 'network.state':
      case 'network.profiles':
      case 'network.profiles.edit':
      case 'network.directory':
      case 'network.library':
      case 'network.test':
      case 'network.job':
      case 'network.removeEntry':
      case 'network.cover':
      case 'network.cacheInfo':
      case 'network.clearCache':
      case 'network.play': {
        const network = this.dependencies.network
        if (!network) throw failure('FAILED', 'Network runtime unavailable')
        switch (request.name) {
          case 'network.state':
            return network.state()
          case 'network.profiles':
            return network.listProfiles(request.payload)
          case 'network.profiles.edit':
            return network.edit(request.payload, signal)
          case 'network.directory':
            return network.directory(request.payload, signal)
          case 'network.library':
            return network.library(request.payload)
          case 'network.test':
            return network.test(request.payload.profileId, signal)
          case 'network.job':
            return network.job(request.payload)
          case 'network.removeEntry':
            return network.removeEntry(request.payload, signal)
          case 'network.cover':
            return network.cover(request.payload.profileId, request.payload.entryId)
          case 'network.cacheInfo':
            return network.cacheInfo()
          case 'network.clearCache':
            if (this.dependencies.cache) return this.dependencies.cache.clearNetwork(signal)
            return network.clearCache((action) => playback.maintainSources(action), signal)
          case 'network.play': {
            if (!identity.permissions.includes('library:read'))
              throw failure('FORBIDDEN', 'Network library access is not granted')
            return playback.fromTrack(
              (preparation) => network.playback(request.payload, preparation),
              0,
              request.payload.play !== false,
              signal,
              () => network.assertRevision(request.payload.revision)
            )
          }
        }
        break
      }
      case 'streams.state':
      case 'radio.stations':
      case 'radio.directory':
      case 'radio.edit':
      case 'podcasts.subscriptions':
      case 'podcasts.episodes':
      case 'podcasts.subscribe':
      case 'podcasts.edit':
      case 'podcasts.refresh':
      case 'podcasts.defaultRate':
      case 'streams.play': {
        const streams = this.dependencies.streams
        if (!streams) throw failure('FAILED', 'Streams runtime unavailable')
        switch (request.name) {
          case 'streams.state':
            return streams.state()
          case 'radio.stations':
            return streams.stations(request.payload)
          case 'radio.directory':
            return streams.searchDirectory(request.payload, signal)
          case 'radio.edit':
            return streams.radioEdit(request.payload, signal)
          case 'podcasts.subscriptions':
            return streams.subscriptions(request.payload)
          case 'podcasts.episodes':
            return streams.episodes(request.payload.id, request.payload)
          case 'podcasts.subscribe':
            return streams.subscribe(request.payload.feedUrl, request.payload.revision, signal)
          case 'podcasts.edit':
            return streams.podcastEdit(request.payload, signal)
          case 'podcasts.refresh':
            streams.assertPodcastRevision(request.payload.revision)
            return streams.startRefresh(request.payload.id)
          case 'podcasts.defaultRate':
            return streams.setDefaultRate(request.payload.rate, request.payload.revision, signal)
          case 'streams.play': {
            if (!identity.permissions.includes('library:read'))
              throw failure('FORBIDDEN', 'Stream library access is not granted')
            const source = streams.playback(request.payload)
            return playback.fromTrack(
              source.track,
              source.position,
              request.payload.play !== false,
              signal,
              () => {
                streams.playback(request.payload)
              }
            )
          }
        }
        break
      }
      case 'playback.rate': {
        const podcast = playback.snapshot().track?.source === 'podcast'
        await playback.setRate(request.payload.rate)
        const streams = this.dependencies.streams
        if (podcast && streams)
          await streams.setDefaultRate(
            request.payload.rate,
            streams.state().preferencesRevision,
            signal
          )
        return
      }
      case 'workspace.state':
      case 'workspace.sessions':
      case 'workspace.history':
      case 'workspace.restore':
      case 'workspace.edit': {
        const workspace = this.dependencies.workspace
        if (!workspace) throw failure('FAILED', 'Queue workspace runtime unavailable')
        switch (request.name) {
          case 'workspace.state':
            return workspace.state()
          case 'workspace.sessions':
            return workspace.sessions(request.payload)
          case 'workspace.history':
            return workspace.history(request.payload)
          case 'workspace.restore':
            if (!identity.permissions.includes('library:read'))
              throw failure('FORBIDDEN', 'Library read capability is not granted')
            return workspace.restore(request.payload, signal)
          case 'workspace.edit':
            if (
              !identity.permissions.includes('playback:read') &&
              request.payload.edit.kind === 'saveCurrent'
            )
              throw failure('FORBIDDEN', 'Playback read capability is not granted')
            return workspace.edit(request.payload, signal)
        }
        break
      }
      case 'lyrics.state':
      case 'lyrics.current':
      case 'lyrics.entry':
      case 'lyrics.search':
      case 'lyrics.edit':
      case 'lyrics.reload':
      case 'lyrics.importDraft':
      case 'lyrics.exportDraft': {
        const lyrics = this.dependencies.lyrics
        if (!lyrics) throw failure('FAILED', 'Lyrics runtime unavailable')
        switch (request.name) {
          case 'lyrics.state':
            return lyrics.state()
          case 'lyrics.current':
            return lyrics.content()
          case 'lyrics.entry':
            return lyrics.entry(request.payload.trackId)
          case 'lyrics.search':
            return lyrics.search(request.payload, signal)
          case 'lyrics.edit':
            return lyrics.edit(request.payload, signal)
          case 'lyrics.reload':
            return lyrics.reload(request.payload)
          case 'lyrics.importDraft':
          case 'lyrics.exportDraft':
            if (identity.role !== 'desktop')
              throw failure('FORBIDDEN', 'Lyrics dialogs require the desktop client')
            return request.name === 'lyrics.importDraft'
              ? lyrics.importDraft(signal)
              : lyrics.exportDraft(request.payload.contents, signal)
        }
        break
      }
      case 'bookmarks.state':
        if (!this.dependencies.bookmarks) throw failure('FAILED', 'Bookmark runtime unavailable')
        return this.dependencies.bookmarks.state()
      case 'bookmarks.page':
        if (!this.dependencies.bookmarks) throw failure('FAILED', 'Bookmark runtime unavailable')
        return this.dependencies.bookmarks.page(request.payload)
      case 'bookmarks.edit':
        if (!this.dependencies.bookmarks) throw failure('FAILED', 'Bookmark runtime unavailable')
        return this.dependencies.bookmarks.edit(request.payload, signal)
      case 'bookmarks.seek': {
        if (!identity.permissions.includes('library:read'))
          throw failure('FORBIDDEN', 'Bookmark access is not granted')
        if (!this.dependencies.bookmarks) throw failure('FAILED', 'Bookmark runtime unavailable')
        return playback.seek(
          this.dependencies.bookmarks.position(
            request.payload.id,
            request.payload.revision,
            request.payload.current
          )
        )
      }
      case 'imports.previews':
      case 'imports.preview':
      case 'imports.previewPage':
      case 'imports.previewChoices':
      case 'imports.previewStart':
      case 'imports.previewFile':
      case 'imports.previewConfigure':
      case 'imports.previewSave':
      case 'imports.previewDiscard': {
        const previews = this.dependencies.importPreviews
        if (!previews) throw failure('FAILED', 'Playlist preview runtime unavailable')
        if (request.name === 'imports.previewFile' && identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'File selection requires a desktop window')
        return executePreviewOperation(previews, request, signal)
      }
      case 'imports.status': {
        const status = this.dependencies.imports?.status(request.payload.id)
        return status
          ? { ...status, error: status.error ? projectCoreError(status.error) : null }
          : null
      }
      case 'imports.bind':
      case 'imports.previewBind': {
        const resolve = this.dependencies.resolvePlaylistInputs
        if (!resolve) throw failure('NOT_READY', 'Track sources are unavailable')
        const { id, revision, entryId, input } = request.payload
        const track = input ? (await resolve([input], signal))[0] : null
        if (request.name === 'imports.previewBind') {
          if (!this.dependencies.importPreviews) throw failure('NOT_READY', 'Import previews are unavailable')
          return this.dependencies.importPreviews.bind(id, revision, entryId, track)
        }
        if (!this.dependencies.playlists) throw failure('NOT_READY', 'Playlists are unavailable')
        return this.dependencies.playlists.edit(revision, { kind: 'importBind', id, entryId, track }, signal)
      }
      case 'playlists.replaceSource':
      case 'playlists.rematch': {
        const sources = this.dependencies.playlistSources
        if (!sources) throw failure('NOT_READY', 'Playlist source matching is unavailable')
        return request.name === 'playlists.replaceSource'
          ? sources.replace(request.payload.revision, request.payload.oldTrackId, request.payload.input, signal)
          : sources.rematch(request.payload.revision, request.payload.input, signal)
      }
      case 'library.reveal': {
        if (!this.dependencies.revealAudioFile) throw failure('NOT_READY', 'File reveal is unavailable')
        const page = await this.dependencies.library.getTracksByIds([request.payload.id])
        const track = page.tracks[0]
        if (!track) throw failure('FAILED', '本地曲目已不存在')
        if (request.payload.version !== undefined && page.versions[track.id] !== request.payload.version)
          throw failure('STALE_REVISION', '曲目信息已变化，请刷新后重试')
        if (track.source && track.source !== 'local') throw failure('FAILED', '此曲目没有本地文件')
        return this.dependencies.revealAudioFile(track.filePath)
      }
      case 'imports.retry':
        if (!this.dependencies.imports) throw failure('FAILED', 'Playlist matching unavailable')
        return this.dependencies.imports.start(
          request.payload.id,
          request.payload.force,
          request.payload.entries
        )
      case 'imports.cancel':
        await this.dependencies.importPreviews?.cancel(request.payload.id)
        return this.dependencies.imports?.stop(request.payload.id)
      case 'playlists.view':
        if (!this.dependencies.playlists) throw failure('FAILED', 'Playlist runtime unavailable')
        return this.dependencies.playlists.view(request.payload, signal)
      case 'versions.catalog':
        if (!this.dependencies.recordingCatalog) throw failure('NOT_READY', 'Recording sources are unavailable')
        return this.dependencies.recordingCatalog.page(request.payload, signal)
      case 'playlists.favorites': {
        const { playlists, resolvePlaylistInputs } = this.dependencies
        if (!playlists || !resolvePlaylistInputs) throw failure('NOT_READY', 'Playlists are unavailable')
        const tracks = await resolvePlaylistInputs(request.payload.items, signal)
        return playlists.favorites(request.payload.revision, tracks)
      }
      case 'versions.page':
        if (!this.dependencies.recordingVersions)
          throw failure('FAILED', 'Recording versions unavailable')
        return this.dependencies.recordingVersions.page(request.payload)
      case 'versions.edit':
        if (!this.dependencies.recordingVersions)
          throw failure('FAILED', 'Recording versions unavailable')
        return this.dependencies.recordingVersions.edit(request.payload, signal)
      case 'playlists.list':
        if (!this.dependencies.playlists) throw failure('FAILED', 'Playlist runtime unavailable')
        return this.dependencies.playlists.list(
          request.payload.offset,
          request.payload.limit,
          request.payload.revision
        )
      case 'playlists.entries':
        if (!this.dependencies.playlists) throw failure('FAILED', 'Playlist runtime unavailable')
        return this.dependencies.playlists.entries(
          request.payload.id,
          request.payload.revision,
          request.payload.offset,
          request.payload.limit
        )
      case 'playlists.edit':
        if (!this.dependencies.playlists) throw failure('FAILED', 'Playlist runtime unavailable')
        return this.dependencies.playlists.edit(
          request.payload.revision,
          request.payload.edit,
          signal
        )
      case 'playlists.catalog':
      case 'playlists.collection':
      case 'playlists.members':
      case 'playlists.membership':
      case 'playlists.state':
      case 'playlists.export':
      case 'playlists.importDocument':
      case 'playlists.flush':
        if (!this.dependencies.playlists) throw failure('NOT_READY', 'Playlists are unavailable')
        return executePlaylistProjection(this.dependencies.playlists, request, signal)
      case 'providers.call': {
        if (!this.dependencies.plugins) throw failure('FAILED', 'Provider runtime unavailable')
        const { providerId, method, args, idempotencyKey } = request.payload
        if (providerId === 'ncm' && method === 'logout')
          await this.dependencies.cloudTransfers?.observeAccount(null)
        const result = await this.dependencies.plugins.callProvider(providerId, method, args, {
          signal,
          idempotencyKey
        })
        if (
          providerId === 'ncm' &&
          ['checkLogin', 'openOfficialLogin', 'getProfile'].includes(method)
        ) {
          const value = result as {
            loggedIn?: boolean
            profile?: { userId?: number }
            userId?: number
          } | null
          const userId =
            method === 'getProfile' ? value?.userId : value?.loggedIn ? value.profile?.userId : null
          if (userId === null || typeof userId === 'number')
            await this.dependencies.cloudTransfers?.observeAccount(userId)
        }
        return result
      }
      case 'extensions.experiences':
      case 'extensions.resource':
      case 'extensions.stylesheet':
      case 'extensions.preferences':
      case 'extensions.preferences.edit':
      case 'extensions.document':
      case 'extensions.document.edit':
      case 'extensions.music':
      case 'extensions.export': {
        const experiences = this.dependencies.pluginExperiences
        if (!experiences) throw failure('FAILED', 'Plugin experiences unavailable')
        switch (request.name) {
          case 'extensions.experiences': return experiences.list()
          case 'extensions.resource': return experiences.resource(request.payload.url)
          case 'extensions.stylesheet': return experiences.stylesheet(request.payload.pluginId, request.payload.themeId)
          case 'extensions.preferences': return experiences.preferences(request.payload.id)
          case 'extensions.preferences.edit': return experiences.preferences(request.payload.id, request.payload.value)
          case 'extensions.document': return experiences.document(request.payload.id)
          case 'extensions.document.edit': return experiences.document(request.payload.id, request.payload.update)
          case 'extensions.music': return experiences.music(request.payload.id, request.payload.operation, request.payload.args)
          case 'extensions.export': return experiences.export(request.payload.id, request.payload.name, request.payload.content)
        }
        break
      }
      case 'extensions.pluginRequest': {
        if (!this.dependencies.plugins) throw failure('FAILED', 'Plugin runtime unavailable')
        const { id, request: pluginRequest } = request.payload
        if (typeof id !== 'string' || !id || id.length > 128)
          throw failure('INVALID_REQUEST', 'Invalid plugin id')
        if (pluginRequest === undefined || typeof pluginRequest !== 'object')
          throw failure('INVALID_REQUEST', 'Invalid plugin request')
        return this.dependencies.plugins.callExperienceRequest(id, pluginRequest)
      }
      case 'plugins.installSource':
        if (!this.dependencies.plugins) throw failure('FAILED', 'Plugin runtime unavailable')
        return this.dependencies.plugins.installFromPath(request.payload.path)
      case 'plugins.index.list':
      case 'plugins.index.refresh':
        if (!this.dependencies.pluginMarketplace) throw failure('FAILED', 'Plugin market unavailable')
        return this.dependencies.pluginMarketplace.list(request.name === 'plugins.index.refresh')
      case 'plugins.index.status':
        if (!this.dependencies.pluginMarketplace) throw failure('FAILED', 'Plugin market unavailable')
        return this.dependencies.pluginMarketplace.status()
      case 'plugins.index.install':
        if (!this.dependencies.pluginMarketplace) throw failure('FAILED', 'Plugin market unavailable')
        return this.dependencies.pluginMarketplace.install(request.payload.id)
      case 'plugins.list':
        return this.dependencies.plugins?.list() ?? []
      case 'providers.list':
        return this.dependencies.plugins?.listProviders() ?? []
      case 'extensions.list':
        return this.dependencies.plugins?.listExtensions() ?? []
      case 'plugins.enable':
      case 'plugins.disable':
      case 'plugins.uninstall':
      case 'plugins.install':
      case 'plugins.dspParameters':
      case 'plugins.log':
      case 'plugins.showLog':
      case 'extensions.execute': {
        const plugins = this.dependencies.plugins
        if (!plugins) throw failure('FAILED', 'Plugin runtime unavailable')
        return executePluginOperation(plugins, request)
      }
      case 'statistics.summary':
        return this.dependencies.statistics.summary()
      case 'statistics.overview':
        return this.dependencies.statistics.overview(signal)
      case 'statistics.previewClear':
        return this.dependencies.statistics.previewClear(request.payload.range, request.payload.revision)
      case 'statistics.tracks':
        return this.dependencies.statistics.projectPage ? this.dependencies.statistics.projectPage(request.payload, signal) : this.dependencies.statistics.page(request.payload)
      case 'statistics.clear':
        return this.dependencies.statistics.clear(request.payload.range, request.payload.revision)
      case 'state.snapshot':
        return this.snapshot(identity)
      case 'scan.status':
        return projectCoreScan(this.dependencies.scan.snapshot())
      case 'scan.watchers':
        return this.dependencies.libraryBackground?.snapshot() ?? { enabled: false, folders: [] }
      case 'metadata.status':
        return this.dependencies.metadata?.snapshot() ?? null
      case 'metadata.entity.policy':
      case 'identification.start':
      case 'identification.status':
      case 'identification.detail':
      case 'identification.candidates':
      case 'identification.history':
      case 'identification.restorePreview':
      case 'identification.restore':
      case 'metadata.entity.sources':
      case 'metadata.entity.requery':
      case 'identification.inbox':
      case 'identification.preview':
      case 'identification.decide':
      case 'identification.detach':
      case 'metadata.entity.detail':
      case 'metadata.entity.jobs':
      case 'metadata.entity.tasks':
      case 'metadata.entity.demands':
      case 'metadata.entity.credits':
      case 'metadata.entity.resolve':
      case 'metadata.entity.enrich':
      case 'metadata.entity.decide':
      case 'metadata.entity.detach':
      case 'metadata.entity.override':
      case 'metadata.entity.sourcePreference':
      case 'metadata.entity.artworkOverride':
      case 'metadata.entity.cancel': {
        const service = this.dependencies.metadata?.entities
        if (!service) throw failure('NOT_READY', 'Entity metadata service is unavailable')
        switch (request.name) {
          case 'identification.start': return service.startIdentification(request.payload)
          case 'identification.status': return service.identificationStatus()
          case 'identification.detail': return service.identity(request.payload.entityId)
          case 'identification.candidates': return service.candidates(request.payload)
          case 'identification.history': return service.history(request.payload)
          case 'identification.restorePreview': return service.restorePreview(request.payload)
          case 'identification.restore': return service.restoreIdentity(request.payload)
          case 'metadata.entity.sources': return service.taskSources(request.payload)
          case 'metadata.entity.requery': return service.requery(request.payload)
          case 'identification.inbox': return service.inbox(request.payload)
          case 'identification.preview': return service.preview(request.payload)
          case 'identification.decide': return service.decideIdentity(request.payload)
          case 'identification.detach': return service.detachIdentity(request.payload.linkId, request.payload.revision)
          case 'metadata.entity.policy': return service.policy()
          case 'metadata.entity.detail': return service.detail(request.payload.entityId, request.payload.language, request.payload.sourceProvider, request.payload.includeAutomaticArtwork)
          case 'metadata.entity.jobs': return service.jobs(request.payload)
          case 'metadata.entity.tasks': return service.tasks(request.payload)
          case 'metadata.entity.demands': return service.demands(request.payload)
          case 'metadata.entity.credits': return service.credits(request.payload)
          case 'metadata.entity.resolve': return service.resolve(request.payload)
          case 'metadata.entity.enrich': return service.enrich(request.payload)
          case 'metadata.entity.decide': return service.decide(request.payload)
          case 'metadata.entity.detach': return service.detach(request.payload.entityId, request.payload.revision)
          case 'metadata.entity.override': return service.override(request.payload)
          case 'metadata.entity.sourcePreference': return service.sourcePreference(request.payload)
          case 'metadata.entity.artworkOverride': return service.artworkOverride(request.payload)
          case 'metadata.entity.cancel': return service.cancel(request.payload.jobId, request.payload.batchId, request.payload.generation)
        }
        break
      }
      case 'metadata.start':
        if (!this.dependencies.metadata) throw new Error('Metadata service is unavailable')
        this.dependencies.metadata.start()
        return
      case 'metadata.cancel':
        return this.dependencies.metadata?.cancel() ?? false
      case 'metadata.candidates':
        if (!this.dependencies.metadata) throw new Error('Metadata service is unavailable')
        return this.dependencies.metadata.find(request.payload.id, request.payload.version, signal)
      case 'metadata.apply':
        if (!this.dependencies.metadata) throw new Error('Metadata service is unavailable')
        return this.dependencies.metadata.apply(
          request.payload.token,
          request.payload.index,
          signal
        )
      case 'metadata.clear':
        if (!this.dependencies.metadata) throw new Error('Metadata service is unavailable')
        return this.dependencies.metadata.clear(request.payload.id, request.payload.version, signal)
      case 'scan.start':
        return projectCoreScan(await this.dependencies.scan.start(request.payload, signal))
      case 'scan.pause':
        return this.dependencies.scan.pause(request.payload.jobId)
      case 'scan.resume':
        return projectCoreScan(await this.dependencies.scan.resume(request.payload.jobId))
      case 'scan.cancel':
        return this.dependencies.scan.cancel(request.payload.jobId)
      case 'library.metadata':
        return this.dependencies.library.getMetadata()
      case 'audio.diagnostics':
        if (!this.dependencies.diagnostics) throw failure('NOT_READY', 'Audio diagnostics are unavailable')
        return this.dependencies.diagnostics.report(request.payload.locale)
      case 'library.artwork':
        if (!this.dependencies.artwork) throw failure('NOT_READY', 'Artwork is unavailable')
        return executeLibraryArtwork(
          this.dependencies.library,
          request.payload,
          this.dependencies.artwork,
          signal,
          (ids, currentSignal) => this.resolveFallbackArtworkTracks(ids, currentSignal)
        )
      case 'library.collections': {
        const entities = this.dependencies.metadata?.entities
        const platformContexts = entities?.platformContexts() ?? {}
        const page = await executeLibraryRead(this.dependencies.library, request, { platformContexts, now: Date.now() })
        if (JSON.stringify(platformContexts) !== JSON.stringify(entities?.platformContexts() ?? {}))
          throw failure('STALE_REVISION', '资料授权已变化，请重新读取')
        return page
      }
      case 'library.byIds':
      case 'library.paths.lookup':
        return executeLibraryRead(this.dependencies.library, request)
      case 'library.recent.resolve': {
        const versions = this.dependencies.recordingVersions
        if (!versions) throw failure('NOT_READY', 'Recording versions unavailable')
        const versionsRevision = versions.getRevision()
        if (request.payload.versionsRevision !== versionsRevision)
          throw failure('STALE_REVISION', '版本记录已变化，请刷新最近播放')
        const versionSnapshot = versions.snapshot()
        const result = await this.dependencies.library.lookupPlaylistTracks(
          {
            entries: request.payload.entries,
            versions: versionSnapshot.tracks.versions,
            resolution: 'recent'
          },
          request.payload.revision
        )
        if (versions.getRevision() !== versionsRevision)
          throw failure('STALE_REVISION', '版本记录已变化，请刷新最近播放')
        return { ...result, versionsRevision }
      }
      case 'library.tracks': {
        const page = await this.dependencies.library.queryTracks(request.payload)
        return { ...page, tracks: page.tracks.map((track) => projectCoreTrack(track)) }
      }
      case 'queue.page': {
        const { id, revision, offset, limit, search } = request.payload
        const page = await this.dependencies.library.readLibraryQueue(id, offset, limit, {
          expectedRevision: revision,
          search
        })
        return {
          ...page,
          items: page.items.map((item) => ({
            position: item.position,
            queueEntryId: item.queueEntryId,
            logicalQueueEnd: item.logicalQueueEnd,
            track: item.track ? projectCoreTrack(item.track, item.queueEntryId) : null
          }))
        }
      }
      case 'playback.play':
        return playback.play(nonnegativeOptional(request.payload.position), signal)
      case 'playback.pause':
        return playback.pause()
      case 'playback.stop':
        return playback.stop()
      case 'playback.seek':
        return playback.seek(nonnegative(request.payload.position))
      case 'playback.abLoop':
        return playback.configureAbLoop(request.payload)
      case 'playback.mute':
        return playback.configureMute(request.payload.muted)
      case 'playback.next':
        return playback.navigate(1, signal)
      case 'playback.previous':
        return playback.navigate(-1, signal)
      case 'playback.volume': {
        const volume = nonnegative(request.payload.volume)
        if (volume > 1) throw failure('INVALID_REQUEST', 'Volume exceeds unity')
        await playback.setVolume(volume)
        const actual = playback.snapshot().playback
        if (actual && actual.outputBackend !== 'cast')
          this.dependencies.settings?.rememberVolume(actual.volume)
        return
      }
      case 'playback.mode':
        if (
          !['sequential', 'listLoop', 'repeat', 'shuffle', 'heart'].includes(request.payload.mode)
        )
          throw failure('INVALID_REQUEST', 'Unknown playback mode')
        return playback.setMode(request.payload.mode, signal)
      case 'queue.select':
        return playback.select(request.payload, signal)
      case 'queue.submit':
        if (!this.dependencies.queueSubmission)
          throw failure('NOT_READY', 'Queue submission is unavailable')
        if (identity.role !== 'desktop')
          throw failure('FORBIDDEN', 'Queue submission requires the desktop window')
        return this.dependencies.queueSubmission.submit(identity.id, request.payload)
      case 'playlists.submit':
        if (!this.dependencies.playlistSubmission) throw failure('NOT_READY', 'Playlist submission is unavailable')
        return this.dependencies.playlistSubmission.submit(identity.id, request.payload)
      case 'queue.fromQuery':
        return playback.fromQuery(
          request.payload.query,
          request.payload.selectedId,
          request.payload.play,
          signal,
          {
            position: request.payload.position,
            randomStart: request.payload.randomStart,
            playMode: request.payload.playMode
          }
        )
      case 'queue.edit':
        return playback.edit(request.payload.id, request.payload.revision, request.payload.edit)
      case 'queue.undo':
        return playback.edit(request.payload.id, request.payload.revision, { kind: 'undo' })
      case 'queue.refresh':
        return playback.refresh()
      case 'migration.status':
        return this.dependencies.state.coreStateStatus()
      case 'migration.begin':
        return this.dependencies.state.coreMigrationBegin(
          request.payload.id,
          request.payload.manifest
        )
      case 'migration.stage':
        return this.dependencies.state.coreMigrationStage(
          request.payload.id,
          request.payload.batch,
          request.payload.domain,
          request.payload.rows
        )
      case 'migration.commit': {
        const result = await this.dependencies.state.coreMigrationCommit(request.payload.id)
        this.migrationRequired = !result.complete
        await this.checkReady()
        return result
      }
      case 'migration.abort':
        return this.dependencies.state.coreMigrationAbort(request.payload.id)
      case 'lifecycle.flush':
        await this.dependencies.pluginExperiences?.flush()
        await this.dependencies.sleepTimer?.flush()
        await this.dependencies.settings?.flush()
        await this.dependencies.dsp?.flush()
        await this.dependencies.output?.flush()
        await this.dependencies.cache?.flush()
        await this.dependencies.recordingVersions?.flush()
        await this.dependencies.playlists?.flush()
        await playback.flush()
        await this.dependencies.bookmarks?.flush()
        await this.dependencies.lyrics?.flush()
        await this.dependencies.workspace?.flush()
        await this.dependencies.streams?.flush()
        await this.dependencies.network?.flush()
        return this.dependencies.statistics.flush()
    }
  }
  async shutdown(): Promise<void> {
    await this.dependencies.catalog?.shutdown()
    await this.dependencies.genres?.shutdown()
    await this.dependencies.remote?.shutdown()
    if (this.phase === 'stopped') return
    this.shuttingDown = true
    this.dependencies.plugins?.off('changed', this.pluginsChanged)
    this.dependencies.plugins?.off('notice', this.pluginNotice)
    this.dependencies.plugins?.off('experience-event', this.pluginExperienceEvent)
    await this.dependencies.queueSubmission?.shutdown()
    await this.dependencies.playlistSubmission?.shutdown()
    await this.dependencies.presentation?.shutdown()
    for (const client of this.clients.values())
      for (const controller of client.requests.values())
        controller.abort(new Error('Core shutting down'))
    try {
      await this.dependencies.audioRecovery?.shutdown()
      await this.dependencies.audition?.shutdown()
      await this.dependencies.visualization?.shutdown()
      await this.dependencies.outputTest?.stop()
      await this.dependencies.sleepTimer?.shutdown()
      await this.dependencies.autoMix?.shutdown()
      await this.dependencies.modelPack?.shutdown()
      await this.dependencies.analysis?.shutdown()
      await this.dependencies.libraryLoudness?.shutdown()
      await this.dependencies.downloads?.shutdown()
      await this.dependencies.cloudTransfers?.shutdown()
      await this.dependencies.libraryRepair?.shutdown()
      await this.dependencies.duplicates?.shutdown()
      await this.dependencies.inbox?.shutdown()
      await this.dependencies.libraryHealth?.shutdown()
      await this.dependencies.personalBackup?.shutdown()
      await this.dependencies.settingsBackup?.shutdown()
      await this.dependencies.pluginExperiences?.shutdown()
      await this.dependencies.themes?.shutdown()
      await this.dependencies.libraryMaintenance?.shutdown()
      await Promise.all([
        this.dependencies.search?.shutdown(),
        Promise.allSettled([...this.work, ...(this.readiness ? [this.readiness] : [])]),
        this.dependencies.scan.shutdown(),
        this.dependencies.libraryBackground?.shutdown(),
        this.dependencies.metadata?.shutdown(),
        this.dependencies.lyrics?.shutdown(),
        this.dependencies.streams?.stopRefresh(),
        this.dependencies.network?.shutdown()
      ])
      await this.dependencies.plugins?.broadcastEvent('app:before-quit', {})
      await this.dependencies.settings?.flush()
      await this.dependencies.importPreviews?.shutdown()
      await this.dependencies.imports?.shutdown()
      await this.dependencies.plugins?.destroy()
      await this.dependencies.playlists?.shutdown()
      await this.dependencies.recordingVersions?.flush()
      await this.dependencies.dsp?.shutdown()
      await this.dependencies.output?.shutdown()
      await this.dependencies.playback.shutdown()
      await this.dependencies.diagnostics?.shutdown()
      await this.dependencies.streams?.shutdown()
      await this.dependencies.workspace?.shutdown()
      await this.dependencies.bookmarks?.shutdown()
      await this.dependencies.statistics.shutdown()
      this.phase = 'stopped'
      this.changed()
    } finally {
      this.shuttingDown = false
    }
  }
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw failure('INVALID_REQUEST', 'Expected a finite nonnegative number')
  return value
}
function nonnegativeOptional(value: unknown): number | undefined {
  return value === undefined ? undefined : nonnegative(value)
}

function executePluginOperation(
  plugins: TwilightPluginManager,
  request: Extract<
    CoreRequestEnvelope,
    {
      name:
        | 'plugins.enable'
        | 'plugins.disable'
        | 'plugins.uninstall'
        | 'plugins.install'
        | 'plugins.dspParameters'
        | 'plugins.log'
        | 'plugins.showLog'
        | 'extensions.execute'
    }
  >
): unknown {
  switch (request.name) {
    case 'plugins.enable':
      return plugins.enable(request.payload.id)
    case 'plugins.disable':
      return plugins.disable(request.payload.id)
    case 'plugins.uninstall':
      return plugins.uninstall(request.payload.id, { removeData: request.payload.removeData })
    case 'plugins.install':
      return plugins.chooseAndInstall(request.payload.kind)
    case 'plugins.dspParameters':
      return plugins.setNativeDspPluginParameters(request.payload.id, request.payload.parameters)
    case 'plugins.log':
      return plugins.getLog(request.payload.id)
    case 'plugins.showLog':
      return plugins.openLog(request.payload.id)
    case 'extensions.execute':
      return plugins.executeUiCommand(request.payload.command, request.payload.args)
  }
}

function executePreviewOperation(
  previews: CorePlaylistPreviews,
  request: Extract<
    CoreRequestEnvelope,
    {
      name:
        | 'imports.previews'
        | 'imports.preview'
        | 'imports.previewPage'
        | 'imports.previewChoices'
        | 'imports.previewStart'
        | 'imports.previewFile'
        | 'imports.previewConfigure'
        | 'imports.previewSave'
        | 'imports.previewDiscard'
    }
  >,
  signal: AbortSignal
): unknown {
  switch (request.name) {
    case 'imports.previewChoices':
      return previews.choices(
        request.payload.id,
        request.payload.revision,
        request.payload.kind,
        request.payload.offset,
        request.payload.limit
      )
    case 'imports.previews':
      return previews.list(request.payload.offset, request.payload.limit)
    case 'imports.preview':
      return previews.status(request.payload.id)
    case 'imports.previewPage':
      return previews.page(
        request.payload.id,
        request.payload.revision,
        request.payload.offset,
        request.payload.limit
      )
    case 'imports.previewStart':
      return previews.start(request.payload.link, request.payload.credentials)
    case 'imports.previewFile':
      return previews.file(signal)
    case 'imports.previewConfigure':
      return previews.configure(request.payload)
    case 'imports.previewSave':
      return previews.save(request.payload, signal)
    case 'imports.previewDiscard':
      return previews.discard(request.payload.id, request.payload.revision)
  }
}
