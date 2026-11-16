import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { shallowRef, watch } from 'vue'
import { playlistRuntime } from '../coreTestFixtures.ts'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  LibraryPlaylistViewSync,
  LibraryCollectionSummary,
  LibraryTrackRecord
} from '../../../../shared/libraryDatabase.ts'
import { createLibraryPlaylistView } from './libraryPlaylistView.ts'
import { createLibraryCollectionPages } from './libraryCollectionPages.ts'
import { createPlaylistTrackResolver } from '../../../../core/playlists/trackResolver.ts'
import { filterLocalGridItems } from '../../utils/localLibrarySearch.ts'
import {
  summarizePlaylistSources,
  formatPlaylistSourceSummary
} from '../../utils/playlistSourceSummary.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'
import type { Playlist } from './musicStoreTypes.ts'

const preferences = { revision: 1, versions: [] }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const record = (id: string, patch: Record<string, unknown> = {}): LibraryTrackRecord => ({
  id,
  filePath: `D:/Music/${id}.flac`,
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
  source: 'local',
  ...patch
})

test('reordering catalog cards changes only lightweight order, not the member lease', async (t) => {
  const { owner, playlists, calls, db } = fixture(t)
  await owner.setCatalog(playlists, preferences)
  const id = owner.state.value.id,
    count = calls.length
  const reordered = [...playlists].reverse()
  await owner.setCatalog(reordered, preferences)
  assert.equal(owner.state.value.id, id)
  assert.equal(calls.length, count)
  assert.deepEqual(
    db
      .queryCollections('playlists', {
        playlistView: id!,
        collectionOrder: reordered.map((item) => item.id)
      })
      .items.map((item) => item.id),
    reordered.map((item) => item.id)
  )
})
function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  const tracks = [
    record('one'),
    record('two'),
    record('new', { title: 'Relinked', duration: 12 })
  ].map(libraryTrack)
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: tracks as unknown as LibraryTrackRecord[],
    folders: [],
    exclusions: []
  })
  const calls: LibraryPlaylistViewSync[] = []
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      calls.push(structuredClone(request))
      return db.syncPlaylistView(request)
    }
  })
  t.after(async () => {
    await owner.dispose()
    db.close()
  })
  const remote = libraryTrack(
    record('ncm:7', { source: 'ncm', title: 'Remote', filePath: '', duration: 30 })
  )
  const playlists: Playlist[] = [
    {
      id: 'favorites',
      name: '我喜欢的音乐',
      isDefault: true,
      createdAt: '',
      trackIds: ['one', 'one', 'old', 'ncm:7', 'missing'],
      trackSnapshots: {
        old: libraryTrack(record('old', { title: 'Relinked', duration: 12 })),
        'ncm:7': remote
      }
    },
    { id: 'empty', name: 'Empty Mix', createdAt: '', trackIds: [], cover: 'cover://chosen' },
    { id: 'other', name: 'One / Mix', createdAt: '', trackIds: ['two'] }
  ]
  return { db, tracks, calls, owner, playlists }
}

test('catalog summaries use the existing complete resolver, including duplicates, relinks, remote members and empty playlists', async (t) => {
  const { db, tracks, owner, playlists } = fixture(t)
  await owner.setCatalog(playlists, preferences)
  const id = owner.state.value.id!
  const page = db.queryCollections('playlists', { playlistView: id })
  assert.equal(page.total, 3)
  const resolver = createPlaylistTrackResolver({
    runtime: playlistRuntime(),
    tracks: shallowRef(tracks),
    trackById: new Map(tracks.map((track) => [track.id, track])),
    getTracksRevision: () => 1
  })
  for (let i = 0; i < playlists.length; i++) {
    const members = resolver.resolvePlaylistTracks(playlists[i])
    const summary = page.items[i]
    assert.equal(summary.trackCount, members.length)
    assert.equal(
      summary.duration,
      members.reduce((sum, track) => sum + track.duration, 0)
    )
    assert.deepEqual(
      summary.sourceSummary,
      summarizePlaylistSources({
        trackIds: members.map((t) => t.id),
        trackSnapshots: Object.fromEntries(members.map((t) => [t.id, t]))
      })
    )
    assert.equal('tracks' in summary, false)
    assert.equal('trackIds' in summary, false)
    assert.equal('trackSnapshots' in summary, false)
  }
  assert.equal(page.items[0].isDefault, true)
  assert.equal(page.items[1].cover, 'cover://chosen')
  assert.equal(page.items[0].cover, null, 'do not invent an automatic track cover')
  assert.equal(
    db.sql
      .prepare(
        `SELECT count(*) AS n FROM playlist_members WHERE view_id=? AND
    (payload<>'{}' OR snapshot IS NOT NULL OR title<>'' OR search_text<>'')`
      )
      .get(id)?.n,
    0
  )
  assert.throws(() => db.queryTracks({ playlistView: id }), /catalogs support summaries/)
  assert.throws(() => db.createLibraryQueue({ playlistView: id }), /catalogs cannot/)
  assert.throws(
    () => db.queryCollections('albums', { playlistView: id }),
    /not collection summaries/
  )
})

test('catalog supersession during headers and a lost worker rebuild the latest configuration without replaying uploads', async (t) => {
  const { db, playlists } = fixture(t)
  let unblock!: () => void
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve
  })
  let first = true
  const calls: LibraryPlaylistViewSync[] = []
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      calls.push(request)
      const result = db.syncPlaylistView(request)
      if (request.kind === 'groups' && first) {
        first = false
        await blocked
      }
      return result
    }
  })
  t.after(() => owner.dispose())
  const upload = owner.setCatalog(playlists, preferences)
  await tick()
  assert.equal(calls.at(-1)?.kind, 'groups')
  void owner.setCatalog([{ ...playlists[1], name: 'Latest' }], preferences)
  unblock()
  await upload
  assert.equal(
    db.queryCollections('playlists', { playlistView: owner.state.value.id! }).items[0].name,
    'Latest'
  )
  const dropped = owner.state.value.id!
  db.syncPlaylistView({ kind: 'drop', id: dropped })
  assert.equal(owner.recover(dropped, new Error('Playlist view expired; rebuild')), true)
  await owner.setCatalog([{ ...playlists[1], name: 'Latest' }], preferences)
  assert.notEqual(owner.state.value.id, dropped)
  assert.equal(
    db.queryCollections('playlists', { playlistView: owner.state.value.id! }).items[0].trackCount,
    0
  )
  assert.equal(
    calls.filter((call) => call.kind === 'commit').length,
    2,
    'superseded header upload never commits'
  )
})

test('name matching and lightweight card ordering retain grid semantics without reuploading members', async (t) => {
  const { db, owner, playlists, calls } = fixture(t)
  await owner.setCatalog(playlists, preferences)
  const query = {
    playlistView: owner.state.value.id!,
    collectionOrder: ['other', 'empty', 'favorites', 'other', 'unknown']
  }
  const uploads = calls.length
  const expectedOrder = [playlists[2], playlists[1], playlists[0]]
  for (const search of ['', ' mix ', '我 喜欢', 'One', 'ONE', 'Artist', 'Remote', 'w x h', '/%']) {
    const page = db.queryCollections('playlists', { ...query, search, limit: 1 })
    const expected = filterLocalGridItems(expectedOrder, search)
    assert.equal(page.total, expected.length, search)
    const items: LibraryCollectionSummary[] = []
    for (let offset = 0; offset < page.total; offset++)
      items.push(...db.queryCollections('playlists', { ...query, search, limit: 1, offset }).items)
    assert.deepEqual(
      items.map((p) => p.id),
      expected.map((p) => p.id),
      search
    )
  }
  await owner.setCatalog(
    playlists.map((playlist) => ({ ...playlist })),
    preferences
  )
  assert.equal(calls.length, uploads)
  assert.deepEqual(
    db.queryCollections('playlists', { ...query, collectionCountOnly: true }).items,
    []
  )
  assert.throws(() => db.queryCollections('playlists', { ...query, ids: ['one'] }), /Unsupported/)
  assert.equal(calls.length, uploads, 'query and card reorder do not upload member definitions')
})

test('library changes update authoritative counts and duration atomically without catalog uploads', async (t) => {
  const { db, owner, playlists, calls } = fixture(t)
  await owner.setCatalog(playlists, preferences)
  const query = { playlistView: owner.state.value.id! },
    before = db.queryCollections('playlists', query)
  const uploads = calls.length
  const version = db.getTracksByIds(['one']).versions.one
  db.patchTracks([{ id: 'one', expectedVersion: version, patch: { duration: 5 } }])
  const changed = db.queryCollections('playlists', query)
  assert.equal(changed.items[0].duration, before.items[0].duration - 350)
  db.replaceDocument({
    version: 2,
    revision: 0,
    tracks: db.getTracksByIds(['two', 'new']).tracks,
    folders: [],
    exclusions: []
  })
  const removed = db.queryCollections('playlists', query)
  assert.equal(removed.items[0].trackCount, 2)
  assert.equal(removed.items[0].sourceSummary?.local, 1)
  assert.equal(removed.items[0].sourceSummary?.provider, 1)
  assert.throws(
    () => db.queryCollections('playlists', { ...query, contentRevision: before.revision }),
    /变化/
  )
  assert.equal(calls.length, uploads)
})

test('catalog upload validation and failed batches never publish partial definitions or advance the sequence', (t) => {
  const { db } = fixture(t)
  const id = 'manual'
  db.syncPlaylistView({ kind: 'begin', id, versions: [], catalog: true })
  assert.throws(() => db.queryCollections('playlists', { playlistView: id }), /incomplete/)
  assert.throws(
    () =>
      db.syncPlaylistView({
        kind: 'groups',
        id,
        sequence: 1,
        groups: [
          { id: 'p', name: 'First' },
          { id: 'p', name: 'Duplicate' }
        ]
      }),
    /UNIQUE/
  )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_groups WHERE view_id=?').get(id)?.n,
    0
  )
  db.syncPlaylistView({ kind: 'groups', id, sequence: 1, groups: [{ id: 'p', name: 'First' }] })
  for (const collectionId of [undefined, 'missing', 77])
    assert.throws(
      () =>
        db.syncPlaylistView({
          kind: 'append',
          id,
          sequence: 2,
          entries: [{ id: 'one', collectionId }]
        } as LibraryPlaylistViewSync),
      /membership|collection/
    )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_definitions WHERE view_id=?').get(id)?.n,
    0
  )
  db.syncPlaylistView({
    kind: 'append',
    id,
    sequence: 2,
    entries: [{ id: 'one', collectionId: 'p' }]
  })
  db.syncPlaylistView({ kind: 'commit', id, sequence: 3 })
  assert.equal(db.queryCollections('playlists', { playlistView: id }).items[0].trackCount, 1)
  assert.throws(
    () => db.syncPlaylistView({ kind: 'groups', id, sequence: 4, groups: [] }),
    /changed/
  )
  assert.throws(
    () =>
      db.syncPlaylistView({
        kind: 'begin',
        id: 'invalid',
        versions: [],
        catalog: 'yes'
      } as unknown as LibraryPlaylistViewSync),
    /catalog mode/
  )
  assert.throws(
    () =>
      db.syncPlaylistView({
        kind: 'groups',
        id: 'invalid',
        sequence: 1,
        groups: Array.from({ length: 201 }, (_, i) => ({ id: String(i), name: 'name' }))
      }),
    /oversized/
  )
  db.syncPlaylistView({ kind: 'begin', id: 'ordinary', versions: [] })
  assert.throws(
    () => db.syncPlaylistView({ kind: 'groups', id: 'ordinary', sequence: 1, groups: [] }),
    /require a catalog/
  )
  db.syncPlaylistView({ kind: 'commit', id: 'ordinary', sequence: 1 })
  assert.throws(
    () => db.queryCollections('playlists', { playlistView: 'ordinary' }),
    /require a catalog/
  )
})

test('provider labels are bounded while counts include every source', async (t) => {
  const { db, owner, playlists } = fixture(t)
  const snapshots = Array.from({ length: 37 }, (_, i) =>
    libraryTrack(
      record(`provider${String(i).padStart(2, '0')}:7`, {
        source: `provider${String(i).padStart(2, '0')}`,
        filePath: ''
      })
    )
  )
  await owner.setCatalog(
    [
      {
        ...playlists[0],
        trackIds: snapshots.map((t) => t.id),
        trackSnapshots: Object.fromEntries(snapshots.map((t) => [t.id, t]))
      }
    ],
    preferences
  )
  const summary = db.queryCollections('playlists', { playlistView: owner.state.value.id! }).items[0]
    .sourceSummary!
  assert.equal(summary.total, 37)
  assert.equal(summary.provider, 37)
  assert.equal(summary.providers.length, 20)
  assert.equal(summary.additionalProviders, 17)
  assert.match(formatPlaylistSourceSummary(summary), /Provider 37.*等 37 个音源/)
})

test('a failed projection batch rolls back all summary counters and retries from immutable definitions', async (t) => {
  const { db, owner, playlists } = fixture(t)
  await owner.setCatalog(playlists, preferences)
  const id = owner.state.value.id!
  db.sql.exec(`CREATE TEMP TRIGGER catalog_fault BEFORE INSERT ON playlist_members
    WHEN new.seq=1 BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END;`)
  assert.throws(
    () => db.queryCollections('playlists', { playlistView: id }),
    /injected catalog failure/
  )
  assert.equal(
    db.sql.prepare('SELECT sum(track_count) AS n FROM playlist_groups WHERE view_id=?').get(id)?.n,
    0
  )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_group_sources WHERE view_id=?').get(id)?.n,
    0
  )
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_members WHERE view_id=?').get(id)?.n,
    0
  )
  db.sql.exec('DROP TRIGGER catalog_fault')
  const page = db.queryCollections('playlists', { playlistView: id })
  assert.equal(page.items[0].trackCount, 4)
  assert.equal(page.items[0].duration, 402)
  assert.equal(page.items[0].sourceSummary?.local, 3)
  assert.equal(page.items[0].sourceSummary?.provider, 1)
})

test('catalog paging keeps four summary windows and invalidates late replies after membership/header changes', async (t) => {
  const { db, owner, playlists, calls } = fixture(t)
  const input = Array.from({ length: 2405 }, (_, i) => ({
    ...playlists[i % 3],
    id: String(i),
    name: `Mix ${i}`
  }))
  await owner.setCatalog(input, preferences)
  assert.ok(calls.filter((c) => c.kind === 'groups').every((c) => c.groups.length <= 200))
  assert.ok(calls.filter((c) => c.kind === 'append').every((c) => c.entries.length <= 200))
  const firstId = owner.state.value.id!
  const pages = createLibraryCollectionPages({
    queryCollections: async (kind, query) => db.queryCollections(kind, query)
  })
  const stop = watch(
    () => owner.state.value.id,
    (id) => pages.setQuery(id ? 'playlists' : null, id ? { playlistView: id } : {}),
    { flush: 'sync', immediate: true }
  )
  t.after(() => {
    stop()
    pages.dispose()
  })
  for (let i = 0; i < 13; i++) {
    pages.goToPage(i)
    while (pages.state.value.loading) await tick()
    assert.equal(pages.state.value.error, '')
    assert.equal(pages.state.value.page?.items.length, i === 12 ? 5 : 200)
  }
  assert.equal(pages.cacheState.cachedPages, 4)
  assert.ok(pages.cacheState.cachedItems <= 800)
  await owner.setCatalog([{ ...playlists[1], name: 'Renamed' }], preferences)
  while (pages.state.value.loading) await tick()
  assert.equal(pages.state.value.page?.items[0].name, 'Renamed')
  assert.equal(pages.cacheState.cachedPages, 1)
  assert.throws(() => db.queryCollections('playlists', { playlistView: firstId }), /expired/)
  let turns = 0
  while (db.needsQueryMaintenance) {
    const before =
      Number(
        db.sql
          .prepare('SELECT count(*) AS n FROM playlist_definitions WHERE view_id=?')
          .get(firstId)?.n
      ) +
      Number(
        db.sql.prepare('SELECT count(*) AS n FROM playlist_members WHERE view_id=?').get(firstId)?.n
      ) +
      Number(
        db.sql.prepare('SELECT count(*) AS n FROM playlist_groups WHERE view_id=?').get(firstId)?.n
      )
    db.maintainQueryState()
    const after =
      Number(
        db.sql
          .prepare('SELECT count(*) AS n FROM playlist_definitions WHERE view_id=?')
          .get(firstId)?.n
      ) +
      Number(
        db.sql.prepare('SELECT count(*) AS n FROM playlist_members WHERE view_id=?').get(firstId)?.n
      ) +
      Number(
        db.sql.prepare('SELECT count(*) AS n FROM playlist_groups WHERE view_id=?').get(firstId)?.n
      )
    assert.ok(before - after <= 200)
    assert.ok(++turns < 1000)
  }
  assert.equal(
    db.sql.prepare('SELECT count(*) AS n FROM playlist_group_sources WHERE view_id=?').get(firstId)
      ?.n,
    0
  )
})
