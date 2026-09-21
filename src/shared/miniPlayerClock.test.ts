import assert from 'node:assert/strict'
import test from 'node:test'
import { EMPTY_MINI_PLAYER_STATE } from './miniPlayer.ts'
import { estimateMiniPlayerTime } from './miniPlayerClock.ts'

test('mini player projects snapshot time with rate and reanchors without accumulating drift', () => {
  const state = {
    ...EMPTY_MINI_PLAYER_STATE,
    isPlaying: true,
    currentTime: 10,
    duration: 100,
    playbackRate: 1.5,
    capturedAtMs: 1000
  }
  assert.equal(estimateMiniPlayerTime(state, 1500, 1200), 10.75)
  assert.equal(
    estimateMiniPlayerTime({ ...state, currentTime: 11.5, capturedAtMs: 2000 }, 2500, 2200),
    12.25
  )
  assert.equal(estimateMiniPlayerTime({ ...state, isPlaying: false }, 1500, 1200), 10)
  assert.equal(estimateMiniPlayerTime({ ...state, isLoading: true }, 1500, 1200), 10)
})

test('mini player stops extrapolating stale data and respects seeking and end of track', () => {
  const state = {
    ...EMPTY_MINI_PLAYER_STATE,
    isPlaying: true,
    currentTime: 20,
    duration: 100,
    capturedAtMs: 1000
  }
  assert.equal(estimateMiniPlayerTime(state, 600000, 1000), 22)
  assert.equal(
    estimateMiniPlayerTime({ ...state, currentTime: 4, capturedAtMs: 600000 }, 600100, 600000),
    4.1
  )
  assert.equal(estimateMiniPlayerTime({ ...state, currentTime: 99 }, 2500, 1000), 100)
  assert.equal(estimateMiniPlayerTime(state, 900, 1000), 20)
})
