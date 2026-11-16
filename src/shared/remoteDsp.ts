import type { CoreDspState } from './coreDsp.ts'
import type { DspGraphStatus } from './dspGraph.ts'
import type { CorePlaybackView } from './coreViews.ts'
import type { BridgeReceiverFacts, BridgeRuntimeState } from './audioBridge.ts'
import type { BridgeClockStatus } from './audioBridgeClock.ts'

const PROCESSING = ['dspEnabled', 'directMode', 'eqEnabled', 'eqMode', 'eqPreamp', 'eqBands',
  'crossfeedEnabled', 'crossfeedStrength', 'convolverEnabled'] as const
export interface RemoteDspState {
  revision: number
  processing: Pick<CoreDspState['processing'], typeof PROCESSING[number]>
  scenes: { id: string; name: string; enabled: boolean }[]
  activeSceneId: string | null
  pinnedSceneId: string | null
}
export function projectRemoteDsp(state: CoreDspState): RemoteDspState {
  return { revision: state.revision,
    processing: Object.fromEntries(PROCESSING.map(k => [k, state.processing[k]])) as RemoteDspState['processing'],
    scenes: state.scenes.scenes.map(({ id, name, enabled }) => ({ id, name, enabled })),
    activeSceneId: state.scenes.activeSceneId, pinnedSceneId: state.scenes.pinnedSceneId }
}
/** No paths, plugin states, assets or arbitrary scene graphs enter the remote boundary. */
export function validRemoteDspEdit(payload: Record<string, unknown>): boolean {
  const edit = payload.edit as Record<string, unknown> | undefined
  if (!edit || typeof edit !== 'object') return false
  if (edit.kind === 'apply') return edit.id === null || typeof edit.id === 'string'
  if (edit.kind !== 'processing' || !edit.settings || typeof edit.settings !== 'object' || Array.isArray(edit.settings)) return false
  return Object.entries(edit.settings).every(([key, v]) => {
    if (!PROCESSING.includes(key as typeof PROCESSING[number])) return false
    if (key.endsWith('Enabled') || key === 'directMode') return typeof v === 'boolean'
    if (key === 'eqMode') return v === 'graphic' || v === 'parametric'
    if (key === 'eqPreamp') return typeof v === 'number' && v >= -24 && v <= 12
    if (key === 'crossfeedStrength') return typeof v === 'number' && v >= 0 && v <= 1
    return key === 'eqBands' && Array.isArray(v) && v.length <= 64 && v.every(b => b &&
      typeof b === 'object' && Object.keys(b).every(k => ['frequency', 'gain', 'q', 'filterType', 'enabled', 'channelMask'].includes(k)) &&
      Number.isFinite(b.frequency) && b.frequency >= 10 && b.frequency <= 96000 &&
      Number.isFinite(b.gain) && b.gain >= -24 && b.gain <= 24 &&
      Number.isFinite(b.q) && b.q >= 0.05 && b.q <= 40 &&
      ['peak', 'lowShelf', 'highShelf', 'bandPass', 'lowPass', 'highPass', 'allPass', 'notch'].includes(b.filterType) &&
      (b.enabled === undefined || typeof b.enabled === 'boolean') &&
      (b.channelMask === undefined || (Number.isInteger(b.channelMask) && b.channelMask >= 0 && b.channelMask <= 255)))
  })
}
export function projectRemoteDspStatus(graph: DspGraphStatus) {
  return { revision: graph.revision, requestedRevision: graph.requestedRevision, appliedRevision: graph.appliedRevision,
    applyState: graph.applyState, activeSceneId: graph.activeSceneId, compileState: graph.compileState,
    totalLatencyFrames: graph.totalLatencyFrames, latencySampleRate: graph.latencySampleRate, totalTailFrames: graph.totalTailFrames,
    nodes: graph.nodes.map(({ id, type, enabled, active, bypassed, latencyFrames, format }) =>
      ({ id, type, enabled, active, bypassed, latencyFrames, format })),
    outputStage: graph.outputStage ? { actualSampleRate: graph.outputStage.actualSampleRate,
      effectiveResampler: graph.outputStage.effectiveResampler, resampled: graph.outputStage.resampled,
      headroomGainDb: graph.outputStage.headroomGainDb, active: graph.outputStage.active } : null }
}
export interface CoreSignalPath {
  zoneId: string
  source: { sampleRate: number; bitDepth: number; channels: number; codec: string; isDsd?: boolean }
  decoded: {
    sampleRate: number
    bitDepth: number
    channels: number
    format: string
    dsdMode?: CorePlaybackView['dsdMode']
    dsdRate?: number
  }
  dsp: ReturnType<typeof projectRemoteDspStatus>
  transport: { kind: 'local' | 'tls-pcm' | 'tls-dsd'; sampleRate: number; channels: number; format: string; connected: boolean }
  receiver: BridgeReceiverFacts | null
  timing?: BridgeClockStatus | null
  output: {
    backend: string
    sampleRate: number
    bitDepth: number
    channels: number
    deviceName: string | null
    dsdMode?: CorePlaybackView['dsdMode']
    dsdRate?: number
  }
  hardware: null
}
export function buildSignalPath(playback: CorePlaybackView | null, graph: DspGraphStatus, zone: BridgeRuntimeState | null): CoreSignalPath {
  const remote = zone?.selected === true, facts = remote ? zone.receiver : null
  const codec = playback?.codec ?? ''
  const sourceBits = playback?.sourceBitDepth ?? 0
  const isDsd = playback?.isDsd === true || sourceBits === 1 || /^ds(?:d|f|diff)$/i.test(codec.trim())
  const remoteDsdMode: CorePlaybackView['dsdMode'] | undefined = facts?.wireFormat === 'dop-int24-le'
    ? 'dop'
    : facts?.wireFormat?.startsWith('dsd-')
      ? 'native'
      : isDsd
        ? 'pcm'
        : undefined
  const outputDsdMode = remote ? remoteDsdMode : playback?.dsdMode
  const outputDsdRate = remote
    ? remoteDsdMode === 'dop'
      ? (facts?.actualSampleRate ?? 0) * 16
      : remoteDsdMode === 'native'
        ? (facts?.sampleRate ?? 0)
        : 0
    : (playback?.actualDsdRate || playback?.dsdRate || 0)
  return { zoneId: 'local', source: { sampleRate: playback?.sourceSampleRate ?? 0, bitDepth: sourceBits,
    channels: playback?.sourceChannels ?? 0, codec, isDsd },
    decoded: { sampleRate: playback?.decodedSampleRate ?? 0, bitDepth: playback?.decodedBitDepth ?? 0,
      channels: playback?.decodedChannels ?? 0, format: playback?.decodedSampleFormat ?? '',
      dsdMode: playback?.dsdMode, dsdRate: playback?.dsdRate ?? 0 },
    dsp: projectRemoteDspStatus(graph),
    transport: { kind: remote ? facts?.wireFormat && facts.wireFormat !== 'float32-le' ? 'tls-dsd' : 'tls-pcm' : 'local', sampleRate: facts?.sampleRate ?? playback?.actualSampleRate ?? 0,
      channels: facts?.channels ?? playback?.actualChannels ?? 0, format: remote ? facts?.wireFormat ?? 'float32-le' : '', connected: !remote || zone.connected },
    receiver: facts, timing: remote ? zone.timing ?? null : null,
    output: { backend: remote ? facts?.backend ?? '' : playback?.outputBackend ?? '',
      sampleRate: remote ? facts?.actualSampleRate ?? 0 : playback?.actualSampleRate ?? 0,
      bitDepth: remote ? facts?.actualBitDepth ?? 0 : playback?.actualBitDepth ?? 0,
      channels: remote ? facts?.actualChannels ?? 0 : playback?.actualChannels ?? 0, deviceName: facts?.deviceName ?? null,
      dsdMode: outputDsdMode, dsdRate: outputDsdRate },
    hardware: null }
}
