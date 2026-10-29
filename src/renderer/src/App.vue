<script setup lang="ts">
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
import AppearanceLayersHost from './components/AppearanceLayersHost.vue'
import { providePageDock } from './app/pageDock'
import {
  guardAppearanceNavigation,
  type AppearanceWorkspace
} from './app/appearanceNavigationGuard'
import AppBackgroundLayer from './components/AppBackgroundLayer.vue'
import { guardDspNavigation, type DspWorkspace } from './app/dspNavigationGuard'
import {
  appearanceEditorOpen,
  appearanceChromePreview,
  appearanceFullWindowPreview
} from './composables/appearanceEditorState.ts'
const BackgroundAppearanceCustomizer = defineAsyncComponent(
  () => import('./components/BackgroundAppearanceCustomizer.vue')
)
const SideMenu = defineAsyncComponent(() => import('@renderer/components/SideMenu.vue'))
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
const ExperienceView = defineAsyncComponent(
  () => import('./components/experience/ExperienceView.vue')
)
const OnboardingWizard = defineAsyncComponent(
  () => import('./components/onboarding/OnboardingWizard.vue')
)
const MusicMetadataSetupHost = defineAsyncComponent(
  () => import('./components/music-metadata/MusicMetadataSetupHost.vue')
)
import type { OnboardingFinishResult } from './components/onboarding/OnboardingWizard.vue'
import { saveOnboardingSettings } from './components/onboarding/saveOnboardingSettings.ts'
import { useMusicStore } from './stores/useMusicStore'
import { startPlaylistPersistenceNotifications } from './app/playlistPersistenceNotifications.ts'
import { getExternalPlaylistService } from './stores/library/externalPlaylistService.ts'
import { useNcmStore } from './stores/useNcmStore'
import { isPlaybackSpace } from '@renderer/app/playbackKeyboard'
import { usePlayerStore } from './stores/usePlayerStore'
import { useCoreLibraryApi } from './stores/library/coreLibraryApi.ts'
import { useSettingsStore } from './stores/useSettingsStore'
import { useCoreConnection } from './stores/coreConnection.ts'
import { useThemeStore, applyActiveTheme, bootstrapThemeRuntime } from './stores/useThemeStore'
import { getStartupSnapshot } from './app/startupSnapshot'
import { useExtensionRegistry } from './extensions/registry'
import { applyStartupExperience } from './app/startupExperience'
import { useAppNavigation } from './app/useAppNavigation'
import { createNavigationSessionPersistence } from './app/useNavigationSessionPersistence'
import { useCommandPalette } from '@renderer/app/useCommandPalette.ts'
import { useBackStack } from './app/useBackStack'
import { createHistoryCommandRouter } from './app/historyNavigation.ts'
import { hasDismissLayer } from '@renderer/app/useDismissLayer'
import { useSideMenuClearance } from './app/useSideMenuClearance'
import { useMotionPreference } from './app/useMotionPreference'
import { useLanguagePreference } from './app/useLocale'
import { useLiquidGlassEnvironment } from './composables/useLiquidGlassEnvironment'
import { useAppNoticeStore } from './stores/useAppNoticeStore'
import { getTrackSource } from './utils/logicalTrackModel'
import { scheduleIdleTask, type IdleTaskHandle } from './app/scheduleIdleTask'
import {
  getPrimaryStreamingArtistName,
  type StreamingMetadataNavigationRequest
} from './utils/streamingArtistResolution'
const AppNoticeHost = defineAsyncComponent(() => import('./components/AppNoticeHost.vue'))
const ExperienceFlyout = defineAsyncComponent(() => import('./components/ExperienceFlyout.vue'))
import LiquidGlassDefs from './components/LiquidGlassDefs.vue'
import { resolvePlayerBarPresentation } from '../../shared/playerBar.ts'
import type { AppBackgroundPage } from './types/settings'
import {
  soundFieldPlaybackKey,
  usesSoundFieldSidebar
} from '@renderer/components/local-dashboard/soundFieldPlayback'

import type { TrackArtistRef } from './types/music'

type TitleSurface = 'default' | 'settings' | 'streaming'
let idleLoginCheck: IdleTaskHandle | null = null

const appearancePageRef = ref<(AppearanceWorkspace & { requestClose: () => Promise<void> }) | null>(
  null
)
const audioWorkspaceRef = ref<DspWorkspace | null>(null)
const navigation = guardDspNavigation(
  guardAppearanceNavigation(
    useAppNavigation({
      appearancePreviewActive: () => appearanceFullWindowPreview.value
    }),
    () => appearancePageRef.value
  ),
  () => audioWorkspaceRef.value
)
const audioWorkspaceRetained = computed(() =>
  [navigation.session.value.overlay, ...navigation.session.value.overlayHistory].some(
    (overlay) => overlay === 'equalizer' || overlay === 'dsp'
  )
)
const audioWorkspaceInitialTab = computed(() =>
  [
    navigation.session.value.overlay,
    ...[...navigation.session.value.overlayHistory].reverse()
  ].find((overlay) => overlay === 'equalizer' || overlay === 'dsp') === 'equalizer'
    ? 'equalizer'
    : 'monitor'
)
const appearancePageRetained = computed(
  () =>
    navigation.showAppearancePage.value ||
    navigation.session.value.overlayHistory.includes('appearance')
)
const pageDock = providePageDock(() => (navigation.showAppearancePage.value ? 'appearance' : ''))
const navigationPersistence = createNavigationSessionPersistence(navigation)
const {
  menuOpen,
  showPlayingPage,
  showStreamingPage,
  showRecentPage,
  streamingTab,
  activePageId,
  pageTarget,
  showRadioPodcastPage,
  showNetworkSourcesPage,
  showLoginPage,
  loginPageMode,
  loginInitialProviderId,
  showSettingsPage,
  showAppearancePage,
  appearanceNavigationTarget,
  themeStudioInitialDomain,
  showPluginPage,
  showEqualizerPage,
  showDspRackPage,
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
  onSelectPluginPage,
  openPlayingPage: showPlaying,
  closePlayingPage,
  enterStreamingMode,
  returnToLocalMode,
  openLoginPage,
  closeLoginPage,
  closeSettingsPage,
  openThemeStudioPage,
  openAppearancePage,
  closeAppearancePage,
  openPlaybackSettings,
  openDspSettings,
  hidePluginPage,
  openPluginPage,
  openEqualizerPage,
  closeEqualizerPage,
  openDspRackPage,
  closeDspRackPage,
  closeMissingPluginPage,
  openSettingsPage
} = navigation
// Keep the wallpaper inside its overlay through the leave transition. An idle
// overlay must hide its embedded painter, which would otherwise cover home.
const settingsOverlayLeaves = ref(0)
const settingsOverlayVisible = computed(
  () =>
    showSettingsPage.value ||
    showAppearancePage.value ||
    showPluginPage.value ||
    settingsOverlayLeaves.value > 0
)
function retainSettingsOverlay(): void {
  settingsOverlayLeaves.value += 1
}
function releaseSettingsOverlay(): void {
  settingsOverlayLeaves.value = Math.max(0, settingsOverlayLeaves.value - 1)
}
const { pushNotice } = useAppNoticeStore()
const playlistRecoveryStore = useMusicStore()
const stopPlaylistPersistenceNotifications = startPlaylistPersistenceNotifications(
  playlistRecoveryStore.playlistPersistenceStatus,
  playlistRecoveryStore.reloadPlaylistsDiscardingChanges
)
onBeforeUnmount(stopPlaylistPersistenceNotifications)
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
const noticeHostRef = ref<InstanceType<typeof AppNoticeHost> | null>(null)

// One global back affordance on the title bar. Every full-screen page
// registers a single base layer here; deeper in-page states (streaming
// details, login QR flow, EQ advanced settings, …) push themselves on top of
// it, so the button always resolves the innermost layer first.
const backStack = useBackStack()
backStack.useBackHandler(navigation.canGoBackPage, navigation.goBackPage)
backStack.useBackHandler(showPlayingPage, closePlayingPage)
backStack.useBackHandler(showSettingsPage, closeSettingsPage)
// ThemeStudio 不在此注册：未应用的修改需要确认，由 ThemeStudioPage 自己挂载
// 期间注册 closeStudio。
backStack.useBackHandler(showPluginPage, hidePluginPage)
backStack.useBackHandler(showEqualizerPage, closeEqualizerPage)
backStack.useBackHandler(showDspRackPage, closeDspRackPage)
backStack.useBackHandler(showLoginPage, closeLoginPage)
// Mouse side buttons: Windows/Linux deliver them as app commands forwarded by
// the main process; some builds also dispatch the XBUTTON as a DOM mouseup.
// Both paths share one router so a single press only moves one step. Back
// resolves this same layered stack as the title-bar button; forward replays the
// page trail the user backed out of.
const routeHistoryCommand = createHistoryCommandRouter({
  back: () => backStack.goBack(),
  forward: () => navigation.goForwardPage()
})
const toggleMenu = navigation.createToggleMenuHandler()
const toggleSettingsPage = navigation.createToggleSettingsHandler()
const togglePluginPage = navigation.createTogglePluginHandler()

const coverOrigin = ref({ x: 48, y: window.innerHeight - 36, w: 48, h: 48 })
const streamingMetadataRequest = ref<StreamingMetadataNavigationRequest | null>(null)
let streamingMetadataRequestKey = 0
const streamingMetadataTab = ref<StreamingPageTab>('home')
// Keep StreamingPage mounted so contextual navigation preserves its detail.
// Explicit sidebar selection returns the selected tab to its root instead.
const streamingPageTabs = shallowRef<StreamingPageTab[]>([])
const streamingRootNavigationRevisions = ref<Partial<Record<StreamingPageTab, number>>>({})

function selectSidebarPage(target: NavigationPageTarget): void {
  streamingMetadataRequest.value = null
  if (target.kind === 'streaming') {
    const revisions = streamingRootNavigationRevisions.value
    revisions[target.tab] = (revisions[target.tab] ?? 0) + 1
  }
  navigation.selectSidebarPage(target)
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
  showOnboarding.value = false
  if (target === 'settings') {
    openSettingsPage('general')
    return
  }
  if (target === 'streaming') {
    enterStreamingMode()
  } else {
    onSelectView('dashboard', null)
  }
}
const titleMenuOpen = computed(() => menuOpen.value)

function handleTitleBack(): void {
  backStack.goBack()
}

function onGlobalBackKeydown(event: KeyboardEvent): void {
  if (settings.value.shortcutEnabled?.playbackSpace !== false && isPlaybackSpace(event)) {
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

function handleTitleLogin(providerId?: string | null): void {
  openLoginPage(providerId ?? null)
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
    await saveOnboardingSettings(result.patch, { core: useCoreConnection(), updateSettings })
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
const externalPlaylistService = getExternalPlaylistService(musicStore)
onBeforeUnmount(() => externalPlaylistService.dispose())
const {
  loadApplicationLibrary,
  libraryCompatibilityError,
  retryLibraryCompatibility,
  loadPlaylists
} = musicStore
watch(libraryCompatibilityError, (error) => {
  if (!error) return
  pushNotice({
    kind: 'warning',
    message: `兼容曲库页面尚未更新：${error}`,
    action: {
      label: '重试读取',
      run: () =>
        retryLibraryCompatibility().catch((cause) => {
          console.error('[library] Compatibility refresh retry failed:', cause)
        })
    }
  })
})
const { checkLogin } = useNcmStore()
const {
  currentTrack,
  coverThemeColor,
  themeCoverUrl,
  themeCoverIdentity,
  queueSessions,
  canUndoQueue,
  queueUndoLabel,
  undoQueue,
  visualizerActive,
  currentFavorite,
  queueWorkspace,
  queueCount,
  togglePlay,
  toggleFavorite
} = usePlayerStore()
const { setAdaptiveMedia, effectiveSurfaceMaterial, effectiveLiquidGlass, effectiveThemeLayers } =
  useThemeStore()
const navigationProviders = useProviderStore()
const commandPalette = useCommandPalette(navigation, () => navigationPages.value)

function handlePlayerBarArtistClick(artist: TrackArtistRef): void {
  const track = currentTrack.value
  const artistName = artist.name.trim()
  if (!track || !artistName) return

  const source = getTrackSource(track)
  if (source === 'local') {
    streamingMetadataRequest.value = null
    onSelectView('artists', `artist:${artistName}`)
    return
  }

  streamingMetadataRequest.value = {
    kind: 'artist',
    key: ++streamingMetadataRequestKey,
    providerId: source,
    artistName,
    ...(artist.id != null ? { artistId: artist.id } : {})
  }
  streamingMetadataTab.value = pageTarget.value.kind === 'streaming' ? streamingTab.value : 'home'
  enterStreamingMode(streamingMetadataTab.value)
}

async function handlePlayingAlbumClick(): Promise<void> {
  const track = currentTrack.value
  if (!track?.album.trim()) return

  const source = getTrackSource(track)
  if (source === 'local') {
    streamingMetadataRequest.value = null
    try {
      const result = await useCoreLibraryApi().queryCollections('albums', {
        ids: [track.id],
        limit: 1
      })
      const album = result.items[0]
      if (!album) {
        pushNotice({ kind: 'info', message: '本地曲库中未找到这首歌曲的专辑' })
        return
      }
      onSelectView('albums', `album:${album.id}`)
    } catch (error) {
      pushNotice({ kind: 'warning', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  const albumId = track.albumId?.trim()
  if (!albumId) {
    pushNotice({ kind: 'info', message: '这首歌曲没有可用的专辑详情标识' })
    return
  }

  streamingMetadataRequest.value = {
    kind: 'album',
    key: ++streamingMetadataRequestKey,
    providerId: source,
    albumId,
    albumName: track.album,
    artist: track.albumArtist || track.artist,
    cover: track.cover,
    coverSource: track.coverSource
  }
  streamingMetadataTab.value = pageTarget.value.kind === 'streaming' ? streamingTab.value : 'home'
  enterStreamingMode(streamingMetadataTab.value)
}

// The analytics dashboard only knows an aggregated artist string, so it hands
// streaming-owned artists here; the provider falls back to a name search.
function handleAnalyticsArtistOpen(request: { name: string; providerId: string }): void {
  streamingMetadataTab.value = 'home'
  const artistName = getPrimaryStreamingArtistName(request.name)
  if (!artistName) return
  streamingMetadataRequest.value = {
    kind: 'artist',
    key: ++streamingMetadataRequestKey,
    providerId: request.providerId,
    artistName
  }
  enterStreamingMode()
}

const favoriteButtonVisible = computed(() => currentFavorite.value?.available ?? false)
const favoriteButtonLiked = computed(() => currentFavorite.value?.liked ?? false)
const favoriteButtonLoading = computed(() => currentFavorite.value?.loading ?? false)
const favoriteButtonTitle = computed(() => favoriteButtonLiked.value ? '取消收藏' : '收藏歌曲')

watch(
  [themeCoverIdentity, coverThemeColor, themeCoverUrl],
  ([identity, accentColor, coverUrl]) => {
    void setAdaptiveMedia({ identity, accentColor, coverUrl })
  },
  { immediate: true }
)

const { loadSettings, hydrateStartupSnapshot, settings, updateSettings } = useSettingsStore()
useMotionPreference(computed(() => settings.value.motionPreference))
useLanguagePreference(computed(() => settings.value.language))
const { uiContributions, sidebarExperiences, syncExtensions } = useExtensionRegistry()
const availablePluginPages = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'sidebarPage')
)
function openThemeWorkshop(): void {
  const page = availablePluginPages.value.find(
    (page) =>
      page.pluginId === 'com.twilightecho.tool.theme-workshop' && page.id === 'theme-workshop'
  )
  if (!page) return
  closeSettingsPage()
  onSelectPluginPage(page)
}
const localSidebarItems = computed(() =>
  uiContributions.value.filter((contribution) => contribution.kind === 'localSidebarItem')
)
const soundFieldSidebarVisible = ref(false)
const playerBarRef = ref<{
  openQueue: () => void
  openAudio: () => void
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
  openAudio: () => playerBarRef.value?.openAudio(),
  openMiniPlayer: () => playerBarRef.value?.openMiniPlayer(),
  openLyrics: () => showPlaying()
})
const hasPlayerBar = computed(
  () =>
    !showOnboarding.value &&
    !showLoginPage.value &&
    (!showSettingsPage.value || appearanceFullWindowPreview.value) &&
    (!showAppearancePage.value || appearanceFullWindowPreview.value) &&
    !showEqualizerPage.value &&
    !showDspRackPage.value &&
    !showPluginPage.value &&
    !activePluginPage.value &&
    !visualizerActive.value
)
/* Shape and visibility resolution live in shared/playerBar.ts so main and renderer
   agree and the truth table stays unit-testable; App.vue only forwards the result.
   A fully hidden bar stays mounted — playback controls, the HiFi panel and the
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
    !showLoginPage.value &&
    (!showSettingsPage.value || appearanceFullWindowPreview.value) &&
    (!showAppearancePage.value || appearanceFullWindowPreview.value) &&
    !showEqualizerPage.value &&
    !showDspRackPage.value &&
    !showPluginPage.value
)

const sideMenuActiveKey = activePageId
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
let removeHistoryCommandListener: (() => void) | null = null
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

function flushPendingPersistenceForExit(): void {
  navigationPersistence.flush()
}

onMounted(async () => {
  const startupSnapshot = await getStartupSnapshot()
  await bootstrapThemeRuntime(startupSnapshot ?? undefined)
  const loadedSettings = startupSnapshot
    ? hydrateStartupSnapshot(startupSnapshot)
    : await loadSettings()
  removeAppNavigationListener = window.api.app.onNavigate((target) => {
    applyExternalNavigation(target)
    void window.api.app.consumePendingNavigation()
  })
  removeHistoryCommandListener = window.api.app.onHistoryCommand(routeHistoryCommand.run)
  window.addEventListener('mouseup', routeHistoryCommand.handleMouseUp, true)
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
  const startupNavigation = navigation.session.value

  // Closing a view only saves its navigation; main flushes the Core owner.
  removePlaybackSessionSaveListener = window.api.app.onSavePlaybackSession(async () => {
    navigationPersistence.flush()
  })
  // Run independent startup operations in parallel so none blocks the others.
  const libraryLoad = loadApplicationLibrary()
  const playlistsLoad = loadPlaylists()
  const libraryPromise = libraryLoad.catch((error) =>
    reportStartupDataError('music library', error)
  )
  const playlistsPromise = playlistsLoad.catch((error) =>
    reportStartupDataError('playlists', error)
  )
  const extensionsPromise = syncExtensions().then(() => {
    const canEnterExperience =
      !needsOnboarding && !pendingNavigation && navigation.session.value === startupNavigation
    // Full interfaces are restored only by the explicit startup preference, never by page memory.
    navigationPersistence.resolvePluginPages([
      ...availablePluginPages.value.filter((page) => !page.experience),
      ...localSidebarItems.value
    ])
    if (
      canEnterExperience &&
      applyStartupExperience(
        navigation,
        loadedSettings.startupExperience,
        availablePluginPages.value
      ) === 'unavailable'
    ) {
      pushNotice({
        kind: 'warning',
        message: '所选完整界面未启用或已移除，已使用 Twilight Echo 默认界面。'
      })
    }
  })
  if (loadedSettings.autoCheckLogin) {
    idleLoginCheck = scheduleIdleTask(() => {
      idleLoginCheck = null
      void checkLogin()
    })
  }

  await libraryPromise
  // Ensure extensions are loaded before wiring listeners that depend on them.
  await extensionsPromise
  await applyActiveTheme(false)
  await playlistsPromise

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
  [showSettingsPage, showPluginPage, showAppearancePage, appearanceFullWindowPreview],
  () => {
    document.body.classList.toggle(
      'te-settings-surface',
      !appearanceFullWindowPreview.value &&
        (showSettingsPage.value || showPluginPage.value || showAppearancePage.value)
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
  removePlaybackSessionSaveListener?.()
  removePlaybackSessionSaveListener = null
  removeAppNavigationListener?.()
  removeAppNavigationListener = null
  removeHistoryCommandListener?.()
  removeHistoryCommandListener = null
  window.removeEventListener('mouseup', routeHistoryCommand.handleMouseUp, true)
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
  if (showPluginPage.value) return 'settings'
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
    v-if="appearanceFullWindowPreview || (!appearancePageRetained && !appearanceEditorOpen)"
    :settings="
      appearanceChromePreview?.appearanceLayers ?? effectiveThemeLayers ?? settings.appearanceLayers
    "
  />
  <AppBackgroundLayer
    :page="showStreamingSurface ? 'streaming' : 'local'"
    :ambient="localViewVisible && activeCategory === 'dashboard'"
  />
  <div
    class="app-shell"
    :class="{ 'is-immersive': showPlayingPage }"
    :inert="appearanceFullWindowPreview"
    :style="{
      '--te-side-menu-bottom': `${sideMenuBottomOffset}px`,
      '--te-side-menu-tools-clearance': `${sideMenuToolsClearance}px`
    }"
  >
    <LiquidGlassDefs :active="playbarRefractionActive" />
    <div class="app-shell-title">
      <TitleBar
        :close-only="showOnboarding"
        :immersive="showPlayingPage"
        :liquid-material="liquidGlassChromeActive"
        :streaming="showStreamingPage && !showPlayingPage"
        :title-surface="titleSurface"
        :active-tool="
          showAppearancePage
            ? 'appearance'
            : showPluginPage
              ? 'plugins'
              : showSettingsPage
                ? 'settings'
                : null
        "
        :page-dock-actions="pageDock.actions.value"
        :menu-open="titleMenuOpen"
        @toggle-menu="toggleMenu"
        @collapse-menu="collapseMenu"
        @back="handleTitleBack"
        @login="handleTitleLogin"
        @settings="toggleSettingsPage"
        @appearance="
          showAppearancePage ? appearancePageRef?.requestClose?.() : openAppearancePage()
        "
        @plugins="togglePluginPage"
        @library="selectSidebarPage({ kind: 'local', category: 'allSongs', filter: null })"
        :notifications-open="noticeHostRef?.historyOpen ?? false"
        @notifications="noticeHostRef?.toggleHistory($event)"
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
        :widgets="sidebarExperiences"
        @vue:mounted="startSideMenuMonitor"
        @select-page="selectSidebarPage($event.target)"
      />
    </div>
    <div class="app-shell-content">
      <div
        class="main-content"
        :class="{
          'menu-open': menuOpen && showLocalSidebar,
          'playing-open': showPlayingPage,
          'plugin-open': showPluginPage,
          'dsp-rack-open': showDspRackPage,
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
            @open-artist="handlePlayerBarArtistClick"
            @open-album="handlePlayingAlbumClick"
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
          :metadata-navigation-request="
            showStreamingSurface && tab === streamingMetadataTab && streamingTab === tab
              ? streamingMetadataRequest
              : null
          "
          @navigate-tab="enterStreamingMode($event)"
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
          v-if="audioWorkspaceRetained"
          ref="audioWorkspaceRef"
          :active="showDspRackPage || showEqualizerPage"
          :initial-tab="audioWorkspaceInitialTab"
        />
        <Transition name="login-page">
          <PluginExtensionPage
            v-if="activePluginPage && !activePluginPage.experience"
            :key="activePageId"
            :page="activePluginPage"
          />
        </Transition>
      </div>
    </div>
    <div class="app-shell-player">
      <PlayerBar
        v-if="hasPlayerBar"
        ref="playerBarRef"
        :glass="showPlayingPage"
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
      <AppearancePage
        v-if="appearancePageRetained"
        v-show="showAppearancePage"
        ref="appearancePageRef"
        :active="showAppearancePage"
        :pages="navigationPages"
        :initial-domain="themeStudioInitialDomain"
        :navigation-target="appearanceNavigationTarget"
        @tab-change="navigation.rememberAppearanceTab"
        @domain-change="navigation.rememberThemeStudioDomain"
        @back="closeAppearancePage"
        @open-plugins="openPluginPage"
      />
    </Transition>
    <Transition
      name="settings-page"
      @before-leave="retainSettingsOverlay"
      @after-leave="releaseSettingsOverlay"
      @leave-cancelled="releaseSettingsOverlay"
    >
      <SettingsPage
        v-if="showSettingsPage"
        :initial-section="settingsInitialSection"
        :navigation-target="settingsNavigationTarget"
        @section-change="navigation.rememberSettingsSection"
        @open-equalizer="openEqualizerPage"
        @open-dsp-rack="openDspRackPage"
        @open-theme-studio="openThemeStudioPage"
        @open-theme-workshop="openThemeWorkshop"
        @open-appearance="openAppearancePage"
        @reopen-onboarding="handleReopenOnboarding"
      />
    </Transition>
    <Transition
      name="settings-page"
      @before-leave="retainSettingsOverlay"
      @after-leave="releaseSettingsOverlay"
      @leave-cancelled="releaseSettingsOverlay"
    >
      <PluginPage
        v-if="showPluginPage"
        @open-theme-workshop="
          onSelectPluginPage({
            pluginId: 'com.twilightecho.tool.theme-workshop',
            id: 'theme-workshop',
            kind: 'sidebarPage',
            title: '主题插件工坊',
            command: 'theme-workshop.open'
          })
        "
      />
    </Transition>
  </div>
  <ExperienceView
    v-if="activePluginPage?.experience"
    :key="activePluginPage.pluginId + ':' + activePluginPage.experience.version"
    :experience="activePluginPage.experience"
    @exit="navigation.closePluginPage()"
  />
  <CommandPalette
    v-if="commandPalette.isOpen.value"
    :actions="commandPalette.actions.value"
    :search="commandPalette.search"
    :playlists="commandPalette.playlists"
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
  <MusicMetadataSetupHost :suspended="showOnboarding" />
  <NativeDialogTransition>
    <QueueWorkspaceDialog
      v-if="queueSessions.open.value"
      :workspace="queueWorkspace"
      :controller="queueSessions"
      :queue-length="queueCount"
      :can-undo="canUndoQueue"
      :undo-label="queueUndoLabel"
      :undo="undoQueue"
      @close="queueSessions.open.value = false"
    />
  </NativeDialogTransition>
  <AppNoticeHost
    ref="noticeHostRef"
    @library="selectSidebarPage({ kind: 'local', category: 'allSongs', filter: null })"
  />
  <ExperienceFlyout />
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
  grid-area: navigation;
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
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  min-width: 0;
  height: 100% !important;
  border-radius: 0;
}

html[data-te-shell-layout='custom'][data-te-shell-navigation='persistent']
  .app-shell-navigation
  .side-menu {
  transform: none !important;
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
    position: fixed;
    top: var(--te-titlebar-inset, 32px);
    left: 0;
    width: var(--te-menu-width);
    bottom: var(--te-side-menu-bottom, 0px);
    z-index: 1000;
  }

  html[data-te-shell-layout='custom'] .app-shell-navigation.navigation-temporary .side-menu {
    transform: none;
  }
}

/* The clearance is animated on `padding-left` itself, deliberately, even though
   that reflows this subtree every frame of the 0.32s slide.

   The alternative — land the padding instantly and give the distance back with a
   composited `translate` — is cheaper but geometrically wrong here. This box is
   `width: 100%` and `border-box`, so its right edge is pinned to the window and
   only its width changes; a translate moves *both* edges, so the right edge
   snapped inward by the clearance on the first frame and slid back over the
   remaining ones. That read as the content flashing on the right, and on the
   collapsing direction it overhung the window and flickered a scrollbar in.

   Pinning the right edge while the left one moves *is* a width change, and a
   width change is a layout. There is no compositor-only spelling of it: only
   `scaleX` alters visual width, and that stretches the glyphs. So the cost is
   the intended trade, not an oversight — keep the layout property here. */
.main-content {
  display: grid;
  box-sizing: border-box;
  margin-left: 0;
  width: 100%;
  min-height: 100vh;
  padding-left: 0;
  transform: translateZ(0);
  transition: padding-left var(--te-motion-panel) var(--te-ease-soft);
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
  padding-left: var(--te-menu-width);
}

.main-content.playing-open {
  overflow: visible;
}

.main-content.plugin-open {
  min-height: 100vh !important;
  height: 100vh;
}

.main-content.dsp-rack-open {
  height: 100vh;
  min-height: 0 !important;
}

.main-content.dsp-rack-open > .dsp-rack-page {
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

/* PlayingMusic open/close — expands from / shrinks to cover position */
.playing-page-enter-active {
  transition:
    transform var(--te-motion-page) var(--te-ease-out-expo),
    opacity var(--te-motion-panel) ease,
    border-radius var(--te-motion-page) var(--te-ease-out-expo);
}
.playing-page-leave-active {
  transition:
    transform var(--te-motion-panel) var(--te-ease-enter),
    opacity var(--te-motion-hover) ease,
    border-radius var(--te-motion-panel) var(--te-ease-enter);
}

.playing-page-enter-from {
  transform: scale(0.12) !important;
  border-radius: 28px;
  opacity: 0;
}

.playing-page-leave-to {
  transform: scale(0.12) !important;
  border-radius: 28px;
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
  transition:
    opacity var(--te-motion-settle) ease,
    transform var(--te-motion-settle) var(--te-ease-out-expo),
    filter var(--te-motion-settle) var(--te-ease-out-expo);
}
.onboarding-page-enter-from {
  opacity: 0;
}
.onboarding-page-leave-to {
  opacity: 0;
  transform: scale(1.02);
  filter: blur(10px);
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
</style>

<style>
.streaming-page.menu-open .streaming-content {
  padding-left: var(--te-menu-width);
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
  position: fixed;
  top: var(--te-titlebar-inset, 32px);
  left: 0;
  width: var(--te-menu-width);
  bottom: var(--te-side-menu-bottom, 0px);
  z-index: 1000;
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
