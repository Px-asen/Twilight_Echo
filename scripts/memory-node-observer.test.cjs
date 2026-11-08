const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { once } = require('node:events')
const { observeNodeSpawns } = require('./memory-node-observer.cjs')

test('Node host observer preserves IPC handles, callbacks, arguments and environment', () => {
  const launches = [],
    sent = []
  const child = {
    send: (...args) => {
      sent.push(args)
      return true
    }
  }
  const originalSpawn = (...args) => {
    launches.push(args)
    return child
  }
  const processes = { spawn: originalSpawn }
  let endpoint
  const dispose = observeNodeSpawns({
    childProcess: processes,
    scriptsRoot: '/harness',
    sampleDir: '/samples',
    observe: (target, role, peer, intercept) => {
      assert.equal(target, child)
      assert.equal(role, 'twilight-core')
      endpoint = peer
      intercept((message) => {
        if (message.kind === 'initialize') message.fixture = true
      })
    }
  })
  const argv = [
    '--max-old-space-size=256',
    '/runtime/bootstrap.cjs',
    '/runtime/musicCore.cjs',
    '--service'
  ]
  const env = { USER_FIXTURE: 'preserved' }
  assert.equal(
    processes.spawn('/runtime/node.exe', argv, { env, serialization: 'advanced' }),
    child
  )
  assert.deepEqual(argv, [
    '--max-old-space-size=256',
    '/runtime/bootstrap.cjs',
    '/runtime/musicCore.cjs',
    '--service'
  ])
  assert.equal(launches[0][1][1], join('/harness', 'memory-node-wrapper.cjs'))
  assert.equal(launches[0][2].env.USER_FIXTURE, 'preserved')
  assert.equal(launches[0][2].env.TWILIGHT_MEMORY_ORIGINAL_BOOTSTRAP, '/runtime/bootstrap.cjs')
  assert.equal(launches[0][2].serialization, 'advanced')
  const handle = {},
    options = { keepOpen: false },
    callback = () => {}
  child.send({ message: { kind: 'initialize' }, socket: true }, handle, options, callback)
  assert.equal(sent[0][0].message.fixture, true)
  assert.equal(sent[0][1], handle)
  assert.equal(sent[0][2], options)
  assert.equal(sent[0][3], callback)
  endpoint.postMessage({ kind: 'request' })
  assert.deepEqual(sent[1][0], { message: { kind: 'request' }, socket: false })
  processes.spawn('/other', ['different.cjs'], { env })
  assert.deepEqual(launches[1], ['/other', ['different.cjs'], { env }])
  dispose()
  assert.equal(processes.spawn, originalSpawn)
})

test('Node benchmark wrapper samples the actual process and preserves bootstrap argv', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-node-observer-'))
  const samples = join(root, 'samples')
  mkdirSync(samples)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bootstrap = join(root, 'bootstrap.cjs'),
    entry = join(root, 'musicCore.cjs')
  writeFileSync(bootstrap, 'require(process.argv[2])')
  writeFileSync(
    entry,
    `process.send({args:process.argv.slice(1),pid:process.pid});process.on('message',()=>process.exit(0))`
  )
  const processes = { spawn: require('node:child_process').spawn }
  const dispose = observeNodeSpawns({
    childProcess: processes,
    scriptsRoot: __dirname,
    sampleDir: samples,
    observe: () => {}
  })
  t.after(dispose)
  const child = processes.spawn(process.execPath, [bootstrap, entry, 'unchanged'], {
    cwd: resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) })
  assert.deepEqual(message.args, [bootstrap, entry, 'unchanged'])
  const sample = JSON.parse(readFileSync(join(samples, `${message.pid}.json`), 'utf8'))
  assert.equal(sample.pid, child.pid)
  assert.ok(sample.heapUsed > 0)
  const exited = once(child, 'exit')
  child.send({ done: true })
  assert.equal((await exited)[0], 0)
})

test('desktop supervision instrumentation decodes requests and replies without changing wire transport', () => {
  const sent = []
  const child = {
    send: (...args) => {
      sent.push(args)
      return true
    }
  }
  const processes = { spawn: () => child }
  const codec = {
    encodeSupervisionMessage: (value) => ({ version: 1, fixture: structuredClone(value) }),
    decodeSupervisionMessage: (value) => structuredClone(value.fixture)
  }
  let peer, decode
  const dispose = observeNodeSpawns({
    childProcess: processes,
    scriptsRoot: '/harness',
    sampleDir: '/samples',
    codec,
    observe: (_child, _role, endpoint, intercept, read) => {
      peer = endpoint
      decode = read
      intercept((message) => {
        if (message.kind === 'initialize') message.injected = true
      })
    }
  })
  processes.spawn('/runtime/node', ['/runtime/bootstrap.cjs', '/runtime/musicCore.cjs'], {
    env: { TWILIGHT_DESKTOP_NODE_HOST: '1' },
    serialization: 'json'
  })
  const handle = {},
    callback = () => {}
  child.send(
    { message: codec.encodeSupervisionMessage({ kind: 'initialize' }), socket: true },
    handle,
    { keepOpen: false },
    callback
  )
  assert.equal(codec.decodeSupervisionMessage(sent[0][0].message).injected, true)
  assert.equal(sent[0][1], handle)
  assert.equal(sent[0][3], callback)
  peer.postMessage({ kind: 'core:request', payload: 123n })
  assert.equal(codec.decodeSupervisionMessage(sent[1][0].message).payload, 123n)
  assert.deepEqual(decode(codec.encodeSupervisionMessage({ kind: 'core:initialized' })), {
    kind: 'core:initialized'
  })
  dispose()
})
