import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import * as ncmProvider from './index.mjs'

function song(id) {
  return {
    id,
    name: `song-${id}`,
    ar: [{ name: 'artist' }],
    al: { name: `album-${id}`, picUrl: null },
    dt: 180000
  }
}

function album(id) {
  return {
    id,
    name: `album-${id}`,
    picUrl: null,
    size: 10
  }
}

async function activateProvider(
  request,
  settings = new Map([['cookie', 'MUSIC_U=test;']]),
  overrides = {}
) {
  let registeredProvider = null
  await ncmProvider.activate({
    twilight: {
      internal: {
        ncm: {
          request,
          officialLogin: async () => 'MUSIC_U=test;',
          getCachedSong: async () => null,
          cacheSong: async () => null,
          ...overrides.ncm
        }
      },
      providers: {
        register: async (provider) => {
          registeredProvider = provider
        }
      }
    },
    settings: {
      get: async (key) => (key == null ? Object.fromEntries(settings) : settings.get(key)),
      set: async (key, value) => {
        settings.set(key, value)
      },
      delete: async (key) => {
        settings.delete(key)
      }
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      ...overrides.logger
    }
  })
  assert.ok(registeredProvider)
  return registeredProvider
}

function parseRequest(path) {
  return new URL(path, 'http://twilight.local')
}

test('recording identity search is anonymous, exact-precision, bounded and excludes playback/private data', async () => {
  const provider = await activateProvider(async path => {
    const u = parseRequest(path)
    assert.equal(u.pathname, '/cloudsearch')
    assert.equal(u.searchParams.get('limit'), '10')
    return { code: 200, result: { songCount: 1, songs: [{ id: 123, name: 'Song', dt: 200125,
      ar: [{ id: 42, name: 'AC/DC' }, { id: 43, name: 'Guest' }], al: { id: 456, name: 'Album' }, url: 'unused' }] } }
  }, new Map())
  try {
    assert.deepEqual(await provider.searchRecordingIdentities('Song', 30, 0), { total: 1, items: [{ id: '123', title: 'Song',
      durationSeconds: 200.125, artists: [{ id: '42', name: 'AC/DC' }, { id: '43', name: 'Guest' }], album: { id: '456', title: 'Album' } }] })
  } finally { ncmProvider.deactivate() }
})

test('public metadata does not attach a saved account, preserves missing guest IDs and stops on rate limits', async () => {
  let calls = 0
  const provider = await activateProvider(async (_path, cookie) => {
    assert.equal(cookie, '')
    calls++
    return calls === 1 ? { code: 200, result: { songCount: 1, songs: [{ id: 123, name: 'Song', dt: 200125,
      ar: [{ id: 42, name: 'AC/DC' }, { id: 0, name: 'Guest' }], al: { id: 456, name: 'Album' } }] } }
      : { code: 429, message: '操作频繁，请稍候再试' }
  })
  try {
    assert.equal((await provider.searchRecordingIdentities('Song')).items[0].artists[1].id, null)
    await assert.rejects(provider.fetchArtistMetadata('42'), /NCM_METADATA_RATE_LIMITED/)
    await assert.rejects(provider.fetchAlbumMetadata('42'), /NCM_METADATA_RATE_LIMITED/)
    assert.equal(calls, 2, 'a cooldown must not send more upstream requests')
  } finally { ncmProvider.deactivate() }
})

test('artist identity uses exact anonymous IDs and only typed native aliases', async () => {
  let mismatch = false
  const controller = new AbortController()
  const provider = await activateProvider(async (path, cookie, options) => {
    assert.equal(cookie, '')
    assert.equal(parseRequest(path).pathname, '/artist/detail')
    assert.equal(options.signal, controller.signal)
    return { code: 200, data: { artist: { id: mismatch ? 99 : 42, name: 'かめりあ', alias: ['Camellia', 'Camellia', null], transNames: ['山茶花'], avatar: 'not identity data', private: 'discard' } } }
  })
  try {
    assert.deepEqual(await provider.fetchArtistIdentity('42', { signal: controller.signal }), { id: '42', name: 'かめりあ', aliases: ['Camellia', '山茶花'] })
    mismatch = true
    await assert.rejects(provider.fetchArtistIdentity('42', { signal: controller.signal }), /身份不一致/)
  } finally { ncmProvider.deactivate() }
})

test('recording search retains provider aliases only for a valid owning artist ID', async () => {
  const provider = await activateProvider(async () => ({ code: 200, result: { songCount: 1, songs: [{ id: 123, name: 'Song', dt: 200125,
    ar: [{ id: 42, name: 'かめりあ', alia: ['Camellia'] }, { id: 0, name: 'Guest', alias: ['not trusted'] }], al: { id: 456, name: 'Album' } }] } }))
  try {
    assert.deepEqual((await provider.searchRecordingIdentities('Song')).items[0].artists,
      [{ id: '42', name: 'かめりあ', aliases: ['Camellia'] }, { id: null, name: 'Guest' }])
  } finally { ncmProvider.deactivate() }
})

test('public artist search is anonymous-capable and still forwards an available account', async () => {
  for (const settings of [new Map(), new Map([['cookie', 'MUSIC_U=test;']])]) {
    const provider = await activateProvider(async (_path, cookie) => {
      assert.equal(cookie, settings.get('cookie') ?? '')
      return { code: 200, result: { artists: [{ id: 42, name: 'Artist' }], artistCount: 1 } }
    }, settings)
    try { assert.equal((await provider.searchArtists('Artist')).items[0].id, 42) }
    finally { ncmProvider.deactivate() }
  }
})

test('metadata portraits use artist avatar first, permit image-only details and reject non-CDN or signed resources', async () => {
  const avatar = 'http://p4.music.126.net/portrait==/109951167441551721.jpg'
  let artist = { id: 42, name: 'Artist', avatar, cover: 'https://p4.music.126.net/banner/123.jpg' }
  const provider = await activateProvider(async path => parseRequest(path).pathname === '/artist/detail'
    ? { code: 200, data: { artist } }
    : { code: 200 }, new Map())
  try {
    const result = await provider.fetchArtistMetadata('42')
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.metadata.texts, [])
    assert.equal(result.metadata.artwork[0].resource, avatar.replace('http:', 'https:'))
    assert.equal(result.metadata.artwork[0].url, 'https://music.163.com/#/artist?id=42')
    assert.equal(result.metadata.artwork[0].license, '')
    assert.equal(result.metadata.artwork[0].usage, undefined)
    for (const bad of ['https://evil.example/portrait/123.jpg', 'https://p4.music.126.net/portrait/123.jpg?token=secret',
      'https://user:secret@p4.music.126.net/portrait/123.jpg', 'file:///tmp/123.jpg']) {
      artist = { id: 42, name: 'Artist', avatar: bad, album: { picUrl: avatar } }
      assert.deepEqual(await provider.fetchArtistMetadata('42'), { status: 'not_provided' })
    }
    artist = { id: 42, name: 'Artist', briefDesc: '详情里的简介', avatar }
    assert.equal((await provider.fetchArtistMetadata('42')).metadata.texts[0].value, '详情里的简介')
  } finally { ncmProvider.deactivate() }
})

test('release artwork never changes its identity scope to artist or album project', async () => {
  const provider = await activateProvider(async () => ({ code: 200,
    album: { id: 42, name: 'Album', picUrl: 'http://p3.music.126.net/album/123.jpg' }
  }), new Map())
  try {
    const result = await provider.fetchAlbumMetadata('42')
    assert.equal(result.metadata.kind, 'release')
    assert.equal(result.metadata.artwork[0].resource, 'https://p3.music.126.net/album/123.jpg')
    assert.deepEqual(result.metadata.texts, [])
  } finally { ncmProvider.deactivate() }
})

test('native artist text preserves full source sections, unspecified language and anonymous request cancellation context', async () => {
  const controller = new AbortController(), calls = []
  const provider = await activateProvider(async (path, cookie, options) => {
    const url = parseRequest(path); calls.push(url.pathname)
    assert.equal(cookie, '')
    assert.equal(options.signal, controller.signal)
    assert.equal(url.searchParams.get('id'), '42')
    if (url.pathname === '/artist/detail') return { code: 200, data: { artist: { id: 42, name: 'Artist' } } }
    return { code: 200, briefDesc: '简介', introduction: [{ ti: '生平', txt: '正文' }] }
  }, new Map())
  try {
    const result = await provider.fetchArtistMetadata(42, { signal: controller.signal })
    assert.equal(result.status, 'ok')
    assert.equal(result.metadata.id, '42')
    assert.equal(result.metadata.texts[0].value, '简介\n\n生平\n正文')
    assert.equal(result.metadata.texts[0].language, 'und')
    assert.equal(result.metadata.texts[0].usage, undefined, 'API access does not grant caching/cross-source rights')
    assert.deepEqual(calls, ['/artist/detail', '/artist/desc'])
    assert.equal(typeof provider.fetchArtistIntro, 'function')
  } finally { ncmProvider.deactivate() }
})

test('native album details contain platform release text, not playback tracks or a MusicBrainz pressing', async () => {
  const provider = await activateProvider(async path => {
    assert.equal(parseRequest(path).pathname, '/album')
    return { code: 200, album: { id: 42, name: 'Album', description: '专辑正文', briefDesc: '短描述' }, songs: [song(7)] }
  }, new Map())
  try {
    const result = await provider.fetchAlbumMetadata('42')
    assert.equal(result.status, 'ok'); assert.equal(result.metadata.kind, 'release')
    assert.equal(result.metadata.texts[0].value, '专辑正文')
    assert.equal(result.metadata.texts[0].url, 'https://music.163.com/#/album?id=42')
    assert.equal(result.metadata.tracks, undefined)
  } finally { ncmProvider.deactivate() }
})

test('native release dates survive without prose or artwork and use the upstream Shanghai calendar', async () => {
  let publishTime = Date.parse('2020-05-11T16:00:00Z')
  const provider = await activateProvider(async () => ({ code: 200, album: { id: 42, name: 'Album', publishTime } }), new Map())
  try {
    for (const value of [publishTime, String(publishTime)]) {
      publishTime = value
      const result = await provider.fetchAlbumMetadata('42')
      assert.equal(result.status, 'ok')
      assert.equal(result.metadata.releaseDate.value, '2020-05-12')
      assert.equal(result.metadata.releaseDate.url, 'https://music.163.com/#/album?id=42')
      assert.deepEqual(result.metadata.texts, [])
      assert.equal(result.metadata.artwork, undefined)
    }
    publishTime = Date.parse('1965-01-01T00:00:00+08:00')
    assert.equal((await provider.fetchAlbumMetadata('42')).metadata.releaseDate.value, '1965-01-01')
    for (const value of [0, '', null, undefined, NaN, 1.5, 'invalid', 9e15]) {
      publishTime = value
      assert.deepEqual(await provider.fetchAlbumMetadata('42'), { status: 'not_provided' })
    }
  } finally { ncmProvider.deactivate() }
})

test('native metadata distinguishes absent text, missing identities, errors and mismatched response IDs', async () => {
  let data = { code: 200, album: { id: 42, name: 'Album' } }
  const provider = await activateProvider(async () => data, new Map())
  try {
    assert.deepEqual(await provider.fetchAlbumMetadata('42'), { status: 'not_provided' })
    data = { code: 404 }; assert.deepEqual(await provider.fetchAlbumMetadata('42'), { status: 'not_found' })
    data = { code: 503 }; await assert.rejects(provider.fetchAlbumMetadata('42'))
    data = { code: 200, album: { id: 43, name: 'Album', description: 'Wrong album' } }
    await assert.rejects(provider.fetchAlbumMetadata('42'), /身份不一致/)
  } finally { ncmProvider.deactivate() }
})

test('readPlaylistImportPage preserves repeated IDs and missing songs across complete pages',async()=>{
  const requests=[]
  const provider=await activateProvider(async path=>{
    requests.push(path)
    const url=parseRequest(path)
    if(url.pathname==='/playlist/detail')return {playlist:{name:'Mix',trackCount:3,trackIds:[{id:1},{id:2},{id:1}]}}
    if(url.pathname==='/song/detail')return {songs:(url.searchParams.get('ids')||'').split(',').filter(id=>id==='1').map(id=>({...song(Number(id)),al:{...song(Number(id)).al,picUrl:'https://p1.music.126.net/cover.jpg'}}))}
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })
  try{
    const first=await provider.readPlaylistImportPage('77',0,2)
    assert.equal(first.name,'Mix');assert.equal(first.total,3);assert.equal(first.hasMore,true);assert.deepEqual(first.songs.map(item=>item.platformId),['1','2'])
    assert.ok(first.songs[1].unavailableReason)
    assert.equal(first.songs[0].cover,'https://p1.music.126.net/cover.jpg')
    assert.equal(first.songs[0].coverSource,'https://p1.music.126.net/cover.jpg')
    assert.equal(first.songs[0].coverSmall,'https://p1.music.126.net/cover.jpg?param=140y140')
    const last=await provider.readPlaylistImportPage('77',2,2)
    assert.equal(last.hasMore,false);assert.equal(last.nextOffset,3);assert.equal(last.songs[0].platformId,'1')
    assert.equal(requests.filter(path=>parseRequest(path).pathname==='/playlist/detail').length,2)
  }finally{ncmProvider.deactivate()}
})

test('readPlaylistImportPage preserves occurrence IDs, unavailable songs and stable pagination',async()=>{
  const requests=[]
  const provider=await activateProvider(async path=>{
    requests.push(path)
    const url=parseRequest(path)
    if(url.pathname==='/playlist/detail')return {playlist:{name:'Mix',trackCount:3,trackIds:[{id:1},{id:2},{id:1}]}}
    if(url.pathname==='/song/detail'){
      const ids=(url.searchParams.get('ids')||'').split(',')
      return {songs:ids.filter(id=>id==='1').map(id=>song(Number(id)))}
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })
  try{
    const first=await provider.readPlaylistImportPage('77',0,2)
    assert.equal(first.name,'Mix');assert.equal(first.total,3);assert.equal(first.hasMore,true);assert.deepEqual(first.songs.map(item=>item.platformId),['1','2'])
    assert.equal(first.songs[1].unavailableReason!==undefined,true)
    const last=await provider.readPlaylistImportPage('77',2,2)
    assert.equal(last.hasMore,false);assert.equal(last.nextOffset,3);assert.equal(last.songs[0].platformId,'1')
    assert.equal(requests.filter(path=>parseRequest(path).pathname==='/playlist/detail').length,2)
  }finally{ncmProvider.deactivate()}
})

test('playlist browsing keeps returned occurrences when copyright restrictions reduce the ID list', async () => {
  const requests = []
  const provider = await activateProvider(async path => {
    const url = parseRequest(path)
    requests.push(url.pathname)
    if (url.pathname === '/playlist/detail') return { playlist: {
      name: 'Mixed rights', trackCount: 5, trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 1 }]
    } }
    if (url.pathname === '/song/detail') return { songs: [
      { ...song(2), noCopyrightRcmd: { type: 2 } }, song(1)
    ] }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })
  try {
    const first = await provider.fetchPlaylistTracksPage('77', 0, 3)
    assert.equal(first.total, 4)
    assert.equal(first.reportedTotal, 5)
    assert.deepEqual(first.tracks.map(track => track.ncmSongId), [1, 2, 3])
    assert.equal(first.tracks[0].unavailableReason, undefined)
    assert.equal(first.tracks[1].unavailableReason, '原平台版权受限')
    assert.match(first.tracks[2].unavailableReason, /缺少元数据/)
    assert.equal(first.nextOffset, 3)
    assert.equal(first.hasMore, true)
    const last = await provider.fetchPlaylistTracksPage('77', 3, 3)
    assert.deepEqual(last.tracks.map(track => track.ncmSongId), [1])
    assert.equal(last.nextOffset, 4)
    assert.equal(last.hasMore, false)
    await assert.rejects(provider.readPlaylistImportPage('77'), /不完整的条目/)
    assert.ok(requests.every(route => route === '/playlist/detail' || route === '/song/detail'))
  } finally { ncmProvider.deactivate() }
})

test('playlist pages tolerate null song details and recover omitted metadata without dropping occurrences', async () => {
  const provider = await activateProvider(async path => {
    if (parseRequest(path).pathname === '/playlist/detail') return { playlist: {
      name: 'Unavailable entries', trackCount: 4, trackIds: [1, { id: 2 }, { id: 3 }, { id: 4 }],
      tracks: [{ ...song(3), name: 'Still named in playlist' }]
    } }
    return { songs: [null, { ...song(2), ar: [null, { name: 'Artist' }], noCopyrightRcmd: {} }, song(1)],
      privileges: [{ id: 2, st: -200, pl: 0 }] }
  })
  try {
    const page = await provider.fetchPlaylistTracksPage('77')
    assert.deepEqual(page.tracks.map(track => track.ncmSongId), [1, 2, 3, 4])
    assert.equal(page.tracks[0].title, 'song-1')
    assert.equal(page.tracks[1].artist, 'Artist')
    assert.equal(page.tracks[1].unavailableReason, '原平台版权受限')
    assert.equal(page.tracks[2].title, 'Still named in playlist')
    assert.match(page.tracks[2].unavailableReason, /无权访问/)
    assert.equal(page.tracks[3].title, '未知歌曲')
    const imported = await provider.readPlaylistImportPage('77')
    assert.deepEqual(imported.songs.map(track => track.platformId), ['1', '2', '3', '4'])
    assert.equal(imported.songs[1].artist, 'Artist')
    assert.equal(imported.songs[2].title, 'Still named in playlist')
    assert.match(imported.songs[3].unavailableReason, /缺少元数据/)
  } finally { ncmProvider.deactivate() }
})

test('playlist browsing reports failed detail reads instead of presenting an empty successful page', async () => {
  let details = { code: 200, playlist: { trackCount: 1, trackIds: [{ id: 1 }] } }
  const provider = await activateProvider(async path => parseRequest(path).pathname === '/playlist/detail'
    ? details : { code: 200 })
  try {
    await assert.rejects(provider.fetchPlaylistTracksPage('77'), /歌曲详情读取中断/)
    details = { code: 200, playlist: { trackCount: 1 } }
    await assert.rejects(provider.fetchPlaylistTracksPage('77'), /权限不足/)
  } finally { ncmProvider.deactivate() }
})

test('album search is anonymous-capable and preserves totals, artist credits and cancellation', async () => {
  const controller = new AbortController()
  const provider = await activateProvider(async (path, cookie, options) => {
    const url = parseRequest(path)
    assert.equal(url.pathname, '/cloudsearch')
    assert.equal(url.searchParams.get('type'), '10')
    assert.equal(url.searchParams.get('keywords'), '范特西 & Live')
    assert.equal(url.searchParams.get('limit'), '2')
    assert.equal(url.searchParams.get('offset'), '30')
    assert.ok(!cookie)
    assert.equal(options.signal, controller.signal)
    return {
      code: 200,
      data: {
        result: {
          albumCount: 48,
          albums: [
            {
              ...album(1),
              artists: [{ name: '周杰伦' }, { name: 'Guest' }],
              picUrl: 'https://p1.music.126.net/album.jpg',
              publishTime: '1600000000000'
            },
            { ...album(2), artist: { name: 'Other artist' } }
          ]
        }
      }
    }
  }, new Map())
  try {
    const result = await provider.searchAlbums('范特西 & Live', 2, 30, {
      signal: controller.signal
    })
    assert.equal(result.total, 48)
    assert.deepEqual(
      result.items.map((item) => item.id),
      [1, 2]
    )
    assert.equal(result.items[0].artist, '周杰伦 / Guest')
    assert.equal(result.items[1].artist, 'Other artist')
    assert.equal(result.items[0].publishTime, 1600000000000)
    assert.match(result.items[0].cover, /^https:/)
    controller.abort(new Error('cancelled album request'))
    await assert.rejects(
      provider.searchAlbums('unused', 2, 30, { signal: controller.signal }),
      /cancelled/
    )
  } finally {
    ncmProvider.deactivate()
  }
})

for (const method of ['searchSongs', 'searchArtists', 'fetchArtistIntro']) {
  test(`${method} forwards active cancellation to the actual HTTP exit`, async () => {
    const controller = new AbortController()
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    const provider = await activateProvider(async (_path, _cookie, options) => {
      assert.equal(options.signal, controller.signal)
      entered()
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    })
    try {
      const invoke = () => method === 'fetchArtistIntro'
        ? provider[method](42, { signal: controller.signal })
        : provider[method]('Artist', 10, 0, { signal: controller.signal })
      const pending = invoke()
      await ready
      controller.abort(new Error('cancelled identification request'))
      await assert.rejects(pending, /cancelled identification request/)
      await assert.rejects(invoke(), /cancelled identification request/)
    } finally {
      ncmProvider.deactivate()
    }
  })
}

test('song and artist searches distinguish failed responses from an empty result', async () => {
  let response = { code: 200, result: {} }
  const provider = await activateProvider(async () => response)
  try {
    for (const method of ['searchSongs', 'searchArtists']) {
      assert.deepEqual(await provider[method]('Artist'), { items: [], total: 0 })
      response = { code: 403, message: 'not allowed' }
      await assert.rejects(provider[method]('Artist'))
      response = { code: 200, result: { songs: {}, artists: {} } }
      await assert.rejects(provider[method]('Artist'), /无效/)
      response = { code: 200, result: {} }
    }
  } finally {
    ncmProvider.deactivate()
  }
})

test('album search distinguishes empty pages from invalid or failed responses', async () => {
  let response = { code: 200, result: { albumCount: 0 } }
  const provider = await activateProvider(async () => response, new Map())
  try {
    assert.deepEqual(await provider.searchAlbums('empty'), { items: [], total: 0 })
    response = { code: 503, message: 'upstream unavailable' }
    await assert.rejects(provider.searchAlbums('failure'))
    response = { code: 200, result: { albums: 'invalid' } }
    await assert.rejects(provider.searchAlbums('malformed'), /无效的专辑搜索结果/)
    response = { code: 200 }
    await assert.rejects(provider.searchAlbums('missing result'), /无效的专辑搜索结果/)
    response = {
      code: 200,
      result: { albums: [null, { id: Infinity }, { id: -1 }, album(1)], albumCount: 1 }
    }
    assert.deepEqual(
      (await provider.searchAlbums('valid ids')).items.map((item) => item.id),
      [1]
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('album tracks can be opened after anonymous search without changing their order', async () => {
  const provider = await activateProvider(async (path, cookie) => {
    const url = parseRequest(path)
    assert.equal(url.pathname, '/album')
    assert.equal(url.searchParams.get('id'), '123')
    assert.ok(!cookie)
    return { code: 200, songs: [song(9), song(3)] }
  }, new Map())
  try {
    const tracks = await provider.fetchAlbumTracks('123')
    assert.deepEqual(
      tracks.map((track) => track.id),
      ['ncm:9', 'ncm:3']
    )
    assert.ok(tracks.every((track) => track.source === 'ncm'))
  } finally {
    ncmProvider.deactivate()
  }
})

function identityAlbumResponse() {
  return {
    code: 200,
    album: { id: 123, name: 'Album', size: 2, artists: [{ id: 7, name: 'Artist' }] },
    // Response order is deliberately different from service track ordinals.
    songs: [2, 1].map(n => ({
      id: 100 + n, name: `Song ${n}`, ar: [{ id: 7, name: 'Artist' }],
      al: { id: 123, name: 'Album' }, cd: '01', no: n, dt: 200250
    }))
  }
}

test('album identity preserves independent counts, structured credits, actual order and original precision anonymously', async () => {
  const controller = new AbortController()
  const provider = await activateProvider(async (path, cookie, options) => {
    assert.equal(parseRequest(path).pathname, '/album')
    assert.equal(parseRequest(path).searchParams.get('id'), '123')
    assert.ok(!cookie)
    assert.equal(options.signal, controller.signal)
    return identityAlbumResponse()
  }, new Map())
  try {
    const result = await provider.fetchAlbumIdentity(123, { signal: controller.signal })
    assert.equal(result.schemaVersion, 1)
    assert.equal(result.id, '123')
    assert.equal(result.provider, 'ncm')
    assert.equal(result.trackCount, 2)
    assert.equal(result.complete, true)
    assert.deepEqual(result.artists, [{ id: '7', name: 'Artist' }])
    assert.deepEqual(result.tracks.map(t => [t.id, t.disc, t.position, t.durationSeconds]),
      [['102', 1, 2, 200.25], ['101', 1, 1, 200.25]])
    assert.ok(result.tracks.every(t => !('filePath' in t) && !('streamUrl' in t)))
    assert.deepEqual((await provider.fetchAlbumTracks(123, { signal: controller.signal })).map(t => t.id), ['ncm:102', 'ncm:101'])
  } finally { ncmProvider.deactivate() }
})

for (const variant of ['unknown_count', 'conflicting_counts', 'missing_track', 'duplicate', 'wrong_track_album', 'oversize']) {
  test(`album identity ${variant} cannot claim complete retrieval`, async () => {
    const response = identityAlbumResponse()
    if (variant === 'unknown_count') delete response.album.size
    if (variant === 'conflicting_counts') response.album.songCount = 3
    if (variant === 'missing_track') response.songs.pop()
    if (variant === 'duplicate') response.songs[1] = response.songs[0]
    if (variant === 'wrong_track_album') response.songs[0].al.id = 456
    if (variant === 'oversize') {
      response.album.size = 65
      response.songs = Array.from({ length: 65 }, (_, i) => ({ ...response.songs[0], id: 200 + i, no: i + 1 }))
    }
    const provider = await activateProvider(async () => response)
    try {
      const result = await provider.fetchAlbumIdentity(123)
      assert.equal(result.complete, false)
      assert.ok(result.tracks.length <= 64)
      if (variant === 'unknown_count') assert.equal(result.trackCount, null)
    } finally { ncmProvider.deactivate() }
  })
}

test('missing album ordinals, duration and nameless credits stay unknown instead of being guessed or dropped', async () => {
  const response = identityAlbumResponse()
  delete response.songs[0].cd; delete response.songs[0].no; delete response.songs[0].dt
  response.songs[0].ar.push({ id: 8 })
  const provider = await activateProvider(async () => response)
  try {
    const result = await provider.fetchAlbumIdentity(123)
    assert.equal(result.complete, true) // retrieved, but not comparable
    assert.equal(result.tracks[0].disc, null)
    assert.equal(result.tracks[0].position, null)
    assert.equal(result.tracks[0].durationSeconds, null)
    assert.deepEqual(result.tracks[0].artists, [{ name: 'Artist', id: '7' }, { name: '', id: '8' }])
  } finally { ncmProvider.deactivate() }
})

test('malformed album responses and wrong identities are errors, not successful empty albums', async () => {
  let response
  const provider = await activateProvider(async () => response)
  try {
    for (response of [{ code: 403 }, { code: 200 }, { album: { id: 123 } },
      { ...identityAlbumResponse(), album: { id: 456 } },
      { ...identityAlbumResponse(), songs: [null] }]) {
      await assert.rejects(provider.fetchAlbumIdentity(123))
    }
    response = { code: 200, data: identityAlbumResponse() }
    assert.equal((await provider.fetchAlbumIdentity(123)).complete, true)
  } finally { ncmProvider.deactivate() }
})

test('album search marks filtered rows and unknown service totals incomplete for identity consumers', async () => {
  let response = { code: 200, result: { albums: [album(1)] } }
  const provider = await activateProvider(async () => response)
  try {
    assert.equal((await provider.searchAlbums('Album')).incomplete, true)
    response = { code: 200, result: { albums: [null, album(1)], albumCount: 1 } }
    assert.equal((await provider.searchAlbums('Album')).incomplete, true)
    response = { code: 200, result: { albums: [{ ...album(1), id: '1e3' }], albumCount: 1 } }
    assert.equal((await provider.searchAlbums('Album')).incomplete, true)
  } finally { ncmProvider.deactivate() }
})

test('album identity forwards active cancellation and rejects pre-cancelled requests', async () => {
  const controller = new AbortController()
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const provider = await activateProvider(async (_path, _cookie, options) => {
    assert.equal(options.signal, controller.signal)
    entered()
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  })
  try {
    const pending = provider.fetchAlbumIdentity(123, { signal: controller.signal })
    await ready
    controller.abort(new Error('cancel album identity'))
    await assert.rejects(pending, /cancel album identity/)
    await assert.rejects(provider.fetchAlbumIdentity(123, { signal: controller.signal }), /cancel album identity/)
  } finally { ncmProvider.deactivate() }
})

test('public toplists normalize previews, exclude invalid entries and cache until refreshed', async () => {
  let calls = 0
  const provider = await activateProvider(async (path, cookie) => {
    assert.equal(parseRequest(path).pathname, '/toplist/detail')
    assert.ok(!cookie)
    calls += 1
    return {
      code: 200,
      list: [
        {
          id: 19723756,
          name: '飙升榜',
          coverImgUrl: 'https://p1.music.126.net/chart.jpg',
          trackCount: 100,
          updateFrequency: '每天更新',
          updateTime: 1700000000000,
          tracks: [{ first: `歌曲 ${calls}`, second: '歌手' }, null]
        },
        { id: 19723756, name: '重复榜单' },
        { id: -1, name: '无效榜单' },
        { id: 8, name: 123 },
        null,
        { id: 42, name: '特色榜', tracks: [{ name: '另一首歌' }] }
      ]
    }
  }, new Map())
  try {
    const charts = await provider.fetchToplists()
    assert.equal(charts.length, 2)
    assert.equal(charts[0].featured, true)
    assert.equal(charts[0].updateFrequency, '每天更新')
    assert.equal(charts[0].updatedAt, 1700000000000)
    assert.ok(charts[0].cover.includes('chart.jpg'))
    assert.deepEqual(charts[0].previewTracks, [{ title: '歌曲 1', artist: '歌手' }])
    assert.deepEqual(charts[1].previewTracks, [{ title: '另一首歌', artist: '' }])
    assert.equal(await provider.fetchToplists(), charts)
    assert.equal(calls, 1)
    assert.equal((await provider.fetchToplists(true))[0].previewTracks[0].title, '歌曲 2')
    assert.equal(calls, 2)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      provider.fetchToplists(false, { signal: controller.signal }),
      /abort|cancel/i
    )
    assert.equal(calls, 2)
  } finally {
    ncmProvider.deactivate()
  }
})

test('malformed toplist responses are recoverable and are never cached as an empty success', async () => {
  let invalid = true
  const provider = await activateProvider(
    async () =>
      invalid
        ? { code: 200 }
        : { code: 200, data: { list: [{ id: 1, name: '榜单', tracks: [] }] } },
    new Map()
  )
  try {
    await assert.rejects(provider.fetchToplists(), /数据不完整/)
    invalid = false
    assert.equal((await provider.fetchToplists())[0].name, '榜单')
  } finally {
    ncmProvider.deactivate()
  }
})

test('login checks preserve credentials across failures and provider restarts', async () => {
  const settings = new Map([['cookie', 'MUSIC_U=restart-test;']])
  const failures = [
    { code: 502 },
    { code: 503 },
    { code: 460 },
    { code: 200 },
    {},
    { code: -1, message: 'connection unavailable' }
  ]
  try {
    for (const response of failures) {
      const provider = await activateProvider(async () => response, settings)
      await assert.rejects(provider.checkLogin())
      assert.equal(settings.get('cookie'), 'MUSIC_U=restart-test;')
      ncmProvider.deactivate()
    }
    for (const response of [{ code: 301 }, { data: { code: 200, profile: null } }]) {
      const provider = await activateProvider(async () => response, settings)
      assert.deepEqual(await provider.checkLogin(), { loggedIn: false, profile: null })
      assert.equal(settings.get('cookie'), 'MUSIC_U=restart-test;')
      ncmProvider.deactivate()
    }
    const provider = await activateProvider(async (path, cookie) => {
      assert.equal(cookie, 'MUSIC_U=restart-test;')
      if (path.startsWith('/login/status')) {
        return {
          data: {
            code: 200,
            profile: { userId: 42, nickname: 'restored', avatarUrl: '' }
          }
        }
      }
      return { code: 200 }
    }, settings)
    assert.equal((await provider.checkLogin()).loggedIn, true)
    await provider.logout()
    assert.equal(settings.has('cookie'), false)
    ncmProvider.deactivate()
    const signedOut = await activateProvider(
      async () => assert.fail('no cookie after logout'),
      settings
    )
    assert.deepEqual(await signedOut.checkLogin(), { loggedIn: false, profile: null })
  } finally {
    ncmProvider.deactivate()
  }
})

test('personal FM requests a 30-track roaming batch', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/personal/fm/mode')
    assert.equal(url.searchParams.get('mode'), 'DEFAULT')
    assert.equal(url.searchParams.get('limit'), '30')
    return { data: Array.from({ length: 30 }, (_, index) => song(index + 1)) }
  })

  try {
    const tracks = await provider.fetchPersonalFm()
    assert.equal(tracks.length, 30)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      Array.from({ length: 30 }, (_, index) => index + 1)
    )
    assert.equal(requests.length, 1)
  } finally {
    ncmProvider.deactivate()
  }
})

test('tracks carry provider artist ids aligned with the display string', async () => {
  const provider = await activateProvider(async (path) => {
    assert.equal(parseRequest(path).pathname, '/personal/fm/mode')
    return {
      data: [
        {
          id: 501,
          name: 'duet',
          ar: [
            { id: 9001, name: '沙包--' },
            { id: 9002, name: 'Om Chincholkar' }
          ],
          al: { name: 'album-501', picUrl: null },
          dt: 180000
        },
        {
          id: 502,
          name: 'legacy payload',
          artists: [{ id: 9003, name: '在你怀里的桃花' }],
          artist: '在你怀里的桃花（遗留字符串）',
          al: { name: 'album-502', picUrl: null },
          dt: 180000
        },
        {
          id: 503,
          name: 'partial ids',
          ar: [{ name: '无 id 歌手' }, { id: 9004, name: '有 id 歌手' }],
          al: { name: 'album-503', picUrl: null },
          dt: 180000
        },
        {
          id: 504,
          name: 'string artist only',
          artist: '只有字符串',
          al: { name: 'album-504', picUrl: null },
          dt: 180000
        },
        // 补满一个漫游批次，避免落到经典 FM 回退路径上。
        ...Array.from({ length: 26 }, (_, index) => song(600 + index))
      ]
    }
  })

  try {
    const tracks = await provider.fetchPersonalFm()

    // 展示串由 artists 拼出，两者同源同序：首位名字必定对应 artists[0]。
    assert.equal(tracks[0].artist, '沙包-- / Om Chincholkar')
    assert.deepEqual(tracks[0].artists, [
      { id: 9001, name: '沙包--' },
      { id: 9002, name: 'Om Chincholkar' }
    ])

    // 老接口的 artists 数组也带 id，优先于拿不到 id 的 artist 字符串。
    assert.equal(tracks[1].artist, '在你怀里的桃花')
    assert.deepEqual(tracks[1].artists, [{ id: 9003, name: '在你怀里的桃花' }])

    // 缺 id 的条目保留占位，否则第二位歌手会顶到首位、把 id 配错人。
    assert.equal(tracks[2].artist, '无 id 歌手 / 有 id 歌手')
    assert.deepEqual(tracks[2].artists, [{ name: '无 id 歌手' }, { id: 9004, name: '有 id 歌手' }])

    // 完全没有结构化歌手时不写 artists 键，歌手页跳转自然回退到名字搜索。
    assert.equal(tracks[3].artist, '只有字符串')
    assert.equal('artists' in tracks[3], false)
  } finally {
    ncmProvider.deactivate()
  }
})

test('upstream requests are rate limited by a global token bucket', async () => {
  const requestTimes = []
  const provider = await activateProvider(async (path) => {
    requestTimes.push(Date.now())
    const url = parseRequest(path)
    assert.equal(url.pathname, '/cloudsearch')
    return { result: { songs: [], songCount: 0 } }
  })

  try {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const pending = Promise.all(
      Array.from({ length: 6 }, (_, index) => provider.searchSongs(`k${index}`))
    )
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requestTimes.length, 5, 'burst capacity admits five requests immediately')
    mock.timers.tick(200)
    await pending
    assert.equal(requestTimes.length, 6)
    const origin = requestTimes[0]
    assert.deepEqual(
      requestTimes.map((time) => time - origin),
      [0, 0, 0, 0, 0, 200],
      'the sixth request must wait one 200ms refill step'
    )
  } finally {
    mock.timers.reset()
    ncmProvider.deactivate()
  }
})

test('token bucket survives a system clock rollback without wedging requests', async () => {
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    assert.equal(url.pathname, '/cloudsearch')
    return { result: { songs: [], songCount: 0 } }
  })

  try {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    // 先消耗空突发容量，再把时钟回拨到过去：回拨后第一个请求必须仍能通过
    // （原地重置回灌基准），而不是等一个永远到不了的回灌窗口。
    mock.timers.setTime(1_000_000)
    await Promise.all(Array.from({ length: 5 }, (_, index) => provider.searchSongs(`a${index}`)))
    mock.timers.setTime(500_000)
    const secondWave = Promise.all(
      Array.from({ length: 5 }, (_, index) => provider.searchSongs(`b${index}`))
    )
    // tick 是同步推进：先排空 microtask，让第二波请求的等待计时器完成登记。
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    // 回拨不凭空增发令牌：第二波按 ~200ms/个 的正常速率放行。
    mock.timers.tick(1_000)
    await secondWave
    mock.timers.tick(200)
    const thirdRequest = provider.searchSongs('c')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(200)
    await thirdRequest
  } finally {
    mock.timers.reset()
    ncmProvider.deactivate()
  }
})

test('personal FM returns fresh session tracks across repeated roaming requests', async () => {
  let requestNumber = 0
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/personal/fm/mode') {
      requestNumber += 1
      const start = (requestNumber - 1) * 30 + 1
      return { data: Array.from({ length: 30 }, (_, index) => song(start + index)) }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const first = await provider.fetchPersonalFm()
    const second = await provider.fetchPersonalFm()
    assert.equal(first.length, 30)
    assert.equal(second.length, 30)
    assert.deepEqual(
      second.map((track) => track.ncmSongId),
      Array.from({ length: 30 }, (_, index) => index + 31)
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('personal FM fills a short roaming response with deduplicated classic batches', async () => {
  const requests = []
  let classicBatch = 0
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/personal/fm/mode') {
      return { data: [song(1), song(2), song(3)] }
    }
    if (url.pathname === '/personal_fm') {
      classicBatch += 1
      const start = classicBatch * 3 + 1
      return { data: [song(start - 1), song(start), song(start + 1)] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchPersonalFm()
    assert.equal(tracks.length, 30)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      Array.from({ length: 30 }, (_, index) => index + 1)
    )
    assert.equal(
      requests.filter((path) => parseRequest(path).pathname === '/personal_fm').length,
      10
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('private radar resolves the personalized radar playlist instead of private-content entries', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/playlist/track/all')
    assert.equal(url.searchParams.get('id'), '3136952023')
    assert.equal(url.searchParams.get('offset'), '0')
    return { songs: [song(101), song(102), song(103), song(104)] }
  })

  try {
    const tracks = await provider.fetchPrivateContent()
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      [101, 102, 103, 104]
    )
    assert.equal(
      requests.some((path) => parseRequest(path).pathname === '/personalized/privatecontent'),
      false
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('level-based playback uses eapi without needing an xeapi key or the classic URL endpoint', async () => {
  const requests = []
  const provider = await activateProvider(async (path, cookie) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(cookie, 'MUSIC_U=test;')
    if (url.pathname !== '/song/url/v1' || url.searchParams.get('crypto') !== 'eapi') {
      return { code: 404, msg: 'xeapi public key is missing', data: null }
    }
    return {
      code: 200,
      data: [{ id: 76, url: 'https://music.example/76.flac', code: 200 }]
    }
  })

  try {
    for (const quality of ['auto', 'hires', 'lossless', 'exhigh', 'standard']) {
      assert.equal(
        await provider.getPlaybackUrl({ id: 'ncm:76' }, { quality, force: true }),
        'https://music.example/76.flac'
      )
    }
    assert.equal(requests.length, 5)
    assert.deepEqual(
      requests.map((path) => parseRequest(path).searchParams.get('level')),
      ['hires', 'hires', 'lossless', 'exhigh', 'standard']
    )
    assert.ok(
      requests.every((path) => parseRequest(path).searchParams.get('encodeType') === 'flac')
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('playback quality falls back only through official lower compatible levels', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/song/url/v1')
    assert.equal(url.searchParams.get('encodeType'), 'flac')
    assert.equal(url.searchParams.get('crypto'), 'eapi')
    if (url.searchParams.get('level') === 'lossless') {
      return {
        code: 200,
        data: [{ id: 77, url: null, code: 404, fee: 1, msg: 'VIP quality unavailable' }]
      }
    }
    if (url.searchParams.get('level') === 'exhigh') {
      return {
        code: 200,
        data: [{ id: 77, url: 'https://music.example/77.mp3', code: 200, level: 'exhigh' }]
      }
    }
    throw new Error(`unexpected quality: ${url.searchParams.get('level')}`)
  })

  try {
    assert.equal(
      await provider.getPlaybackUrl({ id: 'ncm:77' }, { quality: 'lossless' }),
      'https://music.example/77.mp3'
    )
    assert.deepEqual(
      requests.map((path) => parseRequest(path).searchParams.get('level')),
      ['lossless', 'exhigh']
    )
    assert.ok(requests.every((path) => !path.includes('unblock=')))
  } finally {
    ncmProvider.deactivate()
  }
})

test('automatic quality falls back through Hi-Res, lossless, extreme, and standard only', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname !== '/song/url/v1') {
      throw new Error(`unexpected path: ${url.pathname}`)
    }
    const level = url.searchParams.get('level')
    if (level === 'exhigh') {
      return { code: 200, data: [{ id: 78, url: 'https://music.example/78.mp3', code: 200 }] }
    }
    return { code: 200, data: [{ id: 78, url: null, code: 404, msg: 'unavailable' }] }
  })

  try {
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:78' }), 'https://music.example/78.mp3')
    assert.deepEqual(
      requests.map((path) => parseRequest(path).searchParams.get('level')),
      ['hires', 'lossless', 'exhigh']
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('premium-only tracks return no URL when official and unlock fallbacks are unavailable', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/song/url/match') {
      return { code: 500, msg: 'no matching source', data: [] }
    }
    return {
      code: 200,
      data: [{ id: 79, url: null, code: 404, fee: 1, msg: 'VIP only' }]
    }
  })

  try {
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:79' }, { quality: 'hires' }), null)
    assert.deepEqual(
      requests.map((path) => {
        const url = parseRequest(path)
        if (url.pathname === '/song/url/v1') return `v1:${url.searchParams.get('level')}`
        if (url.pathname === '/song/url/match') return `match:${url.searchParams.get('id')}`
        return `br:${url.searchParams.get('br')}`
      }),
      [
        'v1:hires',
        'v1:lossless',
        'v1:exhigh',
        'v1:standard',
        'br:999000',
        'br:320000',
        'br:128000',
        'match:79'
      ]
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('gray tracks use song URL matching only after every official endpoint fails', async () => {
  const requests = []
  const cachedSongs = []
  const provider = await activateProvider(
    async (path) => {
      requests.push(path)
      const url = parseRequest(path)
      if (url.pathname === '/song/url/match') {
        assert.equal(url.searchParams.get('id'), '82')
        assert.equal(url.searchParams.get('source'), null)
        return { code: 200, data: 'https://unblock.example/82.flac', proxyUrl: '' }
      }
      return {
        code: 200,
        data: [{ id: 82, url: null, code: 404, fee: 1, msg: 'copyright unavailable' }]
      }
    },
    undefined,
    {
      ncm: {
        cacheSong: async (songId, url, fileName) => {
          cachedSongs.push({ songId, url, fileName })
          return null
        }
      }
    }
  )

  try {
    const track = { id: 'ncm:82', fileName: 'gray-track.flac' }
    assert.equal(
      await provider.getPlaybackUrl(track, { quality: 'standard' }),
      'https://unblock.example/82.flac'
    )
    assert.deepEqual(
      requests.map((path) => parseRequest(path).pathname),
      ['/song/url/v1', '/song/url', '/song/url', '/song/url', '/song/url/match']
    )
    assert.deepEqual(cachedSongs, [
      { songId: 82, url: 'https://unblock.example/82.flac', fileName: 'gray-track.flac' }
    ])

    assert.equal(
      await provider.getPlaybackUrl(track, { quality: 'standard' }),
      'https://unblock.example/82.flac'
    )
    assert.equal(requests.length, 5)
    assert.equal(cachedSongs.length, 1)
  } finally {
    ncmProvider.deactivate()
  }
})

test('gray track fallback rejects successful responses without a valid HTTP URL', async () => {
  const warnings = []
  const provider = await activateProvider(
    async (path) => {
      const url = parseRequest(path)
      if (url.pathname === '/song/url/match') {
        return { code: 200, data: [], proxyUrl: 'javascript:alert(1)' }
      }
      return { code: 200, data: [{ id: 83, url: null, code: 404, msg: 'unavailable' }] }
    },
    undefined,
    { logger: { warn: (message) => warnings.push(message) } }
  )

  try {
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:83' }, { quality: 'standard' }), null)
    assert.ok(
      warnings.some((message) => message.includes('灰色歌曲解锁响应缺少有效的 HTTP(S) URL'))
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('gray track fallback preserves unlock request failures in diagnostic logs', async () => {
  const warnings = []
  const provider = await activateProvider(
    async (path) => {
      const url = parseRequest(path)
      if (url.pathname === '/song/url/match') throw new Error('unblock upstream failed')
      return { code: 200, data: [{ id: 84, url: null, code: 404, msg: 'unavailable' }] }
    },
    undefined,
    { logger: { warn: (message) => warnings.push(message) } }
  )

  try {
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:84' }, { quality: 'standard' }), null)
    assert.ok(warnings.some((message) => message.includes('unblock upstream failed')))
  } finally {
    ncmProvider.deactivate()
  }
})

test('playback cancellation stops official fallback before gray track matching', async () => {
  const controller = new AbortController()
  const requests = []
  const provider = await activateProvider(async (path, _cookie, options) => {
    requests.push(path)
    assert.strictEqual(options.signal, controller.signal)
    controller.abort(new Error('playback cancelled'))
    return { code: 200, data: [{ id: 85, url: null, code: 404 }] }
  })

  try {
    await assert.rejects(
      () =>
        provider.getPlaybackUrl(
          { id: 'ncm:85' },
          { quality: 'standard' },
          { signal: controller.signal }
        ),
      /playback cancelled/
    )
    assert.equal(requests.length, 1)
    assert.equal(parseRequest(requests[0]).pathname, '/song/url/v1')
  } finally {
    ncmProvider.deactivate()
  }
})

test('classic bitrate endpoint is used when level-based player API has no URL', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/song/url/v1') {
      return { code: 200, data: [{ id: 80, url: null, code: 404, msg: 'level unavailable' }] }
    }
    if (url.pathname === '/song/url' && url.searchParams.get('br') === '320000') {
      return {
        code: 200,
        data: [{ id: 80, url: '//m701.music.126.net/song.mp3', br: 320000 }]
      }
    }
    return { code: 200, data: [{ id: 80, url: null, code: 404 }] }
  })

  try {
    assert.equal(
      await provider.getPlaybackUrl({ id: 'ncm:80' }, { quality: 'standard' }),
      'https://m701.music.126.net/song.mp3'
    )
    assert.ok(requests.some((path) => path.startsWith('/song/url?')))
    assert.ok(requests.some((path) => path.includes('br=320000')))
  } finally {
    ncmProvider.deactivate()
  }
})

test('protocol-relative stream URLs are normalized to https', async () => {
  const provider = await activateProvider(async () => ({
    code: 200,
    data: [{ id: 81, url: '//m801.music.126.net/track.flac', code: 200, level: 'hires' }]
  }))

  try {
    assert.equal(
      await provider.getPlaybackUrl({ id: 'ncm:81' }, { quality: 'hires' }),
      'https://m801.music.126.net/track.flac'
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('revalidates legacy disk cache through the current account before playback', async () => {
  const cachedPath = 'D:\\Cache\\ncm-cache\\90.flac'
  let networkCalls = 0
  let registeredProvider = null
  await ncmProvider.activate({
    twilight: {
      internal: {
        ncm: {
          request: async () => {
            networkCalls += 1
            return {
              code: 200,
              data: [{ id: 90, url: 'https://music.example/90.flac', br: 999000 }]
            }
          },
          officialLogin: async () => 'MUSIC_U=test;',
          getCachedSong: async (songId) => (Number(songId) === 90 ? cachedPath : null),
          cacheSong: async () => null
        }
      },
      providers: {
        register: async (provider) => {
          registeredProvider = provider
        }
      }
    },
    settings: {
      get: async (key) =>
        key == null ? { cookie: 'MUSIC_U=test;' } : key === 'cookie' ? 'MUSIC_U=test;' : undefined,
      set: async () => undefined,
      delete: async () => undefined
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
  })
  assert.ok(registeredProvider)

  try {
    assert.equal(
      await registeredProvider.getPlaybackUrl({ id: 'ncm:90' }),
      'https://music.example/90.flac'
    )
    assert.equal(networkCalls, 1)
    assert.equal(
      await registeredProvider.getPlaybackUrl({ id: 'ncm:90' }, { force: true }),
      'https://music.example/90.flac'
    )
    assert.equal(networkCalls, 2)
  } finally {
    ncmProvider.deactivate()
  }
})

test('a memory-cached disk path is revalidated after the managed cache is cleared', async () => {
  const cachedPath = 'D:\\Cache\\ncm-cache\\190.flac'
  let present = true,
    networkCalls = 0
  const provider = await activateProvider(
    async () => {
      networkCalls++
      return {
        code: 200,
        data: [{ id: 190, url: `https://music.example/190.flac?v=${networkCalls}`, code: 200 }]
      }
    },
    undefined,
    {
      ncm: {
        getCachedSong: async () => (present ? cachedPath : null),
        cacheSong: async () => (present ? cachedPath : null)
      }
    }
  )
  try {
    await provider.getPlaybackUrl({ id: 'ncm:190' })
    await new Promise(setImmediate)
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:190' }), cachedPath)
    present = false
    assert.equal(
      await provider.getPlaybackUrl({ id: 'ncm:190' }),
      'https://music.example/190.flac?v=1'
    )
    assert.equal(networkCalls, 1, 'the still-fresh account-authorized URL survives cache removal')
  } finally {
    ncmProvider.deactivate()
  }
})

test('internal playback identity preserves actual fallback quality and origin across cache reuse', async () => {
  const cachedPath = 'D:/cache/991.verified.mp3'
  const provider = await activateProvider(
    async () => ({
      code: 200,
      data: [
        {
          id: 991,
          url: 'https://music.example/991.mp3',
          level: 'standard',
          type: 'mp3',
          br: 128000,
          sr: 44100,
          size: 800000,
          expi: 60,
          code: 200
        }
      ]
    }),
    undefined,
    {
      ncm: {
        cacheSong: async () => cachedPath,
        getCachedSong: async () => cachedPath
      }
    }
  )
  try {
    const first = await provider.getPlaybackUrl(
      { id: 'ncm:991' },
      { quality: 'hires', _twilightSourceIdentity: true }
    )
    assert.equal(first.streamUrl, 'https://music.example/991.mp3')
    assert.equal(first.providerSource.actualQuality, 'standard')
    assert.equal(first.providerSource.sampleRate, 44100)
    assert.ok(first.providerSource.expiresAt <= Date.now() + 60000)
    await new Promise(setImmediate)
    const second = await provider.getPlaybackUrl(
      { id: 'ncm:991' },
      { quality: 'hires', _twilightSourceIdentity: true }
    )
    assert.equal(second.streamUrl, cachedPath)
    assert.deepEqual(second.providerSource, first.providerSource)
  } finally {
    ncmProvider.deactivate()
  }
})

test('fresh AutoMix playback resolves to the completed authorized cache with actual quality', async () => {
  const cachedPath = 'D:/cache/新歌.verified.flac'
  let preparations = 0,
    regularWrites = 0
  const provider = await activateProvider(
    async () => ({
      code: 200,
      data: [
        {
          url: 'https://music.example/new.flac',
          level: 'standard',
          size: 4096,
          expi: 60
        }
      ]
    }),
    undefined,
    {
      ncm: {
        cacheSong: async () => {
          regularWrites++
          return null
        },
        getCachedSong: async () => cachedPath,
        prepareAutoMixSong: async (id, url, _fileName, metadata) => {
          preparations++
          assert.equal(id, 992)
          assert.equal(url, 'https://music.example/new.flac')
          assert.equal(metadata.expectedBytes, 4096)
          assert.ok(metadata.expiresAt <= Date.now() + 60_000)
          return cachedPath
        }
      }
    }
  )
  try {
    const options = {
      quality: 'hires',
      _twilightSourceIdentity: true,
      _twilightAutoMixPrepare: true
    }
    const first = await provider.getPlaybackUrl({ id: 'ncm:992' }, options)
    assert.equal(first.streamUrl, cachedPath)
    assert.equal(first.providerSource.actualQuality, 'standard')
    assert.equal(first.providerSource.originSource, 'https://music.example/new.flac')
    assert.deepEqual(await provider.getPlaybackUrl({ id: 'ncm:992' }, options), first)
    assert.equal(preparations, 1)
    assert.equal(regularWrites, 0)
  } finally {
    ncmProvider.deactivate()
  }
})

test('AutoMix cache timeout and disabled cache retain the authorized URL without quality retries', async () => {
  for (const failure of [null, new Error('timeout')]) {
    let requests = 0
    const provider = await activateProvider(
      async () => {
        requests++
        return { code: 200, data: [{ url: 'https://music.example/new.mp3', level: 'standard' }] }
      },
      undefined,
      {
        ncm: {
          prepareAutoMixSong: async () => {
            if (failure) throw failure
            return null
          }
        }
      }
    )
    try {
      const result = await provider.getPlaybackUrl(
        { id: 'ncm:992' },
        {
          quality: 'hires',
          _twilightSourceIdentity: true,
          _twilightAutoMixPrepare: true
        }
      )
      assert.equal(result.streamUrl, 'https://music.example/new.mp3')
      assert.equal(result.providerSource.actualQuality, 'standard')
      assert.equal(requests, 1)
    } finally {
      ncmProvider.deactivate()
    }
  }
})

test('playback URL memory cache expires after its TTL and re-resolves', async () => {
  let requestNumber = 0
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/song/url/v1') {
      requestNumber += 1
      return {
        code: 200,
        data: [{ id: 91, url: `https://music.example/91.flac?v=${requestNumber}`, code: 200 }]
      }
    }
    throw new Error(`unexpected path: ${url.pathname}`)
  })

  try {
    mock.timers.enable({ apis: ['Date'] })
    const first = await provider.getPlaybackUrl({ id: 'ncm:91' }, { quality: 'standard' })
    const second = await provider.getPlaybackUrl({ id: 'ncm:91' }, { quality: 'standard' })
    assert.equal(requestNumber, 1, 'a fresh cache entry must be reused')
    assert.equal(second, first)

    mock.timers.tick(21 * 60_000)
    const third = await provider.getPlaybackUrl({ id: 'ncm:91' }, { quality: 'standard' })
    assert.equal(requestNumber, 2, 'an expired cache entry must trigger a fresh resolve')
    assert.notEqual(third, first)
  } finally {
    mock.timers.reset()
    ncmProvider.deactivate()
  }
})

for (const cacheState of ['removed', 'replaced', 'lookup-failed']) {
  test(`playback resumes online when a downloaded cache file is ${cacheState}`, async () => {
    const cachedPath = 'D:\\Cache\\ncm-cache\\93.current.flac'
    const streamUrl = 'https://music.example/93.flac'
    let diskPath = cachedPath
    let lookupFailed = false
    let requests = 0
    const provider = await activateProvider(
      async () => {
        requests += 1
        return { code: 200, data: [{ id: 93, url: streamUrl, code: 200 }] }
      },
      undefined,
      {
        ncm: {
          cacheSong: async () => cachedPath,
          getCachedSong: async () => {
            if (lookupFailed) throw new Error('cache unavailable')
            return diskPath
          }
        }
      }
    )

    try {
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:93' }), streamUrl)
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:93' }), cachedPath)
      diskPath = cacheState === 'replaced' ? 'D:\\Cache\\ncm-cache\\93.other.flac' : null
      lookupFailed = cacheState === 'lookup-failed'
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:93' }), streamUrl)
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:93' }), streamUrl)
      assert.equal(requests, 1, 'a still-valid stream does not need a new account request')
    } finally {
      ncmProvider.deactivate()
    }
  })
}

test('playback fallback ladder backs off between steps instead of bursting', async () => {
  const requestTimes = []
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname !== '/song/url/v1') throw new Error(`unexpected path: ${url.pathname}`)
    requestTimes.push(Date.now())
    const level = url.searchParams.get('level')
    if (level === 'exhigh') {
      return {
        code: 200,
        data: [{ id: 92, url: 'https://music.example/92.mp3', code: 200, level: 'exhigh' }]
      }
    }
    return { code: 200, data: [{ id: 92, url: null, code: 404, msg: 'unavailable' }] }
  })

  try {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    const pending = provider.getPlaybackUrl({ id: 'ncm:92' }, { quality: 'hires' })
    // 第一级请求立即发出（无前缀等待）。
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requestTimes.length, 1)
    mock.timers.tick(250)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requestTimes.length, 2)
    mock.timers.tick(500)
    assert.equal(await pending, 'https://music.example/92.mp3')
    assert.deepEqual(
      requestTimes.slice(1).map((time, index) => time - requestTimes[index]),
      [250, 500],
      'fallback steps must be spaced by a 250→500ms backoff'
    )
  } finally {
    mock.timers.reset()
    ncmProvider.deactivate()
  }
})

test('risk control messages stop the whole playback fallback ladder early', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    return {
      code: 200,
      data: [{ id: 93, url: null, code: 460, msg: '操作已拦截，存在安全风险' }]
    }
  })

  try {
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:93' }, { quality: 'hires' }), null)
    assert.deepEqual(
      requests.map((path) => parseRequest(path).pathname),
      ['/song/url/v1'],
      'a risk-control response must stop both the level ladder and the gray-track match'
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('artist songs keep paging when a short page reports more items', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/artist/songs')
    assert.equal(url.searchParams.get('id'), '6452')
    assert.equal(url.searchParams.get('order'), 'hot')
    assert.equal(url.searchParams.get('limit'), '100')

    const offset = Number(url.searchParams.get('offset'))
    if (offset === 0) return { songs: [song(1), song(2)], more: true }
    if (offset === 2) return { songs: [song(3)], more: false }
    throw new Error(`unexpected offset: ${offset}`)
  })

  try {
    const tracks = await provider.fetchArtistTopSongs(6452)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      [1, 2, 3]
    )
    assert.equal(requests.length, 2)
    assert.equal(parseRequest(requests[1]).searchParams.get('offset'), '2')
  } finally {
    ncmProvider.deactivate()
  }
})

test('search song normalization preserves tempo and artist/album navigation identities', async () => {
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    assert.equal(url.pathname, '/cloudsearch')
    return {
      result: {
        songs: [
          {
            ...song(128),
            bpm: '128.4',
            ar: [
              { id: 11, name: 'First Artist' },
              { id: 22, name: 'Guest Artist' }
            ],
            al: { id: 456, name: 'Search Album' }
          }
        ],
        songCount: 1
      }
    }
  })

  try {
    const result = await provider.searchSongs('tempo')
    assert.equal(result.items[0].bpm, 128.4)
    assert.equal(result.items[0].source, 'ncm')
    assert.equal(result.items[0].artist, 'First Artist / Guest Artist')
    assert.deepEqual(result.items[0].artists, [
      { id: 11, name: 'First Artist' },
      { id: 22, name: 'Guest Artist' }
    ])
    assert.equal(result.items[0].albumId, '456')
    assert.equal(result.items[0].album, 'Search Album')
  } finally {
    ncmProvider.deactivate()
  }
})

test('cloud songs page preserves separate cloud and playback song identifiers', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    return {
      count: 3,
      hasMore: true,
      data: [
        {
          songId: 'cloud-9001',
          songName: 'cloud title',
          fileName: 'original-file.flac',
          fileSize: 123456,
          bitrate: 999000,
          addTime: 1720000000000,
          simpleSong: {
            ...song(81),
            ar: [{ name: 'cloud artist' }],
            al: { name: 'cloud album', picUrl: '//img.example/81.jpg' }
          }
        }
      ]
    }
  })

  try {
    const page = await provider.fetchCloudSongsPage(50, 1)
    const request = parseRequest(requests[0])
    assert.equal(request.pathname, '/user/cloud')
    assert.equal(request.searchParams.get('offset'), '50')
    assert.equal(request.searchParams.get('limit'), '1')
    assert.equal(page.total, 3)
    assert.equal(page.hasMore, true)
    assert.equal(page.nextOffset, 51)
    assert.equal(page.items[0].cloudSongId, 'cloud-9001')
    assert.equal(page.items[0].songId, 81)
    assert.equal(page.items[0].fileName, 'original-file.flac')
    assert.equal(page.items[0].track.id, 'ncm:81')
    assert.equal(page.items[0].track.filePath, 'ncm:81')
    assert.equal(page.items[0].track.cover, 'https://img.example/81.jpg')
    assert.equal(page.items[0].track.size, 123456)
    assert.equal(page.items[0].track.format, 'flac')
  } finally {
    ncmProvider.deactivate()
  }
})

test('cloud provider operations require an existing login cookie', async () => {
  const provider = await activateProvider(async () => {
    throw new Error('request should not run')
  }, new Map())

  try {
    await assert.rejects(() => provider.fetchCloudSongsPage(), /请先登录网易云音乐/)
    await assert.rejects(
      () =>
        provider.prepareCloudUpload({
          md5: '0123456789abcdef0123456789abcdef',
          fileSize: 1024,
          filename: 'test.flac'
        }),
      /请先登录网易云音乐/
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('cloud upload protocol validates and forwards documented token and completion fields', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/cloud/upload/token') {
      return {
        code: 200,
        data: {
          needUpload: true,
          songId: 9002,
          uploadToken: 'upload-token',
          uploadUrl: '//nos.example/upload/object',
          resourceId: 'resource-9002',
          md5: url.searchParams.get('md5'),
          fileSize: Number(url.searchParams.get('fileSize')),
          filename: url.searchParams.get('filename')
        }
      }
    }
    if (url.pathname === '/cloud/upload/complete') return { code: 200 }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const input = {
      md5: '0123456789abcdef0123456789abcdef',
      fileSize: 4096,
      filename: '测试 音乐.flac',
      bitrate: 960000
    }
    const preparation = await provider.prepareCloudUpload(input)
    assert.equal(preparation.uploadUrl, 'https://nos.example/upload/object')
    assert.equal(preparation.uploadToken, 'upload-token')
    assert.equal(preparation.resourceId, 'resource-9002')
    const tokenRequest = parseRequest(requests[0])
    assert.equal(tokenRequest.searchParams.get('filename'), input.filename)
    assert.equal(tokenRequest.searchParams.get('bitrate'), '960000')

    const completion = {
      songId: preparation.songId,
      resourceId: preparation.resourceId,
      md5: input.md5,
      filename: input.filename,
      song: '测试音乐',
      artist: '测试歌手',
      album: '测试专辑',
      bitrate: 960000
    }
    const requestContext = {
      signal: new AbortController().signal,
      idempotencyKey: 'cloud-complete-9002'
    }
    await provider.completeCloudUpload(completion, requestContext)
    await provider.completeCloudUpload(completion, requestContext)
    const completeRequest = parseRequest(requests[1])
    assert.equal(completeRequest.pathname, '/cloud/upload/complete')
    assert.equal(completeRequest.searchParams.get('songId'), '9002')
    assert.equal(completeRequest.searchParams.get('resourceId'), 'resource-9002')
    assert.equal(completeRequest.searchParams.get('song'), '测试音乐')
    assert.equal(requests.length, 2)
  } finally {
    ncmProvider.deactivate()
  }
})

test('cloud download accepts documented URL shapes and rejects malformed responses', async () => {
  let response = { code: 200, data: { url: '//download.example/song.flac' } }
  const provider = await activateProvider(async (path) => {
    assert.equal(parseRequest(path).pathname, '/song/cloud/download')
    return response
  })

  try {
    assert.equal(
      await provider.getCloudDownloadUrl('cloud-77'),
      'https://download.example/song.flac'
    )
    response = { code: 200, data: { downloadUrl: 'https://unverified.example/song.flac' } }
    await assert.rejects(
      () => provider.getCloudDownloadUrl('cloud-77'),
      /下载响应缺少有效的 HTTP\(S\) URL/
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('liked tracks fall back to playlist detail when playlist track-all is malformed', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: {
            userId: 42,
            nickname: 'listener',
            avatarUrl: 'avatar.jpg',
            signature: ''
          }
        }
      }
    }
    if (url.pathname === '/user/playlist') {
      return {
        playlist: [
          {
            id: 9001,
            name: '喜欢的音乐',
            specialType: 5,
            trackCount: 2,
            coverImgUrl: 'cover.jpg'
          }
        ]
      }
    }
    if (url.pathname === '/playlist/track/all') {
      throw new Error('Unexpected non-whitespace character after JSON at position 25')
    }
    if (url.pathname === '/playlist/detail') {
      return { playlist: { trackIds: [{ id: 1 }, { id: 2 }] } }
    }
    if (url.pathname === '/song/detail') {
      return { songs: [song(1), song(2)] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchLikedTracks(true)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      [1, 2]
    )
    assert.equal(
      requests.filter((path) => parseRequest(path).pathname === '/playlist/track/all').length,
      3
    )
    assert.ok(requests.some((path) => parseRequest(path).pathname === '/playlist/detail'))
    assert.ok(requests.some((path) => parseRequest(path).pathname === '/song/detail'))
  } finally {
    ncmProvider.deactivate()
  }
})

test('liked tracks fall back to likelist when playlist endpoints fail', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: {
            userId: 42,
            nickname: 'listener',
            avatarUrl: 'avatar.jpg',
            signature: ''
          }
        }
      }
    }
    if (url.pathname === '/user/playlist') {
      return {
        playlist: [
          {
            id: 9001,
            name: '喜欢的音乐',
            specialType: 5,
            trackCount: 2,
            coverImgUrl: 'cover.jpg'
          }
        ]
      }
    }
    if (url.pathname === '/playlist/track/all' || url.pathname === '/playlist/detail') {
      throw new Error(`endpoint unavailable: ${url.pathname}`)
    }
    if (url.pathname === '/likelist') {
      return { ids: [3, 4] }
    }
    if (url.pathname === '/song/detail') {
      return { songs: [song(3), song(4)] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchLikedTracks(true)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      [3, 4]
    )
    assert.ok(requests.some((path) => parseRequest(path).pathname === '/likelist'))
  } finally {
    ncmProvider.deactivate()
  }
})

test('liked playlist page order survives the raw likelist refresh', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: {
            userId: 42,
            nickname: 'listener',
            avatarUrl: 'avatar.jpg',
            signature: ''
          }
        }
      }
    }
    if (url.pathname === '/user/playlist') {
      return {
        playlist: [
          {
            id: 9001,
            name: 'Liked Music',
            specialType: 5,
            trackCount: 3,
            coverImgUrl: 'cover.jpg'
          }
        ]
      }
    }
    // The liked playlist detail is authoritative: newest liked first.
    if (url.pathname === '/playlist/detail') {
      return { playlist: { trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }] } }
    }
    // /likelist returns the same songs in a different (liked-history) order.
    if (url.pathname === '/likelist') {
      return { ids: [3, 2, 1] }
    }
    if (url.pathname === '/song/detail') {
      return { songs: [song(1), song(2), song(3)] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const firstPage = await provider.fetchLikedTracksPage(0, 100, false)
    assert.deepEqual(
      firstPage.tracks.map((track) => track.ncmSongId),
      [1, 2, 3],
      'playlist page must follow the liked playlist detail order'
    )

    // A like-state check triggers the raw /likelist refresh on a different order.
    assert.equal(await provider.isTrackLiked(2), true)
    assert.ok(requests.some((path) => parseRequest(path).pathname === '/likelist'))

    const secondPage = await provider.fetchLikedTracksPage(0, 100, false)
    assert.deepEqual(
      secondPage.tracks.map((track) => track.ncmSongId),
      [1, 2, 3],
      'raw likelist refresh must not scramble the liked playlist page order'
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('fetchIntelligenceList calls the smart playback endpoint and normalizes songs', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/playmode/intelligence/list') {
      return {
        code: 200,
        data: [
          { id: 501, alg: 'alg-501', recommended: true, songInfo: song(501) },
          { id: 502, alg: 'alg-502', recommended: true, songInfo: song(502) },
          // 个别推荐条目没有元数据，应被跳过而不是产出无标题曲目。
          { id: 503, alg: 'alg-503', recommended: false, songInfo: null }
        ]
      }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchIntelligenceList({
      songId: 501,
      playlistId: 42,
      startSongId: 501,
      count: 10
    })
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      [501, 502]
    )
    assert.equal(tracks[0].title, 'song-501')
    assert.equal(tracks[0].artist, 'artist')
    assert.equal(tracks[0].album, 'album-501')
    const match = requests
      .map((path) => parseRequest(path))
      .find((url) => url.pathname === '/playmode/intelligence/list')
    assert.ok(match)
    assert.equal(match.searchParams.get('id'), '501')
    assert.equal(match.searchParams.get('pid'), '42')
    assert.equal(match.searchParams.get('sid'), '501')
    assert.equal(match.searchParams.get('count'), '10')
  } finally {
    ncmProvider.deactivate()
  }
})

test('fetchIntelligenceList rejects invalid ids and requires a login cookie', async () => {
  const provider = await activateProvider(async (path) => {
    throw new Error(`unexpected endpoint: ${path}`)
  })
  try {
    await assert.rejects(
      provider.fetchIntelligenceList({ songId: 0, playlistId: 42 }),
      /心动模式需要有效的歌曲 ID 与歌单 ID/
    )
    const anonymous = await activateProvider(async (path) => {
      throw new Error(`unexpected endpoint: ${path}`)
    }, new Map())
    await assert.rejects(
      anonymous.fetchIntelligenceList({ songId: 501, playlistId: 42 }),
      /请先登录网易云音乐/
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('liked song detail requests split into smaller chunks after transient failures', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => index + 1)
  const detailBatchSizes = []
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: {
            userId: 42,
            nickname: 'listener',
            avatarUrl: 'avatar.jpg',
            signature: ''
          }
        }
      }
    }
    if (url.pathname === '/user/playlist') return { playlist: [] }
    if (url.pathname === '/likelist') return { ids }
    if (url.pathname === '/song/detail') {
      const batch = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number)
      detailBatchSizes.push(batch.length)
      if (batch.length > 25) throw new Error('socket hang up')
      return { songs: batch.map(song) }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchLikedTracks(true)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      ids
    )
    assert.deepEqual(detailBatchSizes, [30, 30, 30, 15, 15])
  } finally {
    ncmProvider.deactivate()
  }
})

test('fetchPlaylistTracks pages track/all beyond the 200-track detail preview', async () => {
  const total = 450
  const ids = Array.from({ length: total }, (_, index) => index + 1)
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'avatar.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/playlist/track/all') {
      const limit = Number(url.searchParams.get('limit') || 1000)
      const offset = Number(url.searchParams.get('offset') || 0)
      assert.ok(limit <= 1000)
      return { songs: ids.slice(offset, offset + limit).map(song) }
    }
    if (url.pathname === '/playlist/detail') {
      return {
        playlist: {
          trackIds: ids.map((id) => ({ id })),
          tracks: ids.slice(0, 200).map(song)
        }
      }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchPlaylistTracks(55, true)
    assert.equal(tracks.length, total)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      ids
    )
    const trackAllOffsets = requests
      .map(parseRequest)
      .filter((url) => url.pathname === '/playlist/track/all')
      .map((url) => Number(url.searchParams.get('offset') || 0))
    assert.deepEqual(trackAllOffsets, [0])
    assert.equal(
      requests.some((path) => parseRequest(path).pathname === '/playlist/detail'),
      false
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('fetchPlaylistTracks pages multiple track/all windows up to 5000', async () => {
  const total = 2500
  const ids = Array.from({ length: total }, (_, index) => 10_000 + index)
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'avatar.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/playlist/track/all') {
      const limit = Number(url.searchParams.get('limit') || 1000)
      const offset = Number(url.searchParams.get('offset') || 0)
      return { songs: ids.slice(offset, offset + limit).map(song) }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchPlaylistTracks(77, true)
    assert.equal(tracks.length, total)
    const trackAll = requests
      .map(parseRequest)
      .filter((url) => url.pathname === '/playlist/track/all')
    assert.equal(trackAll.length, 3)
    assert.deepEqual(
      trackAll.map((url) => Number(url.searchParams.get('offset') || 0)),
      [0, 1000, 2000]
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('fetchPlaylistTracks caps at 5000 songs', async () => {
  const total = 5200
  const ids = Array.from({ length: total }, (_, index) => 20_000 + index)
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'avatar.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/playlist/track/all') {
      const limit = Number(url.searchParams.get('limit') || 1000)
      const offset = Number(url.searchParams.get('offset') || 0)
      return { songs: ids.slice(offset, offset + limit).map(song) }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchPlaylistTracks(88, true)
    assert.equal(tracks.length, 5000)
    assert.equal(tracks[0].ncmSongId, 20_000)
    assert.equal(tracks[4999].ncmSongId, 24_999)
  } finally {
    ncmProvider.deactivate()
  }
})

test('fetchPlaylistTracks detail fallback prefers full trackIds over truncated tracks', async () => {
  const ids = Array.from({ length: 350 }, (_, index) => 30_000 + index)
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'avatar.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/playlist/track/all') {
      throw new Error('track/all unavailable')
    }
    if (url.pathname === '/playlist/detail') {
      return {
        playlist: {
          trackIds: ids.map((id) => ({ id })),
          tracks: ids.slice(0, 200).map(song)
        }
      }
    }
    if (url.pathname === '/song/detail') {
      const batch = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number)
      return { songs: batch.map(song) }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchPlaylistTracks(99, true)
    assert.equal(tracks.length, 350)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      ids
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('liked tracks page loads only the requested window', async () => {
  const playlistIds = Array.from({ length: 250 }, (_, index) => 1000 + index)
  const likelistIds = Array.from({ length: 250 }, (_, index) => index + 1)
  const detailIds = []
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: {
            userId: 42,
            nickname: 'listener',
            avatarUrl: 'avatar.jpg',
            signature: ''
          }
        }
      }
    }
    if (url.pathname === '/user/playlist') {
      return {
        playlist: [
          {
            id: 9001,
            name: '喜欢的音乐',
            specialType: 5,
            trackCount: playlistIds.length,
            coverImgUrl: 'cover.jpg'
          }
        ]
      }
    }
    if (url.pathname === '/playlist/detail') {
      return { playlist: { trackIds: playlistIds.map((id) => ({ id })) } }
    }
    if (url.pathname === '/likelist') return { ids: likelistIds }
    if (url.pathname === '/song/detail') {
      const batch = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number)
      detailIds.push(...batch)
      return { songs: batch.map(song) }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const page = await provider.fetchLikedTracksPage(100, 100, true)
    assert.equal(page.total, 250)
    assert.equal(page.offset, 100)
    assert.equal(page.limit, 100)
    assert.equal(page.nextOffset, 200)
    assert.equal(page.hasMore, true)
    assert.deepEqual(
      page.tracks.map((track) => track.ncmSongId),
      playlistIds.slice(100, 200)
    )
    assert.deepEqual(detailIds, playlistIds.slice(100, 200))
    assert.equal(
      requests.some((path) => parseRequest(path).pathname === '/likelist'),
      false
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('saved albums and artists paginate and normalize cloud collections', async () => {
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    const offset = Number(url.searchParams.get('offset'))
    if (url.pathname === '/album/sublist') {
      return { data: [album(offset === 0 ? 1 : 2)], more: offset === 0 }
    }
    if (url.pathname === '/artist/sublist') {
      return {
        data: [{ id: 7, name: 'Saved artist', picUrl: 'https://example.com/artist.jpg' }],
        more: false
      }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })
  try {
    assert.deepEqual(
      (await provider.fetchSavedAlbums()).map((item) => item.id),
      [1, 2]
    )
    const artists = await provider.fetchSavedArtists()
    assert.equal(artists[0].id, 7)
    assert.equal(artists[0].name, 'Saved artist')
  } finally {
    ncmProvider.deactivate()
  }
})

test('album collections retain upstream release kinds without guessing from track counts', async () => {
  const source = [
    { ...album(1), name: 'LONG SEASON', size: 1, type: 'Single', subType: '录音室版' },
    { ...album(2), name: 'Spitfire EP', size: 11, type: '专辑', subType: '录音室版' },
    { ...album(3), type: ' EP ', subType: ' 现场版 ' },
    { ...album(4), type: 'EP/Single', subType: 'Remix' },
    { ...album(5), type: 'Mixtape', subType: 'Demo' },
    { ...album(6), type: ' ', subType: 7 },
    album(7)
  ]
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/artist/album') return { hotAlbums: source, more: false }
    if (url.pathname === '/album/sublist') return { data: source, more: false }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })
  try {
    for (const result of [
      await provider.fetchArtistAlbums(185871),
      await provider.fetchSavedAlbums()
    ]) {
      assert.deepEqual(
        result.map(({ releaseType }) => releaseType),
        ['Single', '专辑', 'EP', 'EP/Single', 'Mixtape', undefined, undefined]
      )
      assert.equal(result[0].trackCount, 1)
      assert.equal(result[1].name, 'Spitfire EP')
      assert.equal(result[1].trackCount, 11)
    }
  } finally {
    ncmProvider.deactivate()
  }
})

test('album explicit badges use the upstream flag bit and leave invalid metadata unknown', async () => {
  const cases = [
    [1048576, true],
    [1056768, true],
    [2 ** 40 + 1048576, true],
    ['1056768', true],
    [0, false],
    [8192, false],
    ['0', false],
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    [' ', undefined],
    ['invalid', undefined],
    [true, undefined],
    [-1, undefined],
    [1048576.5, undefined],
    [Number.MAX_SAFE_INTEGER + 1, undefined]
  ]
  const source = cases.map(([mark], id) => ({ ...album(id + 1), name: 'Explicit', mark }))
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/artist/album') return { hotAlbums: source, more: false }
    if (url.pathname === '/album/sublist') return { data: source, more: false }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })
  try {
    for (const result of [
      await provider.fetchArtistAlbums(53092),
      await provider.fetchSavedAlbums()
    ]) {
      assert.deepEqual(
        result.map(({ isExplicit }) => isExplicit),
        cases.map(([, expected]) => expected)
      )
    }
  } finally {
    ncmProvider.deactivate()
  }
})

test('artist albums keep paging when a short page reports more items', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/artist/album')
    assert.equal(url.searchParams.get('id'), '6452')
    assert.equal(url.searchParams.get('limit'), '100')

    const offset = Number(url.searchParams.get('offset'))
    if (offset === 0) return { hotAlbums: [album(1), album(2)], more: true }
    if (offset === 2) return { hotAlbums: [album(3)], more: false }
    throw new Error(`unexpected offset: ${offset}`)
  })

  try {
    const albums = await provider.fetchArtistAlbums(6452)
    assert.deepEqual(
      albums.map((item) => item.id),
      [1, 2, 3]
    )
    assert.equal(requests.length, 2)
    assert.equal(parseRequest(requests[1]).searchParams.get('offset'), '2')
  } finally {
    ncmProvider.deactivate()
  }
})

test('artist songs still fall back to the top-song endpoint when all-song paging fails', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/artist/songs') throw new Error('all songs unavailable')
    if (url.pathname === '/artist/top/song') return { songs: [song(9)] }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const tracks = await provider.fetchArtistTopSongs(6452)
    assert.deepEqual(
      tracks.map((track) => track.ncmSongId),
      [9]
    )
    assert.equal(parseRequest(requests[0]).pathname, '/artist/songs')
    assert.equal(parseRequest(requests[1]).pathname, '/artist/top/song')
  } finally {
    ncmProvider.deactivate()
  }
})

test('artist intro and follow state use dedicated artist endpoints', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/artist/desc') return { briefDesc: '  artist introduction  ' }
    if (url.pathname === '/artist/detail/dynamic') return { data: { followed: true } }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    assert.equal(await provider.fetchArtistIntro(6452), 'artist introduction')
    assert.equal(await provider.fetchArtistFollowState(6452), true)
    assert.deepEqual(
      requests.map((path) => parseRequest(path).pathname),
      ['/artist/desc', '/artist/detail/dynamic']
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('account library failures are retryable errors, not successful empty libraries', async t => {
  t.after(() => ncmProvider.deactivate())
  let libraryResponse = { code: 301, msg: '需要登录' }
  const provider = await activateProvider(async path => {
    const url = parseRequest(path)
    if (url.pathname === '/login/status') return { data: { code: 200, profile: {
      userId: 1001, nickname: 'Account', signature: '', follows: 0, followeds: 0
    } } }
    if (url.pathname === '/user/playlist') return libraryResponse
    throw new Error(`Unexpected endpoint ${url.pathname}`)
  })
  await assert.rejects(provider.fetchUserLibrary(), /登录/)
  libraryResponse = { code: 200 }
  await assert.rejects(provider.fetchUserLibrary(true), /歌单.*不完整/)
  libraryResponse = { code: 200, playlist: [
    { id: 11, name: '喜欢的音乐', specialType: 5, userId: 1001, trackCount: 2 },
    { id: 22, name: 'My playlist', userId: 1001, trackCount: 3 }
  ] }
  const library = await provider.fetchUserLibrary(true)
  assert.equal(library.likedPlaylist.id, 11)
  assert.equal(library.playlists[0].id, 22)
  assert.equal(library.playlists[0].owned, true)
  libraryResponse = { code: 200, playlist: [] }
  assert.deepEqual(await provider.fetchUserLibrary(true), { likedPlaylist: null, playlists: [] })
})

test('login restores missing profile details from the authenticated account identity', async t => {
  t.after(() => ncmProvider.deactivate())
  const settings = new Map([['cookie', 'MUSIC_U=account']])
  let detail = { code: 200, profile: { userId: 42, nickname: 'Restored',
    avatarUrl: null, signature: '', follows: 3, followeds: 4 } }
  const provider = await activateProvider(async (path, cookie) => {
    assert.equal(cookie, 'MUSIC_U=account')
    const url = parseRequest(path)
    if (url.pathname === '/login/status') return { data: { code: 200, account: { id: 42 }, profile: null } }
    if (url.pathname === '/user/detail') {
      assert.equal(url.searchParams.get('uid'), '42')
      return detail
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`)
  }, settings)
  detail = { code: 503 }
  await assert.rejects(provider.checkLogin())
  assert.equal(settings.get('cookie'), 'MUSIC_U=account')
  detail = { code: 200, profile: { userId: 99, nickname: 'Wrong account' } }
  await assert.rejects(provider.checkLogin(), /账户/)
  detail = { code: 200, profile: { userId: 42, nickname: 'Restored',
    avatarUrl: null, signature: '', follows: 3, followeds: 4 } }
  const login = await provider.checkLogin()
  assert.equal(login.loggedIn, true)
  assert.equal(login.profile.userId, 42)
  assert.equal(login.profile.nickname, 'Restored')
})

test('create delete and track mutations call NetEase playlist write endpoints', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/user/playlist') {
      return {
        playlist: [
          {
            id: 11,
            name: '我创建的',
            userId: 1001,
            trackCount: 2,
            coverImgUrl: null
          },
          {
            id: 22,
            name: '别人的',
            userId: 2002,
            trackCount: 5,
            coverImgUrl: null
          }
        ]
      }
    }
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: {
            userId: 1001,
            nickname: 'tester',
            avatarUrl: null,
            signature: '',
            follows: 0,
            followeds: 0
          }
        }
      }
    }
    if (url.pathname === '/playlist/create') {
      return {
        code: 200,
        playlist: {
          id: 99,
          name: url.searchParams.get('name'),
          userId: 1001,
          trackCount: 0,
          coverImgUrl: null
        }
      }
    }
    if (
      url.pathname === '/playlist/delete' ||
      url.pathname === '/playlist/subscribe' ||
      url.pathname === '/playlist/tracks'
    ) {
      return { code: 200 }
    }
    return { code: 200 }
  })

  try {
    const library = await provider.fetchUserLibrary(true)
    assert.equal(library.playlists.find((item) => item.id === 11)?.owned, true)
    assert.equal(library.playlists.find((item) => item.id === 22)?.owned, false)

    const created = await provider.createPlaylist('新歌单')
    assert.equal(created.id, 99)
    assert.equal(created.owned, true)
    assert.ok(requests.some((path) => parseRequest(path).pathname === '/playlist/create'))

    await provider.addTracksToPlaylist(99, [1, 2, 2])
    await provider.removeTracksFromPlaylist(99, [1])
    const trackWrite = requests
      .map((path) => parseRequest(path))
      .filter((url) => url.pathname === '/playlist/tracks')
    assert.equal(trackWrite.length, 2)
    assert.equal(trackWrite[0].searchParams.get('op'), 'add')
    assert.equal(trackWrite[0].searchParams.get('tracks'), '1,2')
    assert.equal(trackWrite[1].searchParams.get('op'), 'del')

    await provider.deletePlaylist(11)
    assert.ok(
      requests.some((path) => {
        const url = parseRequest(path)
        return url.pathname === '/playlist/delete' && url.searchParams.get('id') === '11'
      })
    )

    await provider.deletePlaylist(22)
    assert.ok(
      requests.some((path) => {
        const url = parseRequest(path)
        return (
          url.pathname === '/playlist/subscribe' &&
          url.searchParams.get('t') === '2' &&
          url.searchParams.get('id') === '22'
        )
      })
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('artist and user follow actions call NetEase follow endpoints', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    return { code: 200 }
  })

  try {
    await provider.followArtist(6452, true)
    await provider.followArtist(6452, false)
    await provider.followUser(32953014, true)
    await provider.followUser(32953014, false)

    assert.deepEqual(
      requests.map((path) => {
        const url = parseRequest(path)
        return `${url.pathname}?id=${url.searchParams.get('id')}&t=${url.searchParams.get('t')}`
      }),
      [
        '/artist/sub?id=6452&t=1',
        '/artist/sub?id=6452&t=0',
        '/follow?id=32953014&t=1',
        '/follow?id=32953014&t=0'
      ]
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('like and follow retries with one idempotency key execute the upstream write once', async () => {
  const requests = []
  let releaseRequest
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve
  })
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    await requestGate
    return { code: 200 }
  })
  const firstContext = {
    signal: new AbortController().signal,
    idempotencyKey: 'like-track-42'
  }

  try {
    const first = provider.likeTrack(42, true, firstContext)
    const concurrentRetry = provider.likeTrack(42, true, {
      signal: new AbortController().signal,
      idempotencyKey: 'like-track-42'
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests.length, 1)

    releaseRequest()
    await Promise.all([first, concurrentRetry])
    await provider.likeTrack(42, true, firstContext)
    assert.equal(requests.length, 1)

    await assert.rejects(
      () => provider.likeTrack(42, false, firstContext),
      /reused for a different write payload/
    )
    await provider.likeTrack(42, false, {
      signal: new AbortController().signal,
      idempotencyKey: 'unlike-track-42'
    })
    assert.equal(requests.length, 2)
  } finally {
    ncmProvider.deactivate()
  }
})

test('completed provider writes survive a built-in provider restart without replaying upstream', async () => {
  const settings = new Map([['cookie', 'MUSIC_U=test;']])
  const requests = []
  const context = {
    signal: new AbortController().signal,
    idempotencyKey: 'restart-like-track-42'
  }
  let provider = await activateProvider(async (path, _cookie, options) => {
    requests.push({ path, options })
    return { code: 200 }
  }, settings)

  try {
    await provider.likeTrack(42, true, context)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].options.idempotencyKey, context.idempotencyKey)
    assert.strictEqual(requests[0].options.signal, context.signal)
    const persisted = settings.get('providerWriteIdempotency')
    assert.equal(Array.isArray(persisted.records), true)
    assert.equal(persisted.records.length, 1)

    ncmProvider.deactivate()
    provider = await activateProvider(async (path, _cookie, options) => {
      requests.push({ path, options })
      return { code: 200 }
    }, settings)
    await provider.likeTrack(42, true, context)
    assert.equal(requests.length, 1)
    assert.equal(await provider.isTrackLiked(42), true)
  } finally {
    ncmProvider.deactivate()
  }
})

test('aborted writes forward the signal and never mutate the local liked state', async () => {
  let releaseRequest
  let seenOptions = null
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve
  })
  const provider = await activateProvider(async (_path, _cookie, options) => {
    seenOptions = options
    await requestGate
    return { code: 200 }
  })
  const controller = new AbortController()

  try {
    const pending = provider.likeTrack(42, true, {
      signal: controller.signal,
      idempotencyKey: 'abort-like-track-42'
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(seenOptions.signal, controller.signal)
    assert.equal(seenOptions.idempotencyKey, 'abort-like-track-42')

    controller.abort(new Error('caller cancelled the write'))
    releaseRequest()
    await assert.rejects(pending, /caller cancelled the write/)
    assert.equal(await provider.isTrackLiked(42), false)
  } finally {
    ncmProvider.deactivate()
  }
})

test('isTrackLiked refreshes the liked set from likelist with a short TTL cache', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'a.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/likelist') {
      return { ids: [1, 2, 3] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    // 首次查询会从云端 likelist 拉取权威喜欢集合。
    assert.equal(await provider.isTrackLiked(2), true)
    assert.equal(await provider.isTrackLiked(99), false)
    assert.equal(
      requests.filter((path) => parseRequest(path).pathname === '/likelist').length,
      1,
      'TTL 内第二次查询不应重复拉取 likelist'
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('isTrackLiked falls back to the cached liked set when likelist refresh fails', async () => {
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/likelist') {
      throw new Error('network down')
    }
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'a.jpg', signature: '' }
        }
      }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    // 云端刷新失败时回退到本地缓存集合（空集合 -> 未喜欢）。
    assert.equal(await provider.isTrackLiked(7), false)
  } finally {
    ncmProvider.deactivate()
  }
})

test('in-flight liked refresh cannot overwrite a completed local like', async () => {
  let releaseRefresh
  let refreshStarted
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve
  })
  const refreshStartedGate = new Promise((resolve) => {
    refreshStarted = resolve
  })
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'a.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/likelist') {
      refreshStarted()
      await refreshGate
      return { ids: [] }
    }
    if (url.pathname === '/like') return { code: 200 }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    const pendingRefresh = provider.isTrackLiked(7)
    await refreshStartedGate
    await provider.likeTrack(7, true)
    releaseRefresh()
    await pendingRefresh
    assert.equal(await provider.isTrackLiked(7), true)
  } finally {
    ncmProvider.deactivate()
  }
})

test('liked refresh retries after the backoff window instead of extending the TTL', async () => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  let likelistRequests = 0
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/login/status') {
      return {
        code: 200,
        data: {
          code: 200,
          profile: { userId: 42, nickname: 'listener', avatarUrl: 'a.jpg', signature: '' }
        }
      }
    }
    if (url.pathname === '/likelist') {
      likelistRequests += 1
      throw new Error('network down')
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  })

  try {
    await provider.isTrackLiked(7)
    const firstRequestCount = likelistRequests
    now += 15_000 - 1
    await provider.isTrackLiked(7)
    assert.equal(likelistRequests, firstRequestCount)
    now += 1
    await provider.isTrackLiked(7)
    assert.ok(likelistRequests > firstRequestCount)
  } finally {
    Date.now = realNow
    ncmProvider.deactivate()
  }
})

test('follow list uses artist sublist and returns artist identities', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    if (url.pathname !== '/artist/sublist') {
      throw new Error(`unexpected endpoint: ${url.pathname}`)
    }
    assert.equal(url.searchParams.get('limit'), '100')
    assert.equal(url.searchParams.get('offset'), '0')
    return {
      data: [
        { id: 101, name: 'aiss', picUrl: 'https://img.test/aiss.jpg', musicSize: 12 },
        { id: 202, name: '7FIV6', img1v1Url: 'https://img.test/7fiv6.jpg', musicSize: 8 }
      ]
    }
  })

  try {
    const follows = await provider.fetchUserFollows(12345, 100, 0)
    assert.deepEqual(follows, [
      {
        id: 101,
        name: 'aiss',
        picUrl: 'https://img.test/aiss.jpg',
        picUrlSmall: 'https://img.test/aiss.jpg',
        musicSize: 12,
        userType: 2,
        artistId: 101,
        followed: true
      },
      {
        id: 202,
        name: '7FIV6',
        picUrl: 'https://img.test/7fiv6.jpg',
        picUrlSmall: 'https://img.test/7fiv6.jpg',
        musicSize: 8,
        userType: 2,
        artistId: 202,
        followed: true
      }
    ])
    assert.equal(requests.length, 1)
  } finally {
    ncmProvider.deactivate()
  }
})

test('playlist categories load anonymously, normalize groups, and cache the catalogue', async () => {
  const requests = []
  const cookies = []
  const provider = await activateProvider(async (path, cookie) => {
    requests.push(path)
    cookies.push(cookie)
    const url = parseRequest(path)
    if (url.pathname === '/playlist/catlist') {
      return {
        categories: { 0: '语种', 1: '风格' },
        sub: [
          { name: '华语', category: 0, hot: true },
          { name: '欧美', category: 0, hot: false },
          { name: '摇滚', category: 1, hot: true }
        ]
      }
    }
    if (url.pathname === '/playlist/hot') {
      return { tags: [{ name: '华语' }, { name: '流行' }] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  }, new Map())

  try {
    const catalogue = await provider.fetchPlaylistCategories()
    assert.deepEqual(catalogue, {
      hotTags: ['华语', '流行'],
      groups: [
        {
          id: 0,
          name: '语种',
          tags: [
            { name: '华语', hot: true },
            { name: '欧美', hot: false }
          ]
        },
        { id: 1, name: '风格', tags: [{ name: '摇滚', hot: true }] }
      ]
    })
    assert.ok(cookies.every((cookie) => !cookie))
    assert.equal(requests.length, 2)

    const cached = await provider.fetchPlaylistCategories()
    assert.deepEqual(cached, catalogue)
    assert.equal(requests.length, 2)
  } finally {
    ncmProvider.deactivate()
  }
})

test('playlist categories derive hot tags from sub items when the hot endpoint fails', async () => {
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname === '/playlist/catlist') {
      return {
        categories: { 2: '场景' },
        sub: [
          { name: '学习', category: 2, hot: true },
          { name: '夜晚', category: 2, hot: false }
        ]
      }
    }
    throw new Error('hot tags unavailable')
  }, new Map())

  try {
    const catalogue = await provider.fetchPlaylistCategories()
    assert.deepEqual(catalogue.hotTags, ['学习'])
  } finally {
    ncmProvider.deactivate()
  }
})

test('discovery playlists pass tag paging params and normalize playlists with play counts', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/top/playlist')
    // /api/playlist/list responds with the plural `playlists` key.
    return {
      playlists: [
        {
          id: 900,
          name: '欧美新歌',
          coverImgUrl: 'https://img.test/900.jpg',
          trackCount: 42,
          creator: { nickname: 'curator' },
          playCount: 123456
        }
      ],
      total: 100,
      more: true
    }
  }, new Map())

  try {
    const page = await provider.fetchDiscoveryPlaylists('欧美', 'new', 30, 60)
    const url = parseRequest(requests[0])
    assert.equal(url.searchParams.get('cat'), '欧美')
    assert.equal(url.searchParams.get('order'), 'new')
    assert.equal(url.searchParams.get('limit'), '30')
    assert.equal(url.searchParams.get('offset'), '60')
    assert.equal(page.total, 100)
    assert.equal(page.hasMore, true)
    assert.equal(page.offset, 60)
    assert.equal(page.limit, 30)
    assert.deepEqual(page.items, [
      {
        id: 900,
        name: '欧美新歌',
        cover: 'https://img.test/900.jpg',
        coverSmall: 'https://img.test/900.jpg',
        trackCount: 42,
        creatorName: 'curator',
        owned: undefined,
        playCount: 123456
      }
    ])
  } finally {
    ncmProvider.deactivate()
  }
})

test('playlist covers request higher-resolution NetEase thumbnails', async () => {
  const provider = await activateProvider(
    async () => ({
      playlists: [
        {
          id: 901,
          name: 'High-res cover',
          coverImgUrl: 'https://p1.music.126.net/abc/cover.jpg?param=300y300',
          trackCount: 12
        },
        {
          id: 902,
          name: 'High-res cover',
          coverImgUrl: 'https://p2.music.126.net/abc/original.jpg',
          trackCount: 7
        }
      ],
      total: 2,
      more: false
    }),
    new Map()
  )

  try {
    const page = await provider.fetchDiscoveryPlaylists('all', 'hot', 30, 0)
    assert.equal(page.items[0].cover, 'https://p1.music.126.net/abc/cover.jpg?param=600y600')
    assert.equal(page.items[0].coverSmall, 'https://p1.music.126.net/abc/cover.jpg?param=140y140')
    assert.equal(page.items[1].cover, 'https://p2.music.126.net/abc/original.jpg?param=600y600')
    assert.equal(
      page.items[1].coverSmall,
      'https://p2.music.126.net/abc/original.jpg?param=140y140'
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('discovery playlists fall back to hot order for invalid order values', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    return { playlists: [], total: 0, more: false }
  }, new Map())

  try {
    await provider.fetchDiscoveryPlaylists('全部', 'invalid-order', 30, 0)
    assert.equal(parseRequest(requests[0]).searchParams.get('order'), 'hot')
  } finally {
    ncmProvider.deactivate()
  }
})

test('high-quality playlists page with a forward before cursor and surface lasttime', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    requests.push(path)
    const url = parseRequest(path)
    assert.equal(url.pathname, '/top/playlist/highquality')
    const before = url.searchParams.get('before')
    return {
      playlists: [
        {
          id: before ? 902 : 901,
          name: before ? '精品二' : '精品一',
          coverImgUrl: null,
          trackCount: 10,
          updateTime: before ? 1600 : 1800
        }
      ],
      total: 60,
      more: !before,
      lasttime: before ? 1600 : 1800
    }
  }, new Map())

  try {
    const first = await provider.fetchHighQualityPlaylists('全部', 30, 0)
    assert.equal(parseRequest(requests[0]).searchParams.get('before'), null)
    assert.equal(first.hasMore, true)
    assert.equal(first.lasttime, 1800)

    const second = await provider.fetchHighQualityPlaylists('全部', 30, first.lasttime)
    assert.equal(parseRequest(requests[1]).searchParams.get('before'), '1800')
    assert.equal(second.hasMore, false)
    assert.equal(second.items[0].id, 902)
  } finally {
    ncmProvider.deactivate()
  }
})

test('playlist tracks load anonymously without a login error', async () => {
  const cookies = []
  const provider = await activateProvider(async (path, cookie) => {
    cookies.push(cookie)
    const url = parseRequest(path)
    if (url.pathname === '/playlist/track/all') {
      return { songs: [song(1), song(2)] }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  }, new Map())

  try {
    const tracks = await provider.fetchPlaylistTracks(123)
    assert.equal(tracks.length, 2)
    assert.equal(tracks[0].id, 'ncm:1')
    assert.ok(cookies.every((cookie) => !cookie))
  } finally {
    ncmProvider.deactivate()
  }
})

test('lyrics search and lookup work without a NetEase login', async () => {
  const cookies = []
  const provider = await activateProvider(async (path, cookie) => {
    cookies.push(cookie)
    const url = parseRequest(path)
    if (url.pathname === '/cloudsearch') {
      return { result: { songCount: 1, songs: [song(77)] } }
    }
    if (url.pathname === '/lyric/new') {
      return {
        lrc: { lyric: '[00:01.00]Original' },
        tlyric: { lyric: '[00:01.00]Translation' }
      }
    }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  }, new Map())

  try {
    const search = await provider.searchSongs('song 77')
    const lyrics = await provider.getLyrics(search.items[0])
    assert.equal(search.items[0].id, 'ncm:77')
    assert.equal(lyrics.translatedLyrics, '[00:01.00]Translation')
    assert.ok(cookies.every((cookie) => !cookie))
  } finally {
    ncmProvider.deactivate()
  }
})

test('lyrics lookup retries a transient lyric endpoint failure', async () => {
  let lyricRequests = 0
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    if (url.pathname !== '/lyric/new') throw new Error(`unexpected endpoint: ${url.pathname}`)
    lyricRequests += 1
    if (lyricRequests === 1) throw new Error('fetch failed')
    return { lrc: { lyric: '[00:01.00]Recovered lyric' } }
  }, new Map())

  try {
    const lyrics = await provider.getLyrics({ id: 'ncm:88', filePath: 'ncm:88', source: 'ncm' })
    assert.equal(lyricRequests, 2)
    assert.equal(lyrics.lyrics, '[00:01.00]Recovered lyric')
  } finally {
    ncmProvider.deactivate()
  }
})

test('lyrics lookup falls back to the legacy endpoint when lyric/new fails', async () => {
  const requests = []
  const provider = await activateProvider(async (path) => {
    const url = parseRequest(path)
    requests.push(url.pathname)
    if (url.pathname === '/lyric/new') throw new Error('lyric/new endpoint unavailable')
    if (url.pathname === '/lyric') return { lrc: { lyric: '[00:01.00]Legacy lyric' } }
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  }, new Map())

  try {
    const lyrics = await provider.getLyrics({ id: 'ncm:89', filePath: 'ncm:89', source: 'ncm' })
    assert.equal(lyrics.lyrics, '[00:01.00]Legacy lyric')
    assert.deepEqual(requests, ['/lyric/new', '/lyric'])
  } finally {
    ncmProvider.deactivate()
  }
})

test('lyrics lookup preserves a business error when both lyric endpoints fail', async () => {
  const provider = await activateProvider(async (path) => {
    const endpoint = parseRequest(path).pathname
    if (endpoint === '/lyric/new' || endpoint === '/lyric') {
      return { code: 460, message: 'risk control' }
    }
    throw new Error(`unexpected endpoint: ${endpoint}`)
  }, new Map())

  try {
    await assert.rejects(
      provider.getLyrics({ id: 'ncm:90', filePath: 'ncm:90', source: 'ncm' }),
      /NetEase code 460/
    )
  } finally {
    ncmProvider.deactivate()
  }
})

test('membership upgrade resolves full audio after trial without reusing trial caches', async () => {
  let member = false
  const writes = []
  const provider = await activateProvider(
    async () => ({
      code: 200,
      data: [
        {
          code: 200,
          url: member ? 'https://music.example/full.mp3' : 'https://music.example/trial.mp3',
          freeTrialInfo: member ? null : { start: 0, end: 30 }
        }
      ]
    }),
    undefined,
    {
      ncm: {
        getCachedSong: async () => 'D:/Cache/79.mp3',
        cacheSong: async (_id, url) => {
          writes.push(url)
          return null
        }
      }
    }
  )
  try {
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:79' }), 'https://music.example/trial.mp3')
    assert.deepEqual(writes, [])
    member = true
    assert.equal(await provider.getPlaybackUrl({ id: 'ncm:79' }), 'https://music.example/full.mp3')
    assert.deepEqual(writes, ['https://music.example/full.mp3'])
  } finally {
    ncmProvider.deactivate()
  }
})

for (const loginMethod of ['QR', 'official web']) {
  test(`signing in again by ${loginMethod} clears resolved audio and ignores downloads from the old session`, async () => {
    let finishOldDownload
    let calls = 0
    const provider = await activateProvider(
      async (path) => {
        if (path.startsWith('/login/qr/check')) return { code: 803, cookie: 'MUSIC_U=renewed;' }
        if (path.startsWith('/login/status')) return { data: { code: 200, profile: { userId: 1 } } }
        if (path.startsWith('/user/detail')) return { code: 200, profile: { follows: 0 } }
        return {
          code: 200,
          data: [{ code: 200, url: `https://music.example/${++calls}.mp3` }]
        }
      },
      undefined,
      {
        ncm: {
          cacheSong: async () =>
            new Promise((resolve) => {
              finishOldDownload = resolve
            })
        }
      }
    )
    try {
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:79' }), 'https://music.example/1.mp3')
      const finish = finishOldDownload
      if (loginMethod === 'QR') {
        assert.equal((await provider.checkQrLogin('renewed-key')).code, 803)
      } else {
        await provider.openOfficialLogin()
      }
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:79' }), 'https://music.example/2.mp3')
      finish('D:/Cache/old.mp3')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(await provider.getPlaybackUrl({ id: 'ncm:79' }), 'https://music.example/2.mp3')
    } finally {
      ncmProvider.deactivate()
    }
  })
}
