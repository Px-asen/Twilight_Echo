import type { DspStatePayload } from '../../shared/audioServiceContract.ts'
import type { DspGraphStatus, Vst3ScanDescriptor } from '../../shared/dspGraph.ts'
import type {
  AudioDeviceOption,
  BpmAnalysisResult,
  ConvolverInfo,
  CorePlatformId,
  LoudnessAnalysisResult,
  NativeAudioMetadata,
  PlaybackInfo,
  VisualizationData
} from '../../shared/audioEngineTypes.ts'

export type * from '../../shared/audioEngineTypes.ts'

export type { DspSceneState } from '../../shared/dspGraph.ts'

export interface AudioEngineScheduler {
  now: () => number
  setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  setImmediate: (callback: () => void) => void
}

export interface NativeAudioBinding {
  Play: (source: string, startTime?: number) => void
  Pause: () => void
  Stop: () => void
  Seek: (time: number) => void
  SetVolume: (volume: number) => void
  SetPlaybackRate: (rate: number) => void
  SetAutoMixMode?: (mode: import('../../shared/twilightAutoMix.ts').AutoMixMode) => void
  SelectAutoMix?: (requestJson: string) => string | Promise<unknown>
  BindBridgeAutoMixSelection?: (requestJson: string) => string | Promise<unknown>
  PrepareAutoMix?: (requestJson: string) => void
  SubmitAutoMix?: (planId: number) => void
  CancelAutoMix?: () => void
  /** A-B loop; end <= start clears. Optional on older native bindings. */
  SetLoopRange?: (startSeconds: number, endSeconds: number) => void
  SetOutputDevice: (device: string) => void
  SetOutputBackend: (backend: string) => void
  SetOutputConfig?: (json: string) => void
  LoadQueue?: (queueJson: string, startIndex: number) => void
  RebindQueue?: (
    queueJson: string,
    startIndex: number,
    mode: string,
    expectedJson: string,
    expectedIndex: number
  ) => boolean | Promise<boolean>
  /** Hot append: returns void; the host mirror owns the first appended index. */
  AppendQueueItems?: (itemsJson: string) => void
  /** Refresh a non-current queued item's source (expiring provider URL). */
  UpdateQueueItemSource?: (index: number, source: string) => void
  GetQueueState?: () => string | import('../../shared/audioEngineTypes.ts').AudioEngineQueueState
  SelectQueueIndex?: (index: number) => void
  Next?: () => void
  Previous?: () => void
  SetPlayMode?: (mode: 'sequential' | 'repeat' | 'shuffle') => void
  SetDspConfig?: (json: string) => void
  SetDspGraph?: (json: string) => void
  ApplyDspState: (revision: number, json: string) => void
  GetDspGraphStatus: () => string | DspGraphStatus
  LoadImpulseResponse?: (path: string) => void
  UnloadImpulseResponse?: () => void
  GetConvolverInfo?: () => string | ConvolverInfo
  SetEqBands?: (json: string) => void
  SetEqPreset?: (json: string) => void
  SetCrossfeedStrength?: (strength: number) => void
  SetReplayGainMode?: (
    mode: import('../../shared/audioProcessingOptions.ts').VolumeNormalizationMode,
    preamp: number,
    fallback: number,
    clip: boolean
  ) => void
  SetDspPluginChain?: (json: string) => void
  GetDspPluginStatus?: () => string | { plugins: unknown[] }
  ScanVst3Module?: (modulePath: string) => string | Vst3ScanDescriptor
  GetMetadata?: (source: string) => string | NativeAudioMetadata
  GetPlaybackInfo?: () => string | PlaybackInfo
  /** 引擎诊断事件环形日志：返回 sequence 大于 sinceSequence 的新条目（JSON 数组字符串）。 */
  GetDiagnosticLog?: (sinceSequence?: number, maxEntries?: number) => string
  GetUpcomingTrack?: () =>
    | string
    | import('../../shared/audioEngineTypes.ts').AudioEngineQueueItem
    | null
  GetSpectrumData?: (points?: number) => number[]
  GetVisualizationData?: (optionsJson: string) => string | VisualizationData
  SetVisualizationDemand?: (enabled: boolean) => void
  AnalyzeBpm?: (source: string, optionsJson?: string) => string | BpmAnalysisResult
  AnalyzeLoudness?: (source: string, optionsJson?: string) => string | LoudnessAnalysisResult
  /** Background worker only; writes a bounded, unprocessed PCM WAV. */
  RenderPcmSegment?: (
    source: string, outputPath: string, startSeconds: number, endSeconds: number,
    virtualPregapSeconds: number
  ) => void
  AnalyzeAutoMix?: (
    source: string,
    optionsJson?: string
  ) => string | import('../../shared/twilightAutoMix.ts').AutoMixAnalysisResult
  EnumerateDevices?: () => string | AudioDeviceOption[]
  EnumerateBackends?: () => string
  GetEngineCapabilities?: () => string
  GetLastError?: () => string
  /** 异步调用原生方法（service 模式下等待 utility 进程返回）。直接 N-API 模式不实现此方法。 */
  callAsync?: (method: string, args: unknown[]) => Promise<unknown>
}

export interface AudioEngineServiceNativeBinding extends NativeAudioBinding {
  getDiagnosticEvidence?(): unknown
  getMetadataAsync: (source: string) => Promise<string | NativeAudioMetadata>
  /** Full native capability JSON; the sync accessor is a synthetic subset. */
  getEngineCapabilitiesAsync?: () => Promise<string>
  applyDspState: (revision: number, payload: DspStatePayload) => Promise<DspGraphStatus>
  applyDspGraph: (json: string) => Promise<DspGraphStatus>
  getDspGraphStatusAsync: () => Promise<DspGraphStatus>
  setLoopRangeConfirmed?: (start: number, end: number) => Promise<boolean>
  destroy: () => void
  // Present on the real service binding: the fatal-startup latch and its manual
  // release. Optional so lightweight test doubles need not implement them.
  restartAfterFatal?: () => boolean
  /** Manual recovery joins the old process before maintenance and a fresh ready handshake. */
  restart?: (maintenance?: () => Promise<void>) => Promise<void>
  /** Stop restart timers and join any remaining audio process before Core exits. */
  shutdown?: () => Promise<void>
  readonly fatalStartupError?: string
  on: (
    event: 'crash' | 'error-log' | 'log' | 'ready' | 'rpc-timeout',
    listener: (...args: any[]) => void
  ) => unknown
}

export interface AudioOutputCommit {
  audioOutput: import('../../shared/audioEngineTypes.ts').AudioOutputId
  audioDevice: string
  audioExclusiveMode: boolean
  audioOutputConfig: import('../../shared/audioEngineTypes.ts').OutputConfig
}

export interface AudioEngineManagerDependencies {
  initialBridgeSelected?: boolean
  deferNativeStartup?: boolean
  persistBridgeSelection?: (selected: boolean) => Promise<void>
  platform?: CorePlatformId
  persistAudioOutput?: (commit: AudioOutputCommit) => void
  persistDeviceProfiles?: (commit: import('./deviceProfiles.ts').DeviceProfileCommit) => void
  nativeBinding?: NativeAudioBinding | null
  scheduler?: Partial<AudioEngineScheduler>
  deviceOptionsProvider?: () => AudioDeviceOption[] | null
  nativeAddonCandidates?: () => string[]
  audioServiceEntry?: string
  audioServiceFactory?: () => AudioEngineServiceNativeBinding
  dspAssetPathResolver?: (assetId: string) => string | null
  vst3ModuleResolver?: (
    catalogId: string,
    classId: string
  ) => {
    modulePath: string | null
    classId: string
    reason: string
  }
  vst3StateAssetResolver?: (assetId: string) => {
    path: string | null
    kind: 'vst3Preset' | 'vst3State' | null
    reason: string
  }
}
