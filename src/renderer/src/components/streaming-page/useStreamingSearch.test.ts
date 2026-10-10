import assert from 'node:assert/strict'
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
