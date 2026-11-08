import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DebugSessionController, diagnosticFiles } from './debugSession.ts'
import { debugCaptureContext, setDebugCaptureContext } from './debugContext.ts'
import { configureDiagnosticLogger, writeDiagnostic } from './logger.ts'
import { sanitizeDiagnosticValue, summarizeDiagnosticArguments } from './sanitize.ts'
import { observeUtilityProcess } from './utilityObservation.ts'
import {
  cachedCoreEvidence,
  processEvidence,
  registerDiagnosticProcess
} from './processEvidence.ts'
import { exportDiagnosticBundle } from './bundle.ts'

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-debug-test-'))
  t.after(async () => {
    setDebugCaptureContext(null)
    await rm(root, { recursive: true, force: true })
  })
  return root
}
test('debug preserves Chinese paths and stack coordinates but filters credentials and URL queries', () => {
  const value = {
    path: 'C:\\用户\\音乐 目录\\test.flac',
    stack: 'at load (D:\\应用\\main.js:34:12)',
    baseAddress: '0x10000000',
    exceptionAddress: '0x10005d70',
    token: 'private-token',
    note: 'Bearer abc.def',
    url: 'https://example.com/music?token=private'
  }
  setDebugCaptureContext({ id: 'test', directory: 'C:\\logs', captureCrashes: false })
  const full = sanitizeDiagnosticValue(value) as any
  assert.equal(full.path, value.path)
  assert.equal(full.stack, value.stack)
  assert.equal(full.baseAddress, value.baseAddress)
  assert.equal(full.exceptionAddress, value.exceptionAddress)
  assert.doesNotMatch(JSON.stringify(full), /private|abc\.def/)
  assert.notEqual(
    (sanitizeDiagnosticValue(value, { preserveLocalPaths: false }) as any).path,
    value.path
  )
  setDebugCaptureContext(null)
  assert.doesNotMatch(JSON.stringify(sanitizeDiagnosticValue(value)), /音乐|main\.js/)
})
test('crash capture starts before children after restart and ends before pending export on next boot', async (t) => {
  const root = await fixture(t)
  const first = new DebugSessionController(root)
  const initial = first.start(true)
  assert.equal(initial.state, 'restart-required')
  assert.equal(debugCaptureContext(), null)
  const running = new DebugSessionController(root)
  assert.equal(running.boot()?.state, 'active')
  assert.equal(debugCaptureContext()?.id, initial.id)
  running.queueExport(join(root, 'result.zip'), true)
  assert.equal((await running.stop())?.state, 'stopping')
  assert.equal(
    (await running.stop())?.state,
    'stopping',
    'a duplicate stop must still require restart'
  )
  assert.equal(debugCaptureContext(), null)
  const finished = new DebugSessionController(root)
  const saved = finished.boot()!
  assert.equal(saved.id, initial.id)
  assert.equal(saved.state, 'ended')
  assert.equal(saved.pendingExport?.includeCrashes, true)
  finished.exportResult('disk full')
  assert.equal(new DebugSessionController(root).current?.pendingExport?.error, 'disk full')
  finished.exportResult()
  assert.equal(finished.current?.pendingExport, undefined)
  await finished.close()
})

test('debug RPC diagnostics keep only fields defined for that method', () => {
  setDebugCaptureContext({ id: 'fields', directory: 'D:/logs', captureCrashes: false })
  try {
    assert.deepEqual(
      summarizeDiagnosticArguments(
        [
          JSON.stringify({
            preferredBufferSize: 512,
            routingMode: 'native',
            extra: 'private-payload',
            token: 'private-token'
          })
        ],
        'SetOutputConfig'
      ),
      [{ preferredBufferSize: 512, routingMode: 'native' }]
    )
    assert.deepEqual(
      summarizeDiagnosticArguments(
        [42, JSON.stringify({ revision: 42, graph: { secretState: 'private-payload' } })],
        'ApplyDspState'
      ),
      [42, { revision: 42 }]
    )
    assert.equal(
      summarizeDiagnosticArguments(['D:/音乐 目录/track.flac'], 'Play')[0],
      'D:/音乐 目录/track.flac'
    )
    assert.doesNotMatch(
      JSON.stringify(
        summarizeDiagnosticArguments([{ unexpected: 'private-payload' }], 'SetOutputBackend')
      ),
      /private-payload/
    )
  } finally {
    setDebugCaptureContext(null)
  }
})
test('a stopped debug export keeps full paths and all module entries, with explicit dump privacy', async (t) => {
  const root = await fixture(t),
    sessions = new DebugSessionController(root)
  const session = sessions.start(false)
  configureDiagnosticLogger({}, (event) => sessions.record(event))
  writeDiagnostic('audio.native', 'binding.load.start', {
    path: 'D:\\应用\\engine.dll',
    password: 'never-export'
  })
  const fatal = writeDiagnostic(
    'app',
    'process.uncaught-exception',
    { stack: 'at load (D:\\应用\\main.js:34:12)' },
    'fatal'
  )
  if (fatal) sessions.emergency(fatal)
  sessions.attachment(
    'windows/modules.json',
    Array.from({ length: 130 }, (_, i) => ({
      path: `D:\\Modules\\${i}.dll`,
      baseAddress: `0x${i}`
    }))
  )
  await sessions.stop()
  const dump = join(session.directory, 'crashes')
  await mkdir(dump)
  await writeFile(join(dump, 'example.dmp'), 'MDMP-fixture')
  await writeFile(
    join(dump, 'crash-42-1.json'),
    JSON.stringify({
      processId: 42,
      exceptionCode: '0xc00000ff',
      exceptionAddress: '0x10005d70',
      dumpStatus: 'saved',
      modules: [{ name: 'engine.dll', baseAddress: '0x10000000', size: 65536 }]
    })
  )
  const result = await exportDiagnosticBundle({
    destination: join(root, 'result.zip'),
    collectors: [],
    debugSession: session,
    snapshot: (destination) => sessions.snapshot(session.id, destination),
    attachments: await sessions.attachmentsFor(session.id, true)
  })
  assert.equal(result.manifest.privacy.fullPathsCaptured, true)
  assert.equal(result.manifest.privacy.credentialsCaptured, 'possible-in-crash-dumps')
  const yauzl = createRequire(import.meta.url)('yauzl')
  const entries = await new Promise<Map<string, string>>((resolve, reject) => {
    yauzl.open(result.filePath, { lazyEntries: true }, (error: Error, zip: any) => {
      if (error) return reject(error)
      const contents = new Map<string, string>()
      zip.on('error', reject)
      zip.on('end', () => resolve(contents))
      zip.on('entry', (entry: any) =>
        zip.openReadStream(entry, (error: Error, stream: any) => {
          if (error) return reject(error)
          const chunks: Buffer[] = []
          stream.on('data', (data: Buffer) => chunks.push(data))
          stream.on('end', () => {
            contents.set(entry.fileName, Buffer.concat(chunks).toString())
            zip.readEntry()
          })
        })
      )
      zip.readEntry()
    })
  })
  assert.match(entries.get('timeline.jsonl')!, /应用/)
  assert.match(entries.get('timeline.jsonl')!, /main\.js:34:12/)
  assert.doesNotMatch(entries.get('timeline.jsonl')!, /never-export/)
  assert.equal(JSON.parse(entries.get('debug/windows/modules.json')!).length, 130)
  assert.equal(JSON.parse(entries.get('debug/windows/modules.json')!)[1].baseAddress, '0x1')
  assert.match(entries.get('README.md')!, /engine\.dll \+ 0x5d70/)
  assert.match(entries.get('README.md')!, /0xc00000ff/)
  assert.equal(
    (await sessions.attachmentsFor(session.id, false)).some((item) => item.name.endsWith('.dmp')),
    false
  )
  await sessions.close()
})

test('collector failures, dump count and mode acknowledgements have explicit status', async (t) => {
  const root = await fixture(t),
    sessions = new DebugSessionController(root)
  const session = sessions.start(true)
  sessions.boot()
  const directory = join(session.directory, 'crashes')
  await mkdir(directory)
  await writeFile(
    join(directory, 'attach-42.json'),
    JSON.stringify({ status: 'failed', processId: 42, stage: 'attach', errorCode: 5 })
  )
  await writeFile(
    join(directory, 'crash-42-1.json'),
    JSON.stringify({ dumpStatus: 'failed', processId: 42, stage: 'minidump', errorCode: 112 })
  )
  await writeFile(join(directory, 'crash-42-2.dmp'), 'MDMP-fixture')
  await sessions.maintain()
  assert.equal(sessions.current?.crashes?.dumps, 1)
  assert.equal(sessions.current?.crashes?.collectors[0].errorCode, 5)
  assert.match(sessions.current!.warnings.join('\n'), /minidump.*112/)
  for (const suffix of ['3', '4', '5'])
    await writeFile(join(directory, `crash-42-${suffix}.dmp`), 'MDMP-fixture')
  await sessions.maintain()
  assert.equal(sessions.current?.crashes?.dumps, 3)
  assert.match(sessions.current!.warnings.join('\n'), /最多保留 3/)
  await sessions.stop()
  await sessions.close()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = Object.assign(new EventEmitter(), { pid: 31415, postMessage: () => {} })
  const evidence = registerDiagnosticProcess(child, 'ack-test')
  setDebugCaptureContext({ id: 'ack-session', directory: root, captureCrashes: false })
  assert.equal(evidence.captureState, 'pending')
  t.mock.timers.tick(5001)
  assert.equal(evidence.captureState, 'timeout')
  assert.match(evidence.error!, /5 seconds/)
  child.emit('message', { kind: 'diagnostics:ack', debugSessionId: 'ack-session' })
  assert.equal(evidence.captureState, 'active')
  assert.equal(evidence.error, undefined)
  child.emit('exit', 0)
})
test('observer registers once, retains PID and last Core snapshot after exit, and applies debug mode', () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined,
    postMessage: (_message: unknown) => {},
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  const events: any[] = [],
    sent: any[] = []
  configureDiagnosticLogger({}, (event) => events.push(event))
  child.postMessage = (message) => {
    sent.push(message)
  }
  observeUtilityProcess(child, 'twilight-core')
  observeUtilityProcess(child, 'twilight-core')
  child.pid = 765432
  child.emit('spawn')
  child.emit('message', {
    kind: 'diagnostics:snapshot',
    value: { audio: { nativeError: 'failure', lastKnown: 'engine.dll' } }
  })
  setDebugCaptureContext({ id: 'session', directory: 'C:\\logs', captureCrashes: false })
  assert.equal(sent.at(-1).context.id, 'session')
  child.pid = undefined
  child.emit('exit', 3221225727)
  assert.equal(events.filter((event) => event.event === 'utility.exit').length, 1)
  assert.equal(events.find((event) => event.event === 'utility.exit').details.processId, 765432)
  assert.equal(cachedCoreEvidence().value.audio.lastKnown, 'engine.dll')
  assert.equal(cachedCoreEvidence().alive, false)
  assert.equal(processEvidence().find((item) => item.processId === 765432)?.alive, false)
  setDebugCaptureContext(null)
})
test('debug retention protects the active session and a failed pending export', async (t) => {
  const root = await fixture(t),
    sessions = new DebugSessionController(root)
  const session = sessions.start(false)
  await assert.rejects(sessions.snapshot('invalid/../id', root))
  await sessions.stop()
  await writeFile(join(session.directory, 'in-progress.json.tmp'), '{}')
  assert.equal(
    (await diagnosticFiles(session.directory)).some((file) => file.name.endsWith('.tmp')),
    false
  )
  sessions.queueExport(join(root, 'result.zip'), false)
  await sessions.maintain()
  assert.equal(
    JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8')).pendingExport
      .destination,
    join(root, 'result.zip')
  )
  await sessions.close()
})
test('a running Node service acknowledges live capture changes and publishes cached evidence', async (t) => {
  const root = await fixture(t),
    entry = join(root, 'worker.mjs')
  const utility = new URL('./utility.ts', import.meta.url).href
  await writeFile(
    entry,
    `import {initializeUtilityDiagnostics,setUtilityDiagnosticSnapshotProvider} from ${JSON.stringify(utility)};
    initializeUtilityDiagnostics('twilight-core');setUtilityDiagnosticSnapshotProvider(()=>({audio:{state:'stopped',nativeIdentity:'test.dll'}}));
    process.on('message',message=>{if(message.kind==='finish')process.exit(7)});`
  )
  const child = fork(entry, [], {
    env: { ...process.env, TWILIGHT_LOG_SESSION_ID: 'test-control' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  t.after(() => {
    if (child.exitCode === null) child.kill()
  })
  const waitMessage = (predicate: (message: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off('message', listener)
        reject(Error('Missing worker acknowledgement'))
      }, 5000)
      const listener = (message: any) => {
        if (predicate(message)) {
          clearTimeout(timer)
          child.off('message', listener)
          resolve(message)
        }
      }
      child.on('message', listener)
    })
  observeUtilityProcess(child, 'twilight-core')
  await waitMessage((message) => message.kind === 'diagnostics:snapshot' && message.value.audio)
  const ack = waitMessage(
    (message) => message.kind === 'diagnostics:ack' && message.debugSessionId === 'live-session'
  )
  setDebugCaptureContext({ id: 'live-session', directory: root, captureCrashes: false })
  await ack
  const disabled = waitMessage(
    (message) => message.kind === 'diagnostics:ack' && !message.debugSessionId
  )
  setDebugCaptureContext(null)
  await disabled
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.send({ kind: 'finish' })
  await exited
  assert.equal(child.exitCode, 7)
  assert.equal(cachedCoreEvidence().value.audio.nativeIdentity, 'test.dll')
  assert.equal(cachedCoreEvidence().alive, false)
})

test('post-restart export uses saved session evidence instead of a new empty or redacted Core', async (t) => {
  const root = await fixture(t),
    session = new DebugSessionController(root)
  const started = session.start(false)
  session.attachment('processes/core-instance.json', {
    role: 'twilight-core',
    alive: false,
    processId: 42,
    snapshot: {
      collectedAt: new Date().toISOString(),
      value: {
        audio: {
          serviceEvidence: {
            lastKnownCapabilities: { value: { nativeRuntime: { addonPath: 'D:/应用/audio.node' } } }
          }
        }
      }
    }
  })
  await session.stop()
  const restarted = new DebugSessionController(root)
  restarted.boot()
  const saved = await restarted.coreSnapshot(started.id)
  assert.equal(saved.evidenceOrigin, 'debug-session')
  assert.equal(saved.aliveAtCapture, false)
  assert.equal(
    saved.value.audio.serviceEvidence.lastKnownCapabilities.value.nativeRuntime.addonPath,
    'D:/应用/audio.node'
  )
  assert.equal(typeof saved.dataAgeMs, 'number')
  await restarted.close()
})
