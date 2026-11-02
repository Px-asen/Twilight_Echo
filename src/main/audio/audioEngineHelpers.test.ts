import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveDopSupportState as mainDop,
  deriveNativeDsdSupportState as mainDsd,
  normalizeDsdState as mainDsdState
} from './audioEngineHelpers.ts'
import {
  deriveDopSupportState as rendererDop,
  deriveNativeDsdSupportState as rendererDsd
} from '../../renderer/src/stores/player/audioOutputNormalize.ts'
import { normalizeDsdState as rendererDsdState } from '../../renderer/src/utils/playerPlaybackInfo.ts'
import type {
  AudioDeviceOption,
  EqualizerBand,
  OutputInfo,
  PlaybackInfo
} from './audioEngineTypes.ts'

const {
  DEFAULT_OUTPUT_CONFIG,
  MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS,
  advanceSoftPlaybackPosition,
  audioProcessingSettingsEqual,
  createDefaultPlaybackInfo,
  eqBandsEqual,
  nativePlayMode,
  normalizeAudioProcessingSettings,
  normalizeInitialAudioProcessingSettings,
  normalizeOutputConversionInfo,
  normalizeOutputProviderImplementation,
  normalizeOutputConfig,
  normalizeVisualizationData,
  normalizeVisualizationOptions,
  withPrecomputedVisualizerBars,
  outputConfigsEqual,
  parseDspGraphStatusOrThrow,
  parseNativeJson,
  resolveProcessingMasterState,
  resolveQueueIndexForSource
} = (await import(
  new URL('./audioEngineHelpers.ts', import.meta.url).href
)) as typeof import('./audioEngineHelpers')

function deeplyNestedJson(depth: number): string {
  return `${'['.repeat(depth)}0${']'.repeat(depth)}`
}

test('native visualizer bars bypass spectrum expansion and malformed bars use the legacy fallback', () => {
  const options = normalizeVisualizationOptions({
    spectrumPoints: 4096,
    waveformPoints: 48,
    spectrogramFrames: 0,
    oscilloscopePoints: 0,
    visualizerBarCount: 140
  })
  const bars = Array.from({ length: 140 }, (_, i) => i / 140)
  bars[0] = Number.NaN
  bars[1] = 2
  const normalized = normalizeVisualizationData(
    { spectrum: [], visualizerBars: bars, active: true, sampleRate: 48000 },
    options
  )
  assert.deepEqual(normalized.spectrum, [])
  assert.equal(normalized.visualizerBars?.[0], 0)
  assert.equal(normalized.visualizerBars?.[1], 1)
  assert.equal(
    withPrecomputedVisualizerBars(normalized, options).visualizerBars,
    normalized.visualizerBars
  )
  const fallback = normalizeVisualizationData(
    { spectrum: Array(4096).fill(0.5), visualizerBars: [1], active: true, sampleRate: 48000 },
    options
  )
  assert.equal(fallback.spectrum.length, 4096)
  assert.deepEqual(
    withPrecomputedVisualizerBars(fallback, options).visualizerBars,
    Array(140).fill(0.5)
  )
})

test('crossfade defaults remain linear and content rules participate in settings equality', () => {
  const previous = normalizeAudioProcessingSettings()
  assert.equal(previous.crossfadeCurve, 'linear')
  assert.equal(previous.crossfadeContent, 'conservative')
  const next = normalizeAudioProcessingSettings({
    crossfadeCurve: 'equal-power',
    crossfadeContent: 'all'
  })
  assert.equal(audioProcessingSettingsEqual(previous, next), false)
  assert.deepEqual(normalizeAudioProcessingSettings(JSON.parse(JSON.stringify(next))), next)
})

test('continuity output policy migrates defaults and participates in route transactions', () => {
  const previous = normalizeOutputConfig()
  assert.equal(previous.playbackPolicy, 'bit-perfect-first')
  assert.equal(previous.continuitySampleRate, 48000)
  const continuous = normalizeOutputConfig({
    playbackPolicy: 'continuity-first',
    continuitySampleRate: 96000
  })
  assert.equal(outputConfigsEqual(previous, continuous), false)
  assert.equal(
    outputConfigsEqual(continuous, { ...continuous, continuitySampleRate: 44100 }),
    false
  )
  assert.deepEqual(normalizeOutputConfig(JSON.parse(JSON.stringify(continuous))), continuous)
  assert.equal(
    normalizeOutputConfig(JSON.parse('{"continuitySampleRate":12345}')).continuitySampleRate,
    48000
  )
})

function makePlaybackInfo(overrides: Partial<PlaybackInfo> = {}): PlaybackInfo {
  return {
    ...createDefaultPlaybackInfo('wasapi', 'auto', false, DEFAULT_OUTPUT_CONFIG),
    ...overrides
  }
}

test('native audio JSON parsers reject over-nested worker output without changing valid output', () => {
  const fallback = { state: 'stopped' }
  assert.equal(parseNativeJson(deeplyNestedJson(128), fallback), fallback)
  assert.deepEqual(parseNativeJson('{"state":"playing"}', fallback), { state: 'playing' })
  assert.throws(
    () => parseDspGraphStatusOrThrow(deeplyNestedJson(128)),
    /native audio engine returned invalid DSP graph status JSON/
  )
})

test('output conversion facts normalize old payloads without claiming unavailable details', () => {
  assert.equal(normalizeOutputProviderImplementation(undefined), 'legacy-native')
  assert.equal(normalizeOutputProviderImplementation('invalid'), 'legacy-native')
  assert.deepEqual(normalizeOutputConversionInfo(undefined, true), {
    sampleFormatConverted: false,
    sampleRateConverted: true,
    channelLayoutConverted: false,
    source: 'unavailable'
  })
  assert.deepEqual(
    normalizeOutputConversionInfo(
      {
        sampleFormatConverted: true,
        sampleRateConverted: true,
        channelLayoutConverted: true,
        source: 'backend-runtime'
      },
      false
    ),
    {
      sampleFormatConverted: true,
      sampleRateConverted: false,
      channelLayoutConverted: true,
      source: 'backend-runtime'
    }
  )
})

test('default playback output preserves shared mixer reason with legacy provider facts', () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, DEFAULT_OUTPUT_CONFIG)
  assert.equal(info.outputInfo.providerImplementation, 'legacy-native')
  assert.deepEqual(info.outputInfo.conversionInfo, {
    sampleFormatConverted: false,
    sampleRateConverted: false,
    channelLayoutConverted: false,
    source: 'unavailable'
  })
  assert.equal(info.outputInfo.perfectReasonCode, 'shared_mixer')
})

test('initial settings distinguish saved master-off from legacy module-only configurations', () => {
  const modules = [
    { eqEnabled: true },
    { eqPreamp: -2 },
    { convolverEnabled: true },
    { convolverIrPath: 'D:/IR/room.wav' },
    { crossfeedEnabled: true, crossfeedStrength: 0.4 },
    { volumeNormalization: 'track' as const }
  ]
  for (const module of modules) {
    let saved = normalizeInitialAudioProcessingSettings({
      ...module,
      dspEnabled: false,
      directMode: true
    })
    for (let restart = 0; restart < 3; restart++) {
      saved = normalizeInitialAudioProcessingSettings(JSON.parse(JSON.stringify(saved)))
      assert.equal(saved.dspEnabled, false)
      assert.equal(saved.directMode, true)
      for (const [key, value] of Object.entries(module))
        assert.equal(saved[key as keyof typeof saved], value)
    }
    const legacy = normalizeInitialAudioProcessingSettings(module)
    assert.equal(legacy.dspEnabled, true)
    assert.equal(legacy.directMode, false)
  }
  const enabled = normalizeInitialAudioProcessingSettings({
    dspEnabled: true,
    directMode: true,
    eqEnabled: true
  })
  assert.equal(enabled.dspEnabled, true)
  assert.equal(enabled.directMode, false)
})

test('resolveProcessingMasterState reconciles modules, master switch, and direct mode', () => {
  const base = {
    dspEnabled: false,
    directMode: false,
    eqEnabled: false,
    eqPreamp: 0,
    volumeNormalization: 'off' as const,
    convolverEnabled: false,
    convolverIrPath: '',
    crossfeedEnabled: false,
    crossfeedStrength: 0
  }
  // Enabling EQ exits direct mode and turns the DSP master on.
  assert.deepEqual(resolveProcessingMasterState({ ...base, eqEnabled: true }), {
    dspEnabled: true,
    directMode: false
  })
  // A stale persisted directMode with an enabled module is healed.
  assert.deepEqual(resolveProcessingMasterState({ ...base, directMode: true, eqEnabled: true }), {
    dspEnabled: true,
    directMode: false
  })
  // An explicit master-switch off always wins.
  assert.deepEqual(resolveProcessingMasterState({ ...base, eqEnabled: true }, false), {
    dspEnabled: false,
    directMode: true
  })
  // No module and no explicit intent keeps the current state.
  assert.deepEqual(resolveProcessingMasterState({ ...base, dspEnabled: true, directMode: false }), {
    dspEnabled: true,
    directMode: false
  })
  // Explicit direct mode without modules stays direct.
  assert.deepEqual(resolveProcessingMasterState(base, undefined, true), {
    dspEnabled: false,
    directMode: true
  })
})

test('MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS is 1.5', () => {
  assert.equal(MAX_SOFT_PLAYBACK_CLOCK_GAP_SECONDS, 1.5)
})

test('nativePlayMode maps supported modes and falls back otherwise', () => {
  assert.equal(nativePlayMode('sequential'), 'sequential')
  assert.equal(nativePlayMode('repeat'), 'repeat')
  // Both looping modes ride native listLoop: the renderer hands over an already
  // shuffled queue, so the engine must wrap that order rather than re-permute it.
  assert.equal(nativePlayMode('listLoop'), 'listLoop')
  assert.equal(nativePlayMode('shuffle'), 'listLoop')
  // heart loads only the current track and lets the renderer own every boundary.
  assert.equal(nativePlayMode('heart'), 'sequential')
  assert.equal(nativePlayMode('unknown' as Parameters<typeof nativePlayMode>[0]), 'sequential')
})

test('resolveQueueIndexForSource returns info unchanged when no correction is needed', () => {
  const queue = [
    { id: 'one', source: 'one.flac' },
    { id: 'two', source: 'two.flac' }
  ]
  const noSource = makePlaybackInfo({ queueIndex: 1 })
  assert.equal(resolveQueueIndexForSource(queue, noSource), noSource)

  const matchingSource = makePlaybackInfo({ source: 'one.flac', queueIndex: 0 })
  assert.equal(resolveQueueIndexForSource(queue, matchingSource), matchingSource)

  const missingSource = makePlaybackInfo({ source: 'missing.flac', queueIndex: 0 })
  assert.equal(resolveQueueIndexForSource(queue, missingSource), missingSource)
})

test('resolveQueueIndexForSource copies with corrected queue index when source exists elsewhere', () => {
  const queue = [
    { id: 'one', source: 'one.flac' },
    { id: 'two', source: 'two.flac' },
    { id: 'three', source: 'one.flac' }
  ]
  const info = makePlaybackInfo({ source: 'two.flac', queueIndex: 0 })
  const resolved = resolveQueueIndexForSource(queue, info)

  assert.notEqual(resolved, info)
  assert.equal(resolved.queueIndex, 1)
  assert.equal(resolved.source, 'two.flac')
})

test('advanceSoftPlaybackPosition applies the soft playback clock rule', () => {
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1, 20), 10.25)
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1.5, 20), 10.375)
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1.5, 10.2), 10.2)
  assert.equal(advanceSoftPlaybackPosition(10, 0.25, 1.5, 0), 10.375)
  assert.equal(advanceSoftPlaybackPosition(10, 2.5, 1, 20), 10)
  assert.equal(advanceSoftPlaybackPosition(10, -1, 1, 20), 10)
})

function makeEqBands(patch: Partial<EqualizerBand> = {}): EqualizerBand[] {
  return [{ frequency: 1000, gain: 0, q: 1, filterType: 'peak', ...patch }]
}

test('eqBandsEqual compares per-band bypass and channel routing', () => {
  // dspOrchestrator.setAudioProcessing early-returns when settings compare
  // equal, so ignoring these left a bypass toggle still processing audio.
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ enabled: false })), false)
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ channelMask: 1 })), false)

  // Absent flags stay equivalent to their defaults so unrelated writes are
  // still short-circuited.
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ enabled: true })), true)
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands({ channelMask: 0xffffffff })), true)
  assert.equal(eqBandsEqual(makeEqBands(), makeEqBands()), true)
})

test('audioProcessingSettingsEqual treats a band bypass toggle as a real change', () => {
  const left = normalizeAudioProcessingSettings({ eqMode: 'graphic' })
  const right = normalizeAudioProcessingSettings({
    eqMode: 'graphic',
    eqBands: left.eqBands.map((band, index) =>
      index === 2 ? { ...band, enabled: false } : { ...band }
    )
  })
  assert.equal(audioProcessingSettingsEqual(left, right), false)
  assert.equal(audioProcessingSettingsEqual(left, { ...left }), true)
})

test('normalization preserves an explicitly empty parametric EQ through a settings round trip', () => {
  const empty = normalizeAudioProcessingSettings({ eqMode: 'parametric', eqBands: [] })
  assert.deepEqual(empty.eqBands, [])
  assert.deepEqual(normalizeAudioProcessingSettings(empty).eqBands, [])
  assert.equal(
    normalizeAudioProcessingSettings({ eqMode: 'graphic', eqBands: [] }).eqBands.length,
    10
  )
  assert.equal(normalizeAudioProcessingSettings({ eqMode: 'parametric' }).eqBands.length, 10)
})

test('phone EQ frequencies and per-band flags survive desktop processing normalization', () => {
  const bands: EqualizerBand[] = [
    {
      frequency: 10,
      gain: 3,
      q: 0.7,
      filterType: 'lowShelf',
      enabled: true,
      channelMask: 0xffffffff
    },
    { frequency: 96000, gain: -2, q: 1.2, filterType: 'highShelf', enabled: false, channelMask: 2 }
  ]
  const processing = normalizeAudioProcessingSettings({ eqMode: 'parametric', eqBands: bands })
  assert.deepEqual(processing.eqBands, bands)
  assert.deepEqual(
    normalizeAudioProcessingSettings({ ...processing, dspEnabled: true }).eqBands,
    bands
  )
})

test('normalizeAudioProcessingSettings keeps graphic band gains through a round trip', () => {
  const first = normalizeAudioProcessingSettings({ eqMode: 'graphic' })
  const edited = normalizeAudioProcessingSettings({
    ...first,
    eqBands: first.eqBands.map((band, index) => (index === 3 ? { ...band, gain: 5 } : { ...band }))
  })
  assert.equal(edited.eqBands[3].gain, 5)
  assert.equal(normalizeAudioProcessingSettings({ ...edited }).eqBands[3].gain, 5)
})

test('graphic frequencies survive the native processing settings round trip', () => {
  const defaults = normalizeAudioProcessingSettings({ eqMode: 'graphic' })
  const bands = defaults.eqBands.map((band, index) => ({
    ...band,
    frequency: index === 0 ? 10 : index === 9 ? 96000 : band.frequency
  }))
  const processing = normalizeAudioProcessingSettings({ ...defaults, eqBands: bands })
  assert.deepEqual(processing.eqBands, bands)
  assert.deepEqual(normalizeAudioProcessingSettings(JSON.parse(JSON.stringify(processing))), processing)
})

test('main and renderer agree on capability candidates without promoting IDs to verified support', () => {
  const cases: Array<[Partial<AudioDeviceOption>, string, string]> = [
    [{ id: 'auto' }, 'runtime-probed', 'unsupported'],
    [{ id: 'wasapi:usb' }, 'runtime-probed', 'unsupported'],
    [{ id: 'coreaudio:usb' }, 'runtime-probed', 'unsupported'],
    [{ id: 'alsa:hw:0,0' }, 'unknown', 'runtime-probed'],
    [{ id: 'hw:0,0' }, 'unknown', 'runtime-probed'],
    [{ id: 'alsa:plughw:0,0' }, 'unknown', 'unknown'],
    [{ id: 'asio:usb' }, 'unknown', 'unknown'],
    [{ id: 'unknown' }, 'unknown', 'unknown'],
    [{ id: 'wasapi:usb', backend: 'alsa', pathKind: 'hw' }, 'unknown', 'runtime-probed'],
    [
      { id: 'alsa:hw:0,0', supportsNativeDsd: false, supportsDop: false },
      'unsupported',
      'unsupported'
    ],
    [
      { id: 'asio:usb', nativeDsdSupportState: 'verified', dopSupportState: 'unsupported' },
      'unsupported',
      'verified'
    ],
    [
      { id: 'asio:usb', nativeDsdSampleRates: [2822400], dopCarrierSampleRates: [176400] },
      'verified',
      'verified'
    ]
  ]
  for (const [device, dop, dsd] of cases) {
    for (const [name, deriveDop, deriveDsd] of [
      ['main', mainDop, mainDsd],
      ['renderer', rendererDop, rendererDsd]
    ] as const) {
      assert.equal(deriveDop(device), dop, `${name} DoP ${device.id}`)
      assert.equal(deriveDsd(device), dsd, `${name} DSD ${device.id}`)
    }
  }
})

test('both playback consumers honor canonical DSD facts over stale mirror fields', () => {
  const cases: Array<[Partial<OutputInfo> | null, Partial<PlaybackInfo> | null, object]> = [
    [
      { isDsd: false, dsdMode: 'pcm' },
      { isDsd: true, dsdMode: 'native', dsdRate: 2822400 },
      { isDsd: false, dsdMode: 'pcm', dsdRate: 0 }
    ],
    [
      { dsdMode: ' native ', dsdRate: 2822400 },
      null,
      { isDsd: true, dsdMode: 'native', dsdRate: 2822400 }
    ],
    [null, { isDsd: true }, { isDsd: true, dsdMode: 'unsupported', dsdRate: 0 }],
    [null, null, { isDsd: false, dsdMode: 'pcm', dsdRate: 0 }]
  ]
  for (const [canonical, mirror, expected] of cases) {
    assert.deepEqual(mainDsdState(canonical, mirror), expected)
    assert.deepEqual(rendererDsdState(canonical, mirror), expected)
  }
})
