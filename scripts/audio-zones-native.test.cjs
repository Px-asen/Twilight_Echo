'use strict'
// Two production decoder/DSP services and real TLS; only DACs are simulated.
// No host audio device, application profile or external computer is used.
const assert = require('node:assert/strict')
const test = require('node:test')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

test('independent production Zones retain DSP and TLS output after one receiver fails', { timeout: 30000 }, async t => {
  await import('../src/adapters-node/index.ts')
  const [{ AudioEngineServiceBinding }, { AudioBridgeRuntime }, { createRemoteTlsIdentity }] = await Promise.all([
    import('../src/main/audioEngineServiceClient.ts'), import('../src/main/audio/bridgeRuntime.ts'),
    import('../src/adapters-node/remoteTlsIdentity.ts')
  ])
  const root = resolve(__dirname, '..'), directory = await mkdtemp(join(tmpdir(), 'twilight-zones-native-'))
  const zones = [], errors = []
  const until = async predicate => {
    const end = Date.now() + 5000
    while (!(await predicate()) && Date.now() < end) await delay(10)
    assert.ok(await predicate(), errors.join('\n'))
  }
  t.after(async () => {
    for (const zone of zones) {
      clearInterval(zone.clock)
      try { await zone.binding.callAsync('BridgeShutdown', []) } catch {}
      zone.binding.destroy(); await zone.receiver.close()
      if (zone.child && zone.child.exitCode === null && zone.child.signalCode === null) {
        const exit = once(zone.child, 'exit'); zone.child.kill(); await exit
      }
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  })
  const rate = 44100, count = rate * 8, wave = Buffer.alloc(44 + count * 4)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22); wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 4, 28)
  wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(count * 4, 40)
  for (let n = 0; n < count; n++) for (let c = 0; c < 2; c++)
    wave.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 1000 / rate) * 8192), 44 + (n * 2 + c) * 2)
  const source = join(directory, 'tone.wav'); await writeFile(source, wave)

  async function create(name, preamp) {
    const facts = { sampleRate: 48000, channels: 2, bufferedFrames: 0, capacityFrames: 12000, prebufferFrames: 1920,
      consumedFrames: 0, underruns: 0, started: false, failed: false, backend: 'wasapi-exclusive', deviceName: name,
      actualSampleRate: 48000, actualBitDepth: 24, actualChannels: 2, actualOutputFormat: 'int24', exclusive: true }
    const zone = { facts, blocks: [], child: null, clock: null }
    const dac = {
      Stop() {}, SetOutputDevice() {}, SetOutputBackend() {}, PullBridgePcm() { throw Error('Receiver must not decode') },
      OpenBridgeReceiver(backend, device) {
        assert.equal(backend, 'wasapi-exclusive'); assert.equal(device, name)
        facts.bufferedFrames = facts.consumedFrames = 0; facts.started = false
      },
      CloseBridgeReceiver() { facts.bufferedFrames = 0; facts.started = false },
      WriteBridgePcm(data) {
        if (zone.blocks.length < 30) zone.blocks.push(Buffer.from(data))
        facts.bufferedFrames += data.length / 8
        assert.ok(facts.bufferedFrames <= facts.capacityFrames)
        if (facts.bufferedFrames >= facts.prebufferFrames) facts.started = true
      },
      StartBridgeReceiver() { facts.started = true }, GetBridgeReceiverInfo() { return JSON.stringify(facts) }
    }
    zone.receiver = new AudioBridgeRuntime(dac)
    zone.binding = new AudioEngineServiceBinding({ serviceEntry: join(root, 'out/main/audioEngineService.js'), requestTimeoutMs: 5000,
      launch() {
        const child = fork(join(root, 'out/main/audioEngineService.js'), [], { execArgv: [], cwd: root,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
        zone.child = child; child.stdout.resume(); child.stderr.on('data', data => errors.push(String(data)))
        child.postMessage = message => child.send(message)
        return child
      }
    })
    zones.push(zone)
    zone.clock = setInterval(() => { if (facts.started) {
      const n = Math.min(480, facts.bufferedFrames); facts.bufferedFrames -= n; facts.consumedFrames += n
    } }, 10)
    const identity = createRemoteTlsIdentity()
    const grant = await zone.receiver.startHost({ ...identity, name, backend: 'wasapi-exclusive', device: name, sampleRate: 48000 })
    zone.peer = { host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }
    await zone.binding.callAsync('BridgeConnect', [zone.peer])
    await zone.binding.callAsync('SetVolume', [1])
    await zone.binding.callAsync('SetDspConfig', [JSON.stringify({ dspEnabled: true, eqEnabled: true, eqPreamp: preamp, fftEnabled: false })])
    return zone
  }
  const a = await create('Fixture DAC A', -6), b = await create('Fixture DAC B', 0)
  assert.notEqual(a.child.pid, b.child.pid)
  await Promise.all([a.binding.callAsync('Play', [source]), b.binding.callAsync('Play', [source])])
  await until(() => a.blocks.length >= 14 && b.blocks.length >= 14)
  const rms = zone => {
    let squares = 0, samples = 0
    for (const block of zone.blocks.slice(3, 14)) for (let n = 0; n < block.length; n += 4) {
      squares += block.readFloatLE(n) ** 2; samples++
    }
    return Math.sqrt(squares / samples)
  }
  const ratio = rms(a) / rms(b)
  assert.ok(ratio > .48 && ratio < .53, `independent preamp RMS ratio ${ratio}`)
  const before = b.facts.consumedFrames
  a.facts.failed = true
  await until(async () => !(await a.binding.callAsync('BridgeStatus', [])).connected)
  const lost = await a.binding.callAsync('BridgeStatus', [])
  assert.equal(lost.selected, true)
  await assert.rejects(a.binding.callAsync('Play', [source]), /未连接/)
  await a.binding.callAsync('Pause', []) // Safe silence remains usable offline.
  await until(() => b.facts.consumedFrames >= before + 9600)
  assert.equal((await b.binding.callAsync('BridgeStatus', [])).connected, true)
  a.facts.failed = false
  await a.binding.callAsync('BridgeConnect', [a.peer])
  await a.binding.callAsync('Play', [source])
  await until(() => a.facts.consumedFrames > 1920)
  const beforeCrash = b.facts.consumedFrames
  const crashed = once(a.child, 'exit')
  a.child.kill(); await crashed; a.binding.destroy()
  await until(() => b.facts.consumedFrames >= beforeCrash + 9600)
  assert.equal((await b.binding.callAsync('BridgeStatus', [])).connected, true)
  assert.equal(JSON.parse(await b.binding.callAsync('GetPlaybackInfo', [])).outputBackend, 'bridge-pcm')
  await b.binding.callAsync('Stop', [])
  t.diagnostic(`Two decoder processes, independent -6/0 dB DSP RMS ratio ${ratio.toFixed(4)}; B consumed >=9600 further frames after A DAC failure and again after A process crash.`)
})
