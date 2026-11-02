import assert from 'node:assert/strict'
import test from 'node:test'
import { extractLowFrequencyEnergy, FluidPhaseIntegrator } from './fluidAudioReactivity.ts'

test('extractLowFrequencyEnergy responds to sub-bass/kick bins while rejecting mid/high treble', () => {
  const bassHeavy = new Float32Array(64)
  bassHeavy[0] = 0.85
  bassHeavy[1] = 0.72
  const bassEnergy = extractLowFrequencyEnergy(bassHeavy, 48000)
  assert.ok(bassEnergy > 0.65, `expected strong low-frequency energy, got ${bassEnergy}`)

  const trebleOnly = new Float32Array(64)
  for (let i = 10; i < 64; i++) trebleOnly[i] = 0.95
  const trebleEnergy = extractLowFrequencyEnergy(trebleOnly, 48000)
  assert.equal(trebleEnergy, 0, 'mid/high frequencies must not trigger low-frequency fluid swell')

  assert.equal(extractLowFrequencyEnergy(null), 0)
  assert.equal(extractLowFrequencyEnergy([]), 0)
})

test('FluidPhaseIntegrator advances phase monotonically without discontinuities across speed, pause, and bass changes', () => {
  const integrator = new FluidPhaseIntegrator(1.0, true)
  let prevPhase = integrator.getState().phase

  // Step normally, then abruptly change speedMultiplier from 2.4 -> 0.3 and pause
  const scenarios = [
    { playing: true, speedMultiplier: 1.0, lowFreqEnergy: 0.1 },
    { playing: true, speedMultiplier: 2.4, lowFreqEnergy: 0.92 },
    { playing: true, speedMultiplier: 0.3, lowFreqEnergy: 0.05 },
    { playing: false, speedMultiplier: 1.5, lowFreqEnergy: 0.95 }
  ]

  for (const s of scenarios) {
    for (let frame = 0; frame < 15; frame++) {
      const next = integrator.step({
        dtSeconds: 1 / 60,
        playing: s.playing,
        speedMultiplier: s.speedMultiplier,
        lowFreqEnergy: s.lowFreqEnergy,
        audioReactive: true
      })
      assert.ok(next.phase > prevPhase, 'phase must advance monotonically without backward jumps')
      assert.ok(next.phase - prevPhase < 0.25, 'single-frame phase delta must stay smooth and bounded')
      prevPhase = next.phase
    }
  }

  // Let pause settle for ~3 seconds -> playFactor should decay smoothly to ~0.18 micro-breathing
  for (let i = 0; i < 180; i++) {
    integrator.step({
      dtSeconds: 1 / 60,
      playing: false,
      speedMultiplier: 1.0,
      lowFreqEnergy: 0.8
    })
  }
  const pausedState = integrator.getState()
  assert.ok(
    Math.abs(pausedState.playFactor - 0.18) < 0.015,
    `expected paused playFactor near 0.18, got ${pausedState.playFactor}`
  )
  assert.ok(pausedState.swell < 0.02, 'bass swell must decay to zero while paused')
})

test('FluidPhaseIntegrator bass transient surge boosts swell while steady drone adapts floor', () => {
  const integrator = new FluidPhaseIntegrator(0, true)

  // Sudden kick hit from quiet floor
  let peakSwell = 0
  for (let i = 0; i < 8; i++) {
    const state = integrator.step({
      dtSeconds: 1 / 60,
      playing: true,
      speedMultiplier: 1.0,
      lowFreqEnergy: 0.9,
      audioReactive: true
    })
    peakSwell = Math.max(peakSwell, state.swell)
  }
  assert.ok(peakSwell > 0.55, `expected kick transient to lift swell > 0.55, got ${peakSwell}`)

  // When audioReactive is disabled, swell decays cleanly even if lowFreqEnergy stays high
  for (let i = 0; i < 90; i++) {
    integrator.step({
      dtSeconds: 1 / 60,
      playing: true,
      speedMultiplier: 1.0,
      lowFreqEnergy: 0.95,
      audioReactive: false
    })
  }
  assert.ok(integrator.getState().swell < 0.03)
})
