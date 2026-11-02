import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { CoreWindowBridge, CORE_WINDOW_POLICIES } from './windowBridge.ts'
import {
  CORE_WINDOW_IPC,
  type CoreBridgeConnected,
  type CoreBridgeReply
} from '../../shared/coreBridge.ts'
import type {
  CoreClientIdentity,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../shared/coreProtocol.ts'
import type { CoreSupervisor } from './supervisor.ts'

const snapshot = (sequence = 0) =>
  ({ protocolVersion: 1, epoch: 'epoch', sequence, phase: 'ready' }) as CoreSnapshot
class Contents extends EventEmitter {
  id: number
  mainFrame = { url: 'file:///app/renderer/index.html', processId: 1, routingId: 1 }
  sent: unknown[][] = []
  dead = false
  constructor(id: number) {
    super()
    this.id = id
  }
  isDestroyed() {
    return this.dead
  }
  send(...args: unknown[]) {
    this.sent.push(args)
  }
}
class Supervisor extends EventEmitter {
  identities = new Map<string, CoreClientIdentity>()
  requests: { id: string; request: CoreRequestEnvelope; signal?: AbortSignal }[] = []
  disconnected: string[] = []
  sequence = 0
  handler: (request: CoreRequestEnvelope, signal?: AbortSignal) => Promise<unknown> = async (
    request
  ) => (request.name === 'state.snapshot' ? snapshot(this.sequence) : null)
  connect(identity: CoreClientIdentity) {
    this.identities.set(identity.id, identity)
    this.state(identity.id)
  }
  state(id: string) {
    this.emit('client-message', id, {
      kind: 'state',
      epoch: 'epoch',
      sequence: this.sequence,
      snapshot: snapshot(this.sequence)
    })
  }
  disconnect(id: string) {
    this.disconnected.push(id)
    this.identities.delete(id)
  }
  getStatus() {
    return { phase: 'ready' as const, epoch: 'epoch' }
  }
  async request(id: string, request: CoreRequestEnvelope, signal?: AbortSignal) {
    this.requests.push({ id, request, signal })
    return this.handler(request, signal)
  }
}
function fixture(t: test.TestContext) {
  const supervisor = new Supervisor()
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, payload: unknown) => Promise<CoreBridgeReply<unknown>>
  >()
  const ipc = {
    handle: (name, handler) => handlers.set(name, handler),
    removeHandler: (name) => handlers.delete(name)
  } as Pick<IpcMain, 'handle' | 'removeHandler'>
  const bridge = new CoreWindowBridge({
    supervisor: supervisor as unknown as CoreSupervisor,
    ipc,
    trustedUrl: (url) => url.startsWith('file:///app/renderer/index.html')
  })
  t.after(() => bridge.dispose())
  const desktop = new Contents(1),
    auxiliary = new Contents(2),
    stranger = new Contents(3)
  bridge.register(desktop as unknown as WebContents, CORE_WINDOW_POLICIES.desktop)
  bridge.register(auxiliary as unknown as WebContents)
  const event = (contents: Contents, frame = contents.mainFrame) =>
    ({ sender: contents, senderFrame: frame }) as unknown as IpcMainInvokeEvent
  const invoke = (
    name: keyof typeof CORE_WINDOW_IPC,
    contents: Contents,
    payload: unknown,
    frame = contents.mainFrame
  ) => handlers.get(CORE_WINDOW_IPC[name])!(event(contents, frame), payload)
  const connect = async (contents: Contents) => {
    const reply = await invoke('connect', contents, {})
    assert.equal(reply.ok, true)
    return (reply as { ok: true; value: CoreBridgeConnected }).value
  }
  return { bridge, supervisor, desktop, auxiliary, stranger, invoke, connect, handlers }
}
const pause = (requestId = 'local-id'): CoreRequestEnvelope => ({
  kind: 'command',
  name: 'playback.pause',
  payload: {},
  epoch: 'epoch',
  requestId
})

test('no renderer window can authorize plugin package paths or installation sources', () => {
  for (const policy of Object.values(CORE_WINDOW_POLICIES))
    assert.equal(policy.permissions.includes('plugins:resources'), false)
})

test('only registered top-level app frames connect; query text never grants desktop permissions', async (t) => {
  const f = fixture(t)
  assert.equal((await f.invoke('connect', f.stranger, {})).ok, false)
  assert.equal((await f.invoke('connect', f.desktop, {}, { ...f.desktop.mainFrame })).ok, false)
  f.desktop.mainFrame.url = 'https://untrusted.test/'
  assert.equal((await f.invoke('connect', f.desktop, {})).ok, false)
  f.auxiliary.mainFrame.url += '?window=desktop&permissions=all'
  assert.equal((await f.invoke('connect', f.auxiliary, { role: 'desktop' })).ok, false)
  const connection = await f.connect(f.auxiliary)
  assert.deepEqual(f.supervisor.identities.get(connection.connectionId)?.permissions, [
    'playback:read',
    'playback:write'
  ])
  const forbidden = await f.invoke('request', f.auxiliary, {
    connectionId: connection.connectionId,
    request: { ...pause(), name: 'library.reset', payload: { revision: 0 } }
  })
  assert.equal(forbidden.ok, false)
  assert.equal((forbidden as { ok: false; error: { code: string } }).error.code, 'FORBIDDEN')
  assert.equal(f.supervisor.requests.length, 0)
})

test('initial snapshot precedes event consumption, refresh reuses identity and finite requests preserve error codes', async (t) => {
  const f = fixture(t),
    connection = await f.connect(f.desktop)
  assert.equal(connection.snapshot.sequence, 0)
  assert.equal(f.desktop.sent.length, 0)
  f.supervisor.sequence = 1
  f.supervisor.state(connection.connectionId)
  assert.equal(f.desktop.sent[0][0], CORE_WINDOW_IPC.message)
  const fft = {
    kind: 'visualization',
    epoch: 'epoch',
    subscriptionId: 'fft',
    sequence: 1,
    data: null
  }
  f.supervisor.emit('client-message', connection.connectionId, fft)
  assert.deepEqual(f.desktop.sent[1], [
    CORE_WINDOW_IPC.message,
    { connectionId: connection.connectionId, message: fft }
  ])
  const refreshed = await f.invoke('connect', f.desktop, { connectionId: connection.connectionId })
  assert.equal((refreshed as { value: CoreBridgeConnected }).value.snapshot.sequence, 1)
  assert.equal(f.supervisor.identities.size, 1)
  const invalid = await f.invoke('request', f.desktop, {
    connectionId: connection.connectionId,
    request: { ...pause(), name: 'anything.run' }
  })
  assert.equal((invalid as { error: { code: string } }).error.code, 'INVALID_REQUEST')
  f.supervisor.handler = async () => {
    throw Object.assign(new Error('version mismatch'), { code: 'STALE_REVISION' })
  }
  const failed = await f.invoke('request', f.desktop, {
    connectionId: connection.connectionId,
    request: pause()
  })
  assert.deepEqual(failed, {
    ok: false,
    error: { code: 'STALE_REVISION', message: 'version mismatch' }
  })
  assert.notEqual(f.supervisor.requests.at(-1)?.request.requestId, 'local-id')
})

test('request IDs and cancellation are isolated per window; navigation cancels its pending request only', async (t) => {
  const f = fixture(t),
    desktop = await f.connect(f.desktop),
    helper = await f.connect(f.auxiliary)
  f.supervisor.handler = async (_request, signal) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('unknown write'), { code: 'OUTCOME_UNKNOWN' })),
        { once: true }
      )
    })
  const first = f.invoke('request', f.desktop, {
    connectionId: desktop.connectionId,
    request: pause()
  })
  const second = f.invoke('request', f.auxiliary, {
    connectionId: helper.connectionId,
    request: pause()
  })
  assert.notEqual(
    f.supervisor.requests[0].request.requestId,
    f.supervisor.requests[1].request.requestId
  )
  assert.equal(
    (
      await f.invoke('cancel', f.auxiliary, {
        connectionId: desktop.connectionId,
        requestId: 'local-id'
      })
    ).ok,
    false
  )
  assert.equal(f.supervisor.requests[0].signal?.aborted, false)
  f.desktop.emit('did-start-navigation', {}, 'file:///app/renderer/index.html', false, true)
  assert.deepEqual(await first, {
    ok: false,
    error: { code: 'OUTCOME_UNKNOWN', message: 'unknown write' }
  })
  assert.equal(f.supervisor.requests[1].signal?.aborted, false)
  assert.deepEqual(f.supervisor.disconnected, [desktop.connectionId])
  await f.invoke('cancel', f.auxiliary, {
    connectionId: helper.connectionId,
    requestId: 'local-id'
  })
  assert.equal((await second).ok, false)
  assert.equal(f.supervisor.requests.length, 2, 'cancelled commands are never replayed')
})

test('frame replacement, renderer crash and window disposal retire connections without affecting other windows', async (t) => {
  const f = fixture(t),
    desktop = await f.connect(f.desktop),
    helper = await f.connect(f.auxiliary)
  f.desktop.emit('did-start-navigation', {}, '#different-route', true, true)
  assert.equal(f.supervisor.identities.has(desktop.connectionId), true)
  f.desktop.mainFrame = { ...f.desktop.mainFrame, routingId: 2 }
  const replacement = await f.connect(f.desktop)
  assert.notEqual(replacement.connectionId, desktop.connectionId)
  f.desktop.emit('render-process-gone', {})
  assert.equal(f.supervisor.identities.has(replacement.connectionId), false)
  f.auxiliary.emit('destroyed')
  assert.equal(f.supervisor.identities.has(helper.connectionId), false)
  assert.equal((await f.invoke('connect', f.auxiliary, {})).ok, false)
  f.bridge.dispose()
  assert.equal(f.handlers.size, 0)
})

test('connect and status surface supervisor getLastError detail when Core is unavailable', async (t) => {
  const f = fixture(t)
  const unavailableSupervisor = f.supervisor as unknown as {
    getStatus: () => { phase: 'failed' | 'starting'; epoch: string | null }
    getLastError?: () => string | null
    connect: (identity: CoreClientIdentity) => void
  }
  unavailableSupervisor.getStatus = () => ({ phase: 'failed', epoch: null })
  unavailableSupervisor.getLastError = () => 'Database quick_check failed'

  const connectReply = await f.invoke('connect', f.desktop, {})
  assert.deepEqual(connectReply, {
    ok: false,
    error: {
      code: 'NOT_READY',
      message: 'Core is not available (Database quick_check failed)'
    }
  })

  // Also verify an in-flight connect when supervisor transitions to 'failed' via status event
  unavailableSupervisor.getStatus = () => ({ phase: 'starting', epoch: null })
  unavailableSupervisor.connect = () => {}
  const pendingConnect = f.invoke('connect', f.desktop, {})
  f.supervisor.emit('status', { phase: 'failed', epoch: null })
  assert.deepEqual(await pendingConnect, {
    ok: false,
    error: {
      code: 'NOT_READY',
      message: 'Core is not available (Database quick_check failed)'
    }
  })
})
