// Usage: node scripts/run-debug-session-package-smoke.cjs <packaged executable> [output parent]
const assert = require('node:assert/strict'),
  { spawn } = require('node:child_process'),
  { once } = require('node:events'),
  fs = require('node:fs'),
  path = require('node:path')
async function runPackage(executable, directory, expression) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'TWILIGHT_DEV_USER_DATA_DIR'])
    delete env[key]
  for (const key of Object.keys(env).filter(
    (key) => key.startsWith('TWILIGHT_METADATA_') || key === 'TWILIGHT_DEV_METADATA_SETUP_FILE'
  ))
    delete env[key]
  const child = spawn(executable, ['--no-sandbox', '--inspect-brk=127.0.0.1:0'], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = '',
    closed = false,
    socket
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      closed = true
      resolveExit({ code, signal })
    })
  })
  child.stdout.on('data', (data) => process.stdout.write(data))
  child.stderr.on('data', (data) => {
    stderr += data
    process.stderr.write(data)
  })
  const timer = setTimeout(() => child.kill(), 80_000)
  try {
    const endpoint = await waitFor(() => {
      assert.equal(
        closed,
        false,
        'Package exited before inspector attachment (' +
          child.exitCode +
          '/' +
          child.signalCode +
          '):\n' +
          stderr
      )
      return stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]
    }, 'packaged main inspector')
    socket = new WebSocket(endpoint)
    await once(socket, 'open')
    const pending = new Map(),
      events = new Map()
    let serial = 0
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const item = pending.get(message.id)
        if (!item) return
        pending.delete(message.id)
        message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result)
      } else events.get(message.method)?.(message.params)
    })
    const send = (method, params = {}) =>
      new Promise((resolveCall, reject) => {
        const id = ++serial
        pending.set(id, { resolve: resolveCall, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    await send('Runtime.enable')
    await send('Debugger.enable')
    const paused = new Promise((resolvePause) => events.set('Debugger.paused', resolvePause))
    await send('Runtime.runIfWaitingForDebugger')
    const event = await paused
    const evaluation = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: event.callFrames[0].callFrameId,
      expression,
      returnByValue: true
    })
    assert.equal(evaluation.exceptionDetails, undefined, JSON.stringify(evaluation))
    assert.equal(evaluation.result.value, 'debug acceptance armed')
    await send('Debugger.resume')
    socket.close()
    const result = await exit
    assert.equal(result.code, 0, 'Packaged runtime failed:\n' + stderr)
    assert.equal(result.signal, null)
  } finally {
    clearTimeout(timer)
    socket?.close()
    if (!closed) {
      child.kill()
      await exit
    }
  }
}

async function waitFor(read, label) {
  for (let i = 0; i < 600; i++) {
    const value = await read()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw Error('Timed out: ' + label)
}

async function inspectBundle(file, captureCrashes) {
  const contents = await new Promise((resolve, reject) => {
    require('yauzl').open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error)
      const entries = new Map()
      zip.on('error', reject)
      zip.on('end', () => resolve(entries))
      zip.on('entry', (entry) => {
        if (
          !['manifest.json', 'snapshots.json', 'README.md'].includes(entry.fileName) &&
          !entry.fileName.endsWith('.dmp')
        ) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error)
          const chunks = []
          stream.on('error', reject)
          stream.on('data', (chunk) => {
            if (!entry.fileName.endsWith('.dmp') || !chunks.length) chunks.push(chunk)
          })
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
  const manifest = JSON.parse(contents.get('manifest.json'))
  assert.deepEqual(
    manifest.missing.filter((item) => !item.startsWith('每个会话最多保留 3 份完成的转储')),
    [],
    'The test package must retain complete Core evidence'
  )
  assert.equal(manifest.privacy.fullPathsCaptured, true)
  assert.equal(manifest.privacy.crashDumpsIncluded, captureCrashes)
  const snapshots = JSON.parse(contents.get('snapshots.json'))
  const core = snapshots.find((item) => item.name === 'core.cached').value
  assert.equal(core.evidenceOrigin, 'debug-session')
  assert.ok(core.value.audio.serviceEvidence.lastKnownCapabilities.value.nativeRuntime)
  const dumps = [...contents].filter(([name]) => name.endsWith('.dmp'))
  assert.equal(dumps.length > 0, captureCrashes)
  assert.ok(dumps.length <= 3, 'The completed package must obey the dump retention limit')
  assert.equal(manifest.status.debug.crashes.dumps, dumps.length)
  for (const [, bytes] of dumps) assert.equal(bytes.toString('ascii', 0, 4), 'MDMP')
  if (!captureCrashes)
    assert.match(contents.get('README.md').toString(), /packaged debug reproduction/)
  return { events: manifest.coverage.events, dumps: dumps.length, missing: manifest.missing }
}

async function main() {
  if (!process.argv[2]) throw Error('Pass the packaged executable as the first argument')
  const executable = path.resolve(process.argv[2])
  assert.ok(fs.existsSync(executable), 'Packaged executable is missing')
  const parent = path.resolve(process.argv[3] || 'tmp/diagnostics-package-acceptance')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, '中文路径 debug-'))
  const profile = path.join(root, 'profile')
  fs.mkdirSync(profile)
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({
      firstLaunch: false,
      onboardingCompleted: true,
      autoCheckUpdate: false,
      analyticsEnabled: false,
      telemetryEnabled: false,
      audioVolume: 0,
      smtcEnabled: false,
      autoPlay: false
    })
  )
  console.log(`Acceptance evidence: ${root}`)
  const arm = require('./fixtures/debug-session-package.cjs')
  for (const phase of ['ordinary', 'capture', 'finished']) {
    await runPackage(executable, root, `(${arm.toString()})(${JSON.stringify({ root, phase })})`)
    console.log(`PASS ${phase}`)
  }
  const result = {
    ordinary: await inspectBundle(path.join(root, 'ordinary.zip'), false),
    capture: await inspectBundle(path.join(root, 'capture.zip'), true)
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log('DEBUG_SESSION_PACKAGE_OK', JSON.stringify(result))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
