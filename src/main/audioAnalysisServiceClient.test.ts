import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AudioAnalysisServiceClient } from './audioAnalysisServiceClient.ts'
import { AudioEngineServiceBinding } from './audioEngineServiceClient.ts'
import { createAudioServiceCapabilities } from '../shared/audioServiceContract.ts'
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
