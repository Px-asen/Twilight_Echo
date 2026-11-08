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

test(
  'zero-window Core restores old journals and exports all eleven personal domains through real private database ports',
  { timeout: 90_000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-backup-'))
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
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const execution = promisify(execFile)(require('electron'), [runner, root], {
        env,
        windowsHide: true,
        timeout: 80_000,
        maxBuffer: 2 * 1024 * 1024
      })
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      await execution
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.deepEqual(result, {
        windows: 0,
        domains: 11,
        migratedHistory: true,
        queuedRestore: true,
        restartPaused: true,
        servicesAfterShutdown: 0
      })
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-backup-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { CoreStateDatabase } = require('./src/main/library/coreStateDatabase.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { createPersonalBackupRepository } = require('./src/core/persistence/personalBackup.ts')
const { personalBackupFixture } = require('./src/core/persistence/personalBackup.fixture.ts')
const { PERSONAL_DOMAINS } = require('./src/shared/personalBackup.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { writeFileSync, readFileSync, mkdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile'), alive = new Set()
mkdirSync(profile)
app.disableHardwareAcceleration(); app.setPath('userData', profile)
let supervisor, serial = 0, holdAuthorization = null
const identity = { id: 'desktop:backup', role: 'desktop', permissions: ['playback:read', 'playback:write', 'library:read', 'library:write', 'statistics:read', 'settings:read', 'settings:write'] }
const repository = createPersonalBackupRepository()
const importPath = join(profile, 'incoming.json'), exportPath = join(profile, 'export.json')
const request = (kind, name, payload = {}) => supervisor.request(identity.id, { kind, name, payload, epoch: supervisor.getStatus().epoch, requestId: 'backup:' + ++serial })
async function awaitCatalog() {
  for (let i = 0; i < 500; i++) {
    const status = await request('query', 'catalog.status')
    if (status.state === 'failed') throw Error(status.error)
    if (status.state === 'idle' && !status.localPending) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('Catalog initialization did not finish before backup')
}
const makeSupervisor = () => new CoreSupervisor({
  configuration: { root: profile, libraryFilePath: join(profile, 'music-library.json'), coverCacheDir: join(profile, 'covers'), libraryStorage: 'sqlite', resumeMode: 'trackAndPosition' },
  entries: Object.fromEntries(Object.entries({ core: 'musicCore', audio: 'audioEngineService', database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService' }).map(([name, file]) => [name, join(root, 'out/main', file + '.js')])),
  platform: {
    ...createDspCorePlatform(),
    'downloads.authorizedRoots': async ({ libraryFolders }) => ({ libraryRoots: libraryFolders, downloadRoot: null }),
    'backup.chooseFile': async ({ kind }) => kind === 'import' ? importPath : exportPath,
    'backup.chooseFolder': async () => profile,
    'settings.authorizePaths': async paths => {
      if (holdAuthorization) { holdAuthorization.enter(); await holdAuthorization.gate }
      return paths
    },
    'paths.authorizeAudio': async () => { throw Error('This fixture never authorizes playback') },
    'paths.areAudioFilesAuthorized': async ({ paths }) => paths.map(() => false),
    'paths.authorizeAudioFile': async () => { throw Error('This fixture never opens media files') },
    'artwork.normalizeCachedCover': async ({ handle }) => handle
  },
  fork(entry, args, serviceName) {
    const child = utilityProcess.fork(entry, args, { serviceName, stdio: 'pipe' })
    alive.add(child); child.once('exit', () => alive.delete(child))
    child.stdout?.on('data', data => process.stdout.write(data))
    child.stderr?.on('data', data => process.stderr.write(data))
    return child
  },
  channel() { return new MessageChannelMain() }
})
async function main() {
  await app.whenReady()
  const incoming = personalBackupFixture()
  incoming.data.library.folders = []
  incoming.data.playback.queue = [
    { ...incoming.data.playback.track, queueEntryId: 'backup:first' },
    { ...incoming.data.playback.track, queueEntryId: 'backup:second' }
  ]
  incoming.data.playback.queueIndex = 1
  incoming.data.playback.track = incoming.data.playback.queue[1]
  repository.stagePersonalRestore(profile, incoming, { domains: [...PERSONAL_DOMAINS], conflict: 'use-backup', mappings: [] }, [], {}, 'sqlite')
  // The browser has already migrated IndexedDB history. Restoration must merge
  // these rows in the worker before the tracker becomes active.
  const state = new CoreStateDatabase(join(profile, 'core-state.sqlite'))
  const counts = emptyCoreStateCounts(); counts['statistics-tracks'] = 1; counts['statistics-days'] = 1
  state.begin('old-profile-upgrade', { version: 1, counts })
  state.stage('old-profile-upgrade', 0, 'statistics-tracks', [{ key: 'previous', value: { title: 'IndexedDB history', artist: 'Artist', seconds: 45, plays: 3, history: { '2026-10-02': { seconds: 45, plays: 3 } } } }])
  state.stage('old-profile-upgrade', 1, 'statistics-days', [{ key: '2026-10-02', value: 45 }])
  state.commit('old-profile-upgrade'); state.close()
  supervisor = makeSupervisor()
  await supervisor.start(); supervisor.connect(identity)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  assert.equal(existsSync(join(profile, 'personal-restore-renderer.json')), false)
  assert.equal((await request('query', 'library.metadata')).trackCount, 1)
  let stateView = await request('query', 'state.snapshot')
  assert.notEqual(stateView.playback.state, 'playing')
  assert.equal(stateView.queue.occurrenceId, 'backup:second')
  assert.equal(stateView.queue.index, 1)
  await awaitCatalog()
  assert.equal(await request('command', 'backup.export'), true)
  const exported = repository.readBackupFile(exportPath)
  assert.deepEqual(Object.keys(exported.data).sort(), [...PERSONAL_DOMAINS].sort())
  assert.equal(exported.data.statistics.tracks.previous.plays, 3)
  assert.equal(exported.data.statistics.tracks.song.seconds, 20)
  assert.equal(exported.data.statistics.days['2026-10-02'], 45)
  assert.deepEqual(exported.data.versions, incoming.data.versions)
  assert.equal(exported.data.playback.queue[1].queueEntryId, 'backup:second')
  assert.equal(exported.data.playback.queueIndex, 1)
  assert.equal(exported.data.playback.position, 12)
  assert.equal(exported.data.queue.sessions[0].currentEntryId, 'entry')
  assert.equal(exported.data.lyrics.tracks.song.original, incoming.data.lyrics.tracks.song.original)
  assert.equal(exported.data.bookmarks.bookmarks[0].positionSeconds, 12)
  assert.equal(exported.data.radio.stations[0].id, 'radio')
  assert.equal(exported.data.podcasts.subscriptions[0].episodes[0].progressSeconds, 900)
  assert.equal(exported.data.playlists.find(item => item.id === 'favorites').trackIds[0], 'song')
  // An accepted restore survives loss of its client reply. Startup consumes its
  // durable journal; no renderer gets a business-data writeback request.
  exported.data.statistics.tracks.song.seconds = 123
  repository.writePersonalBackupFile(importPath, exported)
  const preview = await request('command', 'backup.preview')
  const restore = { id: preview.id, options: { domains: Object.keys(exported.data), conflict: 'use-backup', mappings: [] } }
  await request('command', 'backup.repreview', restore)
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  holdAuthorization = { enter, gate: new Promise(resolve => { release = resolve }) }
  const pending = request('command', 'backup.stage', restore)
  const lostReply = assert.rejects(pending, error => error.code === 'OUTCOME_UNKNOWN')
  await entered
  await request('command', 'playback.pause')
  supervisor.disconnect(identity.id); await lostReply
  holdAuthorization = null; release()
  for (let i = 0; i < 500 && !existsSync(join(profile, 'personal-restore-pending.json')); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(existsSync(join(profile, 'personal-restore-pending.json')), true)
  await supervisor.shutdown()
  supervisor = makeSupervisor(); await supervisor.start(); supervisor.connect(identity)
  await awaitCatalog()
  assert.equal(await request('command', 'backup.export'), true)
  const restored = repository.readBackupFile(exportPath)
  assert.equal(restored.data.statistics.tracks.song.seconds, 123)
  assert.equal(restored.data.statistics.tracks.previous.plays, 3)
  assert.deepEqual(restored.data.versions, incoming.data.versions)
  stateView = await request('query', 'state.snapshot')
  assert.notEqual(stateView.playback.state, 'playing')
  assert.equal(stateView.queue.occurrenceId, 'backup:second')
  assert.equal(existsSync(join(profile, 'personal-restore-renderer.json')), false)
  assert.equal(existsSync(join(profile, 'personal-restore-pending.json')), false)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  await supervisor.shutdown()
  for (let i = 0; i < 500 && alive.size; i++) await new Promise(resolve => setTimeout(resolve, 10))
  writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ windows: 0, domains: Object.keys(restored.data).length, migratedHistory: restored.data.statistics.tracks.previous.plays === 3, queuedRestore: restored.data.statistics.tracks.song.seconds === 123, restartPaused: stateView.playback.state !== 'playing', servicesAfterShutdown: alive.size }))
  app.quit()
}
main().catch(async error => { console.error(error); await supervisor?.shutdown().catch(() => {}); for (const child of alive) child.kill(); app.exit(1) })
`
