import type { BridgeOutputClock, BridgeReceiverFacts } from './audioBridge.ts'
import type { BridgePresentationObservation } from './audioBridgeSync.ts'
import { readBridgeOutputClock } from './audioBridge.ts'

export interface BridgeClockExchange {
  sentAtMs: number
  receivedAtMs: number
  remoteReceiveMs: number
  remoteSendMs: number
  nativeReadBeforeMs: number
  nativeReadAfterMs: number
  clock: BridgeOutputClock | null
}
export interface BridgeClockStatus {
  network: { state: 'warming' | 'ready' | 'stale'; samples: number;
    offsetMs: number | null; roundTripMs: number | null; uncertaintyMs: number | null }
  output: { state: 'unsupported' | 'stopped' | 'unreliable' | 'warming' | 'ready' | 'stale' | 'discontinuity';
    source: string; streamGeneration: number; epoch: number; sampleRate: number;
    positionFrames: number | null; sampledAtCoreMs: number | null; ageMs: number | null;
    callbackRequestedFrames: number; driftPpm: number | null; windowMs: number; samples: number;
    residualFrames: number | null }
}
type NetworkSample = { at: number; coreTime: number; offset: number; rtt: number }
type DeviceSample = { time: number; frames: number }
const finite = (n: number) => Number.isFinite(n) && n >= 0

export function readBridgeClockExchange(value: Record<string, unknown>): BridgeClockExchange {
  const result: Record<string, unknown> = { clock: readBridgeOutputClock(value.clock) }
  for (const key of ['sentAtMs', 'receivedAtMs', 'remoteReceiveMs', 'remoteSendMs', 'nativeReadBeforeMs', 'nativeReadAfterMs']) {
    if (typeof value[key] !== 'number' || !finite(value[key])) throw new Error('Invalid Bridge clock timestamp')
    result[key] = value[key]
  }
  return result as unknown as BridgeClockExchange
}

/** Read-only observations. Network offset uses four timestamps, not ping/2;
 * output drift is fitted against the receiver's native monotonic timestamps,
 * never against packet arrival times or the count consumed by render callbacks. */
export class BridgeClockMonitor {
  private network: NetworkSample[] = []
  private device: DeviceSample[] = []
  private latest: BridgeClockExchange | null = null
  private discontinuity = false

  resetStream(): void { this.device = []; this.latest = null; this.discontinuity = false }

  private networkModel(nowMs: number) {
    const samples = this.network.filter(s => nowMs-s.at <= 5000)
    const best = samples.reduce<NetworkSample | undefined>((a,b) => !a || b.rtt <= a.rtt ? b : a, undefined)
    // Fit only the low-RTT envelope: queued packets measure queue asymmetry,
    // not host oscillator rate. Offset is anchored to the best four-timestamp
    // exchange; the slope removes drift while that anchor remains in use.
    const near = best ? samples.filter(s => s.rtt <= best.rtt+.1) : []
    const ready = near.length >= 8 && near.at(-1)!.coreTime-near[0].coreTime >= 2000
    let rate = 0
    if (ready) {
      const origin = near[0].coreTime
      const meanT = near.reduce((v,s) => v+s.coreTime-origin,0)/near.length
      const meanO = near.reduce((v,s) => v+s.offset,0)/near.length
      let covariance = 0, variance = 0
      for (const sample of near) {
        const dt = sample.coreTime-origin-meanT
        covariance += dt*(sample.offset-meanO); variance += dt*dt
      }
      rate = covariance/variance
    }
    return { samples, best, rate, ready }
  }
  receiverTime(coreMs: number, nowMs: number): number | null {
    const { best, rate } = this.networkModel(nowMs)
    return best ? coreMs+best.offset+rate*(coreMs-best.coreTime) : null
  }

  /** Pair source position with exactly the IAudioClock snapshot that produced
   * it. A later PCM-credit fact must never be paired with an earlier pong. */
  presentation(facts: BridgeReceiverFacts, nowMs: number): BridgePresentationObservation | null {
    const sample = this.latest, clock = sample?.clock, native = facts.clock, media = facts.timedStart
    const timing = this.view(nowMs)
    if (!sample || !clock?.valid || !native?.valid || !facts.adaptive || !media ||
        !['running', 'completed'].includes(media.state) || media.presentedMediaFrames === null ||
        native.streamGeneration !== clock.streamGeneration || native.epoch !== clock.epoch ||
        native.sampledAtMs !== clock.sampledAtMs || native.positionFrames !== clock.positionFrames ||
        native.readAtMs !== clock.readAtMs || native.sampleRate !== clock.sampleRate ||
        timing.network.state !== 'ready' || !['warming', 'ready'].includes(timing.output.state) ||
        timing.output.sampledAtCoreMs === null || timing.network.uncertaintyMs === null) return null
    const network = this.networkModel(nowMs)
    return { sampledAtCoreMs: timing.output.sampledAtCoreMs, deviceSampledAtMs: clock.sampledAtMs,
      devicePositionFrames: clock.positionFrames, sourceFrames: media.presentedMediaFrames,
      uncertaintyMs: timing.network.uncertaintyMs+(sample.nativeReadAfterMs-sample.nativeReadBeforeMs)/2,
      streamGeneration: clock.streamGeneration, clockEpoch: clock.epoch, sampleRate: clock.sampleRate,
      mediaFrame: media.mediaFrame, deviceDriftPpm: timing.output.driftPpm,
      deviceCoreDriftPpm: network.ready && timing.output.driftPpm !== null
        ? ((1+timing.output.driftPpm*1e-6)*(1+network.rate)-1)*1e6 : null,
      effectivePpm: facts.adaptive.effectivePpm, ended: media.ended, completed: media.state === 'completed' }
  }

  observe(sample: BridgeClockExchange): void {
    const { sentAtMs: t1, remoteReceiveMs: t2, remoteSendMs: t3, receivedAtMs: t4,
      nativeReadBeforeMs: before, nativeReadAfterMs: after, clock } = sample
    if (![t1, t2, t3, t4, before, after].every(finite) || t4 < t1 || t3 < t2 ||
        before < t2 || after < before || after > t3 || t4 - t1 > 3000 ||
        t4 - t1 - (t3 - t2) < -0.01) throw new Error('Invalid Bridge clock exchange')
    const rtt = Math.max(0, t4 - t1 - (t3 - t2))
    this.network.push({ at: t4, coreTime: (t1+t4)/2, offset: ((t2 - t1) + (t3 - t4)) / 2, rtt })
    this.network = this.network.filter(s => t4 - s.at <= 5000).slice(-32)
    const previous = this.latest?.clock
    if (!clock || !previous || clock.streamGeneration !== previous.streamGeneration || clock.epoch !== previous.epoch || clock.sampleRate !== previous.sampleRate) {
      this.device = []; this.discontinuity = false
    }
    this.latest = sample
    if (!clock?.valid || !clock.running || clock.readAtMs - clock.sampledAtMs > 1000) return
    const last = this.device.at(-1)
    if (last && clock.sampledAtMs === last.time && clock.positionFrames === last.frames) return
    if (last) {
      const elapsed = clock.sampledAtMs - last.time, advanced = clock.positionFrames - last.frames
      if (elapsed <= 0 || advanced < 0 || (elapsed <= 5000 && Math.abs(advanced / elapsed * 1000 / clock.sampleRate - 1) > 0.02)) {
        this.device = []; this.discontinuity = true
        return
      }
      if (elapsed > 5000) this.device = []
    }
    if (this.discontinuity) return // Explicit stream/clock epoch change is required.
    this.device.push({ time: clock.sampledAtMs, frames: clock.positionFrames })
    this.device = this.device.filter(s => clock.sampledAtMs - s.time <= 60000).slice(-512)
  }

  view(nowMs: number): BridgeClockStatus {
    const { samples: network, best, rate } = this.networkModel(nowMs)
    const lastNetwork = network.at(-1)
    const networkState = !lastNetwork || nowMs - lastNetwork.at > 1000 ? 'stale' : network.length >= 3 ? 'ready' : 'warming'
    const observation = this.latest, clock = observation?.clock
    // The native clock and Node monotonic clock need not share an origin.
    // Bracket the native read to map them, then remove the receiver/Core offset.
    const sampledAtCoreMs = clock?.valid && observation && best ? best.coreTime+
      (clock.sampledAtMs-(clock.readAtMs-(observation.nativeReadBeforeMs+observation.nativeReadAfterMs)/2)-best.coreTime-best.offset)/(1+rate) : null
    const age = sampledAtCoreMs === null ? null : Math.max(0, nowMs - sampledAtCoreMs)
    const samples = this.device
    const windowMs = samples.length > 1 ? samples.at(-1)!.time - samples[0].time : 0
    let driftPpm: number | null = null, residualFrames: number | null = null
    if (clock && windowMs >= 2000 && samples.length >= 8) {
      // Center the fit to avoid losing precision on a long-running host's uptime.
      const origin = samples[0], n = samples.length
      const meanT = samples.reduce((sum, s) => sum + s.time - origin.time, 0) / n
      const meanF = samples.reduce((sum, s) => sum + s.frames - origin.frames, 0) / n
      let covariance = 0, variance = 0
      for (const s of samples) {
        const t = s.time - origin.time - meanT, f = s.frames - origin.frames - meanF
        covariance += t * f; variance += t * t
      }
      const slope = covariance / variance
      driftPpm = (slope * 1000 / clock.sampleRate - 1) * 1e6
      residualFrames = Math.sqrt(samples.reduce((sum, s) => {
        const error = s.frames - origin.frames - meanF - slope * (s.time - origin.time - meanT)
        return sum + error * error
      }, 0) / n)
    }
    const state = !clock?.supported ? 'unsupported' : !clock.running ? 'stopped' : this.discontinuity ? 'discontinuity'
      : !clock.valid ? 'unreliable' : age! > 1000 || networkState === 'stale' ? 'stale' : driftPpm === null ? 'warming' : 'ready'
    return {
      network: { state: networkState, samples: network.length, offsetMs: best ? best.offset+rate*(nowMs-best.coreTime) : null,
        roundTripMs: best?.rtt ?? null, uncertaintyMs: best ? best.rtt / 2 : null },
      output: { state, source: clock?.source ?? 'unsupported', streamGeneration: clock?.streamGeneration ?? 0,
        epoch: clock?.epoch ?? 0, sampleRate: clock?.sampleRate ?? 0, positionFrames: clock?.valid ? clock.positionFrames : null,
        sampledAtCoreMs,
        ageMs: age, callbackRequestedFrames: clock?.callbackRequestedFrames ?? 0,
        driftPpm: state === 'ready' ? driftPpm : null, windowMs, samples: samples.length,
        residualFrames: state === 'ready' ? residualFrames : null }
    }
  }
}
