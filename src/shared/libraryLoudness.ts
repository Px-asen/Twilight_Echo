import type { LoudnessAnalysisResult } from './audioEngineTypes.ts'
import { normalizeCueRange, type CueRange } from './cue.ts'

export const LIBRARY_LOUDNESS_ALGORITHM_VERSION = 2
export const MAX_LOUDNESS_BATCH_TRACKS = 10_000
export const MAX_LOUDNESS_ALBUM_TRACKS = 256
export const REPLAYGAIN2_REFERENCE_LUFS = -18
export const R128_REFERENCE_LUFS = -23

export interface LoudnessInputTrack {
  id: string
  filePath: string
  title?: string
  cueRange?: CueRange
  subTrack?: string
}

export interface LoudnessInputGroup {
  id: string
  title: string
  mode: 'track' | 'album'
  tracks: LoudnessInputTrack[]
}

export interface LoudnessGroupMeasurement {
  tracks: LoudnessAnalysisResult[]
  album: LoudnessAnalysisResult | null
}

export interface LibraryLoudnessResult {
  id: string
  status: 'measured' | 'missing' | 'unavailable'
  measurement?: LoudnessAnalysisResult
  tracks?: LoudnessAnalysisResult[]
  reason?: string
}

export type LoudnessBatchItemState =
  | 'queued'
  | 'analyzing'
  | 'completed'
  | 'cached'
  | 'failed'
  | 'cancelled'

export interface LoudnessBatchItem {
  id: string
  title: string
  trackCount: number
  state: LoudnessBatchItemState
  reason?: string
}

export interface LoudnessBatchStatus {
  revision: number
  jobId: string | null
  state: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled'
  total: number
  processed: number
  failed: number
  currentTitle: string
}

export interface LoudnessBatchProgress {
  status: LoudnessBatchStatus
  item?: LoudnessBatchItem
}

export interface LoudnessBatchSnapshot {
  status: LoudnessBatchStatus
  items: LoudnessBatchItem[]
}

export interface LibraryLoudnessApi {
  startBatch: (groups: LoudnessInputGroup[]) => Promise<LoudnessBatchSnapshot>
  cancelBatch: (jobId: string) => Promise<void>
  getBatch: () => Promise<LoudnessBatchSnapshot>
  getResults: (groups: LoudnessInputGroup[]) => Promise<LibraryLoudnessResult[]>
  clearResults: (ids: string[]) => Promise<void>
  onBatchProgress: (callback: (event: LoudnessBatchProgress) => void) => () => void
}

export function isLoudnessMeasurement(value: unknown): value is LoudnessAnalysisResult {
  if (!value || typeof value !== 'object') return false
  const result = value as LoudnessAnalysisResult
  return (
    result.source === 'analyzed' &&
    result.available === true &&
    result.algorithmVersion === LIBRARY_LOUDNESS_ALGORITHM_VERSION &&
    Number.isFinite(result.integratedLufs) &&
    Number.isFinite(result.truePeakDb) &&
    typeof result.analyzedAt === 'string' &&
    Number.isFinite(Date.parse(result.analyzedAt))
  )
}

export function isLoudnessGroupMeasurement(value: unknown): value is LoudnessGroupMeasurement {
  if (!value || typeof value !== 'object') return false
  const result = value as LoudnessGroupMeasurement
  return (
    Array.isArray(result.tracks) &&
    result.tracks.length > 0 &&
    result.tracks.length <= MAX_LOUDNESS_ALBUM_TRACKS &&
    result.tracks.every(isLoudnessMeasurement) &&
    (result.album === null || isLoudnessMeasurement(result.album))
  )
}

export function normalizeLoudnessGroups(value: unknown): LoudnessInputGroup[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_LOUDNESS_BATCH_TRACKS)
    throw new Error('请选择 1–10,000 首本地歌曲')
  const groupIds = new Set<string>()
  let total = 0
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('响度分析分组无效')
    const id = boundedText(raw.id, 8192)
    const title = boundedText(raw.title, 1024)
    if (groupIds.has(id) || !['track', 'album'].includes(raw.mode))
      throw new Error('响度分析分组重复或模式无效')
    groupIds.add(id)
    if (
      !Array.isArray(raw.tracks) ||
      !raw.tracks.length ||
      raw.tracks.length > MAX_LOUDNESS_ALBUM_TRACKS ||
      (raw.mode === 'track' && raw.tracks.length !== 1)
    )
      throw new Error('单张专辑最多分析 256 首，曲目模式每组须为一首')
    total += raw.tracks.length
    if (total > MAX_LOUDNESS_BATCH_TRACKS) throw new Error('单次最多分析 10,000 首')
    const trackIds = new Set<string>()
    const tracks = raw.tracks.map((track: LoudnessInputTrack) => {
      if (!track || typeof track !== 'object') throw new Error('响度分析曲目无效')
      const trackId = boundedText(track.id, 8192)
      if (trackIds.has(trackId)) throw new Error('专辑包含重复曲目')
      trackIds.add(trackId)
      const cueRange = track.cueRange === undefined ? undefined : normalizeCueRange(track.cueRange)
      if (cueRange === null) throw new Error('CUE 测量区间无效')
      return {
        id: trackId,
        filePath: boundedText(track.filePath, 4096),
        ...(track.title ? { title: boundedText(track.title, 1024) } : {}),
        ...(track.subTrack ? { subTrack: boundedText(track.subTrack, 512) } : {}),
        ...(cueRange ? { cueRange } : {})
      }
    })
    return { id, title, mode: raw.mode, tracks }
  })
}

export function loudnessGainValues(measurement: LoudnessAnalysisResult) {
  return {
    replayGain2Db: REPLAYGAIN2_REFERENCE_LUFS - measurement.integratedLufs,
    r128Db: R128_REFERENCE_LUFS - measurement.integratedLufs,
    r128Q78: Math.round((R128_REFERENCE_LUFS - measurement.integratedLufs) * 256),
    peakLinear: 10 ** (measurement.truePeakDb / 20)
  }
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value))
    throw new Error('响度分析标识或路径无效')
  return value.trim()
}

export function idleLoudnessBatchStatus(): LoudnessBatchStatus {
  return {
    revision: 0,
    jobId: null,
    state: 'idle',
    total: 0,
    processed: 0,
    failed: 0,
    currentTitle: ''
  }
}
