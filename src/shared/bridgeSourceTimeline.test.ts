import assert from 'node:assert/strict'
import test from 'node:test'
import { readBridgeSourceTimeline } from './bridgeSourceTimeline.ts'
const valid = { generation: 1, frames: 100, sampleRate: 48000, positionFrames: 24000,
  transitionFrame: 0, transitionSerial: 0, entryId: 'legacy:C:/music/disc.flac:2', advanceReady: false }
test('private timeline keeps occurrence identity and seek origins without trusting peer fields', () => {
  assert.deepEqual(readBridgeSourceTimeline(JSON.stringify({ ...valid, epoch: 123, source: 'ignored' })), valid)
  for (const absent of [null, undefined, 'null']) assert.equal(readBridgeSourceTimeline(absent), null)
  for (const change of [{ frames: -1 }, { frames: 1.5 }, { generation: Number.MAX_SAFE_INTEGER+1 },
    { sampleRate: 0 }, { positionFrames: null }, { transitionFrame: 101 }, { entryId: '' }, { entryId: 'bad\0id' },
    { entryId: 'a'.repeat(8193) }]) assert.throws(() => readBridgeSourceTimeline(JSON.stringify({ ...valid, ...change })))
  assert.throws(() => readBridgeSourceTimeline('a'.repeat(65537)))
})
