import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLoudnessMeasurement,
  loudnessGainValues,
  normalizeLoudnessGroups
} from './libraryLoudness.ts'

test('library loudness units distinguish measurement, ReplayGain 2, R128 and linear peak', () => {
  const result = {
    source: 'analyzed' as const,
    available: true,
    algorithmVersion: 2,
    integratedLufs: -14,
    truePeakDb: -6.020599913,
    analyzedAt: '2026-09-14T00:00:00Z'
  }
  assert.equal(isLoudnessMeasurement(result), true)
  const gains = loudnessGainValues(result)
  assert.equal(gains.replayGain2Db, -4)
  assert.equal(gains.r128Db, -9)
  assert.equal(gains.r128Q78, -2304)
  assert.ok(Math.abs(gains.peakLinear - 0.5) < 1e-9)
  for (const patch of [
    { available: false },
    { algorithmVersion: 1 },
    { integratedLufs: NaN },
    { source: 'tags' },
    { analyzedAt: 'invalid' }
  ])
    assert.equal(isLoudnessMeasurement({ ...result, ...patch }), false)
})

test('batch normalization bounds groups and members and preserves CUE source ranges', () => {
  const group = {
    id: 'album:one',
    title: 'One',
    mode: 'album',
    tracks: [
      {
        id: 'cue:1',
        filePath: 'D:/music/a.flac',
        subTrack: 'cue:1',
        cueRange: { startSeconds: 1, endSeconds: 10, pregapSeconds: 2 }
      }
    ]
  }
  assert.equal(normalizeLoudnessGroups([group])[0].tracks[0].cueRange?.startSeconds, 1)
  assert.throws(() => normalizeLoudnessGroups([group, group]), /重复/)
  assert.throws(
    () => normalizeLoudnessGroups([{ ...group, tracks: [group.tracks[0], group.tracks[0]] }]),
    /重复/
  )
  assert.throws(
    () =>
      normalizeLoudnessGroups([
        {
          ...group,
          tracks: [{ ...group.tracks[0], cueRange: { startSeconds: 10, endSeconds: 1 } }]
        }
      ]),
    /CUE/
  )
  assert.throws(() => normalizeLoudnessGroups([{ ...group, id: '../x\ninvalid' }]), /无效/)
  assert.throws(
    () =>
      normalizeLoudnessGroups([
        {
          ...group,
          tracks: Array.from({ length: 257 }, (_, i) => ({ id: String(i), filePath: 'x' }))
        }
      ]),
    /256/
  )
  assert.throws(
    () =>
      normalizeLoudnessGroups(
        Array.from({ length: 10001 }, (_, i) => ({ ...group, id: String(i) }))
      ),
    /10,000/
  )
})
