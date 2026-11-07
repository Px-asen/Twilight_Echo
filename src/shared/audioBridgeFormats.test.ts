import test from 'node:test'
import assert from 'node:assert/strict'
import { readBridgeAudioFormat, readBridgeReceiverFacts, bridgeCaptureDevice, bridgeFrameRate, bridgeSampleBytes } from './audioBridge.ts'

test('Bridge format defaults preserve legacy stereo; typed formats keep layout and distinct DSD byte-frame units', () => {
  const stereo = readBridgeAudioFormat({ sampleRate: 48000 })
  assert.equal(bridgeCaptureDevice(stereo), '48000/2')
  assert.equal(bridgeCaptureDevice(readBridgeAudioFormat({ sampleRate: 48000, channels: 6 })), '48000/6/1/1551')
  const dsd = readBridgeAudioFormat({ sampleRate: 2822400, channels: 6, wireFormat: 'dsd-int8-lsb1' })
  assert.equal(bridgeFrameRate(dsd), 352800)
  assert.equal(bridgeSampleBytes(dsd.wireFormat), 1)
  const dop = readBridgeAudioFormat({ sampleRate: 176400, wireFormat: 'dop-int24-le' })
  assert.equal(bridgeFrameRate(dop), 176400)
  assert.equal(bridgeSampleBytes(dop.wireFormat), 3)
  for (const bad of [
    { sampleRate: 48000, channels: 6, channelMask: 3 },
    { sampleRate: 48000, channels: 9 },
    { sampleRate: 48000, channels: 6, channelMask: 0 },
    { sampleRate: 48000, wireFormat: 'dop-int24-le' },
    { sampleRate: 2822400, wireFormat: 'pcm-fake' },
    { sampleRate: 2822400, wireFormat: 'dsd-int8-lsb1', channelMask: NaN }
  ]) assert.throws(() => readBridgeAudioFormat(bad as any))
})

test('new receiver facts declare their wire format; DSD cannot advertise PCM resampling/synchronization', () => {
  const facts = { sampleRate: 2822400, channels: 2, wireFormat: 'dsd-int8-lsb1', channelMask: 3,
    bufferedFrames: 0, capacityFrames: 88200, prebufferFrames: 14112, consumedFrames: 0, underruns: 0,
    started: false, failed: false, backend: 'asio', deviceName: 'DAC', actualSampleRate: 2822400,
    actualBitDepth: 1, actualChannels: 2, actualOutputFormat: 'dsd-int8-lsb1', exclusive: true }
  assert.equal(readBridgeReceiverFacts(facts).wireFormat, 'dsd-int8-lsb1')
  assert.throws(() => readBridgeReceiverFacts({ ...facts, adaptiveSupported: true }))
  assert.throws(() => readBridgeReceiverFacts({ ...facts, wireFormat: undefined }))
  assert.throws(() => readBridgeReceiverFacts({ ...facts, channelMask: 4 }))
})
