import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogEntity, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type {
  MusicIdentityDetail,
  MusicIdentityLink
} from '../../../../shared/musicIdentification.ts'
import { selectArtistProfile } from './artistProfileSelection.ts'

function fixture(
  rows: Array<[string, string | null, MusicIdentityLink['confirmation']?, number?]>
) {
  const items: CatalogEntity[] = rows.map(([id, , , sourceCount = 1]) => ({
    id,
    title: 'Alice',
    kind: 'artist',
    artist: '',
    identity: 'source',
    sourceCount
  }))
  const identities: Record<string, MusicIdentityDetail> = Object.fromEntries(
    rows.map(([id, targetId, confirmation]) => [
      id,
      {
        entityId: id,
        kind: 'artist',
        references: [],
        link: targetId
          ? {
              id,
              entityId: id,
              kind: 'artist',
              state: 'confirmed',
              targetId,
              revision: 1,
              confirmation
            }
          : null
      }
    ])
  )
  const queries: CatalogQuery[] = []
  const query: CatalogQuery = {
    kind: 'artist',
    source: 'local',
    artistName: 'Alice',
    limit: 200,
    context: { type: 'collection', collection: 'artists', id: 'Alice' }
  }
  const api = {
    catalog: async (q: CatalogQuery) => {
      queries.push(q)
      return {
        revision: 1,
        total: items.length,
        offset: q.offset ?? 0,
        items: items.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200))
      }
    },
    identity: async (id: string) => identities[id]
  }
  return {
    api,
    queries,
    identities,
    select: async (preferred: string | null = null) =>
      selectArtistProfile(
        api,
        query,
        await api.catalog(query),
        new AbortController().signal,
        preferred
      )
  }
}

test('confirmed profiles are usable beside unresolved or detached members, without mutating their identities', async () => {
  const f = fixture([
    ['unresolved', null],
    ['confirmed', 'person'],
    ['detached', 'other']
  ])
  f.identities.detached.link!.state = 'detached'
  const before = structuredClone(f.identities)
  const result = await f.select()
  assert.equal(result.selected?.id, 'confirmed')
  assert.equal(result.targetId, 'person')
  assert.equal(result.shared, true)
  assert.deepEqual(f.identities, before)
})

test('manual confirmation outranks automatic proof, which outranks legacy confirmation', async () => {
  const f = fixture([
    ['legacy', 'legacy-person', undefined, 100],
    ['automatic', 'automatic-person', { mode: 'automatic', rule: 'artist_recordings' }],
    ['manual', 'manual-person', { mode: 'manual' }]
  ])
  assert.equal((await f.select()).selected?.id, 'manual')
  f.identities.manual.link = null
  assert.equal((await f.select()).selected?.id, 'automatic')
})

test('same-target agreement then source coverage rank equally confirmed profiles, with stable representative ties', async () => {
  const f = fixture([
    ['a', 'homonym', undefined, 100],
    ['b', 'person'],
    ['c', 'person']
  ])
  assert.equal((await f.select()).targetId, 'person')
  assert.equal((await f.select()).selected?.id, 'b')
  const covered = fixture([
    ['b', 'person', undefined, 2],
    ['a', 'other']
  ])
  assert.equal((await covered.select()).selected?.id, 'b')
  const reversed = fixture([
    ['c', 'person'],
    ['b', 'person'],
    ['a', 'other']
  ])
  assert.equal((await reversed.select()).selected?.id, 'b')
})

test('a stronger confirmed profile beyond the first 200 members participates in the same ranking', async () => {
  const rows: Parameters<typeof fixture>[0] = Array.from({ length: 200 }, (_, i) => [
    String(i),
    'legacy'
  ])
  rows.push(['winner', 'manual', { mode: 'manual' }])
  const f = fixture(rows)
  assert.equal((await f.select()).selected?.id, 'winner')
  assert.equal(f.queries[1].offset, 200)
  assert.equal(f.queries[1].revision, 1)
})

test('explicit sources retain their own scope; unconfirmed collections get only an editor anchor', async () => {
  const f = fixture([
    ['b', null],
    ['a', null]
  ])
  assert.deepEqual(await f.select(), {
    selected: {
      id: 'a',
      title: 'Alice',
      kind: 'artist',
      artist: '',
      identity: 'source',
      sourceCount: 1
    },
    shared: true,
    targetId: null
  })
  assert.equal((await f.select('b')).shared, false)
  assert.equal((await f.select('outside')).selected, null)
})

test('changed or incomplete membership and cancelled reads cannot publish a partial winner', async () => {
  const entity: CatalogEntity = {
    id: 'a',
    title: 'Alice',
    kind: 'artist',
    artist: '',
    identity: 'source',
    sourceCount: 1
  }
  const first = { revision: 1, offset: 0, total: 2, items: [entity] }
  const f = fixture([['a', 'person']])
  const query: CatalogQuery = { kind: 'artist', artistName: 'Alice' }
  await assert.rejects(
    selectArtistProfile(
      { ...f.api, catalog: async () => ({ ...first, revision: 2 }) },
      query,
      first,
      new AbortController().signal
    ),
    /已变化/
  )
  await assert.rejects(
    selectArtistProfile(
      { ...f.api, catalog: async () => ({ ...first, items: [] }) },
      query,
      first,
      new AbortController().signal
    ),
    /不完整/
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(selectArtistProfile(f.api, query, first, controller.signal), {
    name: 'AbortError'
  })
})
