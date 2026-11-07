import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, connect } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { createRemoteTlsIdentity } from '../../adapters-node/remoteTlsIdentity.ts'
import { AudioBridgeRuntime } from './bridgeRuntime.ts'
import type { NativeAudioBinding } from '../../core/audio/audioEngineTypes.ts'
import { bridgeInvitation, parseBridgeInvitation, type BridgeReceiverFacts, type BridgeTimedStartFacts, type BridgeAdaptiveFacts } from '../../shared/audioBridge.ts'
import { validRemoteDspEdit, projectRemoteDsp } from '../../shared/remoteDsp.ts'
import { readBridgePackets, sendBridgeJson } from './bridgeWire.ts'

class NativeFixture {
  backend = 'wasapi'; device = 'explicit-dac'; playing = false; generation = 0
  value = .25; stopped = 0; closed = 0; received: number[] = []; opens: string[] = []
  opened = false; observeClock = false; streamGeneration = 0; startedAt = 0
  facts: BridgeReceiverFacts = { sampleRate: 48000, channels: 2, bufferedFrames: 0, capacityFrames: 12000, prebufferFrames: 1920,
    consumedFrames: 0, underruns: 0, started: false, failed: false, backend: 'wasapi-exclusive', deviceName: 'USB DAC',
    actualSampleRate: 48000, actualBitDepth: 24, actualChannels: 2, actualOutputFormat: 'int24-in32', exclusive: true }
  binding(): NativeAudioBinding { return this as unknown as NativeAudioBinding }
  Stop = () => { this.playing = false; ++this.generation; ++this.stopped }
  SetOutputBackend = (backend: string) => { this.backend = backend }
  SetOutputDevice = (device: string) => { this.device = device }
  GetPlaybackInfo = () => JSON.stringify({ outputBackend: this.backend, outputDevice: this.device })
  PullBridgePcm = (frames: number) => {
    const pcm = Buffer.alloc(frames * 8)
    for (let n = 0; n < frames * 2; ++n) pcm.writeFloatLE(this.value, n * 4)
    return { sampleRate: 48000, channels: 2, frames: this.playing ? frames : 0, pcm: this.playing ? pcm : Buffer.alloc(0),
      generation: this.generation, playing: this.playing }
  }
  OpenBridgeReceiver = (backend: string, device: string) => {
    this.opened = true; ++this.streamGeneration; this.startedAt = 0
    this.opens.push(`${backend}/${device}`)
    this.facts = { ...this.facts, bufferedFrames: 0, consumedFrames: 0, started: false, failed: false }
  }
  CloseBridgeReceiver = () => { this.opened = false; this.facts.bufferedFrames = 0; this.facts.started = false; ++this.closed }
  WriteBridgePcm = (data: Buffer) => {
    assert.ok(data.length / 8 + this.facts.bufferedFrames <= this.facts.capacityFrames)
    this.facts.bufferedFrames += data.length / 8
    this.received.push(data.readFloatLE(0))
    if (this.facts.bufferedFrames >= this.facts.prebufferFrames) this.facts.started = true
  }
  StartBridgeReceiver = () => { this.facts.started = true }
  GetBridgeReceiverInfo = () => {
    assert.ok(this.opened, 'clock/facts query must not access a closed native handle')
    if (!this.observeClock) return JSON.stringify(this.facts)
    const now = Number(process.hrtime.bigint()) / 1e6
    if (this.facts.started && !this.startedAt) this.startedAt = now
    return JSON.stringify({ ...this.facts, clock: {
      supported: true, valid: this.facts.started, running: this.facts.started, source: 'wasapi-audio-clock',
      streamGeneration: this.streamGeneration, epoch: 1, positionFrames: this.facts.started ? (now - this.startedAt) * 48 * 1.0001 : 0,
      sampledAtMs: now + 40000, readAtMs: now + 40000, sampleRate: 48000,
      callbackRequestedFrames: this.facts.consumedFrames + 512
    } })
  }
  consume() {
    if (!this.facts.started) return
    const count = Math.min(480, this.facts.bufferedFrames)
    this.facts.bufferedFrames -= count; this.facts.consumedFrames += count
  }
}
const mono = () => Number(process.hrtime.bigint()) / 1e6
class TimedNativeFixture extends NativeFixture {
  prepareCount = 0; armFails = false; targetNodeMs = 0
  timed: BridgeTimedStartFacts = this.disabled()
  private disabled(): BridgeTimedStartFacts { return { supported: true, state: 'disabled', error: '', ended: false,
    targetAtMs: 0, mediaFrame: 0, deviceStartFrame: null, deviceStartAtMs: null, presentedMediaFrames: null } }
  constructor() {
    super(); this.observeClock = true
    const open = this.OpenBridgeReceiver, close = this.CloseBridgeReceiver, info = this.GetBridgeReceiverInfo
    this.OpenBridgeReceiver = (backend, device) => { open(backend, device); this.timed = this.disabled(); this.targetNodeMs = 0 }
    this.CloseBridgeReceiver = () => { close(); this.timed = this.disabled(); this.targetNodeMs = 0 }
    this.GetBridgeReceiverInfo = () => JSON.stringify({ ...JSON.parse(info()), timedStart: this.timed })
  }
  PrepareBridgeTimedReceiver = () => { assert.ok(this.opened); ++this.prepareCount; this.timed.state = 'prepared'; this.facts.started = true }
  ArmBridgeTimedReceiver = (time: number, generation: number, mediaFrame: number) => {
    assert.equal(generation, this.streamGeneration)
    assert.ok(!this.armFails && this.timed.state === 'prepared' && this.facts.bufferedFrames >= this.facts.prebufferFrames)
    assert.ok(time - 40000 > mono() + 40 && time - 40000 < mono() + 2000)
    this.targetNodeMs = time - 40000; this.timed.targetAtMs = time; this.timed.mediaFrame = mediaFrame; this.timed.state = 'armed'
  }
  EndBridgeTimedReceiver = () => { this.timed.ended = true }
  override consume() {
    if (this.timed.state === 'disabled') return super.consume()
    if (!this.targetNodeMs || mono() < this.targetNodeMs) return
    this.timed.state = 'running'; this.timed.deviceStartFrame = 4800; this.timed.deviceStartAtMs = this.timed.targetAtMs
    super.consume(); this.timed.presentedMediaFrames = this.facts.consumedFrames
  }
}
class AdaptiveNativeFixture extends TimedNativeFixture {
  adaptive: BridgeAdaptiveFacts | null = null
  rates: number[] = []; rateFails = false; creditLimit = 700
  constructor() {
    super(); this.facts.adaptiveSupported = true
    const info = this.GetBridgeReceiverInfo, write = this.WriteBridgePcm, close = this.CloseBridgeReceiver
    this.GetBridgeReceiverInfo = () => {
      if (this.adaptive) this.adaptive.inputCreditFrames = this.timed.ended ? 0 : Math.min(this.creditLimit, this.facts.capacityFrames-this.facts.bufferedFrames)
      return JSON.stringify({ ...JSON.parse(info()), adaptive: this.adaptive })
    }
    this.WriteBridgePcm = data => {
      if (this.adaptive) { assert.ok(data.length/8 <= this.adaptive.inputCreditFrames); this.adaptive.inputFrames += data.length/8 }
      write(data)
    }
    this.CloseBridgeReceiver = () => { close(); this.adaptive = null }
  }
  PrepareBridgeAdaptiveReceiver = () => {
    this.PrepareBridgeTimedReceiver()
    this.adaptive = { requestedPpm: 0, effectivePpm: 0, inputFrames: 0, pendingInputFrames: 0,
      resamplerDelayFrames: 134, sourceConsumedFrames: 0, inputCreditFrames: this.creditLimit }
  }
  SetBridgeTimedCorrection = (ppm: number, generation: number) => {
    assert.ok(!this.rateFails && this.adaptive && generation === this.streamGeneration && !this.timed.ended)
    this.adaptive.requestedPpm = this.adaptive.effectivePpm = ppm; this.rates.push(ppm)
  }
  override consume() {
    super.consume()
    if (this.adaptive) {
      this.adaptive.sourceConsumedFrames = Math.min(this.adaptive.inputFrames, this.facts.consumedFrames)
      if (this.timed.ended && !this.facts.bufferedFrames) this.timed.state = 'completed'
    }
  }
}
class ContinuousAdaptiveFixture extends AdaptiveNativeFixture {
  sourcePosition = 0; sourceUpdatedAt = 0; omitPresentation = false
  constructor() {
    super()
    const info = this.GetBridgeReceiverInfo, correction = this.SetBridgeTimedCorrection, open = this.OpenBridgeReceiver
    const advance = () => {
      const now = mono()
      if (this.targetNodeMs && this.adaptive && ['armed', 'running', 'completed'].includes(this.timed.state)) {
        const elapsed = Math.max(0, now-Math.max(this.sourceUpdatedAt, this.targetNodeMs))
        this.sourcePosition = Math.min(this.adaptive.inputFrames, this.sourcePosition+
          elapsed*48*1.0002/(1+this.adaptive.requestedPpm*1e-6))
      }
      this.sourceUpdatedAt = now
    }
    this.OpenBridgeReceiver = (backend, device) => { open(backend, device); this.sourcePosition = this.sourceUpdatedAt = 0 }
    this.GetBridgeReceiverInfo = () => {
      advance()
      const facts = JSON.parse(info())
      if (facts.clock.valid) facts.clock.positionFrames = (facts.clock.sampledAtMs-40000-this.startedAt)*48*1.0002
      if (this.targetNodeMs && this.adaptive && facts.timedStart.deviceStartFrame !== null) {
        if (this.timed.state === 'completed') this.sourcePosition = this.adaptive.inputFrames
        facts.timedStart.presentedMediaFrames = this.omitPresentation ? null : this.sourcePosition
      }
      return JSON.stringify(facts)
    }
    this.SetBridgeTimedCorrection = (ppm, generation) => { advance(); correction(ppm, generation) }
  }
}
async function until(predicate: () => boolean, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs
  while (!predicate() && Date.now() < end) await delay(10)
  assert.ok(predicate(), 'condition was not reached')
}

test('source timeline stays on the private Core port and is cleared after failure/flush', async t => {
  const a = new NativeFixture(), b = new NativeFixture()
  const pull = a.PullBridgePcm
  let frames = 0
  a.PullBridgePcm = count => ({ ...pull(count), sourceTimeline: JSON.stringify({ generation: a.generation,
    sampleRate: 48000, frames: frames += count, positionFrames: frames, transitionSerial: 0, transitionFrame: 0,
    entryId: 'legacy:C:/private/library/disc.wav:1' }) })
  const sender = new AudioBridgeRuntime(a.binding()), receiver = new AudioBridgeRuntime(b.binding())
  const clock = setInterval(() => b.consume(), 10)
  t.after(async () => { clearInterval(clock); await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Private', backend: 'wasapi-exclusive', device: 'explicit', sampleRate: 48000 })
  await sender.connectPeer({ host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint })
  a.playing = true
  await until(() => !!sender.sourceTimeline())
  assert.equal(sender.sourceTimeline()?.entryId, 'legacy:C:/private/library/disc.wav:1')
  assert.equal(JSON.stringify(sender.state()).includes('private/library'), false)
  assert.equal(JSON.stringify(receiver.state()).includes('private/library'), false)
  assert.equal('sourceTimeline' in sender.state(), false)
  sender.beforeCall('Pause', []); a.playing = false
  assert.equal(sender.sourceTimeline(), null)
  await receiver.stopHost(); await until(() => !sender.state().connected)
  assert.equal(sender.sourceTimeline(), null)
})

test('group source setup withholds every PCM frame until DSP controls are acknowledged', async t => {
  const a = new NativeFixture(), b = new AdaptiveNativeFixture()
  let commits = 0
  Object.assign(a, { CommitBridgeSourceControls: () => { commits++ } })
  const sender = new AudioBridgeRuntime(a.binding()), receiver = new AudioBridgeRuntime(b.binding())
  const clock = setInterval(() => b.consume(), 10)
  t.after(async () => { clearInterval(clock); await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Held source', backend: 'wasapi-exclusive', device: 'explicit', sampleRate: 48000 })
  await sender.connectPeer({ host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint })
  const prepared = await sender.prepareTimedPlayback(true, true)
  sender.beforeCall('Play', []); a.playing = true
  await delay(120)
  assert.equal(b.received.length, 0)
  assert.equal(b.timed.ended, false)
  sender.afterCall('ApplyDspState')
  assert.equal(commits, 1)
  assert.throws(() => sender.releaseTimedMedia(prepared.epoch-1), /取消/)
  sender.releaseTimedMedia(prepared.epoch)
  await until(() => b.received.length > 0)
  sender.beforeCall('Pause', [])
  assert.throws(() => sender.releaseTimedMedia(prepared.epoch), /取消/)
})
test('TLS authorization, DAC credit pacing, transport flush, revocation and no speaker fallback', async t => {
  const a = new NativeFixture(), b = new NativeFixture()
  const sender = new AudioBridgeRuntime(a.binding()), receiver = new AudioBridgeRuntime(b.binding())
  const clock = setInterval(() => b.consume(), 10)
  t.after(async () => { clearInterval(clock); await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Study DAC', backend: 'wasapi-exclusive', device: 'explicit-dac', sampleRate: 48000 })
  const peer = { host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }
  assert.deepEqual(parseBridgeInvitation(bridgeInvitation(peer)), peer)
  assert.throws(() => parseBridgeInvitation('not-an-invite'), /输出桥邀请无效/)
  await assert.rejects(sender.connectPeer({ ...peer, fingerprint: '0'.repeat(64) }), /证书/)
  assert.equal(sender.state().selected, true)
  assert.equal(a.backend, 'wasapi') // still stopped; no automatic resume
  await assert.rejects(sender.connectPeer({ ...peer, token: '0'.repeat(48) }), /关闭/)
  assert.equal(receiver.state().receiving, false)
  await sender.connectPeer(peer)
  const stops = a.stopped
  await assert.rejects(sender.prepareTimedPlayback(), /不支持/)
  assert.equal(a.stopped, stops) // A new capability never becomes a prerequisite for old playback.
  assert.equal(a.backend, 'bridge-pcm'); assert.equal(a.device, '48000/2')
  a.playing = true
  await until(() => b.received.length > 5)
  assert.ok(b.received.every(n => n === .25))
  assert.ok(b.facts.bufferedFrames <= 4800)
  assert.ok(b.facts.consumedFrames > 0)
  const closes = b.closed
  sender.beforeCall('Seek', [50]); ++a.generation; a.value = -.5
  await until(() => b.received.includes(-.5))
  assert.ok(b.closed > closes)
  assert.ok(b.opens.every(route => route === 'wasapi-exclusive/explicit-dac'))
  sender.beforeCall('SetOutputBackend', ['asio'])
  assert.equal(a.backend, 'bridge-pcm')
  await receiver.stopHost()
  await until(() => !sender.state().connected)
  assert.equal(a.playing, false); assert.equal(a.backend, 'bridge-pcm')
  assert.throws(() => sender.beforeCall('Play', []), /未连接/)
  sender.disconnectPeer()
  assert.equal(a.backend, 'asio'); assert.equal(a.device, 'explicit-dac')
  assert.equal(sender.state().selected, false)
})

test('closing a bridge-only sender releases TLS and audio without restoring an unavailable local backend', async t => {
  const native = new NativeFixture(), dac = new NativeFixture()
  native.backend = 'alsa'
  const sender = new AudioBridgeRuntime(native.binding()), receiver = new AudioBridgeRuntime(dac.binding())
  t.after(async () => { await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Shutdown DAC', backend: 'wasapi-exclusive', device: 'explicit-dac', sampleRate: 48000 })
  await sender.connectPeer({ host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint })
  const backendChanges: string[] = []
  native.SetOutputBackend = backend => { backendChanges.push(backend); throw Error('Output backend is not available in this build: ' + backend) }
  native.playing = true
  await sender.close()
  await until(() => !receiver.state().receiving)
  assert.deepEqual(backendChanges, [])
  assert.equal(native.backend, 'bridge-pcm')
  assert.equal(native.playing, false)
  assert.equal(sender.state().connected, false)
  assert.equal(sender.state().selected, true)
  assert.equal(dac.opened, false)
})

test('a restarted selected Bridge quarantines playback and local route restoration until explicit release', async t => {
  const native = new NativeFixture(), runtime = new AudioBridgeRuntime(native.binding())
  t.after(() => runtime.close())
  runtime.quarantine()
  assert.equal(runtime.state().selected, true)
  assert.equal(runtime.state().connected, false)
  assert.deepEqual(runtime.beforeCall('SetOutputBackend', ['asio']), ['bridge-pcm'])
  assert.deepEqual(runtime.beforeCall('SetOutputDevice', ['saved-local-dac']), ['48000/2'])
  assert.throws(() => runtime.beforeCall('Play', ['track.wav']), /未连接/)
  assert.deepEqual(runtime.beforeCall('Pause', []), []) // offline queue preparation only silences
  runtime.disconnectPeer()
  assert.equal(native.backend, 'asio'); assert.equal(native.device, 'saved-local-dac')
  assert.equal(runtime.state().selected, false)
})
test('host consent refuses default devices; DSP remote edits cannot introduce files or plugins', async t => {
  const fixture = new NativeFixture(), runtime = new AudioBridgeRuntime(fixture.binding())
  t.after(() => runtime.close())
  await assert.rejects(runtime.startHost({ ...createRemoteTlsIdentity(), name: 'DAC', backend: 'wasapi', device: 'auto', sampleRate: 48000 }), /明确选择/)
  for (const device of ['default', 'System Default', 'system default', 'system-default', '系统默认'])
    await assert.rejects(runtime.startHost({ ...createRemoteTlsIdentity(), name: 'DAC', backend: 'wasapi', device, sampleRate: 48000 }), /明确选择/)
  for (const device of ['alsa:default', 'pulse', 'pipewire'])
    await assert.rejects(runtime.startHost({ ...createRemoteTlsIdentity(), name: 'DAC', backend: 'alsa', device, sampleRate: 48000 }), /明确选择/)
  assert.equal(fixture.opens.length, 0)
  assert.equal(validRemoteDspEdit({ edit: { kind: 'processing', settings: { convolverIrPath: 'C:/secret.wav' } } }), false)
  assert.equal(validRemoteDspEdit({ edit: { kind: 'scenes', scenes: [] } }), false)
  assert.equal(validRemoteDspEdit({ edit: { kind: 'processing', settings: { eqPreamp: -6 } } }), true)
  const dsp = projectRemoteDsp({ revision: 4, processing: { eqPreamp: -6, convolverIrPath: 'private' },
    scenes: { scenes: [{ id: 'room', name: 'Room', enabled: true, graph: { private: 'private' } }], activeSceneId: 'room', pinnedSceneId: 'room' }
  } as any)
  assert.ok(!JSON.stringify(dsp).includes('private'))
})

test('large DAC startup buffers receive enough credit to start without a pacing deadlock', async t => {
  const a = new NativeFixture(), b = new NativeFixture()
  b.facts.prebufferFrames = 8192
  const sender = new AudioBridgeRuntime(a.binding()), receiver = new AudioBridgeRuntime(b.binding())
  const clock = setInterval(() => b.consume(), 10)
  t.after(async () => { clearInterval(clock); await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Large ASIO', backend: 'asio', device: 'explicit-dac', sampleRate: 48000 })
  const peer = { host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }
  await sender.connectPeer(peer)
  a.playing = true
  await until(() => b.facts.consumedFrames > 4800)
  assert.ok(b.facts.bufferedFrames <= 8192)
})

test('negotiated TLS clock probes measure independent presentation clock; flush and reconnect invalidate observations', async t => {
  const a = new NativeFixture(), b = new NativeFixture(); b.observeClock = true
  const sender = new AudioBridgeRuntime(a.binding()), receiver = new AudioBridgeRuntime(b.binding())
  const timer = setInterval(() => b.consume(), 10)
  t.after(async () => { clearInterval(timer); await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Clock fixture', backend: 'wasapi-exclusive', device: 'explicit-dac', sampleRate: 48000 })
  const peer = { host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }
  await sender.connectPeer(peer); a.playing = true
  await until(() => sender.state().timing?.output.state === 'ready', 5000)
  const status = sender.state().timing!
  assert.equal(status.network.state, 'ready')
  assert.ok(Math.abs(status.output.driftPpm! - 100) < .01)
  assert.ok(status.output.ageMs! < 1000)
  assert.ok(status.output.positionFrames! > 48000)
  const generation = status.output.streamGeneration
  sender.beforeCall('Pause', []); a.playing = false
  await until(() => sender.state().timing?.output.state === 'stopped')
  assert.equal(sender.state().timing!.output.driftPpm, null)
  assert.equal(sender.state().timing!.output.samples, 0)
  a.playing = true
  await until(() => (sender.state().timing?.output.streamGeneration ?? 0) > generation)
  assert.equal(sender.state().timing!.output.state, 'warming')
  sender.disconnectPeer()
  assert.equal(sender.state().timing, null)
  await until(() => !receiver.state().receiving)
  await sender.connectPeer(peer)
  assert.notEqual(sender.state().timing?.output.state, 'ready')
})

test('legacy receiver stays usable without clock probes; revoked/duplicate clock replies cannot resurrect a stream', async t => {
  const identity = createRemoteTlsIdentity(), native = new NativeFixture(), facts = native.facts
  const runtime = new AudioBridgeRuntime(native.binding())
  const sockets = new Set<import('node:tls').TLSSocket>()
  let advertise = false, probes = 0
  let reply: (() => void) | undefined
  const server = createServer({ key: identity.key, cert: identity.cert }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    readBridgePackets(socket, (kind, data) => {
      assert.equal(kind, 0)
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') {
        sendBridgeJson(socket, { type: 'ready', version: 1, name: 'Old Bridge', facts,
          ...(advertise ? { capabilities: ['clock-v1'] } : {}) })
        sendBridgeJson(socket, { type: 'pull', credit: 1, frames: 128, facts })
      } else if (message.type === 'clock-probe') {
        probes++
        const now = Number(process.hrtime.bigint()) / 1e6
        reply = () => sendBridgeJson(socket, { type: 'clock-pong', seq: message.seq, epoch: message.epoch,
          remoteReceiveMs: now, remoteSendMs: now, nativeReadBeforeMs: now, nativeReadAfterMs: now, clock: null })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await runtime.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const peer = { host: '127.0.0.1', port: (server.address() as AddressInfo).port, token: 'a'.repeat(48), fingerprint: identity.fingerprint }
  await runtime.connectPeer(peer)
  await delay(350)
  assert.equal(probes, 0); assert.equal(runtime.state().timing, null)
  assert.equal(runtime.state().connected, true)
  runtime.disconnectPeer(); advertise = true
  await runtime.connectPeer(peer)
  await until(() => !!reply)
  const oldReply = reply!
  runtime.beforeCall('Stop', [])
  oldReply(); oldReply()
  await delay(50)
  assert.equal(runtime.state().timing!.network.samples, 0)
  assert.equal(runtime.state().connected, true)
  await until(() => probes > 1)
  reply!()
  await until(() => runtime.state().timing!.network.samples === 1)
  reply!() // Duplicate is ignored, not counted twice.
  await delay(20)
  assert.equal(runtime.state().timing!.network.samples, 1)
})

test('clock probes cannot keep a stalled PCM credit alive or pin an open DAC indefinitely', async t => {
  const native = new NativeFixture(), receiver = new AudioBridgeRuntime(native.binding())
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Credit timeout', backend: 'wasapi-exclusive', device: 'explicit-dac', sampleRate: 48000 })
  const socket = connect({ host: '127.0.0.1', port: grant.port, rejectUnauthorized: false })
  socket.on('error', () => {})
  await new Promise<void>(resolve => socket.once('secureConnect', resolve))
  sendBridgeJson(socket, { type: 'hello', version: 1, token: grant.token, capabilities: ['clock-v1'] })
  let pulls = 0, pongs = 0, seq = 0
  readBridgePackets(socket, (_kind, data) => {
    const message = JSON.parse(data.toString())
    if (message.type === 'pull') pulls++ // Deliberately never return PCM or idle.
    if (message.type === 'clock-pong') pongs++
  })
  const timer = setInterval(() => { if (!socket.destroyed) sendBridgeJson(socket, { type: 'clock-probe', seq: ++seq, epoch: 0 }) }, 200)
  t.after(async () => { clearInterval(timer); socket.destroy(); await receiver.close() })
  await until(() => receiver.state().receiving)
  await until(() => !receiver.state().receiving, 4000)
  assert.equal(pulls, 1); assert.ok(pongs >= 5)
  assert.equal(native.opened, false)
})

async function timedPair(t: import('node:test').TestContext, b: TimedNativeFixture = new TimedNativeFixture()) {
  const a = new NativeFixture()
  const sender = new AudioBridgeRuntime(a.binding()), receiver = new AudioBridgeRuntime(b.binding())
  const timer = setInterval(() => b.consume(), 10)
  t.after(async () => { clearInterval(timer); await sender.close(); await receiver.close() })
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Timed fixture', backend: 'wasapi-exclusive', device: 'explicit-dac', sampleRate: 48000 })
  const peer = { host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint }
  await sender.connectPeer(peer)
  await until(() => sender.state().timing?.network.state === 'ready')
  return { a, b, sender, receiver, peer }
}
async function feedTimed(pair: Awaited<ReturnType<typeof timedPair>>) {
  const prepared = await pair.sender.prepareTimedPlayback()
  pair.sender.beforeCall('Play', []); pair.a.playing = true
  await until(() => (pair.sender.state().receiver?.bufferedFrames ?? 0) >= pair.b.facts.prebufferFrames &&
    pair.sender.state().timing?.output.state === 'warming')
  return prepared
}
test('TLS timed preparation holds media, maps Core time to native time and cancels an armed deadline on Pause', async t => {
  const pair = await timedPair(t), { a, b, sender } = pair
  await feedTimed(pair)
  assert.equal(b.facts.consumedFrames, 0)
  const target = mono() + 350
  const armed = await sender.armTimedPlayback(target, 96000)
  assert.equal(armed.timedStart?.state, 'armed'); assert.equal(armed.timedStart?.mediaFrame, 96000)
  assert.ok(Math.abs(b.targetNodeMs - target) < 10)
  await delay(70)
  assert.equal(b.facts.consumedFrames, 0)
  sender.beforeCall('Pause', []); a.playing = false
  await delay(370)
  assert.equal(b.timed.state, 'disabled'); assert.equal(b.facts.consumedFrames, 0)
  assert.equal(sender.state().selected, true); assert.equal(sender.state().connected, true)
  await feedTimed(pair)
  await sender.armTimedPlayback(mono() + 200)
  await until(() => b.facts.consumedFrames > 0)
  assert.equal(b.timed.state, 'running')
  assert.ok(b.received.every(n => n === .25))
  await sender.cancelTimedPlayback()
  assert.equal(b.opened, false); assert.equal(b.timed.state, 'disabled')
  assert.equal(a.playing, false)
})

test('adaptive PCM is opt-in and requires negotiated support without changing legacy timed playback', async t => {
  const { sender, a } = await timedPair(t)
  const stops = a.stopped
  await assert.rejects(sender.prepareTimedPlayback(true), /时钟自适应/)
  assert.equal(a.stopped, stops)
  const prepared = await sender.prepareTimedPlayback()
  assert.equal(prepared.receiver.adaptive, null)
  await assert.rejects(sender.setTimedCorrection(100), /当前自适应流/)
})

test('TLS adaptive lane honors input credit, acknowledges correction, observes EOF without extra PCM and cancels old rates', async t => {
  const b = new AdaptiveNativeFixture(), { sender, a } = await timedPair(t, b)
  const prepared = await sender.prepareTimedPlayback(true)
  assert.equal(prepared.receiver.adaptive?.requestedPpm, 0)
  await sender.setTimedCorrection(200)
  sender.beforeCall('Play', []); a.playing = true
  await until(() => (sender.state().receiver?.bufferedFrames ?? 0) >= b.facts.prebufferFrames &&
    sender.state().timing?.output.state === 'warming')
  assert.equal(b.facts.consumedFrames, 0)
  const corrected = await sender.setTimedCorrection(-200)
  assert.equal(corrected.adaptive?.requestedPpm, -200)
  assert.deepEqual(b.rates, [200, -200])
  await assert.rejects(sender.setTimedCorrection(1001), /1000 ppm/)
  await sender.armTimedPlayback(mono()+200)
  await until(() => b.facts.consumedFrames > 0)
  a.playing = false // acknowledged finite EOF, not Pause/Stop.
  await until(() => sender.state().receiver?.timedStart?.state === 'completed')
  const consumed = b.facts.consumedFrames
  await delay(3100)
  assert.equal(sender.state().connected, true)
  assert.equal(b.facts.consumedFrames, consumed)
  assert.equal(sender.state().receiver?.adaptive?.inputCreditFrames, 0)
  await sender.cancelTimedPlayback()
  assert.equal(sender.state().receiver?.adaptive, null)
  await sender.prepareTimedPlayback(true)
  const pending = sender.setTimedCorrection(50)
  const rejected = assert.rejects(pending, /取消/)
  sender.beforeCall('Stop', []); await rejected
  await delay(50)
  assert.equal(b.adaptive, null); assert.equal(b.opened, false)
  assert.equal(a.playing, false); assert.equal(a.backend, 'bridge-pcm')
})

test('native adaptive correction failure cancels the stream without retry or local speaker fallback', async t => {
  const b = new AdaptiveNativeFixture(), { sender, a } = await timedPair(t, b)
  await sender.prepareTimedPlayback(true); b.rateFails = true
  await assert.rejects(sender.setTimedCorrection(200), /定时操作失败/)
  await until(() => b.adaptive === null)
  assert.equal(b.rates.length, 0); assert.equal(a.playing, false); assert.equal(a.backend, 'bridge-pcm')
})

test('Core timeline feedback owns rate commands, stops on missing presentation and cannot restart after Pause', async t => {
  const b = new ContinuousAdaptiveFixture(), { sender, a } = await timedPair(t, b)
  const start = async () => {
    await sender.prepareTimedPlayback(true)
    sender.beforeCall('Play', []); a.playing = true
    await until(() => (sender.state().receiver?.bufferedFrames ?? 0) >= b.facts.prebufferFrames &&
      sender.state().timing?.output.state === 'warming')
    await sender.armTimedPlayback(mono()+200, 0, true)
  }
  await start()
  await until(() => b.rates.length >= 3, 5000)
  assert.equal(sender.state().synchronization?.state, 'correcting')
  assert.ok(b.rates.every(ppm => Math.abs(ppm) <= 1000))
  await assert.rejects(sender.setTimedCorrection(200), /闭环控制/)
  sender.beforeCall('Pause', []); a.playing = false
  await until(() => !b.opened)
  const rates = b.rates.length
  await delay(350)
  assert.equal(sender.state().synchronization, null); assert.equal(b.rates.length, rates)
  await start()
  await until(() => sender.state().synchronization?.state === 'correcting')
  b.omitPresentation = true
  await until(() => sender.state().synchronization?.state === 'failed', 2000)
  assert.equal(sender.state().synchronization?.error, 'presentation_clock_stale')
  assert.equal(a.playing, false); assert.equal(a.backend, 'bridge-pcm'); assert.equal(sender.state().connected, true)
  await until(() => !b.opened)
  await delay(300)
  assert.equal(b.opened, false)
  await sender.cancelTimedPlayback()
  assert.equal(sender.state().synchronization, null)
})

test('EOF overtaking a rate command drains unchanged instead of cancelling the tail', async t => {
  const b = new AdaptiveNativeFixture(), { sender, a } = await timedPair(t, b)
  await sender.prepareTimedPlayback(true)
  sender.beforeCall('Play', []); a.playing = true
  await until(() => (sender.state().receiver?.bufferedFrames ?? 0) >= b.facts.prebufferFrames &&
    sender.state().timing?.output.state === 'warming')
  await sender.armTimedPlayback(mono()+200)
  await until(() => b.facts.consumedFrames > 0)
  a.playing = false
  await until(() => b.timed.ended)
  const corrected = await sender.setTimedCorrection(200)
  assert.equal(corrected.timedStart?.ended, true)
  assert.equal(corrected.adaptive?.requestedPpm, 0)
  assert.equal(b.rates.length, 0)
  await until(() => sender.state().receiver?.timedStart?.state === 'completed')
  assert.equal(sender.state().connected, true)
})

test('same-peer automatic re-arm retains learned rate, while explicit manual correction and reconnect discard it', async t => {
  const b = new ContinuousAdaptiveFixture(), { sender, a, peer } = await timedPair(t, b)
  const prepare = async () => {
    const prepared = await sender.prepareTimedPlayback(true)
    assert.equal(prepared.receiver.adaptive?.requestedPpm,0) // Existing prepare/manual contract.
    sender.beforeCall('Play',[]);a.playing=true
    await until(()=>(sender.state().receiver?.bufferedFrames??0)>=b.facts.prebufferFrames&&sender.state().timing?.output.state==='warming')
  }
  await prepare();await sender.armTimedPlayback(mono()+400,1,true)
  await until(()=>b.rates.length>=3&&sender.state().timing?.output.driftPpm!==null,5000)
  const learned=sender.state().synchronization!.effectivePpm!
  await sender.cancelTimedPlayback();await prepare()
  const before=b.rates.length
  await sender.armTimedPlayback(mono()+400,2,true)
  assert.equal(b.rates[before],learned)
  assert.equal(sender.state().synchronization?.samples,0) // New media phase/clock identity.
  await sender.cancelTimedPlayback();await prepare()
  await sender.setTimedCorrection(50)
  const manual=b.rates.length
  await sender.armTimedPlayback(mono()+400,3,true)
  assert.equal(b.rates.length,manual);assert.equal(sender.state().receiver?.adaptive?.requestedPpm,50)
  await sender.cancelTimedPlayback()
  sender.disconnectPeer();await sender.connectPeer(peer)
  await until(()=>sender.state().timing?.network.state==='ready')
  await prepare();const connected=b.rates.length
  await sender.armTimedPlayback(mono()+400,4,true)
  assert.equal(b.rates.length,connected)
})

test('failed learned-rate application revokes re-arm without retry or a resurrected prior media stream', async t => {
  const b = new ContinuousAdaptiveFixture(),{sender,a}=await timedPair(t,b)
  const start=async()=>{
    await sender.prepareTimedPlayback(true);sender.beforeCall('Play',[]);a.playing=true
    await until(()=>(sender.state().receiver?.bufferedFrames??0)>=b.facts.prebufferFrames&&sender.state().timing?.output.state==='warming')
  }
  await start();await sender.armTimedPlayback(mono()+400,1,true)
  await until(()=>b.rates.length>=3&&sender.state().timing?.output.driftPpm!==null,5000)
  await sender.cancelTimedPlayback();await start();b.rateFails=true
  const before=b.rates.length
  await assert.rejects(sender.armTimedPlayback(mono()+400,2,true),/定时操作失败/)
  await until(()=>!b.opened)
  assert.equal(b.rates.length,before);assert.equal(a.playing,false);assert.equal(a.backend,'bridge-pcm')
  await delay(300);assert.equal(b.opened,false)
})

test('an automatic rate failure is latched without retry and leaves a selected but silent Bridge', async t => {
  const b = new ContinuousAdaptiveFixture(), { sender, a } = await timedPair(t, b)
  await sender.prepareTimedPlayback(true)
  sender.beforeCall('Play', []); a.playing = true
  await until(() => (sender.state().receiver?.bufferedFrames ?? 0) >= b.facts.prebufferFrames &&
    sender.state().timing?.output.state === 'warming')
  b.rateFails = true
  await sender.armTimedPlayback(mono()+200, 0, true)
  await until(() => sender.state().synchronization?.state === 'failed', 5000)
  assert.equal(sender.state().synchronization?.error, 'rate_request_failed')
  assert.equal(a.playing, false); assert.equal(sender.state().selected, true)
  await until(() => !b.opened)
  await delay(350)
  assert.equal(b.rates.length, 0); assert.equal(b.opened, false)
})
test('timed arm failure flushes media without fallback; unexpected source generations require a fresh preparation', async t => {
  const pair = await timedPair(t), { a, b, sender } = pair
  await feedTimed(pair); b.armFails = true
  await assert.rejects(sender.armTimedPlayback(mono() + 300), /定时操作失败/)
  await until(() => b.timed.state === 'disabled')
  assert.equal(a.playing, false); assert.equal(a.backend, 'bridge-pcm'); assert.equal(b.facts.consumedFrames, 0)
  b.armFails = false
  await feedTimed(pair); await sender.armTimedPlayback(mono() + 150)
  ++a.generation
  await until(() => !sender.state().connected)
  assert.equal(a.playing, false); assert.equal(sender.state().selected, true)
  assert.equal(a.backend, 'bridge-pcm')
})
test('an unarmed timed stream expires even while the peer supplies healthy idle responses and clock probes', async t => {
  const { sender, b } = await timedPair(t)
  await sender.prepareTimedPlayback()
  await until(() => !sender.state().connected, 4000)
  assert.equal(b.facts.consumedFrames, 0); assert.equal(b.opened, false)
  assert.equal(sender.state().selected, true)
})

test('revoked and duplicate timed controls cannot reopen a receiver after a newer flush', async t => {
  const native = new TimedNativeFixture(), receiver = new AudioBridgeRuntime(native.binding())
  const identity = createRemoteTlsIdentity()
  const grant = await receiver.startHost({ ...identity, name: 'Epoch fixture', backend: 'wasapi-exclusive', device: 'explicit-dac', sampleRate: 48000 })
  const socket = connect({ host: '127.0.0.1', port: grant.port, rejectUnauthorized: false })
  socket.on('error', () => {})
  t.after(async () => { socket.destroy(); await receiver.close() })
  await new Promise<void>(resolve => socket.once('secureConnect', resolve))
  let results = 0, pulls = 0
  readBridgePackets(socket, (_kind, data) => {
    const message = JSON.parse(data.toString())
    if (message.type === 'timed-result') results++
    if (message.type === 'pull') { pulls++; sendBridgeJson(socket, { type: 'idle', credit: message.credit, eof: true }) }
  })
  sendBridgeJson(socket, { type: 'hello', version: 1, token: grant.token, capabilities: ['clock-v1', 'timed-start-v1'] })
  await until(() => pulls > 0)
  sendBridgeJson(socket, { type: 'flush', epoch: 1 })
  sendBridgeJson(socket, { type: 'timed-prepare', epoch: 1, requestId: 1 })
  await until(() => results === 1)
  sendBridgeJson(socket, { type: 'flush', epoch: 2 })
  sendBridgeJson(socket, { type: 'timed-prepare', epoch: 1, requestId: 2 })
  sendBridgeJson(socket, { type: 'timed-arm', epoch: 1, requestId: 3 })
  await delay(40)
  assert.equal(native.prepareCount, 1); assert.equal(native.opened, false)
  sendBridgeJson(socket, { type: 'timed-prepare', epoch: 2, requestId: 4 })
  await until(() => results === 2)
  sendBridgeJson(socket, { type: 'timed-prepare', epoch: 2, requestId: 4 })
  await delay(40)
  assert.equal(native.prepareCount, 2); assert.equal(native.timed.state, 'prepared')
})

test('failed native start and Stop during a pending prepare both revoke timed intent without automatic replay', async t => {
  const pair = await timedPair(t), { a, b, sender } = pair
  await sender.prepareTimedPlayback()
  sender.beforeCall('Play', []); a.playing = true
  sender.callFailed('Play')
  await until(() => b.timed.state === 'disabled')
  assert.equal(a.playing, false); assert.equal(b.facts.consumedFrames, 0)
  const pending = sender.prepareTimedPlayback()
  const rejected = assert.rejects(pending, /取消/)
  sender.beforeCall('Stop', [])
  await rejected
  await delay(50) // Any late prepared acknowledgement is now from a revoked epoch.
  assert.equal(b.timed.state, 'disabled')
  assert.equal(a.playing, false); assert.equal(sender.state().connected, true)
})

test('a timed prepare timeout is not retried and its late acknowledgement cannot restore the consumed start intent', async t => {
  const identity = createRemoteTlsIdentity(), native = new NativeFixture(), runtime = new AudioBridgeRuntime(native.binding())
  const facts = { ...native.facts, timedStart: { supported: true, state: 'prepared', error: '', ended: false,
    targetAtMs: 0, mediaFrame: 0, deviceStartFrame: null, deviceStartAtMs: null, presentedMediaFrames: null } }
  const sockets = new Set<import('node:tls').TLSSocket>()
  let prepares = 0, flushes = 0, late: (() => void) | undefined
  const server = createServer({ key: identity.key, cert: identity.cert }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    readBridgePackets(socket, (_kind, data) => {
      const message = JSON.parse(data.toString())
      if (message.type === 'hello') sendBridgeJson(socket, { type: 'ready', version: 1, name: 'Withheld ACK', facts,
        capabilities: ['clock-v1', 'timed-start-v1'] })
      if (message.type === 'flush') flushes++
      if (message.type === 'timed-prepare') {
        prepares++
        late = () => sendBridgeJson(socket, { type: 'timed-result', requestId: message.requestId,
          epoch: message.epoch, ok: true, facts: { ...facts, started: true } })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await runtime.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  await runtime.connectPeer({ host: '127.0.0.1', port: (server.address() as AddressInfo).port,
    token: 'a'.repeat(48), fingerprint: identity.fingerprint })
  await assert.rejects(runtime.prepareTimedPlayback(), /结果未知/)
  await until(() => flushes === 2)
  assert.equal(prepares, 1)
  late!()
  await delay(25)
  runtime.beforeCall('Play', [])
  await until(() => flushes === 3) // An ordinary explicit Play, not the revoked timed lane.
  assert.equal(prepares, 1); assert.equal(native.playing, false)
  assert.equal(runtime.state().connected, true); assert.equal(runtime.state().selected, true)
})
