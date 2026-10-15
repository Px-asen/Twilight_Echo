import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { Track } from '../../types/music.ts'
import {
  createPlaybackQueueDisplayItems,
  getPlaybackQueueWindow
} from '../../utils/playbackQueueVirtualization.ts'
import { usePlaybackQueueDrawerActions } from './usePlaybackQueueDrawerActions.ts'

function track(index: number): Track {
  return {
    id: `local:${Math.floor(index / 2)}`,
    queueEntryId: `entry:${index}`,
    title: `Track ${index}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `E:\\Music\\${index}.flac`,
    fileName: `${index}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

function createDataTransfer(): DataTransfer {
  let value = ''
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(_format: string, next: string) {
      value = next
    },
    getData() {
      return value
    }
  } as unknown as DataTransfer
}

function dragEvent(dataTransfer: DataTransfer): DragEvent {
  return {
    dataTransfer,
    preventDefault() {}
  } as unknown as DragEvent
}

test('virtual queue drawer resolves drag source and target by stable IDs after its visible window shifts', () => {
  const queue = ref(Array.from({ length: 20_000 }, (_, index) => track(index)))
  const visible = createPlaybackQueueDisplayItems(
    queue.value,
    getPlaybackQueueWindow(20_000, 10_000 * 54, 324)
  )
  const source = visible.find((item) => item.queueEntryId === 'entry:10000')
  const target = visible.find((item) => item.queueEntryId === 'entry:10005')
  assert.ok(source)
  assert.ok(target)

  const reorders: Array<[number, number]> = []
  const actions = usePlaybackQueueDrawerActions({
    queue,
    commands: {
      enqueueTrack() {},
      playNextTrack() {},
      removeQueueItem() {},
      clearQueue() {},
      reorderQueue(from, to) {
        reorders.push([from, to])
      },
      saveQueueAsPlaylist() {
        return 'playlist-id'
      }
    },
    createPlaylistWithTracks() {
      return 'playlist-id'
    }
  })

  const transfer = createDataTransfer()
  actions.onDragStart(dragEvent(transfer), source.queueEntryId)
  // A queue update while dragging changes every mounted row's index. Drop must
  // resolve the stable source/target identities from the current queue.
  queue.value = queue.value.slice(1)
  actions.onDrop(dragEvent(transfer), target.queueEntryId)

  assert.deepEqual(reorders, [[9_999, 10_004]])
  assert.equal(actions.draggedEntryId.value, null)
})

test('drawer queue commands target duplicate tracks by entry identity and save a named snapshot', () => {
  const queue = ref([track(0), track(1), track(2)])
  const calls: string[] = []
  const actions = usePlaybackQueueDrawerActions({
    queue,
    commands: {
      enqueueTrack(entry) {
        calls.push(`tail:${entry.queueEntryId}`)
      },
      playNextTrack(entry) {
        calls.push(`next:${entry.queueEntryId}`)
      },
      removeQueueItem(index) {
        calls.push(`remove:${index}`)
      },
      clearQueue() {
        calls.push('clear')
      },
      reorderQueue() {},
      saveQueueAsPlaylist(name, create) {
        calls.push(`save:${name}:${create(name, queue.value)}`)
        return 'playlist-id'
      }
    },
    createPlaylistWithTracks() {
      return 'created'
    }
  })

  actions.playNext('entry:1')
  actions.addToTail('entry:1')
  actions.remove('entry:1')
  assert.equal(actions.saveAsPlaylist('  My Queue  '), 'playlist-id')
  actions.clear()

  assert.deepEqual(calls, [
    'next:entry:1',
    'tail:entry:1',
    'remove:1',
    'save:My Queue:created',
    'clear'
  ])
  assert.equal(actions.saveAsPlaylist('   '), null)
})

test('keyboard moves resolve the current occurrence and respect queue boundaries', () => {
  const queue = ref([track(0), track(1), track(2)])
  const reorders: Array<[number, number]> = []
  const actions = usePlaybackQueueDrawerActions({
    queue,
    commands: {
      enqueueTrack() {},
      playNextTrack() {},
      removeQueueItem() {},
      clearQueue() {},
      reorderQueue(from, to) {
        reorders.push([from, to])
      },
      saveQueueAsPlaylist() {
        return 'playlist-id'
      }
    },
    createPlaylistWithTracks() {
      return 'playlist-id'
    }
  })

  actions.move('entry:0', -1)
  actions.move('entry:2', 1)
  actions.move('missing', 1)
  // Duplicate track IDs still address their independent queue occurrences.
  actions.move('entry:1', -1)
  queue.value = [track(2), track(0), track(1)]
  actions.move('entry:1', -1)
  actions.move('entry:0', 1)

  assert.deepEqual(reorders, [
    [1, 0],
    [2, 1],
    [1, 2]
  ])
})
