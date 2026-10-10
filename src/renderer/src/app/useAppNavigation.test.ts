import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextTick } from 'vue'
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
  assert.equal(navigation.showSettingsPage.value, true)
  assert.equal(navigation.settingsInitialSection.value, 'appearance')

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
  assert.equal(navigation.settingsInitialSection.value, 'system')
  assert.equal(navigation.activePluginPage.value, null)
  persistence.stop()
})
