/** Phase 1 owns one Core session/Zone; output selection never creates a second queue. */
export interface BridgePeer {
  host: string
  port: number
  token: string
  fingerprint: string
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
}
export interface CoreZoneState extends BridgeRuntimeState {
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
