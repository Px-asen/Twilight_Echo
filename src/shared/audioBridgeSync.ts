/** A single output following the Core's media timeline. Group queue/transport
 * ownership is deliberately above this actuator, not another source of Play. */
export interface BridgeSyncPlan {
  sampleRate: number
  startAtCoreMs: number
  streamGeneration: number
  clockEpoch: number
  mediaFrame: number
}
export interface BridgePresentationObservation {
  sampledAtCoreMs: number
  deviceSampledAtMs: number
  devicePositionFrames: number
  sourceFrames: number
  uncertaintyMs: number
  streamGeneration: number
  clockEpoch: number
  mediaFrame: number
  sampleRate: number
  deviceDriftPpm: number | null
  /** Device rate relative to Core, including the measured Bridge host/Core rate. */
  deviceCoreDriftPpm?: number | null
  effectivePpm: number
  ended: boolean
  completed: boolean
}
export interface BridgeSyncStatus {
  state: 'waiting' | 'correcting' | 'draining' | 'completed' | 'failed'
  error: string | null
  phaseErrorMs: number | null
  uncertaintyMs: number | null
  requestedPpm: number
  effectivePpm: number | null
  sampledAtCoreMs: number | null
  samples: number
}
export type BridgeSyncDecision = { kind: 'wait' } | { kind: 'rate'; ppm: number } | { kind: 'failed'; reason: string }
/** A same-peer rate estimate, not a media/clock epoch or an old phase error. */
export interface BridgeSyncSeed { ratePpm: number; feedPpm: number; integralPpm: number }
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export class BridgeTimelineController {
  private status: BridgeSyncStatus = { state: 'waiting', error: null, phaseErrorMs: null, uncertaintyMs: null,
    requestedPpm: 0, effectivePpm: null, sampledAtCoreMs: null, samples: 0 }
  private filteredErrorMs = 0
  private integralPpm = 0
  private previousSource = 0
  private previousDeviceTime: number | null = null
  private previousDevicePosition = 0
  private lastFeedPpm: number | null = null
  private readonly plan: BridgeSyncPlan
  constructor(plan: BridgeSyncPlan, initialPpm = 0, seed?: BridgeSyncSeed) {
    this.plan = plan; this.status.requestedPpm = initialPpm
    if (seed) {
      this.lastFeedPpm = seed.feedPpm
      // Retain the learned residual rate bias, not the old media phase or
      // an in-flight requested rate that the receiver has not acknowledged.
      this.integralPpm = seed.integralPpm
    }
  }
  view(): BridgeSyncStatus { return { ...this.status } }
  seed(): BridgeSyncSeed | null {
    return ['correcting', 'draining', 'completed'].includes(this.status.state) && this.status.effectivePpm !== null && this.lastFeedPpm !== null
      ? { ratePpm: this.status.effectivePpm, feedPpm: this.lastFeedPpm, integralPpm: this.integralPpm } : null
  }
  fail(reason: string): BridgeSyncDecision {
    this.status.state = 'failed'; this.status.error = reason
    return { kind: 'failed', reason }
  }
  watch(nowMs: number): BridgeSyncDecision {
    if (this.status.state === 'failed') return { kind: 'failed', reason: this.status.error! }
    if (this.status.state !== 'completed' && nowMs - (this.status.sampledAtCoreMs ?? this.plan.startAtCoreMs) > 1000)
      return this.fail('presentation_clock_stale')
    return { kind: 'wait' }
  }
  update(observation: BridgePresentationObservation, nowMs: number, canCommand = true): BridgeSyncDecision {
    const p = this.plan, s = this.status, o = observation
    if (s.state === 'failed' || s.state === 'completed') return this.watch(nowMs)
    if (o.streamGeneration !== p.streamGeneration || o.clockEpoch !== p.clockEpoch ||
        o.mediaFrame !== p.mediaFrame || o.sampleRate !== p.sampleRate) return this.fail('presentation_stream_changed')
    if (nowMs-o.sampledAtCoreMs > 1000) return this.fail('presentation_clock_stale')
    if (o.sampledAtCoreMs < p.startAtCoreMs) return { kind: 'wait' }
    // Native snapshot identity survives changes to the estimated network offset.
    // Re-mapping one cached IAudioClock sample is not new progress in the plant.
    if (this.previousDeviceTime !== null) {
      if (o.deviceSampledAtMs === this.previousDeviceTime && o.devicePositionFrames === this.previousDevicePosition) {
        if (o.ended) s.state = o.completed ? 'completed' : 'draining'
        return this.watch(nowMs)
      }
      if (o.deviceSampledAtMs <= this.previousDeviceTime || o.devicePositionFrames < this.previousDevicePosition)
        return this.fail('presentation_clock_discontinuous')
    }
    if (s.sampledAtCoreMs !== null && o.sampledAtCoreMs <= s.sampledAtCoreMs) {
      if (o.sampledAtCoreMs === s.sampledAtCoreMs && o.sourceFrames === this.previousSource) return this.watch(nowMs)
      return this.fail('presentation_clock_discontinuous')
    }
    if (s.samples && o.sourceFrames < this.previousSource) return this.fail('presentation_clock_discontinuous')
    const elapsed = s.sampledAtCoreMs === null ? .25 : (o.sampledAtCoreMs-s.sampledAtCoreMs)/1000
    const errorMs = o.sourceFrames * 1000/p.sampleRate - (o.sampledAtCoreMs-p.startAtCoreMs)
    // Soft +/-1000 ppm cannot repair a lost media epoch. Rebuffer/re-arm is the
    // coordinator's job; never conceal a gross discontinuity by dropping PCM.
    if (!o.ended && Math.abs(errorMs) > Math.max(40, o.uncertaintyMs*4)) return this.fail('presentation_phase_lost')
    s.phaseErrorMs = errorMs; s.uncertaintyMs = o.uncertaintyMs; s.effectivePpm = o.effectivePpm
    s.sampledAtCoreMs = o.sampledAtCoreMs; ++s.samples; this.previousSource = o.sourceFrames
    this.previousDeviceTime = o.deviceSampledAtMs; this.previousDevicePosition = o.devicePositionFrames
    if (o.ended) { s.state = o.completed ? 'completed' : 'draining'; return { kind: 'wait' } }
    s.state = 'correcting'
    this.filteredErrorMs += (errorMs-this.filteredErrorMs) * (1-Math.exp(-elapsed/1.5))
    if (!canCommand) return { kind: 'wait' } // Keep observing during the previous command's ACK deadline.
    // Only correct phase outside the clock observation's uncertainty plus one
    // output frame. A low-pass PI loop is deliberately much slower than the
    // 100-250 ms of queued audio in the plant.
    const deadband = o.uncertaintyMs+1000/p.sampleRate
    const excessMs = Math.sign(this.filteredErrorMs)*Math.max(0, Math.abs(this.filteredErrorMs)-deadband)
    this.lastFeedPpm = o.deviceCoreDriftPpm ?? o.deviceDriftPpm ?? this.lastFeedPpm
    const feed = this.lastFeedPpm ?? 0
    const proportionalPpm = excessMs*1000/8
    const integral = this.integralPpm+excessMs*1000/320*elapsed
    const demanded = feed+proportionalPpm+integral
    if (Math.abs(demanded) <= 1000 || Math.sign(excessMs) !== Math.sign(demanded)) this.integralPpm = integral
    const target = clamp(feed+proportionalPpm+this.integralPpm, -1000, 1000)
    const ppm = Math.round(clamp(target, s.requestedPpm-40*elapsed, s.requestedPpm+40*elapsed)*1000)/1000
    if (Math.abs(ppm-s.requestedPpm) < .5) return { kind: 'wait' }
    s.requestedPpm = ppm
    return { kind: 'rate', ppm }
  }
}
