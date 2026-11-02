import { randomUUID } from 'node:crypto'
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import {
  coreOperation,
  isCoreRequest,
  type CoreClientIdentity,
  type CoreClientMessage,
  type CoreErrorCode,
  type CoreSnapshot
} from '../../shared/coreProtocol.ts'
import {
  CORE_WINDOW_IPC,
  type CoreBridgeConnected,
  type CoreBridgeReply
} from '../../shared/coreBridge.ts'
import type { CoreSupervisor } from './supervisor.ts'

type Permission = CoreClientIdentity['permissions'][number]
export interface CoreWindowPolicy {
  role: 'desktop' | 'mini-player'
  permissions: readonly Permission[]
}
export const CORE_WINDOW_POLICIES: Record<'desktop' | 'playback' | 'lyrics', CoreWindowPolicy> = {
  desktop: {
    role: 'desktop',
    permissions: [
      'playback:read',
      'playback:write',
      'library:read',
      'library:write',
      'settings:read',
      'settings:write',
      'migration:write',
      'statistics:read',
      'statistics:write',
      'plugins:read',
      'plugins:manage',
      'providers:call',
      'extensions:execute',
      'downloads:read',
      'downloads:write'
    ]
  },
  playback: { role: 'mini-player', permissions: ['playback:read', 'playback:write'] },
  lyrics: { role: 'mini-player', permissions: ['playback:read'] }
}
interface Session {
  id: string
  frame: WebFrameMain
  requests: Map<string, AbortController>
  resolve(snapshot: CoreSnapshot): void
  reject(error: Error): void
  ready: boolean
}
interface RegisteredWindow {
  contents: WebContents
  policy: CoreWindowPolicy
  session: Session | null
  dispose(): void
}
interface Options {
  supervisor: Pick<
    CoreSupervisor,
    'connect' | 'request' | 'disconnect' | 'getStatus' | 'on' | 'off'
  > & {
    getLastError?(): string | null
  }
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  trustedUrl(url: string): boolean
  connectTimeoutMs?: number
}

/** Window capabilities are assigned at creation, never inferred from a document query. */
export class CoreWindowBridge {
  private readonly windows = new Map<number, RegisteredWindow>()
  private readonly sessions = new Map<string, RegisteredWindow>()
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
    options.supervisor.on('client-message', this.message)
    options.supervisor.on('status', this.status)
    this.handle(CORE_WINDOW_IPC.connect, async (window, event, payload) => {
      if (!record(payload) || !Object.keys(payload).every((key) => key === 'connectionId'))
        throw error('INVALID_REQUEST', 'Invalid Core connection request')
      if (payload.connectionId !== undefined) {
        const session = this.owned(window, payload.connectionId)
        const epoch = options.supervisor.getStatus().epoch
        if (!epoch) throw error('NOT_READY', 'Core is not ready')
        const snapshot = (await options.supervisor.request(session.id, {
          kind: 'query',
          name: 'state.snapshot',
          payload: {},
          epoch,
          requestId: randomUUID()
        })) as CoreSnapshot
        if (window.session !== session) throw error('CANCELLED', 'Core window was detached')
        return { connectionId: session.id, snapshot }
      }
      return this.connect(window, event.senderFrame!)
    })
    this.handle(CORE_WINDOW_IPC.request, async (window, _event, payload) => {
      if (!record(payload) || Object.keys(payload).length !== 2 || !isCoreRequest(payload.request))
        throw error('INVALID_REQUEST', 'Unknown or malformed Core operation')
      const session = this.owned(window, payload.connectionId)
      const request = payload.request
      if (!window.policy.permissions.includes(coreOperation(request.name)!.permission))
        throw error('FORBIDDEN', 'Core window cannot perform this operation')
      if (session.requests.has(request.requestId))
        throw error('INVALID_REQUEST', 'Duplicate request ID')
      const controller = new AbortController()
      session.requests.set(request.requestId, controller)
      try {
        // Supervisor IDs are global. A renderer only chooses IDs in its own connection.
        return await options.supervisor.request(
          session.id,
          { ...request, requestId: randomUUID() },
          controller.signal
        )
      } finally {
        session.requests.delete(request.requestId)
      }
    })
    this.handle(CORE_WINDOW_IPC.cancel, async (window, _event, payload) => {
      if (!record(payload) || Object.keys(payload).length !== 2 || !identifier(payload.requestId))
        throw error('INVALID_REQUEST', 'Invalid Core cancellation')
      this.owned(window, payload.connectionId).requests.get(payload.requestId)?.abort()
    })
    this.handle(CORE_WINDOW_IPC.disconnect, async (window, _event, payload) => {
      if (!record(payload) || Object.keys(payload).length !== 1)
        throw error('INVALID_REQUEST', 'Invalid Core disconnect')
      this.owned(window, payload.connectionId)
      this.detach(window)
    })
  }
  register(
    contents: WebContents,
    policy: CoreWindowPolicy = CORE_WINDOW_POLICIES.playback
  ): () => void {
    if (this.windows.has(contents.id)) throw new Error('Core window already registered')
    const window: RegisteredWindow = {
      contents,
      policy: { role: policy.role, permissions: [...policy.permissions] },
      session: null,
      dispose: () => {}
    }
    const navigation = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !inPlace) this.detach(window)
    }
    const gone = () => this.detach(window)
    const destroy = () => window.dispose()
    window.dispose = () => {
      this.detach(window)
      this.windows.delete(contents.id)
      contents.off('did-start-navigation', navigation)
      contents.off('render-process-gone', gone)
      contents.off('destroyed', destroy)
    }
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', gone)
    contents.on('destroyed', destroy)
    this.windows.set(contents.id, window)
    return window.dispose
  }
  private handle(
    channel: string,
    action: (
      window: RegisteredWindow,
      event: IpcMainInvokeEvent,
      payload: unknown
    ) => Promise<unknown>
  ): void {
    this.options.ipc.handle(channel, async (event, payload): Promise<CoreBridgeReply<unknown>> => {
      try {
        const window = this.windows.get(event.sender.id)
        if (
          !window ||
          window.contents !== event.sender ||
          event.sender.isDestroyed() ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !this.options.trustedUrl(event.senderFrame.url)
        )
          throw error('FORBIDDEN', 'Core rejected an unregistered window or frame')
        if (window.session && window.session.frame !== event.senderFrame) this.detach(window)
        return { ok: true, value: await action(window, event, payload) }
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: (cause as { code?: CoreErrorCode })?.code ?? 'FAILED',
            message: cause instanceof Error ? cause.message : String(cause)
          }
        }
      }
    })
  }
  private owned(window: RegisteredWindow, id: unknown): Session {
    if (!identifier(id) || window.session?.id !== id)
      throw error('FORBIDDEN', 'Core connection does not belong to this window')
    return window.session
  }
  private connect(window: RegisteredWindow, frame: WebFrameMain): Promise<CoreBridgeConnected> {
    if (['stopped', 'failed'].includes(this.options.supervisor.getStatus().phase)) {
      const detail = this.options.supervisor.getLastError?.()
      throw error('NOT_READY', detail ? `Core is not available (${detail})` : 'Core is not available')
    }
    this.detach(window)
    const id = randomUUID()
    let resolve!: (value: CoreBridgeConnected) => void, reject!: (reason: Error) => void
    const first = new Promise<CoreBridgeConnected>((done, fail) => {
      resolve = done
      reject = fail
    })
    const timer = setTimeout(() => {
      session.reject(error('NOT_READY', 'Core snapshot timed out'))
      if (window.session === session) this.detach(window)
    }, this.options.connectTimeoutMs ?? 120_000)
    const session: Session = {
      id,
      frame,
      requests: new Map(),
      ready: false,
      resolve: (snapshot) => {
        clearTimeout(timer)
        session.ready = true
        resolve({ connectionId: id, snapshot })
      },
      reject: (cause) => {
        clearTimeout(timer)
        reject(cause)
      }
    }
    window.session = session
    this.sessions.set(id, window)
    try {
      this.options.supervisor.connect({
        id,
        ...window.policy,
        permissions: [...window.policy.permissions]
      })
    } catch (cause) {
      session.reject(cause instanceof Error ? cause : new Error(String(cause)))
      this.detach(window)
    }
    return first
  }
  private detach(window: RegisteredWindow): void {
    const session = window.session
    if (!session) return
    window.session = null
    this.sessions.delete(session.id)
    session.reject(error('CANCELLED', 'Core window was detached'))
    this.options.supervisor.disconnect(session.id)
    for (const controller of session.requests.values()) controller.abort()
    session.requests.clear()
  }
  private readonly message = (id: string, message: CoreClientMessage): void => {
    const window = this.sessions.get(id),
      session = window?.session
    if (!window || !session || message.kind === 'response') return
    if (!session.ready) {
      if (message.kind === 'state') session.resolve(message.snapshot)
    } else if (!window.contents.isDestroyed())
      window.contents.send(CORE_WINDOW_IPC.message, { connectionId: id, message })
  }
  private readonly status = (status: { phase: string; epoch: string | null }): void => {
    for (const window of this.sessions.values()) {
      if (!window.contents.isDestroyed())
        window.contents.send(CORE_WINDOW_IPC.status, {
          connectionId: window.session!.id,
          ...status
        })
      if (status.phase === 'failed' || status.phase === 'stopped') {
        const detail = this.options.supervisor.getLastError?.()
        window.session?.reject(
          error('NOT_READY', detail ? `Core is not available (${detail})` : 'Core is not available')
        )
      }
    }
  }
  dispose(): void {
    for (const window of [...this.windows.values()]) window.dispose()
    this.options.supervisor.off('client-message', this.message)
    this.options.supervisor.off('status', this.status)
    for (const name of ['connect', 'request', 'cancel', 'disconnect'] as const)
      this.options.ipc.removeHandler(CORE_WINDOW_IPC[name])
  }
}
function error(code: CoreErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
