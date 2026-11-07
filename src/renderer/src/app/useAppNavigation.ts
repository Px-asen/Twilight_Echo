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
  BUILTIN_NAVIGATION_PAGES,
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
import { buildSidebarEntries } from './sidebarNavigation.ts'
import type { PageMotionName } from './motion/policy.ts'

export type SettingsSection = SectionKey
export type AppearanceWorkspaceTab = 'adjust' | 'studio' | 'workshop'
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
const defaultPageOrder = buildSidebarEntries(BUILTIN_NAVIGATION_PAGES).flatMap((entry) =>
  entry.kind === 'page' ? [entry.page.id] : entry.pages.map((page) => page.id)
)

export function useAppNavigation(
  options: {
    appearancePreviewActive?: () => boolean
    pageOrder?: () => string[]
  } = {}
) {
  const menuOpen = ref(false)
  const pageTarget = shallowRef<NavigationPageTarget>(localHome())
  const overlay = ref<Overlay | null>(null)
  const overlayHistory = reactive<Array<Overlay | null>>([])
  const history = shallowRef<NavigationPageTarget[]>([])
  // Pages the user backed out of, newest last. A fresh navigation drops it so
  // the side-button forward key behaves like a browser's forward history.
  const forwardHistory = shallowRef<NavigationPageTarget[]>([])
  const lastLocal = shallowRef<Extract<NavigationPageTarget, { kind: 'local' }>>(localHome())
  const loginPageMode = ref<'login' | 'profile'>('login')
  const loginInitialProviderId = ref<string | null>(null)
  const themeStudioInitialDomain = ref<ThemeStudioDomain>('presets')
  const themeReturn = ref<'playing' | 'settings' | null>(null)
  const settingsInitialSection = ref<SettingsSection>('general')
  const settingsCurrentSection = ref<SettingsSection>('general')
  const themeStudioCurrentDomain = ref<ThemeStudioDomain>('presets')
  const appearanceTab = ref<AppearanceWorkspaceTab>('adjust')
  const appearanceNavigationTarget = shallowRef<SettingsNavigationTarget>({ revision: 0 })
  const settingsNavigationTarget = shallowRef<SettingsNavigationTarget>({ revision: 0 })
  const songlistTransitionName = ref<PageMotionName>('page-down')

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
    pageTarget.value = resolveNavigationTarget(saved.pageTarget, pages) ?? localHome()
    history.value = saved.history.flatMap((target) => resolveNavigationTarget(target, pages) ?? [])
    lastLocal.value = saved.lastLocal
    const migrateOverlay = (page: Overlay | null): Overlay | null =>
      page === 'theme' ? 'appearance' : page
    overlayHistory.splice(0, overlayHistory.length, ...saved.overlayHistory.map(migrateOverlay))
    overlay.value = migrateOverlay(saved.overlay)
    appearanceTab.value =
      saved.overlay === 'theme' || saved.overlayHistory.includes('theme')
        ? 'studio'
        : (saved.appearanceTab ?? 'adjust')
    appearanceNavigationTarget.value = { revision: 0, appearanceTab: appearanceTab.value }
    if (
      saved.pageTarget.kind === 'plugin' &&
      saved.pageTarget.pluginId === 'com.twilightecho.tool.theme-workshop' &&
      saved.pageTarget.pageId === 'theme-workshop'
    ) {
      pageTarget.value = history.value.pop() ?? saved.lastLocal
      appearanceTab.value = 'workshop'
      appearanceNavigationTarget.value = { revision: 0, appearanceTab: 'workshop' }
      if (!overlay.value) {
        overlay.value = 'appearance'
        overlayHistory.splice(0, overlayHistory.length, null)
      } else if (overlay.value !== 'appearance' && !overlayHistory.includes('appearance')) {
        overlayHistory.unshift('appearance')
      }
    }
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
  function rememberAppearanceTab(tab: AppearanceWorkspaceTab): void {
    appearanceTab.value = tab
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
  const showAppearancePage = overlayFlag('appearance')
  const showThemeStudioPage = computed(
    () => showAppearancePage.value && appearanceTab.value === 'studio'
  )
  const showPluginPage = overlayFlag('plugins')
  const showEqualizerPage = overlayFlag('equalizer')
  const showDspRackPage = overlayFlag('dsp')
  // Preview the retained page without dismissing Settings or changing its return path.
  const pageContentVisible = computed(
    () =>
      !overlay.value ||
      ((overlay.value === 'settings' || overlay.value === 'appearance') &&
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
  const showZonesPage = computed(
    () => pageTarget.value.kind === 'zones' && pageContentVisible.value
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
  const canGoBackPage = computed(() => history.value.length > 0 && !overlay.value)
  const canGoForwardPage = computed(() => forwardHistory.value.length > 0 && !overlay.value)
  const activeCategory = computed(() =>
    pageTarget.value.kind === 'local' ? pageTarget.value.category : 'dashboard'
  )
  const activeFilter = computed(() =>
    pageTarget.value.kind === 'local' ? pageTarget.value.filter : null
  )
  const streamingTab = computed<StreamingPageTab>(() =>
    pageTarget.value.kind === 'streaming' ? pageTarget.value.tab : 'home'
  )

  function preparePageMotion(
    target: NavigationPageTarget,
    historyDirection?: 'forward' | 'back'
  ): void {
    if (historyDirection) {
      songlistTransitionName.value = `page-${historyDirection}`
      return
    }
    const from = pageTarget.value
    if (target.kind === 'local' && target.filter) {
      songlistTransitionName.value = 'page-forward'
    } else if (
      from.kind === 'local' &&
      from.filter &&
      target.kind === 'local' &&
      (target.category === from.category ||
        (from.category === 'aggregate' && target.category === 'playlists'))
    ) {
      songlistTransitionName.value = 'page-back'
    } else {
      const order = options.pageOrder?.() ?? defaultPageOrder
      const before = order.indexOf(navigationTargetId(from))
      const after = order.indexOf(navigationTargetId(target))
      songlistTransitionName.value =
        before >= 0 && after >= 0 && after < before ? 'page-up' : 'page-down'
    }
  }
  function navigate(target: NavigationPageTarget, options?: { resetHistory?: boolean }): void {
    preparePageMotion(target)
    if (pageTarget.value.kind === 'local') lastLocal.value = pageTarget.value
    forwardHistory.value = []
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
    preparePageMotion(previous, 'back')
    history.value = history.value.slice(0, -1)
    forwardHistory.value = [...forwardHistory.value.slice(-49), pageTarget.value]
    pageTarget.value = previous
  }
  function goForwardPage(): boolean {
    // Foreground tools own the title-bar affordance; moving the page behind one
    // would leave the user on a surface they never opened for that page.
    if (overlay.value) return false
    const next = forwardHistory.value.at(-1)
    if (!next) return false
    preparePageMotion(next, 'forward')
    forwardHistory.value = forwardHistory.value.slice(0, -1)
    history.value = [...history.value.slice(-49), pageTarget.value]
    pageTarget.value = next
    return true
  }
  function onSelectView(category: string, filter: string | null): void {
    if (category === 'recent') {
      navigate({ kind: 'recent', scope: 'device' })
      return
    }
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
    if (history.value.length) goBackPage()
    else pageTarget.value = lastLocal.value
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
  function enterZonesMode(): void {
    navigate({ kind: 'zones' })
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
  function openAppearancePage(entry?: SettingsSearchEntry, tab?: AppearanceWorkspaceTab): void {
    const retainedIndex = overlayHistory.lastIndexOf('appearance')
    const retained = overlay.value === 'appearance' || retainedIndex >= 0
    // Returning from another tool resumes the same workspace and draft. Explicit
    // deep links are handled by AppearancePage's own tab/dirty-state transition.
    if (!retained || entry || tab) {
      appearanceTab.value = tab ?? 'adjust'
      appearanceNavigationTarget.value = {
        ...(entry?.section === 'appearance' ? { entry } : {}),
        appearanceTab: appearanceTab.value,
        revision: appearanceNavigationTarget.value.revision + 1
      }
    }
    if (retainedIndex >= 0) {
      overlayHistory.splice(retainedIndex)
      overlay.value = 'appearance'
    } else openOverlay('appearance')
  }
  function closeAppearancePage(): void {
    closeOverlay('appearance')
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
    const current = pages.find(
      (page) => page.pluginId === target.page.pluginId && page.id === target.page.id
    )
    if (!current) {
      pageTarget.value = localHome()
    } else if (current.experience?.version !== target.page.experience?.version) {
      pageTarget.value = { kind: 'plugin', page: current }
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
    rememberAppearanceTab,
    menuOpen,
    pageTarget,
    activePageId,
    streamingTab,
    canGoBackPage,
    canGoForwardPage,
    navigate,
    selectSidebarPage,
    goBackPage,
    goForwardPage,
    showPlayingPage,
    showStreamingPage,
    showStreamingSurface,
    showRadioPodcastPage,
    showNetworkSourcesPage,
    showZonesPage,
    showRecentPage,
    showLoginPage,
    loginPageMode,
    loginInitialProviderId,
    showSettingsPage,
    showAppearancePage,
    appearanceTab,
    appearanceNavigationTarget,
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
    enterZonesMode,
    openLoginPage,
    closeLoginPage,
    openSettingsPage,
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
    openLibraryPlaylist,
    closeMissingPluginPage,
    createToggleMenuHandler,
    createToggleSettingsHandler,
    createTogglePluginHandler
  }
}
