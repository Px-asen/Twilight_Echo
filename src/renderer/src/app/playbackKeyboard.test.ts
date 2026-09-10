import test from 'node:test'
import assert from 'node:assert/strict'
import { isPlaybackSpace } from './playbackKeyboard.ts'

test('plain Space controls playback while inputs, buttons, repeat and composition retain their keys', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  class Element {
    interactive: boolean
    constructor(interactive = false) {
      this.interactive = interactive
    }
    closest(): object | null {
      return this.interactive ? {} : null
    }
  }
  Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true })
  const space = { code: 'Space', target: new Element() } as unknown as KeyboardEvent
  try {
    assert.equal(isPlaybackSpace(space), true)
    assert.equal(
      isPlaybackSpace({ ...space, target: new Element(true) } as unknown as KeyboardEvent),
      false
    )
    for (const key of [
      'repeat',
      'isComposing',
      'defaultPrevented',
      'ctrlKey',
      'altKey',
      'metaKey',
      'shiftKey'
    ]) {
      assert.equal(isPlaybackSpace({ ...space, [key]: true }), false)
    }
    assert.equal(isPlaybackSpace({ ...space, code: 'Enter' }), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'HTMLElement', previous)
    else Reflect.deleteProperty(globalThis, 'HTMLElement')
  }
})
