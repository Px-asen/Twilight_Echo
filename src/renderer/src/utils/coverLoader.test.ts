import assert from 'node:assert/strict'
import test from 'node:test'

const { clearCoverCache, clearRemoteCoverGrantCache, readCachedCover, resolveCover } =
  (await import(
    new URL('./coverLoader.ts', import.meta.url).href
  )) as typeof import('./coverLoader')

test('cached artwork is available synchronously with the same source priority and invalidation', async () => {
  const record = globalThis as Record<string, unknown>
  const previous = record.window
  record.window = {
    api: {
      data: {
        getCover: async () => 'data:image/png;base64,local',
        grantRemoteCover: async () => 'twilight-media://image/remote'
      }
    }
  }
  clearCoverCache()
  try {
    assert.equal(readCachedCover('cover://avatar.png'), null)
    assert.equal(readCachedCover('https://example.com/avatar'), null)
    await resolveCover('cover://avatar.png')
    await resolveCover(null, 'https://example.com/avatar')
    assert.equal(
      readCachedCover('cover://avatar.png#v=1', 'https://example.com/avatar'),
      'data:image/png;base64,local'
    )
    assert.equal(
      readCachedCover(null, 'https://example.com/avatar'),
      'twilight-media://image/remote'
    )
    assert.equal(readCachedCover('data:image/png;base64,manual'), 'data:image/png;base64,manual')
    assert.equal(readCachedCover('twilight-media://image/live'), 'twilight-media://image/live')
    clearCoverCache()
    assert.equal(readCachedCover('cover://avatar.png'), null)
    assert.equal(readCachedCover(null, 'https://example.com/avatar'), null)
  } finally {
    record.window = previous
    clearCoverCache()
  }
})

test('clearing display caches prevents late IPC responses from populating a new generation', async () => {
  const record = globalThis as Record<string, unknown>
  const previous = record.window
  let finish!: (value: string) => void
  let calls = 0
  record.window = {
    api: {
      data: {
        getCover: () => {
          calls++
          return new Promise<string>((resolve) => {
            finish = resolve
          })
        }
      }
    }
  }
  try {
    clearCoverCache()
    const old = resolveCover('cover://pending.jpg')
    clearCoverCache()
    finish('data:image/png;base64,old')
    await old
    const fresh = resolveCover('cover://pending.jpg')
    assert.equal(calls, 2)
    finish('data:image/png;base64,new')
    assert.equal(await fresh, 'data:image/png;base64,new')
    assert.equal(await resolveCover('cover://pending.jpg'), 'data:image/png;base64,new')
    assert.equal(calls, 2)
  } finally {
    record.window = previous
    clearCoverCache()
  }
})

test('local cover cache evicts by byte budget and preserves recently read art', async () => {
  clearCoverCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  const calls = new Map<string, number>()
  // Each entry uses just over 6 MiB under the conservative UTF-16 budget.
  const art = 'data:image/jpeg;base64,' + 'a'.repeat(3 * 1024 * 1024)
  globalRecord.window = {
    api: {
      data: {
        getCover: async (handle: string) => {
          calls.set(handle, (calls.get(handle) ?? 0) + 1)
          return art
        }
      }
    }
  }
  try {
    await resolveCover('cover://a.jpg')
    await resolveCover('cover://b.jpg')
    await resolveCover('cover://a.jpg')
    await resolveCover('cover://c.jpg')
    await resolveCover('cover://a.jpg')
    assert.equal(calls.get('cover://a.jpg'), 1)
    await resolveCover('cover://b.jpg')
    assert.equal(calls.get('cover://b.jpg'), 2)
    clearCoverCache()
    await resolveCover('cover://a.jpg')
    await resolveCover('cover://b.jpg')
    await resolveCover('cover://a.jpg')
    assert.equal(calls.get('cover://a.jpg'), 2)
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('oversized art is displayed without retaining it in the local cache', async () => {
  clearCoverCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  const art = 'data:image/jpeg;base64,' + 'a'.repeat(8 * 1024 * 1024)
  let calls = 0
  globalRecord.window = {
    api: {
      data: {
        getCover: async () => {
          calls += 1
          return art
        }
      }
    }
  }
  try {
    assert.equal(await resolveCover('cover://large.jpg'), art)
    assert.equal(await resolveCover('cover://large.jpg'), art)
    assert.equal(calls, 2)
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('resolveCover materializes cover:// handles via getCover IPC', async () => {
  clearCoverCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async (handle: string) => {
          assert.equal(handle, 'cover://abc.jpg')
          return 'data:image/jpeg;base64,abc'
        }
      }
    }
  }

  try {
    assert.equal(await resolveCover('cover://abc.jpg'), 'data:image/jpeg;base64,abc')
    // Cached — second call reuses without requiring IPC again.
    assert.equal(await resolveCover('cover://abc.jpg#t=track'), 'data:image/jpeg;base64,abc')
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('resolveCover converts Uint8Array IPC responses without base64 IPC payloads', async () => {
  clearCoverCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previousWindow = globalRecord.window
  const previousFileReader = globalRecord.FileReader
  class FakeFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then(
        (bytes) => {
          this.result = `data:image/jpeg;base64,${new Uint8Array(bytes).join('-')}`
          this.onload?.()
        },
        () => this.onerror?.()
      )
    }
  }
  globalRecord.FileReader = FakeFileReader
  globalRecord.window = {
    api: { data: { getCover: async () => new Uint8Array([1, 2, 3]) } }
  }
  try {
    assert.equal(await resolveCover('cover://bytes.jpg'), 'data:image/jpeg;base64,1-2-3')
  } finally {
    globalRecord.window = previousWindow
    globalRecord.FileReader = previousFileReader
    clearCoverCache()
  }
})

test('resolveCover caps protocol-fetch fallback cache at 128 entries', async () => {
  clearCoverCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previousWindow = globalRecord.window
  const previousFetch = globalRecord.fetch
  const previousFileReader = globalRecord.FileReader
  let fetchCount = 0

  // The fallback converts a Blob through FileReader; provide the tiny browser
  // surface needed by this renderer utility when running under node:test.
  class FakeFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then(
        () => {
          this.result = `data:image/jpeg;base64,${blob.size}`
          this.onload?.()
        },
        () => this.onerror?.()
      )
    }
  }

  globalRecord.window = { api: { data: {} } }
  globalRecord.FileReader = FakeFileReader
  globalRecord.fetch = async () => {
    fetchCount += 1
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/jpeg' }
    })
  }

  try {
    for (let i = 0; i < 129; i += 1) {
      assert.match(
        (await resolveCover(`cover://fallback-${i}.jpg`)) ?? '',
        /^data:image\/jpeg;base64,/
      )
    }
    assert.equal(fetchCount, 129)
    // FIFO eviction means the first entry is fetched again after 129 inserts.
    await resolveCover('cover://fallback-0.jpg')
    assert.equal(fetchCount, 130)
  } finally {
    globalRecord.window = previousWindow
    globalRecord.fetch = previousFetch
    globalRecord.FileReader = previousFileReader
    clearCoverCache()
  }
})

test('resolveCover prefers local cover:// over durable coverSource', async () => {
  clearCoverCache()
  const grants: string[] = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async () => 'data:image/jpeg;base64,local',
        grantRemoteCover: async (source: string) => {
          grants.push(source)
          return 'twilight-media://image/remote'
        }
      }
    }
  }

  try {
    assert.equal(
      await resolveCover('cover://local.jpg', 'https://p1.music.126.net/cover.jpg'),
      'data:image/jpeg;base64,local'
    )
    assert.equal(grants.length, 0)
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('resolveCover prefers durable coverSource and re-grants remote origins', async () => {
  clearRemoteCoverGrantCache()
  const grants: string[] = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        grantRemoteCover: async (source: string) => {
          grants.push(source)
          return `twilight-media://image/reissued-${grants.length}`
        }
      }
    }
  }

  try {
    // Dead post-restart grant + durable origin → re-grant from origin.
    const restored = await resolveCover(
      'twilight-media://image/expired-token',
      'https://p1.music.126.net/cover.jpg'
    )
    assert.equal(restored, 'twilight-media://image/reissued-1')

    // Cached by origin.
    const again = await resolveCover(
      'twilight-media://image/other-token',
      'https://p1.music.126.net/cover.jpg'
    )
    assert.equal(again, 'twilight-media://image/reissued-1')
    assert.equal(grants.length, 1)

    // Legacy bare https cover (no coverSource) → grant for CSP.
    const bareHttps = await resolveCover('https://p1.music.126.net/legacy.jpg')
    assert.equal(bareHttps, 'twilight-media://image/reissued-2')

    // Source-only row.
    const fromSourceOnly = await resolveCover(null, 'https://p1.music.126.net/only-source.jpg')
    assert.equal(fromSourceOnly, 'twilight-media://image/reissued-3')

    // Live grant without durable origin still displays.
    assert.equal(
      await resolveCover('twilight-media://image/live-token'),
      'twilight-media://image/live-token'
    )
  } finally {
    globalRecord.window = previous
    clearRemoteCoverGrantCache()
  }
})

test('resolveCover falls back to a live handle when re-grant fails', async () => {
  clearRemoteCoverGrantCache()
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        grantRemoteCover: async () => {
          throw new Error('ipc unavailable')
        }
      }
    }
  }

  try {
    assert.equal(
      await resolveCover('twilight-media://image/still-live', 'https://p1.music.126.net/cover.jpg'),
      'twilight-media://image/still-live'
    )
  } finally {
    globalRecord.window = previous
    clearRemoteCoverGrantCache()
  }
})

test('useCover clears previous art when handle is not immediately displayable', async () => {
  clearCoverCache()
  const { useCover } = (await import(
    new URL('./coverLoader.ts', import.meta.url).href
  )) as typeof import('./coverLoader')
  const { ref, nextTick } = await import('vue')

  const grants: string[] = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async (handle: string) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return `data:image/jpeg;base64,${handle.includes('track-a') ? 'a' : 'c'}`
        },
        grantRemoteCover: async (source: string) => {
          grants.push(source)
          await new Promise((resolve) => setTimeout(resolve, 5))
          return `twilight-media://image/new-${grants.length}`
        }
      }
    }
  }

  try {
    const handle = ref<string | null>('cover://track-a.jpg')
    const source = ref<string | null>(null)
    const resolved = useCover(handle, source)
    await nextTick()
    // Local protocol covers clear first, then materialize — never stay on cover://.
    assert.equal(resolved.value, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved.value, 'data:image/jpeg;base64,a')

    // Switch to a durable-only remote cover (no live handle yet). Must not keep track A.
    handle.value = null
    source.value = 'https://p1.music.126.net/track-b.jpg'
    await nextTick()
    assert.equal(resolved.value, null)

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved.value, 'twilight-media://image/new-1')

    // Switch to another local handle — previous remote art must not stick.
    handle.value = 'cover://track-c.jpg'
    source.value = null
    await nextTick()
    assert.equal(resolved.value, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved.value, 'data:image/jpeg;base64,c')
  } finally {
    globalRecord.window = previous
    clearCoverCache()
  }
})

test('resolveCover and useCover pass sm/grid size tiers to local IPC and remote media grants', async () => {
  clearCoverCache()
  clearRemoteCoverGrantCache()
  const localCalls: Array<{ handle: string; size?: string }> = []
  const globalRecord = globalThis as Record<string, unknown>
  const previous = globalRecord.window
  globalRecord.window = {
    api: {
      data: {
        getCover: async (handle: string, size?: string) => {
          localCalls.push({ handle, size })
          return `data:image/jpeg;base64,${size ?? 'md'}`
        },
        grantRemoteCover: async () => 'twilight-media://image/granted-token'
      }
    }
  }

  try {
    assert.equal(await resolveCover('cover://album.jpg', null, 'grid'), 'data:image/jpeg;base64,grid')
    assert.equal(await resolveCover('cover://album.jpg', null, 'sm'), 'data:image/jpeg;base64,sm')
    assert.deepEqual(localCalls, [
      { handle: 'cover://album.jpg', size: 'grid' },
      { handle: 'cover://album.jpg', size: 'sm' }
    ])

    assert.equal(
      await resolveCover('twilight-media://image/live-token', null, 'grid'),
      'twilight-media://image/live-token?size=grid'
    )
    assert.equal(
      await resolveCover(null, 'https://p1.music.126.net/art.jpg', 'sm'),
      'twilight-media://image/granted-token?size=sm'
    )
    assert.equal(
      readCachedCover(null, 'https://p1.music.126.net/art.jpg', 'grid'),
      'twilight-media://image/granted-token?size=grid'
    )
  } finally {
    globalRecord.window = previous
    clearCoverCache()
    clearRemoteCoverGrantCache()
  }
})

test('DOM mode materializes Uint8Array covers as blob URLs and pins active useCover scopes before revoking', async () => {
  clearCoverCache()
  const { useCover } = (await import(
    new URL('./coverLoader.ts', import.meta.url).href
  )) as typeof import('./coverLoader')
  const { effectScope, ref, nextTick } = await import('vue')

  const globalRecord = globalThis as Record<string, unknown>
  const previousWindow = globalRecord.window
  const previousDocument = globalRecord.document
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL

  let seq = 0
  const created: string[] = []
  const revoked: string[] = []
  URL.createObjectURL = () => {
    const url = `blob:twilight-test/${++seq}`
    created.push(url)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  globalRecord.document = {}
  globalRecord.window = {
    api: {
      data: {
        getCover: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
      }
    }
  }

  try {
    const scope = effectScope()
    const handle = ref<string | null>('cover://pinned.jpg')
    let activeCover!: ReturnType<typeof useCover>
    scope.run(() => {
      activeCover = useCover(handle, undefined, 'grid')
    })
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 15))
    const pinnedUrl = activeCover.value
    assert.equal(pinnedUrl, 'blob:twilight-test/1')
    assert.equal(revoked.length, 0)

    // Clearing the cache while useCover is still mounted must NOT revoke the pinned blob URL.
    clearCoverCache()
    assert.equal(revoked.includes('blob:twilight-test/1'), false)

    // Once the component scope unmounts, the deferred revocation completes cleanly.
    scope.stop()
    assert.equal(revoked.includes('blob:twilight-test/1'), true)
  } finally {
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
    globalRecord.window = previousWindow
    if (previousDocument === undefined) delete globalRecord.document
    else globalRecord.document = previousDocument
    clearCoverCache()
  }
})
