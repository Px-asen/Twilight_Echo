import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteCoverCache } from './remoteCoverCache.ts'
import {
  createRemoteMediaRequestHandler,
  RemoteMediaGrantService
} from '../security/remoteMediaGrants.ts'

test('cover clear joins real publications and fences HTTP responses begun before or during maintenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'te-cover-clear-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = createRemoteCoverCache(() => root)
  const publishing = cache.write('https://example.com/before', 'image/png', new Uint8Array([1]))
  let release!: () => void, arrived!: () => void
  const arrivedAtClear = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const grants = new RemoteMediaGrantService()
  const bodies: Array<(value: Response) => void> = []
  const handler = createRemoteMediaRequestHandler({
    grants,
    imageCache: cache,
    fetch: () =>
      new Promise<Response>((resolve) => {
        bodies.push(resolve)
      })
  })
  const response = handler(new Request(grants.grant('https://example.com/old', 'image')))
  while (bodies.length < 1) await new Promise((resolve) => setImmediate(resolve))
  const clearing = cache.maintain(async () => {
    await publishing
    assert.equal((await readdir(root)).length, 1)
    for (const name of await readdir(root)) await rm(join(root, name))
    arrived()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await arrivedAtClear
  const during = handler(new Request(grants.grant('https://example.com/during', 'image')))
  while (bodies.length < 2) await new Promise((resolve) => setImmediate(resolve))
  release()
  await clearing
  // Both requests retain the generation from before their fetch, rather than
  // acquiring a fresh publication permit when the slow body finally arrives.
  for (const body of bodies)
    body(new Response(new Uint8Array([3]), { headers: { 'content-type': 'image/png' } }))
  assert.deepEqual(
    (await Promise.all([response, during])).map((r) => r.status),
    [200, 200]
  )
  assert.deepEqual(await readdir(root), [])
  await cache.write('https://example.com/new', 'image/png', new Uint8Array([4]))
  assert.ok(await cache.read('https://example.com/new'))
})

test('authorized covers survive a cache instance restart and disabling cache bypasses disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-cover-'))
  try {
    let enabled = true
    let requests = 0
    const grants = new RemoteMediaGrantService()
    const token = grants.grant('https://example.com/cover.png', 'image')
    const createHandler = () =>
      createRemoteMediaRequestHandler({
        grants,
        imageCache: createRemoteCoverCache(() => (enabled ? root : null)),
        fetch: async () => {
          requests++
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'image/png' }
          })
        }
      })
    assert.deepEqual(
      new Uint8Array(await (await createHandler()(new Request(token))).arrayBuffer()),
      new Uint8Array([1, 2, 3])
    )
    assert.equal((await createHandler()(new Request(token))).status, 200)
    assert.equal(requests, 1)
    assert.equal((await createHandler()(new Request('twilight-media://image/unknown'))).status, 403)
    enabled = false
    await createHandler()(new Request(token))
    assert.equal(requests, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote covers are downscaled by the injected resizer before they reach disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-cover-resize-'))
  try {
    const calls: Array<{ bytes: number; mime: string }> = []
    const cache = createRemoteCoverCache(() => root, {
      resize: (bytes, mime) => {
        calls.push({ bytes: bytes.byteLength, mime })
        return { bytes: new Uint8Array([9, 9]), mime: 'image/jpeg' }
      }
    })
    await cache.write(
      'https://example.com/large.png',
      'image/png; charset=binary',
      new Uint8Array(64)
    )
    const cached = await cache.read('https://example.com/large.png')
    assert.ok(cached)
    assert.equal(cached.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), new Uint8Array([9, 9]))
    assert.deepEqual(calls, [{ bytes: 64, mime: 'image/png' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote covers keep their original bytes when the resizer declines or throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-cover-keep-'))
  try {
    const declining = createRemoteCoverCache(() => root, { resize: () => null })
    await declining.write('https://example.com/small.gif', 'image/gif', new Uint8Array([1, 2, 3]))
    const small = await declining.read('https://example.com/small.gif')
    assert.ok(small)
    assert.equal(small.headers.get('content-type'), 'image/gif')
    assert.deepEqual(new Uint8Array(await small.arrayBuffer()), new Uint8Array([1, 2, 3]))

    const throwing = createRemoteCoverCache(() => root, {
      resize: () => {
        throw new Error('decoder failed')
      }
    })
    await throwing.write('https://example.com/broken.jpg', 'image/jpeg', new Uint8Array([4, 5]))
    const broken = await throwing.read('https://example.com/broken.jpg')
    assert.ok(broken)
    assert.equal(broken.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(new Uint8Array(await broken.arrayBuffer()), new Uint8Array([4, 5]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('first-hit remote cover responses serve downscaled bytes directly to Chromium', async () => {
  const root = await mkdtemp(join(tmpdir(), 'te-cover-first-hit-'))
  try {
    const grants = new RemoteMediaGrantService()
    const token = grants.grant('https://example.com/huge.png', 'image')
    const cache = createRemoteCoverCache(() => root, {
      resize: () => ({ bytes: new Uint8Array([7, 8, 9]), mime: 'image/jpeg' })
    })
    const handler = createRemoteMediaRequestHandler({
      grants,
      imageCache: cache,
      fetch: async () =>
        new Response(new Uint8Array(1024), {
          headers: { 'content-type': 'image/png', 'content-length': '1024' }
        })
    })
    const firstHit = await handler(new Request(token))
    assert.equal(firstHit.status, 200)
    assert.equal(firstHit.headers.get('content-type'), 'image/jpeg')
    assert.equal(firstHit.headers.get('content-length'), null)
    assert.deepEqual(new Uint8Array(await firstHit.arrayBuffer()), new Uint8Array([7, 8, 9]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
