export interface FluidPhaseStepInput {
  /** Frame delta in seconds. */
  dtSeconds: number
  /** Whether playback is currently active. */
  playing: boolean
  /** User speed multiplier [0.25, 2.5], default 1.0. */
  speedMultiplier: number
  /** Theme tempo multiplier (18s / --te-playback-fluid-tempo), default 1.0. */
  tempoMultiplier?: number
  /** Instantaneous normalized low-frequency energy in [0, 1]. */
  lowFreqEnergy?: number
  /** Whether audio-reactive bass surge is enabled. */
  audioReactive?: boolean
}

export interface FluidPhaseState {
  /** Monotonically integrated phase driving orbital rotations & liquid domain waves. */
  readonly phase: number
  /** Smoothed bass pulse envelope in [0, 1] for subtle curvature/light-wave swell. */
  readonly swell: number
  /** Smoothed play velocity factor between paused micro-breathing (0.18) and active (1.0). */
  readonly playFactor: number
}

const PAUSED_BREATHING_FACTOR = 0.18
const BASE_ANGULAR_SPEED = 0.36
const MAX_DT_SECONDS = 0.1

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Extracts normalized low-frequency (20 Hz – 155 Hz) energy from the audio engine's
 * linear FFT spectrum array while ignoring mid/high-frequency content.
 */
export function extractLowFrequencyEnergy(
  spectrum: ArrayLike<number> | null | undefined,
  sampleRate = 48000
): number {
  if (!spectrum || spectrum.length === 0) return 0
  const n = spectrum.length
  const effectiveRate = sampleRate > 0 ? sampleRate : 48000
  const nyquist = effectiveRate * 0.5
  const binHz = nyquist / n

  // When spectrum has few points (e.g. 64 linear bins -> ~375 Hz/bin), ensure the
  // lowest 2 bins still represent the sub-bass / kick region with gentle weighting.
  const maxBin = Math.min(n - 1, Math.max(1, Math.ceil(160 / Math.max(1, binHz))))
  let weightedSum = 0
  let weightTotal = 0

  for (let i = 0; i <= maxBin; i++) {
    const raw = Number(spectrum[i])
    if (!Number.isFinite(raw) || raw <= 0) continue
    const centerHz = (i + 0.5) * binHz
    const bandWeight = centerHz <= 110 ? 1.0 : centerHz <= 240 ? 0.65 : 0.28
    weightedSum += clamp(raw, 0, 1) * bandWeight
    weightTotal += bandWeight
  }

  if (weightTotal <= 0) return 0
  return clamp(weightedSum / weightTotal, 0, 1)
}

/**
 * Continuous phase integrator with asymmetric bass transient tracking and
 * exponential pause damping. Integrating angular velocity prevents any phase
 * discontinuity when changing speed, pausing, or riding bass transients.
 */
export class FluidPhaseIntegrator {
  private phase = 0
  private playFactor = 1
  private bassFloor = 0.08
  private bassEnvelope = 0

  constructor(initialPhase = 0, initiallyPlaying = true) {
    this.phase = initialPhase
    this.playFactor = initiallyPlaying ? 1 : PAUSED_BREATHING_FACTOR
  }

  reset(initialPhase = 0, initiallyPlaying = true): void {
    this.phase = initialPhase
    this.playFactor = initiallyPlaying ? 1 : PAUSED_BREATHING_FACTOR
    this.bassFloor = 0.08
    this.bassEnvelope = 0
  }

  getState(): FluidPhaseState {
    return {
      phase: this.phase,
      swell: this.bassEnvelope,
      playFactor: this.playFactor
    }
  }

  step(input: FluidPhaseStepInput): FluidPhaseState {
    const dt = clamp(Number.isFinite(input.dtSeconds) ? input.dtSeconds : 0, 0, MAX_DT_SECONDS)
    if (dt <= 0) return this.getState()

    const targetPlay = input.playing ? 1 : PAUSED_BREATHING_FACTOR
    const playAlpha = 1 - Math.exp(-dt / 0.62)
    this.playFactor += (targetPlay - this.playFactor) * playAlpha

    const rawBass =
      input.playing && input.audioReactive !== false
        ? clamp(input.lowFreqEnergy ?? 0, 0, 1)
        : 0

    // Slow adaptive floor isolates rhythmic drum/bass surges from steady background drone
    const floorTau = rawBass < this.bassFloor ? 0.28 : 1.85
    this.bassFloor += (rawBass - this.bassFloor) * (1 - Math.exp(-dt / floorTau))
    const transient = clamp((rawBass - this.bassFloor * 0.72) * 1.65, 0, 1)

    const envTau = transient > this.bassEnvelope ? 0.048 : 0.34
    this.bassEnvelope += (transient - this.bassEnvelope) * (1 - Math.exp(-dt / envTau))

    const userSpeed = clamp(Number.isFinite(input.speedMultiplier) ? input.speedMultiplier : 1, 0.25, 2.5)
    const tempoSpeed = clamp(Number.isFinite(input.tempoMultiplier) ? input.tempoMultiplier! : 1, 0.35, 3)

    const velocity =
      BASE_ANGULAR_SPEED *
      userSpeed *
      tempoSpeed *
      (this.playFactor + 1.18 * this.bassEnvelope)

    this.phase += velocity * dt
    return this.getState()
  }
}
