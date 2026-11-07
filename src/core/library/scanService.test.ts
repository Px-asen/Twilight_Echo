import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import {
  LIBRARY_SCAN_DATABASE_METHODS,
  type LibraryDatabaseScanResult
} from '../../shared/libraryDatabase.ts'
import {
  LibraryScanInterruptedError,
  type CoreScanDatabase,
  type CoreScanRunner
} from '../../shared/coreScan.ts'
import { LibraryDatabaseScanCoordinator } from './scanCoordinator.ts'
import { CoreScanService, type CoreScanServiceOptions } from './scanService.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('file maintenance joins the decoder then resumes the same full scan, without recording a user Cancel', async (t) => {
  const f = fixture(t),
    { service, scanner } = f.create(),
    gate = deferred<void>(),
    entered = deferred<void>()
  await service.initialize()
  service.activate()
  const original = await service.start({ mode: 'full' })
  const work = service.maintain(async () => {
    assert.equal(scanner.current, null)
    assert.equal(f.sql.getScanProgress(original.jobId).state, 'interrupted')
    entered.resolve()
    await gate.promise
  })
  await entered.promise
  await assert.rejects(service.start({ mode: 'full' }), (error: any) => error.code === 'BUSY')
  gate.resolve()
  await work
  for (let i = 0; i < 20 && !scanner.current; i++) await tick()
  assert.equal(service.snapshot()?.jobId, original.jobId)
  assert.equal(f.sql.getScanProgress(original.jobId).state, 'running')
  assert.equal(f.sql.getLatestScanJob()!.mode, 'full')
})

test('maintenance retains a user Pause; reset does not resume the scan or pending directory queue', async (t) => {
  const f = fixture(t),
    { service, scanner } = f.create()
  await service.initialize()
  service.activate()
  const original = await service.start({ mode: 'full' })
  await service.pause(original.jobId)
  await service.maintain(async () => {})
  await tick()
  assert.equal(service.snapshot()?.state, 'paused')
  assert.equal(scanner.current, null)
  await service.resume(original.jobId)
  await service.enqueueDirectories([f.root + '/pending'])
  await service.maintain(async () => {
    f.sql.resetLibrary()
  }, false)
  await tick()
  assert.equal(service.snapshot()?.state, 'cancelled')
  assert.equal(scanner.current, null)
  assert.deepEqual(f.errors, [])
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

class Scanner implements CoreScanRunner {
  calls: string[] = []
  current: ReturnType<typeof deferred<LibraryDatabaseScanResult>> | null = null
  async scanDatabase(
    ...[id, , database, , , signal]: Parameters<CoreScanRunner['scanDatabase']>
  ): Promise<LibraryDatabaseScanResult> {
    this.calls.push(`scan:${id}`)
    const current = deferred<LibraryDatabaseScanResult>()
    this.current = current
    const abort = () => {
      void database
        .getScanProgress(id)
        .then((progress) => current.resolve({ cancelled: true, progress, removedFileCount: 0 }))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await current.promise
    } finally {
      signal?.removeEventListener('abort', abort)
      this.current = null
    }
  }
  pause(id: string) {
    this.calls.push(`pause:${id}`)
  }
  resume(id: string) {
    this.calls.push(`resume:${id}`)
  }
  destroy() {
    this.calls.push('destroy')
    this.current?.reject(new LibraryScanInterruptedError('Owned metadata process stopped'))
  }
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'core-scan-')).replaceAll('\\', '/')
  mkdirSync(join(root, 'downloads'))
  mkdirSync(join(root, 'pending'))
  const sql = new LibraryDatabase(':memory:')
  sql.updateConfiguration({ folders: [root], exclusions: [] })
  const names = [
    ...LIBRARY_SCAN_DATABASE_METHODS,
    'getMetadata',
    'listScanJobs',
    'getLatestScanJob',
    'startScan',
    'setScanState',
    'resumeScan'
  ] as const
  const database = Object.fromEntries(
    names.map((method) => [
      method,
      async (...args: any[]) => (sql[method] as (...args: any[]) => unknown).apply(sql, args)
    ])
  ) as unknown as CoreScanDatabase
  const errors: unknown[] = [],
    changes: number[] = [],
    authorized: string[] = []
  const services: CoreScanService[] = []
  let serial = 0
  const create = (
    authorizeDirectory = async (path: string) => {
      authorized.push(path)
      return path
    },
    directoryQueue?: CoreScanServiceOptions['directoryQueue']
  ) => {
    const scanner = new Scanner()
    const coordinator = new LibraryDatabaseScanCoordinator({
      database,
      scanner,
      coverCacheDir: '',
      now: Date.now,
      newId: () => `scan:${++serial}`,
      log() {}
    })
    const service = new CoreScanService({
      database,
      scanner,
      coordinator,
      directoryQueue,
      authorizeDirectory,
      changed: () => changes.push(1),
      failed: (error) => errors.push(error)
    })
    services.push(service)
    return { scanner, coordinator, service }
  }
  t.after(async () => {
    for (const service of services) await service.shutdown()
    sql.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, sql, database, create, errors, changes, authorized }
}

function finish(f: ReturnType<typeof fixture>, scanner: Scanner, jobId: string): void {
  const directories = f.sql.claimScanDirectories(jobId)
  for (const path of directories.directories)
    f.sql.recordScanDirectory(jobId, { path, children: [], complete: true })
  assert.equal(f.sql.finishScan(jobId).completed, true)
  scanner.current!.resolve({
    cancelled: false,
    progress: f.sql.getScanProgress(jobId),
    removedFileCount: 0
  })
}

test('startup reserves one task before authorization; polling waits for completion and yields to controls', async (t) => {
  const f = fixture(t),
    gate = deferred<string>()
  const { service, scanner } = f.create(() => gate.promise)
  await service.initialize()
  assert.equal(await service.poll(f.root), undefined)
  service.activate()
  const startup = service.startup()
  await service.startup()
  assert.equal(await service.poll(f.root), undefined)
  gate.resolve(f.root)
  await startup
  const job = f.sql.getLatestScanJob()!
  assert.equal(job.mode, 'startup')
  finish(f, scanner, job.id)
  await tick()
  let completed = false
  const polling = service.poll(f.root).then((result) => {
    completed = true
    return result
  })
  assert.equal(await service.poll(f.root), undefined)
  await tick()
  assert.equal(completed, false)
  const polled = f.sql.getLatestScanJob()!
  assert.equal(polled.mode, 'watch')
  finish(f, scanner, polled.id)
  assert.equal(await polling, false, 'unchanged revision uses polling backoff')
  const interrupted = service.poll(f.root)
  await tick()
  await service.shutdown()
  assert.equal(await interrupted, undefined)
  assert.equal(f.sql.getLatestScanJob()!.state, 'interrupted')
  assert.deepEqual(f.errors, [])
})

test('no configured roots means no startup job or metadata process', async (t) => {
  const f = fixture(t),
    { service, scanner } = f.create()
  f.sql.updateConfiguration({ folders: [], exclusions: [] })
  await service.initialize()
  service.activate()
  await service.startup()
  assert.deepEqual(f.sql.listScanJobs(), [])
  assert.deepEqual(scanner.calls, [])
})

test('start returns the durable job ACK; controls use its identity and work survives the starting client', async (t) => {
  const f = fixture(t),
    { service, scanner } = f.create()
  await service.initialize()
  service.activate()
  const client = new AbortController()
  const status = await service.start({ mode: 'full' }, client.signal)
  assert.equal(status.state, 'running')
  assert.equal(status.phase, 'checking')
  client.abort(new Error('Starting renderer disappeared'))
  assert.equal(service.snapshot()?.state, 'running')
  await assert.rejects(service.start({ mode: 'full' }), (e: any) => e.code === 'BUSY')
  assert.equal(await service.pause('old-job'), false)
  assert.equal(await service.cancel('old-job'), false)
  // Concurrent window controls are ordered, not competing SQL state writes.
  const pause = service.pause(status.jobId),
    resume = service.resume(status.jobId)
  assert.equal(await pause, true)
  assert.equal((await resume)?.state, 'running')
  assert.deepEqual(scanner.calls.slice(0, 3), [
    `scan:${status.jobId}`,
    `pause:${status.jobId}`,
    `resume:${status.jobId}`
  ])
  assert.equal(await service.cancel(status.jobId), true)
  assert.equal(f.sql.getScanProgress(status.jobId).state, 'cancelled')
  assert.deepEqual(f.authorized, [f.root])
})

test('download indexing survives restart but never restarts an explicit Pause or Cancel', async (t) => {
  const f = fixture(t)
  let pending: string[] = []
  const repository = {
    load: async () => [...pending],
    save: async (roots: string[]) => {
      pending = [...roots]
    }
  }
  const first = f.create(undefined, repository)
  await first.service.initialize()
  first.service.activate()
  const full = await first.service.start({ mode: 'full' })
  await first.service.pause(full.jobId)
  await first.service.enqueueDirectories([f.root + '/downloads', f.root + '/downloads'])
  assert.deepEqual(pending, [f.root + '/downloads'])
  assert.equal(first.scanner.calls.filter((call) => call.startsWith('scan:')).length, 1)
  await first.service.shutdown()
  const second = f.create(undefined, repository)
  await second.service.initialize()
  second.service.activate()
  await tick()
  assert.deepEqual(second.scanner.calls, [])
  assert.equal(await second.service.cancel(full.jobId), true)
  await second.service.startup()
  assert.equal(await second.service.poll(f.root), undefined)
  await tick()
  assert.deepEqual(second.scanner.calls, [])
  assert.deepEqual(pending, [f.root + '/downloads'])
  // Explicit Continue lifts the durable user stop; completion drains pending changes.
  await second.service.resume(full.jobId)
  finish(f, second.scanner, full.jobId)
  await tick()
  for (let i = 0; i < 20 && !second.scanner.current; i++) await tick()
  const job = f.sql.getLatestScanJob()!
  assert.equal(job.mode, 'watch')
  assert.deepEqual(job.roots, [f.root + '/downloads'])
  for (let i = 0; i < 20 && pending.length; i++) await tick()
  assert.deepEqual(pending, [])
  await second.service.cancel(job.id)
  assert.deepEqual(f.errors, [])
})

test('a change arriving during watch startup is retained for the next scan', async (t) => {
  const f = fixture(t),
    authorization = deferred<string>()
  let pending: string[] = [],
    authorizations = 0
  const active = f.create(
    async (path) => {
      authorizations++
      return authorizations === 1 ? authorization.promise : path
    },
    {
      load: async () => pending,
      save: async (roots) => {
        pending = roots
      }
    }
  )
  await active.service.initialize()
  active.service.activate()
  await active.service.enqueueDirectories([f.root])
  await tick()
  await active.service.enqueueDirectories([f.root])
  authorization.resolve(f.root)
  for (let i = 0; i < 20 && !active.scanner.current; i++) await tick()
  await tick()
  assert.deepEqual(pending, [f.root])
  const first = active.service.snapshot()!.jobId
  finish(f, active.scanner, first)
  for (let i = 0; i < 20 && active.service.snapshot()?.jobId === first; i++) await tick()
  assert.equal(authorizations, 2)
  const second = active.service.snapshot()!.jobId
  assert.notEqual(second, first)
  await active.service.cancel(second)
  assert.deepEqual(f.errors, [])
})

test('shutdown joins the interrupted task; a new Core resumes it but never resumes an explicit pause', async (t) => {
  const f = fixture(t),
    first = f.create()
  await first.service.initialize()
  first.service.activate()
  const initial = await first.service.start({ mode: 'startup' })
  await first.service.shutdown()
  assert.equal(f.sql.getScanProgress(initial.jobId).state, 'interrupted')
  const second = f.create()
  await second.service.initialize()
  assert.equal(second.scanner.calls.length, 0)
  second.service.activate()
  for (let i = 0; i < 10 && !second.scanner.current; i++) await tick()
  assert.equal(second.service.snapshot()?.jobId, initial.jobId)
  assert.equal(second.service.snapshot()?.state, 'running')
  assert.equal(await second.service.pause(initial.jobId), true)
  await second.service.shutdown()
  assert.equal(f.sql.getScanProgress(initial.jobId).state, 'paused')
  const third = f.create()
  await third.service.initialize()
  third.service.activate()
  await tick()
  assert.equal(third.service.snapshot()?.state, 'paused')
  assert.deepEqual(third.scanner.calls, [])
  const resumed = await third.service.resume(initial.jobId)
  assert.equal(resumed?.state, 'running')
  assert.equal(await third.service.cancel(initial.jobId), true)
  assert.deepEqual(f.errors, [])
})

test('revoked roots and cancelled preparation create no durable job and dispatch no scan', async (t) => {
  const f = fixture(t),
    denied = f.create(async () => {
      throw new Error('Directory permission revoked')
    })
  await denied.service.initialize()
  await assert.rejects(
    denied.service.start({ mode: 'watch', roots: ['D:/Unauthorized'] }),
    /revoked/
  )
  assert.deepEqual(f.sql.listScanJobs(), [])
  assert.deepEqual(denied.scanner.calls, [])
  const gate = deferred<string>(),
    preparing = f.create(() => gate.promise)
  await preparing.service.initialize()
  const client = new AbortController()
  const start = preparing.service.start({ mode: 'startup' }, client.signal)
  const rejected = assert.rejects(start, /cancelled/)
  client.abort(new Error('Client cancelled'))
  gate.resolve(f.root)
  await rejected
  assert.deepEqual(f.sql.listScanJobs(), [])
  assert.deepEqual(preparing.scanner.calls, [])
})

test('shutdown during durable job creation interrupts startup instead of recording a user cancellation', async (t) => {
  const f = fixture(t),
    { service } = f.create()
  await service.initialize()
  const original = f.database.startScan.bind(f.database),
    committed = deferred<void>(),
    release = deferred<void>()
  f.database.startScan = async (request) => {
    const job = await original(request)
    committed.resolve()
    await release.promise
    return job
  }
  const start = service.start({ mode: 'full' })
  await committed.promise
  const shutdown = service.shutdown()
  release.resolve()
  assert.equal((await start).state, 'interrupted')
  await shutdown
  assert.equal(f.sql.listScanJobs()[0].state, 'interrupted')
})

test('failed automatic recovery reports its permission error and retains the recoverable job', async (t) => {
  const f = fixture(t),
    first = f.create()
  await first.service.initialize()
  const status = await first.service.start({ mode: 'startup' })
  await first.service.shutdown()
  const second = f.create(async () => {
    throw new Error('Library disk permission revoked')
  })
  await second.service.initialize()
  second.service.activate()
  await tick()
  assert.match(second.service.snapshot()!.error, /permission revoked/)
  assert.equal(f.sql.getScanProgress(status.jobId).state, 'interrupted')
  assert.equal(f.errors.length, 1)
})

test('a newer completed scan remains the startup status and cannot revive an older interrupted job', async (t) => {
  const f = fixture(t),
    first = f.create()
  await first.service.initialize()
  const old = await first.service.start({ mode: 'startup' })
  await first.service.shutdown()
  const second = f.create()
  await second.service.initialize()
  // Explicitly replace the interrupted task with a new full scan, then finish it.
  const current = await second.service.start({ mode: 'full' })
  const directories = f.sql.claimScanDirectories(current.jobId)
  for (const path of directories.directories)
    f.sql.recordScanDirectory(current.jobId, { path, children: [], complete: true })
  const result = f.sql.finishScan(current.jobId)
  assert.equal(result.completed, true)
  second.scanner.current!.resolve({
    cancelled: false,
    progress: f.sql.getScanProgress(current.jobId),
    removedFileCount: 0
  })
  await tick()
  await second.service.shutdown()
  const third = f.create()
  await third.service.initialize()
  third.service.activate()
  await tick()
  assert.equal(third.service.snapshot()?.jobId, current.jobId)
  assert.equal(third.service.snapshot()?.state, 'completed')
  assert.deepEqual(third.scanner.calls, [])
  assert.equal(f.sql.getScanProgress(old.jobId).state, 'interrupted')
})
