import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { CoreSupervisor, type CoreSupervisorOptions } from './supervisor.ts'
import type { CoreClientIdentity, CoreRequestEnvelope } from '../../shared/coreProtocol.ts'
import type { ServiceMessagePort } from '../services/servicePort.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('requested cache relocation remains restart-required across Core recovery', async (t) => {
  const { supervisor, children } = fixture(t)
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  core.emit('message', {
    kind: 'core:settings',
    epoch: core.epoch,
    state: { revision: 0, settings: { musicCachePath: 'D:/active-cache' } }
  })
  core.emit('message', {
    kind: 'core:settings',
    epoch: core.epoch,
    state: { revision: 1, settings: { musicCachePath: 'D:/next-launch-cache' } }
  })
  core.emit('exit', 1)
  await tick()
  const recovered = children[1].child
  recovered.boot()
  const initialization = recovered.sent.find((row) => row.message.kind === 'core:initialize')!
  assert.equal(initialization.message.configuration.musicCachePath, 'D:/active-cache')
})

test('private settings projection ignores an obsolete Core epoch and is not a renderer state broadcast', async (t) => {
  const { supervisor, children } = fixture(t)
  const projected: unknown[] = []
  supervisor.on('settings', (state, epoch) => projected.push({ state, epoch }))
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  const state = { revision: 3, settings: { theme: 'dark' } }
  core.emit('message', { kind: 'core:settings', epoch: 'obsolete', state })
  assert.deepEqual(projected, [])
  core.emit('message', { kind: 'core:settings', epoch: core.epoch, state })
  assert.deepEqual(projected, [{ state, epoch: core.epoch }])
})

test('a failed Core termination remains a barrier across explicit retry, even after remote Stop succeeded', async (t) => {
  const { supervisor, children } = fixture(t, { stopOutputs: async () => {} })
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  core.exitsOnKill = false
  const failed = once(supervisor, 'failure')
  core.emit('message', { kind: 'core:fatal', epoch: core.epoch, error: 'Remote control failed' })
  await failed
  assert.equal(supervisor.getStatus().phase, 'failed')
  await assert.rejects(supervisor.retry(), /Core termination not confirmed/)
  assert.equal(children.length, 1)
  core.emit('exit', 0)
  const retry = supervisor.retry()
  await tick()
  children[1].child.boot()
  await retry
})

test('Core death reclaims local services while remote Stop is pending and never restarts before its confirmation', async (t) => {
  let finish!: () => void
  const remoteStop = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { supervisor, children } = fixture(t, { stopOutputs: () => remoteStop })
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio',
    service: 'audio'
  })
  const audio = children[1].child
  core.emit('exit', 1)
  await tick()
  assert.equal(audio.kills, 1)
  assert.equal(supervisor.getStatus().epoch, null)
  assert.equal(children.length, 2)
  finish()
  await tick()
  assert.equal(children.length, 3)
  children[2].child.boot()
})

test('remote Stop failure still joins local termination and blocks restart until an explicit successful retry', async (t) => {
  let fail = true,
    stops = 0
  const { supervisor, children } = fixture(t, {
    stopOutputs: async () => {
      stops++
      if (fail) throw new Error('Remote Stop unconfirmed')
    }
  })
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio',
    service: 'audio'
  })
  const audio = children[1].child
  audio.stopReply = false
  audio.exitsOnKill = false
  core.emit('exit', 1)
  await tick()
  assert.equal(supervisor.getStatus().phase, 'recovering')
  audio.emit('exit', 0)
  await tick()
  assert.equal(supervisor.getStatus().phase, 'failed')
  assert.equal(children.length, 2)
  fail = false
  const retry = supervisor.retry()
  await tick()
  children[2].child.boot()
  await retry
  assert.equal(stops, 2)
  assert.equal(supervisor.getStatus().phase, 'ready')
})

test('private platform cancellation reaches only its own active request', async (t) => {
  let cancelled = false
  const { supervisor, children } = fixture(t, {
    platform: {
      'network.sftp': async (_payload, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              reject(signal.reason)
            },
            { once: true }
          )
        )
    }
  })
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  core.emit('message', {
    kind: 'core:platform',
    epoch: core.epoch,
    requestId: 'sftp',
    name: 'network.sftp',
    payload: {
      connection: { host: 'nas', username: 'alice', port: 22, keyPath: '/key' },
      operation: { kind: 'list', path: '/' }
    }
  })
  core.emit('message', { kind: 'core:platform-cancel', epoch: 'old-epoch', requestId: 'sftp' })
  assert.equal(cancelled, false)
  core.emit('message', { kind: 'core:platform-cancel', epoch: core.epoch, requestId: 'other' })
  assert.equal(cancelled, false)
  core.emit('message', { kind: 'core:platform-cancel', epoch: core.epoch, requestId: 'sftp' })
  assert.equal(cancelled, true)
  await tick()
  assert.equal(core.sent.find((row) => row.message.requestId === 'sftp')?.message.ok, false)
})
class Process extends EventEmitter {
  sent: Array<{ message: any; ports: ServiceMessagePort[] }> = []
  kills = 0
  exitsOnKill = true
  stopReply = true
  shutdownReply = true
  postMessage(message: any, ports: ServiceMessagePort[] = []) {
    this.sent.push({ message, ports })
    if (message.kind === 'supervisor:stop-audio' && this.stopReply)
      queueMicrotask(() =>
        this.emit('message', {
          kind: 'supervisor:audio-stopped',
          requestId: message.requestId,
          stopped: true
        })
      )
    if (message.kind === 'core:shutdown' && this.shutdownReply)
      queueMicrotask(() =>
        this.emit('message', {
          kind: 'core:shutdown-complete',
          epoch: this.epoch,
          requestId: message.requestId,
          ok: true
        })
      )
  }
  get epoch() {
    return this.sent.find((s) => s.message.kind === 'core:initialize')?.message.configuration.epoch
  }
  kill() {
    this.kills++
    if (this.exitsOnKill) queueMicrotask(() => this.emit('exit', 0))
    return true
  }
  boot(ready = true) {
    this.emit('message', { kind: 'core:booted' })
    this.emit('message', { kind: 'core:initialized', epoch: this.epoch })
    if (ready) this.emit('message', { kind: 'core:ready', epoch: this.epoch })
  }
}
class Port extends EventEmitter implements ServiceMessagePort {
  postMessage() {}
  start() {}
  close() {}
}
function fixture(t: test.TestContext, extra: Partial<CoreSupervisorOptions> = {}) {
  const children: Array<{ child: Process; entry: string; args: string[] }> = []
  const supervisor = new CoreSupervisor({
    entries: {
      core: '/registered/core',
      database: '/registered/database',
      audio: '/registered/audio',
      'audio-test': '/registered/audio',
      scan: '/registered/scan',
      analysis: '/registered/analysis',
      'model-install': '/registered/modelPackWorker',
      plugin: '/registered/plugin'
    },
    configuration: {
      root: '/isolated',
      coverCacheDir: '/isolated/cover',
      libraryFilePath: '/isolated/library.json',
      libraryStorage: 'sqlite'
    },
    fork: (entry, args) => {
      const child = new Process()
      children.push({ child, entry, args })
      return child
    },
    channel: () => ({ port1: new Port(), port2: new Port() }),
    stopTimeoutMs: 25,
    readyTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    ...extra
  })
  t.after(async () => {
    for (const p of children) {
      p.child.exitsOnKill = true
      p.child.stopReply = true
      p.child.shutdownReply = true
    }
    await supervisor.shutdown()
  })
  return { children, supervisor }
}
const identity: CoreClientIdentity = {
  id: 'desktop:1',
  role: 'desktop',
  permissions: ['playback:read', 'playback:write', 'library:read', 'migration:write']
}
function command(epoch: string, requestId: string): CoreRequestEnvelope {
  return { kind: 'command', epoch, requestId, name: 'playback.pause', payload: {} }
}

test('official provider login survives the ordinary deadline and accepts a delayed account result', async (t) => {
  const { supervisor, children } = fixture(t, { requestTimeoutMs: undefined })
  supervisor.connect({ ...identity, permissions: [...identity.permissions, 'providers:call'] })
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const request = supervisor.request(identity.id, {
      kind: 'command', name: 'providers.call', epoch: core.epoch, requestId: 'official',
      payload: { providerId: 'qq', method: 'openOfficialLogin', args: [] }
    })
    const ordinary = assert.rejects(supervisor.request(identity.id, command(core.epoch, 'ordinary')), {
      code: 'OUTCOME_UNKNOWN'
    })
    t.mock.timers.tick(181_000)
    await ordinary
    assert.deepEqual(core.sent.filter(row => row.message.kind === 'core:cancel')
      .map(row => row.message.requestId), ['ordinary'])
    core.emit('message', {
      kind: 'core:client-message', clientId: identity.id,
      message: { kind: 'response', requestId: 'official', epoch: core.epoch, ok: true,
        value: { loggedIn: true } }
    })
    assert.deepEqual(await request, { loggedIn: true })
  } finally {
    t.mock.timers.reset()
  }
})

for (const timeoutMs of [undefined, 50]) {
  test(`official login is cancelled at its ${timeoutMs === undefined ? 'default' : 'configured'} deadline`, async (t) => {
    const { supervisor, children } = fixture(t, { requestTimeoutMs: timeoutMs })
    supervisor.connect({ ...identity, permissions: [...identity.permissions, 'providers:call'] })
    const started = supervisor.start()
    const core = children[0].child
    core.boot()
    await started
    t.mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const rejected = assert.rejects(supervisor.request(identity.id, {
        kind: 'command', name: 'providers.call', epoch: core.epoch, requestId: 'official',
        payload: { providerId: 'ncm', method: 'openOfficialLogin', args: [] }
      }), { code: 'OUTCOME_UNKNOWN' })
      t.mock.timers.tick(timeoutMs ?? 245_000)
      await rejected
      assert.equal(core.sent.at(-1)?.message.kind, 'core:cancel')
      assert.equal(core.sent.at(-1)?.message.requestId, 'official')
    } finally {
      t.mock.timers.reset()
    }
  })
}

test('only the fixed service registry launches children and transfers distinct private ports', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio-1',
    service: 'audio',
    entry: '/untrusted/evil',
    env: { INJECT: 'yes' }
  })
  assert.equal(children[1].entry, '/registered/audio')
  assert.deepEqual(children[1].args, ['--twilight-core-service'])
  const attached = children[1].child.sent.find((m) => m.message.kind === 'core:attach-service')!
  const connected = core.sent.find((m) => m.message.kind === 'core:service-connected')!
  assert.equal(attached.ports.length, 1)
  assert.equal(connected.ports.length, 1)
  assert.notEqual(attached.ports[0], connected.ports[0])
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'evil',
    service: '../../evil'
  })
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio-2',
    service: 'audio'
  })
  assert.equal(children.length, 2)
  assert.equal(core.sent.filter((m) => m.message.kind === 'core:service-error').length, 2)
})
test('trusted identity and epoch gate requests; the migration client can connect before ready', async (t) => {
  const { supervisor, children } = fixture(t)
  supervisor.connect(identity)
  const started = supervisor.start()
  const core = children[0].child
  core.boot(false)
  assert.equal(core.sent.filter((s) => s.message.kind === 'core:connect').length, 1)
  await assert.rejects(supervisor.request(identity.id, command(core.epoch, 'early')), /not ready/)
  const snapshot: CoreRequestEnvelope = {
    kind: 'query',
    name: 'state.snapshot',
    payload: {},
    epoch: core.epoch,
    requestId: 'initial'
  }
  const request = supervisor.request(identity.id, snapshot)
  core.emit('message', {
    kind: 'core:client-message',
    clientId: identity.id,
    message: {
      kind: 'response',
      requestId: 'initial',
      epoch: core.epoch,
      ok: true,
      value: { migrationRequired: true }
    }
  })
  assert.deepEqual(await request, { migrationRequired: true })
  core.emit('message', { kind: 'core:ready', epoch: core.epoch })
  await started
  await assert.rejects(
    supervisor.request(identity.id, command('previous', 'stale')),
    /epoch changed/
  )
  supervisor.connect({ id: 'plugin:read-only', role: 'plugin', permissions: ['playback:read'] })
  await assert.rejects(
    supervisor.request('plugin:read-only', command(core.epoch, 'denied')),
    /not permitted/
  )
})

test('output test has a separate single-instance lease and cannot replace the music service', async (t) => {
  const { supervisor, children } = fixture(t)
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  for (const [leaseId, service] of [
    ['music', 'audio'],
    ['test', 'audio-test'],
    ['duplicate', 'audio-test']
  ])
    core.emit('message', { kind: 'core:service-open', epoch: core.epoch, leaseId, service })
  assert.equal(children.length, 3)
  assert.equal(children[1].entry, '/registered/audio')
  assert.equal(children[2].entry, '/registered/audio')
  assert.ok(
    core.sent.some(
      ({ message }) => message.kind === 'core:service-error' && message.leaseId === 'duplicate'
    )
  )
  assert.ok(
    core.sent.some(
      ({ message }) => message.kind === 'core:service-exit' && message.leaseId === 'duplicate'
    )
  )
})

test('Core restart waits for both music and test audio silence, including actual test process exit', async (t) => {
  const { supervisor, children } = fixture(t)
  const starting = supervisor.start(),
    core = children[0].child
  core.boot()
  await starting
  for (const service of ['audio', 'audio-test'])
    core.emit('message', {
      kind: 'core:service-open',
      epoch: core.epoch,
      leaseId: service,
      service
    })
  const music = children[1].child,
    outputTest = children[2].child
  outputTest.stopReply = false
  outputTest.exitsOnKill = false
  const failed = once(supervisor, 'failure')
  core.emit('exit', 1)
  await failed
  for (const child of [music, outputTest]) {
    assert.equal(
      child.sent.filter(({ message }) => message.kind === 'supervisor:stop-audio').length,
      1
    )
    assert.equal(child.kills, 1)
  }
  assert.equal(supervisor.getStatus().phase, 'failed')
  assert.equal(children.length, 3)
  outputTest.emit('exit', 0)
})

test('a failed service fork confirms no process exists so its termination lease can settle', async (t) => {
  const core = new Process()
  const { supervisor } = fixture(t, {
    fork: (entry) => {
      if (entry === '/registered/core') return core
      throw new Error('fork unavailable')
    }
  })
  const starting = supervisor.start()
  core.boot()
  await starting
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'test',
    service: 'audio-test'
  })
  assert.deepEqual(
    core.sent.slice(-2).map(({ message }) => message),
    [
      { kind: 'core:service-error', leaseId: 'test', error: 'fork unavailable' },
      { kind: 'core:service-exit', leaseId: 'test', code: null }
    ]
  )
})
test('Core failure invalidates pending writes, silences audio, restarts once paused, and never replays requests', async (t) => {
  const { supervisor, children } = fixture(t)
  supervisor.connect(identity)
  const started = supervisor.start()
  const first = children[0].child
  first.boot()
  await started
  first.emit('message', {
    kind: 'core:service-open',
    epoch: first.epoch,
    leaseId: 'audio',
    service: 'audio'
  })
  const audio = children[1].child
  const pending = supervisor.request(identity.id, command(first.epoch, 'unknown-write'))
  const rejected = assert.rejects(pending, (e: any) => e.code === 'OUTCOME_UNKNOWN')
  first.emit('exit', 9)
  assert.equal(supervisor.getStatus().epoch, null)
  await rejected
  await tick()
  await tick()
  assert.equal(audio.sent.filter((s) => s.message.kind === 'supervisor:stop-audio').length, 1)
  assert.equal(audio.kills, 1)
  assert.equal(children.filter((p) => p.entry === '/registered/core').length, 2)
  const second = children[2].child
  second.boot()
  await tick()
  const configuration = second.sent.find((s) => s.message.kind === 'core:initialize')!.message
    .configuration
  assert.equal(configuration.recovery, true)
  assert.notEqual(configuration.epoch, first.epoch)
  assert.equal(second.sent.filter((s) => s.message.kind === 'core:request').length, 0)
  second.emit('exit', 9)
  await tick()
  await tick()
  assert.equal(supervisor.getStatus().phase, 'failed')
  assert.equal(children.filter((p) => p.entry === '/registered/core').length, 2)
})
test('unconfirmed silence kills the owned audio process and withholds restart until exit is confirmed', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio',
    service: 'audio'
  })
  const audio = children[1].child
  audio.stopReply = false
  audio.exitsOnKill = false
  core.emit('exit', 1)
  await new Promise((resolve) => setTimeout(resolve, 65))
  assert.equal(audio.kills, 1)
  assert.equal(supervisor.getStatus().phase, 'failed')
  assert.equal(children.length, 2)
  audio.emit('exit', 0)
})
test('shutdown requires a successful durable flush acknowledgement before destroying Core', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.shutdownReply = false
  const shutdown = supervisor.shutdown()
  const message = core.sent.find((s) => s.message.kind === 'core:shutdown')!.message
  assert.equal(core.kills, 0)
  core.emit('message', {
    kind: 'core:shutdown-complete',
    epoch: core.epoch,
    requestId: message.requestId,
    ok: false,
    error: 'Disk full'
  })
  await assert.rejects(shutdown, /Disk full/)
  assert.equal(core.kills, 0)
  core.shutdownReply = true
  await supervisor.shutdown()
  assert.equal(core.kills, 1)
})

test('an initialized Core awaiting browser migration still confirms its checkpoint before shutdown', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  void started.catch(() => {})
  const core = children[0].child
  core.boot(false)
  await supervisor.shutdown()
  assert.equal(core.sent.filter((s) => s.message.kind === 'core:shutdown').length, 1)
  assert.equal(core.kills, 1)
  assert.equal(supervisor.getStatus().phase, 'stopped')
})

test('a timed-out shutdown retry joins the original checkpoint and accepts its late ACK', async (t) => {
  const { supervisor, children } = fixture(t, { requestTimeoutMs: 20 })
  supervisor.connect(identity)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.shutdownReply = false
  await assert.rejects(supervisor.shutdown(), /Core did not confirm final persistence/)
  assert.equal(core.kills, 0)
  await assert.rejects(supervisor.request(identity.id, command(core.epoch, 'after-timeout')), {
    code: 'NOT_READY'
  })
  const retry = supervisor.shutdown()
  const messages = core.sent.filter(({ message }) => message.kind === 'core:shutdown')
  assert.equal(messages.length, 1)
  core.emit('message', {
    kind: 'core:shutdown-complete',
    epoch: core.epoch,
    requestId: messages[0].message.requestId,
    ok: true
  })
  await retry
  assert.equal(core.kills, 1)
  assert.equal(supervisor.getStatus().phase, 'stopped')
})

test('shutdown still delivers responses to already-dispatched requests, while rejecting new work', async (t) => {
  const { supervisor, children } = fixture(t)
  supervisor.connect(identity)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.shutdownReply = false
  const request = supervisor.request(identity.id, command(core.epoch, 'dispatched'))
  const shutdown = supervisor.shutdown()
  core.emit('message', {
    kind: 'core:client-message',
    clientId: identity.id,
    message: {
      kind: 'response',
      epoch: core.epoch,
      requestId: 'dispatched',
      ok: true,
      value: 'done'
    }
  })
  assert.equal(await request, 'done')
  await assert.rejects(supervisor.request(identity.id, command(core.epoch, 'new-work')), {
    code: 'NOT_READY'
  })
  const message = core.sent.find(({ message }) => message.kind === 'core:shutdown')!.message
  core.emit('message', {
    kind: 'core:shutdown-complete',
    epoch: core.epoch,
    requestId: message.requestId,
    ok: true
  })
  await shutdown
})

test('explicit discard after an unconfirmed checkpoint reclaims Core, audio and database without saving again', async (t) => {
  let stoppedOutputs = 0
  const { supervisor, children } = fixture(t, {
    requestTimeoutMs: 20,
    stopOutputs: async () => {
      stoppedOutputs++
    }
  })
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  for (const service of ['audio', 'database'])
    core.emit('message', {
      kind: 'core:service-open',
      epoch: core.epoch,
      leaseId: service,
      service
    })
  core.shutdownReply = false
  await assert.rejects(supervisor.shutdown(), /final persistence/)
  await supervisor.forceShutdown()
  assert.equal(core.sent.filter(({ message }) => message.kind === 'core:shutdown').length, 1)
  assert.equal(stoppedOutputs, 1)
  assert.equal(children.length, 3)
  assert.ok(children.every(({ child }) => child.kills === 1))
  assert.deepEqual(supervisor.getStatus(), { phase: 'stopped', epoch: null })
})

test('discard does not report completion before every owned service actually exits', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'database',
    service: 'database'
  })
  const database = children[1].child
  database.exitsOnKill = false
  await assert.rejects(supervisor.forceShutdown(), /Service termination not confirmed/)
  assert.notEqual(supervisor.getStatus().phase, 'stopped')
  assert.equal(core.kills, 1)
  database.emit('exit', 0)
  await supervisor.forceShutdown()
  assert.equal(supervisor.getStatus().phase, 'stopped')
  assert.equal(core.sent.filter(({ message }) => message.kind === 'core:shutdown').length, 0)
})

test('explicit discard settles in-flight writes as unknown and queries as cancelled without replay', async (t) => {
  const { supervisor, children } = fixture(t)
  supervisor.connect(identity)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  const write = assert.rejects(supervisor.request(identity.id, command(core.epoch, 'write-once')), {
    code: 'OUTCOME_UNKNOWN'
  })
  const read = assert.rejects(
    supervisor.request(identity.id, {
      kind: 'query',
      name: 'state.snapshot',
      epoch: core.epoch,
      requestId: 'cancel-read',
      payload: {}
    }),
    { code: 'CANCELLED' }
  )
  await supervisor.forceShutdown()
  await Promise.all([write, read])
  assert.equal(core.sent.filter(({ message }) => message.kind === 'core:request').length, 2)
  assert.equal(core.sent.filter(({ message }) => message.kind === 'core:shutdown').length, 0)
  assert.equal(children.length, 1)
})

test('Core exit without a shutdown ACK fails promptly instead of waiting out the checkpoint deadline', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.shutdownReply = false
  const shutdown = supervisor.shutdown()
  core.emit('exit', 7)
  await assert.rejects(shutdown, /Core exited \(7\)/)
  await supervisor.forceShutdown()
  assert.equal(children.length, 1)
})

test('a late fatal failure after checkpoint timeout still reclaims services without restarting Core', async (t) => {
  const { supervisor, children } = fixture(t, { requestTimeoutMs: 20 })
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio',
    service: 'audio'
  })
  core.shutdownReply = false
  await assert.rejects(supervisor.shutdown(), /final persistence/)
  core.emit('message', {
    kind: 'core:fatal',
    epoch: core.epoch,
    error: 'Cannot confirm audio stopped'
  })
  await tick()
  await tick()
  assert.equal(children.length, 2)
  assert.equal(children[1].child.kills, 1)
  assert.equal(supervisor.getStatus().phase, 'failed')
})

test('an owned service rejected by pre-spawn kill is terminated on spawn before Core may restart', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'scanner-starting',
    service: 'scan'
  })
  const scan = children[1].child
  let spawned = false
  const kill = scan.kill.bind(scan)
  scan.kill = () => (spawned ? kill() : false)
  core.emit('exit', 1)
  await tick()
  assert.equal(children.length, 2)
  assert.equal(supervisor.getStatus().phase, 'recovering')
  spawned = true
  scan.emit('spawn')
  await tick()
  await tick()
  assert.equal(scan.kills, 1)
  assert.equal(children.length, 3)
  children[2].child.boot()
})

test('a fatal stop failure during shutdown invalidates the epoch and reclaims audio without restarting Core', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  core.emit('message', {
    kind: 'core:service-open',
    epoch: core.epoch,
    leaseId: 'audio',
    service: 'audio'
  })
  const audio = children[1].child
  core.shutdownReply = false
  const shutdown = supervisor.shutdown()
  const rejected = assert.rejects(shutdown, /Cannot confirm audio stopped/)
  core.emit('message', {
    kind: 'core:fatal',
    epoch: core.epoch,
    error: 'Cannot confirm audio stopped'
  })
  await rejected
  await tick()
  await tick()
  assert.equal(supervisor.getStatus().epoch, null)
  assert.equal(audio.kills, 1)
  assert.equal(supervisor.getStatus().phase, 'failed')
  assert.equal(children.filter((child) => child.entry === '/registered/core').length, 1)
})
test('platform UI lifetime is cancelled before a crashed Core can be replaced', async (t) => {
  let cancelled = false
  const { supervisor, children } = fixture(t, {
    platform: {
      'ncm.officialLogin': async (_payload, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              reject(signal.reason)
            },
            { once: true }
          )
        })
    }
  })
  const start = supervisor.start()
  const old = children[0].child
  old.boot()
  await start
  old.emit('message', {
    kind: 'core:platform',
    epoch: old.epoch,
    requestId: 'login',
    name: 'ncm.officialLogin',
    payload: {}
  })
  old.emit('exit', 1)
  assert.equal(cancelled, true)
  await tick()
  const replacement = children[1].child
  replacement.boot()
  await tick()
  assert.equal(supervisor.getStatus().phase, 'ready')
  assert.equal(old.sent.filter((row) => row.message.kind === 'core:platform-response').length, 0)
})

test('three fixed Zone audio leases have separate capacity and a failed peer does not reclaim others', async t => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start(), core = children[0].child
  core.boot(); await started
  const open = (leaseId: string, service: string) => core.emit('message', { kind: 'core:service-open', epoch: core.epoch, leaseId, service })
  open('primary', 'audio')
  for (let i = 0; i < 4; i++) open(`zone-${i}`, 'zone-audio')
  assert.equal(children.length, 5)
  assert.ok(children.slice(1).every(child => child.entry === '/registered/audio'))
  assert.ok(core.sent.some(row => row.message.kind === 'core:service-error' && row.message.leaseId === 'zone-3'))
  const primary = children[1].child, first = children[2].child, second = children[3].child
  first.emit('exit', 1)
  await tick()
  assert.equal(primary.kills, 0); assert.equal(second.kills, 0)
  assert.equal(supervisor.getStatus().phase, 'ready')
  open('replacement', 'zone-audio')
  assert.equal(children.length, 6)
  second.stopReply = false
  core.emit('message', { kind: 'core:service-close', epoch: core.epoch, leaseId: 'zone-1' })
  const stop = second.sent.find(row => row.message.kind === 'supervisor:stop-audio')!
  assert.ok(stop); assert.equal(second.kills, 0)
  second.emit('message', { kind: 'supervisor:audio-stopped', requestId: stop.message.requestId, stopped: true })
  await tick()
  assert.equal(second.kills, 1); assert.equal(primary.kills, 0)
})

test('core:service-close silences audio and audio-test peers before terminating their process', async (t) => {
  const { supervisor, children } = fixture(t)
  const started = supervisor.start()
  const core = children[0].child
  core.boot()
  await started
  for (const service of ['audio', 'audio-test'] as const) {
    core.emit('message', {
      kind: 'core:service-open',
      epoch: core.epoch,
      leaseId: service,
      service
    })
  }
  const music = children[1].child
  const outputTest = children[2].child
  music.stopReply = false
  outputTest.stopReply = false

  core.emit('message', {
    kind: 'core:service-close',
    epoch: core.epoch,
    leaseId: 'audio'
  })
  core.emit('message', {
    kind: 'core:service-close',
    epoch: core.epoch,
    leaseId: 'audio-test'
  })

  // Process must NOT be killed before supervisor:audio-stopped is acknowledged (or times out).
  assert.equal(music.kills, 0)
  assert.equal(outputTest.kills, 0)
  const musicStop = music.sent.find((row) => row.message.kind === 'supervisor:stop-audio')
  const testStop = outputTest.sent.find((row) => row.message.kind === 'supervisor:stop-audio')
  assert.ok(musicStop)
  assert.ok(testStop)

  music.emit('message', {
    kind: 'supervisor:audio-stopped',
    requestId: musicStop.message.requestId,
    stopped: true
  })
  await tick()
  assert.equal(music.kills, 1)
  assert.equal(outputTest.kills, 0)

  outputTest.emit('message', {
    kind: 'supervisor:audio-stopped',
    requestId: testStop.message.requestId,
    stopped: true
  })
  await tick()
  assert.equal(outputTest.kills, 1)
})

test('getLastError captures the fatal failure reason and clears once Core recovers', async (t) => {
  const { supervisor, children } = fixture(t)
  assert.equal(supervisor.getLastError(), null)
  const started = supervisor.start()
  const first = children[0].child
  first.boot()
  await started
  assert.equal(supervisor.getLastError(), null)

  first.emit('message', {
    kind: 'core:fatal',
    epoch: first.epoch,
    error: 'Corrupt SQLite B-tree page 4'
  })
  assert.equal(supervisor.getLastError(), 'Corrupt SQLite B-tree page 4')
  await tick()
  await tick()
  const second = children[1].child
  second.boot()
  await tick()
  assert.equal(supervisor.getLastError(), null)
})
