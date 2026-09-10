import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  detectedDownloadQuality,
  downloadLyricFiles,
  saveDownloadedLyrics,
  prepareDownloadedMetadata
} from './downloadMetadata.ts'
import { parseFile } from 'music-metadata'

test('Apple Music lossless at 24bit/48k is not falsely advertised as Hi-Res', () => {
  assert.equal(
    detectedDownloadQuality({ lossless: true, bitsPerSample: 24, sampleRate: 48000 }),
    'lossless'
  )
  assert.equal(
    detectedDownloadQuality({ lossless: true, bitsPerSample: 24, sampleRate: 96000 }),
    'hi-res'
  )
  assert.equal(detectedDownloadQuality({ codec: 'AAC', sampleRate: 96000 }), 'aac')
  assert.equal(detectedDownloadQuality({}), null)
})

test('word timing and translations are retained under their correct file formats', () => {
  const files = downloadLyricFiles({
    lyrics: '[00:01]你好',
    translatedLyrics: '[00:01]Hello',
    wordLyrics: '[1000,500](1000,250,0)你(1250,250,0)好'
  })
  assert.deepEqual(
    files.map((f) => f.suffix),
    ['.lrc', '.translated.lrc', '.yrc']
  )
  assert.equal(files[2].text, '[1000,500](1000,250,0)你(1250,250,0)好')
  assert.deepEqual(downloadLyricFiles({ lyrics: 'a'.repeat(1024 * 1024 + 1) }), [])
})

test('lyric export never overwrites an existing local lyric', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-download-lyrics-'))
  try {
    await writeFile(join(root, 'song.lrc'), 'original')
    const warning = await saveDownloadedLyrics(join(root, 'song.flac'), [
      { suffix: '.lrc', text: 'new' }
    ])
    assert.ok(warning)
    assert.equal(await readFile(join(root, 'song.lrc'), 'utf8'), 'original')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('optional tag enrichment preserves downloaded PCM and detects its real quality', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-download-tags-'))
  try {
    const audio = Buffer.alloc(44 + 400)
    audio.write('RIFF', 0)
    audio.writeUInt32LE(audio.length - 8, 4)
    audio.write('WAVEfmt ', 8)
    audio.writeUInt32LE(16, 16)
    audio.writeUInt16LE(1, 20)
    audio.writeUInt16LE(2, 22)
    audio.writeUInt32LE(48000, 24)
    audio.writeUInt32LE(192000, 28)
    audio.writeUInt16LE(4, 32)
    audio.writeUInt16LE(16, 34)
    audio.write('data', 36)
    audio.writeUInt32LE(400, 40)
    for (let index = 44; index < audio.length; index++) audio[index] = index % 251
    const partPath = join(root, 'song.part')
    await writeFile(partPath, audio)
    const result = await prepareDownloadedMetadata({
      partPath,
      targetPath: join(root, 'song.wav'),
      track: { id: 'song', title: '夜曲', artist: '歌手', album: '专辑' },
      preferences: { naming: 'title', embedMetadata: true, saveLyrics: true },
      getLyrics: async () => ({ lyrics: '[00:01.00]你好' }),
      signal: new AbortController().signal
    })
    assert.equal(result.actualQuality, 'lossless')
    const metadata = await parseFile(partPath)
    assert.equal(metadata.common.title, '夜曲')
    const written = await readFile(partPath)
    const dataIndex = written.indexOf(Buffer.from('data'))
    assert.deepEqual(written.subarray(dataIndex + 8, dataIndex + 8 + 400), audio.subarray(44))
    assert.equal(result.lyrics[0].text, '[00:01.00]你好')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
