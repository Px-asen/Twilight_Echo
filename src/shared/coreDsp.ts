import type {
  AudioProcessingSettings,
  ConvolverInfo,
  HeadphoneCompensationSettings
} from './audioEngineTypes.ts'
import type { EqualizerAutoPreamp } from './equalizerPreferences.ts'
import type { DspAuditionRequest, DspAuditionResult } from './dspAudition.ts'
export interface CoreAuditionMeasure extends Omit<DspAuditionRequest, 'source'> {
  revision: number
}
export interface CoreAuditionState {
  revision: number
  measuring: boolean
  result: DspAuditionResult | null
}
import type {
  DspAssetKind,
  DspOutputStageConfig,
  DspScene,
  DspSceneState,
  DspStereoImageConfig,
  Vst3CatalogEntry,
  Vst3HelpersAvailability,
  Vst3ParameterDescriptor
} from './dspGraph.ts'

export interface CoreDspState {
  revision: number
  processing: AudioProcessingSettings
  autoPreamp: EqualizerAutoPreamp | null
  headphoneCompensation: HeadphoneCompensationSettings
  scenes: DspSceneState
  convolver: ConvolverInfo
}
export interface CoreDspEdit {
  revision: number
  edit:
    | { kind: 'processing'; settings: Partial<AudioProcessingSettings> }
    | { kind: 'autoPreamp'; enabled: boolean }
    | { kind: 'headphoneCompensation'; settings: Partial<HeadphoneCompensationSettings> }
    | { kind: 'scenes'; scenes: DspScene[]; pinnedSceneId: string | null }
    | { kind: 'apply'; id: string | null; confirmDsdPcmFallback?: boolean }
    | { kind: 'outputStage'; settings: Partial<DspOutputStageConfig> }
    | { kind: 'stereoImage'; settings: Partial<DspStereoImageConfig> }
}
export interface CoreDspImport {
  revision: number
  kind: DspAssetKind | 'profile' | 'frequencyResponse' | 'impulsePath'
}
export interface CoreVst3Edit {
  revision: number
  edit:
    | { kind: 'enabled'; enabled: boolean }
    | { kind: 'searchPaths'; paths: string[] }
    | { kind: 'scan' }
    | { kind: 'clearQuarantine'; id: string }
}
export interface CoreVst3Page {
  revision: number
  enabled: boolean
  searchPaths: string[]
  helpers?: Vst3HelpersAvailability
  total: number
  items: Omit<Vst3CatalogEntry, 'parameters'>[]
}
export interface CoreVst3Parameters {
  revision: number
  total: number
  items: Vst3ParameterDescriptor[]
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).every((key) => names.includes(key))
const text = (v: unknown, max = 32768) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const assetId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z]+:[a-f0-9]{64}$/.test(v)
const page = (v: Record<string, unknown>) =>
  (v.offset === undefined || uint(v.offset)) &&
  (v.limit === undefined || (uint(v.limit) && Number(v.limit) > 0 && Number(v.limit) <= 200))

/** The common boundary already enforces finite JSON and a byte budget. */
export function validCoreDspPayload(name: string, p: Record<string, unknown>): boolean {
  switch (name) {
    case 'audio.audition':
      return keys(p, [])
    case 'audio.audition.end':
      return keys(p, ['revision']) && uint(p.revision)
    case 'audio.audition.select':
      return (
        keys(p, ['revision', 'id', 'side']) &&
        uint(p.revision) &&
        text(p.id, 128) &&
        (p.side === 'a' || p.side === 'b')
      )
    case 'audio.audition.measure':
      return (
        keys(p, ['revision', 'startSeconds', 'endSeconds', 'a', 'b']) &&
        uint(p.revision) &&
        typeof p.startSeconds === 'number' &&
        typeof p.endSeconds === 'number' &&
        record(p.a) &&
        record(p.b)
      )
    case 'audio.dsp':
    case 'audio.dsp.status':
    case 'audio.vst3.chooseDirectory':
      return keys(p, [])
    case 'audio.dsp.assets':
    case 'audio.vst3':
      return keys(p, ['offset', 'limit']) && page(p)
    case 'audio.vst3.parameters':
      return (
        keys(p, ['id', 'revision', 'offset', 'limit']) &&
        text(p.id, 160) &&
        uint(p.revision) &&
        page(p)
      )
    case 'audio.dsp.correction':
      return keys(p, ['id']) && assetId(p.id)
    case 'audio.dsp.assetRemove':
      return keys(p, ['id', 'revision']) && assetId(p.id) && uint(p.revision)
    case 'audio.dsp.export':
      return keys(p, ['revision', 'name']) && uint(p.revision) && text(p.name, 120)
    case 'audio.dsp.import':
      return (
        keys(p, ['revision', 'kind']) &&
        uint(p.revision) &&
        [
          'impulseResponse',
          'correctionProfile',
          'vst3Preset',
          'vst3State',
          'profile',
          'frequencyResponse',
          'impulsePath'
        ].includes(String(p.kind))
      )
    case 'audio.vst3.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const e = p.edit
      switch (e.kind) {
        case 'enabled':
          return keys(e, ['kind', 'enabled']) && typeof e.enabled === 'boolean'
        case 'searchPaths':
          return (
            keys(e, ['kind', 'paths']) &&
            Array.isArray(e.paths) &&
            e.paths.length <= 32 &&
            e.paths.every((v) => text(v))
          )
        case 'scan':
          return keys(e, ['kind'])
        case 'clearQuarantine':
          return keys(e, ['kind', 'id']) && text(e.id, 160)
        default:
          return false
      }
    }
    case 'audio.dsp.edit': {
      if (!keys(p, ['revision', 'edit']) || !uint(p.revision) || !record(p.edit)) return false
      const e = p.edit
      switch (e.kind) {
        case 'autoPreamp':
          return keys(e, ['kind', 'enabled']) && typeof e.enabled === 'boolean'
        case 'processing':
        case 'headphoneCompensation':
        case 'outputStage':
        case 'stereoImage':
          return keys(e, ['kind', 'settings']) && record(e.settings)
        case 'scenes':
          return (
            keys(e, ['kind', 'scenes', 'pinnedSceneId']) &&
            Array.isArray(e.scenes) &&
            e.scenes.every(record) &&
            (e.pinnedSceneId === null || text(e.pinnedSceneId, 160))
          )
        case 'apply':
          return (
            keys(e, ['kind', 'id', 'confirmDsdPcmFallback']) &&
            (e.id === null || text(e.id, 160)) &&
            (e.confirmDsdPcmFallback === undefined || typeof e.confirmDsdPcmFallback === 'boolean')
          )
        default:
          return false
      }
    }
    default:
      return false
  }
}
