import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData as Track } from '../../../shared/track.ts'
import { searchMetadataTracks } from './musicMetadataSearch.ts'

const {
  enrichLocalTracksFromProviders,
  LibraryMetadataEnrichmentQueue,
  runLibraryMetadataEnrichmentBenchmark
} = (await import(
  new URL('./libraryMetadataEnrichment.ts', import.meta.url).href
)) as typeof import('./libraryMetadataEnrichment')

const localTrack = {
  id: 'local:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: '',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local' as const,
  format: 'flac'
}

test(
  'metadata acceptance backpressures a duplicate group and cancellation stops subsequent writes',
  { timeout: 3000 },
  async () => {
    let started!: () => void, release!: () => void
    const accepting = new Promise<void>((resolve) => {
      started = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const queue = new LibraryMetadataEnrichmentQueue({
      provider: {
        searchSongs: async () => ({ items: [createProviderTrack(localTrack)], total: 1 })
      },
      onTrackEnriched: async () => {
        writes++
        started()
        await hold
      }
    })
    const complete = queue.enqueue(
      Array.from({ length: 500 }, (_, index) => ({ ...localTrack, id: `local:${index}` }))
    )
    await accepting
    assert.equal(writes, 1)
    assert.equal(queue.getStatus().state, 'enriching')
    assert.equal(queue.cancel(), true)
    release()
    await complete
    await Promise.resolve()
    assert.equal(writes, 1)
    assert.equal(queue.getStatus().state, 'cancelled')
  }
)

test('metadata write failures are reported as persistence failures, not provider outages', async () => {
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: { searchSongs: async () => ({ items: [createProviderTrack(localTrack)], total: 1 }) },
    onTrackEnriched: async () => {
      throw new Error('disk full')
    }
  })
  await queue.enqueue([localTrack])
  assert.equal(queue.getStatus().state, 'failed')
  assert.match(queue.getStatus().error, /元数据保存失败/)
})

test('enrichLocalTracksFromProviders fills missing local metadata from provider search results', async () => {
  const enriched = await enrichLocalTracksFromProviders([localTrack], {
    searchSongs: async (query) => {
      assert.equal(query, 'Moon River Audrey')
      return {
        items: [
          {
            id: 'ncm:123',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online Album',
            filePath: 'ncm:123',
            fileName: 'Moon River',
            duration: 179,
            size: 0,
            cover: 'https://cover.example/album.jpg',
            lyrics: '[00:00.00]Moon River',
            translatedLyrics: '[00:00.00]月亮河',
            source: 'ncm' as const,
            streamUrl: 'https://temporary.example/song.mp3'
          }
        ],
        total: 1
      }
    }
  })

  assert.equal(enriched[0].id, 'local:moon')
  assert.equal(enriched[0].filePath, 'D:\\Music\\Moon River.flac')
  assert.equal(enriched[0].album, 'Online Album')
  assert.equal(enriched[0].cover, 'https://cover.example/album.jpg')
  assert.equal(enriched[0].lyrics, '[00:00.00]Moon River')
  assert.equal(enriched[0].translatedLyrics, '[00:00.00]月亮河')
  assert.deepEqual(enriched[0].metadataMatch, {
    providerId: 'ncm',
    trackId: 'ncm:123',
    confidence: 'high',
    score: 96
  })
  assert.equal(enriched[0].streamUrl, undefined)
})

test('enrichLocalTracksFromProviders keeps local playback working when provider search fails', async () => {
  const enriched = await enrichLocalTracksFromProviders([localTrack], {
    searchSongs: async () => {
      throw new Error('provider unavailable')
    }
  })

  assert.deepEqual(enriched, [localTrack])
})

test('enrichLocalTracksFromProviders respects disabled provider metadata cache policy', async () => {
  const enriched = await enrichLocalTracksFromProviders(
    [localTrack],
    {
      searchSongs: async () => ({
        items: [
          {
            id: 'ncm:123',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online Album',
            filePath: 'ncm:123',
            fileName: 'Moon River',
            duration: 179,
            size: 0,
            cover: 'https://cover.example/album.jpg',
            lyrics: '[00:00.00]Moon River',
            translatedLyrics: '[00:00.00]月亮河',
            source: 'ncm' as const
          }
        ],
        total: 1
      })
    },
    {
      cachePolicy: {
        cover: false,
        lyrics: false,
        metadata: false
      }
    }
  )

  assert.deepEqual(enriched, [localTrack])
})

test('enrichLocalTracksFromProviders can cache cover without lyrics or album metadata', async () => {
  const enriched = await enrichLocalTracksFromProviders(
    [localTrack],
    {
      searchSongs: async () => ({
        items: [
          {
            id: 'ncm:123',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online Album',
            filePath: 'ncm:123',
            fileName: 'Moon River',
            duration: 179,
            size: 0,
            cover: 'https://cover.example/album.jpg',
            lyrics: '[00:00.00]Moon River',
            translatedLyrics: '[00:00.00]月亮河',
            source: 'ncm' as const
          }
        ],
        total: 1
      })
    },
    {
      cachePolicy: {
        cover: true,
        lyrics: false,
        metadata: false
      }
    }
  )

  assert.equal(enriched[0].album, '')
  assert.equal(enriched[0].cover, 'https://cover.example/album.jpg')
  assert.equal(enriched[0].lyrics, null)
  assert.equal(enriched[0].translatedLyrics, undefined)
})

test('enrichLocalTracksFromProviders skips local tracks that already have enrichment metadata', async () => {
  let calls = 0
  const enrichedTrack = {
    ...localTrack,
    album: 'Local Album',
    genre: 'Jazz',
    cover: 'cover://embedded',
    lyrics: '[00:00.00]local',
    translatedLyrics: '[00:00.00]local translated'
  }

  const enriched = await enrichLocalTracksFromProviders([enrichedTrack], {
    searchSongs: async () => {
      calls++
      return { items: [], total: 0 }
    }
  })

  assert.equal(calls, 0)
  assert.deepEqual(enriched, [enrichedTrack])
})

test('enrichLocalTracksFromProviders does not re-query tracks only missing genre, translatedLyrics, or non-provided lyrics', async () => {
  let calls = 0
  const trackWithoutGenreOrTranslation = {
    ...localTrack,
    album: 'Local Album',
    genre: undefined,
    cover: 'cover://embedded',
    lyrics: '[00:00.00]local',
    translatedLyrics: null
  }
  await enrichLocalTracksFromProviders([trackWithoutGenreOrTranslation], {
    searchSongs: async () => {
      calls++
      return { items: [], total: 0 }
    }
  })
  assert.equal(calls, 0)

  const scannedFlacTrack = {
    ...localTrack,
    album: 'Local Album',
    genre: undefined,
    cover: 'cover://embedded',
    lyrics: null
  }
  await enrichLocalTracksFromProviders([scannedFlacTrack], {
    providesLyrics: false,
    searchSongs: async () => {
      calls++
      return { items: [], total: 0 }
    }
  })
  assert.equal(calls, 0)
})

test('metadata enrichment queue deduplicates matching queries and updates every local track', async () => {
  const statuses: string[] = []
  const updates: string[] = []
  let searches = 0
  const secondTrack = {
    ...localTrack,
    id: 'local:moon-live',
    filePath: 'D:\\Music\\Moon River Live.flac',
    fileName: 'Moon River Live.flac'
  }
  const queue = new LibraryMetadataEnrichmentQueue({
    concurrency: 8,
    provider: {
      searchSongs: async (query) => {
        searches += 1
        assert.equal(query, 'Moon River Audrey')
        return { items: [createProviderTrack(localTrack)], total: 1 }
      }
    },
    onStatus: (status) => statuses.push(status.state),
    onTrackEnriched: (update) => updates.push(update.track.id)
  })

  await queue.enqueue([localTrack, secondTrack])

  assert.equal(searches, 1)
  assert.deepEqual(updates.sort(), ['local:moon', 'local:moon-live'])
  assert.ok(statuses.includes('enriching'))
  assert.equal(queue.getStatus().state, 'completed')
  assert.equal(queue.getStatus().completed, 2)
})

test('metadata searches retry by title when combined keywords return no usable match', async () => {
  const queries: string[] = []
  const enriched = await enrichLocalTracksFromProviders([localTrack], {
    searchSongs: async (query) => {
      queries.push(query)
      return {
        items: query === localTrack.title ? [createProviderTrack(localTrack)] : [],
        total: 1
      }
    }
  })
  assert.deepEqual(queries, ['Moon River Audrey', 'Moon River'])
  assert.equal(enriched[0].metadataMatch?.providerId, 'ncm')
})

test('manual metadata search retries the lead artist with a larger bounded candidate page', async () => {
  const track = { ...localTrack, artist: 'Audrey;Guest' }
  const candidate = createProviderTrack({ ...localTrack, artist: 'Guest / Audrey' })
  const queries: string[] = []
  const candidates = await searchMetadataTracks([track], async (query, limit, offset) => {
    queries.push(query)
    assert.equal(limit, 30)
    assert.equal(offset, 0)
    return { items: query === 'Moon River Audrey' ? [candidate] : [] }
  })
  assert.deepEqual(queries, ['Moon River Audrey Guest', 'Moon River Audrey'])
  assert.deepEqual(candidates, [candidate])
})

test('metadata search cancellation prevents fallback requests after a late response', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    searchMetadataTracks(
      [localTrack],
      async (_query, _limit, _offset, signal) => {
        calls += 1
        assert.equal(signal, controller.signal)
        controller.abort()
        return { items: [] }
      },
      { signal: controller.signal }
    ),
    { name: 'AbortError' }
  )
  assert.equal(calls, 1)
})

test('metadata enrichment searches real title without Unknown Artist and fills placeholders', async () => {
  const track = { ...localTrack, artist: 'Unknown Artist', album: 'Unknown Album' }
  const queries: string[] = []
  const enriched = await enrichLocalTracksFromProviders([track], {
    searchSongs: async (query) => {
      queries.push(query)
      return { items: [createProviderTrack(localTrack)], total: 1 }
    }
  })
  assert.deepEqual(queries, ['Moon River'])
  assert.equal(enriched[0].artist, 'Audrey')
  assert.equal(enriched[0].album, 'Online Album')
})

test('metadata queue shares fallback searches for duplicate tracks and still rejects wrong artists', async () => {
  const queries: string[] = []
  const updates: Track[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async (query) => {
        queries.push(query)
        return {
          items: [
            { ...createProviderTrack(localTrack), id: 'ncm:wrong', artist: 'Other Singer' },
            ...(query === localTrack.title ? [createProviderTrack(localTrack)] : [])
          ],
          total: 2
        }
      }
    },
    onTrackEnriched: ({ track }) => updates.push(track)
  })
  await queue.enqueue([localTrack, { ...localTrack, id: 'local:copy' }])
  assert.deepEqual(queries, ['Moon River Audrey', 'Moon River'])
  assert.equal(updates.length, 2)
  assert.ok(updates.every((track) => track.metadataMatch?.trackId === `ncm:${localTrack.id}`))
})

test('metadata enrichment deduplicates an active query while retaining each track policy', async () => {
  let searches = 0
  let resolveSearch: ((value: { items: Track[]; total: number }) => void) | null = null
  const updates = new Map<string, Track>()
  const secondTrack = {
    ...localTrack,
    id: 'local:moon-policy-two',
    filePath: 'D:\\Music\\Moon River Policy Two.flac',
    fileName: 'Moon River Policy Two.flac'
  }
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () => {
        searches += 1
        return await new Promise((resolve) => {
          resolveSearch = resolve
        })
      }
    },
    onTrackEnriched: (update) => updates.set(update.track.id, update.track)
  })

  const coverOnly = queue.enqueue([localTrack], { cover: true, lyrics: false, metadata: false })
  await waitFor(() => searches === 1)
  const lyricsOnly = queue.enqueue([secondTrack], { cover: false, lyrics: true, metadata: false })
  ;(resolveSearch as ((value: { items: Track[]; total: number }) => void) | null)?.({
    items: [createProviderTrack(localTrack)],
    total: 1
  })
  await Promise.all([coverOnly, lyricsOnly])

  assert.equal(searches, 1)
  assert.equal(updates.get(localTrack.id)?.cover, 'https://cover.example/album.jpg')
  assert.equal(updates.get(localTrack.id)?.lyrics, null)
  assert.equal(updates.get(secondTrack.id)?.cover, null)
  assert.equal(updates.get(secondTrack.id)?.lyrics, '[00:00.00]Moon River')
})

test('metadata enrichment queue caches query failures with retry backoff', async () => {
  let now = 1_000
  let searches = 0
  let shouldFail = true
  const queue = new LibraryMetadataEnrichmentQueue({
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    now: () => now,
    provider: {
      searchSongs: async () => {
        searches += 1
        if (shouldFail) throw new Error('offline')
        return { items: [createProviderTrack(localTrack)], total: 1 }
      }
    }
  })

  await queue.enqueue([localTrack])
  assert.equal(searches, 1)
  assert.equal(queue.getStatus().state, 'failed')

  await queue.enqueue([localTrack])
  assert.equal(searches, 1, 'the same query must respect its cached retry window')
  assert.equal(queue.getStatus().skipped, 1)

  shouldFail = false
  now += 100
  await queue.enqueue([localTrack])
  assert.equal(searches, 2)
  assert.equal(queue.getStatus().state, 'completed')
})

test('metadata enrichment cancellation drops late provider results', async () => {
  let resolveSearch: ((value: { items: Track[]; total: number }) => void) | null = null
  let started = false
  const updates: string[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () => {
        started = true
        return await new Promise((resolve) => {
          resolveSearch = resolve
        })
      }
    },
    onTrackEnriched: (update) => updates.push(update.track.id)
  })

  const run = queue.enqueue([localTrack])
  await waitFor(() => started)
  assert.equal(queue.cancel(), true)
  ;(resolveSearch as ((value: { items: Track[]; total: number }) => void) | null)?.({
    items: [createProviderTrack(localTrack)],
    total: 1
  })
  await run
  await Promise.resolve()

  assert.equal(queue.getStatus().state, 'cancelled')
  assert.deepEqual(updates, [])
})

test('a cancelled query can immediately restart while its old provider response is still pending', async () => {
  const responses: Array<(value: { items: Track[]; total: number }) => void> = []
  const updates: Track[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () =>
        await new Promise((resolve) => {
          responses.push(resolve)
        })
    },
    onTrackEnriched: ({ track }) => updates.push(track)
  })
  const firstRun = queue.enqueue([localTrack])
  await waitFor(() => responses.length === 1)
  assert.equal(queue.cancel(), true)
  await firstRun
  const secondRun = queue.enqueue([localTrack])
  await waitFor(() => responses.length === 2)
  responses[0]({ items: [createProviderTrack(localTrack)], total: 1 })
  responses[1]({ items: [createProviderTrack(localTrack)], total: 1 })
  await secondRun
  assert.equal(updates.length, 1)
  assert.equal(queue.getStatus().completed, 1)
  assert.equal(queue.getStatus().state, 'completed')
})

test('metadata enrichment cancellation aborts providers that expose AbortSignal support', async () => {
  let aborted = false
  let started = false
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async (_query, _limit, _offset, signal) => {
        started = true
        return await new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('cancelled', 'AbortError'))
          })
        })
      }
    }
  })

  const run = queue.enqueue([localTrack])
  await waitFor(() => started)
  assert.equal(queue.cancel(), true)
  await run

  assert.equal(aborted, true)
  assert.equal(queue.getStatus().state, 'cancelled')
})

test('metadata enrichment updates retain the source snapshot for stale-result fencing', async () => {
  const updates: Array<{ source: Track; track: Track }> = []
  const queue = new LibraryMetadataEnrichmentQueue({
    provider: {
      searchSongs: async () => ({ items: [createProviderTrack(localTrack)], total: 1 })
    },
    onTrackEnriched: (update) => updates.push(update)
  })

  await queue.enqueue([localTrack])

  assert.equal(updates.length, 1)
  assert.equal(updates[0].source, localTrack)
  assert.equal(updates[0].track.id, localTrack.id)
  assert.notEqual(updates[0].track, localTrack)
})

test('metadata enrichment queue caps concurrent queries while deduplicating the same track', async () => {
  const tracks = Array.from({ length: 24 }, (_, index) => ({
    ...localTrack,
    id: `local:concurrent-${index}`,
    title: `Concurrent ${index}`,
    artist: 'Queue Artist',
    filePath: `D:\\Music\\Concurrent ${index}.flac`,
    fileName: `Concurrent ${index}.flac`
  }))
  let active = 0
  let maxActive = 0
  let searches = 0
  const updates: string[] = []
  const states: string[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    concurrency: 6,
    provider: {
      searchSongs: async (query) => {
        searches += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        const source = tracks.find((track) => `${track.title} ${track.artist}` === query)!
        return { items: [createProviderTrack(source)], total: 1 }
      }
    },
    onStatus: (status) => states.push(status.state),
    onTrackEnriched: (update) => updates.push(update.track.id)
  })

  await queue.enqueue([...tracks, tracks[0]])

  assert.equal(searches, tracks.length)
  assert.equal(maxActive, 6)
  assert.equal(updates.length, tracks.length)
  assert.equal(new Set(updates).size, tracks.length)
  assert.ok(states.includes('enriching'))
  assert.equal(queue.getStatus().state, 'completed')
})

test('metadata enrichment benchmark handles a large library with bounded query work', async () => {
  const result = await runLibraryMetadataEnrichmentBenchmark({
    trackCount: 2_000,
    uniqueQueryCount: 200,
    concurrency: 6
  })

  assert.equal(result.queryCalls, 200)
  assert.equal(result.maxConcurrentQueries, 6)
  assert.ok(result.durationMs >= 0)
  console.log(
    `metadata enrichment benchmark: ${result.trackCount} tracks, ${result.queryCalls} queries, ${result.durationMs.toFixed(1)}ms`
  )
})

test('metadata enrichment paces background queries and pauses remaining work during upstream 405 cooldowns', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const tracks = [0, 1, 2].map((index) => ({
    ...localTrack,
    id: `local:rate-limit-${index}`,
    title: `RateSong ${index}`,
    artist: 'RateArtist',
    filePath: `D:\\Music\\RateSong ${index}.flac`,
    fileName: `RateSong ${index}.flac`
  }))
  const callTimes: Array<{ query: string; at: number }> = []
  const enrichedIds: string[] = []
  const queue = new LibraryMetadataEnrichmentQueue({
    concurrency: 2,
    minQueryIntervalMs: 1_200,
    rateLimitCooldownMs: 60_000,
    provider: {
      searchSongs: async (query) => {
        const at = Date.now()
        callTimes.push({ query, at })
        if (callTimes.length === 1) {
          throw new Error('操作频繁，请稍候再试 (405)')
        }
        const matched = tracks.find((item) => `${item.title} ${item.artist}` === query)!
        return { items: [createProviderTrack(matched)], total: 1 }
      }
    },
    onTrackEnriched: ({ track }) => enrichedIds.push(track.id)
  })
  t.after(() => queue.dispose())

  const run = queue.enqueue(tracks)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(callTimes.length, 1, 'first query runs immediately and triggers 60s cooldown')

  // Advancing 10 seconds inside the 60s cooldown must not fire the remaining tracks into 405s.
  t.mock.timers.tick(10_000)
  await Promise.resolve()
  assert.equal(callTimes.length, 1, 'remaining tracks pause during rate-limit cooldown')

  // Once the 60s cooldown expires, remaining tracks resume at minQueryIntervalMs spacing.
  t.mock.timers.tick(50_000)
  await Promise.resolve()
  await Promise.resolve()
  t.mock.timers.tick(1_200)
  await run

  assert.equal(callTimes.length, 3)
  assert.ok(callTimes[1].at >= 60_000)
  assert.ok(callTimes[2].at - callTimes[1].at >= 1_200)
  assert.deepEqual(enrichedIds.sort(), ['local:rate-limit-1', 'local:rate-limit-2'])
  assert.equal(queue.getStatus().failed, 1)
  assert.equal(queue.getStatus().completed, 2)
})

function createProviderTrack(track: typeof localTrack): Track {
  return {
    ...track,
    id: `ncm:${track.id}`,
    filePath: `ncm:${track.id}`,
    fileName: track.title,
    album: 'Online Album',
    cover: 'https://cover.example/album.jpg',
    lyrics: '[00:00.00]Moon River',
    translatedLyrics: '[00:00.00]月亮河',
    source: 'ncm'
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition was not reached')
}
