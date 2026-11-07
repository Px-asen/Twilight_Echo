'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')

function wave(value, frames = 96000) {
  const data = Buffer.alloc(44 + frames * 8)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16)
  data.writeUInt16LE(3, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(48000, 24)
  data.writeUInt32LE(384000, 28); data.writeUInt16LE(8, 32); data.writeUInt16LE(32, 34)
  data.write('data', 36); data.writeUInt32LE(frames * 8, 40)
  for (let f = 0; f < frames * 2; f++) data.writeFloatLE(value, 44 + f * 4)
  return data
}

test('native capture timeline and group single-promotion lease', { timeout: 30000 }, async t => {
  const native = require(process.env.TWILIGHT_BRIDGE_NATIVE || resolve(__dirname, '../resources/audio-engine/twilight_audio_node.node'))
  const directory = await mkdtemp(join(tmpdir(), 'twilight-source-timeline-'))
  t.after(async () => { native.Stop(); native.SetBridgeQueueControl(false); await rm(directory, { recursive: true, force: true }) })
  const a = join(directory, 'a.wav'), b = join(directory, 'b.wav')
  await writeFile(a, wave(.25)); await writeFile(b, wave(.5))
  native.SetOutputBackend('bridge-pcm'); native.SetOutputDevice('48000/2')
  native.SetVolume(1); native.SetPlaybackRate(1); native.SetPlayMode('sequential')
  native.SetOutputConfig(JSON.stringify({ routingMode: 'auto', pcmToDsdMode: 'off' }))
  // The group lease overrides local transition preferences, not saved settings.
  native.SetDspConfig(JSON.stringify({ gapless: false, crossfadeSeconds: 1 }))
  const start = async (sameFile = false) => {
    native.Stop(); native.SetBridgeQueueControl(true)
    native.LoadQueue(JSON.stringify([
      { id: 'a', source: a, queueEntryId: 'a:1' },
      { id: sameFile ? 'a' : 'b', source: sameFile ? a : b, queueEntryId: 'a:2' },
      { id: 'a', source: a, queueEntryId: 'a:3' }
    ]), 0)
    native.SelectQueueIndex(0)
    native.Play(a)
    const deadline = Date.now() + 4000
    while (!JSON.parse(native.GetPlaybackInfo()).preloadReady && Date.now() < deadline) await delay(10)
    assert.equal(JSON.parse(native.GetPlaybackInfo()).preloadReady, true, native.GetPlaybackInfo())
  }
  for (const sameFile of [false, true]) await t.test(sameFile ? 'repeated media keeps occurrence identity' : 'exact PCM boundary with local crossfade suppressed', async () => {
    await start(sameFile)
    assert.throws(() => native.SetBridgeQueueControl(true, 'wrong', 'a:2'))
    native.SetBridgeQueueControl(true, 'a:1', 'a:2')
    const audio = [], timelines = []
    for (let n = 0; n < 115; n++) {
      const block = native.PullBridgePcm(1000), timeline = JSON.parse(block.sourceTimeline)
      assert.ok(timeline, native.GetPlaybackInfo())
      assert.equal(timeline.generation, block.generation)
      assert.equal(timeline.frames, (n + 1) * 1000)
      timelines.push(timeline); audio.push(block.pcm)
      if (n % 8 === 0) await delay(1)
    }
    assert.equal(new Set(timelines.map(v => v.generation)).size, 1)
    assert.equal(timelines[94].entryId, 'a:1')
    assert.equal(timelines[96].entryId, 'a:2')
    assert.equal(timelines[96].transitionSerial, 1)
    assert.equal(timelines[96].transitionFrame, 96000)
    assert.equal(timelines[96].positionFrames, 1000)
    const pcm = Buffer.concat(audio)
    for (let frame = 0; frame < pcm.length / 8; frame++)
      assert.ok(Math.abs(pcm.readFloatLE(frame * 8) - (frame < 96000 || sameFile ? .25 : .5)) < 1e-5, `frame ${frame}: ${pcm.readFloatLE(frame*8)}`)
    // Without a second all-member commit, the third decoder cannot promote.
    for (let n = 0; n < 90; n++) { native.PullBridgePcm(1000); if (n % 8 === 0) await delay(1) }
    await delay(130)
    assert.equal(JSON.parse(native.GetPlaybackInfo()).queueIndex, 1)
  })
  await t.test('group gapless keeps convolver delay and history across a repeated occurrence', async () => {
    const ir = join(directory, 'ir.wav'), bytes = wave(0, 128)
    for (const frame of [0, 64]) for (let c = 0; c < 2; c++) bytes.writeFloatLE(.5, 44+(frame*2+c)*4)
    await writeFile(ir, bytes)
    native.SetDspConfig(JSON.stringify({ dspEnabled: true, gapless: false, convolverEnabled: true,
      convolverIrPath: ir, convolverPartitionSize: 64, convolverDelayMs: 10, convolverWet: 1, convolverDry: 0 }))
    await start(true); native.SetBridgeQueueControl(true, 'a:1', 'a:2')
    const audio = []
    for (let n = 0; n < 115; n++) { audio.push(native.PullBridgePcm(1000).pcm); if (n%8 === 0) await delay(1) }
    const pcm = Buffer.concat(audio)
    for (let frame = 94000; frame < 98000; frame++)
      assert.ok(Math.abs(pcm.readFloatLE(frame*8)-.25) < 1e-4, `DSP continuity frame ${frame}: ${pcm.readFloatLE(frame*8)}`)
    native.SetDspConfig('{}')
  })
  await t.test('seek resets the stream generation and source origin, plain Play has no private occurrence', async () => {
    await start()
    const first = JSON.parse(native.PullBridgePcm(1000).sourceTimeline)
    native.Seek(.5)
    await delay(20)
    const seek = JSON.parse(native.PullBridgePcm(1000).sourceTimeline)
    assert.notEqual(seek.generation, first.generation)
    assert.equal(seek.frames, 1000); assert.equal(seek.positionFrames, 25000)
    assert.equal(seek.transitionSerial, 0)
    native.Stop(); native.LoadQueue('[]', 0); native.Play(a)
    assert.equal(JSON.parse(native.PullBridgePcm(1000).sourceTimeline), null)
  })
  await t.test('per-track ReplayGain changes before the live convolver without losing its tail', async () => {
    const ir = join(directory, 'ir.wav')
    const config = { dspEnabled: true, gapless: false, volumeNormalization: 'track', convolverEnabled: true,
      convolverIrPath: ir, convolverDelayMs: 10, convolverWet: 1, convolverDry: 0 }
    native.SetDspConfig(JSON.stringify(config))
    native.Stop(); native.SetBridgeQueueControl(true)
    const first = { id: 'a', source: a, queueEntryId: 'rg:1', replayGainTrackGainDb: 0 }
    const second = { ...first, queueEntryId: 'rg:2', replayGainTrackGainDb: -6.020599913279624 }
    native.LoadQueue(JSON.stringify([first, second]), 0); native.Play(a)
    await delay(30)
    native.SetBridgeQueueControl(true, 'rg:1', 'rg:2')
    const capture = async () => {
      const audio = []
      for (let n=0;n<110;n++) { audio.push(native.PullBridgePcm(1000).pcm); if (n%8===0) await delay(1) }
      return Buffer.concat(audio)
    }
    const joined = await capture()
    const referencePath = join(directory, 'joined-reference.wav'), reference = wave(.25, 192000)
    for (let n=96000;n<192000;n++) for (let c=0;c<2;c++) reference.writeFloatLE(.125,44+(n*2+c)*4)
    await writeFile(referencePath, reference)
    native.Stop(); native.LoadQueue(JSON.stringify([{ ...first, source: referencePath, queueEntryId: 'reference' }]),0)
    native.Play(referencePath)
    const continuous = await capture()
    for (let frame=94000;frame<100000;frame++) assert.ok(Math.abs(joined.readFloatLE(frame*8)-continuous.readFloatLE(frame*8)) < 1e-5,
      `track-gain/DSP order at ${frame}: ${joined.readFloatLE(frame*8)} / ${continuous.readFloatLE(frame*8)}`)
    native.SetDspConfig('{}')
  })
  await t.test('held source setup acknowledges DSP without consuming PCM; live capture cannot use that control lane', async () => {
    await start()
    native.ApplyDspState(100001, JSON.stringify({ revision: 100001, processing: { gapless: false },
      graph: { nodes: [], outputStage: {} } }))
    native.CommitBridgeSourceControls()
    assert.equal(JSON.parse(native.GetDspGraphStatus()).revision, 100001)
    const first = native.PullBridgePcm(1000)
    assert.equal(JSON.parse(first.sourceTimeline).frames, 1000)
    assert.equal(JSON.parse(first.sourceTimeline).advanceReady, true)
    assert.throws(() => native.CommitBridgeSourceControls())
  })
})
