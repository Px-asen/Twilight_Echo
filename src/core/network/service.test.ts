import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import test from 'node:test'
import { CoreNetworkService } from './service.ts'
import { createNetworkProfileStore } from './profileStore.ts'
import { createNetworkLibrary } from './networkLibrary.ts'
import { buildNetworkEntryId } from './networkPath.ts'
import { createSourceResolver } from '../playback/sourceResolver.ts'
import { clearDirectory, downloadEntryToCache, getDirectorySize } from './networkCache.ts'
import type { NetworkEntry } from '../../shared/networkSources.ts'
import type { NetworkSourceSession } from './adapters/types.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'core-network-'))
  const store = createNetworkProfileStore({
    filePath: join(root, 'profiles.json'),
    codec: { encrypt: async (value) => `enc:${value}`, decrypt: async (value) => value.slice(4) }
  })
  const profile = await store.createProfile({
    protocol: 'webdav',
    name: 'NAS',
    host: 'nas.test',
    rootPath: '/',
    auth: { kind: 'password', password: 'secret' }
  })
  const entry: NetworkEntry = {
    id: buildNetworkEntryId('webdav', profile.id, '/a.flac'),
    profileId: profile.id,
    name: 'a.flac',
    path: '/a.flac',
    kind: 'audio',
    mimeType: 'https://private.test/media?token=private',
    coverPath: 'C:/private/cover.png',
    sizeBytes: 4
  }
  const library = createNetworkLibrary({ filePath: join(root, 'library.json') })
  let gate: ReturnType<typeof deferred> | undefined,
    started = deferred(),
    closes = 0,
    reads = 0,
    cancels = 0,
    ids = 0
  const session: NetworkSourceSession = {
    protocol: 'webdav',
    async list(_path, signal) {
      started.resolve()
      if (gate)
        await Promise.race([
          gate.promise,
          new Promise((_resolve, reject) =>
            signal?.addEventListener(
              'abort',
              () => {
                cancels++
                reject(signal.reason)
              },
              { once: true }
            )
          )
        ])
      return [entry]
    },
    async stat() {
      return entry
    },
    async resolvePlaybackUrl() {
      return null
    },
    async readStream() {
      reads++
      return Readable.from([Buffer.from('test')])
    },
    async close() {
      closes++
    }
  }
  const make = () =>
    new CoreNetworkService({
      store,
      library,
      cacheRoot: join(root, 'cache'),
      coverCacheRoot: join(root, 'covers'),
      newId: () => `id-${++ids}`,
      now: () => 1000,
      changed: () => {},
      getAdapter: async () => ({ protocol: 'webdav', createSession: async () => session })
    })
  const service = make()
  await service.initialize()
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return {
    service,
    make,
    store,
    library,
    profile,
    entry,
    root,
    session,
    get closes() {
      return closes
    },
    get reads() {
      return reads
    },
    get cancels() {
      return cancels
    },
    slow() {
      gate = deferred()
      started = deferred()
      return { gate, started }
    }
  }
}
async function completed(service: CoreNetworkService) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (service.state().jobs.every((job) => job.state !== 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('job did not finish')
}

test('Core owns paged private directory identities and request-independent scan jobs', async (t) => {
  const f = await fixture(t),
    slow = f.slow()
  const started = f.service.job({ revision: 0, kind: 'scan', profileId: f.profile.id, path: '/' })
  assert.equal(started.jobs[0].state, 'running')
  await slow.started.promise
  slow.gate.resolve()
  await completed(f.service)
  assert.equal(f.service.state().jobs[0].state, 'completed')
  const page = await f.service.library({ revision: 1, limit: 1 })
  assert.equal(page.total, 1)
  assert.doesNotMatch(JSON.stringify(page), /mimeType|coverPath|private|secret|encryptedId/)
  assert.equal(f.closes, 1)
  await assert.rejects(f.service.library({ revision: 0 }), { code: 'STALE_REVISION' })
  const directory = await f.service.directory({ revision: 1, profileId: f.profile.id, path: '/' })
  assert.deepEqual(
    (
      await f.service.directory({
        revision: 1,
        profileId: f.profile.id,
        path: '/',
        token: directory.token
      })
    ).items,
    directory.items
  )
  const restarted = f.make()
  await restarted.initialize()
  assert.equal((await restarted.library({ revision: 0 })).items[0].id, f.entry.id)
  await restarted.shutdown()
})

test('profile deletion cancels a running scan and never resurrects its index', async (t) => {
  const f = await fixture(t),
    slow = f.slow()
  f.service.job({ revision: 0, kind: 'scan', profileId: f.profile.id, path: '/' })
  await slow.started.promise
  await f.service.edit({ revision: 0, kind: 'delete', id: f.profile.id })
  await completed(f.service)
  assert.equal(f.cancels, 1)
  assert.equal(f.closes, 1)
  assert.equal(f.service.state().jobs[0].state, 'cancelled')
  assert.deepEqual(await f.library.listEntries(f.profile.id), [])
  assert.equal(f.service.state().profiles, 0)
})

test('directory disconnect cancellation joins session close, while shutdown cancels background jobs', async (t) => {
  const f = await fixture(t),
    slow = f.slow(),
    controller = new AbortController()
  const pending = f.service.directory(
    { revision: 0, profileId: f.profile.id, path: '/' },
    controller.signal
  )
  const rejected = assert.rejects(pending, /disconnect/)
  await slow.started.promise
  controller.abort(new Error('disconnect'))
  await rejected
  assert.equal(f.closes, 1)
  const next = f.slow()
  f.service.job({ revision: 0, kind: 'scan', profileId: f.profile.id, path: '/' })
  await next.started.promise
  await f.service.shutdown()
  assert.equal(f.closes, 2)
  assert.equal(f.cancels, 2)
  assert.equal(f.service.state().jobs[0].state, 'cancelled')
})

test('browse-only queued sources resolve after restart without trusting a saved URL or forged identity', async (t) => {
  const f = await fixture(t)
  await f.service.directory({ revision: 0, profileId: f.profile.id, path: '/' })
  const track = await f.service.playback({
    revision: 0,
    profileId: f.profile.id,
    entryId: f.entry.id
  })
  assert.equal(track.filePath, '')
  assert.doesNotMatch(JSON.stringify(track), /private|coverPath|mimeType/)
  const restarted = f.make()
  await restarted.initialize()
  const resolved = await restarted.resolve({
    ...track,
    filePath: 'https://expired.test/audio?token=old'
  })
  assert.ok(resolved)
  assert.equal(await readFile(resolved.source, 'utf8'), 'test')
  assert.equal(
    await restarted.resolve({
      ...track,
      networkSource: { profileId: f.profile.id, entry: { ...f.entry, path: '/forged.flac' } }
    }),
    null
  )
  f.session.resolvePlaybackUrl = async () => 'https://current.test/audio?token=private'
  assert.deepEqual(await restarted.resolve(track), {
    source: 'https://current.test/audio?token=private',
    expiresAt: 481000
  })
  await restarted.shutdown()
})

test('network playback resolves the current source before the generic local/URL shortcut', async () => {
  let received: unknown
  const resolver = createSourceResolver({
    now: () => 1000,
    resolveNetwork: async (track) => {
      received = track
      return { source: 'https://current.test/a', expiresAt: 481000 }
    }
  })
  const track = { id: 'one', source: 'network', filePath: 'https://expired.test/a' }
  const source = await resolver.resolve(track)
  assert.equal(received, track)
  assert.equal(source?.source, 'https://current.test/a')
  assert.equal(source?.expiresAt, 481000)
  assert.equal(await createSourceResolver().resolve(track), null)
})

test('profile store serializes async encryption and preserves concurrent mutations across restart', async (t) => {
  const f = await fixture(t)
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      f.store.createProfile({
        protocol: 'ftp',
        name: `NAS ${index}`,
        host: 'nas.test',
        rootPath: '/',
        auth: { kind: 'password', password: `secret-${index}` }
      })
    )
  )
  assert.equal((await f.store.listProfiles()).length, 13)
  const document = JSON.parse(await readFile(join(f.root, 'profiles.json'), 'utf8'))
  assert.equal(document.profiles.length, 13)
  assert.equal(document.profiles[12].credential.encryptedId, 'enc:secret-11')
})

test('concurrent cache consumers serialize one physical target without racing its partial file', async (t) => {
  const f = await fixture(t)
  const deps = { session: f.session, entry: f.entry, cacheRoot: join(f.root, 'concurrent-cache') }
  const paths = await Promise.all([downloadEntryToCache(deps), downloadEntryToCache(deps)])
  assert.equal(paths[0], paths[1])
  assert.equal(f.reads, 1)
  assert.equal(await readFile(paths[0], 'utf8'), 'test')
})

test('a cancelled cache waiter exits without releasing the active writer to later consumers', async (t) => {
  const f = await fixture(t)
  const gate = deferred(),
    started = deferred()
  let reads = 0
  const session: NetworkSourceSession = {
    ...f.session,
    async readStream() {
      reads++
      started.resolve()
      await gate.promise
      return Readable.from(['test'])
    }
  }
  const deps = { session, entry: f.entry, cacheRoot: join(f.root, 'cancelled-waiter') }
  const first = downloadEntryToCache(deps)
  await started.promise
  const controller = new AbortController()
  const second = downloadEntryToCache({ ...deps, signal: controller.signal })
  const cancelled = assert.rejects(second, {
    code: 'timeout',
    message: /cancelled waiter/
  })
  controller.abort(new Error('cancelled waiter'))
  await cancelled
  let thirdFinished = false
  const third = downloadEntryToCache(deps).then((path) => {
    thirdFinished = true
    return path
  })
  await tick()
  assert.equal(reads, 1)
  assert.equal(thirdFinished, false)
  gate.resolve()
  const paths = await Promise.all([first, third])
  assert.equal(paths[0], paths[1])
  assert.equal(await readFile(paths[0], 'utf8'), 'test')
  assert.equal(reads, 1)
})

test('cache writers coordinate by the sanitized physical target and Windows path casing', async (t) => {
  const f = await fixture(t)
  const gate = deferred(),
    started = deferred()
  let reads = 0
  const session: NetworkSourceSession = {
    ...f.session,
    async readStream() {
      reads++
      started.resolve()
      await gate.promise
      return Readable.from(['test'])
    }
  }
  const cacheRoot = join(f.root, 'physical-target')
  const first = downloadEntryToCache({
    session,
    cacheRoot,
    entry: { ...f.entry, name: 'a.invalid-extension' }
  })
  await started.promise
  const second = downloadEntryToCache({
    session,
    cacheRoot: process.platform === 'win32' ? cacheRoot.toUpperCase() : cacheRoot,
    entry: { ...f.entry, name: 'a.another-invalid-extension' }
  })
  await tick()
  assert.equal(reads, 1)
  gate.resolve()
  const paths = await Promise.all([first, second])
  assert.equal(paths[0].toLowerCase(), paths[1].toLowerCase())
  assert.equal(await readFile(paths[0], 'utf8'), 'test')
  assert.equal(reads, 1)
})

test('cache clearing joins cancelled readers and session close, preserves native pins and gates new resolution', async (t) => {
  const f = await fixture(t)
  await f.service.directory({ revision: 0, profileId: f.profile.id, path: '/' })
  const track = await f.service.playback({
    revision: 0,
    profileId: f.profile.id,
    entryId: f.entry.id
  })
  const cache = join(f.root, 'cache')
  await mkdir(cache)
  await Promise.all(
    ['current.flac', 'preloaded.flac', 'stale.flac', 'aborted.part'].map((name) =>
      writeFile(join(cache, name), name)
    )
  )
  const started = deferred(),
    closing = deferred(),
    releaseClose = deferred()
  f.session.resolvePlaybackUrl = async (_path, signal) => {
    started.resolve()
    return new Promise((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    )
  }
  f.session.close = async () => {
    closing.resolve()
    await releaseClose.promise
  }
  const old = f.service.resolve(track)
  const rejected = assert.rejects(old, /being cleared/)
  await started.promise
  let ended = false
  const clearing = f.service
    .clearCache((clear) =>
      clear([
        process.platform === 'win32'
          ? join(cache, 'current.flac').toUpperCase()
          : join(cache, 'current.flac'),
        join(cache, 'preloaded.flac')
      ])
    )
    .then((result) => {
      ended = true
      return result
    })
  await closing.promise
  assert.equal(ended, false)
  assert.equal((await readdir(cache)).length, 4)
  await assert.rejects(async () => f.service.clearCache((clear) => clear([])), /already/)
  let newReads = 0
  f.session.resolvePlaybackUrl = async () => {
    newReads++
    return null
  }
  const next = f.service.resolve(track)
  await tick()
  assert.equal(newReads, 0)
  releaseClose.resolve()
  await rejected
  const result = await clearing
  assert.equal(result.sizeBytes, 'current.flacpreloaded.flac'.length)
  assert.ok(await next)
  assert.equal(newReads, 1)
  assert.deepEqual(
    (await readdir(cache)).sort(),
    [f.entry.id + '.flac', 'current.flac', 'preloaded.flac'].sort()
  )
})

test('cache clearing leaves directory scans active and releases its gate after a failed/cancelled clear', async (t) => {
  const f = await fixture(t),
    slow = f.slow()
  f.service.job({ revision: 0, kind: 'scan', profileId: f.profile.id, path: '/' })
  await slow.started.promise
  const cancelled = new AbortController()
  await assert.rejects(
    f.service.clearCache(async (clear) => {
      cancelled.abort(new Error('client disconnected'))
      return clear([])
    }, cancelled.signal),
    /disconnected/
  )
  assert.equal(f.service.state().jobs[0].state, 'running')
  await f.service.clearCache((clear) => clear([]))
  slow.gate.resolve()
  await completed(f.service)
  assert.equal(f.service.state().jobs[0].state, 'completed')
})

test('clearDirectory preserves active and queued downloads and serializes against waiting writers', async (t) => {
  const f = await fixture(t)
  const cacheRoot = join(f.root, 'clear-directory-active')
  await mkdir(cacheRoot, { recursive: true })
  const partial = join(cacheRoot, `${f.entry.id}.flac.part`)
  await writeFile(join(cacheRoot, 'old.flac'), 'old cache')
  await writeFile(join(cacheRoot, 'old.flac.part'), 'abandoned partial')
  const gate = deferred(),
    firstChunk = deferred()
  let reads = 0
  const session: NetworkSourceSession = {
    ...f.session,
    async readStream() {
      reads++
      return Readable.from(
        (async function* () {
          yield Buffer.from('te')
          firstChunk.resolve()
          await gate.promise
          yield Buffer.from('st')
        })()
      )
    }
  }
  const first = downloadEntryToCache({ session, entry: f.entry, cacheRoot })
  await firstChunk.promise
  for (let i = 0; i < 50; i++) {
    if (
      await stat(partial)
        .then((info) => info.size === 2)
        .catch(() => false)
    )
      break
    await tick()
  }
  const queued = downloadEntryToCache({ session, entry: f.entry, cacheRoot })
  const clearRoot = process.platform === 'win32' ? cacheRoot.toUpperCase() : cacheRoot
  await clearDirectory(clearRoot)
  assert.equal(await readFile(partial, 'utf8'), 'te')
  await assert.rejects(readFile(join(cacheRoot, 'old.flac')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(cacheRoot, 'old.flac.part')), { code: 'ENOENT' })
  gate.resolve()
  const [firstPath, queuedPath] = await Promise.all([first, queued])
  assert.equal(firstPath, queuedPath)
  assert.equal(await readFile(firstPath, 'utf8'), 'test')
  assert.equal(reads, 1)
  await clearDirectory(cacheRoot)
  assert.equal(await getDirectorySize(cacheRoot), 0)
})

test('CoreNetworkService resolves cacheRoot and coverCacheRoot dynamically when settings change', async (t) => {
  const f = await fixture(t)
  let currentRoot = join(f.root, 'cache-a')
  const service = new CoreNetworkService({
    store: f.store,
    library: f.library,
    cacheRoot: () => join(currentRoot, 'network-cache'),
    coverCacheRoot: () => join(currentRoot, 'cover-cache'),
    newId: () => 'id-dynamic',
    now: () => 1000,
    changed: () => {},
    getAdapter: async () => ({ protocol: 'webdav', createSession: async () => f.session })
  })
  await service.initialize()
  t.after(() => service.shutdown())
  await service.directory({ revision: 0, profileId: f.profile.id, path: '/' })
  const track = await service.playback({
    revision: 0,
    profileId: f.profile.id,
    entryId: f.entry.id
  })
  const first = await service.resolve(track)
  assert.equal(first?.source, join(currentRoot, 'network-cache', `${f.entry.id}.flac`))
  assert.equal((await service.cacheInfo()).sizeBytes, 4)

  currentRoot = join(f.root, 'cache-b')
  assert.equal((await service.cacheInfo()).sizeBytes, 0)
  const second = await service.resolve(track)
  assert.equal(second?.source, join(currentRoot, 'network-cache', `${f.entry.id}.flac`))
  assert.equal((await service.cacheInfo()).sizeBytes, 4)
  await service.clearCache((clear) => clear([]))
  assert.equal((await service.cacheInfo()).sizeBytes, 0)
})
