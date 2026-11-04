import type { DspAsset, DspAssetKind, Vst3HelpersAvailability, Vst3ParameterDescriptor } from './dspGraph.ts'
import { validZoneId } from './coreZones.ts'

export const DSP_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
export const DSP_UPLOAD_CHUNK_BYTES = 768 * 1024
export const DSP_LIBRARY_QUERIES = ['zones.dsp.library', 'zones.dsp.parameters', 'zones.dsp.profile.chunk'] as const
export const DSP_LIBRARY_COMMANDS = ['zones.dsp.library.edit', 'zones.dsp.upload.begin',
  'zones.dsp.upload.chunk', 'zones.dsp.upload.commit', 'zones.dsp.upload.cancel',
  'zones.dsp.profile.preview', 'zones.dsp.profile.import', 'zones.dsp.profile.export', 'zones.dsp.profile.release'] as const
export const isDspLibraryOperation = (name: string) =>
  ([...DSP_LIBRARY_QUERIES, ...DSP_LIBRARY_COMMANDS] as readonly string[]).includes(name)

export interface DspUploadBegin { zoneId: string; kind: DspAssetKind | 'profile'; fileName: string; byteSize: number }
export interface DspUploadKey { zoneId: string; uploadId: string }
export interface DspProfilePreview {
  previewId: string; revision: number; name: string
  scenes: { name: string; nodeCount: number }[]
  assetCount: number; assetBytes: number; issues: string[]
}
export interface DspProfileDownload { downloadId: string; fileName: string; byteSize: number; chunkBytes: number }
export interface DspParameterPage {
  revision: number; sceneId: string; nodeId: string; name: string; total: number; offset: number
  items: (Vst3ParameterDescriptor & { value: number | null; overridden: boolean })[]
}
export type DspLibraryEdit =
  | { kind: 'removeAsset'; id: string }
  | { kind: 'createScene'; name: string }
  | { kind: 'removeScene'; sceneId: string }
  | { kind: 'applyScene'; sceneId: string; confirmDsdPcmFallback: boolean }
  | { kind: 'bindImpulse'; sceneId: string; assetId: string }
  | { kind: 'bindCorrection'; sceneId: string; assetId: string }
  | { kind: 'addVst3'; sceneId: string; catalogId: string; stateAssetId: string | null }
  | { kind: 'removeNode'; sceneId: string; nodeId: string }
  | { kind: 'parameter'; sceneId: string; nodeId: string; parameterId: number; value: number | null }
  | { kind: 'vst3Enabled'; enabled: boolean }
  | { kind: 'scan' }
  | { kind: 'clearQuarantine'; id: string }
export interface DspLibraryPage {
  revision: number
  assets: { total: number; offset: number; items: DspAsset[] }
  plugins: { total: number; offset: number; items: {
    id: string; name: string; vendor: string; version: string; status: string; parameterCount: number
  }[] }
  scenes: { id: string; name: string; active: boolean; pinned: boolean; nodes: {
    id: string; type: string; enabled: boolean; assetId: string | null; catalogId: string | null
  }[] }[]
  vst3Enabled: boolean
  scanning: boolean
  scanFailed: boolean
  searchRootCount: number
  helpers: Vst3HelpersAvailability
  maxUploadBytes: number
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (p: Record<string, unknown>, keys: string[]) => Object.keys(p).every(k => keys.includes(k))
const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 160 && !/[\0\r\n]/.test(v)
const asset = (v: unknown) => typeof v === 'string' && /^(impulseResponse|correctionProfile|vst3Preset|vst3State):[a-f0-9]{64}$/.test(v)
export function validDspUploadFile(kind: unknown, name: unknown): boolean {
  if (!text(name) || /[\\/:]/.test(String(name)) || String(name).startsWith('.')) return false
  const extension = String(name).slice(String(name).lastIndexOf('.')).toLowerCase()
  const extensions: Record<string, string[]> = { impulseResponse: ['.wav', '.flac', '.aiff', '.aif'],
    correctionProfile: ['.txt', '.apo'], vst3Preset: ['.vstpreset'], vst3State: ['.vststate', '.bin'], profile: ['.tedsp'] }
  return Object.hasOwn(extensions, String(kind)) && extensions[String(kind)].includes(extension)
}
export function validDspLibraryPayload(name: string, p: Record<string, unknown>): boolean {
  if (!validZoneId(p.zoneId)) return false
  if (name === 'zones.dsp.parameters') return only(p, ['zoneId', 'revision', 'sceneId', 'nodeId', 'offset']) &&
    uint(p.revision) && text(p.sceneId) && text(p.nodeId) && (p.offset === undefined || uint(p.offset))
  if (name === 'zones.dsp.profile.preview') return only(p, ['zoneId', 'uploadId', 'revision']) && text(p.uploadId) && uint(p.revision)
  if (name === 'zones.dsp.profile.import') return only(p, ['zoneId', 'uploadId', 'previewId', 'revision']) && text(p.uploadId) && text(p.previewId) && uint(p.revision)
  if (name === 'zones.dsp.profile.export') return only(p, ['zoneId', 'revision', 'name']) && uint(p.revision) && text(p.name) && String(p.name).length <= 80
  if (name === 'zones.dsp.profile.chunk') return only(p, ['zoneId', 'downloadId', 'offset']) && text(p.downloadId) && uint(p.offset)
  if (name === 'zones.dsp.profile.release') return only(p, ['zoneId', 'downloadId']) && text(p.downloadId)
  if (name === 'zones.dsp.library') return only(p, ['zoneId', 'assetOffset', 'pluginOffset', 'revision']) &&
    [p.assetOffset, p.pluginOffset, p.revision].every(v => v === undefined || uint(v))
  if (name === 'zones.dsp.upload.begin') return only(p, ['zoneId', 'kind', 'fileName', 'byteSize']) &&
    validDspUploadFile(p.kind, p.fileName) && uint(p.byteSize) && Number(p.byteSize) > 0 && Number(p.byteSize) <= DSP_UPLOAD_MAX_BYTES
  if (name.startsWith('zones.dsp.upload.')) {
    if (!text(p.uploadId)) return false
    if (name.endsWith('.cancel')) return only(p, ['zoneId', 'uploadId'])
    if (name.endsWith('.commit')) return only(p, ['zoneId', 'uploadId', 'revision']) && uint(p.revision)
    return name.endsWith('.chunk') && only(p, ['zoneId', 'uploadId', 'offset', 'data']) && uint(p.offset) &&
      typeof p.data === 'string' && p.data.length > 0 && p.data.length <= DSP_UPLOAD_CHUNK_BYTES / 3 * 4 &&
      p.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(p.data)
  }
  if (name !== 'zones.dsp.library.edit' || !only(p, ['zoneId', 'revision', 'edit']) || !uint(p.revision) || !object(p.edit)) return false
  const e = p.edit
  switch (e.kind) {
    case 'removeAsset': return only(e, ['kind', 'id']) && asset(e.id)
    case 'createScene': return only(e, ['kind', 'name']) && text(e.name) && String(e.name).length <= 80
    case 'removeScene': return only(e, ['kind', 'sceneId']) && text(e.sceneId)
    case 'applyScene': return only(e, ['kind', 'sceneId', 'confirmDsdPcmFallback']) && text(e.sceneId) && typeof e.confirmDsdPcmFallback === 'boolean'
    case 'bindImpulse': case 'bindCorrection': return only(e, ['kind', 'sceneId', 'assetId']) && text(e.sceneId) && asset(e.assetId)
    case 'addVst3': return only(e, ['kind', 'sceneId', 'catalogId', 'stateAssetId']) && text(e.sceneId) &&
      typeof e.catalogId === 'string' && /^vst3:[a-f0-9]{64}$/.test(e.catalogId) && (e.stateAssetId === null || asset(e.stateAssetId))
    case 'removeNode': return only(e, ['kind', 'sceneId', 'nodeId']) && text(e.sceneId) && text(e.nodeId)
    case 'parameter': return only(e, ['kind', 'sceneId', 'nodeId', 'parameterId', 'value']) && text(e.sceneId) && text(e.nodeId) &&
      uint(e.parameterId) && Number(e.parameterId) <= 0xffffffff && (e.value === null || typeof e.value === 'number' && Number.isFinite(e.value) && e.value >= 0 && e.value <= 1)
    case 'vst3Enabled': return only(e, ['kind', 'enabled']) && typeof e.enabled === 'boolean'
    case 'scan': return only(e, ['kind'])
    case 'clearQuarantine': return only(e, ['kind', 'id']) && typeof e.id === 'string' && /^vst3:[a-f0-9]{64}$/.test(e.id)
    default: return false
  }
}
