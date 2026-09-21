import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLyricLines } from './lyrics.ts'

test('embedded bilingual LRC keeps originals and translations on the same row', () => {
  const lines = buildLyricLines('[00:01]Hello\n[00:01]你好\n[00:02]Goodbye\n[00:02]再见', null)
  assert.deepEqual(
    lines.map(({ text, translation }) => ({ text, translation })),
    [
      { text: 'Hello', translation: '你好' },
      { text: 'Goodbye', translation: '再见' }
    ]
  )
})

test('embedded Japanese original, Chinese translation and romanization are separate layers', () => {
  const lines = buildLyricLines(
    '[00:01]こんにちは\n[00:01]你好\n[00:01]konnichiwa\n[00:02]さようなら\n[00:02]再见\n[00:02]sayounara',
    null
  )
  assert.equal(lines.length, 2)
  assert.equal(lines[0].romanization, 'konnichiwa')
  assert.equal(lines[0].translation, '你好')
})

test('explicit embedded labels work without guessing an isolated bilingual or duet row', () => {
  const explicit = buildLyricLines(
    '[00:01]你好\n[00:01][romaji]ni hao\n[00:01][translation]Hello',
    null
  )
  assert.equal(explicit[0].romanization, 'ni hao')
  assert.equal(explicit[0].translation, 'Hello')
  assert.equal(buildLyricLines('[00:01]Hello\n[00:01]你好', null).length, 2)
  assert.equal(buildLyricLines('[00:01]A\n[00:01]B\n[00:02]C\n[00:02]D', null).length, 4)
})

test('separate translation wins and explicit voice metadata is never reclassified', () => {
  const original = '[00:01]Hello\n[00:01]你好\n[00:02]Goodbye\n[00:02]再见'
  assert.equal(buildLyricLines(original, '[00:01]您好\n[00:02]再會')[0].translation, '您好')
  assert.equal(buildLyricLines(original, '')[0].translation, null)
  const voiced = original
    .replaceAll(']Hello', '][te:voice role=lead lane=start]Hello')
    .replaceAll(']Goodbye', '][te:voice role=lead lane=start]Goodbye')
  assert.equal(buildLyricLines(voiced, null).length, 4)
})
