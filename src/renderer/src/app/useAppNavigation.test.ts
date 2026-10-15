import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import { BUILTIN_NAVIGATION_PAGES } from './navigationPages.ts'
import {
  NAVIGATION_SESSION_KEY,
  normalizeNavigationSession,
  type NavigationSessionStorage
} from './navigationSession.ts'

const { useAppNavigation } = (await import(
  new URL('./useAppNavigation.ts', import.meta.url).href
)) as typeof import('./useAppNavigation')
const { createNavigationSessionPersistence } = (await import(
  new URL('./useNavigationSessionPersistence.ts', import.meta.url).href
)) as typeof import('./useNavigationSessionPersistence')

function memoryStorage(): NavigationSessionStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

test('DSP title entry opens EQ once and preserves the active audio workspace tab', () => {
  const navigation = useAppNavigation()
  navigation.enterStreamingMode('library')
  navigation.openAudioWorkspace()
  assert.equal(navigation.showAudioWorkspace.value, true)
  assert.equal(navigation.audioWorkspaceTab.value, 'equalizer')
  assert.deepEqual(navigation.session.value.overlayHistory, [null])

  navigation.openDspRackPage()
  const session = navigation.session.value
  navigation.openAudioWorkspace()
  assert.deepEqual(navigation.session.value, session)
  assert.equal(navigation.audioWorkspaceTab.value, 'effects')
  navigation.closeAudioWorkspace()
  assert.equal(navigation.showAudioWorkspace.value, false)
  assert.equal(navigation.showStreamingPage.value, true)
  assert.equal(navigation.streamingTab.value, 'library')
})

test('audio tabs share one return path for compatible EQ and DSP entry points', () => {
  const navigation = useAppNavigation()
  navigation.openSettingsPage('audio')
  navigation.openEqualizerPage()
  navigation.openDspRackPage()
  navigation.openEqualizerPage()
  navigation.switchAudioWorkspaceTab('effects')
  assert.deepEqual(navigation.session.value.overlayHistory, [null, 'settings'])
  navigation.closeDspRackPage()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.showAudioWorkspace.value, false)
  navigation.openDspSettings()
  assert.equal(navigation.audioWorkspaceTab.value, 'effects')
  navigation.closeAudioWorkspace()
  assert.equal(navigation.showSettingsPage.value, true)
})

test('old stacked audio sessions close to their original surface without reopening another tab', () => {
  const navigation = useAppNavigation()
  navigation.restoreSession({
    ...navigation.session.value,
    overlay: 'dsp',
    overlayHistory: [null, 'settings', 'equalizer', 'dsp', 'equalizer']
  })
  assert.equal(navigation.audioWorkspaceTab.value, 'effects')
  navigation.closeAudioWorkspace()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.deepEqual(navigation.session.value.overlayHistory, [null])
})

test('appearance has an independent return route and retains the settings selection', () => {
  const navigation = useAppNavigation()
  navigation.openSettingsPage('library')
  navigation.openSettingsCategory('appearance')
  navigation.openAppearancePage(undefined, 'studio')
  assert.equal(navigation.showSettingsPage.value, false)
  assert.equal(navigation.session.value.settingsSection, 'library')
  assert.equal(navigation.appearanceTab.value, 'studio')
  assert.equal(navigation.appearanceNavigationTarget.value.appearanceTab, 'studio')
  assert.deepEqual(navigation.session.value.overlayHistory, [null, 'settings'])
  navigation.closeAppearancePage()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.showAppearancePage.value, false)
  assert.equal(navigation.session.value.settingsSection, 'library')
  navigation.openSettingsCategory('audio')
  assert.equal(navigation.session.value.settingsSection, 'audio')
  navigation.openSettingsCategory('appearance')
  assert.equal(navigation.appearanceTab.value, 'studio')
  navigation.closeAppearancePage()
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.session.value.settingsSection, 'audio')
  navigation.closeSettingsPage()
  assert.deepEqual(navigation.session.value.overlayHistory, [])
})

test('home control changes role across local pages, streaming and foreground tools', () => {
  const navigation = useAppNavigation()
  assert.equal(navigation.isHome.value, true)
  for (const target of [
    { kind: 'local', category: 'albums', filter: 'one' },
    { kind: 'streaming', tab: 'home' },
    { kind: 'network' }
  ] as const) {
    navigation.navigate(target)
    assert.equal(navigation.isHome.value, false)
    navigation.openSettingsPage()
    navigation.menuOpen.value = true
    navigation.goHome()
    assert.equal(navigation.isHome.value, true)
    assert.equal(navigation.menuOpen.value, false)
    assert.equal(navigation.canGoBackPage.value, false)
    assert.equal(navigation.showSettingsPage.value, false)
    assert.deepEqual(navigation.session.value.overlayHistory, [])
  }
  navigation.openAccountPage()
  assert.equal(navigation.isHome.value, true)
})

test('avatar child keeps its parent active without changing navigation or persisting its expansion', () => {
  const navigation = useAppNavigation()
  navigation.enterStreamingMode('library')
  const before = navigation.session.value
  navigation.openAccountPage('ncm')
  assert.equal(navigation.showAccountPage.value, true)
  assert.equal(navigation.accountInitialProviderId.value, 'ncm')
  assert.equal(navigation.showLoginPage.value, false)
  assert.equal(navigation.showStreamingPage.value, true)
  assert.deepEqual(navigation.session.value, before)
  const restored = useAppNavigation()
  restored.restoreSession(normalizeNavigationSession(navigation.session.value)!)
  assert.equal(restored.showAccountPage.value, false)
  assert.equal(restored.showStreamingPage.value, true)
  assert.equal(restored.streamingTab.value, 'library')
  navigation.closeAccountPage()
  navigation.openAppearancePage()
  const appearance = navigation.session.value
  navigation.openAccountPage()
  assert.equal(navigation.showAppearancePage.value, true)
  assert.deepEqual(navigation.session.value, appearance)
  navigation.closeAccountPage()
  assert.equal(navigation.showAppearancePage.value, true)
  assert.deepEqual(navigation.pageTarget.value, { kind: 'streaming', tab: 'library' })
  navigation.openAccountPage()
  navigation.goHome()
  assert.equal(navigation.showAccountPage.value, false)
  assert.equal(navigation.isHome.value, true)
})

test('earlier avatar page sessions restore the retained parent', () => {
  const navigation = useAppNavigation()
  navigation.openAppearancePage()
  const legacy = {
    ...navigation.session.value,
    overlay: 'account',
    overlayHistory: [null, 'appearance']
  }
  navigation.restoreSession(normalizeNavigationSession(legacy)!)
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.showAccountPage.value, false)
  assert.deepEqual(navigation.session.value.overlayHistory, [null])
})

test('legacy appearance entry opens its independent page and preserves the music destination', () => {
  const preview = ref(false)
  const navigation = useAppNavigation({ appearancePreviewActive: () => preview.value })
  const cases = [
    {
      target: { kind: 'local', category: 'albums', filter: 'album:one' },
      visible: navigation.localViewVisible
    },
    { target: { kind: 'streaming', tab: 'search' }, visible: navigation.showStreamingSurface },
    { target: { kind: 'radio' }, visible: navigation.showRadioPodcastPage },
    { target: { kind: 'network' }, visible: navigation.showNetworkSourcesPage },
    { target: { kind: 'recent', scope: 'device' }, visible: navigation.showRecentPage }
  ] as const
  for (const { target, visible } of cases) {
    navigation.navigate(target)
    navigation.openSettingsPage('appearance')
    const retainedSession = JSON.stringify(navigation.session.value)
    assert.equal(visible.value, false, target.kind)
    preview.value = true
    assert.equal(visible.value, true, target.kind)
    assert.equal(navigation.showAppearancePage.value, true)
    assert.equal(navigation.showSettingsPage.value, false)
    assert.equal(JSON.stringify(navigation.session.value), retainedSession)
    preview.value = false
    assert.equal(visible.value, false, target.kind)
    assert.equal(JSON.stringify(navigation.session.value), retainedSession)
    navigation.closeAppearancePage()
    assert.equal(visible.value, true, target.kind)
    assert.deepEqual(navigation.pageTarget.value, target)
  }
})

test('appearance preview does not expose page content behind other foreground tools', () => {
  const navigation = useAppNavigation({ appearancePreviewActive: () => true })
  navigation.openPlayingPage()
  assert.equal(navigation.localViewVisible.value, false)
  navigation.openPluginPage()
  assert.equal(navigation.localViewVisible.value, false)
})

test('unified appearance workspace preserves its origin without adding a studio back layer', () => {
  const preview = ref(false)
  const navigation = useAppNavigation({ appearancePreviewActive: () => preview.value })
  navigation.enterStreamingMode('library')
  navigation.openAppearancePage()
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.showSettingsPage.value, false)
  assert.equal(navigation.showStreamingPage.value, false)
  const saved = JSON.stringify(navigation.session.value)
  preview.value = true
  assert.equal(navigation.showStreamingPage.value, true)
  assert.equal(JSON.stringify(navigation.session.value), saved)
  preview.value = false
  navigation.openThemeStudioPage()
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.appearanceTab.value, 'studio')
  assert.deepEqual(navigation.session.value.overlayHistory, [null])
  assert.equal(navigation.showSettingsPage.value, false)
  navigation.closeAppearancePage()
  assert.equal(navigation.showStreamingPage.value, true)
  navigation.openSettingsPage('general')
  navigation.openAppearancePage()
  const restored = useAppNavigation()
  restored.restoreSession(normalizeNavigationSession(navigation.session.value)!)
  assert.equal(restored.showAppearancePage.value, true)
  restored.closeAppearancePage()
  assert.equal(restored.showSettingsPage.value, true)
  assert.equal(restored.settingsInitialSection.value, 'general')
})

test('theme plugin entries stay inside appearance and preserve the underlying music page', () => {
  const navigation = useAppNavigation()
  navigation.enterStreamingMode('library')
  navigation.openSettingsPage('general')
  navigation.onSelectPluginPage({
    pluginId: 'com.twilightecho.tool.theme-workshop',
    id: 'theme-workshop',
    kind: 'sidebarPage',
    title: '主题插件工坊'
  })
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.appearanceTab.value, 'workshop')
  assert.deepEqual(navigation.pageTarget.value, { kind: 'streaming', tab: 'library' })
  const reopened = useAppNavigation()
  reopened.restoreSession(normalizeNavigationSession(navigation.session.value)!)
  assert.equal(reopened.appearanceTab.value, 'workshop')
  assert.equal(reopened.appearanceNavigationTarget.value.appearanceTab, 'workshop')
  reopened.closeAppearancePage()
  assert.equal(reopened.showSettingsPage.value, true)
  reopened.closeSettingsPage()
  assert.equal(reopened.showStreamingPage.value, true)
})

test('old studio and workshop sessions migrate into the shared appearance workspace', () => {
  const navigation = useAppNavigation()
  const oldStudio = normalizeNavigationSession({
    ...navigation.session.value,
    overlay: 'theme',
    overlayHistory: [null, 'appearance']
  })!
  navigation.restoreSession(oldStudio)
  assert.equal(navigation.showAppearancePage.value, true)
  assert.equal(navigation.appearanceTab.value, 'studio')
  navigation.closeAppearancePage()
  assert.equal(navigation.localViewVisible.value, true)
  const oldWorkshop = normalizeNavigationSession({
    ...navigation.session.value,
    pageTarget: {
      kind: 'plugin',
      pluginId: 'com.twilightecho.tool.theme-workshop',
      pageId: 'theme-workshop'
    },
    history: [{ kind: 'streaming', tab: 'library' }],
    overlay: null
  })!
  navigation.restoreSession(oldWorkshop)
  assert.equal(navigation.appearanceTab.value, 'workshop')
  assert.equal(navigation.showAppearancePage.value, true)
  navigation.closeAppearancePage()
  assert.equal(navigation.showStreamingPage.value, true)
  navigation.restoreSession({ ...oldWorkshop, overlay: 'plugins', overlayHistory: [null] })
  assert.equal(navigation.showPluginPage.value, true)
  navigation.hidePluginPage()
  assert.equal(navigation.showAppearancePage.value, true)
  navigation.closeAppearancePage()
  assert.equal(navigation.showStreamingPage.value, true)
  navigation.restoreSession({ ...oldWorkshop, overlay: 'appearance', overlayHistory: [null] })
  navigation.closeAppearancePage()
  assert.equal(navigation.showStreamingPage.value, true)
})

test('the menu starts closed and stays shared across local and streaming pages', () => {
  const navigation = useAppNavigation()
  assert.equal(navigation.menuOpen.value, false)

  navigation.menuOpen.value = true
  navigation.enterStreamingMode()

  assert.equal(navigation.showStreamingPage.value, true)
  assert.equal(navigation.menuOpen.value, true)
  navigation.enterStreamingMode('library')
  assert.equal(navigation.menuOpen.value, true)

  navigation.returnToLocalMode()

  assert.equal(navigation.showStreamingPage.value, false)
  assert.equal(navigation.menuOpen.value, true)
  navigation.collapseMenu()
  navigation.enterStreamingMode('search')
  assert.equal(navigation.menuOpen.value, false)
})

test('the sidebar bookmark opens over the plugin market without replacing the page or return route', () => {
  const navigation = useAppNavigation()
  navigation.enterStreamingMode('library')
  navigation.openPluginPage()
  const before = navigation.session.value
  const toggle = navigation.createToggleMenuHandler()
  toggle()
  assert.equal(navigation.menuOpen.value, true)
  assert.equal(navigation.showPluginPage.value, true)
  assert.deepEqual(navigation.session.value.overlayHistory, before.overlayHistory)
  assert.deepEqual(navigation.session.value.pageTarget, before.pageTarget)
  toggle()
  assert.equal(navigation.menuOpen.value, false)
  assert.equal(navigation.showPluginPage.value, true)
  navigation.hidePluginPage()
  assert.equal(navigation.showStreamingPage.value, true)
  assert.equal(navigation.streamingTab.value, 'library')
})

test('online audio pages retain the local sidebar so the title-bar menu can open it', () => {
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const localSidebar = appSource.match(/const showLocalSidebar = computed\([\s\S]*?\n\)/)?.[0] ?? ''

  assert.doesNotMatch(localSidebar, /!showRadioPodcastPage\.value/)
  assert.doesNotMatch(localSidebar, /!showNetworkSourcesPage\.value/)
  assert.doesNotMatch(localSidebar, /!showStreamingPage\.value/)
  assert.match(appSource, /'menu-open': menuOpen && showLocalSidebar/)
})

test('page history restores page parameters and foreground tools return to their page', () => {
  const navigation = useAppNavigation()
  navigation.onSelectView('albums', 'album:one')
  navigation.enterStreamingMode('search')
  navigation.navigate({ kind: 'recent', scope: 'platform', providerId: 'example' })
  navigation.openSettingsPage()
  navigation.closeSettingsPage()
  assert.deepEqual(navigation.pageTarget.value, {
    kind: 'recent',
    scope: 'platform',
    providerId: 'example'
  })
  navigation.goBackPage()
  assert.equal(navigation.streamingTab.value, 'search')
  navigation.goBackPage()
  assert.equal(navigation.activeCategory.value, 'albums')
  assert.equal(navigation.activeFilter.value, 'album:one')
})

test('sidebar selections switch root pages without exposing a return path', () => {
  const navigation = useAppNavigation()
  for (const page of BUILTIN_NAVIGATION_PAGES) {
    navigation.onSelectView('albums', 'album:detail')
    navigation.openSettingsPage()
    navigation.selectSidebarPage(page.target)
    assert.deepEqual(navigation.pageTarget.value, page.target)
    assert.equal(navigation.canGoBackPage.value, false, page.id)
    assert.equal(navigation.showSettingsPage.value, false)
    navigation.goBackPage()
    assert.deepEqual(navigation.pageTarget.value, page.target)
  }
})

test('a secondary page returns to its selected root and stops there', () => {
  const navigation = useAppNavigation()
  navigation.selectSidebarPage({ kind: 'local', category: 'artists', filter: null })
  navigation.onSelectView('artists', 'artist:one')
  navigation.onSelectView('albums', 'album:one')
  assert.equal(navigation.canGoBackPage.value, true)
  navigation.goBackPage()
  assert.equal(navigation.activeFilter.value, 'artist:one')
  navigation.goBackPage()
  assert.equal(navigation.activeCategory.value, 'artists')
  assert.equal(navigation.activeFilter.value, null)
  assert.equal(navigation.canGoBackPage.value, false)
})

test('selecting the current root from the sidebar discards its old detail history', () => {
  const navigation = useAppNavigation()
  navigation.selectSidebarPage({ kind: 'local', category: 'albums', filter: null })
  navigation.onSelectView('albums', 'album:one')
  navigation.selectSidebarPage({ kind: 'local', category: 'albums', filter: null })
  assert.equal(navigation.activeFilter.value, null)
  assert.equal(navigation.canGoBackPage.value, false)
})

test('local home history links open the shared recent page and retain their return target', () => {
  const navigation = useAppNavigation()
  navigation.menuOpen.value = true
  navigation.onSelectView('artists', 'artist:one')
  navigation.onSelectView('recent', null)
  assert.deepEqual(navigation.pageTarget.value, { kind: 'recent', scope: 'device' })
  assert.equal(navigation.showRecentPage.value, true)
  assert.equal(navigation.localViewVisible.value, false)
  assert.equal(navigation.menuOpen.value, true)
  navigation.goBackPage()
  assert.equal(navigation.activeFilter.value, 'artist:one')
})

test('nested foreground tools restore their originating surface before returning to the page', () => {
  const navigation = useAppNavigation()
  navigation.enterStreamingMode('library')
  navigation.openPlayingPage()
  navigation.openPlaybackSettings()
  navigation.openPluginPage()
  navigation.hidePluginPage()
  assert.equal(navigation.showSettingsPage.value, true)
  navigation.closeSettingsPage()
  assert.equal(navigation.showPlayingPage.value, true)
  navigation.openDspRackPage()
  navigation.closeDspRackPage()
  assert.equal(navigation.showPlayingPage.value, true)
  navigation.closePlayingPage()
  assert.equal(navigation.showStreamingSurface.value, true)
  assert.equal(navigation.streamingTab.value, 'library')
  navigation.openPlayingPage()
  navigation.openEqualizerPage()
  navigation.navigate({ kind: 'recent' })
  navigation.openSettingsPage()
  navigation.closeSettingsPage()
  assert.equal(navigation.showPlayingPage.value, false)
  assert.equal(navigation.showEqualizerPage.value, false)
  assert.equal(navigation.showRecentPage.value, true)
})

test('opening plugins hides every streaming tab and closing restores the original destination', () => {
  for (const tab of ['home', 'discover', 'library', 'cloud', 'search'] as const) {
    const navigation = useAppNavigation()
    navigation.enterStreamingMode(tab)
    const destination = navigation.pageTarget.value
    const togglePlugins = navigation.createTogglePluginHandler()

    togglePlugins()
    assert.equal(navigation.showPluginPage.value, true)
    assert.equal(navigation.showStreamingPage.value, false, tab)
    assert.equal(navigation.showStreamingSurface.value, false, tab)
    assert.equal(navigation.pageTarget.value, destination)

    togglePlugins()
    assert.equal(navigation.showPluginPage.value, false)
    assert.equal(navigation.showStreamingPage.value, true, tab)
    assert.equal(navigation.showStreamingSurface.value, true, tab)
    assert.equal(navigation.pageTarget.value, destination)
  }
})

test('network sources page is mutually exclusive with streaming and radio pages', () => {
  const navigation = useAppNavigation()

  navigation.enterStreamingMode()
  navigation.enterNetworkSourcesMode()

  assert.equal(navigation.showNetworkSourcesPage.value, true)
  assert.equal(navigation.showStreamingPage.value, false)
  assert.equal(navigation.localViewVisible.value, false)

  navigation.enterRadioPodcastMode()
  assert.equal(navigation.showNetworkSourcesPage.value, false)
  assert.equal(navigation.showRadioPodcastPage.value, true)

  navigation.closeRadioPodcastPage()
  navigation.enterNetworkSourcesMode()
  navigation.closeNetworkSourcesPage()
  assert.equal(navigation.showNetworkSourcesPage.value, false)
})

test('settings, plugin, equalizer, and extension pages are mutually exclusive', () => {
  const navigation = useAppNavigation()
  const page = {
    pluginId: 'com.example.tool',
    id: 'tool-page',
    kind: 'sidebarPage',
    title: 'Tool',
    command: 'tool.open'
  } as const

  navigation.enterStreamingMode()
  navigation.openSettingsPage('dsp')
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.showStreamingPage.value, false)
  assert.equal(navigation.showPluginPage.value, false)

  navigation.openPluginPage()
  assert.equal(navigation.showPluginPage.value, true)
  assert.equal(navigation.showSettingsPage.value, false)
  assert.equal(navigation.showEqualizerPage.value, false)

  navigation.openThemeStudioPage()
  assert.equal(navigation.showThemeStudioPage.value, true)
  assert.equal(navigation.showPluginPage.value, false)
  assert.equal(navigation.showSettingsPage.value, false)

  navigation.closeThemeStudioPage()
  assert.equal(navigation.showThemeStudioPage.value, false)
  assert.equal(navigation.showPluginPage.value, true)
  assert.equal(navigation.showSettingsPage.value, false)

  navigation.openEqualizerPage()
  assert.equal(navigation.showEqualizerPage.value, true)
  assert.equal(navigation.showPluginPage.value, false)

  navigation.onSelectPluginPage(page)
  assert.deepEqual(navigation.activePluginPage.value, page)
  assert.equal(navigation.showStreamingPage.value, false)
  assert.equal(navigation.showEqualizerPage.value, false)
  assert.equal(navigation.showPluginPage.value, false)
})

test('active plugin extension page closes when its contribution disappears', () => {
  const navigation = useAppNavigation()
  const page = {
    pluginId: 'com.example.tool',
    id: 'tool-page',
    kind: 'sidebarPage',
    title: 'Tool',
    command: 'tool.open'
  } as const

  navigation.onSelectPluginPage(page)
  navigation.closeMissingPluginPage([])

  assert.equal(navigation.activePluginPage.value, null)
})

test('page back history discards disabled plugin targets while preserving other pages', () => {
  const navigation = useAppNavigation()
  navigation.onSelectPluginPage({
    pluginId: 'tool',
    id: 'page',
    kind: 'sidebarPage',
    title: 'Tool',
    command: 'open'
  })
  navigation.enterStreamingMode('library')
  navigation.closeMissingPluginPage([])
  navigation.goBackPage()
  assert.equal(navigation.activePageId.value, 'local-home')
})

test('login page can open with an initial streaming provider', () => {
  const navigation = useAppNavigation()

  navigation.enterStreamingMode()
  navigation.openLoginPage('ncm')

  assert.equal(navigation.showLoginPage.value, true)
  assert.equal(navigation.showStreamingPage.value, false)
  assert.equal(navigation.loginInitialProviderId.value, 'ncm')
  assert.equal(navigation.loginPageMode.value, 'login')

  navigation.closeLoginPage()

  assert.equal(navigation.showLoginPage.value, false)
  assert.equal(navigation.showStreamingPage.value, true)
  assert.equal(navigation.loginInitialProviderId.value, null)
  assert.equal(navigation.loginPageMode.value, 'login')
})

test('persistent title menu returns from login, theme studio and playback to navigation', () => {
  for (const overlay of ['login', 'themeStudio', 'playing']) {
    const navigation = useAppNavigation()
    if (overlay === 'login') navigation.openLoginPage()
    else if (overlay === 'themeStudio') navigation.openThemeStudioPage('player')
    else navigation.openPlayingPage()
    navigation.createToggleMenuHandler()()
    assert.equal(navigation.showLoginPage.value, false)
    assert.equal(navigation.showThemeStudioPage.value, false)
    assert.equal(navigation.showPlayingPage.value, false)
    assert.equal(navigation.menuOpen.value, true)
  }
})

test('login page can open directly in profile mode for a provider', () => {
  const navigation = useAppNavigation()

  navigation.enterStreamingMode()
  navigation.openLoginPage('ncm', { profile: true })

  assert.equal(navigation.showLoginPage.value, true)
  assert.equal(navigation.loginPageMode.value, 'profile')
  assert.equal(navigation.loginInitialProviderId.value, 'ncm')

  navigation.closeLoginPage()
  assert.equal(navigation.loginPageMode.value, 'login')
})

test('returning from local list pages to dashboard uses page-up transition', () => {
  const navigation = useAppNavigation()

  navigation.onSelectView('allSongs', null)
  assert.equal(navigation.activeCategory.value, 'allSongs')
  assert.equal(navigation.songlistTransitionName.value, 'page-down')

  navigation.onSelectView('dashboard', null)
  assert.equal(navigation.activeCategory.value, 'dashboard')
  assert.equal(navigation.songlistTransitionName.value, 'page-up')

  navigation.onSelectView('playlists', null)
  assert.equal(navigation.songlistTransitionName.value, 'page-down')
  navigation.onSelectView('dashboard', null)
  assert.equal(navigation.songlistTransitionName.value, 'page-up')
})

test('contextual theme studio entries return to the originating player or library workflow', () => {
  const navigation = useAppNavigation()

  navigation.openPlayingPage()
  navigation.openThemeStudioPage('player')
  assert.equal(navigation.themeStudioInitialDomain.value, 'player')
  assert.equal(navigation.showPlayingPage.value, false)
  navigation.closeThemeStudioPage()
  assert.equal(navigation.showPlayingPage.value, true)
  assert.equal(navigation.showSettingsPage.value, false)

  navigation.closePlayingPage()
  navigation.openThemeStudioPage('library')
  assert.equal(navigation.themeStudioInitialDomain.value, 'library')
  navigation.closeThemeStudioPage()
  assert.equal(navigation.showSettingsPage.value, false)
  assert.equal(navigation.localViewVisible.value, true)
})

test('command destinations replace foreground overlays and repeated settings targets are observable', () => {
  const navigation = useAppNavigation()
  navigation.openSettingsPage()
  navigation.openPlayingPage()
  assert.equal(navigation.showSettingsPage.value, false)
  assert.equal(navigation.showPlayingPage.value, true)
  navigation.openEqualizerPage()
  assert.equal(navigation.showPlayingPage.value, false)
  navigation.openLibraryPlaylist({ id: 'mix', name: '工作', kind: 'aggregate' })
  assert.equal(navigation.localViewVisible.value, true)
  assert.equal(navigation.activeCategory.value, 'aggregate')
  assert.equal(navigation.activeFilter.value, 'mix')
  navigation.openSettingsPage('playback', { anchor: 'device-profiles' })
  const first = navigation.settingsNavigationTarget.value.revision
  navigation.openSettingsPage('playback', { anchor: 'device-profiles' })
  assert.equal(navigation.settingsNavigationTarget.value.revision, first + 1)
})

test('reopening restores every built-in page and local details without waiting for shutdown', async () => {
  for (const page of BUILTIN_NAVIGATION_PAGES) {
    const storage = memoryStorage()
    const navigation = useAppNavigation()
    const persistence = createNavigationSessionPersistence(navigation, storage)
    assert.equal(persistence.restored, false)
    persistence.start()
    navigation.selectSidebarPage(page.target)
    await nextTick()
    const reopened = useAppNavigation()
    const reopenedPersistence = createNavigationSessionPersistence(reopened, storage)
    assert.equal(reopenedPersistence.restored, true, page.id)
    assert.deepEqual(reopened.pageTarget.value, page.target, page.id)
    reopenedPersistence.stop()
    persistence.stop()
  }

  const storage = memoryStorage()
  const navigation = useAppNavigation()
  const persistence = createNavigationSessionPersistence(navigation, storage)
  persistence.start()
  navigation.selectSidebarPage({ kind: 'local', category: 'artists', filter: null })
  navigation.onSelectView('artists', 'artist:测试歌手')
  navigation.onSelectView('albums', 'album:测试专辑')
  navigation.menuOpen.value = true
  // Close before Vue's queued watcher runs: the exit flush must capture this page.
  persistence.flush()
  const reopened = useAppNavigation()
  const reopenedPersistence = createNavigationSessionPersistence(reopened, storage)
  assert.equal(reopened.activeFilter.value, 'album:测试专辑')
  assert.equal(reopened.menuOpen.value, true)
  reopened.goBackPage()
  assert.equal(reopened.activeFilter.value, 'artist:测试歌手')
  reopened.goBackPage()
  assert.equal(reopened.activeCategory.value, 'artists')
  assert.equal(reopened.canGoBackPage.value, false)
  reopenedPersistence.stop()
  persistence.stop()
})

test('reopening restores foreground tools, current sections, and their return path', () => {
  const storage = memoryStorage()
  const navigation = useAppNavigation()
  const persistence = createNavigationSessionPersistence(navigation, storage)
  persistence.start()
  navigation.onSelectView('playlists', 'playlist:工作')
  navigation.enterStreamingMode('library')
  navigation.openPlayingPage()
  navigation.openSettingsPage('general')
  navigation.rememberSettingsSection('shortcuts')
  navigation.openThemeStudioPage('presets')
  navigation.rememberThemeStudioDomain('typography')
  persistence.stop()

  const reopened = useAppNavigation()
  const reopenedPersistence = createNavigationSessionPersistence(reopened, storage)
  assert.equal(reopened.showThemeStudioPage.value, true)
  assert.equal(reopened.themeStudioInitialDomain.value, 'typography')
  assert.equal(reopened.settingsInitialSection.value, 'connections')
  reopened.closeThemeStudioPage()
  assert.equal(reopened.showSettingsPage.value, true)
  reopened.closeSettingsPage()
  assert.equal(reopened.showPlayingPage.value, true)
  reopened.closePlayingPage()
  assert.equal(reopened.showStreamingSurface.value, true)
  reopened.returnToLocalMode()
  assert.equal(reopened.activeFilter.value, 'playlist:工作')
  reopenedPersistence.stop()
})

test('login, equalizer, DSP, and plugin management surfaces survive reopening', () => {
  for (const open of [
    (navigation: ReturnType<typeof useAppNavigation>) =>
      navigation.openLoginPage('ncm', { profile: true }),
    (navigation: ReturnType<typeof useAppNavigation>) => navigation.openEqualizerPage(),
    (navigation: ReturnType<typeof useAppNavigation>) => navigation.openDspRackPage(),
    (navigation: ReturnType<typeof useAppNavigation>) => navigation.openPluginPage()
  ]) {
    const storage = memoryStorage()
    const navigation = useAppNavigation()
    const persistence = createNavigationSessionPersistence(navigation, storage)
    persistence.start()
    open(navigation)
    persistence.stop()
    const reopened = useAppNavigation()
    const reopenedPersistence = createNavigationSessionPersistence(reopened, storage)
    assert.deepEqual(reopened.session.value, navigation.session.value)
    reopenedPersistence.stop()
  }
})

test('corrupt, unsupported, and invalid saved pages fall back without breaking startup', () => {
  for (const raw of [
    '{',
    'null',
    '[]',
    '{"version":2}',
    '{"version":1,"pageTarget":{"kind":"local","category":"invalid","filter":null}}'
  ]) {
    const storage = memoryStorage()
    storage.setItem(NAVIGATION_SESSION_KEY, raw)
    const navigation = useAppNavigation()
    const persistence = createNavigationSessionPersistence(navigation, storage)
    assert.equal(persistence.restored, false)
    assert.equal(navigation.activePageId.value, 'local-home')
    persistence.stop()
  }
  const saved = useAppNavigation().session.value
  const normalized = normalizeNavigationSession({
    ...saved,
    settingsSection: 'invalid',
    themeStudioDomain: 'invalid',
    overlay: 'invalid',
    history: [null, { kind: 'streaming', tab: 'invalid' }, { kind: 'network' }],
    overlayHistory: [null, 'playing', 'invalid'],
    menuOpen: 'true'
  })!
  assert.equal(normalized.settingsSection, 'general')
  assert.equal(normalized.themeStudioDomain, 'presets')
  assert.equal(normalized.overlay, null)
  assert.equal(normalized.menuOpen, false)
  assert.deepEqual(normalized.history, [{ kind: 'network' }])
  assert.deepEqual(normalized.overlayHistory, [null, 'playing'])
})

test('blocked storage is harmless and failed writes are retried at exit', () => {
  const navigation = useAppNavigation()
  const broken = createNavigationSessionPersistence(navigation, {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('full')
    }
  })
  assert.doesNotThrow(() => {
    broken.start()
    navigation.enterStreamingMode('search')
    broken.stop()
  })

  const storage = memoryStorage()
  let fail = true
  const persistence = createNavigationSessionPersistence(navigation, {
    getItem: storage.getItem,
    setItem(key, value) {
      if (fail) throw new Error('temporary failure')
      storage.setItem(key, value)
    }
  })
  persistence.start()
  assert.equal(storage.getItem(NAVIGATION_SESSION_KEY), null)
  fail = false
  persistence.stop()
  assert.equal(JSON.parse(storage.getItem(NAVIGATION_SESSION_KEY)!).pageTarget.tab, 'search')
})

test('plugin pages wait for current contributions and persist only stable identifiers', () => {
  const storage = memoryStorage()
  const page = {
    pluginId: 'tool',
    id: 'page',
    kind: 'sidebarPage',
    title: 'Old tool',
    command: 'old.open'
  } as const
  const navigation = useAppNavigation()
  const persistence = createNavigationSessionPersistence(navigation, storage)
  persistence.start()
  navigation.onSelectPluginPage(page)
  persistence.stop()
  const raw = storage.getItem(NAVIGATION_SESSION_KEY)!
  assert.doesNotMatch(raw, /Old tool|old\.open/)

  const reopened = useAppNavigation()
  const reopenedPersistence = createNavigationSessionPersistence(reopened, storage)
  assert.equal(reopened.activePluginPage.value, null)
  reopenedPersistence.start()
  // Quitting while plugins load must retain the intended plugin page.
  reopenedPersistence.flush()
  assert.equal(JSON.parse(storage.getItem(NAVIGATION_SESSION_KEY)!).pageTarget.kind, 'plugin')
  // App's registry watcher prunes removed pages before the startup promise resolves.
  reopened.closeMissingPluginPage([{ ...page, title: 'Current tool', command: 'new.open' }])
  reopenedPersistence.resolvePluginPages([{ ...page, title: 'Current tool', command: 'new.open' }])
  assert.deepEqual(reopened.activePluginPage.value, {
    ...page,
    title: 'Current tool',
    command: 'new.open'
  })
  reopenedPersistence.stop()

  const missing = useAppNavigation()
  const missingPersistence = createNavigationSessionPersistence(missing, storage)
  missingPersistence.start()
  missingPersistence.resolvePluginPages([])
  assert.equal(missing.activePageId.value, 'local-home')
  assert.equal(JSON.parse(storage.getItem(NAVIGATION_SESSION_KEY)!).pageTarget.kind, 'local')
  missingPersistence.stop()
})

test('explicit navigation during startup overrides a saved plugin destination', () => {
  const storage = memoryStorage()
  storage.setItem(
    NAVIGATION_SESSION_KEY,
    JSON.stringify({
      ...useAppNavigation().session.value,
      pageTarget: { kind: 'plugin', pluginId: 'tool', pageId: 'page' }
    })
  )
  const navigation = useAppNavigation()
  const persistence = createNavigationSessionPersistence(navigation, storage)
  navigation.openSettingsPage('about')
  persistence.start()
  persistence.resolvePluginPages([
    { pluginId: 'tool', id: 'page', kind: 'sidebarPage', title: 'Tool' }
  ])
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.settingsInitialSection.value, 'about')
  assert.equal(navigation.activePluginPage.value, null)
  persistence.stop()
})
