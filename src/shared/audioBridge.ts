import type { BridgeClockStatus } from './audioBridgeClock.ts'
/** Each Bridge connection belongs to one Core session. */
export interface BridgePeer {
  host: string
  port: number
  token: string
  fingerprint: string
}
export interface BridgeOutputClock {
  supported: boolean
  valid: boolean
  running: boolean
  source: 'wasapi-audio-clock' | 'unsupported'
  streamGeneration: number
  epoch: number
  positionFrames: number
  sampledAtMs: number
  readAtMs: number
  sampleRate: number
  callbackRequestedFrames: number
}
export function readBridgeOutputClock(value: unknown): BridgeOutputClock | null {
  if (value === undefined || value === null) return null // Legacy receiver.
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bridge clock')
  const raw = value as Record<string, unknown>, result: Record<string, unknown> = {}
  for (const key of ['supported', 'valid', 'running']) {
    if (typeof raw[key] !== 'boolean') throw new Error('Invalid Bridge clock flags')
    result[key] = raw[key]
  }
  for (const key of ['streamGeneration', 'epoch', 'sampleRate', 'callbackRequestedFrames']) {
    if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0) throw new Error('Invalid Bridge clock counter')
    result[key] = raw[key]
  }
  for (const key of ['positionFrames', 'sampledAtMs', 'readAtMs']) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || Number(raw[key]) < 0 || Number(raw[key]) > Number.MAX_SAFE_INTEGER)
      throw new Error('Invalid Bridge clock position or timestamp')
    result[key] = raw[key]
  }
  if (!['wasapi-audio-clock', 'unsupported'].includes(String(raw.source))) throw new Error('Invalid Bridge clock source')
  result.source = raw.source
  const clock = result as unknown as BridgeOutputClock
  if ((clock.supported !== (clock.source !== 'unsupported')) ||
      (clock.valid && (!clock.supported || !clock.running || clock.sampleRate < 44100 || clock.sampleRate > 192000 ||
        clock.sampledAtMs <= 0 || clock.sampledAtMs > clock.readAtMs))) throw new Error('Inconsistent Bridge clock')
  return clock
}
export interface BridgeReceiverFacts {
  sampleRate: number
  channels: number
  bufferedFrames: number
  capacityFrames: number
  prebufferFrames: number
  consumedFrames: number
  underruns: number
  started: boolean
  failed: boolean
  backend: string
  deviceName: string
  actualSampleRate: number
  actualBitDepth: number
  actualChannels: number
  actualOutputFormat: string
  exclusive: boolean
  clock?: BridgeOutputClock | null
  timedStart?: BridgeTimedStartFacts | null
  adaptiveSupported?: boolean
  adaptive?: BridgeAdaptiveFacts | null
}
export interface BridgeAdaptiveFacts {
  requestedPpm: number
  effectivePpm: number
  inputFrames: number
  pendingInputFrames: number
  resamplerDelayFrames: number
  sourceConsumedFrames: number
  inputCreditFrames: number
}
export function readBridgeAdaptive(value: unknown): BridgeAdaptiveFacts | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid adaptive Bridge facts')
  const raw = value as Record<string, unknown>, result: Record<string, number> = {}
  for (const key of ['requestedPpm', 'effectivePpm', 'inputFrames', 'pendingInputFrames', 'resamplerDelayFrames', 'sourceConsumedFrames', 'inputCreditFrames']) {
    const n = raw[key]
    if (typeof n !== 'number' || !Number.isFinite(n) ||
        (key.endsWith('Ppm') ? Math.abs(n) > 1002 : n < 0 || n > Number.MAX_SAFE_INTEGER) ||
        (['inputFrames', 'inputCreditFrames'].includes(key) && !Number.isSafeInteger(n))) throw new Error('Invalid adaptive Bridge counter')
    result[key] = n
  }
  return result as unknown as BridgeAdaptiveFacts
}
export interface BridgeTimedStartFacts {
  supported: boolean
  state: 'disabled' | 'prepared' | 'armed' | 'running' | 'completed' | 'failed'
  error: string
  ended: boolean
  targetAtMs: number
  mediaFrame: number
  deviceStartFrame: number | null
  deviceStartAtMs: number | null
  presentedMediaFrames: number | null
}
export function readBridgeTimedStart(value: unknown): BridgeTimedStartFacts | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid timed Bridge facts')
  const r = value as BridgeTimedStartFacts
  if (typeof r.supported !== 'boolean' || typeof r.ended !== 'boolean' ||
      !['disabled', 'prepared', 'armed', 'running', 'completed', 'failed'].includes(r.state) ||
      !['', 'clock_unavailable', 'clock_epoch_changed', 'deadline_missed', 'media_underrun', 'driver_failed', 'device_frame_discontinuity'].includes(r.error) ||
      !Number.isSafeInteger(r.mediaFrame) || r.mediaFrame < 0 ||
      !Number.isFinite(r.targetAtMs) || r.targetAtMs < 0 ||
      (r.deviceStartFrame !== null && (!Number.isSafeInteger(r.deviceStartFrame) || r.deviceStartFrame < 0)) ||
      [r.deviceStartAtMs, r.presentedMediaFrames].some(n => n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)) ||
      ((r.deviceStartFrame === null) !== (r.deviceStartAtMs === null)) ||
      (r.presentedMediaFrames !== null && r.deviceStartFrame === null) ||
      (r.state === 'armed' && r.targetAtMs <= 0)) throw new Error('Invalid timed Bridge facts')
  return { supported: r.supported, state: r.state, error: r.error, ended: r.ended, targetAtMs: r.targetAtMs,
    mediaFrame: r.mediaFrame, deviceStartFrame: r.deviceStartFrame, deviceStartAtMs: r.deviceStartAtMs,
    presentedMediaFrames: r.presentedMediaFrames }
}
export function readBridgeReceiverFacts(value: unknown): BridgeReceiverFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bridge facts')
  const raw = value as Record<string, unknown>, result: Record<string, unknown> = {}
  for (const key of ['sampleRate', 'channels', 'bufferedFrames', 'capacityFrames', 'prebufferFrames', 'consumedFrames', 'underruns',
    'actualSampleRate', 'actualBitDepth', 'actualChannels']) {
    const n = raw[key]
    if (!Number.isSafeInteger(n) || Number(n) < 0) throw new Error('Invalid Bridge counter')
    result[key] = n
  }
  for (const key of ['started', 'failed', 'exclusive']) {
    if (typeof raw[key] !== 'boolean') throw new Error('Invalid Bridge state')
    result[key] = raw[key]
  }
  for (const key of ['backend', 'deviceName', 'actualOutputFormat']) {
    if (typeof raw[key] !== 'string' || raw[key].length > 1024 || raw[key].includes('\0')) throw new Error('Invalid Bridge output')
    result[key] = raw[key]
  }
  const facts = result as unknown as BridgeReceiverFacts
  facts.clock = readBridgeOutputClock(raw.clock)
  facts.timedStart = readBridgeTimedStart(raw.timedStart)
  if (raw.adaptiveSupported !== undefined && typeof raw.adaptiveSupported !== 'boolean') throw new Error('Invalid adaptive Bridge support')
  facts.adaptiveSupported = raw.adaptiveSupported === true
  facts.adaptive = readBridgeAdaptive(raw.adaptive)
  if (facts.adaptive && (!facts.adaptiveSupported || !facts.timedStart?.supported || facts.timedStart.state === 'disabled' ||
      facts.adaptive.sourceConsumedFrames > facts.adaptive.inputFrames || facts.adaptive.inputCreditFrames > facts.capacityFrames))
    throw new Error('Inconsistent adaptive Bridge facts')
  if (facts.clock?.valid && facts.clock.sampleRate !== facts.sampleRate) throw new Error('Bridge clock format changed')
  if (facts.channels !== 2 || facts.sampleRate < 44100 || facts.sampleRate > 192000 ||
      facts.capacityFrames > facts.sampleRate || facts.bufferedFrames > facts.capacityFrames ||
      facts.prebufferFrames > facts.capacityFrames)
    throw new Error('Invalid Bridge format or buffer')
  return facts
}
export interface BridgeRuntimeState {
  supported: boolean
  hosting: boolean
  receiving: boolean
  selected: boolean
  connected: boolean
  peerName: string | null
  error: string | null
  receiver: BridgeReceiverFacts | null
  timing?: BridgeClockStatus | null
  synchronization?: import('./audioBridgeSync.ts').BridgeSyncStatus | null
}
export interface CoreZoneState extends BridgeRuntimeState {
  groupId?: string | null
  revision: number
  zoneId: 'local'
  selectedOutputId: 'local' | 'bridge'
  outputs: { id: 'local' | 'bridge'; name: string; available: boolean }[]
}
export interface BridgePcmBlock {
  generation: number
  sampleRate: number
  channels: number
  frames: number
  playing: boolean
  pcm: Uint8Array
}
export function validBridgePeer(value: unknown): value is BridgePeer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as BridgePeer
  return Object.keys(p).every(k => ['host', 'port', 'token', 'fingerprint'].includes(k)) &&
    typeof p.host === 'string' && /^[a-zA-Z0-9.:[\]%-]{1,253}$/.test(p.host) &&
    Number.isInteger(p.port) && p.port > 0 && p.port <= 65535 &&
    typeof p.token === 'string' && /^[a-f0-9]{48}$/.test(p.token) &&
    typeof p.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(p.fingerprint)
}
export function parseBridgeInvitation(value: string): BridgePeer {
  let url: URL
  try {
    if (value.length > 2048) throw new Error('Invitation too long')
    url = new URL(value.trim())
  } catch { throw new Error('输出桥邀请无效，请复制完整邀请') }
  const peer = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port),
    token: url.searchParams.get('token') ?? '', fingerprint: url.searchParams.get('fp') ?? '' }
  if (url.protocol !== 'twilight-bridge:' || !validBridgePeer(peer)) throw new Error('输出桥邀请无效')
  return peer
}
export function bridgeInvitation(peer: BridgePeer): string {
  const host = peer.host.includes(':') ? `[${peer.host}]` : peer.host
  return `twilight-bridge://${host}:${peer.port}?token=${peer.token}&fp=${peer.fingerprint}`
}
