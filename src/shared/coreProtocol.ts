import type { CoreCastStart, CoreCastState, CoreCastDevice } from './coreCast.ts'
import type { BridgePeer, CoreZoneState } from './audioBridge.ts'
import type { ZonesView, ZoneTransport } from './coreZones.ts'
import type { CoreSignalPath } from './remoteDsp.ts'
import type { CoreAbLoopCommand, CoreAbLoopState } from './coreAbLoop.ts'
import type { CoreLibraryQueries } from './coreLibrary.ts'
import type { CoreAudioDiagnosticsQuery, AudioDiagnosticReport } from './coreAudioDiagnostics.ts'
import type { AudioRecoveryKind, AudioRecoveryState } from './audioRecovery.ts'
import type { CorePlaylistQueries, CorePlaylistCommands } from './corePlaylists.ts'
import type { CoreRemoteCommands, CoreRemoteQueries } from './coreRemote.ts'
import type { CoreQueueSubmitCommand, CoreQueueInsert, CoreQueueTrackInput } from './coreQueueSubmission.ts'
import type {
  CoreSystemPlaybackAction,
  CorePlayerPresentation,
  CoreSystemLyrics
} from './coreSystemPlayer.ts'
import type { OutputInfo } from './audioEngineTypes.ts'
import type {
  CoreCloudTransferState,
  CoreCloudTransferQuery,
  CoreCloudTransferPage
} from './coreCloudTransfer.ts'
import type { NcmCloudDownloadRequest } from './ncmCloud.ts'
import type { CoreSettingsBackupImport } from './coreSettingsBackup.ts'
import type { CoreModelPackStatus } from './coreModelPack.ts'
import type { OpraCatalogStatus, OpraProfile } from './coreOpra.ts'
import type { CoreThemeOperations } from './coreThemes.ts'
import type { CoreVisualizationEvent, CoreVisualizationSubscribe } from './coreVisualization.ts'
import type { CoreSettingsEdit, CoreSettingsState } from './coreSettings.ts'
import type { CoreSleepTimerConfigure, CoreSleepTimerState } from './coreSleepTimer.ts'
import type { CoreAutoMixCapabilities } from './coreAutoMix.ts'
import type { CoreInboxState, CoreInboxQuery, CoreInboxPage, CoreInboxMark } from './coreInbox.ts'
import type {
  CoreLoudnessPlanRequest,
  CoreLoudnessState,
  CoreLoudnessPage,
  CoreLoudnessResult
} from './coreAnalysis.ts'
import type { CorePersonalRestore } from './coreBackup.ts'
import type {
  CoreDuplicatesStatus,
  CoreDuplicatePageQuery,
  CoreDuplicatePage,
  CoreDuplicateGroup,
  CoreDuplicateItem
} from './coreDuplicates.ts'
import type { LibrarySelectionRequest } from './librarySelection.ts'
import type { CoreLibrarySelectionPage, CoreTagWrite } from './coreLibraryMaintenance.ts'
import type { LibraryWatcherFolderStatus } from './localLibraryScan.ts'
import type { CoreMetadataCandidates, LibraryMetadataEnrichmentStatus } from './coreMetadata.ts'
import type {
  CoreDspState,
  CoreDspEdit,
  CoreDspImport,
  CoreVst3Edit,
  CoreVst3Page,
  CoreVst3Parameters,
  CoreAuditionMeasure,
  CoreAuditionState
} from './coreDsp.ts'
import type { DspAsset, DspCorrectionProfile, DspGraphStatus } from './dspGraph.ts'
import type { CoreHeartState, CoreLikedPlayback } from './coreHeart.ts'
import type {
  CoreMusicSearchQuery,
  CoreMusicSearchPage,
  CoreCollectionSearchQuery,
  CoreCollectionSearchPage
} from './coreSearch.ts'
import type {
  CoreNetworkState,
  CoreNetworkPage,
  CoreNetworkPageQuery,
  CoreNetworkEntry,
  CoreNetworkProfile,
  CoreNetworkProfileEdit,
  CoreNetworkJobCommand,
  CoreNetworkTestResult,
  CoreNetworkPlayback
} from './coreNetwork.ts'
import type { CorePersonalizedStart, CorePersonalizedState } from './corePersonalized.ts'
import type {
  CorePlaylistMutation,
  CorePlaylistPage,
  CorePlaylistEntries
} from './corePlaylists.ts'
import type { CorePlaylistRepairStatus } from './corePlaylists.ts'
import type { CorePlaylistViewQuery, CorePlaylistViewPage } from './corePlaylists.ts'
import type { CoreImportProgress } from './corePlaylists.ts'
import type {
  CoreAudioOutput,
  CoreOutputTestState,
  CoreAudioProfiles,
  CoreAudioOutputEdit,
  CoreAudioProfileEdit
} from './coreAudio.ts'
import type {
  CoreStreamsState,
  CoreRadioEdit,
  CorePodcastEdit,
  CoreStreamPageQuery,
  CoreStreamPage,
  CoreRadioStation,
  CorePodcast,
  CorePodcastEpisode,
  CoreStreamPlayback,
  RadioBrowserStation
} from './coreStreams.ts'
import type {
  CoreWorkspaceState,
  CoreWorkspaceEdit,
  CoreWorkspacePageQuery,
  CoreWorkspaceSessionsPage,
  CoreWorkspaceHistoryPage
} from './coreWorkspace.ts'
import type { CoreWorkspaceRestore } from './coreWorkspace.ts'
import type {
  CoreLyricsState,
  CoreLyricsContent,
  CoreLyricsCurrent,
  CoreLyricsMutation
} from './coreLyrics.ts'
import type { OnlineLyricsSearchResult, LyricTrackOverride } from './lyricsManagement.ts'
import type {
  CoreBookmarkMutation,
  CoreBookmarkCurrent,
  CoreBookmarksState,
  CoreBookmarksQuery,
  CoreBookmarksPage
} from './coreBookmarks.ts'
import type {
  CoreImportPreview,
  CoreImportPreviewChoices,
  CoreImportPreviewPage,
  CoreImportPreviewConfigure,
  CoreImportPreviewSave,
  PlaylistReadCredentials
} from './coreImports.ts'
import type { PlayMode, LoudnormStatus } from './audioEngineTypes.ts'
import type { CoreVersionsEdit, CoreVersionsQuery, CoreVersionsPage, CoreVersionsCatalogQuery, CoreVersionsCatalogPage } from './coreVersions.ts'
import type { LibraryMetadata, LibraryQuery, LibraryQueueEdit } from './libraryDatabase.ts'
import type {
  CoreLibraryPage,
  CorePlaybackView,
  CoreQueuePage,
  CoreTrackView
} from './coreViews.ts'
import type {
  CoreMigrationManifest,
  CoreMigrationStatus,
  CoreStateDomain,
  CoreStateRow
} from './coreState.ts'
import { validCorePayload } from './coreRequestValidation.ts'
import type { CoreScanStatus } from './coreScan.ts'
import type { LocalLibraryScanMode } from './localLibraryScan.ts'
import type { InstalledExperience } from './pluginExperience.ts'
import type { PluginNotice } from './pluginNotice.ts'
import type { CoreExperienceDocument } from './corePlugins.ts'
import type { CoreProviderCall } from './corePlugins.ts'
import type {
  TwilightMediaProviderRegistration,
  TwilightPluginDescriptor,
  TwilightPluginIndexEntry,
  TwilightPluginIndexStatus,
  TwilightPluginExtensionContribution
} from './pluginTypes.ts'
import type {
  CoreStatisticsQuery,
  CoreStatisticsPage,
  CoreStatisticsSummary,
  CoreStatisticsClear
} from './coreStatistics.ts'
import type { CoreStatisticsOverview, CoreStatisticsPreviewQuery, CoreStatisticsClearPreview } from './coreStatistics.ts'

import type {
  CoreDownloadCreate,
  CoreDownloadsState,
  CoreDownloadsQuery,
  CoreDownloadsPage
} from './coreDownloads.ts'

import type { CatalogQuery, CatalogPage, CatalogSourceQuery, CatalogSourcePage,
  CatalogDetail, CatalogServiceStatus } from './musicCatalog.ts'
import type { EntityMetadataResolve, EntityMetadataDemand, EntityMetadataDecision, EntityMetadataOverride,
  EntityMetadataJobsQuery, EntityMetadataJob, EntityMetadataLanguage, EntityMetadataDetail, EntityMetadataPolicyView } from './entityMetadata.ts'
import type { MusicIdentityDetail, IdentificationCandidatesQuery, IdentificationCandidate, IdentificationStart,
  IdentificationDecision, IdentificationReview, IdentificationPreview } from './musicIdentification.ts'

export const CORE_PROTOCOL_VERSION = 1
export type CoreEpoch = string
export type CoreServiceKind = 'audio' | 'audio-test' | 'zone-audio' | 'database' | 'scan' | 'analysis' | 'plugin'
export type CorePhase = 'starting' | 'ready' | 'recovering' | 'failed' | 'stopped'
export type CoreClientRole = 'desktop' | 'mini-player' | 'system' | 'remote' | 'plugin'

/** Main assigns identity/permissions; no renderer-supplied identity is trusted. */
export interface CoreClientIdentity {
  id: string
  role: CoreClientRole
  permissions: (
    | 'playback:read'
    | 'playback:write'
    | 'library:read'
    | 'library:write'
    | 'settings:read'
    | 'settings:write'
    | 'migration:write'
    | 'statistics:read'
    | 'statistics:write'
    | 'plugins:read'
    | 'plugins:manage'
    | 'plugins:resources'
    | 'providers:call'
    | 'extensions:execute'
    | 'downloads:read'
    | 'downloads:write'
  )[]
}

export interface CoreQueueReference {
  id: string
  revision: number
  total: number
  index: number
  occurrenceId: string | null
  canUndo?: boolean
  undoLabel?: string | null
}

/** Bounded projection. Library pages, queue pages, lyrics and FFT are separate queries/streams. */
export interface CoreSnapshot {
  libraryRevision: number | null
  catalogRevision?: number | null
  genresRevision?: number | null
  classificationMetadataRevision?: number | null
  ratingsRevision?: number | null
  preferencesRevision?: number | null
  tagsRevision?: number | null
  tagsLinkRevision?: number | null
  focusRevision?: number | null
  focusHistoryRevision?: number | null
  explorationRevision?: number | null
  entityMetadataRevision?: number | null
  /** Identities, candidates and saved metadata; excludes task-only progress. */
  entityMetadataContentRevision?: number | null
  pluginsRevision: number | null
  isStreamBuffering: boolean
  loading: boolean
  presentationRevision: number | null
  abLoop: CoreAbLoopState | null
  mute: { muted: boolean; userVolume: number; lastAudibleVolume: number } | null
  modelPack: CoreModelPackStatus | null
  cloudTransfers: CoreCloudTransferState | null
  inbox: CoreInboxState | null
  libraryLoudness: CoreLoudnessState | null
  loudness: { status: LoudnormStatus } | null
  protocolVersion: typeof CORE_PROTOCOL_VERSION
  epoch: CoreEpoch
  sequence: number
  phase: CorePhase
  playback: CorePlaybackView | null
  track: CoreTrackView | null
  queue: CoreQueueReference | null
  error: string | null
  migrationRequired: boolean
  scan: CoreScanStatus | null
  statisticsRevision: number | null
  playlistsRevision: number | null
  versionsRevision: number | null
  audioRevision: number | null
  settingsRevision: number | null
  personalBackupRecovery?: boolean | null
  sleepTimer: CoreSleepTimerState | null
  bookmarksRevision: number | null
  lyricsRevision: number | null
  lyricsContentRevision: number | null
  workspaceRevision: number | null
  workspaceContentRevision: number | null
  streams: CoreStreamsState | null
  cast: CoreCastState | null
  network: CoreNetworkState | null
  downloads: CoreDownloadsState | null
  personalized: CorePersonalizedState | null
  heart: CoreHeartState | null
}

export interface CoreCommands extends CorePlaylistCommands, CoreRemoteCommands {
  'ratings.set': import('./musicRatings.ts').MusicRatingsSet
  'preferences.set': import('./musicPreferences.ts').MusicPreferencesSet
  'tags.create': import('./musicTags.ts').MusicTagsCreate
  'tags.rename': import('./musicTags.ts').MusicTagsRename
  'tags.delete': import('./musicTags.ts').MusicTagsDelete
  'tags.member.set': import('./musicTags.ts').MusicTagsMemberSet
  'tags.play': import('./musicTags.ts').MusicTagsPlay
  'focus.play': import('./musicFocus.ts').MusicFocusPlay
  'focus.saved.create': import('./musicFocus.ts').MusicFocusCreate
  'focus.saved.rename': import('./musicFocus.ts').MusicFocusRename
  'focus.saved.update': import('./musicFocus.ts').MusicFocusUpdate
  'focus.saved.delete': import('./musicFocus.ts').MusicFocusDelete
  'exploration.performance.save': import('./musicExploration.ts').MusicExplorationPerformanceSave
  'exploration.performance.delete': import('./musicExploration.ts').MusicExplorationPerformanceDelete
  'genres.edit': import('./musicGenres.ts').GenreEdit
  'genres.map': import('./musicGenres.ts').GenreMap
  'genres.override': import('./musicGenres.ts').GenreOverride
  'identification.restore': import('./musicIdentification.ts').IdentificationHistoryReview
  'metadata.entity.requery': import('./entityMetadataTasks.ts').MetadataTaskRequery
  'identification.start': IdentificationStart
  'metadata.entity.resolve': EntityMetadataResolve
  'identification.decide': IdentificationDecision
  'identification.detach': { linkId: string; revision: number }
  'metadata.entity.enrich': EntityMetadataDemand
  'metadata.entity.decide': EntityMetadataDecision
  'metadata.entity.detach': { entityId: string; revision: number }
  'metadata.entity.override': EntityMetadataOverride
  'metadata.entity.sourcePreference': import('./entityMetadata.ts').EntityMetadataSourcePreference
  'metadata.entity.artworkOverride': import('./entityMetadata.ts').EntityMetadataArtworkOverride
  'metadata.entity.cancel': { jobId: string; batchId: string; generation?: number }
  'opra.refresh': Record<string, never>
  'themes.edit': CoreThemeOperations['themes.edit']['input']
  'themes.import': CoreThemeOperations['themes.import']['input']
  'themes.export': CoreThemeOperations['themes.export']['input']
  'themes.importAsset': CoreThemeOperations['themes.importAsset']['input']
  'themes.validateAssets': CoreThemeOperations['themes.validateAssets']['input']
  'themes.copyAssets': CoreThemeOperations['themes.copyAssets']['input']
  'themes.reconcile': Record<string, never>
  'visualization.subscribe': CoreVisualizationSubscribe
  'visualization.unsubscribe': { subscriptionId: string }
  'automix.install.start': { enableAfterInstall: boolean }
  'automix.install.cancel': Record<string, never>
  'settings.restore': CoreSettingsBackupImport
  'ncm.cloud.chooseUploadFiles': Record<string, never>
  'ncm.cloud.upload': { handle: string }
  'ncm.cloud.download': NcmCloudDownloadRequest
  'ncm.cloud.cancel': { id: string }
  'library.inbox.refresh': { duplicatesId?: string }
  'library.inbox.mark': CoreInboxMark
  'library.health.start': Record<string, never>
  'library.health.repair': import('./libraryHealth.ts').LibraryHealthRepair
  'library.loudness.prepare': CoreLoudnessPlanRequest
  'library.loudness.start': { id: string }
  'library.loudness.cancel': { id: string }
  'library.loudness.clear': { id: string }
  'analysis.request': { kind: 'bpm' | 'loudness'; id: string; version: number }
  'analysis.cache.clear': { kind: 'bpm' | 'loudness' }
  'backup.export': import('./personalBackup.ts').PersonalBackupExportOptions
  'backup.preview': Record<string, never>
  'backup.recover': Record<string, never>
  'backup.repreview': CorePersonalRestore
  'backup.chooseFolder': Record<string, never>
  'backup.stage': CorePersonalRestore
  'library.duplicates.start': Record<string, never>
  'library.duplicates.cancel': { id: string }
  'playlists.repair': { id: string; revision: number; folder: string }
  'library.selection.open': LibrarySelectionRequest
  'library.selection.close': { id: string }
  'library.remove': { selectionId: string; mode: 'library' | 'trash' }
  'library.reset': { revision: number }
  'library.exclusions.clear': { revision: number; paths: string[] }
  'library.tags.write': CoreTagWrite
  'library.tags.restore': { selectionId?: string; fromJournal?: boolean }
  'sleep.configure': CoreSleepTimerConfigure
  'sleep.cancel': { revision: number }
  'settings.edit': CoreSettingsEdit
  'cast.discover': Record<string, never>
  'bridge.host': { revision: number; enabled: boolean; sampleRate: number }
  'bridge.connect': { revision: number; peer: BridgePeer }
  'zones.select': { revision: number; outputId: 'local' | 'bridge' }
  'zones.create': { revision: number; name: string }
  'zones.remove': { revision: number; zoneId: string }
  'zones.connect': { revision: number; zoneId: string; peer: BridgePeer }
  'zones.transport': { revision: number; zoneId: string; action: ZoneTransport }
  'zones.queueFromQuery': { revision: number; zoneId: string; query: LibraryQuery; selectedId?: string }
  'zones.dsp.edit': { zoneId: string; revision: number; edit: CoreDspEdit['edit'] }
  'cast.start': CoreCastStart
  'cast.end': { revision: number }
  'audio.outputTest.play': { revision: number; exclusive: boolean }
  'audio.outputTest.stop': Record<string, never>
  'audio.recovery.start': { kind: AudioRecoveryKind }
  'audio.audition.measure': CoreAuditionMeasure
  'audio.audition.select': { revision: number; id: string; side: 'a' | 'b' }
  'audio.audition.end': { revision: number }
  'audio.dsp.edit': CoreDspEdit
  'audio.dsp.import': CoreDspImport
  'audio.dsp.export': { revision: number; name: string }
  'audio.dsp.assetRemove': { revision: number; id: string }
  'audio.vst3.edit': CoreVst3Edit
  'audio.vst3.chooseDirectory': Record<string, never>
  'audio.output.edit': CoreAudioOutputEdit
  'audio.profiles.edit': CoreAudioProfileEdit
  'cache.clear': Record<string, never>
  'downloads.create': CoreDownloadCreate
  'downloads.cancel': { id: string }
  'downloads.retry': { id: string }
  'downloads.result': { id: string; addToLibrary: boolean }
  'downloads.reveal': { id: string }
  'downloads.play': { id: string; play?: boolean }
  'network.profiles.edit': CoreNetworkProfileEdit
  'network.job': CoreNetworkJobCommand
  'network.removeEntry': { revision: number; profileId: string; entryId: string }
  'network.play': CoreNetworkPlayback
  'network.clearCache': Record<string, never>
  'liked.play': CoreLikedPlayback
  'heart.refill': { id: string; revision: number }
  'personalized.start': CorePersonalizedStart
  'personalized.refill': { id: string; revision: number }
  'radio.edit': CoreRadioEdit
  'podcasts.subscribe': { revision: number; feedUrl: string }
  'podcasts.edit': CorePodcastEdit
  'podcasts.refresh': { revision: number; id?: string }
  'podcasts.defaultRate': { revision: number; rate: number }
  'streams.play': CoreStreamPlayback
  'playback.rate': { rate: number }
  'workspace.edit': CoreWorkspaceEdit
  'workspace.restore': CoreWorkspaceRestore
  'lyrics.edit': CoreLyricsMutation
  'lyrics.reload': CoreLyricsCurrent
  'lyrics.importDraft': Record<string, never>
  'lyrics.exportDraft': { contents: string }
  'bookmarks.edit': CoreBookmarkMutation
  'bookmarks.seek': { id: string; revision: number; current: CoreBookmarkCurrent }
  'imports.previewStart': { link: string; credentials?: PlaylistReadCredentials }
  'imports.previewFile': Record<string, never>
  'imports.previewConfigure': CoreImportPreviewConfigure
  'imports.previewBind': { id: string; revision: number; entryId: string; input: CoreQueueTrackInput | null }
  'imports.bind': { id: string; revision: number; entryId: string; input: CoreQueueTrackInput | null }
  'playlists.replaceSource': { revision: number; oldTrackId: string; input: CoreQueueTrackInput }
  'playlists.rematch': { revision: number; input: CoreQueueTrackInput }
  'library.reveal': { id: string; version?: number }
  'imports.previewSave': CoreImportPreviewSave
  'imports.previewDiscard': { id: string; revision: number }
  'imports.retry': { id: string; force?: boolean; entries?: string[] }
  'imports.cancel': { id: string }
  'versions.edit': CoreVersionsEdit
  'catalog.refresh': Record<string, never>
  'catalog.cancel': Record<string, never>
  'catalog.play': { sourceId: string; revision: number }
  'catalog.playUnified': import('./musicUnifiedPlayback.ts').UnifiedPlaybackRequest
  'playlists.edit': CorePlaylistMutation
  'providers.call': CoreProviderCall
  'plugins.enable': { id: string }
  'plugins.disable': { id: string }
  'plugins.uninstall': { id: string; removeData?: boolean }
  'plugins.install': { kind: 'package' | 'directory' }
  'plugins.index.refresh': Record<string, never>
  'plugins.index.install': { id: string }
  'plugins.dspParameters': { id: string; parameters: Record<string, number> }
  'plugins.showLog': { id: string }
  'plugins.installSource': { path: string }
  'extensions.preferences.edit': { id: string; value: Record<string, unknown> }
  'extensions.document.edit': { id: string; update: CoreExperienceDocument }
  'extensions.music': { id: string; operation: import('./pluginExperience.ts').ExperienceMusicOperation; args: Record<string, unknown> }
  'extensions.export': { id: string; name: string; content: string }
  'extensions.pluginRequest': { id: string; request: unknown }
  'extensions.execute': { command: string; args: unknown[] }
  'statistics.clear': CoreStatisticsClear
  'scan.start': { mode: LocalLibraryScanMode; roots?: string[]; restoreExcluded?: boolean }
  'metadata.start': Record<string, never>
  'metadata.cancel': Record<string, never>
  'metadata.apply': { token: string; index: number }
  'metadata.clear': { id: string; version: number }
  'scan.pause': { jobId: string }
  'scan.resume': { jobId: string }
  'scan.cancel': { jobId: string }
  'playback.play': { position?: number }
  'playback.pause': Record<string, never>
  'playback.stop': Record<string, never>
  'playback.seek': { position: number }
  'playback.next': Record<string, never>
  'playback.previous': Record<string, never>
  'playback.volume': { volume: number }
  'playback.mute': { muted?: boolean }
  'playback.control': CoreSystemPlaybackAction
  'playback.favorite': CoreLyricsCurrent
  'playback.abLoop': CoreAbLoopCommand
  'playback.mode': { mode: PlayMode }
  'queue.select': { id: string; revision: number; index: number; occurrenceId: string }
  'queue.fromQuery': {
    query: LibraryQuery
    selectedId?: string
    play?: boolean
    position?: number
    randomStart?: boolean
    playMode?: Exclude<PlayMode, 'heart'>
  }
  'queue.submit': CoreQueueSubmitCommand
  'queue.insert': CoreQueueInsert
  'playlists.saveQueue': { name: string; revision: number; queue: { id: string; revision: number } }
  'playlists.addQueueEntries': {
    id: string
    revision: number
    queue: { id: string; revision: number }
    occurrenceIds: string[]
  }
  'queue.edit': {
    id: string
    revision: number
    edit: Exclude<LibraryQueueEdit, { kind: 'select' | 'step' | 'mode' | 'undo' }>
  }
  'queue.undo': { id: string; revision: number }
  'queue.refresh': Record<string, never>
  'migration.begin': { id: string; manifest: CoreMigrationManifest }
  'migration.stage': { id: string; batch: number; domain: CoreStateDomain; rows: CoreStateRow[] }
  'migration.commit': { id: string }
  'migration.abort': { id: string }
  'lifecycle.flush': Record<string, never>
}

export interface CoreQueries
  extends
    CoreLibraryQueries,
    CorePlaylistQueries,
    CoreRemoteQueries,
    Pick<CoreThemeOperations, 'themes.list' | 'themes.bootstrap'> {
  'ratings.detail': { input: { entityId: string }; output: import('./musicRatings.ts').MusicRatingsDetail }
  'ratings.targets': { input: import('./musicRatings.ts').MusicRatingsTargetsQuery; output: import('./musicRatings.ts').MusicRatingsTargetsPage }
  'ratings.history': { input: import('./musicRatings.ts').MusicRatingsHistoryQuery; output: import('./musicRatings.ts').MusicRatingsHistoryPage }
  'preferences.detail': { input: { entityId: string }; output: import('./musicPreferences.ts').MusicPreferencesDetail }
  'preferences.targets': { input: import('./musicPreferences.ts').MusicPreferencesTargetsQuery; output: import('./musicPreferences.ts').MusicPreferencesTargetsPage }
  'preferences.history': { input: import('./musicPreferences.ts').MusicPreferencesHistoryQuery; output: import('./musicPreferences.ts').MusicPreferencesHistoryPage }
  'focus.query': { input: import('./musicFocus.ts').MusicFocusPageQuery; output: import('./musicFocus.ts').MusicFocusPage }
  'exploration.query': { input: import('./musicExploration.ts').MusicExplorationQuery; output: import('./musicExploration.ts').MusicExplorationPage }
  'exploration.lookup': { input: import('./musicExploration.ts').MusicExplorationLookupQuery; output: import('./musicExploration.ts').MusicExplorationDetail }
  'exploration.detail': { input: import('./musicExploration.ts').MusicExplorationDetailQuery; output: import('./musicExploration.ts').MusicExplorationDetail }
  'exploration.relations': { input: import('./musicExploration.ts').MusicExplorationRelationsQuery; output: import('./musicExploration.ts').MusicExplorationRelationsPage }
  'exploration.participation': { input: import('./musicExploration.ts').MusicExplorationParticipationQuery; output: import('./musicExploration.ts').MusicExplorationRelationsPage }
  'focus.play.status': { input: import('./musicFocus.ts').MusicFocusPlayStatusQuery; output: import('./musicFocus.ts').MusicFocusPlayStatus }
  'focus.facets': { input: import('./musicFocus.ts').MusicFocusFacetsQuery; output: import('./musicFocus.ts').MusicFocusFacetsPage }
  'focus.saved.list': { input: import('./musicFocus.ts').MusicFocusSavedListQuery; output: import('./musicFocus.ts').MusicFocusSavedPage }
  'tags.list': { input: import('./musicTags.ts').MusicTagsListQuery; output: import('./musicTags.ts').MusicTagsListPage }
  'tags.entity': { input: import('./musicTags.ts').MusicTagsEntityQuery; output: import('./musicTags.ts').MusicTagsEntityPage }
  'tags.members': { input: import('./musicTags.ts').MusicTagsMembersQuery; output: import('./musicTags.ts').MusicTagsMembersPage }
  'tags.recordings': { input: import('./musicTags.ts').MusicTagsMembersQuery; output: import('./musicTags.ts').MusicTagsRecordingsPage }
  'genres.tree': { input: import('./musicGenres.ts').GenreQuery; output: import('./musicGenres.ts').GenrePage }
  'genres.browse': { input: import('./musicGenreBrowse.ts').GenreBrowseQuery; output: import('./musicGenreBrowse.ts').GenreBrowsePage }
  'genres.members': { input: import('./musicGenreBrowse.ts').GenreMembersQuery; output: import('./musicGenreBrowse.ts').GenreMembersPage }
  'genres.facets': { input: import('./musicGenreBrowse.ts').GenreFacetsQuery; output: import('./musicGenreBrowse.ts').GenreFacetsPage }
  'genres.unmapped': { input: import('./musicGenres.ts').GenreUnmappedQuery; output: import('./musicGenres.ts').GenreUnmappedPage }
  'genres.evidence': { input: import('./musicGenres.ts').GenreEvidenceQuery; output: import('./musicGenres.ts').GenreEvidencePage }
  'opra.search': { input: { query: string }; output: OpraProfile[] }
  'opra.profile': { input: { id: string }; output: OpraProfile | null }
  'opra.status': { input: Record<string, never>; output: OpraCatalogStatus }
  'player.presentation': { input: Record<string, never>; output: CorePlayerPresentation }
  'player.lyrics': { input: Record<string, never>; output: CoreSystemLyrics }
  'playback.diagnostics': { input: Record<string, never>; output: Omit<OutputInfo, 'nativeDsp'> }
  'audio.diagnostics': { input: CoreAudioDiagnosticsQuery; output: AudioDiagnosticReport }
  'queue.locate': {
    input: { id: string; revision: number; occurrenceId: string }
    output: { position: number | null }
  }
  'automix.install.status': { input: Record<string, never>; output: CoreModelPackStatus }
  'settings.backup': { input: Record<string, never>; output: string }
  'ncm.cloud.state': { input: Record<string, never>; output: CoreCloudTransferState }
  'ncm.cloud.page': { input: CoreCloudTransferQuery; output: CoreCloudTransferPage }
  'library.inbox.page': { input: CoreInboxQuery; output: CoreInboxPage }
  'library.health.status': { input: Record<string, never>; output: import('./libraryHealth.ts').LibraryHealthState }
  'library.health.page': { input: import('./libraryHealth.ts').LibraryHealthPageQuery; output: import('./libraryHealth.ts').LibraryHealthPage }
  'library.loudness.state': { input: Record<string, never>; output: CoreLoudnessState | null }
  'library.loudness.page': {
    input: { id: string; offset?: number; limit?: number }
    output: CoreLoudnessPage
  }
  'library.loudness.result': { input: { id: string; index: number }; output: CoreLoudnessResult }
  'analysis.cache.size': { input: { kind: 'bpm' | 'loudness' }; output: number }
  'analysis.loudness.status': { input: Record<string, never>; output: { status: LoudnormStatus } }
  'library.duplicates.status': { input: Record<string, never>; output: CoreDuplicatesStatus | null }
  'library.duplicates.groups': {
    input: CoreDuplicatePageQuery
    output: CoreDuplicatePage<CoreDuplicateGroup>
  }
  'library.duplicates.items': {
    input: CoreDuplicatePageQuery & { group: number }
    output: CoreDuplicatePage<CoreDuplicateItem>
  }
  'library.duplicates.unavailable': {
    input: CoreDuplicatePageQuery
    output: CoreDuplicatePage<string>
  }
  'playlists.repair.status': {
    input: Record<string, never>
    output: CorePlaylistRepairStatus | null
  }
  'library.selection.page': {
    input: { id: string; cursor?: number; projection?: 'tracks' | 'files' }
    output: CoreLibrarySelectionPage
  }
  'automix.capabilities': { input: { refresh?: boolean }; output: CoreAutoMixCapabilities }
  'sleep.state': { input: Record<string, never>; output: CoreSleepTimerState }
  'settings.state': { input: Record<string, never>; output: CoreSettingsState }
  'cast.state': { input: Record<string, never>; output: CoreCastState }
  'zones.state': { input: Record<string, never>; output: CoreZoneState }
  'zones.list': { input: Record<string, never>; output: ZonesView }
  'zones.dsp': { input: { zoneId: string }; output: CoreDspState }
  'zones.signalPath': { input: { zoneId: string }; output: CoreSignalPath }
  'audio.signalPath': { input: Record<string, never>; output: CoreSignalPath }
  'bridge.invitation': { input: Record<string, never>; output: { invitation: string | null } }
  'cast.devices': {
    input: { offset: number; limit: number }
    output: { offset: number; total: number; items: CoreCastDevice[] }
  }
  'audio.outputTest': { input: Record<string, never>; output: CoreOutputTestState }
  'audio.recovery': { input: Record<string, never>; output: AudioRecoveryState }
  'audio.audition': { input: Record<string, never>; output: CoreAuditionState }
  'audio.dsp': { input: Record<string, never>; output: CoreDspState }
  'audio.dsp.status': { input: Record<string, never>; output: DspGraphStatus }
  'audio.dsp.assets': {
    input: { offset?: number; limit?: number }
    output: { revision: number; total: number; items: DspAsset[] }
  }
  'audio.dsp.correction': { input: { id: string }; output: DspCorrectionProfile }
  'audio.vst3': { input: { offset?: number; limit?: number }; output: CoreVst3Page }
  'audio.vst3.parameters': {
    input: { id: string; revision: number; offset?: number; limit?: number }
    output: CoreVst3Parameters
  }
  'audio.output': { input: Record<string, never>; output: CoreAudioOutput }
  'audio.profiles': { input: Record<string, never>; output: CoreAudioProfiles }
  'cache.info': { input: Record<string, never>; output: { sizeBytes: number } }
  'search.songs': { input: CoreMusicSearchQuery; output: CoreMusicSearchPage }
  'search.collections': { input: CoreCollectionSearchQuery; output: CoreCollectionSearchPage }
  'downloads.state': { input: Record<string, never>; output: CoreDownloadsState }
  'downloads.page': { input: CoreDownloadsQuery; output: CoreDownloadsPage }
  'downloads.indexed': { input: { id: string }; output: { indexed: boolean } }
  'network.state': { input: Record<string, never>; output: CoreNetworkState }
  'network.profiles': { input: CoreNetworkPageQuery; output: CoreNetworkPage<CoreNetworkProfile> }
  'network.directory': {
    input: CoreNetworkPageQuery & { profileId: string; path: string; token?: string }
    output: CoreNetworkPage<CoreNetworkEntry> & { token: string }
  }
  'network.library': {
    input: CoreNetworkPageQuery & { profileId?: string; query?: string }
    output: CoreNetworkPage<CoreNetworkEntry & { profileName: string }>
  }
  'network.test': { input: { profileId: string }; output: CoreNetworkTestResult }
  'network.cover': { input: { profileId: string; entryId: string }; output: string | null }
  'network.cacheInfo': { input: Record<string, never>; output: { sizeBytes: number } }
  'streams.state': { input: Record<string, never>; output: CoreStreamsState }
  'radio.stations': { input: CoreStreamPageQuery; output: CoreStreamPage<CoreRadioStation> }
  'radio.directory': {
    input: { query: string; offset?: number; limit?: number }
    output: RadioBrowserStation[]
  }
  'podcasts.subscriptions': { input: CoreStreamPageQuery; output: CoreStreamPage<CorePodcast> }
  'podcasts.episodes': {
    input: CoreStreamPageQuery & { id: string }
    output: CoreStreamPage<CorePodcastEpisode>
  }
  'workspace.state': { input: Record<string, never>; output: CoreWorkspaceState }
  'workspace.sessions': { input: CoreWorkspacePageQuery; output: CoreWorkspaceSessionsPage }
  'workspace.history': { input: CoreWorkspacePageQuery; output: CoreWorkspaceHistoryPage }
  'lyrics.state': { input: Record<string, never>; output: CoreLyricsState }
  'lyrics.current': { input: Record<string, never>; output: CoreLyricsContent }
  'lyrics.entry': {
    input: { trackId: string }
    output: { revision: number; override: LyricTrackOverride | null }
  }
  'lyrics.search': { input: CoreLyricsCurrent; output: OnlineLyricsSearchResult }
  'bookmarks.state': { input: Record<string, never>; output: CoreBookmarksState }
  'bookmarks.page': { input: CoreBookmarksQuery; output: CoreBookmarksPage }
  'imports.previewChoices': {
    input: {
      id: string
      revision: number
      kind: 'columns' | 'playlists'
      offset?: number
      limit?: number
    }
    output: CoreImportPreviewChoices
  }
  'imports.previews': {
    input: { offset?: number; limit?: number }
    output: { total: number; items: CoreImportPreview[] }
  }
  'imports.preview': { input: { id: string }; output: CoreImportPreview }
  'imports.previewPage': {
    input: { id: string; revision: number; offset?: number; limit?: number }
    output: CoreImportPreviewPage
  }
  'imports.status': { input: { id: string }; output: CoreImportProgress | null }
  'playlists.view': { input: CorePlaylistViewQuery; output: CorePlaylistViewPage }
  'versions.page': { input: CoreVersionsQuery; output: CoreVersionsPage }
  'identification.history': { input: import('./musicIdentification.ts').IdentificationHistoryQuery; output: import('./musicIdentification.ts').IdentificationHistoryPage }
  'identification.restorePreview': { input: import('./musicIdentification.ts').IdentificationHistoryReview; output: import('./musicIdentification.ts').IdentificationRestorePreview }
  'metadata.entity.sources': { input: import('./entityMetadataTasks.ts').MetadataTaskSourcesQuery; output: import('./entityMetadataTasks.ts').MetadataTaskSourcesPage }
  'metadata.entity.policy': { input: Record<string, never>; output: EntityMetadataPolicyView }
  'identification.status': { input: Record<string, never>; output: import('./musicIdentificationSchedule.ts').IdentificationScheduleStatus }
  'identification.detail': { input: { entityId: string }; output: MusicIdentityDetail }
  'identification.candidates': { input: IdentificationCandidatesQuery; output: { total: number; items: IdentificationCandidate[] } }
  'identification.inbox': { input: import('./musicIdentification.ts').IdentificationInboxQuery; output: import('./musicIdentification.ts').IdentificationInboxPage }
  'identification.preview': { input: IdentificationReview; output: IdentificationPreview }
  'metadata.entity.detail': { input: { entityId: string; language: EntityMetadataLanguage; sourceProvider?: string; includeAutomaticArtwork?: boolean }; output: EntityMetadataDetail }
  'metadata.entity.jobs': { input: EntityMetadataJobsQuery; output: { total: number; items: EntityMetadataJob[] } }
  'metadata.entity.tasks': { input: import('./entityMetadataTasks.ts').MetadataTasksQuery; output: import('./entityMetadataTasks.ts').MetadataTasksPage }
  'metadata.entity.demands': { input: import('./entityMetadataTasks.ts').MetadataTaskDemandsQuery; output: import('./entityMetadataTasks.ts').MetadataTaskDemandsPage }
  'metadata.entity.credits': { input: import('./musicCredits.ts').MusicCreditsQuery; output: import('./musicCredits.ts').MusicCreditsPage }
  'catalog.query': { input: CatalogQuery; output: CatalogPage }
  'albums.browse': { input: import('./musicAlbumBrowse.ts').AlbumBrowseQuery; output: import('./musicAlbumBrowse.ts').AlbumBrowsePage }
  'albums.sources': { input: import('./musicAlbumBrowse.ts').AlbumSourcesQuery; output: import('./musicAlbumBrowse.ts').AlbumSourcesPage }
  'catalog.detail': { input: { id: string; revision?: number }; output: CatalogDetail }
  'catalog.sources': { input: CatalogSourceQuery; output: CatalogSourcePage }
  'catalog.status': { input: Record<string, never>; output: CatalogServiceStatus }
  'versions.catalog': { input: CoreVersionsCatalogQuery; output: CoreVersionsCatalogPage }
  'playlists.list': {
    input: { offset?: number; limit?: number; revision?: number }
    output: CorePlaylistPage
  }
  'playlists.entries': {
    input: { id: string; revision: number; offset?: number; limit?: number }
    output: CorePlaylistEntries
  }
  'plugins.list': { input: Record<string, never>; output: TwilightPluginDescriptor[] }
  'plugins.index.list': { input: Record<string, never>; output: TwilightPluginIndexEntry[] }
  'plugins.index.status': { input: Record<string, never>; output: TwilightPluginIndexStatus }
  'plugins.log': { input: { id: string }; output: string }
  'providers.list': { input: Record<string, never>; output: TwilightMediaProviderRegistration[] }
  'extensions.list': { input: Record<string, never>; output: TwilightPluginExtensionContribution[] }
  'extensions.experiences': { input: Record<string, never>; output: InstalledExperience[] }
  'extensions.resource': { input: { url: string }; output: { path: string } | null }
  'extensions.stylesheet': { input: { pluginId: string; themeId: string }; output: string }
  'extensions.preferences': { input: { id: string }; output: unknown }
  'extensions.document': { input: { id: string }; output: CoreExperienceDocument }
  'statistics.summary': { input: Record<string, never>; output: CoreStatisticsSummary }
  'statistics.overview': { input: Record<string, never>; output: CoreStatisticsOverview }
  'statistics.previewClear': { input: CoreStatisticsPreviewQuery; output: CoreStatisticsClearPreview }
  'statistics.tracks': { input: CoreStatisticsQuery; output: CoreStatisticsPage }
  'scan.status': { input: Record<string, never>; output: CoreScanStatus | null }
  'scan.watchers': {
    input: Record<string, never>
    output: { enabled: boolean; folders: LibraryWatcherFolderStatus[] }
  }
  'metadata.status': {
    input: Record<string, never>
    output: LibraryMetadataEnrichmentStatus | null
  }
  'metadata.candidates': { input: { id: string; version: number }; output: CoreMetadataCandidates }
  'state.snapshot': { input: Record<string, never>; output: CoreSnapshot }
  'library.metadata': { input: Record<string, never>; output: LibraryMetadata }
  'library.recent.resolve': CoreLibraryQueries['library.recent.resolve']
  'library.tracks': { input: LibraryQuery; output: CoreLibraryPage }
  'queue.page': {
    input: { id: string; revision: number; offset: number; limit?: number; search?: string }
    output: CoreQueuePage
  }
  'migration.status': { input: Record<string, never>; output: CoreMigrationStatus }
}

export type CoreCommandName = keyof CoreCommands
export type CoreQueryName = keyof CoreQueries
export type CoreOperation = CoreCommandName | CoreQueryName
export type CoreRequest =
  | {
      [K in CoreCommandName]: { kind: 'command'; name: K; payload: CoreCommands[K] }
    }[CoreCommandName]
  | {
      [K in CoreQueryName]: { kind: 'query'; name: K; payload: CoreQueries[K]['input'] }
    }[CoreQueryName]
export type CoreRequestEnvelope = CoreRequest & { requestId: string; epoch: CoreEpoch }

export type CoreErrorCode =
  | 'NOT_READY'
  | 'STALE_EPOCH'
  | 'STALE_REVISION'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'BUSY'
  | 'CANCELLED'
  | 'OUTCOME_UNKNOWN'
  | 'FAILED'
export interface CoreFailure {
  code: CoreErrorCode
  message: string
}
export type CoreResponse = { kind: 'response'; requestId: string; epoch: string } & (
  | { ok: true; value: unknown }
  | { ok: false; error: CoreFailure }
)
export interface CoreStateEvent {
  kind: 'state'
  epoch: CoreEpoch
  sequence: number
  snapshot: CoreSnapshot
}
export type CoreClientMessage = CoreResponse | CoreStateEvent | CoreVisualizationEvent | {
  kind: 'plugin-notice'; epoch: string; notice: PluginNotice
} | {
  /** Live event pushed by a plugin's background code to its mounted experience iframe. */
  kind: 'plugin-experience'; epoch: string; pluginId: string; event: string; value: unknown
}

const OPERATIONS: Record<
  CoreOperation,
  { kind: CoreRequest['kind']; permission: CoreClientIdentity['permissions'][number] }
> = {
  'opra.search': { kind: 'query', permission: 'settings:read' },
  'opra.profile': { kind: 'query', permission: 'settings:read' },
  'opra.status': { kind: 'query', permission: 'settings:read' },
  'opra.refresh': { kind: 'command', permission: 'settings:write' },
  'player.presentation': { kind: 'query', permission: 'playback:read' },
  'player.lyrics': { kind: 'query', permission: 'playback:read' },
  'playback.diagnostics': { kind: 'query', permission: 'settings:read' },
  'audio.diagnostics': { kind: 'query', permission: 'settings:read' },
  'playlists.submit': { kind: 'command', permission: 'library:write' },
  'playback.control': { kind: 'command', permission: 'playback:write' },
  'playback.favorite': { kind: 'command', permission: 'playback:write' },
  'queue.locate': { kind: 'query', permission: 'playback:read' },
  'queue.insert': { kind: 'command', permission: 'playback:write' },
  'playlists.saveQueue': { kind: 'command', permission: 'library:write' },
  'playlists.addQueueEntries': { kind: 'command', permission: 'library:write' },
  'themes.list': { kind: 'query', permission: 'settings:read' },
  'themes.bootstrap': { kind: 'query', permission: 'settings:read' },
  'themes.edit': { kind: 'command', permission: 'settings:write' },
  'themes.import': { kind: 'command', permission: 'settings:write' },
  'themes.export': { kind: 'command', permission: 'settings:read' },
  'themes.importAsset': { kind: 'command', permission: 'settings:write' },
  'themes.validateAssets': { kind: 'command', permission: 'settings:read' },
  'themes.copyAssets': { kind: 'command', permission: 'settings:write' },
  'themes.reconcile': { kind: 'command', permission: 'settings:write' },
  'visualization.subscribe': { kind: 'command', permission: 'playback:read' },
  'visualization.unsubscribe': { kind: 'command', permission: 'playback:read' },
  'automix.install.start': { kind: 'command', permission: 'settings:write' },
  'automix.install.cancel': { kind: 'command', permission: 'settings:write' },
  'automix.install.status': { kind: 'query', permission: 'settings:read' },
  'settings.restore': { kind: 'command', permission: 'settings:write' },
  'settings.backup': { kind: 'query', permission: 'settings:read' },
  'ncm.cloud.chooseUploadFiles': { kind: 'command', permission: 'providers:call' },
  'ncm.cloud.upload': { kind: 'command', permission: 'providers:call' },
  'ncm.cloud.download': { kind: 'command', permission: 'downloads:write' },
  'ncm.cloud.cancel': { kind: 'command', permission: 'downloads:write' },
  'ncm.cloud.state': { kind: 'query', permission: 'downloads:read' },
  'ncm.cloud.page': { kind: 'query', permission: 'downloads:read' },
  'backup.export': { kind: 'command', permission: 'settings:read' },
  'library.inbox.refresh': { kind: 'command', permission: 'library:read' },
  'library.inbox.mark': { kind: 'command', permission: 'library:write' },
  'library.inbox.page': { kind: 'query', permission: 'library:read' },
  'library.health.start': { kind: 'command', permission: 'library:read' },
  'library.health.repair': { kind: 'command', permission: 'library:write' },
  'library.health.status': { kind: 'query', permission: 'library:read' },
  'library.health.page': { kind: 'query', permission: 'library:read' },
  'library.loudness.prepare': { kind: 'command', permission: 'library:read' },
  'library.loudness.start': { kind: 'command', permission: 'library:read' },
  'library.loudness.cancel': { kind: 'command', permission: 'library:read' },
  'library.loudness.clear': { kind: 'command', permission: 'settings:write' },
  'library.loudness.state': { kind: 'query', permission: 'library:read' },
  'library.loudness.page': { kind: 'query', permission: 'library:read' },
  'library.loudness.result': { kind: 'query', permission: 'library:read' },
  'analysis.request': { kind: 'command', permission: 'library:write' },
  'analysis.cache.clear': { kind: 'command', permission: 'settings:write' },
  'analysis.cache.size': { kind: 'query', permission: 'settings:read' },
  'analysis.loudness.status': { kind: 'query', permission: 'settings:read' },
  'backup.preview': { kind: 'command', permission: 'settings:write' },
  'backup.recover': { kind: 'command', permission: 'settings:write' },
  'backup.repreview': { kind: 'command', permission: 'settings:write' },
  'backup.chooseFolder': { kind: 'command', permission: 'settings:write' },
  'backup.stage': { kind: 'command', permission: 'settings:write' },
  'library.duplicates.start': { kind: 'command', permission: 'library:read' },
  'library.duplicates.cancel': { kind: 'command', permission: 'library:read' },
  'library.duplicates.status': { kind: 'query', permission: 'library:read' },
  'library.duplicates.groups': { kind: 'query', permission: 'library:read' },
  'library.duplicates.items': { kind: 'query', permission: 'library:read' },
  'library.duplicates.unavailable': { kind: 'query', permission: 'library:read' },
  'playlists.repair': { kind: 'command', permission: 'library:write' },
  'playlists.repair.status': { kind: 'query', permission: 'library:read' },
  'library.selection.open': { kind: 'command', permission: 'library:read' },
  'library.selection.close': { kind: 'command', permission: 'library:read' },
  'library.selection.page': { kind: 'query', permission: 'library:read' },
  'library.remove': { kind: 'command', permission: 'library:write' },
  'library.reset': { kind: 'command', permission: 'library:write' },
  'library.exclusions.clear': { kind: 'command', permission: 'library:write' },
  'library.tags.write': { kind: 'command', permission: 'library:write' },
  'library.tags.restore': { kind: 'command', permission: 'library:write' },
  'settings.state': { kind: 'query', permission: 'settings:read' },
  'sleep.state': { kind: 'query', permission: 'playback:read' },
  'automix.capabilities': { kind: 'query', permission: 'settings:read' },
  'sleep.configure': { kind: 'command', permission: 'playback:write' },
  'sleep.cancel': { kind: 'command', permission: 'playback:write' },
  'settings.edit': { kind: 'command', permission: 'settings:write' },
  'cast.state': { kind: 'query', permission: 'playback:read' },
  'zones.state': { kind: 'query', permission: 'playback:read' },
  'zones.list': { kind: 'query', permission: 'playback:read' },
  'zones.dsp': { kind: 'query', permission: 'settings:read' },
  'zones.signalPath': { kind: 'query', permission: 'playback:read' },
  'zones.create': { kind: 'command', permission: 'settings:write' },
  'zones.remove': { kind: 'command', permission: 'settings:write' },
  'zones.connect': { kind: 'command', permission: 'settings:write' },
  'zones.transport': { kind: 'command', permission: 'playback:write' },
  'zones.queueFromQuery': { kind: 'command', permission: 'playback:write' },
  'zones.dsp.edit': { kind: 'command', permission: 'settings:write' },
  'audio.signalPath': { kind: 'query', permission: 'playback:read' },
  'bridge.invitation': { kind: 'query', permission: 'settings:read' },
  'bridge.host': { kind: 'command', permission: 'settings:write' },
  'bridge.connect': { kind: 'command', permission: 'settings:write' },
  'zones.select': { kind: 'command', permission: 'playback:write' },
  'remote.status': { kind: 'query', permission: 'settings:read' },
  'remote.setEnabled': { kind: 'command', permission: 'settings:write' },
  'remote.rotatePin': { kind: 'command', permission: 'settings:write' },
  'remote.decidePairing': { kind: 'command', permission: 'settings:write' },
  'remote.revokeDevice': { kind: 'command', permission: 'settings:write' },
  'cast.devices': { kind: 'query', permission: 'playback:read' },
  'cast.discover': { kind: 'command', permission: 'playback:write' },
  'cast.start': { kind: 'command', permission: 'playback:write' },
  'cast.end': { kind: 'command', permission: 'playback:write' },
  'audio.outputTest': { kind: 'query', permission: 'settings:read' },
  'audio.outputTest.play': { kind: 'command', permission: 'settings:write' },
  'audio.outputTest.stop': { kind: 'command', permission: 'settings:write' },
  'audio.recovery': { kind: 'query', permission: 'settings:read' },
  'audio.recovery.start': { kind: 'command', permission: 'settings:write' },
  'audio.audition': { kind: 'query', permission: 'settings:read' },
  'audio.audition.measure': { kind: 'command', permission: 'settings:write' },
  'audio.audition.select': { kind: 'command', permission: 'settings:write' },
  'audio.audition.end': { kind: 'command', permission: 'settings:write' },
  'audio.dsp': { kind: 'query', permission: 'settings:read' },
  'audio.dsp.status': { kind: 'query', permission: 'settings:read' },
  'audio.dsp.assets': { kind: 'query', permission: 'settings:read' },
  'audio.dsp.correction': { kind: 'query', permission: 'settings:read' },
  'audio.vst3': { kind: 'query', permission: 'settings:read' },
  'audio.vst3.parameters': { kind: 'query', permission: 'settings:read' },
  'audio.dsp.edit': { kind: 'command', permission: 'settings:write' },
  'audio.dsp.import': { kind: 'command', permission: 'settings:write' },
  'audio.dsp.export': { kind: 'command', permission: 'settings:write' },
  'audio.dsp.assetRemove': { kind: 'command', permission: 'settings:write' },
  'audio.vst3.edit': { kind: 'command', permission: 'settings:write' },
  'audio.vst3.chooseDirectory': { kind: 'command', permission: 'settings:write' },
  'audio.output': { kind: 'query', permission: 'settings:read' },
  'audio.profiles': { kind: 'query', permission: 'settings:read' },
  'audio.output.edit': { kind: 'command', permission: 'settings:write' },
  'audio.profiles.edit': { kind: 'command', permission: 'settings:write' },
  'cache.info': { kind: 'query', permission: 'settings:read' },
  'cache.clear': { kind: 'command', permission: 'settings:write' },
  'search.songs': { kind: 'query', permission: 'library:read' },
  'search.collections': { kind: 'query', permission: 'library:read' },
  'downloads.state': { kind: 'query', permission: 'downloads:read' },
  'downloads.page': { kind: 'query', permission: 'downloads:read' },
  'downloads.create': { kind: 'command', permission: 'downloads:write' },
  'downloads.cancel': { kind: 'command', permission: 'downloads:write' },
  'downloads.retry': { kind: 'command', permission: 'downloads:write' },
  'downloads.result': { kind: 'command', permission: 'downloads:write' },
  'downloads.reveal': { kind: 'command', permission: 'downloads:read' },
  'downloads.indexed': { kind: 'query', permission: 'downloads:read' },
  'downloads.play': { kind: 'command', permission: 'playback:write' },
  'network.state': { kind: 'query', permission: 'library:read' },
  'network.profiles': { kind: 'query', permission: 'library:write' },
  'network.directory': { kind: 'query', permission: 'library:read' },
  'network.library': { kind: 'query', permission: 'library:read' },
  'network.test': { kind: 'query', permission: 'library:write' },
  'network.cover': { kind: 'query', permission: 'library:read' },
  'network.cacheInfo': { kind: 'query', permission: 'library:read' },
  'network.clearCache': { kind: 'command', permission: 'library:write' },
  'liked.play': { kind: 'command', permission: 'playback:write' },
  'heart.refill': { kind: 'command', permission: 'playback:write' },
  'personalized.start': { kind: 'command', permission: 'playback:write' },
  'personalized.refill': { kind: 'command', permission: 'playback:write' },
  'network.profiles.edit': { kind: 'command', permission: 'library:write' },
  'network.job': { kind: 'command', permission: 'library:write' },
  'network.removeEntry': { kind: 'command', permission: 'library:write' },
  'network.play': { kind: 'command', permission: 'playback:write' },
  'streams.state': { kind: 'query', permission: 'library:read' },
  'radio.stations': { kind: 'query', permission: 'library:read' },
  'radio.directory': { kind: 'query', permission: 'library:read' },
  'radio.edit': { kind: 'command', permission: 'library:write' },
  'podcasts.subscriptions': { kind: 'query', permission: 'library:read' },
  'podcasts.episodes': { kind: 'query', permission: 'library:read' },
  'podcasts.subscribe': { kind: 'command', permission: 'library:write' },
  'podcasts.edit': { kind: 'command', permission: 'library:write' },
  'podcasts.refresh': { kind: 'command', permission: 'library:write' },
  'podcasts.defaultRate': { kind: 'command', permission: 'library:write' },
  'streams.play': { kind: 'command', permission: 'playback:write' },
  'playback.rate': { kind: 'command', permission: 'playback:write' },
  'workspace.edit': { kind: 'command', permission: 'library:write' },
  'workspace.restore': { kind: 'command', permission: 'playback:write' },
  'workspace.state': { kind: 'query', permission: 'library:read' },
  'workspace.sessions': { kind: 'query', permission: 'library:read' },
  'workspace.history': { kind: 'query', permission: 'library:read' },
  'lyrics.edit': { kind: 'command', permission: 'library:write' },
  'lyrics.reload': { kind: 'command', permission: 'library:write' },
  'lyrics.importDraft': { kind: 'command', permission: 'library:write' },
  'lyrics.exportDraft': { kind: 'command', permission: 'library:write' },
  'lyrics.state': { kind: 'query', permission: 'library:read' },
  'lyrics.current': { kind: 'query', permission: 'library:read' },
  'lyrics.entry': { kind: 'query', permission: 'library:read' },
  'lyrics.search': { kind: 'query', permission: 'library:read' },
  'bookmarks.edit': { kind: 'command', permission: 'library:write' },
  'bookmarks.seek': { kind: 'command', permission: 'playback:write' },
  'bookmarks.state': { kind: 'query', permission: 'library:read' },
  'bookmarks.page': { kind: 'query', permission: 'library:read' },
  'imports.previewStart': { kind: 'command', permission: 'library:write' },
  'imports.previewFile': { kind: 'command', permission: 'library:write' },
  'imports.previewConfigure': { kind: 'command', permission: 'library:write' },
  'imports.previewBind': { kind: 'command', permission: 'library:write' },
  'imports.bind': { kind: 'command', permission: 'library:write' },
  'playlists.replaceSource': { kind: 'command', permission: 'library:write' },
  'playlists.rematch': { kind: 'command', permission: 'library:write' },
  'library.reveal': { kind: 'command', permission: 'library:read' },
  'imports.previewSave': { kind: 'command', permission: 'library:write' },
  'imports.previewDiscard': { kind: 'command', permission: 'library:write' },
  'imports.previews': { kind: 'query', permission: 'library:read' },
  'imports.preview': { kind: 'query', permission: 'library:read' },
  'imports.previewPage': { kind: 'query', permission: 'library:read' },
  'imports.previewChoices': { kind: 'query', permission: 'library:read' },
  'imports.retry': { kind: 'command', permission: 'library:write' },
  'imports.cancel': { kind: 'command', permission: 'library:write' },
  'imports.status': { kind: 'query', permission: 'library:read' },
  'versions.edit': { kind: 'command', permission: 'library:write' },
  'identification.history': { kind: 'query', permission: 'library:read' },
  'identification.restorePreview': { kind: 'query', permission: 'library:read' },
  'identification.restore': { kind: 'command', permission: 'library:write' },
  'metadata.entity.sources': { kind: 'query', permission: 'library:read' },
  'metadata.entity.requery': { kind: 'command', permission: 'library:write' },
  'metadata.entity.resolve': { kind: 'command', permission: 'library:write' },
  'identification.start': { kind: 'command', permission: 'library:write' },
  'identification.status': { kind: 'query', permission: 'library:read' },
  'identification.decide': { kind: 'command', permission: 'library:write' },
  'identification.detach': { kind: 'command', permission: 'library:write' },
  'identification.detail': { kind: 'query', permission: 'library:read' },
  'identification.candidates': { kind: 'query', permission: 'library:read' },
  'identification.inbox': { kind: 'query', permission: 'library:read' },
  'identification.preview': { kind: 'query', permission: 'library:read' },
  'metadata.entity.enrich': { kind: 'command', permission: 'library:write' },
  'metadata.entity.decide': { kind: 'command', permission: 'library:write' },
  'metadata.entity.detach': { kind: 'command', permission: 'library:write' },
  'metadata.entity.override': { kind: 'command', permission: 'library:write' },
  'metadata.entity.sourcePreference': { kind: 'command', permission: 'library:write' },
  'metadata.entity.artworkOverride': { kind: 'command', permission: 'library:write' },
  'metadata.entity.cancel': { kind: 'command', permission: 'library:write' },
  'metadata.entity.policy': { kind: 'query', permission: 'library:read' },
  'metadata.entity.detail': { kind: 'query', permission: 'library:read' },
  'metadata.entity.jobs': { kind: 'query', permission: 'library:read' },
  'metadata.entity.tasks': { kind: 'query', permission: 'library:read' },
  'metadata.entity.demands': { kind: 'query', permission: 'library:read' },
  'metadata.entity.credits': { kind: 'query', permission: 'library:read' },
  'catalog.refresh': { kind: 'command', permission: 'library:write' },
  'catalog.cancel': { kind: 'command', permission: 'library:write' },
  'catalog.play': { kind: 'command', permission: 'playback:write' },
  'catalog.playUnified': { kind: 'command', permission: 'playback:write' },
  'albums.browse': { kind: 'query', permission: 'library:read' },
  'ratings.detail': { kind: 'query', permission: 'library:read' },
  'ratings.targets': { kind: 'query', permission: 'library:read' },
  'ratings.history': { kind: 'query', permission: 'library:read' },
  'ratings.set': { kind: 'command', permission: 'library:write' },
  'preferences.detail': { kind: 'query', permission: 'library:read' },
  'preferences.targets': { kind: 'query', permission: 'library:read' },
  'preferences.history': { kind: 'query', permission: 'library:read' },
  'preferences.set': { kind: 'command', permission: 'library:write' },
  'tags.list': { kind: 'query', permission: 'library:read' },
  'tags.entity': { kind: 'query', permission: 'library:read' },
  'tags.members': { kind: 'query', permission: 'library:read' },
  'tags.recordings': { kind: 'query', permission: 'library:read' },
  'tags.create': { kind: 'command', permission: 'library:write' },
  'tags.rename': { kind: 'command', permission: 'library:write' },
  'tags.delete': { kind: 'command', permission: 'library:write' },
  'tags.member.set': { kind: 'command', permission: 'library:write' },
  'tags.play': { kind: 'command', permission: 'playback:write' },
  'focus.query': { kind: 'query', permission: 'library:read' },
  'exploration.query': { kind: 'query', permission: 'library:read' },
  'exploration.lookup': { kind: 'query', permission: 'library:read' },
  'exploration.detail': { kind: 'query', permission: 'library:read' },
  'exploration.relations': { kind: 'query', permission: 'library:read' },
  'exploration.participation': { kind: 'query', permission: 'library:read' },
  'exploration.performance.save': { kind: 'command', permission: 'library:write' },
  'exploration.performance.delete': { kind: 'command', permission: 'library:write' },
  'focus.play.status': { kind: 'query', permission: 'playback:read' },
  'focus.facets': { kind: 'query', permission: 'library:read' },
  'focus.saved.list': { kind: 'query', permission: 'library:read' },
  'focus.saved.create': { kind: 'command', permission: 'library:write' },
  'focus.saved.rename': { kind: 'command', permission: 'library:write' },
  'focus.saved.update': { kind: 'command', permission: 'library:write' },
  'focus.saved.delete': { kind: 'command', permission: 'library:write' },
  'focus.play': { kind: 'command', permission: 'playback:write' },
  'albums.sources': { kind: 'query', permission: 'library:read' },
  'genres.tree': { kind: 'query', permission: 'library:read' },
  'genres.browse': { kind: 'query', permission: 'library:read' },
  'genres.members': { kind: 'query', permission: 'library:read' },
  'genres.facets': { kind: 'query', permission: 'library:read' },
  'genres.unmapped': { kind: 'query', permission: 'library:read' },
  'genres.evidence': { kind: 'query', permission: 'library:read' },
  'genres.edit': { kind: 'command', permission: 'library:write' },
  'genres.map': { kind: 'command', permission: 'library:write' },
  'genres.override': { kind: 'command', permission: 'library:write' },
  'catalog.query': { kind: 'query', permission: 'library:read' },
  'catalog.detail': { kind: 'query', permission: 'library:read' },
  'catalog.sources': { kind: 'query', permission: 'library:read' },
  'catalog.status': { kind: 'query', permission: 'library:read' },
  'versions.page': { kind: 'query', permission: 'library:read' },
  'versions.catalog': { kind: 'query', permission: 'library:read' },
  'playlists.edit': { kind: 'command', permission: 'library:write' },
  'playlists.list': { kind: 'query', permission: 'library:read' },
  'playlists.entries': { kind: 'query', permission: 'library:read' },
  'playlists.view': { kind: 'query', permission: 'library:read' },
  'providers.call': { kind: 'command', permission: 'providers:call' },
  'plugins.list': { kind: 'query', permission: 'plugins:read' },
  'plugins.index.list': { kind: 'query', permission: 'plugins:read' },
  'plugins.index.status': { kind: 'query', permission: 'plugins:read' },
  'plugins.index.refresh': { kind: 'command', permission: 'plugins:manage' },
  'plugins.index.install': { kind: 'command', permission: 'plugins:manage' },
  'providers.list': { kind: 'query', permission: 'plugins:read' },
  'extensions.list': { kind: 'query', permission: 'plugins:read' },
  'extensions.experiences': { kind: 'query', permission: 'plugins:read' },
  'extensions.resource': { kind: 'query', permission: 'plugins:resources' },
  'plugins.installSource': { kind: 'command', permission: 'plugins:resources' },
  'extensions.stylesheet': { kind: 'query', permission: 'plugins:read' },
  'extensions.preferences': { kind: 'query', permission: 'plugins:read' },
  'extensions.preferences.edit': { kind: 'command', permission: 'extensions:execute' },
  'extensions.document': { kind: 'query', permission: 'library:read' },
  'extensions.document.edit': { kind: 'command', permission: 'library:write' },
  'extensions.music': { kind: 'command', permission: 'library:write' },
  'extensions.export': { kind: 'command', permission: 'library:read' },
  'extensions.pluginRequest': { kind: 'command', permission: 'extensions:execute' },
  'plugins.log': { kind: 'query', permission: 'plugins:manage' },
  'plugins.enable': { kind: 'command', permission: 'plugins:manage' },
  'plugins.disable': { kind: 'command', permission: 'plugins:manage' },
  'plugins.uninstall': { kind: 'command', permission: 'plugins:manage' },
  'plugins.install': { kind: 'command', permission: 'plugins:manage' },
  'plugins.showLog': { kind: 'command', permission: 'plugins:manage' },
  'plugins.dspParameters': { kind: 'command', permission: 'plugins:manage' },
  'extensions.execute': { kind: 'command', permission: 'extensions:execute' },
  'statistics.summary': { kind: 'query', permission: 'statistics:read' },
  'statistics.overview': { kind: 'query', permission: 'statistics:read' },
  'statistics.previewClear': { kind: 'query', permission: 'statistics:read' },
  'statistics.tracks': { kind: 'query', permission: 'statistics:read' },
  'statistics.clear': { kind: 'command', permission: 'statistics:write' },
  'scan.start': { kind: 'command', permission: 'library:write' },
  'metadata.start': { kind: 'command', permission: 'library:write' },
  'metadata.cancel': { kind: 'command', permission: 'library:write' },
  'metadata.apply': { kind: 'command', permission: 'library:write' },
  'metadata.clear': { kind: 'command', permission: 'library:write' },
  'metadata.status': { kind: 'query', permission: 'library:read' },
  'metadata.candidates': { kind: 'query', permission: 'library:read' },
  'scan.pause': { kind: 'command', permission: 'library:write' },
  'scan.resume': { kind: 'command', permission: 'library:write' },
  'scan.cancel': { kind: 'command', permission: 'library:write' },
  'scan.status': { kind: 'query', permission: 'library:read' },
  'scan.watchers': { kind: 'query', permission: 'library:read' },
  'state.snapshot': { kind: 'query', permission: 'playback:read' },
  'library.metadata': { kind: 'query', permission: 'library:read' },
  'library.recent.resolve': { kind: 'query', permission: 'library:read' },
  'library.tracks': { kind: 'query', permission: 'library:read' },
  'library.collections': { kind: 'query', permission: 'library:read' },
  'library.byIds': { kind: 'query', permission: 'library:read' },
  'library.artwork': { kind: 'query', permission: 'library:read' },
  'library.paths.lookup': { kind: 'query', permission: 'library:read' },
  'playlists.catalog': { kind: 'query', permission: 'library:read' },
  'playlists.collection': { kind: 'query', permission: 'library:read' },
  'playlists.members': { kind: 'query', permission: 'library:read' },
  'playlists.membership': { kind: 'query', permission: 'library:read' },
  'playlists.favorites': { kind: 'query', permission: 'library:read' },
  'playlists.state': { kind: 'query', permission: 'library:read' },
  'playlists.export': { kind: 'query', permission: 'library:read' },
  'playlists.importDocument': { kind: 'command', permission: 'library:write' },
  'playlists.flush': { kind: 'command', permission: 'library:write' },
  'playback.play': { kind: 'command', permission: 'playback:write' },
  'playback.pause': { kind: 'command', permission: 'playback:write' },
  'playback.stop': { kind: 'command', permission: 'playback:write' },
  'playback.seek': { kind: 'command', permission: 'playback:write' },
  'playback.next': { kind: 'command', permission: 'playback:write' },
  'playback.previous': { kind: 'command', permission: 'playback:write' },
  'playback.volume': { kind: 'command', permission: 'playback:write' },
  'playback.mute': { kind: 'command', permission: 'playback:write' },
  'playback.abLoop': { kind: 'command', permission: 'playback:write' },
  'playback.mode': { kind: 'command', permission: 'playback:write' },
  'queue.select': { kind: 'command', permission: 'playback:write' },
  'queue.fromQuery': { kind: 'command', permission: 'playback:write' },
  'queue.submit': { kind: 'command', permission: 'playback:write' },
  'queue.edit': { kind: 'command', permission: 'playback:write' },
  'queue.undo': { kind: 'command', permission: 'playback:write' },
  'queue.refresh': { kind: 'command', permission: 'playback:write' },
  'queue.page': { kind: 'query', permission: 'playback:read' },
  'migration.status': { kind: 'query', permission: 'migration:write' },
  'migration.begin': { kind: 'command', permission: 'migration:write' },
  'migration.stage': { kind: 'command', permission: 'migration:write' },
  'migration.commit': { kind: 'command', permission: 'migration:write' },
  'migration.abort': { kind: 'command', permission: 'migration:write' },
  'lifecycle.flush': { kind: 'command', permission: 'playback:write' }
}

export function coreOperation(value: unknown): (typeof OPERATIONS)[CoreOperation] | null {
  return typeof value === 'string' && Object.hasOwn(OPERATIONS, value)
    ? OPERATIONS[value as CoreOperation]
    : null
}

export function isCoreRequest(value: unknown): value is CoreRequestEnvelope {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const operation = coreOperation(r.name)
  return (
    !!operation &&
    operation.kind === r.kind &&
    Object.keys(r).every((key) =>
      ['kind', 'name', 'payload', 'requestId', 'epoch'].includes(key)
    ) &&
    typeof r.requestId === 'string' &&
    r.requestId.length > 0 &&
    r.requestId.length <= 128 &&
    typeof r.epoch === 'string' &&
    r.epoch.length > 0 &&
    r.epoch.length <= 128 &&
    validCorePayload(r.name as CoreOperation, r.payload)
  )
}
