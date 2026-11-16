import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createBilibiliMvResolver,
  encodeBilibiliWbiQuery,
  md5Hex,
  parseBilibiliDurationSeconds,
  pickBestBilibiliMvCandidate
} from './bilibiliMvResolver.ts'
import { RemoteMediaGrantService, protectProviderMedia } from '../../main/security/remoteMediaGrants.ts'

test('md5Hex and encodeBilibiliWbiQuery match native Node MD5 across UTF-8 and multi-block inputs', () => {
  const samples = [
    '',
    'a',
    'abc',
    'message digest',
    '春泥棒 ヨルシカ MV',
    'bvid=BV17t4y1r7Jq&cid=280326424&fnval=1&fourk=1&high_quality=1&platform=html5&qn=80&wts=1700000000ea1db124af3c7062474693fa704f4ff8'
  ]
  for (const sample of samples) {
    assert.equal(md5Hex(sample), createHash('md5').update(sample, 'utf8').digest('hex'))
  }

  const signed = encodeBilibiliWbiQuery(
    { keyword: "春泥棒!(ヨルシカ)*'MV'", search_type: 'video', page: 1 },
    '7cd084941338484aae1ad9425b84077c',
    '4932caff0ff746eab6f01bf08b70ac45',
    1702774799
  )
  assert.doesNotMatch(signed, /[!'()*]/)
  assert.match(signed, /&wts=1702774799&w_rid=[0-9a-f]{32}$/)
})

test('pickBestBilibiliMvCandidate selects official MV while rejecting karaoke, covers, and long compilations', () => {
  assert.equal(parseBilibiliDurationSeconds('5:30'), 330)
  assert.equal(parseBilibiliDurationSeconds('179:58'), 10798)
  assert.equal(parseBilibiliDurationSeconds('1:02:03'), 3723)

  const match = pickBestBilibiliMvCandidate(
    { title: '春泥棒', artist: 'ヨルシカ', duration: 290 },
    [
      {
        bvid: 'BV1aaaa11111',
        title: 'Yorushika<em class="keyword">ヨルシカ</em>夜鹿MV合集',
        author: '合集搬运',
        duration: '179:58',
        play: 5_000_000
      },
      {
        bvid: 'BV1bbbb22222',
        title: '【カラオケ】<em class="keyword">春泥棒</em>_ヨルシカ【on / off vocal】',
        author: 'KaraokeCh',
        duration: '5:00',
        play: 900_000
      },
      {
        bvid: 'BV1cccc33333',
        title: '【歌ってみた】春泥棒 / ヨルシカ covered by 某人',
        author: 'Singer',
        duration: '4:52',
        play: 800_000
      },
      {
        bvid: 'BV17t4y1r7Jq',
        title: '【<em class="keyword">ヨルシカ</em>】「<em class="keyword">春泥棒</em> (偷春人)」<em class="keyword">MV</em>【ナブナ/n-buna × suis】',
        author: 'ヨルシカ_Official',
        duration: '5:30',
        play: 2_030_184,
        pic: '//i0.hdslb.com/bfs/archive/yorushika.jpg'
      }
    ]
  )

  assert.ok(match)
  assert.equal(match.bvid, 'BV17t4y1r7Jq')
  assert.equal(match.pic, 'https://i0.hdslb.com/bfs/archive/yorushika.jpg')
  assert.equal(match.durationSeconds, 330)
})

test('createBilibiliMvResolver resolves 1080p progressive MP4, falls back to AVC DASH for 480p, retries expired WBI keys, and returns twilight-media grants', async () => {
  const grants = new RemoteMediaGrantService()
  let searchAttempts = 0
  const requestedUrls: string[] = []

  const resolver = createBilibiliMvResolver({
    now: () => 1_700_000_000_000,
    protectResult: (value) => protectProviderMedia(value, 'getTrackMv', grants),
    fetch: async (input) => {
      const url = String(input)
      requestedUrls.push(url)

      if (url.includes('/x/frontend/finger/spi')) {
        return Response.json({
          code: 0,
          data: { b_3: 'BUVID3-TEST', b_4: 'BUVID4-TEST' }
        })
      }
      if (url.includes('/x/web-interface/nav')) {
        return Response.json({
          code: -101,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
            }
          }
        })
      }
      if (url.includes('/x/web-interface/wbi/search/type')) {
        searchAttempts++
        if (searchAttempts === 1) {
          // Simulate expired WBI key (-352) on first attempt
          return Response.json({ code: -352, message: 'risk' })
        }
        return Response.json({
          code: 0,
          data: {
            result: [
              {
                bvid: 'BV1trial9999',
                title: '【ヨルシカ】「春泥棒」官方 MV（充电试看）',
                author: 'ヨルシカ',
                duration: '5:00',
                play: 9_900_000,
                pic: 'http://i0.hdslb.com/bfs/archive/trial.jpg'
              },
              {
                bvid: 'BV17t4y1r7Jq',
                title: '【ヨルシカ】「春泥棒」官方 MV',
                author: 'ヨルシカ',
                duration: '5:00',
                play: 2_100_000,
                pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg'
              }
            ]
          }
        })
      }
      if (url.includes('/x/web-interface/view') && url.includes('BV1trial9999')) {
        return Response.json({
          code: 0,
          data: {
            bvid: 'BV1trial9999',
            cid: 111,
            title: '【ヨルシカ】「春泥棒」官方 MV（充电试看）',
            duration: 300,
            dimension: { width: 1920, height: 1080 }
          }
        })
      }
      if (url.includes('/x/player/wbi/playurl') && url.includes('BV1trial9999')) {
        return Response.json({
          code: 0,
          data: {
            quality: 80,
            durl: [
              {
                url: 'https://upos-sz-estghw.bilivideo.com/upgcxcode/trial-6s.mp4',
                size: 500_000,
                length: 6_000
              }
            ]
          }
        })
      }
      if (url.includes('/x/web-interface/view')) {
        return Response.json({
          code: 0,
          data: {
            bvid: 'BV17t4y1r7Jq',
            cid: 280326424,
            title: '【ヨルシカ】「春泥棒」官方 MV',
            pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
            duration: 300,
            dimension: { width: 1920, height: 1080 }
          }
        })
      }
      if (url.includes('/x/player/wbi/playurl') && url.includes('platform=html5')) {
        return Response.json({
          code: 0,
          data: {
            quality: 80,
            durl: [
              {
                url: 'https://upos-sz-estghw.bilivideo.com/upgcxcode/24/64/280326424/280326424-1-80.mp4?deadline=999999',
                size: 92_935_129,
                length: 300_000
              }
            ]
          }
        })
      }
      if (url.includes('/x/player/wbi/playurl') && url.includes('fnval=4048')) {
        return Response.json({
          code: 0,
          data: {
            quality: 32,
            dash: {
              video: [
                {
                  id: 32,
                  codecid: 12,
                  bandwidth: 900_000,
                  width: 852,
                  height: 480,
                  baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/hevc-480.m4s'
                },
                {
                  id: 32,
                  codecid: 7,
                  bandwidth: 800_000,
                  width: 852,
                  height: 480,
                  baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/avc-480.m4s'
                }
              ],
              audio: [
                {
                  id: 30280,
                  bandwidth: 320_000,
                  baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/audio-hi.m4s'
                }
              ]
            }
          }
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }
  })

  // 1. Auto/1080p resolves watermark-free Bilibili progressive 1080p MP4 via WBI search (recovering from -352)
  const hdStream = await resolver.resolveTrackMv(
    { title: '春泥棒', artist: 'ヨルシカ', duration: 290 },
    { quality: 'auto' }
  )
  assert.ok(hdStream)
  assert.equal(searchAttempts, 2)
  assert.equal(hdStream.providerId, 'bili')
  assert.equal(hdStream.mvId, 'BV17t4y1r7Jq')
  assert.equal(hdStream.quality, '1080p')
  assert.equal(hdStream.width, 1920)
  assert.equal(hdStream.height, 1080)
  assert.match(hdStream.url, /^twilight-media:\/\/video\/[A-Za-z0-9_-]+$/)
  assert.equal(hdStream.audioUrl, undefined)
  assert.match(String(hdStream.coverUrl), /^twilight-media:\/\/image\/[A-Za-z0-9_-]+$/)
  assert.equal('referer' in hdStream, false)

  // 2. Direct BV ID at 480p uses DASH and prefers AVC (codecid=7) + companion audio grant
  const sdStream = await resolver.resolveTrackMv(
    { id: 'bili:BV17t4y1r7Jq', source: 'bili', title: '春泥棒' },
    { quality: '480p' }
  )
  assert.ok(sdStream)
  assert.equal(sdStream.quality, '480p')
  assert.match(sdStream.url, /^twilight-media:\/\/video\/[A-Za-z0-9_-]+$/)
  assert.match(String(sdStream.audioUrl), /^twilight-media:\/\/audio\/[A-Za-z0-9_-]+$/)
  assert.equal(
    grants.resolve(sdStream.url, 'video').source,
    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/avc-480.m4s'
  )
  assert.equal(grants.resolve(sdStream.url, 'video').referer, 'https://www.bilibili.com/')
})
