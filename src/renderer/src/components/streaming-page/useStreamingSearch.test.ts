import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import type { SearchSourceOption } from './useStreamingSearch.ts'

const { useStreamingSearch } = (await import(
  new URL('./useStreamingSearch.ts', import.meta.url).href
)) as typeof import('./useStreamingSearch')

const localTrack = {
  id: 'local:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Local Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

const providerTrack = {
  id: 'ncm:moon',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Online Album',
  filePath: 'ncm:moon',
  fileName: 'Moon River',
  duration: 180,
  size: 0,
  cover: null,
  lyrics: null,
  source: 'ncm'
}

const defaultSources = ref<SearchSourceOption[]>([
  {
    id: 'all',
    label: '全部',
    available: true,
    supportedTypes: ['songs', 'playlists', 'artists']
  },
  { id: 'local', label: '本地音乐', available: true, supportedTypes: ['songs'] },
  {
    id: 'ncm',
    label: '网易云',
    available: true,
    supportedTypes: ['songs', 'playlists', 'artists']
  }
])

const albumSources = ref<SearchSourceOption[]>(
  ['all', 'local', 'ncm'].map((id) => ({
    id,
    label: id,
    available: true,
    supportedTypes: ['songs', 'albums']
  }))
)

test('album search routes all, local and provider requests with independent pagination', async (t) => {
  const calls: Array<[string, number]> = []
  const page = (source: string, offset = 0) => {
    calls.push([source, offset])
    return {
      albums: [
        {
          id: String(offset),
          name: 'Album',
          cover: null,
          trackCount: 2,
          providerId: source,
          providerName: source
        }
      ],
      total: 61
    }
  }
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchAlbums: async (_query, _limit, offset) => page('all', offset),
    searchLocalAlbums: async (_query, _limit, offset) => page('local', offset),
    searchProviderAlbums: async (id, _query, limit, offset, options) => {
      assert.equal(limit, 30)
      assert.ok(options?.signal)
      return page(id, offset)
    },
    searchSources: albumSources,
    playTrack: () => assert.fail('search must not start playback')
  })
  t.after(search.clearSearch)
  search.searchType.value = 'albums'
  search.searchQuery.value = 'Album'
  for (const source of ['all', 'local', 'ncm']) {
    search.searchSource.value = source
    await nextTick()
    await search.performSearch('Album')
    search.onPageChange({ first: 30 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(search.searchAlbumsResults.value[0].id, '30')
    assert.equal(search.searchAlbumsResults.value[0].providerId, source)
  }
  assert.deepEqual(calls, [
    ['all', 0],
    ['all', 30],
    ['local', 0],
    ['local', 30],
    ['ncm', 0],
    ['ncm', 30]
  ])
})

test('album paging recovers a valid page when a failed source leaves fewer results', async (t) => {
  const calls: number[] = []
  let offline = false
  const localAlbum = {
    id: 'local:album',
    name: 'Album',
    cover: null,
    trackCount: 1,
    providerId: 'local',
    providerName: '本地音乐'
  }
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchAlbums: async (_query, _limit, offset = 0) => {
      calls.push(offset)
      return {
        albums: offset === 0 ? [localAlbum] : [],
        total: offline ? 1 : 61
      }
    },
    searchSources: albumSources,
    playTrack: () => {}
  })
  t.after(search.clearSearch)
  search.searchType.value = 'albums'
  search.searchQuery.value = 'Album'
  await nextTick()
  await search.performSearch('Album')
  offline = true
  search.searchOffset.value = 30
  await search.performSearch('Album')
  assert.equal(search.searchOffset.value, 0)
  assert.equal(search.searchTotal.value, 1)
  assert.deepEqual(search.searchAlbumsResults.value, [localAlbum])
  assert.equal(search.searchLoading.value, false)
  assert.equal(search.searchError.value, '')
  assert.deepEqual(calls, [0, 30, 0])
})

test('switching away from an album request cancels it and ignores its late failure', async (t) => {
  let signal!: AbortSignal
  let rejectOld!: (reason: Error) => void
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [localTrack], total: 1 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchProviderAlbums: async (_id, _query, _limit, _offset, options) => {
      signal = options!.signal!
      return new Promise((_resolve, reject) => {
        rejectOld = reject
      })
    },
    searchSources: albumSources,
    playTrack: () => {}
  })
  t.after(search.clearSearch)
  search.searchSource.value = 'ncm'
  search.searchType.value = 'albums'
  search.searchQuery.value = 'Album'
  await nextTick()
  const old = search.performSearch('Album')
  search.searchSource.value = 'all'
  search.searchType.value = 'songs'
  await nextTick()
  assert.equal(signal.aborted, true)
  assert.deepEqual(search.searchAlbumsResults.value, [])
  await search.performSearch('Album')
  rejectOld(new Error('late album failure'))
  await old
  assert.equal(search.searchResults.value[0].id, localTrack.id)
  assert.equal(search.searchTotal.value, 1)
  assert.equal(search.searchError.value, '')
  assert.equal(search.searchLoading.value, false)
})

test('song search uses unified local and provider results when available', async () => {
  let legacySearchCalls = 0
  let unifiedSearchQuery = ''
  const search = useStreamingSearch({
    searchSongs: async () => {
      legacySearchCalls++
      return { tracks: [providerTrack], total: 1 }
    },
    searchUnifiedSongs: async (keywords) => {
      unifiedSearchQuery = keywords
      return { tracks: [localTrack, providerTrack], total: 2 }
    },
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: () => {}
  })
  search.searchSource.value = 'all'
  search.searchQuery.value = 'Moon River'

  await search.performSearch('Moon River')

  assert.equal(unifiedSearchQuery, 'Moon River')
  assert.equal(legacySearchCalls, 0)
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['local:moon', 'ncm:moon']
  )
  assert.equal(search.searchTotal.value, 2)
})

test('song result click plays the visible unified result queue', async () => {
  let playedTrackId = ''
  let queueIds: string[] = []
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchUnifiedSongs: async () => ({ tracks: [localTrack, providerTrack], total: 2 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: (track, queue) => {
      playedTrackId = track.id
      queueIds = queue?.map((item) => item.id) ?? []
    }
  })
  search.searchSource.value = 'all'
  search.searchQuery.value = 'Moon River'
  await search.performSearch('Moon River')

  search.onSearchTrackClick(providerTrack)

  assert.equal(playedTrackId, 'ncm:moon')
  assert.deepEqual(queueIds, ['local:moon', 'ncm:moon'])
})

test('switching source routes to per-provider search', async () => {
  let providerSearchCalls = 0
  let providerSearchId = ''
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [providerTrack], total: 1 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchProviderSongs: async (providerId, keywords) => {
      providerSearchCalls++
      providerSearchId = providerId
      assert.equal(keywords, 'Moon River')
      return { tracks: [providerTrack], total: 1 }
    },
    searchSources: defaultSources,
    playTrack: () => {}
  })
  search.searchSource.value = 'ncm'
  search.searchQuery.value = 'Moon River'

  await search.performSearch('Moon River')

  assert.equal(providerSearchCalls, 1)
  assert.equal(providerSearchId, 'ncm')
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['ncm:moon']
  )
})

test('availableSearchTypes reflects the selected source capabilities', async () => {
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: () => {}
  })

  assert.deepEqual(search.availableSearchTypes.value, ['songs', 'playlists', 'artists'])

  search.searchSource.value = 'local'
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(search.availableSearchTypes.value, ['songs'])
  assert.equal(search.searchType.value, 'songs', 'searchType should auto-switch to songs for local')
})

test('a late search response cannot overwrite a newer source and page snapshot', async () => {
  let resolveProvider!: () => void
  let resolveUnified!: () => void
  const providerPending = new Promise<void>((resolve) => {
    resolveProvider = resolve
  })
  const unifiedPending = new Promise<void>((resolve) => {
    resolveUnified = resolve
  })
  const calls: Array<{ source: string; offset: number }> = []
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchUnifiedSongs: async (_query, _limit, offset = 0) => {
      calls.push({ source: 'all', offset })
      await unifiedPending
      return { tracks: [{ ...localTrack, id: 'all:page-30' }], total: 31 }
    },
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchProviderSongs: async (providerId, _query, _limit, offset = 0) => {
      calls.push({ source: providerId, offset })
      await providerPending
      return { tracks: [{ ...providerTrack, id: 'ncm:page-0' }], total: 31 }
    },
    searchSources: defaultSources,
    playTrack: () => {}
  })

  search.searchSource.value = 'ncm'
  search.searchQuery.value = 'moon'
  await new Promise((resolve) => setTimeout(resolve, 0))
  search.searchOffset.value = 0
  const oldRequest = search.performSearch('moon')

  search.searchSource.value = 'all'
  await new Promise((resolve) => setTimeout(resolve, 0))
  search.searchOffset.value = 30
  const newestRequest = search.performSearch('moon')
  resolveUnified()
  await newestRequest
  resolveProvider()
  await oldRequest

  assert.deepEqual(calls, [
    { source: 'ncm', offset: 0 },
    { source: 'all', offset: 30 }
  ])
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['all:page-30']
  )
  assert.equal(search.searchOffset.value, 30)
  assert.equal(search.searchLoading.value, false)
})

test('a superseded provider search cancels its request without surfacing an error', async () => {
  let firstSignal!: AbortSignal
  let secondSignal!: AbortSignal | undefined
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchProviderSongs: async (_providerId, _keywords, _limit, _offset, options) => {
      if (!firstSignal) {
        firstSignal = options!.signal!
        return new Promise((_resolve, reject) => {
          firstSignal.addEventListener('abort', () => reject(firstSignal.reason))
        })
      }
      secondSignal = options?.signal
      return { tracks: [{ ...providerTrack, id: 'ncm:new' }], total: 1 }
    },
    searchSources: defaultSources,
    playTrack: () => {}
  })
  search.searchSource.value = 'ncm'

  const superseded = search.performSearch('moon')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const newest = search.performSearch('moonlight')
  await superseded
  await newest

  assert.equal(firstSignal.aborted, true)
  assert.equal(secondSignal?.aborted, false)
  assert.equal(search.searchError.value, '')
  assert.equal(search.searchResults.value[0]?.id, 'ncm:new')
})

test('local invalidation refreshes the current page once, forwards cancellation, and recovers a page after deletions', async (t) => {
  const offsets: number[] = []
  let total = 90
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchLocalSongs: async (_query, _limit, offset = 0, options) => {
      assert.ok(options?.signal)
      offsets.push(offset)
      return { tracks: offset < total ? [localTrack] : [], total }
    },
    searchSources: defaultSources,
    playTrack: () => {}
  })
  t.after(search.clearSearch)
  search.searchSource.value = 'local'
  search.searchQuery.value = 'moon'
  await nextTick()
  search.searchOffset.value = 60
  await search.performSearch('moon')
  for (let i = 0; i < 500; i++) search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(offsets, [60, 60])
  total = 31
  search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(offsets, [60, 60, 60, 30])
  assert.equal(search.searchOffset.value, 30)
  assert.equal(search.searchTotal.value, 31)
  assert.equal(search.searchResults.value[0].id, localTrack.id)
  search.refreshSearch()
  search.clearSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(offsets.length, 4)
})

test('artist refreshes preserve deep offsets, recover after deletion, and pass cancellation to local catalog reads', async (t) => {
  const offsets: number[] = [],
    signals: AbortSignal[] = []
  let total = 405
  const artist = { id: 'local-singer', name: 'Singer', picUrl: null }
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchLocalArtists: async (_query, _limit, offset = 0, options) => {
      assert.ok(options?.signal)
      signals.push(options.signal)
      offsets.push(offset)
      return { artists: offset < total ? [artist] : [], total }
    },
    searchSources: ref([
      { id: 'local', label: '本地', available: true, supportedTypes: ['artists'] }
    ]),
    playTrack: () => {}
  })
  t.after(search.clearSearch)
  search.searchSource.value = 'local'
  search.searchType.value = 'artists'
  search.searchQuery.value = 'Singer'
  await nextTick()
  search.searchOffset.value = 300
  await search.performSearch('Singer')
  for (let i = 0; i < 500; i++) search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(offsets, [300, 300])
  total = 31
  search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(offsets, [300, 300, 300, 30])
  assert.equal(search.searchOffset.value, 30)
  assert.equal(search.searchTotal.value, 31)
  assert.equal(search.searchArtistsResults.value[0].id, artist.id)
  assert.equal(signals[2].aborted, true, 'clamping the page supersedes the invalid deep request')
})

test('local database search playback freezes all results, fences stale rows, and preserves provider and JSON queues', async (t) => {
  const query = { search: 'moon', sort: 'playlist' as const, contentRevision: 12 }
  const full: Array<{ query: unknown; id: string }> = [],
    arrays: string[][] = []
  let json = false,
    failure = false
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [providerTrack], total: 1 }),
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchLocalSongs: async () => ({
      tracks: [localTrack],
      total: 405,
      ...(!json ? { playbackQuery: query } : {})
    }),
    searchProviderSongs: async () => ({ tracks: [providerTrack], total: 1 }),
    searchSources: defaultSources,
    playTrack: (_track, queue) => {
      arrays.push(queue!.map((track) => track.id))
    },
    playLibraryQuery: async (value, id) => {
      if (failure) throw new Error('曲库在读取期间发生变化，请重试')
      full.push({ query: value, id })
    }
  })
  t.after(search.clearSearch)
  search.searchSource.value = 'local'
  search.searchQuery.value = 'moon'
  await nextTick()
  search.searchOffset.value = 300
  await search.performSearch('moon')
  search.onSearchTrackClick(localTrack)
  assert.deepEqual(full, [{ query, id: localTrack.id }])
  assert.equal(arrays.length, 0)
  search.searchQuery.value = 'new query'
  search.onSearchTrackClick(localTrack)
  assert.equal(full.length, 1, 'an old row cannot play against a new input before debounce')
  search.searchQuery.value = 'moon'
  await nextTick()
  await search.performSearch('moon')
  failure = true
  search.onSearchTrackClick(localTrack)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(search.searchError.value, /发生变化/)
  assert.equal(arrays.length, 0, 'failed SQL queue creation never plays the current page instead')
  failure = false
  json = true
  await search.performSearch('moon')
  search.onSearchTrackClick(localTrack)
  assert.deepEqual(arrays, [[localTrack.id]])
  search.searchSource.value = 'ncm'
  await nextTick()
  await search.performSearch('moon')
  search.onSearchTrackClick(providerTrack)
  assert.deepEqual(arrays, [[localTrack.id], [providerTrack.id]])
})

test('refreshSearch coalesces during in-flight all-sources search without aborting or flashing loading state', async (t) => {
  const signals: Array<AbortSignal | undefined> = []
  const resolvers: Array<
    (page: { tracks: Array<typeof localTrack | typeof providerTrack>; total: number }) => void
  > = []
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchUnifiedSongs: async (_query, _limit, _offset, options) => {
      signals.push(options?.signal)
      return new Promise((resolve) => {
        resolvers.push(resolve)
      })
    },
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: () => {}
  })
  t.after(search.clearSearch)

  search.searchSource.value = 'all'
  search.searchQuery.value = 'Moon River'
  await nextTick()

  const initial = search.performSearch('Moon River')
  assert.equal(signals.length, 1)
  assert.equal(search.searchLoading.value, true)

  for (let i = 0; i < 5; i++) search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(signals.length, 1, 'refreshSearch must wait for active unified search')
  assert.equal(signals[0]?.aborted, false, 'in-flight unified search must not be aborted')

  resolvers[0]({ tracks: [localTrack], total: 1 })
  await initial
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(signals.length, 2, 'coalesced refresh runs once after active search settles')
  assert.equal(
    search.searchLoading.value,
    false,
    'background refresh must not flip searchLoading back to true'
  )
  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['local:moon'],
    'existing results stay visible during background refresh'
  )

  resolvers[1]({ tracks: [localTrack, providerTrack], total: 2 })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(
    search.searchResults.value.map((track) => track.id),
    ['local:moon', 'ncm:moon']
  )
  assert.equal(search.searchTotal.value, 2)
})

test('refreshSearch skips retries while debounce is pending or searchError is displayed', async (t) => {
  let calls = 0
  let shouldFail = true
  const search = useStreamingSearch({
    searchSongs: async () => ({ tracks: [], total: 0 }),
    searchUnifiedSongs: async () => {
      calls++
      if (shouldFail) throw new Error('provider failure')
      return { tracks: [localTrack], total: 1 }
    },
    searchPlaylists: async () => ({ playlists: [], total: 0 }),
    searchArtists: async () => ({ artists: [], total: 0 }),
    searchSources: defaultSources,
    playTrack: () => {}
  })
  t.after(search.clearSearch)

  search.searchSource.value = 'all'
  search.searchQuery.value = 'Moon'
  await nextTick()

  await search.performSearch('Moon')
  assert.equal(calls, 1)
  assert.ok(search.searchError.value.length > 0)

  shouldFail = false
  search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1, 'refreshSearch must not auto-retry while searchError is displayed')

  search.searchQuery.value = 'Moonlight'
  await nextTick()
  search.refreshSearch()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1, 'refreshSearch must not bypass pending input debounce')
})

test('StreamingSearch keeps result rows mounted instead of flashing loading placeholder when results exist', () => {
  const source = readFileSync(new URL('../StreamingSearch.vue', import.meta.url), 'utf8')
  assert.match(source, /const hasVisibleResults = computed\(/)
  assert.match(source, /v-if="searchLoading && !hasVisibleResults"/)
  assert.doesNotMatch(source, /v-if="searchLoading && searchOffset === 0"/)
})
