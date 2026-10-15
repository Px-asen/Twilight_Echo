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
  toPlaybackQueueSnapshots,
  createPlaybackQueueSnapshotCache,
  patchPlaybackQueueTrack
} from './playbackQueueVirtualization.ts'
import { usePlaybackQueueVirtualScroll } from '../components/player-bar/usePlaybackQueueVirtualScroll.ts'

test('queue patches preserve versions for transient/equivalent metadata and update all duplicate entries when meaningful fields change', () => {
  const selected: Track = {
    ...track(1),
    artists: [{ id: 1, name: 'Artist' }],
    cueRange: { startSeconds: 1, endSeconds: 181, pregapSeconds: 0 }
  }
  const queue = toPlaybackQueueSnapshots([selected, track(2), selected])
  const equivalent = {
    ...selected,
    artists: selected.artists!.map((artist) => ({ ...artist })),
    cueRange: { ...selected.cueRange! },
    lyrics: 'new lyrics',
    bpmAnalysis: {
      bpm: 120,
      confidence: 0.9,
      source: 'analyzed' as const,
      analyzedAt: 'today',
      algorithmVersion: 1
    }
  }
  assert.equal(patchPlaybackQueueTrack(queue, equivalent), queue)
  const changed = patchPlaybackQueueTrack(queue, {
    ...equivalent,
    title: 'Renamed',
    cueRange: { ...equivalent.cueRange, endSeconds: 170 }
  })
  assert.notEqual(changed, queue)
  assert.equal(changed[1], queue[1])
  for (const index of [0, 2]) {
    assert.equal(changed[index].queueEntryId, queue[index].queueEntryId)
    assert.equal(changed[index].title, 'Renamed')
    assert.equal(changed[index].cueRange?.endSeconds, 170)
    assert.equal(changed[index].bpmAnalysis, undefined)
    assert.equal(changed[index].lyrics, null)
  }
})

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

test('queue sidebar iterates only the virtual queue window and wires current-item reveal', () => {
  const source = readFileSync(
    new URL('../components/player-bar/PlaybackQueueSidebar.vue', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /usePlaybackQueueVirtualScroll\([\s\S]*?viewTracks[\s\S]*?rowHeight[\s\S]*?listOffset/
  )
  assert.match(source, /visibleItems\.value\.map/)
  assert.match(source, /v-for="item in rows"/)
  assert.match(source, /class="queue-spacer"/)
  assert.match(source, /@scroll\.passive="onScroll"/)
  assert.match(source, /:key="item\.queueEntryId"/)
  assert.match(source, /@drop="emit\('drop', \$event, item\.queueEntryId\)"/)
  assert.match(source, /@click="locateCurrent"/)
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
  assert.match(selectionSource, /queueSnapshots\(trackList\)/)
  assert.match(source, /const nativeQueueRevisionFence = new NativeQueueRevisionFence\(\)/)
  assert.match(source, /const snapshot = captureNativeQueueState\(revision\)/)
  assert.match(source, /if \(!nativeQueueRevisionFence\.isCurrent\(snapshot\.revision\)\) return/)
})

test('snapshot cache invalidates mutable metadata, routing, ordering and duplicate identities', () => {
  const cached = createPlaybackQueueSnapshotCache()
  const tracks = [track(1), track(1), track(2)]
  const first = cached(tracks)
  assert.equal(cached([...tracks]), first)
  tracks[0].lyrics = 'new heavy payload'
  assert.equal(cached(tracks), first)
  tracks[0].title = 'edited'
  const edited = cached(tracks)
  assert.notEqual(edited, first)
  assert.equal(edited[0].title, 'edited')
  tracks[0].filePath = 'another.flac'
  assert.notEqual(cached(tracks), edited)
  const reversed = cached([...tracks].reverse())
  assert.equal(reversed[0].id, 'local:2')
  tracks[0].queueEntryId = 'custom'
  assert.equal(cached(tracks)[0].queueEntryId, 'custom')
  assert.equal(cached(tracks.slice(1)).length, 2)
})
