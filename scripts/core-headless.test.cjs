'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm, access } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real utility Core and database communicate over private MessagePorts without a BrowserWindow',
  { timeout: 120_000 },
  async () => {
    const root = resolve(__dirname, '..')
    await access(join(root, 'out/main/musicCore.js'))
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-headless-'))
    try {
      const runner = join(directory, 'runner.cjs')
      buildSync({
        stdin: { contents: fixture, resolveDir: root },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        define: {
          'import.meta.url': JSON.stringify(
            require('node:url').pathToFileURL(join(root, 'package.json')).href
          )
        },
        outfile: runner
      })
      buildSync({
        stdin: { contents: outputTestFixture, resolveDir: root },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: join(directory, 'silent-output-test.cjs')
      })
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      env.TWILIGHT_METADATA_ENABLED = '0'
      // Native remains stopped throughout. No app instance lock or user profile is used.
      const execution = promisify(execFile)(require('electron'), [runner, root], {
        env,
        windowsHide: true,
        timeout: 110_000,
        maxBuffer: 2 * 1024 * 1024
      })
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      await execution
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.equal(result.windows, 0)
      // Source maintenance can retire an in-flight analysis worker. Every actual
      // service instance still receives exactly one direct Core MessagePort.
      assert.equal(result.privatePorts, result.servicePorts.length)
      assert.ok(result.servicePorts.every((service) => service.ports === 1))
      assert.deepEqual([...new Set(result.servicePorts.map((service) => service.name))].sort(), [
        'twilight-analysis',
        'twilight-audio',
        'twilight-audio-test',
        'twilight-database',
        'twilight-scan',
        'twilight-zone-audio'
      ])
      assert.equal(result.serviceBusinessMessages, 0)
      assert.equal(result.tracks, 2)
      assert.equal(result.migrationComplete, true)
      assert.equal(result.oldEpochRejected, true)
      assert.equal(result.recoveredPaused, true)
      assert.equal(result.databaseRecovered, true)
      assert.equal(result.scanRecovered, true)
      assert.equal(result.watcherHeadless, true)
      assert.equal(result.cueTracks, 2)
      assert.equal(result.statisticsRestored, true)
      assert.equal(result.statisticsCleared, true)
      assert.equal(result.cacheClearedHeadless, true)
      assert.equal(result.dspHeadless, true)
      assert.equal(result.outputTestHeadless, true)
      assert.equal(result.settingsHeadless, true)
      assert.equal(result.equalizerHeadless, true)
      assert.equal(result.libraryMutationsHeadless, true)
      assert.equal(result.playlistRepairHeadless, true)
      assert.equal(result.duplicatesHeadless, true)
      assert.equal(result.inboxHeadless, true)
      assert.equal(result.servicesAfterShutdown, 0)
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-headless-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain, session } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { computeAutoPreampDb } = require('./src/shared/eqResponse.ts')
const { writeFileSync, mkdirSync, readFileSync, existsSync } = require('node:fs')
const { createRemoteCoverCache } = require('./src/main/cache/remoteCoverCache.ts')
const { createPlatformCacheMaintenance } = require('./src/main/cache/platformCacheMaintenance.ts')
const { maintainCoverCache, normalizeCachedCoverHandle } = require('./src/main/library/coverCache.ts')
const { clearProtocolAssetCache } = require('./src/main/cache/protocolAssetCache.ts')
const { join } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile); app.disableHardwareAcceleration()
const children = [], alive = new Set(), ports = []
let serviceBusinessMessages = 0, serial = 0, supervisor
let tagAuthorization = null
let repairAuthorization = null
async function main() {
  await app.whenReady()
  const testCallsPath = join(__dirname, 'silent-output-test-calls.jsonl')
  const testCalls = () => existsSync(testCallsPath) ? readFileSync(testCallsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const waitForTest = async (count) => {
    for (let i = 0; i < 500; i++) {
      if (testCalls().filter(row => row.method === 'Play').length >= count) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw Error('Simulated output test did not start')
  }
  const library = join(profile, 'music-library.json')
  const music = join(profile, 'music')
  const extraMusic = join(profile, 'extra-music')
  const cacheRoot = join(profile, 'music-cache')
  mkdirSync(cacheRoot)
  const remoteCovers = createRemoteCoverCache(() => join(cacheRoot, 'cover-cache'))
  let platformCacheClears = 0
  const clearPlatformCache = createPlatformCacheMaintenance({
    root: cacheRoot, legacyCover: join(profile, 'cover-cache'),
    authorizeRoot: async () => cacheRoot,
    maintainRemote: action => remoteCovers.maintain(action),
    maintainCovers: maintainCoverCache,
    clearMemory: clearProtocolAssetCache,
    clearChromium: async () => { await session.defaultSession.clearCache(); platformCacheClears++ }
  })
  mkdirSync(music)
  const wave = Buffer.alloc(44 + 48_000)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
  wave.write('data', 36); wave.writeUInt32LE(48_000, 40)
  for (let i = 0; i < 300; i++) writeFileSync(join(music, String(i).padStart(4, '0') + '.wav'), wave)
  writeFileSync(join(music, 'cover.gif'), 'GIF89a-fixture')
  writeFileSync(join(music, 'disc.cue'), 'FILE "0000.wav" WAVE\nTRACK 01 AUDIO\nTITLE "Core Cue First"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Core Cue Second"\nINDEX 01 00:01:00\n')
  writeFileSync(library, JSON.stringify({ version: 2, revision: 0, folders: [music], exclusions: [], tracks: [
    { id: 'one', title: 'One', artist: 'Artist', album: 'Album', filePath: join(profile, 'one.wav'), duration: 1 },
    { id: 'two', title: 'Two', artist: 'Artist', album: 'Album', filePath: join(profile, 'two.wav'), duration: 1 }
  ] }))
  supervisor = new CoreSupervisor({
    configuration: { root: profile, libraryFilePath: library, coverCacheDir: join(cacheRoot, 'cover-cache'), libraryStorage: 'sqlite', resumeMode: 'trackAndPosition' },
    entries: { ...Object.fromEntries(Object.entries({ core: 'musicCore', audio: 'audioEngineService', database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService' }).map(([name, file]) => [name, join(root, 'out/main', file + '.js')])), 'audio-test': join(__dirname, 'silent-output-test.cjs') },
    readyTimeoutMs: 45_000, requestTimeoutMs: 15_000, stopTimeoutMs: 5_000,
    platform: {
      'downloads.authorizedRoots': async ({libraryFolders}) => ({libraryRoots: libraryFolders, downloadRoot: null}),
      'settings.authorizePaths': async paths => paths,
      ...createDspCorePlatform(),
      'dsp.chooseFile': async ({ kind }) => {
        assert.ok(kind === 'correctionProfile' || kind === 'profile')
        return join(profile, kind === 'profile' ? 'roundtrip.tedsp' : 'correction.apo')
      },
      'dsp.chooseExportFile': async () => join(profile, 'roundtrip.tedsp'),
      'cache.authorizeRoot': async () => cacheRoot,
      'cache.clearPlatform': (_payload, signal) => clearPlatformCache(signal),
      'paths.authorizeLibraryDirectory': async ({ path }) => {
        const canonical = require('node:path').resolve(path).toLowerCase()
        assert.ok(canonical === music.toLowerCase() || canonical === extraMusic.toLowerCase(), path)
        if (repairAuthorization) { repairAuthorization.enter(); await repairAuthorization.gate }
        return path
      },
      'paths.authorizeAudio': async () => { throw Error('No audio sources are authorized in this silent fixture') },
      'paths.authorizeAudioFile': async ({ path }) => {
        const canonical = require('node:path').resolve(path).toLowerCase()
        assert.ok(canonical.startsWith(music.toLowerCase() + require('node:path').sep) || canonical.startsWith(extraMusic.toLowerCase() + require('node:path').sep), path)
        if (tagAuthorization) { tagAuthorization.enter(); await tagAuthorization.gate }
        return path
      },
      'files.trashAudio': async () => { throw Error('No deletion is authorized in this fixture') },
      'artwork.normalizeCachedCover': async ({ handle }) => normalizeCachedCoverHandle(handle),
      'artwork.remotePreview': async () => null
    },
    fork(entry, args, serviceName) {
      const child = utilityProcess.fork(entry, args, { serviceName, stdio: 'pipe' })
      const owner = { child, serviceName, ports: 0 }
      children.push(owner); alive.add(child)
      child.once('exit', () => alive.delete(child))
      child.stdout?.on('data', data => process.stdout.write(data))
      child.stderr?.on('data', data => process.stderr.write(data))
      const post = child.postMessage.bind(child)
      child.postMessage = (message, transferred = []) => {
        if (serviceName !== 'twilight-core') {
          if (!['core:attach-service', 'supervisor:stop-audio'].includes(message.kind)) serviceBusinessMessages++
          ports.push(...transferred)
          owner.ports += transferred.length
        }
        return post(message, transferred)
      }
      return child
    },
    channel() { return new MessageChannelMain() }
  })
  supervisor.on('status', status => console.log('[headless] supervisor', status))
  supervisor.on('failure', error => console.error('[headless] failure', error))
  const projectedSettings = []
  supervisor.on('settings', (state, epoch) => projectedSettings.push({state, epoch}))
  const identity = { id: 'system:test', role: 'system', permissions: ['playback:read', 'playback:write', 'library:read', 'library:write', 'migration:write', 'statistics:read', 'statistics:write', 'settings:read', 'settings:write'] }
  supervisor.connect(identity)
  const request = (kind, name, payload = {}, epoch = supervisor.getStatus().epoch) => supervisor.request(identity.id, { kind, name, payload, epoch, requestId: 'test:' + ++serial })
  const initialized = once(supervisor, 'initialized')
  const started = supervisor.start(); void started.catch(() => {})
  await initialized
  const initial = await request('query', 'state.snapshot')
  assert.equal(initial.migrationRequired, true)
  const timestamp = Date.now() - 10_000, day = new Date(timestamp).toISOString().slice(0, 10)
  const counts = emptyCoreStateCounts(); counts['statistics-tracks'] = 1; counts['statistics-days'] = 1; counts['eq-preferences'] = 2
  await request('command', 'migration.begin', { id: 'headless-upgrade', manifest: { version: 1, counts } })
  const importedStat = { title: 'CUE segment', artist: 'Artist', seconds: 15, plays: 2, skips: 1, completions: 1, lastPlayed: timestamp, cover: null, daily: { [day]: { seconds: 15, plays: 2, skips: 1, completions: 1, lastPlayed: timestamp } }, sourceIds: [{ source: 'local', trackId: 'cue:disc:2' }], track: { id: 'cue:disc:2', title: 'CUE segment', artist: 'Artist', album: 'Disc', filePath: join(music,'0000.wav'), fileName: '0000.wav', duration: 1, size: 48044, cover: null, lyrics: null, cueRange: { startSeconds: 1, endSeconds: 2, pregapSeconds: 0 } } }
  await request('command', 'migration.stage', { id: 'headless-upgrade', batch: 0, domain: 'statistics-tracks', rows: [{ key: 'logic:cue segment::artist', value: importedStat }] })
  await request('command', 'migration.stage', { id: 'headless-upgrade', batch: 1, domain: 'statistics-days', rows: [{ key: day, value: 15 }] })
  await request('command', 'migration.stage', { id: 'headless-upgrade', batch: 2, domain: 'eq-preferences', rows: [{ key: 'autoPreamp', value: true }, { key: 'manualPreamp', value: 2.3 }] })
  // Automatic startup becomes controllable only after atomic migration publication.
  let scan, pause
  const pausedStartup = new Promise(resolve => {
    const pauseInitial = (id, message) => {
      if (id === identity.id && message.kind === 'state' && message.snapshot.scan?.state === 'running' && !pause) {
        scan = message.snapshot.scan
        pause = request('command', 'scan.pause', { jobId: scan.jobId })
        supervisor.off('client-message', pauseInitial)
        resolve(pause)
      }
    }
    supervisor.on('client-message', pauseInitial)
  })
  const migration = await request('command', 'migration.commit', { id: 'headless-upgrade' })
  await started
  assert.equal(await pausedStartup, true)
  const page = await request('query', 'library.tracks', { limit: 2 })
  assert.deepEqual(page.tracks.map(t => t.id), ['one', 'two'])
  // The production composition indexes the local catalog without a renderer,
  // and publishes only safe identity/source projections over the public API.
  for (let i = 0; i < 200; i++) {
    const status = await request('query', 'catalog.status')
    assert.notEqual(status.state, 'failed', status.error)
    if (!status.localPending && status.playlistsRevision !== null && status.versionsRevision !== null) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const catalog = await request('query', 'catalog.query', { kind: 'recording', limit: 2 })
  assert.equal(catalog.total, 2)
  const catalogSources = await request('query', 'catalog.sources', { entityId: catalog.items[0].id, revision: catalog.revision })
  assert.equal(catalogSources.items[0].provider, 'local')
  assert.doesNotMatch(JSON.stringify(catalogSources), /filePath|streamUrl|source_key/)
  assert.equal((await request('query', 'state.snapshot')).catalogRevision, catalog.revision)
  // New entity operations traverse the real Core/database ports without a UI.
  // This fixture leaves public metadata networking disabled; blocked != not_found.
  const metadataArtist = (await request('query', 'catalog.query', { kind: 'artist', limit: 1 })).items[0].id
  const metadataIdentity = await request('query', 'identification.detail', { entityId: metadataArtist })
  assert.equal(metadataIdentity.kind, 'artist')
  assert.equal(metadataIdentity.link, null)
  assert.equal((await request('query', 'identification.candidates', { entityId: metadataArtist, limit: 1 })).total, 0)
  const albumProjects = await request('query', 'catalog.query', { kind: 'album_project', limit: 1 })
  assert.ok(albumProjects.total > 0)
  assert.equal((await request('query', 'identification.detail', { entityId: albumProjects.items[0].id })).kind, 'album_project')
  const metadataPolicy = await request('query', 'metadata.entity.policy')
  assert.equal(metadataPolicy.identity, false)
  const metadataJob = await request('command', 'metadata.entity.resolve', { entityId: metadataArtist, mbid: 'a223958d-5c56-4b2c-a30a-87e357bc121b', language: 'zh-Hans', batchId: 'headless' })
  let entityJob
  for (let i = 0; i < 200; i++) {
    entityJob = (await request('query', 'metadata.entity.jobs', { jobId: metadataJob.id })).items[0]
    if (entityJob.state === 'blocked') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(entityJob.state, 'blocked')
  assert.equal(entityJob.outcome, null)
  const metadataDetail = await request('query', 'metadata.entity.detail', { entityId: metadataArtist, language: 'zh-Hans' })
  await request('command', 'metadata.entity.override', { entityId: metadataArtist, revision: metadataDetail.revision, mode: 'value', value: 'Headless user introduction', language: 'en' })
  assert.doesNotMatch(JSON.stringify(metadataDetail), /filePath|streamUrl|source_key/)
  const importedStatistics = await request('query', 'statistics.tracks', { limit: 1 })
  assert.equal(importedStatistics.items[0].plays, 2)
  assert.equal(importedStatistics.items[0].seconds, 15)
  // The imported historical ID is absent from the current library. Its counts
  // survive, while playable details must come from a live catalog record.
  assert.equal(importedStatistics.items[0].track, null)
  assert.deepEqual(importedStatistics.items[0].sourceIds, importedStat.sourceIds)
  assert.doesNotMatch(JSON.stringify(importedStatistics), /filePath|streamUrl/)
  // No route is opened: save a disconnected device profile through the public
  // Core domain and the real synchronous settings repository.
  const audioOutput = await request('query', 'audio.output')
  // Production Core -> private utility RPC -> staged native Bridge support.
  // These operations stay stopped and never open an output device.
  const zone = await request('query', 'zones.state')
  assert.equal(zone.supported, true)
  assert.equal(zone.zoneId, 'local')
  assert.equal(zone.selectedOutputId, 'local')
  assert.equal(zone.hosting, false)
  const path = await request('query', 'audio.signalPath')
  assert.equal(path.transport.kind, 'local')
  assert.equal(path.hardware, null)
  await request('command', 'zones.select', { revision: zone.revision, outputId: 'local' })
  assert.equal((await request('query', 'zones.state')).revision, zone.revision + 1)
  // Multi-Zone composition uses separate real native utility processes. Build
  // paused SQL queues and change DSP only; no decoder or output device opens.
  const zoneDesktop = { ...identity, id: 'desktop:zones', role: 'desktop' }
  supervisor.connect(zoneDesktop)
  const zoneCommand = (name, payload) => supervisor.request(zoneDesktop.id, { kind: 'command', name, payload,
    epoch: supervisor.getStatus().epoch, requestId: 'zones:' + ++serial })
  assert.equal((await request('query', 'zones.list')).zones.length, 1)
  const zoneA = (await zoneCommand('zones.create', { revision: 0, name: 'Study' })).id
  const zoneB = (await zoneCommand('zones.create', { revision: 1, name: 'Bedroom' })).id
  await zoneCommand('zones.queueFromQuery', { zoneId: zoneA, revision: 0, query: { ids: ['one'] } })
  await zoneCommand('zones.queueFromQuery', { zoneId: zoneB, revision: 0, query: { ids: ['two'] } })
  const beforeZoneDsp = await request('query', 'zones.dsp', { zoneId: zoneA })
  await zoneCommand('zones.dsp.edit', { zoneId: zoneA, revision: beforeZoneDsp.revision,
    edit: { kind: 'processing', settings: { eqPreamp: -6 } } })
  assert.equal((await request('query', 'zones.dsp', { zoneId: zoneA })).processing.eqPreamp, -6)
  assert.notEqual((await request('query', 'zones.dsp', { zoneId: zoneB })).processing.eqPreamp, -6)
  await zoneCommand('zones.transport', { zoneId: zoneB, revision: null, action: { kind: 'pause' } })
  const independentZones = (await request('query', 'zones.list')).zones
  const aQueue = independentZones.find(z => z.id === zoneA).queue.id
  let bQueue = independentZones.find(z => z.id === zoneB).queue.id
  assert.notEqual(aQueue, bQueue)
  assert.equal(independentZones.find(z => z.id === zoneA).track.id, 'one')
  assert.equal(independentZones.find(z => z.id === zoneB).track.id, 'two')
  assert.equal(independentZones.find(z => z.id === zoneA).output.selected, true)
  await assert.rejects(zoneCommand('zones.transport', { zoneId: zoneA, revision: 1, action: { kind: 'play' } }), /未连接/)
  assert.equal((await request('query', 'zones.list')).zones.find(z => z.id === zoneB).queue.id, bQueue)
  assert.equal((await request('query', 'state.snapshot')).queue, null)
  const transferZones = (await request('query', 'zones.list')).zones
  const endpoint = id => {
    const zone = transferZones.find(z => z.id === id), q = zone.queue
    return { zoneId: id, revision: zone.revision, queue: q ? { id: q.id, revision: q.revision, occurrenceId: q.occurrenceId } : null }
  }
  const transfer = { source: endpoint(zoneA), target: endpoint(zoneB), replace: false, resume: false }
  await assert.rejects(zoneCommand('zones.handoff', transfer), /确认替换/)
  await zoneCommand('zones.handoff', { ...transfer, replace: true })
  const handed = (await request('query', 'zones.list')).zones
  const targetZone = handed.find(z => z.id === zoneB)
  assert.notEqual(targetZone.queue.id, bQueue)
  bQueue = targetZone.queue.id
  assert.notEqual(bQueue, aQueue)
  assert.equal(targetZone.track.id, 'one')
  assert.equal(targetZone.playback.state, 'paused')
  assert.equal(handed.find(z => z.id === zoneA).queue.id, aQueue)
  assert.equal(handed.find(z => z.id === zoneA).playback.state, 'paused')
  assert.notEqual((await request('query', 'zones.dsp', { zoneId: zoneB })).processing.eqPreamp, -6)
  const grouping = await request('query', 'zones.list')
  const sourceZone = grouping.zones.find(z => z.id === zoneA)
  const groupId = (await zoneCommand('groups.create', { revision: grouping.revision, name: 'Headless group',
    members: grouping.zones.filter(z => z.id !== 'local').map(z => ({ zoneId: z.id, revision: z.revision, downstreamDelayMs: z.id === zoneB ? 3 : 0 })),
    source: { zoneId: zoneA, queue: { id: sourceZone.queue.id, revision: sourceZone.queue.revision, occurrenceId: sourceZone.queue.occurrenceId } }
  })).id
  const shared = (await request('query', 'groups.list')).groups[0]
  const sharedQueue = shared.queue.id
  assert.equal(shared.playback.state, 'paused')
  assert.notEqual(sharedQueue, aQueue); assert.notEqual(sharedQueue, bQueue)
  await assert.rejects(zoneCommand('zones.transport', { zoneId: zoneA, revision: null, action: { kind: 'play' } }))
  const member = (await request('query', 'zones.list')).zones.find(z => z.id === zoneA)
  await assert.rejects(zoneCommand('zones.transport', { zoneId: zoneA, revision: member.revision, action: { kind: 'play' } }), /同步组/)
  await zoneCommand('groups.transport', { groupId, revision: null, action: { kind: 'pause' } })
  supervisor.disconnect(zoneDesktop.id)
  assert.equal((await request('query', 'state.snapshot')).playback.state, 'stopped')
  const audioProfiles = await request('query', 'audio.profiles')
  const savedProfile = { ...audioProfiles.profiles.current, id: 'headless-dac', name: 'Headless DAC', stableDeviceId: 'fixture-disconnected-dac' }
  await request('command', 'audio.profiles.edit', { revision: audioProfiles.revision, edit: { kind: 'save', profile: savedProfile } })
  assert.equal(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).audioDeviceProfiles.profiles[0].id, savedProfile.id)
  let staleOutputRejected = false
  try { await request('command', 'audio.output.edit', { revision: audioOutput.revision, edit: { kind: 'exclusive', enabled: true } }) } catch (error) { staleOutputRejected = error.code === 'STALE_REVISION' }
  assert.equal(staleOutputRejected, true)
  writeFileSync(join(profile, 'correction.apo'), 'Preamp: -3 dB\nFilter 1: ON PK Fc 100 Hz Gain -2 dB Q 1\n')
  const initialDsp = await request('query', 'audio.dsp')
  assert.deepEqual(initialDsp.autoPreamp, { enabled: true, manualDb: 2.3 })
  assert.deepEqual(await request('query', 'audio.audition'), { revision: initialDsp.revision, measuring: false, result: null })
  assert.deepEqual(await request('query', 'audio.outputTest'), { revision: initialDsp.revision, active: false })
  await assert.rejects(request('command', 'audio.outputTest.play', { revision: initialDsp.revision, exclusive: false }), error => error.code === 'FORBIDDEN')
  const desktop = { ...identity, id: 'desktop:output-test', role: 'desktop' }
  supervisor.connect(desktop)
  const testRequest = (name, payload = {}) => supervisor.request(desktop.id, { kind: name === 'audio.outputTest' ? 'query' : 'command', name, payload, epoch: supervisor.getStatus().epoch, requestId: 'output-test:' + ++serial })
  const testPlaying = testRequest('audio.outputTest.play', { revision: (await request('query', 'audio.output')).revision, exclusive: false })
  const lostTestReply = assert.rejects(testPlaying, error => error.code === 'OUTCOME_UNKNOWN')
  await waitForTest(1)
  supervisor.disconnect(desktop.id)
  await lostTestReply
  supervisor.connect(desktop)
  assert.equal((await testRequest('audio.outputTest')).active, true)
  const simulatedSource = testCalls().find(row => row.method === 'Play').args[0]
  assert.equal(existsSync(simulatedSource), true)
  await testRequest('audio.outputTest.stop')
  assert.equal((await testRequest('audio.outputTest')).active, false)
  assert.equal(existsSync(simulatedSource), false)
  assert.equal([...alive].some(child => children.find(row => row.child === child)?.serviceName === 'twilight-audio-test'), false)
  assert.equal(testCalls().filter(row => row.method === 'supervisor:stop-audio').length, 1)
  assert.equal((await request('query', 'state.snapshot')).queue, null)
  assert.deepEqual(await request('query', 'statistics.tracks', { limit: 1 }), importedStatistics)
  supervisor.disconnect(desktop.id)
  const correction = await request('command', 'audio.dsp.import', { revision: (await request('query', 'audio.dsp')).revision, kind: 'correctionProfile' })
  assert.equal(correction.profile.preampDb, -3)
  const dspState = await request('query', 'audio.dsp')
  const scenes = dspState.scenes.scenes
  scenes[0].graph.nodes.push({ id: 'headless-correction', type: 'equalizer', enabled: false, params: { correctionProfileAssetId: correction.asset.id } })
  await request('command', 'audio.dsp.edit', { revision: dspState.revision, edit: { kind: 'scenes', scenes, pinnedSceneId: null } })
  const dspAssets = await request('query', 'audio.dsp.assets', { limit: 1 })
  assert.equal(dspAssets.items[0].referenceCount, 1)
  await request('command', 'audio.dsp.export', { revision: dspAssets.revision, name: 'Headless round trip' })
  await request('command', 'audio.dsp.import', { revision: (await request('query', 'audio.dsp')).revision, kind: 'profile' })
  assert.equal((await request('query', 'audio.dsp.correction', { id: correction.asset.id })).bands[0].gain, -2)
  assert.equal((await request('query', 'audio.vst3', { limit: 1 })).items.length, 0)
  // Core owns auto headroom even with every EQ panel/window absent. Keep DSP
  // master and EQ bypassed, so native configuration never opens a playback route.
  const equalizerBands = [{ frequency: 1000, gain: 8, q: 1, filterType: 'peak' }]
  await request('command', 'audio.dsp.edit', { revision: (await request('query', 'audio.dsp')).revision, edit: { kind: 'processing', settings: { dspEnabled: false, eqEnabled: false, eqMode: 'parametric', eqBands: equalizerBands, eqPreamp: 2.3 } } })
  const lostEqualizerProjection = state => {
    if (state.settings.audioEqAutoPreamp?.enabled) {
      supervisor.off('settings', lostEqualizerProjection)
      supervisor.disconnect(identity.id)
    }
  }
  supervisor.on('settings', lostEqualizerProjection)
  await assert.rejects(
    request('command', 'audio.dsp.edit', { revision: (await request('query', 'audio.dsp')).revision, edit: { kind: 'autoPreamp', enabled: true } }),
    error => error.code === 'OUTCOME_UNKNOWN'
  )
  supervisor.connect(identity)
  const equalizerState = await request('query', 'audio.dsp')
  assert.deepEqual(equalizerState.autoPreamp, { enabled: true, manualDb: 2.3 })
  assert.equal(equalizerState.processing.eqPreamp, computeAutoPreampDb(equalizerBands))
  assert.equal(equalizerState.processing.dspEnabled, false)
  assert.equal((await request('query', 'state.snapshot')).playback.state, 'stopped')
  const epoch = supervisor.getStatus().epoch
  // Disconnecting/re-attaching clients is a pure state operation.
  for (let i = 0; i < 5; i++) {
    supervisor.disconnect(identity.id); supervisor.connect(identity)
    const state = await request('query', 'state.snapshot')
    assert.equal(state.playback.state, 'stopped')
    assert.equal(state.queue, null)
    assert.deepEqual(await request('query', 'statistics.tracks', { limit: 1 }), importedStatistics)
  }
  console.log('[headless] automatic startup remains paused', scan.jobId)
  assert.equal((await request('query', 'scan.status')).state, 'paused')
  // Aggregate cache maintenance reaches the existing scanner over its private
  // port. Neither a durable Pause nor a cache clear may restart that scan.
  writeFileSync(join(cacheRoot, 'personal-file'), 'user-owned')
  for (const name of ['audio-engine-cache', 'ncm-cache', 'network-cache', 'renderer-cache']) {
    mkdirSync(join(cacheRoot, name), { recursive: true })
    writeFileSync(join(cacheRoot, name, 'stale'), name)
  }
  await remoteCovers.write('https://example.test/cover', 'image/png', new Uint8Array([1,2]))
  assert.ok((await request('query', 'cache.info')).sizeBytes > 0)
  await request('command', 'cache.clear')
  assert.equal((await request('query', 'scan.status')).state, 'paused')
  assert.equal((await request('query', 'state.snapshot')).playback.state, 'stopped')
  assert.equal(platformCacheClears, 1)
  for (const name of ['audio-engine-cache', 'ncm-cache', 'network-cache']) assert.equal(existsSync(join(cacheRoot, name, 'stale')), false)
  assert.equal(await remoteCovers.read('https://example.test/cover'), null)
  assert.equal(readFileSync(join(cacheRoot, 'personal-file'), 'utf8'), 'user-owned')
  assert.equal(readFileSync(join(cacheRoot, 'renderer-cache', 'stale'), 'utf8'), 'renderer-cache')
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  const newReady = new Promise((resolve, reject) => supervisor.on('status', status => {
    if (status.phase === 'failed') reject(Error('Core recovery failed'))
    if (status.phase === 'ready' && status.epoch !== epoch) resolve()
  }))
  const beforeCrashSettings = await request('query', 'settings.state')
  await request('command', 'settings.edit', { revision: beforeCrashSettings.revision, patch: { ncmPlaybackQuality: 'hires' } })
  // Leave the simulated test service active during real Core death. No native
  // audio output is used by this fixture; the test service only records calls.
  supervisor.connect(desktop)
  const crashedTest = testRequest('audio.outputTest.play', { revision: (await request('query', 'audio.output')).revision, exclusive: false })
  const crashedTestReply = assert.rejects(crashedTest, error => error.code === 'OUTCOME_UNKNOWN')
  await waitForTest(2)
  const stopsBeforeCrash = testCalls().filter(row => row.method === 'supervisor:stop-audio').length
  // Lose the resume reply after its durable state change. No client remains;
  // the new Core must recover the task without replaying that old command.
  const crashOnResume = (id, message) => {
    if (id === identity.id && message.kind === 'state' && message.snapshot.scan?.jobId === scan.jobId && message.snapshot.scan.state === 'running') {
      supervisor.off('client-message', crashOnResume)
      console.log('[headless] crash after resume')
      supervisor.disconnect(identity.id)
      children.find(p => p.serviceName === 'twilight-core').child.kill()
    }
  }
  supervisor.on('client-message', crashOnResume)
  await assert.rejects(request('command', 'scan.resume', { jobId: scan.jobId }), e => e.code === 'OUTCOME_UNKNOWN')
  console.log('[headless] resume outcome unknown')
  await newReady
  await crashedTestReply
  supervisor.disconnect(desktop.id)
  assert.equal(testCalls().filter(row => row.method === 'supervisor:stop-audio').length - stopsBeforeCrash, 1)
  console.log('[headless] Core recovered')
  supervisor.connect(identity)
  let oldEpochRejected = false
  try { await request('command', 'playback.pause', {}, epoch) } catch (e) { oldEpochRejected = e.code === 'STALE_EPOCH' }
  const recovered = await request('query', 'state.snapshot')
  const recoveredZones = (await request('query', 'zones.list')).zones
  assert.equal(recoveredZones.length, 3)
  assert.equal(recoveredZones.find(z => z.id === zoneA).queue.id, aQueue)
  assert.equal(recoveredZones.find(z => z.id === zoneB).queue.id, bQueue)
  assert.equal(recoveredZones.find(z => z.id === zoneB).playback.state, 'paused')
  assert.equal((await request('query', 'zones.dsp', { zoneId: zoneA })).processing.eqPreamp, -6)
  const restoredGroup = (await request('query', 'groups.list')).groups[0]
  assert.equal(restoredGroup.id, groupId); assert.equal(restoredGroup.queue.id, sharedQueue)
  assert.equal(restoredGroup.playback.state, 'paused')
  assert.ok(recoveredZones.filter(z => z.id !== 'local').every(z => z.groupId === groupId))
  supervisor.connect(zoneDesktop)
  await zoneCommand('groups.remove', { groupId, revision: restoredGroup.revision })
  assert.equal((await request('query', 'groups.list')).groups.length, 0)
  const ungrouped = (await request('query', 'zones.list')).zones.filter(z => z.id !== 'local')
  assert.deepEqual(ungrouped.map(z => z.queue.id), [aQueue, bQueue])
  assert.ok(ungrouped.every(z => !z.groupId && z.playback.state === 'paused'))
  supervisor.disconnect(zoneDesktop.id)
  const recoveredMetadata = await request('query', 'metadata.entity.detail', { entityId: metadataArtist, language: 'en' })
  assert.equal(recoveredMetadata.introduction.value, 'Headless user introduction')
  assert.equal((await request('query', 'metadata.entity.jobs', { jobId: metadataJob.id })).items[0].state, 'blocked')
  assert.equal((await request('query', 'settings.state')).settings.ncmPlaybackQuality, 'hires')
  const recoveredEqualizer = await request('query', 'audio.dsp')
  assert.deepEqual(recoveredEqualizer.autoPreamp, equalizerState.autoPreamp)
  assert.equal(recoveredEqualizer.processing.eqPreamp, equalizerState.processing.eqPreamp)
  assert.equal(recovered.migrationRequired, false)
  assert.equal((await request('query', 'audio.profiles')).profiles.profiles[0].stableDeviceId, savedProfile.stableDeviceId)
  assert.equal(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).audioExclusiveMode, false)
  assert.equal((await request('query', 'audio.dsp.assets')).items[0].id, correction.asset.id)
  assert.equal((await request('query', 'audio.dsp')).scenes.scenes[0].graph.nodes.find(node => node.id === 'headless-correction').params.correctionProfileAssetId, correction.asset.id)
  let scanState
  for (let i = 0; i < 500; i++) {
    scanState = await request('query', 'scan.status')
    if (scanState?.state === 'completed') break
    assert.ok(!['failed', 'cancelled'].includes(scanState?.state), JSON.stringify(scanState))
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(scanState.jobId, scan.jobId)
  assert.equal(scanState.state, 'completed')
  const watchers = await request('query', 'scan.watchers')
  assert.equal(watchers.enabled, true)
  assert.equal(watchers.folders[0].state, 'active')
  assert.equal(watchers.folders[0].folder, music)
  // Real fs.watch, scan service and DB commit run with no client attached.
  supervisor.disconnect(identity.id)
  writeFileSync(join(music, 'headless-added.wav'), wave)
  await new Promise(resolve => setTimeout(resolve, 800))
  supervisor.connect(identity)
  let watchedPage
  for (let i = 0; i < 500; i++) {
    watchedPage = await request('query', 'library.tracks', { limit: 1 })
    if (watchedPage.total === 304) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(watchedPage.total, 304)
  const watchedScan = await request('query', 'scan.status')
  assert.notEqual(watchedScan.jobId, scan.jobId)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  const cuePage = await request('query', 'library.tracks', { search: 'Core Cue', limit: 2 })
  assert.equal(cuePage.total, 2)
  assert.ok(cuePage.tracks.every(track => track.cueRange))
  const restoredStatistics = await request('query', 'statistics.tracks', { limit: 1 })
  assert.deepEqual(restoredStatistics, importedStatistics)
  const currentDb = [...children].reverse().find(p => p.serviceName === 'twilight-database')
  const exited = once(currentDb.child, 'exit'); currentDb.child.kill(); await exited
  // The exit notification shares main's ordered channel with this query.
  const recoveredMigration = await request('query', 'migration.status')
  const recoveredPage = await request('query', 'library.tracks', { limit: 2 })
  // A real statistics write goes through the restarted DB's direct port. Clear
  // publishes tracks + days in one durable checkpoint and never starts audio.
  await request('command', 'statistics.clear', { range: { startDay: day, endDay: day }, revision: restoredStatistics.revision })
  const clearedStatistics = await request('query', 'statistics.summary')
  assert.equal(clearedStatistics.trackCount, 0)
  assert.deepEqual(clearedStatistics.days, {})
  assert.equal(clearedStatistics.persistence.dirty, false)
  // Preferences are Core-owned commits with no window. Reattachment reads state, not commands.
  const preferences = await request('query', 'settings.state')
  const audioRevisionBeforePreferences = (await request('query', 'audio.output')).revision
  const loseSettingsReply = (state) => {
    if (!state.settings.watchLibrary) {
      supervisor.off('settings', loseSettingsReply)
      supervisor.disconnect(identity.id)
    }
  }
  supervisor.on('settings', loseSettingsReply)
  await assert.rejects(request('command', 'settings.edit', {
    revision: preferences.revision,
    patch: { watchLibrary: false, ncmPlaybackQuality: 'hires', onlineLyricsFallback: false }
  }), e => e.code === 'OUTCOME_UNKNOWN')
  supervisor.connect(identity)
  await request('command', 'lifecycle.flush')
  const changedPreferences = await request('query', 'settings.state')
  assert.equal(changedPreferences.revision, preferences.revision + 1)
  assert.equal((await request('query', 'audio.output')).revision, audioRevisionBeforePreferences)
  assert.equal((await request('query', 'scan.watchers')).enabled, false)
  await assert.rejects(request('command', 'settings.edit', { revision: preferences.revision, patch: { theme: 'dark' } }), e => e.code === 'STALE_REVISION')
  supervisor.disconnect(identity.id); supervisor.connect(identity)
  assert.deepEqual(await request('query', 'settings.state'), changedPreferences)
  assert.equal(projectedSettings.at(-1).epoch, supervisor.getStatus().epoch)
  assert.deepEqual(projectedSettings.at(-1).state, changedPreferences)
  assert.equal(JSON.parse(readFileSync(join(profile,'settings.json'),'utf8')).ncmPlaybackQuality, 'hires')
  assert.equal((await request('query', 'state.snapshot')).settingsRevision, changedPreferences.revision)
  mkdirSync(extraMusic)
  writeFileSync(join(extraMusic, 'existing.wav'), wave)
  supervisor.disconnect(identity.id)
  supervisor.connect(identity)
  const addedRoot = await request('command', 'settings.edit', {
    revision: changedPreferences.revision, patch: { libraryFolders: [music, extraMusic] }
  })
  assert.equal((await request('query', 'scan.watchers')).enabled, false)
  supervisor.disconnect(identity.id)
  await new Promise(resolve => setTimeout(resolve, 250))
  supervisor.connect(identity)
  let configuredPage
  for (let i=0; i<500; i++) {
    configuredPage = await request('query', 'library.tracks', { limit: 1 })
    if(configuredPage.total === 305) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(configuredPage.total, 305, 'new root imports existing files even with automatic watching disabled')
  await request('command', 'settings.edit', { revision: addedRoot.revision, patch: { watchLibrary: true } })
  assert.equal((await request('query', 'scan.watchers')).enabled, true)
  assert.equal((await request('query', 'scan.watchers')).folders.length, 2)
  // The actual Core, SQL service, taglib analysis worker and scanner execute all
  // file operations without a BrowserWindow or a renderer-owned mutation loop.
  await request('command', 'settings.edit', { revision: (await request('query', 'settings.state')).revision, patch: { watchLibrary: false } })
  for (let i = 0; i < 500; i++) {
    if ((await request('query', 'scan.status')).state === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  supervisor.connect(desktop)
  const fileRequest = (kind, name, payload = {}) => supervisor.request(desktop.id, { kind, name, payload, epoch: supervisor.getStatus().epoch, requestId: 'library:' + ++serial })
  const settingsBackup = JSON.parse(await fileRequest('query', 'settings.backup'))
  assert.equal(settingsBackup.schemaVersion, 2)
  settingsBackup.settings.language = 'en-US'
  const restoredSettings = await fileRequest('command', 'settings.restore', { revision: (await request('query', 'settings.state')).revision, json: JSON.stringify(settingsBackup) })
  assert.equal(restoredSettings.settings.language, 'en-US')
  assert.deepEqual(JSON.parse(await fileRequest('query', 'settings.backup')).themeLibrary, settingsBackup.themeLibrary)
  assert.equal((await fileRequest('query', 'automix.install.status')).phase, 'idle')
  const selectExtra = async () => {
    const page = await request('query', 'library.tracks', { folder: extraMusic, sort: 'insertion', limit: 1 })
    return fileRequest('command', 'library.selection.open', { query: { folder: extraMusic, sort: 'insertion', contentRevision: page.revision }, total: page.total, ranges: [[0, page.total]] })
  }
  const selectedTags = await selectExtra()
  const tagPage = await fileRequest('query', 'library.selection.page', { id: selectedTags.id, projection: 'files' })
  assert.equal(tagPage.rows.length, 1)
  assert.doesNotMatch(JSON.stringify(tagPage), /filePath/)
  const tagId = tagPage.rows[0].track.id, originalTitle = tagPage.rows[0].track.title
  let releaseTags, enteredTags
  const tagEntered = new Promise(resolve => { enteredTags = resolve })
  tagAuthorization = { enter: enteredTags, gate: new Promise(resolve => { releaseTags = resolve }) }
  const writingTags = fileRequest('command', 'library.tags.write', { selectionId: selectedTags.id, patch: { title: 'Tagged by detached Core', artist: 'Core Artist' } })
  const lostTagsReply = assert.rejects(writingTags, error => error.code === 'OUTCOME_UNKNOWN')
  await tagEntered
  await request('command', 'playback.pause')
  supervisor.disconnect(desktop.id)
  await lostTagsReply
  tagAuthorization = null; releaseTags()
  const waitTitle = async title => {
    for (let i = 0; i < 500; i++) {
      const page = await request('query', 'library.tracks', { ids: [tagId], limit: 1 })
      const scan = await request('query', 'scan.status')
      // Metadata is visible before the scan's final revision is committed.
      // Start the next maintenance/inspection only after that actual completion.
      if (page.tracks[0]?.title === title && scan?.state === 'completed' && scan.revision === page.revision) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw Error('Core tag reindex did not publish ' + title)
  }
  await waitTitle('Tagged by detached Core')
  const tagJournal = JSON.parse(readFileSync(join(profile, 'tag-backups', 'tag-write-journal.json'), 'utf8'))
  assert.equal(tagJournal.state, 'completed')
  assert.equal(tagJournal.entries.length, 1)
  supervisor.connect(desktop)
  const restoredTags = await fileRequest('command', 'library.tags.restore', { fromJournal: true })
  assert.equal(restoredTags.items[0].status, 'success')
  await waitTitle(originalTitle)
  const selectedRemoval = await selectExtra()
  const removal = await fileRequest('command', 'library.remove', { selectionId: selectedRemoval.id, mode: 'library' })
  assert.deepEqual(removal.removedTrackIds, [tagId])
  assert.equal(removal.removedFileCount, 1)
  assert.equal(existsSync(join(extraMusic, 'existing.wav')), true)
  await fileRequest('command', 'playlists.edit', { revision: (await request('query', 'playlists.list')).revision, edit: { kind: 'create', name: 'Headless repair' } })
  const repairCatalog = await request('query', 'playlists.list')
  const repairPlaylist = repairCatalog.items.find(item => item.name === 'Headless repair')
  await fileRequest('command', 'playlists.edit', { revision: repairCatalog.revision, edit: { kind: 'add', id: repairPlaylist.id, tracks: [{ ...tagPage.rows[0].track, id: 'missing:headless', source: 'local', filePath: join(profile, 'old', 'existing.wav'), fileName: 'existing.wav' }] } })
  let releaseRepair, enteredRepair
  const repairEntered = new Promise(resolve => { enteredRepair = resolve })
  repairAuthorization = { enter: enteredRepair, gate: new Promise(resolve => { releaseRepair = resolve }) }
  const acceptedRepair = await fileRequest('command', 'playlists.repair', { id: repairPlaylist.id, revision: (await request('query', 'playlists.list')).revision, folder: extraMusic })
  assert.equal(acceptedRepair.state, 'running')
  await repairEntered
  supervisor.disconnect(desktop.id)
  await request('command', 'playback.pause')
  repairAuthorization = null; releaseRepair()
  let repairStatus
  for (let i = 0; i < 500; i++) {
    repairStatus = await request('query', 'playlists.repair.status')
    if (repairStatus.state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(repairStatus.state, 'completed', JSON.stringify(repairStatus))
  assert.equal(repairStatus.relocated, 1)
  assert.equal((await request('query', 'library.metadata')).trackCount, 304, 'repair candidates never import into the canonical library')
  const repairedEntries = await request('query', 'playlists.entries', { id: repairPlaylist.id, revision: (await request('query', 'playlists.list')).revision })
  assert.equal(repairedEntries.items.length, 1)
  assert.notEqual(repairedEntries.items[0].id, 'missing:headless')
  assert.equal(repairedEntries.items[0].track.title, originalTitle)
  assert.doesNotMatch(JSON.stringify(repairedEntries), /filePath/)
  supervisor.connect(desktop)
  let releaseDuplicates, enteredDuplicates
  const duplicatesEntered = new Promise(resolve => { enteredDuplicates = resolve })
  tagAuthorization = { enter: enteredDuplicates, gate: new Promise(resolve => { releaseDuplicates = resolve }) }
  const acceptedDuplicates = await fileRequest('command', 'library.duplicates.start')
  assert.equal(acceptedDuplicates.state, 'loading')
  await duplicatesEntered
  supervisor.disconnect(desktop.id)
  await request('command', 'playback.pause')
  tagAuthorization = null; releaseDuplicates()
  let duplicateStatus
  for (let i = 0; i < 500; i++) {
    duplicateStatus = await request('query', 'library.duplicates.status')
    if (!['loading', 'inspecting'].includes(duplicateStatus.state)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(duplicateStatus.state, 'completed', JSON.stringify(duplicateStatus))
  assert.equal(duplicateStatus.id, acceptedDuplicates.id)
  assert.equal(duplicateStatus.candidates, 304)
  const duplicateGroups = await request('query', 'library.duplicates.groups', { id: duplicateStatus.id })
  const waveGroup = duplicateGroups.items.find(group => group.kind === 'contentHash' && group.total >= 300)
  assert.ok(waveGroup, JSON.stringify(duplicateGroups))
  const duplicateMembers = await request('query', 'library.duplicates.items', { id: duplicateStatus.id, group: waveGroup.index })
  assert.equal(duplicateMembers.items.length, 200)
  assert.doesNotMatch(JSON.stringify(duplicateMembers), /filePath|contentHash|audioFingerprint/)
  assert.equal((await request('query', 'library.metadata')).trackCount, 304)
  supervisor.connect(desktop)
  const inbox = await fileRequest('command', 'library.inbox.refresh', { duplicatesId: duplicateStatus.id })
  const inboxPage = await request('query', 'library.inbox.page', { id: inbox.id, revision: inbox.revision, kind: 'duplicate', limit: 200 })
  assert.equal(inboxPage.items.length, 200)
  assert.doesNotMatch(JSON.stringify(inboxPage), /filePath|fingerprint|"key"/)
  const reviewedInbox = await fileRequest('command', 'library.inbox.mark', { id: inbox.id, revision: inbox.revision, indexes: [inboxPage.items[0].index], status: 'done' })
  supervisor.disconnect(desktop.id)
  assert.equal((await request('query', 'state.snapshot')).inbox.counts.done.duplicate, 1)
  supervisor.connect(desktop)
  await assert.rejects(fileRequest('command', 'library.inbox.mark', { id: inbox.id, revision: inbox.revision, indexes: [inboxPage.items[0].index], status: 'ignored' }))
  const excluded = await request('query', 'library.metadata')
  assert.equal(excluded.exclusions.length, 1)
  await assert.rejects(fileRequest('command', 'library.exclusions.clear', { revision: excluded.revision - 1, paths: [join(extraMusic, 'existing.wav')] }))
  const clearedExclusions = await fileRequest('command', 'library.exclusions.clear', { revision: excluded.revision, paths: [join(extraMusic, 'existing.wav')] })
  assert.equal(clearedExclusions.clearedFiles, 1)
  await assert.rejects(fileRequest('command', 'library.reset', { revision: excluded.revision }))
  const resetLibrary = await fileRequest('command', 'library.reset', { revision: clearedExclusions.revision })
  assert.equal(resetLibrary.removedTracks, 304)
  await assert.rejects(fileRequest('command', 'library.inbox.mark', { id: reviewedInbox.id, revision: reviewedInbox.revision, indexes: [inboxPage.items[0].index], status: 'ignored' }))
  assert.equal((await request('query', 'library.tracks', { limit: 1 })).total, 0)
  for (let i = 0; i < 200 && (await request('query', 'catalog.status')).localPending; i++)
    await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await request('query', 'catalog.query', { kind: 'recording' })).total, 0)
  assert.ok((await request('query', 'catalog.query', { kind: 'recording', scope: 'all' })).total > 0)
  assert.equal(existsSync(join(music, '0000.wav')), true)
  assert.equal((await request('query', 'state.snapshot')).playback.state, 'stopped')
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  supervisor.disconnect(desktop.id)
  const portCount = ports.length
  const windows = BrowserWindow.getAllWindows().length
  await supervisor.shutdown()
  // Core itself is supervised too; service exit barriers have all completed.
  for (const child of alive) await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(Error('Owned Core did not exit')), 5000))])
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ windows, privatePorts: portCount, servicePorts: children.filter(row=>row.serviceName!=='twilight-core').map(row=>({name:row.serviceName,ports:row.ports})), serviceBusinessMessages, tracks: page.total, migrationComplete: migration.complete, oldEpochRejected, recoveredPaused: recovered.playback.state !== 'playing', databaseRecovered: recoveredMigration.complete && recoveredPage.total === 304, scanRecovered: scanState.state === 'completed', watcherHeadless: watchedPage.total === 304, cueTracks: cuePage.total, statisticsRestored: restoredStatistics.items[0].plays === 2, statisticsCleared: clearedStatistics.trackCount === 0, cacheClearedHeadless: platformCacheClears === 1, dspHeadless: true, outputTestHeadless: true, settingsHeadless: true, equalizerHeadless: true, libraryMutationsHeadless: true, playlistRepairHeadless: true, duplicatesHeadless: true, inboxHeadless: true, servicesAfterShutdown: alive.size }))
  app.quit()
}
main().catch(async error => {
  console.error(error)
  await supervisor?.shutdown().catch(failure => console.error('[headless] cleanup', failure))
  for (const child of alive) child.kill()
  app.exit(1)
})
`

// Fixed test-only registry entry: real utility process and MessagePort, simulated
// output sink. It never loads a native binding or opens an audio device.
const outputTestFixture = String.raw`
const { createServicePort } = require('./src/main/services/servicePort.ts')
const { createAudioServiceCapabilities } = require('./src/shared/audioServiceContract.ts')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const record = (method, args = []) => appendFileSync(join(__dirname, 'silent-output-test-calls.jsonl'), JSON.stringify({ method, args }) + '\n')
let source = '', state = 'stopped'
const port = createServicePort({ supervise: (message, reply) => {
  state = 'stopped'
  record(message.kind)
  reply({ kind: 'supervisor:audio-stopped', requestId: message.requestId, stopped: true })
} })
port.postMessage({ kind: 'ready', capabilities: createAudioServiceCapabilities(['ApplyDspState', 'GetDspGraphStatus']) })
port.on('message', message => {
  if (message.kind === 'ping') return port.postMessage({ kind: 'pong', requestId: message.requestId })
  if (message.kind !== 'request') return
  record(message.method, message.args)
  if (message.method === 'Play') { source = message.args[0]; state = 'playing' }
  const value = message.method === 'GetPlaybackInfo' ? { state, source } : null
  port.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
})
`
