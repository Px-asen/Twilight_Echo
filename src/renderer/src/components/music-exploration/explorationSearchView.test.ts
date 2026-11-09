import assert from 'node:assert/strict'
import test from 'node:test'
import { h, ref, shallowRef } from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import { createExplorationSearchView } from './explorationSearchView.ts'
import type { MusicExplorationPage, MusicExplorationQuery } from '../../../../shared/musicExploration.ts'
const token = { revision: 1, catalogRevision: 2, contentRevision: 3, metadataRevision: 4, contextKey: '[]', asOf: 100, expiresAt: null }
const page = (offset = 0): MusicExplorationPage => ({ token, offset, total: 11, items: [{ id: 'person-1', kind: 'artist', title: 'Same name', artist: '', inLibrary: true, sourceCount: 2 }] })

test('entity search defaults to actual library content and uses a frozen token only for its current page', async () => {
  const queries: MusicExplorationQuery[] = []
  const view = createExplorationSearchView(async query => { queries.push(query); return page(query.offset) })
  await view.setQuery(' Same name ')
  assert.deepEqual(queries[0], { search: 'Same name', kinds: ['artist', 'work', 'performance'], scope: 'library', offset: 0, limit: 10 })
  await view.page(10)
  assert.deepEqual(queries[1].token, token)
  assert.equal(queries[1].offset, 10)
  await view.setQuery('Other', 'catalog')
  assert.equal(queries[2].scope, 'catalog')
  assert.equal(queries[2].token, undefined)
  view.dispose()
})

test('changing text, clearing or disposing entity search retires an old response', async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (p: MusicExplorationPage) => void }> = []
  const view = createExplorationSearchView((_q, signal) => new Promise(resolve => pending.push({ signal, resolve })))
  const first = view.setQuery('Old'), second = view.setQuery('New')
  assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve(page(10)); await second
  pending[0].resolve(page()); await first
  assert.equal(view.state.value.page?.offset, 10)
  const third = view.setQuery('Third')
  await view.setQuery(' ')
  assert.equal(pending[2].signal.aborted, true)
  pending[2].resolve(page()); await third
  assert.equal(view.state.value.page, null)
  const last = view.setQuery('Last')
  view.dispose(); pending[3].resolve(page()); await last
  assert.equal(view.state.value.page, null)
})

test('stale or offline entity search clears old results and requires an explicit fresh read', async () => {
  let fail = false, calls = 0
  const view = createExplorationSearchView(async () => { calls++; if (fail) throw new Error('人物作品已变化'); return page() })
  await view.setQuery('Person')
  fail = true; await view.page(10)
  assert.equal(calls, 2)
  assert.equal(view.state.value.page, null)
  assert.match(view.state.value.error, /已变化/)
  fail = false; await view.refresh()
  const current = () => view.state.value.page
  assert.equal(current()?.offset, 0)
  view.dispose()
})

test('a permission deadline removes visible search results without networking and cancels on disposal', async () => {
  let now = 100, callback: (() => void) | null = null, reads = 0, cancelled = 0
  const view = createExplorationSearchView(async () => { reads++; return { ...page(), token: { ...token, expiresAt: 200 } } }, {
    now: () => now, schedule: fn => { callback = fn; return () => { cancelled++; callback = null } }
  })
  await view.setQuery('Person')
  now = 200; (callback as unknown as () => void)()
  assert.equal(view.state.value.page, null)
  assert.match(view.state.value.error, /到期/)
  assert.equal(reads, 1)
  now = 100; await view.refresh()
  view.dispose()
  assert.equal(cancelled, 1)
  assert.equal(callback, null)
})

test('compiled unified entity results navigate the chosen exact ID and clear on a new query', async t => {
  const snapshot = shallowRef({ epoch: 'one', explorationRevision: 1 }), query = ref('Same name')
  const requests: MusicExplorationQuery[] = [], opened: string[] = []
  const Search = component('../music-exploration/MusicExplorationSearch.vue', {
    './explorationSearchView.ts': { createExplorationSearchView },
    './MusicExplorationPanel.vue': { __esModule: true, default: { props: ['entityId'], setup: (p: any) => () => { opened.push(p.entityId); return h('aside', p.entityId) } } },
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({ state: snapshot, query: async (name: string, q: MusicExplorationQuery) => {
      assert.equal(name, 'exploration.query'); requests.push(q); return page(q.offset)
    } }) }
  })
  const ui = mount(t, () => h(Search, { query: query.value }))
  await settle()
  assert.equal(requests[0].scope, 'library')
  const result = () => ui.nodes().find(n => n.tag === 'button' && n.props['aria-pressed'] === false)!
  result().props.onClick(); await settle()
  assert.equal(opened.at(-1), 'person-1')
  ui.button('下一页').props.onClick(); await settle()
  assert.deepEqual(requests.at(-1)!.token, token)
  query.value = 'Other'; await settle()
  assert.equal(requests.at(-1)!.search, 'Other')
  assert.doesNotMatch(ui.text(), /收起详情/)
  const reads = requests.length
  snapshot.value = { ...snapshot.value, explorationRevision: 2 }; await settle()
  assert.equal(requests.length, reads + 1)
  const select = ui.nodes().find(n => n.tag === 'select')!
  select.props['onUpdate:modelValue']('catalog'); await settle()
  assert.equal(requests.at(-1)!.scope, 'catalog')
})

test('refresh keeps the current page visible, reads a fresh token and retires superseded replies', async () => {
  const pending: Array<{ query: MusicExplorationQuery; signal: AbortSignal; resolve: (p: MusicExplorationPage) => void }> = []
  const view = createExplorationSearchView((query, signal) => new Promise(resolve => pending.push({ query, signal, resolve })))
  const first = view.setQuery('Person')
  pending[0].resolve(page()); await first
  const next = view.page(10)
  pending[1].resolve(page(10)); await next
  const refresh = view.refresh()
  assert.equal(view.state.value.page?.offset, 10)
  assert.equal(view.state.value.loading, true)
  assert.equal(pending[2].query.offset, 10)
  assert.equal(pending[2].query.token, undefined)
  const latest = view.refresh()
  assert.equal(pending[2].signal.aborted, true)
  pending[3].resolve({ ...page(10), total: 12 }); await latest
  pending[2].resolve(page(10)); await refresh
  assert.equal(view.state.value.page?.total, 12)
  assert.equal(view.state.value.loading, false)
  const changed = view.setQuery('Other')
  assert.equal(view.state.value.page, null)
  pending[4].resolve(page()); await changed
  view.dispose()
})

test('refresh cannot extend the permission deadline of retained results', async () => {
  let now = 100, callback: (() => void) | null = null
  let finish!: (p: MusicExplorationPage) => void
  const view = createExplorationSearchView(async () => new Promise(resolve => { finish = resolve }), {
    now: () => now, schedule: fn => { callback = fn; return () => { callback = null } }
  })
  const initial = view.setQuery('Person')
  finish({ ...page(), token: { ...token, expiresAt: 200 } }); await initial
  const refresh = view.refresh()
  assert.ok(callback, 'the visible results must retain their expiry timer during refresh')
  now = 200; (callback as unknown as () => void)()
  assert.equal(view.state.value.page, null)
  assert.match(view.state.value.error, /到期/)
  finish(page()); await refresh
  assert.equal(view.state.value.page, null)
  view.dispose()
})

test('refresh moves to the last valid page when library changes remove the current page', async () => {
  let total = 11
  const queries: MusicExplorationQuery[] = []
  const view = createExplorationSearchView(async query => {
    queries.push(query)
    return { ...page(query.offset), total, items: (query.offset ?? 0) < total ? page().items : [] }
  })
  await view.setQuery('Person')
  await view.page(10)
  total = 1
  await view.refresh()
  assert.equal(queries[2].offset, 10)
  assert.equal(queries[2].token, undefined)
  assert.equal(queries[3].offset, 0)
  assert.deepEqual(queries[3].token, token)
  assert.equal(view.state.value.page?.offset, 0)
  assert.equal(view.state.value.page?.items.length, 1)
  view.dispose()
})

test('compiled search ignores unrelated snapshots and keeps results and selection during metadata refresh', async t => {
  const snapshot = shallowRef({ epoch: 'one', explorationRevision: 1, catalogRevision: 1, libraryRevision: 1, entityMetadataRevision: 1, pluginsRevision: 1, sequence: 1 })
  const query = ref('Same name')
  const pending: Array<{ query: MusicExplorationQuery; resolve: (p: MusicExplorationPage) => void }> = []
  const Search = component('../music-exploration/MusicExplorationSearch.vue', {
    './explorationSearchView.ts': { createExplorationSearchView },
    './MusicExplorationPanel.vue': { __esModule: true, default: { props: ['entityId'], setup: (p: any) => () => h('aside', p.entityId) } },
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({ state: snapshot, query: (_name: string, q: MusicExplorationQuery) => new Promise(resolve => pending.push({ query: q, resolve })) }) }
  })
  const ui = mount(t, () => h(Search, { query: query.value }))
  assert.match(ui.text(), /正在查找/)
  pending[0].resolve(page()); await settle()
  ui.nodes().find(n => n.tag === 'button' && n.props['aria-pressed'] === false)!.props.onClick(); await settle()
  snapshot.value = { ...snapshot.value, sequence: 2 }; await settle()
  assert.equal(pending.length, 1, 'playback and other unrelated snapshots must not query again')
  for (let revision = 2; revision <= 4; revision++) {
    snapshot.value = { ...snapshot.value, libraryRevision: revision, entityMetadataRevision: revision }; await settle()
    assert.match(ui.text(), /Same name/)
    assert.match(ui.text(), /收起详情/)
    assert.doesNotMatch(ui.text(), /正在查找|暂无匹配/)
    assert.equal(ui.nodes().find(n => n.tag === 'section')!.props['aria-busy'], true)
    pending.at(-1)!.resolve(page()); await settle()
  }
  snapshot.value = { ...snapshot.value, pluginsRevision: 2 }; await settle()
  assert.doesNotMatch(ui.text(), /Same name|收起详情/)
  assert.match(ui.text(), /正在查找/)
  pending.at(-1)!.resolve(page()); await settle()
  query.value = 'Other'; await settle()
  assert.doesNotMatch(ui.text(), /Same name/)
  pending.at(-1)!.resolve({ ...page(), items: [], total: 0 }); await settle()
  assert.match(ui.text(), /暂无匹配的库内人物或作品/)
})

test('metadata notifications coalesce while search is pending and do not repeatedly retry a failed search', async t => {
  const snapshot = shallowRef({ epoch: 'one', libraryRevision: 1, entityMetadataRevision: 1 })
  const pending: Array<{
    signal: AbortSignal
    resolve: (value: MusicExplorationPage) => void
    reject: (error: Error) => void
  }> = []
  const Search = component('../music-exploration/MusicExplorationSearch.vue', {
    './explorationSearchView.ts': { createExplorationSearchView },
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({
      state: snapshot,
      query: (_name: string, _query: MusicExplorationQuery, signal: AbortSignal) =>
        new Promise((resolve, reject) => pending.push({ signal, resolve, reject }))
    }) }
  })
  const ui = mount(t, () => h(Search, { query: '周杰伦' }))
  for (let revision = 2; revision <= 20; revision++) {
    snapshot.value = { ...snapshot.value, entityMetadataRevision: revision }
    await settle()
  }
  assert.equal(pending.length, 1, 'background enrichment must not restart an unfinished SQL read')
  assert.equal(pending[0].signal.aborted, false)
  pending[0].resolve(page()); await settle()
  assert.match(ui.text(), /Same name/)
  assert.equal(pending.length, 2, 'all pending invalidations share one fresh read')
  pending[1].reject(new Error('Music library database request queue is full')); await settle()
  for (let revision = 21; revision <= 30; revision++) {
    snapshot.value = { ...snapshot.value, entityMetadataRevision: revision }
    await settle()
    assert.match(ui.text(), /request queue is full/)
    assert.doesNotMatch(ui.text(), /正在查找/)
  }
  assert.equal(pending.length, 2, 'an error stays visible until an explicit retry or a new query')
  ui.button('重新读取').props.onClick(); await settle()
  assert.equal(pending.length, 3)
  pending[2].resolve(page()); await settle()
  assert.match(ui.text(), /Same name/)
})
