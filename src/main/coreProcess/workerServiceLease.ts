import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { Worker, type ResourceLimits } from 'node:worker_threads'
import type { CoreServiceKind } from '../../shared/coreProtocol.ts'
import type { CoreServiceLauncher, CoreServiceLease } from './serviceLauncher.ts'

export type InProcessWorkerServiceKind = Extract<CoreServiceKind, 'database' | 'scan'>

const WORKER_SERVICE_BASENAMES: Record<InProcessWorkerServiceKind, string> = {
  database: 'libraryDatabaseService',
  scan: 'libraryScanService'
}

const WORKER_RESOURCE_LIMITS: Record<InProcessWorkerServiceKind, ResourceLimits> = {
  database: { maxOldGenerationSizeMb: 256 },
  scan: { maxOldGenerationSizeMb: 192 }
}

/**
 * Resolves a sibling service module path next to the running Core entry module.
 * Works uniformly across bundled Electron ASAR (`*.js`), Node Server (`*.cjs`), and `.ts` tests.
 */
export function resolveWorkerServiceEntry(
  service: CoreServiceKind,
  hostFilename: string | undefined = typeof __filename === 'string' ? __filename : undefined,
  fileExists: (path: string) => boolean = existsSync
): string | null {
  if (!(service in WORKER_SERVICE_BASENAMES) || !hostFilename) return null
  const basename = WORKER_SERVICE_BASENAMES[service as InProcessWorkerServiceKind]
  const rawExtension = extname(hostFilename)
  const extension = rawExtension === '.cjs' || rawExtension === '.ts' ? rawExtension : '.js'
  const candidate = join(dirname(hostFilename), `${basename}${extension}`)
  return fileExists(candidate) ? candidate : null
}

/**
 * Exposes a `node:worker_threads` worker using the exact `CoreServiceLease` event/control
 * contract so Core clients can switch transparently between OS processes and worker threads.
 */
export class WorkerServiceLease extends EventEmitter {
  readonly id: string
  private readonly worker: Worker
  private closed = false
  private readonly exitPromise: Promise<void>

  constructor(
    entryPath: string,
    service: CoreServiceKind,
    options: {
      id?: string
      resourceLimits?: ResourceLimits
      workerData?: Record<string, unknown>
    } = {}
  ) {
    super()
    this.id = options.id ?? `worker:${service}`
    this.worker = new Worker(entryPath, {
      workerData: {
        ...options.workerData,
        twilightWorkerThread: true,
        service
      },
      resourceLimits:
        options.resourceLimits ??
        WORKER_RESOURCE_LIMITS[service as InProcessWorkerServiceKind]
    })
    this.exitPromise = new Promise<void>((resolve) => {
      this.worker.once('exit', (code) => {
        const wasClosed = this.closed
        this.closed = true
        resolve()
        if (!wasClosed) {
          this.emit('exit', code)
          this.removeAllListeners()
        }
      })
    })
    this.worker.on('message', (message) => {
      if (!this.closed) this.emit('message', message)
    })
    this.worker.on('error', (error) => {
      if (this.closed) return
      this.emit('error', error)
    })
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('Worker service lease is closed')
    this.worker.postMessage(message)
  }

  waitForExit(): Promise<void> {
    return this.exitPromise
  }

  kill(): void {
    if (this.closed) return
    this.closed = true
    void this.worker.terminate().finally(() => this.removeAllListeners())
  }

  /** Terminates the worker thread and awaits OS/V8 thread exit for clean shutdown. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise
      return
    }
    this.closed = true
    try {
      await this.worker.terminate()
    } finally {
      await this.exitPromise
      this.removeAllListeners()
    }
  }
}

export type SupervisedOrWorkerLease = Pick<
  CoreServiceLease | WorkerServiceLease,
  'postMessage' | 'kill' | 'on'
>

/**
 * Routes configured in-process services to local `worker_threads` inside `musicCore`,
 * while preserving `CoreServiceLauncher` OS-process isolation for all other services.
 */
export function createCoreServiceFactory(options: {
  launcher: Pick<CoreServiceLauncher, 'launch'>
  workerServices?: readonly CoreServiceKind[]
  hostFilename?: string
  resolveEntry?: (service: CoreServiceKind, hostFilename?: string) => string | null
  createWorker?: (entryPath: string, service: CoreServiceKind) => WorkerServiceLease
}): {
  launch(service: CoreServiceKind): SupervisedOrWorkerLease
  closeAll(): Promise<void>
} {
  const workerSet = new Set<CoreServiceKind>(options.workerServices ?? [])
  const activeWorkers = new Set<WorkerServiceLease>()
  const resolveEntry = options.resolveEntry ?? resolveWorkerServiceEntry
  const createWorker =
    options.createWorker ?? ((entryPath, service) => new WorkerServiceLease(entryPath, service))

  return {
    launch(service) {
      const entryPath = workerSet.has(service)
        ? resolveEntry(service, options.hostFilename)
        : null
      if (!entryPath) return options.launcher.launch(service)
      const lease = createWorker(entryPath, service)
      activeWorkers.add(lease)
      void lease.waitForExit().finally(() => activeWorkers.delete(lease))
      return lease
    },
    async closeAll() {
      const running = [...activeWorkers]
      activeWorkers.clear()
      await Promise.allSettled(running.map((lease) => lease.close()))
    }
  }
}
