import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chunkAndSplitLyricWords,
  chunkSpan,
  chunkWords,
  isCJK,
  resolveLyricWordTimings,
  type LyricWordChunk
} from './lyricWordChunks.ts'

function texts(chunks: LyricWordChunk[]): string[] {
  return chunks.map((chunk) => {
    if (chunk.kind === 'space') return `_${chunk.text}_`
    if (chunk.kind === 'word') return chunk.word.text
    return `[${chunk.words.map((word) => word.text).join('|')}]`
  })
}

test('syllables of one visual word merge into a single chunk', () => {
  // YRC routinely emits "love" as "lo" + "ve". Emphasis must treat it as one
  // word, otherwise each half scales independently.
  const words = resolveLyricWordTimings([
    { text: 'lo', time: 1, endTime: 1.5 },
    { text: 've', time: 1.5, endTime: 2 }
  ])
  const chunks = chunkAndSplitLyricWords(words)

  assert.deepEqual(texts(chunks), ['[lo|ve]'])
  const span = chunkSpan(chunks[0])
  assert.ok(span)
  assert.equal(span.text, 'love')
  assert.equal(span.time, 1)
  assert.equal(span.endTime, 2)
})

test('CJK characters never merge, so a Chinese line cannot emphasize as one unit', () => {
  const words = resolveLyricWordTimings([
    { text: '我', time: 0, endTime: 1 },
    { text: '爱', time: 1, endTime: 2 },
    { text: '你', time: 2, endTime: 3 }
  ])
  const chunks = chunkAndSplitLyricWords(words)

  assert.deepEqual(texts(chunks), ['我', '爱', '你'])
})

test('CJK punctuation stays attached to its neighbouring glyph while fullwidth-punctuated tokens still split cleanly', () => {
  const words = resolveLyricWordTimings([
    { text: '「', time: 0, endTime: 0.2 },
    { text: '夜', time: 0.2, endTime: 0.6 },
    { text: '風，', time: 0.6, endTime: 1.2 },
    { text: '吹', time: 1.2, endTime: 1.6 },
    { text: '」', time: 1.6, endTime: 1.8 },
    { text: '。', time: 1.8, endTime: 2.0 }
  ])
  const chunks = chunkAndSplitLyricWords(words)

  assert.deepEqual(texts(chunks), ['[「|夜]', '風，', '[吹|」|。]'])
})

test('boundary spaces become collapsible chunks outside visual words', () => {
  const words = resolveLyricWordTimings([
    { text: 'is', time: 0, endTime: 1 },
    { text: ' a', time: 1, endTime: 2 },
    { text: ' su', time: 2, endTime: 3 },
    { text: 'gar', time: 3, endTime: 4 }
  ])
  const chunks = chunkAndSplitLyricWords(words)

  assert.deepEqual(texts(chunks), ['is', '_ _', 'a', '_ _', '[su|gar]'])
})

test('whitespace-only entries become their own chunks', () => {
  const words = resolveLyricWordTimings([
    { text: 'Life', time: 0, endTime: 1 },
    { text: ' ', time: 1, endTime: 1 },
    { text: 'is', time: 1, endTime: 2 }
  ])
  const chunks = chunkAndSplitLyricWords(words)

  assert.deepEqual(texts(chunks), ['Life', '_ _', 'is'])
  assert.deepEqual(chunkWords(chunks[1]), [], 'a space chunk carries no timed words')
  assert.equal(chunkSpan(chunks[1]), null)
})

test('an entry containing internal spaces is split with proportional timing', () => {
  const words = resolveLyricWordTimings([{ text: 'gar so', time: 1, endTime: 2 }])
  const chunks = chunkAndSplitLyricWords(words)

  assert.deepEqual(texts(chunks), ['gar', '_ _', 'so'])

  // "garso" is 5 characters, so "gar" owns 3/5 of the span and "so" the rest.
  const first = chunkSpan(chunks[0])
  const last = chunkSpan(chunks[2])
  assert.ok(first && last)
  assert.equal(first.time, 1)
  assert.ok(Math.abs(first.endTime - 1.6) < 1e-9)
  assert.ok(Math.abs(last.time - 1.6) < 1e-9)
  assert.equal(last.endTime, 2)
})

test('adjacent entries with no separating space stay merged', () => {
  // AMLL's own docstring claims "so" and "sweet" end up separate here, but its
  // algorithm merges them, because the source never put a space between them.
  const words = resolveLyricWordTimings([
    { text: 'so', time: 0, endTime: 1 },
    { text: 'sweet', time: 1, endTime: 2 }
  ])
  assert.deepEqual(texts(chunkAndSplitLyricWords(words)), ['[so|sweet]'])
})

test('isCJK covers Han and Kana but not Hangul or Latin', () => {
  assert.ok(isCJK('我'))
  assert.ok(isCJK('あ'))
  assert.ok(isCJK('ア'))
  assert.ok(!isCJK('가'), 'Hangul sits above the range AMLL uses')
  assert.ok(!isCJK('a'))
  assert.ok(!isCJK(' 我'), 'the test is anchored, so leading space disqualifies it')
  assert.ok(!isCJK(''))
})

test('word end times resolve from the explicit value, then the next word, then the line', () => {
  const resolved = resolveLyricWordTimings(
    [
      { text: 'a', time: 0, endTime: 0.5 },
      { text: 'b', time: 1, endTime: null },
      { text: 'c', time: 2, endTime: null }
    ],
    4
  )

  assert.equal(resolved[0].endTime, 0.5, 'explicit end time wins')
  assert.equal(resolved[1].endTime, 2, 'falls back to the next word start')
  assert.equal(resolved[2].endTime, 4, 'falls back to the line end')
})

test('a non-advancing end time degrades to the word start instead of going backwards', () => {
  const resolved = resolveLyricWordTimings([{ text: 'a', time: 5, endTime: 3 }])
  assert.equal(resolved[0].endTime, 5)

  const noHints = resolveLyricWordTimings([{ text: 'a', time: 5, endTime: null }])
  assert.equal(noHints[0].endTime, 5)
})

test('empty input yields no chunks', () => {
  assert.deepEqual(chunkAndSplitLyricWords([]), [])
  assert.deepEqual(resolveLyricWordTimings([]), [])
})
