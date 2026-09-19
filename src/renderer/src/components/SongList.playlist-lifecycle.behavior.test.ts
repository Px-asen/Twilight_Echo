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

test('real Vue, Pinia and Electron DOM exercise the complete playlist lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playlist-lifecycle-'))
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
    const bundleFiles = await readdir(bundleDirectory)
    const bundleName = bundleFiles.find((name) => name.endsWith('.iife.js'))
    const stylesheetName = bundleFiles.find((name) => name.endsWith('.css'))
    assert.ok(bundleName, 'Vite should bundle the production playlist composable and store')
    assert.ok(stylesheetName, 'Vite should bundle the production toolbar and dialog styles')
    await writeFile(htmlPath, runtimeHtml(bundleName, stylesheetName), 'utf8')
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
  const actionsPath = join(
    workspaceRoot,
    'src/renderer/src/components/song-list/usePlaylistLifecycleActions.ts'
  ).replaceAll('\\', '/')
  const storePath = join(workspaceRoot, 'src/renderer/src/stores/useMusicStore.ts').replaceAll(
    '\\',
    '/'
  )
  const lifecyclePath = join(
    workspaceRoot,
    'src/renderer/src/utils/playlistLifecycle.ts'
  ).replaceAll('\\', '/')
  const toolbarPath = join(
    workspaceRoot,
    'src/renderer/src/components/song-list/PlaylistLifecycleToolbar.vue'
  ).replaceAll('\\', '/')
  const dialogPath = join(
    workspaceRoot,
    'src/renderer/src/components/song-list/PlaylistActionDialog.vue'
  ).replaceAll('\\', '/')
  const baseStylePath = join(workspaceRoot, 'src/renderer/src/assets/base.css').replaceAll(
    '\\',
    '/'
  )
  const iconStylePath = require.resolve('primeicons/primeicons.css').replaceAll('\\', '/')
  return `import { computed, createApp, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePlaylistLifecycleActions } from ${JSON.stringify(actionsPath)}
import { useMusicStore } from ${JSON.stringify(storePath)}
import { MAX_PLAYLIST_IMPORT_BYTES } from ${JSON.stringify(lifecyclePath)}
import PlaylistLifecycleToolbar from ${JSON.stringify(toolbarPath)}
import PlaylistActionDialog from ${JSON.stringify(dialogPath)}
import ${JSON.stringify(baseStylePath)}
import ${JSON.stringify(iconStylePath)}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function track(id, filePath, title = id) {
  return {
    id,
    title,
    artist: 'Artist',
    album: 'Album',
    filePath,
    fileName: filePath.split(/[\\\\/]/).at(-1) || filePath,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

const tick = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await tick()
    if (predicate()) return
  }
  throw new Error(message + '; status=' + document.querySelector('#playlist-status')?.textContent)
}

const statusText = () => document.querySelector('#playlist-status')?.textContent || ''
const click = async (selector) => {
  const element = document.querySelector(selector)
  expect(element, 'missing control ' + selector)
  element.focus()
  element.click()
  await tick()
}

const renameButton = '[aria-label="重命名歌单"]'
const copyButton = '[aria-label="复制歌单"]'
const dialogSelector = '.playlist-action-dialog'
const setDialogValue = async (value) => {
  const input = document.querySelector('#playlist-action-value')
  expect(input, 'playlist dialog did not open')
  input.value = value
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await tick()
}
const submitDialog = async () => {
  document.querySelector(dialogSelector + ' form').requestSubmit()
  await tick()
}

const setInputFile = async (selector, file) => {
  const input = document.querySelector(selector)
  expect(input, 'missing file input ' + selector)
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}

const runtimeReady = (async () => {
const pinia = createPinia()
setActivePinia(pinia)
const music = useMusicStore()
await music.loadPlaylists()
music.tracks.value = [
  track('a', 'C:\\\\Music\\\\A.flac', 'A'),
  track('b', 'C:\\\\Music\\\\B.flac', 'B'),
  track('c', 'C:\\\\Music\\\\C.flac', 'C')
]
music.refreshLibraryIndex()

const activePlaylistName = ref('Road Mix')
const selectedIds = ref([])
const repairMessage = ref('')
const currentPlaylist = computed(
  () => music.localPlaylists.value.find((playlist) => playlist.name === activePlaylistName.value) || null
)
const Root = {
  setup() {
    const actions = usePlaylistLifecycleActions({
      currentPlaylist,
      isPlaylistDetail: computed(() => !!currentPlaylist.value),
      repairMessage,
      getSelectedTracks: () =>
        music.tracks.value.filter((item) => selectedIds.value.includes(item.id)),
      isSelected: (trackId) => selectedIds.value.includes(trackId),
      clearSelection: () => {
        selectedIds.value = []
      },
      selectPlaylist: (name) => {
        activePlaylistName.value = name
        window.__playlistFixture.lastSelectedPlaylist = name
      }
    })
    return () =>
      h('main', [
        h(PlaylistLifecycleToolbar, {
          exportFormat: actions.playlistExportFormat.value,
          'onUpdate:exportFormat': (format) => { actions.playlistExportFormat.value = format },
          repairPending: actions.playlistRepairPending.value,
          onRename: actions.handleRenamePlaylist,
          onCopy: actions.handleCopyPlaylist,
          onCover: actions.triggerPlaylistCoverPicker,
          onImport: actions.triggerPlaylistImport,
          onExport: () => actions.downloadPlaylistDocument(actions.playlistExportFormat.value),
          onRepair: actions.handlePlaylistRepair
        }),
        actions.playlistDialog.value
          ? h(PlaylistActionDialog, {
              request: actions.playlistDialog.value,
              error: actions.playlistDialogError.value,
              targets: actions.playlistMoveTargets.value,
              onClose: actions.dismissPlaylistDialog,
              onConfirm: actions.confirmPlaylistDialog
            })
          : null,
        h('input', {
          id: 'playlist-import',
          ref: actions.playlistImportInput,
          type: 'file',
          onChange: actions.handlePlaylistImport
        }),
        h('input', {
          id: 'playlist-cover',
          ref: actions.playlistCoverInput,
          type: 'file',
          onChange: actions.handlePlaylistCover
        }),
        h(
          'button',
          { id: 'playlist-reorder-start', onClick: () => actions.handleMoveSelectedWithinPlaylist(false) },
          'Move start'
        ),
        h('button', { id: 'playlist-move', onClick: actions.handleMoveSelectedToPlaylist }, 'Move'),
        h('output', { id: 'playlist-status' }, repairMessage.value),
        h('pre', { id: 'playlist-state' }, JSON.stringify(music.playlists.value))
      ])
  }
}
createApp(Root).use(pinia).mount('#app')

const runPlaylistLifecycleRuntime = async () => {
  await tick()

  for (const format of ['m3u', 'm3u8', 'pls']) {
    const select = document.querySelector('[aria-label="导出歌单格式"]')
    select.value = format
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await click('.playlist-export-controls button')
  }
  expect(window.__playlistFixture.downloads.length === 3, 'all three exports must download')
  for (const format of ['m3u', 'm3u8', 'pls']) {
    const download = window.__playlistFixture.downloads.find((item) => item.name === 'Road Mix.' + format)
    expect(download, 'missing .' + format + ' filename')
    const contents = await window.__playlistFixture.blobs.get(download.url).text()
    if (format === 'pls') {
      expect(contents.startsWith('[playlist]'), 'PLS download has wrong contents')
      expect(window.__playlistFixture.blobs.get(download.url).type.startsWith('audio/x-scpls'), 'PLS MIME mismatch')
    } else {
      expect(contents.startsWith('#EXTM3U'), format + ' download has wrong contents')
      expect(window.__playlistFixture.blobs.get(download.url).type.startsWith('audio/x-mpegurl'), format + ' MIME mismatch')
    }
  }

  let oversizedReads = 0
  await setInputFile('#playlist-import', {
    name: 'too-large.m3u8',
    size: MAX_PLAYLIST_IMPORT_BYTES + 1,
    text: async () => {
      oversizedReads += 1
      return '#EXTM3U'
    }
  })
  await waitFor(() => statusText().includes('8 MiB'), 'oversized import feedback was not visible')
  expect(oversizedReads === 0, 'oversized import called File.text before rejection')

  let validReads = 0
  await setInputFile('#playlist-import', {
    name: 'valid.m3u8',
    size: 64,
    text: async () => {
      validReads += 1
      return '#EXTM3U\\nC:\\\\Music\\\\C.flac'
    }
  })
  await waitFor(() => statusText().includes('已导入 1 首'), 'successful import feedback was not visible')
  expect(validReads === 1, 'valid import must read exactly once')
  expect(currentPlaylist.value.trackIds.includes('c'), 'valid import did not update the real store')

  await setInputFile('#playlist-import', {
    name: 'invalid.txt',
    size: 8,
    text: async () => 'not a playlist'
  })
  await waitFor(
    () => statusText().includes('M3U') && statusText().includes('PLS'),
    'invalid import feedback was not visible'
  )

  await setInputFile('#playlist-cover', { name: 'bad.gif', size: 8, type: 'image/gif' })
  await waitFor(() => statusText().includes('PNG, JPEG, or WebP'), 'cover validation feedback missing')
  const goodCover = new File([new Uint8Array([137, 80, 78, 71])], 'cover.png', { type: 'image/png' })
  await setInputFile('#playlist-cover', goodCover)
  await waitFor(() => statusText().includes('歌单封面已更新'), 'valid cover feedback missing')
  expect(currentPlaylist.value.cover?.startsWith('data:image/png;base64,'), 'valid cover not applied')

  await click(renameButton)
  const nameInput = document.querySelector('#playlist-action-value')
  expect(document.querySelector(dialogSelector)?.open, 'rename must open a native modal in Electron')
  expect(document.activeElement === nameInput, 'rename should focus its input')
  expect(nameInput.value === 'Road Mix', 'rename should prefill the current name')
  expect(nameInput.selectionStart === 0 && nameInput.selectionEnd === nameInput.value.length, 'rename should select the existing name')
  await setDialogValue('Cancelled name')
  nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await tick()
  expect(!document.querySelector(dialogSelector), 'Escape should close the rename dialog')
  expect(currentPlaylist.value.name === 'Road Mix', 'cancel must preserve the playlist name')
  expect(document.activeElement === document.querySelector(renameButton), 'cancel should restore trigger focus')

  await click(renameButton)
  await setDialogValue('   ')
  expect(document.querySelector(dialogSelector + ' button[type="submit"]').disabled, 'blank names must disable save')
  await setDialogValue('Target')
  await submitDialog()
  expect(document.querySelector('[role="alert"]')?.textContent.includes('同名'), 'duplicate-name errors must stay visible in the dialog')
  expect(currentPlaylist.value.name === 'Road Mix', 'rejected name must not change the active playlist')
  const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
  document.querySelector('#playlist-action-value').dispatchEvent(composing)
  expect(composing.defaultPrevented, 'IME confirmation must not submit a name')

  await setDialogValue('  Road   Renamed  ')
  window.__playlistFixture.conflictNext = true
  await submitDialog()
  expect(!document.querySelector(dialogSelector), 'successful rename should close its dialog')
  expect(currentPlaylist.value?.name === 'Road Renamed', 'name-based navigation must retain the renamed playlist')
  expect(document.activeElement === document.querySelector(renameButton), 'save should restore trigger focus')
  expect(window.__playlistFixture.lastSelectedPlaylist === 'Road Renamed', 'rename did not select the renamed playlist')
  expect(await music.flushPlaylists(), 'rename persistence did not flush')
  await waitFor(
    () => statusText().includes('其他窗口更新') && statusText().includes('权威版本'),
    'recovered CAS conflict was not visible in the UI'
  )
  expect(music.playlists.value.some((playlist) => playlist.id === 'pl-remote'), 'authoritative remote playlist was lost')
  expect(music.playlists.value.find((playlist) => playlist.id === 'pl-source')?.name === 'Road Renamed', 'local rename was lost during CAS recovery')

  await click(copyButton)
  expect(document.querySelector('#playlist-action-value').value === 'Road Renamed 副本', 'copy should suggest a name')
  await setDialogValue('Road Copy')
  await submitDialog()
  expect(music.playlists.value.some((playlist) => playlist.name === 'Road Copy'), 'copy action did not use the real store')

  selectedIds.value = ['b']
  await click('#playlist-reorder-start')
  expect(currentPlaylist.value.trackIds[0] === 'b', 'manual reorder did not move the selected track')

  selectedIds.value = ['a', 'c']
  await click('#playlist-move')
  await setDialogValue('pl-target')
  await submitDialog()
  const target = music.playlists.value.find((playlist) => playlist.id === 'pl-target')
  expect(target.trackIds.includes('a') && target.trackIds.includes('c'), 'batch move did not populate target')
  expect(!currentPlaylist.value.trackIds.includes('a') && !currentPlaylist.value.trackIds.includes('c'), 'batch move did not remove source ids')

  await click('[aria-label="重新定位缺失文件"]')
  await waitFor(() => statusText().includes('已重新定位 1 首'), 'unique relocation feedback missing')
  expect(currentPlaylist.value.trackIds.includes('relocated-missing'), 'unique relocation was not applied')
  expect(!currentPlaylist.value.trackIds.includes('missing'), 'stale missing id survived relocation')

  expect(await music.flushPlaylists(), 'final lifecycle transaction did not flush')
  expect(window.__playlistFixture.authoritative.some((playlist) => playlist.id === 'pl-remote'), 'final CAS state discarded authoritative data')
  await click(renameButton)
  activePlaylistName.value = 'Target'
  await tick()
  expect(!document.querySelector(dialogSelector), 'navigation must dismiss an edit for the previous playlist')
  activePlaylistName.value = 'Road Renamed'
  await tick()
  console.log('PLAYLIST_LIFECYCLE_RUNTIME_OK')
}
return runPlaylistLifecycleRuntime
})()
window.runPlaylistLifecycleRuntime = async () => (await runtimeReady)()
`
}

function runtimeHtml(bundleName: string, stylesheetName: string): string {
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="bundle/${stylesheetName}"><style>
body { margin: 0; padding: 32px; background: var(--te-app-bg); color: var(--te-neutral-900); font-family: system-ui, sans-serif; }
.playlist-lifecycle-actions { margin-bottom: 24px; }
</style></head><body><div id="app"></div><script>
window.__playlistFixture = {
  revision: 1,
  conflictNext: false,
  downloads: [],
  blobs: new Map(),
  lastSelectedPlaylist: '',
  authoritative: [
    { id: 'pl-favorite', name: 'Favorite', trackIds: [], isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
    {
      id: 'pl-source',
      name: 'Road Mix',
      trackIds: ['a', 'b', 'missing'],
      trackSnapshots: {
        missing: {
          id: 'missing', title: 'Missing', artist: 'Artist', album: 'Album',
          filePath: 'D:\\\\Gone\\\\Missing.flac', fileName: 'Missing.flac', duration: 180,
          size: 1, cover: null, lyrics: null, source: 'local'
        }
      },
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    { id: 'pl-target', name: 'Target', trackIds: [], createdAt: '2026-01-01T00:00:00.000Z' }
  ]
}
const fixture = window.__playlistFixture
const clone = (value) => JSON.parse(JSON.stringify(value))
const envelope = () => ({ version: 2, revision: fixture.revision, savedAt: new Date().toISOString(), data: clone(fixture.authoritative) })
window.URL.createObjectURL = (blob) => {
  const url = 'blob:playlist-' + (fixture.blobs.size + 1)
  fixture.blobs.set(url, blob)
  return url
}
window.URL.revokeObjectURL = () => {}
HTMLAnchorElement.prototype.click = function () {
  fixture.downloads.push({ name: this.download, url: this.href })
}
window.createImageBitmap = async () => ({ width: 800, height: 800, close() {} })
window.api = {
  data: {
    loadPlaylists: async () => envelope(),
    savePlaylists: async (data, expectedRevision) => {
      if (fixture.conflictNext) {
        fixture.conflictNext = false
        fixture.revision += 1
        fixture.authoritative = [
          ...fixture.authoritative,
          { id: 'pl-remote', name: 'Remote', trackIds: [], createdAt: '2026-01-02T00:00:00.000Z' }
        ]
        const error = new Error('concurrent playlist write')
        error.code = 'ERR_PERSISTENCE_REVISION_CONFLICT'
        error.current = envelope()
        error.expectedRevision = expectedRevision
        throw error
      }
      if (expectedRevision !== fixture.revision) throw new Error('unexpected revision ' + expectedRevision)
      fixture.revision += 1
      fixture.authoritative = clone(data)
      return envelope()
    }
  },
  dialog: { openFolder: async () => 'E:\\\\Relocated' },
  fs: {
    scanMusicFiles: async () => [
      {
        id: 'relocated-missing', title: 'Missing', artist: 'Artist', album: 'Album',
        filePath: 'E:\\\\Relocated\\\\Missing.flac', fileName: 'Missing.flac', duration: 180,
        size: 1, cover: null, lyrics: null, source: 'local'
      }
    ]
  }
}
</script><script src="bundle/${bundleName}"></script></body></html>`
}

function electronRunnerSource(): string {
  const renameClickSource = `document.querySelector('.playlist-lifecycle-actions button').focus(); document.querySelector('.playlist-lifecycle-actions button').click()`
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 920, height: 600, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runPlaylistLifecycleRuntime()')
    const evaluate = (source) => window.webContents.executeJavaScript(source)
    const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    const openRename = async () => {
      await evaluate(${JSON.stringify(renameClickSource)})
      await settle()
      assert.equal(await evaluate('document.querySelector(".playlist-action-dialog")?.open'), true, 'rename dialog should be visible')
    }
    const press = async (keyCode) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await settle()
    }
    await openRename()
    await evaluate('const nameField = document.querySelector("#playlist-action-value"); nameField.value = "Keyboard rename"; nameField.dispatchEvent(new Event("input", { bubbles: true }))')
    await press('Enter')
    assert.equal(await evaluate('!!document.querySelector(".playlist-action-dialog")'), false, 'native Enter must save and close')
    assert.equal(await evaluate('JSON.parse(document.querySelector("#playlist-state").textContent).find(p => p.id === "pl-source").name'), 'Keyboard rename')
    await openRename()
    await press('Escape')
    assert.equal(await evaluate('!!document.querySelector(".playlist-action-dialog")'), false, 'native Escape must cancel')
    assert.equal(await evaluate('document.activeElement === document.querySelector(".playlist-lifecycle-actions button")'), true)

    const evidence = process.env.TWILIGHT_PLAYLIST_EVIDENCE_DIR
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true })
      await evaluate('const previewStyle = document.createElement("style"); previewStyle.textContent = "main > :not(.playlist-lifecycle-actions):not(dialog) { display: none; }"; document.head.append(previewStyle)')
      await evaluate('const formatField = document.querySelector(".playlist-export-format select"); formatField.value = "m3u8"; formatField.dispatchEvent(new Event("change", { bubbles: true }))')
      for (const theme of ['dark', 'light']) {
        await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme))
        await settle()
        const bounds = await evaluate('(() => { const toolbar = document.querySelector(".playlist-lifecycle-actions"); const r = toolbar.getBoundingClientRect(); const last = toolbar.lastElementChild.getBoundingClientRect(); return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(last.right - r.left) + 16, height: Math.ceil(r.height) + 16 }; })()')
        await fs.writeFile(path.join(evidence, 'playlist-toolbar-' + theme + '.png'), (await window.webContents.capturePage(bounds)).toPNG())
        await openRename()
        await fs.writeFile(path.join(evidence, 'playlist-rename-' + theme + '.png'), (await window.webContents.capturePage()).toPNG())
        await press('Escape')
      }
    }
    app.exit(0)
  } catch (error) {
    console.error('PLAYLIST_LIFECYCLE_RUNTIME_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
