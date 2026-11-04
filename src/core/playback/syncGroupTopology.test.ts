import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreZoneRegistry, type ZoneRuntime } from './zoneRegistry.ts'
import { CorePlaybackSession, type CorePlaybackEngine } from './session.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { LibraryDatabaseServiceClient } from '../../main/library/libraryDatabaseServiceClient.ts'
import { createDefaultPlaybackInfo } from '../audio/audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../../shared/audioOutputConfig.ts'
import type { AudioEngineQueueItem, PlayMode } from '../../shared/audioEngineTypes.ts'
import type { NativeQueueRebind } from '../../shared/nativeQueue.ts'
import { playbackQueueApi, zoneCatalog } from '../../main/coreProcess/zoneRuntime.ts'
import { createSyncGroupRuntime, syncGroupCatalog } from '../../main/coreProcess/syncGroupRuntime.ts'
import { createCorePlaybackRepository } from '../../main/persistence/corePlaybackRepository.ts'
import { createPlaybackSessionStoreBundle } from '../../main/persistence/playbackSessionRepository.ts'
import { zoneQueueFence, type ZoneDescriptor } from '../../shared/coreZones.ts'
import type { SyncGroupCreate, SyncGroupDescriptor } from '../../shared/coreSyncGroups.ts'
import { isCoreRequest } from '../../shared/coreProtocol.ts'

const signal = () => new AbortController().signal
const peer = { host: 'localhost', port: 12345, token: 'a'.repeat(48), fingerprint: 'b'.repeat(64) }
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
const drain = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r)) }
class Engine extends EventEmitter implements CorePlaybackEngine {
  info = createDefaultPlaybackInfo('wasapi', '', false, normalizeOutputConfig())
  items: AudioEngineQueueItem[] = []; token = ''; plays = 0
  async start() {}
  async getPlaybackInfo() { return { ...this.info } }
  getQueueSnapshot() { return this.items }
  getQueueToken() { return this.token }
  getPlaybackEnd() { return null }
  async continueAfterPlaybackEnd() { return false }
  async loadQueue(items: AudioEngineQueueItem[], index = 0) {
    this.items = items; this.token = randomUUID(); this.info.queueIndex = index; this.info.source = items[index]?.source ?? ''
  }
  async rebindQueue(r: NativeQueueRebind) {
    if (r.expected.queueToken !== this.token) return null
    this.items = r.items; this.token = randomUUID(); this.info.queueIndex = r.startIndex; return { queueToken: this.token }
  }
  async play(source: string, position = 0, current?: () => boolean) {
    if (current?.() === false) return { nativeStarted: false, superseded: true, fallbackReason: '' }
    this.plays++; this.info = { ...this.info, source, position, state: 'playing' }; this.emit('playback-info', this.info)
    return { nativeStarted: true, fallbackReason: '' }
  }
  async pause() { this.info.state = 'paused'; this.emit('playback-info', { ...this.info }) }
  async stop() { this.info.state = 'stopped'; this.info.position = 0; this.emit('playback-info', { ...this.info }) }
  async seek(position: number) { this.info.position = position }
  async setVolume(volume: number) { this.info.volume = volume }
  async setPlayMode(mode: PlayMode) { this.info.playMode = mode }
  async setPlaybackRate(rate: number) { this.info.playbackRate = rate }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-group-topology-'))
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [
    { id: 'a', title: 'First', filePath: 'C:/a.flac', duration: 60 },
    { id: 'b', title: 'Second', filePath: 'C:/b.flac', duration: 60 }
  ] })
  const database = new Proxy(db, { get: (target, key) => {
    const method = Reflect.get(target, key)
    return typeof method === 'function' ? async (...args: unknown[]) => method.apply(target, args) : method
  } }) as unknown as LibraryDatabaseServiceClient
  const dependencies = { queues: playbackQueueApi(database),
    resolver: { resolve: async (track: unknown) => ({ source: (track as { filePath: string }).filePath, expiresAt: null }) },
    authorize: async (source: string) => source }
  const devices = new Map<string, Awaited<ReturnType<typeof device>>>()
  let factoryGate: Promise<void> | null = null, failSave = false, missing = false, onSave: (() => void) | null = null
  let local: ZoneRuntime, zones: CoreZoneRegistry
  async function device(descriptor: ZoneDescriptor) {
    const engine = new Engine()
    const playback = new CorePlaybackSession({ ...dependencies, engine,
      repository: createCorePlaybackRepository(createPlaybackSessionStoreBundle(join(root, descriptor.id)), database, `${descriptor.id}:persisted`),
      now: Date.now, resumeMode: () => 'trackAndPosition', schedule: () => () => {}, changed: () => {}, fatal: () => {} })
    await playback.initialize()
    let stopFails = false, stops = 0, connections = 0
    const bridge = { supported: true, hosting: false, receiving: false, selected: true, connected: false,
      peerName: null, error: null, receiver: null }
    const value: ZoneRuntime = { playback, dsp: {} as ZoneRuntime['dsp'], output: async () => ({ ...bridge }),
      groupOutput: { id: descriptor.id, downstreamDelayMs: 0,
        read: async () => ({ playback: await engine.getPlaybackInfo(), bridge: { ...bridge },
          dsp: { revision: 0, activeSceneId: null, totalLatencyFrames: 0, totalTailFrames: 0, nodes: [], applyState: 'applied', compileState: 'ready' } }),
        prepare: async () => assert.fail('Offline topology never opens a decoder'), arm: async () => assert.fail('No hardware arm'),
        silence: async () => { stops++; if (stopFails) throw Error('DAC stop unconfirmed'); await engine.pause() },
        volume: v => engine.setVolume(v) },
      connect: async (_peer, coordinated) => { connections++; assert.equal(coordinated, true); bridge.connected = true; stopFails = false },
      sources: () => engine.items.map(i => i.source), close: () => playback.shutdown() }
    const result = { value, engine, bridge, get stops() { return stops }, get connections() { return connections },
      stopFailure: (enabled: boolean) => { stopFails = enabled } }
    devices.set(descriptor.id, result); return result
  }
  async function start() {
    local = (await device({ id: 'local', name: 'Primary' })).value
    const groups = syncGroupCatalog(root)
    zones = new CoreZoneRegistry({ ...zoneCatalog(root), local, newId: randomUUID, changed: () => {},
      create: async descriptor => { if (missing) throw Error('Audio launch failed'); return (await device(descriptor)).value },
      groups: { ...groups, save: async data => { onSave?.(); if (failSave) throw Error('Catalog write failed'); await groups.save(data) },
        create: async (descriptor, outputs) => { await factoryGate; return createSyncGroupRuntime({ root, descriptor, outputs, database, playback: dependencies, changed: () => {} }) } } })
    await zones.initialize()
  }
  await start()
  t.after(async () => {
    factoryGate = null; failSave = false
    for (const device of devices.values()) device.stopFailure(false)
    await zones.shutdown(); await local.playback.shutdown(); db.close()
    await rm(root, { recursive: true, force: true })
  })
  const add = async () => zones.create('Study', (await zones.list()).revision)
  const prepare = async (id: string, ids = ['a','a','b']) => {
    const z = (await zones.list()).zones.find(z => z.id === id)!
    await zones.fromQuery(id, z.revision, { ids, sort: 'playlist' }, ids[0], signal())
  }
  async function command(id: string): Promise<SyncGroupCreate> {
    const view = await zones.list(), source = view.zones.find(z => z.id === id)!
    return { revision: view.revision, name: 'Whole home',
      members: view.zones.map(z => ({ zoneId: z.id, revision: z.revision, downstreamDelayMs: z.id === id ? 3 : 0 })),
      source: { zoneId: id, queue: zoneQueueFence(source.queue)! } }
  }
  return { root, db, devices, zones: () => zones, add, prepare, command,
    onSave: (action: (() => void) | null) => { onSave = action },
    slowFactory: (value: Promise<void>) => { factoryGate = value }, failSave: (value: boolean) => { failSave = value },
    restart: async (failZone = false) => { await zones.shutdown(); await local.playback.shutdown(); missing = failZone; await start() },
    restoreFactory: () => { missing = false } }
}

test('DSP scan pauses a group and blocks new playback while immediate Stop still works', async t => {
  const f = await fixture(t), id = await f.add()
  await f.prepare(id)
  const groupId = await f.zones().createGroup(await f.command(id), signal())
  let scanning = false
  const entered = gate(), finish = gate()
  const dsp = f.devices.get(id)!.value.dsp
  dsp.library = async () => ({}) as never
  dsp.editLibrary = async () => { entered.release(); await finish.promise; scanning = true }
  dsp.isPluginScanActive = () => scanning
  const edit = f.zones().editDspLibrary(id, 0, { kind: 'scan' }, signal())
  await entered.promise
  let group = (await f.zones().listGroups()).groups[0]
  assert.equal(group.playback?.state, 'paused')
  await assert.rejects(f.zones().groupTransport(groupId, group.revision, { kind: 'play' }, signal()), { code: 'BUSY' })
  await f.zones().groupTransport(groupId, null, { kind: 'stop' }, signal())
  finish.release(); await edit
  group = (await f.zones().listGroups()).groups[0]
  assert.equal(group.playback?.state, 'stopped')
})

test('explicit session queues read and edit their own SQL occurrences; grouped members cannot mutate frozen queues', async t => {
  const f = await fixture(t), id = await f.add()
  await f.prepare('local', ['b']); await f.prepare(id)
  const localQueue = (await f.zones().list()).zones[0].queue!.id
  let zone = (await f.zones().list()).zones.find(z => z.id === id)!
  await f.zones().loadQueue({ kind: 'zone', id, revision: zone.revision }, zoneQueueFence(zone.queue), false,
    async destination => destination.fromPages(async append => { await append([{ id: 'a' }, { id: 'a' }, { id: 'b' }]) }), signal())
  zone = (await f.zones().list()).zones.find(z => z.id === id)!
  const target = () => ({ kind: 'zone' as const, id, revision: zone.revision })
  const key = () => ({ id: zone.queue!.id, revision: zone.queue!.revision })
  let page = await f.zones().queuePage(target(), key(), 0)
  assert.equal(page.total, 3)
  assert.equal(page.items[0].track!.id, page.items[1].track!.id)
  assert.notEqual(page.items[0].queueEntryId, page.items[1].queueEntryId)
  assert.equal((await f.zones().list()).zones[0].queue!.id, localQueue)
  await assert.rejects(f.zones().queuePage(target(), { id: localQueue, revision: 1 }, 0), { code: 'STALE_REVISION' })
  await f.zones().queueEdit(target(), key(), { kind: 'remove', entryIds: [page.items[1].queueEntryId] })
  zone = (await f.zones().list()).zones.find(z => z.id === id)!
  page = await f.zones().queuePage(target(), key(), 0)
  assert.deepEqual(page.items.map(i => i.track!.id), ['a', 'b'])
  assert.equal(f.devices.get(id)!.engine.plays, 0)
  await assert.rejects(f.zones().queueSelect(target(), key(), 0, page.items[0].queueEntryId, signal()), { code: 'NOT_READY' })
  zone = (await f.zones().list()).zones.find(z => z.id === id)!
  const groupId = await f.zones().createGroup(await f.command(id), signal())
  const group = (await f.zones().listGroups()).groups.find(g => g.id === groupId)!
  const groupTarget = { kind: 'group' as const, id: groupId, revision: group.revision }
  const groupKey = { id: group.queue!.id, revision: group.queue!.revision }
  assert.equal((await f.zones().queuePage(groupTarget, groupKey, 0)).total, 2)
  await assert.rejects(f.zones().queueEdit(target(), key(), { kind: 'clear' }), { code: 'BUSY' })
  await f.zones().queueEdit(groupTarget, groupKey, { kind: 'clear' })
  const empty = (await f.zones().listGroups()).groups[0]
  assert.equal(empty.queue!.total, 0)
  assert.equal((await f.zones().list()).zones[0].queue!.id, localQueue)
})

test('session replacement confirms the observed queue and Stop cancels slow preparation without touching another zone', async t => {
  const f = await fixture(t), id = await f.add()
  await f.prepare('local', ['b']); await f.prepare(id, ['b'])
  let zone = (await f.zones().list()).zones.find(z => z.id === id)!
  const old = zone.queue!.id
  await assert.rejects(f.zones().loadQueue({ kind: 'zone', id, revision: zone.revision }, null, false,
    async () => assert.fail('No source reads before replacement confirmation'), signal()), { code: 'STALE_REVISION' })
  const pending = gate()
  const load = f.zones().loadQueue({ kind: 'zone', id, revision: zone.revision }, zoneQueueFence(zone.queue), false,
    async destination => destination.fromPages(async append => { await pending.promise; await append([{ id: 'a' }]) }), signal())
  const rejection = assert.rejects(load)
  await drain()
  await f.zones().transport(id, null, { kind: 'stop' }, signal())
  pending.release(); await rejection
  zone = (await f.zones().list()).zones.find(z => z.id === id)!
  assert.equal(zone.queue!.id, old)
  assert.equal(f.devices.get(id)!.engine.plays, 0)
  assert.equal((await f.zones().list()).zones[0].track!.id, 'b')
})

test('real SQLite group owns one cloned cursor, freezes independent events, and releases original paused queues', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare('local'); await f.prepare(id, ['b'])
  const original = (await f.zones().list()).zones.map(z => z.queue!.id)
  const groupId = await f.zones().createGroup(await f.command('local'), signal())
  const group = (await f.zones().listGroups()).groups[0]
  assert.equal(group.id, groupId); assert.equal(group.playback?.state, 'paused'); assert.equal(group.queue?.total, 3)
  assert.ok(!original.includes(group.queue!.id))
  assert.equal(f.db.readLibraryQueue(group.queue!.id, 0, 3).items.length, 3)
  for (const zone of (await f.zones().list()).zones) {
    assert.equal(zone.groupId, groupId)
    const d = f.devices.get(zone.id)!, before = d.value.playback.snapshot()
    d.engine.info.source = 'C:/group-media.flac'; d.engine.info.position = 40; d.engine.info.state = 'playing'
    d.engine.emit('playback-info', { ...d.engine.info }); await drain()
    assert.deepEqual(d.value.playback.snapshot().queue, before.queue)
    assert.equal(d.value.playback.snapshot().track?.id, before.track?.id)
    await assert.rejects(d.value.playback.play(), { code: 'BUSY' })
    await assert.rejects(d.value.playback.seek(2), { code: 'BUSY' })
    await assert.rejects(d.value.playback.edit(before.queue!.id, before.queue!.revision, { kind: 'clear' } as never), { code: 'BUSY' })
    await assert.rejects(f.zones().transport(zone.id, zone.revision, { kind: 'play' }, signal()), { code: 'BUSY' })
  }
  await f.devices.get('local')!.value.playback.pause()
  await f.devices.get(id)!.value.playback.stop()
  assert.ok(f.devices.get(id)!.stops >= 2)
  const revision = (await f.zones().listGroups()).groups[0].revision
  await f.zones().removeGroup(groupId, revision)
  const released = (await f.zones().list()).zones
  assert.deepEqual(released.map(z => z.queue!.id), original)
  assert.ok(released.every(z => !z.groupId && z.playback?.state === 'paused'))
  await f.devices.get('local')!.value.playback.play()
  assert.equal(f.devices.get('local')!.engine.plays, 1)
})

test('persisted membership and shared queue restore paused, without any connection credentials or automatic media', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare(id)
  const groupId = await f.zones().createGroup(await f.command(id), signal())
  const queue = (await f.zones().listGroups()).groups[0].queue!.id
  assert.doesNotMatch(await readFile(join(f.root, 'audio-sync-groups.json'), 'utf8'), /token|fingerprint|host|filePath/)
  await f.restart()
  const restored = (await f.zones().listGroups()).groups[0]
  assert.equal(restored.id, groupId); assert.equal(restored.queue?.id, queue)
  assert.equal(restored.playback?.state, 'paused'); assert.equal(restored.coordination?.phase, 'paused')
  assert.ok((await f.zones().list()).zones.every(z => z.groupId === groupId && !z.output?.connected))
  assert.ok([...f.devices.values()].every(d => d.engine.plays === 0))
})

test('a stale source occurrence cannot pause unrelated outputs before rejecting group creation', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare('local'); await f.prepare(id)
  await f.devices.get(id)!.value.playback.play()
  const command = await f.command('local')
  command.source.queue.occurrenceId = 'previous-selection'
  await assert.rejects(f.zones().createGroup(command, signal()), { code: 'STALE_REVISION' })
  assert.equal(f.devices.get(id)!.engine.info.state, 'playing')
  assert.equal((await f.zones().listGroups()).groups.length, 0)
})

test('leases precede slow group creation; new independent Play is BUSY and member Pause cancels the old creation', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare('local')
  const hold = gate(); f.slowFactory(hold.promise)
  const creating = f.zones().createGroup(await f.command('local'), signal())
  const rejected = assert.rejects(creating, /abort|取消|superseded/i)
  await drain()
  await assert.rejects(f.devices.get('local')!.value.playback.play(), { code: 'BUSY' })
  await assert.rejects(f.devices.get(id)!.value.playback.play(), { code: 'BUSY' })
  await f.zones().transport(id, null, { kind: 'pause' }, signal())
  hold.release(); await rejected
  assert.equal((await f.zones().listGroups()).groups.length, 0)
  assert.ok((await f.zones().list()).zones.every(z => !z.groupId && z.playback?.state !== 'playing'))
})

test('catalog failure releases only confirmed-stopped creations; failed removal stays paused and retryable', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare(id)
  f.failSave(true)
  await assert.rejects(f.zones().createGroup(await f.command(id), signal()), /Catalog write/)
  assert.equal((await f.zones().listGroups()).groups.length, 0)
  f.failSave(false)
  const groupId = await f.zones().createGroup(await f.command(id), signal())
  f.failSave(true)
  await assert.rejects(f.zones().removeGroup(groupId, 0), /Catalog write/)
  assert.ok((await f.zones().list()).zones.every(z => z.groupId === groupId))
  await assert.rejects(f.devices.get('local')!.value.playback.play(), { code: 'BUSY' })
  f.failSave(false)
  await f.zones().removeGroup(groupId, 0)
  assert.equal((await f.zones().listGroups()).groups.length, 0)
})

test('offline reconnect bypasses no lease, requires joined stop on the new connection, and never resumes', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare(id)
  const groupId = await f.zones().createGroup(await f.command(id), signal())
  const lost = f.devices.get(id)!, local = f.devices.get('local')!
  lost.stopFailure(true)
  await f.zones().connect(id, peer, (await f.zones().list()).zones.find(z => z.id === id)!.revision)
  assert.equal(lost.connections, 1)
  assert.equal((await f.zones().listGroups()).groups[0].playback?.state, 'stopped')
  assert.equal(lost.engine.plays, 0); assert.equal(local.engine.plays, 0)
  local.bridge.connected = true; local.stopFailure(true)
  let connected = false
  await assert.rejects(f.zones().coordinatePrimaryConnection(async () => { connected = true }), /unconfirmed/)
  assert.equal(connected, false)
  local.bridge.connected = false
  await f.zones().coordinatePrimaryConnection(async grouped => { assert.equal(grouped, true); connected = true; local.stopFailure(false); local.bridge.connected = true })
  assert.equal(connected, true)
  assert.equal((await f.zones().listGroups()).groups[0].id, groupId)
  assert.equal(local.engine.plays, 0)
})

test('failed catalog creation plus unconfirmed close keeps leases; reconnect retires rather than resurrects the disposed session', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare('local')
  const lost = f.devices.get(id)!
  f.failSave(true); f.onSave(() => lost.stopFailure(true))
  await assert.rejects(f.zones().createGroup(await f.command('local'), signal()), /Catalog write/)
  const failed = (await f.zones().listGroups()).groups[0]
  assert.ok((await f.zones().list()).zones.every(z => z.groupId === failed.id))
  await assert.rejects(f.devices.get('local')!.value.playback.play(), { code: 'BUSY' })
  f.failSave(false); f.onSave(null)
  await f.zones().connect(id, peer, (await f.zones().list()).zones.find(z => z.id === id)!.revision)
  const retired = (await f.zones().listGroups()).groups[0]
  assert.equal(retired.playback, null); assert.match(retired.error!, /完成解除/)
  await assert.rejects(f.zones().groupTransport(retired.id, retired.revision, { kind: 'play' }, signal()), { code: 'NOT_READY' })
  await f.zones().removeGroup(retired.id, retired.revision)
  assert.equal((await f.zones().listGroups()).groups.length, 0)
})

test('a failed restored member retains membership; explicit process reconstruction restores the same shared cursor', async t => {
  const f = await fixture(t), id = await f.add(); await f.prepare('local')
  const groupId = await f.zones().createGroup(await f.command('local'), signal())
  const queue = (await f.zones().listGroups()).groups[0].queue!.id
  await f.restart(true)
  assert.equal((await f.zones().listGroups()).groups[0].playback, null)
  assert.ok((await f.zones().list()).zones.every(z => z.groupId === groupId))
  await assert.rejects(f.devices.get('local')!.value.playback.play(), { code: 'BUSY' })
  f.restoreFactory()
  await f.zones().connect(id, peer, 0)
  const restored = (await f.zones().listGroups()).groups[0]
  assert.equal(restored.queue?.id, queue); assert.equal(restored.error, null)
  assert.notEqual(restored.playback?.state, 'playing')
})

test('group catalog rejects overlapping outputs, invalid delay, credentials and stale persistence writers', async t => {
  const f = await fixture(t), id = await f.add()
  const catalog = syncGroupCatalog(f.root); await catalog.load()
  const a: SyncGroupDescriptor = { id: `group-${randomUUID()}`, name: 'Music', members: [
    { zoneId: 'local', downstreamDelayMs: 0 }, { zoneId: id, downstreamDelayMs: 250 } ] }
  await catalog.save([a])
  const stale = syncGroupCatalog(f.root); await stale.load()
  await assert.rejects(catalog.save([a, { ...a, id: `group-${randomUUID()}` }]))
  await assert.rejects(catalog.save([{ ...a, members: a.members.map(m => ({ ...m, downstreamDelayMs: -1 })) }]))
  await assert.rejects(catalog.save([{ ...a, token: peer.token } as SyncGroupDescriptor]))
  await catalog.save([a]); await assert.rejects(stale.save([]))
})

test('public group payloads are bounded, explicit and cannot inject paths or use unfenced Play', () => {
  const zoneId = `zone-${randomUUID()}`, groupId = `group-${randomUUID()}`
  const request = (name: string, payload: unknown, kind = 'command') => isCoreRequest({ kind, name, payload, epoch: 'epoch', requestId: 'test' })
  const payload = { revision: 0, name: 'Music', members: [ { zoneId: 'local', revision: 0, downstreamDelayMs: 0 },
    { zoneId, revision: 0, downstreamDelayMs: 250 } ], source: { zoneId, queue: { id: 'queue', revision: 1, occurrenceId: 'a:2' } } }
  assert.equal(request('groups.create', payload), true)
  assert.equal(request('groups.create', { ...payload, members: [payload.members[0], payload.members[0]] }), false)
  assert.equal(request('groups.create', { ...payload, members: payload.members.map(m => ({ ...m, downstreamDelayMs: 251 })) }), false)
  assert.equal(request('groups.create', { ...payload, source: { ...payload.source, filePath: 'secret' } }), false)
  assert.equal(request('groups.transport', { groupId, revision: null, action: { kind: 'play' } }), false)
  assert.equal(request('groups.transport', { groupId, revision: null, action: { kind: 'pause' } }), true)
  assert.equal(request('groups.signalPath', { groupId, zoneId }, 'query'), true)
  assert.equal(request('groups.signalPath', { groupId: '../../state', zoneId }, 'query'), false)
})
