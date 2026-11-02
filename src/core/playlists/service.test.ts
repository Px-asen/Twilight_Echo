import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CorePlaylistService, type CorePlaylistServiceOptions } from './service.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import type { Playlist } from '../../shared/playlists.ts'
import type { TrackData } from '../../shared/track.ts'
import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import { CorePlaylistImportJobs, type CorePlaylistImportJobsOptions } from './importJobs.ts'
import { EventEmitter, once } from 'node:events'
import type { PlaylistImportDocument } from '../../shared/externalPlaylist.ts'
import { CorePlaylistPreviews } from './previews.ts'
import { createPlaylistReader } from './reader.ts'
import { CorePlaylistSubmission, createPlaylistInputResolver } from './submission.ts'
import { createQueueInputResolver } from '../playback/queueInputResolver.ts'

const song = (i: number): TrackData => ({
  id: `track:${i}`,
  title: `Song ${i}`,
  artist: 'Artist',
  album: 'Album',
  filePath: `D:/Music/${i}.flac`,
  fileName: `${i}.flac`,
  duration: 180,
  size: 1000,
  cover: null,
  lyrics: null,
  source: 'local'
})
async function fixture(t: test.TestContext, extra: Partial<CorePlaylistServiceOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-playlists-'))
  const file = join(root, 'playlists.json')
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 405 }, (_, i) => ({ ...song(i) }))
  })
  const repository = new VersionedDataStore<Playlist[]>({
    filePath: file,
    label: 'playlists',
    maxBytes: 20 * 1024 * 1024,
    isData: Array.isArray,
    isLegacy: Array.isArray
  })
  let largestPage = 0,
    changed = 0
  const options: CorePlaylistServiceOptions = {
    runtime: {
      repository,
      now: Date.now,
      newId: randomUUID,
      clone: structuredClone,
      notify() {},
      identity: createLogicalTrackModel(() => undefined),
      versions: { ensure() {}, revision: () => 0 }
    },
    database: {
      syncPlaylistView: async (request) => db.syncPlaylistView(request),
      queryTracks: async (query) => db.queryTracks(query),
      lookupTracksByPaths: async (paths, revision) => db.lookupTracksByPaths(paths, revision),
      getTracksByIds: async (ids, revision) => {
        largestPage = Math.max(largestPage, ids.length)
        return db.getTracksByIds(ids, revision)
      },
      getMetadata: async () => db.getMetadata()
    },
    versions: { getRevision: () => 0, snapshot: emptyMusicVersions },
    changed: () => {
      changed++
    },
    ...extra
  }
  const service = new CorePlaylistService(options)
  t.after(async () => {
    await service.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    service,
    db,
    options,
    repository,
    file,
    get largestPage() {
      return largestPage
    },
    get changed() {
      return changed
    }
  }
}

async function submissionFixture(t: test.TestContext) {
  const f = await fixture(t)
  await f.service.initialize()
  const resolve = createQueueInputResolver({
    database: {
      getTracksByIds: f.options.database.getTracksByIds,
      readLibraryQueue: async () => {
        throw Error('unused')
      }
    },
    authorizeLocal: async (path) => path,
    providers: () => new Set(['ncm']),
    network: async () => {
      throw Error('unused')
    },
    streams: () => new Map()
  })
  const submission = new CorePlaylistSubmission({
    playlists: f.service,
    resolve: createPlaylistInputResolver(resolve, f.options.database),
    newId: randomUUID,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref()
      return () => clearTimeout(timer)
    }
  })
  t.after(() => submission.shutdown())
  return { ...f, submission }
}

test('catalog membership ignores orphan snapshots and superseded import resolutions without changing the version picker', async t => {
  const f = await fixture(t)
  const a = { ...song(1), id: 'ncm:1', source: 'ncm', filePath: '' }
  const orphan = { ...a, id: 'ncm:orphan' }, previous = { ...a, id: 'ncm:previous' }, chosen = { ...a, id: 'ncm:chosen' }
  const createdAt = '2026-10-23T00:00:00Z'
  await f.repository.save([
    { id: 'ordinary', name: 'Ordinary', createdAt, trackIds: [a.id], trackSnapshots: { [a.id]: a, [orphan.id]: orphan } },
    { id: 'imported', name: 'Imported', createdAt, trackIds: ['entry'], imported: {
      version: 1, source: { kind: 'file', label: 'Saved import' }, complete: true, importedAt: createdAt,
      generation: 'membership-test', membershipRevision: 0,
      entries: [{ entryId: 'entry', position: 0, revision: 1, original: { title: 'Song' },
        resolution: { state: 'streaming', track: previous }, manualBinding: chosen }]
    } }
  ], 0)
  await f.service.initialize()
  assert.deepEqual([...f.service.librarySourceTracks()].map(track => track.id).sort(), [a.id, chosen.id].sort())
  assert.equal([...f.service.sourceTracks()].some(track => track.id === previous.id), true)
})

test('client-bound playlist upload commits every source page once through the existing controller', async (t) => {
  const f = await submissionFixture(t)
  let stage = await f.submission.submit('one', {
    kind: 'begin',
    revision: f.service.getRevision(),
    edit: { kind: 'create', name: 'Uploaded' }
  })
  await assert.rejects(
    f.submission.submit('other', { kind: 'append', id: stage.id, sequence: 1, items: [] }),
    /已结束/
  )
  for (let offset = 0; offset < 405; offset += 200) {
    stage = await f.submission.submit('one', {
      kind: 'append',
      id: stage.id,
      sequence: stage.sequence + 1,
      items: Array.from({ length: Math.min(200, 405 - offset) }, (_, i) => ({
        input: { kind: 'local' as const, id: song(i + offset).id }
      }))
    })
  }
  assert.equal(
    f.service.catalog().items.some((item) => item.name === 'Uploaded'),
    false
  )
  const saved = await f.submission.submit('one', {
    kind: 'commit',
    id: stage.id,
    sequence: stage.sequence + 1
  })
  assert.equal(saved.state, 'committed')
  assert.equal(saved.total, 405)
  assert.equal(f.service.catalog().items.find((item) => item.id === saved.result)!.count, 405)
  await assert.rejects(
    f.submission.submit('one', { kind: 'commit', id: stage.id, sequence: stage.sequence + 1 }),
    /已结束/
  )
  assert.equal(f.service.getRevision(), saved.revision)
})

test('out-of-order uploads fail without publication; disconnect discards only uncommitted staging', async (t) => {
  const f = await submissionFixture(t)
  let stage = await f.submission.submit('one', {
    kind: 'begin',
    revision: f.service.getRevision(),
    edit: { kind: 'create', name: 'Discarded' }
  })
  await assert.rejects(
    f.submission.submit('one', { kind: 'append', id: stage.id, sequence: 2, items: [] }),
    /不可重放/
  )
  stage = await f.submission.submit('one', {
    kind: 'append',
    id: stage.id,
    sequence: 1,
    items: [{ input: { kind: 'local', id: song(1).id } }]
  })
  await f.submission.disconnect('one')
  assert.equal(
    f.service.catalog().items.some((item) => item.name === 'Discarded'),
    false
  )
  await assert.rejects(
    f.submission.submit('one', { kind: 'commit', id: stage.id, sequence: 2 }),
    /已结束/
  )
  const next = await f.service.edit(f.service.getRevision(), {
    kind: 'create',
    name: 'After disconnect'
  })
  assert.ok(next)
})

test('ID-only staged reorders and moves preserve configured identities and return durable results', async (t) => {
  const f = await submissionFixture(t)
  const source = await f.service.saveTrackPages(
    'Source',
    f.service.getRevision(),
    async (append) => {
      await append([song(1), song(2), song(3)])
    }
  )
  const target = (await f.service.edit(source.revision, { kind: 'create', name: 'Target' })) as {
    revision: number
    result: string
  }
  let stage = await f.submission.submit('one', {
    kind: 'begin',
    revision: target.revision,
    edit: { kind: 'reorder', id: source.id, target: 0 }
  })
  stage = await f.submission.submit('one', {
    kind: 'append',
    id: stage.id,
    sequence: 1,
    items: [{ id: 'track:3' }]
  })
  let saved = await f.submission.submit('one', { kind: 'commit', id: stage.id, sequence: 2 })
  assert.deepEqual(
    (await f.service.members({ id: source.id, revision: saved.revision! })).items.map(
      (item) => item.id
    ),
    ['track:3', 'track:1', 'track:2']
  )
  stage = await f.submission.submit('one', {
    kind: 'begin',
    revision: saved.revision!,
    edit: { kind: 'move', id: source.id, targetId: target.result }
  })
  await f.submission.submit('one', {
    kind: 'append',
    id: stage.id,
    sequence: 1,
    items: [{ id: 'track:3', input: { kind: 'local', id: 'track:3' } }]
  })
  saved = await f.submission.submit('one', { kind: 'commit', id: stage.id, sequence: 2 })
  assert.deepEqual(saved.result, { moved: 1, sourceRemoved: 1 })
  assert.deepEqual(
    (await f.service.members({ id: target.result, revision: saved.revision! })).items.map(
      (item) => item.id
    ),
    ['track:3']
  )
})

test('system favorites share the durable playlist owner and survive a rejected stale edit', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const track = song(1)
  assert.equal(await f.service.isFavorite(track), false)
  assert.equal(await f.service.toggleFavorite(track, () => {}), true)
  const saved = JSON.parse(await readFile(f.file, 'utf8'))
  assert.equal(
    saved.data.find((item: Playlist) => item.isDefault).trackIds.includes(track.id),
    true
  )
  await assert.rejects(f.service.edit(0, { kind: 'create', name: 'Stale' }), {
    code: 'STALE_REVISION'
  })
  assert.equal(await f.service.isFavorite(track), true)
  await assert.rejects(
    f.service.toggleFavorite(track, () => {
      throw Error('Occurrence changed')
    }),
    /Occurrence changed/
  )
  assert.equal(await f.service.isFavorite(track), true)
  assert.equal(await f.service.toggleFavorite(track, () => {}), false)
})

test('catalog, member pages and membership checks expose configuration without full playlist snapshots', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const created = await f.service.saveTrackPages(
    'Catalog',
    f.service.getRevision(),
    async (append) => {
      await append(Array.from({ length: 200 }, (_, i) => song(i)))
      await append(Array.from({ length: 200 }, (_, i) => song(i + 200)))
      await append([song(400), song(401), song(402), song(403), song(404)])
    }
  )
  const page = f.service.catalog(0, 1, created.revision)
  assert.equal(page.items.length, 1)
  assert.equal(
    f.service.catalog(0, 200, created.revision).items.find((item) => item.id === created.id)?.count,
    405
  )
  assert.equal('trackIds' in page.items[0], false)
  assert.equal('trackSnapshots' in page.items[0], false)
  const members = await f.service.members({
    id: created.id,
    revision: created.revision,
    anchorId: 'track:404',
    limit: 200
  })
  assert.equal(members.offset, 400)
  assert.equal(members.anchorIndex, 404)
  assert.equal(members.items.length, 5)
  assert.equal(members.items[4].position, 404)
  assert.equal('filePath' in members.items[4].track!, false)
  assert.deepEqual(
    f.service.membership(created.id, created.revision, ['track:404', 'missing']).contains,
    [true, false]
  )
  assert.throws(() => f.service.membership(created.id, 0, ['track:404']), {
    code: 'STALE_REVISION'
  })
  const status = f.service.state()
  status.persistence.failureCount = 99
  assert.equal(f.service.state().persistence.failureCount, 0)
})

test('Core document export and path import retain every page and fence the existing repository', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const created = (await f.service.edit(f.service.getRevision(), {
    kind: 'create',
    name: 'Document'
  })) as { revision: number; result: string }
  const imported = await f.service.importDocument(
    created.result,
    created.revision,
    'fixture.m3u8',
    Array.from({ length: 405 }, (_, i) => song(i).filePath).join('\n')
  )
  assert.equal(imported.result.importedCount, 405)
  const exported = await f.service.exportDocument(created.result, imported.revision, 'm3u8')
  assert.equal(exported.contents.split('\n').filter((line) => line.startsWith('D:')).length, 405)
  assert.ok(exported.contents.includes('D:/Music/404.flac'))
  assert.ok(f.largestPage <= 200)
  await assert.rejects(
    f.service.importDocument(created.result, created.revision, 'fixture.m3u8', 'D:/Music/1.flac'),
    { code: 'STALE_REVISION' }
  )
})

test('import member projection preserves occurrence IDs, original sort and retry states without locations or binding authority', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const created = (await f.service.edit(f.service.getRevision(), {
    kind: 'importCreate',
    document: {
      name: 'Imported',
      source: { kind: 'file', label: 'M3U' },
      songs: [{ title: 'Z', locations: ['D:/secret.flac'] }, { title: 'A' }, { title: 'Z' }],
      complete: true,
      warnings: []
    }
  })) as { revision: number; result: string }
  const data = f.service.readExternal(created.result)!
  await f.service.applyImportResolutions(created.result, data.generation, [
    {
      entryId: data.entries[0].entryId,
      revision: 0,
      resolution: { state: 'local', track: song(0) }
    }
  ])
  const revision = f.service.getRevision()
  const catalog = f.service.catalog(0, 200, revision).items.find((p) => p.id === created.result)!
  assert.equal(catalog.imported!.counts.local, 1)
  assert.equal(catalog.imported!.counts.pending, 2)
  assert.equal('entries' in catalog.imported!, false)
  const sorted = await f.service.members({
    id: created.result,
    revision,
    sort: 'title',
    search: 'Z',
    limit: 1
  })
  assert.equal(sorted.total, 2)
  assert.equal(sorted.items[0].id, data.entries[0].entryId)
  assert.equal('locations' in sorted.items[0].imported!.original, false)
  assert.equal('filePath' in sorted.items[0].imported!.resolution.track!, false)
  const next = await f.service.members({
    id: created.result,
    revision,
    sort: 'title',
    anchorId: data.entries[2].entryId,
    limit: 1
  })
  assert.equal(next.items[0].id, data.entries[2].entryId)
  assert.equal(next.items[0].position, 2)
})

test('paged queue save uses the existing playlist repository, revision fence and complete snapshot data', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const revision = f.service.getRevision()
  const saved = await f.service.saveTrackPages('Queue snapshot', revision, async (append) => {
    await append(Array.from({ length: 200 }, (_, i) => song(i)))
    await append(Array.from({ length: 200 }, (_, i) => song(i + 200)))
    await append(Array.from({ length: 5 }, (_, i) => song(i + 400)))
  })
  const disk = JSON.parse(await readFile(f.file, 'utf8'))
  const playlist: Playlist = disk.data.find((item: Playlist) => item.id === saved.id)
  assert.equal(saved.revision, disk.revision)
  assert.equal(playlist.trackIds.length, 405)
  assert.equal(playlist.trackSnapshots?.[song(404).id]?.filePath, song(404).filePath)
  await assert.rejects(
    f.service.saveTrackPages('Old revision', revision, async () => {}),
    { code: 'STALE_REVISION' }
  )
})

test('Core imports a plugin batch durably without a renderer, with bounded SQL matching and stable identity', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const before = f.service.getRevision()
  await f.service.importFromPlugin({
    pluginId: 'fixture',
    playlists: [
      {
        name: 'Imported',
        paths: [
          ...Array.from({ length: 405 }, (_, i) => song(i).filePath),
          song(0).filePath,
          'missing.flac'
        ]
      }
    ]
  })
  const page = f.service.list()
  const playlist = page.items.find((p) => p.name === 'Imported')!
  assert.equal(playlist.count, 405)
  assert.equal(page.revision, before + 1)
  assert.equal(f.largestPage, 200)
  assert.equal('trackIds' in playlist, false)
  const entries = await f.service.entries(playlist.id, page.revision, 400)
  assert.deepEqual(
    entries.items.map((row) => row.id),
    [400, 401, 402, 403, 404].map((i) => song(i).id)
  )
  assert.equal('filePath' in entries.items[0].track!, false)
  const saved = JSON.parse(await readFile(f.file, 'utf8'))
  assert.equal(saved.data.find((p: Playlist) => p.id === playlist.id).trackIds.length, 405)
  await f.service.importFromPlugin({
    pluginId: 'fixture',
    playlists: [{ name: 'Imported', paths: [song(0).filePath] }]
  })
  assert.equal(f.service.list().items.find((p) => p.name === 'Imported')!.id, playlist.id)
  assert.equal(f.service.list().items.find((p) => p.name === 'Imported')!.count, 405)
})

test('Core accepts one background playlist repair, survives client cancellation and persists its trusted matches', async (t) => {
  let finish!: (
    result: import('../../shared/playlistLifecycle.ts').PlaylistRelocationResult
  ) => void
  const scanning = new Promise<
    import('../../shared/playlistLifecycle.ts').PlaylistRelocationResult
  >((resolve) => {
    finish = resolve
  })
  let entered!: () => void
  const enteredScan = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = await fixture(t, {
    findRelocationsInFolder: async (missing, folder) => {
      assert.equal(folder, 'E:/Moved')
      assert.deepEqual(
        missing.map((track) => track.id),
        [song(999).id]
      )
      entered()
      return scanning
    }
  })
  await f.service.initialize()
  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Repair' })
  const playlist = f.service.list().items.find((item) => item.name === 'Repair')!
  await f.service.edit(f.service.getRevision(), {
    kind: 'add',
    id: playlist.id,
    tracks: [song(999)]
  })
  const client = new AbortController()
  const accepted = await f.service.startRepair(
    playlist.id,
    f.service.getRevision(),
    'E:/Moved',
    client.signal
  )
  await enteredScan
  client.abort(new Error('Renderer closed'))
  assert.equal(accepted.state, 'running')
  await assert.rejects(
    f.service.startRepair(playlist.id, f.service.getRevision(), 'E:/Other'),
    (error: any) => error.code === 'BUSY'
  )
  finish({
    relocations: [{ trackId: song(999).id, fromPath: song(999).filePath, toTrack: song(1) }],
    unresolvedTrackIds: [],
    ambiguousTrackIds: []
  })
  for (let i = 0; i < 100 && f.service.repairSnapshot()?.state === 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(f.service.repairSnapshot()?.state, 'completed')
  assert.equal(f.service.repairSnapshot()?.relocated, 1)
  const entries = await f.service.entries(playlist.id, f.service.getRevision())
  assert.deepEqual(
    entries.items.map((entry) => entry.id),
    [song(1).id]
  )
  const disk = JSON.parse(await readFile(f.file, 'utf8'))
  assert.deepEqual(disk.data.find((item: Playlist) => item.id === playlist.id).trackIds, [
    song(1).id
  ])
  assert.doesNotMatch(JSON.stringify(f.service.repairSnapshot()), /filePath|fromPath/)
})

test('a long Core repair rejects a renamed target and leaves its new playlist definition intact', async (t) => {
  let finish!: (
    result: import('../../shared/playlistLifecycle.ts').PlaylistRelocationResult
  ) => void
  const scanning = new Promise<
    import('../../shared/playlistLifecycle.ts').PlaylistRelocationResult
  >((resolve) => {
    finish = resolve
  })
  let entered!: () => void
  const enteredScan = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = await fixture(t, {
    findRelocationsInFolder: async () => {
      entered()
      return scanning
    }
  })
  await f.service.initialize()
  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Original' })
  const playlist = f.service.list().items.find((item) => item.name === 'Original')!
  await f.service.edit(f.service.getRevision(), {
    kind: 'add',
    id: playlist.id,
    tracks: [song(999)]
  })
  await assert.rejects(
    f.service.startRepair(playlist.id, 0, 'E:/Moved'),
    (error: any) => error.code === 'STALE_REVISION'
  )
  await f.service.startRepair(playlist.id, f.service.getRevision(), 'E:/Moved')
  await enteredScan
  await f.service.edit(f.service.getRevision(), {
    kind: 'rename',
    id: playlist.id,
    name: 'Renamed'
  })
  finish({
    relocations: [{ trackId: song(999).id, fromPath: song(999).filePath, toTrack: song(1) }],
    unresolvedTrackIds: [],
    ambiguousTrackIds: []
  })
  for (let i = 0; i < 100 && f.service.repairSnapshot()?.state === 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(f.service.repairSnapshot()?.state, 'failed')
  assert.match(f.service.repairSnapshot()!.error!, /重命名|删除/)
  assert.deepEqual(
    (await f.service.entries(playlist.id, f.service.getRevision())).items.map((entry) => entry.id),
    [song(999).id]
  )
})

test('concurrent window edits fence the same committed revision and a cancelled queued command cannot mutate it', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const revision = f.service.getRevision()
  const first = f.service.edit(revision, { kind: 'create', name: 'First' })
  const second = f.service.edit(revision, { kind: 'create', name: 'Stale' })
  await first
  await assert.rejects(second, (error: { code: string }) => error.code === 'STALE_REVISION')
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(
    f.service.edit(
      f.service.getRevision(),
      { kind: 'create', name: 'Cancelled' },
      controller.signal
    ),
    /cancelled/
  )
  assert.deepEqual(
    f.service.list().items.map((p) => p.name),
    ['我收藏的音乐', 'First']
  )
})

test('Core rematch persists ordinary playlist and favorite references with existing order, dedup and compact snapshot rules', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const old = { ...song(0), id: 'ncm:old', source: 'ncm', filePath: 'ncm:old' }
  const next = {
    ...song(1),
    id: 'fixture:new',
    source: 'fixture',
    filePath: 'fixture:new',
    lyrics: 'not a playlist payload',
    metadataMatch: {
      providerId: 'other',
      trackId: 'other:1',
      confidence: 'high' as const,
      score: 100
    }
  }
  await f.service.edit(f.service.getRevision(), { kind: 'favorite', tracks: [old], favorite: true })
  const created = (await f.service.edit(f.service.getRevision(), {
    kind: 'create',
    name: 'Repair list'
  })) as { result: string }
  await f.service.edit(f.service.getRevision(), {
    kind: 'add',
    id: created.result,
    tracks: [old, next, song(2)]
  })
  const before = JSON.parse(await readFile(f.file, 'utf8'))
  const result = await f.service.replaceTrackReference(old.id, next, f.service.getRevision())
  assert.equal(result.count, 2)
  assert.equal(result.revision, before.revision + 1)
  const after = JSON.parse(await readFile(f.file, 'utf8'))
  assert.deepEqual(
    after.data.map((p: Playlist) => p.id),
    before.data.map((p: Playlist) => p.id)
  )
  assert.deepEqual(after.data.find((p: Playlist) => p.id === created.result).trackIds, [
    next.id,
    song(2).id
  ])
  const favorite = after.data.find((p: Playlist) => p.isDefault)
  assert.deepEqual(favorite.trackIds, [next.id])
  assert.equal(favorite.trackSnapshots[old.id], undefined)
  assert.equal(favorite.trackSnapshots[next.id].title, next.title)
  assert.equal(favorite.trackSnapshots[next.id].lyrics, null)
  assert.equal(favorite.trackSnapshots[next.id].metadataMatch, undefined)
  assert.equal(
    (await f.service.entries(created.result, result.revision)).items[0].track?.id,
    next.id
  )
  await assert.rejects(
    f.service.replaceTrackReference(next.id, old, before.revision),
    (e) => (e as { code: string }).code === 'STALE_REVISION'
  )
  const cancelled = new AbortController()
  cancelled.abort(Error('cancelled source repair'))
  await assert.rejects(
    f.service.replaceTrackReference(next.id, old, result.revision, cancelled.signal),
    /cancelled source repair/
  )
  assert.deepEqual(await f.service.replaceTrackReference(old.id, next, result.revision), {
    revision: result.revision,
    count: 0
  })
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), after)
})

test('source rematch updates authoritative imported resolutions and bindings, preserving duplicate occurrences and rejecting old matching work', async (t) => {
  const f = await fixture(t)
  const old = { ...song(7), id: 'expired:7', source: 'expired' },
    next = { ...song(8), id: 'other:8', source: 'other' },
    manuallyChosen = { ...song(9), id: 'other:9', source: 'other' }
  const original = {
    title: old.title,
    artist: old.artist,
    platform: 'ncm' as const,
    platformId: '7'
  }
  const entries = [
    {
      entryId: 'auto',
      position: 0,
      revision: 2,
      original,
      resolution: { state: 'streaming', track: old }
    },
    {
      entryId: 'manual',
      position: 1,
      revision: 4,
      original,
      manualBinding: old,
      resolution: { state: 'streaming', track: old }
    },
    {
      entryId: 'new-choice',
      position: 2,
      revision: 9,
      original,
      manualBinding: manuallyChosen,
      resolution: { state: 'pending' }
    }
  ]
  await writeFile(
    f.file,
    JSON.stringify([
      {
        id: 'imported',
        name: 'Imported',
        createdAt: '2024-01-01',
        trackIds: [],
        imported: {
          version: 1,
          source: { kind: 'platform', label: 'Fixture', platform: 'ncm' },
          entries,
          generation: 'original-generation',
          membershipRevision: 3,
          complete: true,
          importedAt: '2024-01-01'
        }
      }
    ])
  )
  await f.service.initialize()
  const before = f.service.readExternal('imported')!
  const saved = await f.service.replaceTrackReference(old.id, next)
  assert.equal(saved.count, 1)
  const after = f.service.readExternal('imported')!
  assert.equal(after.generation, before.generation)
  assert.equal(after.membershipRevision, before.membershipRevision)
  assert.deepEqual(
    after.entries.map((e) => e.entryId),
    entries.map((e) => e.entryId)
  )
  assert.deepEqual(
    after.entries.map((e) => e.revision),
    [3, 5, 9]
  )
  assert.deepEqual(
    after.entries.slice(0, 2).map((e) => e.resolution.track!.id),
    [next.id, next.id]
  )
  assert.equal(after.entries[0].manualBinding, undefined)
  assert.equal(after.entries[1].manualBinding!.id, next.id)
  assert.equal(after.entries[2].manualBinding!.id, manuallyChosen.id)
  assert.deepEqual(
    after.entries.map((e) => e.original),
    entries.map((e) => e.original)
  )
  await f.service.applyImportResolutions('imported', before.generation, [
    { entryId: 'auto', revision: 2, resolution: { state: 'streaming', track: old } }
  ])
  assert.equal(f.service.readExternal('imported')!.entries[0].resolution.track!.id, next.id)
  const persisted = JSON.parse(await readFile(f.file, 'utf8')).data.find(
    (p: Playlist) => p.id === 'imported'
  )
  assert.deepEqual(persisted.imported.entries, after.entries)
  assert.deepEqual(persisted.trackIds, [])
})

test('local playlist search reads committed ordinary playlists with the existing name/page/count rules', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Moon one' })
  await f.service.edit(f.service.getRevision(), {
    kind: 'create',
    name: 'Moon aggregate',
    aggregate: true
  })
  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Moon two' })
  const page = f.service.searchLocal('moon', 1, 1)
  assert.equal(page.revision, f.service.getRevision())
  assert.equal(page.total, 2)
  assert.equal(page.items[0].name, 'Moon two')
  assert.equal(page.items[0].trackCount, 0)
  assert.equal(f.service.searchLocal('!!!', 10, 0).total, 0)
  assert.equal('trackIds' in page.items[0], false)
})

test('queries remain at the committed revision while a new document is awaiting disk acknowledgment', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const saving = new Promise<void>((resolve) => {
    entered = resolve
  })
  const save = f.options.runtime.repository.save.bind(f.options.runtime.repository)
  f.options.runtime.repository.save = async (...args) => {
    entered()
    await blocked
    return save(...args)
  }
  const before = f.service.list()
  const edit = f.service.edit(before.revision, { kind: 'create', name: 'Pending' })
  await saving
  assert.deepEqual(f.service.list(), before)
  release()
  await edit
  assert.equal(f.service.list().items.at(-1)!.name, 'Pending')
  assert.equal(f.service.getRevision(), before.revision + 1)
})

test('favorites keep recording identity, aggregate names keep a separate namespace, and reorders persist', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  await f.service.edit(f.service.getRevision(), {
    kind: 'favorite',
    tracks: [song(0), song(0)],
    favorite: true
  })
  assert.equal(f.service.list().items[0].count, 1)
  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Same' })
  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Same', aggregate: true })
  assert.equal(f.service.list().items.filter((p) => p.name === 'Same').length, 2)
  const id = f.service.list().items.find((p) => p.name === 'Same' && !p.kind)!.id
  await f.service.edit(f.service.getRevision(), {
    kind: 'add',
    id,
    tracks: [song(0), song(1), song(2)]
  })
  await f.service.edit(f.service.getRevision(), {
    kind: 'reorder',
    id,
    ids: [song(2).id],
    target: 0
  })
  assert.deepEqual(
    (await f.service.entries(id, f.service.getRevision())).items.map((p) => p.id),
    [song(2).id, song(0).id, song(1).id]
  )
  const loaded = await f.repository.load()
  assert.deepEqual(loaded!.data.find((p) => p.id === id)!.trackIds, [
    song(2).id,
    song(0).id,
    song(1).id
  ])
})

test('existing JSON playlists preserve CUE occurrences and legacy file shape across a new Core attachment', async (t) => {
  const f = await fixture(t)
  const track = { ...song(0), id: 'cue:1', cueRange: { startSeconds: 10, endSeconds: 40 } }
  await writeFile(
    f.file,
    JSON.stringify([
      {
        id: 'legacy',
        name: 'Legacy',
        isDefault: true,
        createdAt: '2024-01-01',
        trackIds: [track.id, track.id],
        trackSnapshots: { [track.id]: track }
      }
    ])
  )
  await f.service.initialize()
  const entries = await f.service.entries('legacy', 0)
  assert.deepEqual(
    entries.items.map((p) => p.id),
    ['cue:1', 'cue:1']
  )
  assert.deepEqual(entries.items[0].track!.cueRange, {
    startSeconds: 10,
    endSeconds: 40,
    pregapSeconds: 0,
    sourcePregapSeconds: 0,
    virtualPregapSeconds: 0
  })
  await f.service.edit(0, { kind: 'rename', id: 'legacy', name: 'Renamed' })
  const saved = await f.repository.load()
  assert.equal(saved!.version, 2)
  assert.deepEqual(saved!.data[0].trackIds, ['cue:1', 'cue:1'])
})

test('JSON developer-library imports use the original full-library resolver rather than SQL fallback', async (t) => {
  const f = await fixture(t, {
    loadJsonLibrary: async () => ({ revision: 7, tracks: [song(0), song(1)] })
  })
  await f.service.initialize()
  await f.service.importFromPlugin({
    pluginId: 'fixture',
    playlists: [{ name: 'JSON', paths: ['0.flac', song(1).filePath] }]
  })
  assert.equal(f.largestPage, 0)
  assert.equal(f.service.list().items.find((p) => p.name === 'JSON')!.count, 2)
})

test('Core SQL views own preferred recording, aggregate variants and source counts without client uploads', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const remote = {
    ...song(0),
    id: 'ncm:7',
    source: 'ncm',
    ncmSongId: 7,
    filePath: 'ncm:7',
    streamUrl: 'https://expired.invalid/?token=private'
  }
  await f.service.edit(f.service.getRevision(), {
    kind: 'create',
    name: 'Aggregate',
    aggregate: true
  })
  const aggregate = f.service.list().items.find((p) => p.name === 'Aggregate')!
  await f.service.edit(f.service.getRevision(), {
    kind: 'add',
    id: aggregate.id,
    tracks: [remote, song(0)]
  })
  const input = { id: aggregate.id, revision: f.service.getRevision(), versionsRevision: 0 }
  const rows = await f.service.view(input)
  assert.equal(rows.page.total, 1)
  assert.equal(rows.page.tracks[0].id, song(0).id)
  assert.equal(rows.page.aggregate!.rows[0].variantCount, 2)
  const row = rows.page.aggregate!.rows[0].rowId
  const variants = await f.service.view({ ...input, variantRow: row })
  assert.deepEqual(
    variants.page.tracks.map((t) => t.id),
    [song(0).id, remote.id]
  )
  assert.equal(variants.page.entryIds!.length, 2)
  assert.doesNotMatch(JSON.stringify(variants), /streamUrl|expired.invalid|filePath|private/)
  const sources = await f.service.view({ ...input, sourceCounts: true })
  assert.deepEqual(sources.page.aggregate!.sources, [
    { source: 'local', count: 1, hidden: false },
    { source: 'ncm', count: 1, hidden: false }
  ])
  await f.service.edit(input.revision, {
    kind: 'hiddenSources',
    id: aggregate.id,
    sources: ['local']
  })
  await assert.rejects(f.service.view(input), (e: { code: string }) => e.code === 'STALE_REVISION')
  const hidden = await f.service.view({ ...input, revision: f.service.getRevision() })
  assert.equal(hidden.page.tracks[0].id, remote.id)

  await f.service.edit(f.service.getRevision(), { kind: 'create', name: 'Preferred' })
  const normal = f.service.list().items.find((p) => p.name === 'Preferred')!
  await f.service.edit(f.service.getRevision(), { kind: 'add', id: normal.id, tracks: [remote] })
  const preferred = await f.service.view({
    id: normal.id,
    revision: f.service.getRevision(),
    versionsRevision: 0
  })
  assert.equal(preferred.page.tracks[0].id, song(0).id)
  assert.equal(
    (
      await f.service.view({
        id: normal.id,
        revision: f.service.getRevision(),
        versionsRevision: 0,
        preserveSources: true
      })
    ).page.tracks[0].id,
    remote.id
  )
})

test('version revisions fence cached playlist views and a mutation during a read cannot return stale rows', async (t) => {
  let revision = 0
  const document = emptyMusicVersions()
  const f = await fixture(t, {
    versions: { getRevision: () => revision, snapshot: () => structuredClone(document) }
  })
  await f.service.initialize()
  await f.service.edit(f.service.getRevision(), {
    kind: 'favorite',
    tracks: [song(0)],
    favorite: true
  })
  const id = f.service.list().items[0].id,
    input = { id, revision: f.service.getRevision(), versionsRevision: 0 }
  await f.service.view(input)
  revision++
  document.tracks.versions.push({
    id: 'manual',
    label: 'Master',
    sources: ['a', 'b'],
    preferredSource: null
  })
  await assert.rejects(f.service.view(input), (e: { code: string }) => e.code === 'STALE_REVISION')
  let entered!: () => void, release!: () => void
  const reading = new Promise<void>((r) => (entered = r)),
    blocked = new Promise<void>((r) => (release = r))
  const query = f.options.database.queryTracks
  f.options.database.queryTracks = async (...args) => {
    entered()
    await blocked
    return query(...args)
  }
  const pending = assert.rejects(
    f.service.view({ ...input, versionsRevision: 1 }),
    (e: { code: string }) => e.code === 'STALE_REVISION'
  )
  await reading
  await f.service.edit(input.revision, { kind: 'rename', id, name: 'Changed while reading' })
  release()
  await pending
})

test('JSON views retain repeat occurrences, aggregation and real library revision without touching SQL', async (t) => {
  const f = await fixture(t, {
    loadJsonLibrary: async () => ({ revision: 9, tracks: [song(0), song(1)] })
  })
  await writeFile(
    f.file,
    JSON.stringify([
      {
        id: 'legacy',
        name: 'Repeated',
        isDefault: true,
        createdAt: '2024-01-01',
        trackIds: [song(0).id, song(0).id, song(1).id]
      }
    ])
  )
  await f.service.initialize()
  const view = await f.service.view({
    id: 'legacy',
    revision: 0,
    versionsRevision: 0,
    offset: 1,
    limit: 2
  })
  assert.equal(view.page.revision, 9)
  assert.deepEqual(view.page.entryIds, ['1', '2'])
  assert.deepEqual(
    view.page.tracks.map((t) => t.id),
    [song(0).id, song(1).id]
  )
  await assert.rejects(
    f.service.view({ id: 'legacy', revision: 0, versionsRevision: 0, contentRevision: 8 }),
    /曲库已变化/
  )
  await f.service.edit(0, { kind: 'create', name: 'Aggregate', aggregate: true })
  const id = f.service.list().items.find((p) => p.name === 'Aggregate')!.id
  const remote = { ...song(0), id: 'ncm:1', source: 'ncm', filePath: 'ncm:1' }
  await f.service.edit(f.service.getRevision(), { kind: 'add', id, tracks: [remote, song(0)] })
  const input = { id, revision: f.service.getRevision(), versionsRevision: 0 }
  const rows = await f.service.view(input)
  assert.equal(rows.page.total, 1)
  assert.equal(rows.page.aggregate!.rows[0].variantCount, 2)
  const variants = await f.service.view({
    ...input,
    variantRow: rows.page.aggregate!.rows[0].rowId
  })
  assert.deepEqual(variants.page.entryIds, ['1', '0'])
})

async function matchingFixture(
  t: test.TestContext,
  extra: Partial<CorePlaylistImportJobsOptions> = {}
) {
  const f = await fixture(t)
  await f.service.initialize()
  const events = new EventEmitter(),
    failures: unknown[] = []
  const provider = { id: 'ncm', getPlaybackUrl: true }
  const options: CorePlaylistImportJobsOptions = {
    providers: { list: () => [provider], get: (id) => (id === 'ncm' ? provider : undefined) },
    localCandidates: async () => ({ candidates: [] }),
    authorizeLocal: async () => true,
    now: () => 123456789,
    read: (id) => f.service.readExternal(id),
    ids: () => f.service.externalIds(),
    apply: (...args) => f.service.applyImportResolutions(...args),
    changed: () => events.emit('change'),
    failed: (error) => failures.push(error),
    delay: async (_ms, signal) => {
      signal?.throwIfAborted()
    },
    ...extra
  }
  const jobs = new CorePlaylistImportJobs(options)
  const add = async (songs: PlaylistImportDocument['songs']) => {
    const result = (await f.service.edit(f.service.getRevision(), {
      kind: 'importCreate',
      document: {
        name: 'External',
        songs,
        source: { kind: 'file', label: 'Fixture' },
        warnings: [],
        complete: true
      }
    })) as { result: string }
    return result.result
  }
  const finished = async (id: string) => {
    while (!jobs.status(id) || jobs.status(id)!.running) await once(events, 'change')
  }
  return { ...f, jobs, options, add, finished, failures }
}

test('Core matching checkpoints complete occurrences, caches repeated songs and persists before completion', async (t) => {
  let searches = 0
  const f = await matchingFixture(t, {
    localCandidates: async () => {
      searches++
      return { candidates: [] }
    }
  })
  const id = await f.add(
    Array.from({ length: 205 }, () => ({ title: 'Remote', platform: 'ncm', platformId: '7' }))
  )
  try {
    f.jobs.activate()
    await f.finished(id)
    assert.equal(searches, 1)
    const data = f.service.readExternal(id)!
    assert.equal(data.entries.length, 205)
    assert.equal(new Set(data.entries.map((e) => e.entryId)).size, 205)
    assert.ok(
      data.entries.every(
        (e) => e.resolution.state === 'streaming' && e.resolution.track!.id === 'ncm:7'
      )
    )
    const disk = JSON.parse(await readFile(f.file, 'utf8')).data.find((p: Playlist) => p.id === id)
    assert.deepEqual(disk.imported, JSON.parse(JSON.stringify(data)))
    assert.equal(f.jobs.status(id)!.done, 205)
    assert.deepEqual(f.failures, [])
  } finally {
    await f.jobs.shutdown()
  }
})

test('cancel persists retryable states; an old match cannot overwrite a newer manual binding', async (t) => {
  let entered!: () => void, release!: (value: { candidates: TrackData[] }) => void
  const searching = new Promise<void>((r) => (entered = r)),
    blocked = new Promise<{ candidates: TrackData[] }>((r) => (release = r))
  const f = await matchingFixture(t, {
    localCandidates: async () => {
      entered()
      return blocked
    }
  })
  const id = await f.add([{ title: 'Remote', platform: 'ncm', platformId: '7' }])
  try {
    f.jobs.activate()
    await searching
    const entry = f.service.readExternal(id)!.entries[0]
    const bound = { ...song(99), id: 'ncm:99', source: 'ncm', filePath: 'ncm:99' }
    await f.service.edit(f.service.getRevision(), {
      kind: 'importBind',
      id,
      entryId: entry.entryId,
      track: bound
    })
    release({ candidates: [] })
    await f.finished(id)
    const saved = f.service.readExternal(id)!.entries[0]
    assert.equal(saved.entryId, entry.entryId)
    assert.equal(saved.revision, 1)
    assert.equal(saved.resolution.track!.id, 'ncm:99')

    let cancelStarted!: () => void
    const waiting = new Promise<void>((r) => (cancelStarted = r))
    f.options.localCandidates = async (_song, signal) => {
      cancelStarted()
      return new Promise((_r, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    }
    // A second job fixture uses the captured resolver port, which is immutable.
    const stopped = new CorePlaylistImportJobs({
      ...f.options,
      localCandidates: f.options.localCandidates
    })
    const second = await f.add([{ title: 'Remote', platform: 'ncm', platformId: '8' }])
    stopped.activate()
    await waiting
    await stopped.stop(second)
    assert.equal(f.service.readExternal(second)!.entries[0].resolution.state, 'cancelled')
    stopped.reconcile()
    assert.equal(stopped.status(second)!.running, false)
    await stopped.shutdown()
  } finally {
    await f.jobs.shutdown()
  }
})

test('a checkpoint failure is surfaced once instead of continuously reissuing pending writes', async (t) => {
  let attempts = 0
  const f = await matchingFixture(t, {
    apply: async () => {
      attempts++
      throw Error('disk write failed')
    }
  })
  const id = await f.add([{ title: 'Remote', platform: 'ncm', platformId: '7' }])
  try {
    f.jobs.activate()
    await f.finished(id)
    f.jobs.reconcile()
    await Promise.resolve()
    assert.equal(attempts, 1)
    assert.match(f.jobs.status(id)!.error!, /disk write failed/)
    assert.equal(f.service.readExternal(id)!.entries[0].resolution.state, 'pending')
    assert.equal(f.failures.length, 1)
  } finally {
    await f.jobs.shutdown()
  }
})

test('saving a Core preview preserves occurrence IDs and manual results, with one durable library commit', async (t) => {
  const f = await fixture(t)
  await f.service.initialize()
  const doc: PlaylistImportDocument = {
    name: 'Preview save',
    source: { kind: 'file', label: 'Fixture' },
    warnings: [],
    complete: true,
    songs: [
      { platform: 'ncm', platformId: '7' },
      { platform: 'ncm', platformId: '7' }
    ]
  }
  const previews = new CorePlaylistPreviews({
    now: Date.now,
    newId: randomUUID,
    reader: createPlaylistReader({
      providers: () => [],
      resolveShortLink: async () => {
        throw Error('not used')
      },
      readPage: async () => {
        throw Error('not used')
      }
    }),
    chooseFile: async () => 'selected-file',
    readFile: async () => doc,
    save: (playlist, command, signal) => f.service.savePreview(playlist, command, signal),
    changed() {},
    reconcile() {}
  })
  t.after(() => previews.shutdown())
  let p = (await previews.file(new AbortController().signal))!
  const data = previews.read(p.id)!,
    ids = data.entries.map((e) => e.entryId)
  const track = { ...song(7), id: 'ncm:7', source: 'ncm', filePath: 'ncm:7' }
  await previews.apply(
    p.id,
    data.generation,
    ids.map((entryId) => ({ entryId, revision: 0, resolution: { state: 'streaming', track } }))
  )
  p = previews.status(p.id)
  assert.equal(
    f.service.list().items.some((item) => item.id === p.id),
    false
  )
  const saved = await previews.save({
    id: p.id,
    revision: p.revision,
    playlistsRevision: f.service.getRevision()
  })
  const disk = JSON.parse(await readFile(f.file, 'utf8'))
  const adopted = disk.data.find((item: Playlist) => item.id === p.id)
  assert.equal(disk.revision, saved.revision)
  assert.equal(adopted.transient, undefined)
  assert.deepEqual(
    adopted.imported.entries.map((e: { entryId: string }) => e.entryId),
    ids
  )
  assert.deepEqual(
    adopted.imported.entries.map(
      (e: { resolution: { track: TrackData } }) => e.resolution.track.id
    ),
    ['ncm:7', 'ncm:7']
  )
  const fresh = (await previews.file(new AbortController().signal))!
  await assert.rejects(
    previews.save({ id: fresh.id, revision: fresh.revision, playlistsRevision: 0 }),
    (e: { code: string }) => e.code === 'STALE_REVISION'
  )
  assert.equal(previews.has(fresh.id), true)
  const generation = f.service.readExternal(saved.id)!.generation
  const targetEntry = f.service.readExternal(saved.id)!.entries[0]
  previews.bind(
    fresh.id,
    previews.status(fresh.id).revision,
    previews.read(fresh.id)!.entries[0].entryId,
    { ...song(99), source: 'ncm', id: 'ncm:99' }
  )
  const refreshed = await previews.save({
    id: fresh.id,
    revision: previews.status(fresh.id).revision,
    playlistsRevision: saved.revision,
    target: { id: saved.id, generation }
  })
  assert.equal(refreshed.id, saved.id)
  const result = f.service.readExternal(saved.id)!
  assert.equal(result.entries[0].entryId, targetEntry.entryId)
  assert.equal(result.entries[0].manualBinding!.id, 'ncm:99')
  assert.equal(result.entries[0].revision, targetEntry.revision + 1)
})

test('the read-only recent view pages every recorded source, filters in SQL and never edits saved playlists', async (t) => {
  let revision = 7
  const remote = {
    ...song(900),
    id: 'ncm:900',
    source: 'ncm',
    filePath: 'ncm:900',
    title: 'Remote song'
  }
  let recent: Playlist = {
    id: 'core:recent',
    name: '最近播放',
    createdAt: '',
    trackIds: [...Array.from({ length: 405 }, (_, i) => song(i).id), remote.id, 'deleted'],
    trackSnapshots: { [remote.id]: remote, deleted: { ...song(999), id: 'deleted' } }
  }
  const f = await fixture(t, {
    recentHistory: { getRevision: () => revision, recentPlaylist: () => recent }
  })
  await f.service.initialize()
  const before = f.service.getRevision()
  const query = { id: 'core:recent', revision, versionsRevision: 0, preserveSources: true }
  const first = await f.service.view({ ...query, limit: 200 })
  const last = await f.service.view({ ...query, offset: 400, limit: 200 })
  assert.equal(first.page.total, 406)
  assert.equal(first.page.tracks.length, 200)
  assert.deepEqual(
    last.page.tracks.map((track) => track.id),
    ['track:400', 'track:401', 'track:402', 'track:403', 'track:404', remote.id]
  )
  const filtered = await f.service.view({ ...query, query: { filters: { provider: 'ncm' } } })
  assert.deepEqual(
    filtered.page.tracks.map((track) => track.id),
    [remote.id]
  )
  const local = await f.service.view({ ...query, query: { filters: { provider: 'local' } } })
  assert.equal(local.page.total, 405)
  const none = await f.service.view({ ...query, search: 'no match' })
  assert.equal(none.page.total, 0)
  f.db.syncListeningHistory({ kind: 'begin', id: 'recent-history', mode: 'replace' })
  f.db.syncListeningHistory({
    kind: 'append',
    id: 'recent-history',
    sequence: 1,
    entries: recent.trackIds.map((id, index) => ({ id, lastPlayed: index + 1 }))
  })
  const history = f.db.syncListeningHistory({ kind: 'commit', id: 'recent-history', sequence: 2 })
  const orderedQuery = {
    sort: 'lastPlayed' as const,
    direction: 'desc' as const,
    historyRevision: history.revision
  }
  const ordered = await f.service.view({ ...query, query: orderedQuery })
  assert.equal(ordered.page.tracks[0].id, remote.id)
  const allQueue = f.db.createLibraryQueue(
    { ...orderedQuery, playlistView: ordered.viewId },
    remote.id
  )
  assert.equal(allQueue.total, 406)
  assert.equal(f.db.readLibraryQueue(allQueue.id).items[0].track?.source, 'ncm')
  assert.equal(f.db.readLibraryQueue(allQueue.id, 400).items.length, 6)
  const remoteQueue = f.db.createLibraryQueue({
    ...orderedQuery,
    playlistView: ordered.viewId,
    filters: { provider: 'ncm' }
  })
  assert.equal(remoteQueue.total, 1)
  assert.equal(f.db.readLibraryQueue(remoteQueue.id).items[0].track?.id, remote.id)
  revision++
  recent = { ...recent, trackIds: [] }
  await assert.rejects(f.service.view(query), /播放记录已变化/)
  const empty = await f.service.view({ ...query, revision })
  assert.equal(empty.page.total, 0)
  assert.equal(f.service.getRevision(), before)
  assert.equal(
    f.service.catalog().items.some((item) => item.id === 'core:recent'),
    false
  )
})
