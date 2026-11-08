import assert from 'node:assert/strict'
import test from 'node:test'
import { ScheduledPauseTimer } from './scheduledPause.ts'
import type { CoreSleepTimerConfigure } from '../../shared/coreSleepTimer.ts'

function fixture() {
  let wall = 1_000_000, elapsed = 1000, pauses = 0, armed = false, boot = 'boot-1'
  const info = { state: 'playing', volume: 0.42, duration: 180 }
  const errors: unknown[] = []
  const options = { now: () => wall, monotonic: () => elapsed, bootId: () => boot,
    setInterval: (() => 1) as never, clearInterval: (() => {}) as never,
    read: () => info, pause: async (current: () => boolean) => { if (current()) { pauses++; info.state = 'paused' } },
    armTrackEnd: async (enabled: boolean) => { armed = enabled; return true }, changed: () => {},
    failed: (error: unknown) => errors.push(error) }
  const timer = new ScheduledPauseTimer(options)
  const request = (finishCurrentTrack = false): CoreSleepTimerConfigure => ({ revision: 0, mode: 'minutes', action: 'pause',
    endsAt: wall + 60_000, schedule: { id: 'task-1', clock: 'elapsed', deadlineMs: elapsed + 60_000, bootId: boot }, finishCurrentTrack })
  timer.activate()
  return { timer, info, options, errors, request, pauses: () => pauses, armed: () => armed,
    wall: (value: number) => { wall = value }, elapsed: (value: number) => { elapsed = value }, boot: () => { boot = 'boot-2' } }
}

test('elapsed countdown ignores wall-clock edits and repeated OS wakeups pause exactly once', async () => {
  const f = fixture()
  await f.timer.configure(f.request())
  f.wall(10_000_000)
  await f.timer.check()
  assert.equal(f.pauses(), 0)
  f.elapsed(61_000)
  await Promise.all([f.timer.check(), f.timer.check(), f.timer.check()])
  await f.timer.check()
  assert.equal(f.pauses(), 1)
  assert.equal(f.info.volume, 0.42)
  assert.equal(f.timer.state(), null)
})
test('a local-time schedule uses the civil clock, including a jump past its deadline', async () => {
  const f = fixture(), request = f.request()
  request.schedule = { ...request.schedule!, clock: 'local', deadlineMs: 1_060_000 }
  await f.timer.configure(request)
  f.elapsed(10_000_000)
  await f.timer.check()
  assert.equal(f.pauses(), 0)
  f.wall(1_070_000)
  await f.timer.check()
  assert.equal(f.pauses(), 1)
})
test('replacing or cancelling a countdown invalidates its previous deadline', async () => {
  const f = fixture()
  await f.timer.configure(f.request())
  f.elapsed(50_000)
  await f.timer.configure(f.request())
  f.elapsed(61_000)
  await f.timer.check()
  assert.equal(f.pauses(), 0)
  await f.timer.cancel()
  f.elapsed(999_999)
  await f.timer.check()
  assert.equal(f.pauses(), 0)
})
test('finish-track arms the native boundary, then completes on the paused EOF snapshot', async () => {
  const f = fixture()
  await f.timer.configure(f.request(true))
  f.elapsed(61_000)
  await f.timer.check()
  assert.equal(f.timer.waiting(), true)
  assert.equal(f.armed(), true)
  assert.equal(f.pauses(), 0)
  f.info.state = 'paused'
  await f.timer.check()
  assert.equal(f.pauses(), 1)
  assert.equal(f.armed(), false)
})
test('a manual skip while waiting is consumed by pause; a later explicit play remains usable', async () => {
  const f = fixture()
  await f.timer.configure(f.request(true)); f.elapsed(61_000); await f.timer.check()
  assert.equal(await f.timer.consumeTransport('playback.next'), true)
  assert.equal(f.pauses(), 1)
  assert.equal(await f.timer.consumeTransport('playback.play'), false)
})
test('paused playback and indefinite streams complete immediately and cancel focus resume through pause', async () => {
  for (const state of ['paused', 'playing']) {
    const f = fixture(); f.info.state = state; f.info.duration = 0
    await f.timer.configure(f.request(true)); f.elapsed(61_000); await f.timer.check()
    assert.equal(f.pauses(), 1)
    assert.equal(f.armed(), false)
  }
})
test('only unexpired timers from this boot restore; an elapsed timer survives a wall-clock jump', async () => {
  const f = fixture(); await f.timer.configure(f.request())
  const saved = f.timer.state()!
  f.wall(99_000_000)
  const restored = new ScheduledPauseTimer(f.options); restored.restore(saved); restored.activate()
  assert.equal(restored.state()?.schedule?.id, 'task-1')
  f.elapsed(61_000)
  const expired = new ScheduledPauseTimer(f.options); expired.restore(saved)
  assert.equal(expired.state(), null)
  f.elapsed(1000); f.boot()
  const rebooted = new ScheduledPauseTimer(f.options); rebooted.restore(saved)
  assert.equal(rebooted.state(), null)
})
