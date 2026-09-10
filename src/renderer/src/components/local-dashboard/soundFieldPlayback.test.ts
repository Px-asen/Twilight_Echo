import assert from 'node:assert/strict'
import test from 'node:test'
import { usesSoundFieldSidebar } from './soundFieldPlayback.ts'

test('sound field sidebar replaces only the wide local dashboard player', () => {
  assert.equal(usesSoundFieldSidebar(true, true, 'dashboard', false, false), true)
  assert.equal(usesSoundFieldSidebar(false, true, 'dashboard', false, false), false)
  assert.equal(usesSoundFieldSidebar(true, true, 'allSongs', false, false), false)
  assert.equal(usesSoundFieldSidebar(true, false, 'dashboard', false, false), false)
})

test('streaming and lyrics retain their own player bar presentation', () => {
  for (const local of [true, false]) {
    assert.equal(usesSoundFieldSidebar(true, local, 'dashboard', true, false), false)
    assert.equal(usesSoundFieldSidebar(true, local, 'dashboard', false, true), false)
    assert.equal(usesSoundFieldSidebar(true, local, 'dashboard', true, true), false)
  }
})
