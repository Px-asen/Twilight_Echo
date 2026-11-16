import { randomUUID } from '../../shared/portableCrypto.ts'
import type { TwilightMediaProviderMethod } from './types.ts'
import { PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN } from '../../shared/pluginHostContracts.ts'
export {
  PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN,
  normalizeInternalNcmRequestOptions
} from '../../shared/pluginHostContracts.ts'

const IDEMPOTENT_PROVIDER_WRITE_METHODS = new Set<TwilightMediaProviderMethod>([
  'reportListening',
  'likeTrack',
  'followArtist',
  'followUser',
  'createPlaylist',
  'deletePlaylist',
  'addTracksToPlaylist',
  'removeTracksFromPlaylist',
  'completeCloudUpload',
  'createDownload'
])

export function resolveProviderIdempotencyKey(
  method: TwilightMediaProviderMethod,
  suppliedKey: string | undefined
): string | undefined {
  if (!IDEMPOTENT_PROVIDER_WRITE_METHODS.has(method)) return undefined
  const key = suppliedKey?.trim() || randomUUID()
  if (!PLUGIN_RPC_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error('Provider idempotency key is invalid.')
  }
  return key
}

export const DEFAULT_MAX_PLUGIN_RPC_CONCURRENCY = 4
export const DEFAULT_MAX_PLUGIN_RPC_QUEUE = 32
export const DEFAULT_PLUGIN_RPC_CIRCUIT_FAILURE_THRESHOLD = 3
export const DEFAULT_PLUGIN_RPC_CIRCUIT_INITIAL_BACKOFF_MS = 1_000
export const DEFAULT_PLUGIN_RPC_CIRCUIT_MAX_BACKOFF_MS = 30_000
export const DEFAULT_PLUGIN_RPC_LATE_RESULT_TTL_MS = 5 * 60_000
export const DEFAULT_PLUGIN_RPC_IDEMPOTENCY_TTL_MS = 5 * 60_000
export const DEFAULT_MAX_PLUGIN_RPC_LATE_RESULTS = 256
export const DEFAULT_MAX_PLUGIN_RPC_IDEMPOTENCY_RECORDS = 512

export type PluginRpcKind = 'provider' | 'ui-command' | 'experience'
export type PluginRpcPriority = 'high' | 'normal' | 'low'

const PLUGIN_RPC_PRIORITY_RANK: Record<PluginRpcPriority, number> = {
  high: 0,
  normal: 1,
  low: 2
}

export interface PluginRpcIdempotency {
  /** A namespace chosen by the caller, usually plugin/provider/method. */
  scope: string
  key: string
  /** Reject accidental reuse of one key for a different request payload. */
  fingerprint: string
}

export interface PluginRpcRequestOptions<TMetadata> {
  requestId: string
  pluginId: string
  /**
   * Optional isolation key for circuit-breaker tracking. Defaults to `pluginId`
   * so host-wide callers share one circuit while multi-method providers can
   * isolate e.g. background search failures from playback RPCs.
   */
  circuitKey?: string
  /**
   * Scheduling priority within a plugin's RPC queue. `'low'` background calls
   * also leave foreground concurrency headroom when `maxConcurrencyPerPlugin`
   * allows it, preventing metadata bursts from starving playback.
   */
  priority?: PluginRpcPriority
  kind: PluginRpcKind
  timeoutMs: number
  metadata: TMetadata
  dispatch: () => void
  cancel?: (reason: string) => void
  onTimeout?: (error: Error) => void
  signal?: AbortSignal
  idempotency?: PluginRpcIdempotency
  /** Scheduling priority inside the per-plugin queue (defaults to 'normal'). */
  priority?: PluginRpcPriority
}

export type PluginRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; tripCircuit?: boolean }

export type PluginRpcCompletion<TMetadata> =
  | { status: 'settled'; metadata: TMetadata; result: PluginRpcResult }
  | { status: 'late' | 'unknown' | 'wrong-plugin' }

export interface PluginRpcCoordinatorOptions {
  maxConcurrencyPerPlugin?: number
  /** Extra concurrency slots reserved exclusively for `'high'` priority requests. */
  highPriorityHeadroom?: number
  maxQueuePerPlugin?: number
  circuitFailureThreshold?: number
  circuitInitialBackoffMs?: number
  circuitMaxBackoffMs?: number
  lateResultTtlMs?: number
  idempotencyTtlMs?: number
  maxLateResults?: number
  maxIdempotencyRecords?: number
  now?: () => number
}

interface PluginCircuitState {
  consecutiveFailures: number
  openUntil: number | null
  probeRequestId: string | null
}

interface PluginRpcState {
  active: Map<string, PendingPluginRpc<unknown>>
  queue: PendingPluginRpc<unknown>[]
  circuits: Map<string, PluginCircuitState>
  cancelling: boolean
}

interface PendingPluginRpc<TMetadata> {
  requestId: string
  pluginId: string
  circuitKey: string
  priority: PluginRpcPriority
  kind: PluginRpcKind
  priority: PluginRpcPriority
  timeoutMs: number
  metadata: TMetadata
  dispatch: () => void
  cancel?: (reason: string) => void
  onTimeout?: (error: Error) => void
  signal?: AbortSignal
  abortListener?: () => void
  idempotency?: {
    cacheKey: string
    fingerprint: string
  }
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  dispatched: boolean
  settled: boolean
  circuitProbe: boolean
}

interface IdempotencyRecord {
  fingerprint: string
  promise: Promise<unknown>
  expiresAt: number
  status: 'in-flight' | 'succeeded' | 'unknown-outcome'
}

/**
 * Owns the lifecycle of calls sent from the main process to one plugin host.
 * The coordinator intentionally has no Electron dependency so overload and
 * cancellation behaviour can be verified with normal Node tests.
 */
export class PluginRpcCoordinator {
  private readonly maxConcurrencyPerPlugin: number
  private readonly highPriorityHeadroom: number
  private readonly maxQueuePerPlugin: number
  private readonly circuitFailureThreshold: number
  private readonly circuitInitialBackoffMs: number
  private readonly circuitMaxBackoffMs: number
  private readonly lateResultTtlMs: number
  private readonly idempotencyTtlMs: number
  private readonly maxLateResults: number
  private readonly maxIdempotencyRecords: number
  private readonly now: () => number
  private readonly states = new Map<string, PluginRpcState>()
  private readonly pendingById = new Map<string, PendingPluginRpc<unknown>>()
  private readonly lateResults = new Map<string, number>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()

  constructor(options: PluginRpcCoordinatorOptions = {}) {
    this.maxConcurrencyPerPlugin = positiveInteger(
      options.maxConcurrencyPerPlugin,
      DEFAULT_MAX_PLUGIN_RPC_CONCURRENCY,
      'maxConcurrencyPerPlugin'
    )
    this.highPriorityHeadroom = nonNegativeInteger(
      options.highPriorityHeadroom,
      0,
      'highPriorityHeadroom'
    )
    this.maxQueuePerPlugin = positiveInteger(
      options.maxQueuePerPlugin,
      DEFAULT_MAX_PLUGIN_RPC_QUEUE,
      'maxQueuePerPlugin'
    )
    this.circuitFailureThreshold = positiveInteger(
      options.circuitFailureThreshold,
      DEFAULT_PLUGIN_RPC_CIRCUIT_FAILURE_THRESHOLD,
      'circuitFailureThreshold'
    )
    this.circuitInitialBackoffMs = positiveInteger(
      options.circuitInitialBackoffMs,
      DEFAULT_PLUGIN_RPC_CIRCUIT_INITIAL_BACKOFF_MS,
      'circuitInitialBackoffMs'
    )
    this.circuitMaxBackoffMs = positiveInteger(
      options.circuitMaxBackoffMs,
      DEFAULT_PLUGIN_RPC_CIRCUIT_MAX_BACKOFF_MS,
      'circuitMaxBackoffMs'
    )
    this.lateResultTtlMs = positiveInteger(
      options.lateResultTtlMs,
      DEFAULT_PLUGIN_RPC_LATE_RESULT_TTL_MS,
      'lateResultTtlMs'
    )
    this.idempotencyTtlMs = positiveInteger(
      options.idempotencyTtlMs,
      DEFAULT_PLUGIN_RPC_IDEMPOTENCY_TTL_MS,
      'idempotencyTtlMs'
    )
    this.maxLateResults = positiveInteger(
      options.maxLateResults,
      DEFAULT_MAX_PLUGIN_RPC_LATE_RESULTS,
      'maxLateResults'
    )
    this.maxIdempotencyRecords = positiveInteger(
      options.maxIdempotencyRecords,
      DEFAULT_MAX_PLUGIN_RPC_IDEMPOTENCY_RECORDS,
      'maxIdempotencyRecords'
    )
    this.now = options.now ?? Date.now
  }

  request<T, TMetadata = unknown>(options: PluginRpcRequestOptions<TMetadata>): Promise<T> {
    if (!options.requestId.trim())
      return Promise.reject(new Error('Plugin RPC request id is required.'))
    if (!options.pluginId.trim())
      return Promise.reject(new Error('Plugin RPC plugin id is required.'))
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return Promise.reject(new Error('Plugin RPC timeout must be a positive number.'))
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal))
    this.pruneExpiredEntries()
    if (this.pendingById.has(options.requestId)) {
      return Promise.reject(
        new Error(`Plugin RPC request id is already pending: ${options.requestId}`)
      )
    }
    if (this.lateResults.has(options.requestId)) {
      return Promise.reject(
        new Error(
          `Plugin RPC request id is quarantined after a prior settlement: ${options.requestId}`
        )
      )
    }
    const idempotency = options.idempotency ? this.prepareIdempotency<T>(options.idempotency) : null
    if (idempotency?.existing) return idempotency.existing

    const circuitKey = options.circuitKey?.trim() || options.pluginId
    const priority: PluginRpcPriority = options.priority ?? 'normal'
    const state = this.stateFor(options.pluginId)
    const circuitError = this.reserveCircuitProbe(
      state,
      options.pluginId,
      circuitKey,
      options.requestId
    )
    if (circuitError) return Promise.reject(circuitError)
    if (!this.canDispatch(state, priority) && state.queue.length >= this.maxQueuePerPlugin) {
      if (priority !== 'low' && this.preemptLowPriorityQueuedRequest(state, options.pluginId)) {
        // A low-priority background RPC made room for foreground work.
      } else {
        this.clearCircuitProbe(state, circuitKey, options.requestId)
        this.cleanupState(options.pluginId, state)
        return Promise.reject(
          new Error(
            `Plugin ${options.pluginId} RPC queue is full (${this.maxQueuePerPlugin} waiting requests).`
          )
        )
      }
    }

    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((resolveRequest, rejectRequest) => {
      resolve = resolveRequest as (value: unknown) => void
      reject = rejectRequest
    })
    const circuit = state.circuits.get(circuitKey)
    const pending: PendingPluginRpc<TMetadata> = {
      requestId: options.requestId,
      pluginId: options.pluginId,
      circuitKey,
      priority,
      kind: options.kind,
      timeoutMs: options.timeoutMs,
      metadata: options.metadata,
      dispatch: options.dispatch,
      cancel: options.cancel,
      onTimeout: options.onTimeout,
      signal: options.signal,
      idempotency: idempotency?.record,
      resolve,
      reject,
      timer: null,
      dispatched: false,
      settled: false,
      circuitProbe: circuit?.probeRequestId === options.requestId
    }
    this.pendingById.set(pending.requestId, pending as PendingPluginRpc<unknown>)
    if (idempotency?.record) {
      this.idempotency.set(idempotency.record.cacheKey, {
        fingerprint: idempotency.record.fingerprint,
        promise,
        expiresAt: Number.POSITIVE_INFINITY,
        status: 'in-flight'
      })
    }
    pending.timer = setTimeout(() => this.timeout(pending.requestId), pending.timeoutMs)
    if (pending.signal) {
      pending.abortListener = () => this.abort(pending.requestId)
      pending.signal.addEventListener('abort', pending.abortListener, { once: true })
      if (pending.signal.aborted) this.abort(pending.requestId)
    }

    if (pending.settled) return promise
    if (this.canDispatch(state, priority)) {
      this.start(state, pending as PendingPluginRpc<unknown>)
    } else {
      this.enqueue(state, pending as PendingPluginRpc<unknown>)
    }
    return promise
  }

  complete<TMetadata>(
    pluginId: string,
    requestId: string,
    result: PluginRpcResult
  ): PluginRpcCompletion<TMetadata> {
    this.pruneExpiredEntries()
    const pending = this.pendingById.get(requestId)
    if (!pending) {
      return this.lateResults.has(requestId) ? { status: 'late' } : { status: 'unknown' }
    }
    if (pending.pluginId !== pluginId) return { status: 'wrong-plugin' }
    if (!pending.dispatched) return { status: 'unknown' }

    const state = this.stateFor(pluginId)
    if (result.ok) {
      this.settle(state, pending, { kind: 'success', value: result.value })
    } else {
      this.settle(state, pending, {
        kind: 'remote-error',
        error: new Error(result.error),
        tripCircuit: result.tripCircuit !== false
      })
    }
    return { status: 'settled', metadata: pending.metadata as TMetadata, result }
  }

  /** Reject queued and active requests before a host is stopped or discarded. */
  cancelPlugin(pluginId: string, reason: string): number {
    const state = this.states.get(pluginId)
    if (!state) return 0
    const error = new Error(reason)
    let cancelled = 0
    state.cancelling = true
    try {
      for (const pending of [...state.active.values()]) {
        this.addLateResult(pending.requestId)
        try {
          pending.cancel?.(reason)
        } catch {
          // A dead utility process can reject postMessage. The caller still gets a prompt rejection.
        }
        this.settle(state, pending, { kind: 'cancelled-active', error })
        cancelled += 1
      }
      for (const pending of [...state.queue]) {
        this.settle(state, pending, { kind: 'cancelled-queued', error })
        cancelled += 1
      }
    } finally {
      state.cancelling = false
    }
    this.cleanupState(pluginId, state)
    return cancelled
  }

  getPendingCount(pluginId: string): number {
    const state = this.states.get(pluginId)
    return state ? state.active.size + state.queue.length : 0
  }

  getMetadata<TMetadata>(pluginId: string, requestId: string): TMetadata | null {
    const pending = this.pendingById.get(requestId)
    if (!pending || !pending.dispatched || pending.pluginId !== pluginId) return null
    return pending.metadata as TMetadata
  }

  getLateResultCount(): number {
    this.pruneExpiredEntries()
    return this.lateResults.size
  }

  private start(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    if (pending.settled) return
    pending.dispatched = true
    state.active.set(pending.requestId, pending)
    try {
      pending.dispatch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.settle(state, pending, { kind: 'remote-error', error: new Error(message) })
    }
  }

  private abort(requestId: string): void {
    const pending = this.pendingById.get(requestId)
    if (!pending || pending.settled) return
    const state = this.stateFor(pending.pluginId)
    const error = abortError(pending.signal)
    if (pending.dispatched) {
      this.addLateResult(pending.requestId)
      try {
        pending.cancel?.(error.message)
      } catch {
        // The utility process may have exited between abort and cancellation.
      }
      this.settle(state, pending, { kind: 'cancelled-active', error })
    } else {
      this.settle(state, pending, { kind: 'cancelled-queued', error })
    }
  }

  private timeout(requestId: string): void {
    const pending = this.pendingById.get(requestId)
    if (!pending || pending.settled) return
    const state = this.stateFor(pending.pluginId)
    const error = new Error(
      `Plugin ${pending.pluginId} ${pending.kind} RPC timed out after ${pending.timeoutMs}ms.`
    )
    if (pending.dispatched) {
      this.addLateResult(pending.requestId)
      try {
        pending.cancel?.(error.message)
      } catch {
        // The utility process may have exited between timeout and cancellation.
      }
      this.settle(state, pending, { kind: 'timeout-active', error })
    } else {
      this.settle(state, pending, { kind: 'timeout-queued', error })
    }
    try {
      pending.onTimeout?.(error)
    } catch {
      // A caller-owned timeout observer must not break coordinator cleanup.
    }
  }

  private settle(
    state: PluginRpcState,
    pending: PendingPluginRpc<unknown>,
    outcome:
      | { kind: 'success'; value: unknown }
      | {
          kind: 'remote-error'
          error: Error
          tripCircuit?: boolean
        }
      | {
          kind: 'timeout-active' | 'timeout-queued' | 'cancelled-active' | 'cancelled-queued'
          error: Error
        }
  ): void {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
    pending.abortListener = undefined
    this.pendingById.delete(pending.requestId)
    if (pending.dispatched) state.active.delete(pending.requestId)
    else {
      const index = state.queue.indexOf(pending)
      if (index >= 0) state.queue.splice(index, 1)
    }
    this.clearCircuitProbe(state, pending.circuitKey, pending.requestId)

    const preserveSucceededIdempotency = outcome.kind === 'success'
    const preserveUnknownIdempotency =
      (outcome.kind === 'timeout-active' || outcome.kind === 'cancelled-active') &&
      pending.dispatched
    if (pending.idempotency) {
      const record = this.idempotency.get(pending.idempotency.cacheKey)
      if (!preserveSucceededIdempotency && !preserveUnknownIdempotency) {
        this.idempotency.delete(pending.idempotency.cacheKey)
      } else if (record) {
        record.status = preserveSucceededIdempotency ? 'succeeded' : 'unknown-outcome'
        record.expiresAt = this.now() + this.idempotencyTtlMs
      }
    }

    if (outcome.kind === 'success') {
      this.recordSuccess(state, pending)
      pending.resolve(outcome.value)
    } else {
      if (outcome.kind === 'timeout-active') {
        this.recordFailure(state, pending)
      } else if (outcome.kind === 'remote-error') {
        if (outcome.tripCircuit !== false) {
          this.recordFailure(state, pending)
        } else {
          this.recordSuccess(state, pending)
        }
      }
      pending.reject(outcome.error)
    }
    this.drain(pending.pluginId, state)
    this.cleanupState(pending.pluginId, state)
  }

  private canDispatch(state: PluginRpcState, priority: PluginRpcPriority): boolean {
    const limit =
      priority === 'high'
        ? this.maxConcurrencyPerPlugin + this.highPriorityHeadroom
        : this.maxConcurrencyPerPlugin
    if (state.active.size >= limit) return false
    if (priority === 'low' && this.maxConcurrencyPerPlugin >= 2) {
      const lowLimit = this.maxConcurrencyPerPlugin >= 3 ? this.maxConcurrencyPerPlugin - 2 : 1
      let activeLow = 0
      for (const active of state.active.values()) {
        if (active.priority === 'low') activeLow += 1
      }
      if (activeLow >= lowLimit) return false
    }
    return true
  }

  private enqueue(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    const targetRank = PLUGIN_RPC_PRIORITY_RANK[pending.priority]
    let insertAt = state.queue.length
    for (let i = state.queue.length - 1; i >= 0; i -= 1) {
      if (PLUGIN_RPC_PRIORITY_RANK[state.queue[i].priority] <= targetRank) {
        insertAt = i + 1
        break
      }
      if (i === 0) insertAt = 0
    }
    state.queue.splice(insertAt, 0, pending)
  }

  private drain(pluginId: string, state: PluginRpcState): void {
    if (state.cancelling) return
    let index = 0
    const maxTotal = this.maxConcurrencyPerPlugin + this.highPriorityHeadroom
    while (state.active.size < maxTotal && index < state.queue.length) {
      const pending = state.queue[index]
      if (!pending || pending.settled) {
        state.queue.splice(index, 1)
        continue
      }
      if (this.circuitBlocksQueuedRequest(state, pending)) {
        const circuit = state.circuits.get(pending.circuitKey)
        this.settle(state, pending, {
          kind: 'cancelled-queued',
          error: this.circuitError(pluginId, circuit?.openUntil ?? this.now())
        })
        return
      }
      if (!this.canDispatch(state, pending.priority)) {
        index += 1
        continue
      }
      state.queue.splice(index, 1)
      this.start(state, pending)
    }
  }

  private preemptLowPriorityQueuedRequest(state: PluginRpcState, pluginId: string): boolean {
    for (let index = state.queue.length - 1; index >= 0; index -= 1) {
      const candidate = state.queue[index]
      if (!candidate || candidate.settled || candidate.priority !== 'low') continue
      this.settle(state, candidate, {
        kind: 'cancelled-queued',
        error: new Error(`Plugin ${pluginId} background RPC was preempted by foreground work.`)
      })
      return true
    }
    return false
  }

  private circuitFor(state: PluginRpcState, circuitKey: string): PluginCircuitState {
    const existing = state.circuits.get(circuitKey)
    if (existing) return existing
    const created: PluginCircuitState = {
      consecutiveFailures: 0,
      openUntil: null,
      probeRequestId: null
    }
    state.circuits.set(circuitKey, created)
    return created
  }

  private recordSuccess(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    const circuit = state.circuits.get(pending.circuitKey)
    if (!circuit) return
    if (pending.circuitProbe) {
      circuit.consecutiveFailures = 0
      circuit.openUntil = null
      return
    }
    if (circuit.openUntil === null) circuit.consecutiveFailures = 0
  }

  private recordFailure(state: PluginRpcState, pending: PendingPluginRpc<unknown>): void {
    const circuit = this.circuitFor(state, pending.circuitKey)
    circuit.consecutiveFailures += 1
    if (circuit.consecutiveFailures < this.circuitFailureThreshold) return
    const exponent = circuit.consecutiveFailures - this.circuitFailureThreshold
    const backoff = Math.min(
      this.circuitMaxBackoffMs,
      this.circuitInitialBackoffMs * 2 ** Math.min(exponent, 30)
    )
    circuit.openUntil = this.now() + backoff
    circuit.probeRequestId = null
    for (const queued of [...state.queue]) {
      if (queued.circuitKey !== pending.circuitKey) continue
      this.settle(state, queued, {
        kind: 'cancelled-queued',
        error: this.circuitError(pending.pluginId, circuit.openUntil)
      })
    }
  }

  private reserveCircuitProbe(
    state: PluginRpcState,
    pluginId: string,
    circuitKey: string,
    requestId: string
  ): Error | null {
    const circuit = state.circuits.get(circuitKey)
    if (!circuit) return null
    const openUntil = circuit.openUntil
    if (openUntil === null) return null
    if (this.now() < openUntil) return this.circuitError(pluginId, openUntil)
    if (circuit.probeRequestId) {
      return new Error('Plugin RPC circuit is half-open; wait for the recovery probe to finish.')
    }
    circuit.probeRequestId = requestId
    return null
  }

  private circuitBlocksQueuedRequest(
    state: PluginRpcState,
    pending: PendingPluginRpc<unknown>
  ): boolean {
    const circuit = state.circuits.get(pending.circuitKey)
    if (!circuit) return false
    const openUntil = circuit.openUntil
    if (openUntil === null) return false
    if (pending.circuitProbe) return this.now() < openUntil
    return true
  }

  private circuitError(pluginId: string, openUntil: number): Error {
    const retryAfterMs = Math.max(0, openUntil - this.now())
    return new Error(`Plugin ${pluginId} RPC circuit is open; retry after ${retryAfterMs}ms.`)
  }

  private clearCircuitProbe(state: PluginRpcState, circuitKey: string, requestId: string): void {
    const circuit = state.circuits.get(circuitKey)
    if (circuit && circuit.probeRequestId === requestId) circuit.probeRequestId = null
  }

  private prepareIdempotency<T>(idempotency: PluginRpcIdempotency): {
    existing?: Promise<T>
    record?: { cacheKey: string; fingerprint: string }
  } {
    if (!idempotency.scope || !idempotency.key || !idempotency.fingerprint) {
      return { existing: Promise.reject(new Error('Plugin RPC idempotency data is incomplete.')) }
    }
    const cacheKey = `${idempotency.scope}\u0000${idempotency.key}`
    const existing = this.idempotency.get(cacheKey)
    if (existing) {
      if (existing.fingerprint !== idempotency.fingerprint) {
        return {
          existing: Promise.reject(
            new Error('Plugin RPC idempotency key is already bound to a different request payload.')
          )
        }
      }
      if (existing.status !== 'unknown-outcome') {
        return { existing: existing.promise as Promise<T> }
      }
      return { record: { cacheKey, fingerprint: idempotency.fingerprint } }
    }
    this.evictSettledIdempotencyRecords(this.maxIdempotencyRecords - 1)
    if (this.idempotency.size >= this.maxIdempotencyRecords) {
      return {
        existing: Promise.reject(
          new Error('Plugin RPC idempotency registry is full of in-flight write operations.')
        )
      }
    }
    return { record: { cacheKey, fingerprint: idempotency.fingerprint } }
  }

  private stateFor(pluginId: string): PluginRpcState {
    const existing = this.states.get(pluginId)
    if (existing) return existing
    const created: PluginRpcState = {
      active: new Map(),
      queue: [],
      circuits: new Map(),
      cancelling: false
    }
    this.states.set(pluginId, created)
    return created
  }

  private cleanupState(pluginId: string, state: PluginRpcState): void {
    const now = this.now()
    for (const [key, circuit] of state.circuits) {
      if (
        circuit.consecutiveFailures === 0 &&
        circuit.probeRequestId === null &&
        (circuit.openUntil === null || now >= circuit.openUntil)
      ) {
        state.circuits.delete(key)
      }
    }
    if (state.active.size !== 0 || state.queue.length !== 0) return
    if (state.circuits.size !== 0) return
    this.states.delete(pluginId)
  }

  private addLateResult(requestId: string): void {
    this.lateResults.set(requestId, this.now() + this.lateResultTtlMs)
    this.trimLateResults()
  }

  private pruneExpiredEntries(): void {
    const now = this.now()
    for (const [requestId, expiresAt] of this.lateResults) {
      if (expiresAt <= now) this.lateResults.delete(requestId)
    }
    for (const [cacheKey, record] of this.idempotency) {
      if (record.status !== 'in-flight' && record.expiresAt <= now) {
        this.idempotency.delete(cacheKey)
      }
    }
    this.trimLateResults()
    this.evictSettledIdempotencyRecords(this.maxIdempotencyRecords)
  }

  private trimLateResults(): void {
    while (this.lateResults.size > this.maxLateResults) {
      const oldest = this.lateResults.keys().next().value
      if (oldest === undefined) break
      this.lateResults.delete(oldest)
    }
  }

  private evictSettledIdempotencyRecords(maximumSize: number): void {
    if (this.idempotency.size <= maximumSize) return
    for (const [cacheKey, record] of this.idempotency) {
      if (record.status === 'in-flight') continue
      this.idempotency.delete(cacheKey)
      if (this.idempotency.size <= maximumSize) return
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (reason != null) return new Error(String(reason))
  return new Error('Plugin RPC request was aborted.')
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return selected
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return selected
}
