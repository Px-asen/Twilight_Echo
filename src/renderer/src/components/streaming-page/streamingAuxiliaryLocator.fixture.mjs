import { createApp, h, nextTick, ref } from 'vue'
import StreamingSearch from '@renderer/components/StreamingSearch.vue'
import NcmCloudPanel from '@renderer/components/NcmCloudPanel.vue'
import { installScrollToTopButton } from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'

const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async () => {
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await pause()
}
const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const makeTrack = (id, title = id) => ({
  id,
  title,
  artist: '测试艺术家',
  album: '测试专辑',
  duration: 180,
  cover: null,
  source: 'ncm',
  ncmSongId: 1
})
const searchTracks = ref(Array.from({ length: 24 }, (_, index) => makeTrack('search-' + index)))
const currentSearch = ref(null)
const searchOffset = ref(0)
const cloudSongs = Array.from({ length: 24 }, (_, index) => ({
  cloudSongId: index,
  track: makeTrack('cloud-' + index),
  fileName: 'cloud-' + index + '.flac',
  addTime: 0
}))
const currentCloud = ref(null)
const showSearch = ref(true)
const showCloud = ref(true)
const searchEvents = []
const cloudEvents = []
const state = {
  searchTracks,
  currentSearch,
  searchOffset,
  cloudSongs,
  currentCloud,
  showSearch,
  showCloud,
  searchEvents,
  cloudEvents
}
const app = createApp({
  render: () =>
    h('div', [
      state.showSearch.value &&
        h('div', { id: 'search-region' }, [
          h(StreamingSearch, {
            searchType: 'songs',
            searchResults: searchTracks.value.slice(searchOffset.value, searchOffset.value + 30),
            searchPlaylistsResults: [],
            searchArtistsResults: [],
            searchTotal: searchTracks.value.length,
            searchOffset: searchOffset.value,
            searchLoading: false,
            searchError: '',
            currentTrack: currentSearch.value,
            trackActivationMode: 'singleClick',
            likingTracks: new Set(),
            isTrackLiked: () => false,
            formatTime: () => '3:00',
            selectedIds: new Set(['search-0']),
            hasSelection: true,
            selectedCount: 1,
            onSearchTrackClick: (...args) => searchEvents.push(['play', ...args]),
            onSearchTrackActivate: (track) => searchEvents.push(['play', track]),
            onPageChange: (event) => {
              searchEvents.push(['page', event])
              searchOffset.value = event.first
            },
            onBatchFavorite: () => searchEvents.push(['selection']),
            onClearSelection: () => searchEvents.push(['clearSelection'])
          })
        ]),
      state.showCloud.value &&
        h('div', { id: 'cloud-region' }, [
          h(NcmCloudPanel, {
            songs: cloudSongs,
            total: cloudSongs.length,
            loading: false,
            loadingMore: false,
            hasMore: false,
            error: '',
            selectedFiles: [],
            transferTasks: {},
            currentTrackId: currentCloud.value,
            onPlay: (song) => cloudEvents.push(['play', song]),
            onPlayAll: () => cloudEvents.push(['playAll']),
            onDownload: (song) => cloudEvents.push(['download', song])
          })
        ])
    ])
})
app.config.errorHandler = (error) => {
  window.auxError = error.stack || String(error)
}
const stopButtons = installScrollToTopButton()
app.mount('#app')
const locator = () => document.querySelector('.te-scroll-companion')
const shown = () => locator()?.dataset.teScrollTopVisible === 'true'
const shell = () => document.querySelector('#shell')
const searchRow = (id) =>
  [...document.querySelectorAll('.track-row')].find((row) => row.dataset.teTrackId === id)
const cloudRow = (id) =>
  [...document.querySelectorAll('.cloud-song')].find((row) => row.dataset.teTrackId === id)
const scroll = async (top) => {
  shell().scrollTop = top
  shell().dispatchEvent(new Event('scroll', { bubbles: true }))
  await settle()
}
const centerMatches = async (row) => {
  locator().click()
  await settle()
  const rect = row.getBoundingClientRect(),
    viewport = shell().getBoundingClientRect()
  const center = (Math.max(viewport.top, 0) + Math.min(viewport.bottom, innerHeight - 70)) / 2
  expect(
    Math.abs((rect.top + rect.bottom) / 2 - center) < 8,
    'locator did not center actual SFC row: ' +
      JSON.stringify({ row: rect.toJSON(), center, scrollTop: shell().scrollTop })
  )
  expect(!shown(), 'locator stayed visible after target entered viewport')
}
window.runAuxLocatorChecks = async () => {
  await settle()
  expect(!window.auxError, window.auxError)
  const button = locator()
  expect(button, 'two real component roots did not register shared locator')
  expect(
    document.querySelectorAll('.te-scroll-companion').length === 1,
    'components created duplicate locator buttons for one scroller'
  )
  expect(!shown(), 'no current ID should hide the action')

  // StreamingSearch: current row is mounted below the actual 600px scroll viewport.
  state.currentSearch.value = makeTrack('search-18')
  await settle()
  await scroll(0)
  expect(searchRow('search-18'), 'search target row was not rendered')
  expect(shown(), 'offscreen search row did not expose locator')
  const beforeSearch = JSON.stringify({
    events: state.searchEvents.length,
    selected: document.querySelector('.selection-count')?.textContent,
    offset: state.searchOffset.value,
    results: [...document.querySelectorAll('#search-region .track-row')].map(
      (row) => row.dataset.teTrackId
    )
  })
  await centerMatches(searchRow('search-18'))
  expect(
    JSON.stringify({
      events: state.searchEvents.length,
      selected: document.querySelector('.selection-count')?.textContent,
      offset: state.searchOffset.value,
      results: [...document.querySelectorAll('#search-region .track-row')].map(
        (row) => row.dataset.teTrackId
      )
    }) === beforeSearch,
    'locating triggered playback/selection or changed search results/page'
  )
  const searchDocTop = shell().scrollTop + searchRow('search-18').getBoundingClientRect().top
  await scroll(searchDocTop - (shell().clientHeight - 8))
  const partial = searchRow('search-18').getBoundingClientRect()
  expect(
    partial.top < shell().getBoundingClientRect().bottom &&
      partial.bottom > shell().getBoundingClientRect().bottom,
    'partial-visibility fixture did not clip the search row'
  )
  expect(!shown(), 'partly visible search row should hide the locator')

  // A changed query/result set and pagination remove the candidate naturally.
  state.searchTracks.value = state.searchTracks.value.filter((track) => track.id !== 'search-18')
  await settle()
  await scroll(0)
  expect(!shown(), 'filtered search target remained locatable')
  state.searchTracks.value = Array.from({ length: 24 }, (_, index) => makeTrack('search-' + index))
  await settle()
  state.currentSearch.value = makeTrack('search-22')
  await settle()
  await scroll(0)
  expect(shown(), 'restored search result was not dynamically registered')
  state.searchTracks.value = Array.from({ length: 36 }, (_, index) => makeTrack('search-' + index))
  await settle()
  const next = [...document.querySelectorAll('.pager-btn')].find((element) =>
    element.textContent.includes('下一页')
  )
  expect(next && !next.disabled, 'real search paginator did not render')
  state.currentSearch.value = makeTrack('search-35')
  await settle()
  await scroll(0)
  expect(!shown(), 'target on another page should stay hidden')
  next.click()
  await settle()
  expect(searchRow('search-35'), 'next-page fixture did not replace result rows')
  expect(!shown(), 'visible target on the selected page should not expose locator')
  expect(
    state.searchEvents.length === 1 && state.searchEvents[0][0] === 'page',
    'page button did not preserve the normal paginator event'
  )

  // NcmCloudPanel: the cloud rows share the same ancestor and shared action.
  state.currentSearch.value = null
  state.currentCloud.value = 'cloud-18'
  await settle()
  await scroll(0)
  const cloud = cloudRow('cloud-18')
  expect(cloud, 'cloud target row was not rendered')
  expect(shown(), 'offscreen cloud row did not expose locator')
  const companion = locator()
  expect(companion === button, 'locator DOM node was replaced during root update')
  const cloudBefore = state.cloudEvents.length
  await centerMatches(cloud)
  expect(state.cloudEvents.length === cloudBefore, 'cloud locator invoked the row playback action')

  // Removing one component must keep the shared group alive for the other root.
  state.currentCloud.value = null
  state.searchOffset.value = 0
  state.currentSearch.value = makeTrack('search-0')
  await settle()
  await scroll(500)
  expect(shown(), 'remaining search root did not retain its locator registration')
  state.showCloud.value = false
  await settle()
  expect(locator() === button && shown(), 'unmounting cloud root removed the search root action')
  state.showSearch.value = false
  await settle()
  expect(!locator(), 'last root unmount leaked shared locator control')
  app.unmount()
  await settle()
  expect(!locator(), 'unmount leaked shared locator control')
  stopButtons()
  expect(!document.querySelector('.te-scroll-top'), 'scroll-to-top fixture leaked controls')
  expect(!window.auxError, window.auxError)
  return 'AUX_LOCATOR_OK'
}
