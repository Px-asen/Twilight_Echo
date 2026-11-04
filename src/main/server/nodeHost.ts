import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import type { CoreSupervisorOptions, SupervisedProcess } from '../coreProcess/supervisor.ts'
import type { ServiceMessagePort } from '../services/servicePort.ts'

/** Only socket ownership crosses Node IPC. Both business endpoints leave the parent. */
class TransferEndpoint implements ServiceMessagePort {
  private transferred = false
  readonly socket: Promise<Socket>
  constructor(socket: Promise<Socket>) {
    this.socket = socket
  }
  postMessage(): never {
    throw new Error('A service endpoint must be transferred to its owner')
  }
  on(): never {
    throw new Error('The supervisor cannot read private service traffic')
  }
  async take(): Promise<Socket> {
    if (this.transferred) throw new Error('Service endpoint already transferred')
    this.transferred = true
    return this.socket
  }
  close(): void {
    if (!this.transferred)
      void this.socket.then(
        (socket) => socket.destroy(),
        () => {}
      )
  }
}

/** A loopback socket pair whose handles can be transferred between Node processes on Windows. */
export function createNodeServiceChannel(): ReturnType<CoreSupervisorOptions['channel']> {
  const pair = new Promise<[Socket, Socket]>((resolve, reject) => {
    const listener = createServer({ pauseOnConnect: true })
    let client: Socket | undefined
    let accepted: Socket | undefined
    let connected = false
    const candidates = new Set<Socket>()
    const fail = (error: Error) => {
      listener.close()
      client?.destroy()
      accepted?.destroy()
      for (const socket of candidates) socket.destroy()
      reject(error)
    }
    const finish = () => {
      if (!connected || !client || !accepted) return
      listener.close()
      client.off('error', fail)
      accepted.off('error', fail)
      resolve([accepted, client])
    }
    listener.on('error', fail)
    listener.on('connection', (socket) => {
      candidates.add(socket)
      socket.on('error', fail)
      if (connected && socket.remotePort === client?.localPort) {
        accepted = socket
        finish()
      } else if (connected) socket.destroy()
    })
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address() as { port: number }
      client = createConnection({ port: address.port, host: '127.0.0.1' })
      client.on('error', fail)
      client.once('connect', () => {
        connected = true
        for (const socket of candidates) {
          if (socket.remotePort === client!.localPort) accepted = socket
          else socket.destroy()
        }
        finish()
      })
    })
  })
  return {
    port1: new TransferEndpoint(pair.then(([a]) => a)),
    port2: new TransferEndpoint(pair.then(([, b]) => b))
  }
}

export class NodeSupervisedProcess extends EventEmitter implements SupervisedProcess {
  private sending = Promise.resolve()
  readonly child: ChildProcess
  constructor(options: {
    bootstrap: string
    entry: string
    args: string[]
    cwd: string
    env?: NodeJS.ProcessEnv
  }) {
    super()
    this.child = spawn(process.execPath, [options.bootstrap, options.entry, ...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })
    this.child.on('message', (message) => this.emit('message', message))
    this.child.on('error', (error) => this.emit('error', error))
    this.child.on('spawn', () => this.emit('spawn'))
    this.child.on('exit', (code, signal) => this.emit('exit', code, signal))
  }

  postMessage(message: unknown, ports: ServiceMessagePort[] = []): void {
    if (ports.length > 1 || ports.some((port) => !(port instanceof TransferEndpoint)))
      throw new Error('Node services require one owned socket endpoint')
    this.sending = this.sending
      .then(async () => {
        const socket = ports.length ? await (ports[0] as TransferEndpoint).take() : undefined
        await new Promise<void>((resolve, reject) => {
          this.child.send({ message, socket: !!socket }, socket, { keepOpen: false }, (error) => {
            if (error) {
              socket?.destroy()
              reject(error)
            } else resolve()
          })
        })
      })
      .catch((error) => {
        this.emit('error', error)
      })
  }

  kill(): boolean {
    return this.child.kill()
  }
}
