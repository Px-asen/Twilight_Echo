import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CoreAnalysisService } from './analysisService.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import type { LoudnessAnalysisManager } from './loudnessAnalysisManager.ts'
import type { BpmAnalysisResult } from '../../shared/audioEngineTypes.ts'
import { LIBRARY_LOUDNESS_ALGORITHM_VERSION } from '../../shared/libraryLoudness.ts'

const result: BpmAnalysisResult = {
  bpm: 123,
  confidence: 0.9,
  source: 'analyzed',
  analyzedAt: '2026-10-22T12:00:00Z',
  algorithmVersion: 1
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await delay(5)
  }
  throw new Error('Analysis fixture timed out')
}
async function fixture(
  t: test.TestContext,
  overrides: Partial<ConstructorParameters<typeof CoreAnalysisService>[0]> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'core-analysis-'))
  const filePath = join(root, 'one.wav')
  await writeFile(filePath, 'source')
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 1,
    tracks: [{ id: 'one', filePath, title: 'One', bpm: 120 }],
    folders: [],
    exclusions: []
  })
  let manager: LoudnessAnalysisManager | null = null,
    analyses = 0,
    patches = 0,
    applied = 0,
    cleared = 0
  const errors: unknown[] = []
  const database = {
    getTracksByIds: async (...args: Parameters<LibraryDatabase['getTracksByIds']>) =>
      db.getTracksByIds(...args),
    lookupTracksByPaths: async (...args: Parameters<LibraryDatabase['lookupTracksByPaths']>) =>
      db.lookupTracksByPaths(...args),
    queryTracks: async (...args: Parameters<LibraryDatabase['queryTracks']>) =>
      db.queryTracks(...args),
    patchTracks: async (...args: Parameters<LibraryDatabase['patchTracks']>) => {
      patches++
      return db.patchTracks(...args)
    }
  }
  const service = new CoreAnalysisService({
    root,
    database,
    enabled: () => true,
    authorize: async (path) => path,
    bpm: {
      analyzeFile: async () => {
        analyses++
        return result
      }
    },
    loudness: {
      analyzeFile: async () => ({
        integratedLufs: -20,
        truePeakDb: -1,
        available: true,
        source: 'analyzed',
        analyzedAt: result.analyzedAt,
        algorithmVersion: LIBRARY_LOUDNESS_ALGORITHM_VERSION
      })
    },
    engine: {
      setLoudnessAnalysisManager: (next) => {
        manager = next
      },
      notifyLoudnessCacheCleared: async () => {
        assert.ok(manager, 'native remeasurement needs the reattached manager')
      },
      getLoudnormStatus: () => ({ status: 'idle', source: filePath })
    },
    applyBpm: () => {
      applied++
    },
    clearBpm: () => {
      cleared++
    },
    changed: () => {},
    failed: (error) => errors.push(error),
    ...overrides
  })
  t.after(async () => {
    await service.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    db,
    filePath,
    service,
    database,
    errors,
    track: () => libraryTrack(db.getTracksByIds(['one']).tracks[0]),
    manager: () => manager,
    counts: () => ({ analyses, patches, applied, cleared })
  }
}

test('automatic BPM and a simultaneous manual request share one SQL commit, without a renderer owner', async (t) => {
  const gate = deferred(),
    started = deferred()
  let calls = 0
  const f = await fixture(t, {
    bpm: {
      analyzeFile: async (request) => {
        calls++
        assert.equal(request.referenceBpm, 120)
        started.resolve()
        await gate.promise
        return result
      }
    }
  })
  f.service.observe(f.track(), { state: 'playing' })
  assert.equal(calls, 0)
  f.service.activate()
  assert.ok(f.manager())
  f.service.observe(f.track(), { state: 'paused' })
  assert.equal(calls, 0)
  f.service.observe(f.track(), { state: 'playing' })
  await started.promise
  for (let i = 0; i < 30; i++) f.service.observe(f.track(), { state: 'playing' })
  const manual = f.service.request({
    kind: 'bpm',
    id: 'one',
    version: f.db.getTracksByIds(['one']).versions.one
  })
  gate.resolve()
  assert.equal((await manual).status, 'completed')
  assert.equal(calls, 1)
  assert.deepEqual(f.counts(), { analyses: 0, patches: 1, applied: 1, cleared: 0 })
  assert.deepEqual(f.track().bpmAnalysis, result)
  assert.ok((await f.service.cacheSize('bpm')) > 0)
  f.service.observe(f.track(), { state: 'paused' })
  f.service.observe(f.track(), { state: 'playing' })
  assert.equal(calls, 1)
  assert.deepEqual(f.errors, [])
})

test('source maintenance waits for authorization and prevents both late BPM writes and native loudness starts', async (t) => {
  const authorization = deferred(),
    entered = deferred(),
    maintained = deferred()
  const f = await fixture(t, {
    authorize: async (path) => {
      entered.resolve()
      await authorization.promise
      return path
    }
  })
  f.service.activate()
  const nativeManager = f.manager()!
  f.service.observe(f.track(), { state: 'playing' })
  await entered.promise
  let changing = false
  const maintenance = f.service.maintain(async () => {
    changing = true
    await maintained.promise
  })
  assert.equal(f.manager(), null)
  assert.equal(changing, false)
  authorization.resolve()
  await waitFor(() => changing)
  assert.deepEqual(await nativeManager.requestAnalysis({ trackId: 'one', filePath: f.filePath }), {
    status: 'skipped',
    reason: 'cancelled'
  })
  assert.equal(f.counts().patches, 0)
  maintained.resolve()
  await maintenance
  assert.equal(f.manager(), nativeManager)
  assert.equal(
    (await nativeManager.requestAnalysis({ trackId: 'one', filePath: f.filePath })).status,
    'completed'
  )
  assert.deepEqual(f.service.status(), { status: 'idle' })
  await f.service.clearCache('loudness')
  assert.equal(await f.service.cacheSize('loudness'), 0)
})

test('clear joins in-flight worker results before removing caches and paged SQLite BPM data', async (t) => {
  const started = deferred(),
    finish = deferred()
  const f = await fixture(t, {
    bpm: {
      analyzeFile: async () => {
        started.resolve()
        await finish.promise
        return result
      },
      cancelFile: finish.resolve
    }
  })
  const seed = Array.from({ length: 401 }, (_, i) => ({
    id: String(i),
    filePath: join(f.root, `${i}.wav`),
    bpmAnalysis: result
  }))
  f.db.replaceDocument({
    version: 2,
    revision: 2,
    folders: [],
    exclusions: [],
    tracks: [...seed, { id: 'one', filePath: f.filePath }]
  })
  f.service.activate()
  f.service.observe(f.track(), { state: 'playing' })
  await started.promise
  await f.service.clearCache('bpm')
  assert.equal(await f.service.cacheSize('bpm'), 0)
  assert.ok(f.db.queryTracks({ limit: 1000 }).tracks.every((track) => track.bpmAnalysis == null))
  assert.equal(f.counts().applied, 0)
  assert.equal(f.counts().cleared, 1)
  assert.equal(f.counts().patches, 3)
})

test('stale manual track versions are rejected and shutdown joins an already dispatched SQL write without replay', async (t) => {
  const f = await fixture(t)
  f.service.activate()
  await assert.rejects(f.service.request({ kind: 'bpm', id: 'one', version: 999 }), /曲目已变化/)
  assert.equal(f.counts().analyses, 0)
  const committed = deferred(),
    lostReply = deferred()
  const patch = f.database.patchTracks
  f.database.patchTracks = async (...args) => {
    await patch(...args)
    committed.resolve()
    await lostReply.promise
    throw Object.assign(new Error('reply lost'), { code: 'OUTCOME_UNKNOWN' })
  }
  const request = f.service.request({
    kind: 'bpm',
    id: 'one',
    version: f.db.getTracksByIds(['one']).versions.one
  })
  const rejected = assert.rejects(request, { code: 'OUTCOME_UNKNOWN' })
  await committed.promise
  let stopped = false
  const shutdown = f.service.shutdown().then(() => {
    stopped = true
  })
  await delay(0)
  assert.equal(stopped, false)
  lostReply.resolve()
  await Promise.all([rejected, shutdown])
  assert.equal(f.manager(), null)
  assert.equal(f.counts().patches, 1)
  assert.deepEqual(f.track().bpmAnalysis, result)
  assert.equal(f.counts().applied, 0)
  await assert.rejects(f.service.request({ kind: 'bpm', id: 'one', version: 1 }), /维护/)
})
