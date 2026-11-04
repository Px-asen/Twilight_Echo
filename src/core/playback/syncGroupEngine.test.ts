import assert from 'node:assert/strict'
import test from 'node:test'
import { SyncGroupEngine, type SyncGroupOutput, type SyncGroupOutputState } from './syncGroupEngine.ts'
import { createDefaultPlaybackInfo } from '../audio/audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../../shared/audioOutputConfig.ts'
import type { AudioEngineQueueItem } from '../../shared/audioEngineTypes.ts'
import { CorePlaybackSession, type CorePlaybackSessionOptions } from './session.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'

const initial = () => createDefaultPlaybackInfo('wasapi', 'explicit-fixture', true, normalizeOutputConfig())
const item = (id = 'a', entry = 'a:1'): AudioEngineQueueItem => ({ id, queueEntryId: entry, source: `C:/${id}.flac`, duration: 10, logicalQueueEnd: true })
function fixture() {
  let now = 10000, token = 0
  let scheduled: (() => void) | null = null
  const calls: string[] = []
  class Output implements SyncGroupOutput {
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

async function sharedSession(t: test.TestContext) {
  const f = fixture(), db = new LibraryDatabase(':memory:')
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
