import assert from 'node:assert/strict'
import test from 'node:test'
import { createArtworkProjection, createQueueCoverResolver } from './artworkProjection.ts'

test('metadata artwork projection carries absolute permission expiry to the original grant service', async () => {
  let expires: number | undefined
  const project = createArtworkProjection({ normalizeCachedCover: async handle => handle,
    migrateBase64Cover: () => null, resolve: () => ({ source: 'https://cover.example/a.jpg', expiresAt: 1500 }),
    grant: (_source, expiresAt) => { expires = expiresAt; return 'twilight-media://image/expiring' }
  })
  assert.deepEqual(await project({ cover: 'https://cover.example/a.jpg', coverSource: null, imageExpiresAt: 2000 }, new AbortController().signal),
    { cover: 'twilight-media://image/expiring', coverSource: null })
  assert.equal(expires, 2000)
  await project({ cover: 'twilight-media://image/expiring', coverSource: null }, new AbortController().signal)
  assert.equal(expires, 1500, 're-granting an existing image cannot discard its permission deadline')
})

test('Core artwork projects cache handles and re-grants durable or session images without exposing origins', async () => {
  const sources: string[] = []
  const project = createArtworkProjection({
    normalizeCachedCover: async (handle) => handle,
    migrateBase64Cover: () => 'cover://embedded.jpg',
    grant: (source) => {
      sources.push(source)
      return 'twilight-media://image/granted'
    },
    resolve: () => ({ source: 'https://cdn.test/recovered?token=private' })
  })
  const signal = new AbortController().signal
  assert.deepEqual(await project({ cover: 'cover://local.jpg', coverSource: 'https://cdn.test/other' }, signal), { cover: 'cover://local.jpg', coverSource: null })
  assert.deepEqual(await project({ cover: 'data:image/png;base64,AA==', coverSource: null }, signal), { cover: 'cover://embedded.jpg', coverSource: null })
  for (const input of [
    { cover: 'twilight-media://image/old', coverSource: 'https://cdn.test/art?token=private' },
    { cover: 'https://cdn.test/art?token=private', coverSource: null },
    { cover: 'twilight-media://image/live', coverSource: null }
  ]) {
    const result = await project(input, signal)
    assert.equal(result.cover, 'twilight-media://image/granted')
    assert.doesNotMatch(JSON.stringify(result), /https|token|private/)
  }
  assert.equal(sources.length, 3)
  assert.deepEqual(await project({ cover: 'file:///private.jpg', coverSource: null }, signal), { cover: null, coverSource: null })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(project({ cover: null, coverSource: null }, controller.signal), { name: 'AbortError' })
})

test('only approved non-expiring metadata is retained, and disk failures preserve display', async () => {
  let saves = 0
  const project = createArtworkProjection({ normalizeCachedCover: async h => h, migrateBase64Cover:()=>null,
    grant:()=> 'twilight-media://image/photo', resolve:()=>({source:'https://example.com/photo.jpg'}),
    retainMetadata:async()=>{saves++;throw Error('disk full')} })
  const signal=new AbortController().signal
  const input={cover:'https://example.com/photo.jpg',coverSource:null}
  await project(input,signal)
  await project({...input,retainMetadata:true,imageExpiresAt:Date.now()+1000},signal)
  assert.equal(saves,0)
  assert.equal((await project({...input,retainMetadata:true},signal)).cover,'twilight-media://image/photo')
  assert.equal(saves,1)
})

test('queue cover resolver recovers durable origins for issued grants and rejects unknown or expiring tokens cleanly', async () => {
  const resolveQueueCovers = createQueueCoverResolver({
    normalizeCachedCover: async (handle) => `${handle}`,
    migrateBase64Cover: () => 'cover://migrated.jpg',
    resolve: (handle) => {
      if (handle === 'twilight-media://image/durable')
        return { source: 'https://p2.music.126.net/song.jpg' }
      if (handle === 'twilight-media://image/expiring')
        return { source: 'https://p2.music.126.net/temp.jpg', expiresAt: 5000 }
      throw new Error('Unknown grant')
    }
  })
  const result = await resolveQueueCovers(
    {
      covers: [
        'twilight-media://image/durable',
        'twilight-media://image/expiring',
        'twilight-media://image/missing',
        'cover://local_hash.jpg?rev=1',
        'data:image/png;base64,AA=='
      ]
    },
    new AbortController().signal
  )
  assert.deepEqual(result, {
    'twilight-media://image/durable': {
      cover: null,
      coverSource: 'https://p2.music.126.net/song.jpg'
    },
    'twilight-media://image/expiring': { cover: null, coverSource: null },
    'twilight-media://image/missing': { cover: null, coverSource: null },
    'cover://local_hash.jpg?rev=1': { cover: 'cover://local_hash.jpg', coverSource: null },
    'data:image/png;base64,AA==': { cover: 'cover://migrated.jpg', coverSource: null }
  })
})
