const assert = require('node:assert/strict')
const test = require('node:test')
const { createEmbeddedHarness, createFakePlatform, wireTrack } = require('./portable-embedded-harness.cjs')
const lock = require('../audio-engine/automix-native/dependencies.lock.json')
const modelVersion = `twilight-automix-native-1:${lock.models['beat-this-small0'].graphSha256}:${lock.models.yamnet.graphSha256}`
const tracks = ['a', 'b'].map(id => wireTrack(id, { duration: 60 }))

function features(options) {
  const o = JSON.parse(options), duration = o.sourceEndSeconds - o.sourceStartSeconds
  const start = o.rangeStartSeconds, end = Math.min(start + 30, duration)
  return { ok: true, algorithm: 'Twilight AutoMix', modelVersion, sourceIdentity: o.sourceIdentity,
    coverage: { startSeconds: start, endSeconds: end, durationSeconds: duration, complete: start === 0 && end === duration },
    bpm: 120, tempoConfidence: 0.9, rmsDb: -12, peak: 0.2, key: -1, keyConfidence: 0,
    beats: [], downbeats: [], voice: [], frameDb: Array(Math.ceil((end - start) * 50)).fill(-12),
    framePeak: Array(Math.ceil((end - start) * 50)).fill(0.2) }
}
function fixture(overrides = {}) {
  const platform = createFakePlatform()
  platform.cache = null
  platform.hash = 'a'.repeat(64)
  Object.assign(platform.handlers, {
    'audioEngine.setAutoMixMode': ({ mode }) => { platform.audio.autoMixMode = mode; return true },
    'audioEngine.cancelAutoMix': () => {
      platform.audio.autoMixPlanId = 0; platform.audio.autoMixState = 'degraded'; platform.audio.autoMixReason = 'host_cancelled'; return true
    },
    'audioEngine.getSnapshot': () => ({ ...platform.audio,
      upcomingQueueIndex: platform.audio.queueIndex === 0 ? 1 : -1 }),
    'audioAnalysis.identify': () => ({ ok: true, sourceIdentity: platform.hash }),
    'audioAnalysis.analyze': ({ optionsJson }) => features(optionsJson),
    'audioAnalysis.readCache': () => platform.cache,
    'audioAnalysis.writeCache': ({ text }) => { platform.cache = text; return true },
    'audioAnalysisControl.cancel': () => true,
    'audioEngine.selectAutoMix': () => ({ ok: true, selectionId: 71, currentStartSeconds: 55, currentEndSeconds: 60 }),
    'audioEngine.prepareAutoMix': ({ requestJson }) => {
      assert.equal(JSON.parse(requestJson).selectionId, 71)
      Object.assign(platform.audio, { autoMixState: 'ready', autoMixReason: '', autoMixPlanId: 91,
        autoMixStrategy: 'content-boundary', autoMixDurationSeconds: 5, autoMixDecodeMs: 24, autoMixPrepareMs: 7 })
      return true
    },
    'audioEngine.submitAutoMix': ({ planId }) => { assert.equal(planId, 91); return true },
    ...overrides
  })
  return platform
}
async function play(h) {
  await h.value('library.syncTracks', { tracks })
  await h.value('playback.replaceQueue', { tracks: tracks.map(({ id }) => ({ id })), play: true })
}
const setMode = (h, mode) => h.value('settings.edit', { key: 'autoMixMode', valueJson: JSON.stringify(mode) })
const calls = (platform, name) => platform.calls.filter(call => call.key === name)

test('actual portable bundle defaults off and reuses two bounded SAF windows through native submit and restart', async () => {
  const platform = fixture(), h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'automix' }); await play(h)
  assert.equal((await h.snapshot()).playback.autoMixMode, 'off')
  assert.equal(calls(platform, 'audioAnalysis.analyze').length, 0)
  await setMode(h, 'natural')
  const ready = (await h.snapshot()).playback
  assert.equal(ready.autoMixState, 'ready')
  assert.equal(ready.autoMixStrategy, 'content-boundary')
  assert.equal(ready.autoMixPlanId, 91)
  assert.equal(ready.autoMixDecodeMs, 24)
  assert.equal(ready.crossfadeMixActive, false)
  assert.equal(calls(platform, 'audioAnalysis.analyze').length, 2)
  assert.deepEqual(calls(platform, 'audioAnalysis.analyze').map(c => JSON.parse(c.args.optionsJson).rangeStartSeconds), [30, 0])
  await h.value('playback.pause'); await h.value('playback.play')
  assert.equal((await h.snapshot()).playback.autoMixState, 'ready')
  assert.equal(calls(platform, 'audioAnalysis.analyze').length, 2)
  assert.equal(calls(platform, 'audioEngine.submitAutoMix').length, 2)
  await h.shutdown()
  assert.equal(platform.stored.includes('"autoMixPlanId"'), false)
  const restored = createEmbeddedHarness({ platform })
  await restored.boot({ epoch: 'automix-restored' })
  assert.equal((await restored.snapshot()).playback.autoMixMode, 'natural')
  assert.equal((await restored.snapshot()).playback.state, 'paused')
  assert.equal((await restored.snapshot()).playback.autoMixPlanId, 0)
  await restored.value('playback.play')
  const resumed = (await restored.snapshot()).playback
  assert.equal(resumed.autoMixState, 'ready', JSON.stringify(resumed))
  assert.equal(calls(platform, 'audioAnalysis.analyze').length, 2)
  await restored.shutdown()
})

test('rejected native mode leaves the accepted setting and current playback unchanged', async () => {
  const platform = fixture({ 'audioEngine.setAutoMixMode': () => false }), h = createEmbeddedHarness({ platform })
  await h.boot(); await play(h)
  const response = await h.request('settings.edit', { key: 'autoMixMode', valueJson: '"natural"' })
  assert.equal(response.ok, false)
  const after = (await h.snapshot()).playback
  assert.equal(after.autoMixMode, 'off'); assert.equal(after.state, 'playing')
  assert.equal(calls(platform, 'audioAnalysis.analyze').length, 0)
  await h.shutdown()
})

test('unidentified streams and malformed model results degrade without stopping ordinary playback', async () => {
  for (const overrides of [
    { 'audioAnalysis.identify': () => ({ ok: false, reason: 'actual_source_identity_unavailable' }) },
    { 'audioAnalysis.analyze': () => ({ ok: true, algorithm: 'Twilight AutoMix' }) }
  ]) {
    const platform = fixture(overrides), h = createEmbeddedHarness({ platform })
    await h.boot(); await play(h); await setMode(h, 'natural')
    const playback = (await h.snapshot()).playback
    assert.equal(playback.state, 'playing'); assert.equal(playback.autoMixState, 'degraded')
    assert.equal(playback.autoMixMode, 'natural')
    assert.equal(calls(platform, 'audioEngine.prepareAutoMix').length, 0)
    await h.shutdown()
  }
})

test('seek invalidates the plan; changed content invalidates only its cached identity', async () => {
  const platform = fixture(), h = createEmbeddedHarness({ platform })
  await h.boot(); await play(h); await setMode(h, 'natural')
  assert.equal(calls(platform, 'audioEngine.submitAutoMix').length, 1)
  platform.hash = 'b'.repeat(64)
  await h.value('playback.seek', { position: 5 })
  assert.equal(calls(platform, 'audioAnalysis.analyze').length, 4)
  assert.equal(calls(platform, 'audioEngine.submitAutoMix').length, 2)
  await setMode(h, 'off')
  assert.equal((await h.snapshot()).playback.autoMixMode, 'off')
  const submitted = calls(platform, 'audioEngine.submitAutoMix').length
  await h.value('playback.seek', { position: 10 })
  assert.equal(calls(platform, 'audioEngine.submitAutoMix').length, submitted)
  await h.shutdown()
})
