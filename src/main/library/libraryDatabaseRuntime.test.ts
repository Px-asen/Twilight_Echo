import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LibraryDatabaseRuntime } from './libraryDatabaseRuntime.ts'
import { LibraryDatabaseServiceClient } from './libraryDatabaseServiceClient.ts'
import { LocalLibraryScanServiceClient } from './libraryScanServiceClient.ts'
import { selectLibraryStorage } from './libraryStorageMode.ts'
import { stagePersonalRestore } from '../persistence/personalBackup.ts'
import { getLocalLibraryRemovalJournalPath } from './removal.ts'
import { isActiveLibraryPathExcluded, normalizeLibraryFilePath } from './libraryRepository.ts'
import type { DatabaseScanStatus } from './libraryDatabaseScanCoordinator.ts'
import { toDuplicateCandidate } from './duplicateDetection.ts'
import type { DuplicateCandidate } from '../../shared/duplicateDetection.ts'

async function fixture(t: test.TestContext, count = 4, initialize = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sqlite-app-owner-'))),
    media = join(root, 'media'),
    albumA = join(media, 'a'),
    albumB = join(media, 'b')
  mkdirSync(albumA, { recursive: true })
  mkdirSync(albumB)
  const wav = Buffer.alloc(44 + 48_000)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(48_000, 40)
  const paths = Array.from({ length: count }, (_, index) =>
    join(index % 2 ? albumB : albumA, `${String(index).padStart(4, '0')}.wav`)
  )
  paths.forEach((path) => writeFileSync(path, wav))
  const cue = join(albumA, 'disc.cue')
  writeFileSync(
    cue,
    'FILE "0000.wav" WAVE\n TRACK 01 AUDIO\n TITLE "First"\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n TITLE "Second"\n INDEX 01 00:01:00\n'
  )
  const json = join(root, 'music-library.json'),
    original = JSON.stringify({
      version: 2,
      revision: 4,
      tracks: [],
      folders: [media],
      exclusions: []
    })
  writeFileSync(json, original)
  const children: ChildProcess[] = []
  const spawn = (entry: string) => {
    const child = fork(entry, [], {
      execArgv: ['--experimental-strip-types'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    children.push(child)
    return {
      postMessage: (message: object) => {
        child.send(message)
      },
      kill: () => {
        child.kill()
      },
      on: child.on.bind(child)
    }
  }
  const database = new LibraryDatabaseServiceClient({
    serviceEntry: fileURLToPath(new URL('./libraryDatabaseService.ts', import.meta.url)),
    libraryFilePath: json,
    fork: spawn
  })
  const scanner = new LocalLibraryScanServiceClient({
    serviceEntry: fileURLToPath(new URL('./libraryScanService.ts', import.meta.url)),
    electron: { utilityProcess: { fork: spawn } }
  })
  let roots = [media]
  let prepareTrash: (paths: string[]) => Promise<void> = async () => {}
  const owner = new LibraryDatabaseRuntime({
    root,
    libraryFilePath: json,
    database,
    scanner,
    coverCacheDir: join(root, 'covers'),
    resolveRoots: async () => roots,
    authorizeRemoval: async () => {},
    authorizeRepairDirectory: async (path) => realpathSync(path),
    authorizeRepairFile: async (path) => realpathSync(path),
    prepareTrash: (paths) => prepareTrash(paths),
    trashItem: async (path) => {
      unlinkSync(path)
    },
    closeDatabase: () => database.destroy(),
    watcherDebounceMs: 10
  })
  t.after(async () => {
    owner.destroy()
    scanner.destroy()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  if (initialize) await owner.initialize()
  return {
    root,
    media,
    albumA,
    albumB,
    paths,
    cue,
    json,
    original,
    owner,
    database,
    scanner,
    setRoots(next: string[]) {
      roots = next
    },
    setPrepareTrash(next: typeof prepareTrash) {
      prepareTrash = next
    }
  }
}

test('repair scan reservation prevents durable watcher/manual jobs while preserving reads and queued watcher changes', async (t) => {
  const f = await fixture(t)
  let release!: () => void, started!: () => void
  const held = new Promise<void>((resolve) => {
      release = resolve
    }),
    scanning = new Promise<void>((resolve) => {
      started = resolve
    })
  const scan = f.scanner.scanRepair.bind(f.scanner)
  f.scanner.scanRepair = async (...args) => {
    started()
    await held
    return scan(...args)
  }
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const opening = f.owner.playlistRepair!.handle(sender, { kind: 'open', folder: f.albumA })
  await scanning
  assert.equal(await f.owner.poll(f.media), undefined)
  assert.equal(await f.owner.resume(), false)
  await assert.rejects(f.owner.scan('full'), /歌单修复正在运行/)
  f.owner.enqueueWatcherChanges([{ kind: 'reconcile', path: f.albumB }])
  assert.deepEqual(await f.database.listScanJobs(), [])
  assert.equal((await f.owner.api.getMetadata()).trackCount, 0)
  release()
  const ready = await opening
  await f.owner.playlistRepair!.handle(sender, { kind: 'close', id: ready.id })
  const deadline = Date.now() + 10000
  while ((await f.database.getLatestScanJob())?.state !== 'completed') {
    assert.ok(Date.now() < deadline, 'coalesced watcher scope must resume after the repair scan')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual((await f.database.getLatestScanJob())!.roots, [f.albumB])
  assert.equal((await f.database.getMetadata()).trackCount, 2)
})

test('read-only duplicate analysis pages through the sole worker without compatibility exports or a second owner', async (t) => {
  const f = await fixture(t)
  const tracks = Array.from({ length: 1002 }, (_, i) => ({
    id: `duplicate:${i}`,
    filePath: f.paths[i % f.paths.length],
    title: `Segment ${i}`,
    artist: 'Singer',
    album: 'Album',
    size: 48044,
    duration: 3,
    extension: { unrelated: 'kept' }
  }))
  await f.database.replaceDocument({
    version: 2,
    revision: 0,
    tracks,
    folders: [f.media],
    exclusions: []
  })
  t.mock.method(f.database, 'exportDocument', async () => assert.fail('full library export used'))
  const pages: DuplicateCandidate[][] = []
  for await (const page of f.owner.duplicateCandidatePages()) pages.push(page)
  assert.deepEqual(
    pages.map((page) => page.length),
    [1000, 2]
  )
  assert.deepEqual(pages.flat(), JSON.parse(JSON.stringify(tracks.map(toDuplicateCandidate))))
  const reader = f.owner.duplicateCandidatePages()
  await reader.next()
  await f.owner.patchTracks([
    { id: tracks.at(-1)!.id, expectedVersion: 1, patch: { title: 'Edited' } }
  ])
  await assert.rejects(reader.next(), /读取期间发生变化/)
})

test('history projection uses the sole owner without publishing library changes or invalidating unchanged scan work', async (t) => {
  const f = await fixture(t)
  await f.owner.scan('startup')
  const before = await f.database.getMetadata(),
    tracks = await f.database.queryTracks()
  let changed = 0
  f.owner.on('changed', () => changed++)
  await f.owner.api.syncListeningHistory({ kind: 'begin', id: 'runtime-history', mode: 'replace' })
  await f.owner.api.syncListeningHistory({
    kind: 'append',
    id: 'runtime-history',
    sequence: 1,
    entries: [{ id: tracks.tracks.at(-1)!.id, lastPlayed: 12345 }]
  })
  const result = await f.owner.api.syncListeningHistory({
    kind: 'commit',
    id: 'runtime-history',
    sequence: 2
  })
  assert.equal(result.revision, 1)
  assert.equal(changed, 0)
  assert.deepEqual(await f.database.getMetadata(), before)
  assert.equal(
    (
      await f.owner.api.queryTracks({
        sort: 'lastPlayed',
        direction: 'desc',
        historyRevision: result.revision
      })
    ).tracks[0].id,
    tracks.tracks.at(-1)!.id
  )
  const scan = await f.owner.scan('startup')
  assert.equal(scan.parsedFileCount, 0)
  assert.deepEqual(
    (await f.database.getTracksByIds(tracks.tracks.map((track) => track.id))).versions,
    tracks.versions
  )
})
function terminal(
  owner: LibraryDatabaseRuntime,
  predicate: (status: DatabaseScanStatus) => boolean
) {
  return new Promise<DatabaseScanStatus>((resolve) => {
    const listener = (status: DatabaseScanStatus) => {
      if (predicate(status)) {
        owner.off('database-status', listener)
        resolve(status)
      }
    }
    owner.on('database-status', listener)
  })
}

test(
  'application startup restores old deletion journals before personal backups and never rewrites migration JSON',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, 4, false)
    const track = { id: 'original', filePath: f.paths[1], title: 'Original' }
    const source = JSON.stringify({
      version: 2,
      revision: 4,
      tracks: [track],
      folders: [f.media],
      exclusions: []
    })
    writeFileSync(f.json, source)
    const backup = {
      format: 'twilight-personal-data' as const,
      version: 1 as const,
      createdAt: new Date().toISOString(),
      data: {
        library: {
          version: 2 as const,
          revision: 0,
          tracks: [{ ...track, title: 'Restored after removal', addedAt: 42, custom: true }],
          folders: [f.media],
          exclusions: []
        },
        playlists: [{ id: 'favorite', name: 'Favorite', trackIds: ['original'] }]
      }
    }
    stagePersonalRestore(f.root, backup, {
      conflict: 'use-backup',
      domains: ['library', 'playlists'],
      mappings: []
    })
    unlinkSync(f.paths[1])
    writeFileSync(
      getLocalLibraryRemovalJournalPath(f.json),
      JSON.stringify({
        version: 1,
        expectedRevision: 4,
        targetRevision: 5,
        createdAt: new Date().toISOString(),
        items: [{ ...track, artist: '' }],
        succeededFilePaths: [track.filePath],
        inFlightFilePath: null
      })
    )
    await f.owner.initialize()
    const current = await f.owner.api.getTracksByIds(['original'])
    assert.equal(current.tracks[0].title, 'Restored after removal')
    assert.equal(current.tracks[0].addedAt, 42)
    assert.equal(current.tracks[0].custom, true)
    const restoredPlaylists = await f.database.preferencesPlaylistsLoad()
    const restoredPlaylist = restoredPlaylists!.data.find((playlist) => playlist.id === 'favorite')!
    assert.deepEqual(restoredPlaylist.trackIds, ['original'])
    assert.ok(Number.isFinite(Date.parse(restoredPlaylist.createdAt)))
    assert.equal(existsSync(getLocalLibraryRemovalJournalPath(f.json)), false)
    assert.equal(readFileSync(f.json, 'utf8'), source)
  }
)

test(
  'one application authority serves paged reads, complete compatibility snapshots, patches, exclusions and trash',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const page = await f.owner.api.queryTracks({ limit: 2 })
    assert.equal(page.total, 5)
    assert.equal(page.tracks.length, 2)
    const full = await f.owner.loadLegacyDocument()
    assert.equal(full.tracks.length, 5)
    const track =
      page.tracks.find(
        (item) => normalizeLibraryFilePath(item.filePath) === normalizeLibraryFilePath(f.paths[1])
      ) ??
      (await f.owner.api.queryTracks()).tracks.find(
        (item) => normalizeLibraryFilePath(item.filePath) === normalizeLibraryFilePath(f.paths[1])
      )!
    const version = (await f.owner.api.getTracksByIds([track.id])).versions[track.id]
    await f.owner.api.patchTracks([
      {
        id: track.id,
        expectedVersion: version,
        patch: { title: 'Incremental', custom: { kept: true } }
      }
    ])
    const snapshot = await f.owner.loadLegacyDocument()
    snapshot.tracks = snapshot.tracks.map((item) =>
      (item as { id: string }).id === track.id
        ? { ...(item as object), title: 'Compatibility edit' }
        : item
    )
    const saved = await f.owner.saveLegacyDocument(snapshot)
    assert.equal(
      (await f.owner.api.getTracksByIds([track.id])).tracks[0].title,
      'Compatibility edit'
    )
    await assert.rejects(f.owner.saveLegacyDocument(snapshot), /changed concurrently/)
    const cue = (await f.owner.api.queryTracks()).tracks.find(
      (item) => normalizeLibraryFilePath(item.filePath) === normalizeLibraryFilePath(f.paths[0])
    )!
    const removed = await f.owner.removeFiles(
      [{ id: cue.id, filePath: cue.filePath, title: 'First', artist: '' }],
      'library'
    )
    assert.equal(removed.removedTrackIds.length, 2)
    assert.ok(existsSync(cue.filePath))
    const excluded = await f.owner.loadLegacyDocument()
    assert.equal(excluded.exclusions.length, 1)
    await f.owner.clearLegacyExclusions(excluded, [cue.filePath])
    await f.owner.scan('full')
    const trashed = await f.owner.removeFiles(
      [{ id: track.id, filePath: track.filePath, title: 'Track', artist: '' }],
      'trash'
    )
    assert.deepEqual(trashed.removedTrackIds, [track.id])
    assert.equal(existsSync(track.filePath), false)
    assert.equal((await f.owner.api.queryTracks()).total, 4)
    assert.ok(saved.revision > snapshot.revision)
    assert.equal(readFileSync(f.json, 'utf8'), f.original)
  }
)

test(
  'a cancelled application scan does not automatically restart at startup; explicit continue keeps committed records',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, 600)
    let cancelled = false
    f.owner.on('database-status', (status: DatabaseScanStatus) => {
      if (!cancelled && status.committedFiles >= 256) {
        cancelled = true
        f.owner.cancel()
      }
    })
    const result = await f.owner.scan('full')
    assert.equal(result.state, 'cancelled')
    const committed = await f.owner.api.getMetadata()
    assert.ok(committed.trackCount > 0 && committed.trackCount < 601)
    const cancelledStatus = f.owner.getStatus()
    assert.equal(cancelledStatus.databaseProgress?.state, 'cancelled')
    assert.equal(cancelledStatus.databaseProgress.trackCount, committed.trackCount)
    assert.ok(cancelledStatus.databaseProgress.committedFiles >= 256)
    assert.equal(cancelledStatus.databaseProgress.revision, committed.revision)
    assert.equal('error' in cancelledStatus.databaseProgress, false)
    assert.equal((await f.owner.scan('startup')).state, 'cancelled')
    assert.equal((await f.owner.api.getMetadata()).revision, committed.revision)
    const completed = terminal(f.owner, (status) => status.state === 'completed')
    assert.equal(await f.owner.resume(), true)
    assert.equal((await completed).trackCount, 601)
    assert.equal((await f.owner.api.getMetadata()).trackCount, 601)
    const completedStatus = f.owner.getStatus()
    assert.equal(completedStatus.databaseProgress?.state, 'completed')
    assert.equal(completedStatus.databaseProgress.checkedFiles, 600)
    assert.equal(completedStatus.databaseProgress.parsedFiles, 600)
    assert.equal(completedStatus.databaseProgress.failedFiles, 0)
    assert.equal(completedStatus.databaseProgress.trackCount, 601)
  }
)

test(
  'a reset racing with queued scan preparation cannot deadlock the mutation lane or resurrect records',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const current = await f.owner.api.queryTracks(),
      track = current.tracks[0]
    const patch = f.database.patchTracks.bind(f.database)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    f.database.patchTracks = async (patches) => {
      const result = await patch(patches)
      await blocked
      return result
    }
    const writing = f.owner.api.patchTracks([
      { id: track.id, expectedVersion: current.versions[track.id], patch: { title: 'Changed' } }
    ])
    const scanning = f.owner.scan('full')
    const resetting = f.owner.reset()
    release()
    await writing
    await resetting
    await scanning
    assert.equal((await f.owner.api.getMetadata()).trackCount, 0)
  }
)

test(
  'watch storms coalesce into the affected directory and do not parse unrelated albums',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const all = await f.owner.api.queryTracks(),
      other = all.tracks.find(
        (track) => normalizeLibraryFilePath(track.filePath) === normalizeLibraryFilePath(f.paths[1])
      )!,
      before = all.versions[other.id]
    const scopes: string[][] = [],
      start = f.database.startScan.bind(f.database)
    f.database.startScan = async (job) => {
      scopes.push(job.roots)
      return start(job)
    }
    const previousId = f.owner.getStatus().jobId
    const watched = terminal(
      f.owner,
      (status) => status.state === 'completed' && status.jobId !== previousId
    )
    writeFileSync(f.cue, readFileSync(f.cue, 'utf8').replace('First', 'Changed CUE'))
    f.owner.enqueueWatcherChanges(
      Array.from({ length: 1000 }, () => ({ kind: 'add' as const, path: f.cue }))
    )
    const status = await watched
    assert.deepEqual(scopes, [[f.albumA]])
    assert.equal(status.parsedFiles, 0)
    assert.equal((await f.owner.api.getTracksByIds([other.id])).versions[other.id], before)
  }
)

test(
  'explicit imports merge scopes, restore only selected exclusions and reuse unchanged metadata; tags never unexclude',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const before = await f.owner.api.queryTracks()
    const find = (path: string) =>
      before.tracks.find(
        (track) => normalizeLibraryFilePath(track.filePath) === normalizeLibraryFilePath(path)
      )!
    const excludedA = find(f.paths[0]),
      excludedB = find(f.paths[1]),
      other = find(f.paths[3])
    await f.owner.removeFiles(
      [excludedA, excludedB].map((track) => ({
        id: track.id,
        filePath: track.filePath,
        title: '',
        artist: ''
      })),
      'library'
    )
    const starts: { roots: string[]; restoreExcluded?: boolean }[] = []
    const start = f.database.startScan.bind(f.database)
    f.database.startScan = async (job) => {
      starts.push(job)
      return start(job)
    }
    const tags = await f.owner.scanDirectories({ directories: [f.albumA], reason: 'tags' })
    assert.equal(tags.state, 'completed')
    assert.equal(tags.exclusions.length, 2)
    assert.equal((await f.owner.api.queryTracks()).total, 2)
    f.owner.enqueueWatcherChanges([{ kind: 'reconcile', path: f.albumA }])
    const imported = await f.owner.scanDirectories({
      directories: [join(f.albumA, '.'), f.albumA, f.albumA],
      reason: 'import'
    })
    assert.equal(imported.state, 'completed')
    assert.deepEqual(starts.at(-1)?.roots, [f.albumA])
    assert.equal(starts.at(-1)?.restoreExcluded, true)
    assert.equal((await f.owner.api.getTracksByIds([excludedA.id])).tracks[0]?.id, excludedA.id)
    assert.deepEqual(
      imported.exclusions.map((entry) => normalizeLibraryFilePath(entry.filePath)),
      [normalizeLibraryFilePath(f.paths[1])]
    )
    assert.equal((await f.owner.api.queryTracks()).total, 4)
    assert.equal(
      (await f.owner.api.getTracksByIds([other.id])).versions[other.id],
      before.versions[other.id]
    )
    const unchanged = await f.owner.scanDirectories({ directories: [f.albumA], reason: 'import' })
    assert.equal(unchanged.parsedFileCount, 0)
    assert.equal((await f.owner.api.queryTracks()).total, 4)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(
      starts.length,
      3,
      'pre-existing watcher work covered by the import must not run twice'
    )
    assert.equal(readFileSync(f.json, 'utf8'), f.original)
  }
)

test(
  'invalid, missing, file and revoked import scopes preserve exclusions and the resumable job',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const track = (await f.owner.api.queryTracks()).tracks[0]
    await f.owner.removeFiles(
      [{ id: track.id, filePath: track.filePath, title: '', artist: '' }],
      'library'
    )
    await f.database.startScan({ id: 'retained', mode: 'watch', roots: [f.media] })
    await f.database.setScanState('retained', 'paused')
    const before = await f.owner.api.getMetadata()
    for (const directories of [
      [join(f.media, '..', 'outside')],
      [f.albumA, join(f.media, 'missing')],
      [f.paths[0]]
    ]) {
      await assert.rejects(f.owner.scanDirectories({ directories, reason: 'import' }))
      assert.deepEqual(await f.owner.api.getMetadata(), before)
      assert.equal((await f.database.getLatestScanJob())?.state, 'paused')
    }
    await assert.rejects(
      f.owner.scanDirectories({ directories: [f.albumA], reason: 'tags' }),
      /未完成的扫描/
    )
    assert.equal((await f.database.getLatestScanJob())?.id, 'retained')
    f.setRoots([f.albumB])
    await assert.rejects(
      f.owner.scanDirectories({ directories: [f.albumA], reason: 'import' }),
      /未获授权/
    )
    assert.deepEqual((await f.owner.api.getMetadata()).exclusions, before.exclusions)
  }
)

test(
  'selected imports retain committed checkpoints on cancel and resume only the original selected scope',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, 600)
    let cancelled = false
    f.owner.on('database-status', (status: DatabaseScanStatus) => {
      if (!cancelled && status.committedFiles >= 256) {
        cancelled = true
        f.owner.cancel()
      }
    })
    const imported = await f.owner.scanDirectories({ directories: [f.albumA], reason: 'import' })
    assert.equal(imported.state, 'cancelled')
    const partial = await f.owner.api.queryTracks()
    assert.ok(partial.total > 0 && partial.total < 301)
    assert.deepEqual((await f.database.getLatestScanJob())?.roots, [f.albumA])
    assert.equal((await f.owner.scan('startup')).state, 'cancelled')
    const completed = terminal(f.owner, (status) => status.state === 'completed')
    assert.equal(await f.owner.resume(), true)
    const status = await completed
    assert.equal(status.checkedFiles, 300)
    assert.equal(status.parsedFiles, 300, 'already committed audio must not be parsed again')
    assert.equal(status.trackCount, 301)
    assert.deepEqual((await f.database.getLatestScanJob())?.roots, [f.albumA])
    assert.equal((await f.owner.api.queryTracks({ folder: f.albumB })).total, 0)
  }
)

test(
  'an explicit directory scope cannot escape its authorization through a junction',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    const outside = join(f.root, 'outside'),
      link = join(f.media, 'linked')
    mkdirSync(outside)
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const before = await f.owner.api.getMetadata()
    await assert.rejects(
      f.owner.scanDirectories({ directories: [link], reason: 'import' }),
      /实际位置未获授权/
    )
    assert.deepEqual(await f.owner.api.getMetadata(), before)
    assert.equal(await f.database.getLatestScanJob(), null)
    const internalLink = join(f.media, 'internal-link')
    symlinkSync(f.albumA, internalLink, process.platform === 'win32' ? 'junction' : 'dir')
    await f.owner.scanDirectories({ directories: [internalLink, f.albumA], reason: 'import' })
    assert.deepEqual((await f.database.getLatestScanJob())?.roots, [f.albumA])
    assert.equal((await f.owner.api.getMetadata()).trackCount, 3)
  }
)

test(
  'committed import exclusions reach the native watcher even if the metadata process immediately fails',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const track = (await f.owner.api.queryTracks()).tracks.find(
      (track) => normalizeLibraryFilePath(track.filePath) === normalizeLibraryFilePath(f.paths[0])
    )!
    await f.owner.removeFiles(
      [{ id: track.id, filePath: track.filePath, title: '', artist: '' }],
      'library'
    )
    assert.equal(isActiveLibraryPathExcluded(track.filePath), true)
    f.scanner.scanDatabase = async () => {
      assert.equal(isActiveLibraryPathExcluded(track.filePath), false)
      throw new Error('metadata worker unavailable')
    }
    await assert.rejects(
      f.owner.scanDirectories({ directories: [f.albumA], reason: 'import' }),
      /metadata worker unavailable/
    )
    assert.equal(isActiveLibraryPathExcluded(track.filePath), false)
    assert.equal((await f.database.getLatestScanJob())?.state, 'failed')
    assert.deepEqual((await f.owner.api.getMetadata()).exclusions, [])
  }
)

test(
  'cancel during selected import preparation does not clear exclusions, and does not deadlock reset',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const track = (await f.owner.api.queryTracks()).tracks[0]
    await f.owner.removeFiles(
      [{ id: track.id, filePath: track.filePath, title: '', artist: '' }],
      'library'
    )
    const before = await f.owner.api.getMetadata()
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
      }),
      preparing = new Promise<void>((resolve) => {
        entered = resolve
      })
    const latest = f.database.getLatestScanJob.bind(f.database)
    f.database.getLatestScanJob = async () => {
      const job = await latest()
      entered()
      await blocked
      return job
    }
    const importing = f.owner.scanDirectories({ directories: [f.albumA], reason: 'import' })
    await preparing
    assert.equal(f.owner.cancel(), true)
    release()
    assert.equal((await importing).state, 'cancelled')
    assert.deepEqual(await f.owner.api.getMetadata(), before)
    await f.owner.reset()
    assert.equal((await f.owner.api.getMetadata()).trackCount, 0)
  }
)

test(
  'a root-added watcher owning the scanner rejects a concurrent import without clearing exclusions',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const track = (await f.owner.api.queryTracks()).tracks[0]
    await f.owner.removeFiles(
      [{ id: track.id, filePath: track.filePath, title: '', artist: '' }],
      'library'
    )
    const before = await f.owner.api.getMetadata()
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
      }),
      preparing = new Promise<void>((resolve) => {
        entered = resolve
      })
    const start = f.database.startScan.bind(f.database)
    f.database.startScan = async (job) => {
      const result = await start(job)
      entered()
      await blocked
      return result
    }
    const watching = f.owner.scan('watch', [f.albumA])
    await preparing
    await assert.rejects(
      f.owner.scanDirectories({ directories: [f.albumA], reason: 'import' }),
      /扫描正在运行/
    )
    assert.deepEqual((await f.owner.api.getMetadata()).exclusions, before.exclusions)
    release()
    await watching
  }
)

test('normal development and packaged starts use SQLite without a preview flag', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-storage-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(selectLibraryStorage(root, true, undefined), 'sqlite')
  assert.equal(selectLibraryStorage(root, true, '1'), 'sqlite')
  assert.equal(selectLibraryStorage(root, true, '0'), 'sqlite')
  assert.equal(selectLibraryStorage(root, false, undefined), 'sqlite')
  assert.equal(selectLibraryStorage(root, false, '1'), 'sqlite')
})

test('explicit legacy development mode remains available before SQLite migration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-storage-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const json = join(root, 'music-library.json')
  writeFileSync(json, 'retained legacy input')
  assert.equal(selectLibraryStorage(root, false, '0'), 'json')
  assert.equal(readFileSync(json, 'utf8'), 'retained legacy input')
})

test('existing SQLite is authoritative on normal startup and cannot reopen stale JSON in legacy mode', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-storage-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'music-library.sqlite'), 'unrecognized database')
  assert.equal(selectLibraryStorage(root, true, undefined), 'sqlite')
  assert.equal(selectLibraryStorage(root, false, undefined), 'sqlite')
  assert.throws(() => selectLibraryStorage(root, false, '0'), /不能退回旧 JSON/)
})

test(
  'a newer completed scan supersedes historical cancellation for startup and continue',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.database.startScan({ id: 'old-cancelled', mode: 'full', roots: [f.media] })
    await f.database.setScanState('old-cancelled', 'cancelled')
    await f.owner.scan('full')
    assert.equal(await f.owner.resume(), false)
    const startup = await f.owner.scan('startup')
    assert.equal(startup.state, 'completed')
    assert.equal(startup.parsedFileCount, 0)
    assert.notEqual(startup.jobId, 'old-cancelled')
  }
)

test(
  'failed compatibility removals and absent exclusions do not persist caller snapshots or advance versions',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const before = await f.owner.api.queryTracks()
    const snapshot = await f.owner.loadLegacyDocument()
    const fake = {
      id: 'phantom',
      filePath: join(f.media, 'unpersisted.wav'),
      title: 'Never stored',
      artist: ''
    }
    snapshot.tracks.push(fake)
    const result = await f.owner.removeLegacy({ library: snapshot, mode: 'library', items: [fake] })
    assert.equal(result.removedFilePaths.length, 0)
    assert.equal(result.failures.length, 1)
    assert.equal(result.library.revision, before.revision)
    assert.equal(result.library.tracks.length, before.total)
    const noExclusions = await f.owner.clearLegacyExclusions(snapshot, [fake.filePath])
    assert.equal(noExclusions.library.revision, before.revision)
    assert.deepEqual((await f.owner.api.queryTracks()).versions, before.versions)
  }
)

test(
  'successful compatibility removal preserves caller edits and leaves unrelated track versions unchanged',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const before = await f.owner.api.queryTracks()
    const remove = before.tracks[0]
    const edit = before.tracks.find((track) => track.filePath !== remove.filePath)!
    const survivor = before.tracks.find(
      (track) => track.filePath !== remove.filePath && track.filePath !== edit.filePath
    )!
    const snapshot = await f.owner.loadLegacyDocument()
    snapshot.tracks = snapshot.tracks.map((track) =>
      (track as { id: string }).id === edit.id
        ? { ...(track as object), custom: 'Caller edit' }
        : track
    )
    const result = await f.owner.removeLegacy({
      library: snapshot,
      mode: 'library',
      items: [{ id: remove.id, filePath: remove.filePath, title: 'Remove', artist: '' }]
    })
    assert.ok(result.removedTrackIds.includes(remove.id))
    assert.equal((await f.owner.api.getTracksByIds([edit.id])).tracks[0].custom, 'Caller edit')
    assert.equal(
      (await f.owner.api.getTracksByIds([survivor.id])).versions[survivor.id],
      before.versions[survivor.id]
    )
  }
)

test(
  'startup abandons revoked scan scopes without reading or removing their tracks',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    await f.database.startScan({ id: 'revoked', mode: 'full', roots: [f.media] })
    await f.database.setScanState('revoked', 'interrupted')
    f.setRoots([f.albumB])
    await assert.rejects(f.owner.resume(), /目录授权已更改/)
    const result = await f.owner.scan('startup')
    assert.equal(result.state, 'completed')
    assert.equal(result.parsedFileCount, 0)
    assert.equal((await f.owner.api.getMetadata()).trackCount, 5)
  }
)

test(
  'fallback polling is incremental and respects explicit cancellation',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    assert.equal(await f.owner.poll(f.albumA), false)
    writeFileSync(f.cue, readFileSync(f.cue, 'utf8').replace('First', 'Polled change'))
    assert.equal(await f.owner.poll(f.albumA), true)
    f.owner.cancel()
    assert.equal(await f.owner.poll(f.albumA), undefined)
  }
)

test(
  'the bounded mutation lane never blocks independent queries',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const page = await f.owner.api.queryTracks(),
      track = page.tracks[0]
    const patch = f.database.patchTracks.bind(f.database)
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const writing = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.database.patchTracks = async (patches) => {
      const result = await patch(patches)
      entered()
      await blocked
      return result
    }
    const pending = Array.from({ length: 16 }, (_, index) =>
      f.owner.api.patchTracks([
        {
          id: track.id,
          expectedVersion: page.versions[track.id] + index,
          patch: { title: `Edit ${index}` }
        }
      ])
    )
    await writing
    await assert.rejects(f.owner.api.patchTracks([]), /修改队列已满/)
    assert.equal((await f.owner.api.getTracksByIds([track.id])).tracks[0].title, 'Edit 0')
    release()
    await Promise.all(pending)
    assert.equal((await f.owner.api.getTracksByIds([track.id])).tracks[0].title, 'Edit 15')
  }
)

test(
  'continue waits for trash handle preparation instead of starting a conflicting parser',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const track = (await f.owner.api.queryTracks()).tracks.find(
      (item) => normalizeLibraryFilePath(item.filePath) === normalizeLibraryFilePath(f.paths[1])
    )!
    await f.database.startScan({ id: 'continue-after-trash', mode: 'full', roots: [f.media] })
    await f.database.setScanState('continue-after-trash', 'cancelled')
    let release!: () => void,
      entered!: () => void,
      starts = 0
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.setPrepareTrash(async () => {
      entered()
      await blocked
    })
    const scan = f.scanner.scanDatabase.bind(f.scanner)
    f.scanner.scanDatabase = (...args) => {
      starts++
      return scan(...args)
    }
    const removal = f.owner.removeFiles(
      [{ id: track.id, filePath: track.filePath, title: 'Trash', artist: '' }],
      'trash'
    )
    await preparing
    const finished = terminal(
      f.owner,
      (status) => status.state === 'completed' && status.jobId === 'continue-after-trash'
    )
    const resume = f.owner.resume()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(starts, 0)
    release()
    await removal
    assert.equal(await resume, true)
    assert.equal((await finished).trackCount, 4)
    assert.equal(starts, 1)
  }
)

test(
  'late scanner status cannot send a revision older than an acknowledged edit',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t)
    await f.owner.scan('full')
    const old = f.owner.scanner.getStatus()!
    const page = await f.owner.api.queryTracks(),
      track = page.tracks[0]
    const revisions: number[] = []
    f.owner.on('changed', (revision: number) => revisions.push(revision))
    const saved = await f.owner.api.patchTracks([
      { id: track.id, expectedVersion: page.versions[track.id], patch: { title: 'Newer edit' } }
    ])
    f.owner.scanner.emit('status', old)
    assert.deepEqual(revisions, [saved.revision])
  }
)
