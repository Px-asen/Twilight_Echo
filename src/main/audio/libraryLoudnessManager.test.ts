import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test, { type TestContext } from 'node:test'
import { LibraryLoudnessCache } from './libraryLoudnessCache.ts'
import { LibraryLoudnessManager } from './libraryLoudnessManager.ts'
import type {
  LoudnessBatchProgress,
  LoudnessGroupMeasurement,
  LoudnessInputGroup
} from '../../shared/libraryLoudness.ts'

const measured = () => ({
  source: 'analyzed' as const,
  available: true,
  algorithmVersion: 2,
  integratedLufs: -18,
  truePeakDb: -2,
  analyzedAt: '2026-09-14T00:00:00Z'
})

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'loudness-manager-'))
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  const filePath = join(directory, 'track.wav')
  await writeFile(filePath, 'audio')
  const group: LoudnessInputGroup = {
    id: 'track:one',
    title: 'One',
    mode: 'track',
    tracks: [{ id: 'one', filePath }]
  }
  const cache = new LibraryLoudnessCache(join(directory, 'results'))
  const events: LoudnessBatchProgress[] = []
  let finish = () => {}
  let calls = 0
  let cancels = 0
  const options = {
    cache,
    authorizePath: async (path: string) => path,
    analyze: async (input: LoudnessInputGroup): Promise<LoudnessGroupMeasurement> => {
      calls++
      return {
        tracks: input.tracks.map(measured),
        album: input.mode === 'album' ? measured() : null
      }
    },
    cancelWork: () => {
      cancels++
    },
    onProgress: (event: LoudnessBatchProgress) => {
      events.push(event)
      if (event.status.state === 'completed' || event.status.state === 'cancelled') finish()
    }
  }
  const manager = new LibraryLoudnessManager(options)
  return {
    manager,
    options,
    group,
    filePath,
    events,
    calls: () => calls,
    cancels: () => cancels,
    start: (groups = [group]) => {
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      manager.start(groups)
      return done
    }
  }
}

test('batch results persist across managers and source size, mtime and CUE changes invalidate them', async (t) => {
  const f = await fixture(t)
  const original = await readFile(f.filePath)
  await f.start()
  assert.equal(f.manager.snapshot().items[0].state, 'completed')
  assert.equal((await f.manager.results([f.group]))[0].status, 'measured')
  const restarted = new LibraryLoudnessManager(f.options)
  assert.equal((await restarted.results([f.group]))[0].status, 'measured')
  await f.start()
  assert.equal(f.calls(), 1)
  assert.equal(f.manager.snapshot().items[0].state, 'cached')
  assert.deepEqual(await readFile(f.filePath), original)
  await writeFile(f.filePath, 'different length')
  assert.equal((await f.manager.results([f.group]))[0].status, 'missing')
  await f.start()
  await utimes(f.filePath, new Date(), new Date(Date.now() + 60_000))
  assert.equal((await f.manager.results([f.group]))[0].status, 'missing')
  await f.start()
  const cue = {
    ...f.group,
    tracks: [
      { ...f.group.tracks[0], cueRange: { startSeconds: 2, endSeconds: 8, pregapSeconds: 0 } }
    ]
  }
  assert.equal((await f.manager.results([cue]))[0].status, 'missing')
  await f.start([cue])
  assert.equal((await f.manager.results([cue]))[0].status, 'measured')
  f.manager.clear([f.group.id])
  assert.equal((await f.manager.results([cue]))[0].status, 'missing')
})

test('complete album membership is part of the cache and every member retains its measurement', async (t) => {
  const f = await fixture(t)
  const album: LoudnessInputGroup = {
    ...f.group,
    id: 'album:one',
    mode: 'album',
    tracks: [f.group.tracks[0], { ...f.group.tracks[0], id: 'two' }]
  }
  await f.start([album])
  const result = (await f.manager.results([album]))[0]
  assert.equal(result.status, 'measured')
  assert.equal(result.tracks?.length, 2)
  assert.equal(result.measurement?.integratedLufs, -18)
  assert.equal(
    (await f.manager.results([{ ...album, tracks: album.tracks.slice(0, 1) }]))[0].status,
    'missing'
  )
  assert.equal(
    (await f.manager.results([{ ...album, tracks: [...album.tracks].reverse() }]))[0].status,
    'missing'
  )
})

test('cancelled analysis cannot commit late measurements and does not discard earlier complete groups', async (t) => {
  const f = await fixture(t)
  await f.start()
  const started = Promise.withResolvers<void>()
  const analysis = Promise.withResolvers<LoudnessGroupMeasurement>()
  f.options.analyze = async () => {
    started.resolve()
    return analysis.promise
  }
  const group = { ...f.group, id: 'track:two' }
  const done = f.start([group])
  await started.promise
  assert.throws(() => f.manager.start([group]), /已有/)
  assert.throws(() => f.manager.clear([group.id]), /请先/)
  await f.manager.cancel('previous-job')
  assert.equal(f.cancels(), 0)
  const cancel = f.manager.cancel(f.manager.snapshot().status.jobId)
  analysis.resolve({ tracks: [measured()], album: null })
  await cancel
  await done
  assert.equal(f.cancels(), 1)
  assert.equal(f.manager.snapshot().status.state, 'cancelled')
  assert.equal((await f.manager.results([group]))[0].status, 'missing')
  assert.equal((await f.manager.results([f.group]))[0].status, 'measured')
  assert.equal(
    f.events.some((event) => event.item?.id === group.id && event.item.state === 'completed'),
    false
  )
})

test('cancellation during final source validation never reaches the synchronous atomic commit', async (t) => {
  const f = await fixture(t)
  const checked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  let checks = 0
  f.options.authorizePath = async (path) => {
    if (++checks === 2) {
      checked.resolve()
      return release.promise
    }
    return path
  }
  const done = f.start()
  await checked.promise
  const cancelled = f.manager.cancel()
  release.resolve(f.filePath)
  await cancelled
  await done
  assert.equal((await f.manager.results([f.group]))[0].status, 'missing')
})

test('source mutation and partial album responses fail without publishing a complete result', async (t) => {
  const f = await fixture(t)
  f.options.analyze = async () => {
    await writeFile(f.filePath, 'changed while measuring')
    return { tracks: [measured()], album: null }
  }
  await f.start()
  assert.match(f.manager.snapshot().items[0].reason!, /源文件已变化/)
  assert.equal((await f.manager.results([f.group]))[0].status, 'missing')
  const album = { ...f.group, mode: 'album' as const, id: 'album:one' }
  f.options.analyze = async () => ({ tracks: [measured()], album: null })
  await f.start([album, f.group])
  assert.equal(f.manager.snapshot().status.failed, 1)
  assert.equal((await f.manager.results([album]))[0].status, 'missing')
  assert.equal((await f.manager.results([f.group]))[0].status, 'measured')
})

test('authorization, unsupported container tracks and persistence failures are visible and retryable', async (t) => {
  const f = await fixture(t)
  f.options.authorizePath = async () => {
    throw new Error('路径不在已授权目录内')
  }
  await f.start()
  assert.equal(f.calls(), 0)
  assert.match(f.manager.snapshot().items[0].reason!, /授权/)
  f.options.authorizePath = async (path) => path
  const subTrack = { ...f.group, tracks: [{ ...f.group.tracks[0], subTrack: 'iso:1' }] }
  await f.start([subTrack])
  assert.equal(f.calls(), 0)
  assert.match(f.manager.snapshot().items[0].reason!, /子曲目/)
  const save = f.options.cache.set.bind(f.options.cache)
  f.options.cache.set = () => {
    throw new Error('disk full')
  }
  await f.start()
  assert.match(f.manager.snapshot().items[0].reason!, /disk full/)
  f.options.cache.set = save
  await f.start()
  assert.equal(f.manager.snapshot().items[0].state, 'completed')
})
