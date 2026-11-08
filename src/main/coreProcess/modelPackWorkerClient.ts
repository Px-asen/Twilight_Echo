import type { CoreModelPackOptions } from '../../core/audio/modelPackService.ts'
import type { CoreModelPackStatus } from '../../shared/coreModelPack.ts'
import type {
  ModelPackPlatformCall,
  ModelPackWorkerMessage,
  ModelPackWorkerRequest
} from './modelPackWorkerProtocol.ts'

export interface ModelPackWorkerLease {
  postMessage(message: ModelPackWorkerRequest): void
  on(event: 'message', listener: (message: ModelPackWorkerMessage) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  terminate(): Promise<void>
}
type Operation = {
  lease: ModelPackWorkerLease
  done: Promise<void>
  resolve(): void
  calls: Map<number, { controller: AbortController; work: Promise<void> }>
  startup: ReturnType<typeof setTimeout>
  finishing: boolean
}

/** Core retains progress only. Each installation owns and then reaps its host. */
export class ModelPackWorkerClient {
  private value: CoreModelPackStatus = { phase: 'idle', completedBytes: 0, totalBytes: 0 }
  private operation: Operation | undefined
  private stopped = false
  private readonly options: CoreModelPackOptions & {
    launch(): ModelPackWorkerLease
    startupTimeoutMs?: number
  }
  constructor(options: ModelPackWorkerClient['options']) {
    this.options = options
  }
  state(): CoreModelPackStatus {
    return structuredClone(this.value)
  }

  start(enableAfterInstall: boolean): CoreModelPackStatus {
    if (this.stopped) throw new Error('Core model installer is stopped')
    if (this.operation) return this.state()
    this.value = { phase: 'selecting', completedBytes: 0, totalBytes: 0 }
    try {
      const lease = this.options.launch()
      let resolve!: () => void
      const done = new Promise<void>((finish) => {
        resolve = finish
      })
      const operation: Operation = {
        lease,
        done,
        resolve,
        calls: new Map(),
        finishing: false,
        startup: setTimeout(() => {
          void this.fail(operation)
        }, this.options.startupTimeoutMs ?? 30_000)
      }
      operation.startup.unref?.()
      this.operation = operation
      lease.on('message', (message) => {
        if (this.operation !== operation || operation.finishing) return
        if (message.kind === 'ready') {
          clearTimeout(operation.startup)
          lease.postMessage({
            kind: 'start',
            root: this.options.root,
            enableAfterInstall,
            checkpointSha256: this.options.checkpointSha256
          })
          if (this.stopped) lease.postMessage({ kind: 'shutdown' })
        } else if (message.kind === 'state') {
          this.value = message.state
          this.options.changed()
        } else if (message.kind === 'platform')
          this.dispatchPlatform(operation, message.id, message)
        else if (message.kind === 'platform-cancel')
          operation.calls.get(message.id)?.controller.abort()
        else if (message.kind === 'finished') {
          this.value = message.state
          void this.finish(operation)
        }
      })
      lease.on('exit', () => {
        if (!operation.finishing) void this.fail(operation)
      })
      lease.on('error', () => {
        if (!operation.finishing) void this.fail(operation)
      })
    } catch {
      this.value = { ...this.value, phase: 'failed', reason: 'runtime' }
    }
    this.options.changed()
    return this.state()
  }

  private dispatchPlatform(operation: Operation, id: number, call: ModelPackPlatformCall): void {
    const controller = new AbortController()
    const invoke = async (): Promise<unknown> => {
      switch (call.operation) {
        case 'chooseArchive':
          return this.options.chooseArchive(controller.signal)
        case 'decode':
          return this.options.decode(call.payload, controller.signal)
        case 'probe':
          return this.options.probe(call.payload, controller.signal)
        case 'installed':
          return this.options.installed(call.payload)
      }
    }
    const work = Promise.resolve()
      .then(invoke)
      .then(
        (value) => {
          if (!operation.finishing)
            operation.lease.postMessage({ kind: 'platform-result', id, ok: true, value })
        },
        (error) => {
          if (!operation.finishing)
            operation.lease.postMessage({
              kind: 'platform-result',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
        }
      )
      .catch(() => {
        void this.fail(operation)
      })
      .finally(() => {
        operation.calls.delete(id)
      })
    operation.calls.set(id, { controller, work })
  }

  private async fail(operation: Operation): Promise<void> {
    if (this.operation !== operation || operation.finishing) return
    this.value = { ...this.value, phase: 'failed', reason: 'runtime' }
    for (const call of operation.calls.values()) call.controller.abort()
    await this.finish(operation)
  }
  private async finish(operation: Operation): Promise<void> {
    if (operation.finishing) return operation.done
    operation.finishing = true
    clearTimeout(operation.startup)
    try {
      await Promise.allSettled([...operation.calls.values()].map((call) => call.work))
      await operation.lease.terminate()
    } finally {
      if (this.operation === operation) this.operation = undefined
      operation.resolve()
      this.options.changed()
    }
  }
  cancel(): CoreModelPackStatus {
    const operation = this.operation
    if (operation && !operation.finishing) {
      try {
        operation.lease.postMessage({ kind: 'cancel' })
      } catch {
        void this.fail(operation)
      }
    }
    return this.state()
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    const operation = this.operation
    if (!operation) return
    if (!operation.finishing) {
      try {
        operation.lease.postMessage({ kind: 'shutdown' })
      } catch {
        void this.fail(operation)
      }
    }
    await operation.done
  }
}
