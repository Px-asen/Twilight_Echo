import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreZoneRegistry, type ZoneRuntime } from './zoneRegistry.ts'
import type { CorePlaybackSession } from './session.ts'
import { isCoreRequest } from '../../shared/coreProtocol.ts'

const signal = () => new AbortController().signal
function runtime() {
  let state = 'stopped', plays = 0, pauses = 0, stops = 0, closed = false
  let pendingPlay: Promise<void> | undefined
  const output = { supported: true, hosting: false, receiving: false, selected: true,
    connected: true, peerName: null, error: null, receiver: null }
  const playback = {
    snapshot: () => ({ playback: { state }, track: null, queue: null, error: null }),
    play: async () => { plays++; await pendingPlay; state = 'playing' },
    pause: async () => { pauses++; state = 'paused' }, stop: async () => { stops++; state = 'stopped' },
    maintainSources: async <T>(action: (sources: string[]) => Promise<T>) => action(['active.flac'])
  } as unknown as CorePlaybackSession
  const value: ZoneRuntime = { playback, dsp: {} as ZoneRuntime['dsp'], output: async () => ({ ...output }),
    connect: async () => { throw new Error('Bridge connection refused') }, sources: () => ['active.flac'],
    close: async () => { closed = true } }
  return { value, get plays() { return plays }, get pauses() { return pauses }, get stops() { return stops }, get closed() { return closed },
    slowPlay: (promise: Promise<void>) => { pendingPlay = promise } }
}

test('Zone topology is bounded, revision fenced, credential-free and independent of legacy local state', async t => {
  const local = runtime(), created: ReturnType<typeof runtime>[] = []
  let stored: unknown = []
  const zones = new CoreZoneRegistry({ local: local.value, load: async () => [], save: async data => { stored = data },
    create: async () => { const next = runtime(); created.push(next); return next.value }, newId: randomUUID, changed: () => {} })
  t.after(() => zones.shutdown())
  await zones.initialize()
  const a = await zones.create('Study', 0)
  await assert.rejects(zones.create('Stale', 0), { code: 'STALE_REVISION' })
  const b = await zones.create('Bedroom', 1)
  await zones.create('Kitchen', 2)
  await assert.rejects(zones.create('Too many', 3), { code: 'BUSY' })
  assert.equal((await zones.list()).zones.length, 4)
  assert.doesNotMatch(JSON.stringify(stored), /token|fingerprint|host|filePath/)
  await assert.rejects(zones.connect(a, { host: 'localhost', port: 1234, token: 'a'.repeat(48), fingerprint: 'b'.repeat(64) }, 0), /refused/)
  await zones.transport(b, 0, { kind: 'pause' }, signal())
  assert.equal(created[1].pauses, 1)
  assert.equal(local.pauses, 0)
  assert.equal(local.stops, 0)
  assert.match((await zones.list()).zones.find(z => z.id === a)!.error!, /连接未成功/)
  await zones.remove(a, 3)
  assert.equal(created[0].closed, true)
  assert.equal((await zones.list()).zones.length, 3)
})

test('a slow Zone Play never queues a different Zone Pause or same-Zone Stop', async t => {
  const local = runtime(), remote = runtime()
  let finish!: () => void
  remote.slowPlay(new Promise(resolve => { finish = resolve }))
  const zones = new CoreZoneRegistry({ local: local.value, load: async () => [], save: async () => {},
    create: async () => remote.value, newId: randomUUID, changed: () => {} })
  t.after(() => zones.shutdown())
  const id = await zones.create('Study', 0)
  const pending = zones.transport(id, 0, { kind: 'play' }, signal())
  await zones.transport('local', 0, { kind: 'pause' }, signal())
  await zones.transport(id, null, { kind: 'stop' }, signal())
  assert.equal(local.pauses, 1)
  assert.equal(remote.stops, 1)
  finish(); await pending
})

test('Stop during slow output preflight cannot be followed by a late resurrected Play', async t => {
  const local = runtime(), remote = runtime()
  const output = await remote.value.output()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  remote.value.output = async () => { await gate; return output }
  const zones = new CoreZoneRegistry({ local: local.value, load: async () => [], save: async () => {},
    create: async () => remote.value, newId: randomUUID, changed: () => {} })
  t.after(() => zones.shutdown())
  const id = await zones.create('Study', 0)
  const pending = zones.transport(id, 0, { kind: 'play' }, signal())
  const rejected = assert.rejects(pending, { code: 'CANCELLED' })
  await zones.transport(id, null, { kind: 'stop' }, signal())
  finish(); await rejected
  assert.equal(remote.stops, 1)
  assert.equal(remote.plays, 0)
  let finishMaintenance!: () => void
  const maintenanceGate = new Promise<void>(resolve => { finishMaintenance = resolve })
  remote.value.output = async () => { await maintenanceGate; return output }
  const beforeMaintenance = zones.transport(id, 2, { kind: 'play' }, signal())
  const cancelled = assert.rejects(beforeMaintenance, { code: 'CANCELLED' })
  await zones.maintainSources(async sources => { assert.ok(sources.includes('active.flac')) })
  finishMaintenance(); await cancelled
  assert.equal(remote.plays, 0)
})

test('one failed restored Zone is visible offline; corrupt topology cannot overwrite saved zones', async t => {
  const id = `zone-${randomUUID()}`, local = runtime()
  const zones = new CoreZoneRegistry({ local: local.value, load: async () => [{ id, name: 'Offline' }], save: async () => {},
    create: async () => { throw Error('Failed native start') }, newId: randomUUID, changed: () => {} })
  t.after(() => zones.shutdown())
  await zones.initialize()
  assert.equal((await zones.list()).zones.length, 2)
  assert.match((await zones.list()).zones[1].error!, /初始化失败/)
  await zones.transport('local', 0, { kind: 'pause' }, signal())
  const corrupt = new CoreZoneRegistry({ local: local.value, load: async () => { throw Error('Corrupt catalog') },
    save: async () => assert.fail('Do not overwrite corrupt topology'), create: async () => local.value,
    newId: randomUUID, changed: () => {} })
  t.after(() => corrupt.shutdown())
  await corrupt.initialize()
  assert.match((await corrupt.list()).error!, /清单无法读取/)
  await assert.rejects(corrupt.create('Replacement', 0), { code: 'NOT_READY' })
})

test('explicit reconnect retires a fatally failed Zone before creating its paused replacement', async t => {
  const local = runtime(), failed = runtime(), replacement = runtime()
  let creations = 0, connections = 0
  failed.value.failed = () => true
  failed.value.connect = async () => assert.fail('A destroyed engine cannot reconnect')
  replacement.value.connect = async () => { connections++ }
  const zones = new CoreZoneRegistry({ local: local.value, load: async () => [], save: async () => {},
    create: async () => { creations++; if (creations > 1) assert.equal(failed.closed, true); return creations === 1 ? failed.value : replacement.value },
    newId: randomUUID, changed: () => {} })
  t.after(() => zones.shutdown())
  const id = await zones.create('Study', 0)
  await zones.connect(id, { host: 'localhost', port: 1234, token: 'a'.repeat(48), fingerprint: 'b'.repeat(64) }, 0)
  assert.equal(creations, 2); assert.equal(connections, 1)
  assert.equal(local.stops, 0)
})

test('multi-Zone public requests reject arbitrary IDs, actions, files and malformed consent', () => {
  const id = `zone-${randomUUID()}`
  const request = (name: string, payload: unknown) => isCoreRequest({ kind: 'command', name, payload, requestId: 'test', epoch: 'epoch' })
  assert.equal(request('zones.create', { revision: 0, name: 'Study' }), true)
  assert.equal(request('zones.transport', { zoneId: id, revision: 0, action: { kind: 'volume', volume: 0.2 } }), true)
  assert.equal(request('zones.transport', { zoneId: id, revision: null, action: { kind: 'stop' } }), true)
  assert.equal(request('zones.transport', { zoneId: id, revision: null, action: { kind: 'play' } }), false)
  assert.equal(request('zones.transport', { zoneId: id, revision: null, action: { kind: 'volume', volume: 0 } }), false)
  assert.equal(request('zones.transport', { zoneId: '../../settings', revision: 0, action: { kind: 'play' } }), false)
  assert.equal(request('zones.transport', { zoneId: id, revision: 0, action: { kind: 'Play', source: 'secret.flac' } }), false)
  assert.equal(request('zones.dsp.edit', { zoneId: id, revision: 0, edit: { kind: 'processing', settings: { convolverIrPath: 'secret.wav' } } }), false)
  assert.equal(request('zones.create', { revision: 0, name: 'Study', token: 'secret' }), false)
  const handoff = { source: { zoneId: 'local', revision: 0, queue: { id: 'queue-a', revision: 2, occurrenceId: 'first' } },
    target: { zoneId: id, revision: 1, queue: null }, replace: false, resume: false }
  assert.equal(request('zones.handoff', handoff), true)
  assert.equal(request('zones.handoff', { ...handoff, resume: 'true' }), false)
  assert.equal(request('zones.handoff', { ...handoff, target: handoff.source }), false)
  assert.equal(request('zones.handoff', { ...handoff, source: { ...handoff.source, queue: { ...handoff.source.queue, filePath: 'injected' } } }), false)
})
