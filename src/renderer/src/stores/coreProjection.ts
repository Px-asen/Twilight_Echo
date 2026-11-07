import {
  CORE_PROTOCOL_VERSION,
  type CoreClientMessage,
  type CoreCommandName,
  type CoreCommands,
  type CoreQueries,
  type CoreQueryName,
  type CoreRequestEnvelope,
  type CoreSnapshot
} from '../../../shared/coreProtocol.ts'

export interface CoreConnection {
  connect(): Promise<CoreSnapshot>
  request(request: CoreRequestEnvelope, signal?: AbortSignal): Promise<unknown>
  subscribe(listener: (message: CoreClientMessage) => void): () => void
}

/** Client-only synchronization. Reconnect/gaps re-read state; commands are never replayed. */
export class CoreProjection {
  private current: CoreSnapshot | null = null
  private unsubscribe: (() => void) | null = null
  private refreshing: Promise<CoreSnapshot> | null = null
  private generation = 0
  private disposed = false
  private synchronized = false
  private readonly retiredEpochs = new Set<string>()
  private queued: CoreClientMessage[] = []
  private readonly connection: CoreConnection
  private readonly changed: (state: CoreSnapshot) => void
  private readonly newId: () => string
  private readonly failed: (error: Error) => void
  constructor(
    connection: CoreConnection,
    changed: (state: CoreSnapshot) => void,
    newId: () => string = () => crypto.randomUUID(),
    failed: (error: Error) => void = () => {}
  ) {
    this.connection = connection
    this.changed = changed
    this.newId = newId
    this.failed = failed
  }
  snapshot(): CoreSnapshot | null {
    return this.current
  }
  async attach(): Promise<CoreSnapshot> {
    if (this.disposed) throw new Error('Core projection was disposed')
    if (!this.unsubscribe)
      this.unsubscribe = this.connection.subscribe((message) => this.receive(message))
    return this.refresh()
  }
  private publish(state: CoreSnapshot, synchronized = this.synchronized): void {
    if (
      state.protocolVersion !== CORE_PROTOCOL_VERSION ||
      !state.epoch ||
      !Number.isSafeInteger(state.sequence) ||
      state.sequence < 0
    )
      throw new Error('Invalid Core snapshot')
    if (this.retiredEpochs.has(state.epoch))
      throw new Error('Core connection returned a retired epoch')
    if (this.current?.epoch === state.epoch && state.sequence < this.current.sequence)
      throw new Error('Core connection returned an older snapshot')
    if (this.current && this.current.epoch !== state.epoch) {
      this.retiredEpochs.add(this.current.epoch)
      if (this.retiredEpochs.size > 8)
        this.retiredEpochs.delete(this.retiredEpochs.values().next().value!)
    }
    this.current = freeze(structuredClone(state))
    this.synchronized = synchronized
    this.changed(this.current)
  }
  private receive(message: CoreClientMessage): void {
    if (this.disposed || message.kind !== 'state' || this.retiredEpochs.has(message.epoch)) return
    if (
      message.epoch !== message.snapshot.epoch ||
      message.sequence !== message.snapshot.sequence
    ) {
      this.failed(new Error('Core event and snapshot versions disagree'))
      return
    }
    if (this.refreshing) {
      // Bounded to one latest snapshot event: events are full bounded projections,
      // not queue/library documents. A gap triggers another snapshot read.
      this.queued = [message]
      return
    }
    if (
      !this.synchronized ||
      !this.current ||
      message.epoch !== this.current.epoch ||
      message.sequence > this.current.sequence + 1
    ) {
      void this.refresh().catch(() => {})
      return
    }
    if (message.sequence <= this.current.sequence) return
    this.publish(message.snapshot)
  }
  refresh(): Promise<CoreSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Core projection was disposed'))
    if (this.refreshing) return this.refreshing
    this.synchronized = false
    const generation = ++this.generation
    const promise = this.connection
      .connect()
      .then((state) => {
        if (this.disposed || generation !== this.generation)
          throw new Error('Core projection detached')
        this.publish(state, true)
        return state
      })
      .catch((error) => {
        this.synchronized = false
        this.queued = []
        this.failed(error instanceof Error ? error : new Error(String(error)))
        throw error
      })
      .finally(() => {
        if (this.refreshing !== promise) return
        this.refreshing = null
        for (const event of this.queued.splice(0)) this.receive(event)
      })
    this.refreshing = promise
    return promise
  }
  async command<K extends CoreCommandName>(
    name: K,
    payload: CoreCommands[K],
    signal?: AbortSignal,
    requestId?: string
  ): Promise<unknown> {
    return this.request({ kind: 'command', name, payload } as CoreRequestEnvelope, signal, requestId)
  }
  async query<K extends CoreQueryName>(
    name: K,
    payload: CoreQueries[K]['input'],
    signal?: AbortSignal
  ): Promise<CoreQueries[K]['output']> {
    return this.request({ kind: 'query', name, payload } as CoreRequestEnvelope, signal) as Promise<
      CoreQueries[K]['output']
    >
  }
  private async request(operation: CoreRequestEnvelope, signal?: AbortSignal, requestId = this.newId()): Promise<unknown> {
    if (!this.current || this.disposed || !this.synchronized)
      throw new Error('Core state is not attached')
    const epoch = this.current.epoch
    let value: unknown
    try {
      value = await this.connection.request(
        { ...operation, epoch, requestId },
        signal
      )
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (
        !this.disposed &&
        this.current?.epoch === epoch &&
        (code === 'STALE_EPOCH' || code === 'NOT_READY')
      ) {
        // Refresh only the connection. Never repeat the rejected operation.
        this.synchronized = false
        void this.refresh().catch(() => {})
      }
      throw error
    }
    if (this.disposed || this.current?.epoch !== epoch)
      throw Object.assign(
        new Error(
          operation.kind === 'command'
            ? 'Core changed during this command; read current state instead of replaying it'
            : 'Core query belongs to an old connection'
        ),
        { code: operation.kind === 'command' ? 'OUTCOME_UNKNOWN' : 'STALE_EPOCH' }
      )
    return value
  }
  dispose(): void {
    this.disposed = true
    this.synchronized = false
    this.generation++
    this.unsubscribe?.()
    this.unsubscribe = null
    this.queued = []
    this.current = null
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
