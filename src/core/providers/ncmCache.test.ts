import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createNcmCache } from './ncmCache.ts'
import { SourceResources } from '../playback/sourceResources.ts'

async function fixture(
  t: test.TestContext,
  overrides: Partial<Parameters<typeof createNcmCache>[0]> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-cache-'))
  const cache = createNcmCache({ root: () => root, waitForStart: async () => {}, ...overrides })
  t.after(async () => {
    await cache.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return { root, cache }
}
const url = (id: number) => `https://cdn.example.invalid/${id}.wav?token=fixture`
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
function wav(): Uint8Array<ArrayBuffer> {
  const data = Buffer.alloc(44 + 1600)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24)
  data.writeUInt32LE(16000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(1600, 40)
  return Uint8Array.from(data)
}

test('cache remains delayed, supersedes an older resolution and waits for cancellation on shutdown', async (t) => {
  let fetches = 0
  const waits: AbortSignal[] = []
  const { cache, root } = await fixture(t, {
    waitForStart: (signal) =>
      new Promise((_resolve, reject) => {
        waits.push(signal)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    fetch: async () => {
      fetches++
      return new Response('bytes')
    }
  })
  const first = cache.cacheSong(1, url(1))
  const second = cache.cacheSong(2, url(2))
  assert.equal(waits[0].aborted, true)
  assert.equal(await first, null)
  assert.equal(fetches, 0)
  await cache.shutdown()
  assert.equal(await second, null)
  assert.equal(waits[1].aborted, true)
  assert.equal(fetches, 0)
  assert.deepEqual(await readdir(join(root, 'ncm-cache')), [])
  assert.equal(await cache.cacheSong(3, url(3)), null)
})

test('streaming writes publish only finished bytes and preserve cache hits without a new request', async (t) => {
  let calls = 0
  let body!: ReadableStreamDefaultController<Uint8Array>
  const { cache, root } = await fixture(t, {
    fetch: async () => {
      calls++
      return new Response(
        new ReadableStream({
          start(controller) {
            body = controller
          }
        }),
        { headers: { 'content-type': 'audio/flac' } }
      )
    }
  })
  const pending = cache.cacheSong(7, url(7))
  await tick()
  body.enqueue(new Uint8Array([1, 2, 3]))
  assert.equal(cache.getCachedSong(7), null)
  body.close()
  const path = await pending
  assert.ok(path)
  assert.match(path, /7\.[a-f0-9]+\.flac$/)
  assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]))
  assert.equal(cache.getCachedSong(7), path)
  assert.equal(await cache.cacheSong(7, url(7)), path)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(join(root, 'ncm-cache')), [path.split(/[\\/]/).at(-1)])
})

test('shutdown interrupts an active body and removes its partial file before resolving', async (t) => {
  let started!: () => void
  const fetching = new Promise<void>((resolve) => {
    started = resolve
  })
  const { cache, root } = await fixture(t, {
    fetch: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
              once: true
            })
            started()
          }
        })
      )
  })
  const pending = cache.cacheSong(8, url(8))
  await fetching
  await cache.shutdown()
  assert.equal(await pending, null)
  assert.deepEqual(await readdir(join(root, 'ncm-cache')), [])
})

test('legacy filenames, directory changes and externally deleted files keep their old meaning', async (t) => {
  let root = ''
  const fixtureResult = await fixture(t, { root: () => root })
  root = fixtureResult.root
  const cache = fixtureResult.cache
  await mkdir(join(root, 'ncm-cache'))
  const legacy = join(root, 'ncm-cache', '93.flac')
  await writeFile(legacy, 'legacy')
  await writeFile(join(root, 'ncm-cache', '94.flac.abandoned.part'), 'unfinished')
  assert.equal(cache.getCachedSong(93), legacy)
  assert.equal(cache.getCachedSong(94), null)
  await rm(legacy)
  assert.equal(cache.getCachedSong(93), null)
  root = join(root, 'new-root')
  assert.equal(cache.getCachedSong(93), null)
})

test('AutoMix prepares recognized complete audio and reuses the exact playback bytes', async (t) => {
  const bytes = wav()
  let calls = 0
  const { cache } = await fixture(t, {
    fetch: async () => {
      calls++
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    }
  })
  const path = await cache.prepareAutoMixSong(10, url(10), undefined, {
    expectedBytes: bytes.length
  })
  assert.ok(path)
  assert.deepEqual(await readFile(path), Buffer.from(bytes))
  assert.equal(cache.getCachedSong(10), path)
  assert.equal(await cache.prepareAutoMixSong(10, url(10), undefined, {}), path)
  assert.equal(calls, 1)
})

test('AutoMix cancellation aborts the active download and queued preparation at Core shutdown', async (t) => {
  let started!: () => void
  let calls = 0
  const fetching = new Promise<void>((resolve) => {
    started = resolve
  })
  const { cache, root } = await fixture(t, {
    fetch: async (_url, init) => {
      calls++
      started()
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      )
    }
  })
  const first = cache.prepareAutoMixSong(11, url(11), undefined, {})
  const second = cache.prepareAutoMixSong(12, url(12), undefined, {})
  const rejected = Promise.all([
    assert.rejects(first, /shutting down/),
    assert.rejects(second, /shutting down/)
  ])
  await fetching
  await cache.shutdown()
  await rejected
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(join(root, 'ncm-cache')), [])
})

test('scheduled pruning waits for prepared source adoption and keeps pinned native files above its budget', async (t) => {
  const resources = new SourceResources(),
    published = deferred(),
    acknowledge = deferred(),
    pins: string[] = [],
    pruning: Promise<unknown>[] = []
  const { cache, root } = await fixture(t, {
    fetch: async () => new Response(wav()),
    maxBytes: 0,
    maintainSources: (action) => {
      const work = resources.maintain(() => action(pins))
      pruning.push(work)
      return work
    }
  })
  const preparing = resources.use(async () => {
    const path = await cache.prepareAutoMixSong(20, url(20), undefined, {})
    assert.ok(path)
    published.resolve()
    await acknowledge.promise
    pins.push(process.platform === 'win32' ? path.toUpperCase() : path)
    return path
  })
  await published.promise
  assert.equal((await readdir(join(root, 'ncm-cache'))).length, 1)
  acknowledge.resolve()
  const path = await preparing
  await Promise.all(pruning)
  assert.deepEqual(await readFile(path), Buffer.from(wav()))
  pins.length = 0
  await cache.cacheSong(21, url(21))
  await Promise.all(pruning)
  assert.deepEqual(await readdir(join(root, 'ncm-cache')), [])
  assert.equal(cache.getCachedSong(20), null)
})

test('automatic pruning preserves an active writer part, even when its mtime looks orphaned', async (t) => {
  const entered = deferred(),
    pruning: Promise<unknown>[] = []
  let body!: ReadableStreamDefaultController<Uint8Array>
  const { cache, root } = await fixture(t, {
    maxBytes: 0,
    now: () => 10_000_000,
    maintainSources: (action) => {
      const work = Promise.resolve().then(() => action([]))
      pruning.push(work)
      return work
    },
    fetch: async (source) =>
      source === url(30)
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller
                controller.enqueue(wav().subarray(0, 44))
                entered.resolve()
              }
            })
          )
        : new Response(wav())
  })
  const preparing = cache.prepareAutoMixSong(30, url(30), undefined, {})
  await entered.promise
  let part: string | undefined
  for (let i = 0; i < 30 && !part; i++) {
    await tick()
    part = (await readdir(join(root, 'ncm-cache'))).find((name) => name.endsWith('.part'))
  }
  assert.ok(part)
  await utimes(join(root, 'ncm-cache', part), new Date(0), new Date(0))
  await cache.cacheSong(31, url(31))
  await Promise.all(pruning)
  assert.ok((await readdir(join(root, 'ncm-cache'))).includes(part))
  body.enqueue(wav().subarray(44))
  body.close()
  await preparing
  await Promise.all(pruning)
  assert.deepEqual(await readdir(join(root, 'ncm-cache')), [])
})

test('maintenance joins active and queued AutoMix work and delayed downloads before clearing, and gates new work', async (t) => {
  const entered = deferred(),
    clearing = deferred(),
    release = deferred(),
    waits: AbortSignal[] = []
  let calls = 0
  const { cache, root } = await fixture(t, {
    waitForStart: (signal) =>
      new Promise<void>((_resolve, reject) => {
        waits.push(signal)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    fetch: async (_source, init) => {
      calls++
      entered.resolve()
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      )
    }
  })
  const first = cache.prepareAutoMixSong(40, url(40), undefined, {}),
    second = cache.prepareAutoMixSong(41, url(41), undefined, {})
  const rejected = Promise.all([
    assert.rejects(first, /being cleared/),
    assert.rejects(second, /being cleared/)
  ])
  await entered.promise
  const delayed = cache.cacheSong(42, url(42))
  const work = cache.maintain(async () => {
    await rejected
    assert.equal(await delayed, null)
    assert.equal(waits[0].aborted, true)
    assert.deepEqual(await readdir(join(root, 'ncm-cache')), [])
    clearing.resolve()
    await release.promise
  })
  await clearing.promise
  const next = cache.cacheSong(43, url(43))
  await tick()
  assert.equal(waits.length, 1)
  assert.equal(calls, 1)
  release.resolve()
  await work
  await tick()
  assert.equal(waits.length, 2)
  await cache.shutdown()
  assert.equal(await next, null)
})

test('clear preserves current/preloaded paths and unrelated files, invalidates its index and releases after failure', async (t) => {
  const { cache, root } = await fixture(t),
    dir = cache.getNcmCacheDir()
  const current = join(dir, '50.flac'),
    preloaded = join(dir, '51.flac')
  await Promise.all([
    writeFile(current, 'current'),
    writeFile(preloaded, 'preloaded'),
    writeFile(join(dir, '52.flac'), 'stale'),
    writeFile(join(dir, 'old.part'), 'partial'),
    writeFile(join(root, 'unrelated.txt'), 'user data')
  ])
  assert.ok(cache.getCachedSong(52))
  assert.deepEqual(
    await cache.clear([process.platform === 'win32' ? current.toUpperCase() : current, preloaded]),
    { sizeBytes: 16 }
  )
  assert.deepEqual((await readdir(dir)).sort(), ['50.flac', '51.flac'])
  assert.equal(cache.getCachedSong(52), null)
  assert.equal(cache.getCachedSong(50), current)
  assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'user data')
  await assert.rejects(
    cache.maintain(async () => {
      throw new Error('clear failed')
    }),
    /clear failed/
  )
  assert.deepEqual(await cache.clear([]), { sizeBytes: 0 })
})

test('shutdown joins an active maintenance failure without preventing service cleanup', async (t) => {
  const { cache } = await fixture(t),
    entered = deferred(),
    release = deferred()
  const work = cache.maintain(async () => {
      entered.resolve()
      await release.promise
      throw new Error('failed cache removal')
    }),
    rejected = assert.rejects(work, /failed cache removal/)
  await entered.promise
  let stopped = false
  const stopping = cache.shutdown().then(() => {
    stopped = true
  })
  await tick()
  assert.equal(stopped, false)
  release.resolve()
  await Promise.all([rejected, stopping])
  assert.equal(stopped, true)
})

test('resolveCachedSong and cacheSong reuse verified disk caches across rotated NCM CDN URLs', async (t) => {
  const bytes = wav()
  let calls = 0
  const { cache, root } = await fixture(t, {
    fetch: async () => {
      calls++
      return new Response(bytes, { headers: { 'content-type': 'audio/wav' } })
    }
  })
  const firstUrl =
    'https://m701.music.126.net/20261116000000/0123456789abcdef0123456789abcdef/ymusic/obj/test/77.wav'
  const rotatedUrl =
    'https://m804.music.126.net/20261117001500/fedcba9876543210fedcba9876543210/ymusic/obj/test/77.wav'
  const saved = await cache.cacheSong(77, firstUrl)
  assert.ok(saved)
  assert.equal(calls, 1)

  assert.equal(cache.resolveCachedSong(77, rotatedUrl, undefined, { expectedBytes: bytes.length }), saved)
  assert.equal(cache.resolveCachedSong(77, rotatedUrl, undefined, { expectedBytes: bytes.length + 1 }), null)
  assert.equal(await cache.cacheSong(77, rotatedUrl), saved)
  assert.equal(await cache.prepareAutoMixSong(77, rotatedUrl, undefined, { expectedBytes: bytes.length }), saved)
  assert.equal(calls, 1)

  // Unhashed legacy files stay excluded from verified resolveCachedSong lookups, while
  // pre-existing hashed files (across Core restart) match exact size & extension even across URL changes.
  const dir = cache.getNcmCacheDir()
  const legacyPath = join(dir, '78.flac')
  await writeFile(legacyPath, bytes)
  const preExistingHashed = join(dir, '79.abcdef0123456789abcdef0123456789.wav')
  await writeFile(preExistingHashed, bytes)

  const restarted = createNcmCache({ root: () => root })
  try {
    assert.equal(
      restarted.resolveCachedSong(78, 'https://m801.music.126.net/a.flac', undefined, {
        expectedBytes: bytes.length
      }),
      null
    )
    assert.equal(
      restarted.resolveCachedSong(79, 'https://other.cdn.example/renamed/79.wav', undefined, {
        expectedBytes: bytes.length
      }),
      preExistingHashed
    )
    assert.equal(restarted.resolveCachedSong(77, rotatedUrl, undefined, { expectedBytes: bytes.length }), saved)
  } finally {
    await restarted.shutdown()
  }
  assert.equal(await readFile(join(root, 'ncm-cache', '79.abcdef0123456789abcdef0123456789.wav')).then((b) => b.length), bytes.length)
})
