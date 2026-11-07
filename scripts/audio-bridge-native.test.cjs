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
    actualSampleRate: 48000, actualBitDepth: 24, actualChannels: 2, actualOutputFormat: 'int24', exclusive: true,
    adaptiveSupported: true }
  const blankTimed = () => ({ supported: true, state: 'disabled', error: '', ended: false,
    targetAtMs: 0, mediaFrame: 0, deviceStartFrame: null, deviceStartAtMs: null, presentedMediaFrames: null })
  let blocks = [], streamGeneration = 0, startedAt = 0, timed = blankTimed(), targetNodeMs = 0, adaptive = null
  let syntheticSource = 0, sourceUpdatedAt = 0
  const advanceSource = () => {
    const now = Number(process.hrtime.bigint()) / 1e6
    if (targetNodeMs && adaptive && ['running', 'completed'].includes(timed.state)) {
      const elapsed = Math.max(0, now-Math.max(targetNodeMs, sourceUpdatedAt))
      syntheticSource = Math.min(adaptive.inputFrames, syntheticSource+elapsed*48*1.0001/(1+adaptive.requestedPpm*1e-6))
      timed.presentedMediaFrames = syntheticSource
    }
    sourceUpdatedAt = now
  }
  const dac = {
    Stop() {}, SetOutputDevice() {}, SetOutputBackend() {}, PullBridgePcm() { throw Error('Receiver must not decode') },
    OpenBridgeReceiver(backend, device) {
      assert.equal(backend, 'wasapi-exclusive'); assert.equal(device, 'explicit-fixture')
      ++streamGeneration; startedAt = 0; timed = blankTimed(); targetNodeMs = 0; adaptive = null
      syntheticSource = sourceUpdatedAt = 0
      facts.bufferedFrames = facts.consumedFrames = 0; facts.started = false
    },
    CloseBridgeReceiver() { facts.bufferedFrames = 0; facts.started = false; timed = blankTimed(); targetNodeMs = 0; adaptive = null },
    WriteBridgePcm(data) { blocks.push(Buffer.from(data)); facts.bufferedFrames += data.length / 8
      if (adaptive) adaptive.inputFrames += data.length/8
      assert.ok(facts.bufferedFrames <= facts.capacityFrames)
      if (facts.bufferedFrames >= facts.prebufferFrames) facts.started = true },
    StartBridgeReceiver() { facts.started = true },
    PrepareBridgeTimedReceiver() { timed.state = 'prepared'; facts.started = true },
    PrepareBridgeAdaptiveReceiver() {
      timed.state = 'prepared'; facts.started = true
      adaptive = { requestedPpm: 0, effectivePpm: 0, inputFrames: 0, pendingInputFrames: 134,
        resamplerDelayFrames: 134, sourceConsumedFrames: 0, inputCreditFrames: 12000 }
    },
    SetBridgeTimedCorrection(ppm, generation) {
      assert.equal(generation, streamGeneration); assert.ok(adaptive)
      advanceSource()
      adaptive.requestedPpm = adaptive.effectivePpm = ppm
    },
    ArmBridgeTimedReceiver(time, generation, frame) {
      assert.equal(generation, streamGeneration); assert.ok(facts.bufferedFrames >= facts.prebufferFrames)
      assert.equal(timed.state, 'prepared')
      targetNodeMs = time - 40000; timed.state = 'armed'; timed.targetAtMs = time; timed.mediaFrame = frame
    },
    EndBridgeTimedReceiver() { timed.ended = true },
    GetBridgeReceiverInfo() {
      advanceSource()
      const now = Number(process.hrtime.bigint()) / 1e6
      if (facts.started && !startedAt) startedAt = now
      if (adaptive) adaptive.inputCreditFrames = timed.ended ? 0 : facts.capacityFrames-facts.bufferedFrames
      return JSON.stringify({ ...facts, timedStart: timed, adaptive, clock: {
        supported: true, valid: facts.started, running: facts.started, source: 'wasapi-audio-clock',
        streamGeneration, epoch: 1, sampleRate: 48000,
        positionFrames: facts.started ? (now - startedAt) * 48 * 1.0001 : 0,
        sampledAtMs: now + 40000, readAtMs: now + 40000, callbackRequestedFrames: facts.consumedFrames
      } })
    }
  }
  const receiver = new AudioBridgeRuntime(dac)
  const clock = setInterval(() => { if (facts.started) {
    if (timed.state !== 'disabled') {
      if (!targetNodeMs || Number(process.hrtime.bigint()) / 1e6 < targetNodeMs) return
      timed.state = 'running'; timed.deviceStartFrame = 4800; timed.deviceStartAtMs = timed.targetAtMs
    }
    const n = Math.min(480, facts.bufferedFrames)
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
  // Same production process/RPC lane, but a deliberately synthetic +100 ppm
  // presentation clock. This validates propagation, not physical DAC accuracy.
  await binding.callAsync('Play', [source])
  let measured
  const deadline = Date.now() + 5000
  do {
    measured = await binding.callAsync('BridgeStatus', [])
    if (measured.timing?.output.state === 'ready') break
    await delay(50)
  } while (Date.now() < deadline)
  assert.equal(measured.timing.output.state, 'ready')
  assert.ok(Math.abs(measured.timing.output.driftPpm - 100) < .1)
  await binding.callAsync('Pause', [])
  const prepare = async (adaptive = false) => {
    await binding.callAsync('BridgePrepareTimed', [adaptive])
    await binding.callAsync('Play', [source])
    const deadline = Date.now() + 2000
    let status
    do {
      status = await binding.callAsync('BridgeStatus', [])
      if (status.receiver?.bufferedFrames >= facts.prebufferFrames && status.timing?.output.state === 'warming') break
      await delay(20)
    } while (Date.now() < deadline)
    assert.equal(status.timing.output.state, 'warming')
    assert.equal(facts.consumedFrames, 0, 'decoder/DSP PCM must remain unconsumed during silent preroll')
  }
  await prepare()
  const target = Number(process.hrtime.bigint()) / 1e6 + 350
  await binding.callAsync('BridgeArmTimed', [target, 44100])
  assert.ok(Math.abs(targetNodeMs - target) < 10)
  await delay(50)
  assert.equal(facts.consumedFrames, 0)
  await binding.callAsync('Pause', [])
  await until(() => timed.state === 'disabled')
  await delay(360)
  assert.equal(facts.consumedFrames, 0, 'cancelled native service intent must not sound at its old deadline')
  await prepare()
  await binding.callAsync('BridgeArmTimed', [Number(process.hrtime.bigint()) / 1e6 + 200, 0])
  await until(() => facts.consumedFrames >= 960)
  await binding.callAsync('BridgeCancelTimed', [])
  assert.equal(timed.state, 'disabled'); assert.equal(facts.started, false)
  await prepare(true)
  let corrected = await binding.callAsync('BridgeSetTimedCorrection', [200])
  assert.equal(corrected.adaptive.requestedPpm, 200)
  assert.equal(facts.consumedFrames, 0)
  await binding.callAsync('BridgeArmTimed', [Number(process.hrtime.bigint()) / 1e6 + 200, 0])
  await until(() => facts.consumedFrames >= 960)
  corrected = await binding.callAsync('BridgeSetTimedCorrection', [-200])
  assert.equal(corrected.adaptive.requestedPpm, -200)
  await binding.callAsync('BridgeCancelTimed', [])
  assert.equal(adaptive, null); assert.equal(facts.started, false)
  await prepare(true)
  await binding.callAsync('BridgeArmTimed', [Number(process.hrtime.bigint()) / 1e6 + 200, 0, true])
  let loop
  const loopDeadline = Date.now()+4500
  do {
    loop = await binding.callAsync('BridgeStatus', [])
    if (loop.synchronization?.state === 'correcting' && Math.abs(loop.synchronization.requestedPpm) > .5) break
    await delay(30)
  } while (Date.now() < loopDeadline)
  assert.equal(loop.synchronization.state, 'correcting')
  assert.ok(Math.abs(loop.synchronization.requestedPpm) > .5 && Math.abs(loop.synchronization.requestedPpm) <= 1000)
  await assert.rejects(binding.callAsync('BridgeSetTimedCorrection', [200]), /闭环控制/)
  await binding.callAsync('Pause', [])
  await until(() => timed.state === 'disabled')
  await delay(300)
  assert.equal((await binding.callAsync('BridgeStatus', [])).synchronization, null)
  assert.equal(facts.started, false)
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
  t.diagnostic('Synthetic device clock +100 ppm across production audio RPC: ' + measured.timing.output.driftPpm.toFixed(3) + ' ppm')
  t.diagnostic('Production timed lane: real decode/DSP PCM held before arm, armed Pause cancelled, explicit reprepare started successfully (simulated DAC).')
  t.diagnostic('Production adaptive RPC: optional prepare, generation-bound +/-200 ppm acknowledgements and joined cancel passed (simulated DAC/SRC; native sample accuracy tested in C++).')
  t.diagnostic('Production closed-loop RPC: paired presentation feedback issued automatic correction; manual rate ownership refused; Pause revoked future control (simulated DAC/SRC).')
})
