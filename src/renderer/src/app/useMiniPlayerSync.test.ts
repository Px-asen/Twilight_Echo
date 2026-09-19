import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMiniPlayerLyricLines,
  buildMiniPlayerStateSnapshot,
  createMiniPlayerPublishScheduler,
  findActiveMiniPlayerLyricIndex,
  miniPlayerProgressKey,
  resetMiniPlayerLyricCache,
  resolveCurrentLyricForMiniPlayer
} from './useMiniPlayerSync.ts'
import type { Track } from '../types/music.ts'
import { ref, shallowRef } from 'vue'
import { createQueueCommandController } from '@renderer/stores/player/queueCommandController.ts'
import { toPlaybackQueueSnapshots } from '@renderer/utils/playbackQueueVirtualization.ts'
import type { PlayMode } from '@renderer/types/settings'

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'ncm:1',
    title: 'Daydream',
    artist: 'Twilight Echo',
    album: 'Afterglow',
    albumArtist: 'Twilight Echo',
    trackNumber: 7,
    fileName: 'daydream.mp3',
    filePath: 'ncm:1',
    duration: 240,
    size: 0,
    cover: null,
    format: 'FLAC',
    sampleRate: 192000,
    bitDepth: 24,
    lyrics: '[00:01.00]first line\n[00:03.00]second line',
    translatedLyrics: '[00:01.00]第一行\n[00:03.00]第二行',
    ...overrides
  }
}

function makeSource(track: Track | null, currentTime: number) {
  return {
    track,
    isPlaying: true,
    isLoading: false,
    currentTime,
    duration: 240,
    playbackRate: 1.25,
    volume: 0.7,
    playMode: 'sequential' as const,
    favoriteAvailable: false,
    favoriteLiked: false,
    favoriteLoading: false,
    dominantColor: '#7c4dff',
    queueIndex: 0,
    queueLength: 1
  }
}

test('mini player snapshots follow queue clear and undo with the restored index and paused transport', (t) => {
  const queue = shallowRef(toPlaybackQueueSnapshots([makeTrack(), makeTrack()]))
  const originalQueue = shallowRef([...queue.value])
  const currentTrack = shallowRef<Track | null>(queue.value[1])
  const queueIndex = ref(1)
  const isPlaying = ref(true)
  const time = ref(35)
  const commands = createQueueCommandController({
    queue,
    originalQueue,
    currentTrack,
    queueIndex,
    playMode: ref<PlayMode>('sequential'),
    getPosition: () => time.value,
    prepareSelection: (track, position) => {
      currentTrack.value = track
      time.value = position
      isPlaying.value = false
    },
    onMutation: () => {}
  })
  t.after(commands.dispose)
  const snapshot = () =>
    buildMiniPlayerStateSnapshot({
      ...makeSource(currentTrack.value, time.value),
      isPlaying: isPlaying.value,
      queueIndex: queueIndex.value,
      queueLength: queue.value.length
    })
  commands.replace([], -1)
  assert.equal(snapshot().track, null)
  assert.equal(snapshot().queueLength, 0)
  assert.equal(snapshot().queueIndex, -1)
  commands.undo()
  assert.equal(snapshot().track?.id, 'ncm:1')
  assert.equal(snapshot().queueLength, 2)
  assert.equal(snapshot().queueIndex, 1)
  assert.equal(snapshot().currentTime, 35)
  assert.equal(snapshot().isPlaying, false)
})

test('mini player snapshot carries the lyric line active at the snapshot time', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 3.5))
  assert.equal(snapshot.currentLyric?.original, 'second line')
  assert.equal(snapshot.currentLyric?.translation, '第二行')
  assert.equal(snapshot.track?.format, 'FLAC')
  assert.equal(snapshot.track?.sampleRate, 192000)
  assert.equal(snapshot.track?.bitDepth, 24)
  assert.equal(snapshot.track?.albumArtist, 'Twilight Echo')
  assert.equal(snapshot.track?.trackNumber, 7)
  assert.equal(snapshot.playbackRate, 1.25)
})

test('mini player snapshot keeps quality fields null when the track has none', () => {
  const snapshot = buildMiniPlayerStateSnapshot(
    makeSource(makeTrack({ format: undefined, sampleRate: undefined, bitDepth: undefined }), 3.5)
  )
  assert.equal(snapshot.track?.format, null)
  assert.equal(snapshot.track?.sampleRate, null)
  assert.equal(snapshot.track?.bitDepth, null)
})

test('mini player lyric resolution returns null before the first timed line', () => {
  assert.equal(resolveCurrentLyricForMiniPlayer(makeTrack(), 0.5), null)
  assert.equal(resolveCurrentLyricForMiniPlayer(null, 10), null)
})

test('mini player lyric resolution ignores plain untimed lyrics', () => {
  const plain = makeTrack({ lyrics: 'Just a plain lyric line', translatedLyrics: '' })
  assert.equal(resolveCurrentLyricForMiniPlayer(plain, 10), null)
})

test('mini player snapshot drops the lyric field when no line is active', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 0.5))
  assert.equal(snapshot.currentLyric, null)
})

test('mini player snapshot carries timed lyric lines for the multi-line view', () => {
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(makeTrack(), 3.5))
  assert.deepEqual(snapshot.lyrics, [
    { time: 1, original: 'first line', translation: '第一行' },
    { time: 3, original: 'second line', translation: '第二行' }
  ])
})

test('mini player projects explicit duet markers to readable text without leaking metadata', () => {
  const duet = makeTrack({
    lyrics: [
      '[00:01.00][te:voice role=lead lane=start group=duet]First',
      '[00:01.00][te:voice role=lead lane=end group=duet]Second',
      '[00:01.20][te:voice role=harmony lane=end group=duet]Harmony'
    ].join('\n'),
    translatedLyrics: '[00:01.00]组合翻译'
  })
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(duet, 1.5))
  assert.equal(snapshot.lyrics[0]?.original, 'First · Second')
  assert.equal(snapshot.lyrics[0]?.translation, '组合翻译')
  assert.ok(!snapshot.lyrics[0]?.original.includes('[te:voice'))
})

test('mini player lyric lines ignore plain untimed lyrics', () => {
  const plain = makeTrack({ lyrics: 'Just a plain lyric line', translatedLyrics: '' })
  const snapshot = buildMiniPlayerStateSnapshot(makeSource(plain, 10))
  assert.deepEqual(snapshot.lyrics, [])
})

test('mini player lyric index picks the latest line at or before current time', () => {
  const lines = [
    { time: 1, original: 'first', translation: null },
    { time: 3, original: 'second', translation: null },
    { time: 7.5, original: 'third', translation: null }
  ]
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 0.5), -1)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 1), 0)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 3.2), 1)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 7.5), 2)
  assert.equal(findActiveMiniPlayerLyricIndex(lines, 99), 2)
  assert.equal(findActiveMiniPlayerLyricIndex([], 5), -1)
})

test('mini player lyric parsing is cached per track identity and reused by progress lookups', () => {
  resetMiniPlayerLyricCache()
  const track = makeTrack()
  const first = buildMiniPlayerLyricLines(track)
  const second = buildMiniPlayerLyricLines({ ...track })
  assert.equal(first, second, 'same track id + lyric text must hit the parse cache')
  assert.equal(resolveCurrentLyricForMiniPlayer(track, 3.5)?.original, 'second line')

  const edited = makeTrack({ lyrics: '[00:02.00]changed line', translatedLyrics: '' })
  const third = buildMiniPlayerLyricLines(edited)
  assert.notEqual(third, first)
  assert.deepEqual(third, [{ time: 2, original: 'changed line', translation: null }])

  const other = makeTrack({ id: 'ncm:2' })
  assert.notEqual(buildMiniPlayerLyricLines(other), third)
})

test('mini player progress key only changes across lyric lines or whole seconds', () => {
  const track = makeTrack()
  assert.equal(miniPlayerProgressKey(track, 1.1), miniPlayerProgressKey(track, 1.4))
  assert.notEqual(miniPlayerProgressKey(track, 1.9), miniPlayerProgressKey(track, 2.1))
  assert.notEqual(miniPlayerProgressKey(track, 2.9), miniPlayerProgressKey(track, 3.0))
  assert.equal(miniPlayerProgressKey(null, 5.2), miniPlayerProgressKey(null, 5.9))
  assert.notEqual(miniPlayerProgressKey(null, 5.9), miniPlayerProgressKey(null, 6.0))
})

test('mini player publish scheduler throttles progress ticks and publishes metadata immediately', () => {
  let now = 0
  let key = '0:0'
  const timers: Array<{ at: number; callback: () => void }> = []
  const published: number[] = []
  const scheduler = createMiniPlayerPublishScheduler({
    publish: () => published.push(now),
    progressKey: () => key,
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as { at: number; callback: () => void })
      if (index >= 0) timers.splice(index, 1)
    },
    throttleMs: 500
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of [...timers]) {
      if (timer.at > now) continue
      timers.splice(timers.indexOf(timer), 1)
      timer.callback()
    }
  }

  scheduler.publishNow()
  assert.deepEqual(published, [0])

  // 250 ms ticks inside the same lyric line and second: nothing is sent.
  advance(250)
  scheduler.notifyProgress()
  advance(250)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0])

  // Outside the throttle window a changed key publishes right away.
  key = '0:1'
  advance(100)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0, 600])

  // Inside the window the publish trails to the window edge, once.
  key = '0:2'
  advance(100)
  scheduler.notifyProgress()
  advance(100)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0, 600])
  assert.equal(timers.length, 1)
  advance(300)
  assert.deepEqual(published, [0, 600, 1100])
  assert.equal(timers.length, 0)

  // A pending trailing publish is superseded by an immediate metadata publish.
  key = '1:3'
  advance(100)
  scheduler.notifyProgress()
  assert.equal(timers.length, 1)
  scheduler.publishNow()
  assert.equal(timers.length, 0)
  assert.deepEqual(published, [0, 600, 1100, 1200])
  advance(1000)
  assert.deepEqual(published, [0, 600, 1100, 1200])

  scheduler.dispose()
  key = '2:9'
  advance(1000)
  scheduler.notifyProgress()
  assert.deepEqual(published, [0, 600, 1100, 1200])
})
