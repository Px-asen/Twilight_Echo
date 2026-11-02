import assert from 'node:assert/strict'
import test from 'node:test'
import { eqBandsInBox, groupEqBandPatches, selectEqBands } from './parametricEqSelection.ts'
import type { EqualizerBand } from '@renderer/types/settings'

const bands: EqualizerBand[] = [
  { frequency: 1000, gain: 6, q: 1, filterType: 'peak' },
  { frequency: 100, gain: 3, q: 2, filterType: 'lowShelf', enabled: false },
  { frequency: 5000, gain: -3, q: 0.5, filterType: 'highShelf' },
  { frequency: 2000, gain: 9, q: 1, filterType: 'notch' }
]

test('selection supports toggles and shift ranges in displayed frequency order', () => {
  assert.deepEqual(selectEqBands(bands, [0], 2, 0, { toggle: true, range: false }), {
    indices: [0, 2],
    primary: 2
  })
  assert.deepEqual(selectEqBands(bands, [0, 2], 2, 0, { toggle: true, range: false }), {
    indices: [0],
    primary: 0
  })
  assert.deepEqual(selectEqBands(bands, [0], 0, 0, { toggle: true, range: false }), {
    indices: [],
    primary: -1
  })
  assert.deepEqual(selectEqBands(bands, [1], 3, 1, { toggle: false, range: true }), {
    indices: [1, 0, 3],
    primary: 3
  })
  assert.deepEqual(selectEqBands(bands, [0, 2], 0, 2, { toggle: false, range: false }), {
    indices: [0, 2],
    primary: 0
  })
})

test('box selection uses visible gain positions, including bypassed and gainless bands', () => {
  assert.deepEqual(eqBandsInBox(bands, { left: 0, right: 100, top: 0, bottom: 40 }, 12), [0, 1])
  assert.deepEqual(eqBandsInBox(bands, { left: 0, right: 100, top: 49, bottom: 51 }, 12), [3])
  assert.deepEqual(eqBandsInBox(bands, { left: 0, right: 100, top: 0, bottom: 1 }, 3), [0, 1])
})

test('group drag preserves frequency and gain ratios without touching gainless filters', () => {
  const before = structuredClone(bands)
  const changes = groupEqBandPatches(bands, [0, 1, 2, 3], 0, { frequency: 2000, gain: 12 })
  assert.deepEqual(
    changes.map((change) => change.patch.frequency),
    [2000, 200, 10000, 4000]
  )
  assert.deepEqual(
    changes.map((change) => change.patch.gain),
    [12, 6, -6, undefined]
  )
  assert.deepEqual(bands, before)
  assert.ok(changes.every((change) => change.patch.enabled === undefined))
})

test('group movement stops together at frequency, Q and gain limits', () => {
  const changes = groupEqBandPatches(bands, [0, 1, 2], 0, { frequency: 96000, gain: 30, q: 20 })
  assert.deepEqual(
    changes.map((change) => change.patch.frequency),
    [19200, 1920, 96000]
  )
  assert.deepEqual(
    changes.map((change) => change.patch.gain),
    [24, 12, -12]
  )
  assert.deepEqual(
    changes.map((change) => change.patch.q),
    [10, 20, 5]
  )
  assert.deepEqual(
    groupEqBandPatches(bands, [0, 1], 0, { frequency: 10 }).map((change) => change.patch.frequency),
    [100, 10]
  )
})

test('zero-gain anchors use a shared bounded offset and single edits retain their value', () => {
  const zero = [
    { ...bands[0], gain: 0 },
    { ...bands[1], gain: 23 }
  ]
  assert.deepEqual(
    groupEqBandPatches(zero, [0, 1], 0, { gain: 5 }).map((change) => change.patch.gain),
    [1, 24]
  )
  assert.equal(groupEqBandPatches(bands, [0], 0, { gain: -4 })[0].patch.gain, -4)
})

test('filter and bypass changes affect the entire selection and gainless anchors never change gain', () => {
  const changes = groupEqBandPatches(bands, [0, 3], 3, { enabled: false, gain: 12 })
  assert.deepEqual(changes, [
    { index: 0, patch: { enabled: false } },
    { index: 3, patch: { enabled: false } }
  ])
  assert.ok(
    groupEqBandPatches(bands, [0, 1], 0, { filterType: 'highPass' }).every(
      (change) => change.patch.filterType === 'highPass'
    )
  )
})
