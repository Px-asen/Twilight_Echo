import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  autoMixBoundaryStarts,
  TwilightAutoMixCoordinator,
  type TwilightAutoMixContext
} from './twilightAutoMixCoordinator.ts'
import { TwilightAutoMixWindowCache } from './twilightAutoMixCache.ts'
import { TWILIGHT_AUTOMIX_MODEL_VERSION } from '../../shared/twilightAutoMix.ts'
import type { AutoMixFeatures } from '../../shared/twilightAutoMix.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import { ProviderPlaybackIdentityRegistry } from './providerPlaybackIdentity.ts'
import { AudioAnalysisServiceClient } from '../audioAnalysisServiceClient.ts'
import type { AudioAnalysisWorkerRequest } from '../../shared/audioAnalysisContract.ts'

function result(options: string): AutoMixFeatures {
  const o = JSON.parse(options)
  const duration = o.sourceEndSeconds - o.sourceStartSeconds
  const start = o.rangeStartSeconds,
    end = Math.min(start + 30, duration)
  return {
    ok: true,
    algorithm: 'Twilight AutoMix',
    modelVersion: TWILIGHT_AUTOMIX_MODEL_VERSION,
    sourceIdentity: o.sourceIdentity,
    coverage: {
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
      complete: start === 0 && end === duration
    },
    bpm: 120,
    tempoConfidence: 0.9,
    rmsDb: -12,
    peak: 0.2,
    key: -1,
    keyConfidence: 0,
    beats: [],
    downbeats: [],
    voice: [],
    frameDb: Array(Math.ceil((end - start) * 50)).fill(-12),
    framePeak: Array(Math.ceil((end - start) * 50)).fill(0.2)
  }
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'twilight-automix-coordinator-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function context(): TwilightAutoMixContext {
  return {
    queueToken: 'queue-1',
    current: {
      id: 'a',
      source: 'C:/中文/a.flac',
      duration: 60,
      cueRange: { startSeconds: 5, endSeconds: 65, pregapSeconds: 0 }
    },
    next: { id: 'b', source: 'C:/中文/b.flac', duration: 60 },
    info: {
      state: 'playing',
      duration: 60,
      position: 1,
      source: 'C:/中文/a.flac',
      actualSampleRate: 48000,
      actualChannels: 2,
      playbackRate: 1,
      autoMixState: 'ready',
      autoMixPlanId: 19
    } as PlaybackInfo
  }
}
test('model cache identity matches the locked public graph digests', async () => {
  const lock = JSON.parse(
    await readFile(
      new URL('../../../audio-engine/automix-native/dependencies.lock.json', import.meta.url),
      'utf8'
    )
  )
  assert.equal(
    TWILIGHT_AUTOMIX_MODEL_VERSION,
    `twilight-automix-native-1:${lock.models['beat-this-small0'].graphSha256}:${lock.models.yamnet.graphSha256}`
  )
})
test('boundaries prepare before middle windows; native owns the submitted plan and cache reuse', async () =>
  fixture(async (root) => {
    const c = context(),
      order: string[] = [],
      prepared: Record<string, unknown>[] = [],
      submits: number[] = []
    const cache = new TwilightAutoMixWindowCache(join(root, 'cache.json'))
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache,
      analyze: async (source, options, priority) => {
        const o = JSON.parse(options)
        order.push(`${source}:${o.rangeStartSeconds}:${priority}`)
        return result(options)
      },
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async (request) => {
        order.push('prepare')
        prepared.push(JSON.parse(request))
        return true
      },
      status: async () => c.info,
      submit: async (id) => {
        submits.push(id)
        order.push('submit')
        return true
      }
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.deepEqual(submits, [19])
    assert.equal(order[0], 'C:/中文/a.flac:30:boundary')
    assert.equal(order[1], 'C:/中文/b.flac:0:boundary')
    assert.deepEqual(order.slice(2, 4), ['prepare', 'submit'])
    assert.equal(prepared[0].currentSourceStartSeconds, 5)
    assert.equal(prepared[0].currentSourceEndSeconds, 65)
    assert.equal((prepared[0].currentFeatures as AutoMixFeatures).coverage.complete, false)
    const analyses = order.filter((entry) => entry.includes('.flac:')).length
    coordinator.invalidate('seek')
    coordinator.observe()
    await coordinator.idle()
    assert.equal(order.filter((entry) => entry.includes('.flac:')).length, analyses)
    assert.deepEqual(submits, [19, 19])
    coordinator.destroy()
  }))
test('two slow native windows reach preparation and submit within the live playback deadline', async (t) =>
  fixture(async (root) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const c = context()
    c.current = { ...c.current, duration: 256.5, cueRange: undefined }
    c.info.duration = 256.5
    let elapsedMs = 0,
      kills = 0
    let receive!: (request: AudioAnalysisWorkerRequest) => void
    const nextRequest = () =>
      new Promise<AudioAnalysisWorkerRequest>((resolve) => {
        receive = resolve
      })
    const worker = Object.assign(new EventEmitter(), {
      postMessage(request: AudioAnalysisWorkerRequest): void {
        receive(request)
      },
      kill(): void {
        kills++
        worker.emit('exit', 0)
      }
    })
    const analysis = new AudioAnalysisServiceClient({
      serviceEntry: 'analysis.js',
      launch: () => {
        queueMicrotask(() =>
          worker.emit('message', {
            kind: 'ready',
            protocolVersion: 1,
            analyses: ['bpm', 'loudness', 'automix']
          })
        )
        return worker
      }
    })
    const respond = (request: AudioAnalysisWorkerRequest) =>
      worker.emit('message', {
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        value: result(request.optionsJson)
      })
    const prepared: Record<string, unknown>[] = [],
      submits: number[] = []
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (source) => source,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      scopedCancellation: true,
      analyze: (source, options, priority, signal) =>
        analysis.analyzeAutoMix(source, options, {
          priority: priority === 'boundary' ? 90 : -20,
          signal
        }),
      cancelAnalysis: (source) => {
        analysis.cancelBySource(source, 'automix')
      },
      cancel: async () => true,
      prepare: async (request) => {
        prepared.push(JSON.parse(request))
        return true
      },
      status: async () => c.info,
      submit: async (id) => {
        submits.push(id)
        return true
      },
      onState: (state) => {
        if (state === 'ready') resolveReady()
      },
      now: () => elapsedMs
    })
    try {
      const tailStarted = nextRequest()
      coordinator.setMode('natural')
      const tail = await tailStarted
      elapsedMs += 48_000
      c.info.position = 49
      t.mock.timers.tick(48_000)
      assert.equal(kills, 0)
      const headStarted = nextRequest()
      respond(tail)
      const head = await headStarted
      elapsedMs += 48_000
      c.info.position = 97
      t.mock.timers.tick(48_000)
      assert.equal(kills, 0)
      respond(head)
      await ready
      assert.equal(prepared.length, 1)
      assert.deepEqual(submits, [19])
      assert.equal(coordinator.reason, '')
      assert.equal((prepared[0].currentFeatures as AutoMixFeatures).coverage.startSeconds, 226.5)
      assert.equal((prepared[0].nextFeatures as AutoMixFeatures).coverage.startSeconds, 0)
      assert.equal(
        coordinator.diagnostics.find((entry) => entry.stage === 'analysis')?.elapsedMs,
        96_000
      )
    } finally {
      await coordinator.shutdown()
      analysis.destroy()
    }
  }))

test('seek during inference cancels and never prepares or submits stale features', async () =>
  fixture(async (root) => {
    let resolve: ((r: AutoMixFeatures) => void) | undefined,
      observedOptions = '',
      prepares = 0,
      submits = 0
    const cancelled: string[] = [],
      c = context()
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: (_, options) => {
        observedOptions = options
        return new Promise((done) => {
          resolve = done
        })
      },
      cancelAnalysis: (source) => {
        cancelled.push(source)
      },
      cancel: async () => true,
      prepare: async () => {
        prepares++
        return true
      },
      submit: async () => {
        submits++
        return true
      },
      status: async () => c.info
    })
    coordinator.setMode('dj')
    for (let i = 0; i < 50 && !resolve; i++) await new Promise((done) => setTimeout(done, 2))
    assert.ok(resolve)
    coordinator.invalidate('seek')
    resolve(result(observedOptions))
    await coordinator.idle()
    assert.equal(prepares, 0)
    assert.equal(submits, 0)
    assert.ok(cancelled.includes(c.current.source))
    coordinator.destroy()
  }))
test('native DSP invalidation prepares a fresh plan once without rerunning cached models', async () =>
  fixture(async (root) => {
    const c = context()
    let prepares = 0,
      analyses = 0,
      submits = 0,
      nativePreparations = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_, options) => {
        analyses++
        return result(options)
      },
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async () => {
        prepares++
        c.info.autoMixState = 'ready'
        c.info.autoMixPlanId = prepares
        return true
      },
      onNativePreparation: () => {
        nativePreparations++
      },
      submit: async () => {
        submits++
        return true
      },
      status: async () => c.info
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    const initialAnalyses = analyses
    c.info.autoMixState = 'degraded'
    c.info.autoMixReason = 'dsp_changed'
    coordinator.observe()
    await coordinator.idle()
    assert.equal(prepares, 2)
    assert.equal(submits, 2)
    assert.equal(nativePreparations, 2)
    assert.equal(analyses, initialAnalyses)
    coordinator.observe()
    await coordinator.idle()
    assert.equal(prepares, 2)
    coordinator.destroy()
  }))

test('a failed middle window keeps the submitted boundary plan and reports ready', async () =>
  fixture(async (root) => {
    const c = context(),
      states: string[] = []
    let cancelled = 0,
      submitted = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_, options, priority) => {
        if (priority === 'background') throw new Error('analysis_timeout')
        return result(options)
      },
      cancelAnalysis: () => {},
      cancel: async () => {
        cancelled++
        return true
      },
      prepare: async () => true,
      submit: async () => {
        submitted++
        return true
      },
      status: async () => c.info,
      onState: (state) => {
        states.push(state)
      }
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.equal(submitted, 1)
    assert.equal(
      cancelled,
      1,
      'only initial mode invalidation cancels; middle cache failure retains plan'
    )
    assert.equal(states.at(-1), 'ready')
    assert.equal(coordinator.reason, '')
    coordinator.destroy()
  }))

test('unverified online URL degrades without analysis, network identity guesses or native plans', async () =>
  fixture(async (root) => {
    const c = context()
    c.current.source = 'https://cdn.example/music?token=secret'
    let analyzed = 0,
      prepared = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_, options) => {
        analyzed++
        return result(options)
      },
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async () => {
        prepared++
        return true
      },
      submit: async () => true,
      status: async () => c.info
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.equal(coordinator.reason, 'actual_online_source_identity_unavailable')
    assert.equal(analyzed, 0)
    assert.equal(prepared, 0)
    coordinator.destroy()
  }))

test('decoded fractional ranges survive analysis, cache identity and preparation unchanged', async () =>
  fixture(async (root) => {
    const c = context()
    delete c.current.cueRange
    c.current.duration = 338
    c.info.duration = 338.040123456789
    c.next.duration = 298.701234567891
    const ranges: number[] = []
    let prepared: Record<string, number> | undefined
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_, options) => {
        ranges.push(JSON.parse(options).sourceEndSeconds)
        return result(options)
      },
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async (request) => {
        prepared = JSON.parse(request)
        return true
      },
      submit: async () => true,
      status: async () => c.info
    })
    coordinator.setMode('dj')
    await coordinator.idle()
    assert.deepEqual(ranges.slice(0, 2), [c.info.duration, c.next.duration])
    assert.equal(prepared?.currentSourceEndSeconds, c.info.duration)
    assert.equal(prepared?.nextSourceEndSeconds, c.next.duration)
    assert.equal(coordinator.reason, '')
    coordinator.destroy()
  }))

test('a rejected native preparation retains its actual reason after cleanup cancellation', async () =>
  fixture(async (root) => {
    const c = context(),
      states: string[] = []
    let nativeReason = 'low_beat_confidence',
      submissions = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_, options) => result(options),
      cancelAnalysis: () => {},
      cancel: async () => {
        nativeReason = 'host_cancelled'
        return true
      },
      prepare: async () => {
        nativeReason = 'low_beat_confidence'
        return false
      },
      submit: async () => {
        submissions++
        return true
      },
      status: async () => ({ ...c.info, autoMixState: 'degraded', autoMixReason: nativeReason }),
      onState: (state, reason) => states.push(`${state}:${reason}`)
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.equal(submissions, 0)
    assert.equal(coordinator.reason, 'low_beat_confidence')
    assert.equal(states.at(-1), 'degraded:low_beat_confidence')
    coordinator.destroy()
  }))

test('provider cache uses actual bytes; resolution change during inference rejects publication', async () =>
  fixture(async (root) => {
    const c = context(),
      registry = new ProviderPlaybackIdentityRegistry()
    registry.record('ncm', 'a', 'hires', {
      streamUrl: c.current.source,
      providerSource: { originSource: 'https://cdn.example/a?version=1', actualQuality: 'lossless' }
    })
    let prepared = 0,
      analyzed = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      sourceRevision: (s) => registry.revision(s),
      assertSource: (s) => registry.assertCurrent(s),
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_, options) => {
        analyzed++
        if (analyzed === 2) registry.record('ncm', 'a', 'standard', 'D:/cache/replaced.mp3')
        return result(options)
      },
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async () => {
        prepared++
        return true
      },
      submit: async () => true,
      status: async () => c.info
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.equal(prepared, 0)
    assert.equal(coordinator.reason, 'provider_source_resolution_changed')
    coordinator.destroy()
  }))

test('DJ fixed windows cover only the first 60 and last 100 seconds with overlap', () => {
  for (const duration of [12.5, 60, 100, 184.731])
    for (const deck of [0, 1]) {
      const starts = autoMixBoundaryStarts(duration, 'dj', deck).sort((a, b) => a - b)
      const end = deck ? Math.min(60, duration) : duration
      assert.equal(starts[0], deck ? 0 : Math.max(0, duration - 100))
      let covered = starts[0]
      for (const start of starts) {
        assert.ok(start <= covered)
        covered = Math.min(duration, start + 30)
        assert.ok(covered <= end + 1e-7)
      }
      assert.equal(covered, end)
    }
})

test('transient busy retries twice reuse analysis and preserve the real final reason', async () =>
  fixture(async (root) => {
    const c = context(),
      delays: number[] = [],
      states: string[] = []
    let analyses = 0,
      prepares = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_s, o) => {
        analyses++
        return result(o)
      },
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async () => {
        prepares++
        return false
      },
      status: async () => ({
        ...c.info,
        autoMixState: 'degraded',
        autoMixReason: 'preparation_worker_busy'
      }),
      submit: async () => {
        assert.fail('busy plan cannot submit')
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
      onState: (_s, r) => states.push(r)
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.equal(prepares, 3)
    assert.equal(analyses, 2)
    assert.deepEqual(delays, [250, 1000])
    assert.equal(coordinator.reason, 'preparation_worker_busy')
    assert.equal(states.at(-1), 'preparation_worker_busy')
    coordinator.destroy()
  }))

test('cache read and write failure preserves valid analysis and submits once', async () =>
  fixture(async (root) => {
    const c = context()
    let submits = 0
    const cache = new TwilightAutoMixWindowCache(join(root, 'cache.json'))
    cache.get = async () => {
      throw Error('read')
    }
    cache.set = async () => {
      throw Error('write')
    }
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache,
      analyze: async (_s, o) => result(o),
      cancelAnalysis: () => {},
      cancel: async () => true,
      prepare: async () => true,
      status: async () => c.info,
      submit: async () => {
        submits++
        return true
      }
    })
    coordinator.setMode('natural')
    await coordinator.idle()
    assert.equal(submits, 1)
    assert.ok(coordinator.diagnostics.some((e) => e.reason === 'cache_write_failed'))
    coordinator.destroy()
  }))

test('live playback deadline prevents submission after analysis or model delay', async () =>
  fixture(async (root) => {
    const c = context()
    let submits = 0,
      prepares = 0,
      releases = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_s, o) => result(o),
      cancelAnalysis: () => {},
      cancel: async () => true,
      select: async () => ({ ok: true, selectionId: 7, currentStartSeconds: 40 }),
      stems: async () => {
        c.info.position = 39
        throw Error('stem_timeout')
      },
      releaseMaterials: async () => {
        releases++
      },
      prepare: async () => {
        prepares++
        return true
      },
      status: async () => c.info,
      submit: async () => {
        submits++
        return true
      }
    })
    coordinator.setMode('dj')
    await coordinator.idle()
    assert.equal(prepares, 0)
    assert.equal(submits, 0)
    assert.equal(releases, 1)
    assert.equal(coordinator.reason, 'preparation_missed_boundary')
    coordinator.destroy()
  }))

test('stem timeout falls back to base preparation while releasing its ticket', async () =>
  fixture(async (root) => {
    const c = context()
    let submitted = 0,
      released = 0
    const coordinator = new TwilightAutoMixCoordinator({
      context: () => c,
      authorize: async (s) => s,
      identify: async () => 'a'.repeat(64),
      cache: new TwilightAutoMixWindowCache(join(root, 'cache.json')),
      analyze: async (_s, o) => result(o),
      cancelAnalysis: () => {},
      cancel: async () => true,
      select: async () => ({ ok: true, selectionId: 7, currentStartSeconds: 40 }),
      stems: async () => {
        throw Error('stem_timeout')
      },
      releaseMaterials: async () => {
        released++
      },
      prepare: async (r) => {
        assert.equal(JSON.parse(r).selectionId, 7)
        assert.equal(JSON.parse(r).stemMaterials, undefined)
        return true
      },
      status: async () => c.info,
      submit: async () => {
        submitted++
        return true
      }
    })
    coordinator.setMode('dj')
    await coordinator.idle()
    assert.equal(submitted, 1)
    assert.equal(released, 1)
    assert.ok(coordinator.diagnostics.some((e) => e.stage === 'stems' && e.outcome === 'fallback'))
    coordinator.destroy()
  }))
