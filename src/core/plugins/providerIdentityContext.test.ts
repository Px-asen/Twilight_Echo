import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { IdentificationResponseCache } from '../library/identificationResponseCache.ts'
import { PlatformIdentificationProvider } from '../library/musicIdentificationProvider.ts'
import type { IdentificationInput } from '../../shared/musicIdentification.ts'
import type { RemoteProviderSession } from '../../shared/remoteCoreBridge.ts'
import {
  normalizeProviderUi,
  normalizeProviderHealth,
  isTwilightMediaProviderMethod
} from './providerRouting.ts'

interface ContextManager extends EventEmitter {
  providerIdentityContext(id: string): string
  providerAccountContext(id: string): string
  identityContextChanged(pluginId: string): void
  callProvider(id: string, method: string, args: unknown[]): Promise<unknown>
  handleApiCall(id: string, message: unknown): Promise<{ ok: boolean }>
  handleQishuiAuthApiCall(id: string, message: unknown): Promise<unknown>
  registerProviderFromPlugin(id: string, message: unknown): unknown
}
function fixture() {
  const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(
    (n): n is ts.ClassDeclaration =>
      ts.isClassDeclaration(n) && n.name?.text === 'TwilightPluginManager'
  )!
  const members = declaration.members.filter(
    (n) =>
      n.name &&
      [
        'identityContexts',
        'accountContexts',
        'providerAccountContext',
        'accountContextChanged',
        'providerIdentityContext',
        'identityContextChanged',
        'callProvider',
        'handleApiCall',
        'handleQishuiAuthApiCall',
        'registerProviderFromPlugin'
      ].includes(n.name.getText(ast))
  )
  assert.equal(members.length, 10)
  const plugins = [
    {
      descriptor: {
        id: 'plugin.ncm',
        version: '1',
        type: ['provider'],
        paths: { dataDir: 'unused' }
      },
      providers: [{ id: 'ncm' }]
    },
    {
      descriptor: { id: 'plugin.other', version: '1', paths: { dataDir: 'unused' } },
      providers: [{ id: 'other' }]
    }
  ]
  const code = ts.transpileModule(
    `class Manager extends EventEmitter {${members.map((n) => n.getText(ast)).join('\n')}}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const Manager = runInNewContext(`${code}\nManager`, {
    EventEmitter,
    randomUUID,
    findProviderRoute: () => plugins[0],
    getProviderCallTimeoutMs: () => 1000,
    resolveProviderIdempotencyKey: () => undefined,
    normalizeProviderUi,
    normalizeProviderHealth,
    isTwilightMediaProviderMethod,
    QISHUI_PLUGIN_ID: 'plugin.ncm'
  }) as new () => ContextManager
  let run: () => Promise<unknown> = async () => undefined
  const manager = Object.assign(new Manager(), {
    contributingPlugins: () => plugins,
    requirePermission() {},
    requireProviderCapabilityPermissions() {},
    assertProviderIdAvailable() {},
    providerHealth: new Map(),
    running: new Map(plugins.map((p) => [p.descriptor.id, p])),
    ensureRunningForCall: async () => plugins[0],
    rpcCalls: { request: () => run() },
    settings: {
      get: async () => undefined,
      set: async () => {
        await run()
      },
      delete: async () => {
        await run()
      }
    },
    qishuiAuth: { checkQrLogin: () => run(), clear: () => run() }
  })
  return {
    manager,
    plugins,
    setRun: (action: () => Promise<unknown>) => {
      run = action
    }
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('listening account context survives ordinary settings writes and changes on credentials', async () => {
  const { manager } = fixture()
  const initial = manager.providerAccountContext('ncm')
  const events: string[] = []
  manager.on('provider-account', id => events.push(id))
  const write = (key: string) => manager.handleApiCall('plugin.ncm', {
    namespace: 'settings', requestId: key, method: 'set', args: [key, 'fixture']
  })
  await write('providerWriteIdempotency')
  assert.equal(manager.providerAccountContext('ncm'), initial)
  assert.deepEqual(events, [])
  await write('cookie')
  assert.notEqual(manager.providerAccountContext('ncm'), initial)
  assert.deepEqual(events, ['ncm', 'ncm'])
  const loggedIn = manager.providerAccountContext('ncm')
  await manager.callProvider('ncm', 'logout', [])
  assert.notEqual(manager.providerAccountContext('ncm'), loggedIn)
})

test('provider re-registration invalidates a previous host context even when methods are unchanged', () => {
  const { manager } = fixture(),
    events: string[] = []
  manager.on('provider-context', (id) => events.push(id))
  const initial = manager.providerIdentityContext('ncm')
  const message = {
    method: 'register',
    args: [
      { id: 'ncm', name: 'NCM', capabilities: ['search'], supportedMethods: ['searchArtists'] }
    ]
  }
  manager.registerProviderFromPlugin('plugin.ncm', message)
  const registered = manager.providerIdentityContext('ncm')
  assert.notEqual(registered, initial)
  manager.registerProviderFromPlugin('plugin.ncm', message)
  assert.notEqual(manager.providerIdentityContext('ncm'), registered)
  assert.deepEqual(events, ['ncm', 'ncm'])
})

test('provider context contains only session revisions and isolates each plugin, including failed settings writes', async () => {
  const { manager, setRun } = fixture()
  const events: string[] = []
  manager.on('provider-context', (id) => events.push(id))
  const initial = manager.providerIdentityContext('ncm'),
    other = manager.providerIdentityContext('other')
  const request = (method: string) =>
    manager.handleApiCall('plugin.ncm', {
      namespace: 'settings',
      requestId: method,
      method,
      args: ['cookie', 'secret-never-in-context']
    })
  assert.equal((await request('get')).ok, true)
  assert.equal(manager.providerIdentityContext('ncm'), initial)
  let finish!: () => void
  setRun(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const write = request('set'),
    during = manager.providerIdentityContext('ncm')
  assert.notEqual(during, initial)
  finish()
  assert.equal((await write).ok, true)
  assert.notEqual(manager.providerIdentityContext('ncm'), during)
  setRun(async () => {
    throw new Error('disk full')
  })
  assert.equal((await request('delete')).ok, false)
  assert.equal(manager.providerIdentityContext('other'), other)
  assert.deepEqual(events, ['ncm', 'ncm', 'ncm', 'ncm'])
  assert.doesNotMatch(manager.providerIdentityContext('ncm'), /cookie|secret/)
})

test('login and logout invalidate on entry and settlement without changing normal provider calls or failure results', async () => {
  const { manager, setRun } = fixture()
  const events: string[] = []
  manager.on('provider-context', (id) => events.push(id))
  let finish!: () => void
  setRun(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const pending = manager.callProvider('ncm', 'logout', [])
  await tick()
  assert.deepEqual(events, ['ncm'])
  finish()
  await pending
  assert.deepEqual(events, ['ncm', 'ncm'])
  setRun(async () => {
    throw new Error('login denied')
  })
  await assert.rejects(manager.callProvider('ncm', 'checkQrLogin', ['key']), /login denied/)
  assert.equal(events.length, 4)
  setRun(async () => 'search result')
  assert.equal(await manager.callProvider('ncm', 'searchArtists', ['Artist']), 'search result')
  assert.equal(events.length, 4)
})

test('built-in QR credential changes and clears update the same provider context', async () => {
  const { manager } = fixture(),
    events: string[] = []
  manager.on('provider-context', (id) => events.push(id))
  await manager.handleQishuiAuthApiCall('plugin.ncm', {
    method: 'qishuiCheckQrLogin',
    args: ['key']
  })
  await manager.handleQishuiAuthApiCall('plugin.ncm', { method: 'qishuiClear', args: [] })
  assert.deepEqual(events, ['ncm', 'ncm', 'ncm', 'ncm'])
})

test('production manager context changes prevent reuse of the previous account search snapshot', async () => {
  const { manager } = fixture(),
    cache = new IdentificationResponseCache()
  manager.on('provider-context', (id: string) => cache.invalidate(`platform.${id}`))
  let calls = 0,
    resultId = '7'
  const adapter = () =>
    new PlatformIdentificationProvider('ncm', {
      responses: cache,
      inventory: () => [
        {
          id: 'ncm',
          enabled: true,
          configuration: manager.providerIdentityContext('ncm'),
          supportedMethods: ['searchArtists']
        }
      ],
      search: async () => {
        calls++
        return { total: 1, items: [{ id: resultId, name: 'Artist' }] }
      }
    })
  const input: IdentificationInput = {
    entityId: 'entity',
    kind: 'artist',
    name: 'Artist',
    artist: '',
    version: '1',
    linkRevision: 0
  }
  const signal = new AbortController().signal
  await adapter().recall(input, signal)
  await adapter().recall(input, signal)
  assert.equal(calls, 1)
  await manager.callProvider('ncm', 'logout', [])
  resultId = '8'
  assert.equal((await adapter().recall(input, signal)).proposals[0].references[0].value, '8')
  assert.equal(calls, 2)
})

function sessionFixture() {
  const id = 'com.twilightecho.provider.ncm'
  const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find((n): n is ts.ClassDeclaration =>
    ts.isClassDeclaration(n) && n.name?.text === 'TwilightPluginManager')!
  const method = declaration.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === 'readNcmSession')!
  const code = ts.transpileModule(`class Manager {${method.getText(ast)}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const Manager = runInNewContext(`${code}\nManager`, { INTERNAL_NCM_PLUGIN_ID: id }) as new () => {
    readNcmSession(): Promise<RemoteProviderSession>
  }
  const owner = { descriptor: { id, paths: { dataDir: 'ncm-private-settings' } }, providers: [{ id: 'ncm' }] }
  const plugins = [owner]
  const state = { [id]: { enabled: true } }
  let revision = 0, loginCalls = 0
  let loggedIn = true
  let readCookie = async (): Promise<unknown> => 'MUSIC_U=account; __csrf=csrf'
  const reads: unknown[] = []
  const manager = Object.assign(new Manager(), {
    state,
    shuttingDown: false,
    contributingPlugins: () => plugins,
    providerIdentityContext: () => String(revision),
    callProvider: async (...args: unknown[]) => {
      loginCalls++
      assert.deepEqual(JSON.parse(JSON.stringify(args)), ['ncm', 'checkLogin', []])
      return { loggedIn }
    },
    settings: { get: async (...args: unknown[]) => { reads.push(args); return readCookie() } }
  })
  return {
    read: async () => JSON.parse(JSON.stringify(await manager.readNcmSession())) as RemoteProviderSession,
    reads, state, plugins, owner, manager,
    login: (value: boolean) => { loggedIn = value },
    loginCalls: () => loginCalls,
    cookie: (read: typeof readCookie) => { readCookie = read },
    accountChanged: () => { revision++ }
  }
}

test('remote session reads only the enabled official NCM account through the settings repository', async () => {
  const f = sessionFixture()
  assert.deepEqual(await f.read(), { providerId: 'ncm', loggedIn: true, cookie: 'MUSIC_U=account; __csrf=csrf' })
  assert.deepEqual(f.reads, [['ncm-private-settings', 'cookie']])
  f.login(false)
  assert.deepEqual(await f.read(), { providerId: 'ncm', loggedIn: false })
  assert.equal(f.reads.length, 1)
})

test('disabled, absent, or nonofficial providers never read account credentials', async () => {
  for (const condition of ['disabled', 'absent', 'other-plugin', 'shutdown']) {
    const f = sessionFixture()
    if (condition === 'disabled') Object.values(f.state)[0].enabled = false
    if (condition === 'absent') f.plugins.length = 0
    if (condition === 'other-plugin') f.owner.descriptor.id = 'other.provider'
    if (condition === 'shutdown') f.manager.shuttingDown = true
    assert.deepEqual(await f.read(), { providerId: 'ncm', loggedIn: false })
    assert.equal(f.loginCalls(), 0)
    assert.equal(f.reads.length, 0)
  }
})

test('remote sessions omit malformed cookies and discard concurrent account or enablement changes', async () => {
  const f = sessionFixture()
  for (const cookie of [undefined, 3, '', 'MUSIC_U=', 'other=MUSIC_U=spoof', 'MUSIC_U=account\r\nInjected: header', 'MUSIC_U=' + 'x'.repeat(16000)]) {
    f.cookie(async () => cookie)
    assert.deepEqual(await f.read(), { providerId: 'ncm', loggedIn: false })
  }
  f.cookie(async () => { f.accountChanged(); return 'MUSIC_U=old-account' })
  assert.deepEqual(await f.read(), { providerId: 'ncm', loggedIn: false })
  f.cookie(async () => { Object.values(f.state)[0].enabled = false; return 'MUSIC_U=old-account' })
  assert.deepEqual(await f.read(), { providerId: 'ncm', loggedIn: false })
})
