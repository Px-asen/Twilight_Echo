import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { LyricsContentType, parseBuffer, TimestampFormat, type ILyricsTag } from 'music-metadata'
import { extractEmbeddedLyrics, loadLocalLyrics } from './loadLyrics.ts'

function flacWithLyrics(lyrics: string): Buffer {
  const streamInfo = Buffer.alloc(38)
  streamInfo.writeUIntBE(34, 1, 3)
  streamInfo.writeUInt16BE(4096, 4)
  streamInfo.writeUInt16BE(4096, 6)
  streamInfo.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 10584000n, 14)
  const comment = Buffer.from(`LYRICS=${lyrics}`)
  const comments = Buffer.alloc(16 + comment.length)
  comments[0] = 0x84
  comments.writeUIntBE(comments.length - 4, 1, 3)
  comments.writeUInt32LE(0, 4)
  comments.writeUInt32LE(1, 8)
  comments.writeUInt32LE(comment.length, 12)
  comment.copy(comments, 16)
  return Buffer.concat([Buffer.from('fLaC'), streamInfo, comments])
}

function synchronizedLyrics(overrides: Partial<ILyricsTag> = {}): ILyricsTag {
  return {
    contentType: LyricsContentType.lyrics,
    timeStampFormat: TimestampFormat.milliseconds,
    text: 'Opening / 开场\nVerse / 主歌\nEnding / 结束',
    syncText: [
      { timestamp: 520, text: 'Opening / 开场' },
      { timestamp: 5700, text: 'Verse / 主歌' },
      { timestamp: 212060, text: 'Ending / 结束' }
    ],
    ...overrides
  }
}

test('FLAC Vorbis lyrics keep their original LRC timestamps after music-metadata separates syncText', async () => {
  const lrc =
    '[ti:Timing regression]\n[00:00.52]Opening / 开场\n[00:05.70]Verse / 主歌\n[03:32.06]Ending / 结束'
  const metadata = await parseBuffer(flacWithLyrics(lrc), { mimeType: 'audio/flac' })
  assert.equal(metadata.common.lyrics?.[0].syncText[1].timestamp, 5700)
  assert.ok(!metadata.common.lyrics?.[0].text?.includes('[00:05.70]'))
  assert.equal(extractEmbeddedLyrics(metadata), lrc)
})

test('native LRC retains offsets, repeated timestamps and word timing verbatim', async () => {
  const lrc =
    '[offset:250]\n[00:01.00][00:10.00]Repeated\n[00:20.00]<00:20.00>Word <00:20.50>timing'
  const metadata = await parseBuffer(flacWithLyrics(lrc), { mimeType: 'audio/flac' })
  assert.equal(extractEmbeddedLyrics(metadata), lrc)
})

test('structured synchronized lyrics become millisecond LRC when raw LRC is unavailable', () => {
  assert.equal(
    extractEmbeddedLyrics({ common: { lyrics: [synchronizedLyrics()] }, native: {} }),
    '[00:00.520]Opening / 开场\n[00:05.700]Verse / 主歌\n[03:32.060]Ending / 结束'
  )
})

test('synchronized lyrics take priority over an earlier plain-text lyric tag', () => {
  const plain = synchronizedLyrics({
    timeStampFormat: TimestampFormat.notSynchronized,
    syncText: []
  })
  assert.match(
    extractEmbeddedLyrics({ common: { lyrics: [plain, synchronizedLyrics()] }, native: {} })!,
    /^\[00:00\.520\]/
  )
})

test('MPEG frame numbers are never treated as millisecond timing', () => {
  const lyric = synchronizedLyrics({ timeStampFormat: TimestampFormat.mpegFrameNumber })
  assert.equal(extractEmbeddedLyrics({ common: { lyrics: [lyric] }, native: {} }), lyric.text)
  assert.equal(extractEmbeddedLyrics({ common: {}, native: {} }), null)
})

test('invalid sync timestamps are skipped and multiline entries share their real timestamp', () => {
  const lyric = synchronizedLyrics({
    syncText: [
      { text: 'No timestamp' },
      { timestamp: NaN, text: 'Invalid' },
      { timestamp: -1, text: 'Negative' },
      { timestamp: Infinity, text: 'Infinite' },
      { timestamp: 61234, text: 'Original\r\nTranslation' },
      { timestamp: 65000, text: '' }
    ]
  })
  assert.equal(
    extractEmbeddedLyrics({ common: { lyrics: [lyric] }, native: {} }),
    '[01:01.234]Original\n[01:01.234]Translation\n[01:05.000]'
  )
})

test('lazy local loading prefers sibling LRC and falls back to embedded FLAC timing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-embedded-lyrics-'))
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    await rm(directory, { recursive: true, force: true })
  })
  const fileName = 'timed.flac'
  const audioPath = join(directory, fileName)
  const embedded = '[00:00.52]Opening\n[00:05.70]Verse'
  await writeFile(audioPath, flacWithLyrics(embedded))
  assert.equal(await loadLocalLyrics(directory, fileName, audioPath), embedded)
  assert.equal(await loadLocalLyrics(directory, fileName, null), null)
  const external = '[00:01.00]User supplied timing'
  await writeFile(join(directory, 'timed.lrc'), '\uFEFF' + external)
  assert.equal(await loadLocalLyrics(directory, fileName, audioPath), external)
  assert.equal(await loadLocalLyrics(directory, fileName, null), external)
  assert.equal(
    await loadLocalLyrics(directory, 'missing.flac', join(directory, 'missing.flac')),
    null
  )
})
