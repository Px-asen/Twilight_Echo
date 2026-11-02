import type {
  BpmAnalysisRequest,
  BpmAnalysisRequestResult,
  BpmAnalysisCompletedEvent,
  LoudnessAnalysisRequest,
  LoudnessAnalysisRequestResult,
  LoudnessAnalysisCompletedEvent,
  LoudnormStatusEvent,
  ProviderDownloadCreateInput,
  ProviderDownloadTaskSnapshot,
  OpraCatalogStatus,
  OpraProfile,
  PlaybackSession,
  TwilightPluginDescriptor,
  TwilightPluginInstallResult,
  TwilightPluginIndexEntry,
  TwilightPluginIndexStatus,
  TwilightMediaProviderRegistration,
  TwilightPluginExtensionContribution,
  AudioEngineConfigAppliedEvent
} from './types.ts'
import type {
  MiniPlayerSettings,
  MiniPlayerStateSnapshot,
  MiniPlayerSettingsPatch
} from '../shared/miniPlayer.ts'
import type { TrayNavigationTarget } from '../shared/trayPlayer.ts'
import type { ExperienceWindowOptions, ExperienceWindowTheme } from '../shared/experienceWindow.ts'
import type {
  DynamicIslandBootstrap,
  DynamicIslandLyricsPayload,
  DynamicIslandPresentation
} from '../shared/dynamicIsland.ts'
import type { VersionedDataEnvelope } from '../shared/versionedPersistence.ts'
import type {
  AudioOutputId,
  PlayMode,
  VolumeNormalizationMode,
  AudioProcessingSettings,
  AudioOutputOption,
  OutputConfig,
  OutputConfigApplyStatus,
  AudioOutputState,
  AudioEngineQueueItem,
  PlaybackInfo,
  AudioEnginePlayResult,
  VisualizationOptions,
  VisualizationData,
  ConvolverInfo,
  NativeAudioMetadata
} from '../shared/audioEngineTypes.ts'
import type { AudioEqPreset, AppSettings, SettingsSnapshot } from '../shared/appSettings.ts'
import type {
  AudioDeviceProfile,
  AudioDeviceProfilesSnapshot
} from '../shared/audioDeviceProfiles.ts'
import type {
  DesktopLyricsBootstrap,
  DesktopLyricsClockSnapshot,
  DesktopLyricsSession,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction
} from '../shared/desktopLyrics.ts'
import type { TrackData } from '../shared/track.ts'
import type { NativeContextMenuRequest } from '../shared/nativeContextMenu.ts'
import type { EqualizerClipboardApi } from '../shared/equalizerClipboard.ts'
import type {
  DspAsset,
  DspAssetKind,
  DspCorrectionImportResult,
  DspCorrectionProfile,
  DspGraphStatus,
  DspOutputStageConfig,
  DspProfile,
  DspScene,
  DspSceneState,
  DspStereoImageConfig,
  Vst3CatalogState
} from '../shared/dspGraph.ts'
import type { ImportedFrequencyResponse } from '../shared/frequencyResponse.ts'
import type { AppStartupSnapshot } from '../shared/appStartup.ts'
import type { AppHistoryCommand } from '../shared/appHistory.ts'
import type {
  ThemeAssetReference,
  ThemeAssetType,
  ThemeBootstrap,
  ThemeLibrarySnapshot,
  ThemeProfileV2,
  ThemeSelection,
  ThemeWindowInheritance
} from '../shared/theme.ts'
import type {
  LocalLibraryRemoveRequest,
  LocalLibraryRemoveResult,
  LocalLibraryResetResult,
  LocalLibraryClearExclusionsRequest,
  LocalLibraryClearExclusionsResult,
  LocalLibraryRestoreRequest,
  LocalLibraryRestoreResult,
  LocalLibrarySnapshotInput,
  LocalMusicLibraryDocument
} from '../shared/localLibrary.ts'
import type {
  LocalLibraryTagRestoreRequest,
  LocalLibraryTagRestoreResult,
  LocalLibraryTagWriteRequest,
  LocalLibraryTagWriteResult
} from '../shared/localLibraryTags.ts'
import type {
  LocalLibraryScanProgress,
  LocalLibraryScanStatus,
  LocalLibraryScanUpdate
} from '../shared/localLibraryScan.ts'
import type { DuplicateDetectionReadApi } from '../shared/duplicateDetection.ts'
import type { LyricsManagementDocument } from '../shared/lyricsManagement.ts'
import type { PluginNotice } from '../shared/pluginNotice.ts'
import type { PluginPlaylistImportNotice } from '../shared/pluginPlaylistImport.ts'
import type {
  NcmCloudDownloadRequest,
  NcmCloudDownloadResult,
  NcmCloudSelectedFile,
  NcmCloudTransferProgress,
  NcmCloudUploadResult
} from '../shared/ncmCloud.ts'

export {}

interface AudioEngineEvent {
  name: string
  data: unknown
}

type PlayerShortcutAction =
  | 'previous'
  | 'next'
  | 'playPause'
  | 'play'
  | 'pause'
  | 'toggleDesktopLyrics'
  | 'toggleDesktopLyricsLock'
  | { action: 'seek'; positionSeconds: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'jumpQueue'; index: number }
interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutAction
  label: string
  registered: boolean
  error: string | null
}

type LibraryChange =
  | { kind: 'database'; revision: number }
  | { kind: 'add' | 'remove' | 'unknown'; path?: string; revision?: number }
  | { kind: 'scan'; update: LocalLibraryScanUpdate }

import type { TwilightMediaProviderMethod } from '../shared/mediaProviderMethods.ts'

type MotionPreference = 'system' | 'full' | 'reduced' | 'off'

type MiniPlayerCommand =
  | { type: 'toggle-play' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'previous' }
  | { type: 'next' }
  | { type: 'cycle-play-mode' }
  | { type: 'set-play-mode'; value: PlayMode }
  | { type: 'toggle-favorite' }
  | { type: 'seek'; value: number }
  | { type: 'set-volume'; value: number }

interface MiniPlayerBootstrap {
  state: MiniPlayerStateSnapshot
  settings: MiniPlayerSettings
  motionPreference: MotionPreference
}

interface TrayPlayerBootstrap {
  state: MiniPlayerStateSnapshot
  motionPreference: MotionPreference
}

interface AudioEngineAPI {
  installAutoMixStemPack: () => Promise<
    import('../shared/twilightAutoMix.ts').AutoMixStemInstallStatus
  >
  getAutoMixStemInstallStatus: () => Promise<
    import('../shared/twilightAutoMix.ts').AutoMixStemInstallStatus
  >
  cancelAutoMixStemInstall: () => Promise<
    import('../shared/twilightAutoMix.ts').AutoMixStemInstallStatus
  >
  getAutoMixStemCapabilities: (
    refresh?: boolean
  ) => Promise<import('../shared/twilightAutoMix.ts').AutoMixStemCapabilities>
  loadQueue: (
    items: AudioEngineQueueItem[],
    startIndex?: number
  ) => Promise<import('../shared/nativeQueue').NativeQueueCommit | void>
  selectQueueItem?: (
    selection: import('../shared/nativeQueue').NativeQueueSelection
  ) => Promise<boolean>
  rebindQueue?: (
    request: import('../shared/nativeQueue').NativeQueueRebind
  ) => Promise<import('../shared/nativeQueue').NativeQueueCommit | null>
  play: (filePath: string, startTime?: number) => Promise<AudioEnginePlayResult>
  isHtmlAudioFallbackAllowed: () => Promise<boolean>
  togglePause: () => Promise<void>
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => Promise<void>
  setPlaybackRate: (rate: number) => Promise<void>
  /** Native A-B loop; end <= start clears. Returns false when native unavailable. */
  setLoopRange: (startSeconds: number, endSeconds: number) => Promise<boolean>
  stop: () => Promise<void>
  next: () => Promise<void>
  previous: () => Promise<void>
  setPlayMode: (mode: PlayMode) => Promise<void>
  getUpcomingTrack: () => Promise<AudioEngineQueueItem | null>
  setExclusiveMode: (enabled: boolean) => Promise<AudioOutputState>
  getExclusiveMode: () => Promise<boolean>
  setAudioOutput: (output: AudioOutputId, device?: string) => Promise<AudioOutputState>
  getDeviceProfiles: () => Promise<AudioDeviceProfilesSnapshot>
  saveDeviceProfile: (profile: AudioDeviceProfile) => Promise<AudioDeviceProfilesSnapshot>
  deleteDeviceProfile: (id: string) => Promise<AudioDeviceProfilesSnapshot>
  applyDeviceProfile: (id: string) => Promise<AudioDeviceProfilesSnapshot>
  onDeviceProfilesChanged: (callback: () => void) => () => void
  setAudioDevice: (device: string) => Promise<AudioOutputState>
  setOutputConfig: (config: OutputConfig) => Promise<OutputConfig>
  getOutputConfigApplyStatus: () => Promise<OutputConfigApplyStatus>
  getAudioOutput: () => Promise<AudioOutputId>
  getAudioOutputOptions: () => Promise<AudioOutputOption[]>
  getAudioOutputState: () => Promise<AudioOutputState>
  setAudioProcessing: (
    settings: Partial<AudioProcessingSettings>
  ) => Promise<AudioProcessingSettings>
  getAudioProcessing: () => Promise<AudioProcessingSettings>
  getDspSceneState: () => Promise<DspSceneState>
  audition: import('../shared/dspAudition.ts').DspAuditionApi
  setDspScenes: (scenes: DspScene[], pinnedSceneId?: string | null) => Promise<DspSceneState>
  setOutputStage: (partial: Partial<DspOutputStageConfig>) => Promise<DspSceneState>
  setStereoImage: (partial: Partial<DspStereoImageConfig>) => Promise<DspSceneState>
  applyDspScene: (sceneId: string | null, confirmDsdPcmFallback?: boolean) => Promise<DspSceneState>
  getDspGraphStatus: () => Promise<DspGraphStatus>
  getDspAssets: () => Promise<DspAsset[]>
  importDspAsset: (kind: DspAssetKind) => Promise<DspAsset | null>
  importDspCorrectionProfile: () => Promise<DspCorrectionImportResult | null>
  importFrequencyResponse: () => Promise<ImportedFrequencyResponse | null>
  getDspCorrectionProfile: (assetId: string) => Promise<DspCorrectionProfile>
  deleteDspAsset: (assetId: string) => Promise<DspAsset[]>
  exportDspProfile: (name?: string) => Promise<DspProfile | null>
  importDspProfile: () => Promise<{
    state: DspSceneState
    profile: DspProfile
    importedAssets: DspAsset[]
  } | null>
  getVst3Catalog: () => Promise<Vst3CatalogState>
  setVst3Enabled: (enabled: boolean) => Promise<Vst3CatalogState>
  selectVst3SearchPath: () => Promise<string | null>
  setVst3SearchPaths: (paths: string[]) => Promise<Vst3CatalogState>
  scanVst3Plugins: () => Promise<Vst3CatalogState>
  clearVst3Quarantine: (id: string) => Promise<Vst3CatalogState>
  selectImpulseResponse: () => Promise<string | null>
  loadImpulseResponse: (path: string) => Promise<ConvolverInfo>
  unloadImpulseResponse: () => Promise<ConvolverInfo>
  getConvolverInfo: () => Promise<ConvolverInfo>
  setEqBands: (settings: Partial<AudioProcessingSettings>) => Promise<AudioProcessingSettings>
  setEqPreset: (preset: AudioEqPreset) => Promise<AudioProcessingSettings>
  setCrossfeedStrength: (strength: number) => Promise<AudioProcessingSettings>
  setReplayGainMode: (
    mode: VolumeNormalizationMode,
    preamp?: number,
    fallback?: number,
    clip?: boolean
  ) => Promise<AudioProcessingSettings>
  getMetadata: (source: string) => Promise<NativeAudioMetadata | null>
  getPlaybackInfo: () => Promise<PlaybackInfo>
  testOutput: (exclusive: boolean) => Promise<{ cancelled: boolean }>
  stopOutputTest: () => Promise<void>
  exportDiagnostics: () => Promise<{ filePath: string | null }>
  getSpectrumData: (points?: number) => Promise<number[]>
  getVisualizationData: (options?: VisualizationOptions) => Promise<VisualizationData>

  onPropertyChange: (cb: (event: AudioEngineEvent) => void) => () => void
  onEndFile: (cb: (reason: string) => void) => () => void
  onStartFile: (cb: () => void) => () => void
  onReady: (cb: () => void) => () => void
  onError: (cb: (message: string) => void) => () => void
  onDisconnected: (cb: () => void) => () => void
  onPlaybackInfo: (cb: (info: PlaybackInfo) => void) => () => void
  onLoudnormStatus: (cb: (event: LoudnormStatusEvent) => void) => () => void
  onConfigApplied: (cb: (event: AudioEngineConfigAppliedEvent) => void) => () => void
  onDeviceOptionsChanged: (cb: (event: { reason: string }) => void) => () => void
  onServiceCrash: (cb: (event: { reason: string; fatal?: boolean }) => void) => () => void
  restartService: () => Promise<{ restarted: boolean; error: string }>
  onServiceReady: (
    cb: (event: {
      manualResumeRequired: boolean
      outputRouteSynced: boolean
      restoreErrors: string[]
    }) => void
  ) => () => void
}

interface OpraAPI {
  search: (query: string) => Promise<OpraProfile[]>
  getProfile: (eqId: string) => Promise<OpraProfile | null>
  refresh: () => Promise<OpraCatalogStatus>
  getStatus: () => Promise<OpraCatalogStatus>
}

interface WindowAPI {
  core: import('../shared/coreBridge.ts').CoreBridgeApi
  playlistImport: {
    chooseFile(): Promise<import('../shared/externalPlaylist.ts').PlaylistImportDocument | null>
    resolveNeteaseShortLink(request: {
      input: string
      requestId: string
    }): Promise<import('../shared/externalPlaylist.ts').PlaylistLink>
    readPage(request: {
      link: string
      offset: number
      cursor?: string
      requestId?: string
      credentials?: {
        accessToken?: string
        developerToken?: string
        userToken?: string
        country?: string
      }
    }): Promise<import('../shared/externalPlaylist.ts').PlaylistImportPage>
    cancelRead(requestId: string): Promise<boolean>
  }
  diagnostics: import('../shared/diagnostics.ts').DiagnosticsApi
  systemMedia: {
    getNativeStatus: () => Promise<import('../shared/systemMedia.ts').SystemMediaNativeStatus>
  }
  sleepTimer: {
    configure: (
      state: import('../shared/sleepTimer.ts').SleepTimerState
    ) => Promise<import('../shared/sleepTimer.ts').SleepTimerState | null>
    cancel: () => Promise<null>
    getState: () => Promise<import('../shared/sleepTimer.ts').SleepTimerState | null>
    boundary: (
      boundary: 'trackEnd' | 'queueEnd'
    ) => Promise<import('../shared/sleepTimer.ts').SleepTimerState | null>
    onState: (
      callback: (state: import('../shared/sleepTimer.ts').SleepTimerState | null) => void
    ) => () => void
    onTrigger: (
      callback: (state: import('../shared/sleepTimer.ts').SleepTimerState) => void
    ) => () => void
  }
  window: EqualizerClipboardApi & {
    copyTrackNames: (text: string) => Promise<void>
    getState: () => Promise<import('../shared/windowChrome.ts').WindowChromeState>
    onStateChanged: (
      callback: (state: import('../shared/windowChrome.ts').WindowChromeState) => void
    ) => () => void
    popupContextMenu: (request: NativeContextMenuRequest) => Promise<string | null>
    closeContextMenu: (requestId: string) => Promise<void>
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    showTrayPlayer: (options?: ExperienceWindowOptions) => Promise<void>
  }
  experienceWindow: {
    onTheme: (callback: (theme: ExperienceWindowTheme) => void) => () => void
  }
  dialog: {
    openFolder: (options?: { deferImport?: boolean }) => Promise<string | null>
  }
  shell: {
    showItemInFolder: (filePath: string) => Promise<void>
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
  }
  discord: {
    getStatus: () => Promise<{
      enabled: boolean
      connected: boolean
      lastError: string | null
    }>
    updateActivity: (data: {
      title: string
      artist: string
      album?: string
      playing: boolean
      startTime?: number
    }) => Promise<void>
    clearActivity: () => Promise<void>
  }
  library: DuplicateDetectionReadApi & {
    getStorageMode: () => Promise<'json' | 'sqlite'>
    database: {
      buildQueue: import('../shared/libraryQueueBuild.ts').LibraryQueueBuildApi['buildQueue']
      selection: import('../shared/librarySelection.ts').LibrarySelectionBridgeApi['selection']
      repairPlaylist: import('../shared/playlistRepair.ts').LibraryPlaylistRepairApi['repairPlaylist']
      syncListeningHistory: import('../shared/libraryDatabase.ts').LibraryDatabaseApi['syncListeningHistory']
      syncPlaylistView: import('../shared/libraryDatabase.ts').LibraryDatabaseApi['syncPlaylistView']
      scanDirectories: import('../shared/libraryDatabase.ts').LibraryFileMutationApi['scanDirectories']
      removeFiles: import('../shared/libraryDatabase.ts').LibraryFileMutationApi['removeFiles']
      getMetadata: () => Promise<import('../shared/libraryDatabase.ts').LibraryMetadata>
      queryTracks: (
        query?: import('../shared/libraryDatabase.ts').LibraryQuery
      ) => Promise<import('../shared/libraryDatabase.ts').LibraryPage>
      queryCollections: (
        kind: import('../shared/libraryDatabase.ts').LibraryCollectionKind,
        query?: import('../shared/libraryDatabase.ts').LibraryQuery
      ) => Promise<import('../shared/libraryDatabase.ts').LibraryCollectionPage>
      getTracksByIds: import('../shared/libraryDatabase.ts').LibraryDatabaseApi['getTracksByIds']
      lookupTracksByPaths: import('../shared/libraryDatabase.ts').LibraryDatabaseApi['lookupTracksByPaths']
      lookupPlaylistTracks: import('../shared/libraryDatabase.ts').LibraryDatabaseApi['lookupPlaylistTracks']
      patchTracks: (
        patches: import('../shared/libraryDatabase.ts').LibraryTrackPatch[]
      ) => Promise<import('../shared/libraryDatabase.ts').LibraryPage>
      createQueue: (
        query: import('../shared/libraryDatabase.ts').LibraryQuery,
        selectedId?: string
      ) => Promise<import('../shared/libraryDatabase.ts').LibraryQueueSnapshot>
      readQueue: (
        id: string,
        offset?: number,
        limit?: number,
        options?: import('../shared/libraryDatabase.ts').LibraryQueueReadOptions
      ) => Promise<import('../shared/libraryDatabase.ts').LibraryQueuePage>
      getQueue: (id: string) => Promise<import('../shared/libraryDatabase.ts').LibraryQueueSnapshot>
      editQueue: (
        id: string,
        revision: number,
        edit: import('../shared/libraryDatabase.ts').LibraryQueueEdit
      ) => Promise<import('../shared/libraryDatabase.ts').LibraryQueueEditResult>
      deleteQueue: (id: string, revision: number) => Promise<void>
      syncQueueReferences: (owner: string, ids: string[]) => Promise<void>
      collectQueueGarbage: (olderThanMs?: number) => Promise<number>
    }
    removeTracks: (request: LocalLibraryRemoveRequest) => Promise<LocalLibraryRemoveResult>
    clearExclusions: (
      request: LocalLibraryClearExclusionsRequest
    ) => Promise<LocalLibraryClearExclusionsResult>
    restoreExclusions: (request: LocalLibraryRestoreRequest) => Promise<LocalLibraryRestoreResult>
    reset: () => Promise<LocalLibraryResetResult>
    writeTags: (request: LocalLibraryTagWriteRequest) => Promise<LocalLibraryTagWriteResult>
    restoreTags: (request: LocalLibraryTagRestoreRequest) => Promise<LocalLibraryTagRestoreResult>
    scanStartup: () => Promise<LocalLibraryScanUpdate>
    scanFull: () => Promise<LocalLibraryScanUpdate>
    getScanStatus: () => Promise<LocalLibraryScanStatus>
    getWatcherStatus: () => Promise<
      import('../shared/localLibraryScan.ts').LibraryWatcherStatusSnapshot
    >
    pauseScan: () => Promise<boolean>
    resumeScan: () => Promise<boolean>
    cancelScan: () => Promise<boolean>
    onChanged: (cb: (change: LibraryChange | undefined) => void) => () => void
    onCoversMissing: (cb: (info: { dirtyCount: number }) => void) => () => void
    onScanProgress: (cb: (progress: LocalLibraryScanProgress) => void) => () => void
    onScanStatus: (cb: (status: LocalLibraryScanStatus) => void) => () => void
  }
  fs: {
    scanMusicFiles: (folderPath: string) => Promise<TrackData[]>
    getAudioFileUrl: (filePath: string) => Promise<string>
    isAudioFileAuthorized: (filePath: string) => Promise<boolean>
    areAudioFilesAuthorized: (filePaths: string[]) => Promise<boolean[]>
    onScanProgress: (cb: (progress: { current: number; total: number }) => void) => () => void
  }
  audioEngine: AudioEngineAPI
  bpmAnalysis: {
    request: (request: BpmAnalysisRequest) => Promise<BpmAnalysisRequestResult>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    cancel: (filePath?: string) => Promise<void>
    onCompleted: (cb: (event: BpmAnalysisCompletedEvent) => void) => () => void
  }
  loudnessAnalysis: import('../shared/libraryLoudness.ts').LibraryLoudnessApi & {
    request: (request: LoudnessAnalysisRequest) => Promise<LoudnessAnalysisRequestResult>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    getStatus: () => Promise<{ status: string; source: string | null }>
    cancel: (filePath?: string) => Promise<void>
    onCompleted: (cb: (event: LoudnessAnalysisCompletedEvent) => void) => () => void
  }
  opra: OpraAPI
  app: {
    getStartupSnapshot: () => Promise<AppStartupSnapshot>
    consumePendingNavigation: () => Promise<TrayNavigationTarget | null>
    relaunch: () => Promise<void>
    checkForUpdates: () => Promise<import('../shared/appUpdate').AppUpdateCheckResult>
    getUpdateState: () => Promise<import('../shared/appUpdate').AppUpdateSnapshot>
    setUpdatePreferences: (
      patch: import('../shared/appUpdate').AppUpdatePreferencePatch
    ) => Promise<import('../shared/appUpdate').AppUpdateSnapshot>
    dismissUpdate: (
      action: 'skip' | 'later'
    ) => Promise<import('../shared/appUpdate').AppUpdateSnapshot>
    onUpdateState: (
      cb: (snapshot: import('../shared/appUpdate').AppUpdateSnapshot) => void
    ) => () => void
    downloadUpdate: () => Promise<import('../shared/appUpdate').AppUpdateDownloadResult>
    cancelUpdateDownload: () => Promise<boolean>
    installUpdate: () => Promise<import('../shared/appUpdate').AppUpdateInstallResult>
    onUpdateProgress: (
      cb: (progress: import('../shared/appUpdate').AppUpdateProgress) => void
    ) => () => void
    /**
     * Reject to report a failed close-time persistence transaction. The main
     * process keeps the window open and offers the user a retry path.
     * `includeQueue` asks for a queue-inclusive snapshot (Afterglow entry).
     */
    onSavePlaybackSession: (
      cb: (
        options?: import('../shared/closePersistence.ts').PlaybackSessionSaveOptions
      ) => Promise<void> | void
    ) => () => void
    onNavigate: (cb: (target: TrayNavigationTarget) => void) => () => void
    /** Mouse side-button back/forward presses forwarded from the main process. */
    onHistoryCommand: (cb: (command: AppHistoryCommand) => void) => () => void
    /** Renderer-unload mode (Afterglow): status, entry, restore and live handoff. */
    afterglow: {
      getStatus: () => Promise<import('../shared/afterglowMode.ts').AfterglowModeStatus>
      enter: () => Promise<import('../shared/afterglowMode.ts').AfterglowModeStatus>
      restore: () => Promise<import('../shared/afterglowMode.ts').AfterglowModeStatus>
      getRestoreState: () => Promise<
        import('../shared/afterglowMode.ts').AfterglowRestoreState | null
      >
      rendererAdoptComplete: () => Promise<void>
      /** Pre-unload queue snapshot handed to main (memory only). */
      publishRendererSnapshot: (
        snapshot: import('../shared/afterglowMode.ts').AfterglowRendererSnapshot
      ) => Promise<boolean>
    }
  }
  ncmCloud: {
    chooseUploadFiles: () => Promise<NcmCloudSelectedFile[]>
    upload: (handle: string) => Promise<NcmCloudUploadResult>
    download: (request: NcmCloudDownloadRequest) => Promise<NcmCloudDownloadResult>
    cancel: (transferId: string) => Promise<boolean>
    onProgress: (callback: (progress: NcmCloudTransferProgress) => void) => () => void
  }
  radio: {
    loadStations: () => Promise<
      VersionedDataEnvelope<import('../shared/radioStations.ts').RadioStationsDocument>
    >
    saveStations: (
      document: import('../shared/radioStations.ts').RadioStationsDocument,
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<import('../shared/radioStations.ts').RadioStationsDocument>>
    importPlaylist: (payload: {
      text: string
      fileNameHint?: string
      allowInsecureHttp?: boolean
    }) => Promise<import('../shared/radioStations.ts').RadioStation[]>
    searchDirectory: (payload: { query: string; limit?: number; offset?: number }) => Promise<
      Array<{
        stationuuid: string
        name: string
        url: string
        urlResolved: string
        homepage?: string
        favicon?: string
        tags: string[]
        countryCode?: string
        bitrate?: number
        codec?: string
        votes?: number
      }>
    >
  }
  podcast: {
    loadSubscriptions: () => Promise<
      VersionedDataEnvelope<
        import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      >
    >
    saveSubscriptions: (
      document: import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument,
      expectedRevision: number
    ) => Promise<
      VersionedDataEnvelope<
        import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      >
    >
    subscribe: (feedUrl: string) => Promise<{
      subscription: import('../shared/podcastSubscriptions.ts').PodcastSubscription
      document: import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      revision: number
    }>
    refresh: (subscriptionId: string) => Promise<{
      subscription: import('../shared/podcastSubscriptions.ts').PodcastSubscription
      document: import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
      revision: number
    }>
    refreshAll: () => Promise<
      import('../shared/podcastSubscriptions.ts').PodcastSubscriptionsDocument
    >
  }
  data: {
    chooseRestoreFolder: () => Promise<string | null>
    exportPersonalBackup: (
      data: import('../shared/personalBackup.ts').PersonalData
    ) => Promise<boolean>
    previewPersonalBackup: (
      data: import('../shared/personalBackup.ts').PersonalData
    ) => Promise<import('../shared/personalBackup.ts').PersonalBackupPreview | null>
    stagePersonalRestore: (
      options: import('../shared/personalBackup.ts').PersonalRestoreOptions
    ) => Promise<void>
    readRendererRestore: () => Promise<unknown>
    acknowledgeRendererRestore: (id: string) => Promise<void>
    saveMusicLibrary: (data: LocalLibrarySnapshotInput) => Promise<LocalMusicLibraryDocument>
    loadMusicLibrary: () => Promise<LocalMusicLibraryDocument | unknown[]>
    getCover: (handle: string, size?: 'sm' | 'md') => Promise<Uint8Array | string | null>
    cacheCover: (data: ArrayBuffer | Uint8Array) => Promise<string | null>
    grantRemoteCover: (source: string) => Promise<string>
    getLyrics: (dir: string, fileName: string, filePath?: string) => Promise<string | null>
    getTranslatedLyrics: (
      dir: string,
      fileName: string,
      filePath?: string
    ) => Promise<string | null>
    getRomanizedLyrics: (dir: string, fileName: string, filePath?: string) => Promise<string | null>
    getAmlTtml: (songId: number) => Promise<string | null>
    importLyrics: () => Promise<string | null>
    saveLyrics: (contents: string) => Promise<string | null>
    searchOnlineLyrics: (query: {
      title: string
      artist: string
      album?: string
      durationSeconds?: number
    }) => Promise<{
      query: { title: string; artist: string; album?: string; durationSeconds?: number }
      candidates: Array<{
        id: number | string
        title: string
        artist: string
        album: string
        durationSeconds: number | null
        score: number
        syncedLyrics: string | null
        plainLyrics: string | null
        source: 'lrclib'
      }>
      best: {
        id: number | string
        title: string
        artist: string
        album: string
        durationSeconds: number | null
        score: number
        syncedLyrics: string | null
        plainLyrics: string | null
        source: 'lrclib'
      } | null
    }>
    saveLyricsManagement: (
      document: LyricsManagementDocument,
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<LyricsManagementDocument>>
    loadLyricsManagement: () => Promise<VersionedDataEnvelope<LyricsManagementDocument> | null>
    loadPlaybackBookmarks: () => Promise<VersionedDataEnvelope<
      import('../shared/playbackBookmarks.ts').PlaybackBookmarksDocument
    > | null>
    savePlaybackBookmarks: (
      document: import('../shared/playbackBookmarks.ts').PlaybackBookmarksDocument,
      expectedRevision: number
    ) => Promise<
      VersionedDataEnvelope<import('../shared/playbackBookmarks.ts').PlaybackBookmarksDocument>
    >
    loadQueueWorkspace: () => Promise<VersionedDataEnvelope<
      import('../shared/queueWorkspace.ts').QueueWorkspaceDocument
    > | null>
    saveQueueWorkspace: (
      document: import('../shared/queueWorkspace.ts').QueueWorkspaceDocument,
      expectedRevision: number
    ) => Promise<
      VersionedDataEnvelope<import('../shared/queueWorkspace.ts').QueueWorkspaceDocument>
    >
    savePlaybackSession: (
      session: PlaybackSession,
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<PlaybackSession>>
    loadPlaybackSession: () => Promise<VersionedDataEnvelope<PlaybackSession | null> | null>
    clearPlaybackSession: (
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<PlaybackSession | null>>
    savePlaylists: (
      playlists: unknown[],
      expectedRevision: number
    ) => Promise<VersionedDataEnvelope<unknown[]>>
    loadPlaylists: () => Promise<VersionedDataEnvelope<unknown[]> | null>
    saveCookie: (cookie: string) => Promise<void>
    loadCookie: () => Promise<string>
  }
  networkSources: {
    listProfiles: () => Promise<import('../shared/networkSources.ts').NetworkSourceProfileSummary[]>
    createProfile: (
      input: import('../shared/networkSources.ts').NetworkSourceProfileInput
    ) => Promise<import('../shared/networkSources.ts').NetworkSourceProfileSummary>
    updateProfile: (
      id: string,
      patch: Partial<import('../shared/networkSources.ts').NetworkSourceProfileInput>
    ) => Promise<import('../shared/networkSources.ts').NetworkSourceProfileSummary>
    deleteProfile: (id: string) => Promise<void>
    listDirectory: (
      profileId: string,
      remotePath: string
    ) => Promise<import('../shared/networkSources.ts').NetworkEntry[]>
    testConnection: (profileId: string) => Promise<{
      ok: boolean
      errorCode?: import('../shared/networkSources.ts').NetworkSourceErrorCode
    }>
    resolvePlayback: (
      profileId: string,
      entry: import('../shared/networkSources.ts').NetworkEntry
    ) => Promise<import('../shared/networkSources.ts').NetworkPlaybackPlan>
    scanDirectory: (
      profileId: string,
      remotePath: string
    ) => Promise<{ added: number; total: number }>
    listLibrary: (
      profileId: string,
      query?: string
    ) => Promise<import('../shared/networkSources.ts').NetworkEntry[]>
    removeLibraryEntry: (profileId: string, entryId: string) => Promise<void>
    enrichLibrary: (profileId: string) => Promise<{ enriched: number; failed: number }>
    cacheInfo: () => Promise<{ sizeBytes: number }>
    clearCache: () => Promise<{ ok: boolean }>
    searchLibrary: (query?: string) => Promise<
      Array<{
        profileId: string
        profileName: string
        entry: import('../shared/networkSources.ts').NetworkEntry
      }>
    >
    coverDataUrl: (profileId: string, entryId: string) => Promise<string | null>
  }
  remote: {
    getStatus: () => Promise<import('../shared/remoteControl.ts').RemoteControlStatus>
    setEnabled: (
      enabled: boolean
    ) => Promise<import('../shared/remoteControl.ts').RemoteControlStatus>
    rotatePin: () => Promise<{
      pin: string
      status: import('../shared/remoteControl.ts').RemoteControlStatus
    }>
    publishState: (
      snapshot: Partial<import('../shared/remoteControl.ts').RemotePlaybackSnapshot>
    ) => Promise<boolean>
    onRequest: (
      callback: (
        request: import('../shared/remoteControl.ts').RemoteRendererRequest
      ) =>
        | Promise<import('../shared/remoteControl.ts').RemoteBrowseResult | void>
        | import('../shared/remoteControl.ts').RemoteBrowseResult
        | void
    ) => () => void
    discoverDlna: () => Promise<import('../shared/remoteControl.ts').DlnaDeviceInfo[]>
    castToDevice: (payload: {
      usn: string
      /** Authorized local library / managed-cache path. Mutually exclusive with mediaUrl. */
      filePath?: string
      /** Direct http(s) stream URL (podcast / radio / provider). Mutually exclusive with filePath. */
      mediaUrl?: string
      contentType?: string
      title?: string
      artist?: string
      album?: string
      positionSeconds?: number
    }) => Promise<{ ok: true; usn: string; friendlyName: string; mediaUrl: string }>
    stopCast: () => Promise<{ ok: true }>
    getCastTarget: () => Promise<{ usn: string; friendlyName: string } | null>
    controlCast: (payload: {
      seek?: number
      volume?: number
      pause?: boolean
      play?: boolean
    }) => Promise<{ ok: boolean; reason?: string }>
  }
  settings: {
    get: () => Promise<SettingsSnapshot>
    update: (patch: Partial<AppSettings>) => Promise<SettingsSnapshot>
    chooseCacheFolder: () => Promise<string | null>
    chooseDownloadFolder: () => Promise<string | null>
    chooseBackgroundImage: () => Promise<string | null>
    importBackgroundImage: (fileName: string, data: ArrayBuffer) => Promise<string | null>
    exportBackup: () => Promise<string>
    importBackup: (json: string) => Promise<SettingsSnapshot>
    getCacheSize: () => Promise<number>
    clearCache: () => Promise<number>
    getShortcutStatuses: () => Promise<PlayerShortcutStatus[]>
    onChanged: (cb: (snapshot: SettingsSnapshot) => void) => () => void
    onPlayerShortcut: (cb: (action: PlayerShortcutAction) => void) => () => void
  }
  fonts: {
    listInstalled: () => Promise<string[]>
  }
  themeWorkshop: import('./types').ThemeWorkshopApi
  themes: {
    getSystemTone: () => Promise<ThemeTone>
    getBootstrap: () => Promise<ThemeBootstrap>
    list: () => Promise<ThemeLibrarySnapshot>
    save: (profile: ThemeProfileV2, expectedRevision: number) => Promise<ThemeLibrarySnapshot>
    delete: (profileId: string, expectedRevision: number) => Promise<ThemeLibrarySnapshot>
    setActive: (
      selection: ThemeSelection,
      expectedRevision: number
    ) => Promise<ThemeLibrarySnapshot>
    setWindowInheritance: (
      inheritance: ThemeWindowInheritance,
      expectedRevision: number
    ) => Promise<ThemeLibrarySnapshot>
    importTheme: (expectedRevision: number) => Promise<ThemeLibrarySnapshot | null>
    exportTheme: (profileId: string) => Promise<string | null>
    importAsset: (profileId: string, type: ThemeAssetType) => Promise<ThemeAssetReference | null>
    validateAssets: (profileId: string, assets: ThemeAssetReference[]) => Promise<boolean>
    copyAssets: (sourceProfileId: string, targetProfileId: string) => Promise<void>
    onChanged: (cb: (snapshot: ThemeLibrarySnapshot) => void) => () => void
    onSystemToneChanged: (cb: (tone: ThemeTone) => void) => () => void
  }
  plugins: {
    list: () => Promise<TwilightPluginDescriptor[]>
    chooseAndInstall: (
      kind?: 'package' | 'directory'
    ) => Promise<TwilightPluginInstallResult | null>
    enable: (id: string) => Promise<TwilightPluginDescriptor>
    disable: (id: string) => Promise<TwilightPluginDescriptor>
    uninstall: (id: string, options?: { removeData?: boolean }) => Promise<void>
    openLog: (id: string) => Promise<void>
    getLog: (id: string) => Promise<string>
    listIndex: () => Promise<TwilightPluginIndexEntry[]>
    refreshIndex: () => Promise<TwilightPluginIndexEntry[]>
    getIndexStatus: () => Promise<TwilightPluginIndexStatus>
    installFromIndex: (id: string) => Promise<TwilightPluginInstallResult>
    setNativeDspParameters: (
      id: string,
      parameters: Record<string, number>
    ) => Promise<TwilightPluginDescriptor>
    onChanged: (cb: () => void) => () => void
    onNotice: (cb: (notice: PluginNotice) => void) => () => void
    takePlaylistImports: () => Promise<PluginPlaylistImportNotice[]>
    onImportPlaylist: (cb: () => void) => () => void
  }
  providers: {
    list: () => Promise<TwilightMediaProviderRegistration[]>
    call: (
      providerId: string,
      method: TwilightMediaProviderMethod,
      args: unknown[],
      options?: { idempotencyKey?: string; requestId?: string }
    ) => Promise<unknown>
    cancel: (requestId: string) => void
  }
  providerDownloads: {
    result: (taskId: string, addToLibrary: boolean) => Promise<string>
    list: () => Promise<ProviderDownloadTaskSnapshot[]>
    create: (input: ProviderDownloadCreateInput) => Promise<ProviderDownloadTaskSnapshot>
    cancel: (taskId: string) => Promise<void>
    retry: (taskId: string) => Promise<ProviderDownloadTaskSnapshot>
    onChanged: (cb: (tasks: ProviderDownloadTaskSnapshot[]) => void) => () => void
  }
  extensions: {
    experienceExport: (
      pluginId: string,
      name: string,
      content: string
    ) => Promise<{ saved: boolean }>
    experienceMusic: (
      pluginId: string,
      operation: string,
      albums: unknown[],
      args: Record<string, unknown>
    ) => Promise<unknown>
    experienceDocument: (
      pluginId: string,
      update?: { revision: number; value: Record<string, unknown> }
    ) => Promise<{ revision: number; value: Record<string, unknown> }>
    experiences: () => Promise<import('../shared/pluginExperience.ts').InstalledExperience[]>
    experiencePreferences: (pluginId: string, value?: unknown) => Promise<unknown>
    list: () => Promise<TwilightPluginExtensionContribution[]>
    executeCommand: (command: string, args?: unknown[]) => Promise<unknown>
    readThemeStylesheet: (stylesheetPath: string) => Promise<string>
  }
  desktopLyrics: {
    setEnabled: (enabled: boolean, options?: ExperienceWindowOptions) => Promise<boolean>
    publishSession: (session: DesktopLyricsSession) => void
    publishClock: (clock: DesktopLyricsClockSnapshot) => void
    onEnabledChanged: (cb: (enabled: boolean) => void) => () => void
    onResyncRequested: (cb: () => void) => () => void
    onLoadFailed: (cb: (payload: { code: number; description: string }) => void) => () => void
    bootstrap: () => Promise<DesktopLyricsBootstrap>
    updateQuickSettings: (
      patch: Partial<DesktopLyricsSettingsV3>
    ) => Promise<DesktopLyricsSettingsV3>
    setLocked: (locked: boolean) => Promise<DesktopLyricsSettingsV3>
    setInteractionActive: (active: boolean) => Promise<void>
    setPausedHidden: (hidden: boolean) => Promise<void>
    transport: (action: DesktopLyricsTransportAction) => void
    moveTo: (x: number, y: number) => void
    moveEnd: () => void
    ready: () => void
    close: () => void
    onSessionChanged: (cb: (session: DesktopLyricsSession) => void) => () => void
    onClockChanged: (cb: (clock: DesktopLyricsClockSnapshot) => void) => () => void
    onSettingsChanged: (cb: (settings: DesktopLyricsSettingsV3) => void) => () => void
    onFreezeClock: (cb: () => void) => () => void
    onHoverIntent: (cb: (pointerInside: boolean) => void) => () => void
  }
  miniPlayer: {
    open: (options?: ExperienceWindowOptions) => Promise<MiniPlayerSettings>
    getBootstrap: () => Promise<MiniPlayerBootstrap>
    command: (command: MiniPlayerCommand) => void
    updateSettings: (patch: MiniPlayerSettingsPatch) => Promise<MiniPlayerSettings>
    chooseBackgroundImage: () => Promise<string | null>
    minimize: () => void
    returnToMain: () => void
    moveTo: (x: number, y: number) => void
    moveEnd: () => void
    publishState: (state: MiniPlayerStateSnapshot) => void
    /** Island-only lyric channel; keeps lyric payloads out of the shared snapshot. */
    publishLyrics: (payload: DynamicIslandLyricsPayload) => void
    onState: (cb: (state: MiniPlayerStateSnapshot) => void) => () => void
    onSettings: (cb: (settings: MiniPlayerSettings) => void) => () => void
    onMotionPreference: (cb: (preference: MotionPreference) => void) => () => void
    onCommand: (cb: (command: MiniPlayerCommand) => void) => () => void
  }
  trayPlayer: {
    getBootstrap: () => Promise<TrayPlayerBootstrap>
    command: (command: MiniPlayerCommand) => void
    navigate: (target: TrayNavigationTarget) => void
    hide: () => void
    onState: (cb: (state: MiniPlayerStateSnapshot) => void) => () => void
    onMotionPreference: (cb: (preference: MotionPreference) => void) => () => void
  }
  dynamicIsland: {
    getBootstrap: () => Promise<DynamicIslandBootstrap>
    command: (command: MiniPlayerCommand) => void
    setExpanded: (expanded: boolean) => Promise<boolean>
    onState: (cb: (state: MiniPlayerStateSnapshot) => void) => () => void
    onExpanded: (cb: (expanded: boolean) => void) => () => void
    onConfig: (cb: (presentation: DynamicIslandPresentation) => void) => () => void
    onLyrics: (cb: (payload: DynamicIslandLyricsPayload) => void) => () => void
  }
}

declare global {
  interface Window {
    api: WindowAPI
  }
}
