export type AutoMixMode = 'off' | 'natural' | 'dj'
export type AutoMixStemMode = 'off' | 'auto'
export type AutoMixStemDevice = 'auto' | 'gpu' | 'cpu'
export interface AutoMixStemInstallStatus {
  phase:
    | 'idle'
    | 'selecting'
    | 'checking'
    | 'extracting'
    | 'verifying'
    | 'ready'
    | 'cancelled'
    | 'failed'
  completedBytes: number
  totalBytes: number
  fileName?: string
  reason?: 'invalid_archive' | 'invalid_pack' | 'integrity' | 'disk_space' | 'runtime' | 'io'
  capabilities?: { cpu: boolean; gpu: boolean; gpuName?: string }
}
export function autoMixStemInstallBusy(status: AutoMixStemInstallStatus): boolean {
  return ['selecting', 'checking', 'extracting', 'verifying'].includes(status.phase)
}
export interface AutoMixStemCapabilities {
  status: 'missing' | 'ready' | 'unavailable'
  cpu: boolean
  gpu: boolean
  packs: { directory: string; cpu: boolean; gpu: boolean; gpuName?: string }[]
  reason?: 'pack_invalid' | 'runtime_unavailable' | 'probe_timeout'
}
export function normalizeAutoMixStemDevice(value: unknown): AutoMixStemDevice {
  return value === 'gpu' || value === 'cpu' ? value : 'auto'
}
export type AutoMixStemCacheMiB = 0 | 256 | 512 | 1024 | 2048
export function normalizeAutoMixStemCacheMiB(value: unknown): AutoMixStemCacheMiB {
  return value === 0 || value === 256 || value === 1024 || value === 2048 ? value : 512
}
export const TWILIGHT_AUTOMIX_RULE_VERSION = 'twilight-rules-5'
export const TWILIGHT_AUTOMIX_MATERIAL_VERSION = 2
export const TWILIGHT_AUTOMIX_STEM_ARRANGEMENT_VERSION = 'twilight-stem-arrangement-1'
export interface AutoMixSelection {
  ok: boolean
  reason?: string
  selectionId?: number
  currentStartSeconds?: number
  currentEndSeconds?: number
  nextStartSeconds?: number
  nextEndSeconds?: number
  sampleRate?: number
  channels?: number
  overlapSeconds?: number
  outputFrames?: number
  currentRate?: number
  nextRate?: number
  mode?: 'natural' | 'dj'
  nextGain?: number
  strategy?: string
  /** Present only for group-owned native selections; never remote state. */
  sharedPlan?: import('./bridgeAutoMix.ts').BridgeAutoMixPlan
  stemDirectory?: string
  inputs?: {
    path: string
    sha256: string
    sourceIdentity: string
    origin: number
    frames: number
  }[]
}
// Release availability permits opt-in use without asserting listening acceptance.
// Neither availability nor a selected mode passes the delivery acceptance gates.
export const TWILIGHT_AUTOMIX_RELEASE_AVAILABLE = true
export const TWILIGHT_AUTOMIX_RELEASE_READY = false
declare const __TWILIGHT_AUTOMIX_EVALUATION__: boolean
export const TWILIGHT_AUTOMIX_EVALUATION_AVAILABLE =
  typeof __TWILIGHT_AUTOMIX_EVALUATION__ !== 'undefined' && __TWILIGHT_AUTOMIX_EVALUATION__
export const TWILIGHT_AUTOMIX_AVAILABLE =
  TWILIGHT_AUTOMIX_RELEASE_AVAILABLE ||
  TWILIGHT_AUTOMIX_RELEASE_READY ||
  TWILIGHT_AUTOMIX_EVALUATION_AVAILABLE
export const TWILIGHT_AUTOMIX_MODEL_VERSION =
  'twilight-automix-native-1:a01d39a2185f64e2da422fc6251dd93785f8bb90ba91a50087049e42d8b04fec:2f80a111ab1af443c8657406fd543d700b068b938e6638a26f5ec0f6ee5aa1df'
export type AutoMixPhase = 'off' | 'preparing' | 'ready' | 'mixing' | 'degraded'

export function autoMixStatusKeys(
  phase: string,
  reason = '',
  strategy = ''
): { phase: string; reason: string; strategy?: string } {
  const waiting = /^(host_cancelled|.*_changed|manual_skip|seek|stopped|new_preparation)$/.test(
    reason
  )
  const reasonGroup =
    reason === 'retrying'
      ? 'retrying'
      : waiting
        ? 'waiting'
        : reason === 'low_beat_confidence' || reason === 'missing_boundary_beats'
          ? 'beats'
          : reason === 'tempo_outside_mode_limit'
            ? 'tempo'
            : reason === 'no_safe_boundary_candidate'
              ? 'boundary'
              : reason === 'continuous_album_gapless'
                ? 'gapless'
                : /^(manual_transport|cue_pregap|pcm_path)/.test(reason)
                  ? 'transport'
                  : /range|timeline/.test(reason)
                    ? 'range'
                    : /timeout|missed_boundary/.test(reason)
                      ? 'timeout'
                      : /source|identity/.test(reason)
                        ? 'source'
                        : /cache/.test(reason)
                          ? 'cache'
                          : /decode|continuation|decoded/.test(reason)
                            ? 'decode'
                            : /model|asset/.test(reason)
                              ? 'model'
                              : /worker|service/.test(reason)
                                ? 'service'
                                : /memory_budget|short_track|silent_track/.test(reason)
                                  ? 'unsuitable'
                                  : /analysis/.test(reason)
                                    ? 'analysis'
                                    : 'failed'
  return {
    phase: `automix.phase.${['off', 'preparing', 'ready', 'mixing', 'completed', 'degraded'].includes(phase) ? phase : 'degraded'}`,
    reason: reason ? `automix.reason.${reasonGroup}` : '',
    ...(['ready', 'mixing', 'completed'].includes(phase) &&
    ['beat-aligned', 'content-boundary', 'tail-overlap', 'release-boundary'].includes(strategy)
      ? { strategy: `automix.strategy.${strategy}` }
      : {})
  }
}

export interface AutoMixStatus {
  mode: AutoMixMode
  phase: AutoMixPhase
  reason: string
  planId?: string
  overlapSeconds?: number
  confidence?: number
}

export interface AutoMixFeatures {
  ok: true
  algorithm: 'Twilight AutoMix'
  modelVersion: string
  sourceIdentity: string
  coverage: {
    startSeconds: number
    endSeconds: number
    durationSeconds: number
    complete: boolean
  }
  bpm: number
  tempoConfidence: number
  rmsDb: number
  peak: number
  key: number
  keyConfidence: number
  beats: number[]
  downbeats: number[]
  voice: {
    startSeconds: number
    endSeconds: number
    probability: number
    music: number
  }[]
  frameDb: number[]
  framePeak: number[]
  frameOnset?: number[]
  frameLowDb?: number[]
}

export interface AutoMixAnalysisFailure {
  ok: false
  algorithm: 'Twilight AutoMix'
  reason: string
  error?: string
}
export type AutoMixAnalysisResult = AutoMixFeatures | AutoMixAnalysisFailure

export function normalizeAutoMixStemMode(value: unknown): AutoMixStemMode {
  return value === 'off' ? 'off' : 'auto'
}
export function normalizeAutoMixMode(value: unknown): AutoMixMode {
  return value === 'natural' || value === 'dj' ? value : 'off'
}

export function effectiveAutoMixMode(value: unknown): AutoMixMode {
  return TWILIGHT_AUTOMIX_AVAILABLE ? normalizeAutoMixMode(value) : 'off'
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const array = (value: unknown, max: number, test: (v: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && value.length <= max && value.every(test)

export function isAutoMixAnalysisResult(value: unknown): value is AutoMixAnalysisResult {
  if (!object(value) || value.algorithm !== 'Twilight AutoMix') return false
  if (value.ok === false) {
    return (
      typeof value.reason === 'string' &&
      /^[a-z_]{1,80}$/.test(value.reason) &&
      (value.error === undefined || (typeof value.error === 'string' && value.error.length <= 4096))
    )
  }
  if (
    value.ok !== true ||
    typeof value.modelVersion !== 'string' ||
    !/^twilight-automix-native-1:[a-f0-9]{64}:[a-f0-9]{64}$/.test(value.modelVersion) ||
    typeof value.sourceIdentity !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sourceIdentity) ||
    !object(value.coverage)
  )
    return false
  const c = value.coverage
  if (
    !number(c.startSeconds, 0, 604800) ||
    !number(c.endSeconds, 0, 604800) ||
    !number(c.durationSeconds, 0.001, 604800) ||
    c.startSeconds >= c.endSeconds ||
    c.endSeconds > c.durationSeconds + 0.0001 ||
    c.endSeconds - c.startSeconds > 30.001 ||
    typeof c.complete !== 'boolean' ||
    (c.complete && (c.startSeconds !== 0 || Math.abs(c.endSeconds - c.durationSeconds) > 0.0001))
  )
    return false
  if (
    !number(value.bpm, 0, 300) ||
    !number(value.tempoConfidence, 0, 1) ||
    !number(value.rmsDb, -160, 60) ||
    !number(value.peak, 0, 1000) ||
    !number(value.key, -1, 23) ||
    !Number.isInteger(value.key) ||
    !number(value.keyConfidence, 0, 1)
  )
    return false
  const events = (v: unknown) => {
    if (!array(v, 1500, (t) => number(t, c.startSeconds as number, c.endSeconds as number)))
      return false
    return v.every((t, i) => i === 0 || (t as number) > (v[i - 1] as number))
  }
  if (!events(value.beats) || !events(value.downbeats)) return false
  if (
    !array(value.frameDb, 1500, (v) => number(v, -160, 60)) ||
    !array(value.framePeak, 1500, (v) => number(v, 0, 1000)) ||
    value.frameDb.length !== value.framePeak.length ||
    !value.frameDb.length ||
    Math.abs(value.frameDb.length - (c.endSeconds - c.startSeconds) * 50) > 1.001
  )
    return false
  for (const field of ['frameOnset', 'frameLowDb'] as const) {
    const values = value[field]
    if (
      values !== undefined &&
      (!array(values, 1500, (v) =>
        number(v, field === 'frameOnset' ? 0 : -160, field === 'frameOnset' ? 1000 : 60)
      ) ||
        values.length !== value.frameDb.length)
    )
      return false
  }
  if (
    !array(value.voice, 64, (v) => {
      if (!object(v)) return false
      return (
        number(v.startSeconds, c.startSeconds as number, c.endSeconds as number) &&
        number(v.endSeconds, c.startSeconds as number, (c.endSeconds as number) + 0.0001) &&
        v.startSeconds < v.endSeconds &&
        number(v.probability, 0, 1) &&
        number(v.music, 0, 1)
      )
    })
  )
    return false
  return value.voice.every(
    (v, i) =>
      i === 0 ||
      (v as Record<string, number>).startSeconds >
        (value.voice as Record<string, number>[])[i - 1].startSeconds
  )
}
