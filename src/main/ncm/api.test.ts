import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Agent, MockAgent, request as requestLoopbackApi } from 'undici'
import { normalizeIpcString } from '../security/ipcValidation.ts'
import type { NcmApiRequestOptions } from './api.ts'
import { getListeningPort, waitForListeningPort } from './serverBinding.ts'

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function loadRequestNcmApi(
  overrides: Record<string, unknown> = {}
): Promise<(path: string, cookie?: string, options?: NcmApiRequestOptions) => Promise<unknown>> {
  const source = await readFile(new URL('./api.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set([
    'requestNcmApi',
    'shouldTimestampNcmApiPath',
    'normalizeNcmApiPath',
    'normalizeNcmCookie',
    'TIMESTAMPED_NCM_API_PATHS',
    'NCM_API_HOST',
    'NCM_API_ORIGIN',
    'MAX_NCM_API_PATH_LENGTH',
    'MAX_NCM_COOKIE_LENGTH',
    'NCM_IDEMPOTENCY_KEY_PATTERN',
    'NCM_API_REQUEST_TIMEOUT_MS'
  ])
  const nodes = ast.statements.filter((node) =>
    ts.isFunctionDeclaration(node)
      ? !!node.name && names.has(node.name.text)
      : ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) =>
          names.has(declaration.name.getText(ast))
        )
  )
  const code = ts.transpileModule(
    nodes.map((node) => node.getText(ast).replace(/^export /, '')).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  return runInNewContext(`${code}\nrequestNcmApi`, {
    URL,
    Error,
    AbortController,
    setTimeout,
    clearTimeout,
    normalizeIpcString,
    redactSensitiveText: (text: string) => text,
    console: { error: () => undefined },
    runtime: { ncmServer: {} },
    getListeningPort: () => 3101,
    ensureNcmServer: async () => undefined,
    requestLoopbackApi,
    ...overrides
  })
}

test('FM and radar requests bypass gateway caches while ordinary playback requests retain caching', async () => {
  let now = 1000
  const urls: URL[] = []
  const respond = async (url: string): Promise<unknown> => {
    urls.push(new URL(url))
    return { body: { text: async () => '{"code":200,"data":[]}' } }
  }
  const request = await loadRequestNcmApi({
    Date: { now: () => now },
    NCM_KEEP_ALIVE_AGENT: {},
    requestLoopbackApi: respond
  })
  for (const path of ['/personal_fm', '/personal/fm/mode?mode=DEFAULT']) {
    await request(path)
    now += 1
    await request(path)
    const [first, second] = urls.slice(-2)
    assert.equal(first.searchParams.get('timestamp'), String(now - 1))
    assert.equal(second.searchParams.get('timestamp'), String(now))
    if (path.includes('?')) assert.equal(second.searchParams.get('mode'), 'DEFAULT')
  }
  await request('/song/url?id=93')
  assert.equal(urls.at(-1)!.searchParams.has('timestamp'), false)
  assert.equal(urls.at(-1)!.searchParams.get('id'), '93')
})

test('NCM loopback requests retain redirects and invalid JSON diagnostics', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  const server = agent.get('http://127.0.0.1:6000')
  server.intercept({ path: '/redirect', method: 'GET' }).reply(302, '', {
    headers: { location: '/result' }
  })
  server.intercept({ path: '/result', method: 'GET' }).reply(200, { code: 200 })
  server.intercept({ path: '/invalid', method: 'GET' }).reply(503, '<html>unavailable</html>', {
    headers: { 'content-type': 'text/html' }
  })
  const request = await loadRequestNcmApi({
    NCM_KEEP_ALIVE_AGENT: agent,
    getListeningPort: () => 6000
  })
  try {
    assert.equal(JSON.stringify(await request('/redirect')), '{"code":200}')
    const invalid = (await request('/invalid')) as { code: number; message: string }
    assert.equal(invalid.code, -1)
    assert.match(invalid.message, /invalid JSON \(HTTP 503, text\/html\)/)
    agent.assertNoPendingInterceptors()
  } finally {
    await agent.close()
  }
})

for (const cancellation of ['caller', 'deadline'] as const) {
  test(`NCM loopback requests retain ${cancellation} cancellation and clear the deadline`, async () => {
    let startRequest!: () => void
    const started = new Promise<void>((resolve) => (startRequest = resolve))
    let expire!: () => void
    let forwardedSignal!: AbortSignal
    let cleared = 0
    const request = await loadRequestNcmApi({
      NCM_KEEP_ALIVE_AGENT: {},
      setTimeout: (callback: () => void, timeout: number) => {
        assert.equal(timeout, 25_000)
        expire = callback
        return 1
      },
      clearTimeout: () => (cleared += 1),
      requestLoopbackApi: (_url: string, options: { signal: AbortSignal }) => {
        forwardedSignal = options.signal
        startRequest()
        return new Promise((_resolve, reject) => {
          forwardedSignal.addEventListener('abort', () => reject(forwardedSignal.reason), {
            once: true
          })
        })
      }
    })
    const caller = new AbortController()
    const pending = request('/song/url?id=93', undefined, { signal: caller.signal })
    await started
    if (cancellation === 'caller') caller.abort(new Error('caller cancelled'))
    else expire()
    const result = (await pending) as { code: number }
    assert.equal(result.code, -1)
    assert.equal(forwardedSignal.aborted, true)
    assert.equal(cleared, 1)
  })
}

test('NCM API requests reach their isolated listener on a Fetch-restricted port', async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  agent
    .get('http://127.0.0.1:6000')
    .intercept({
      path: '/song/url?id=93',
      method: 'GET',
      headers: { cookie: 'MUSIC_U=test; __csrf=csrf', 'x-twilight-idempotency-key': 'request-1' }
    })
    .reply(200, { code: 200, service: 'ncm' })
  const request = await loadRequestNcmApi({
    NCM_KEEP_ALIVE_AGENT: agent,
    getListeningPort: () => 6000
  })
  try {
    const result = await request('/song/url?id=93', 'MUSIC_U=test;  __csrf=csrf', {
      idempotencyKey: 'request-1'
    })
    assert.equal(JSON.stringify(result), '{"code":200,"service":"ncm"}')
    agent.assertNoPendingInterceptors()
  } finally {
    await agent.close()
  }
})

test('NCM API binding reports its actual isolated port instead of a foreign listener', async () => {
  let foreignRequests = 0
  const foreignServer = createServer((_request, response) => {
    foreignRequests += 1
    response.end('foreign-service')
  })
  const ncmServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end('{"service":"ncm"}')
  })
  const agent = new Agent()

  try {
    foreignServer.listen(0, '127.0.0.1')
    const foreignPort = await waitForListeningPort(foreignServer)

    ncmServer.listen(0, '127.0.0.1')
    const ncmPort = await waitForListeningPort(ncmServer)

    assert.notEqual(ncmPort, foreignPort)
    const request = await loadRequestNcmApi({
      NCM_KEEP_ALIVE_AGENT: agent,
      runtime: { ncmServer },
      getListeningPort
    })
    const response = await request('/login/qr/key')
    assert.equal(JSON.stringify(response), '{"service":"ncm"}')
    assert.equal(foreignRequests, 0)
  } finally {
    await agent.close()
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

test('NCM API server starts once on the first request and gates loopback requests on readiness', async () => {
  const source = await readFile(new URL('./api.ts', import.meta.url), 'utf8')

  assert.match(source, /export function ensureNcmServer\(\): Promise<void>/)
  assert.match(source, /if \(runtime\.ncmServerPromise\) return runtime\.ncmServerPromise/)
  assert.match(source, /const startup = startNcmServer\(\)/)
  assert.match(source, /await ensureNcmServer\(\)/)
  assert.match(source, /port: NCM_API_EPHEMERAL_PORT/)
  assert.match(source, /await waitForListeningPort\(ncmApp\.server\)/)
  assert.match(source, /getListeningPort\(runtime\.ncmServer\)/)
  assert.match(source, /const res = await requestLoopbackApi\(url, \{/)
  assert.match(source, /const responseText = await res\.body\.text\(\)/)
  assert.match(source, /signal: controller\.signal,/)
  assert.match(source, /headers,/)
  assert.match(source, /dispatcher: NCM_KEEP_ALIVE_AGENT/)
  assert.doesNotMatch(source, /NCM_API_PORT = 3100/)
  assert.doesNotMatch(source, /export async function setupNcmApi/)
})
