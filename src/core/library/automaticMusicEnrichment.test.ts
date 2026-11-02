import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { MusicExternalReference } from '../../shared/musicIdentification.ts'
import type {
  IdentificationScheduleRequest,
  MusicIdentificationSettings
} from '../../shared/musicIdentificationSchedule.ts'
import { normalizeMusicIdentificationSettings } from '../../shared/musicIdentificationSchedule.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataFact,
  EntityMetadataLanguage
} from '../../shared/entityMetadata.ts'
import type { MetadataDetailProvider } from './metadataDetailProvider.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'
import { PlatformIdentificationProvider } from './musicIdentificationProvider.ts'
import { PlatformMetadataProvider } from './platformMetadataProvider.ts'

const kinds: CatalogKind[] = ['artist', 'recording', 'release', 'album_project']
const mbid = '00000000-0000-4000-8000-000000000042'
const policy = { enabled: true, publicServiceApproved: false, contact: '', wikipediaText: false }
const configuration = (
  patch: Partial<IdentificationScheduleRequest> = {}
): IdentificationScheduleRequest => ({
  enabled: true,
  newImports: true,
  history: false,
  providers: [],
  enrichment: {
    language: 'zh-Hans',
    providers: [{ id: 'platform.ncm', context: 'a', kinds: ['artist', 'release'] }]
  },
  ...patch
})
function seed(db: LibraryDatabase) {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'local',
        source: 'local',
        filePath: 'D:/music/Album/song.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        duration: 200
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  let batch = db.catalogSync({ kind: 'begin', revision: 1 })
  batch = db.catalogSync({
    kind: 'append',
    ...batch,
    tracks: [
      {
        id: 'ncm:7',
        source: 'ncm',
        filePath: '',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        duration: 200,
        albumId: '42',
        artists: [{ id: 42, name: 'Artist' }],
        fileName: '',
        size: 0,
        cover: null,
        lyrics: null
      }
    ]
  })
  db.catalogSync({ kind: 'commit', ...batch })
}
const entity = (db: LibraryDatabase, source = 'local', kind: CatalogKind = 'artist') =>
  db.catalogQuery({ source, kind }).items[0].id
function confirm(db: LibraryDatabase, entityId: string, references?: MusicExternalReference[]) {
  const input = db.identificationInput(entityId)
  const [candidate] = db.identificationPublish(
    input,
    [
      {
        provider: 'ncm',
        name: input.name,
        summary: '',
        matcherVersion: 'manual-fixture',
        references: references ?? [
          { provider: 'ncm', kind: input.kind, idType: 'native', value: '42' }
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
  return db.identificationDecide(
    {
      candidateId: candidate.id,
      revision: candidate.revision,
      linkRevision: candidate.linkRevision,
      decision: 'confirm'
    },
    1001
  )
}
function drain(db: LibraryDatabase, request = configuration(), now = 2000) {
  for (let i = 0; i < 100; i++) if (!db.identificationSchedule(request, now).more) return
  assert.fail('Outbox did not drain')
}
function fixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  seed(db)
  return db
}
const fact = (
  value = '介绍',
  language: EntityMetadataLanguage = 'zh-Hans'
): EntityMetadataFact => ({
  field: 'introduction',
  value,
  language,
  attribution: {
    provider: 'fixture',
    externalId: '42',
    url: 'https://example.com/artist/42',
    license: 'CC0',
    licenseUrl: '',
    revision: '1',
    attribution: 'Fixture',
    retrievedAt: 2000
  }
})
const completed = () => ({
  state: 'completed' as const,
  outcome: 'matched' as const,
  facts: [fact()]
})
function asyncDb(db: LibraryDatabase): EntityMetadataDatabaseApi {
  return new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...a: unknown[]) => unknown).apply(db, args)
  })
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Automatic enrichment timed out')
}
function core(
  db: LibraryDatabase,
  provider: MetadataDetailProvider,
  settings: MusicIdentificationSettings,
  options = {}
) {
  return new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: new MusicBrainzWikiProvider(() => policy),
    enrichmentProviders: () => [provider],
    automation: () => settings,
    policy: () => policy,
    now: () => 2000,
    changed() {},
    failed: (e) => assert.fail(String(e)),
    ...options
  })
}

test('unconfirmed same-name sources never fetch details; confirmed local and streaming consumers share one job', (t) => {
  const db = fixture(t)
  drain(db)
  assert.equal(db.metadataJobs({}).total, 0)
  const local = entity(db),
    online = entity(db, 'ncm')
  confirm(db, local)
  confirm(db, online)
  drain(db)
  assert.equal(db.metadataJobs({}).total, 1)
  const work = db.metadataClaim(2000)!
  assert.equal(work.job.type, 'enrich')
  assert.notEqual(work.job.entityId, local)
  assert.notEqual(work.job.entityId, online)
  assert.equal(work.automatic!.origin, 'new')
  assert.equal(
    db.sql.prepare('SELECT count(*) n FROM metadata_demands WHERE job_id=?').get(work.job.id)!.n,
    2
  )
  db.metadataFinish(work, completed(), 2001, configuration())
  assert.equal(db.metadataDetail(local, 'zh-Hans').introduction!.value, '介绍')
  assert.equal(db.metadataDetail(online, 'zh-Hans').introduction!.value, '介绍')
  assert.equal(db.metadataDetail(entity(db, 'local', 'release'), 'zh-Hans').introduction, null)
})

test('confirmed artist follow-ups reach the next bounded schedule page ahead of an identification backlog', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2, revision: 1, folders: [], exclusions: [],
    tracks: Array.from({ length: 125 }, (_, i) => ({
      id: `local-${i}`, source: 'local', filePath: `D:/music/${i}.flac`,
      title: `Song ${i}`, artist: `Artist ${i}`, album: '', duration: 200
    }))
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  drain(db)
  const id = String(db.sql.prepare(`SELECT s.entity_id FROM metadata_identification_schedule s
    JOIN catalog_entities e ON e.id=s.entity_id WHERE e.kind='artist' ORDER BY s.id DESC LIMIT 1`).get()!.entity_id)
  const target = confirm(db, id).link!.targetId!
  db.sql.exec('UPDATE metadata_identification_schedule SET dirty=1')
  assert.ok(db.identificationScheduleStatus().pending > 200)
  const scheduled = db.identificationSchedule(configuration(), 2000)
  assert.equal(scheduled.processed, 200)
  assert.equal(scheduled.more, true)
  const work = db.metadataClaim(2000)
  assert.equal(work?.job.type, 'enrich', 'known identities must not wait behind unrelated search pages')
  assert.equal(work?.job.entityId, target)
  db.metadataFinish(work!, completed(), 2001, configuration())
  assert.equal(db.metadataDetail(id, 'zh-Hans').introduction?.value, '介绍')
})

test('automatic portraits already queued are not overtaken by later album detail jobs', (t) => {
  const db = fixture(t)
  const artist = entity(db), release = entity(db, 'local', 'release')
  confirm(db, artist)
  drain(db)
  confirm(db, release)
  drain(db, configuration(), 2001)
  const work = db.metadataClaim(2001)!
  assert.equal(work.job.type, 'enrich')
  assert.equal(work.job.entityKind, 'artist')
  db.metadataFinish(work, completed(), 2002, configuration())
  assert.equal(db.metadataDetail(artist, 'zh-Hans').introduction?.value, '介绍')
  assert.equal(db.metadataClaim(2002)?.job.entityKind, 'release')
})

for (const running of [false, true])
  test(`${running ? 'running' : 'queued'} automatic biography work survives a pending local catalog projection`, t => {
    const db = fixture(t), id = entity(db)
    confirm(db, id)
    drain(db)
    const original = db.metadataJobs({}).items[0]
    const work = running ? db.metadataClaim(2000)! : null
    const version = db.getTracksByIds(['local']).versions.local
    db.patchTracks([{ id: 'local', expectedVersion: version, patch: { lyrics: 'Updated local lyrics' } }])
    if (work) assert.equal(db.metadataFinish(work, completed(), 2001, configuration()), false)
    else assert.equal(db.metadataClaim(2000), null)
    assert.equal(db.metadataJobs({ jobId: original.id }).items[0].state, 'queued')
    assert.equal(db.metadataDetail(id, 'zh-Hans').introduction, null)
    while (db.catalogStatus().localPending) db.catalogAdvance()
    drain(db, configuration(), 2101)
    const resumed = db.metadataClaim(2101)!
    assert.equal(resumed.job.id, original.id)
    if (work) assert.equal(db.metadataFinish(work, completed(), 2102, configuration()), false)
    assert.equal(db.metadataFinish(resumed, completed(), 2102, configuration()), true)
    assert.equal(db.metadataDetail(id, 'zh-Hans').introduction!.value, '介绍')
  })

test('pending first-import consent prevents automatic requests even with enabled scope switches; accepting resumes the durable scheduler', async t => {
  const db = fixture(t), id = entity(db)
  confirm(db, id)
  let calls = 0
  const settings: MusicIdentificationSettings = { newImports: true, history: true,
    sources: ['platform.ncm'], setup: 'pending' }
  const service = core(db, { id: 'platform.ncm', supports: kind => kind === 'artist',
    blockedReason: () => null, context: () => 'fixture', enrich: async () => {
      calls++; return { facts: [fact()], availability: 'available' }
    } }, settings)
  t.after(() => service.shutdown())
  service.activate()
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
  assert.equal(db.metadataJobs({}).total, 0)
  settings.setup = 'accepted'
  service.refreshIdentification(true)
  await until(() => db.metadataJobs({}).items.some(job => job.state === 'completed'))
  assert.equal(calls, 1)
  assert.equal(db.metadataDetail(id, 'zh-Hans').introduction?.value, '介绍')
})

test('same-name confirmed identities remain separate when their typed native IDs differ', (t) => {
  const db = fixture(t),
    local = entity(db),
    online = entity(db, 'ncm')
  confirm(db, local)
  confirm(db, online, [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '43' }])
  drain(db)
  assert.equal(db.metadataJobs({}).total, 2)
  const work = db.metadataClaim(2000)!
  db.metadataFinish(work, completed(), 2001, configuration())
  assert.equal(
    [local, online].filter((id) => db.metadataDetail(id, 'zh-Hans').introduction).length,
    1
  )
})

test('confirmed project, pressing, recording and artist fetch only supported typed MB details', (t) => {
  const db = fixture(t)
  for (const kind of kinds)
    confirm(db, entity(db, 'local', kind), [
      { provider: 'musicbrainz', kind, idType: 'mbid', value: mbid }
    ])
  const request = configuration({
    enrichment: {
      language: 'en',
      providers: [
        { id: 'musicbrainz-details', context: 'public', kinds },
        { id: 'public-artwork', context: 'images', kinds: ['artist', 'album_project', 'release'] }
      ]
    }
  })
  drain(db, request)
  const jobs = db.metadataJobs({}).items
  assert.equal(jobs.length, 7)
  assert.deepEqual(
    jobs
      .filter((j) => j.provider === 'musicbrainz-details')
      .map((j) => j.entityKind)
      .sort(),
    [...kinds].sort()
  )
  assert.equal(
    jobs.some((j) => j.provider === 'public-artwork' && j.entityKind === 'recording'),
    false
  )
  for (const job of jobs) assert.equal(job.externalId, mbid)
})

test('all 16 selected sources can schedule the two public adapters and 15 platform adapters', (t) => {
  const db = fixture(t)
  confirm(db, entity(db), [
    { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: mbid }
  ])
  const request = configuration({
    enrichment: {
      language: 'en',
      providers: [
        { id: 'musicbrainz-details', context: 'public', kinds: ['artist'] },
        { id: 'public-artwork', context: 'images', kinds: ['artist'] },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `platform.fixture${i}`,
          context: 'a',
          kinds: ['artist' as const]
        }))
      ]
    }
  })
  drain(db, request)
  assert.equal(db.metadataJobs({}).total, 2)
})

test('adding a reference marks every linked source dirty and unlocks its newly available provider', (t) => {
  const db = fixture(t),
    local = entity(db),
    online = entity(db, 'ncm')
  confirm(db, local)
  confirm(db, online)
  const request = configuration({
    enrichment: {
      language: 'en',
      providers: [
        { id: 'platform.ncm', context: 'a', kinds: ['artist'] },
        { id: 'musicbrainz-details', context: 'b', kinds: ['artist'] }
      ]
    }
  })
  drain(db, request)
  confirm(db, online, [
    { provider: 'ncm', kind: 'artist', idType: 'native', value: '42' },
    { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: mbid }
  ])
  assert.equal(db.identificationScheduleStatus().pending, 2)
  drain(db, request)
  const job = db.metadataJobs({}).items.find((j) => j.provider === 'musicbrainz-details')!
  assert.equal(
    db.sql.prepare('SELECT count(*) n FROM metadata_demands WHERE job_id=?').get(job.id)!.n,
    2
  )
})

test('enrichment enqueue, demand and outbox acknowledgement roll back together; replay after lost receipt is idempotent', (t) => {
  const db = fixture(t)
  confirm(db, entity(db))
  db.sql.exec(
    "CREATE TRIGGER fail_enrich BEFORE INSERT ON metadata_demands BEGIN SELECT RAISE(ABORT,'enrich failed'); END"
  )
  assert.throws(() => drain(db), /enrich failed/)
  assert.equal(db.metadataJobs({}).total, 0)
  assert.ok(db.identificationScheduleStatus().pending > 0)
  db.sql.exec('DROP TRIGGER fail_enrich')
  drain(db)
  const before = db.metadataJobs({}).items
  db.sql.exec('UPDATE metadata_identification_schedule SET dirty=1')
  drain(db)
  assert.deepEqual(db.metadataJobs({}).items, before)
})

test('restart resumes interrupted shared work and later reopens reuse the saved result', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'automatic-enrich-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  seed(db)
  const id = entity(db)
  drain(db)
  confirm(db, id)
  db.close()
  db = new LibraryDatabase(path)
  drain(db)
  const old = db.metadataClaim(2000)!
  db.close()
  db = new LibraryDatabase(path)
  db.metadataRecover(2001)
  const current = db.metadataClaim(2001)!
  assert.equal(current.job.id, old.job.id)
  assert.equal(current.job.generation, old.job.generation + 1)
  assert.equal(db.metadataFinish(old, completed(), 2002, configuration()), false)
  assert.equal(db.metadataFinish(current, completed(), 2002, configuration()), true)
  assert.equal(db.metadataDetail(id, 'zh-Hans').introduction!.value, '介绍')
  const saved = db.metadataJobs({}).items
  db.close()
  db = new LibraryDatabase(path)
  const later = 2002 + 2 * 86400000
  db.metadataRecover(later)
  // A refreshed scheduler/configuration check must not turn a saved result
  // into a fresh network lookup, even beyond the explicit lookup's cache TTL.
  db.sql.exec('UPDATE metadata_identification_schedule SET dirty=1')
  drain(db, configuration(), later)
  assert.deepEqual(db.metadataJobs({}).items, saved)
  assert.equal(db.metadataClaim(later), null)
  assert.equal(db.metadataDetail(id, 'zh-Hans').introduction!.value, '介绍')
})

for (const explicit of [false, true])
  test(`settings disable fences running enrichment with ${explicit ? 'an explicit shared' : 'only automatic'} consumer`, (t) => {
    const db = fixture(t),
      id = entity(db)
    confirm(db, id)
    drain(db)
    const work = db.metadataClaim(2000)!
    if (explicit)
      db.metadataEnqueue(
        {
          entityId: id,
          batchId: 'explicit',
          type: 'enrich',
          language: 'zh-Hans',
          provider: 'platform.ncm',
          providerContext: 'a'
        },
        2000
      )
    db.metadataFinish(work, completed(), 2001, configuration({ newImports: false }))
    assert.equal(
      db.metadataJobs({ jobId: work.job.id }).items[0].state,
      explicit ? 'completed' : 'blocked'
    )
    assert.equal(!!db.metadataDetail(id, 'zh-Hans').introduction, explicit)
    drain(db, configuration({ newImports: false }))
    assert.equal(
      db.sql.prepare('SELECT count(*) n FROM metadata_demands').get()!.n,
      explicit ? 1 : 0
    )
  })

for (const change of ['language', 'context', 'source'] as const)
  test(`${change} changes remove old automatic demand and fence a late response`, (t) => {
    const db = fixture(t),
      id = entity(db)
    confirm(db, id)
    drain(db)
    const work = db.metadataClaim(2000)!
    const request = configuration({
      enrichment: {
        language: change === 'language' ? 'en' : 'zh-Hans',
        providers:
          change === 'source'
            ? []
            : [{ id: 'platform.ncm', context: change === 'context' ? 'b' : 'a', kinds: ['artist'] }]
      }
    })
    db.metadataFinish(work, completed(), 2001, request)
    assert.equal(db.metadataDetail(id, 'zh-Hans').introduction, null)
    drain(db, request)
    const jobs = db.metadataJobs({}).items
    assert.equal(jobs.find((j) => j.id === work.job.id)!.state, 'cancelled')
    if (change !== 'source') {
      const next = db.metadataClaim(2001)!
      assert.notEqual(next.job.id, work.job.id)
      assert.equal(next.job.language, request.enrichment!.language)
      assert.equal(next.job.providerContext, request.enrichment!.providers[0].context)
    }
  })

test('a detached consumer cannot publish late details; another confirmed consumer keeps the same task usable', (t) => {
  const db = fixture(t),
    local = entity(db),
    online = entity(db, 'ncm')
  confirm(db, local)
  confirm(db, online)
  drain(db)
  const work = db.metadataClaim(2000)!
  const link = db.identificationDetail(local).link!
  db.identificationDetach(link.id, link.revision, 2001)
  assert.equal(db.metadataFinish(work, completed(), 2002, configuration()), true)
  assert.equal(db.metadataDetail(local, 'zh-Hans').introduction, null)
  assert.equal(db.metadataDetail(online, 'zh-Hans').introduction!.value, '介绍')
  drain(db)
  assert.equal(db.metadataJobs({}).total, 1)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_demands').get()!.n, 1)
})

for (const action of ['detach', 'remove'] as const)
  test(`last-consumer ${action} fences a running automatic target result`, (t) => {
    const db = fixture(t),
      id = entity(db)
    confirm(db, id)
    drain(db)
    const work = db.metadataClaim(2000)!
    if (action === 'detach') {
      const link = db.identificationDetail(id).link!
      db.identificationDetach(link.id, link.revision, 2001)
    } else db.replaceDocument({ version: 2, revision: 2, folders: [], exclusions: [], tracks: [] })
    db.metadataFinish(work, completed(), 2002, configuration())
    assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_facts').get()!.n, 0)
    assert.equal(db.metadataJobs({ jobId: work.job.id }).items[0].reason, 'not_library_member')
    db.metadataRecover(2003)
    assert.equal(db.metadataClaim(2003), null)
  })

test('removal before catalog projection catches up prevents an automatic HTTP claim', (t) => {
  const db = fixture(t),
    id = entity(db)
  confirm(db, id)
  drain(db)
  db.replaceDocument({ version: 2, revision: 2, folders: [], exclusions: [], tracks: [] })
  assert.equal(db.catalogStatus().localPending, true)
  assert.equal(db.metadataClaim(2000), null)
  assert.equal(db.metadataJobs({}).items[0].reason, 'not_library_member')
})

test('history permission is evaluated across all shared consumers, not the first new-import row', (t) => {
  const db = fixture(t),
    local = entity(db),
    online = entity(db, 'ncm')
  confirm(db, local)
  confirm(db, online)
  db.sql.exec(
    "DELETE FROM metadata_identification_schedule; INSERT INTO metadata_identification_schedule(entity_id,origin) SELECT entity_id,'history' FROM metadata_identity_links"
  )
  const request = configuration({ newImports: false, history: true })
  drain(db, request)
  const work = db.metadataClaim(2000)!
  assert.equal(work.automatic!.historical, true)
  assert.equal(work.automatic!.origin, 'history')
  db.metadataFinish(work, completed(), 2001, request)
  assert.equal(db.metadataJobs({ jobId: work.job.id }).items[0].state, 'completed')
})

test('manual values, clear and restore retain precedence over automatic shared facts', (t) => {
  const db = fixture(t),
    id = entity(db)
  confirm(db, id)
  db.metadataOverride(
    {
      entityId: id,
      revision: db.metadataDetail(id, 'zh-Hans').revision,
      language: 'zh-Hans',
      mode: 'value',
      value: '我的介绍'
    },
    1002
  )
  drain(db)
  db.metadataFinish(db.metadataClaim(2000)!, completed(), 2001, configuration())
  let detail = db.metadataDetail(id, 'zh-Hans')
  assert.equal(detail.introduction!.value, '我的介绍')
  detail = db.metadataOverride(
    { entityId: id, revision: detail.revision, language: 'zh-Hans', mode: 'clear' },
    2002
  )
  assert.equal(detail.introduction, null)
  detail = db.metadataOverride(
    { entityId: id, revision: detail.revision, language: 'zh-Hans', mode: 'reset' },
    2003
  )
  assert.equal(detail.introduction!.value, '介绍')
})

for (const state of ['failed', 'blocked', 'completed'] as const)
  test(`${state} enrichment is not endlessly restarted by polling or unchanged catalog publication`, (t) => {
    const db = fixture(t),
      id = entity(db)
    confirm(db, id)
    drain(db)
    const work = db.metadataClaim(2000)!
    db.metadataFinish(
      work,
      state === 'completed'
        ? { state, outcome: 'not_found', facts: [] }
        : { state, reason: 'fixture' },
      2001,
      configuration()
    )
    const before = db.metadataJobs({}).items
    db.sql.exec('UPDATE metadata_identification_schedule SET dirty=1')
    drain(db, configuration(), 90000000)
    seed(db)
    drain(db, configuration(), 90000001)
    assert.deepEqual(db.metadataJobs({}).items, before)
  })

test('Core immediately follows native identity confirmation with actual platform artist and album metadata', async (t) => {
  const db = fixture(t)
  const inventory = () => [
    {
      id: 'ncm',
      enabled: true,
      configuration: 'a',
      supportedMethods: [
        'searchSongs',
        'searchArtists',
        'searchAlbums',
        'fetchArtistMetadata',
        'fetchAlbumMetadata'
      ]
    }
  ]
  const calls: string[] = []
  const identifier = new PlatformIdentificationProvider('ncm', {
    inventory,
    search: async () => ({ items: [], total: 0 })
  })
  const provider = new PlatformMetadataProvider('ncm', {
    inventory,
    now: () => 2000,
    usage: () => ({ display: true, cache: true, crossSource: true, export: false }),
    call: async (_provider, method, id) => {
      calls.push(method)
      return {
        status: 'ok',
        metadata: {
          schemaVersion: 1,
          provider: 'ncm',
          kind: method === 'fetchArtistMetadata' ? 'artist' : 'release',
          id,
          name: 'Fixture',
          texts: [
            {
              field: 'introduction',
              value: `平台介绍 ${method}`,
              language: 'zh-Hans',
              url: 'https://music.163.com/',
              revision: '1',
              attribution: '网易云音乐',
              license: '',
              licenseUrl: ''
            }
          ]
        }
      }
    }
  })
  const service = core(
    db,
    provider,
    { newImports: true, history: false, sources: ['platform.ncm'] },
    { identificationProviders: () => [identifier] }
  )
  t.after(() => service.shutdown())
  service.activate()
  await until(
    () => calls.length === 2 && db.metadataJobs({}).items.every((j) => j.state === 'completed')
  )
  assert.deepEqual(calls.sort(), ['fetchAlbumMetadata', 'fetchArtistMetadata'])
  for (const kind of ['artist', 'release'] as const) {
    const id = entity(db, 'ncm', kind)
    assert.equal(db.identificationDetail(id).link!.state, 'confirmed')
    assert.ok((await service.detail(id, 'zh-Hans')).introduction!.value.startsWith('平台介绍'))
    assert.equal(db.metadataDetail(entity(db, 'local', kind), 'zh-Hans').introduction, null)
  }
})

test('manual confirmation wakes the Core worker without waiting for the polling timer; language follows settings', async (t) => {
  const db = fixture(t),
    id = entity(db)
  const calls: string[] = []
  const provider: MetadataDetailProvider = {
    id: 'platform.ncm',
    supports: (k) => k === 'artist',
    blockedReason: () => null,
    context: () => 'a',
    enrich: async (request) => {
      calls.push(request.language)
      return { facts: [fact('正文', request.language)], availability: 'available' }
    }
  }
  const settings: MusicIdentificationSettings = {
    newImports: true,
    history: false,
    sources: [provider.id]
  }
  const service = core(db, provider, settings, { language: () => 'en' as const })
  t.after(() => service.shutdown())
  service.activate()
  await until(() => db.identificationScheduleStatus().pending === 0)
  const input = db.identificationInput(id)
  const [candidate] = db.identificationPublish(
    input,
    [
      {
        provider: 'ncm',
        name: input.name,
        summary: '',
        matcherVersion: 'manual',
        references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: '42' }],
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
    2000
  )
  await service.decideIdentity({
    candidateId: candidate.id,
    revision: candidate.revision,
    linkRevision: candidate.linkRevision,
    decision: 'confirm'
  })
  await until(() => calls.length === 1 && db.metadataJobs({}).items[0].state === 'completed')
  assert.deepEqual(calls, ['en'])
  settings.language = 'zh-Hant'
  service.refreshIdentification(true)
  await until(() => calls.length === 2 && db.metadataJobs({}).items[0].state === 'completed')
  assert.deepEqual(calls, ['en', 'zh-Hant'])
  assert.equal(
    normalizeMusicIdentificationSettings({ ...settings, language: 'bad' }).language,
    undefined
  )
  assert.equal(normalizeMusicIdentificationSettings(settings).language, 'zh-Hant')
  assert.equal(
    normalizeMusicIdentificationSettings({ ...settings, language: ['en'] }).language,
    undefined
  )
})

for (const action of ['disable', 'disable-shared', 'account'] as const)
  test(`Core ${action} aborts automatic HTTP and rejects the late reply`, async (t) => {
    const db = fixture(t),
      id = entity(db)
    confirm(db, id)
    let context = 'a',
      calls = 0,
      aborted = false,
      release!: () => void
    const provider: MetadataDetailProvider = {
      id: 'platform.ncm',
      supports: (k) => k === 'artist',
      blockedReason: () => null,
      context: () => context,
      enrich: async (_request, signal) => {
        calls++
        const value = calls === 1 ? '旧账号迟到结果' : '当前结果'
        if (calls === 1) {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
            },
            { once: true }
          )
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { facts: [fact(value)], availability: 'available' }
      }
    }
    const settings = { newImports: true, history: false, sources: [provider.id] }
    const service = core(db, provider, settings)
    t.after(() => service.shutdown())
    service.activate()
    await until(() => calls === 1)
    const old = db.metadataJobs({}).items[0]
    if (action === 'disable-shared')
      await service.enrich({
        entityId: id,
        batchId: 'explicit',
        language: 'zh-Hans',
        provider: provider.id
      })
    if (action === 'account') {
      context = 'b'
      service.refreshIdentification(false, provider.id)
    } else {
      settings.newImports = false
      service.refreshIdentification(true)
    }
    release()
    await until(() =>
      db.metadataJobs({}).items.every((j) => ['completed', 'cancelled'].includes(j.state))
    )
    assert.equal(aborted, true)
    assert.equal(calls, action === 'disable' ? 1 : 2)
    assert.equal(
      db.metadataJobs({ jobId: old.id }).items[0].state,
      action === 'disable-shared' ? 'completed' : 'cancelled'
    )
    assert.equal(
      JSON.stringify(db.sql.prepare('SELECT payload FROM metadata_facts').all()).includes(
        '旧账号迟到结果'
      ),
      false
    )
    if (action !== 'disable')
      assert.equal(db.metadataDetail(id, 'zh-Hans').introduction!.value, '当前结果')
  })
