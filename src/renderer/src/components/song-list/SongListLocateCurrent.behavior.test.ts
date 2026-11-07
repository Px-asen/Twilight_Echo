import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test(
  'the song table locates the currently playing row through the shared scroll control',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-song-locate-ui-'))
    try {
      await writeFile(join(directory, 'entry.mjs'), runtime)
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'song-list-player-boundary',
            enforce: 'pre',
            resolveId(source) {
              if (/\/stores\/usePlayerStore(?:\.ts)?$/.test(source)) return '\0song-list-player'
              return null
            },
            load(id) {
              return id === '\0song-list-player'
                ? 'export const usePlayerStore = () => window.songListPlayer'
                : null
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js'),
            pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: join(directory, 'entry.mjs'),
            name: 'SongListLocateCurrentTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((name) => name.endsWith('.css'))
          .map((name) => `<link rel="stylesheet" href="bundle/${name}">`)
          .join(
            ''
          )}<style>body{margin:0;font-family:system-ui}#app{height:100vh}</style></head><body><div id="app"></div><script src="bundle/${files.find((name) => name.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /SONG_LIST_LOCATE_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runtime = `
import {createApp,h,nextTick,ref} from 'vue'
import {createPinia,setActivePinia} from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import {useMusicStore} from '@renderer/stores/useMusicStore.ts'
import {installMusicCoreFixture} from '@renderer/components/musicCore.fixture.mjs'
import {installScrollToTopButton} from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'

window.songListReady = (async () => {
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const expect = (condition, message) => { if (!condition) throw new Error(message) }

window.api = {
  library: { getStorageMode: async () => 'json', onChanged: () => () => {} },
  data: { loadPlaybackBookmarks: async () => null },
  providers: { list: async () => [] }
}
const currentTrack = ref(null)
window.songListPlayer = {
  currentTrack,
  queue: ref([]),
  isPlaying: ref(false),
  mode: 'order',
  playTrack() {},
  playTrackFromPosition() {},
  playNextTrack() {},
  setPlayMode() {},
  appendQueueTracks() {}
}

const pinia = createPinia()
setActivePinia(pinia)
const tracks = Array.from({ length: 6_000 }, (_, index) => ({
  id: 'locate-track-' + index,
  title: 'Locate track ' + index,
  artist: 'Test artist',
  album: 'Test album',
  albumId: 'test-album',
  filePath: 'C:/Music/' + index + '.flac',
  fileName: index + '.flac',
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  format: 'FLAC',
  sampleRate: 44_100,
  bitDepth: 24,
  source: 'local'
}))
await installMusicCoreFixture({ revision: 1, authoritative: [], localTracks: tracks })
await useMusicStore().loadPlaylists()
const targetIndex = 4_200
currentTrack.value = tracks[targetIndex]

const errors = []
const app = createApp({
  setup: () => () => h(SongList, {
    category: 'allSongs',
    filter: null,
    hasPlayer: false,
    transitionName: 'page-up',
    onSelectView: () => {},
    returnFromDetail: () => {}
  })
})
app.use(pinia)
app.config.errorHandler = (error) => errors.push(String(error))
app.mount('#app')
const stopScrollControls = installScrollToTopButton()

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await nextTick()
    await pause(20)
    if (predicate()) return
  }
  throw new Error(message)
}

window.songListLocateTest = async () => {
  await waitFor(
    () => document.querySelector('.song-list') && document.querySelector('.te-scroll-companion'),
    'the table did not register the shared locate action'
  )
  const container = document.querySelector('.song-list')
  const initialScrollTop = 1_200
  container.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
  container.scrollTop = initialScrollTop
  container.dispatchEvent(new Event('scroll'))
  await waitFor(
    () => document.querySelector('.te-scroll-companion')?.dataset.teScrollTopVisible === 'true',
    'the shared locate control did not appear'
  )

  const before = JSON.stringify({ track: currentTrack.value, queue: window.songListPlayer.queue.value })
  document.querySelector('.te-scroll-companion').click()
  await waitFor(
    () =>
      Array.from(document.querySelectorAll('.track-row')).some((element) =>
        element.textContent.includes('Locate track ' + targetIndex)
      ),
    'the locate click did not mount the current track row'
  )
  await waitFor(
    () => {
      const current = document.querySelector('.track-playing')?.getBoundingClientRect()
      const viewport = container.getBoundingClientRect()
      return document.querySelector('.te-scroll-companion')?.dataset.teScrollTopVisible === 'false' &&
        current && current.top >= viewport.top && current.bottom <= viewport.bottom
    },
    'the locate control did not hide after revealing the row'
  )
  expect(
    JSON.stringify({ track: currentTrack.value, queue: window.songListPlayer.queue.value }) === before,
    'the locate control changed playback state'
  )
  expect(container.scrollTop > initialScrollTop, 'the locate click did not scroll the table')
  const row = Array.from(document.querySelectorAll('.track-row')).find((element) =>
    element.textContent.includes('Locate track ' + targetIndex)
  )
  expect(row, 'the located row was not mounted')
  expect(row.classList.contains('track-playing'), 'the located row is not marked as playing')
  expect(row.getAttribute('aria-current') === 'true', 'the located row is not exposed to assistive tech')
  const containerBox = container.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()
  expect(rowBox.top >= containerBox.top, 'the located row is above the viewport')
  expect(rowBox.bottom <= containerBox.bottom, 'the located row is below the viewport')
  expect(errors.length === 0, errors.join(';'))
  stopScrollControls()
  return 'SONG_LIST_LOCATE_OK'
}
})()
`

const runner = `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const directory = process.argv.at(-1)
app.setPath('userData', path.join(directory, 'profile'))
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1_280,
    height: 900,
    useContentSize: true,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  window.showInactive()
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) =>
    console.error('RENDERER', sourceId + ':' + line, message)
  )
  try {
    await window.loadFile(path.join(directory, 'index.html'))
    console.log(await window.webContents.executeJavaScript('window.songListReady.then(() => window.songListLocateTest())'))
    app.exit(0)
  } catch (error) {
    console.error('SONG_LIST_LOCATE_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})
`
