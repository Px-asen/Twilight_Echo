const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFile } = require('node:child_process')
const { createServer } = require('node:http')
const { promisify } = require('node:util')

const addon = path.resolve(
  process.env.TAE_AUDIO_NODE || 'resources/audio-engine/twilight_audio_node.node'
)

for (const mode of [
  'ascii',
  'unicode-environment',
  'unicode-profile',
  'unicode-live',
  'unavailable'
]) {
  test(
    `native audio survives diagnostic journal startup: ${mode}`,
    { timeout: 15_000 },
    async (t) => {
      const root = path.resolve('tmp')
      await fs.mkdir(root, { recursive: true })
      const directory = await fs.mkdtemp(path.join(root, 'audio-journal-'))
      t.after(() => fs.rm(directory, { recursive: true, force: true }))
      // Match the Windows profile layout in the November 10 crash bundle,
      // including Chinese text and full-width parentheses in the username.
      const journal =
        mode === 'unicode-profile'
          ? path.join(
              directory,
              '用户（无密码）',
              'AppData',
              'Roaming',
              'TwilightEcho',
              'logs',
              'diagnostics'
            )
          : path.join(directory, mode === 'ascii' ? 'logs' : '中文用户 音频 🎵', 'logs')
      const debug = path.join(journal, 'debug-sessions', '调试会话 🎵')
      const environmentDebug = mode === 'unicode-environment' || mode === 'unicode-profile'
      if (mode === 'unavailable') {
        await fs.mkdir(path.dirname(journal), { recursive: true })
        await fs.writeFile(journal, 'A file prevents creation of the log directory')
      } else {
        await fs.mkdir(journal, { recursive: true })
        // Capacity scans must not narrow unrelated filenames to the Windows ANSI code page.
        await fs.writeFile(path.join(journal, '说明 🎵.txt'), 'unrelated file')
      }
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          '-e',
          `
      const audio = require(process.argv[1]);
      if (process.argv[2] === 'unicode-live') audio.SetDebugCapture('journal-live', process.argv[3]);
      audio.SetVolume(0.4);
      setTimeout(() => {
        const info = JSON.parse(audio.GetPlaybackInfo());
        audio.Stop();
        console.log(JSON.stringify({ state: info.state, volume: info.volume }));
      }, 1200);
    `,
          addon,
          mode,
          debug
        ],
        {
          windowsHide: true,
          timeout: 10_000,
          env: {
            ...process.env,
            TAE_DIAGNOSTICS_DIR: journal,
            TWILIGHT_LOG_SESSION_ID: 'journal-startup',
            TAE_SERVICE_GENERATION: '7',
            TWILIGHT_DEBUG_SESSION_ID: environmentDebug ? 'journal-environment' : '',
            TWILIGHT_DEBUG_DIRECTORY: environmentDebug ? debug : ''
          }
        }
      )
      assert.deepEqual(JSON.parse(stdout), { state: 'stopped', volume: 0.4 })
      if (mode === 'unavailable') {
        assert.match(stderr, /native journal unavailable; stage=write/)
        assert.equal(
          await fs.readFile(journal, 'utf8'),
          'A file prevents creation of the log directory'
        )
        return
      }
      assert.equal(stderr, '')
      const readEvents = async (folder) =>
        (
          await Promise.all(
            (await fs.readdir(folder))
              .filter((name) => name.endsWith('.jsonl'))
              .map(async (name) =>
                (await fs.readFile(path.join(folder, name), 'utf8'))
                  .trim()
                  .split('\n')
                  .map(JSON.parse)
              )
          )
        ).flat()
      const events = await readEvents(journal)
      assert.ok(events.some((event) => event.event === 'engine.started'))
      assert.ok(events.filter((event) => event.event === 'health.sample').length >= 2)
      assert.ok(events.every((event) => event.serviceGeneration === 7))
      if (mode.startsWith('unicode')) {
        const debugEvents = await readEvents(path.join(debug, 'logs'))
        assert.ok(debugEvents.some((event) => event.event === 'engine.started'))
        assert.ok(debugEvents.filter((event) => event.event === 'health.sample').length >= 2)
        assert.ok(
          debugEvents.every(
            (event) =>
              event.debugSessionId ===
              (mode === 'unicode-live' ? 'journal-live' : 'journal-environment')
          )
        )
      }
    }
  )
}

test('native journal keeps sampling when synchronous control/RPC is blocked; service termination leaves evidence', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twilight-native-fault-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const { configureDiagnosticLogger } = await import('../src/main/diagnostics/logger.ts')
  const { observeUtilityProcess } = await import('../src/main/diagnostics/utilityObservation.ts')
  const events = []
  configureDiagnosticLogger({}, (event) => events.push(event))
  const server = createServer(() => {}) // Deliberately never send response headers.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const audio = require(process.argv[1]);
    process.on('message', message => {
      if (message.kind !== 'request') return;
      audio.SetDiagnosticContext(JSON.stringify(message.diagnosticContext));
      try { audio.Play(message.args[0], 0); process.send({kind:'response', requestId:message.requestId, ok:true}); }
      catch (error) { process.send({kind:'response', requestId:message.requestId, ok:false, error:String(error)}); }
    });
    process.send({kind:'ready'});
  `,
      addon
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        TAE_DIAGNOSTICS_DIR: directory,
        TWILIGHT_LOG_SESSION_ID: 'native-fault',
        TAE_SERVICE_GENERATION: '19',
        PATH: `${path.dirname(addon)};${process.env.PATH}`
      }
    }
  )
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill()
  })
  observeUtilityProcess(child, 'native-fault')
  await new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message.kind === 'ready') resolve()
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`early exit ${code}`)))
  })
  child.send({
    kind: 'request',
    requestId: 'blocked-request',
    method: 'Play',
    args: [`http://127.0.0.1:${server.address().port}/blocked?token=secret`]
  })
  await new Promise((resolve) => setTimeout(resolve, 4200))
  const native = []
  for (const name of await fs.readdir(directory))
    for (const line of (await fs.readFile(path.join(directory, name), 'utf8')).trim().split('\n'))
      native.push(JSON.parse(line))
  const health = native.filter((event) => event.event === 'health.sample')
  assert.ok(health.length >= 4, `only ${health.length} health samples`)
  assert.ok(health.every((event) => event.serviceGeneration === 19))
  assert.ok(health.at(-1).details.clockAgeMs > 2000)
  assert.equal(typeof health.at(-1).details.streamToken, 'number')
  assert.ok(!JSON.stringify(native).includes('token=secret'))
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
  assert.ok(
    events.some(
      (event) =>
        event.event === 'utility.exit' &&
        event.details.unfinished.some((item) => item.requestId === 'blocked-request')
    )
  )
})
