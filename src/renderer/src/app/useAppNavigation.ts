import { computed, reactive, ref, shallowRef } from 'vue'
import type { UiContribution } from '@renderer/extensions/registry'
import {
  normalizeSettingsSection,
  LEGACY_SETTINGS_TARGETS,
  type SettingsSectionInput,
  type SectionKey,
  type SettingsSearchEntry
} from '@renderer/components/settings-page/types.ts'
import {
  navigationTargetId,
  type NavigationPageTarget,
  type StreamingPageTab
} from '@renderer/app/navigationPages.ts'
import {
  navigationHome,
  saveNavigationTarget,
  resolveNavigationTarget,
  type NavigationSession,
  type NavigationOverlay
} from './navigationSession.ts'

export type SettingsSection = SectionKey
export interface SettingsNavigationTarget {
  revision: number
  entry?: SettingsSearchEntry
  anchor?: string
}
export type ThemeStudioDomain =
  | 'presets'
  | 'personalization'
  | 'shell'
  | 'navigation'
  | 'library'
  | 'typography'
  | 'player'
  | 'windows'
  | 'motion'
  | 'advanced'
type Overlay = NavigationOverlay
const localHome = navigationHome
const songlistOrder = [
  'dashboard',
  'allSongs',
  'artists',
  'albums',
  'genres',
  'playlists',
  'aggregate',
  'folders',
  'recent',
  'analytics'
]

export function useAppNavigation() {
  const menuOpen = ref(false)
  const pageTarget = shallowRef<NavigationPageTarget>(localHome())
  const overlay = ref<Overlay | null>(null)
  const overlayHistory = reactive<Array<Overlay | null>>([])
  const history = shallowRef<NavigationPageTarget[]>([])
  const lastLocal = shallowRef<Extract<NavigationPageTarget, { kind: 'local' }>>(localHome())
  const loginPageMode = ref<'login' | 'profile'>('login')
  const loginInitialProviderId = ref<string | null>(null)
  const themeStudioInitialDomain = ref<ThemeStudioDomain>('presets')
  const themeReturn = ref<'playing' | 'settings' | null>(null)
  const settingsInitialSection = ref<SettingsSection>('general')
  const settingsCurrentSection = ref<SettingsSection>('general')
  const themeStudioCurrentDomain = ref<ThemeStudioDomain>('presets')
  const settingsNavigationTarget = shallowRef<SettingsNavigationTarget>({ revision: 0 })
  const songlistTransitionName = ref<'page-down' | 'page-up'>('page-down')

  const session = computed<NavigationSession>(() => ({
    version: 1,
    pageTarget: saveNavigationTarget(pageTarget.value),
    history: history.value.map(saveNavigationTarget),
    lastLocal: lastLocal.value,
    overlay: overlay.value,
    overlayHistory: [...overlayHistory],
    menuOpen: menuOpen.value,
    settingsSection: settingsCurrentSection.value,
    themeStudioDomain: themeStudioCurrentDomain.value,
    themeReturn: themeReturn.value,
    loginPageMode: loginPageMode.value,
    loginProviderId: loginInitialProviderId.value
  }))

  function restoreSession(saved: NavigationSession, pages: UiContribution[] = []): void {
    pageTarget.value = resolveNavigationTarget(saved.pageTarget, pages) ?? localHome()
    history.value = saved.history.flatMap((target) => resolveNavigationTarget(target, pages) ?? [])
    lastLocal.value = saved.lastLocal
    overlayHistory.splice(0, overlayHistory.length, ...saved.overlayHistory)
    overlay.value = saved.overlay
    menuOpen.value = saved.menuOpen
    settingsInitialSection.value = settingsCurrentSection.value = saved.settingsSection
    themeStudioInitialDomain.value = themeStudioCurrentDomain.value = saved.themeStudioDomain
    themeReturn.value = saved.themeReturn
    loginPageMode.value = saved.loginPageMode
    loginInitialProviderId.value = saved.loginProviderId
  }

  function rememberSettingsSection(section: SettingsSectionInput): void {
    settingsCurrentSection.value = normalizeSettingsSection(section)
  }

  function rememberThemeStudioDomain(domain: ThemeStudioDomain): void {
    themeStudioCurrentDomain.value = domain
  }

  function openOverlay(key: Overlay): void {
    if (overlay.value === key) return
    overlayHistory.push(overlay.value)
    overlay.value = key
  }
  function closeOverlay(key: Overlay): void {
    if (overlay.value !== key) return
    overlay.value = overlayHistory.pop() ?? null
  }
  function overlayFlag(key: Overlay) {
    return computed({
      get: () => overlay.value === key,
      set: (value: boolean) => {
        if (value) openOverlay(key)
        else closeOverlay(key)
      }
    })
  }
  const showPlayingPage = overlayFlag('playing')
  const showLoginPage = overlayFlag('login')
  const showSettingsPage = overlayFlag('settings')
  const showThemeStudioPage = overlayFlag('theme')
  const showPluginPage = overlayFlag('plugins')
  const showEqualizerPage = overlayFlag('equalizer')
  const showDspRackPage = overlayFlag('dsp')
  const showStreamingPage = computed(() => pageTarget.value.kind === 'streaming' && !overlay.value)
  const showStreamingSurface = showStreamingPage
  const showRadioPodcastPage = computed(() => pageTarget.value.kind === 'radio' && !overlay.value)
  const showNetworkSourcesPage = computed(
    () => pageTarget.value.kind === 'network' && !overlay.value
  )
  const showRecentPage = computed(() => pageTarget.value.kind === 'recent' && !overlay.value)
  const localViewVisible = computed(() => pageTarget.value.kind === 'local' && !overlay.value)
  const activePluginPage = computed(() =>
    pageTarget.value.kind === 'plugin' && !overlay.value ? pageTarget.value.page : null
  )
  const activePageId = computed(() => navigationTargetId(pageTarget.value))
  const canGoBackPage = computed(() => history.value.length > 0 && !overlay.value)
  const activeCategory = computed(() =>
    pageTarget.value.kind === 'local' ? pageTarget.value.category : 'dashboard'
  )
  const activeFilter = computed(() =>
    pageTarget.value.kind === 'local' ? pageTarget.value.filter : null
  )
  const streamingTab = computed<StreamingPageTab>(() =>
    pageTarget.value.kind === 'streaming' ? pageTarget.value.tab : 'home'
  )

  function navigate(target: NavigationPageTarget, options?: { resetHistory?: boolean }): void {
    if (pageTarget.value.kind === 'local') lastLocal.value = pageTarget.value
    if (options?.resetHistory) {
      history.value = []
    } else if (
      navigationTargetId(target) !== activePageId.value ||
      JSON.stringify(target) !== JSON.stringify(pageTarget.value)
    ) {
      history.value = [...history.value.slice(-49), pageTarget.value]
    }
    pageTarget.value = target
    overlayHistory.length = 0
    overlay.value = null
  }
  function selectSidebarPage(target: NavigationPageTarget): void {
    // Sidebar entries are roots, not another level in the current return path.
    navigate(target, { resetHistory: true })
  }
  function goBackPage(): void {
    const previous = history.value.at(-1)
    if (!previous) return
    history.value = history.value.slice(0, -1)
    pageTarget.value = previous
  }
  function onSelectView(category: string, filter: string | null): void {
    if (category === 'recent') {
      navigate({ kind: 'recent', scope: 'device' })
      return
    }
    const current = songlistOrder.indexOf(activeCategory.value)
    const next = songlistOrder.indexOf(category)
    if (current !== -1 && next !== -1)
      songlistTransitionName.value = next > current ? 'page-down' : 'page-up'
    navigate({ kind: 'local', category, filter })
  }
  function enterStreamingMode(tab: StreamingPageTab = 'home'): void {
    navigate({ kind: 'streaming', tab })
  }
  function returnToLocalMode(): void {
    navigate(lastLocal.value)
  }
  function onSelectPluginPage(page: UiContribution): void {
    navigate({ kind: 'plugin', page })
  }
  function closePluginPage(): void {
    goBackPage()
  }
  function enterRadioPodcastMode(): void {
    navigate({ kind: 'radio' })
  }
  function closeRadioPodcastPage(): void {
    goBackPage()
  }
  function enterNetworkSourcesMode(): void {
    navigate({ kind: 'network' })
  }
  function closeNetworkSourcesPage(): void {
    goBackPage()
  }
  function collapseMenu(): void {
    menuOpen.value = false
  }
  function openPlayingPage(): void {
    openOverlay('playing')
  }
  function closePlayingPage(): void {
    showPlayingPage.value = false
  }
  function openLoginPage(
    initialProviderId: string | null = null,
    options?: { profile?: boolean }
  ): void {
    loginPageMode.value = options?.profile ? 'profile' : 'login'
    loginInitialProviderId.value = initialProviderId
    openOverlay('login')
  }
  function closeLoginPage(): void {
    showLoginPage.value = false
    loginPageMode.value = 'login'
    loginInitialProviderId.value = null
  }
  function openSettingsPage(
    section: SettingsSectionInput = settingsCurrentSection.value,
    target: Omit<SettingsNavigationTarget, 'revision'> = {}
  ): void {
    settingsInitialSection.value = normalizeSettingsSection(section)
    settingsCurrentSection.value = normalizeSettingsSection(section)
    settingsNavigationTarget.value = {
      ...target,
      ...(!target.anchor && !target.entry && Object.hasOwn(LEGACY_SETTINGS_TARGETS, section)
        ? {
            anchor: LEGACY_SETTINGS_TARGETS[section as keyof typeof LEGACY_SETTINGS_TARGETS].anchor
          }
        : {}),
      revision: settingsNavigationTarget.value.revision + 1
    }
    openOverlay('settings')
  }
  function closeSettingsPage(): void {
    showSettingsPage.value = false
  }
  function openThemeStudioPage(initialDomain: ThemeStudioDomain = 'presets'): void {
    themeStudioInitialDomain.value = initialDomain
    themeStudioCurrentDomain.value = initialDomain
    themeReturn.value =
      initialDomain === 'presets' || showSettingsPage.value
        ? 'settings'
        : showPlayingPage.value
          ? 'playing'
          : null
    openOverlay('theme')
  }
  function closeThemeStudioPage(): void {
    closeOverlay('theme')
    if (themeReturn.value === 'settings') openSettingsPage('appearance')
  }
  function openPlaybackSettings(): void {
    openSettingsPage('playback')
  }
  function openDspSettings(): void {
    openSettingsPage('dsp')
  }
  function openPluginPage(): void {
    openOverlay('plugins')
  }
  function hidePluginPage(): void {
    showPluginPage.value = false
  }
  function openEqualizerPage(): void {
    openOverlay('equalizer')
  }
  function closeEqualizerPage(): void {
    showEqualizerPage.value = false
  }
  function openDspRackPage(): void {
    openOverlay('dsp')
  }
  function closeDspRackPage(): void {
    showDspRackPage.value = false
  }
  function openLibraryPlaylist(playlist: { id: string; name: string; kind?: 'aggregate' }): void {
    onSelectView(
      playlist.kind === 'aggregate' ? 'aggregate' : 'playlists',
      playlist.kind === 'aggregate' ? playlist.id : `playlist:${playlist.name}`
    )
  }
  function closeMissingPluginPage(pages: UiContribution[]): void {
    const nextHistory = history.value.filter(
      (entry) =>
        entry.kind !== 'plugin' ||
        pages.some((page) => page.pluginId === entry.page.pluginId && page.id === entry.page.id)
    )
    if (nextHistory.length !== history.value.length) history.value = nextHistory
    const target = pageTarget.value
    if (target.kind !== 'plugin') return
    if (
      !pages.some((page) => page.pluginId === target.page.pluginId && page.id === target.page.id)
    ) {
      pageTarget.value = localHome()
    }
  }
  function createToggleMenuHandler(): () => void {
    return () => {
      if (overlay.value) {
        overlay.value = null
        overlayHistory.length = 0
        menuOpen.value = true
      } else menuOpen.value = !menuOpen.value
    }
  }
  function createToggleSettingsHandler(): () => void {
    return () => (showSettingsPage.value ? closeSettingsPage() : openSettingsPage())
  }
  function createTogglePluginHandler(): () => void {
    return () => (showPluginPage.value ? hidePluginPage() : openPluginPage())
  }

  return {
    session,
    restoreSession,
    rememberSettingsSection,
    rememberThemeStudioDomain,
    menuOpen,
    pageTarget,
    activePageId,
    streamingTab,
    canGoBackPage,
    navigate,
    selectSidebarPage,
    goBackPage,
    showPlayingPage,
    showStreamingPage,
    showStreamingSurface,
    showRadioPodcastPage,
    showNetworkSourcesPage,
    showRecentPage,
    showLoginPage,
    loginPageMode,
    loginInitialProviderId,
    showSettingsPage,
    showThemeStudioPage,
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
    localViewVisible,
    collapseMenu,
    onSelectView,
    closePluginPage,
    onSelectPluginPage,
    openPlayingPage,
    closePlayingPage,
    enterStreamingMode,
    returnToLocalMode,
    enterRadioPodcastMode,
    closeRadioPodcastPage,
    enterNetworkSourcesMode,
    closeNetworkSourcesPage,
    openLoginPage,
    closeLoginPage,
    openSettingsPage,
    closeSettingsPage,
    openThemeStudioPage,
    closeThemeStudioPage,
    openPlaybackSettings,
    openDspSettings,
    openPluginPage,
    hidePluginPage,
    openEqualizerPage,
    closeEqualizerPage,
    openDspRackPage,
    closeDspRackPage,
    openLibraryPlaylist,
    closeMissingPluginPage,
    createToggleMenuHandler,
    createToggleSettingsHandler,
    createTogglePluginHandler
  }
}
