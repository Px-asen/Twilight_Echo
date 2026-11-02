const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

// Explicit path keeps this check independent of the installed/staged player.
const native = require(resolve(process.env.TWILIGHT_BRIDGE_TEST_ADDON || 'resources/audio-engine/twilight_audio_node.node'))
test('real Core decode/DSP feeds pull-clocked PCM; pause/seek/stop isolate generations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'twilight-bridge-capture-'))
  try {
    const rate = 44100, count = rate * 3
    const wav = Buffer.alloc(44 + count * 4)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24)
    wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(count * 4, 40)
    for (let n = 0; n < count; n++) for (let c = 0; c < 2; c++)
      wav.writeInt16LE(Math.round(Math.sin(n * 2 * Math.PI * 1000 / rate) * 8192), 44 + (n * 2 + c) * 2)
    const path = join(dir, 'tone.wav'); writeFileSync(path, wav)
    native.SetOutputBackend('bridge-pcm'); native.SetOutputDevice('48000/2'); native.SetVolume(1)
    const rms = (db) => {
      native.Stop()
      native.SetOutputConfig(JSON.stringify({ pcmToDsdMode: 'dsd64' })) // local DSD profile must not escape to hardware
      native.SetDspConfig(JSON.stringify({ dspEnabled: true, eqEnabled: true, eqPreamp: db, fftEnabled: false,
        dsdRoute: { enabled: true, backend: 'asio', device: 'do-not-open-a-local-driver' } }))
      native.Play(path)
      let sum = 0, samples = 0
      for (let n = 0; n < 15; n++) {
        const block = native.PullBridgePcm(2048)
        assert.equal(block.sampleRate, 48000); assert.equal(block.channels, 2)
        assert.equal(block.pcm.length, block.frames * 8)
        if (n > 2) for (let i = 0; i < block.pcm.length; i += 4) { sum += block.pcm.readFloatLE(i) ** 2; samples++ }
      }
      return Math.sqrt(sum / samples)
    }
    const unity = rms(0), processed = rms(-6)
    assert.ok(unity > .1); assert.ok(processed / unity > .48 && processed / unity < .53, `${processed / unity}`)
    const before = native.PullBridgePcm(128)
    native.Pause()
    const paused = native.PullBridgePcm(128)
    assert.ok(paused.generation > before.generation); assert.equal(paused.playing, false); assert.equal(paused.frames, 0)
    native.Pause(); native.Seek(1.5)
    const sought = native.PullBridgePcm(128)
    assert.ok(sought.generation > paused.generation); assert.ok(sought.frames > 0)
    native.Stop()
    const stopped = native.PullBridgePcm(128)
    assert.ok(stopped.generation > sought.generation); assert.equal(stopped.frames, 0)
    assert.throws(() => native.PullBridgePcm(4096))
  } finally { native.Stop(); rmSync(dir, { recursive: true, force: true }) }
})
