import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from '../library/libraryDatabase.ts'
import { AfterglowLibraryQueueCore } from './afterglowLibraryQueueCore.ts'
import { afterglowNativeQueueItem } from './afterglowQueueCore.ts'
import type { AfterglowLibraryQueueCoreOptions } from './afterglowLibraryQueueCore.ts'
import type { PlayMode } from '../../shared/audioEngineTypes.ts'
import type { NativeQueueRebind } from '../../shared/nativeQueue.ts'
import { createAfterglowSourceResolver } from './afterglowSourceResolver.ts'
import { RemoteMediaGrantService, protectProviderMedia } from '../security/remoteMediaGrants.ts'
import { classifyAudioSource } from '../security/audioSourcePolicy.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(
  t: test.TestContext,
  count = 605,
  start = 0,
  mode: PlayMode = 'listLoop',
  remoteNext = false
) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'a',
        filePath: 'D:/Music/a.flac',
        title: 'A',
        duration: 60,
        cueRange: { startSeconds: 60, endSeconds: 120 },
        replayGainTrackGainDb: -4
      },
      {
        id: 'b',
        filePath: remoteNext ? 'ncm:b' : 'D:/Music/b.flac',
        source: remoteNext ? 'ncm' : 'local',
        title: 'B',
        duration: 60
      }
    ]
  })
  const ids = Array.from({ length: count }, (_, i) => (i % 2 ? 'b' : 'a'))
  let queue = db.createLibraryQueue({ ids: ids.slice(0, 1000), sort: 'playlist' })
  for (let offset = 1000; offset < count; offset += 1000)
    queue = db.editLibraryQueue(queue.id, queue.revision, {
      kind: 'insert',
      trackIds: ids.slice(offset, offset + 1000)
    }).queue
  const row = (position: number) => db.readLibraryQueue(queue.id, position, 1).items[0]
  queue = db.editLibraryQueue(queue.id, queue.revision, {
    kind: 'select',
    entryId: row(start).queueEntryId
  }).queue
  const entry = row(start)
  const errors: string[] = [],
    requests: NativeQueueRebind[] = [],
    reads: number[] = [],
    resolved: string[] = []
  let clock = 1_000
  const engine = {
    ended: false,
    continued: [] as string[],
    token: 'native',
    items: [
      afterglowNativeQueueItem(
        { ...entry.track, queueEntryId: entry.queueEntryId },
        entry.track!.filePath,
        start,
        mode !== 'repeat' && start === count - 1
      )
    ],
    info: {
      state: 'playing',
      queueIndex: 0,
      source: entry.track!.filePath,
      position: 12,
      duration: 60,
      volume: 0.7,
      playbackRate: 1.25,
      playMode: 'sequential'
    } as Awaited<ReturnType<AfterglowLibraryQueueCoreOptions['engine']['getPlaybackInfo']>>,
    getQueueToken() {
      return this.token
    },
    getQueueSnapshot() {
      return this.items.map((item) => ({ ...item }))
    },
    async getPlaybackInfo() {
      return { ...this.info }
    },
    getPlaybackEnd() {
      return this.ended && this.info.state === 'stopped'
        ? {
            intent: 1,
            selection: {
              queueToken: this.token,
              index: this.info.queueIndex,
              id: this.items[this.info.queueIndex].id,
              source: this.info.source
            }
          }
        : null
    },
    async continueAfterPlaybackEnd(
      request: Parameters<AfterglowLibraryQueueCoreOptions['engine']['continueAfterPlaybackEnd']>[0]
    ) {
      if (
        !request.isCurrent() ||
        JSON.stringify(request.expected) !== JSON.stringify(this.getPlaybackEnd())
      )
        return false
      this.continued.push(request.item.queueEntryId!)
      this.items = [request.item]
      this.token += ':continue'
      this.info.queueIndex = 0
      request.onSelected()
      this.ended = false
      this.info = {
        ...this.info,
        state: 'playing',
        position: 0,
        source: request.item.source,
        playMode: request.playMode
      }
      return true
    },
    async rebindQueue(request: NativeQueueRebind) {
      requests.push(request)
      if (
        request.expected.queueToken !== this.token ||
        request.expected.index !== this.info.queueIndex
      )
        return null
      assert.equal(request.items[0].queueEntryId, this.items[this.info.queueIndex].queueEntryId)
      assert.deepEqual(request.items[0].cueRange, this.items[this.info.queueIndex].cueRange)
      this.items = request.items
      this.token += ':rebind'
      this.info.queueIndex = 0
      this.info.playMode = request.playMode
      return { queueToken: this.token }
    }
  }
  let mapping = [start]
  const options: AfterglowLibraryQueueCoreOptions = {
    engine,
    nativeQueueIndices: mapping,
    async readWindow(index, entryId, current) {
      if (!current()) return null
      queue = db.getLibraryQueue(queue.id)
      if (queue.selectedEntryId !== entryId)
        queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId }).queue
      const window = db.readLibraryQueuePlaybackWindow(
        queue.id,
        queue.revision,
        index,
        mode === 'listLoop' || mode === 'shuffle'
      )
      reads.push(window.items.length)
      return { window, mode }
    },
    async validateWindow(plan) {
      return (
        db.getLibraryQueue(queue.id).revision === plan.window.queue.revision && plan.mode === mode
      )
    },
    resolver: {
      resolve: async (track) => {
        const item = track as { queueEntryId: string; filePath: string }
        resolved.push(item.queueEntryId)
        return { source: item.filePath, expiresAt: null }
      }
    },
    authorize: async (source) => source,
    commit: async (operation, current) => {
      if (current()) await operation()
    },
    onMappingChanged: (next) => {
      mapping = [...next]
    },
    onPlaybackAdvanced: async (_info, position, entryId) => {
      assert.equal(engine.items[0].queueEntryId, entryId)
      assert.equal(core.getMapping()[0], position)
      queue = db.getLibraryQueue(queue.id)
      queue = db.editLibraryQueue(queue.id, queue.revision, { kind: 'select', entryId }).queue
    },
    onError: (message) => errors.push(message),
    now: () => clock
  }
  const core = new AfterglowLibraryQueueCore(options)
  t.after(() => core.stop())
  return {
    db,
    engine,
    options,
    core,
    errors,
    reads,
    requests,
    resolved,
    row,
    queue: () => db.getLibraryQueue(queue.id),
    mapping: () => mapping,
    mode: (value: PlayMode) => {
      mode = value
    },
    clock: (value: number) => {
      clock = value
    },
    advance: () => {
      assert.equal(engine.items.length, 2)
      engine.info.queueIndex = 1
      engine.info.source = engine.items[1].source
      engine.info.position = 0
    }
  }
}

test('SQL traversal compacts current + successor, preserves duplicate CUE identity, and wraps the whole queue with bounded state', async (t) => {
  const f = fixture(t)
  await f.core.start()
  for (let index = 0; index < 620; index++) {
    const logical = index % 605
    assert.deepEqual(f.core.getMapping(), [logical, (logical + 1) % 605])
    assert.equal(f.engine.items[0].queueEntryId, f.row(logical).queueEntryId)
    assert.equal(f.engine.info.playMode, 'sequential')
    assert.equal(f.engine.items.length, 2)
    assert.equal(f.engine.items[0].logicalQueueEnd, logical === 604)
    assert.equal(f.engine.items[1].logicalQueueEnd, (logical + 1) % 605 === 604)
    f.advance()
    await f.core.tick()
  }
  assert.deepEqual(f.errors, [])
  assert.ok(f.reads.every((size) => size <= 2))
  assert.equal(f.engine.info.volume, 0.7)
  assert.equal(f.engine.info.playbackRate, 1.25)
  const retained = f.core as unknown as { source: { key: string }; retry: unknown }
  assert.equal(typeof retained.source.key, 'string')
  assert.equal(retained.retry, null)
})

test('indexed SQL successor skips 2003 missing occurrences and sequential stops at the global end', async (t) => {
  const f = fixture(t, 2005, 0, 'sequential')
  f.db.sql
    .prepare('UPDATE queue_entries SET track_id=? WHERE queue_id=? AND position BETWEEN 1 AND 2003')
    .run('missing', f.queue().id)
  await f.core.start()
  assert.deepEqual(f.core.getMapping(), [0, 2004])
  f.advance()
  await f.core.tick()
  assert.deepEqual(f.core.getMapping(), [2004])
  assert.equal(f.engine.info.playMode, 'sequential')
  assert.deepEqual(f.errors, [])
})

test('SQL shuffle follows its persisted order across the global boundary instead of looping its native subset', async (t) => {
  const f = fixture(t, 605, 0, 'shuffle')
  const queue = f.queue()
  f.db.editLibraryQueue(queue.id, queue.revision, { kind: 'order', order: 'shuffle' })
  await f.core.start()
  for (let i = 0; i < 606; i++) {
    const logical = i % 605
    assert.equal(f.engine.items[0].queueEntryId, f.row(logical).queueEntryId)
    f.advance()
    await f.core.tick()
  }
  assert.deepEqual(f.errors, [])
  assert.equal(f.queue().order, 'shuffle')
})

test('repeat and singleton loops rebind without replaying or changing paused position, CUE, rate or volume', async (t) => {
  for (const mode of ['repeat', 'listLoop', 'shuffle'] as const) {
    const f = fixture(t, 1, 0, mode)
    f.engine.info.state = 'paused'
    await f.core.start()
    assert.equal(f.engine.info.playMode, 'repeat')
    assert.equal(f.engine.items[0].logicalQueueEnd, mode !== 'repeat')
    assert.equal(f.engine.info.state, 'paused')
    assert.equal(f.engine.info.position, 12)
    assert.equal(f.engine.info.playbackRate, 1.25)
    assert.deepEqual(f.mapping(), [0])
    assert.equal(f.resolved.length, 0)
  }
})

test('missing or wrong logical EOF metadata is repaired by conditional rebind without replay', async (t) => {
  for (const marker of [undefined, true]) {
    const f = fixture(t)
    f.engine.items[0].logicalQueueEnd = marker
    await f.core.start()
    assert.equal(f.requests[0].items[0].logicalQueueEnd, false)
    assert.equal(f.engine.items[0].logicalQueueEnd, false)
    assert.equal(f.engine.info.position, 12)
    assert.equal(f.engine.info.state, 'playing')
    assert.deepEqual(f.engine.continued, [])
    assert.deepEqual(f.errors, [])
  }
})

test('SQL last playable occurrence completes the logical cycle even with trailing holes', async (t) => {
  for (const mode of ['sequential', 'listLoop', 'shuffle', 'repeat'] as const) {
    const f = fixture(t, 605, 602, mode)
    f.db.sql
      .prepare('UPDATE queue_entries SET track_id=? WHERE queue_id=? AND position>=603')
      .run('missing', f.queue().id)
    await f.core.start()
    assert.equal(f.engine.items[0].logicalQueueEnd, mode !== 'repeat')
    assert.deepEqual(
      f.core.getMapping(),
      mode === 'listLoop' || mode === 'shuffle' ? [602, 0] : [602]
    )
    assert.deepEqual(f.errors, [])
  }
})

test('a looping legacy native window is made sequential before a slow successor read', async (t) => {
  const f = fixture(t)
  const started = deferred<void>(),
    reply = deferred<null>()
  f.engine.info.playMode = 'listLoop'
  f.options.resolver.resolve = async () => {
    started.resolve()
    return reply.promise
  }
  const run = f.core.start()
  await started.promise
  assert.equal(f.engine.info.playMode, 'sequential')
  assert.equal(f.engine.info.position, 12)
  await f.core.stop()
  reply.resolve(null)
  await run
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.errors, [])
})

test('stop cancels delayed SQL and provider work without waiting or authorizing its result', async (t) => {
  for (const stage of ['sql', 'provider']) {
    const f = fixture(t)
    const started = deferred<void>(),
      reply = deferred<void>()
    let authorized = 0
    f.options.authorize = async (source) => {
      authorized++
      return source
    }
    if (stage === 'sql') {
      const read = f.options.readWindow
      f.options.readWindow = async (...args) => {
        started.resolve()
        await reply.promise
        return read(...args)
      }
    } else
      f.options.resolver.resolve = async () => {
        started.resolve()
        await reply.promise
        return { source: 'D:/Music/b.flac', expiresAt: null }
      }
    const run = f.core.start()
    await started.promise
    await f.core.stop()
    reply.resolve()
    await run
    assert.equal(authorized, 0)
    assert.equal(f.requests.length, 0)
  }
})

test('stop drains dispatched rebind and publishes its confirmed mapping for the next owner', async (t) => {
  const f = fixture(t)
  const started = deferred<void>(),
    reply = deferred<void>()
  const rebind = f.engine.rebindQueue.bind(f.engine)
  f.engine.rebindQueue = async (request) => {
    started.resolve()
    await reply.promise
    return rebind(request)
  }
  const run = f.core.start()
  await started.promise
  let stopped = false
  const drain = f.core.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(stopped, false)
  reply.resolve()
  await Promise.all([run, drain])
  assert.deepEqual(f.core.getMapping(), [0, 1])
  assert.deepEqual(f.mapping(), [0, 1])
  assert.deepEqual(f.engine.continued, [])
  assert.deepEqual(f.errors, [])
})

test('a delayed provider cannot reset the successor that already started at EOF', async (t) => {
  const f = fixture(t)
  await f.core.start()
  f.clock(2_000)
  // Invalidate the library revision to force source revalidation.
  f.db.patchTracks([
    { id: 'a', expectedVersion: f.db.getTracksByIds(['a']).versions.a, patch: { title: 'Changed' } }
  ])
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/b.flac', expiresAt: null }
  }
  const run = f.core.tick()
  await started.promise
  f.advance()
  const count = f.requests.length
  reply.resolve()
  await run
  assert.equal(f.requests.length, count)
  assert.equal(f.engine.info.queueIndex, 1)
})

test('URL expiry refreshes only the successor and retries authorization failures with one bounded slot', async (t) => {
  const f = fixture(t)
  let resolves = 0
  f.options.resolver.resolve = async () => ({
    source: `https://cdn.example/${++resolves}`,
    expiresAt: 181_000
  })
  await f.core.start()
  f.clock(40_000)
  await f.core.tick()
  assert.equal(resolves, 1)
  f.clock(70_000)
  await f.core.tick()
  assert.equal(resolves, 2)
  assert.equal(f.engine.items[0].source, 'D:/Music/a.flac')
  assert.equal(f.engine.items[1].source, 'https://cdn.example/2')
  f.clock(110_000)
  f.options.authorize = async () => {
    throw new Error('authorization revoked')
  }
  await f.core.tick()
  await f.core.tick()
  assert.equal(resolves, 3)
  assert.equal(f.errors.length, 1)
  assert.equal(f.engine.items[1].source, 'https://cdn.example/2')
})

test('SQL successor uses real provider audio protection and grant resolution before native dispatch', async (t) => {
  const f = fixture(t, 605, 0, 'listLoop', true)
  const grants = new RemoteMediaGrantService()
  f.options.resolver = createAfterglowSourceResolver({
    grants,
    quality: 'auto',
    callProvider: async (_id, _method, args) => {
      assert.equal((args[0] as { queueEntryId: string }).queueEntryId, f.row(1).queueEntryId)
      return protectProviderMedia(
        {
          streamUrl: 'https://cdn.example/authorized.flac',
          providerSource: { expiresAt: Date.now() + 180_000 }
        },
        'getPlaybackUrl',
        grants
      )
    }
  })
  f.options.authorize = async (source) => classifyAudioSource(source).source
  await f.core.start()
  assert.equal(f.engine.items[1].source, 'https://cdn.example/authorized.flac')
  assert.equal(f.engine.items[1].queueEntryId, f.row(1).queueEntryId)
  assert.equal(f.engine.items[0].source, 'D:/Music/a.flac')
  assert.deepEqual(f.errors, [])
  assert.ok(f.reads.every((size) => size <= 2))
})

test('authorization, SQL validation, playback read and lane delays cannot dispatch expired successors or spin retries', async (t) => {
  for (const delay of ['authorization', 'validation', 'playback-read', 'lane']) {
    const f = fixture(t)
    let calls = 0,
      delayed = false,
      infoReads = 0
    f.options.resolver.resolve = async () => ({
      source: `https://cdn.example/${++calls}.flac`,
      expiresAt: calls === 1 ? 2_000 : 90_000
    })
    const expire = () => {
      if (!delayed) {
        delayed = true
        f.clock(2_000)
      }
    }
    if (delay === 'authorization')
      f.options.authorize = async (source) => {
        expire()
        return source
      }
    if (delay === 'validation') {
      const validate = f.options.validateWindow
      f.options.validateWindow = async (plan) => {
        expire()
        return validate(plan)
      }
    }
    if (delay === 'playback-read') {
      const read = f.engine.getPlaybackInfo.bind(f.engine)
      f.engine.getPlaybackInfo = async () => {
        if (++infoReads === 2) expire()
        return read()
      }
    }
    if (delay === 'lane')
      f.options.commit = async (operation) => {
        expire()
        await operation()
      }
    await f.core.start()
    for (let i = 0; i < 50; i++) await f.core.tick()
    assert.equal(f.requests.length, 0, delay)
    assert.equal(calls, 1, delay)
    assert.equal(f.errors.length, 1, delay)
    assert.equal(f.core.isActive(), true, 'expiry is not an unknown native outcome')
    f.clock(32_000)
    await f.core.tick()
    assert.equal(calls, 2, delay)
    assert.equal(f.engine.items[1].source, 'https://cdn.example/2.flac', delay)
  }
})

test('expired resident successor is removed without invalidating the open current decoder while refresh is unavailable', async (t) => {
  const f = fixture(t)
  let calls = 0
  f.options.resolver.resolve = async () =>
    ++calls === 1 ? { source: 'https://cdn.example/short.flac', expiresAt: 2_000 } : null
  await f.core.start()
  f.clock(3_000)
  await f.core.tick()
  for (let i = 0; i < 50; i++) await f.core.tick()
  assert.equal(f.engine.items.length, 1)
  assert.equal(f.engine.info.state, 'playing')
  assert.equal(f.engine.info.position, 12)
  assert.equal(f.engine.items[0].source, 'D:/Music/a.flac')
  assert.equal(calls, 2)
  assert.equal(f.errors.length, 1)
})

test('slow EOF recovery rechecks expiry after preview/lane waits and through the native continuation predicate', async (t) => {
  for (const delay of ['authorization', 'validation', 'lane', 'continuation']) {
    const f = fixture(t)
    f.engine.ended = true
    f.engine.info.state = 'stopped'
    let calls = 0
    f.options.resolver.resolve = async () => {
      calls++
      return { source: 'https://cdn.example/short.flac', expiresAt: 2_000 }
    }
    if (delay === 'authorization')
      f.options.authorize = async (source) => {
        f.clock(2_000)
        return source
      }
    if (delay === 'validation')
      f.options.validateWindow = async () => {
        f.clock(2_000)
        return true
      }
    if (delay === 'lane')
      f.options.commit = async (operation) => {
        f.clock(2_000)
        await operation()
      }
    if (delay === 'continuation') {
      const advance = f.engine.continueAfterPlaybackEnd.bind(f.engine)
      f.engine.continueAfterPlaybackEnd = async (request) => {
        f.clock(2_000)
        return advance(request)
      }
    }
    await f.core.start()
    for (let i = 0; i < 50; i++) await f.core.tick()
    assert.equal(f.engine.continued.length, 0, delay)
    assert.equal(calls, 1, delay)
    assert.equal(f.errors.length, 1, delay)
    assert.equal(f.core.isActive(), true)
  }
})

test('stopping SQL maintenance aborts the actual pending provider request without waiting for its timeout', async (t) => {
  const f = fixture(t, 605, 0, 'listLoop', true)
  const started = deferred<void>()
  let signal: AbortSignal | undefined
  f.options.resolver = createAfterglowSourceResolver({
    quality: 'auto',
    callProvider: async (_id, _method, _args, options) => {
      signal = options.signal
      started.resolve()
      return new Promise(() => {})
    }
  })
  const pending = f.core.start()
  await started.promise
  await f.core.stop()
  await pending
  assert.equal(signal?.aborted, true)
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.errors, [])
})

test('72 hours of failed-provider event storms retain a single retry slot and enforce 30-second backoff', async (t) => {
  const f = fixture(t)
  let calls = 0
  f.options.resolver.resolve = async () => {
    calls++
    return null
  }
  await f.core.start()
  for (let seconds = 15; seconds <= 72 * 60 * 60; seconds += 15) {
    f.clock(1_000 + seconds * 1_000)
    await Promise.all(Array.from({ length: 20 }, () => f.core.tick()))
  }
  assert.equal(calls, 1 + 72 * 120)
  assert.equal(f.errors.length, calls)
  assert.equal(f.engine.items.length, 1)
  assert.deepEqual(f.core.getMapping(), [0])
  const state = f.core as unknown as { source: unknown; retry: unknown; rejected: unknown }
  assert.equal(state.source, null)
  assert.ok(state.retry && !Array.isArray(state.retry))
  assert.equal(state.rejected, null)
})

test('unknown rebind outcomes stop maintenance without replay or fallback transport', async (t) => {
  const f = fixture(t)
  let calls = 0
  f.engine.rebindQueue = async () => {
    calls++
    throw new Error('lost native reply')
  }
  await f.core.start()
  await f.core.tick()
  assert.equal(calls, 1)
  assert.equal(f.core.isActive(), false)
  assert.deepEqual(f.errors, ['lost native reply'])
})

test('a refused or unsupported rebind is not retried until its cursor or revision changes', async (t) => {
  const f = fixture(t)
  let calls = 0
  f.engine.rebindQueue = async () => {
    calls++
    return null
  }
  await f.core.start()
  await f.core.tick()
  f.clock(100_000)
  await f.core.tick()
  assert.equal(calls, 1)
  assert.deepEqual(f.errors, ['afterglow_library_queue_changed'])
  f.engine.token = 'new transport'
  await f.core.tick()
  assert.equal(calls, 2)
})

test('a queued commit can be cancelled without making stop wait for an unrelated transport', async (t) => {
  const f = fixture(t)
  const queued = deferred<void>(),
    release = deferred<void>()
  f.options.commit = async (operation, current) => {
    queued.resolve()
    await release.promise
    if (current()) await operation()
  }
  const run = f.core.start()
  await queued.promise
  await f.core.stop()
  release.resolve()
  await run
  assert.equal(f.requests.length, 0)
})

test('a source arriving after natural EOF starts the exact SQL successor once, then restores bounded lookahead', async (t) => {
  const f = fixture(t, 605, 604)
  const started = deferred<void>(),
    reply = deferred<void>()
  let calls = 0
  f.options.resolver.resolve = async (track) => {
    if (++calls === 1) {
      started.resolve()
      await reply.promise
    }
    return { source: (track as { filePath: string }).filePath, expiresAt: null }
  }
  const run = f.core.start()
  await started.promise
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  f.engine.info.position = 60
  assert.equal(f.core.getPlaybackEndRecoveryDeadline(), 31_000)
  reply.resolve()
  await run
  assert.deepEqual(f.engine.continued, [f.row(0).queueEntryId])
  assert.equal(f.queue().index, 0)
  assert.equal(f.queue().selectedEntryId, f.row(0).queueEntryId)
  assert.deepEqual(f.core.getMapping(), [0, 1])
  assert.deepEqual(f.engine.items[0].cueRange, f.row(0).track!.cueRange)
  assert.equal(f.engine.info.position, 0)
  assert.equal(f.engine.info.volume, 0.7)
  assert.equal(f.engine.info.playbackRate, 1.25)
  assert.deepEqual(f.errors, [])
  await f.core.tick()
  assert.equal(f.engine.continued.length, 1)
  assert.ok(f.reads.every((size) => size <= 2))
})

test('late sources do not auto-play a manual stop or pause, and cancellation revokes natural EOF work', async (t) => {
  for (const action of ['stop', 'pause', 'restore'] as const) {
    const f = fixture(t)
    const started = deferred<void>(),
      reply = deferred<void>()
    f.options.resolver.resolve = async (track) => {
      started.resolve()
      await reply.promise
      return { source: (track as { filePath: string }).filePath, expiresAt: null }
    }
    const run = f.core.start()
    await started.promise
    f.engine.info.state = action === 'pause' ? 'paused' : 'stopped'
    f.engine.ended = action === 'restore'
    if (action === 'restore') await f.core.stop()
    reply.resolve()
    await run
    assert.equal(f.engine.continued.length, 0)
  }
})

test('refused lookahead may recover at natural EOF without retrying or reloading the active decoder', async (t) => {
  const f = fixture(t)
  f.engine.rebindQueue = async (request) => {
    f.requests.push(request)
    return null
  }
  await f.core.start()
  await f.core.tick()
  assert.equal(f.requests.length, 1)
  assert.equal(f.engine.continued.length, 0)
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  await f.core.tick()
  assert.deepEqual(f.engine.continued, [f.row(1).queueEntryId])
  assert.equal(f.queue().index, 1)
})

test('SQL EOF policy preserves sequential global end, repeat, singleton loops and persisted shuffle successors', async (t) => {
  for (const mode of ['sequential', 'repeat', 'listLoop', 'shuffle'] as const) {
    const f = fixture(t, mode === 'listLoop' ? 1 : 605, 0, mode)
    if (mode === 'shuffle') {
      const q = f.queue()
      f.db.editLibraryQueue(q.id, q.revision, { kind: 'order', order: 'shuffle' })
    }
    if (mode === 'sequential') {
      const q = f.queue()
      f.db.editLibraryQueue(q.id, q.revision, { kind: 'select', entryId: f.row(604).queueEntryId })
      f.engine.items[0] = afterglowNativeQueueItem(
        { ...f.row(604).track, queueEntryId: f.row(604).queueEntryId },
        f.row(604).track!.filePath,
        604
      )
      f.options.nativeQueueIndices = [604]
      // The replacement core starts at the exact SQL terminal occurrence.
      await f.core.stop()
      const terminal = new AfterglowLibraryQueueCore(f.options)
      f.engine.ended = true
      f.engine.info.state = 'stopped'
      await terminal.start()
      assert.equal(f.engine.continued.length, 0)
      assert.equal(terminal.getPlaybackEndRecoveryDeadline(), null)
      await terminal.stop()
      continue
    }
    f.engine.ended = true
    f.engine.info.state = 'stopped'
    await f.core.start()
    const expected = mode === 'shuffle' ? 1 : 0
    assert.deepEqual(f.engine.continued, [f.row(expected).queueEntryId])
    assert.equal(f.queue().index, expected)
  }
})

test('the EOF grace is finite even while the provider is pending; a late result cannot extend it', async (t) => {
  const f = fixture(t)
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/b.flac', expiresAt: null }
  }
  const run = f.core.start()
  await started.promise
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  assert.equal(f.core.getPlaybackEndRecoveryDeadline(), 31_000)
  f.clock(31_001)
  reply.resolve()
  await run
  await f.core.tick()
  assert.equal(f.core.getPlaybackEndRecoveryDeadline(), 31_000)
  assert.equal(f.engine.continued.length, 0)
})

test('SQL changes during EOF resolution reject the stale target before native continuation', async (t) => {
  const f = fixture(t)
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  const started = deferred<void>(),
    reply = deferred<void>()
  f.options.resolver.resolve = async () => {
    started.resolve()
    await reply.promise
    return { source: 'D:/Music/b.flac', expiresAt: null }
  }
  const run = f.core.start()
  await started.promise
  const q = f.queue()
  f.db.editLibraryQueue(q.id, q.revision, { kind: 'remove', entryIds: [f.row(1).queueEntryId] })
  reply.resolve()
  await run
  assert.equal(f.engine.continued.length, 0)
})

test('unknown native or SQL continuation outcomes suspend without reloading or replaying', async (t) => {
  for (const boundary of ['native', 'sql']) {
    const f = fixture(t)
    f.engine.ended = true
    f.engine.info.state = 'stopped'
    if (boundary === 'native')
      f.engine.continueAfterPlaybackEnd = async () => {
        throw new Error('lost continuation reply')
      }
    else
      f.options.onPlaybackAdvanced = async () => {
        throw new Error('lost cursor reply')
      }
    await f.core.start()
    await f.core.tick()
    assert.equal(f.core.isActive(), false)
    assert.equal(f.errors.length, 1)
    assert.equal(f.engine.continued.length, boundary === 'native' ? 0 : 1)
  }
})

test('restore drains an issued continuation and its SQL cursor, retaining the confirmed occurrence without more lookahead', async (t) => {
  const f = fixture(t)
  f.engine.ended = true
  f.engine.info.state = 'stopped'
  const started = deferred<void>(),
    reply = deferred<void>()
  const advance = f.engine.continueAfterPlaybackEnd.bind(f.engine)
  f.engine.continueAfterPlaybackEnd = async (request) => {
    const result = await advance(request)
    started.resolve()
    await reply.promise
    return result
  }
  const run = f.core.start()
  await started.promise
  let drained = false
  const stopping = f.core.stop().then(() => {
    drained = true
  })
  await Promise.resolve()
  assert.equal(drained, false)
  reply.resolve()
  await Promise.all([run, stopping])
  assert.equal(f.engine.continued.length, 1)
  assert.equal(f.queue().index, 1)
  assert.deepEqual(f.core.getMapping(), [1])
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.errors, [])
})
