import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { Agent, MockAgent } from 'undici'
import { NcmApiService } from '../../core/providers/ncmApi.ts'
import { waitForListeningPort } from './serverBinding.ts'
import { createNcmLoopbackTransport } from './runtimeAdapter.ts'

test('the production NCM transport reaches Fetch-restricted ports and retains redirects and headers', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  const server = agent.get('http://127.0.0.1:6000')
  server
    .intercept({ path: '/redirect', method: 'GET', headers: { cookie: 'a=1' } })
    .reply(302, '', {
      headers: { location: '/result' }
    })
  server
    .intercept({ path: '/result', method: 'GET', headers: { cookie: 'a=1' } })
    .reply(200, '{"code":200}', {
      headers: { 'content-type': 'application/json' }
    })
  const transport = createNcmLoopbackTransport(agent)
  try {
    const response = await transport.fetch('http://127.0.0.1:6000/redirect', {
      signal: new AbortController().signal,
      headers: { cookie: 'a=1' }
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.deepEqual(JSON.parse(await response.text()), { code: 200 })
    agent.assertNoPendingInterceptors()
  } finally {
    await transport.closeTransport()
  }
})

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test('NCM API binding reports its actual isolated port instead of a foreign listener', async () => {
  const foreignServer = createServer((_request, response) => response.end('foreign-service'))
  const ncmServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end('{"service":"ncm"}')
  })

  try {
    foreignServer.listen(0, '127.0.0.1')
    const foreignPort = await waitForListeningPort(foreignServer)

    ncmServer.listen(0, '127.0.0.1')
    const ncmPort = await waitForListeningPort(ncmServer)

    assert.notEqual(ncmPort, foreignPort)
    const response = await fetch(`http://127.0.0.1:${ncmPort}/login/qr/key`)
    assert.deepEqual(await response.json(), { service: 'ncm' })
  } finally {
    await Promise.all([closeServer(ncmServer), closeServer(foreignServer)])
  }
})

test('NCM API binding rejects when the server cannot listen', async () => {
  const foreignServer = createServer()
  const collidingServer = createServer()

  try {
    foreignServer.listen(0, '127.0.0.1')
    const foreignPort = await waitForListeningPort(foreignServer)
    collidingServer.listen(foreignPort, '127.0.0.1')

    await assert.rejects(waitForListeningPort(collidingServer), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'EADDRINUSE')
      return true
    })
  } finally {
    await closeServer(foreignServer)
  }
})

test('account library reads, FM, radar and writes bypass gateway caches while ordinary playback keeps caching', async () => {
  let now = 1000
  const urls: URL[] = []
  const api = new NcmApiService({
    startServer: async () => createServer().listen(0, '127.0.0.1'),
    now: () => now,
    fetch: async (url) => {
      urls.push(new URL(String(url)))
      return new Response('{"code":200,"data":[]}')
    }
  })
  try {
    for (const path of [
      '/personal_fm',
      '/personal/fm/mode?mode=DEFAULT',
      '/playlist/tracks?op=add',
      '/like?id=1',
      '/user/playlist?uid=42&limit=1000',
      '/user/detail?uid=42',
      '/user/cloud?limit=50',
      '/likelist?uid=42'
    ]) {
      await api.request(path)
      now++
      await api.request(path)
      const [first, second] = urls.slice(-2)
      assert.equal(first.searchParams.get('timestamp'), String(now - 1))
      assert.equal(second.searchParams.get('timestamp'), String(now))
      if (path.includes('mode=')) assert.equal(second.searchParams.get('mode'), 'DEFAULT')
    }
    await api.request('/song/url?id=93')
    assert.equal(urls.at(-1)!.searchParams.has('timestamp'), false)
    assert.equal(urls.at(-1)!.searchParams.get('id'), '93')
  } finally {
    await api.shutdown()
  }
})

test('concurrent first requests start one listener and use its actual port, cookies and write key', async () => {
  let starts = 0
  const received: Array<{ url?: string; cookie?: string; key?: string | string[] }> = []
  const server = createServer((request, response) => {
    received.push({
      url: request.url,
      cookie: request.headers.cookie,
      key: request.headers['x-twilight-idempotency-key']
    })
    response.end('{"code":200}')
  })
  let transportClosed = false
  const api = new NcmApiService({
    startServer: async () => {
      starts++
      return server.listen(0, '127.0.0.1')
    },
    closeTransport: async () => {
      transportClosed = true
    }
  })
  assert.equal(starts, 0)
  try {
    const responses = await Promise.all([
      api.request('/song/url?id=1', ' a=1; b=2;; '),
      api.request('/playlist/tracks?op=add', undefined, { idempotencyKey: 'fixture:write:1' })
    ])
    assert.deepEqual(responses, [{ code: 200 }, { code: 200 }])
    assert.equal(starts, 1)
    assert.equal(api.getServer(), server)
    assert.equal(received.find((row) => row.url?.startsWith('/song/url'))?.cookie, 'a=1; b=2')
    assert.equal(received.find((row) => row.url?.startsWith('/playlist/'))?.key, 'fixture:write:1')
  } finally {
    await api.shutdown()
  }
  assert.equal(server.listening, false)
  assert.equal(transportClosed, true)
  assert.equal(((await api.request('/song/url')) as { code: number }).code, -1)
})

test('invalid API paths do not start a listener and invalid cookies/keys never reach fetch', async () => {
  let starts = 0
  let headers: Headers | undefined
  const api = new NcmApiService({
    startServer: async () => {
      starts++
      return createServer().listen(0, '127.0.0.1')
    },
    fetch: async (_url, init) => {
      headers = new Headers(init?.headers)
      return new Response('{}')
    }
  })
  try {
    for (const path of [
      'https://foreign.test/',
      '//foreign.test/',
      '/foo\\bar',
      '/foo\r\ninjected:1',
      '/' + 'x'.repeat(4096)
    ])
      assert.deepEqual(await api.request(path), { code: -1, message: 'Invalid NetEase API path' })
    assert.equal(starts, 0)
    await api.request('/safe', 'cookie=1\r\ninjected:1', { idempotencyKey: 'bad key' })
    assert.equal(headers!.get('cookie'), null)
    assert.equal(headers!.get('x-twilight-idempotency-key'), null)
  } finally {
    await api.shutdown()
  }
})

test('cancellation and shutdown settle requests without replay and close the owned transport', async () => {
  let fetched!: () => void
  let calls = 0
  const started = new Promise<void>((resolve) => {
    fetched = resolve
  })
  const api = new NcmApiService({
    startServer: async () => createServer().listen(0, '127.0.0.1'),
    fetch: async (_url, init) => {
      calls++
      fetched()
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      )
    }
  })
  const controller = new AbortController()
  const first = api.request('/playlist/tracks?op=add', undefined, { signal: controller.signal })
  await started
  controller.abort(new Error('cancelled by user'))
  assert.equal(((await first) as { code: number }).code, -1)
  const second = api.request('/song/url')
  await new Promise((resolve) => setImmediate(resolve))
  await api.shutdown()
  assert.equal(((await second) as { code: number }).code, -1)
  assert.equal(calls, 2)
})

test('shutdown cancels a partial HTTP response and closes its real pooled connection without replay', async () => {
  const agent = new Agent({
    connections: 8,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000
  })
  let received!: () => void
  const responding = new Promise<void>((resolve) => {
    received = resolve
  })
  let calls = 0
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((_request, response) => {
    calls++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"code":')
    received()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  let transportClosed = false
  const transport = createNcmLoopbackTransport(agent)
  const api = new NcmApiService({
    startServer: async () => server.listen(0, '127.0.0.1'),
    fetch: transport.fetch,
    closeTransport: async () => {
      await transport.closeTransport()
      transportClosed = true
    }
  })
  const pendingWrite = api.request('/playlist/tracks?op=add', undefined, {
    idempotencyKey: 'shutdown:write'
  })
  await responding
  await api.shutdown()
  assert.equal(((await pendingWrite) as { code: number }).code, -1)
  assert.equal(calls, 1)
  assert.equal(server.listening, false)
  assert.equal(transportClosed, true)
  assert.equal(sockets.size, 0)
})

test('shutdown releases idle HTTP connections through their Agent before waiting for the listener', async () => {
  const agent = new Agent({
    connections: 8,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000
  })
  const events: string[] = []
  const server = createServer((_request, response) => response.end('{"code":200}'))
  server.once('close', () => events.push('listener closed'))
  const transport = createNcmLoopbackTransport(agent)
  const api = new NcmApiService({
    startServer: async () => server.listen(0, '127.0.0.1'),
    fetch: transport.fetch,
    closeTransport: async () => {
      await transport.closeTransport()
      events.push('transport closed')
    }
  })
  assert.deepEqual(await api.request('/song/url?id=1'), { code: 200 })
  await api.shutdown()
  assert.deepEqual(events, ['transport closed', 'listener closed'])
  assert.equal(server.listening, false)
})

test('shutdown during lazy startup waits for and closes the new listener before completing', async () => {
  let release!: (server: ReturnType<typeof createServer>) => void
  let fetches = 0
  const api = new NcmApiService({
    startServer: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    fetch: async () => {
      fetches++
      return new Response('{}')
    }
  })
  const request = api.request('/song/url')
  const shutdown = api.shutdown()
  const server = createServer().listen(0, '127.0.0.1')
  release(server)
  await shutdown
  assert.equal(((await request) as { code: number }).code, -1)
  assert.equal(server.listening, false)
  assert.equal(fetches, 0)
})

test('failed startup can be retried, and non-JSON errors retain the response failure contract', async () => {
  let starts = 0
  const api = new NcmApiService({
    startServer: async () => {
      if (++starts === 1) throw Error('startup failed')
      return createServer().listen(0, '127.0.0.1')
    },
    fetch: async () =>
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' }
      })
  })
  try {
    assert.deepEqual(await api.request('/song/url'), { code: -1, message: 'startup failed' })
    const result = (await api.request('/song/url')) as { code: number; message: string }
    assert.equal(starts, 2)
    assert.equal(result.code, -1)
    assert.match(result.message, /invalid JSON \(HTTP 502, text\/html\)/)
  } finally {
    await api.shutdown()
  }
})
