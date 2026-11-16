import type { TLSSocket } from 'node:tls'
import type { BridgeAudioFormat } from '../../shared/audioBridge.ts'

export const BRIDGE_PACKET_LIMIT = 2048 * 8 * 4 + 40

/** Compares negotiated Bridge stream format fields without object/JSON allocations. */
export function sameBridgeAudioFormat(
  left: Pick<BridgeAudioFormat, 'sampleRate' | 'channels' | 'wireFormat' | 'channelMask'>,
  right: Pick<BridgeAudioFormat, 'sampleRate' | 'channels' | 'wireFormat' | 'channelMask'>
): boolean {
  return (
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels &&
    left.wireFormat === right.wireFormat &&
    left.channelMask === right.channelMask
  )
}

function assertPacketBudget(socket: TLSSocket, bodyLength: number): void {
  if (bodyLength > BRIDGE_PACKET_LIMIT || socket.writableLength > 128 * 1024)
    throw new Error('Bridge transport budget exceeded')
}

// A length prefix plus one bounded JSON control or up-to-eight-channel audio block. Audio
// stays inside the utility process; it never crosses the Core command RPC lane.
export function sendBridgePacket(socket: TLSSocket, kind: number, data: Uint8Array): void {
  assertPacketBudget(socket, data.byteLength)
  const frame = Buffer.allocUnsafe(5 + data.byteLength)
  frame.writeUInt32BE(data.byteLength + 1, 0)
  frame[4] = kind
  frame.set(data, 5)
  socket.write(frame)
}

/** Frames a header + binary PCM/DoP/DSD payload in a single write buffer allocation. */
export function sendBridgeFramedBlock(
  socket: TLSSocket,
  kind: number,
  headerLength: number,
  writeHeader: (header: Buffer) => void,
  payload: Uint8Array
): void {
  const bodyLength = headerLength + payload.byteLength
  assertPacketBudget(socket, bodyLength)
  const frame = Buffer.allocUnsafe(5 + bodyLength)
  frame.writeUInt32BE(bodyLength + 1, 0)
  frame[4] = kind
  writeHeader(frame.subarray(5, 5 + headerLength))
  frame.set(payload, 5 + headerLength)
  socket.write(frame)
}

export function sendBridgeJson(socket: TLSSocket, value: object): void {
  const json = JSON.stringify(value)
  const byteLength = Buffer.byteLength(json, 'utf8')
  assertPacketBudget(socket, byteLength)
  const frame = Buffer.allocUnsafe(5 + byteLength)
  frame.writeUInt32BE(byteLength + 1, 0)
  frame[4] = 0
  frame.write(json, 5, 'utf8')
  socket.write(frame)
}

export function readBridgePackets(socket: TLSSocket, receive: (kind: number, data: Buffer) => void): void {
  let pending: Buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    try {
      // Socket chunks are bounded separately from individual packets.
      if (pending.length + chunk.length > 256 * 1024) throw new Error('Bridge input budget exceeded')
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0)
        if (size < 1 || size > BRIDGE_PACKET_LIMIT + 1) throw new Error('Invalid Bridge packet size')
        if (pending.length < size + 4) break
        const packet = pending.subarray(4, size + 4)
        pending = pending.subarray(size + 4)
        receive(packet[0], packet.subarray(1))
      }
      if (pending.length === 0) pending = Buffer.alloc(0)
    } catch (cause) { socket.destroy(cause instanceof Error ? cause : new Error('Bridge protocol error')) }
  })
}
