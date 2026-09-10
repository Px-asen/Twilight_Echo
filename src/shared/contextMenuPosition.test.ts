import test from 'node:test'
import assert from 'node:assert/strict'
import { contextMenuPosition } from './contextMenuPosition.ts'

test('menus preserve CSS cursor coordinates and stay within the viewport', () => {
  assert.deepEqual(contextMenuPosition(100, 150, 180, 200, 800, 600), { x: 100, y: 150 })
  assert.deepEqual(contextMenuPosition(790, 590, 180, 200, 800, 600), { x: 612, y: 392 })
  assert.deepEqual(contextMenuPosition(0, 0, 180, 200, 160, 160), { x: 8, y: 8 })
})
