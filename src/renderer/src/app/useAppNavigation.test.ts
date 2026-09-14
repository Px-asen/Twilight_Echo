import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { useAppNavigation } = (await import(
  new URL('./useAppNavigation.ts', import.meta.url).href
)) as typeof import('./useAppNavigation')

test('streaming mode preserves and restores local menu state', () => {
  const navigation = useAppNavigation()

  navigation.menuOpen.value = true
  navigation.enterStreamingMode()

  assert.equal(navigation.showStreamingPage.value, true)
  assert.equal(navigation.menuOpen.value, false)
  assert.equal(navigation.localMenuOpenBeforeStreaming.value, true)

  navigation.returnToLocalMode()

  assert.equal(navigation.showStreamingPage.value, false)
  assert.equal(navigation.streamingMenuOpen.value, false)
  assert.equal(navigation.menuOpen.value, true)
})

test('online audio pages retain the local sidebar so the title-bar menu can open it', () => {
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  const localSidebar = appSource.match(/const showLocalSidebar = computed\([\s\S]*?\n\)/)?.[0] ?? ''

  assert.doesNotMatch(localSidebar, /!showRadioPodcastPage\.value/)
  assert.doesNotMatch(localSidebar, /!showNetworkSourcesPage\.value/)
  assert.match(appSource, /'menu-open': menuOpen && showLocalSidebar/)
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
  assert.equal(navigation.showStreamingPage.value, true)
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

test('login page hides the title bar start actions', () => {
  const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')

  assert.match(appSource, /:hide-start="showThemeStudioPage \|\| showLoginPage"/)
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
