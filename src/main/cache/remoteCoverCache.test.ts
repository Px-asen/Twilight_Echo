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
