import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { compileStyle } from '@vue/compiler-sfc'
import type { LocalLibraryRemoveResult } from '../../../../shared/localLibrary.ts'
import type { Track } from '../../types/music.ts'
import { appendUniqueTracks } from './streamingPageModel.ts'
import { getTrackSource } from '../../utils/logicalTrackModel.ts'

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('../StreamingHome.vue', import.meta.url), 'utf8')
const discoverySource = readFileSync(new URL('../StreamingDiscovery.vue', import.meta.url), 'utf8')
const providerHomeSource = readFileSync(new URL('./ProviderMusicHome.vue', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('./StreamingContentHeader.vue', import.meta.url), 'utf8')

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
        if (album.providerId === 'local') return local
        return new Promise<Track[]>((resolve) => {
          finishRemote = resolve
        })
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
    providerId: 'local'
  }
  const remote = handlers.openSearchAlbum({ ...album, providerId: 'ncm' })
  await handlers.openSearchAlbum(album)
  finishRemote([createTrack('ncm:1', 'ncm')])
  await remote
  assert.equal(scope.detailTracks.value, local)
  assert.equal(scope.activeProvider.value, 'another-provider')
  assert.equal(scope.detailLoading.value, false)
  assert.equal(scope.detailError.value, '')
  assert.equal(stack.at(-1)?.providerId, 'local')
  const depth = stack.length
  await handlers.openAlbum(album, 'local', true)
  assert.equal(stack.length, depth)
  assert.deepEqual(
    calls.map((call) => call.providerId),
    ['ncm', 'local', 'local']
  )
})
test('album links in track rows retain local release identity and online source', async () => {
  const code = source.match(
    /async function openTrackAlbum[\s\S]*?(?=\nfunction openTrackArtist)/
  )?.[0]
  assert.ok(code)
  const track = createTrack('local:1', 'local')
  const opened: Array<{ providerId: string; id: string | number }> = []
  const handler = runInNewContext(`${stripTypeScriptTypes(code)}\nopenTrackAlbum`, {
    detailProviderId: { value: 'another-provider' },
    musicStore: {
      albums: {
        value: [{ id: 'release:1', name: 'Album', tracks: [track], cover: null, trackCount: 1 }]
      }
    },
    openAlbum: async (album: { id: string | number }, providerId: string) =>
      opened.push({ providerId, id: album.id }),
    pushNotice: () => assert.fail('the local library supplies the album identity')
  })
  await handler(track)
  await handler({ ...createTrack('ncm:1', 'ncm'), albumId: 1 })
  assert.deepEqual(opened, [
    { providerId: 'local', id: 'release:1' },
    { providerId: 'ncm', id: 1 }
  ])
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
  assert.match(source, /localTracks: musicStore\.tracks\.value/)
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
  assert.match(source, /artistNavigationRequest\?: StreamingArtistNavigationRequest \| null/)
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
  assert.match(source, /openArtist\(matched \?\? \{ id: request\.artistId/)
  // 没有 id 才回退名字匹配，且要先拿到全部同名候选，由页面自己消歧并告知用户。
  assert.match(source, /matchStreamingArtistsByName\(artistName, searchResult\?\.items \?\? \[\]\)/)
  assert.match(source, /candidates\.length > 1/)
  // 绝不能退回“搜索结果里第一个同名者即命中”——那正是同名歌手跳错页的成因。
  assert.doesNotMatch(source, /findBestStreamingArtistMatch\(artistName, result\.items\)/)
})

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
  assert.match(source, /topStats/)
  assert.match(source, /resolveUnifiedRecentTracks\(\{/)
  assert.doesNotMatch(source, /const tracks = await fetchPlayRecords\(1\)/)
})

test('provider likes never fall back to application favorites', () => {
  assert.match(source, /fetchLikedTracksPage\(0, LIKED_TRACKS_PAGE_SIZE, force\)/)
  assert.doesNotMatch(source, /unifiedFavoriteTracks|summarizeUnifiedFavoriteTracks/)
  assert.match(source, /Boolean\(activeExternalState\.value\?\.likedPlaylist\)/)
})

test('liked playback resolves the complete provider list instead of queueing only the first page', () => {
  assert.match(source, /async function resolveDetailPlaybackQueue\(\): Promise<Track\[]>/)
  assert.match(source, /const tracks = await fetchLikedTracks\(\)/)
  assert.match(source, /async function playAllDetailTracks\(\): Promise<void>/)
  assert.match(source, /const tracks = await resolveDetailPlaybackQueue\(\)/)
  // 通过 playStreamingTrack 仍使用完整解析后的列表（同时携带心动模式上下文）。
  assert.match(source, /playStreamingTrack\(tracks\[0\], tracks\)/)
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
    resolveDetailPlaybackQueue: async () => {
      assert.equal(scope.currentDetail.value?.playlist.id, selected.id)
      return tracks
    },
    playStreamingTrack: (first: Track, queue: Track[]) => {
      assert.equal(first, tracks[0])
      played.push(queue)
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

test('private FM and radar use a session-fenced queue stream in shuffle mode', () => {
  assert.match(source, /const PERSONALIZED_STREAM_QUEUE_THRESHOLD = 6/)
  assert.match(source, /async function loadMorePersonalizedStream/)
  assert.match(source, /session: PersonalizedStreamSession \| null = null/)
  assert.match(source, /let additions = appendUniqueTracks\(existing, incoming\)/)
  assert.match(source, /key === 'radar' &&\s*additions\.length === 0/)
  assert.match(source, /providerStore\.callProvider<Track\[]>\(providerId,\s*'fetchPersonalFm'\)/)
  assert.match(source, /if \(session\) appendPersonalizedStreamTracks\(session, additions\)/)
  assert.match(source, /playTrack\(track, trackQueue\)[\s\S]*startPersonalizedStream\(streamKey\)/)
  assert.match(source, /personalizedStreamRemaining/)
  assert.match(source, /personalizedStreamLoading\[session\.key\]/)
  assert.doesNotMatch(source, /queueLength - index > PERSONALIZED_STREAM_QUEUE_THRESHOLD/)
  assert.doesNotMatch(source, /activePersonalizedStreamKey/)
  assert.match(homeSource, /function playPersonalizedStream/)
  assert.match(homeSource, /@click="playPersonalizedStream\(fmSection\)"/)
  assert.match(homeSource, /@click="playPersonalizedStream\(radarSection\)"/)
  assert.doesNotMatch(homeSource, /@click="emit\('openRecSection', fmSection\)"/)
  assert.doesNotMatch(homeSource, /@click="emit\('openRecSection', radarSection\)"/)
})

test('each streaming destination stays mounted across page switches', () => {
  const appSource = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
  assert.match(appSource, /v-for="tab in streamingPageTabs"/)
  assert.match(source, /v-show="active !== false"/)
  assert.doesNotMatch(appSource.match(/<StreamingPage\b[\s\S]*?\/>/)?.[0] ?? '', /v-if=/)
  assert.match(appSource, /:active="showStreamingSurface && streamingTab === tab"/)
  assert.doesNotMatch(source, /<ProviderSidebar/)
  assert.match(source, /async function refreshStreamingSurface/)
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
  assert.match(source, /executeStreamingBatchRemoval\(selected/)
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
      response.failures.push({ filePath: failedLocal.filePath, message: 'local failed' })
      return response
    },
    removeProviderTrack: async (track) => {
      providerCalls.push(track.id)
    }
  })

  assert.deepEqual(localCalls, [['local:first', 'local:failed']])
  assert.deepEqual(providerCalls, ['ncm:42'])
  assert.deepEqual(result.removedTrackIds, ['local:first', 'ncm:42'])
  assert.deepEqual(result.failures, [{ filePath: failedLocal.filePath, message: 'local failed' }])
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
        removeSnapshotFavorite: (removed) => removedSnapshots.push(removed.id)
      })
  })

  assert.deepEqual(providerCalls, [{ id: 'BV1xx', like: false }])
  assert.deepEqual(removedSnapshots, ['bili:BV1xx'])
  assert.deepEqual(result.removedTrackIds, ['bili:BV1xx'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].filePath, local.filePath)
})

test('local dashboard top tracks resolve logical stats to playable local variants', () => {
  const dashboardSource = readFileSync(new URL('../LocalDashboard.vue', import.meta.url), 'utf8')

  assert.match(
    dashboardSource,
    /import \{ createUnifiedRecentTrackResolver \} from '\.\.\/utils\/unifiedRecentTracks'/
  )
  assert.match(dashboardSource, /getMostListenedTracks\(TOP_TRACK_COUNT\)/)
  assert.match(dashboardSource, /createUnifiedRecentTrackResolver\(tracks\.value\)/)
  assert.doesNotMatch(dashboardSource, /recentStats: \[stat\]/)
  assert.doesNotMatch(dashboardSource, /Object\.entries\(listeningStats\.value\.tracks\)/)
  assert.doesNotMatch(dashboardSource, /track: byId\.get\(id\) \?\? stat\.track/)
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
    activeProvider: { value: 'qq' },
    recommendationTracks: { value: { fm: [createTrack('qq:visible', 'qq')] } },
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
  ) as (key: string, session: unknown) => Promise<void>
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

test('FM continues from its playing provider after browsing another homepage', async () => {
  const harness = createFmHarness()
  const visible = harness.scope.recommendationTracks.value
  await harness.load('fm', { key: 'fm', id: 1 })
  assert.deepEqual(harness.requests, ['kugou'])
  assert.equal(harness.scope.recommendationTracks.value, visible)
  assert.deepEqual(harness.appended[0], [harness.incoming])
  assert.equal(harness.scope.personalizedStreamLoading.fm, false)
})

test('a repeated FM batch backs off without appending duplicate queue tracks', async () => {
  const harness = createFmHarness()
  harness.scope.playbackStore.queue.value = [harness.current, harness.incoming]
  await harness.load('fm', { key: 'fm', id: 1 })
  assert.equal(harness.appended.length, 0)
  assert.ok(harness.scope.personalizedStreamRetryAfter.fm > Date.now())
})

test('FM completion cannot overwrite a homepage refreshed during the request', async () => {
  const harness = createFmHarness()
  harness.scope.activeProvider.value = 'kugou'
  const refreshed = { fm: [createTrack('kugou:refreshed', 'kugou')] }
  harness.scope.providerStore.callProvider = async () => {
    harness.scope.recommendationRequestId += 1
    harness.scope.recommendationTracks.value = refreshed
    return [harness.incoming]
  }
  await harness.load('fm', { key: 'fm', id: 1 })
  assert.equal(harness.scope.recommendationTracks.value, refreshed)
  assert.deepEqual(harness.appended[0], [harness.incoming])
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

function createLocalResult(tracks: Track[], removedTrackIds: string[]): LocalLibraryRemoveResult {
  const removed = new Set(removedTrackIds)
  const removedTracks = tracks.filter((track) => removed.has(track.id))
  return {
    mode: 'library',
    library: {
      version: 2,
      revision: 1,
      tracks: tracks.filter((track) => !removed.has(track.id)),
      folders: [],
      exclusions: removedTracks.map((track) => ({
        filePath: track.filePath,
        title: track.title,
        artist: track.artist,
        excludedAt: '2026-01-01T00:00:00.000Z'
      }))
    },
    removedTrackIds,
    removedFilePaths: removedTracks.map((track) => track.filePath),
    failures: []
  }
}

test('saved streaming scroll positions stay bounded', () => {
  assert.match(source, /SAVED_SCROLL_POSITION_LIMIT = \d+/)
  assert.match(source, /while \(savedScrollPositions\.size > SAVED_SCROLL_POSITION_LIMIT\)/)
})
