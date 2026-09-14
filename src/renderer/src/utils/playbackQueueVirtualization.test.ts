import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import type { Track } from '../types/music'
import {
  createPlaybackQueueDisplayItems,
  getPlaybackQueueScrollTopForIndex,
  getPlaybackQueueWindow,
  toPlaybackQueueSnapshot,
  toPlaybackQueueSnapshots
} from './playbackQueueVirtualization.ts'
import { usePlaybackQueueVirtualScroll } from '../components/player-bar/usePlaybackQueueVirtualScroll.ts'

function track(index: number, lyrics = 'long lyric payload'): Track {
  return {
    id: `local:${index}`,
    title: `Track ${index}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `E:\\Music\\${index}.flac`,
    fileName: `${index}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics,
    translatedLyrics: lyrics,
    metadataMatch: { providerId: 'ncm', trackId: String(index), confidence: 'high', score: 1 },
    source: 'local'
  }
}

test('playback queue snapshots retain routing metadata while dropping lyric and match payloads', () => {
  const snapshot = toPlaybackQueueSnapshot(track(1))

  assert.equal(snapshot.id, 'local:1')
  assert.equal(snapshot.filePath, 'E:\\Music\\1.flac')
  assert.equal(snapshot.lyrics, null)
  assert.equal(snapshot.translatedLyrics, undefined)
  assert.equal(snapshot.metadataMatch, undefined)
  assert.equal(snapshot.bpmAnalysis, undefined)
})

test('queue snapshots keep a unique stable entry identity for duplicate tracks through reordering', () => {
  const snapshots = toPlaybackQueueSnapshots([track(1), track(1)])
  assert.notEqual(snapshots[0]?.queueEntryId, snapshots[1]?.queueEntryId)

  const reordered = toPlaybackQueueSnapshots([snapshots[1]!, snapshots[0]!])
  assert.equal(reordered[0]?.queueEntryId, snapshots[1]?.queueEntryId)
  assert.equal(reordered[1]?.queueEntryId, snapshots[0]?.queueEntryId)
})

test('virtual queue window mounts only bounded rows at 5k and 20k positions', () => {
  for (const total of [5_000, 20_000]) {
    const window = getPlaybackQueueWindow(total, (total - 1) * 54, 324)
    assert.equal(window.end, total)
    assert.ok(window.end - window.start <= 18)
  }
})

test('virtual queue renders compact display records only for its visible range', () => {
  const queue = Array.from({ length: 20_000 }, (_, index) => track(index, 'x'.repeat(16_384)))
  const window = getPlaybackQueueWindow(queue.length, 10_000 * 54, 324)
  const items = createPlaybackQueueDisplayItems(queue, window)

  assert.ok(items.length <= 18)
  assert.equal(items[0]?.index, window.start)
  assert.deepEqual(Object.keys(items[0] ?? {}).sort(), [
    'artist',
    'cover',
    'id',
    'index',
    'queueEntryId',
    'title'
  ])
})

test('current queue item is centered without scrolling past either end', () => {
  assert.equal(getPlaybackQueueScrollTopForIndex(0, 5_000, 324), 0)
  assert.equal(getPlaybackQueueScrollTopForIndex(4_999, 5_000, 324), 5_000 * 54 - 324)
  assert.equal(getPlaybackQueueScrollTopForIndex(2, 5_000, 324), 0)
})

test('production virtual-scroll composable reveals the current item in a 20k queue', async () => {
  const queue = ref(Array.from({ length: 20_000 }, (_, index) => track(index)))
  const queueIndex = ref(10_000)
  const open = ref(false)
  const virtualScroll = usePlaybackQueueVirtualScroll(queue, queueIndex, open)
  const container = { clientHeight: 324, scrollTop: 0 } as unknown as HTMLElement
  virtualScroll.containerRef.value = container

  open.value = true
  await nextTick()
  await nextTick()

  assert.ok(container.scrollTop > 0)
  assert.ok(virtualScroll.visibleItems.value.some((item) => item.index === 10_000))
  assert.ok(virtualScroll.visibleItems.value.length <= 18)
})

test('player drawer iterates only the virtual queue window and wires current-item reveal', () => {
  const source = readFileSync(new URL('../components/PlayerBar.vue', import.meta.url), 'utf8')

  assert.match(source, /usePlaybackQueueVirtualScroll\(queue, queueIndex, playlistOpen\)/)
  assert.match(source, /v-for="item in visibleQueueItems"/)
  assert.match(source, /class="playlist-virtual-spacer"/)
  assert.match(source, /@scroll\.passive="onQueueScroll"/)
  assert.match(source, /:key="item\.queueEntryId"/)
  assert.match(source, /@drop="onQueueDrop\(\$event, item\.queueEntryId\)"/)
  assert.doesNotMatch(source, /v-for="\(track, i\) in queue"/)
  assert.doesNotMatch(source, /Play Queue/)
})

test('player queue state uses shallow snapshots and revision-fenced native synchronization', () => {
  const source = readFileSync(new URL('../stores/usePlayerStore.ts', import.meta.url), 'utf8')
  const selectionSource = readFileSync(
    new URL('../stores/player/playbackSelectionController.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /const queue = shallowRef<Track\[\]>\(\[\]\)/)
  assert.match(source, /const originalQueue = shallowRef<Track\[\]>\(\[\]\)/)
  assert.match(selectionSource, /toPlaybackQueueSnapshots\(trackList\)/)
  assert.match(source, /const nativeQueueRevisionFence = new NativeQueueRevisionFence\(\)/)
  assert.match(source, /const snapshot = captureNativeQueueState\(revision\)/)
  assert.match(source, /if \(!nativeQueueRevisionFence\.isCurrent\(snapshot\.revision\)\) return/)
})
