import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { SocketMessagePort } from './socketPort.ts'

// Install the same narrow parent-port contract before loading the existing production entry.
const parent = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void }
parent.postMessage = (message) => {
  process.send!(message, (error) => {
    if (error) throw error
  })
}
Object.defineProperty(process, 'parentPort', { value: parent })
process.on('message', (envelope: { message: unknown; socket: boolean }, handle: Socket) => {
  parent.emit('message', {
    data: envelope.message,
    ports: envelope.socket ? [new SocketMessagePort(handle)] : []
  })
})
process.once('disconnect', () => {
  parent.emit('close')
  // Services that own audio handle parent close synchronously before exiting.
  process.exit(0)
})
createRequire(import.meta.url)(process.argv[2])
