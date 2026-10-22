import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { downloadEntryToCache } from './networkCache.ts'
import { clearDirectory, getDirectorySize } from './networkCache.ts'
import { createWebDavAdapter } from './adapters/webdavAdapter.ts'
import { buildNetworkEntryId } from './networkPath.ts'
import { normalizeEntry } from './networkEntryInput.ts'
import type { NetworkEntry, NetworkSourceProfile } from '../../shared/networkSources.ts'
import type { NetworkSourceSession } from './adapters/types.ts'

const FLAC_BYTES = Buffer.from('FLAC-CACHE-DATA-0123456789')
let server: Server
let getCount = 0
let rangeRequestSeen = false
let ignoreRangeRequests = false
let invalidRangeResponse = false
let basePort = 0

function makeProfile(): NetworkSourceProfile {
  return {
    id: 'p1',
    protocol: 'webdav',
    name: 'Cache NAS',
    host: '127.0.0.1',
    port: basePort,
    rootPath: '/music',
    credential: { kind: 'anonymous', encryptedId: '' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 10_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null
  }
}

function makeEntry(path = '/music/a.flac', sizeBytes = FLAC_BYTES.length): NetworkEntry {
  return {
    id: buildNetworkEntryId('webdav', 'p1', path),
    profileId: 'p1',
    name: 'a.flac',
    kind: 'audio',
    path,
    sizeBytes
  }
}

test.before(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/music/a.flac') {
      getCount += 1
      const range = req.headers.range
      const match = typeof range === 'string' ? /^bytes=(\d+)-/.exec(range) : null
      if (match) {
        rangeRequestSeen = true
        if (ignoreRangeRequests) {
          res.writeHead(200, { 'Content-Length': FLAC_BYTES.length })
          res.end(FLAC_BYTES)
          return
        }
        const start = Number(match[1])
        const body = FLAC_BYTES.subarray(start)
        res.writeHead(206, {
          'Content-Length': body.length,
          'Content-Range': `bytes ${invalidRangeResponse ? 0 : start}-${FLAC_BYTES.length - 1}/${FLAC_BYTES.length}`
        })
        res.end(invalidRangeResponse ? FLAC_BYTES.subarray(0, body.length) : body)
        return
      }
      res.writeHead(200, { 'Content-Length': FLAC_BYTES.length })
      res.end(FLAC_BYTES)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  basePort = (server.address() as { port: number }).port
})

test.after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

test('downloadEntryToCache streams a remote file into a hashed cache path once', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  try {
    const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
    const first = await downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    assert.equal((await readFile(first)).toString(), FLAC_BYTES.toString())
    assert.match(first, /[0-9a-f]{64}\.flac$/)

    const second = await downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    assert.equal(second, first)
    assert.equal(getCount, 1, '已缓存文件不应重复下载')
    await session.close()
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test('downloadEntryToCache rejects a download whose declared size does not match', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  const before = getCount
  try {
    const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
    await downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    const staleEntry = { ...makeEntry(), sizeBytes: 9999 }
    await assert.rejects(() => downloadEntryToCache({ session, entry: staleEntry, cacheRoot }), {
      code: 'network'
    })
    assert.equal(getCount, before + 2)
    await session.close()
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test('cache size reflects downloaded bytes and clearDirectory empties it', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  try {
    const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
    await downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    const size = await getDirectorySize(cacheRoot)
    assert.equal(size, FLAC_BYTES.length)
    await clearDirectory(cacheRoot)
    assert.equal(await getDirectorySize(cacheRoot), 0)
    await session.close()
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test('downloadEntryToCache resumes from a partial file via byte range', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  try {
    rangeRequestSeen = false
    const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
    const entry = makeEntry()
    const partPath = join(cacheRoot, `${entry.id}.flac.part`)
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(partPath, FLAC_BYTES.subarray(0, 5))
    const target = await downloadEntryToCache({ session, entry, cacheRoot })
    assert.equal((await readFile(target)).toString(), FLAC_BYTES.toString())
    assert.equal(rangeRequestSeen, true, '续传应发送 Range 请求')
    await session.close()
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test('downloadEntryToCache resets a partial file when a server ignores Range', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  try {
    rangeRequestSeen = false
    ignoreRangeRequests = true
    const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
    const entry = normalizeEntry(makeEntry())
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(join(cacheRoot, `${entry.id}.flac.part`), FLAC_BYTES.subarray(0, 5))
    const target = await downloadEntryToCache({ session, entry, cacheRoot })
    assert.deepEqual(await readFile(target), FLAC_BYTES)
    assert.equal(rangeRequestSeen, true)
    await session.close()
  } finally {
    ignoreRangeRequests = false
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test('unknown-size IPC entries restart partial downloads without appending', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
  t.after(() => session.close())
  const entry = normalizeEntry({ ...makeEntry(), sizeBytes: undefined })
  await writeFile(join(cacheRoot, `${entry.id}.flac.part`), FLAC_BYTES.subarray(0, 5))
  rangeRequestSeen = false
  const target = await downloadEntryToCache({ session, entry, cacheRoot })
  assert.deepEqual(await readFile(target), FLAC_BYTES)
  assert.equal(rangeRequestSeen, false)
})

test('cache rejects path-like keys before creating any files', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
  t.after(() => session.close())
  for (const id of ['../escaped', '..\\escaped', '/absolute', 'C:\\absolute', 'a:stream']) {
    await assert.rejects(
      downloadEntryToCache({ session, entry: normalizeEntry({ ...makeEntry(), id }), cacheRoot }),
      { code: 'denied' }
    )
  }
  assert.equal(await getDirectorySize(cacheRoot), 0)
})

test('playback DTO rejects invalid sizes and entry kinds', () => {
  for (const sizeBytes of [-1, NaN, Infinity, 1.5, '10']) {
    assert.throws(() => normalizeEntry({ ...makeEntry(), sizeBytes }), /invalid entry size/)
  }
  assert.throws(() => normalizeEntry({ ...makeEntry(), kind: 'unknown' }), /invalid entry kind/)
  assert.equal(normalizeEntry({ ...makeEntry(), sizeBytes: 0 }).sizeBytes, 0)
})

test('a wrong Content-Range cannot publish same-size but incorrect resumed bytes', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  const session = await createWebDavAdapter().createSession(makeProfile(), { kind: 'anonymous' })
  t.after(() => session.close())
  const entry = normalizeEntry(makeEntry())
  await writeFile(join(cacheRoot, `${entry.id}.flac.part`), FLAC_BYTES.subarray(0, 5))
  invalidRangeResponse = true
  t.after(() => {
    invalidRangeResponse = false
  })
  const target = await downloadEntryToCache({ session, entry, cacheRoot })
  assert.deepEqual(await readFile(target), FLAC_BYTES)
})

test('concurrent consumers wait for one cache writer instead of resuming its active partial file', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-concurrent-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  let reads = 0
  const session: NetworkSourceSession = {
    protocol: 'webdav',
    list: async () => [],
    stat: async () => null,
    resolvePlaybackUrl: async () => null,
    close: async () => {},
    async readStream(_path, _signal, options) {
      reads++
      started()
      if (options?.start) return Readable.from([FLAC_BYTES.subarray(options.start)])
      return Readable.from(
        (async function* () {
          yield FLAC_BYTES.subarray(0, 5)
          await paused
          yield FLAC_BYTES.subarray(5)
        })()
      )
    }
  }
  const first = downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
  await reading
  const second = downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
  // Keep the first stream live long enough for the independent second caller
  // to reach the cache. Its partial file must remain owned by the first caller.
  await delay(30)
  release()
  const results = await Promise.allSettled([first, second])
  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled']
  )
  assert.equal(reads, 1)
  assert.deepEqual(await readFile((results[0] as PromiseFulfilledResult<string>).value), FLAC_BYTES)
})

test('cancelling a waiting cache consumer does not release the active writer to later consumers', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-cancel-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  let reads = 0
  const session: NetworkSourceSession = {
    protocol: 'webdav',
    list: async () => [],
    stat: async () => null,
    resolvePlaybackUrl: async () => null,
    close: async () => {},
    async readStream() {
      reads++
      started()
      return Readable.from(
        (async function* () {
          await paused
          yield FLAC_BYTES
        })()
      )
    }
  }
  const first = downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
  await reading
  const controller = new AbortController()
  const second = downloadEntryToCache({
    session,
    entry: makeEntry(),
    cacheRoot,
    signal: controller.signal
  })
  controller.abort()
  try {
    await assert.rejects(second, { code: 'timeout' })
    const third = downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    await delay(30)
    release()
    assert.deepEqual(await Promise.all([first, third]), [await first, await first])
    assert.equal(reads, 1)
  } finally {
    release()
    await first.catch(() => {})
  }
})

test('clearing old cache preserves active and queued downloads and their returned paths', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-clear-active-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  const entry = makeEntry()
  const partial = join(cacheRoot, `${entry.id}.flac.part`)
  await writeFile(join(cacheRoot, 'old.flac'), 'old cache')
  await writeFile(join(cacheRoot, 'old.flac.part'), 'abandoned partial')
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  const session: NetworkSourceSession = {
    protocol: 'webdav',
    list: async () => [],
    stat: async () => null,
    resolvePlaybackUrl: async () => null,
    close: async () => {},
    async readStream() {
      reads++
      return Readable.from(
        (async function* () {
          yield FLAC_BYTES.subarray(0, 5)
          await paused
          yield FLAC_BYTES.subarray(5)
        })()
      )
    }
  }
  const first = downloadEntryToCache({ session, entry, cacheRoot })
  const firstResult = Promise.allSettled([first])
  let queuedResult: Promise<PromiseSettledResult<string>[]> = Promise.resolve([])
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await stat(partial)
          .then((info) => info.size === 5)
          .catch(() => false)
      )
        break
      await delay(5)
    }
    assert.equal((await stat(partial)).size, 5)
    const queued = downloadEntryToCache({ session, entry, cacheRoot })
    queuedResult = Promise.allSettled([queued])
    // Windows aliases of the same directory share the protection and barrier.
    const clearRoot = process.platform === 'win32' ? cacheRoot.toUpperCase() : cacheRoot
    await clearDirectory(clearRoot)
    assert.deepEqual(await readFile(partial), FLAC_BYTES.subarray(0, 5))
    await assert.rejects(readFile(join(cacheRoot, 'old.flac')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(cacheRoot, 'old.flac.part')), { code: 'ENOENT' })
    release()
    for (const result of [...(await firstResult), ...(await queuedResult)]) {
      assert.equal(result.status, 'fulfilled')
      assert.deepEqual(await readFile((result as PromiseFulfilledResult<string>).value), FLAC_BYTES)
    }
    assert.equal(reads, 1)
    const cachedReader = downloadEntryToCache({ session, entry, cacheRoot })
    await clearDirectory(clearRoot)
    assert.deepEqual(await readFile(await cachedReader), FLAC_BYTES)
    // Protection belongs to in-flight calls, not a permanent exemption.
    await clearDirectory(cacheRoot)
    assert.equal(await getDirectorySize(cacheRoot), 0)
  } finally {
    release()
    await Promise.all([firstResult, queuedResult])
  }
})

test('new downloads wait for all earlier clears even when another waiting download cancels', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'network-cache-clear-queued-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  const oldDirectory = join(cacheRoot, 'old')
  await mkdir(oldDirectory)
  await Promise.all(
    Array.from({ length: 128 }, (_, index) => writeFile(join(oldDirectory, `${index}.flac`), 'old'))
  )
  let cleared = 0
  let reads = 0
  const session: NetworkSourceSession = {
    protocol: 'webdav',
    list: async () => [],
    stat: async () => null,
    resolvePlaybackUrl: async () => null,
    close: async () => {},
    async readStream() {
      assert.equal(cleared, 2, 'a later writer must not run inside either earlier clear')
      reads++
      return Readable.from([FLAC_BYTES])
    }
  }
  const firstClear = clearDirectory(cacheRoot).then(() => cleared++)
  const controller = new AbortController()
  const cancelled = downloadEntryToCache({
    session,
    entry: makeEntry('/music/cancelled.flac'),
    cacheRoot,
    signal: controller.signal
  })
  const cancelledResult = assert.rejects(cancelled, { code: 'timeout' })
  const secondClear = clearDirectory(cacheRoot).then(() => cleared++)
  const later = downloadEntryToCache({ session, entry: makeEntry('/music/later.flac'), cacheRoot })
  const laterResult = Promise.allSettled([later])
  controller.abort()
  await Promise.all([firstClear, secondClear, cancelledResult])
  const [result] = await laterResult
  assert.equal(result.status, 'fulfilled')
  assert.deepEqual(await readFile((result as PromiseFulfilledResult<string>).value), FLAC_BYTES)
  assert.equal(reads, 1)
  await assert.rejects(stat(oldDirectory), { code: 'ENOENT' })
})

test(
  'a failed clear releases waiting writers and the directory can recover',
  { timeout: 2_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'network-cache-clear-failure-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const cacheRoot = join(root, 'cache')
    // A regular file at the root gives a deterministic filesystem failure
    // without changing user permissions or relying on platform-specific locks.
    await writeFile(cacheRoot, 'not a directory')
    let reads = 0
    const session: NetworkSourceSession = {
      protocol: 'webdav',
      list: async () => [],
      stat: async () => null,
      resolvePlaybackUrl: async () => null,
      close: async () => {},
      async readStream() {
        reads++
        return Readable.from([FLAC_BYTES])
      }
    }
    const clearing = clearDirectory(cacheRoot)
    const waiting = downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    await Promise.all([
      assert.rejects(clearing, { code: 'EEXIST' }),
      assert.rejects(waiting, { code: 'EEXIST' })
    ])
    await rm(cacheRoot)
    const target = await downloadEntryToCache({ session, entry: makeEntry(), cacheRoot })
    assert.deepEqual(await readFile(target), FLAC_BYTES)
    assert.equal(reads, 1)
  }
)
