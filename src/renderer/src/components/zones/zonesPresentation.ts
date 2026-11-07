import type { ZoneView } from '../../../../shared/coreZones.ts'
import type { SyncGroupEngineState, SyncGroupView } from '../../../../shared/coreSyncGroups.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import type { BridgeReceiverFacts } from '../../../../shared/audioBridge.ts'
import { bridgeFrameRate, readBridgeAudioFormat } from '../../../../shared/audioBridge.ts'
import type { DspNodeType } from '../../../../shared/dspGraph.ts'
import { nodeLabel } from '../../utils/dspNodeParams.ts'
import {
  bridgeAdaptiveObservation,
  bridgeClockObservation
} from '../../utils/bridgeClockPresentation.ts'

/** How a zone's window is lit: the cover is the light, its state the switch. */
export type ZoneLight = 'playing' | 'paused' | 'offline' | 'unpaired' | 'empty'
export type ZoneTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export const isBridgeZone = (zone: Pick<ZoneView, 'id'>): boolean => zone.id !== 'local'

/** A bridge zone never falls back to local speakers, so "not connected" is a real, dark state. */
export function zoneOutputDown(zone: ZoneView): boolean {
  const output = zone.output
  if (isBridgeZone(zone)) return !output?.connected
  return Boolean(output?.selected && !output.connected)
}

export function zoneLight(zone: ZoneView): ZoneLight {
  if (zoneOutputDown(zone)) return zone.output?.peerName ? 'offline' : 'unpaired'
  if (!zone.queue || !zone.track) return 'empty'
  return zone.playback?.state === 'playing' ? 'playing' : 'paused'
}

/** Members share the group's music; only their own output can switch a window off. */
export function memberLight(zone: ZoneView, group: SyncGroupView): ZoneLight {
  if (zoneOutputDown(zone)) return zone.output?.peerName ? 'offline' : 'unpaired'
  if (!group.queue || !group.track) return 'empty'
  return group.playback?.state === 'playing' ? 'playing' : 'paused'
}

export function playbackStateLabel(state: string | null | undefined): string {
  if (state === 'playing') return '播放中'
  if (state === 'paused') return '已暂停'
  return '已停止'
}

export function zoneStatus(zone: ZoneView): { label: string; tone: ZoneTone } {
  const light = zoneLight(zone)
  if (zone.error) return { label: '需要处理', tone: 'danger' }
  if (light === 'offline') return { label: '输出桥离线', tone: 'danger' }
  if (light === 'unpaired') return { label: '待配对', tone: 'neutral' }
  if (light === 'empty') return { label: '队列为空', tone: 'neutral' }
  if (light === 'playing') return { label: '播放中', tone: 'success' }
  return { label: playbackStateLabel(zone.playback?.state), tone: 'neutral' }
}

export function zoneOutputLabel(zone: ZoneView): string {
  const output = zone.output
  if (!isBridgeZone(zone)) {
    return output?.selected ? `输出桥 · ${output.peerName ?? '未命名设备'}` : '本机输出'
  }
  if (!output?.peerName) return '未配对输出桥'
  const device = output.connected ? output.receiver?.deviceName : null
  return device ? `${output.peerName} · ${device}` : output.peerName
}

const BACKEND_LABELS: Record<string, string> = {
  wasapi: 'WASAPI 共享',
  'wasapi-shared': 'WASAPI 共享',
  'wasapi-exclusive': 'WASAPI 独占',
  asio: 'ASIO',
  coreaudio: 'CoreAudio',
  'coreaudio-exclusive': 'CoreAudio 独占',
  alsa: 'ALSA',
  'sync-group': '同步组'
}

export function backendLabel(backend: string | null | undefined, exclusive?: boolean): string {
  if (!backend) return ''
  if (backend === 'wasapi' && exclusive) return BACKEND_LABELS['wasapi-exclusive']
  return BACKEND_LABELS[backend] ?? backend
}

export function formatRate(rate: number | null | undefined): string {
  if (!rate || !Number.isFinite(rate)) return ''
  const khz = rate / 1000
  return `${Number.isInteger(khz) ? khz : Number(khz.toFixed(1))} kHz`
}

export function formatAudio(rate?: number | null, bits?: number | null): string {
  const value = formatRate(rate)
  if (!value) return ''
  return bits ? `${value} / ${bits} bit` : value
}

export function codecLabel(codec: string | null | undefined): string {
  return (codec ?? '').trim().toUpperCase()
}

function receiverOf(zone: ZoneView): BridgeReceiverFacts | null {
  return zone.output?.selected && zone.output.connected ? zone.output.receiver : null
}

/** "FLAC · 96 kHz / 24 bit → WASAPI 独占 · 48 kHz / 24 bit" — only facts Core reported. */
export function zoneFormatLine(zone: ZoneView): string {
  const playback = zone.playback
  const track = zone.track
  const codec = codecLabel(playback?.codec || track?.format)
  const source = [
    codec,
    formatAudio(
      playback?.sourceSampleRate || track?.sampleRate,
      playback?.sourceBitDepth || track?.bitDepth
    )
  ]
    .filter(Boolean)
    .join(' · ')
  const receiver = receiverOf(zone)
  const output = receiver
    ? [
        backendLabel(receiver.backend, receiver.exclusive),
        formatAudio(receiver.actualSampleRate, receiver.actualBitDepth)
      ]
    : [
        backendLabel(playback?.outputBackend),
        formatAudio(playback?.actualSampleRate, playback?.actualBitDepth)
      ]
  const sink = output.filter(Boolean).join(' · ')
  if (source && sink) return `${source} → ${sink}`
  return source || sink
}

export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function trackArtists(track: ZoneView['track']): string {
  if (!track) return ''
  return [track.artist, track.album].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------
// Signal path

export type PathTone = 'exact' | 'adapted' | 'enhanced' | 'fault' | 'idle'
export interface PathNode {
  id: string
  label: string
  value: string
  tone: PathTone
  detail: string[]
  icon: string
}
export interface PathStage {
  id: 'core' | 'network' | 'bridge'
  label: string
  nodes: PathNode[]
}

export const PATH_TONE_LABEL: Record<PathTone, string> = {
  exact: '原样',
  adapted: '已转换',
  enhanced: '已处理',
  fault: '异常',
  idle: '待机'
}

function decodedLabel(format: string): string {
  if (!format) return ''
  if (/^f(?:loat)?32/i.test(format)) return '32 位浮点'
  if (/^f(?:loat)?64/i.test(format)) return '64 位浮点'
  const bits = format.match(/(\d{2})/)?.[1]
  return bits ? `${bits} 位整数` : format
}

export function signalPathStages(
  path: CoreSignalPath,
  options: { peerName?: string | null } = {}
): PathStage[] {
  const playing = path.source.sampleRate > 0
  const remote = path.transport.kind !== 'local'
  const codec = codecLabel(path.source.codec)
  const source: PathNode = {
    id: 'source',
    label: '音源',
    icon: 'ph-file-audio',
    value: playing
      ? [codec, formatAudio(path.source.sampleRate, path.source.bitDepth)].filter(Boolean).join(' · ')
      : '尚未播放',
    tone: playing ? 'exact' : 'idle',
    detail: playing
      ? [`${path.source.channels || 2} 声道`, codec ? `${codec} 文件` : '音频文件']
      : ['开始播放后显示实际格式']
  }
  const decodedChanged =
    playing && path.decoded.sampleRate > 0 && path.decoded.sampleRate !== path.source.sampleRate
  const decode: PathNode = {
    id: 'decode',
    label: '解码',
    icon: 'ph-wave-sine',
    value: playing
      ? [decodedLabel(path.decoded.format), formatRate(path.decoded.sampleRate)]
          .filter(Boolean)
          .join(' · ') || '已解码'
      : '待机',
    tone: !playing ? 'idle' : decodedChanged ? 'adapted' : 'exact',
    detail: playing
      ? [
          decodedChanged ? '解码时改变了采样率' : '采样率与音源一致',
          path.decoded.format ? `样本格式 ${path.decoded.format}` : '样本格式未报告'
        ]
      : []
  }
  const active = path.dsp.nodes.filter((node) => node.active && !node.bypassed)
  const dspTone: PathTone =
    path.dsp.applyState === 'failed'
      ? 'fault'
      : !playing
        ? 'idle'
        : active.length
          ? 'enhanced'
          : 'exact'
  const dsp: PathNode = {
    id: 'dsp',
    label: 'DSP',
    icon: 'ph-faders',
    value:
      path.dsp.applyState === 'failed'
        ? '应用失败'
        : path.dsp.applyState === 'pending'
          ? '正在应用'
          : active.length
            ? active.length === 1
              ? nodeLabel(active[0].type as DspNodeType)
              : `${active.length} 个处理节点`
            : '未处理',
    tone: dspTone,
    detail: active.length
      ? active.map((node) => nodeLabel(node.type as DspNodeType))
      : ['没有正在运行的处理节点，声音不被改变']
  }
  const stage = path.dsp.outputStage
  const src: PathNode = {
    id: 'src',
    label: '采样率转换',
    icon: 'ph-arrows-left-right',
    value: stage?.resampled ? `转换至 ${formatRate(stage.actualSampleRate)}` : '保持原采样率',
    tone: !playing ? 'idle' : stage?.resampled ? 'adapted' : 'exact',
    detail: stage?.resampled
      ? [stage.effectiveResampler ? `重采样器 ${stage.effectiveResampler}` : '由 Core 重采样']
      : ['Core 未重采样']
  }
  const stages: PathStage[] = [
    { id: 'core', label: '此电脑', nodes: [source, decode, dsp, src] }
  ]
  const receiver = path.receiver
  const device: PathNode = {
    id: 'device',
    label: '输出设备',
    icon: 'ph-speaker-hifi',
    value:
      [
        path.output.deviceName ||
          backendLabel(path.output.backend, receiver?.exclusive) ||
          (remote ? '输出桥设备' : '系统默认设备'),
        formatAudio(path.output.sampleRate, path.output.bitDepth)
      ]
        .filter(Boolean)
        .join(' · ') || '未报告',
    tone:
      remote && !path.transport.connected
        ? 'fault'
        : !playing
          ? 'idle'
          : path.output.sampleRate && path.output.sampleRate !== path.source.sampleRate
            ? 'adapted'
            : 'exact',
    detail: [
      backendLabel(path.output.backend, receiver?.exclusive) || '驱动未报告',
      ...(path.output.channels > 2 ? [`${path.output.channels} 声道${receiver?.actualChannelMask === 0 ? ' · 驱动未报告扬声器布局，按配置顺序对应输出通道' : ''}`] : []),
      '驱动回报的格式；DAC 内部处理未知'
    ]
  }
  if (!remote) {
    stages[0].nodes.push(device)
    return stages
  }
  stages.push({
    id: 'network',
    label: '网络传输',
    nodes: [
      {
        id: 'transport',
        label: '加密传输',
        icon: 'ph-lock-simple',
        value: path.transport.connected
          ? `${path.transport.format === 'dop-int24-le' ? 'DoP' : path.transport.format.startsWith('dsd-') ? '原生 DSD' : 'Float32 PCM'} · ${formatRate(path.transport.sampleRate)}`
          : '未连接',
        tone: path.transport.connected ? (playing ? 'exact' : 'idle') : 'fault',
        detail: path.transport.connected
          ? [`TLS 加密 · ${path.transport.channels} 声道 · ${path.transport.format}`, '输出桥不重复应用 Core 的 DSP']
          : ['输出桥未连接，不会切回本机输出']
      }
    ]
  })
  const bridgeNodes: PathNode[] = []
  if (receiver?.adaptive) {
    bridgeNodes.push({
      id: 'clock',
      label: '时钟适配',
      icon: 'ph-metronome',
      value: `修正 ${receiver.adaptive.effectivePpm >= 0 ? '+' : ''}${receiver.adaptive.effectivePpm.toFixed(1)} ppm`,
      tone: 'adapted',
      detail: bridgeAdaptiveObservation(receiver)
    })
  }
  if (receiver) {
    const ms = receiver.sampleRate ? Math.round((receiver.bufferedFrames * 1000) / bridgeFrameRate(readBridgeAudioFormat(receiver))) : 0
    bridgeNodes.push({
      id: 'buffer',
      label: '缓冲',
      icon: 'ph-hourglass-medium',
      value: `${ms} ms${receiver.underruns ? ` · 欠载 ${receiver.underruns}` : ''}`,
      tone: receiver.failed ? 'fault' : receiver.underruns ? 'enhanced' : playing ? 'exact' : 'idle',
      detail: [
        `已出队 ${receiver.consumedFrames.toLocaleString('zh-CN')} 帧`,
        ...bridgeClockObservation(path.timing)
      ]
    })
  }
  bridgeNodes.push(device)
  stages.push({
    id: 'bridge',
    label: `${options.peerName || '输出桥'} · 输出桥`,
    nodes: bridgeNodes
  })
  return stages
}

/** The node worth reading first: the first one that changes the sound, else the device. */
export function signalPathFocus(stages: PathStage[]): string {
  const nodes = stages.flatMap((stage) => stage.nodes)
  return (
    nodes.find((node) => node.tone === 'fault')?.id ??
    nodes.find((node) => node.tone === 'enhanced' || node.tone === 'adapted')?.id ??
    nodes.at(-1)?.id ??
    'source'
  )
}

export function signalPathVerdict(stages: PathStage[]): { label: string; tone: ZoneTone } {
  const nodes = stages.flatMap((stage) => stage.nodes)
  if (nodes.some((node) => node.tone === 'fault')) return { label: '链路中断', tone: 'danger' }
  if (nodes.every((node) => node.tone === 'idle')) return { label: '待机', tone: 'neutral' }
  if (nodes.some((node) => node.tone === 'enhanced')) return { label: '已处理', tone: 'warning' }
  if (nodes.some((node) => node.tone === 'adapted')) return { label: '已转换', tone: 'info' }
  return { label: '原样输出', tone: 'success' }
}

// ---------------------------------------------------------------------------
// Sync groups

export const GROUP_PHASE_LABEL: Record<SyncGroupEngineState['phase'], string> = {
  paused: '已暂停',
  preparing: '共同预缓冲',
  armed: '已调度起播',
  playing: '同步播放中',
  rebuffering: '共同重缓冲',
  completed: '队列已结束',
  failed: '需要恢复'
}

export const GROUP_STEPS = [
  { phase: 'paused', label: '待命' },
  { phase: 'preparing', label: '预缓冲' },
  { phase: 'armed', label: '调度起播' },
  { phase: 'playing', label: '同步播放' }
] as const

export function groupPhase(group: SyncGroupView): SyncGroupEngineState['phase'] {
  return group.coordination?.phase ?? (group.playback?.state === 'playing' ? 'playing' : 'paused')
}

/** Index into GROUP_STEPS; rebuffering re-enters preparation, completion rests at the start. */
export function groupStepIndex(phase: SyncGroupEngineState['phase']): number {
  if (phase === 'rebuffering') return 1
  if (phase === 'completed' || phase === 'failed') return 0
  return GROUP_STEPS.findIndex((step) => step.phase === phase)
}

export function groupPhaseTone(phase: SyncGroupEngineState['phase']): ZoneTone {
  if (phase === 'playing') return 'success'
  if (phase === 'failed') return 'danger'
  if (phase === 'rebuffering') return 'warning'
  if (phase === 'preparing' || phase === 'armed') return 'info'
  return 'neutral'
}

/** Core flags drift once the lower bound of the spread exceeds 1 ms. */
export const GROUP_SKEW_TOLERANCE_MS = 1

export interface SkewReading {
  measured: boolean
  skewMs: number
  rangeMs: number
  aligned: boolean
  label: string
  /** Axis maximum in ms; the meter maps 0…scale onto its width. */
  scaleMs: number
}

export function groupSkew(group: SyncGroupView): SkewReading {
  const skew = group.coordination?.estimatedSkewMs
  const range = group.coordination?.observationRangeMs ?? 0
  if (skew === null || skew === undefined || !Number.isFinite(skew)) {
    return {
      measured: false,
      skewMs: 0,
      rangeMs: 0,
      aligned: true,
      label: groupPhase(group) === 'playing' ? '正在测量' : '播放后测量',
      scaleMs: 2
    }
  }
  const aligned = skew - range <= GROUP_SKEW_TOLERANCE_MS
  const scale = Math.max(2, Math.ceil((skew + range) * 1.25 * 2) / 2)
  return {
    measured: true,
    skewMs: skew,
    rangeMs: range,
    aligned,
    label: aligned ? '对齐良好' : `超出 ${GROUP_SKEW_TOLERANCE_MS} ms 容差`,
    scaleMs: scale
  }
}

export function groupReady(group: SyncGroupView, zones: ZoneView[]): boolean {
  return group.members.every((member) => {
    const zone = zones.find((candidate) => candidate.id === member.zoneId)
    return Boolean(zone?.output?.connected && zone.output.receiver?.adaptiveSupported)
  })
}

export function formatMs(value: number, digits = 2): string {
  return `${value.toFixed(digits)} ms`
}

/** A member can join synchronized playback only through an adaptive-clock Bridge. */
export function memberReadiness(zone: ZoneView | undefined): { ready: boolean; label: string; tone: ZoneTone } {
  if (!zone) return { ready: false, label: '声区已移除', tone: 'danger' }
  const output = zone.output
  if (!output?.connected) {
    if (output?.peerName) return { ready: false, label: '输出桥离线', tone: 'danger' }
    return isBridgeZone(zone)
      ? { ready: false, label: '未配对输出桥', tone: 'warning' }
      : { ready: false, label: '需要输出桥', tone: 'warning' }
  }
  if (!output.receiver?.adaptiveSupported) return { ready: false, label: '不支持时钟自适应', tone: 'warning' }
  return { ready: true, label: '可同步', tone: 'success' }
}

// ---------------------------------------------------------------------------
// Wall layout

export type WallItem =
  | { kind: 'zone'; key: string; zone: ZoneView }
  | { kind: 'group'; key: string; group: SyncGroupView; members: ZoneView[] }

/** Zones in Core order; a sync group takes the place of its first member and holds the rest. */
export function wallItems(zones: ZoneView[], groups: SyncGroupView[]): WallItem[] {
  const items: WallItem[] = []
  const placed = new Set<string>()
  for (const zone of zones) {
    const group = zone.groupId ? groups.find((candidate) => candidate.id === zone.groupId) : undefined
    if (!group) {
      items.push({ kind: 'zone', key: zone.id, zone })
      continue
    }
    if (placed.has(group.id)) continue
    placed.add(group.id)
    const members = group.members
      .map((member) => zones.find((candidate) => candidate.id === member.zoneId))
      .filter((member): member is ZoneView => Boolean(member))
    items.push({ kind: 'group', key: group.id, group, members })
  }
  return items
}

export function volumeIcon(volume: number): string {
  if (volume <= 0.001) return 'ph-speaker-simple-x'
  if (volume < 0.5) return 'ph-speaker-simple-low'
  return 'ph-speaker-simple-high'
}
