import '../../adapters-node/index.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRemoteTlsIdentity } from '../../adapters-node/remoteTlsIdentity.ts'
import { AudioBridgeRuntime } from './bridgeRuntime.ts'
import type { NativeAudioBinding } from '../../core/audio/audioEngineTypes.ts'
import { bridgeInvitation, parseBridgeInvitation, type BridgeReceiverFacts } from '../../shared/audioBridge.ts'
import { validRemoteDspEdit, projectRemoteDsp } from '../../shared/remoteDsp.ts'

class NativeFixture {
  backend = 'wasapi'; device = 'explicit-dac'; playing = false; generation = 0
  value = .25; stopped = 0; closed = 0; received: number[] = []; opens: string[] = []
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
    this.opens.push(`${backend}/${device}`)
    this.facts = { ...this.facts, bufferedFrames: 0, consumedFrames: 0, started: false, failed: false }
  }
  CloseBridgeReceiver = () => { this.facts.bufferedFrames = 0; this.facts.started = false; ++this.closed }
  WriteBridgePcm = (data: Buffer) => {
    assert.ok(data.length / 8 + this.facts.bufferedFrames <= this.facts.capacityFrames)
    this.facts.bufferedFrames += data.length / 8
    this.received.push(data.readFloatLE(0))
    if (this.facts.bufferedFrames >= this.facts.prebufferFrames) this.facts.started = true
  }
  StartBridgeReceiver = () => { this.facts.started = true }
  GetBridgeReceiverInfo = () => JSON.stringify(this.facts)
  consume() {
    if (!this.facts.started) return
    const count = Math.min(480, this.facts.bufferedFrames)
    this.facts.bufferedFrames -= count; this.facts.consumedFrames += count
  }
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2500
  while (!predicate() && Date.now() < end) await delay(10)
  assert.ok(predicate(), 'condition was not reached')
}
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
  await sender.connectPeer({ host: '127.0.0.1', port: grant.port, token: grant.token, fingerprint: identity.fingerprint })
  a.playing = true
  await until(() => b.facts.consumedFrames > 4800)
  assert.ok(b.facts.bufferedFrames <= 8192)
})
