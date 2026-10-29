import '../../adapters-node/index.ts'
import { CoreMusicExplorationService } from '../../core/library/explorationService.ts'
import { networkInterfaces, hostname } from 'node:os'
import { CoreDiscoveryAdvertisement } from '../remote/coreDiscovery.ts'
import { createPersistentDevicePairing, loadRemoteTlsIdentity } from '../remote/deviceTrust.ts'
import { persistentLibraryId } from '../remote/libraryIdentity.ts'
import { RemoteMediaResolver } from '../../core/remote/media.ts'
import { CoreCastService } from '../../core/cast/service.ts'
import { CoreNcmCloudTransferService } from '../../core/ncm/cloudTransferService.ts'
import { RemoteHttpServer } from '../../core/cast/httpServer.ts'
import { createCastBackend } from '../../core/cast/backend.ts'
import { stat, access, readFile } from 'node:fs/promises'
import { CoreLibraryMaintenance } from '../../core/library/maintenanceService.ts'
import { CoreGenresService } from '../../core/library/genresService.ts'
import { CoreMusicRatingsService } from '../../core/library/ratingsService.ts'
import { CoreMusicPreferencesService } from '../../core/library/preferencesService.ts'
import { CoreMusicTagsService } from '../../core/library/tagsService.ts'
import { CoreMusicFocusService } from '../../core/library/focusService.ts'
import { createPreferencesPlaylistRepository } from '../../core/playlists/preferencesRepository.ts'
import { CoreDuplicatesService } from '../../core/library/duplicatesService.ts'
import { createPersonalBackupRepository } from '../../core/persistence/personalBackup.ts'
import { CorePersonalBackupService } from '../../core/persistence/personalBackupService.ts'
import { recoverLocalLibraryRemovalFromDatabase } from '../library/removal.ts'
import { LibraryPlaylistRepairService } from '../../core/library/playlistRepairService.ts'
import { findLibraryPlaylistRelocations } from '../../core/playlists/repairFolder.ts'
import { DspAuditionManager } from '../../core/audio/dspAuditionManager.ts'
import { CoreAuditionService } from '../../core/audio/auditionService.ts'
import { CoreOutputTestService } from '../../core/audio/outputTestService.ts'
import { CoreSettingsService } from '../../core/settings/service.ts'
import { CoreSettingsBackupService } from '../../core/settings/backupService.ts'
import { CoreThemeService } from '../../core/settings/themeService.ts'
import { createSettingsImportEffects } from '../../core/settings/importEffects.ts'
import { ThemeLibraryRepository } from '../../core/persistence/themeLibraryRepository.ts'
import { createDefaultThemeLibraryDocument } from '../../shared/theme.ts'
import { effectiveAutoMixMode } from '../../shared/twilightAutoMix.ts'
import { CORE_SPECIALIZED_SETTINGS, type CoreSettingsEdit } from '../../shared/coreSettings.ts'
import { CorePlaylistService } from '../../core/playlists/service.ts'
import { CoreBookmarksService } from '../../core/bookmarks/service.ts'
import { CoreLyricsService } from '../../core/lyrics/service.ts'
import { CoreWorkspaceService } from '../../core/workspace/service.ts'
import { resolveQueueSession } from '../../core/workspace/restoration.ts'
import { CoreStreamsService } from '../../core/streams/service.ts'
import { CoreNetworkService } from '../../core/network/service.ts'
import { CoreDownloadsService } from '../../core/downloads/service.ts'
import { CoreMusicSearchService } from '../../core/search/service.ts'
import { CoreMusicCacheService } from '../../core/cache/service.ts'
import {
  clearCoreMusicCache,
  getManagedMusicCacheSize
} from '../../core/providers/musicCacheLayout.ts'
import { createDownloadMetadataPreparation } from '../../core/downloads/metadataService.ts'
import { createNetworkProfileStore } from '../../core/network/profileStore.ts'
import { createNetworkLibrary } from '../../core/network/networkLibrary.ts'
import { createWebDavAdapter } from '../../core/network/adapters/webdavAdapter.ts'
import { createFtpAdapter } from '../../core/network/adapters/ftpAdapter.ts'
import { createDlnaAdapter } from '../../core/network/adapters/dlnaAdapter.ts'
import { createSftpSystemAdapter } from '../../core/network/adapters/sftpSystemAdapter.ts'
import {
  createNfsMountAdapter,
  createSmbMountAdapter
} from '../../core/network/adapters/smbMountAdapter.ts'
import { RadioMediaService } from '../../core/streams/radioMediaService.ts'
import {
  isQueueWorkspaceDocument,
  type QueueWorkspaceDocument
} from '../../shared/queueWorkspace.ts'
import { createLocalLyricsLoader } from '../../core/lyrics/localLoader.ts'
import { nodeLocalLyricsFilePort } from '../lyrics/loadLyrics.ts'
import { nodeLyricsFileOperations } from '../lyrics/saveLyrics.ts'
import { resolveLyricsAcrossProviders } from '../../core/lyrics/providerLyrics.ts'
import { fetchAmlTtml } from '../../core/lyrics/amllTtml.ts'
import {
  searchOnlineLyrics,
  assertOnlineLyricsRateLimit
} from '../../core/lyrics/onlineLyricsSearch.ts'
import { importLyricDraft, exportLyricDraft } from '../../core/lyrics/files.ts'
import {
  isLyricsManagementDocument,
  type LyricsManagementDocument
} from '../../shared/lyricsManagement.ts'
import type { LyricProvider, MediaProviderLyrics } from '../../shared/providerLyrics.ts'
import {
  isPlaybackBookmarksDocument,
  type PlaybackBookmarksDocument
} from '../../shared/playbackBookmarks.ts'
import { CorePlaylistImportJobs } from '../../core/playlists/importJobs.ts'
import { CorePlaylistPreviews } from '../../core/playlists/previews.ts'
import { createPlaylistReader, type PlaylistReadProvider } from '../../core/playlists/reader.ts'
import {
  readOfficialPlaylistPage,
  resolveNeteaseShortPlaylistLink
} from '../../core/playlists/platformReader.ts'
import { readPlaylistImportFile } from '../../core/playlists/readFile.ts'
import { createImportLocalCandidates } from '../../core/playlists/importLocalCandidates.ts'
import type { ImportProvider } from '../../core/playlists/importResolver.ts'
import { isPluginProviderEnabled } from '../../shared/providerAvailability.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { CoreRecordingVersions } from '../../core/playlists/recordingVersions.ts'
import { CoreRecordingCatalog } from '../../core/playlists/recordingCatalog.ts'
import { CorePlaylistSourceEdits } from '../../core/playlists/sourceEdits.ts'
import { CoreRemoteService } from '../../core/remote/service.ts'
import { VersionedDataStore } from '../../core/persistence/versionedDataStore.ts'
import type { Playlist } from '../../shared/playlists.ts'
import { libraryTrack } from '../../core/playback/libraryTrack.ts'
import { createNcmApiRuntime } from '../ncm/runtimeAdapter.ts'
import { createNcmCache } from '../../core/providers/ncmCache.ts'
import { join, dirname, basename } from 'node:path'
import { resolve } from 'node:path'
import type { LibraryQuery } from '../../shared/libraryDatabase.ts'
import type { CorePlaylistEdit } from '../../shared/corePlaylists.ts'
import type { TrackData } from '../../shared/track.ts'
import { CoreSettingsRepository } from '../../core/persistence/settingsRepository.ts'
import { applyDevelopmentMetadataSetup } from './developmentMetadataSetup.ts'
import { CoreAudioOutputService } from '../../core/audio/outputService.ts'
import { CoreDspService } from '../../core/audio/dspService.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import { Vst3CatalogService } from '../../core/audio/vst3Catalog.ts'
import {
  coreAudioConfiguration,
  createCoreAudioPersistence,
  initialAudioSettings
} from '../../core/audio/settings.ts'
import { CoreApplication } from '../../core/application.ts'
import { CoreInboxService } from '../../core/library/inboxService.ts'
import { CoreLibraryHealthService } from '../../core/library/libraryHealthService.ts'
import { CoreAnalysisService } from '../../core/audio/analysisService.ts'
import { CoreLibraryLoudnessService } from '../../core/audio/libraryLoudnessService.ts'
import { CorePlaybackSession, type CoreSessionRepository } from '../../core/playback/session.ts'
import { CoreQueueSubmission } from '../../core/playback/queueSubmission.ts'
import { CoreCatalogService } from '../../core/catalog/service.ts'
import { CoreAlbumBrowseService } from '../../core/library/albumBrowseService.ts'
import { CoreUnifiedPlaybackService } from '../../core/catalog/unifiedPlayback.ts'
import { CoreCatalogPlaybackScope } from '../../core/catalog/playbackScope.ts'
import { CorePlaylistSubmission, createPlaylistInputResolver } from '../../core/playlists/submission.ts'
import { CoreAudioDiagnosticsService } from '../../core/audio/diagnosticsService.ts'
import { CorePlayerPresentationService } from '../../core/playback/presentationService.ts'
import { createQueueInputResolver } from '../../core/playback/queueInputResolver.ts'
import { authorizeNativeSource } from '../../core/playback/sourceResolver.ts'
import { CoreSleepTimer } from '../../core/playback/sleepService.ts'
import { CoreAutoMixService } from '../../core/audio/autoMixService.ts'
import { CoreModelPackService } from '../../core/audio/modelPackService.ts'
import { OpraCatalog } from '../../core/audio/opraCatalog.ts'
import { CoreVisualizationService } from '../../core/audio/visualizationService.ts'
import { createPlaybackSourceRecovery } from '../../core/playback/sourceRecovery.ts'
import { SourceResources } from '../../core/playback/sourceResources.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { CoreScanService } from '../../core/library/scanService.ts'
import { CoreLibraryBackground } from '../../core/library/background.ts'
import { CoreMetadataService } from '../../core/library/metadataService.ts'
import { MusicBrainzWikiProvider, MusicBrainzDetailsProvider } from '../../core/library/entityMetadataProvider.ts'
import { PublicMusicSource } from '../../core/library/publicMusicSources.ts'
import { metadataConfiguration } from './metadataConfiguration.ts'
import { NCM_PUBLIC_METADATA_CONFIGURATION } from '../../shared/metadataCacheContext.ts'
import { publicMetadataSources } from '../../shared/metadataProviders.ts'
import { MusicBrainzIdentificationProvider, PlatformIdentificationProvider } from '../../core/library/musicIdentificationProvider.ts'
import { resolveLocale } from '../../shared/i18n/locale.ts'
import { IdentificationResponseCache } from '../../core/library/identificationResponseCache.ts'
import { PlatformMetadataProvider } from '../../core/library/platformMetadataProvider.ts'
import { ncmMetadataIdentity } from '../../core/library/ncmMetadataIdentity.ts'
import { PublicArtworkProvider } from '../../core/library/publicArtworkProvider.ts'
import { CoreStatisticsService } from '../../core/listening/service.ts'
import { CoreStatisticsRepository } from '../../core/listening/repository.ts'
import { createLibraryListeningProjection } from '../../core/listening/libraryProjection.ts'
import { LibraryDatabaseScanCoordinator } from '../../core/library/scanCoordinator.ts'
import { LocalLibraryScanServiceClient } from '../library/libraryScanServiceClient.ts'
import { AudioAnalysisServiceClient } from '../audioAnalysisServiceClient.ts'
import { randomUUID } from 'node:crypto'
import { createSourceResolver } from '../../core/playback/sourceResolver.ts'
import { AudioEngineManager } from '../audioEngineManager.ts'
import { AudioEngineServiceBinding } from '../audioEngineServiceClient.ts'
import { CoreAudioRecoveryService } from '../../core/audio/recoveryService.ts'
import { LibraryDatabaseServiceClient } from '../library/libraryDatabaseServiceClient.ts'
import { createPlaybackSessionStoreBundle } from '../persistence/playbackSessionRepository.ts'
import { createCorePlaybackRepository } from '../persistence/corePlaybackRepository.ts'
import { initializeUtilityDiagnostics } from '../diagnostics/utility.ts'
import type {
  CoreChildMessage,
  CoreParentMessage,
  CoreProcessConfiguration
} from '../../shared/coreProcessProtocol.ts'
import type { ServiceMessagePort } from '../services/servicePort.ts'
import { CoreServiceLauncher, type CoreServiceLease } from './serviceLauncher.ts'
import { CorePlatformClient } from './platformClient.ts'
import type { CorePlatformOperations } from '../../shared/corePlatform.ts'
import { CorePluginExperiences } from '../../core/plugins/experiences.ts'
import { createLegacyMusicLookupProvider } from '../../core/plugins/legacyMusicLookupProvider.ts'
import { CorePluginMarketplace } from '../../core/plugins/marketplace.ts'
import { TwilightPluginManager } from '../../core/plugins/manager.ts'
import { providerPlaybackIdentities } from '../../core/audio/providerPlaybackIdentity.ts'
import { PluginSettingsRepository } from '../../core/plugins/settingsRepository.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'
import { sanitizeDiagnosticText } from '../diagnostics/sanitize.ts'
import { redactSensitiveText } from '../../shared/errors/redactSensitiveText.ts'
import {
  derivePlaybackEvents,
  type PluginPlaybackEventSnapshot
} from '../../core/plugins/events.ts'

const parent = (process as unknown as { parentPort?: ServiceMessagePort }).parentPort
if (!parent) throw new Error('Music Core must run in an Electron utility process')
const parentPort = parent
initializeUtilityDiagnostics('twilight-core')
let configuration: CoreProcessConfiguration | null = null
let application: CoreApplication | null = null
let launcher: CoreServiceLauncher | null = null
let platform: CorePlatformClient | null = null
let database: LibraryDatabaseServiceClient | null = null
let audio: AudioEngineManager | null = null
let analysis: AudioAnalysisServiceClient | null = null
let plugins: TwilightPluginManager | undefined
let pluginMarketplace: CorePluginMarketplace | undefined
let pluginExperiences: CorePluginExperiences | undefined
let imports: CorePlaylistImportJobs | undefined
let ncm: ReturnType<typeof createNcmApiRuntime> | undefined
let ncmCache: ReturnType<typeof createNcmCache> | undefined
let previousPluginPlayback: PluginPlaybackEventSnapshot | null = null
const send = (message: CoreChildMessage) => parentPort.postMessage(message)

parentPort.on('message', (event) => {
  const message = event.data as CoreParentMessage
  if (!message || typeof message !== 'object') return
  if (message.kind === 'core:initialize') {
    if (configuration) return
    configuration = message.configuration
    void initialize(configuration).catch((error) =>
      send({ kind: 'core:fatal', epoch: configuration!.epoch, error: errorText(error) })
    )
    return
  }
  launcher?.handle(message, event.ports)
  if (message.kind === 'core:platform-response') platform?.handle(message)
  else if (message.kind === 'core:connect')
    application?.connect(message.identity, (reply) =>
      send({ kind: 'core:client-message', clientId: message.identity.id, message: reply })
    )
  else if (message.kind === 'core:disconnect') application?.disconnect(message.clientId)
  else if (message.kind === 'core:request')
    void application?.request(message.clientId, message.request)
  else if (message.kind === 'core:cancel')
    application?.cancel(message.clientId, message.requestId, message.epoch)
  else if (message.kind === 'core:shutdown') void shutdown(message.requestId)
})
send({ kind: 'core:booted' })

async function initialize(config: CoreProcessConfiguration): Promise<void> {
  let libraryRevision: number | null = null
  let catalog: CoreCatalogService | undefined = undefined
  let genres: CoreGenresService | undefined = undefined
  let ratings: CoreMusicRatingsService | undefined = undefined
  let preferences: CoreMusicPreferencesService | undefined = undefined
  let tags: CoreMusicTagsService | undefined = undefined
  let exploration: CoreMusicExplorationService | undefined = undefined
  let focus: CoreMusicFocusService | undefined = undefined
  launcher = new CoreServiceLauncher(config.epoch, send)
  platform = new CorePlatformClient(config.epoch, send)
  database = new LibraryDatabaseServiceClient({
    changed: (revision) => { libraryRevision = revision; application?.changed(); catalog?.invalidate() },
    genresChanged: revision => { genres?.observe(revision) },
    classificationMetadataChanged: revision => { genres?.observeMetadata(revision) },
    ratingsChanged: revision => { ratings?.observe(revision) },
    preferencesChanged: revision => { preferences?.observe(revision) },
    tagsChanged: token => { tags?.observe(token) },
    explorationChanged: state => { exploration?.observe(state) },
    focusChanged: state => { focus?.observe(state) },
    genresInvalidated: () => genres?.invalidate(),
    serviceEntry: 'database',
    libraryFilePath: config.libraryFilePath,
    coverCacheDir: config.coverCacheDir,
    coreStateFilePath: join(config.root, 'core-state.sqlite'),
    fork: () => launcher!.launch('database')
  })
  await database.coreStateOpen(join(config.root, 'core-state.sqlite'))
  // Recover the old journal before any staged owner can scan or mutate the library.
  await database.recoverRemoval()
  await recoverLocalLibraryRemovalFromDatabase(config.libraryFilePath, database)
  const personalBackupRepository = createPersonalBackupRepository()
  try {
    await personalBackupRepository.applyPendingPersonalRestoreFromDatabase(config.root, database)
  } catch (error) {
    if ((error as { code?: string }).code !== 'STALE_REVISION' ||
      !personalBackupRepository.deferStalePersonalRestore(config.root)) throw error
    console.warn('[core.backup] Music data changed after preview; restore awaits a fresh review in Settings')
  }
  const initialLibrary = await database.getMetadata()
  libraryRevision = initialLibrary.revision
  const settings = new CoreSettingsRepository({
    filePath: join(config.root, 'settings.json'),
    environment: {
      platform: process.platform,
      defaultCachePath: join(config.root, 'music-cache'),
      resolvePath: resolve
    },
    initial: {
      ...initialAudioSettings(config.audioConfig),
      libraryFolders: initialLibrary.folders,
      ...(config.resumeMode !== undefined ? { playbackResumeMode: config.resumeMode } : {}),
      ...(config.musicCachePath !== undefined ? { musicCachePath: config.musicCachePath } : {}),
      ...(config.ncmPlaybackQuality !== undefined
        ? { ncmPlaybackQuality: config.ncmPlaybackQuality }
        : {}),
      ...(config.onlineLyricsFallback !== undefined
        ? { onlineLyricsFallback: config.onlineLyricsFallback }
        : {}),
      ...(config.downloadFolder !== undefined ? { downloadFolder: config.downloadFolder } : {}),
      ...(config.downloadPreferences !== undefined
        ? { downloadPreferences: config.downloadPreferences }
        : {}),
      ...(config.streamingAudioCache !== undefined
        ? {
            cachePolicy: {
              cover: true,
              lyrics: true,
              metadata: true,
              streamingAudio: config.streamingAudioCache
            }
          }
        : {}),
      ...(config.autoMixEnabled ? { autoMixMode: 'natural' as const } : {}),
      ...(config.plugins?.developerMode !== undefined
        ? { developerMode: config.plugins.developerMode }
        : {})
    },
    changed: (patch) => {
      if (
        CORE_SPECIALIZED_SETTINGS.some(
          (key) => key !== 'playMode' && key !== 'softwareVolume' && Object.hasOwn(patch, key)
        )
      )
        output?.changed()
      else application?.changed()
      publishSettings()
      if (Object.hasOwn(patch, 'musicIdentification') || Object.hasOwn(patch, 'language')) metadata?.entities?.refreshIdentification(true)
      if (Object.hasOwn(patch, 'genreSeparators')) genres?.invalidate()
      if (Object.hasOwn(patch, 'playbackResumeMode'))
        void playback?.flush().catch((error) => console.error('[core.playback]', error))
    }
  })
  function publishSettings(): void {
    send({
      kind: 'core:settings',
      epoch: config.epoch,
      state: { revision: settings.getRevision(), settings: settings.read() }
    })
  }
  publishSettings()
  if (settings.issue) console.warn('[core.settings]', settings.issue.kind)
  const persistAudio = createCoreAudioPersistence(settings)
  const dspEnvironment = await platform.call('dsp.environment', {})
  const dspAssets = new DspAssetLibrary(join(config.root, 'dsp-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  await dspAssets.initialize()
  const vst3 = new Vst3CatalogService(
    join(config.root, 'dsp-vst3'),
    {
      scan: (path) => audio!.scanVst3Module(path)
    },
    dspEnvironment.searchPaths,
    {
      platform: dspEnvironment.platform,
      helpers: dspEnvironment.helpers,
      now: Date.now
    }
  )
  audio = new AudioEngineManager(coreAudioConfiguration(settings.read()), {
    platform: process.platform,
    persistDeviceProfiles: persistAudio.profile,
    persistAudioOutput: persistAudio.output,
    dspAssetPathResolver: (id) => dspAssets.getKnownPath(id),
    vst3StateAssetResolver: (id) => dspAssets.resolveVst3State(id),
    vst3ModuleResolver: (id, classId) => vst3.resolveAvailableModule(id, classId),
    audioServiceFactory: () =>
      new AudioEngineServiceBinding({
        serviceEntry: 'audio',
        launch: () => launcher!.launch('audio')
      })
  })
  // EventEmitter error events are reported as state/failure, never unhandled process exceptions.
  audio.on('error', (error) => console.error('[core.audio]', error))
  const output: CoreAudioOutputService = new CoreAudioOutputService({
    engine: audio,
    settings,
    changed: () => application?.changed()
  })
  audio.on('audio-device-options-changed', () => output!.changed())
  audio.on('device-profiles-changed', () => output!.changed())
  const dsp = new CoreDspService({
    engine: audio,
    configuration: output,
    settings,
    preferences: database,
    assets: dspAssets,
    catalog: vst3,
    platform,
    temporaryDirectory: dspEnvironment.temporaryDirectory,
    now: Date.now,
    newId: randomUUID,
    failed: (error) => console.error('[core.equalizer]', error)
  })
  audio.on('playback-info', (info) => dsp.observePlayback(info))
  const auditionManager = new DspAuditionManager({
    context: () => audio!.getAuditionContext(),
    apply: (revision, key, graph) => audio!.applyAuditionGraph(revision, key, graph),
    authorize: (source) => platform!.call('paths.authorizeAudioFile', { path: source }),
    identify: async (source) => {
      const info = await stat(source)
      if (!info.isFile()) throw new Error('试听源不是本地文件')
      return JSON.stringify([source, info.size, info.mtimeMs])
    },
    analyze: (source, options) => analysis!.analyzeDspAudition(source, options),
    cancel: (source) => {
      analysis?.cancelBySource(source, 'dsp-audition')
    },
    newId: randomUUID,
    timers: {
      setInterval: (callback, delay) => {
        const timer = setInterval(callback, delay)
        timer.unref()
        return timer
      },
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout)
    },
    changed: () => output.changed()
  })
  const audition = new CoreAuditionService({
    manager: auditionManager,
    configuration: output,
    context: () => audio!.getAuditionContext()
  })
  const outputTest = new CoreOutputTestService({
    configuration: output,
    temporaryDirectory: dspEnvironment.temporaryDirectory,
    timers: {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    context: async (exclusive) => {
      const state = await audio!.getAudioOutputState()
      const info = await audio!.getPlaybackInfo()
      return {
        backend: state.output === 'wasapi' && exclusive ? 'wasapi-exclusive' : state.output,
        device: state.device,
        volume: Math.min(info.volume, audio!.getDeviceProfiles().volumeCeiling),
        outputConfig: audio!.getOutputConfig(),
        playing: info.state === 'playing' || playback.snapshot().playback?.state === 'playing'
      }
    },
    createService: () => {
      let lease: CoreServiceLease | undefined
      const service = new AudioEngineServiceBinding({
        serviceEntry: 'audio-test',
        launch: () => (lease = launcher!.launch('audio-test'))
      })
      service.on('crash', () => service.destroy())
      return {
        callAsync: (method, args) => service.callAsync(method, args),
        destroy: async () => {
          service.destroy()
          await lease?.terminate()
        }
      }
    }
  })
  audio.on('audio-service-crash', (reason: string) => {
    void outputTest.stop().catch((error) => console.error('[core.outputTest]', error))
    void audition.shutdown().catch((error) => console.error('[core.audition]', error))
    void dsp.quarantineActive(reason).catch((error) => console.error('[core.dsp]', error))
  })
  const sessionStore = createPlaybackSessionStoreBundle(config.root, (label, path, result) =>
    console.warn('[core.persistence] recovered', label, path, result.status)
  )
  const repository = createCorePlaybackRepository(sessionStore, database)
  const history = createLibraryListeningProjection({
    getStorageMode: async () => config.libraryStorage,
    ready: async () => {},
    snapshot: () => statistics.historySnapshot(),
    sync: (request) => database!.syncListeningHistory(request),
    identity: randomUUID
  })
  const statistics = new CoreStatisticsService({
    repository: new CoreStatisticsRepository({ database, newId: randomUUID }),
    history,
    now: Date.now,
    timers: {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    changed: () => application?.changed()
  })
  const recordingVersions = new CoreRecordingVersions(
    database,
    () => { application?.changed(); catalog?.invalidate() },
    randomUUID
  )
  const bookmarkRepository = new VersionedDataStore<PlaybackBookmarksDocument>({
    filePath: join(config.root, 'playback-bookmarks.json'),
    label: 'playback bookmarks',
    maxBytes: 4 * 1024 * 1024,
    isData: isPlaybackBookmarksDocument,
    isLegacy: isPlaybackBookmarksDocument
  })
  const bookmarks = new CoreBookmarksService({
    repository: bookmarkRepository,
    now: Date.now,
    newId: () => `bm_${randomUUID()}`,
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.bookmarks]', error)
  })
  const lyrics = new CoreLyricsService({
    repository: new VersionedDataStore<LyricsManagementDocument>({
      filePath: join(config.root, 'lyrics-management.json'),
      label: 'lyrics management',
      maxBytes: 8 * 1024 * 1024,
      isData: isLyricsManagementDocument,
      isLegacy: isLyricsManagementDocument
    }),
    now: Date.now,
    timers: {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.lyrics]', error),
    sources: {
      getAppSettings: () => ({
        value: { onlineLyricsFallback: settings.read().onlineLyricsFallback }
      }),
      loadLocalLyrics: createLocalLyricsLoader(
        {
          audioFile: (path, signal) => platform!.call('paths.authorizeAudioFile', { path }, signal),
          directory: (path, signal) =>
            platform!.call('paths.authorizeLibraryDirectory', { path }, signal)
        },
        nodeLocalLyricsFilePort
      ),
      resolveProviderLyrics: (track, signal) =>
        resolveLyricsAcrossProviders(
          (plugins?.listProviders() ?? []).map(
            (provider): LyricProvider => ({
              id: provider.id,
              name: provider.name,
              isEnabled: () => isPluginProviderEnabled(provider.health),
              ...(provider.capabilities.includes('lyrics')
                ? {
                    getLyrics: async (track, options) =>
                      (await plugins!.callProvider(
                        provider.id,
                        'getLyrics',
                        [track],
                        options
                      )) as MediaProviderLyrics
                  }
                : {}),
              ...(provider.capabilities.includes('search')
                ? {
                    searchSongs: async (query, limit, offset, options) =>
                      (await plugins!.callProvider(
                        provider.id,
                        'searchSongs',
                        [query, limit, offset],
                        options
                      )) as { items: import('../../shared/track.ts').TrackData[]; total: number }
                  }
                : {})
            })
          ),
          track,
          Date.now,
          { signal }
        ),
      loadAmlTtml: (id, signal) => fetchAmlTtml(id, { signal }),
      loadOnlineLyrics: async (query, signal) => {
        assertOnlineLyricsRateLimit()
        const result = await searchOnlineLyrics(query, { signal })
        return result.best?.syncedLyrics ?? result.best?.plainLyrics ?? null
      }
    },
    search: (track, signal) => {
      assertOnlineLyricsRateLimit()
      return searchOnlineLyrics(
        {
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationSeconds: track.duration
        },
        { signal }
      )
    },
    importDraft: (signal) =>
      importLyricDraft(
        () => platform!.call('lyrics.chooseImportFile', {}, signal),
        {
          readFile: (path) => readFile(path),
          statSize: async (path) => (await stat(path)).size
        },
        signal
      ),
    exportDraft: (contents, signal) =>
      exportLyricDraft(
        () => platform!.call('lyrics.chooseExportFile', {}, signal),
        contents,
        nodeLyricsFileOperations,
        signal
      )
  })
  const workspaceRepository = new VersionedDataStore<QueueWorkspaceDocument>({
    filePath: join(config.root, 'queue-workspace.json'),
    label: 'queue workspace',
    maxBytes: 32 * 1024 * 1024,
    isData: isQueueWorkspaceDocument,
    isLegacy: isQueueWorkspaceDocument
  })
  const workspace = new CoreWorkspaceService({
    repository: {
      loadQueueWorkspace: () => workspaceRepository.load(),
      saveQueueWorkspace: (document, revision) => workspaceRepository.save(document, revision),
      syncQueueReferences: (owner: string, ids: string[]) =>
        database!.syncLibraryQueueReferences(owner, ids)
    },
    capture: () => playback.captureWorkspace(),
    restore: (session, play, guard, signal) => {
      const streamsRevision = streams.state()
      const networkRevision = network.state().revision
      const providers = () =>
        (plugins?.listProviders() ?? [])
          .filter(
            (provider) =>
              provider.capabilities.includes('playbackUrl') &&
              provider.health?.available !== false &&
              isPluginProviderEnabled(provider.health)
          )
          .map((provider) => provider.id)
          .sort()
      const availableProviders = providers()
      const sources = new Set(session.entries.map((entry) => entry.source))
      const check = () => {
        guard()
        const streamsState = streams.state()
        if (
          (sources.has('radio') && streamsState.radioRevision !== streamsRevision.radioRevision) ||
          (sources.has('podcast') &&
            streamsState.podcastRevision !== streamsRevision.podcastRevision) ||
          (sources.has('network') && network.state().revision !== networkRevision) ||
          JSON.stringify(providers()) !== JSON.stringify(availableProviders)
        )
          throw Object.assign(new Error('会话音源已变化，请重新选择会话'), {
            code: 'STALE_REVISION'
          })
      }
      return playback.restoreNamedSession(
        session,
        async (currentSignal) => {
          const local = session.entries.filter((entry) => entry.source === 'local')
          const localTracks = new Map<string, import('../../shared/track.ts').TrackData>()
          for (let offset = 0; offset < local.length; offset += 500) {
            currentSignal.throwIfAborted()
            const page = await database!.getTracksByIds(
              local.slice(offset, offset + 500).map((entry) => entry.id)
            )
            for (const record of page.tracks) localTracks.set(record.id, libraryTrack(record))
          }
          return resolveQueueSession(session, {
            localTracks,
            savedStreams: streams.savedStreams(),
            networkProfiles: network.profileIds(),
            availableProviders: new Set(availableProviders),
            authorizeFiles: (paths) =>
              platform!.call('paths.areAudioFilesAuthorized', { paths }, currentSignal),
            isCurrent: () => {
              currentSignal.throwIfAborted()
              check()
              return true
            }
          })
        },
        check,
        play,
        signal
      )
    },
    now: Date.now,
    newId: randomUUID,
    timers: {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.workspace]', error)
  })
  const streams = new CoreStreamsService({
    repository: new RadioMediaService({
      userDataPath: config.root,
      now: () => new Date().toISOString(),
      newId: randomUUID
    }),
    preferences: database,
    now: Date.now,
    newId: randomUUID,
    timers: {
      setInterval: (callback, delay) => {
        const timer = setInterval(callback, delay)
        timer.unref()
        return timer
      },
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout)
    },
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.streams]', error)
  })
  const legacyPlaylistRepository = new VersionedDataStore<Playlist[]>({
    filePath: join(config.root, 'playlists.json'),
    label: 'playlists',
    maxBytes: 20 * 1024 * 1024,
    isData: Array.isArray,
    isLegacy: Array.isArray
  })
  const playlistRepository = createPreferencesPlaylistRepository({
    legacy: legacyPlaylistRepository, database, identity: recordingVersions.identity, now: Date.now
  })
  let networkEnvironment:
    | Promise<CorePlatformOperations['network.environment']['output']>
    | undefined
  const musicCacheRoot = (): string =>
    settings.read().musicCachePath || config.musicCachePath || join(config.root, 'music-cache')
  const network = new CoreNetworkService({
    store: createNetworkProfileStore({
      filePath: join(config.root, 'network-sources', 'profiles.json'),
      now: Date.now,
      newId: randomUUID,
      codec: {
        encrypt: (plain) => platform!.call('network.protectCredential', { plain }),
        decrypt: (encrypted) => platform!.call('network.unprotectCredential', { encrypted })
      }
    }),
    library: createNetworkLibrary({
      filePath: join(config.root, 'network-sources', 'library.json')
    }),
    cacheRoot: () => join(musicCacheRoot(), 'network-cache'),
    coverCacheRoot: () => join(musicCacheRoot(), 'cover-cache'),
    newId: randomUUID,
    now: Date.now,
    changed: () => application?.changed(),
    getAdapter: async (protocol) => {
      if (protocol === 'webdav') return createWebDavAdapter()
      if (protocol === 'ftp' || protocol === 'ftps') return createFtpAdapter()
      if (protocol === 'dlna') return createDlnaAdapter()
      const environment = await (networkEnvironment ??= platform!.call('network.environment', {}))
      if (protocol === 'sftp' || protocol === 'scp')
        return createSftpSystemAdapter({
          tempDir: environment.tempRoot,
          newId: randomUUID,
          runOperation: (operation, connection, signal) =>
            platform!.callJoined('network.sftp', { operation, connection }, signal)
        })
      const mount = {
        platform: environment.platform,
        mountBaseDir: environment.tempRoot,
        gvfsRoot: environment.gvfsRoot,
        runCommand: (command, args, signal) =>
          platform!.callJoined('network.mountCommand', { command, args }, signal)
      } satisfies Parameters<typeof createSmbMountAdapter>[0]
      if (protocol === 'smb') return createSmbMountAdapter(mount)
      if (protocol === 'nfs') return createNfsMountAdapter(mount)
      return null
    }
  })
  const repairOwner = { isDestroyed: () => false, once: () => {}, removeListener: () => {} }
  const playlists = new CorePlaylistService({
    preferencesTrackStates: async tracks => {
      const states: Array<import('../../shared/musicPreferences.ts').MusicPreferenceState | null> = []
      for (let offset = 0; offset < tracks.length; offset += 200)
        states.push(...await database!.preferencesTrackStates(tracks.slice(offset, offset + 200)))
      return states
    },
    findRelocationsInFolder: (missing, folder) =>
      findLibraryPlaylistRelocations(missing, folder, {
        repairPlaylist: (request) => libraryRepair.handle(repairOwner, request)
      }),
    database,
    versions: recordingVersions,
    runtime: {
      now: Date.now,
      newId: randomUUID,
      clone: structuredClone,
      notify: () => {},
      identity: recordingVersions.identity,
      versions: { ensure: () => {}, revision: () => recordingVersions.getRevision() },
      repository: playlistRepository
    },
    changed: () => {
      application?.changed()
      queueMicrotask(() => imports?.reconcile())
      queueMicrotask(() => presentation.refresh())
      catalog?.invalidate()
    }
  })
  const presentation = new CorePlayerPresentationService({
    artwork: (track, signal) => platform!.call('artwork.present', {
      cover: track.cover ?? null, coverSource: track.coverSource ?? null
    }, signal),
    playlists,
    supportedMethods: (id) => plugins?.listProviders().find((provider) => provider.id === id)?.supportedMethods ?? [],
    callProvider: (id, method, args, signal) => {
      if (!plugins) throw new Error('Provider runtime is not configured')
      return plugins.callProvider(id, method, args, { signal })
    },
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.presentation]', error)
  })
  const resolver = createSourceResolver({
    quality: () => settings.read().ncmPlaybackQuality,
    canUseLocalSource: async (source, signal) =>
      (await platform!.call('paths.areAudioFilesAuthorized', { paths: [source] }, signal))[0],
    resolveNetwork: (track, signal) => network.resolve(track, signal),
    now: Date.now,
    callProvider: (id, method, args, options) => {
      if (!plugins) throw new Error('Provider runtime is not configured')
      return plugins.callProvider(id, method, args, options)
    },
    grants: { resolve: (handle) => platform!.call('media.resolveAudio', { handle }) }
  })
  const sourceResources = new SourceResources()
  const mediaServer = new RemoteHttpServer({
      serverName: hostname(), devicePairing: createPersistentDevicePairing(config.root),
      tls: loadRemoteTlsIdentity(config.root),
      discovery: new CoreDiscoveryAdvertisement(),
      confirmDevice: ({ deviceName, address, verificationCode }, signal) => platform!.call('remote.confirmDevice',
        { deviceName, address, ...(verificationCode ? { verificationCode } : {}) }, signal),
      staticRoot: config.remoteStaticRoot ?? '',
      addresses: () =>
        Object.values(networkInterfaces()).flatMap((entries) =>
          (entries ?? [])
            .filter((entry) => !entry.internal && ['IPv4', '4'].includes(String(entry.family)))
            .map((entry) => entry.address)
        ),
      useSource: (action) => sourceResources.use(action)
    })
  const cast = new CoreCastService({
    backend: createCastBackend({
      arm: (target) => platform!.call('cast.arm', { target }),
      disarm: (deviceId) => platform!.call('cast.disarm', { deviceId })
    }),
    media: mediaServer,
    resources: sourceResources,
    authorizeFile: (path) => platform!.call('paths.authorizeAudioFile', { path }),
    changed: () => application?.changed(),
    observe: (sample, revision) => playback.observeCast(sample, revision),
    failed: (error, revision) => playback.castFailed(error, revision),
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      return () => clearTimeout(timer)
    }
  })
  const sleepTimer = new CoreSleepTimer({
    settings: () => settings.read().sleepTimer,
    now: Date.now,
    timers: { setInterval, clearInterval, setTimeout, clearTimeout },
    playback: {
      read: () => playback.snapshot().playback ?? { state: 'stopped', volume: 0 },
      quiesce: () => playback.quiesceForSleep(),
      setGain: (gain) => playback.setSleepTimerGain(gain),
      stop: (current) => playback.stopForSleep(current),
      resumeMaintenance: () => playback.resumeAfterSleep(),
      persist: () => playback.flush()
    },
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.sleep]', error)
  })
  audio.on('sleep-timer-boundary', ({ boundary, occurredAt }) =>
    sleepTimer.boundary(boundary, occurredAt)
  )
  const playback = new CorePlaybackSession({
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
    sleepTimer,
    setNativeSleepGain: (gain) => audio!.setSleepTimerGain(gain),
    naturalBoundary: (boundary, at) => sleepTimer.boundary(boundary, at),
    cast,
    engine: audio,
    runTransport: (action) => outputTest.withTransport(action),
    resources: sourceResources,
    queues: {
      libraryRevision: async () => (await database!.getMetadata()).revision,
      importLegacyPlaybackQueue: (command) => database!.importLegacyPlaybackQueue(command),
      restoreNamedPlaybackQueue: (command) => database!.restoreNamedPlaybackQueue(command),
      restoreHeartBaseQueue: (...args) => database!.restoreHeartBaseQueue(...args),
      extendQueue: (...args) => database!.extendPlaybackQueue(...args),
      replaceSource: (command) => database!.replacePlaybackQueueSource(command),
      buildQueue: (...args) => database!.buildLibraryQueue(...args),
      createQueue: (...args) => database!.createLibraryQueue(...args),
      getQueue: (...args) => database!.getLibraryQueue(...args),
      readQueue: (...args) => database!.readLibraryQueue(...args),
      editQueue: (id, revision, edit) => edit.kind === 'insert'
        ? database!.insertCorePlaybackQueue(id, revision, edit)
        : database!.editLibraryQueue(id, revision, edit),
      deleteQueue: (...args) => database!.deleteLibraryQueue(...args),
      syncQueueReferences: (...args) => database!.syncLibraryQueueReferences(...args),
      readNeighbor: (...args) => database!.readLibraryQueueNeighbor(...args)
    },
    resolver,
    automaticPlaybackAllowed: async (tracks, signal) => {
      const allowed: boolean[] = []
      for (let offset = 0; offset < tracks.length; offset += 200) {
        signal?.throwIfAborted()
        allowed.push(...await database!.preferencesAutomaticEligibility(tracks.slice(offset, offset + 200)))
      }
      signal?.throwIfAborted()
      return allowed
    },
    sources: createPlaybackSourceRecovery({
      resolver,
      authorize: (source) => platform!.call('paths.prepareAudio', { source }),
      identity: recordingVersions.identity,
      versionsRevision: () => recordingVersions.getRevision(),
      search: (query, signal) => search.songs({ query, limit: 100 }, signal),
      now: Date.now,
      repaired: async (previous, replacement) => {
        if (getTrackSource(previous) !== 'local')
          await playlists.replaceTrackReference(previous.id, replacement)
      }
    }),
    authorize: (source) => platform!.call('paths.authorizeAudio', { source }),
    repository: repository as CoreSessionRepository,
    resumeMode: () => settings.read().playbackResumeMode,
    now: Date.now,
    changed: () => application?.changed(),
    observePlayback: (track, info) => {
      presentation.observe(track)
      playbackAnalysis.observe(track, info)
      bookmarks.observe(track, info)
      lyrics.observe(track)
      workspace.observe(track, info)
      streams.observe(track, info)
      statistics.observe(track, info)
      if (plugins) {
        for (const event of derivePlaybackEvents(previousPluginPlayback, info))
          void plugins.broadcastEvent(event.name, event.payload)
        previousPluginPlayback = { ...info }
      }
    },
    playbackStarted: () => workspace.beginAttempt(),
    occurrenceRebound: (previous, current) => workspace.rebindOccurrence(previous, current),
    podcastPlaybackRate: () => streams.defaultPlaybackRate(),
    personalized: {
      supportedMethods: (id) =>
        plugins?.listProviders().find((provider) => provider.id === id)?.supportedMethods ?? [],
      call: (id, method, signal) => {
        if (!plugins) throw new Error('Provider runtime is not configured')
        return plugins.callProvider(id, method, [], { signal })
      }
    },
    heart: {
      call: (method, args, signal) => {
        if (!plugins) throw new Error('Provider runtime is not configured')
        return plugins.callProvider('ncm', method, args, { signal })
      }
    },
    fatal: (error) => send({ kind: 'core:fatal', epoch: config.epoch, error: errorText(error) })
  })
  analysis = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis',
    launch: () => launcher!.launch('analysis')
  })
  const playbackAnalysis = new CoreAnalysisService({
    root: config.root,
    database,
    enabled: () => settings.read().autoAnalyzeBpm !== false,
    authorize: (path) => platform!.call('paths.authorizeAudioFile', { path }),
    bpm: {
      analyzeFile: (request) =>
        analysis!.analyzeBpm(
          request.filePath,
          JSON.stringify({ maxAnalysisSeconds: 180, referenceBpm: request.referenceBpm }),
          { priority: request.priority ?? 10 }
        ),
      cancelFile: (path) => {
        if (path) analysis?.cancelBySource(path, 'bpm')
        else analysis?.cancelAll('bpm')
      }
    },
    loudness: {
      analyzeFile: (request) =>
        analysis!.analyzeLoudness(request.filePath, JSON.stringify({ maxAnalysisSeconds: 0 }), {
          priority: request.priority ?? 50,
          timeoutMs: (14_400 + 120) * 1000
        }),
      cancelFile: (path) => {
        if (path) analysis?.cancelBySource(path, 'loudness')
        else analysis?.cancelAll('loudness')
      }
    },
    engine: audio,
    applyBpm: (track, result) => playback.applyBpm(track, result),
    clearBpm: () => playback.clearBpm(),
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.analysis]', error)
  })
  audio.on('loudnorm-status', () => application?.changed())
  const libraryLoudness = new CoreLibraryLoudnessService({
    root: config.root,
    database,
    authorizePath: (path) => platform!.call('paths.authorizeAudioFile', { path }),
    analyze: (group) => analysis!.analyzeLoudnessGroup(group),
    cancelWork: () => {
      analysis?.cancelAll('loudness-batch')
    },
    newId: randomUUID,
    changed: () => application?.changed()
  })
  const autoMix = new CoreAutoMixService({
    root: config.root,
    settings: () => settings.read(),
    engine: audio,
    identities: providerPlaybackIdentities,
    authorize: (source) => platform!.call('paths.authorizeAudio', { source }),
    analysis: {
      analyze: (source, options, priority, signal) =>
        analysis!.analyzeAutoMix(source, options, {
          priority: priority === 'boundary' ? 90 : -20,
          signal
        }),
      cancel: (source) => {
        analysis?.cancelBySource(source, 'automix')
      }
    },
    environment: () => platform!.call('automix.environment', {}),
    probe: (packDirectory, signal) =>
      platform!.callJoined('automix.probe', { packDirectory }, signal),
    runWorker: (request, signal) => platform!.callJoined('automix.runWorker', request, signal),
    useSources: (action) => sourceResources.use(action),
    now: Date.now
  })
  const scanner = new LocalLibraryScanServiceClient({
    serviceEntry: 'scan',
    launch: () => launcher!.launch('scan')
  })
  let scanRevision = -1
  let metadataScanJob: string | null = null
  const scanDirectoryRepository = new VersionedDataStore<string[]>({
    filePath: join(config.root, 'core-index-directories.json'),
    label: 'pending index directories',
    maxBytes: 4 * 1024 * 1024,
    isData: (value): value is string[] =>
      Array.isArray(value) && value.every((root) => typeof root === 'string' && root.length > 0),
    isLegacy: (value): value is string[] =>
      Array.isArray(value) && value.every((root) => typeof root === 'string' && root.length > 0)
  })
  let scanDirectoryRevision = 0
  const scan = new CoreScanService({
    directoryQueue: {
      load: async () => {
        const document = await scanDirectoryRepository.load()
        scanDirectoryRevision = document?.revision ?? 0
        return document?.data ?? []
      },
      save: async (roots) => {
        scanDirectoryRevision = (await scanDirectoryRepository.save(roots, scanDirectoryRevision))
          .revision
      }
    },
    database,
    scanner,
    coordinator: new LibraryDatabaseScanCoordinator({
      database,
      scanner,
      coverCacheDir: config.coverCacheDir,
      now: Date.now,
      newId: randomUUID,
      normalizeCoverHandle: (handle, signal) =>
        platform!.call('artwork.normalizeCachedCover', { handle }, signal),
      readSacdIsoMetadata: async (path, signal) => {
        const source = await platform!.call('paths.authorizeAudio', { source: path }, signal)
        return analysis!.getMetadata(source, { signal, priority: -10 })
      }
    }),
    authorizeDirectory: (path) => platform!.call('paths.authorizeLibraryDirectory', { path }),
    changed: () => {
      application?.changed()
      const status = scan.snapshot()
      const revision = status?.revision
      if (revision !== undefined && revision !== scanRevision) {
        scanRevision = revision
        imports?.rematch()
      }
      if (status?.state === 'completed' && status.jobId !== metadataScanJob) {
        metadataScanJob = status.jobId
        metadata.refresh()
      }
    },
    failed: (error) => console.error('[core.scan]', error)
  })
  const libraryBackground = new CoreLibraryBackground({
    database,
    scan,
    enabled: () => settings.read().watchLibrary,
    authorizeDirectory: (path) => platform!.call('paths.authorizeLibraryDirectory', { path }),
    pathKey: (path) => {
      const normalized = resolve(path)
      return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
    },
    directoryOf: dirname,
    platform: process.platform,
    now: () => new Date(),
    failed: (error) => console.error('[core.library-watch]', error)
  })
  const libraryRepair = new LibraryPlaylistRepairService({
    database,
    scanner,
    coverCacheDir: config.coverCacheDir,
    reserveScan: (action) => scan.maintain(action),
    authorizeDirectory: (path) => platform!.call('paths.authorizeLibraryDirectory', { path }),
    authorizeFile: (path) => platform!.call('paths.authorizeAudioFile', { path }),
    normalizeCoverHandle: (handle) =>
      handle.startsWith('cover://')
        ? platform!.call('artwork.normalizeCachedCover', { handle })
        : Promise.resolve(handle),
    readSacdIsoMetadata: async (path) => {
      const source = await platform!.call('paths.authorizeAudio', { source: path })
      return analysis!.getMetadata(source, { priority: -10 })
    }
  })
  const settingsService = new CoreSettingsService({
    importEffects: createSettingsImportEffects(audio, dsp),
    repository: settings,
    serialize: (action) => output.serialize(action),
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      timer.unref()
      return () => clearTimeout(timer)
    },
    failed: (error) => console.error('[core.settings]', error),
    audio,
    authorizePaths: (paths, signal) => platform!.call('settings.authorizePaths', paths, signal),
    configureLibrary: async (previous, next) => {
      const { libraryRoots } = await platform!.call('downloads.authorizedRoots', {
        libraryFolders: next.libraryFolders,
        downloadFolder: ''
      })
      const before = await database!.getMetadata()
      if (JSON.stringify(before.folders) !== JSON.stringify(libraryRoots))
        await database!.setLibraryRoots(libraryRoots)
      await libraryBackground.configure()
      // Startup already scans every root. Later additions import existing files even with watching off.
      if (previous) {
        const added = libraryRoots.filter((root) => !before.folders.includes(root))
        if (added.length) await scan.enqueueDirectories(added)
      }
    }
  })
  if (config.plugins) {
    ncm = createNcmApiRuntime()
    ncmCache = createNcmCache({
      root: () => musicCacheRoot(),
      maintainSources: (action) =>
        autoMix.maintain(() =>
          sourceResources.maintain(async () => {
            // All source reads have committed or cancelled before this sample.
            // Pause/Seek may still run; neither can introduce a new physical source.
            const actual = await audio!.getPlaybackInfo()
            return action([
              ...audio!.getQueueSnapshot().map((item) => item.source),
              actual.source,
              ...sourceResources.protectedSources()
            ])
          })
        )
    })
    const control = (operation: () => Promise<void>) => {
      if (application?.snapshot().phase !== 'ready') throw new Error('Music Core is not ready')
      return operation()
    }
    plugins = new TwilightPluginManager({
      appVersion: config.plugins.appVersion,
      bundledPlugins: config.plugins.bundledPlugins,
      hostIdleTimeoutMs: config.plugins.hostIdleTimeoutMs,
      recordPlaybackIdentity: (...args) => providerPlaybackIdentities.record(...args),
      settings: new PluginSettingsRepository({
        protect: (value, scope) => platform!.call('credentials.protect', { scope, value }),
        unprotect: (value, scope) => platform!.call('credentials.unprotect', { scope, value })
      }),
      platform: {
        userData: config.root,
        launchHost: () => launcher!.launch('plugin'),
        prepareDisable: (id) => platform!.call('plugins.prepareDisable', { id }),
        chooseInstallSource: (kind) => platform!.call('plugins.chooseInstallSource', { kind }),
        confirmInstall: (manifest, evidence) =>
          platform!.call('plugins.confirmInstall', { manifest, evidence }),
        showLog: (path) => platform!.call('plugins.showLog', { path }),
        notifyStateIssue: (type, detail) =>
          platform!.call('plugins.notifyStateIssue', { type, detail }),
        protectProviderResult: (value, method) =>
          platform!.call('media.protectProviderResult', { value, method }),
        log: (pluginId, level, message) => {
          const event = writeDiagnostic(
            'plugin',
            'plugin.output',
            { pluginId, message },
            level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
          )
          return {
            timestamp: event?.timestamp ?? new Date().toISOString(),
            eventId: event?.eventId ?? '',
            text: sanitizeDiagnosticText(redactSensitiveText(message))
          }
        }
      },
      ncm: {
        request: (...args) => ncm!.request(...args),
        officialLogin: () => platform!.call('ncm.officialLogin', {}),
        getCachedSong: async (id) =>
          settings.read().cachePolicy.streamingAudio === 'provider'
            ? ncmCache!.getCachedSong(id)
            : null,
        cacheSong: (id, url, name) =>
          settings.read().cachePolicy.streamingAudio === 'provider'
            ? ncmCache!.cacheSong(id, url, name)
            : Promise.resolve(null),
        prepareAutoMixSong: (...args) =>
          settings.read().cachePolicy.streamingAudio === 'provider' &&
          effectiveAutoMixMode(settings.read().autoMixMode) !== 'off'
            ? ncmCache!.prepareAutoMixSong(...args)
            : Promise.resolve(null)
      },
      autoMixEnabled: () => effectiveAutoMixMode(settings.read().autoMixMode) !== 'off',
      dynamicIsland: {
        show: (pluginId) => platform!.call('overlay.show', { pluginId }),
        hide: (pluginId) => platform!.call('overlay.hide', { pluginId }),
        configure: (pluginId, config) => platform!.call('overlay.configure', { pluginId, config }),
        isOwner: (pluginId) => platform!.call('overlay.isOwner', { pluginId })
      },
      importPlaylists: (request) => playlists.importFromPlugin(request),
      getPlaybackInfo: () => playback.snapshot().playback,
      applyNativeDspPluginChain: (chain) => audio!.setNativeDspPluginChain(chain),
      player: {
        play: () => control(() => playback.play()),
        pause: () => control(() => playback.pause()),
        togglePause: () =>
          control(() =>
            playback.snapshot().playback?.state === 'playing' ? playback.pause() : playback.play()
          ),
        stop: () => control(() => playback.stop()),
        next: () => control(() => playback.navigate(1)),
        previous: () => control(() => playback.navigate(-1)),
        playTracks: (ids, startIndex) =>
          control(() =>
            playback.fromQuery({ ids, sort: 'insertion' }, ids[startIndex] ?? ids[0], true)
          ),
        setVolume: (volume) => control(() => playback.setVolume(volume)),
        seek: (position) => control(() => playback.seek(position)),
        setPlayMode: (mode) => control(() => playback.setMode(mode))
      },
      libraryApi: {
        queryTracks: (query) => database!.queryTracks(query as LibraryQuery),
        getTracksByIds: (ids) => database!.getTracksByIds(ids),
        patchTracks: (patches) => database!.patchTracks(patches),
        getCover: async (trackId) => {
          const page = await database!.getTracksByIds([trackId])
          const cover = (page.tracks?.[0] as { cover?: unknown } | undefined)?.cover
          if (typeof cover !== 'string' || !cover) return null
          if (cover.startsWith('data:')) {
            return cover.length <= 8 * 1024 * 1024 ? cover : null
          }
          if (!cover.startsWith('cover://')) return null
          const fileName = cover.slice('cover://'.length).split(/[?#]/, 1)[0]
          if (
            !fileName ||
            fileName.includes('/') ||
            fileName.includes('\\') ||
            fileName.includes('..') ||
            !/\.(jpe?g|png|webp|gif)$/i.test(fileName)
          )
            return null
          try {
            const bytes = await readFile(join(config.coverCacheDir ?? '', fileName))
            if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) return null
            const type = /\.png$/i.test(fileName)
              ? 'image/png'
              : /\.webp$/i.test(fileName)
                ? 'image/webp'
                : /\.gif$/i.test(fileName)
                    ? 'image/gif'
                    : 'image/jpeg'
            return `data:${type};base64,${bytes.toString('base64')}`
          } catch {
            return null
          }
        },
        listPlaylists: async () =>
          playlists.list(0, 200, playlists.getRevision()) as unknown,
        createPlaylist: async (name) => {
          const created = await playlists.edit(playlists.getRevision(), {
            kind: 'create',
            name
          } as CorePlaylistEdit)
          return created
        },
        addTracksToPlaylist: async (playlistId, trackIds) => {
          const page = await database!.getTracksByIds(trackIds)
          const tracks = (page.tracks ?? []) as unknown as TrackData[]
          if (!tracks.length) throw new Error('曲目不存在或已不可用')
          return playlists.edit(playlists.getRevision(), {
            kind: 'add',
            id: playlistId,
            tracks
          } as CorePlaylistEdit)
        },
        removeTracksFromPlaylist: async (playlistId, trackIds) =>
          playlists.edit(playlists.getRevision(), {
            kind: 'remove',
            id: playlistId,
            ids: trackIds
          } as CorePlaylistEdit)
      },
      appSettingsApi: {
        get: () => settings.read(),
        update: async (patch) => {
          await settingsService.editOwned(patch as CoreSettingsEdit['patch'])
          return settings.read()
        }
      },
      hostCaptureApi: {
        captureScreenshot: () => platform!.call('host.captureScreenshot', {})
      },
    })
  }
  const importProviders = () =>
    (plugins?.listProviders() ?? []).map(
      (provider): ImportProvider => ({
        id: provider.id,
        getPlaybackUrl: provider.capabilities.includes('playbackUrl') || undefined,
        isEnabled: () => isPluginProviderEnabled(provider.health),
        ...(provider.capabilities.includes('search')
          ? {
              searchSongs: async (
                query: string,
                limit: number,
                offset: number,
                options: { signal: AbortSignal }
              ) =>
                (await plugins!.callProvider(
                  provider.id,
                  'searchSongs',
                  [query, limit, offset],
                  options
                )) as { items: import('../../shared/track.ts').TrackData[]; total: number }
            }
          : {})
      })
    )
  const authorizeLocal = async (
    track: import('../../shared/track.ts').TrackData
  ): Promise<boolean> => {
    try {
      await platform!.call('paths.authorizeAudio', { source: track.filePath })
      return true
    } catch {
      return false
    }
  }
  const importPreviews = new CorePlaylistPreviews({
    now: Date.now,
    newId: randomUUID,
    reader: createPlaylistReader({
      providers: () =>
        plugins?.listProviders().map(
          (provider): PlaylistReadProvider => ({
            id: provider.id,
            isEnabled: () => isPluginProviderEnabled(provider.health),
            ...(provider.supportedMethods?.includes('readPlaylistImportPage')
              ? {
                  readPlaylistImportPage: async (
                    id: string,
                    offset: number,
                    limit: number,
                    options: { signal: AbortSignal }
                  ) =>
                    (await plugins!.callProvider(
                      provider.id,
                      'readPlaylistImportPage',
                      [id, offset, limit],
                      options
                    )) as import('../../shared/externalPlaylist.ts').PlaylistImportPage
                }
              : {})
          })
        ) ?? [],
      resolveShortLink: (input, signal) => resolveNeteaseShortPlaylistLink(input, fetch, signal),
      readPage: (request, signal) => readOfficialPlaylistPage(request, fetch, signal)
    }),
    chooseFile: (signal) => platform!.call('playlists.chooseImportFile', {}, signal),
    readFile: readPlaylistImportFile,
    save: (playlist, command, signal) => playlists.savePreview(playlist, command, signal),
    changed: () => application?.changed(),
    reconcile: (id) => (id ? imports?.start(id) : imports?.reconcile())
  })
  imports = new CorePlaylistImportJobs({
    providers: { list: importProviders, get: (id) => importProviders().find((p) => p.id === id) },
    localCandidates: createImportLocalCandidates({ database, authorizeLocal }),
    authorizeLocal,
    now: Date.now,
    read: (id) => importPreviews.read(id) ?? playlists.readExternal(id),
    ids: () => [...importPreviews.ids(), ...playlists.externalIds()],
    apply: (id, generation, updates) =>
      importPreviews.has(id)
        ? importPreviews.apply(id, generation, updates)
        : playlists.applyImportResolutions(id, generation, updates),
    delay: async (ms, signal) => {
      await delay(ms, undefined, { signal })
    },
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.imports]', error)
  })
  let providerInventory = ''
  let identificationInventoryRevision = 0
  const pluginTheme = async (pluginId: string, themeId: string) => {
    const theme = (await plugins?.listExtensions())
      ?.find((extension) => extension.pluginId === pluginId)
      ?.themes.find((theme) => theme.id === themeId)
    return theme ? { windowDefaults: theme.structured?.windowDefaults } : null
  }
  const themes = new CoreThemeService({
    repository: new ThemeLibraryRepository(join(config.root, 'themes.json'), () =>
      createDefaultThemeLibraryDocument(
        settings.read().activeTheme,
        settings.read().themeWindowInheritance
      )
    ),
    settings: () => settings.read(),
    updateSettings: (patch) => settingsService.editOwned(patch),
    platform: {
      validateAssets: (id, assets, signal) =>
        platform!.call('themes.validateAssets', { id, assets }, signal),
      deleteAssets: (id) => platform!.callJoined('themes.deleteAssets', { id }),
      importArchive: (signal) => platform!.callJoined('themes.importArchive', {}, signal),
      exportArchive: (profile, signal) =>
        platform!.callJoined('themes.exportArchive', { profile }, signal),
      importAsset: (id, type, signal) =>
        platform!.callJoined('themes.importAsset', { id, type }, signal),
      copyAssets: (sourceId, targetId) =>
        platform!.callJoined('themes.copyAssets', { sourceId, targetId })
    },
    pluginTheme,
    changed: (snapshot) => send({ kind: 'core:themes', epoch: config.epoch, snapshot }),
    now: () => new Date().toISOString()
  })
  const cloudTransfers = new CoreNcmCloudTransferService({
    chooseUploadFiles: (_client, signal) => platform!.call('ncm.chooseUploadFiles', {}, signal),
    chooseDownloadFile: (_client, fileName, signal) =>
      platform!.call('ncm.chooseDownloadFile', { fileName }, signal),
    callProvider: async <T>(method, args, signal, idempotencyKey): Promise<T> => {
      if (!plugins) throw new Error('网易云 Provider 尚未就绪')
      return (await plugins.callProvider('ncm', method, args, { signal, idempotencyKey })) as T
    },
    now: Date.now,
    newId: randomUUID,
    changed: () => application?.changed()
  })
  if (plugins) {
    pluginExperiences = new CorePluginExperiences(plugins, database!, () => {
      const state = scan.snapshot()?.state
      return state === 'running' || state === 'paused'
    }, (name, content) => platform!.call('plugins.exportExperience', { name, content }), database!, {
      startLegacyMusic: (...args) => metadata.entities!.startLegacyMusic(...args),
      legacyMusicStatus: (...args) => metadata.entities!.legacyMusicStatus(...args),
      cancelLegacyMusic: (...args) => metadata.entities!.cancelLegacyMusic(...args)
    })
  }
  if (plugins && config.plugins?.index) {
    pluginMarketplace = new CorePluginMarketplace({
      appVersion: config.plugins.appVersion,
      localIndexPath: config.plugins.index.localPath,
      remoteIndexUrl: config.plugins.index.remoteUrl,
      cacheIndexPath: join(config.root, 'plugin-index', 'cache', 'plugins.json'),
      packageStagingDir: join(config.root, 'plugin-index', 'staging'),
      bundledPluginIds: config.plugins.bundledPlugins?.map((plugin) => plugin.id)
    }, plugins)
  }
  const downloads = plugins
    ? new CoreDownloadsService({
        pluginManager: plugins,
        getPreferences: () => settings.read().downloadPreferences,
        authorizedRoots: async () => {
          const folders = (await database!.getMetadata()).folders
          return platform!.call('downloads.authorizedRoots', {
            libraryFolders: folders,
            downloadFolder: settings.read().downloadFolder
          })
        },
        indexer: () => (path) => scan.enqueueDirectories([dirname(path)]),
        grant: (path) => platform!.call('downloads.grantResult', { path }),
        indexed: async (path) => (await database!.lookupTracksByPaths([path])).ids[0] !== null,
        reveal: (path) => platform!.call('downloads.reveal', { path }),
        fetchCover: (handle, signal) => platform!.call('downloads.cover', { handle }, signal),
        prepareMetadata: createDownloadMetadataPreparation((source, request, signal) =>
          analysis!.prepareDownloadMetadata(source, request, signal)
        ),
        changed: () => application?.changed(),
        log: (taskId, previous, patch) =>
          writeDiagnostic(
            'download',
            'task.state',
            { taskId, previous, ...patch },
            patch.status === 'failed' ? 'error' : 'info',
            { operationId: taskId }
          )
      })
    : undefined
  plugins?.on('changed', () => {
    void themes.reconcile().catch((error) => console.error('[core.themes]', error))
    const inventory = JSON.stringify((plugins?.listProviders() ?? []).map((p) => [p.id, isPluginProviderEnabled(p.health), p.supportedMethods]))
    if (inventory !== providerInventory) {
      providerInventory = inventory
      identificationInventoryRevision++
      imports?.rematch()
      metadata.refresh(true)
      metadata.entities?.refreshIdentification()
      presentation.refresh()
    }
  })
  // The supervisor connects clients after initialized, even when migration is
  // required; only migration/status operations are accepted before ready.
  let ready = false,
    initializedSent = false
  const search = new CoreMusicSearchService({
    database,
    playlists,
    versions: recordingVersions,
    providers: () =>
      (plugins?.listProviders() ?? []).map((provider) => ({
        ...provider,
        available: isPluginProviderEnabled(provider.health)
      })),
    searchProvider: async (id, query, limit, offset, signal) =>
      (await plugins!.callProvider(id, 'searchSongs', [query, limit, offset], { signal })) as {
        items: import('../../shared/track.ts').TrackData[]
        total: number
      },
    searchCollectionProvider: async (id, method, query, limit, offset, signal) =>
      (await plugins!.callProvider(id, method, [query, limit, offset], { signal })) as {
        items: import('../../core/search/collections.ts').CollectionSummary[]
        total: number
      },
    network: {
      revision: () => network.state().revision,
      search: (query, signal) => network.searchTracks(query, signal)
    }
  })
  const metadataProviders = () =>
    (plugins?.listProviders() ?? []).filter(
      (provider) =>
        provider.capabilities.includes('search') &&
        provider.supportedMethods?.includes('searchSongs') &&
        isPluginProviderEnabled(provider.health)
    )
  const { entityPolicy: entityMetadataPolicy, publicArtworkPolicy, publicMusicPolicy,
    platformTextUsage, platformArtworkUsage } = metadataConfiguration()
  const identificationPlatforms = () => (plugins?.listProviders() ?? []).map(provider => ({
    id: provider.id,
    enabled: isPluginProviderEnabled(provider.health),
    supportedMethods: provider.supportedMethods ?? [],
    configuration: JSON.stringify([identificationInventoryRevision, plugins?.providerIdentityContext(provider.id)])
  }))
  const identificationResponses = new IdentificationResponseCache()
  plugins?.on('provider-context', (id: string) => {
    identificationResponses.invalidate(`platform.${id}`)
    metadata.entities?.refreshIdentification(false, `platform.${id}`)
  })
  const musicbrainzIdentification = new MusicBrainzIdentificationProvider(() => entityMetadataPolicy)
  const publicMusicProviders = publicMetadataSources.map(id => new PublicMusicSource(id, () => publicMusicPolicy))
  const legacyMusic = plugins ? createLegacyMusicLookupProvider({ plugins,
    // Only an explicit deployment prohibition changes the existing manual
    // capability; omitted automatic-enrichment opt-ins do not disable it.
    disabled: operation => process.env.TWILIGHT_METADATA_ENABLED === '0' ? 'metadata_disabled' :
      operation === 'introductions' && process.env.TWILIGHT_METADATA_WIKIPEDIA_TEXT === '0' ? 'wikipedia_text_disabled' : null
  }) : undefined
  const metadata = new CoreMetadataService({
    database,
    entities: {
      backfillCredits: () => database!.explorationBackfillCredits(100),
      database,
      legacy: () => legacyMusic!,
      provider: new MusicBrainzWikiProvider(() => entityMetadataPolicy),
      artwork: async image => (await platform!.call('artwork.present', { cover: image.resource, coverSource: null,
        retainMetadata: image.usage.display && image.usage.cache && image.usage.expiresAt === undefined,
        ...(image.usage.expiresAt === undefined ? {} : { imageExpiresAt: image.usage.expiresAt }) })).cover,
      enrichmentProviders: () => [new MusicBrainzDetailsProvider(() => entityMetadataPolicy), new PublicArtworkProvider(() => publicArtworkPolicy), ...publicMusicProviders, ...identificationPlatforms().map(provider => new PlatformMetadataProvider(provider.id, {
        inventory: identificationPlatforms,
        configuration: () => provider.id === 'ncm'
          ? NCM_PUBLIC_METADATA_CONFIGURATION
          : plugins!.providerMetadataContext(provider.id),
        usage: id => platformTextUsage(settings.read().musicIdentification.ncmLocalFallback !== false)[id] ?? null,
        ...(provider.id === 'ncm' || platformArtworkUsage()[provider.id] ? {
          artworkUsage: (id: string) => platformArtworkUsage(settings.read().musicIdentification.ncmLocalFallback !== false)[id] ?? null
        } : {}),
        call: (id, method, externalId, signal) => plugins!.callProvider(id, method, [externalId], { signal }),
        ...(provider.id === 'ncm' ? {
          identity: ncmMetadataIdentity(() => entityMetadataPolicy),
          sourcePage: (_: string, id: string) => `https://music.163.com/#/artist?id=${encodeURIComponent(id)}`
        } : {})
      }))],
      identificationProviders: () => [musicbrainzIdentification, ...publicMusicProviders.map(provider => provider.identification()), ...identificationPlatforms().map(provider =>
        new PlatformIdentificationProvider(provider.id, {
          responses: identificationResponses,
          inventory: identificationPlatforms,
          search: (id, method, query, limit, offset, signal) =>
            plugins!.callProvider(id, method, [query, limit, offset], { signal }),
          albumIdentity: (id, albumId, signal) =>
            plugins!.callProvider(id, 'fetchAlbumIdentity', [albumId], { signal }),
          recordingSearch: (id, query, signal, offset = 0) =>
            plugins!.callProvider(id, 'searchRecordingIdentities', [query, 10, offset], { signal }),
          artistIdentity: (id, artistId, signal) =>
            plugins!.callProvider(id, 'fetchArtistIdentity', [artistId], { signal })
        }))],
      policy: () => entityMetadataPolicy,
      automation: () => settings.read().musicIdentification,
      language: () => resolveLocale(settings.read().language, Intl.DateTimeFormat().resolvedOptions().locale) === 'en-US' ? 'en' : 'zh-Hans',
      now: Date.now,
      changed: () => application?.changed(),
        failed: error => console.error('[core.metadata.entities]', error),
        taskFailed: (error, task) => console.error('[core.metadata.task]', task, error)
    },
    provider: {
      searchSongs: async (query, limit = 30, offset = 0, signal) => {
        const results = await Promise.allSettled(
          metadataProviders().map(
            (provider) =>
              plugins!.callProvider(provider.id, 'searchSongs', [query, limit, offset], {
                signal
              }) as Promise<{ items: import('../../shared/track.ts').TrackData[]; total: number }>
          )
        )
        signal?.throwIfAborted()
        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        if (results.length && !fulfilled.length) throw new Error('在线元数据服务暂不可用')
        const items = fulfilled.flatMap((result) => result.value.items)
        return { items, total: items.length }
      }
    },
    available: () => metadataProviders().length > 0,
    policy: () => settings.read().cachePolicy,
    now: Date.now,
    newId: randomUUID,
    changed: () => application?.changed(),
    failed: (error) => console.error('[core.metadata]', error),
    libraryChanged: () => imports?.rematch()
  })
  // Run only after the services captured by settings.changed are constructed,
  // and before application.initialize activates scanning and metadata tasks.
  const metadataSetupFile = process.env.TWILIGHT_DEV_METADATA_SETUP_FILE
  if (metadataSetupFile) {
    if (entityMetadataPolicy.enabled && entityMetadataPolicy.publicServiceApproved) {
      const result = applyDevelopmentMetadataSetup(metadataSetupFile, config.root, settings)
      if (result.status === 'applied') console.info('[dev.metadata] Requested music metadata preferences applied.')
      else if (result.status !== 'missing' && result.status !== 'not-requested')
        console.warn('[dev.metadata] One-time setup needs attention:', result)
    } else console.warn('[dev.metadata] One-time setup deferred: deployment metadata policy is disabled.')
  }
  const duplicates = new CoreDuplicatesService({
    readCandidates: (after, limit, revision) =>
      database!.readDuplicateCandidates(after, limit, revision),
    authorizeFile: (path, signal) => platform!.call('paths.authorizeAudioFile', { path }, signal),
    hashContent: (path, signal) => analysis!.hashContent(path, signal),
    pathKey,
    fileName: basename,
    yieldControl: () => new Promise<void>((done) => setImmediate(done)),
    newId: randomUUID,
    changed: () => application?.changed()
  })
  const resolveQueueInput = createQueueInputResolver({
        database,
        authorizeLocal: (source, signal) =>
          authorizeNativeSource(source, (path) =>
            platform!.call('paths.authorizeAudioFile', { path }, signal)
          ),
        providers: () =>
          new Set(
            (plugins?.listProviders() ?? [])
              .filter(
                (provider) =>
                  provider.capabilities.includes('playbackUrl') &&
                  provider.health?.available !== false &&
                  isPluginProviderEnabled(provider.health)
              )
              .map((provider) => provider.id)
          ),
        network: (request, signal) => network.playback(request, signal),
        streams: () => streams.savedStreams()
      })
  const schedule = (callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay)
    timer.unref()
    return () => clearTimeout(timer)
  }
  const remote = new CoreRemoteService({
    server: mediaServer, settings, playback,
    providerSession: () => plugins?.readNcmSession() ?? Promise.resolve({ providerId: 'ncm', loggedIn: false }),
    media: new RemoteMediaResolver({ libraryId: persistentLibraryId(config.root),
      resolve: async (sourceId) => {
        const status = await database!.catalogStatus()
        return database!.catalogResolve(sourceId, status.revision)
      },
      authorizeFile: (path) => platform!.call('paths.authorizeAudioFile', { path }),
      grants: mediaServer.getMediaGrants() }),
    resolveTrackLyrics: (track, options) => lyrics.resolveTrack(track, options),
    playlistRecords: (query, signal) => playlists.records(query, signal),
    castActive: () => cast.active(),
    resolveCover: (cover) => platform!.call('artwork.remotePreview', { cover }),
    failed: (error) => console.error('[core.remote]', error), now: Date.now
  })
  ratings = new CoreMusicRatingsService({ database, now: Date.now,
    changed: () => application?.changed() })
  exploration = new CoreMusicExplorationService({ database, now: Date.now,
    platformContexts: () => metadata.entities?.platformContexts() ?? {},
    changed: () => application?.changed() })
  focus = new CoreMusicFocusService({ database, playback, now: Date.now,
    platformContexts: () => metadata.entities?.platformContexts() ?? {},
    ensureHistory: async () => {
      await history.ensure()
      if (!history.state.value.ready || history.state.value.pending || history.state.value.error)
        throw Object.assign(new Error('播放历史索引尚未就绪，请稍后重新查询'), { code: 'NOT_READY' })
    }, changed: () => application?.changed() })
  tags = new CoreMusicTagsService({ database, playback, now: Date.now,
    changed: () => application?.changed() })
  preferences = new CoreMusicPreferencesService({ database, now: Date.now,
    changed: () => {
      application?.changed()
      return playlists.refreshPreferences()
    } })
  genres = new CoreGenresService({
    database,
    platformContexts: () => metadata.entities?.platformContexts() ?? {},
    separators: () => settings.read().genreSeparators,
    changed: () => application?.changed(),
    failed: error => console.error('[core.genres]', error)
  })
  catalog = new CoreCatalogService({
    database,
    playlists: { getRevision: () => playlists.getRevision(), sourceTracks: () => playlists.librarySourceTracks() },
    versions: recordingVersions,
    changed: () => { application?.changed(); metadata.entities?.refreshIdentification(); genres?.invalidate() },
    failed: error => console.error('[core.catalog]', error)
  })
  application = new CoreApplication({
    catalog,
    genres,
    ratings,
    preferences,
    tags,
    focus,
    exploration,
    albums: new CoreAlbumBrowseService({ database,
      platformContexts: () => metadata.entities?.platformContexts() ?? {},
      observeMetadata: revision => genres?.observeMetadata(revision) }),
    unifiedPlayback: new CoreUnifiedPlaybackService({ database, versions: recordingVersions, playback,
      // The request's identity supplies the provider-authorized restorer in CoreApplication.
      restore: async () => { throw Object.assign(new Error('Provider playback requires request authorization'), { code: 'FORBIDDEN' }) },
      assertScope: (request, ids, signal) => new CoreCatalogPlaybackScope({ database: database!,
        platformContexts: () => metadata.entities?.platformContexts() ?? {} }).allowed(request, ids, signal) }),
    opra: new OpraCatalog(join(config.root, 'opra', 'database_v1.jsonl')),
    revealAudioFile: (path) => platform!.call('downloads.reveal', { path }),
    playlistSources: new CorePlaylistSourceEdits({
      resolve: createPlaylistInputResolver(resolveQueueInput, database),
      search: (query, signal) => search.songs({ query, limit: 20, offset: 0 }, signal),
      replace: (oldId, track, revision, signal) => playlists.replaceTrackReference(oldId, track, revision, signal)
    }),
    remote,
    recordingCatalog: new CoreRecordingCatalog({ database, playlists, versions: recordingVersions }),
    resolvePlaylistInputs: createPlaylistInputResolver(resolveQueueInput, database),
    libraryRevision: () => libraryRevision,
    diagnostics: config.diagnostics ? new CoreAudioDiagnosticsService({
      ...config.diagnostics, engine: audio, settings: () => settings.read(),
      failed: (error) => console.error('[core.diagnostics]', error)
    }) : undefined,
    artwork: (track, signal) => platform!.call('artwork.present', { cover: track.cover, coverSource: track.coverSource ?? null }, signal),
    playlistSubmission: new CorePlaylistSubmission({ playlists, newId: randomUUID, schedule, resolve: createPlaylistInputResolver(resolveQueueInput, database) }),
    presentation,
    outputInfo: async () => (await audio!.getPlaybackInfo()).outputInfo,
    queueSubmission: new CoreQueueSubmission({
      playback,
      newId: randomUUID,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay)
        timer.unref()
        return () => clearTimeout(timer)
      },
      resolve: resolveQueueInput
    }),
    themes,
    visualization: new CoreVisualizationService({
      epoch: config.epoch,
      engine: audio,
      send: (clientId, event) => application?.sendVisualization(clientId, event),
      schedule: (callback, milliseconds) => {
        const timer = setInterval(callback, milliseconds)
        timer.unref()
        return () => clearInterval(timer)
      }
    }),
    modelPack: new CoreModelPackService({
      root: config.root,
      chooseArchive: (signal) => platform!.call('automix.chooseArchive', {}, signal),
      decode: (request, signal) =>
        platform!.callJoined('automix.decodeArchiveEntry', request, signal),
      probe: (packDirectory, signal) =>
        platform!.callJoined('automix.probeInstall', { packDirectory }, signal),
      changed: () => application?.changed(),
      installed: async (enableAfterInstall) => {
        await settingsService.editOwned(
          enableAfterInstall
            ? { autoMixStemMode: 'auto', autoMixStemDevice: 'auto' }
            : { autoMixStemMode: 'off' }
        )
        await autoMix.capabilities(true)
      }
    }),
    settingsBackup: new CoreSettingsBackupService({
      settings: settingsService,
      normalize: (patch) => settings.normalize(patch),
      themes,
      validateThemeAssets: (id, assets, signal) =>
        platform!.call('themes.validateAssets', { id, assets }, signal),
      pluginTheme,
      themesChanged: () => {}
    }),
    cloudTransfers,
    personalBackup: new CorePersonalBackupService({
      root: config.root,
      database,
      flush: async () => {
        await Promise.all([
          statistics.flush(),
          recordingVersions.flush(),
          playlists.flush(),
          bookmarks.flush(),
          lyrics.flush(),
          workspace.flush(),
          streams.flush()
        ])
        await playback.flush()
      },
      personalData: () => ({
        statistics: statistics.exportData(),
        versions: recordingVersions.snapshot()
      }),
      chooseFile: (kind, signal) => platform!.call('backup.chooseFile', { kind }, signal),
      chooseFolder: (signal) => platform!.call('backup.chooseFolder', {}, signal),
      authorizeRoots: async (roots) =>
        (await platform!.call('settings.authorizePaths', { libraryFolders: roots }))
          .libraryFolders!,
      newId: randomUUID
    }),
    duplicates,
    libraryHealth: metadata.entities ? new CoreLibraryHealthService({
      database, metadata: metadata.entities, now: Date.now, newId: randomUUID,
      language: () => settings.read().musicIdentification.language ??
        (resolveLocale(settings.read().language, Intl.DateTimeFormat().resolvedOptions().locale) === 'en-US' ? 'en' : 'zh-Hans'),
      changed: () => application?.changed()
    }) : undefined,
    inbox: new CoreInboxService({
      database,
      duplicates: (id) => duplicates.evidence(id),
      newId: randomUUID,
      changed: () => application?.changed()
    }),
    libraryRepair,
    libraryMaintenance: new CoreLibraryMaintenance({
      database,
      scanner: scan,
      maintainFiles: (paths, action) =>
        autoMix.maintain(() =>
          playback.maintainSources((sources) =>
            sourceResources.maintain(() =>
              playbackAnalysis.maintain(() =>
                libraryLoudness.maintain(async () => {
                  await audition.shutdown()
                  await analysis!.releaseSources(paths)
                  const targets = new Set(paths.map(pathKey))
                  if (
                    [...sources, ...sourceResources.protectedSources()].some((source) =>
                      targets.has(pathKey(source))
                    )
                  )
                    await playback.stop()
                  return action()
                })
              )
            )
          )
        ),
      authorizeFile: (path) => platform!.call('paths.authorizeAudioFile', { path }),
      authorizeRemoval: async (path, mode) => {
        // Library-only removal must also work for missing/offline files. SQL's
        // frozen identity is sufficient; only filesystem deletion needs a grant.
        if (mode === 'trash') await platform!.call('paths.authorizeAudioFile', { path })
      },
      trash: (path) => platform!.callJoined('files.trashAudio', { path }),
      tagJournalExists: async () => {
        for (const suffix of ['', '.bak']) {
          try {
            await access(join(config.root, 'tag-backups', `tag-write-journal.json${suffix}`))
            return true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        return false
      },
      tags: (request) => analysis!.libraryTags(join(config.root, 'tag-backups'), request),
      pathKey,
      directoryOf: dirname,
      fileName: basename,
      newId: randomUUID,
      changed: () => {
        application?.changed()
        imports?.rematch()
      }
    }),
    autoMix,
    analysis: playbackAnalysis,
    libraryLoudness,
    sleepTimer,
    settings: settingsService,
    outputTest,
    audition,
    dsp,
    output,
    search,
    audioRecovery: new CoreAudioRecoveryService({
      engine: audio,
      playback,
      configuration: output,
      windows: process.platform === 'win32',
      confirmWindowsRestart: (signal) => platform!.call('audio.confirmWindowsRestart', {}, signal),
      restartWindowsServices: () => platform!.callJoined('audio.restartWindowsServices', {}),
      changed: () => application?.changed()
    }),
    epoch: config.epoch,
    playback,
    cast,
    library: database,
    state: database,
    scan,
    libraryBackground,
    metadata,
    statistics,
    plugins,
    pluginMarketplace,
    pluginExperiences,
    playlists,
    recordingVersions,
    imports,
    importPreviews,
    bookmarks,
    lyrics,
    workspace,
    streams,
    network,
    cache: new CoreMusicCacheService({
      authorize: async () => {
        await platform!.call('cache.authorizeRoot', {})
      },
      maintainSources: (action) => autoMix.maintain(() => playback.maintainSources(action)),
      maintainResources: (action) => sourceResources.maintain(action),
      maintainNetwork: (action) => network.maintainCache(action),
      maintainProvider: (action) => (ncmCache ? ncmCache.maintain(action) : action()),
      maintainScanner: (action) => scanner.maintainCoverCache(action),
      clearFiles: (sources, signal) =>
        clearCoreMusicCache(
          musicCacheRoot(),
          [...sources, ...sourceResources.protectedSources()],
          signal
        ),
      clearPlatform: (signal) => platform!.callJoined('cache.clearPlatform', {}, signal),
      info: async () => ({ sizeBytes: await getManagedMusicCacheSize(musicCacheRoot()) }),
      clearNetwork: (signal) =>
        network.clearCache(
          (action) =>
            autoMix.maintain(() =>
              playback.maintainSources((sources) =>
                sourceResources.maintain(() =>
                  action([...sources, ...sourceResources.protectedSources()])
                )
              )
            ),
          signal
        )
    }),
    downloads,
    ready: () => {
      ready = true
      if (initializedSent) send({ kind: 'core:ready', epoch: config.epoch })
    }
  })
  remote.attach(application)
  await application.initialize()
  send({ kind: 'core:initialized', epoch: config.epoch })
  initializedSent = true
  if (ready) send({ kind: 'core:ready', epoch: config.epoch })
  if (!ready) console.info('[core] waiting for the one-time browser data import')
}
function pathKey(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
}

async function shutdown(requestId: string): Promise<void> {
  try {
    if (!application || !configuration) throw new Error('Core was not initialized')
    await application.shutdown()
    await ncmCache?.shutdown()
    await ncm?.shutdown()
    analysis?.destroy()
    analysis = null
    await database?.close()
    database = null
    audio?.destroy()
    audio = null
    launcher?.destroy()
    platform?.destroy()
    send({ kind: 'core:shutdown-complete', epoch: configuration.epoch, requestId, ok: true })
  } catch (error) {
    send({
      kind: 'core:shutdown-complete',
      epoch: configuration?.epoch ?? '',
      requestId,
      ok: false,
      error: errorText(error)
    })
  }
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
