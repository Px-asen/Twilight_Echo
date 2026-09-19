import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteCoverCache } from './remoteCoverCache.ts'
import {
  createRemoteMediaRequestHandler,
  RemoteMediaGrantService
} from '../security/remoteMediaGrants.ts'

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
