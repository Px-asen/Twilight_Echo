import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import {
  createPlaybackQueueController,
  type PersonalizedStreamSession
} from './playbackQueueController.ts'
import { toPlaybackQueueSnapshots } from '@renderer/utils/playbackQueueVirtualization.ts'

test('queue facade persists and synchronizes final selection, and personalized appends use fresh IDs', (t) => {
  const song = {
    id: 'song',
    title: 'Song',
    artist: '',
    album: '',
    filePath: 'song.flac',
    fileName: 'song',
    duration: 120,
    size: 0,
    cover: null,
    lyrics: null
  } as Track
  const queue = shallowRef(toPlaybackQueueSnapshots([song, song]))
  const currentTrack = shallowRef<Track | null>(queue.value[1])
  const queueIndex = ref(1)
  const originalQueue = shallowRef([...queue.value])
  const isPlaying = ref(true)
  const personalizedStreamSession = ref<PersonalizedStreamSession | null>(null)
  const personalizedStreamRemaining = ref(0)
  const synchronized: Array<{ index: number; current: string | null; length: number }> = []
  let saves = 0
  const controller = createPlaybackQueueController({
    queue,
    currentTrack,
    queueIndex,
    originalQueue,
    isPlaying,
    playMode: ref<PlayMode>('shuffle'),
    personalizedStreamSession,
    personalizedStreamRemaining,
    personalizedStreamEntryIds: new Set(),
    personalizedStreamPlayedEntryIds: new Set(),
    rendererPlayModeBoundaryPending: ref(false),
    persistPlaybackSessionAfterQueueMutation: () => {
      saves++
    },
    queueNativeQueueStateSync: async () => {
      synchronized.push({
        index: queueIndex.value,
        current: currentTrack.value?.queueEntryId ?? null,
        length: queue.value.length
      })
    },
    setAudioEngineError: () => assert.fail('unexpected sync error'),
    clearAutomaticLyricsBaselines: () => {},
    getPosition: () => 15,
    prepareSelection: (track) => {
      currentTrack.value = track
      isPlaying.value = false
    },
    exitHeartModeForQueueEdit: () => {}
  })
  t.after(controller.commands.dispose)
  controller.playNextTrack(queue.value[1])
  assert.equal(new Set(queue.value.map((track) => track.queueEntryId)).size, 3)
  assert.equal(queueIndex.value, 1)
  controller.commands.undo()
  const stream = controller.startPersonalizedStream('fm')
  assert.equal(controller.appendPersonalizedStreamTracks(stream, [song]), true)
  assert.equal(new Set(queue.value.map((track) => track.queueEntryId)).size, 3)
  assert.equal(controller.commands.canUndo.value, false)
  controller.clearQueue()
  assert.deepEqual(synchronized.at(-1), { index: -1, current: null, length: 0 })
  assert.equal(isPlaying.value, false)
  assert.equal(saves, 4)
  assert.equal(controller.appendPersonalizedStreamTracks(stream, [song]), false)
  controller.commands.undo()
  assert.equal(queue.value.length, 3)
  assert.equal(isPlaying.value, false)
})
