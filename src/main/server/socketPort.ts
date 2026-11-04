import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { serialize, deserialize } from 'node:v8'
import type { ServiceMessagePort } from '../services/servicePort.ts'

/** A transferred, connected socket. The supervisor never reads its business traffic. */
export class SocketMessagePort extends EventEmitter implements ServiceMessagePort {
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private bodyBytes = 0
  private length = 0
  private chunks: Buffer[] = []
  private started = false
  private readonly socket: Socket

  constructor(socket: Socket) {
    super()
    this.socket = socket
    socket.pause()
    socket.on('data', (chunk: Buffer) => {
      let offset = 0
      while (offset < chunk.length) {
        if (this.headerBytes < 4) {
          const bytes = Math.min(4 - this.headerBytes, chunk.length - offset)
          chunk.copy(this.header, this.headerBytes, offset, offset + bytes)
          this.headerBytes += bytes
          offset += bytes
          if (this.headerBytes < 4) return
          this.length = this.header.readUInt32BE(0)
        }
        const bytes = Math.min(this.length - this.bodyBytes, chunk.length - offset)
        this.chunks.push(chunk.subarray(offset, offset + bytes))
        this.bodyBytes += bytes
        offset += bytes
        if (this.bodyBytes === this.length) {
          const value = deserialize(Buffer.concat(this.chunks, this.length))
          this.chunks = []
          this.headerBytes = this.bodyBytes = this.length = 0
          this.emit('message', { data: value })
        }
      }
    })
    // Losing a private peer invalidates its lease; no reconnect or replay.
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.emit('close'))
  }

  postMessage(message: unknown): void {
    if (this.socket.destroyed) throw new Error('Private service channel is closed')
    const body = serialize(message)
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(body.length)
    this.socket.write(Buffer.concat([header, body]))
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.socket.resume()
  }

  close(): void {
    this.socket.destroy()
  }
}
