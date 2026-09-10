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

test('long press reorders without accidental clicks and local playlist order survives remount', async () => {
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
import '@renderer/components/song-list/SongList.css'
import '@renderer/components/streaming-page/StreamingDetailStage.css'
import { useHoldReorder } from '@renderer/composables/useHoldReorder'
import { useLocalPlaylistOrder } from '@renderer/components/song-list/useLocalPlaylistOrder'
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
    const e = new PointerEvent(type, { ...point(id), pointerId:1, isPrimary:true, button:0, bubbles:true, cancelable:true })
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
    '<!doctype html><html><head></head><body><div id="app"></div><script src="bundle/' +
    bundleName +
    '"></script></body></html>'
  )
}
function electronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runPlaylistLifecycleRuntime()')
    app.exit(0)
  } catch (error) {
    console.error('PLAYLIST_LIFECYCLE_RUNTIME_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
