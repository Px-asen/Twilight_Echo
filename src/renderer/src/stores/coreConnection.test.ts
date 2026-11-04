import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoreConnectionStore, CoreWindowConnection } from './coreConnection.ts'
import type {
  CoreBridgeApi,
  CoreBridgeConnected,
  CoreBridgeMessage,
  CoreBridgeReply,
  CoreBridgeStatus
} from '../../../shared/coreBridge.ts'
import type { CoreRequestEnvelope, CoreSnapshot } from '../../../shared/coreProtocol.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('Focus supplies a known command request ID and reconciles with a read instead of replaying', async () => {
  const f = fixture(), store = createCoreConnectionStore(f.api)
  try {
    await store.attach()
    const payload = { query: { version: 1 as const, entity: 'recording' as const }, token: {} } as import('../../../shared/musicFocus.ts').MusicFocusPlay
    await store.command('focus.play', payload, undefined, 'focus-intent-one')
    await store.query('focus.play.status', { requestId: 'focus-intent-one', epoch: 'first' })
    assert.equal(f.requests[0].requestId, 'focus-intent-one')
    assert.equal(f.requests[0].name, 'focus.play')
    assert.equal(f.requests[1].name, 'focus.play.status')
    assert.deepEqual(f.requests[1].payload, { requestId: 'focus-intent-one', epoch: 'first' })
    assert.equal(f.requests.filter(r => r.name === 'focus.play').length, 1)
  } finally { store.dispose() }
})
const snapshot = (sequence = 0, epoch = 'first') =>
  ({ protocolVersion: 1, epoch, sequence, phase: 'ready' }) as CoreSnapshot
function fixture() {
  const messages = new Set<(event: CoreBridgeMessage) => void>(),
    statuses = new Set<(event: CoreBridgeStatus) => void>()
  const requests: CoreRequestEnvelope[] = [],
    cancellations: unknown[] = [],
    disconnected: string[] = []
  let state = snapshot(),
    reads = 0
  const api: CoreBridgeApi = {
    connect: async () => {
      reads++
      return { ok: true, value: { connectionId: 'window-1', snapshot: state } }
    },
    request: async (_id, request) => {
      requests.push(request)
      return { ok: true, value: null }
    },
    cancel: async (...args) => {
      cancellations.push(args)
      return { ok: true, value: undefined }
    },
    disconnect: async (id) => {
      disconnected.push(id)
      return { ok: true, value: undefined }
    },
    onMessage: (listener) => {
      messages.add(listener)
      return () => {
        messages.delete(listener)
      }
    },
    onStatus: (listener) => {
      statuses.add(listener)
      return () => {
        statuses.delete(listener)
      }
    }
  }
  return {
    api,
    requests,
    disconnected,
    cancellations,
    messages,
    statuses,
    emit(value = state, connectionId = 'window-1') {
      for (const listener of messages)
        listener({
          connectionId,
          message: { kind: 'state', epoch: value.epoch, sequence: value.sequence, snapshot: value }
        })
    },
    set state(value: CoreSnapshot) {
      state = value
    },
    get reads() {
      return reads
    }
  }
}

test('store attaches explicitly and catches an event raced with the first immutable snapshot', async () => {
  const f = fixture(),
    store = createCoreConnectionStore(f.api)
  assert.equal(f.reads, 0)
  assert.equal(Boolean(store.state.value), false)
  let release!: (reply: CoreBridgeReply<CoreBridgeConnected>) => void
  f.api.connect = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const attached = store.attach()
  f.emit(snapshot(1))
  release({ ok: true, value: { connectionId: 'window-1', snapshot: snapshot() } })
  await attached
  assert.equal(store.state.value?.sequence, 1)
  assert.equal(Object.isFrozen(store.state.value), true)
  f.emit(snapshot(2), 'obsolete-document')
  assert.equal(store.state.value?.sequence, 1)
  store.dispose()
  assert.deepEqual(f.disconnected, ['window-1'])
  assert.equal(f.messages.size + f.statuses.size, 0)
})

test('gaps and new epochs reread snapshots without replaying commands or losing structured errors', async () => {
  const f = fixture(),
    store = createCoreConnectionStore(f.api)
  await store.attach()
  f.api.request = async (_id, request) => {
    f.requests.push(request)
    return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'reply was lost' } }
  }
  await assert.rejects(store.command('playback.pause', {}), { code: 'OUTCOME_UNKNOWN' })
  f.state = snapshot(4)
  f.emit()
  await tick()
  assert.equal(f.reads, 2)
  assert.equal(store.state.value?.sequence, 4)
  f.state = snapshot(0, 'second')
  f.emit()
  await tick()
  assert.equal(store.state.value?.epoch, 'second')
  assert.equal(f.requests.length, 1)
  store.dispose()
})

test('abort is scoped to its document and disposal retires a late first connection', async () => {
  const f = fixture(),
    connection = new CoreWindowConnection(f.api)
  await connection.connect()
  const controller = new AbortController()
  let release!: (reply: CoreBridgeReply<unknown>) => void
  f.api.request = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const request: CoreRequestEnvelope = {
    kind: 'query',
    name: 'state.snapshot',
    epoch: 'first',
    requestId: 'one',
    payload: {}
  }
  const pending = connection.request(request, controller.signal)
  controller.abort()
  assert.deepEqual(f.cancellations, [['window-1', 'one']])
  release({ ok: false, error: { code: 'CANCELLED', message: 'cancelled' } })
  await assert.rejects(pending, { code: 'CANCELLED' })
  connection.dispose()

  let attached!: (reply: CoreBridgeReply<CoreBridgeConnected>) => void
  f.api.connect = () =>
    new Promise((resolve) => {
      attached = resolve
    })
  const fresh = new CoreWindowConnection(f.api),
    attaching = fresh.connect()
  fresh.dispose()
  attached({ ok: true, value: { connectionId: 'late', snapshot: snapshot() } })
  await assert.rejects(attaching, /disposed/)
  assert.deepEqual(f.disconnected, ['window-1', 'late'])
})

test('status changes during initial attach are retained and foreign statuses are ignored', async () => {
  const f = fixture(),
    store = createCoreConnectionStore(f.api)
  let release!: (reply: CoreBridgeReply<CoreBridgeConnected>) => void
  f.api.connect = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const attached = store.attach()
  for (const listener of f.statuses)
    listener({ connectionId: 'window-1', phase: 'recovering', epoch: null })
  release({ ok: true, value: { connectionId: 'window-1', snapshot: snapshot() } })
  await attached
  assert.equal(store.status.value?.phase, 'recovering')
  for (const listener of f.statuses)
    listener({ connectionId: 'other', phase: 'ready', epoch: 'other' })
  assert.equal(store.status.value?.phase, 'recovering')
  store.dispose()
})

test('FFT events reach explicit consumers without becoming projection snapshots', async () => {
  const f = fixture(),
    store = createCoreConnectionStore(f.api)
  await store.attach()
  const kinds: string[] = []
  const unsubscribe = store.subscribe((message) => kinds.push(message.kind))
  for (const listener of f.messages)
    listener({
      connectionId: 'window-1',
      message: {
        kind: 'visualization',
        epoch: 'first',
        subscriptionId: 'fft',
        sequence: 1,
        data: null
      }
    })
  assert.deepEqual(kinds, ['visualization'])
  assert.equal(store.state.value?.sequence, 0)
  assert.equal(f.reads, 1)
  unsubscribe()
  store.dispose()
})

test('page readers are admitted within Core capacity, queued cancellation and disposal never dispatch', async () => {
  const f = fixture(), connection = new CoreWindowConnection(f.api)
  await connection.connect()
  const releases: Array<() => void> = []
  f.api.request = async (_id, request) => {
    f.requests.push(request)
    await new Promise<void>(resolve => releases.push(resolve))
    return { ok: true, value: null }
  }
  const request = (n: number, signal?: AbortSignal) => connection.request({
    kind: 'query', name: 'state.snapshot', epoch: 'first', requestId: String(n), payload: {}
  }, signal)
  const readers = Array.from({ length: 12 }, (_, i) => request(i))
  const cancelled = new AbortController()
  const aborted = request(12, cancelled.signal)
  const rejected = assert.rejects(aborted, { code: 'CANCELLED' })
  const queued = request(13)
  assert.equal(f.requests.length, 12)
  cancelled.abort()
  await rejected
  assert.deepEqual(f.cancellations, [])
  releases.shift()!()
  await tick()
  assert.equal(f.requests.at(-1)!.requestId, '13')
  assert.equal(f.requests.length, 13)
  const retired = request(14)
  const disposed = assert.rejects(retired, /disposed/)
  connection.dispose()
  await disposed
  for (const release of releases) release()
  await Promise.all([...readers, queued])
  assert.equal(f.requests.length, 13)
})

test('metadata reads leave capacity for playback controls, even with readers already waiting', async () => {
  const f = fixture(), connection = new CoreWindowConnection(f.api)
  await connection.connect()
  const releases = new Map<string, () => void>()
  f.api.request = async (_id, request) => {
    f.requests.push(request)
    await new Promise<void>(resolve => releases.set(request.requestId, resolve))
    return { ok: true, value: null }
  }
  const readers = Array.from({ length: 15 }, (_, i) => connection.request({
    kind: 'query', name: 'metadata.entity.tasks', epoch: 'first',
    requestId: `read:${i}`, payload: { limit: 10 }
  }))
  const controls = Array.from({ length: 5 }, (_, i) => connection.request({
    kind: 'command', name: 'playback.pause', epoch: 'first',
    requestId: `control:${i}`, payload: {}
  }))
  try {
    assert.equal(f.requests.filter(r => r.kind === 'query').length, 12)
    assert.equal(f.requests.filter(r => r.kind === 'command').length, 4,
      'pause must dispatch without waiting for metadata responses')
    assert.equal(releases.size, 16, 'never exceed Core\'s per-client capacity')
    releases.get('control:0')!()
    await tick()
    assert.equal(f.requests.at(-1)?.requestId, 'control:4')
    assert.equal(f.requests.some(r => r.requestId === 'read:12'), false)
  } finally {
    const settled = Promise.allSettled([...readers, ...controls])
    connection.dispose()
    for (const release of releases.values()) release()
    await settled
  }
})

test('starting a song and locating a queued occurrence also bypass saturated metadata readers', async () => {
  const f = fixture(), connection = new CoreWindowConnection(f.api)
  await connection.connect()
  const releases: Array<() => void> = []
  f.api.request = async (_id, request) => {
    f.requests.push(request)
    await new Promise<void>(resolve => releases.push(resolve))
    return { ok: true, value: null }
  }
  const readers = Array.from({ length: 12 }, (_, i) => connection.request({
    kind: 'query', name: 'metadata.entity.tasks', epoch: 'first', requestId: `read:${i}`, payload: {}
  }))
  const requests: CoreRequestEnvelope[] = [
    { kind: 'query', name: 'queue.locate', payload: { id: 'queue', revision: 1, occurrenceId: 'one' }, requestId: 'locate', epoch: 'first' },
    { kind: 'command', name: 'queue.fromQuery', payload: { query: {}, selectedId: 'one' }, requestId: 'library-play', epoch: 'first' },
    { kind: 'command', name: 'queue.submit', payload: { kind: 'begin', selectedIndex: 0, play: true }, requestId: 'submit', epoch: 'first' },
    { kind: 'command', name: 'catalog.play', payload: { sourceId: 'one', revision: 1 }, requestId: 'catalog-play', epoch: 'first' }
  ]
  const playing = requests.map(request => connection.request(request))
  try {
    assert.deepEqual(f.requests.slice(12), requests)
  } finally {
    const settled = Promise.allSettled([...readers, ...playing])
    connection.dispose()
    for (const release of releases) release()
    await settled
  }
})
