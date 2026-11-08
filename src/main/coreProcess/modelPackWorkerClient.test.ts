import assert from 'node:assert/strict'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ModelPackWorkerClient, type ModelPackWorkerLease } from './modelPackWorkerClient.ts'
import type { ModelPackWorkerRequest } from './modelPackWorkerProtocol.ts'

class ProcessLease extends EventEmitter implements ModelPackWorkerLease {
  readonly child: ChildProcess
  readonly exited: Promise<void>
  stderr = ''
  constructor() {
    super()
    this.child = fork(fileURLToPath(new URL('./modelPackWorker.ts', import.meta.url)), [], {
      execArgv: [
        '--experimental-strip-types',
        '--import',
        new URL('../../../scripts/register-renderer-aliases.mjs', import.meta.url).href
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    } as ForkOptions & { windowsHide: true })
    this.child.stderr!.on('data', (bytes) => {
      this.stderr += String(bytes)
    })
    this.child.on('message', (message) => this.emit('message', message))
    this.child.on('error', (error) => this.emit('error', error))
    this.exited = new Promise((resolve) =>
      this.child.once('exit', (code) => {
        this.emit('exit', code)
        resolve()
      })
    )
  }
  postMessage(message: ModelPackWorkerRequest): void {
    this.child.send(message)
  }
  async terminate(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
    await this.exited
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function packageFixture(root: string): Promise<{ archive: string; checkpoint: string }> {
  const model = Buffer.from('model fixture'),
    checkpoint = createHash('sha256').update(model).digest('hex')
  const metadata = Buffer.from(
    JSON.stringify({ modelVersion: 'demucs-4.0.1:955717e8', checkpointSha256: checkpoint })
  )
  const files = new Map([
    ['manifest.json', metadata],
    ['model.lock.json', metadata],
    ['models/955717e8-8726e21a.th', model],
    ['runtime/python.exe', Buffer.from('runtime fixture')]
  ])
  const local: Buffer[] = [],
    directory: Buffer[] = []
  let offset = 0
  for (const [name, bytes] of files) {
    const filename = Buffer.from(name),
      crc = crc32(bytes),
      header = Buffer.alloc(30),
      central = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(bytes.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(filename.length, 26)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    local.push(header, filename, bytes)
    directory.push(central, filename)
    offset += header.length + filename.length + bytes.length
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  const archive = join(root, 'fixture.zip')
  await writeFile(archive, Buffer.concat([...local, central, end]))
  return { archive, checkpoint }
}

test('model installation keeps the idle Core light, joins real host exit, and can install again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'model-worker-'))
  const fixture = await packageFixture(root),
    leases: ProcessLease[] = [],
    installed: boolean[] = []
  const client = new ModelPackWorkerClient({
    root,
    checkpointSha256: fixture.checkpoint,
    launch: () => {
      const lease = new ProcessLease()
      leases.push(lease)
      return lease
    },
    chooseArchive: async () => fixture.archive,
    decode: async () => {
      throw new Error('Stored ZIP needs no decoder')
    },
    probe: async (path) => {
      assert.match(path, /automix-stem-packs/)
      return { cpu: true, gpu: false }
    },
    installed: async (enabled) => {
      installed.push(enabled)
    },
    changed: () => {}
  })
  t.after(async () => {
    await client.shutdown()
    await Promise.all(leases.map((lease) => lease.terminate()))
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(client.state().phase, 'idle')
  client.cancel()
  assert.equal(leases.length, 0)
  assert.equal(client.start(true).phase, 'selecting')
  client.start(false)
  assert.equal(leases.length, 1)
  await leases[0].exited
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(client.state().phase, 'ready', leases[0].stderr)
  assert.deepEqual(installed, [true])
  const registry = JSON.parse(
    await readFile(join(root, 'automix-stem-packs', 'active.json'), 'utf8')
  )
  assert.equal(registry.length, 1)
  client.start(false)
  assert.equal(leases.length, 2)
  await leases[1].exited
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(client.state().phase, 'ready', leases[1].stderr)
  assert.deepEqual(installed, [true, false])
})

test('shutdown during a platform probe waits for its cancellation barrier before deleting staging and exiting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'model-worker-cancel-'))
  const fixture = await packageFixture(root)
  let lease!: ProcessLease, release!: () => void, entered!: () => void, cancelled!: () => void
  const probing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = new ModelPackWorkerClient({
    root,
    checkpointSha256: fixture.checkpoint,
    launch: () => (lease = new ProcessLease()),
    chooseArchive: async () => fixture.archive,
    decode: async () => {},
    installed: async () => {
      throw new Error('Cancelled install must not publish')
    },
    changed: () => {},
    probe: async (_path, signal) => {
      entered()
      signal.addEventListener('abort', cancelled, { once: true })
      await barrier
      signal.throwIfAborted()
      return { cpu: true, gpu: false }
    }
  })
  t.after(async () => {
    release()
    await client.shutdown()
    await lease?.terminate()
    await rm(root, { recursive: true, force: true })
  })
  client.start(false)
  await probing
  let stopped = false
  const closing = client.shutdown().then(() => {
    stopped = true
  })
  await cancellation
  assert.equal(stopped, false)
  assert.equal(lease.child.exitCode, null)
  release()
  await closing
  assert.equal(client.state().phase, 'cancelled', lease.stderr)
  const entries = await readdir(join(root, 'automix-stem-packs'))
  assert.deepEqual(entries, [])
})

test('a failed worker does not replay installation and a later explicit start gets a fresh host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'model-worker-crash-')),
    leases: ProcessLease[] = []
  let choose!: () => void
  const choosing = new Promise<void>((resolve) => {
    choose = resolve
  })
  const client = new ModelPackWorkerClient({
    root,
    launch: () => {
      const lease = new ProcessLease()
      leases.push(lease)
      return lease
    },
    chooseArchive: async (signal) => {
      if (leases.length > 1) return null
      choose()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      signal.throwIfAborted()
      return null
    },
    decode: async () => {},
    probe: async () => ({ cpu: true, gpu: false }),
    installed: async () => {},
    changed: () => {}
  })
  t.after(async () => {
    await client.shutdown()
    await Promise.all(leases.map((lease) => lease.terminate()))
    await rm(root, { recursive: true, force: true })
  })
  client.start(false)
  await choosing
  await leases[0].terminate()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(client.state().phase, 'failed')
  assert.equal(leases.length, 1)
  client.start(false)
  await leases[1].exited
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(client.state().phase, 'cancelled', leases[1].stderr)
})
