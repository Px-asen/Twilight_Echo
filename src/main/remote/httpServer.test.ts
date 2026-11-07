import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Writable } from 'node:stream'
import { parseByteRange } from './byteRange.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteAuthSession } from './auth.ts'
import { RemoteCoreBridge } from '../../core/remote/coreBridge.ts'
import type { CoreSnapshot } from '../../shared/coreProtocol.ts'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'test:remote-electron', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'test:remote-electron') {
      return {
        format: 'module',
        source:
          "export const app = { getAppPath: () => process.cwd(), get isPackaged() { return process.env.TWILIGHT_TEST_REMOTE_PACKAGED === '1' } }",
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})
const { RemoteHttpServer, RemoteCommandError } = await import('./httpServer.ts')
hooks.deregister()

type MediaHandler = {
  serveMedia(req: IncomingMessage, res: ServerResponse, token: string): Promise<void>
  proxyRemoteMedia(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    type: string
  ): Promise<void>
  sseClients: Set<ServerResponse>
  broadcastSse(event: string, data: unknown): void
}

test('single-range parsing covers suffix, clamping, empty and invalid requests', () => {
  for (const range of ['bytes=-3', 'bytes=7-', 'bytes=7-999', 'bytes=7-99999999999999999999']) {
    assert.deepEqual(parseByteRange(range, 10), { start: 7, end: 9 }, range)
  }
  assert.deepEqual(parseByteRange('bytes=-999', 10), { start: 0, end: 9 })
  for (const range of [
    'bytes=-0',
    'bytes=-',
    'bytes=10-',
    'bytes=8-7',
    'bytes=1-2,4-5',
    'other=0-1'
  ]) {
    assert.equal(parseByteRange(range, 10), null, range)
  }
  assert.equal(parseByteRange('bytes=0-', 0), null)
})

test('local media serves correct suffix and clamped ranges over HTTP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-range-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'audio.mp3')
  await writeFile(filePath, '0123456789')
  const remote = new RemoteHttpServer()
  const token = remote.getMediaGrants().issueFile(filePath)
  const handler = remote as unknown as MediaHandler
  const server = createServer((req, res) => {
    void handler.serveMedia(req, res, token)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/media`
  for (const range of ['bytes=-3', 'bytes=7-999', 'bytes=7-9']) {
    const response = await fetch(url, { headers: { range } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 7-9/10')
    assert.equal(await response.text(), '789')
  }
  const response = await fetch(url, { headers: { range: 'bytes=10-' } })
  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), 'bytes */10')
  await response.text()
})

test('SSE disconnects lagging clients before their buffers exceed one MiB', () => {
  const remote = new RemoteHttpServer() as unknown as MediaHandler
  const stalled = new Writable({ highWaterMark: 1, write() {} }) as unknown as ServerResponse
  remote.sseClients.add(stalled)
  let largest = 0
  for (let i = 0; i < 128; i++) {
    remote.broadcastSse('state', { text: 'x'.repeat(32768) })
    largest = Math.max(largest, stalled.writableLength)
  }
  assert.ok(largest <= 1024 * 1024)
  assert.equal(stalled.destroyed, true)
  assert.equal(remote.sseClients.size, 0)
})

test(
  'proxy settles and cancels upstream when downstream closes under backpressure',
  { timeout: 3000 },
  async (t) => {
    const remote = new RemoteHttpServer() as unknown as MediaHandler
    let cancelCount = 0
    let notifyBlocked!: () => void
    const blocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve
    })
    const stalled = new Writable({
      highWaterMark: 1,
      write() {
        notifyBlocked()
      }
    }) as unknown as ServerResponse
    stalled.writeHead = () => stalled
    let upstreamSignal: AbortSignal | null | undefined
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      upstreamSignal = options.signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
          },
          cancel() {
            cancelCount++
          }
        })
      )
    })
    const operation = remote.proxyRemoteMedia(
      { headers: {} } as IncomingMessage,
      stalled,
      'https://example.com/audio',
      'audio/mpeg'
    )
    await blocked
    stalled.destroy()
    await operation
    assert.equal(cancelCount, 1)
    assert.equal(upstreamSignal?.aborted, true)
  }
)

test(
  'proxy aborts a pending upstream connection on downstream close',
  { timeout: 3000 },
  async (t) => {
    const remote = new RemoteHttpServer() as unknown as MediaHandler
    const downstream = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      }
    }) as unknown as ServerResponse
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    let aborted = false
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('aborted'))
            },
            { once: true }
          )
          notifyStarted()
        })
    )
    const operation = remote.proxyRemoteMedia(
      { headers: {} } as IncomingMessage,
      downstream,
      'https://example.com/audio',
      'audio/mpeg'
    )
    await started
    downstream.destroy()
    await operation
    assert.equal(aborted, true)
  }
)

test('default remote root serves the complete UI and packaging includes its runtime assets', async (t) => {
  const server = new RemoteHttpServer()
  const status = await server.start()
  t.after(() => server.stop())
  for (const path of ['/', '/remote.js', '/remote.css']) {
    const response = await fetch(`http://127.0.0.1:${status.port}${path}`)
    assert.equal(response.status, 200, path)
    assert.ok((await response.text()).length > 0)
  }
  const packaging = await readFile(
    new URL('../../../electron-builder.yml', import.meta.url),
    'utf8'
  )
  assert.match(packaging, /from: resources\/remote\s+to: remote/)
  const source = await readFile(new URL('./httpServer.ts', import.meta.url), 'utf8')
  assert.match(source, /app\.isPackaged\s*\? join\(process\.resourcesPath, 'remote'\)/)
  const ipcSource = await readFile(new URL('./remoteIpc.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(ipcSource, /staticRoot\s*:/)
})

test('packaged remote root serves the UI from process resources', async (t) => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'twilight-remote-test-'))
  const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const previousPackaged = process.env.TWILIGHT_TEST_REMOTE_PACKAGED
  t.after(async () => {
    if (previousResourcesPath)
      Object.defineProperty(process, 'resourcesPath', previousResourcesPath)
    else Reflect.deleteProperty(process, 'resourcesPath')
    if (previousPackaged === undefined) delete process.env.TWILIGHT_TEST_REMOTE_PACKAGED
    else process.env.TWILIGHT_TEST_REMOTE_PACKAGED = previousPackaged
    await rm(resourcesPath, { recursive: true, force: true })
  })
  await cp(new URL('../../../resources/remote', import.meta.url), join(resourcesPath, 'remote'), {
    recursive: true
  })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
  process.env.TWILIGHT_TEST_REMOTE_PACKAGED = '1'

  const server = new RemoteHttpServer()
  const status = await server.start()
  t.after(() => server.stop())
  for (const path of ['/', '/remote.js', '/remote.css']) {
    const response = await fetch(`http://127.0.0.1:${status.port}${path}`)
    assert.equal(response.status, 200, path)
    assert.ok((await response.text()).length > 0)
  }
})

async function fixture(t: test.TestContext) {
  const server = new RemoteHttpServer({
    auth: new RemoteAuthSession({ pin: '123456' }),
    staticRoot: fileURLToPath(new URL('../../../resources/remote', import.meta.url))
  })
  const status = await server.start()
  t.after(() => server.stop())
  const base = `http://127.0.0.1:${status.port}`
  const pair = await fetch(`${base}/api/pair`, {
    method: 'POST',
    body: JSON.stringify({ pin: '123456' })
  })
  const { token } = (await pair.json()) as { token: string }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } })
  return { server, base, request }
}

test('real remote HTTP requires auth, validates and bounds browse before invoking renderer', async (t) => {
  const { server, base, request } = await fixture(t)
  let calls = 0
  server.setBrowseHandler(async (query) => {
    calls++
    assert.equal(query.limit, 100)
    return { items: [], total: 0, offset: query.offset, limit: query.limit }
  })
  assert.equal((await fetch(`${base}/api/browse?view=library`)).status, 401)
  assert.equal((await request('/api/browse?view=invalid')).status, 400)
  assert.equal((await request('/api/browse?view=library&offset=-1')).status, 400)
  assert.equal(calls, 0)
  const response = await request('/api/browse?view=library&limit=10000')
  assert.equal(response.status, 200)
  assert.equal(((await response.json()) as { limit: number }).limit, 100)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
})

test('real remote HTTP propagates stale queue and unavailable renderer, rejects missing revision', async (t) => {
  const { server, request } = await fixture(t)
  server.setCommandHandler(async () => {
    throw new RemoteCommandError('queue_changed', 409)
  })
  const command = (body: unknown) =>
    request('/api/command', { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await command({ action: 'jumpQueue', index: 0 })).status, 400)
  const stale = await command({ action: 'jumpQueue', index: 0, revision: 0 })
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), { error: 'queue_changed' })
  server.setCommandHandler(async () => {
    throw new RemoteCommandError('renderer_not_ready')
  })
  assert.equal((await command({ action: 'playTrack', id: 'opaque-id' })).status, 503)
  server.setCommandHandler(async () => {
    throw new Error('C:/private/library/secret.flac')
  })
  const failure = await command({ action: 'play' })
  assert.equal(failure.status, 500)
  assert.doesNotMatch(await failure.text(), /private|secret/)
})

test('real remote HTTP limits outstanding browsing and recovers its slots after failures', async (t) => {
  const { server, request } = await fixture(t)
  let entered = 0
  let enteredResolve!: () => void
  let release!: () => void
  const allEntered = new Promise<void>((resolve) => {
    enteredResolve = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  server.setBrowseHandler(async () => {
    if (++entered === 2) enteredResolve()
    await gate
    throw new RemoteCommandError('renderer_timeout')
  })
  const first = request('/api/browse?view=library')
  const second = request('/api/browse?view=queue')
  try {
    await allEntered
    assert.equal((await request('/api/browse?view=library')).status, 429)
  } finally {
    release()
  }
  assert.equal((await first).status, 503)
  assert.equal((await second).status, 503)
  server.setBrowseHandler(async (query) => ({ items: [], total: 0, ...query }))
  assert.equal((await request('/api/browse?view=library')).status, 200)
})

test('real remote HTTP mediaOnly closes control surface and PIN rotation revokes browsing', async (t) => {
  const { server, request } = await fixture(t)
  server.setBrowseHandler(async (query) => ({ items: [], total: 0, ...query }))
  assert.equal((await request('/remote.js')).status, 200)
  server.rotatePin()
  assert.equal((await request('/api/browse?view=library')).status, 401)
  await server.start(0, { mode: 'mediaOnly' })
  for (const path of ['/', '/remote.js', '/api/state', '/api/browse?view=library', '/api/events']) {
    assert.equal((await request(path)).status, 404, path)
  }
  assert.equal(server.getStatus().pin, null)
  assert.equal(server.getStatus().enabled, false)
})

test('Core bridge discovery, RPC and initial SSE use the authenticated existing LAN surface', async (t) => {
  const { server, base, request } = await fixture(t)
  const discovery = () => fetch(`${base}/api/status`).then((response) => response.json())
  assert.equal(((await discovery()) as { coreBridge: boolean }).coreBridge, false)
  let calls = 0
  server.setCoreRpcHandler(async (envelope) => {
    calls++
    return {
      kind: 'response',
      requestId: envelope.requestId,
      epoch: 'desktop',
      ok: true,
      value: { connected: true }
    }
  })
  const status = (await discovery()) as {
    coreBridge: boolean
    coreBridgeVersion: number
    capabilities: { queries: string[]; commands: string[] }
  }
  assert.equal(status.coreBridge, true)
  assert.equal(status.coreBridgeVersion, 1)
  assert.ok(status.capabilities.queries.includes('metadata.entity.detail'))
  assert.ok(status.capabilities.commands.includes('playback.replaceQueue'))
  assert.ok(!status.capabilities.queries.includes('library.paths.lookup'))
  assert.ok(!status.capabilities.queries.includes('providers.session'))
  const payload = {
    requestId: 'phone',
    epoch: 'epoch-boot',
    kind: 'query',
    name: 'core.getSnapshot',
    payload: {}
  }
  assert.equal(
    (await fetch(`${base}/api/core/rpc`, { method: 'POST', body: JSON.stringify(payload) })).status,
    401
  )
  assert.equal((await request('/api/core/rpc', { method: 'POST', body: '{}' })).status, 400)
  assert.equal(calls, 0)
  const response = await request('/api/core/rpc', { method: 'POST', body: JSON.stringify(payload) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    kind: 'response',
    requestId: 'phone',
    epoch: 'desktop',
    ok: true,
    value: { connected: true }
  })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const state = {
    kind: 'state',
    epoch: 'desktop',
    sequence: 1,
    snapshot: { epoch: 'desktop', sequence: 1 }
  }
  server.updateCoreStateEvent(state)
  assert.equal((await fetch(`${base}/api/core/events`)).status, 401)
  const events = await request('/api/core/events')
  const reader = events.body!.getReader()
  let initial = ''
  try {
    while (!initial.includes(`data: ${JSON.stringify(state)}\n\n`)) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      initial += new TextDecoder().decode(chunk.value)
    }
    assert.match(initial, /event: core_state/)
  } finally {
    await reader.cancel()
  }
  server.rotatePin()
  assert.equal(
    (await request('/api/core/rpc', { method: 'POST', body: JSON.stringify(payload) })).status,
    401
  )
  assert.equal(calls, 1)
  await server.start(0, { mode: 'mediaOnly' })
  assert.equal((await request('/api/core/events')).status, 404)
  assert.equal(
    (await request('/api/core/rpc', { method: 'POST', body: JSON.stringify(payload) })).status,
    404
  )
})

test('RPC carries a bounded personal bitmap while legacy command bodies keep their smaller limit', async t => {
  const { server, base, request } = await fixture(t)
  let calls = 0
  const dataUrl = 'data:image/png;base64,' + Buffer.alloc(2 * 1024 * 1024).toString('base64')
  const body = JSON.stringify({ requestId: 'artwork', epoch: 'desktop', kind: 'command',
    name: 'metadata.entity.artworkOverride', payload: { entityId: 'artist', revision: 1, mode: 'value', language: 'zh-Hans', dataUrl } })
  server.setCoreRpcHandler(async envelope => {
    calls++
    assert.equal((envelope.payload as { dataUrl: string }).dataUrl, dataUrl)
    return { requestId: envelope.requestId, ok: true }
  })
  assert.equal((await fetch(`${base}/api/core/rpc`, { method: 'POST', body })).status, 401)
  const response = await request('/api/core/rpc', { method: 'POST', body })
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { ok: boolean }).ok, true)
  assert.equal(calls, 1)
  await assert.rejects(request('/api/core/rpc', { method: 'POST', body: body + ' '.repeat(64 * 1024), signal: AbortSignal.timeout(5000) }))
  await assert.rejects(request('/api/command', { method: 'POST', body: JSON.stringify({ type: 'play', extra: 'x'.repeat(65 * 1024) }), signal: AbortSignal.timeout(5000) }))
  assert.equal(calls, 1)
})

test('HTTP cannot export a provider session, including forged TLS headers and payloads', async t => {
  const { server, base, request } = await fixture(t)
  let reads = 0
  const bridge = new RemoteCoreBridge({
    snapshot: () => ({ phase: 'ready', epoch: 'desktop' }) as CoreSnapshot,
    request: (async () => { throw new Error('Unexpected Core request') }) as never,
    playback: {} as never,
    resolveCover: async () => null,
    signal: new AbortController().signal,
    failed: error => { throw error },
    providerSession: async () => { reads++; return { providerId: 'ncm', loggedIn: true, cookie: 'MUSIC_U=private' } }
  })
  server.setCoreRpcHandler((envelope, principal, context) => {
    assert.equal(context?.encrypted, false)
    return bridge.handle(envelope, principal, context)
  })
  const payload = { requestId: 'session', epoch: 'desktop', kind: 'query', name: 'providers.session', payload: { providerId: 'ncm' } }
  const init = { method: 'POST', body: JSON.stringify(payload),
    headers: { 'x-forwarded-proto': 'https', forwarded: 'proto=https' } }
  assert.equal((await fetch(`${base}/api/core/rpc`, init)).status, 401)
  const response = await request('/api/core/rpc', init)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await response.json() as { ok: boolean; error: { code: string } }
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'FORBIDDEN')
  assert.doesNotMatch(JSON.stringify(result), /MUSIC_U|cookie|private/)
  payload.payload = { providerId: 'ncm', encrypted: true } as typeof payload.payload
  assert.equal((await (await request('/api/core/rpc', { ...init, body: JSON.stringify(payload) })).json() as typeof result).error.code, 'INVALID_REQUEST')
  assert.equal(reads, 0)
})

test('revocation while awaiting a provider session prevents sending the completed credential reply', async t => {
  const { server, request } = await fixture(t)
  server.setCoreRpcHandler(async envelope => {
    server.rotatePin()
    return { requestId: envelope.requestId, ok: true, value: { cookie: 'MUSIC_U=must-not-send' } }
  })
  const response = await request('/api/core/rpc', { method: 'POST', body: JSON.stringify({
    requestId: 'session', epoch: 'desktop', kind: 'query', name: 'providers.session', payload: { providerId: 'ncm' }
  }) })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.doesNotMatch(await response.text(), /cookie|MUSIC_U|must-not-send/)
})
