import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLUGIN_NOTICE_MAX_DURATION_MS,
  PLUGIN_NOTICE_MESSAGE_MAX_LENGTH,
  PLUGIN_NOTICE_MIN_DURATION_MS,
  normalizePluginNoticeInput
} from './pluginNotice.ts'

test('normalizes a valid plugin notice', () => {
  assert.deepEqual(
    normalizePluginNoticeInput({ kind: 'warning', message: '  hi  ', durationMs: 5000 }),
    { kind: 'warning', message: 'hi', durationMs: 5000 }
  )
})

test('falls back to info and drops non-finite durations', () => {
  assert.deepEqual(normalizePluginNoticeInput({ message: 'hello' }), {
    kind: 'info',
    message: 'hello',
    durationMs: undefined
  })
  assert.equal(normalizePluginNoticeInput({ kind: 'nope', message: 'x' })?.kind, 'info')
  assert.equal(
    normalizePluginNoticeInput({ message: 'x', durationMs: Number.NaN })?.durationMs,
    undefined
  )
})

test('clamps duration and truncates long messages', () => {
  assert.equal(
    normalizePluginNoticeInput({ message: 'x', durationMs: 1 })?.durationMs,
    PLUGIN_NOTICE_MIN_DURATION_MS
  )
  assert.equal(
    normalizePluginNoticeInput({ message: 'x', durationMs: 10 ** 9 })?.durationMs,
    PLUGIN_NOTICE_MAX_DURATION_MS
  )
  const long = normalizePluginNoticeInput({ message: 'y'.repeat(2000) })
  assert.equal(long?.message.length, PLUGIN_NOTICE_MESSAGE_MAX_LENGTH)
})

test('rejects notices without a usable message', () => {
  assert.equal(normalizePluginNoticeInput(null), null)
  assert.equal(normalizePluginNoticeInput('hello'), null)
  assert.equal(normalizePluginNoticeInput({ message: '   ' }), null)
  assert.equal(normalizePluginNoticeInput({ message: 42 }), null)
})
