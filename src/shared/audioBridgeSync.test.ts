import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeTimelineController, type BridgePresentationObservation } from './audioBridgeSync.ts'
import { BridgeClockMonitor, type BridgeClockExchange } from './audioBridgeClock.ts'
import type { BridgeOutputClock, BridgeReceiverFacts } from './audioBridge.ts'

const plan = { sampleRate: 48000, startAtCoreMs: 10000, streamGeneration: 1, clockEpoch: 3, mediaFrame: 900 }
const observation = (patch: Partial<BridgePresentationObservation> = {}): BridgePresentationObservation => ({
  ...plan, sampledAtCoreMs: 10250, sourceFrames: 12000, uncertaintyMs: .2, deviceDriftPpm: 200,
  deviceSampledAtMs: (patch.sampledAtCoreMs ?? 10250)+40000,
  devicePositionFrames: ((patch.sampledAtCoreMs ?? 10250)-10000)*48+480,
  effectivePpm: 0, ended: false, completed: false, ...patch
})
export function syncExchange(time: number, hardwareFrames: number, hostPpm: number, i: number): BridgeClockExchange {
  const host = (t: number) => t*(1+hostPpm*1e-6)
  const up = .2+(i%7)*.01+(i%17 === 0 ? 8 : 0), down = .2+(i%5)*.015+(i%11 === 0 ? 12 : 0)
  const clock: BridgeOutputClock = { supported: true, valid: true, running: true, source: 'wasapi-audio-clock',
    streamGeneration: 1, epoch: 3, sampleRate: 48000, positionFrames: hardwareFrames,
    sampledAtMs: host(time)+40000, readAtMs: host(time)+40000, callbackRequestedFrames: Math.ceil(hardwareFrames+480) }
  return { sentAtMs: time-.1-up, receivedAtMs: time+.1+down, remoteReceiveMs: host(time-.1)+5000,
    remoteSendMs: host(time+.1)+5000, nativeReadBeforeMs: host(time-.01)+5000,
    nativeReadAfterMs: host(time+.01)+5000, clock }
}
export function syncFacts(clock: BridgeOutputClock, source: number, ppm: number): BridgeReceiverFacts {
  return { sampleRate: 48000, channels: 2, bufferedFrames: 4800, capacityFrames: 12000, prebufferFrames: 1920,
    consumedFrames: Math.ceil(source), underruns: 0, started: true, failed: false, backend: 'controlled-dac', deviceName: 'fixture',
    actualSampleRate: 48000, actualBitDepth: 32, actualChannels: 2, actualOutputFormat: 'float32', exclusive: true,
    clock, adaptiveSupported: true, adaptive: { requestedPpm: ppm, effectivePpm: ppm, inputFrames: Math.ceil(source+4800),
      pendingInputFrames: 134, resamplerDelayFrames: 134, sourceConsumedFrames: source, inputCreditFrames: 7200 },
    timedStart: { supported: true, state: 'running', error: '', ended: false, targetAtMs: 1, mediaFrame: 900,
      deviceStartFrame: 480, deviceStartAtMs: 1, presentedMediaFrames: source } }
}
test('media coordinates are paired with their own device clock, including native-read uncertainty', () => {
  const monitor = new BridgeClockMonitor()
  let sample = syncExchange(10000, 48000, 0, 1)
  for (let n = 1; n <= 4; n++) { sample = syncExchange(10000+n*250, 48000+n*12000, 0, n); monitor.observe(sample) }
  const facts = syncFacts(sample.clock!, 25000.75, 199.7)
  const mapped = monitor.presentation(facts, sample.receivedAtMs)!
  assert.equal(mapped.sourceFrames, 25000.75)
  assert.ok(Math.abs(mapped.sampledAtCoreMs-11000) < .05)
  assert.ok(mapped.uncertaintyMs > .2 && mapped.uncertaintyMs < .3)
  assert.equal(monitor.presentation({ ...facts, clock: { ...facts.clock!, positionFrames: 96001 } }, sample.receivedAtMs), null)
  assert.equal(monitor.presentation({ ...facts, clock: { ...facts.clock!, readAtMs: facts.clock!.readAtMs+1 } }, sample.receivedAtMs), null)
  assert.equal(monitor.presentation(facts, sample.receivedAtMs+1500), null)
  assert.equal(monitor.presentation({ ...facts, timedStart: { ...facts.timedStart!, presentedMediaFrames: null } }, sample.receivedAtMs), null)
})

test('30-minute timeline feedback corrects independent device/host clocks, queued actuation and asymmetric network jitter', t => {
  for (const devicePpm of [-200, -100, 100, 200]) {
    const hostPpm = devicePpm < 0 ? 80 : -80, base = 1e8
    const monitor = new BridgeClockMonitor()
    const controller = new BridgeTimelineController({ ...plan, startAtCoreMs: base+1000 })
    for (let i = 0; i < 4; i++) monitor.observe(syncExchange(base+i*250, (1000+i*250)*48*(1+devicePpm*1e-6), hostPpm, i))
    let source = 0, hardware = 96000*(1+devicePpm*1e-6), ppm = 0
    const queued = [0, 0], errors: number[] = [], all: number[] = []
    for (let i = 1; i <= 7200; i++) {
      const time = base+1000+i*250
      const currentDrift = i < 3600 ? devicePpm : -devicePpm // Deliberate rate step at 15 minutes.
      const outputFrames = 12000*(1+currentDrift*1e-6)
      const activePpm = queued.shift()!
      queued.push(ppm)
      // Quantized SRC ratio and 500 ms queued actuation. The native fixture
      // separately validates this loop with real SWR and committed PCM mapping.
      source += outputFrames/(1+Math.round(activePpm)*1e-6); hardware += outputFrames
      const sample = syncExchange(time, hardware, hostPpm, i)
      monitor.observe(sample)
      const actualMs = source/48-i*250
      all.push(Math.abs(actualMs))
      if (i > 240 && (i < 3600 || i > 4080)) errors.push(Math.abs(actualMs))
      const mapped = monitor.presentation(syncFacts(sample.clock!, source, ppm), sample.receivedAtMs)!
      assert.ok(mapped)
      const decision = controller.update(mapped, sample.receivedAtMs)
      assert.notEqual(decision.kind, 'failed', JSON.stringify(controller.view()))
      if (decision.kind === 'rate') { assert.ok(Math.abs(decision.ppm) <= 1000); ppm = decision.ppm }
    }
    errors.sort((a,b) => a-b)
    const maximum = Math.max(...errors), p99 = errors[Math.floor(errors.length*.99)]
    t.diagnostic(`${devicePpm} ppm DAC / ${hostPpm} ppm host: steady max=${maximum.toFixed(4)} ms, p99=${p99.toFixed(4)} ms, transient max=${Math.max(...all).toFixed(4)} ms`)
    assert.ok(maximum < 1, `physical phase ${maximum} ms`)
    assert.ok(Math.max(...all) < 5)
    assert.equal(controller.view().state, 'correcting')
  }
})

test('stale clocks, epoch/position discontinuities and lost phase require a fresh start; EOF drains without new correction', () => {
  for (const patch of [{ streamGeneration: 2 }, { clockEpoch: 4 }, { mediaFrame: 901 }, { sampleRate: 44100 },
    { sourceFrames: 20000, sampledAtCoreMs: 10500 }, { sampledAtCoreMs: 10249 },
    { sourceFrames: 11999, sampledAtCoreMs: 10500 }, { devicePositionFrames: 1, sampledAtCoreMs: 10500 }]) {
    const controller = new BridgeTimelineController(plan)
    controller.update(observation(), 10251)
    assert.equal(controller.update(observation(patch), patch.sampledAtCoreMs ? 10251 : 10501).kind, 'failed')
    assert.equal(controller.update(observation({ sampledAtCoreMs: 10500, sourceFrames: 24000 }), 10501).kind, 'failed')
  }
  const c = new BridgeTimelineController(plan)
  assert.equal(c.watch(10999).kind, 'wait')
  assert.equal(c.watch(11001).kind, 'failed')
  const ended = new BridgeTimelineController(plan)
  ended.update(observation(), 10251)
  assert.equal(ended.update(observation(), 10260).kind, 'wait') // Exact duplicate is not a new sample.
  assert.equal(ended.view().samples, 1)
  assert.equal(ended.update(observation({ ended: true, sampledAtCoreMs: 10500, sourceFrames: 20000 }), 10501).kind, 'wait')
  assert.equal(ended.view().state, 'draining')
  ended.update(observation({ ended: true, completed: true, sampledAtCoreMs: 10750, sourceFrames: 20000 }), 10751)
  assert.equal(ended.view().state, 'completed')
  assert.equal(ended.watch(50000).kind, 'wait')
})

test('cached native samples do not become new measurements when NTP offset changes; pending rates do not block observation', () => {
  const controller = new BridgeTimelineController(plan)
  controller.update(observation(), 10251)
  controller.update(observation({ sampledAtCoreMs: 10249.9, deviceSampledAtMs: 50250, devicePositionFrames: 12480 }), 10280)
  assert.equal(controller.view().samples, 1)
  assert.equal(controller.view().state, 'correcting')
  const requested = controller.view().requestedPpm
  for (let i = 2; i <= 5; i++) {
    assert.equal(controller.update(observation({ sampledAtCoreMs: 10000+i*250, sourceFrames: i*12000 }), 10001+i*250, false).kind, 'wait')
    assert.equal(controller.view().requestedPpm, requested)
    assert.equal(controller.watch(10002+i*250).kind, 'wait')
  }
  assert.equal(controller.view().samples, 5)
  assert.equal(controller.watch(12251).kind, 'failed')
  const tail = new BridgeTimelineController(plan)
  tail.update(observation(), 10251)
  tail.update(observation({ ended: true, completed: true }), 10252)
  assert.equal(tail.view().state, 'completed') // EOF may arrive just after the final frame was already presented.
})

test('host/Core rate fitting maps both current presentation and future arm without redefining host-relative drift', () => {
  for (const hostPpm of [-80,80]) {
    const monitor = new BridgeClockMonitor(), base = 1e8, devicePpm = hostPpm < 0 ? 200 : -200
    let sample!: BridgeClockExchange
    for (let i=0;i<48;i++) {
      const at = base+i*250
      sample = syncExchange(at, 96000+i*12000*(1+devicePpm*1e-6), hostPpm, i)
      monitor.observe(sample)
    }
    const at = base+47*250, timing = monitor.view(sample.receivedAtMs)
    const expectedHostRelative = ((1+devicePpm*1e-6)/(1+hostPpm*1e-6)-1)*1e6
    assert.ok(Math.abs(timing.output.driftPpm!-expectedHostRelative)<.01)
    const mapped = monitor.presentation(syncFacts(sample.clock!, 12345, 0), sample.receivedAtMs)!
    assert.ok(Math.abs(mapped.sampledAtCoreMs-at)<.05)
    assert.ok(Math.abs(mapped.deviceCoreDriftPpm!-devicePpm)<10)
    const future = at+1900 // Future mapping must fit the current window, not age it by 1.9 seconds.
    assert.ok(Math.abs(monitor.receiverTime(future, sample.receivedAtMs)!-(future*(1+hostPpm*1e-6)+5000))<.05)
  }
})

test('re-arm retains an acknowledged rate and learned bias, resets media phase, and never seeds a failed loop', () => {
  const previous = new BridgeTimelineController(plan)
  previous.update(observation({effectivePpm:120,deviceDriftPpm:280,deviceCoreDriftPpm:200}),10251)
  const seed = previous.seed()!
  assert.equal(seed.ratePpm,120); assert.equal(seed.feedPpm,200); assert.equal(seed.integralPpm,0)
  const next = new BridgeTimelineController({...plan,startAtCoreMs:20000,streamGeneration:2},seed.ratePpm,seed)
  const decision = next.update(observation({streamGeneration:2,sampledAtCoreMs:20250,sourceFrames:12000,
    deviceDriftPpm:null,deviceCoreDriftPpm:null,effectivePpm:120}),20251)
  assert.deepEqual(decision,{kind:'rate',ppm:130})
  assert.equal(next.view().phaseErrorMs,0); assert.equal(next.view().samples,1)
  previous.update(observation({ended:true,completed:true,sampledAtCoreMs:10500,sourceFrames:24000,effectivePpm:120}),10501)
  assert.equal(previous.seed()?.ratePpm,120)
  next.fail('rate_request_failed'); assert.equal(next.seed(),null)
})
