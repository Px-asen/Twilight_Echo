import { createApp, h, nextTick, ref, shallowRef } from 'vue'
import StreamingPage from '../StreamingPage.vue'
import { useProviderStore } from '../../stores/useProviderStore.ts'
import { syncPluginProviders } from '../../providers/index.ts'
import { getStreamingHomeProviders } from '../../utils/streamingNavigation.ts'
import '../../assets/main.css'

// Only account, playback and disk boundaries are replaced. The Provider store,
// registry, page routing, header, popover, content and downloads are production.
const calls = []
const searchResponses = []
const events = []
const errors = []
const holds = new Map()
const behavior = new Map()
const listeners = new Set()
const pluginListeners = new Set()
let registered = []
let tasks = []
let authenticated = true
let searchResultsEnabled = false
let providerListGate
let app
let revision = 0

const image = (index) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="${['#6b7785', '#8a7f72', '#597b76'][index % 3]}"/><circle cx="160" cy="160" r="95" fill="#ffffff" fill-opacity=".14"/></svg>`
  )
const track = (provider, index) => ({
  id: `${provider}:${index}`,
  source: provider,
  title: `${provider}·第${index + 1}首给远方和慢生活的音乐`,
  artist: '名字很长的独立音乐人与城市乐团',
  album: '写给每一个日落之后仍在路上的你',
  duration: 183,
  cover: image(index),
  lyrics: null,
  filePath: '',
  fileName: '',
  size: 0
})
const collection = (provider, index) => ({
  id: `${provider}-${index}`,
  name: `${provider}·第${index + 1}份收藏与漫长旅途歌单`,
  cover: image(index),
  trackCount: 12,
  owned: index % 2 === 0
})

/** @returns {import('../../stores/useProviderStore.ts').ProviderInfo} */
function provider(id, { branded = true, home = true, login = true, count = 6, counts = {} } = {}) {
  const methods = [
    'fetchDiscoveryPlaylists',
    'fetchUserLibrary',
    'fetchPlaylistTracks',
    'fetchAlbumTracks',
    'fetchLikedTracks',
    'searchSongs',
    'searchAlbums',
    'searchPlaylists',
    'searchArtists',
    'fetchSavedAlbums',
    'fetchSavedArtists'
  ]
  if (login) methods.push('checkLogin')
  if (home) methods.push('fetchRecommendSongs', 'fetchRecommendPlaylists', 'fetchPersonalFm')
  if (id === 'ncm') methods.push('fetchToplists')
  return {
    id,
    name:
      id === 'ncm'
        ? '网易云音乐'
        : id === 'aurora'
          ? '独立音乐与世界各地创作者的声音档案馆'
          : id === 'archive'
            ? '城市声音档案'
            : '只提供音乐库与发现的音源',
    capabilities: ['search', 'playlist', 'library', 'download', ...(login ? ['login'] : [])],
    supportedMethods: methods,
    health: { pluginStatus: 'enabled', available: true },
    ui: {
      icon: 'pi pi-headphones',
      authType: 'qr',
      color: '#647c7e',
      streamingLibraryTab: true,
      streamingDiscovery: { supportsSort: false },
      ...(branded
        ? { streamingHome: { requiresLogin: false, subtitle: '公开新声与编辑精选' } }
        : {}),
      streamingSections: [
        {
          id: 'editorial',
          title: '这一周，听见来自远方的新声音',
          icon: 'pi pi-music',
          method: 'fetchRecommendSongs',
          args: [{ catalogue: 'editorial', count: counts.tracks ?? count }],
          eyebrow: '编辑精选',
          description: '公开内容由编辑整理，推荐标题和长名称由共同的宿主页面呈现。'
        },
        {
          id: 'private',
          title: '私人漫游',
          icon: 'pi pi-compass',
          method: 'fetchPersonalFm',
          requiresLogin: true
        }
      ]
    },
    fixtureCount: count,
    fixtureCounts: counts
  }
}

const settings = ref({
  streamingActiveProvider: 'aurora',
  trackActivationMode: 'singleClick',
  motionPreference: 'off',
  language: 'zh-CN'
})
const localTracks = shallowRef([])
const player = {
  currentTrack: shallowRef(null),
  isPlaying: ref(false),
  personalizedStreamSession: ref(null),
  personalizedStreamRemaining: ref(100),
  formatTime: (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
  playTrack: async (song, queue) => events.push(['play', song.id, queue?.length]),
  startPersonalizedStream: async (...args) => events.push(['stream', ...args]),
  appendPersonalizedStreamTracks: () => 0,
  playNextTrack: (song) => events.push(['next', song.id])
}
const ncmRefs = {
  providerAvailable: ref(true),
  providerError: ref(''),
  isLoggedIn: ref(true),
  profile: ref({ userId: 'fixture-account', nickname: '仅用于测试的账号', avatarUrl: image(0) }),
  libraryLoading: ref(false),
  libraryLoaded: ref(true),
  libraryError: ref(''),
  likedPlaylist: ref(collection('ncm', 0)),
  userPlaylists: ref([]),
  cloudSongs: ref([]),
  cloudTotal: ref(0),
  cloudHasMore: ref(false),
  cloudLoading: ref(false),
  cloudLoadingMore: ref(false),
  cloudError: ref(''),
  cloudSelectedFiles: ref([]),
  cloudTransferTasks: ref([]),
  isTrackLiked: () => false,
  checkLogin: async () => ({ loggedIn: authenticated, profile: ncmRefs.profile.value })
}

window.streamingFixture = {
  settingsStore: {
    settings,
    updateSettings: async (patch) => {
      events.push(['settings', patch])
      settings.value = { ...settings.value, ...patch }
    }
  },
  musicStore: {
    tracks: localTracks,
    albums: ref([]),
    artists: ref([]),
    playlists: ref([]),
    aggregatePlaylists: ref([]),
    favoriteTracks: ref([]),
    isFavoriteTrack: () => false,
    addFavoriteTrack: () => true,
    removeFavoriteTrack: () => true,
    applyLocalTagWrite: () => undefined
  },
  playerStore: player,
  ncmStore: new Proxy(ncmRefs, {
    get(target, key) {
      if (key in target) return target[key]
      return async (...args) => {
        calls.push(['ncm-boundary', key, args])
        return []
      }
    }
  })
}

async function callProvider(id, method, args = []) {
  calls.push([id, method, args])
  const source = registered.find((entry) => entry.id === id)
  if (!source) throw new Error('Provider 未启用')
  if (!source.supportedMethods.includes(method)) throw new Error(`does not implement ${method}`)
  const key = `${id}:${method}`
  const queryKey = `${key}:${args[0]}`
  const behaviorKey = behavior.has(queryKey) ? queryKey : key
  const action = behavior.get(behaviorKey)
  if (action === 'hold') {
    await new Promise((resolve) =>
      holds.set(behaviorKey, [...(holds.get(behaviorKey) ?? []), resolve])
    )
  }
  if (action === 'fail') throw new Error(`${id} 暂时无法连接，请重试`)
  const collectionType = {
    fetchUserLibrary: 'playlists',
    fetchDiscoveryPlaylists: 'playlists',
    fetchRecommendPlaylists: 'playlists',
    fetchSavedAlbums: 'albums',
    fetchSavedArtists: 'artists',
    fetchToplists: 'toplists'
  }[method]
  const count =
    action === 'empty'
      ? 0
      : (source.fixtureCounts?.[collectionType ?? 'tracks'] ?? source.fixtureCount)
  if (method === 'checkLogin')
    return {
      loggedIn: authenticated,
      profile: authenticated
        ? { userId: `${id}-fixture`, nickname: `${id}的测试用户`, avatarUrl: image(0) }
        : null
    }
  if (method === 'fetchUserLibrary')
    return {
      likedPlaylist: collection(id, 0),
      playlists: Array.from({ length: count }, (_, index) => collection(id, index))
    }
  if (method === 'fetchDiscoveryPlaylists')
    return {
      items: Array.from({ length: count }, (_, index) => collection(id, index)),
      total: 0,
      hasMore: false
    }
  if (method === 'fetchSavedAlbums')
    return Array.from({ length: count }, (_, index) => ({
      ...collection(id, index),
      artist: '独立创作者'
    }))
  if (method === 'fetchSavedArtists')
    return Array.from({ length: count }, (_, index) => ({
      id: `${id}-artist-${index}`,
      name: `长名称音乐人${index}`,
      picUrl: image(index)
    }))
  if (method === 'fetchRecommendPlaylists' || method === 'fetchToplists')
    return Array.from({ length: count }, (_, index) => ({
      ...collection(id, index),
      updateFrequency: '每周更新',
      previewTracks: [track(id, index)]
    }))
  if (method.startsWith('search')) {
    searchResponses.push({ provider: id, method, query: String(args[0]) })
    if (!searchResultsEnabled || action === 'empty') return { items: [], total: 0 }
    const query = String(args[0])
    const items = Array.from({ length: 2 }, (_, index) => {
      if (method === 'searchSongs')
        return {
          ...track(id, index),
          id: `${id}:search:${query}:${index}`,
          title: `${query} · ${id} 搜索歌曲 ${index + 1}`
        }
      return {
        ...collection(id, index),
        id: `${id}-search-${query}-${index}`,
        name: `${query} · ${id} 搜索集合 ${index + 1}`,
        artist: '仅用于搜索命令测试的音乐人',
        picUrl: image(index)
      }
    })
    return { items, total: items.length }
  }
  return Array.from({ length: count }, (_, index) => track(id, index))
}

window.api = {
  providers: {
    list: async () => {
      if (providerListGate) await providerListGate.promise
      return structuredClone(registered)
    },
    call: callProvider,
    cancel: async (id) => calls.push(['cancel', id])
  },
  plugins: {
    onChanged: (fn) => {
      pluginListeners.add(fn)
      return () => pluginListeners.delete(fn)
    }
  },
  providerDownloads: {
    list: async () => structuredClone(tasks),
    onChanged: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    retry: async (id) => events.push(['retry', id]),
    cancel: async (id) => events.push(['cancel-download', id]),
    result: async (id, add) => {
      events.push(['download-result', id, add])
      return 'C:\\FixtureOnly\\complete.flac'
    }
  },
  shell: { showItemInFolder: async (path) => events.push(['reveal', path]) },
  data: { loadPlaybackBookmarks: async () => [], loadListeningStats: async () => null },
  covers: { getDataUrl: async () => null }
}

const surface = ref('home')
const active = ref(true)
const searchNavigationRequest = shallowRef(null)
const mounted = ref(true)
const pageKey = ref(0)
const flush = async () => {
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await new Promise((resolve) => setTimeout(resolve, 45))
}
const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const text = () =>
  document.querySelector('.streaming-content-body')?.textContent.replace(/\s+/g, ' ').trim() ?? ''
const bounds = (node) => {
  if (!node) return null
  const rect = node.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  }
}
const select = async (id) => {
  const trigger = document.querySelector('.provider-switcher-trigger')
  expect(trigger && !trigger.disabled, 'Multiple supported providers must expose a source control')
  trigger.focus()
  trigger.click()
  await flush()
  const option = [...document.querySelectorAll('.provider-switcher-option')].find((node) =>
    node.textContent.includes(registered.find((entry) => entry.id === id)?.name)
  )
  expect(option, 'Source option is missing: ' + id)
  option.click()
  await flush()
}

app = createApp({
  render: () =>
    mounted.value
      ? h(StreamingPage, {
          key: pageKey.value,
          initialTab: surface.value,
          active: active.value,
          searchNavigationRequest: searchNavigationRequest.value,
          menuOpen: false,
          hasPlayer: true,
          onLogin: (id) => events.push(['login', id]),
          onNavigateTab: (tab) => events.push(['navigate', tab]),
          onSearchQueryChange: (query) => events.push(['search-query', query])
        })
      : null
})
app.config.errorHandler = (error) => errors.push(error?.stack || String(error))
app.mount('#app')

window.prepareProviderFixture = async (options = {}) => {
  mounted.value = false
  providerListGate?.resolve()
  providerListGate = undefined
  for (const waiting of holds.values()) for (const done of waiting) done()
  holds.clear()
  behavior.clear()
  await flush()
  authenticated = options.mode !== 'guest'
  searchResultsEnabled = options.searchResults === true
  active.value = options.active !== false
  searchNavigationRequest.value = options.searchNavigationRequest ?? null
  registered = options.none
    ? []
    : [
        provider('aurora', { count: options.count ?? 6, counts: options.counts }),
        provider('archive', { branded: false, count: options.count ?? 6, counts: options.counts }),
        provider('quiet', { home: false })
      ]
  if (options.ncm)
    registered.push(
      provider('ncm', { branded: false, count: options.count ?? 6, counts: options.counts })
    )
  if (options.only) registered = registered.filter((entry) => entry.id === options.only)
  for (const [key, value] of Object.entries(options.behavior ?? {})) behavior.set(key, value)
  settings.value = { ...settings.value, streamingActiveProvider: options.provider ?? 'aurora' }
  surface.value = options.surface ?? 'home'
  document.documentElement.dataset.theme = options.tone ?? 'pureWhite'
  document.documentElement.style.setProperty('--te-font-size-body', `${options.font ?? 14}px`)
  tasks = []
  for (const listener of listeners) listener([])
  ncmRefs.isLoggedIn.value = authenticated
  ncmRefs.userPlaylists.value = Array.from({ length: options.count ?? 6 }, (_, index) =>
    collection('ncm', index)
  )
  errors.length = 0
  calls.length = 0
  searchResponses.length = 0
  events.length = 0
  await useProviderStore().syncProviders()
  await syncPluginProviders()
  if (options.holdProviderSync) {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    providerListGate = { promise, resolve }
  }
  pageKey.value = ++revision
  mounted.value = true
  await flush()
  await flush()
  return {
    eligibleHome: getStreamingHomeProviders({
      ncmAvailable: options.ncm === true,
      providers: registered
    }).map((entry) => entry.id),
    text: text()
  }
}

window.inspectProviderHeader = async () => {
  await flush()
  const issues = []
  const header = document.querySelector('.streaming-content-header')
  const scroller = document.querySelector('.streaming-content')
  const body = document.querySelector('.streaming-content-body')
  const heading = header?.querySelector('h1')
  const rect = bounds(header)
  if (!rect || rect.left < 15 || rect.right > innerWidth - 15)
    issues.push('Header crosses safe horizontal bounds')
  if (!heading?.textContent.trim()) issues.push('Root page has no visible title')
  if (header?.scrollWidth > header?.clientWidth + 1) issues.push('Header has horizontal overflow')
  if (scroller?.scrollWidth > scroller?.clientWidth + 1) issues.push('Page has horizontal overflow')
  if (rect?.bottom > innerHeight * 0.52)
    issues.push('Root heading consumes more than half of the window')
  for (const control of header?.querySelectorAll('button:not(:disabled),input,select') ?? []) {
    const item = bounds(control)
    if (
      item.width &&
      (item.left < 8 || item.right > innerWidth - 8 || item.bottom > innerHeight - 8)
    )
      issues.push('Header control is clipped: ' + control.outerHTML.slice(0, 120))
    if (control.clientHeight && control.scrollHeight > control.clientHeight + 2)
      issues.push('Header control text is vertically clipped')
  }
  if (errors.length) issues.push(...errors)
  return {
    viewport: { width: innerWidth, height: innerHeight },
    font: getComputedStyle(document.documentElement).getPropertyValue('--te-font-size-body').trim(),
    title: heading?.textContent.trim(),
    header: rect,
    body: bounds(body),
    contentWidth: scroller?.clientWidth,
    text: text().slice(0, 220),
    issues
  }
}

window.inspectProviderRefinement = async (kind) => {
  await flush()
  const shown = (node) => !!node && node.getBoundingClientRect().height > 0
  const measure = (node) => {
    if (!node) return null
    const style = getComputedStyle(node)
    return {
      ...bounds(node),
      radius: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius
      ].map(parseFloat),
      overflow: node.scrollWidth > node.clientWidth + 1
    }
  }
  const common = {
    viewport: { width: innerWidth, height: innerHeight },
    errors: [...errors]
  }
  if (kind === 'home') {
    const main = document.querySelector('.home-flow .hero, .music-hero')
    const quick = [...document.querySelectorAll('.duo-card, .music-feature')]
    const preview = document.querySelector('.chart-grid, .music-track-grid')
    const tracks = [...(preview?.children ?? [])].map((node) => ({
      ...bounds(node),
      label: node.getAttribute('aria-label'),
      text: node.textContent.replace(/\s+/g, ' ').trim()
    }))
    const unique = (key) => {
      const positions = []
      for (const item of tracks)
        if (!positions.some((position) => Math.abs(position - item[key]) <= 1))
          positions.push(item[key])
      return positions
    }
    return {
      ...common,
      main: measure(main),
      quick: quick.map(measure),
      preview: measure(preview),
      tracks,
      columns: unique('left'),
      rows: unique('top')
    }
  }
  if (kind === 'library') {
    const navigation = document.querySelector('.library-collection-tabs')
    const tabs = [...(navigation?.querySelectorAll('[data-collection]') ?? [])]
    const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
    const panelId = active?.getAttribute('aria-controls')
    const panel = panelId ? document.getElementById(panelId) : null
    return {
      ...common,
      navigation: bounds(navigation),
      tabs: tabs.map((tab) => ({
        type: tab.dataset.collection,
        role: tab.getAttribute('role'),
        selected: tab.getAttribute('aria-selected') === 'true',
        ...bounds(tab)
      })),
      selectedCollection: active?.dataset.collection,
      panel: bounds(panel),
      firstPlaylist: bounds([...document.querySelectorAll('.playlist-item')].find(shown)),
      visiblePlaylists: [...document.querySelectorAll('.playlist-item')].filter(shown).length,
      visibleSavedItems: [...document.querySelectorAll('.saved-grid > button')].filter(shown)
        .length,
      albumRequests: calls.filter((call) => call[1] === 'fetchSavedAlbums').length,
      artistRequests: calls.filter((call) => call[1] === 'fetchSavedArtists').length
    }
  }
  if (kind === 'search') {
    const query = document.querySelector('.streaming-search-box')
    const controls = document.querySelector('.streaming-search-tabs')
    return {
      ...common,
      title: bounds(document.querySelector('.streaming-content-title')),
      query: measure(query),
      input: bounds(query?.querySelector('input')),
      controls: measure(controls),
      result: bounds(document.querySelector('.streaming-content-body')),
      tools: [...(controls?.querySelectorAll('button,select') ?? [])].filter(shown).map((node) => ({
        name: node.getAttribute('aria-label') || node.textContent.trim(),
        ...bounds(node)
      }))
    }
  }
  throw new Error('Unknown refinement inspection: ' + kind)
}

window.providerProbe = {
  select,
  flush,
  async submitSearch(request) {
    searchNavigationRequest.value = request ? { ...request } : null
    await flush()
  },
  async setActive(value) {
    active.value = value
    await flush()
  },
  async settleSearch() {
    // Covers the real debounce as well as immediate navigation-command execution.
    await new Promise((resolve) => setTimeout(resolve, 360))
    await flush()
  },
  searchState() {
    const root = document.querySelector('.streaming-page')
    return {
      active: active.value,
      hidden: !root || getComputedStyle(root).display === 'none',
      request: searchNavigationRequest.value ? { ...searchNavigationRequest.value } : null,
      query: document.querySelector('.streaming-search-box input')?.value ?? null,
      source: document.querySelector('select[aria-label="搜索音源"]')?.value ?? null,
      sources: [...(document.querySelector('select[aria-label="搜索音源"]')?.options ?? [])].map(
        (option) => option.value
      ),
      resultText:
        document
          .querySelector('.search-results-content')
          ?.textContent.replace(/\s+/g, ' ')
          .trim() ?? '',
      loading: !!document.querySelector('.search-view[aria-busy="true"]'),
      detail: !!document.querySelector('.detail-back-button'),
      startHint: document.querySelector('.search-start-hint')?.textContent.trim() ?? '',
      resultsSummary: !!document.querySelector('.search-results-summary'),
      calls: calls.filter((call) => String(call[1]).startsWith('search')),
      responses: searchResponses.map((response) => ({ ...response })),
      emittedQueries: events
        .filter((event) => event[0] === 'search-query')
        .map((event) => event[1]),
      errors: [...errors]
    }
  },
  get calls() {
    return calls
  },
  get events() {
    return events
  },
  get errors() {
    return errors
  },
  get text() {
    return text()
  },
  setBehavior(key, value) {
    value ? behavior.set(key, value) : behavior.delete(key)
  },
  release(key) {
    for (const done of holds.get(key) ?? []) done()
    holds.delete(key)
  },
  async releaseProviderSync() {
    providerListGate?.resolve()
    providerListGate = undefined
    await flush()
  },
  async removeProvider(id) {
    registered = registered.filter((entry) => entry.id !== id)
    for (const listener of pluginListeners) listener()
    await useProviderStore().syncProviders()
    await syncPluginProviders()
    await flush()
  },
  async addProvider(id) {
    expect(!registered.some((source) => source.id === id), 'Provider is already registered')
    registered.push(provider(id))
    for (const listener of pluginListeners) listener()
    await useProviderStore().syncProviders()
    await syncPluginProviders()
    await flush()
  },
  async updateMethods(id, methods) {
    const source = registered.find((entry) => entry.id === id)
    expect(source, 'Cannot update an unavailable fixture provider')
    source.supportedMethods = [...methods]
    for (const listener of pluginListeners) listener()
    await useProviderStore().syncProviders()
    await syncPluginProviders()
    await flush()
  },
  methods(id) {
    return [...(registered.find((entry) => entry.id === id)?.supportedMethods ?? [])]
  },
  async setTasks(statuses) {
    tasks = statuses.map((status, index) => ({
      id: 'task-' + index,
      providerId: index % 2 ? 'archive' : 'aurora',
      providerJobId: 'fixture-' + index,
      track: {
        id: 'file-' + index,
        title: `第${index + 1}首` + '音乐与长文件名称'.repeat(8),
        artist: '跨来源的音乐人'
      },
      status,
      requestedQuality: 'lossless',
      actualQuality: status === 'completed' ? 'aac' : null,
      progress: 0.45,
      queuePosition: status === 'queued' ? 3 : null,
      targetPath:
        status === 'completed' ? 'C:\\FixtureOnly\\' + '长目录'.repeat(20) + '.flac' : null,
      fileSize: 35 * 1048576,
      error: status === 'failed' ? '临时连接失败，可重试；此消息仅来自测试数据。' : null,
      warning: status === 'completed' ? '音源提供的实际音质低于请求值。' : null,
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z'
    }))
    for (const listener of listeners) listener(structuredClone(tasks))
    await flush()
  }
}
