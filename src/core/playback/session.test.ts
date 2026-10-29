import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  CorePlaybackSession,
  type CorePlaybackEngine,
  type CoreSessionRepository,
  type CorePlaybackSessionOptions
} from './session.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { createDefaultPlaybackInfo } from '../../main/audio/audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../../shared/audioOutputConfig.ts'
import type {
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  PlayMode
} from '../../shared/audioEngineTypes.ts'
import type { NativeQueueRebind } from '../../shared/nativeQueue.ts'
import type { SourceResolver } from './sourceResolver.ts'
import type { PersonalizedProviders } from './personalizedQueue.ts'
import type { HeartProviders } from './heartQueue.ts'
import type { PlaybackSessionData } from '../../shared/playbackSession.ts'
import type { TrackData } from '../../shared/track.ts'
import { captureQueueSession, captureLibraryQueueSession } from '../workspace/tracks.ts'
import { resolveQueueSession } from '../workspace/restoration.ts'
import { libraryQueueTrack } from './libraryTrack.ts'
import type { PlaybackSourceRecovery } from './sourceRecovery.ts'
import { SourceResources } from './sourceResources.ts'
import { CoreCastService } from '../cast/service.ts'
import { RemoteHttpServer } from '../cast/httpServer.ts'
import type { CastDevice, CastLoadRequest, CastSample } from '../cast/castBackend.ts'
import { CoreSleepTimer } from './sleepService.ts'
import { createPlaybackSourceRecovery } from './sourceRecovery.ts'
import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'

test('Focus paged source owner receives one adoption receipt before native acknowledgement and none on preparation failure', async t => {
  const f = await fixture(t)
  let adopted = 0
  await f.session.fromPages(async append => append([{ id: 'a' }]), { onAdopt: () => { adopted++ } })
  assert.equal(adopted, 1)
  const previous = f.session.snapshot().queue?.id
  await assert.rejects(f.session.fromPages(async () => { throw new Error('cancel before publication') }, { onAdopt: () => { adopted++ } }), /cancel before publication/)
  assert.equal(adopted, 1)
  assert.equal(f.session.snapshot().queue?.id, previous)
  f.engine.play = async () => {
    assert.equal(adopted, 2, 'receipt observes the actual owner before a native failure')
    return { nativeStarted: false, fallbackReason: 'native acknowledgement failed' }
  }
  await assert.rejects(f.session.fromPages(async append => append([{ id: 'b' }]), { onAdopt: () => { adopted++ } }), /native acknowledgement failed/)
  assert.equal(adopted, 2)
  assert.notEqual(f.session.snapshot().queue?.id, previous)
})

async function castFixture(
  t: test.TestContext,
  options: {
    resolver?: SourceResolver
    personalized?: PersonalizedProviders
    heart?: HeartProviders
    fatal?: (error: Error) => void
    observePlayback?: CorePlaybackSessionOptions['observePlayback']
    sleepTimer?: CoreSleepTimer
    automaticPlaybackAllowed?: CorePlaybackSessionOptions['automaticPlaybackAllowed']
  } = {}
) {
  const resources = new SourceResources()
  const loads: CastLoadRequest[] = [],
    commands: string[] = [],
    sources: string[] = []
  let timer: (() => void) | null = null
  let sample: CastSample = { state: 'stopped', position: 0, duration: 60 }
  let loadError: Error | null = null,
    stopError: Error | null = null
  const device: CastDevice = {
    id: 'loopback-device',
    protocol: 'dlna',
    friendlyName: 'Test output',
    manufacturer: 'Test',
    modelName: 'Fake',
    location: 'http://127.0.0.1/device',
    avTransportUrl: 'http://127.0.0.1/control',
    renderingControlUrl: null,
    lastSeenAt: 0
  }
  const cast = new CoreCastService({
    resources,
    media: new RemoteHttpServer({
      staticRoot: '',
      addresses: () => ['127.0.0.1'],
      useSource: (action) => resources.use(action)
    }),
    authorizeFile: async (source) => source,
    backend: {
      discover: async () => [device],
      load: async (_device, request) => {
        assert.equal(f.engine.info.state, 'stopped', 'local audio stopped before remote LOAD')
        loads.push(request)
        if (loadError) throw loadError
        sample = {
          state: request.autoplay ? 'playing' : 'paused',
          position: request.positionSeconds ?? 0,
          duration: 60
        }
      },
      sample: async () => ({ ...sample }),
      control: async (_device, command, value) => {
        commands.push(command)
        if (command === 'stop' && stopError) throw stopError
        if (command === 'stop') sample = { ...sample, state: 'stopped' }
        if (command === 'play') sample = { ...sample, state: 'playing' }
        if (command === 'pause') sample = { ...sample, state: 'paused' }
        if (command === 'seek') sample = { ...sample, position: value! }
        if (command === 'volume') sample = { ...sample, volume: value! }
      }
    },
    changed: () => {},
    observe: (value, revision) => session.observeCast(value, revision),
    failed: (error, revision) => session.castFailed(error, revision),
    schedule: (callback) => {
      timer = callback
      return () => {
        timer = null
      }
    }
  })
  const f = await fixture(
    t,
    options.resolver ?? {
      resolve: async (track) => {
        const source =
          (track as TrackData).source === 'local'
            ? (track as TrackData).filePath
            : `https://audio.test/${(track as TrackData).id}?generation=${sources.length}`
        sources.push(source)
        return { source, expiresAt: null }
      }
    },
    options.fatal,
    options.observePlayback,
    options.personalized,
    options.heart,
    undefined,
    resources,
    undefined,
    cast,
    {
      ...(options.sleepTimer ? {
          sleepTimer: options.sleepTimer,
          naturalBoundary: (boundary: 'trackEnd' | 'queueEnd', at: number) => options.sleepTimer!.boundary(boundary, at)
        } : {}),
      automaticPlaybackAllowed: options.automaticPlaybackAllowed
    }
  )
  const session = f.session
  await cast.discover()
  // Always clear injected failures before the fixture's normal durable shutdown.
  t.after(() => {
    stopError = null
    loadError = null
  })
  return {
    ...f,
    cast,
    loads,
    commands,
    sources,
    start: () =>
      session.startCast({
        revision: cast.state().revision,
        deviceId: device.id,
        queue: session.snapshot().queue! as { id: string; revision: number; occurrenceId: string }
      }),
    fire: async (value: CastSample) => {
      sample = value
      const callback = timer
      timer = null
      callback?.()
      await tick()
      await session.flush()
      await tick()
    },
    failLoad: () => {
      loadError = new Error('Remote LOAD reply lost')
    },
    failStop: () => {
      stopError = new Error('Remote Stop not acknowledged')
    },
    resetFailures: () => {
      stopError = null
      loadError = null
    }
  }
}

test('Cast uses the same occurrence and real cursor, routes transport remotely and returns to local only on explicit Play', async (t) => {
  const f = await castFixture(t)
  const track = {
    ...recommended(1),
    id: 'local:one',
    source: 'local',
    filePath: 'D:/Music/one.flac'
  }
  await f.session.fromTrack(track, 23)
  const occurrence = f.session.snapshot().queue!.occurrenceId
  await f.start()
  const nativeCalls = transportCalls(f.engine)
  assert.equal(f.loads.length, 1)
  assert.equal(f.loads[0].positionSeconds, 23)
  assert.equal(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.session.snapshot().playback?.outputBackend, 'cast')
  assert.equal(f.session.snapshot().playback?.nativePlaybackActive, false)
  await f.session.pause()
  await f.session.seek(31)
  await f.session.setVolume(0.3)
  await f.session.play()
  assert.deepEqual(
    f.commands.filter((command) => command !== 'stop'),
    ['pause', 'seek', 'volume', 'play']
  )
  assert.deepEqual(transportCalls(f.engine), nativeCalls)
  f.engine.emit('playback-info', { ...f.engine.info, state: 'playing', position: 999 })
  await tick()
  assert.equal(f.session.snapshot().playback?.position, 31)
  await f.session.endCast(f.cast.state().revision)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().playback?.position, 31)
  assert.deepEqual(transportCalls(f.engine), nativeCalls)
  await f.session.play()
  assert.equal(f.engine.info.position, 31)
  assert.equal(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 2)
})

test('Cast validates discovery, queue revision and occurrence before touching the local output', async (t) => {
  const f = await castFixture(t)
  await f.session.fromTrack(recommended(1))
  const queue = f.session.snapshot().queue! as {
    id: string
    revision: number
    occurrenceId: string
  }
  const before = [...transportCalls(f.engine)]
  const command = { revision: f.cast.state().revision, deviceId: 'loopback-device', queue }
  await assert.rejects(f.session.startCast({ ...command, deviceId: 'not-discovered' }), /not found/)
  await assert.rejects(
    f.session.startCast({ ...command, queue: { ...queue, revision: queue.revision + 1 } }),
    { code: 'STALE_REVISION' }
  )
  await assert.rejects(
    f.session.startCast({ ...command, queue: { ...queue, occurrenceId: 'different' } }),
    { code: 'STALE_REVISION' }
  )
  assert.deepEqual(transportCalls(f.engine), before)
  assert.equal(f.loads.length, 0)
})

test('Cast queue edits and undo keep duplicate occurrences; selected removal stays paused until Play', async (t) => {
  const f = await castFixture(t)
  await f.session.fromPages(async (append) =>
    append([1, 1, 2].map((id) => ({ id: `ncm:${id}`, snapshot: { ...recommended(id) } })))
  )
  await f.start()
  let queue = f.session.snapshot().queue!
  const rows = f.db.readLibraryQueue(queue.id).items
  await f.session.select({ ...queue, index: 1, occurrenceId: rows[1].queueEntryId })
  assert.equal(f.session.snapshot().queue?.occurrenceId, rows[1].queueEntryId)
  assert.equal(f.loads.length, 2)
  queue = f.session.snapshot().queue!
  await f.session.edit(queue.id, queue.revision, {
    kind: 'remove',
    entryIds: [rows[1].queueEntryId]
  })
  assert.equal(f.loads.length, 2)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().playback?.outputBackend, 'cast')
  queue = f.session.snapshot().queue!
  await f.session.edit(queue.id, queue.revision, { kind: 'undo' })
  assert.deepEqual(
    f.db.readLibraryQueue(queue.id).items.map((row) => row.queueEntryId),
    rows.map((row) => row.queueEntryId)
  )
  await f.session.play()
  assert.equal(f.loads.length, 3)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
})

test('Cast EOF advances once with a refreshed source, repeat reloads the same occurrence, external Stop never advances', async (t) => {
  const f = await castFixture(t)
  await f.session.fromPages(async (append) =>
    append([1, 2].map((id) => ({ id: `ncm:${id}`, snapshot: { ...recommended(id) } })))
  )
  await f.start()
  const first = f.session.snapshot().queue!
  const revision = f.cast.state().revision
  await f.fire({ state: 'stopped', position: 60, duration: 60, ended: true })
  assert.equal(f.loads.length, 2)
  const next = f.session.snapshot().queue!
  assert.notEqual(next.occurrenceId, first.occurrenceId)
  f.session.observeCast({ state: 'stopped', position: 60, duration: 60, ended: true }, revision)
  await tick()
  assert.equal(f.loads.length, 2)
  await f.session.setMode('repeat')
  await f.fire({ state: 'stopped', position: 60, duration: 60, ended: true })
  assert.equal(f.loads.length, 3)
  assert.equal(f.session.snapshot().queue?.occurrenceId, next.occurrenceId)
  assert.equal(new Set(f.sources).size, f.sources.length, 'every LOAD resolves the source again')
  await f.fire({ state: 'stopped', position: 8, duration: 60, ended: true })
  assert.equal(f.loads.length, 3)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
})

test('Core sleep EOF stops Cast before successor LOAD and persists only the armed timer', async (t) => {
  const timer = new CoreSleepTimer({
    settings: () => ({ defaultMinutes: 30, fadeSeconds: 0 }),
    now: () => 1000,
    timers: { setInterval, clearInterval, setTimeout, clearTimeout },
    playback: {
      read: () => session.snapshot().playback!,
      quiesce: () => session.quiesceForSleep(),
      setGain: (gain) => session.setSleepTimerGain(gain),
      stop: (current) => session.stopForSleep(current),
      resumeMaintenance: () => session.resumeAfterSleep(),
      persist: () => session.flush()
    },
    changed: () => {},
    failed: (error) => assert.fail(String(error))
  })
  const f = await castFixture(t, { sleepTimer: timer })
  const session = f.session
  timer.activate()
  await session.fromPages(async (append) =>
    append([1, 2].map((id) => ({ id: `ncm:${id}`, snapshot: { ...recommended(id) } })))
  )
  await f.start()
  await timer.configure({ revision: 0, mode: 'trackEnd' }, new AbortController().signal)
  assert.equal((await f.repository.load())?.data?.sleepTimer?.active, true)
  const occurrence = session.snapshot().queue!.occurrenceId
  await f.fire({ state: 'stopped', position: 60, duration: 60, ended: true })
  await tick()
  await timer.flush()
  assert.equal(timer.state().timer?.shutdownOwner, 'core')
  assert.equal(session.snapshot().playback?.state, 'stopped')
  assert.equal(session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.loads.length, 1)
  assert.equal((await f.repository.load())?.data?.sleepTimer, undefined)
  await session.play()
  assert.equal(timer.state().timer, null)
  assert.equal(f.loads.length, 2)
  await timer.shutdown()
})

test('temporary Cast attenuation does not replace the logical user volume or saved local preference', async (t) => {
  const f = await castFixture(t)
  await f.session.fromTrack(recommended(1))
  await f.start()
  const localVolume = f.engine.info.volume
  await f.session.setVolume(0.6)
  await f.session.setSleepTimerGain(0.5)
  await f.fire({ state: 'playing', position: 10, duration: 60, volume: 0.3 })
  assert.equal(f.session.snapshot().playback?.volume, 0.6)
  await f.session.setSleepTimerGain(1)
  await f.fire({ state: 'playing', position: 11, duration: 60, volume: 0.6 })
  assert.equal(f.session.snapshot().playback?.volume, 0.6)
  assert.equal(f.engine.info.volume, localVolume)
})

test('Pause cancels slow Cast successor resolution and stale completion cannot stop a newer playing intent', async (t) => {
  let slow = false,
    started!: () => void,
    release!: () => void
  const preparing = new Promise<void>((resolve) => {
    started = resolve
  })
  const f = await castFixture(t, {
    resolver: {
      resolve: async (track) => {
        if (slow) {
          slow = false
          started()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { source: `https://audio.test/${(track as TrackData).id}`, expiresAt: null }
      }
    }
  })
  await f.session.fromPages(async (append) =>
    append([1, 2].map((id) => ({ id: `ncm:${id}`, snapshot: { ...recommended(id) } })))
  )
  await f.start()
  slow = true
  f.session.observeCast(
    { state: 'stopped', position: 60, duration: 60, ended: true },
    f.cast.state().revision
  )
  await preparing
  await f.session.pause()
  await f.session.play()
  const before = [...f.commands]
  release()
  await tick()
  assert.deepEqual(f.commands, before)
  assert.equal(f.loads.length, 1)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
})

test('Cast heart entry and exit are queue-only handoffs; a detached recommendation finishes into the base queue', async (t) => {
  const f = await castFixture(t, { heart: heartProvider() })
  await f.session.startLiked({ selectedId: 'ncm:2' })
  await f.start()
  const initial = f.session.snapshot()
  const calls = [...transportCalls(f.engine)]
  await f.session.setMode('heart')
  assert.equal(f.loads.length, 1)
  assert.equal(f.session.snapshot().queue?.occurrenceId, initial.queue?.occurrenceId)
  await f.session.navigate(1)
  assert.equal(f.loads.length, 2)
  const recommendation = f.session.snapshot().track?.id
  await f.session.setMode('sequential')
  assert.equal(f.session.snapshot().track?.id, recommendation)
  assert.equal(f.loads.length, 2)
  await f.fire({ state: 'stopped', position: 60, duration: 60, ended: true })
  assert.equal(f.loads.length, 3)
  assert.ok(['ncm:1', 'ncm:2', 'ncm:3'].includes(f.session.snapshot().track!.id))
  assert.deepEqual(transportCalls(f.engine), calls)
})

test('Cast observations refill FM in the background without native queue writes or extra remote LOAD', async (t) => {
  let calls = 0
  const f = await castFixture(t, {
    personalized: {
      supportedMethods: () => ['fetchPersonalFm'],
      call: async () => (++calls === 1 ? [1, 2, 3, 4] : [5, 6, 7]).map(recommended)
    }
  })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  await f.start()
  const native = transportCalls(f.engine)
  await f.session.navigate(1)
  await tick()
  await f.session.flush()
  assert.equal(f.session.snapshot().queue?.total, 7)
  assert.equal(calls, 2)
  assert.equal(f.loads.length, 2)
  assert.deepEqual(transportCalls(f.engine), native)
})

test('Cast natural completion retains the end position and boundary for statistics, bookmarks and podcast observers', async (t) => {
  const observations: Array<{
    id: string | undefined
    position: number
    serial: number | undefined
  }> = []
  const f = await castFixture(t, {
    observePlayback: (track, info) =>
      observations.push({
        id: track?.id,
        position: info.position,
        serial: info.naturalBoundaries?.trackSerial
      })
  })
  await f.session.fromPages(async (append) =>
    append([1, 2].map((id) => ({ id: `ncm:${id}`, snapshot: { ...recommended(id) } })))
  )
  await f.start()
  await f.fire({ state: 'playing', position: 59, duration: 60 })
  await f.fire({ state: 'stopped', position: 0, duration: 60, ended: true })
  assert.ok(
    observations.some((row) => row.id === 'ncm:1' && row.position === 60 && row.serial === 1)
  )
  assert.equal(f.loads.length, 2)
})

test('Cast unknown LOAD is not replayed or routed locally; unconfirmed remote Stop reaches main supervision', async (t) => {
  const fatal: Error[] = []
  const f = await castFixture(t, { fatal: (error) => fatal.push(error) })
  await f.session.fromTrack(recommended(1))
  f.failLoad()
  await assert.rejects(f.start(), /LOAD reply lost/)
  assert.equal(f.loads.length, 1)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
  f.resetFailures()
  await f.session.play()
  f.failStop()
  await assert.rejects(f.session.stop(), /Cannot confirm audio stopped/)
  assert.equal(fatal.length, 1)
  f.resetFailures()
})

test('Cast shutdown persists the real remote cursor and cold recovery stays paused with no remote or native replay', async (t) => {
  const f = await castFixture(t)
  await f.session.fromTrack(recommended(1))
  await f.start()
  await f.fire({ state: 'playing', position: 37, duration: 60 })
  const occurrence = f.session.snapshot().queue?.occurrenceId
  await f.session.shutdown()
  const before = [...transportCalls(f.engine)]
  const cold = f.create()
  await cold.initialize()
  assert.equal(cold.snapshot().playback?.state, 'paused')
  assert.equal(cold.snapshot().playback?.position, 37)
  assert.equal(cold.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.cast.state().phase, 'idle')
  assert.equal(f.loads.length, 1)
  assert.deepEqual(transportCalls(f.engine), before)
  await cold.shutdown()
})

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function heartProvider(
  recommend: (
    seed: { songId: number; playlistId: number; startSongId: number; count: number },
    signal: AbortSignal
  ) => Promise<TrackData[]> = async () => [10, 11, 12, 13].map(recommended)
): HeartProviders {
  return {
    call: async (method, args, signal) => {
      if (method === 'fetchUserLibrary') return { likedPlaylist: { id: 123 } }
      if (method === 'fetchLikedTracksPage')
        return { tracks: [1, 2, 3].map(recommended), nextOffset: 3, hasMore: false, total: 3 }
      return recommend(args[0] as Parameters<typeof recommend>[0], signal)
    }
  }
}
async function heartFixture(t: test.TestContext, provider = heartProvider()) {
  return fixture(
    t,
    {
      resolve: async (track) => ({
        source: `https://audio.test/${(track as TrackData).id}`,
        expiresAt: null
      })
    },
    undefined,
    undefined,
    undefined,
    provider
  )
}
const transportCalls = (engine: Engine) =>
  engine.calls.filter((call) => ['pause', 'stop', 'play', 'loadQueue', 'seek'].includes(call))

function abCommand(
  session: CorePlaybackSession,
  action: 'a' | 'b' | 'toggle' | 'clear',
  position?: number
) {
  const { revision, occurrenceId } = session.snapshot().abLoop
  return session.configureAbLoop({ revision, occurrenceId: occurrenceId!, action, position })
}
async function observeAt(f: Awaited<ReturnType<typeof fixture>>, position: number) {
  f.engine.info.position = position
  f.engine.emit('playback-info', f.engine.info)
  await tick()
  await f.session.flush()
}
test('native position-only samples update Core and its business observers without any renderer', async (t) => {
  const observed: number[] = []
  const f = await fixture(t, undefined, undefined, (_track, info) => observed.push(info.position))
  await f.session.fromQuery({}, 'a')
  const occurrence = f.session.snapshot().queue!.occurrenceId
  const calls = [...transportCalls(f.engine)]
  f.engine.info = { ...f.engine.info, position: 12.5 }
  f.engine.emit('playback-sample', f.engine.info)
  await tick()
  await f.session.flush()
  assert.equal(f.session.snapshot().playback?.position, 12.5)
  assert.equal(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(observed.at(-1), 12.5)
  assert.deepEqual(transportCalls(f.engine), calls)
})
test('Core AB rules, soft tolerance and reconnect snapshots retain one owner', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  await abCommand(f.session, 'b', 0)
  assert.equal(f.session.snapshot().abLoop.a, 0)
  assert.equal(f.session.snapshot().abLoop.b, null)
  await abCommand(f.session, 'a', 3)
  await abCommand(f.session, 'b', 5)
  assert.equal(f.session.snapshot().abLoop.mode, 'soft')
  await observeAt(f, 4.97)
  assert.equal(f.engine.calls.filter((c) => c === 'seek').length, 0)
  await observeAt(f, 4.99)
  assert.equal(f.engine.calls.filter((c) => c === 'seek').length, 1)
  assert.equal(f.engine.info.position, 3)
  const calls = [...f.engine.calls]
  const state = f.session.snapshot().abLoop
  state.a = 123
  assert.equal(f.session.snapshot().abLoop.a, 3)
  assert.deepEqual(f.engine.calls, calls)
  await abCommand(f.session, 'a', 6)
  assert.equal(f.session.snapshot().abLoop.b, null)
  await abCommand(f.session, 'toggle', 9)
  assert.equal(f.session.snapshot().abLoop.b, 9)
  await abCommand(f.session, 'toggle')
  assert.equal(f.session.snapshot().abLoop.mode, 'off')
})
test('Core AB prefers acknowledged native loop and fences concurrent revisions and stale occurrences', async (t) => {
  const f = await fixture(t)
  f.engine.nativeLoop = true
  await f.session.fromQuery({}, 'a')
  await abCommand(f.session, 'a', 2)
  const state = f.session.snapshot().abLoop
  const command = {
    revision: state.revision,
    occurrenceId: state.occurrenceId!,
    action: 'b' as const,
    position: 4
  }
  const result = await Promise.allSettled([
    f.session.configureAbLoop(command),
    f.session.configureAbLoop(command)
  ])
  assert.deepEqual(
    result.map((r) => r.status),
    ['fulfilled', 'rejected']
  )
  assert.equal(f.session.snapshot().abLoop.mode, 'native')
  await observeAt(f, 5)
  assert.equal(f.engine.calls.filter((c) => c === 'seek').length, 0)
  await assert.rejects(
    f.session.configureAbLoop({
      ...command,
      revision: f.session.snapshot().abLoop.revision,
      occurrenceId: 'old'
    }),
    { code: 'STALE_REVISION' }
  )
  const loop = f.session.snapshot().abLoop
  await f.session.setMode('repeat')
  assert.deepEqual(f.session.snapshot().abLoop, loop)
  await f.session.stop()
  assert.equal(f.session.snapshot().abLoop.mode, 'off')
  assert.equal(f.engine.calls.at(-2), 'loop:-1:-1')
})
test('Core AB clears on duplicate occurrences, CUE changes, named restore and cold restore', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a', 'a', 'b'], sort: 'playlist' }, undefined)
  const first = f.session.snapshot().abLoop.occurrenceId
  await abCommand(f.session, 'a', 2)
  await abCommand(f.session, 'b', 4)
  await f.session.navigate(1)
  assert.notEqual(f.session.snapshot().abLoop.occurrenceId, first)
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.session.snapshot().abLoop.a, null)
  await abCommand(f.session, 'a', 2)
  await f.session.navigate(1)
  assert.equal(f.session.snapshot().track?.id, 'b')
  assert.equal(f.session.snapshot().abLoop.a, null)
  await abCommand(f.session, 'a', 2)
  await abCommand(f.session, 'b', 4)
  await f.session.flush()
  await f.session.shutdown()
  const restored = f.create()
  await restored.initialize()
  assert.equal(restored.snapshot().abLoop.mode, 'off')
  assert.equal(restored.snapshot().playback?.state, 'paused')
  await restored.shutdown()
})
test('Core AB disables radio/live HTTP but permits finite podcasts', async (t) => {
  const f = await fixture(t)
  for (const track of [
    { ...recommended(1), source: 'radio', duration: 60 },
    {
      ...recommended(2),
      duration: 0,
      filePath: 'https://audio.test/live',
      streamUrl: 'https://audio.test/live'
    }
  ] as TrackData[]) {
    await f.session.fromTrack(track)
    await abCommand(f.session, 'a', 2)
    assert.equal(f.session.snapshot().abLoop.a, null)
  }
  await f.session.fromTrack({ ...recommended(3), source: 'podcast', duration: 60 })
  await abCommand(f.session, 'toggle', 2)
  await abCommand(f.session, 'toggle', 4)
  assert.equal(f.session.snapshot().abLoop.mode, 'soft')
})
test('Core AB lost native ACK stops without a soft seek or command replay', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  await abCommand(f.session, 'a', 2)
  let calls = 0
  f.engine.setLoopRangeConfirmed = async () => {
    calls++
    throw new Error('Loop reply lost')
  }
  await assert.rejects(abCommand(f.session, 'b', 4), /Loop reply lost/)
  assert.equal(calls, 1)
  assert.equal(f.session.snapshot().abLoop.mode, 'off')
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  await observeAt(f, 5)
  assert.equal(calls, 1)
  assert.equal(f.engine.calls.filter((c) => c === 'seek').length, 0)
})
test('Core AB lost soft Seek ACK stops without replay', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  await abCommand(f.session, 'a', 2)
  await abCommand(f.session, 'b', 4)
  let seeks = 0
  f.engine.seekConfirmed = async () => {
    seeks++
    throw new Error('Seek reply lost')
  }
  await observeAt(f, 5)
  assert.equal(seeks, 1)
  assert.equal(f.session.snapshot().abLoop.mode, 'off')
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
})
test('Pause invalidates an in-flight AB observation before it can seek', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  await abCommand(f.session, 'a', 2)
  await abCommand(f.session, 'b', 4)
  await tick()
  const original = f.engine.getPlaybackInfo.bind(f.engine)
  let release!: () => void
  let entered!: () => void
  const pending = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.engine.getPlaybackInfo = async () => {
    f.engine.getPlaybackInfo = original
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return original()
  }
  f.engine.info.position = 5
  f.engine.emit('playback-info', f.engine.info)
  await pending
  const pause = f.session.pause()
  release()
  await pause
  assert.equal(f.engine.calls.filter((c) => c === 'seek').length, 0)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
})
test('Core mute restores the last audible volume across projections and serialized toggles', async (t) => {
  const f = await fixture(t)
  await f.session.fromTrack(
    libraryQueueTrack(f.db.getTracksByIds(['a']).tracks[0], 'temporary'),
    0,
    false
  )
  await f.session.setVolume(0.42)
  await f.session.configureMute()
  assert.deepEqual(f.session.snapshot().mute, {
    muted: true,
    userVolume: 0,
    lastAudibleVolume: 0.42
  })
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  await f.session.configureMute()
  assert.deepEqual(f.session.snapshot().mute, {
    muted: false,
    userVolume: 0.42,
    lastAudibleVolume: 0.42
  })
  await f.session.setVolume(0)
  await f.session.configureMute()
  assert.equal(f.session.snapshot().mute.userVolume, 0.42)
  await Promise.all([f.session.configureMute(), f.session.configureMute()])
  assert.equal(f.session.snapshot().mute.userVolume, 0.42)
  await f.session.configureMute(true)
  await f.session.setVolume(0.3)
  assert.deepEqual(f.session.snapshot().mute, {
    muted: false,
    userVolume: 0.3,
    lastAudibleVolume: 0.3
  })
})
test('Core system controls serialize volume steps and mode cycles without stale client snapshots', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  await f.session.setVolume(0.4)
  await Promise.all([
    f.session.control({ type: 'volume-step', direction: 'volumeUp' }),
    f.session.control({ type: 'volume-step', direction: 'volumeUp' })
  ])
  assert.equal(f.session.snapshot().mute.userVolume, 0.5)
  await Promise.all([
    f.session.control({ type: 'cycle-play-mode' }),
    f.session.control({ type: 'cycle-play-mode' })
  ])
  assert.equal(f.session.snapshot().playback?.playMode, 'repeat')
  const first = f.session.control({ type: 'toggle-play' })
  const second = f.session.control({ type: 'toggle-play' })
  await Promise.all([first, second])
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.session.snapshot().loading, false)
})
test('Core query preparation applies the selected position and mode in the initial load without a follow-up Seek', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ sort: 'title' }, 'b', true, undefined, {
    position: 12.5,
    playMode: 'repeat'
  })
  assert.equal(f.session.snapshot().track?.id, 'b')
  assert.equal(f.session.snapshot().playback?.position, 12.5)
  assert.equal(f.session.snapshot().playback?.playMode, 'repeat')
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'seek').length, 0)
})
test('Core query random start chooses a durable occurrence, while an explicit selected identity wins', async (t) => {
  const f = await fixture(t)
  t.mock.method(Math, 'random', () => 0.75)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, undefined, true, undefined, {
    randomStart: true,
    playMode: 'sequential'
  })
  const first = f.session.snapshot()
  assert.equal(first.track?.id, 'b')
  assert.equal(first.queue?.index, 1)
  assert.equal(first.playback?.playMode, 'sequential')
  assert.equal(f.db.getLibraryQueue(first.queue!.id)!.selectedEntryId, first.queue?.occurrenceId)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a', true, undefined, {
    randomStart: true,
    position: 8,
    playMode: 'shuffle'
  })
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.session.snapshot().playback?.position, 8)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.session.snapshot().playback?.playMode, 'shuffle')
})
test('Core loading follows source preparation, Pause cancels it immediately, and an old completion cannot clear a new preparation', async (t) => {
  const f = await fixture(t)
  const first = deferred<TrackData>(),
    second = deferred<TrackData>()
  const old = f.session.fromTrack(() => first.promise)
  const oldRejected = assert.rejects(old, /superseded/)
  assert.equal(f.session.snapshot().loading, true)
  const pause = f.session.control({ type: 'toggle-play' })
  assert.equal(f.session.snapshot().loading, false)
  await pause
  const next = f.session.fromTrack(() => second.promise)
  assert.equal(f.session.snapshot().loading, true)
  first.resolve(recommended(1))
  await oldRejected
  assert.equal(f.session.snapshot().loading, true)
  second.resolve(recommended(2))
  await next
  assert.equal(f.session.snapshot().loading, false)
  assert.equal(f.session.snapshot().track?.id, 'ncm:2')
  assert.equal(f.engine.calls.filter((c) => c === 'play').length, 1)
})
test('Core source failure clears loading without waiting for another window command', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.session.fromTrack(async () => {
      throw new Error('Provider failed')
    }),
    /Provider failed/
  )
  assert.equal(f.session.snapshot().loading, false)
})
test('Core owns stream buffering across clients, refreshes the 1.5s hold on new underruns, and clears on Pause or occurrence changes', async (t) => {
  const scheduled = new Map<() => void, number>()
  const f = await fixture(
    t,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      schedule: (callback, delayMs) => {
        scheduled.set(callback, delayMs)
        return () => {
          scheduled.delete(callback)
        }
      }
    }
  )
  const sample = async (count: number) => {
    f.engine.info.diagnostics = { ...f.engine.info.diagnostics, sessionUnderrunCount: count }
    f.engine.emit('playback-info', f.engine.info)
    await tick()
    await f.session.flush()
  }
  await f.session.fromTrack(recommended(1))
  await sample(1)
  assert.equal(f.session.snapshot().isStreamBuffering, true)
  assert.deepEqual([...scheduled.values()], [1500])
  const oldTimer = [...scheduled.keys()][0]
  await sample(2)
  assert.equal(scheduled.has(oldTimer), false)
  assert.equal(scheduled.size, 1)
  const before = [...f.engine.calls]
  for (let i = 0; i < 10; i++) assert.equal(f.session.snapshot().isStreamBuffering, true)
  assert.deepEqual(f.engine.calls, before)
  ;[...scheduled.keys()][0]()
  scheduled.clear()
  assert.equal(f.session.snapshot().isStreamBuffering, false)
  await sample(3)
  assert.equal(f.session.snapshot().isStreamBuffering, true)
  await f.session.pause()
  assert.equal(f.session.snapshot().isStreamBuffering, false)
  assert.equal(scheduled.size, 0)
  await f.session.play()
  assert.equal(f.session.snapshot().isStreamBuffering, false)
  await sample(4)
  assert.equal(f.session.snapshot().isStreamBuffering, true)
  await f.session.fromQuery({}, 'a')
  assert.equal(f.session.snapshot().isStreamBuffering, false)
  assert.equal(scheduled.size, 0)
  await sample(5)
  assert.equal(
    f.session.snapshot().isStreamBuffering,
    false,
    'local xruns do not become stream buffering'
  )
})
test('Cast AB seeks in Core without native transport and mute keeps the local preference', async (t) => {
  const f = await castFixture(t)
  await f.session.fromTrack({ ...recommended(1), source: 'podcast' })
  await f.start()
  const localVolume = f.engine.info.volume
  await f.session.setVolume(0.4)
  await f.session.configureMute()
  await f.session.configureMute()
  assert.equal(f.session.snapshot().mute.userVolume, 0.4)
  assert.equal(f.engine.info.volume, localVolume)
  await abCommand(f.session, 'a', 2)
  await abCommand(f.session, 'b', 4)
  const native = [...f.engine.calls]
  await f.fire({ state: 'playing', position: 4, duration: 60 })
  assert.equal(f.session.snapshot().playback?.position, 2)
  assert.deepEqual(f.engine.calls, native)
})

test('Core builds the authenticated liked queue in bounded pages, uses the provider cursor and selects an identity on a later page', async (t) => {
  const offsets: number[] = []
  const provider = heartProvider(),
    original = provider.call
  provider.call = async (method, args, signal) => {
    if (method !== 'fetchLikedTracksPage') return original(method, args, signal)
    offsets.push(Number(args[0]))
    assert.equal(args[1], 200)
    return args[0] === 0
      ? { tracks: [recommended(1)], nextOffset: 200, hasMore: true }
      : { tracks: [recommended(2), recommended(3)], nextOffset: 202, hasMore: false }
  }
  const f = await heartFixture(t, provider)
  await f.session.startLiked({ selectedId: 'ncm:3', play: false })
  assert.deepEqual(offsets, [0, 200])
  const before = f.session.snapshot()
  assert.equal(before.track?.id, 'ncm:3')
  assert.equal(before.queue?.index, 2)
  assert.equal(before.heart?.available, true)
  assert.equal(before.heart?.active, false)
  assert.equal(f.saved?.data?.heart?.likedPlaylistId, 123)
  assert.doesNotMatch(
    JSON.stringify(f.db.readLibraryQueue(before.queue!.id)),
    /expired.invalid|token=private/
  )
  assert.deepEqual(transportCalls(f.engine), ['pause'])
  await assert.rejects(
    f.session.startLiked({ selectedId: 'ncm:missing', play: false }),
    /unavailable/
  )
  assert.equal(f.session.snapshot().queue?.id, before.queue?.id)
})

test('heart entry and exit preserve the seed decoder, position and occurrence without Pause, Play, Seek or LoadQueue', async (t) => {
  const seeds: unknown[] = []
  const f = await heartFixture(
    t,
    heartProvider(async (seed) => {
      seeds.push(seed)
      return [recommended(1), ...[10, 11, 12, 13].map(recommended)]
    })
  )
  await f.session.startLiked({ selectedId: 'ncm:2' })
  for (let i = 0; i < 10; i++) await tick()
  f.engine.info.position = 19.25
  const before = f.session.snapshot(),
    calls = transportCalls(f.engine)
  await f.session.setMode('heart')
  assert.deepEqual(seeds[0], { songId: 2, playlistId: 123, startSongId: 2, count: 20 })
  assert.equal(f.session.snapshot().playback?.playMode, 'heart')
  assert.equal(f.session.snapshot().queue?.occurrenceId, before.queue?.occurrenceId)
  assert.equal(f.saved?.data?.heart?.baseQueue?.id, before.queue?.id)
  assert.equal(f.engine.info.position, 19.25)
  assert.equal(f.session.snapshot().heart?.active, true)
  assert.deepEqual(transportCalls(f.engine), calls)
  await f.session.setMode('sequential')
  assert.equal(f.session.snapshot().track?.id, 'ncm:2')
  assert.equal(f.session.snapshot().queue?.occurrenceId, before.queue?.occurrenceId)
  assert.equal(f.session.snapshot().queue?.index, 1)
  assert.deepEqual(
    f.db.readLibraryQueue(f.session.snapshot().queue!.id).items.map((row) => row.track?.id),
    ['ncm:1', 'ncm:2', 'ncm:3']
  )
  assert.equal(f.engine.info.position, 19.25)
  assert.equal(f.session.snapshot().heart?.active, false)
  assert.deepEqual(transportCalls(f.engine), calls)
})

test('heart exit restores the exact base while an outside recommendation finishes, then native EOF adopts its first entry', async (t) => {
  const f = await heartFixture(t)
  await f.session.startLiked({})
  await f.session.setMode('heart')
  const queue = f.session.snapshot().queue!
  const row = f.db.readLibraryQueue(queue.id).items[1]
  await f.session.select({
    id: queue.id,
    revision: queue.revision,
    occurrenceId: row.queueEntryId,
    index: 1
  })
  f.engine.info.position = 17
  const before = transportCalls(f.engine)
  await f.session.setMode('sequential')
  assert.equal(f.session.snapshot().track?.id, 'ncm:10')
  assert.equal(f.session.snapshot().queue?.index, 0)
  assert.equal(f.session.snapshot().queue?.total, 3)
  assert.equal(f.engine.info.position, 17)
  assert.equal(f.saved?.data?.detachedHeartTrack, true)
  assert.deepEqual(transportCalls(f.engine), before)
  for (let i = 0; i < 30 && f.engine.items.length < 2; i++) await tick()
  assert.equal(f.engine.items[0].id, 'ncm:10')
  assert.equal(f.engine.items[1]?.id, 'ncm:1')
  const next = f.engine.items[1]
  f.engine.info = { ...f.engine.info, queueIndex: 1, source: next.source, position: 1 }
  f.engine.emit('playback-info', f.engine.info)
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
  assert.equal(f.session.snapshot().queue?.occurrenceId, next.queueEntryId)
  await f.session.flush()
  assert.equal(f.saved?.data?.detachedHeartTrack, undefined)
  assert.deepEqual(transportCalls(f.engine), before)
})

test('heart and detached exit survive cold paused restoration without provider reads or native loads', async (t) => {
  let reads = 0
  const provider = heartProvider(),
    call = provider.call
  provider.call = (...args) => {
    reads++
    return call(...args)
  }
  const f = await heartFixture(t, provider)
  await f.session.startLiked({ play: false })
  await f.session.setMode('heart')
  const heart = f.session.snapshot()
  await f.session.shutdown()
  let cold = f.create()
  await cold.initialize()
  assert.equal(cold.snapshot().heart?.active, true)
  assert.equal(cold.snapshot().playback?.playMode, 'heart')
  assert.equal(cold.snapshot().queue?.occurrenceId, heart.queue?.occurrenceId)
  assert.equal(cold.snapshot().playback?.state, 'paused')
  assert.equal(reads, 3)
  const row = f.db.readLibraryQueue(cold.snapshot().queue!.id).items[1]
  await cold.select({ ...cold.snapshot().queue!, occurrenceId: row.queueEntryId, index: 1 })
  f.engine.info.position = 12
  await cold.setMode('sequential')
  await cold.shutdown()
  const calls = transportCalls(f.engine),
    count = reads
  cold = f.create()
  await cold.initialize()
  assert.equal(cold.snapshot().track?.id, 'ncm:10')
  assert.equal(cold.snapshot().playback?.state, 'paused')
  assert.equal(cold.snapshot().playback?.position, 12)
  assert.deepEqual(transportCalls(f.engine), calls)
  assert.equal(reads, count)
  await cold.play()
  for (let i = 0; i < 20 && f.engine.items.length < 2; i++) await tick()
  assert.equal(f.engine.items[0].id, 'ncm:10')
  assert.equal(f.engine.items[1]?.id, 'ncm:1')
  await cold.shutdown()
})

test('slow heart entry is cancelled by Pause; manual replacement drops the base instead of restoring it', async (t) => {
  const entered = deferred<void>()
  let slow = true
  const f = await heartFixture(
    t,
    heartProvider(async (_seed, signal) => {
      if (!slow) return [10, 11, 12, 13].map(recommended)
      entered.resolve()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    })
  )
  await f.session.startLiked({})
  const queue = f.session.snapshot().queue!,
    calls = transportCalls(f.engine)
  const starting = f.session.setMode('heart'),
    cancelled = assert.rejects(starting, /superseded/)
  await entered.promise
  await f.session.pause()
  await cancelled
  assert.equal(f.session.snapshot().queue?.id, queue.id)
  assert.deepEqual(transportCalls(f.engine), [...calls, 'pause'])
  slow = false
  await f.session.setMode('heart')
  await f.session.fromQuery({}, 'a', false)
  assert.equal(f.session.snapshot().playback?.playMode, 'sequential')
  assert.equal(f.session.snapshot().heart?.available, false)
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.saved?.data?.heart, undefined)
  await assert.rejects(f.session.setMode('heart'), /liked playlist context/)
})

test('heart restoration retains the frozen base order, including shuffle, rather than silently reordering it', async (t) => {
  const f = await heartFixture(t)
  await f.session.setMode('shuffle')
  await f.session.startLiked({ play: false })
  assert.equal(f.session.snapshot().playback?.playMode, 'shuffle')
  assert.equal(f.db.getLibraryQueue(f.session.snapshot().queue!.id).order, 'shuffle')
  const base = f.db.readLibraryQueue(f.session.snapshot().queue!.id).items
  await f.session.setMode('heart')
  await f.session.setMode('sequential')
  assert.deepEqual(
    f.db.readLibraryQueue(f.session.snapshot().queue!.id).items.map((row) => row.queueEntryId),
    base.map((row) => row.queueEntryId)
  )
})

test('heart base restoration keeps mixed CUE occurrences and deleted local holes without hydrating or rewriting them', async (t) => {
  const f = await heartFixture(t)
  await f.session.startLiked({ play: false })
  let queue = f.session.snapshot().queue!
  await f.session.edit(queue.id, queue.revision, { kind: 'insert', trackIds: ['a', 'b', 'a'] })
  queue = f.session.snapshot().queue!
  const base = f.db.readLibraryQueue(queue.id).items
  await f.session.setMode('heart')
  f.db.sql.prepare('DELETE FROM tracks WHERE id=?').run('b')
  await f.session.setMode('sequential')
  const restored = f.db.readLibraryQueue(f.session.snapshot().queue!.id).items
  assert.deepEqual(
    restored.map((row) => row.queueEntryId),
    base.map((row) => row.queueEntryId)
  )
  assert.deepEqual(
    restored.filter((row) => row.track?.id === 'a').map((row) => row.track?.cueRange),
    [base[3].track?.cueRange, base[5].track?.cueRange]
  )
  assert.equal(restored[4].track, null)
})

test('an empty initial heart batch returns to sequential with the frozen base order and no decoder restart', async (t) => {
  const f = await heartFixture(
    t,
    heartProvider(async () => [])
  )
  await f.session.setMode('shuffle')
  await f.session.startLiked({})
  for (let i = 0; i < 10; i++) await tick()
  const base = f.db
    .readLibraryQueue(f.session.snapshot().queue!.id)
    .items.map((row) => row.queueEntryId)
  const before = transportCalls(f.engine)
  await f.session.setMode('heart')
  assert.equal(f.session.snapshot().playback?.playMode, 'sequential')
  assert.equal(f.session.snapshot().heart?.active, false)
  assert.deepEqual(
    f.db.readLibraryQueue(f.session.snapshot().queue!.id).items.map((row) => row.queueEntryId),
    base
  )
  assert.deepEqual(transportCalls(f.engine), before)
})

test('heart refills follow committed occurrences while slow provider IO leaves Pause responsive and late additions cannot play', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  const seeds: number[] = []
  const f = await heartFixture(
    t,
    heartProvider(async (seed) => {
      seeds.push(seed.songId)
      if (seeds.length === 1) return [10, 11, 12, 13].map(recommended)
      entered.resolve()
      await release.promise
      return [13, 20, 20, 21].map(recommended)
    })
  )
  await f.session.startLiked({})
  await f.session.setMode('heart')
  const queue = f.session.snapshot().queue!,
    target = f.db.readLibraryQueue(queue.id).items[3]
  await f.session.select({ ...queue, index: 3, occurrenceId: target.queueEntryId })
  await entered.promise
  assert.deepEqual(seeds, [1, 12])
  await f.session.pause()
  const calls = transportCalls(f.engine)
  release.resolve()
  for (let i = 0; i < 30 && f.session.snapshot().queue!.total < 7; i++) await tick()
  assert.equal(f.session.snapshot().queue?.total, 7)
  assert.equal(f.session.snapshot().queue?.occurrenceId, target.queueEntryId)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.deepEqual(transportCalls(f.engine), calls)
})

test('unknown heart append results stop once, require stopped read recovery and never replay the write', async (t) => {
  let reads = 0,
    writes = 0,
    lose = true
  const f = await heartFixture(
    t,
    heartProvider(async () =>
      (++reads === 1 ? [10, 11, 12, 13] : reads === 2 ? [20] : [21]).map(recommended)
    )
  )
  const extend = f.queues.extendQueue!
  f.queues.extendQueue = async (...args) => {
    writes++
    const result = await extend(...args)
    if (lose) throw new Error('Lost heart append reply')
    return result
  }
  await f.session.startLiked({ play: false })
  await f.session.setMode('heart')
  const queue = f.session.snapshot().queue!
  await assert.rejects(f.session.refillHeart(queue), /Lost heart append/)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.match(f.session.snapshot().heart?.error ?? '', /Lost heart append/)
  await assert.rejects(f.session.refillHeart(queue), /Refresh stopped/)
  assert.equal(writes, 1)
  assert.equal(reads, 2)
  await f.session.refresh()
  assert.equal(f.session.snapshot().playback?.playMode, 'heart')
  assert.equal(f.session.snapshot().queue?.total, 6)
  lose = false
  assert.equal(await f.session.refillHeart(f.session.snapshot().queue!), 1)
  assert.equal(writes, 2)
  assert.equal(reads, 3)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 0)
})

test('native advancement during initial heart recommendations rejects the stale seed without another native load', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  const f = await heartFixture(
    t,
    heartProvider(async () => {
      entered.resolve()
      await release.promise
      return [10, 11, 12, 13].map(recommended)
    })
  )
  await f.session.startLiked({})
  for (let i = 0; i < 20 && f.engine.items.length < 2; i++) await tick()
  const next = f.engine.items[1],
    before = transportCalls(f.engine)
  const start = f.session.setMode('heart'),
    rejected = assert.rejects(start, { code: 'STALE_REVISION' })
  await entered.promise
  f.engine.info = { ...f.engine.info, queueIndex: 1, source: next.source, position: 2 }
  f.engine.emit('playback-info', f.engine.info)
  release.resolve()
  await rejected
  assert.equal(f.session.snapshot().track?.id, next.id)
  assert.equal(f.session.snapshot().heart?.active, false)
  assert.deepEqual(transportCalls(f.engine), before)
})

test('a lost heart rebind reply publishes stopped authority and never retries the handoff', async (t) => {
  const f = await heartFixture(t)
  await f.session.startLiked({})
  for (let i = 0; i < 10; i++) await tick()
  const original = f.engine.rebindQueue.bind(f.engine)
  let writes = 0
  f.engine.rebindQueue = async (request) => {
    writes++
    await original(request)
    throw new Error('Lost heart rebind reply')
  }
  const changes = f.changes
  await assert.rejects(f.session.setMode('heart'), /Lost heart rebind/)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.equal(f.session.snapshot().heart?.active, true)
  assert.ok(f.changes > changes)
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(writes, 1)
  await f.session.refresh()
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().playback?.playMode, 'heart')
  assert.equal(writes, 1)
})

test('Pause during an already-dispatched heart rebind retains its acknowledged occurrence before confirming pause', async (t) => {
  const f = await heartFixture(t)
  await f.session.startLiked({})
  for (let i = 0; i < 10; i++) await tick()
  const original = f.engine.rebindQueue.bind(f.engine)
  const entered = deferred<void>(),
    release = deferred<void>()
  f.engine.rebindQueue = async (request) => {
    const result = await original(request)
    entered.resolve()
    await release.promise
    return result
  }
  const occurrence = f.session.snapshot().queue?.occurrenceId,
    before = transportCalls(f.engine)
  const entering = f.session.setMode('heart')
  await entered.promise
  const pausing = f.session.pause()
  release.resolve()
  await Promise.all([entering, pausing])
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.engine.items[0].queueEntryId, occurrence)
  assert.equal(f.saved?.data?.heart?.queueId, f.session.snapshot().queue?.id)
  assert.deepEqual(transportCalls(f.engine), [...before, 'pause'])
})

function recommended(id: number): TrackData {
  return {
    id: `ncm:${id}`,
    source: 'ncm',
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    duration: 60,
    filePath: 'https://expired.invalid/audio?token=private',
    fileName: '',
    size: 0,
    cover: null,
    lyrics: null,
    ncmSongId: id
  }
}

async function automaticFixture(
  t: test.TestContext,
  allowed: CorePlaybackSessionOptions['automaticPlaybackAllowed'],
  options: {
    tracks?: TrackData[]
    resolver?: SourceResolver
    heart?: HeartProviders
    sources?: PlaybackSourceRecovery
  } = {}
) {
  let tracks = options.tracks ?? [1, 2, 3, 4, 5].map(recommended)
  let requests = 0
  const f = await fixture(
    t,
    options.resolver ?? {
      resolve: async (track) => ({ source: `https://audio.test/${(track as TrackData).id}`, expiresAt: null })
    },
    undefined,
    undefined,
    {
      supportedMethods: () => ['fetchPersonalFm', 'fetchPrivateContent'],
      call: async () => {
        requests++
        return tracks
      }
    },
    options.heart,
    options.sources,
    undefined,
    undefined,
    undefined,
    { automaticPlaybackAllowed: allowed }
  )
  return {
    ...f,
    setTracks: (value: TrackData[]) => { tracks = value },
    get requests() { return requests }
  }
}

function automaticEof(f: { engine: Engine }): void {
  const selected = f.engine.items[f.engine.info.queueIndex]
  f.engine.end = {
    intent: 1,
    selection: {
      queueToken: f.engine.token,
      index: f.engine.info.queueIndex,
      id: selected.id,
      source: selected.source
    }
  }
  f.engine.info = { ...f.engine.info, state: 'stopped', position: 60 }
  f.engine.emit('playback-info', f.engine.info)
}

test('automatic bans filter initial recommendations and refills but retain a named initial selection', async (t) => {
  const banned = new Set(['ncm:1', 'ncm:4'])
  const f = await automaticFixture(t, async (tracks) => tracks.map((track) => !banned.has(track.id)))
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', play: false })
  assert.deepEqual(
    f.db.readLibraryQueue(f.session.snapshot().queue!.id).items.map((row) => row.track!.id).sort(),
    ['ncm:2', 'ncm:3', 'ncm:5']
  )
  f.setTracks([4, 6].map(recommended))
  assert.equal(await f.session.refillPersonalized(f.session.snapshot().queue!), 1)
  await f.session.startPersonalized({
    providerId: 'ncm', key: 'fm', selectedId: 'ncm:4', play: true
  })
  assert.equal(f.session.snapshot().track?.id, 'ncm:4')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
})

test('new bans do not interrupt or reorder an automatic queue; native EOF checks the existing batch again', async (t) => {
  const banned = new Set<string>()
  const f = await automaticFixture(t, async (tracks) => tracks.map((track) => !banned.has(track.id)))
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  await tick()
  const queue = f.session.snapshot().queue!
  const rows = f.db.readLibraryQueue(queue.id).items
  const next = rows[1].track!.id
  banned.add('ncm:1')
  banned.add(next)
  f.engine.emit('playback-info', f.engine.info)
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.engine.items.length, 1, 'recommendations are not native-preloaded')
  assert.deepEqual(f.db.readLibraryQueue(queue.id).items.map((row) => row.queueEntryId), rows.map((row) => row.queueEntryId))
  automaticEof(f)
  for (let i = 0; i < 40 && f.session.snapshot().track?.id === 'ncm:1'; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, rows[2].track!.id)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.engine.items.length, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 2)
})

test('automatic next rechecks after slow source preparation and skips a newly banned candidate', async (t) => {
  const banned = new Set<string>()
  const entered = deferred<void>(), release = deferred<void>()
  let slow = ''
  const f = await automaticFixture(t,
    async (tracks) => tracks.map((track) => !banned.has(track.id)),
    { resolver: { resolve: async (value) => {
      const track = value as TrackData
      if (track.id === slow) { entered.resolve(); await release.promise }
      return { source: `https://audio.test/${track.id}`, expiresAt: null }
    } } }
  )
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  const rows = f.db.readLibraryQueue(f.session.snapshot().queue!.id).items
  slow = rows[1].track!.id
  const next = f.session.navigate(1)
  await entered.promise
  banned.add(slow)
  release.resolve()
  await next
  assert.equal(f.session.snapshot().track?.id, rows[2].track!.id)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 2)
})

test('an all-banned automatic batch stops at EOF without repeated refetches or native replay', async (t) => {
  let deny = false
  const f = await automaticFixture(t, async (tracks) => tracks.map(() => !deny))
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  await tick()
  deny = true
  const requests = f.requests
  automaticEof(f)
  for (let i = 0; i < 30; i++) await tick()
  const after = f.requests
  for (let i = 0; i < 10; i++) { f.engine.emit('playback-info', f.engine.info); await tick() }
  assert.ok(after <= requests + 1)
  assert.equal(f.requests, after)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
})

test('automatic skip inspects at most 100 occurrences even when the frozen queue is larger', async (t) => {
  let deny = false, inspected = 0
  const f = await automaticFixture(t, async (tracks) => {
    if (deny) inspected += tracks.length
    return tracks.map(() => !deny)
  }, { tracks: Array.from({ length: 150 }, (_, index) => recommended(index + 1)) })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  deny = true
  await f.session.navigate(1)
  assert.equal(inspected, 100)
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
})

test('explicit queue selection, source playback and ordinary liked playback ignore automatic bans', async (t) => {
  let reads = 0
  const f = await automaticFixture(t, async (tracks) => { reads++; return tracks.map(() => false) },
    { heart: heartProvider() })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  const queue = f.session.snapshot().queue!
  const row = f.db.readLibraryQueue(queue.id).items[0]
  const before = reads
  await f.session.select({ ...queue, index: 0, occurrenceId: row.queueEntryId })
  await f.session.fromTrack(recommended(8))
  await f.session.startLiked({ selectedId: 'ncm:1' })
  await f.session.navigate(1)
  assert.equal(reads, before)
  assert.equal(f.session.snapshot().heart?.active, false)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
})

test('heart bans filter intelligence batches without suppressing the already-playing liked seed', async (t) => {
  const banned = new Set(['ncm:1', 'ncm:10'])
  const f = await automaticFixture(t, async (tracks) => tracks.map((track) => !banned.has(track.id)),
    { heart: heartProvider(async () => [10, 11, 12, 13].map(recommended)) })
  await f.session.startLiked({ selectedId: 'ncm:1' })
  const plays = f.engine.calls.filter((call) => call === 'play').length
  await f.session.setMode('heart')
  assert.equal(f.session.snapshot().heart?.active, true)
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, plays)
  assert.equal(f.engine.items.length, 1)
  assert.equal(f.db.readLibraryQueue(f.session.snapshot().queue!.id).items.some((row) => row.track?.id === 'ncm:10'), false)
  automaticEof(f)
  for (let i = 0; i < 30 && f.session.snapshot().track?.id === 'ncm:1'; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'ncm:11')
})

test('slow automatic preference reads leave Pause responsive and cannot publish a late Play', async (t) => {
  const entered = deferred<void>(), release = deferred<void>()
  let slow = false
  const f = await automaticFixture(t, async (tracks) => {
    if (slow && tracks.length === 1) { entered.resolve(); await release.promise }
    return tracks.map(() => true)
  })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  slow = true
  const next = f.session.navigate(1)
  const cancelled = assert.rejects(next)
  await entered.promise
  await f.session.pause()
  release.resolve()
  await cancelled
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
})

test('invalid automatic preference batches fail visibly instead of permitting recommendations', async (t) => {
  const f = await automaticFixture(t, async () => [])
  await assert.rejects(f.session.startPersonalized({ providerId: 'ncm', key: 'fm' }), /invalid batch/)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 0)
})

test('an initial automatic choice banned during source IO never replaces the currently playing queue', async (t) => {
  const entered = deferred<void>(), release = deferred<void>()
  let deny = false
  const f = await automaticFixture(t, async (tracks) => tracks.map(() => !deny), {
    resolver: { resolve: async (value) => {
      const track = value as TrackData
      if (track.source === 'ncm') { entered.resolve(); await release.promise }
      return { source: track.filePath || `https://audio.test/${track.id}`, expiresAt: null }
    } }
  })
  await f.session.fromQuery({}, 'a')
  const before = f.session.snapshot().queue!
  const starting = f.session.startPersonalized({ providerId: 'ncm', key: 'fm' })
  const rejected = assert.rejects(starting, /excluded from automatic playback/)
  await entered.promise
  deny = true
  release.resolve()
  await rejected
  assert.equal(f.session.snapshot().queue?.id, before.id)
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1)
})

test('repeat in an automatic context has a Core preference boundary instead of native replay', async (t) => {
  const banned = new Set<string>()
  const f = await automaticFixture(t, async (tracks) => tracks.map((track) => !banned.has(track.id)))
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  await f.session.setMode('repeat')
  assert.equal(f.engine.info.playMode, 'sequential')
  banned.add('ncm:1')
  automaticEof(f)
  for (let i = 0; i < 30 && f.session.snapshot().track?.id === 'ncm:1'; i++) await tick()
  assert.notEqual(f.session.snapshot().track?.id, 'ncm:1')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.engine.info.playMode, 'sequential')
})

test('injecting automatic preferences leaves ordinary playlist native preloading intact', async (t) => {
  let reads = 0
  const f = await automaticFixture(t, async (tracks) => { reads++; return tracks.map(() => false) })
  await f.session.fromPages(async (append) => append([1, 2].map((id) => ({
    id: recommended(id).id, snapshot: { ...recommended(id) }
  }))))
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(f.engine.items.length, 2)
  assert.equal(reads, 0)
})

test('Cast recommendation EOF skips newly banned queue entries before issuing remote LOAD', async (t) => {
  const banned = new Set<string>()
  const f = await castFixture(t, {
    automaticPlaybackAllowed: async (tracks) => tracks.map((track) => !banned.has(track.id)),
    personalized: {
      supportedMethods: () => ['fetchPersonalFm'],
      call: async () => [1, 2, 3, 4, 5].map(recommended)
    }
  })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  await f.start()
  const rows = f.db.readLibraryQueue(f.session.snapshot().queue!.id).items
  banned.add(rows[1].track!.id)
  const before = f.loads.length
  await f.fire({ state: 'stopped', position: 60, duration: 60, ended: true })
  for (let i = 0; i < 20 && f.loads.length === before; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, rows[2].track!.id)
  assert.equal(f.loads.length, before + 1)
})

test('a background recommendation append during automatic source IO preserves the selected next occurrence', async (t) => {
  const entered = deferred<void>(), release = deferred<void>()
  let slow = ''
  const f = await automaticFixture(t, async (tracks) => tracks.map(() => true), {
    resolver: { resolve: async (value) => {
      const track = value as TrackData
      if (track.id === slow) { entered.resolve(); await release.promise }
      return { source: `https://audio.test/${track.id}`, expiresAt: null }
    } }
  })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', selectedId: 'ncm:1' })
  const rows = f.db.readLibraryQueue(f.session.snapshot().queue!.id).items
  slow = rows[1].track!.id
  const next = f.session.navigate(1)
  await entered.promise
  f.setTracks([recommended(6)])
  assert.equal(await f.session.refillPersonalized(f.session.snapshot().queue!), 1)
  release.resolve()
  await next
  assert.equal(f.session.snapshot().track?.id, slow)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.session.snapshot().queue?.total, 6)
})

async function recoveredHeartFixture(t: test.TestContext, recommendations = [11, 12, 13, 14]) {
  const banned = new Set<string>()
  let requests = 0
  const f = await automaticFixture(
    t,
    async (tracks) => tracks.map((track) => !banned.has(track.id)),
    {
      heart: heartProvider(async () => {
        requests++
        return recommendations.map(recommended)
      }),
      sources: {
        prepare: async (track) => {
          const prepared = track.id === 'ncm:11'
            ? {
                ...track,
                id: 'fallback-local',
                source: 'local',
                ncmSongId: undefined,
                filePath: 'D:/Music/fallback-local.flac'
              }
            : track
          return {
            track: prepared,
            resolved: {
              source: prepared.source === 'local'
                ? prepared.filePath
                : `https://audio.test/${prepared.id}`,
              expiresAt: null
            }
          }
        }
      }
    }
  )
  await f.session.startLiked({ selectedId: 'ncm:1' })
  await f.session.setMode('heart')
  await f.session.navigate(1)
  assert.equal(f.session.snapshot().track?.id, 'fallback-local')
  assert.equal(f.session.snapshot().heart?.available, false)
  assert.equal(f.session.snapshot().heart?.active, true)
  assert.equal(f.engine.items.length, 1)
  return { ...f, banned, get heartRequests() { return requests } }
}

test('a heart recommendation repaired to local keeps automatic bans and the single-item native window on Next', async (t) => {
  const f = await recoveredHeartFixture(t)
  f.banned.add('ncm:12')
  await f.session.navigate(1)
  assert.equal(f.session.snapshot().track?.id, 'ncm:13')
  assert.equal(f.session.snapshot().heart?.active, true)
  assert.equal(f.engine.items.length, 1)
  assert.equal(f.engine.items.some((item) => item.id === 'ncm:12'), false)
})

test('a heart recommendation repaired to local keeps automatic bans at natural EOF without native preloading', async (t) => {
  const f = await recoveredHeartFixture(t)
  f.banned.add('ncm:12')
  automaticEof(f)
  for (let i = 0; i < 30 && f.session.snapshot().track?.id === 'fallback-local'; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'ncm:13')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.engine.items.length, 1)
  assert.equal(f.engine.items.some((item) => item.id === 'ncm:12'), false)
})

test('a local repaired heart occurrence remains active without sending an invalid refill seed', async (t) => {
  const f = await recoveredHeartFixture(t, [11, 12, 13])
  for (let i = 0; i < 10; i++) {
    f.engine.emit('playback-info', f.engine.info)
    await tick()
  }
  assert.equal(f.heartRequests, 1)
  assert.equal(f.session.snapshot().heart?.active, true)
  assert.equal(f.session.snapshot().heart?.error, null)
  await assert.rejects(f.session.refillHeart(f.session.snapshot().queue!), /requires an NCM seed/)
  assert.equal(f.heartRequests, 1)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.equal(f.engine.items.length, 1)
})

test('Core starts and extends FM/radar with lazy provider identities, deduplication and independent original order; cold restore is paused', async (t) => {
  let tracks = [recommended(1), recommended(2), recommended(3)],
    calls = 0
  const f = await fixture(t, undefined, undefined, undefined, {
    supportedMethods: () => ['fetchPersonalFm', 'fetchPrivateContent'],
    call: async () => {
      calls++
      return tracks
    }
  })
  await f.session.startPersonalized({
    providerId: 'ncm',
    key: 'fm',
    selectedId: 'ncm:2',
    play: false
  })
  const queue = f.session.snapshot().queue!
  assert.equal(queue.total, 3)
  assert.equal(f.session.snapshot().track?.id, 'ncm:2')
  assert.equal(f.saved?.data?.personalizedStream?.queueId, queue.id)
  assert.equal(
    f.engine.calls.some((call) => ['play', 'seek', 'loadQueue'].includes(call)),
    false
  )
  assert.doesNotMatch(
    JSON.stringify(f.db.readLibraryQueue(queue.id)),
    /expired.invalid|token=private/
  )
  tracks = [recommended(3), recommended(4), recommended(5), recommended(4)]
  assert.equal(await f.session.refillPersonalized(queue), 2)
  const updated = f.session.snapshot().queue!
  assert.equal(updated.total, 5)
  assert.equal(updated.occurrenceId, queue.occurrenceId)
  assert.equal(f.session.snapshot().personalized?.remaining, 4)
  assert.deepEqual(
    f.db.sql
      .prepare('SELECT track_id FROM queue_entries WHERE queue_id=? ORDER BY original_position')
      .all(queue.id)
      .map((row) => row.track_id),
    ['ncm:1', 'ncm:2', 'ncm:3', 'ncm:4', 'ncm:5']
  )
  assert.equal(
    f.db.sql.prepare('SELECT count(*) AS n FROM queue_history WHERE queue_id=?').get(queue.id)!.n,
    0
  )
  await assert.rejects(f.session.refillPersonalized(queue), { code: 'STALE_REVISION' })
  assert.equal(calls, 2)
  await f.session.shutdown()
  const restarted = f.create()
  await restarted.initialize()
  assert.equal(restarted.snapshot().personalized?.key, 'fm')
  assert.equal(restarted.snapshot().queue?.occurrenceId, queue.occurrenceId)
  assert.equal(restarted.snapshot().playback?.state, 'paused')
  assert.equal(calls, 2)
  await restarted.shutdown()
})

test('radar falls back to FM when private content repeats, and manual queue replacement cancels late refill', async (t) => {
  let sequence = 0
  const entered = deferred<void>(),
    release = deferred<void>()
  const f = await fixture(t, undefined, undefined, undefined, {
    supportedMethods: () => ['fetchPrivateContent', 'fetchPersonalFm'],
    call: async (_id, method) => {
      if (++sequence > 3) {
        entered.resolve()
        await release.promise
        return [recommended(99)]
      }
      return method === 'fetchPrivateContent' ? [recommended(1)] : [recommended(2)]
    }
  })
  await f.session.startPersonalized({ providerId: 'ncm', key: 'radar', play: false })
  assert.equal(await f.session.refillPersonalized(f.session.snapshot().queue!), 1)
  assert.equal(sequence, 3)
  const oldQueue = f.session.snapshot().queue!
  const late = f.session.refillPersonalized(oldQueue)
  const cancelled = assert.rejects(late, /changed/)
  await entered.promise
  await f.session.fromQuery({}, 'a')
  release.resolve()
  await cancelled
  assert.equal(f.session.snapshot().personalized, null)
  assert.equal(f.db.getLibraryQueue(oldQueue.id).total, 2)
  assert.equal(f.session.snapshot().track?.id, 'a')
})

test('native occurrence observations refill the personalized queue without a renderer, extra Play, Seek or LoadQueue', async (t) => {
  let calls = 0
  const f = await fixture(
    t,
    {
      resolve: async (track) => ({
        source: `https://audio.test/${(track as TrackData).id}`,
        expiresAt: null
      })
    },
    undefined,
    undefined,
    {
      supportedMethods: () => ['fetchPersonalFm'],
      call: async () => (++calls === 1 ? [1, 2, 3, 4].map(recommended) : [5, 6, 7].map(recommended))
    }
  )
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm' })
  for (let i = 0; i < 20 && f.engine.items.length < 2; i++) await tick()
  assert.equal(calls, 1)
  const before = f.engine.calls.length,
    next = f.engine.items[1]
  f.engine.info = { ...f.engine.info, queueIndex: 1, source: next.source, position: 2 }
  f.engine.emit('playback-info', f.engine.info)
  for (let i = 0; i < 50 && f.session.snapshot().queue!.total < 7; i++) await tick()
  assert.equal(f.session.snapshot().queue?.total, 7)
  assert.equal(f.session.snapshot().queue?.occurrenceId, next.queueEntryId)
  assert.equal(calls, 2)
  assert.deepEqual(
    f.engine.calls.slice(before).filter((call) => ['play', 'seek', 'loadQueue'].includes(call)),
    []
  )
})

test('Pause cancels slow initial recommendations before replacing the old queue or playing', async (t) => {
  const entered = deferred<void>()
  const f = await fixture(t, undefined, undefined, undefined, {
    supportedMethods: () => ['fetchPersonalFm'],
    call: async (_id, _method, signal) => {
      entered.resolve()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    }
  })
  await f.session.fromQuery({}, 'a')
  const before = f.session.snapshot().queue!,
    calls = f.engine.calls.length
  const loading = f.session.startPersonalized({ providerId: 'ncm', key: 'fm' })
  const cancelled = assert.rejects(loading, /superseded/)
  await entered.promise
  await f.session.pause()
  await cancelled
  assert.equal(f.session.snapshot().queue?.id, before.id)
  assert.deepEqual(
    f.engine.calls.slice(calls).filter((call) => ['play', 'seek', 'loadQueue'].includes(call)),
    []
  )
})

test('a lost committed automatic append stops and is never reissued by observations or explicit refill', async (t) => {
  let calls = 0
  const f = await fixture(t, undefined, undefined, undefined, {
    supportedMethods: () => ['fetchPersonalFm'],
    call: async () => (++calls === 1 ? [recommended(1)] : [recommended(2)])
  })
  const append = f.queues.extendQueue!
  let writes = 0,
    loseReply = true
  f.queues.extendQueue = async (...args) => {
    writes++
    const result = await append(...args)
    if (loseReply) throw new Error('Lost automatic append reply')
    return result
  }
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm', play: false })
  const queue = f.session.snapshot().queue!
  await assert.rejects(f.session.refillPersonalized(queue), /Lost automatic append/)
  assert.equal(f.db.getLibraryQueue(queue.id).total, 2)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.match(f.session.snapshot().personalized?.error ?? '', /Lost automatic append/)
  await assert.rejects(f.session.refillPersonalized(queue), /Refresh stopped playback/)
  f.engine.emit('playback-info', f.engine.info)
  await tick()
  assert.equal(writes, 1)
  assert.equal(calls, 2)
  loseReply = false
  await f.session.refresh()
  assert.equal(f.session.snapshot().queue?.total, 2)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(await f.session.refillPersonalized(f.session.snapshot().queue!), 0)
  assert.equal(writes, 2) // A fresh provider read after explicit stopped recovery, not automatic replay.
})

test('empty personalized refills respect the existing cooldown instead of refetching on every playback sample', async (t) => {
  let calls = 0
  const f = await fixture(
    t,
    {
      resolve: async (track) => ({
        source: `https://audio.test/${(track as TrackData).id}`,
        expiresAt: null
      })
    },
    undefined,
    undefined,
    {
      supportedMethods: () => ['fetchPersonalFm'],
      call: async () => {
        calls++
        return [1, 2, 3, 4].map(recommended)
      }
    }
  )
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm' })
  await f.session.navigate(1)
  for (let i = 0; i < 20; i++) {
    f.engine.emit('playback-info', f.engine.info)
    await tick()
  }
  assert.equal(calls, 2)
  assert.equal(f.session.snapshot().queue?.total, 4)
  assert.equal(f.session.snapshot().personalized?.loading, false)
})

test('a slow personalized refill never holds Pause and its late additions cannot restart audio', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  let calls = 0
  const f = await fixture(
    t,
    {
      resolve: async (track) => ({
        source: `https://audio.test/${(track as TrackData).id}`,
        expiresAt: null
      })
    },
    undefined,
    undefined,
    {
      supportedMethods: () => ['fetchPersonalFm'],
      call: async () => {
        if (++calls === 1) return [1, 2, 3, 4].map(recommended)
        entered.resolve()
        await release.promise
        return [5, 6, 7].map(recommended)
      }
    }
  )
  await f.session.startPersonalized({ providerId: 'ncm', key: 'fm' })
  await f.session.navigate(1)
  await entered.promise
  const callsBeforePause = f.engine.calls.length
  await f.session.pause()
  const occurrence = f.session.snapshot().queue?.occurrenceId
  release.resolve()
  for (let i = 0; i < 30 && f.session.snapshot().queue!.total !== 7; i++) await tick()
  assert.equal(f.session.snapshot().queue?.total, 7)
  assert.equal(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.deepEqual(
    f.engine.calls
      .slice(callsBeforePause)
      .filter((call) => ['play', 'seek', 'loadQueue'].includes(call)),
    []
  )
})

test('source maintenance pins current and preload without a native reload, and Pause stays responsive during deletion', async (t) => {
  const f = await fixture(t, {
    resolve: async (track) => ({
      source: `D:/cache/${(track as TrackData).id}.flac`,
      expiresAt: null
    })
  })
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a')
  for (let i = 0; i < 20 && f.engine.items.length < 2; i++) await tick()
  await f.session.seek(23)
  const before = f.session.snapshot().queue!
  const calls = f.engine.calls.length
  const deleting = deferred<void>(),
    release = deferred<void>()
  const work = f.session.maintainSources(async (sources) => {
    assert.ok(sources.includes('D:/cache/a.flac'))
    assert.ok(sources.includes('D:/cache/b.flac'))
    deleting.resolve()
    await release.promise
  })
  await deleting.promise
  await f.session.pause()
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().playback?.position, 23)
  release.resolve()
  await work
  assert.equal(f.session.snapshot().queue?.occurrenceId, before.occurrenceId)
  assert.deepEqual(
    f.engine.calls
      .slice(calls)
      .filter((call) => ['play', 'seek', 'loadQueue', 'stop'].includes(call)),
    []
  )
})

test('source maintenance revokes a resolved-before-load candidate and holds new source loads outside the control lane', async (t) => {
  let slow = false
  const entered = deferred<void>(),
    authorized = deferred<void>()
  const f = await fixture(t, {
    resolve: async (track) => {
      if (slow) {
        entered.resolve()
        await authorized.promise
      }
      return { source: (track as TrackData).filePath, expiresAt: null }
    }
  })
  await f.session.fromQuery({}, 'a')
  await f.session.pause()
  slow = true
  const old = f.session.fromQuery({}, 'b')
  const cancelled = assert.rejects(old, { code: 'CANCELLED' })
  await entered.promise
  const clearing = deferred<void>(),
    release = deferred<void>()
  const maintenance = f.session.maintainSources(async () => {
    clearing.resolve()
    await release.promise
  })
  await clearing.promise
  authorized.resolve()
  await cancelled
  slow = false
  const calls = f.engine.calls.length
  const next = f.session.fromQuery({}, 'b')
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(f.engine.calls.slice(calls).includes('loadQueue'), false)
  await f.session.pause()
  const nextCancelled = assert.rejects(next, { code: 'CANCELLED' })
  release.resolve()
  await maintenance
  await nextCancelled
  assert.equal(f.engine.calls.slice(calls).includes('loadQueue'), false)
  assert.equal(f.session.snapshot().track?.id, 'a')
})

test('a source owner reserves its playback intent before file/provider preparation; Pause prevents a late Play', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  const before = f.session.snapshot().queue
  const previousLoads = f.engine.calls.filter((call) => call === 'loadQueue').length
  let release!: () => void, entered!: () => void, preparation!: AbortSignal
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const work = f.session.fromTrack(async (signal) => {
    preparation = signal
    entered()
    await gate
    return libraryQueueTrack(f.db.getTracksByIds(['b']).tracks[0], 'b')
  })
  const cancelled = assert.rejects(work, /superseded/)
  await started
  await f.session.pause()
  assert.equal(preparation.aborted, true)
  release()
  await cancelled
  assert.equal(f.session.snapshot().queue?.id, before?.id)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, previousLoads)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
})
class Engine extends EventEmitter implements CorePlaybackEngine {
  calls: string[] = []
  items: AudioEngineQueueItem[] = []
  token = ''
  info = createDefaultPlaybackInfo('wasapi', '', false, normalizeOutputConfig())
  failLoad = false
  nativeLoop = false
  async setLoopRangeConfirmed(start: number, end: number) {
    this.calls.push(`loop:${start}:${end}`)
    return this.nativeLoop
  }
  seekConfirmed(position: number) {
    return this.seek(position)
  }
  end: ReturnType<CorePlaybackEngine['getPlaybackEnd']> = null
  async start() {
    this.calls.push('start')
  }
  async getPlaybackInfo() {
    return { ...this.info }
  }
  getQueueSnapshot() {
    return this.items
  }
  getQueueToken() {
    return this.token
  }
  getPlaybackEnd() {
    return this.end
  }
  async continueAfterPlaybackEnd(
    request: Parameters<CorePlaybackEngine['continueAfterPlaybackEnd']>[0]
  ) {
    this.calls.push('continueAfterPlaybackEnd')
    if (!request.isCurrent() || request.expected !== this.end) return false
    this.end = null
    this.items = [request.item]
    this.token += ':end'
    this.info = {
      ...this.info,
      queueIndex: 0,
      source: request.item.source,
      state: 'playing',
      position: 0,
      playMode: request.playMode
    }
    request.onSelected()
    this.emit('playback-info', this.info)
    return true
  }
  async play(
    source: string,
    position = 0,
    requested?: () => boolean
  ): Promise<AudioEnginePlayResult> {
    this.calls.push('play')
    if (requested?.() === false)
      return { nativeStarted: false, superseded: true, fallbackReason: '' }
    this.info = { ...this.info, state: 'playing', source, position }
    this.emit('playback-info', this.info)
    return { nativeStarted: true, fallbackReason: '' }
  }
  async pause() {
    this.calls.push('pause')
    this.info = { ...this.info, state: 'paused' }
    this.emit('playback-info', this.info)
  }
  async stop() {
    this.calls.push('stop')
    this.info = { ...this.info, state: 'stopped', position: 0 }
    this.emit('playback-info', this.info)
  }
  async seek(position: number) {
    this.calls.push('seek')
    this.info = { ...this.info, position }
    this.emit('playback-info', this.info)
  }
  async setVolume(volume: number) {
    this.info.volume = volume
  }
  async setPlaybackRate(rate: number) {
    this.calls.push(`rate:${rate}`)
    this.info.playbackRate = rate
  }
  async setPlayMode(mode: PlayMode) {
    this.info.playMode = mode
  }
  async loadQueue(items: AudioEngineQueueItem[], startIndex = 0) {
    this.calls.push('loadQueue')
    this.items = items
    this.token += ':load'
    this.info.queueIndex = startIndex
    this.info.source = items[startIndex].source
    if (this.failLoad) throw new Error('Reply lost after native LoadQueue')
  }
  async rebindQueue(request: NativeQueueRebind) {
    this.calls.push('rebindQueue')
    if (
      request.expected.queueToken !== this.token ||
      request.expected.index !== this.info.queueIndex ||
      request.expected.source !== this.info.source
    )
      return null
    this.items = request.items
    this.token += ':rebind'
    this.info.queueIndex = request.startIndex
    this.info.playMode = request.playMode
    return { queueToken: this.token }
  }
}

function namedFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: Exclude<PlayMode, 'heart'> = 'shuffle'
) {
  const base = libraryQueueTrack(f.db.getTracksByIds(['a']).tracks[0], 'saved:first')
  const queue = [base, { ...base, queueEntryId: 'saved:second' }]
  const saved = captureQueueSession(
    { now: () => 1000, newId: () => 'named' },
    'Named',
    queue,
    [...queue].reverse(),
    queue[1],
    23,
    mode
  )
  const resolve = () =>
    resolveQueueSession(saved, {
      localTracks: new Map([['a', base]]),
      savedStreams: new Map(),
      availableProviders: new Set(),
      networkProfiles: new Set(),
      authorizeFiles: async (paths) => paths.map(() => true),
      isCurrent: () => true
    })
  return { saved, resolve }
}

test('named array restore keeps overlapping occurrence IDs, CUE ranges, independent orders and paused position without Load/Play/Seek', async (t) => {
  const f = await fixture(t)
  // Even old non-shuffle array saves can carry an independent original order.
  const named = namedFixture(f, 'repeat')
  await f.session.restoreNamedSession(named.saved, named.resolve, () => {})
  const first = f.session.snapshot().queue!
  assert.equal(first.occurrenceId, 'saved:second')
  assert.equal(first.index, 1)
  assert.equal(f.session.snapshot().playback?.position, 23)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.deepEqual(
    f.engine.calls.filter((call) => ['loadQueue', 'play', 'seek'].includes(call)),
    []
  )
  await f.session.restoreNamedSession(named.saved, named.resolve, () => {})
  const second = f.session.snapshot().queue!
  assert.notEqual(first.id, second.id)
  for (const id of [first.id, second.id]) {
    assert.deepEqual(
      f.db.readLibraryQueue(id).items.map((row) => row.queueEntryId),
      ['saved:first', 'saved:second']
    )
    assert.deepEqual(
      f.db.sql
        .prepare('SELECT entry_id FROM queue_entries WHERE queue_id=? ORDER BY original_position')
        .all(id)
        .map((row) => row.entry_id),
      ['saved:second', 'saved:first']
    )
    assert.deepEqual(f.db.readLibraryQueue(id).items[1].track?.cueRange, {
      startSeconds: 10,
      endSeconds: 70
    })
  }
  await f.session.play()
  assert.equal(f.engine.info.position, 23)
  assert.equal(f.session.snapshot().queue?.occurrenceId, 'saved:second')
  assert.deepEqual(f.engine.items[0].cueRange, { startSeconds: 10, endSeconds: 70 })
})

test('named durable restore follows the shared current queue and cursor and applies saved mode without cloning or reselecting old occurrence', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a', false)
  const reference = (await f.session.captureWorkspace()).reference
  const named = captureLibraryQueueSession(
    { now: () => 1000, newId: () => 'named' },
    'Named',
    reference,
    17,
    'repeat'
  )
  await f.session.select({
    id: reference.id,
    revision: reference.revision,
    index: 1,
    occurrenceId: f.db.readLibraryQueue(reference.id).items[1].queueEntryId
  })
  const latest = f.session.snapshot().queue!
  const calls = f.engine.calls.length
  const outcome = await f.session.restoreNamedSession(
    named,
    async () => {
      throw new Error('Durable sessions do not resolve arrays')
    },
    () => {}
  )
  assert.equal(outcome.restored, 2)
  assert.equal(f.session.snapshot().queue?.id, reference.id)
  assert.equal(f.session.snapshot().queue?.occurrenceId, latest.occurrenceId)
  assert.equal(f.session.snapshot().queue?.index, 1)
  assert.equal(f.session.snapshot().playback?.playMode, 'repeat')
  assert.equal(f.session.snapshot().playback?.position, 17)
  assert.deepEqual(
    f.engine.calls.slice(calls).filter((call) => ['loadQueue', 'play', 'seek'].includes(call)),
    []
  )
  assert.equal(f.db.sql.prepare('SELECT count(*) AS n FROM queues').get()?.n, 1)
})

test('Pause cancels named-session source preparation immediately; empty sessions do not replace the current queue', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a'], sort: 'playlist' }, 'a', false)
  const before = f.session.snapshot().queue
  const named = namedFixture(f)
  let started!: () => void
  const preparing = new Promise<void>((resolve) => {
    started = resolve
  })
  const restore = f.session.restoreNamedSession(
    named.saved,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        started()
      }),
    () => {}
  )
  const rejected = assert.rejects(restore, /superseded/)
  await preparing
  await f.session.pause()
  await rejected
  assert.deepEqual(f.session.snapshot().queue, before)
  await assert.rejects(
    f.session.restoreNamedSession(
      named.saved,
      async () => ({ queue: [], original: [], index: 0, position: 0, missing: [], deferred: 0 }),
      () => {}
    ),
    /当前队列未改变/
  )
  assert.deepEqual(f.session.snapshot().queue, before)
})

test('named restore checks session/source and current selection after slow resolution, then retains exact identity on an unknown Load', async (t) => {
  let finish!: () => void
  let block = false
  const wait = () =>
    new Promise<void>((resolve) => {
      finish = resolve
    })
  const f = await fixture(t, {
    resolve: async (track) => {
      if (block) await wait()
      return { source: (track as TrackData).filePath, expiresAt: null }
    }
  })
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a', false)
  const before = f.session.snapshot().queue
  const named = namedFixture(f)
  let current = true
  block = true
  const restoring = f.session.restoreNamedSession(
    named.saved,
    named.resolve,
    () => {
      if (!current) throw new Error('session edited')
    },
    true
  )
  const rejected = assert.rejects(restoring, /session edited/)
  while (!finish) await tick()
  current = false
  finish()
  await rejected
  assert.deepEqual(f.session.snapshot().queue, before)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1) // fromQuery's prepared source
  block = false
  f.engine.failLoad = true
  await assert.rejects(
    f.session.restoreNamedSession(named.saved, named.resolve, () => {}, true),
    /Reply lost/
  )
  assert.equal(f.session.snapshot().queue?.occurrenceId, 'saved:second')
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 2)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 0)
})

test('an unconsumed native EOF during named restore wins its occurrence and cancels before a stale native Load', async (t) => {
  let finish: (() => void) | undefined
  let block = false
  const f = await fixture(t, {
    resolve: async (track) => {
      if (block)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return { source: (track as TrackData).filePath, expiresAt: null }
    }
  })
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a')
  while (f.engine.items.length < 2) await tick()
  const previous = f.session.snapshot().queue!
  const named = namedFixture(f)
  block = true
  const restoring = f.session.restoreNamedSession(named.saved, named.resolve, () => {}, true)
  const rejected = assert.rejects(restoring, /选中项已变化/)
  while (!finish) await tick()
  const successor = f.engine.items[1]
  f.engine.info = { ...f.engine.info, queueIndex: 1, source: successor.source, position: 4 }
  // Deliberately withhold the event: final adoption must sample the native cursor.
  finish()
  await rejected
  assert.equal(f.session.snapshot().queue?.id, previous.id)
  assert.equal(f.session.snapshot().queue?.occurrenceId, successor.queueEntryId)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
})

test('deferred provider/network named entries seed durable logical identities without saving resolved URLs', async (t) => {
  const seen: TrackData[] = []
  const f = await fixture(t, {
    resolve: async (track) => {
      seen.push(track as TrackData)
      return { source: 'https://resolved.test/private?token=secret', expiresAt: null }
    }
  })
  const base = libraryQueueTrack(f.db.getTracksByIds(['a']).tracks[0], 'provider')
  const queue: TrackData[] = [
    { ...base, id: 'ncm:1', source: 'ncm', ncmSongId: 1, filePath: '', cueRange: undefined },
    {
      ...base,
      id: 'network:one',
      source: 'network',
      queueEntryId: 'network',
      filePath: '',
      cueRange: undefined,
      networkSource: {
        profileId: 'nas',
        entry: {
          id: 'network:one',
          profileId: 'nas',
          path: '/one.flac',
          name: 'one.flac',
          kind: 'audio'
        }
      }
    }
  ]
  const saved = captureQueueSession(
    { now: () => 1000, newId: () => 'remote' },
    'Remote',
    queue,
    queue,
    queue[0],
    0,
    'sequential'
  )
  const resolve = () =>
    resolveQueueSession(saved, {
      localTracks: new Map(),
      savedStreams: new Map(),
      availableProviders: new Set(['ncm']),
      networkProfiles: new Set(['nas']),
      authorizeFiles: async () => [],
      isCurrent: () => true
    })
  const outcome = await f.session.restoreNamedSession(saved, resolve, () => {}, true)
  assert.equal(outcome.deferred, 2)
  assert.equal(seen[0].id, 'ncm:1')
  const rows = f.db.readLibraryQueue(f.session.snapshot().queue!.id).items
  assert.deepEqual(
    rows.map((row) => row.track?.filePath),
    ['', '']
  )
  assert.deepEqual(rows[1].track?.networkSource, queue[1].networkSource)
  assert.doesNotMatch(JSON.stringify(rows), /resolved.test|secret/)
})

test('path-derived saved occurrence IDs survive native use, edits and cold paused recovery without truncation', async (t) => {
  const f = await fixture(t)
  const named = namedFixture(f)
  const occurrence = `queue:D:/Music/${'long-folder/'.repeat(40)}disc.flac:0`
  named.saved.entries[1].queueEntryId = occurrence
  named.saved.originalEntryIds[0] = occurrence
  named.saved.currentEntryId = occurrence
  await f.session.restoreNamedSession(named.saved, named.resolve, () => {})
  const reference = f.session.snapshot().queue!
  assert.equal(reference.occurrenceId, occurrence)
  await f.session.edit(reference.id, reference.revision, {
    kind: 'move',
    entryId: occurrence,
    beforeEntryId: 'saved:first'
  })
  await f.session.play()
  assert.equal(f.engine.items[0].queueEntryId, occurrence)
  await f.session.shutdown()
  const cold = f.create()
  try {
    await cold.initialize()
    assert.equal(cold.snapshot().queue?.occurrenceId, occurrence)
    assert.equal(cold.snapshot().playback?.state, 'paused')
    assert.equal(cold.snapshot().playback?.position, 23)
  } finally {
    await cold.shutdown()
  }
})
async function fixture(
  t: test.TestContext,
  resolver: SourceResolver = {
    resolve: async (track) => ({ source: (track as TrackData).filePath, expiresAt: null })
  },
  fatal: (error: Error) => void = (error) => assert.fail(error.message),
  observePlayback?: CorePlaybackSessionOptions['observePlayback'],
  personalized?: PersonalizedProviders,
  heart?: HeartProviders,
  sources?: PlaybackSourceRecovery,
  resources?: SourceResources,
  runTransport?: CorePlaybackSessionOptions['runTransport'],
  cast?: CoreCastService,
  extra?: Partial<
    Pick<
      CorePlaybackSessionOptions,
      'sleepTimer' | 'setNativeSleepGain' | 'naturalBoundary' | 'schedule' | 'automaticPlaybackAllowed'
    >
  >
) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'a',
        title: 'Cue 1',
        filePath: 'D:/Music/disc.flac',
        duration: 60,
        cueRange: { startSeconds: 10, endSeconds: 70 }
      },
      {
        id: 'b',
        title: 'Cue 2',
        filePath: 'D:/Music/disc.flac',
        duration: 60,
        cueRange: { startSeconds: 70, endSeconds: 130 }
      }
    ]
  })
  const queues: CorePlaybackSessionOptions['queues'] = {
    buildQueue: async (command) => db.buildLibraryQueue(command),
    libraryRevision: async () => db.getMetadata().revision,
    importLegacyPlaybackQueue: async (command) => db.importLegacyPlaybackQueue(command),
    restoreNamedPlaybackQueue: async (command) => db.restoreNamedPlaybackQueue(command),
    restoreHeartBaseQueue: async (...args) => db.restoreHeartBaseQueue(...args),
    extendQueue: async (...args) => db.extendPlaybackQueue(...args),
    replaceSource: async (command) => db.replacePlaybackQueueSource(command),
    createQueue: async (...args) => db.createLibraryQueue(...args),
    getQueue: async (...args) => db.getLibraryQueue(...args),
    readQueue: async (...args) => db.readLibraryQueue(...args),
    editQueue: async (...args) => db.editLibraryQueue(...args),
    deleteQueue: async (...args) => db.deleteLibraryQueue(...args),
    syncQueueReferences: async (...args) => db.syncLibraryQueueReferences(...args),
    readNeighbor: async (...args) => db.readLibraryQueueNeighbor(...args)
  }
  const engine = new Engine()
  let saved: { revision: number; data: PlaybackSessionData<TrackData> | null } | null = null
  const repository: CoreSessionRepository = {
    load: async () => saved,
    save: async (data, revision) => {
      assert.equal(revision, saved?.revision ?? 0)
      saved = { revision: revision + 1, data: structuredClone(data) }
      return saved
    },
    clear: async (revision) => {
      saved = { revision: revision + 1, data: null }
      return saved
    }
  }
  let changes = 0
  const create = (overrides = extra) =>
    new CorePlaybackSession({
      ...overrides,
      engine,
      cast,
      queues,
      resolver,
      sources,
      resources,
      runTransport,
      authorize: async (source) => source,
      repository,
      resumeMode: () => 'trackAndPosition',
      now: () => 1000,
      schedule:
        overrides?.schedule ??
        ((callback, delayMs) => {
          const timer = setTimeout(callback, delayMs)
          return () => clearTimeout(timer)
        }),
      changed: () => changes++,
      observePlayback,
      personalized,
      heart,
      fatal
    })
  const session = create()
  await session.initialize()
  t.after(async () => {
    await session.shutdown()
    db.close()
  })
  return {
    db,
    engine,
    session,
    repository,
    create,
    queues,
    get changes() {
      return changes
    },
    get saved() {
      return saved
    }
  }
}

test('catalog sources enter the existing durable queue and native resolution with exact CUE identity and fresh occurrences', async t => {
  const resolved: TrackData[] = []
  const f = await fixture(t, {
    resolve: async track => {
      resolved.push(track as TrackData)
      return { source: (track as TrackData).source === 'ncm' ? 'https://media.example/7' : (track as TrackData).filePath, expiresAt: null }
    }
  })
  while (f.db.catalogStatus().localPending) f.db.catalogAdvance()
  const entity = f.db.catalogQuery({ kind: 'recording' }).items.find(item => item.title === 'Cue 1')!
  const source = f.db.catalogSources({ entityId: entity.id }).items[0]
  const playSource = async (id: string) => {
    await f.session.fromTrack(async () => {
      const track = f.db.catalogResolve(id, f.db.catalogStatus().revision)
      if (!track) throw new Error('missing source')
      return { ...track, sourceSelection: 'explicit' }
    })
  }
  await playSource(source.id)
  const first = f.session.snapshot().queue!
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.engine.items[0].cueRange?.startSeconds, 10)
  assert.equal(f.engine.items[0].cueRange?.endSeconds, 70)
  assert.equal(f.db.readLibraryQueue(first.id).items[0].track?.sourceSelection, 'explicit')
  await playSource(source.id)
  assert.notEqual(f.session.snapshot().queue!.occurrenceId, first.occurrenceId)
  const remote = recommended(7)
  let job = f.db.catalogSync({ kind: 'begin', revision: 0 })
  job = f.db.catalogSync({ kind: 'append', ...job, tracks: [remote] })
  f.db.catalogSync({ kind: 'commit', ...job })
  const online = f.db.catalogQuery({ kind: 'recording', source: 'ncm' }).items[0]
  await playSource(f.db.catalogSources({ entityId: online.id }).items[0].id)
  assert.equal(f.engine.items[0].source, 'https://media.example/7')
  assert.equal(resolved.some(track => track.id === 'ncm:7' && !track.streamUrl), true)
  assert.equal(f.db.getLibraryQueue(first.id).total, 1, 'new playback never rewrites an old queue')
})

test('an explicitly chosen unavailable catalog source cannot trigger mature metadata rematching', async t => {
  let searches = 0
  const resolver: SourceResolver = { resolve: async () => null }
  const sources = createPlaybackSourceRecovery({
    resolver, authorize: async source => source, identity: createLogicalTrackModel(() => undefined),
    versionsRevision: () => 0, now: () => 1000,
    search: async () => { searches++; throw new Error('must not search') }
  })
  const f = await fixture(t, resolver, undefined, undefined, undefined, undefined, sources)
  const selected = { ...recommended(7), sourceSelection: 'explicit' as const }
  await assert.rejects(f.session.fromTrack(selected), /Unable to resolve/)
  assert.equal(searches, 0)
  assert.equal(f.engine.calls.includes('loadQueue'), false)
})

test('source-owned radio/podcast queues use durable fresh occurrences; paused preparation issues no Load/Play/Seek and applies rate on Play', async (t) => {
  const f = await fixture(t)
  const podcast: TrackData = {
    id: 'podcast:one:guid',
    source: 'podcast',
    filePath: 'https://cdn.example/one.mp3',
    streamUrl: 'https://cdn.example/one.mp3',
    title: 'Episode',
    artist: 'Cast',
    album: 'Cast',
    fileName: '',
    duration: 120,
    size: 0,
    cover: null,
    lyrics: null
  }
  await f.session.fromTrack(podcast, 42, false)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().playback?.position, 42)
  const occurrence = f.session.snapshot().queue?.occurrenceId
  assert.ok(occurrence)
  assert.equal(f.session.snapshot().queue?.total, 1)
  assert.deepEqual(
    f.engine.calls.filter((call) => ['play', 'seek', 'loadQueue'].includes(call)),
    []
  )
  await f.session.play()
  assert.equal(f.session.snapshot().playback?.position, 42)
  assert.equal(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.ok(f.engine.calls.includes('rate:1'))
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  await f.session.fromTrack({ ...podcast, id: 'radio_one', source: 'radio' })
  assert.notEqual(f.session.snapshot().queue?.occurrenceId, occurrence)
  assert.equal(f.engine.calls.filter((call) => call === 'rate:1').length, 2)
})

test('slow internal source preparation never holds Pause; cancelled source build cannot replace the old cursor', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  const before = f.session.snapshot().queue
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    ready = new Promise<void>((resolve) => {
      started = resolve
    })
  const work = f.session.fromPages(async (append) => {
    started()
    await gate
    await append([{ id: 'b' }])
  })
  void work.catch(() => {})
  await ready
  await f.session.pause()
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  release()
  await assert.rejects(work, /superseded/)
  assert.equal(f.session.snapshot().queue?.id, before?.id)
  assert.equal(f.session.snapshot().queue?.occurrenceId, before?.occurrenceId)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
})

test('unknown native Load for a source-owned seed stays stopped and retains its exact cursor without replay', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  const old = f.session.snapshot().queue?.id
  f.engine.failLoad = true
  await assert.rejects(
    f.session.fromTrack({
      id: 'radio_1',
      source: 'radio',
      filePath: 'https://example.test/live',
      title: 'Radio',
      artist: '',
      album: '',
      fileName: '',
      duration: 0,
      size: 0,
      cover: null,
      lyrics: null
    }),
    /Reply lost/
  )
  assert.notEqual(f.session.snapshot().queue?.id, old)
  assert.equal(f.session.snapshot().track?.id, 'radio_1')
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 2)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
})

test('a changed source revision during resolution is rejected before LoadQueue or Play', async (t) => {
  let started!: () => void,
    release!: () => void,
    current = true
  const ready = new Promise<void>((resolve) => {
      started = resolve
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
  const f = await fixture(t, {
    resolve: async (track) => {
      if ((track as TrackData).id === 'radio_slow') {
        started()
        await gate
      }
      return { source: (track as TrackData).filePath, expiresAt: null }
    }
  })
  await f.session.fromQuery({}, 'a')
  const before = f.session.snapshot().queue
  const calls = [...f.engine.calls]
  const pending = f.session.fromTrack(
    {
      id: 'radio_slow',
      source: 'radio',
      filePath: 'https://example.test/live',
      title: 'Radio',
      artist: '',
      album: '',
      fileName: '',
      size: 0,
      duration: 0,
      cover: null,
      lyrics: null
    },
    0,
    true,
    undefined,
    () => {
      if (!current) throw new Error('Source revision changed')
    }
  )
  const rejected = assert.rejects(pending, /Source revision changed/)
  await ready
  current = false
  release()
  await rejected
  assert.equal(f.session.snapshot().queue?.id, before?.id)
  assert.equal(f.session.snapshot().queue?.occurrenceId, before?.occurrenceId)
  assert.deepEqual(
    f.engine.calls
      .slice(calls.length)
      .filter((call) => ['loadQueue', 'play', 'seek'].includes(call)),
    []
  )
})

test('the business observer follows committed native/session state, never snapshot reads or cancelled source previews', async (t) => {
  const samples: {
    id: string | null
    occurrence: string | undefined
    state: string
    position: number
    cueRange: TrackData['cueRange']
  }[] = []
  let slow = false,
    resolving!: () => void
  const started = new Promise<void>((resolve) => {
    resolving = resolve
  })
  const f = await fixture(
    t,
    {
      resolve: async (track, signal) => {
        if (!slow) return { source: (track as TrackData).filePath, expiresAt: null }
        resolving()
        return new Promise((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        )
      }
    },
    (error) => assert.fail(error.message),
    (track, info) =>
      samples.push({
        id: track?.id ?? null,
        occurrence: track?.queueEntryId,
        state: info.state,
        position: info.position,
        cueRange: track?.cueRange
      })
  )
  await f.session.fromQuery({ sort: 'title' }, 'a', true)
  const playing = samples.at(-1)!
  assert.equal(playing.id, 'a')
  assert.equal(playing.state, 'playing')
  assert.ok(playing.occurrence)
  assert.equal(playing.cueRange?.startSeconds, 10)
  const before = samples.length
  for (let i = 0; i < 5; i++) f.session.snapshot()
  assert.equal(samples.length, before)
  slow = true
  const pending = f.session.navigate(1)
  await started
  await f.session.pause()
  await assert.rejects(pending)
  assert.equal(samples.at(-1)!.id, 'a')
  assert.equal(samples.at(-1)!.state, 'paused')
  assert.ok(
    !samples.some((sample) => sample.id === 'b'),
    'the failed candidate must not contribute history'
  )
})

test('Core owns a bounded SQL/native session; UI observers reconnect without playback commands or identity changes', async (t) => {
  const { engine, session } = await fixture(t)
  await session.fromQuery({ ids: ['a', 'b', 'a'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  const before = session.snapshot()
  const calls = [...engine.calls]
  for (let i = 0; i < 50; i++) {
    const attached = session.snapshot()
    assert.equal(attached.queue?.occurrenceId, before.queue?.occurrenceId)
    assert.equal(attached.playback?.position, before.playback?.position)
  }
  assert.deepEqual(engine.calls, calls)
  assert.ok(engine.items.length <= 2)
  assert.deepEqual(engine.items[0].cueRange, { startSeconds: 10, endSeconds: 70 })
  assert.equal('source' in session.snapshot().playback!, false)
})
test('workspace capture samples the authoritative occurrence and position without Play, Seek or LoadQueue', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ sort: 'title' }, 'a')
  f.engine.info.position = 18.5
  const before = [...f.engine.calls]
  const capture = await f.session.captureWorkspace()
  assert.equal(capture.position, 18.5)
  assert.equal(capture.reference.entryId, f.session.snapshot().queue!.occurrenceId)
  assert.equal(capture.reference.revision, f.session.snapshot().queue!.revision)
  assert.deepEqual(f.engine.calls, before)
})

test('slow provider preview is cancelled by Pause without dispatching a late LoadQueue or Play', async (t) => {
  let started!: () => void
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled = false
  const { engine, session } = await fixture(t, {
    resolve: async (_track, signal) => {
      started()
      return new Promise((resolve) =>
        signal!.addEventListener(
          'abort',
          () => {
            cancelled = true
            resolve(null)
          },
          { once: true }
        )
      )
    }
  })
  const play = session.fromQuery({ ids: ['a'], sort: 'playlist' }, undefined)
  const failed = assert.rejects(play, /superseded/)
  await pending
  await session.pause()
  await failed
  assert.equal(cancelled, true)
  assert.deepEqual(
    engine.calls.filter((c) => ['pause', 'play', 'loadQueue'].includes(c)),
    ['pause']
  )
})
test('native EOF changes the exact CUE occurrence and SQL cursor without another Play, Seek or LoadQueue', async (t) => {
  const { session, engine } = await fixture(t)
  await session.fromQuery({ ids: ['a', 'b', 'a'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  assert.equal(engine.items.length, 2)
  const target = engine.items[1]
  const before = engine.calls.filter((c) => ['play', 'seek', 'loadQueue'].includes(c))
  engine.info = {
    ...engine.info,
    queueIndex: 1,
    source: target.source,
    position: 2,
    state: 'playing'
  }
  engine.emit('playback-info', engine.info)
  await tick()
  await tick()
  await tick()
  const snapshot = session.snapshot()
  assert.equal(snapshot.track?.id, 'b')
  assert.equal(snapshot.queue?.occurrenceId, target.queueEntryId)
  assert.equal(snapshot.queue?.index, 1)
  assert.deepEqual(
    engine.calls.filter((c) => ['play', 'seek', 'loadQueue'].includes(c)),
    before
  )
})
test('an unknown native load outcome stops safely and is never retried on a timer', async (t) => {
  const { session, engine } = await fixture(t)
  engine.failLoad = true
  await assert.rejects(session.fromQuery({ ids: ['a'], sort: 'playlist' }, undefined), /Reply lost/)
  await tick()
  await tick()
  assert.equal(engine.calls.filter((c) => c === 'loadQueue').length, 1)
  assert.equal(engine.calls.filter((c) => c === 'play').length, 0)
  assert.ok(engine.calls.includes('stop'))
  assert.match(session.snapshot().error!, /Reply lost/)
})
test('cold restore remains paused and attaches durable occurrence/position without loading or playing', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, undefined)
  await f.session.seek(23)
  await f.session.flush()
  const before = f.saved!.data!
  await f.session.shutdown()
  const restored = f.create()
  const calls = f.engine.calls.length
  await restored.initialize()
  assert.equal(restored.snapshot().queue?.occurrenceId, before.libraryQueue?.entryId)
  assert.equal(restored.snapshot().playback?.position, 23)
  assert.equal(restored.snapshot().playback?.state, 'paused')
  assert.deepEqual(f.engine.calls.slice(calls), ['start'])
  await restored.shutdown()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('replacing a running queue keeps the old owner throughout a slow preview; Pause cancels the candidate', async (t) => {
  const entered = deferred<void>()
  const f = await fixture(t, {
    resolve: async (track, signal) => {
      if ((track as TrackData).id !== 'b')
        return { source: String((track as TrackData).filePath), expiresAt: null }
      entered.resolve()
      return new Promise((resolve) =>
        signal!.addEventListener('abort', () => resolve(null), { once: true })
      )
    }
  })
  await f.session.fromQuery({ ids: ['a'], sort: 'playlist' }, undefined)
  const before = f.session.snapshot()
  const calls = [...f.engine.calls]
  const replace = f.session.fromQuery({ ids: ['b'], sort: 'playlist' }, undefined)
  const failed = assert.rejects(replace, /superseded/)
  await entered.promise
  assert.deepEqual(f.session.snapshot().queue, before.queue)
  assert.equal(f.session.snapshot().track?.id, 'a')
  await f.session.pause()
  await failed
  assert.deepEqual(f.session.snapshot().queue, before.queue)
  assert.equal(f.session.snapshot().track?.id, 'a')
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.deepEqual(
    f.engine.calls
      .slice(calls.length)
      .filter((c) => ['play', 'seek', 'loadQueue', 'pause'].includes(c)),
    ['pause']
  )
})

test('manual Next resolves outside the transport lane and Pause preserves the confirmed occurrence', async (t) => {
  const entered = deferred<void>()
  let slow = false
  const f = await fixture(t, {
    resolve: async (track, signal) => {
      if (!slow) return { source: String((track as TrackData).filePath), expiresAt: null }
      entered.resolve()
      return new Promise((resolve) =>
        signal!.addEventListener('abort', () => resolve(null), { once: true })
      )
    }
  })
  await f.session.fromQuery({ ids: ['a', 'b', 'a'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  const before = f.session.snapshot()
  const calls = [...f.engine.calls]
  slow = true
  const next = f.session.navigate(1)
  const rejected = assert.rejects(next, /superseded/)
  await entered.promise
  await f.session.pause()
  await rejected
  assert.deepEqual(f.session.snapshot().queue, before.queue)
  assert.equal(f.session.snapshot().track?.queueEntryId, before.track?.queueEntryId)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.deepEqual(
    f.engine.calls
      .slice(calls.length)
      .filter((c) => ['play', 'seek', 'loadQueue', 'pause'].includes(c)),
    ['pause']
  )
})

test('a stale displayed queue revision is rejected before any native mutation', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  const queue = f.session.snapshot().queue!
  const calls = [...f.engine.calls]
  await assert.rejects(
    f.session.select({ ...queue, revision: queue.revision + 1, occurrenceId: queue.occurrenceId! }),
    { code: 'STALE_REVISION' }
  )
  await assert.rejects(f.session.edit(queue.id, queue.revision + 1, { kind: 'clear' }), {
    code: 'STALE_REVISION'
  })
  assert.deepEqual(f.engine.calls, calls)
})

test('native EOF during a slow manual preview wins its occurrence fence without a stale Play or SQL cursor overwrite', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  let slow = false
  const f = await fixture(t, {
    resolve: async (track) => {
      if (slow) {
        entered.resolve()
        await release.promise
      }
      return { source: String((track as TrackData).filePath), expiresAt: null }
    }
  })
  await f.session.fromQuery({ ids: ['a', 'b', 'a'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  const before = f.session.snapshot().queue!
  const target = f.db.readLibraryQueue(before.id, 2, 1).items[0]
  const calls = [...f.engine.calls]
  slow = true
  const selection = f.session.select({
    id: before.id,
    revision: before.revision,
    index: 2,
    occurrenceId: target.queueEntryId
  })
  const rejected = assert.rejects(selection, { code: 'STALE_REVISION' })
  await entered.promise
  const next = f.engine.items[1]
  f.engine.info = { ...f.engine.info, queueIndex: 1, source: next.source, position: 3 }
  f.engine.emit('playback-info', f.engine.info)
  await tick()
  await tick()
  release.resolve()
  await rejected
  assert.equal(f.session.snapshot().queue?.occurrenceId, next.queueEntryId)
  assert.equal(f.session.snapshot().track?.id, 'b')
  assert.deepEqual(
    f.engine.calls.slice(calls.length).filter((c) => ['play', 'seek', 'loadQueue'].includes(c)),
    []
  )
})

test('queue membership edits and undo keep the same decoder/position; removing the selected row chooses a paused successor', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a', 'b', 'a'], sort: 'playlist' }, undefined)
  await f.session.seek(23)
  await tick()
  await tick()
  const before = f.session.snapshot().queue!
  const calls = [...f.engine.calls]
  const row = f.db.readLibraryQueue(before.id, 2, 1).items[0]
  await f.session.edit(before.id, before.revision, { kind: 'remove', entryIds: [row.queueEntryId] })
  let state = f.session.snapshot()
  assert.equal(state.queue?.occurrenceId, before.occurrenceId)
  assert.equal(state.playback?.position, 23)
  assert.equal(state.queue?.total, 2)
  await f.session.edit(before.id, state.queue!.revision, { kind: 'undo' })
  state = f.session.snapshot()
  assert.equal(state.queue?.total, 3)
  assert.equal(state.queue?.occurrenceId, before.occurrenceId)
  assert.equal(state.playback?.position, 23)
  assert.deepEqual(
    f.engine.calls.slice(calls.length).filter((c) => ['play', 'seek', 'loadQueue'].includes(c)),
    []
  )
  await f.session.edit(before.id, state.queue!.revision, {
    kind: 'remove',
    entryIds: [before.occurrenceId!]
  })
  state = f.session.snapshot()
  assert.equal(state.track?.id, 'b')
  assert.equal(state.playback?.state, 'paused')
  assert.equal(state.playback?.position, 0)
  assert.deepEqual(
    f.engine.calls.slice(calls.length).filter((c) => ['play', 'seek', 'loadQueue'].includes(c)),
    []
  )
  assert.equal(f.saved?.data?.track?.queueEntryId, state.queue?.occurrenceId)
})

test('lost SQL edit replies require an explicit stopped read recovery and never replay the edit', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a', 'b', 'a'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  const before = f.session.snapshot().queue!
  const target = f.db.readLibraryQueue(before.id, 2, 1).items[0]
  const edit = f.queues.editQueue
  let writes = 0
  f.queues.editQueue = async (...args) => {
    const result = await edit(...args)
    writes++
    if (args[2].kind === 'remove') throw new Error('Lost edit reply')
    return result
  }
  await assert.rejects(
    f.session.edit(before.id, before.revision, { kind: 'remove', entryIds: [target.queueEntryId] }),
    /Lost edit reply/
  )
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.equal(writes, 1)
  const calls = [...f.engine.calls]
  await f.session.refresh()
  assert.equal(f.session.snapshot().queue?.total, 2)
  assert.equal(f.session.snapshot().queue?.occurrenceId, before.occurrenceId)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().error, null)
  assert.equal(writes, 1)
  assert.deepEqual(
    f.engine.calls.slice(calls.length).filter((c) => ['play', 'seek', 'loadQueue'].includes(c)),
    []
  )
})

test('an unknown Pause result stops safely rather than leaving an unacknowledged playing session', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({ ids: ['a'], sort: 'playlist' }, undefined)
  const calls = [...f.engine.calls]
  f.engine.pause = async () => {
    throw new Error('Lost native Pause reply')
  }
  await assert.rejects(f.session.pause(), /Lost native Pause reply/)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  assert.match(f.session.snapshot().error!, /Pause reply/)
  assert.equal(f.engine.calls.slice(calls.length).filter((call) => call === 'stop').length, 1)
  assert.deepEqual(
    f.engine.calls
      .slice(calls.length)
      .filter((call) => ['loadQueue', 'play', 'seek'].includes(call)),
    []
  )
})

test('failure to confirm silence notifies main once and observation failure does not leave an unhandled promise', async (t) => {
  const fatal: Error[] = []
  const f = await fixture(t, undefined, (error) => fatal.push(error))
  await f.session.fromQuery({ ids: ['a'], sort: 'playlist' }, undefined)
  await tick()
  await tick()
  const getInfo = f.engine.getPlaybackInfo.bind(f.engine),
    stop = f.engine.stop.bind(f.engine)
  f.engine.getPlaybackInfo = async () => {
    throw new Error('Native observation lost')
  }
  f.engine.stop = async () => {
    throw new Error('Native Stop lost')
  }
  f.engine.emit('playback-info', f.engine.info)
  for (let i = 0; i < 5 && !fatal.length; i++) await tick()
  assert.equal(fatal.length, 1)
  assert.match(fatal[0].message, /Cannot confirm audio stopped/)
  assert.match(f.session.snapshot().error!, /Cannot confirm audio stopped/)
  f.engine.getPlaybackInfo = getInfo
  f.engine.stop = stop
  await f.session.refresh()
  assert.equal(f.session.snapshot().playback?.state, 'paused')
})

const repairTrack = (id: string): TrackData => ({
  ...recommended(1),
  id,
  source: id.split(':')[0],
  ncmSongId: undefined,
  filePath: ''
})
async function repairFixture(t: test.TestContext, extra: Partial<PlaybackSourceRecovery> = {}) {
  const repairs: Array<[string, string]> = []
  const sources: PlaybackSourceRecovery = {
    prepare: async (track) => {
      const current =
        track.id === 'expired:one'
          ? { ...repairTrack('other:one'), queueEntryId: track.queueEntryId }
          : track
      return {
        track: current,
        resolved: { source: `https://audio.test/${current.id}`, expiresAt: null }
      }
    },
    repaired: async (previous, next) => {
      repairs.push([previous.id, next.id])
    },
    ...extra
  }
  const f = await fixture(t, undefined, undefined, undefined, undefined, undefined, sources)
  return { ...f, sources, repairs }
}
const seedRepairs = (
  f: Awaited<ReturnType<typeof repairFixture>>,
  ids: string[],
  options: Parameters<CorePlaybackSession['fromPages']>[1] = {}
) =>
  f.session.fromPages(async (append) => {
    await append(ids.map((id) => ({ id, snapshot: { ...repairTrack(id) } })))
  }, options)

test('source recovery commits only the selected SQL occurrence, preserves duplicates and original order, and cold restore never resolves or plays', async (t) => {
  const f = await repairFixture(t)
  await seedRepairs(f, ['expired:one', 'expired:one', 'good:one'], {
    selectedIndex: 1,
    mode: 'repeat'
  })
  const snapshot = f.session.snapshot(),
    queue = snapshot.queue!
  assert.equal(snapshot.track?.id, 'other:one')
  const page = f.db.readLibraryQueue(queue.id)
  assert.deepEqual(
    page.items.map((row) => row.track?.id),
    ['expired:one', 'other:one', 'good:one']
  )
  assert.equal(page.items[1].queueEntryId, queue.occurrenceId)
  assert.equal(f.engine.items[0].queueEntryId, queue.occurrenceId)
  assert.equal(f.engine.items[0].id, 'other:one')
  assert.deepEqual(f.repairs, [['expired:one', 'other:one']])
  assert.doesNotMatch(JSON.stringify(page), /audio.test/)
  await f.session.seek(19)
  await f.session.shutdown()
  const calls = [...f.engine.calls]
  f.sources.prepare = async () => assert.fail('cold restore must not prepare a source')
  const cold = f.create()
  await cold.initialize()
  assert.equal(cold.snapshot().track?.id, 'other:one')
  assert.equal(cold.snapshot().queue?.occurrenceId, queue.occurrenceId)
  assert.equal(cold.snapshot().playback?.state, 'paused')
  assert.equal(cold.snapshot().playback?.position, 19)
  assert.deepEqual(f.engine.calls.slice(calls.length), ['start'])
  await cold.shutdown()
})

test('explicit selection commits the repaired identity before selecting its native occurrence and rejects the old revision', async (t) => {
  const f = await repairFixture(t)
  await seedRepairs(f, ['good:one', 'expired:one'], { mode: 'repeat' })
  const before = f.session.snapshot().queue!
  const target = f.db.readLibraryQueue(before.id).items[1]
  const command = { ...before, index: 1, occurrenceId: target.queueEntryId }
  await f.session.select(command)
  const after = f.session.snapshot().queue!
  assert.equal(after.revision, before.revision + 2)
  assert.equal(after.occurrenceId, target.queueEntryId)
  assert.equal(f.engine.items[0].id, 'other:one')
  assert.equal(f.session.snapshot().track?.id, 'other:one')
  await assert.rejects(f.session.select(command), { code: 'STALE_REVISION' })
  assert.deepEqual(f.repairs, [['expired:one', 'other:one']])
})

test('a prepared source repair rebases a valid queue undo instead of resurrecting the expired identity', async (t) => {
  const f = await repairFixture(t)
  await seedRepairs(f, ['expired:one', 'good:one', 'good:two'], { play: false, mode: 'repeat' })
  let queue = f.session.snapshot().queue!
  const initial = f.db.readLibraryQueue(queue.id).items
  await f.session.edit(queue.id, queue.revision, {
    kind: 'move',
    entryId: initial[2].queueEntryId,
    beforeEntryId: initial[1].queueEntryId
  })
  await f.session.play()
  queue = f.session.snapshot().queue!
  assert.deepEqual(
    f.db.readLibraryQueue(queue.id).items.map((row) => row.track?.id),
    ['other:one', 'good:two', 'good:one']
  )
  await f.session.edit(queue.id, queue.revision, { kind: 'undo' })
  assert.deepEqual(
    f.db.readLibraryQueue(queue.id).items.map((row) => row.track?.id),
    ['other:one', 'good:one', 'good:two']
  )
  assert.equal(f.session.snapshot().queue?.occurrenceId, initial[0].queueEntryId)
})

test('lookahead repairs SQL and native metadata without restarting the current decoder; native advance consumes that same occurrence', async (t) => {
  const f = await repairFixture(t)
  await seedRepairs(f, ['good:one', 'expired:one'])
  const before = f.session.snapshot().queue!,
    calls = transportCalls(f.engine)
  f.engine.info.position = 27
  for (let i = 0; i < 30 && f.engine.items[1]?.id !== 'other:one'; i++) await tick()
  const target = f.db.readLibraryQueue(before.id).items[1]
  assert.equal(target.track?.id, 'other:one')
  assert.equal(f.engine.items[1]?.id, 'other:one')
  assert.equal(f.engine.info.position, 27)
  assert.deepEqual(transportCalls(f.engine), calls)
  f.engine.info = { ...f.engine.info, queueIndex: 1, source: f.engine.items[1].source, position: 0 }
  f.engine.emit('playback-info', f.engine.info)
  for (let i = 0; i < 15 && f.session.snapshot().track?.id !== 'other:one'; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'other:one')
  assert.equal(f.session.snapshot().queue?.occurrenceId, target.queueEntryId)
  assert.deepEqual(f.repairs, [['expired:one', 'other:one']])
  assert.deepEqual(transportCalls(f.engine), calls)
})

test('slow lookahead recovery can finish at native EOF and repeat can replace the source without changing the occurrence', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  const f = await repairFixture(t)
  const prepare = f.sources.prepare
  f.sources.prepare = async (track, signal) => {
    if (track.id === 'expired:one') {
      entered.resolve()
      await release.promise
    }
    return prepare(track, signal)
  }
  await seedRepairs(f, ['good:one', 'expired:one'])
  await entered.promise
  const selected = f.engine.items[0]
  f.engine.info.state = 'stopped'
  f.engine.end = {
    intent: 1,
    selection: { queueToken: f.engine.token, index: 0, id: selected.id, source: selected.source }
  }
  release.resolve()
  for (let i = 0; i < 40 && f.session.snapshot().track?.id !== 'other:one'; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'other:one')
  assert.equal(f.engine.calls.filter((call) => call === 'continueAfterPlaybackEnd').length, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
  await f.session.setMode('repeat')
  const before = f.session.snapshot().queue!,
    current = f.engine.items[0]
  f.sources.prepare = async (track) => ({
    track: { ...repairTrack('third:one'), queueEntryId: track.queueEntryId },
    resolved: { source: 'https://audio.test/third', expiresAt: null }
  })
  f.engine.info.state = 'stopped'
  f.engine.end = {
    intent: 2,
    selection: { queueToken: f.engine.token, index: 0, id: current.id, source: current.source }
  }
  f.engine.emit('playback-info', f.engine.info)
  for (let i = 0; i < 40 && f.session.snapshot().track?.id !== 'third:one'; i++) await tick()
  assert.equal(f.session.snapshot().track?.id, 'third:one')
  assert.equal(f.session.snapshot().queue?.occurrenceId, before.occurrenceId)
  assert.equal(f.engine.items[0].id, 'third:one')
})

test('Pause cancels slow source rematching before any source identity write or native load', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  const f = await repairFixture(t)
  await seedRepairs(f, ['good:one'], { mode: 'repeat' })
  const before = f.session.snapshot(),
    calls = transportCalls(f.engine),
    prepare = f.sources.prepare
  f.sources.prepare = async (track, signal) => {
    if (track.id === 'expired:one') {
      entered.resolve()
      await release.promise
    }
    return prepare(track, signal)
  }
  const next = seedRepairs(f, ['expired:one']),
    cancelled = assert.rejects(next, { code: 'CANCELLED' })
  await entered.promise
  await f.session.pause()
  assert.equal(f.session.snapshot().queue?.id, before.queue?.id)
  release.resolve()
  await cancelled
  assert.deepEqual(f.repairs, [])
  assert.deepEqual(transportCalls(f.engine), [...calls, 'pause'])
})

test('lost SQL source-repair replies stop without Load/Play or write replay; explicit read recovery adopts the committed source paused', async (t) => {
  const f = await repairFixture(t)
  let writes = 0
  const replace = f.queues.replaceSource!
  f.queues.replaceSource = async (command) => {
    writes++
    await replace(command)
    throw new Error('Lost source repair reply')
  }
  await seedRepairs(f, ['expired:one'], { play: false, mode: 'repeat' })
  const calls = transportCalls(f.engine)
  await assert.rejects(f.session.play(), /Lost source repair reply/)
  assert.equal(writes, 1)
  assert.deepEqual(transportCalls(f.engine), [...calls, 'stop'])
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  await f.session.refresh()
  assert.equal(f.session.snapshot().track?.id, 'other:one')
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(writes, 1)
})

test('a lost native reply after lookahead source repair confirms silence and never retries its committed write or handoff', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  const f = await repairFixture(t),
    prepare = f.sources.prepare
  f.sources.prepare = async (track, signal) => {
    if (track.id === 'expired:one') {
      entered.resolve()
      await release.promise
    }
    return prepare(track, signal)
  }
  await seedRepairs(f, ['good:one', 'expired:one'])
  await entered.promise
  const rebind = f.engine.rebindQueue.bind(f.engine)
  let writes = 0
  f.engine.rebindQueue = async (request) => {
    const result = await rebind(request)
    if (request.items.some((item) => item.id === 'other:one')) {
      writes++
      throw new Error('Lost repaired native rebind reply')
    }
    return result
  }
  release.resolve()
  for (let i = 0; i < 30 && !f.session.snapshot().error; i++) await tick()
  assert.match(f.session.snapshot().error!, /Lost repaired native rebind reply/)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
  for (let i = 0; i < 10; i++) {
    f.engine.emit('playback-info', f.engine.info)
    await tick()
  }
  assert.equal(writes, 1)
  assert.deepEqual(f.repairs, [['expired:one', 'other:one']])
  const queue = f.session.snapshot().queue!
  assert.equal(f.db.readLibraryQueue(queue.id).items[1].track?.id, 'other:one')
  await f.session.refresh()
  assert.equal(f.session.snapshot().track?.id, 'good:one')
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(writes, 1)
})

test('a negative native Play ACK permits one new source after confirmed Stop, while lost Play replies never invoke recovery', async (t) => {
  const f = await repairFixture(t)
  let recoveries = 0
  f.sources.recover = async (track) => {
    recoveries++
    return {
      track: { ...repairTrack('other:one'), queueEntryId: track.queueEntryId },
      resolved: { source: 'https://audio.test/other:one', expiresAt: null }
    }
  }
  const play = f.engine.play.bind(f.engine)
  f.engine.play = async (...args) => {
    if (args[0].includes('good:one')) {
      f.engine.calls.push('rejectedPlay')
      return { nativeStarted: false, fallbackReason: 'decoder rejected source' }
    }
    return play(...args)
  }
  await seedRepairs(f, ['good:one'], { mode: 'repeat' })
  assert.equal(recoveries, 1)
  assert.equal(f.session.snapshot().track?.id, 'other:one')
  assert.equal(f.session.snapshot().playback?.state, 'playing')
  assert.deepEqual(f.repairs, [['good:one', 'other:one']])
  assert.equal(f.engine.calls.filter((call) => call === 'stop').length, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 2)
  f.engine.play = async (...args) => {
    await play(...args)
    throw new Error('Lost Play reply')
  }
  await f.session.pause()
  await assert.rejects(f.session.play(), /Lost Play reply/)
  assert.equal(recoveries, 1)
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
})

test('source recovery after a rejected resume retains its selected occurrence and position without a Seek', async (t) => {
  const f = await repairFixture(t)
  await seedRepairs(f, ['good:one'], { mode: 'repeat' })
  await f.session.seek(23)
  await f.session.pause()
  const before = f.session.snapshot().queue!,
    calls = [...f.engine.calls]
  f.sources.recover = async (track) => ({
    track: { ...repairTrack('other:one'), queueEntryId: track.queueEntryId },
    resolved: { source: 'https://audio.test/other:one', expiresAt: null }
  })
  const play = f.engine.play.bind(f.engine)
  f.engine.play = async (...args) =>
    args[0].includes('good:one')
      ? { nativeStarted: false, fallbackReason: 'cached URL expired' }
      : play(...args)
  await f.session.play()
  assert.equal(f.session.snapshot().track?.id, 'other:one')
  assert.equal(f.session.snapshot().queue?.occurrenceId, before.occurrenceId)
  assert.equal(f.engine.info.position, 23)
  assert.equal(f.engine.calls.slice(calls.length).includes('seek'), false)
})

test('Pause cancels slow rematching after a known native source rejection, and a second rejected source is not retried', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>()
  const f = await repairFixture(t)
  f.sources.recover = async (track) => {
    entered.resolve()
    await release.promise
    return {
      track: { ...repairTrack('other:one'), queueEntryId: track.queueEntryId },
      resolved: { source: 'https://audio.test/other:one', expiresAt: null }
    }
  }
  f.engine.play = async () => ({ nativeStarted: false, fallbackReason: 'unreadable' })
  const selecting = seedRepairs(f, ['good:one'], { mode: 'repeat' }),
    cancelled = assert.rejects(selecting, { code: 'CANCELLED' })
  await entered.promise
  await f.session.pause()
  release.resolve()
  await cancelled
  assert.deepEqual(f.repairs, [])
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1)
  await assert.rejects(f.session.play(), /Native playback did not start/)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 3)
  assert.deepEqual(f.repairs, [['good:one', 'other:one']])
})

test('recording preference changes during durable source repair fence LoadQueue and lookahead rebind', async (t) => {
  for (const lookahead of [false, true]) {
    let revision = 0
    const f = await repairFixture(t, {
      repaired: async () => {
        revision++
      }
    })
    const prepare = f.sources.prepare
    f.sources.prepare = async (track, signal) => {
      const source = await prepare(track, signal),
        expected = revision
      return {
        ...source,
        confirm: () => {
          if (revision !== expected)
            throw Object.assign(new Error('Recording preferences changed'), {
              code: 'STALE_REVISION'
            })
        }
      }
    }
    if (lookahead) {
      await seedRepairs(f, ['good:one', 'expired:one'])
      for (let i = 0; i < 30 && !f.session.snapshot().error; i++) await tick()
      assert.match(f.session.snapshot().error!, /Recording preferences changed/)
      assert.equal(
        f.engine.items.some((item) => item.id === 'other:one'),
        false
      )
      assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1)
    } else {
      await assert.rejects(seedRepairs(f, ['expired:one']), { code: 'STALE_REVISION' })
      assert.equal(f.engine.calls.includes('loadQueue'), false)
    }
    assert.equal(f.session.snapshot().playback?.state, 'stopped')
    await f.session.shutdown()
  }
})

test('automatic cache maintenance waits through source resolution and native load without cancelling the playback intent', async (t) => {
  const resources = new SourceResources(),
    entered = deferred<void>(),
    release = deferred<void>()
  const f = await fixture(
    t,
    {
      resolve: async () => {
        entered.resolve()
        await release.promise
        return { source: 'D:/cache/current.flac', expiresAt: null }
      }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resources
  )
  const selecting = f.session.fromQuery({ ids: ['a'] }, 'a', false)
  await entered.promise
  let sampled = false
  const pruning = resources.maintain(async () => {
    sampled = true
    assert.equal(f.engine.items[0].source, 'D:/cache/current.flac')
    assert.equal(f.session.snapshot().queue?.occurrenceId, f.engine.items[0].queueEntryId)
  })
  await tick()
  assert.equal(sampled, false)
  release.resolve()
  await Promise.all([selecting, pruning])
  assert.equal(sampled, true)
  assert.equal(f.engine.calls.includes('stop'), false)
})

test('Pause remains responsive while cache maintenance gates new source loads, and the old request is not dispatched afterwards', async (t) => {
  const resources = new SourceResources(),
    entered = deferred<void>(),
    release = deferred<void>()
  const f = await fixture(
    t,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resources
  )
  await f.session.fromQuery({ ids: ['a'] }, 'a', false)
  const calls = transportCalls(f.engine)
  const clearing = f.session.maintainSources((pins) =>
    resources.maintain(async () => {
      assert.ok(pins.includes('D:/Music/disc.flac'))
      entered.resolve()
      await release.promise
    })
  )
  await entered.promise
  const selecting = f.session.fromQuery({ ids: ['b'] }, 'b', false),
    cancelled = assert.rejects(selecting, { code: 'CANCELLED' })
  await tick()
  await f.session.pause()
  assert.deepEqual(transportCalls(f.engine), [...calls, 'pause'])
  release.resolve()
  await clearing
  await cancelled
  assert.deepEqual(transportCalls(f.engine), [...calls, 'pause'])
})

for (const control of ['pause', 'seek'] as const) {
  test(`${control} during lookahead ACK preserves the committed mapping across maintenance restart`, async (t) => {
    const f = await fixture(t)
    const entered = deferred<void>(),
      release = deferred<void>()
    const rebind = f.engine.rebindQueue.bind(f.engine)
    f.engine.rebindQueue = async (request) => {
      const result = await rebind(request)
      if (request.items.length === 2) {
        entered.resolve()
        await release.promise
      }
      return result
    }
    await f.session.fromQuery({ ids: ['a', 'b'], sort: 'playlist' }, 'a')
    await entered.promise
    const controlling = control === 'pause' ? f.session.pause() : f.session.seek(12)
    release.resolve()
    await controlling
    if (control === 'pause') await f.session.play()
    await tick()
    assert.equal(f.session.snapshot().error, null)
    assert.equal(f.engine.items.length, 2)
    // The successor must remain mappable after the old maintainer was revoked.
    const next = f.engine.items[1]
    f.engine.info = { ...f.engine.info, queueIndex: 1, source: next.source, position: 0 }
    f.engine.emit('playback-info', f.engine.info)
    await tick()
    assert.equal(f.session.snapshot().track?.id, 'b')
    assert.equal(f.session.snapshot().queue?.index, 1)
    assert.equal(f.session.snapshot().error, null)
    assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1)
  })
}

test('lookahead holds its resource lease until native rebind ACK, so pruning sees both acknowledged sources', async (t) => {
  const resources = new SourceResources(),
    entered = deferred<void>(),
    release = deferred<void>()
  const f = await fixture(
    t,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resources
  )
  const rebind = f.engine.rebindQueue.bind(f.engine)
  f.engine.rebindQueue = async (request) => {
    if (request.items.length === 2) {
      entered.resolve()
      await release.promise
    }
    return rebind(request)
  }
  await f.session.fromQuery({}, 'a')
  await entered.promise
  let sampled = false
  const pruning = resources.maintain(async () => {
    sampled = true
    assert.equal(f.engine.items.length, 2)
  })
  await tick()
  assert.equal(sampled, false)
  release.resolve()
  await pruning
  assert.equal(sampled, true)
})

test('explicit cache maintenance cancels and drains an existing source lease before deleting files', async (t) => {
  const resources = new SourceResources(),
    entered = deferred<void>(),
    release = deferred<void>()
  let delayed = true
  const f = await fixture(
    t,
    {
      resolve: async (track) => {
        if ((track as TrackData).id === 'b' && delayed) {
          entered.resolve()
          await release.promise
        }
        return { source: (track as TrackData).filePath, expiresAt: null }
      }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resources
  )
  await f.session.fromQuery({ ids: ['a'] }, 'a', false)
  const before = f.session.snapshot().queue!,
    calls = transportCalls(f.engine)
  const selecting = f.session.fromQuery({ ids: ['b'] }, 'b', false),
    cancelled = assert.rejects(selecting, { code: 'CANCELLED' })
  await entered.promise
  let deleted = false
  const clearing = f.session.maintainSources((pins) =>
    resources.maintain(async () => {
      deleted = true
      assert.ok(pins.includes('D:/Music/disc.flac'))
    })
  )
  await tick()
  assert.equal(deleted, false)
  await f.session.pause()
  release.resolve()
  await Promise.all([clearing, cancelled])
  assert.equal(deleted, true)
  assert.equal(f.session.snapshot().queue?.id, before.id)
  assert.deepEqual(transportCalls(f.engine), [...calls, 'pause'])
  delayed = false
  await f.session.fromQuery({ ids: ['b'] }, 'b', false)
  assert.equal(f.session.snapshot().track?.id, 'b')
})

test('a rejected native resume acquires its source lease before rematching', async (t) => {
  const resources = new SourceResources(),
    entered = deferred<void>(),
    release = deferred<void>()
  let rematched = false
  const sources: PlaybackSourceRecovery = {
    prepare: async (track) => ({
      track,
      resolved: { source: track.filePath, expiresAt: null }
    }),
    recover: async (track) => {
      rematched = true
      return { track, resolved: { source: track.filePath, expiresAt: null } }
    }
  }
  const f = await fixture(
    t,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sources,
    resources
  )
  await f.session.fromQuery({ ids: ['a'] }, 'a')
  await f.session.pause()
  const pruning = resources.maintain(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const play = f.engine.play.bind(f.engine)
  let rejected = false
  f.engine.play = async (...args) => {
    if (!rejected) {
      rejected = true
      return { nativeStarted: false, fallbackReason: 'expired cache source' }
    }
    return play(...args)
  }
  const resuming = f.session.play()
  await tick()
  assert.equal(rejected, true)
  assert.equal(rematched, false)
  release.resolve()
  await Promise.all([pruning, resuming])
  assert.equal(rematched, true)
  assert.equal(f.session.snapshot().playback?.state, 'playing')
})

test('all music load/play/pause/stop entry points use the output-test transport boundary', async (t) => {
  let inside = false,
    dispatches = 0
  const f = await fixture(
    t,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (action) => {
      inside = true
      dispatches++
      try {
        return await action()
      } finally {
        inside = false
      }
    }
  )
  const restore: (() => void)[] = []
  for (const method of ['loadQueue', 'play', 'pause', 'stop'] as const) {
    const original = f.engine[method].bind(f.engine) as (...args: any[]) => Promise<any>
    restore.push(() => {
      ;(f.engine[method] as (...args: any[]) => Promise<any>) = original
    })
    ;(f.engine[method] as (...args: any[]) => Promise<any>) = async (...args) => {
      assert.equal(inside, true, method)
      return original(...args)
    }
  }
  await f.session.fromQuery({}, 'a')
  await f.session.pause()
  await f.session.play()
  await f.session.navigate(1)
  await f.session.fromTrack(recommended(9), 0, false)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  await f.session.refresh()
  await f.session.stop()
  assert.ok(dispatches >= 5)
  for (const reset of restore) reset()
})

test('unified preparation tries equivalent candidates once before staging a single selected occurrence', async (t) => {
  const prepared: string[] = []
  let liveQueueId: string | null = null
  let inspect = false
  const f = await fixture(t, undefined, undefined, undefined, undefined, undefined, {
    prepare: async (track) => {
      prepared.push(track.id)
      if (inspect) {
        assert.equal(f.session.snapshot().queue?.id, liveQueueId)
        assert.equal(track.sourceSelection, 'explicit')
      }
      if (track.id === 'ncm:1') throw new Error('First equivalent source unavailable')
      return { track, resolved: { source: `https://audio.test/${track.id}`, expiresAt: null } }
    },
    recover: async () => assert.fail('unified playback must not use legacy automatic recovery')
  })
  await f.session.fromTrack(recommended(9))
  liveQueueId = f.session.snapshot().queue!.id
  prepared.length = 0
  inspect = true
  const before = f.engine.calls.length
  const result = await f.session.fromUnifiedTrack(async (_signal, prepare) => {
    await assert.rejects(prepare(recommended(1)), /First equivalent source/)
    return { prepared: await prepare(recommended(2)), result: 'source-two' }
  })
  inspect = false
  assert.equal(result, 'source-two')
  assert.deepEqual(prepared, ['ncm:1', 'ncm:2'])
  assert.notEqual(f.session.snapshot().queue?.id, liveQueueId)
  assert.equal(f.session.snapshot().track?.id, 'ncm:2')
  assert.equal(f.engine.items[0].queueEntryId, f.session.snapshot().queue?.occurrenceId)
  assert.equal(f.saved?.data?.track?.sourceSelection, 'explicit')
  assert.equal(f.engine.calls.slice(before).filter((call) => call === 'loadQueue').length, 1)
  assert.equal(f.engine.calls.slice(before).filter((call) => call === 'play').length, 1)
})

test('unified all-source failure and commit-time stale scope preserve the previous queue without native writes', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  const queue = f.session.snapshot().queue
  const calls = transportCalls(f.engine)
  const result = await f.session.fromUnifiedTrack(async () => ({ prepared: null, result: 'unavailable' }))
  assert.equal(result, 'unavailable')
  assert.deepEqual(f.session.snapshot().queue, queue)
  assert.deepEqual(transportCalls(f.engine), calls)
  await assert.rejects(f.session.fromUnifiedTrack(async (_signal, prepare) => ({
    prepared: await prepare(recommended(1)), result: 'not-committed'
  }), undefined, async () => {
    throw Object.assign(new Error('Frozen scope expired'), { code: 'STALE_REVISION' })
  }), { code: 'STALE_REVISION' })
  assert.deepEqual(f.session.snapshot().queue, queue)
  assert.deepEqual(transportCalls(f.engine), calls)
  assert.equal(f.session.snapshot().loading, false)
})

test('unified native rejection stops once and never prepares a replacement after a committed load', async (t) => {
  let preparations = 0
  const f = await fixture(t, undefined, undefined, undefined, undefined, undefined, {
    prepare: async (track) => {
      preparations++
      return { track, resolved: { source: 'https://audio.test/selected', expiresAt: null } }
    },
    recover: async () => assert.fail('native rejection cannot switch unified versions or sources')
  })
  f.engine.play = async () => {
    f.engine.calls.push('play')
    return { nativeStarted: false, fallbackReason: 'decoder rejected selected source' }
  }
  await assert.rejects(f.session.fromUnifiedTrack(async (_signal, prepare) => ({
    prepared: await prepare(recommended(1)), result: 'selected'
  })), /decoder rejected selected source/)
  assert.equal(preparations, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'loadQueue').length, 1)
  assert.equal(f.engine.calls.filter((call) => call === 'play').length, 1)
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
  assert.equal(f.session.snapshot().playback?.state, 'stopped')
})

test('unified preparation is cancellable by Pause and does not adopt a late successful candidate', async (t) => {
  const entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  const queue = f.session.snapshot().queue
  const old = f.session.fromUnifiedTrack(async (signal, prepare) => {
    entered.resolve()
    await release.promise
    signal.throwIfAborted()
    return { prepared: await prepare(recommended(1)), result: 'cancelled' }
  })
  const rejected = assert.rejects(old, /superseded/)
  await entered.promise
  await f.session.pause()
  release.resolve()
  await rejected
  assert.deepEqual(f.session.snapshot().queue, queue)
  assert.equal(f.session.snapshot().playback?.state, 'paused')
  assert.equal(f.session.snapshot().loading, false)
})

test('unified source resource lease spans preparation and commit without a nested maintenance deadlock', async (t) => {
  const resources = new SourceResources(), entered = deferred<void>(), release = deferred<void>()
  let maintenanceRan = false
  const f = await fixture(t, undefined, undefined, undefined, undefined, undefined, undefined, resources)
  const playback = f.session.fromUnifiedTrack(async (_signal, prepare) => {
    const prepared = await prepare(recommended(1))
    entered.resolve()
    await release.promise
    assert.equal(maintenanceRan, false)
    return { prepared, result: 'selected' }
  })
  await entered.promise
  const maintaining = resources.maintain(async () => {
    maintenanceRan = true
    assert.equal(f.session.snapshot().track?.id, 'ncm:1')
    assert.equal(f.session.snapshot().playback?.state, 'playing')
  })
  release.resolve()
  await Promise.all([playback, maintaining])
  assert.equal(maintenanceRan, true)
})

test('switching between duplicate occurrences or replacing the queue samples the departing occurrence before activating the next', async (t) => {
  const observed: Array<{ id: string | null; occurrenceId: string | null; position: number; state: string }> = []
  const f = await fixture(t, undefined, undefined, (track, info) => {
    observed.push({
      id: track?.id ?? null,
      occurrenceId: track?.queueEntryId ?? null,
      position: info.position,
      state: info.state
    })
  })
  const podcastEpisode: TrackData = {
    id: 'podcast:sub-1:ep-1',
    title: 'Episode 1',
    artist: 'Show',
    album: 'Show',
    duration: 180,
    filePath: 'https://audio.test/ep-1.mp3',
    fileName: 'ep-1.mp3',
    size: 0,
    cover: null,
    lyrics: null,
    streamUrl: 'https://audio.test/ep-1.mp3',
    source: 'podcast'
  }
  await f.session.fromPages(async (append) => {
    await append([
      { id: podcastEpisode.id, snapshot: { ...podcastEpisode } },
      { id: podcastEpisode.id, snapshot: { ...podcastEpisode } }
    ])
  })
  const queue = f.session.snapshot().queue!
  const page = f.db.readLibraryQueue(queue.id)
  const firstOccurrence = page.items[0].queueEntryId
  const secondOccurrence = page.items[1].queueEntryId
  assert.notEqual(firstOccurrence, secondOccurrence)

  f.engine.info.position = 47
  await f.session.select({
    id: queue.id,
    revision: queue.revision,
    index: 1,
    occurrenceId: secondOccurrence
  })
  assert.equal(
    observed.some(
      (item) => item.id === podcastEpisode.id && item.occurrenceId === firstOccurrence && item.position === 47
    ),
    true
  )

  f.engine.info.position = 83
  await f.session.fromPages(async (append) => {
    await append([{ id: 'a' }])
  })
  assert.equal(
    observed.some(
      (item) => item.id === podcastEpisode.id && item.occurrenceId === secondOccurrence && item.position === 83
    ),
    true
  )
})

test('unified playback waits for explicit source maintenance before acquiring its source lease', async (t) => {
  const resources = new SourceResources(), entered = deferred<void>(), release = deferred<void>()
  const f = await fixture(t, undefined, undefined, undefined, undefined, undefined, undefined, resources)
  let maintained = false
  const maintenance = f.session.maintainSources(async () => {
    entered.resolve()
    await release.promise
    await resources.maintain(async () => { maintained = true })
  })
  await entered.promise
  const playback = f.session.fromUnifiedTrack(async (_signal, prepare) => {
    assert.equal(maintained, true)
    return { prepared: await prepare(recommended(1)), result: 'selected' }
  })
  release.resolve()
  await Promise.all([maintenance, playback])
  assert.equal(f.session.snapshot().track?.id, 'ncm:1')
})


test('shutdown preserves the persisted libraryQueue when engine.stop emits playback-info or flush runs after shutdown', async (t) => {
  const f = await fixture(t)
  await f.session.fromQuery({}, 'a')
  const queueId = f.session.snapshot().queue!.id
  f.engine.info.position = 37
  const originalStop = f.engine.stop.bind(f.engine)
  f.engine.stop = async () => {
    await originalStop()
    f.engine.info = { ...f.engine.info, state: 'stopped', position: 0 }
    f.engine.emit('playback-info', f.engine.info)
  }
  await f.session.shutdown()
  await f.session.flush()
  assert.equal(f.saved?.data?.libraryQueue?.id, queueId)
  assert.equal(f.saved?.data?.position, 37)

  const cold = f.create()
  await cold.initialize()
  assert.equal(cold.snapshot().queue?.id, queueId)
  assert.equal(cold.snapshot().queue?.total, 2)
  assert.equal(cold.snapshot().track?.id, 'a')
  assert.equal(cold.snapshot().playback?.position, 37)
  await cold.shutdown()
})
