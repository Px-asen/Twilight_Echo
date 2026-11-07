import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeNativeBindingFailure,
  loadNativeBindingWithDiagnostics,
  resolveElectronApp
} from './audio/nativeBinding.ts'
import type { DspGraphStatus, DspScene } from '../shared/dspGraph.ts'
import type { DspStatePayload } from '../shared/audioServiceContract.ts'
import { createSleepTimerState } from '../shared/sleepTimer.ts'
import { deviceOptionsForOutput } from '../shared/audioDeviceRouting.ts'
import { registerNativeSleepTimerBoundaries } from './audio/sleepTimerNativeBoundary.ts'
import { SleepTimerService } from './sleepTimerCore.ts'
import { LibraryDatabase } from './library/libraryDatabase.ts'
import { AfterglowLibraryQueueCore } from './app/afterglowLibraryQueueCore.ts'
import { afterglowNativeQueueItem } from './app/afterglowQueueCore.ts'
import { isAfterglowSourceCurrent } from './app/afterglowSourceResolver.ts'
import {
  navigateAfterglowLibraryQueue,
  type AfterglowLibraryNavigation
} from './app/afterglowLibraryTransport.ts'

// Most fake devices in this suite implement Windows backend contracts. Tests
// for other platforms explicitly override this fixture and restore it locally.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

test('plain Node diagnostics never load the Electron SDK or trigger binary discovery', () => {
  let loads = 0
  assert.equal(
    resolveElectronApp('', () => {
      loads++
      throw new Error('SDK loaded')
    }),
    null
  )
  assert.equal(loads, 0)
})

test('Electron diagnostics use its app API and tolerate non-app or failed loaders', () => {
  const app = { getAppPath: () => '/fixture' } as (typeof import('electron'))['app']
  const sdk = { app } as typeof import('electron')
  assert.equal(
    resolveElectronApp('43.5.0', () => sdk),
    app
  )
  assert.equal(
    resolveElectronApp('43.5.0', () => '/electron.exe'),
    null
  )
  assert.equal(
    resolveElectronApp('43.5.0', () => {
      throw new Error('unavailable')
    }),
    null
  )
})
test.beforeEach(() =>
  Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'win32' })
)
test.afterEach(() => Object.defineProperty(process, 'platform', hostPlatform))

function readPreloadSources(): string {
  const root = new URL('../preload/', import.meta.url)
  return [
    'index.ts',
    'types.ts',
    'index.d.ts',
    'sleepTimerEvents.ts',
    'domains/dataApi.ts',
    'domains/audioEngineApi.ts',
    'domains/desktopLyricsApi.ts',
    'domains/libraryApi.ts',
    'domains/mediaSubscriptionsApi.ts',
    'domains/networkSourcesApi.ts',
    'domains/settingsApi.ts',
    'domains/themesApi.ts',
    'domains/pluginsApi.ts',
    'domains/systemApi.ts',
    'domains/versionedData.ts'
  ]
    .map((rel) => readFileSync(new URL(rel, root), 'utf8'))
    .join('\n')
}

import type {
  AudioEngineServiceNativeBinding,
  AudioDeviceOption,
  AudioEngineManagerDependencies,
  AudioEngineQueueItem,
  ConvolverInfo,
  LatencyInfo,
  NativeAudioBinding,
  OutputConfig,
  OutputDiagnostics,
  OutputInfo,
  PlaybackInfo,
  PlayMode,
  AudioProcessingSettings,
  VolumeNormalizationMode
} from './audioEngineManager'

const {
  AudioEngineManager,
  DEFAULT_AUDIO_PROCESSING,
  createPlaybackInfoFanoutSignature,
  mapSpectrumToVisualizerBars,
  normalizeAudioProcessingSettings
} = (await import(
  new URL('./audioEngineManager.ts', import.meta.url).href
)) as typeof import('./audioEngineManager')

const DEVICE_OPTIONS: AudioDeviceOption[] = [
  {
    id: 'auto',
    label: 'System Default',
    name: 'System Default',
    isDefault: true,
    supportsExclusive: true,
    pathKind: 'default'
  },
  {
    id: 'dac-1',
    label: 'Desk DAC',
    name: 'Desk DAC',
    isDefault: false,
    supportsExclusive: true,
    pathKind: 'default'
  },
  {
    id: 'asio:studio',
    label: 'Studio ASIO',
    name: 'Studio ASIO',
    backend: 'asio',
    isDefault: false,
    supportsExclusive: true,
    pathKind: 'asio',
    minBufferSize: 64,
    maxBufferSize: 2048,
    granularity: 64,
    preferredBufferSize: 256,
    supportsDop: true,
    supportsNativeDsd: true,
    supportedDsdRates: [64],
    nativeDsdSampleRates: [2822400, 5644800, 11289600],
    nativeDsdSampleFormats: ['dsd-int8-msb1'],
    dopCarrierSampleRates: [176400],
    dopCarrierFormats: ['int24-in32'],
    capabilityVersion: 3
  }
]

const TEST_SCHEDULER: AudioEngineManagerDependencies['scheduler'] = {
  now: () => 1000,
  setInterval: () => ({}) as NodeJS.Timeout,
  clearInterval: () => {},
  setImmediate: (callback) => callback()
}

function makeLatencyInfo(
  bufferLatencyMs = 0,
  outputLatencyMs = 0,
  totalLatencyMs = bufferLatencyMs + outputLatencyMs
): LatencyInfo {
  return {
    bufferLatencyMs,
    outputLatencyMs,
    totalLatencyMs
  }
}

function makeDiagnostics(overrides: Partial<OutputDiagnostics> = {}): OutputDiagnostics {
  return {
    sessionUnderrunCount: 0,
    sessionBufferDropCount: 0,
    sessionRecoveryCount: 0,
    lifetimeUnderrunCount: 0,
    lifetimeBufferDropCount: 0,
    lifetimeRecoveryCount: 0,
    driverRestartCount: 0,
    deviceLostCount: 0,
    lastError: '',
    ...overrides
  }
}

function makeOutputInfo(overrides: Partial<OutputInfo> = {}): OutputInfo {
  return {
    exclusive: false,
    supportsOutputPerfect: false,
    sourceExact: false,
    outputPerfect: false,
    pcmPassthrough: false,
    resampled: false,
    providerImplementation: 'legacy-native',
    conversionInfo: {
      sampleFormatConverted: false,
      sampleRateConverted: false,
      channelLayoutConverted: false,
      source: 'unavailable'
    },
    perfectReason: '共享输出经过系统混音',
    outputSampleRate: 48000,
    outputBitDepth: 32,
    outputChannels: 2,
    backend: 'wasapi',
    actualBackend: 'wasapi',
    deviceName: 'System Default',
    actualDeviceName: 'System Default',
    driverName: '',
    actualDriverName: '',
    driverVersion: 0,
    actualDriverVersion: 0,
    actualOutputFormat: 'float32',
    actualSampleRate: 48000,
    actualBitDepth: 32,
    actualChannels: 2,
    accessMode: 'shared',
    devicePathKind: 'default',
    perfectReasonCode: 'shared_mixer',
    capabilityReason: '共享输出经过系统混音',
    driverDopCapable: false,
    driverNativeDsdCapable: false,
    driverDopCarrierSampleRates: [],
    driverDopCarrierFormats: [],
    driverNativeDsdSampleRates: [],
    nativeDsdRuntimeState: 'unsupported',
    nativeDsdRequestedRate: 0,
    nativeDsdActualRate: 0,
    nativeDsdChannels: 0,
    nativeDsdExplicitlyCapable: false,
    nativeDsdAdvertisedSampleRates: [],
    nativeDsdRuntimeReason: '',
    bufferSizeFrames: 480,
    latencyFrames: 480,
    latencyMs: 10,
    latencyInfo: makeLatencyInfo(10, 0, 10),
    channelRoutingMode: 'auto',
    diagnostics: makeDiagnostics(),
    deviceRecovered: false,
    recoveryCount: 0,
    isDsd: false,
    dsdMode: 'pcm',
    dsdRate: 0,
    actualDsdRate: 0,
    dsdRatePolicy: 'pcm-fallback',
    dsdConversion: 'exact',
    dsdConversionReason: '',
    ...overrides
  }
}

function makePlaybackInfo(overrides: Partial<PlaybackInfo> = {}): PlaybackInfo {
  const outputInfo = makeOutputInfo(overrides.outputInfo)
  return {
    state: 'stopped',
    position: 0,
    duration: 0,
    volume: 1,
    playbackRate: 1,
    requestedConfigRevision: 0,
    appliedConfigRevision: 0,
    queueIndex: -1,
    playMode: 'sequential',
    source: '',
    codec: 'flac',
    bitrate: 0,
    sourceSampleRate: 48000,
    sourceBitDepth: 24,
    decodedSampleRate: 48000,
    decodedBitDepth: 32,
    decodedChannels: 2,
    decodedSampleFormat: 'float32',
    outputBackend: outputInfo.backend,
    outputDevice: outputInfo.deviceName,
    actualBackend: outputInfo.actualBackend,
    driverName: outputInfo.driverName,
    driverVersion: outputInfo.driverVersion,
    actualOutputFormat: outputInfo.actualOutputFormat,
    actualSampleRate: outputInfo.actualSampleRate,
    actualBitDepth: outputInfo.actualBitDepth,
    actualChannels: outputInfo.actualChannels,
    bufferSizeFrames: outputInfo.bufferSizeFrames,
    latencyFrames: outputInfo.latencyFrames,
    latencyMs: outputInfo.latencyMs,
    latencyInfo: outputInfo.latencyInfo,
    channelRoutingMode: outputInfo.channelRoutingMode,
    supportsOutputPerfect: outputInfo.supportsOutputPerfect,
    sourceExact: outputInfo.sourceExact,
    diagnostics: outputInfo.diagnostics,
    deviceRecovered: outputInfo.deviceRecovered,
    recoveryCount: outputInfo.recoveryCount,
    outputSampleRate: outputInfo.outputSampleRate,
    outputBitDepth: outputInfo.outputBitDepth,
    channelCount: outputInfo.actualChannels,
    outputPerfect: outputInfo.outputPerfect,
    pcmPassthrough: outputInfo.pcmPassthrough,
    dspActive: false,
    replayGainActive: false,
    eqActive: false,
    convolverActive: false,
    crossfeedActive: false,
    crossfadeActive: false,
    fftActive: false,
    irResampled: false,
    replayGainDb: 0,
    crossfeedStrength: 0,
    crossfadeSeconds: 0,
    convolverLatencyFrames: 0,
    partitionSize: 0,
    channelMappingMode: '',
    perfectReason: outputInfo.perfectReason,
    perfectReasonCode: outputInfo.perfectReasonCode,
    isDsd: outputInfo.isDsd,
    dsdMode: outputInfo.dsdMode,
    dsdRate: outputInfo.dsdRate,
    actualDsdRate: outputInfo.actualDsdRate,
    dsdRatePolicy: outputInfo.dsdRatePolicy,
    dsdConversion: outputInfo.dsdConversion,
    dsdConversionReason: outputInfo.dsdConversionReason,
    gaplessActive: false,
    preloadReady: false,
    gaplessBlockedReason: '',
    upcomingTrack: null,
    nativePlaybackActive: false,
    ...overrides,
    outputInfo
  }
}

function assertPlaybackMirrorsOutputInfo(info: PlaybackInfo): void {
  assert.equal(info.outputBackend, info.outputInfo.backend)
  assert.equal(info.outputDevice, info.outputInfo.deviceName)
  assert.equal(info.actualBackend, info.outputInfo.actualBackend)
  assert.equal(info.actualOutputFormat, info.outputInfo.actualOutputFormat)
  assert.equal(info.actualSampleRate, info.outputInfo.actualSampleRate)
  assert.equal(info.actualBitDepth, info.outputInfo.actualBitDepth)
  assert.equal(info.actualChannels, info.outputInfo.actualChannels)
  assert.equal(info.bufferSizeFrames, info.outputInfo.bufferSizeFrames)
  assert.equal(info.latencyFrames, info.outputInfo.latencyFrames)
  assert.equal(info.latencyMs, info.outputInfo.latencyMs)
  assert.deepEqual(info.latencyInfo, info.outputInfo.latencyInfo)
  assert.equal(info.channelRoutingMode, info.outputInfo.channelRoutingMode)
  assert.equal(info.supportsOutputPerfect, info.outputInfo.supportsOutputPerfect)
  assert.equal(info.sourceExact, info.outputInfo.sourceExact)
  assert.deepEqual(info.diagnostics, info.outputInfo.diagnostics)
  assert.equal(info.deviceRecovered, info.outputInfo.deviceRecovered)
  assert.equal(info.recoveryCount, info.outputInfo.recoveryCount)
  assert.equal(info.outputSampleRate, info.outputInfo.outputSampleRate)
  assert.equal(info.outputBitDepth, info.outputInfo.outputBitDepth)
  assert.equal(info.outputPerfect, info.outputInfo.outputPerfect)
  assert.equal(info.pcmPassthrough, info.outputInfo.pcmPassthrough)
  assert.equal(info.perfectReason, info.outputInfo.perfectReason)
  assert.equal(info.outputInfo.conversionInfo.sampleRateConverted, info.outputInfo.resampled)
  assert.equal(info.perfectReasonCode, info.outputInfo.perfectReasonCode)
  assert.equal(info.isDsd, info.outputInfo.isDsd)
  assert.equal(info.dsdMode, info.outputInfo.dsdMode)
  assert.equal(info.dsdRate, info.outputInfo.dsdRate)
}

test('playback fanout signature changes when config revisions advance', () => {
  const base = makePlaybackInfo() as PlaybackInfo & {
    requestedConfigRevision: number
    appliedConfigRevision: number
  }
  base.requestedConfigRevision = 0
  base.appliedConfigRevision = 0
  const requested = { ...base, requestedConfigRevision: 1 }
  const applied = { ...requested, appliedConfigRevision: 1 }

  assert.notEqual(
    createPlaybackInfoFanoutSignature(base, true),
    createPlaybackInfoFanoutSignature(requested, true)
  )
  assert.notEqual(
    createPlaybackInfoFanoutSignature(requested, true),
    createPlaybackInfoFanoutSignature(applied, true)
  )
})

test('playback fanout signature publishes canonical output-perfect transitions', () => {
  const before = makePlaybackInfo({
    state: 'playing',
    source: 'pcm-192k.flac',
    sourceSampleRate: 192000,
    decodedSampleRate: 192000,
    outputInfo: makeOutputInfo({
      supportsOutputPerfect: true,
      sourceExact: false,
      pcmPassthrough: false,
      outputPerfect: false,
      outputSampleRate: 192000,
      actualSampleRate: 192000
    })
  })
  const afterOutputInfo = makeOutputInfo({
    ...before.outputInfo,
    supportsOutputPerfect: true,
    sourceExact: true,
    pcmPassthrough: true,
    outputPerfect: true,
    outputSampleRate: 192000,
    actualSampleRate: 192000,
    perfectReason: '',
    perfectReasonCode: ''
  })
  const after = makePlaybackInfo({
    ...before,
    sourceExact: true,
    pcmPassthrough: true,
    outputPerfect: true,
    perfectReason: '',
    perfectReasonCode: '',
    outputInfo: afterOutputInfo
  })

  assertPlaybackMirrorsOutputInfo(after)
  assert.equal(after.sourceExact, true)
  assert.equal(after.pcmPassthrough, true)
  assert.equal(after.outputPerfect, true)
  assert.notEqual(
    createPlaybackInfoFanoutSignature(before, true),
    createPlaybackInfoFanoutSignature(after, true)
  )
})

test('playback fanout signature ignores native tick position changes', () => {
  const info = makePlaybackInfo({
    state: 'playing',
    position: 12.5,
    duration: 240,
    queueIndex: 0,
    source: 'track.flac',
    nativePlaybackActive: true
  })
  const positionOnlyTick: PlaybackInfo = {
    ...info,
    position: 13
  }

  assert.equal(
    createPlaybackInfoFanoutSignature(info, true),
    createPlaybackInfoFanoutSignature(positionOnlyTick, true)
  )
})

test('playback fanout signature changes for non-position playback facts', () => {
  const info = makePlaybackInfo({
    state: 'playing',
    position: 12.5,
    duration: 240,
    queueIndex: 0,
    source: 'track.flac',
    dspActive: false,
    nativePlaybackActive: true,
    outputInfo: makeOutputInfo({
      actualBackend: 'wasapi',
      perfectReasonCode: 'shared_mixer',
      nativeDsp: {
        plugins: [
          {
            id: 'com.example.eq',
            active: true,
            bypassed: false,
            lastError: ''
          }
        ]
      }
    })
  })
  const base = createPlaybackInfoFanoutSignature(info, true)
  const cases: Array<[string, PlaybackInfo, boolean]> = [
    ['state', { ...info, state: 'paused' }, true],
    ['duration', { ...info, duration: 241 }, true],
    ['queueIndex', { ...info, queueIndex: 1 }, true],
    ['source', { ...info, source: 'other.flac' }, true],
    [
      'actualBackend',
      {
        ...info,
        actualBackend: 'asio',
        outputInfo: { ...info.outputInfo, actualBackend: 'asio' }
      },
      true
    ],
    [
      'actualDeviceId',
      {
        ...info,
        outputInfo: { ...info.outputInfo, actualDeviceId: 'endpoint-b' }
      },
      true
    ],
    [
      'outputSampleFormat',
      {
        ...info,
        outputInfo: { ...info.outputInfo, outputSampleFormat: 'float32' }
      },
      true
    ],
    [
      'outputChannels',
      {
        ...info,
        outputInfo: { ...info.outputInfo, outputChannels: 6 }
      },
      true
    ],
    [
      'perfectReasonCode',
      {
        ...info,
        perfectReasonCode: 'native_dsp_active',
        outputInfo: { ...info.outputInfo, perfectReasonCode: 'native_dsp_active' }
      },
      true
    ],
    [
      'dsdMode',
      {
        ...info,
        isDsd: true,
        dsdMode: 'dop',
        outputInfo: { ...info.outputInfo, isDsd: true, dsdMode: 'dop' }
      },
      true
    ],
    ['dspActive', { ...info, dspActive: true }, true],
    [
      'diagnostics',
      {
        ...info,
        recoveryCount: 1,
        diagnostics: { ...info.diagnostics, lastError: 'driver restart' },
        outputInfo: {
          ...info.outputInfo,
          recoveryCount: 1,
          diagnostics: { ...info.outputInfo.diagnostics, lastError: 'driver restart' }
        }
      },
      true
    ],
    [
      'nativeDspStatus',
      {
        ...info,
        outputInfo: {
          ...info.outputInfo,
          nativeDsp: {
            plugins: [
              {
                id: 'com.example.eq',
                active: false,
                bypassed: true,
                bypassReason: 'process exceeded realtime budget',
                lastError: 'process exceeded realtime budget'
              }
            ]
          }
        }
      },
      true
    ],
    [
      'providerConversionFacts',
      {
        ...info,
        outputInfo: {
          ...info.outputInfo,
          providerImplementation: 'miniaudio',
          conversionInfo: {
            sampleFormatConverted: true,
            sampleRateConverted: false,
            channelLayoutConverted: false,
            source: 'backend-runtime'
          }
        }
      },
      true
    ],
    ['nativePlaybackActive', info, false]
  ]

  for (const [label, changedInfo, nativePlaybackActive] of cases) {
    assert.notEqual(
      createPlaybackInfoFanoutSignature(changedInfo, nativePlaybackActive),
      base,
      label
    )
  }
})

function makeDspGraphStatus(payload: Record<string, unknown> | null): DspGraphStatus {
  const graph =
    payload?.graph && typeof payload.graph === 'object' && !Array.isArray(payload.graph)
      ? (payload.graph as Record<string, unknown>)
      : {}
  const nodes: DspGraphStatus['nodes'] = Array.isArray(graph.nodes)
    ? (graph.nodes as Array<Record<string, unknown>>).map((node) => ({
        id: String(node.id ?? ''),
        type: String(node.type ?? '') as DspGraphStatus['nodes'][number]['type'],
        enabled: node.enabled !== false,
        active: node.enabled !== false,
        bypassed: node.enabled === false,
        bypassReason: node.enabled === false ? 'disabled' : '',
        latencyFrames: 0,
        tailFrames: 0,
        processCalls: 0,
        lastProcessMs: 0,
        maxProcessMs: 0
      }))
    : []
  const outputStage =
    graph.outputStage && typeof graph.outputStage === 'object' && !Array.isArray(graph.outputStage)
      ? (graph.outputStage as Record<string, unknown>)
      : {}
  const requestedRate = outputStage.targetSampleRate
  const targetSampleRate = typeof requestedRate === 'number' ? requestedRate : null
  return {
    revision: Number(payload?.revision ?? 0),
    activeSceneId: typeof payload?.sceneId === 'string' ? payload.sceneId : null,
    totalLatencyFrames: 0,
    totalTailFrames: 0,
    nodes,
    compileState: 'ready',
    outputStage: {
      targetSampleRate,
      actualSampleRate: targetSampleRate ?? 48000,
      resamplerQuality:
        outputStage.resamplerQuality === 'high' || outputStage.resamplerQuality === 'ultra'
          ? outputStage.resamplerQuality
          : 'native',
      dither:
        outputStage.dither === 'tpdf' ||
        outputStage.dither === 'highpassTpdf' ||
        outputStage.dither === 'noiseShaped'
          ? outputStage.dither
          : 'off',
      active: targetSampleRate !== null,
      reason: ''
    }
  }
}

function getDspGraphPayloadGraph(
  payload: Record<string, unknown> | null
): { nodes?: Array<{ type?: string; params?: Record<string, unknown> }> } | null {
  const graph = payload?.graph
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null
  return graph as { nodes?: Array<{ type?: string; params?: Record<string, unknown> }> }
}

class FakeNativeBinding implements NativeAudioBinding {
  playbackInfo: PlaybackInfo
  devices: AudioDeviceOption[]
  lastOutputConfig: OutputConfig = { preferredBufferSize: 0, routingMode: 'auto' }
  lastDspConfig: Partial<AudioProcessingSettings> = {}
  lastDspGraphPayload: Record<string, unknown> | null = null
  lastEqConfig: Partial<AudioProcessingSettings> = {}
  lastEqPresetConfig: Partial<AudioProcessingSettings> = {}
  lastReplayGainConfig: {
    mode: VolumeNormalizationMode
    preamp: number
    fallback: number
    clip: boolean
  } | null = null
  lastCrossfeedStrength = 0
  loadedImpulseResponsePath = ''
  nativeDspPluginChainJson = ''
  lastLoadedQueue: AudioEngineQueueItem[] = []
  lastLoadedQueueIndex = -1
  failAsioPlayWith = ''
  lastErrorMessage = ''
  nextLeavesStopped = false
  nextTargetIndex: number | null = null
  previousTargetIndex: number | null = null
  nextCalls = 0
  previousCalls = 0
  playbackInfoReads = 0
  spectrumReads = 0
  visualizationReads = 0
  volumeCalls = 0
  playModeCalls = 0
  metadataReads = 0
  upcomingTrackReads = 0
  outputConfigCalls = 0
  outputDeviceCalls = 0
  outputBackendCalls = 0
  preservePlaybackRouteOnSet = false
  failNextOutputBackend = ''
  failNextOutputDevice = ''
  failNextOutputConfig = ''
  failRollbackOutputBackend = ''
  failRollbackOutputDevice = ''
  failRollbackOutputConfig = ''
  routeCalls: Array<{ method: string; value: string }> = []
  failOutputDeviceValues = new Set<string>()
  actualDeviceIdOverride = ''
  autoDeviceUsesPhysicalDefault = false
  inRollback = false
  loadQueueCalls = 0
  stopCalls = 0
  seekCalls = 0
  enumerateDeviceCalls = 0
  dspConfigCalls = 0
  dspGraphCalls = 0
  eqBandsCalls = 0
  eqPresetCalls = 0
  replayGainCalls = 0
  crossfeedCalls = 0
  loadImpulseResponseCalls = 0
  unloadImpulseResponseCalls = 0
  nativeDspPluginChainCalls = 0
  nativeDspPluginStatusReads = 0
  convolverInfoReads = 0
  playCalls: Array<{ backend: string; device: string; source: string; startTime: number }> = []

  constructor(playbackInfo?: Partial<PlaybackInfo>, devices = DEVICE_OPTIONS) {
    this.devices = devices
    this.playbackInfo = makePlaybackInfo(playbackInfo)
  }

  Play = (source: string, startTime = 0): void => {
    const backend = this.playbackInfo.outputInfo.actualBackend
    const device = this.playbackInfo.outputInfo.deviceName
    this.playCalls.push({ backend, device, source, startTime })
    if (backend === 'asio' && this.failAsioPlayWith) {
      this.lastErrorMessage = this.failAsioPlayWith
      throw new Error(this.failAsioPlayWith)
    }
    this.lastErrorMessage = ''
    const queued = this.lastLoadedQueue[this.playbackInfo.queueIndex]
    this.playbackInfo = {
      ...this.playbackInfo,
      state: 'playing',
      source,
      position: startTime,
      duration:
        queued?.source === source && Number.isFinite(queued.duration)
          ? Number(queued.duration)
          : this.playbackInfo.duration,
      nativePlaybackActive: true
    }
  }

  Pause = (): void => {
    this.playbackInfo = {
      ...this.playbackInfo,
      state: this.playbackInfo.state === 'paused' ? 'playing' : 'paused'
    }
  }

  Stop = (): void => {
    this.stopCalls += 1
    this.playbackInfo = {
      ...this.playbackInfo,
      state: 'stopped',
      position: 0,
      nativePlaybackActive: false
    }
  }

  Seek = (time: number): void => {
    this.seekCalls += 1
    this.playbackInfo = {
      ...this.playbackInfo,
      position: time
    }
  }

  SetVolume = (volume: number): void => {
    this.volumeCalls += 1
    this.playbackInfo = {
      ...this.playbackInfo,
      volume
    }
  }

  SetPlaybackRate = (rate: number): void => {
    this.playbackInfo = {
      ...this.playbackInfo,
      playbackRate: rate
    }
  }

  SetOutputDevice = (device: string): void => {
    this.outputDeviceCalls += 1
    this.routeCalls.push({ method: 'SetOutputDevice', value: device })
    const failure = this.inRollback ? this.failRollbackOutputDevice : this.failNextOutputDevice
    if (failure || this.failOutputDeviceValues.has(device)) {
      if (this.inRollback) this.failRollbackOutputDevice = ''
      else this.failNextOutputDevice = ''
      const message = failure || `device ${device} unavailable`
      this.lastErrorMessage = message
      throw new Error(message)
    }
    const currentBackend = this.playbackInfo.outputInfo.actualBackend
    const nextDevice =
      device === 'auto' && currentBackend !== 'asio' && this.autoDeviceUsesPhysicalDefault
        ? (this.devices.find((entry) => entry.id !== 'auto' && entry.isDefault) ?? this.devices[0])
        : device === 'auto' && currentBackend === 'asio'
          ? (this.devices.find((entry) => entry.pathKind === 'asio') ?? this.devices[0])
          : (this.devices.find((entry) => entry.id === device) ?? this.devices[0])
    const deviceName = nextDevice.name || nextDevice.label
    const devicePathKind =
      currentBackend === 'coreaudio' || currentBackend === 'coreaudio-exclusive'
        ? 'hal'
        : nextDevice.pathKind || this.playbackInfo.outputInfo.devicePathKind
    const outputInfo = {
      ...this.playbackInfo.outputInfo,
      deviceName: device,
      actualDeviceName: deviceName,
      actualDeviceId: this.actualDeviceIdOverride || nextDevice.platformStableId || nextDevice.id,
      devicePathKind
    }
    this.playbackInfo = this.withOutputInfo(outputInfo, {
      outputDevice: device
    })
  }

  SetOutputBackend = (backend: string): void => {
    this.outputBackendCalls += 1
    this.routeCalls.push({ method: 'SetOutputBackend', value: backend })
    const failure = this.inRollback ? this.failRollbackOutputBackend : this.failNextOutputBackend
    if (failure) {
      if (this.inRollback) this.failRollbackOutputBackend = ''
      else this.failNextOutputBackend = ''
      this.lastErrorMessage = failure
      throw new Error(failure)
    }
    if (this.preservePlaybackRouteOnSet) return
    const exclusive =
      backend === 'asio' || backend === 'wasapi-exclusive' || backend === 'coreaudio-exclusive'
    const accessMode = backend === 'wasapi' || backend === 'coreaudio' ? 'shared' : 'exclusive'
    const devicePathKind =
      backend === 'asio'
        ? 'asio'
        : backend === 'coreaudio' || backend === 'coreaudio-exclusive'
          ? 'hal'
          : 'default'
    const supportsOutputPerfect =
      backend === 'asio' || backend === 'wasapi-exclusive' || backend === 'coreaudio-exclusive'
    const perfectReasonCode = backend === 'wasapi' || backend === 'coreaudio' ? 'shared_mixer' : ''
    const perfectReason =
      backend === 'wasapi' || backend === 'coreaudio' ? '共享输出经过系统混音' : ''
    const capabilityReason = perfectReason
    const outputInfo = {
      ...this.playbackInfo.outputInfo,
      exclusive,
      accessMode,
      backend,
      actualBackend: backend,
      devicePathKind,
      deviceName: backend === 'asio' ? 'asio:studio' : 'auto',
      actualDeviceName: backend === 'asio' ? 'Studio ASIO' : 'System Default',
      supportsOutputPerfect,
      perfectReasonCode,
      perfectReason,
      capabilityReason,
      outputPerfect: false,
      sourceExact: false,
      pcmPassthrough: false
    }
    this.playbackInfo = this.withOutputInfo(outputInfo, {
      outputBackend: backend,
      outputDevice: outputInfo.deviceName,
      actualBackend: backend
    })
  }

  SetOutputConfig = (json: string): void => {
    this.outputConfigCalls += 1
    this.routeCalls.push({ method: 'SetOutputConfig', value: json })
    const failure = this.inRollback ? this.failRollbackOutputConfig : this.failNextOutputConfig
    if (failure) {
      if (this.inRollback) this.failRollbackOutputConfig = ''
      else this.failNextOutputConfig = ''
      this.lastErrorMessage = failure
      throw new Error(failure)
    }
    const parsed = JSON.parse(json) as Partial<OutputConfig>
    this.lastOutputConfig = {
      preferredBufferSize:
        typeof parsed.preferredBufferSize === 'number'
          ? parsed.preferredBufferSize
          : this.lastOutputConfig.preferredBufferSize,
      routingMode:
        typeof parsed.routingMode === 'string'
          ? parsed.routingMode
          : this.lastOutputConfig.routingMode,
      wasapiExclusivePushMode:
        parsed.wasapiExclusivePushMode ?? this.lastOutputConfig.wasapiExclusivePushMode,
      pcmToDsdMode: parsed.pcmToDsdMode ?? this.lastOutputConfig.pcmToDsdMode,
      upmixCenterGain: parsed.upmixCenterGain ?? this.lastOutputConfig.upmixCenterGain,
      upmixLfeGain: parsed.upmixLfeGain ?? this.lastOutputConfig.upmixLfeGain,
      upmixLfeLowpassHz: parsed.upmixLfeLowpassHz ?? this.lastOutputConfig.upmixLfeLowpassHz,
      upmixSurroundGain: parsed.upmixSurroundGain ?? this.lastOutputConfig.upmixSurroundGain,
      upmixSideGain: parsed.upmixSideGain ?? this.lastOutputConfig.upmixSideGain,
      upmixSurroundDelayMs:
        parsed.upmixSurroundDelayMs ?? this.lastOutputConfig.upmixSurroundDelayMs
    }
    const actualBufferSize =
      this.playbackInfo.outputInfo.actualBackend === 'asio'
        ? this.resolveAsioBufferSize(this.lastOutputConfig.preferredBufferSize)
        : this.playbackInfo.outputInfo.actualBackend === 'wasapi-exclusive'
          ? this.resolveExclusiveBufferSize(this.lastOutputConfig.preferredBufferSize)
          : this.resolveSharedBufferSize(this.lastOutputConfig.preferredBufferSize)
    const sampleRate = this.playbackInfo.outputInfo.actualSampleRate || 48000
    const bufferLatencyMs = actualBufferSize > 0 ? (actualBufferSize * 1000) / sampleRate : 0
    const driverLatencyMs = this.playbackInfo.outputInfo.actualBackend === 'asio' ? 2 : 1
    const perfectReasonCode =
      this.lastOutputConfig.routingMode && this.lastOutputConfig.routingMode !== 'auto'
        ? 'routing_changes_semantics'
        : this.playbackInfo.outputInfo.actualBackend === 'wasapi' ||
            this.playbackInfo.outputInfo.actualBackend === 'coreaudio'
          ? 'shared_mixer'
          : ''
    const perfectReason =
      perfectReasonCode === 'routing_changes_semantics'
        ? '声道映射改变声道语义'
        : this.playbackInfo.outputInfo.actualBackend === 'wasapi' ||
            this.playbackInfo.outputInfo.actualBackend === 'coreaudio'
          ? '共享输出经过系统混音'
          : ''
    const outputInfo = {
      ...this.playbackInfo.outputInfo,
      bufferSizeFrames: actualBufferSize,
      latencyFrames: actualBufferSize,
      latencyMs: bufferLatencyMs + driverLatencyMs,
      latencyInfo: makeLatencyInfo(
        bufferLatencyMs,
        driverLatencyMs,
        bufferLatencyMs + driverLatencyMs
      ),
      channelRoutingMode: this.lastOutputConfig.routingMode,
      perfectReasonCode,
      perfectReason,
      capabilityReason: perfectReason
    }
    this.playbackInfo = this.withOutputInfo(outputInfo, {
      channelRoutingMode: outputInfo.channelRoutingMode
    })
  }

  LoadQueue = (queueJson: string, startIndex: number): void => {
    this.loadQueueCalls += 1
    const queue = JSON.parse(queueJson) as AudioEngineQueueItem[]
    this.lastLoadedQueue = queue
    this.lastLoadedQueueIndex = startIndex
    this.playbackInfo = {
      ...this.playbackInfo,
      queueIndex: queue.length > 0 ? Math.min(Math.max(0, startIndex), queue.length - 1) : -1
    }
  }
  Next = (): void => {
    this.nextCalls += 1
    if (this.nextTargetIndex !== null) {
      const target = this.lastLoadedQueue[this.nextTargetIndex]
      this.playbackInfo = {
        ...this.playbackInfo,
        state: 'playing',
        queueIndex: this.nextTargetIndex,
        source: target?.source ?? this.playbackInfo.source,
        position: 0
      }
      return
    }
    if (this.nextLeavesStopped) {
      this.playbackInfo = {
        ...this.playbackInfo,
        state: 'stopped',
        queueIndex: this.playbackInfo.queueIndex + 1
      }
    }
  }
  Previous = (): void => {
    this.previousCalls += 1
    if (this.previousTargetIndex === null) return
    const target = this.lastLoadedQueue[this.previousTargetIndex]
    this.playbackInfo = {
      ...this.playbackInfo,
      state: 'playing',
      queueIndex: this.previousTargetIndex,
      source: target?.source ?? this.playbackInfo.source,
      position: 0
    }
  }
  SetPlayMode = (mode: PlayMode): void => {
    this.playModeCalls += 1
    this.playbackInfo = {
      ...this.playbackInfo,
      playMode: mode
    }
  }

  SetDspConfig = (json: string): void => {
    this.dspConfigCalls += 1
    this.lastDspConfig = JSON.parse(json) as Partial<AudioProcessingSettings>
  }
  SetDspGraph = (json: string): void => {
    this.dspGraphCalls += 1
    this.lastDspGraphPayload = JSON.parse(json) as Record<string, unknown>
  }
  ApplyDspState = (_revision: number, json: string): void => {
    const payload = JSON.parse(json) as DspStatePayload
    this.dspConfigCalls += 1
    this.dspGraphCalls += 1
    this.lastDspConfig = payload.processing as Partial<AudioProcessingSettings>
    this.lastDspGraphPayload = payload as unknown as Record<string, unknown>
    this.loadedImpulseResponsePath =
      typeof payload.processing.convolverIrPath === 'string'
        ? payload.processing.convolverIrPath
        : ''
  }
  GetDspGraphStatus = (): string => JSON.stringify(makeDspGraphStatus(this.lastDspGraphPayload))
  LoadImpulseResponse = (path: string): void => {
    this.loadImpulseResponseCalls += 1
    this.loadedImpulseResponsePath = path
  }
  UnloadImpulseResponse = (): void => {
    this.unloadImpulseResponseCalls += 1
    this.loadedImpulseResponsePath = ''
  }
  GetConvolverInfo = (): string => {
    this.convolverInfoReads += 1
    return JSON.stringify({ loaded: false, active: false, reads: this.convolverInfoReads })
  }
  SetEqBands = (json: string): void => {
    this.eqBandsCalls += 1
    this.lastEqConfig = JSON.parse(json) as Partial<AudioProcessingSettings>
  }
  SetEqPreset = (json: string): void => {
    this.eqPresetCalls += 1
    this.lastEqPresetConfig = JSON.parse(json) as Partial<AudioProcessingSettings>
  }
  SetCrossfeedStrength = (strength: number): void => {
    this.crossfeedCalls += 1
    this.lastCrossfeedStrength = strength
  }
  SetReplayGainMode = (
    mode: VolumeNormalizationMode,
    preamp: number,
    fallback: number,
    clip: boolean
  ): void => {
    this.replayGainCalls += 1
    this.lastReplayGainConfig = { mode, preamp, fallback, clip }
  }
  SetDspPluginChain = (json: string): void => {
    this.nativeDspPluginChainCalls += 1
    this.nativeDspPluginChainJson = json
  }
  GetMetadata = (source: string): string => {
    this.metadataReads += 1
    return JSON.stringify({
      source,
      title: `sync metadata ${this.metadataReads}`,
      error: ''
    })
  }
  GetDspPluginStatus = (): string => {
    this.nativeDspPluginStatusReads += 1
    return JSON.stringify({
      plugins: [{ id: 'com.example.eq', reads: this.nativeDspPluginStatusReads }]
    })
  }
  GetPlaybackInfo = (): string => {
    this.playbackInfoReads += 1
    return JSON.stringify(this.playbackInfo)
  }
  GetUpcomingTrack = (): AudioEngineQueueItem | null => {
    this.upcomingTrackReads += 1
    return {
      id: `upcoming-${this.upcomingTrackReads}`,
      source: `file:///upcoming-${this.upcomingTrackReads}.flac`,
      title: `Upcoming ${this.upcomingTrackReads}`
    }
  }
  GetSpectrumData = (points = 64): number[] => {
    this.spectrumReads += 1
    return Array.from({ length: points }, (_, index) => this.spectrumReads + index / 100)
  }
  GetVisualizationData = (optionsJson: string): string => {
    this.visualizationReads += 1
    const options = JSON.parse(optionsJson || '{}') as {
      spectrumPoints?: number
      waveformPoints?: number
      spectrogramFrames?: number
    }
    const spectrumPoints = options.spectrumPoints ?? 64
    const waveformPoints = options.waveformPoints ?? 128
    return JSON.stringify({
      spectrum: Array.from(
        { length: spectrumPoints },
        (_, index) => index / Math.max(1, spectrumPoints - 1)
      ),
      waveform: Array.from({ length: waveformPoints }, (_, index) => Math.sin(index / 8)),
      peakDb: -3,
      rmsDb: -12,
      lufsMomentary: -15,
      spectrogram: [
        Array.from({ length: spectrumPoints }, () => 0.25),
        Array.from({ length: spectrumPoints }, () => 0.5)
      ],
      sampleRate: 48000,
      active: true
    })
  }
  EnumerateDevices = (): string => {
    this.enumerateDeviceCalls += 1
    return JSON.stringify(this.devices)
  }
  EnumerateBackends = (): string =>
    JSON.stringify(['wasapi', 'wasapi-exclusive', 'asio', 'coreaudio', 'coreaudio-exclusive'])
  GetEngineCapabilities = (): string => JSON.stringify({})
  GetLastError = (): string => JSON.stringify({ message: this.lastErrorMessage })

  setDiagnostics(diagnostics: Partial<OutputDiagnostics>, extras: Partial<OutputInfo> = {}): void {
    const nextDiagnostics = {
      ...this.playbackInfo.outputInfo.diagnostics,
      ...diagnostics
    }
    const outputInfo = {
      ...this.playbackInfo.outputInfo,
      diagnostics: nextDiagnostics,
      deviceRecovered: extras.deviceRecovered ?? this.playbackInfo.outputInfo.deviceRecovered,
      recoveryCount: extras.recoveryCount ?? this.playbackInfo.outputInfo.recoveryCount,
      perfectReasonCode: extras.perfectReasonCode ?? this.playbackInfo.outputInfo.perfectReasonCode,
      perfectReason: extras.perfectReason ?? this.playbackInfo.outputInfo.perfectReason,
      capabilityReason: extras.capabilityReason ?? this.playbackInfo.outputInfo.capabilityReason
    }
    this.playbackInfo = this.withOutputInfo(outputInfo)
  }

  private resolveExclusiveBufferSize(requested: number): number {
    if (requested === 0) return 256
    if (requested === 512) return 448
    return requested
  }

  private resolveSharedBufferSize(requested: number): number {
    return requested > 0 ? requested : 480
  }

  private resolveAsioBufferSize(requested: number): number {
    if (requested === 0) return 256
    const clamped = Math.min(2048, Math.max(64, requested))
    return Math.floor(clamped / 64) * 64
  }

  private withOutputInfo(
    outputInfo: OutputInfo,
    overrides: Partial<PlaybackInfo> = {}
  ): PlaybackInfo {
    return {
      ...this.playbackInfo,
      ...overrides,
      outputBackend: overrides.outputBackend ?? outputInfo.backend,
      outputDevice: overrides.outputDevice ?? outputInfo.deviceName,
      actualBackend: overrides.actualBackend ?? outputInfo.actualBackend,
      actualOutputFormat: outputInfo.actualOutputFormat,
      actualSampleRate: outputInfo.actualSampleRate,
      actualBitDepth: outputInfo.actualBitDepth,
      actualChannels: outputInfo.actualChannels,
      bufferSizeFrames: outputInfo.bufferSizeFrames,
      latencyFrames: outputInfo.latencyFrames,
      latencyMs: outputInfo.latencyMs,
      latencyInfo: outputInfo.latencyInfo,
      channelRoutingMode: overrides.channelRoutingMode ?? outputInfo.channelRoutingMode,
      supportsOutputPerfect: outputInfo.supportsOutputPerfect,
      sourceExact: outputInfo.sourceExact,
      diagnostics: outputInfo.diagnostics,
      deviceRecovered: outputInfo.deviceRecovered,
      recoveryCount: outputInfo.recoveryCount,
      outputSampleRate: outputInfo.outputSampleRate,
      outputBitDepth: outputInfo.outputBitDepth,
      outputPerfect: outputInfo.outputPerfect,
      pcmPassthrough: outputInfo.pcmPassthrough,
      perfectReason: outputInfo.perfectReason,
      perfectReasonCode: outputInfo.perfectReasonCode,
      isDsd: outputInfo.isDsd,
      dsdMode: outputInfo.dsdMode,
      dsdRate: outputInfo.dsdRate,
      outputInfo
    }
  }
}

class FakeAudioServiceBinding extends EventEmitter implements AudioEngineServiceNativeBinding {
  stopped = false
  stopCalls = 0
  destroyCalls = 0
  volume = 1
  backend = 'wasapi'
  device = 'auto'
  outputConfig: Partial<OutputConfig> = {}
  dspConfig: Partial<AudioProcessingSettings> = {}
  lastDspGraphPayload: Record<string, unknown> | null = null
  dspPluginChain = ''
  eqBandsCalls = 0
  replayGainCalls = 0
  crossfeedCalls = 0
  metadataReads = 0
  queue: AudioEngineQueueItem[] = []
  queueIndex = -1
  playCalls = 0
  playAsyncError: Error | null = null
  callOrder: string[] = []
  playbackInfo = makePlaybackInfo({ state: 'playing', nativePlaybackActive: true })

  Play = (): void => {
    this.playCalls += 1
    this.playbackInfo = makePlaybackInfo({ state: 'playing', nativePlaybackActive: true })
  }
  Pause = (): void => {
    this.playbackInfo = { ...this.playbackInfo, state: 'paused' }
  }
  Stop = (): void => {
    this.stopCalls += 1
    this.stopped = true
    this.playbackInfo = { ...this.playbackInfo, state: 'stopped', nativePlaybackActive: false }
  }
  Seek = (): void => {}
  SetVolume = (volume: number): void => {
    this.volume = volume
  }
  SetPlaybackRate = (rate: number): void => {
    this.playbackInfo = {
      ...this.playbackInfo,
      playbackRate: rate
    }
  }
  SetOutputDevice = (device: string): void => {
    this.device = device
  }
  SetOutputBackend = (backend: string): void => {
    this.backend = backend
  }
  SetOutputConfig = (json: string): void => {
    this.outputConfig = JSON.parse(json) as Partial<OutputConfig>
    const routingMode =
      typeof this.outputConfig.routingMode === 'string'
        ? this.outputConfig.routingMode
        : this.playbackInfo.outputInfo.channelRoutingMode
    this.playbackInfo = {
      ...this.playbackInfo,
      channelRoutingMode: routingMode,
      outputInfo: {
        ...this.playbackInfo.outputInfo,
        channelRoutingMode: routingMode
      }
    }
  }
  LoadQueue = (queueJson: string, startIndex: number): void => {
    this.queue = JSON.parse(queueJson) as AudioEngineQueueItem[]
    this.queueIndex = startIndex
  }
  SetPlayMode = (_mode: PlayMode): void => {}
  SetDspConfig = (json: string): void => {
    this.dspConfig = JSON.parse(json) as Partial<AudioProcessingSettings>
  }
  SetDspGraph = (json: string): void => {
    this.lastDspGraphPayload = JSON.parse(json) as Record<string, unknown>
  }
  ApplyDspState = (_revision: number, json: string): void => {
    const payload = JSON.parse(json) as DspStatePayload
    this.dspConfig = payload.processing as Partial<AudioProcessingSettings>
    this.lastDspGraphPayload = payload as unknown as Record<string, unknown>
  }
  GetDspGraphStatus = (): string => JSON.stringify(makeDspGraphStatus(this.lastDspGraphPayload))
  async applyDspState(revision: number, payload: DspStatePayload): Promise<DspGraphStatus> {
    await this.callAsync('ApplyDspState', [revision, JSON.stringify(payload)])
    return JSON.parse(this.GetDspGraphStatus()) as DspGraphStatus
  }
  async applyDspGraph(json: string): Promise<DspGraphStatus> {
    const payload = JSON.parse(json) as DspStatePayload
    return this.applyDspState(payload.revision, payload)
  }
  async getDspGraphStatusAsync(): Promise<DspGraphStatus> {
    return JSON.parse(this.GetDspGraphStatus()) as DspGraphStatus
  }
  SetEqBands = (): void => {
    this.eqBandsCalls += 1
  }
  SetReplayGainMode = (): void => {
    this.replayGainCalls += 1
  }
  SetCrossfeedStrength = (): void => {
    this.crossfeedCalls += 1
  }
  SetDspPluginChain = (json: string): void => {
    this.dspPluginChain = json
  }
  GetMetadata = (): string => JSON.stringify({ title: 'sync fallback', error: '' })
  GetPlaybackInfo = (): string => JSON.stringify(this.playbackInfo)
  GetDspPluginStatus = (): string => JSON.stringify({ plugins: [] })
  GetLastError = (): string => JSON.stringify({ message: '' })
  async callAsync(method: string, args: unknown[]): Promise<unknown> {
    this.callOrder.push(method)
    if (method === 'Play' && this.playAsyncError) {
      throw this.playAsyncError
    }
    const target = this[method as keyof this]
    if (typeof target === 'function') {
      return (target as (...args: unknown[]) => unknown).apply(this, args)
    }
    return undefined
  }
  async getMetadataAsync(source: string): Promise<string> {
    this.metadataReads += 1
    return JSON.stringify({ source, title: `service metadata ${this.metadataReads}`, error: '' })
  }
  destroy(): void {
    this.destroyCalls += 1
    this.stopped = true
  }
}

class RejectingDspAudioServiceBinding extends FakeAudioServiceBinding {
  override async applyDspState(
    _revision: number,
    _payload: DspStatePayload
  ): Promise<DspGraphStatus> {
    throw new Error('native DSP graph rejected by service')
  }
}

class RouteFailingLateReadyAudioServiceBinding extends FakeAudioServiceBinding {
  ready = false
  volumeCalls = 0

  override SetVolume = (volume: number): void => {
    this.volumeCalls += 1
    this.volume = volume
  }

  override async callAsync(method: string, args: unknown[]): Promise<unknown> {
    // Before the service is up, every startup restore call is rejected (as the
    // real utility-process client does with "音频服务不可用"). After ready, the
    // output route keeps failing but SetVolume must still be applied.
    if (!this.ready) {
      if (
        method === 'SetOutputBackend' ||
        method === 'SetOutputDevice' ||
        method === 'SetOutputConfig' ||
        method === 'SetVolume'
      ) {
        throw new Error('audio service not ready')
      }
    } else if (
      method === 'SetOutputBackend' ||
      method === 'SetOutputDevice' ||
      method === 'SetOutputConfig'
    ) {
      throw new Error('output route restore failed persistently')
    }
    return await super.callAsync(method, args)
  }
}

class VolumeRestoreFailingAudioServiceBinding extends FakeAudioServiceBinding {
  volumeCalls = 0
  failVolumeRestore = true

  override SetVolume = (volume: number): void => {
    this.volumeCalls += 1
    this.volume = volume
  }

  override async callAsync(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'SetVolume' && this.failVolumeRestore) {
      throw new Error('volume restore rejected before service ready')
    }
    return await super.callAsync(method, args)
  }
}

class DeferredAudioServiceBinding extends FakeAudioServiceBinding {
  deferredMethods = new Set<string>()
  deferredCalls: Array<{
    method: string
    args: unknown[]
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }> = []

  constructor(deferredMethods: string[]) {
    super()
    this.deferredMethods = new Set(deferredMethods)
  }

  override async callAsync(method: string, args: unknown[]): Promise<unknown> {
    if (!this.deferredMethods.has(method)) {
      return await super.callAsync(method, args)
    }
    return await new Promise((resolve, reject) => {
      this.deferredCalls.push({ method, args, resolve, reject })
    })
  }

  resolveDeferredCalls(): void {
    while (this.deferredCalls.length > 0) {
      this.resolveNextDeferredCall()
    }
  }

  resolveNextDeferredCall(): void {
    const call = this.deferredCalls.shift()
    if (!call) return
    const target = this[call.method as keyof this]
    if (typeof target === 'function') {
      call.resolve((target as (...args: unknown[]) => unknown).apply(this, call.args))
    } else {
      call.resolve(undefined)
    }
  }

  rejectDeferredCalls(error: Error): void {
    while (this.deferredCalls.length > 0) {
      const call = this.deferredCalls.shift()
      if (!call) return
      call.reject(error)
    }
  }
}

class AsioFailingAudioServiceBinding extends DeferredAudioServiceBinding {
  directRouteCalls: Array<{ method: string; args: unknown[] }> = []
  private applyingDeferredRouteCall = false

  SetOutputDevice = (device: string): void => {
    if (!this.applyingDeferredRouteCall) {
      this.directRouteCalls.push({ method: 'SetOutputDevice', args: [device] })
      return
    }
    this.device = device
  }

  SetOutputBackend = (backend: string): void => {
    if (!this.applyingDeferredRouteCall) {
      this.directRouteCalls.push({ method: 'SetOutputBackend', args: [backend] })
      return
    }
    this.backend = backend
  }

  SetOutputConfig = (json: string): void => {
    if (!this.applyingDeferredRouteCall) {
      this.directRouteCalls.push({ method: 'SetOutputConfig', args: [json] })
      return
    }
    this.outputConfig = JSON.parse(json) as Partial<OutputConfig>
  }

  override async callAsync(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'Play' && this.backend === 'asio') {
      this.playCalls += 1
      throw new Error('asio backend failed')
    }
    return await super.callAsync(method, args)
  }

  override resolveNextDeferredCall(): void {
    this.applyingDeferredRouteCall = true
    try {
      super.resolveNextDeferredCall()
    } finally {
      this.applyingDeferredRouteCall = false
    }
  }
}

class DeferredNextAudioServiceBinding extends FakeAudioServiceBinding {
  nextCalls = 0
  private nextResolvers: Array<() => void> = []

  Next = (): void => {
    this.nextCalls += 1
  }

  override async callAsync(method: string, args: unknown[]): Promise<unknown> {
    if (method !== 'Next') return await super.callAsync(method, args)
    this.nextCalls += 1
    return await new Promise((resolve) => {
      this.nextResolvers.push(() => {
        this.queueIndex = Math.min(this.queueIndex + 1, this.queue.length - 1)
        const item = this.queue[this.queueIndex]
        this.playbackInfo = makePlaybackInfo({
          state: 'playing',
          source: item?.source ?? '',
          queueIndex: this.queueIndex,
          nativePlaybackActive: true
        })
        resolve(undefined)
      })
    })
  }

  resolveNext(): void {
    const resolve = this.nextResolvers.shift()
    if (resolve) resolve()
  }
}

async function resolveDeferredRouteCalls(service: DeferredAudioServiceBinding): Promise<void> {
  for (let index = 0; index < 3; ++index) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.resolveNextDeferredCall()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeManager(
  config: ConstructorParameters<typeof AudioEngineManager>[0],
  nativeBinding: FakeNativeBinding | FakeAudioServiceBinding,
  scheduler?: AudioEngineManagerDependencies['scheduler']
): InstanceType<typeof AudioEngineManager> {
  return new AudioEngineManager(config, {
    nativeBinding,
    scheduler: {
      ...TEST_SCHEDULER,
      ...scheduler
    },
    deviceOptionsProvider: () => DEVICE_OPTIONS
  })
}

test('group transition lease suspends local AutoMix and restores it without changing DSP preferences', async () => {
  const calls: unknown[][] = []
  class GroupBinding extends FakeAudioServiceBinding {
    override callAsync(method: string, args: unknown[]): Promise<unknown> {
      if (method === 'BridgeQueueControl' || method === 'BridgeAutoMixMode') { calls.push([method, ...args]); return Promise.resolve() }
      if (method === 'BridgeBindAutoMix') { calls.push([method, ...args]); return Promise.resolve('{"ok":true,"selectionId":51}') }
      return super.callAsync(method, args)
    }
  }
  const service = new GroupBinding()
  const manager = new AudioEngineManager({ exclusiveMode: false, audioProcessing: { gapless: false, crossfadeSeconds: 4 } },
    { audioServiceFactory: () => service, scheduler: TEST_SCHEDULER, deviceOptionsProvider: () => DEVICE_OPTIONS })
  const coordinator = { setMode: (mode: unknown) => calls.push(['mode', mode]), suspend: async () => { calls.push(['suspend']) },
    resume: () => { calls.push(['resume']) }, observe: () => {}, invalidate: (reason: string) => { calls.push(['invalidate', reason]) }, destroy: () => {} }
  try {
    await manager.start()
    manager.setAutoMixCoordinator(coordinator as unknown as Parameters<typeof manager.setAutoMixCoordinator>[0])
    const before = structuredClone(manager.getAudioProcessing())
    await assert.rejects(manager.bindBridgeAutoMixSelection('{}'), /group_ownership_required/)
    await assert.rejects(manager.setBridgeAutoMixMode('natural'), /group_ownership_required/)
    await manager.acquireGroupPlayback()
    assert.equal(manager.getAutoMixContext(), null)
    assert.deepEqual(calls.slice(-2), [['suspend'], ['BridgeQueueControl', true]])
    await manager.loadQueue([{ id: 'a', source: 'C:/a.wav', queueEntryId: 'one' }], 0)
    assert.equal(calls.some(c => c[0] === 'invalidate'), false)
    await manager.setBridgeAutoMixMode('natural')
    assert.deepEqual(calls.at(-1), ['BridgeAutoMixMode', 'natural'])
    assert.equal((await manager.bindBridgeAutoMixSelection('{"sharedPlan":{}}')).selectionId, 51)
    await manager.releaseGroupPlayback()
    assert.deepEqual(calls.slice(-2), [['BridgeQueueControl', false], ['resume']])
    assert.deepEqual(manager.getAudioProcessing(), before)
  } finally { manager.destroy() }
})

test('Core AB confirmed mutations await ACK and never publish a lost Seek as success', async () => {
  class LoopBinding extends DeferredAudioServiceBinding {
    SetLoopRange = (_start: number, _end: number): void => {}
  }
  const service = new LoopBinding(['SetLoopRange', 'Seek'])
  const manager = makeManager({ exclusiveMode: false }, service)
  try {
    await manager.start()
    let done = false
    const loop = manager.setLoopRangeConfirmed(1, 2).then((ok) => {
      done = true
      return ok
    })
    await Promise.resolve()
    assert.equal(done, false)
    service.resolveNextDeferredCall()
    assert.equal(await loop, true)
    const before = (await manager.getPlaybackInfo()).position
    const seek = manager.seekConfirmed(12)
    const rejected = assert.rejects(seek, /reply lost/)
    service.rejectDeferredCalls(new Error('Seek reply lost'))
    await rejected
    assert.equal((await manager.getPlaybackInfo()).position, before)
    const accepted = manager.seekConfirmed(8)
    service.resolveNextDeferredCall()
    await accepted
    assert.equal((await manager.getPlaybackInfo()).position, 8)
  } finally {
    manager.destroy()
  }
})

test('Core visualization demand keeps DSP preferences and revisions intact while slow FFT permits Pause', async () => {
  let resolveRead!: (value: string) => void
  const demand: boolean[] = []
  class VisualizationBinding extends FakeAudioServiceBinding {
    override Play = (source = 'track.flac'): void => {
      this.playCalls++
      this.playbackInfo = makePlaybackInfo({ state: 'playing', nativePlaybackActive: true, source })
    }
    override callAsync(method: string, args: unknown[]): Promise<unknown> {
      if (method === 'SetVisualizationDemand') {
        demand.push(args[0] as boolean)
        return Promise.resolve()
      }
      if (method === 'GetVisualizationData')
        return new Promise((resolve) => {
          resolveRead = resolve
        })
      return super.callAsync(method, args)
    }
  }
  const service = new VisualizationBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false, audioProcessing: { fftEnabled: true } },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  try {
    await manager.start()
    await manager.play('track.flac', 4)
    const graph = structuredClone(service.lastDspGraphPayload)
    const preferences = structuredClone(manager.getAudioProcessing())
    await manager.setVisualizationDemand(false)
    await manager.setVisualizationDemand(true)
    assert.deepEqual(service.lastDspGraphPayload, graph)
    assert.deepEqual(manager.getAudioProcessing(), preferences)
    const pending = manager.readVisualizationDataAsync({ spectrumPoints: 8, spectrogramFrames: 0 })
    await manager.pause()
    assert.equal((await manager.getPlaybackInfo()).state, 'paused')
    assert.equal(service.playbackInfo.state, 'paused')
    await manager.setVisualizationDemand(false)
    resolveRead(JSON.stringify({ spectrum: [0.5], active: false, tapStatus: 'disabled' }))
    const data = await pending
    assert.equal(data.tapStatus, 'disabled')
    assert.equal(data.active, false)
    assert.equal(data.spectrum.length, 8)
    assert.deepEqual(demand, [false, true, false])
    const restored = new Promise<void>((resolve) =>
      manager.once('audio-service-ready', () => resolve())
    )
    service.emit('ready')
    await restored
    assert.deepEqual(demand, [false, true, false, false])
    assert.equal(manager.getAudioProcessing().fftEnabled, true)
  } finally {
    manager.destroy()
  }
})

test('leaving loudnorm while cache lookup is pending cannot apply measurements or restart analysis', async () => {
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: { dspEnabled: true, volumeNormalization: 'loudnorm' }
    },
    new FakeNativeBinding()
  )
  let resolveLookup!: (value: unknown) => void
  let requested = false
  manager.setLoudnessAnalysisManager({
    peekCached: () =>
      new Promise((resolve) => {
        resolveLookup = resolve
      }),
    cancel: () => {},
    requestAnalysis: () => {
      requested = true
      return Promise.resolve({ status: 'skipped' })
    }
  } as never)
  const prepare = (
    manager as unknown as { prepareLoudnormForPlay: (path: string) => Promise<void> }
  ).prepareLoudnormForPlay('C:/Music/test.flac')
  await manager.setReplayGainMode('off')
  resolveLookup({ integratedLufs: -18, truePeakDb: -2 })
  await prepare
  assert.equal(manager.getLoudnormStatus().status, 'idle')
  assert.equal(requested, false)
  manager.destroy()
})

test('normalizing explicit DSD Auto is not overridden by legacy dsdToPcm flag', () => {
  const normalized = normalizeAudioProcessingSettings({
    ...DEFAULT_AUDIO_PROCESSING,
    dsdToPcm: true,
    dsdOutputMode: 'auto'
  })

  assert.equal(normalized.dsdOutputMode, 'auto')
  assert.equal(normalized.dsdToPcm, false)
})

test('legacy dsdToPcm still maps to PCM when dsdOutputMode is absent', () => {
  const normalized = normalizeAudioProcessingSettings({ dsdToPcm: true })

  assert.equal(normalized.dsdOutputMode, 'pcm')
  assert.equal(normalized.dsdToPcm, true)
})

test('DSD rate policy defaults fail-compatibly and preserves valid strict policies', () => {
  assert.equal(normalizeAudioProcessingSettings({}).dsdRatePolicy, 'pcm-fallback')
  assert.equal(
    normalizeAudioProcessingSettings({ dsdRatePolicy: 'invalid' as 'exact' }).dsdRatePolicy,
    'pcm-fallback'
  )
  assert.equal(normalizeAudioProcessingSettings({ dsdRatePolicy: 'exact' }).dsdRatePolicy, 'exact')
  assert.equal(
    normalizeAudioProcessingSettings({ dsdRatePolicy: 'downrate' }).dsdRatePolicy,
    'downrate'
  )
})

test('loudnorm is preserved as a distinct volumeNormalization mode', () => {
  const normalized = normalizeAudioProcessingSettings({
    ...DEFAULT_AUDIO_PROCESSING,
    volumeNormalization: 'loudnorm'
  })

  assert.equal(normalized.volumeNormalization, 'loudnorm')
  assert.notEqual(normalized.volumeNormalization, 'track')
})

test('Settings and HiFi shared options both require loudnorm (no forbid-loudnorm regression)', async () => {
  const { volumeNormalizationValues, VOLUME_NORMALIZATION_OPTIONS } =
    await import('../shared/audioProcessingOptions.ts')
  const settingsSource = await import('node:fs').then((fs) =>
    [
      fs.readFileSync(
        new URL('../renderer/src/components/SettingsPage.vue', import.meta.url),
        'utf8'
      ),
      fs.readFileSync(
        new URL('../renderer/src/components/settings-page/types.ts', import.meta.url),
        'utf8'
      )
    ].join('\n')
  )
  const hifiSource = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL('../renderer/src/components/player-bar/HiFiSidebar.vue', import.meta.url),
      'utf8'
    )
  )

  assert.deepEqual(volumeNormalizationValues(), ['off', 'track', 'album', 'loudnorm'])
  assert.ok(VOLUME_NORMALIZATION_OPTIONS.some((option) => option.value === 'loudnorm'))
  assert.match(settingsSource, /VOLUME_NORMALIZATION_OPTIONS/)
  assert.match(hifiSource, /VOLUME_NORMALIZATION_OPTIONS/)
  assert.doesNotMatch(settingsSource, /forbid.*loudnorm/i)
  assert.doesNotMatch(hifiSource, /forbid.*loudnorm/i)
  // Local option arrays must not reappear once shared source is required
  assert.doesNotMatch(
    settingsSource,
    /const replayGainOptions:\s*\{\s*value:\s*VolumeNormalizationMode/
  )
  assert.doesNotMatch(
    hifiSource,
    /const replayGainOptions:\s*\{\s*value:\s*VolumeNormalizationMode/
  )
})

test('gapless runtime fields and HiFi Active/Preload/Blocked wiring stay present', async () => {
  const { GAPLESS_BLOCKED_REASONS, gaplessRuntimeStatusCopy, HIFI_STATUS_COPY } =
    await import('../shared/audioProcessingOptions.ts')
  const hifiSource = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL('../renderer/src/components/player-bar/HiFiSidebar.vue', import.meta.url),
      'utf8'
    )
  )
  const managerSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./audioEngineManager.ts', import.meta.url), 'utf8')
  )
  const playbackControllerSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./audio/playbackController.ts', import.meta.url), 'utf8')
  )
  const playerBarSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../renderer/src/components/PlayerBar.vue', import.meta.url), 'utf8')
  )

  assert.ok(GAPLESS_BLOCKED_REASONS.includes('crossfade'))
  assert.equal(
    gaplessRuntimeStatusCopy({
      intentEnabled: true,
      gaplessActive: true,
      preloadReady: true
    }),
    HIFI_STATUS_COPY.gaplessPreload
  )
  assert.match(playbackControllerSource, /gaplessBlockedReason/)
  assert.match(playbackControllerSource, /gaplessActive:\s*info\.gaplessActive === true/)
  assert.match(managerSource, /PlaybackController/)
  assert.match(hifiSource, /gaplessRuntimeStatusCopy/)
  assert.match(hifiSource, /Active/)
  assert.match(hifiSource, /Preload/)
  assert.match(hifiSource, /Blocked/)
  assert.match(playerBarSource, /gapless-active/)
  assert.match(playerBarSource, /gapless-blocked-reason/)
})

test('setStereoImage patches default scene balance/phase and preserves it across setAudioProcessing', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: { dspEnabled: true }
    },
    nativeBinding
  )

  const state = await manager.setStereoImage({
    balance: -0.4,
    width: 1.15,
    invertLeft: false,
    invertRight: true
  })
  const image = () => manager.getStereoImage()
  assert.equal(image().balance, -0.4)
  assert.equal(image().width, 1.15)
  assert.equal(image().invertRight, true)
  assert.ok(state.scenes.some((scene) => scene.id === 'default'))

  const payloadGraph = nativeBinding.lastDspGraphPayload?.graph as {
    nodes?: Array<{ type?: string; enabled?: boolean; params?: Record<string, unknown> }>
  }
  const stereoNode = payloadGraph?.nodes?.find((node) => node.type === 'stereoField')
  const stripNode = payloadGraph?.nodes?.find((node) => node.type === 'channelStrip')
  assert.equal(stereoNode?.enabled, true)
  assert.equal(stereoNode?.params?.balance, -0.4)
  assert.equal(stripNode?.enabled, true)

  await manager.setAudioProcessing({ eqEnabled: true, dspEnabled: true })
  assert.equal(image().balance, -0.4)
  assert.equal(image().width, 1.15)
  assert.equal(image().invertRight, true)

  const hifiSource = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL('../renderer/src/components/player-bar/HiFiSidebar.vue', import.meta.url),
      'utf8'
    )
  )
  const playerBarSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../renderer/src/components/PlayerBar.vue', import.meta.url), 'utf8')
  )
  const managerSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./audioEngineManager.ts', import.meta.url), 'utf8')
  )
  assert.match(managerSource, /async setStereoImage\(/)
  assert.match(hifiSource, /Balance \/ Phase/)
  assert.match(hifiSource, /setStereoImage/)
  assert.match(playerBarSource, /dsp-stereo-image/)
  assert.match(playerBarSource, /@set-stereo-image="setStereoImage"/)

  manager.destroy()
})

test('setOutputStage patches default scene graph.outputStage and preserves it across setAudioProcessing', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: { dspEnabled: true }
    },
    nativeBinding
  )

  const state = await manager.setOutputStage({
    targetSampleRate: 96000,
    resamplerQuality: 'ultra',
    dither: 'highpassTpdf'
  })
  const defaultStage = () => {
    const scene = manager.getDspSceneState().scenes.find((item) => item.id === 'default')
    return scene?.graph.outputStage ?? manager.getOutputStage()
  }
  assert.equal(defaultStage().targetSampleRate, 96000)
  assert.equal(defaultStage().resamplerQuality, 'ultra')
  assert.equal(defaultStage().dither, 'highpassTpdf')
  assert.equal(manager.getOutputStage().targetSampleRate, 96000)

  const payloadGraph = nativeBinding.lastDspGraphPayload?.graph as {
    outputStage?: { targetSampleRate?: unknown; resamplerQuality?: string; dither?: string }
  }
  assert.equal(payloadGraph?.outputStage?.targetSampleRate, 96000)
  assert.equal(payloadGraph?.outputStage?.resamplerQuality, 'ultra')

  await manager.setAudioProcessing({ eqEnabled: true, dspEnabled: true })
  assert.equal(defaultStage().targetSampleRate, 96000)
  assert.equal(defaultStage().resamplerQuality, 'ultra')
  assert.equal(defaultStage().dither, 'highpassTpdf')
  // Silence unused after asserts above when active graph is default.
  assert.ok(state.scenes.some((scene) => scene.id === 'default'))

  const hifiSource = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL('../renderer/src/components/player-bar/HiFiSidebar.vue', import.meta.url),
      'utf8'
    )
  )
  const playerBarSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../renderer/src/components/PlayerBar.vue', import.meta.url), 'utf8')
  )
  const managerSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./audioEngineManager.ts', import.meta.url), 'utf8')
  )
  assert.match(managerSource, /async setOutputStage\(/)
  assert.match(hifiSource, /DSP_OUTPUT_SAMPLE_RATE_OPTIONS/)
  assert.match(hifiSource, /采样率锁/)
  assert.match(hifiSource, /setOutputStage/)
  assert.match(playerBarSource, /dsp-output-stage/)
  assert.match(playerBarSource, /@set-output-stage="setOutputStage"/)

  manager.destroy()
})

test('default audio service mode applies DSP graph revisions and exposes native node/output evidence', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS,
      vst3ModuleResolver: (_catalogId, classId) => ({
        modulePath: 'C:\\managed-vst3\\contract.vst3',
        classId,
        reason: ''
      })
    }
  )
  const scene: DspScene = {
    id: 'service-contract',
    name: 'Service contract',
    enabled: true,
    priority: 10,
    rules: {},
    graph: {
      version: 2,
      outputStage: {
        targetSampleRate: 96000,
        resamplerQuality: 'ultra',
        dither: 'highpassTpdf',
        safetyClamp: true
      },
      nodes: [
        { id: 'width', type: 'stereoField', enabled: true, params: { width: 1.25 } },
        {
          id: 'contract-vst3',
          type: 'vst3Plugin',
          enabled: true,
          params: {},
          vst3: {
            catalogId: 'vst3:contract',
            classId: '0123456789ABCDEF0123456789ABCDEF'
          }
        }
      ]
    }
  }

  await manager.setDspScenes([scene], scene.id)
  const status = await manager.getDspGraphStatus()

  assert.equal(status.applyState, 'applied')
  assert.equal(status.requestedRevision, 1)
  assert.equal(status.appliedRevision, 1)
  assert.equal(status.revision, 1)
  assert.equal(status.nodes.find((node) => node.id === 'width')?.active, true)
  assert.equal(status.nodes.find((node) => node.id === 'contract-vst3')?.active, true)
  assert.equal(status.outputStage?.targetSampleRate, 96000)
  assert.equal(status.outputStage?.resamplerQuality, 'ultra')
  const materializedVst3 = (
    service.lastDspGraphPayload?.graph as {
      nodes?: Array<{ id?: string; params?: Record<string, unknown> }>
    }
  ).nodes?.find((node) => node.id === 'contract-vst3')
  assert.equal(materializedVst3?.params?.vst3ModulePath, 'C:\\managed-vst3\\contract.vst3')
  manager.destroy()
})

test('native binding failures name the real loader error instead of a bare 未加载', () => {
  assert.equal(
    describeNativeBindingFailure(loadNativeBindingWithDiagnostics(() => [])),
    '未加载 twilight_audio_node.node（没有可用的模块路径）'
  )
  assert.match(
    describeNativeBindingFailure(
      loadNativeBindingWithDiagnostics(() => ['D:/twilight-absent/twilight_audio_node.node'])
    ),
    /1 个候选路径均不存在/
  )

  // A file that exists but cannot be dlopened needs a different repair from a
  // file that is absent — on Windows it is almost always a runtime DLL missing
  // beside the addon — so the reason has to carry the loader's own message.
  const dir = mkdtempSync(join(tmpdir(), 'twilight-addon-'))
  try {
    const candidate = join(dir, 'twilight_audio_node.node')
    writeFileSync(candidate, 'not a real addon')
    const broken = loadNativeBindingWithDiagnostics(() => [candidate])
    assert.equal(broken.binding, null)
    assert.equal(broken.attempts.length, 1)
    const described = describeNativeBindingFailure(broken)
    assert.match(described, /^未加载 twilight_audio_node\.node（/)
    assert.ok(described.includes(candidate), `the failing candidate must be named: ${described}`)
    assert.ok(
      described.length > '未加载 twilight_audio_node.node'.length + candidate.length + 2,
      `the loader message must survive: ${described}`
    )
    assert.ok(!described.includes('\n'), 'the reason must stay on one line for the crash notice')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('direct native mode remains fail-closed when no addon candidate exists', () => {
  const previousServiceMode = process.env.TWILIGHT_AUDIO_SERVICE
  process.env.TWILIGHT_AUDIO_SERVICE = '0'
  try {
    const manager = new AudioEngineManager(
      { exclusiveMode: false },
      {
        nativeAddonCandidates: () => [],
        scheduler: TEST_SCHEDULER,
        deviceOptionsProvider: () => DEVICE_OPTIONS
      }
    )
    const internals = manager as unknown as {
      native: NativeAudioBinding | null
      lastNativeError: string
    }

    assert.equal(internals.native, null)
    assert.match(internals.lastNativeError, /twilight_audio_node\.node/)
    manager.destroy()
  } finally {
    if (previousServiceMode === undefined) delete process.env.TWILIGHT_AUDIO_SERVICE
    else process.env.TWILIGHT_AUDIO_SERVICE = previousServiceMode
  }
})

test('DSP graph ACK failures remain observable and reject renderer-facing mutations', async () => {
  const service = new RejectingDspAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  await assert.rejects(
    () => manager.setOutputStage({ targetSampleRate: 96000 }),
    /native DSP graph rejected by service/
  )
  assert.equal(manager.getOutputStage().targetSampleRate, 'device')
  await assert.rejects(() => manager.setAudioProcessing({ dspEnabled: false }))
  assert.equal(manager.getAudioProcessing().directMode, false)
  assert.equal(manager.getAudioProcessing().dspEnabled, false)
  const status = await manager.getDspGraphStatus()
  assert.equal(status.applyState, 'failed')
  assert.ok((status.requestedRevision ?? 0) >= 1)
  assert.equal(status.appliedRevision, 0)
  assert.match(status.applyError ?? '', /native DSP graph rejected by service/)
  manager.destroy()
})

test('direct mode submits an identity graph and restores rate/routing without changing volume', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { routingMode: 'stereo' },
      audioProcessing: { dspEnabled: true, eqEnabled: true, crossfadeSeconds: 2 }
    },
    nativeBinding
  )
  const scene: DspScene = {
    id: 'direct-mode-fixture',
    name: 'Direct mode fixture',
    enabled: true,
    priority: 10,
    rules: {},
    graph: {
      version: 2,
      outputStage: {
        targetSampleRate: 96000,
        resamplerQuality: 'ultra',
        dither: 'tpdf',
        safetyClamp: true
      },
      nodes: [{ id: 'compressor', type: 'compressor', enabled: true, params: { ratio: 2 } }]
    }
  }
  await manager.setDspScenes([scene], scene.id)
  await manager.setVolume(0.8)
  await manager.setPlaybackRate(1.25)

  const direct = await manager.setAudioProcessing({ dspEnabled: false })
  const directGraph = nativeBinding.lastDspGraphPayload?.graph as {
    nodes?: unknown[]
    outputStage?: { targetSampleRate?: unknown; resamplerQuality?: string; dither?: string }
  }
  assert.equal(direct.directMode, true)
  assert.equal(direct.dspEnabled, false)
  assert.deepEqual(directGraph.nodes, [])
  assert.equal(directGraph.outputStage?.targetSampleRate, 'device')
  assert.equal(directGraph.outputStage?.resamplerQuality, 'native')
  assert.equal(directGraph.outputStage?.dither, 'off')
  assert.equal(nativeBinding.lastDspConfig.dspEnabled, false)
  // The read-only FFT tap must remain available while audio processing is bypassed.
  assert.equal(nativeBinding.lastDspConfig.fftEnabled, true)
  assert.equal(nativeBinding.lastDspConfig.crossfadeSeconds, 0)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.8)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 1)
  assert.equal(manager.getOutputConfig().routingMode, 'stereo')
  assert.equal(manager.getEffectiveOutputConfig().routingMode, 'auto')
  assert.equal(
    manager.getDspSceneState().effectiveBypassReason,
    'Direct mode bypasses the DSP graph and output stage'
  )

  const restored = await manager.setAudioProcessing({ dspEnabled: true })
  assert.equal(restored.directMode, false)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 1.25)
  assert.equal(manager.getEffectiveOutputConfig().routingMode, 'stereo')
  assert.equal(
    (nativeBinding.lastDspGraphPayload?.graph as { nodes?: Array<{ id?: string }> }).nodes?.[0]?.id,
    'compressor'
  )
  manager.destroy()
})

test('startup with an enabled master repairs stale directMode and keeps EQ active', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: {
        dspEnabled: true,
        directMode: true,
        eqEnabled: true,
        eqMode: 'parametric',
        eqPreamp: -2,
        eqBands: [
          { frequency: 100, gain: 4, q: 1, filterType: 'peak' },
          { frequency: 1000, gain: -3, q: 1.2, filterType: 'peak' }
        ]
      }
    },
    nativeBinding
  )

  const processing = manager.getAudioProcessing()
  assert.equal(processing.directMode, false)
  assert.equal(processing.dspEnabled, true)
  assert.equal(processing.eqEnabled, true)

  await manager.start()
  const graph = nativeBinding.lastDspGraphPayload?.graph as {
    nodes?: Array<{ type?: string; enabled?: boolean }>
  }
  const eqNode = graph?.nodes?.find((node) => node.type === 'equalizer')
  assert.ok(eqNode, 'equalizer node must be present when EQ is enabled')
  assert.equal(eqNode.enabled, true)
  manager.destroy()
})

test('saved DSP bypass survives engine restarts without clearing configured modules', async () => {
  let audioProcessing = normalizeAudioProcessingSettings({
    dspEnabled: false, directMode: true, eqEnabled: true,
    crossfeedEnabled: true, crossfeedStrength: 0.4
  })
  for (let restart = 0; restart < 3; restart++) {
    const nativeBinding = new FakeNativeBinding()
    const manager = makeManager({ exclusiveMode: false, audioProcessing }, nativeBinding)
    await manager.start()
    const restored = manager.getAudioProcessing()
    assert.equal(restored.dspEnabled, false)
    assert.equal(restored.directMode, true)
    assert.equal(restored.eqEnabled, true)
    assert.equal(restored.crossfeedStrength, 0.4)
    assert.equal(nativeBinding.lastDspConfig.dspEnabled, false)
    audioProcessing = JSON.parse(JSON.stringify(restored))
    manager.destroy()
  }
})

test('module switches gate matching nodes in an active custom scene', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: { dspEnabled: true, eqEnabled: false }
    },
    nativeBinding
  )
  const scene: DspScene = {
    id: 'eq-gate-fixture',
    name: 'EQ gate fixture',
    enabled: true,
    priority: 10,
    rules: {},
    graph: {
      version: 2,
      outputStage: {
        targetSampleRate: 'device',
        resamplerQuality: 'native',
        dither: 'off',
        safetyClamp: true
      },
      nodes: [
        {
          id: 'scene-eq',
          type: 'equalizer',
          enabled: true,
          params: { mode: 'graphic', bands: [] }
        },
        { id: 'scene-compressor', type: 'compressor', enabled: true, params: { ratio: 2 } }
      ]
    }
  }
  await manager.setDspScenes([scene], scene.id)
  const graph = nativeBinding.lastDspGraphPayload?.graph as {
    nodes?: Array<{ id?: string; enabled?: boolean }>
  }
  assert.equal(graph.nodes?.find((node) => node.id === 'scene-eq')?.enabled, false)
  assert.equal(graph.nodes?.find((node) => node.id === 'scene-compressor')?.enabled, true)
  manager.destroy()
})

for (const directMode of [false, true]) {
  test(`audio startup preserves the native crash reason with direct mode ${directMode}`, async () => {
    class CrashingService extends FakeAudioServiceBinding {
      failed = true
      crashed = false
      override async callAsync(method: string, args: unknown[]): Promise<unknown> {
        if (this.failed) {
          if (!this.crashed) {
            this.crashed = true
            this.emit('crash', '音频服务进程退出：3221225727')
          }
          throw new Error('Audio engine is restarting')
        }
        return super.callAsync(method, args)
      }
      async restart() { this.failed = false; this.emit('ready') }
    }
    const service = new CrashingService()
    const manager = new AudioEngineManager({ exclusiveMode: false, volume: 0.35,
      audioOutput: 'wasapi', audioDevice: 'auto', audioProcessing: { directMode },
      audioOutputConfig: { routingMode: 'stereo' } }, {
      audioServiceFactory: () => service, scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    })
    try {
      await assert.rejects(manager.start(), { code: 'AUDIO_SERVICE_UNAVAILABLE', message: '音频服务进程退出：3221225727' })
      assert.equal(manager.getAudioServiceFailure(), '音频服务进程退出：3221225727')
      assert.equal((await manager.getPlaybackInfo()).state, 'stopped')
      assert.equal(manager.getAudioProcessing().directMode, directMode)
      assert.equal(manager.canRestartAudioEngine(), true)
      await manager.restartAudioEngine()
      assert.equal(manager.getAudioServiceFailure(), null)
      assert.equal(service.volume, 0.35)
      assert.equal(service.outputConfig.routingMode, directMode ? 'auto' : 'stereo')
      assert.equal(service.playCalls, 0)
      assert.equal((await manager.getPlaybackInfo()).state, 'stopped')
    } finally { manager.destroy() }
  })
}

for (const readyFirst of [false, true]) {
  test(`cold startup serializes DSP initialization when service ready arrives ${readyFirst ? 'before' : 'during'} start`, async () => {
    const service = new DeferredAudioServiceBinding(['ApplyDspState'])
    const manager = new AudioEngineManager(
      { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
      {
        audioServiceFactory: () => service,
        scheduler: TEST_SCHEDULER,
        deviceOptionsProvider: () => DEVICE_OPTIONS
      }
    )
    try {
      const ready = new Promise<{ restoreErrors: string[]; outputRouteSynced: boolean }>(
        (resolve) => {
          manager.once('audio-service-ready', resolve)
        }
      )
      if (readyFirst) service.emit('ready')
      let startupFinished = false
      const startup = manager.start().then(() => {
        startupFinished = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(service.deferredCalls.length, 1)
      if (!readyFirst) service.emit('ready')
      await new Promise((resolve) => setImmediate(resolve))
      const concurrentGraphApplies = service.deferredCalls.length
      service.resolveNextDeferredCall()
      await new Promise((resolve) => setImmediate(resolve))
      const readyAfterFirstGraph = startupFinished
      for (let turn = 0; turn < 6; turn += 1) {
        service.resolveNextDeferredCall()
        await new Promise((resolve) => setImmediate(resolve))
      }
      await startup
      const event = await ready
      assert.equal(
        concurrentGraphApplies,
        1,
        "startup and ready must wait for each other's DSP ACK"
      )
      assert.equal(readyAfterFirstGraph, false, 'startup must also await the first ready restore')
      assert.deepEqual(event.restoreErrors, [])
      assert.equal(event.outputRouteSynced, true)
      const status = await manager.getDspGraphStatus()
      assert.equal(status.applyState, 'applied')
      assert.equal(status.appliedRevision, status.requestedRevision)
    } finally {
      manager.destroy()
    }
  })
}

test('audio service restart replays the DSP graph and verifies the new applied revision', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  await manager.start()
  await manager.setStereoImage({ balance: -0.2, width: 1.1 })
  const before = await manager.getDspGraphStatus()
  service.emit('crash', 'service restart fixture')
  service.lastDspGraphPayload = null

  const ready = new Promise<{ restoreErrors: string[] }>((resolve) => {
    manager.once('audio-service-ready', resolve)
  })
  service.emit('ready')
  const readyEvent = await ready
  const recovered = await manager.getDspGraphStatus()

  assert.deepEqual(readyEvent.restoreErrors, [])
  assert.equal(recovered.applyState, 'applied')
  assert.ok((recovered.appliedRevision ?? 0) > (before.appliedRevision ?? 0))
  assert.equal(recovered.appliedRevision, recovered.requestedRevision)
  const recoveredGraph = getDspGraphPayloadGraph(service.lastDspGraphPayload)
  assert.ok(
    recoveredGraph?.nodes?.some((node) => node.type === 'stereoField'),
    'recovered service graph must include the stereo field node'
  )
  manager.destroy()
})

test('audio service restart restores graph-owned processors through one DSP state transaction', async () => {
  const service = new FakeAudioServiceBinding()
  const scene: DspScene = {
    id: 'graph-authority',
    name: 'Graph authority',
    enabled: true,
    priority: 10,
    rules: {},
    graph: {
      version: 2,
      outputStage: {
        targetSampleRate: 'device',
        resamplerQuality: 'native',
        dither: 'off',
        safetyClamp: true
      },
      nodes: [
        {
          id: 'graph-replay-gain',
          type: 'replayGain',
          enabled: true,
          params: { mode: 'album', preampDb: 5, fallbackDb: -2, clip: false }
        },
        {
          id: 'graph-equalizer',
          type: 'equalizer',
          enabled: true,
          params: { mode: 'parametric', preampDb: 7, bands: [] }
        },
        {
          id: 'graph-convolver',
          type: 'convolver',
          enabled: true,
          params: { impulseResponsePath: 'graph-ir.wav', wet: 0.75, dry: 0.25 }
        },
        {
          id: 'graph-crossfeed',
          type: 'crossfeed',
          enabled: true,
          params: { algorithm: 'custom', strength: 0.8, delayMs: 0.4, cutoffHz: 750 }
        }
      ]
    }
  }
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioProcessing: {
        dspEnabled: true,
        eqEnabled: true,
        eqPreamp: -6,
        volumeNormalization: 'track',
        replayGainPreamp: 1,
        replayGainFallback: -9,
        replayGainClip: true,
        crossfeedEnabled: true,
        crossfeedStrength: 0.2,
        convolverEnabled: true,
        convolverIrPath: 'legacy-ir.wav'
      },
      dspScenes: [scene],
      dspPinnedSceneId: scene.id
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  await manager.start()
  manager.setNativeDspPluginChain('{"plugins":[{"id":"legacy-plugin"}]}')
  service.emit('crash', 'service restart ordering fixture')
  service.lastDspGraphPayload = null
  service.callOrder = []
  const ready = new Promise<{ restoreErrors: string[] }>((resolve) => {
    manager.once('audio-service-ready', resolve)
  })

  service.emit('ready')
  const readyEvent = await ready
  const status = await manager.getDspGraphStatus()
  const graphIndex = service.callOrder.indexOf('ApplyDspState')
  const graphOwnedLegacyMethods = [
    'SetDspConfig',
    'SetEqBands',
    'SetReplayGainMode',
    'SetCrossfeedStrength',
    'LoadImpulseResponse'
  ]
  const restoredGraph = getDspGraphPayloadGraph(service.lastDspGraphPayload)

  assert.deepEqual(readyEvent.restoreErrors, [])
  assert.ok(graphIndex >= 0)
  assert.ok(restoredGraph, 'service restart must restore a DSP graph payload')
  for (const method of graphOwnedLegacyMethods) {
    const index = service.callOrder.indexOf(method)
    assert.equal(index, -1, `${method} must not fan out beside ApplyDspState`)
  }
  assert.ok(service.callOrder.indexOf('SetDspPluginChain') < graphIndex)
  assert.equal(restoredGraph.nodes?.find((node) => node.type === 'equalizer')?.params?.preampDb, 7)
  assert.equal(restoredGraph.nodes?.find((node) => node.type === 'replayGain')?.params?.preampDb, 5)
  assert.equal(
    restoredGraph.nodes?.find((node) => node.type === 'crossfeed')?.params?.strength,
    0.8
  )
  assert.equal(
    restoredGraph.nodes?.find((node) => node.type === 'convolver')?.params?.impulseResponsePath,
    'graph-ir.wav'
  )
  assert.equal(status.applyState, 'applied')
  assert.equal(status.appliedRevision, status.requestedRevision)
  manager.destroy()
})

test('DSD DSP scenes remain bypassed until the active graph receives an explicit PCM confirmation', async () => {
  const nativeBinding = new FakeNativeBinding({ source: 'album.dsf', codec: 'dsd' })
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'asio', audioDevice: 'asio:studio' },
    nativeBinding
  )
  ;(manager as unknown as { playbackInfo: PlaybackInfo }).playbackInfo = nativeBinding.playbackInfo
  const scene: DspScene = {
    id: 'headphone-correction',
    name: 'Headphone correction',
    enabled: true,
    priority: 10,
    rules: { sourceKinds: ['dsd'] },
    graph: {
      version: 2,
      outputStage: {
        targetSampleRate: 'device',
        resamplerQuality: 'native',
        dither: 'off',
        safetyClamp: true
      },
      nodes: [
        { id: 'eq', type: 'equalizer', enabled: true, params: { mode: 'parametric', bands: [] } }
      ]
    }
  }

  let state = await manager.setDspScenes([scene])
  assert.equal(state.requiresPcmFallback, true)
  assert.equal(state.dsdPcmFallbackApplied, false)
  assert.deepEqual((nativeBinding.lastDspGraphPayload?.graph as { nodes?: unknown[] }).nodes, [])

  state = await manager.applyDspScene(scene.id)
  assert.equal(state.dsdPcmFallbackApplied, false)
  assert.deepEqual((nativeBinding.lastDspGraphPayload?.graph as { nodes?: unknown[] }).nodes, [])

  state = await manager.applyDspScene(scene.id, true)
  assert.equal(state.dsdPcmFallbackApplied, true)
  assert.equal(manager.getAudioProcessing().dsdOutputMode, 'pcm')
  assert.equal(state.scenes[0]?.allowDsdPcmFallback, true)
  assert.equal((nativeBinding.lastDspGraphPayload?.graph as { nodes?: unknown[] }).nodes?.length, 1)

  state = await manager.setDspScenes([
    {
      ...scene,
      graph: {
        ...scene.graph,
        nodes: [{ id: 'compressor', type: 'compressor', enabled: true, params: { ratio: 2 } }]
      }
    }
  ])
  assert.equal(state.dsdPcmFallbackApplied, false)
  assert.equal(state.scenes[0]?.allowDsdPcmFallback, undefined)
  assert.deepEqual((nativeBinding.lastDspGraphPayload?.graph as { nodes?: unknown[] }).nodes, [])

  manager.destroy()
})

test('VST3 graph payloads materialize only a managed catalog resolution', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS,
      vst3ModuleResolver: (catalogId, classId) =>
        catalogId === 'vst3:fixture' && classId === '0123456789ABCDEF0123456789ABCDEF'
          ? {
              modulePath: 'C:\\managed-vst3\\fixture.vst3',
              classId,
              reason: ''
            }
          : { modulePath: null, classId, reason: 'not managed' },
      vst3StateAssetResolver: (assetId) =>
        assetId === 'vst3Preset:fixture-state'
          ? {
              path: 'C:\\managed-dsp-assets\\fixture.vstpreset',
              kind: 'vst3Preset',
              reason: ''
            }
          : { path: null, kind: null, reason: 'state asset is not managed' }
    }
  )
  const scene: DspScene = {
    id: 'vst3',
    name: 'Managed VST3',
    enabled: true,
    priority: 1,
    rules: {},
    graph: {
      version: 2,
      outputStage: {
        targetSampleRate: 'device',
        resamplerQuality: 'native',
        dither: 'off',
        safetyClamp: true
      },
      nodes: [
        {
          id: 'fixture',
          type: 'vst3Plugin',
          enabled: true,
          params: {
            vst3ModulePath: 'C:\\untrusted\\plugin.vst3',
            vst3ClassId: 'UNTRUSTED',
            parameters: { '100': 0.5 }
          },
          vst3: {
            catalogId: 'vst3:fixture',
            classId: '0123456789ABCDEF0123456789ABCDEF',
            stateAssetId: 'vst3Preset:fixture-state'
          }
        }
      ]
    }
  }

  await manager.setDspScenes([scene])
  const payloadGraph = nativeBinding.lastDspGraphPayload?.graph as {
    nodes?: Array<{ params?: Record<string, unknown> }>
  }
  const params = payloadGraph.nodes?.[0]?.params
  assert.equal(params?.vst3ModulePath, 'C:\\managed-vst3\\fixture.vst3')
  assert.equal(params?.vst3ClassId, '0123456789ABCDEF0123456789ABCDEF')
  assert.equal(params?.vst3StatePath, 'C:\\managed-dsp-assets\\fixture.vstpreset')
  assert.equal(params?.vst3StateFormat, 'preset')
  assert.equal(params?.vst3BypassReason, undefined)
  assert.deepEqual(params?.parameters, { '100': 0.5 })

  await manager.setDspScenes([
    {
      ...scene,
      graph: {
        ...scene.graph,
        nodes: [
          {
            ...scene.graph.nodes[0],
            vst3: { catalogId: 'vst3:missing', classId: '0123456789ABCDEF0123456789ABCDEF' }
          }
        ]
      }
    }
  ])
  const bypassedGraph = nativeBinding.lastDspGraphPayload?.graph as {
    nodes?: Array<{ params?: Record<string, unknown> }>
  }
  const bypassedParams = bypassedGraph.nodes?.[0]?.params
  assert.equal(bypassedParams?.vst3ModulePath, undefined)
  assert.equal(bypassedParams?.vst3ClassId, undefined)
  assert.equal(bypassedParams?.vst3BypassReason, 'not managed')
  manager.destroy()
})

test('a missing managed VST3 state asset bypasses the node instead of passing a path to the host', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS,
      vst3ModuleResolver: (_catalogId, classId) => ({
        modulePath: 'C:\\managed-vst3\\fixture.vst3',
        classId,
        reason: ''
      }),
      vst3StateAssetResolver: () => ({
        path: null,
        kind: null,
        reason: 'state asset is not managed'
      })
    }
  )
  await manager.setDspScenes([
    {
      id: 'vst3-state',
      name: 'Missing VST3 state',
      enabled: true,
      priority: 1,
      rules: {},
      graph: {
        version: 2,
        outputStage: {
          targetSampleRate: 'device',
          resamplerQuality: 'native',
          dither: 'off',
          safetyClamp: true
        },
        nodes: [
          {
            id: 'fixture',
            type: 'vst3Plugin',
            enabled: true,
            params: { vst3StatePath: 'C:\\untrusted\\state.vstpreset' },
            vst3: {
              catalogId: 'vst3:fixture',
              classId: '0123456789ABCDEF0123456789ABCDEF',
              stateAssetId: 'vst3Preset:missing'
            }
          }
        ]
      }
    }
  ])

  const params = (
    nativeBinding.lastDspGraphPayload?.graph as {
      nodes?: Array<{ params?: Record<string, unknown> }>
    }
  ).nodes?.[0]?.params
  assert.equal(params?.vst3StatePath, undefined)
  assert.equal(params?.vst3BypassReason, 'state asset is not managed')
  manager.destroy()
})

test('a service crash requires explicit recovery for each active VST3 node', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS,
      vst3ModuleResolver: (catalogId, classId) =>
        catalogId === 'vst3:fixture-a' || catalogId === 'vst3:fixture-b'
          ? {
              modulePath: `C:\\managed-vst3\\${catalogId.slice('vst3:'.length)}.vst3`,
              classId,
              reason: ''
            }
          : { modulePath: null, classId, reason: 'not managed' }
    }
  )
  await manager.setDspScenes([
    {
      id: 'vst3-crash-fixture',
      name: 'VST3 crash fixture',
      enabled: true,
      priority: 1,
      rules: {},
      graph: {
        version: 2,
        outputStage: {
          targetSampleRate: 'device',
          resamplerQuality: 'native',
          dither: 'off',
          safetyClamp: true
        },
        nodes: [
          {
            id: 'fixture-a',
            type: 'vst3Plugin',
            enabled: true,
            params: {},
            vst3: { catalogId: 'vst3:fixture-a', classId: '0123456789ABCDEF0123456789ABCDEF' }
          },
          {
            id: 'fixture-b',
            type: 'vst3Plugin',
            enabled: true,
            params: {},
            vst3: { catalogId: 'vst3:fixture-b', classId: 'FEDCBA9876543210FEDCBA9876543210' }
          }
        ]
      }
    }
  ])

  service.emit('crash', 'fixture host exited')
  manager.refreshDspGraph()
  const bypassed = (
    service.lastDspGraphPayload?.graph as {
      nodes?: Array<{ params?: Record<string, unknown> }>
    }
  ).nodes
  assert.match(String(bypassed?.[0]?.params?.vst3BypassReason), /service crash/)
  assert.match(String(bypassed?.[1]?.params?.vst3BypassReason), /service crash/)

  manager.clearVst3RecoveryBypass('vst3:fixture-a')
  manager.refreshDspGraph()
  const partiallyRestored = (
    service.lastDspGraphPayload?.graph as {
      nodes?: Array<{ params?: Record<string, unknown> }>
    }
  ).nodes
  assert.equal(partiallyRestored?.[0]?.params?.vst3ModulePath, 'C:\\managed-vst3\\fixture-a.vst3')
  assert.match(String(partiallyRestored?.[1]?.params?.vst3BypassReason), /service crash/)

  manager.clearVst3RecoveryBypass('vst3:fixture-b')
  manager.refreshDspGraph()
  const restored = (
    service.lastDspGraphPayload?.graph as {
      nodes?: Array<{ params?: Record<string, unknown> }>
    }
  ).nodes
  assert.equal(restored?.[1]?.params?.vst3ModulePath, 'C:\\managed-vst3\\fixture-b.vst3')
  manager.destroy()
})

test('audio processing normalization preserves advanced replaygain, fft, and crossfeed settings', () => {
  const normalized = normalizeAudioProcessingSettings({
    fftEnabled: false,
    replayGainFallback: 20,
    replayGainClip: false,
    crossfeedDelayMs: 5,
    crossfeedCutoffHz: 10
  })

  assert.equal(normalized.fftEnabled, false)
  assert.equal(normalized.replayGainFallback, 12)
  assert.equal(normalized.replayGainClip, false)
  assert.equal(normalized.crossfeedDelayMs, 2)
  assert.equal(normalized.crossfeedCutoffHz, 80)
})

test('setExclusiveMode refreshes backend facts immediately', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setExclusiveMode(true)
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputBackend, 'wasapi-exclusive')
  assert.equal(info.actualBackend, 'wasapi-exclusive')
  assert.equal(info.outputInfo.actualBackend, 'wasapi-exclusive')
  assert.equal(info.outputInfo.accessMode, 'exclusive')
  assert.equal(info.outputInfo.devicePathKind, 'default')
  assert.equal(info.outputInfo.exclusive, true)
  assert.equal(info.outputInfo.supportsOutputPerfect, true)
  assert.equal(info.outputInfo.perfectReasonCode, '')
  assertPlaybackMirrorsOutputInfo(info)
})

test('getPlaybackInfo preserves canonical 192 kHz PCM output-perfect facts', async () => {
  const outputInfo = makeOutputInfo({
    backend: 'asio',
    actualBackend: 'asio',
    exclusive: true,
    accessMode: 'exclusive',
    devicePathKind: 'asio',
    deviceName: 'asio:studio',
    actualDeviceName: 'Studio ASIO',
    supportsOutputPerfect: true,
    sourceExact: true,
    pcmPassthrough: true,
    outputPerfect: true,
    resampled: false,
    outputSampleRate: 192000,
    outputBitDepth: 24,
    actualSampleRate: 192000,
    actualBitDepth: 24,
    actualChannels: 2,
    actualOutputFormat: 'int24',
    perfectReason: '',
    perfectReasonCode: ''
  })
  const nativeBinding = new FakeNativeBinding({
    state: 'playing',
    source: 'pcm-192k.flac',
    codec: 'flac',
    sourceSampleRate: 192000,
    sourceBitDepth: 24,
    decodedSampleRate: 192000,
    decodedBitDepth: 24,
    decodedChannels: 2,
    decodedSampleFormat: 'int24',
    outputInfo
  })
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:studio'
    },
    nativeBinding
  )
  const managerState = manager as unknown as {
    nativePlaybackActive: boolean
    nativeOutputRouteSynced: boolean
  }
  managerState.nativePlaybackActive = true
  managerState.nativeOutputRouteSynced = true

  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputInfo.sourceExact, true)
  assert.equal(info.outputInfo.pcmPassthrough, true)
  assert.equal(info.outputInfo.outputPerfect, true)
  assert.equal(info.outputInfo.resampled, false)
  assert.equal(info.outputInfo.outputSampleRate, 192000)
  assert.equal(info.sourceExact, true)
  assert.equal(info.pcmPassthrough, true)
  assert.equal(info.outputPerfect, true)
  assertPlaybackMirrorsOutputInfo(info)
})

test('setAudioOutput rejects a stale ASIO snapshot after switching to WASAPI', async () => {
  const nativeBinding = new FakeNativeBinding({
    outputInfo: makeOutputInfo({
      backend: 'asio',
      actualBackend: 'asio',
      exclusive: true,
      accessMode: 'exclusive',
      devicePathKind: 'asio',
      deviceName: 'asio:studio',
      actualDeviceName: 'Studio ASIO'
    })
  })
  nativeBinding.preservePlaybackRouteOnSet = true
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:studio'
    },
    nativeBinding
  )

  await manager.setAudioOutput('wasapi', 'auto')
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputBackend, 'wasapi')
  assert.equal(info.actualBackend, 'wasapi')
  assert.equal(info.outputInfo.backend, 'wasapi')
  assert.equal(info.outputInfo.actualBackend, 'wasapi')
  assert.equal(info.outputInfo.accessMode, 'shared')
  assert.equal(info.outputInfo.devicePathKind, 'default')
  assert.equal(info.outputInfo.deviceName, 'auto')
  assertPlaybackMirrorsOutputInfo(info)
})

test('setAudioOutput rejects a stale WASAPI snapshot after switching to ASIO', async () => {
  const nativeBinding = new FakeNativeBinding()
  nativeBinding.preservePlaybackRouteOnSet = true
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setAudioOutput('asio', 'asio:studio')
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputBackend, 'asio')
  assert.equal(info.actualBackend, 'asio')
  assert.equal(info.outputInfo.backend, 'asio')
  assert.equal(info.outputInfo.actualBackend, 'asio')
  assert.equal(info.outputInfo.accessMode, 'exclusive')
  assert.equal(info.outputInfo.devicePathKind, 'asio')
  assert.equal(info.outputInfo.deviceName, 'asio:studio')
  assertPlaybackMirrorsOutputInfo(info)
})

test('setExclusiveMode skips native calls and playback fanout when mode is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  const firstState = await manager.setExclusiveMode(true)
  assert.equal(firstState.exclusiveMode, true)
  assert.equal(nativeBinding.outputBackendCalls, 1)
  assert.equal(nativeBinding.outputConfigCalls, 1)
  assert.equal(playbackUpdates.at(-1)?.outputBackend, 'wasapi-exclusive')
  const fullUpdatesAfterChange = playbackUpdates.length

  const secondState = await manager.setExclusiveMode(true)
  assert.equal(secondState.exclusiveMode, true)
  assert.equal(nativeBinding.outputBackendCalls, 1)
  assert.equal(nativeBinding.outputConfigCalls, 1)
  assert.equal(playbackUpdates.length, fullUpdatesAfterChange)
})

test('setOutputConfig forwards and keeps advanced upmix parameters', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setOutputConfig({
    preferredBufferSize: 512,
    routingMode: 'stereo-to-7.1',
    pcmToDsdMode: 'dsd64',
    upmixCenterGain: 1.1,
    upmixLfeGain: 0.25,
    upmixLfeLowpassHz: 180,
    upmixSurroundGain: 0.75,
    upmixSideGain: 0.4,
    upmixSurroundDelayMs: 12
  })

  assert.equal(nativeBinding.lastOutputConfig.preferredBufferSize, 512)
  assert.equal(nativeBinding.lastOutputConfig.routingMode, 'stereo-to-7.1')
  assert.equal(nativeBinding.lastOutputConfig.pcmToDsdMode, 'dsd64')
  assert.equal(nativeBinding.lastOutputConfig.upmixCenterGain, 1.1)
  assert.equal(nativeBinding.lastOutputConfig.upmixLfeGain, 0.25)
  assert.equal(nativeBinding.lastOutputConfig.upmixLfeLowpassHz, 180)
  assert.equal(nativeBinding.lastOutputConfig.upmixSurroundGain, 0.75)
  assert.equal(nativeBinding.lastOutputConfig.upmixSideGain, 0.4)
  assert.equal(nativeBinding.lastOutputConfig.upmixSurroundDelayMs, 12)
})

test('setOutputConfig skips native call and playback fanout when normalized config is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  await manager.setOutputConfig({ preferredBufferSize: 512, routingMode: 'stereo-to-7.1' })
  assert.equal(nativeBinding.outputConfigCalls, 1)
  assert.equal(playbackUpdates.at(-1)?.outputInfo.channelRoutingMode, 'stereo-to-7.1')
  const fullUpdatesAfterChange = playbackUpdates.length

  await manager.setOutputConfig({ preferredBufferSize: 512, routingMode: 'stereo-to-7.1' })
  assert.equal(nativeBinding.outputConfigCalls, 1)
  assert.equal(playbackUpdates.length, fullUpdatesAfterChange)
})

test('coreaudio exclusive mode maps to coreaudio-exclusive backend', async () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const nativeBinding = new FakeNativeBinding()
    const manager = makeManager(
      {
        exclusiveMode: false,
        audioOutput: 'coreaudio',
        audioDevice: 'auto'
      },
      nativeBinding
    )

    await manager.setExclusiveMode(true)
    const info = await manager.getPlaybackInfo()

    assert.equal(info.outputBackend, 'coreaudio-exclusive')
    assert.equal(info.actualBackend, 'coreaudio-exclusive')
    assert.equal(info.outputInfo.actualBackend, 'coreaudio-exclusive')
    assert.equal(info.outputInfo.accessMode, 'exclusive')
    assert.equal(info.outputInfo.devicePathKind, 'hal')
    assert.equal(info.outputInfo.exclusive, true)
    assert.equal(info.outputInfo.supportsOutputPerfect, true)
    assert.equal(info.outputInfo.perfectReasonCode, '')
    assertPlaybackMirrorsOutputInfo(info)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  }
})

test('coreaudio shared mode stays coreaudio with shared_mixer reason', async () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try {
    const nativeBinding = new FakeNativeBinding()
    const manager = makeManager(
      {
        exclusiveMode: false,
        audioOutput: 'coreaudio',
        audioDevice: 'auto'
      },
      nativeBinding
    )

    const info = await manager.getPlaybackInfo()

    assert.equal(info.outputBackend, 'coreaudio')
    assert.equal(info.actualBackend, 'coreaudio')
    assert.equal(info.outputInfo.accessMode, 'shared')
    assert.equal(info.outputInfo.exclusive, false)
    assert.equal(info.outputInfo.supportsOutputPerfect, false)
    assert.equal(info.outputInfo.perfectReasonCode, 'shared_mixer')
    assertPlaybackMirrorsOutputInfo(info)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  }
})

test('setAudioDevice refreshes canonical device names immediately', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setAudioDevice('dac-1')
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputDevice, 'dac-1')
  assert.equal(info.outputInfo.deviceName, 'dac-1')
  assert.equal(info.outputInfo.actualDeviceName, 'Desk DAC')
  assert.equal(info.outputInfo.devicePathKind, 'default')
  assertPlaybackMirrorsOutputInfo(info)
})

test('setAudioDevice skips native call and playback fanout when normalized device is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  const firstState = await manager.setAudioDevice('dac-1')
  assert.equal(firstState.device, 'dac-1')
  assert.equal(nativeBinding.outputDeviceCalls, 1)
  assert.equal(playbackUpdates.at(-1)?.outputDevice, 'dac-1')
  const fullUpdatesAfterChange = playbackUpdates.length

  const secondState = await manager.setAudioDevice('dac-1')
  assert.equal(secondState.device, 'dac-1')
  assert.equal(nativeBinding.outputDeviceCalls, 1)
  assert.equal(playbackUpdates.length, fullUpdatesAfterChange)
})

test('default output device display labels normalize to auto', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: '系统默认'
    },
    nativeBinding
  )

  assert.equal((await manager.getAudioOutputState()).device, 'auto')

  await manager.setAudioDevice('System Default')
  const state = await manager.getAudioOutputState()
  const info = await manager.getPlaybackInfo()

  assert.equal(state.device, 'auto')
  assert.equal(info.outputDevice, 'auto')
  assert.equal(info.outputInfo.deviceName, 'auto')
})

test('setOutputConfig uses the actual native buffer size and latency facts', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setExclusiveMode(true)
  await manager.setOutputConfig({ preferredBufferSize: 512 })
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputInfo.actualBackend, 'wasapi-exclusive')
  assert.equal(info.outputInfo.bufferSizeFrames, 448)
  assert.equal(info.bufferSizeFrames, 448)
  assert.equal(info.outputInfo.latencyFrames, 448)
  assert.equal(info.latencyFrames, 448)
  assert.equal(info.outputInfo.latencyInfo.bufferLatencyMs > 0, true)
  assert.equal(
    info.outputInfo.latencyInfo.totalLatencyMs >= info.outputInfo.latencyInfo.bufferLatencyMs,
    true
  )
  assert.equal(info.outputInfo.latencyMs, info.outputInfo.latencyInfo.totalLatencyMs)
  assert.equal(info.latencyInfo.totalLatencyMs, info.outputInfo.latencyInfo.totalLatencyMs)
  assertPlaybackMirrorsOutputInfo(info)
})

test('ASIO output config uses the native applied buffer and capability facts', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setAudioOutput('asio', 'asio:studio')
  await manager.setOutputConfig({ preferredBufferSize: 1000 })
  const info = await manager.getPlaybackInfo()
  const state = await manager.getAudioOutputState()
  const asioDevice = state.deviceOptions.find((device) => device.id === 'asio:studio')

  assert.equal(info.outputInfo.backend, 'asio')
  assert.equal(info.outputInfo.actualBackend, 'asio')
  assert.equal(info.outputInfo.accessMode, 'exclusive')
  assert.equal(info.outputInfo.devicePathKind, 'asio')
  assert.equal(info.outputInfo.deviceName, 'asio:studio')
  assert.equal(info.outputInfo.actualDeviceName, 'Studio ASIO')
  assert.equal(info.outputInfo.supportsOutputPerfect, true)
  assert.equal(info.outputInfo.bufferSizeFrames, 960)
  assert.equal(info.outputInfo.latencyFrames, 960)
  assert.equal(info.outputInfo.latencyInfo.bufferLatencyMs, 20)
  assert.equal(info.outputInfo.latencyInfo.outputLatencyMs, 2)
  assert.equal(info.outputInfo.latencyInfo.totalLatencyMs, 22)
  assert.equal(info.outputInfo.latencyMs, 22)
  assert.equal(info.outputInfo.perfectReasonCode, '')
  assert.equal(asioDevice?.minBufferSize, 64)
  assert.equal(asioDevice?.maxBufferSize, 2048)
  assert.equal(asioDevice?.granularity, 64)
  assert.equal(asioDevice?.preferredBufferSize, 256)
  assert.equal(asioDevice?.supportsDop, true)
  assert.equal(asioDevice?.dopSupportState, 'verified')
  assert.equal(asioDevice?.supportsNativeDsd, true)
  assert.equal(asioDevice?.nativeDsdSupportState, 'verified')
  assert.deepEqual(asioDevice?.supportedDsdRates, [64])
  assert.deepEqual(asioDevice?.nativeDsdSampleRates, [2822400, 5644800, 11289600])
  assert.deepEqual(asioDevice?.nativeDsdSampleFormats, ['dsd-int8-msb1'])
  assert.deepEqual(asioDevice?.dopCarrierSampleRates, [176400])
  assert.deepEqual(asioDevice?.dopCarrierFormats, ['int24-in32'])
  assert.equal(asioDevice?.capabilityVersion, 3)
  assertPlaybackMirrorsOutputInfo(info)
})

test('ASIO legacy display ids migrate only when the catalog has a unique canonical CLSID id', async () => {
  const nativeBinding = new FakeNativeBinding()
  const canonicalId = 'asio:{12345678-1234-1234-1234-1234567890ab}'
  const canonicalDevice: AudioDeviceOption = {
    ...DEVICE_OPTIONS[2],
    id: canonicalId,
    backend: 'asio'
  }
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:Studio ASIO'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => [DEVICE_OPTIONS[0], canonicalDevice]
    }
  )

  const state = await manager.getAudioOutputState()

  assert.equal(state.device, canonicalId)
  assert.equal(
    state.deviceOptions.some((device) => device.id === 'asio:Studio ASIO'),
    false
  )

  const ambiguousManager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:Studio ASIO'
    },
    {
      nativeBinding: new FakeNativeBinding(),
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => [
        DEVICE_OPTIONS[0],
        canonicalDevice,
        { ...canonicalDevice, id: 'asio:{abcdefab-cdef-cdef-cdef-abcdefabcdef}' }
      ]
    }
  )

  // An ambiguous legacy name stays unresolved so the backend reports it by name.
  // It must not migrate to either candidate, and must not become 'auto': ASIO has
  // no system-default endpoint, so that would bind whichever driver enumerates
  // first without ever showing which one.
  const ambiguousDevice = (await ambiguousManager.getAudioOutputState()).device
  assert.equal(ambiguousDevice, 'asio:Studio ASIO')
  assert.notEqual(ambiguousDevice, 'auto')
})

test('audio device options expose runtime-probed DSD support states without forcing boolean support', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    nativeBinding
  )

  const state = await manager.getAudioOutputState()
  const defaultDevice = state.deviceOptions.find((device) => device.id === 'auto')
  const dac = state.deviceOptions.find((device) => device.id === 'dac-1')

  assert.equal(defaultDevice?.dopSupportState, 'runtime-probed')
  assert.equal(defaultDevice?.nativeDsdSupportState, 'unsupported')
  assert.equal(dac?.supportsDop, undefined)
  assert.equal(dac?.dopSupportState, 'runtime-probed')
  assert.equal(dac?.nativeDsdSupportState, 'unsupported')
})

test('audio device options preserve additive stable catalog identity fields', async () => {
  const stableId = '{0.0.0.00000000}.{stable-endpoint}'
  const nativeBinding = new FakeNativeBinding(undefined, [
    DEVICE_OPTIONS[0],
    {
      id: stableId,
      platformStableId: stableId,
      label: 'USB DAC',
      lastKnownLabel: 'USB DAC',
      providerFamily: 'wasapi',
      defaultRole: 'console',
      backend: 'wasapi',
      isDefault: true,
      pathKind: 'default'
    }
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: stableId
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )

  const state = await manager.getAudioOutputState()
  const device = state.deviceOptions.find((option) => option.id === stableId)
  assert.equal(state.device, stableId)
  assert.equal(device?.platformStableId, stableId)
  assert.equal(device?.lastKnownLabel, 'USB DAC')
  assert.equal(device?.providerFamily, 'wasapi')
  assert.equal(device?.defaultRole, 'console')
})

test('an unreadable ASIO catalog keeps the persisted driver instead of dropping to auto', async () => {
  // The manager resolves the initial device in its constructor, before the audio
  // service is up, so the catalog reads empty there. Rewriting the selection at
  // that point discarded an explicit ASIO driver on every launch, and 'auto' then
  // bound whichever driver enumerated first without ever showing which.
  const persisted = 'asio:{6D241B5E-CF73-4043-A85F-EF11D4670955}'
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: persisted
    },
    {
      nativeBinding: new FakeNativeBinding(undefined, []),
      scheduler: TEST_SCHEDULER
    }
  )

  const state = await manager.getAudioOutputState()
  assert.equal(state.device, persisted)
})

test('a backend switch restores the device last used on that backend', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    nativeBinding
  )

  const onAsio = await manager.setAudioOutput('asio', 'asio:studio')
  assert.equal(onAsio.device, 'asio:studio')

  // Switching back used to hard-reset the device to auto, discarding the explicit
  // WASAPI endpoint every time the user compared two backends.
  const backOnWasapi = await manager.setAudioOutput('wasapi')
  assert.equal(backOnWasapi.output, 'wasapi')
  assert.equal(backOnWasapi.device, 'dac-1')

  const backOnAsio = await manager.setAudioOutput('asio')
  assert.equal(backOnAsio.output, 'asio')
  assert.equal(backOnAsio.device, 'asio:studio')
})

test('the output device picker only offers devices the selected backend can open', () => {
  // EnumerateDevices returns one merged list. Presenting it unfiltered lets a user
  // pick an ASIO driver while WASAPI is selected — silently snapped back to the
  // default — and offers a 系统默认 row under ASIO, which has no such endpoint.
  const onWasapi = deviceOptionsForOutput('wasapi', DEVICE_OPTIONS)
  assert.deepEqual(
    onWasapi.map((option) => option.id),
    ['auto', 'dac-1']
  )

  const onAsio = deviceOptionsForOutput('asio', DEVICE_OPTIONS)
  assert.deepEqual(
    onAsio.map((option) => option.id),
    ['asio:studio']
  )
})

test('output route switches apply backend device config between mute and unmute', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    nativeBinding
  )

  await manager.setAudioOutput('asio', 'asio:studio')

  assert.deepEqual(
    nativeBinding.routeCalls.map((call) => call.method),
    ['SetOutputBackend', 'SetOutputDevice', 'SetOutputConfig']
  )
  assert.equal(nativeBinding.routeCalls[0]?.value, 'asio')
  assert.equal(nativeBinding.routeCalls[1]?.value, 'asio:studio')
  assert.equal(nativeBinding.volumeCalls, 2)
})

test('output route switch rejects a target device that disappears after prepare', async () => {
  const nativeBinding = new FakeNativeBinding()
  let options = DEVICE_OPTIONS
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => options
    }
  )

  options = DEVICE_OPTIONS.filter((device) => device.id !== 'asio:studio')
  await assert.rejects(() => manager.setAudioOutput('asio', 'asio:studio'), /unavailable/)

  const state = await manager.getAudioOutputState()
  assert.equal(state.output, 'wasapi')
  assert.equal(state.device, 'dac-1')
  assert.equal(nativeBinding.outputBackendCalls, 0)
})

test('output route verification uses stable device ids when labels are duplicated', async () => {
  const endpointA = '{0.0.0.00000000}.{endpoint-a}'
  const endpointB = '{0.0.0.00000000}.{endpoint-b}'
  const options: AudioDeviceOption[] = [
    DEVICE_OPTIONS[0],
    {
      id: endpointA,
      platformStableId: endpointA,
      label: 'Duplicate DAC',
      backend: 'wasapi',
      isDefault: true,
      pathKind: 'default'
    },
    {
      id: endpointB,
      platformStableId: endpointB,
      label: 'Duplicate DAC',
      backend: 'wasapi',
      isDefault: false,
      pathKind: 'default'
    }
  ]
  const nativeBinding = new FakeNativeBinding(undefined, options)
  nativeBinding.actualDeviceIdOverride = endpointA
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: endpointA
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => options
    }
  )
  await manager.play('track.flac', 4)

  await assert.rejects(() => manager.setAudioDevice(endpointB), /did not preserve/)

  const state = await manager.getAudioOutputState()
  assert.equal(state.device, endpointA)
  assert.equal(nativeBinding.stopCalls, 0)
})

test('output route switch rolls back after target open failure without auto replay', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    nativeBinding
  )
  await manager.play('track.flac', 12)
  nativeBinding.routeCalls = []
  nativeBinding.playCalls = []
  nativeBinding.failNextOutputConfig = 'target ready timeout'

  await assert.rejects(() => manager.setAudioOutput('asio', 'asio:studio'), /target ready timeout/)

  const state = await manager.getAudioOutputState()
  const info = await manager.getPlaybackInfo()
  assert.equal(state.output, 'wasapi')
  assert.equal(state.device, 'dac-1')
  assert.equal(info.state, 'playing')
  assert.equal(info.source, 'track.flac')
  assert.equal(info.position, 12)
  assert.equal(nativeBinding.playCalls.length, 0)
  assert.deepEqual(
    nativeBinding.routeCalls.map((call) => call.method),
    [
      'SetOutputBackend',
      'SetOutputDevice',
      'SetOutputConfig',
      'SetOutputBackend',
      'SetOutputDevice',
      'SetOutputConfig'
    ]
  )
})

test('output route switch safe-stops when rollback device is gone', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    nativeBinding
  )
  await manager.play('track.flac', 18)
  nativeBinding.routeCalls = []
  nativeBinding.playCalls = []
  nativeBinding.failNextOutputConfig = 'target open failed'
  nativeBinding.failOutputDeviceValues.add('dac-1')

  await assert.rejects(() => manager.setAudioOutput('asio', 'asio:studio'), /target open failed/)

  const info = await manager.getPlaybackInfo()
  assert.equal(info.state, 'stopped')
  assert.equal(info.nativePlaybackActive, false)
  assert.equal(nativeBinding.stopCalls, 1)
  assert.equal(nativeBinding.playCalls.length, 0)
})

test('paused output route switch preserves paused state and queue position', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    nativeBinding
  )
  await manager.play('track.flac', 33)
  await manager.pause()

  await manager.setAudioOutput('asio', 'asio:studio')
  const info = await manager.getPlaybackInfo()

  assert.equal(info.state, 'paused')
  assert.equal(info.source, 'track.flac')
  assert.equal(info.position, 33)
})

test('setAudioOutput skips native calls and playback fanout when output and device are unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  const firstState = await manager.setAudioOutput('asio', 'asio:studio')
  assert.equal(firstState.output, 'asio')
  assert.equal(firstState.device, 'asio:studio')
  assert.equal(nativeBinding.outputBackendCalls, 1)
  assert.equal(nativeBinding.outputDeviceCalls, 1)
  assert.equal(nativeBinding.outputConfigCalls, 1)
  assert.equal(playbackUpdates.at(-1)?.outputBackend, 'asio')
  const fullUpdatesAfterChange = playbackUpdates.length

  const secondState = await manager.setAudioOutput('asio', 'asio:studio')
  assert.equal(secondState.output, 'asio')
  assert.equal(secondState.device, 'asio:studio')
  assert.equal(nativeBinding.outputBackendCalls, 1)
  assert.equal(nativeBinding.outputDeviceCalls, 1)
  assert.equal(nativeBinding.outputConfigCalls, 1)
  assert.equal(playbackUpdates.length, fullUpdatesAfterChange)
})

test('audio service output switches wait for route RPCs before marking synced', async () => {
  const service = new DeferredAudioServiceBinding([
    'SetOutputBackend',
    'SetOutputDevice',
    'SetOutputConfig'
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 512 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup

  const switchPromise = manager.setAudioOutput('asio', 'asio:studio')
  let resolved = false
  switchPromise.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputBackend']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputDevice']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  const state = await switchPromise

  assert.equal(resolved, true)
  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(state.output, 'asio')
  assert.equal(state.device, 'asio:studio')
  assert.equal(service.backend, 'asio')
  assert.equal(service.device, 'asio:studio')
  assert.equal(service.outputConfig.preferredBufferSize, 512)

  manager.destroy()
})

test('audio service startup waits for route RPCs before emitting ready', async () => {
  const service = new DeferredAudioServiceBinding([
    'SetOutputBackend',
    'SetOutputDevice',
    'SetOutputConfig'
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1',
      audioOutputConfig: { preferredBufferSize: 512 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }
  let ready = false
  manager.on('ready', () => {
    ready = true
  })

  const startPromise = manager.start()
  let resolved = false
  startPromise.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(ready, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputBackend']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(ready, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputDevice']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(ready, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  await startPromise

  assert.equal(resolved, true)
  assert.equal(ready, true)
  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(service.backend, 'wasapi-exclusive')
  assert.equal(service.device, 'dac-1')
  assert.equal(service.outputConfig.preferredBufferSize, 512)

  manager.destroy()
})

test('audio service device switches wait for device RPC before marking synced', async () => {
  const service = new DeferredAudioServiceBinding(['SetOutputDevice'])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup
  const switchPromise = manager.setAudioDevice('dac-1')
  let resolved = false
  switchPromise.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputDevice']
  )

  service.resolveNextDeferredCall()
  const state = await switchPromise

  assert.equal(resolved, true)
  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(state.device, 'dac-1')
  assert.equal(service.device, 'dac-1')

  manager.destroy()
})

test('audio service exclusive mode switches wait for backend and config RPCs before marking synced', async () => {
  const service = new DeferredAudioServiceBinding(['SetOutputBackend', 'SetOutputConfig'])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 256 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup

  const switchPromise = manager.setExclusiveMode(true)
  let resolved = false
  switchPromise.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputBackend']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  const state = await switchPromise

  assert.equal(resolved, true)
  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(state.exclusiveMode, true)
  assert.equal(service.backend, 'wasapi-exclusive')
  assert.equal(service.outputConfig.preferredBufferSize, 256)

  manager.destroy()
})

test('audio service output config changes wait for config RPC before marking synced', async () => {
  const service = new DeferredAudioServiceBinding(['SetOutputConfig'])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 256, routingMode: 'auto' }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup

  const configPromise = manager.setOutputConfig({
    preferredBufferSize: 512,
    routingMode: 'stereo-to-5.1'
  })
  let resolved = false
  configPromise.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  await configPromise

  const info = await manager.getPlaybackInfo()
  assert.equal(resolved, true)
  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(service.outputConfig.preferredBufferSize, 512)
  assert.equal(service.outputConfig.routingMode, 'stereo-to-5.1')
  assert.equal(info.channelRoutingMode, 'stereo-to-5.1')

  manager.destroy()
})

test('failed topology config RPC leaves the last applied config and reports a failed revision', async () => {
  const service = new DeferredAudioServiceBinding(['SetOutputConfig'])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 256, routingMode: 'auto' }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup

  const update = manager.setOutputConfig({
    preferredBufferSize: 512,
    wasapiExclusivePushMode: true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )
  service.rejectDeferredCalls(
    new Error('candidate topology failed; rollback restored previous output')
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )
  service.resolveNextDeferredCall()
  await assert.rejects(update, /candidate topology failed/)

  assert.equal(manager.getOutputConfig().preferredBufferSize, 256)
  assert.equal(manager.getOutputConfig().wasapiExclusivePushMode, false)
  const status = manager.getOutputConfigApplyStatus()
  assert.equal(status.state, 'failed')
  assert.equal(status.requestedRevision, 1)
  assert.equal(status.appliedRevision, 0)
  assert.equal(status.failedRevision, 1)
  assert.match(status.error, /candidate topology failed/)

  manager.destroy()
})

test('backend and device switches do not leave stale output facts', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setExclusiveMode(true)
  await manager.setOutputConfig({ preferredBufferSize: 512 })
  const exclusiveInfo = await manager.getPlaybackInfo()
  assert.equal(exclusiveInfo.outputInfo.actualBackend, 'wasapi-exclusive')
  assert.equal(exclusiveInfo.outputInfo.accessMode, 'exclusive')
  assert.equal(exclusiveInfo.outputInfo.devicePathKind, 'default')
  assert.equal(exclusiveInfo.outputInfo.actualDeviceName, 'System Default')
  assert.equal(exclusiveInfo.outputInfo.bufferSizeFrames, 448)

  await manager.setAudioOutput('asio', 'asio:studio')
  await manager.setOutputConfig({ preferredBufferSize: 1000 })
  const asioInfo = await manager.getPlaybackInfo()
  assert.equal(asioInfo.outputInfo.actualBackend, 'asio')
  assert.equal(asioInfo.outputInfo.accessMode, 'exclusive')
  assert.equal(asioInfo.outputInfo.devicePathKind, 'asio')
  assert.equal(asioInfo.outputInfo.deviceName, 'asio:studio')
  assert.equal(asioInfo.outputInfo.actualDeviceName, 'Studio ASIO')
  assert.equal(asioInfo.outputInfo.bufferSizeFrames, 960)
  assert.equal(asioInfo.outputInfo.perfectReasonCode, '')
  assertPlaybackMirrorsOutputInfo(asioInfo)

  await manager.setAudioOutput('wasapi', 'auto')
  await manager.setExclusiveMode(false)
  await manager.setOutputConfig({ preferredBufferSize: 0 })
  const sharedInfo = await manager.getPlaybackInfo()
  assert.equal(sharedInfo.outputInfo.backend, 'wasapi')
  assert.equal(sharedInfo.outputInfo.actualBackend, 'wasapi')
  assert.equal(sharedInfo.outputInfo.accessMode, 'shared')
  assert.equal(sharedInfo.outputInfo.devicePathKind, 'default')
  assert.equal(sharedInfo.outputInfo.deviceName, 'auto')
  assert.equal(sharedInfo.outputInfo.actualDeviceName, 'System Default')
  assert.equal(sharedInfo.outputInfo.bufferSizeFrames, 480)
  assert.equal(sharedInfo.outputInfo.latencyInfo.bufferLatencyMs, 10)
  assert.equal(sharedInfo.outputInfo.latencyInfo.outputLatencyMs, 1)
  assert.equal(sharedInfo.outputInfo.latencyInfo.totalLatencyMs, 11)
  assert.equal(sharedInfo.outputInfo.perfectReasonCode, 'shared_mixer')
  assert.equal(sharedInfo.outputInfo.supportsOutputPerfect, false)
  assertPlaybackMirrorsOutputInfo(sharedInfo)
})

test('switching to ASIO does not keep a WASAPI endpoint device id', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: '{0.0.0.00000000}.{f968bbfb-342c-4419-adef-8082728d6c2d}'
    },
    nativeBinding
  )

  await manager.setAudioOutput('asio')
  const state = await manager.getAudioOutputState()
  const info = await manager.getPlaybackInfo()

  assert.equal(state.output, 'asio')
  // Binds an explicit driver rather than the inert 系统默认 row, which ASIO has no
  // endpoint for and which would let whichever driver enumerates first win.
  assert.equal(state.device, 'asio:studio')
  assert.equal(info.outputInfo.actualBackend, 'asio')
  assert.equal(info.outputInfo.devicePathKind, 'asio')
  assert.notEqual(
    info.outputInfo.deviceName,
    '{0.0.0.00000000}.{f968bbfb-342c-4419-adef-8082728d6c2d}'
  )
  assertPlaybackMirrorsOutputInfo(info)
})

test('ASIO play failure falls back to native WASAPI instead of throwing to HTMLAudio', async () => {
  const nativeBinding = new FakeNativeBinding()
  nativeBinding.failAsioPlayWith =
    '无法找到请求的 ASIO 设备：{0.0.0.00000000}.{f968bbfb-342c-4419-adef-8082728d6c2d}'
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:studio'
    },
    nativeBinding
  )

  await manager.setAudioOutput('asio', 'asio:studio')
  const result = await manager.play('album.dsf', 0)
  const state = await manager.getAudioOutputState()
  const info = await manager.getPlaybackInfo()

  assert.equal(result.nativeStarted, true)
  assert.match(result.fallbackReason, /无法找到请求的 ASIO 设备/)
  assert.deepEqual(
    nativeBinding.playCalls.map((call) => call.backend),
    ['asio', 'wasapi']
  )
  assert.equal(state.output, 'wasapi')
  assert.equal(state.device, 'auto')
  assert.equal(info.state, 'playing')
  assert.equal(info.outputInfo.actualBackend, 'wasapi')
  assert.equal(info.outputInfo.accessMode, 'shared')
  assert.equal(info.outputInfo.deviceName, 'auto')
  assert.equal(info.source, 'album.dsf')
  assert.equal(info.isDsd, true)
  assertPlaybackMirrorsOutputInfo(info)
})

test('audio service ASIO play fallback waits for WASAPI route RPCs before retrying playback', async () => {
  const service = new AsioFailingAudioServiceBinding([
    'SetOutputBackend',
    'SetOutputDevice',
    'SetOutputConfig'
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:studio',
      audioOutputConfig: { preferredBufferSize: 512 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup
  assert.equal(service.backend, 'asio')
  assert.equal(service.device, 'asio:studio')

  const playPromise = manager.play('album.dsf', 0)
  let resolved = false
  let rejected: unknown = null
  playPromise.then(
    () => {
      resolved = true
    },
    (error) => {
      rejected = error
    }
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(rejected, null)
  assert.equal(service.playCalls, 1)
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(service.directRouteCalls, [])
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputBackend']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(rejected, null)
  assert.equal(service.playCalls, 1)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputDevice']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolved, false)
  assert.equal(rejected, null)
  assert.equal(service.playCalls, 1)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  const result = await playPromise
  const state = await manager.getAudioOutputState()

  assert.equal(resolved, true)
  assert.equal(rejected, null)
  assert.equal(result.nativeStarted, true)
  assert.match(result.fallbackReason, /asio backend failed/)
  assert.equal(service.playCalls, 2)
  assert.equal(service.backend, 'wasapi')
  assert.equal(service.device, 'auto')
  assert.equal(service.outputConfig.preferredBufferSize, 512)
  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(state.output, 'wasapi')
  assert.equal(state.device, 'auto')

  manager.destroy()
})

test('next falls back to Play when native Next advances but does not keep playback active', async () => {
  const nativeBinding = new FakeNativeBinding()
  nativeBinding.nextLeavesStopped = true
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: '1', source: 'first.flac', title: 'First' },
    { id: '2', source: 'second.flac', title: 'Second' }
  ]

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  await manager.next()
  const info = await manager.getPlaybackInfo()

  assert.equal(nativeBinding.nextCalls, 1)
  assert.deepEqual(
    nativeBinding.playCalls.map((call) => call.source),
    ['first.flac', 'second.flac']
  )
  assert.equal(info.state, 'playing')
  assert.equal(info.queueIndex, 1)
  assert.equal(info.source, 'second.flac')
})

test('switching to shuffle preserves the active stream and only updates native policy', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: '1', source: 'first.flac', title: 'First' },
    { id: '2', source: 'second.flac', title: 'Second' },
    { id: '3', source: 'third.flac', title: 'Third' }
  ]

  await manager.loadQueue(queue, 1)
  await manager.play(queue[1].source, 37)
  const before = await manager.getPlaybackInfo()
  const loadQueueCalls = nativeBinding.loadQueueCalls
  const playCalls = nativeBinding.playCalls.length
  const stopCalls = nativeBinding.stopCalls
  const seekCalls = nativeBinding.seekCalls
  const playModeCalls = nativeBinding.playModeCalls

  await manager.setPlayMode('shuffle')
  const after = await manager.getPlaybackInfo()

  assert.equal(nativeBinding.playModeCalls, playModeCalls + 1)
  // The renderer already shuffled the queue it handed over, so shuffle rides the
  // engine's listLoop: wrap that order, do not permute it a second time.
  assert.equal(nativeBinding.playbackInfo.playMode, 'listLoop')
  assert.equal(nativeBinding.loadQueueCalls, loadQueueCalls)
  assert.equal(nativeBinding.playCalls.length, playCalls)
  assert.equal(nativeBinding.stopCalls, stopCalls)
  assert.equal(nativeBinding.seekCalls, seekCalls)
  assert.equal(after.source, before.source)
  assert.equal(after.queueIndex, before.queueIndex)
  assert.equal(after.position, before.position)
  assert.equal(after.state, before.state)
})

test('natural-end authority is main-only, exact and revoked by explicit transport or decode failure', async (t) => {
  for (const action of ['stop', 'pause', 'seek', 'mode', 'error', 'upcoming'] as const) {
    await t.test(action, async (t) => {
      const native = new FakeNativeBinding()
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      await manager.loadQueue([
        { id: 'a', queueEntryId: 'occurrence:a', source: 'a.flac', duration: 60 }
      ])
      await manager.play('a.flac', 10)
      assert.equal(manager.getPlaybackEnd(), null)
      native.playbackInfo = {
        ...native.playbackInfo,
        state: 'stopped',
        upcomingTrack: null,
        position: 60
      }
      ;(manager as unknown as { tick(): void }).tick()
      const expected = manager.getPlaybackEnd()
      assert.ok(expected)
      assert.equal(expected.selection.queueToken, manager.getQueueToken())
      if (action === 'stop') await manager.stop()
      if (action === 'pause') await manager.pause()
      if (action === 'seek') await manager.seek(0)
      if (action === 'mode') await manager.setPlayMode('repeat')
      if (action === 'error' || action === 'upcoming') {
        native.playbackInfo = {
          ...native.playbackInfo,
          ...(action === 'error'
            ? {
                diagnostics: makeDiagnostics({ lastError: 'decoder failed' }),
                outputInfo: makeOutputInfo({
                  diagnostics: makeDiagnostics({ lastError: 'decoder failed' })
                })
              }
            : { upcomingTrack: { id: 'next', source: 'next.flac' } })
        }
        ;(manager as unknown as { tick(): void }).tick()
        ;(manager as unknown as { tick(): void }).tick()
        ;(manager as unknown as { tick(): void }).tick()
        ;(manager as unknown as { tick(): void }).tick()
      }
      assert.equal(manager.getPlaybackEnd(), null)
      assert.equal(
        await manager.continueAfterPlaybackEnd({
          expected,
          item: { id: 'b', source: 'b.flac' },
          playMode: 'sequential',
          isCurrent: () => true,
          onSelected: () => assert.fail('stale end selected a queue')
        }),
        false
      )
      assert.equal(native.playCalls.length, 1)
    })
  }
})

test('guarded natural-end continuation selects before starting, preserves CUE/rate/volume and consumes its authority once', async (t) => {
  const native = new FakeNativeBinding()
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  await manager.loadQueue([
    { id: 'a', queueEntryId: 'occurrence:a', source: 'disc.flac', duration: 60 }
  ])
  await manager.play('disc.flac', 10)
  await manager.setVolume(0.7)
  await manager.setPlaybackRate(1.25)
  native.playbackInfo = {
    ...native.playbackInfo,
    state: 'stopped',
    upcomingTrack: null,
    position: 60
  }
  ;(manager as unknown as { tick(): void }).tick()
  const expected = manager.getPlaybackEnd()!
  assert.ok(expected)
  const item: AudioEngineQueueItem = {
    id: 'a',
    queueEntryId: 'occurrence:b',
    source: 'disc.flac',
    duration: 60,
    cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 }
  }
  let selected = false
  manager.on('start-file', () => assert.equal(selected, true))
  const options = {
    expected,
    item,
    playMode: 'sequential' as const,
    isCurrent: () => true,
    onSelected: () => {
      selected = true
    }
  }
  assert.equal(await manager.continueAfterPlaybackEnd(options), true)
  assert.equal(await manager.continueAfterPlaybackEnd(options), false)
  assert.equal(native.playCalls.length, 2)
  assert.equal(native.playCalls[1].startTime, 0)
  const info = await manager.getPlaybackInfo()
  assert.equal(info.state, 'playing')
  assert.equal(info.volume, 0.7)
  assert.equal(info.playbackRate, 1.25)
  assert.deepEqual(manager.getQueueSnapshot()[0].cueRange, item.cueRange)
})

test('automatic URL expiry fences load/preparation but never invalidates a decoder whose Play was dispatched while valid', async (t) => {
  for (const delay of ['load', 'preparation', 'play-ack'] as const) {
    await t.test(delay, async (t) => {
      const native = new FakeNativeBinding()
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      await manager.loadQueue([{ id: 'a', queueEntryId: 'a', source: 'a.flac', duration: 60 }])
      await manager.play('a.flac', 10)
      native.playbackInfo = { ...native.playbackInfo, state: 'stopped', upcomingTrack: null }
      ;(manager as unknown as { tick(): void }).tick()
      const expected = manager.getPlaybackEnd()!
      assert.ok(expected)
      let now = 1_000
      const resolved = { source: 'https://cdn.example/short.flac', expiresAt: 2_000 }
      if (delay === 'preparation')
        Object.assign(manager, {
          prepareLoudnormForPlay: async () => {
            now = 2_000
          }
        })
      Object.assign(native, {
        callAsync: async (method: keyof NativeAudioBinding, args: unknown[]) => {
          const result = (native[method] as (...args: unknown[]) => unknown)(...args)
          if (
            (delay === 'load' && method === 'LoadQueue') ||
            (delay === 'play-ack' && method === 'Play')
          )
            now = 2_000
          return result
        }
      })
      let selections = 0
      const result = await manager.continueAfterPlaybackEnd({
        expected,
        item: { id: 'b', queueEntryId: 'b', source: resolved.source, duration: 60 },
        playMode: 'sequential',
        isCurrent: () => isAfterglowSourceCurrent(resolved, now),
        onSelected: () => {
          selections++
        }
      })
      assert.equal(result, delay === 'play-ack')
      assert.equal(selections, 1)
      assert.equal(native.playCalls.length, delay === 'play-ack' ? 2 : 1)
      assert.equal(
        (await manager.getPlaybackInfo()).state,
        delay === 'play-ack' ? 'playing' : 'stopped'
      )
      assert.equal(manager.getQueueSnapshot()[0].queueEntryId, 'b')
    })
  }
})

test('manual SQL navigation fences preparation/fallback expiry but drains dispatched playback and yields to a newer play', async (t) => {
  for (const delay of ['preparation', 'fallback-route', 'play-ack', 'restore', 'newer-play']) {
    await t.test(delay, async (t) => {
      const db = new LibraryDatabase(':memory:')
      t.after(() => db.close())
      db.replaceDocument({
        version: 2,
        revision: 0,
        folders: [],
        exclusions: [],
        tracks: [{ id: 'cue', filePath: 'disc.flac', title: 'Cue', duration: 60 }]
      })
      let queue = db.createLibraryQueue({ ids: Array(605).fill('cue'), sort: 'playlist' })
      const row = (position: number) => db.readLibraryQueue(queue.id, position, 1).items[0]
      queue = db.editLibraryQueue(queue.id, queue.revision, {
        kind: 'select',
        entryId: row(399).queueEntryId
      }).queue
      const native = new FakeNativeBinding()
      Object.assign(native, {
        RebindQueue: (json: string, index: number, mode: PlayMode) => {
          native.lastLoadedQueue = JSON.parse(json)
          native.playbackInfo = { ...native.playbackInfo, queueIndex: index, playMode: mode }
          return true
        }
      })
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      await manager.loadQueue([
        afterglowNativeQueueItem(
          { ...row(399).track, queueEntryId: row(399).queueEntryId },
          'disc.flac',
          399
        )
      ])
      await manager.play('disc.flac', 12)
      if (delay === 'fallback-route') {
        await manager.setAudioOutput('asio', 'asio:studio')
        native.failAsioPlayWith = 'ASIO device unavailable'
      }
      let now = 1_000,
        current = true,
        mapping = [399]
      t.mock.method(Date, 'now', () => now)
      const resolved = { source: 'https://cdn.example/short.flac', expiresAt: 2_000 }
      const session: NonNullable<
        ReturnType<AfterglowLibraryNavigation['session']['getCachedSession']>
      > = {
        version: 1,
        savedAt: new Date(0).toISOString(),
        mode: 'off',
        playMode: 'listLoop',
        track: { ...row(399).track, queueEntryId: row(399).queueEntryId },
        position: 12,
        libraryQueue: {
          id: queue.id,
          revision: queue.revision,
          index: 399,
          entryId: row(399).queueEntryId
        }
      }
      const states: string[] = []
      const options: AfterglowLibraryNavigation = {
        engine: manager,
        database: {
          getLibraryQueue: async (id) => db.getLibraryQueue(id),
          readLibraryQueueNeighbor: async (...args) => db.readLibraryQueueNeighbor(...args)
        },
        session: {
          getCachedSession: () => session,
          applyEngineState: async (info, selected) => {
            assert.equal(selected?.logicalIndex, 400)
            assert.equal(selected?.entryId, row(400).queueEntryId)
            assert.deepEqual(mapping, [400])
            assert.equal(manager.getQueueSnapshot()[0].queueEntryId, selected.entryId)
            queue = db.editLibraryQueue(queue.id, queue.revision, {
              kind: 'select',
              entryId: selected.entryId!
            }).queue
            states.push(info.state)
          }
        },
        resolver: { resolve: async () => resolved },
        authorize: async (source) => source,
        isCurrent: () => current,
        setMapping: (next) => {
          mapping = next
        },
        mutate: async (operation) => operation()
      }
      Object.assign(manager, {
        prepareLoudnormForPlay: async (source: string) => {
          if (source !== resolved.source) return
          if (delay === 'preparation') now = 2_000
          if (delay === 'restore') current = false
          if (delay === 'newer-play') {
            await manager.loadQueue([{ id: 'newer', source: 'newer.flac' }])
            await manager.play('newer.flac')
            now = 2_000
          }
        }
      })
      Object.assign(native, {
        callAsync: async (method: keyof NativeAudioBinding, args: unknown[]) => {
          const result = (native[method] as (...args: unknown[]) => unknown)(...args)
          if (
            (delay === 'fallback-route' && method === 'SetOutputDevice') ||
            (delay === 'play-ack' && method === 'Play')
          )
            now = 2_000
          return result
        }
      })
      const navigation = navigateAfterglowLibraryQueue(1, options)
      const expired = delay === 'preparation' || delay === 'fallback-route'
      if (expired) await assert.rejects(navigation, /afterglow_no_resumable_track/)
      else if (delay === 'newer-play') await assert.rejects(navigation, /native_playback/)
      else await navigation
      assert.equal(native.stopCalls, expired ? 1 : 0)
      assert.equal(db.getLibraryQueue(queue.id).index, delay === 'newer-play' ? 399 : 400)
      assert.deepEqual(states, delay === 'newer-play' ? [] : [expired ? 'stopped' : 'playing'])
      assert.equal(native.playCalls.length, delay === 'preparation' ? 1 : 2)
      if (delay === 'fallback-route')
        assert.equal(native.playCalls.at(-1)?.backend, 'asio', 'no expired WASAPI retry')
      const info = await manager.getPlaybackInfo()
      assert.equal(info.state, expired ? 'stopped' : 'playing')
      assert.equal(
        info.source,
        delay === 'newer-play' ? 'newer.flac' : expired ? 'disc.flac' : resolved.source
      )
    })
  }
})

test('stop or pause during the native continuation load prevents the later automatic play', async (t) => {
  for (const action of ['stop', 'pause'] as const) {
    await t.test(action, async (t) => {
      const native = new FakeNativeBinding()
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      await manager.loadQueue([{ id: 'a', queueEntryId: 'a', source: 'a.flac', duration: 60 }])
      await manager.play('a.flac', 10)
      native.playbackInfo = { ...native.playbackInfo, state: 'stopped', upcomingTrack: null }
      ;(manager as unknown as { tick(): void }).tick()
      const expected = manager.getPlaybackEnd()!
      assert.ok(expected)
      let release!: () => void, started!: () => void
      const loading = new Promise<void>((done) => {
          started = done
        }),
        reply = new Promise<void>((done) => {
          release = done
        })
      Object.assign(native, {
        callAsync: async (method: keyof NativeAudioBinding, args: unknown[]) => {
          if (method === 'LoadQueue') {
            started()
            await reply
          }
          return (native[method] as (...args: unknown[]) => unknown)(...args)
        }
      })
      let selections = 0
      const run = manager.continueAfterPlaybackEnd({
        expected,
        item: { id: 'b', queueEntryId: 'b', source: 'b.flac' },
        playMode: 'sequential',
        isCurrent: () => true,
        onSelected: () => {
          selections++
        }
      })
      await loading
      await manager[action]()
      release()
      assert.equal(await run, false)
      assert.equal(native.playCalls.length, 1)
      assert.equal(selections, 1)
      assert.equal((await manager.getPlaybackInfo()).state, 'stopped')
    })
  }
})

test('real SQLite and playback controller recover a delayed CUE successor across the full queue, not the native window', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'cue',
        title: 'Cue',
        filePath: 'disc.flac',
        duration: 60,
        cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 }
      }
    ]
  })
  let queue = db.createLibraryQueue({ ids: Array(605).fill('cue'), sort: 'playlist' })
  queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'mode', mode: 'listLoop' }).queue
  const row = (position: number) => db.readLibraryQueue(queue.id, position, 1).items[0]
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: row(604).queueEntryId
  }).queue
  const initial = afterglowNativeQueueItem(
    { ...row(604).track, queueEntryId: row(604).queueEntryId },
    'disc.flac',
    604
  )
  const native = new FakeNativeBinding()
  Object.assign(native, {
    RebindQueue: (json: string, index: number, mode: PlayMode) => {
      native.lastLoadedQueue = JSON.parse(json)
      native.playbackInfo = { ...native.playbackInfo, queueIndex: index, playMode: mode }
      return true
    }
  })
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  await manager.loadQueue([initial])
  await manager.play('disc.flac', 12)
  let started!: () => void,
    release!: () => void,
    resolves = 0
  const resolving = new Promise<void>((done) => {
      started = done
    }),
    reply = new Promise<void>((done) => {
      release = done
    })
  const errors: string[] = [],
    reads: number[] = []
  let mapping = [604]
  const core = new AfterglowLibraryQueueCore({
    engine: manager,
    nativeQueueIndices: mapping,
    readWindow: async (index, entryId) => {
      queue = db.getLibraryQueue(queue.id)
      if (queue.selectedEntryId !== entryId)
        queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId }).queue
      const window = db.readLibraryQueuePlaybackWindow(queue.id, queue.revision, index, true)
      reads.push(window.items.length)
      return { window, mode: 'listLoop' }
    },
    validateWindow: async (plan) =>
      db.getLibraryQueue(queue.id).revision === plan.window.queue.revision,
    resolver: {
      resolve: async () => {
        if (++resolves === 1) {
          started()
          await reply
        }
        return { source: 'disc.flac', expiresAt: null }
      }
    },
    authorize: async (source) => source,
    commit: async (operation, current) => {
      if (current()) await operation()
    },
    onMappingChanged: (next) => {
      mapping = next
    },
    onPlaybackAdvanced: async (_info, index, entryId) => {
      assert.equal(mapping[0], index)
      queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId }).queue
    },
    onError: (message) => errors.push(message)
  })
  t.after(() => core.stop())
  const run = core.start()
  await resolving
  native.playbackInfo = {
    ...native.playbackInfo,
    state: 'stopped',
    upcomingTrack: null,
    position: 60
  }
  ;(manager as unknown as { tick(): void }).tick()
  assert.ok(manager.getPlaybackEnd())
  core.getPlaybackEndRecoveryDeadline()
  release()
  await run
  assert.equal(db.getLibraryQueue(queue.id).index, 0)
  assert.equal(db.getLibraryQueue(queue.id).selectedEntryId, row(0).queueEntryId)
  assert.deepEqual(mapping, [0, 1])
  assert.equal(native.loadQueueCalls, 2)
  assert.equal(native.playCalls.length, 2)
  assert.equal((await manager.getPlaybackInfo()).position, 0)
  assert.equal(manager.getQueueSnapshot()[0].queueEntryId, row(0).queueEntryId)
  assert.deepEqual(manager.getQueueSnapshot()[0].cueRange, row(0).track!.cueRange)
  assert.ok(reads.every((count) => count <= 2))
  assert.deepEqual(errors, [])
})

test('unknown natural-end LoadQueue acknowledgement revokes authority without rollback or replay', async (t) => {
  const native = new FakeNativeBinding()
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  await manager.loadQueue([{ id: 'a', queueEntryId: 'a', source: 'a.flac', duration: 60 }])
  await manager.play('a.flac', 10)
  native.playbackInfo = { ...native.playbackInfo, state: 'stopped', upcomingTrack: null }
  ;(manager as unknown as { tick(): void }).tick()
  const expected = manager.getPlaybackEnd()!
  let loads = 0
  Object.assign(native, {
    callAsync: async (method: keyof NativeAudioBinding, args: unknown[]) => {
      if (method === 'LoadQueue') {
        loads++
        throw new Error('lost native load acknowledgement')
      }
      return (native[method] as (...args: unknown[]) => unknown)(...args)
    }
  })
  await assert.rejects(
    manager.continueAfterPlaybackEnd({
      expected,
      item: { id: 'b', queueEntryId: 'b', source: 'b.flac' },
      playMode: 'sequential',
      isCurrent: () => true,
      onSelected: () => assert.fail('unknown load published')
    })
  )
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(loads, 1)
  assert.equal(manager.getQueueToken(), '')
  assert.equal(native.playCalls.length, 1)
})

test('automatic continuation preparation yields to seek, mode and pause without changing ordinary play preparation', async (t) => {
  for (const automatic of [false, true]) {
    for (const action of ['seek', 'mode', 'pause'] as const) {
      await t.test(`${automatic ? 'automatic' : 'explicit'} ${action}`, async (t) => {
        const native = new FakeNativeBinding()
        const manager = makeManager({ exclusiveMode: false }, native)
        t.after(() => manager.destroy())
        await manager.loadQueue([{ id: 'a', queueEntryId: 'a', source: 'a.flac', duration: 60 }])
        await manager.play('a.flac', 10)
        native.playbackInfo = { ...native.playbackInfo, state: 'stopped', upcomingTrack: null }
        ;(manager as unknown as { tick(): void }).tick()
        const expected = manager.getPlaybackEnd()!
        let started!: () => void, release!: () => void
        const preparing = new Promise<void>((done) => {
            started = done
          }),
          reply = new Promise<void>((done) => {
            release = done
          })
        Object.assign(manager, {
          prepareLoudnormForPlay: async () => {
            started()
            await reply
          }
        })
        const run = automatic
          ? manager.continueAfterPlaybackEnd({
              expected,
              item: { id: 'b', queueEntryId: 'b', source: 'b.flac', duration: 60 },
              playMode: 'sequential',
              isCurrent: () => true,
              onSelected: () => {}
            })
          : manager.play('a.flac', 0).then((result) => result.nativeStarted)
        await preparing
        if (action === 'seek') await manager.seek(22)
        if (action === 'mode') await manager.setPlayMode('repeat')
        if (action === 'pause') await manager.pause()
        release()
        assert.equal(await run, !automatic)
        assert.equal(native.playCalls.length, automatic ? 1 : 2)
      })
    }
  }
})

test('owner restore drains an issued automatic native Play acknowledgement and retains its confirmed playing state', async (t) => {
  const native = new FakeNativeBinding()
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  await manager.loadQueue([{ id: 'a', queueEntryId: 'a', source: 'a.flac', duration: 60 }])
  await manager.play('a.flac', 10)
  native.playbackInfo = { ...native.playbackInfo, state: 'stopped', upcomingTrack: null }
  ;(manager as unknown as { tick(): void }).tick()
  const expected = manager.getPlaybackEnd()!
  let started!: () => void,
    release!: () => void,
    current = true
  const dispatched = new Promise<void>((done) => {
      started = done
    }),
    reply = new Promise<void>((done) => {
      release = done
    })
  Object.assign(native, {
    callAsync: async (method: keyof NativeAudioBinding, args: unknown[]) => {
      const result = (native[method] as (...args: unknown[]) => unknown)(...args)
      if (method === 'Play') {
        started()
        await reply
      }
      return result
    }
  })
  const run = manager.continueAfterPlaybackEnd({
    expected,
    item: { id: 'b', queueEntryId: 'b', source: 'b.flac', duration: 60 },
    playMode: 'sequential',
    isCurrent: () => current,
    onSelected: () => {}
  })
  await dispatched
  current = false
  release()
  assert.equal(await run, true)
  assert.equal((await manager.getPlaybackInfo()).state, 'playing')
  assert.equal((await manager.getPlaybackInfo()).source, 'b.flac')
  assert.equal(manager.getQueueSnapshot()[0].queueEntryId, 'b')
  assert.equal(native.playCalls.length, 2)
})

test('a native stop mid-queue is not reported as a queue end while an upcoming track exists', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: 'first', source: 'first.flac', title: 'First' },
    { id: 'last', source: 'last.flac', title: 'Last' }
  ]
  const boundaries: Array<'trackEnd' | 'queueEnd'> = []
  manager.on('sleep-timer-boundary', ({ boundary }) => boundaries.push(boundary))

  await manager.loadQueue(queue, 1)
  await manager.play(queue[1].source, 0)
  // The engine reports a stop while it still has somewhere to go — a device
  // hiccup or a repeating queue, not the end of playback. The old index-based
  // check called this a queue end because the index was already the last one.
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'stopped',
    queueIndex: 1,
    upcomingTrack: { id: 'first', source: 'first.flac', title: 'First' }
  }

  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  tickManager.tick()

  assert.deepEqual(boundaries, [])
})

test('a delegated listLoop queue reports trackEnd then queueEnd when it wraps', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: 'first', source: 'first.flac', title: 'First' },
    { id: 'last', source: 'last.flac', title: 'Last' }
  ]
  const boundaries: Array<'trackEnd' | 'queueEnd'> = []
  manager.on('sleep-timer-boundary', ({ boundary }) => boundaries.push(boundary))

  await manager.loadQueue(queue, 1)
  await manager.setPlayMode('listLoop')
  await manager.play(queue[1].source, 0)
  // A looping engine never stops, so wrapping past the last entry is the only
  // queue boundary it will ever produce. Without this a "stop at end of queue"
  // timer would never fire once the queue is delegated.
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'playing',
    source: queue[0].source,
    queueIndex: 0,
    upcomingTrack: { id: 'last', source: 'last.flac', title: 'Last' }
  }

  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()

  assert.deepEqual(boundaries, ['trackEnd', 'queueEnd'])
})

test('a delegated sequential queue does not report a queue end on an ordinary advance', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: 'first', source: 'first.flac', title: 'First' },
    { id: 'last', source: 'last.flac', title: 'Last' }
  ]
  const boundaries: Array<'trackEnd' | 'queueEnd'> = []
  manager.on('sleep-timer-boundary', ({ boundary }) => boundaries.push(boundary))

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'playing',
    source: queue[1].source,
    queueIndex: 1,
    upcomingTrack: null
  }

  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()

  assert.deepEqual(boundaries, ['trackEnd'])
})

test('native serials report same-index repeats and skipped logical cycles without counting explicit transport', async () => {
  const native = new FakeNativeBinding()
  const zero = { trackSerial: 0, queueSerial: 0, trackTimeMs: 0, queueTimeMs: 0 }
  native.playbackInfo.naturalBoundaries = { ...zero }
  const manager = makeManager(
    { exclusiveMode: true, audioOutput: 'wasapi', audioDevice: 'auto' },
    native
  )
  const boundaries: Array<{ boundary: string; occurredAt?: number }> = []
  manager.on('sleep-timer-boundary', (event) => boundaries.push(event))
  await manager.loadQueue([{ id: 'same', source: 'disc.flac', logicalQueueEnd: false }], 0)
  await manager.setPlayMode('repeat')
  await manager.play('disc.flac', 0)
  const tick = () => (manager as unknown as { tick(): void }).tick()
  tick()
  native.playbackInfo.naturalBoundaries = {
    trackSerial: 3,
    queueSerial: 0,
    trackTimeMs: 2000,
    queueTimeMs: 0
  }
  tick()
  tick()
  assert.deepEqual(boundaries, [{ boundary: 'trackEnd', occurredAt: 2000 }])
  await manager.seek(0)
  await manager.next()
  await manager.previous()
  await manager.stop()
  await manager.play('disc.flac', 0)
  tick()
  assert.equal(boundaries.length, 1)
  native.playbackInfo.naturalBoundaries = {
    trackSerial: 9,
    queueSerial: 2,
    trackTimeMs: 6000,
    queueTimeMs: 5000
  }
  tick()
  assert.deepEqual(boundaries.slice(1), [
    { boundary: 'trackEnd', occurredAt: 6000 },
    { boundary: 'queueEnd', occurredAt: 5000 }
  ])
})

test('native logical EOF is authoritative before renderer EOF and stale boundaries cannot trigger a rearmed timer', async () => {
  const native = new FakeNativeBinding()
  native.playbackInfo.naturalBoundaries = {
    trackSerial: 0,
    queueSerial: 0,
    trackTimeMs: 0,
    queueTimeMs: 0
  }
  const manager = makeManager(
    { exclusiveMode: true, audioOutput: 'wasapi', audioDevice: 'auto' },
    native
  )
  let now = 3000
  const timer = new SleepTimerService({ now: () => now })
  registerNativeSleepTimerBoundaries(manager, timer)
  const events: string[] = []
  manager.on('sleep-timer-boundary', ({ boundary }) => events.push(boundary))
  manager.on('property-change', ({ name }) => {
    if (name === 'eof-reached') events.push(name)
  })
  await manager.loadQueue([{ id: 'last', source: 'last.flac', logicalQueueEnd: true }], 0)
  await manager.play('last.flac', 0)
  timer.configure(createSleepTimerState('queueEnd', now, { defaultMinutes: 1, fadeSeconds: 0 }))
  native.playbackInfo = {
    ...native.playbackInfo,
    state: 'stopped',
    upcomingTrack: null,
    naturalBoundaries: { trackSerial: 1, queueSerial: 1, trackTimeMs: 2000, queueTimeMs: 2000 }
  }
  const tick = () => (manager as unknown as { tick(): void }).tick()
  tick()
  assert.equal(timer.snapshot()?.active, true)
  assert.deepEqual(events, ['trackEnd', 'queueEnd', 'eof-reached'])
  now = 4000
  native.playbackInfo.naturalBoundaries = {
    trackSerial: 2,
    queueSerial: 2,
    trackTimeMs: 4000,
    queueTimeMs: 4000
  }
  for (let i = 0; i < 4; i++) tick() // Stopped native output polls every fourth tick.
  assert.equal(timer.snapshot()?.triggered, true)
})

test('legacy bindings project explicit SQL end metadata instead of treating every resident window as a full queue', async () => {
  for (const logicalEnd of [false, true]) {
    const native = new FakeNativeBinding()
    const manager = makeManager(
      { exclusiveMode: true, audioOutput: 'wasapi', audioDevice: 'auto' },
      native
    )
    const queue = [
      { id: 'same', source: 'disc.flac', logicalQueueEnd: logicalEnd },
      { id: 'same', source: 'disc.flac', logicalQueueEnd: false }
    ]
    const boundaries: string[] = []
    manager.on('sleep-timer-boundary', ({ boundary }) => boundaries.push(boundary))
    await manager.loadQueue(queue, 0)
    await manager.play('disc.flac', 0)
    native.playbackInfo = { ...native.playbackInfo, queueIndex: 1, state: 'playing' }
    const tick = () => (manager as unknown as { tick(): void }).tick()
    tick()
    assert.deepEqual(boundaries, logicalEnd ? ['trackEnd', 'queueEnd'] : ['trackEnd'])
    boundaries.length = 0
    native.playbackInfo = { ...native.playbackInfo, state: 'stopped', upcomingTrack: null }
    tick()
    assert.deepEqual(boundaries, ['trackEnd'], 'end of the short window is not global EOF')
  }
})

test('shuffle next accepts the native non-adjacent queue target', async () => {
  const nativeBinding = new FakeNativeBinding()
  nativeBinding.nextTargetIndex = 3
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: '1', source: 'first.flac', title: 'First' },
    { id: '2', source: 'second.flac', title: 'Second' },
    { id: '3', source: 'third.flac', title: 'Third' },
    { id: '4', source: 'fourth.flac', title: 'Fourth' }
  ]

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  await manager.setPlayMode('shuffle')
  await manager.next()
  const info = await manager.getPlaybackInfo()

  assert.equal(nativeBinding.nextCalls, 1)
  assert.equal(nativeBinding.playCalls.length, 1)
  assert.equal(info.queueIndex, 3)
  assert.equal(info.source, 'fourth.flac')
  assert.equal(info.state, 'playing')
})

test('next falls back to target track when native Next reports stale playback info', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue = [
    { id: '1', source: 'first.flac', title: 'First' },
    { id: '2', source: 'second.flac', title: 'Second' }
  ]

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  await manager.next()
  const info = await manager.getPlaybackInfo()

  assert.equal(nativeBinding.nextCalls, 1)
  assert.deepEqual(
    nativeBinding.playCalls.map((call) => call.source),
    ['first.flac', 'second.flac']
  )
  assert.equal(info.queueIndex, 1)
  assert.equal(info.source, 'second.flac')
})

test('audio service next waits for Next ack before falling back to Play', async () => {
  const service = new DeferredNextAudioServiceBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const queue = [
    { id: '1', source: 'first.flac', title: 'First' },
    { id: '2', source: 'second.flac', title: 'Second' }
  ]

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  const nextPromise = manager.next()
  let resolved = false
  nextPromise.then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.equal(service.nextCalls, 1)
  assert.equal(service.playCalls, 1)

  service.resolveNext()
  await nextPromise
  const info = await manager.getPlaybackInfo()

  assert.equal(service.playCalls, 1)
  assert.equal(resolved, true)
  assert.equal(info.state, 'playing')
  assert.equal(info.queueIndex, 1)
  assert.equal(info.source, 'second.flac')

  manager.destroy()
})

test('a delayed startup play cannot replace the song selected by next', async (t) => {
  const native = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: { dspEnabled: true, volumeNormalization: 'loudnorm' }
    },
    native
  )
  t.after(() => manager.destroy())
  const queue = [
    { id: '1', source: 'first.flac' },
    { id: '2', source: 'second.flac' }
  ]
  await manager.loadQueue(queue, 0)
  let releaseLookup!: (value: null) => void
  manager.setLoudnessAnalysisManager({
    peekCached: ({ filePath }: { filePath: string }) =>
      filePath === queue[0].source
        ? new Promise((resolve) => {
            releaseLookup = resolve
          })
        : Promise.resolve(null),
    cancel() {},
    requestAnalysis: async () => ({ status: 'skipped', reason: 'cancelled' })
  } as never)

  const startupPlay = manager.play(queue[0].source)
  await manager.next()
  releaseLookup(null)
  assert.equal((await startupPlay).superseded, true)

  assert.deepEqual(
    native.playCalls.map((call) => call.source),
    ['second.flac']
  )
  assert.equal(native.playbackInfo.source, 'second.flac')
  assert.equal((await manager.getPlaybackInfo()).source, 'second.flac')
})

test('a delayed Play acknowledgement cannot publish the previous song after next', async (t) => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  t.after(() => manager.destroy())
  const queue = [
    { id: '1', source: 'first.flac' },
    { id: '2', source: 'second.flac' }
  ]
  await manager.loadQueue(queue, 0)
  service.Play = (source = '', startTime = 0) => {
    service.playCalls += 1
    service.playbackInfo = makePlaybackInfo({
      state: 'playing',
      source,
      position: startTime,
      queueIndex: service.queueIndex,
      nativePlaybackActive: true
    })
  }
  let releaseAck!: () => void
  let notifyStarted!: () => void
  const ack = new Promise<void>((resolve) => {
    releaseAck = resolve
  })
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const originalCall = service.callAsync.bind(service)
  service.callAsync = async (method, args) => {
    const result = await originalCall(method, args)
    if (method === 'Play' && args[0] === queue[0].source) {
      notifyStarted()
      await ack
    }
    return result
  }
  const startupPlay = manager.play(queue[0].source)
  await started
  await manager.next()
  const publishedSources: string[] = []
  manager.on('playback-info', (info) => publishedSources.push(info.source))
  releaseAck()
  assert.equal((await startupPlay).superseded, true)

  assert.equal(service.playbackInfo.source, 'second.flac')
  assert.equal((await manager.getPlaybackInfo()).source, 'second.flac')
  assert.deepEqual(publishedSources, [])
})

for (const [direction, startIndex, targetIndex] of [
  ['next', 0, 1],
  ['previous', 1, 0]
] as const) {
  test(`${direction} cannot restart playback after a newer stop`, async (t) => {
    const service = new FakeAudioServiceBinding()
    Object.assign(service, { Next: () => {}, Previous: () => {} })
    const manager = new AudioEngineManager(
      { exclusiveMode: true, audioOutput: 'wasapi', audioDevice: 'auto' },
      {
        audioServiceFactory: () => service,
        scheduler: TEST_SCHEDULER,
        deviceOptionsProvider: () => DEVICE_OPTIONS
      }
    )
    t.after(() => manager.destroy())
    const queue = [
      { id: '1', source: 'first.flac', title: 'First' },
      { id: '2', source: 'second.flac', title: 'Second' }
    ]
    await manager.loadQueue(queue, startIndex)
    await manager.play(queue[startIndex].source, 0)

    let releaseAdvance!: () => void
    let notifyStarted!: () => void
    const pendingAck = new Promise<void>((resolve) => {
      releaseAdvance = resolve
    })
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const nativeMethod = direction === 'next' ? 'Next' : 'Previous'
    const originalCallAsync = service.callAsync.bind(service)
    service.callAsync = async (method, args) => {
      if (method !== nativeMethod) return originalCallAsync(method, args)
      service.callOrder.push(method)
      service.queueIndex = targetIndex
      service.playbackInfo = makePlaybackInfo({
        state: 'playing',
        source: queue[targetIndex].source,
        queueIndex: targetIndex,
        nativePlaybackActive: true
      })
      notifyStarted()
      await pendingAck
      return undefined
    }

    const advance = manager[direction]()
    await started
    await manager.stop()
    releaseAdvance()
    await advance

    assert.equal(service.playCalls, 1)
    assert.equal(service.playbackInfo.state, 'stopped')
    assert.equal((await manager.getPlaybackInfo()).state, 'stopped')
  })
}

test('audio service loadQueue waits for queue and play mode confirmations in order', async () => {
  const service = new DeferredAudioServiceBinding(['LoadQueue', 'SetPlayMode'])
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const queue: AudioEngineQueueItem[] = [
    { id: 'ncm:one', source: 'https://stream.example/one.flac', title: 'One' }
  ]
  let resolved = false

  const loadPromise = manager.loadQueue(queue, 0).then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['LoadQueue']
  )
  assert.deepEqual(service.queue, [])

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(resolved, false)
  assert.deepEqual(service.queue, queue)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetPlayMode']
  )

  service.resolveNextDeferredCall()
  await loadPromise

  assert.equal(resolved, true)
  manager.destroy()
})

test('queue cursor reuse verifies content token and CUE identity before native selection', async (t) => {
  const nativeBinding = new FakeNativeBinding()
  const selected: number[] = []
  Object.assign(nativeBinding, {
    SelectQueueIndex: (index: number) => {
      selected.push(index)
      nativeBinding.playbackInfo.queueIndex = index
    }
  })
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding
  )
  t.after(() => manager.destroy())
  const queue: AudioEngineQueueItem[] = [
    {
      id: 'cue:1',
      source: 'disc.flac',
      cueRange: {
        startSeconds: 0,
        endSeconds: 60,
        pregapSeconds: 0,
        virtualPregapSeconds: 0,
        sourcePregapSeconds: 0
      }
    },
    {
      id: 'cue:2',
      source: 'disc.flac',
      cueRange: {
        startSeconds: 60,
        endSeconds: 120,
        pregapSeconds: 0,
        virtualPregapSeconds: 0,
        sourcePregapSeconds: 0
      }
    }
  ]
  await manager.loadQueue(queue, 0)
  const queueToken = manager.getQueueToken()
  assert.ok(queueToken)
  const selection = { queueToken, index: 1, id: 'cue:2', source: 'disc.flac' }
  assert.equal(await manager.selectQueueItem({ ...selection, queueToken: 'stale' }), false)
  assert.equal(await manager.selectQueueItem({ ...selection, id: 'cue:1' }), false)
  assert.equal(await manager.selectQueueItem({ ...selection, source: 'other.flac' }), false)
  assert.deepEqual(selected, [])
  assert.equal(await manager.selectQueueItem(selection), true)
  assert.deepEqual(selected, [1])
  assert.equal((await manager.getPlaybackInfo()).queueIndex, 1)
  assert.equal(nativeBinding.loadQueueCalls, 1)
  await manager.loadQueue([{ ...queue[0], replayGainTrackGainDb: -3 }, queue[1]], 1)
  assert.notEqual(manager.getQueueToken(), queueToken)
  assert.equal(await manager.selectQueueItem(selection), false)
  assert.deepEqual(selected, [1])
})

test('conditional queue rebind preserves playback and commits only confirmed authority', async (t) => {
  for (const state of ['playing', 'paused'] as const) {
    await t.test(state, async (t) => {
      const native = new FakeNativeBinding()
      const calls: unknown[][] = []
      Object.assign(native, {
        RebindQueue: (...args: unknown[]) => {
          calls.push(args)
          return true
        }
      })
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      const current = { id: 'current', source: 'current.flac' }
      await manager.loadQueue([{ id: 'old', source: 'old.flac' }, current], 1)
      await manager.play(current.source, 42)
      if (state === 'paused') await manager.togglePause()
      const before = await manager.getPlaybackInfo()
      const oldToken = manager.getQueueToken()
      const items = [
        { ...current, queueEntryId: 'sql:0' },
        { id: 'next', source: 'next.flac' }
      ]
      const commit = await manager.rebindQueue({
        expected: { queueToken: oldToken, index: 1, ...current },
        items,
        startIndex: 0,
        playMode: 'sequential'
      })
      assert.ok(commit?.queueToken)
      assert.notEqual(commit.queueToken, oldToken)
      assert.deepEqual(calls, [
        [JSON.stringify(items), 0, 'sequential', JSON.stringify(current), 1]
      ])
      assert.deepEqual(manager.getQueueSnapshot(), items)
      // Native transport is never invoked by a queue-only handoff.
      assert.equal(native.playCalls.length, 1)
      assert.equal(native.stopCalls, 0)
      assert.equal(native.seekCalls, 0)
      assert.equal(native.loadQueueCalls, 1)
      assert.equal(native.playModeCalls, 1)
      assert.equal(before.state, state)
      assert.equal(native.playbackInfo.state, before.state)
      assert.equal(native.playbackInfo.position, before.position)
    })
  }
})

test('conditional queue rebind rejects stale authority, CUE changes and unsupported bindings', async (t) => {
  const native = new FakeNativeBinding()
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  const current: AudioEngineQueueItem = {
    id: 'cue',
    source: 'disc.flac',
    cueRange: {
      startSeconds: 0,
      endSeconds: 60,
      pregapSeconds: 0,
      virtualPregapSeconds: 0,
      sourcePregapSeconds: 0
    }
  }
  await manager.loadQueue([current], 0)
  const queueToken = manager.getQueueToken()
  const request = {
    expected: { queueToken, index: 0, id: current.id, source: current.source },
    items: [current],
    startIndex: 0,
    playMode: 'sequential' as const
  }
  assert.equal(await manager.rebindQueue(request), null)
  let calls = 0
  Object.assign(native, {
    RebindQueue: () => {
      calls++
      return false
    }
  })
  for (const expected of [
    { ...request.expected, queueToken: 'stale' },
    { ...request.expected, index: 1 },
    { ...request.expected, id: 'wrong' },
    { ...request.expected, source: 'wrong.flac' }
  ])
    assert.equal(await manager.rebindQueue({ ...request, expected }), null)
  assert.equal(
    await manager.rebindQueue({
      ...request,
      items: [{ ...current, cueRange: { ...current.cueRange!, startSeconds: 30 } }]
    }),
    null
  )
  assert.equal(calls, 0)
  assert.equal(manager.getQueueToken(), queueToken)
  assert.equal(await manager.rebindQueue(request), null)
  assert.equal(calls, 1)
  assert.equal(manager.getQueueToken(), queueToken, 'native false guarantees no mutation')
  assert.deepEqual(manager.getQueueSnapshot(), [current])
})

test('unknown queue rebind revokes authority without rollback or replay', async (t) => {
  for (const reply of ['lost', 'malformed'] as const) {
    await t.test(reply, async (t) => {
      const native = new FakeNativeBinding()
      let calls = 0
      Object.assign(native, {
        RebindQueue: () => {
          calls++
          if (reply === 'lost') throw new Error('reply lost')
          return undefined
        }
      })
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      const current = { id: 'a', source: 'a.flac' }
      await manager.loadQueue([current], 0)
      const expected = { ...current, queueToken: manager.getQueueToken(), index: 0 }
      await assert.rejects(
        manager.rebindQueue({ expected, items: [current], startIndex: 0, playMode: 'sequential' }),
        /reply lost|Invalid native queue rebind reply/
      )
      assert.equal(manager.getQueueToken(), '')
      assert.equal(calls, 1)
      assert.equal(native.loadQueueCalls, 1)
      assert.equal(
        await manager.rebindQueue({
          expected,
          items: [current],
          startIndex: 0,
          playMode: 'sequential'
        }),
        null
      )
      assert.equal(calls, 1)
    })
  }
})

test('late queue rebind cannot overwrite or revoke a newer queue', async (t) => {
  for (const reply of [true, false, new Error('late failure')]) {
    await t.test(String(reply), async (t) => {
      const native = new FakeNativeBinding()
      let resolve!: (value: boolean) => void
      let reject!: (error: Error) => void
      Object.assign(native, {
        RebindQueue: () =>
          new Promise<boolean>((yes, no) => {
            resolve = yes
            reject = no
          })
      })
      const manager = makeManager({ exclusiveMode: false }, native)
      t.after(() => manager.destroy())
      const current = { id: 'a', source: 'a.flac' }
      await manager.loadQueue([current], 0)
      const pending = manager.rebindQueue({
        expected: { ...current, index: 0, queueToken: manager.getQueueToken() },
        items: [current],
        startIndex: 0,
        playMode: 'sequential'
      })
      const newer = [{ id: 'newer', source: 'newer.flac' }]
      await manager.loadQueue(newer, 0)
      const newerToken = manager.getQueueToken()
      if (reply instanceof Error) reject(reply)
      else resolve(reply)
      if (reply === false) assert.equal(await pending, null)
      else await assert.rejects(pending, /superseded|late failure/)
      assert.deepEqual(manager.getQueueSnapshot(), newer)
      assert.equal(manager.getQueueToken(), newerToken)
      assert.equal(native.loadQueueCalls, 2)
    })
  }
})

test('explicit queue recovery forces native Stop even when the host mirror was never playing', async (t) => {
  const native = new FakeNativeBinding()
  Object.assign(native, {
    RebindQueue: () => {
      native.playbackInfo = makePlaybackInfo({
        state: 'playing',
        source: 'same.flac',
        queueIndex: 1
      })
      throw new Error('lost queue reply')
    }
  })
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  const item = { id: 'duplicate', source: 'same.flac' }
  await manager.loadQueue([item])
  await assert.rejects(manager.stopForQueueRecovery(), /queue_changed/)
  assert.equal(native.stopCalls, 0, 'a known queue must retain its normal live restore contract')
  await assert.rejects(
    manager.rebindQueue({
      expected: { ...item, queueToken: manager.getQueueToken(), index: 0 },
      items: [item, item],
      startIndex: 0,
      playMode: 'sequential'
    }),
    /lost queue reply/
  )
  const proof = await manager.stopForQueueRecovery()
  assert.equal(native.stopCalls, 1)
  assert.equal(native.playbackInfo.state, 'stopped')
  assert.equal(manager.getQueueToken(), '', 'Stop does not prove queue identity')
  assert.equal(manager.isQueueRecoveryCurrent(proof), true)
  assert.equal(native.loadQueueCalls, 1)
  assert.deepEqual(native.playCalls, [])
  await manager.setVolume(0.4)
  assert.equal(manager.isQueueRecoveryCurrent(proof), true)
  await manager.loadQueue([{ id: 'new', source: 'new.flac' }])
  assert.equal(manager.isQueueRecoveryCurrent(proof), false)
})

test('stopped queue recovery requires both the service ACK and a fresh stopped readback', async (t) => {
  for (const failure of ['stop-reply', 'read-reply', 'still-playing'] as const) {
    await t.test(failure, async (t) => {
      const service = new FakeAudioServiceBinding()
      const manager = makeManager({ exclusiveMode: false }, service)
      t.after(() => manager.destroy())
      const methods: string[] = []
      const call = service.callAsync.bind(service)
      service.callAsync = async (method, args) => {
        methods.push(method)
        if (method === 'Stop') {
          if (failure !== 'still-playing') service.Stop()
          if (failure === 'stop-reply') throw new Error('Stop ACK lost')
          return
        }
        if (method === 'GetPlaybackInfo' && failure === 'read-reply')
          throw new Error('read ACK lost')
        return call(method, args)
      }
      await assert.rejects(manager.stopForQueueRecovery(), /recovery_stop_failed/)
      assert.equal(methods.filter((method) => method === 'Stop').length, 1)
      assert.equal(methods.includes('LoadQueue'), false)
      assert.equal(methods.includes('Play'), false)
      assert.equal(manager.isQueueRecoveryCurrent(1), false)
    })
  }
})

test('late recovery Stop acknowledgement cannot adopt or stop a newer user queue', async (t) => {
  const service = new FakeAudioServiceBinding()
  const manager = makeManager({ exclusiveMode: false }, service)
  t.after(() => manager.destroy())
  let acknowledge!: () => void
  const call = service.callAsync.bind(service)
  service.callAsync = async (method, args) => {
    if (method !== 'Stop') return call(method, args)
    service.Stop()
    await new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    return undefined
  }
  const recovery = manager.stopForQueueRecovery()
  const rejected = assert.rejects(recovery, /queue_changed/)
  await manager.loadQueue([{ id: 'new', source: 'new.flac' }])
  const token = manager.getQueueToken()
  acknowledge()
  await rejected
  assert.equal(service.stopCalls, 1)
  assert.equal(manager.getQueueToken(), token)
  assert.equal(manager.isQueueRecoveryCurrent(1), false)
})

test('native service crash and ready epochs revoke a previously confirmed recovery Stop', async (t) => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  t.after(() => manager.destroy())
  const proof = await manager.stopForQueueRecovery()
  assert.equal(manager.isQueueRecoveryCurrent(proof), true)
  service.emit('crash', 'recovery fixture crash')
  assert.equal(manager.isQueueRecoveryCurrent(proof), false)
  const next = await manager.stopForQueueRecovery()
  assert.equal(manager.isQueueRecoveryCurrent(next), true)
  service.emit('ready')
  assert.equal(manager.isQueueRecoveryCurrent(next), false)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(service.playCalls, 0)
})

test('playback snapshots expose queue authority only for a matching native source', async (t) => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding,
    { now: () => now }
  )
  t.after(() => manager.destroy())
  const events: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => events.push(info))
  await manager.loadQueue(
    [
      { id: 'ncm:a', source: 'https://cdn.test/a.flac' },
      { id: 'ncm:b', source: 'https://cdn.test/b.flac' }
    ],
    0
  )
  await manager.play('https://cdn.test/a.flac')
  const token = manager.getQueueToken()
  assert.equal((await manager.getPlaybackInfo()).queueToken, token)
  assert.ok(events.some((event) => event.queueToken === token))

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    source: 'https://cdn.test/b.flac',
    queueIndex: 1
  }
  now += 1000
  const promoted = await manager.getPlaybackInfo()
  assert.equal(promoted.queueIndex, 1)
  assert.equal(promoted.queueToken, token)

  await manager.loadQueue([{ id: 'ncm:c', source: 'https://cdn.test/c.flac' }], 0)
  now += 1000
  assert.equal((await manager.getPlaybackInfo()).queueToken, undefined)
})

test('queue hot update appends and refreshes future sources without reloading', async (t) => {
  const nativeBinding = new FakeNativeBinding()
  const calls: Array<{ method: string; args: unknown[] }> = []
  Object.assign(nativeBinding, {
    AppendQueueItems: (json: string) => {
      calls.push({ method: 'AppendQueueItems', args: [json] })
    },
    UpdateQueueItemSource: (index: number, source: string) => {
      calls.push({ method: 'UpdateQueueItemSource', args: [index, source] })
    }
  })
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding
  )
  t.after(() => manager.destroy())
  assert.equal(manager.getQueueHotUpdateCapability(), null)
  Object.assign(nativeBinding, {
    GetEngineCapabilities: () =>
      JSON.stringify({
        queueHotUpdate: {
          version: 1,
          append: true,
          updateSource: true,
          upcomingIndex: true
        }
      })
  })
  assert.deepEqual(manager.getQueueHotUpdateCapability(), {
    version: 1,
    append: true,
    updateSource: true,
    upcomingIndex: true
  })
  assert.deepEqual(await manager.getQueueHotUpdateCapabilityAsync(), {
    version: 1,
    append: true,
    updateSource: true,
    upcomingIndex: true
  })
  await manager.loadQueue(
    [
      { id: 'ncm:a', source: 'https://cdn.test/a.flac' },
      { id: 'ncm:b', source: 'https://cdn.test/b.flac' }
    ],
    0
  )
  const appendEvents: unknown[] = []
  manager.on('queue-appended', (payload: unknown) => appendEvents.push(payload))

  const firstIndex = await manager.appendQueueItems([
    { id: 'ncm:c', source: 'https://cdn.test/c.flac' }
  ])
  assert.equal(firstIndex, 2)
  assert.deepEqual(
    manager.getQueueSnapshot().map((item) => item.source),
    ['https://cdn.test/a.flac', 'https://cdn.test/b.flac', 'https://cdn.test/c.flac']
  )
  assert.equal(nativeBinding.loadQueueCalls, 1, 'append must not reload the queue')
  assert.equal(calls.filter((call) => call.method === 'AppendQueueItems').length, 1)
  assert.deepEqual(appendEvents, [{ firstIndex: 2, count: 1, queueToken: manager.getQueueToken() }])

  assert.equal(await manager.updateQueueItemSource(2, 'https://cdn.test/c.flac?sig=2'), true)
  assert.equal(manager.getQueueSnapshot()[2].source, 'https://cdn.test/c.flac?sig=2')
  assert.equal(nativeBinding.loadQueueCalls, 1)
  assert.equal(calls.filter((call) => call.method === 'UpdateQueueItemSource').length, 1)
  // The active item is already open; hot-swapping it is a contract violation.
  await assert.rejects(
    () => manager.updateQueueItemSource(0, 'https://cdn.test/a.flac?sig=2'),
    /cannot be hot-updated/
  )
  await assert.rejects(() => manager.updateQueueItemSource(9, 'x'), /out of range/)
})

test('service capability probe asks the utility process for the full native JSON', async (t) => {
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    new FakeNativeBinding()
  )
  t.after(() => manager.destroy())
  const calls: string[] = []
  const binding = {
    GetEngineCapabilities: () => JSON.stringify({}),
    getEngineCapabilitiesAsync: async () => {
      calls.push('async')
      return JSON.stringify({
        queueHotUpdate: {
          version: 1,
          append: true,
          updateSource: true,
          upcomingIndex: true
        }
      })
    },
    destroy: () => {}
  }
  ;(manager as unknown as { audioServiceBinding: typeof binding }).audioServiceBinding = binding
  assert.deepEqual(await manager.getQueueHotUpdateCapabilityAsync(), {
    version: 1,
    append: true,
    updateSource: true,
    upcomingIndex: true
  })
  assert.deepEqual(calls, ['async'])
})

test('queue hot update capability falls back to the native queue-state probe', async (t) => {
  const nativeBinding = new FakeNativeBinding()
  Object.assign(nativeBinding, {
    GetEngineCapabilities: () => JSON.stringify({}),
    GetQueueState: () =>
      JSON.stringify({
        revision: 4,
        size: 2,
        currentIndex: 0,
        upcomingIndex: 1,
        playMode: 'sequential'
      })
  })
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding
  )
  t.after(() => manager.destroy())
  assert.deepEqual(await manager.getQueueHotUpdateCapabilityAsync(), {
    version: 1,
    append: true,
    updateSource: true,
    upcomingIndex: true
  })
})

test('loadQueue skips native call and queue fanout when normalized queue is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue: AudioEngineQueueItem[] = [
    { id: 'local:one', source: 'one.flac', title: 'One' },
    { id: 'local:two', source: 'two.flac', title: 'Two' }
  ]
  const queueChanges: AudioEngineQueueItem[][] = []
  manager.on('queue-change', (items: AudioEngineQueueItem[]) => queueChanges.push(items))

  await manager.loadQueue(queue, 1)
  assert.equal(nativeBinding.loadQueueCalls, 1)
  assert.equal(nativeBinding.playModeCalls, 1)
  assert.deepEqual(nativeBinding.lastLoadedQueue, queue)
  assert.equal(nativeBinding.lastLoadedQueueIndex, 1)
  assert.equal(queueChanges.length, 1)

  await manager.loadQueue(
    queue.map((item) => ({ ...item })),
    99
  )
  assert.equal(nativeBinding.loadQueueCalls, 1)
  assert.equal(nativeBinding.playModeCalls, 1)
  assert.deepEqual(nativeBinding.lastLoadedQueue, queue)
  assert.equal(nativeBinding.lastLoadedQueueIndex, 1)
  assert.equal(queueChanges.length, 1)
})

test('changing only a duplicate occurrence invalidates native queue authority', async (t) => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding
  )
  t.after(() => manager.destroy())
  const queue: AudioEngineQueueItem[] = [{ id: 'same', source: 'same.flac', queueEntryId: 'first' }]
  await manager.loadQueue(queue)
  const token = manager.getQueueToken()
  await manager.loadQueue([{ ...queue[0], queueEntryId: 'second' }])
  assert.notEqual(manager.getQueueToken(), token)
  assert.equal(nativeBinding.loadQueueCalls, 2)
  assert.equal(nativeBinding.lastLoadedQueue[0].queueEntryId, 'second')
  assert.equal(
    await manager.selectQueueItem({ queueToken: token, index: 0, id: 'same', source: 'same.flac' }),
    false
  )
})

test('same-source CUE queue preserves its logical index and clamps relative seek/play positions', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const source = 'D:/Music/single-file.flac'
  const queue: AudioEngineQueueItem[] = [
    {
      id: 'local:cue:first',
      source,
      duration: 60,
      cueRange: { startSeconds: 0, endSeconds: 60, pregapSeconds: 0 },
      replayGainTrackGainDb: -3
    },
    {
      id: 'local:cue:second',
      source,
      duration: 60,
      cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 2 },
      replayGainTrackGainDb: -9
    }
  ]

  await manager.loadQueue(queue, 1)
  await manager.play(source, 999)
  let info = await manager.getPlaybackInfo()

  assert.deepEqual(nativeBinding.lastLoadedQueue, queue)
  assert.equal(info.queueIndex, 1)
  assert.equal(info.duration, 60)
  assert.equal(info.position, 60)
  assert.equal(nativeBinding.playCalls.at(-1)?.startTime, 60)

  await manager.seek(-50)
  info = await manager.getPlaybackInfo()
  assert.equal(info.position, 0)
  await manager.seek(999)
  info = await manager.getPlaybackInfo()
  assert.equal(info.position, 60)
})

test('native tick recognizes a same-source CUE boundary by queue index', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const source = 'D:/Music/same-source.flac'
  const queue: AudioEngineQueueItem[] = [
    {
      id: 'local:cue:first',
      source,
      duration: 30,
      cueRange: { startSeconds: 0, endSeconds: 30, pregapSeconds: 0 }
    },
    {
      id: 'local:cue:second',
      source,
      duration: 45,
      cueRange: { startSeconds: 30, endSeconds: 75, pregapSeconds: 0 }
    }
  ]
  let startFileEvents = 0
  manager.on('start-file', () => startFileEvents++)

  await manager.loadQueue(queue, 0)
  await manager.play(source, 0)
  startFileEvents = 0
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    queueIndex: 1,
    duration: 45,
    position: 0.25
  }
  ;(manager as unknown as { tick: () => void }).tick()

  const info = await manager.getPlaybackInfo()
  assert.equal(info.source, source)
  assert.equal(info.queueIndex, 1)
  assert.equal(info.duration, 45)
  assert.equal(startFileEvents, 1)
})

test('same-file CUE handoff resets the outgoing soft clock and pending seek target', async (t) => {
  const native = new FakeNativeBinding()
  const manager = makeManager({ exclusiveMode: false }, native)
  t.after(() => manager.destroy())
  const source = 'disc.flac'
  await manager.loadQueue([
    {
      id: 'long',
      source,
      duration: 122,
      cueRange: { startSeconds: 2, endSeconds: 124, pregapSeconds: 0 }
    },
    {
      id: 'short',
      source,
      duration: 1,
      cueRange: { startSeconds: 0, endSeconds: 1, pregapSeconds: 0 }
    }
  ])
  await manager.play(source, 121)
  await manager.seek(121.9)
  const updates: PlaybackInfo[] = []
  manager.on('playback-info', (info) => updates.push(info))
  native.playbackInfo = {
    ...native.playbackInfo,
    queueIndex: 1,
    position: 0.2,
    duration: 1,
    state: 'playing'
  }
  ;(manager as unknown as { tick: () => void }).tick()
  assert.equal(updates.at(-1)?.queueIndex, 1)
  assert.equal(updates.at(-1)?.duration, 1)
  assert.equal(
    updates.at(-1)?.position,
    0.2,
    'incoming occurrence must not inherit the outgoing clock'
  )
})

test('loadQueue reapplies play mode to clear stale native repeat mode', async () => {
  const nativeBinding = new FakeNativeBinding({ playMode: 'repeat' })
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const queue: AudioEngineQueueItem[] = [{ id: 'local:one', source: 'one.flac', title: 'One' }]

  await manager.loadQueue(queue, 0)

  assert.equal(nativeBinding.loadQueueCalls, 1)
  assert.equal(nativeBinding.playModeCalls, 1)
  assert.equal(nativeBinding.playbackInfo.playMode, 'sequential')
})

test('Native queue handoff publishes incoming identity and position before scalar progress and start-file', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: true, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding
  )
  const outgoing = 'D:/Music/out.flac'
  const incoming = 'D:/Music/in.flac'
  await manager.loadQueue(
    [
      { id: 'out', source: outgoing, duration: 186 },
      { id: 'in', source: incoming, duration: 257 }
    ],
    0
  )
  await manager.play(outgoing, 170)
  const events: string[] = []
  manager.on('playback-info', (info) => {
    assert.equal(info.source, incoming)
    assert.equal(info.queueIndex, 1)
    assert.equal(info.position, 4.18)
    events.push('info')
  })
  manager.on('property-change', ({ name }) => {
    if (name === 'time-pos' || name === 'duration') events.push(name)
  })
  manager.on('start-file', () => events.push('start'))
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    source: incoming,
    queueIndex: 1,
    duration: 257,
    position: 4.18
  }
  ;(manager as unknown as { tick: () => void }).tick()
  assert.ok(events.includes('info'))
  assert.ok(events.includes('time-pos'))
  assert.ok(events.indexOf('info') < events.indexOf('time-pos'))
  assert.ok(events.indexOf('info') < events.indexOf('duration'))
  assert.ok(events.indexOf('info') < events.indexOf('start'))
  assert.equal(events.filter((event) => event === 'start').length, 1)
})

test('getPlaybackInfo reuses fresh native playback info from the manager tick', async () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  await manager.play('track.flac', 0)
  assert.equal(nativeBinding.playbackInfoReads, 1)

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    position: 0.25
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  assert.equal(nativeBinding.playbackInfoReads, 2)

  const cachedInfo = await manager.getPlaybackInfo()
  assert.equal(nativeBinding.playbackInfoReads, 2)
  assert.equal(cachedInfo.position, 0.25)

  now += 250
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    position: 0.5
  }
  const refreshedInfo = await manager.getPlaybackInfo()
  assert.equal(nativeBinding.playbackInfoReads, 3)
  assert.equal(refreshedInfo.position, 0.5)

  const repeatedInfo = await manager.getPlaybackInfo()
  assert.equal(nativeBinding.playbackInfoReads, 3)
  assert.equal(repeatedInfo.position, 0.5)
})

test('native tick skips full playback-info fanout when only position changes', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  const coreSamples: PlaybackInfo[] = []
  const timePositions: number[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))
  manager.on('playback-sample', (info: PlaybackInfo) => coreSamples.push(info))
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') timePositions.push(data as number)
  })

  await manager.play('track.flac', 0)
  const fullUpdatesAfterPlay = playbackUpdates.length

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    position: 0.25
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()

  assert.equal(timePositions.at(-1), 0.25)
  assert.equal(playbackUpdates.length, fullUpdatesAfterPlay)
  assert.equal(coreSamples.at(-1)?.position, 0.25)
})

test('native tick keeps time-pos moving when GetPlaybackInfo briefly fails', async () => {
  let now = 1000
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )
  const timePositions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') timePositions.push(data as number)
  })

  await manager.play('track.flac', 0)
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'playing',
    position: 1
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  assert.equal(timePositions.at(-1), 1)

  const previousGetPlaybackInfo = nativeBinding.GetPlaybackInfo
  nativeBinding.GetPlaybackInfo = () => {
    throw new Error('transient native read failure')
  }
  now += 500
  tickManager.tick()
  assert.ok((timePositions.at(-1) ?? 0) > 1)
  nativeBinding.GetPlaybackInfo = previousGetPlaybackInfo
})

test('native tick preserves explicit paused and stopped transport states', async () => {
  let now = 1500
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )
  const timePositions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') timePositions.push(data as number)
  })

  await manager.play('track.flac', 0)
  const tickManager = manager as unknown as { tick: () => void }
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'paused',
    position: 4
  }
  now += 250
  tickManager.tick()
  const pausedInfo = await manager.getPlaybackInfo()
  assert.equal(pausedInfo.state, 'paused')
  assert.equal(timePositions.at(-1), 4)

  now += 1000
  tickManager.tick()
  const stillPausedInfo = await manager.getPlaybackInfo()
  assert.equal(stillPausedInfo.state, 'paused')
  assert.equal(timePositions.at(-1), 4)

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'stopped',
    position: 4,
    nativePlaybackActive: false
  }
  now += 250
  tickManager.tick()
  const stoppedInfo = await manager.getPlaybackInfo()
  assert.equal(stoppedInfo.state, 'stopped')
  assert.equal(timePositions.at(-1), 4)
})

test('native tick soft-advances past stale service GetPlaybackInfo cache', async () => {
  let now = 2000
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )
  const timePositions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') timePositions.push(data as number)
  })

  await manager.play('track.flac', 0)
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'playing',
    position: 2
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  assert.equal(timePositions.at(-1), 2)

  // Simulate async service cache that keeps returning the same sample.
  now += 250
  tickManager.tick()
  now += 250
  tickManager.tick()
  const advanced = timePositions.at(-1) ?? 0
  assert.ok(
    advanced >= 2.45,
    `expected soft-advanced position >= 2.45, got ${advanced}; samples=${JSON.stringify(timePositions)}`
  )
})

test('AutoMix progress and frozen native source positions bypass wall-clock smoothing', async () => {
  let now = 2000
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    nativeBinding,
    {
      now: () => now
    }
  )
  const positions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') positions.push(data as number)
  })
  await manager.play('track.flac', 0)
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'playing',
    position: 20,
    autoMixMode: 'natural',
    autoMixState: 'mixing',
    autoMixPlanId: 1
  }
  manager.tick()
  now += 250
  manager.tick()
  assert.equal(positions.at(-1), 20)
  nativeBinding.playbackInfo = { ...nativeBinding.playbackInfo, position: 20.24 }
  now += 250
  manager.tick()
  assert.equal(positions.at(-1), 20.24)
  manager.destroy()
})

test('native source starvation freezes progress while stale cache smoothing remains available', async () => {
  let now = 2000
  const native = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    native,
    { now: () => now }
  )
  const positions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') positions.push(data as number)
  })
  await manager.play('remote.flac', 0)
  native.playbackInfo = { ...native.playbackInfo, state: 'playing', position: 4.3 }
  native.setDiagnostics({
    decodeHealthAvailable: true,
    liveRenderState: 1,
    decodeEof: false,
    decodeStopRequested: false,
    decodeBufferedFrames: 0,
    decodeStage: 'reading',
    decodeLastProgressAgeMs: 1000
  })
  manager.tick()
  for (let tick = 0; tick < 12; tick++) {
    now += 250
    manager.tick()
  }
  assert.equal(positions.at(-1), 4.3)
  native.setDiagnostics({ decodeStage: 'reconnecting' })
  now += 250
  manager.tick()
  assert.equal(positions.at(-1), 4.3)
  native.playbackInfo = { ...native.playbackInfo, position: 4.55 }
  native.setDiagnostics({
    decodeBufferedFrames: 96000,
    decodeStage: 'writing',
    decodeLastProgressAgeMs: 10
  })
  now += 250
  manager.tick()
  assert.equal(positions.at(-1), 4.55)
  manager.destroy()
})

test('terminal native decode failure reports error without a normal EOF or sleep-timer boundary', async () => {
  let now = 2000
  const native = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    native,
    { now: () => now }
  )
  const endings: string[] = [],
    boundaries: unknown[] = [],
    errors: Error[] = [],
    properties: string[] = []
  const positions: number[] = []
  manager.on('end-file', ({ reason }) => endings.push(reason))
  manager.on('sleep-timer-boundary', (data) => boundaries.push(data))
  manager.on('error', (error) => errors.push(error))
  manager.on('property-change', ({ name, data }) => {
    properties.push(name)
    if (name === 'time-pos') positions.push(data as number)
  })
  await manager.play('broken.flac', 0)
  native.playbackInfo = { ...native.playbackInfo, state: 'playing', position: 4.3 }
  manager.tick()
  now += 3000
  native.playbackInfo = {
    ...native.playbackInfo,
    state: 'stopped',
    position: 4.3,
    upcomingTrack: null
  }
  native.setDiagnostics({ lastError: 'Audio source read failed, code: -1414092869' })
  manager.tick()
  manager.tick()
  assert.deepEqual(endings, ['error'])
  assert.equal(errors.length, 1)
  assert.deepEqual(boundaries, [])
  assert.ok(!properties.includes('eof-reached'))
  assert.equal(positions.at(-1), 4.3)
  manager.destroy()
})

test('terminal decode failure clears a pending seek and reports stopped once', async () => {
  const native = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    native
  )
  const endings: string[] = []
  const errors: Error[] = []
  manager.on('end-file', ({ reason }) => endings.push(reason))
  manager.on('error', (error) => errors.push(error))
  await manager.play('broken.flac', 0)
  await manager.seek(90)
  native.playbackInfo = { ...native.playbackInfo, state: 'stopped', position: 4.3 }
  native.setDiagnostics({ lastError: 'Audio source read failed' })
  manager.tick()
  manager.tick()
  const info = await manager.getPlaybackInfo()
  assert.equal(info.state, 'stopped')
  assert.equal(info.position, 4.3)
  assert.deepEqual(endings, ['error'])
  assert.equal(errors.length, 1)
  manager.destroy()
})

test('an explicit play toggle retries the failed source from its last consumed position', async () => {
  const native = new FakeNativeBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    native
  )
  manager.on('error', () => {})
  await manager.play('broken.flac', 0)
  native.playbackInfo = { ...native.playbackInfo, state: 'stopped', position: 4.3 }
  native.setDiagnostics({ lastError: 'Audio source read failed' })
  manager.tick()
  manager.tick()
  assert.equal(native.playCalls.length, 1, 'status polling must not restart a failed source')
  native.setDiagnostics({ lastError: '' })
  await manager.togglePause()
  assert.equal(native.playCalls.length, 2)
  assert.equal(native.playCalls[1].source, 'broken.flac')
  assert.equal(native.playCalls[1].startTime, 4.3)
  assert.equal((await manager.getPlaybackInfo()).state, 'playing')
  manager.destroy()
})

test('AutoMix preparation status reads the service instead of its stale synchronous cache', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    service
  )
  service.playbackInfo = makePlaybackInfo({
    autoMixMode: 'dj',
    autoMixState: 'degraded',
    autoMixReason: 'host_cancelled'
  })
  const cached = service.GetPlaybackInfo()
  service.GetPlaybackInfo = () => cached
  const baseCall = service.callAsync.bind(service)
  service.callAsync = async (method, args) =>
    method === 'GetPlaybackInfo'
      ? JSON.stringify(
          makePlaybackInfo({ autoMixMode: 'dj', autoMixState: 'ready', autoMixPlanId: 42 })
        )
      : baseCall(method, args)
  const status = await manager.getAutoMixNativeStatus()
  assert.equal(status.autoMixState, 'ready')
  assert.equal(status.autoMixPlanId, 42)
  manager.destroy()
})

test('AutoMix context waits for decoded next-source duration and preserves fractional bounds', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    service
  )
  await manager.loadQueue([
    { id: 'a', source: 'a.flac', duration: 338 },
    { id: 'b', source: 'b.flac', duration: 299 }
  ])
  const internal = manager as unknown as { playbackInfo: PlaybackInfo }
  internal.playbackInfo = makePlaybackInfo({
    queueIndex: 0,
    source: 'a.flac',
    duration: 338.040123456789,
    upcomingTrack: { id: 'b', source: 'b.flac', duration: 298.701234567891 }
  })
  assert.equal(manager.getAutoMixContext(), null)
  internal.playbackInfo.preloadReady = true
  const context = manager.getAutoMixContext()
  assert.equal(context?.info.duration, 338.040123456789)
  assert.equal(context?.next.duration, 298.701234567891)
  manager.destroy()
})

test('play publishes decoded source bounds immediately despite rounded queue duration and stale service cache', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = makeManager(
    { exclusiveMode: false, audioOutput: 'wasapi', audioDevice: 'auto' },
    service
  )
  await manager.loadQueue([
    { id: 'a', source: 'a.flac', duration: 338 },
    { id: 'b', source: 'b.flac', duration: 299 }
  ])
  service.GetPlaybackInfo = () =>
    JSON.stringify(makePlaybackInfo({ source: 'old.flac', duration: 10 }))
  const originalCall = service.callAsync.bind(service)
  service.callAsync = async (method, args) =>
    method === 'GetPlaybackInfo'
      ? JSON.stringify(
          makePlaybackInfo({
            state: 'playing',
            source: 'a.flac',
            queueIndex: 0,
            duration: 338.040123456789,
            preloadReady: true,
            upcomingTrack: { id: 'b', source: 'b.flac', duration: 298.701234567891 }
          })
        )
      : originalCall(method, args)
  assert.equal((await manager.play('a.flac')).nativeStarted, true)
  const context = manager.getAutoMixContext()
  assert.equal(context?.info.duration, 338.040123456789)
  assert.equal(context?.next.duration, 298.701234567891)
  manager.destroy()
})

test('native tick rejects pre-seek cached positions until the requested position arrives', async () => {
  let now = 3000
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    { now: () => now }
  )
  const timePositions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') timePositions.push(data as number)
  })
  const tickManager = manager as unknown as { tick: () => void }

  await manager.play('track.flac', 0)
  tickManager.tick()
  nativeBinding.playbackInfo = { ...nativeBinding.playbackInfo, position: 30 }
  now += 30_000
  tickManager.tick()

  const realGetPlaybackInfo = nativeBinding.GetPlaybackInfo
  const staleForward = JSON.stringify(nativeBinding.playbackInfo)
  await manager.seek(90)
  nativeBinding.GetPlaybackInfo = () => staleForward
  now += 250
  tickManager.tick()
  assert.ok((timePositions.at(-1) ?? 0) >= 90.2)

  nativeBinding.GetPlaybackInfo = realGetPlaybackInfo
  nativeBinding.playbackInfo = { ...nativeBinding.playbackInfo, position: 90.5 }
  now += 250
  tickManager.tick()
  assert.equal(timePositions.at(-1), 90.5)

  const staleBackward = JSON.stringify(nativeBinding.playbackInfo)
  await manager.seek(10)
  nativeBinding.GetPlaybackInfo = () => staleBackward
  now += 250
  tickManager.tick()
  assert.ok((timePositions.at(-1) ?? 0) >= 10.2)
  assert.ok((timePositions.at(-1) ?? 0) < 11)
})

test('native tick continues the new track while service cache still reports the previous track', async () => {
  let now = 5000
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    { now: () => now }
  )
  await manager.loadQueue(
    [
      { id: 'local:one', source: 'one.flac', title: 'One', duration: 180 },
      { id: 'local:two', source: 'two.flac', title: 'Two', duration: 180 }
    ],
    0
  )
  await manager.play('one.flac', 0)
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  nativeBinding.playbackInfo = { ...nativeBinding.playbackInfo, position: 20 }
  now += 20_000
  tickManager.tick()

  const previousTrackSnapshot = JSON.stringify({
    ...nativeBinding.playbackInfo,
    state: 'stopped',
    nativePlaybackActive: false
  })
  const realGetPlaybackInfo = nativeBinding.GetPlaybackInfo
  nativeBinding.GetPlaybackInfo = () => previousTrackSnapshot
  await manager.next()

  const timePositions: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'time-pos') timePositions.push(data as number)
  })
  now += 250
  tickManager.tick()

  const info = await manager.getPlaybackInfo()
  assert.equal(info.source, 'two.flac')
  assert.equal(info.queueIndex, 1)
  assert.equal(info.state, 'playing')
  assert.equal(info.nativePlaybackActive, true)
  assert.ok((timePositions.at(-1) ?? 0) >= 0.2)
  assert.ok((timePositions.at(-1) ?? 0) < 1)

  const targetStoppedSnapshot = JSON.stringify({
    ...nativeBinding.playbackInfo,
    source: 'two.flac',
    queueIndex: 1,
    state: 'stopped',
    position: 0,
    nativePlaybackActive: false
  })
  nativeBinding.GetPlaybackInfo = () => targetStoppedSnapshot
  now += 250
  tickManager.tick()
  const pendingInfo = await manager.getPlaybackInfo()
  assert.equal(pendingInfo.state, 'playing')
  assert.equal(pendingInfo.nativePlaybackActive, true)
  assert.ok((timePositions.at(-1) ?? 0) >= 0.45)
  nativeBinding.GetPlaybackInfo = realGetPlaybackInfo
})

test('native tick publishes playback-info when non-position playback facts change', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))
  const queue = [
    { id: '1', source: 'first.flac', title: 'First' },
    { id: '2', source: 'second.flac', title: 'Second' }
  ]

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  playbackUpdates.length = 0

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    position: 0.25,
    source: queue[1].source,
    queueIndex: 1
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()

  assert.equal(playbackUpdates.length, 1)
  assert.equal(playbackUpdates[0].source, queue[1].source)
  assert.equal(playbackUpdates[0].queueIndex, 1)
})

for (const scenario of [
  {
    label: 'a delegated native single-track queue',
    queue: [{ id: 'single', source: 'single.flac', title: 'Single' }],
    startIndex: 0
  },
  {
    label: 'the final item in a delegated native queue',
    queue: [
      { id: 'first', source: 'first.flac', title: 'First' },
      { id: 'last', source: 'last.flac', title: 'Last' }
    ],
    startIndex: 1
  }
]) {
  test(`native tick emits one trackEnd before queueEnd for ${scenario.label}`, async () => {
    const nativeBinding = new FakeNativeBinding()
    const manager = makeManager(
      {
        exclusiveMode: true,
        audioOutput: 'wasapi',
        audioDevice: 'auto'
      },
      nativeBinding
    )
    const boundaries: Array<'trackEnd' | 'queueEnd'> = []
    let triggerEvents = 0
    const sleepTimer = new SleepTimerService({
      now: () => 1_000,
      publish: (kind) => {
        if (kind === 'trigger') triggerEvents++
      }
    })
    registerNativeSleepTimerBoundaries(manager, sleepTimer)
    manager.on('sleep-timer-boundary', ({ boundary }) => boundaries.push(boundary))

    await manager.loadQueue(scenario.queue, scenario.startIndex)
    await manager.play(scenario.queue[scenario.startIndex].source, 0)
    sleepTimer.configure(
      createSleepTimerState('trackEnd', 1_000, { defaultMinutes: 1, fadeSeconds: 0 })
    )
    nativeBinding.playbackInfo = {
      ...nativeBinding.playbackInfo,
      state: 'stopped',
      queueIndex: scenario.startIndex
    }

    const tickManager = manager as unknown as { tick: () => void }
    tickManager.tick()
    tickManager.tick()

    assert.deepEqual(boundaries, ['trackEnd', 'queueEnd'])
    assert.equal(triggerEvents, 1)
    assert.equal(sleepTimer.snapshot()?.triggered, true)
  })
}

test('manager emits config-applied only after the applied revision advances', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const appliedEvents: Array<{
    requestedConfigRevision: number
    appliedConfigRevision: number
  }> = []
  manager.on('config-applied', (event) => appliedEvents.push(event))

  await manager.play('track.flac', 0)
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 1,
    appliedConfigRevision: 0
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  assert.deepEqual(appliedEvents, [])

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    appliedConfigRevision: 1
  }
  tickManager.tick()
  tickManager.tick()
  assert.deepEqual(appliedEvents, [
    {
      requestedConfigRevision: 1,
      appliedConfigRevision: 1
    }
  ])

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 2,
    appliedConfigRevision: 1
  }
  tickManager.tick()
  assert.equal(appliedEvents.length, 1)
})

test('manager publishes matching playback info before config-applied', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const events: Array<
    | { kind: 'playback-info'; requestedConfigRevision: number; appliedConfigRevision: number }
    | { kind: 'config-applied'; requestedConfigRevision: number; appliedConfigRevision: number }
  > = []
  manager.on('playback-info', (info) => {
    events.push({
      kind: 'playback-info',
      requestedConfigRevision: info.requestedConfigRevision,
      appliedConfigRevision: info.appliedConfigRevision
    })
  })
  manager.on('config-applied', (event) => {
    events.push({ kind: 'config-applied', ...event })
  })

  await manager.play('config-event-order.flac', 0)
  events.length = 0
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 1,
    appliedConfigRevision: 1
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()

  const configEventIndex = events.findIndex((event) => event.kind === 'config-applied')
  const playbackEventIndex = events.findIndex(
    (event) =>
      event.kind === 'playback-info' &&
      event.requestedConfigRevision === 1 &&
      event.appliedConfigRevision === 1
  )
  assert.notEqual(configEventIndex, -1)
  assert.notEqual(playbackEventIndex, -1)
  assert(playbackEventIndex < configEventIndex)
})

test('manager keeps config revisions monotonic across a native service revision reset', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const appliedEvents: Array<{
    requestedConfigRevision: number
    appliedConfigRevision: number
  }> = []
  manager.on('config-applied', (event) => appliedEvents.push(event))
  await manager.play('track.flac', 0)
  const tickManager = manager as unknown as { tick: () => void }

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 7,
    appliedConfigRevision: 7
  }
  tickManager.tick()
  assert.deepEqual(appliedEvents.at(-1), {
    requestedConfigRevision: 7,
    appliedConfigRevision: 7
  })
  appliedEvents.length = 0

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 0,
    appliedConfigRevision: 0
  }
  tickManager.tick()
  const resetInfo = await manager.getPlaybackInfo()
  assert.equal(resetInfo.requestedConfigRevision, 7)
  assert.equal(resetInfo.appliedConfigRevision, 7)
  assert.deepEqual(appliedEvents, [])

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 1,
    appliedConfigRevision: 1
  }
  tickManager.tick()
  const nextInfo = await manager.getPlaybackInfo()
  assert.equal(nextInfo.requestedConfigRevision, 8)
  assert.equal(nextInfo.appliedConfigRevision, 8)
  assert.deepEqual(appliedEvents, [
    {
      requestedConfigRevision: 8,
      appliedConfigRevision: 8
    }
  ])
})

test('service replacement rebases raw zero without claiming an unapplied request', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const managerInternals = manager as unknown as {
    tick: () => void
    handleAudioServiceCrash: (reason: string) => void
  }
  const appliedEvents: Array<{
    requestedConfigRevision: number
    appliedConfigRevision: number
  }> = []
  manager.on('config-applied', (event) => appliedEvents.push(event))
  await manager.play('before-restart.flac', 0)

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 10,
    appliedConfigRevision: 8
  }
  managerInternals.tick()
  appliedEvents.length = 0

  managerInternals.handleAudioServiceCrash('service replaced')
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 0,
    appliedConfigRevision: 0
  }
  await manager.play('after-restart.flac', 0)
  const resetInfo = await manager.getPlaybackInfo()
  assert.equal(resetInfo.requestedConfigRevision, 10)
  assert.equal(resetInfo.appliedConfigRevision, 8)
  assert.deepEqual(appliedEvents, [])

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    requestedConfigRevision: 1,
    appliedConfigRevision: 1
  }
  managerInternals.tick()
  const nextInfo = await manager.getPlaybackInfo()
  assert.equal(nextInfo.requestedConfigRevision, 11)
  assert.equal(nextInfo.appliedConfigRevision, 11)
  assert.deepEqual(appliedEvents, [
    {
      requestedConfigRevision: 11,
      appliedConfigRevision: 11
    }
  ])
})

test('native tick skips repeated duration property changes until duration changes', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const durations: number[] = []
  manager.on('property-change', ({ name, data }) => {
    if (name === 'duration') durations.push(data as number)
  })
  const queue = [{ id: '1', source: 'track.flac', title: 'Track', duration: 120 }]

  await manager.loadQueue(queue, 0)
  await manager.play(queue[0].source, 0)
  assert.deepEqual(durations, [120])

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    position: 0.25,
    duration: 120
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()
  assert.deepEqual(durations, [120])

  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    position: 0.5,
    duration: 121
  }
  tickManager.tick()
  assert.deepEqual(durations, [120, 121])
})

test('cold start applies configured software volume before reporting the engine ready', async () => {
  const nativeBinding = new FakeNativeBinding()
  const readyVolumes: number[] = []
  const manager = makeManager(
    {
      exclusiveMode: true,
      volume: 0.42,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      setImmediate: (callback) => {
        callback()
      }
    }
  )
  manager.on('ready', () => readyVolumes.push(nativeBinding.playbackInfo.volume))

  assert.equal((await manager.getPlaybackInfo()).volume, 0.42)
  assert.equal(nativeBinding.playbackInfo.volume, 1)

  await manager.start()

  assert.equal(nativeBinding.volumeCalls, 1)
  assert.equal(nativeBinding.playbackInfo.volume, 0.42)
  assert.deepEqual(readyVolumes, [0.42])
  manager.destroy()
})

test('setVolume skips native call and playback fanout when normalized volume is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  await manager.setVolume(0.5)
  assert.equal(nativeBinding.volumeCalls, 1)
  assert.equal(playbackUpdates.at(-1)?.volume, 0.5)
  const fullUpdatesAfterChange = playbackUpdates.length

  await manager.setVolume(0.5)
  assert.equal(nativeBinding.volumeCalls, 1)
  assert.equal(playbackUpdates.length, fullUpdatesAfterChange)
})

test('service-ready restore applies the saved volume even when the output route restore fails', async () => {
  const service = new RouteFailingLateReadyAudioServiceBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      volume: 0.31,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  await manager.start()
  service.ready = true
  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  // A fresh audio-service process starts at unity volume. Even though the
  // output-route restore failed, the saved volume must still reach the native
  // engine; otherwise the manager reports 0.31 while the engine stays loud.
  assert.equal(service.volume, 0.31)
  assert.ok(service.volumeCalls >= 1)
  manager.destroy()
})

test('setVolume re-dispatches while the service native volume is not confirmed synced', async () => {
  const service = new VolumeRestoreFailingAudioServiceBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      volume: 0.31,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  await manager.start()
  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(service.volume, 1)

  // playbackInfo already reports the saved volume, so the old dedupe guard
  // silently dropped every renderer push. The native side is still unsynced,
  // so this call must dispatch to the engine.
  service.failVolumeRestore = false
  await manager.setVolume(0.31)
  assert.equal(service.volumeCalls, 1)
  assert.equal(service.volume, 0.31)
  manager.destroy()
})

test('seek skips native call and fanout when paused position is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding({ state: 'paused', position: 32 })
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  const timePositions: number[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))
  manager.on('property-change', (event: { name: string; data: unknown }) => {
    if (event.name === 'time-pos') timePositions.push(event.data as number)
  })

  await manager.seek(48)
  assert.equal(nativeBinding.seekCalls, 1)
  assert.deepEqual(timePositions, [48])
  assert.equal(playbackUpdates.at(-1)?.position, 48)
  const fullUpdatesAfterSeek = playbackUpdates.length

  await manager.seek(48)
  assert.equal(nativeBinding.seekCalls, 1)
  assert.deepEqual(timePositions, [48])
  assert.equal(playbackUpdates.length, fullUpdatesAfterSeek)
})

test('stop skips native call and playback fanout when already idle', async () => {
  const nativeBinding = new FakeNativeBinding({ state: 'stopped', position: 0 })
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  const propertyChanges: Array<{ name: string; data: unknown }> = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))
  manager.on('property-change', (event: { name: string; data: unknown }) =>
    propertyChanges.push(event)
  )

  await manager.stop()

  assert.equal(nativeBinding.stopCalls, 0)
  assert.equal(playbackUpdates.length, 0)
  assert.equal(propertyChanges.length, 0)
})

test('setPlayMode skips native call and playback fanout when mode is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  await manager.setPlayMode('repeat')
  assert.equal(nativeBinding.playModeCalls, 1)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.at(-1)?.playMode, 'repeat')
  const fullUpdatesAfterChange = playbackUpdates.length

  await manager.setPlayMode('repeat')
  assert.equal(nativeBinding.playModeCalls, 1)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, fullUpdatesAfterChange)
})

test('getUpcomingTrack reuses native result briefly and invalidates on play mode change', async () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  const first = manager.getUpcomingTrack()
  const second = manager.getUpcomingTrack()

  assert.equal(nativeBinding.upcomingTrackReads, 1)
  assert.deepEqual(second, first)

  now += 250
  const refreshed = manager.getUpcomingTrack()
  assert.equal(nativeBinding.upcomingTrackReads, 2)
  assert.notDeepEqual(refreshed, first)

  const cached = manager.getUpcomingTrack()
  assert.equal(nativeBinding.upcomingTrackReads, 2)
  assert.deepEqual(cached, refreshed)

  await manager.setPlayMode('repeat')
  const afterModeChange = manager.getUpcomingTrack()

  assert.equal(nativeBinding.upcomingTrackReads, 3)
  assert.notDeepEqual(afterModeChange, refreshed)
})

test('getMetadata reuses native metadata for the same source within the cache window', () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  const first = manager.getMetadata('file:///album/track.flac')
  const second = manager.getMetadata('file:///album/track.flac')

  assert.equal(nativeBinding.metadataReads, 1)
  assert.deepEqual(second, first)

  const other = manager.getMetadata('file:///album/other.flac')
  assert.equal(nativeBinding.metadataReads, 2)
  assert.notDeepEqual(other, first)

  now += 1250
  const refreshed = manager.getMetadata('file:///album/track.flac')
  assert.equal(nativeBinding.metadataReads, 3)
  assert.notDeepEqual(refreshed, first)
})

test('getMetadata bounds expired and unique metadata cache entries', () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )
  const internals = manager as unknown as {
    metadataCache: Map<string, unknown>
  }

  for (let index = 0; index < 260; ++index) {
    manager.getMetadata(`file:///album/side-a-${index}.flac`)
  }

  now += 1250

  for (let index = 0; index < 260; ++index) {
    manager.getMetadata(`file:///album/side-b-${index}.flac`)
  }

  assert.ok(
    internals.metadataCache.size <= 256,
    `metadata cache retained ${internals.metadataCache.size} entries`
  )
  assert.equal(internals.metadataCache.has('file:///album/side-a-0.flac'), false)
})

test('getMetadataAsync reuses service metadata for the same source within the cache window', async () => {
  const service = new FakeAudioServiceBinding()
  let now = 1000
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: {
        ...TEST_SCHEDULER,
        now: () => now
      },
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  const first = await manager.getMetadataAsync('service-track.flac')
  const second = await manager.getMetadataAsync('service-track.flac')

  assert.equal(service.metadataReads, 1)
  assert.deepEqual(second, first)

  const other = await manager.getMetadataAsync('other-service-track.flac')
  assert.equal(service.metadataReads, 2)
  assert.notDeepEqual(other, first)

  now += 1250
  const refreshed = await manager.getMetadataAsync('service-track.flac')
  assert.equal(service.metadataReads, 3)
  assert.notDeepEqual(refreshed, first)

  manager.destroy()
})

test('setOutputConfig keeps routing and non-perfect reasons in sync', async () => {
  const nativeBinding = new FakeNativeBinding({
    outputInfo: makeOutputInfo({
      backend: 'wasapi-exclusive',
      actualBackend: 'wasapi-exclusive',
      exclusive: true,
      accessMode: 'exclusive',
      supportsOutputPerfect: true,
      perfectReason: '',
      perfectReasonCode: '',
      capabilityReason: ''
    })
  })
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.setOutputConfig({ routingMode: 'stereo-to-7.1' })
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputInfo.channelRoutingMode, 'stereo-to-7.1')
  assert.equal(info.channelRoutingMode, 'stereo-to-7.1')
  assert.equal(info.outputInfo.perfectReasonCode, 'routing_changes_semantics')
  assert.equal(info.perfectReasonCode, 'routing_changes_semantics')
  assertPlaybackMirrorsOutputInfo(info)
})

test('ASIO diagnostics and recovery facts propagate through manager refresh', async () => {
  const nativeBinding = new FakeNativeBinding({
    outputInfo: {
      ...makeOutputInfo({
        backend: 'asio',
        actualBackend: 'asio',
        accessMode: 'exclusive',
        devicePathKind: 'asio',
        deviceName: 'asio:studio',
        actualDeviceName: 'Studio ASIO',
        supportsOutputPerfect: true,
        perfectReason: '',
        perfectReasonCode: '',
        capabilityReason: ''
      })
    }
  })
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: 'asio:studio'
    },
    nativeBinding
  )

  await manager.setAudioOutput('asio', 'asio:studio')
  await manager.play('track.flac', 0)
  nativeBinding.setDiagnostics(
    {
      sessionUnderrunCount: 1,
      sessionBufferDropCount: 1,
      sessionRecoveryCount: 2,
      driverRestartCount: 1,
      deviceLostCount: 1,
      lastError: 'ASIO driver restart after buffer failure'
    },
    {
      deviceRecovered: true,
      recoveryCount: 2,
      perfectReasonCode: 'driver_restart',
      perfectReason: 'ASIO driver restart after buffer failure',
      capabilityReason: 'ASIO driver restart after buffer failure'
    }
  )

  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputInfo.actualBackend, 'asio')
  assert.equal(info.outputInfo.accessMode, 'exclusive')
  assert.equal(info.outputInfo.devicePathKind, 'asio')
  assert.equal(info.outputInfo.deviceRecovered, true)
  assert.equal(info.deviceRecovered, true)
  assert.equal(info.outputInfo.recoveryCount, 2)
  assert.equal(info.recoveryCount, 2)
  assert.equal(info.outputInfo.diagnostics.sessionUnderrunCount, 1)
  assert.equal(info.outputInfo.diagnostics.sessionBufferDropCount, 1)
  assert.equal(info.outputInfo.diagnostics.sessionRecoveryCount, 2)
  assert.equal(info.outputInfo.diagnostics.driverRestartCount, 1)
  assert.equal(info.outputInfo.diagnostics.deviceLostCount, 1)
  assert.equal(info.outputInfo.diagnostics.lastError, 'ASIO driver restart after buffer failure')
  assert.equal(info.outputInfo.perfectReasonCode, 'driver_restart')
  assert.equal(info.perfectReasonCode, 'driver_restart')
  assertPlaybackMirrorsOutputInfo(info)
})

test('getAudioOutputState can use injected device options without native enumeration', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const state = await manager.getAudioOutputState()

  assert.equal(state.deviceOptions.length, DEVICE_OPTIONS.length)
  assert.equal(state.deviceOptions[1].label, 'Desk DAC')
  assert.equal(state.deviceOptions[2].pathKind, 'asio')
  assert.equal(state.deviceOptions[2].supportsDop, true)
  assert.equal(state.deviceOptions[2].capabilityVersion, 3)
})

test('native ASIO names become labels; an absent explicit CLSID stays selected until explicit recovery', async () => {
  const canonicalAsioId = 'asio:{6b3ba606-8664-4426-8994-0f1d9d12a345}'
  const absentAsioId = 'asio:{11111111-1111-4111-8111-111111111111}'
  const nativeBinding = new FakeNativeBinding(undefined, [
    DEVICE_OPTIONS[0],
    {
      id: canonicalAsioId,
      label: '',
      name: 'FiiO ASIO Driver',
      backend: 'asio',
      isDefault: false,
      pathKind: 'asio'
    }
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'asio',
      audioDevice: absentAsioId
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )

  const state = await manager.getAudioOutputState()

  // The dual-architecture contract preserves an explicit CLSID even when its
  // driver is absent. An unrelated enumerated CLSID is not the same endpoint.
  assert.equal(state.device, absentAsioId)
  assert.notEqual(state.device, 'auto')
  assert.equal(nativeBinding.routeCalls.some(call => call.method === 'SetOutputDevice' && call.value === canonicalAsioId), false)
  assert.equal(
    state.deviceOptions.find((device) => device.id === canonicalAsioId)?.label,
    'FiiO ASIO Driver'
  )
  assert.equal(
    state.deviceOptions.some((device) => device.id === absentAsioId),
    false
  )
  await manager.setAudioDevice(canonicalAsioId)
  assert.equal((await manager.getAudioOutputState()).device, canonicalAsioId)
  assert.equal(nativeBinding.playCalls.length, 0)
})

test('getAudioOutputState reuses native device options within the output state cache window', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )
  const enumerateCallsAfterConstruction = nativeBinding.enumerateDeviceCalls

  const first = await manager.getAudioOutputState()
  const enumerateCallsAfterFirstRead = nativeBinding.enumerateDeviceCalls
  const second = await manager.getAudioOutputState()

  assert.ok(enumerateCallsAfterFirstRead <= enumerateCallsAfterConstruction + 1)
  assert.equal(nativeBinding.enumerateDeviceCalls, enumerateCallsAfterFirstRead)
  assert.deepEqual(second.deviceOptions, first.deviceOptions)
})

test('native device recovery diagnostics invalidate device options cache', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )
  const refreshReasons: string[] = []
  manager.on('audio-device-options-changed', ({ reason }) => {
    refreshReasons.push(reason)
  })

  await manager.play('file:///music.flac')
  const first = await manager.getAudioOutputState()
  const enumerateCallsAfterFirstRead = nativeBinding.enumerateDeviceCalls
  nativeBinding.devices = [
    ...nativeBinding.devices,
    {
      id: 'dac-hotplug',
      label: 'Hotplug DAC',
      isDefault: false,
      backend: 'wasapi',
      pathKind: 'endpoint'
    }
  ]
  assert.equal(
    (await manager.getAudioOutputState()).deviceOptions.length,
    first.deviceOptions.length
  )

  nativeBinding.setDiagnostics({ deviceLostCount: 1 }, { deviceRecovered: true, recoveryCount: 1 })
  ;(manager as unknown as { tick: () => void }).tick()
  const refreshed = await manager.getAudioOutputState()

  assert.ok(nativeBinding.enumerateDeviceCalls > enumerateCallsAfterFirstRead)
  assert.equal(
    refreshed.deviceOptions.some((device) => device.id === 'dac-hotplug'),
    true
  )
  assert.equal(refreshReasons.includes('native-output-diagnostics-changed'), true)
})

test('device hotplug polling refreshes device options while playback is stopped', async () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      nativeBinding,
      scheduler: {
        ...TEST_SCHEDULER,
        now: () => now
      }
    }
  )
  const refreshReasons: string[] = []
  manager.on('audio-device-options-changed', ({ reason }) => {
    refreshReasons.push(reason)
  })

  const first = await manager.getAudioOutputState()
  nativeBinding.devices = [
    ...nativeBinding.devices,
    {
      id: 'usb-dac-new',
      label: 'New USB DAC',
      isDefault: false,
      backend: 'wasapi',
      pathKind: 'endpoint'
    }
  ]
  now += 5001
  ;(manager as unknown as { tick: () => void }).tick()
  const refreshed = await manager.getAudioOutputState()

  assert.equal(refreshed.deviceOptions.length, first.deviceOptions.length + 1)
  assert.equal(
    refreshed.deviceOptions.some((device) => device.id === 'usb-dac-new'),
    true
  )
  assert.equal(refreshReasons.includes('audio-device-hotplug'), true)
})

test('platform device change notifications refresh device options immediately', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )
  const refreshReasons: string[] = []
  manager.on('audio-device-options-changed', ({ reason }) => {
    refreshReasons.push(reason)
  })

  const first = await manager.getAudioOutputState()
  const enumerateCallsAfterFirstRead = nativeBinding.enumerateDeviceCalls
  nativeBinding.devices = [
    ...nativeBinding.devices,
    {
      id: 'wm-devicechange-dac',
      label: 'WM_DEVICECHANGE DAC',
      isDefault: false,
      backend: 'wasapi',
      pathKind: 'endpoint'
    }
  ]
  assert.equal(
    (await manager.getAudioOutputState()).deviceOptions.length,
    first.deviceOptions.length
  )

  manager.notifyAudioDeviceOptionsChanged('platform-device-change:wm-devicechange')
  const refreshed = await manager.getAudioOutputState()

  assert.ok(nativeBinding.enumerateDeviceCalls > enumerateCallsAfterFirstRead)
  assert.equal(refreshed.deviceOptions.length, first.deviceOptions.length + 1)
  assert.equal(
    refreshed.deviceOptions.some((device) => device.id === 'wm-devicechange-dac'),
    true
  )
  assert.equal(refreshReasons.includes('platform-device-change:wm-devicechange'), true)
})

test('auto device follows OS default endpoint changes while playing', async () => {
  const nativeBinding = new FakeNativeBinding(
    {
      state: 'playing',
      outputDevice: 'auto',
      outputInfo: makeOutputInfo({
        deviceName: 'auto',
        actualDeviceName: 'Desk DAC',
        actualBackend: 'wasapi',
        backend: 'wasapi'
      })
    },
    [
      {
        id: 'auto',
        label: '系统默认',
        name: '系统默认',
        isDefault: true,
        pathKind: 'default'
      },
      {
        id: 'dac-1',
        label: 'Desk DAC',
        name: 'Desk DAC',
        isDefault: true,
        pathKind: 'default'
      },
      {
        id: 'speakers-2',
        label: 'USB Speakers',
        name: 'USB Speakers',
        isDefault: false,
        pathKind: 'default'
      }
    ]
  )
  nativeBinding.autoDeviceUsesPhysicalDefault = true
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )
  await manager.start()
  await manager.play('default-follow.flac', 5)
  const deviceCallsAfterStart = nativeBinding.outputDeviceCalls
  const routeCallsAfterStart = nativeBinding.routeCalls.length
  const dspGraphCallsAfterStart = nativeBinding.dspGraphCalls

  // Flip the physical default endpoint (auto stays selected).
  nativeBinding.devices = [
    {
      id: 'auto',
      label: '系统默认',
      name: '系统默认',
      isDefault: true,
      pathKind: 'default'
    },
    {
      id: 'dac-1',
      label: 'Desk DAC',
      name: 'Desk DAC',
      isDefault: false,
      pathKind: 'default'
    },
    {
      id: 'speakers-2',
      label: 'USB Speakers',
      name: 'USB Speakers',
      isDefault: true,
      pathKind: 'default'
    }
  ]

  manager.notifyAudioDeviceOptionsChanged('platform-device-change:wm-devicechange')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(nativeBinding.outputDeviceCalls > deviceCallsAfterStart)
  assert.deepEqual(
    nativeBinding.routeCalls.slice(routeCallsAfterStart).map((call) => call.method),
    ['SetOutputBackend', 'SetOutputDevice', 'SetOutputConfig']
  )
  assert.equal((await manager.getAudioOutputState()).device, 'auto')
  assert.equal(nativeBinding.playbackInfo.outputDevice, 'auto')
  assert.equal(nativeBinding.playbackInfo.outputInfo.actualDeviceId, 'speakers-2')
  assert.equal(nativeBinding.playbackInfo.outputInfo.actualDeviceName, 'USB Speakers')
  assert.equal(nativeBinding.playbackInfo.state, 'playing')
  assert.equal(nativeBinding.dspGraphCalls, dspGraphCallsAfterStart + 1)
})

test('auto device records OS default endpoint changes without reopening while stopped', async () => {
  const nativeBinding = new FakeNativeBinding(
    {
      state: 'stopped',
      outputDevice: 'auto',
      outputInfo: makeOutputInfo({
        deviceName: 'auto',
        actualDeviceName: 'Desk DAC',
        actualBackend: 'wasapi',
        backend: 'wasapi'
      })
    },
    [
      {
        id: 'auto',
        label: '系统默认',
        name: '系统默认',
        isDefault: true,
        pathKind: 'default'
      },
      {
        id: 'dac-1',
        label: 'Desk DAC',
        name: 'Desk DAC',
        isDefault: true,
        pathKind: 'default'
      },
      {
        id: 'speakers-2',
        label: 'USB Speakers',
        name: 'USB Speakers',
        isDefault: false,
        pathKind: 'default'
      }
    ]
  )
  nativeBinding.autoDeviceUsesPhysicalDefault = true
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )
  await manager.start()
  const routeCallsAfterStart = nativeBinding.routeCalls.length

  nativeBinding.devices = [
    {
      id: 'auto',
      label: '系统默认',
      name: '系统默认',
      isDefault: true,
      pathKind: 'default'
    },
    {
      id: 'dac-1',
      label: 'Desk DAC',
      name: 'Desk DAC',
      isDefault: false,
      pathKind: 'default'
    },
    {
      id: 'speakers-2',
      label: 'USB Speakers',
      name: 'USB Speakers',
      isDefault: true,
      pathKind: 'default'
    }
  ]

  manager.notifyAudioDeviceOptionsChanged('platform-device-change:wm-devicechange')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    nativeBinding.routeCalls.slice(routeCallsAfterStart).map((call) => call.method),
    ['SetOutputDevice']
  )
  assert.equal(nativeBinding.playbackInfo.outputInfo.actualDeviceId, 'speakers-2')
  assert.equal(nativeBinding.playbackInfo.state, 'stopped')
})

test('pinned device does not rebind when OS default endpoint changes', async () => {
  const nativeBinding = new FakeNativeBinding(
    {
      state: 'playing',
      outputDevice: 'dac-1',
      outputInfo: makeOutputInfo({
        deviceName: 'dac-1',
        actualDeviceName: 'Desk DAC',
        actualBackend: 'wasapi',
        backend: 'wasapi'
      })
    },
    [
      {
        id: 'auto',
        label: '系统默认',
        name: '系统默认',
        isDefault: true,
        pathKind: 'default'
      },
      {
        id: 'dac-1',
        label: 'Desk DAC',
        name: 'Desk DAC',
        isDefault: true,
        pathKind: 'default'
      },
      {
        id: 'speakers-2',
        label: 'USB Speakers',
        name: 'USB Speakers',
        isDefault: false,
        pathKind: 'default'
      }
    ]
  )
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'dac-1'
    },
    {
      nativeBinding,
      scheduler: TEST_SCHEDULER
    }
  )
  await manager.start()
  const deviceCallsAfterStart = nativeBinding.outputDeviceCalls

  nativeBinding.devices = [
    {
      id: 'auto',
      label: '系统默认',
      name: '系统默认',
      isDefault: true,
      pathKind: 'default'
    },
    {
      id: 'dac-1',
      label: 'Desk DAC',
      name: 'Desk DAC',
      isDefault: false,
      pathKind: 'default'
    },
    {
      id: 'speakers-2',
      label: 'USB Speakers',
      name: 'USB Speakers',
      isDefault: true,
      pathKind: 'default'
    }
  ]

  manager.notifyAudioDeviceOptionsChanged('platform-device-change:wm-devicechange')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(nativeBinding.outputDeviceCalls, deviceCallsAfterStart)
  assert.equal((await manager.getAudioOutputState()).device, 'dac-1')
})

test('getSpectrumData reuses native spectrum data within one visual frame', () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  const first = manager.getSpectrumData(12)
  const second = manager.getSpectrumData(12)

  assert.equal(nativeBinding.spectrumReads, 1)
  assert.deepEqual(second, first)
  assert.notStrictEqual(second, first)

  first[0] = 999
  const third = manager.getSpectrumData(12)
  assert.equal(nativeBinding.spectrumReads, 1)
  assert.notEqual(third[0], 999)

  now += 100
  const refreshed = manager.getSpectrumData(12)
  assert.equal(nativeBinding.spectrumReads, 2)
  assert.notDeepEqual(refreshed, second)
})

test('getVisualizationData normalizes native visualization data', () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const data = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 1
  })

  assert.equal(data.active, true)
  assert.equal(data.sampleRate, 48000)
  assert.equal(data.spectrum.length, 12)
  assert.equal(data.waveform.length, 20)
  assert.equal(data.spectrogram.length, 1)
  assert.equal(data.spectrogram[0].length, 12)
  assert.equal(data.peakDb, -3)
  assert.equal(data.rmsDb, -12)
  assert.equal(data.lufsMomentary, -15)
  assert.equal(data.tapStatus, 'active')
  assert.equal(data.reason, '')
})

test('getVisualizationData preserves high-resolution spectrum requests for the visualizer', () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const data = manager.getVisualizationData({
    spectrumPoints: 4096,
    waveformPoints: 20,
    spectrogramFrames: 1
  })

  assert.equal(data.spectrum.length, 4096)
  assert.equal(data.spectrogram[0].length, 4096)
})

test('getVisualizationData caps native maxFrequency at Nyquist', () => {
  const nativeBinding = new FakeNativeBinding()
  nativeBinding.GetVisualizationData = () =>
    JSON.stringify({
      spectrum: Array.from({ length: 64 }, () => 0.5),
      waveform: Array.from({ length: 20 }, () => 0),
      peakDb: -6,
      rmsDb: -16,
      lufsMomentary: -18,
      spectrogram: [],
      sampleRate: 32000,
      maxFrequency: 20000,
      active: true
    })
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const data = manager.getVisualizationData({
    spectrumPoints: 64,
    waveformPoints: 20,
    spectrogramFrames: 0
  })

  assert.equal(data.sampleRate, 32000)
  assert.equal(data.maxFrequency, 16000)
})

test('getVisualizationData can precompute visualizer bars without returning the full spectrum payload', () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const data = manager.getVisualizationData({
    spectrumPoints: 4096,
    waveformPoints: 20,
    spectrogramFrames: 0,
    oscilloscopePoints: 0,
    visualizerBarCount: 130
  })

  assert.equal(data.active, true)
  assert.equal(data.spectrum.length, 0)
  assert.equal(data.visualizerBars?.length, 130)
  assert.equal(data.waveform.length, 20)
  assert.ok(data.visualizerBars?.some((value) => value > 0))
})

test('mapSpectrumToVisualizerBars keeps flat spectrum visually flat', () => {
  const bars = mapSpectrumToVisualizerBars(
    Array.from({ length: 4096 }, () => 0.5),
    48000,
    130
  )

  assert.equal(bars.length, 130)
  const min = Math.min(...bars)
  const max = Math.max(...bars)
  assert.ok(max - min < 0.0001, `expected flat bars, got range ${max - min}`)
  assert.ok(Math.abs(bars[0] - 0.5) < 0.0001, `expected raw normalized value, got ${bars[0]}`)
})

test('mapSpectrumToVisualizerBars maps a 1kHz peak near the 1kHz visual band', () => {
  const sampleRate = 48000
  const spectrumLength = 4096
  const fftSize = spectrumLength * 2
  const peakFrequency = 1000
  const spectrum = Array.from({ length: spectrumLength }, (_, bin) => {
    const frequency = bin * (sampleRate / fftSize)
    const distance = (frequency - peakFrequency) / 80
    return Math.exp(-distance * distance)
  })

  const bars = mapSpectrumToVisualizerBars(spectrum, sampleRate, 130)
  const peakBar = bars.reduce((best, value, index) => (value > bars[best] ? index : best), 0)
  const minFrequency = 20
  const maxFrequency = 20000
  const ratio = maxFrequency / minFrequency
  const centerFrequency = minFrequency * Math.pow(ratio, peakBar / (130 - 1))

  assert.ok(
    centerFrequency >= 900 && centerFrequency <= 1125,
    `expected 1kHz near peak bar center ${centerFrequency.toFixed(1)}Hz`
  )
})

test('mapSpectrumToVisualizerBars caps visual frequency range at Nyquist', () => {
  const bars = mapSpectrumToVisualizerBars(
    Array.from({ length: 4096 }, () => 1),
    32000,
    130
  )

  assert.equal(bars.length, 130)
  assert.ok(bars.every((value) => value > 0 && value <= 1))
})

test('getVisualizationData can omit unused visualization payloads', () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const data = manager.getVisualizationData({
    spectrumPoints: 2048,
    waveformPoints: 96,
    spectrogramFrames: 0,
    oscilloscopePoints: 0
  })

  assert.equal(data.active, true)
  assert.equal(data.spectrum.length, 2048)
  assert.equal(data.waveform.length, 96)
  assert.equal(data.spectrogram.length, 0)
  assert.equal(data.oscilloscope.length, 0)
})

test('getVisualizationData reuses native visualization data within one visual frame', () => {
  const helpersSource = readFileSync(
    new URL('../core/audio/audioEngineHelpers.ts', import.meta.url),
    'utf8'
  )
  assert.match(helpersSource, /export const VISUALIZATION_CACHE_TTL_MS = 24/)

  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  const first = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 1
  })
  const second = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 1
  })

  assert.equal(nativeBinding.visualizationReads, 1)
  assert.strictEqual(second, first)

  now += 100
  const refreshed = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 1
  })
  assert.equal(nativeBinding.visualizationReads, 2)
  assert.notStrictEqual(refreshed, first)
})

test('getVisualizationData returns inactive shape when native visualization is unavailable while stopped', () => {
  const nativeBinding = new FakeNativeBinding()
  delete (nativeBinding as Partial<NativeAudioBinding>).GetVisualizationData
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  const data = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 4
  })

  assert.equal(data.active, false)
  assert.equal(data.sampleRate, 0)
  assert.equal(data.spectrum.length, 12)
  assert.equal(data.waveform.length, 20)
  assert.equal(data.spectrogram.length, 0)
  assert.equal(data.peakDb, -120)
  assert.equal(data.rmsDb, -120)
  assert.equal(data.lufsMomentary, null)
  assert.equal(data.tapStatus, 'native-unavailable')
  assert.equal(data.reason, 'Native visualization tap unavailable')
})

test('getVisualizationData returns animated fallback data when native visualization is unavailable while playing', async () => {
  const nativeBinding = new FakeNativeBinding()
  delete (nativeBinding as Partial<NativeAudioBinding>).GetVisualizationData
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  await manager.play('file:///music.flac')
  const data = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 4
  })
  now += 250
  const nextData = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 4
  })

  assert.equal(data.active, true)
  assert.ok(data.sampleRate > 0)
  assert.equal(data.spectrum.length, 12)
  assert.equal(data.waveform.length, 20)
  assert.equal(data.spectrogram.length, 1)
  assert.equal(data.spectrogram[0].length, 12)
  assert.notDeepEqual(nextData.spectrum, data.spectrum)
  assert.ok(data.spectrum.some((value) => value > 0))
  assert.ok(data.waveform.some((value) => value !== 0))
  assert.equal(data.peakDb, -18)
  assert.equal(data.rmsDb, -28)
  assert.equal(data.lufsMomentary, -24)
  assert.equal(data.tapStatus, 'synthetic-fallback')
  assert.equal(data.reason, 'Native visualization tap unavailable')
})

test('getVisualizationData falls back while playback is active but native visualization is inactive', async () => {
  const nativeBinding = new FakeNativeBinding()
  nativeBinding.GetVisualizationData = (optionsJson: string): string => {
    const options = JSON.parse(optionsJson || '{}') as {
      spectrumPoints?: number
      waveformPoints?: number
      oscilloscopePoints?: number
    }
    return JSON.stringify({
      spectrum: Array.from({ length: options.spectrumPoints ?? 64 }, () => 0),
      waveform: Array.from({ length: options.waveformPoints ?? 128 }, () => 0),
      oscilloscope: Array.from({ length: options.oscilloscopePoints ?? 1024 }, () => 0),
      peakDb: -120,
      rmsDb: -120,
      lufsMomentary: null,
      spectrogram: [],
      sampleRate: 0,
      active: false
    })
  }
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  await manager.play('file:///music.flac')
  const data = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 4
  })
  now += 250
  const nextData = manager.getVisualizationData({
    spectrumPoints: 12,
    waveformPoints: 20,
    spectrogramFrames: 4
  })

  assert.equal(data.active, true)
  assert.ok(data.sampleRate > 0)
  assert.notDeepEqual(nextData.spectrum, data.spectrum)
  assert.ok(data.spectrum.some((value) => value > 0))
  assert.ok(data.waveform.some((value) => value !== 0))
  assert.equal(data.tapStatus, 'synthetic-fallback')
  assert.equal(data.reason, 'Native visualization tap returned no samples')
})

test('DSP module updates enable the native DSP chain instead of only toggling UI state', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: {
        dspEnabled: false,
        eqEnabled: false,
        volumeNormalization: 'off',
        crossfeedEnabled: false,
        crossfeedStrength: 0,
        convolverIrPath: ''
      }
    },
    nativeBinding
  )

  const eq = await manager.setAudioProcessing({ eqEnabled: true })
  assert.equal(eq.dspEnabled, true)
  assert.equal(eq.eqEnabled, true)
  assert.equal(nativeBinding.lastDspConfig.dspEnabled, true)
  assert.equal(nativeBinding.lastDspConfig.eqEnabled, true)

  const replayGain = await manager.setReplayGainMode('track', 1.5, -3, true)
  assert.equal(replayGain.dspEnabled, true)
  assert.equal(replayGain.volumeNormalization, 'track')
  assert.equal(nativeBinding.lastDspConfig.volumeNormalization, 'track')
  assert.equal(nativeBinding.lastDspConfig.replayGainPreamp, 1.5)
  assert.equal(nativeBinding.lastDspConfig.replayGainFallback, -3)
  assert.equal(nativeBinding.lastDspConfig.replayGainClip, true)

  const crossfeed = await manager.setCrossfeedStrength(0.35)
  assert.equal(crossfeed.dspEnabled, true)
  assert.equal(crossfeed.crossfeedEnabled, true)
  assert.equal(crossfeed.crossfeedStrength, 0.35)
  assert.equal(nativeBinding.lastDspConfig.crossfeedStrength, 0.35)

  const convolver = await manager.loadImpulseResponse('C:\\ir\\headphones.wav')
  assert.equal(manager.getAudioProcessing().dspEnabled, true)
  assert.equal(manager.getAudioProcessing().convolverEnabled, true)
  assert.equal(manager.getAudioProcessing().convolverIrPath, 'C:\\ir\\headphones.wav')
  assert.equal(nativeBinding.loadedImpulseResponsePath, 'C:\\ir\\headphones.wav')
  assert.equal(convolver.loaded, false)

  await manager.unloadImpulseResponse()
  assert.equal(manager.getAudioProcessing().convolverEnabled, false)
  assert.equal(manager.getAudioProcessing().convolverIrPath, '')
  assert.equal(nativeBinding.loadedImpulseResponsePath, '')
  assert.equal(nativeBinding.eqBandsCalls, 0)
  assert.equal(nativeBinding.replayGainCalls, 0)
  assert.equal(nativeBinding.crossfeedCalls, 0)
  manager.destroy()
})

test('setAudioProcessing skips native DSP fanout when normalized settings are unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: {
        dspEnabled: false,
        eqEnabled: false,
        volumeNormalization: 'off',
        crossfeedEnabled: false,
        crossfeedStrength: 0,
        convolverIrPath: ''
      }
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  await manager.setAudioProcessing({ eqEnabled: true })
  assert.equal(nativeBinding.dspConfigCalls, 1)
  assert.equal(nativeBinding.dspGraphCalls, 1)
  assert.equal(nativeBinding.eqBandsCalls, 0)
  assert.equal(nativeBinding.replayGainCalls, 0)
  assert.equal(nativeBinding.crossfeedCalls, 0)
  assert.equal(nativeBinding.unloadImpulseResponseCalls, 0)
  // Leaving a restored bypass also publishes its routing override change.
  const updatesAfterChange = playbackUpdates.length
  assert.ok(updatesAfterChange >= 1)

  const unchanged = await manager.setAudioProcessing({ eqEnabled: true })

  assert.equal(unchanged.dspEnabled, true)
  assert.equal(unchanged.eqEnabled, true)
  assert.equal(nativeBinding.dspConfigCalls, 1)
  assert.equal(nativeBinding.dspGraphCalls, 1)
  assert.equal(nativeBinding.eqBandsCalls, 0)
  assert.equal(nativeBinding.replayGainCalls, 0)
  assert.equal(nativeBinding.crossfeedCalls, 0)
  assert.equal(nativeBinding.unloadImpulseResponseCalls, 0)
  assert.equal(playbackUpdates.length, updatesAfterChange)
  manager.destroy()
})

test('unloadImpulseResponse skips native fanout when no impulse response is loaded', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: {
        dspEnabled: false,
        convolverEnabled: false,
        convolverIrPath: ''
      }
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  const convolver = await manager.unloadImpulseResponse()

  assert.equal(convolver.loaded, false)
  assert.equal(manager.getAudioProcessing().convolverEnabled, false)
  assert.equal(manager.getAudioProcessing().convolverIrPath, '')
  assert.equal(nativeBinding.unloadImpulseResponseCalls, 0)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 0)
})

test('getConvolverInfo reuses idle native convolver info within the polling cache window', () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: {
        dspEnabled: false,
        convolverEnabled: false,
        convolverIrPath: ''
      }
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  const first = manager.getConvolverInfo() as ConvolverInfo & { reads?: number }
  const second = manager.getConvolverInfo() as ConvolverInfo & { reads?: number }

  assert.equal(nativeBinding.convolverInfoReads, 1)
  assert.equal(second.reads, first.reads)

  now += 250
  const refreshed = manager.getConvolverInfo() as ConvolverInfo & { reads?: number }

  assert.equal(nativeBinding.convolverInfoReads, 2)
  assert.equal(refreshed.reads, 2)
})

test('specialized DSP setters skip native calls when normalized settings are unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))

  await manager.setEqBands({ eqEnabled: true, eqPreamp: 1 })
  assert.equal(nativeBinding.dspConfigCalls, 1)
  assert.equal(nativeBinding.eqBandsCalls, 0)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 1)

  await manager.setEqBands({ eqEnabled: true, eqPreamp: 1 })
  assert.equal(nativeBinding.dspConfigCalls, 1)
  assert.equal(nativeBinding.eqBandsCalls, 0)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 1)

  await manager.setCrossfeedStrength(0.35)
  assert.equal(nativeBinding.dspConfigCalls, 2)
  assert.equal(nativeBinding.crossfeedCalls, 0)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 2)

  await manager.setCrossfeedStrength(0.35)
  assert.equal(nativeBinding.dspConfigCalls, 2)
  assert.equal(nativeBinding.crossfeedCalls, 0)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 2)

  // setReplayGainMode routes through setAudioProcessing (graph + dual DSP path).
  await manager.setReplayGainMode('track', 1.5, -3, true)
  assert.equal(nativeBinding.replayGainCalls, 0)
  assert.equal(nativeBinding.dspConfigCalls, 3)
  assert.equal(playbackUpdates.length, 3)

  await manager.setReplayGainMode('track', 1.5, -3, true)
  assert.equal(nativeBinding.replayGainCalls, 0)
  assert.equal(nativeBinding.dspConfigCalls, 3)
  assert.equal(playbackUpdates.length, 3)
  manager.destroy()
})

test('setEqPreset skips native calls when normalized preset is unchanged', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))
  const preset = {
    eqMode: 'graphic' as const,
    eqPreamp: 2,
    eqBands: DEFAULT_AUDIO_PROCESSING.eqBands.map((band, index) => ({
      ...band,
      gain: index === 0 ? 1.5 : 0
    }))
  }

  const first = await manager.setEqPreset(preset)
  assert.equal(first.eqEnabled, true)
  assert.equal(first.eqPreamp, 2)
  assert.equal(nativeBinding.eqPresetCalls, 0)
  assert.equal(nativeBinding.dspConfigCalls, 1)
  assert.equal(nativeBinding.lastDspConfig.eqEnabled, true)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 1)

  const second = await manager.setEqPreset(preset)
  assert.equal(second.eqEnabled, true)
  assert.equal(second.eqPreamp, 2)
  assert.equal(nativeBinding.eqPresetCalls, 0)
  assert.equal(nativeBinding.dspConfigCalls, 1)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 1)
  manager.destroy()
})

test('turning the DSP master switch off still bypasses processing modules', async () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioProcessing: {
        dspEnabled: true,
        eqEnabled: true,
        volumeNormalization: 'track',
        crossfeedEnabled: true,
        crossfeedStrength: 0.4
      }
    },
    nativeBinding
  )

  const processing = await manager.setAudioProcessing({ dspEnabled: false })

  assert.equal(processing.dspEnabled, false)
  assert.equal(processing.eqEnabled, true)
  assert.equal(processing.volumeNormalization, 'track')
  assert.equal(processing.crossfeedEnabled, true)
  assert.equal(nativeBinding.lastDspConfig.dspEnabled, false)
  assert.equal(nativeBinding.lastDspConfig.eqEnabled, false)
  assert.equal(nativeBinding.lastDspConfig.volumeNormalization, 'off')
  assert.equal(nativeBinding.lastDspConfig.crossfeedEnabled, false)
  assert.equal(nativeBinding.lastDspConfig.fftEnabled, true)
})

test('canonical outputInfo clears stale DoP mirrors on PCM DSD fallback', async () => {
  const nativeBinding = new FakeNativeBinding({
    source: 'album.dsf',
    codec: 'dsd',
    isDsd: true,
    dsdMode: 'dop',
    dsdRate: 64,
    outputInfo: makeOutputInfo({
      isDsd: true,
      dsdMode: 'pcm',
      dsdRate: 64,
      actualOutputFormat: 'float32',
      actualSampleRate: 176400,
      actualBitDepth: 32,
      outputSampleRate: 176400,
      outputBitDepth: 32,
      perfectReason: 'DSD 当前已转换为 PCM 输出',
      perfectReasonCode: 'dsd_converted_to_pcm',
      capabilityReason: 'DSD 当前已转换为 PCM 输出'
    })
  })
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.play('album.dsf', 0)
  const info = await manager.getPlaybackInfo()

  assert.equal(info.outputInfo.isDsd, true)
  assert.equal(info.outputInfo.dsdMode, 'pcm')
  assert.equal(info.outputInfo.dsdRate, 64)
  assert.equal(info.isDsd, true)
  assert.equal(info.dsdMode, 'pcm')
  assert.equal(info.dsdRate, 64)
  assert.equal(info.perfectReasonCode, 'dsd_converted_to_pcm')
  assertPlaybackMirrorsOutputInfo(info)
})

test('switching DSD output mode to PCM does not leave stale DoP state', async () => {
  const nativeBinding = new FakeNativeBinding({
    source: 'album.dsf',
    codec: 'dsd',
    isDsd: true,
    dsdMode: 'dop',
    dsdRate: 64,
    outputInfo: makeOutputInfo({
      isDsd: true,
      dsdMode: 'dop',
      dsdRate: 64,
      actualOutputFormat: 'pcm_dop',
      actualSampleRate: 176400,
      actualBitDepth: 24,
      outputSampleRate: 176400,
      outputBitDepth: 24,
      perfectReason: '当前 DSD 正在通过 DoP 载波传输',
      perfectReasonCode: 'dsd_dop',
      capabilityReason: '当前 DSD 正在通过 DoP 载波传输'
    })
  })
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  await manager.play('album.dsf', 0)
  const dopInfo = await manager.getPlaybackInfo()
  assert.equal(dopInfo.outputInfo.dsdMode, 'dop')
  assert.equal(dopInfo.dsdMode, 'dop')

  await manager.setAudioProcessing({ dsdOutputMode: 'pcm' })
  const pcmInfo = await manager.getPlaybackInfo()

  assert.equal(pcmInfo.outputInfo.isDsd, true)
  assert.equal(pcmInfo.outputInfo.dsdMode, 'pcm')
  assert.equal(pcmInfo.outputInfo.dsdRate, 64)
  assert.equal(pcmInfo.isDsd, true)
  assert.equal(pcmInfo.dsdMode, 'pcm')
  assert.equal(pcmInfo.dsdRate, 64)
  assert.equal(pcmInfo.perfectReasonCode, 'dsd_converted_to_pcm')
  assert.notEqual(pcmInfo.outputInfo.dsdMode, 'dop')
  assertPlaybackMirrorsOutputInfo(pcmInfo)
})

test('audio service crash stops native playback and keeps manager usable', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  let crashReason = ''
  manager.on('audio-service-crash', ({ reason }) => {
    crashReason = reason
  })

  const meta = await manager.getMetadataAsync('service-track.flac')
  assert.equal(meta?.title, 'service metadata 1')

  service.emit('crash', 'native dsp crash fixture exited')
  const info = await manager.getPlaybackInfo()

  assert.equal(crashReason, 'native dsp crash fixture exited')
  assert.equal(info.state, 'stopped')
  assert.equal(info.nativePlaybackActive, false)
  assert.equal(info.outputInfo.diagnostics.lastError, 'native dsp crash fixture exited')
  assert.equal(info.outputInfo.nativeDsp?.plugins.length, 0)
  assert.equal(info.outputInfo.recoveryCount, 1)

  manager.destroy()
})

test('audio service play waits for utility process confirmation before marking playing', async () => {
  const service = new FakeAudioServiceBinding()
  service.playAsyncError = new Error('audio service child missing')
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const originalWarn = console.warn
  console.warn = () => {}

  try {
    await assert.rejects(() => manager.play('service-track.flac', 0), /audio service child missing/)

    const info = await manager.getPlaybackInfo()
    assert.equal(info.state, 'stopped')
    assert.equal(info.nativePlaybackActive, false)
    assert.equal(service.playCalls, 0)
  } finally {
    console.warn = originalWarn
    manager.destroy()
  }
})

test('audio service stop waits for utility process confirmation before marking stopped', async () => {
  const service = new DeferredAudioServiceBinding(['Stop'])
  service.playbackInfo = makePlaybackInfo({
    state: 'playing',
    source: 'service-track.flac',
    nativePlaybackActive: true
  })
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  await manager.play('service-track.flac', 0)

  const stopPromise = manager.stop()
  await new Promise((resolve) => setTimeout(resolve, 0))

  let info = await manager.getPlaybackInfo()
  assert.equal(service.stopCalls, 0)
  assert.equal(info.state, 'playing')
  assert.equal(info.nativePlaybackActive, true)

  service.resolveNextDeferredCall()
  await stopPromise

  info = await manager.getPlaybackInfo()
  assert.equal(service.stopCalls, 1)
  assert.equal(info.state, 'stopped')
  assert.equal(info.nativePlaybackActive, false)

  manager.destroy()
})

test('destroy skips duplicate native Stop after the manager is already destroyed', () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )

  manager.destroy()
  manager.destroy()

  assert.equal(nativeBinding.stopCalls, 1)
})

test('destroy skips duplicate audio service teardown after the manager is already destroyed', () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  manager.destroy()
  manager.destroy()

  assert.equal(service.stopCalls, 1)
  assert.equal(service.destroyCalls, 1)
})

test('setNativeDspPluginChain skips native calls when chain JSON is unchanged', () => {
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding
  )
  const playbackUpdates: PlaybackInfo[] = []
  manager.on('playback-info', (info: PlaybackInfo) => playbackUpdates.push(info))
  const chainJson = '{"plugins":[{"id":"com.example.eq"}]}'

  manager.setNativeDspPluginChain(chainJson)
  assert.equal(nativeBinding.nativeDspPluginChainCalls, 1)
  assert.equal(nativeBinding.nativeDspPluginChainJson, chainJson)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 0)

  manager.setNativeDspPluginChain(chainJson)
  assert.equal(nativeBinding.nativeDspPluginChainCalls, 1)
  assert.equal(nativeBinding.playbackInfoReads, 0)
  assert.equal(playbackUpdates.length, 0)
})

test('getNativeDspPluginStatus reuses native status within the polling cache window', () => {
  const nativeBinding = new FakeNativeBinding()
  let now = 1000
  const manager = makeManager(
    {
      exclusiveMode: false,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  const first = manager.getNativeDspPluginStatus() as { plugins: Array<{ reads: number }> }
  const second = manager.getNativeDspPluginStatus() as { plugins: Array<{ reads: number }> }

  assert.equal(nativeBinding.nativeDspPluginStatusReads, 1)
  assert.equal(second.plugins[0]?.reads, first.plugins[0]?.reads)

  manager.setNativeDspPluginChain('{"plugins":[{"id":"com.example.eq"}]}')
  const afterChainUpdate = manager.getNativeDspPluginStatus() as {
    plugins: Array<{ reads: number }>
  }

  assert.equal(nativeBinding.nativeDspPluginStatusReads, 2)
  assert.equal(afterChainUpdate.plugins[0]?.reads, 2)

  now += 250
  const refreshed = manager.getNativeDspPluginStatus() as { plugins: Array<{ reads: number }> }

  assert.equal(nativeBinding.nativeDspPluginStatusReads, 3)
  assert.equal(refreshed.plugins[0]?.reads, 3)
})

test('audio service ready after restart restores configuration and queue without auto-resume', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 512, routingMode: 'stereo-to-5.1' },
      audioProcessing: { eqEnabled: true, crossfeedEnabled: true, crossfeedStrength: 0.35 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const queue: AudioEngineQueueItem[] = [
    { id: 'local:one', source: 'one.flac', title: 'One' },
    { id: 'local:two', source: 'two.flac', title: 'Two' }
  ]
  let serviceReadyManualResumeRequired = false
  let serviceReadyOutputRouteSynced = false
  manager.on('audio-service-ready', ({ manualResumeRequired, outputRouteSynced }) => {
    serviceReadyManualResumeRequired = manualResumeRequired
    serviceReadyOutputRouteSynced = outputRouteSynced
  })

  await manager.start()
  assert.equal(service.callOrder.filter((method) => method === 'ApplyDspState').length, 1)
  assert.equal(service.eqBandsCalls, 0)
  assert.equal(service.replayGainCalls, 0)
  assert.equal(service.crossfeedCalls, 0)

  await manager.setAudioOutput('asio', 'asio:studio')
  await manager.loadQueue(queue, 1)
  manager.setNativeDspPluginChain('{"plugins":[{"id":"com.example.eq"}]}')
  await manager.play('two.flac', 12)
  const appliesBeforeRestart = service.callOrder.filter(
    (method) => method === 'ApplyDspState'
  ).length
  service.emit('crash', 'service crashed')

  service.backend = 'wasapi'
  service.device = 'auto'
  service.outputConfig = {}
  service.dspConfig = {}
  service.dspPluginChain = ''
  service.queue = []
  service.queueIndex = -1
  service.playCalls = 0
  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(serviceReadyManualResumeRequired, true)
  assert.equal(serviceReadyOutputRouteSynced, true)
  assert.equal(service.backend, 'asio')
  assert.equal(service.device, 'asio:studio')
  assert.equal(service.outputConfig.preferredBufferSize, 512)
  assert.equal(service.outputConfig.routingMode, 'stereo-to-5.1')
  assert.equal(service.dspConfig.eqEnabled, true)
  assert.equal(service.dspConfig.crossfeedStrength, 0.35)
  assert.equal(
    service.callOrder.filter((method) => method === 'ApplyDspState').length,
    appliesBeforeRestart + 1
  )
  assert.equal(service.eqBandsCalls, 0)
  assert.equal(service.replayGainCalls, 0)
  assert.equal(service.crossfeedCalls, 0)
  assert.equal(service.dspPluginChain, '{"plugins":[{"id":"com.example.eq"}]}')
  assert.deepEqual(service.queue, queue)
  assert.equal(service.queueIndex, 1)
  assert.equal(service.playCalls, 0)
  manager.destroy()

  const info = await manager.getPlaybackInfo()
  assert.equal(info.state, 'stopped')
  assert.equal(info.nativePlaybackActive, false)

  manager.destroy()
})

test('audio service ready keeps output route unsynced until restore RPCs acknowledge', async () => {
  const service = new DeferredAudioServiceBinding([
    'SetOutputBackend',
    'SetOutputDevice',
    'SetOutputConfig'
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 512 },
      audioProcessing: { eqEnabled: true, crossfeedEnabled: true, crossfeedStrength: 0.35 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }
  let serviceReadyManualResumeRequired = false
  let serviceReadyOutputRouteSynced = false
  manager.on('audio-service-ready', ({ manualResumeRequired, outputRouteSynced }) => {
    serviceReadyManualResumeRequired = manualResumeRequired
    serviceReadyOutputRouteSynced = outputRouteSynced
  })

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup
  const initialRouteSwitch = manager.setAudioOutput('asio', 'asio:studio')
  await resolveDeferredRouteCalls(service)
  await initialRouteSwitch
  const queue: AudioEngineQueueItem[] = [
    { id: 'local:one', source: 'one.flac', title: 'One' },
    { id: 'local:two', source: 'two.flac', title: 'Two' }
  ]
  await manager.loadQueue(queue, 1)
  manager.setNativeDspPluginChain('{"plugins":[{"id":"com.example.eq"}]}')
  service.emit('crash', 'service crashed before route restore')
  service.backend = 'wasapi'
  service.device = 'auto'
  service.outputConfig = {}
  service.dspConfig = {}
  service.dspPluginChain = ''
  service.queue = []
  service.queueIndex = -1

  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.equal(serviceReadyManualResumeRequired, false)
  assert.equal(serviceReadyOutputRouteSynced, false)
  assert.deepEqual(service.dspConfig, {})
  assert.equal(service.dspPluginChain, '')
  assert.deepEqual(service.queue, [])
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputBackend']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputDevice']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(internals.nativeOutputRouteSynced, true)
  assert.equal(serviceReadyManualResumeRequired, true)
  assert.equal(serviceReadyOutputRouteSynced, true)
  assert.equal(service.backend, 'asio')
  assert.equal(service.device, 'asio:studio')
  assert.equal(service.outputConfig.preferredBufferSize, 512)
  assert.equal(service.dspConfig.eqEnabled, true)
  assert.equal(service.dspConfig.crossfeedStrength, 0.35)
  assert.equal(service.dspPluginChain, '{"plugins":[{"id":"com.example.eq"}]}')
  assert.deepEqual(service.queue, queue)
  assert.equal(service.queueIndex, 1)

  manager.destroy()
})

test('audio service ready waits for DSP and queue restore RPCs before enabling manual resume', async () => {
  const service = new DeferredAudioServiceBinding([
    'SetOutputBackend',
    'SetOutputDevice',
    'SetOutputConfig'
  ])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 512 },
      audioProcessing: { eqEnabled: true, crossfeedEnabled: true, crossfeedStrength: 0.35 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const serviceReadyEvents: Array<{
    manualResumeRequired: boolean
    outputRouteSynced: boolean
    restoreErrors: string[]
  }> = []
  manager.on('audio-service-ready', (event) => {
    serviceReadyEvents.push(event)
  })

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup
  const initialRouteSwitch = manager.setAudioOutput('asio', 'asio:studio')
  await resolveDeferredRouteCalls(service)
  await initialRouteSwitch
  const queue: AudioEngineQueueItem[] = [
    { id: 'local:one', source: 'one.flac', title: 'One' },
    { id: 'local:two', source: 'two.flac', title: 'Two' }
  ]
  await manager.loadQueue(queue, 1)
  manager.setNativeDspPluginChain('{"plugins":[{"id":"com.example.eq"}]}')
  service.deferredMethods.add('ApplyDspState')
  service.deferredMethods.add('SetDspPluginChain')
  service.deferredMethods.add('LoadQueue')
  service.emit('crash', 'service crashed before full restore')
  service.backend = 'wasapi'
  service.device = 'auto'
  service.outputConfig = {}
  service.dspConfig = {}
  service.dspPluginChain = ''
  service.queue = []
  service.queueIndex = -1

  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(serviceReadyEvents.length, 0)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputBackend']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(serviceReadyEvents.length, 0)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputDevice']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(serviceReadyEvents.length, 0)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetOutputConfig']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(serviceReadyEvents.length, 0)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['SetDspPluginChain']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(serviceReadyEvents.length, 0)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['ApplyDspState']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(serviceReadyEvents.length, 0)
  assert.deepEqual(
    service.deferredCalls.map((call) => call.method),
    ['LoadQueue']
  )

  service.resolveNextDeferredCall()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(serviceReadyEvents.length, 1)
  assert.equal(serviceReadyEvents[0].manualResumeRequired, true)
  assert.equal(serviceReadyEvents[0].outputRouteSynced, true)
  assert.deepEqual(serviceReadyEvents[0].restoreErrors, [])
  assert.equal(service.dspConfig.eqEnabled, true)
  assert.equal(service.dspConfig.crossfeedStrength, 0.35)
  assert.equal(service.dspPluginChain, '{"plugins":[{"id":"com.example.eq"}]}')
  assert.deepEqual(service.queue, queue)
  assert.equal(service.queueIndex, 1)

  manager.destroy()
})

test('audio service ready reports output route restore failures without enabling resume', async () => {
  const service = new DeferredAudioServiceBinding(['SetOutputDevice'])
  const manager = new AudioEngineManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto',
      audioOutputConfig: { preferredBufferSize: 512 }
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const internals = manager as unknown as {
    nativeOutputRouteSynced: boolean
  }
  const serviceReadyEvents: Array<{
    manualResumeRequired: boolean
    outputRouteSynced: boolean
    restoreErrors: string[]
  }> = []
  manager.on('audio-service-ready', (event) => {
    serviceReadyEvents.push(event)
  })

  const startup = manager.start()
  await resolveDeferredRouteCalls(service)
  await startup
  const initialRouteSwitch = manager.setAudioOutput('asio', 'asio:studio')
  await resolveDeferredRouteCalls(service)
  await initialRouteSwitch
  service.emit('crash', 'service crashed before route restore failure')
  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(serviceReadyEvents.length, 0)
  assert.equal(internals.nativeOutputRouteSynced, false)

  service.rejectDeferredCalls(new Error('device disappeared'))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(internals.nativeOutputRouteSynced, false)
  assert.equal(serviceReadyEvents.length, 1)
  assert.equal(serviceReadyEvents[0].manualResumeRequired, true)
  assert.equal(serviceReadyEvents[0].outputRouteSynced, false)
  assert.match(serviceReadyEvents[0].restoreErrors.join('\n'), /device disappeared/)

  manager.destroy()
})

test('setPlaybackRate clamps, fans out to native, and marks non-unity rate imperfect', async () => {
  const nativeBinding = new FakeNativeBinding({
    state: 'playing',
    volume: 1,
    playbackRate: 1,
    outputPerfect: true,
    perfectReasonCode: '',
    outputInfo: makeOutputInfo({
      outputPerfect: true,
      supportsOutputPerfect: true,
      perfectReasonCode: '',
      perfectReason: ''
    })
  })
  const manager = new AudioEngineManager({ exclusiveMode: false }, { nativeBinding })

  await manager.setPlaybackRate(1.25)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 1.25)
  assert.equal(nativeBinding.playbackInfo.playbackRate, 1.25)
  // Non-unity rate forces processingActive / non-perfect on the JS-side evaluation path
  // when native is not driving playback ticks.
  assert.equal((await manager.getPlaybackInfo()).dspActive, true)

  await manager.setPlaybackRate(3)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 2)

  await manager.setPlaybackRate(0.1)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 0.5)

  await manager.setPlaybackRate(1)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 1)

  manager.destroy()
})

test('play preserves non-unity playbackRate and reasserts SetPlaybackRate on native', async () => {
  const nativeBinding = new FakeNativeBinding({
    state: 'stopped',
    volume: 1,
    playbackRate: 1,
    outputPerfect: true,
    perfectReasonCode: '',
    outputInfo: makeOutputInfo({
      outputPerfect: true,
      supportsOutputPerfect: true,
      perfectReasonCode: '',
      perfectReason: ''
    })
  })
  const manager = new AudioEngineManager({ exclusiveMode: false }, { nativeBinding })
  await manager.setPlaybackRate(1.5)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 1.5)

  // Simulate native GetPlaybackInfo defaulting rate to 1 after Play.
  const originalPlay = nativeBinding.Play
  nativeBinding.Play = (source: string, startTime = 0): void => {
    originalPlay(source, startTime)
    nativeBinding.playbackInfo = {
      ...nativeBinding.playbackInfo,
      playbackRate: 1
    }
  }

  await manager.play('C:\\music\\track.flac', 0)
  assert.equal((await manager.getPlaybackInfo()).playbackRate, 1.5)
  assert.equal(nativeBinding.playbackInfo.playbackRate, 1.5)

  manager.destroy()
})

test('play preserves saved volume and reasserts SetVolume on native', async () => {
  const nativeBinding = new FakeNativeBinding({
    state: 'stopped',
    volume: 1,
    playbackRate: 1,
    outputPerfect: true,
    perfectReasonCode: '',
    outputInfo: makeOutputInfo({
      outputPerfect: true,
      supportsOutputPerfect: true,
      perfectReasonCode: '',
      perfectReason: ''
    })
  })
  const manager = new AudioEngineManager({ exclusiveMode: false, volume: 0.42 }, { nativeBinding })
  assert.equal((await manager.getPlaybackInfo()).volume, 0.42)

  // Simulate native GetPlaybackInfo defaulting volume to 1 after Play (the
  // exact failure mode where a startup SetVolume was lost and the restored
  // engine would otherwise stay at unity loudness).
  const originalPlay = nativeBinding.Play
  nativeBinding.Play = (source: string, startTime = 0): void => {
    originalPlay(source, startTime)
    nativeBinding.playbackInfo = {
      ...nativeBinding.playbackInfo,
      volume: 1
    }
  }

  await manager.play('C:\\music\\track.flac', 0)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.42)
  assert.equal(nativeBinding.playbackInfo.volume, 0.42)
  assert.ok(nativeBinding.volumeCalls >= 1)

  manager.destroy()
})

test('main-only sleep gain attenuates native output without changing public/user volume, including a later play', async () => {
  const binding = new FakeNativeBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false, volume: 0.7 },
    { nativeBinding: binding, scheduler: TEST_SCHEDULER }
  )
  await manager.setSleepTimerGain(0.5)
  assert.equal(binding.playbackInfo.volume, 0.35)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.7)
  await manager.setVolume(0.4)
  assert.equal(binding.playbackInfo.volume, 0.2)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.4)
  await manager.play('C:\\music\\track.flac', 0)
  assert.equal(binding.playbackInfo.volume, 0.2)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.4)
  await manager.setAudioDevice('dac-1')
  assert.equal(binding.playbackInfo.volume, 0.2, 'a route commit must retain temporary attenuation')
  binding.failNextOutputConfig = 'target topology rejected'
  await assert.rejects(manager.setAudioOutput('asio', 'asio:studio'), /target topology rejected/)
  assert.equal(binding.playbackInfo.volume, 0.2, 'route rollback must also retain attenuation')
  assert.equal((await manager.getPlaybackInfo()).volume, 0.4)
  await manager.setSleepTimerGain(1)
  assert.equal(binding.playbackInfo.volume, 0.4)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.4)
  manager.destroy()
})

test('service-ready restore reapplies attenuation, never temporary gain as the saved user volume', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false, volume: 0.6 },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  await manager.start()
  await manager.setSleepTimerGain(0.25)
  assert.equal(service.volume, 0.15)
  service.volume = 1
  service.emit('ready')
  await new Promise((done) => setTimeout(done, 0))
  await new Promise((done) => setTimeout(done, 0))
  assert.equal(service.volume, 0.15)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.6)
  await manager.setSleepTimerGain(1)
  assert.equal(service.volume, 0.6)
  manager.destroy()
})

test('getPlaybackInfo refresh never lets a native unity report clobber the saved volume', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    {
      exclusiveMode: false,
      volume: 0.31,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )

  await manager.start()
  assert.equal(service.volume, 0.31)

  // Auto-resume starts native playback before the service confirms the saved
  // volume; the fresh engine reports unity (the exact failure mode where a
  // startup SetVolume was dropped before the pipeline existed).
  await manager.play('C:\\music\\track.flac', 0)
  service.playbackInfo = makePlaybackInfo({
    state: 'playing',
    nativePlaybackActive: true,
    volume: 1
  })

  // The renderer's getPlaybackInfo refresh must not adopt the transient unity
  // report; otherwise a later restore re-applies 1.0 while the UI still shows
  // the saved volume (user hears 100% despite the slider showing the old value).
  assert.equal((await manager.getPlaybackInfo()).volume, 0.31)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.31)

  // A later service-ready restore must re-apply the saved volume, not unity.
  service.emit('ready')
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(service.volume, 0.31)
  assert.equal((await manager.getPlaybackInfo()).volume, 0.31)
  manager.destroy()
})

test('loudnorm status event, library RG queue fields, and cancel IPC are wired end-to-end', () => {
  const managerSource = readFileSync(new URL('./audioEngineManager.ts', import.meta.url), 'utf8')
  const engineIpcSource = readFileSync(new URL('./audio/engineIpc.ts', import.meta.url), 'utf8')
  const loudnessIpcSource = readFileSync(new URL('./audio/loudnessIpc.ts', import.meta.url), 'utf8')
  const queuePrepSource = readFileSync(
    new URL('../renderer/src/utils/nativeQueuePreparation.ts', import.meta.url),
    'utf8'
  )
  const hifiSource = readFileSync(
    new URL('../renderer/src/components/player-bar/HiFiSidebar.vue', import.meta.url),
    'utf8'
  )
  const settingsSource = readFileSync(
    new URL('../renderer/src/components/SettingsPage.vue', import.meta.url),
    'utf8'
  )
  const dspSettingsSource = readFileSync(
    new URL('../renderer/src/components/settings-page/DspSettingsSection.vue', import.meta.url),
    'utf8'
  )
  const playerStoreSource = readFileSync(
    new URL('../renderer/src/stores/player/corePlayerStore.ts', import.meta.url),
    'utf8'
  )
  const playerSessionTrackSource = readFileSync(
    new URL('../core/playback/sessionTrack.ts', import.meta.url),
    'utf8'
  )
  const dspStoreSource = readFileSync(
    new URL('../renderer/src/stores/useAudioOutputDspStore.ts', import.meta.url),
    'utf8'
  )
  const preloadSource = readPreloadSources()
  const preloadDtsSource = readFileSync(new URL('../preload/index.d.ts', import.meta.url), 'utf8')
  const pipelineSource = readFileSync(
    new URL('../../audio-engine/core/AudioPipeline.cpp', import.meta.url),
    'utf8'
  )
  const engineCppSource = readFileSync(
    new URL('../../audio-engine/core/TwilightAudioEngine.cpp', import.meta.url),
    'utf8'
  )

  const dspOrchestratorSource = readFileSync(
    new URL('../core/audio/dspOrchestrator.ts', import.meta.url),
    'utf8'
  )
  assert.ok(managerSource.includes("emit('loudnorm-status'"))
  assert.ok(managerSource.includes('syncLoudnormModeTransition'))
  assert.ok(managerSource.includes('notifyLoudnessCacheCleared'))
  // setReplayGainMode must rewrite legacy graph via setAudioProcessing (no dual-path drift).
  assert.match(
    dspOrchestratorSource,
    /async setReplayGainMode[\s\S]*?return this\.setAudioProcessing\(/
  )
  assert.ok(
    managerSource.includes('loudnessAnalysisManager.cancel') ||
      managerSource.includes('this.loudnessAnalysisManager.cancel') ||
      managerSource.includes('.cancel(')
  )
  assert.ok(managerSource.includes('this.destroyed'))
  assert.ok(engineIpcSource.includes("on('loudnorm-status'"))
  assert.ok(
    readFileSync(new URL('../shared/ipcChannels.ts', import.meta.url), 'utf8').includes(
      "'audioEngine:loudnorm-status'"
    )
  )
  assert.ok(engineIpcSource.includes('IPC.audioEngine.loudnormStatus'))
  assert.ok(engineIpcSource.includes('replayGainTrackGainDb'))
  assert.ok(engineIpcSource.includes('r128TrackGainDb'))
  assert.ok(loudnessIpcSource.includes('loudnessAnalysis:cancel'))
  assert.ok(loudnessIpcSource.includes('runtime.audioAnalysisService'))
  assert.ok(loudnessIpcSource.includes('service.analyzeLoudness'))
  assert.ok(loudnessIpcSource.includes("cancelBySource(filePath, 'loudness')"))
  assert.ok(queuePrepSource.includes('replayGainTrackGainDb'))
  assert.ok(queuePrepSource.includes('r128AlbumGainDb'))
  assert.ok(preloadSource.includes('onLoudnormStatus'))
  assert.ok(preloadSource.includes('IPC.audioEngine.loudnormStatus'))
  assert.ok(preloadSource.includes('loudnessAnalysis:cancel'))
  assert.ok(playerStoreSource.includes('loudnormStatus'))
  assert.ok(playerStoreSource.includes('core.state.value?.loudness?.status'))
  assert.ok(playerSessionTrackSource.includes('replayGainTrackGainDb'))
  assert.ok(dspStoreSource.includes('loudnormStatus: player.loudnormStatus'))
  assert.ok(hifiSource.includes('loudnormStatusCopy'))
  assert.ok(hifiSource.includes('loudnormStatusText'))
  assert.ok(dspSettingsSource.includes('loudnormStatusCopy'))
  assert.ok(dspSettingsSource.includes('settings-loudnorm-status'))
  assert.ok(settingsSource.includes('确认清理 Loudnorm'))
  assert.ok(
    readFileSync(new URL('../shared/audioEngineTypes.ts', import.meta.url), 'utf8').includes(
      'replayGainTrackGainDb'
    )
  )
  assert.ok(
    readFileSync(new URL('../shared/audioEngineTypes.ts', import.meta.url), 'utf8').includes(
      'r128AlbumGainDb'
    )
  )
  assert.ok(preloadDtsSource.includes('TrackData'))
  assert.ok(pipelineSource.includes('refreshQueueReplayGainTags'))
  assert.ok(engineCppSource.includes('refreshQueueReplayGainTags'))
  assert.ok(pipelineSource.includes('lastPreloadFormatMismatch_'))
  assert.ok(
    pipelineSource.includes('"format_mismatch"') || pipelineSource.includes('format_mismatch')
  )
  assert.ok(
    readFileSync(new URL('./audio/loudnessIpc.ts', import.meta.url), 'utf8').includes(
      'notifyLoudnessCacheCleared'
    )
  )
})

test('paused native polling throttles service refreshes to one per four ticks', async () => {
  let now = 500
  const nativeBinding = new FakeNativeBinding()
  const manager = makeManager(
    {
      exclusiveMode: true,
      audioOutput: 'wasapi',
      audioDevice: 'auto'
    },
    nativeBinding,
    {
      now: () => now
    }
  )

  await manager.play('track.flac', 0)
  nativeBinding.playbackInfo = {
    ...nativeBinding.playbackInfo,
    state: 'paused',
    position: 3
  }
  const tickManager = manager as unknown as { tick: () => void }
  tickManager.tick()

  let nativeReads = 0
  const original = nativeBinding.GetPlaybackInfo
  nativeBinding.GetPlaybackInfo = () => {
    nativeReads += 1
    return original.call(nativeBinding)
  }

  for (let index = 0; index < 8; index += 1) {
    now += 250
    tickManager.tick()
  }
  assert.equal(nativeReads, 2)

  nativeBinding.GetPlaybackInfo = original
  const info = await manager.getPlaybackInfo()
  assert.equal(info.state, 'paused')
})

test('failed service-mode queue load rolls the native queue back to the local mirror', async () => {
  const service = new FakeAudioServiceBinding()
  const manager = new AudioEngineManager(
    { exclusiveMode: false },
    {
      audioServiceFactory: () => service,
      scheduler: TEST_SCHEDULER,
      deviceOptionsProvider: () => DEVICE_OPTIONS
    }
  )
  const firstQueue: AudioEngineQueueItem[] = [{ id: 'one', source: 'first.flac', title: 'First' }]
  const secondQueue: AudioEngineQueueItem[] = [
    { id: 'two', source: 'second.flac', title: 'Second' }
  ]
  await manager.loadQueue(firstQueue, 0)
  assert.deepEqual(service.queue, firstQueue)

  let loadQueueCalls = 0
  const originalLoadQueue = service.LoadQueue
  service.LoadQueue = (queueJson: string, startIndex: number): void => {
    loadQueueCalls += 1
    originalLoadQueue.call(service, queueJson, startIndex)
  }
  let failedOnce = false
  service.SetPlayMode = (): void => {
    if (!failedOnce) {
      failedOnce = true
      throw new Error('transient play-mode failure')
    }
  }

  // The rejection now carries its catalog code as a `[TE-ERR:...]` sentinel
  // instead of a pre-rendered Chinese sentence, so the renderer can translate it.
  // Asserting the code keeps this test independent of the copy.
  await assert.rejects(manager.loadQueue(secondQueue, 0), /TE-ERR:audio\.play_mode_sync_failed/)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(service.queue, firstQueue)
  assert.equal(service.queueIndex, 0)
  assert.equal(loadQueueCalls, 2)

  manager.destroy()
})

test('group timed media prepares after source setup and never retries a failed Play through ASIO fallback', async () => {
  const service = new FakeAudioServiceBinding(), order: string[] = []
  const original = service.callAsync.bind(service)
  let rejectPlay = false
  service.callAsync = async (method, args) => {
    order.push(method)
    if (method === 'Play' && rejectPlay) throw new Error('timed native play failed')
    return original(method, args)
  }
  const manager = new AudioEngineManager({ audioOutput: 'asio', exclusiveMode: true }, {
    audioServiceFactory: () => service, initialBridgeSelected: true,
    scheduler: TEST_SCHEDULER, deviceOptionsProvider: () => DEVICE_OPTIONS
  })
  const warn = console.warn; console.warn = () => {}
  try {
    await manager.loadQueue([{ id: 'a', source: 'tone.flac', queueEntryId: 'one' }], 0)
    order.length = 0
    assert.equal((await manager.playTimedBridge('tone.flac', 2, () => true)).nativeStarted, true)
    assert.ok(order.indexOf('BridgePrepareTimed') >= 0)
    assert.ok(order.indexOf('BridgePrepareTimed') < order.indexOf('Play'))
    assert.ok(order.indexOf('BridgeReleaseTimedMedia') > order.lastIndexOf('ApplyDspState'))
    assert.ok(order.indexOf('BridgeReleaseTimedMedia') > order.indexOf('Play'))
    assert.equal(order.slice(order.indexOf('BridgePrepareTimed')+1).includes('LoadQueue'), false)
    await manager.stop()
    rejectPlay = true; order.length = 0
    await assert.rejects(manager.playTimedBridge('tone.flac', 0, () => true), /timed native play failed/)
    assert.equal(order.filter(m => m === 'Play').length, 1)
    assert.equal(order.filter(m => m === 'BridgePrepareTimed').length, 1)
    assert.equal(order.slice(order.indexOf('Play')+1).includes('SetOutputBackend'), false)
    order.length = 0
    assert.equal((await manager.playTimedBridge('tone.flac', 0, () => false)).superseded, true)
    assert.equal(order.includes('BridgePrepareTimed'), false)
    assert.equal(order.includes('Play'), false)
  } finally { console.warn = warn; manager.destroy() }
})
