import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { createRequire } from 'module'

import {
  AUDIO_ANALYSIS_PROTOCOL_VERSION,
  type AudioAnalysisKind,
  type AudioAnalysisWorkerRequest
} from '../shared/audioAnalysisContract.ts'
import { isBpmAnalysisResult, type BpmAnalysisResult } from './bpm/bpmCache.ts'
import { tryParseJsonWithNestingLimit } from './security/jsonSafety.ts'
import {
  asUtilityProcessMessageRecord,
  inspectUtilityProcessMessage,
  inspectUtilityProcessPayload,
  isBoundedUtf8String,
  parseUtilityProcessResponse,
  UtilityProcessLogBudget,
  MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES,
  MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES
} from './security/utilityProcessSafety.ts'
import { isLoudnessAnalysisResult, type LoudnessAnalysisResult } from './audio/loudnessCache.ts'
import {
  isLoudnessGroupMeasurement,
  type LoudnessGroupMeasurement,
  type LoudnessInputGroup
} from '../shared/libraryLoudness.ts'

const require = createRequire(import.meta.url)

type UtilityProcessLike = {
  postMessage: (message: AudioAnalysisWorkerRequest) => void
  kill: () => void
  on: (
    event: 'message' | 'exit' | 'error',
    listener:
      | ((message: unknown) => void)
      | ((code: number | null) => void)
      | ((error: unknown, location?: string) => void)
  ) => void
  stdout?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void }
  stderr?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void }
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

type AnalysisTask = {
  id: string
  analysis: AudioAnalysisKind
  source: string
  optionsJson: string
  priority: number
  timeoutMs: number
  sequence: number
  queuedAt: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

type AnalysisWorker = {
  slot: number
  child: UtilityProcessLike | null
  ready: boolean
  taskId: string | null
  startupTimer: NodeJS.Timeout | null
  restartTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  startupFailures: number
  disabled: boolean
  logBudget: UtilityProcessLogBudget
}

export interface AudioAnalysisServiceClientOptions {
  serviceEntry: string
  maxConcurrency?: number
  /** Maximum waiting tasks; active workers are bounded separately by maxConcurrency. */
  maxQueueSize?: number
  taskTimeoutMs?: number
  /** Maximum time a task may wait before worker assignment. */
  queueTimeoutMs?: number
  /** Waiting time required to add one effective priority point. */
  agingIntervalMs?: number
  startupTimeoutMs?: number
  restartDelayMs?: number
  maxStartupFailures?: number
  /**
   * Idle workers are killed after this long without a task so an analysis
   * burst does not leave a pool of utility processes resident for the rest
   * of the session. Workers are re-forked lazily on the next request.
   */
  idleTimeoutMs?: number
  now?: () => number
  electron?: ElectronModule
}

export interface AudioAnalysisRequestOptions {
  priority?: number
  /** Per-task worker deadline; whole-file analyses override the short default. */
  timeoutMs?: number
}

export interface AudioAnalysisServiceStatus {
  active: number
  queued: number
  readyWorkers: number
  /** Workers currently forked (ready or still starting). */
  liveWorkers: number
  maxConcurrency: number
  maxQueueSize: number
  lastError: string
}

type AudioAnalysisError = Error & { code?: string }

const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000
const MAX_TASK_TIMEOUT_MS = (14_400 + 120) * 1000
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_AGING_INTERVAL_MS = 1000
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_RESTART_DELAY_MS = 250
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CONCURRENCY = 1
const DEFAULT_MAX_QUEUE_SIZE = 32
const DEFAULT_MAX_STARTUP_FAILURES = 3
const MAX_AUDIO_ANALYSIS_RESPONSE_BYTES = 512 * 1024
const AUDIO_ANALYSIS_INVALID_RESPONSE_CODE = 'ERR_AUDIO_ANALYSIS_INVALID_RESPONSE'
const AUDIO_ANALYSIS_INVALID_RESPONSE =
  'audio analysis worker returned an invalid or oversized message'

export class AudioAnalysisServiceClient extends EventEmitter {
  private readonly options: AudioAnalysisServiceClientOptions
  private readonly maxConcurrency: number
  private readonly maxQueueSize: number
  private readonly taskTimeoutMs: number
  private readonly queueTimeoutMs: number
  private readonly agingIntervalMs: number
  private readonly startupTimeoutMs: number
  private readonly restartDelayMs: number
  private readonly maxStartupFailures: number
  private readonly idleTimeoutMs: number
  private readonly now: () => number
  private readonly workers: AnalysisWorker[]
  private readonly queued: AnalysisTask[] = []
  private readonly active = new Map<string, AnalysisTask>()
  private sequence = 0
  private stopped = false
  private unavailableError = ''
  private lastError = ''
  private queueMaintenanceTimer: NodeJS.Timeout | null = null
  private queueMaintenanceDueAt = 0

  constructor(options: AudioAnalysisServiceClientOptions) {
    super()
    this.options = options
    this.maxConcurrency = clampInteger(options.maxConcurrency, 1, 4, DEFAULT_MAX_CONCURRENCY)
    this.maxQueueSize = clampInteger(options.maxQueueSize, 1, 512, DEFAULT_MAX_QUEUE_SIZE)
    this.taskTimeoutMs = clampInteger(
      options.taskTimeoutMs,
      100,
      60 * 60 * 1000,
      DEFAULT_TASK_TIMEOUT_MS
    )
    this.queueTimeoutMs = clampInteger(
      options.queueTimeoutMs,
      100,
      60 * 60 * 1000,
      DEFAULT_QUEUE_TIMEOUT_MS
    )
    this.agingIntervalMs = clampInteger(
      options.agingIntervalMs,
      100,
      60 * 1000,
      DEFAULT_AGING_INTERVAL_MS
    )
    this.startupTimeoutMs = clampInteger(
      options.startupTimeoutMs,
      100,
      60_000,
      DEFAULT_STARTUP_TIMEOUT_MS
    )
    this.restartDelayMs = clampInteger(options.restartDelayMs, 0, 30_000, DEFAULT_RESTART_DELAY_MS)
    this.idleTimeoutMs = clampInteger(
      options.idleTimeoutMs,
      1,
      60 * 60 * 1000,
      DEFAULT_IDLE_TIMEOUT_MS
    )
    this.maxStartupFailures = clampInteger(
      options.maxStartupFailures,
      1,
      100,
      DEFAULT_MAX_STARTUP_FAILURES
    )
    this.now = options.now ?? Date.now
    this.workers = Array.from({ length: this.maxConcurrency }, (_, slot) => ({
      slot,
      child: null,
      ready: false,
      taskId: null,
      startupTimer: null,
      restartTimer: null,
      idleTimer: null,
      startupFailures: 0,
      disabled: false,
      logBudget: new UtilityProcessLogBudget()
    }))
  }

  async analyzeLoudnessGroup(group: LoudnessInputGroup): Promise<LoudnessGroupMeasurement> {
    const value = parseAnalysisJson(
      await this.request(
        'loudness-batch',
        group.tracks[0].filePath,
        JSON.stringify({
          segments: group.tracks.map((track) => ({
            source: track.filePath,
            startSeconds: track.cueRange?.startSeconds ?? 0,
            endSeconds: track.cueRange?.endSeconds ?? 0
          })),
          album: group.mode === 'album'
        }),
        { priority: -20, timeoutMs: MAX_TASK_TIMEOUT_MS }
      ),
      'loudness batch'
    )
    if (!isLoudnessGroupMeasurement(value))
      throw new Error(analysisErrorMessage(value, '原生引擎不支持批量响度测量，请更新引擎'))
    if (
      value.tracks.length !== group.tracks.length ||
      (group.mode === 'album' && value.album === null)
    )
      throw new Error('专辑响度测量不完整')
    return value
  }

  async analyzeDspAudition(
    source: string,
    optionsJson: string
  ): Promise<import('../shared/dspAudition.ts').DspAuditionMeasurement> {
    const value = parseAnalysisJson(
      await this.request('dsp-audition', source, optionsJson, { priority: 10 }),
      'processed loudness'
    )
    if (
      !isLoudnessAnalysisResult(value) ||
      (value as { processingVersion?: number }).processingVersion !== 1
    )
      throw new Error(analysisErrorMessage(value, '处理后测量不可用，请更新原生引擎'))
    return value as LoudnessAnalysisResult & { processingVersion: number }
  }

  async analyzeBpm(
    source: string,
    optionsJson: string,
    options: AudioAnalysisRequestOptions = {}
  ): Promise<BpmAnalysisResult> {
    const value = parseAnalysisJson(await this.request('bpm', source, optionsJson, options), 'BPM')
    if (!isBpmAnalysisResult(value)) {
      throw new Error(
        analysisErrorMessage(value, 'audio analysis worker returned invalid BPM data')
      )
    }
    return value
  }

  async analyzeLoudness(
    source: string,
    optionsJson: string,
    options: AudioAnalysisRequestOptions = {}
  ): Promise<LoudnessAnalysisResult> {
    const value = parseAnalysisJson(
      await this.request('loudness', source, optionsJson, options),
      'loudness'
    )
    if (isLoudnessAnalysisResult(value)) return value
    if (
      value &&
      typeof value === 'object' &&
      (value as { available?: unknown }).available === false
    ) {
      return {
        integratedLufs: 0,
        truePeakDb: 0,
        source: 'analyzed',
        analyzedAt: new Date().toISOString(),
        algorithmVersion: 1,
        available: false
      }
    }
    throw new Error(
      analysisErrorMessage(value, 'audio analysis worker returned invalid loudness data')
    )
  }

  cancelBySource(source: string, analysis?: AudioAnalysisKind): number {
    const normalized = source.trim()
    if (!normalized) return 0
    let cancelled = this.cancelQueued(
      (task) => task.source === normalized && (!analysis || task.analysis === analysis)
    )
    for (const worker of this.workers) {
      const task = worker.taskId ? this.active.get(worker.taskId) : undefined
      if (!task || task.source !== normalized || (analysis && task.analysis !== analysis)) continue
      cancelled += 1
      this.terminateWorker(
        worker,
        createAnalysisError('ERR_AUDIO_ANALYSIS_CANCELLED', `analysis cancelled: ${normalized}`),
        true
      )
    }
    return cancelled
  }

  cancelAll(analysis?: AudioAnalysisKind): number {
    let cancelled = this.cancelQueued((task) => !analysis || task.analysis === analysis)
    for (const worker of this.workers) {
      const task = worker.taskId ? this.active.get(worker.taskId) : undefined
      if (!task || (analysis && task.analysis !== analysis)) continue
      cancelled += 1
      this.terminateWorker(
        worker,
        createAnalysisError('ERR_AUDIO_ANALYSIS_CANCELLED', 'analysis cancelled'),
        true
      )
    }
    return cancelled
  }

  getStatus(): AudioAnalysisServiceStatus {
    this.expireQueuedTasks(this.now())
    this.pump()
    return {
      active: this.active.size,
      queued: this.queued.length,
      readyWorkers: this.workers.filter((worker) => worker.ready).length,
      liveWorkers: this.workers.filter((worker) => worker.child).length,
      maxConcurrency: this.maxConcurrency,
      maxQueueSize: this.maxQueueSize,
      lastError: this.lastError
    }
  }

  destroy(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearQueueMaintenanceTimer()
    this.cancelQueued(() => true, 'audio analysis service stopped')
    for (const worker of this.workers) {
      if (worker.restartTimer) clearTimeout(worker.restartTimer)
      worker.restartTimer = null
      this.clearIdleTimer(worker)
      this.terminateWorker(
        worker,
        createAnalysisError('ERR_AUDIO_ANALYSIS_STOPPED', 'audio analysis service stopped'),
        false
      )
    }
  }

  private request(
    analysis: AudioAnalysisKind,
    source: string,
    optionsJson: string,
    options: AudioAnalysisRequestOptions
  ): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(
        createAnalysisError('ERR_AUDIO_ANALYSIS_STOPPED', 'audio analysis service stopped')
      )
    }
    if (this.unavailableError) {
      return Promise.reject(
        createAnalysisError('ERR_AUDIO_ANALYSIS_UNAVAILABLE', this.unavailableError)
      )
    }
    const normalizedSource = source.trim()
    if (!normalizedSource) return Promise.reject(new Error('audio analysis source is empty'))
    const now = this.now()
    this.expireQueuedTasks(now)
    return new Promise((resolve, reject) => {
      const task: AnalysisTask = {
        id: randomUUID(),
        analysis,
        source: normalizedSource,
        optionsJson: optionsJson || '{}',
        priority: clampInteger(options.priority, -100, 100, 0),
        timeoutMs: clampInteger(options.timeoutMs, 1000, MAX_TASK_TIMEOUT_MS, this.taskTimeoutMs),
        sequence: this.sequence++,
        queuedAt: now,
        resolve,
        reject,
        timer: null
      }
      if (!this.admitTask(task, now)) return
      this.ensureWorkerCapacity()
      if (this.unavailableError) return
      this.scheduleQueueMaintenance(now)
      this.pump()
    })
  }

  /**
   * Forks only as many workers as the current demand needs. A single
   * loudness request must not fan out into a full pool of resident
   * processes; further workers start when more tasks are waiting.
   */
  private ensureWorkerCapacity(): void {
    if (this.stopped || this.unavailableError) return
    const demand = this.queued.length + this.active.size
    let capacity = this.workers.filter((worker) => worker.child || worker.restartTimer).length
    for (const worker of this.workers) {
      if (capacity >= demand) break
      if (worker.child || worker.restartTimer || worker.disabled) continue
      this.startWorker(worker)
      if (worker.child) capacity += 1
    }
  }

  private clearIdleTimer(worker: AnalysisWorker): void {
    if (worker.idleTimer) clearTimeout(worker.idleTimer)
    worker.idleTimer = null
  }

  private armIdleTimer(worker: AnalysisWorker): void {
    this.clearIdleTimer(worker)
    if (this.stopped || !worker.child || worker.taskId) return
    worker.idleTimer = setTimeout(() => {
      worker.idleTimer = null
      if (this.stopped || !worker.child || worker.taskId) return
      if (this.queued.length > 0) {
        this.pump()
        return
      }
      this.releaseIdleWorker(worker)
    }, this.idleTimeoutMs)
  }

  /** Kills an idle worker without treating it as a failure; the slot is re-forked on demand. */
  private releaseIdleWorker(worker: AnalysisWorker): void {
    const child = worker.child
    worker.child = null
    worker.ready = false
    worker.taskId = null
    if (worker.startupTimer) clearTimeout(worker.startupTimer)
    worker.startupTimer = null
    this.clearIdleTimer(worker)
    try {
      child?.kill()
    } catch {
      // The process already exited; the detached identity ignores its late events.
    }
  }

  private startWorker(worker: AnalysisWorker): void {
    if (this.stopped || this.unavailableError || worker.disabled || worker.child) return
    const electron = this.options.electron ?? resolveElectron()
    if (!electron?.utilityProcess) {
      this.unavailableError = 'current runtime does not support Electron utilityProcess'
      this.lastError = this.unavailableError
      this.rejectQueuedUnavailable()
      return
    }
    try {
      const child = electron.utilityProcess.fork(this.options.serviceEntry, [], {
        serviceName: `twilight-audio-analysis-${worker.slot + 1}`,
        stdio: 'pipe'
      })
      worker.child = child
      worker.ready = false
      worker.logBudget.reset()
      this.clearIdleTimer(worker)
      worker.startupTimer = setTimeout(() => {
        if (worker.child !== child || worker.ready) return
        this.terminateWorker(
          worker,
          createAnalysisError(
            'ERR_AUDIO_ANALYSIS_STARTUP_TIMEOUT',
            `audio analysis worker ${worker.slot + 1} startup timed out`
          ),
          true
        )
      }, this.startupTimeoutMs)
      child.on('message', (message) => {
        if (worker.child !== child) return
        this.handleWorkerMessage(worker, message)
      })
      child.on('exit', (code) => {
        if (worker.child !== child) return
        this.terminateWorker(
          worker,
          createAnalysisError(
            'ERR_AUDIO_ANALYSIS_WORKER_EXIT',
            `audio analysis worker ${worker.slot + 1} exited: ${code ?? 'unknown'}`
          ),
          true
        )
      })
      child.on('error', (error, location) => {
        if (worker.child !== child) return
        const detail = error instanceof Error ? error.message : String(error)
        this.terminateWorker(
          worker,
          createAnalysisError(
            'ERR_AUDIO_ANALYSIS_WORKER_ERROR',
            `audio analysis worker ${worker.slot + 1} error at ${location ?? 'unknown'}: ${detail}`
          ),
          true
        )
      })
      child.stdout?.on('data', (chunk) => {
        if (worker.child !== child) return
        this.emitWorkerLog(worker, 'log', chunk)
      })
      child.stderr?.on('data', (chunk) => {
        if (worker.child !== child) return
        this.emitWorkerLog(worker, 'error-log', chunk)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      if (this.recordStartupFailure(worker, message)) this.scheduleRestart(worker)
    }
  }

  private emitWorkerLog(worker: AnalysisWorker, event: 'log' | 'error-log', chunk: Buffer): void {
    const capture = worker.logBudget.capture(chunk)
    if (capture.text) this.emit(event, capture.text)
    if (capture.notice) this.emit(event, capture.notice)
  }

  private handleWorkerMessage(worker: AnalysisWorker, message: unknown): void {
    const record = asUtilityProcessMessageRecord(message)
    if (!record) {
      this.handleWorkerProtocolViolation(worker)
      return
    }

    let kind: unknown
    try {
      kind = record.kind
    } catch {
      this.handleWorkerProtocolViolation(worker)
      return
    }

    if (kind === 'ready') {
      if (!inspectUtilityProcessMessage(record, MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES).ok) {
        this.handleWorkerProtocolViolation(worker)
        return
      }
      try {
        const analyses = record.analyses
        if (
          record.protocolVersion !== AUDIO_ANALYSIS_PROTOCOL_VERSION ||
          !Array.isArray(analyses) ||
          !analyses.includes('bpm') ||
          !analyses.includes('loudness')
        ) {
          this.handleFatal('audio analysis worker capability contract mismatch')
          return
        }
        if (worker.startupTimer) clearTimeout(worker.startupTimer)
        worker.startupTimer = null
        worker.ready = true
        worker.startupFailures = 0
        this.unavailableError = ''
        this.pump()
      } catch {
        this.handleWorkerProtocolViolation(worker)
      }
      return
    }

    if (kind === 'fatal') {
      if (!inspectUtilityProcessMessage(record, MAX_UTILITY_PROCESS_CONTROL_MESSAGE_BYTES).ok) {
        this.handleWorkerProtocolViolation(worker)
        return
      }
      try {
        if (
          !isBoundedUtf8String(record.error, MAX_UTILITY_PROCESS_ERROR_TEXT_BYTES) ||
          !record.error.trim()
        ) {
          this.handleWorkerProtocolViolation(worker)
          return
        }
        this.handleFatal(record.error)
      } catch {
        this.handleWorkerProtocolViolation(worker)
      }
      return
    }

    if (kind !== 'response') {
      this.handleWorkerProtocolViolation(worker)
      return
    }
    // Envelope fields are bounded by parseUtilityProcessResponse; the payload
    // is inspected separately below, so a whole-record serialization here
    // would only duplicate that work.

    const parsed = parseUtilityProcessResponse(record)
    if (!parsed.ok) {
      this.handleWorkerProtocolViolation(worker)
      return
    }

    const { response } = parsed
    if (response.requestId !== worker.taskId) return
    const task = this.active.get(response.requestId)
    if (!task) return
    if (!inspectUtilityProcessPayload(response.value, MAX_AUDIO_ANALYSIS_RESPONSE_BYTES).ok) {
      this.handleWorkerProtocolViolation(worker)
      return
    }

    this.completeTask(worker, task)
    if (response.ok) task.resolve(response.value)
    else {
      this.lastError = response.error || 'audio analysis worker request failed'
      task.reject(new Error(this.lastError))
    }
    this.pump()
  }

  private handleWorkerProtocolViolation(worker: AnalysisWorker): void {
    this.terminateWorker(
      worker,
      createAnalysisError(AUDIO_ANALYSIS_INVALID_RESPONSE_CODE, AUDIO_ANALYSIS_INVALID_RESPONSE),
      true
    )
  }

  private handleFatal(reason: string): void {
    this.unavailableError = reason || 'audio analysis worker failed to start'
    this.lastError = this.unavailableError
    for (const candidate of this.workers) {
      if (candidate.restartTimer) clearTimeout(candidate.restartTimer)
      candidate.restartTimer = null
      this.clearIdleTimer(candidate)
      this.terminateWorker(
        candidate,
        createAnalysisError('ERR_AUDIO_ANALYSIS_UNAVAILABLE', this.unavailableError),
        false
      )
    }
    this.rejectQueuedUnavailable()
  }

  private pump(): void {
    if (this.stopped || this.unavailableError) return
    const now = this.now()
    this.expireQueuedTasks(now)
    for (const worker of this.workers) {
      if (!worker.ready || worker.taskId || !worker.child) continue
      const task = this.takeNextTask(now)
      if (!task) {
        this.armIdleTimer(worker)
        continue
      }
      this.clearIdleTimer(worker)
      worker.taskId = task.id
      this.active.set(task.id, task)
      task.timer = setTimeout(() => {
        if (worker.taskId !== task.id) return
        this.terminateWorker(
          worker,
          createAnalysisError(
            'ERR_AUDIO_ANALYSIS_TIMEOUT',
            `${task.analysis} analysis timed out after ${task.timeoutMs} ms: ${task.source}`
          ),
          true
        )
      }, task.timeoutMs)
      try {
        worker.child.postMessage({
          kind: 'request',
          requestId: task.id,
          analysis: task.analysis,
          source: task.source,
          optionsJson: task.optionsJson
        })
      } catch (error) {
        this.terminateWorker(
          worker,
          createAnalysisError(
            'ERR_AUDIO_ANALYSIS_SEND_FAILED',
            error instanceof Error ? error.message : String(error)
          ),
          true
        )
      }
    }
    if (this.queued.length > 0) this.ensureWorkerCapacity()
    this.scheduleQueueMaintenance(this.now())
  }

  private completeTask(worker: AnalysisWorker, task: AnalysisTask): void {
    if (task.timer) clearTimeout(task.timer)
    task.timer = null
    this.active.delete(task.id)
    if (worker.taskId === task.id) worker.taskId = null
    if (worker.child && worker.ready) this.armIdleTimer(worker)
  }

  private terminateWorker(worker: AnalysisWorker, error: Error, restart: boolean): void {
    const child = worker.child
    const failedDuringStartup = Boolean(child) && !worker.ready
    worker.child = null
    worker.ready = false
    if (worker.startupTimer) clearTimeout(worker.startupTimer)
    worker.startupTimer = null
    this.clearIdleTimer(worker)
    const task = worker.taskId ? this.active.get(worker.taskId) : undefined
    if (task) {
      this.completeTask(worker, task)
      task.reject(error)
    } else {
      worker.taskId = null
    }
    this.lastError = error.message
    try {
      child?.kill()
    } catch {
      // Worker identity was detached before kill, so late exit/results are ignored.
    }
    if (
      restart &&
      !this.stopped &&
      (!failedDuringStartup || this.recordStartupFailure(worker, error.message))
    ) {
      this.scheduleRestart(worker)
    }
    this.pump()
  }

  private scheduleRestart(worker: AnalysisWorker): void {
    if (this.stopped || this.unavailableError || worker.disabled || worker.restartTimer) return
    worker.restartTimer = setTimeout(() => {
      worker.restartTimer = null
      this.startWorker(worker)
    }, this.restartDelayMs)
  }

  private recordStartupFailure(worker: AnalysisWorker, reason: string): boolean {
    worker.startupFailures += 1
    if (worker.startupFailures < this.maxStartupFailures) return true
    worker.disabled = true
    if (this.workers.some((candidate) => !candidate.disabled)) return false

    this.unavailableError = `audio analysis workers failed to start after ${
      this.maxStartupFailures
    } attempts: ${reason}`
    this.lastError = this.unavailableError
    this.rejectQueuedUnavailable()
    return false
  }

  private cancelQueued(
    predicate: (task: AnalysisTask) => boolean,
    reason = 'analysis cancelled'
  ): number {
    let cancelled = 0
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      const task = this.queued[index]
      if (!task || !predicate(task)) continue
      this.queued.splice(index, 1)
      task.reject(createAnalysisError('ERR_AUDIO_ANALYSIS_CANCELLED', reason))
      cancelled += 1
    }
    this.scheduleQueueMaintenance(this.now())
    return cancelled
  }

  private rejectQueuedUnavailable(): void {
    const message = this.unavailableError || 'audio analysis service unavailable'
    while (this.queued.length > 0) {
      this.queued.shift()?.reject(createAnalysisError('ERR_AUDIO_ANALYSIS_UNAVAILABLE', message))
    }
    this.clearQueueMaintenanceTimer()
  }

  private admitTask(task: AnalysisTask, now: number): boolean {
    if (this.queued.length < this.maxQueueSize) {
      this.queued.push(task)
      return true
    }

    const worstIndex = this.findWorstQueuedTaskIndex(now)
    const worst = worstIndex >= 0 ? this.queued[worstIndex] : undefined
    if (!worst || this.compareTaskPrecedence(task, worst, now) >= 0) {
      task.reject(
        createAnalysisError(
          'ERR_AUDIO_ANALYSIS_QUEUE_FULL',
          `audio analysis queue is full (${this.maxQueueSize})`
        )
      )
      return false
    }

    this.queued.splice(worstIndex, 1)
    worst.reject(
      createAnalysisError(
        'ERR_AUDIO_ANALYSIS_EVICTED',
        `${worst.analysis} analysis was evicted by a higher-priority request: ${worst.source}`
      )
    )
    this.queued.push(task)
    return true
  }

  private takeNextTask(now: number): AnalysisTask | undefined {
    if (this.queued.length === 0) return undefined
    let bestIndex = 0
    for (let index = 1; index < this.queued.length; index += 1) {
      const candidate = this.queued[index]
      const best = this.queued[bestIndex]
      if (candidate && best && this.compareTaskPrecedence(candidate, best, now) < 0) {
        bestIndex = index
      }
    }
    return this.queued.splice(bestIndex, 1)[0]
  }

  private findWorstQueuedTaskIndex(now: number): number {
    if (this.queued.length === 0) return -1
    let worstIndex = 0
    for (let index = 1; index < this.queued.length; index += 1) {
      const candidate = this.queued[index]
      const worst = this.queued[worstIndex]
      if (candidate && worst && this.compareTaskPrecedence(candidate, worst, now) > 0) {
        worstIndex = index
      }
    }
    return worstIndex
  }

  /** Negative means left should run first. Older tasks gain one point per aging interval. */
  private compareTaskPrecedence(left: AnalysisTask, right: AnalysisTask, now: number): number {
    const priorityDelta = this.effectivePriority(right, now) - this.effectivePriority(left, now)
    return priorityDelta || left.sequence - right.sequence
  }

  private effectivePriority(task: AnalysisTask, now: number): number {
    const waitedMs = Math.max(0, now - task.queuedAt)
    return task.priority + Math.floor(waitedMs / this.agingIntervalMs)
  }

  private expireQueuedTasks(now: number): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      const task = this.queued[index]
      if (!task || now - task.queuedAt < this.queueTimeoutMs) continue
      this.queued.splice(index, 1)
      task.reject(
        createAnalysisError(
          'ERR_AUDIO_ANALYSIS_QUEUE_TIMEOUT',
          `${task.analysis} analysis exceeded the ${this.queueTimeoutMs} ms queue deadline: ${task.source}`
        )
      )
    }
    this.scheduleQueueMaintenance(now)
  }

  private scheduleQueueMaintenance(now: number): void {
    if (this.stopped || this.unavailableError || this.queued.length === 0) {
      this.clearQueueMaintenanceTimer()
      return
    }

    let dueAt = Number.POSITIVE_INFINITY
    for (const task of this.queued) {
      dueAt = Math.min(dueAt, task.queuedAt + this.queueTimeoutMs)
      const age = Math.max(0, now - task.queuedAt)
      const nextAgingStep = Math.floor(age / this.agingIntervalMs) + 1
      dueAt = Math.min(dueAt, task.queuedAt + nextAgingStep * this.agingIntervalMs)
    }
    if (this.queueMaintenanceTimer && this.queueMaintenanceDueAt <= dueAt) return
    this.clearQueueMaintenanceTimer()
    this.queueMaintenanceDueAt = dueAt
    this.queueMaintenanceTimer = setTimeout(
      () => {
        this.queueMaintenanceTimer = null
        this.queueMaintenanceDueAt = 0
        const current = this.now()
        this.expireQueuedTasks(current)
        this.pump()
      },
      Math.max(1, dueAt - now)
    )
  }

  private clearQueueMaintenanceTimer(): void {
    if (this.queueMaintenanceTimer) clearTimeout(this.queueMaintenanceTimer)
    this.queueMaintenanceTimer = null
    this.queueMaintenanceDueAt = 0
  }
}

function resolveElectron(): ElectronModule | null {
  try {
    const electron = require('electron') as ElectronModule | string
    return typeof electron === 'object' && electron ? electron : null
  } catch {
    return null
  }
}

function clampInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function createAnalysisError(code: string, message: string): AudioAnalysisError {
  const error = new Error(message) as AudioAnalysisError
  error.code = code
  return error
}

function parseAnalysisJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value
  const parsed = tryParseJsonWithNestingLimit(value)
  if (!parsed.ok) throw new Error(`audio analysis worker returned invalid ${label} JSON`)
  return parsed.value
}

function analysisErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const error = (value as { error?: unknown }).error
  return typeof error === 'string' && error.trim() ? error : fallback
}
