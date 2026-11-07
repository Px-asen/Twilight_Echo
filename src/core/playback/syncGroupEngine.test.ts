import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncGroupEngine, type SyncGroupOutput, type SyncGroupOutputState } from './syncGroupEngine.ts'
import { createDefaultPlaybackInfo } from '../audio/audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../../shared/audioOutputConfig.ts'
import type { AudioEngineQueueItem } from '../../shared/audioEngineTypes.ts'
import { CorePlaybackSession, type CorePlaybackSessionOptions } from './session.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { BridgeAutoMixPlan } from '../../shared/bridgeAutoMix.ts'
import { bridgeAutoMixSourceFrame } from '../../shared/bridgeAutoMix.ts'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreAutoMixService } from '../audio/autoMixService.ts'
import { ProviderPlaybackIdentityRegistry } from '../audio/providerPlaybackIdentity.ts'
import { TWILIGHT_AUTOMIX_MODEL_VERSION } from '../../shared/twilightAutoMix.ts'
import type { TwilightAutoMixCoordinator } from '../audio/twilightAutoMixCoordinator.ts'

const initial = () => createDefaultPlaybackInfo('wasapi', 'explicit-fixture', true, normalizeOutputConfig())
const item = (id = 'a', entry = 'a:1'): AudioEngineQueueItem => ({ id, queueEntryId: entry, source: `C:/${id}.flac`, duration: 10, logicalQueueEnd: true })
function fixture(continuous = false) {
  let now = 10000, token = 0
  let scheduled: (() => void) | null = null
  const calls: string[] = []
  class Output implements SyncGroupOutput {
    continuous?: SyncGroupOutput['continuous']
    autoMix?: SyncGroupOutput['autoMix']
    id: string; downstreamDelayMs = 0; values: SyncGroupOutputState
    pending: Promise<void> | null = null
    prepareFails = false; armFails = false; stopFails = false; arms: number[] = []; items: AudioEngineQueueItem[] = []
    constructor(id: string, latency: number, rate: number, volume: number) {
      this.id = id
      this.values = { playback: { ...initial(), volume },
        dsp: { revision: 1, activeSceneId: null, totalLatencyFrames: latency, totalTailFrames: 0, latencySampleRate: rate,
          nodes: [], applyState: 'applied', compileState: 'ready' },
        bridge: { supported: true, hosting: false, receiving: false, selected: true, connected: true, peerName: id, error: null,
          receiver: { sampleRate: 48000, channels: 2, capacityFrames: 12000, prebufferFrames: 1920, bufferedFrames: 0,
            consumedFrames: 0, underruns: 0, started: false, failed: false, backend: 'wasapi-exclusive', deviceName: id,
            actualSampleRate: 48000, actualBitDepth: 32, actualChannels: 2, actualOutputFormat: 'float32', exclusive: true,
            adaptiveSupported: true, timedStart: { supported: true, state: 'disabled', error: '', ended: false, mediaFrame: 0,
              targetAtMs: 0, deviceStartFrame: null, deviceStartAtMs: null, presentedMediaFrames: null } },
          timing: { network: { state: 'ready', offsetMs: 0, roundTripMs: .4, uncertaintyMs: .2, samples: 10 },
            output: { state: 'warming', source: 'wasapi-audio-clock', streamGeneration: 1, epoch: 1, sampleRate: 48000,
              positionFrames: 0, sampledAtCoreMs: now, ageMs: 0, callbackRequestedFrames: 0, driftPpm: null,
              windowMs: 0, samples: 1, residualFrames: null } } } }
    }
    async read() { return structuredClone(this.values) }
    async prepare(media: AudioEngineQueueItem, position: number, current: () => boolean) {
      calls.push(`prepare:${this.id}:${media.queueEntryId}:${position}`)
      if (this.pending) await this.pending
      if (!current()) throw Error('cancelled prepare')
      if (this.prepareFails) throw Error('decoder failed')
      this.items.push(media)
      this.values.bridge.receiver!.bufferedFrames = 4800
      this.values.bridge.receiver!.timedStart!.state = 'prepared'
    }
    async arm(at: number, frame: number) {
      calls.push(`arm:${this.id}`)
      if (this.armFails) throw Error('arm failed')
      this.arms.push(at)
      this.values.bridge.receiver!.timedStart!.state = 'running'
      this.values.bridge.receiver!.timedStart!.mediaFrame = frame
      this.values.bridge.synchronization = { state: 'correcting', error: null, phaseErrorMs: 0, uncertaintyMs: .2,
        requestedPpm: 0, effectivePpm: 0, sampledAtCoreMs: at, samples: 1 }
    }
    async silence() {
      calls.push(`silence:${this.id}`)
      this.values.bridge.receiver!.timedStart!.state = 'disabled'; this.values.bridge.receiver!.bufferedFrames = 0
      this.values.bridge.synchronization = null
      if (this.stopFails) throw Error('silence unconfirmed')
    }
    async volume(value: number) { this.values.playback.volume = value }
    complete() { this.values.bridge.receiver!.timedStart!.state = 'completed'; this.values.bridge.receiver!.timedStart!.ended = true }
  }
  const a = new Output('a', 480, 48000, .8), b = new Output('b', 1920, 96000, .4)
  if (continuous) for (const o of [a,b]) Object.assign(o, { continuous: {
    acquire: async () => { calls.push(`acquire:${o.id}`) }, release: async () => { calls.push(`release:${o.id}`) },
    prepare: async (items: AudioEngineQueueItem[], position: number, current: () => boolean) => {
      await o.prepare(items[0], position, current)
      o.values.playback.duration = items[0].duration ?? 10
      o.values.playback.preloadReady = items.length > 1
      o.values.sourceTimeline = { generation: o.arms.length+1, epoch: o.arms.length+1, frames: 4800,
        sampleRate: 48000, positionFrames: Math.round(position*48000)+4800,
        transitionFrame: 0, transitionSerial: 0, entryId: items[0].queueEntryId!, advanceReady: true }
    },
    rebind: async (_expected: AudioEngineQueueItem, items: AudioEngineQueueItem[]) => {
      calls.push(`rebind:${o.id}:${items[0].queueEntryId}:${items[1]?.queueEntryId ?? ''}`)
      o.values.playback.preloadReady = items.length > 1
      o.values.sourceTimeline!.entryId = items[0].queueEntryId!
      return true
    },
    hold: async () => { calls.push(`hold:${o.id}`) },
    advance: async (current: string, next: string) => { calls.push(`advance:${o.id}:${current}:${next}`) }
  } })
  b.downstreamDelayMs = 3
  let changed = 0
  const engine = new SyncGroupEngine({ outputs: [a,b], initial: initial(), now: () => now, wallNow: () => 123456,
    token: () => `group-token-${++token}`, wait: async (ms, signal) => { signal.throwIfAborted(); now += ms },
    schedule: action => { scheduled = action; return () => { if (scheduled === action) scheduled = null } },
    changed: () => { changed++ } })
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
  const tick = async (ms = 100) => { now += ms; const callback = scheduled; scheduled = null; callback?.(); await settle() }
  return { engine, a, b, calls, tick, settle, now: () => now, changed: () => changed }
}

test('one common occurrence uses distinct DSP domains and downstream offsets, with balance-preserving volume', async () => {
  const f = fixture(); await f.engine.loadQueue([item()], 0)
  await f.engine.play(item().source, 2)
  const state = f.engine.state()
  assert.equal(state.phase, 'armed')
  assert.equal(state.members[0].dspDelayMs, 10)
  assert.equal(state.members[1].dspDelayMs, 20)
  assert.equal(f.a.arms[0]-f.b.arms[0], 13)
  assert.equal(f.a.arms[0]+10, state.audibleAtCoreMs)
  assert.equal(f.b.arms[0]+23, state.audibleAtCoreMs)
  assert.deepEqual(f.a.items.map(i => i.queueEntryId), ['a:1'])
  assert.deepEqual(f.b.items.map(i => i.queueEntryId), ['a:1'])
  assert.equal((await f.engine.getPlaybackInfo()).position, 2)
  await f.engine.setVolume(.6)
  assert.equal(f.a.values.playback.volume, .6)
  assert.equal(f.b.values.playback.volume, .3)
  await f.tick(600)
  assert.ok((await f.engine.getPlaybackInfo()).position > 2)
  assert.equal(f.engine.state().phase, 'playing')
  await f.engine.pause()
  const position = (await f.engine.getPlaybackInfo()).position
  await f.tick(500)
  assert.equal((await f.engine.getPlaybackInfo()).position, position)
  assert.equal(f.a.values.bridge.receiver?.timedStart?.state, 'disabled')
})

test('one common EOF waits for the slowest device, then advances identical-media occurrences exactly once', async () => {
  const f = fixture()
  await f.engine.loadQueue([{ ...item(), logicalQueueEnd: false }, item('a', 'a:2')])
  await f.engine.play(item().source, 0)
  f.a.complete(); await f.tick(11000)
  assert.equal(f.a.items.length, 1); assert.equal(f.b.items.length, 1)
  f.b.complete(); await f.tick()
  assert.equal(f.a.items.length, 2); assert.equal(f.b.items.length, 2)
  assert.equal(f.a.items[1].queueEntryId, 'a:2')
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial, 1)
  await f.tick(); assert.equal(f.a.items.length, 2)
  f.a.complete(); f.b.complete(); await f.tick(11000)
  const info = await f.engine.getPlaybackInfo()
  assert.equal(info.state, 'stopped'); assert.equal(info.naturalBoundaries?.trackSerial, 2)
  assert.equal(info.naturalBoundaries?.queueSerial, 1)
  const end = f.engine.getPlaybackEnd()!
  assert.equal(end.selection.index, 1)
  let selected = 0
  assert.equal(await f.engine.continueAfterPlaybackEnd({ expected: end, item: item('b', 'b:1'), playMode: 'sequential',
    isCurrent: () => true, onSelected: () => { selected++ } }), true)
  assert.equal(selected, 1); assert.equal(f.a.items.at(-1)?.queueEntryId, 'b:1')
  assert.equal(await f.engine.continueAfterPlaybackEnd({ expected: end, item: item('b'), playMode: 'sequential',
    isCurrent: () => true, onSelected: () => { selected++ } }), false)
})

test('queue-only rebind keeps live deadlines and delay changes rebuffer the group from common presented position', async () => {
  const f = fixture(); await f.engine.loadQueue([item()]); await f.engine.play(item().source, 1)
  const before = f.engine.state().audibleAtCoreMs
  const token = f.engine.getQueueToken()
  const result = await f.engine.rebindQueue({ expected: { queueToken: token, index: 0, id: 'a', source: item().source },
    items: [{ ...item(), logicalQueueEnd: false }, item('b')], startIndex: 0, playMode: 'sequential' })
  assert.ok(result); assert.notEqual(result.queueToken, token)
  assert.equal(f.engine.state().audibleAtCoreMs, before)
  assert.equal(f.a.arms.length, 1)
  await f.tick(800)
  f.b.values.dsp.totalLatencyFrames += 960
  await f.tick()
  assert.equal(f.a.arms.length, 2); assert.equal(f.b.arms.length, 2)
  assert.equal(f.engine.state().members[1].dspDelayMs, 30)
  assert.equal(f.a.arms[1]-f.b.arms[1], 23)
  assert.ok(Math.abs(Number(f.calls.filter(c => c.startsWith('prepare:a')).at(-1)!.split(':').at(-1))-1.527) < 1e-8)
})

test('a Stop interrupts blocked preparation before a commit lane is free; late completion cannot arm', async () => {
  const f = fixture(); await f.engine.loadQueue([item()])
  let release!: () => void
  f.b.pending = new Promise<void>(resolve => { release = resolve })
  const playing = f.engine.play(item().source)
  await f.settle()
  assert.ok(f.calls.some(c => c.startsWith('prepare:b')))
  f.engine.interrupt() // Same synchronous hook used by CorePlaybackSession.revoke().
  const stopped = f.engine.stop()
  release()
  assert.equal((await playing).superseded, true); await stopped
  assert.equal(f.a.arms.length, 0); assert.equal(f.b.arms.length, 0)
  assert.equal((await f.engine.getPlaybackInfo()).state, 'stopped')
})

test('synchronous revocation and committed Pause join one outstanding cancellation instead of flushing its acknowledgement', async () => {
  const f = fixture(); await f.engine.loadQueue([item()]); await f.engine.play(item().source)
  let release!: () => void, stops = 0
  f.a.silence = async () => { stops++; await new Promise<void>(resolve => { release = resolve }) }
  f.engine.interrupt()
  f.engine.interrupt(true)
  const pausing = f.engine.pause()
  assert.equal(stops, 1)
  release(); await pausing
  assert.equal((await f.engine.getPlaybackInfo()).state, 'paused')
})

test('member/arm failure silences all outputs and never drops the failed member or resumes automatically', async () => {
  for (const failAt of ['prepare', 'arm', 'disconnect', 'clock'] as const) {
    const f = fixture(); await f.engine.loadQueue([item()])
    if (failAt === 'prepare') f.b.prepareFails = true
    if (failAt === 'arm') f.b.armFails = true
    if (failAt === 'prepare' || failAt === 'arm') await assert.rejects(f.engine.play(item().source), /failed/)
    else {
      await f.engine.play(item().source)
      if (failAt === 'disconnect') f.b.values.bridge.connected = false
      else f.b.values.bridge.synchronization!.state = 'failed'
      await f.tick(500)
    }
    assert.equal(f.engine.state().phase, 'failed')
    assert.equal((await f.engine.getPlaybackInfo()).state, 'paused')
    assert.equal(f.a.values.bridge.receiver?.timedStart?.state, 'disabled')
    assert.equal(f.b.values.bridge.receiver?.timedStart?.state, 'disabled')
    const arms = f.a.arms.length
    await f.tick(3000); assert.equal(f.a.arms.length, arms)
    assert.equal(f.engine.state().members.length, 2)
  }
})

test('Seek re-arms all outputs; repeat is owned by the group and playback-rate changes cannot split it', async () => {
  const f = fixture(); await f.engine.loadQueue([item()]); await f.engine.play(item().source)
  await f.engine.seek(4)
  assert.equal(f.a.arms.length, 2); assert.equal(f.b.arms.length, 2)
  assert.equal((await f.engine.getPlaybackInfo()).position, 4)
  await f.engine.setPlayMode('repeat')
  f.a.complete(); f.b.complete(); await f.tick(11000)
  assert.equal(f.a.arms.length, 3); assert.equal(f.b.arms.length, 3)
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial, 1)
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.queueSerial, 0)
  await assert.rejects(f.engine.setPlaybackRate(1.5), /1 倍速/)
  await f.engine.pause(); await f.engine.seek(7)
  assert.equal(f.a.arms.length, 3)
  assert.equal((await f.engine.getPlaybackInfo()).position, 7)
  await f.engine.close()
})

test('persistent skew beyond observation range triggers common rebuffer; unconfirmed silence escalates instead of reporting success', async () => {
  const f = fixture(); await f.engine.loadQueue([item()]); await f.engine.play(item().source)
  f.b.values.bridge.synchronization!.phaseErrorMs = 3
  await f.tick(600); assert.equal(f.a.arms.length, 1)
  await f.tick(600); assert.equal(f.a.arms.length, 2)
  let crash = ''
  f.engine.on('audio-service-crash', e => { crash = e.reason })
  f.b.stopFails = true; f.b.values.bridge.connected = false
  await f.tick()
  assert.match(crash, /停音未确认/)
    f.b.stopFails = false; f.b.values.bridge.connected = true
    await f.engine.recover()
    assert.equal(f.engine.state().error, null)
    assert.equal(f.engine.state().phase, 'paused')
    assert.notEqual((await f.engine.getPlaybackInfo()).state, 'playing')
})

async function sharedSession(t: test.TestContext, continuous = false) {
  const f = fixture(continuous), db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [
    { id: 'a', title: 'First cue', filePath: 'C:/disc.flac', duration: 10, cueRange: { startSeconds: 0, endSeconds: 10 } },
    { id: 'b', title: 'Second cue', filePath: 'C:/disc.flac', duration: 10, cueRange: { startSeconds: 10, endSeconds: 20 } }
  ] })
  const queues: CorePlaybackSessionOptions['queues'] = {
    libraryRevision: async () => db.getMetadata().revision,
    importLegacyPlaybackQueue: async c => db.importLegacyPlaybackQueue(c),
    restoreNamedPlaybackQueue: async c => db.restoreNamedPlaybackQueue(c),
    restoreHeartBaseQueue: async (...args) => db.restoreHeartBaseQueue(...args),
    createQueue: async (...args) => db.createLibraryQueue(...args), getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args), editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args),
    syncQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args),
    readNeighbor: async (...args) => db.readLibraryQueueNeighbor(...args)
  }
  let saved: Awaited<ReturnType<CorePlaybackSessionOptions['repository']['load']>> = null
  const session = new CorePlaybackSession({ engine: f.engine, queues,
    resolver: { resolve: async track => ({ source: (track as {filePath:string}).filePath, expiresAt: null }) },
    authorize: async source => source, repository: { load: async () => saved,
      save: async (data, revision) => { saved = { revision: revision+1, data: structuredClone(data) }; return saved },
      clear: async revision => { saved = { revision: revision+1, data: null }; return saved } },
    resumeMode: () => 'trackAndPosition', now: () => 123456,
    schedule: (action, ms) => { const timer = setTimeout(action, ms); return () => clearTimeout(timer) },
    changed: () => {}, fatal: error => assert.fail(error.message) })
  await session.initialize()
  t.after(async () => { await session.shutdown(); await f.engine.close(); db.close() })
  const drain = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
  return { ...f, session, db, drain, saved: () => saved }
}

test('real shared Core session maintains one SQL cursor and CUE occurrences while all outputs wait for common EOF', async t => {
  const f = await sharedSession(t)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a')
  await f.drain()
  const queue = f.session.snapshot().queue!
  assert.equal(f.engine.getQueueSnapshot().length, 2) // Session maintainer installed one shared successor.
  assert.equal(f.engine.getQueueSnapshot()[0].cueRange?.endSeconds, 10)
  f.a.complete(); await f.tick(11000); await f.drain()
  assert.equal(f.session.snapshot().track?.id, 'a')
  f.b.complete(); await f.tick(); await f.drain()
  assert.equal(f.session.snapshot().track?.id, 'b')
  assert.equal(f.session.snapshot().queue?.id, queue.id)
  assert.equal(f.db.getLibraryQueue(queue.id).index, 1)
  assert.equal(f.a.items.at(-1)?.cueRange?.startSeconds, 10)
  assert.equal(f.b.items.at(-1)?.queueEntryId, f.session.snapshot().queue?.occurrenceId)
  await f.session.pause(); await f.session.flush()
  assert.equal(f.saved()?.data?.libraryQueue?.id, queue.id)
  assert.equal(f.saved()?.data?.track?.id, 'b')
})

test('shared Core Pause interrupts a pending group prepare before its serialized session transport completes', async t => {
  const f = await sharedSession(t)
  let release!: () => void
  f.b.pending = new Promise<void>(resolve => { release = resolve })
  const playing = f.session.fromQuery({ ids: ['a'], sort: 'playlist' }, 'a')
  const rejected = assert.rejects(playing, /superseded|取消|started/)
  await f.drain()
  assert.ok(f.calls.some(c => c.startsWith('prepare:b')))
  const pausing = f.session.pause()
  await f.settle()
  assert.equal(f.a.values.bridge.receiver?.timedStart?.state, 'disabled')
  release(); await rejected; await pausing
  assert.equal(f.a.arms.length, 0); assert.equal(f.b.arms.length, 0)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
})

test('shared queue edits and mode changes preserve the current decoder and cannot suppress the next common boundary', async t => {
  const f = await sharedSession(t)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a'); await f.drain()
  await f.session.setMode('listLoop'); await f.drain()
  assert.equal(f.a.arms.length, 1); assert.equal(f.b.arms.length, 1)
  assert.equal(f.a.values.bridge.receiver?.timedStart?.state, 'running')
  await f.tick(600)
  assert.equal((await f.engine.getPlaybackInfo()).state, 'playing')
  f.a.complete(); f.b.complete(); await f.tick(11000); await f.drain()
  assert.equal(f.session.snapshot().track?.id, 'b')
  f.a.complete(); f.b.complete(); await f.tick(11000); await f.drain()
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.a.arms.length, 3); assert.equal(f.b.arms.length, 3)
})

function promote(output: ReturnType<typeof fixture>['a'], entryId: string, at = 480000, rate = 48000) {
  const prior = output.values.sourceTimeline!
  output.values.sourceTimeline = { ...prior, entryId, sampleRate: rate, frames: at+4800, positionFrames: 4800,
    transitionFrame: at, transitionSerial: prior.transitionSerial+1 }
  output.values.playback.queueIndex = 1
  output.values.playback.preloadReady = false
}

test('continuous windows commit one successor together and adopt repeated occurrences only at their audible boundary', async () => {
  const f = fixture(true)
  f.a.values.playback.crossfadeActive = true; f.a.values.playback.crossfadeSeconds = 4
  await f.engine.loadQueue([{ ...item(), logicalQueueEnd: false }, item('a', 'a:2')])
  await f.engine.play(item().source)
  await f.tick()
  assert.deepEqual(f.calls.filter(c => c.startsWith('advance:')), ['advance:a:a:1:a:2', 'advance:b:a:1:a:2'])
  assert.equal((await f.engine.getPlaybackInfo()).gaplessActive, true)
  assert.equal((await f.engine.getPlaybackInfo()).crossfadeActive, false)
  promote(f.a, 'a:2')
  await f.tick(9600)
  assert.equal((await f.engine.getPlaybackInfo()).queueIndex, 0)
  promote(f.b, 'a:2')
  await f.tick(100)
  assert.equal((await f.engine.getPlaybackInfo()).queueIndex, 0) // captured, not yet audible
  await f.tick(1000)
  const info = await f.engine.getPlaybackInfo()
  assert.equal(info.queueIndex, 1); assert.equal(info.naturalBoundaries?.trackSerial, 1)
  assert.equal(info.naturalBoundaries?.queueSerial, 0)
  assert.equal(f.a.arms.length, 1); assert.equal(f.b.arms.length, 1)
  assert.equal(f.a.items.length, 1); assert.ok(info.position > 0 && info.position < 1)
  await f.tick(); assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial, 1)
  f.a.complete(); f.b.complete(); await f.tick(10000)
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial, 2)
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.queueSerial, 1)
  await f.engine.close()
  assert.deepEqual(f.calls.filter(c => c.startsWith('release:')), ['release:a', 'release:b'])
})

test('continuous hot rebind is all-member CAS; a mixed or unknown result silences every member', async () => {
  for (const fail of [false, true]) {
    const f = fixture(true); await f.engine.loadQueue([item()]); await f.engine.play(item().source, 1)
    const before = f.engine.state().audibleAtCoreMs
    if (fail) f.b.continuous!.rebind = async () => false
    const request = { expected: { queueToken: f.engine.getQueueToken(), index: 0, id: 'a', source: item().source },
      items: [{ ...item(), logicalQueueEnd: false }, item('b', 'b:1')], startIndex: 0, playMode: 'sequential' as const }
    if (fail) {
      await assert.rejects(f.engine.rebindQueue(request), /不一致/)
      assert.equal(f.engine.state().phase, 'failed')
      assert.equal(f.a.values.bridge.receiver?.timedStart?.state, 'disabled')
      assert.equal(f.b.values.bridge.receiver?.timedStart?.state, 'disabled')
    } else {
      assert.ok(await f.engine.rebindQueue(request))
      assert.equal(f.engine.state().audibleAtCoreMs, before)
      assert.equal(f.a.arms.length, 1)
      await f.tick()
      assert.ok(f.calls.includes('advance:a:a:1:b:1'))
      assert.equal((await f.engine.getPlaybackInfo()).gaplessActive, true)
    }
    await f.engine.close()
  }
})

test('no common-ready successor keeps explicit EOF re-arm; unexpected or mismatched promotion stops the group', async () => {
  const f = fixture(true); await f.engine.loadQueue([{ ...item(), logicalQueueEnd: false }, item('b', 'b:1')])
  await f.engine.play(item().source)
  f.b.values.playback.preloadReady = false; await f.tick()
  assert.equal(f.calls.some(c => c.startsWith('advance:')), false)
  assert.equal((await f.engine.getPlaybackInfo()).gaplessActive, false)
  f.a.complete(); f.b.complete(); await f.tick(11000)
  assert.equal(f.a.arms.length, 2); assert.equal(f.b.arms.length, 2)
  await f.engine.close()
  for (const mismatch of ['uncommitted', 'boundary', 'generation'] as const) {
    const g = fixture(true); await g.engine.loadQueue([item(), item('b', 'b:1')]); await g.engine.play(item().source)
    if (mismatch !== 'uncommitted') await g.tick()
    promote(g.a, 'b:1'); promote(g.b, 'b:1', mismatch === 'boundary' ? 480096 : 480000)
    if (mismatch === 'generation') g.b.values.sourceTimeline!.generation++
    await g.tick(11000)
    assert.equal(g.engine.state().phase, 'failed', mismatch)
    assert.equal(g.a.values.bridge.receiver?.timedStart?.state, 'disabled')
    assert.equal(g.b.values.bridge.receiver?.timedStart?.state, 'disabled')
    await g.engine.close()
  }
})

test('continuous shared Core session advances its SQL CUE cursor without preparing or arming another stream', async t => {
  const f = await sharedSession(t, true)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a'); await f.drain()
  const queue = f.session.snapshot().queue!, next = f.engine.getQueueSnapshot()[1]
  assert.equal(next.cueRange?.startSeconds, 10)
  await f.tick()
  promote(f.a, next.queueEntryId!); promote(f.b, next.queueEntryId!)
  await f.tick(11000); await f.drain()
  assert.equal(f.session.snapshot().track?.id, 'b')
  assert.equal(f.db.getLibraryQueue(queue.id).index, 1)
  assert.equal(f.a.arms.length, 1); assert.equal(f.b.arms.length, 1)
  assert.equal(f.a.items.length, 1); assert.equal(f.b.items.length, 1)
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial, 1)
})

test('repeat renews the same occurrence window and counts every continuous boundary once without re-arming', async () => {
  const f = fixture(true); await f.engine.loadQueue([item()]); await f.engine.setPlayMode('repeat')
  await f.engine.play(item().source); await f.tick()
  for (let n = 1; n <= 3; n++) {
    for (const o of [f.a,f.b]) {
      promote(o, 'a:1', n*480000)
      o.values.playback.preloadReady = false
    }
    await f.tick(n === 1 ? 11000 : 10000)
    const info = await f.engine.getPlaybackInfo()
    assert.equal(info.queueIndex, 0); assert.equal(info.naturalBoundaries?.trackSerial, n)
    assert.equal(info.naturalBoundaries?.queueSerial, 0)
    assert.equal(f.a.arms.length, 1); assert.equal(f.b.arms.length, 1)
    await f.tick(); await f.tick()
  }
  assert.equal(f.calls.filter(c => c === 'advance:a:a:1:a:1').length, 4)
  await f.engine.close()
})

function autoMixFixture() {
  const f = fixture(true), requests: { kind: string; member: string; value: any }[] = []
  const plan: BridgeAutoMixPlan = { version: 1, ruleVersion: 'twilight-rules-5', mode: 'natural', sampleRate: 48000, channels: 2,
    currentIdentity: 'a'.repeat(64), nextIdentity: 'b'.repeat(64), currentEntryId: 'a:1', nextEntryId: 'b:1',
    currentSourceStartSeconds: 0, currentSourceEndSeconds: 10, nextSourceStartSeconds: 0, nextSourceEndSeconds: 4.005,
    currentStartFrame: 6*48000, currentEndFrame: Math.round(9.928*48000), nextStartFrame: 0, nextEndFrame: 4*48000,
    outputFrames: 4*48000, currentRate: .98, nextRate: 1, nextGain: 1, effect: 0, kind: 1, bpm: 120, confidence: .9,
    score: 1, lowClash: 0, vocalClash: 0 }
  for (const [i,o] of [f.a,f.b].entries()) o.autoMix = {
    mode: async mode => { o.values.playback.autoMixMode = mode },
    select: async json => { requests.push({ kind:'select',member:o.id,value:JSON.parse(json) }); return { ok:true,selectionId:101,sharedPlan:plan } },
    bind: async json => { requests.push({ kind:'bind',member:o.id,value:JSON.parse(json) }); return { ok:true,selectionId:902,sharedPlan:plan } },
    prepare: async json => { requests.push({ kind:'prepare',member:o.id,value:JSON.parse(json) });
      o.values.playback.autoMixState='preparing';o.values.playback.autoMixPlanId=i?9001:501;return true },
    status: async () => structuredClone(o.values.playback),
    submit: async id => { requests.push({ kind:'submit',member:o.id,value:id });return true },
    cancel: async () => { requests.push({ kind:'cancel',member:o.id,value:null });return true }
  }
  const ready = async () => {
    f.a.values.playback.autoMixState = f.b.values.playback.autoMixState = 'ready'
    return f.engine.getAutoMixNativeStatus()
  }
  const start = async () => {
    await f.engine.setAutoMixMode('natural')
    await f.engine.loadQueue([item(), {...item('b','b:1'),duration:4.005}]);await f.engine.play(item().source)
  }
  const select = () => f.engine.selectAutoMix(JSON.stringify({ currentSource:item().source,nextSource:item('b').source,
    minimumCurrentStartSeconds:0,materialDirectory:'C:/leader-only/twilight-automix-material-fixture' }))
  const prepare = (selectionId: number) => f.engine.prepareAutoMix(JSON.stringify({ selectionId }))
  return { ...f, requests, plan, start, select, prepare, ready }
}

test('group AutoMix selects once, binds local tickets, waits for every ready ID and commits each native plan', async () => {
  const f=autoMixFixture();await f.start();await f.tick()
  assert.equal(f.calls.some(c=>c.startsWith('advance:')),false,'ordinary gapless must wait for the AutoMix decision')
  f.b.values.sourceTimeline!.frames=f.b.values.sourceTimeline!.positionFrames=3*48000
  const selection=await f.select()
  assert.equal(f.requests.filter(r=>r.kind==='select').length,1)
  assert.equal(f.requests.find(r=>r.kind==='select')!.value.minimumCurrentStartSeconds,5.02)
  assert.equal(f.requests.find(r=>r.kind==='bind')!.value.materialDirectory,undefined)
  assert.deepEqual(f.requests.find(r=>r.kind==='bind')!.value.sharedPlan,f.plan)
  assert.equal(await f.prepare(selection.selectionId!),true)
  assert.deepEqual(f.requests.filter(r=>r.kind==='prepare').map(r=>r.value.selectionId),[101,902])
  f.a.values.playback.autoMixState='ready'
  assert.equal((await f.engine.getAutoMixNativeStatus()).autoMixState,'preparing')
  await assert.rejects(f.engine.submitAutoMix(selection.selectionId!),/stale_preparation_ticket/)
  assert.equal(f.requests.some(r=>r.kind==='submit'),false)
  assert.equal((await f.ready()).autoMixState,'ready')
  await f.engine.submitAutoMix(selection.selectionId!)
  assert.deepEqual(f.requests.filter(r=>r.kind==='submit').map(r=>r.value),[501,9001])
  await f.tick(f.engine.state().audibleAtCoreMs!+7000-f.now())
  assert.ok(Math.abs((await f.engine.getPlaybackInfo()).position-6.98)<1e-8,'current source follows stretch, not 1x wall time')
  for(const [i,o] of [f.a,f.b].entries()){
    promote(o,'b:1');o.values.playback.duration=4.005
    o.values.playback.autoMixState='degraded';o.values.playback.autoMixReason='transition_completed'
    o.values.sourceTimeline!.frames=480000+(i?3424:1024)
    o.values.sourceTimeline!.positionFrames=192240 // Real incoming EOF; different physical DSP drains.
  }
  await f.tick(f.engine.state().audibleAtCoreMs!+10100-f.now())
  const info=await f.engine.getPlaybackInfo()
  assert.equal(info.queueIndex,1);assert.equal(info.position,4.005)
  assert.equal(info.naturalBoundaries?.trackSerial,1)
  assert.equal(f.a.arms.length,1);assert.equal(f.b.arms.length,1)
  await f.engine.close()
})

test('a retired native AutoMix label without a proven promotion cannot pass the common deadline', async () => {
  const f=autoMixFixture();await f.start();const selected=await f.select();await f.prepare(selected.selectionId!);await f.ready()
  await f.engine.submitAutoMix(selected.selectionId!)
  for(const o of [f.a,f.b]){o.values.playback.autoMixState='degraded';o.values.playback.autoMixReason='transition_completed'}
  await f.tick(f.engine.state().audibleAtCoreMs!+10100-f.now())
  assert.equal(f.engine.state().phase,'failed');assert.match(f.engine.state().error!,/AutoMix 边界/)
  assert.equal((await f.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial??0,0)
  await f.engine.close()
})

test('partial or unknown group AutoMix submit stops every output, while a changed ready ID submits none', async () => {
  for(const failure of ['false','unknown','stale'] as const){
    const f=autoMixFixture();await f.start();const selected=await f.select();await f.prepare(selected.selectionId!);await f.ready()
    if(failure==='stale') f.b.values.playback.autoMixPlanId=999
    else f.b.autoMix!.submit=async()=>{if(failure==='unknown')throw Error('lost acknowledgement');return false}
    await assert.rejects(f.engine.submitAutoMix(selected.selectionId!),failure==='stale'?/stale_preparation_ticket/:/提交不一致/)
    if(failure==='stale'){
      assert.equal(f.requests.some(r=>r.kind==='submit'),false);await f.engine.pause()
    }else assert.equal(f.engine.state().phase,'failed')
    assert.equal(f.a.values.bridge.receiver!.timedStart!.state,'disabled')
    assert.equal(f.b.values.bridge.receiver!.timedStart!.state,'disabled')
    await f.engine.close()
  }
})

test('group AutoMix rejects leader-only stems, invalidates selection on transport and permits confirmed gapless fallback', async () => {
  const f=autoMixFixture();await f.start();const selected=await f.select()
  await assert.rejects(f.engine.prepareAutoMix(JSON.stringify({selectionId:selected.selectionId,stemMaterials:{directory:'leader-only'}})),/group_material_bindings_required/)
  assert.equal(f.requests.some(r=>r.kind==='prepare'),false)
  await f.engine.pause()
  await assert.rejects(f.prepare(selected.selectionId!),/stale_selection_ticket/)
  await f.engine.play(item().source)
  f.a.autoMix!.select=async()=>({ok:false,reason:'continuous_album_gapless'})
  const rejected=await f.select();assert.equal(rejected.ok,false)
  await f.tick()
  assert.deepEqual(f.calls.filter(c=>c.startsWith('advance:')),['advance:a:a:1:b:1','advance:b:a:1:b:1'])
  await f.engine.close()
})

test('Pause revokes an in-flight follower binding; late completion cannot create a new preparation', async () => {
  const f=autoMixFixture();await f.start()
  let release!:()=>void,entered=false
  f.b.autoMix!.bind=async()=>{entered=true;await new Promise<void>(resolve=>{release=resolve});return {ok:true,selectionId:902,sharedPlan:f.plan}}
  const selecting=f.select(), rejected=assert.rejects(selecting,/stale_group_automix/)
  await f.settle();assert.equal(entered,true)
  await f.engine.pause();release();await rejected
  assert.equal((await f.engine.getPlaybackInfo()).state,'paused')
  assert.notEqual((await f.engine.getPlaybackInfo()).autoMixState,'mixing')
  assert.equal(f.requests.some(r=>r.kind==='prepare'||r.kind==='submit'),false)
  await f.engine.close()
})

test('unconfirmed AutoMix cancellation independently silences both outputs and remains failed until explicit recovery', async () => {
  const f=autoMixFixture();await f.start();await f.select()
  f.b.autoMix!.cancel=async()=>false
  await assert.rejects(f.engine.cancelAutoMix(),/停音未确认|撤销未确认/)
  assert.equal(f.engine.state().phase,'failed')
  for(const o of [f.a,f.b])assert.equal(o.values.bridge.receiver!.timedStart!.state,'disabled')
  f.b.autoMix!.cancel=async()=>true;await f.engine.close()
})

test('group selection will not use an unconfirmed or unitless DSP latency', async () => {
  const f=autoMixFixture();await f.start();f.b.values.dsp.latencySampleRate=undefined
  await assert.rejects(f.select(),/dsp_not_applied/)
  assert.equal(f.requests.some(r=>r.kind==='select'||r.kind==='bind'),false)
  await f.engine.close()
})

test('common source mapping preserves the native 80/20 rate ramp and both endpoints', () => {
  const {plan}=autoMixFixture()
  assert.equal(bridgeAutoMixSourceFrame(plan,0,0),plan.currentStartFrame)
  assert.equal(bridgeAutoMixSourceFrame(plan,0,plan.outputFrames),plan.currentEndFrame)
  assert.equal(bridgeAutoMixSourceFrame(plan,1,plan.outputFrames),plan.nextEndFrame)
  assert.equal(bridgeAutoMixSourceFrame(plan,0,plan.outputFrames*2),plan.currentEndFrame)
})

test('one real Core coordinator analyzes a group once, automatically submits local IDs and cancels an armed plan without deadlock', {timeout:5000}, async t => {
  const f=autoMixFixture(),root=await mkdtemp(join(tmpdir(),'group-automix-service-'))
  const sources=[join(root,'current.wav'),join(root,'next.wav')]
  await Promise.all(sources.map((s,i)=>writeFile(s,`actual-file-identity-${i}`)))
  let coordinator: TwilightAutoMixCoordinator | null=null
  const attach=f.engine.setAutoMixCoordinator.bind(f.engine)
  f.engine.setAutoMixCoordinator=next=>{coordinator=next;attach(next)}
  let analyzed=0
  const service=new CoreAutoMixService({root,engine:f.engine,
    settings:()=>({autoMixStemMode:'off',autoMixStemDevice:'cpu',autoMixStemCacheMiB:512}),
    identities:new ProviderPlaybackIdentityRegistry(),authorize:async source=>source,useSources:action=>action(),now:Date.now,
    environment:async()=>{throw Error('disabled stems cannot inspect an optional runtime')},
    probe:async()=>{throw Error('no probe')},runWorker:async()=>{throw Error('no worker')},
    analysis:{cancel:()=>assert.fail('group analysis must use scoped cancellation'),analyze:async(_source,json)=>{
      analyzed++;const o=JSON.parse(json),duration=o.sourceEndSeconds-o.sourceStartSeconds,start=o.rangeStartSeconds,end=Math.min(start+30,duration)
      return {ok:true,algorithm:'Twilight AutoMix',modelVersion:TWILIGHT_AUTOMIX_MODEL_VERSION,sourceIdentity:o.sourceIdentity,
        coverage:{startSeconds:start,endSeconds:end,durationSeconds:duration,complete:start===0&&end===duration},
        bpm:120,tempoConfidence:.9,rmsDb:-12,peak:.4,key:-1,keyConfidence:0,beats:[],downbeats:[],voice:[],
        frameDb:Array(Math.ceil((end-start)*50)).fill(-12),framePeak:Array(Math.ceil((end-start)*50)).fill(.4)}
    }}})
  t.after(async()=>{await service.shutdown();await f.engine.close();await rm(root,{recursive:true,force:true})})
  await f.engine.setAutoMixMode('natural')
  const items=[{...item(),source:sources[0]},{...item('b','b:1'),source:sources[1],duration:4.005}]
  for(const o of [f.a,f.b]){
    o.values.playback.upcomingTrack=items[1]
    const prepare=o.autoMix!.prepare
    o.autoMix!.prepare=async json=>{const ok=await prepare(json);o.values.playback.autoMixState='ready';return ok}
  }
  await f.engine.loadQueue(items);await f.engine.play(sources[0]);service.activate()
  await coordinator!.idle()
  assert.equal(analyzed,2,'common analysis must not run once per member')
  assert.equal(f.requests.filter(r=>r.kind==='select').length,1)
  assert.equal(f.requests.filter(r=>r.kind==='bind').length,1)
  assert.deepEqual(f.requests.filter(r=>r.kind==='submit').map(r=>r.value),[501,9001])
  assert.equal((await f.engine.getPlaybackInfo()).autoMixState,'ready')
  coordinator!.observe();await coordinator!.idle()
  assert.equal(f.requests.filter(r=>r.kind==='submit').length,2,'observation must not replay the committed plan')
  coordinator!.invalidate('source_changed')
  // The coordinator's own cancel is allowed to silence the armed group, but
  // cannot wait for the promise chain currently executing that cancellation.
  await coordinator!.suspend()
  assert.equal((await f.engine.getPlaybackInfo()).state,'paused')
  for(const o of [f.a,f.b])assert.equal(o.values.bridge.receiver!.timedStart!.state,'disabled')
})

test('group material exports keep native frame domains and IDs; partial optional material never reaches any prepare', async () => {
  const f=autoMixFixture();await f.start()
  const exported:{id:number;rate:number}[]=[],released:number[]=[],seen:unknown[]=[]
  const selection=await f.engine.autoMixMaterials.select('{}',{
    select:async(request,native)=>{const result=await native(request),rate=result.selectionId===101?48000:44100
      exported.push({id:result.selectionId!,rate});return {...result,sampleRate:rate,stemDirectory:`private-${rate}`}},
    release:async member=>{released.push(member!.selectionId!)}
  })
  assert.deepEqual(exported,[{id:101,rate:48000},{id:902,rate:44100}])
  const material=await f.engine.autoMixMaterials.prepare(selection,async member=>{
    seen.push([member.selectionId,member.sampleRate,member.stemDirectory])
    return member.selectionId===902?null:{stemMaterials:{selectionId:member.selectionId}}
  })
  assert.equal(material,null)
  await f.engine.prepareAutoMix(JSON.stringify({selectionId:selection.selectionId}))
  assert.ok(f.requests.filter(r=>r.kind==='prepare').every(r=>r.value.stemMaterials===undefined))
  await f.engine.autoMixMaterials.release(selection)
  assert.deepEqual(released.sort((a,b)=>a-b),[101,902]);assert.equal(seen.length,2)
  await f.engine.close()
})

test('group stems require confirmed enhancement on every prepared native, and failed binding releases completed exports', async () => {
  const f=autoMixFixture();await f.start();const released:number[]=[]
  const exporter={select:async(json:string,native:(v:string)=>Promise<any>)=>native(json),release:async(s:any)=>{released.push(s.selectionId)}}
  const selection=await f.engine.autoMixMaterials.select('{}',exporter)
  const material=await f.engine.autoMixMaterials.prepare(selection,async member=>({stemMaterials:{selectionId:member.selectionId}}))
  await f.engine.prepareAutoMix(JSON.stringify({selectionId:selection.selectionId,...material}))
  f.a.values.playback.autoMixState=f.b.values.playback.autoMixState='ready'
  f.a.values.playback.autoMixStemEnhanced=true;f.b.values.playback.autoMixStemEnhanced=false
  const status=await f.engine.getAutoMixNativeStatus()
  assert.equal(status.autoMixState,'degraded');assert.equal(status.autoMixReason,'group_stems_binding_failed')
  assert.equal(f.requests.some(r=>r.kind==='submit'),false)
  await f.engine.autoMixMaterials.release(selection);assert.deepEqual(released.sort((a,b)=>a-b),[101,902])
  await f.engine.pause();await f.engine.play(item().source)
  released.length=0;f.b.autoMix!.bind=async()=>{throw Error('member bind failed')}
  await assert.rejects(f.engine.autoMixMaterials.select('{}',exporter),/member bind failed/)
  assert.deepEqual(released,[101],'successful exports cannot leak when another binding throws')
  await f.engine.close()
})

test('next-source invalidation is normal only after the exact private promotion marker', async () => {
  for(const marker of [true,false]){
    const f=autoMixFixture();await f.start();const selected=await f.select();await f.prepare(selected.selectionId!);await f.ready()
    await f.engine.submitAutoMix(selected.selectionId!)
    for(const o of [f.a,f.b]){
      if(marker)promote(o,'b:1')
      o.values.playback.autoMixState='degraded';o.values.playback.autoMixReason='next_source_changed'
    }
    const status=await f.engine.getAutoMixNativeStatus()
    if(marker)assert.equal(status.autoMixState,'mixing')
    else assert.equal(f.engine.state().phase,'failed')
    await f.engine.close()
  }
})
