import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { compileStyle } from '@vue/compiler-sfc'
import { computed, effectScope, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import { createCorePlayerQueue } from '../../stores/player/corePlayerQueue.ts'
import type { CorePlayerClient } from '../../stores/player/corePlayerTypes.ts'
import { coreSnapshot } from '../../stores/coreTestFixtures.ts'
import type { CoreLibraryRemovalResult } from '../../../../shared/coreLibraryMaintenance.ts'
import type { Track, TrackArtistRef } from '../../types/music.ts'
import type {
  MediaProviderAlbumSummary,
  MediaProviderArtistSummary
} from '../../providers/mediaProvider.ts'
import { appendUniqueTracks } from './streamingPageModel.ts'
import { createCoreCollectionSearch } from './coreCollectionSearch.ts'
import { createNcmPlaylistEditor } from './ncmPlaylistEditor.ts'
import { getTrackSource } from '../../utils/logicalTrackModel.ts'
import {
  findStreamingArtistById,
  matchStreamingArtistsByName
} from '../../utils/streamingArtistResolution.ts'

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('../StreamingHome.vue', import.meta.url), 'utf8')
const discoverySource = readFileSync(new URL('../StreamingDiscovery.vue', import.meta.url), 'utf8')
const providerHomeSource = readFileSync(new URL('./ProviderMusicHome.vue', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('./StreamingContentHeader.vue', import.meta.url), 'utf8')

function createAlbumPlaylistHarness() {
  const owned = source.match(/const ownedUserPlaylists = computed\([\s\S]*?\n\)/)?.[0]
  assert.ok(owned)
  const watcher = source.slice(
    source.indexOf('watch([currentDetail, isLoggedIn]'),
    source.indexOf('async function collectNcmIds(')
  )
  assert.ok(watcher.startsWith('watch('))
  const notices: Array<{ message: string }> = []
  const externalPlaylist = { id: 222, name: 'QQ playlist', owned: true }
  const scope = {
    computed,
    watch,
    currentDetail: ref<{ type: string; providerId: string } | null>(null),
    isLoggedIn: ref(true),
    NCM_PROVIDER_ID: 'ncm',
    libraryLoaded: ref(false),
    libraryLoading: ref(false),
    userPlaylists: ref<Array<{ id: number; name: string; owned: boolean }>>([]),
    userPlaylistEntries: ref([externalPlaylist]),
    fetchUserLibrary: async () => {},
    pushNotice: (notice: { message: string }) => notices.push(notice),
    friendlyStreamingError: (error: Error, fallback: string) => `${fallback}：${error.message}`
  }
  const runtime = runInNewContext(
    `${stripTypeScriptTypes(owned)}\nconst stop = ${stripTypeScriptTypes(watcher)}\n;({ ownedUserPlaylists, stop })`,
    scope
  ) as {
    ownedUserPlaylists: { value: Array<{ id: number; name: string; owned: boolean }> }
    stop: () => void
  }
  return { scope, notices, runtime, externalPlaylist }
}

test('NetEase album playlist writes use the NetEase account library while browsing another source', async (t) => {
  const h = createAlbumPlaylistHarness()
  t.after(h.runtime.stop)
  const ncmPlaylist = { id: 111, name: 'NCM playlist', owned: true }
  const calls: number[] = []
  h.scope.fetchUserLibrary = async () => {
    calls.push(1)
    h.scope.userPlaylists.value = [ncmPlaylist, { id: 333, name: 'Subscribed', owned: false }]
    h.scope.libraryLoaded.value = true
  }
  assert.equal(h.runtime.ownedUserPlaylists.value.length, 0)
  h.scope.currentDetail.value = { type: 'album', providerId: 'ncm' }
  await nextTick()
  assert.equal(calls.length, 1)
  assert.deepEqual(h.runtime.ownedUserPlaylists.value, [ncmPlaylist])
  const writes: Array<[number | string, number[]]> = []
  const editor = createNcmPlaylistEditor({
    canManage: () => true,
    captureContext: () => () => true,
    create: async () => ({ id: 999 }),
    add: async (id, ids) => {
      writes.push([id, ids])
    },
    describeError: (error) => String(error)
  })
  t.after(editor.dispose)
  assert.equal(editor.openAdd([{ ...createTrack('ncm:123', 'ncm'), ncmSongId: 123 }]), true)
  await editor.confirmAdd(h.runtime.ownedUserPlaylists.value[0].id)
  assert.deepEqual(writes, [[111, [123]]])
  assert.notEqual(writes[0][0], h.externalPlaylist.id)
})

test('anonymous and local albums do not fetch the NetEase account library or surface obsolete failures', async (t) => {
  const h = createAlbumPlaylistHarness()
  t.after(h.runtime.stop)
  let calls = 0
  let rejectLibrary!: (error: Error) => void
  h.scope.fetchUserLibrary = async () => {
    calls++
    return new Promise<void>((_resolve, reject) => {
      rejectLibrary = reject
    })
  }
  h.scope.isLoggedIn.value = false
  h.scope.currentDetail.value = { type: 'album', providerId: 'ncm' }
  await nextTick()
  h.scope.currentDetail.value = { type: 'album', providerId: 'local' }
  h.scope.isLoggedIn.value = true
  await nextTick()
  assert.equal(calls, 0)
  h.scope.currentDetail.value = { type: 'album', providerId: 'ncm' }
  await nextTick()
  assert.equal(calls, 1)
  h.scope.currentDetail.value = { type: 'album', providerId: 'local' }
  rejectLibrary(new Error('late account failure'))
  await nextTick()
  assert.deepEqual(h.notices, [])
})

test('album search detail opens the result source, retries in place and ignores stale detail loads', async () => {
  const code = source.match(
    /async function openSearchAlbum[\s\S]*?(?=\nasync function openArtist)/
  )?.[0]
  assert.ok(code)
  assert.match(source, /@open-album="openSearchAlbum"/)
  const stack: Array<{ providerId: string }> = []
  const local = [createTrack('local:1', 'local')]
  let finishRemote!: (tracks: Track[]) => void
  let token = 0
  const calls: Array<{ providerId: string; id: string }> = []
  const scope = {
    detailNavigationToken: 0,
    activeProvider: { value: 'another-provider' },
    beginDetailTransition: () => {},
    pushDetail: (view: { providerId: string }) => stack.push(view),
    replaceTopDetail: (view: { providerId: string }) => {
      stack[stack.length - 1] = view
    },
    beginDetailLoad: () => {
      scope.detailLoading.value = true
      return ++token
    },
    isActiveDetailLoad: (request: number) => request === token,
    albumSearch: {
      loadAlbumTracks: async (album: { providerId: string; id: string }) => {
        calls.push(album)
        if (album.providerId === 'qq') return local
        return new Promise<Track[]>((resolve) => {
          finishRemote = resolve
        })
      }
    },
    detailBrowse: {
      open: async (source: { providerId: string; args: string[] }) => {
        const request = token
        const tracks = await scope.albumSearch.loadAlbumTracks({ providerId: source.providerId, id: source.args[0] })
        if (request === token) scope.detailTracks.value = tracks
      }
    },
    detailTracks: { value: [] as Track[] },
    detailLoading: { value: false },
    detailError: { value: '' },
    friendlyStreamingError: (error: Error) => error.message
  }
  const handlers = runInNewContext(
    `${stripTypeScriptTypes(code)}\n({openSearchAlbum, openAlbum})`,
    scope
  )
  const album = {
    id: '1',
    name: 'Album',
    trackCount: 1,
    cover: null,
    providerName: 'Local',
    providerId: 'qq'
  }
  const remote = handlers.openSearchAlbum({ ...album, providerId: 'ncm' })
  await handlers.openSearchAlbum(album)
  finishRemote([createTrack('ncm:1', 'ncm')])
  await remote
  assert.equal(scope.detailTracks.value, local)
  assert.equal(scope.activeProvider.value, 'another-provider')
  assert.equal(scope.detailLoading.value, false)
  assert.equal(scope.detailError.value, '')
  assert.equal(stack.at(-1)?.providerId, 'qq')
  const depth = stack.length
  await handlers.openAlbum(album, 'qq', true)
  assert.equal(stack.length, depth)
  assert.deepEqual(
    calls.map((call) => call.providerId),
    ['ncm', 'qq', 'qq']
  )
})
test('album links retain native local release navigation and online source', async () => {
  const code = source.match(
    /async function openTrackAlbum[\s\S]*?(?=\nfunction openTrackArtist)/
  )?.[0]
  assert.ok(code)
  const track = createTrack('local:1', 'local')
  const opened: Array<{ providerId: string; id: string | number }> = []
  const localViews: unknown[][] = []
  const handler = runInNewContext(`${stripTypeScriptTypes(code)}\nopenTrackAlbum`, {
    detailNavigationToken: 0,
    getTrackSource,
    canOpenTrackAlbum: () => true,
    selectDetailProvider: async () => undefined,
    isCurrentDetailNavigation: () => true,
    emit: (...args: unknown[]) => localViews.push(args),
    localSearchSource: { resolveAlbum: async () => ({ albumId: 'release:1', mode: 'sqlite' }) },
    friendlyStreamingError: (error: Error) => error.message,
    openAlbum: async (album: { id: string | number }, providerId: string) =>
      opened.push({ providerId, id: album.id }),
    pushNotice: () => assert.fail('the local library supplies the album identity')
  })
  await handler(track)
  await handler({ ...createTrack('ncm:1', 'ncm'), albumId: '1' })
  assert.deepEqual(localViews, [['selectView', 'albums', 'album:release:1']])
  assert.deepEqual(opened, [{ providerId: 'ncm', id: '1' }])
})

const providerSwitcherSource = readFileSync(
  new URL('./StreamingProviderSwitcher.vue', import.meta.url),
  'utf8'
)
const { executeStreamingBatchRemoval, removeStreamingProviderFavorite } = (await import(
  new URL('./streamingBatchRemoval.ts', import.meta.url).href
)) as typeof import('./streamingBatchRemoval.ts')
const { MediaProviderRegistry } = (await import(
  new URL('../../providers/mediaProvider.ts', import.meta.url).href
)) as typeof import('../../providers/mediaProvider.ts')

test('streaming page renders NetEase cloud as a dedicated sidebar surface', () => {
  assert.match(source, /import NcmCloudPanel from '\.\/NcmCloudPanel\.vue'/)
  assert.match(source, /activeTab === 'cloud'/)
  assert.match(source, /<NcmCloudPanel[\s\S]*@download="startCloudDownload"/)
  assert.match(source, /activeTab\.value === 'cloud'/)
  assert.doesNotMatch(source, /<StreamingLibrary[\s\S]*:show-ncm-cloud=/)
})

test('streaming page exposes unified song search beyond the NetEase-only surface', () => {
  assert.match(source, /useMediaProviders\(\)/)
  assert.match(source, /mediaProviders\.searchAllSongs\(\{/)
  assert.doesNotMatch(source, /localTracks:|musicStore\.tracks|createUnifiedRecentTrackResolver/)
  assert.match(source, /createCoreCollectionSearch/ )
  assert.match(source, /searchUnifiedSongs/)
  assert.match(source, /const showUnifiedSearch = computed/)
  assert.doesNotMatch(source, /const showNcmSearch = computed/)
})

test('streaming detail, social, and HiFi surfaces compile working dark-theme selectors', () => {
  const detailStyles = readFileSync(new URL('./StreamingDetailStage.css', import.meta.url), 'utf8')
  const socialStyles = readFileSync(new URL('./StreamingSocialStage.css', import.meta.url), 'utf8')
  const hifiSource = readFileSync(new URL('../player-bar/HiFiSidebar.css', import.meta.url), 'utf8')

  const detailCode = compileStyle({
    source: detailStyles,
    filename: 'StreamingDetailStage.css',
    id: 'data-v-streaming-detail-dark',
    scoped: true
  }).code
  const socialCode = compileStyle({
    source: socialStyles,
    filename: 'StreamingSocialStage.css',
    id: 'data-v-streaming-social-dark',
    scoped: true
  }).code
  const hifiCode = compileStyle({
    source: hifiSource,
    filename: 'HiFiSidebar.css',
    id: 'data-v-hifi-dark',
    scoped: true
  }).code

  assert.match(
    detailCode,
    /html\[data-theme=['"]dark['"]\] \.detail-stage\[[^\]]+\]\s*\{[^}]*--stage-paper-raised:\s*#1c1917/
  )
  assert.match(
    socialCode,
    /html\[data-theme=['"]dark['"]\] \.social-stage \.stage-person-card\[[^\]]+\]:hover/
  )
  assert.match(hifiCode, /html\[data-theme=['"]dark['"]\] \.deck\[[^\]]+\]\s*\{[^}]*--d-card:/)
  assert.match(hifiCode, /html\[data-theme=['"]dark['"]\] \.deck \.deck-display\[[^\]]+\]/)
  assert.doesNotMatch(
    [detailCode, socialCode, hifiCode].join('\n'),
    /html\[data-theme=['"]dark['"]\]\s*\{[^}]*(?:--stage-paper-raised|--d-card):/
  )
})

test('streaming page resolves player-bar artist requests through the track provider', () => {
  assert.match(source, /metadataNavigationRequest\?: StreamingMetadataNavigationRequest \| null/)
  assert.match(source, /mediaProviders\.searchArtists\(providerId, artistName, 8, 0\)/)
  assert.match(source, /provider\.fetchArtistTopSongs\(artist\.id\)/)
  assert.match(
    source,
    /if \(isExternalActive\.value\)[\s\S]*provider\.fetchArtistTopSongs\(artist\.id\)/
  )
  assert.doesNotMatch(
    source,
    /if \(provider === NCM_PROVIDER_ID\) \{\s*fallbackProvider\.value = null/
  )
})

test('same-named artists are separated by provider artist id, never by search order', () => {
  // 带歌手 id 时选人只认 id，搜索结果仅用于补 picUrl 等展示字段。
  assert.match(source, /findStreamingArtistById\(request\.artistId, searchResult\.items\)/)
  assert.match(source, /openArtist\(\s*matched \?\? \{ id: request\.artistId/)
  // 没有 id 才回退名字匹配，且要先拿到全部同名候选，由页面自己消歧并告知用户。
  assert.match(source, /matchStreamingArtistsByName\(artistName, searchResult\?\.items \?\? \[\]\)/)
  assert.match(source, /candidates\.length > 1/)
  // 绝不能退回“搜索结果里第一个同名者即命中”——那正是同名歌手跳错页的成因。
  assert.doesNotMatch(source, /findBestStreamingArtistMatch\(artistName, result\.items\)/)
})

function createTrackMetadataNavigationHarness() {
  const track: Track = {
    ...createTrack('ncm:123', 'ncm'),
    artist: 'First Artist / Shared Name',
    artists: [
      { id: 11, name: 'First Artist' },
      { id: 22, name: 'Shared Name' }
    ],
    albumId: '456'
  }
  const searchResults = ref([track])
  const searchQuery = ref('test song')
  const searchType = ref('songs')
  const searchSource = ref('all')
  const searchOffset = ref(60)
  const detailStack = ref<Array<{ view: { type: string } }>>([])
  const openedArtists: MediaProviderArtistSummary[] = []
  const openedAlbums: MediaProviderAlbumSummary[] = []
  const localViews: unknown[][] = []
  const providerSelections: Array<[string, boolean]> = []
  const methods = ['fetchArtistTopSongs', 'searchArtists', 'fetchAlbumTracks']
  const scope = {
    getTrackSource,
    restoringPage: false,
    core: { command: async () => undefined, query: async () => [] },
    browseContexts: Promise.resolve([]),
    captureBrowseContexts: async () => [],
    browseState: ref({ session: null }),
    detailBrowse: { reset() {} },
    recommendationSessions: ref({}),
    retainDetailState: () => ({}),
    releaseDetailEntry() {},
    findStreamingArtistById,
    matchStreamingArtistsByName,
    nextTick,
    watch,
    activeProvider: ref('other'),
    activeTab: ref('search'),
    props: reactive({ active: true }),
    NCM_PROVIDER_ID: 'ncm',
    providerStore: {
      providers: ref([]),
      syncProviders: async (): Promise<void> => undefined,
      getProvider: (id: string) => ({ supportedMethods: id === 'ncm' ? methods : [] })
    },
    mediaProviders: {
      get: () => ({ name: 'NetEase', fetchArtistTopSongs() {}, searchArtists() {} }),
      searchArtists: async () => ({
        items: [
          { id: 99, name: 'Shared Name', picUrl: null },
          { id: 22, name: 'Shared Name', picUrl: 'artist-cover' }
        ]
      })
    },
    localSearchSource: { resolveAlbum: async () => ({ albumId: 'local-release', mode: 'sqlite' }) },
    selectProvider: (id: string, persist = true) => {
      providerSelections.push([id, persist])
      scope.activeProvider.value = id
    },
    emit: (...args: unknown[]) => localViews.push(args),
    pushNotice: (notice: unknown) => {
      throw new Error(JSON.stringify(notice))
    },
    friendlyStreamingError: (error: Error) => error.message,
    openArtist: async (artist: MediaProviderArtistSummary) => {
      openedArtists.push(artist)
      runtime.pushDetail({ type: 'artist' })
    },
    openAlbum: async (album: MediaProviderAlbumSummary) => {
      openedAlbums.push(album)
      runtime.pushDetail({ type: 'album' })
    },
    detailStack,
    detailLoadToken: 0,
    playbackNavigationSyncToken: null,
    streamingTransitionName: ref(''),
    streamingContentRef: ref(null),
    applyDetailState() {},
    captureDetailState: () => ({}),
    clearDetailState() {},
    currentDetail: computed(() => detailStack.value.at(-1)?.view ?? null),
    searchQuery,
    searchType,
    searchSource,
    clearSearch: () => {
      searchQuery.value = ''
      searchOffset.value = 0
      searchResults.value = []
    },
    recommendationRequestId: 0,
    recommendationProviderId: ref(''),
    homeSectionDefinitions: ref([]),
    recommendationTracks: ref({}),
    recommendationErrors: ref({}),
    recsError: ref(''),
    recsLoading: ref(false),
    recommendPlaylists: ref([]),
    activeProviderRequiresLogin: ref(false)
  }
  const handlers = source.slice(
    source.indexOf('function canOpenTrackArtist('),
    source.indexOf('async function openAlbum(')
  )
  const artistResolution = source.slice(
    source.indexOf('async function openRequestedArtist('),
    source.indexOf('async function openUserList(')
  )
  const push = source.slice(
    source.indexOf('function pushDetail('),
    source.indexOf('function replaceTopDetail(')
  )
  const reset = source.slice(
    source.indexOf('function resetDetail('),
    source.indexOf('function resetLikedTracksPaging(')
  )
  const back = source.slice(
    source.indexOf('async function popDetail('),
    source.indexOf('async function removeDetailEntries(')
  )
  const providerWatcher = source.slice(
    source.indexOf('watch(activeProvider,'),
    source.indexOf('watch(activeTab,')
  )
  const navigationWatcher = source.slice(
    source.indexOf('watch([searchQuery, searchType, searchSource,'),
    source.indexOf('watch(isSearching,')
  )
  const runtime = runInNewContext(
    stripTypeScriptTypes(
      `let detailNavigationToken = 0\n${handlers}\n${artistResolution}\n${push}\n${back}\n${reset}\nconst stopProvider = ${providerWatcher}\nconst stopNavigation = ${navigationWatcher}\nconst stop = () => { stopProvider(); stopNavigation() }\n;({ canOpenTrackArtist, canOpenTrackAlbum, openTrackArtist, openTrackAlbum, pushDetail, popDetail, resetDetail, stop })`
    ),
    scope
  ) as {
    canOpenTrackArtist: (track: Track, artist?: TrackArtistRef) => boolean
    canOpenTrackAlbum: (track: Track) => boolean
    openTrackArtist: (track: Track, artist?: TrackArtistRef) => void
    openTrackAlbum: (track: Track) => Promise<void>
    pushDetail: (view: { type: string }) => void
    popDetail: () => void
    resetDetail: () => void
    stop: () => void
  }
  return {
    track,
    searchQuery,
    searchOffset,
    searchResults,
    detailStack,
    openedArtists,
    openedAlbums,
    localViews,
    providerSelections,
    scope,
    runtime
  }
}

for (const kind of ['artist', 'album'] as const) {
  test(`song search opens the result's ${kind} provider and returns to the same search page`, async (t) => {
    const h = createTrackMetadataNavigationHarness()
    t.after(h.runtime.stop)
    const results = h.searchResults.value
    if (kind === 'artist') {
      h.runtime.openTrackArtist(h.track, h.track.artists![1])
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(
        h.openedArtists[0]?.id,
        22,
        'the selected guest must win over the first same-named search result'
      )
      assert.equal(h.openedArtists[0]?.picUrl, 'artist-cover')
    } else {
      await h.runtime.openTrackAlbum(h.track)
      assert.equal(h.openedAlbums[0]?.id, '456')
      assert.equal(h.openedAlbums[0]?.name, h.track.album)
    }
    assert.equal(h.scope.activeProvider.value, 'ncm')
    assert.deepEqual(h.providerSelections, [['ncm', false]])
    assert.equal(h.detailStack.value.at(-1)?.view.type, kind)
    h.runtime.popDetail()
    assert.equal(h.detailStack.value.length, 0)
    assert.equal(h.searchQuery.value, 'test song')
    assert.equal(h.searchOffset.value, 60)
    assert.equal(h.searchResults.value, results)

    h.scope.selectProvider('other')
    await nextTick()
    assert.equal(h.searchQuery.value, '', 'an explicit provider change must still reset search')
  })
}

test('metadata navigation uses local library identities and exposes only supported online links', async (t) => {
  const h = createTrackMetadataNavigationHarness()
  t.after(h.runtime.stop)
  assert.equal(h.runtime.canOpenTrackArtist(h.track), true)
  assert.equal(h.runtime.canOpenTrackAlbum(h.track), true)
  assert.equal(h.runtime.canOpenTrackAlbum({ ...h.track, albumId: undefined }), false)
  assert.equal(h.runtime.canOpenTrackArtist({ ...h.track, source: 'unsupported' }), false)
  assert.equal(h.runtime.canOpenTrackAlbum({ ...h.track, source: 'unsupported' }), false)

  const local = { ...createTrack('local-file', 'local'), albumId: undefined }
  assert.equal(h.runtime.canOpenTrackArtist(local), true)
  assert.equal(h.runtime.canOpenTrackAlbum(local), true)
  h.runtime.openTrackArtist(local)
  await h.runtime.openTrackAlbum(local)
  assert.deepEqual(h.localViews, [
    ['selectView', 'artists', 'artist:Test Artist'],
    ['selectView', 'albums', 'album:local-release']
  ])
  assert.equal(h.providerSelections.length, 0)
})

async function holdArtistNavigation(
  h: ReturnType<typeof createTrackMetadataNavigationHarness>,
  phase: 'providers' | 'search'
): Promise<() => Promise<void>> {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  if (phase === 'providers') h.scope.providerStore.syncProviders = () => pending
  else {
    const searchArtists = h.scope.mediaProviders.searchArtists
    h.scope.mediaProviders.searchArtists = async () => {
      await pending
      return searchArtists()
    }
  }
  h.runtime.openTrackArtist(h.track, h.track.artists![1])
  await new Promise<void>((resolve) => setImmediate(resolve))
  return async () => {
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

for (const phase of ['providers', 'search'] as const) {
  for (const providerId of ['ncm', 'other']) {
    test(`album navigation supersedes artist navigation pending ${phase} on ${providerId}`, async (t) => {
      const h = createTrackMetadataNavigationHarness()
      t.after(h.runtime.stop)
      h.scope.providerStore.getProvider = () => ({
        supportedMethods: ['fetchArtistTopSongs', 'searchArtists', 'fetchAlbumTracks']
      })
      const release = await holdArtistNavigation(h, phase)
      await h.runtime.openTrackAlbum({ ...h.track, source: providerId, albumId: 'new-album' })
      await release()
      assert.equal(h.openedArtists.length, 0, 'the obsolete artist must never open or fetch tracks')
      assert.equal(h.openedAlbums[0]?.id, 'new-album')
      assert.equal(h.scope.activeProvider.value, providerId)
      assert.equal(h.detailStack.value.at(-1)?.view.type, 'album')
    })
  }

  for (const kind of ['artist', 'album'] as const) {
    test(`local ${kind} navigation supersedes artist navigation pending ${phase}`, async (t) => {
      const h = createTrackMetadataNavigationHarness()
      t.after(h.runtime.stop)
      const local = createTrack('local-file', 'local')
          const release = await holdArtistNavigation(h, phase)
      if (kind === 'artist') h.runtime.openTrackArtist(local)
      else await h.runtime.openTrackAlbum(local)
      await release()
      assert.equal(h.openedArtists.length, 0)
      assert.equal(h.localViews[0]?.[0], 'selectView')
      assert.equal(h.localViews[0]?.[1], kind === 'artist' ? 'artists' : 'albums')
    })
  }
}

for (const destination of ['back', 'root', 'playlist', 'query', 'source', 'hidden'] as const) {
  test(`leaving an artist lookup for ${destination} ignores its late response`, async (t) => {
    const h = createTrackMetadataNavigationHarness()
    t.after(h.runtime.stop)
    const release = await holdArtistNavigation(h, 'search')
    switch (destination) {
      case 'back':
        h.runtime.popDetail()
        break
      case 'root':
        h.runtime.resetDetail()
        break
      case 'playlist':
        h.runtime.pushDetail({ type: 'playlist' })
        break
      case 'query':
        h.scope.clearSearch()
        break
      case 'source':
        h.scope.searchSource.value = 'local'
        break
      case 'hidden':
        h.scope.props.active = false
        break
    }
    await nextTick()
    await release()
    assert.equal(h.openedArtists.length, 0)
    assert.equal(
      h.detailStack.value.at(-1)?.view.type,
      destination === 'playlist' ? 'playlist' : undefined
    )
  })
}

for (const phase of ['providers', 'search'] as const) {
  test(`a newer artist request wins over an older lookup pending ${phase}`, async (t) => {
    const h = createTrackMetadataNavigationHarness()
    t.after(h.runtime.stop)
    const syncProviders = h.scope.providerStore.syncProviders
    const searchArtists = h.scope.mediaProviders.searchArtists
    const release = await holdArtistNavigation(h, phase)
    h.scope.providerStore.syncProviders = syncProviders
    h.scope.mediaProviders.searchArtists = searchArtists
    h.runtime.openTrackArtist(h.track, h.track.artists![0])
    await new Promise<void>((resolve) => setImmediate(resolve))
    await release()
    assert.deepEqual(
      h.openedArtists.map((artist) => artist.id),
      [11]
    )
    assert.equal(h.scope.activeProvider.value, 'ncm')
  })
}

test('streaming page keeps third-party providers on the generic provider library surface', () => {
  assert.doesNotMatch(source, /import BilibiliPage/)
  assert.doesNotMatch(source, /<BilibiliPage/)
  assert.doesNotMatch(source, /showBilibiliView/)
  assert.doesNotMatch(source, /shouldShowBilibiliViewForSidebarProvider/)
  assert.match(source, /:show-track-likes="showBilibiliTrackLikes"/)
  assert.doesNotMatch(source, /bilibili\.setPinnedFavoriteFolder/)
})

test('platform history is delegated to the independent recent page', () => {
  assert.match(source, /emit\('recent', activeProvider\.value\)/)
  assert.doesNotMatch(source, /getRecentTracks\(\)/)
})

test('ranking detail uses cross-source listening stats before provider play records', () => {
  assert.match(source, /getTopTracks\(\)/)
  assert.match(source, /stat\.displayTrack/)
  assert.doesNotMatch(source, /resolveUnifiedRecentTracks|musicStore\.tracks/)
  assert.doesNotMatch(source, /const tracks = await fetchPlayRecords\(1\)/)
})

test('provider likes never fall back to application favorites', () => {
  assert.match(source, /method: 'fetchLikedTracksPage',\s*args: \[0, 200, force\]/)
  assert.doesNotMatch(source, /unifiedFavoriteTracks|summarizeUnifiedFavoriteTracks/)
  assert.match(source, /Boolean\(activeExternalState\.value\?\.likedPlaylist\)/)
})

test('liked playback submits the complete provider session while preserving heart mode', () => {
  assert.match(source, /async function playBrowseTracks/)
  assert.match(source, /playbackStore\.playLikedTracks/)
  assert.match(source, /playbackStore\.playTrackPages/)
  assert.match(source, /detailBrowse\.produce/)
  assert.match(source, /async function playAllDetailTracks/)
})

function createLikedPlaybackHarness(t: test.TestContext) {
  const tracks = Array.from({ length: 2100 }, (_, index) => ({
    ...createTrack(`ncm:${index + 1}`, 'ncm'),
    ncmSongId: index + 1
  }))
  let release!: (tracks: Track[]) => void
  let reject!: (error: Error) => void
  const loading = new Promise<Track[]>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  const commands: Array<{ name: string; payload: any }> = []
  const core = {
    state: shallowRef(coreSnapshot()),
    query: async () => ({ items: [] }),
    command: async (name: string, payload: unknown) => {
      commands.push({ name, payload })
    }
  } as unknown as CorePlayerClient
  const effect = effectScope()
  const playbackStore = effect.run(() => createCorePlayerQueue(core, (error) => assert.fail(String(error))))!
  t.after(() => {
    release(tracks)
    effect.stop()
  })
  const detailTracks = shallowRef<Track[]>(tracks.slice(0, 100))
  let fullReads = 0
  const scope = {
    currentDetail: ref<{ type: string } | null>({ type: 'liked' }),
    isExternalActive: ref(false),
    libraryFavoritePlaylist: ref({ id: 123 }),
    detailTracks,
    browseState: ref({ offset: 0 }),
    detailBrowse: {
      load: async () => {
        detailTracks.value = (await loading).slice(0, 800)
      }
    },
    visibleDetailTracks: computed(() => detailTracks.value),
    streamingListTracks: computed(() => detailTracks.value),
    streamingContextMenuTrack: ref(tracks[0]),
    likedTracksHasMore: ref(true),
    likedTracksLoadingMore: ref(false),
    likedTracksLoadMoreError: ref(''),
    likedCount: ref(2100),
    likedTracksTotal: ref(2100),
    likedTracksNextOffset: ref(100),
    detailLoadToken: 1,
    isActiveDetailLoad: (token: number) => token === 1,
    fetchLikedTracks: () => {
      fullReads++
      return loading
    },
    fetchLikedTracksPage: async () => ({
      tracks: (await loading).slice(100),
      total: tracks.length,
      nextOffset: tracks.length,
      hasMore: false
    }),
    LIKED_TRACKS_PAGE_SIZE: 100,
    streamingContentRef: ref(null),
    nextTick,
    syncLikedIds() {},
    closeStreamingContextMenu() {},
    friendlyStreamingError: String,
    shuffleArray: (items: Track[]) => [...items].reverse(),
    playTrack: playbackStore.playTrack,
    playbackStore,
    openLikedTracks: async () => {
      await loading
      scope.currentDetail.value = { type: 'liked' }
    }
  }
  const contextStart = source.search(/(?:async )?function handleContextPlayTrack\(/)
  const handlers = runInNewContext(
    stripTypeScriptTypes(
      source.slice(
        source.indexOf('function playStreamingTrack('),
        source.indexOf('function isDetailRowLiking(')
      ) +
        source.slice(contextStart, source.indexOf('function handleContextPlayNext(')) +
        source.slice(
          source.indexOf('async function loadMoreLikedTracks('),
          source.indexOf('async function openPlaylist(')
        ) +
        source.slice(
          source.indexOf('async function playLikedSongs('),
          source.indexOf('async function retryCurrentView(')
        )
    ) +
      '\n({ playTrackFromCurrentDetail, playAllDetailTracks, shufflePlayDetailTracks, handleContextPlayTrack, playLikedSongs, loadAllLikedTracks, loadMoreLikedTracks })',
    scope
  ) as {
    playTrackFromCurrentDetail(track: Track): void | Promise<void>
    playAllDetailTracks(): void | Promise<void>
    shufflePlayDetailTracks(): void | Promise<void>
    handleContextPlayTrack(): void | Promise<void>
    playLikedSongs(): Promise<void>
    loadAllLikedTracks(): Promise<void>
    loadMoreLikedTracks(): Promise<void>
  }
  return {
    tracks,
    scope,
    commands,
    handlers,
    release: () => release(tracks),
    reject,
    fullReads: () => fullReads
  }
}

test('a delayed full liked-list read cannot replay an older click over the newer song (issue 213)', async (t) => {
  const h = createLikedPlaybackHarness(t)
  const first = h.handlers.playTrackFromCurrentDetail(h.tracks[0])
  await h.handlers.playTrackFromCurrentDetail(h.tracks[1])
  h.release()
  await first
  assert.deepEqual(
    h.commands.map(({ payload }) => payload.selectedId),
    ['ncm:1', 'ncm:2']
  )
  assert.equal(
    h.fullReads(),
    0,
    'Core owns the complete liked queue; display reads must not defer Play'
  )
})

for (const action of [
  'playTrackFromCurrentDetail',
  'playAllDetailTracks',
  'shufflePlayDetailTracks',
  'handleContextPlayTrack'
] as const) {
  test(`${action} submits liked playback immediately while display paging is in flight`, async (t) => {
    const h = createLikedPlaybackHarness(t)
    h.scope.likedTracksLoadingMore.value = true
    await h.handlers[action](h.tracks[0])
    assert.equal(h.commands.length, 1)
    assert.equal(h.commands[0].name, 'liked.play')
    if (action === 'shufflePlayDetailTracks') {
      assert.equal(
        h.commands[0].payload.shuffle,
        true,
        'shuffle must include the complete Core queue'
      )
      assert.equal(h.commands[0].payload.selectedId, undefined)
    } else assert.equal(h.commands[0].payload.selectedId, 'ncm:1')
    h.scope.detailTracks.value = h.tracks
    h.scope.likedTracksHasMore.value = false
    h.scope.likedTracksLoadingMore.value = false
    await nextTick()
    assert.equal(h.commands.length, 1, 'finishing display paging must not submit another queue')
    assert.equal(h.fullReads(), 0)
  })
}

for (const action of ['loadAllLikedTracks', 'loadMoreLikedTracks'] as const) {
  test(`${action} completion updates the display without replacing active playback`, async (t) => {
    const h = createLikedPlaybackHarness(t)
    const loading = h.handlers[action]()
    await h.handlers.playTrackFromCurrentDetail(h.tracks[1])
    h.release()
    await loading
    assert.equal(h.scope.detailTracks.value.length, action === 'loadAllLikedTracks' ? 800 : 2100)
    if (action === 'loadMoreLikedTracks') assert.equal(h.scope.likedTracksHasMore.value, false)
    assert.equal(h.commands.length, 1)
    assert.equal(h.commands[0].name, 'liked.play')
    assert.equal(h.commands[0].payload.selectedId, 'ncm:2')
  })
}

test('the liked library card submits its intent before opening the display, without a late replay', async (t) => {
  const h = createLikedPlaybackHarness(t)
  h.scope.currentDetail.value = null
  const playing = h.handlers.playLikedSongs()
  assert.equal(h.commands.length, 1)
  assert.equal(h.commands[0].name, 'liked.play')
  assert.equal(h.commands[0].payload.selectedId, undefined)
  h.scope.currentDetail.value = { type: 'liked' }
  await h.handlers.playTrackFromCurrentDetail(h.tracks[1])
  h.release()
  await playing
  assert.deepEqual(
    h.commands.map(({ payload }) => payload.selectedId),
    [undefined, 'ncm:2']
  )
})

test('a rate-limited full display read cannot replay playback from its partial fallback', async (t) => {
  const h = createLikedPlaybackHarness(t)
  const loading = h.handlers.loadAllLikedTracks()
  await h.handlers.playTrackFromCurrentDetail(h.tracks[1])
  h.reject(new Error('NCM -460 rate limited'))
  await loading
  assert.match(h.scope.likedTracksLoadMoreError.value, /-460/)
  assert.equal(h.scope.likedTracksHasMore.value, true)
  assert.equal(h.scope.likedTracksLoadingMore.value, false)
  assert.deepEqual(
    h.commands.map(({ payload }) => payload.selectedId),
    ['ncm:2']
  )
})

test('loading the liked display keeps a bounded window independent of playback', () => {
  assert.match(source, /async function loadAllLikedTracks\(\): Promise<void>/)
  assert.match(source, /@load-all-liked="loadAllLikedTracks"/)
  assert.match(source, /await detailBrowse\.load\(browseState\.value\.offset\)/)
  assert.doesNotMatch(source, /const tracks = await fetchLikedTracks\(\)/)
  assert.doesNotMatch(source, /resolveDetailPlaybackQueue/)
})

test('external favorite card opens and plays the selected folder instead of the provider default', async () => {
  const selected = { id: '102', name: '音乐收藏', cover: null, trackCount: 2 }
  const tracks = [createTrack('bili:one', 'bili'), createTrack('bili:two', 'bili')]
  const opened: unknown[] = []
  const played: Track[][] = []
  const scope = {
    isExternalActive: { value: true },
    activeExternalState: { value: { likedPlaylist: { id: '101' } } },
    libraryFavoritePlaylist: { value: selected },
    currentDetail: { value: null as { type: string; playlist: typeof selected } | null },
    openPlaylist: async (playlist: typeof selected, force: boolean) => {
      opened.push([playlist.id, force])
      scope.currentDetail.value = { type: 'playlist', playlist }
    },
    visibleDetailTracks: { value: tracks },
    playBrowseTracks: async () => {
      assert.equal(scope.currentDetail.value?.playlist.id, selected.id)
      played.push(tracks)
    }
  }
  const openSource = source.slice(
    source.indexOf('async function openLikedTracks('),
    source.indexOf('async function loadMoreLikedTracks(')
  )
  const playSource = source.slice(
    source.indexOf('async function playLikedSongs('),
    source.indexOf('async function retryCurrentView(')
  )
  const handlers = runInNewContext(
    `${stripTypeScriptTypes(openSource + playSource)}\n({openLikedTracks, playLikedSongs})`,
    scope
  ) as { openLikedTracks: (force?: boolean) => Promise<void>; playLikedSongs: () => Promise<void> }
  await handlers.openLikedTracks(true)
  assert.deepEqual(opened, [['102', true]])
  scope.currentDetail.value = null
  await handlers.playLikedSongs()
  assert.deepEqual(opened, [
    ['102', true],
    ['102', false]
  ])
  assert.equal(played[0], tracks)
  await handlers.playLikedSongs()
  assert.equal(opened.length, 2, 'the selected folder already being viewed should not be reloaded')
  assert.equal(played[1], tracks)
})

test('recommendations load declared provider sections and fence stale source results', () => {
  assert.match(source, /provider\?\.ui\?\.streamingSections/)
  assert.match(source, /supportedMethods\.has\(section\.method\)/)
  assert.match(source, /Promise\.allSettled\(/)
  assert.match(source, /providerStore\.callProvider<Track\[]>\(providerId, section\.method/)
  assert.match(
    source,
    /requestId !== recommendationRequestId \|\| providerId !== activeProvider\.value/
  )
  assert.match(source, /const options =\s*activeTab\.value === 'home'/)
  assert.match(source, /selectProvider\(options\[0\]\.id, false\)/)
})

test('logged-out home and library retain source options independently of search visibility', () => {
  const definition = source.match(
    /const headerProviderOptions = computed\(\(\) => \{([\s\S]*?)\n}\)/
  )
  assert.ok(definition)
  const context = {
    currentDetail: { value: null },
    isSearching: { value: false },
    activeTab: { value: 'home' },
    activeLoggedIn: { value: false },
    homeProviderOptions: { value: [{ id: 'home' }] },
    discoveryProviderOptions: { value: [{ id: 'discover' }] },
    libraryProviderOptions: { value: [{ id: 'library' }] }
  }
  const read = (): unknown => runInNewContext(`(() => {${definition[1]}})()`, context)
  assert.equal(read(), context.homeProviderOptions.value)
  context.activeTab.value = 'library'
  assert.equal(read(), context.libraryProviderOptions.value)
  context.activeLoggedIn.value = true
  assert.equal(read(), context.libraryProviderOptions.value)
})

test('streaming provider switcher replaces the avatar in the content header', () => {
  assert.doesNotMatch(providerSwitcherSource, /<select/)
  assert.match(providerSwitcherSource, /class="provider-switcher-trigger"/)
  assert.match(providerSwitcherSource, /role="listbox"/)
  assert.match(providerSwitcherSource, /class="provider-switcher-option"/)
  assert.match(providerSwitcherSource, /options\.length < 2/)
  assert.match(providerSwitcherSource, /class="provider-switcher-label"/)
  assert.match(headerSource, /<StreamingProviderSwitcher/)
  assert.match(headerSource, /class="streaming-header-provider-switcher"/)
  assert.match(headerSource, /emit\('select-provider', \$event\)/)
  assert.doesNotMatch(headerSource, /streaming-avatar-btn/)
  assert.doesNotMatch(homeSource, /StreamingProviderSwitcher/)
  assert.doesNotMatch(discoverySource, /StreamingProviderSwitcher/)
  assert.match(source, /const headerProviderOptions = computed\(/)
  assert.match(source, /:provider-options="headerProviderOptions"/)
  assert.match(source, /@select-provider="selectProvider"/)
})

test('external provider home uses the shared home title and time greeting', () => {
  assert.match(
    source,
    /const isExternalHome = computed\([\s\S]*activeTab\.value === 'home'[\s\S]*!isSearching\.value/
  )
  assert.match(source, /if \(isExternalHome\.value\) return '主页'/)
  assert.match(
    source,
    /const headerSubtitle = computed\(\(\) => \{\s*if \(isExternalHome\.value\) return timeGreeting\.value/
  )
})

test('external provider home removes the redundant provider masthead', () => {
  assert.doesNotMatch(providerHomeSource, /class="music-masthead"/)
  assert.doesNotMatch(providerHomeSource, /class="music-refresh"/)
  assert.match(providerHomeSource, /class="music-hero"/)
})

test('private FM and radar start the Core session without renderer queue ownership', () => {
  assert.match(source, /startPersonalizedStream\(streamKey, getTrackSource\(track\), track\.id\)/)
  assert.doesNotMatch(source, /appendPersonalizedStreamTracks|personalizedStreamRemaining|session: PersonalizedStreamSession/)
  assert.match(homeSource, /@click="playPersonalizedStream\(fmSection\)"/)
  assert.match(homeSource, /@click="playPersonalizedStream\(radarSection\)"/)
})

test('streaming destinations unload and restore Core-owned navigation state', () => {
  const appSource = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
  assert.match(appSource, /v-if="showStreamingSurface"/)
  assert.doesNotMatch(appSource, /streamingPageTabs|MAX_RETAINED_STREAMING_TABS/)
  assert.match(source, /saveBrowsePage\(\s*pageCacheKey/)
  assert.match(source, /restoreBrowsePage\(pageCacheKey/)
  assert.match(source, /detailBrowse\.dispose\(\)/)
  assert.doesNotMatch(source, /<ProviderSidebar/)
})

test('streaming page supports multi-select batch favorite and delete on track lists', () => {
  const searchSource = readFileSync(new URL('../StreamingSearch.vue', import.meta.url), 'utf8')
  const detailSource = readFileSync(new URL('./StreamingDetailStage.vue', import.meta.url), 'utf8')
  const menuSource = readFileSync(new URL('./StreamingContextMenu.vue', import.meta.url), 'utf8')

  assert.match(source, /useTrackMultiSelect/)
  assert.match(source, /handleStreamingBatchFavorite/)
  assert.match(source, /handleStreamingBatchDelete/)
  assert.match(source, /handleStreamingBatchAddToPlaylist/)
  assert.match(source, /createNcmPlaylist/)
  assert.match(source, /removeNcmTracksFromPlaylist/)
  assert.match(source, /onStreamingTrackContextMenu/)
  assert.match(source, /<StreamingContextMenu/)
  assert.match(menuSource, /添加到歌单/)
  assert.match(source, /onSearchTrackClickWithSelect/)
  const detailClickHandler = source.match(
    /function onTrackClick\([\s\S]*?\r?\n}\r?\n\r?\nfunction playDetailTrack/
  )
  const searchClickHandler = source.match(
    /function onSearchTrackClickWithSelect\([\s\S]*?\r?\n}\r?\n\r?\nasync function favoriteStreamingTracks/
  )
  assert.ok(detailClickHandler)
  assert.ok(searchClickHandler)
  assert.match(detailClickHandler[0], /trackActivationMode === 'doubleClick'\) return/)
  assert.doesNotMatch(detailClickHandler[0], /selectOnly\(/)
  assert.doesNotMatch(searchClickHandler[0], /selectOnly\(/)
  assert.match(source, /multiSelect\.shouldSuppressRowDoubleClick\(event\)/)
  assert.match(detailSource, /emit\('playTrack', track, index, event\)/)
  assert.match(searchSource, /batchFavorite/)
  assert.match(searchSource, /batchAddToPlaylist/)
  assert.match(searchSource, /trackContextMenu/)
  assert.match(searchSource, /track-selected/)
  assert.match(searchSource, /selection-toolbar/)
  assert.match(detailSource, /batchAddToPlaylist/)
  assert.match(detailSource, /trackContextMenu/)
  assert.match(detailSource, /从歌单移除/)
  assert.match(source, /executeStreamingBatchRemoval\(tracks/)
  assert.doesNotMatch(source, /musicStore\.removeTrack\(track\.id\)/)
})

test('local-only streaming deletion uses one library removal transaction', async () => {
  const tracks = [createTrack('local:first', 'local'), createTrack('local:second', 'local')]
  const calls: Array<{ ids: string[]; mode: string }> = []
  const result = await executeStreamingBatchRemoval(tracks, {
    removeLocalTracks: async (selected, mode) => {
      calls.push({ ids: selected.map((track) => track.id), mode })
      return createLocalResult(
        selected,
        selected.map((track) => track.id)
      )
    },
    removeProviderTrack: async () => {
      throw new Error('provider removal must not run for local tracks')
    }
  })

  assert.deepEqual(calls, [{ ids: ['local:first', 'local:second'], mode: 'library' }])
  assert.deepEqual(result.removedTrackIds, ['local:first', 'local:second'])
  assert.deepEqual(result.failures, [])
})

test('mixed streaming deletion batches locals and keeps provider semantics separate', async () => {
  const local = createTrack('local:first', 'local')
  const failedLocal = createTrack('local:failed', 'local')
  const provider = createTrack('ncm:42', 'ncm')
  const localCalls: string[][] = []
  const providerCalls: string[] = []

  const result = await executeStreamingBatchRemoval([local, provider, failedLocal], {
    removeLocalTracks: async (selected) => {
      localCalls.push(selected.map((track) => track.id))
      const response = createLocalResult(selected, [local.id])
      response.failures.push({ id: failedLocal.id, message: 'local failed' })
      return response
    },
    removeProviderTrack: async (track) => {
      providerCalls.push(track.id)
    }
  })

  assert.deepEqual(localCalls, [['local:first', 'local:failed']])
  assert.deepEqual(providerCalls, ['ncm:42'])
  assert.deepEqual(result.removedTrackIds, ['local:first', 'ncm:42'])
  assert.deepEqual(result.failures, [{ id: failedLocal.id, message: 'local failed' }])
})

test('external provider unfavorite still runs when the local removal phase rejects', async () => {
  const local = createTrack('local:first', 'local')
  const external = createTrack('bili:BV1xx', 'bili')
  const providerCalls: Array<{ id: string | number; like: boolean }> = []
  const registry = new MediaProviderRegistry()
  registry.register({
    id: 'bili',
    name: 'Bilibili',
    source: 'plugin',
    capabilities: ['library'],
    likeTrack: async (id, like) => {
      providerCalls.push({ id, like })
    }
  })
  const removedSnapshots: string[] = []

  const result = await executeStreamingBatchRemoval([local, external], {
    removeLocalTracks: async () => {
      throw new Error('local transaction failed')
    },
    removeProviderTrack: (track) =>
      removeStreamingProviderFavorite(track, {
        providers: registry,
        removeNcmFavorite: async () => {
          throw new Error('unexpected NCM fallback')
        },
        removeSnapshotFavorite: (removed) => { removedSnapshots.push(removed.id) }
      })
  })

  assert.deepEqual(providerCalls, [{ id: 'BV1xx', like: false }])
  assert.deepEqual(removedSnapshots, ['bili:BV1xx'])
  assert.deepEqual(result.removedTrackIds, ['bili:BV1xx'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].id, local.id)
})

test('local dashboard renders Core-resolved listening identities', () => {
  const dashboardSource = readFileSync(new URL('../LocalDashboard.vue', import.meta.url), 'utf8')
  assert.match(dashboardSource, /getMostListenedTracks\(TOP_TRACK_COUNT\)/)
  assert.match(dashboardSource, /stat\.displayTrack/)
  assert.doesNotMatch(dashboardSource, /createUnifiedRecentTrackResolver|musicVersionRevision|window\.api\.library/)
})

function createFmHarness() {
  const current = createTrack('kugou:current', 'kugou')
  const incoming = createTrack('kugou:next', 'kugou')
  const requests: string[] = []
  const appended: Track[][] = []
  const scope = {
    personalizedStreamLoading: { fm: false },
    personalizedStreamRetryAfter: { fm: 0 },
    currentTrack: { value: current },
    activeProvider: { value: 'kugou' },
    recommendationTracks: { value: { fm: [current] } },
    recommendationSessions: { value: { fm: { id: 'fm-session' } } },
    core: {
      query: async (_name: string, input: { trackId: string }) => ({ position: scope.recommendationTracks.value.fm.findIndex(track => track.id === input.trackId) }),
      command: async () => ({ id: 'fm-session' })
    },
    recommendationRequestId: 1,
    currentDetail: { value: null },
    playbackStore: { queue: { value: [current] } },
    providerStore: {
      getProvider: () => ({ supportedMethods: ['fetchPersonalFm'] }),
      callProvider: async (id: string) => {
        requests.push(id)
        return [current, incoming]
      }
    },
    appendPersonalizedStreamTracks: (_session: unknown, tracks: Track[]) => appended.push(tracks),
    appendUniqueTracks,
    getTrackSource,
    PERSONALIZED_STREAM_RETRY_COOLDOWN_MS: 15000
  }
  const functionSource = source.slice(
    source.indexOf('async function loadMorePersonalizedStream('),
    source.indexOf('\nconst hasOnlineNavigationEntries =')
  )
  const load = runInNewContext(
    `${stripTypeScriptTypes(functionSource)}\nloadMorePersonalizedStream`,
    scope
  ) as (key: string) => Promise<void>
  return { load, scope, requests, appended, current, incoming }
}

test('guest home skips private daily recommendations while retaining public chart sections', async () => {
  const definitions = [
    {
      key: 'daily',
      title: '每日推荐',
      method: 'fetchRecommendSongs',
      args: ['daily'],
      requiresLogin: true
    },
    { key: 'hot', title: '热歌榜', method: 'fetchRecommendSongs', args: ['hot'] }
  ]
  const calls: unknown[][] = []
  const scope = {
    activeProvider: { value: 'qq' },
    activeLoggedIn: { value: false },
    activeProviderInfo: { value: { ui: { streamingHome: { requiresLogin: false } } } },
    providerSupportsHome: () => true,
    recommendationProviderId: { value: '' },
    recommendationRequestId: 0,
    homeSectionDefinitions: { value: [] },
    recommendationTracks: { value: {} as Record<string, Track[]> },
    recommendationSessions: { value: {} },
    core: { command: async () => undefined },
    createBrowseWindow: () => {
      const state = { value: { tracks: [] as Track[], session: { id: 'section' } } }
      return { state, seed: async (_id: string, tracks: Track[]) => { state.value.tracks = tracks }, dispose() {} }
    },
    recommendationErrors: { value: {} },
    recommendPlaylists: { value: [] },
    recsLoading: { value: false },
    recsError: { value: '' },
    getHomeSectionDefinitions: () => definitions,
    friendlyStreamingError: (_error: unknown, fallback: string) => fallback,
    providerStore: {
      getProvider: () => ({ supportedMethods: ['fetchRecommendSongs'] }),
      callProvider: async (_id: string, _method: string, args: unknown[]) => {
        calls.push(args)
        return [createTrack('qq:hot', 'qq')]
      }
    }
  }
  const functionSource = source.slice(
    source.indexOf('async function loadRecommendations('),
    source.indexOf('\nconst recSections =')
  )
  const load = runInNewContext(
    `${stripTypeScriptTypes(functionSource)}\nloadRecommendations`,
    scope
  ) as () => Promise<void>
  await load()
  assert.deepEqual(calls, [['hot']])
  assert.equal(scope.recommendationTracks.value.daily.length, 0)
  assert.equal(scope.recommendationTracks.value.hot.length, 1)
  assert.equal(scope.recsError.value, '')
})

test('browsing a further FM shelf changes only displayed recommendations', async () => {
  const harness = createFmHarness()
  await harness.load('fm')
  assert.deepEqual(harness.requests, ['kugou'])
  assert.equal(harness.scope.recommendationTracks.value.fm[0], harness.current)
  assert.equal(harness.scope.recommendationTracks.value.fm[1], harness.incoming)
  assert.equal(harness.appended.length, 0)
  assert.equal(harness.scope.personalizedStreamLoading.fm, false)
})

test('a repeated display FM batch backs off without writing the Core playback queue', async () => {
  const harness = createFmHarness()
  harness.scope.recommendationTracks.value = { fm: [harness.current, harness.incoming] }
  await harness.load('fm')
  assert.equal(harness.appended.length, 0)
  assert.ok(harness.scope.personalizedStreamRetryAfter.fm > Date.now())
})

test('a late display FM response cannot overwrite a refreshed homepage', async () => {
  const harness = createFmHarness()
  const refreshed = { fm: [createTrack('kugou:refreshed', 'kugou')] }
  harness.scope.providerStore.callProvider = async () => {
    harness.scope.recommendationRequestId += 1
    harness.scope.recommendationTracks.value = refreshed
    return [harness.incoming]
  }
  await harness.load('fm')
  assert.equal(harness.scope.recommendationTracks.value, refreshed)
  assert.equal(harness.appended.length, 0)
})

function createTrack(id: string, source: string): Track {
  return {
    id,
    title: id,
    artist: 'Test Artist',
    album: 'Test Album',
    filePath: `C:\\Music\\${id.replace(':', '-')}.flac`,
    fileName: `${id}.flac`,
    duration: 120,
    size: 1,
    cover: null,
    lyrics: null,
    source
  }
}

function createLocalResult(_tracks: Track[], removedTrackIds: string[]): CoreLibraryRemovalResult {
  return { revision: 1, removedTrackIds, removedFileCount: 0, failures: [] }
}

test('saved streaming scroll positions stay bounded', () => {
  assert.match(source, /SAVED_SCROLL_POSITION_LIMIT = \d+/)
  assert.match(source, /while \(savedScrollPositions\.size > SAVED_SCROLL_POSITION_LIMIT\)/)
})


test('collection UI forwards source, bounded paging and cancellation to Core without provider fan-out', async () => {
  const requests: unknown[] = [], warnings: string[] = []
  const controller = new AbortController()
  const search = createCoreCollectionSearch({
    read: async (query, signal) => {
      requests.push({ query, signal })
      return { kind: query.kind, total: 90, offset: query.offset ?? 0, hasMore: false, warning: 'One provider failed', items: [{ kind: query.kind, id: 'release:1', name: 'Release', providerId: 'ncm', providerName: 'NetEase' }] }
    }, warning: message => warnings.push(message)
  })
  const albums = await search.albums('all', 'release', 40, 80, { signal: controller.signal })
  assert.equal(albums.total, 90)
  assert.equal(albums.albums[0].cover, null)
  assert.equal(albums.albums[0].trackCount, 0)
  await search.artists('local', 'artist', 20, 0)
  await search.playlists('ncm', 'playlist')
  assert.deepEqual(requests, [
    { query: { kind: 'albums', query: 'release', limit: 40, offset: 80, scope: 'all' }, signal: controller.signal },
    { query: { kind: 'artists', query: 'artist', limit: 20, offset: 0, scope: 'local' }, signal: undefined },
    { query: { kind: 'playlists', query: 'playlist', limit: 30, offset: 0, providerId: 'ncm' }, signal: undefined }
  ])
  assert.equal(warnings.length, 3)
})

test('a provider unfavorite waits for Core favorite persistence before reporting removal', async () => {
  const order: string[] = []
  let acknowledge!: () => void
  const track = { ...createTrack('ncm:42', 'ncm'), ncmSongId: 42 }
  const operation = removeStreamingProviderFavorite(track, {
    providers: { getForTrack: () => null },
    removeNcmFavorite: async () => { order.push('provider') },
    removeSnapshotFavorite: async () => { await new Promise<void>(resolve => { acknowledge = resolve }); order.push('core') }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['provider'])
  acknowledge()
  await operation
  assert.deepEqual(order, ['provider', 'core'])
})
