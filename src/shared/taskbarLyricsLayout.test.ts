import assert from 'node:assert/strict'
import test from 'node:test'
import { taskbarLyricsBounds } from './taskbarLyricsLayout.ts'

test('taskbar lyrics stay on displays with negative origins and inside taskbar bounds', () => {
  const bounds = { x: -1920, y: 0, width: 1920, height: 1080 }
  const area = { ...bounds, height: 1032 }
  assert.deepEqual(taskbarLyricsBounds(bounds, area, 320, 100), {
    x: -320,
    y: 1032,
    width: 320,
    height: 48
  })
  assert.deepEqual(taskbarLyricsBounds(bounds, { ...bounds, y: 40, height: 1040 }, 320, 0), {
    x: -1920,
    y: 0,
    width: 320,
    height: 40
  })
})

test('auto-hidden taskbars use the bottom edge and widths cannot exceed the display', () => {
  const bounds = { x: 0, y: 0, width: 600, height: 800 }
  assert.deepEqual(taskbarLyricsBounds(bounds, bounds, 900, 110), {
    x: 0,
    y: 760,
    width: 600,
    height: 40
  })
})
