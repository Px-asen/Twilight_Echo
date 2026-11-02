import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { LibraryDatabase, getLibraryDatabasePath } from '../../main/library/libraryDatabase.ts'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from '../../main/library/libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from '../../main/library/libraryDatabaseProtocol.ts'
import type { EntityMetadataDatabaseApi } from '../../shared/entityMetadata.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import { validEntityMetadataPayload } from '../../shared/entityMetadata.ts'
import { validCorePlatformPayload } from '../../shared/corePlatform.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider, MetadataIdentityError } from './entityMetadataProvider.ts'
import { MetadataHttp, MetadataHttpError } from './metadataHttp.ts'
import {
  PublicArtworkProvider,
  artworkUsageApproval,
  type PublicArtworkPolicy
} from './publicArtworkProvider.ts'

const ARTIST = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
const RELEASE = '1834eae1-741b-3c03-9ca5-0df3decb43ea'
const GROUP = 'b1392450-e666-3926-a536-22c65f834433'
const REPRESENTATIVE = '30702389-5c67-4438-9ea0-2351c8de0f1d'
const usage = { display: true, cache: true, crossSource: true, export: false }
const activePolicy: PublicArtworkPolicy = {
  enabled: true,
  publicServiceApproved: true,
  contact: 'https://github.com/Px-asen/Twilight_Echo',
  wikipediaText: false,
  commonsImages: true,
  caaUsage: usage
}
const signal = () => new AbortController().signal
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const caa = (release = RELEASE) => ({
  release: `https://musicbrainz.org/release/${release}`,
  images: [
    { id: '2', front: true, approved: false },
    { id: '3', front: false, approved: true },
    { id: '18174904878', edit: 48753629, front: true, approved: true }
  ]
})
function fixture() {
  const state = {
    policy: structuredClone(activePolicy),
    now: 1000,
    exactMissing: false,
    reciprocal: ARTIST,
    author: '<a href="https://commons.wikimedia.org/wiki/User:Example">A &amp; B</a>',
    license: 'https://creativecommons.org/licenses/by-sa/4.0/',
    extraLicense: {} as Record<string, { value: string }>,
    resource:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Artist.jpg/960px-Artist.jpg',
    calls: [] as URL[],
    index: caa()
  }
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    state.calls.push(url)
    if (url.hostname === 'coverartarchive.org') {
      if (url.pathname === `/release/${RELEASE}` && state.exactMissing)
        return new Response(null, { status: 404 })
      return json(url.pathname.startsWith('/release-group/') ? caa(REPRESENTATIVE) : state.index)
    }
    if (url.hostname === 'musicbrainz.org')
      return json(
        url.pathname.includes('/artist/')
          ? {
              id: ARTIST,
              name: 'Artist',
              type: 'Person',
              relations: [
                { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }
              ]
            }
          : { id: RELEASE, 'release-group': { id: GROUP } }
      )
    if (url.hostname === 'www.wikidata.org')
      return json({
        entities: {
          Q123: {
            id: 'Q123',
            claims: {
              P434: [{ mainsnak: { datavalue: { value: state.reciprocal } } }],
              P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Artist.jpg' } } }]
            }
          }
        }
      })
    return json({
      query: {
        pages: [
          {
            ns: 6,
            title: 'File:Artist.jpg',
            imageinfo: [
              {
                timestamp: '2026-01-01T00:00:00Z',
                thumburl: state.resource,
                extmetadata: {
                  Artist: { value: state.author },
                  LicenseUrl: { value: state.license },
                  Copyrighted: { value: 'True' },
                  ...state.extraLicense
                }
              }
            ]
          }
        ]
      }
    })
  }
  return {
    state,
    fetcher,
    provider: new PublicArtworkProvider(
      () => state.policy,
      fetcher,
      () => state.now
    )
  }
}
function seed(db: LibraryDatabase, kind: CatalogKind) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/music/one.flac',
        title: 'One',
        artist: 'Artist',
        album: 'Album',
        cover: 'cover://personal.jpg'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entityId = db.catalogQuery({ kind }).items[0].id
  const [candidate] = db.identificationPublish(
    db.identificationInput(entityId),
    [
      {
        provider: 'musicbrainz',
        matcherVersion: 'fixture-v1',
        name: 'Artist',
        summary: '',
        references: [
          {
            provider: 'musicbrainz',
            kind,
            idType: 'mbid',
            value: kind === 'artist' ? ARTIST : kind === 'release' ? RELEASE : GROUP
          }
        ],
        evidence: {
          origin: 'search',
          matches: [],
          missing: ['manual'],
          conflicts: [],
          incomplete: true,
          provenance: 'fixture'
        }
      }
    ],
    1000
  )
  db.identificationDecide(
    {
      candidateId: candidate.id,
      revision: candidate.revision,
      linkRevision: candidate.linkRevision,
      decision: 'confirm'
    },
    1001
  )
  return entityId
}
const asyncDb = (db: LibraryDatabase) =>
  new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Artwork task did not finish')
}

test('CAA selects approved front art, separates exact release from representative project art and preserves rights', async () => {
  const { state, provider } = fixture()
  const exact = await provider.enrich(
    { kind: 'release', externalId: RELEASE, language: 'en' },
    signal()
  )
  assert.equal(exact.artwork[0].scope, 'release')
  assert.equal(exact.artwork[0].sourceReleaseId, RELEASE)
  assert.equal(
    exact.artwork[0].resource,
    `https://coverartarchive.org/release/${RELEASE}/18174904878-500.jpg`
  )
  assert.match(exact.artwork[0].attribution.license, /Copyright/)
  assert.deepEqual(exact.artwork[0].usage, usage)
  state.exactMissing = true
  const fallback = await provider.enrich(
    { kind: 'release', externalId: RELEASE, language: 'en' },
    signal()
  )
  assert.equal(fallback.artwork[0].scope, 'album_project')
  assert.equal(fallback.artwork[0].targetId, GROUP)
  assert.equal(fallback.artwork[0].sourceReleaseId, REPRESENTATIVE)
  assert.ok(state.calls.some((url) => url.pathname === `/ws/2/release/${RELEASE}`))
  state.calls = []
  await provider.enrich({ kind: 'album_project', externalId: GROUP, language: 'en' }, signal())
  assert.equal(state.calls.length, 1)
})

test('CAA image permission is separate from CC0 metadata and Wikipedia text permission', async () => {
  const { state, provider } = fixture()
  state.policy.caaUsage = null
  assert.equal(provider.blockedReason('release'), 'caa_artwork_cache_not_approved')
  await assert.rejects(
    provider.enrich({ kind: 'release', externalId: RELEASE, language: 'en' }, signal()),
    MetadataHttpError
  )
  assert.equal(state.calls.length, 0)
  assert.equal(provider.blockedReason('artist'), null)
  state.policy.caaUsage = { ...usage, crossSource: false }
  assert.equal(provider.blockedReason('release'), 'caa_artwork_cross_source_not_approved')
  state.policy.caaUsage = { ...usage, expiresAt: 1000 }
  assert.equal(provider.blockedReason('release'), 'caa_artwork_cache_not_approved')
  assert.equal(artworkUsageApproval(undefined), null)
  assert.deepEqual(artworkUsageApproval(JSON.stringify(usage)), usage)
  assert.throws(() => artworkUsageApproval('{"cache":true}'))
})

test('wrong CAA release cannot supply art and missing front images remain empty', async () => {
  const { state, provider } = fixture()
  state.index = caa(REPRESENTATIVE)
  await assert.rejects(
    provider.enrich({ kind: 'release', externalId: RELEASE, language: 'en' }, signal()),
    MetadataIdentityError
  )
  state.index = caa()
  state.index.images = []
  const result = await provider.enrich(
    { kind: 'release', externalId: RELEASE, language: 'en' },
    signal()
  )
  // A confirmed group supplies explicitly labelled fallback, not an exact-release claim.
  assert.equal(result.artwork[0].scope, 'album_project')
})

test('Commons follows confirmed P18 and keeps per-file author, license, timestamp and plain attribution', async () => {
  const { state, provider } = fixture()
  const result = await provider.enrich(
    { kind: 'artist', externalId: ARTIST, language: 'zh-Hans' },
    signal()
  )
  const image = result.artwork[0]
  assert.equal(image.scope, 'artist')
  assert.equal(image.attribution.attribution, 'A & B')
  assert.equal(image.attribution.license, 'CC-BY-SA-4.0')
  assert.equal(image.attribution.revision, '2026-01-01T00:00:00Z')
  assert.equal(image.usage.export, true)
  assert.equal(
    state.calls.find((url) => url.hostname === 'commons.wikimedia.org')?.searchParams.get('titles'),
    'File:Artist.jpg'
  )
  assert.equal(
    state.calls.some((url) => url.hostname.endsWith('wikipedia.org')),
    false
  )
})

test('Commons structured public-domain templates without LicenseUrl require consistent rights fields', async () => {
  const { state, provider } = fixture()
  state.license = ''
  state.extraLicense = {
    License: { value: 'pd' }, LicenseShortName: { value: 'Public domain' },
    UsageTerms: { value: 'Public domain' }, Copyrighted: { value: 'False' }, Restrictions: { value: '' }
  }
  const image = (await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal())).artwork[0]
  assert.equal(image.attribution.license, 'Public domain')
  assert.match(image.attribution.licenseUrl, /Commons:Licensing/)
  for (const [key, value] of [['License', 'unknown'], ['Copyrighted', 'True'], ['UsageTerms', 'Noncommercial'], ['Restrictions', 'permission required']]) {
    const original = state.extraLicense[key]
    state.extraLicense[key] = { value }
    assert.deepEqual((await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal())).artwork, [])
    state.extraLicense[key] = original
  }
})

test('Commons missing author/license, restricted licenses, raw SVG and credential URLs are not image resources', async () => {
  const { state, provider } = fixture()
  for (const patch of [
    { author: '' },
    { license: '' },
    { license: 'https://creativecommons.org/licenses/by-nc/4.0/' },
    { resource: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.svg' },
    { resource: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg?token=private' }
  ]) {
    const before = { author: state.author, license: state.license, resource: state.resource }
    Object.assign(state, patch)
    assert.deepEqual(
      (await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal()))
        .artwork,
      []
    )
    Object.assign(state, before)
  }
  state.reciprocal = RELEASE
  await assert.rejects(
    provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal()),
    MetadataIdentityError
  )
})

test('current Commons thumbnail hosts and analytics parameters normalize without admitting signed queries', async () => {
  const { state, provider } = fixture()
  state.resource =
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Artist.jpg/960px-Artist.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail'
  const image = (
    await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal())
  ).artwork[0]
  assert.equal(
    image.resource,
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Artist.jpg/960px-Artist.jpg'
  )
  state.resource += '&Signature=private'
  assert.deepEqual(
    (await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal()))
      .artwork,
    []
  )
})

test('public metadata follows only the CAA JSON archive chain and shares concurrent consumers', async () => {
  const calls: URL[] = []
  const http = new MetadataHttp(async (input, init) => {
    const url = new URL(String(input))
    calls.push(url)
    assert.equal(init?.redirect, 'manual')
    if (url.hostname === 'coverartarchive.org')
      return new Response(null, {
        status: 307,
        headers: { Location: `https://archive.org/download/mbid-${RELEASE}/index.json` }
      })
    if (url.hostname === 'archive.org')
      return new Response(null, {
        status: 302,
        headers: { Location: `https://dn710702.ca.archive.org/0/items/mbid-${RELEASE}/index.json` }
      })
    return json(caa())
  }, 0)
  const url = `https://coverartarchive.org/release/${RELEASE}`
  const [a, b] = await Promise.all([http.fetch(url), http.fetch(url)])
  assert.equal(calls.length, 3)
  assert.deepEqual(await a.json(), await b.json())
  await assert.rejects(http.fetch(`https://archive.org/download/mbid-${RELEASE}/index.json`))
  await assert.rejects(http.fetch(`https://coverartarchive.org/release/${RELEASE}/front`))
})

test('CAA JSON redirects reject credentials, downgrade, foreign hosts, non-index resources, wrong IDs and loops', async () => {
  for (const target of [
    'http://archive.org/download/x/index.json',
    `https://u:p@archive.org/download/mbid-${RELEASE}/index.json`,
    `https://evil.test/download/mbid-${RELEASE}/index.json`,
    `https://archive.org/download/mbid-${RELEASE}/front.jpg`,
    `https://archive.org/download/mbid-${RELEASE}/index.json?token=private`
  ]) {
    let calls = 0
    const http = new MetadataHttp(async () => {
      calls++
      return new Response(null, { status: 307, headers: { Location: target } })
    }, 0)
    await assert.rejects(
      http.fetch(`https://coverartarchive.org/release/${RELEASE}`),
      /Unsupported CAA/
    )
    assert.equal(calls, 1)
  }
  for (const wrongId of [true, false]) {
    let calls = 0
    const http = new MetadataHttp(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            Location: `https://archive.org/download/mbid-${++calls === 1 || !wrongId ? RELEASE : REPRESENTATIVE}/index.json`
          }
        }),
      0
    )
    await assert.rejects(
      http.fetch(`https://coverartarchive.org/release/${RELEASE}`),
      /Unsupported CAA/
    )
    assert.ok(calls <= 4)
  }
})

test('artwork uses existing metadata byte limit, Retry-After and cancellation', async () => {
  const http = new MetadataHttp(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)), 0)
  await assert.rejects(http.fetch('https://commons.wikimedia.org/w/api.php'), /exceeds 2 MiB/)
  const provider = new PublicArtworkProvider(
    () => activePolicy,
    async () => new Response(null, { status: 503, headers: { 'Retry-After': '300' } }),
    () => 1000
  )
  await assert.rejects(
    provider.enrich({ kind: 'release', externalId: RELEASE, language: 'en' }, signal()),
    (e: MetadataHttpError) => e.status === 503 && e.retryAt === 301000
  )
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await assert.rejects(
    new PublicArtworkProvider(
      () => activePolicy,
      async () => json(caa())
    ).enrich({ kind: 'release', externalId: RELEASE, language: 'en' }, controller.signal),
    /stop/
  )
})

test('durable images re-project after DB/Core replacement, never appear as raw public facts, and detach hides them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-artwork-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const entityId = seed(db, 'release')
  const { state, provider, fetcher } = fixture()
  let grants = 0
  const create = () =>
    new CoreEntityMetadataService({
      database: asyncDb(db),
      provider: new MusicBrainzWikiProvider(() => state.policy, fetcher),
      enrichmentProviders: () => [provider],
      policy: () => state.policy,
      now: () => state.now,
      changed() {},
      failed(error) {
        throw error
      },
      artwork: async (image) => {
        assert.match(image.resource, /^https:\/\/coverartarchive.org/)
        return `twilight-media://image/session-${++grants}`
      }
    })
  let core = create()
  const job = await core.enrich({
    entityId,
    language: 'en',
    batchId: 'test',
    provider: 'public-artwork'
  })
  core.activate()
  await until(async () => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
  const first = await core.detail(entityId, 'en')
  assert.equal(first.artwork?.[0].scope, 'release')
  assert.deepEqual(first.artwork?.[0].targetRef, {
    provider: 'musicbrainz',
    kind: 'release',
    idType: 'mbid',
    value: RELEASE
  })
  assert.equal(first.artwork?.[0].handle, 'twilight-media://image/session-1')
  assert.doesNotMatch(
    JSON.stringify(first),
    /coverartarchive.org|resource|providerContext|personal.jpg/
  )
  assert.equal(first.facts.length, 0)
  const stored = db.metadataArtwork(entityId, {
    artworkContext: provider.context(),
    now: state.now
  })
  assert.match(stored[0].resource, /coverartarchive.org/)
  assert.doesNotMatch(JSON.stringify(stored), /twilight-media/)
  const calls = state.calls.length
  await core.shutdown()
  db.close()
  db = new LibraryDatabase(path)
  core = create()
  const second = await core.detail(entityId, 'en')
  assert.equal(second.artwork?.[0].handle, 'twilight-media://image/session-2')
  assert.equal(state.calls.length, calls)
  assert.equal(db.queryTracks({ limit: 1 }).tracks[0].cover, 'cover://personal.jpg')
  const link = db.identificationDetail(entityId).link!
  db.identificationDetach(link.id, link.revision, state.now)
  assert.equal((await core.detail(entityId, 'en')).artwork, undefined)
  await core.shutdown()
})

test('collection reads can include permitted automatic portraits without sharing a source hidden state', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'artist'), { state, provider } = fixture()
  db.metadataEnqueue({ entityId, type: 'enrich', language: 'en', batchId: 'portrait',
    provider: 'public-artwork', providerContext: provider.context() }, state.now)
  const work = db.metadataClaim(state.now)!
  const result = await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal())
  db.metadataFinish(work, { state: 'completed', outcome: 'matched', ...result }, state.now)
  const before = db.metadataDetail(entityId, 'en', { now: state.now })
  db.metadataArtworkOverride({ entityId, revision: before.revision, mode: 'clear', language: 'en' }, state.now)
  let handles = 0
  const core = new CoreEntityMetadataService({
    database: asyncDb(db), policy: () => state.policy,
    provider: new MusicBrainzWikiProvider(() => state.policy),
    enrichmentProviders: () => [provider], now: () => state.now, changed() {}, failed() {},
    artwork: async () => { handles++; return 'twilight-media://image/shared-portrait' }
  })
  t.after(() => core.shutdown())
  assert.equal((await core.detail(entityId, 'en', 'local')).artwork, undefined)
  assert.equal(handles, 0, 'ordinary personal reads keep their original contract')
  const shared = await core.detail(entityId, 'en', 'local', true)
  assert.equal(shared.artworkOverride?.mode, 'clear')
  assert.equal(shared.artwork?.[0].handle, 'twilight-media://image/shared-portrait')
  state.policy.commonsImages = false
  assert.equal((await core.detail(entityId, 'en', 'local', true)).artwork, undefined)
  const query = { entityId, language: 'en', includeAutomaticArtwork: true }
  assert.equal(validEntityMetadataPayload('metadata.entity.detail', query), true)
  assert.equal(validEntityMetadataPayload('metadata.entity.detail', { ...query, includeAutomaticArtwork: 'yes' }), false)
})

for (const change of ['unrelated', 'detach', 'hide'] as const)
  test(`portrait materialization tolerates unrelated commits but fences source edits: ${change}`, async (t) => {
    const db = new LibraryDatabase(':memory:')
    t.after(() => db.close())
    const entityId = seed(db, 'artist'), { state, provider } = fixture()
    db.metadataEnqueue({ entityId, type: 'enrich', language: 'en', batchId: 'portrait',
      provider: 'public-artwork', providerContext: provider.context() }, state.now)
    const work = db.metadataClaim(state.now)!
    const result = await provider.enrich({ kind: 'artist', externalId: ARTIST, language: 'en' }, signal())
    db.metadataFinish(work, { state: 'completed', outcome: 'matched', ...result }, state.now)
    let release!: () => void, projecting = false
    const core = new CoreEntityMetadataService({
      database: asyncDb(db), policy: () => state.policy,
      provider: new MusicBrainzWikiProvider(() => state.policy),
      enrichmentProviders: () => [provider], now: () => state.now, changed() {}, failed() {},
      artwork: async () => {
        projecting = true
        await new Promise<void>((resolve) => { release = resolve })
        return 'twilight-media://image/late-portrait'
      }
    })
    t.after(() => core.shutdown())
    const reading = core.detail(entityId, 'en', 'local')
    // Observe a rejection immediately rather than leaving a pending read unhandled.
    const settled = reading.then((value) => ({ value }), (error: { code: string }) => ({ error }))
    await until(async () => projecting)
    if (change === 'detach') {
      const link = db.identificationDetail(entityId).link!
      await core.detachIdentity(link.id, link.revision)
    } else if (change === 'hide') {
      await core.artworkOverride({ entityId, language: 'en', mode: 'clear',
        revision: db.metadataDetail(entityId, 'en').revision })
    } else {
      const other = db.catalogQuery({ kind: 'release' }).items[0].id
      await core.override({ entityId: other, language: 'en', mode: 'value', value: 'Other album',
        revision: db.metadataDetail(other, 'en').revision })
    }
    release()
    const read = await settled
    if (change === 'unrelated') {
      assert.ok('value' in read)
      assert.equal(read.value.artwork?.[0].handle, 'twilight-media://image/late-portrait')
    } else {
      assert.ok('error' in read)
      assert.equal(read.error.code, 'STALE_IDENTITY')
    }
  })

test('image expiry and deployment context hide and retire only automatic resources', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'release'),
    { state, provider } = fixture()
  state.policy.caaUsage = { ...usage, expiresAt: 2000 }
  db.metadataEnqueue(
    {
      entityId,
      type: 'enrich',
      language: 'en',
      batchId: 'one',
      provider: 'public-artwork',
      providerContext: provider.context()
    },
    state.now
  )
  const work = db.metadataClaim(state.now)!,
    result = await provider.enrich(
      { kind: 'release', externalId: RELEASE, language: 'en' },
      signal()
    )
  db.metadataFinish(work, { state: 'completed', outcome: 'matched', ...result }, state.now)
  assert.equal(
    db.metadataArtwork(entityId, { artworkContext: provider.context(), now: 1000 }).length,
    1
  )
  assert.equal(db.metadataArtwork(entityId, { artworkContext: 'changed', now: 1000 }).length, 0)
  const before = db.metadataDetail(entityId, 'en', { now: state.now })
  db.metadataOverride(
    { entityId, revision: before.revision, mode: 'value', value: 'My note', language: 'en' },
    1001
  )
  assert.equal(db.metadataNextAttempt(), 2000)
  state.now = 2000
  assert.equal(
    db.metadataArtwork(entityId, { artworkContext: provider.context(), now: state.now }).length,
    0
  )
  db.metadataClaim(state.now)
  assert.equal(db.metadataNextAttempt(), null)
  assert.equal(db.metadataDetail(entityId, 'en').introduction?.value, 'My note')
  assert.equal(db.identificationDetail(entityId).link?.state, 'confirmed')
})

test('new public artwork demand accepts no caller URL and the platform projection validates optional expiry', () => {
  const request = { entityId: 'one', language: 'en', batchId: 'a', provider: 'public-artwork' }
  assert.equal(validEntityMetadataPayload('metadata.entity.enrich', request), true)
  assert.equal(
    validEntityMetadataPayload('metadata.entity.enrich', {
      ...request,
      url: 'https://evil.test/a.jpg'
    }),
    false
  )
  const envelope = {
    kind: 'core:platform' as const,
    epoch: 'a',
    requestId: 'a',
    name: 'artwork.present' as const,
    payload: { cover: null, coverSource: null, imageExpiresAt: 2000 }
  }
  assert.equal(validCorePlatformPayload(envelope), true)
  assert.equal(
    validCorePlatformPayload({ ...envelope, payload: { ...envelope.payload, imageExpiresAt: -1 } }),
    false
  )
})

test('artwork resources cross the actual database worker boundary and recover without persisting session grants', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'artwork-worker-')),
    path = join(root, 'library.json')
  const db = new LibraryDatabase(getLibraryDatabasePath(path)),
    entityId = seed(db, 'artist')
  db.close()
  const children: ChildProcess[] = []
  const create = () =>
    new LibraryDatabaseServiceClient({
      libraryFilePath: path,
      serviceEntry: fileURLToPath(
        new URL('../../main/library/libraryDatabaseService.ts', import.meta.url)
      ),
      fork: (entry) => {
        const child = fork(entry, [], {
          execArgv: ['--experimental-strip-types'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        })
        children.push(child)
        Object.assign(child, {
          postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
        })
        return child as unknown as DatabaseUtilityProcess
      }
    })
  let client = create()
  t.after(async () => {
    await client.close()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  const { provider } = fixture()
  const job = await client.metadataEnqueue(
    {
      entityId,
      type: 'enrich',
      language: 'en',
      batchId: 'worker',
      provider: 'public-artwork',
      providerContext: provider.context()
    },
    1000
  )
  const work = await client.metadataClaim(1000)
  assert.equal(work?.job.id, job.id)
  const result = await provider.enrich(
    { kind: 'artist', externalId: ARTIST, language: 'en' },
    signal()
  )
  assert.equal(
    await client.metadataFinish(work!, { state: 'completed', outcome: 'matched', ...result }, 1001),
    true
  )
  const images = await client.metadataArtwork(entityId, {
    artworkContext: provider.context(),
    now: 1001
  })
  assert.equal(images[0].attribution.license, 'CC-BY-SA-4.0')
  assert.doesNotMatch(
    JSON.stringify(await client.metadataDetail(entityId, 'en')),
    /upload.wikimedia|resource|providerContext/
  )
  await client.close()
  if (children[0].exitCode === null && children[0].signalCode === null)
    await once(children[0], 'exit')
  client = create()
  assert.deepEqual(
    await client.metadataArtwork(entityId, { artworkContext: provider.context(), now: 1001 }),
    images
  )
})

test('late cancelled artwork never publishes, missing refresh preserves existing art and mixed identity snapshots are rejected', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const entityId = seed(db, 'release'),
    { provider } = fixture()
  const demand = {
    entityId,
    type: 'enrich' as const,
    language: 'en' as const,
    batchId: 'one',
    provider: 'public-artwork',
    providerContext: provider.context()
  }
  const job = db.metadataEnqueue(demand, 1000),
    work = db.metadataClaim(1000)!
  const result = await provider.enrich(
    { kind: 'release', externalId: RELEASE, language: 'en' },
    signal()
  )
  db.metadataCancel(job.id, 'one', 1001)
  assert.equal(
    db.metadataFinish(work, { state: 'completed', outcome: 'matched', ...result }, 1002),
    false
  )
  assert.deepEqual(
    db.metadataArtwork(entityId, { artworkContext: provider.context(), now: 1002 }),
    []
  )
  db.metadataEnqueue({ ...demand, batchId: 'two' }, 1003)
  db.metadataFinish(
    db.metadataClaim(1003)!,
    { state: 'completed', outcome: 'matched', ...result },
    1004
  )
  const before = db.metadataArtwork(entityId, { artworkContext: provider.context(), now: 1004 })
  const later = 1004 + 86400001
  db.metadataEnqueue({ ...demand, batchId: 'three' }, later)
  db.metadataFinish(
    db.metadataClaim(later)!,
    { state: 'completed', outcome: 'not_found', facts: [], artwork: [] },
    later
  )
  assert.deepEqual(
    db.metadataArtwork(entityId, { artworkContext: provider.context(), now: later }),
    before
  )
  assert.throws(
    () =>
      db.metadataArtwork(entityId, {
        artworkContext: provider.context(),
        artworkTargetId: 'old-target',
        now: later
      }),
    { code: 'STALE_REVISION' }
  )
})
