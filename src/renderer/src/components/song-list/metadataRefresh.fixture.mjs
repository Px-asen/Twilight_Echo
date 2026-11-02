import { createApp, h, nextTick, ref, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import TaskCenter from '@renderer/components/TaskCenter.vue'
import { coreSnapshot } from '@renderer/stores/coreTestFixtures.ts'
import { createInitialAppUpdateSnapshot } from '@renderer/../../shared/appUpdate.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = async () => {
  await nextTick()
  await new Promise(requestAnimationFrame)
}
const expect = (ok, message) => {
  if (!ok) throw Error(message)
}
const errors = []
async function wait(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await pause(30)
  }
  throw Error(message + ': ' + errors.join(';'))
}
const canvas = document.createElement('canvas')
canvas.width = canvas.height = 180
const paint = canvas.getContext('2d')
paint.fillStyle = '#143e52'
paint.fillRect(0, 0, 180, 180)
paint.fillStyle = '#dfac70'
paint.beginPath()
paint.arc(90, 90, 55, 0, Math.PI * 2)
paint.fill()
const cover = canvas.toDataURL()
const category = ref('allSongs')
const state = shallowRef(
  coreSnapshot({
    libraryRevision: 1,
    playlistsRevision: 1,
    versionsRevision: 1,
    statisticsRevision: 1,
    bookmarksRevision: 1,
    settingsRevision: 1,
    pluginsRevision: 1,
    entityMetadataRevision: 1,
    entityMetadataContentRevision: 1
  })
)
const listeners = new Set()
let delay = 0,
  completed = 1,
  artworkReads = 0
const publish = (patch) => {
  state.value = { ...state.value, ...patch, sequence: state.value.sequence + 1 }
  for (const listener of listeners) listener({ kind: 'state', snapshot: state.value })
}
const metadataStatus = () => ({
  state: 'enriching',
  completed,
  failed: 0,
  skipped: 0,
  total: 600,
  queued: 600 - completed,
  active: 1,
  error: ''
})
window.api = {
  data: { getCover: async () => cover },
  providers: { list: async () => [] },
  app: {
    getUpdateState: async () => createInitialAppUpdateSnapshot(),
    onUpdateState: () => () => {}
  }
}
window.refreshSettings = {
  settings: shallowRef({
    musicIdentification: { language: 'zh-Hans' },
    libraryFolders: [],
    genreSeparators: ';',
    trackActivationMode: 'doubleClick'
  })
}
window.refreshPlayer = {
  currentTrack: ref(null),
  isPlaying: ref(false),
  playTrack() {
    throw Error('Unexpected playback')
  },
  setPlayMode() {
    throw Error('Unexpected playback mode change')
  },
  playNextTrack() {
    throw Error('Unexpected track skip')
  },
  appendQueueTracks() {
    throw Error('Unexpected queue change')
  }
}
window.refreshCore = {
  state,
  attach: async () => state.value,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  command: async () => {
    throw Error('Unexpected write')
  },
  query: async (name, q = {}) => {
    if (name === 'library.metadata')
      return { revision: state.value.libraryRevision, trackCount: 600, folders: [], exclusions: [] }
    if (name === 'playlists.state')
      return { revision: 1, persistence: { state: 'idle', dirty: false } }
    if (['playlists.catalog', 'statistics.tracks', 'bookmarks.page'].includes(name))
      return { revision: 1, offset: 0, total: 0, items: [] }
    if (name === 'statistics.overview')
      return {
        revision: 1,
        days: {},
        artists: [],
        history: { mode: 'sqlite', ready: true, pending: false, revision: 1, error: null },
        persistence: { dirty: false, error: null }
      }
    if (name === 'bookmarks.state') return { revision: 1, longTrackResumeSeconds: 1200 }
    if (name === 'providers.list') return []
    if (name === 'tags.list')
      return {
        token: {
          tagsRevision: 0,
          catalogRevision: 0,
          contentRevision: state.value.libraryRevision,
          linkRevision: 0
        },
        offset: 0,
        total: 0,
        items: []
      }
    if (name === 'metadata.status') return metadataStatus()
    if (name === 'metadata.entity.tasks')
      return {
        offset: 0,
        total: 0,
        counts: {
          queued: 0,
          running: 0,
          retry_wait: 0,
          needs_review: 0,
          blocked: 0,
          failed: 0,
          completed: 0,
          cancelled: 0
        },
        items: []
      }
    if (name === 'library.tracks') {
      const revision = state.value.libraryRevision,
        offset = q.offset ?? 0
      await pause(delay)
      return {
        revision,
        offset,
        total: 600,
        totalDuration: 108000,
        versions: {},
        tracks: Array.from({ length: Math.min(200, 600 - offset) }, (_, i) => ({
          id: 'song-' + (offset + i),
          title: 'Song ' + String(offset + i).padStart(3, '0'),
          artist: 'Artist',
          album: 'Enriched album ' + revision,
          source: 'local',
          duration: 180
        }))
      }
    }
    if (name === 'library.collections') {
      const revision = state.value.libraryRevision,
        offset = q.query.offset ?? 0
      await pause(delay)
      return {
        revision,
        offset,
        total: 600,
        letterOffsets: { A: 0 },
        items: Array.from({ length: Math.min(200, 600 - offset) }, (_, i) => ({
          id: 'album-' + (offset + i),
          name: 'Album ' + String(offset + i).padStart(3, '0'),
          artist: 'Artist',
          trackCount: revision,
          duration: 180,
          cover
        }))
      }
    }
    if (name === 'library.artwork') {
      artworkReads++
      const revision = state.value.libraryRevision
      await pause(delay)
      return { revision, items: q.ids.map((id) => ({ id, cover: 'cover://' + id + '.jpg' })) }
    }
    throw Error('Unexpected query ' + name)
  }
}
const app = createApp({
  render: () => [
    h(SongList, {
      category: category.value,
      filter: null,
      hasPlayer: false,
      transitionName: 'page-up'
    }),
    h('aside', { class: 'task-panel' }, [h(TaskCenter, { active: true })])
  ]
})
app.use(createPinia())
app.config.errorHandler = (error) => errors.push(error.stack || String(error))
app.mount('#app')
const rows = () => [...document.querySelectorAll('.track-row:not(.track-row-pending)')]
const images = () => rows().map((row) => row.querySelector('img.cover-img'))
const cards = () => [...document.querySelectorAll('.album-card')]
const container = () => document.querySelector('.song-list')
const loaded = () =>
  rows().length > 0 &&
  images().every(
    (img) => img?.complete && img.naturalWidth > 0 && !img.classList.contains('default-track-cover')
  )
window.checkMetadataRefresh = async () => {
  delay = 0
  category.value = 'allSongs'
  publish({})
  await wait(loaded, 'Initial rows or covers did not load')
  container().scrollTop = 9600
  container().dispatchEvent(new Event('scroll'))
  await wait(
    () => loaded() && rows()[0].textContent.includes('Song 1'),
    'Deep table window did not load'
  )
  await pause(100)
  const originalRows = rows(),
    originalImages = images(),
    top = rows()[1].getBoundingClientRect().top
  originalRows[1].focus({ preventScroll: true })
  const task = document.querySelector('progress[aria-label="曲目信息补全"]')
  expect(task, 'Enrichment progress is missing')
  const before = artworkReads
  for (let i = 0; i < 4; i++) {
    completed++
    publish({})
    await frame()
  }
  expect(artworkReads === before, 'Progress-only updates reloaded artwork')
  delay = 180
  for (let i = 0; i < 4; i++) {
    completed++
    publish({ libraryRevision: state.value.libraryRevision + 1 })
    for (let f = 0; f < 5; f++) {
      await frame()
      expect(
        rows().length === originalRows.length && rows().every((row, j) => row === originalRows[j]),
        'Metadata enrichment removed or remounted visible rows'
      )
      expect(
        !document.querySelector('.track-row-pending'),
        'Metadata enrichment flashed row skeletons'
      )
      expect(
        images().every(
          (img, j) =>
            img === originalImages[j] &&
            img.complete &&
            img.naturalWidth > 0 &&
            !img.classList.contains('default-track-cover')
        ),
        'Metadata enrichment blanked loaded artwork'
      )
      expect(document.activeElement === originalRows[1], 'Metadata enrichment lost keyboard focus')
      expect(
        Math.abs(originalRows[1].getBoundingClientRect().top - top) < 0.5,
        'Metadata enrichment moved the visible scroll anchor'
      )
      expect(
        document.querySelector('progress[aria-label="曲目信息补全"]') === task &&
          Math.abs(task.value - completed / 600) < 0.001,
        'Enrichment progress stopped updating in place'
      )
    }
  }
  await wait(
    () =>
      rows().every((row) =>
        row
          .querySelector('.col-album')
          ?.textContent.includes('Enriched album ' + state.value.libraryRevision)
      ),
    'Latest metadata never reached visible rows'
  )
  delay = 0
  category.value = 'albums'
  await wait(
    () => cards().length > 0 && cards().every((card) => card.querySelector('img')?.complete),
    'Album cards did not load'
  )
  await pause(100)
  const originalCards = cards(),
    originalCovers = cards().map((card) => card.querySelector('img'))
  delay = 180
  completed++
  publish({ libraryRevision: state.value.libraryRevision + 1 })
  for (let i = 0; i < 6; i++) {
    await frame()
    expect(
      cards().length === originalCards.length &&
        cards().every((card, j) => card === originalCards[j]),
      'Metadata enrichment blanked collection cards'
    )
    expect(
      cards().every((card, j) => card.querySelector('img') === originalCovers[j]),
      'Metadata enrichment remounted album artwork'
    )
  }
  await wait(
    () =>
      cards().every((card) =>
        card
          .querySelector('.local-album-meta')
          ?.textContent.includes(state.value.libraryRevision + ' 首')
      ),
    'Latest collection metadata never arrived'
  )
  expect(errors.length === 0, errors.join(';'))
}
