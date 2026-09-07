import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  gradientColors,
  matchesStudioSearch,
  parseStudioColor,
  replaceGradientAngle,
  replaceGradientColor,
  studioColorValue,
  studioTokenLabel
} from './themeVisualControls.ts'

test('studio search accepts displayed names, old labels, IDs and multiple search terms', () => {
  const id = 'library.table.surface'
  const original = '媒体库列表表面'
  const terms = [studioTokenLabel(original, id), original, id]
  assert.equal(matchesStudioSearch('歌曲 底色', ...terms), true)
  assert.equal(matchesStudioSearch('列表表面', ...terms), true)
  assert.equal(matchesStudioSearch(' LIBRARY.TABLE ', ...terms), true)
  assert.equal(matchesStudioSearch('歌曲 字体', ...terms), false)
})

test('color picker preserves opacity across rgba and short or alpha hex colors', () => {
  for (const [value, expected] of [
    ['rgba(29, 29, 39, 0.66)', { hex: '#1d1d27', opacity: 66 }],
    ['#abc', { hex: '#aabbcc', opacity: 100 }],
    ['#1238', { hex: '#112233', opacity: 53 }],
    ['#11223300', { hex: '#112233', opacity: 0 }],
    ['transparent', { hex: '#000000', opacity: 0 }]
  ] as const)
    assert.deepEqual(parseStudioColor(value), expected)
  assert.equal(studioColorValue({ hex: '#1d1d27', opacity: 66 }), 'rgba(29, 29, 39, 0.66)')
  assert.equal(parseStudioColor('rgba(900, 1, 2, 1)'), null)
  assert.equal(parseStudioColor('var(--color)'), null)
})

test('gradient edits preserve all other colors, alpha and stop positions', () => {
  const original =
    'linear-gradient(180deg, rgba(5, 7, 11, 0.72) 0%, rgba(5, 7, 11, 0.74) 52%, rgba(5, 7, 11, 0.78) 100%)'
  assert.equal(gradientColors(original).length, 3)
  assert.equal(
    replaceGradientColor(original, 1, '#ff0000'),
    'linear-gradient(180deg, rgba(5, 7, 11, 0.72) 0%, #ff0000 52%, rgba(5, 7, 11, 0.78) 100%)'
  )
  assert.equal(replaceGradientAngle(original, 90), original.replace('180deg', '90deg'))
  assert.equal(
    replaceGradientAngle('linear-gradient(to top, #38bdf8, #a78bfa)', 180),
    'linear-gradient(180deg, #38bdf8, #a78bfa)'
  )
  assert.equal(
    replaceGradientAngle('linear-gradient(#fff, #000)', 90),
    'linear-gradient(90deg, #fff, #000)'
  )
})
