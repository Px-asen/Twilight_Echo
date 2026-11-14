import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  WorkerServiceLease,
  createCoreServiceFactory,
  resolveWorkerServiceEntry
} from './workerServiceLease.ts'
import type { CoreServiceLease } from './serviceLauncher.ts'

test('resolveWorkerServiceEntry maps database/scan across extensions and ignores process-isolated services', () => {
  const existing = new Set([
    join('/app/out/main', 'libraryDatabaseService.js'),
    join('/app/out/server', 'libraryScanService.cjs'),
    join('/app/src/main/coreProcess', 'libraryDatabaseService.ts')
  ])
  const exists = (file: string) => existing.has(file)

  assert.equal(
    resolveWorkerServiceEntry('database', '/app/out/main/musicCore.js', exists),
    join('/app/out/main', 'libraryDatabaseService.js')
  )
  assert.equal(
    resolveWorkerServiceEntry('scan', '/app/out/server/musicCore.cjs', exists),
    join('/app/out/server', 'libraryScanService.cjs')
  )
  assert.equal(
    resolveWorkerServiceEntry('database', '/app/src/main/coreProcess/entry.ts', exists),
    join('/app/src/main/coreProcess', 'libraryDatabaseService.ts')
  )
  assert.equal(resolveWorkerServiceEntry('audio', '/app/out/main/musicCore.js', exists), null)
  assert.equal(resolveWorkerServiceEntry('analysis', '/app/out/main/musicCore.js', exists), null)
  assert.equal(resolveWorkerServiceEntry('plugin', '/app/out/main/musicCore.js', exists), null)
  assert.equal(
    resolveWorkerServiceEntry('scan', '/app/out/main/musicCore.js', exists),
    null
  )
})

test('WorkerServiceLease exchanges messages over worker_threads and terminates cleanly on closeAll', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'twilight-worker-lease-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const servicePortUrl = pathToFileURL(
    resolve(import.meta.dirname, '../services/servicePort.ts')
  ).href
  const dbEntry = join(dir, 'libraryDatabaseService.mjs')
  writeFileSync(
    dbEntry,
    `
      import { createServicePort } from ${JSON.stringify(servicePortUrl)};
      const port = createServicePort();
      port.postMessage({ kind: 'ready' });
      port.on('message', (message) => {
        if (message.kind === 'ping') port.postMessage({ kind: 'pong', id: message.id });
      });
    `
  )

  const fallbackCalls: string[] = []
  const factory = createCoreServiceFactory({
    launcher: {
      launch: (service) => {
        fallbackCalls.push(service)
        return new EventEmitter() as CoreServiceLease
      }
    },
    workerServices: ['database', 'scan'],
    resolveEntry: (service) => (service === 'database' ? dbEntry : null)
  })

  // Process-isolated services stay on CoreServiceLauncher even if present in filesystem.
  factory.launch('audio')
  factory.launch('analysis')
  // Unresolved scan entry falls back transparently to launcher.
  factory.launch('scan')
  assert.deepEqual(fallbackCalls, ['audio', 'analysis', 'scan'])

  const dbLease = factory.launch('database') as WorkerServiceLease
  const pong = await new Promise<{ kind: string; id: number }>((resolvePong, rejectPong) => {
    dbLease.once('error', rejectPong)
    dbLease.on('message', (message: { kind: string; id?: number }) => {
      if (message.kind === 'ready') dbLease.postMessage({ kind: 'ping', id: 42 })
      else if (message.kind === 'pong') resolvePong(message as { kind: string; id: number })
    })
  })
  assert.deepEqual(pong, { kind: 'pong', id: 42 })

  await factory.closeAll()
  assert.throws(() => dbLease.postMessage({ kind: 'ping', id: 99 }), /closed/)
})
