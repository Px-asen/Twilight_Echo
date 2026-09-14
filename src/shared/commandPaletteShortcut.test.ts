import assert from 'node:assert/strict'
import test from 'node:test'
import { isCommandPaletteAccelerator, isCommandPaletteKey } from './commandPaletteShortcut.ts'

test('command palette reserves only the plain control or command K combination', () => {
  for (const value of ['CommandOrControl+K', 'Ctrl+K', 'Control+k', 'Cmd+K', 'Meta+K', 'K+Command'])
    assert.equal(isCommandPaletteAccelerator(value), true, value)
  for (const value of ['K', 'Alt+K', 'Ctrl+Shift+K', 'Ctrl+Alt+K', 'Control+J'])
    assert.equal(isCommandPaletteAccelerator(value), false, value)
  const key = {
    key: 'k',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false
  }
  assert.equal(isCommandPaletteKey(key), true)
  assert.equal(isCommandPaletteKey({ ...key, ctrlKey: false, metaKey: true }), true)
  for (const flag of ['metaKey', 'shiftKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented'])
    assert.equal(isCommandPaletteKey({ ...key, [flag]: true }), false, flag)
  assert.equal(isCommandPaletteKey({ ...key, keyCode: 229 }), false)
})
