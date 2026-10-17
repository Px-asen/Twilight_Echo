import { createApp, h, nextTick, ref } from 'vue'
import ArchiveHome from '@renderer/components/local-dashboard/ArchiveHome.vue'
import NightHarborHome from '@renderer/components/local-dashboard/NightHarborHome.vue'
import SoundFieldHome from '@renderer/components/local-dashboard/SoundFieldHome.vue'
import OnlineHome from '@renderer/components/local-dashboard/OnlineHome.vue'
import LocalDashboard from '@renderer/components/LocalDashboard.vue'
import StreamingHome from '@renderer/components/StreamingHome.vue'
import ProviderMusicHome from '@renderer/components/streaming-page/ProviderMusicHome.vue'
import ListeningRankings from '@renderer/components/listening-analytics/ListeningRankings.vue'
import { installScrollToTopButton } from '@renderer/utils/scrollToTopButton.ts'

const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))
const noop = () => {}
const expect = (ok, message) => {
  if (!ok) throw new Error(message)
}
const songs = Array.from({ length: 12 }, (_, index) => ({
  id: 'home-track-' + index,
  title: 'Home song ' + index,
  artist: 'Fixture artist',
  album: 'Fixture album',
  albumId: 'fixture-album',
  duration: 180,
  filePath: 'C:/Music/fixture-' + index + '.flac',
  cover: null,
  source: 'local',
  format: 'flac'
}))
const current = songs[0]
let playCalls = 0
window.homePlayer = {
  currentTrack: ref(current),
  isPlaying: ref(false),
  currentTime: ref(0),
  duration: ref(180),
  progress: ref(0),
  volume: ref(1),
  playMode: ref('sequential'),
  queue: ref([]),
  formatTime(seconds) {
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
  },
  playTrack() {
    playCalls += 1
  },
  togglePlay() {
    playCalls += 1
  },
  next() {
    playCalls += 1
  },
  prev() {
    playCalls += 1
  },
  setPlayMode() {
    playCalls += 1
  },
  setVolume: noop,
  seek: noop,
  playNextTrack() {
    playCalls += 1
  },
  appendQueueTracks() {
    playCalls += 1
  }
}
window.homeMusic = { tracks: ref(songs), albums: ref([]), artists: ref([]) }
window.homeStats = { listeningStats: ref({ days: {}, tracks: {} }) }
window.homeDsp = {
  audioProcessing: ref({
    dspEnabled: false,
    volumeNormalization: 'off',
    replayGainPreamp: 0,
    eqEnabled: false,
    eqMode: 'parametric',
    eqPreamp: 0,
    eqBands: [],
    crossfeedEnabled: false,
    crossfeedStrength: 0.35,
    convolverEnabled: false,
    convolverIrPath: ''
  }),
  playbackInfo: ref(null),
  outputInfo: ref(null)
}
window.homeSettings = { settings: ref({ motionPreference: 'off' }) }

const stats = songs.map((track, index) => ({
  ...track,
  seconds: 500 - index,
  plays: 10,
  lastPlayed: 1,
  skips: 0,
  completions: 0,
  resolvedTrack: track
}))
const section = {
  key: 'daily',
  title: 'Daily mix',
  eyebrow: 'DAILY',
  icon: 'ph ph-music-notes',
  description: 'Fixture recommendations',
  tracks: songs
}
const provider = {
  id: 'fixture',
  name: 'Fixture source',
  supportedMethods: [],
  capabilities: [],
  ui: {}
}
const configs = {
  archive: {
    summary: { tracks: 12, albums: 0, artists: 0, duration: '36', durationUnit: '分钟' },
    recent: songs,
    added: songs.slice(1),
    albums: [],
    hero: current,
    isPlaying: false,
    currentTrackId: current.id
  },
  night: {
    summary: { tracks: 12, albums: 0, artists: 0, hours: 0, minutes: 36 },
    hero: current,
    recent: songs,
    added: songs.slice(1),
    albums: [],
    isPlaying: false,
    currentTrackId: current.id,
    currentTime: 0,
    duration: 180
  },
  sound: {
    summary: { tracks: 12, albums: 0, artists: 0, totalSeconds: 2160 },
    featured: current,
    recent: songs,
    added: songs.slice(1),
    albums: [],
    isPlaying: false,
    currentTrackId: current.id,
    currentTime: 0,
    duration: 180
  },
  online: {
    providers: [provider],
    provider,
    loading: false,
    loggedIn: true,
    error: '',
    tracks: songs,
    playlists: [],
    sectionTitle: 'Songs',
    playlistTitle: 'Playlists',
    recent: songs,
    hero: current,
    currentTrackId: current.id,
    isPlaying: false,
    pendingPlaylist: null
  },
  local: { previewTracks: songs },
  streaming: {
    providerLabel: 'Fixture source',
    isLoggedIn: true,
    recsLoading: false,
    recsError: '',
    recSections: [section],
    recommendPlaylists: [],
    currentTrackId: current.id
  },
  provider: {
    providerLabel: 'Fixture source',
    isLoggedIn: true,
    recsLoading: false,
    recsError: '',
    recSections: [
      section,
      { ...section, key: 'more', title: 'More songs', tracks: songs.slice(0, 3) }
    ],
    recommendPlaylists: [],
    currentTrackId: current.id
  },
  rankings: {
    tracks: stats,
    artists: [],
    sort: 'seconds',
    currentTrack: current,
    navigableArtists: new Set(),
    canPlayList: true
  }
}
const components = {
  archive: ArchiveHome,
  night: NightHarborHome,
  sound: SoundFieldHome,
  online: OnlineHome,
  local: LocalDashboard,
  streaming: StreamingHome,
  provider: ProviderMusicHome,
  rankings: ListeningRankings
}
const mounted = ref(['provider', 'rankings'])
const errors = []
const app = createApp({
  render: () =>
    h('div', { class: 'home-test-scroll' }, [
      mounted.value.some((key) => ['provider', 'rankings'].includes(key))
        ? h('div', { class: 'home-test-spacer' })
        : null,
      h(
        'div',
        { class: 'home-test-pages' },
        mounted.value.map((key) =>
          h(components[key], {
            ...configs[key],
            key,
            onPlay: () => {
              playCalls += 1
            },
            onPlayTrack: () => {
              playCalls += 1
            }
          })
        )
      )
    ])
})
app.config.errorHandler = (error, instance, info) =>
  errors.push(String(error?.stack || error) + ' [' + instance?.type?.__name + ' ' + info + ']')
installScrollToTopButton()
app.mount('#app')

const scroller = () => document.querySelector('.home-test-scroll')
const locator = () => document.querySelector('[aria-label="定位正在播放的歌曲"]')
const shown = () => locator()?.dataset.teScrollTopVisible === 'true'
const rootFor = () => document.querySelector('.home-test-pages')?.firstElementChild
async function settle() {
  await nextTick()
  await pause(180)
}
async function showOnly(key) {
  mounted.value = [key]
  await settle()
  scroller().scrollTop = 0
  await settle()
}
async function checkHomeLocator(key) {
  await showOnly(key)
  const root = rootFor()
  const rows = [...root.querySelectorAll('[data-te-track-id="' + current.id + '"]')]
  expect(rows.length > 0, key + ' current-song row missing')
  let scrollRoot = rows[0].parentElement
  while (
    scrollRoot &&
    !(
      /(auto|scroll|overlay)/.test(getComputedStyle(scrollRoot).overflowY) &&
      scrollRoot.scrollHeight > scrollRoot.clientHeight
    )
  )
    scrollRoot = scrollRoot.parentElement
  expect(scrollRoot, key + ' scroll container missing')
  const visible = () => {
    const viewport = scrollRoot.getBoundingClientRect()
    const bottom = Math.min(
      viewport.bottom,
      document.querySelector('.player-bar-shell').getBoundingClientRect().top
    )
    return rows.some((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > Math.max(0, viewport.top) && rect.top < bottom
    })
  }
  scrollRoot.scrollTop = visible() ? scrollRoot.scrollHeight : 0
  scrollRoot.dispatchEvent(new Event('scroll'))
  await settle()
  expect(!visible(), key + ' fixture must place all current-song rows offscreen')
  expect(shown(), key + ' offscreen current song did not expose locator')
  const before = JSON.stringify({
    playCalls,
    currentTrack: window.homePlayer.currentTrack.value,
    queue: window.homePlayer.queue.value
  })
  locator().click()
  await settle()
  expect(visible(), key + ' locator did not reveal a current-song row')
  expect(!shown(), key + ' locator stayed visible after reveal')
  expect(
    JSON.stringify({
      playCalls,
      currentTrack: window.homePlayer.currentTrack.value,
      queue: window.homePlayer.queue.value
    }) === before,
    key + ' locator changed playback state'
  )
  expect(errors.length === 0, key + ' component runtime errors: ' + errors.join('; '))
}

window.runHomeLocatorChecks = async () => {
  await settle()
  scroller().dispatchEvent(new Event('scroll'))
  await pause(260)
  expect(errors.length === 0, 'component mount errors: ' + errors.join('; '))
  expect(
    document.querySelectorAll('[data-te-track-id="' + current.id + '"]').length >= 3,
    'mounted home rows must mark the current track in real SFCs'
  )
  expect(shown(), 'offscreen home rows did not expose the shared locator')
  const before = playCalls
  locator().click()
  await settle()
  expect(!shown(), 'locating an offscreen home song did not hide the action after reveal')
  const scrollRect = scroller().getBoundingClientRect()
  const viewportCenter =
    (Math.max(0, scrollRect.top) +
      Math.min(
        scrollRect.bottom,
        document.querySelector('.player-bar-shell').getBoundingClientRect().top
      )) /
    2
  const visibleCurrent = [
    ...document.querySelectorAll('[data-te-track-id="' + current.id + '"]')
  ].find((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom
  })
  expect(visibleCurrent, 'locator did not bring a duplicate current-song row into view')
  const visibleRect = visibleCurrent.getBoundingClientRect()
  expect(
    Math.abs((visibleRect.top + visibleRect.bottom) / 2 - viewportCenter) < 8,
    'locator did not center the row above the player bar: ' +
      JSON.stringify({ row: visibleRect.toJSON(), viewportCenter })
  )
  expect(playCalls === before, 'locator activation triggered playback')
  const sharedRows = [...document.querySelectorAll('[data-te-track-id="' + current.id + '"]')]
  expect(sharedRows.length >= 2, 'fixture needs duplicate current-song rows across home sections')
  const laterRow = sharedRows.at(-1)
  scroller().scrollTop = laterRow.getBoundingClientRect().top + scroller().scrollTop - 250
  await settle()
  expect(!shown(), 'a visible duplicate home row must hide the shared locator')

  await showOnly('archive')
  const archive = rootFor()
  expect(
    archive.querySelector('[data-te-track-id="' + current.id + '"]'),
    'ArchiveHome recent row missing'
  )
  archive.scrollTop = 0
  archive.querySelector('[aria-label="下一页唱片"]').click()
  await settle()
  expect(
    !archive.querySelector('[data-te-track-id="' + current.id + '"]'),
    'ArchiveHome retained a song row from the previous page'
  )
  expect(!shown(), 'previous ArchiveHome page kept locator visible')
  archive.querySelector('#archive-tab-added').click()
  await settle()
  expect(
    !archive.querySelector('[data-te-track-id="' + current.id + '"]'),
    'ArchiveHome retained a row from the inactive activity tab'
  )
  expect(!shown(), 'inactive ArchiveHome row kept locator visible')

  await showOnly('sound')
  const sound = rootFor()
  expect(
    sound.querySelector('[data-te-track-id="' + current.id + '"]'),
    'SoundFieldHome recent row missing'
  )
  sound.querySelector('[aria-label="下一页曲目"]').click()
  await settle()
  expect(
    !sound.querySelector('[data-te-track-id="' + current.id + '"]'),
    'SoundFieldHome retained a song row from the previous page'
  )
  expect(!shown(), 'previous SoundFieldHome page kept locator visible')
  sound.querySelector('[aria-selected="false"]')?.click()
  await settle()
  expect(
    !sound.querySelector('[data-te-track-id="' + current.id + '"]'),
    'SoundFieldHome retained a row from the inactive activity tab'
  )
  expect(!shown(), 'inactive SoundFieldHome row kept locator visible')

  await showOnly('rankings')
  const rankings = rootFor()
  expect(
    rankings.querySelector('[data-te-track-id="' + current.id + '"]'),
    'ListeningRankings track row missing'
  )
  rankings.querySelectorAll('.ranking-tabs button')[1].click()
  await settle()
  expect(
    !rankings.querySelector('[data-te-track-id="' + current.id + '"]'),
    'ListeningRankings kept song rows while artist tab was active'
  )
  expect(!shown(), 'artist tab kept song locator visible')

  await showOnly('provider')
  const providerHome = rootFor()
  expect(
    providerHome.querySelector('[data-te-track-id="' + current.id + '"]'),
    'ProviderMusicHome track row missing'
  )
  expect(
    !providerHome.querySelector('.music-artwork-cover[data-te-track-id]'),
    'hero cover collage must not be tagged as a song row'
  )
  for (const key of ['night', 'online', 'streaming', 'local']) await checkHomeLocator(key)
  expect(errors.length === 0, 'component runtime errors: ' + errors.join('; '))
  return 'HOME_LOCATOR_OK'
}
