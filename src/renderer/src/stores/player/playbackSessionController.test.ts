import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import type { PlaybackSession, Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { createPlaybackSessionController } from '@renderer/stores/player/playbackSessionController.ts'

const makeTrack = (id: string, queueEntryId?: string): Track => ({
  id,
  queueEntryId,
  title: id,
  artist: '',
  album: '',
  filePath: `${id}.flac`,
  fileName: `${id}.flac`,
  duration: 100,
  size: 1,
  cover: null,
  lyrics: null
})

function fixture() {
  const queue = shallowRef<Track[]>([])
  const originalQueue = shallowRef<Track[]>([])
  const currentTrack = shallowRef<Track | null>(null)
  const queueIndex = ref(-1)
  const playMode = ref<PlayMode>('shuffle')
  const currentTime = ref(0)
  const isPlaying = ref(true)
  const isLoading = ref(true)
  let resets = 0
  let pending = false
  let restoredPosition = 0
  const controller = createPlaybackSessionController({
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    playMode,
    currentTime,
    isPlaying,
    isLoading,
    duration: ref(0),
    sleepTimerState: ref(null),
    getAppSettings: () => {
      throw new Error('unused')
    },
    getSleepTimerController: () => {
      throw new Error('unused')
    },
    hydratePlaybackTrack: (track) => track,
    resetPlaybackRuntimeStateForRestore: () => {
      resets++
    },
    setPlayModeInternal: (mode) => {
      playMode.value = mode
    },
    loadLyricsForTrack: () => {},
    clearCrossfadeTimer: () => {},
    setCurrentTimeImmediate: (time) => {
      currentTime.value = time
    },
    clearSleepTimerIntervals: () => {},
    flushLatestCurrentTime: () => {},
    queueNativeQueueStateSync: async () => {},
    deleteAutomaticLyricsBaseline: () => {},
    getRestoredPlaybackPending: () => pending,
    setRestoredPlaybackPending: (value) => {
      pending = value
    },
    getRestoredPlaybackPosition: () => restoredPosition,
    setRestoredPlaybackPosition: (value) => {
      restoredPosition = value
    },
    getPendingLoadStartTime: () => 0,
    setPendingLoadStartTime: () => {},
    getAutoAdvanceInFlight: () => false,
    setAutoAdvanceInFlight: () => {},
    getAdvancingFromEndedTrackId: () => '',
    setAdvancingFromEndedTrackId: () => {},
    getNativePlaybackActive: () => false
  })
  function restore(track: Track, tracks: Track[], index: number) {
    const session: PlaybackSession = {
      version: 1,
      savedAt: new Date().toISOString(),
      mode: 'trackAndPosition',
      playMode: 'listLoop',
      track,
      queue: tracks,
      queueIndex: index,
      position: 25
    }
    controller.restorePlaybackSession(session)
  }
  return {
    restore,
    controller,
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    currentTime,
    playMode,
    isPlaying,
    isLoading,
    resets: () => resets,
    pending: () => pending,
    pendingPosition: () => restoredPosition,
    seekDuringLoad: (position: number) => {
      pending = true
      restoredPosition = position
    }
  }
}

test('automatic restore selects the saved duplicate occurrence instead of an obsolete numeric index', () => {
  const state = fixture()
  const first = makeTrack('same', 'first')
  const second = makeTrack('same', 'second')
  state.restore(second, [makeTrack('other', 'other'), first, second], 0)
  assert.equal(state.queueIndex.value, 2)
  assert.equal(state.currentTrack.value?.queueEntryId, 'second')
  assert.equal(state.currentTime.value, 25)
  assert.equal(state.playMode.value, 'listLoop')
  assert.equal(state.isPlaying.value, false)
  assert.equal(state.isLoading.value, false)
  assert.equal(state.pending(), true)
  assert.equal(state.resets(), 1)
  assert.deepEqual(state.originalQueue.value, state.queue.value)
})

test('legacy sessions reject fractional or mismatched indices and match the saved track identity', () => {
  const state = fixture()
  const track = makeTrack('saved')
  const tracks = [makeTrack('other'), track, track]
  for (const index of [0.5, -1, Number.NaN, 99, 0]) {
    state.restore(track, tracks, index)
    assert.equal(state.queueIndex.value, 1)
    assert.equal(state.currentTrack.value?.id, 'saved')
    assert.equal(state.currentTime.value, 25)
  }
  state.restore(track, tracks, 2)
  assert.equal(state.queueIndex.value, 2)
  assert.equal(state.currentTrack.value?.queueEntryId, state.queue.value[2].queueEntryId)
})

test('missing restored selections reset position and preparing an empty queue clears the cursor', () => {
  const state = fixture()
  state.restore(makeTrack('missing', 'missing'), [makeTrack('other', 'other')], 0)
  assert.equal(state.currentTrack.value?.id, 'other')
  assert.equal(state.currentTime.value, 0)
  state.restore(makeTrack('same', 'removed'), [makeTrack('same', 'surviving')], 0)
  assert.equal(state.currentTrack.value?.queueEntryId, 'surviving')
  assert.equal(state.currentTime.value, 0)
  state.controller.prepareQueueSelection(null)
  assert.equal(state.currentTrack.value, null)
  assert.equal(state.pending(), false)
  assert.equal(state.isPlaying.value, false)
})

test('automatic restore strips stale provider URLs from both the queue and selected track', () => {
  const state = fixture()
  const track = {
    ...makeTrack('ncm:1', 'entry'),
    source: 'ncm',
    streamUrl: 'https://expired.test/song'
  }
  state.restore(track, [track], 0)
  assert.equal(state.queue.value[0].streamUrl, null)
  assert.equal(state.currentTrack.value?.streamUrl, null)
  assert.equal(state.currentTrack.value?.queueEntryId, 'entry')
})

test('playing another song after a paused session restore does not inherit its position', () => {
  for (const startTime of [0, 12]) {
    const state = fixture()
    const saved = makeTrack('saved')
    const next = makeTrack('next')
    state.restore(saved, [saved, next], 0)
    state.currentTrack.value = next
    state.controller.clearPendingPlaybackPosition()
    assert.equal(state.controller.consumePendingPlaybackPosition(next, startTime), startTime)
    assert.equal(state.pending(), false)
    assert.equal(state.pendingPosition(), 0)
  }
})

test('resuming the restored song keeps its explicitly requested starting position', () => {
  const state = fixture()
  const saved = makeTrack('saved')
  state.restore(saved, [saved], 0)
  const startTime = state.pendingPosition()
  state.controller.clearPendingPlaybackPosition()
  assert.equal(state.controller.consumePendingPlaybackPosition(saved, startTime), 25)
})

test('seeking during a load overrides its start but is discarded when another load begins', () => {
  const state = fixture()
  const track = makeTrack('saved')
  state.restore(track, [track], 0)
  state.controller.clearPendingPlaybackPosition()
  state.seekDuringLoad(40)
  assert.equal(state.controller.consumePendingPlaybackPosition(track, 25), 40)
  assert.equal(state.controller.consumePendingPlaybackPosition(track, 0), 0)
  state.seekDuringLoad(60)
  state.controller.clearPendingPlaybackPosition()
  assert.equal(state.controller.consumePendingPlaybackPosition(makeTrack('next'), 0), 0)
})
