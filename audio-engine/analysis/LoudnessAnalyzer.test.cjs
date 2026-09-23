const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const test = require('node:test')

const native = require(
  process.env.TWILIGHT_LOUDNESS_NATIVE_BINDING ||
    '../../resources/audio-engine/twilight_audio_node.node'
)
const sampleRate = 48000

function wav(segments, frequency = 1000, phase = 0) {
  const frames = Math.round(
    segments.reduce((seconds, segment) => seconds + segment.seconds, 0) * sampleRate
  )
  const pcm = Buffer.alloc(frames * 4)
  let position = 0
  for (const segment of segments) {
    const count = Math.round(segment.seconds * sampleRate)
    for (let frame = 0; frame < count; frame++, position++) {
      const value = Math.round(
        segment.amplitude *
          Math.sin((2 * Math.PI * frequency * position) / sampleRate + phase) *
          32767
      )
      pcm.writeInt16LE(value, position * 4)
      pcm.writeInt16LE(value, position * 4 + 2)
    }
  }
  return pcmWav(pcm)
}

function pcmWav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(pcm.length + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function fixtures(t) {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-loudness-native-'))
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    rmSync(directory, { recursive: true, force: true })
  })
  return (name, bytes) => {
    const path = join(directory, name)
    writeFileSync(path, bytes)
    return path
  }
}

function analyze(path, options = {}) {
  return JSON.parse(native.AnalyzeLoudness(path, JSON.stringify(options)))
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, expected ${expected} ± ${tolerance}`
  )
}

test('processed EQ loudness matches gain references and compensated remeasurement', (t) => {
  const file = fixtures(t)
  const path = file('audition.wav', wav([{ seconds: 12, amplitude: 0.1 }]))
  const graph = (gain, bands = []) => ({
    version: 2,
    nodes: [
      {
        id: 'eq',
        type: 'equalizer',
        enabled: true,
        params: { mode: 'parametric', preampDb: gain, bands }
      }
    ],
    outputStage: {
      targetSampleRate: 'device',
      resamplerQuality: 'native',
      dither: 'off',
      safetyClamp: true
    }
  })
  const measured = (processedGraph) =>
    analyze(path, { startSeconds: 0, endSeconds: 12, processedGraph })
  const a = measured(graph(0))
  const b = measured(graph(-6))
  assert.equal(a.processingVersion, 1, JSON.stringify(a))
  near(a.integratedLufs - b.integratedLufs, 6, 0.01, 'processed gain difference')
  const matchedA = measured(graph(b.integratedLufs - a.integratedLufs))
  near(matchedA.integratedLufs, b.integratedLufs, 0.1, 'matched LUFS')
  assert.ok(matchedA.truePeakDb <= -1 && b.truePeakDb <= -1)
  const eq = measured(
    graph(0, [{ frequency: 1000, gain: -6, q: 1, enabled: true, filterType: 'peak' }])
  )
  near(eq.integratedLufs, b.integratedLufs, 0.1, 'EQ center attenuation')
  const unity = measured({ ...graph(0), nodes: [] })
  near(unity.integratedLufs, analyze(path).integratedLufs, 0.001, 'identity graph')
  const unsupported = graph(0)
  unsupported.nodes[0].type = 'compressor'
  assert.match(measured(unsupported).error, /equalizer/)
  assert.match(
    analyze(path, { startSeconds: 0, endSeconds: 2, processedGraph: graph(0) }).error,
    /10 to 60/
  )
})

test('native whole-track measurements repeat and meet sine loudness / true-peak tolerances', (t) => {
  const file = fixtures(t)
  const path = file('tone.wav', wav([{ seconds: 6, amplitude: 0.1 }]))
  const before = createHash('sha256').update(readFileSync(path)).digest('hex')
  const first = analyze(path)
  const second = analyze(path)
  assert.equal(first.available, true, JSON.stringify(first))
  assert.equal(first.algorithmVersion, 2)
  near(first.integratedLufs, -20.04, 0.15, 'stereo 1 kHz LUFS')
  near(first.truePeakDb, -20, 0.1, 'true peak')
  near(second.integratedLufs, first.integratedLufs, 0.001, 'repeat LUFS')
  near(second.truePeakDb, first.truePeakDb, 0.001, 'repeat true peak')
  assert.equal(first.analyzedFrames, 6 * sampleRate)
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before)
  t.diagnostic(JSON.stringify({ fixture: 'stereo-1khz-0.1-6s', ...first }))
})

test('album loudness combines gated energy across unequal lengths and does not average dB', (t) => {
  const file = fixtures(t)
  const loud = file('loud.wav', wav([{ seconds: 12, amplitude: 0.1 }]))
  const soft = file('soft.wav', wav([{ seconds: 36, amplitude: 0.05 }]))
  const result = analyze(loud, { segments: [{ source: loud }, { source: soft }], album: true })
  assert.equal(result.tracks?.length, 2, JSON.stringify(result))
  near(result.tracks[0].integratedLufs, -20.04, 0.15, 'loud track')
  near(result.tracks[1].integratedLufs, -26.06, 0.15, 'soft track')
  near(result.album.integratedLufs, -23.63, 0.15, 'duration-weighted gated album')
  assert.ok(
    Math.abs(
      result.album.integratedLufs -
        (result.tracks[0].integratedLufs + result.tracks[1].integratedLufs) / 2
    ) > 0.4
  )
  assert.equal(result.album.truePeakDb, Math.max(...result.tracks.map((track) => track.truePeakDb)))
  const repeated = analyze(loud, { segments: [{ source: loud }, { source: soft }], album: true })
  near(repeated.album.integratedLufs, result.album.integratedLufs, 0.001, 'repeat album')
  t.diagnostic(JSON.stringify({ fixture: 'album-12s-0.1-plus-36s-0.05', ...result }))
})

test('CUE source ranges match separately cut PCM and fail when the requested interval is truncated', (t) => {
  const file = fixtures(t)
  const bytes = wav([
    { seconds: 1, amplitude: 0.7 },
    { seconds: 6, amplitude: 0.05 },
    { seconds: 1, amplitude: 0.8 }
  ])
  const path = file('disc.wav', bytes)
  const startSeconds = 1.371
  const endSeconds = 6.783
  const startFrame = Math.round(startSeconds * sampleRate)
  const endFrame = Math.round(endSeconds * sampleRate)
  const reference = file('cut.wav', pcmWav(bytes.subarray(44 + startFrame * 4, 44 + endFrame * 4)))
  const expected = analyze(reference)
  const actual = analyze(path, {
    segments: [{ source: path, startSeconds, endSeconds }],
    album: true
  })
  assert.equal(actual.tracks?.length, 1, JSON.stringify(actual))
  assert.equal(actual.tracks[0].analyzedFrames, endFrame - startFrame)
  near(actual.tracks[0].integratedLufs, expected.integratedLufs, 0.001, 'CUE LUFS')
  near(actual.tracks[0].truePeakDb, expected.truePeakDb, 0.001, 'CUE peak')
  const truncated = analyze(path, {
    segments: [{ source: path, startSeconds: 7, endSeconds: 10 }],
    album: true
  })
  assert.match(truncated.error, /ended before/)
  assert.equal(truncated.album, undefined)
  const missing = analyze(path, {
    segments: [{ source: path }, { source: path + '.missing' }],
    album: true
  })
  assert.equal(typeof missing.error, 'string')
  assert.equal(missing.tracks, undefined)
})

test('true peak detects intersample overs and silent or corrupt members cannot publish an album', (t) => {
  const file = fixtures(t)
  const path = file('intersample.wav', wav([{ seconds: 4, amplitude: 0.9 }], 12000, Math.PI / 4))
  const result = analyze(path)
  const samplePeakDb = 20 * Math.log10(0.9 / Math.sqrt(2))
  assert.ok(result.truePeakDb > samplePeakDb + 2, JSON.stringify(result))
  const silent = file('silent.wav', wav([{ seconds: 2, amplitude: 0 }]))
  const invalid = file('invalid.wav', Buffer.from('not an audio file'))
  for (const source of [silent, invalid]) {
    const album = analyze(path, { segments: [{ source: path }, { source }], album: true })
    assert.equal(typeof album.error, 'string')
    assert.equal(album.album, undefined)
    assert.equal(album.tracks, undefined)
  }
})
