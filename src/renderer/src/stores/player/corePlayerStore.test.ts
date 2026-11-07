import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { createCorePlayerStore, type CorePlayerStoreOptions } from './corePlayerStore.ts'
import { createCorePlayerResource } from './corePlayerResource.ts'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import type { CoreClientMessage, CoreSnapshot } from '../../../../shared/coreProtocol.ts'
import type { CoreBridgeStatus } from '../../../../shared/coreBridge.ts'
import type { CorePlaybackView } from '../../../../shared/coreViews.ts'
import type { TrackData } from '../../../../shared/track.ts'
import type { CoreQueueSubmitCommand } from '../../../../shared/coreQueueSubmission.ts'
import { createInactiveVisualizationData } from './useVisualizationPolling.ts'

const tick = async () => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
}
function snapshot(): CoreSnapshot {
  return {
    protocolVersion: 1,
    epoch: 'one',
    sequence: 0,
    phase: 'ready',
    playback: null,
    track: null,
    queue: null,
    error: null,
    migrationRequired: false,
    loading: false,
    isStreamBuffering: false,
    presentationRevision: null,
    pluginsRevision: null,
    libraryRevision: null,
    abLoop: null,
    mute: null,
    modelPack: null,
    cloudTransfers: null,
    inbox: null,
    libraryLoudness: null,
    loudness: null,
    scan: null,
    statisticsRevision: null,
    playlistsRevision: null,
    versionsRevision: null,
    audioRevision: null,
    settingsRevision: null,
    sleepTimer: null,
    bookmarksRevision: null,
    lyricsRevision: null,
    lyricsContentRevision: null,
    workspaceRevision: null,
    workspaceContentRevision: null,
    streams: null,
    cast: null,
    network: null,
    downloads: null,
    personalized: null,
    heart: null
  }
}
const track = (id = 'one'): TrackData => ({
  id,
  title: id,
  artist: 'Artist',
  album: 'Album',
  filePath: `D:/Fixture/${id}.flac`,
  fileName: `${id}.flac`,
  duration: 60,
  size: 100,
  cover: null,
  lyrics: null
})
test('Core stays ready for library access while failed or recovering audio is not playable', () => {
  const f = fixture()
  try {
    assert.equal(f.player.audioEngineReady.value, true)
    const recovery = { phase: 'failed' as const, kind: null, engineAvailable: true,
      windowsServicesAvailable: true, error: '音频服务进程退出：255' }
    f.state.value = { ...f.state.value, audioRecovery: recovery }
    assert.equal(f.state.value.phase, 'ready')
    assert.equal(f.player.audioEngineReady.value, false)
    assert.match(f.player.audioEngineError.value ?? '', /255/)
    f.state.value = { ...f.state.value, audioRecovery: { ...recovery, phase: 'restarting-engine', kind: 'engine', error: null } }
    assert.equal(f.player.audioEngineReady.value, false)
    f.state.value = { ...f.state.value, audioRecovery: { ...recovery, phase: 'succeeded', kind: 'engine', error: null } }
    assert.equal(f.player.audioEngineReady.value, true)
    assert.equal(f.player.audioEngineError.value, null)
  } finally { f.player.dispose() }
})

function fixture(initial = snapshot(), options: CorePlayerStoreOptions = {}) {
  const state = shallowRef(initial)
  const status = shallowRef<CoreBridgeStatus | null>({
    connectionId: 'window',
    epoch: initial.epoch,
    phase: initial.phase
  })
  const requests: Array<{ name: string; payload: unknown }> = []
  const listeners = new Set<(event: CoreClientMessage) => void>()
  let handler: (name: string, payload: unknown) => Promise<unknown> = async () => null
  let query: (name: string, payload: unknown) => Promise<unknown> = async () => null
  const core: CorePlayerClient = {
    state,
    status,
    failure: shallowRef(null),
    attach: async () => state.value,
    refresh: async () => state.value,
    command: async (name, payload) => {
      requests.push({ name, payload })
      return handler(name, payload)
    },
    query: async (name, payload) => (await query(name, payload)) as never,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  let now = 0,
    nextId = 0
  const frames = new Map<number, () => void>()
  const player = createCorePlayerStore(core, {
    now: () => now,
    requestFrame: (callback) => {
      frames.set(++nextId, callback)
      return nextId
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
    visible: ref(true),
    resolveArtwork: async () => null,
    newId: () => `id-${++nextId}`,
    ...options
  })
  return {
    state,
    status,
    requests,
    player,
    setHandler: (next: typeof handler) => {
      handler = next
    },
    setQuery: (next: typeof query) => {
      query = next
    },
    emit: (event: CoreClientMessage) => {
      for (const listener of listeners) listener(event)
    },
    advance: (time: number) => {
      now = time
      for (const [id, callback] of [...frames]) {
        frames.delete(id)
        callback()
      }
    }
  }
}

test('construct, attach, rebuild and Core epoch changes never issue playback or session commands', async () => {
  const f = fixture()
  await f.player.attach()
  f.state.value = { ...snapshot(), epoch: 'two', sequence: 1 }
  f.status.value = { connectionId: 'window', epoch: 'two', phase: 'ready' }
  await tick()
  assert.deepEqual(f.requests, [])
  f.player.dispose()
  const next = fixture(f.state.value)
  await next.player.attach()
  assert.deepEqual(next.requests, [])
  next.player.dispose()
})

test('clock only interpolates Core samples, does not re-anchor on unrelated state or issue seek', async () => {
  const f = fixture()
  f.state.value = {
    ...snapshot(),
    sequence: 1,
    track: track(),
    playback: {
      state: 'playing',
      position: 10,
      duration: 60,
      playbackRate: 1
    } as CorePlaybackView
  }
  await tick()
  f.advance(500)
  assert.equal(f.player.currentTime.value, 10.5)
  f.state.value = { ...f.state.value, sequence: 2, statisticsRevision: 5 }
  await tick()
  f.advance(1000)
  assert.equal(f.player.currentTime.value, 11)
  f.status.value = { connectionId: 'window', epoch: 'one', phase: 'recovering' }
  await tick()
  f.advance(1300)
  assert.equal(f.player.currentTime.value, 10)
  assert.deepEqual(f.requests, [])
  f.player.dispose()
})

test('queue submission streams bounded identity-only batches and keeps selected duplicate CUE occurrence', async () => {
  const f = fixture()
  const tracks = Array.from({ length: 401 }, (_, index) => track(String(index)))
  tracks[0] = {
    ...track('cue'),
    subTrack: '2',
    cueRange: { startSeconds: 30, endSeconds: 90, pregapSeconds: 0 }
  }
  tracks[400] = { ...tracks[0] }
  f.setHandler(async (name, payload) => {
    assert.equal(name, 'queue.submit')
    const command = payload as CoreQueueSubmitCommand
    return {
      id: 'build',
      state: command.kind === 'commit' ? 'committed' : 'building',
      sequence: 'sequence' in command ? command.sequence : 0,
      total: 0
    }
  })
  await f.player.playTrack(tracks[400], tracks)
  const commands = f.requests.map((request) => request.payload as CoreQueueSubmitCommand)
  assert.deepEqual(commands[0], { kind: 'begin', selectedIndex: 400, play: true, position: 0 })
  const appends = commands.filter((command) => command.kind === 'append')
  assert.deepEqual(
    appends.map((command) => command.items.length),
    [200, 200, 1]
  )
  assert.deepEqual(appends[0].items[0], {
    kind: 'local',
    id: 'cue',
    fallback: {
      filePath: 'D:/Fixture/cue.flac',
      title: 'cue',
      artist: 'Artist',
      album: 'Album',
      duration: 60,
      subTrack: '2',
      cueRange: { startSeconds: 30, endSeconds: 90, pregapSeconds: 0 }
    }
  })
  assert.deepEqual(commands.at(-1), { kind: 'commit', id: 'build', sequence: 4 })
  f.player.dispose()
})

test('provider playback strips resolved URLs and unknown commit outcomes are never replayed', async () => {
  const f = fixture()
  f.setHandler(async (_name, payload) => {
    const command = payload as CoreQueueSubmitCommand
    if (command.kind === 'commit')
      throw Object.assign(new Error('reply lost'), { code: 'OUTCOME_UNKNOWN' })
    return {
      id: 'build',
      state: 'building',
      sequence: 'sequence' in command ? command.sequence : 0,
      total: 0
    }
  })
  await assert.rejects(
    f.player.playTrack({
      ...track('ncm:1'),
      source: 'ncm',
      ncmSongId: 1,
      streamUrl: 'https://example.test/secret-token',
      filePath: 'https://example.test/secret-token'
    }),
    /reply lost/
  )
  assert.equal(JSON.stringify(f.requests).includes('secret-token'), false)
  assert.deepEqual(
    f.requests.map((request) => (request.payload as CoreQueueSubmitCommand).kind),
    ['begin', 'append', 'commit']
  )
  f.player.dispose()
})

test('Pause is not serialized behind slow queue/source resolution', async () => {
  const f = fixture()
  f.state.value = { ...snapshot(), playback: { state: 'playing' } as CorePlaybackView }
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setHandler(async (name, payload) => {
    if (name === 'playback.pause') return null
    const command = payload as CoreQueueSubmitCommand
    if (command.kind === 'commit') await pending
    return {
      id: 'build',
      state: 'building',
      sequence: 'sequence' in command ? command.sequence : 0,
      total: 0
    }
  })
  const play = f.player.playTrack(track())
  await tick()
  await f.player.togglePlay()
  assert.equal(f.requests.at(-1)?.name, 'playback.pause')
  release()
  await play
  f.player.dispose()
})

test('query projection fences stale replies, freezes data and ignores replies after disposal', async () => {
  const scope = effectScope()
  const key = ref('first'),
    replies: Array<(value: { items: string[] }) => void> = []
  const resource = scope.run(() =>
    createCorePlayerResource(
      () => key.value,
      () => new Promise<{ items: string[] }>((resolve) => replies.push(resolve)),
      () => {}
    )
  )!
  key.value = 'second'
  await tick()
  replies[1]({ items: ['current'] })
  await tick()
  replies[0]({ items: ['stale'] })
  await tick()
  assert.deepEqual(resource.value.value, { items: ['current'] })
  assert.throws(() => resource.value.value!.items.push('mutated'), TypeError)
  key.value = 'third'
  await tick()
  scope.stop()
  replies[2]({ items: ['disposed'] })
  await tick()
  assert.deepEqual(resource.value.value, { items: ['current'] })
})

test('FFT starts only with a consumer, reconnects subscriptions and stops at zero consumers', async () => {
  const f = fixture()
  assert.equal(f.requests.length, 0)
  const release = f.player.acquireVisualizationConsumer({ spectrumPoints: 128 })
  await tick()
  const first = f.requests[0].payload as { subscriptionId: string }
  assert.equal(f.requests[0].name, 'visualization.subscribe')
  const data = { ...createInactiveVisualizationData(), active: true }
  f.emit({
    kind: 'visualization',
    epoch: 'one',
    subscriptionId: first.subscriptionId,
    sequence: 1,
    data
  })
  assert.equal(f.player.visualizationData.value.active, true)
  f.state.value = { ...snapshot(), epoch: 'two' }
  f.status.value = { connectionId: 'window', epoch: 'two', phase: 'ready' }
  await tick()
  const second = f.requests.at(-1)!.payload as { subscriptionId: string }
  assert.notEqual(second.subscriptionId, first.subscriptionId)
  f.emit({
    kind: 'visualization',
    epoch: 'one',
    subscriptionId: first.subscriptionId,
    sequence: 2,
    data
  })
  assert.equal(f.player.visualizationData.value.active, false)
  release()
  await tick()
  assert.deepEqual(f.requests.at(-1), {
    name: 'visualization.unsubscribe',
    payload: { subscriptionId: second.subscriptionId }
  })
  assert.equal(
    f.requests.some((request) => request.name.startsWith('playback.')),
    false
  )
  f.player.dispose()
})

const queueReference = (revision = 4) => ({
  id: 'queue', revision, index: 0, total: 901, occurrenceId: 'entry:0', canUndo: false, undoLabel: ''
})

test('selecting an occurrence outside the display window locates its absolute position', async () => {
  const f = fixture()
  f.state.value = { ...snapshot(), queue: queueReference() }
  f.setQuery(async (name, payload) => {
    if (name === 'queue.locate') {
      assert.deepEqual(payload, { id: 'queue', revision: 4, occurrenceId: 'entry:900' })
      return { position: 900 }
    }
    return null
  })
  await f.player.playLibraryQueueEntry('entry:900', { id: 'queue', revision: 4 })
  assert.deepEqual(f.requests, [{ name: 'queue.select', payload: {
    id: 'queue', revision: 4, index: 900, occurrenceId: 'entry:900'
  } }])
  f.player.dispose()
})

test('append batches advance the returned Core revision; no queue starts paused', async () => {
  const f = fixture()
  f.state.value = { ...snapshot(), queue: queueReference() }
  f.setHandler(async (name, payload) => {
    assert.equal(name, 'queue.insert')
    return queueReference((payload as { revision: number }).revision + 1)
  })
  await f.player.appendQueueTracks(Array.from({ length: 401 }, (_, i) => track(String(i))))
  assert.deepEqual(f.requests.map(request => (request.payload as { revision: number }).revision), [4, 5, 6])
  f.player.dispose()
  const empty = fixture()
  empty.setHandler(async (_name, payload) => ({
    id: 'build', state: 'building', sequence: (payload as { sequence?: number }).sequence ?? 0, total: 0
  }))
  await empty.player.enqueueTrack(track())
  assert.deepEqual(empty.requests[0], { name: 'queue.submit', payload: { kind: 'begin', selectedIndex: 0, play: false } })
  assert.equal(empty.requests.some(request => request.name === 'playback.play'), false)
  empty.player.dispose()
})

test('duplicate mixed-source entries copy a private Core occurrence, never a display path', async () => {
  const f = fixture()
  f.state.value = { ...snapshot(), queue: queueReference() }
  await f.player.duplicateLibraryQueueEntry('entry:800', true, { id: 'queue', revision: 4 })
  assert.deepEqual(f.requests[0], { name: 'queue.insert', payload: {
    id: 'queue', revision: 4,
    items: [{ kind: 'occurrence', queueId: 'queue', revision: 4, occurrenceId: 'entry:800' }],
    afterEntryId: 'entry:0'
  } })
  f.player.dispose()
})

test('presentation and bookmark lists remain fenced by the current occurrence', async () => {
  const f = fixture()
  const current = { trackId: 'one', occurrenceId: 'entry:0' }
  f.setQuery(async name => {
    if (name === 'player.presentation') return { current, cover: 'cover://one', coverSource: null, favorite: { available: true, liked: true, loading: false } }
    if (name === 'bookmarks.state') return { revision: 3, current, resumeOffer: null, longTrackResumeSeconds: 600, error: null }
    if (name === 'bookmarks.page') return { revision: 3, total: 1, offset: 0, items: [{ id: 'bookmark', label: 'Verse', positionSeconds: 10 }] }
    return null
  })
  f.state.value = { ...snapshot(), track: track(), queue: queueReference(), presentationRevision: 1, bookmarksRevision: 3 }
  await tick()
  assert.equal(f.player.currentTrack.value?.cover, 'cover://one')
  assert.equal(f.player.currentFavorite.value?.liked, true)
  assert.equal(f.player.currentTrackBookmarks.value[0].id, 'bookmark')
  await f.player.seekBookmark('bookmark')
  assert.deepEqual(f.requests.at(-1), { name: 'bookmarks.seek', payload: { revision: 3, id: 'bookmark', current } })
  f.state.value = { ...f.state.value, queue: { ...queueReference(), occurrenceId: 'entry:1' } }
  await tick()
  assert.equal(f.player.currentTrack.value?.cover, null)
  assert.equal(f.player.currentFavorite.value, null)
  assert.deepEqual(f.player.currentTrackBookmarks.value, [])
  f.player.dispose()
})

test('background metadata progress does not re-resolve artwork or invalidate the playing track', async () => {
  let resolutions = 0, colors = 0
  const f = fixture(snapshot(), {
    resolveArtwork: async handle => { resolutions++; return handle ?? null },
    extractColor: async () => { colors++; return '#123456' }
  })
  f.setQuery(async name => name === 'player.presentation' ? {
    current: { trackId: 'one', occurrenceId: 'entry:0' },
    cover: 'cover://one', coverSource: null
  } : null)
  try {
    f.state.value = { ...snapshot(), track: { ...track(), artists: [{ name: 'Artist' }] },
      queue: queueReference(), presentationRevision: 1 }
    await tick()
    const playing = f.player.currentTrack.value
    const before = { resolutions, colors }
    for (let i = 1; i <= 20; i++) {
      f.state.value = { ...structuredClone(f.state.value), sequence: i,
        entityMetadataRevision: i, entityMetadataContentRevision: i, libraryRevision: i }
      await tick()
    }
    assert.deepEqual({ resolutions, colors }, before)
    assert.equal(f.player.currentTrack.value, playing)
    f.state.value = { ...structuredClone(f.state.value),
      track: { ...f.state.value.track!, title: 'Updated title' } }
    await tick()
    assert.equal(f.player.currentTrack.value?.title, 'Updated title')
    assert.notEqual(f.player.currentTrack.value, playing)
    assert.deepEqual({ resolutions, colors }, before, 'a tag edit does not change the artwork')
  } finally { f.player.dispose() }
})

test('a changed cover is resolved once and its late predecessor cannot replace the current theme', async () => {
  const colorResults = new Map<string, (color: string) => void>()
  const resolved: string[] = []
  const f = fixture(snapshot(), {
    resolveArtwork: async handle => {
      if (handle) resolved.push(handle)
      return handle ?? null
    },
    extractColor: url => new Promise(resolve => colorResults.set(url, resolve))
  })
  let cover = 'cover://one'
  f.setQuery(async name => name === 'player.presentation' ? {
    current: { trackId: 'one', occurrenceId: 'entry:0' }, cover, coverSource: null
  } : null)
  try {
    f.state.value = { ...snapshot(), track: track(), queue: queueReference(), presentationRevision: 1 }
    await tick()
    cover = 'cover://two'
    f.state.value = { ...f.state.value, presentationRevision: 2 }
    await tick()
    colorResults.get('cover://two')!('#223344')
    await tick()
    colorResults.get('cover://one')!('#aabbcc')
    await tick()
    assert.deepEqual(resolved, ['cover://one', 'cover://two'])
    assert.equal(f.player.themeCoverUrl.value, 'cover://two')
    assert.equal(f.player.coverThemeColor.value, '#223344')
  } finally { f.player.dispose() }
})
