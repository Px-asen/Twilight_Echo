import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DspAsset } from '../../shared/dspGraph.ts'
import type { DspAssetLibrary } from './dspAssetLibrary.ts'
import { importCorrectionProfileFile, parseCorrectionProfileText } from './correctionProfile.ts'

test('imports Equalizer APO parametric filters with channel masks', () => {
  const profile = parseCorrectionProfileText(`
# Equalizer APO
Device: Speakers
Preamp: -4.5 dB
Channel: L, R
Filter 1: ON PK Fc 105 Hz Gain 3.2 dB Q 1.41
Filter 2: OFF LSC Fc 80 Hz Gain -1.5 dB Q 0.70
Filter 3: ON NO Fc 8000 Hz Q 4.00
`)

  assert.equal(profile.format, 'equalizerApo')
  assert.equal(profile.preampDb, -4.5)
  assert.deepEqual(profile.bands, [
    { frequency: 105, gain: 3.2, q: 1.41, filterType: 'peak', enabled: true, channelMask: 3 },
    { frequency: 80, gain: -1.5, q: 0.7, filterType: 'lowShelf', enabled: false, channelMask: 3 },
    { frequency: 8000, gain: 0, q: 4, filterType: 'notch', enabled: true, channelMask: 3 }
  ])
})

test('recognizes a REW filter settings file', () => {
  const profile = parseCorrectionProfileText(`
Filter Settings file
Room EQ Wizard V5.31
Preamp: -2.0 dB
Filter 1: ON HSC Fc 6500 Hz Gain 1.5 dB Q 0.80
`)

  assert.equal(profile.format, 'rew')
  assert.equal(profile.bands[0].filterType, 'highShelf')
})

test('recognizes AutoEq parametric text', () => {
  const profile = parseCorrectionProfileText(`
# AutoEq: Example Headphone ParametricEQ
Preamp: -6.1 dB
Filter 1: ON PK Fc 60 Hz Gain 4.0 dB Q 0.75
Filter 2: ON PK Fc 2200 Hz Gain -2.5 dB Q 1.20
`)

  assert.equal(profile.format, 'autoeq')
  assert.equal(profile.bands.length, 2)
  assert.equal(profile.bands[1].gain, -2.5)
})

test('phone-exported filter codes keep center shelves, custom-Q passes and all 32 channels', () => {
  const profile = parseCorrectionProfileText(`Preamp: -6.5 dB
Channel: L R 32
Filter 1: ON LSC Fc 10 Hz Gain 4.5 dB Q 0.7
Filter 2: OFF HSC Fc 96000 Hz Gain -2.5 dB Q 0.8
Filter 3: ON LPQ Fc 18000 Hz Q 1.2
Filter 4: ON HPQ Fc 15 Hz Q 0.5
Channel: all
Filter 5: ON BP Fc 1000 Hz Q 2
Filter 6: ON AP Fc 100 Hz Q 1
`)
  assert.equal(profile.preampDb, -6.5)
  assert.deepEqual(profile.bands.slice(0, 4), [
    {
      frequency: 10,
      gain: 4.5,
      q: 0.7,
      filterType: 'lowShelf',
      enabled: true,
      channelMask: 0x80000003
    },
    {
      frequency: 96000,
      gain: -2.5,
      q: 0.8,
      filterType: 'highShelf',
      enabled: false,
      channelMask: 0x80000003
    },
    {
      frequency: 18000,
      gain: 0,
      q: 1.2,
      filterType: 'lowPass',
      enabled: true,
      channelMask: 0x80000003
    },
    {
      frequency: 15,
      gain: 0,
      q: 0.5,
      filterType: 'highPass',
      enabled: true,
      channelMask: 0x80000003
    }
  ])
  assert.equal(profile.bands[4].channelMask, 0xffffffff)
  assert.equal(profile.bands[5].filterType, 'allPass')
})

test('LP and HP use fixed Butterworth Q and require LPQ/HPQ for another Q', () => {
  const profile = parseCorrectionProfileText(`Filter 1: ON LP Fc 18000 Hz
Filter 2: OFF HP Fc 20 Hz Q 0.7071`)
  assert.deepEqual(
    profile.bands.map((band) => [band.filterType, band.q]),
    [
      ['lowPass', Math.SQRT1_2],
      ['highPass', Math.SQRT1_2]
    ]
  )
  for (const shape of ['LP', 'HP']) {
    assert.throws(
      () => parseCorrectionProfileText(`Filter: ON ${shape} Fc 100 Hz Q 1.5`),
      new RegExp(`第 1 行.*${shape}Q`)
    )
    assert.throws(() => parseCorrectionProfileText(`Filter: ON ${shape}Q Fc 100 Hz`), /缺少 Q/)
  }
})

test('corner-frequency shelves, slope and bandwidth are refused instead of reinterpreted', () => {
  for (const shape of ['LS', 'HS']) {
    assert.throws(
      () => parseCorrectionProfileText(`Filter: ON ${shape} Fc 100 Hz Gain 4 dB Q 0.7`),
      new RegExp(`第 1 行.*拐点.*${shape}C`)
    )
  }
  assert.throws(() => parseCorrectionProfileText('Filter: ON LSC 12dB Fc 100 Hz Gain 3 dB'), /斜率/)
  assert.throws(() => parseCorrectionProfileText('Filter: ON PK Fc 100 Hz Gain 3 dB BW 1'), /BW/)
})

test('filter parameters accept attached units and report duplicate, mismatched and out-of-range values', () => {
  const [band] = parseCorrectionProfileText('Filter: ON PEQ Q 1.2 Fc 1e3Hz Gain -2.5dB').bands
  assert.equal(band.frequency, 1000)
  assert.equal(band.gain, -2.5)
  for (const params of [
    'Fc 1000 Hz Q 1 Q 2 Gain 3 dB',
    'Fc 1000dB Q 1 Gain 3 dB',
    'Fc 9 Hz Q 1 Gain 3 dB',
    'Fc 96001 Hz Q 1 Gain 3 dB',
    'Fc 100 Hz Q 21 Gain 3 dB',
    'Fc 1e999 Hz Q 1 Gain 3 dB'
  ]) {
    assert.throws(() => parseCorrectionProfileText(`Filter: ON PK ${params}`), /第 1 行/)
  }
})

test('REW measurement metadata and empty slots do not hide unsupported processing directives', () => {
  const header =
    'Filter Settings file\nRoom EQ V5.31.1\nDated: 1-Nov-2026\nNotes: chair 2\nEqualiser: Generic\nAverage 1\n'
  const filter = 'Filter 1: ON PK Fc 63 Hz Gain -6 dB Q 4\nFilter 2: OFF None'
  assert.equal(parseCorrectionProfileText(header + filter).bands.length, 1)
  assert.throws(
    () => parseCorrectionProfileText(header + 'Include: other.txt\n' + filter),
    /仅可导入参数 EQ/
  )
  assert.throws(
    () => parseCorrectionProfileText(header + 'Convolution: other.wav\n' + filter),
    /无法识别/
  )
})

test('device blocks and channel-specific preamp are not flattened into a different signal path', () => {
  const filter = 'Filter: ON PK Fc 1000 Hz Gain 1 dB Q 1'
  assert.throws(
    () => parseCorrectionProfileText('Device: A\n' + filter + '\nDevice: B\n' + filter),
    /多个 Device/
  )
  assert.throws(
    () => parseCorrectionProfileText('Channel: L\nPreamp: -3 dB\n' + filter),
    /全部声道/
  )
  for (const channel of ['0', '33', '1.5']) {
    assert.throws(
      () => parseCorrectionProfileText(`Channel: ${channel}\n${filter}`),
      /不支持的声道/
    )
  }
})

test('rejects unsupported and ambiguous correction text', () => {
  assert.throws(
    () => parseCorrectionProfileText('GraphicEQ: 20 0; 100 3; 1000 -2'),
    /仅可导入参数 EQ/
  )
  assert.throws(() => parseCorrectionProfileText('Filter 1: ON PK Fc 1000 Hz Q 1.00'), /需要 Gain/)
  assert.throws(() => parseCorrectionProfileText('Include: arbitrary.txt'), /仅可导入参数 EQ/)
})

test('validates a correction before delegating storage to the managed asset library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-correction-profile-'))
  try {
    const sourcePath = join(root, 'headphone.txt')
    await writeFile(
      sourcePath,
      '# Equalizer APO\nPreamp: -3 dB\nFilter 1: ON PK Fc 1000 Hz Gain 2 dB Q 1.2\n',
      'utf8'
    )
    let importCalls = 0
    const assets: Pick<DspAssetLibrary, 'importFile'> = {
      importFile: async () => {
        importCalls += 1
        return {
          id: 'correctionProfile:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          kind: 'correctionProfile',
          name: 'headphone',
          fileName: 'headphone.txt',
          sha256: 'a'.repeat(64),
          byteSize: 1,
          mediaType: 'text/plain',
          createdAt: '2026-01-01T00:00:00.000Z',
          referenceCount: 0
        } satisfies DspAsset
      }
    }
    const imported = await importCorrectionProfileFile(sourcePath, assets)

    assert.equal(imported.asset.kind, 'correctionProfile')
    assert.equal(imported.profile.bands.length, 1)
    assert.equal(importCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
