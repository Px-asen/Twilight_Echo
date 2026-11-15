import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData } from '../../shared/track.ts'
import {
  CorePlayerPresentationService,
  type CorePlayerPresentationOptions
} from './presentationService.ts'

const song = (id = 'local:1', source = 'local'): TrackData => ({
  id,
  source,
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  filePath: 'D:/Music/song.flac',
  fileName: 'song.flac',
  duration: 180,
  size: 1000,
  cover: null,
  lyrics: null
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(t: test.TestContext, extra: Partial<CorePlayerPresentationOptions> = {}) {
  const errors: unknown[] = []
  let changed = 0
  let liked = false
  const service = new CorePlayerPresentationService({
    artwork: async () => ({ cover: 'cover://song', coverSource: null }),
    playlists: {
      isFavorite: async () => liked,
      toggleFavorite: async (_track, assertCurrent) => {
        assertCurrent()
        liked = !liked
        return liked
      }
    },
    supportedMethods: () => ['likeTrack', 'isTrackLiked'],
    callProvider: async () => false,
    changed: () => {
      changed++
    },
    failed: (error) => errors.push(error),
    ...extra
  })
  t.after(() => service.shutdown())
  return {
    service,
    errors,
    get changed() {
      return changed
    }
  }
}

test('Core artwork and local favorites publish independently, idle observations are idempotent', async (t) => {
  const art = deferred<{ cover: string; coverSource: null }>()
  const f = fixture(t, { artwork: () => art.promise })
  f.service.observe(null)
  assert.equal(f.service.getRevision(), 0)
  f.service.observe(song(), 'one')
  await turn()
  assert.deepEqual(f.service.snapshot().favorite, { available: true, liked: false, loading: false })
  assert.equal(f.service.snapshot().cover, null)
  const toggled = await f.service.toggleFavorite({ trackId: 'local:1', occurrenceId: 'one' })
  assert.equal(toggled.favorite.liked, true)
  art.resolve({ cover: 'cover://ready', coverSource: null })
  await turn()
  assert.equal(f.service.snapshot().cover, 'cover://ready')
  assert.equal(f.service.snapshot().favorite.liked, true)
  const published = f.service.snapshot()
  published.favorite.liked = false
  assert.equal(f.service.snapshot().favorite.liked, true)
})

test('late artwork and provider reads cannot cross repeated queue occurrences', async (t) => {
  const oldArt = deferred<{ cover: string; coverSource: null }>()
  const oldLiked = deferred<boolean>()
  let reads = 0
  const f = fixture(t, {
    artwork: async (_track, signal) =>
      signal.aborted
        ? { cover: null, coverSource: null }
        : ++reads === 1
          ? oldArt.promise
          : { cover: 'cover://new', coverSource: null },
    callProvider: async () => oldLiked.promise
  })
  f.service.observe(song('ncm:123', 'ncm'), 'old')
  f.service.observe(song('ncm:123', 'ncm'), 'new')
  oldArt.resolve({ cover: 'cover://old', coverSource: null })
  oldLiked.resolve(true)
  await turn()
  assert.deepEqual(f.service.snapshot().current, { trackId: 'ncm:123', occurrenceId: 'new' })
  assert.equal(f.service.snapshot().cover, 'cover://new')
  await assert.rejects(f.service.toggleFavorite({ trackId: 'ncm:123', occurrenceId: 'old' }), {
    code: 'STALE_REVISION'
  })
})

test('concurrent local toggles serialize and cancelled queued writes are not dispatched', async (t) => {
  const f = fixture(t)
  f.service.observe(song(), 'one')
  await turn()
  const expected = { trackId: 'local:1', occurrenceId: 'one' }
  const results = await Promise.all([
    f.service.toggleFavorite(expected),
    f.service.toggleFavorite(expected)
  ])
  assert.deepEqual(
    results.map((value) => value.favorite.liked),
    [true, false]
  )
  const cancelled = new AbortController()
  cancelled.abort(new Error('Window closed'))
  await assert.rejects(f.service.toggleFavorite(expected, cancelled.signal), /Window closed/)
  assert.equal(f.service.snapshot().favorite.liked, false)
})

test('accepted provider write finishes once after client disconnect and shutdown joins it', async (t) => {
  const accepted = deferred<void>()
  const reply = deferred<unknown>()
  const writes: unknown[][] = []
  const f = fixture(t, {
    callProvider: async (provider, method, args, signal) => {
      if (method === 'isTrackLiked') return false
      assert.equal(provider, 'ncm')
      assert.equal(signal, undefined)
      writes.push(args)
      accepted.resolve()
      return reply.promise
    }
  })
  f.service.observe({ ...song('ncm:legacy', 'ncm'), ncmSongId: 123 }, 'one')
  await turn()
  const client = new AbortController()
  const write = f.service.toggleFavorite(
    { trackId: 'ncm:legacy', occurrenceId: 'one' },
    client.signal
  )
  await accepted.promise
  client.abort(new Error('Window closed'))
  let stopped = false
  const stopping = f.service.shutdown().then(() => {
    stopped = true
  })
  await turn()
  assert.equal(stopped, false)
  reply.resolve(true)
  assert.equal((await write).favorite.liked, true)
  await stopping
  assert.deepEqual(writes, [[123, true]])
})

test('a failed favorite write is reported without replay, new occurrence refresh resumes after in-flight write', async (t) => {
  const accepted = deferred<void>()
  const reply = deferred<unknown>()
  let writes = 0
  const f = fixture(t, {
    callProvider: async (_provider, method) => {
      if (method === 'isTrackLiked') return false
      writes++
      accepted.resolve()
      return reply.promise
    }
  })
  f.service.observe(song('bili:old', 'bili'), 'old')
  await turn()
  const write = f.service.toggleFavorite({ trackId: 'bili:old', occurrenceId: 'old' })
  await accepted.promise
  f.service.observe(song('bili:new', 'bili'), 'new')
  reply.reject(new Error('Reply lost'))
  await assert.rejects(write, /Reply lost/)
  await turn()
  assert.equal(writes, 1)
  assert.deepEqual(f.service.snapshot().current, { trackId: 'bili:new', occurrenceId: 'new' })
  assert.equal(f.service.snapshot().favorite.available, true)
  assert.equal(f.service.snapshot().favorite.loading, false)
  assert.equal(f.service.snapshot().cover, 'cover://song')
})

test('unsupported provider favorites stay unavailable rather than writing the local collection', async (t) => {
  const f = fixture(t, { supportedMethods: () => [] })
  f.service.observe(song('custom:123', 'custom'), 'one')
  await turn()
  assert.deepEqual(f.service.snapshot().favorite, {
    available: false,
    liked: false,
    loading: false
  })
  await assert.rejects(
    f.service.toggleFavorite({ trackId: 'custom:123', occurrenceId: 'one' }),
    /不支持收藏/
  )
})

test('provider tracks missing persisted artwork recover exact-identity cover via searchSongs and never borrow title-only matches', async (t) => {
  let searches = 0
  const recoveredCalls: Array<{ id: string; coverSource: string | null }> = []
  const f = fixture(t, {
    artwork: async (track) =>
      track.coverSource || track.cover
        ? { cover: 'twilight-media://image/recovered', coverSource: null }
        : { cover: null, coverSource: null },
    artworkRecovered: (track, artwork) => {
      recoveredCalls.push({ id: track.id, coverSource: artwork.coverSource })
    },
    supportedMethods: () => ['likeTrack', 'isTrackLiked', 'searchSongs'],
    callProvider: async (_providerId, method, args) => {
      if (method === 'isTrackLiked') return false
      if (method === 'searchSongs') {
        searches++
        const query = String(args[0] ?? '')
        if (query.includes('Mismatch')) {
          return {
            items: [
              {
                id: 'ncm:999',
                source: 'ncm',
                title: 'Mismatch',
                cover: 'twilight-media://image/wrong',
                coverSource: 'https://p2.music.126.net/wrong.jpg'
              }
            ]
          }
        }
        return {
          items: [
            {
              id: 'ncm:999',
              source: 'ncm',
              title: 'Is this love?',
              cover: 'twilight-media://image/wrong',
              coverSource: 'https://p2.music.126.net/wrong.jpg'
            },
            {
              id: 'ncm:42',
              source: 'ncm',
              ncmSongId: 42,
              title: 'Is this love?',
              artist: 'twenty4-7',
              cover: 'twilight-media://image/provider_grant',
              coverSource: 'https://p2.music.126.net/exact.jpg'
            }
          ]
        }
      }
      return null
    }
  })
  f.service.observe(
    { ...song('ncm:88', 'ncm'), ncmSongId: 88, title: 'Mismatch', artist: 'Artist' },
    'occ-1'
  )
  await turn()
  await turn()
  assert.equal(f.service.snapshot().cover, null)
  assert.equal(searches, 1)

  const exactTrack = {
    ...song('ncm:42', 'ncm'),
    ncmSongId: 42,
    title: 'Is this love?',
    artist: 'twenty4-7'
  }
  f.service.observe(exactTrack, 'occ-2')
  await turn()
  await turn()
  assert.equal(f.service.snapshot().cover, 'twilight-media://image/recovered')
  assert.equal(f.service.snapshot().coverSource, null)
  assert.equal(searches, 2)

  // Repeated occurrence of the same track reuses the cached cover match without re-searching.
  f.service.observe(exactTrack, 'occ-3')
  await turn()
  await turn()
  assert.equal(f.service.snapshot().cover, 'twilight-media://image/recovered')
  assert.equal(searches, 2)
  assert.deepEqual(recoveredCalls, [
    { id: 'ncm:42', coverSource: 'https://p2.music.126.net/exact.jpg' },
    { id: 'ncm:42', coverSource: 'https://p2.music.126.net/exact.jpg' }
  ])
  assert.deepEqual(f.errors, [])
})

test('resolveMv resolves online NCM tracks, metadataMatch local tracks, search fallback local tracks, and enforces twilight-media handles', async (t) => {
  let providerCalls = 0
  const f = fixture(t, {
    listProviderIds: () => ['bili', 'ncm'],
    supportedMethods: (id) =>
      id === 'ncm' || id === 'bili' ? ['searchSongs', 'getTrackMv'] : [],
    callProvider: async (providerId, method, args) => {
      providerCalls++
      if (providerId === 'ncm' && method === 'getTrackMv') {
        const lookup = args[0] as { id?: string; mvId?: string }
        if (lookup.id === 'ncm:500' || lookup.mvId === '9001') {
          return {
            url: 'twilight-media://video/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            quality: '1080p',
            width: 1920,
            height: 1080,
            mvId: '9001'
          }
        }
        return null
      }
      if (providerId === 'ncm' && method === 'searchSongs') {
        return {
          items: [
            {
              id: 'ncm:500',
              source: 'ncm',
              title: '夜曲',
              artist: '周杰伦',
              duration: 226,
              mvId: '9001'
            }
          ]
        }
      }
      if (providerId === 'bili' && method === 'getTrackMv') {
        return {
          url: 'twilight-media://video/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          audioUrl: 'twilight-media://audio/cccccccccccccccccccccccccccccccc',
          coverUrl: 'twilight-media://image/dddddddddddddddddddddddddddddddd',
          quality: '1080p',
          mvId: 'BV1mv'
        }
      }
      return null
    }
  })

  // 1. Direct provider track (including companion DASH audioUrl for external plugin)
  f.service.observe({ ...song('bili:BV1mv', 'bili'), title: '夜曲 MV', artist: '周杰伦' }, 'occ-bili')
  const biliResult = await f.service.resolveMv({
    trackId: 'bili:BV1mv',
    occurrenceId: 'occ-bili',
    quality: '1080p'
  })
  assert.equal(biliResult.available, true)
  assert.equal(biliResult.stream?.providerId, 'bili')
  assert.equal(biliResult.stream?.url, 'twilight-media://video/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(
    biliResult.stream?.audioUrl,
    'twilight-media://audio/cccccccccccccccccccccccccccccccc'
  )

  // 2. Stale occurrence fence returns unavailable without leaking stream
  const stale = await f.service.resolveMv({
    trackId: 'bili:BV1mv',
    occurrenceId: 'wrong-occurrence'
  })
  assert.equal(stale.available, false)
  assert.equal(stale.stream, null)

  // 3. Unmatched local track falls back to searchSongs + pickBestLyricSearchMatch -> NCM MV
  f.service.observe(
    { ...song('local:nocturne', 'local'), title: '夜曲', artist: '周杰伦', duration: 226 },
    'occ-local'
  )
  const localResult = await f.service.resolveMv({
    trackId: 'local:nocturne',
    occurrenceId: 'occ-local'
  })
  assert.equal(localResult.available, true)
  assert.equal(localResult.stream?.providerId, 'ncm')
  assert.equal(localResult.stream?.mvId, '9001')

  // Cached repeat avoids calling providers again unless force=true
  const callsBeforeCached = providerCalls
  const cachedResult = await f.service.resolveMv({
    trackId: 'local:nocturne',
    occurrenceId: 'occ-local'
  })
  assert.equal(cachedResult.available, true)
  assert.equal(providerCalls, callsBeforeCached)
})

test('resolveMv prioritizes Bilibili first and automatically falls back to NetEase when Bilibili has no MV, while allowing manual NCM switch', async (t) => {
  let biliCalls = 0
  let ncmCalls = 0
  let biliAvailable = true

  const f = fixture(t, {
    listProviderIds: () => ['ncm'],
    supportedMethods: (id) => (id === 'ncm' ? ['searchSongs', 'getTrackMv'] : []),
    resolveBilibiliMv: async (track) => {
      biliCalls++
      if (!biliAvailable || track.title === '仅网易云有MV') return null
      return {
        url: 'twilight-media://video/bilibilibilibilibilibilibilibili',
        quality: '1080p',
        width: 1920,
        height: 1080,
        providerId: 'bili',
        mvId: 'BV17t4y1r7Jq',
        title: '春泥棒 MV'
      }
    },
    callProvider: async (providerId, method) => {
      if (providerId === 'ncm' && method === 'getTrackMv') {
        ncmCalls++
        return {
          url: 'twilight-media://video/ncmncmncmncmncmncmncmncmncmncmnc',
          quality: '1080p',
          width: 1920,
          height: 1080,
          providerId: 'ncm',
          mvId: '14288888'
        }
      }
      return null
    }
  })

  f.service.observe(
    { ...song('ncm:1811921555', 'ncm'), title: '春泥棒', artist: 'ヨルシカ', duration: 290 },
    'occ-spring'
  )

  // 1. Default ('bili' / 'auto') prioritizes watermark-free Bilibili MV first
  const defaultRes = await f.service.resolveMv({
    trackId: 'ncm:1811921555',
    occurrenceId: 'occ-spring',
    source: 'bili'
  })
  assert.equal(defaultRes.available, true)
  assert.equal(defaultRes.stream?.providerId, 'bili')
  assert.equal(defaultRes.stream?.mvId, 'BV17t4y1r7Jq')
  assert.equal(biliCalls, 1)
  assert.equal(ncmCalls, 0)

  // 2. Switching source to 'ncm' prioritizes NetEase MV with separate cache entry
  const ncmRes = await f.service.resolveMv({
    trackId: 'ncm:1811921555',
    occurrenceId: 'occ-spring',
    source: 'ncm'
  })
  assert.equal(ncmRes.available, true)
  assert.equal(ncmRes.stream?.providerId, 'ncm')
  assert.equal(ncmRes.stream?.mvId, '14288888')
  assert.equal(biliCalls, 1)
  assert.equal(ncmCalls, 1)

  // 3. When Bilibili fails to obtain an MV, BOTH 'bili' and 'auto' automatically switch to NetEase!
  biliAvailable = false
  f.service.observe(
    { ...song('ncm:199999', 'ncm'), title: '仅网易云有MV', artist: '歌手', duration: 240 },
    'occ-ncm-only'
  )
  const biliFallbackToNcm = await f.service.resolveMv({
    trackId: 'ncm:199999',
    occurrenceId: 'occ-ncm-only',
    source: 'bili'
  })
  assert.equal(biliFallbackToNcm.available, true)
  assert.equal(biliFallbackToNcm.stream?.providerId, 'ncm')
  assert.equal(biliFallbackToNcm.stream?.mvId, '14288888')
})

