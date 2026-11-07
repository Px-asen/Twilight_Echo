import '../../adapters-node/index.ts'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  coreOperation,
  isCoreRequest,
  type CoreClientIdentity,
  type CorePhase,
  type CoreRequestEnvelope,
  type CoreServiceKind
} from '../../shared/coreProtocol.ts'
import type {
  AudioSupervisorReply,
  CoreChildMessage,
  CoreParentMessage,
  CoreProcessConfiguration
} from '../../shared/coreProcessProtocol.ts'
import type { ServiceMessagePort } from '../services/servicePort.ts'
import type { CorePlatformOperations, CorePlatformRequest } from '../../shared/corePlatform.ts'
import { validCorePlatformPayload } from '../../shared/corePlatform.ts'

export interface SupervisedProcess extends EventEmitter {
  postMessage(message: unknown, ports?: ServiceMessagePort[]): void
  kill(): boolean | void
}
interface Peer {
  child: SupervisedProcess
  service: CoreServiceKind
  exited: boolean
  exit: Promise<void>
  silencing?: Promise<boolean>
}
interface Pending {
  epoch: string
  command: boolean
  clientId: string
  resolve(value: unknown): void
  reject(error: Error): void
  dispose(): void
}
export interface CoreSupervisorOptions {
  /** Fixed main-owned entry registry. Never built from IPC payloads. */
  entries: Readonly<Record<Exclude<CoreServiceKind, 'zone-audio'> | 'core', string>>
  configuration: Omit<CoreProcessConfiguration, 'epoch' | 'recovery'>
  fork(entry: string, args: string[], serviceName: string): SupervisedProcess
  channel(): { port1: ServiceMessagePort; port2: ServiceMessagePort }
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  stopOutputs?(): Promise<void>
  platform?: {
    [K in keyof CorePlatformOperations]?: (
      payload: CorePlatformOperations[K]['input'],
      signal: AbortSignal
    ) => Promise<CorePlatformOperations[K]['output']>
  }
}

/** Main-only lifecycle owner. It knows no queue, source-resolution or playback business. */
export class CoreSupervisor extends EventEmitter {
  private child: SupervisedProcess | null = null
  private coreExit: Promise<void> | null = null
  private epoch: string | null = null
  private phase: CorePhase = 'stopped'
  private lastError: string | null = null
  private readonly peers = new Map<string, Peer>()
  private readonly clients = new Map<string, CoreClientIdentity>()
  private readonly pending = new Map<string, Pending>()
  private startPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private automaticRestarts = 0
  private stopping = false
  private initialized = false
  private platformLifetime = new AbortController()
  private activePlatformRequests = 0
  private readonly platformRequests = new Map<string, AbortController>()
  private failureInProgress: Promise<void> | null = null
  private shutdownReply: { id: string; resolve(): void; reject(error: Error): void } | null = null
  private shutdownCheckpoint: Promise<void> | null = null

  private readonly options: CoreSupervisorOptions
  constructor(options: CoreSupervisorOptions) {
    super()
    this.options = { ...options, configuration: { ...options.configuration } }
  }
  getStatus(): { phase: CorePhase; epoch: string | null } {
    return { phase: this.phase, epoch: this.epoch }
  }
  getLastError(): string | null {
    return this.lastError
  }
  private setPhase(phase: CorePhase): void {
    this.phase = phase
    this.emit('status', this.getStatus())
  }

  start(): Promise<void> {
    if (this.phase === 'ready') return Promise.resolve()
    if (this.startPromise) return this.startPromise
    if (this.stopping || this.failureInProgress)
      return Promise.reject(new Error('Core lifecycle transition in progress'))
    if (this.phase === 'failed')
      return Promise.reject(new Error('Core failed; explicit retry required'))
    this.setPhase(this.automaticRestarts ? 'recovering' : 'starting')
    this.platformLifetime = new AbortController()
    this.epoch = randomUUID()
    this.initialized = false
    const epoch = this.epoch
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.startPromise = ready
    try {
      const child = this.options.fork(this.options.entries.core, [], 'twilight-core')
      this.child = child
      this.coreExit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.on('message', (message: CoreChildMessage) => {
        if (this.child !== child) return
        this.handleMessage(child, epoch, message)
      })
      child.on('exit', (code) => {
        if (this.child !== child) return
        const error = new Error(`Core exited (${code})`)
        if (this.stopping || this.shutdownCheckpoint) this.shutdownReply?.reject(error)
        else void this.fail(error)
      })
      child.on('error', (error) => {
        if (this.child === child && !this.stopping) void this.fail(asError(error))
      })
      this.readyTimer = setTimeout(() => {
        void this.fail(new Error('Core initialization timed out'))
      }, this.options.readyTimeoutMs ?? 120_000)
    } catch (error) {
      void this.fail(asError(error))
    }
    return ready
  }

  private handleMessage(child: SupervisedProcess, epoch: string, raw: CoreChildMessage): void {
    if (!raw || typeof raw !== 'object') return
    // Core may need a database reopen or an outstanding platform result to
    // finish its shutdown checkpoint. Public requests are already gated.
    if (
      (this.stopping || this.shutdownCheckpoint) &&
      ![
        'core:shutdown-complete',
        'core:service-close',
        'core:service-open',
        'core:platform',
        'core:platform-cancel',
        'core:settings',
        'core:client-message',
        'core:fatal'
      ].includes(raw.kind)
    )
      return
    if (raw.kind === 'core:booted') {
      const message: CoreParentMessage = {
        kind: 'core:initialize',
        configuration: {
          ...this.options.configuration,
          epoch,
          recovery: this.automaticRestarts > 0
        }
      }
      child.postMessage(message)
      return
    }
    if ('epoch' in raw && raw.epoch !== epoch) return
    switch (raw.kind) {
      case 'core:themes':
        this.emit('themes', raw.snapshot, epoch)
        break
      case 'core:settings':
        // Cache relocation is restart-required, including across an automatic Core recovery.
        if (!this.options.configuration.musicCachePath)
          this.options.configuration.musicCachePath = raw.state.settings.musicCachePath
        this.emit('settings', raw.state, epoch)
        break
      case 'core:initialized':
        this.lastError = null
        this.initialized = true
        this.clearReadyTimer()
        for (const identity of this.clients.values())
          child.postMessage({ kind: 'core:connect', identity })
        this.emit('initialized', this.getStatus())
        break
      case 'core:ready':
        this.lastError = null
        this.clearReadyTimer()
        this.setPhase('ready')
        this.readyResolve?.()
        this.readyResolve = this.readyReject = null
        this.startPromise = null
        break
      case 'core:platform':
        void this.platformRequest(child, epoch, raw)
        break
      case 'core:platform-cancel':
        this.platformRequests
          .get(raw.requestId)
          ?.abort(new Error('Core cancelled platform request'))
        break
      case 'core:fatal':
        if (this.stopping) this.shutdownReply?.reject(new Error(raw.error))
        void this.fail(new Error(raw.error))
        break
      case 'core:service-open':
        this.openService(child, epoch, raw.leaseId, raw.service)
        break
      case 'core:service-close': {
        const peer = this.peers.get(raw.leaseId)
        if (peer) void this.closePeer(peer)
        break
      }
      case 'core:client-message': {
        if ((this.stopping || this.shutdownCheckpoint) && raw.message?.kind !== 'response') return
        if (raw.message?.epoch !== epoch || !this.clients.has(raw.clientId)) return
        if (raw.message.kind === 'response') {
          const pending = this.pending.get(raw.message.requestId)
          if (pending?.epoch === epoch && pending.clientId === raw.clientId) {
            pending.dispose()
            if (raw.message.ok) pending.resolve(raw.message.value)
            else
              pending.reject(
                Object.assign(new Error(raw.message.error.message), {
                  code: raw.message.error.code
                })
              )
          }
        }
        this.emit('client-message', raw.clientId, raw.message)
        break
      }
      case 'core:shutdown-complete':
        if (this.shutdownReply?.id === raw.requestId) {
          if (raw.ok) this.shutdownReply.resolve()
          else this.shutdownReply.reject(new Error(raw.error ?? 'Core persistence failed'))
        }
        break
    }
  }

  private async platformRequest(
    child: SupervisedProcess,
    epoch: string,
    request: CorePlatformRequest
  ): Promise<void> {
    if (this.activePlatformRequests >= 32) {
      child.postMessage({
        kind: 'core:platform-response',
        epoch,
        requestId: request.requestId,
        ok: false,
        error: 'Platform capability queue is full'
      })
      return
    }
    this.activePlatformRequests++
    const controller = new AbortController()
    this.platformRequests.set(request.requestId, controller)
    try {
      if (!this.options.platform || !Object.hasOwn(this.options.platform, request.name))
        throw new Error('Unknown or unavailable platform capability')
      if (!validCorePlatformPayload(request)) throw new Error('Invalid platform capability payload')
      const handler = this.options.platform[request.name] as (
        payload: CorePlatformRequest['payload'],
        signal: AbortSignal
      ) => Promise<unknown>
      const value = await handler(
        request.payload,
        AbortSignal.any([this.platformLifetime.signal, controller.signal])
      )
      if (this.child === child && this.epoch === epoch)
        child.postMessage({
          kind: 'core:platform-response',
          epoch,
          requestId: request.requestId,
          ok: true,
          value
        })
    } catch (error) {
      if (this.child === child && this.epoch === epoch)
        child.postMessage({
          kind: 'core:platform-response',
          epoch,
          requestId: request.requestId,
          ok: false,
          error: asError(error).message
        })
    } finally {
      this.activePlatformRequests--
      if (this.platformRequests.get(request.requestId) === controller)
        this.platformRequests.delete(request.requestId)
    }
  }

  private openService(
    core: SupervisedProcess,
    epoch: string,
    leaseId: string,
    service: CoreServiceKind
  ): void {
    if (
      !['audio', 'audio-test', 'zone-audio', 'database', 'scan', 'analysis', 'plugin'].includes(service) ||
      typeof leaseId !== 'string' ||
      leaseId.length > 128 ||
      this.peers.has(leaseId)
    ) {
      core.postMessage({ kind: 'core:service-error', leaseId, error: 'Invalid service lease' })
      if (!this.peers.has(leaseId))
        core.postMessage({ kind: 'core:service-exit', leaseId, code: null })
      return
    }
    const limit = service === 'zone-audio' ? 3 : service === 'analysis' ? 4 : service === 'plugin' ? 32 : 1
    if (
      [...this.peers.values()].filter((p) => p.service === service && !p.exited).length >= limit
    ) {
      core.postMessage({ kind: 'core:service-error', leaseId, error: 'Service capacity exceeded' })
      core.postMessage({ kind: 'core:service-exit', leaseId, code: null })
      return
    }
    let peer: Peer | null = null
    let ports: { port1: ServiceMessagePort; port2: ServiceMessagePort } | null = null
    try {
      const child = this.options.fork(
        this.options.entries[service === 'zone-audio' ? 'audio' : service],
        ['--twilight-core-service'],
        `twilight-${service}`
      )
      peer = {
        child,
        service,
        exited: false,
        exit: new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
      this.peers.set(leaseId, peer)
      const currentPeer = peer
      child.once('exit', (code: number | null) => {
        currentPeer.exited = true
        this.peers.delete(leaseId)
        if (this.child === core && this.epoch === epoch)
          core.postMessage({ kind: 'core:service-exit', leaseId, code })
      })
      child.on('error', (error) => {
        terminateProcess(child)
        if (this.child === core && this.epoch === epoch)
          core.postMessage({ kind: 'core:service-error', leaseId, error: asError(error).message })
      })
      ports = this.options.channel()
      child.postMessage({ kind: 'core:attach-service' }, [ports.port1])
      core.postMessage({ kind: 'core:service-connected', leaseId }, [ports.port2])
    } catch (error) {
      if (peer) terminateProcess(peer.child)
      ports?.port1.close?.()
      ports?.port2.close?.()
      core.postMessage({ kind: 'core:service-error', leaseId, error: asError(error).message })
      if (!peer) core.postMessage({ kind: 'core:service-exit', leaseId, code: null })
    }
  }

  /** Identity is resolved at the trusted caller (window registry, remote auth, plugin permissions). */
  connect(identity: CoreClientIdentity): void {
    if (this.clients.has(identity.id)) throw new Error('Core client identity is already connected')
    const owned = { ...identity, permissions: [...identity.permissions] }
    this.clients.set(identity.id, owned)
    if (this.initialized && this.child)
      this.child.postMessage({ kind: 'core:connect', identity: owned })
  }
  disconnect(clientId: string): void {
    this.clients.delete(clientId)
    this.child?.postMessage({ kind: 'core:disconnect', clientId })
    for (const pending of [...this.pending.values()])
      if (pending.clientId === clientId) {
        pending.dispose()
        pending.reject(
          Object.assign(
            new Error(
              pending.command
                ? 'Client disconnected; command outcome is unknown'
                : 'Client disconnected'
            ),
            { code: pending.command ? 'OUTCOME_UNKNOWN' : 'CANCELLED' }
          )
        )
      }
  }
  async request(
    clientId: string,
    request: CoreRequestEnvelope,
    signal?: AbortSignal
  ): Promise<unknown> {
    const identity = this.clients.get(clientId)
    if (!identity)
      throw Object.assign(new Error('Core client is not connected'), { code: 'FORBIDDEN' })
    if (!isCoreRequest(request))
      throw Object.assign(new Error('Unknown or malformed Core operation'), {
        code: 'INVALID_REQUEST'
      })
    const operation = coreOperation(request.name)!
    if (!identity.permissions.includes(operation.permission))
      throw Object.assign(new Error('Core request is not permitted'), { code: 'FORBIDDEN' })
    const initializationRequest =
      request.name.startsWith('migration.') || request.name === 'state.snapshot'
    if (
      !this.initialized ||
      (this.phase !== 'ready' && !initializationRequest) ||
      !this.child ||
      this.stopping ||
      this.shutdownCheckpoint
    )
      throw Object.assign(new Error('Core is not ready'), { code: 'NOT_READY' })
    if (request.epoch !== this.epoch)
      throw Object.assign(new Error('Core epoch changed; read a new snapshot'), {
        code: 'STALE_EPOCH'
      })
    if (this.pending.size >= 128)
      throw Object.assign(new Error('Core gateway request queue is full'), { code: 'BUSY' })
    if (this.pending.has(request.requestId)) throw new Error('Duplicate Core request ID')
    if (signal?.aborted)
      throw Object.assign(new Error('Core request cancelled before dispatch'), {
        code: 'CANCELLED'
      })
    return new Promise((resolve, reject) => {
      const child = this.child!
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.pending.delete(request.requestId)
      }
      const cancel = () => {
        finish()
        if (this.child === child)
          child.postMessage({
            kind: 'core:cancel',
            clientId,
            requestId: request.requestId,
            epoch: request.epoch
          })
        reject(
          Object.assign(
            new Error(
              request.kind === 'command'
                ? 'Core request cancelled; command outcome may be unknown'
                : 'Core query cancelled'
            ),
            { code: request.kind === 'command' ? 'OUTCOME_UNKNOWN' : 'CANCELLED' }
          )
        )
      }
      // Browser authentication needs time for the user to scan and confirm,
      // then for the provider to validate and save the returned account.
      const timeoutMs = this.options.requestTimeoutMs ?? (
        request.kind === 'command' && request.name === 'providers.call' &&
        request.payload.method === 'openOfficialLogin' ? 245_000 : 30_000
      )
      const timer = setTimeout(cancel, timeoutMs)
      this.pending.set(request.requestId, {
        epoch: request.epoch,
        command: request.kind === 'command',
        clientId,
        resolve,
        reject,
        dispose: finish
      })
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        child.postMessage({ kind: 'core:request', clientId, request })
      } catch (error) {
        finish()
        reject(
          Object.assign(asError(error), {
            code: request.kind === 'command' ? 'OUTCOME_UNKNOWN' : 'FAILED'
          })
        )
      }
    })
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
  }
  private fail(error: Error): Promise<void> {
    if (this.failureInProgress) return this.failureInProgress
    this.lastError = error.message
    const allowAutomaticRestart = !this.stopping && !this.shutdownCheckpoint
    this.shutdownReply?.reject(error)
    // Invalidate before any await; old commands cannot cross into a new epoch.
    const child = this.child
    const coreExit = this.coreExit
    this.child = null
    this.epoch = null
    this.platformLifetime.abort(error)
    this.clearReadyTimer()
    this.readyReject?.(error)
    this.readyResolve = this.readyReject = null
    this.startPromise = null
    for (const p of [...this.pending.values()]) {
      p.dispose()
      p.reject(
        Object.assign(
          new Error(
            p.command
              ? `${error.message}; command outcome unknown, refresh before retrying`
              : error.message
          ),
          { code: p.command ? 'OUTCOME_UNKNOWN' : 'FAILED' }
        )
      )
    }
    this.setPhase('recovering')
    if (child) terminateProcess(child)
    const failure = Promise.allSettled([
      this.stopPeers(),
      coreExit
        ? deadline(coreExit, this.options.stopTimeoutMs ?? 2000, 'Core termination not confirmed')
        : Promise.resolve()
    ])
      .then((results) => {
        for (const result of results) if (result.status === 'rejected') throw result.reason
        this.coreExit = null
        this.emit('failure', error)
      })
      .catch((stopError) => {
        this.setPhase('failed')
        this.emit('failure', asError(stopError))
      })
      .then(() => {
        this.failureInProgress = null
        if (!allowAutomaticRestart) {
          this.setPhase('failed')
          return
        }
        if (this.stopping) return
        if (this.phase === 'failed' || this.automaticRestarts >= 1) {
          this.setPhase('failed')
          return
        }
        this.automaticRestarts++
        void this.start().catch(() => {
          /* fail() owns the one-restart policy */
        })
      })
    this.failureInProgress = failure
    return failure
  }

  private async stopPeers(): Promise<void> {
    const results = await Promise.allSettled([this.stopServices(), this.options.stopOutputs?.()])
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  private async stopServices(): Promise<void> {
    const peers = [...this.peers.values()]
    const audio = peers.filter(
      (p) => ['audio', 'audio-test', 'zone-audio'].includes(p.service) && !p.exited
    )
    const silenced = await Promise.all(audio.map((peer) => this.silenceAudio(peer)))
    for (const peer of peers) if (!peer.exited) terminateProcess(peer.child)
    await Promise.all(
      audio.map((peer, index) =>
        silenced[index]
          ? undefined
          : deadline(
              peer.exit,
              this.options.stopTimeoutMs ?? 2000,
              'Unable to confirm audio service termination; Core restart withheld'
            )
      )
    )
    // Do not reopen databases while an old service may still hold a write connection.
    await deadline(
      Promise.all(peers.map((p) => p.exit)),
      this.options.stopTimeoutMs ?? 2000,
      `Service termination not confirmed (${peers
        .filter((p) => !p.exited)
        .map((p) => p.service)
        .join(', ')})`
    )
    this.peers.clear()
  }

  private async closePeer(peer: Peer): Promise<void> {
    if (peer.exited) return
    if (['audio', 'audio-test', 'zone-audio'].includes(peer.service)) {
      await this.silenceAudio(peer)
    }
    if (!peer.exited) terminateProcess(peer.child)
  }

  private silenceAudio(audio: Peer): Promise<boolean> {
    if (audio.exited) return Promise.resolve(true)
    if (audio.silencing) return audio.silencing
    const silencing = new Promise<boolean>((resolve) => {
      const requestId = randomUUID()
      const onMessage = (reply: AudioSupervisorReply) => {
        if (reply?.kind === 'supervisor:audio-stopped' && reply.requestId === requestId)
          done(reply.stopped === true)
      }
      const onExit = () => done(true)
      const done = (value: boolean) => {
        clearTimeout(timer)
        audio.child.off('message', onMessage)
        audio.child.off('exit', onExit)
        resolve(value)
      }
      const timer = setTimeout(() => done(false), this.options.stopTimeoutMs ?? 2000)
      audio.child.on('message', onMessage)
      audio.child.once('exit', onExit)
      try {
        audio.child.postMessage({ kind: 'supervisor:stop-audio', requestId })
      } catch {
        done(false)
      }
    })
    audio.silencing = silencing
    return silencing
  }

  async retry(): Promise<void> {
    if (this.phase !== 'failed') throw new Error('Core retry is only available after failure')
    if (this.coreExit) {
      await deadline(
        this.coreExit,
        this.options.stopTimeoutMs ?? 2000,
        'Core termination not confirmed'
      )
      this.coreExit = null
    }
    await this.stopPeers()
    this.automaticRestarts = 1 // manual retry must still recover paused, and must not loop
    this.setPhase('stopped')
    return this.start()
  }
  async shutdown(): Promise<void> {
    if (this.stopping) throw new Error('Core shutdown already in progress')
    this.stopping = true
    this.platformLifetime.abort(new Error('Core is shutting down'))
    this.clearReadyTimer()
    if (this.startPromise) {
      this.readyReject?.(new Error('Core initialization cancelled by application shutdown'))
      this.readyResolve = this.readyReject = null
      this.startPromise = null
    }
    try {
      if (this.failureInProgress) await this.failureInProgress
      if (this.child && this.initialized) {
        const child = this.child
        if (!this.shutdownCheckpoint) {
          const checkpoint = new Promise<void>((resolve, reject) => {
            const id = randomUUID()
            this.shutdownReply = { id, resolve, reject }
            child.postMessage({ kind: 'core:shutdown', requestId: id })
          })
          this.shutdownCheckpoint = checkpoint
          void checkpoint.then(
            () => {
              if (this.shutdownCheckpoint === checkpoint) this.shutdownReply = null
            },
            () => {
              if (this.shutdownCheckpoint === checkpoint) {
                this.shutdownReply = null
                this.shutdownCheckpoint = null
              }
            }
          )
        }
        // A timeout leaves the checkpoint running. A retry joins its eventual
        // ACK instead of invoking Core teardown a second time.
        await deadline(
          this.shutdownCheckpoint,
          this.options.requestTimeoutMs ?? 30_000,
          'Core did not confirm final persistence'
        )
      }
      if (this.child) terminateProcess(this.child)
      this.child = null
      this.epoch = null
      await this.stopPeers()
      if (this.coreExit)
        await deadline(
          this.coreExit,
          this.options.stopTimeoutMs ?? 2000,
          'Core termination not confirmed'
        )
      this.coreExit = null
      this.shutdownCheckpoint = null
      this.setPhase('stopped')
    } finally {
      this.stopping = false
    }
  }

  /** Explicit discard: skip persistence, but still join all owned process exits. */
  async forceShutdown(): Promise<void> {
    if (this.stopping) throw new Error('Core shutdown already in progress')
    this.stopping = true
    const error = new Error('Core stopped without final persistence')
    this.platformLifetime.abort(error)
    this.clearReadyTimer()
    this.readyReject?.(error)
    this.readyResolve = this.readyReject = null
    this.startPromise = null
    this.shutdownReply?.reject(error)
    this.shutdownReply = null
    this.shutdownCheckpoint = null
    try {
      if (this.failureInProgress) await this.failureInProgress
      const child = this.child
      this.child = null
      this.epoch = null
      for (const pending of [...this.pending.values()]) {
        pending.dispose()
        pending.reject(
          Object.assign(new Error(error.message), {
            code: pending.command ? 'OUTCOME_UNKNOWN' : 'CANCELLED'
          })
        )
      }
      if (child) terminateProcess(child)
      await Promise.all([
        this.stopPeers(),
        this.coreExit
          ? deadline(
              this.coreExit,
              this.options.stopTimeoutMs ?? 2000,
              'Core termination not confirmed'
            )
          : Promise.resolve()
      ])
      this.coreExit = null
      this.setPhase('stopped')
    } finally {
      this.stopping = false
    }
  }
}
/** Electron can reject kill() before its asynchronous spawn. Keep the same
 * owned process scheduled for termination; never bypass the exit barrier. */
function terminateProcess(child: SupervisedProcess): void {
  const spawned = () => {
    cleanup()
    child.kill()
  }
  const cleanup = () => {
    child.off('spawn', spawned)
    child.off('exit', cleanup)
  }
  child.once('spawn', spawned)
  child.once('exit', cleanup)
  if (child.kill() !== false) cleanup()
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
