'use strict'
// Built production audio service + staged native decoder/DSP + real TLS.
// The only simulated boundary is B's DAC. No host audio device is opened.
const assert = require('node:assert/strict')
const test = require('node:test')
const { fork } = require('node:child_process')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

test('production audio RPC sends real post-DSP PCM through pinned TLS without opening local hardware', { timeout: 30000 }, async t => {
  await import('../src/adapters-node/index.ts')
  const [{ AudioEngineServiceBinding }, { AudioBridgeRuntime }, { createRemoteTlsIdentity }] = await Promise.all([
    import('../src/main/audioEngineServiceClient.ts'), import('../src/main/audio/bridgeRuntime.ts'),
    import('../src/adapters-node/remoteTlsIdentity.ts')
  ])
  const root = resolve(__dirname, '..'), directory = await mkdtemp(join(tmpdir(), 'twilight-bridge-native-'))
  const children = new Set(), messages = [], errors = []
  const binding = new AudioEngineServiceBinding({ serviceEntry: join(root, 'out/main/audioEngineService.js'), requestTimeoutMs: 5000,
    launch() {
      const child = fork(join(root, 'out/main/audioEngineService.js'), [], { execArgv: [], cwd: root,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
      children.add(child); child.once('exit', () => children.delete(child))
      child.stderr.on('data', data => errors.push(String(data)))
      child.postMessage = message => { messages.push(message.method); child.send(message) }
      return child
    }
  })
  const facts = { sampleRate: 48000, channels: 2, bufferedFrames: 0, capacityFrames: 12000, prebufferFrames: 1920,
    consumedFrames: 0, underruns: 0, started: false, failed: false, backend: 'wasapi-exclusive', deviceName: 'Silent fixture DAC',
    actualSampleRate: 48000, actualBitDepth: 24, actualChannels: 2, actualOutputFormat: 'int24', exclusive: true }
  let blocks = []
  const dac = {
    Stop() {}, SetOutputDevice() {}, SetOutputBackend() {}, PullBridgePcm() { throw Error('Receiver must not decode') },
    OpenBridgeReceiver(backend, device) {
      assert.equal(backend, 'wasapi-exclusive'); assert.equal(device, 'explicit-fixture')
      facts.bufferedFrames = facts.consumedFrames = 0; facts.started = false
    },
    CloseBridgeReceiver() { facts.bufferedFrames = 0; facts.started = false },
    WriteBridgePcm(data) { blocks.push(Buffer.from(data)); facts.bufferedFrames += data.length / 8
      assert.ok(facts.bufferedFrames <= facts.capacityFrames)
      if (facts.bufferedFrames >= facts.prebufferFrames) facts.started = true },
    StartBridgeReceiver() { facts.started = true }, GetBridgeReceiverInfo() { return JSON.stringify(facts) }
  }
  const receiver = new AudioBridgeRuntime(dac)
  const clock = setInterval(() => { if (facts.started) { const n = Math.min(480, facts.bufferedFrames)
    facts.bufferedFrames -= n; facts.consumedFrames += n } }, 10)
  t.after(async () => {
    clearInterval(clock)
    try { await binding.callAsync('BridgeShutdown', []) } catch {}
    binding.destroy(); await receiver.close()
    await Promise.all([...children].map(child => new Promise(resolve => { child.once('exit', resolve); child.kill() })))
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  const until = async predicate => { const end = Date.now() + 5000
    while (!predicate() && Date.now() < end) await delay(10)
    assert.ok(predicate(), errors.join('\n')) }
  const status = await binding.callAsync('BridgeStatus', [])
  assert.equal(status.supported, true); assert.equal(status.selected, false)
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Test B', backend: 'wasapi-exclusive', device: 'explicit-fixture', sampleRate: 48000 })
  await binding.callAsync('BridgeConnect', [{ host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }])
  const rate = 44100, count = rate * 3, wave = Buffer.alloc(44 + count * 4)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22); wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 4, 28)
  wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(count * 4, 40)
  for (let n = 0; n < count; n++) for (let c = 0; c < 2; c++)
    wave.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 1000 / rate) * 8192), 44 + (n * 2 + c) * 2)
  const source = join(directory, 'tone.wav'); await writeFile(source, wave)
  await binding.callAsync('SetVolume', [1])
  const rms = async preamp => {
    await binding.callAsync('Stop', [])
    await binding.callAsync('SetDspConfig', [JSON.stringify({ dspEnabled: true, eqEnabled: true, eqPreamp: preamp, fftEnabled: false })])
    blocks = []
    await binding.callAsync('Play', [source])
    await until(() => blocks.length >= 14)
    await binding.callAsync('Stop', [])
    let sum = 0, samples = 0
    for (const block of blocks.slice(3, 14)) for (let offset = 0; offset < block.length; offset += 4) {
      sum += block.readFloatLE(offset) ** 2; ++samples
    }
    return Math.sqrt(sum / samples)
  }
  const original = await rms(0), processed = await rms(-6), ratio = processed / original
  assert.ok(original > .1); assert.ok(ratio > .48 && ratio < .53, 'RMS ratio: ' + ratio)
  const playback = JSON.parse(await binding.callAsync('GetPlaybackInfo', []))
  assert.equal(playback.outputBackend, 'bridge-pcm')
  // PCM blocks never cross the command-RPC lane.
  assert.ok(!messages.includes('PullBridgePcm')); assert.ok(!messages.includes('WriteBridgePcm'))
  await receiver.stopHost()
  let lost
  for (let n = 0; n < 100; ++n) {
    lost = await binding.callAsync('BridgeStatus', [])
    if (!lost.connected) break
    await delay(10)
  }
  assert.equal(lost.selected, true); assert.equal(lost.connected, false)
  await assert.rejects(binding.callAsync('Play', [source]), /未连接/)
  t.diagnostic('Real decode 44.1 -> 48 kHz, TLS PCM and -6 dB DSP RMS ratio: ' + ratio.toFixed(4))
})
