import type { DspGraphConfig } from './dspGraph.ts'

export const DSP_AUDITION_VERSION = 1
export const DSP_AUDITION_CEILING_DB = -1
export const DSP_AUDITION_TOLERANCE_LU = 0.1

export interface DspAuditionRequest {
  source: string
  startSeconds: number
  endSeconds: number
  a: DspGraphConfig
  b: DspGraphConfig
}

export interface DspAuditionMeasurement {
  integratedLufs: number
  truePeakDb: number
  processingVersion: number
}

export interface DspAuditionResult {
  id: string
  a: DspAuditionMeasurement
  b: DspAuditionMeasurement
  gainA: number
  gainB: number
  targetLufs: number
  selected: 'a' | 'b' | null
}

export interface DspAuditionApi {
  measure: (request: DspAuditionRequest) => Promise<DspAuditionResult>
  select: (id: string, side: 'a' | 'b') => Promise<DspAuditionResult>
  end: () => Promise<void>
  status: () => Promise<DspAuditionResult | null>
}

export function normalizeAuditionGraph(value: DspGraphConfig): DspGraphConfig {
  if (!value || value.version !== 2 || !Array.isArray(value.nodes) || value.nodes.length > 32)
    throw new Error('试听 DSP 图无效')
  const stage = value.outputStage
  if (
    !stage ||
    stage.targetSampleRate !== 'device' ||
    stage.resamplerQuality !== 'native' ||
    stage.dither !== 'off'
  )
    throw new Error('首版试听不支持重采样或抖动，请使用原采样率 PCM')
  const nodes = value.nodes.filter((node) => node.enabled && node.type !== 'meter')
  if (nodes.length > 1 || nodes.some((node) => node.type !== 'equalizer'))
    throw new Error('首版等响度试听仅支持无处理或一个内置 EQ 节点')
  for (const node of nodes) {
    const params = node.params
    if (
      !params ||
      !['graphic', 'parametric'].includes(String(params.mode)) ||
      !Number.isFinite(params.preampDb) ||
      Number(params.preampDb) < -24 ||
      Number(params.preampDb) > 24 ||
      !Array.isArray(params.bands) ||
      params.bands.length > 32
    )
      throw new Error('试听 EQ 参数无效')
    for (const band of params.bands) {
      if (
        !band ||
        !Number.isFinite(band.frequency) ||
        band.frequency < 10 ||
        band.frequency > 96000 ||
        !Number.isFinite(band.gain) ||
        Math.abs(band.gain) > 24 ||
        !Number.isFinite(band.q) ||
        band.q < 0.1 ||
        band.q > 20 ||
        (band.filterType &&
          ![
            'peak',
            'lowShelf',
            'highShelf',
            'lowPass',
            'highPass',
            'bandPass',
            'allPass',
            'notch'
          ].includes(band.filterType))
      )
        throw new Error('试听 EQ 频段无效')
    }
  }
  return structuredClone({ version: 2, nodes, outputStage: { ...stage, safetyClamp: true } })
}

export function matchAuditionLoudness(a: DspAuditionMeasurement, b: DspAuditionMeasurement) {
  for (const item of [a, b])
    if (
      item.processingVersion !== DSP_AUDITION_VERSION ||
      !Number.isFinite(item.integratedLufs) ||
      !Number.isFinite(item.truePeakDb) ||
      item.integratedLufs < -70
    )
      throw new Error('处理后响度测量不可用；请更新引擎或选择非静音区间')
  const targetLufs = Math.min(
    a.integratedLufs,
    b.integratedLufs,
    a.integratedLufs + DSP_AUDITION_CEILING_DB - a.truePeakDb,
    b.integratedLufs + DSP_AUDITION_CEILING_DB - b.truePeakDb
  )
  return { targetLufs, gainA: targetLufs - a.integratedLufs, gainB: targetLufs - b.integratedLufs }
}

export function compensatedAuditionGraph(graph: DspGraphConfig, gain: number): DspGraphConfig {
  const result = normalizeAuditionGraph(graph)
  if (!result.nodes.length)
    result.nodes.push({
      id: 'audition-gain',
      type: 'equalizer',
      enabled: true,
      params: { mode: 'parametric', preampDb: 0, bands: [] }
    })
  const params = result.nodes[0].params
  const preamp = Number(params.preampDb) + gain
  if (!Number.isFinite(preamp) || preamp < -24 || preamp > 24)
    throw new Error('所需补偿超出 EQ 前级范围，请先减小两套配置的增益差')
  params.preampDb = preamp
  return result
}
