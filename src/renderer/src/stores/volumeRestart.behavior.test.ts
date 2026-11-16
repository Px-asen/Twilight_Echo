import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')
const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test(
  'Core retains volume through shell remounts and renderer restarts with one settings writer',
  { timeout: 90_000 },
  async () => {
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
        define: { 'process.env.NODE_ENV': JSON.stringify('test') },
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
      await writeFile(
        html,
        `<!doctype html><html><head><meta charset="utf-8"></head><body><script src="bundle/${bundle}"></script></body></html>`
      )
      const bundleNode = (contents: string, outfile: string) =>
        buildSync({
          stdin: { contents, resolveDir: workspaceRoot },
          bundle: true,
          packages: 'external',
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          define: {
            'import.meta.url': JSON.stringify(
              pathToFileURL(join(workspaceRoot, 'package.json')).href
            )
          },
          banner:
            outfile === runner
              ? {
                  js: `module.paths.unshift(${JSON.stringify(join(workspaceRoot, 'node_modules'))});`
                }
              : undefined,
          outfile
        })
      bundleNode(preloadSource(), join(directory, 'preload.cjs'))
      bundleNode(runnerSource(), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const { stderr } = await execFileAsync(
        require('electron') as string,
        [runner, html, workspaceRoot],
        {
          env,
          timeout: 80_000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024
        }
      )
      assert.match(stderr, /VOLUME_RESTART_OK/)
    } finally {
      // directory is an absolute, unique child of the temporary directory.
      await rm(directory, { recursive: true, force: true })
    }
  }
)

function runtimeSource(): string {
  const renderer = join(workspaceRoot, 'src/renderer/src').replaceAll('\\', '/')
  return `import { nextTick, toRaw } from 'vue'
import { useCoreConnection } from ${JSON.stringify(`${renderer}/stores/coreConnection.ts`)}
import { usePlayerStore } from ${JSON.stringify(`${renderer}/stores/usePlayerStore.ts`)}
import { useSettingsStore } from ${JSON.stringify(`${renderer}/stores/useSettingsStore.ts`)}
const expect = (condition, message) => { if (!condition) throw new Error(message) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
window.runVolumeRestart = async (expected, next) => {
  const before = await window.api.fixture.inspect()
  const settings = useSettingsStore()
  const player = usePlayerStore()
  const core = useCoreConnection()
  const startup = { settings: await window.api.settings.get() }
  await core.attach()
  settings.hydrateStartupSnapshot(startup)
  await nextTick()
  expect(player.volume.value === expected, 'restart restored ' + player.volume.value + ' instead of ' + expected)
  const attached = await window.api.fixture.inspect()
  expect(attached.commands === before.commands, 'renderer startup submitted a volume command')
  expect(attached.revision === before.revision, 'renderer startup eagerly persisted the 70% default')
  await player.setVolume(next)
  await nextTick()
  expect(player.volume.value === next, 'Core did not acknowledge the requested volume')
  // A cached shell startup must not override acknowledged Core state, even
  // while its 350 ms settings write is still pending.
  settings.hydrateStartupSnapshot(startup)
  expect(player.volume.value === next, 'cached startup replaced acknowledged Core volume')
  await delay(150)
  const pending = await window.api.fixture.inspect()
  expect(pending.saved === expected, 'Core volume preference was written before its debounce')
  let persisted = false
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await window.api.fixture.inspect()).saved === next) {
      persisted = true
      break
    }
    await delay(10)
  }
  expect(persisted, 'Core volume debounce did not save without an exit flush')
  // Flush a genuinely changed value before its timer, then restore the final
  // volume through the same Core command. The renderer never writes settings.
  const temporary = next === 0 ? 0.01 : next / 2
  await player.setVolume(temporary)
  await core.command('lifecycle.flush', {})
  expect((await window.api.fixture.inspect()).saved === temporary, 'Core flush did not persist the pending volume')
  await player.setVolume(next)
  await core.command('lifecycle.flush', {})
  expect((await window.api.fixture.inspect()).saved === next, 'Core final flush did not reach disk')
  const current = settings.settings.value
  const resumed = settings.hydrateStartupSnapshot(startup)
  await nextTick()
  expect(resumed === toRaw(current), 'shell remount replaced live settings with the cached startup snapshot')
  expect(settings.settings.value.softwareVolume === next, 'shell remount reset the settings projection')
  expect(player.volume.value === next, 'shell remount reset the player projection')
  const flushed = await window.api.fixture.inspect()
  await delay(400)
  const settled = await window.api.fixture.inspect()
  expect(settled.revision === flushed.revision, 'flush left a duplicate scheduled volume write')
  expect(settled.saved === next, 'cached startup overwrote persisted Core volume')
}
`
}

function preloadSource(): string {
  return `const {contextBridge,ipcRenderer}=require('electron')
const {coreApi}=require('./src/preload/domains/coreApi.ts')
contextBridge.exposeInMainWorld('api', {
  core: coreApi,
  settings: {
    get: () => ipcRenderer.invoke('fixture:settings'),
    onChanged: callback => {
      const handler = (_event, snapshot) => callback(snapshot)
      ipcRenderer.on('fixture:settings-changed', handler)
      return () => ipcRenderer.removeListener('fixture:settings-changed', handler)
    }
  },
  fixture: { inspect: () => ipcRenderer.invoke('fixture:inspect') }
})`
}

function runnerSource(): string {
  return String.raw`const { app, BrowserWindow, ipcMain, utilityProcess, MessageChannelMain } = require('electron')
const { mkdirSync, existsSync, readFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { CoreWindowBridge, CORE_WINDOW_POLICIES } = require('./src/main/coreProcess/windowBridge.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const target = process.argv[2], root = process.argv[3], profile = join(dirname(target), 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const file = join(profile, 'settings.json'), alive = new Set(), volumeCommands = []
let supervisor, bridge, projectedSettings, serial = 0
const settingsSnapshot = () => ({
  settings: projectedSettings.settings, defaults: {}, paths: {},
  appVersion: 'test', platform: process.platform, restartReasons: []
})
const savedVolume = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).softwareVolume : 0.7
app.whenReady().then(async () => {
  try {
    const entries = Object.fromEntries(Object.entries({
      core: 'musicCore', audio: 'audioEngineService', 'audio-test': 'audioEngineService',
      database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService', plugin: 'pluginHost'
    }).map(([name, entry]) => [name, join(root, 'out/main', entry + '.js')]))
    supervisor = new CoreSupervisor({
      entries,
      configuration: {
        root: profile, libraryFilePath: join(profile, 'music-library.json'),
        coverCacheDir: join(profile, 'music-cache', 'cover-cache'), libraryStorage: 'sqlite'
      },
      readyTimeoutMs: 30_000, requestTimeoutMs: 10_000, stopTimeoutMs: 5_000,
      platform: {
        ...createDspCorePlatform(),
        'downloads.authorizedRoots': async ({ libraryFolders }) => ({ libraryRoots: libraryFolders, downloadRoot: null }),
        'settings.authorizePaths': async paths => paths,
        'artwork.remotePreview': async () => null
      },
      fork(entry, args, serviceName) {
        const child = utilityProcess.fork(entry, args, { serviceName, stdio: 'pipe' })
        alive.add(child)
        child.once('exit', () => alive.delete(child))
        child.stdout?.on('data', data => process.stdout.write(data))
        child.stderr?.on('data', data => process.stderr.write(data))
        return child
      },
      channel: () => new MessageChannelMain()
    })
    supervisor.on('settings', state => {
      projectedSettings = state
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('fixture:settings-changed', settingsSnapshot())
    })
    const request = supervisor.request.bind(supervisor)
    supervisor.request = (id, envelope, signal) => {
      if (envelope.kind === 'command' && envelope.name === 'playback.volume') volumeCommands.push(envelope.payload.volume)
      return request(id, envelope, signal)
    }
    const identity = { id: 'volume:migration', role: 'system', permissions: ['migration:write'] }
    supervisor.connect(identity)
    const initialized = once(supervisor, 'initialized')
    const starting = supervisor.start(); void starting.catch(() => {})
    await initialized
    const migration = (name, payload) => supervisor.request(identity.id, {
      kind: 'command', name, payload, epoch: supervisor.getStatus().epoch, requestId: 'volume:' + ++serial
    })
    await migration('migration.begin', { id: 'volume-upgrade', manifest: { version: 1, counts: emptyCoreStateCounts() } })
    await migration('migration.commit', { id: 'volume-upgrade' })
    await starting
    supervisor.disconnect(identity.id)
    assert.equal(projectedSettings.settings.softwareVolume, 0.7)
    assert.equal(savedVolume(), 0.7)
    ipcMain.handle('fixture:settings', settingsSnapshot)
    ipcMain.handle('fixture:inspect', () => ({
      saved: savedVolume(), revision: projectedSettings.revision, commands: volumeCommands.length
    }))
    bridge = new CoreWindowBridge({ supervisor, ipc: ipcMain, trustedUrl: url => url.startsWith('file:') })
    for (const [expected, next] of [[0.7, 0.22], [0.22, 0], [0, 1], [1, 0.36]]) {
      const window = new BrowserWindow({ show: false, webPreferences: {
        preload: join(dirname(target), 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false
      } })
      bridge.register(window.webContents, CORE_WINDOW_POLICIES.desktop)
      window.webContents.on('console-message', event => console.error('RENDERER', event.message))
      await window.loadFile(target)
      await window.webContents.executeJavaScript('window.runVolumeRestart(' + expected + ',' + next + ')')
      window.destroy()
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      assert.equal(savedVolume(), next)
    }
    assert.deepEqual(volumeCommands, [0.22, 0.11, 0.22, 0, 0.01, 0, 1, 0.5, 1, 0.36, 0.18, 0.36])
    bridge.dispose()
    await supervisor.shutdown()
    assert.equal(savedVolume(), 0.36)
    assert.equal(alive.size, 0)
    console.error('VOLUME_RESTART_OK')
    app.exit(0)
  } catch (error) {
    console.error('VOLUME_RESTART_FAILED', error && error.stack || error)
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    bridge?.dispose()
    await supervisor?.shutdown().catch(error => console.error('SHUTDOWN', error))
    app.exit(1)
  }
})`
}
