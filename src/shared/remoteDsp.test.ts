import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSignalPath } from './remoteDsp.ts'
import { BridgeClockMonitor } from './audioBridgeClock.ts'
import type { DspGraphStatus } from './dspGraph.ts'
import type { BridgeRuntimeState } from './audioBridge.ts'

test('signal paths carry only the selected Bridge clock; local paths never reuse remote timing', () => {
  const timing = new BridgeClockMonitor().view(0)
  const graph = { nodes: [] } as unknown as DspGraphStatus
  const zone = { selected: true, connected: true, receiver: null, timing } as BridgeRuntimeState
  assert.deepEqual(buildSignalPath(null, graph, zone).timing, timing)
  assert.equal(buildSignalPath(null, graph, { ...zone, selected: false }).timing, null)
  assert.equal(buildSignalPath(null, graph, { ...zone, timing: undefined }).timing, null)
})
