import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatEqBandClipboard,
  normalizeEqClipboardBands,
  parseEqBandClipboard
} from './equalizerClipboard.ts'
import type { EqualizerBand } from './audioEngineTypes.ts'

const band: EqualizerBand = {
  frequency: 1000,
  gain: -6,
  q: 2,
  filterType: 'peak',
  enabled: false,
  channelMask: 1
}

test('EQ clipboard round trips all supported filters and optional bypass/channel flags', () => {
  const bands: EqualizerBand[] = [
    'peak',
    'lowShelf',
    'highShelf',
    'bandPass',
    'lowPass',
    'highPass',
    'allPass',
    'notch'
  ].map((filterType) => ({ ...band, filterType: filterType as EqualizerBand['filterType'] }))
  bands.push({ frequency: 96000, gain: 24, q: 20, filterType: 'peak' })
  bands.push({ frequency: 10, gain: -24, q: 0.1, filterType: 'peak', channelMask: 0xffffffff })
  assert.deepEqual(parseEqBandClipboard(formatEqBandClipboard(bands)), bands)
})

test('clipboard normalization creates isolated DTOs and drops non-EQ fields', () => {
  const source = { ...band, path: 'private', command: 'quit' }
  const [result] = normalizeEqClipboardBands([source])
  assert.deepEqual(result, band)
  result.gain = 3
  assert.equal(source.gain, -6)
})

test('clipboard rejects non-EQ text, unsupported versions and oversized input', () => {
  for (const text of [
    '',
    'ordinary copied text',
    'null',
    '[]',
    '{"kind":"other"}',
    JSON.stringify({ kind: 'twilight-echo/eq-bands', version: 2, bands: [band] })
  ])
    assert.throws(() => parseEqBandClipboard(text), /没有可粘贴/)
  assert.throws(() => parseEqBandClipboard(' '.repeat(65537)), /数据过大/)
})

test('clipboard rejects invalid parameters and counts without partially accepting a selection', () => {
  for (const patch of [
    { frequency: 9 },
    { frequency: 96001 },
    { frequency: '1000' },
    { gain: NaN },
    { gain: Infinity },
    { gain: -24.1 },
    { gain: 24.1 },
    { q: 0 },
    { q: 20.1 },
    { filterType: 'unknown' },
    { enabled: 'false' },
    { channelMask: -1 },
    { channelMask: 1.5 },
    { channelMask: 0x100000000 }
  ])
    assert.throws(() => normalizeEqClipboardBands([band, { ...band, ...patch }]), /参数无效/)
  for (const value of [null, [], [null], [1], Array(33).fill(band)])
    assert.throws(() => normalizeEqClipboardBands(value))
  assert.equal(normalizeEqClipboardBands(Array(32).fill(band)).length, 32)
  assert.throws(
    () => parseEqBandClipboard(formatEqBandClipboard([{ ...band, gain: Infinity }])),
    /参数无效/
  )
})
