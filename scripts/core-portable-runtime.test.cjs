const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const BUNDLE_PATH = path.join(ROOT, 'dist', 'portable-core', 'music-core.js')
const LOCK_PATH = path.join(ROOT, 'dist', 'portable-core', 'core-lock.json')

for (const [operation, boundary] of [['pause', 'before'], ['play', 'load'], ['seek', 'after'], ['stop', 'load']]) {
  test(`portable lookahead keeps queue authority across ${operation} during ${boundary}`, async () => {
    const core = loadPortableCoreInIsolatedSandbox()
    const ports = createFakePorts()
    const host = core.createPortableMusicCoreHost({ audioEngine: ports.audioEngine, sessionStore: ports.sessionStore })
    const engine = host.playback.options.engine
    const current = { id: 'current', queueEntryId: 'row-current', source: '/current.flac', duration: 210 }
    const next = { id: 'next', queueEntryId: 'row-next', source: '/next.flac', duration: 210 }
    await engine.loadQueue([current], 0)
    await engine.play(current.source, 0)
    const token = engine.getQueueToken()
    let resume
    let reached
    const blocked = new Promise(resolve => { resume = resolve })
    const entered = new Promise(resolve => { reached = resolve })
    const snapshot = ports.audioEngine.getSnapshot.bind(ports.audioEngine)
    const load = ports.audioEngine.loadQueue.bind(ports.audioEngine)
    let reads = 0
    ports.audioEngine.getSnapshot = async () => {
      const value = await snapshot()
      reads++
      if ((boundary === 'before' && reads === 1) || (boundary === 'after' && reads === 2)) {
        reached()
        await blocked
      }
      return value
    }
    ports.audioEngine.loadQueue = async (...args) => {
      await load(...args)
      if (boundary === 'load') { reached(); await blocked }
    }
    const binding = engine.rebindQueue({ expected: { queueToken: token, index: 0, id: current.id, source: current.source },
      items: [current, next], startIndex: 0, playMode: 'sequential' })
    await entered
    if (operation === 'play') await engine.play(current.source, 0)
    else if (operation === 'seek') await engine.seek(12)
    else await engine[operation]()
    resume()
    const commit = await binding
    assert.ok(commit?.queueToken, 'A same-selection transport control must not revoke the confirmed lookahead queue')
    assert.notEqual(commit.queueToken, token)
    assert.deepEqual(Array.from(engine.getQueueSnapshot(), item => item.id), ['current', 'next'])
    const actual = await snapshot()
    assert.equal(actual.state, operation === 'pause' ? 'paused' : operation === 'stop' ? 'stopped' : 'playing')
    if (operation === 'seek') assert.equal(actual.position, 12)
  })
}

test('a newer queue load supersedes an older lookahead without losing the new queue', async () => {
  const core = loadPortableCoreInIsolatedSandbox()
  const ports = createFakePorts()
  const host = core.createPortableMusicCoreHost({ audioEngine: ports.audioEngine, sessionStore: ports.sessionStore })
  const engine = host.playback.options.engine
  const current = { id: 'current', queueEntryId: 'row-current', source: '/current.flac' }
  const replacement = { id: 'replacement', queueEntryId: 'row-replacement', source: '/replacement.flac' }
  await engine.loadQueue([current], 0)
  await engine.play(current.source, 0)
  const token = engine.getQueueToken()
  let resume
  let reached
  const blocked = new Promise(resolve => { resume = resolve })
  const entered = new Promise(resolve => { reached = resolve })
  const snapshot = ports.audioEngine.getSnapshot.bind(ports.audioEngine)
  ports.audioEngine.getSnapshot = async () => { const value = await snapshot(); reached(); await blocked; return value }
  const binding = engine.rebindQueue({ expected: { queueToken: token, index: 0, id: current.id, source: current.source },
    items: [current], startIndex: 0, playMode: 'sequential' })
  const rejected = assert.rejects(binding, /handoff superseded/)
  await entered
  await engine.loadQueue([replacement], 0)
  const newToken = engine.getQueueToken()
  resume()
  await rejected
  assert.ok(newToken)
  assert.equal(engine.getQueueToken(), newToken)
  assert.equal(engine.getQueueSnapshot()[0].id, 'replacement')
})

test('a pause during a confirmed queue load preserves its queue authority', async () => {
  const core = loadPortableCoreInIsolatedSandbox()
  const ports = createFakePorts()
  const host = core.createPortableMusicCoreHost({ audioEngine: ports.audioEngine, sessionStore: ports.sessionStore })
  const engine = host.playback.options.engine
  const current = { id: 'current', queueEntryId: 'row-current', source: '/current.flac' }
  const load = ports.audioEngine.loadQueue.bind(ports.audioEngine)
  let resume
  let reached
  const blocked = new Promise(resolve => { resume = resolve })
  const entered = new Promise(resolve => { reached = resolve })
  ports.audioEngine.loadQueue = async (...args) => { await load(...args); reached(); await blocked }
  const loading = engine.loadQueue([current], 0)
  await entered
  await engine.pause()
  resume()
  await loading
  assert.ok(engine.getQueueToken())
  assert.equal(engine.getQueueSnapshot()[0].id, 'current')
  assert.equal((await engine.getPlaybackInfo()).state, 'paused')
})

function loadPortableCoreInIsolatedSandbox() {
  assert.equal(
    fs.existsSync(BUNDLE_PATH),
    true,
    'dist/portable-core/music-core.js must exist (run scripts/build-portable-core.mjs first)',
  )
  const bundleCode = fs.readFileSync(BUNDLE_PATH, 'utf8')

  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox, {
    name: 'QuickJS-Simulated-Sandbox',
    codeGeneration: { strings: false, wasm: false },
  })

  // Strip ECMA-402 / Web / Node globals that QuickJS does not provide natively
  vm.runInContext(
    'delete globalThis.Intl; delete globalThis.structuredClone; delete globalThis.crypto; delete globalThis.TextEncoder; delete globalThis.TextDecoder; delete globalThis.AbortController; delete globalThis.AbortSignal; delete globalThis.URL;',
    context,
  )

  vm.runInContext(bundleCode, context, {
    filename: 'music-core.js',
    timeout: 5000,
  })

  assert.equal(typeof sandbox.process, 'undefined', 'Sandbox must not expose process')
  assert.equal(typeof sandbox.require, 'undefined', 'Sandbox must not expose require')
  assert.equal(
    typeof sandbox.__TWILIGHT_CORE_PORTS__,
    'undefined',
    'Sandbox must not rely on __TWILIGHT_CORE_PORTS__',
  )
  assert.equal(
    typeof sandbox.__TWILIGHT_PORTABLE_CORE__,
    'object',
    'Bundle must register globalThis.__TWILIGHT_PORTABLE_CORE__',
  )

  return sandbox.__TWILIGHT_PORTABLE_CORE__
}

function createFakePorts() {
  let storedSession = null
  let revisionCounter = 0
  let nowTick = 1_710_000_000_000
  const audioListeners = new Set()
  const engineCalls = []

  let queueItems = []
  let queueCursor = 0
  let currentSource = ''
  let currentPosition = 0
  let currentDuration = 210
  let state = 'stopped'
  let volume = 0.7
  let playMode = 'sequential'

  const buildPlaybackInfo = () => {
    const activeItem = queueItems[queueCursor] ?? null
    return {
      state,
      position: currentPosition,
      source: activeItem?.source || currentSource,
      currentTime: currentPosition,
      duration: activeItem?.duration ?? currentDuration,
      volume,
      playMode: playMode === 'heart' ? 'sequential' : playMode,
      currentTrack: activeItem?.source || currentSource,
      queueIndex: queueItems.length > 0 ? queueCursor : -1,
      queueLength: queueItems.length,
    }
  }

  const emitNativeEvent = (event) => {
    for (const listener of [...audioListeners]) {
      listener(event)
    }
  }

  const clock = {
    nowUnixMs() {
      nowTick += 15
      return nowTick
    },
    nowMonotonicMs() {
      nowTick += 15
      return nowTick
    },
  }

  const sessionStore = {
    async load() {
      return storedSession ? { ...storedSession } : null
    },
    async save(payloadJson, expectedRevision) {
      if (storedSession && expectedRevision !== storedSession.revision) {
        return { ok: false, reason: 'conflict' }
      }
      revisionCounter += 1
      const revision = String(revisionCounter)
      storedSession = { revision, payloadJson }
      return { ok: true, revision }
    },
  }

  const audioEngine = {
    async start() {
      engineCalls.push({ method: 'start' })
    },
    async loadQueue(items, startIndex = 0) {
      engineCalls.push({ method: 'loadQueue', count: items.length, startIndex })
      queueItems = items.map((item) => ({ ...item }))
      queueCursor = items.length === 0 ? 0 : Math.max(0, Math.min(items.length - 1, startIndex))
      if (queueItems[queueCursor]) {
        currentSource = queueItems[queueCursor].source
        currentDuration = queueItems[queueCursor].duration || 210
      }
    },
    async play(source, positionSeconds = 0) {
      engineCalls.push({ method: 'play', source, positionSeconds })
      currentSource = source
      currentPosition = positionSeconds
      state = 'playing'
      const matchedIdx = queueItems.findIndex((item) => item.source === source)
      if (matchedIdx >= 0) queueCursor = matchedIdx
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
      return { nativeStarted: true, fallbackReason: '' }
    },
    async pause() {
      engineCalls.push({ method: 'pause' })
      state = 'paused'
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
    },
    async stop() {
      engineCalls.push({ method: 'stop' })
      state = 'stopped'
      currentPosition = 0
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
    },
    async seek(positionSeconds) {
      engineCalls.push({ method: 'seek', positionSeconds })
      currentPosition = positionSeconds
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
    },
    async setVolume(nextVolume) {
      engineCalls.push({ method: 'setVolume', volume: nextVolume })
      volume = nextVolume
    },
    async setPlaybackRate(rate) {
      engineCalls.push({ method: 'setPlaybackRate', rate })
    },
    async setPlayMode(mode) {
      engineCalls.push({ method: 'setPlayMode', mode })
      playMode = mode
    },
    async selectQueueIndex(index) {
      engineCalls.push({ method: 'selectQueueIndex', index })
      if (index < 0 || index >= queueItems.length) return false
      queueCursor = index
      currentSource = queueItems[queueCursor].source
      currentPosition = 0
      state = 'playing'
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
      return true
    },
    async next() {
      engineCalls.push({ method: 'next' })
      if (queueCursor + 1 < queueItems.length) {
        queueCursor += 1
        currentSource = queueItems[queueCursor].source
        currentPosition = 0
      }
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
      return true
    },
    async previous() {
      engineCalls.push({ method: 'previous' })
      if (queueCursor > 0) {
        queueCursor -= 1
        currentSource = queueItems[queueCursor].source
        currentPosition = 0
      }
      emitNativeEvent({ type: 'playback-info', info: buildPlaybackInfo() })
      return true
    },
    async getSnapshot() {
      return buildPlaybackInfo()
    },
    subscribe(listener) {
      audioListeners.add(listener)
      return () => {
        audioListeners.delete(listener)
      }
    },
    emitNativeEvent,
  }

  return {
    clock,
    sessionStore,
    audioEngine,
    engineCalls,
    getStoredSession: () => storedSession,
  }
}

function sendRequestAndWait(host, requestEnvelope) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for response to ${requestEnvelope.requestId}`))
    }, 3000)

    const unsubscribe = host.subscribeMessagesJson((rawJson) => {
      const msg = JSON.parse(rawJson)
      if (msg.kind === 'response' && msg.requestId === requestEnvelope.requestId) {
        clearTimeout(timer)
        unsubscribe()
        resolve(msg)
      }
    })

    host.dispatchRequestJson(JSON.stringify(requestEnvelope))
  })
}

test('portable playTracks batches a complete large library without truncating selection or order', async () => {
  const core = loadPortableCoreInIsolatedSandbox()
  const ports = createFakePorts()
  const host = core.createPortableMusicCoreHost({ audioEngine: ports.audioEngine, sessionStore: ports.sessionStore })
  await host.initialize()
  const tracks = Array.from({ length: 1410 }, (_, i) => ({ id: `large-${i}`, filePath: `/large/${i}.flac`, title: `Song ${i}`, duration: 210 }))
  await host.playTracks(tracks, 1007)
  const snapshot = host.getSnapshot()
  assert.equal(snapshot.queue.total, 1410)
  assert.equal(snapshot.queue.index, 1007)
  assert.equal(snapshot.track.id, 'large-1007')
  const page = await sendRequestAndWait(host, { kind: 'query', name: 'queue.page', requestId: 'last-large-page', epoch: host.epoch,
    payload: { id: snapshot.queue.id, revision: snapshot.queue.revision, offset: 1400, limit: 10 } })
  assert.equal(page.ok, true, JSON.stringify(page.error))
  assert.deepEqual(Array.from(page.value.items, item => item.track.id), tracks.slice(1400).map(track => track.id))
  await host.shutdown()
})

test('core-lock.json metadata matches built portable bundle', () => {
  assert.equal(fs.existsSync(LOCK_PATH), true, 'core-lock.json must exist')
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))
  assert.equal(lock.protocolVersion, 1)
  assert.equal(lock.bundleFile, 'music-core.js')
  assert.match(lock.bundleSha256, /^[0-9a-f]{64}$/)
  assert.ok(lock.bundleBytes > 1000)
})

test('Portable MusicCore runs inside a zero-Node sandbox and fulfills Phase 1 PoC lifecycle', async () => {
  const portableCore = loadPortableCoreInIsolatedSandbox()
  const ports = createFakePorts()
  const initialTracks = [
    {
      id: 'track-101',
      filePath: 'content://media/external/audio/media/101',
      title: 'Twilight Overture',
      artist: 'Echo Ensemble',
      album: 'Phase One',
      duration: 210,
    },
    {
      id: 'track-102',
      filePath: 'content://media/external/audio/media/102',
      title: 'Midnight Horizon',
      artist: 'Echo Ensemble',
      album: 'Phase One',
      duration: 185,
    },
    {
      id: 'track-103',
      filePath: 'content://media/external/audio/media/103',
      title: 'Dawn Resonance',
      artist: 'Echo Ensemble',
      album: 'Phase One',
      duration: 240,
    },
  ]

  const host = portableCore.createPortableMusicCoreHost({
    epoch: 'epoch-poc-1',
    platform: 'android',
    clock: ports.clock,
    sessionStore: ports.sessionStore,
    audioEngine: ports.audioEngine,
    initialTracks,
    initialSettings: {
      playbackResumeMode: 'trackAndPosition',
    },
  })

  const stateSequences = []
  const unsubscribe = host.subscribeMessages((message) => {
    if (message.kind === 'state') {
      stateSequences.push(message.sequence)
    }
  })

  // 1. Initialize
  await host.initialize()
  const initSnap = host.getSnapshot()
  assert.equal(initSnap.protocolVersion, 1)
  assert.equal(initSnap.phase, 'ready')

  // 2. Build queue & play tracks
  await host.playTracks(initialTracks, 0)
  const playingSnap = host.getSnapshot()
  assert.equal(playingSnap.track?.id, 'track-101')
  assert.equal(playingSnap.queue?.total, 3)
  assert.equal(playingSnap.queue?.index, 0)

  // 3. Change play mode via standard CoreRequestEnvelope ('playback.mode')
  const modeResp = await sendRequestAndWait(host, {
    kind: 'command',
    requestId: 'req-mode-1',
    epoch: host.epoch,
    name: 'playback.mode',
    payload: { mode: 'listLoop' },
  })
  assert.equal(modeResp.ok, true, `modeResp failed: ${JSON.stringify(modeResp)}`)
  assert.equal(host.getSnapshot().playback?.playMode, 'listLoop')

  // 4. Advance to next track via standard CoreRequestEnvelope ('playback.next')
  const nextResp = await sendRequestAndWait(host, {
    kind: 'command',
    requestId: 'req-next-1',
    epoch: host.epoch,
    name: 'playback.next',
    payload: {},
  })
  assert.equal(nextResp.ok, true, `nextResp failed: ${JSON.stringify(nextResp)}`)
  assert.equal(host.getSnapshot().track?.id, 'track-102')
  assert.equal(host.getSnapshot().queue?.index, 1)

  // 5. Query queue page via standard CoreRequestEnvelope ('queue.page')
  const queueRef = host.getSnapshot().queue
  assert.ok(queueRef, 'Active queue reference must exist')
  const pageResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-queue-page-1',
    epoch: host.epoch,
    name: 'queue.page',
    payload: {
      id: queueRef.id,
      revision: queueRef.revision,
      offset: 0,
      limit: 10,
    },
  })
  assert.equal(pageResp.ok, true, `pageResp failed: ${JSON.stringify(pageResp)}`)
  assert.equal(pageResp.value.items.length, 3)

  // 6. Trigger platform safety brake (e.g. Bluetooth A2DP disconnected / AudioNoisy)
  await host.triggerPlatformSafetyBrake('android.media.AUDIO_BECOMING_NOISY')
  assert.equal(host.getSnapshot().playback?.state, 'paused')

  // 7. Verify monotonic sequence numbers on emitted state messages
  assert.ok(stateSequences.length >= 4, 'Expected at least 4 state snapshots emitted')
  for (let i = 1; i < stateSequences.length; i += 1) {
    assert.ok(
      stateSequences[i] > stateSequences[i - 1],
      `State sequence must be strictly increasing (${stateSequences[i - 1]} -> ${stateSequences[i]})`,
    )
  }

  // 8. Shutdown & restore in a brand-new host instance sharing sessionStore
  await host.shutdown()
  unsubscribe()
  assert.ok(ports.getStoredSession(), 'Session store must contain persisted envelope after shutdown')

  const restoredHost = portableCore.createPortableMusicCoreHost({
    epoch: 'epoch-poc-2',
    platform: 'android',
    clock: ports.clock,
    sessionStore: ports.sessionStore,
    audioEngine: ports.audioEngine,
    initialSettings: {
      playbackResumeMode: 'trackAndPosition',
    },
  })
  await restoredHost.initialize()
  const restoredSnap = restoredHost.getSnapshot()
  assert.equal(restoredSnap.phase, 'ready')
  assert.equal(restoredSnap.queue?.total, 3)
  assert.equal(restoredSnap.track?.id, 'track-102')
  assert.equal(restoredSnap.playback?.playMode, 'listLoop')
  await restoredHost.shutdown()
})

test('Portable MusicCore Phase 2: Local Library Collections, Search, Playlists/Favorites, Bookmarks, and Lyrics in zero-Node sandbox', async () => {
  const portableCore = loadPortableCoreInIsolatedSandbox()
  const ports = createFakePorts()
  const initialTracks = [
    {
      id: 'track-201',
      filePath: 'content://media/external/audio/media/201',
      title: 'Starlight Echo',
      artist: 'Aurora',
      album: 'Northern Skies',
      genre: 'Ambient',
      duration: 245,
      lyrics: '[00:00.00]Starlight falling\n[00:05.50]Across the northern skies',
    },
    {
      id: 'track-202',
      filePath: 'content://media/external/audio/media/202',
      title: 'Velvet Horizon',
      artist: 'Aurora',
      album: 'Northern Skies',
      genre: 'Ambient',
      duration: 198,
    },
    {
      id: 'track-203',
      filePath: 'content://media/external/audio/media/203',
      title: 'Cyber Pulse',
      artist: 'SynthWave',
      album: 'Neon Grid',
      genre: 'Electronic',
      duration: 212,
    },
  ]

  const host = portableCore.createPortableMusicCoreHost({
    epoch: 'epoch-phase2-1',
    platform: 'android',
    clock: ports.clock,
    sessionStore: ports.sessionStore,
    audioEngine: ports.audioEngine,
    initialTracks,
  })

  await host.initialize()
  await host.playTracks(initialTracks, 0)

  // 1. Query Local Library Collections (albums & artists)
  const albumsResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-albums-1',
    epoch: host.epoch,
    name: 'library.collections',
    payload: {
      kind: 'albums',
      query: { offset: 0, limit: 20 },
    },
  })
  assert.equal(albumsResp.ok, true, `albumsResp failed: ${JSON.stringify(albumsResp)}`)
  assert.equal(albumsResp.value.total, 2)

  // 2. Unified Local Music Search ('search.songs')
  const searchResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-search-1',
    epoch: host.epoch,
    name: 'search.songs',
    payload: {
      query: 'Starlight',
      scope: 'local',
      offset: 0,
      limit: 20,
    },
  })
  assert.equal(searchResp.ok, true, `searchResp failed: ${JSON.stringify(searchResp)}`)
  assert.equal(searchResp.value.items.length, 1)
  assert.equal(searchResp.value.items[0].track.id, 'track-201')

  // 3. Create a playlist & toggle favorite
  const plStateResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-pl-state-1',
    epoch: host.epoch,
    name: 'playlists.state',
    payload: {},
  })
  assert.equal(plStateResp.ok, true)

  const createPlResp = await sendRequestAndWait(host, {
    kind: 'command',
    requestId: 'req-pl-create-1',
    epoch: host.epoch,
    name: 'playlists.edit',
    payload: {
      revision: plStateResp.value.revision,
      edit: {
        kind: 'create',
        name: 'Road Trip',
      },
    },
  })
  assert.equal(createPlResp.ok, true, `createPlResp failed: ${JSON.stringify(createPlResp)}`)

  const listPlResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-pl-list-1',
    epoch: host.epoch,
    name: 'playlists.list',
    payload: {
      offset: 0,
      limit: 20,
    },
  })
  assert.equal(listPlResp.ok, true)
  assert.ok(listPlResp.value.items.some((p) => p.name === 'Road Trip'))

  // Toggle favorite on current playing track via playback.control ('toggle-favorite')
  const favToggleResp = await sendRequestAndWait(host, {
    kind: 'command',
    requestId: 'req-fav-toggle-1',
    epoch: host.epoch,
    name: 'playback.control',
    payload: { type: 'toggle-favorite' },
  })
  assert.equal(favToggleResp.ok, true, `favToggleResp failed: ${JSON.stringify(favToggleResp)}`)
  assert.equal(favToggleResp.value.favorite.liked, true)

  // 4. Bookmarks: add bookmark for current playing track & query bookmarks page
  const bmStateResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-bm-state-1',
    epoch: host.epoch,
    name: 'bookmarks.state',
    payload: {},
  })
  assert.equal(bmStateResp.ok, true, `bmStateResp failed: ${JSON.stringify(bmStateResp)}`)
  assert.equal(bmStateResp.value.current?.trackId, 'track-201')

  const bmAddResp = await sendRequestAndWait(host, {
    kind: 'command',
    requestId: 'req-bm-add-1',
    epoch: host.epoch,
    name: 'bookmarks.edit',
    payload: {
      revision: bmStateResp.value.revision,
      edit: {
        kind: 'addCurrent',
        current: bmStateResp.value.current,
        label: 'Chorus Drop',
      },
    },
  })
  assert.equal(bmAddResp.ok, true, `bmAddResp failed: ${JSON.stringify(bmAddResp)}`)

  const bmPageResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-bm-page-1',
    epoch: host.epoch,
    name: 'bookmarks.page',
    payload: {
      revision: bmAddResp.value.revision,
      scope: 'current',
      offset: 0,
      limit: 20,
    },
  })
  assert.equal(bmPageResp.ok, true)
  assert.equal(bmPageResp.value.items.length, 1)
  assert.equal(bmPageResp.value.items[0].label, 'Chorus Drop')

  // 5. Lyrics: read current track lyrics & adjust lyric offset
  const lyricsResp = await sendRequestAndWait(host, {
    kind: 'query',
    requestId: 'req-lyrics-cur-1',
    epoch: host.epoch,
    name: 'player.lyrics',
    payload: {},
  })
  assert.equal(lyricsResp.ok, true, `lyricsResp failed: ${JSON.stringify(lyricsResp)}`)
  assert.match(lyricsResp.value.content.effective?.original ?? '', /Starlight falling/)

  const lyricsEditResp = await sendRequestAndWait(host, {
    kind: 'command',
    requestId: 'req-lyrics-edit-1',
    epoch: host.epoch,
    name: 'lyrics.edit',
    payload: {
      revision: lyricsResp.value.state.revision,
      edit: {
        kind: 'globalOffset',
        offsetMs: 250,
      },
    },
  })
  assert.equal(lyricsEditResp.ok, true, `lyricsEditResp failed: ${JSON.stringify(lyricsEditResp)}`)
  assert.equal(lyricsEditResp.value.preferences.globalOffsetMs, 250)

  await host.shutdown()
})

test('Portable MusicCore Phase 3: playlists, album/artist collections and EQ/DSP through the real Core in zero-Node sandbox', async () => {
  const portableCore = loadPortableCoreInIsolatedSandbox()
  const ports = createFakePorts()
  const dspApplied = []
  ports.audioEngine.setDspConfig = async (config) => {
    dspApplied.push(config)
  }

  const host = portableCore.createPortableMusicCoreHost({
    epoch: 'epoch-phase3-1',
    platform: 'android',
    clock: ports.clock,
    sessionStore: ports.sessionStore,
    audioEngine: ports.audioEngine,
    initialTracks: [
      {
        id: 'track-301',
        filePath: 'content://media/external/audio/media/301',
        title: 'Amber Horizon',
        artist: 'Aether Ensemble',
        album: 'Echoes of Dusk',
        duration: 240,
      },
      {
        id: 'track-302',
        filePath: 'content://media/external/audio/media/302',
        title: 'Silver Rain',
        artist: 'Aether Ensemble',
        album: 'Echoes of Dusk',
        duration: 200,
      },
      {
        id: 'track-303',
        filePath: 'content://media/external/audio/media/303',
        title: 'Midnight Pulse',
        artist: 'Kairo',
        album: 'Solstice',
        duration: 180,
      },
    ],
  })

  await host.initialize()

  // Collections aggregation
  const collections = host.getLibraryCollections()
  assert.equal(collections.albums.length, 2)
  assert.equal(collections.artists.length, 2)
  const duskAlbum = collections.albums.find((a) => a.title === 'Echoes of Dusk')
  assert.ok(duskAlbum)
  assert.equal(duskAlbum.trackCount, 2)
  assert.equal(duskAlbum.totalDurationSec, 440)

  // Playlists are owned by the Core playlist service ('playlists.edit')
  const track = (id) => host.queueStore.getTrack(id)
  let requestSeq = 0
  const editPlaylists = async (edit) => {
    const response = await sendRequestAndWait(host, {
      kind: 'command',
      requestId: `req-pl-${++requestSeq}`,
      epoch: host.epoch,
      name: 'playlists.edit',
      payload: { revision: host.playlists.getRevision(), edit },
    })
    assert.equal(response.ok, true, `playlists.edit failed: ${JSON.stringify(response)}`)
    return response.value
  }
  const created = await editPlaylists({ kind: 'create', name: 'Late Night Hi-Res' })
  const playlistId = created.result
  assert.equal(typeof playlistId, 'string')
  await editPlaylists({ kind: 'add', id: playlistId, tracks: [track('track-301'), track('track-302'), track('track-303')] })
  await editPlaylists({ kind: 'rename', id: playlistId, name: 'Audiophile Reference' })
  await editPlaylists({ kind: 'remove', id: playlistId, ids: ['track-302'] })
  const stored = host.getPlaylists().find((playlist) => playlist.id === playlistId)
  assert.equal(stored.name, 'Audiophile Reference')
  assert.deepEqual(Array.from(stored.trackIds), ['track-301', 'track-303'])

  // Equalizer / DSP configuration is applied by the engine before it commits
  const updatedEq = await host.setEqConfig({
    enabled: true,
    preset: 'Vocal',
    preampDb: -1.5,
    bitPerfect: false,
    gapless: true,
  })
  assert.equal(updatedEq.enabled, true)
  assert.equal(updatedEq.preset, 'Vocal')
  assert.equal(updatedEq.preampDb, -1.5)
  assert.equal(updatedEq.bandsDb.length, 10)
  assert.equal(updatedEq.bandsDb[4], 4.0)
  assert.equal(dspApplied.at(-1).preset, 'Vocal')

  ports.audioEngine.setDspConfig = async () => {
    throw new Error('IR missing')
  }
  await assert.rejects(host.setEqConfig({ preampDb: -6 }), /IR missing/)
  assert.equal(host.getEqConfig().preampDb, -1.5)

  await host.shutdown()
})
