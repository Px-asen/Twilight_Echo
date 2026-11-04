import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeClockMonitor, readBridgeClockExchange, type BridgeClockExchange } from './audioBridgeClock.ts'
import { readBridgeOutputClock, readBridgeReceiverFacts, readBridgeTimedStart, type BridgeOutputClock } from './audioBridge.ts'

const clock = (patch: Partial<BridgeOutputClock> = {}): BridgeOutputClock => ({
  supported: true, valid: true, running: true, source: 'wasapi-audio-clock',
  streamGeneration: 1, epoch: 1, positionFrames: 48000, sampledAtMs: 1000, readAtMs: 1002,
  sampleRate: 48000, callbackRequestedFrames: 49000, ...patch
})
// Independent clock origins: Core 10s; receiver Node Core+5s; native Core+40s.
function exchange(time = 10000, ppm = 0, patch: Partial<BridgeClockExchange> = {}): BridgeClockExchange {
  return { sentAtMs: time, receivedAtMs: time + 9, remoteReceiveMs: time + 5003,
    remoteSendMs: time + 5006, nativeReadBeforeMs: time + 5004, nativeReadAfterMs: time + 5006,
    clock: clock({ sampledAtMs: time + 40003, readAtMs: time + 40005,
      positionFrames: (time + 3) * 48 * (1 + ppm / 1e6) }), ...patch }
}

test('optional native clocks preserve old facts; malformed clocks cannot masquerade as supported positions', () => {
  const facts = { sampleRate: 48000, channels: 2, bufferedFrames: 0, capacityFrames: 12000, prebufferFrames: 1920,
    consumedFrames: 64, underruns: 0, started: true, failed: false, backend: 'wasapi-exclusive', deviceName: 'DAC',
    actualSampleRate: 48000, actualBitDepth: 24, actualChannels: 2, actualOutputFormat: 'int24', exclusive: true }
  assert.equal(readBridgeReceiverFacts(facts).clock, null)
  const decoded = readBridgeReceiverFacts({ ...facts, clock: clock({ positionFrames: 32, callbackRequestedFrames: 128 }) })
  assert.equal(decoded.consumedFrames, 64)
  assert.equal(decoded.clock!.positionFrames, 32)
  assert.equal(decoded.clock!.callbackRequestedFrames, 128)
  for (const patch of [{ positionFrames: NaN }, { sampledAtMs: 1003 }, { epoch: -1 }, { valid: 'true' },
    { supported: false }, { running: false }, { source: 'callback-counter' }, { sampleRate: 0 }])
    assert.throws(() => readBridgeOutputClock({ ...clock(), ...patch }), /clock/)
  assert.throws(() => readBridgeReceiverFacts({ ...facts, clock: clock({ sampleRate: 44100 }) }), /format/)
  assert.throws(() => readBridgeClockExchange({ ...exchange(), remoteSendMs: '10' }), /timestamp/)
})

test('timed metadata distinguishes an absent presentation mapping from zero presented media', () => {
  assert.equal(readBridgeTimedStart(undefined), null)
  const prepared = { supported: true, state: 'prepared', error: '', ended: false, targetAtMs: 0, mediaFrame: 0,
    deviceStartFrame: null, deviceStartAtMs: null, presentedMediaFrames: null }
  assert.deepEqual(readBridgeTimedStart(prepared), prepared)
  const running = { ...prepared, state: 'running', targetAtMs: 1000, mediaFrame: 96000,
    deviceStartFrame: 1200, deviceStartAtMs: 1000, presentedMediaFrames: 0 }
  assert.equal(readBridgeTimedStart(running)!.presentedMediaFrames, 0)
  for (const patch of [{ deviceStartFrame: -1 }, { deviceStartAtMs: null }, { mediaFrame: .5 },
    { targetAtMs: NaN }, { ended: 'true' }, { state: 'synced' }, { error: 'anything' }])
    assert.throws(() => readBridgeTimedStart({ ...running, ...patch }), /timed/)
})

test('four timestamps remove remote processing; native timestamps map into Core time', () => {
  const monitor = new BridgeClockMonitor()
  for (let i = 0; i < 3; i++) monitor.observe(exchange(10000 + i * 250))
  const status = monitor.view(10509)
  assert.equal(status.network.state, 'ready')
  assert.equal(status.network.offsetMs, 5000)
  assert.equal(status.network.roundTripMs, 6) // 9ms minus 3ms in receiver.
  assert.equal(status.network.uncertaintyMs, 3)
  assert.equal(status.output.sampledAtCoreMs, 10503)
  assert.equal(status.output.ageMs, 6)
  assert.equal(status.output.state, 'warming')
  assert.equal(status.output.driftPpm, null)
  // A slower, asymmetric exchange must not replace the minimum-delay estimate.
  monitor.observe(exchange(10750, 0, { receivedAtMs: 10859 }))
  assert.equal(monitor.view(10859).network.offsetMs, 5000)
  assert.throws(() => monitor.observe(exchange(11000, 0, { receivedAtMs: 11001 })), /exchange/)
})

test('30-minute synthetic ±100/200 ppm clocks remain measurable through network jitter and outliers', () => {
  for (const ppm of [-200, -100, 100, 200]) {
    const monitor = new BridgeClockMonitor()
    let last = 0
    for (let i = 0; i <= 7200; i++) {
      const time = 1e9 + i * 250 // Large uptime must not spoil the centered fit.
      const jitter = i % 11 === 0 ? 350 : i % 7
      const sample = exchange(time, ppm, { receivedAtMs: time + 9 + jitter })
      sample.clock!.positionFrames = Math.round(sample.clock!.positionFrames)
      monitor.observe(sample); last = sample.receivedAtMs
    }
    const status = monitor.view(last)
    assert.equal(status.output.state, 'ready')
    assert.ok(Math.abs(status.output.driftPpm! - ppm) < .1, `${ppm}: ${status.output.driftPpm}`)
    assert.ok(status.output.residualFrames! < .5)
    assert.ok(status.output.samples <= 241)
    assert.equal(status.output.windowMs, 60000)
    assert.ok(status.network.samples <= 21)
    assert.equal(status.network.offsetMs, 5000)
    assert.equal(monitor.view(last + 1500).output.state, 'stale')
    assert.equal(monitor.view(last + 1500).output.driftPpm, null)
  }
})

test('reset epochs, discontinuities, repeated snapshots and unsupported/stopped outputs are distinguished', () => {
  const monitor = new BridgeClockMonitor()
  for (let i = 0; i < 12; i++) monitor.observe(exchange(10000 + i * 250))
  assert.equal(monitor.view(12759).output.state, 'ready')
  const repeated = exchange(13000); repeated.clock = exchange(12750).clock
  monitor.observe(repeated)
  assert.equal(monitor.view(13009).output.samples, 12)
  const reversed = exchange(13250); reversed.clock!.positionFrames = 1
  monitor.observe(reversed)
  assert.equal(monitor.view(13259).output.state, 'discontinuity')
  monitor.observe(exchange(13500))
  assert.equal(monitor.view(13509).output.state, 'discontinuity')
  const reopened = exchange(13750); reopened.clock!.streamGeneration++
  monitor.observe(reopened)
  assert.equal(monitor.view(13759).output.state, 'warming')
  assert.equal(monitor.view(13759).output.samples, 1)
  const uncertain = exchange(14000); uncertain.clock!.valid = false
  monitor.observe(uncertain)
  assert.equal(monitor.view(14009).output.state, 'unreliable')
  const stopped = exchange(14250); stopped.clock = clock({ valid: false, running: false })
  monitor.observe(stopped)
  assert.equal(monitor.view(14259).output.state, 'stopped')
  monitor.resetStream()
  assert.equal(monitor.view(14259).output.samples, 0)
  monitor.observe(exchange(14500, 0, { clock: null }))
  assert.equal(monitor.view(14509).output.state, 'unsupported')
})
