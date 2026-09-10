import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
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

test('local view transitions complete after leaving the song list, including an open dialog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-local-transition-'))
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
  const source = readFileSync(
    join(workspaceRoot, 'src/renderer/src/components/SongList.vue'),
    'utf8'
  )
  const template = parse(source).descriptor.template!
  const roots = template.ast!.children.filter((node) => node.type === 1)
  const dialog = '<TrackInfoDialog v-if="infoTrack" />'
  const shell = roots
    .map((node) => {
      if (node.type !== 1) return ''
      if (node.tag === 'TrackInfoDialog') return dialog
      assert.equal(node.tag, 'div')
      const hasDialog = node.children.some(
        (child) => child.type === 1 && child.tag === 'TrackInfoDialog'
      )
      return (
        '<div class="song-list"><span id="song-list-probe">Songs</span>' +
        (hasDialog ? dialog : '') +
        '</div>'
      )
    })
    .join('')
  return `import { createApp, h, ref, nextTick, Transition, Teleport, compile } from 'vue'
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const expect = (ok, message) => { if (!ok) throw new Error(message) }
window.runPlaylistLifecycleRuntime = async () => {
  const page = ref('home')
  const infoTrack = ref(false)
  const SongShell = {
    setup: () => ({ infoTrack }),
    components: { TrackInfoDialog: { render: () => h(Teleport, { to:'body' }, h('div', { id:'dialog-probe' }, 'Details')) } },
    render: compile(${JSON.stringify(shell)})
  }
  const app = createApp({ setup: () => () => h(Transition, {
    mode: 'out-in', css: false,
    onLeave: (_element, done) => setTimeout(done, 20)
  }, () => page.value === 'songs' ? h(SongShell, { key:'songs' }) : h('div', { key:page.value, id:'page-probe' }, page.value)) })
  app.mount('#app')
  for (const open of [false, true]) {
    infoTrack.value = open
    for (const next of ['home', 'songs', 'home', 'albums', 'songs', 'streaming', 'home', 'songs', 'playlists']) {
      page.value = next
      await nextTick()
      await pause(70)
      expect(next === 'songs' ? document.querySelector('#song-list-probe') : document.querySelector('#page-probe')?.textContent === next, 'local page became blank after switching to ' + next)
      expect(next === 'songs' && open ? document.querySelector('#dialog-probe') : !document.querySelector('#dialog-probe'), 'dialog lifecycle did not follow local page')
    }
  }
  app.unmount()
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
