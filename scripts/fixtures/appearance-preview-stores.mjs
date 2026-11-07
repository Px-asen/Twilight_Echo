import { ref } from 'vue'
import { normalizePlayerBarSettings } from '__SHARED__/playerBar.ts'
import { normalizeNavigationPagePreferences } from '__SHARED__/navigationPages.ts'
import { normalizeLiquidGlass } from '__SHARED__/liquidGlass.ts'
import { formatTime } from '@renderer/utils/playerTime.ts'
const boundary = { native: 0, storeActions: 0, intervals: 0, persistence: 0, network: 0 }
window.previewBoundary = boundary
window.previewErrors = []
window.nativeActions = 0
window.addEventListener('error', (event) => window.previewErrors.push(event.message))
window.addEventListener('unhandledrejection', (event) =>
  window.previewErrors.push(String(event.reason))
)
const forbidden = (kind, name) => () => {
  boundary[kind]++
  if (kind === 'native') window.nativeActions++
  const error = Error('preview crosses ' + kind + ' boundary: ' + name)
  console.error(error.stack)
  throw error
}
const core = {
  state: ref({
    epoch: 'preview',
    phase: 'ready',
    libraryRevision: 1,
    playlistsRevision: 1,
    versionsRevision: 1,
    bookmarksRevision: 1,
    pluginsRevision: 1
  }),
  query: forbidden('native', 'core.query'),
  command: forbidden('native', 'core.command'),
  attach: forbidden('native', 'core.attach'),
  subscribe: forbidden('native', 'core.subscribe')
}
export const useCoreConnection = () => core
// Missing sample artwork may emit diagnostic metadata, never media or library IPC.
const api = (path) =>
  new Proxy(() => {}, {
    get: (_, key) => (key === 'then' ? undefined : api(path + '.' + String(key))),
    apply: (_, __, args) => {
      if (path === 'api.diagnostics.record') {
        if (JSON.stringify(args).includes('PRIVATE_'))
          throw Error('preview diagnostic leaks personal data')
        return
      }
      return forbidden('native', path)()
    }
  })
export function installPreviewBoundary() {
  window.api = api('api')
  window.setInterval = forbidden('intervals', 'setInterval')
  window.fetch = forbidden('network', 'fetch')
  XMLHttpRequest.prototype.open = forbidden('network', 'XMLHttpRequest.open')
  for (const name of ['setItem', 'removeItem', 'clear'])
    Storage.prototype[name] = forbidden('persistence', name)
}
const settings = ref({
  theme: 'dark',
  motionPreference: 'off',
  playerBar: normalizePlayerBarSettings(null),
  navigationPages: normalizeNavigationPagePreferences(null),
  desktopLyrics: { enabled: false },
  sleepTimer: { defaultMinutes: 30 }
})
window.previewSettings = settings
const privateTrack = {
  id: 'private-library-fixture',
  title: 'PRIVATE_LIBRARY_SENTINEL',
  artist: 'PRIVATE_ARTIST_SENTINEL',
  album: 'PRIVATE_ALBUM_SENTINEL',
  duration: 4321,
  source: 'local',
  cover: null,
  filePath: 'private-fixture.flac'
}
const audioProcessing = ref({
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  eqEnabled: false,
  convolverEnabled: false,
  gapless: true
})
const playbackInfo = ref(null),
  outputInfo = ref(null)
const player = {
  currentTrack: ref(privateTrack),
  dominantColor: ref('#aabbcc'),
  isPlaying: ref(false),
  isStreamBuffering: ref(false),
  streamNowPlaying: ref(''),
  currentTime: ref(62),
  duration: ref(180),
  progress: ref(35),
  volume: ref(0.7),
  playbackRate: ref(1),
  sleepTimerState: ref(null),
  sleepTimerNotice: ref(''),
  queue: ref([privateTrack]),
  queueIndex: ref(0),
  playMode: ref('sequential'),
  exclusiveMode: ref(false),
  audioOutput: ref('wasapi'),
  audioOutputOptions: ref([]),
  audioDevice: ref('auto'),
  audioOutputDeviceOptions: ref([]),
  audioProcessing,
  audioOutputConfig: ref({}),
  dspOutputStage: ref({}),
  dspGraphStatus: ref(null),
  dspStereoImage: ref({}),
  playbackInfo,
  loudnormStatus: ref(null),
  outputInfo,
  visualizationData: ref({ spectrum: [], waveform: [], active: false }),
  abLoopA: ref(null),
  abLoopB: ref(null),
  resumeOffer: ref(null),
  canUndoQueue: ref(false),
  queueUndoLabel: ref(''),
  queueSessions: ref([]),
  queueWorkspace: {
    history: ref([]),
    ensureLoaded: forbidden('storeActions', 'queueWorkspace.ensureLoaded')
  },
  castTargetName: ref(''),
  libraryQueueActive: ref(false),
  libraryQueueSnapshot: ref(null),
  libraryQueueContentRevision: ref(0),
  libraryQueueBusy: ref(false),
  formatTime
}
for (const name of 'readLibraryQueuePage playLibraryQueueEntry editLibraryQueue refreshLibraryQueue setPlaybackRate acquireVisualizationConsumer cyclePlayMode togglePlay next prev seek toggleAbLoopAtCurrentTime clearAbLoop refreshCurrentLyrics acceptResumeOffer dismissResumeOffer addManualBookmarkAtCurrentTime playTrack enqueueTrack playNextTrack removeQueueItem clearQueue reorderQueue saveQueueAsPlaylist undoQueue toggleExclusiveMode setPlayMode setVolume setUnityVolume configureSleepTimer cancelSleepTimer setAudioProcessing setAudioOutputConfig setAudioOutput setAudioDevice setOutputStage setStereoImage refreshAudioOutputState toggleDspEnabled toggleEqEnabled toggleCrossfeed toggleGapless setReplayGainMode setCrossfeedStrength selectImpulseResponse clearImpulseResponse castToDevice stopCast discoverCastDevices refreshCastTarget'.split(
  ' '
))
  player[name] = forbidden('storeActions', name)
const music = {
  tracks: ref([privateTrack]),
  albums: ref([]),
  artists: ref([]),
  genres: ref([]),
  localPlaylists: ref([]),
  aggregatePlaylists: ref([]),
  folders: ref([]),
  libraryRepairReport: ref(null),
  excludedTracks: ref([]),
  isScanning: ref(false),
  libraryScanStatus: ref({ state: 'idle' }),
  libraryScanProgress: ref(null),
  isFavoriteTrack: () => false
}
for (const name of 'addToPlaylist addTracksToPlaylist removeFromPlaylist createPlaylist createPlaylistWithTracks addFavoriteTrack removeFavoriteTrack'.split(
  ' '
))
  music[name] = forbidden('storeActions', name)
export const useSettingsStore = () => ({
  settings,
  updateSettings: forbidden('storeActions', 'updateSettings')
})
export const useMusicStore = () => music
export const usePlayerStore = () => player
export const useThemeStore = () => ({
  presetLayout: ref('default'),
  effectiveSurfaceMaterial: ref('standard'),
  effectiveLiquidGlass: ref(normalizeLiquidGlass(null))
})
export const useAudioOutputDspStore = () => ({ audioProcessing, playbackInfo, outputInfo })
export const storeToRefs = (store) => store
export const useListeningStatsStore = () => ({
  overview: ref({ days: {} }),
  listeningStats: ref({ days: {}, tracks: {} })
})
export const waitForListeningStatsReady = async () => {}
export const libraryListeningProjection = {
  state: ref({ mode: 'json', ready: true, pending: false, error: '' }),
  ensure: forbidden('storeActions', 'listeningProjection.ensure'),
  retry: forbidden('storeActions', 'listeningProjection.retry')
}
export const buildLastPlayedByTrackId = (stats) => {
  const result = new Map()
  for (const stat of Object.values(stats.tracks)) {
    if (stat.track?.id) result.set(stat.track.id, stat.lastPlayed)
    for (const sourceId of stat.sourceIds ?? []) result.set(sourceId.trackId, stat.lastPlayed)
  }
  return result
}
export const getMostListenedTracks = () => [{ id: privateTrack.id, track: privateTrack }]
export const getRecentTracks = () => [{ id: privateTrack.id, track: privateTrack }]
export const getTopTracks = getRecentTracks
export const getTopArtists = () => []
export const useNcmStore = () => ({
  isLoggedIn: ref(true),
  profile: ref({
    nickname: 'PRIVATE_PROFILE_SENTINEL',
    avatarUrl: 'PRIVATE_AVATAR_SENTINEL',
    userId: 7
  })
})
export const useProviderStore = () => ({
  providers: ref([{ id: 'ncm', name: 'Fixture', capabilities: ['login'] }])
})
export const useAppNoticeStore = () => ({
  unreadCount: ref(0),
  activeTaskCount: ref(0),
  doNotDisturb: ref(false),
  pushNotice: forbidden('storeActions', 'pushNotice')
})
export const usePlaybackBookmarks = () => ({
  bookmarksFor: () => [],
  ensureLoaded: forbidden('storeActions', 'bookmarks.ensureLoaded'),
  renameBookmark: forbidden('storeActions', 'renameBookmark'),
  removeBookmark: forbidden('storeActions', 'removeBookmark')
})
export const useLyricsManagement = () => ({
  document: ref({ showTranslation: true }),
  entryFor: () => null,
  selectSource: forbidden('storeActions', 'lyrics.selectSource'),
  updateTrack: forbidden('storeActions', 'lyrics.updateTrack'),
  updateVisibility: forbidden('storeActions', 'lyrics.updateVisibility')
})
export const useExtensionRegistry = (options) => {
  if (options?.listen !== false) forbidden('native', 'preview extension subscription')()
  return { uiContributions: ref([]), syncExtensions: forbidden('storeActions', 'syncExtensions') }
}
export const useMediaProviders = (options) => {
  if (options?.sync !== false) forbidden('native', 'preview provider synchronization')()
  return { get: () => undefined, list: () => [] }
}
export const syncPluginProviders = forbidden('storeActions', 'syncPluginProviders')
