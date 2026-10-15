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
export type AppearanceWorkspaceTab = 'adjust' | 'studio' | 'workshop'
export type AudioWorkspaceTab = 'equalizer' | 'effects'
export interface SettingsNavigationTarget {
  revision: number
  entry?: SettingsSearchEntry
  anchor?: string
  appearanceTab?: AppearanceWorkspaceTab
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

export function useAppNavigation(options: { appearancePreviewActive?: () => boolean } = {}) {
  const menuOpen = ref(false)
  const pageTarget = shallowRef<NavigationPageTarget>(localHome())
  const overlay = ref<Overlay | null>(null)
  const overlayHistory = reactive<Array<Overlay | null>>([])
  const history = shallowRef<NavigationPageTarget[]>([])
  const lastLocal = shallowRef<Extract<NavigationPageTarget, { kind: 'local' }>>(localHome())
  const loginPageMode = ref<'login' | 'profile'>('login')
  const loginInitialProviderId = ref<string | null>(null)
  const showAccountPage = ref(false)
  const accountInitialProviderId = ref<string | null>(null)
  const themeStudioInitialDomain = ref<ThemeStudioDomain>('presets')
  const themeReturn = ref<'playing' | 'settings' | null>(null)
  const settingsInitialSection = ref<SettingsSection>('general')
  const settingsCurrentSection = ref<SettingsSection>('general')
  const themeStudioCurrentDomain = ref<ThemeStudioDomain>('presets')
  const appearanceTab = ref<AppearanceWorkspaceTab>('adjust')
  const settingsNavigationTarget = shallowRef<SettingsNavigationTarget>({ revision: 0 })
  const appearanceNavigationTarget = shallowRef<SettingsNavigationTarget>({ revision: 0 })
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
    appearanceTab: appearanceTab.value,
    themeReturn: themeReturn.value,
    loginPageMode: loginPageMode.value,
    loginProviderId: loginInitialProviderId.value
  }))

  function restoreSession(saved: NavigationSession, pages: UiContribution[] = []): void {
    closeAccountPage()
    pageTarget.value = resolveNavigationTarget(saved.pageTarget, pages) ?? localHome()
    history.value = saved.history.flatMap((target) => resolveNavigationTarget(target, pages) ?? [])
    lastLocal.value = saved.lastLocal
    overlayHistory.splice(0, overlayHistory.length, ...saved.overlayHistory)
    overlay.value = saved.overlay === 'theme' ? 'appearance' : saved.overlay
    if (saved.overlay === 'theme') {
      const previous = overlayHistory.lastIndexOf('appearance')
      if (previous !== -1) overlayHistory.splice(previous)
    }
    appearanceTab.value = saved.overlay === 'theme' ? 'studio' : (saved.appearanceTab ?? 'adjust')
    if (
      saved.pageTarget.kind === 'plugin' &&
      saved.pageTarget.pluginId === 'com.twilightecho.tool.theme-workshop' &&
      saved.pageTarget.pageId === 'theme-workshop'
    ) {
      pageTarget.value = history.value.pop() ?? saved.lastLocal
      appearanceTab.value = 'workshop'
      if (!overlay.value) {
        overlay.value = 'appearance'
        overlayHistory.splice(0, overlayHistory.length, null)
      } else if (overlay.value !== 'appearance' && !overlayHistory.includes('appearance')) {
        if (overlayHistory[0] === null) overlayHistory.splice(1, 0, 'appearance')
        else overlayHistory.unshift(null, 'appearance')
      }
    }
    appearanceNavigationTarget.value = { revision: 0, appearanceTab: appearanceTab.value }
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
    closeAccountPage()
    if (overlay.value === key) return
    overlayHistory.push(overlay.value)
    overlay.value = key
  }
  function closeOverlay(key: Overlay): void {
    closeAccountPage()
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
  const showAppearancePage = overlayFlag('appearance')
  const showThemeStudioPage = computed(
    () => showAppearancePage.value && appearanceTab.value === 'studio'
  )
  const showPluginPage = overlayFlag('plugins')
  const showEqualizerPage = overlayFlag('equalizer')
  const showDspRackPage = overlayFlag('dsp')
  const showAudioWorkspace = computed(() => showEqualizerPage.value || showDspRackPage.value)
  const audioWorkspaceTab = computed<AudioWorkspaceTab>(() =>
    showDspRackPage.value ? 'effects' : 'equalizer'
  )
  // Preview the retained page without dismissing Settings or changing its return path.
  const pageContentVisible = computed(
    () =>
      !overlay.value ||
      ((overlay.value === 'settings' || overlay.value === 'appearance') &&
        (overlay.value !== 'appearance' || appearanceTab.value === 'adjust') &&
        !!options.appearancePreviewActive?.())
  )
  const showStreamingPage = computed(
    () => pageTarget.value.kind === 'streaming' && pageContentVisible.value
  )
  const showStreamingSurface = showStreamingPage
  const showRadioPodcastPage = computed(
    () => pageTarget.value.kind === 'radio' && pageContentVisible.value
  )
  const showNetworkSourcesPage = computed(
    () => pageTarget.value.kind === 'network' && pageContentVisible.value
  )
  const showRecentPage = computed(
    () => pageTarget.value.kind === 'recent' && pageContentVisible.value
  )
  const localViewVisible = computed(
    () => pageTarget.value.kind === 'local' && pageContentVisible.value
  )
  const activePluginPage = computed(() =>
    pageTarget.value.kind === 'plugin' && pageContentVisible.value ? pageTarget.value.page : null
  )
  const activePageId = computed(() => navigationTargetId(pageTarget.value))
  const isHome = computed(
    () =>
      !overlay.value &&
      pageTarget.value.kind === 'local' &&
      pageTarget.value.category === 'dashboard'
  )
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
    closeAccountPage()
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
    if (page.pluginId === 'com.twilightecho.tool.theme-workshop' && page.id === 'theme-workshop') {
      openAppearancePage(undefined, 'workshop')
      return
    }
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
  function goHome(): void {
    selectSidebarPage(localHome())
    collapseMenu()
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
  function openAccountPage(initialProviderId: string | null = null): void {
    accountInitialProviderId.value = initialProviderId
    showAccountPage.value = true
  }
  function closeAccountPage(): void {
    showAccountPage.value = false
    accountInitialProviderId.value = null
  }
  function openSettingsPage(
    section: SettingsSectionInput = settingsCurrentSection.value,
    target: Omit<SettingsNavigationTarget, 'revision'> = {}
  ): void {
    if (section === 'appearance' || target.entry?.section === 'appearance') {
      openAppearancePage(target.entry)
      return
    }
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
  function openAppearancePage(
    entry?: SettingsSearchEntry,
    tab: AppearanceWorkspaceTab = 'adjust'
  ): void {
    appearanceTab.value = tab
    appearanceNavigationTarget.value = {
      ...(entry?.section === 'appearance' ? { entry } : {}),
      appearanceTab: tab,
      revision: appearanceNavigationTarget.value.revision + 1
    }
    openOverlay('appearance')
  }
  function closeAppearancePage(): void {
    closeOverlay('appearance')
  }
  // Compatibility entry for older commands; Appearance has its own page and back route.
  function openSettingsCategory(section: SectionKey, entry?: SettingsSearchEntry): void {
    if (section === 'appearance') {
      if (overlay.value === 'appearance' && !entry) return
      openAppearancePage(entry, entry ? 'adjust' : appearanceTab.value)
    } else openSettingsPage(section, entry ? { entry } : {})
  }
  function openThemeStudioPage(initialDomain: ThemeStudioDomain = 'presets'): void {
    themeStudioInitialDomain.value = initialDomain
    themeStudioCurrentDomain.value = initialDomain
    themeReturn.value = null
    openAppearancePage(undefined, 'studio')
  }
  function closeThemeStudioPage(): void {
    closeAppearancePage()
  }
  function openPlaybackSettings(): void {
    openSettingsPage('playback')
  }
  function openDspSettings(): void {
    openDspRackPage()
  }
  function openPluginPage(): void {
    openOverlay('plugins')
  }
  function hidePluginPage(): void {
    showPluginPage.value = false
  }
  function openEqualizerPage(): void {
    switchAudioWorkspaceTab('equalizer')
  }
  function closeEqualizerPage(): void {
    if (showEqualizerPage.value) closeAudioWorkspace()
  }
  function openDspRackPage(): void {
    switchAudioWorkspaceTab('effects')
  }
  function closeDspRackPage(): void {
    if (showDspRackPage.value) closeAudioWorkspace()
  }
  function openAudioWorkspace(): void {
    // The title-bar entry resumes the active tab and its in-progress edits.
    closeAccountPage()
    if (!showAudioWorkspace.value) openEqualizerPage()
  }
  function switchAudioWorkspaceTab(tab: AudioWorkspaceTab): void {
    const target = tab === 'effects' ? 'dsp' : 'equalizer'
    if (showAudioWorkspace.value) {
      closeAccountPage()
      overlay.value = target
    } else openOverlay(target)
  }
  function closeAudioWorkspace(): void {
    if (!showAudioWorkspace.value) return
    // Old sessions could have stacked the former independent audio pages.
    while (overlayHistory.at(-1) === 'dsp' || overlayHistory.at(-1) === 'equalizer')
      overlayHistory.pop()
    closeOverlay(overlay.value!)
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
      closeAccountPage()
      if (overlay.value && overlay.value !== 'plugins') {
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
    isHome,
    goHome,
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
    showAccountPage,
    accountInitialProviderId,
    openAccountPage,
    closeAccountPage,
    loginPageMode,
    loginInitialProviderId,
    showSettingsPage,
    showAppearancePage,
    appearanceNavigationTarget,
    appearanceTab,
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
    openSettingsCategory,
    closeSettingsPage,
    openAppearancePage,
    closeAppearancePage,
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
    openAudioWorkspace,
    switchAudioWorkspaceTab,
    closeAudioWorkspace,
    openLibraryPlaylist,
    closeMissingPluginPage,
    createToggleMenuHandler,
    createToggleSettingsHandler,
    createTogglePluginHandler
  }
}
