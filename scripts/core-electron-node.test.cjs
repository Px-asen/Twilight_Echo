const assert = require('node:assert/strict')
const test = require('node:test')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm, access, symlink, mkdir } = require('node:fs/promises')
const { basename, dirname, join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const { buildSync } = require('esbuild')

const workspace = resolve(__dirname, '..')
const buildRoot = resolve(process.env.TWILIGHT_DESKTOP_TEST_BUILD_ROOT || workspace)
const fixtureRoot =
  process.platform === 'win32'
    ? join(workspace, '.electron-node-test')
    : dirname(buildRoot)

test('Electron default host runs Core services via ELECTRON_RUN_AS_NODE with database/scan converged into worker_threads', async (t) => {
  for (const required of [
    join(buildRoot, 'out/main/bootstrap.js'),
    join(buildRoot, 'out/main/musicCore.js'),
    join(buildRoot, 'out/main/libraryDatabaseService.js'),
    join(buildRoot, 'out/main/libraryScanService.js'),
    join(buildRoot, 'out/main/audioEngineService.js'),
    join(buildRoot, 'resources/audio-engine/twilight_audio_node.node')
  ]) {
    await access(required)
  }

  await mkdir(fixtureRoot, { recursive: true })
  const directory = await mkdtemp(join(fixtureRoot, 'twilight-electron-node-'))
  const temporary = join(directory, 'tmp')
  await mkdir(temporary, { recursive: true })
  t.after(async () => {
    assert.equal(dirname(directory), resolve(fixtureRoot))
    assert.ok(basename(directory).startsWith('twilight-electron-node-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await symlink(
    join(workspace, 'node_modules'),
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const runner = join(directory, 'electron-node-runner.cjs')
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
    TWILIGHT_METADATA_ENABLED: '0',
    TEMP: temporary,
    TMP: temporary,
    NODE_PATH: ''
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.TWILIGHT_CORE_HOST
  delete env.TWILIGHT_CORE_WORKER_THREADS
  delete env.TWILIGHT_ISOLATE_ALL_SERVICES
  delete env.TWILIGHT_DEV_METADATA_SETUP_FILE

  const execution = promisify(execFile)(
    require('electron'),
    [runner, buildRoot],
    {
      env,
      windowsHide: true,
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024
    }
  )
  execution.child.stdout?.on('data', (data) => process.stdout.write(data))
  execution.child.stderr?.on('data', (data) => process.stderr.write(data))
  await execution

  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
  assert.equal(result.remainingProcesses, 0)
  assert.equal(result.serviceBusinessMessages, 0)
  assert.equal(result.totalTracksAfterScan, 3)
  assert.ok(!result.processNames.includes('twilight-database'))
  assert.ok(!result.processNames.includes('twilight-scan'))
  assert.ok(result.processNames.includes('twilight-core'))
  assert.ok(result.processNames.includes('twilight-audio'))
  assert.ok(result.processNames.includes('twilight-plugin'))
})

const fixture = String.raw`
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const buildRoot = process.argv[2]
const profile = join(__dirname, 'profile')
const music = join(profile, 'music')
const extra = join(profile, 'extra')
const cache = join(profile, 'music-cache')
for (const folder of [profile, music, extra, join(profile, 'logs'), join(profile, 'session')]) {
  mkdirSync(folder, { recursive: true })
}
const plugin = join(profile, 'fixture-plugin')
mkdirSync(plugin)
writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({
  id: 'com.twilightecho.fixture.electron-node',
  name: 'Electron Node fixture',
  version: '1.0.0',
  description: 'Integrated worker_threads + ELECTRON_RUN_AS_NODE fixture',
  author: 'Twilight Echo',
  license: 'Apache-2.0',
  main: 'index.mjs',
  type: ['provider'],
  apiVersion: 4,
  engines: { twilightEcho: '*' },
  permissions: ['settings', 'network', 'library:read']
}))
writeFileSync(join(plugin, 'index.mjs'), ${JSON.stringify(`export async function activate({ twilight }) {
  await twilight.providers.register({
    id: 'fixture',
    name: 'Fixture',
    capabilities: ['search', 'library'],
    async searchSongs(query) { return { items: [{ id: 'fixture:' + query, title: query, artist: 'Fixture', album: 'Album', duration: 60, source: 'fixture' }], total: 1 } }
  })
}`)})

app.setPath('userData', profile)
app.setPath('sessionData', join(profile, 'session'))
app.setPath('logs', join(profile, 'logs'))
app.getAppPath = () => buildRoot

const wave = Buffer.alloc(44 + 16000)
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
wave.write('data', 36); wave.writeUInt32LE(16000, 40)
const tracks = ['one', 'two'].map((id) => {
  const filePath = join(music, id + '.wav')
  writeFileSync(filePath, wave)
  return { id, title: id, artist: 'Electron Node', album: 'Silence', duration: 1, filePath, source: 'local' }
})
writeFileSync(join(extra, 'three.wav'), wave)
const libraryFilePath = join(profile, 'music-library.json')
writeFileSync(libraryFilePath, JSON.stringify({ version: 2, revision: 0, folders: [music], exclusions: [], tracks }))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  onboardingCompleted: true,
  libraryFolders: [music],
  musicCachePath: cache,
  watchLibrary: false,
  launchAtLogin: false,
  globalShortcuts: false,
  discordRpcEnabled: false,
  desktopLyrics: { enabled: false },
  playbackResumeMode: 'trackAndPosition',
  onlineLyricsFallback: false,
  autoCheckUpdate: false,
  smtcEnabled: false,
  audioExclusiveMode: false,
  audioProcessing: { loudnormEnabled: false },
  remoteControlEnabled: false
}))

require('./src/adapters-node/index.ts')
const { createElectronCoreSupervisor } = require('./src/main/coreProcess/electronSupervisor.ts')
const { initializeLocalPathGrants, grantUserSelectedLibraryRoot } = require('./src/main/security/localPaths.ts')
const { ensureMusicCacheDirectories } = require('./src/core/providers/ncmCache.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { runtime } = require('./src/main/core/runtime.ts')
runtime.launchSettings = structuredClone(runtime.appSettings)

const children = []
const alive = new Set()
const businessMessages = []
let supervisor, serial = 0, serviceBusinessMessages = 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, label, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await sleep(25)
  }
  throw Error('Timed out: ' + label)
}
const identity = {
  id: 'desktop:electron-node-test',
  role: 'desktop',
  permissions: [
    'playback:read', 'playback:write', 'library:read', 'library:write',
    'migration:write', 'settings:read', 'settings:write', 'statistics:read',
    'providers:call', 'plugins:read', 'plugins:manage'
  ]
}
const request = (kind, name, payload = {}, epoch = supervisor.getStatus().epoch) =>
  supervisor.request(identity.id, { kind, name, payload, epoch, requestId: 'electron-node:' + ++serial })

function observe(child, name) {
  const owner = {
    child,
    name,
    pid: child.pid,
    executable: child.child.spawnfile,
    spawnargs: child.child.spawnargs
  }
  children.push(owner)
  alive.add(child)
  child.once('exit', () => alive.delete(child))
  child.stdout?.on('data', (data) => process.stdout.write(data))
  child.stderr?.on('data', (data) => process.stderr.write(data))
  const send = child.postMessage.bind(child)
  child.postMessage = (message, ports = []) => {
    if (
      name !== 'twilight-core' &&
      !['core:attach-service', 'supervisor:stop-audio', 'diagnostics:configure'].includes(message.kind)
    ) {
      serviceBusinessMessages++
      businessMessages.push({ dir: 'out', name, kind: message?.kind })
    }
    return send(message, ports)
  }
  child.on('message', (message) => {
    if (
      name !== 'twilight-core' &&
      message?.kind !== 'supervisor:audio-stopped' &&
      !String(message?.kind || '').startsWith('diagnostics:')
    ) {
      serviceBusinessMessages++
      businessMessages.push({ dir: 'in', name, kind: message?.kind, raw: message })
    }
  })
}

async function main() {
  await app.whenReady()
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  ensureMusicCacheDirectories(cache)
  await initializeLocalPathGrants(runtime.launchSettings)

  supervisor = createElectronCoreSupervisor({
    root: profile,
    libraryFilePath,
    coverCacheDir: join(cache, 'cover-cache'),
    libraryStorage: 'sqlite',
    musicCachePath: cache,
    resumeMode: 'trackAndPosition',
    autoMixEnabled: false,
    plugins: {
      appVersion: '2.0.0',
      hostIdleTimeoutMs: 0,
      bundledPlugins: [{ id: 'com.twilightecho.fixture.electron-node', sourcePath: plugin, defaultEnabled: true }]
    }
  }, { observeNodeProcess: observe })

  supervisor.connect(identity)
  const initialized = once(supervisor, 'initialized')
  const started = supervisor.start(); void started.catch(() => {})
  await Promise.race([initialized, started])
  await request('command', 'migration.begin', { id: 'electron-node-fixture', manifest: { version: 1, counts: emptyCoreStateCounts() } })
  await request('command', 'migration.commit', { id: 'electron-node-fixture' })
  await started

  await until(async () => {
    const state = await request('query', 'state.snapshot')
    return !state.scan || !['running', 'paused'].includes(state.scan.state)
  }, 'startup scan completes')
  assert.equal((await request('query', 'library.tracks', { limit: 10 })).total, 2)
  assert.equal(readFileSync(join(profile, 'music-library.sqlite')).subarray(0, 15).toString('utf8'), 'SQLite format 3')

  await grantUserSelectedLibraryRoot(extra)
  await request('command', 'settings.edit', {
    revision: (await request('query', 'settings.state')).revision,
    patch: { libraryFolders: [music, extra] }
  })
  await until(async () => (await request('query', 'library.tracks', { limit: 10 })).total === 3, 'scan worker indexes newly added folder')

  await until(async () => (await request('query', 'providers.list')).some((p) => p.id === 'fixture'), 'plugin provider ready')
  const found = await request('command', 'providers.call', { providerId: 'fixture', method: 'searchSongs', args: ['hello'] })
  assert.equal(found.items[0].id, 'fixture:hello')

  const audio = children.findLast((row) => row.name === 'twilight-audio' && alive.has(row.child))
  assert.ok(audio)
  const audioExit = once(audio.child, 'exit')
  audio.child.kill()
  await audioExit
  await until(() => children.some((row) => row.name === 'twilight-audio' && row !== audio && alive.has(row.child)), 'audio independent restart')

  assert.equal(children.filter((row) => row.name === 'twilight-database').length, 0)
  assert.equal(children.filter((row) => row.name === 'twilight-scan').length, 0)
  assert.ok(children.length > 0)
  const expectedBootstrap = require('node:path').join('out', 'main', 'bootstrap.js')
  for (const child of children) {
    assert.equal(child.executable, process.execPath)
    assert.ok(
      child.spawnargs.some((arg) => arg.endsWith(expectedBootstrap)),
      child.name
    )
  }

  await supervisor.shutdown()
  assert.equal(alive.size, 0, 'expected all child processes exited: ' + [...alive].map((child) => child.pid).join(','))
  assert.equal(serviceBusinessMessages, 0, 'expected zero business messages through main: ' + JSON.stringify(businessMessages))

  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({
    processNames: children.map((row) => row.name),
    remainingProcesses: alive.size,
    serviceBusinessMessages,
    totalTracksAfterScan: 3
  }, null, 2))
}

main().then(() => app.exit(0)).catch(async (error) => {
  console.error(error.stack || error)
  try { await supervisor?.forceShutdown() } catch (cleanup) { console.error(cleanup) }
  const exits = [...alive].map((child) => once(child, 'exit'))
  for (const child of alive) child.kill()
  await Promise.allSettled(exits)
  app.exit(1)
})
`
