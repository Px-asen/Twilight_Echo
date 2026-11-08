const test = require('node:test')
const assert = require('node:assert/strict')
const { createEmbeddedHarness, createFakePlatform, wireTrack } = require('./portable-embedded-harness.cjs')

async function fixture() {
  const platform = createFakePlatform()
  platform.handlers['audioEngine.setPauseAtTrackEnd'] = ({ enabled }) => { platform.sleepBoundary = enabled; return true }
  const h = createEmbeddedHarness({ platform })
  h.core.updateHostClock(JSON.stringify({ monotonicMs: 1000, bootId: 'phone-1' }))
  await h.boot()
  await h.value('playback.replaceQueue', { tracks: [wireTrack('one'), wireTrack('two')], startIndex: 0, play: true })
  await h.value('playback.seek', { position: 27 })
  await h.value('playback.setVolume', { volume: 0.42 })
  return h
}
async function arm(h, finishCurrentTrack = false) {
  const state = await h.value('sleep.state', {}, 'query')
  await h.value('sleep.configure', { revision: state.revision, mode: 'minutes', action: 'pause',
    endsAt: Date.now() + 60_000, finishCurrentTrack,
    schedule: { id: 'sleep-test', clock: 'elapsed', deadlineMs: 61_000, bootId: 'phone-1' } })
}
test('embedded timer preserves position, queue and volume and appears in snapshots', async () => {
  const h = await fixture()
  await arm(h)
  assert.equal((await h.snapshot()).sleepTimer.timer.schedule.id, 'sleep-test')
  h.core.updateHostClock(JSON.stringify({ monotonicMs: 61_000, bootId: 'phone-1' }))
  await h.value('sleep.state', {}, 'query')
  const snapshot = await h.snapshot()
  assert.equal(snapshot.playback.state, 'paused')
  assert.equal(snapshot.playback.position, 27)
  assert.equal(snapshot.playback.volume, 0.42)
  assert.equal(snapshot.queue.total, 2)
  assert.equal(snapshot.sleepTimer.timer, null)
  await h.shutdown()
})
test('finish-track suppresses successor commands and explicit play resumes after completion', async () => {
  const h = await fixture()
  await arm(h, true)
  h.core.updateHostClock(JSON.stringify({ monotonicMs: 61_000, bootId: 'phone-1' }))
  assert.equal((await h.value('sleep.state', {}, 'query')).timer.waitingForTrackEnd, true)
  assert.equal(h.platform.sleepBoundary, true)
  await h.value('playback.next')
  assert.equal((await h.snapshot()).playback.state, 'paused')
  assert.equal((await h.snapshot()).sleepTimer.timer, null)
  await h.value('playback.play')
  assert.equal((await h.snapshot()).playback.state, 'playing')
  await h.shutdown()
})
test('active timer survives host recreation without autoplay and is discarded after reboot', async () => {
  const h = await fixture(); await arm(h); await h.shutdown()
  const restored = createEmbeddedHarness({ platform: h.platform })
  restored.core.updateHostClock(JSON.stringify({ monotonicMs: 2000, bootId: 'phone-1' }))
  await restored.boot()
  assert.equal((await restored.snapshot()).sleepTimer.timer.schedule.id, 'sleep-test')
  assert.notEqual((await restored.snapshot()).playback.state, 'playing')
  await restored.shutdown()
  const rebooted = createEmbeddedHarness({ platform: h.platform })
  rebooted.core.updateHostClock(JSON.stringify({ monotonicMs: 1000, bootId: 'phone-2' }))
  await rebooted.boot()
  assert.equal((await rebooted.snapshot()).sleepTimer.timer, null)
  await rebooted.shutdown()
})

test('a timer set before selecting music survives a process restart', async () => {
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  h.core.updateHostClock(JSON.stringify({ monotonicMs: 1000, bootId: 'phone-1' }))
  await h.boot(); await arm(h); await h.shutdown()
  const restored = createEmbeddedHarness({ platform })
  restored.core.updateHostClock(JSON.stringify({ monotonicMs: 2000, bootId: 'phone-1' }))
  await restored.boot()
  assert.equal((await restored.snapshot()).sleepTimer.timer.schedule.id, 'sleep-test')
  await restored.shutdown()
})

test('portable hosts reject unimplemented desktop sleep modes before arming a task', async () => {
  const h = await fixture()
  const response = await h.request('sleep.configure', { revision: 0, mode: 'queueEnd' })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'UNSUPPORTED_CAPABILITY')
  assert.equal((await h.value('sleep.state', {}, 'query')).timer, null)
  await h.shutdown()
})
