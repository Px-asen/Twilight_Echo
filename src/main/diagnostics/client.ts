import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import type { DiagnosticEvent, DiagnosticStatus } from '../../shared/diagnostics.ts'
import {
  DIAGNOSTICS_MAX_QUEUE_BYTES,
  DIAGNOSTICS_MAX_TOTAL_BYTES,
  DIAGNOSTICS_RETENTION_DAYS
} from '../../shared/diagnostics.ts'
import { diagnosticIdentity, writeDiagnostic } from './logger.ts'
import { sanitizeDiagnosticText } from './sanitize.ts'
import { DiagnosticStore } from './store.ts'
import { utilityDiagnosticStatuses } from './utilityObservation.ts'

type QueuedDiagnostic = { event: DiagnosticEvent; line: string; bytes: number }

export class DiagnosticWriterClient {
  readonly directory: string
  private worker: Worker | null = null
  private localStore: DiagnosticStore | null = null
  private localChain: Promise<void> = Promise.resolve()
  private localPruneTimer: NodeJS.Timeout | null = null
  private ready = false
  private queue: QueuedDiagnostic[] = []
  private queuedBytes = 0
  private inFlight: { id: string; bytes: number; items: QueuedDiagnostic[] } | null = null
  private fallback: DiagnosticEvent[] = []
  private fallbackBytes = 0
  private dropped = 0
  private pendingDropped = 0
  private error: string | null = null
  private lastWriteAt: string | null = null
  private requests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private timer: NodeJS.Timeout | null = null
  private closing = false
  constructor(directory: string, workerEntry?: string | URL | null) {
    this.directory = directory
    if (workerEntry) {
      this.worker = new Worker(workerEntry, {
        workerData: { directory },
        resourceLimits: {
          maxOldGenerationSizeMb: 24,
          maxYoungGenerationSizeMb: 4
        }
      })
      this.worker.on('message', (message) => {
        if (message.kind === 'ready') {
          this.ready = true
          this.error = message.error ? sanitizeDiagnosticText(message.error) : null
          this.pump()
          return
        }
        if (message.id && this.inFlight && this.inFlight.id === message.id) {
          const batch = this.inFlight
          this.inFlight = null
          this.queuedBytes -= batch.bytes
          if (message.kind === 'failure') {
            this.dropped += batch.items.length
            this.pendingDropped += batch.items.length
            for (const item of batch.items) this.remember(item.event)
          } else {
            this.lastWriteAt = message.lastWriteAt
            this.error = null
          }
        }
        if (message.kind === 'failure') this.error = sanitizeDiagnosticText(message.error)
        const request = this.requests.get(message.id)
        if (request) {
          clearTimeout(request.timer)
          this.requests.delete(message.id)
          if (message.kind === 'failure')
            request.reject(new Error(this.error ?? 'Diagnostic writer failed'))
          else request.resolve(message.value)
        }
        if (!this.error) this.pump()
      })
      this.worker.on('error', (error) => this.failed(error))
      this.worker.on('exit', (code) => {
        if (!this.closing) this.failed(new Error(`Diagnostic writer exited (${code})`))
      })
      this.worker.unref()
      return
    }
    const store = new DiagnosticStore({ directory })
    this.localStore = store
    this.localChain = store.initialize().then(
      () => {
        this.ready = true
        this.error = null
        this.pump()
      },
      (error) => {
        this.ready = true
        this.error = sanitizeDiagnosticText(String(error))
        this.pump()
      }
    )
    this.localPruneTimer = setInterval(() => {
      if (this.closing) return
      this.localChain = this.localChain
        .catch(() => undefined)
        .then(() => store.prune())
        .catch((error) => {
          this.error = sanitizeDiagnosticText(String(error))
        })
    }, 60_000)
    this.localPruneTimer.unref()
  }
  private schedulePump(): void {
    if (this.closing || this.timer || !this.queue.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, 250)
    this.timer.unref()
  }
  record(event: DiagnosticEvent): void {
    const line = `${JSON.stringify(event)}\n`
    const bytes = Buffer.byteLength(line)
    const priority = event.level === 'error' || event.level === 'fatal' || event.level === 'warn'
    if (this.queuedBytes + bytes > DIAGNOSTICS_MAX_QUEUE_BYTES && priority) {
      for (
        let index = this.queue.length - 1;
        index >= 0 && this.queuedBytes + bytes > DIAGNOSTICS_MAX_QUEUE_BYTES;
        index--
      ) {
        if (!['debug', 'info'].includes(this.queue[index].event.level)) continue
        this.queuedBytes -= this.queue[index].bytes
        this.queue.splice(index, 1)
        this.dropped++
        this.pendingDropped++
      }
    }
    if (this.queuedBytes + bytes > DIAGNOSTICS_MAX_QUEUE_BYTES) {
      this.dropped++
      this.pendingDropped++
      if (priority) this.remember(event)
      return
    }
    if (priority) this.queue.unshift({ event, line, bytes })
    else this.queue.push({ event, line, bytes })
    this.queuedBytes += bytes
    if (!this.ready || this.error) this.remember(event)
    if (priority) queueMicrotask(() => this.pump())
    else this.schedulePump()
  }
  private remember(event: DiagnosticEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.fallback.push(event)
    this.fallbackBytes += bytes
    while (this.fallbackBytes > 1024 * 1024)
      this.fallbackBytes -= Buffer.byteLength(JSON.stringify(this.fallback.shift()))
  }
  private failed(error: Error): void {
    this.ready = false
    this.error = sanitizeDiagnosticText(error.message)
    if (this.inFlight) {
      this.dropped += this.inFlight.items.length
      this.pendingDropped += this.inFlight.items.length
      for (const item of this.inFlight.items) this.remember(item.event)
      this.queuedBytes -= this.inFlight.bytes
      this.inFlight = null
    }
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.requests.clear()
  }
  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.ready || this.inFlight || !this.queue.length) return
    const items: typeof this.queue = []
    let bytes = 0
    while (this.queue.length && bytes < 256 * 1024) {
      const item = this.queue.shift()!
      bytes += item.bytes
      items.push(item)
    }
    const id = randomUUID()
    this.inFlight = { id, bytes, items }
    if (this.localStore) {
      const store = this.localStore
      const lines = items.map((item) => item.line)
      const hadError = this.error !== null
      this.localChain = this.localChain
        .catch(() => undefined)
        .then(async () => {
          if (hadError) await store.initialize()
          await store.append(lines)
          const batch = this.inFlight
          this.inFlight = null
          if (batch) this.queuedBytes -= batch.bytes
          this.lastWriteAt = store.lastWriteAt
          this.error = null
          if (this.queue.length) this.schedulePump()
        })
        .catch((error) => {
          const batch = this.inFlight
          this.inFlight = null
          if (batch) {
            this.queuedBytes -= batch.bytes
            this.dropped += batch.items.length
            this.pendingDropped += batch.items.length
            for (const item of batch.items) this.remember(item.event)
          }
          const formatted =
            error instanceof Error
              ? `${(error as NodeJS.ErrnoException).code ?? 'WRITE_FAILED'}: ${error.message}`
              : String(error)
          this.error = sanitizeDiagnosticText(formatted)
        })
    } else if (this.worker) {
      try {
        this.worker.postMessage({ kind: 'write', id, lines: items.map((item) => item.line) })
      } catch (error) {
        this.failed(error as Error)
      }
    }
    if (this.pendingDropped) {
      const count = this.pendingDropped
      this.pendingDropped = 0
      writeDiagnostic('diagnostics', 'events.dropped', { count, total: this.dropped }, 'warn')
    }
  }
  private request(
    kind: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 2000
  ): Promise<any> {
    if (!this.ready) return Promise.reject(new Error(this.error ?? 'Diagnostic writer is starting'))
    if (this.localStore) {
      const store = this.localStore
      const run = this.localChain
        .catch(() => undefined)
        .then(async () => {
          if (kind === 'status') return { ...(await store.status()), error: this.error }
          if (kind === 'snapshot') return await store.snapshot(payload.destination as string)
          if (kind === 'clear') {
            await store.clearHistory()
            return await store.status()
          }
          if (kind === 'flush') {
            await store.flush()
            return undefined
          }
          throw new Error('Unknown diagnostic writer request')
        })
      this.localChain = run.then(
        () => undefined,
        () => undefined
      )
      return run
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`Diagnostic ${kind} timed out`))
      }, timeoutMs)
      this.requests.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ kind, id, ...payload })
    })
  }
  async flush(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while ((this.queue.length || this.inFlight || !this.ready) && Date.now() < deadline) {
      this.pump()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (this.queue.length || this.inFlight || !this.ready)
      throw new Error(this.error ?? 'Diagnostic flush timed out')
    await this.request('flush', {}, Math.max(1, deadline - Date.now()))
  }
  async status(): Promise<DiagnosticStatus> {
    const disk = await this.request('status').catch(() =>
      new DiagnosticStore({ directory: this.directory }).status()
    )
    return {
      enabled: true,
      level: 'debug',
      sessionId: diagnosticIdentity().sessionId,
      directory: this.directory,
      bytes: disk.bytes,
      files: disk.files,
      retentionDays: DIAGNOSTICS_RETENTION_DAYS,
      maxTotalBytes: DIAGNOSTICS_MAX_TOTAL_BYTES,
      queuedBytes: this.queuedBytes,
      droppedEvents: this.dropped,
      lastWriteAt: this.lastWriteAt,
      error: this.error ?? disk.error ?? null,
      warnings: utilityDiagnosticStatuses()
        .filter((state) => state.alive && state.journalUnavailable)
        .map((state) => `${state.role}: 原生日志写入异常，诊断包将注明缺失证据`)
    }
  }
  async snapshot(destination: string): Promise<{ files: any[]; missing: string[] }> {
    try {
      await this.flush()
      return await this.request('snapshot', { destination }, 10000)
    } catch {
      const saved = await new DiagnosticStore({ directory: this.directory }).snapshot(destination)
      return {
        ...saved,
        missing: [
          ...saved.missing,
          'writer unavailable: exported persisted files without writer acknowledgement'
        ]
      }
    }
  }
  async clearHistory(): Promise<void> {
    await this.flush()
    await this.request('clear')
  }
  memoryEvents(): DiagnosticEvent[] {
    return [...this.fallback]
  }
  emergency(event: DiagnosticEvent): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      const file = join(
        this.directory,
        `emergency-${process.pid}-${diagnosticIdentity().processInstanceId}.jsonl`
      )
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        /* New emergency segment. */
      }
      if (size >= 1024 * 1024) {
        this.remember(event)
        this.dropped++
        return
      }
      appendFileSync(
        join(
          this.directory,
          `emergency-${process.pid}-${diagnosticIdentity().processInstanceId}.jsonl`
        ),
        `${JSON.stringify(event)}\n`,
        'utf8'
      )
    } catch {
      this.remember(event)
    }
  }
  async close(): Promise<void> {
    this.closing = true
    try {
      await this.flush(2000)
    } catch {
      /* Status/fallback retain the failure. */
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.localPruneTimer) {
      clearInterval(this.localPruneTimer)
      this.localPruneTimer = null
    }
    if (this.worker) await this.worker.terminate()
  }
}
