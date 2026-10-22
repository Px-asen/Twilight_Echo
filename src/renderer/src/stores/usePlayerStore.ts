import { createAbLoopController } from './player/abLoopController.ts'
import { createRendererPauseFadeController } from './player/rendererPauseFadeController.ts'
import { createCastController } from './player/castController.ts'
import { createBpmAnalysisController } from './player/bpmAnalysisController.ts'
import { createAudioOutputState } from '@renderer/stores/player/audioOutputState.ts'
import { createPlaybackSelectionController } from '@renderer/stores/player/playbackSelectionController.ts'
import { createQueueWorkspaceStore } from '@renderer/stores/player/queueWorkspaceStore.ts'
import { createQueueSessionController } from '@renderer/stores/player/queueSessionController.ts'
import {
  createLibraryPlaybackController,
  type LibraryQueuePageProducer,
  type LibraryQueuePageOptions
} from './player/libraryPlaybackController.ts'
import { createLibraryArrayQueueSeed } from './player/libraryArrayQueueSeed.ts'
import {
  libraryNativeQueueOptions,
  libraryQueueTrack,
  libraryTrack
} from '../utils/libraryQueuePlayback.ts'
import type {
  LibraryQuery,
  LibraryQueuePlaybackWindow,
  LibraryQueueSnapshot,
  LibraryQueueEdit
} from '../../../shared/libraryDatabase.ts'
import { LIBRARY_PAGE_SIZE, libraryQueueResumeMode } from '../../../shared/libraryDatabase.ts'
import type { PlaylistTrackPageCreator } from './library/musicStoreTypes.ts'
import { compactPlaylistRecord } from '../../../shared/playlistSnapshot.ts'
import type { LibraryPlaybackQueueReference } from '../../../shared/playbackSession.ts'
import { getQueueSessionSources } from '@renderer/stores/player/queueSessionSources.ts'
import { findNativeQueueTrackIndex } from '@renderer/utils/nativeQueueTrackIndex.ts'
import { dispatchPlayerShortcut } from '@renderer/stores/player/playerShortcutController'
import {
  shallowRef,
  ref,
  computed,
  watch as vueWatch,
  effectScope,
  type WatchStopHandle
} from 'vue'
import { shouldApplyNativeTimePosition } from './playerProgressPolicy.ts'
import type { PlaybackSession, Track } from '../types/music'
import type { AfterglowRestoreState } from '../../../shared/afterglowMode.ts'
import type {
  AudioProcessingSettings,
  OutputConfig,
  OutputConfigApplyStatus,
  PlayMode
} from '../types/settings'
import {
  DEFAULT_DSP_OUTPUT_STAGE,
  DEFAULT_DSP_STEREO_IMAGE,
  extractStereoImageFromGraph,
  mergeDspOutputStage,
  type DspOutputStageConfig,
  type DspStereoImageConfig
} from '../../../shared/dspGraph.ts'
import { extractDominantColor } from '../utils/colorExtractor'
import { resolveCover } from '../utils/coverLoader'
import { normalizeNativePlaybackInfo } from '../utils/playerPlaybackInfo.ts'
import { normalizeOutputConfig } from '../../../shared/audioOutputConfig.ts'
import { clampSoftwareVolume, cloneAudioProcessingSettings } from '../utils/playerAudioSettings.ts'
import {
  NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS,
  NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS,
  NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS,
  PLAYBACK_TOGGLE_INTENT_GRACE_MS,
  RENDERER_PLAYBACK_WATCHDOG_MS,
  START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS,
  START_FILE_PLAYBACK_INFO_REFRESH_DELAY_MS
} from '../utils/playerConstants.ts'
import { formatTime, getNowMs } from '../utils/playerTime.ts'
import {
  getTrackAudioSource,
  getTrackSource,
  isLikelyLocalFilePath,
  isStreamLikeTrack,
  mergeTrackTransientData,
  nonEmptyString
} from '../utils/playerTrackUtils.ts'
import {
  shouldReuseResolvedStreamUrl,
  shouldUseNativePlaybackTarget
} from '../utils/playbackRouting'
import {
  NCM_STREAM_URL_MAX_AGE_MS,
  isAuthorizedRemoteUrl,
  preparePlayerNativeQueue,
  preparedNativePlayMode,
  stripStaleNcmStreamUrls
} from '../utils/nativeQueuePreparation.ts'
import {
  NativeQueueRevisionFence,
  synchronizeLatestNativeQueue
} from '../utils/nativeQueueRevision.ts'
import { NativeQueueLoader } from '../utils/nativeQueueLoader.ts'
import {
  toPlaybackQueueSnapshot,
  toPlaybackQueueSnapshots,
  patchPlaybackQueueTrack
} from '../utils/playbackQueueVirtualization.ts'
import { clampProviderReliability, findPlaybackFallbackTrack } from '../utils/playbackFallback.ts'
import { findProviderRematchCandidate } from '../utils/libraryRepair.ts'
import { useNcmStore } from './useNcmStore.ts'
import { useLyricsManagement } from './lyricsManagement.ts'
import { usePlaybackBookmarks } from './playbackBookmarks'
import {
  getPodcastDefaultPlaybackRate,
  setPodcastDefaultPlaybackRate,
  usePodcastStore
} from './usePodcastStore.ts'
import { createPlaybackHistoryController } from './player/playbackHistoryController.ts'
import { toggleVolumeMute } from '../utils/volumeMute.ts'
import { createDebouncedVolumePersistence } from '../utils/volumePersistence.ts'
import { configurePlayerStoreHmr } from './playerStoreHmr.ts'
import {
  clampCuePlaybackPosition,
  cueDuration,
  rendererAudioAbsolutePositionForTrack,
  rendererAudioPositionForTrack
} from '../utils/cuePlayback.ts'
import {
  evaluateNativePlaybackInfoIntent,
  type NativePlaybackInfoIntent
} from '../utils/nativePlaybackInfoIntent.ts'
import { syncPluginProviders, useMediaProviders } from '../providers'
import { useSettingsStore } from './useSettingsStore'
import { useMusicStore } from './useMusicStore'
import { type SleepTimerState } from '../../../shared/sleepTimer.ts'
import { DEFAULT_SOFTWARE_VOLUME } from '../../../shared/audioProcessingOptions.ts'
import { presentError, presentErrorDetail } from '../../../shared/errors/presentError.ts'
import { ipcError, parseAppError } from '../../../shared/errors/appError.ts'
import { translate } from '../../../shared/i18n/translate.ts'
import { currentLocale } from '../app/useLocale.ts'
import type { LyricSource } from '../../../shared/lyricsManagement.ts'
import { createPlayerSleepTimer } from './player/usePlayerSleepTimer.ts'
import { useAppNoticeStore, type AppNoticeKind } from './useAppNoticeStore'
import { claimRendererRuntime } from './playerRuntimeOwnership.ts'
import {
  createInactiveVisualizationData,
  createVisualizationPolling,
  type NativeVisualizationData
} from './player/useVisualizationPolling.ts'
import { createPlaybackClockController } from './player/playbackClockController.ts'
import { createLyricsLoader } from './player/lyricsLoaderController.ts'
import { createPlaybackSessionController } from './player/playbackSessionController.ts'
import { createPlaybackQueueController } from './player/playbackQueueController.ts'
import { createAudioOutputController } from './player/audioOutputController.ts'
import { createHeartModeController } from './player/heartModeController.ts'
import { createRemoteControlBridge } from './player/remoteControlBridge.ts'
import { createLibraryPlaylistView } from './library/libraryPlaylistView.ts'
import { getMusicVersions, musicVersionRevision } from './musicVersions.ts'
import { createRemotePlaybackPublisher } from './player/remotePlaybackPublisher.ts'
import { createNativePlaybackToggleController } from '@renderer/stores/player/nativePlaybackToggleController.ts'
import { createPlayerSystemIntegrations } from './player/playerSystemIntegrations.ts'
import { useProviderStore } from './useProviderStore'
import { onLocalTracksRemovalRequested } from '../utils/localTrackRemovalPolicy.ts'

type NativePlaybackInfo = Awaited<ReturnType<typeof window.api.audioEngine.getPlaybackInfo>>
type NativeOutputInfo = NativePlaybackInfo['outputInfo']
// Module state is intentionally shared by all player consumers. Vite replaces
// this module in development, so every watcher must belong to a runtime scope
// that the replacement can stop before registering its own listeners.
const playerRuntimeScope = effectScope(true)
const watch = ((...args: unknown[]): WatchStopHandle => {
  let stop: WatchStopHandle | undefined
  playerRuntimeScope.run(() => {
    stop = (vueWatch as (...parameters: unknown[]) => WatchStopHandle)(...args)
  })
  return stop!
}) as typeof vueWatch
const PLAYER_RUNTIME_OWNERSHIP_KEY = Symbol.for('twilight-echo.player-store-runtime')
let remoteControlBridge: ReturnType<typeof createRemoteControlBridge> | null = null
let removeRemoteRequestListener: (() => void) | null = null
const remotePlaylistViews = new Map<string, ReturnType<typeof createLibraryPlaylistView>>()
type ProviderSourceReliability = Record<string, number>
export type PersonalizedStreamKey = 'fm' | 'radar'
export interface PersonalizedStreamSession {
  id: number
  key: PersonalizedStreamKey
}

export interface AudioEngineRecoveryNotice {
  kind: 'service-crash' | 'service-fatal' | 'service-ready'
  message: string
  actionLabel?: string
  canResume?: boolean
}

export interface LyricsLoadState {
  trackId: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed'
}

const currentTrack = ref<Track | null>(null)
const dominantColor = ref('#1a73e8')
const coverThemeColor = ref('#1a73e8')
const themeCoverUrl = ref('')
const themeCoverIdentity = ref('')
const isPlaying = ref(false)
const isLoading = ref(false)
const lyricsLoadState = ref<LyricsLoadState>({ trackId: '', status: 'idle' })

const lyricsLoader = createLyricsLoader({
  currentTrack,
  lyricsLoadState,
  getAppSettings: () => appSettings,
  patchTrackInQueues,
  getLyricsManagement: useLyricsManagement
})

// A lyric request belongs to a particular playback activation, not merely to
// a song id. Returning to the same song after switching away must never reuse
// a suspended request that was started for the previous activation.
watch(
  () => currentTrack.value?.id ?? '',
  (trackId, previousTrackId) => {
    if (trackId === previousTrackId) return
    lyricsLoader.onTrackChanged(trackId, previousTrackId)
  },
  { flush: 'sync' }
)
const isStreamBuffering = ref(false)
/** Live ICY StreamTitle from native radio playback (empty when unavailable). */
const streamNowPlaying = ref('')
/** Last observed native sessionUnderrunCount; rise while playing stream → buffering UX. */
let lastNativeSessionUnderrunCount = 0
let nativeStreamBufferingClearTimer: ReturnType<typeof setTimeout> | null = null
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(DEFAULT_SOFTWARE_VOLUME)
const muted = ref(false)
/** Application-layer playback rate (0.5–2). 1 = realtime. */
const playbackRate = ref(1)
/** A-B loop points in seconds relative to the logical track start. Null = unset. */
const abLoopA = ref<number | null>(null)
const abLoopB = ref<number | null>(null)
const {
  clearAbLoop,
  isCurrentTrackLiveStream,
  setAbLoopPoint,
  toggleAbLoopAtCurrentTime,
  enforceAbLoop,
  getAbLoopNativeActive
} = createAbLoopController({
  currentTrack,
  abLoopA,
  abLoopB,
  getLatestPlaybackTime: () => getLatestPlaybackTime(),
  seekPlayback,
  getNativeLoopRange: () => window.api?.audioEngine?.setLoopRange
})
const lastAudibleVolume = ref(DEFAULT_SOFTWARE_VOLUME)
let suppressVolumePersist = false
/** Active cast target display name (null when not casting). */
const castTargetName = ref<string | null>(null)
/** Active cast device id (usn); required to re-cast on queue skip. */
const castTargetUsn = ref<string | null>(null)
const sleepTimerState = ref<SleepTimerState | null>(null)
const sleepTimerNotice = ref<string | null>(null)
// Queue entries are immutable playback snapshots. Keeping this as a shallow
// array avoids proxying every nested field for a 5k/20k queue.
const queue = shallowRef<Track[]>([])
const queueIndex = ref(-1)
const playMode = ref<PlayMode>('sequential')
const originalQueue = shallowRef<Track[]>([])
// Database membership is never put in the full-array legacy entry points.
const libraryPlayback = createLibraryPlaybackController({
  buildQueue: (...args) => window.api.library.database.buildQueue(...args),
  createQueue: (...args) => window.api.library.database.createQueue(...args),
  getQueue: (...args) => window.api.library.database.getQueue(...args),
  readQueue: (...args) => window.api.library.database.readQueue(...args),
  editQueue: (...args) => window.api.library.database.editQueue(...args),
  deleteQueue: (...args) => window.api.library.database.deleteQueue(...args),
  syncQueueReferences: (...args) => window.api.library.database.syncQueueReferences(...args)
})
const personalizedStreamSession = ref<PersonalizedStreamSession | null>(null)
const personalizedStreamRemaining = ref(0)
const personalizedStreamEntryIds = new Set<string>()
const personalizedStreamPlayedEntryIds = new Set<string>()
const audioEngineReady = ref(false)
const audioEngineError = ref<string | null>(null)
const audioEngineRecoveryNotice = ref<AudioEngineRecoveryNotice | null>(null)
const { pushNotice, dismissNotice, releaseNoticeDedupe } = useAppNoticeStore()
let audioEngineRecoveryAppNoticeId = 0
let lastAudioEngineNotice = ''

/**
 * Resolve an audio-engine error string for display.
 *
 * Every audio failure reaches the UI through `setAudioEngineError`, including the
 * 14 catch blocks that hand over a raw `err.message` from an IPC rejection.
 * Resolving here means a main-process `ipcError(...)` is translated — and its
 * `[TE-ERR:...]` tail stripped — without each catch block knowing about the codec.
 *
 * Only a sentinel-carrying message is translated. Anything else is passed through
 * verbatim rather than sent to `presentError`: that function's job is to replace
 * unrecognized *platform* English with a generic fallback, and it cannot tell our
 * own English copy from a Node error string. Running "The audio service failed to
 * start" through it under en-US produced "An unknown error occurred" — a
 * regression that zh-CN hid, because the CJK passthrough rule saved it there.
 */
function resolveAudioEngineErrorText(error: string): string {
  const parsed = parseAppError(error)
  if (parsed.code !== null) return presentError(currentLocale(), error).trim()
  return error.trim()
}

/**
 * Publish an audio-engine error to the inline banner and the toast host.
 *
 * `kind` is passed in rather than sniffed out of the message. It used to be
 * inferred by substring-matching Chinese copy ("已启用临时播放通道" and friends),
 * which silently tied severity to wording: translating the message would have
 * reclassified a recovered-with-fallback warning as a hard error. Callers know
 * which case they are in, so they say so.
 */
function setAudioEngineError(error: string | null, kind: AppNoticeKind = 'error'): void {
  const message = typeof error === 'string' ? resolveAudioEngineErrorText(error) : ''
  audioEngineError.value = message || error
  if (!message) {
    lastAudioEngineNotice = ''
    return
  }
  if (message === lastAudioEngineNotice) return
  lastAudioEngineNotice = message
  pushNotice({ kind, message })
}
// Tracks whether the in-PlayingMusic audio visualizer surface is active.
// App.vue reads this to hide the PlayerBar while the visualizer is open.
const visualizerActive = ref(false)
const defaultAudioProcessing: AudioProcessingSettings = {
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  fftEnabled: true,
  fftResolution: 8192,
  highResolution: true,
  dsdToPcm: false,
  dsdOutputMode: 'auto',
  dsdRatePolicy: 'pcm-fallback',
  dsdRoute: {
    enabled: false,
    backend: '',
    device: '',
    applyToPcmToDsd: true,
    strictPassthrough: false
  },
  sacdProgramMode: 'auto',
  eqEnabled: false,
  eqMode: 'graphic',
  eqPreamp: 0,
  eqBands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency) => ({
    frequency,
    gain: 0,
    q: 1,
    filterType: 'peak'
  })),
  volumeNormalization: 'off',
  replayGainPreamp: 0,
  replayGainFallback: 0,
  replayGainClip: true,
  convolverEnabled: false,
  convolverIrPath: '',
  crossfeedEnabled: false,
  crossfeedStrength: 0,
  crossfeedDelayMs: 0.35,
  crossfeedCutoffHz: 700,
  gapless: true,
  crossfadeSeconds: 0
}
const audioProcessing = ref<AudioProcessingSettings>({ ...defaultAudioProcessing })
const defaultAudioOutputConfig: OutputConfig = {
  preferredBufferSize: 0,
  routingMode: 'auto',
  wasapiExclusivePushMode: false
}
const audioOutputConfig = ref<OutputConfig>({ ...defaultAudioOutputConfig })
const audioOutputConfigApplyStatus = ref<OutputConfigApplyStatus>({
  requestedRevision: 0,
  appliedRevision: 0,
  failedRevision: 0,
  state: 'idle',
  error: '',
  generation: 0
})
/** Default-scene graph.outputStage (sample-rate lock / SRC / dither). Not OutputConfig. */
const dspOutputStage = ref<DspOutputStageConfig>({ ...DEFAULT_DSP_OUTPUT_STAGE })
/** Default-scene stereoField + channelStrip polarity (HiFi balance/phase). */
const dspStereoImage = ref<DspStereoImageConfig>({ ...DEFAULT_DSP_STEREO_IMAGE })
const {
  exclusiveMode,
  audioOutput,
  audioDevice,
  audioOutputOptions,
  audioDeviceOptions,
  audioOutputDeviceOptions,
  applyAudioOutputState,
  refreshAudioOutputState
} = createAudioOutputState({
  audioProcessing,
  dspOutputStage,
  dspStereoImage,
  audioEngineReady,
  setAudioEngineError
})
const playbackInfo = ref<NativePlaybackInfo | null>(null)
const loudnormStatus = ref<'idle' | 'measuring' | 'cached' | 'fallback' | 'unavailable'>('idle')
const loudnormStatusSource = ref<string | null>(null)
const outputInfo = computed<NativeOutputInfo | null>(() => playbackInfo.value?.outputInfo ?? null)
// 高频（60ms）整体替换的可视化载荷不值得一层层深度代理，消费方只读快照。
const visualizationData = shallowRef<NativeVisualizationData>(createInactiveVisualizationData())
// 读取 visualizationData 的已挂载组件数；为 0 时 60ms IPC 轮询不启动。
const visualizationConsumers = ref(0)
const visualizationDocumentVisible = ref(typeof document === 'undefined' || !document.hidden)
const {
  settings: appSettings,
  loaded: settingsLoaded,
  platform: appPlatform,
  updateSettings
} = useSettingsStore()
const lyricsManagement = useLyricsManagement()
let playbackAudio: HTMLAudioElement | null = null
let playbackObjectUrl: string | null = null
let nativePlaybackActive = false
let nativeQueueDelegated = false
/**
 * 原生引擎在授权/缓存层会把 source 解析成缓存文件或 CDN 直链，playback-info
 * 回传的 source 与渲染层队列条目的 streamUrl/filePath 可能不一致。渲染层每次
 * 实际发起播放时（loadAndPlay）都记录 source->track.id 映射，匹配 playback-info
 * 时先按 source 查映射，保证原生自动切歌后 queueIndex/currentTrack 能同步。
 */
const nativeSourceToTrackId = new Map<string, string>()
// source->track.id 只是 playback-info 匹配提示（失配时走 queueIndex+source 校验
// 回退），但授权层解析出的缓存路径/CDN 直链会让 source 每次播放都不同，只增不减
// 即无界增长。超过上限时先收紧到当前原生队列 source 集合，再按插入序淘汰旧项。
const NATIVE_SOURCE_TO_TRACK_ID_LIMIT = 1024

function pruneNativeSourceToTrackId(
  items: ReadonlyArray<{ source: string; id: string }>,
  protectedSource?: string
): void {
  if (nativeSourceToTrackId.size <= NATIVE_SOURCE_TO_TRACK_ID_LIMIT) return
  const validSources = new Set(items.map((item) => item.source))
  for (const source of nativeSourceToTrackId.keys()) {
    if (nativeSourceToTrackId.size <= NATIVE_SOURCE_TO_TRACK_ID_LIMIT) break
    if (!validSources.has(source) && source !== protectedSource) {
      nativeSourceToTrackId.delete(source)
    }
  }
  for (const source of nativeSourceToTrackId.keys()) {
    if (nativeSourceToTrackId.size <= NATIVE_SOURCE_TO_TRACK_ID_LIMIT) break
    if (source === protectedSource) continue
    nativeSourceToTrackId.delete(source)
  }
}

// —— 8.4 NCM 下一曲播放地址预取 ——
// 启动、原生切曲和队列编辑时立即准备下一首，播放进度 ≥70% 时重试。并发 1；
// 预取地址仅在 NCM_STREAM_URL_MAX_AGE_MS（10min）窗口内被原生队列携带——短于
// CDN 链接有效期，也尊重 twilight-media grant 的 30min 空闲 TTL。
const NCM_PREFETCH_TRIGGER_PROGRESS = 0.7
const MAX_NCM_STREAM_URL_RECORDS = 64
const ncmStreamUrlCommittedAt = new Map<string, number>()
let ncmPrefetchInFlightTrackId = ''
let ncmPrefetchGeneration = 0
let ncmPrefetchRetryAfter = 0
let ncmPrefetchRetryKey = ''
let ncmPrefetchLastSyncedKey = ''

function getNcmPrefetchScope(): string {
  const ncm = useNcmStore()
  return `${ncm.isLoggedIn.value}:${ncm.profile.value?.userId ?? ''}:${appSettings.value.ncmPlaybackQuality}`
}

function rememberNcmStreamUrlCommit(trackId: string): void {
  ncmStreamUrlCommittedAt.delete(trackId)
  ncmStreamUrlCommittedAt.set(trackId, Date.now())
  while (ncmStreamUrlCommittedAt.size > MAX_NCM_STREAM_URL_RECORDS) {
    const oldest = ncmStreamUrlCommittedAt.keys().next().value
    if (oldest == null) break
    ncmStreamUrlCommittedAt.delete(oldest)
  }
}

/** 队列里的「下一首」：与 advanceAfterPlaybackEnded 的推进语义保持一致。 */
function findUpcomingQueueTrack(): Track | null {
  if (playMode.value === 'repeat' || playMode.value === 'heart') return null
  const nextIndex = queueIndex.value + 1
  if (nextIndex >= 0 && nextIndex < queue.value.length) return queue.value[nextIndex] ?? null
  if ((playMode.value === 'listLoop' || playMode.value === 'shuffle') && queue.value.length > 0) {
    return queue.value[0] ?? null
  }
  return null
}

async function prefetchUpcomingNcmStream(): Promise<void> {
  if (
    nativeQueueAdoptionUncertain ||
    !nativePlaybackActive ||
    isLoading.value ||
    !isPlaying.value ||
    castTargetUsn.value
  )
    return
  const upcoming = findUpcomingQueueTrack()
  if (!upcoming || getTrackSource(upcoming) !== 'ncm') return
  const trackId = upcoming.id
  if (ncmPrefetchInFlightTrackId) return
  const committedAt = ncmStreamUrlCommittedAt.get(trackId)
  const quality = appSettings.value.ncmPlaybackQuality
  const scope = getNcmPrefetchScope()
  const retryKey = `${activeLoadToken}:${scope}:${playMode.value}:${queueIndex.value}:${currentTrack.value?.queueEntryId}:${upcoming.queueEntryId ?? trackId}`
  const generation = ncmPrefetchGeneration
  const loadToken = activeLoadToken
  const currentUpcoming = (): Track | null => {
    const latest = findUpcomingQueueTrack()
    return generation === ncmPrefetchGeneration &&
      loadToken === activeLoadToken &&
      scope === getNcmPrefetchScope() &&
      nativePlaybackActive &&
      !nativeQueueAdoptionUncertain &&
      latest?.id === trackId &&
      latest.queueEntryId === upcoming.queueEntryId
      ? latest
      : null
  }
  let attempted = false
  let succeeded = false
  ncmPrefetchInFlightTrackId = trackId
  try {
    if (
      upcoming.streamUrl &&
      upcoming.streamQuality === quality &&
      committedAt != null &&
      Date.now() - committedAt < NCM_STREAM_URL_MAX_AGE_MS &&
      (isAuthorizedRemoteUrl(upcoming.streamUrl) ||
        (await isUsableLocalPlaybackFile(upcoming.streamUrl)))
    ) {
      if (
        currentUpcoming() &&
        nativeQueueLoader.hasWindow() &&
        ncmPrefetchLastSyncedKey !== retryKey
      ) {
        await queueNativeQueueStateSync()
        ncmPrefetchLastSyncedKey = retryKey
      }
      return
    }
    if (retryKey === ncmPrefetchRetryKey && Date.now() < ncmPrefetchRetryAfter) return
    attempted = true
    await syncPluginProviders()
    const result = await useProviderStore().callProvider<
      | string
      | {
          streamUrl: string
          sampleRate?: number
          bitrate?: number
        }
      | null
    >('ncm', 'getPlaybackUrl', [upcoming, { quality, _twilightPlaybackMetadata: true }])
    const resolved = typeof result === 'string' ? result : result?.streamUrl
    if (!resolved) return
    if (
      !isAuthorizedRemoteUrl(resolved) &&
      (!isLikelyLocalFilePath(resolved) || !(await isUsableLocalPlaybackFile(resolved)))
    )
      return
    // Resolution and cache authorization may outlive queue/account/quality changes.
    const stillUpcoming = currentUpcoming()
    if (!stillUpcoming) return

    if (result && typeof result !== 'string') {
      stillUpcoming.sampleRate =
        typeof result.sampleRate === 'number' &&
        Number.isFinite(result.sampleRate) &&
        result.sampleRate > 0
          ? result.sampleRate
          : undefined

      stillUpcoming.bitrate =
        typeof result.bitrate === 'number' && Number.isFinite(result.bitrate) && result.bitrate > 0
          ? result.bitrate
          : undefined
    }

    stillUpcoming.streamUrl = resolved
    stillUpcoming.streamQuality = quality
    patchTrackInQueues(stillUpcoming)
    rememberNcmStreamUrlCommit(trackId)
    await queueNativeQueueStateSync()
    ncmPrefetchLastSyncedKey = retryKey
    succeeded = true
  } catch {
    // Normal playback remains the fallback; do not hammer the provider on every tick.
    ncmStreamUrlCommittedAt.delete(trackId)
    ncmPrefetchLastSyncedKey = ''
  } finally {
    if (attempted && !succeeded) {
      ncmPrefetchRetryAfter = Date.now() + 5_000
      ncmPrefetchRetryKey = retryKey
    }
    if (ncmPrefetchInFlightTrackId === trackId) ncmPrefetchInFlightTrackId = ''
    if (
      generation !== ncmPrefetchGeneration ||
      loadToken !== activeLoadToken ||
      scope !== getNcmPrefetchScope() ||
      findUpcomingQueueTrack()?.queueEntryId !== upcoming.queueEntryId ||
      findUpcomingQueueTrack()?.id !== trackId
    ) {
      ncmPrefetchRetryAfter = 0
      void prefetchUpcomingNcmStream()
    }
  }
}

const nativeQueueRevisionFence = new NativeQueueRevisionFence()
const nativeQueueLoader = new NativeQueueLoader()
let libraryNativeHandoff: Promise<void> | null = null
let latestLibraryHandoffInfo: NativePlaybackInfo | null = null
let libraryTransportIntent = 0
let libraryPlayModeIntent = 0
let requestedLibraryPlayMode: PlayMode | null = null
let activeLoadToken = 0
let activeLoadCompletion: Promise<void> | null = null
// Suppress identity-free native events while a conditional handoff is in
// flight, or its outcome is unknown. An explicit load/resync restores authority.
let nativeQueueAdoptionUncertain = false
let rendererFallbackInProgress = false
let rendererPlaybackWatchdogTimer: number | null = null
let playbackToggleIntent: { playing: boolean; expiresAt: number } | null = null
let nativePlaybackInfoIntent: NativePlaybackInfoIntent | null = null
let startFilePlaybackInfoRefreshGeneration = 0
let rendererResumePlaybackInfoRefresh: Promise<void> | null = null

const { applyBpmAnalysisToTrack, clearBpmAnalysisFromPlaybackState, requestBpmAnalysisForTrack } =
  createBpmAnalysisController({
    currentTrack,
    queue,
    originalQueue,
    isEnabled: () => useSettingsStore().settings.value.autoAnalyzeBpm !== false,
    patchTrackInQueues,
    getMusicStore: useMusicStore,
    getAnalysisApi: () => window.api?.bpmAnalysis
  })

function isActiveLoad(loadToken: number, track: Track): boolean {
  return (
    loadToken === activeLoadToken &&
    currentTrack.value?.id === track.id &&
    (!libraryPlayback.active.value || currentTrack.value.queueEntryId === track.queueEntryId)
  )
}

function clearRendererPlaybackWatchdog(): void {
  if (rendererPlaybackWatchdogTimer !== null) {
    window.clearTimeout(rendererPlaybackWatchdogTimer)
    rendererPlaybackWatchdogTimer = null
  }
}

/** After an intentional next/prev/load, reject delayed previous-track snapshots. */
let intentionalTrackGuard: {
  trackId: string
  source: string
  until: number
} | null = null

function setNativePlaybackInfoIntent(
  loadToken: number,
  track: Track,
  source = '',
  targetQueueIndex = queueIndex.value
): void {
  const normalizedSource = typeof source === 'string' ? source.trim() : ''
  const now = getNowMs()
  nativePlaybackInfoIntent = {
    loadToken,
    trackId: track.id,
    queueIndex: targetQueueIndex,
    source: normalizedSource,
    expiresAt: now + NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS,
    confirmedAt: null
  }
  // Sticky guard outlives the intent so a late previous-track tick cannot flash
  // the UI after confirmation clears/expires the primary intent.
  intentionalTrackGuard = {
    trackId: track.id,
    source: normalizedSource || getTrackAudioSource(track),
    until:
      now + NATIVE_PLAYBACK_INFO_INTENT_GRACE_MS + NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
  }
}

function clearNativePlaybackInfoIntent(): void {
  nativePlaybackInfoIntent = null
}

function clearNativePlaybackInfoIntentForLoad(loadToken: number): void {
  if (nativePlaybackInfoIntent?.loadToken === loadToken) {
    clearNativePlaybackInfoIntent()
  }
}

function markNativePlaybackInfoIntentConfirmed(now = getNowMs()): void {
  const intent = nativePlaybackInfoIntent
  if (!intent || intent.confirmedAt !== null) return
  intent.confirmedAt = now
  // Bound the guard to this confirmation. Extending it on every playing tick
  // also rejects legitimate native gapless advances later in the song.
  intent.expiresAt = Math.max(
    intent.expiresAt,
    now + NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
  )
  if (intentionalTrackGuard && intentionalTrackGuard.trackId === intent.trackId) {
    intentionalTrackGuard.until = Math.max(intentionalTrackGuard.until, intent.expiresAt)
  }
}

function shouldIgnoreNativePlaybackInfo(info: NativePlaybackInfo, infoIndex: number): boolean {
  const indexedTrack = libraryPlayback.active.value
    ? libraryPlayback.window.value?.items.find((item) => item.position === infoIndex)?.track
    : infoIndex >= 0
      ? queue.value[infoIndex]
      : null
  const now = getNowMs()
  const source = typeof info.source === 'string' ? info.source.trim() : ''
  const candidateTrackId = indexedTrack?.id ?? ''

  const intent = nativePlaybackInfoIntent
  if (intent) {
    const decision = evaluateNativePlaybackInfoIntent(
      intent,
      { trackId: candidateTrackId, source },
      now,
      NATIVE_PLAYBACK_INFO_POST_CONFIRMATION_GRACE_MS
    )
    if (decision === 'expired') {
      clearNativePlaybackInfoIntent()
      // Fall through to sticky guard — do not immediately apply a non-matching row.
    } else if (decision === 'match') {
      markNativePlaybackInfoIntentConfirmed(now)
      return false
    } else {
      return true
    }
  }

  const guard = intentionalTrackGuard
  if (guard && now <= guard.until) {
    const matchesGuardTrack = candidateTrackId.length > 0 && candidateTrackId === guard.trackId
    const matchesGuardSource =
      source.length > 0 && (source === guard.source || source === guard.trackId)
    if (matchesGuardTrack || matchesGuardSource) return false
    // Conflicting identity while a recent intentional switch is still settling.
    if (candidateTrackId.length > 0 || source.length > 0) return true
  } else if (guard && now > guard.until) {
    intentionalTrackGuard = null
  }

  return false
}

function setPlaybackToggleIntent(playing: boolean): void {
  if (playing) clearPendingNativePause()
  playbackToggleIntent = {
    playing,
    expiresAt: getNowMs() + PLAYBACK_TOGGLE_INTENT_GRACE_MS
  }
}

function clearPlaybackToggleIntent(): void {
  playbackToggleIntent = null
}

function applyNativePlayingState(playing: boolean, pausePosition: number | null = null): void {
  if (playbackToggleIntent) {
    if (getNowMs() > playbackToggleIntent.expiresAt) {
      clearPlaybackToggleIntent()
    } else if (playing !== playbackToggleIntent.playing) {
      // Drop stale pause/playback-info that still reflects the pre-toggle state.
      // Clearing the intent immediately after togglePause re-opened this race and
      // made the play/pause button briefly flip back before settling.
      return
    }
    // Matching confirmation: apply UI state but keep the intent until grace
    // expires so later out-of-order ticks cannot reverse the button again.
  }

  if (playing) {
    clearPendingNativePause()
    isPlaying.value = true
    publishPlaybackClockTransport('playing', playbackRate.value)
    return
  }

  if (
    pausePosition !== null &&
    isPlaying.value &&
    nativePlaybackActive &&
    playbackToggleIntent?.playing !== false
  ) {
    deferNativePause(pausePosition)
    return
  }

  clearPendingNativePause()
  isPlaying.value = playing
  publishPlaybackClockTransport('paused', playbackRate.value)
}

function scheduleRendererPlaybackWatchdog(track: Track, loadToken: number): void {
  clearRendererPlaybackWatchdog()
  rendererPlaybackWatchdogTimer = window.setTimeout(async () => {
    rendererPlaybackWatchdogTimer = null
    if (!isActiveLoad(loadToken, track) || nativePlaybackActive) return

    const audio = playbackAudio
    if (!audio || !audio.src || !audio.paused || audio.ended) return

    try {
      await stopNativeAudio()
      await audio.play()
    } catch (err) {
      if (!isActiveLoad(loadToken, track)) return
      console.warn('[audio-engine] Renderer playback watchdog retry failed:', err)
    }
  }, RENDERER_PLAYBACK_WATCHDOG_MS)
}

function getPlaybackAudio(): HTMLAudioElement {
  if (playbackAudio) return playbackAudio

  const audio = new Audio()
  audio.preload = 'auto'
  audio.volume = volume.value
  applyPlaybackRateToHtmlAudio(audio)

  audio.addEventListener('loadedmetadata', () => {
    if (currentTrack.value?.cueRange) {
      duration.value = cueDuration(currentTrack.value)
    } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration.value = audio.duration
    }
    publishPlaybackClockDuration(duration.value)
  })

  audio.addEventListener('timeupdate', () => {
    if (Number.isFinite(audio.currentTime)) {
      const track = currentTrack.value
      const position = rendererAudioPositionForTrack(audio.currentTime, track)
      applyPlaybackPositionSample(position, 'html-audio')
      if (track?.cueRange && audio.currentTime >= track.cueRange.endSeconds) {
        audio.pause()
        audio.currentTime = track.cueRange.endSeconds
        setCurrentTimeImmediate(cueDuration(track))
        void handlePlaybackEnded()
        return
      }
      scheduleCrossfadeIfNeeded()
    }
  })

  audio.addEventListener('play', () => {
    isPlaying.value = true
    flushLatestCurrentTime()
  })

  audio.addEventListener('pause', () => {
    if (!audio.ended) {
      isPlaying.value = false
      flushLatestCurrentTime()
    }
  })

  audio.addEventListener('ended', () => {
    isPlaying.value = false
    void handlePlaybackEnded()
  })

  audio.addEventListener('error', () => {
    resetNativeStreamBufferingState()
    const code = audio.error?.code ?? 0
    const mediaErrorMessage = audio.error?.message?.trim() || ''
    const message = mediaErrorMessage
      ? `临时播放通道失败：${mediaErrorMessage}`
      : `临时播放通道失败（错误码 ${code}）`
    console.error('[audio-engine] Renderer audio error:', {
      code,
      message: mediaErrorMessage,
      src: audio.src ? audio.src.slice(0, 120) : ''
    })
    // Renderer (non-native) playback failed — attempt cross-source fallback
    // before surfacing the error. loadAndPlay's catch block already handles
    // failures during initial load; this covers mid-stream CDN drops / 403 /
    // decode errors that occur after playback has started.
    const track = currentTrack.value
    if (track && !nativePlaybackActive && !rendererFallbackInProgress) {
      rendererFallbackInProgress = true
      void handlePlaybackFallback(track, new Error(message), activeLoadToken).then((handled) => {
        rendererFallbackInProgress = false
        if (!handled) {
          setAudioEngineError(message)
          isPlaying.value = false
          isLoading.value = false
        }
      })
      return
    }
    setAudioEngineError(message)
    isPlaying.value = false
    isLoading.value = false
  })

  const markBuffering = (): void => {
    if (nativePlaybackActive) return
    const track = currentTrack.value
    if (!track) return
    if (
      track.source === 'radio' ||
      track.source === 'podcast' ||
      /^https?:\/\//i.test(track.filePath || '')
    ) {
      isStreamBuffering.value = true
    }
  }
  const clearBuffering = (): void => {
    isStreamBuffering.value = false
  }
  audio.addEventListener('waiting', markBuffering)
  audio.addEventListener('stalled', markBuffering)
  audio.addEventListener('canplay', clearBuffering)
  audio.addEventListener('playing', clearBuffering)
  audio.addEventListener('emptied', clearBuffering)

  playbackAudio = audio
  return audio
}

function releasePlaybackObjectUrl(): void {
  if (playbackObjectUrl) {
    URL.revokeObjectURL(playbackObjectUrl)
    playbackObjectUrl = null
  }
}

function stopRendererAudio(clearSource = false): void {
  clearRendererPlaybackWatchdog()
  rendererPauseFadeController.cancel()
  if (!playbackAudio) return
  playbackAudio.pause()
  if (clearSource) {
    playbackAudio.removeAttribute('src')
    playbackAudio.load()
    releasePlaybackObjectUrl()
  }
}

function resetPlaybackRuntimeStateForRestore(): void {
  nativeQueueAdoptionUncertain = false
  activeLoadToken += 1
  nativeQueueRevisionFence.next()
  startFilePlaybackInfoRefreshGeneration++
  nativeSourceToTrackId.clear()
  nativePlaybackActive = false
  nativeQueueDelegated = false
  loadedTrackId = ''
  playbackInfo.value = null
  clearNativePlaybackInfoIntent()
  clearPlaybackToggleIntent()
  resetPlaybackClock()
  resetNativeStreamBufferingState()
  stopVisualizationPolling(true)
  stopRendererAudio(true)
  void stopNativeAudio()
  if (castTargetUsn.value) {
    void stopCastSession().catch((error) => {
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  }
}

function seekRendererAudioWhenReady(
  audio: HTMLAudioElement,
  startTime: number,
  track: Track,
  loadToken: number
): void {
  const targetTime = clampCuePlaybackPosition(track, startTime)

  const applySeek = (): void => {
    if (!isActiveLoad(loadToken, track)) return
    try {
      audio.currentTime = rendererAudioAbsolutePositionForTrack(targetTime, track)
    } catch (err) {
      console.warn('[audio-engine] Failed to restore renderer playback position:', err)
    }
  }

  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    applySeek()
    return
  }

  audio.addEventListener('loadedmetadata', applySeek, { once: true })
}

async function stopNativeAudio(): Promise<void> {
  nativeQueueDelegated = false
  try {
    await window.api.audioEngine.stop()
  } catch {
    // The renderer audio fallback can still continue if the native bridge is unavailable.
  }
}

function normalizeRemovalPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return appPlatform.value === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isRemovalTarget(filePath: string | undefined, targets: Set<string>): boolean {
  return !!filePath && targets.has(normalizeRemovalPath(filePath))
}

/**
 * Native playback preloads the upcoming queue item, so stopping only the
 * current track is insufficient when that upcoming file is being trashed.
 * Renderer fallback audio also needs its source cleared before the main IPC
 * attempts the filesystem operation.
 */
async function prepareLocalTracksForRemoval(
  _trackIds: string[],
  filePaths: string[]
): Promise<void> {
  const targets = new Set(
    filePaths
      .filter((filePath) => typeof filePath === 'string' && filePath)
      .map(normalizeRemovalPath)
  )
  if (targets.size === 0) return

  const current = currentTrack.value
  const currentPath =
    current && getTrackSource(current) === 'local' ? normalizeRemovalPath(current.filePath) : ''
  const currentMatches = currentPath.length > 0 && targets.has(currentPath)
  const nativeInfo = playbackInfo.value
  const nativeSourceMatches = isRemovalTarget(nativeInfo?.source, targets)
  const upcomingSourceMatches = isRemovalTarget(nativeInfo?.upcomingTrack?.source, targets)
  const rendererMatches = currentMatches && loadedTrackId === current?.id
  const nativeMatches =
    nativePlaybackActive || nativeQueueDelegated
      ? currentMatches || nativeSourceMatches || upcomingSourceMatches
      : nativeSourceMatches || upcomingSourceMatches

  if (!nativeMatches && !rendererMatches) return

  activeLoadToken += 1
  nativeQueueRevisionFence.next()
  clearCrossfadeTimer()
  clearPlaybackToggleIntent()
  clearNativePlaybackInfoIntent()
  stopVisualizationPolling(true)
  isLoading.value = false
  isPlaying.value = false
  loadedTrackId = ''
  stopRendererAudio(true)

  // Await the native command. The Windows decoder and any preloaded stream
  // release their handles as part of Stop; the retrying trash operation in the
  // main process covers the small OS-level close delay that can follow it.
  if (nativeMatches) await stopNativeAudio()
  nativePlaybackActive = false
  nativeQueueDelegated = false
}

const playbackClockController = createPlaybackClockController({
  currentTrack,
  currentTime,
  duration,
  playbackRate,
  isPlaying,
  isLoading,
  abLoopA,
  abLoopB,
  playMode,
  getNow: getNowMs,
  getPlaybackToggleIntent: () => playbackToggleIntent,
  getAbLoopNativeActive,
  enforceAbLoop,
  isCurrentTrackLiveStream,
  applyNativePlaybackInfo
})
const {
  playbackClockSnapshot,
  clearPendingNativePause,
  deferNativePause,
  setCurrentTimeImmediate,
  anchorRendererPlaybackClock,
  beginPlaybackPositionTransition,
  applyPlaybackPositionSample,
  estimatePlaybackClockPosition,
  flushLatestCurrentTime,
  startRendererPlaybackClock,
  getLatestPlaybackTime,
  setTransport: publishPlaybackClockTransport,
  setDuration: publishPlaybackClockDuration,
  resetPlaybackClock,
  dispose: disposePlaybackClock
} = playbackClockController

const playbackSessionController = createPlaybackSessionController({
  getLibraryQueueReference: () => libraryPlayback.reference(),
  restoreLibraryQueue: restoreLibraryQueueSession,
  detachLibraryQueue: detachLibraryPlayback,
  currentTrack,
  queue,
  originalQueue,
  queueIndex,
  playMode,
  duration,
  currentTime,
  isPlaying,
  isLoading,
  sleepTimerState,
  getAppSettings: () => appSettings,
  getSleepTimerController: () => getSleepTimerController(),
  hydratePlaybackTrack,
  resetPlaybackRuntimeStateForRestore,
  setPlayModeInternal,
  loadLyricsForTrack: (track) => void lyricsLoader.ensureCurrentTrackLyricsLoaded(track),
  clearCrossfadeTimer,
  setCurrentTimeImmediate,
  clearSleepTimerIntervals: () => clearSleepTimerIntervals(),
  flushLatestCurrentTime,
  queueNativeQueueStateSync,
  deleteAutomaticLyricsBaseline: lyricsLoader.deleteLyricsBaseline,
  getRestoredPlaybackPending: () => restoredPlaybackPending,
  setRestoredPlaybackPending: (value) => {
    restoredPlaybackPending = value
  },
  getRestoredPlaybackPosition: () => restoredPlaybackPosition,
  setRestoredPlaybackPosition: (value) => {
    restoredPlaybackPosition = value
  },
  getPendingLoadStartTime: () => pendingLoadStartTime,
  setPendingLoadStartTime: (value) => {
    pendingLoadStartTime = value
  },
  getAutoAdvanceInFlight: () => autoAdvanceInFlight,
  setAutoAdvanceInFlight: (value) => {
    autoAdvanceInFlight = value
  },
  getAdvancingFromEndedTrackId: () => advancingFromEndedTrackId,
  setAdvancingFromEndedTrackId: (value) => {
    advancingFromEndedTrackId = value
  },
  getNativePlaybackActive: () => nativePlaybackActive
})
const {
  persistSelectedTrackSession,
  persistPlaybackSessionAfterQueueMutation,
  restorePlaybackSession,
  createPlaybackSession,
  removeUnavailableTracks
} = playbackSessionController

function detachLibraryPlayback(): void {
  libraryTransportIntent++
  libraryPlayModeIntent++
  requestedLibraryPlayMode = null
  const wasActive = libraryPlayback.active.value
  libraryPlayback.detach()
  if (!wasActive) return
  nativeQueueLoader.clear()
  nativeQueueRevisionFence.next()
}

function reportLibraryPlaybackError(error: unknown): void {
  setAudioEngineError(error instanceof Error ? error.message : String(error))
  isLoading.value = false
  autoAdvanceInFlight = false
  advancingFromEndedTrackId = ''
}

function invalidateLibraryTransportIntent(): number {
  activeLoadToken++
  nativeQueueRevisionFence.next()
  clearNativePlaybackInfoIntent()
  intentionalTrackGuard = null
  return ++libraryTransportIntent
}

function playLibraryWindow(result: LibraryQueuePlaybackWindow | null, positionSeconds = 0): void {
  const reference = libraryPlayback.reference()
  if (
    !result ||
    !reference ||
    reference.id !== result.queue.id ||
    reference.revision !== result.queue.revision
  )
    return
  const track = libraryPlayback.track(result)
  if (!track) return
  queue.value = []
  originalQueue.value = []
  queueIndex.value = -1
  playQueueTrack(track, positionSeconds)
  persistSelectedTrackSession()
}

/** Freeze the query in the worker. No all-track read occurs at this entry. */
async function playLibraryQuery(
  query: LibraryQuery,
  selectedId?: string,
  options: {
    positionSeconds?: number
    randomStart?: boolean
    playMode?: Exclude<PlayMode, 'heart'>
    /** Reconcile an expired derived query without replaying queue creation. */
    onQueryFailure?: (error: unknown) => void
  } = {}
): Promise<void> {
  playerSleepTimer.interruptShutdown()
  const requestedMode = options.playMode ?? requestedLibraryPlayMode ?? playMode.value
  detachLibraryPlayback()
  const intent = invalidateLibraryTransportIntent()
  exitHeartModeForManualQueueReplacement()
  endPersonalizedStream()
  resetPlaybackRuntimeStateForRestore()
  currentTrack.value = null
  isPlaying.value = false
  queue.value = []
  originalQueue.value = []
  queueIndex.value = -1
  // A mode change on an existing database source is asynchronous. Capture that
  // intent before detach, rather than creating the replacement in the old mode.
  if (requestedMode !== 'heart') setPlayModeInternal(requestedMode)
  isLoading.value = true
  try {
    const result = await libraryPlayback.create(
      query,
      selectedId,
      playMode.value,
      options.randomStart
    )
    if (intent !== libraryTransportIntent) return
    if (!result) throw new Error('未能创建本地播放队列')
    playLibraryWindow(result, options.positionSeconds)
  } catch (error) {
    if (intent === libraryTransportIntent) {
      libraryPlayback.detach()
      reportLibraryPlaybackError(error)
      options.onQueryFailure?.(error)
    }
  }
}

async function restoreLibraryQueueReference(
  queueReference: LibraryPlaybackQueueReference,
  mode: Exclude<PlayMode, 'heart'>,
  isCurrent: () => boolean,
  applySavedMode = false
) {
  libraryPlayModeIntent++
  requestedLibraryPlayMode = null
  const result = await libraryPlayback.restore(queueReference, mode, isCurrent, applySavedMode)
  if (!result || !isCurrent()) return null
  const track = libraryPlayback.track(result)
  const reference = libraryPlayback.reference()
  if (!track || !reference) return null
  // The session controller applies selection/position in the same continuation.
  // Avoid scheduling another asynchronous order edit while it restores.
  const restoredMode = libraryQueueResumeMode(result.queue, mode)
  playMode.value = restoredMode
  rendererPlayModeBoundaryPending.value = false
  return { track, reference, playMode: restoredMode }
}

async function restoreLibraryQueueSession(session: PlaybackSession, isCurrent: () => boolean) {
  if (!session.libraryQueue) return null
  const mode: Exclude<PlayMode, 'heart'> =
    session.playMode === 'heart' || !session.playMode ? 'sequential' : session.playMode
  return restoreLibraryQueueReference(session.libraryQueue, mode, isCurrent)
}

async function advanceLibraryPlayback(
  direction: 1 | -1,
  manual: boolean,
  nativeBoundaryAuthoritative = false
): Promise<void> {
  const intent = invalidateLibraryTransportIntent()
  isLoading.value = true
  clearCrossfadeTimer()
  try {
    let result = await libraryPlayback.navigate(direction, manual, playMode.value)
    if (!result || intent !== libraryTransportIntent) return
    if (result.reachedEnd && !manual) {
      if (await getSleepTimerController().reportBoundary('queueEnd', nativeBoundaryAuthoritative))
        return
      if (intent !== libraryTransportIntent) return
      if (playMode.value === 'listLoop' || playMode.value === 'shuffle') {
        result = await libraryPlayback.navigate(direction, true, playMode.value)
      }
    }
    if (intent !== libraryTransportIntent) return
    if (result?.window) playLibraryWindow(result.window)
    else {
      isPlaying.value = false
      isLoading.value = false
      autoAdvanceInFlight = false
      advancingFromEndedTrackId = ''
      stopVisualizationPolling(true)
    }
  } catch (error) {
    if (intent === libraryTransportIntent) reportLibraryPlaybackError(error)
  }
}

/** Commit the engine's incoming occurrence before autosaving or renewing its
 * current+next window. loadQueue updates preloading, never play/seek/stop. */
function acceptLibraryNativeHandoff(
  info: NativePlaybackInfo,
  previous: LibraryPlaybackQueueReference,
  entryId: string
): void {
  const loadToken = activeLoadToken
  latestLibraryHandoffInfo = info
  const request = libraryPlayback
    .acceptNative(entryId, previous, playMode.value)
    .then(async (result) => {
      if (!result || loadToken !== activeLoadToken || !libraryPlayback.active.value) return
      if (!nativeQueueLoader.rebaseLibraryCursor(previous, result.queue)) return
      const incoming = latestLibraryHandoffInfo ?? info
      libraryNativeHandoff = null
      latestLibraryHandoffInfo = null
      clearNativePlaybackInfoIntent()
      intentionalTrackGuard = null
      applyNativePlaybackInfo(incoming, { applyTrackWhenInactive: true })
      persistSelectedTrackSession()
      await queueNativeQueueStateSync()
    })
    .catch((error) => {
      if (loadToken === activeLoadToken && libraryPlayback.active.value)
        reportLibraryPlaybackError(error)
    })
    .finally(() => {
      if (libraryNativeHandoff === request) {
        libraryNativeHandoff = null
        latestLibraryHandoffInfo = null
      }
    })
  libraryNativeHandoff = request
}

const playerSleepTimer = createPlayerSleepTimer({
  volume,
  muted,
  isPlaying,
  isLoading,
  state: sleepTimerState,
  notice: sleepTimerNotice,
  getSettings: () => useSettingsStore().settings.value.sleepTimer,
  getBridge: () => window.api?.sleepTimer,
  persistSession: persistSelectedTrackSession,
  clearCrossfade: () => clearCrossfadeTimer(),
  stopVisualization: () => stopVisualizationPolling(true),
  stopRendererAudio: () => stopRendererAudio(false),
  stopNativeAudio
})

const {
  clearIntervals: clearSleepTimerIntervals,
  getController: getSleepTimerController,
  configure: configureSleepTimer,
  cancel: cancelSleepTimer
} = playerSleepTimer

function toggleMute(): void {
  const next = toggleVolumeMute({
    volume: volume.value,
    muted: muted.value,
    lastAudibleVolume: lastAudibleVolume.value
  })
  volume.value = next.volume
  muted.value = next.muted
  lastAudibleVolume.value = next.lastAudibleVolume
}

function shouldUseNativePlayback(track: Track, target: string): boolean {
  return shouldUseNativePlaybackTarget(getTrackSource(track), target)
}

function isNativeQueueDelegated(): boolean {
  return nativeQueueDelegated && !nativeQueueAdoptionUncertain
}

async function createPlayableUrl(
  target: string,
  track: Track,
  loadToken: number
): Promise<string | null> {
  // http(s)/blob/data stream directly. twilight-media:// is the granted proxy
  // scheme registered in main (protocol.handle) and allowed by media-src CSP.
  if (
    /^https?:\/\//i.test(target) ||
    /^blob:/i.test(target) ||
    /^data:/i.test(target) ||
    /^twilight-media:/i.test(target)
  ) {
    if (!isActiveLoad(loadToken, track)) return null
    releasePlaybackObjectUrl()
    return target
  }

  const fileUrl = await window.api.fs.getAudioFileUrl(target)
  if (!isActiveLoad(loadToken, track)) return null
  releasePlaybackObjectUrl()
  if (!duration.value && track.duration) {
    duration.value = track.duration
  }
  return fileUrl
}

async function playWithRendererAudio(
  track: Track,
  target: string,
  startTime: number,
  loadToken: number
): Promise<boolean> {
  const audio = getPlaybackAudio()
  rendererPauseFadeController.cancel()
  audio.pause()
  // Renderer HTMLAudio is a shared-mode Windows stream. Never start it while the
  // native engine (e.g. WASAPI Exclusive) could still be playing, or the same
  // track is heard twice. Stopping is a cheap no-op when native is already idle.
  await stopNativeAudio()
  if (!isActiveLoad(loadToken, track)) return false

  const playableUrl = await createPlayableUrl(target, track, loadToken)
  if (!playableUrl || !isActiveLoad(loadToken, track)) return false

  audio.src = playableUrl
  audio.volume = volume.value
  applyPlaybackRateToHtmlAudio(audio)
  if (!isActiveLoad(loadToken, track)) return false

  seekRendererAudioWhenReady(audio, startTime, track, loadToken)
  if (!isActiveLoad(loadToken, track)) return false

  try {
    await audio.play()
  } catch (err) {
    if (!isActiveLoad(loadToken, track)) return false

    await new Promise((resolve) => window.setTimeout(resolve, 140))
    if (!isActiveLoad(loadToken, track)) return false

    try {
      await audio.play()
    } catch {
      console.error('[audio-engine] Renderer audio play failed:', {
        message: err instanceof Error ? err.message : String(err),
        src: audio.src ? audio.src.slice(0, 120) : ''
      })
      throw err
    }
  }

  return isActiveLoad(loadToken, track)
}

async function persistAudioProcessingFallback(
  nextSettings: AudioProcessingSettings,
  reason: unknown
): Promise<void> {
  setAudioEngineError(reason instanceof Error ? reason.message : String(reason))
  try {
    const savedSettings = await updateSettings({ audioProcessing: nextSettings })
    audioProcessing.value = cloneAudioProcessingSettings(savedSettings.audioProcessing)
  } catch (err) {
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    console.error('[audio-engine] Failed to persist audio processing fallback:', err)
  }
}

function findLibraryTrackHint(track: Track, _libraryHint?: Track | null): Track | null {
  if (libraryPlayback.active.value) return null
  // Always resolve from the real library. Callers used to pass the queue row as
  // libraryHint, which short-circuited lookup and left lyrics:null / stale cover
  // forever (queue snapshots intentionally strip lyrics). O(1) via trackById —
  // never linear-scan tracks on the switch hot path (freezes PlayingMusic).
  return useMusicStore().getTrackById(track.id) ?? null
}

let databaseHydrationRequest = 0

/**
 * SQLite rows are deliberately not retained in the renderer's legacy library
 * array. Hydrate only the active local row after a queue snapshot is adopted;
 * the request is fenced by activation and occurrence identity so a late reply
 * cannot repaint a newer track.
 */
function hydrateActiveTrackFromDatabase(track: Track): void {
  if (libraryPlayback.active.value || getTrackSource(track) !== 'local') return
  const request = ++databaseHydrationRequest
  const queueEntryId = track.queueEntryId
  void (async () => {
    try {
      if ((await window.api.library.getStorageMode()) !== 'sqlite') return
      const page = await window.api.library.database.getTracksByIds([track.id])
      const record = page.tracks.find((item) => item.id === track.id)
      if (!record || request !== databaseHydrationRequest) return
      const active = currentTrack.value
      if (!active || active.id !== track.id || active.queueEntryId !== queueEntryId) return
      const next = hydratePlaybackTrack(active, libraryTrack(record))
      if (next === active) return
      currentTrack.value = { ...next }
      lastActiveTrack = currentTrack.value
      if (!libraryPlayback.active.value) patchTrackInQueues(next)
    } catch {
      // Database hydration is an enhancement; the queue snapshot remains
      // playable and the lyrics loader still provides its normal fallback.
    }
  })()
}

/**
 * Hydrate a queue/session snapshot for the active currentTrack.
 * Queue rows intentionally strip lyrics (memory) and may lose cover after
 * restore; never inherit cover/lyrics from a *different* previous track id.
 */
function hydratePlaybackTrack(track: Track, libraryHint?: Track | null): Track {
  const hint = libraryHint ?? findLibraryTrackHint(track)
  const cover = nonEmptyString(track.cover) || nonEmptyString(hint?.cover)
  const coverSource = nonEmptyString(track.coverSource) || nonEmptyString(hint?.coverSource)
  // Queue snapshots force lyrics: null — restore embedded library lyrics so
  // PlayingMusic does not blank until (or unless) async re-resolution finishes.
  const lyrics = nonEmptyString(track.lyrics) || nonEmptyString(hint?.lyrics)
  const translatedLyrics =
    nonEmptyString(track.translatedLyrics) || nonEmptyString(hint?.translatedLyrics)
  const romanizedLyrics =
    nonEmptyString(track.romanizedLyrics) || nonEmptyString(hint?.romanizedLyrics)
  const fallbackLyricsSource: LyricSource =
    getTrackSource(track) === 'ncm' ? 'provider' : 'embedded'
  const lyricsSource =
    track.lyricsSource ?? hint?.lyricsSource ?? (lyrics ? fallbackLyricsSource : null)
  const translatedLyricsSource =
    track.translatedLyricsSource ??
    hint?.translatedLyricsSource ??
    (translatedLyrics ? fallbackLyricsSource : null)
  const romanizedLyricsSource =
    track.romanizedLyricsSource ??
    hint?.romanizedLyricsSource ??
    (romanizedLyrics ? fallbackLyricsSource : null)

  if (
    cover === (track.cover ?? null) &&
    coverSource === (track.coverSource ?? null) &&
    lyrics === (track.lyrics ?? null) &&
    translatedLyrics === (track.translatedLyrics ?? null) &&
    romanizedLyrics === (track.romanizedLyrics ?? null) &&
    lyricsSource === (track.lyricsSource ?? null) &&
    translatedLyricsSource === (track.translatedLyricsSource ?? null) &&
    romanizedLyricsSource === (track.romanizedLyricsSource ?? null)
  ) {
    return track
  }

  return {
    ...track,
    cover,
    coverSource,
    lyrics,
    translatedLyrics,
    romanizedLyrics,
    lyricsSource,
    translatedLyricsSource,
    romanizedLyricsSource
  }
}

function activateCurrentTrack(
  track: Track,
  options: { resetUi?: boolean; position?: number } = {}
): void {
  const next = hydratePlaybackTrack(track)
  const previousTrack = currentTrack.value
  if (
    previousTrack &&
    (previousTrack.id !== next.id || previousTrack.queueEntryId !== next.queueEntryId)
  ) {
    // Selection replaces the active track and resets its clock before load.
    // Capture the departing occurrence while its last position still belongs to it.
    playbackHistoryController.recordTrackDeparture(previousTrack)
  }
  // Fresh object every activation so cover/lyrics watchers always rebind.
  currentTrack.value = { ...next }
  loadedTrackId = next.id
  lastActiveTrack = currentTrack.value
  if (options.resetUi !== false) {
    resetPlaybackUiForTrackSwitch(next, options.position ?? 0)
  }
  hydrateActiveTrackFromDatabase(next)
  // Queue snapshots strip lyrics — always re-resolve for the active track.
  void lyricsLoader.ensureCurrentTrackLyricsLoaded(currentTrack.value, true)
}

/**
 * Re-apply library cover/lyrics onto the active track + queue after the library
 * finishes loading (session restore often runs before loadLibrary completes).
 */
function rehydrateCurrentTrackFromLibrary(): void {
  const active = currentTrack.value
  if (active) {
    const next = hydratePlaybackTrack(active)
    if (
      next.cover !== active.cover ||
      next.coverSource !== active.coverSource ||
      next.lyrics !== active.lyrics ||
      next.translatedLyrics !== active.translatedLyrics
    ) {
      currentTrack.value = { ...next }
      lastActiveTrack = currentTrack.value
    }
    if (currentTrack.value) hydrateActiveTrackFromDatabase(currentTrack.value)
  }

  const musicStore = useMusicStore()
  const patchRow = (row: Track): Track => {
    const library = musicStore.getTrackById(row.id)
    if (!library) return row
    const cover = nonEmptyString(row.cover) || nonEmptyString(library.cover)
    const coverSource = nonEmptyString(row.coverSource) || nonEmptyString(library.coverSource)
    if (cover === (row.cover ?? null) && coverSource === (row.coverSource ?? null)) return row
    return { ...row, cover, coverSource }
  }
  queue.value = queue.value.map(patchRow)
  originalQueue.value = originalQueue.value.map(patchRow)
}

function patchTrackInQueues(updatedTrack: Track): void {
  queue.value = patchPlaybackQueueTrack(queue.value, updatedTrack)
  originalQueue.value = patchPlaybackQueueTrack(originalQueue.value, updatedTrack)
}

function findTrackIndexFromPlaybackInfo(info: NativePlaybackInfo): number {
  if (libraryPlayback.active.value) {
    const reference = libraryPlayback.reference()
    return reference ? (nativeQueueLoader.findLibraryEntry(info, reference)?.index ?? -1) : -1
  }
  const logicalIndex =
    playMode.value !== 'heart' ? nativeQueueLoader.findLogicalIndex(info, queue.value) : -1
  if (logicalIndex >= 0) return logicalIndex
  const mappedTrackId =
    typeof info.source === 'string' && info.source.length > 0
      ? nativeSourceToTrackId.get(info.source)
      : undefined
  return findNativeQueueTrackIndex(
    queue.value,
    queueIndex.value,
    info,
    mappedTrackId,
    nativeQueueDelegated && nativeQueueSyncRequest === null
  )
}

function isCurrentTrackNativePlaybackInfo(info: NativePlaybackInfo): boolean {
  if (libraryPlayback.active.value) {
    const reference = libraryPlayback.reference()
    const entry = reference ? nativeQueueLoader.findLibraryEntry(info, reference) : null
    return !!entry && entry.queueEntryId === currentTrack.value?.queueEntryId
  }
  const index = nativeQueueLoader.findLogicalIndex(info, queue.value)
  const track = currentTrack.value
  return (
    !!track &&
    index >= 0 &&
    index === queueIndex.value &&
    queue.value[index]?.id === track.id &&
    (!track.queueEntryId || queue.value[index]?.queueEntryId === track.queueEntryId)
  )
}

function clearNativeStreamBufferingTimer(): void {
  if (nativeStreamBufferingClearTimer) {
    clearTimeout(nativeStreamBufferingClearTimer)
    nativeStreamBufferingClearTimer = null
  }
}

/** Reset native underrun-derived LIVE buffering UX (load/stop/error). */
function resetNativeStreamBufferingState(): void {
  clearNativeStreamBufferingTimer()
  lastNativeSessionUnderrunCount = 0
  isStreamBuffering.value = false
}

/**
 * Map native output underrun counters onto isStreamBuffering for LIVE/stream tracks.
 * Sticky for 1.5s so single xruns don't flicker the badge; no engine ABI change.
 */
function applyNativeStreamBufferingFromInfo(info: NativePlaybackInfo): void {
  if (!nativePlaybackActive) return
  const track = currentTrack.value
  if (!isStreamLikeTrack(track)) {
    lastNativeSessionUnderrunCount = 0
    clearNativeStreamBufferingTimer()
    return
  }
  const underruns = Number(
    info.diagnostics?.sessionUnderrunCount ??
      info.outputInfo?.diagnostics?.sessionUnderrunCount ??
      0
  )
  if (!Number.isFinite(underruns) || underruns < 0) return
  if (underruns > lastNativeSessionUnderrunCount) {
    isStreamBuffering.value = true
    clearNativeStreamBufferingTimer()
    // Sticky briefly so the LIVE badge doesn't flicker on single xruns.
    nativeStreamBufferingClearTimer = setTimeout(() => {
      isStreamBuffering.value = false
      nativeStreamBufferingClearTimer = null
    }, 1500)
  }
  lastNativeSessionUnderrunCount = underruns
  if (info.state === 'stopped' || info.state === 'paused') {
    clearNativeStreamBufferingTimer()
    isStreamBuffering.value = false
  }
}

/**
 * Reset playbar progress / A-B when the active track identity changes without
 * going through loadAndPlay (native gapless, delegated queue next, start-file).
 */
function resetPlaybackUiForTrackSwitch(track: Track | null, position = 0): void {
  clearAbLoop()
  pendingLoadStartTime = 0
  duration.value = track ? cueDuration(track) : 0
  beginPlaybackPositionTransition(position, { keepRendererClockAlive: true })
}

function applyNativePlaybackInfo(
  info: NativePlaybackInfo,
  options: { applyTrackWhenInactive?: boolean } = {}
): boolean {
  if (nativeQueueAdoptionUncertain) return false
  if (!currentTrack.value || (restoredPlaybackPending && !nativePlaybackActive && !isLoading.value))
    return false
  if (libraryPlayback.active.value) {
    const reference = libraryPlayback.reference()
    const entry = reference ? nativeQueueLoader.findLibraryEntry(info, reference) : null
    if (!reference || !entry) return false
    if (libraryNativeHandoff) {
      if (entry.queueEntryId !== reference.entryId) latestLibraryHandoffInfo = info
      return false
    }
    if (entry.queueEntryId !== reference.entryId) {
      if (
        libraryPlayback.window.value?.items.some((item) => item.queueEntryId === entry.queueEntryId)
      ) {
        acceptLibraryNativeHandoff(info, reference, entry.queueEntryId)
      }
      return false
    }
  }
  const preserveRestoredPosition = restoredPlaybackPending && isLoading.value
  const infoIndex = findTrackIndexFromPlaybackInfo(info)
  if (shouldIgnoreNativePlaybackInfo(info, infoIndex)) return false

  const normalizedInfo = normalizeNativePlaybackInfo(info)
  playbackInfo.value = normalizedInfo
  if (typeof (info as { streamTitle?: string }).streamTitle === 'string') {
    streamNowPlaying.value = (info as { streamTitle?: string }).streamTitle?.trim() ?? ''
  }
  // Promote nativePlaybackActive when the engine confirms it, but never demote
  // it from a transient/stale snapshot while we still believe native is active.
  // Demoting here drops time-pos updates and freezes the playbar until pause
  // forces a full playback-info sync.
  if (info.nativePlaybackActive === true) {
    nativePlaybackActive = true
  } else if (
    info.nativePlaybackActive === false &&
    playbackToggleIntent?.playing !== true &&
    (info.state === 'stopped' || (!isPlaying.value && !isLoading.value))
  ) {
    nativePlaybackActive = false
  }
  if (!nativePlaybackActive && !options.applyTrackWhenInactive) return true

  const previousQueueIndex = libraryPlayback.reference()?.index ?? queueIndex.value
  const previousTrackId = currentTrack.value?.id ?? loadedTrackId
  let switchedTrack = false

  if (infoIndex >= 0) {
    const libraryEntry = libraryPlayback.active.value
      ? libraryPlayback.window.value?.items.find((item) => item.position === infoIndex)
      : null
    const track = libraryEntry?.track
      ? libraryQueueTrack(libraryEntry.track, libraryEntry.queueEntryId)
      : queue.value[infoIndex]
    if (!track) return false
    // Treat queue-index changes as a switch even when consecutive CUE/logical
    // entries share metadata, so cover + progress always rebind.
    switchedTrack =
      previousTrackId !== track.id ||
      previousQueueIndex !== infoIndex ||
      loadedTrackId !== track.id ||
      currentTrack.value?.queueEntryId !== track.queueEntryId
    const mergedTrack = mergeTrackTransientData(track, currentTrack.value)
    if (!libraryPlayback.active.value) queueIndex.value = infoIndex
    const snapshot = { ...toPlaybackQueueSnapshot(mergedTrack), queueEntryId: track.queueEntryId }
    if (
      !libraryPlayback.active.value &&
      (Object.keys(snapshot) as Array<keyof Track>).some((key) => snapshot[key] !== track[key])
    ) {
      queue.value = queue.value.map((item, index) => (index === infoIndex ? snapshot : item))
    }
    // Always assign a fresh object on switch so cover/title/lyrics watchers and
    // PlayerBar remount keys fire even when the queue snapshot is referentially
    // stable (same album handle, gapless hand-off, delegated next).
    if (switchedTrack) {
      // Hydrate from library (not the queue row) so embedded cover/lyrics return
      // after queue snapshots stripped them. Never inherit previous track fields.
      // Keep lyrics null so the now-playing column stays in loading reserve until
      // ensureCurrentTrackLyricsLoaded commits '' or real text for this id.
      const hydrated = hydratePlaybackTrack({
        ...mergedTrack,
        cover: nonEmptyString(track.cover) || nonEmptyString(mergedTrack.cover),
        coverSource: nonEmptyString(track.coverSource) || nonEmptyString(mergedTrack.coverSource),
        lyrics: null,
        translatedLyrics: null,
        romanizedLyrics: null
      })
      currentTrack.value = { ...hydrated }
      lastActiveTrack = currentTrack.value
      // Some native playback fixtures evaluate this hot-path function in
      // isolation; database hydration is optional there and never gates audio.
      if (typeof hydrateActiveTrackFromDatabase === 'function')
        hydrateActiveTrackFromDatabase(currentTrack.value)
      // Native gapless / delegated next skips activateCurrentTrack — still load lyrics.
      void lyricsLoader.ensureCurrentTrackLyricsLoaded(currentTrack.value, true)
    } else {
      currentTrack.value = mergedTrack
      lastActiveTrack = mergedTrack
    }
    loadedTrackId = mergedTrack.id
  }

  const nextDuration =
    Number.isFinite(info.duration) && info.duration > 0
      ? info.duration
      : currentTrack.value
        ? cueDuration(currentTrack.value)
        : 0

  const nextPosition = Number.isFinite(info.position)
    ? Math.max(0, info.position)
    : switchedTrack
      ? 0
      : getLatestPlaybackTime()

  if (switchedTrack) {
    // Native gapless / queue next does not go through loadAndPlay — clear A-B and
    // reset duration/time so the playbar cover + progress do not stick on the previous track.
    clearAbLoop()
    pendingLoadStartTime = 0
    duration.value =
      nextDuration > 0 ? nextDuration : currentTrack.value ? cueDuration(currentTrack.value) : 0
    beginPlaybackPositionTransition(nextPosition, { keepRendererClockAlive: true })
    // Native handoffs also need a short guard against delayed outgoing snapshots.
    if (!nativePlaybackInfoIntent && currentTrack.value) {
      setNativePlaybackInfoIntent(activeLoadToken, currentTrack.value, info.source, infoIndex)
    }
    markNativePlaybackInfoIntentConfirmed()
  } else {
    if (nextDuration > 0) {
      duration.value = nextDuration
    }
    applyPlaybackPositionSample(nextPosition, 'native-info')
  }

  applyNativePlayingState(
    normalizedInfo.state === 'playing',
    normalizedInfo.state === 'paused' ? nextPosition : null
  )
  applyNativeStreamBufferingFromInfo(normalizedInfo)
  if (normalizedInfo.state === 'playing' && currentTrack.value) {
    playbackHistoryController.recordPlaybackStart(
      currentTrack.value,
      playMode.value,
      nativeHistoryRestartPending
    )
    nativeHistoryRestartPending = false
  }
  isLoading.value = false
  autoAdvanceInFlight = false
  advancingFromEndedTrackId = ''
  if (!preserveRestoredPosition) {
    restoredPlaybackPending = false
    restoredPlaybackPosition = 0
  }
  scheduleCrossfadeIfNeeded()
  return true
}

interface NativeQueueStateSnapshot {
  revision: number
  queue: Track[]
  current: Track | null
  currentIndex: number
  playMode: PlayMode
  libraryQueue?: LibraryPlaybackQueueReference
}

function captureNativeQueueState(revision: number): NativeQueueStateSnapshot {
  return {
    revision,
    queue: queue.value,
    current: currentTrack.value ? toPlaybackQueueSnapshot(currentTrack.value) : null,
    currentIndex: queueIndex.value,
    playMode: playMode.value,
    ...(libraryPlayback.reference() ? { libraryQueue: libraryPlayback.reference()! } : {})
  }
}

async function syncNativeQueueState(snapshot: NativeQueueStateSnapshot): Promise<void> {
  if (!nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
  const active = currentTrack.value
  const selected = snapshot.current
  // Preserve the request's cursor: next/previous may already have advanced
  // the UI. Only refresh a URL resolved while waiting for this same occurrence.
  const current =
    selected && active?.id === selected.id && active.queueEntryId === selected.queueEntryId
      ? {
          ...selected,
          streamUrl: active.streamUrl,
          streamQuality: active.streamQuality,
          filePath: active.filePath
        }
      : selected
  if (!current) {
    if (!nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
    await stopNativeAudio()
    return
  }

  if (snapshot.libraryQueue) {
    const reference = libraryPlayback.reference()
    if (
      !reference ||
      reference.id !== snapshot.libraryQueue.id ||
      reference.revision !== snapshot.libraryQueue.revision
    )
      return
    const playbackWindow = await libraryPlayback.playbackWindow(current, snapshot.playMode)
    if (!playbackWindow || !nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
    const prepared = await preparePlayerNativeQueue(
      libraryNativeQueueOptions(
        playbackWindow,
        current,
        getTrackAudioSource(current),
        snapshot.playMode
      ),
      {
        isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized,
        areAudioFilesAuthorized: window.api.fs.areAudioFilesAuthorized
      }
    )
    if (!prepared || !nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
    await nativeQueueLoader.loadPrepared(prepared, window.api.audioEngine)
    nativeQueueAdoptionUncertain = false
    if (!nativeQueueRevisionFence.isCurrent(snapshot.revision)) return
    await window.api.audioEngine.setPlayMode(preparedNativePlayMode(prepared, snapshot.playMode))
    nativeQueueDelegated = false
    return
  }

  const heartModeActive = snapshot.playMode === 'heart'
  const synchronized = await synchronizeLatestNativeQueue(
    nativeQueueRevisionFence,
    snapshot.revision,
    {
      prepare: () =>
        preparePlayerNativeQueue(
          {
            // 心动模式由渲染层管理智能列表与边界续播，原生引擎只加载当前曲目，
            // 避免原生引擎在列表耗尽时静默停止而无法触发渲染层补拉。
            queue: stripStaleNcmStreamUrls(heartModeActive ? [current] : snapshot.queue, {
              committedAtByTrackId: ncmStreamUrlCommittedAt,
              quality: appSettings.value.ncmPlaybackQuality
            }),
            currentTrack: current,
            currentTarget: getTrackAudioSource(current),
            currentIndex: heartModeActive ? 0 : snapshot.currentIndex,
            playMode: snapshot.playMode
          },
          {
            isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized,
            areAudioFilesAuthorized: window.api.fs.areAudioFilesAuthorized
          }
        ),
      loadQueue: (preparedQueue) =>
        nativeQueueLoader.loadPrepared(preparedQueue, window.api.audioEngine, snapshot.queue),
      setPlayMode: (preparedQueue) =>
        window.api.audioEngine.setPlayMode(preparedNativePlayMode(preparedQueue, snapshot.playMode))
    }
  )
  if (!synchronized.applied) return
  if (synchronized.loadQueueError) {
    console.warn(
      '[audio-engine] Native queue resynchronization failed:',
      synchronized.loadQueueError
    )
    throw synchronized.loadQueueError
  }
  const preparedQueue = synchronized.prepared
  if (preparedQueue) nativeQueueAdoptionUncertain = false
  if (preparedQueue) pruneNativeSourceToTrackId(preparedQueue.items, getTrackAudioSource(current))
  if (!preparedQueue) {
    // 不要因为队列重同步失败就停掉正在播放的引擎：停止会让主进程误判
    // “播放结束”（单曲队列 queueIndex>=len-1 恒真）→ 渲染层自动切歌/重播。
    // 保持现有播放不变，让 loadAndPlay 走正常的“不可用→回退”路径。
    return
  }
  nativeQueueDelegated = heartModeActive ? false : preparedQueue.delegated
}

function trackNativeQueueSyncRequest(request: Promise<void>): Promise<void> {
  nativeQueueSyncRequest = request
  const clearRequest = (): void => {
    if (nativeQueueSyncRequest === request) {
      nativeQueueSyncRequest = null
    }
  }
  void request.then(clearRequest, clearRequest)
  return request
}

function queueNativeQueueStateSync(): Promise<void> {
  const revision = nativeQueueRevisionFence.next()
  const snapshot = captureNativeQueueState(revision)
  const request = nativeQueueRevisionFence.serialize(() => syncNativeQueueState(snapshot))
  return trackNativeQueueSyncRequest(request)
}

function queueNativePlayModeSync(mode: PlayMode): Promise<void> {
  const loadToken = activeLoadToken
  const request = nativeQueueRevisionFence.serialize(async () => {
    if (loadToken !== activeLoadToken || mode !== playMode.value) return
    await window.api.audioEngine.setPlayMode(nativeQueueLoader.playMode(mode))
  })
  return trackNativeQueueSyncRequest(request)
}

async function waitForNativeQueueStateSync(): Promise<void> {
  const request = nativeQueueSyncRequest
  if (request) {
    await request
  }
}

function getNativeQueueAdvanceTarget(
  direction: 'next' | 'previous'
): { track: Track; queueIndex: number } | null {
  if (queue.value.length === 0) return null

  const currentQueueIndex =
    queueIndex.value >= 0 && queueIndex.value < queue.value.length
      ? queueIndex.value
      : Math.max(
          0,
          queue.value.findIndex((track) => track.id === currentTrack.value?.id)
        )
  const targetQueueIndex =
    direction === 'next'
      ? (currentQueueIndex + 1) % queue.value.length
      : (currentQueueIndex - 1 + queue.value.length) % queue.value.length
  const track = queue.value[targetQueueIndex]
  return track ? { track, queueIndex: targetQueueIndex } : null
}

async function advanceNativePlayback(direction: 'next' | 'previous'): Promise<void> {
  const loadToken = ++activeLoadToken
  const isCurrentAdvance = () => loadToken === activeLoadToken
  // Drop any pending pause/play grace — a track switch is a new transport action
  // and must not be blocked by a prior pause intent (UI stuck paused while audio
  // already advanced).
  const wasPlaying = isPlaying.value
  clearPlaybackToggleIntent()

  // The native queue mirrors the renderer's queue order in every mode now
  // (shuffle is applied by the renderer before the queue is handed over), so the
  // adjacent item is a safe prediction and shuffle keeps the optimistic UI too.
  const target = getNativeQueueAdvanceTarget(direction)
  if (target) {
    // Optimistic UI update so cover/title/progress reset immediately instead of
    // waiting for (or missing) the first native playback-info event.
    queueIndex.value = target.queueIndex
    activateCurrentTrack(target.track, { resetUi: true, position: 0 })
    setNativePlaybackInfoIntent(
      activeLoadToken,
      target.track,
      getTrackAudioSource(target.track),
      target.queueIndex
    )
  } else {
    clearNativePlaybackInfoIntent()
  }
  stopVisualizationPolling(false)
  try {
    isLoading.value = true
    await waitForNativeQueueStateSync()
    if (!isCurrentAdvance()) return
    if (direction === 'next') {
      await window.api.audioEngine.next()
    } else {
      await window.api.audioEngine.previous()
    }
    if (!isCurrentAdvance()) return
    await new Promise((resolve) =>
      window.setTimeout(resolve, NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS)
    )
    if (!isCurrentAdvance()) return
    let info = await window.api.audioEngine.getPlaybackInfo()
    if (!isCurrentAdvance()) return
    let applied = applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    if (!applied) {
      await new Promise((resolve) =>
        window.setTimeout(resolve, NATIVE_PLAYBACK_INFO_REFRESH_DELAY_MS)
      )
      if (!isCurrentAdvance()) return
      info = await window.api.audioEngine.getPlaybackInfo()
      if (!isCurrentAdvance()) return
      applied = applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    }
    if (!applied) {
      // Keep optimistic track metadata; force a full load if native did not confirm.
      // loadAndPlay manages nativePlaybackActive — do not demote it here or the
      // playbar will ignore time-pos until the next pause/play handshake.
      const track = currentTrack.value
      if (track) {
        await loadAndPlay(track)
      }
      return
    }

    const track = currentTrack.value
    if (track && info.state !== 'playing') {
      // Paused engine after next/previous: start the new track. loadAndPlay also
      // clears any residual pause intent and sets isPlaying.
      await loadAndPlay(track)
      return
    }

    // Engine already playing the new track — mirror that into UI even when the
    // user was paused (native next often auto-starts) or a stale pause intent
    // would have blocked applyNativePlayingState.
    if (info.state === 'playing' || wasPlaying) {
      clearPlaybackToggleIntent()
      isPlaying.value = true
      if (info.nativePlaybackActive === true || nativeQueueDelegated) {
        nativePlaybackActive = true
      }
      isLoading.value = false
    } else {
      isLoading.value = false
    }
  } catch (err) {
    if (!isCurrentAdvance()) return
    clearNativePlaybackInfoIntent()
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    console.error('[音频引擎] 切换歌曲失败:', err)
    isLoading.value = false
  } finally {
    if (isCurrentAdvance() && isPlaying.value && currentTrack.value) startVisualizationPolling()
  }
}

async function persistSoftwareVolume(val: number): Promise<void> {
  if (!settingsLoaded.value) return
  const next = Math.min(
    clampSoftwareVolume(val),
    appSettings.value.audioDeviceProfiles.volumeCeiling
  )
  const saved = clampSoftwareVolume(
    typeof appSettings.value?.softwareVolume === 'number'
      ? appSettings.value.softwareVolume
      : DEFAULT_SOFTWARE_VOLUME
  )
  if (Math.abs(saved - next) < 0.0005) return
  await updateSettings({ softwareVolume: next })
}

const softwareVolumePersistence = createDebouncedVolumePersistence(persistSoftwareVolume)

function scheduleSoftwareVolumePersist(val: number): void {
  if (settingsLoaded.value && !suppressVolumePersist) softwareVolumePersistence.schedule(val)
}

async function flushSoftwareVolumePersist(): Promise<void> {
  if (!settingsLoaded.value || suppressVolumePersist) return
  try {
    await softwareVolumePersistence.flush(volume.value)
  } catch (err) {
    console.error('[音频引擎] 保存软件音量失败:', err)
    throw err
  }
}

function syncSoftwareVolumeToEngine(): void {
  // Engine ready can precede settings hydration. Its volume IPC also persists
  // the value, so sending the temporary 70% default would overwrite the saved volume.
  if (!settingsLoaded.value) return
  window.api.audioEngine.setVolume(volume.value).catch(() => {})
}

watch(volume, (val) => {
  const limited = Math.min(
    clampSoftwareVolume(val),
    appSettings.value.audioDeviceProfiles.volumeCeiling
  )
  if (limited !== val) {
    volume.value = limited
    return
  }
  if (val > 0) {
    lastAudibleVolume.value = val
    muted.value = false
  }
  if (playbackAudio) playbackAudio.volume = val
  rendererPauseFadeController.syncVolume()
  syncSoftwareVolumeToEngine()
  if (castTargetName.value) {
    void window.api.remote?.controlCast?.({ volume: val }).catch(() => {})
  }
  scheduleSoftwareVolumePersist(val)
})

function applyPlaybackRateToHtmlAudio(audio: HTMLAudioElement, rate = playbackRate.value): void {
  audio.playbackRate = rate
  try {
    audio.preservesPitch = true
  } catch {
    // preservesPitch is not available on every runtime.
  }
  try {
    ;(audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
  } catch {
    // Safari-style property; ignore when unsupported.
  }
}

async function setPlaybackRate(rate: number): Promise<void> {
  const clamped = Math.min(2, Math.max(0.5, Number.isFinite(rate) ? rate : 1))
  const rounded = Math.round(clamped * 1000) / 1000
  if (Object.is(rounded, playbackRate.value)) return
  playbackRate.value = rounded
  publishPlaybackClockTransport(playbackClockSnapshot.value.state, rounded)
  if (playbackAudio) applyPlaybackRateToHtmlAudio(playbackAudio, rounded)
  window.api.audioEngine.setPlaybackRate(rounded).catch(() => {})
  // Remember podcast speed preference when the user changes rate while on a podcast.
  if (currentTrack.value?.source === 'podcast') {
    setPodcastDefaultPlaybackRate(rounded)
  }
}

watch(
  [
    () => currentTrack.value?.id,
    () => currentTrack.value?.cover,
    () => currentTrack.value?.coverSource,
    () => appSettings.value?.useCoverTheme
  ],
  async ([trackId, cover, coverSource, useCoverTheme]) => {
    const requestId = ++dominantColorRequestId
    const identity = `${trackId ?? 'none'}:${cover ?? ''}:${coverSource ?? ''}`
    themeCoverIdentity.value = identity

    if (cover || coverSource) {
      const displayCover = await resolveCover(cover, coverSource)
      if (
        requestId !== dominantColorRequestId ||
        currentTrack.value?.id !== trackId ||
        currentTrack.value?.cover !== cover ||
        currentTrack.value?.coverSource !== coverSource
      ) {
        return
      }
      if (displayCover) {
        themeCoverUrl.value = displayCover
        const extracted = await extractDominantColor(displayCover)
        if (
          requestId !== dominantColorRequestId ||
          currentTrack.value?.id !== trackId ||
          currentTrack.value?.cover !== cover ||
          currentTrack.value?.coverSource !== coverSource
        ) {
          return
        }
        coverThemeColor.value = extracted
        dominantColor.value = useCoverTheme ? extracted : '#7c4dff'
      } else {
        themeCoverUrl.value = ''
        coverThemeColor.value = '#1a73e8'
        dominantColor.value = useCoverTheme ? '#1a73e8' : '#7c4dff'
      }
    } else {
      themeCoverUrl.value = ''
      coverThemeColor.value = '#1a73e8'
      dominantColor.value = useCoverTheme ? '#1a73e8' : '#7c4dff'
    }
  }
)

watch(
  () => appSettings.value?.audioOutputConfig,
  (config) => {
    audioOutputConfig.value = normalizeOutputConfig(config, 32768)
  },
  { deep: true, immediate: true }
)
watch(
  () => currentTrack.value?.id,
  async (id, prevId) => {
    const track = currentTrack.value
    if (!track || track.id !== id) return
    // Only on track identity change. Field-level watches re-entered with
    // allowProviderLookup=false after partial writes and could leave blank lyrics.
    if (id === prevId) return
    await lyricsLoader.ensureCurrentTrackLyricsLoaded(track, true)
  }
)

const cleanupFns: (() => void)[] = []
cleanupFns.push(onLocalTracksRemovalRequested(prepareLocalTracksForRemoval))
let listenersSetup = false
let crossfadeTimer: number | null = null
let crossfadeTrackId = ''
let advancingFromEndedTrackId = ''
let autoAdvanceInFlight = false
let loadedTrackId = ''
/** Last track that successfully entered the playing pipeline (identity for resume bookmarks). */
let lastActiveTrack: Track | null = null
let restoredPlaybackPending = false
let restoredPlaybackPosition = 0
let pendingLoadStartTime = 0
/**
 * Set once a recreated renderer adopted live engine state after Afterglow.
 * Startup must not replay persisted volume/rate over the running host.
 */
let adoptedAfterglowRestore = false

const ADOPTED_PLAY_MODES: readonly PlayMode[] = [
  'sequential',
  'listLoop',
  'repeat',
  'shuffle',
  'heart'
]

const normalizeAdoptedPlayMode = (value: string): PlayMode =>
  (ADOPTED_PLAY_MODES as readonly string[]).includes(value) ? (value as PlayMode) : 'sequential'
let nativeQueueSyncRequest: Promise<void> | null = null
let nativeHistoryRestartPending = false
const rendererPlayModeBoundaryPending = ref(false)
let dominantColorRequestId = 0

const playbackQueueController = createPlaybackQueueController({
  currentTrack,
  queue,
  originalQueue,
  queueIndex,
  playMode,
  isPlaying,
  personalizedStreamSession,
  personalizedStreamRemaining,
  personalizedStreamEntryIds,
  personalizedStreamPlayedEntryIds,
  rendererPlayModeBoundaryPending,
  persistPlaybackSessionAfterQueueMutation,
  queueNativeQueueStateSync,
  setAudioEngineError,
  clearAutomaticLyricsBaselines: lyricsLoader.clearLyricsBaselines,
  getPosition: getLatestPlaybackTime,
  prepareSelection: playbackSessionController.prepareQueueSelection,
  exitHeartModeForQueueEdit: () => exitHeartModeForManualQueueReplacement(),
  onQueueNotice: (label, revision) => {
    if (label === '替换队列') return
    useAppNoticeStore().pushNotice({
      message: `已${label}`,
      dedupeKey: 'queue-edit',
      action: {
        label: '撤销',
        run: () => {
          const undone = playbackQueueController.commands.undo(revision)
          useAppNoticeStore().pushNotice({
            message: undone ? '已撤销队列操作' : '队列已变化，请使用当前撤销入口',
            dedupeKey: 'queue-edit'
          })
        }
      }
    })
  }
})
const {
  markCurrentPersonalizedStreamTrackPlayed,
  endPersonalizedStream,
  isPersonalizedStreamTrack,
  startPersonalizedStream,
  applyPendingRendererPlayModeAtBoundary,
  enqueueTrack: enqueueArrayTrack,
  appendQueueTracks: appendArrayQueueTracks,
  appendPersonalizedStreamTracks,
  playNextTrack: playNextArrayTrack,
  removeQueueItem: removeArrayQueueItem,
  clearQueue: clearArrayQueue,
  reorderQueue: reorderArrayQueue,
  saveQueueAsPlaylist: saveArrayQueueAsPlaylist
} = playbackQueueController

async function applyLibraryQueueEdit(
  action: () => Promise<LibraryQueuePlaybackWindow | null>,
  rethrow = false
): Promise<void> {
  const intent = libraryTransportIntent
  const previous = currentTrack.value?.queueEntryId
  try {
    const result = await action()
    if (!libraryPlayback.active.value || intent !== libraryTransportIntent) return
    // An explicit refresh can resolve a mode write whose reply was lost.
    // Adopt its durable mode before saving or rebuilding the native window.
    if (result?.queue.playMode && result.queue.playMode !== playMode.value) {
      playMode.value = result.queue.playMode
      rendererPlayModeBoundaryPending.value = false
    }
    if (!result) {
      if (libraryPlayback.reference()) return
      resetPlaybackRuntimeStateForRestore()
      currentTrack.value = null
      isPlaying.value = false
      isLoading.value = false
      duration.value = 0
      persistPlaybackSessionAfterQueueMutation()
    } else if (previous !== result.queue.selectedEntryId) {
      invalidateLibraryTransportIntent()
      // Queue removal/empty-queue insertion selects a paused row, matching the
      // existing array command contract; only an explicit play/next starts it.
      playbackSessionController.prepareQueueSelection(libraryPlayback.track(result), 0)
      persistPlaybackSessionAfterQueueMutation()
    } else {
      persistSelectedTrackSession()
      if (nativePlaybackActive) await queueNativeQueueStateSync()
    }
  } catch (error) {
    if (intent === libraryTransportIntent)
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    if (rethrow) throw error
  }
}

async function playLibraryQueueEntry(
  entryId: string,
  expected: Pick<LibraryQueueSnapshot, 'id' | 'revision'>
): Promise<void> {
  const state = libraryPlayback.snapshot.value
  if (!state || state.id !== expected.id || state.revision !== expected.revision)
    throw new Error('播放队列已变化，请刷新后重试')
  playerSleepTimer.interruptShutdown()
  const intent = invalidateLibraryTransportIntent()
  try {
    const result = await libraryPlayback.selectEntry(entryId, expected, playMode.value)
    if (intent === libraryTransportIntent) playLibraryWindow(result)
  } catch (error) {
    if (intent === libraryTransportIntent) reportLibraryPlaybackError(error)
    throw error
  }
}

function editLibraryQueue(
  edit: LibraryQueueEdit,
  expected: Pick<LibraryQueueSnapshot, 'id' | 'revision'>
): Promise<void> {
  return applyLibraryQueueEdit(() => libraryPlayback.edit(edit, playMode.value, expected), true)
}

async function undoLibraryQueue(revision?: number): Promise<boolean> {
  if (!libraryPlayback.active.value || !libraryPlayback.canUndo()) return false
  const snapshot = libraryPlayback.snapshot.value
  if (revision !== undefined && snapshot?.revision !== revision) return false
  try {
    await applyLibraryQueueEdit(
      () =>
        libraryPlayback.undo(
          playMode.value,
          snapshot ? { id: snapshot.id, revision: snapshot.revision } : undefined
        ),
      true
    )
    return true
  } catch {
    return false
  }
}

function appendLibraryTracks(
  tracks: readonly Track[],
  next = false,
  rethrow = false
): Promise<void> {
  if (!next)
    return appendLibraryQueuePages(async (append) => {
      for (let offset = 0; offset < tracks.length; offset += LIBRARY_PAGE_SIZE)
        await append(queueInsertItems(tracks.slice(offset, offset + LIBRARY_PAGE_SIZE)))
    }, rethrow)
  const afterEntryId = next ? libraryPlayback.reference()?.entryId : undefined
  return applyLibraryQueueEdit(async () => {
    const result = await libraryPlayback.edit(
      {
        kind: 'insert',
        items: queueInsertItems(tracks),
        ...(afterEntryId ? { afterEntryId } : {})
      },
      playMode.value
    )
    if (!result && rethrow) throw new Error('播放来源已变化，添加已中断，请检查原队列')
    return result
  }, rethrow)
}

function queueInsertItems(tracks: readonly Track[]) {
  return tracks.map((track) => ({
    id: track.id,
    ...(getTrackSource(track) === 'local'
      ? {}
      : {
          snapshot: compactPlaylistRecord(
            track as unknown as import('../../../shared/libraryDatabase.ts').LibraryTrackRecord
          )
        })
  }))
}

/** SQLite-only streaming entry point; never switch a cancelled source to the
 * legacy in-memory queue partway through a selection action. */
async function appendLibraryQueuePages(
  produce: LibraryQueuePageProducer,
  rethrow = true,
  options: LibraryQueuePageOptions = {}
): Promise<void> {
  if (!libraryPlayback.active.value) {
    await stageLibraryQueuePages(produce, rethrow, options)
    return
  }
  await applyLibraryQueueEdit(async () => {
    const result = await libraryPlayback.appendPages(produce, playMode.value, options)
    if (!result) throw new Error('播放来源已变化，添加已中断，请检查原队列')
    return result.window
  }, rethrow)
}

/** Convert the existing source only after its once-only SQL stream and native
 * conditional handoff both succeed. The old arrays remain live until then. */
async function stageLibraryQueuePages(
  produce: LibraryQueuePageProducer,
  rethrow: boolean,
  options: LibraryQueuePageOptions
): Promise<void> {
  const intent = libraryTransportIntent,
    commandRevision = playbackQueueController.commands.revision.value,
    requestedMode = playMode.value
  const sourceCheck = () => {
    if (
      intent !== libraryTransportIntent ||
      libraryPlayback.active.value ||
      playbackQueueController.commands.revision.value !== commandRevision ||
      playMode.value !== requestedMode
    )
      throw new Error('播放来源或队列已变化，未切换播放来源')
    if (options.signal?.aborted) throw new Error('队列构建已取消')
    options.guard?.()
  }
  try {
    sourceCheck()
    // URL resolution/native play may still be finishing for this occurrence.
    // Changing its occurrence before that continuation would invalidate it.
    const loadingToken = activeLoadToken
    if (activeLoadCompletion) {
      let abort: (() => void) | undefined
      try {
        await Promise.race([
          activeLoadCompletion,
          new Promise<void>((_resolve, reject) => {
            abort = () => reject(new Error('队列构建已取消'))
            options.signal?.addEventListener('abort', abort, { once: true })
          })
        ])
      } finally {
        if (abort) options.signal?.removeEventListener('abort', abort)
      }
    }
    sourceCheck()
    if (activeLoadToken !== loadingToken) throw new Error('当前播放已变化，未切换播放来源')
    const token = activeLoadToken,
      revision = nativeQueueRevisionFence.current,
      index = queueIndex.value,
      selected = currentTrack.value,
      native = nativePlaybackActive && !castTargetUsn.value,
      cast = castTargetUsn.value,
      pendingMode = rendererPlayModeBoundaryPending.value,
      mode = requestedMode === 'heart' ? 'sequential' : requestedMode
    const check = () => {
      sourceCheck()
      if (
        activeLoadToken !== token ||
        !nativeQueueRevisionFence.isCurrent(revision) ||
        queueIndex.value !== index ||
        currentTrack.value?.id !== selected?.id ||
        currentTrack.value?.queueEntryId !== selected?.queueEntryId ||
        (nativePlaybackActive && !castTargetUsn.value) !== native ||
        castTargetUsn.value !== cast ||
        rendererPlayModeBoundaryPending.value !== pendingMode
      )
        throw new Error('当前播放已变化，未切换播放来源')
    }
    const seed = createLibraryArrayQueueSeed(
      queue.value,
      originalQueue.value,
      selected,
      index,
      mode,
      pendingMode
    )
    const metadata = await window.api.library.database.getMetadata()
    check()
    const result = await libraryPlayback.stagePages(
      async (append) => {
        await seed.produce(append)
        await produce(append)
      },
      {
        contentRevision: metadata.revision,
        order: mode === 'shuffle' ? 'shuffle' : 'original',
        selectedIndex: seed.selectedIndex
      },
      mode,
      async (playbackWindow, activate, retain) => {
        await nativeQueueRevisionFence.serialize(async () => {
          check()
          let rebound = false
          try {
            if (native && selected) {
              const current = {
                ...currentTrack.value!,
                queueEntryId: playbackWindow.queue.selectedEntryId!
              }
              const prepared = await preparePlayerNativeQueue(
                libraryNativeQueueOptions(
                  playbackWindow,
                  current,
                  getTrackAudioSource(current),
                  mode
                ),
                {
                  isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized,
                  areAudioFilesAuthorized: window.api.fs.areAudioFilesAuthorized
                }
              )
              check()
              if (!prepared) throw new Error('未能准备数据库播放窗口，原队列未切换')
              const info = await window.api.audioEngine.getPlaybackInfo()
              check()
              const expected = nativeQueueLoader.arraySelection(info, queue.value, index, selected)
              if (!expected) throw new Error('原生播放位置已变化，原队列未切换，请重试')
              nativeQueueAdoptionUncertain = true
              let outcome: Awaited<ReturnType<NativeQueueLoader['rebindPrepared']>>
              try {
                outcome = await nativeQueueLoader.rebindPrepared(
                  prepared,
                  expected,
                  mode,
                  window.api.audioEngine
                )
              } catch (error) {
                retain()
                if (nativeQueueRevisionFence.isCurrent(revision)) nativeQueueDelegated = false
                throw new Error(
                  `队列接管结果未知，请重新选择歌曲恢复同步：${error instanceof Error ? error.message : String(error)}`
                )
              }
              if (!outcome.applied) {
                if (nativeQueueRevisionFence.isCurrent(revision))
                  nativeQueueAdoptionUncertain = false
                throw new Error('原生队列未接管，原队列已保留；请重试或更新音频引擎')
              }
              retain()
              rebound = outcome.current
              if (!outcome.current) throw new Error('播放来源已变化，未采用迟到的队列接管回复')
              check()
            }
            activate()
          } catch (error) {
            if (rebound && nativeQueueRevisionFence.isCurrent(revision)) {
              nativeQueueLoader.clear()
              nativeQueueDelegated = false
              throw new Error(
                `原生队列已接管，来源确认中断，请重新选择歌曲恢复同步：${error instanceof Error ? error.message : String(error)}`
              )
            }
            throw error
          }
          // No await between the final controller fence and the source change.
          if (!native) nativeQueueLoader.clear()
          nativeQueueAdoptionUncertain = false
          nativeQueueDelegated = false
          clearNativePlaybackInfoIntent()
          intentionalTrackGuard = null
          exitHeartModeForManualQueueReplacement()
          endPersonalizedStream()
          rendererPlayModeBoundaryPending.value = false
          queue.value = []
          originalQueue.value = []
          queueIndex.value = -1
          if (selected) {
            currentTrack.value = {
              ...currentTrack.value!,
              queueEntryId: playbackWindow.queue.selectedEntryId!
            }
            lastActiveTrack = currentTrack.value
            if (!native && !cast) {
              clearRendererPlaybackWatchdog()
              if (isPlaying.value && playbackAudio?.src)
                scheduleRendererPlaybackWatchdog(currentTrack.value, token)
            }
          } else
            playbackSessionController.prepareQueueSelection(
              libraryPlayback.track(playbackWindow),
              0
            )
          nativeQueueRevisionFence.next()
          persistSelectedTrackSession()
        })
      },
      { ...options, guard: check }
    )
    if (!result) {
      check()
      // A completely empty seed/producer is a no-op, not a fake selected row.
    }
  } catch (error) {
    if (intent === libraryTransportIntent)
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    if (rethrow) throw error
  }
}

function enqueueTrack(track: Track): void {
  if (libraryPlayback.active.value) void appendLibraryTracks([track])
  else enqueueArrayTrack(track)
}

function appendQueueTracks(tracks: readonly Track[]): void {
  if (libraryPlayback.active.value) void appendLibraryTracks(tracks)
  else appendArrayQueueTracks(tracks)
}

async function appendQueueTracksAsync(tracks: readonly Track[]): Promise<void> {
  if (tracks.length === 0) return
  if (libraryPlayback.active.value) await appendLibraryTracks(tracks, false, true)
  else appendArrayQueueTracks(tracks)
}

function playNextTrack(track: Track): void {
  if (libraryPlayback.active.value) void appendLibraryTracks([track], true)
  else playNextArrayTrack(track)
}

function removeQueueItem(index: number): void {
  if (libraryPlayback.active.value) {
    void applyLibraryQueueEdit(() =>
      libraryPlayback.editPositions({ kind: 'remove', index }, playMode.value)
    )
  } else removeArrayQueueItem(index)
}

function clearQueue(): void {
  if (libraryPlayback.active.value) {
    void applyLibraryQueueEdit(() => libraryPlayback.edit({ kind: 'clear' }, playMode.value))
  } else clearArrayQueue()
}

function reorderQueue(from: number, to: number): void {
  if (libraryPlayback.active.value) {
    void applyLibraryQueueEdit(() =>
      libraryPlayback.editPositions({ kind: 'move', from, to }, playMode.value)
    )
  } else reorderArrayQueue(from, to)
}

function saveQueueAsPlaylist(
  name: string,
  create: (name: string, tracks: Track[]) => string,
  createPages?: PlaylistTrackPageCreator,
  signal?: AbortSignal
): string | Promise<string> {
  if (libraryPlayback.active.value) {
    if (createPages) {
      const intent = libraryTransportIntent
      return createPages(
        name,
        async (append) => {
          let count = 0,
            revision: number | null = null
          const result = await libraryPlayback.forEachPage(async (page) => {
            if (signal?.aborted) throw new Error('歌单操作已取消')
            revision = page.libraryRevision
            const tracks = page.items.flatMap((item) =>
              item.track ? [libraryQueueTrack(item.track, item.queueEntryId)] : []
            )
            count += tracks.length
            await append(tracks)
          })
          if (!result) throw new Error('数据库队列已变化，请刷新后重试')
          if (!count) throw new Error('队列中没有可保存的歌曲')
          return () => {
            const current = libraryPlayback.snapshot.value
            if (
              signal?.aborted ||
              intent !== libraryTransportIntent ||
              !libraryPlayback.active.value ||
              current?.id !== result.queue.id ||
              current.revision !== result.queue.revision ||
              libraryPlayback.contentRevision.value !== revision
            )
              throw new Error('数据库队列已变化，请刷新后重试')
          }
        },
        signal
      )
    }
    return (async () => {
      let playlistId = ''
      const result = await libraryPlayback.forEachPage((page) => {
        const tracks = page.items.flatMap((item) =>
          item.track ? [libraryQueueTrack(item.track, item.queueEntryId)] : []
        )
        if (tracks.length === 0) return
        const created = create(name, tracks)
        if (!created) throw new Error('歌单创建失败')
        playlistId ||= created
      })
      if (!result) throw new Error('数据库队列已变化，请刷新后重试')
      if (!playlistId) throw new Error('队列中没有可保存的歌曲')
      return playlistId
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      setAudioEngineError(message)
      return ''
    })
  }
  return saveArrayQueueAsPlaylist(name, create)
}

const queueWorkspace = createQueueWorkspaceStore(
  () => ({
    ...window.api.data,
    syncQueueReferences: async (owner: string, ids: string[]) => {
      try {
        await window.api.library.database.syncQueueReferences(owner, ids)
      } catch (error) {
        if (!String(error).includes('SQLite 曲库尚未启用')) throw error
      }
    }
  }),
  (message) => {
    useAppNoticeStore().pushNotice({
      kind: 'error',
      message: `播放顺序保存失败：${message}`,
      dedupeKey: 'queue-workspace'
    })
  }
)
cleanupFns.push(queueWorkspace.dispose, playbackQueueController.commands.dispose)

const playbackHistoryController = createPlaybackHistoryController({
  currentTrack,
  currentTime,
  getLatestPlaybackTime,
  seekPlayback: seekPlaybackFromUser,
  getPlaybackBookmarks: usePlaybackBookmarks,
  getPodcastStore: usePodcastStore,
  now: Date.now,
  recordActualPlayback: queueWorkspace.record
})
const { resumeOffer, acceptResumeOffer, dismissResumeOffer, addManualBookmarkAtCurrentTime } =
  playbackHistoryController

const audioOutputController = createAudioOutputController({
  exclusiveMode,
  audioProcessing,
  audioOutputConfig,
  audioOutputConfigApplyStatus,
  dspOutputStage,
  dspStereoImage,
  getAudioEngineApi: () => window.api.audioEngine,
  applyAudioOutputState,
  setAudioEngineError,
  scheduleCrossfadeIfNeeded,
  refreshPlaybackInfo: async () => {
    playbackInfo.value = normalizeNativePlaybackInfo(await window.api.audioEngine.getPlaybackInfo())
  },
  persistAudioProcessingFallback
})
const {
  toggleExclusiveMode,
  setAudioOutput,
  setAudioDevice,
  setAudioOutputConfig,
  setAudioProcessing,
  applyAudioProcessingState,
  setOutputStage,
  setStereoImage,
  toggleDspEnabled,
  toggleEqEnabled,
  toggleCrossfeed,
  toggleGapless,
  setReplayGainMode,
  setCrossfeedStrength,
  selectImpulseResponse,
  clearImpulseResponse
} = audioOutputController

const heartModeController = createHeartModeController({
  queue,
  queueIndex,
  currentTrack,
  playMode,
  isPlaying,
  isLoading,
  rendererPlayModeBoundaryPending,
  fetchIntelligenceList: (request) => useNcmStore().fetchIntelligenceList(request),
  playQueueTrack,
  advanceAfterPlaybackEnded,
  setAutoAdvanceInFlight: (value) => {
    autoAdvanceInFlight = value
  },
  replaceQueue: (tracks, index, replaceOptions) => {
    const snapshots = toPlaybackQueueSnapshots(tracks)
    queue.value = snapshots
    originalQueue.value = [...snapshots]
    queueIndex.value = index
    if (replaceOptions.persist) persistPlaybackSessionAfterQueueMutation()
    void queueNativeQueueStateSync().catch((error) => {
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  },
  appendQueueAdditions: (additions) => {
    const snapshots = toPlaybackQueueSnapshots(additions)
    queue.value = [...queue.value, ...snapshots]
    originalQueue.value = [...originalQueue.value, ...snapshots]
    persistPlaybackSessionAfterQueueMutation()
    void queueNativeQueueStateSync().catch((error) => {
      setAudioEngineError(error instanceof Error ? error.message : String(error))
    })
  }
})
const {
  heartModeAvailable,
  setHeartModeContext,
  enterHeartMode,
  exitHeartModeToSequential,
  exitHeartModeForManualQueueReplacement,
  advanceHeartPlayback
} = heartModeController

const queueSessions = createQueueSessionController({
  workspace: queueWorkspace,
  queue,
  originalQueue,
  currentTrack,
  playMode,
  revision: playbackQueueController.commands.revision,
  getPosition: getLatestPlaybackTime,
  getSources: getQueueSessionSources,
  getLibraryQueueReference: () => libraryPlayback.reference(),
  restoreLibraryQueue: (reference, mode, isCurrent) =>
    restoreLibraryQueueReference(reference, mode, isCurrent, true),
  prepare: (result, mode) => {
    detachLibraryPlayback()
    exitHeartModeForManualQueueReplacement()
    endPersonalizedStream()
    playMode.value = mode
    rendererPlayModeBoundaryPending.value = false
    playbackQueueController.commands.replace(result.queue, result.index, {
      original: result.original,
      select: false,
      synchronize: false,
      label: '恢复会话'
    })
    const track = result.queue[result.index]
    playbackSessionController.prepareQueueSelection(
      track,
      clampCuePlaybackPosition(track, result.position)
    )
    persistPlaybackSessionAfterQueueMutation()
    void queueNativeQueueStateSync().catch((error) => setAudioEngineError(String(error)))
    void updateSettings({ playMode: mode }).catch((error) => setAudioEngineError(String(error)))
  },
  prepareLibrary: (result, mode, position) => {
    exitHeartModeForManualQueueReplacement()
    endPersonalizedStream()
    queue.value = []
    originalQueue.value = []
    queueIndex.value = -1
    playMode.value = mode
    rendererPlayModeBoundaryPending.value = false
    playbackSessionController.prepareQueueSelection(
      result.track,
      clampCuePlaybackPosition(result.track, position)
    )
    persistPlaybackSessionAfterQueueMutation()
    void queueNativeQueueStateSync().catch((error) => setAudioEngineError(String(error)))
    void updateSettings({ playMode: mode }).catch((error) => setAudioEngineError(String(error)))
  },
  play: togglePlayState
})

// One dedupe slot for the whole audio-engine recovery lifecycle: crash, fatal
// and ready all update the same toast in place. The main process can emit the
// same crash reason repeatedly (service crash and error channels both fire, and
// a fatal is re-reported on every manual retry), so a fresh notice per event
// would keep replacing the one the user just closed.
const AUDIO_ENGINE_RECOVERY_DEDUPE_KEY = 'audio-engine-recovery'

function publishAudioEngineRecoveryNotice(notice: AudioEngineRecoveryNotice): void {
  audioEngineRecoveryNotice.value = notice
  const unrecoverable = notice.kind === 'service-fatal'
  const action =
    notice.kind === 'service-ready' && notice.canResume !== false
      ? {
          label: notice.actionLabel || translate(currentLocale(), 'action.resumePlayback'),
          run: () => void togglePlayState()
        }
      : unrecoverable
        ? {
            label: notice.actionLabel || translate(currentLocale(), 'action.retry'),
            run: () => void retryAudioService()
          }
        : undefined
  audioEngineRecoveryAppNoticeId = pushNotice({
    kind: unrecoverable
      ? 'error'
      : notice.kind === 'service-crash' || notice.canResume === false
        ? 'warning'
        : 'success',
    message: notice.message,
    action,
    sticky: unrecoverable || notice.kind === 'service-crash' || notice.canResume === false,
    durationMs: 8000,
    dedupeKey: AUDIO_ENGINE_RECOVERY_DEDUPE_KEY
  })
}

/**
 * Both call sites now hand over a bare reason — the structured `serviceCrash`
 * event and the sentinel-carrying `error` channel — so this no longer has to
 * strip a Chinese prefix back off a pre-rendered sentence.
 */
function setAudioServiceCrashNotice(reason: string, options?: { fatal?: boolean }): void {
  const locale = currentLocale()
  const detail = reason.trim() || translate(locale, 'error.audio.unknown_reason')
  if (options?.fatal === true) {
    publishAudioEngineRecoveryNotice({
      kind: 'service-fatal',
      message: translate(locale, 'error.audio.service_fatal', { reason: detail }),
      actionLabel: translate(locale, 'action.retry')
    })
    return
  }
  publishAudioEngineRecoveryNotice({
    kind: 'service-crash',
    message: translate(locale, 'error.audio.service_crashed', { reason: detail }),
    actionLabel: translate(locale, 'action.resumeManually')
  })
}

/**
 * User-driven recovery from a fatal audio-service startup failure. Nothing else
 * re-forks the child, so the retry must also release the notice suppression —
 * the user asked for a fresh answer and deserves to see it.
 */
async function retryAudioService(): Promise<void> {
  const api = window.api?.audioEngine
  if (!api?.restartService) return
  try {
    const result = await api.restartService()
    // Release only after awaiting: the notice host dismisses the toast right
    // after the action returns, which re-suppresses the message it carried.
    // Releasing here guarantees the retry's outcome is visible even when the
    // service fails again with the identical reason.
    releaseNoticeDedupe(AUDIO_ENGINE_RECOVERY_DEDUPE_KEY)
    if (result.restarted) {
      setAudioEngineError(null)
      publishAudioEngineRecoveryNotice({
        kind: 'service-ready',
        message: translate(currentLocale(), 'error.audio.service_restarting'),
        canResume: false
      })
      return
    }
    setAudioServiceCrashNotice(
      result.error || translate(currentLocale(), 'error.audio.service_still_failing'),
      { fatal: true }
    )
  } catch (error) {
    releaseNoticeDedupe(AUDIO_ENGINE_RECOVERY_DEDUPE_KEY)
    setAudioServiceCrashNotice(error instanceof Error ? error.message : String(error), {
      fatal: true
    })
  }
}

function setAudioServiceReadyNotice(event?: {
  outputRouteSynced?: boolean
  restoreErrors?: string[]
}): void {
  const outputRouteSynced = event?.outputRouteSynced === true
  const restoreErrors = Array.isArray(event?.restoreErrors)
    ? event.restoreErrors.filter((item) => item.trim())
    : []
  const locale = currentLocale()
  const detail =
    restoreErrors.length > 0
      ? translate(locale, 'error.audio.restore_detail', { detail: restoreErrors.join('；') })
      : ''
  publishAudioEngineRecoveryNotice({
    kind: 'service-ready',
    message: outputRouteSynced
      ? translate(locale, 'error.audio.service_recovered')
      : translate(locale, 'error.audio.service_recovered_route_pending', { detail }),
    actionLabel: outputRouteSynced ? translate(locale, 'action.resumePlayback') : undefined,
    canResume: outputRouteSynced
  })
}

const visualizationPolling = createVisualizationPolling({
  data: visualizationData,
  active: visualizerActive,
  consumers: visualizationConsumers,
  visible: visualizationDocumentVisible,
  enabled: () => Boolean(isPlaying.value && audioEngineReady.value && currentTrack.value?.id)
})

const {
  stop: stopVisualizationPolling,
  start: startVisualizationPolling,
  acquireConsumer: acquireVisualizationConsumer
} = visualizationPolling

async function handlePlaybackEnded(nativeBoundaryAuthoritative = false): Promise<void> {
  const loadToken = activeLoadToken
  if (await getSleepTimerController().reportBoundary('trackEnd', nativeBoundaryAuthoritative))
    return
  if (loadToken !== activeLoadToken) return
  const trackId = currentTrack.value?.id ?? ''
  if (!trackId || autoAdvanceInFlight || advancingFromEndedTrackId === trackId) return
  advancingFromEndedTrackId = trackId
  autoAdvanceInFlight = true
  flushLatestCurrentTime()
  if (playMode.value === 'repeat') {
    const track = currentTrack.value
    if (track) void loadAndPlay(track)
    return
  }
  await advanceAfterPlaybackEnded(nativeBoundaryAuthoritative)
}

async function advanceAfterPlaybackEnded(nativeBoundaryAuthoritative = false): Promise<void> {
  const loadToken = activeLoadToken
  clearCrossfadeTimer()
  if (libraryPlayback.active.value) {
    await advanceLibraryPlayback(1, false, nativeBoundaryAuthoritative)
    return
  }
  if (playMode.value === 'heart') {
    await advanceHeartPlayback()
    return
  }
  applyPendingRendererPlayModeAtBoundary()
  const nextIndex = queueIndex.value + 1
  if (nextIndex >= 0 && nextIndex < queue.value.length) {
    queueIndex.value = nextIndex
    const track = queue.value[nextIndex]
    if (track) {
      activateCurrentTrack(track, { resetUi: true, position: 0 })
      void loadAndPlay(track)
    } else {
      currentTrack.value = null
      resetPlaybackUiForTrackSwitch(null, 0)
    }
    return
  }

  if (await getSleepTimerController().reportBoundary('queueEnd', nativeBoundaryAuthoritative))
    return
  if (loadToken !== activeLoadToken) return

  if ((playMode.value === 'listLoop' || playMode.value === 'shuffle') && queue.value.length > 0) {
    queueIndex.value = 0
    const track = queue.value[0]
    if (track) {
      activateCurrentTrack(track, { resetUi: true, position: 0 })
      void loadAndPlay(track)
      return
    }
  }

  isPlaying.value = false
  isLoading.value = false
  autoAdvanceInFlight = false
  stopVisualizationPolling(true)
}

function handleNativePlaybackEnded(): void {
  if (nativeQueueAdoptionUncertain) return
  if (!nativePlaybackActive) return
  const nativeBoundaryAuthoritative = playbackInfo.value?.naturalBoundaries !== undefined
  if (libraryNativeHandoff) {
    const loadToken = activeLoadToken
    void libraryNativeHandoff.then(() => {
      if (loadToken === activeLoadToken && nativePlaybackActive)
        void handlePlaybackEnded(nativeBoundaryAuthoritative)
    })
    return
  }
  // Do not drop this because the queue is delegated. A delegated queue that
  // actually reached its end is exactly the case that needs the renderer's
  // boundary handling: listLoop/shuffle wrap in advanceAfterPlaybackEnded, and
  // without this the auto-advance budget ended up equal to the queue length.
  // Main only publishes the EOF signal when the engine reports no upcoming
  // track, i.e. when it cannot advance on its own, so this never races the
  // engine's own auto-advance (issue #48).
  void handlePlaybackEnded(nativeBoundaryAuthoritative)
}

/** True when a previously resolved local playback file still exists. */
async function isUsableLocalPlaybackFile(filePath: string): Promise<boolean> {
  try {
    return (await window.api?.fs?.isAudioFileAuthorized?.(filePath)) === true
  } catch {
    return false
  }
}

async function resolvePlayTarget(track: Track): Promise<string> {
  const source = getTrackSource(track)
  if (source === 'local') {
    const authorized = await window.api.fs.isAudioFileAuthorized(track.filePath)
    if (!authorized) {
      throw new Error('Local audio file is outside the authorized library folders')
    }
    return track.filePath
  }

  // Live radio always streams.
  if (source === 'radio') {
    const direct = track.streamUrl || track.filePath
    if (direct && /^https?:\/\//i.test(direct)) return direct
    throw new Error('Unable to resolve radio stream URL')
  }

  // Podcast episodes stream from the feed media URL.
  if (source === 'podcast') {
    const direct = track.streamUrl || track.filePath
    if (direct && /^https?:\/\//i.test(direct)) return direct
    throw new Error('Unable to resolve podcast stream URL')
  }

  if (source === 'network') {
    // Browse-page tracks may already carry a resolved cache path/URL. Search
    // and library tracks carry the profile/entry pair and resolve lazily here.
    if (track.filePath) {
      if (
        !isLikelyLocalFilePath(track.filePath) ||
        (await isUsableLocalPlaybackFile(track.filePath))
      ) {
        return track.filePath
      }
      // The managed music cache was cleared: the local copy is gone. Drop the
      // dead path and re-resolve, which re-downloads into the cache.
      track.filePath = ''
    }
    const network = track.networkSource
    if (!network || !window.api?.networkSources) {
      throw new Error('Unable to resolve network stream URL')
    }
    const plan = await window.api.networkSources.resolvePlayback(network.profileId, network.entry)
    const target = plan.kind === 'direct-url' ? plan.url : plan.cacheFilePath
    if (!target) throw new Error('Unable to resolve network stream URL')
    track.filePath = target
    return target
  }

  const ncmPlaybackQuality = appSettings.value.ncmPlaybackQuality
  // Do not reuse a remote NCM URL when a managed disk cache may already exist;
  // the provider is the authority for cache-hit local paths.
  const canReuseNcmStream = source !== 'ncm' || track.streamQuality === ncmPlaybackQuality
  let force = false
  if (
    source !== 'ncm' &&
    track.streamUrl &&
    shouldReuseResolvedStreamUrl(source) &&
    canReuseNcmStream
  ) {
    // Session-scoped twilight-media grants die with the main-process grant map.
    // Never reuse a stale audio grant — re-resolve so protectProviderMedia issues
    // a live token (or the provider returns a fresh cache path / stream URL).
    if (!/^twilight-media:/i.test(track.streamUrl)) {
      if (
        !isLikelyLocalFilePath(track.streamUrl) ||
        (await isUsableLocalPlaybackFile(track.streamUrl))
      )
        return track.streamUrl
      force = true
    }
  }
  if (
    source === 'ncm' &&
    track.streamUrl &&
    shouldReuseResolvedStreamUrl(source) &&
    canReuseNcmStream &&
    !/^https?:\/\//i.test(track.streamUrl) &&
    !/^twilight-media:/i.test(track.streamUrl)
  ) {
    // Local cache path previously returned by the provider. The managed cache
    // may have been cleared since, so only reuse a path that still exists;
    // otherwise re-resolve through the provider, which re-fetches online and
    // re-caches on demand. loadAndPlay commits the resolved target back onto
    // the track, so no clearing is needed here.
    if (await isUsableLocalPlaybackFile(track.streamUrl)) return track.streamUrl
    force = true
  }

  await syncPluginProviders()
  const options = source === 'ncm' ? { quality: ncmPlaybackQuality } : undefined
  let streamUrl = await useMediaProviders().resolvePlaybackUrl(
    track,
    force ? { ...options, force: true } : options
  )
  if (
    source === 'ncm' &&
    streamUrl &&
    isLikelyLocalFilePath(streamUrl) &&
    !(await isUsableLocalPlaybackFile(streamUrl))
  ) {
    // The provider can finish resolving just as its managed cache is cleared.
    // Bypass its memory cache once to obtain a fresh account-authorized stream
    // before native queue preparation rejects the missing local target.
    streamUrl = await useMediaProviders().resolvePlaybackUrl(track, {
      quality: ncmPlaybackQuality,
      force: true
    })
    if (
      streamUrl &&
      isLikelyLocalFilePath(streamUrl) &&
      !(await isUsableLocalPlaybackFile(streamUrl))
    ) {
      throw new Error('网易云缓存文件不可用，重新获取播放地址后仍无法播放，请重试')
    }
  }
  if (!streamUrl) {
    if (source === 'ncm') {
      throw new Error('当前网易云账号没有可播放的音质，请检查登录状态、歌曲版权和会员权益')
    }
    throw new Error(`Unable to resolve ${source} stream URL`)
  }

  return streamUrl
}

function replaceFailedPlaybackOccurrence(failedTrack: Track, replacement: Track): Track | null {
  const active = currentTrack.value
  if (
    !active ||
    active.id !== failedTrack.id ||
    (failedTrack.queueEntryId && active.queueEntryId !== failedTrack.queueEntryId)
  )
    return null

  // Older direct-play state may have no array queue. Give that playback its
  // own occurrence so recovery remains playable, navigable and restorable.
  if (!queue.value.length) {
    const recovered = {
      ...replacement,
      queueEntryId:
        failedTrack.queueEntryId ?? active.queueEntryId ?? `queue:${crypto.randomUUID()}`
    }
    const snapshot = toPlaybackQueueSnapshot(recovered)
    queue.value = [snapshot]
    originalQueue.value = [snapshot]
    queueIndex.value = 0
    return recovered
  }

  const index = failedTrack.queueEntryId
    ? queue.value.findIndex((track) => track.queueEntryId === failedTrack.queueEntryId)
    : queueIndex.value
  const failedEntry = queue.value[index]
  if (
    !failedEntry ||
    failedEntry.id !== failedTrack.id ||
    (currentTrack.value?.queueEntryId &&
      currentTrack.value.queueEntryId !== failedEntry.queueEntryId)
  )
    return null

  // Recovery changes the source of this occurrence. The candidate may already
  // occupy another slot, so neither its id nor its entry id owns our cursor.
  const recovered = {
    ...replacement,
    queueEntryId: failedEntry.queueEntryId ?? `queue:${crypto.randomUUID()}`
  }
  const snapshot = toPlaybackQueueSnapshot(recovered)
  let originalIndex = failedEntry.queueEntryId
    ? originalQueue.value.findIndex((track) => track.queueEntryId === failedEntry.queueEntryId)
    : originalQueue.value.indexOf(failedEntry)
  if (!failedEntry.queueEntryId && originalIndex < 0) {
    const occurrence = queue.value
      .slice(0, index)
      .filter((track) => track.id === failedEntry.id).length
    let seen = 0
    originalIndex = originalQueue.value.findIndex(
      (track) => track.id === failedEntry.id && seen++ === occurrence
    )
  }
  queue.value = queue.value.map((track, entryIndex) => (entryIndex === index ? snapshot : track))
  originalQueue.value = originalQueue.value.map((track, entryIndex) =>
    entryIndex === originalIndex ? snapshot : track
  )
  queueIndex.value = index
  return recovered
}

async function handlePlaybackFallback(
  failedTrack: Track,
  reason: unknown,
  loadToken: number
): Promise<boolean> {
  if (!isActiveLoad(loadToken, failedTrack)) return false
  // A provider replacement is not the authoritative local occurrence stored in
  // SQLite. Keep local failures attached to that occurrence rather than saving
  // an unrelated stream under its database session reference.
  if (libraryPlayback.active.value) return false
  const failedSource = getTrackSource(failedTrack)
  const fallback = findPlaybackFallbackTrack({
    failedTrack,
    candidates: queue.value,
    unavailableSources: [failedSource],
    sourceReliability: getProviderSourceReliability()
  })
  if (!fallback) return await handleProviderRematchFallback(failedTrack, loadToken)
  const recovered = replaceFailedPlaybackOccurrence(failedTrack, fallback)
  if (!recovered) return false

  // A fallback succeeded: audio is still playing, so this is a warning.
  const fallbackLocale = currentLocale()
  setAudioEngineError(
    translate(fallbackLocale, 'error.audio.playback_fallback_switched', {
      title: failedTrack.title || translate(fallbackLocale, 'error.audio.current_track'),
      source: fallback.source ?? getTrackSource(fallback),
      reason: presentError(fallbackLocale, reason)
    }),
    'warning'
  )
  nativePlaybackActive = false
  loadedTrackId = ''
  stopVisualizationPolling(true)
  stopRendererAudio(true)

  currentTrack.value = recovered
  await loadAndPlay(recovered)
  return true
}

function getProviderSourceReliability(): ProviderSourceReliability {
  const reliability: ProviderSourceReliability = {}
  for (const provider of useMediaProviders().list()) {
    const playbackUrlRate = provider.health?.methodStats?.getPlaybackUrl?.successRate
    const successRate =
      typeof playbackUrlRate === 'number' ? playbackUrlRate : provider.health?.successRate
    reliability[provider.id] = clampProviderReliability(successRate)
  }
  return reliability
}

async function handleProviderRematchFallback(
  failedTrack: Track,
  loadToken: number
): Promise<boolean> {
  if (!isActiveLoad(loadToken, failedTrack)) return false
  const failedSource = getTrackSource(failedTrack)

  await syncPluginProviders()
  const searchResult = await useMediaProviders().searchAllSongs({
    query: [failedTrack.title, failedTrack.artist].filter(Boolean).join(' '),
    localTracks: queue.value
  })
  const candidates = searchResult.items
    .map((item) => item.track)
    .filter((track) =>
      failedSource === 'local'
        ? getTrackSource(track) !== 'local'
        : getTrackSource(track) !== failedSource || track.id !== failedTrack.id
    )
  const rematched = findProviderRematchCandidate(failedTrack, candidates)
  if (!rematched || !isActiveLoad(loadToken, failedTrack)) return false
  const recovered = replaceFailedPlaybackOccurrence(failedTrack, rematched)
  if (!recovered) return false

  // Rematch succeeded: playback continues from another source.
  const rematchLocale = currentLocale()
  setAudioEngineError(
    translate(rematchLocale, 'error.audio.playback_fallback_rematched', {
      title: failedTrack.title || translate(rematchLocale, 'error.audio.current_track'),
      source: rematched.source ?? getTrackSource(rematched)
    }),
    'warning'
  )
  nativePlaybackActive = false
  loadedTrackId = ''
  stopVisualizationPolling(true)
  stopRendererAudio(true)

  currentTrack.value = recovered
  // Persist the rematch so playlists/library references to the expired
  // provider track are replaced — not just the transient playback queue.
  if (failedSource !== 'local') {
    useMusicStore().replaceTrackReference(failedTrack.id, rematched)
  }
  await loadAndPlay(recovered)
  return true
}

function retryCurrentTrackLyricsIfNeeded(forceReload = false): void {
  lyricsLoader.retryCurrentTrackLyricsIfNeeded(forceReload)
}

async function refreshPlaybackInfoAfterStartFile(): Promise<void> {
  const api = window.api?.audioEngine
  if (!api) return

  const refreshGeneration = ++startFilePlaybackInfoRefreshGeneration
  const trackIdAtStart = currentTrack.value?.id ?? ''
  for (let attempt = 0; attempt < START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS; attempt += 1) {
    if (currentTrack.value?.id !== trackIdAtStart) {
      retryCurrentTrackLyricsIfNeeded()
      return
    }
    try {
      const info = await api.getPlaybackInfo()
      if (refreshGeneration !== startFilePlaybackInfoRefreshGeneration) return
      applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
      if (currentTrack.value?.id !== trackIdAtStart) {
        retryCurrentTrackLyricsIfNeeded()
        return
      }
    } catch {
      // A later attempt can observe the post-boundary native service snapshot.
    }

    if (attempt + 1 < START_FILE_PLAYBACK_INFO_REFRESH_ATTEMPTS) {
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, START_FILE_PLAYBACK_INFO_REFRESH_DELAY_MS)
      )
    }
  }

  if (refreshGeneration === startFilePlaybackInfoRefreshGeneration) {
    retryCurrentTrackLyricsIfNeeded()
  }
}

async function refreshPlaybackAfterRendererResume(): Promise<void> {
  if (rendererResumePlaybackInfoRefresh) return rendererResumePlaybackInfoRefresh

  rendererResumePlaybackInfoRefresh = (async () => {
    try {
      const info = await window.api?.audioEngine?.getPlaybackInfo()
      if (info) applyNativePlaybackInfo(info, { applyTrackWhenInactive: true })
    } catch {
      // Playback events can resume independently after a short service delay.
    } finally {
      retryCurrentTrackLyricsIfNeeded(true)
      rendererResumePlaybackInfoRefresh = null
    }
  })()

  return rendererResumePlaybackInfoRefresh
}

function setupAudioEngineListeners(): void {
  if (listenersSetup) return
  listenersSetup = true

  const api = window.api?.audioEngine
  if (!api) return

  const settingsApi = window.api?.settings

  cleanupFns.push(
    api.onPropertyChange(({ name, data }) => {
      if (nativeQueueAdoptionUncertain) return
      if (
        !currentTrack.value ||
        (restoredPlaybackPending && !nativePlaybackActive && !isLoading.value)
      )
        return
      if (
        libraryPlayback.active.value &&
        (libraryPlayback.busy.value || libraryNativeHandoff) &&
        (name === 'time-pos' || name === 'duration')
      )
        return
      switch (name) {
        case 'time-pos':
          // 兜底（HTMLAudio）模式下原生 time-pos 与 <audio> timeupdate 双源竞争，
          // 会造成进度冻结；只在原生播放时应用原生时间。
          if (!shouldApplyNativeTimePosition({ nativePlaybackActive, nativeQueueDelegated })) {
            break
          }
          if (typeof data === 'number' && isFinite(data)) {
            applyPlaybackPositionSample(data, 'native-time-pos')
          }
          break
        case 'duration':
          if (typeof data === 'number' && isFinite(data) && data > 0) {
            duration.value = data
          }
          break
        case 'pause':
          if (
            !nativePlaybackActive &&
            !nativeQueueDelegated &&
            !isPlaying.value &&
            !isLoading.value
          ) {
            break
          }
          applyNativePlayingState(!data, data === true ? getLatestPlaybackTime() : null)
          flushLatestCurrentTime()
          break
        case 'eof-reached':
          handleNativePlaybackEnded()
          break
      }
      if (name === 'time-pos' || name === 'duration') {
        scheduleCrossfadeIfNeeded()
      }
    })
  )

  cleanupFns.push(
    api.onEndFile((reason) => {
      if ((nativePlaybackActive || nativeQueueDelegated) && reason === 'eof') {
        handleNativePlaybackEnded()
      }
    })
  )

  cleanupFns.push(
    api.onStartFile(() => {
      if (nativeQueueAdoptionUncertain) return
      if (
        !currentTrack.value ||
        (restoredPlaybackPending && !nativePlaybackActive && !isLoading.value)
      )
        return
      nativeHistoryRestartPending =
        !isLoading.value &&
        (playMode.value === 'repeat' ||
          (queue.value.length === 1 && playMode.value !== 'sequential'))
      // Gapless / delegated auto-advance emits start-file without going through
      // loadAndPlay or advanceNativePlayback. Always refresh track identity +
      // progress so cover and the playbar slider rebind to the new file.
      advancingFromEndedTrackId = ''
      autoAdvanceInFlight = false
      // Only identity-bearing playback-info can start a native track clock.
      // Resetting to zero here discards the confirmed position of the incoming track.
      // loadAndPlay anchors explicit starts before issuing the native command.
      pendingLoadStartTime = 0
      isLoading.value = false
      // start-file is emitted by the native backend when the new file has
      // entered its playback pipeline. Re-open both clocks immediately: a
      // stale pause snapshot may have cleared isPlaying before this event, and
      // leaving nativePlaybackActive false would make the time-pos policy drop
      // every sample from the new track.
      if (currentTrack.value && playbackToggleIntent?.playing !== false) {
        setPlaybackToggleIntent(true)
        nativePlaybackActive = true
        isPlaying.value = true
      }
      void refreshPlaybackInfoAfterStartFile()
    })
  )

  const refreshAfterRendererResume = (): void => {
    visualizationDocumentVisible.value = document.visibilityState !== 'hidden'
    if (document.visibilityState === 'hidden') return
    void refreshPlaybackAfterRendererResume()
  }
  document.addEventListener('visibilitychange', refreshAfterRendererResume)
  window.addEventListener('focus', refreshAfterRendererResume)
  cleanupFns.push(() => {
    document.removeEventListener('visibilitychange', refreshAfterRendererResume)
    window.removeEventListener('focus', refreshAfterRendererResume)
  })

  cleanupFns.push(
    api.onPlaybackInfo((info) => {
      applyNativePlaybackInfo(info)
    })
  )

  if (typeof api.onLoudnormStatus === 'function') {
    cleanupFns.push(
      api.onLoudnormStatus((event) => {
        loudnormStatus.value = event.status
        loudnormStatusSource.value = event.source
      })
    )
  }

  if (api.onDeviceOptionsChanged) {
    cleanupFns.push(
      api.onDeviceOptionsChanged(() => {
        void refreshAudioOutputState()
      })
    )
  }

  if (api.onServiceCrash) {
    cleanupFns.push(
      api.onServiceCrash(({ reason, fatal }) => {
        nativeQueueLoader.clear()
        setAudioServiceCrashNotice(reason, { fatal: fatal === true })
      })
    )
  }

  if (api.onServiceReady) {
    cleanupFns.push(
      api.onServiceReady((event) => {
        nativeQueueLoader.clear()
        audioEngineReady.value = true
        if (event.outputRouteSynced) {
          setAudioEngineError(null)
        } else {
          audioEngineError.value =
            event.restoreErrors?.join('；') ||
            translate(currentLocale(), 'error.audio.output_route_not_restored')
        }
        setAudioServiceReadyNotice({
          outputRouteSynced: event.outputRouteSynced === true,
          restoreErrors: event.restoreErrors
        })
        void refreshAudioOutputState()
      })
    )
  }

  cleanupFns.push(
    api.onReady(async () => {
      const recoveredFromServiceCrash = audioEngineRecoveryNotice.value?.kind === 'service-crash'
      audioEngineReady.value = true
      if (recoveredFromServiceCrash) {
        const locale = currentLocale()
        setAudioServiceReadyNotice({
          outputRouteSynced: false,
          restoreErrors: [translate(locale, 'error.audio.awaiting_route_confirmation')]
        })
        audioEngineError.value = translate(locale, 'error.audio.output_route_not_restored')
      } else {
        setAudioEngineError(null)
      }
      // A renderer recreated after Afterglow must not overwrite the running
      // host with the persisted volume/rate; it adopted the live values instead.
      // A later engine-ready event (for example after an audio-service restart)
      // must resume syncing the persisted settings.
      if (adoptedAfterglowRestore) {
        adoptedAfterglowRestore = false
      } else {
        syncSoftwareVolumeToEngine()
        api.setPlaybackRate(playbackRate.value).catch(() => {})
      }
      await refreshAudioOutputState()
      try {
        const nativeInfo = await api.getPlaybackInfo()
        audioOutputConfig.value = {
          ...(appSettings.value?.audioOutputConfig ?? defaultAudioOutputConfig)
        }
        playbackInfo.value = normalizeNativePlaybackInfo(nativeInfo)
      } catch {
        // keep default
      }
    })
  )

  cleanupFns.push(
    api.onError((message) => {
      // The sentinel classifies the failure; the prose is only for the console.
      // Reading `code` instead of substring-matching Chinese keeps crash handling
      // working in every language.
      const detail = presentErrorDetail(currentLocale(), message)
      console.error('[audio-engine] Playback error:', detail.developerMessage || message)
      if (detail.code === 'audio.service_fatal') {
        audioEngineError.value = detail.display
        setAudioServiceCrashNotice(String(detail.params.reason ?? ''), { fatal: true })
      } else if (detail.code === 'audio.service_crashed') {
        audioEngineError.value = detail.display
        setAudioServiceCrashNotice(String(detail.params.reason ?? ''))
      } else {
        setAudioEngineError(detail.display)
      }
      clearPlaybackToggleIntent()
      clearNativePlaybackInfoIntent()
      isPlaying.value = false
      isLoading.value = false
    })
  )

  cleanupFns.push(
    api.onDisconnected(() => {
      audioEngineReady.value = false
      nativePlaybackActive = false
      clearPlaybackToggleIntent()
      clearNativePlaybackInfoIntent()
      isPlaying.value = false
    })
  )

  if (settingsApi?.onPlayerShortcut) {
    cleanupFns.push(
      settingsApi.onPlayerShortcut((action) => {
        void handlePlayerShortcutAction(action)
      })
    )
  }

  if (settingsApi?.onChanged) {
    cleanupFns.push(
      settingsApi.onChanged((snapshot) => {
        audioOutputConfig.value = {
          ...defaultAudioOutputConfig,
          ...snapshot.settings.audioOutputConfig
        }
        audioProcessing.value = {
          ...defaultAudioProcessing,
          ...snapshot.settings.audioProcessing,
          eqBands: snapshot.settings.audioProcessing.eqBands.map((band) => ({ ...band }))
        }
        const defaultScene = snapshot.settings.dspScenes?.find((scene) => scene.id === 'default')
        if (defaultScene?.graph?.outputStage) {
          dspOutputStage.value = mergeDspOutputStage(defaultScene.graph.outputStage, {})
        }
        if (defaultScene?.graph) {
          dspStereoImage.value = extractStereoImageFromGraph(defaultScene.graph)
        }
      })
    )
  }

  void refreshAudioOutputState()
}

function dismissAudioEngineRecoveryNotice(): void {
  if (audioEngineRecoveryAppNoticeId) dismissNotice(audioEngineRecoveryAppNoticeId)
  audioEngineRecoveryAppNoticeId = 0
  audioEngineRecoveryNotice.value = null
}

function disposePlayerStoreRuntime(): void {
  libraryPlayback.dispose()
  removeRemoteRequestListener?.()
  removeRemoteRequestListener = null
  remoteControlBridge = null
  for (const view of remotePlaylistViews.values()) void view.dispose()
  remotePlaylistViews.clear()
  // Release IPC subscriptions first: stale modules must never keep advancing
  // their own playback clock after a hot replacement has taken ownership.
  for (const cleanup of cleanupFns.splice(0).reverse()) {
    try {
      cleanup()
    } catch {
      // Every cleanup is best-effort; remaining handles are still released.
    }
  }
  listenersSetup = false
  playerSystemIntegrations.dispose()
  playerSleepTimer.dispose()
  playerRuntimeScope.stop()
  playerIntegrationSideEffectsSetup = false
  clearRendererPlaybackWatchdog()
  clearNativeStreamBufferingTimer()
  rendererPauseFadeController.cancel()
  disposePlaybackClock()
  playbackHistoryController.dispose()
  clearCrossfadeTimer()
  stopVisualizationPolling(false)
}

// Claim before registering listeners. A Vite replacement invokes the previous
// generation's release callback, so one renderer window has one active audio
// event consumer and one lyric-loading state machine.
const playerRuntimeLease = claimRendererRuntime(
  PLAYER_RUNTIME_OWNERSHIP_KEY,
  disposePlayerStoreRuntime
)
setupAudioEngineListeners()
startRendererPlaybackClock()

configurePlayerStoreHmr(
  import.meta.hot,
  () => window.location.reload(),
  () => playerRuntimeLease.release()
)

watch([isPlaying, playbackRate], ([playing, rate], [previousPlaying, previousRate]) => {
  if (playing && (playing !== previousPlaying || rate !== previousRate)) {
    anchorRendererPlaybackClock(currentTime.value)
  }
})

watch(
  [
    isPlaying,
    audioEngineReady,
    () => currentTrack.value?.id,
    visualizerActive,
    visualizationDocumentVisible
  ],
  ([playing, ready, trackId, activeVisualizer, visible]) => {
    if (playing && ready && trackId && !activeVisualizer && visible) {
      startVisualizationPolling()
      return
    }
    stopVisualizationPolling(activeVisualizer ? false : true)
  },
  { immediate: true }
)

watch(visualizationConsumers, (consumers) => {
  if (consumers > 0) {
    if (isPlaying.value && audioEngineReady.value && currentTrack.value?.id) {
      startVisualizationPolling()
    }
    return
  }
  stopVisualizationPolling(true)
})

function clearCrossfadeTimer(): void {
  if (crossfadeTimer) {
    window.clearTimeout(crossfadeTimer)
    crossfadeTimer = null
  }
  crossfadeTrackId = ''
}

function scheduleCrossfadeIfNeeded(): void {
  const seconds = audioProcessing.value.crossfadeSeconds
  const track = currentTrack.value
  if (
    !track ||
    !isPlaying.value ||
    nativePlaybackActive ||
    playMode.value === 'repeat' ||
    seconds <= 0 ||
    duration.value <= seconds + 1
  ) {
    clearCrossfadeTimer()
    return
  }

  if (queue.value.length <= 1) return
  if (queueIndex.value + 1 >= queue.value.length) return

  const remaining = duration.value - getLatestPlaybackTime()
  if (remaining > seconds || remaining < 0) {
    if (crossfadeTrackId !== track.id) clearCrossfadeTimer()
    return
  }

  if (crossfadeTrackId === track.id) return
  crossfadeTrackId = track.id
  crossfadeTimer = window.setTimeout(
    () => {
      crossfadeTimer = null
      next()
    },
    Math.max(0, remaining * 1000)
  )
}

async function loadAndPlay(track: Track, startTime = 0): Promise<void> {
  nativeQueueAdoptionUncertain = false
  playbackHistoryController.beginPlaybackAttempt()
  nativeHistoryRestartPending = false
  // Capture previous playback identity before this load mutates state.
  // Callers (playTrack / next / previous) often set currentTrack and even replace
  // the queue before invoking loadAndPlay, so prefer lastActiveTrack.
  const previousTrack =
    lastActiveTrack && lastActiveTrack.id !== track.id
      ? lastActiveTrack
      : currentTrack.value && currentTrack.value.id !== track.id
        ? currentTrack.value
        : null
  if (previousTrack && previousTrack.id !== track.id) {
    playbackHistoryController.recordTrackDeparture(previousTrack)
  }
  playbackHistoryController.clearResumeOfferForOtherTrack(track)

  const normalizedStartTime = clampCuePlaybackPosition(track, startTime)
  playbackSessionController.clearPendingPlaybackPosition()
  const loadToken = ++activeLoadToken
  nativeQueueRevisionFence.next()
  // New load is always an intentional play — drop pause-toggle grace so a
  // prior pause cannot keep the UI stuck while this track starts.
  clearPlaybackToggleIntent()
  setNativePlaybackInfoIntent(loadToken, track)
  stopVisualizationPolling(false)
  isLoading.value = true
  resetNativeStreamBufferingState()
  streamNowPlaying.value = ''
  nativePlaybackActive = false
  nativeQueueDelegated = false
  stopRendererAudio(true)
  if (playbackAudio) playbackAudio.muted = false
  pendingLoadStartTime = normalizedStartTime
  duration.value = cueDuration(track)
  beginPlaybackPositionTransition(normalizedStartTime, { keepRendererClockAlive: true })
  clearAbLoop()
  clearCrossfadeTimer()

  // Apply remembered podcast playback rate (or reset to 1 when leaving podcasts).
  if (track.source === 'podcast') {
    const preferred = getPodcastDefaultPlaybackRate()
    if (Math.abs(playbackRate.value - preferred) > 0.001) {
      void setPlaybackRate(preferred)
    }
  } else if (previousTrack?.source === 'podcast' && Math.abs(playbackRate.value - 1) > 0.001) {
    // Leaving a podcast: restore unity rate so music stays bit-perfect by default.
    void setPlaybackRate(1)
  }

  const releaseLoadIfOwned = (): void => {
    // Only the still-current load token may clear loading. A superseded load
    // must leave isLoading true for the newer owner.
    if (loadToken === activeLoadToken) isLoading.value = false
  }

  let complete!: () => void
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })
  activeLoadCompletion = completion
  try {
    await stopNativeAudio()
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }

    const playTarget = await resolvePlayTarget(track)
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    track.streamUrl = playTarget
    if (getTrackSource(track) === 'ncm') {
      track.streamQuality = appSettings.value.ncmPlaybackQuality
      rememberNcmStreamUrlCommit(track.id)
    }
    patchTrackInQueues(track)
    nativeSourceToTrackId.set(playTarget, track.id)
    // resolvePlayTarget 只改写了传入的 track 对象，而 active currentTrack 是
    // 激活时的拷贝；若不回写，后续队列重同步（如切换播放模式）会因取不到
    // source 而误判“当前曲目不支持原生播放”→ stopNativeAudio → 误触发切歌。
    if (currentTrack.value && currentTrack.value.id === track.id) {
      currentTrack.value = {
        ...currentTrack.value,
        streamUrl: track.streamUrl ?? currentTrack.value.streamUrl,
        filePath: track.filePath ?? currentTrack.value.filePath,
        streamQuality: track.streamQuality ?? currentTrack.value.streamQuality
      }
    }
    setNativePlaybackInfoIntent(loadToken, track, playTarget)
    const useNativePlayback = shouldUseNativePlayback(track, playTarget)

    let nativeStarted = false
    let nativeFallbackReason = ''
    let nativePlaySuperseded = false

    if (useNativePlayback) {
      try {
        await nativeQueueRevisionFence.serialize(async () => {
          if (!isActiveLoad(loadToken, track)) return
          const playbackWindow = libraryPlayback.active.value
            ? await libraryPlayback.playbackWindow(track, playMode.value)
            : null
          if (!isActiveLoad(loadToken, track)) return
          if (libraryPlayback.active.value && !playbackWindow) {
            throw ipcError(
              'audio.playback_target_unavailable',
              'Database playback occurrence is unavailable'
            )
          }
          const preparedQueue = await nativeQueueLoader.prepareAndLoad(
            playbackWindow
              ? libraryNativeQueueOptions(playbackWindow, track, playTarget, playMode.value, () =>
                  isActiveLoad(loadToken, track)
                )
              : {
                  // 心动模式：渲染层自行驱动切歌与补拉，原生引擎只加载当前曲目。
                  queue: stripStaleNcmStreamUrls(
                    playMode.value === 'heart' ? [track] : queue.value,
                    {
                      committedAtByTrackId: ncmStreamUrlCommittedAt,
                      quality: appSettings.value.ncmPlaybackQuality
                    }
                  ),
                  currentTrack: track,
                  currentTarget: playTarget,
                  currentIndex: playMode.value === 'heart' ? 0 : queueIndex.value,
                  playMode: playMode.value,
                  isCurrent: () => isActiveLoad(loadToken, track)
                },
            {
              isAudioFileAuthorized: window.api.fs.isAudioFileAuthorized,
              areAudioFilesAuthorized: window.api.fs.areAudioFilesAuthorized
            },
            window.api.audioEngine
          )
          if (!isActiveLoad(loadToken, track)) {
            releaseLoadIfOwned()
            return
          }
          if (!preparedQueue) {
            throw ipcError(
              'audio.playback_target_unavailable',
              'Playback target is unavailable or unauthorized'
            )
          }
          for (const item of preparedQueue.items) {
            nativeSourceToTrackId.set(item.source, item.id)
          }
          // 当前播放 source 挪到最新插入位，保证淘汰时最后才被考虑。
          nativeSourceToTrackId.delete(playTarget)
          nativeSourceToTrackId.set(playTarget, track.id)
          pruneNativeSourceToTrackId(preparedQueue.items, playTarget)
          if (!isActiveLoad(loadToken, track)) {
            releaseLoadIfOwned()
            return
          }

          nativeQueueDelegated = preparedQueue.delegated
          // 心动模式由渲染层驱动切歌与补拉，原生队列不代管边界。
          if (playMode.value === 'heart') nativeQueueDelegated = false

          const nativePlayMode = preparedNativePlayMode(preparedQueue, playMode.value)
          await window.api.audioEngine.setPlayMode(nativePlayMode)
          if (!isActiveLoad(loadToken, track)) {
            releaseLoadIfOwned()
            return
          }

          const playResult = await window.api.audioEngine.play(playTarget, normalizedStartTime)
          if (!isActiveLoad(loadToken, track)) {
            releaseLoadIfOwned()
            return
          }
          if (playResult?.superseded) {
            nativePlaySuperseded = true
            releaseLoadIfOwned()
            return
          }
          nativeStarted = playResult?.nativeStarted === true
          nativeFallbackReason = playResult?.fallbackReason ?? ''
        })
      } catch (engineErr) {
        if (!isActiveLoad(loadToken, track)) {
          releaseLoadIfOwned()
          return
        }
        // Queue availability failures belong to source recovery. Queue IPC and
        // output failures still use the configured renderer playback fallback.
        if (parseAppError(engineErr).code === 'audio.playback_target_unavailable') {
          throw engineErr
        }
        nativeQueueDelegated = false
        nativeFallbackReason = engineErr instanceof Error ? engineErr.message : String(engineErr)
        console.warn(
          '[audio-engine] Native output unavailable, falling back to Electron playback:',
          engineErr
        )
      }
    }

    if (nativePlaySuperseded || !isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    nativePlaybackActive = nativeStarted

    if (nativePlaybackActive) {
      setAudioEngineError('')
      stopRendererAudio(true)
    } else if (useNativePlayback) {
      nativeQueueDelegated = false
      clearNativePlaybackInfoIntentForLoad(loadToken)
      const htmlAudioFallbackAllowed =
        typeof window.api?.audioEngine?.isHtmlAudioFallbackAllowed === 'function'
          ? await window.api.audioEngine.isHtmlAudioFallbackAllowed()
          : false
      if (!isActiveLoad(loadToken, track)) {
        releaseLoadIfOwned()
        return
      }
      if (!htmlAudioFallbackAllowed) {
        setAudioEngineError(
          nativeFallbackReason
            ? translate(currentLocale(), 'error.audio.native_unavailable_detail', {
                reason: nativeFallbackReason
              })
            : translate(currentLocale(), 'error.audio.native_unavailable')
        )
        isPlaying.value = false
        releaseLoadIfOwned()
        return
      }
      // Degraded but audible: the HTML audio path took over, so this is a
      // warning rather than an error.
      setAudioEngineError(
        nativeFallbackReason
          ? translate(currentLocale(), 'error.audio.native_fallback', {
              reason: nativeFallbackReason
            })
          : '',
        'warning'
      )
      const rendererStarted = await playWithRendererAudio(
        track,
        playTarget,
        normalizedStartTime,
        loadToken
      )
      if (!rendererStarted || !isActiveLoad(loadToken, track)) {
        releaseLoadIfOwned()
        return
      }
      scheduleRendererPlaybackWatchdog(track, loadToken)
    } else {
      nativeQueueDelegated = false
      clearNativePlaybackInfoIntentForLoad(loadToken)
      setAudioEngineError('')
      const rendererStarted = await playWithRendererAudio(
        track,
        playTarget,
        normalizedStartTime,
        loadToken
      )
      if (!rendererStarted || !isActiveLoad(loadToken, track)) {
        releaseLoadIfOwned()
        return
      }
      scheduleRendererPlaybackWatchdog(track, loadToken)
    }

    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    advancingFromEndedTrackId = ''
    autoAdvanceInFlight = false
    loadedTrackId = track.id
    lastActiveTrack = track
    const resumeAt = playbackSessionController.consumePendingPlaybackPosition(
      track,
      normalizedStartTime
    )
    beginPlaybackPositionTransition(resumeAt, { keepRendererClockAlive: true })
    if (resumeAt > 0.05 && Math.abs(resumeAt - normalizedStartTime) > 0.05) {
      if (nativePlaybackActive) {
        void window.api.audioEngine.seek(resumeAt).catch(() => {})
      } else if (playbackAudio) {
        playbackAudio.currentTime = rendererAudioAbsolutePositionForTrack(resumeAt, track)
      }
    }
    isLoading.value = false
    isPlaying.value = true
    startVisualizationPolling()
    playbackHistoryController.maybeOfferResumeForTrack(track, resumeAt)
    playbackHistoryController.recordPlaybackStart(track, playMode.value)
  } catch (err) {
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    clearNativePlaybackInfoIntentForLoad(loadToken)
    try {
      if (await handlePlaybackFallback(track, err, loadToken)) return
    } catch (fallbackError) {
      console.warn('[audio-engine] Source recovery failed:', fallbackError)
    }
    if (!isActiveLoad(loadToken, track)) {
      releaseLoadIfOwned()
      return
    }
    console.error('[audio-engine] Playback failed:', err)
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    autoAdvanceInFlight = false
    isLoading.value = false
    isPlaying.value = false
    nativePlaybackActive = false
    nativeQueueDelegated = false
    stopVisualizationPolling(true)
  } finally {
    if (activeLoadCompletion === completion) activeLoadCompletion = null
    complete()
  }
}

function playQueueTrack(track: Track, positionSeconds = 0): void {
  const position = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0
  activateCurrentTrack(track, { resetUi: true, position })
  // While casting, re-cast the new track to the same device instead of
  // starting local engine playback underneath the cast session.
  if (castTargetUsn.value) {
    playbackHistoryController.beginPlaybackAttempt()
    void castCurrentTrackToDevice(castTargetUsn.value).catch((error) => {
      console.error('[cast] queue skip re-cast failed:', error)
      void loadAndPlay(track, position)
    })
    return
  }
  void loadAndPlay(track, position)
}

function next(): void {
  if (libraryPlayback.active.value) {
    void advanceLibraryPlayback(1, true)
    return
  }
  if (queue.value.length === 0) return
  clearCrossfadeTimer()
  if (playMode.value === 'heart') {
    void advanceHeartPlayback()
    return
  }

  if (!castTargetUsn.value && nativePlaybackActive && isNativeQueueDelegated()) {
    void advanceNativePlayback('next')
    return
  }

  applyPendingRendererPlayModeAtBoundary()
  const nextIndex = queueIndex.value + 1
  if (nextIndex < queue.value.length) {
    queueIndex.value = nextIndex
    const track = queue.value[nextIndex]
    playQueueTrack(track)
  } else {
    queueIndex.value = 0
    const track = queue.value[0]
    playQueueTrack(track)
  }
}

function jumpQueue(index: number): void {
  playerSleepTimer.interruptShutdown()
  if (libraryPlayback.active.value) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= (libraryPlayback.window.value?.queue.total ?? 0)
    )
      return
    const intent = invalidateLibraryTransportIntent()
    void libraryPlayback
      .select(index, playMode.value)
      .then((result) => {
        if (intent === libraryTransportIntent) playLibraryWindow(result)
      })
      .catch((error) => {
        if (intent === libraryTransportIntent) reportLibraryPlaybackError(error)
      })
    return
  }
  if (!Number.isInteger(index) || index < 0 || index >= queue.value.length) return
  clearCrossfadeTimer()
  queueIndex.value = index
  const track = queue.value[index]
  if (!track) return
  playQueueTrack(track)
}

async function handlePlayerShortcutAction(
  action: import('../types/settings').PlayerShortcutAction
): Promise<void> {
  await dispatchPlayerShortcut(action, {
    previous: previousFromUser,
    next: nextFromUser,
    isPlaying: () => isPlaying.value,
    togglePlay: togglePlayState,
    toggleLyrics: async () => {
      const enabled = await window.api.desktopLyrics.setEnabled(
        !appSettings.value.desktopLyrics.enabled
      )
      await updateSettings({ desktopLyrics: { ...appSettings.value.desktopLyrics, enabled } })
    },
    toggleLyricsLock: async () => {
      await updateSettings({
        desktopLyrics: {
          ...appSettings.value.desktopLyrics,
          locked: !appSettings.value.desktopLyrics.locked
        }
      })
    },
    seek: seekPlaybackFromUser,
    getVolume: () => (muted.value ? 0 : volume.value),
    setVolume: (value) => {
      volume.value = value
      muted.value = false
    },
    jumpQueue
  })
}

const rendererPauseFadeController = createRendererPauseFadeController({
  getVolume: () => volume.value
})

const nativePlaybackToggleController = createNativePlaybackToggleController({
  isPlaying,
  togglePause: () => window.api.audioEngine.togglePause(),
  setPlaybackToggleIntent,
  clearPlaybackToggleIntent,
  setAudioEngineError
})

async function togglePlayState(): Promise<void> {
  playerSleepTimer.interruptShutdown()
  const track = currentTrack.value
  if (!track) return
  if (loadedTrackId !== track.id) {
    await loadAndPlay(track, restoredPlaybackPending ? restoredPlaybackPosition : 0)
    return
  }
  const casting = Boolean(castTargetName.value)
  try {
    if (casting) {
      // Local engine stays paused while casting; only mirror transport to the device.
      const nextPlaying = !isPlaying.value
      if (isPlaying.value && !nextPlaying) {
        playbackHistoryController.maybeRecordResumeBookmark(track, getLatestPlaybackTime())
        playbackHistoryController.flushPodcastEpisodeProgress(true)
      }
      isPlaying.value = nextPlaying
      void window.api.remote
        ?.controlCast?.(nextPlaying ? { play: true } : { pause: true })
        .catch(() => {})
      return
    }
    if (nativePlaybackActive) {
      if (isPlaying.value) {
        playbackHistoryController.maybeRecordResumeBookmark(track, getLatestPlaybackTime())
        playbackHistoryController.flushPodcastEpisodeProgress(true)
      }
      await nativePlaybackToggleController.togglePause()
    } else {
      const audio = getPlaybackAudio()
      if (rendererPauseFadeController.isActive()) {
        rendererPauseFadeController.cancel()
        isPlaying.value = true
      } else if (audio.paused) {
        await stopNativeAudio()
        await audio.play()
      } else {
        playbackHistoryController.maybeRecordResumeBookmark(track, getLatestPlaybackTime())
        playbackHistoryController.flushPodcastEpisodeProgress(true)
        isPlaying.value = false
        rendererPauseFadeController.begin(audio)
      }
    }
  } catch (err) {
    console.error('[audio-engine] togglePlay failed:', err)
  }
}

function previous(): void {
  if (queue.value.length === 0 && !libraryPlayback.active.value) return
  clearCrossfadeTimer()
  if (appSettings.value.previousButtonAction === 'restart' && getLatestPlaybackTime() > 3) {
    const track = currentTrack.value
    beginPlaybackPositionTransition(0)
    if (track && loadedTrackId !== track.id) {
      restoredPlaybackPending = true
      restoredPlaybackPosition = 0
    } else if (castTargetName.value) {
      void window.api.remote?.controlCast?.({ seek: 0 }).catch(() => {})
    } else if (nativePlaybackActive) {
      window.api.audioEngine.seek(0).catch(() => {})
    } else if (playbackAudio && track) {
      playbackAudio.currentTime = rendererAudioAbsolutePositionForTrack(0, track)
    }
    return
  }
  if (libraryPlayback.active.value) {
    void advanceLibraryPlayback(-1, true)
    return
  }
  if (!castTargetUsn.value && nativePlaybackActive && isNativeQueueDelegated()) {
    void advanceNativePlayback('previous')
    return
  }

  applyPendingRendererPlayModeAtBoundary()
  const prevIndex = queueIndex.value - 1
  if (prevIndex >= 0) {
    queueIndex.value = prevIndex
    playQueueTrack(queue.value[prevIndex])
  } else {
    const lastIndex = queue.value.length - 1
    queueIndex.value = lastIndex
    playQueueTrack(queue.value[lastIndex])
  }
}

function seekPlayback(time: number): void {
  const track = currentTrack.value
  const position = track ? clampCuePlaybackPosition(track, time) : Math.max(0, time)
  if (!track) {
    beginPlaybackPositionTransition(position)
    return
  }
  if (isLoading.value) {
    restoredPlaybackPending = true
    restoredPlaybackPosition = position
    beginPlaybackPositionTransition(position)
    return
  }
  beginPlaybackPositionTransition(position)
  if (castTargetName.value) {
    void window.api.remote?.controlCast?.({ seek: position }).catch(() => {})
    return
  }
  if (nativePlaybackActive || nativeQueueDelegated) {
    window.api.audioEngine.seek(position).catch(() => {})
  } else if (playbackAudio) {
    playbackAudio.currentTime = rendererAudioAbsolutePositionForTrack(position, track)
  }
}

function nextFromUser(): void {
  playerSleepTimer.interruptShutdown()
  next()
}

function previousFromUser(): void {
  playerSleepTimer.interruptShutdown()
  previous()
}

function seekPlaybackFromUser(time: number): void {
  playerSleepTimer.interruptShutdown()
  seekPlayback(time)
}

let playerIntegrationSideEffectsSetup = false
const playerSystemIntegrations = createPlayerSystemIntegrations({
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  mediaEnabled: computed(() => Boolean(appSettings.value?.smtcEnabled)),
  discordEnabled: computed(() => appSettings.value?.discordRpcEnabled === true),
  commands: {
    togglePlay: togglePlayState,
    previous: previousFromUser,
    next: nextFromUser,
    seek: seekPlaybackFromUser
  },
  getNativeStatus: () => window.api.systemMedia.getNativeStatus(),
  mediaSession: typeof navigator !== 'undefined' ? navigator.mediaSession : undefined,
  createMetadata:
    typeof MediaMetadata !== 'undefined' ? (init) => new MediaMetadata(init) : undefined,
  discord: window.api?.discord
})

function setupPlayerIntegrationSideEffects(): void {
  if (playerIntegrationSideEffectsSetup) return
  playerIntegrationSideEffectsSetup = true
  playerSystemIntegrations.start()
  void lyricsManagement.ensureLoaded()
  playerSleepTimer.start()

  // This is deliberately owned by the player state machine rather than the
  // application shell. A user can select a track before asynchronous startup
  // work completes, and that selection must still survive a later restart.
  watch(
    [() => currentTrack.value?.queueEntryId, () => currentTrack.value?.id],
    ([entryId, trackId], [previousEntryId, previousTrackId]) => {
      if (!trackId || (entryId === previousEntryId && trackId === previousTrackId)) return
      persistSelectedTrackSession()
    },
    { flush: 'sync' }
  )

  const stopLibraryChanges = window.api.library?.onChanged((change) => {
    if (!libraryPlayback.active.value || !change) return
    const revision = change.kind === 'scan' ? change.update.libraryRevision : change.revision
    if (typeof revision !== 'number') return
    libraryPlayback.invalidateLibrary(revision)
    if (nativePlaybackActive) void queueNativeQueueStateSync().catch(reportLibraryPlaybackError)
  })
  if (stopLibraryChanges) cleanupFns.push(stopLibraryChanges)

  watch(
    isPlaying,
    () => {
      if (!isPlaying.value) playbackHistoryController.flushPodcastEpisodeProgress(true)
    },
    { immediate: true }
  )

  // Throttled podcast progress writeback while playing.
  watch(currentTime, () => {
    if (!isPlaying.value) return
    if (currentTrack.value?.source !== 'podcast') return
    playbackHistoryController.flushPodcastEpisodeProgress(false)
  })

  // Retry failed/expired next-track preparation in the latter part of playback.
  watch([currentTime, duration], ([time, total]) => {
    if (!isPlaying.value || !Number.isFinite(total) || total <= 0) return
    if (time / total < NCM_PREFETCH_TRIGGER_PROGRESS) return
    void prefetchUpcomingNcmStream()
  })

  // Prepare immediately after native startup/handoff, including queue edits.
  watch(
    [
      () => currentTrack.value?.queueEntryId ?? currentTrack.value?.id,
      queueIndex,
      queue,
      isPlaying,
      isLoading
    ],
    () => {
      if (isPlaying.value) void prefetchUpcomingNcmStream()
    }
  )

  watch(
    getNcmPrefetchScope,
    () => {
      ncmPrefetchGeneration += 1
      ncmPrefetchRetryAfter = 0
      ncmPrefetchLastSyncedKey = ''
      ncmStreamUrlCommittedAt.clear()
      const clearNcmTarget = (track: Track): Track =>
        getTrackSource(track) === 'ncm'
          ? { ...track, streamUrl: null, streamQuality: undefined }
          : track
      queue.value = queue.value.map(clearNcmTarget)
      originalQueue.value = originalQueue.value.map(clearNcmTarget)
      if (nativePlaybackActive) {
        void queueNativeQueueStateSync()
          .then(prefetchUpcomingNcmStream)
          .catch(() => {})
      }
    },
    { flush: 'sync' }
  )

  watch(
    () => appSettings.value.playMode,
    (savedPlayMode) => {
      if (libraryPlayback.active.value && requestedLibraryPlayMode !== null) return
      if (savedPlayMode && savedPlayMode !== playMode.value) {
        setPlayModeInternal(savedPlayMode, { persist: false })
      }
    },
    { immediate: true }
  )

  watch(heartModeAvailable, (available) => {
    if (!available && playMode.value === 'heart') {
      exitHeartModeToSequential()
    }
  })

  watch(
    [settingsLoaded, () => appSettings.value.softwareVolume],
    ([loaded, savedVolume]) => {
      if (!loaded) return
      if (typeof savedVolume !== 'number' || !Number.isFinite(savedVolume)) return
      const next = clampSoftwareVolume(savedVolume)
      if (Math.abs(next - volume.value) < 0.0005) {
        syncSoftwareVolumeToEngine()
        return
      }
      suppressVolumePersist = true
      volume.value = next
      if (next > 0) lastAudibleVolume.value = next
      queueMicrotask(() => {
        suppressVolumePersist = false
      })
    },
    { immediate: true, flush: 'sync' }
  )

  watch(
    [() => currentTrack.value?.queueEntryId, () => currentTrack.value?.id, queueIndex],
    () => markCurrentPersonalizedStreamTrackPlayed(),
    { flush: 'sync' }
  )

  watch(
    [() => currentTrack.value?.id, isPlaying],
    () => {
      const track = currentTrack.value
      if (track && isPlaying.value) void requestBpmAnalysisForTrack(track)
    },
    { immediate: true }
  )

  const stopBpmAnalysis = window.api?.bpmAnalysis?.onCompleted((event) => {
    applyBpmAnalysisToTrack(event.trackId, event.filePath, event.analysis)
  })
  if (stopBpmAnalysis) cleanupFns.push(stopBpmAnalysis)
}

function cyclePlayMode(): void {
  playerSleepTimer.interruptShutdown()
  const modes: PlayMode[] = ['sequential', 'listLoop', 'repeat', 'shuffle', 'heart']
  const cycleModes = heartModeAvailable.value ? modes : modes.filter((mode) => mode !== 'heart')
  const idx = cycleModes.indexOf(requestedLibraryPlayMode ?? playMode.value)
  if (idx === -1) {
    setPlayModeInternal(cycleModes[0] ?? 'sequential')
    return
  }
  setPlayModeInternal(cycleModes[(idx + 1) % cycleModes.length])
}

function setPlayModeInternal(mode: PlayMode, options: { persist?: boolean } = {}): void {
  if (mode === (requestedLibraryPlayMode ?? playMode.value)) return
  if (libraryPlayback.active.value) {
    if (mode === 'heart') return
    const intent = ++libraryPlayModeIntent
    requestedLibraryPlayMode = mode
    void libraryPlayback
      .edit({ kind: 'mode', mode }, mode, undefined, { recordUndo: false })
      .then(async (result) => {
        if (!libraryPlayback.active.value || intent !== libraryPlayModeIntent) return
        if (!result && libraryPlayback.diagnostics.queue?.total !== 0) return
        playMode.value = mode
        rendererPlayModeBoundaryPending.value = false
        if (options.persist !== false) await updateSettings({ playMode: mode })
        if (intent !== libraryPlayModeIntent || !libraryPlayback.active.value) return
        persistSelectedTrackSession()
        if (nativePlaybackActive) await queueNativeQueueStateSync()
      })
      .catch((error) => {
        if (intent === libraryPlayModeIntent)
          setAudioEngineError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (intent === libraryPlayModeIntent) requestedLibraryPlayMode = null
      })
    return
  }
  if (mode === 'heart') {
    if (!heartModeAvailable.value) return
    enterHeartMode(options)
    return
  }
  if (playMode.value === 'heart') {
    exitHeartModeToSequential()
  }
  playMode.value = mode
  // Preserve the active track, position and queue identity. Renderer fallback
  // applies the new ordering only when next/EOF reaches a track boundary.
  rendererPlayModeBoundaryPending.value = true
  // 心动模式分支在上面提前返回，因此这里只会持久化常规播放模式。
  if (options.persist !== false) {
    void updateSettings({ playMode: mode }).catch((err) => {
      console.error('[音频引擎] 保存播放模式失败:', err)
    })
  }
  if (
    !castTargetUsn.value &&
    nativePlaybackActive &&
    (isNativeQueueDelegated() || nativeQueueLoader.hasWindow())
  ) {
    // A delegated engine or window has already preloaded its next item, so a later renderer
    // boundary can no longer influence what plays next: the pending reorder would
    // never take effect and shuffle would keep playing in plain queue order.
    // Apply it now and resync the whole queue instead. The active track stays at
    // the head of the new order and loadQueue does not touch the pipeline, so
    // playback continues uninterrupted.
    applyPendingRendererPlayModeAtBoundary()
    void queueNativeQueueStateSync().catch((err) => {
      setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[音频引擎] 同步播放模式失败:', err)
    })
    return
  }
  void queueNativePlayModeSync(mode).catch((err) => {
    setAudioEngineError(err instanceof Error ? err.message : String(err))
    console.error('[音频引擎] 同步播放模式失败:', err)
  })
}

const progress = computed(() => {
  if (duration.value <= 0) return 0
  return (currentTime.value / duration.value) * 100
})

const {
  castCurrentTrackToDevice,
  stopCastSession,
  discoverCastDevices,
  refreshCastTarget,
  dispose: disposeCastController
} = createCastController({
  currentTrack,
  currentTime,
  castTargetName,
  castTargetUsn,
  getRemoteApi: () => window.api?.remote,
  resolvePlayTarget,
  isCurrentTrackLiveStream,
  recordPlaybackStart: (track) =>
    playbackHistoryController.recordPlaybackStart(track, playMode.value)
})
cleanupFns.push(disposeCastController)

export function usePlayerStore() {
  setupPlayerIntegrationSideEffects()

  const { playTrack, playTrackFromPosition } = createPlaybackSelectionController({
    beforeSelection: () => {
      playerSleepTimer.interruptShutdown()
      detachLibraryPlayback()
    },
    queue,
    queueIndex,
    playMode,
    setHeartModeContext,
    exitHeartModeForManualQueueReplacement,
    isPersonalizedStreamTrack,
    endPersonalizedStream,
    activateCurrentTrack,
    loadAndPlay,
    replaceQueue: (nextQueue, index, original) =>
      playbackQueueController.commands.replace(nextQueue, index, {
        original,
        select: false,
        synchronize: false
      })
  })

  function setPlayMode(mode: PlayMode): void {
    playerSleepTimer.interruptShutdown()
    setPlayModeInternal(mode)
  }

  if (!remoteControlBridge) {
    const musicStore = useMusicStore()
    remoteControlBridge = createRemoteControlBridge({
      tracks: musicStore.tracks,
      playlists: musicStore.playlists,
      getPlaylistTracks: musicStore.getPlaylistTracksById,
      queue,
      queueIndex,
      playMode,
      playTrack: async (track, trackList) => playTrack(track, trackList ?? musicStore.tracks.value),
      enqueueTrack,
      jumpQueue,
      removeQueueItem,
      setPlayMode,
      getStorageMode: () => window.api.library.getStorageMode(),
      database: {
        queryTracks: window.api.library.database.queryTracks,
        queryCollections: window.api.library.database.queryCollections,
        getTracksByIds: window.api.library.database.getTracksByIds,
        readLibraryQueue: window.api.library.database.readQueue
      },
      playLibraryQuery: (query, selectedId) => playLibraryQuery(query, selectedId),
      enqueueLibraryTrack: async (id) => {
        const page = await window.api.library.database.getTracksByIds([id])
        const record = page.tracks[0]
        if (!record || record.id !== id) throw new Error('track_not_found')
        enqueueTrack(libraryTrack(record))
      },
      queryLibraryPlaylist: async (playlistId, request) => {
        const playlist = musicStore.playlists.value.find((item) => item.id === playlistId)
        if (!playlist) throw new Error('playlist_not_found')
        let view = remotePlaylistViews.get(playlistId)
        if (!view) {
          view = createLibraryPlaylistView({
            syncPlaylistView: (sync) => window.api.library.database.syncPlaylistView(sync)
          })
          remotePlaylistViews.set(playlistId, view)
        }
        await view.setPlaylist(playlist, {
          revision: musicVersionRevision.value,
          versions: getMusicVersions().tracks.versions
        })
        const viewId = view.state.value.id
        if (!viewId) throw new Error(view.state.value.error || 'playlist_not_found')
        const query: LibraryQuery = {
          playlistView: viewId,
          sort: 'playlist',
          search: request.query,
          ...(request.query.trim() ? { searchLiteral: true } : {}),
          offset: request.offset,
          limit: request.limit
        }
        const page = await window.api.library.database.queryTracks(query)
        const { offset: _offset, limit: _limit, ...fullQuery } = query
        return { page, query: fullQuery }
      },
      getLibraryQueue: () => libraryPlayback.snapshot.value,
      readLibraryQueue: window.api.library.database.readQueue
    })
    const remoteApi = window.api?.remote
    if (remoteApi?.publishState) {
      cleanupFns.push(
        createRemotePlaybackPublisher({
          currentTrack,
          isPlaying,
          currentTime,
          duration,
          volume,
          muted,
          queueIndex,
          queue,
          playMode,
          castTarget: castTargetName,
          snapshotExtras: () =>
            remoteControlBridge?.snapshot() ?? { playMode: 'sequence', queueRevision: 0 },
          publish: remoteApi.publishState,
          resolveCover
        })
      )
    }
  }
  if (!removeRemoteRequestListener && window.api.remote?.onRequest) {
    removeRemoteRequestListener = window.api.remote.onRequest(async (request) => {
      if (!remoteControlBridge) throw new Error('renderer_not_ready')
      if (request.kind === 'browse') return remoteControlBridge.browse(request.payload)
      await remoteControlBridge.command(request.payload)
      return undefined
    })
  }

  async function togglePlay(): Promise<void> {
    await togglePlayState()
  }

  /** End the current transport while retaining the user's queue for replay. */
  function stopPlayback(): void {
    playerSleepTimer.interruptShutdown()
    libraryTransportIntent++
    // Cancel a pending database selection without deleting its durable queue.
    // A new explicit queue selection restores it through its own owner.
    if (libraryPlayback.busy.value) detachLibraryPlayback()
    clearCrossfadeTimer()
    resetPlaybackRuntimeStateForRestore()
    currentTrack.value = null
    isPlaying.value = false
    isLoading.value = false
    currentTime.value = 0
    resetPlaybackUiForTrackSwitch(null, 0)
  }

  function prev(): void {
    previousFromUser()
  }

  function seek(time: number): void {
    seekPlaybackFromUser(time)
  }

  function setVolume(vol: number): void {
    volume.value = Math.min(vol, appSettings.value.audioDeviceProfiles.volumeCeiling)
  }

  /** Explicit user action for bit-perfect: software gain must be unity (1.0). Does not change default 0.7. */
  function setUnityVolume(): void {
    setVolume(1)
  }

  async function refreshCurrentLyrics(): Promise<void> {
    await lyricsLoader.ensureCurrentTrackLyricsLoaded(currentTrack.value, true, true)
  }

  /**
   * Afterglow restore: adopt the engine's live state without issuing transport
   * commands. Known authority stays live; explicit unknown-queue recovery
   * attaches only the stopped SQL selection and waits for the user's play.
   */
  async function adoptAfterglowRestore(state: AfterglowRestoreState): Promise<void> {
    const snapshotQueue = Array.isArray(state.queue) ? (state.queue as Track[]) : []
    const recovery = state.recovery === 'native-queue-unknown'
    if (
      recovery &&
      (state.state !== 'stopped' ||
        state.position !== 0 ||
        state.queueToken ||
        snapshotQueue.length ||
        state.nativeQueueIndices.length ||
        state.nativeQueueEntries?.length ||
        (!state.libraryQueue && state.queueLength !== 0))
    )
      throw new Error('后台停止恢复状态无效')
    if (snapshotQueue.length === 0 && !state.libraryQueue && !recovery)
      throw new Error('后台播放队列为空，未接管原生播放')
    detachLibraryPlayback()
    const loadToken = ++activeLoadToken
    const intent = ++libraryTransportIntent
    const isCurrent = () => loadToken === activeLoadToken && intent === libraryTransportIntent
    const mode = normalizeAdoptedPlayMode(state.playMode)
    const index = state.libraryQueue
      ? state.libraryQueue.index
      : Number.isInteger(state.queueIndex)
        ? Math.min(Math.max(0, state.queueIndex), snapshotQueue.length - 1)
        : 0

    nativeQueueRevisionFence.next()
    nativeQueueLoader.clear()
    nativeSourceToTrackId.clear()
    clearNativePlaybackInfoIntent()
    clearPlaybackToggleIntent()
    resetPlaybackClock()
    stopVisualizationPolling(true)
    stopRendererAudio(true)

    let adoptedQueue: Track[] = []
    let track: Track | null
    if (recovery) {
      const result = state.libraryQueue
        ? await libraryPlayback.adoptStopped(state.libraryQueue, mode, isCurrent)
        : null
      if (!isCurrent() || (state.libraryQueue && !result)) throw new Error('后台播放接管已取消')
      track = libraryPlayback.track(result)
    } else if (state.libraryQueue) {
      const entries = state.nativeQueueEntries
      if (
        snapshotQueue.length ||
        !entries?.length ||
        entries.length !== state.nativeQueueIndices.length ||
        entries.some(
          (entry, native) =>
            entry.index !== state.nativeQueueIndices[native] || entry.index >= state.queueLength
        ) ||
        !entries.some(
          (entry) => entry.index === index && entry.queueEntryId === state.libraryQueue!.entryId
        )
      )
        throw new Error('后台播放位置映射无效，未接管原生播放')
      const result = await libraryPlayback.adoptLive(state.libraryQueue, mode, isCurrent)
      if (!result || !isCurrent()) throw new Error('后台播放接管已取消')
      track = libraryPlayback.track(result)
      const live = state.track as Track | undefined
      if (
        !track ||
        live?.id !== track.id ||
        live.queueEntryId !== track.queueEntryId ||
        !nativeQueueLoader.adoptLibrary(state.libraryQueue, entries, state.queueToken)
      ) {
        detachLibraryPlayback()
        throw new Error('后台正在播放的歌曲已变化，未接管原生播放')
      }
      track = { ...track, streamUrl: live.streamUrl }
    } else {
      adoptedQueue = toPlaybackQueueSnapshots(snapshotQueue)
      track = adoptedQueue[index]
    }
    if (!track && !recovery) throw new Error('无法读取后台正在播放的歌曲')
    const nativeQueueIndices = Array.isArray(state.nativeQueueIndices)
      ? state.nativeQueueIndices
      : null
    queue.value = adoptedQueue
    originalQueue.value = [...adoptedQueue]
    queueIndex.value = state.libraryQueue ? -1 : index
    const hydrated = track ? hydratePlaybackTrack(track) : null
    currentTrack.value = hydrated
    lastActiveTrack = recovery ? null : hydrated
    loadedTrackId = recovery ? '' : hydrated!.id
    if (hydrated) hydrateActiveTrackFromDatabase(hydrated)
    duration.value = recovery
      ? hydrated
        ? cueDuration(hydrated)
        : 0
      : state.duration > 0
        ? state.duration
        : cueDuration(hydrated!)
    setCurrentTimeImmediate(Math.max(0, state.position))
    isPlaying.value = state.state === 'playing'
    isLoading.value = false
    playbackRate.value = state.playbackRate
    volume.value = Math.min(
      Math.max(0, state.volume),
      appSettings.value.audioDeviceProfiles.volumeCeiling
    )
    playMode.value = mode
    rendererPlayModeBoundaryPending.value = false
    restoredPlaybackPending = recovery
    restoredPlaybackPosition = 0
    pendingLoadStartTime = 0
    autoAdvanceInFlight = false
    advancingFromEndedTrackId = ''
    nativePlaybackActive = !recovery
    nativeQueueAdoptionUncertain = recovery
    // A windowed adoption (current+next online queue) still lets the native
    // engine advance inside the loaded window, but the renderer must keep
    // handling queue-end so playback does not stop silently at the window tail.
    nativeQueueDelegated =
      !recovery &&
      !state.libraryQueue &&
      (!nativeQueueIndices || nativeQueueIndices.length === adoptedQueue.length)
    adoptedAfterglowRestore = true
    if (!recovery && !state.libraryQueue)
      nativeQueueLoader.adopt(adoptedQueue, {
        queueIndex: index,
        queueToken: state.queueToken,
        ...(nativeQueueIndices ? { nativeQueueIndices } : {})
      })
    if (hydrated) void lyricsLoader.ensureCurrentTrackLyricsLoaded(hydrated, true)
    if (recovery)
      setAudioEngineError(
        hydrated
          ? '后台队列结果未确认，已停止播放。点击播放重新加载所选歌曲。'
          : '后台队列结果未确认，已停止播放。请从队列中选择可用歌曲。',
        'warning'
      )
    else startRendererPlaybackClock()
  }

  return {
    adoptAfterglowRestore,
    rehydrateCurrentTrackFromLibrary,
    currentTrack,
    dominantColor,
    coverThemeColor,
    themeCoverUrl,
    themeCoverIdentity,
    isPlaying,
    isLoading,
    lyricsLoadState,
    isStreamBuffering,
    streamNowPlaying,
    currentTime,
    playbackClockSnapshot,
    estimatePlaybackClockPosition,
    duration,
    volume,
    muted,
    playbackRate,
    abLoopA,
    abLoopB,
    sleepTimerState,
    sleepTimerNotice,
    progress,
    queue,
    queueIndex,
    libraryQueue: libraryPlayback.window,
    libraryQueueSnapshot: libraryPlayback.snapshot,
    libraryQueueReference: computed(() => libraryPlayback.reference()),
    libraryQueueContentRevision: libraryPlayback.contentRevision,
    libraryQueueActive: libraryPlayback.active,
    libraryQueueBusy: libraryPlayback.busy,
    playLibraryQuery,
    playLibraryQueueEntry,
    editLibraryQueue,
    readLibraryQueuePage: libraryPlayback.loadPage,
    refreshLibraryQueue: () =>
      applyLibraryQueueEdit(() => libraryPlayback.refresh(playMode.value), true),
    canUndoQueue: computed(() =>
      libraryPlayback.active.value
        ? libraryPlayback.canUndo()
        : playbackQueueController.commands.canUndo.value
    ),
    queueUndoLabel: computed(() =>
      libraryPlayback.active.value
        ? libraryPlayback.undoLabel()
        : playbackQueueController.commands.undoLabel.value
    ),
    undoQueue: (revision?: number) =>
      libraryPlayback.active.value
        ? undoLibraryQueue(revision)
        : playbackQueueController.commands.undo(revision),
    queueWorkspace,
    queueSessions,
    playMode,
    heartModeAvailable,
    setHeartModeContext,
    personalizedStreamSession,
    personalizedStreamRemaining,
    audioEngineReady,
    audioEngineError,
    audioEngineRecoveryNotice,
    exclusiveMode,
    visualizerActive,
    audioOutput,
    audioDevice,
    audioOutputOptions,
    audioDeviceOptions,
    audioOutputDeviceOptions,
    /** Native→logical queue mapping for the pre-unload handoff. */
    getNativeQueueIndices: (): number[] | null => nativeQueueLoader.getCommittedIndices(),
    handoffSleepTimerForAfterglow: playerSleepTimer.handoffForAfterglow,
    audioProcessing,
    audioOutputConfig,
    audioOutputConfigApplyStatus,
    dspOutputStage,
    dspStereoImage,
    playbackInfo,
    isCurrentTrackNativePlaybackInfo,
    loudnormStatus,
    loudnormStatusSource,
    outputInfo,
    visualizationData,
    acquireVisualizationConsumer,
    castTargetName,
    cyclePlayMode,
    setPlayMode,
    enqueueTrack,
    appendQueueTracks,
    appendQueueTracksAsync,
    appendLibraryQueuePages,
    startPersonalizedStream,
    appendPersonalizedStreamTracks,
    endPersonalizedStream,
    playNextTrack,
    removeQueueItem,
    clearQueue,
    reorderQueue,
    saveQueueAsPlaylist,
    playTrack,
    playTrackFromPosition,
    togglePlay,
    stopPlayback,
    next: nextFromUser,
    prev,
    seek,
    setAbLoopPoint,
    toggleAbLoopAtCurrentTime,
    clearAbLoop,
    resumeOffer,
    acceptResumeOffer,
    dismissResumeOffer,
    addManualBookmarkAtCurrentTime,
    setVolume,
    flushSoftwareVolumePersist,
    setPlaybackRate,
    toggleMute,
    configureSleepTimer,
    cancelSleepTimer,
    setUnityVolume,
    toggleExclusiveMode,
    setAudioOutput,
    setAudioDevice,
    setAudioOutputConfig,
    refreshAudioOutputState,
    dismissAudioEngineRecoveryNotice,
    setAudioProcessing,
    applyAudioProcessingState,
    setOutputStage,
    setStereoImage,
    toggleDspEnabled,
    toggleEqEnabled,
    toggleCrossfeed,
    toggleGapless,
    setReplayGainMode,
    setCrossfeedStrength,
    selectImpulseResponse,
    clearImpulseResponse,
    restorePlaybackSession,
    createPlaybackSession,
    removeUnavailableTracks,
    clearBpmAnalysisFromPlaybackState,
    refreshCurrentLyrics,
    castToDevice: castCurrentTrackToDevice,
    stopCast: stopCastSession,
    discoverCastDevices,
    refreshCastTarget,
    formatTime
  }
}
