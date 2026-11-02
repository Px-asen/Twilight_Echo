import assert from 'node:assert/strict'
import test from 'node:test'
import { createSourceResolver, prepareNativeSource } from './sourceResolver.ts'

const now = 1_000_000
const ttl = 8 * 60_000
const track = { id: 'ncm:123', source: 'ncm', filePath: 'ncm:123' }

test('SAF SACD authorization keeps the provider query and fragment outside the logical selector', async () => {
  const physical = 'content://documents/opaque?provider=keep#original'
  for (const area of ['stereo', 'multichannel']) {
    const suffix = `#twilight-sacd=${area}:2`
    const calls: string[] = []
    assert.equal(await prepareNativeSource(physical + suffix, async (source) => {
      calls.push(source)
      return source + '-resolved'
    }), physical + '-resolved' + suffix)
    assert.deepEqual(calls, [physical])
    assert.equal(await prepareNativeSource(physical + suffix, async () => null), null)
    await assert.rejects(prepareNativeSource(physical + suffix, async () => { throw new Error('grant revoked') }),
      { code: 'SOURCE_ACCESS_DENIED' })
  }
})

test('native preparation distinguishes a missing source from an authorization refusal for files and SACD selectors', async () => {
  for (const source of ['D:/Music/song.flac', 'D:/Music/disc.iso?area=stereo&track=1']) {
    assert.equal(await prepareNativeSource(source, async () => null), null)
    const denied = new Error('platform denied')
    await assert.rejects(prepareNativeSource(source, async () => { throw denied }), {
      code: 'SOURCE_ACCESS_DENIED', message: 'platform denied', cause: denied
    })
  }
})

test('subsequent source resolution reads the committed Core quality without rebuilding the resolver', async () => {
  let quality = 'standard'
  const requested: unknown[] = []
  const resolver = createSourceResolver({
    quality: () => quality,
    callProvider: async (_id, _method, args) => {
      requested.push(args[1])
      return 'https://cdn.test/current.flac'
    }
  })
  await resolver.resolve(track)
  quality = 'hires'
  await resolver.resolve(track)
  assert.deepEqual(requested, [{ quality: 'standard' }, { quality: 'hires' }])
})

test('Core asks the provider for persisted URLs and cache paths, preserving the quality request', async () => {
  const calls: unknown[][] = []
  const resolver = createSourceResolver({
    now: () => now,
    quality: 'lossless',
    callProvider: async (id, method, args, options) => {
      calls.push([id, method, args])
      assert.equal(options.playbackExpiry, true)
      return 'https://cdn.test/current.flac'
    }
  })
  for (const path of ['D:/Cache/removed.flac', 'https://cdn.test/expired.flac']) {
    const persisted = { ...track, filePath: path, streamUrl: 'https://cdn.test/old.flac' }
    assert.deepEqual(await resolver.resolve(persisted), {
      source: 'https://cdn.test/current.flac',
      expiresAt: now + ttl
    })
    assert.deepEqual(calls.at(-1), ['ncm', 'getPlaybackUrl', [persisted, { quality: 'lossless' }]])
  }
  assert.equal(calls.length, 2)
})

test('a missing NCM cache refreshes exactly once; a usable cache needs no refresh', async () => {
  for (const available of [true, false]) {
    const calls: unknown[] = []
    const checked: string[] = []
    const resolver = createSourceResolver({
      now: () => now,
      callProvider: async (_id, _method, args) => {
        calls.push(args[1])
        return 'D:/Cache/song.flac'
      },
      canUseLocalSource: async (source) => {
        checked.push(source)
        return available
      }
    })
    assert.deepEqual(
      await resolver.resolve(track),
      available
        ? {
            source: 'D:/Cache/song.flac',
            expiresAt: now + ttl
          }
        : null
    )
    assert.deepEqual(
      calls,
      available ? [{ quality: 'auto' }] : [{ quality: 'auto' }, { quality: 'auto', force: true }]
    )
    assert.equal(checked.length, available ? 1 : 2)
  }
})

test('forced cache refresh can return an authorized fresh remote URL', async () => {
  const calls: unknown[] = []
  const resolver = createSourceResolver({
    now: () => now,
    canUseLocalSource: async () => false,
    callProvider: async (_id, _method, args) => {
      calls.push(args[1])
      return calls.length === 1
        ? 'D:/Cache/missing.flac'
        : {
            streamUrl: 'https://cdn.test/new.flac',
            providerSource: { expiresAt: now + 60_000 }
          }
    }
  })
  assert.deepEqual(await resolver.resolve(track), {
    source: 'https://cdn.test/new.flac',
    expiresAt: now + 60_000
  })
  assert.deepEqual(calls, [{ quality: 'auto' }, { quality: 'auto', force: true }])
})

test('known-expired URLs refresh once without receiving the unknown-expiry TTL', async () => {
  for (const fresh of [true, false]) {
    let calls = 0
    const resolver = createSourceResolver({
      now: () => now,
      callProvider: async (_id, _method, args) => {
        assert.deepEqual(args[1], calls ? { force: true } : {})
        calls++
        return {
          streamUrl: 'https://cdn.test/song.flac',
          providerSource: { expiresAt: calls === 2 && fresh ? now + 60_000 : now }
        }
      }
    })
    assert.deepEqual(
      await resolver.resolve({ ...track, source: 'plugin', id: 'plugin:123' }),
      fresh ? { source: 'https://cdn.test/song.flac', expiresAt: now + 60_000 } : null
    )
    assert.equal(calls, 2)
  }
})

test('expiry is checked after asynchronous grant/availability resolution', async () => {
  let clock = now
  let calls = 0
  const resolver = createSourceResolver({
    now: () => clock,
    callProvider: async () => {
      calls++
      return {
        streamUrl: 'twilight-media://audio/issued',
        providerSource: { expiresAt: clock + 1 }
      }
    },
    grants: {
      resolve: async () => {
        clock++
        return { source: 'D:/Cache/song.flac' }
      }
    },
    canUseLocalSource: async () => true
  })
  assert.equal(await resolver.resolve(track), null)
  assert.equal(calls, 2)
})

test('a denied media grant is not retried or bypassed with a persisted path', async () => {
  let calls = 0
  let checks = 0
  const resolver = createSourceResolver({
    callProvider: async () => {
      calls++
      return 'twilight-media://audio/denied'
    },
    grants: {
      resolve: async () => {
        throw new Error('grant denied')
      }
    },
    canUseLocalSource: async () => {
      checks++
      return true
    }
  })
  await assert.rejects(resolver.resolve({ ...track, filePath: 'D:/Cache/old.flac' }), {
    code: 'SOURCE_ACCESS_DENIED'
  })
  assert.equal(calls, 1)
  assert.equal(checks, 0)
})

test('cancellation during cache authorization cannot dispatch a late forced refresh', async () => {
  const controller = new AbortController()
  let checked!: () => void
  const checking = new Promise<void>((resolve) => {
    checked = resolve
  })
  let complete!: (value: boolean) => void
  let calls = 0
  const resolver = createSourceResolver({
    callProvider: async () => {
      calls++
      return 'D:/Cache/song.flac'
    },
    canUseLocalSource: async (_source, signal) => {
      assert.equal(signal, controller.signal)
      checked()
      return new Promise<boolean>((resolve) => {
        complete = resolve
      })
    }
  })
  const pending = resolver.resolve(track, controller.signal)
  await checking
  controller.abort()
  complete(false)
  assert.equal(await pending, null)
  assert.equal(calls, 1)
  assert.equal(await resolver.resolve(track, controller.signal), null)
  assert.equal(calls, 1)
})

test('local, CUE, SACD, radio and podcast sources never call a provider', async () => {
  const resolver = createSourceResolver({
    callProvider: async () => assert.fail('unexpected provider')
  })
  const cases = [
    { id: 'local:1', source: 'local', filePath: 'D:/Music/song.flac' },
    { id: 'D:/Music/legacy.flac', filePath: 'D:/Music/legacy.flac' },
    {
      id: 'cue',
      source: 'local',
      filePath: 'D:/Music/disc.flac',
      cueRange: { startSeconds: 30, endSeconds: 60 },
      subTrack: 'D:/Music/incorrect.flac'
    },
    {
      id: 'sacd',
      source: 'local',
      filePath: 'D:/Music/disc.iso',
      subTrack: 'D:/Music/disc.iso?area=stereo&track=2'
    },
    { id: 'radio:1', source: 'radio', streamUrl: 'https://radio.test/live' },
    { id: 'podcast:1', source: 'podcast', filePath: 'https://podcast.test/episode.mp3' }
  ]
  for (const entry of cases) {
    const expected = entry.cueRange
      ? entry.filePath
      : (entry.subTrack ?? entry.filePath ?? entry.streamUrl)
    assert.deepEqual(await resolver.resolve(entry), { source: expected, expiresAt: null })
  }
})
