'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createServer } = require('node:http')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { createRequire } = require('node:module')
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real zero-window Core owns Cast transport and main stops the loopback receiver after Core death',
  { timeout: 90000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-cast-'))
    const actions = []
    let state = 'STOPPED',
      position = 0,
      mediaUrl = ''
    const server = createServer(async (req, res) => {
      if (req.url === '/finish') {
        state = 'STOPPED'
        position = 60
        res.end()
        return
      }
      const action = String(req.headers.soapaction).split('#')[1]?.replace('"', '')
      let body = ''
      for await (const chunk of req) body += chunk
      actions.push(action)
      if (action === 'SetAVTransportURI')
        mediaUrl = /<CurrentURI>(.*?)<\/CurrentURI>/.exec(body)[1].replaceAll('&amp;', '&')
      if (action === 'Play') state = 'PLAYING'
      if (action === 'Pause') state = 'PAUSED_PLAYBACK'
      if (action === 'Stop') state = 'STOPPED'
      if (action === 'Seek') {
        const time = /<Target>(.*?)<\/Target>/.exec(body)[1].split(':').map(Number)
        position = time[0] * 3600 + time[1] * 60 + time[2]
      }
      const time = [Math.floor(position / 3600), Math.floor(position / 60) % 60, position % 60]
        .map(value => String(value).padStart(2, '0')).join(':')
      res.end(
        '<Envelope><Body><CurrentTransportState>' +
          state +
          '</CurrentTransportState><RelTime>' +
          time +
          '</RelTime><TrackDuration>00:01:00</TrackDuration></Body></Envelope>'
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const device = {
      id: 'loopback-only',
      protocol: 'dlna',
      friendlyName: 'Silent fixture',
      manufacturer: 'Test',
      modelName: 'Fake',
      location: 'http://127.0.0.1',
      avTransportUrl: `http://127.0.0.1:${server.address().port}/control`,
      renderingControlUrl: null,
      lastSeenAt: 0
    }
    const common = {
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      define: {
        'import.meta.url': JSON.stringify(
          require('node:url').pathToFileURL(join(root, 'package.json')).href
        )
      }
    }
    try {
      // Only the test build replaces discovery. Production has no injected device,
      // arbitrary backend path or environment switch; real SOAP/HTTP remain intact.
      await build({
        ...common,
        entryPoints: [join(root, 'src/main/coreProcess/entry.ts')],
        packages: 'external',
        banner: { js: `module.paths.unshift(${JSON.stringify(join(root, 'node_modules'))});` },
        outfile: join(directory, 'cast-core.cjs'),
        plugins: [
          {
            name: 'loopback-discovery',
            setup(builder) {
              builder.onLoad({ filter: /core[\\/]cast[\\/]backend\.ts$/ }, async (args) => {
                const text = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n')
                const contents = text.replace(
                  /discover: async \(\) => \{[\s\S]*?\n    \},\n    load:/,
                  `discover: async () => [${JSON.stringify(device)}],\n    load:`
                )
                assert.notEqual(contents, text)
                return { contents, loader: 'ts', resolveDir: dirname(args.path) }
              })
            }
          }
        ]
      })
      await build({
        ...common,
        stdin: { contents: fixture, resolveDir: root },
        outfile: join(directory, 'runner.cjs')
      })
      await build({
        ...common,
        stdin: { contents: silentAudio, resolveDir: root },
        outfile: join(directory, 'silent-audio.cjs')
      })
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), root, `http://127.0.0.1:${server.address().port}`],
        { env, windowsHide: true, timeout: 80000, maxBuffer: 2 * 1024 * 1024 }
      )
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')), {
        windows: 0,
        loads: 2,
        supervisedStops: 1,
        recoveredPaused: true,
        retainedOccurrence: true,
        sleptHeadless: true,
        timerRestored: true
      })
      assert.equal(actions.filter((action) => action === 'SetAVTransportURI').length, 2)
      assert.equal(state, 'STOPPED')
      assert.ok(mediaUrl.includes('/media/'))
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-cast-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { CastOutputSupervisor } = require('./src/main/coreProcess/castOutputSupervisor.ts')
const { dlnaStop } = require('./src/core/cast/dlnaClient.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile'), children = [], alive = new Set()
mkdirSync(profile)
app.setPath('userData', profile); app.disableHardwareAcceleration()
let supervisor, serial = 0, supervisedStops = 0
const output = new CastOutputSupervisor(async target => { supervisedStops++; await dlnaStop(target.controlUrl) })
const identity = { id: 'test:desktop', role: 'desktop', permissions: ['playback:read', 'playback:write', 'library:read', 'migration:write', 'settings:read', 'settings:write'] }
async function main() {
  await app.whenReady()
  const file = join(profile, 'one.wav'), library = join(profile, 'music-library.json')
  writeFileSync(file, 'silent-media-fixture')
  writeFileSync(library, JSON.stringify({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [{ id: 'one', title: 'One', source: 'local', filePath: file, duration: 60 }] }))
  supervisor = new CoreSupervisor({
    configuration: { root: profile, libraryFilePath: library, coverCacheDir: join(profile, 'covers'), libraryStorage: 'sqlite', resumeMode: 'trackAndPosition' },
    entries: { core: join(__dirname, 'cast-core.cjs'), audio: join(__dirname, 'silent-audio.cjs'), ...Object.fromEntries(Object.entries({ database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService' }).map(([key, name]) => [key, join(root, 'out/main', name + '.js')])) },
    readyTimeoutMs: 30000, requestTimeoutMs: 15000, stopTimeoutMs: 5000,
    stopOutputs: () => output.stop(),
    platform: {
      'downloads.authorizedRoots': async ({libraryFolders}) => ({libraryRoots: libraryFolders, downloadRoot: null}),
      ...createDspCorePlatform(),
      'cast.arm': async ({ target }, signal) => { signal.throwIfAborted(); output.arm(target) },
      'cast.disarm': async ({ deviceId }) => output.disarm(deviceId),
      'paths.prepareAudio': async ({ source }) => { assert.equal(source, file); return source },
      'paths.authorizeAudio': async ({ source }) => { assert.equal(source, file); return source },
      'paths.authorizeAudioFile': async ({ path }) => { assert.equal(path, file); return path },
      'artwork.normalizeCachedCover': async () => null
    },
    fork(entry, args, serviceName) {
      const child = utilityProcess.fork(entry, args, { serviceName, stdio: 'pipe' })
      children.push({ child, serviceName }); alive.add(child)
      child.once('exit', () => alive.delete(child))
      child.stdout.on('data', data => process.stdout.write(data))
      child.stderr.on('data', data => process.stderr.write(data))
      return child
    },
    channel: () => new MessageChannelMain()
  })
  supervisor.on('failure', error => console.error('[cast-headless]', error))
  supervisor.connect(identity)
  const request = (kind, name, payload = {}) => supervisor.request(identity.id, { kind, name, payload, epoch: supervisor.getStatus().epoch, requestId: 'request:' + ++serial })
  const initialized = once(supervisor, 'initialized'), started = supervisor.start(); void started.catch(() => {})
  await initialized
  await request('command', 'migration.begin', { id: 'empty-profile', manifest: { version: 1, counts: emptyCoreStateCounts() } })
  await request('command', 'migration.commit', { id: 'empty-profile' })
  await started
  await request('command', 'queue.fromQuery', { query: { ids: ['one'], sort: 'playlist' }, selectedId: 'one', play: false })
  await request('command', 'cast.discover')
  const initial = await request('query', 'state.snapshot')
  await request('command', 'cast.start', { revision: initial.cast.revision, deviceId: 'loopback-only', queue: { id: initial.queue.id, revision: initial.queue.revision, occurrenceId: initial.queue.occurrenceId } })
  await request('command', 'playback.seek', { position: 37 })
  await assert.rejects(request('command', 'audio.outputTest.play', { revision: (await request('query', 'audio.output')).revision, exclusive: false }), /请先暂停当前歌曲/)
  for (let i = 0; i < 5; i++) {
    supervisor.disconnect(identity.id); supervisor.connect(identity)
    const attached = await request('query', 'state.snapshot')
    assert.equal(attached.queue.occurrenceId, initial.queue.occurrenceId)
    assert.equal(attached.playback.position, 37)
    assert.equal(attached.playback.outputBackend, 'cast')
  }
  const settings = await request('query', 'settings.state')
  await request('command', 'settings.edit', { revision: settings.revision, patch: { sleepTimer: { defaultMinutes: 30, fadeSeconds: 0 } } })
  // Lose the accepted timer reply. The observer only reads it after reconnect;
  // no client manufactures an EOF or executes Stop.
  const loseTimerReply = (id, message) => {
    if (id === identity.id && message.kind === 'state' && message.snapshot.sleepTimer?.timer?.active) {
      supervisor.off('client-message', loseTimerReply)
      supervisor.disconnect(identity.id)
    }
  }
  supervisor.on('client-message', loseTimerReply)
  await assert.rejects(request('command', 'sleep.configure', { revision: (await request('query', 'sleep.state')).revision, mode: 'trackEnd' }), error => error.code === 'OUTCOME_UNKNOWN')
  await fetch(process.argv[3] + '/finish', { method: 'POST' })
  await new Promise(resolve => setTimeout(resolve, 2200))
  supervisor.connect(identity)
  const slept = await request('query', 'state.snapshot')
  assert.equal(slept.playback.state, 'stopped')
  assert.equal(slept.queue.occurrenceId, initial.queue.occurrenceId)
  assert.equal(slept.sleepTimer.timer.triggered, true)
  assert.equal(slept.sleepTimer.timer.shutdownOwner, 'core')
  assert.equal(readFileSync(join(profile, 'playback-session.json'), 'utf8').includes('"sleepTimer"'), false)
  await request('command', 'playback.play', { position: 37 })
  await request('command', 'sleep.configure', { revision: (await request('query', 'sleep.state')).revision, mode: 'minutes', minutes: 30 })
  const armedTimer = await request('query', 'sleep.state')
  await request('command', 'lifecycle.flush')
  const epoch = supervisor.getStatus().epoch
  const recovered = new Promise((resolve, reject) => supervisor.on('status', status => {
    if (status.phase === 'failed') reject(Error('Core recovery failed'))
    if (status.phase === 'ready' && status.epoch !== epoch) resolve()
  }))
  children.find(row => row.serviceName === 'twilight-core').child.kill()
  await recovered
  const current = await request('query', 'state.snapshot')
  assert.equal(current.playback.state, 'paused')
  assert.equal(current.playback.position, 37)
  assert.equal(current.cast.phase, 'idle')
  assert.equal(current.queue.occurrenceId, initial.queue.occurrenceId)
  assert.deepEqual(current.sleepTimer.timer, armedTimer.timer)
  assert.equal(supervisedStops, 1)
  const calls = readFileSync(join(__dirname, 'audio-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.filter(row => row.method === 'Play' || row.method === 'Seek').length, 0)
  await supervisor.shutdown()
  assert.equal(alive.size, 0)
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ windows: BrowserWindow.getAllWindows().length, loads: 2, supervisedStops, recoveredPaused: true, retainedOccurrence: true, sleptHeadless: true, timerRestored: true }))
  app.quit()
}
main().catch(async error => { console.error(error); await supervisor?.shutdown().catch(console.error); for (const child of alive) child.kill(); app.exit(1) })
`

const silentAudio = String.raw`
const { createServicePort } = require('./src/main/services/servicePort.ts')
const { createAudioServiceCapabilities } = require('./src/shared/audioServiceContract.ts')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const port = createServicePort('audio', { silence: async () => { state = 'stopped' } })
let state = 'stopped', source = '', revision = 0
port.postMessage({ kind: 'ready', available: true, capabilities: createAudioServiceCapabilities(['ApplyDspState', 'GetDspGraphStatus']) })
port.on('message', message => {
  appendFileSync(join(__dirname, 'audio-calls.jsonl'), JSON.stringify({ method: message.method }) + '\n')
  if (message.method === 'Stop') state = 'stopped'
  if (message.method === 'Pause') state = 'paused'
  if (message.method === 'LoadQueue') source = message.args[0]?.[0]?.source ?? ''
  if (message.method === 'ApplyDspState') revision = message.args[0]
  const value = message.method === 'BridgeStatus' ? { supported: true, selected: false, hosting: false, receiving: false, connected: false, peerName: null, receiver: null, error: null } : message.method === 'GetPlaybackInfo' ? { state, source, position: 0 } : message.method === 'GetDspGraphStatus' ? { revision, nodes: [], totalLatencyFrames: 0, totalTailFrames: 0 } : null
  port.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
})
`
