import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { DiagnosticStore } from './store.ts'
import { DiagnosticWriterClient } from './client.ts'
import {
  configureDiagnosticLogger,
  writeDiagnostic,
  forwardDiagnosticEvent,
  withDiagnosticContext
} from './logger.ts'
import { sanitizeDiagnosticValue, sanitizeDiagnosticText } from './sanitize.ts'
import {
  installIpcDiagnostics,
  observeDiagnosticOperation,
  flushDiagnosticAggregates,
  diagnosticInFlight,
  unwrapObservedIpc
} from './observation.ts'
import { exportDiagnosticBundle, collectDiagnosticSnapshots } from './bundle.ts'
import { installNetworkDiagnostics } from './network.ts'
import type { DiagnosticEvent } from '../../shared/diagnostics.ts'
import {
  createRemoteMediaRequestHandler,
  RemoteMediaGrantService
} from '../security/remoteMediaGrants.ts'
import { createRemoteCoverCache } from '../cache/remoteCoverCache.ts'

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-logs-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function event(index: number, level: DiagnosticEvent['level'] = 'debug'): DiagnosticEvent {
  return {
    schemaVersion: 1,
    eventId: `test:${index}`,
    sessionId: 'test',
    processId: process.pid,
    processRole: 'test',
    processInstanceId: 'test',
    sequence: index,
    timestamp: new Date(1700000000000 + index).toISOString(),
    monotonicMs: index,
    module: 'test',
    event: 'sample',
    level,
    details: { payload: 'x'.repeat(4000) }
  }
}
async function readZip(file: string): Promise<Map<string, Buffer>> {
  const yauzl = createRequire(import.meta.url)('yauzl')
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error: Error, zip: any) => {
      if (error) return reject(error)
      const result = new Map<string, Buffer>()
      zip.on('error', reject)
      zip.on('end', () => resolve(result))
      zip.readEntry()
      zip.on('entry', (entry: any) =>
        zip.openReadStream(entry, (error: Error, stream: any) => {
          if (error) return reject(error)
          const buffers: Buffer[] = []
          stream.on('data', (data: Buffer) => buffers.push(data))
          stream.on('error', reject)
          stream.on('end', () => {
            result.set(entry.fileName, Buffer.concat(buffers))
            zip.readEntry()
          })
        })
      )
    })
  )
}

test('concurrent writes preserve every event, rotate, and snapshots remain fixed', async (t) => {
  const directory = await fixture(t)
  const store = new DiagnosticStore({ directory, maxFileBytes: 600, maxTotalBytes: 100000 })
  await store.initialize()
  await Promise.all(
    Array.from({ length: 100 }, (_, i) => store.append([JSON.stringify({ i }) + '\n']))
  )
  const files = await store.listFiles()
  assert.ok(files.length > 1)
  assert.ok(files.every((file) => file.bytes <= 600))
  const snapshot = join(directory, 'snapshot')
  await store.snapshot(snapshot)
  await store.append(['{"i":100}\n'])
  const lines = (
    await Promise.all(
      (await readdir(snapshot)).map((name) => readFile(join(snapshot, name), 'utf8'))
    )
  )
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).i)
  assert.deepEqual(
    lines.sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, i) => i)
  )
})
test('retention, capacity, restart and cleanup preserve live logs and unrelated files', async (t) => {
  const directory = await fixture(t)
  const now = Date.now()
  await writeFile(join(directory, 'app-999999-old-0.active.jsonl'), '{"torn":')
  await utimes(
    join(directory, 'app-999999-old-0.active.jsonl'),
    new Date(now - 8 * 86400000),
    new Date(now - 8 * 86400000)
  )
  await writeFile(join(directory, 'keep.txt'), 'unrelated')
  const store = new DiagnosticStore({ directory, maxFileBytes: 100, maxTotalBytes: 200 })
  await store.initialize()
  assert.equal((await store.listFiles()).length, 0)
  for (let i = 0; i < 20; i++) await store.append(['x'.repeat(49) + '\n'])
  assert.ok((await store.status()).bytes <= 200)
  const restarted = new DiagnosticStore({ directory, maxFileBytes: 100, maxTotalBytes: 200 })
  await restarted.initialize()
  await restarted.append(['restart\n'])
  await restarted.clearHistory()
  assert.ok((await restarted.listFiles()).every((file) => file.active))
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'unrelated')
  await assert.rejects(restarted.append(['x'.repeat(201)]))
})
test('disk failure rejects without recursive logging, queue overload is bounded and prioritizes errors', async (t) => {
  const directory = await fixture(t)
  const blocked = join(directory, 'blocked')
  await writeFile(blocked, 'file')
  const store = new DiagnosticStore({ directory: blocked })
  await assert.rejects(store.initialize())
  const client = new DiagnosticWriterClient(blocked, new URL('./writerWorker.ts', import.meta.url))
  t.after(() => client.close())
  for (let i = 0; i < 2000; i++) client.record(event(i))
  client.record(event(2001, 'error'))
  await pause(500)
  const status = await client.status()
  assert.ok(status.queuedBytes <= 4 * 1024 * 1024)
  assert.ok(status.droppedEvents > 0)
  assert.ok(status.error)
  assert.ok(client.memoryEvents().some((item) => item.level === 'error'))
  assert.ok(Buffer.byteLength(JSON.stringify(client.memoryEvents())) < 1100000)
})
test('worker crash still exports saved logs and advertises missing acknowledgement', async (t) => {
  const directory = await fixture(t)
  const client = new DiagnosticWriterClient(
    directory,
    new URL('./writerWorker.ts', import.meta.url)
  )
  t.after(() => client.close())
  await pause(300)
  client.record(event(1))
  await client.flush()
  await (client as any).worker.terminate()
  await pause(50)
  assert.ok((await client.status()).error)
  const snapshot = await client.snapshot(join(directory, 'snapshot'))
  assert.ok(snapshot.files.length)
  assert.ok(snapshot.missing.some((item) => item.includes('writer unavailable')))
})
test('nested secrets, URLs, paths, errors, accessors and cycles are sanitized', () => {
  assert.ok(
    !sanitizeDiagnosticText('{"cookie":"json-secret","authToken":"json-token"}').includes(
      'json-secret'
    )
  )
  assert.ok(
    !sanitizeDiagnosticText('Cookie: sid=first-secret; second=second-secret').includes(
      'second-secret'
    )
  )
  assert.ok(!sanitizeDiagnosticText('data:audio/wav;base64,ZmFrZWF1ZGlv').includes('ZmFrZWF1ZGlv'))
  const input: any = {
    password: 'secret-a',
    Cookie: 'cookie-a',
    authToken: 'token-a',
    url: 'https://user:pass@server.test/song.flac?signature=abc',
    path: 'C:\\Users\\private\\song.flac',
    error: Object.assign(new Error('Bearer abc123 https://server.test/song?token=abc'), {
      code: 'EIO',
      cause: new Error('password=oops')
    }),
    nested: { authorization: 'hidden' }
  }
  input.circular = input
  Object.defineProperty(input, 'danger', {
    enumerable: true,
    get() {
      throw new Error('getter called')
    }
  })
  const value = sanitizeDiagnosticValue(input) as any
  assert.ok(
    !JSON.stringify(
      sanitizeDiagnosticValue({ 'https://private.example/song?token=key-secret': true })
    ).includes('private.example')
  )
  const text = JSON.stringify(value)
  for (const secret of [
    'secret-a',
    'cookie-a',
    'token-a',
    'server.test',
    'private',
    'oops',
    'abc123',
    'hidden'
  ])
    assert.ok(!text.includes(secret), secret)
  assert.equal(value.error.code, 'EIO')
  assert.equal(value.circular, '[circular]')
  assert.equal(value.danger, '[accessor omitted]')
})
test('operation chains retain request ids, failures, timeout and cancellations; business result is untouched', async () => {
  const entries: DiagnosticEvent[] = []
  configureDiagnosticLogger({}, (entry) => entries.push(entry))
  const original = { result: 1 }
  const result = await withDiagnosticContext({ operationId: 'operation' }, () =>
    observeDiagnosticOperation('test', 'fetch', async () => original, [], { requestId: 'request' })
  )
  assert.equal(result, original)
  assert.equal(entries[0].operationId, 'operation')
  assert.equal(entries[1].requestId, 'request')
  await assert.rejects(
    observeDiagnosticOperation('test', 'fetch', async () => {
      throw Object.assign(new Error('timeout'), { code: 'ERR_TIMEOUT' })
    })
  )
  assert.ok(entries.some((entry) => entry.event === 'request.timeout'))
  assert.equal(diagnosticInFlight().length, 0)
  assert.throws(() =>
    observeDiagnosticOperation('test', 'fetch', () => {
      throw Object.assign(new Error('cancel'), { name: 'AbortError' })
    })
  )
  assert.ok(entries.some((entry) => entry.event === 'request.cancelled'))
  forwardDiagnosticEvent({ ...event(1), eventId: 'https://secret.invalid/' })
  assert.ok(!entries.some((entry) => entry.eventId.includes('secret.invalid')))
  writeDiagnostic('test', 'oversized', { value: 'x'.repeat(100000) })
  assert.ok(Buffer.byteLength(JSON.stringify(entries.at(-1))) <= 16384)
})
test('IPC unwrap keeps legacy and observed args compatible, once/duplicate listener removal works', async () => {
  class Ipc extends EventEmitter {
    handles = new Map<string, any>()
    handle(channel: string, fn: any) {
      this.handles.set(channel, fn)
    }
  }
  const transport = new Ipc()
  const restore = installIpcDiagnostics(transport, (event) => event.trusted)
  const sender = { trusted: true }
  const wire = {
    __twilightDiagnosticEnvelope: 1,
    context: { requestId: 'request' },
    args: [7, 'value']
  }
  transport.handle('test:call', (_event: any, ...args: unknown[]) => args)
  assert.deepEqual(await transport.handles.get('test:call')(sender, wire), [7, 'value'])
  assert.deepEqual(transport.handles.get('test:call')(sender, 8), [8])
  assert.throws(() => unwrapObservedIpc([{ ...wire, args: Array(33).fill(0) }]))
  let calls = 0
  const listener = (_event: any, value: unknown) => {
    assert.equal(value, 7)
    calls++
  }
  transport.once('test:event', listener)
  transport.emit('test:event', sender, { ...wire, args: [7] })
  transport.emit('test:event', sender, { ...wire, args: [7] })
  assert.equal(calls, 1)
  transport.on('test:event', listener)
  transport.on('test:event', listener)
  transport.removeListener('test:event', listener)
  transport.emit('test:event', sender, { ...wire, args: [7] })
  assert.equal(calls, 2)
  transport.removeListener('test:event', listener)
  assert.equal(transport.listenerCount('test:event'), 0)

  const entries: DiagnosticEvent[] = []
  configureDiagnosticLogger({}, (entry) => entries.push(entry))
  flushDiagnosticAggregates()
  entries.length = 0
  for (const method of ['BridgeStatus', 'GetDspGraphStatus', 'EnumerateDevices']) {
    observeDiagnosticOperation('audio.rpc', method, () => 'ok')
    observeDiagnosticOperation('audio.rpc', method, () => 'ok')
  }
  transport.handle('core-window:request', (_event: any, payload: any) => payload)
  await transport.handles.get('core-window:request')(sender, {
    connectionId: 'c1',
    request: { kind: 'query', name: 'zones.state', payload: {}, requestId: 'r1', epoch: 'e1' }
  })
  await transport.handles.get('core-window:request')(sender, {
    connectionId: 'c1',
    request: { kind: 'query', name: 'zones.state', payload: {}, requestId: 'r2', epoch: 'e1' }
  })
  await transport.handles.get('core-window:request')(sender, {
    connectionId: 'c1',
    request: { kind: 'command', name: 'playback.pause', payload: {}, requestId: 'r3', epoch: 'e1' }
  })
  assert.equal(
    entries.filter((entry) => entry.event === 'request.start').length,
    1,
    'only command requests should write individual request.start events'
  )
  assert.equal(
    (entries.find((entry) => entry.event === 'request.start')!.details as any).method,
    'core-window:request:playback.pause'
  )
  flushDiagnosticAggregates()
  const summaries = entries.filter((entry) => entry.event === 'requests.summary')
  for (const expectedMethod of [
    'BridgeStatus',
    'GetDspGraphStatus',
    'EnumerateDevices',
    'core-window:request:zones.state'
  ]) {
    const summary = summaries.find((entry) => (entry.details as any).method === expectedMethod)
    assert.ok(summary, `expected aggregated summary for ${expectedMethod}`)
    assert.equal((summary!.details as any).count, 2)
  }
  restore()
})
test('ZIP sorts and deduplicates the timeline, sanitizes all files, rejects torn lines, records hashes and hung collectors', async (t) => {
  const directory = await fixture(t)
  const source = join(directory, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'app-999999-test.jsonl'),
    [event(2), event(1), event(1)]
      .map((item) =>
        JSON.stringify({
          ...item,
          details: { password: 'zip-secret', path: 'C:\\secret\\song.wav' }
        })
      )
      .join('\n') + '\n{"torn":'
  )
  const store = new DiagnosticStore({ directory: source })
  const destination = join(directory, 'bundle.zip')
  const result = await exportDiagnosticBundle({
    destination,
    collectors: [
      { name: 'good', collect: () => ({ cookie: 'zip-secret' }) },
      {
        name: 'failure',
        collect: () => {
          throw new Error('failure')
        }
      },
      { name: 'hung', collect: () => new Promise(() => {}) }
    ],
    snapshot: (dest) => store.snapshot(dest),
    status: { droppedEvents: 3 }
  })
  assert.equal(result.manifest.coverage.events, 2)
  assert.equal(result.manifest.coverage.duplicates, 1)
  assert.equal(result.manifest.coverage.invalidLines, 1)
  assert.ok(result.manifest.snapshotFailures.includes('hung'))
  const zip = await readZip(destination)
  for (const file of result.manifest.files) {
    const buffer = zip.get(file.name)!
    assert.equal(createHash('sha256').update(buffer).digest('hex'), file.sha256)
    assert.ok(!buffer.includes(Buffer.from('zip-secret')))
    assert.ok(!buffer.includes(Buffer.from('C:\\secret')))
  }
  const events = zip
    .get('timeline.jsonl')!
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(events[0].sequence, 1)
  const started = Date.now()
  const timeout = await collectDiagnosticSnapshots(
    [{ name: 'hung', collect: () => new Promise(() => {}) }],
    20,
    30
  )
  assert.equal(timeout[0].status, 'timeout')
  assert.ok(Date.now() - started < 200)
})
test('network failure and aborted blocked requests log independently and preserve errors', async (t) => {
  const entries: DiagnosticEvent[] = []
  configureDiagnosticLogger({}, (event) => entries.push(event))
  installNetworkDiagnostics()
  const server = createServer((_request, response) => {
    if (_request.url === '/ok') response.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}`
  assert.equal(await (await fetch(url + '/ok')).text(), 'ok')
  await assert.rejects(fetch(url + '/blocked', { signal: AbortSignal.timeout(50) }))
  assert.ok(entries.some((entry) => entry.event === 'request.failed'))
  assert.ok(!JSON.stringify(entries).includes('127.0.0.1'))
})

test('disk-full failures are acknowledged, retained in memory and counted without recursive output', async (t) => {
  const directory = await fixture(t)
  const worker = join(directory, 'full-worker.cjs')
  await writeFile(
    worker,
    `const fs = require('node:fs/promises'); fs.appendFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }; require('node:module').syncBuiltinESMExports(); import(${JSON.stringify(new URL('./writerWorker.ts', import.meta.url).href)});`
  )
  const client = new DiagnosticWriterClient(join(directory, 'logs'), worker)
  t.after(() => client.close())
  await pause(200)
  client.record(event(1, 'error'))
  await pause(300)
  const status = await client.status()
  assert.ok(status.error?.includes('ENOSPC'))
  assert.ok(status.droppedEvents >= 1)
  assert.ok(client.memoryEvents().some((entry) => entry.eventId === 'test:1'))
})

test('native and legacy ring events share a canonical export id and missing capabilities are explicit', async (t) => {
  const directory = await fixture(t)
  const source = join(directory, 'logs')
  await mkdir(source)
  const native = {
    ...event(1),
    processRole: 'native',
    requestId: 'native-request',
    nativeSequence: 17
  }
  const legacy = { ...event(2), details: { engineSequence: 17, engineTimestamp: native.timestamp } }
  await writeFile(join(source, 'native-999999-test.jsonl'), JSON.stringify(native) + '\n')
  await writeFile(join(source, 'app-999999-test.jsonl'), JSON.stringify(legacy) + '\n')
  const store = new DiagnosticStore({ directory: source })
  const result = await exportDiagnosticBundle({
    destination: join(directory, 'bundle.zip'),
    snapshot: (directory) => store.snapshot(directory),
    collectors: [{ name: 'native.capabilities', collect: () => ({ available: false }) }]
  })
  assert.equal(result.manifest.coverage.events, 1)
  assert.equal(result.manifest.coverage.duplicates, 1)
  assert.ok(result.manifest.missing.includes('native.capabilities: unavailable'))
  const zip = await readZip(result.filePath)
  const timeline = JSON.parse(zip.get('timeline.jsonl')!.toString().trim())
  assert.equal(timeline.requestId, 'native-request')
})

test('cover diagnostics correlate grants, CDN hops, cache and body completion without leaking URLs', async (t) => {
  const directory = await fixture(t)
  const entries: DiagnosticEvent[] = []
  configureDiagnosticLogger({}, (entry) => entries.push(entry))
  t.after(() => configureDiagnosticLogger({}, () => {}))
  const grants = new RemoteMediaGrantService()
  const source = 'https://private-cover.example/art.jpg?token=do-not-log'
  const handle = grants.grant(source, 'image')
  let calls = 0
  const handler = createRemoteMediaRequestHandler({
    grants,
    imageCache: createRemoteCoverCache(() => directory),
    fetch: async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://private-edge.example/art.jpg?signature=hidden' }
          })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
  })
  const response = await handler(new Request(handle))
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]))
  const firstRequest = entries.find((e) => e.event === 'request.start')!.requestId
  for (const name of [
    'authorization.complete',
    'upstream.redirect',
    'body.complete',
    'write.complete',
    'response.ready'
  ]) {
    assert.equal(entries.find((e) => e.event === name)!.requestId, firstRequest, name)
  }
  const granted = entries.find((e) => e.event === 'grant.issued')!.details as any
  const authorized = entries.find((e) => e.event === 'authorization.complete')!.details as any
  assert.deepEqual(granted.handleUrl, authorized.handleUrl)
  assert.deepEqual(granted.source, authorized.source)
  assert.equal((entries.find((e) => e.event === 'body.complete')!.details as any).bytes, 3)
  await (await handler(new Request(handle))).arrayBuffer()
  assert.equal(calls, 2, 'cache hit must not download again')
  const hit = entries.find((e) => e.event === 'read.hit')!
  assert.notEqual(hit.requestId, firstRequest)
  assert.doesNotMatch(
    JSON.stringify(entries),
    /private-cover|private-edge|do-not-log|signature=hidden|img-[a-f0-9]{48}/
  )
  // Diagnostic observer failures must not break the media response.
  configureDiagnosticLogger({}, () => {
    throw new Error('log sink unavailable')
  })
  assert.equal((await handler(new Request(handle))).status, 200)
})

test('cover diagnostics distinguish HTTP, MIME, authorization, connection and mid-body failures', async (t) => {
  const entries: DiagnosticEvent[] = []
  configureDiagnosticLogger({}, (entry) => entries.push(entry))
  t.after(() => configureDiagnosticLogger({}, () => {}))
  const grants = new RemoteMediaGrantService()
  const handle = grants.grant('https://cover.example/art.jpg', 'image')
  for (const [response, reason, status] of [
    [new Response('denied', { status: 403 }), 'upstream-status', 502],
    [new Response('<html>', { headers: { 'content-type': 'text/html' } }), 'content-type', 415],
    [
      new Response(null, {
        headers: { 'content-type': 'image/png', 'content-length': '999999999' }
      }),
      'content-length',
      413
    ]
  ] as const) {
    entries.length = 0
    const handler = createRemoteMediaRequestHandler({ grants, fetch: async () => response })
    assert.equal((await handler(new Request(handle))).status, status)
    assert.equal((entries.find((e) => e.event === 'request.failed')!.details as any).reason, reason)
    assert.ok(entries.some((e) => e.event === 'upstream.response.headers'))
    assert.ok(!entries.some((e) => e.event === 'body.complete'))
  }
  entries.length = 0
  const failing = createRemoteMediaRequestHandler({
    grants,
    fetch: async () => {
      throw Object.assign(new Error('connect failed'), { code: 'ECONNRESET' })
    }
  })
  assert.equal((await failing(new Request('twilight-media://image/expired'))).status, 403)
  assert.equal((entries.at(-1)!.details as any).reason, 'authorization')
  assert.equal((await failing(new Request(handle))).status, 502)
  assert.equal((entries.at(-1)!.details as any).error.code, 'ECONNRESET')
  entries.length = 0
  const broken = createRemoteMediaRequestHandler({
    grants,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('body interrupted'))
          }
        }),
        { headers: { 'content-type': 'image/png' } }
      )
  })
  const result = await broken(new Request(handle))
  await assert.rejects(result.arrayBuffer(), /body interrupted/)
  assert.equal(entries.filter((e) => e.event === 'body.failed').length, 1)
  assert.ok(!entries.some((e) => e.event === 'body.complete'))
  entries.length = 0
  const stream = createRemoteMediaRequestHandler({
    grants,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]))
          }
        }),
        { headers: { 'content-type': 'image/png' } }
      )
  })
  await (await stream(new Request(handle))).body!.cancel()
  assert.ok(entries.some((e) => e.event === 'body.cancelled'))
  assert.ok(!entries.some((e) => e.event === 'body.complete'))
  entries.length = 0
  const pending = createRemoteMediaRequestHandler({
    grants,
    fetch: async () =>
      new Response(new ReadableStream(), { headers: { 'content-type': 'image/png' } })
  })
  const pendingResponse = await pending(new Request(handle))
  const reader = pendingResponse.body!.getReader()
  const read = reader.read()
  await reader.cancel()
  await read
  assert.equal(entries.filter((e) => e.event === 'body.cancelled').length, 1)
  assert.ok(!entries.some((e) => e.event === 'body.complete' || e.event === 'body.failed'))
})

test('cover cache diagnostics distinguish disabled, corrupt and failed writes while retaining fallback behavior', async (t) => {
  const directory = await fixture(t)
  const entries: DiagnosticEvent[] = []
  configureDiagnosticLogger({}, (entry) => entries.push(entry))
  t.after(() => configureDiagnosticLogger({}, () => {}))
  const source = 'https://cover.example/private.jpg'
  const cache = createRemoteCoverCache(() => directory)
  assert.equal(await createRemoteCoverCache(() => null).read(source), null)
  assert.equal((entries.at(-1)!.details as any).reason, 'disabled')
  assert.equal(await cache.read(source), null)
  assert.equal((entries.at(-1)!.details as any).reason, 'not-found')
  const file = join(directory, `${createHash('sha256').update(source).digest('hex')}.remote`)
  await writeFile(file, 'invalid-header')
  assert.equal(await cache.read(source), null)
  assert.equal((entries.at(-1)!.details as any).reason, 'invalid-header')
  const blocker = join(directory, 'not-a-directory')
  await writeFile(blocker, 'blocked')
  await createRemoteCoverCache(() => blocker).write(source, 'image/png', new Uint8Array([1]))
  assert.equal(entries.at(-1)!.event, 'write.failed')
  assert.doesNotMatch(JSON.stringify(entries), /private\.jpg|not-a-directory/)
})

test('external sort merges multiple bounded chunks without holding the complete log', async (t) => {
  const directory = await fixture(t)
  const source = join(directory, 'logs')
  await mkdir(source)
  await writeFile(
    join(source, 'app-999999-large.jsonl'),
    Array.from({ length: 1100 }, (_, index) => JSON.stringify(event(1099 - index)) + '\n').join('')
  )
  const store = new DiagnosticStore({ directory: source })
  const result = await exportDiagnosticBundle({
    destination: join(directory, 'bundle.zip'),
    snapshot: (directory) => store.snapshot(directory),
    collectors: []
  })
  assert.equal(result.manifest.coverage.events, 1100)
  const zip = await readZip(result.filePath)
  const lines = zip.get('timeline.jsonl')!.toString().trim().split('\n')
  assert.equal(JSON.parse(lines[0]).sequence, 0)
  assert.equal(JSON.parse(lines.at(-1)!).sequence, 1099)
})
