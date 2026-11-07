import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreBridgeService } from './bridgeService.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'

test('a service-only host exposes no local DAC and rejects local routing before any playback or output call', async () => {
  const calls: string[] = []
  const service = new CoreBridgeService({
    localOutputAllowed: false,
    call: async method => { calls.push(method); return { selected: true, hosting: false, connected: false } },
    output: { serialize: action => action() }, outputState: async () => assert.fail('No local device state'),
    playback: { stop: async () => assert.fail('Local routing must be rejected before Stop') },
    cast: { active: () => false }, identity: () => assert.fail('No local receiver'), name: 'Service', address: () => '', changed() {}
  })
  const state = await service.state()
  assert.equal(state.selectedOutputId, 'bridge')
  assert.equal(state.outputs.find(output => output.id === 'local')!.available, false)
  await assert.rejects(service.select(0, 'local'), /只能选择输出桥/)
  await assert.rejects(service.host(0, true, 48000), /不承载本机 DAC/)
  await assert.rejects(service.assertLocal(), /仅向输出桥/)
  assert.deepEqual(calls, ['BridgeStatus'])
})

test('primary grouped reconnect retains Bridge consent state, skips independent Stop and confirms the new receiver', async () => {
  const calls: string[] = [], peer = { host: 'localhost', port: 12345, token: 'a'.repeat(48), fingerprint: 'b'.repeat(64) }
  const service = new CoreBridgeService({
    call: async method => { calls.push(method); return method === 'BridgeStatus' ? { selected: true, connected: true, peerName: 'Study' } : undefined },
    coordinateConnection: async action => { calls.push('group-stop'); await action(true); calls.push('group-recover') },
    output: { serialize: action => action() }, outputState: async () => assert.fail('No host setup'),
    playback: { stop: async () => assert.fail('No independent Stop after group cancellation'), assertIndependent: () => { throw Object.assign(Error('Grouped'), { code: 'BUSY' }) } },
    cast: { active: () => false }, identity: () => assert.fail('No new host identity'), name: 'Core', address: () => '', changed: () => {}
  })
  await service.connect(0, peer)
  assert.deepEqual(calls, ['group-stop', 'BridgeConnect', 'BridgeCancelTimed', 'group-recover'])
  const state = await service.state()
  assert.equal(state.revision, 1); assert.equal(state.outputs[1].name, 'Study')
  await assert.rejects(service.connect(0, peer), { code: 'STALE_REVISION' })
  assert.throws(() => service.select(1, 'local'), { code: 'BUSY' })
  assert.throws(() => service.host(1, true, 48000), { code: 'BUSY' })
  await service.select(1, 'bridge')
  assert.equal((await service.state()).revision, 2)
})

test('one Zone keeps its queue owner; output consent/select serialize and enforce revisions', async () => {
  const calls: string[] = []
  const runtime: BridgeRuntimeState = { supported: true, hosting: false, selected: false, connected: false,
    receiving: false, error: null, peerName: 'Study', receiver: null }
  let pending = Promise.resolve(), stops = 0
  const service = new CoreBridgeService({
    call: async (method) => {
      calls.push(method)
      if (method === 'BridgeStatus') return { ...runtime }
      if (method === 'BridgeConnect') { runtime.selected = runtime.connected = true }
      if (method === 'BridgeDisconnect') runtime.selected = runtime.connected = false
      if (method === 'BridgeHostStart') { runtime.hosting = true; return { port: 12345, token: 'a'.repeat(48) } }
      if (method === 'BridgeHostStop') runtime.hosting = false
      return undefined
    },
    output: { serialize: action => {
      const work = pending.then(action); pending = work.then(() => {}, () => {}); return work
    } },
    outputState: async () => ({ output: 'wasapi', device: 'usb-dac', exclusiveMode: true } as any),
    playback: { stop: async () => { ++stops } }, cast: { active: () => false },
    identity: () => ({ key: 'private', cert: 'public', fingerprint: 'b'.repeat(64) }),
    name: 'Study', address: () => '192.168.1.23', changed: () => {}
  })
  await service.connect(0, { host: '192.168.1.2', port: 12345, token: 'a'.repeat(48), fingerprint: 'b'.repeat(64) })
  const state = await service.state()
  assert.equal(state.zoneId, 'local'); assert.equal(state.selectedOutputId, 'bridge')
  assert.deepEqual(state.outputs.map(o => o.id), ['local', 'bridge'])
  assert.ok(!JSON.stringify(state).includes('token'))
  await assert.rejects(service.select(0, 'local'), { code: 'STALE_REVISION' })
  await assert.rejects(service.assertLocal())
  await service.select(state.revision, 'local')
  await service.assertLocal()
  await service.host((await service.state()).revision, true, 48000)
  assert.match(service.invite().invitation!, /^twilight-bridge:\/\/192.168.1.23:/)
  await service.host((await service.state()).revision, false, 48000)
  assert.equal(service.invite().invitation, null)
  assert.equal(stops, 3)
  await service.shutdown()
  assert.equal(calls.at(-1), 'BridgeShutdown') // preserve output intent for restart recovery
})
