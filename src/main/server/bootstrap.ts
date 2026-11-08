import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { SocketMessagePort } from './socketPort.ts'
import { isAbsolute } from 'node:path'
import { decodeSupervisionMessage, encodeSupervisionMessage } from './supervisionCodec.ts'

const stableSupervision = process.env.TWILIGHT_DESKTOP_NODE_HOST === '1'

// The desktop owns this value. Pure Node cannot discover Electron's resources
// directory, and must never resolve packaged native assets from its launch cwd.
if (stableSupervision) {
  const resources = process.env.TWILIGHT_DESKTOP_RESOURCES_PATH
  if (!resources || !isAbsolute(resources))
    throw new Error('Desktop Node resources path is invalid')
  Object.defineProperty(process, 'resourcesPath', { value: resources })
}

// Install the same narrow parent-port contract before loading the existing production entry.
const parent = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void }
parent.postMessage = (message) => {
  process.send!(stableSupervision ? encodeSupervisionMessage(message) : message, (error) => {
    if (error) throw error
  })
}
Object.defineProperty(process, 'parentPort', { value: parent })
process.on('message', (envelope: { message: unknown; socket: boolean }, handle: Socket) => {
  parent.emit('message', {
    data: stableSupervision ? decodeSupervisionMessage(envelope.message) : envelope.message,
    ports: envelope.socket ? [new SocketMessagePort(handle)] : []
  })
})
process.once('disconnect', () => {
  parent.emit('close')
  // Services that own audio handle parent close synchronously before exiting.
  process.exit(0)
})
createRequire(import.meta.url)(process.argv[2])
