import { normalizeDspGraph, type DspGraphNode } from './dspGraph.ts'

export interface PortableDspSettings {
  enabled: boolean
  eqMode: 'graphic' | 'parametric'
  parametricBands: Array<{
    frequency: number; gain: number; q: number; filterType: string; enabled: boolean; channelMask: number
  }>
  nodes: DspGraphNode[]
  outputStage: {
    targetSampleRate: number; resamplerQuality: string; resamplerPhase: string; dither: string
    headroomEnabled: boolean; headroomGainDb: number; safetyClamp: boolean
  }
  crossfadeSeconds: number
  crossfadeCurve: string
  crossfadeContent: string
  outputDeviceId: string
  exclusive: boolean
  bufferFrames: number
  continuitySampleRate: number
  playbackRate: number
  usbPcmPassthrough: boolean
  sampleRateFamilySync: boolean
  allowedSampleRates: number[]
}

export interface PortableDspScene { id: string; name: string; config: Record<string, unknown> }

export function defaultPortableDspSettings(): PortableDspSettings {
  return {
    enabled: true, eqMode: 'graphic',
    parametricBands: [{ frequency: 1000, gain: 0, q: 1, filterType: 'peak', enabled: true, channelMask: 0xffffffff }],
    nodes: [], outputStage: { targetSampleRate: 0, resamplerQuality: 'native', resamplerPhase: 'linear',
      dither: 'off', headroomEnabled: false, headroomGainDb: -3, safetyClamp: true },
    crossfadeSeconds: 0, crossfadeCurve: 'equal-power', crossfadeContent: 'conservative',
    outputDeviceId: 'auto', exclusive: false, bufferFrames: 0, continuitySampleRate: 48000, playbackRate: 1,
    usbPcmPassthrough: false, sampleRateFamilySync: false, allowedSampleRates: []
  }
}

const mobileNodeTypes = new Set(['replayGain', 'dynamicEqualizer', 'convolver', 'crossfeed', 'channelMatrix',
  'channelStrip', 'bassManagement', 'gate', 'compressor', 'multibandCompressor', 'stereoField',
  'loudnessContour', 'truePeakLimiter', 'meter'])
const finite = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max

/** Reuses the desktop graph/output normalization; no DSP algorithm lives in the bridge. */
export function normalizePortableDspSettings(value: unknown): PortableDspSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid DSP settings')
  const v = { ...defaultPortableDspSettings(), ...value } as PortableDspSettings
  if (typeof v.usbPcmPassthrough !== 'boolean' || typeof v.sampleRateFamilySync !== 'boolean' || !Array.isArray(v.allowedSampleRates) ||
    v.allowedSampleRates.length > 32 || v.allowedSampleRates.some(rate => !Number.isInteger(rate) || !finite(rate, 8000, 768000)) ||
    new Set(v.allowedSampleRates).size !== v.allowedSampleRates.length)
    throw new Error('Invalid PCM sample-rate settings')
  if (!Array.isArray(v.nodes) || v.nodes.length > 14 || v.nodes.some(n =>
    !n || !mobileNodeTypes.has(n.type) || typeof n.id !== 'string' || !n.id || n.id === 'phone-eq') ||
    new Set(v.nodes.map(n => n.id)).size !== v.nodes.length ||
    new Set(v.nodes.map(n => n.type)).size !== v.nodes.length) throw new Error('Invalid or duplicate DSP node')
  if (!Array.isArray(v.parametricBands) || v.parametricBands.length > 32 || v.parametricBands.some(b =>
    !b || !finite(b.frequency, 10, 96000) || !finite(b.gain, -24, 24) || !finite(b.q, 0.1, 30) ||
    !['peak', 'lowShelf', 'highShelf', 'lowPass', 'highPass', 'bandPass', 'allPass', 'notch'].includes(b.filterType) ||
    typeof b.enabled !== 'boolean' || !Number.isInteger(b.channelMask) || !finite(b.channelMask, 0, 0xffffffff)))
    throw new Error('Invalid parametric EQ band')
  if (!finite(v.crossfadeSeconds, 0, 12) || !finite(v.playbackRate, 0.5, 2) ||
    !Number.isInteger(v.bufferFrames) || !finite(v.bufferFrames, 0, 32768) ||
    ![44100, 48000, 96000].includes(v.continuitySampleRate) ||
    !['linear', 'equal-power'].includes(v.crossfadeCurve) ||
    !['conservative', 'all', 'live'].includes(v.crossfadeContent) ||
    !['graphic', 'parametric'].includes(v.eqMode) || typeof v.enabled !== 'boolean' ||
    typeof v.exclusive !== 'boolean' || !/^(auto|[1-9][0-9]*)$/.test(v.outputDeviceId))
    throw new Error('Invalid audio output settings')
  const graph = normalizeDspGraph({ nodes: v.nodes, outputStage: {
    ...v.outputStage, targetSampleRate: v.outputStage?.targetSampleRate || 'device'
  } })
  if (v.sampleRateFamilySync && typeof graph.outputStage.targetSampleRate === 'number')
    throw new Error('Family sync cannot use a fixed sample rate')
  return { ...v, allowedSampleRates: [...v.allowedSampleRates].sort((a, b) => a - b), nodes: graph.nodes, outputStage: {
    targetSampleRate: typeof graph.outputStage.targetSampleRate === 'number' ? graph.outputStage.targetSampleRate : 0,
    resamplerQuality: graph.outputStage.resamplerQuality, resamplerPhase: graph.outputStage.resamplerPhase ?? 'linear',
    dither: graph.outputStage.dither, headroomEnabled: graph.outputStage.headroomEnabled ?? false,
    headroomGainDb: graph.outputStage.headroomGainDb ?? -3, safetyClamp: graph.outputStage.safetyClamp
  } }
}
