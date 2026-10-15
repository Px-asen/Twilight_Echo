import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import ApplicationPlaylistsPage from '@renderer/components/navigation/ApplicationPlaylistsPage.vue'
import RecentPlaybackPage from '@renderer/components/navigation/RecentPlaybackPage.vue'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import {
  useListeningStatsStore,
  waitForListeningStatsReady
} from '@renderer/stores/useListeningStatsStore.ts'
import '@renderer/assets/main.css'

// Match AlbumPage.behavior.test.ts: use the production music store, Vue pages
// and generated stylesheet, replacing only the external playback/IPC boundary.
window.api = {
  data: {
    loadPlaybackBookmarks: async () => null,
    savePlaylists: async () => undefined,
    loadPlaylists: async () => [],
    saveMusicLibrary: async () => undefined
  },
  providers: { list: async () => [] }
}
window.libraryPlayer = {
  currentTrack: ref(null),
  isPlaying: ref(false),
  plays: [],
  queued: [],
  mode: 'order',
  playTrack(track, queue) {
    this.plays.push({ id: track.id, ids: queue.map((entry) => entry.id) })
  },
  setPlayMode(mode) {
    window.libraryPlayer.mode = mode
  },
  playNextTrack() {
    // The playback boundary does not execute transport in a layout fixture.
  },
  appendQueueTracks(tracks) {
    window.libraryPlayer.queued.push(tracks.map((track) => track.id))
  }
}
// SongList destructures these methods just as the real player store exports them.
window.libraryPlayer.playTrack = window.libraryPlayer.playTrack.bind(window.libraryPlayer)
window.libraryPlayer.appendQueueTracks = window.libraryPlayer.appendQueueTracks.bind(
  window.libraryPlayer
)

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const frame = () => new Promise((done) => requestAnimationFrame(done))
const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}
const vueErrors = []
const music = useMusicStore()
const category = ref('allSongs')
const filter = ref(null)
const recent = ref(false)
const transition = ref('page-down')
let dataset = ''

const coverCanvas = document.createElement('canvas')
coverCanvas.width = coverCanvas.height = 64
const paint = coverCanvas.getContext('2d')
paint.fillStyle = '#7e91a8'
paint.fillRect(0, 0, 64, 64)
const cover = coverCanvas.toDataURL()
const denseTracks = Array.from({ length: 288 }, (_, index) => {
  const group = Math.floor(index / 8)
  return {
    id: 'layout-track-' + index,
    title:
      index === 1
        ? 'Needle Unique 一首名字很长的本地歌曲与远方传来的声音'
        : 'Track ' + String(index).padStart(3, '0'),
    artist:
      String.fromCharCode(65 + (group % 18)) + ' Artist ' + String(group % 18).padStart(2, '0'),
    album: String.fromCharCode(65 + (group % 26)) + ' Album ' + String(group).padStart(2, '0'),
    albumId: 'layout-album-' + group,
    genre: 'Genre ' + String(group % 12).padStart(2, '0'),
    filePath:
      'C:/LayoutFixture/Folder ' + String(group).padStart(2, '0') + '/track-' + index + '.flac',
    fileName: 'track-' + index + '.flac',
    duration: 140 + index,
    trackNumber: (index % 8) + 1,
    size: 1,
    source: 'local',
    format: 'flac',
    sampleRate: 44100,
    bitDepth: 16,
    cover: index % 3 ? cover : null,
    releaseDate: '2020-05-12',
    addedAt: 1_700_000_000_000 + index
  }
})
const sparseTracks = [
  denseTracks[0],
  {
    ...denseTracks[8],
    title: 'Track 008',
    artist: 'Artist 01',
    genre: 'Genre 01'
  }
]
const sixCollectionTracks = denseTracks.filter((_, index) => index % 8 === 0).slice(0, 6)

async function installData(sparse) {
  const key = sparse === 'six' ? 'six' : sparse ? 'sparse' : 'dense'
  if (dataset === key) return
  dataset = key
  const tracks = key === 'six' ? sixCollectionTracks : sparse ? sparseTracks : denseTracks
  music.tracks.value = tracks
  music.scannedFolders.value = []
  music.refreshLibraryIndex()
  music.playlists.value = [
    {
      id: 'pl_favorites',
      name: '我收藏的音乐',
      isDefault: true,
      trackIds: tracks.slice(0, 8).map((track) => track.id)
    },
    // Six visible playlist slots include Favorites, four user playlists and
    // the real create-playlist card rendered by SongList.
    ...Array.from({ length: key === 'six' ? 5 : sparse ? 1 : 24 }, (_, index) => ({
      id: 'layout-playlist-' + index,
      name: 'Playlist ' + String(index).padStart(2, '0'),
      trackIds: tracks.slice(0, 24).map((track) => track.id),
      createdAt: '2020-05-12T00:00:00.000Z'
    }))
  ]
  music.excludedTracks.value = [
    {
      filePath:
        'C:/LayoutFixture/Removed/' +
        'Long folder name for the exclusion layout/'.repeat(5) +
        'track.flac',
      title: '一首已移除的本地歌曲',
      artist: 'Artist',
      excludedAt: '2020-05-12T00:00:00.000Z'
    }
  ]
  await waitForListeningStatsReady()
  useListeningStatsStore().listeningStats.value = {
    days: {},
    tracks: Object.fromEntries(
      tracks.map((track, index) => [
        track.id,
        {
          seconds: 30,
          plays: 1,
          skips: 0,
          completions: 0,
          lastPlayed: 1_900_000_000_000 - index,
          title: track.title,
          artist: track.artist,
          cover: track.cover,
          sourceIds: [{ source: 'local', trackId: track.id }],
          track
        }
      ])
    )
  }
  await nextTick()
}

function navigate(nextCategory, nextFilter = null) {
  recent.value = false
  category.value = nextCategory
  filter.value = nextFilter
  transition.value = nextFilter ? 'page-down' : 'page-up'
}
function back() {
  navigate(category.value, null)
}

const app = createApp({
  setup: () => () =>
    h('div', { class: 'app-shell' }, [
      h(
        'div',
        { class: 'app-shell-title' },
        h('div', { id: 'fixture-titlebar' }, [
          h('button', { id: 'fixture-start' }, 'Window'),
          filter.value ? h('button', { id: 'fixture-back', onClick: back }, '返回') : null
        ])
      ),
      h(
        'div',
        { class: 'app-shell-content' },
        h('div', { class: 'main-content' }, [
          recent.value
            ? h(RecentPlaybackPage, { active: true, hasPlayer: true, onSelectView: navigate })
            : category.value === 'playlists'
              ? h(ApplicationPlaylistsPage, {
                  category: category.value,
                  filter: filter.value,
                  hasPlayer: true,
                  transitionName: transition.value,
                  returnFromDetail: back,
                  onSelectView: navigate
                })
              : h(SongList, {
                  category: category.value,
                  filter: filter.value,
                  hasPlayer: true,
                  transitionName: transition.value,
                  returnFromDetail: back,
                  onSelectView: navigate
                })
        ])
      ),
      h(
        'div',
        { class: 'app-shell-player' },
        h('div', { id: 'fixture-player', 'aria-hidden': 'true' })
      )
    ])
})
app.use(createPinia())
app.config.errorHandler = (error) => vueErrors.push(String(error))
document.documentElement.style.setProperty('--te-playbar-bottom-clearance', '102px')
document.documentElement.style.setProperty('--te-player-bar-height', '80px')
app.mount('#app')

const views = {
  songs: ['allSongs'],
  artists: ['artists'],
  albums: ['albums'],
  genres: ['genres'],
  folders: ['folders'],
  playlists: ['playlists'],
  recent: ['recent'],
  'artist-detail': ['artists', () => 'artist:' + music.artists.value[0].name],
  'album-detail': ['albums', () => 'album:' + music.albums.value[0].id],
  'genre-detail': ['genres', () => 'genre:' + music.genres.value[0].name],
  'folder-detail': ['folders', () => 'folder:' + music.folders.value[0].path],
  favorites: ['playlists', () => 'playlist:我收藏的音乐'],
  'playlist-detail': ['playlists', () => 'playlist:Playlist 00']
}
window.libraryLayoutViews = Object.keys(views)

async function settle() {
  await nextTick()
  await document.fonts.ready
  for (let attempt = 0; attempt < 45; attempt++) {
    await frame()
    const root = document.querySelector('.song-list')
    if (
      root &&
      !root.classList.contains('is-switching') &&
      root.querySelector('.grid-view,.table-view')
    ) {
      await frame()
      return
    }
    await pause(12)
  }
  throw new Error('actual SongList remained blank or in a transition')
}

const rect = (element) => element.getBoundingClientRect()
const round = (value) => Math.round(value * 10) / 10
const shown = (element) => {
  const style = getComputedStyle(element)
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    rect(element).width > 0 &&
    rect(element).height > 0
  )
}
const cardSelector = '.card-grid > [role="button"],.card-grid > button'
const contentItems = () =>
  [...document.querySelectorAll('.track-row,' + cardSelector)].filter(shown)
const safeViewport = () => {
  const scroller = document.querySelector('.song-list')
  const bounds = rect(scroller)
  return {
    left: bounds.left,
    right: bounds.right,
    top: Math.max(bounds.top, rect(document.querySelector('#fixture-titlebar')).bottom),
    bottom: Math.min(bounds.bottom, innerHeight - 102)
  }
}
const fullInView = (element, safe = safeViewport()) => {
  const bounds = rect(element)
  return (
    bounds.left >= safe.left - 1 &&
    bounds.right <= safe.right + 1 &&
    bounds.top >= safe.top - 1 &&
    bounds.bottom <= safe.bottom + 1
  )
}
const nameOf = (element) =>
  element.getAttribute('aria-label') ||
  element.textContent.trim() ||
  element.getAttribute('title') ||
  element.getAttribute('placeholder')

function expectedItemCount(name) {
  if (name === 'songs') return music.tracks.value.length
  if (name === 'recent') return Math.min(100, music.tracks.value.length)
  if (name === 'favorites') return music.playlists.value[0].trackIds.length
  if (name === 'playlist-detail') return music.playlists.value[1].trackIds.length
  const source = name.startsWith('artist')
    ? music.artists.value
    : name.startsWith('album')
      ? music.albums.value
      : name.startsWith('genre')
        ? music.genres.value
        : name.startsWith('folder')
          ? music.folders.value
          : music.localPlaylists.value
  return name.endsWith('-detail') ? source[0].tracks.length : source.length
}

function expectedLastCardName(name) {
  const source =
    name === 'artists'
      ? music.artists.value
      : name === 'albums'
        ? music.albums.value
        : name === 'genres'
          ? music.genres.value
          : name === 'folders'
            ? music.folders.value
            : music.localPlaylists.value
  return source.at(-1)?.name
}
function hitTest(element) {
  const bounds = rect(element)
  const hit = document.elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2
  )
  return hit === element || element.contains(hit)
}

function largestUnusedHeaderGap(heading, first) {
  if (!heading || !first) return 0
  const start = rect(heading).bottom
  const end = rect(first).top
  const intervals = [
    ...document.querySelectorAll(
      '.song-list-header h2,.song-list-header .view-stats,.song-list-header .repair-status,.song-list-header .library-repair-status,.song-list-header button,.song-list-header input:not([type="checkbox"]),.song-list-header select,.library-play-actions button,.playlist-order-notice,.track-table thead'
    )
  ]
    .filter(shown)
    .map((element) => ({
      top: Math.max(start, rect(element).top),
      bottom: Math.min(end, rect(element).bottom)
    }))
    .filter((interval) => interval.bottom > interval.top)
    .sort((left, right) => left.top - right.top)
  let cursor = start
  let largest = 0
  for (const interval of intervals) {
    largest = Math.max(largest, interval.top - cursor)
    cursor = Math.max(cursor, interval.bottom)
  }
  return Math.max(largest, end - cursor)
}

function collectionGridGeometry() {
  const grid = document.querySelector('.card-grid')
  if (!grid) return null
  const style = getComputedStyle(grid)
  const number = (value) => Number.parseFloat(value) || 0
  const availableWidth = grid.clientWidth - number(style.paddingLeft) - number(style.paddingRight)
  const left = rect(grid).left + number(style.borderLeftWidth) + number(style.paddingLeft)
  const cards = [...grid.querySelectorAll(':scope > [role="button"],:scope > button')].filter(shown)
  const grouped = []
  for (const card of cards) {
    const bounds = rect(card)
    const row = grouped.find((candidate) => Math.abs(candidate.top - bounds.top) < 1)
    if (row) row.cards.push(bounds)
    else grouped.push({ top: bounds.top, cards: [bounds] })
  }
  grouped.sort((first, second) => first.top - second.top)
  const columns = Math.max(0, ...grouped.map((row) => row.cards.length))
  const widths = cards.map((card) => rect(card).width)
  return {
    availableWidth: round(availableWidth),
    columns,
    cardWidthMin: widths.length ? round(Math.min(...widths)) : null,
    cardWidthMax: widths.length ? round(Math.max(...widths)) : null,
    rows: grouped.map((row, index) => {
      const ordered = [...row.cards].sort((first, second) => first.left - second.left)
      const first = ordered[0].left
      const last = ordered.at(-1).right
      return {
        top: round(row.top),
        count: row.cards.length,
        // The final rendered row may be a natural partial row or the edge of a
        // virtual window. It is measured, but is not used as a fill requirement.
        complete: index < grouped.length - 1 && row.cards.length === columns,
        span: round(last - first),
        spanRatio: (last - first) / availableWidth,
        cardCoverageRatio: row.cards.reduce((sum, card) => sum + card.width, 0) / availableWidth,
        unusedRight: round(Math.max(0, left + availableWidth - last)),
        gaps: ordered.slice(1).map((card, cardIndex) => round(card.left - ordered[cardIndex].right))
      }
    })
  }
}

async function showView(profile, name, sparse) {
  await installData(sparse)
  document.documentElement.dataset.theme = profile.tone || 'pureWhite'
  document.documentElement.style.setProperty('--te-font-size-body', profile.font + 'px')
  const [nextCategory, detail] = views[name]
  navigate(nextCategory, detail ? detail() : null)
  recent.value = name === 'recent'
  await settle()
  const scroller = document.querySelector('.song-list')
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event('scroll'))
  await frame()
  await frame()
  expect(!vueErrors.length, 'Vue error: ' + vueErrors.join('; '))
}

function controlIssues(root, onlyFirstScreen = true) {
  const errors = []
  const safe = safeViewport()
  for (const control of root.querySelectorAll(
    'button,input:not([type="file"]):not([type="checkbox"]),select,[role="button"]'
  )) {
    if (!shown(control) || control.disabled) continue
    const bounds = rect(control)
    if (onlyFirstScreen && (bounds.bottom <= safe.top || bounds.top >= safe.bottom)) continue
    const label = nameOf(control) || control.className || control.tagName
    if (!nameOf(control)) errors.push('control has no accessible name: ' + label)
    if (bounds.left < safe.left - 1 || bounds.right > safe.right + 1)
      errors.push('control clipped horizontally: ' + label)
    if (bounds.top >= safe.top && bounds.bottom <= safe.bottom && !hitTest(control))
      errors.push('control covered at its click target: ' + label)
    if (control.tabIndex < 0) errors.push('control cannot receive keyboard focus: ' + label)
  }
  return errors
}

window.inspectLibraryLayout = async (profile, name, sparse = false, collectionCount = null) => {
  await showView(profile, name, collectionCount === 6 ? 'six' : sparse)
  const errors = []
  const scroller = document.querySelector('.song-list')
  const safe = safeViewport()
  const items = contentItems()
  const rows = [...document.querySelectorAll('.track-row')]
  const heading = document.querySelector('.song-list-title,#local-album-title')
  const header = document.querySelector('.song-list-header')
  const first = items[0]
  const isTable = !!document.querySelector('.track-table')
  const visible = items.filter((item) => fullInView(item, safe))
  const expectedRows =
    name === 'album-detail' || profile.font >= 24 ? 1 : profile.font >= 20 ? 2 : 3
  if (!first) errors.push('fixture records never reached the actual page')
  if (isTable && visible.length < Math.min(sparse ? 2 : expectedRows, rows.length)) {
    errors.push(
      'first screen has ' +
        visible.length +
        ' complete rows; needs ' +
        Math.min(sparse ? 2 : expectedRows, rows.length)
    )
  }
  if (!isTable && first) {
    const visibleHeight =
      Math.min(rect(first).bottom, safe.bottom) - Math.max(rect(first).top, safe.top)
    if (visibleHeight < Math.min(96, rect(first).height))
      errors.push('first screen has too little collection content to recognize an item')
  }
  if (header && !fullInView(header, safe))
    errors.push('primary page controls extend below the first screen')
  if (first && heading && name !== 'album-detail') {
    const gap = largestUnusedHeaderGap(heading, first)
    // Large user text can require more toolbar rows. Fail wasted empty gaps,
    // not the space occupied by readable controls; first-screen row counts
    // above remain the independent overall header/content budget.
    if (gap > Math.max(40, profile.font * 2))
      errors.push('unused vertical gap before first content is excessive: ' + round(gap) + 'px')
    if (rect(heading).top - safe.top > Math.max(80, profile.font * 3))
      errors.push('title starts too far below usable page top')
  }
  const content = document.querySelector('.track-table-wrapper,.card-grid')
  const start =
    document.querySelector('.detail-back-button') || (name !== 'album-detail' ? heading : null)
  if (content && start && Math.abs(rect(start).left - rect(content).left) > 8)
    errors.push(
      'page title/back and content columns differ by ' +
        round(rect(start).left - rect(content).left) +
        'px'
    )
  const playActions = document.querySelector('.library-play-actions')
  if (document.querySelectorAll('.song-list-header .library-play-actions').length > 1)
    errors.push('page header repeats the same playback actions')
  if (playActions && content && Math.abs(rect(playActions).left - rect(content).left) > 8)
    errors.push('play actions and content columns do not align')
  for (const element of document.querySelectorAll(
    '.song-list,.song-list-header,.header-right,.library-play-actions,.collection-view-controls,.collection-grid-layout,.card-grid,.track-table-wrapper,.track-table,.selection-toolbar,.selection-actions,.album-detail-header,.playlist-lifecycle-actions'
  )) {
    if (!shown(element)) continue
    // scrollWidth also includes ambient ::before paint outside the box. Require
    // an actual child box to overflow before treating that as lost UI content.
    const bounds = rect(element)
    const childOverflow = [...element.children].some(
      (child) =>
        shown(child) && (rect(child).left < bounds.left - 2 || rect(child).right > bounds.right + 2)
    )
    if (element.scrollWidth > element.clientWidth + 2 && childOverflow)
      errors.push(
        'horizontal layout overflow inside ' +
          element.className +
          ': ' +
          (element.scrollWidth - element.clientWidth) +
          'px'
      )
  }
  for (const element of scroller.querySelectorAll(
    '.track-table-wrapper,.table-view,.grid-view,.card-grid'
  )) {
    if (
      /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
      element.scrollHeight > element.clientHeight + 2
    )
      errors.push('nested vertical scroll area traps library content: ' + element.className)
  }
  errors.push(...controlIssues(scroller))
  if (rows.length) {
    const firstRow = rect(rows[0])
    if (firstRow.height > profile.font * 6)
      errors.push('track row stretched beyond a two-line content budget')
    for (const column of ['col-info', 'col-album', 'col-duration']) {
      const titleCell = document.querySelector('thead .' + column)
      const dataCell = rows[0].querySelector('.' + column)
      if (titleCell && dataCell && Math.abs(rect(titleCell).left - rect(dataCell).left) > 2)
        errors.push(column + ' heading no longer aligns to its data')
    }
    const text = rows[0].querySelector('.track-title')
    if (text && Number.parseFloat(getComputedStyle(text).fontSize) + 0.1 < profile.font)
      errors.push('user text size did not reach the actual track title')
    if (rows.length > 1) {
      const actualStride = rect(rows[1]).top - firstRow.top
      const logicalStride =
        rect(document.querySelector('.track-table tbody')).height / expectedItemCount(name)
      if (Math.abs(actualStride - logicalStride) > 1)
        errors.push(
          'virtual scroll extent disagrees with actual adjacent row spacing: ' +
            round(logicalStride) +
            ' / ' +
            round(actualStride) +
            'px'
        )
    }
    if (
      text &&
      rect(text).height + rect(rows[0].querySelector('.track-artist')).height > firstRow.height + 2
    )
      errors.push('large text is clipped inside the track row')
  }
  if (sparse && first) {
    if (isTable && rect(first).height > profile.font * 6)
      errors.push('sparse tracks stretch to fill the window')
    if (!isTable && rect(first).height > rect(first).width + profile.font * 8 + 24)
      errors.push('sparse collection card stretches beyond artwork and metadata')
  }
  const grid = collectionGridGeometry()
  if (grid) {
    // These are the readable cover bounds shared by the normal, narrow and
    // compact presentations. Actual DOM geometry is checked independently of
    // the grid estimator and its column-count formula.
    if (grid.cardWidthMin < Math.min(128, grid.availableWidth) - 1)
      errors.push('collection cards are too narrow to identify their artwork and labels')
    const categoryTile = name === 'genres' || name === 'folders'
    if (grid.cardWidthMax > (categoryTile ? 361 : 241))
      errors.push('collection presentation exceeds its readable width budget')
    if (categoryTile && first) {
      const thumbnail = first.querySelector(
        '.artist-cover,.artist-cover-placeholder,.album-cover,.playlist-cover-placeholder'
      )
      if (thumbnail && rect(thumbnail).width > 61)
        errors.push('category tile artwork displaces its directory label')
    }
    // Dense complete rows should use the available horizontal space. Sparse
    // collections retain the cover ceiling and ordinary gaps; narrow grids may prioritize the
    // readable cover ceiling when no suitable column count can fill the row.
    if (!sparse && grid.availableWidth >= 400) {
      for (const row of grid.rows) {
        if (row.complete && row.spanRatio < 0.97)
          errors.push(
            'complete collection row leaves excessive unused width: ' +
              round(row.spanRatio * 100) +
              '% used'
          )
      }
    }
    if (collectionCount === 6) {
      const firstRow = grid.rows[0]
      const gap = categoryTile ? 16 : 24
      const minimum = categoryTile ? 240 : 200
      const maximum = categoryTile ? 360 : 240
      const count = Math.min(
        6,
        Math.max(1, Math.floor((grid.availableWidth + gap) / (minimum + gap)))
      )
      const expectedSpan = Math.min(grid.availableWidth, count * maximum + (count - 1) * gap)
      if (grid.cardWidthMin < minimum - 1)
        errors.push('desktop collections fall below readable presentation width')
      if (!firstRow || firstRow.count !== count)
        errors.push('collection row has an unexpected readable item count')
      if (firstRow && Math.abs(firstRow.span - expectedSpan) > 4)
        errors.push('collection row does not use its available width')
      if (firstRow?.gaps.some((actual) => Math.abs(actual - gap) > 1))
        errors.push('collection column gaps are inconsistent')
      grid.expectedSixCardSpan = round(expectedSpan)
    }
  }
  const artwork = document.querySelector('.album-detail-artwork')
  const identity = first?.querySelector('.local-album-name,.artist-name,.playlist-name')
  const metrics = {
    width: innerWidth,
    height: innerHeight,
    font: profile.font,
    firstTop: first ? round(rect(first).top) : null,
    firstRowTop: rows.length ? round(rect(rows[0]).top) : null,
    visibleItems: visible.length,
    visibleRowCount: visible.filter((item) => item.classList.contains('track-row')).length,
    contentWidth: content ? round(rect(content).width) : null,
    grid,
    albumArtworkWidth: artwork ? round(rect(artwork).width) : null,
    titleTop: heading ? round(rect(heading).top) : null,
    headerHeight: round(rect(header).height),
    headerToContent: first && heading ? round(rect(first).top - rect(heading).bottom) : null,
    largestUnusedHeaderGap:
      name !== 'album-detail' ? round(largestUnusedHeaderGap(heading, first)) : null,
    safeTop: round(safe.top),
    safeBottom: round(safe.bottom),
    firstHeight: first ? round(rect(first).height) : null,
    firstCardFullyVisible: !isTable && first ? fullInView(first, safe) : null,
    firstCardTitleVisible: identity ? fullInView(identity, safe) : null
  }
  const initiallyLastVisible = items.length && fullInView(items.at(-1))
  const limitations = []
  if (!isTable && first && !fullInView(first, safe))
    limitations.push(
      'the card continues below the first screen; readable text and artwork retain their natural size'
    )
  if (identity && !fullInView(identity)) {
    identity.scrollIntoView({ block: 'center' })
    await frame()
    await frame()
    if (!fullInView(identity))
      errors.push('the first collection name cannot be fully exposed above the player')
  }
  // Repeatedly follow the actual scroll extent: virtualization may replace its
  // spacers after the first scroll. A present-but-clipped last item fails too.
  for (let attempt = 0; attempt < 3; attempt++) {
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
    await frame()
    await frame()
  }
  const endItems = contentItems()
  const last = endItems.at(-1)
  if (!last || (!initiallyLastVisible && !fullInView(last)))
    errors.push('last actual item cannot be fully exposed above the player')
  if (
    isTable &&
    last &&
    Number.parseInt(last.querySelector('.col-index').textContent.trim(), 10) !==
      expectedItemCount(name)
  )
    errors.push('scrolling to the end never exposed the final fixture track')
  if (!isTable && last && !last.textContent.includes(expectedLastCardName(name)))
    errors.push('scrolling to the end never exposed the final fixture collection')
  metrics.lastBottom = last ? round(rect(last).bottom) : null
  metrics.scrollTop = round(scroller.scrollTop)
  return { errors: [...new Set(errors)], limitations, metrics }
}

async function nativeKey(key, modifiers = []) {
  await window.libraryNativeInput({ key, modifiers })
  await nextTick()
  await frame()
}
async function click(control, reveal = false) {
  expect(control && shown(control), 'missing visible control')
  if (reveal) {
    control.scrollIntoView({ block: 'center' })
    await frame()
    await frame()
  }
  expect(fullInView(control), 'control cannot be clicked without scrolling: ' + nameOf(control))
  expect(hitTest(control), 'control click target is covered: ' + nameOf(control))
  const bounds = rect(control)
  await window.libraryNativeInput({
    click: {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2)
    }
  })
  await nextTick()
  await frame()
}
async function tabTo(target, limit = 45) {
  for (let attempt = 0; attempt < limit; attempt++) {
    if (document.activeElement === target) return
    await nativeKey('Tab')
  }
  throw new Error('native Tab cannot reach ' + (nameOf(target) || target.className))
}
async function search(text) {
  const input = document.querySelector('.search-input')
  input.focus()
  input.select()
  await window.libraryNativeInput({ text })
  await pause(220)
  await settle()
}

async function checkDialog(selector, opener) {
  for (let attempt = 0; attempt < 45; attempt++) {
    const dialog = document.querySelector(selector)
    if (dialog && dialog.contains(document.activeElement)) break
    await frame()
  }
  const dialog = document.querySelector(selector)
  expect(dialog && dialog.contains(document.activeElement), selector + ' did not move focus inside')
  const bounds = rect(dialog)
  expect(
    bounds.left >= 8 &&
      bounds.right <= innerWidth - 8 &&
      bounds.top >= 8 &&
      bounds.bottom <= innerHeight - 8,
    selector + ' escapes the window'
  )
  expect(dialog.scrollWidth <= dialog.clientWidth + 2, selector + ' overflows horizontally')
  expect(
    document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent.trim(),
    selector + ' lost its accessible title'
  )
  for (let attempt = 0; attempt < 8; attempt++) {
    await nativeKey('Tab', attempt % 3 === 0 ? ['shift'] : [])
    expect(dialog.contains(document.activeElement), selector + ' lets Tab escape into the page')
  }
  for (const control of dialog.querySelectorAll('input,button,select')) {
    if (!shown(control) || control.disabled) continue
    expect(nameOf(control) || control.labels?.length, selector + ' contains an unnamed control')
    expect(hitTest(control), selector + ' contains a covered control')
  }
  await nativeKey('Escape')
  for (
    let attempt = 0;
    attempt < 45 && (document.querySelector(selector) || document.activeElement !== opener);
    attempt++
  )
    await frame()
  expect(!document.querySelector(selector), selector + ' did not close with Escape')
  expect(document.activeElement === opener, selector + ' did not return focus to its opener')
}

window.exerciseLibraryControls = async (profile) => {
  await showView(profile, 'songs', false)
  document.querySelector('#fixture-start').focus()
  await tabTo(document.querySelector('.search-input'))
  await search('Needle Unique')
  expect(
    document.querySelectorAll('.track-row').length === 1,
    'search did not narrow the real table'
  )
  expect(
    !controlIssues(document.querySelector('.song-list')).length,
    'filtered controls inaccessible: ' +
      controlIssues(document.querySelector('.song-list')).join('; ')
  )
  await click(document.querySelector('.search-clear'))
  await pause(220)
  await settle()
  await click(document.querySelector('.library-filter-trigger'))
  const panel = document.querySelector('.library-filter-panel')
  expect(panel, 'sort/filter panel did not open')
  const sort = panel.querySelector('select')
  sort.value = 'duration'
  sort.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  await frame()
  const direction = panel.querySelectorAll('select')[1]
  direction.value = 'desc'
  direction.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  await frame()
  await nativeKey('Escape')
  expect(
    document.querySelector('.track-row .track-title').textContent.includes('Track 287'),
    'sort did not change actual row order'
  )
  const first = document.querySelector('.track-row')
  document.querySelector('#fixture-start').focus()
  await tabTo(first)
  const plays = window.libraryPlayer.plays.length
  await nativeKey('Space')
  expect(first.getAttribute('aria-selected') === 'true', 'native Space did not select the track')
  expect(window.libraryPlayer.plays.length === plays, 'selection accidentally played a track')
  const second = document.querySelectorAll('.track-row')[1]
  second.focus()
  await nativeKey('Space')
  expect(second.getAttribute('aria-selected') === 'true', 'native Space did not extend selection')
  expect(window.libraryPlayer.plays.length === plays, 'multi-selection accidentally played a track')
  const selection = document.querySelector('.selection-toolbar')
  expect(selection, 'batch actions disappeared after selection')
  const queue = [...selection.querySelectorAll('button')].find((button) =>
    button.textContent.includes('添加到播放队列')
  )
  expect(queue, 'batch queue action is absent')
  await click(queue, true)
  expect(window.libraryPlayer.queued.at(-1)?.length === 2, 'batch queue action lost the selection')
  await nativeKey('Escape')
  expect(!document.querySelector('.selection-toolbar'), 'Escape did not clear selection')
  first.focus()
  await nativeKey('Enter')
  expect(
    window.libraryPlayer.plays.length === plays + 1,
    'native Enter did not play the focused row'
  )
  for (const name of ['artists', 'albums', 'genres', 'folders', 'playlists']) {
    await showView(profile, name, false)
    const card = [...document.querySelectorAll(cardSelector)].find(
      (element) => !element.classList.contains('create-playlist-card')
    )
    expect(
      card && rect(card).top < safeViewport().bottom - 60,
      name + ' first data card cannot be reached'
    )
    document.querySelector('#fixture-start').focus()
    await tabTo(card)
    await nativeKey(name === 'artists' ? 'Space' : 'Enter')
    await settle()
    expect(
      document.querySelector('.track-row'),
      name + ' keyboard activation did not open its tracks'
    )
    const backControl = document.querySelector('#fixture-back')
    expect(backControl, name + ' detail lost its shared titlebar return action')
    document.querySelector('#fixture-start').focus()
    await tabTo(backControl)
    await nativeKey('Enter')
    await settle()
    expect(document.querySelector('.card-grid'), name + ' return did not restore the collection')
  }
  await showView(profile, 'playlists', false)
  const createCard = document.querySelector('.library-create-button')
  document.querySelector('#fixture-start').focus()
  await tabTo(createCard)
  await nativeKey('Enter')
  await checkDialog('.create-playlist-dialog', createCard)
  await showView(profile, 'songs', false)
  const tools = document.querySelector('.library-tools-trigger')
  await click(tools)
  const removed = [...document.querySelectorAll('.library-tools-option')].find((button) =>
    button.textContent.includes('已移除')
  )
  expect(removed, 'removed-library management entry disappeared')
  await click(removed)
  await checkDialog('.excluded-tracks-dialog', tools)
  expect(!vueErrors.length, vueErrors.join('; '))
  return {
    errors: [],
    plays: window.libraryPlayer.plays.length,
    queueActions: window.libraryPlayer.queued.length
  }
}
window.libraryLayoutReady = installData(false).then(settle)
