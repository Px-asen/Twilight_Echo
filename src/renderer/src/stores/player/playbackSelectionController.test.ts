import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { createPlaybackSelectionController } from './playbackSelectionController.ts'

test('selection carries the exact duplicate queue entry into playback and replaces unrelated direct selections', () => {
  const queue = shallowRef<Track[]>([])
  const queueIndex = ref(-1)
  let activated: Track | undefined
  let loaded: Track | undefined
  let replaced = 0
  const controller = createPlaybackSelectionController({
    queue,
    queueIndex,
    playMode: ref<PlayMode>('shuffle'),
    setHeartModeContext: () => {},
    exitHeartModeForManualQueueReplacement: () => {},
    isPersonalizedStreamTrack: () => false,
    endPersonalizedStream: () => {},
    activateCurrentTrack: (track) => {
      activated = track
    },
    loadAndPlay: async (track) => {
      loaded = track
    },
    replaceQueue: (tracks, index) => {
      queue.value = tracks
      queueIndex.value = index
      replaced++
    }
  })
  const first = {
    id: 'same',
    title: 'first',
    artist: '',
    album: '',
    filePath: 'a.flac',
    fileName: 'a.flac',
    duration: 100,
    size: 0,
    cover: null,
    lyrics: null
  }
  const second = { ...first, title: 'second' }
  controller.playTrack(second, [first, second])
  assert.equal(activated?.title, 'second')
  assert.equal(loaded?.queueEntryId, queue.value[queueIndex.value].queueEntryId)
  assert.notEqual(
    loaded?.queueEntryId,
    queue.value.find((track) => track.title === 'first')?.queueEntryId
  )
  const other = queue.value.find((track) => track.title === 'first')!
  controller.playTrack(other)
  assert.equal(queue.value[queueIndex.value].queueEntryId, other.queueEntryId)
  assert.equal(replaced, 1)
  controller.playTrack({ ...first, id: 'outside' })
  assert.equal(queue.value.length, 1)
  assert.equal(loaded?.id, 'outside')
  assert.equal(replaced, 2)
})
