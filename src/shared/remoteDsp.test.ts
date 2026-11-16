import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSignalPath } from './remoteDsp.ts'
import { BridgeClockMonitor } from './audioBridgeClock.ts'
import type { DspGraphStatus } from './dspGraph.ts'
import type { BridgeRuntimeState } from './audioBridge.ts'
import type { CorePlaybackView } from './coreViews.ts'

test('signal paths carry only the selected Bridge clock; local paths never reuse remote timing', () => {
  const timing = new BridgeClockMonitor().view(0)
  const graph = { nodes: [] } as unknown as DspGraphStatus
  const zone = { selected: true, connected: true, receiver: null, timing } as BridgeRuntimeState
  assert.deepEqual(buildSignalPath(null, graph, zone).timing, timing)
  assert.equal(buildSignalPath(null, graph, { ...zone, selected: false }).timing, null)
  assert.equal(buildSignalPath(null, graph, { ...zone, timing: undefined }).timing, null)
})

test('buildSignalPath preserves local DoP and native DSD mode facts for signal chain presentation', () => {
  const graph = { nodes: [] } as unknown as DspGraphStatus
  const dopPlayback = {
    codec: 'dsd',
    sourceSampleRate: 2822400,
    sourceBitDepth: 1,
    sourceChannels: 2,
    decodedSampleRate: 176400,
    decodedBitDepth: 24,
    decodedChannels: 2,
    decodedSampleFormat: 'int24',
    outputBackend: 'wasapi-exclusive',
    actualSampleRate: 176400,
    actualBitDepth: 24,
    actualChannels: 2,
    isDsd: true,
    dsdMode: 'dop',
    dsdRate: 2822400,
    actualDsdRate: 2822400
  } as CorePlaybackView
  const dopPath = buildSignalPath(dopPlayback, graph, null)
  assert.equal(dopPath.source.isDsd, true)
  assert.equal(dopPath.decoded.dsdMode, 'dop')
  assert.equal(dopPath.decoded.dsdRate, 2822400)
  assert.equal(dopPath.output.dsdMode, 'dop')
  assert.equal(dopPath.output.dsdRate, 2822400)
})
