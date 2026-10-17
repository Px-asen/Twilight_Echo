import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import NetworkSourcesPage from '../NetworkSourcesPage.vue'
import RadioPodcastPage from '../RadioPodcastPage.vue'
import { installScrollToTopButton } from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/icon-fonts.ts'

const expect = (ok, message) => {
  if (!ok) throw new Error(message)
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async () => {
  await nextTick()
  await pause(180)
}
const entries = Array.from({ length: 36 }, (_, i) => ({
  id: `network-${i}`,
  profileId: 'nas',
  name: `Track ${i}.mp3`,
  path: `/Track ${i}.mp3`,
  kind: i === 0 ? 'directory' : 'audio',
  sizeBytes: 1
}))
const libraryItems = entries
  .filter((entry) => entry.kind === 'audio')
  .map((entry) => ({ profileId: 'nas', profileName: 'NAS', entry }))
const stations = Array.from({ length: 36 }, (_, i) => ({
  id: `radio-${i}`,
  name: `Station ${i}`,
  streamUrl: `https://radio.test/${i}`,
  tags: [],
  createdAt: '',
  updatedAt: ''
}))
const episodes = Array.from({ length: 36 }, (_, i) => ({
  guid: `guid-${i}`,
  title: `Episode ${i}`,
  mediaUrl: `https://podcast.test/${i}.mp3`,
  durationSeconds: 300
}))
const subscription = {
  id: 'show',
  feedUrl: 'https://podcast.test/feed',
  title: 'Show',
  createdAt: '',
  updatedAt: '',
  episodes
}
const networkProfile = {
  id: 'nas',
  name: 'NAS',
  protocol: 'webdav',
  host: 'nas.test',
  port: null,
  rootPath: '/',
  credentialKind: 'anonymous',
  bookmarks: []
}
const clone = (x) => JSON.parse(JSON.stringify(x))
window.api = {
  networkSources: {
    listProfiles: async () => [networkProfile],
    listDirectory: async () => entries,
    searchLibrary: async (query) => (query ? [] : libraryItems),
    cacheInfo: async () => ({ sizeBytes: 0 }),
    resolvePlayback: async () => ({ kind: 'direct-url', url: 'https://audio.test' }),
    scanDirectory: async () => ({ added: 0, total: 0 }),
    updateProfile: async () => networkProfile,
    testConnection: async () => ({ ok: true }),
    deleteProfile: async () => {},
    createProfile: async () => networkProfile,
    enrichLibrary: async () => ({ enriched: 0, failed: 0 }),
    removeLibraryEntry: async () => {},
    clearCache: async () => {}
  },
  radio: {
    loadStations: async () => ({ data: { schemaVersion: 1, stations }, revision: 1 }),
    saveStations: async (data) => ({ data: clone(data), revision: 2 }),
    importPlaylist: async () => [],
    searchDirectory: async () => []
  },
  podcast: {
    loadSubscriptions: async () => ({
      data: { schemaVersion: 1, subscriptions: [subscription] },
      revision: 1
    }),
    saveSubscriptions: async (data) => ({ data: clone(data), revision: 2 }),
    refreshAll: async () => ({})
  }
}
const playCalls = []
window.locatePlayer = {
  currentTrack: ref(null),
  isPlaying: ref(false),
  currentTime: ref(0),
  queue: [],
  playTrack(...args) {
    playCalls.push(args)
  },
  playTrackFromPosition(...args) {
    playCalls.push(args)
  },
  enqueueTrack(...args) {
    playCalls.push(args)
  }
}
window.locatePlayerCurrentTrackRef = window.locatePlayer.currentTrack
const stopButtons = installScrollToTopButton()
const app = createApp({ render: () => h(NetworkSourcesPage) })
app.use(createPinia())
app.mount('#app')
const expectLocated = async (id) => {
  await settle()
  const root = document.querySelector('.network-sources-page, .radio-podcast-page')
  root.scrollTop = 0
  root.dispatchEvent(new Event('scroll'))
  await pause(300)
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === '定位正在播放的歌曲'
  )
  expect(button?.dataset.teScrollTopVisible === 'true', `locator should show for ${id}`)
  const before = {
    calls: playCalls.length,
    queue: JSON.stringify(window.locatePlayer.queue),
    id: window.locatePlayer.currentTrack.value?.id
  }
  button.click()
  await pause(450)
  const row = [...root.querySelectorAll('[data-te-track-id]')].find(
    (el) => el.dataset.teTrackId === id
  )
  expect(
    row && row.getBoundingClientRect().top < innerHeight && row.getBoundingClientRect().bottom > 36,
    `target ${id} should scroll into view`
  )
  expect(
    playCalls.length === before.calls &&
      JSON.stringify(window.locatePlayer.queue) === before.queue &&
      window.locatePlayer.currentTrack.value?.id === before.id,
    'locating must preserve playback and queue state'
  )
}
window.runNetworkLocatorChecks = async () => {
  await settle()
  document.querySelector('.network-profile-actions .brand-soft-button').click()
  await settle()
  expect(
    window.locatePlayer.currentTrack === window.locatePlayerCurrentTrackRef,
    'network player ref was replaced'
  )
  window.locatePlayer.currentTrack.value = { id: 'network-30', source: 'network' }
  const directoryRows = [...document.querySelectorAll('.network-entry')]
  expect(
    directoryRows.some(
      (row) => row.textContent.includes('Track 0') && !row.hasAttribute('data-te-track-id')
    ),
    'directory entries must not be track targets'
  )
  expect(
    directoryRows.filter((row) => row.hasAttribute('data-te-track-id')).length === 35,
    'only audio entries should be targetable'
  )
  await expectLocated('network-30')
  ;[...document.querySelectorAll('.network-browser-context button')]
    .find((button) => button.textContent.includes('返回来源列表'))
    .click()
  await settle()
  const libraryTab = [...document.querySelectorAll('[role="tab"]')].find((button) =>
    button.textContent.includes('媒体库')
  )
  libraryTab.click()
  await settle()
  expect(
    document.querySelectorAll('.network-entry[data-te-track-id]').length === 35,
    'network library rows need entry.id targets'
  )
  expect(
    window.locatePlayer.currentTrack === window.locatePlayerCurrentTrackRef,
    'network player ref changed during locate'
  )
  window.locatePlayer.currentTrack.value = { id: 'network-30', source: 'network' }
  await expectLocated('network-30')
  const search = document.querySelector('.network-library-search input')
  search.value = 'missing'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await pause(450)
  expect(
    ![...document.querySelectorAll('button')].some(
      (b) =>
        b.getAttribute('aria-label') === '定位正在播放的歌曲' &&
        b.dataset.teScrollTopVisible === 'true'
    ),
    'filtered target must not be exposed'
  )
  app.unmount()
  const radioApp = createApp({ render: () => h(RadioPodcastPage) })
  radioApp.use(createPinia())
  radioApp.mount('#app')
  await settle()
  expect(
    window.locatePlayer.currentTrack === window.locatePlayerCurrentTrackRef,
    'player ref changed after network unmount'
  )
  window.locatePlayer.currentTrack.value = { id: 'radio-30', source: 'radio' }
  expect(
    document.querySelectorAll('.station-card[data-te-track-id]').length === stations.length,
    'saved stations must be locator rows'
  )
  await expectLocated('radio-30')
  const podcastTab = [...document.querySelectorAll('[role="tab"]')].find((button) =>
    button.textContent.includes('播客')
  )
  podcastTab.click()
  await settle()
  const sub = [...document.querySelectorAll('.subscription-open')].find((button) =>
    button.textContent.includes('Show')
  )
  sub.click()
  await settle()
  const targetId = 'podcast:show:guid-30'
  expect(
    document.querySelector(`[data-te-track-id="${targetId}"]`),
    'podcast target ID must match podcastEpisodeToTrack identity'
  )
  window.locatePlayer.currentTrack.value = { id: targetId, source: 'podcast' }
  await expectLocated(targetId)
  expect(playCalls.length === 0, 'location must not invoke playback actions')
  radioApp.unmount()
  stopButtons()
  return 'NETWORK_TRACK_LOCATOR_OK'
}
