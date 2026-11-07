import type { TLSSocket } from 'node:tls'

export const BRIDGE_PACKET_LIMIT = 2048 * 8 * 4 + 40
// A length prefix plus one bounded JSON control or up-to-eight-channel audio block. Audio
// stays inside the utility process; it never crosses the Core command RPC lane.
export function sendBridgePacket(socket: TLSSocket, kind: number, data: Buffer): void {
  if (data.length > BRIDGE_PACKET_LIMIT || socket.writableLength > 128 * 1024)
    throw new Error('Bridge transport budget exceeded')
  const head = Buffer.allocUnsafe(5)
  head.writeUInt32BE(data.length + 1); head[4] = kind
  socket.write(Buffer.concat([head, data]))
}
export function sendBridgeJson(socket: TLSSocket, value: object): void {
  sendBridgePacket(socket, 0, Buffer.from(JSON.stringify(value)))
}
export function readBridgePackets(socket: TLSSocket, receive: (kind: number, data: Buffer) => void): void {
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    try {
      // Socket chunks are bounded separately from individual packets.
      if (pending.length + chunk.length > 256 * 1024) throw new Error('Bridge input budget exceeded')
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0)
        if (size < 1 || size > BRIDGE_PACKET_LIMIT + 1) throw new Error('Invalid Bridge packet size')
        if (pending.length < size + 4) break
        const packet = pending.subarray(4, size + 4)
        pending = pending.subarray(size + 4)
        receive(packet[0], packet.subarray(1))
      }
    } catch (cause) { socket.destroy(cause instanceof Error ? cause : new Error('Bridge protocol error')) }
  })
}
