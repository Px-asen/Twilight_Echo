'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm, access, symlink, mkdir } = require('node:fs/promises')
const { join, resolve, dirname, basename } = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'desktop Node host uses real SQLite, native audio and the desktop permission bridge without windows',
  { timeout: 120000 },
  async () => {
    const workspace = resolve(__dirname, '..')
    const buildRoot = resolve(process.env.TWILIGHT_DESKTOP_TEST_BUILD_ROOT || workspace)
    const staged = join(buildRoot, 'out/desktop-core')
    await access(join(staged, 'desktop-core-runtime.json'))
    await access(join(buildRoot, 'resources/audio-engine/twilight_audio_node.node'))
    // Keep the isolated profile in the authorized workspace. A staged executable
    // can inherit Windows' low-integrity label and cannot write medium-integrity TEMP.
    const fixtureRoot = join(workspace, '.artifacts', 'desktop-node-integration')
    await mkdir(fixtureRoot, { recursive: true })
    const directory = await mkdtemp(join(fixtureRoot, 'twilight-desktop-node-integration-'))
    try {
      const temporary = join(directory, 'temporary')
      await mkdir(temporary)
      await symlink(
        join(workspace, 'node_modules'),
        join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      const runner = join(directory, 'runner.cjs')
      buildSync({
        stdin: { contents: fixture, resolveDir: workspace },
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'cjs',
        define: {
          'import.meta.url': JSON.stringify(pathToFileURL(join(workspace, 'package.json')).href)
        },
        outfile: runner
      })
      const env = {
        ...process.env,
        TWILIGHT_CORE_HOST: 'node',
        TWILIGHT_METADATA_ENABLED: '0',
        TWILIGHT_LOG_SESSION_ID: 'desktop-node-integration',
        TWILIGHT_LOG_DIRECTORY: join(directory, 'profile/logs'),
        TAE_DIAGNOSTICS_DIR: join(directory, 'profile/logs/audio'),
        // SQLite's file-backed temporary tables share this isolated fixture's
        // writable directory; the Windows TEMP outside the workspace can be
        // unavailable to a restricted build executable.
        TEMP: temporary,
        TMP: temporary,
        // Only the test launcher uses its adjacent dependency junction. The
        // staged Node children resolve their own closed package tree.
        NODE_PATH: ''
      }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      delete env.TWILIGHT_DEV_METADATA_SETUP_FILE
      const execution = promisify(execFile)(
        require('electron'),
        [runner, buildRoot, '--core-host=node'],
        {
          env,
          windowsHide: true,
          timeout: 110000,
          maxBuffer: 4 * 1024 * 1024
        }
      )
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      await execution
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.equal(result.windows, 0)
      assert.equal(result.sandboxDisabled, false)
      assert.equal(result.sqlite, true)
      assert.equal(result.tracks, 2)
      assert.equal(result.desktopPathGrantAccepted, true)
      assert.equal(result.ungrantedPathRejected, true)
      assert.equal(result.databaseRecovered, true)
      assert.equal(result.coreRecovered, true)
      assert.equal(result.pluginRecovered, true)
      assert.equal(result.cancelledProvider, true)
      assert.equal(result.unknownWriteNotReplayed, true)
      assert.equal(result.audioRecovered, true)
      assert.equal(result.oldEpochRejected, true)
      assert.equal(result.recoveryKeptData, true)
      assert.equal(result.nativeCapabilitiesAccepted, true)
      assert.equal(result.nativeState, 'stopped')
      assert.equal(result.serviceBusinessMessages, 0)
      assert.ok(result.servicePorts.length >= 4)
      assert.ok(result.servicePorts.every((row) => row.ports === 1))
      assert.equal(result.remainingProcesses, 0)
      assert.ok(result.platformCalls.includes('settings.authorizePaths'))
      assert.ok(result.platformCalls.includes('dsp.environment'))
      for (const child of result.children) {
        assert.equal(resolve(child.executable), resolve(result.nodeExecutable))
        assert.match(child.entry, /\.cjs$/)
      }
    } finally {
      assert.equal(dirname(directory), resolve(fixtureRoot))
      assert.ok(basename(directory).startsWith('twilight-desktop-node-integration-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const buildRoot = process.argv[2], profile = join(__dirname, 'profile')
const music = join(profile, 'music'), extra = join(profile, 'extra'), denied = join(__dirname, 'ungranted')
const cache = join(profile, 'music-cache')
for (const folder of [profile, music, extra, denied, join(profile, 'logs'), join(profile, 'session')]) mkdirSync(folder, { recursive: true })
const plugin = join(profile, 'fixture-plugin')
mkdirSync(plugin)
writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ id: 'com.twilightecho.fixture.desktop-node', name: 'Desktop Node fixture', version: '1.0.0', description: 'Isolated integration fixture', author: 'Twilight Echo', license: 'Apache-2.0', main: 'index.mjs', type: ['provider'], apiVersion: 4, engines: { twilightEcho: '*' }, permissions: ['settings', 'network', 'library:read'] }))
writeFileSync(join(plugin, 'index.mjs'), ${JSON.stringify(`export async function activate({ settings, twilight }) {
  let active = false, cancelled = false
  await twilight.providers.register({ id: 'fixture', name: 'Fixture', capabilities: ['search', 'library', 'login', 'playlist'],
    async getProfile() { return { active, cancelled, writes: (await settings.get('writes')) ?? 0 } },
    async searchSongs(_query, _limit, _offset, invocation) {
      active = true
      await new Promise((resolve, reject) => invocation.signal.addEventListener('abort', () => { active = false; cancelled = true; reject(Error('cancelled')) }, { once: true }))
      return { items: [], total: 0 }
    },
    async likeTrack() { await settings.set('writes', ((await settings.get('writes')) ?? 0) + 1); return true },
    async fetchPlaylistTracksPage(_id, offset=0, limit=200) { return {tracks:Array.from({length:Math.max(0,Math.min(limit,1201-offset))},(_,i)=>({id:'fixture:'+String(offset+i),title:'Track '+String(offset+i),artist:'Fixture',album:'Album',duration:60,source:'fixture'})),total:1201,nextOffset:Math.min(1201,offset+limit),hasMore:offset+limit<1201} }
  })
}`)})
// Set every profile location before any production module can read settings.
app.setPath('userData', profile)
app.setPath('sessionData', join(profile, 'session'))
app.setPath('logs', join(profile, 'logs'))
app.getAppPath = () => buildRoot
const wave = Buffer.alloc(44 + 16000)
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
wave.write('data', 36); wave.writeUInt32LE(16000, 40)
const tracks = ['one', 'two'].map(id => {
  const filePath = join(music, id + '.wav'); writeFileSync(filePath, wave)
  return { id, title: id, artist: 'Desktop Node integration', album: 'Silence', duration: 1, filePath, source: 'local' }
})
const libraryFilePath = join(profile, 'music-library.json')
writeFileSync(libraryFilePath, JSON.stringify({ version: 2, revision: 0, folders: [music], exclusions: [], tracks }))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  onboardingCompleted: true, libraryFolders: [music], musicCachePath: cache,
  watchLibrary: false, launchAtLogin: false, globalShortcuts: false, discordRpcEnabled: false,
  desktopLyrics: { enabled: false }, playbackResumeMode: 'trackAndPosition', onlineLyricsFallback: false,
  autoCheckUpdate: false, smtcEnabled: false, audioExclusiveMode: false,
  audioProcessing: { loudnormEnabled: false }, remoteControlEnabled: false
}))
require('./src/adapters-node/index.ts')
const { createElectronCoreSupervisor } = require('./src/main/coreProcess/electronSupervisor.ts')
const { resolveDesktopNodeRuntime } = require('./src/main/coreProcess/desktopNodeRuntime.ts')
const { initializeLocalPathGrants, grantUserSelectedLibraryRoot } = require('./src/main/security/localPaths.ts')
const { ensureMusicCacheDirectories } = require('./src/core/providers/ncmCache.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { runtime } = require('./src/main/core/runtime.ts')
runtime.launchSettings = structuredClone(runtime.appSettings)
const children = [], alive = new Set(), platformCalls = new Set()
let supervisor, serial = 0, serviceBusinessMessages = 0, dropWrite = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(25) }
  throw Error('Timed out: ' + label)
}
const identity = { id: 'desktop:node-integration', role: 'desktop', permissions: [
  'playback:read', 'playback:write', 'library:read', 'library:write',
  'migration:write', 'settings:read', 'settings:write', 'statistics:read', 'providers:call', 'plugins:read', 'plugins:manage'
] }
const request = (kind, name, payload = {}, epoch = supervisor.getStatus().epoch, signal) => supervisor.request(identity.id, {
  kind, name, payload, epoch, requestId: 'desktop-node:' + ++serial
}, signal)
const call = (method, args = [], signal) => request('command', 'providers.call', { providerId: 'fixture', method, args }, undefined, signal)
function observe(child, name) {
  const owner = { child, name, ports: 0, pid: child.pid, executable: child.child.spawnfile,
    entry: child.child.spawnargs.find(arg => /[\\/]out[\\/]server[\\/](?:musicCore|audioEngineService|audioAnalysisService|libraryDatabaseService|libraryScanService|modelPackWorker|pluginHost)\.cjs$/.test(arg)) }
  children.push(owner); alive.add(child)
  if (name === 'twilight-core') {
    const emit = child.emit.bind(child)
    child.emit = (event, ...args) => {
      const message = args[0]
      if (dropWrite && event === 'message' && message?.kind === 'core:client-message' && message.clientId === identity.id && message.message?.kind === 'response' && message.message.ok && message.message.value === true) {
        dropWrite = false
        child.kill()
        return true
      }
      return emit(event, ...args)
    }
  }
  child.once('exit', () => alive.delete(child))
  child.stdout?.on('data', data => process.stdout.write(data))
  child.stderr?.on('data', data => process.stderr.write(data))
  const send = child.postMessage.bind(child)
  child.postMessage = (message, ports = []) => {
    if (name !== 'twilight-core') {
      if (!['core:attach-service', 'supervisor:stop-audio'].includes(message.kind)) serviceBusinessMessages++
      owner.ports += ports.length
    }
    return send(message, ports)
  }
  child.on('message', message => {
    if (name === 'twilight-core' && message?.kind === 'core:platform') platformCalls.add(message.name)
    if (name !== 'twilight-core' && message?.kind !== 'supervisor:audio-stopped') serviceBusinessMessages++
  })
}
async function main() {
  await app.whenReady()
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false)
  ensureMusicCacheDirectories(cache)
  await initializeLocalPathGrants(runtime.launchSettings)
  const staged = resolveDesktopNodeRuntime({ packaged: false, appPath: buildRoot, resourcesPath: process.resourcesPath })
  supervisor = createElectronCoreSupervisor({
    root: profile, libraryFilePath, coverCacheDir: join(cache, 'cover-cache'), libraryStorage: 'sqlite',
    musicCachePath: cache, resumeMode: 'trackAndPosition', autoMixEnabled: false,
    plugins: { appVersion: '2.0.0', hostIdleTimeoutMs: 0, bundledPlugins: [{ id: 'com.twilightecho.fixture.desktop-node', sourcePath: plugin, defaultEnabled: true }] }
  }, { observeNodeProcess: observe })
  supervisor.on('failure', error => console.error('[desktop-node expected fault/recovery]', error.message))
  supervisor.connect(identity)
  const initialized = once(supervisor, 'initialized')
  const started = supervisor.start(); void started.catch(() => {})
  await Promise.race([initialized, started])
  assert.equal((await request('query', 'state.snapshot')).migrationRequired, true)
  await request('command', 'migration.begin', { id: 'desktop-node-fixture', manifest: { version: 1, counts: emptyCoreStateCounts() } })
  await request('command', 'migration.commit', { id: 'desktop-node-fixture' })
  await started
  await until(async () => {
    const state = await request('query', 'state.snapshot')
    return !state.scan || !['running', 'paused'].includes(state.scan.state)
  }, 'startup scan completes')
  const page = await request('query', 'library.tracks', { limit: 10 })
  assert.equal(page.total, 2)
  const sqlite = readFileSync(join(profile, 'music-library.sqlite')).subarray(0, 16).toString('utf8') === 'SQLite format 3\0'
  assert.equal(sqlite, true)

  const beforePaths = await request('query', 'settings.state')
  await assert.rejects(request('command', 'settings.edit', { revision: beforePaths.revision, patch: { libraryFolders: [denied] } }), /未经用户授权/)
  assert.deepEqual((await request('query', 'settings.state')).settings.libraryFolders, [music])
  await grantUserSelectedLibraryRoot(extra)
  const updated = await request('command', 'settings.edit', {
    revision: (await request('query', 'settings.state')).revision,
    patch: { libraryFolders: [music, extra], ncmPlaybackQuality: 'hires' }
  })
  assert.ok(updated.settings.libraryFolders.includes(extra))
  assert.equal(runtime.appSettings.ncmPlaybackQuality, 'hires')
  assert.ok(platformCalls.has('settings.authorizePaths'))
  await until(async () => {
    const state = await request('query', 'state.snapshot')
    return !state.scan || !['running', 'paused'].includes(state.scan.state)
  }, 'root update scan completes')

  // These facts only exist after the real native addon capability handshake
  // and DSP ACK. Leave playback stopped, so this gate requires no audio device.
  const diagnostic = await request('query', 'audio.diagnostics', { locale: 'en-US' })
  const nativeReady = diagnostic.events.find(event => event.event === 'audio-service-ready' && event.details?.nativeRuntime)
  assert.ok(nativeReady, 'audio service published a validated native runtime')
  assert.match(nativeReady.details.nativeRuntime['twilight_audio_node.node'], /^[a-f0-9]{64}$/)
  assert.equal(diagnostic.snapshot.playback.state, 'stopped')
  assert.equal(diagnostic.snapshot.playback.nativePlaybackActive, false)
  assert.equal(diagnostic.snapshot.dspGraphStatus.error, undefined)
  assert.notEqual(diagnostic.snapshot.dspGraphStatus.applyState, 'failed')

  await until(async () => (await request('query', 'providers.list')).some(provider => provider.id === 'fixture'), 'plugin provider')
  const browse = await request('command', 'browse.open', { source: { providerId: 'fixture', method: 'fetchPlaylistTracksPage', args: ['one'], paging: { offsetArg: 1, limitArg: 2 } } })
  assert.equal(browse.loaded, 200)
  const lastPage = await request('query', 'browse.page', { id: browse.id, offset: 1000, limit: 200, complete: true })
  assert.equal(lastPage.filteredTotal, 1201)
  assert.equal(lastPage.items[0].id, 'fixture:1000')
  const saved = await request('command', 'browse.snapshot.save', { providerIds: ['fixture'], value: { sessionId: browse.id, draft: 'unsaved', anchor: 1000 } })
  assert.equal((await request('query', 'browse.snapshot', { id: saved.id })).value.draft, 'unsaved')
  await request('command', 'browse.release', { ids: [saved.id, browse.id] })
  const cancellation = new AbortController()
  const pendingSearch = call('searchSongs', ['slow', 20, 0], cancellation.signal)
  const cancelled = assert.rejects(pendingSearch, error => ['CANCELLED', 'OUTCOME_UNKNOWN'].includes(error.code))
  await until(async () => (await call('getProfile')).active, 'provider invocation')
  cancellation.abort()
  await cancelled
  await until(async () => (await call('getProfile')).cancelled, 'provider cancellation')
  const pluginProcess = children.findLast(row => row.name === 'twilight-plugin' && alive.has(row.child))
  assert.ok(pluginProcess)
  const pluginExit = once(pluginProcess.child, 'exit'); pluginProcess.child.kill(); await pluginExit
  await until(async () => (await request('query', 'plugins.list')).some(plugin => plugin.id === 'com.twilightecho.fixture.desktop-node' && plugin.status === 'failed'), 'plugin crash isolation')
  assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 2)
  await request('command', 'plugins.enable', { id: 'com.twilightecho.fixture.desktop-node' })
  assert.equal((await call('getProfile')).writes, 0)
  const beforeWriteEpoch = supervisor.getStatus().epoch
  dropWrite = true
  await assert.rejects(call('likeTrack', ['fixture:one', true]), error => error.code === 'OUTCOME_UNKNOWN')
  await until(() => supervisor.getStatus().phase === 'ready' && supervisor.getStatus().epoch !== beforeWriteEpoch, 'unknown write recovery')
  assert.equal((await call('getProfile')).writes, 1, 'an unacknowledged committed write must not replay')
  const audio = children.findLast(row => row.name === 'twilight-audio' && alive.has(row.child))
  assert.ok(audio)
  const audioExit = once(audio.child, 'exit'); audio.child.kill(); await audioExit
  await until(() => children.some(row => row.name === 'twilight-audio' && row !== audio && alive.has(row.child)), 'audio independent restart')
  await until(async () => {
    const state = await request('query', 'audio.diagnostics', { locale: 'en-US' })
    return state.snapshot.dspGraphStatus?.applyState !== 'failed' && !state.snapshot.playback.nativePlaybackActive
  }, 'audio recovery state')

  const oldEpoch = supervisor.getStatus().epoch
  const database = children.findLast(row => row.name === 'twilight-database' && alive.has(row.child))
  assert.ok(database)
  const databaseExit = once(database.child, 'exit'); database.child.kill(); await databaseExit
  assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 2)
  assert.equal(supervisor.getStatus().epoch, oldEpoch, 'database recovery preserves Core epoch')
  assert.ok(children.filter(row => row.name === 'twilight-database').length >= 2)

  const core = children.findLast(row => row.name === 'twilight-core' && alive.has(row.child))
  assert.ok(core)
  core.child.kill()
  // The first fault (the dropped write ACK above) consumed the one automatic
  // restart. A second fault must respect the existing explicit retry policy.
  await until(() => supervisor.getStatus().phase === 'failed', 'second Core fault stops automatic retry')
  await supervisor.retry()
  await until(() => supervisor.getStatus().phase === 'ready' && supervisor.getStatus().epoch !== oldEpoch, 'Core recovery')
  await assert.rejects(request('query', 'state.snapshot', {}, oldEpoch), error => error.code === 'STALE_EPOCH')
  assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 2)
  assert.equal((await request('query', 'settings.state')).settings.ncmPlaybackQuality, 'hires')
  const recovered = await request('query', 'state.snapshot')
  assert.notEqual(recovered.playback?.state, 'playing')
  assert.equal(serviceBusinessMessages, 0, 'business responses stay on direct Node peer sockets')
  await supervisor.shutdown()
  assert.equal(alive.size, 0)
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({
    windows: BrowserWindow.getAllWindows().length,
    sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), sqlite, tracks: page.total,
    desktopPathGrantAccepted: true, ungrantedPathRejected: true,
    databaseRecovered: true, coreRecovered: true, oldEpochRejected: true, recoveryKeptData: true,
    pluginRecovered: true, cancelledProvider: true, unknownWriteNotReplayed: true, audioRecovered: true,
    nativeCapabilitiesAccepted: true, nativeState: diagnostic.snapshot.playback.state,
    serviceBusinessMessages, servicePorts: children.filter(row => row.name !== 'twilight-core').map(row => ({ name: row.name, ports: row.ports })),
    platformCalls: [...platformCalls], remainingProcesses: alive.size, nodeExecutable: staged.executable,
    children: children.map(({ name, pid, executable, entry }) => ({ name, pid, executable, entry }))
  }, null, 2))
}
main().then(() => app.exit(0)).catch(async error => {
  console.error(error.stack || error)
  try { await supervisor?.forceShutdown() } catch (cleanup) { console.error(cleanup) }
  const exits = [...alive].map(child => once(child, 'exit'))
  for (const child of alive) child.kill()
  await Promise.allSettled(exits)
  app.exit(1)
})
`
