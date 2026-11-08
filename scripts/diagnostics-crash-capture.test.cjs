const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)

test(
  'production x86 ASIO helper registers the x86 collector before its entrypoint',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(path.resolve('tmp'), 'twilight-asio-capture-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const executable = path.resolve(
      process.env.TAE_ASIO_X86_BUILD_DIR || 'audio-engine/build/asio-helper-msvc-x86',
      'twilight-asio-helper-x86.exe'
    )
    const result = await run(executable, ['--self-test'], {
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        TWILIGHT_DEBUG_DIRECTORY: dir,
        TWILIGHT_DEBUG_CRASHES: '1',
        TWILIGHT_DEBUG_SESSION_ID: '00000000-0000-0000-0000-000000000006',
        TWILIGHT_DEBUG_CRASH_HELPER: path.resolve(
          'resources/audio-engine/twilight-crash-helper.exe'
        )
      }
    })
    assert.equal(JSON.parse(result.stdout).architecture, 'x86')
    const receipt = JSON.parse(
      fs.readFileSync(
        files(dir).find((file) => /attach-.*\.json$/.test(file)),
        'utf8'
      )
    )
    assert.equal(receipt.status, 'attached')
    assert.equal(receipt.architecture, 'x86')
  }
)

function files(dir) {
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
        )
    : []
}
function exceptionCode(dump) {
  const buffer = fs.readFileSync(dump)
  assert.equal(buffer.toString('ascii', 0, 4), 'MDMP')
  const count = buffer.readUInt32LE(8),
    directory = buffer.readUInt32LE(12)
  for (let i = 0; i < count; i++) {
    const offset = directory + i * 12
    if (buffer.readUInt32LE(offset) === 6)
      return buffer.readUInt32LE(buffer.readUInt32LE(offset + 8) + 8)
  }
  throw Error('Missing exception stream')
}
for (const arch of ['x64', 'x86'])
  test(
    `native ${arch} unhandled exception produces an external dump and retains exit code`,
    { skip: process.platform !== 'win32', timeout: 20000 },
    async (t) => {
      const base = path.resolve('tmp')
      fs.mkdirSync(base, { recursive: true })
      const dir = fs.mkdtempSync(path.join(base, 'twilight-crash-test-'))
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
      const executable = path.resolve(
        'audio-engine/build/crash-helper-' + arch + '/twilight-crash-fixture.exe'
      )
      const env = {
        ...process.env,
        TWILIGHT_DEBUG_DIRECTORY: dir,
        TWILIGHT_DEBUG_CRASHES: '1',
        TWILIGHT_DEBUG_SESSION_ID: '00000000-0000-0000-0000-000000000002',
        TWILIGHT_DEBUG_CRASH_HELPER: path.resolve(
          'resources/audio-engine/twilight-crash-helper.exe'
        )
      }
      await assert.rejects(
        run(executable, [], { env, windowsHide: true, timeout: 10000 }),
        (error) => error.code === 3221225727
      )
      const dump = files(dir).find((file) => file.endsWith('.dmp'))
      assert.ok(dump)
      assert.equal(exceptionCode(dump), 0xc00000ff)
      const receipt = JSON.parse(
        fs.readFileSync(
          files(dir).find((file) => /attach-.*\.json$/.test(file)),
          'utf8'
        )
      )
      assert.equal(receipt.status, 'attached')
      assert.equal(receipt.architecture, arch)
      const report = JSON.parse(fs.readFileSync(dump.replace(/\.dmp$/, '.json'), 'utf8'))
      assert.equal(report.dumpStatus, 'saved')
      assert.ok(report.modules.some((module) => module.name === 'twilight-crash-fixture.exe'))
    }
  )
test('Electron utility crash is collected locally with Crashpad', { timeout: 25000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-crashpad-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const worker = path.join(dir, 'worker.cjs')
  fs.writeFileSync(worker, 'setTimeout(()=>process.crash(),100)')
  const main = path.join(dir, 'main.cjs'),
    dumps = path.join(dir, 'crashes')
  fs.mkdirSync(dumps)
  fs.writeFileSync(
    main,
    `const {app,crashReporter,utilityProcess}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir, 'profile'))});app.setPath('crashDumps',${JSON.stringify(dumps)});app.disableHardwareAcceleration();crashReporter.start({uploadToServer:false});app.whenReady().then(()=>{const child=utilityProcess.fork(${JSON.stringify(worker)},[],{stdio:'pipe'});child.once('exit',()=>setTimeout(()=>app.exit(0),500));setTimeout(()=>app.exit(2),10000)});`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await run(require('electron'), [main], { env, windowsHide: true, timeout: 15000 })
  const dump = files(dumps).find((file) => file.endsWith('.dmp'))
  assert.ok(dump, 'Crashpad must persist a local utility dump')
  assert.ok(exceptionCode(dump))
})
test(
  'standalone Node registers the external collector before loading a crashing addon',
  { skip: process.platform !== 'win32', timeout: 20000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(path.resolve('tmp'), 'twilight-node-crash-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const moduleUrl = require('node:url').pathToFileURL(
      path.resolve('src/main/diagnostics/windowsCrashCapture.ts')
    ).href
    const addon = path.resolve('audio-engine/build/crash-helper-x64/twilight_crash_addon.node')
    const entry = path.join(dir, 'worker.mjs')
    fs.writeFileSync(
      entry,
      `import {createRequire} from 'node:module';import {registerWindowsCrashCapture} from ${JSON.stringify(moduleUrl)};registerWindowsCrashCapture();createRequire(import.meta.url)(${JSON.stringify(addon)}).crash();`
    )
    const env = {
      ...process.env,
      TWILIGHT_DEBUG_DIRECTORY: dir,
      TWILIGHT_DEBUG_CRASHES: '1',
      TWILIGHT_DEBUG_SESSION_ID: '00000000-0000-0000-0000-000000000003',
      TWILIGHT_DEBUG_CRASH_HELPER: path.resolve('resources/audio-engine/twilight-crash-helper.exe')
    }
    await assert.rejects(run(process.execPath, [entry], { env, windowsHide: true, timeout: 10000 }))
    const dump = files(dir).find((file) => file.endsWith('.dmp'))
    assert.ok(dump, 'Node native crash needs a persisted dump')
    assert.equal(exceptionCode(dump), 0xc00000ff)
  }
)

test(
  'a missing collector records the startup failure and lets Node continue',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(path.resolve('tmp'), 'twilight-collector-failure-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const moduleUrl = require('node:url').pathToFileURL(
      path.resolve('src/main/diagnostics/windowsCrashCapture.ts')
    ).href
    const entry = path.join(dir, 'worker.mjs')
    fs.writeFileSync(
      entry,
      `import {registerWindowsCrashCapture} from ${JSON.stringify(moduleUrl)};registerWindowsCrashCapture();console.log('CONTINUED');`
    )
    const result = await run(process.execPath, [entry], {
      windowsHide: true,
      env: {
        ...process.env,
        TWILIGHT_DEBUG_SESSION_ID: '00000000-0000-0000-0000-000000000004',
        TWILIGHT_DEBUG_DIRECTORY: dir,
        TWILIGHT_DEBUG_CRASHES: '1',
        TWILIGHT_DEBUG_CRASH_HELPER: path.join(dir, 'missing.exe')
      }
    })
    assert.match(result.stdout, /CONTINUED/)
    const receipt = JSON.parse(
      fs.readFileSync(
        files(dir).find((file) => /attach-.*\.json$/.test(file)),
        'utf8'
      )
    )
    assert.equal(receipt.status, 'failed')
    assert.equal(receipt.stage, 'helper-unavailable')
  }
)

test(
  'dump quota preserves the exception and reports why the fourth dump was omitted',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(path.resolve('tmp'), 'twilight-crash-quota-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    for (let i = 0; i < 4; i++)
      await assert.rejects(
        run(path.resolve('audio-engine/build/crash-helper-x64/twilight-crash-fixture.exe'), [], {
          windowsHide: true,
          timeout: 10000,
          env: {
            ...process.env,
            TWILIGHT_DEBUG_SESSION_ID: '00000000-0000-0000-0000-000000000005',
            TWILIGHT_DEBUG_DIRECTORY: dir,
            TWILIGHT_DEBUG_CRASHES: '1',
            TWILIGHT_DEBUG_CRASH_HELPER: path.resolve(
              'resources/audio-engine/twilight-crash-helper.exe'
            )
          }
        }),
        (error) => error.code === 3221225727
      )
    assert.equal(files(dir).filter((file) => file.endsWith('.dmp')).length, 3)
    const failed = files(dir)
      .filter((file) => /crash-.*\.json$/.test(file))
      .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
      .find((record) => record.dumpStatus === 'failed')
    assert.equal(failed.errorCode, 112)
    assert.equal(failed.exceptionCode, '0xc00000ff')
  }
)
