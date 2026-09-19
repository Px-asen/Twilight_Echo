import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import type { Track } from '@renderer/types/music'
import type { PlayMode } from '@renderer/types/settings'
import { toPlaybackQueueSnapshots } from '@renderer/utils/playbackQueueVirtualization.ts'
import { createQueueCommandController, MAX_QUEUE_UNDO_ENTRIES } from './queueCommandController.ts'

const track = (id: string): Track => ({
  id,
  title: id,
  artist: 'Artist',
  album: '',
  filePath: `${id}.flac`,
  fileName: `${id}.flac`,
  source: 'local',
  duration: 100,
  size: 1,
  cover: null,
  lyrics: 'large lyrics'.repeat(100)
})

function harness(tracks = [track('a'), track('a'), track('b')]) {
  const queue = shallowRef(toPlaybackQueueSnapshots(tracks))
  const originalQueue = shallowRef([...queue.value])
  const queueIndex = ref(1)
  const currentTrack = shallowRef<Track | null>(queue.value[1] ?? null)
  const playMode = ref<PlayMode>('sequential')
  let position = 45
  let playing = true
  const commits: Array<{ current: string | null; index: number; length: number }> = []
  const commands = createQueueCommandController({
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    playMode,
    getPosition: () => position,
    prepareSelection: (track, time) => {
      currentTrack.value = track
      position = time
      playing = false
    },
    onMutation: () =>
      commits.push({
        current: currentTrack.value?.queueEntryId ?? null,
        index: queueIndex.value,
        length: queue.value.length
      })
  })
  return {
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    playMode,
    commands,
    commits,
    position: () => position,
    playing: () => playing
  }
}

test('duplicate additions get new entry IDs without cloning existing queue objects and undo rebases prior commands', (t) => {
  const state = harness()
  t.after(state.commands.dispose)
  const original = state.queue.value
  state.commands.add([original[1]], 3, 3)
  const firstRevision = state.commands.revision.value
  assert.equal(new Set(state.queue.value.map((item) => item.queueEntryId)).size, 4)
  assert.strictEqual(state.queue.value[1], original[1])
  assert.equal(state.queue.value[3].lyrics, null)
  state.commands.remove(0)
  assert.equal(state.queueIndex.value, 0)
  assert.equal(state.currentTrack.value?.queueEntryId, original[1].queueEntryId)
  assert.equal(state.commands.undo(firstRevision), false)
  assert.equal(state.commands.undo(), true)
  assert.deepEqual(state.queue.value.slice(0, 3), original)
  assert.equal(state.commands.undo(), true)
  assert.deepEqual(state.queue.value, original)
  assert.equal(state.commands.canUndo.value, false)
  assert.equal(state.playing(), true)
})

test('removing current prepares its successor paused; clear persists empty state and undo restores a paused cursor', (t) => {
  const state = harness()
  t.after(state.commands.dispose)
  const successor = state.queue.value[2]
  state.commands.remove(1)
  assert.equal(state.playing(), false)
  assert.equal(state.currentTrack.value?.queueEntryId, successor.queueEntryId)
  assert.equal(state.queueIndex.value, 1)
  state.commands.undo()
  assert.equal(state.currentTrack.value?.queueEntryId, successor.queueEntryId)
  assert.equal(state.queueIndex.value, 2)
  state.commands.replace([], -1)
  assert.deepEqual(state.commits.at(-1), { current: null, index: -1, length: 0 })
  assert.equal(state.commands.undo(), true)
  assert.equal(state.currentTrack.value?.queueEntryId, successor.queueEntryId)
  assert.equal(state.queueIndex.value, 2)
  assert.equal(state.playing(), false)
})

test('replace undo returns to the saved entry and position, while moves preserve both queue orders', (t) => {
  const state = harness()
  t.after(state.commands.dispose)
  const original = state.originalQueue.value
  state.commands.move(1, 2)
  assert.equal(state.queueIndex.value, 2)
  state.commands.undo()
  assert.deepEqual(state.originalQueue.value, original)
  assert.equal(state.queueIndex.value, 1)
  state.commands.replace(toPlaybackQueueSnapshots([track('new')]), 0)
  state.commands.undo()
  assert.equal(state.currentTrack.value?.queueEntryId, original[1].queueEntryId)
  assert.equal(state.queueIndex.value, 1)
  assert.equal(state.position(), 45)
  assert.equal(state.playing(), false)
})

test('external queue replacement and mode changes invalidate undo; metadata refreshes remain intact', (t) => {
  const state = harness()
  t.after(state.commands.dispose)
  state.commands.add([track('extra')], 3, 3)
  state.queue.value = state.queue.value.map((item, index) =>
    index === 0 ? { ...item, title: 'updated' } : item
  )
  assert.equal(state.commands.undo(), true)
  assert.equal(state.queue.value[0].title, 'updated')
  state.commands.add([track('extra')], 3, 3)
  state.queue.value = [...state.queue.value].reverse()
  assert.equal(state.commands.canUndo.value, false)
  const replacement = state.queue.value
  assert.equal(state.commands.undo(), false)
  assert.strictEqual(state.queue.value, replacement)
  state.commands.add([track('next')], 4, 4)
  state.playMode.value = 'shuffle'
  assert.equal(state.commands.canUndo.value, false)
})

test('20,000-entry queues retain bounded deltas and bounded replacement snapshots', (t) => {
  const state = harness(Array.from({ length: 20_000 }, (_, index) => track(`track:${index}`)))
  t.after(state.commands.dispose)
  const retainedTrack = state.queue.value[15_000]
  for (let index = 0; index < 30; index++) state.commands.move(100, 200)
  assert.equal(state.commands.undoStack.value.length, 20)
  assert.strictEqual(state.queue.value[15_000], retainedTrack)
  assert.equal(
    state.commands.undoStack.value.reduce((sum, item) => sum + item.retained, 0),
    20
  )
  for (let index = 0; index < 4; index++)
    state.commands.replace([...state.queue.value].reverse(), 0)
  assert.ok(
    state.commands.undoStack.value.reduce((sum, item) => sum + item.retained, 0) <=
      MAX_QUEUE_UNDO_ENTRIES
  )
  assert.equal(state.commands.undoStack.value.length, 2)
  assert.equal(state.commands.undo(), true)
  assert.equal(state.commands.undo(), true)
  assert.equal(state.commands.undo(), false)
})

test('automatic personalized append invalidates old undo without losing distinct entries', (t) => {
  const state = harness()
  t.after(state.commands.dispose)
  state.commands.add([track('a')], 3, 3)
  state.commands.add([track('a')], 4, 4, { undoable: false })
  assert.equal(new Set(state.queue.value.map((item) => item.queueEntryId)).size, 5)
  assert.equal(state.commands.undo(), false)
})
