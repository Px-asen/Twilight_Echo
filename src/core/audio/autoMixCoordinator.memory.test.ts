import assert from 'node:assert/strict'
import test from 'node:test'
import { TwilightAutoMixCoordinator, type TwilightAutoMixContext } from './autoMixCoordinator.ts'
import type { TwilightAutoMixWindowIdentity } from './autoMixWindowCache.ts'
import type { AutoMixFeatures } from '../../shared/twilightAutoMix.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'

function features(identity: TwilightAutoMixWindowIdentity): AutoMixFeatures {
  return {
    ok: true,
    algorithm: 'Twilight AutoMix',
    modelVersion: identity.modelVersion,
    sourceIdentity: identity.sourceIdentity,
    coverage: {
      startSeconds: identity.windowStartSeconds,
      endSeconds: identity.windowEndSeconds,
      durationSeconds: identity.sourceEndSeconds - identity.sourceStartSeconds,
      complete: true
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
    frameDb: Array(1500).fill(-12),
    framePeak: Array(1500).fill(0.2)
  }
}

function fixture(
  get: (identity: TwilightAutoMixWindowIdentity) => Promise<AutoMixFeatures | null>
) {
  const context: TwilightAutoMixContext = {
    queueToken: 'queue',
    current: { id: '0', source: 'C:/music/0.flac', duration: 30 },
    next: { id: '1', source: 'C:/music/1.flac', duration: 30 },
    info: {
      state: 'playing',
      duration: 30,
      position: 1,
      playbackRate: 1,
      autoMixState: 'ready',
      autoMixPlanId: 1
    } as PlaybackInfo
  }
  let analyses = 0,
    submits = 0
  const coordinator = new TwilightAutoMixCoordinator({
    context: () => context,
    authorize: async (source) => source,
    identify: async (source) =>
      Number(source.match(/(\d+)\.flac$/)![1])
        .toString(16)
        .padStart(64, '0'),
    cache: { get, set: async () => {} },
    analyze: async () => {
      analyses++
      throw new Error('unexpected_analysis')
    },
    cancelAnalysis: () => {},
    cancel: async () => true,
    prepare: async () => true,
    status: async () => context.info,
    submit: async () => {
      submits++
      return true
    },
    backgroundAnalysis: false
  })
  const windows = (coordinator as unknown as { validWindows: Map<string, AutoMixFeatures> })
    .validWindows
  const play = async (index: number) => {
    context.current = { id: String(index), source: `C:/music/${index}.flac`, duration: 30 }
    context.next = { id: String(index + 1), source: `C:/music/${index + 1}.flac`, duration: 30 }
    coordinator.setMode('natural')
    coordinator.observe()
    await coordinator.idle()
  }
  return { coordinator, windows, play, analyses: () => analyses, submits: () => submits }
}

test('disk cache hits obey the same 64-window memory budget as fresh analysis', async (t) => {
  let reads = 0
  const f = fixture(async (identity) => {
    reads++
    return features(identity)
  })
  t.after(() => f.coordinator.shutdown())
  for (let index = 0; index < 128; index += 2) await f.play(index)
  t.diagnostic(
    `retained windows: ${f.windows.size}; frame values: ${[...f.windows.values()].reduce((sum, value) => sum + value.frameDb.length + value.framePeak.length, 0)}`
  )
  assert.equal(reads, 128)
  assert.equal(f.submits(), 64)
  assert.equal(f.analyses(), 0)
  assert.equal(f.windows.size, 64)
  await f.play(124)
  assert.equal(reads, 128, 'recent windows are reused in memory')
  await f.play(0)
  assert.equal(reads, 130, 'evicted windows are read from disk without rerunning analysis')
  assert.equal(f.analyses(), 0)
  assert.equal(f.windows.size, 64)
})

for (const outcome of ['hit', 'failure'] as const) {
  test(`invalidated ${outcome} from a pending cache read cannot retain windows or start analysis`, async (t) => {
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<AutoMixFeatures | null>()
    let identity!: TwilightAutoMixWindowIdentity
    const f = fixture(async (next) => {
      identity = next
      started.resolve()
      return pending.promise
    })
    t.after(() => f.coordinator.shutdown())
    f.coordinator.setMode('natural')
    await started.promise
    f.coordinator.invalidate('seek')
    if (outcome === 'hit') pending.resolve(features(identity))
    else pending.reject(new Error('cache_read_failed'))
    await f.coordinator.idle()
    assert.equal(f.windows.size, 0)
    assert.equal(f.analyses(), 0)
    assert.equal(f.submits(), 0)
  })
}
