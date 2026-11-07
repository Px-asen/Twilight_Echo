'use strict'
// Real native decoder/capture + production TLS protocol. Receiver DAC is controlled;
// the native receiver's exact driver bytes/idle are covered by bridge_formats_tests.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')

function wave(channels, mask, rate = 48000) {
  const frames = rate, bytes = Buffer.alloc(68+frames*channels*4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length-8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(40, 16)
  bytes.writeUInt16LE(0xfffe, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate*channels*4, 28); bytes.writeUInt16LE(channels*4, 32); bytes.writeUInt16LE(32, 34)
  bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(32, 38); bytes.writeUInt32LE(mask, 40)
  Buffer.from('0300000000001000800000aa00389b71', 'hex').copy(bytes, 44)
  bytes.write('data', 60); bytes.writeUInt32LE(frames*channels*4, 64)
  for (let n = 0; n < frames; n++) for (let c = 0; c < channels; c++) bytes.writeFloatLE((c+1)/16, 68+(n*channels+c)*4)
  return bytes
}
function dsf(channels, rate = 2822400) {
  const block = 4096, blocks = Math.ceil(rate/8/2/block), dataSize = block*blocks*channels
  const bytes = Buffer.alloc(92+dataSize)
  bytes.write('DSD '); bytes.writeBigUInt64LE(28n, 4); bytes.writeBigUInt64LE(BigInt(bytes.length), 12)
  bytes.write('fmt ', 28); bytes.writeBigUInt64LE(52n, 32); bytes.writeUInt32LE(1, 40)
  bytes.writeUInt32LE(channels === 6 ? 7 : channels === 1 ? 1 : 2, 48); bytes.writeUInt32LE(channels, 52)
  bytes.writeUInt32LE(rate, 56); bytes.writeUInt32LE(1, 60); bytes.writeBigUInt64LE(BigInt(block*blocks*8), 64)
  bytes.writeUInt32LE(block, 72); bytes.write('data', 80); bytes.writeBigUInt64LE(BigInt(12+dataSize), 84)
  for (let n = 0; n < blocks; n++) for (let c = 0; c < channels; c++) bytes.fill((c+1)*0x11, 92+(n*channels+c)*block, 92+(n*channels+c+1)*block)
  return bytes
}
function carrierLookingPcm(rate) {
  const frames = Math.floor(rate/4), bytes = Buffer.alloc(44+frames*6)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length-8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate*6, 28)
  bytes.writeUInt16LE(6, 32); bytes.writeUInt16LE(24, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames*6, 40)
  for (let n = 0; n < frames; n++) for (let c = 0; c < 2; c++) { bytes[44+n*6+c*3] = 0x11; bytes[45+n*6+c*3] = 0x22; bytes[46+n*6+c*3] = n%2 ? 0xfa : 5 }
  return bytes
}
const reversed = n => { let v = 0; for (let bit = 0; bit < 8; bit++) v = (v<<1)|((n>>bit)&1); return v }

test('production TLS carries native DSD, DoP and multichannel PCM without local hardware', { timeout: 60_000 }, async t => {
  const { AudioBridgeRuntime } = await import('../src/main/audio/bridgeRuntime.ts')
  const { createRemoteTlsIdentity } = await import('../src/adapters-node/remoteTlsIdentity.ts')
  const { readBridgeAudioFormat, BRIDGE_WIRE_FORMATS, bridgeFrameRate, bridgeSampleBytes } = await import('../src/shared/audioBridge.ts')
  const native = require(process.env.TWILIGHT_BRIDGE_NATIVE || resolve(__dirname, '../resources/audio-engine/twilight_audio_node.node'))
  assert.equal(typeof native.PullBridgeAudio, 'function')
  const directory = await mkdtemp(join(tmpdir(), 'twilight-wire-formats-'))
  t.after(async () => { native.Stop(); await rm(directory, { recursive: true, force: true }) })
  await t.test('PCM-only rate changes do not insert DSD guard silence, including 5.1', async () => {
    native.SetVolume(1); native.SetPlaybackRate(1); native.SetAutoMixMode('off')
    native.SetOutputConfig(JSON.stringify({ routingMode: 'auto', pcmToDsdMode: 'off',
      dsdMutePreRollFrames: 256, dsdMutePostRollFrames: 256, dsdMuteTimeoutFrames: 4096 }))
    native.SetDspConfig('{}')
    for (const channels of [2, 6]) for (const sampleRate of [44100, 48000, 44100]) {
      native.Stop()
      const mask = channels === 6 ? 0x60f : 3
      const file = join(directory, `pcm-rate-${sampleRate}-${channels}.wav`)
      await writeFile(file, wave(channels, mask, sampleRate))
      native.SetOutputBackend('bridge-stream'); native.SetOutputDevice(`${sampleRate}/${channels}/1/${mask}`)
      native.Play(file)
      const info = JSON.parse(native.GetPlaybackInfo())
      assert.equal(info.diagnostics.dsdMuteTransition, 'none', JSON.stringify(info))
      assert.equal(info.diagnostics.dsdMutePreRollFrames, 0)
      assert.equal(info.diagnostics.dsdMutePostRollFrames, 0)
      // Inspect the first pull, not a later nonzero packet that could hide roll silence.
      const block = native.PullBridgeAudio(1000)
      assert.equal(block.audio.length, 1000*channels*4)
      for (let frame = 0; frame < 1000; frame++) for (let c = 0; c < channels; c++)
        assert.ok(Math.abs(block.audio.readFloatLE((frame*channels+c)*4)-(c+1)/16) < 1e-6,
          `${sampleRate}Hz/${channels}ch frame ${frame} channel ${c}`)
    }
    native.Stop()
  })
  for (const scenario of [
    { wireFormat: 'float32-le', channels: 2, sampleRate: 48000 },
    { wireFormat: 'float32-le', channels: 6, sampleRate: 48000 },
    { wireFormat: 'float32-le', channels: 8, sampleRate: 48000 },
    { wireFormat: 'dsd-int8-lsb1', channels: 2, sampleRate: 2822400 },
    { wireFormat: 'dsd-int8-msb1', channels: 2, sampleRate: 2822400 },
    { wireFormat: 'dsd-int8-ner8', channels: 2, sampleRate: 2822400 },
    { wireFormat: 'dsd-int8-lsb1', channels: 6, sampleRate: 2822400 },
    { wireFormat: 'dsd-int8-lsb1', channels: 2, sampleRate: 22579200 },
    { wireFormat: 'dop-int24-le', channels: 2, sampleRate: 176400 },
    { wireFormat: 'dop-int24-le', channels: 6, sampleRate: 176400 },
    { wireFormat: 'dop-int24-le', channels: 2, sampleRate: 1411200 }
  ]) await t.test(`${scenario.wireFormat} / ${scenario.sampleRate} Hz / ${scenario.channels} channels`, async sub => {
    const format = readBridgeAudioFormat(scenario), blocks = []
    const bpf = bridgeSampleBytes(format.wireFormat)*format.channels
    let facts = {}, opened = false, opens = 0
    const silentDac = {
      Stop() {}, SetOutputBackend() {}, SetOutputDevice() {},
      PullBridgePcm() { throw Error('Receiver never decodes') }, PullBridgeAudio() { throw Error('Receiver never decodes') },
      OpenBridgeReceiver(backend, device, rate, channels) {
        assert.equal(format.wireFormat, 'float32-le'); assert.equal(format.channels, 2)
        this.OpenBridgeStreamReceiver(backend, device, rate, channels, 1, 3)
      },
      OpenBridgeStreamReceiver(_backend, _device, rate, channels, code, mask) {
        assert.deepEqual(readBridgeAudioFormat({ sampleRate: rate, channels, wireFormat: BRIDGE_WIRE_FORMATS[code-1], channelMask: mask }), format)
        opened = true; opens++
        facts = { ...format, bufferedFrames: 0, consumedFrames: 0, underruns: 0, started: false, failed: false,
          capacityFrames: Math.floor(bridgeFrameRate(format)/4), prebufferFrames: Math.floor(bridgeFrameRate(format)/25),
          backend: 'asio', deviceName: 'controlled native-format DAC', actualSampleRate: rate, actualChannels: channels,
          actualBitDepth: code === 1 ? 32 : code === 2 ? 24 : 1, actualOutputFormat: BRIDGE_WIRE_FORMATS[code-1], exclusive: true }
      },
      CloseBridgeReceiver() { opened = false; facts.bufferedFrames = 0; facts.started = false },
      WriteBridgePcm(audio) { assert.equal(format.wireFormat, 'float32-le'); assert.equal(format.channels, 2); this.WriteBridgeAudio(audio) },
      WriteBridgeAudio(audio) { assert.ok(opened); assert.equal(audio.length%bpf, 0); blocks.push(Buffer.from(audio)); facts.bufferedFrames += audio.length/bpf
        assert.ok(facts.bufferedFrames <= facts.capacityFrames); if (facts.bufferedFrames >= facts.prebufferFrames) facts.started = true },
      StartBridgeReceiver() { facts.started = true },
      GetBridgeReceiverInfo() { assert.ok(opened); return JSON.stringify(facts) }
    }
    const sender = new AudioBridgeRuntime(native), receiver = new AudioBridgeRuntime(silentDac)
    const consume = setInterval(() => { if (facts.started) { const n = Math.min(facts.bufferedFrames, Math.floor(bridgeFrameRate(format)/100)); facts.bufferedFrames -= n; facts.consumedFrames += n } }, 10)
    sub.after(async () => { clearInterval(consume); await sender.close(); await receiver.close() })
    const identity = createRemoteTlsIdentity()
    const grant = await receiver.startHost({ ...identity, ...format, name: 'Formats', backend: 'asio', device: 'explicit-controlled-dac' })
    const peer = { host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }
    if (format.wireFormat === 'dsd-int8-lsb1' && format.channels === 2) {
      const oldBinding = Object.create(native)
      Object.defineProperty(oldBinding, 'PullBridgeAudio', { value: undefined })
      const legacy = new AudioBridgeRuntime(oldBinding)
      await assert.rejects(legacy.connectPeer(peer))
      assert.equal(legacy.state().selected, true)
      assert.equal(legacy.state().connected, false)
      await legacy.close()
    }
    await sender.connectPeer(peer)
    const file = join(directory, `source-${format.wireFormat}-${format.channels}.${format.wireFormat === 'float32-le' ? 'wav' : 'dsf'}`)
    await writeFile(file, format.wireFormat === 'float32-le' ? wave(format.channels, format.channelMask)
      : dsf(format.channels, format.wireFormat === 'dop-int24-le' ? format.sampleRate*16 : format.sampleRate))
    native.SetVolume(1); native.SetPlaybackRate(1)
    native.SetOutputConfig(JSON.stringify({ routingMode: 'auto', pcmToDsdMode: 'off' }))
    native.SetDspConfig(JSON.stringify({ dsdOutputMode: format.wireFormat === 'dop-int24-le' ? 'dop' : 'native', dsdRatePolicy: 'exact',
      dsdRoute: { enabled: true, backend: 'asio', deviceId: 'must-never-open-local-device' } }))
    sender.beforeCall('Play', [file]); native.Play(file)
    const deadline = Date.now()+8000
    while (blocks.length < 12 && Date.now() < deadline && sender.state().connected) await delay(10)
    assert.equal(sender.state().connected, true, sender.state().error || '')
    assert.ok(blocks.length >= 12, JSON.stringify(native.GetPlaybackInfo()))
    const audio = Buffer.concat(blocks), width = bridgeSampleBytes(format.wireFormat)
    let exactFrames = 0
    for (let frame = 0; frame < audio.length/bpf; frame++) {
      let matches = true
      for (let c = 0; c < format.channels; c++) {
        const at = frame*bpf+c*width
        if (format.wireFormat === 'float32-le') matches &&= Math.abs(audio.readFloatLE(at)-(c+1)/16) < 1e-6
        else if (format.wireFormat === 'dop-int24-le') { matches &&= audio[at] === reversed((c+1)*0x11) && audio[at+1] === reversed((c+1)*0x11)
          assert.ok(audio[at+2] === 5 || audio[at+2] === 250); if (c) assert.equal(audio[at+2], audio[frame*bpf+2]) }
        else matches &&= audio[at] === (format.wireFormat === 'dsd-int8-msb1' ? reversed((c+1)*0x11) : (c+1)*0x11)
      }
      if (matches) exactFrames++
    }
    assert.ok(exactFrames > 1024, `${exactFrames} exact frames; native=${native.GetPlaybackInfo()}`)
    const priorOpens = opens, priorBlocks = blocks.length
    sender.beforeCall('Seek', [0.1]); native.Seek(0.1)
    const seekDeadline = Date.now()+3000
    while ((opens === priorOpens || blocks.length === priorBlocks) && Date.now() < seekDeadline) await delay(10)
    assert.ok(opens > priorOpens, 'Seek must close/reopen the DAC stream, never append old buffered bytes')
    assert.ok(blocks.length > priorBlocks)
    await assert.rejects(sender.prepareTimedPlayback(), /不支持定时/)
    sender.beforeCall('Pause', []); native.Pause()
    await delay(80)
    assert.equal(facts.started, false)
    if (format.wireFormat !== 'float32-le') {
      const pcm = join(directory, 'not-dsd.wav'); await writeFile(pcm, wave(2, 3))
      sender.beforeCall('Play', [pcm]); assert.throws(() => native.Play(pcm))
      native.Stop()
      if (format.wireFormat === 'dop-int24-le') {
        const fakeDop = join(directory, `pcm-not-dop-${format.sampleRate}.wav`)
        await writeFile(fakeDop, carrierLookingPcm(format.sampleRate))
        sender.beforeCall('Play', [fakeDop]); assert.throws(() => native.Play(fakeDop))
        native.Stop()
      }
    }
  })
  await t.test('leaving DoP protects the first PCM stream, then clears the old transition', async () => {
    native.Stop(); native.SetDspConfig('{}')
    native.SetOutputBackend('bridge-stream'); native.SetOutputDevice('48000/2/1/3')
    const first = join(directory, 'after-dop.wav'), next = join(directory, 'after-dop-rate.wav')
    await writeFile(first, wave(2, 3)); await writeFile(next, wave(2, 3, 44100))
    native.Play(first)
    assert.equal(JSON.parse(native.GetPlaybackInfo()).diagnostics.dsdMuteTransition, 'dop-to-pcm')
    native.Stop(); native.SetOutputDevice('44100/2/1/3'); native.Play(next)
    const info = JSON.parse(native.GetPlaybackInfo())
    assert.equal(info.diagnostics.dsdMuteTransition, 'none', JSON.stringify(info))
    assert.equal(info.diagnostics.dsdMutePreRollFrames, 0)
    const block = native.PullBridgeAudio(1000)
    for (let frame = 0; frame < 1000; frame++)
      assert.ok(Math.abs(block.audio.readFloatLE(frame*8)-1/16) < 1e-6)
  })
})
