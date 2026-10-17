import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import AggregatePlaylistPage from '@renderer/components/aggregate-playlist/AggregatePlaylistPage.vue'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import { recordListeningForTest } from '@renderer/stores/useListeningStatsStore.ts'
import { installScrollToTopButton } from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/icon-fonts.ts'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const expect = (value, message) => {
  if (!value) throw new Error(message)
}
async function settle() {
  await nextTick()
  await pause(100)
}
async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await pause(40)
  }
  throw new Error(
    message +
      '; ' +
      JSON.stringify({
        category: category.value,
        filter: filter.value,
        scrollTop: container()?.scrollTop,
        title: document.querySelector('.song-list-title')?.textContent,
        rows: document.querySelectorAll('.track-row').length,
        playing: playingRow()?.getBoundingClientRect().toJSON(),
        errors,
        folders: music.folders.value.map((f) => f.path)
      })
  )
}

window.api = {
  data: { loadPlaybackBookmarks: async () => null },
  providers: { list: async () => [] }
}
window.locatePlayer = {
  currentTrack: ref(null),
  isPlaying: ref(false),
  currentTime: ref(42),
  queue: [],
  playTrack() {
    throw new Error('locating must not play a song')
  },
  setPlayMode() {
    throw new Error('locating must not change play mode')
  },
  playNextTrack() {
    throw new Error('locating must not skip a song')
  },
  appendQueueTracks() {
    throw new Error('locating must not change the queue')
  }
}
const music = useMusicStore()
const library = Array.from({ length: 1000 }, (_, i) => ({
  id: 'track-' + i,
  title: 'Song ' + String(i).padStart(4, '0'),
  artist: 'Artist',
  album: 'Album',
  albumId: 'album',
  trackNumber: i + 1,
  filePath: 'C:/Music/song-' + i + '.flac',
  fileName: 'song-' + i + '.flac',
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  format: i % 2 ? 'dsf' : 'flac',
  sampleRate: i % 2 ? 192000 : 48000
}))
music.tracks.value = library
music.refreshLibraryIndex()
music.playlists.value = [
  {
    id: 'playlist',
    name: 'Playlist',
    trackIds: library.map((t) => t.id).reverse(),
    createdAt: ''
  },
  { id: 'other', name: 'Other', trackIds: [library[0].id], createdAt: '' }
]
window.locatePlayer.currentTrack.value = library[700]
window.locatePlayer.queue = [library[700], library[701]]

const category = ref('allSongs')
const filter = ref(null)
const errors = []
const stopButtons = installScrollToTopButton()
const app = createApp({
  setup: () => () =>
    h(SongList, {
      category: category.value,
      filter: filter.value,
      hasPlayer: true,
      transitionName: 'page-down',
      onSelectView: (nextCategory, nextFilter) => {
        category.value = nextCategory
        filter.value = nextFilter
      }
    })
})
app.use(createPinia())
app.config.errorHandler = (error) => errors.push(String(error))
app.mount('#app')

const container = () => document.querySelector('.song-list')
const locate = () => document.querySelector('[aria-label="定位正在播放的歌曲"]')
const topButton = () => document.querySelector('[aria-label="回到开头"]')
const shown = (button) => !!button && button.dataset.teScrollTopVisible === 'true'
const playingRow = () => document.querySelector('.track-playing')
async function scroll(top) {
  container().scrollTop = top
  container().dispatchEvent(new Event('scroll'))
  await settle()
}
async function switchView(nextCategory, nextFilter = null) {
  category.value = nextCategory
  filter.value = nextFilter
  await nextTick()
  await pause(600)
  await scroll(0)
  expect(errors.length === 0, errors.join(';'))
}
async function locateAndCheck() {
  await waitFor(() => shown(locate()), 'locate button should be available')
  const state = JSON.stringify({
    track: window.locatePlayer.currentTrack.value,
    playing: window.locatePlayer.isPlaying.value,
    time: window.locatePlayer.currentTime.value,
    queue: window.locatePlayer.queue
  })
  locate().click()
  await waitFor(() => playingRow() && !shown(locate()), 'locate did not reveal the current row')
  await waitFor(() => {
    const rect = playingRow().getBoundingClientRect()
    const bar = document.querySelector('.player-bar-shell').getBoundingClientRect()
    const expectedCenter = (container().getBoundingClientRect().top + 44 + bar.top) / 2
    return Math.abs((rect.top + rect.bottom) / 2 - expectedCenter) < 6
  }, 'current row is not centered')
  expect(
    JSON.stringify({
      track: window.locatePlayer.currentTrack.value,
      playing: window.locatePlayer.isPlaying.value,
      time: window.locatePlayer.currentTime.value,
      queue: window.locatePlayer.queue
    }) === state,
    'locate changed playback state'
  )
  expect(document.querySelectorAll('.track-row').length < 40, 'locate defeated virtualization')
}

window.runLocateChecks = async () => {
  await waitFor(
    () => shown(locate()),
    'initial offscreen song should show a button without pointer movement'
  )
  expect(!shown(topButton()), 'back to top should stay hidden at the top')
  expect(!playingRow(), 'distant song must not be mounted initially')
  // Ctrl-select two rows; the locate button must preserve both selections.
  const rows = [...document.querySelectorAll('.track-row')].slice(0, 2)
  for (const row of rows)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  await settle()
  const selected = document.querySelector('.selection-toolbar')?.textContent
  expect(selected, 'selection toolbar missing')
  await locateAndCheck()
  expect(
    document.querySelector('.selection-toolbar')?.textContent === selected,
    'locate changed multi-selection'
  )
  expect(!playingRow().classList.contains('track-selected'), 'locate selected the current song')
  const centeredTop = container().scrollTop
  await scroll(centeredTop - 600)
  expect(shown(locate()) && shown(topButton()), 'both scroll controls should show')
  const a = topButton().getBoundingClientRect(),
    b = locate().getBoundingClientRect()
  expect(a.bottom < b.top && a.left === b.left, 'locate must sit below back to top')
  expect(locate().parentElement === topButton().parentElement, 'controls must share one anchor')
  expect(
    getComputedStyle(locate()).position === 'absolute',
    'locator must use absolute positioning'
  )
  expect(
    getComputedStyle(topButton()).position === 'absolute',
    'arrow must use absolute positioning'
  )
  await scroll(centeredTop)
  expect(!shown(locate()), 'visible song should hide locator')
  expect(topButton().getBoundingClientRect().top === a.top, 'hiding locator moved the arrow')
  await scroll(centeredTop - 600)
  expect(shown(locate()), 'offscreen song should restore locator')
  expect(topButton().getBoundingClientRect().top === a.top, 'showing locator moved the arrow')
  expect(locate().getBoundingClientRect().top === b.top, 'locator changed its absolute slot')
  expect(
    b.bottom < document.querySelector('.player-bar-shell').getBoundingClientRect().top,
    'control overlaps player'
  )
  // The overscan row is mounted below the viewport but must still be locatable.
  await scroll(centeredTop - 460)
  expect(playingRow(), 'overscan fixture did not mount the row')
  expect(
    playingRow().getBoundingClientRect().top >
      document.querySelector('.player-bar-shell').getBoundingClientRect().top,
    'overscan fixture must place the entire row below the visible viewport'
  )
  expect(shown(locate()), 'offscreen overscan must not hide locate')
  await locateAndCheck()
  // Leave only a portion of the row visible: it is already onscreen.
  const rowTop = container().scrollTop + playingRow().getBoundingClientRect().top
  await scroll(rowTop - 20)
  expect(!shown(locate()), 'partly visible song should not show locate')
  await scroll(rowTop + 80)
  expect(shown(locate()), 'row above viewport should show locate')
  await locateAndCheck()
  await scroll(rowTop + 25)
  expect(playingRow().getBoundingClientRect().bottom <= 44, 'caption fixture needs an obscured row')
  expect(shown(locate()), 'song behind title bar must remain locatable')
  await locateAndCheck()
  await scroll(0)
  // Search does not clear itself to reveal a song outside the results.
  const search = document.querySelector('.search-input')
  search.value = 'Song 0001'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await pause(350)
  expect(!shown(locate()), 'search-hidden song should have no locate button')
  expect(search.value === 'Song 0001', 'search was changed')
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await pause(350)
  await waitFor(() => shown(locate()), 'clearing search did not restore locate')
  document.querySelector('.library-filter-trigger').click()
  await settle()
  const panel = document.querySelector('.library-filter-panel')
  const dsd = [...panel.querySelectorAll('label')]
    .find((el) => el.textContent.includes('DSD'))
    .querySelector('input')
  dsd.click()
  await settle()
  expect(
    !shown(locate()) && dsd.checked,
    'filter-hidden song should stay hidden without resetting filters'
  )
  dsd.click()
  const order = panel.querySelectorAll('select')[1]
  order.value = 'desc'
  order.dispatchEvent(new Event('change', { bubbles: true }))
  document.querySelector('.library-filter-trigger').click()
  await settle()
  await locateAndCheck()
  // Changing the playing song updates the action without any scroll or pointer event.
  window.locatePlayer.currentTrack.value = library[100]
  window.locatePlayer.isPlaying.value = true
  await settle()
  await locateAndCheck()
  window.locatePlayer.isPlaying.value = false
  await scroll(0)
  document.documentElement.dataset.teMotion = 'full'
  await locateAndCheck()
  document.documentElement.dataset.teMotion = 'off'
  window.locatePlayer.currentTrack.value = null
  await settle()
  expect(!shown(locate()), 'no current track should hide locate')
  window.locatePlayer.currentTrack.value = { ...library[100], id: 'online:100', source: 'online' }
  await settle()
  expect(!shown(locate()), 'a non-library song should hide locate')
  window.locatePlayer.currentTrack.value = library[700]
  for (const [nextCategory, nextFilter] of [
    ['playlists', 'playlist:Playlist'],
    ['albums', 'album:id:album'],
    ['artists', 'artist:Artist'],
    ['folders', 'folder:' + music.folders.value[0].path]
  ]) {
    await switchView(nextCategory, nextFilter)
    await locateAndCheck()
  }
  await switchView('playlists', 'playlist:Other')
  expect(!shown(locate()), 'song outside this playlist should hide locate')
  await switchView('albums')
  expect(!shown(locate()), 'album grid should not expose a song-row action')
  await switchView('allSongs')
  // A row under the bottom player is not visible even though it is mounted.
  const tbodyTop = document.querySelector('tbody').getBoundingClientRect().top
  const index = 299 // Song 0700 in descending order.
  await scroll(tbodyTop + index * 68 - (innerHeight - 80))
  expect(playingRow(), 'player obstruction fixture needs a mounted row')
  expect(shown(locate()), 'row hidden by player bar should remain locatable')
  await locateAndCheck()
  // Ordinary application playlists and device history also retain online snapshots.
  const snapshots = library.slice(0, 100).map((track, index) => ({
    ...track,
    id: 'ncm:snapshot-' + index,
    title: 'Online Song ' + index,
    artist: 'Online Artist',
    album: 'Online Album',
    source: 'ncm',
    ncmSongId: index + 1
  }))
  music.playlists.value = [
    ...music.playlists.value,
    {
      id: 'online-snapshots',
      name: 'Online snapshots',
      trackIds: snapshots.map((track) => track.id),
      trackSnapshots: Object.fromEntries(snapshots.map((track) => [track.id, track])),
      createdAt: ''
    }
  ]
  window.locatePlayer.currentTrack.value = snapshots[80]
  await switchView('playlists', 'playlist:Online snapshots')
  await locateAndCheck()
  const timestamp = Date.now()
  snapshots.forEach((track, index) => recordListeningForTest(track, 10, timestamp + index))
  window.locatePlayer.currentTrack.value = snapshots[10]
  await switchView('recent')
  await locateAndCheck()
  await switchView('allSongs')
  expect(!shown(locate()), 'pure local library must still exclude a non-library song')
  window.locatePlayer.currentTrack.value = library[700]
  await scroll(0)
  expect(errors.length === 0, errors.join(';'))
  return 'LOCATE_PLAYING_OK'
}

window.locateAppearance = async (theme) => {
  document.documentElement.dataset.theme = theme
  await document.fonts.ready
  await scroll(900)
  await waitFor(
    () => shown(locate()) && shown(topButton()),
    'controls missing after resize/theme change'
  )
  const rect = locate().getBoundingClientRect()
  expect(rect.left >= 0 && rect.right <= innerWidth, 'locate leaves window bounds')
  expect(
    document.elementFromPoint(rect.left + 20, rect.top + 20)?.closest('button') === locate(),
    'locate is not clickable'
  )
  expect(rect.top > topButton().getBoundingClientRect().bottom, 'controls overlap after resize')
}
window.disposeLocateChecks = async () => {
  app.unmount()
  await settle()
  expect(!locate(), 'unmount leaked a locate button')
  stopButtons()
  expect(!document.querySelector('.te-scroll-top'), 'scroll controls leaked after shutdown')
}

window.runAggregateLocateChecks = async () => {
  const online = library.slice(0, 600).map((track, index) => ({
    ...track,
    id: 'ncm:aggregate-' + index,
    source: 'ncm',
    ncmSongId: index + 1
  }))
  music.playlists.value = [
    {
      id: 'aggregate-locator',
      name: 'Aggregate locator',
      kind: 'aggregate',
      trackIds: [...online.map((track) => track.id), library[999].id],
      trackSnapshots: Object.fromEntries(online.map((track) => [track.id, track])),
      createdAt: ''
    }
  ]
  window.locatePlayer.currentTrack.value = online[400]
  const stop = installScrollToTopButton()
  const aggregateApp = createApp({
    render: () =>
      h(AggregatePlaylistPage, {
        hasPlayer: true,
        initialPlaylistId: 'aggregate-locator'
      })
  })
  aggregateApp.config.errorHandler = (error) => errors.push(String(error))
  aggregateApp.mount('#app')
  await pause(500)
  const root = document.querySelector('.aggregate-table-wrapper')
  const row = () => document.querySelector('.aggregate-row.is-playing')
  const scrollAggregate = async (top) => {
    root.scrollTop = top
    root.dispatchEvent(new Event('scroll'))
    await settle()
  }
  await waitFor(() => shown(locate()), 'aggregate offscreen online song has no locator')
  expect(!row(), 'aggregate target should initially be virtualized')
  const playbackState = () =>
    JSON.stringify({
      track: window.locatePlayer.currentTrack.value,
      queue: window.locatePlayer.queue,
      playing: window.locatePlayer.isPlaying.value,
      time: window.locatePlayer.currentTime.value
    })
  const state = playbackState()
  locate().click()
  await pause(250)
  expect(row() && !shown(locate()), 'aggregate locator did not reveal the online song')
  const rect = row().getBoundingClientRect()
  const bounds = root.getBoundingClientRect()
  const bottom = Math.min(
    bounds.top + root.clientTop + root.clientHeight,
    document.querySelector('.player-bar-shell').getBoundingClientRect().top
  )
  expect(
    Math.abs((rect.top + rect.bottom) / 2 - (bounds.top + root.clientTop + bottom) / 2) < 5,
    'aggregate virtual row is not centered: ' +
      JSON.stringify({ row: rect.toJSON(), root: bounds.toJSON() })
  )
  expect(
    document.querySelectorAll('.aggregate-row').length < 40,
    'aggregate locator defeated virtualization'
  )
  expect(playbackState() === state, 'aggregate locator changed playback')
  await scrollAggregate(root.scrollTop - 500)
  expect(shown(locate()), 'aggregate locator should return when target scrolls out')
  const search = document.querySelector('.aggregate-search input')
  search.value = 'Song 0001'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(!shown(locate()) && search.value === 'Song 0001', 'aggregate locator must respect search')
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  const source = [...document.querySelectorAll('.aggregate-source-chip')].find((chip) =>
    chip.textContent.includes('ncm')
  )
  source.click()
  await settle()
  expect(!shown(locate()), 'aggregate hidden source must not be locatable')
  source.click()
  await settle()
  expect(shown(locate()), 'restored aggregate source should become locatable')
  expect(errors.length === 0, errors.join(';'))
  aggregateApp.unmount()
  await settle()
  expect(!locate(), 'aggregate unmount leaked locator')
  stop()
  return 'AGGREGATE_LOCATE_OK'
}
