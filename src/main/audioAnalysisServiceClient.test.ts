import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AudioAnalysisServiceClient } from './audioAnalysisServiceClient.ts'
import { AudioEngineServiceBinding } from './audioEngineServiceClient.ts'
import { createAudioServiceCapabilities } from '../shared/audioServiceContract.ts'
import { TWILIGHT_AUTOMIX_MODEL_VERSION, type AutoMixFeatures } from '../shared/twilightAutoMix.ts'
import type { AudioAnalysisWorkerRequest } from '../shared/audioAnalysisContract.ts'
import type { LoudnessInputGroup } from '../shared/libraryLoudness.ts'

class Worker extends EventEmitter {
  messages: unknown[] = []
  kills = 0
  postMessage(message: unknown): void {
    this.messages.push(message)
  }
  kill(): void {
    this.kills++
    this.emit('exit', 0)
  }
  ready(): void {
    this.emit('message', {
      kind: 'ready',
      protocolVersion: 1,
      analyses: ['bpm', 'loudness', 'loudness-batch']
    })
  }
  respond(index: number, value: unknown): void {
    const requestId = (this.messages[index] as { requestId: string }).requestId
    this.emit('message', { kind: 'response', requestId, ok: true, value: JSON.stringify(value) })
  }
}

const measurement = {
  source: 'analyzed',
  available: true,
  algorithmVersion: 2,
  integratedLufs: -18,
  truePeakDb: -1,
  analyzedAt: '2026-09-14T00:00:00Z'
}

const autoMixFeatures: AutoMixFeatures = {
  ok: true,
  algorithm: 'Twilight AutoMix',
  modelVersion: TWILIGHT_AUTOMIX_MODEL_VERSION,
  sourceIdentity: 'a'.repeat(64),
  coverage: { startSeconds: 0, endSeconds: 30, durationSeconds: 60, complete: false },
  bpm: 120,
  tempoConfidence: 0.9,
  rmsDb: -12,
  peak: 0.2,
  key: -1,
  keyConfidence: 0,
  beats: [],
  downbeats: [],
  voice: [],
  frameDb: Array(1500).fill(-12),
  framePeak: Array(1500).fill(0.2)
}

test('cancelling an album decoder waits for exit before releasing any member source', async () => {
  const worker = new Worker()
  let retire!: () => void
  const exited = new Promise<void>((resolve) => {
    retire = resolve
  })
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => Object.assign(worker, { terminate: () => exited })
  })
  try {
    let settled = false
    const work = service
      .analyzeLoudnessGroup({
        id: 'album:one',
        title: 'Album',
        mode: 'album',
        tracks: [
          { id: 'one', filePath: 'first.wav' },
          { id: 'two', filePath: 'second.wav' }
        ]
      })
      .finally(() => {
        settled = true
      })
    const rejected = assert.rejects(work, { code: 'ERR_AUDIO_ANALYSIS_CANCELLED' })
    worker.ready()
    service.cancelAll('loudness-batch')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    retire()
    await rejected
    assert.equal(worker.messages.length, 1)
  } finally {
    service.destroy()
  }
})

test('duplicate content hashing uses the cancellable low-priority analysis lane', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => worker
  })
  try {
    const abort = new AbortController()
    const work = service.hashContent('library/song.wav', abort.signal)
    worker.ready()
    const message = worker.messages[0] as AudioAnalysisWorkerRequest
    assert.equal(message.analysis, 'content-hash')
    assert.equal(message.source, 'library/song.wav')
    worker.emit('message', {
      kind: 'response',
      requestId: message.requestId,
      ok: true,
      value: 'a'.repeat(64)
    })
    assert.equal(await work, 'a'.repeat(64))
    const cancelled = service.hashContent('library/other.wav', abort.signal)
    const rejected = assert.rejects(cancelled, { code: 'ERR_AUDIO_ANALYSIS_CANCELLED' })
    abort.abort()
    await rejected
    assert.equal(worker.kills, 1)
  } finally {
    service.destroy()
  }
})

test('library tag work and targeted decoder release wait for actual exit, without replay', async () => {
  const worker = new Worker()
  let retire!: () => void
  const exited = new Promise<void>((resolve) => {
    retire = resolve
  })
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => Object.assign(worker, { terminate: () => exited })
  })
  try {
    let settled = false
    const work = service
      .libraryTags('tag-backups', {
        kind: 'write',
        items: [{ filePath: 'song.wav', title: 'Title' }]
      })
      .finally(() => {
        settled = true
      })
    const rejection = assert.rejects(
      work,
      (error: any) => error.code === 'ERR_AUDIO_ANALYSIS_CANCELLED'
    )
    worker.ready()
    let released = false
    const releasing = service.releaseSources(['tag-backups']).then(() => {
      released = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(released, false)
    retire()
    await Promise.all([rejection, releasing])
    assert.equal(worker.messages.length, 1)
    assert.equal((worker.messages[0] as AudioAnalysisWorkerRequest).analysis, 'library-tags')
  } finally {
    service.destroy()
  }
})

test('download tag writers cancel only after their actual worker has exited, never by replaying the write', async () => {
  const worker = new Worker()
  let retire!: () => void
  const terminated = new Promise<void>((resolve) => {
    retire = resolve
  })
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => Object.assign(worker, { terminate: () => terminated })
  })
  const controller = new AbortController()
  let settled = false
  const task = service
    .prepareDownloadMetadata(
      'song.part',
      {
        targetPath: 'song.wav',
        track: { id: 'song', title: 'Song', artist: 'Artist' },
        preferences: { naming: 'provider', embedMetadata: true, saveLyrics: true },
        lyrics: { lyrics: 'large lyrics' },
        lyricFailure: false,
        cover: null,
        coverFailure: false
      },
      controller.signal
    )
    .finally(() => {
      settled = true
    })
  const rejected = assert.rejects(task, /cancel/i)
  worker.ready()
  assert.equal((worker.messages[0] as AudioAnalysisWorkerRequest).analysis, 'download-metadata')
  controller.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  retire()
  await rejected
  assert.equal(worker.messages.length, 1)
  service.destroy()
})

test('a download metadata worker exit is already joined and cannot wait for a second exit event', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => worker
  })
  const task = service.prepareDownloadMetadata(
    'song.part',
    {
      targetPath: 'song.wav',
      track: { id: 'song', title: 'Song', artist: 'Artist' },
      preferences: { naming: 'provider', embedMetadata: false, saveLyrics: false },
      lyrics: {},
      lyricFailure: false,
      cover: null,
      coverFailure: false
    },
    new AbortController().signal
  )
  const rejected = assert.rejects(task, /exited/)
  worker.ready()
  worker.emit('exit', 1)
  await rejected
  assert.equal(worker.kills, 0)
  service.destroy()
})

test('JS-only metadata workers keep downloads available without claiming native analyses', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => worker
  })
  const task = service.prepareDownloadMetadata(
    'song.part',
    {
      targetPath: 'song.wav',
      track: { id: 'song', title: 'Song', artist: 'Artist' },
      preferences: { naming: 'provider', embedMetadata: false, saveLyrics: true },
      lyrics: {},
      lyricFailure: false,
      cover: null,
      coverFailure: false
    },
    new AbortController().signal
  )
  worker.emit('message', { kind: 'ready', protocolVersion: 1, analyses: ['download-metadata'] })
  const value = {
    actualQuality: 'lossless',
    warning: null,
    lyrics: [{ suffix: '.lrc', text: 'a'.repeat(600_000) }]
  }
  worker.emit('message', {
    kind: 'response',
    requestId: (worker.messages[0] as AudioAnalysisWorkerRequest).requestId,
    ok: true,
    value
  })
  assert.deepEqual(await task, value)
  service.destroy()
})

test('native container metadata uses a cancellable analysis lease and retains complete ISO identities', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => worker
  })
  try {
    const metadata = service.getMetadata('disc.iso')
    worker.ready()
    assert.equal((worker.messages[0] as AudioAnalysisWorkerRequest).analysis, 'metadata')
    const value = {
      source: 'disc.iso',
      error: '',
      coverDataBase64: 'a'.repeat(600_000),
      isoTracks: [
        { source: 'sacd:disc.iso#track=1', title: 'First' },
        { source: 'sacd:disc.iso#track=2', title: 'Second' }
      ]
    }
    worker.respond(0, value)
    assert.deepEqual(await metadata, value)
    const controller = new AbortController()
    const pending = service.getMetadata('slow.iso', { signal: controller.signal })
    const cancelled = assert.rejects(pending, /cancel/i)
    controller.abort()
    await cancelled
    assert.equal(worker.kills, 1)
  } finally {
    service.destroy()
  }
})

for (const priority of [90, -20]) {
  test(`AutoMix accepts 48-second native analysis at priority ${priority}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const worker = new Worker()
    const service = new AudioAnalysisServiceClient({
      serviceEntry: 'analysis.js',
      taskTimeoutMs: 1000,
      launch: () => worker
    })
    try {
      const pending = service.analyzeAutoMix('slow.flac', '{}', { priority })
      worker.ready()
      t.mock.timers.tick(48_000)
      worker.respond(0, autoMixFeatures)
      assert.deepEqual(await pending, autoMixFeatures)
      assert.equal(worker.kills, 0)
      assert.equal(service.getStatus().active, 0)
    } finally {
      service.destroy()
    }
  })
}

for (const timeoutMs of [undefined, 15_000]) {
  const deadline = timeoutMs ?? 120_000
  test(`AutoMix enforces its ${deadline} ms deadline and recovers its worker`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const workers: Worker[] = []
    const service = new AudioAnalysisServiceClient({
      serviceEntry: 'analysis.js',
      restartDelayMs: 250,
      launch: () => {
        const worker = new Worker()
        workers.push(worker)
        return worker
      }
    })
    try {
      const pending = service.analyzeAutoMix(
        'hung.flac',
        '{}',
        timeoutMs === undefined ? {} : { timeoutMs }
      )
      const rejected = assert.rejects(pending, {
        code: 'ERR_AUDIO_ANALYSIS_TIMEOUT',
        message: `automix analysis timed out after ${deadline} ms: hung.flac`
      })
      workers[0].ready()
      t.mock.timers.tick(deadline - 1)
      assert.equal(workers[0].kills, 0)
      t.mock.timers.tick(1)
      await rejected
      assert.equal(workers[0].kills, 1)
      assert.equal(service.getStatus().active, 0)

      t.mock.timers.tick(250)
      assert.equal(workers.length, 2)
      const recovered = service.analyzeAutoMix('recovered.flac')
      workers[1].ready()
      workers[1].respond(0, autoMixFeatures)
      assert.deepEqual(await recovered, autoMixFeatures)
      assert.equal(workers[1].kills, 0)
    } finally {
      service.destroy()
    }
  })
}

test('slow AutoMix analysis remains immediately cancellable after the old 30-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    launch: () => worker
  })
  try {
    const abort = new AbortController()
    const pending = service.analyzeAutoMix('slow.flac', '{}', { signal: abort.signal })
    const rejected = assert.rejects(pending, { code: 'ERR_AUDIO_ANALYSIS_CANCELLED' })
    worker.ready()
    t.mock.timers.tick(48_000)
    assert.equal(worker.kills, 0)
    abort.abort()
    await rejected
    assert.equal(worker.kills, 1)
    assert.equal(service.getStatus().active, 0)
  } finally {
    service.destroy()
  }
})

test('AutoMix stays single concurrency in a four-worker pool while other analysis can proceed', async () => {
  const children: Worker[] = []
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    maxConcurrency: 4,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new Worker()
          children.push(child)
          return child
        }
      }
    }
  })
  const unavailable = {
    ok: false,
    algorithm: 'Twilight AutoMix',
    reason: 'public_assets_unavailable'
  }
  try {
    const first = service.analyzeAutoMix('first.flac', '{}')
    const second = service.analyzeAutoMix('second.flac', '{}')
    const third = service.analyzeAutoMix('third.flac', '{}')
    assert.equal(children.length, 1)
    children[0].ready()
    const loudness = service.analyzeLoudness('other.flac', '{}')
    assert.equal(children.length, 2)
    children[1].ready()
    assert.equal(service.getStatus().active, 2)
    assert.equal(service.getStatus().queued, 2)
    assert.equal((children[1].messages[0] as AudioAnalysisWorkerRequest).analysis, 'loudness')
    children[1].respond(0, measurement)
    await loudness
    assert.equal(children[1].messages.length, 1)
    children[0].respond(0, unavailable)
    await first
    assert.equal((children[0].messages[1] as AudioAnalysisWorkerRequest).source, 'second.flac')
    assert.equal(children[1].messages.length, 1)
    children[0].respond(1, unavailable)
    await second
    children[0].respond(2, unavailable)
    await third
    assert.equal(service.getStatus().active, 0)
  } finally {
    service.destroy()
  }
})

test('DSP audition rejects unprocessed native results and cancellation is isolated from loudnorm', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    electron: { utilityProcess: { fork: () => worker } }
  })
  try {
    const old = service.analyzeDspAudition('song.wav', '{"processedGraph":{}}')
    worker.ready()
    assert.equal((worker.messages[0] as AudioAnalysisWorkerRequest).analysis, 'dsp-audition')
    worker.respond(0, measurement)
    await assert.rejects(old, /处理后/)
    const processed = service.analyzeDspAudition('song.wav', '{"processedGraph":{}}')
    worker.respond(1, { ...measurement, processingVersion: 1 })
    assert.equal((await processed).integratedLufs, -18)
    const loudnorm = service.analyzeLoudness('song.wav', '{}')
    assert.equal(service.cancelBySource('song.wav', 'dsp-audition'), 0)
    worker.respond(2, measurement)
    assert.equal((await loudnorm).integratedLufs, -18)
  } finally {
    service.destroy()
  }
})
const group: LoudnessInputGroup = {
  id: 'album:one',
  title: 'One',
  mode: 'album',
  tracks: [
    {
      id: 'cue:1',
      filePath: 'album.flac',
      cueRange: { startSeconds: 10, endSeconds: 20, pregapSeconds: 2 }
    }
  ]
}

test('batch analysis forwards bounded source segments and rejects old or partial native output', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    electron: { utilityProcess: { fork: () => worker } }
  })
  try {
    const pending = service.analyzeLoudnessGroup(group)
    worker.ready()
    const request = worker.messages[0] as AudioAnalysisWorkerRequest
    assert.equal(request.analysis, 'loudness-batch')
    assert.deepEqual(JSON.parse(request.optionsJson), {
      segments: [{ source: 'album.flac', startSeconds: 10, endSeconds: 20 }],
      album: true
    })
    worker.respond(0, { tracks: [measurement], album: measurement })
    assert.equal((await pending).album?.integratedLufs, -18)
    const old = service.analyzeLoudnessGroup(group)
    worker.respond(1, measurement)
    await assert.rejects(old, /更新引擎/)
    const partial = service.analyzeLoudnessGroup(group)
    worker.respond(2, { tracks: [measurement], album: null })
    await assert.rejects(partial, /不完整/)
  } finally {
    service.destroy()
  }
})

test('batch cancellation leaves concurrent loudnorm and playback controls responsive even for the same source', async () => {
  const children: Worker[] = []
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    maxConcurrency: 2,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new Worker()
          children.push(child)
          return child
        }
      }
    }
  })
  const playbackChild = new Worker()
  const playback = new AudioEngineServiceBinding({
    serviceEntry: 'playback.js',
    electron: { utilityProcess: { fork: () => playbackChild } }
  })
  try {
    const batch = service.analyzeLoudnessGroup(group)
    // Workers fork on demand: the batch forks the first, the loudnorm the second.
    assert.equal(children.length, 1)
    children[0].ready()
    const loudnorm = service.analyzeLoudness('album.flac', '{}', { priority: 100 })
    assert.equal(children.length, 2)
    children[1].ready()
    const pause = playback.callAsync('Pause', [])
    playbackChild.emit('message', {
      kind: 'ready',
      capabilities: createAudioServiceCapabilities(['ApplyDspState', 'GetDspGraphStatus'])
    })
    playbackChild.respond(0, null)
    await pause
    assert.equal(service.getStatus().active, 2)
    const cancelled = assert.rejects(batch, /cancelled/)
    assert.equal(service.cancelAll('loudness-batch'), 1)
    await cancelled
    assert.equal(children[0].kills, 1)
    assert.equal(children[1].kills, 0)
    assert.equal(playbackChild.kills, 0)
    children[1].respond(0, measurement)
    assert.equal((await loudnorm).integratedLufs, -18)
  } finally {
    service.destroy()
    playback.destroy()
  }
})

test('queued batch work yields to urgent loudnorm in the shared bounded analysis pool', async () => {
  const worker = new Worker()
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    maxConcurrency: 1,
    electron: { utilityProcess: { fork: () => worker } }
  })
  try {
    const active = service.analyzeLoudness('first.flac', '{}')
    worker.ready()
    const batch = service.analyzeLoudnessGroup(group)
    const urgent = service.analyzeLoudness('urgent.flac', '{}', { priority: 100 })
    worker.respond(0, measurement)
    assert.equal((worker.messages[1] as AudioAnalysisWorkerRequest).source, 'urgent.flac')
    worker.respond(1, measurement)
    assert.equal((worker.messages[2] as AudioAnalysisWorkerRequest).analysis, 'loudness-batch')
    worker.respond(2, { tracks: [measurement], album: measurement })
    await Promise.all([active, batch, urgent])
  } finally {
    service.destroy()
  }
})

test('analysis workers fork only for waiting demand and are reclaimed after idling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children: Worker[] = []
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    maxConcurrency: 4,
    idleTimeoutMs: 1000,
    electron: {
      utilityProcess: {
        fork: () => {
          const child = new Worker()
          children.push(child)
          return child
        }
      }
    }
  })
  try {
    const first = service.analyzeLoudness('first.flac', '{}')
    assert.equal(children.length, 1, 'a single request forks a single worker')
    children[0].ready()
    assert.equal(service.getStatus().liveWorkers, 1)

    worker0Respond(children[0], 0)
    await first
    assert.equal(children[0].kills, 0, 'a finished worker stays warm before the idle timeout')

    t.mock.timers.tick(999)
    assert.equal(children[0].kills, 0)
    t.mock.timers.tick(1)
    assert.equal(children[0].kills, 1, 'the idle worker is killed after the timeout')
    assert.equal(service.getStatus().liveWorkers, 0)
    assert.equal(service.getStatus().lastError, '', 'idle reclaim is not an error')

    const second = service.analyzeLoudness('second.flac', '{}')
    const third = service.analyzeLoudness('third.flac', '{}')
    assert.equal(children.length, 3, 'the next burst forks exactly as many workers as it needs')
    children[1].ready()
    children[2].ready()
    worker0Respond(children[1], 0)
    worker0Respond(children[2], 0)
    await Promise.all([second, third])
    t.mock.timers.tick(1000)
    assert.equal(service.getStatus().liveWorkers, 0)
  } finally {
    service.destroy()
  }
})

function worker0Respond(worker: Worker, index: number): void {
  worker.respond(index, measurement)
}

test('request cancellation retires only its ID even when a new task uses the same source', async () => {
  const workers: Worker[] = []
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    maxConcurrency: 1,
    restartDelayMs: 1,
    electron: {
      utilityProcess: {
        fork: () => {
          const w = new Worker()
          workers.push(w)
          return w
        }
      }
    }
  })
  try {
    const abort = new AbortController()
    const first = service.analyzeAutoMix('same.flac', '{}', { signal: abort.signal })
    const rejected = assert.rejects(first, (e: any) => e.code === 'ERR_AUDIO_ANALYSIS_CANCELLED')
    workers[0].ready()
    const second = service.analyzeAutoMix('same.flac', '{}', { priority: 90 })
    abort.abort()
    await rejected
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(workers.length, 2)
    workers[1].ready()
    const fallback = { ok: false, algorithm: 'Twilight AutoMix', reason: 'missing_boundary_beats' }
    workers[1].respond(0, fallback)
    assert.deepEqual(await second, fallback)
  } finally {
    service.destroy()
  }
})

test('new boundary preempts background AutoMix and survives late worker responses', async () => {
  const workers: Worker[] = []
  const service = new AudioAnalysisServiceClient({
    serviceEntry: 'analysis.js',
    maxConcurrency: 1,
    restartDelayMs: 1,
    electron: {
      utilityProcess: {
        fork: () => {
          const w = new Worker()
          workers.push(w)
          return w
        }
      }
    }
  })
  try {
    const old = service.analyzeAutoMix('old.flac', '{}', { priority: -20 })
    const rejected = assert.rejects(old, (e: any) => e.code === 'ERR_AUDIO_ANALYSIS_PREEMPTED')
    workers[0].ready()
    const boundary = service.analyzeAutoMix('new.flac', '{}', { priority: 90 })
    await rejected
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(workers[0].kills, 1)
    workers[1].ready()
    const fallback = { ok: false, algorithm: 'Twilight AutoMix', reason: 'low_beat_confidence' }
    workers[0].respond(0, { ok: false, algorithm: 'Twilight AutoMix', reason: 'stale' })
    workers[1].respond(0, fallback)
    assert.deepEqual(await boundary, fallback)
  } finally {
    service.destroy()
  }
})
