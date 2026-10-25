import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('real player and settings stores retain volume through shell remounts and renderer restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-volume-restart-'))
  try {
    const entry = join(directory, 'entry.ts')
    const bundleDirectory = join(directory, 'bundle')
    const html = join(directory, 'index.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(entry, runtimeSource())
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js')
        }
      },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        lib: { entry, name: 'VolumeRestart', formats: ['iife'], fileName: 'runtime' }
      }
    })
    const bundle = (await readdir(bundleDirectory)).find((name) => name.endsWith('.iife.js'))
    assert.ok(bundle)
    await writeFile(html, htmlSource(bundle))
    await writeFile(runner, runnerSource())
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stderr } = await execFileAsync(require('electron') as string, [runner, html], {
      env,
      timeout: 45_000,
      windowsHide: true
    })
    assert.match(stderr, /VOLUME_RESTART_OK/)
  } finally {
    // directory is an absolute, unique child of the temporary directory.
    await rm(directory, { recursive: true, force: true })
  }
})

function runtimeSource(): string {
  const renderer = join(workspaceRoot, 'src/renderer/src').replaceAll('\\', '/')
  return `import { nextTick } from 'vue'
import { usePlayerStore } from ${JSON.stringify(`${renderer}/stores/usePlayerStore.ts`)}
import { useSettingsStore } from ${JSON.stringify(`${renderer}/stores/useSettingsStore.ts`)}
const clone = value => JSON.parse(JSON.stringify(value))
const expect = (condition, message) => { if (!condition) throw new Error(message) }
window.runVolumeRestart = async (expected, next) => {
  const settings = useSettingsStore()
  const player = usePlayerStore()
  window.__volumeDefaults = clone(settings.settings.value)
  const startup = { settings: await window.api.settings.get() }
  // An engine-ready notification can arrive before the startup settings.
  await window.__ready()
  expect(window.__forwarded.length === 0, 'engine-ready sent the 70% default before hydration')
  settings.hydrateStartupSnapshot(startup)
  await nextTick()
  expect(player.volume.value === expected, 'restart restored ' + player.volume.value + ' instead of ' + expected)
  expect(window.__forwarded.every(value => value === expected), 'startup sent a temporary default volume')
  player.setVolume(next)
  await nextTick()
  let persisted = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await window.api.settings.get()).settings.softwareVolume === next) {
      persisted = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(persisted, 'volume debounce did not save without an exit flush')
  // Exercise cancellation of a pending debounce by the close coordinator.
  player.setVolume(next === 0 ? 0.01 : next / 2)
  await nextTick()
  player.setVolume(next)
  await nextTick()
  await player.flushSoftwareVolumePersist()
  expect((await window.api.settings.get()).settings.softwareVolume === next, 'final volume did not reach disk')
  // App.vue can mount again while the cached startup promise still holds the
  // old volume. The live settings store must remain authoritative.
  const current = settings.settings.value
  const resumed = settings.hydrateStartupSnapshot(startup)
  await nextTick()
  expect(resumed === current, 'shell remount replaced the live settings with the startup snapshot')
  expect(player.volume.value === next, 'shell remount reset volume to ' + player.volume.value)
  await player.flushSoftwareVolumePersist()
  expect((await window.api.settings.get()).settings.softwareVolume === next, 'shell remount overwrote the saved volume')
}
`
}

function htmlSource(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
const { ipcRenderer } = require('electron')
window.process = { env: {} }
window.__forwarded = []
const noopSubscribe = () => () => {}
const snapshot = saved => ({
  settings: { ...window.__volumeDefaults, ...saved }, defaults: {}, paths: {},
  appVersion: 'test', platform: 'win32', restartReasons: []
})
window.api = {
  library: {
    getStorageMode: async () => 'json',
    onChanged: noopSubscribe,
    database: new Proxy({}, { get: () => async () => ({ items: [], total: 0, tracks: [] }) })
  },
  settings: {
    get: async () => snapshot(await ipcRenderer.invoke('fixture:read')),
    update: async patch => snapshot(await ipcRenderer.invoke('fixture:write', patch)),
    onChanged: noopSubscribe
  },
  audioEngine: {
    onReady: cb => { window.__ready = cb; return () => {} },
    onPropertyChange: noopSubscribe, onPlaybackInfo: noopSubscribe, onEndFile: noopSubscribe,
    onStartFile: noopSubscribe, onError: noopSubscribe, onDisconnected: noopSubscribe,
    getAudioOutputState: async () => { throw new Error('fixture has no output device') },
    getAudioProcessing: async () => { throw new Error('fixture has no DSP') },
    getPlaybackInfo: async () => ({}),
    setPlaybackRate: async () => {},
    setVolume: async value => { window.__forwarded.push(value) }
  },
  systemMedia: { getNativeStatus: async () => ({ active: false }) },
  ncmCloud: { onProgress: noopSubscribe },
  data: { loadLyricsManagement: async () => null }
}
</script><script src="bundle/${bundle}"></script></body></html>`
}

function runnerSource(): string {
  return `const { app, BrowserWindow, ipcMain } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const target = process.argv.at(-1)
const file = path.join(path.dirname(target), 'settings.json')
app.setPath('userData', path.join(path.dirname(target), 'user-data'))
app.on('window-all-closed', () => {})
writeFileSync(file, JSON.stringify({ softwareVolume: 0.7 }))
const read = () => JSON.parse(readFileSync(file, 'utf8'))
ipcMain.handle('fixture:read', read)
ipcMain.handle('fixture:write', (_event, patch) => {
  const next = { ...read(), ...patch }
  writeFileSync(file, JSON.stringify(next))
  return next
})
app.whenReady().then(async () => {
  try {
    for (const [expected, next] of [[0.7, 0.22], [0.22, 0], [0, 1], [1, 0.36]]) {
      const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true } })
      window.webContents.on('console-message', event => console.error('RENDERER', event.message))
      await window.loadFile(target)
      await window.webContents.executeJavaScript('window.runVolumeRestart(' + expected + ',' + next + ')')
      window.destroy()
    }
    console.error('VOLUME_RESTART_OK')
    app.exit(0)
  } catch (error) {
    console.error('VOLUME_RESTART_FAILED', error && error.stack || error)
    app.exit(1)
  }
})`
}
