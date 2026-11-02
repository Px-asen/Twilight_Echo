import { randomUUID } from 'crypto'
import { PlaylistRepairScanSession } from './playlistRepairScanSession.ts'
import type { RepairScanCall } from '../../shared/localLibraryScan.ts'
import { EventEmitter } from 'events'
import { createRequire } from 'module'
import {
  LibraryDatabaseScanSession,
  type DatabaseScanProgressListener
} from './libraryDatabaseScanSession.ts'
import type { LibraryScanCommit, LibraryScanDatabaseApi } from '../../shared/libraryDatabase.ts'
import type {
  LocalLibraryScanBatch,
  LocalLibraryFileIdentity,
  LocalLibraryScanIdentityBatch,
  LocalLibraryScanProgress,
  LocalLibraryScanWorkerMessage,
  LocalLibraryScanWorkerRequest,
  LocalLibraryWorkerScanRequest,
  LocalLibraryWorkerScanResult
} from '../../shared/localLibraryScan.ts'

const require = createRequire(import.meta.url)

type UtilityProcessLike = {
  postMessage: (message: LocalLibraryScanWorkerRequest) => void
  kill: () => void
  on: (
    event: 'message' | 'exit' | 'error',
    listener:
      | ((message: LocalLibraryScanWorkerMessage) => void)
      | ((code: number | null) => void)
      | ((error: unknown, location?: string) => void)
  ) => void
}

type ElectronModule = {
  utilityProcess?: {
    fork: (
      modulePath: string,
      args?: string[],
      options?: { serviceName?: string; stdio?: 'pipe' }
    ) => UtilityProcessLike
  }
}

type PendingScan = {
  resolve: (result: LocalLibraryWorkerScanResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void
  onBatch?: (batch: LocalLibraryScanBatch) => void
  onIdentityBatch?: (batch: LocalLibraryScanIdentityBatch) => void
  onAttemptReset?: () => void
  watchdog: NodeJS.Timeout | null
  request: LocalLibraryWorkerScanRequest
  lastFilePaths: string[]
  restartCount: number
  restarting: boolean
  paused: boolean
  identities: LocalLibraryFileIdentity[]
  completedFilePaths: Set<string>
  parsedFileCount: number
}

export interface LocalLibraryScanRunner {
  scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void,
    onBatch?: (batch: LocalLibraryScanBatch) => void,
    onIdentityBatch?: (batch: LocalLibraryScanIdentityBatch) => void,
    onAttemptReset?: () => void
  ): Promise<LocalLibraryWorkerScanResult>
  pause(requestId: string): void
  resume(requestId: string): void
  cancel(requestId: string): void
  destroy(): void
}

export interface LocalLibraryScanServiceClientOptions {
  serviceEntry: string
  startupTimeoutMs?: number
  scanWatchdogMs?: number
  /**
   * The worker is killed after this long with no scan in flight so the
   * music-metadata process does not stay resident between scans. The next
   * scan forks it again transparently.
   */
  idleTimeoutMs?: number
  electron?: ElectronModule
  launch?: () => UtilityProcessLike
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_SCAN_WATCHDOG_MS = 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 15_000
const MAX_SCAN_WORKER_RESTARTS = 3

export class LocalLibraryScanServiceClient extends EventEmitter implements LocalLibraryScanRunner {
  private readonly options: LocalLibraryScanServiceClientOptions
  private readonly scanWatchdogMs: number
  private readonly idleTimeoutMs: number
  private idleTimer: NodeJS.Timeout | null = null
  private child: UtilityProcessLike | null = null
  private readyPromise: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private readonly pending = new Map<string, PendingScan>()
  private databaseSession: LibraryDatabaseScanSession | null = null
  private databaseReservation: { jobId: string; paused: boolean } | null = null
  private repairSession: PlaylistRepairScanSession | null = null
  private startingScans = 0
  private stopped = false
  private unavailableError = ''
  private cacheBarrier: Promise<void> | null = null
  private cacheControl: {
    id: string
    state: 'suspended' | 'running'
    resolve(): void
    reject(error: Error): void
  } | null = null

  constructor(options: LocalLibraryScanServiceClientOptions) {
    super()
    this.options = options
    this.scanWatchdogMs =
      typeof options.scanWatchdogMs === 'number' && Number.isFinite(options.scanWatchdogMs)
        ? Math.max(100, Math.floor(options.scanWatchdogMs))
        : DEFAULT_SCAN_WATCHDOG_MS
    this.idleTimeoutMs =
      typeof options.idleTimeoutMs === 'number' && Number.isFinite(options.idleTimeoutMs)
        ? Math.max(1, Math.floor(options.idleTimeoutMs))
        : DEFAULT_IDLE_TIMEOUT_MS
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (
      this.stopped ||
      !this.child ||
      this.pending.size > 0 ||
      this.databaseReservation ||
      this.databaseSession ||
      this.repairSession ||
      this.cacheBarrier
    )
      return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.stopped || this.pending.size > 0 || this.databaseSession || this.repairSession)
        return
      this.detachChild()
    }, this.idleTimeoutMs)
  }

  async scan(
    jobId: string,
    request: LocalLibraryWorkerScanRequest,
    onProgress?: (progress: Omit<LocalLibraryScanProgress, 'jobId' | 'mode'>) => void,
    onBatch?: (batch: LocalLibraryScanBatch) => void,
    onIdentityBatch?: (batch: LocalLibraryScanIdentityBatch) => void,
    onAttemptReset?: () => void
  ): Promise<LocalLibraryWorkerScanResult> {
    if (this.repairSession) throw new Error('A repair is already using the metadata process')
    this.clearIdleTimer()
    await this.waitForScanStartup()
    if (this.databaseReservation || this.databaseSession || this.repairSession)
      throw new Error('A SQLite scan or repair is already using the metadata process')
    const child = this.child
    if (!child)
      throw new Error(this.unavailableError || 'local library scan service is unavailable')
    const requestId = jobId || randomUUID()
    return await new Promise<LocalLibraryWorkerScanResult>((resolve, reject) => {
      const pending: PendingScan = {
        resolve,
        reject,
        onProgress,
        onBatch,
        onIdentityBatch,
        onAttemptReset,
        watchdog: null,
        request,
        lastFilePaths: [],
        restartCount: 0,
        restarting: false,
        paused: false,
        identities: [],
        completedFilePaths: new Set(),
        parsedFileCount: 0
      }
      this.pending.set(requestId, pending)
      this.sendPendingScan(requestId, pending, child)
    })
  }

  pause(requestId: string): void {
    if (this.databaseReservation?.jobId === requestId) {
      this.databaseReservation.paused = true
      if (!this.databaseSession) return
    }
    if (this.databaseSession?.jobId === requestId) this.databaseSession.pause()
    const pending = this.pending.get(requestId)
    if (pending) {
      pending.paused = true
      if (pending.watchdog) clearTimeout(pending.watchdog)
      pending.watchdog = null
    }
    this.sendControl({ kind: 'pause', requestId })
  }

  resume(requestId: string): void {
    if (this.databaseReservation?.jobId === requestId) {
      this.databaseReservation.paused = false
      if (!this.databaseSession) return
    }
    if (this.databaseSession?.jobId === requestId) this.databaseSession.resume()
    const pending = this.pending.get(requestId)
    if (pending) {
      pending.paused = false
      this.armWatchdog(requestId, pending)
    }
    this.sendControl({ kind: 'resume', requestId })
  }

  cancel(requestId: string): void {
    if (this.databaseSession?.jobId === requestId) {
      this.databaseSession.cancel()
      return
    }
    this.sendControl({ kind: 'cancel', requestId })
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.clearPending(requestId, pending)
    this.rejectPendingExcept(
      null,
      new Error('local library scan service was stopped for cancellation')
    )
    this.detachChild()
    pending.resolve(createCancelledScanResult(pending.request.mode))
  }

  destroy(): void {
    this.stopped = true
    this.databaseSession?.fail(new Error('local library scan service stopped'))
    this.repairSession?.fail(new Error('local library scan service stopped'))
    this.clearIdleTimer()
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    const error = new Error('local library scan service stopped')
    this.cacheControl?.reject(error)
    this.rejectReady?.(error)
    this.rejectReady = null
    this.resolveReady = null
    for (const [requestId, pending] of this.pending) {
      this.clearPending(requestId, pending)
      pending.reject(error)
    }
    this.pending.clear()
    try {
      this.child?.kill()
    } catch {
      // The process is already gone.
    }
    this.child = null
  }

  private start(): boolean {
    if (this.stopped) return false
    if (this.child || this.readyPromise) return true
    const electron = this.options.launch
      ? undefined
      : (this.options.electron ?? (require('electron') as ElectronModule))
    if (!this.options.launch && !electron?.utilityProcess) {
      this.unavailableError = 'Electron utilityProcess is unavailable for local library scanning'
      return false
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    try {
      const child = this.options.launch
        ? this.options.launch()
        : electron!.utilityProcess!.fork(this.options.serviceEntry, [], {
            serviceName: 'twilight-local-library-scan',
            stdio: 'pipe'
          })
      this.child = child
      child.on('message', (message) => {
        if (this.child !== child) return
        this.handleMessage(message as LocalLibraryScanWorkerMessage)
      })
      child.on('error', (error) => {
        if (this.child !== child) return
        this.handleExit(error instanceof Error ? error.message : String(error))
      })
      child.on('exit', (code) => {
        if (this.child !== child) return
        this.handleExit(`local library scan service exited (${code ?? 'unknown'})`)
      })
      this.startupTimer = setTimeout(() => {
        this.handleExit('local library scan service startup timed out')
      }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
      return true
    } catch (error) {
      this.handleExit(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  private async waitUntilReady(): Promise<void> {
    while (this.cacheBarrier) await this.cacheBarrier
    if (!this.readyPromise && !this.child && !this.unavailableError) this.start()
    if (this.unavailableError) throw new Error(this.unavailableError)
    await this.readyPromise
    while (this.cacheBarrier) await this.cacheBarrier
  }
  private async waitForScanStartup(): Promise<void> {
    this.startingScans++
    try {
      await this.waitUntilReady()
    } finally {
      this.startingScans--
    }
  }

  private handleMessage(message: LocalLibraryScanWorkerMessage): void {
    if (message.kind === 'cache-ready') {
      if (this.cacheControl?.id === message.requestId && this.cacheControl.state === message.state)
        this.cacheControl.resolve()
      return
    }
    if (message.kind === 'ready') {
      if (this.startupTimer) clearTimeout(this.startupTimer)
      this.startupTimer = null
      this.resolveReady?.()
      this.resolveReady = null
      this.rejectReady = null
      this.emit('ready')
      for (const [requestId, pending] of this.pending) {
        if (!pending.restarting) continue
        pending.restarting = false
        this.sendPendingScan(requestId, pending, this.child)
      }
      return
    }
    if (this.repairSession) {
      this.repairSession.handle(message)
      return
    }
    if (message.kind.startsWith('repair-')) return
    if (this.databaseSession) {
      this.databaseSession.handle(message)
      return
    }
    if (message.kind.startsWith('database-')) return
    if (message.kind === 'progress') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.touchWatchdog(pending)
      pending.onProgress?.(message.progress)
      return
    }
    if (message.kind === 'activity') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      pending.lastFilePaths = message.activity.filePaths
      this.touchWatchdog(pending)
      return
    }
    if (message.kind === 'batch') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.touchWatchdog(pending)
      for (const filePath of message.batch.parsedFilePaths) pending.completedFilePaths.add(filePath)
      for (const update of message.batch.releaseDateUpdates ?? [])
        pending.completedFilePaths.add(update.filePath)
      const trackPaths = new Set(
        message.batch.parsedTracks.flatMap((track) =>
          track &&
          typeof track === 'object' &&
          'filePath' in track &&
          typeof track.filePath === 'string'
            ? [track.filePath]
            : []
        )
      )
      pending.parsedFileCount += trackPaths.size + (message.batch.releaseDateUpdates?.length ?? 0)
      pending.onBatch?.(message.batch)
      return
    }
    if (message.kind === 'identity-batch') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.touchWatchdog(pending)
      pending.identities.push(...message.batch.identities)
      pending.onIdentityBatch?.(message.batch)
      return
    }
    if (message.kind !== 'response') return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.clearPending(message.requestId, pending)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error))
  }

  private sendPendingScan(
    requestId: string,
    pending: PendingScan,
    child: UtilityProcessLike | null
  ): void {
    if (!child) {
      pending.restarting = true
      return
    }
    this.armWatchdog(requestId, pending)
    try {
      child.postMessage({ kind: 'scan', requestId, request: pending.request })
      if (pending.paused) child.postMessage({ kind: 'pause', requestId })
    } catch (error) {
      this.clearPending(requestId, pending)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private armWatchdog(requestId: string, pending: PendingScan): void {
    if (pending.watchdog) clearTimeout(pending.watchdog)
    if (pending.paused || this.cacheBarrier) return
    pending.watchdog = setTimeout(() => {
      if (this.pending.get(requestId) !== pending) return
      const skippedPaths = Array.from(new Set(pending.lastFilePaths))
      if (skippedPaths.length === 0 || pending.restartCount >= MAX_SCAN_WORKER_RESTARTS) {
        this.clearPending(requestId, pending)
        const error = new Error(
          `local library scan worker stopped responding after ${this.scanWatchdogMs}ms`
        )
        this.rejectPendingExcept(null, error)
        this.detachChild()
        pending.reject(error)
        this.emit('service-error', error)
        return
      }

      pending.restartCount += 1
      pending.restarting = true
      const canResume =
        pending.request.streamResults === true &&
        pending.identities.length > 0 &&
        (pending.request.mode !== 'watch' ||
          !pending.request.changes?.length ||
          pending.request.changes.some((change) => change.kind === 'reconcile'))
      if (!canResume) {
        pending.onAttemptReset?.()
        pending.identities = []
        pending.completedFilePaths.clear()
        pending.parsedFileCount = 0
      }
      pending.lastFilePaths = []
      pending.request = {
        ...pending.request,
        skipParsePaths: Array.from(
          new Set([...(pending.request.skipParsePaths ?? []), ...skippedPaths])
        ),
        ...(canResume
          ? {
              resumeCheckpoint: {
                identities: pending.identities,
                completeIdentitySnapshot:
                  pending.request.mode !== 'watch' ||
                  !pending.request.changes?.length ||
                  pending.request.changes.some((change) => change.kind === 'reconcile'),
                completedFilePaths: Array.from(pending.completedFilePaths),
                parsedFileCount: pending.parsedFileCount
              }
            }
          : {})
      }
      this.rejectPendingExcept(requestId, new Error('local library scan service is restarting'))
      if (pending.watchdog) clearTimeout(pending.watchdog)
      pending.watchdog = null
      this.detachChild()
      if (!this.start() && this.pending.get(requestId) === pending) {
        this.clearPending(requestId, pending)
        const error = new Error(
          this.unavailableError || 'local library scan service is unavailable after restart'
        )
        pending.reject(error)
        this.emit('service-error', error)
      }
    }, this.scanWatchdogMs)
  }

  private touchWatchdog(pending: PendingScan): void {
    for (const [requestId, candidate] of this.pending) {
      if (candidate !== pending) continue
      this.armWatchdog(requestId, pending)
      return
    }
  }

  private detachChild(): void {
    this.cacheControl?.reject(new Error('Scan process detached during cache maintenance'))
    this.clearIdleTimer()
    const child = this.child
    this.child = null
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.readyPromise = null
    this.resolveReady = null
    this.rejectReady = null
    this.unavailableError = ''
    try {
      child?.kill()
    } catch {
      // The process is already gone.
    }
  }

  private clearPending(requestId: string, pending: PendingScan): void {
    if (this.pending.get(requestId) !== pending) return
    this.pending.delete(requestId)
    if (pending.watchdog) clearTimeout(pending.watchdog)
    pending.watchdog = null
    if (this.pending.size === 0) this.armIdleTimer()
  }

  private rejectPendingExcept(requestId: string | null, error: Error): void {
    for (const [candidateId, pending] of this.pending) {
      if (candidateId === requestId) continue
      this.clearPending(candidateId, pending)
      pending.reject(error)
    }
  }

  private handleExit(reason: string): void {
    if (this.stopped || (!this.child && !this.readyPromise)) return
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    const error = new Error(reason)
    this.cacheControl?.reject(error)
    this.databaseSession?.fail(error)
    this.repairSession?.fail(error)
    this.rejectReady?.(error)
    this.rejectReady = null
    this.resolveReady = null
    for (const [requestId, pending] of this.pending) {
      this.clearPending(requestId, pending)
      pending.reject(error)
    }
    this.pending.clear()
    this.child = null
    this.readyPromise = null
    this.unavailableError = ''
    this.emit('service-error', error)
  }

  async scanDatabase(
    jobId: string,
    coverCacheDir: string,
    database: LibraryScanDatabaseApi,
    onProgress?: DatabaseScanProgressListener,
    prepareBatch?: (batch: LibraryScanCommit) => Promise<LibraryScanCommit>,
    signal?: AbortSignal,
    forceParse = false
  ) {
    if (
      this.repairSession ||
      this.databaseReservation ||
      this.databaseSession ||
      this.pending.size ||
      this.startingScans
    )
      throw new Error('The metadata process is already scanning')
    if (signal?.aborted) throw new Error('SQLite scan was cancelled before worker startup')
    this.clearIdleTimer()
    // Reserve before startup yields so controls cannot overtake scan-database.
    const reservation = { jobId, paused: false }
    this.databaseReservation = reservation
    try {
      const cancelStartup = () => {
        this.rejectReady?.(new Error('SQLite scan was cancelled before worker startup'))
        this.detachChild()
      }
      signal?.addEventListener('abort', cancelStartup, { once: true })
      try {
        await this.waitForScanStartup()
      } finally {
        signal?.removeEventListener('abort', cancelStartup)
      }
      if (signal?.aborted) throw new Error('SQLite scan was cancelled before worker startup')
      if (!this.child || this.pending.size || this.databaseSession || this.repairSession)
        throw new Error('The metadata process is unavailable or already scanning')
      const session = new LibraryDatabaseScanSession(
        jobId,
        database,
        (request) => {
          if (!this.child) throw new Error('Scan process is unavailable')
          this.child.postMessage(request)
        },
        () => this.detachChild(),
        this.scanWatchdogMs,
        onProgress,
        prepareBatch
      )
      this.databaseSession = session
      if (reservation.paused) session.pause()
      const abort = () => session.cancel()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        try {
          this.child.postMessage({
            kind: 'scan-database',
            requestId: jobId,
            coverCacheDir,
            forceParse
          })
          if (reservation.paused) this.sendControl({ kind: 'pause', requestId: jobId })
        } catch (error) {
          session.fail(error)
        }
        return await session.result
      } finally {
        signal?.removeEventListener('abort', abort)
        if (this.databaseSession === session) this.databaseSession = null
      }
    } finally {
      if (this.databaseReservation === reservation) this.databaseReservation = null
      this.armIdleTimer()
    }
  }

  async scanRepair(
    id: string,
    root: string,
    coverCacheDir: string,
    processCall: (call: RepairScanCall) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      this.pending.size ||
      this.databaseReservation ||
      this.databaseSession ||
      this.repairSession ||
      this.startingScans
    )
      throw new Error('The metadata process is already scanning')
    this.clearIdleTimer()
    const session = new PlaylistRepairScanSession(
      id,
      (message) => {
        if (!this.child) throw new Error('Scan process is unavailable')
        this.child.postMessage(message)
      },
      () => this.detachChild(),
      processCall,
      this.scanWatchdogMs
    )
    this.repairSession = session // Reserve before worker startup yields.
    session.setCacheSuspended(this.cacheBarrier !== null)
    const abort = () => session.fail(new Error('歌单修复已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      try {
        await Promise.race([this.waitUntilReady(), session.result])
        if (signal?.aborted) abort()
        else if (!this.child) session.fail(new Error('Scan process is unavailable'))
        else this.child.postMessage({ kind: 'scan-repair', requestId: id, root, coverCacheDir })
      } catch (error) {
        session.fail(error)
      }
      await session.result
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.repairSession === session) this.repairSession = null
      this.armIdleTimer()
    }
  }

  private sendControl(
    message: Extract<LocalLibraryScanWorkerRequest, { kind: 'pause' | 'resume' | 'cancel' }>
  ): void {
    try {
      this.child?.postMessage(message)
    } catch {
      // The request will fail through the active scan promise when the child exits.
    }
  }

  /** ACK only after actual cover writers drain; new scans wait without spawning
   * a worker. Deliberate cache maintenance is independent of the user's Pause. */
  async maintainCoverCache<T>(action: () => Promise<T>): Promise<T> {
    if (this.cacheBarrier) throw new Error('Scan cover maintenance is already running')
    if (this.stopped) throw new Error('local library scan service stopped')
    let release!: () => void
    this.cacheBarrier = new Promise((resolve) => {
      release = resolve
    })
    this.clearIdleTimer()
    this.databaseSession?.setCacheSuspended(true)
    this.repairSession?.setCacheSuspended(true)
    for (const [id, pending] of this.pending) this.armWatchdog(id, pending)
    let child: UtilityProcessLike | null = null
    const id = randomUUID()
    try {
      // Join an existing startup only. The local barrier excludes later starts.
      await this.readyPromise
      child = this.child
      if (child) await this.controlCovers(child, id, 'suspended')
      return await action()
    } finally {
      try {
        if (child && this.child === child) await this.controlCovers(child, id, 'running')
      } finally {
        this.cacheBarrier = null
        release()
        this.databaseSession?.setCacheSuspended(false)
        this.repairSession?.setCacheSuspended(false)
        for (const [id, pending] of this.pending) this.armWatchdog(id, pending)
        this.armIdleTimer()
      }
    }
  }
  private controlCovers(
    child: UtilityProcessLike,
    id: string,
    state: 'suspended' | 'running'
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.cacheControl = null
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () => finish(new Error('Scan cover maintenance acknowledgement timed out')),
        this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
      )
      this.cacheControl = { id, state, resolve: () => finish(), reject: finish }
      try {
        child.postMessage({
          kind: state === 'suspended' ? 'cache-suspend' : 'cache-resume',
          requestId: id
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

function createCancelledScanResult(
  mode: LocalLibraryWorkerScanRequest['mode']
): LocalLibraryWorkerScanResult {
  return {
    mode,
    completeIdentitySnapshot: false,
    identities: [],
    parsedTracks: [],
    parsedFilePaths: [],
    removedFilePaths: [],
    skippedUnchanged: 0,
    parsedFileCount: 0,
    cancelled: true
  }
}
