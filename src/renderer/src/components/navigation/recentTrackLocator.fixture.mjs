import { createApp, h, nextTick, ref, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import RecentPlaybackPage from './RecentPlaybackPage.vue'
import SongList from '../SongList.vue'
import { installScrollToTopButton } from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/icon-fonts.ts'

const expect = (ok, message) => {
  if (!ok) throw new Error(message)
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const wait = async (check, message) => {
  for (let i = 0; i < 150; i++) {
    await nextTick()
    if (check()) return
    await pause(25)
  }
  throw new Error(message + ': ' + errors.join('; ') + ' ' + document.body.innerText.slice(0, 600))
}
const errors = [],
  queries = [],
  playCalls = [],
  navigation = []
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const state = shallowRef({
  phase: 'ready',
  epoch: 'history',
  libraryRevision: 1,
  catalogRevision: 1,
  entityMetadataRevision: 1,
  settingsRevision: 1,
  playlistsRevision: 2,
  versionsRevision: 1,
  statisticsRevision: 3,
  bookmarksRevision: 1,
  pluginsRevision: 1
})
const tracks = Array.from({ length: 405 }, (_, index) => ({
  id: 'recent-' + index,
  title: 'Recent track ' + String(index).padStart(3, '0'),
  artist: index % 2 ? 'Platform artist' : 'Local artist',
  album: 'Recent album',
  source: index % 2 ? 'fixture-provider' : 'local',
  filePath: index % 2 ? 'fixture-provider:' + index : 'D:/Music/' + index + '.flac',
  fileName: index + '.flac',
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  format: 'FLAC'
}))
const folders = Array.from({ length: 7 }, (_, index) => ({
  id: 'folder-' + index,
  name: '音乐文件夹 ' + (index + 1),
  path: 'D:/Music/' + index,
  trackCount: index + 1,
  cover: null
}))
const artists = Array.from({ length: 854 }, (_, index) => ({
  id: 'artist-' + index,
  name:
    String.fromCharCode(65 + Math.floor((index * 26) / 854)) +
    ' 艺术家 ' +
    String(index).padStart(3, '0'),
  genre: index % 2 ? 'Pop' : 'Rock',
  trackCount: (index % 7) + 1,
  duration: ((index % 7) + 1) * 180,
  addedAt: index,
  cover: null
}))
const albums = Array.from({ length: 1078 }, (_, index) => ({
  id: 'album-' + index,
  name:
    String.fromCharCode(65 + Math.floor((index * 26) / 1078)) +
    ' 专辑 ' +
    String(index).padStart(4, '0'),
  artist: '艺术家 ' + (index % 30),
  genre: index % 2 ? 'Pop' : 'Rock',
  trackCount: (index % 12) + 1,
  duration: ((index % 12) + 1) * 180,
  releaseDate: '2025-10-21',
  addedAt: index,
  cover: null
}))
const collectionCases = {
  artists: { items: artists, label: '艺术家', unit: '位艺术家', selector: '.artist-card' },
  albums: { items: albums, label: '专辑', unit: '张专辑', selector: '.local-album-card' }
}
let failView = false,
  failCollections = false,
  failHistory = false,
  historyRevision = 1,
  delay = 30
window.api = { data: { getCover: async () => null }, providers: { list: async () => [] } }
window.locateSettings = {
  settings: shallowRef({
    musicIdentification: { language: 'zh-Hans' },
    libraryFolders: [],
    genreSeparators: ';',
    trackActivationMode: 'doubleClick'
  })
}
window.locatePlayer = {
  currentTrack: ref(tracks[339]),
  isPlaying: ref(false),
  currentTime: ref(0),
  queue: ref([tracks[339], tracks[340]]),
  playTrack: (...args) => playCalls.push(args),
  playLibraryQuery: async (...args) => playCalls.push(args),
  setPlayMode() {},
  playNextTrack() {},
  appendQueueTracks() {}
}
const page = (query = {}) => {
  if (query.sort === 'lastPlayed' && query.historyRevision !== historyRevision)
    throw Object.assign(
      new Error('Listening history changed; refresh its order before retrying'),
      { code: 'STALE_HISTORY_REVISION' }
    )
  let selected = tracks.map((track, index) => ({ track, index }))
  if (query.filters?.provider)
    selected = selected.filter((item) => item.track.source === query.filters.provider)
  if (query.search)
    selected = selected.filter((item) =>
      item.track.title.toLowerCase().includes(query.search.toLowerCase())
    )
  const anchorIndex = query.anchorId
    ? selected.findIndex((item) => item.track.id === query.anchorId)
    : undefined
  const offset =
    anchorIndex !== undefined && anchorIndex >= 0
      ? Math.floor(anchorIndex / 200) * 200
      : (query.offset ?? 0)
  const items = selected.slice(offset, offset + (query.limit ?? 200))
  return {
    revision: 1,
    offset,
    total: selected.length,
    totalDuration: selected.length * 180,
    tracks: items.map((item) => item.track),
    entryIds: items.map((item) => String(item.index)),
    versions: Object.fromEntries(items.map((item) => [item.track.id, 1])),
    anchorIndex,
    historyRevision
  }
}
window.locateCore = {
  state,
  attach: async () => {},
  subscribe: () => () => {},
  command: async () => {
    throw new Error('Unexpected write')
  },
  query: async (name, payload = {}) => {
    queries.push({ name, payload })
    if (name === 'library.metadata')
      return { revision: 1, trackCount: 405, folders: [], exclusions: [] }
    if (name === 'playlists.state')
      return { revision: 2, persistence: { state: 'idle', dirty: false } }
    if (name === 'statistics.tracks')
      return { revision: state.value.statisticsRevision, offset: 0, total: 0, items: [] }
    if (['playlists.catalog', 'bookmarks.page'].includes(name))
      return { revision: 3, offset: 0, total: 0, items: [] }
    if (name === 'statistics.overview') {
      if (failHistory) {
        failHistory = false
        throw new Error('历史索引读取失败（测试）')
      }
      return {
        revision: state.value.statisticsRevision,
        days: {},
        artists: [],
        history: {
          mode: 'sqlite',
          ready: true,
          pending: false,
          revision: historyRevision,
          error: ''
        },
        persistence: { dirty: false, error: null }
      }
    }
    if (name === 'bookmarks.state') return { revision: 1, longTrackResumeSeconds: 1200 }
    if (name === 'catalog.query') return { revision: 1, offset: 0, total: 0, items: [] }
    if (name === 'providers.list')
      return [
        {
          id: 'fixture-provider',
          name: '测试平台',
          capabilities: ['library'],
          supportedMethods: []
        }
      ]
    if (name === 'playlists.view') {
      expect(
        payload.id === 'core:recent' && payload.revision === state.value.statisticsRevision,
        'recent view must use its statistics revision'
      )
      expect(payload.preserveSources === true, 'recent view must retain recorded provider sources')
      await pause(delay)
      if (failView && payload.query?.limit === 1) {
        failView = false
        throw new Error('播放记录读取失败（测试）')
      }
      return {
        viewId: 'recent-view-' + payload.revision,
        revision: payload.revision,
        versionsRevision: 1,
        page: page(payload.query)
      }
    }
    if (name === 'library.collections') {
      expect(
        ['folders', 'artists', 'albums', 'genres'].includes(payload.kind),
        'unexpected collection kind'
      )
      await pause(delay)
      if (failCollections && payload.kind !== 'genres') {
        failCollections = false
        throw new Error((collectionCases[payload.kind]?.label || '文件夹') + '读取失败（测试）')
      }
      const query = payload.query || {}
      const collections =
        collectionCases[payload.kind]?.items ??
        (payload.kind === 'folders'
          ? folders
          : ['Pop', 'Rock'].map((name) => ({
              id: name,
              name,
              trackCount: 427,
              duration: 0,
              cover: null
            })))
      const items = collections.filter(
        (item) =>
          (!query.search || item.name.includes(query.search)) &&
          (!query.collectionGenre || item.genre === query.collectionGenre)
      )
      if (collectionCases[payload.kind]) {
        items.sort(
          (a, b) =>
            (query.sort === 'addedAt' ? a.addedAt - b.addedAt : a.name.localeCompare(b.name)) *
            (query.direction === 'desc' ? -1 : 1)
        )
      }
      const letterOffsets = {}
      items.forEach((item, index) => {
        const letter = payload.kind === 'folders' ? 'Y' : item.name[0].toUpperCase()
        if (!(letter in letterOffsets)) letterOffsets[letter] = index
      })
      return {
        revision: 1,
        offset: query.offset ?? 0,
        total: items.length,
        letterOffsets,
        items: items.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 200))
      }
    }
    throw new Error('Unexpected query: ' + name)
  }
}
const mode = ref('recent'),
  target = ref({ kind: 'recent' })
const app = createApp({
  render: () =>
    mode.value === 'recent'
      ? h(RecentPlaybackPage, { hasPlayer: true, active: true, target: target.value })
      : h(SongList, {
          key: mode.value,
          category: mode.value,
          filter: null,
          hasPlayer: false,
          transitionName: 'page-down',
          onSelectView: (...args) => navigation.push(args)
        })
})
app.use(createPinia())
app.config.errorHandler = (error) => errors.push(error.stack || String(error))
app.mount('#app')
const stopButtons = installScrollToTopButton()
const rows = () => [...document.querySelectorAll('.track-row')]
const resetScroll = async () => {
  const el = document.querySelector('.song-list')
  el.scrollTop = 0
  el.dispatchEvent(new Event('scroll'))
  await pause(100)
}
const source = async (label) => {
  document.querySelector('.recent-source-trigger').click()
  await nextTick()
  const option = [...document.querySelectorAll('.recent-source-option')].find(
    (item) => item.textContent.trim() === label
  )
  expect(option, 'missing source option ' + label)
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await wait(
    () =>
      document.querySelector('.recent-source-trigger').textContent.includes(label) &&
      rows().length &&
      !document.querySelector('[aria-label="刷新歌曲"]').disabled,
    'source filter did not finish'
  )
}
window.runRecentLocatorChecks = async () => {
  await wait(() => rows().length > 0, 'recorded tracks did not load')
  expect(
    !document.querySelector('.recent-scope-tabs, .platform-history'),
    'duplicate history scopes remain'
  )
  expect(
    document.querySelector('.recent-source-trigger').textContent.includes('全平台'),
    'recent source must default to all'
  )
  expect(
    document.querySelector('.view-stats').textContent.includes('405'),
    'history total must include unloaded rows'
  )
  expect(
    !queries.some((query) => query.name === 'library.tracks'),
    'recent history cannot fall back to the complete local library'
  )
  // SQL can commit a listening tick before the renderer receives its next
  // statistics snapshot. The read must refresh that fence, not replay it forever.
  historyRevision++
  await source('本地音乐')
  expect(
    queries.some((query) => query.payload.query?.historyRevision === historyRevision),
    'stale history must automatically reload with the confirmed revision'
  )
  expect(
    rows().every((row) => row.textContent.includes('Local artist')),
    'local source filter leaked remote tracks'
  )
  await source('测试平台')
  expect(
    rows().every((row) => row.textContent.includes('Platform artist')),
    'provider filter leaked local tracks'
  )
  document.querySelector('.btn-play-all').click()
  await pause(50)
  expect(
    playCalls.at(-1)?.[0]?.filters?.provider === 'fixture-provider',
    'play all must keep the complete source-filtered query'
  )
  const beforeQueue = JSON.stringify(window.locatePlayer.queue.value),
    beforePlays = playCalls.length
  await source('全平台')
  await resetScroll()
  const locate = () =>
    [...document.querySelectorAll('.te-scroll-companion')].find(
      (el) => el.dataset.teScrollTopVisible === 'true'
    )
  await wait(locate, 'recent table locator did not appear')
  locate().click()
  await wait(
    () => document.querySelector('.track-row[aria-current="true"]'),
    'locator did not load the current history row beyond the first page'
  )
  expect(
    queries.some((query) => query.payload.query?.anchorId === tracks[339].id),
    'locator must ask the full history view'
  )
  expect(
    JSON.stringify(window.locatePlayer.queue.value) === beforeQueue &&
      playCalls.length === beforePlays,
    'locating changed playback'
  )
  await resetScroll()
  await wait(
    () => !document.querySelector('[aria-label="刷新歌曲"]').disabled,
    'history read did not settle before refresh'
  )
  failView = true
  const beforeRefresh = queries.length
  document.querySelector('[aria-label="刷新歌曲"]').click()
  await wait(() => queries.length > beforeRefresh, 'refresh did not issue a read')
  await wait(
    () => document.querySelector('[role="alert"]')?.textContent.includes('播放记录读取失败'),
    'failed history read must expose retry instead of an empty list'
  )
  const retry = [...document.querySelectorAll('button')].find(
    (el) => el.textContent.trim() === '重试'
  )
  expect(retry, 'history failure has no retry')
  retry.click()
  await wait(
    () => rows().length && !document.querySelector('[role="alert"]'),
    'history retry did not restore tracks'
  )
  // A failed refresh must not keep advertising the old overview as ready.
  historyRevision++
  failHistory = true
  document.querySelector('[aria-label="刷新歌曲"]').click()
  await wait(
    () => document.querySelector('[role="alert"]')?.textContent.includes('历史索引读取失败'),
    'history projection failure must expose its own retry'
  )
  ;[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '重试').click()
  await wait(
    () => rows().length && !document.querySelector('[role="alert"]'),
    'retry must refresh the failed history projection before reading tracks'
  )
  const recorded = tracks.splice(0)
  state.value = { ...state.value, statisticsRevision: state.value.statisticsRevision + 1 }
  await wait(
    () => document.querySelector('.empty-text')?.textContent.includes('暂无播放记录'),
    'clearing history must update the open list'
  )
  tracks.push({ ...recorded[0], id: 'recent-new', title: 'Newly played track' })
  state.value = { ...state.value, statisticsRevision: state.value.statisticsRevision + 1 }
  await wait(
    () => rows().some((row) => row.textContent.includes('Newly played track')),
    'new playback must refresh an empty history without reopening the page'
  )
  tracks.splice(0, tracks.length, ...recorded)
  state.value = { ...state.value, statisticsRevision: state.value.statisticsRevision + 1 }
  await wait(
    () => document.querySelector('.view-stats')?.textContent.includes('405') && rows().length > 1,
    'history revision did not refresh the complete list'
  )
  target.value = { kind: 'recent', scope: 'platform', providerId: 'fixture-provider' }
  await wait(
    () =>
      document.querySelector('.recent-source-trigger')?.textContent.includes('测试平台') &&
      rows().every((row) => row.textContent.includes('Platform artist')),
    'old platform links must open the same source-filtered list'
  )
  target.value = { kind: 'recent' }
  await source('全平台')
  await resetScroll()
  expect(errors.length === 0, errors.join('; '))
  return 'RECENT_TRACK_LOCATOR_OK'
}
window.checkRecentLayout = async () => {
  await resetScroll()
  expect(!document.querySelector('.recent-scope-tabs'), 'history tabs returned')
  for (const selector of [
    '.song-list-title',
    '.recent-source-trigger',
    '.library-filter-trigger',
    '.search-box'
  ]) {
    const rect = document.querySelector(selector).getBoundingClientRect()
    expect(rect.left >= 0 && rect.right <= innerWidth && rect.width > 0, selector + ' overflows')
  }
}
window.openFolderChecks = async () => {
  mode.value = 'folders'
  await wait(
    () => document.querySelectorAll('.folder-card').length === 7,
    'folder grid failed to load'
  )
  const count = () => (document.body.innerText.match(/共 7 个文件夹/g) || []).length
  expect(
    count() === 1 && !document.querySelector('[aria-label="分类读取状态"]'),
    'folder count must appear once'
  )
  delay = 160
  document.querySelector('[aria-label="刷新文件夹"]').click()
  await nextTick()
  expect(
    document.querySelector('[aria-label="刷新文件夹"]').disabled,
    'refresh must disable during reading'
  )
  expect(
    document.querySelector('.view-stats').textContent.includes('正在读取'),
    'header must retain loading feedback'
  )
  await wait(
    () => !document.querySelector('[aria-label="刷新文件夹"]').disabled,
    'folder refresh did not finish'
  )
  failCollections = true
  document.querySelector('[aria-label="刷新文件夹"]').click()
  await wait(
    () => document.querySelector('[role="alert"]')?.textContent.includes('文件夹读取失败'),
    'folder errors must retain recovery'
  )
  ;[...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '重试').click()
  await wait(
    () =>
      document.querySelectorAll('.folder-card').length === 7 &&
      !document.querySelector('[role="alert"]'),
    'folder retry failed'
  )
  document.querySelector('.folder-card').click()
  expect(
    navigation.at(-1)?.[0] === 'folders' && navigation.at(-1)?.[1] === 'folder:D:/Music/0',
    'folder navigation changed'
  )
  const search = document.querySelector('.search-input')
  search.value = '不存在'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(
    () => document.querySelector('.view-stats')?.textContent.trim() === '共 0 个文件夹',
    'empty folder count did not update'
  )
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(
    () => document.querySelectorAll('.folder-card').length === 7,
    'clearing search did not restore folders'
  )
  expect(
    count() === 1 && errors.length === 0,
    'folder count duplicated or rendering failed: ' + errors.join('; ')
  )
}
window.checkFolderLayout = async () => {
  await pause(100)
  const title = document.querySelector('.song-list-title').getBoundingClientRect()
  const first = document.querySelector('.folder-card').getBoundingClientRect()
  expect(
    Math.abs(title.left - first.left) < 1,
    'folder header is not aligned with the cards: ' +
      JSON.stringify({ title: title.left, card: first.left })
  )
  const refresh = document.querySelector('[aria-label="刷新文件夹"]').getBoundingClientRect()
  expect(
    Math.abs(refresh.top + refresh.height / 2 - title.top - title.height / 2) < 12,
    'folder refresh must stay aligned with the title'
  )
  expect(
    (document.body.innerText.match(/共 7 个文件夹/g) || []).length === 1,
    'folder count repeated'
  )
}
window.openCollectionChecks = async (kind) => {
  const { items, label, unit, selector } = collectionCases[kind]
  const count = items.length
  delay = 30
  mode.value = kind
  const cards = () => [...document.querySelectorAll(selector)]
  const refresh = () => document.querySelector(`[aria-label="刷新${label}"]`)
  const total = (count) =>
    document.querySelector('.view-stats')?.textContent.trim() === `共 ${count} ${unit}`
  await wait(
    () => cards().length && total(count) && refresh() && !refresh().disabled,
    kind + ' grid failed to load'
  )
  expect(cards().length < 200, kind + ' count must describe the complete query, not mounted cards')
  expect(
    (document.body.innerText.match(new RegExp(`共 ${count} ${unit}`, 'g')) || []).length === 1,
    kind + ' count must appear once'
  )
  expect(
    !document.querySelector('[aria-label="分类读取状态"]'),
    kind + ' grid still has a duplicate status strip'
  )
  expect(refresh().closest('.song-list-header'), kind + ' refresh must be in the header')

  const sort = document.querySelector('[aria-label="排序方式"]')
  sort.value = 'name-desc'
  sort.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(
    () => cards()[0]?.textContent.includes(`Z ${label}`) && !refresh().disabled,
    kind + ' sort stopped working'
  )
  sort.value = 'name-asc'
  sort.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(
    () => cards()[0]?.textContent.includes(`A ${label}`) && !refresh().disabled,
    kind + ' sort did not reset'
  )

  const genre = document.querySelector('[aria-label="按流派筛选"]')
  genre.value = 'Pop'
  genre.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(() => total(count / 2) && !refresh().disabled, kind + ' genre filter failed')
  genre.value = ''
  genre.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(() => total(count) && !refresh().disabled, 'clearing ' + kind + ' genre failed')

  const search = document.querySelector('.search-input')
  search.value = '不存在'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(() => total(0) && !refresh().disabled, kind + ' empty count must stay visible')
  expect(!cards().length, 'unmatched ' + kind + ' search retained cards')
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(
    () => total(count) && cards().length && !refresh().disabled,
    'clearing ' + kind + ' search failed'
  )

  const lastLetter = [...document.querySelectorAll('.az-index button')].find(
    (el) => el.textContent.trim() === 'Z'
  )
  expect(lastLetter && !lastLetter.disabled, kind + ' A-Z navigation disappeared')
  lastLetter.click()
  await wait(
    () => cards().some((card) => card.dataset.collectionLetter === 'Z') && !refresh().disabled,
    kind + ' A-Z navigation did not load its target'
  )
  expect(
    queries.some(
      (query) =>
        query.name === 'library.collections' &&
        query.payload.kind === kind &&
        query.payload.query.offset >= Math.floor((count * 25) / 26 / 200) * 200
    ),
    kind + ' A-Z must locate unloaded pages'
  )
  await resetScroll()
  await wait(
    () => cards()[0]?.textContent.includes(`A ${label}`) && !refresh().disabled,
    kind + ' grid did not return to the start'
  )
  cards()[0].click()
  expect(
    navigation.at(-1)?.[0] === kind &&
      navigation.at(-1)?.[1] ===
        (kind === 'artists' ? `artist:${items[0].name}` : `album:${items[0].id}`),
    kind + ' card navigation changed'
  )

  delay = 160
  refresh().click()
  await nextTick()
  expect(
    refresh().disabled && document.querySelector('.view-stats').textContent.includes('正在读取'),
    kind + ' refresh lost its loading feedback'
  )
  await wait(() => !refresh().disabled, kind + ' refresh did not finish')
  failCollections = true
  refresh().click()
  await wait(
    () => document.querySelector('[role="alert"]')?.textContent.includes(label + '读取失败'),
    kind + ' errors must retain recovery'
  )
  const retry = [...document.querySelectorAll('button')].find(
    (el) => el.textContent.trim() === '重试'
  )
  expect(retry, kind + ' error has no retry')
  retry.click()
  await wait(
    () => cards().length && !document.querySelector('[role="alert"]') && !refresh().disabled,
    kind + ' retry did not recover'
  )
  expect(errors.length === 0, errors.join('; '))
}
window.checkCollectionLayout = async (kind) => {
  const { items, label, unit, selector } = collectionCases[kind]
  await resetScroll()
  const title = document.querySelector('.song-list-title').getBoundingClientRect()
  const card = document.querySelector(selector).getBoundingClientRect()
  expect(
    Math.abs(title.left - card.left) < 1,
    kind +
      ' title is not aligned with the cards: ' +
      JSON.stringify({ title: title.left, card: card.left })
  )
  const refresh = document.querySelector(`[aria-label="刷新${label}"]`).getBoundingClientRect()
  expect(
    Math.abs(refresh.top + refresh.height / 2 - title.top - title.height / 2) < 12,
    kind + ' refresh must align with the title'
  )
  expect(
    getComputedStyle(document.querySelector('.view-stats')).transform === 'none',
    kind + ' count must follow the title baseline'
  )
  for (const selector of [
    '[aria-label="排序方式"]',
    '[aria-label="按流派筛选"]',
    '.search-box',
    '.az-index'
  ]) {
    const rect = document.querySelector(selector).getBoundingClientRect()
    expect(
      rect.left >= title.left - 1 && rect.right <= innerWidth && rect.width > 0,
      selector + ' overflows the ' + kind + ' page'
    )
  }
  if (innerWidth <= 640) {
    const genre = document.querySelector('[aria-label="按流派筛选"]').getBoundingClientRect()
    const search = document.querySelector('.search-box').getBoundingClientRect()
    expect(
      Math.abs(genre.right - search.right) < 1,
      kind + ' filters and search must share the right edge'
    )
  }
  expect(
    (document.body.innerText.match(new RegExp(`共 ${items.length} ${unit}`, 'g')) || []).length ===
      1,
    kind + ' count repeated'
  )
}
window.finishLibraryChecks = async () => {
  app.unmount()
  await pause(100)
  stopButtons()
  expect(!document.querySelector('.te-scroll-controls'), 'scroll controls leaked after unmount')
  expect(errors.length === 0, errors.join('; '))
}
