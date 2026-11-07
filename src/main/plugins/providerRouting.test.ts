import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const {
  dedupeProviderRegistrations,
  findProviderRoute,
  getProviderCallTimeoutMs,
  getProviderMethodStats,
  isTwilightMediaProviderMethod,
  normalizeProviderHealth,
  normalizeProviderUi,
  providerSupportsMethod
} = (await import(
  new URL('./providerRouting.ts', import.meta.url).href
)) as typeof import('./providerRouting')
const { isRecoverableBundledPluginFailure } = (await import(
  new URL('./stateRecovery.ts', import.meta.url).href
)) as typeof import('./stateRecovery')

type TestRunningProvider = {
  pluginId: string
  providers: Array<{
    id: string
    name: string
    capabilities: Array<
      'search' | 'playbackUrl' | 'lyrics' | 'cover' | 'playlist' | 'library' | 'login' | 'download'
    >
    supportedMethods?: Array<
      'fetchPlaylistTracks' | 'fetchPlaylistTracksPage' | 'readPlaylistImportPage' | 'fetchDiscoveryPlaylists'
    >
  }>
}

const skeleton: TestRunningProvider = {
  pluginId: 'com.test.bili-provider-basic',
  providers: [
    {
      id: 'bili',
      name: 'Bilibili Basic Provider',
      capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist']
    }
  ]
}

const fullProvider: TestRunningProvider = {
  pluginId: 'com.twilightecho.provider.bilibili',
  providers: [
    {
      id: 'bili',
      name: 'Bilibili',
      capabilities: ['login', 'playlist', 'library', 'playbackUrl', 'cover']
    }
  ]
}

test('album search is an optional routed search method with the standard search timeout', () => {
  const provider = {
    id: 'ncm',
    name: 'NCM',
    capabilities: ['search' as const],
    supportedMethods: ['searchAlbums' as const]
  }
  assert.equal(isTwilightMediaProviderMethod('searchAlbums'), true)
  assert.equal(providerSupportsMethod(provider, 'searchAlbums'), true)
  assert.equal(providerSupportsMethod({ ...provider, supportedMethods: [] }, 'searchAlbums'), false)
  assert.equal(providerSupportsMethod({ ...provider, capabilities: [] }, 'searchAlbums'), false)
  assert.equal(getProviderCallTimeoutMs('searchAlbums'), getProviderCallTimeoutMs('searchSongs'))
})

test('album identity requires an explicit handler without replacing album tracks', () => {
  const provider = { id: 'ncm', name: 'NCM', capabilities: ['playlist' as const],
    supportedMethods: ['fetchAlbumIdentity' as const] }
  assert.equal(isTwilightMediaProviderMethod('fetchAlbumIdentity'), true)
  assert.equal(providerSupportsMethod(provider, 'fetchAlbumIdentity'), true)
  assert.equal(providerSupportsMethod({ ...provider, supportedMethods: [] }, 'fetchAlbumIdentity'), false)
  assert.equal(providerSupportsMethod({ ...provider, supportedMethods: undefined }, 'fetchAlbumIdentity'), false)
  assert.equal(providerSupportsMethod({ ...provider, capabilities: [] }, 'fetchAlbumIdentity'), false)
  assert.equal(getProviderCallTimeoutMs('fetchAlbumIdentity'), getProviderCallTimeoutMs('fetchAlbumTracks'))
  const host = readFileSync(new URL('./host.ts', import.meta.url), 'utf8')
  assert.match(host, /'fetchAlbumIdentity'/)
})

test('artist identity is an explicitly advertised library read with a metadata timeout', () => {
  const provider = { id: 'ncm', name: 'NCM', capabilities: ['library' as const], supportedMethods: ['fetchArtistIdentity' as const] }
  assert.equal(isTwilightMediaProviderMethod('fetchArtistIdentity'), true)
  assert.equal(providerSupportsMethod(provider, 'fetchArtistIdentity'), true)
  assert.equal(providerSupportsMethod({ ...provider, supportedMethods: undefined }, 'fetchArtistIdentity'), false)
  assert.equal(providerSupportsMethod({ ...provider, capabilities: [] }, 'fetchArtistIdentity'), false)
  assert.equal(getProviderCallTimeoutMs('fetchArtistIdentity'), getProviderCallTimeoutMs('fetchArtistMetadata'))
  assert.match(readFileSync(new URL('./host.ts', import.meta.url), 'utf8'), /'fetchArtistIdentity'/)
})

test('playlist paging requires an advertised handler and playlist capability through host routing', () => {
  const provider: TestRunningProvider['providers'][number] = {
    id: 'bili',
    name: 'Bilibili',
    capabilities: ['playlist'],
    supportedMethods: ['fetchPlaylistTracks', 'fetchPlaylistTracksPage']
  }
  assert.equal(providerSupportsMethod(provider, 'fetchPlaylistTracksPage'), true)
  assert.equal(
    providerSupportsMethod({ ...provider, capabilities: [] }, 'fetchPlaylistTracksPage'),
    false
  )
  assert.equal(
    providerSupportsMethod(
      { ...provider, supportedMethods: ['fetchPlaylistTracks'] },
      'fetchPlaylistTracksPage'
    ),
    false
  )
  assert.equal(
    getProviderCallTimeoutMs('fetchPlaylistTracksPage'),
    getProviderCallTimeoutMs('fetchPlaylistTracks')
  )
})

test('complete playlist import requires an explicit handler and playlist capability',()=>{
  const provider:TestRunningProvider['providers'][number]={id:'ncm',name:'NCM',capabilities:['playlist'],supportedMethods:['readPlaylistImportPage']}
  assert.equal(isTwilightMediaProviderMethod('readPlaylistImportPage'),true)
  assert.equal(providerSupportsMethod(provider,'readPlaylistImportPage'),true)
  assert.equal(providerSupportsMethod({...provider,capabilities:[]},'readPlaylistImportPage'),false)
})

test('routes provider calls to a plugin that declares the required method capability', () => {
  assert.equal(providerSupportsMethod(skeleton.providers[0], 'getQrLogin'), false)
  assert.equal(providerSupportsMethod(fullProvider.providers[0], 'getQrLogin'), true)

  assert.equal(
    findProviderRoute([skeleton, fullProvider], 'bili', 'getQrLogin')?.pluginId,
    fullProvider.pluginId
  )
  assert.equal(
    findProviderRoute([skeleton, fullProvider], 'bili', 'searchSongs')?.pluginId,
    skeleton.pluginId
  )
})

test('routes download lifecycle calls only to providers declaring download capability', () => {
  const downloadProvider: TestRunningProvider = {
    pluginId: 'com.test.download-provider',
    providers: [
      {
        id: 'am',
        name: 'Apple Music',
        capabilities: ['search', 'playbackUrl', 'download']
      }
    ]
  }

  for (const method of [
    'createDownload',
    'getDownloadStatus',
    'getDownloadFile',
    'cancelDownload'
  ] as const) {
    assert.equal(providerSupportsMethod(downloadProvider.providers[0], method), true)
    assert.equal(providerSupportsMethod(skeleton.providers[0], method), false)
    assert.equal(
      findProviderRoute([skeleton, downloadProvider], 'am', method)?.pluginId,
      downloadProvider.pluginId
    )
  }
})

test('actual provider methods narrow broad capabilities when supplied by the host', () => {
  const provider: TestRunningProvider['providers'][number] = {
    id: 'playlist-only',
    name: 'Playlist Only',
    capabilities: ['playlist'],
    supportedMethods: ['fetchPlaylistTracks']
  }

  assert.equal(providerSupportsMethod(provider, 'fetchPlaylistTracks'), true)
  assert.equal(providerSupportsMethod(provider, 'fetchDiscoveryPlaylists'), false)
})

test('prefers the latest registration when multiple plugins expose the same provider id', () => {
  assert.equal(
    findProviderRoute([skeleton, fullProvider], 'bili', 'getPlaybackUrl')?.pluginId,
    fullProvider.pluginId
  )
  assert.deepEqual(dedupeProviderRegistrations([skeleton, fullProvider]), fullProvider.providers)
})

test('classifies provider call timeouts by method latency class', () => {
  assert.equal(getProviderCallTimeoutMs('openOfficialLogin'), 240_000)
  assert.equal(getProviderCallTimeoutMs('fetchSavedAlbums'), 120_000)
  assert.equal(getProviderCallTimeoutMs('fetchSavedArtists'), 120_000)
  assert.equal(getProviderCallTimeoutMs('fetchPlaylistTracks'), 120_000)
  assert.equal(getProviderCallTimeoutMs('getPlaybackUrl'), 30_000)
  assert.equal(getProviderCallTimeoutMs('likeTrack'), 15_000)
})

test('normalizes provider health records from plugin registration metadata', () => {
  const health = normalizeProviderHealth(
    {
      totalCalls: 3.9,
      successfulCalls: 2,
      failedCalls: -1,
      lastError: '  transient failure  ',
      methodStats: {
        getPlaybackUrl: { totalCalls: 1, successfulCalls: 1, failedCalls: 0, lastError: null },
        unknownMethod: { totalCalls: 1, successfulCalls: 1, failedCalls: 0 },
        getLyrics: 'invalid'
      }
    },
    'ncm',
    'com.twilightecho.provider.ncm'
  )

  assert.deepEqual(health, {
    providerId: 'ncm',
    pluginId: 'com.twilightecho.provider.ncm',
    totalCalls: 3,
    successfulCalls: 2,
    failedCalls: 0,
    methodStats: {
      getPlaybackUrl: {
        totalCalls: 1,
        successfulCalls: 1,
        failedCalls: 0,
        lastError: null,
        lastCheckedAt: null
      }
    },
    lastError: 'transient failure',
    lastCheckedAt: null
  })
  assert.equal(normalizeProviderHealth(null, 'ncm', 'plugin'), null)
})

test('normalizes provider UI metadata defaults and filters malformed sections', () => {
  const ui = normalizeProviderUi({
    icon: 'pi pi-cloud',
    authType: 'browser',
    qrStatusCodes: { waiting: 1, scanned: 2, expired: 3, denied: 4, success: 5 },
    streamingSections: [
      { id: 'weekly', title: 'Weekly', method: 'fetchRecommendSongs' },
      { title: 'Missing Method' }
    ],
    loginExtraActions: [{ label: 'Open Web', method: 'openOfficialLogin' }, { method: 'missing' }]
  })

  assert.deepEqual(ui, {
    icon: 'pi pi-cloud',
    color: undefined,
    description: undefined,
    authType: 'qr',
    loginInstructions: undefined,
    qrStatusCodes: { waiting: 1, scanned: 2, expired: 3, denied: 4, success: 5 },
    showBrowserButton: undefined,
    loginExtraActions: [
      { label: 'Open Web', icon: 'pi pi-external-link', method: 'openOfficialLogin' }
    ],
    streamingSections: [
      {
        id: 'weekly',
        title: 'Weekly',
        icon: 'pi pi-music',
        method: 'fetchRecommendSongs',
        args: undefined
      }
    ],
    streamingLibraryTab: undefined,
    streamingSearch: undefined,
    unifiedLibrary: undefined
  })
  assert.equal(normalizeProviderUi(undefined), undefined)
})

test('primary login actions survive normalization only when explicitly enabled', () => {
  const actions = normalizeProviderUi({ loginExtraActions: [
    { label: 'Official', method: 'openOfficialLogin', primary: true },
    { label: 'Other', method: 'otherLogin', primary: 'true' }
  ] })?.loginExtraActions
  assert.equal(actions?.[0].primary, true)
  assert.equal(actions?.[1].primary, undefined)
})

test('homepage presentation preserves public browsing and bounds provider copy', () => {
  const ui = normalizeProviderUi({
    streamingHome: { requiresLogin: false, subtitle: '首页'.repeat(100) },
    streamingDiscovery: { supportsSort: false },
    streamingSections: [
      {
        id: 'new',
        title: '新歌首发',
        method: 'fetchRecommendSongs',
        args: ['new'],
        requiresLogin: true,
        eyebrow: 'FRESH',
        description: '新歌'.repeat(200)
      }
    ]
  })
  assert.equal(ui?.streamingHome?.requiresLogin, false)
  assert.equal(ui?.streamingHome?.subtitle?.length, 120)
  assert.equal(ui?.streamingDiscovery?.supportsSort, false)
  assert.equal(ui?.streamingSections?.[0].requiresLogin, true)
  assert.equal(ui?.streamingSections?.[0].description?.length, 240)
  assert.equal(ui?.streamingSections?.[0].eyebrow, 'FRESH')
  assert.deepEqual(ui?.streamingSections?.[0].args, ['new'])
  assert.equal(normalizeProviderUi({ streamingHome: {} })?.streamingHome?.requiresLogin, true)
})

test('derives provider method health success rates without mutating records', () => {
  const stats = getProviderMethodStats({
    providerId: 'ncm',
    pluginId: 'plugin',
    totalCalls: 2,
    successfulCalls: 1,
    failedCalls: 1,
    methodStats: {
      getPlaybackUrl: {
        totalCalls: 2,
        successfulCalls: 1,
        failedCalls: 1,
        lastError: 'timeout',
        lastCheckedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    lastError: 'timeout',
    lastCheckedAt: '2026-01-01T00:00:00.000Z'
  })

  assert.deepEqual(stats.getPlaybackUrl, {
    totalCalls: 2,
    successfulCalls: 1,
    failedCalls: 1,
    successRate: 0.5,
    lastError: 'timeout',
    lastCheckedAt: '2026-01-01T00:00:00.000Z'
  })
  assert.deepEqual(getProviderMethodStats(undefined), {})
})

test('treats bundled plugin host-exit failures as recoverable startup state', () => {
  assert.equal(isRecoverableBundledPluginFailure('插件宿主进程退出：18446744073709552000'), true)
  assert.equal(isRecoverableBundledPluginFailure('Invalid value for env'), true)
  assert.equal(isRecoverableBundledPluginFailure('Provider 调用超时：ncm.getPlaybackUrl'), false)
  assert.equal(isRecoverableBundledPluginFailure(undefined), false)
})

test('omits utility process env option when no proxy env is configured', () => {
  const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8')

  assert.match(source, /\.\.\.\(Object\.keys\(proxyEnv\)\.length > 0 \? \{ env:/)
  assert.equal(
    /const env = Object\.keys\(proxyEnv\)\.length > 0[\s\S]*utilityProcess\.fork[\s\S]*\benv\b/.test(
      source
    ),
    false,
    'Electron utilityProcess.fork rejects an explicit env: undefined option'
  )
})

test('bundled provider missing-method errors mention restarting the app', () => {
  const source = readFileSync(new URL('../../core/plugins/manager.ts', import.meta.url), 'utf8')

  assert.match(source, /内置音源插件尚未加载最新代码，请重启应用/)
})

test('plugin host exposes account login methods and reports its actual handler set', () => {
  const source = readFileSync(new URL('./host.ts', import.meta.url), 'utf8')

  assert.match(source, /'sendCaptcha'/)
  assert.match(source, /'loginByPhonePassword'/)
  assert.match(source, /'loginByPhoneCaptcha'/)
  assert.match(source, /'loginByEmailPassword'/)
  assert.match(source, /supportedMethods: Object\.keys\(handlers\)/)
})

test('server login requires both a declared method and login capability', () => {
  const provider = {
    id: 'jellyfin',
    name: 'Jellyfin',
    capabilities: ['login' as const],
    supportedMethods: ['loginWithServer' as const]
  }
  assert.equal(providerSupportsMethod(provider, 'loginWithServer'), true)
  assert.equal(providerSupportsMethod({ ...provider, capabilities: [] }, 'loginWithServer'), false)
  assert.equal(
    providerSupportsMethod({ ...provider, supportedMethods: [] }, 'loginWithServer'),
    false
  )
  const host = readFileSync(new URL('./host.ts', import.meta.url), 'utf8')
  assert.match(host, /'loginWithServer'/)
})
