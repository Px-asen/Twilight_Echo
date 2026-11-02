/* eslint-disable vue/one-component-per-file -- Compiled presentation fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { h, nextTick, shallowRef } from 'vue'
import type { EntityMetadataDetail } from '../../../../shared/entityMetadata.ts'
import type { CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import * as model from './artistIdentityView.ts'
import * as entityView from './entityMetadataView.ts'
import * as profileChoice from './artistProfileChoice.ts'

const attribution = {
  provider: 'Wikimedia Commons',
  externalId: 'Artist.jpg',
  url: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
  license: 'CC-BY-SA-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'Photographer',
  revision: '1',
  retrievedAt: 1000
}
const detail = (): EntityMetadataDetail => ({
  entityId: 'entity',
  targetId: 'target',
  revision: 1,
  link: { state: 'confirmed', mbid: '', revision: 1 },
  name: 'Tagged name',
  introduction: null,
  override: null,
  facts: [{ field: 'name', value: 'Canonical name', language: 'und', attribution }],
  artwork: [
    {
      scope: 'artist',
      handle: 'avatar-handle',
      targetRef: { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: 'artist' },
      attribution,
      usage: { display: true, cache: true, crossSource: true, export: true }
    }
  ]
})
const page = (total = 1): CatalogPage => ({
  revision: 1,
  total,
  offset: 0,
  items: [
    {
      id: 'entity',
      kind: 'artist',
      title: 'Tagged name',
      artist: '',
      identity: 'source',
      sourceCount: 1
    }
  ]
})

test('virtualized cards synchronously restore cached metadata only for the same scope and choice', async () => {
  const cache = model.createArtistIdentityCache()
  let revision = 'session:1',
    reads = 0
  let choice: profileChoice.ArtistProfileChoice | null = null
  const api = {
    cache,
    cacheScope: () => revision,
    choice: () => choice,
    catalog: async () => {
      reads++
      return page()
    },
    detail: async () => detail()
  }
  const first = model.createArtistIdentityView(api)
  await first.setContext('Artist', 'en')
  first.dispose()
  const returned = model.createArtistIdentityView(api)
  const restored = returned.setContext('Artist', 'en')
  assert.equal(returned.detail.value?.artwork?.[0].handle, 'avatar-handle')
  await restored
  assert.equal(reads, 1)
  await returned.setContext('Other', 'en')
  await returned.setContext('Artist', 'zh-Hans')
  revision = 'session:2'
  await returned.setContext('Artist', 'en')
  choice = { entityId: 'entity', targetId: 'target' }
  await returned.setContext('Artist', 'en')
  assert.equal(reads, 5)
  returned.dispose()
})

test('card cache retains empty results, bounds manual art, and never stores failed or outdated reads', async () => {
  let now = 0
  const cache = model.createArtistIdentityCache(() => now)
  for (let i = 0; i < 256; i++) cache.set(String(i), null)
  assert.equal(cache.get('0'), null)
  cache.set('256', null)
  assert.equal(cache.get('1'), undefined)
  assert.equal(cache.get('0'), null)
  const large: EntityMetadataDetail = {
    ...detail(),
    manualArtwork: {
      dataUrl: 'x'.repeat(3 * 1024 * 1024),
      mime: 'image/png',
      bytes: 1,
      width: 1,
      height: 1
    }
  }
  cache.set('a', large)
  cache.set('b', large)
  cache.set('c', large)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('c'), large)
  now = 60 * 60 * 1000
  assert.equal(cache.get('c'), undefined)
  let revision = '1',
    fail = false,
    reads = 0
  const pending: Array<(value: EntityMetadataDetail) => void> = []
  const api = {
    cache,
    cacheScope: () => revision,
    catalog: async () => {
      reads++
      if (fail) throw Error('offline')
      return page()
    },
    detail: () => new Promise<EntityMetadataDetail>((resolve) => pending.push(resolve))
  }
  const old = model.createArtistIdentityView(api)
  const loading = old.setContext('Artist', 'en')
  await settle()
  revision = '2'
  pending.shift()!(detail())
  await loading
  assert.equal(old.detail.value, null)
  old.dispose()
  const fresh = model.createArtistIdentityView(api)
  fail = true
  await fresh.setContext('Artist', 'en')
  fail = false
  const retry = fresh.setContext('Artist', 'en')
  await settle()
  pending.shift()!(detail())
  await retry
  assert.equal(reads, 3)
  fresh.dispose()
})

test('artist cards read exact collection membership and keep ambiguous multi-artist groups unchanged', async () => {
  const queries: CatalogQuery[] = []
  let total = 1,
    reads = 0
  const view = model.createArtistIdentityView({
    catalog: async (query) => {
      queries.push(query)
      return page(total)
    },
    detail: async () => {
      reads++
      return detail()
    }
  })
  await view.setContext('Tagged name', 'zh-Hans')
  assert.deepEqual(queries[0].context, {
    type: 'collection',
    collection: 'artists',
    id: 'Tagged name'
  })
  assert.equal(queries[0].artistName, 'Tagged name')
  assert.equal(
    model.artistIdentityPresentation(view.detail.value, { name: 'Tagged name' }, 1000).cover,
    'avatar-handle'
  )
  total = 2
  await view.refresh()
  assert.equal(view.detail.value, null)
  assert.equal(reads, 1)
  view.dispose()
})

test('card presentation honors clear/manual art, expiry, local-source permission and detached identity', () => {
  const d = detail(),
    fallback = { name: 'Tag', cover: 'track-cover' }
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).name, 'Canonical name')
  d.artwork![0].usage.expiresAt = 1001
  assert.equal(model.artistIdentityPresentation(d, fallback, 1001).cover, 'track-cover')
  d.artwork![0].usage.expiresAt = undefined
  d.artwork![0].usage.crossSource = false
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).cover, 'track-cover')
  d.artworkOverride = { mode: 'clear' }
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).cover, null)
  d.artworkOverride = { mode: 'value' }
  d.manualArtwork = { dataUrl: 'personal-bitmap', mime: 'image/png', bytes: 1, width: 1, height: 1 }
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).cover, 'personal-bitmap')
  d.artworkOverride = null
  d.link!.state = 'detached'
  assert.deepEqual(model.artistIdentityPresentation(d, fallback, 1000), {
    name: fallback.name,
    cover: 'track-cover',
    coverSource: null,
    attribution: null
  })
})

test('artist card song covers fill missing or broken portraits without reviving hidden images or portrait credits', () => {
  const fallback = { name: '打打だいず', cover: 'cover://song.jpg', coverSource: 'https://example.com/song.jpg' }
  assert.equal(model.artistIdentityPresentation(null, fallback, 1000).cover, fallback.cover)
  const remote = model.artistIdentityPresentation(null, { name: fallback.name, coverSource: fallback.coverSource }, 1000)
  assert.equal(remote.cover, null)
  assert.equal(remote.coverSource, fallback.coverSource, 'source-only song artwork remains usable')
  const d = detail()
  const failed = new Set(['avatar-handle'])
  const song = model.artistIdentityPresentation(d, fallback, 1000, failed)
  assert.equal(song.cover, fallback.cover)
  assert.equal(song.coverSource, fallback.coverSource)
  assert.equal(song.attribution, null)
  failed.add(fallback.cover)
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000, failed).cover, null)
  const native = model.artistIdentityPresentation(d, fallback, 1000)
  assert.equal(native.cover, 'avatar-handle')
  assert.equal(native.coverSource, null, 'a song URL must never regrant the artist portrait')
  d.artworkOverride = { mode: 'clear' }
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).cover, null)
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).coverSource, null)
  d.artworkOverride = { mode: 'value' }
  d.manualArtwork = { dataUrl: 'personal-bitmap', mime: 'image/png', bytes: 1, width: 1, height: 1 }
  assert.equal(model.artistIdentityPresentation(d, fallback, 1000).cover, 'personal-bitmap')
})

test('multiple source-scoped performers use the same automatic representative even beside another identity', async () => {
  let otherTarget = 'target'
  const view = model.createArtistIdentityView({
    catalog: async (query) => ({
      ...page(2),
      items: [{ ...page().items[0], id: query.offset ? 'second' : 'first' }]
    }),
    identity: async (id) => ({
      entityId: id,
      kind: 'artist',
      references: [],
      link: {
        id,
        entityId: id,
        kind: 'artist',
        revision: 1,
        state: 'confirmed',
        targetId: id === 'first' ? 'target' : otherTarget
      }
    }),
    detail: async () => detail()
  })
  await view.setContext('Artist', 'en')
  assert.equal(view.detail.value?.targetId, 'target')
  otherTarget = 'homonym'
  await view.refresh()
  assert.equal(view.detail.value?.targetId, 'target')
  view.dispose()
})

test('bursts coalesce without cancelling useful card reads; context changes reject late results', async () => {
  const deferred: Array<{ resolve(d: EntityMetadataDetail): void; signal: AbortSignal }> = []
  const view = model.createArtistIdentityView({
    catalog: async () => page(),
    detail: (_id, _language, signal) => new Promise((resolve) => deferred.push({ resolve, signal }))
  })
  const first = view.setContext('First', 'zh-Hans')
  await settle()
  for (let i = 0; i < 30; i++) void view.refresh()
  assert.equal(deferred[0].signal.aborted, false)
  deferred[0].resolve(detail())
  await first
  await settle()
  assert.equal(deferred.length, 2)
  assert.equal(view.detail.value?.artwork?.[0].handle, 'avatar-handle')
  const next = view.setContext('Next', 'en')
  await settle()
  assert.equal(deferred[1].signal.aborted, true)
  deferred[1].resolve(detail())
  await settle()
  assert.equal(view.detail.value, null)
  deferred[2].resolve({ ...detail(), name: 'Next' })
  await next
  assert.equal((view.detail.value as EntityMetadataDetail | null)?.name, 'Next')
  view.dispose()
})

test('compiled identity slot updates the visible name/avatar and withdraws revoked metadata immediately', async (t) => {
  const state = shallowRef({
    phase: 'ready',
    epoch: 'one',
    settingsRevision: 1,
    entityMetadataRevision: 1,
    entityMetadataContentRevision: 0,
    sequence: 1,
    catalogRevision: 1,
    libraryRevision: 1
  })
  let result: EntityMetadataDetail | null = detail()
  let reads = 0
  const core = {
    state,
    query: async (name: string) => {
      reads++
      return name === 'catalog.query' ? page() : (result ?? { ...detail(), facts: [], artwork: [] })
    }
  }
  const Identity = component('../music-metadata/ArtistMetadataIdentity.vue', {
    './artistProfileChoice.ts': profileChoice,
    './artistIdentityView.ts': model,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core },
    '../../stores/useSettingsStore.ts': {
      useSettingsStore: () => ({
        settings: shallowRef({ musicIdentification: { language: 'zh-Hans' } })
      })
    }
  })
  const ui = mount(t, () =>
    h(
      Identity,
      { name: 'Tag', cover: 'track-cover', enabled: true },
      {
        default: (p) =>
          h('div', [
            h('img', { src: p.cover }),
            h('span', p.name),
            h('small', p.attribution?.attribution)
          ])
      }
    )
  )
  await settle()
  assert.match(ui.text(), /Canonical namePhotographer/)
  assert.equal(ui.nodes().find((n) => n.tag === 'img')?.props.src, 'avatar-handle')
  const before = reads
  state.value = { ...state.value, entityMetadataRevision: 2, sequence: 2 }
  await settle()
  assert.equal(reads, before, 'task-only progress and playback ticks do not reload artist cards')
  state.value = { ...state.value, entityMetadataContentRevision: 1 }
  await settle()
  assert.ok(reads > before, 'committed metadata still refreshes artist cards')
  result = null
  state.value = { ...state.value, settingsRevision: 2 }
  await nextTick()
  assert.equal(ui.nodes().find((n) => n.tag === 'img')?.props.src, 'track-cover')
  await settle()
  assert.equal(ui.text(), 'Tag')
})

test('compiled artist cards paint completed portraits while other artists keep committing metadata', async (t) => {
  const state = shallowRef({
    phase: 'ready', epoch: 'portraits', settingsRevision: 1,
    entityMetadataRevision: 1, entityMetadataContentRevision: 1,
    catalogRevision: 1, libraryRevision: 1
  })
  const pending: Array<{ resolve(value: EntityMetadataDetail): void; signal: AbortSignal }> = []
  const core = {
    state,
    query: (name: string, _query: unknown, signal: AbortSignal) =>
      name === 'catalog.query'
        ? Promise.resolve(page())
        : new Promise<EntityMetadataDetail>((resolve) => pending.push({ resolve, signal }))
  }
  const Identity = component('../music-metadata/ArtistMetadataIdentity.vue', {
    './artistProfileChoice.ts': profileChoice,
    './artistIdentityView.ts': model,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core },
    '../../stores/useSettingsStore.ts': {
      useSettingsStore: () => ({ settings: shallowRef({ musicIdentification: {} }) })
    }
  })
  const ui = mount(t, () => h(Identity, { name: '*Luna', enabled: true }, {
    default: (p) => h('img', { src: p.cover })
  }))
  await settle()
  assert.equal(pending.length, 1)
  state.value = { ...state.value, entityMetadataContentRevision: 2 }
  await settle()
  pending[0].resolve(detail())
  await settle()
  assert.equal(pending.length, 2, 'one follow-up read catches up with the new content')
  assert.equal(ui.nodes().find((node) => node.tag === 'img')?.props.src, 'avatar-handle',
    'a different artist finishing must not discard a usable portrait')
  state.value = { ...state.value, settingsRevision: 2 }
  await nextTick()
  assert.equal(pending[1].signal.aborted, true)
  pending[1].resolve(detail())
  await settle()
  assert.equal(ui.nodes().find((node) => node.tag === 'img')?.props.src, null,
    'a permission change still rejects the late portrait')
  pending[2].resolve({ ...detail(), artwork: [] })
  await settle()
})

test('album overview displays the project introduction without claiming the unresolved pressing, and respects a local clear', async (t) => {
  const state = shallowRef({
    phase: 'ready',
    epoch: 'one',
    settingsRevision: 1,
    entityMetadataRevision: 1,
    catalogRevision: 1,
    libraryRevision: 1
  })
  let cleared = false
  const core = {
    state,
    query: async (name: string, query: any) => {
      if (name === 'catalog.query')
        return { ...page(), items: [{ ...page().items[0], id: query.kind, kind: query.kind }] }
      if (name === 'catalog.sources')
        return {
          revision: 1,
          total: 1,
          offset: 0,
          items: [{ provider: 'local', track: { title: 'Song', album: 'Album' } }]
        }
      if (name === 'metadata.entity.detail')
        return {
          ...detail(),
          entityId: query.entityId,
          artwork: [],
          facts: [],
          link: query.entityId === 'release' ? null : detail().link,
          override:
            query.entityId === 'release' && cleared
              ? { mode: 'clear', value: '', language: 'zh-Hans' }
              : null,
          introduction:
            query.entityId === 'album_project'
              ? { value: '真实作品简介', language: 'zh-Hans', origin: 'external', attribution }
              : null
        }
      throw Error(`Unexpected read: ${name}`)
    }
  }
  const Panel = component('../music-metadata/EntityMetadataPanel.vue', {
    './entityMetadataView.ts': entityView,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core },
    '../../stores/useSettingsStore.ts': {
      useSettingsStore: () => ({
        settings: shallowRef({ musicIdentification: { language: 'zh-Hans' } })
      })
    },
    '../../app/useLocale.ts': { useLocale: () => ({ locale: shallowRef('zh-CN') }) }
  })
  const ui = mount(t, () =>
    h(Panel, {
      target: {
        kind: 'release',
        sourceProvider: 'local',
        context: { type: 'collection', collection: 'albums', id: 'album-key' }
      }
    })
  )
  await settle()
  await settle()
  assert.match(ui.text(), /真实作品简介/)
  assert.match(ui.text(), /专辑作品简介/)
  assert.match(ui.text(), /具体发行待确认/)
  assert.doesNotMatch(ui.text(), /发行身份已确认/)
  cleared = true
  state.value = { ...state.value, entityMetadataRevision: 2 }
  await settle()
  assert.doesNotMatch(ui.text(), /真实作品简介/)
  assert.match(ui.text(), /已隐藏介绍/)
})

test('card profile choice must be an exact member and retain its confirmed target', async () => {
  let selected = {entityId:'entity',targetId:'target'}
  let response=detail()
  const queries: CatalogQuery[]=[]
  const view=model.createArtistIdentityView({choice:()=>selected,catalog:async q=>{queries.push(q);return page()},
    detail:async()=>response})
  await view.setContext('AC/DC','en')
  assert.ok(queries.every(q=>q.artistName==='AC/DC'))
  assert.equal(view.detail.value?.targetId,'target')
  response={...response,targetId:'homonym'}
  await view.refresh()
  assert.equal(view.detail.value,null)
  selected={entityId:'other-artist',targetId:'target'}
  await view.refresh()
  assert.equal(view.detail.value,null)
  view.dispose()
})
