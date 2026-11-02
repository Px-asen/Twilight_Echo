import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreBridgeService } from './bridgeService.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'

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
