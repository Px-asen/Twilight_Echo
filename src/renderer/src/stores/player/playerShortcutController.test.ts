import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchPlayerShortcut } from './playerShortcutController.ts'

test('volume shortcuts clamp and do not toggle playback; play and pause are idempotent', async () => {
  let volume = 0.98
  let playing = true
  let toggles = 0
  const controls = {
    previous: () => {},
    next: () => {},
    isPlaying: () => playing,
    togglePlay: async () => {
      toggles++
      playing = !playing
    },
    toggleLyrics: async () => {},
    toggleLyricsLock: async () => {},
    seek: () => {},
    getVolume: () => volume,
    setVolume: (value: number) => {
      volume = value
    },
    jumpQueue: () => {}
  }
  await dispatchPlayerShortcut('volumeUp', controls)
  assert.equal(volume, 1)
  volume = 0.02
  await dispatchPlayerShortcut('volumeDown', controls)
  assert.equal(volume, 0)
  assert.equal(toggles, 0)
  await dispatchPlayerShortcut('play', controls)
  assert.equal(toggles, 0)
  await dispatchPlayerShortcut('pause', controls)
  await dispatchPlayerShortcut('pause', controls)
  assert.equal(toggles, 1)
})
