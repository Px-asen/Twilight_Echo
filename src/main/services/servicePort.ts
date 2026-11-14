/** Electron parent/MessagePort adapters live outside the portable business Core. */
export interface ServiceMessagePort {
  postMessage(message: unknown): void
  on(
    event: 'message',
    listener: (event: { data: unknown; ports?: ServiceMessagePort[] }) => void
  ): unknown
  start?(): void
  close?(): void
}
export interface ServicePort<Incoming, Outgoing> {
  postMessage(message: Outgoing): void
  on(event: 'message', listener: (message: Incoming) => void): void
}

function isTwilightWorkerData(value: unknown): value is { twilightWorkerThread: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { twilightWorkerThread?: unknown }).twilightWorkerThread === true
  )
}

function resolveWorkerThreadPort(): ServiceMessagePort | undefined {
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule
    const workerThreads = getBuiltin?.('worker_threads') as
      | {
          isMainThread?: boolean
          parentPort?: {
            postMessage(message: unknown): void
            on(event: 'message' | 'close', listener: (value?: unknown) => void): unknown
            close(): void
          } | null
          workerData?: unknown
        }
      | undefined
    if (
      !workerThreads ||
      workerThreads.isMainThread !== false ||
      !workerThreads.parentPort ||
      !isTwilightWorkerData(workerThreads.workerData)
    ) {
      return undefined
    }
    const port = workerThreads.parentPort
    const adapted: ServiceMessagePort = {
      postMessage: (message: unknown) => port.postMessage(message),
      on: ((event: string, listener: (payload?: unknown) => void) => {
        if (event === 'message') port.on('message', (data) => listener({ data }))
        else if (event === 'close') port.on('close', () => listener())
        return adapted
      }) as ServiceMessagePort['on'],
      close: () => port.close()
    }
    return adapted
  } catch {
    return undefined
  }
}

/**
 * The main-owned attachment is one-shot. In peer mode no business messages pass
 * through main; startup replies wait for the transferred port. Main retains only
 * a separate, narrow supervision lane (used to silence audio after Core failure).
 */
export function createServicePort<Incoming, Outgoing>(
  options: {
    parent?: ServiceMessagePort
    peerMode?: boolean
    node?: {
      send(message: unknown): void
      on(event: 'message', listener: (message: unknown) => void): void
      on(event: 'disconnect', listener: () => void): void
    }
    supervise?: (message: unknown, reply: (message: unknown) => void) => void
    onClose?: (source: 'peer' | 'parent') => void
  } = {}
): ServicePort<Incoming, Outgoing> {
  const workerThreadParent = options.parent ? undefined : resolveWorkerThreadPort()
  const parent =
    options.parent ??
    workerThreadParent ??
    (process as unknown as { parentPort?: ServiceMessagePort }).parentPort
  const node =
    options.node ??
    (process.send
      ? {
          send: (message: unknown) => process.send?.(message),
          on: (event: 'message' | 'disconnect', listener: (message: unknown) => void) =>
            process.on(event, listener as (...args: unknown[]) => void)
        }
      : undefined)
  if (!parent && !node) throw new Error('Service requires an Electron parent port or Node IPC')
  const peerMode =
    options.peerMode ?? (!workerThreadParent && process.argv.includes('--twilight-core-service'))
  let peer: ServiceMessagePort | undefined
  const startup: Outgoing[] = []
  const listeners: ((message: Incoming) => void)[] = []
  const dispatch = (message: unknown) => {
    for (const listener of listeners) listener(message as Incoming)
  }
  const listenClose = (port: ServiceMessagePort, source: 'peer' | 'parent') => {
    ;(port as unknown as { on?: (event: 'close', listener: () => void) => unknown }).on?.('close', () => {
      options.onClose?.(source)
    })
  }
  const parentPost = (message: unknown) =>
    parent ? parent.postMessage(message) : node!.send(message)
  if (parent) {
    listenClose(parent, 'parent')
    parent.on('message', (event) => {
      const message = event.data as { kind?: string } | null
      if (message?.kind === 'core:attach-service') {
        if (!peerMode || peer || event.ports?.length !== 1) return
        peer = event.ports[0]
        listenClose(peer, 'peer')
        peer.on('message', (event) => dispatch(event.data))
        peer.start?.()
        for (const reply of startup.splice(0)) peer.postMessage(reply)
        return
      }
      if (message?.kind === 'supervisor:stop-audio') {
        options.supervise?.(message, parentPost)
        return
      }
      if (!peerMode) dispatch(event.data)
    })
  } else {
    node!.on('message', dispatch)
    node!.on?.('disconnect', () => options.onClose?.('parent'))
  }
  return {
    postMessage(message) {
      if (peer) peer.postMessage(message)
      else if (!peerMode) parentPost(message)
      else {
        if (startup.length >= 8) throw new Error('Service startup reply buffer is full')
        startup.push(message)
      }
    },
    on(_, listener) {
      listeners.push(listener)
    }
  }
}
