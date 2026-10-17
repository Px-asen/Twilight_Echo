import { createApp, h, nextTick, ref } from 'vue'
import RecentPlaybackPage from './RecentPlaybackPage.vue'
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
const tracks = Array.from({ length: 100 }, (_, index) => ({
  id: `platform-${index}`,
  title: `Recent track ${String(index).padStart(3, '0')}`,
  artist: 'Artist',
  album: 'Platform history',
  filePath: `https://provider.test/${index}.mp3`,
  fileName: `${index}.mp3`,
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'fixture-provider',
  format: 'mp3'
}))
let providerCalls = 0
const playCalls = []
window.api = {
  providers: {
    list: async () => [
      {
        id: 'fixture-provider',
        name: 'Fixture provider',
        capabilities: ['library'],
        supportedMethods: ['fetchRecentSongs']
      }
    ],
    call: async (id, method) => {
      expect(id === 'fixture-provider' && method === 'fetchRecentSongs', 'unexpected provider call')
      providerCalls++
      return tracks
    }
  }
}
window.locatePlayer = {
  currentTrack: ref(tracks[39]),
  isPlaying: ref(false),
  currentTime: ref(0),
  queue: [tracks[39], tracks[40]],
  playTrack(...args) {
    playCalls.push(args)
  }
}
window.locateProviders = {
  providers: ref([]),
  async syncProviders() {
    this.providers.value = await window.api.providers.list()
  },
  getProvider(id) {
    return this.providers.value.find((provider) => provider.id === id)
  },
  async checkLogin() {
    return { loggedIn: true, profile: null }
  },
  async callProvider(id, method, args) {
    return window.api.providers.call(id, method, args)
  }
}
const stopButtons = installScrollToTopButton()
const app = createApp({
  render: () => h(RecentPlaybackPage, { hasPlayer: true, active: true })
})
app.mount('#app')

const locators = () => [
  ...document.querySelectorAll('.te-scroll-companion[aria-label="定位正在播放的歌曲"]')
]
const locator = () => locators().find((button) => button.dataset.teScrollTopVisible === 'true')
const targetRow = (id) =>
  [...document.querySelectorAll('.history-track[data-te-track-id]')].find(
    (row) => row.dataset.teTrackId === id
  )
async function expectVisibleTarget(id) {
  await settle()
  const scroller = document.querySelector('.platform-history')
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event('scroll'))
  await pause(300)
  const rowAtStart = targetRow(id)
  expect(
    locator()?.dataset.teScrollTopVisible === 'true',
    `locator should show for ${id}: ${JSON.stringify({ rect: rowAtStart?.getBoundingClientRect().toJSON(), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, locatorCount: locators().length })}`
  )
  const before = {
    currentTrack: window.locatePlayer.currentTrack.value.id,
    queue: JSON.stringify(window.locatePlayer.queue),
    playCalls: playCalls.length
  }
  locator().click()
  await pause(400)
  const row = targetRow(id)
  const rect = row?.getBoundingClientRect()
  expect(
    rect && rect.top < innerHeight && rect.bottom > 40,
    `track ${id} should be in view after locate`
  )
  expect(
    window.locatePlayer.currentTrack.value.id === before.currentTrack &&
      JSON.stringify(window.locatePlayer.queue) === before.queue &&
      playCalls.length === before.playCalls,
    'locating must preserve playback state and queue'
  )
}

window.runRecentLocatorChecks = async () => {
  await settle()
  ;[...document.querySelectorAll('.recent-scope-tabs button')]
    .find((button) => button.textContent.includes('平台历史'))
    .click()
  await settle()
  expect(providerCalls > 0, 'platform recent provider should be queried')
  const row40 = 'platform-39'
  expect(targetRow(row40), 'the 40th track should render on the first page')
  await expectVisibleTarget(row40)

  const nextPage = [...document.querySelectorAll('nav[aria-label="平台历史分页"] button')].find(
    (button) => button.textContent.includes('下一页')
  )
  nextPage.click()
  await settle()
  expect(!targetRow(row40), 'the first page target must be removed from page two')
  await pause(300)
  expect(!locator(), 'a track on another page must stay hidden')

  window.locatePlayer.currentTrack.value = tracks[79]
  await expectVisibleTarget('platform-79')

  const queueSnapshot = JSON.stringify(window.locatePlayer.queue)
  ;[...document.querySelectorAll('.recent-scope-tabs button')]
    .find((button) => button.textContent.includes('本机记录'))
    .click()
  await settle()
  await pause(300)
  expect(
    !document.querySelector('.history-tracks'),
    'platform history should unmount in device scope'
  )
  expect(!locator(), 'platform locator should be hidden in device scope')
  expect(
    JSON.stringify(window.locatePlayer.queue) === queueSnapshot,
    'scope switch must preserve queue'
  )

  app.unmount()
  await pause(250)
  expect(locators().length === 0, 'unmount should dispose page locators')
  stopButtons()
  expect(
    !document.querySelector('.te-scroll-controls'),
    'scroll controls should be removed on shutdown'
  )
  return 'RECENT_TRACK_LOCATOR_OK'
}
