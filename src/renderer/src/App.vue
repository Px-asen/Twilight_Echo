<script setup lang="ts">
// Both lazy pages need these foundations before either page has been opened.
import './components/settings-page/SettingsPage.css'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import { mountWorkshopDecorations } from '@renderer/components/theme-workshop/workshopDecorations'
import {
  ref,
  shallowRef,
  provide,
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick,
  watch,
  defineAsyncComponent
} from 'vue'
import TitleBar from './components/TitleBar.vue'
import { providePageDock } from './app/pageDock'
import AppBackgroundLayer from './components/AppBackgroundLayer.vue'
import AppearanceLayersHost from './components/AppearanceLayersHost.vue'
import {
  appearanceEditorOpen,
  appearanceChromePreview,
  appearanceFullWindowPreview
} from './composables/appearanceEditorState.ts'
const BackgroundAppearanceCustomizer = defineAsyncComponent(
  () => import('./components/BackgroundAppearanceCustomizer.vue')
)
const SideMenu = defineAsyncComponent(() => import('@renderer/components/SideMenu.vue'))
const SidebarBookmark = defineAsyncComponent(
  () => import('@renderer/components/SidebarBookmark.vue')
)
import {
  buildNavigationPages,
  type NavigationPageTarget,
  type StreamingPageTab
} from '@renderer/app/navigationPages.ts'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import {
  getNavigationLibraryProviders,
  getStreamingHomeProviders,
  getStreamingDiscoveryProviders
} from '@renderer/utils/streamingNavigation.ts'
const RecentPlaybackPage = defineAsyncComponent(
  () => import('@renderer/components/navigation/RecentPlaybackPage.vue')
)
const PlayerBar = defineAsyncComponent(() => import('./components/PlayerBar.vue'))
const LocalDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/LocalHome.vue')
)
const SongList = defineAsyncComponent(() => import('./components/SongList.vue'))
const ApplicationPlaylistsPage = defineAsyncComponent(
  () => import('@renderer/components/navigation/ApplicationPlaylistsPage.vue')
)
const PlayingMusic = defineAsyncComponent(() => import('./components/PlayingMusic.vue'))
const StreamingPage = defineAsyncComponent(() => import('./components/StreamingPage.vue'))
const RadioPodcastPage = defineAsyncComponent(() => import('./components/RadioPodcastPage.vue'))
const NetworkSourcesPage = defineAsyncComponent(() => import('./components/NetworkSourcesPage.vue'))
const LoginPage = defineAsyncComponent(() => import('./components/LoginPage.vue'))
const AccountPage = defineAsyncComponent(() => import('./components/AccountPage.vue'))
const SettingsPage = defineAsyncComponent(() => import('./components/SettingsPage.vue'))
const AppearancePage = defineAsyncComponent(() => import('./components/AppearancePage.vue'))
const PluginPage = defineAsyncComponent(() => import('./components/PluginPage.vue'))
const AudioWorkspace = defineAsyncComponent(() => import('./components/AudioWorkspace.vue'))
const ListeningAnalyticsPage = defineAsyncComponent(
  () => import('./components/ListeningAnalyticsPage.vue')
)
const CommandPalette = defineAsyncComponent(() => import('@renderer/components/CommandPalette.vue'))
const QueueWorkspaceDialog = defineAsyncComponent(
  () => import('@renderer/components/player-bar/QueueWorkspaceDialog.vue')
)
const PluginExtensionPage = defineAsyncComponent(
  () => import('./components/PluginExtensionPage.vue')
)
const OnboardingWizard = defineAsyncComponent(
  () => import('./components/onboarding/OnboardingWizard.vue')
)
import type { OnboardingFinishResult } from './components/onboarding/OnboardingWizard.vue'
import { useMusicStore } from './stores/useMusicStore'
import { useNcmStore } from './stores/useNcmStore'
import { isPlaybackSpace } from '@renderer/app/playbackKeyboard'
import { usePlayerStore } from './stores/usePlayerStore'
import { useSettingsStore } from './stores/useSettingsStore'
import { useThemeStore, applyActiveTheme, bootstrapThemeRuntime } from './stores/useThemeStore'
import { getStartupSnapshot } from './app/startupSnapshot'
import { useExtensionRegistry } from './extensions/registry'
import { syncPluginProviders, useMediaProviders } from './providers'
import { useAppNavigation } from './app/useAppNavigation'
import { createNavigationSessionPersistence } from './app/useNavigationSessionPersistence'
import { useCommandPalette } from '@renderer/app/useCommandPalette.ts'
import { useBackStack } from './app/useBackStack'
import { hasDismissLayer, useEscapeToClose } from '@renderer/app/useDismissLayer'
import { createPlaybackSessionPersistence } from './app/usePlaybackSessionPersistence'
import { useSideMenuClearance } from './app/useSideMenuClearance'
import { overlaySidebarsNeedExclusiveMode } from './app/overlaySidebars'
import { useMiniPlayerSync } from './app/useMiniPlayerSync'
import { useDesktopLyricsPublisher } from './app/useDesktopLyricsPublisher.ts'
import { useFavoriteButton } from './components/player-bar/useFavoriteButton'
import { useMotionPreference } from './app/useMotionPreference'
import { useLanguagePreference } from './app/useLocale'
import { useLiquidGlassEnvironment } from './composables/useLiquidGlassEnvironment'
import { useAppNoticeStore } from './stores/useAppNoticeStore'
import { getTrackSource } from './utils/logicalTrackModel'
import type { QueuePlaybackOrigin } from './types/music'
import type { StreamingCollectionNavigationRequest } from './utils/queuePlaybackOrigin.ts'
import { scheduleIdleTask, type IdleTaskHandle } from './app/scheduleIdleTask'
import {
  getPrimaryStreamingArtistId,
  getPrimaryStreamingArtistName,
  type StreamingArtistNavigationRequest
} from './utils/streamingArtistResolution'
const AppNoticeHost = defineAsyncComponent(() => import('./components/AppNoticeHost.vue'))
import LiquidGlassDefs from './components/LiquidGlassDefs.vue'
import { resolvePlayerBarPresentation } from '../../shared/playerBar.ts'
import type { AppBackgroundPage } from './types/settings'
import {
  soundFieldPlaybackKey,
  usesSoundFieldSidebar
} from '@renderer/components/local-dashboard/soundFieldPlayback'

type TitleSurface = 'default' | 'settings' | 'streaming'
let idleLoginCheck: IdleTaskHandle | null = null

const navigation = useAppNavigation({
  appearancePreviewActive: () => appearanceFullWindowPreview.value
})
const navigationPersistence = createNavigationSessionPersistence(navigation)
const {
  menuOpen,
  isHome,
  showPlayingPage,
  showStreamingPage,
  showRecentPage,
  streamingTab,
  activePageId,
  pageTarget,
  showRadioPodcastPage,
  showNetworkSourcesPage,
  showLoginPage,
  showAccountPage,
  accountInitialProviderId,
  loginPageMode,
  loginInitialProviderId,
  showSettingsPage,
  showAppearancePage,
  appearanceNavigationTarget,
  showThemeStudioPage,
  themeStudioInitialDomain,
  showPluginPage,
  showEqualizerPage,
  showDspRackPage,
  showAudioWorkspace,
  audioWorkspaceTab,
  activePluginPage,
  settingsInitialSection,
  settingsNavigationTarget,
  activeCategory,
  activeFilter,
  songlistTransitionName,
  showStreamingSurface,
  localViewVisible,
  collapseMenu,
  onSelectView,
  openPlayingPage: showPlaying,
  closePlayingPage,
  enterStreamingMode,
  returnToLocalMode,
  openLoginPage,
  closeLoginPage,
  closeSettingsPage,
  closeAppearancePage,
  hidePluginPage,
  closeMissingPluginPage
} = navigation
const audioWorkspaceRef = ref<{
  requestLeave: () => Promise<boolean>
  focusEditorWindow: () => void
  showEditorTab: (tab: 'equalizer' | 'effects') => Promise<void>
} | null>(null)
const audioWorkspaceDetached = ref(false)
let leavingAudioWorkspace = false
async function runAfterAudioLeave(action: () => void | Promise<void>): Promise<void> {
  if (!showAudioWorkspace.value) {
    await action()
    return
  }
  const workspace = audioWorkspaceRef.value
  if (leavingAudioWorkspace || !workspace) return
  const initialOverlay = navigation.session.value.overlay
  leavingAudioWorkspace = true
  try {
    if (!(await workspace.requestLeave())) return
    if (
      audioWorkspaceRef.value !== workspace ||
      navigation.session.value.overlay !== initialOverlay
    )
      return
    await action()
  } finally {
    leavingAudioWorkspace = false
  }
}
function openAudioWorkspace(): void {
  if (audioWorkspaceDetached.value) {
    audioWorkspaceRef.value?.focusEditorWindow()
    return
  }
  navigation.openAudioWorkspace()
}
function openEqualizerPage(): void {
  if (audioWorkspaceDetached.value) {
    void audioWorkspaceRef.value?.showEditorTab('equalizer')
    return
  }
  if (showAudioWorkspace.value && audioWorkspaceTab.value === 'equalizer') return
  void runAfterAudioLeave(navigation.openEqualizerPage)
}
function openDspRackPage(): void {
  if (audioWorkspaceDetached.value) {
    void audioWorkspaceRef.value?.showEditorTab('effects')
    return
  }
  if (showAudioWorkspace.value && audioWorkspaceTab.value === 'effects') return
  void runAfterAudioLeave(navigation.openDspRackPage)
}
function openDspSettings(): void {
  openDspRackPage()
}
function openSettingsPage(...args: Parameters<typeof navigation.openSettingsPage>): void {
  void runAfterAudioLeave(() => navigation.openSettingsPage(...args))
}
function openAppearancePage(...args: Parameters<typeof navigation.openAppearancePage>): void {
  void runAfterAudioLeave(() => navigation.openAppearancePage(...args))
}
function openThemeStudioPage(...args: Parameters<typeof navigation.openThemeStudioPage>): void {
  void runAfterAudioLeave(() => navigation.openThemeStudioPage(...args))
}
function openPlaybackSettings(): void {
  void runAfterAudioLeave(navigation.openPlaybackSettings)
}
function openPluginPage(): void {
  void runAfterAudioLeave(navigation.openPluginPage)
}
async function requestCloseAudioWorkspace(): Promise<void> {
  await runAfterAudioLeave(navigation.closeAudioWorkspace)
  if (!showAudioWorkspace.value)
    void nextTick(() => document.querySelector<HTMLButtonElement>('.title-bar .dsp-btn')?.focus())
}
const pageDock = providePageDock(() => navigation.session.value.overlay ?? activePageId.value)
const accountAnchor = shallowRef<HTMLElement | null>(null)
const noticeHistoryTarget = ref<HTMLElement | null>(null)
const { centerOpen } = useAppNoticeStore()
watch([showAccountPage, noticeHistoryTarget], ([visible, target]) => {
  centerOpen.value = visible && target !== null
})
// Keep the wallpaper inside its overlay through the leave transition. An idle
// overlay must hide its embedded painter, which would otherwise cover home.
const settingsOverlayLeaves = ref(0)
const settingsOverlayVisible = computed(
  () => showSettingsPage.value || showAppearancePage.value || settingsOverlayLeaves.value > 0
)
function retainSettingsOverlay(): void {
  settingsOverlayLeaves.value += 1
}
function releaseSettingsOverlay(): void {
  settingsOverlayLeaves.value = Math.max(0, settingsOverlayLeaves.value - 1)
}
const { pushNotice } = useAppNoticeStore()
let stopAppUpdateNotifications: (() => void) | null = null
let updateNotificationsDisposed = false
onMounted(() => {
  void import('./app/useAppUpdateNotifications.ts')
    .then(({ startAppUpdateNotifications }) => {
      if (!updateNotificationsDisposed) {
        stopAppUpdateNotifications = startAppUpdateNotifications(() => openSettingsPage('about'))
      }
    })
    .catch((error) => console.warn('[update] Unable to initialize update notifications:', error))
})
onBeforeUnmount(() => {
  updateNotificationsDisposed = true
  stopAppUpdateNotifications?.()
})

// One global back affordance on the title bar. Every full-screen page
// registers a single base layer here; deeper in-page states (streaming
// details, login QR flow, EQ advanced settings, …) push themselves on top of
// it, so the button always resolves the innermost layer first.
const backStack = useBackStack()
backStack.useBackHandler(navigation.canGoBackPage, navigation.goBackPage)
backStack.useBackHandler(showPlayingPage, closePlayingPage)
backStack.useBackHandler(showSettingsPage, () => void requestCloseSettingsWorkspace())
// The appearance workspace owns its back handler so all editors can protect drafts.
backStack.useBackHandler(showPluginPage, hidePluginPage)
backStack.useBackHandler(showAudioWorkspace, () => void requestCloseAudioWorkspace())
backStack.useBackHandler(showLoginPage, closeLoginPage)
backStack.useBackHandler(showAccountPage, closeAccountSubview, '收起我的')
const toggleMenuNavigation = navigation.createToggleMenuHandler()
const toggleMenu = () => void runAfterAudioLeave(toggleMenuNavigation)
function closeNavigation(): void {
  const focusWasInside = document.querySelector('.side-menu')?.contains(document.activeElement)
  collapseMenu()
  if (focusWasInside) document.querySelector<HTMLButtonElement>('.sidebar-bookmark')?.focus()
}
function handleQueueOpened(): void {
  if (overlaySidebarsNeedExclusiveMode()) closeNavigation()
}
const toggleSettingsPage = () =>
  showSettingsPage.value ? void requestCloseSettingsWorkspace() : openSettingsPage()
const appearancePageRef = ref<InstanceType<typeof AppearancePage> | null>(null)
const toggleAppearancePage = () =>
  showAppearancePage.value ? appearancePageRef.value?.requestClose() : openAppearancePage()
const settingsPageVisited = ref(false)
const appearancePageVisited = ref(false)
watch(
  showSettingsPage,
  (visible) => {
    if (visible) settingsPageVisited.value = true
  },
  { immediate: true }
)
watch(
  showAppearancePage,
  (visible) => {
    if (visible) appearancePageVisited.value = true
  },
  { immediate: true }
)
const settingsWorkspaceRetained = computed(
  () =>
    showSettingsPage.value ||
    showAppearancePage.value ||
    navigation.session.value.overlayHistory.some(
      (page) => page === 'settings' || page === 'appearance'
    )
)
const settingsPageRetained = computed(
  () => settingsPageVisited.value && settingsWorkspaceRetained.value
)
const appearancePageRetained = computed(
  () => appearancePageVisited.value && settingsWorkspaceRetained.value
)
watch(settingsWorkspaceRetained, (retained) => {
  if (!retained) {
    settingsPageVisited.value = false
    appearancePageVisited.value = false
  }
})
let closingSettingsWorkspace = false
async function requestCloseSettingsWorkspace(): Promise<void> {
  if (closingSettingsWorkspace) return
  closingSettingsWorkspace = true
  try {
    if (
      appearancePageRetained.value &&
      (!appearancePageRef.value || !(await appearancePageRef.value.requestLeave()))
    )
      return
    closeSettingsPage()
  } finally {
    closingSettingsWorkspace = false
  }
}
let returningHome = false
async function handleTitleHome(): Promise<void> {
  if (returningHome) return
  returningHome = true
  try {
    await runAfterAudioLeave(async () => {
      if (appearancePageRetained.value) {
        if (!appearancePageRef.value || !(await appearancePageRef.value.requestLeave())) return
      }
      streamingArtistRequest.value = null
      streamingCollectionRequest.value = null
      navigation.goHome()
    })
  } finally {
    returningHome = false
  }
}
function openSidebarPlugins(): void {
  collapseMenu()
  pluginInitialTab.value = 'discover'
  openPluginPage()
}
const pluginInitialTab = ref<'installed' | 'discover'>('installed')
watch(showPluginPage, (visible) => {
  if (!visible) pluginInitialTab.value = 'installed'
})

const coverOrigin = ref({ x: 48, y: window.innerHeight - 36, w: 48, h: 48 })
const streamingArtistRequest = ref<StreamingArtistNavigationRequest | null>(null)
const streamingCollectionRequest = ref<StreamingCollectionNavigationRequest | null>(null)
const titleSearchQuery = ref('')
const streamingSearchRequest = ref<{ key: number; query: string } | null>(null)
let streamingSearchRequestKey = 0
let navigatingTitleSearch = false
let streamingCollectionRequestKey = 0
let streamingArtistRequestKey = 0
// Keep StreamingPage mounted so contextual navigation preserves its detail.
// Explicit sidebar selection returns the selected tab to its root instead.
const streamingPageTabs = shallowRef<StreamingPageTab[]>([])
const streamingRootNavigationRevisions = ref<Partial<Record<StreamingPageTab, number>>>({})

function handleTitleSearchQuery(query: string): void {
  titleSearchQuery.value = query
  if (!query.trim() && showStreamingSurface.value && streamingTab.value === 'search') {
    streamingSearchRequest.value = { key: ++streamingSearchRequestKey, query: '' }
  }
}

async function handleTitleSearch(query: string): Promise<void> {
  const term = query.trim()
  if (!term || navigatingTitleSearch) return
  navigatingTitleSearch = true
  try {
    await runAfterAudioLeave(async () => {
      if (
        appearancePageRetained.value &&
        (!appearancePageRef.value || !(await appearancePageRef.value.requestLeave()))
      )
        return
      streamingArtistRequest.value = null
      streamingCollectionRequest.value = null
      titleSearchQuery.value = term
      streamingSearchRequest.value = { key: ++streamingSearchRequestKey, query: term }
      collapseMenu()
      enterStreamingMode('search')
    })
  } finally {
    navigatingTitleSearch = false
  }
}

function selectSidebarPage(target: NavigationPageTarget): void {
  void runAfterAudioLeave(() => {
    streamingArtistRequest.value = null
    streamingCollectionRequest.value = null
    if (target.kind === 'streaming') {
      const revisions = streamingRootNavigationRevisions.value
      revisions[target.tab] = (revisions[target.tab] ?? 0) + 1
    }
    navigation.selectSidebarPage(target)
  })
}
watch(
  [showStreamingPage, streamingTab],
  ([visible, tab]) => {
    if (visible && !streamingPageTabs.value.includes(tab))
      streamingPageTabs.value = [...streamingPageTabs.value, tab]
  },
  { immediate: true }
)
const recentPageMounted = ref(false)
watch(
  showRecentPage,
  (visible) => {
    if (visible) recentPageMounted.value = true
  },
  { immediate: true }
)
const showOnboarding = ref(false)
const onboardingSaving = ref(false)
const onboardingSaveError = ref('')

function applyExternalNavigation(target: 'local' | 'streaming' | 'settings'): void {
  void runAfterAudioLeave(() => {
    showOnboarding.value = false
    if (target === 'settings') {
      navigation.openSettingsPage('general')
      return
    }
    if (target === 'streaming') {
      enterStreamingMode()
    } else {
      onSelectView('dashboard', null)
    }
  })
}
const titleMenuOpen = computed(() => menuOpen.value)

function handleTitleBack(): void {
  backStack.goBack()
}

function onGlobalBackKeydown(event: KeyboardEvent): void {
  if (isPlaybackSpace(event)) {
    event.preventDefault()
    togglePlay()
    return
  }
  if (event.defaultPrevented || event.repeat || event.isComposing) return
  if (event.key === 'Escape') {
    if (hasDismissLayer()) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]'
      )
    )
      return
    if (backStack.goBack()) event.preventDefault()
    return
  }
  if (
    event.key === 'ArrowLeft' &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    backStack.goBack()
  ) {
    event.preventDefault()
  }
}

function openPlayingPage(rect: { x: number; y: number; w: number; h: number }): void {
  coverOrigin.value = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h }
  showPlaying()
}

function handleCoverClick(rect: { x: number; y: number; w: number; h: number }): void {
  if (showPlayingPage.value) {
    closePlayingPage()
  } else {
    openPlayingPage(rect)
  }
}

function handleExitPlayingPage(): void {
  closePlayingPage()
}

function handleStreamingLogin(providerId?: string | null): void {
  openLoginPage(providerId ?? null)
}

function closeAccountSubview(returnFocus = true): void {
  navigation.closeAccountPage()
  if (returnFocus) void nextTick(() => accountAnchor.value?.focus({ preventScroll: true }))
}

function handleTitleLogin(providerId?: string | null, anchor?: HTMLElement): void {
  collapseMenu()
  if (showAccountPage.value) closeAccountSubview()
  else {
    accountAnchor.value = anchor ?? document.querySelector('.title-bar .login-btn')
    navigation.openAccountPage(providerId ?? null)
  }
}

let navigatingFromAccount = false
async function navigateFromAccount(target: NavigationPageTarget | 'plugins'): Promise<void> {
  if (navigatingFromAccount) return
  navigatingFromAccount = true
  try {
    if (showAppearancePage.value) {
      if (!appearancePageRef.value || !(await appearancePageRef.value.requestLeave())) return
    }
    if (target === 'plugins') openPluginPage()
    else selectSidebarPage(target)
  } finally {
    navigatingFromAccount = false
  }
}

function handleReopenOnboarding(): void {
  closeSettingsPage()
  onboardingSaveError.value = ''
  showOnboarding.value = true
}

async function handleOnboardingFinish(result: OnboardingFinishResult): Promise<void> {
  if (onboardingSaving.value) return
  onboardingSaving.value = true
  onboardingSaveError.value = ''
  try {
    await updateSettings(result.patch)
  } catch (error) {
    onboardingSaveError.value = `保存失败，请重试：${error instanceof Error ? error.message : String(error)}`
    return
  } finally {
    onboardingSaving.value = false
  }
  showOnboarding.value = false
  if (result.action === 'streaming' || result.action === 'streaming-login') {
    enterStreamingMode()
  } else {
    // No-op on first run; returns home when the wizard was reopened from
    // settings while the streaming page was active.
    returnToLocalMode()
  }
  if (result.openMiniPlayer) {
    try {
      await window.api.miniPlayer.open()
    } catch (error) {
      pushNotice({
        kind: 'warning',
        message: `打开迷你播放器失败：${error instanceof Error ? error.message : String(error)}`
      })
    }
  }
  if (result.action === 'streaming-login') {
    openLoginPage('ncm')
  } else if (result.openPluginMarket) {
    // Login takes precedence — the market stays one click away from the
    // title bar, while a missed login blocks the whole streaming flow.
    openPluginPage()
  }
}

function handleLoginSuccess(): void {
  closeLoginPage()
}

function handleLoginConfigure(): void {
  closeLoginPage()
  openSettingsPage('connections')
}

const musicStore = useMusicStore()
const {
  loadLibrary,
  loadPlaylists,
  flushSaveLibrary,
  flushPlaylists,
  handleLibraryChange,
  startStartupLibraryScan,
  applyLibraryScanProgress,
  applyLibraryScanStatus
} = musicStore
const { checkLogin } = useNcmStore()
const {
  currentTrack,
  currentTime,
  estimatePlaybackClockPosition,
  duration,
  playbackRate,
  isPlaying,
  isLoading,
  volume,
  playMode,
  coverThemeColor,
  themeCoverUrl,
  themeCoverIdentity,
  queue,
  queueIndex,
  togglePlay,
  next,
  prev,
  seek,
  setVolume,
  flushSoftwareVolumePersist,
  cyclePlayMode,
  setPlayMode,
  restorePlaybackSession,
  createPlaybackSession,
  rehydrateCurrentTrackFromLibrary,
  queueWorkspace,
  queueSessions,
  canUndoQueue,
  queueUndoLabel,
  undoQueue,
  visualizerActive
} = usePlayerStore()
useDesktopLyricsPublisher()
const { setAdaptiveMedia, effectiveSurfaceMaterial, effectiveLiquidGlass, effectiveThemeLayers } =
  useThemeStore()
const mediaProviders = useMediaProviders()
function handleQueueSource(origin: QueuePlaybackOrigin): void {
  collapseMenu()
  streamingArtistRequest.value = null
  if (origin.scope === 'provider') {
    streamingCollectionRequest.value = { key: ++streamingCollectionRequestKey, origin }
    enterStreamingMode('search')
    return
  }
  if (origin.kind === 'album') {
    const album = musicStore.albums.value.find((item) => item.id === origin.id)
    if (album) onSelectView('albums', `album:${album.id}`)
    else
      pushNotice({
        kind: 'warning',
        message: '专辑来源已不可用：这张专辑已不在当前曲库中，播放队列仍可继续使用。'
      })
    return
  }
  const playlists =
    origin.scope === 'aggregate'
      ? musicStore.aggregatePlaylists.value
      : musicStore.localPlaylists.value
  const playlist = playlists.find((item) => item.id === origin.id)
  if (playlist)
    navigation.openLibraryPlaylist({
      id: playlist.id,
      name: playlist.name,
      kind: origin.scope === 'aggregate' ? 'aggregate' : undefined
    })
  else
    pushNotice({
      kind: 'warning',
      message: '歌单来源已不可用：这个歌单已被移除，播放队列仍可继续使用。'
    })
}
const navigationProviders = useProviderStore()
const commandPalette = useCommandPalette(
  {
    ...navigation,
    openEqualizerPage,
    openDspRackPage,
    openSettingsPage,
    openAppearancePage,
    openPlayingPage: () => void runAfterAudioLeave(navigation.openPlayingPage),
    navigate: (...args: Parameters<typeof navigation.navigate>) =>
      void runAfterAudioLeave(() => navigation.navigate(...args)),
    openLibraryPlaylist: (...args: Parameters<typeof navigation.openLibraryPlaylist>) =>
      void runAfterAudioLeave(() => navigation.openLibraryPlaylist(...args))
  },
  () => navigationPages.value
)

function handlePlayerBarArtistClick(): void {
  const track = currentTrack.value
  const trackArtist = track?.artist.trim() ?? ''
  if (!track || !trackArtist) return

  const source = getTrackSource(track)
  if (source === 'local') {
    streamingArtistRequest.value = null
    returnToLocalMode()
    onSelectView('artists', `artist:${trackArtist}`)
    return
  }

  const artistName = getPrimaryStreamingArtistName(trackArtist)
  if (!artistName) return
  // 同名歌手只能靠 provider 歌手 id 区分；曲目没带 id 时才让流媒体页按名字搜。
  const artistId = getPrimaryStreamingArtistId(trackArtist, track.artists)
  streamingArtistRequest.value = {
    key: ++streamingArtistRequestKey,
    providerId: source,
    artistName,
    ...(artistId !== undefined ? { artistId } : {})
  }
  enterStreamingMode()
}

// The analytics dashboard only knows an aggregated artist string, so it hands
// streaming-owned artists here; the provider falls back to a name search.
function handleAnalyticsArtistOpen(request: { name: string; providerId: string }): void {
  const artistName = getPrimaryStreamingArtistName(request.name)
  if (!artistName) return
  streamingArtistRequest.value = {
    key: ++streamingArtistRequestKey,
    providerId: request.providerId,
    artistName
  }
  enterStreamingMode()
}

const {
  favoriteButtonVisible,
  favoriteButtonLiked,
  favoriteButtonLoading,
  favoriteButtonTitle,
  toggleFavorite
} = useFavoriteButton({
  currentTrack,
  playlists: musicStore.localPlaylists,
  mediaProviders,
  addToPlaylist: musicStore.addToPlaylist,
  removeFromPlaylist: musicStore.removeFromPlaylist,
  createPlaylist: musicStore.createPlaylist,
  isFavoriteTrack: musicStore.isFavoriteTrack,
  addFavoriteTrack: musicStore.addFavoriteTrack,
  removeFavoriteTrack: musicStore.removeFavoriteTrack
})

watch(
  [themeCoverIdentity, coverThemeColor, themeCoverUrl],
  ([identity, accentColor, coverUrl]) => {
    void setAdaptiveMedia({ identity, accentColor, coverUrl })
  },
  { immediate: true }
)

useMiniPlayerSync({
  positionAt: estimatePlaybackClockPosition,
  currentTrack,
  isPlaying,
  isLoading,
  currentTime,
  duration,
  playbackRate,
  volume,
  playMode,
  favoriteAvailable: favoriteButtonVisible,
  favoriteLiked: favoriteButtonLiked,
  favoriteLoading: favoriteButtonLoading,
  dominantColor: coverThemeColor,
  queue,
  queueIndex,
  togglePlay,
  next,
  prev,
  seek,
  setVolume,
  cyclePlayMode,
  setPlayMode,
  toggleFavorite
})
const { loadSettings, hydrateStartupSnapshot, settings, updateSettings } = useSettingsStore()
useMotionPreference(computed(() => settings.value.motionPreference))
useLanguagePreference(computed(() => settings.value.language))
const { uiContributions, syncExtensions } = useExtensionRegistry()
const availablePluginPages = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'sidebarPage')
)
function openThemeWorkshop(): void {
  openAppearancePage(undefined, 'workshop')
}
const localSidebarItems = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'localSidebarItem')
)
const soundFieldSidebarVisible = ref(false)
const playerBarRef = ref<{
  openQueue: () => void
  openMiniPlayer: () => void
} | null>(null)
const soundFieldSidebarActive = computed(() =>
  usesSoundFieldSidebar(
    soundFieldSidebarVisible.value,
    localViewVisible.value,
    activeCategory.value,
    showStreamingPage.value,
    showPlayingPage.value
  )
)
provide(soundFieldPlaybackKey, {
  sidebarVisible: soundFieldSidebarVisible,
  favoriteAvailable: favoriteButtonVisible,
  favoriteLiked: favoriteButtonLiked,
  favoriteLoading: favoriteButtonLoading,
  favoriteTitle: favoriteButtonTitle,
  toggleFavorite,
  openQueue: () => playerBarRef.value?.openQueue(),
  openAudio: openAudioWorkspace,
  openMiniPlayer: () => playerBarRef.value?.openMiniPlayer(),
  openLyrics: () => showPlaying()
})
const hasPlayerBar = computed(
  () =>
    !showOnboarding.value &&
    !showLoginPage.value &&
    (!showSettingsPage.value || appearanceFullWindowPreview.value) &&
    (!showAppearancePage.value || appearanceFullWindowPreview.value) &&
    !showThemeStudioPage.value &&
    !showEqualizerPage.value &&
    !showDspRackPage.value &&
    !activePluginPage.value &&
    !visualizerActive.value
)
/* Shape and visibility resolution live in shared/playerBar.ts so main and renderer
   agree and the truth table stays unit-testable; App.vue only forwards the result.
   A fully hidden bar stays mounted — playback controls and the
   geometry flag both consumers read all live on it — so CSS does the hiding. */
const playerBarPresentation = computed(() =>
  resolvePlayerBarPresentation(
    appearanceChromePreview.value?.playerBar ?? settings.value.playerBar,
    {
      onPlayingPage: showPlayingPage.value
    }
  )
)
const showLocalSidebar = computed(
  () =>
    !showPlayingPage.value &&
    !showAccountPage.value &&
    !showLoginPage.value &&
    (!showSettingsPage.value || appearanceFullWindowPreview.value) &&
    (!showAppearancePage.value || appearanceFullWindowPreview.value) &&
    !showThemeStudioPage.value &&
    !showEqualizerPage.value &&
    !showDspRackPage.value
)
// watch() reads its getter during registration, including restored open menus.
useEscapeToClose(() => menuOpen.value && showLocalSidebar.value, closeNavigation)

const sideMenuActiveKey = computed(() => (showPluginPage.value ? 'plugins' : activePageId.value))
const navigationPages = computed(() => {
  const providers = navigationProviders.providers.value
  const ncmAvailable = providers.some(
    (provider) => provider.id === 'ncm' && provider.health?.available !== false
  )
  const options = { providers, ncmAvailable }
  const unavailable: Record<string, string> = {}
  if (!getStreamingHomeProviders(options).length)
    unavailable['streaming-home'] = '尚未启用提供推荐主页的音源'
  if (!getStreamingDiscoveryProviders(options).length)
    unavailable.discover = '尚未启用提供发现歌单的音源'
  if (!getNavigationLibraryProviders(options).length)
    unavailable.library = '尚未启用提供个人音乐库的音源'
  if (!ncmAvailable) unavailable.cloud = '需要启用网易云音乐音源'
  return buildNavigationPages(
    [
      ...availablePluginPages.value.filter(
        (page) => page.pluginId !== 'com.twilightecho.tool.theme-workshop'
      ),
      ...localSidebarItems.value
    ],
    unavailable
  )
})
const mainContentMinHeight = computed(() => '100vh')

const playbackSessionPersistence = createPlaybackSessionPersistence({
  settings,
  currentTrack,
  currentTime,
  isPlaying,
  queue,
  restorePlaybackSession,
  createPlaybackSession,
  syncPluginProviders,
  dataApi: window.api.data,
  onAutosaveError: (error) => {
    pushNotice({
      kind: 'warning',
      message: `自动保存播放会话失败：${error instanceof Error ? error.message : String(error)}`
    })
  }
})
const {
  playerBottomClearance,
  sideMenuBottomOffset,
  sideMenuToolsClearance,
  startSideMenuMonitor,
  stopSideMenuMonitor,
  resetSideMenuClearance,
  dispose: disposeSideMenuClearance
} = useSideMenuClearance({
  showLocalSidebar,
  hasPlayerBar
})

watch(
  playerBottomClearance,
  (clearance) =>
    document.documentElement.style.setProperty('--te-playbar-bottom-clearance', clearance + 'px'),
  { immediate: true }
)

let removePlaybackSessionSaveListener: (() => void) | null = null
let removeAppNavigationListener: (() => void) | null = null
let removeLibraryChangedListener: (() => void) | null = null
let removeCoversMissingListener: (() => void) | null = null
let removeLibraryScanProgressListener: (() => void) | null = null
let removeLibraryScanStatusListener: (() => void) | null = null
let quitFlushHandler: (() => void) | null = null
let pageHideFlushHandler: (() => void) | null = null
const startupDataErrorScopes = new Set<string>()

function reportStartupDataError(scope: string, error: unknown): void {
  console.error(`[persistence] Failed to load ${scope}:`, error)
  startupDataErrorScopes.add(scope)
  const detail = error instanceof Error ? error.message : String(error)
  const scopes = Array.from(startupDataErrorScopes).join('、')
  pushNotice({
    kind: 'error',
    sticky: true,
    message: `启动时无法加载 ${scopes}${detail ? `：${detail}` : ''}。部分功能可能不可用。`,
    action: {
      label: '打开设置',
      run: () => openSettingsPage('general')
    }
  })
}

async function flushPlaylistsForExit(): Promise<void> {
  try {
    const persisted = await flushPlaylists()
    if (!persisted) {
      throw new Error('Playlist persistence did not finish before exit')
    }
  } catch (error) {
    console.error('[persistence] Failed to flush playlists before exit:', error)
    throw error
  }
}

function flushPendingPersistenceForExit(): void {
  navigationPersistence.flush()
  flushSaveLibrary()
  // Browser lifecycle events cannot wait for a Promise. The app-close IPC
  // callback below awaits this same flush before the main process closes.
  void flushPlaylistsForExit().catch(() => {
    // The failure was logged by flushPlaylistsForExit. pagehide is only a
    // best-effort path; it cannot certify a successful application close.
  })
}

onMounted(async () => {
  const { setupListeningStatsTracking, flushListeningStatsForExit } =
    await import('@renderer/stores/useListeningStatsStore')
  setupListeningStatsTracking({ currentTrack, isPlaying, currentTime, duration })
  const startupSnapshot = await getStartupSnapshot()
  await bootstrapThemeRuntime(startupSnapshot ?? undefined)
  const loadedSettings = startupSnapshot
    ? hydrateStartupSnapshot(startupSnapshot)
    : await loadSettings()
  removeAppNavigationListener = window.api.app.onNavigate((target) => {
    applyExternalNavigation(target)
    void window.api.app.consumePendingNavigation()
  })
  const pendingNavigation =
    startupSnapshot?.pendingNavigation ?? (await window.api.app.consumePendingNavigation())
  if (pendingNavigation) applyExternalNavigation(pendingNavigation)

  // First-run welcome wizard. The empty-library guard keeps existing users
  // who upgraded from a build without the flag from ever seeing it.
  const needsOnboarding =
    !pendingNavigation &&
    !loadedSettings.onboardingCompleted &&
    loadedSettings.libraryFolders.length === 0
  if (needsOnboarding) {
    showOnboarding.value = true
  } else if (!pendingNavigation && !navigationPersistence.restored) {
    if (loadedSettings.startupHomePage === 'streaming') {
      // Enter streaming mode immediately if configured — must not block on
      // library/login/extensions which can take 30s+ (provider timeouts).
      enterStreamingMode()
    }
  }
  navigationPersistence.start()

  // Restore the session before loading the potentially large music library.
  // The main-process data handlers use synchronous file reads, so issuing the
  // library request first can delay the home page's current-track state.
  const playbackSessionSetupPromise = playbackSessionPersistence
    .restoreSavedPlaybackSession(loadedSettings.playbackResumeMode)
    .catch((error) => {
      reportStartupDataError('playback session', error)
    })
    .finally(() => {
      removePlaybackSessionSaveListener = window.api.app.onSavePlaybackSession(async () => {
        navigationPersistence.flush()
        // This callback is awaited by the main-process close coordinator. It
        // closes the 250ms playlist debounce window before renderer teardown.
        await flushPlaylistsForExit()
        await flushSoftwareVolumePersist()
        await flushListeningStatsForExit()
        await playbackSessionPersistence.savePlaybackSessionForQuit()
        await queueWorkspace.flush()
      })
      playbackSessionPersistence.startAutosaveWatchers()
    })
  // Run independent startup operations in parallel so none blocks the others.
  const libraryPromise = loadLibrary().catch((error) =>
    reportStartupDataError('music library', error)
  )
  const playlistsPromise = loadPlaylists().catch((error) =>
    reportStartupDataError('playlists', error)
  )
  const extensionsPromise = syncExtensions().then(() => {
    navigationPersistence.resolvePluginPages([
      ...availablePluginPages.value,
      ...localSidebarItems.value
    ])
  })
  if (loadedSettings.autoCheckLogin) {
    idleLoginCheck = scheduleIdleTask(() => {
      idleLoginCheck = null
      void checkLogin()
    })
  }

  // The session restore starts alongside the library load so the home surface
  // can receive the actual current track without waiting for a full scan.
  await libraryPromise
  await playbackSessionSetupPromise
  // Session restore often finishes before library rows are available; re-apply
  // embedded covers/lyrics so playbar/home art and now-playing lyrics hydrate.
  rehydrateCurrentTrackFromLibrary()
  removeLibraryChangedListener = window.api.library.onChanged((change) => {
    handleLibraryChange(change).catch((error) => {
      console.error('[library] Failed to apply an incremental scan update:', error)
    })
  })
  removeLibraryScanProgressListener = window.api.library.onScanProgress(applyLibraryScanProgress)
  removeLibraryScanStatusListener = window.api.library.onScanStatus(applyLibraryScanStatus)
  void window.api.library
    .getScanStatus()
    .then(applyLibraryScanStatus)
    .catch((error) => {
      console.error('[library] Failed to read background scan status:', error)
    })
  void startStartupLibraryScan().catch((error) => {
    console.error('[library] Startup reconciliation failed:', error)
    pushNotice({
      kind: 'warning',
      message: `启动音乐库核对失败：${error instanceof Error ? error.message : String(error)}`,
      action: {
        label: '打开音乐库设置',
        run: () => openSettingsPage('library', { anchor: 'scan-diagnostics' })
      }
    })
  })

  // Ensure extensions are loaded before wiring listeners that depend on them.
  await extensionsPromise
  await applyActiveTheme(false)
  await playlistsPromise

  removeCoversMissingListener = window.api.library.onCoversMissing((info) => {
    const dirtyCount = Math.max(0, Number(info?.dirtyCount) || 0)
    if (dirtyCount <= 0) return
    console.warn(`[library] ${dirtyCount} tracks are missing cover art`)
    pushNotice({
      kind: 'warning',
      message: `检测到 ${dirtyCount} 首缺少封面，可在设置中完整重扫以补全封面。`,
      action: {
        label: '打开音乐库设置',
        run: () => openSettingsPage('library', { anchor: 'scan-diagnostics' })
      }
    })
  })
  // Lifecycle events are best-effort; the close IPC callback above provides
  // the awaitable completion barrier for application shutdown.
  quitFlushHandler = flushPendingPersistenceForExit
  pageHideFlushHandler = flushPendingPersistenceForExit
  window.addEventListener('beforeunload', quitFlushHandler)
  window.addEventListener('pagehide', pageHideFlushHandler)
  window.addEventListener('keydown', onGlobalBackKeydown)
})

watch(
  [showLocalSidebar, hasPlayerBar, menuOpen],
  () => {
    if (hasPlayerBar.value) {
      nextTick(startSideMenuMonitor)
      return
    }

    resetSideMenuClearance()
  },
  { immediate: true, flush: 'post' }
)

watch(
  [showSettingsPage, showAppearancePage, showThemeStudioPage, appearanceFullWindowPreview],
  () => {
    document.body.classList.toggle(
      'te-settings-surface',
      !appearanceFullWindowPreview.value &&
        (showSettingsPage.value || showAppearancePage.value || showThemeStudioPage.value)
    )
  },
  { immediate: true }
)

watch(
  showStreamingSurface,
  (visible) => {
    document.body.classList.toggle('te-streaming-surface', visible)
    // One continuous wallpaper for the whole local shell: the body paints the
    // local background once, window-wide, and the sidebar plus every page sit
    // transparent on top. Pages that each carried their own cover-scaled copy
    // opened a seam at the sidebar edge — two scales of the same image reading
    // as a split surface. Mutually exclusive with the streaming surface, which
    // owns the body in its mode.
    document.body.classList.toggle('te-local-surface', !visible)
  },
  { immediate: true }
)

watch([availablePluginPages, localSidebarItems], ([pages, local]) =>
  closeMissingPluginPage([...pages, ...local])
)

onBeforeUnmount(() => {
  navigationPersistence.stop()
  idleLoginCheck?.cancel()
  idleLoginCheck = null
  playbackSessionPersistence.stop()
  removePlaybackSessionSaveListener?.()
  removePlaybackSessionSaveListener = null
  removeAppNavigationListener?.()
  removeAppNavigationListener = null
  removeLibraryChangedListener?.()
  removeLibraryChangedListener = null
  removeLibraryScanProgressListener?.()
  removeLibraryScanProgressListener = null
  removeLibraryScanStatusListener?.()
  removeLibraryScanStatusListener = null
  removeCoversMissingListener?.()
  removeCoversMissingListener = null
  if (quitFlushHandler) window.removeEventListener('beforeunload', quitFlushHandler)
  if (pageHideFlushHandler) window.removeEventListener('pagehide', pageHideFlushHandler)
  window.removeEventListener('keydown', onGlobalBackKeydown)
  quitFlushHandler = null
  pageHideFlushHandler = null
  stopSideMenuMonitor()
  disposeSideMenuClearance()
  document.body.classList.remove('te-settings-surface')
  document.body.classList.remove('te-streaming-surface')
  document.body.classList.remove('te-local-surface')
})

const coverTransformOrigin = computed(() => `${coverOrigin.value.x}px ${coverOrigin.value.y}px`)
const titleSurface = computed<TitleSurface>(() => {
  if (showPlayingPage.value) return 'default'
  if (showSettingsPage.value && !appearanceFullWindowPreview.value) return 'settings'
  if (showAppearancePage.value && !appearanceFullWindowPreview.value) return 'settings'
  if (showThemeStudioPage.value) return 'settings'
  if (showStreamingPage.value) return 'streaming'
  if (showNetworkSourcesPage.value) return 'streaming'
  if (activePluginPage.value) return 'settings'
  return 'default'
})
const liquidGlassChromeActive = computed(
  () =>
    effectiveSurfaceMaterial.value !== 'transparent' &&
    (effectiveSurfaceMaterial.value === 'liquidGlass' ||
      effectiveLiquidGlass.value.navigationEnabled)
)
const liquidGlassActive = computed(
  () =>
    effectiveSurfaceMaterial.value !== 'transparent' &&
    (liquidGlassChromeActive.value ||
      effectiveLiquidGlass.value.playbarEnabled ||
      effectiveLiquidGlass.value.settingsNavigationEnabled)
)
const playbarRefractionActive = computed(
  () =>
    liquidGlassActive.value &&
    settings.value.blurEffect &&
    hasPlayerBar.value &&
    !!currentTrack.value &&
    !showPlayingPage.value &&
    playerBarPresentation.value.mode === 'standard' &&
    !playerBarPresentation.value.hidden &&
    (effectiveSurfaceMaterial.value === 'liquidGlass' || effectiveLiquidGlass.value.playbarEnabled)
)
const liquidGlassBackgroundPage = computed<AppBackgroundPage>(() => {
  if (showPlayingPage.value) return 'player'
  if (titleSurface.value === 'settings') return 'settings'
  if (titleSurface.value === 'streaming') return 'streaming'
  return 'local'
})

useLiquidGlassEnvironment({
  active: liquidGlassActive,
  page: liquidGlassBackgroundPage
})
let onWorkshopDecorationsUnmount: (() => void) | undefined
onMounted(() => {
  onWorkshopDecorationsUnmount = mountWorkshopDecorations(document)
})
onBeforeUnmount(() => onWorkshopDecorationsUnmount?.())
</script>

<template>
  <AppearanceLayersHost
    v-if="!showAppearancePage && !appearanceEditorOpen"
    :settings="
      appearanceChromePreview?.appearanceLayers ?? effectiveThemeLayers ?? settings.appearanceLayers
    "
  />
  <AppBackgroundLayer
    :page="showStreamingSurface ? 'streaming' : 'local'"
    :reading="
      (showAudioWorkspace ||
        showSettingsPage ||
        showAppearancePage ||
        showRadioPodcastPage ||
        showNetworkSourcesPage) &&
      !appearanceFullWindowPreview
    "
    :ambient="localViewVisible && activeCategory === 'dashboard'"
  />
  <div
    class="app-shell"
    :class="{
      'is-immersive': showPlayingPage,
      'appearance-editor-active': showAppearancePage && !appearanceFullWindowPreview
    }"
    :inert="appearanceFullWindowPreview"
    :style="{
      '--te-side-menu-bottom': `${sideMenuBottomOffset}px`,
      '--te-side-menu-tools-clearance': `${sideMenuToolsClearance}px`
    }"
  >
    <LiquidGlassDefs :active="playbarRefractionActive" />
    <div class="app-shell-title">
      <TitleBar
        :search-query="titleSearchQuery"
        :close-only="showOnboarding"
        :home="isHome"
        :account-open="showAccountPage"
        :page-dock-actions="pageDock.actions.value"
        :immersive="showPlayingPage"
        :liquid-material="liquidGlassChromeActive"
        :streaming="showStreamingPage && !showPlayingPage"
        :title-surface="titleSurface"
        :reading="
          (showAudioWorkspace ||
            showSettingsPage ||
            showAppearancePage ||
            showRadioPodcastPage ||
            showNetworkSourcesPage) &&
          !appearanceFullWindowPreview
        "
        :active-tool="
          showAudioWorkspace
            ? 'dsp'
            : showPluginPage
              ? 'plugins'
              : showAppearancePage
                ? 'appearance'
                : showSettingsPage
                  ? 'settings'
                  : null
        "
        :menu-open="titleMenuOpen"
        @toggle-menu="toggleMenu"
        @home="handleTitleHome"
        @collapse-menu="collapseMenu"
        @back="handleTitleBack"
        @update:search-query="handleTitleSearchQuery"
        @search="handleTitleSearch"
        @login="handleTitleLogin"
        @settings="toggleSettingsPage"
        @appearance="toggleAppearancePage"
        @dsp="openAudioWorkspace"
        @library="selectSidebarPage({ kind: 'local', category: 'allSongs', filter: null })"
      />
    </div>
    <div
      v-if="showLocalSidebar"
      class="app-shell-navigation"
      :class="{ 'navigation-temporary': menuOpen }"
    >
      <SideMenu
        :open="menuOpen"
        :liquid-material="liquidGlassChromeActive"
        :active-key="sideMenuActiveKey"
        :pages="navigationPages"
        @vue:mounted="startSideMenuMonitor"
        @select-page="selectSidebarPage($event.target)"
        @plugins="openSidebarPlugins"
      />
    </div>
    <SidebarBookmark
      v-if="showLocalSidebar"
      :open="menuOpen"
      :liquid-material="liquidGlassChromeActive"
      @toggle="toggleMenu"
    />
    <div class="app-shell-content">
      <div
        class="main-content"
        :class="{
          'menu-open': menuOpen && showLocalSidebar,
          'playing-open': showPlayingPage,
          'plugin-open': showPluginPage,
          'audio-workspace-open': showAudioWorkspace,
          'radio-podcast-open': showRadioPodcastPage
        }"
        :style="{ minHeight: mainContentMinHeight }"
      >
        <Transition
          :name="activeCategory === 'dashboard' ? 'home-page' : songlistTransitionName"
          mode="out-in"
        >
          <LocalDashboard
            v-if="localViewVisible && activeCategory === 'dashboard'"
            key="local-dashboard"
            @select-view="onSelectView"
            @open-library-settings="openSettingsPage('library')"
            @open-streaming="enterStreamingMode($event)"
            @open-plugins="navigation.openPluginPage()"
            @open-radio="navigation.enterRadioPodcastMode()"
            @login="handleStreamingLogin"
          />
          <ApplicationPlaylistsPage
            v-else-if="
              localViewVisible && (activeCategory === 'playlists' || activeCategory === 'aggregate')
            "
            key="local-playlists"
            :category="activeCategory"
            :filter="activeFilter"
            :has-player="hasPlayerBar"
            :transition-name="songlistTransitionName"
            :return-from-detail="navigation.goBackPage"
            @select-view="onSelectView"
            @customize-appearance="openThemeStudioPage('library')"
          />
          <ListeningAnalyticsPage
            v-else-if="localViewVisible && activeCategory === 'analytics'"
            key="local-analytics"
            @select-view="onSelectView"
            @open-artist="handleAnalyticsArtistOpen"
          />
          <SongList
            v-else-if="localViewVisible"
            key="local-songlist"
            :category="activeCategory"
            :filter="activeFilter"
            :has-player="hasPlayerBar"
            :transition-name="songlistTransitionName"
            :return-from-detail="navigation.goBackPage"
            @select-view="onSelectView"
            @customize-appearance="openThemeStudioPage('library')"
          />
        </Transition>
        <Transition name="playing-page">
          <PlayingMusic
            v-if="showPlayingPage"
            :style="{ transformOrigin: coverTransformOrigin }"
            @customize-appearance="openThemeStudioPage('player')"
          />
        </Transition>
        <StreamingPage
          v-for="tab in streamingPageTabs"
          :key="tab"
          :active="showStreamingSurface && streamingTab === tab"
          :menu-open="menuOpen && showLocalSidebar"
          :has-player="hasPlayerBar"
          :initial-tab="tab"
          :root-navigation-revision="streamingRootNavigationRevisions[tab] ?? 0"
          :search-navigation-request="tab === 'search' ? streamingSearchRequest : null"
          :artist-navigation-request="
            showStreamingSurface && tab === 'home' && streamingTab === tab
              ? streamingArtistRequest
              : null
          "
          :collection-navigation-request="
            showStreamingSurface && tab === 'search' && streamingTab === tab
              ? streamingCollectionRequest
              : null
          "
          @navigate-tab="enterStreamingMode($event)"
          @search-query-change="titleSearchQuery = $event"
          @select-view="onSelectView"
          @recent="navigation.navigate({ kind: 'recent', scope: 'platform', providerId: $event })"
          @login="handleStreamingLogin"
        />
        <RecentPlaybackPage
          v-if="recentPageMounted"
          v-show="showRecentPage"
          :active="showRecentPage"
          :target="pageTarget.kind === 'recent' ? pageTarget : undefined"
          :has-player="hasPlayerBar"
          @select-view="onSelectView"
          @login="handleStreamingLogin"
        />
        <RadioPodcastPage v-if="showRadioPodcastPage" />
        <NetworkSourcesPage v-if="showNetworkSourcesPage" />
        <Transition name="login-page">
          <LoginPage
            v-if="showLoginPage"
            :force-profile="loginPageMode === 'profile'"
            :initial-provider-id="loginInitialProviderId"
            @login-success="handleLoginSuccess"
            @configure="handleLoginConfigure"
          />
        </Transition>
        <AudioWorkspace
          v-if="showAudioWorkspace || audioWorkspaceDetached"
          ref="audioWorkspaceRef"
          :tab="audioWorkspaceTab"
          :active="showAudioWorkspace"
          @switch-tab="navigation.switchAudioWorkspaceTab"
          @detached-change="audioWorkspaceDetached = $event"
        />
        <Transition name="login-page">
          <PluginExtensionPage
            v-if="activePluginPage"
            :key="activePageId"
            :page="activePluginPage"
          />
        </Transition>
        <PluginPage
          v-if="showPluginPage"
          :initial-tab="pluginInitialTab"
          @open-theme-workshop="openThemeWorkshop"
        />
      </div>
    </div>
    <div class="app-shell-player">
      <PlayerBar
        v-if="hasPlayerBar"
        ref="playerBarRef"
        :glass="showPlayingPage"
        :liquid-material="liquidGlassChromeActive"
        :left-navigation-open="menuOpen && showLocalSidebar"
        :visualizer-visible="showPlayingPage && settings.playerBar.compactVisualizerEnabled"
        :mode="playerBarPresentation.mode"
        :auto-hide="playerBarPresentation.autoHide"
        :hidden-bar="playerBarPresentation.hidden || soundFieldSidebarActive"
        @vue:mounted="startSideMenuMonitor"
        @exit-playing-page="handleExitPlayingPage"
        @click-cover="handleCoverClick"
        @open-settings="openPlaybackSettings"
        @open-dsp="openDspSettings"
        @open-equalizer="openEqualizerPage"
        @open-artist="handlePlayerBarArtistClick"
        @open-queue-source="handleQueueSource"
        @queue-opened="handleQueueOpened"
      />
    </div>
  </div>
  <div
    class="settings-overlay-root"
    v-show="settingsOverlayVisible && !appearanceFullWindowPreview"
    :class="{ 'settings-overlay-root--active': settingsOverlayVisible }"
  >
    <AppBackgroundLayer page="settings" embedded :reading="!appearanceFullWindowPreview" />
    <Transition
      name="settings-page"
      @before-leave="retainSettingsOverlay"
      @after-leave="releaseSettingsOverlay"
      @leave-cancelled="releaseSettingsOverlay"
    >
      <SettingsPage
        v-if="settingsPageRetained"
        v-show="showSettingsPage"
        :active="showSettingsPage"
        :initial-section="settingsInitialSection"
        :navigation-target="settingsNavigationTarget"
        @section-change="navigation.rememberSettingsSection"
        @open-equalizer="openEqualizerPage"
        @open-dsp-rack="openDspRackPage"
        @open-theme-studio="openThemeStudioPage"
        @open-theme-workshop="openThemeWorkshop"
        @reopen-onboarding="handleReopenOnboarding"
        @open-appearance="navigation.openAppearancePage"
      />
    </Transition>
    <Transition
      name="settings-page"
      @before-leave="retainSettingsOverlay"
      @after-leave="releaseSettingsOverlay"
      @leave-cancelled="releaseSettingsOverlay"
    >
      <AppearancePage
        :pages="navigationPages"
        v-if="appearancePageRetained"
        ref="appearancePageRef"
        v-show="showAppearancePage"
        :active="showAppearancePage"
        :navigation-target="appearanceNavigationTarget"
        :initial-domain="themeStudioInitialDomain"
        @tab-change="navigation.appearanceTab.value = $event"
        @domain-change="navigation.rememberThemeStudioDomain"
        @back="closeAppearancePage"
        @open-plugins="openPluginPage"
      />
    </Transition>
  </div>
  <Transition name="account-subpage">
    <AccountPage
      v-if="showAccountPage"
      :anchor="accountAnchor"
      :initial-provider-id="accountInitialProviderId"
      @close="closeAccountSubview"
      @notice-target="noticeHistoryTarget = $event"
      @configure="navigateFromAccount('plugins')"
      @login-success="navigateFromAccount({ kind: 'streaming', tab: 'home' })"
    />
  </Transition>
  <CommandPalette
    v-if="commandPalette.isOpen.value"
    :actions="commandPalette.actions.value"
    :search="commandPalette.search"
    :playlists="commandPalette.playlists"
    :tracks="commandPalette.tracks"
    :play-track="commandPalette.playTrack"
    :open-playlist="commandPalette.openPlaylist"
    @close="commandPalette.close"
  />
  <Transition name="onboarding-page">
    <OnboardingWizard
      v-if="showOnboarding"
      :saving="onboardingSaving"
      :save-error="onboardingSaveError"
      @finish="handleOnboardingFinish"
    />
  </Transition>
  <NativeDialogTransition>
    <QueueWorkspaceDialog
      v-if="queueSessions.open.value"
      :workspace="queueWorkspace"
      :controller="queueSessions"
      :queue-length="queue.length"
      :can-undo="canUndoQueue"
      :undo-label="queueUndoLabel"
      :undo="undoQueue"
      @close="queueSessions.open.value = false"
    />
  </NativeDialogTransition>
  <AppNoticeHost
    history-embedded
    :history-target="noticeHistoryTarget"
    @library="navigateFromAccount({ kind: 'local', category: 'allSongs', filter: null })"
  />
  <BackgroundAppearanceCustomizer v-if="appearanceEditorOpen" />
</template>

<style>
html[data-te-shell-layout='custom'],
html[data-te-shell-layout='custom'] body,
html[data-te-shell-layout='custom'] #app {
  min-height: 100%;
  height: 100%;
}

.app-shell-title {
  position: relative;
  z-index: 2100;
}

/* The overlay owns the whole settings surface, wallpaper included. It spans the
   full window (title strip included) and is the SINGLE painter of the settings
   image: earlier per-element copies (title bar, page, body) each relied on
   `background-attachment: fixed`, which Chromium silently re-anchors to the
   element box on composited layers — splitting the wallpaper into mismatched
   title/body bands. One static painter cannot drift. The title bar sits in a
   higher stacking context (z-index 2100), so its controls still receive every
   click while it stays transparent and lets this painter show through. */
.settings-overlay-root--active {
  position: fixed;
  inset: 0;
  z-index: 2000;
  overflow: hidden;
  isolation: isolate;
  background: #17181a !important;
}

/* The single settings wallpaper painter. The overlay never scrolls, so the
   layers stay viewport-pinned without `background-attachment: fixed`. The
   final image layer is deliberately opaque, so even a transparent PNG or
   transparent theme color can only reveal this settings backplate — never the
   homepage. */
.settings-overlay-root--active::before {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  content: '';
  pointer-events: none;
  background-color: #17181a;
  background-image:
    var(--te-settings-bg-image, none),
    linear-gradient(var(--te-settings-bg), var(--te-settings-bg)), linear-gradient(#17181a, #17181a);
  background-position: center, center, center;
  background-size: cover, cover, cover;
  background-repeat: no-repeat, no-repeat, no-repeat;
}

.settings-overlay-root--active .settings-preview-page {
  z-index: 1;
  pointer-events: auto;
}

html[data-te-shell-layout='custom'] .app-shell {
  display: grid;
  grid-template-columns: var(--te-shell-template-columns);
  grid-template-rows: var(--te-shell-template-rows);
  grid-template-areas: var(--te-shell-template-areas);
  min-height: 100vh;
  height: 100vh;
  overflow: hidden;
}

html[data-te-shell-layout='custom'] .app-shell-title {
  grid-area: titleBar;
  min-width: 0;
  min-height: 0;
}

html[data-te-shell-layout='custom'] .app-shell-navigation {
  /* Navigation is detached from the theme grid; opening it cannot claim a
     content track or change the title and playback slots. */
  position: fixed;
  top: var(--te-window-content-top);
  bottom: var(--te-window-content-bottom);
  left: var(--te-window-surface-inset);
  width: var(--te-overlay-panel-width);
  z-index: var(--te-overlay-panel-layer, 1000);
  display: var(--te-shell-navigation-display);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

html[data-te-shell-layout='custom'] .app-shell-content {
  grid-area: content;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

html[data-te-shell-layout='custom'] .app-shell-player {
  grid-area: playerBar;
  display: var(--te-shell-player-bar-display);
  min-width: 0;
  min-height: 0;
}

html[data-te-shell-layout='custom'] .app-shell-title .title-bar {
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  min-height: 32px;
  height: 100%;
}

html[data-te-shell-layout='custom'] .app-shell-navigation .side-menu {
  position: fixed;
}

html[data-te-shell-layout='custom'][data-te-shell-navigation='hidden'] .app-shell-navigation {
  display: none;
}

html[data-te-shell-layout='custom'] .app-shell-content .main-content,
html[data-te-shell-layout='custom'] .app-shell-content .main-content.menu-open {
  min-height: 0 !important;
  height: 100%;
  padding-left: 0;
}

html[data-te-shell-layout='custom'] .app-shell-player .player-bar-shell,
html[data-te-shell-layout='custom'] .app-shell-player .player-bar-shell.menu-open {
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  height: 100%;
  pointer-events: auto;
}

/* A fully hidden bar still occupies its grid area here, so the shell above would
   keep eating clicks across that row. Re-assert none, out-specifying that rule. */
html[data-te-shell-layout='custom']
  .app-shell-player
  .player-bar-shell[data-te-playbar-visibility='hidden'] {
  pointer-events: none;
}

@media (max-width: 760px) {
  html[data-te-shell-layout='custom'] .app-shell {
    grid-template-columns: var(--te-shell-compact-template-columns);
    grid-template-rows: var(--te-shell-compact-template-rows);
    grid-template-areas: var(--te-shell-compact-template-areas);
  }

  html[data-te-shell-layout='custom'] .app-shell-navigation {
    display: var(--te-shell-compact-navigation-display);
  }

  html[data-te-shell-layout='custom'] .app-shell-player {
    display: var(--te-shell-compact-player-bar-display);
  }

  html[data-te-shell-layout='custom'] .app-shell-navigation.navigation-temporary {
    display: block;
  }

  html[data-te-shell-layout='custom'] .app-shell-navigation.navigation-temporary .side-menu {
    transform: none;
  }
}

/* Sidebars slide over this stable content box. */
.main-content {
  display: grid;
  box-sizing: border-box;
  margin-left: 0;
  width: 100%;
  min-height: 100vh;
  padding-left: 0;
  transform: translateZ(0);
  overflow: hidden;
  position: relative;
  z-index: 1;
}

.main-content > * {
  grid-area: 1 / 1;
}

body.te-no-blur .main-content::before,
body.te-no-blur .main-content::after,
body.te-no-blur .page-down-leave-to,
body.te-no-blur .page-down-enter-from,
body.te-no-blur .page-up-leave-to,
body.te-no-blur .page-up-enter-from,
body.te-no-blur .playing-page-enter-from,
body.te-no-blur .playing-page-leave-to,
body.te-no-blur .settings-page-enter-from,
body.te-no-blur .settings-page-leave-to,
body.te-no-blur .login-page-enter-from,
body.te-no-blur .login-page-leave-to {
  filter: none !important;
}

.main-content.menu-open {
  padding-left: 0;
}

.main-content.playing-open {
  overflow: visible;
}

.main-content.plugin-open {
  min-height: 0 !important;
}

.main-content.audio-workspace-open {
  height: 100vh;
  min-height: 0 !important;
}

.main-content.audio-workspace-open > .audio-workspace {
  height: 100%;
  min-height: 0;
}

.main-content.radio-podcast-open {
  height: 100vh;
  min-height: 0 !important;
}

.main-content.radio-podcast-open > .radio-podcast-page {
  height: 100%;
  min-height: 0;
}

/* Home returns to its resting geometry immediately; only its opacity changes. */
.main-content:has(> .local-home-layout.home-page-enter-active) {
  /* Restoring a sidebar hidden by an overlay is navigation, not a menu toggle.
     Set its clearance before home becomes visible to avoid resizing its cards. */
  transition: none;
}
.home-page-enter-active {
  transition: opacity 180ms ease;
}
.home-page-leave-active {
  pointer-events: none;
  transition: opacity 140ms ease;
}
.home-page-enter-from,
.home-page-leave-to {
  opacity: 0;
}

/* Local list view transitions mirror the streaming sidebar. */
.main-content > .page-down-enter-active,
.main-content > .page-down-leave-active,
.main-content > .page-up-enter-active,
.main-content > .page-up-leave-active,
.page-down-enter-active,
.page-down-leave-active,
.page-up-enter-active,
.page-up-leave-active {
  will-change: transform, opacity;
}
.main-content > .page-down-enter-active,
.main-content > .page-up-enter-active,
.page-down-enter-active,
.page-up-enter-active {
  z-index: 1;
  transition:
    opacity 0.18s ease,
    transform 0.24s var(--te-ease-out-strong) !important;
}
.main-content > .page-down-leave-active,
.main-content > .page-up-leave-active,
.page-down-leave-active,
.page-up-leave-active {
  z-index: 0;
  pointer-events: none;
  transition:
    opacity 0.14s ease,
    transform 0.18s var(--te-ease-enter) !important;
}

/* page-down: selected page is lower in the sidebar, new view rises from below */
.main-content > .page-down-enter-from,
.page-down-enter-from {
  opacity: 0;
  transform: translate3d(0, 16px, 0);
}
.main-content > .page-down-leave-to,
.page-down-leave-to {
  opacity: 0;
  transform: translate3d(0, -12px, 0);
}

/* page-up: selected page is higher in the sidebar, new view drops from above */
.main-content > .page-up-enter-from,
.page-up-enter-from {
  opacity: 0;
  transform: translate3d(0, -16px, 0);
}
.main-content > .page-up-leave-to,
.page-up-leave-to {
  opacity: 0;
  transform: translate3d(0, 12px, 0);
}

/* Explicit application preferences take precedence over the system setting.
   The direct-child page rules above use !important, so match their specificity. */
html[data-te-motion='reduced']
  .main-content
  :is(
    .page-down-enter-active,
    .page-down-leave-active,
    .page-up-enter-active,
    .page-up-leave-active
  ) {
  transition: opacity 120ms var(--te-ease-out-strong) !important;
}
html[data-te-motion='reduced']
  .main-content
  :is(
    .page-down-enter-active,
    .page-down-leave-active,
    .page-up-enter-active,
    .page-up-leave-active,
    .page-down-enter-from,
    .page-down-leave-to,
    .page-up-enter-from,
    .page-up-leave-to
  ),
html[data-te-motion='off']
  .main-content
  :is(
    .page-down-enter-active,
    .page-down-leave-active,
    .page-up-enter-active,
    .page-up-leave-active,
    .page-down-enter-from,
    .page-down-leave-to,
    .page-up-enter-from,
    .page-up-leave-to
  ) {
  transform: none !important;
  filter: none !important;
}
html[data-te-motion='off']
  .main-content
  :is(
    .page-down-enter-active,
    .page-down-leave-active,
    .page-up-enter-active,
    .page-up-leave-active
  ) {
  transition: none !important;
}

@media (prefers-reduced-motion: reduce) {
  html:not([data-te-motion='full'], [data-te-motion='off'])
    .main-content
    :is(
      .page-down-enter-active,
      .page-down-leave-active,
      .page-up-enter-active,
      .page-up-leave-active
    ) {
    transition: opacity 120ms var(--te-ease-out-strong) !important;
  }

  html:not([data-te-motion='full'], [data-te-motion='off'])
    .main-content
    :is(.page-down-enter-from, .page-down-leave-to, .page-up-enter-from, .page-up-leave-to) {
    transform: none !important;
    filter: none !important;
  }
}

/* The immersive view rises from, and returns to, the bottom player. */
.playing-page-enter-active {
  transition:
    transform var(--te-motion-page) var(--te-ease-out-expo),
    opacity 180ms ease;
}
.playing-page-leave-active {
  transition:
    transform var(--te-motion-panel) var(--te-ease-enter),
    opacity var(--te-motion-hover) ease;
}

.playing-page-enter-from {
  transform: translate3d(0, 28px, 0) !important;
  opacity: 0;
}

.playing-page-leave-to {
  transform: translate3d(0, 28px, 0) !important;
  opacity: 0;
}

/* Settings and plugin pages: shared overlay transition */
.settings-page-enter-active {
  z-index: 2000;
  transition: opacity var(--te-motion-panel) ease;
  will-change: opacity;
}

.settings-page-leave-active {
  z-index: 1999;
  pointer-events: none;
  transition: opacity var(--te-motion-hover) ease;
  will-change: opacity;
}

.settings-page-enter-from {
  opacity: 0;
}

.settings-page-leave-to {
  opacity: 0;
}

/* Onboarding wizard: fade in on first paint, dissolve away over the app */
.onboarding-page-enter-active {
  transition: opacity var(--te-motion-panel) ease;
}
.onboarding-page-leave-active {
  pointer-events: none;
  transition: opacity var(--te-motion-panel) ease;
}
.onboarding-page-enter-from {
  opacity: 0;
}
.onboarding-page-leave-to {
  opacity: 0;
}
body.te-no-blur .onboarding-page-leave-to {
  filter: none !important;
}

/* Login page transition */
.login-page-enter-active {
  transition:
    opacity var(--te-motion-panel) ease,
    transform var(--te-motion-page) var(--te-ease-out-quint);
}
.login-page-leave-active {
  transition:
    opacity var(--te-motion-hover) ease,
    transform var(--te-motion-hover) var(--te-ease-enter);
}
.login-page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
.login-page-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

html:is([data-te-motion='reduced'], [data-te-motion='off'])
  :is(
    [class*='playing-page-enter-'],
    [class*='playing-page-leave-'],
    [class*='login-page-enter-'],
    [class*='login-page-leave-'],
    [class*='onboarding-page-enter-'],
    [class*='onboarding-page-leave-'],
    [class*='onb-fwd-enter-'],
    [class*='onb-fwd-leave-'],
    [class*='onb-back-enter-'],
    [class*='onb-back-leave-']
  ) {
  transform: none !important;
  filter: none !important;
}

html[data-te-motion='reduced']
  :is(
    .playing-page-enter-active,
    .playing-page-leave-active,
    .login-page-enter-active,
    .login-page-leave-active,
    .onboarding-page-enter-active,
    .onboarding-page-leave-active,
    .onb-fwd-enter-active,
    .onb-fwd-leave-active,
    .onb-back-enter-active,
    .onb-back-leave-active
  ) {
  transition: opacity 120ms var(--te-ease-out-strong) !important;
}
</style>

<style>
.streaming-page.menu-open .streaming-content {
  padding-left: 0;
}
html[data-te-shell-layout='custom'] .streaming-page {
  position: absolute;
}
html[data-te-shell-layout='custom'] .streaming-page .streaming-content {
  padding-left: 0;
}
html[data-te-shell-layout='custom'][data-te-shell-navigation='hidden']
  .app-shell-navigation.navigation-temporary {
  display: block;
}
html[data-te-shell-layout='custom'][data-te-shell-navigation='hidden']
  .app-shell-navigation.navigation-temporary
  .side-menu {
  transform: none;
}
@media (max-width: 900px) {
  .main-content.menu-open,
  .streaming-page.menu-open .streaming-content {
    padding-left: 0 !important;
  }
  .app-shell-player .player-bar-shell {
    left: 0 !important;
  }
}
</style>
