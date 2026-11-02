import assert from 'node:assert/strict'
import test from 'node:test'
import { createArtistDetailView, artistDetailPresentation } from './artistDetailView.ts'
import type {
  EntityMetadataDetail,
  MetadataAttribution
} from '../../../../shared/entityMetadata.ts'
import type { CatalogEntity, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'
import { createArtistIdentityView } from '../music-metadata/artistIdentityView.ts'

const attribution: MetadataAttribution = {
  provider: 'wikipedia',
  externalId: 'Q1',
  url: 'https://en.wikipedia.org/wiki/Artist',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'Wikipedia contributors',
  revision: '1',
  retrievedAt: 1
}
const entity = (id = 'a', title = 'Alice'): CatalogEntity => ({
  id,
  title,
  artist: '',
  kind: 'artist',
  sourceCount: 1,
  identity: 'source'
})
const identity = (id: string, targetId: string | null = 'person'): MusicIdentityDetail => ({
  entityId: id,
  kind: 'artist',
  references: [],
  link: targetId
    ? { id, entityId: id, kind: 'artist', state: 'confirmed', targetId, revision: 1 }
    : null
})
const detail = (id = 'a'): EntityMetadataDetail => ({
  entityId: id,
  targetId: 'person',
  name: 'Alice',
  revision: 1,
  link: { state: 'confirmed', mbid: 'a223958d-5c56-4b2c-a30a-87e357bc121b', revision: 1 },
  introduction: { value: 'Public biography', origin: 'external', language: 'en', attribution },
  override: null,
  facts: [
    { field: 'name', value: 'Canonical Alice', language: 'und', attribution },
    { field: 'introduction', value: 'Public biography', language: 'en', attribution }
  ],
  artwork: [
    {
      scope: 'artist',
      handle: 'avatar',
      targetRef: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: 'person' },
      attribution,
      usage: { display: true, cache: true, crossSource: true, export: true }
    }
  ]
})
function fixture(items = [entity()]) {
  const queries: CatalogQuery[] = []
  let identities = new Map(items.map((item) => [item.id, identity(item.id)]))
  const details = new Map(items.map((item) => [item.id, detail(item.id)]))
  const api = {
    catalog: async (query: CatalogQuery) => {
      queries.push(query)
      const matching = query.artistName
        ? items.filter((item) => item.title.trim() === query.artistName!.trim())
        : items
      return {
        revision: 1,
        offset: query.offset ?? 0,
        total: matching.length,
        items: matching.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 200))
      }
    },
    sources: async () => ({ revision: 1, offset: 0, total: 0, items: [] }),
    identity: async (id: string) => identities.get(id)!,
    detail: async (id: string) => details.get(id)!
  }
  return {
    api,
    queries,
    details,
    setIdentities: (next: typeof identities) => {
      identities = next
    }
  }
}

test('single source opens saved biography and personal artwork without starting tasks', async () => {
  const f = fixture(),
    view = createArtistDetailView(f.api)
  f.details.get('a')!.artworkOverride = { mode: 'clear' }
  await view.setContext('Alice', 'en')
  assert.equal(view.state.value.selected?.id, 'a')
  assert.equal(view.state.value.shared, false)
  const p = artistDetailPresentation(view.state.value.detail, false, 'Alice', 'en', 100)
  assert.equal(p.cover, null)
  assert.equal(p.introduction?.value, 'Public biography')
  assert.ok(f.queries.every((query) => query.artistName === 'Alice'))
  view.dispose()
})

test('many exact source identities share automatic facts, never a representative personal override', async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => entity(String(i))))
  const d = f.details.get('0')!
  d.override = { mode: 'value', value: 'Private source prose', language: 'en' }
  d.introduction = {
    value: 'Private source prose',
    origin: 'manual',
    language: 'en',
    attribution: null
  }
  d.manualArtwork = { dataUrl: 'personal', mime: 'image/png', width: 1, height: 1, bytes: 1 }
  d.artworkOverride = { mode: 'value' }
  const automaticArtworkReads: boolean[] = []
  const view = createArtistDetailView({
    ...f.api,
    detail: async (id, _language, _provider, _signal, includeAutomaticArtwork) => {
      automaticArtworkReads.push(includeAutomaticArtwork)
      return f.api.detail(id)
    }
  })
  await view.setContext('Alice', 'en')
  assert.equal(view.state.value.shared, true)
  assert.equal(view.state.value.page?.items.length, 6)
  assert.ok(f.queries.some((query) => query.offset === 200 && query.revision === 1))
  const projected = artistDetailPresentation(view.state.value.detail, true, 'Alice', 'en', 100)
  assert.equal(projected.introduction?.value, 'Public biography')
  assert.notEqual(projected.cover, 'personal')
  assert.equal(automaticArtworkReads.at(-1), true)
  await view.select(entity('0'))
  assert.equal(view.state.value.shared, false)
  assert.equal(automaticArtworkReads.at(-1), false)
  assert.equal(
    artistDetailPresentation(view.state.value.detail, false, 'Alice', 'en', 100).introduction
      ?.value,
    'Private source prose'
  )
  await view.page(6)
  assert.equal(view.state.value.selected?.id, '0', 'paging choices retains the selected source')
  view.dispose()
})

test('homonyms use a stable confirmed profile; unresolved members do not block it, and composites never auto-pick collaborators', async () => {
  const f = fixture([entity('a'), entity('b'), entity('c', 'Bob')])
  f.setIdentities(
    new Map([
      ['a', identity('a')],
      ['b', identity('b', 'another')],
      ['c', identity('c')]
    ])
  )
  const view = createArtistDetailView(f.api)
  await view.setContext('Alice', 'en')
  assert.equal(view.state.value.selected?.id, 'a')
  assert.equal(view.state.value.detail?.entityId, 'a')
  assert.equal(view.state.value.shared, true)
  assert.equal(view.state.value.page?.total, 2)
  await view.select(entity('b'))
  assert.equal((view.state.value.selected as CatalogEntity | null)?.id, 'b')
  await view.setContext('Alice / Bob', 'en')
  assert.equal(view.state.value.exact, false)
  assert.equal(view.state.value.selected, null)
  assert.equal(view.state.value.page?.total, 3)
  f.setIdentities(
    new Map([
      ['a', identity('a')],
      ['b', identity('b', null)],
      ['c', identity('c')]
    ])
  )
  await view.setContext('Alice', 'en')
  assert.equal(view.state.value.detail?.entityId, 'a')
  view.dispose()
})

test('language priority, explicit hide, expiry and detached identities apply to the effective presentation', () => {
  const d = detail()
  d.facts.push({
    field: 'introduction',
    value: '中文简介',
    language: 'zh-Hans',
    attribution,
    usage: { display: true, cache: true, crossSource: true, export: true, expiresAt: 101 }
  })
  assert.equal(
    artistDetailPresentation(d, true, 'Alice', 'zh-Hans', 100).introduction?.value,
    '中文简介'
  )
  assert.equal(
    artistDetailPresentation(d, true, 'Alice', 'zh-Hans', 101).introduction?.value,
    'Public biography'
  )
  d.override = { mode: 'clear', value: '', language: 'en' }
  d.introduction = null
  assert.equal(artistDetailPresentation(d, false, 'Alice', 'en', 100).hiddenIntroduction, true)
  d.artwork![0].usage.expiresAt = 101
  assert.equal(artistDetailPresentation(d, false, 'Alice', 'en', 101).cover, null)
  d.link!.state = 'detached'
  assert.equal(artistDetailPresentation(d, true, 'Alice', 'en', 100).introduction, null)
  assert.equal(artistDetailPresentation(d, false, 'Alice', 'en', 100).name, 'Alice')
})

test('detail and card choose the same trusted profile and re-rank when that identity is detached', async (t) => {
  const f = fixture([entity('a'), entity('b'), entity('c')])
  const automatic = identity('b', 'other'), manual = identity('c')
  automatic.link!.confirmation = { mode: 'automatic', rule: 'artist_recordings' }
  manual.link!.confirmation = { mode: 'manual' }
  f.setIdentities(new Map([['a', identity('a', null)], ['b', automatic], ['c', manual]]))
  f.details.set('b', { ...detail('b'), targetId: 'other' })
  const view = createArtistDetailView(f.api), card = createArtistIdentityView(f.api)
  t.after(() => { view.dispose(); card.dispose() })
  await Promise.all([view.setContext('Alice', 'en'), card.setContext('Alice', 'en')])
  assert.equal(view.state.value.selected?.id, 'c')
  assert.equal(card.detail.value?.entityId, 'c')
  assert.equal(view.state.value.identities.a.link, null, 'display selection leaves other identities unresolved')
  manual.link!.state = 'detached'
  await Promise.all([view.refresh(), card.refresh()])
  assert.equal(view.state.value.selected?.id, 'b')
  assert.equal(card.detail.value?.entityId, 'b')
  f.details.get('b')!.link!.state = 'detached'
  await Promise.all([view.refresh(), card.refresh()])
  assert.equal(view.state.value.detail, null)
  assert.match(view.state.value.error, /身份已变化/)
  assert.equal(card.detail.value, null)
})

test('unconfirmed collections keep identity review available without borrowing a biography or photo', async (t) => {
  const f = fixture([entity('b'), entity('a')])
  f.setIdentities(new Map([['a', identity('a', null)], ['b', identity('b', null)]]))
  for (const d of f.details.values()) { d.link = null; d.targetId = null }
  const view = createArtistDetailView(f.api)
  t.after(view.dispose)
  await view.setContext('Alice', 'en')
  assert.equal(view.state.value.selected?.id, 'a')
  assert.equal(view.state.value.shared, true)
  const p = artistDetailPresentation(view.state.value.detail, true, 'Alice', 'en', 100)
  assert.equal(p.cover, null)
  assert.equal(p.introduction, null)
  await view.select(entity('b'))
  assert.equal(view.state.value.selected?.id, 'b')
  assert.equal(view.state.value.shared, false)
})

test('shared NCM biography fills a missing field without displacing another source or borrowing a personal preference', () => {
  const d = detail()
  const fallback = { field: 'introduction', value: '网易云介绍', language: 'zh-Hans',
    sourceProvider: 'ncm', attribution: { ...attribution, provider: 'platform.ncm' },
    usage: { display: true, cache: true, crossSource: true, export: false } } as const
  d.facts.unshift(fallback)
  d.sourcePreference = { provider: 'platform.ncm', available: true }
  assert.equal(artistDetailPresentation(d, true, 'Alice', 'zh-Hans', 100).introduction?.value, 'Public biography')
  d.facts = [fallback]
  assert.equal(artistDetailPresentation(d, true, 'Alice', 'zh-Hans', 100).introduction?.value, '网易云介绍')
  d.facts = [{ ...fallback, usage: { ...fallback.usage, expiresAt: 100 } }]
  assert.equal(artistDetailPresentation(d, true, 'Alice', 'zh-Hans', 100).introduction, null)
})

test('switching artist or language fences late reads; failed reads expose an actionable error', async () => {
  const f = fixture(),
    pending: Array<(d: EntityMetadataDetail) => void> = []
  const view = createArtistDetailView({
    ...f.api,
    detail: async () => new Promise<EntityMetadataDetail>((resolve) => pending.push(resolve))
  })
  const first = view.setContext('Alice', 'en')
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve))
  const second = view.setContext('Alice', 'zh-Hans')
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve))
  pending[1]({
    ...detail(),
    introduction: { value: '最新', language: 'zh-Hans', origin: 'manual', attribution: null }
  })
  await second
  pending[0](detail())
  await first
  assert.equal(view.state.value.detail?.introduction?.value, '最新')
  view.dispose()
  const broken = createArtistDetailView({
    ...f.api,
    catalog: async () => {
      throw new Error('offline')
    }
  })
  await broken.setContext('Alice', 'en')
  assert.equal(broken.state.value.error, 'offline')
  assert.equal(broken.state.value.loading, false)
  broken.dispose()
})

test('explicit profile choice restores one source without confirming the other same-name sources', async () => {
  const f = fixture([entity('a'),entity('b')])
  f.setIdentities(new Map([['a',identity('a')],['b',identity('b',null)]]))
  let saved = {entityId:'a',targetId:'person'}
  const view = createArtistDetailView({...f.api,choice:()=>saved})
  await view.setContext('Alice','en')
  assert.equal(view.state.value.selected?.id,'a')
  assert.equal(view.state.value.shared,false)
  f.details.set('a',{...detail('a'),targetId:'homonym'})
  await view.refresh()
  assert.equal(view.state.value.detail,null)
  assert.match(view.state.value.error,/身份已变化/)
  saved = {entityId:'foreign-source',targetId:'person'}
  await view.setContext('Alice','en')
  assert.equal(view.state.value.detail,null)
  view.dispose()
})

test('background reads retain the automatic profile and coalesce progress instead of restarting reads', async t => {
  const f = fixture([entity('a'), entity('b')])
  f.setIdentities(new Map([['a', identity('a')], ['b', identity('b', 'homonym')]]))
  let hold = false, reads = 0, release!: () => void
  const view = createArtistDetailView({ ...f.api, catalog: async query => {
    reads++
    if (hold) await new Promise<void>(resolve => { release = resolve })
    return f.api.catalog(query)
  } })
  t.after(view.dispose)
  await view.setContext('Alice', 'en')
  const painted = view.state.value.page
  hold = true
  const first = view.refresh()
  const next = view.refresh()
  assert.equal(view.state.value.loading, false)
  assert.equal(view.state.value.refreshing, true)
  assert.equal(view.state.value.page, painted)
  assert.equal(view.state.value.selected?.id, 'a')
  assert.equal(reads, 2, 'one in-flight read, no abort/restart for each progress event')
  hold = false; release()
  await Promise.all([first, next])
  assert.equal(reads, 3)
  assert.equal(view.state.value.refreshing, false)
})

test('failed background reads retain the selected source and draft host; permission changes withdraw it', async t => {
  const f = fixture()
  let failure = false
  const view = createArtistDetailView({ ...f.api, catalog: async query => {
    if (failure) throw new Error('temporary read failure')
    return f.api.catalog(query)
  } })
  t.after(view.dispose)
  await view.setContext('Alice', 'en')
  const painted = view.state.value.detail
  failure = true
  await view.refresh()
  assert.equal(view.state.value.detail, painted)
  assert.equal(view.state.value.selected?.id, 'a')
  assert.match(view.state.value.error, /temporary/)
  await view.refresh(true)
  assert.equal(view.state.value.detail, null)
  assert.equal(view.state.value.selected, null)
})
