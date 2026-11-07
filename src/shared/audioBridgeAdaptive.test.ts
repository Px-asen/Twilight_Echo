import assert from 'node:assert/strict'
import test from 'node:test'
import { readBridgeAdaptive, readBridgeReceiverFacts } from './audioBridge.ts'
test('adaptive facts preserve fractional source positions and reject invalid or inconsistent observations', () => {
  const facts = { requestedPpm: 200, effectivePpm: 199.7, inputFrames: 48000, pendingInputFrames: 134.25,
    resamplerDelayFrames: 134.25, sourceConsumedFrames: 40000.75, inputCreditFrames: 3000 }
  assert.deepEqual(readBridgeAdaptive(facts), facts)
  assert.equal(readBridgeAdaptive(undefined), null)
  for (const edit of [{ effectivePpm: Infinity }, { requestedPpm: 1003 }, { inputFrames: 1.25 },
    { pendingInputFrames: -1 }, { sourceConsumedFrames: NaN }, { inputCreditFrames: 1.2 }])
    assert.throws(() => readBridgeAdaptive({ ...facts, ...edit }), /adaptive/)
  const receiver = { sampleRate: 48000, channels: 2, bufferedFrames: 3000, capacityFrames: 12000, prebufferFrames: 1920,
    consumedFrames: 40009, underruns: 0, started: true, failed: false, backend: 'wasapi', deviceName: 'fixture',
    actualSampleRate: 48000, actualBitDepth: 32, actualChannels: 2, actualOutputFormat: 'float32', exclusive: false,
    adaptiveSupported: true, adaptive: facts,
    timedStart: { supported: true, state: 'running', error: '', ended: false, targetAtMs: 1, mediaFrame: 0,
      deviceStartFrame: 480, deviceStartAtMs: 1, presentedMediaFrames: 39000.5 } }
  assert.equal(readBridgeReceiverFacts(receiver).adaptive?.sourceConsumedFrames, 40000.75)
  assert.throws(() => readBridgeReceiverFacts({ ...receiver, adaptiveSupported: false }), /Inconsistent/)
  assert.throws(() => readBridgeReceiverFacts({ ...receiver, adaptive: { ...facts, sourceConsumedFrames: 50000 } }), /Inconsistent/)
  assert.throws(() => readBridgeReceiverFacts({ ...receiver, adaptive: { ...facts, inputCreditFrames: 12001 } }), /Inconsistent/)
})
