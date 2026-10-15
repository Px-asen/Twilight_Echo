import assert from 'node:assert/strict'
import test from 'node:test'
import { trackRowKeyAction } from './trackRowKeyboard.ts'

test('table keyboard activation separates playback, selection and nested control actions', () => {
  const row = {}
  const event = (key: string, options: Record<string, unknown> = {}) =>
    ({
      key,
      target: row,
      currentTarget: row,
      defaultPrevented: false,
      preventDefault(this: { defaultPrevented: boolean }) {
        this.defaultPrevented = true
      },
      ...options
    }) as unknown as KeyboardEvent
  const enter = event('Enter')
  assert.equal(trackRowKeyAction(enter), 'play')
  assert.equal(enter.defaultPrevented, true)
  assert.equal(trackRowKeyAction(event(' ')), 'select')
  assert.equal(trackRowKeyAction(event(' ', { ctrlKey: true })), 'select')
  assert.equal(
    trackRowKeyAction(event('Enter', { target: {} })),
    null,
    'nested buttons keep their native activation'
  )
  assert.equal(trackRowKeyAction(event('Enter', { altKey: true })), null)
  const scroll = event(' ')
  assert.equal(trackRowKeyAction(scroll, false), null)
  assert.equal(scroll.defaultPrevented, false, 'unselectable lists retain Space scrolling')
})
