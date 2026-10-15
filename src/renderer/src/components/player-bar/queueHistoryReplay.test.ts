import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { Track } from '../../types/music'
import type { PlaybackOrderEntry } from '../../../../shared/queueWorkspace.ts'
import type { QueueSessionRestoreSources } from '../../stores/player/queueSessionRestore.ts'
import { saveQueueTrack } from '../../utils/queueSessionTrack.ts'
import { createQueueHistoryReplay } from './queueHistoryReplay.ts'

const track = (id: string, entryId: string): Track => ({
  id,
  queueEntryId: entryId,
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  filePath: `C:/music/${id}.flac`,
  fileName: `${id}.flac`,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  queuePlaybackOrigin: { scope: 'local', kind: 'album', id: 'album-1', name: 'Album' }
})
function fixture(t: { after: (cleanup: () => void) => void }) {
  const saved = track('duplicate', 'old-occurrence')
  const current = track('duplicate', 'current-occurrence')
  const queue = ref([current, track('pending', 'pending-occurrence')])
  const currentEntryId = ref(current.queueEntryId)
  const history = ref<PlaybackOrderEntry[]>([
    {
      id: 'event-1',
      playedAt: '2026-10-13T08:00:00Z',
      track: saveQueueTrack(saved),
      playMode: 'heart'
    }
  ])
  let available = true
  let sequence = 0
  let additions = 0
  const played: Track[] = []
  const notices: string[] = []
  const sources: Omit<QueueSessionRestoreSources, 'isCurrent'> = {
    localTracks: new Map([[saved.id, { ...saved, title: 'Updated library title' }]]),
    savedStreams: new Map(),
    availableProviders: new Set(),
    networkProfiles: new Set(),
    authorizeFiles: async (paths) => paths.map(() => true)
  }
  let getSources = async () => sources
  const controller = createQueueHistoryReplay({
    queue,
    history,
    currentEntryId: () => currentEntryId.value,
    isAvailable: () => available,
    getSources: () => getSources(),
    playNextTrack: (item) => {
      additions++
      queue.value = [
        queue.value[0],
        { ...item, queueEntryId: `new-occurrence-${++sequence}` },
        ...queue.value.slice(1)
      ]
    },
    playTrack: (item) => played.push(item),
    onUnavailable: (message) => notices.push(message)
  })
  t.after(controller.dispose)
  return {
    queue,
    currentEntryId,
    history,
    controller,
    played,
    notices,
    sources,
    additions: () => additions,
    close: () => {
      available = false
    },
    setSources: (factory: typeof getSources) => {
      getSources = factory
    }
  }
}

test('history replay resolves current library metadata and preserves pending duplicate occurrences', async (t) => {
  const f = fixture(t)
  await f.controller.replay('event-1')
  assert.deepEqual(
    f.queue.value.map((item) => item.queueEntryId),
    ['current-occurrence', 'new-occurrence-1', 'pending-occurrence']
  )
  assert.equal(f.played[0].queueEntryId, 'new-occurrence-1')
  assert.equal(f.played[0].title, 'Updated library title')
  assert.deepEqual(f.played[0].queuePlaybackOrigin, f.history.value[0].track.queuePlaybackOrigin)
  assert.equal(f.history.value[0].playMode, 'heart')
  assert.equal(f.controller.loading.value, false)
})

test('an unavailable or unauthorized history track leaves the queue intact', async (t) => {
  const f = fixture(t)
  f.sources.authorizeFiles = async (paths) => paths.map(() => false)
  const before = f.queue.value
  await f.controller.replay('event-1')
  assert.equal(f.queue.value, before)
  assert.equal(f.additions(), 0)
  assert.equal(f.played.length, 0)
  assert.match(f.notices[0], /未获授权/)
})

test('queue changes and sidebar closure cancel an asynchronous history replay', async (t) => {
  for (const cancel of ['queue', 'closed', 'explicit']) {
    const f = fixture(t)
    let finish!: (value: typeof f.sources) => void
    f.setSources(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = f.controller.replay('event-1')
    if (cancel === 'queue') f.queue.value = [...f.queue.value]
    if (cancel === 'closed') f.close()
    if (cancel === 'explicit') f.controller.cancel()
    finish(f.sources)
    await pending
    assert.equal(f.additions(), 0)
    assert.equal(f.played.length, 0)
    assert.equal(f.notices.length, 0)
    assert.equal(f.controller.loading.value, false)
  }
})

test('a newer history request wins even if an earlier lookup finishes later', async (t) => {
  const f = fixture(t)
  let finish!: (value: typeof f.sources) => void
  f.setSources(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = f.controller.replay('event-1')
  f.setSources(async () => f.sources)
  await f.controller.replay('event-1')
  finish(f.sources)
  await first
  assert.equal(f.additions(), 1)
  assert.equal(f.played.length, 1)
})

test('a removed provider cannot be replayed from a saved history identity', async (t) => {
  const f = fixture(t)
  f.history.value[0].track.source = 'removed-provider'
  await f.controller.replay('event-1')
  assert.equal(f.additions(), 0)
  assert.equal(f.played.length, 0)
  assert.match(f.notices[0], /音源/)
})

test('manual navigation away and back cannot revive an earlier history replay', async (t) => {
  const f = fixture(t)
  const originalQueue = f.queue.value
  let finish!: (value: typeof f.sources) => void
  f.setSources(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = f.controller.replay('event-1')
  f.currentEntryId.value = 'pending-occurrence'
  f.currentEntryId.value = 'current-occurrence'
  finish(f.sources)
  await pending
  assert.equal(f.queue.value, originalQueue)
  assert.equal(f.additions(), 0)
  assert.equal(f.played.length, 0)
  assert.equal(f.notices.length, 0)
  assert.equal(f.controller.loading.value, false)
})
