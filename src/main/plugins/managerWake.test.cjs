const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const ts = require('typescript')

test(
  'real Windows hosts restart background tasks, recover failures and respect user disable',
  {
    skip: process.platform !== 'win32',
    timeout: 45000
  },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'twilight-plugin-startup-'))
    t.after(() => {
      assert.equal(path.dirname(directory), path.resolve(tmpdir()))
      assert.ok(path.basename(directory).startsWith('twilight-plugin-startup-'))
      fs.rmSync(directory, { recursive: true, force: true })
    })
    const root = path.resolve(__dirname, '../../..')
    const profile = path.join(directory, 'profile')
    const managerFile = path.join(directory, 'manager.cjs')
    const hostFile = path.join(directory, 'host.cjs')
    const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
    await Promise.all(
      ['manager', 'host'].map((name) =>
        esbuild.build({
          entryPoints: [path.join(__dirname, `${name}.ts`)],
          outfile: name === 'manager' ? managerFile : hostFile,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          define: {
            'import.meta.url': JSON.stringify(
              pathToFileURL(path.join(__dirname, `${name}.ts`)).href
            )
          },
          logLevel: 'silent'
        })
      )
    )
    const ids = ['com.example.startup-task', 'com.example.retry-task']
    const records = {}
    for (const id of ids) {
      const pluginRoot = path.join(profile, 'plugins', id, '1.0.0')
      fs.mkdirSync(pluginRoot, { recursive: true })
      fs.writeFileSync(
        path.join(pluginRoot, 'plugin.json'),
        JSON.stringify({
          id,
          name: id,
          version: '1.0.0',
          description: 'Startup regression fixture',
          author: 'Twilight Echo tests',
          license: 'MIT',
          apiVersion: 3,
          engines: { twilightEcho: '*' },
          type: ['tool'],
          main: 'index.mjs',
          permissions: ['filesystem:write', 'library:write']
        })
      )
      fs.writeFileSync(
        path.join(pluginRoot, 'index.mjs'),
        `
      import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
      import { join } from 'node:path'
      let timer
      export async function activate(context) {
        const file = join(context.storagePath, 'probe.json')
        const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
        const state = { activations: (previous.activations || 0) + 1, ticks: 0 }
        const persist = () => {
          writeFileSync(file + '.tmp', JSON.stringify(state))
          renameSync(file + '.tmp', file)
        }
        persist()
        if (${JSON.stringify(id)} === 'com.example.retry-task' && state.activations === 1)
          throw new Error('one-time startup failure')
        // Activation can import before a main window exists. Exercise the real
        // utilityProcess API bridge rather than calling manager internals.
        await context.twilight.library.importPlaylists({
          playlists: [{ name: ${JSON.stringify(id)}, paths: ['D:/Music/startup.flac'] }]
        })
        timer = setInterval(() => {
          state.ticks++
          persist()
        }, 30)
      }
      export function deactivate() { clearInterval(timer) }
    `
      )
      records[id] = {
        enabled: true,
        source: 'directory',
        activeVersion: '1.0.0',
        installedAt: '2026-10-08T00:00:00Z',
        updatedAt: '2026-10-08T00:00:00Z'
      }
    }
    fs.writeFileSync(path.join(profile, 'plugin-state.json'), JSON.stringify(records))
    const runner = path.join(directory, 'runner.cjs')
    fs.writeFileSync(
      runner,
      `
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    const path = require('node:path')
    const { app } = require('electron')
    app.setPath('userData', ${JSON.stringify(profile)})
    app.whenReady().then(async () => {
      const { TwilightPluginManager } = require(${JSON.stringify(managerFile)})
      const manager = new TwilightPluginManager({
        appVersion: '1.2.4', hostEntry: ${JSON.stringify(hostFile)},
        hostIdleTimeoutMs: 100, getPlaybackInfo: () => ({}),
        applyNativeDspPluginChain: () => {}, player: {}
      })
      const phase = Number(process.argv[2])
      const ids = ${JSON.stringify(ids)}
      const imports = []
      manager.on('importPlaylist', request => imports.push(request))
      const probe = (id) => JSON.parse(fs.readFileSync(path.join(
        ${JSON.stringify(profile)}, 'plugin-data', id, 'probe.json'), 'utf8'))
      try {
        await manager.initialize()
        await new Promise(resolve => setTimeout(resolve, 360))
        const descriptors = await manager.list()
        assert.equal(imports.length, phase === 1 ? 1 : phase === 2 ? 2 : 0)
        for (const request of imports) {
          assert.ok(ids.includes(request.pluginId))
          assert.equal(request.playlists[0].name, request.pluginId)
          assert.deepEqual(request.playlists[0].paths, ['D:/Music/startup.flac'])
        }
        if (phase < 3) {
          assert.equal(probe(ids[0]).activations, phase)
          assert.ok(probe(ids[0]).ticks >= 5)
          assert.equal(manager.isHibernated(ids[0]), false)
          assert.equal(probe(ids[1]).activations, phase)
          if (phase === 1) {
            const failed = descriptors.find(d => d.id === ids[1])
            assert.equal(failed.status, 'failed')
            assert.equal(failed.enabled, false)
            assert.equal(manager.state[ids[1]].enabled, true)
          } else {
            assert.ok(probe(ids[1]).ticks >= 5)
            assert.equal(descriptors.find(d => d.id === ids[1]).status, 'enabled')
            for (const id of ids) await manager.disable(id)
            const saved = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(profile)}, 'plugin-state.json')))
            for (const id of ids) assert.equal(saved[id].enabled, false)
          }
        } else {
          for (const id of ids) {
            assert.equal(descriptors.find(d => d.id === id).enabled, false)
            assert.equal(probe(id).activations, 2)
          }
        }
        console.log('STARTUP_PROOF ' + JSON.stringify({ phase, probes: ids.map(probe) }))
      } finally { await manager.destroy() }
      app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `
    )
    const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules') }
    delete env.ELECTRON_RUN_AS_NODE
    for (const phase of [1, 2, 3]) {
      const { stdout } = await promisify(execFile)(require('electron'), [runner, String(phase)], {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 12000
      })
      assert.match(stdout, /STARTUP_PROOF/)
      t.diagnostic(stdout.trim())
    }
  }
)

async function fixture(
  t,
  {
    appVersion = '1.2.4',
    engineRange = '*',
    providerId = 'demo',
    pluginId = 'com.example.demo',
    autoMixEnabled = () => false,
    ncm
  } = {}
) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'twilight-plugin-wake-'))
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export function activate() {}\n')
  const importSource = (name) => import(pathToFileURL(path.join(__dirname, name)).href)
  const [manifest, routing, queue, rpc, idle, persistence, dependenciesApi, media, identities] =
    await Promise.all([
      importSource('manifest.ts'),
      importSource('providerRouting.ts'),
      importSource('operationQueue.ts'),
      importSource('rpcCoordinator.ts'),
      importSource('hostIdle.ts'),
      importSource('statePersistence.ts'),
      importSource('dependencies.ts'),
      importSource('../security/remoteMediaGrants.ts'),
      importSource('../audio/providerPlaybackIdentity.ts')
    ])
  const children = []
  let notify
  const activationStarted = new Promise((resolve) => {
    notify = resolve
  })
  class Child extends EventEmitter {
    messages = []
    postMessage(message) {
      this.messages.push(message)
      if (message.kind === 'activate') notify()
      if (message.kind === 'provider-call')
        queueMicrotask(() =>
          this.emit('message', {
            kind: 'provider-result',
            requestId: message.requestId,
            ok: true,
            value: message.args[0]
          })
        )
      if (message.kind === 'deactivate')
        queueMicrotask(() =>
          this.emit('message', {
            kind: 'deactivated',
            requestId: message.requestId
          })
        )
    }
    kill() {
      this.emit('exit', 0)
    }
  }
  const dependencies = {
    electron: {
      app: { getPath: () => directory },
      dialog: {},
      shell: {},
      utilityProcess: {
        fork: () => {
          const child = new Child()
          children.push(child)
          return child
        }
      }
    },
    './manifest': manifest,
    './providerRouting': routing,
    './operationQueue.ts': queue,
    './rpcCoordinator.ts': rpc,
    './hostIdle.ts': idle,
    './statePersistence.ts': persistence,
    './dependencies': dependenciesApi,
    './contributionsCache.ts': { PLUGIN_CONTRIBUTIONS_CACHE_FILE: 'plugin-contributions.json' },
    './qishuiAuthBridge.ts': {
      QISHUI_PLUGIN_ID: 'com.twilightecho.provider.qishui',
      QishuiAuthBridge: class {}
    },
    './packageSecurity.ts': { resolvePluginFile: (file) => file },
    '../security/remoteMediaGrants.ts': media,
    '../audio/providerPlaybackIdentity.ts': identities
  }
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../core/plugins/manager.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    require: (id) => {
      if (id in dependencies) return dependencies[id]
      if (id.startsWith('.')) return {}
      return require(id)
    },
    Buffer,
    structuredClone,
    AbortController,
    process,
    setTimeout,
    clearTimeout,
    console
  })
  const manager = new exports.TwilightPluginManager({
    appVersion,
    platform: {
      userData: directory,
      launchHost: () => { const child = new Child(); children.push(child); return child },
      protectProviderResult: media.protectProviderMedia
    },
    settings: { flush: async () => {} },
    recordPlaybackIdentity: (...args) => identities.providerPlaybackIdentities.record(...args),
    hostIdleTimeoutMs: 300000,
    getPlaybackInfo: () => ({}),
    autoMixEnabled,
    ncm,
    applyNativeDspPluginChain: () => {},
    player: {}
  })
  manager.appendLog = () => {}
  manager.queueContributionsSave = () => {}
  manager.queueStateSave = () => {}
  const descriptor = {
    id: pluginId,
    name: 'Demo',
    version: '1.0.0',
    enabled: true,
    status: 'enabled',
    main: 'index.mjs',
    engines: { twilightEcho: engineRange },
    type: ['provider'],
    permissions: ['network'],
    apiVersion: 3,
    paths: {
      versionRoot: directory,
      dataDir: directory,
      logPath: path.join(directory, 'plugin.log')
    }
  }
  manager.state[descriptor.id] = {
    enabled: true,
    installedAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    source: 'directory',
    activeVersion: descriptor.version
  }
  manager.findDescriptor = async () => descriptor
  const provider = {
    id: providerId,
    name: 'Demo',
    capabilities: ['search', 'playbackUrl'],
    supportedMethods: ['searchSongs', 'getPlaybackUrl']
  }
  const info = fs.statSync(path.join(directory, 'index.mjs'))
  manager.contributionsCache[descriptor.id] = {
    version: descriptor.version,
    mainSignature: `${info.size}:${Math.floor(info.mtimeMs)}`,
    providers: [provider],
    ui: [],
    subscriptions: ['app:ready']
  }
  assert.equal(manager.hibernateFromCache(descriptor), true)
  t.after(async () => {
    manager.hostIdle.destroy()
    await manager.stopPlugin(descriptor.id)
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('twilight-plugin-wake-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const register = () => {
    children[0].emit('message', {
      kind: 'api-call',
      requestId: 'register',
      namespace: 'providers',
      method: 'register',
      args: [provider]
    })
    children[0].emit('message', { kind: 'api-event-subscribe', eventName: 'app:ready' })
  }
  const activate = () => children[0].emit('message', { kind: 'activated', pluginId: descriptor.id })
  return { manager, descriptor, children, activationStarted, register, activate, directory }
}

test('only the host enables AutoMix preparation for the bundled provider', async (t) => {
  let enabled = true
  const f = await fixture(t, {
    pluginId: 'com.twilightecho.provider.ncm',
    providerId: 'ncm',
    autoMixEnabled: () => enabled
  })
  const first = f.manager.callProvider('ncm', 'getPlaybackUrl', [{ id: 'ncm:991' }, {}])
  await f.activationStarted
  f.register()
  f.activate()
  await first
  let message = f.children[0].messages.filter((m) => m.kind === 'provider-call').at(-1)
  assert.equal(message.args[1]._twilightAutoMixPrepare, true)
  assert.equal(message.args[1]._twilightSourceIdentity, true)
  enabled = false
  await f.manager.callProvider('ncm', 'getPlaybackUrl', [
    { id: 'ncm:991' },
    {
      _twilightAutoMixPrepare: true
    }
  ])
  message = f.children[0].messages.filter((m) => m.kind === 'provider-call').at(-1)
  assert.equal(message.args[1]._twilightAutoMixPrepare, false)
})

test('AutoMix materialization is bundled-only, cancellable and gated by the current mode', async (t) => {
  let enabled = true,
    started,
    signalSeen
  const begun = new Promise((resolve) => {
    started = resolve
  })
  const f = await fixture(t, {
    pluginId: 'com.twilightecho.provider.ncm',
    providerId: 'ncm',
    autoMixEnabled: () => enabled,
    ncm: {
      prepareAutoMixSong: async (_id, _url, _fileName, { signal }) => {
        signalSeen = signal
        started()
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
    }
  })
  const activate = f.manager.callProvider('ncm', 'searchSongs', ['wake'])
  await f.activationStarted
  f.register()
  f.activate()
  await activate
  const call = {
    kind: 'api-call',
    namespace: 'internal',
    method: 'ncmPrepareAutoMixSong',
    requestId: 'prepare-cache',
    args: [991, 'https://music.example/991.flac', undefined, {}]
  }
  const pending = f.manager.handleHostMessage(f.descriptor.id, call)
  await begun
  await f.manager.handleHostMessage(f.descriptor.id, {
    kind: 'api-cancel',
    requestId: call.requestId,
    reason: 'queue_changed'
  })
  await pending
  assert.equal(signalSeen.aborted, true)
  assert.equal(f.manager.internalNcmRequests.size, 0)
  assert.equal(
    f.children[0].messages
      .filter((m) => m.kind === 'api-result' && m.requestId === call.requestId)
      .at(-1).ok,
    false
  )
  enabled = false
  assert.equal((await f.manager.handleApiCall(f.descriptor.id, call)).value, null)
  const foreign = await f.manager.handleApiCall('com.example.foreign', call)
  assert.equal(foreign.ok, false)
})

test('a host failure retains enablement intent and retries once at the next startup', async (t) => {
  const f = await fixture(t)
  f.manager.markFailed(f.descriptor.id, 'temporary startup failure', f.descriptor)
  assert.equal(f.manager.state[f.descriptor.id].enabled, true)
  await f.manager.saveState()
  f.manager.state = {}
  await f.manager.loadState()
  f.manager.list = async () => [
    { ...f.descriptor, enabled: false, status: 'failed', error: 'temporary startup failure' }
  ]
  const attempted = []
  f.manager.startPlugin = async (descriptor) => {
    attempted.push(descriptor.id)
    f.manager.markStarted(descriptor)
  }
  await f.manager.scanAndStartEnabled()
  assert.deepEqual(attempted, [f.descriptor.id])
  assert.equal(f.manager.state[f.descriptor.id].lastError, undefined)
})

test('legacy failure-disabled state recovers but an explicit user disable stays disabled', async (t) => {
  const f = await fixture(t)
  f.manager.state[f.descriptor.id].enabled = false
  f.manager.state[f.descriptor.id].lastError = '插件宿主进程退出：1'
  await f.manager.saveState()
  await f.manager.loadState()
  assert.equal(f.manager.state[f.descriptor.id].enabled, true)
  f.manager.setEnabled(f.descriptor.id, false)
  await f.manager.saveState()
  await f.manager.loadState()
  assert.equal(f.manager.state[f.descriptor.id].enabled, false)
  assert.equal(f.manager.state[f.descriptor.id].lastError, undefined)
})

test('late host errors cannot turn an explicit disable into a recovery request', async (t) => {
  const f = await fixture(t)
  const starting = f.manager.startPlugin(f.descriptor)
  await f.activationStarted
  f.activate()
  await starting
  f.manager.setEnabled(f.descriptor.id, false)
  await f.manager.handleHostMessage(f.descriptor.id, {
    kind: 'host-error',
    message: 'late shutdown error'
  })
  await f.manager.saveState()
  await f.manager.loadState()
  assert.equal(f.manager.state[f.descriptor.id].enabled, false)
  assert.equal(f.manager.state[f.descriptor.id].lastError, undefined)
})

test('failed descriptors preserve the switch intent and can disable next-start recovery', async (t) => {
  const f = await fixture(t)
  f.manager.markFailed(f.descriptor.id, 'persistent activation failure', f.descriptor)
  f.manager.readManifest = async () => f.descriptor
  const visible = await f.manager.readDescriptor(f.directory, 'directory', {
    paths: f.descriptor.paths
  })
  assert.equal(visible.status, 'failed')
  assert.equal(visible.enabled, false)
  assert.equal(visible.requestedEnabled, true)
  f.manager.syncNativeDspChain = async () => {}
  await f.manager.disable(visible.id)
  await f.manager.loadState()
  const disabled = await f.manager.readDescriptor(f.directory, 'directory', {
    paths: f.descriptor.paths
  })
  assert.equal(disabled.requestedEnabled, false)
  assert.equal(disabled.status, 'disabled')
  const starts = []
  f.manager.list = async () => [disabled]
  f.manager.startPlugin = async (descriptor) => starts.push(descriptor.id)
  await f.manager.scanAndStartEnabled()
  assert.deepEqual(starts, [])
})

test('background tools, UI and hybrid hosts run at boot and remain resident while idle', async (t) => {
  const f = await fixture(t)
  f.manager.hibernated.clear()
  for (const type of [['tool'], ['ui'], ['theme'], ['dsp'], ['provider', 'tool']]) {
    const descriptor = { ...f.descriptor, type }
    assert.equal(f.manager.hibernateFromCache(descriptor), false, type.join(','))
    f.manager.running.set(descriptor.id, { descriptor, trial: false })
    assert.equal(f.manager.canHibernatePlugin(descriptor.id), false, type.join(','))
    f.manager.running.clear()
  }
})

test('a failed dependency prevents activation of dependents but independent plugins still start', async (t) => {
  const f = await fixture(t)
  f.manager.hibernateFromCache = () => false
  const dependent = {
    ...f.descriptor,
    id: 'com.example.dependent',
    dependencies: { [f.descriptor.id]: '*' }
  }
  const independent = { ...f.descriptor, id: 'com.example.independent' }
  f.manager.list = async () => [f.descriptor, dependent, independent]
  const attempted = []
  f.manager.startPlugin = async (descriptor) => {
    attempted.push(descriptor.id)
    if (descriptor.id === f.descriptor.id) throw new Error('base activation failed')
  }
  await f.manager.scanAndStartEnabled()
  assert.deepEqual(attempted.sort(), [f.descriptor.id, independent.id].sort())
  assert.match(f.manager.state[dependent.id].lastError, /依赖插件.*启动失败/)
})

test('a queued start cannot create a host after shutdown begins', async (t) => {
  const f = await fixture(t)
  let release
  const stopping = new Promise((resolve) => {
    release = resolve
  })
  f.manager.stopOperations.set(f.descriptor.id, stopping)
  const starting = f.manager.startPlugin(f.descriptor)
  const rejected = assert.rejects(starting, /应用正在退出/)
  await f.manager.destroy()
  release()
  await rejected
  assert.equal(f.children.length, 0)
  f.manager.stopOperations.clear()
})

test('enable and disable cannot acknowledge success before state is durable', async (t) => {
  const f = await fixture(t)
  f.manager.list = async () => [f.descriptor]
  f.manager.startPlugin = async () => {}
  f.manager.syncNativeDspChain = async () => {}
  let release
  let writes = 0
  f.manager.saveState = () => {
    writes++
    return new Promise((resolve) => {
      release = resolve
    })
  }
  let settled = false
  const enabling = f.manager.enable(f.descriptor.id).then(() => {
    settled = true
  })
  await new Promise(setImmediate)
  assert.equal(writes, 1)
  assert.equal(settled, false)
  release()
  await enabling
  f.manager.saveState = async () => {
    throw new Error('state disk unavailable')
  }
  await assert.rejects(f.manager.disable(f.descriptor.id), /state disk unavailable/)
})

for (const directory of ['ncm-provider']) {
  test(`preview host validates and activates the ${directory} engine range`, async (t) => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../../resources/plugins', directory, 'plugin.json'),
        'utf8'
      )
    )
    const f = await fixture(t, {
      appVersion: '1.3.0-perview',
      engineRange: manifest.engines.twilightEcho
    })
    assert.equal(
      f.manager.validateRuntimeDescriptor(manifest, f.descriptor.paths.versionRoot),
      null
    )
    const starting = f.manager.startPlugin(f.descriptor)
    await Promise.race([f.activationStarted, starting])
    assert.equal(f.children.length, 1)
    f.activate()
    await starting
    assert.equal(f.manager.state[f.descriptor.id].enabled, true)
  })
}

test('preview host rejects a plugin requiring the corresponding stable release', async (t) => {
  const f = await fixture(t, { appVersion: '1.3.0-perview', engineRange: '>=1.3.0' })
  assert.match(
    f.manager.validateRuntimeDescriptor(f.descriptor, f.descriptor.paths.versionRoot),
    /插件要求 Twilight Echo >=1\.3\.0/
  )
  await assert.rejects(f.manager.startPlugin(f.descriptor), /插件要求 Twilight Echo >=1\.3\.0/)
  assert.equal(f.children.length, 0)
})

test('concurrent provider calls preserve cached routes and await one activation', async (t) => {
  const f = await fixture(t)
  const first = f.manager.callProvider('demo', 'searchSongs', ['first'])
  await f.activationStarted
  const visibleDuringWake = f.manager.listProviders().map((provider) => provider.id)
  const second = f.manager.callProvider('demo', 'searchSongs', ['second']).then(
    (value) => ({ value }),
    (error) => ({ error: error.message })
  )
  f.register()
  const third = f.manager.callProvider('demo', 'searchSongs', ['third'])
  await new Promise(setImmediate)
  const prematureCalls = f.children[0].messages.filter(
    (message) => message.kind === 'provider-call'
  )
  f.activate()
  assert.equal(await first, 'first')
  assert.deepEqual(await second, { value: 'second' })
  assert.equal(await third, 'third')
  assert.deepEqual(visibleDuringWake, ['demo'])
  assert.equal(prematureCalls.length, 0)
  assert.equal(f.children.length, 1)
  assert.equal(f.manager.isHibernated(f.descriptor.id), false)
})

test('cached startup subscribers receive app:ready once, after activation', async (t) => {
  const f = await fixture(t)
  const first = f.manager.callProvider('demo', 'searchSongs', ['wake'])
  await f.activationStarted
  f.register()
  const broadcasting = f.manager.broadcastEvent('app:ready', { version: '1.2.4' })
  await new Promise(setImmediate)
  const prematureEvents = f.children[0].messages.filter((message) => message.kind === 'event')
  f.activate()
  await first
  await broadcasting
  await new Promise(setImmediate)
  assert.equal(prematureEvents.length, 0)
  assert.deepEqual(
    f.children[0].messages
      .filter((message) => message.kind === 'event')
      .map((message) => message.name),
    ['app:ready']
  )
})

test('app:ready wakes a cached subscriber, while shutdown events keep it asleep', async (t) => {
  const f = await fixture(t)
  await f.manager.broadcastEvent('app:before-quit', {})
  assert.equal(f.children.length, 0)
  f.manager.shuttingDown = true
  await f.manager.broadcastEvent('app:ready', {})
  assert.equal(f.children.length, 0)
  f.manager.shuttingDown = false
  const broadcasting = f.manager.broadcastEvent('app:ready', {})
  await new Promise(setImmediate)
  assert.equal(f.children.length, 1)
  await f.activationStarted
  f.register()
  f.activate()
  await broadcasting
  await new Promise(setImmediate)
  assert.equal(f.children[0].messages.filter((message) => message.kind === 'event').length, 1)
})

test('failed activation rejects concurrent callers and removes cached routes', async (t) => {
  const f = await fixture(t)
  const first = f.manager
    .callProvider('demo', 'searchSongs', ['first'])
    .catch((error) => error.message)
  await f.activationStarted
  const second = f.manager
    .callProvider('demo', 'searchSongs', ['second'])
    .catch((error) => error.message)
  f.children[0].emit('message', { kind: 'host-error', message: 'activation failed' })
  assert.match(await first, /activation failed/)
  assert.match(await second, /activation failed/)
  assert.deepEqual(
    f.manager.listProviders().map((provider) => provider.id),
    []
  )
})

test('local playback proxies survive the five-minute idle boundary without player subscriptions', async (t) => {
  for (const url of [
    'http://127.0.0.1:32100/stream/current',
    'http://127.0.0.2:32100/stream/current',
    'http://localhost:32100/stream/current',
    'http://[::1]:32100/stream/current',
    'https://LOCALHOST.:32100/stream/current'
  ]) {
    await t.test(url, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const f = await fixture(t, { providerId: 'bili' })
      const playback = f.manager.callProvider('bili', 'getPlaybackUrl', [url])
      await f.activationStarted
      f.register()
      f.activate()
      assert.match(await playback, /^twilight-media:\/\/audio\//)
      assert.equal(f.manager.rpcCalls.getPendingCount(f.descriptor.id), 0)

      t.mock.timers.tick(299999)
      await new Promise(setImmediate)
      assert.equal(f.manager.running.has(f.descriptor.id), true)
      t.mock.timers.tick(1)
      await new Promise(setImmediate)
      assert.equal(
        f.manager.running.has(f.descriptor.id),
        true,
        'the stream host must survive 5:00'
      )
      assert.equal(f.manager.isHibernated(f.descriptor.id), false)

      // A paused track or a prepared queue URL has no RPCs or subscribed events
      // either, but still needs the same proxy when it resumes or starts.
      t.mock.timers.tick(6 * 300000)
      await new Promise(setImmediate)
      await f.manager.hibernatePlugin(f.descriptor.id)
      assert.equal(f.manager.running.has(f.descriptor.id), true)
      assert.equal(
        f.children[0].messages.some((message) => message.kind === 'deactivate'),
        false
      )

      // Explicit stop/disable must still shut down a resident media proxy.
      await f.manager.stopPlugin(f.descriptor.id)
      assert.equal(f.manager.running.has(f.descriptor.id), false)
      assert.equal(
        f.children[0].messages.some((message) => message.kind === 'deactivate'),
        true
      )

      const restarting = f.manager.startPlugin(f.descriptor)
      await new Promise(setImmediate)
      f.children[1].emit('message', { kind: 'activated', pluginId: f.descriptor.id })
      await restarting
      assert.equal(
        f.manager.canHibernatePlugin(f.descriptor.id),
        true,
        'residency belongs to one host instance'
      )
    })
  }
})

test('CDN playback URLs and non-playback loopback results still allow idle hibernation', async (t) => {
  for (const [method, value] of [
    ['getPlaybackUrl', 'https://audio.example.com/song.m4a'],
    ['getPlaybackUrl', 'https://localhost.example.com/song.m4a'],
    ['getPlaybackUrl', 'D:\\Music\\cached.flac'],
    ['getPlaybackUrl', null],
    ['searchSongs', 'http://127.0.0.1:32100/image/cover']
  ]) {
    await t.test(`${method}: ${value}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const f = await fixture(t)
      const call = f.manager.callProvider('demo', method, [value])
      await f.activationStarted
      f.register()
      f.activate()
      await call

      t.mock.timers.tick(299999)
      await new Promise(setImmediate)
      assert.equal(f.manager.running.has(f.descriptor.id), true)
      t.mock.timers.tick(1)
      await new Promise(setImmediate)
      assert.equal(f.manager.running.has(f.descriptor.id), false)
      assert.equal(f.manager.isHibernated(f.descriptor.id), true)
      assert.equal(
        f.children[0].messages.some((message) => message.kind === 'deactivate'),
        true
      )
    })
  }
})
