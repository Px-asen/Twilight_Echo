import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CoreLibraryLoudnessService } from './libraryLoudnessService.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { LoudnessInputGroup, LoudnessGroupMeasurement } from '../../shared/libraryLoudness.ts'
import { LIBRARY_LOUDNESS_ALGORITHM_VERSION } from '../../shared/libraryLoudness.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const measured = (group: LoudnessInputGroup): LoudnessGroupMeasurement => {
  const value = {
    integratedLufs: -20,
    truePeakDb: -1,
    source: 'analyzed' as const,
    analyzedAt: '2026-10-22T12:00:00Z',
    algorithmVersion: LIBRARY_LOUDNESS_ALGORITHM_VERSION,
    available: true
  }
  return {
    tracks: group.tracks.map(() => ({ ...value })),
    album: group.mode === 'album' ? { ...value } : null
  }
}
async function fixture(
  t: test.TestContext,
  tracks: (root: string) => LibraryTrackRecord[],
  analyze?: (group: LoudnessInputGroup) => Promise<LoudnessGroupMeasurement>,
  cancelWork = () => {}
) {
  const root = await mkdtemp(join(tmpdir(), 'core-library-loudness-'))
  const rows = tracks(root)
  for (const file of new Set(rows.map((track) => track.filePath))) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'source')
  }
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 4, tracks: rows, folders: [root], exclusions: [] })
  const groups: LoudnessInputGroup[] = []
  let serial = 0
  const service = new CoreLibraryLoudnessService({
    root,
    database: {
      createTrackSelection: async (request) => db.createTrackSelection(request),
      readTrackSelection: async (...args) => db.readTrackSelection(...args),
      closeTrackSelection: async (id) => db.closeTrackSelection(id),
      queryTracks: async (query) => db.queryTracks(query),
      queryCollections: async (kind, query) => db.queryCollections(kind, query),
      getMetadata: async () => db.getMetadata()
    },
    authorizePath: async (path) => path,
    analyze: async (group) => {
      groups.push(group)
      return analyze ? analyze(group) : measured(group)
    },
    cancelWork,
    newId: () => `plan:${++serial}`,
    changed: () => {}
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const selection = (ids: string[]) => ({
    query: { ids, sort: 'playlist' as const, contentRevision: db.getMetadata().revision },
    total: ids.length,
    ranges: [[0, ids.length] as [number, number]]
  })
  const completed = async () => {
    for (let i = 0; i < 400; i++) {
      if (service.state()?.status.state === 'completed') return
      await delay(5)
    }
    throw new Error('Loudness task timed out')
  }
  return { root, db, groups, service, selection, completed }
}

test('album mode expands canonical SQL aliases across discs and keeps CUE ranges and release identity', async (t) => {
  const f = await fixture(t, (root) => [
    {
      id: 'disc2',
      filePath: join(root, 'Disc 2', 'album.wav'),
      title: 'Second',
      album: 'Album',
      artist: 'Artist',
      cover: join(root, 'cover.jpg'),
      discNumber: 2,
      trackNumber: 1,
      cueRange: { startSeconds: 20, endSeconds: 40 }
    },
    {
      id: 'disc1',
      filePath: join(root, 'Disc 1', 'album.wav'),
      title: 'First',
      album: 'Album',
      artist: 'Artist',
      cover: join(root, 'cover.jpg'),
      discNumber: 1,
      trackNumber: 1,
      cueRange: { startSeconds: 0, endSeconds: 20 }
    },
    {
      id: 'other',
      filePath: join(root, 'Other', 'album.wav'),
      title: 'Other release',
      album: 'Album',
      albumId: 'other-release',
      artist: 'Artist',
      cover: join(root, 'cover.jpg')
    }
  ])
  const plan = await f.service.prepare({ selection: f.selection(['disc2']), mode: 'album' })
  assert.equal(plan.tracks, 2)
  assert.equal(plan.groups, 1)
  await f.service.start(plan.id)
  await f.completed()
  assert.deepEqual(
    f.groups[0].tracks.map((track) => track.id),
    ['disc1', 'disc2']
  )
  assert.deepEqual(f.groups[0].tracks[1].cueRange, { startSeconds: 20, endSeconds: 40 })
  const page = f.service.page(plan.id)
  assert.doesNotMatch(JSON.stringify(page), /dir:|filePath|album\.wav/)
  assert.equal(page.items[0].index, 0)
  const result = await f.service.result(plan.id, 0)
  assert.equal(result.status, 'measured')
  assert.equal(result.tracks?.length, 2)
  assert.equal(result.measurement?.integratedLufs, -20)
  await f.service.start(plan.id)
  await f.completed()
  assert.equal(f.groups.length, 1, 'existing cache identity is reused')
  f.service.clear(plan.id)
  assert.equal((await f.service.result(plan.id, 0)).status, 'missing')
})

test('large plans stay paginated; replacement invalidates previous plan and library edits fence start', async (t) => {
  const f = await fixture(t, (root) =>
    Array.from({ length: 405 }, (_, index) => ({
      id: String(index),
      filePath: join(root, 'album.wav'),
      title: `Track ${index}`,
      cueRange: { startSeconds: index, endSeconds: index + 1 }
    }))
  )
  const plan = await f.service.prepare({
    selection: f.selection(Array.from({ length: 405 }, (_, i) => String(i))),
    mode: 'track'
  })
  assert.equal(plan.groups, 405)
  assert.equal(f.service.page(plan.id).items.length, 200)
  assert.equal(f.service.page(plan.id, 400).items.length, 5)
  assert.equal(f.service.page(plan.id, 400).items[0].index, 400)
  const replacement = await f.service.prepare({ selection: f.selection(['0']), mode: 'track' })
  assert.throws(() => f.service.page(plan.id), { code: 'STALE_REVISION' })
  const page = f.db.getTracksByIds(['0'])
  f.db.patchTracks([{ id: '0', expectedVersion: page.versions['0'], patch: { title: 'Changed' } }])
  await assert.rejects(f.service.start(replacement.id), /曲库已变化/)
  assert.equal(f.groups.length, 0)
})

test('accepted analysis survives caller detachment; maintenance cancels and joins before modifying files', async (t) => {
  const started = deferred(),
    release = deferred()
  const f = await fixture(
    t,
    (root) => [{ id: 'one', filePath: join(root, 'one.wav') }],
    async (group) => {
      started.resolve()
      await release.promise
      return measured(group)
    },
    release.resolve
  )
  const plan = await f.service.prepare({ selection: f.selection(['one']), mode: 'track' })
  await f.service.start(plan.id)
  await started.promise
  assert.equal(f.service.state()?.status.state, 'running')
  let maintained = false
  await f.service.maintain(async () => {
    assert.equal(f.service.state()?.status.state, 'cancelled')
    assert.equal((await f.service.result(plan.id, 0)).status, 'missing')
    maintained = true
  })
  assert.equal(maintained, true)
  assert.equal(f.service.page(plan.id).items[0].state, 'cancelled')
})

test('album limit counts all members rather than only the selected track', async (t) => {
  const f = await fixture(t, (root) =>
    Array.from({ length: 257 }, (_, i) => ({
      id: String(i),
      filePath: join(root, 'album.wav'),
      albumId: 'large',
      album: 'Large',
      cueRange: { startSeconds: i, endSeconds: i + 1 }
    }))
  )
  await assert.rejects(f.service.prepare({ selection: f.selection(['0']), mode: 'album' }), /256/)
  assert.equal(f.service.state(), null)
})
