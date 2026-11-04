'use strict'
// No hardware: production C++ receiver/SWR + production TS clock/feedback loop,
// driven by independent synthetic device/host clocks and real sample positions.
const assert = require('node:assert/strict')
const test = require('node:test')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { join, resolve } = require('node:path')
const { resolveMingwEnvironment } = require('./audio-engine-toolchain.cjs')

test('30-minute closed-loop PCM follows Core time through real SWR and committed source history', { timeout: 300000 }, async t => {
  const [{ BridgeTimelineController }, { BridgeClockMonitor }] = await Promise.all([
    import('../src/shared/audioBridgeSync.ts'), import('../src/shared/audioBridgeClock.ts')
  ])
  const env = resolveMingwEnvironment()
  const build = process.env.TAE_MINGW_BUILD_DIR || env.TAE_MINGW_BUILD_DIR || join(__dirname, '../audio-engine/build/mingw-static')
  const executable = join(resolve(build), 'twilight_bridge_sync_fixture.exe')
  for (const devicePpm of [-200, 200]) {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const read = async () => {
      const line = await lines.next()
      assert.equal(line.done, false, 'native fixture ended: '+stderr)
      return JSON.parse(line.value)
    }
    t.after(() => { if (child.exitCode === null) child.kill() }) // Only this test-owned fixture.
    const initial = await read(), base = 1e8, hostPpm = devicePpm < 0 ? 80 : -80
    const startFrame = initial.clock.positionFrames
    const controller = new BridgeTimelineController({ sampleRate: 48000, startAtCoreMs: base+1000,
      streamGeneration: initial.clock.streamGeneration, clockEpoch: initial.clock.epoch, mediaFrame: 900 })
    const monitor = new BridgeClockMonitor()
    function exchange(time, frames, i) {
      const host = t => t*(1+hostPpm*1e-6)
      const up = .2+(i%7)*.01+(i%17 === 0 ? 8 : 0), down = .2+(i%5)*.015+(i%11 === 0 ? 12 : 0)
      return { sentAtMs: time-.1-up, receivedAtMs: time+.1+down, remoteReceiveMs: host(time-.1)+5000,
        remoteSendMs: host(time+.1)+5000, nativeReadBeforeMs: host(time-.01)+5000,
        nativeReadAfterMs: host(time+.01)+5000, clock: { ...initial.clock, positionFrames: frames,
          sampledAtMs: host(time)+40000, readAtMs: host(time)+40000, callbackRequestedFrames: Math.ceil(frames+480) } }
    }
    for (let i = 0; i < 4; i++) monitor.observe(exchange(base+i*250,
      startFrame-(1000-i*250)*48*(1+devicePpm*1e-6), i))
    let ppm = 0, fraction = 0, allMax = 0, commands = 0
    const errors = []
    for (let i = 1; i <= 7200; i++) {
      const currentDrift = i < 3600 ? devicePpm : -devicePpm
      fraction += 12000*(1+currentDrift*1e-6)
      const frames = Math.floor(fraction); fraction -= frames
      child.stdin.write(`${ppm} ${frames}\n`)
      const facts = await read()
      const source = facts.timedStart.presentedMediaFrames
      const error = Math.abs(source/48-i*250)
      allMax = Math.max(allMax, error)
      if (i > 240 && (i < 3600 || i > 4080)) errors.push(error)
      const sample = exchange(base+1000+i*250, facts.clock.positionFrames, i)
      facts.clock = sample.clock // Controlled native/Node/Core timestamp domains, same native media/device pair.
      monitor.observe(sample)
      const mapped = monitor.presentation(facts, sample.receivedAtMs)
      assert.ok(mapped, JSON.stringify(monitor.view(sample.receivedAtMs)))
      const decision = controller.update(mapped, sample.receivedAtMs)
      assert.notEqual(decision.kind, 'failed', JSON.stringify(controller.view()))
      if (decision.kind === 'rate') { ppm = decision.ppm; commands++ }
    }
    errors.sort((a,b) => a-b)
    const maximum = errors.at(-1), p99 = errors[Math.floor(errors.length*.99)]
    assert.ok(maximum < 1, `${devicePpm}: steady phase ${maximum} ms`)
    assert.ok(allMax < 5, 'rate-step transient '+allMax+' ms')
    assert.ok(commands > 100)
    child.stdin.end()
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr)
    t.diagnostic(`${devicePpm} ppm DAC / ${hostPpm} ppm host, 30 min actual SWR: steady max ${maximum.toFixed(4)} ms, p99 ${p99.toFixed(4)} ms; all-time max ${allMax.toFixed(4)} ms; ${commands} correction commands. Native tone-phase assertions and zero underruns passed.`)
  }
})
