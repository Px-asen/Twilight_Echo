import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('local and online playlists support persistent manual ordering without accidental clicks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-hold-order-'))
  try {
    const entryPath = join(directory, 'playlist-lifecycle-entry.ts')
    const bundleDirectory = join(directory, 'bundle')
    const htmlPath = join(directory, 'playlist-lifecycle.html')
    const runnerPath = join(directory, 'playlist-lifecycle-runner.cjs')
    await writeFile(entryPath, runtimeEntrySource(), 'utf8')

    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          'primeicons/primeicons.css': require.resolve('primeicons/primeicons.css'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
        }
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env': '{}'
      },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          name: 'PlaylistLifecycleRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const bundleName = (await readdir(bundleDirectory)).find((name) => name.endsWith('.iife.js'))
    assert.ok(bundleName, 'Vite should bundle the production playlist composable and store')
    const styles = (await readdir(bundleDirectory)).filter((name) => name.endsWith('.css'))
    await writeFile(
      htmlPath,
      runtimeHtml(bundleName).replace(
        '</head>',
        styles.map((name) => '<link rel="stylesheet" href="bundle/' + name + '">').join('') +
          '</head>'
      ),
      'utf8'
    )
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 60_000,
      windowsHide: true
    })
    assert.match(stderr, /PLAYLIST_LIFECYCLE_RUNTIME_OK/)
    assert.doesNotMatch(stderr, /PLAYLIST_LIFECYCLE_RUNTIME_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

function runtimeEntrySource(): string {
  return `import { createApp, h, ref, nextTick } from 'vue'
import '@renderer/assets/base.css'
import 'primeicons/primeicons.css'
import '@renderer/components/song-list/SongList.css'
import '@renderer/components/streaming-page/StreamingDetailStage.css'
import { useHoldReorder } from '@renderer/composables/useHoldReorder'
import { useLocalPlaylistOrder } from '@renderer/components/song-list/useLocalPlaylistOrder'
import StreamingLibrary from '@renderer/components/StreamingLibrary.vue'
import { useLibraryFavoritePlaylist } from '@renderer/components/streaming-page/useLibraryFavoritePlaylist'
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const expect = (ok, message) => { if (!ok) throw new Error(message) }
window.runPlaylistLifecycleRuntime = async () => {
  localStorage.clear()
  let reorder
  let ordered
  let clicks = 0
  let moves = 0
  const source = ref(['a', 'hidden', 'b', 'c'].map(id => ({ id, title: id })))
  function mount() {
    return createApp({ setup() {
      ordered = useLocalPlaylistOrder(source, () => 'test', () => {})
      reorder = useHoldReorder((from, to) => {
        moves++
        ordered.move(from, to, ordered.playlists.value.filter(t => t.id !== 'hidden'))
      })
      return () => h('div', { 'data-reorder-group': '', onClickCapture: reorder.click },
        ordered.playlists.value.filter(t => t.id !== 'hidden').map(t => h('div', {
          'data-reorder-id': t.id,
          style: 'height:70px;width:300px;background:#eee;margin:4px',
          onPointerdown: e => reorder.start(e, t.id),
          onClick: () => { clicks++ }
        }, [t.id, h('button', { onClick: () => {} }, 'more')]))
      )
    }}).mount('#app')
  }
  let instance = mount()
  const element = id => document.querySelector('[data-reorder-id="' + id + '"]')
  function point(id) { const r = element(id).getBoundingClientRect(); return { clientX:r.x+10, clientY:r.y+25 } }
  function pointer(type, id) {
    const e = new PointerEvent(type, { ...point(id), pointerId:1, pointerType:'touch', isPrimary:true, button:0, bubbles:true, cancelable:true })
    ;(type === 'pointerdown' ? element(id) : document).dispatchEvent(e)
  }
  pointer('pointerdown', 'a'); pointer('pointerup', 'a'); element('a').click()
  expect(clicks === 1 && moves === 0, 'ordinary click was swallowed')
  pointer('pointerdown', 'a'); pointer('pointermove', 'b'); await pause(500)
  expect(reorder.active.value === null, 'scroll before hold should cancel activation')
  pointer('pointerdown', 'a'); await pause(500)
  expect(reorder.active.value === 'a', 'long press did not activate')
  pointer('pointermove', 'c'); pointer('pointerup', 'c'); element('c').click()
  await nextTick()
  expect(moves === 1 && clicks === 1, 'drop fired a click or failed to move')
  expect(ordered.playlists.value.map(t => t.id).join(',') === 'b,hidden,c,a', 'filtered ordering lost hidden positions')
  pointer('pointerdown', 'b'); await pause(500)
  document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape' }))
  pointer('pointerup', 'c')
  expect(moves === 1 && reorder.active.value === null, 'Escape committed a move')
  instance.$.appContext.app.unmount()
  instance = mount()
  expect(ordered.playlists.value.map(t => t.id).join(',') === 'b,hidden,c,a', 'order did not survive remount')
  const button = element('b').querySelector('button')
  button.dispatchEvent(new PointerEvent('pointerdown', { ...point('b'), pointerId:1, isPrimary:true, button:0, bubbles:true }))
  await pause(500)
  expect(reorder.active.value === null, 'nested action button activated reorder')
  instance.$.appContext.app.unmount()

  const onlineSource = ref([
    { id: '101', name: 'Pinned Bilibili folder', cover: null, trackCount: 2, pinned: true },
    { id: '102', name: 'Second Bilibili folder', cover: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="88" height="88"%3E%3Crect width="88" height="88" fill="red"/%3E%3C/svg%3E', trackCount: 3 },
    { id: '103', name: 'Third Bilibili folder', cover: null, trackCount: 4 }
  ])
  const provider = ref('bili')
  const userId = ref('123')
  const allowPins = ref(false)
  let onlineClicks = 0
  function mountOnline() {
    return createApp({ render: () => h(StreamingLibrary, {
      isLoggedIn: true,
      activeProvider: provider.value,
      providerLabel: 'Bilibili',
      profile: { userId: userId.value, nickname: 'Test user', avatarUrl: '' },
      profileSignature: '',
      likedSummary: { name: '', cover: null, trackCount: 0 },
      libraryLoaded: true,
      userPlaylistEntries: onlineSource.value,
      showLikedPanel: false,
      showSocialStats: false,
      showFeatureCards: false,
      allowPinPlaylists: allowPins.value,
      pinnedPlaylistIds: ['101'],
      onOpenPlaylist: () => { onlineClicks++ }
    }) }).mount('#app')
  }
  const onlineOrder = () => Array.from(document.querySelectorAll('[data-reorder-id]')).map(el => el.dataset.reorderId).join(',')
  instance = mountOnline()
  await nextTick()
  expect(onlineOrder() === '101,102,103', 'online library lost its initial source order')
  expect(!document.querySelector('.playlist-pin-button'), 'fixture must use the library with pinning disabled')
  expect(!document.querySelector('.playlist-sort-help').textContent.includes('置顶优先'), 'library describes pin priority when pinning is disabled')
  element('101').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
  await nextTick()
  expect(onlineOrder() === '102,101,103', 'legacy pinned Bilibili folder ignored the keyboard move')
  pointer('pointerdown', '101'); await pause(500)
  pointer('pointermove', '103'); pointer('pointerup', '103'); element('103').click()
  await nextTick()
  expect(onlineOrder() === '102,103,101', 'legacy pinned Bilibili folder ignored the drag move')
  expect(onlineClicks === 0, 'online reorder opened a playlist')
  instance.$.appContext.app.unmount()
  instance = mountOnline()
  await nextTick()
  expect(onlineOrder() === '102,103,101', 'Bilibili folder order did not survive remount')
  onlineSource.value = [...onlineSource.value, { id: '104', name: 'New folder', cover: null, trackCount: 1 }]
  await nextTick()
  expect(onlineOrder() === '102,103,101,104', 'library refresh overwrote saved order or lost new folders')
  provider.value = 'other'
  await nextTick()
  expect(onlineOrder() === '101,102,103,104', 'Bilibili folder order leaked to another provider')
  provider.value = 'bili'
  userId.value = '456'
  await nextTick()
  expect(onlineOrder() === '101,102,103,104', 'Bilibili folder order leaked to another account')
  userId.value = '123'
  await nextTick()
  expect(onlineOrder() === '102,103,101,104', 'returning to the Bilibili account did not restore its order')
  allowPins.value = true
  await nextTick()
  expect(onlineOrder() === '101,102,103,104', 'a library with pin controls lost pin priority')
  allowPins.value = false
  await nextTick()
  expect(onlineOrder() === '102,103,101,104', 'disabling pin controls did not restore manual order')

  async function mouse(type, id, selector = '', held = false) {
    const target = selector ? element(id).querySelector(selector) : element(id)
    const rect = target.getBoundingClientRect()
    await window.nativeMouse({ type, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), held })
  }
  await mouse('mouseMove', '102', '.playlist-item-cover')
  await pause(350)
  await mouse('mouseDown', '102', '.playlist-item-cover')
  await pause(550)
  expect(element('102').classList.contains('is-dragging'), 'native mouse hold on the cover did not activate reorder')
  await mouse('mouseMove', '103', '', true)
  await mouse('mouseUp', '103')
  await nextTick()
  expect(onlineOrder() === '103,102,101,104', 'native mouse hold on the cover failed to reorder')
  expect(onlineClicks === 0, 'native mouse drop opened a playlist')

  await mouse('mouseMove', '102', '.playlist-item-title')
  await pause(350)
  await mouse('mouseDown', '102', '.playlist-item-title')
  await mouse('mouseMove', '101', '', true)
  expect(element('102').classList.contains('is-dragging'), 'ordinary mouse drag did not activate before the hold timeout')
  expect(element('101').classList.contains('is-drop-target'), 'ordinary mouse drag did not mark the target folder')
  await mouse('mouseUp', '101')
  await nextTick()
  expect(onlineOrder() === '103,101,102,104', 'ordinary native mouse drag on the title failed to reorder')
  expect(onlineClicks === 0, 'ordinary native mouse drag opened a playlist')
  await mouse('mouseMove', '102', '.playlist-item-cover')
  await pause(350)
  await mouse('mouseDown', '102', '.playlist-item-cover')
  await mouse('mouseMove', '103', '', true)
  await mouse('mouseUp', '103')
  await nextTick()
  expect(onlineOrder() === '102,103,101,104', 'ordinary native mouse drag on the cover failed to reorder')
  expect(onlineClicks === 0, 'cover drag opened a playlist')
  await mouse('mouseMove', '103', '.playlist-item-title')
  await pause(350)
  await mouse('mouseDown', '103', '.playlist-item-title')
  await mouse('mouseUp', '103', '.playlist-item-title')
  await nextTick()
  expect(onlineClicks === 1, 'ordinary native mouse click did not open the playlist')
  element('102').focus()
  await window.nativeKey('Down', ['alt'])
  await nextTick()
  expect(onlineOrder() === '103,102,101,104', 'native Alt+Down did not reorder the focused playlist')
  instance.$.appContext.app.unmount()
  instance = mountOnline()
  await nextTick()
  expect(onlineOrder() === '103,102,101,104', 'native mouse and keyboard order did not survive remount')
  instance.$.appContext.app.unmount()

  const favoriteSource = ref(onlineSource.value.map((playlist, index) => ({
    ...playlist, name: index === 0 ? '默认收藏夹' : index === 1 ? '音乐收藏' : playlist.name
  })))
  let favoriteSelection
  const favoriteOpens = [], favoritePlays = []
  function mountFavorites() {
    return createApp({ setup() {
      favoriteSelection = useLibraryFavoritePlaylist(
        () => JSON.stringify([provider.value, userId.value]),
        () => favoriteSource.value[0] ?? null,
        () => favoriteSource.value
      )
      return () => h(StreamingLibrary, {
        isLoggedIn: true, activeProvider: provider.value, providerLabel: 'Bilibili',
        profile: { userId: userId.value, nickname: 'Test user', avatarUrl: '' },
        profileSignature: '', libraryLoaded: true, userPlaylistEntries: favoriteSource.value,
        likedSummary: favoriteSelection.selectedPlaylist.value,
        likedPlaylistOptions: favoriteSelection.options.value,
        selectedLikedPlaylistId: favoriteSelection.selectedPlaylist.value?.id,
        showLikedPanel: true, showSocialStats: false, showFeatureCards: false,
        onSelectLikedPlaylist: favoriteSelection.select,
        onOpenLikedTracks: () => favoriteOpens.push(favoriteSelection.selectedPlaylist.value.id),
        onPlayLikedSongs: () => favoritePlays.push(favoriteSelection.selectedPlaylist.value.id)
      })
    } }).mount('#app')
  }
  instance = mountFavorites()
  await nextTick()
  let picker = document.querySelector('.favorites-picker select')
  expect(picker && picker.options.length === 4, 'favorite picker is missing or duplicates the default folder')
  expect(document.querySelector('.favorites-info h2').textContent === '我喜欢', 'favorite shortcut lost its stable task label')
  expect(document.querySelector('.favorites-name').textContent === '默认收藏夹', 'wrong initial favorite folder')
  picker.click()
  expect(favoriteOpens.length === 0, 'clicking the favorite picker opened the playlist')
  picker.focus()
  await window.nativeKey('Down', [])
  await nextTick()
  expect(picker.value === '102', 'native keyboard did not select the other favorite folder')
  expect(document.querySelector('.favorites-name').textContent === '音乐收藏', 'favorite title did not follow selection')
  expect(document.querySelector('.favorites-footer p').textContent.includes('3 首'), 'favorite count did not follow selection')
  expect(document.querySelector('.favorites-cover img').src === favoriteSource.value[1].cover, 'favorite cover did not follow selection')
  expect(favoriteOpens.length === 0, 'keyboard selection navigated into a playlist')
  document.querySelector('.favorites-card').click()
  document.querySelector('.favorites-card .btn-play').click()
  expect(favoriteOpens.join(',') === '102' && favoritePlays.join(',') === '102', 'card actions did not use the selected folder')
  await document.fonts.ready
  await pause(450)
  await window.captureFavorites()
  instance.$.appContext.app.unmount()
  instance = mountFavorites()
  await nextTick()
  expect(document.querySelector('.favorites-picker select').value === '102', 'favorite folder did not survive remount')
  userId.value = '456'
  await nextTick()
  expect(document.querySelector('.favorites-picker select').value === '101', 'favorite choice leaked to another account')
  userId.value = '123'
  await nextTick()
  expect(document.querySelector('.favorites-picker select').value === '102', 'favorite choice was not restored for its account')
  favoriteSource.value = favoriteSource.value.filter(playlist => playlist.id !== '102')
  await nextTick()
  expect(document.querySelector('.favorites-name').textContent === '默认收藏夹', 'deleted favorite folder did not fall back to the default')
  favoriteSource.value = favoriteSource.value.slice(0, 1)
  await nextTick()
  expect(!document.querySelector('.favorites-picker'), 'single-folder library displays an unusable switcher')
  instance.$.appContext.app.unmount()

  const fixture = document.createElement('div')
  fixture.style.cssText = 'position:fixed;inset:0;background:white;z-index:99999;padding:20px'
  fixture.innerHTML = '<div class="track-title-row" style="width:600px"><button class="track-title metadata-link">Short title</button><span></span></div><div class="col-info" style="width:600px"><button class="track-artist metadata-link">Singer</button></div><div class="row-meta" style="display:grid;width:600px"><button class="row-title metadata-link">Online title</button><button class="row-artist metadata-link">Online artist</button><button class="metadata-link">Album</button></div>'
  document.body.append(fixture)
  await nextTick()
  for (const link of fixture.querySelectorAll('.metadata-link')) {
    const rect = link.getBoundingClientRect()
    expect(rect.width > 0 && rect.width < 250, 'metadata link stretches beyond its text: ' + link.className)
    expect(document.elementFromPoint(rect.right + 50, rect.top + rect.height / 2) !== link, 'blank area still hits metadata link')
  }
  const longTitle = fixture.querySelector('.track-title')
  longTitle.textContent = 'Long song name '.repeat(100)
  await nextTick()
  expect(longTitle.getBoundingClientRect().width <= 600 && longTitle.scrollWidth > longTitle.clientWidth, 'long title no longer truncates within column')
  fixture.remove()
  console.log('PLAYLIST_LIFECYCLE_RUNTIME_OK')
}
`
}
function runtimeHtml(bundleName: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script src="bundle/' +
    bundleName +
    '"></script></body></html>'
  )
}
function electronRunnerSource(): string {
  return `const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1700, height: 1000, webPreferences: { contextIsolation: false, nodeIntegration: true, backgroundThrottling: false, offscreen: true } })
  ipcMain.handle('playlist:mouse', async (_event, input) => {
    window.webContents.sendInputEvent({ type: input.type, x: input.x, y: input.y, button: 'left', clickCount: 1, modifiers: input.held ? ['leftButtonDown'] : [] })
    await new Promise(resolve => setTimeout(resolve, 30))
  })
  ipcMain.handle('playlist:key', async (_event, key, modifiers) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    await new Promise(resolve => setTimeout(resolve, 30))
  })
  ipcMain.handle('playlist:capture-favorites', async (_event, rect) => {
    if (!process.env.TWILIGHT_FAVORITES_SCREENSHOT) return
    require('node:fs').writeFileSync(process.env.TWILIGHT_FAVORITES_SCREENSHOT, (await window.webContents.capturePage(rect)).toPNG())
  })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript("window.nativeMouse = input => require('electron').ipcRenderer.invoke('playlist:mouse', input); void 0")
    await window.webContents.executeJavaScript("window.nativeKey = (key, modifiers) => require('electron').ipcRenderer.invoke('playlist:key', key, modifiers); void 0")
    await window.webContents.executeJavaScript("window.captureFavorites = () => { const r = document.querySelector('.favorites-card').getBoundingClientRect(); return require('electron').ipcRenderer.invoke('playlist:capture-favorites', { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }); }; void 0")
    await window.webContents.executeJavaScript('window.runPlaylistLifecycleRuntime()')
    app.exit(0)
  } catch (error) {
    console.error('PLAYLIST_LIFECYCLE_RUNTIME_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
