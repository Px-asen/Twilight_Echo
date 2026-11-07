'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

for (const recover of [false, true]) {
  test(`production Core survives native startup exits and ${recover ? 'recovers on request' : 'shuts down with audio unavailable'}`, { timeout: 75_000 }, async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-audio-startup-fallback-'))
    try {
      const runner = join(directory, 'runner.cjs')
      buildSync({ stdin: { contents: fixture, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs',
        packages: 'external', define: { 'import.meta.url': JSON.stringify(require('node:url').pathToFileURL(join(root, 'package.json')).href) }, outfile: runner })
      const env = { ...process.env, TWILIGHT_METADATA_ENABLED: '0', TAE_DIAGNOSTICS_DIR: join(directory, 'logs') }
      delete env.ELECTRON_RUN_AS_NODE
      const run = promisify(execFile)(require('electron'), [runner, root, String(recover)], {
        env, windowsHide: true, timeout: 65_000, maxBuffer: 1024 * 1024
      })
      run.child.stderr?.on('data', data => process.stderr.write(data))
      await run
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.equal(result.coreProcesses, 1)
      assert.equal(result.failedAudioProcesses, 3)
      assert.equal(result.audioProcesses, recover ? 4 : 3)
      assert.equal(result.phase, 'ready')
      assert.equal(result.recovery, recover ? 'succeeded' : 'failed')
      assert.equal(result.state, 'stopped')
      assert.deepEqual(result.playCalls, [])
      assert.ok(result.diagnosticEvents > 0)
      assert.equal(result.alive, 0)
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-audio-startup-fallback-'))
      await rm(directory, { recursive: true, force: true })
    }
  })
}

const fixture = String.raw`
const { app, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const root = process.argv[2], recover = process.argv[3] === 'true', profile = join(__dirname, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const brokenAudio = join(__dirname, 'broken-audio.cjs')
writeFileSync(brokenAudio, [
  "const Module = require('node:module')", 'const load = Module._load',
  'Module._load = function(name, ...args) {', '  const value = load.call(this, name, ...args)',
  "  if (!name.endsWith('twilight_audio_node.node')) return value",
  '  const copy = Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, value[key]]))',
  '  copy.EnumerateDevices = () => process.exit(255)', '  return copy', '}',
  'require(' + JSON.stringify(join(root, 'out/main/audioEngineService.js')) + ')'
].join('\n'))
let coreProcesses = 0, audioProcesses = 0, failedAudioProcesses = 0, serial = 0, injectFailure = true
const children = new Set(), playCalls = [], relays = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label) {
  for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value; await pause(25) }
  throw Error('Timed out: ' + label)
}
async function main() {
  await app.whenReady()
  const supervisor = new CoreSupervisor({
    configuration: { root: profile, libraryFilePath: join(profile, 'music-library.json'),
      coverCacheDir: join(profile, 'cover-cache'), libraryStorage: 'sqlite', resumeMode: 'trackAndPosition',
      audioConfig: { exclusiveMode: false, volume: 0, audioOutput: 'wasapi', audioDevice: 'auto', audioProcessing: { directMode: true } },
      diagnostics: { directory: join(profile, 'audio-logs'), environment: { appName: 'TwilightEcho', appVersion: '2.0.0', packaged: false,
        platform: process.platform, architecture: process.arch, osRelease: require('node:os').release(), locale: 'zh-CN', processVersions: process.versions } }
    },
    entries: Object.fromEntries(Object.entries({ core: 'musicCore', audio: 'audioEngineService', 'audio-test': 'audioEngineService',
      database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService', plugin: 'pluginHost' }).map(([name,file]) => [name, join(root, 'out/main', file + '.js')])),
    readyTimeoutMs: 20_000, requestTimeoutMs: 15_000, stopTimeoutMs: 5_000,
    platform: { ...createDspCorePlatform(), 'downloads.authorizedRoots': async ({ libraryFolders }) => ({ libraryRoots: libraryFolders, downloadRoot: null }) },
    fork(entry, args, serviceName) {
      const audio = serviceName === 'twilight-audio'
      if (audio) { audioProcesses++; if (injectFailure) failedAudioProcesses++ }
      if (serviceName === 'twilight-core') coreProcesses++
      const child = utilityProcess.fork(audio && injectFailure ? brokenAudio : entry, args, { serviceName, stdio: 'pipe' })
      children.add(child); child.once('exit', () => children.delete(child))
      child.stderr?.on('data', data => process.stderr.write(data))
      const send = child.postMessage.bind(child)
      child.postMessage = (message, ports) => {
        if (audio && message.kind === 'core:attach-service') {
          const original = ports[0], { port1, port2 } = new MessageChannelMain()
          original.on('message', ({ data }) => {
            if (data.kind === 'request' && ['Play', 'Seek', 'LoadQueue'].includes(data.method)) playCalls.push(data.method)
            port1.postMessage(data)
          })
          port1.on('message', ({ data }) => original.postMessage(data))
          original.start(); port1.start(); relays.push(original, port1)
          return send(message, [port2])
        }
        return send(message, ports)
      }
      return child
    }, channel() { return new MessageChannelMain() }
  })
  const identity = { id: 'startup-fallback-check', role: 'desktop', permissions: [
    'playback:read', 'playback:write', 'library:read', 'settings:read', 'settings:write', 'migration:write'
  ] }
  supervisor.connect(identity)
  const request = (kind, name, payload = {}) => supervisor.request(identity.id,
    { kind, name, payload, epoch: supervisor.getStatus().epoch, requestId: 'fallback-' + ++serial })
  const initialized = once(supervisor, 'initialized')
  const started = supervisor.start(); void started.catch(() => {})
  await initialized
  await request('command', 'migration.begin', { id: 'fallback-check', manifest: { version: 1, counts: emptyCoreStateCounts() } })
  await request('command', 'migration.commit', { id: 'fallback-check' })
  await started
  await until(() => failedAudioProcesses === 3, 'bounded native retries')
  await pause(1200)
  assert.equal(failedAudioProcesses, 3)
  const failed = await request('query', 'audio.recovery')
  assert.equal(failed.phase, 'failed')
  assert.match(failed.error, /255/)
  assert.equal(failed.engineAvailable, true)
  await request('query', 'library.tracks', { limit: 10 })
  const settings = await request('query', 'settings.state')
  assert.equal(settings.settings.audioProcessing.directMode, true)
  const report = await request('query', 'audio.diagnostics', { locale: 'zh-CN' })
  if (recover) {
    injectFailure = false
    await request('command', 'audio.recovery.start', { kind: 'engine' })
    await until(async () => (await request('query', 'audio.recovery')).phase === 'succeeded', 'manual audio recovery')
  }
  const final = await request('query', 'state.snapshot')
  const recovery = await request('query', 'audio.recovery')
  await supervisor.shutdown()
  await until(() => children.size === 0, 'all children exited')
  for (const port of relays) port.close()
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ coreProcesses, failedAudioProcesses, audioProcesses,
    phase: final.phase, recovery: recovery.phase, state: final.playback.state, playCalls,
    diagnosticEvents: report.events.length, alive: children.size }))
  app.exit(0)
}
main().catch(error => { console.error(error.stack || error); for (const child of children) child.kill(); app.exit(1) })
`
