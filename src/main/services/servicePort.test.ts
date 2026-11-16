import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createServicePort, type ServiceMessagePort } from './servicePort.ts'
import { CoreServiceLauncher } from '../coreProcess/serviceLauncher.ts'
import type { CoreChildMessage } from '../../shared/coreProcessProtocol.ts'

class Port extends EventEmitter implements ServiceMessagePort {
  sent: unknown[] = []
  started = false
  closed = false
  postMessage(message: unknown) {
    this.sent.push(message)
  }
  start() {
    this.started = true
  }
  close() {
    this.closed = true
  }
}
test('peer-mode service startup uses the transferred MessagePort; main is not a business relay', () => {
  const parent = new Port(),
    peer = new Port()
  const received: unknown[] = [],
    supervised: unknown[] = []
  const service = createServicePort({
    parent,
    peerMode: true,
    supervise: (message, reply) => {
      supervised.push(message)
      reply({ stopped: true })
    }
  })
  service.on('message', (message) => received.push(message))
  service.postMessage({ kind: 'ready' })
  assert.deepEqual(parent.sent, [])
  parent.emit('message', { data: { kind: 'core:attach-service' }, ports: [peer] })
  assert.equal(peer.started, true)
  assert.deepEqual(peer.sent, [{ kind: 'ready' }])
  parent.emit('message', { data: { kind: 'request', method: 'Play' } })
  assert.deepEqual(received, [])
  peer.emit('message', { data: { kind: 'request', method: 'GetPlaybackInfo' } })
  assert.equal(received.length, 1)
  parent.emit('message', { data: { kind: 'supervisor:stop-audio', requestId: 's' } })
  assert.equal(supervised.length, 1)
  assert.deepEqual(parent.sent, [{ stopped: true }])
  const replacement = new Port()
  parent.emit('message', { data: { kind: 'core:attach-service' }, ports: [replacement] })
  service.postMessage({ kind: 'response' })
  assert.equal(replacement.sent.length, 0)
  assert.equal(peer.sent.length, 2)
})
test('existing main/Node service callers retain the original direct protocol', () => {
  const parent = new Port(),
    incoming: unknown[] = []
  const service = createServicePort({ parent, peerMode: false })
  service.on('message', (message) => incoming.push(message))
  service.postMessage({ kind: 'ready' })
  parent.emit('message', { data: { kind: 'request' } })
  assert.deepEqual(parent.sent, [{ kind: 'ready' }])
  assert.deepEqual(incoming, [{ kind: 'request' }])
})
test('lease connection buffers only unsent messages; detach never replays a sent write', () => {
  const sent: CoreChildMessage[] = [],
    replies: unknown[] = []
  const launcher = new CoreServiceLauncher('epoch', (message) => sent.push(message))
  const lease = launcher.launch('database')
  lease.on('message', (message) => replies.push(message))
  const request = { kind: 'call', requestId: 'write', method: 'patchTracks', args: [] }
  lease.postMessage(request)
  const port = new Port()
  launcher.handle({ kind: 'core:service-connected', leaseId: lease.id }, [port])
  assert.deepEqual(port.sent, [request])
  port.emit('message', { data: { kind: 'response', requestId: 'write', ok: true } })
  assert.equal(replies.length, 1)
  launcher.handle({ kind: 'core:service-exit', leaseId: lease.id, code: 1 })
  const other = new Port()
  launcher.handle({ kind: 'core:service-connected', leaseId: lease.id }, [other])
  assert.equal(other.closed, true)
  assert.equal(other.sent.length, 0)
  assert.throws(() => lease.postMessage(request), /closed/)
  launcher.destroy()
})
test('service port notifies onClose when peer or parent port closes', () => {
  const parent = new Port()
  const peer = new Port()
  const closedSources: Array<'peer' | 'parent'> = []
  createServicePort({
    parent,
    peerMode: true,
    onClose: (source) => closedSources.push(source)
  })
  parent.emit('message', { data: { kind: 'core:attach-service' }, ports: [peer] })
  peer.emit('close')
  assert.deepEqual(closedSources, ['peer'])
  parent.emit('close')
  assert.deepEqual(closedSources, ['peer', 'parent'])
})
test('servicePort adapts worker_threads parentPort automatically without entering peerMode', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'twilight-service-port-worker-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const servicePortUrl = pathToFileURL(resolve(import.meta.dirname, './servicePort.ts')).href
  const entry = join(dir, 'echo-worker.mjs')
  writeFileSync(
    entry,
    `
      import { createServicePort } from ${JSON.stringify(servicePortUrl)};
      const port = createServicePort();
      port.postMessage({ kind: 'ready', argvCount: process.argv.length });
      port.on('message', (msg) => port.postMessage({ kind: 'echo', value: msg.value }));
    `
  )
  const worker = new Worker(entry, {
    workerData: { twilightWorkerThread: true }
  })
  t.after(() => worker.terminate())
  const messages: unknown[] = []
  await new Promise<void>((resolveReady, rejectReady) => {
    worker.once('error', rejectReady)
    worker.on('message', (message: { kind?: string; value?: unknown }) => {
      messages.push(message)
      if (message.kind === 'ready') worker.postMessage({ value: 'ping' })
      else if (message.kind === 'echo') resolveReady()
    })
  })
  assert.equal((messages[0] as { kind: string }).kind, 'ready')
  assert.deepEqual(messages[1], { kind: 'echo', value: 'ping' })
})
