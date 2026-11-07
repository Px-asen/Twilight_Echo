import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreProjection, type CoreConnection } from './coreProjection.ts'
import type {
  CoreClientMessage,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../../shared/coreProtocol.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const state = (epoch = 'first', sequence = 0): CoreSnapshot => ({
  libraryRevision: 0,
  loading: false,
  isStreamBuffering: false,
  presentationRevision: null,
  pluginsRevision: null,
  abLoop: null,
  mute: null,
  inbox: null,
  cloudTransfers: null,
  modelPack: null,
  libraryLoudness: null,
  loudness: null,
  protocolVersion: 1,
  epoch,
  sequence,
  phase: 'ready',
  playback: null,
  track: null,
  queue: null,
  error: null,
  migrationRequired: false,
  cast: null,
  scan: null,
  statisticsRevision: null,
  playlistsRevision: null,
  versionsRevision: null,
  audioRevision: null,
  settingsRevision: null,
  sleepTimer: null,
  bookmarksRevision: null,
  lyricsRevision: null,
  lyricsContentRevision: null,
  workspaceRevision: null,
  workspaceContentRevision: null,
  streams: null,
  network: null,
  downloads: null,
  personalized: null,
  heart: null
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { resolve, reject, promise }
}
function fixture() {
  let listener: (message: CoreClientMessage) => void = () => {}
  let current = state(),
    reads = 0,
    serial = 0,
    subscribers = 0
  const changed: CoreSnapshot[] = [],
    errors: Error[] = [],
    requests: CoreRequestEnvelope[] = []
  const connection: CoreConnection = {
    connect: async () => {
      reads++
      return current
    },
    subscribe: (fn) => {
      subscribers++
      listener = fn
      return () => {
        subscribers--
        listener = () => {}
      }
    },
    request: async (request) => {
      requests.push(request)
      return undefined
    }
  }
  const projection = new CoreProjection(
    connection,
    (s) => changed.push(s),
    () => `client:${++serial}`,
    (e) => errors.push(e)
  )
  return {
    connection,
    projection,
    requests,
    changed,
    errors,
    emit(s: CoreSnapshot) {
      listener({ kind: 'state', epoch: s.epoch, sequence: s.sequence, snapshot: s })
    },
    set state(s: CoreSnapshot) {
      current = s
    },
    get reads() {
      return reads
    },
    get subscribers() {
      return subscribers
    }
  }
}

test('client subscribes before reading a snapshot, catches a raced event and exposes an immutable projection', async () => {
  const f = fixture(),
    gate = deferred<CoreSnapshot>()
  f.connection.connect = () => gate.promise
  const attach = f.projection.attach()
  assert.equal(f.subscribers, 1)
  f.emit(state('first', 1))
  gate.resolve(state())
  await attach
  assert.equal(f.projection.snapshot()?.sequence, 1)
  assert.throws(() => {
    f.projection.snapshot()!.sequence = 10
  }, TypeError)
  f.projection.dispose()
  assert.equal(f.subscribers, 0)
  assert.deepEqual(f.requests, [])
})

test('duplicates are ignored, sequence gaps re-read once, and retired epoch events cannot roll state back', async () => {
  const f = fixture()
  await f.projection.attach()
  f.emit(state('first', 1))
  f.emit(state('first', 1))
  assert.equal(f.changed.length, 2)
  f.state = state('first', 4)
  f.emit(state('first', 4))
  await tick()
  assert.equal(f.reads, 2)
  assert.equal(f.projection.snapshot()?.sequence, 4)
  f.state = state('second', 0)
  f.emit(state('second', 0))
  await tick()
  assert.equal(f.projection.snapshot()?.epoch, 'second')
  f.emit(state('first', 5))
  await tick()
  assert.equal(f.reads, 3)
  assert.equal(f.projection.snapshot()?.epoch, 'second')
  assert.deepEqual(f.requests, [])
})

test('synchronous consumers can query the newly attached snapshot during publication', async () => {
  const requests: CoreRequestEnvelope[] = []
  let snapshot = state()
  let read: Promise<unknown> | undefined
  const projection = new CoreProjection({
    connect: async () => snapshot,
    subscribe: () => () => {},
    request: async request => { requests.push(request); return {} }
  }, () => { read = projection.query('statistics.overview', {}) })
  await projection.attach()
  await read
  snapshot = state('restarted')
  await projection.refresh()
  await read
  assert.deepEqual(requests.map(request => request.epoch), ['first', 'restarted'])
  projection.dispose()
})

test('failed reconnect reports its error and blocks all commands until an explicit successful attachment', async () => {
  const f = fixture()
  await f.projection.attach()
  f.connection.connect = async () => {
    throw new Error('Core unavailable')
  }
  f.emit(state('second', 0))
  await tick()
  assert.match(f.errors[0].message, /unavailable/)
  await assert.rejects(f.projection.command('playback.pause', {}), /not attached/)
  await assert.rejects(
    f.projection.query('queue.page', { id: 'q', revision: 0, offset: 0 }),
    /not attached/
  )
  f.connection.connect = async () => state('second', 0)
  await f.projection.attach()
  await f.projection.command('playback.pause', {})
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].epoch, 'second')
})

test('unknown writes and late old-epoch replies are never replayed or delivered as a new Core result', async () => {
  const f = fixture(),
    reply = deferred<unknown>()
  await f.projection.attach()
  f.connection.request = async (request) => {
    f.requests.push(request)
    return reply.promise
  }
  const command = f.projection.command('queue.undo', { id: 'q', revision: 3 })
  const rejected = assert.rejects(command, { code: 'OUTCOME_UNKNOWN' })
  f.state = state('second', 0)
  f.emit(state('second', 0))
  await tick()
  reply.resolve({ changed: true })
  await rejected
  assert.equal(f.requests.length, 1)
  f.connection.request = async (request) => {
    f.requests.push(request)
    throw Object.assign(new Error('Reply lost'), { code: 'OUTCOME_UNKNOWN' })
  }
  await assert.rejects(f.projection.command('queue.undo', { id: 'q', revision: 4 }), {
    code: 'OUTCOME_UNKNOWN'
  })
  assert.equal(f.requests.length, 2)
})

test('disposing during connect fences the late snapshot and does not resurrect listeners', async () => {
  const f = fixture(),
    gate = deferred<CoreSnapshot>()
  f.connection.connect = () => gate.promise
  const attaching = f.projection.attach()
  f.projection.dispose()
  gate.resolve(state())
  await assert.rejects(attaching, /detached/)
  assert.deepEqual(f.changed, [])
  assert.equal(f.subscribers, 0)
  assert.equal(f.projection.snapshot(), null)
})

for (const code of ['STALE_EPOCH', 'NOT_READY']) {
  test(`${code} invalidates the attachment and refreshes state without replaying a command`, async () => {
    const f = fixture(),
      gate = deferred<CoreSnapshot>()
    await f.projection.attach()
    f.connection.connect = () => gate.promise
    f.connection.request = async (request) => {
      f.requests.push(request)
      throw Object.assign(new Error(code), { code })
    }
    await assert.rejects(f.projection.command('playback.pause', {}), { code })
    await assert.rejects(f.projection.command('playback.stop', {}), /not attached/)
    gate.resolve(state('second'))
    await tick()
    assert.equal(f.projection.snapshot()?.epoch, 'second')
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].name, 'playback.pause')
  })
}
