import * as files from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreBrowseService } from '../../../core/browse/service.ts'
import type { CoreRequestEnvelope } from '../../../shared/coreProtocol.ts'
import type { TrackData } from '../../../shared/track.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'
import {
  browseSnapshotValue,
  createBrowseWindow,
  produceBrowseSelection,
  saveBrowsePage,
  restoreBrowsePage
} from './browseSessions.ts'

const track = (i: number): TrackData => ({
  id: `p:${i}`,
  title: `Track ${i}`,
  artist: 'Artist',
  album: 'Album',
  source: 'p',
  duration: 60,
  size: 0,
  filePath: '',
  fileName: '',
  cover: null,
  lyrics: null
})

test('snapshot capture detaches Vue proxies and rejects closures before IPC', () => {
  const state = reactive({ people: [{ id: 1 }], draft: { name: 'unsaved' } })
  const saved = browseSnapshotValue(state)
  assert.deepEqual(structuredClone(saved), { people: [{ id: 1 }], draft: { name: 'unsaved' } })
  state.draft.name = 'later'
  assert.equal(saved.draft.name, 'unsaved')
  assert.throws(() => browseSnapshotValue({ loader: () => [] }), /可序列化/)
})
async function fixture(t: test.TestContext, total = 4201, grouped = false) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-window-'))
  let serial = 0
  const calls: number[] = []
  const service = new CoreBrowseService({
    files,
    root,
    newId: () => `session-${++serial}`,
    providerContext: () => 'account-1',
    callProvider: async (_provider, _method, args) => {
      const offset = Number(args[1]),
        limit = Number(args[2])
      calls.push(offset)
      return {
        tracks: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
          ...track(offset + i),
          ...(grouped
            ? {
                mediaPart: {
                  groupId: `video-${Math.floor((offset + i) / 240)}`,
                  groupTitle: 'Video',
                  title: 'Part',
                  index: ((offset + i) % 240) + 1,
                  count: 240
                }
              }
            : {})
        })),
        total,
        nextOffset: Math.min(total, offset + limit),
        hasMore: offset + limit < total
      }
    }
  })
  const invoke = (name: string, payload: unknown, signal = new AbortController().signal) =>
    service.execute(
      'window',
      {
        kind:
          name === 'browse.open' ||
          name === 'browse.append' ||
          name === 'browse.release' ||
          name === 'browse.snapshot.save'
            ? 'command'
            : 'query',
        name,
        payload
      } as CoreRequestEnvelope,
      signal
    )
  const client = { command: invoke, query: invoke } as Pick<CorePlayerClient, 'command' | 'query'>
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return { service, client, calls }
}

test('a renderer window remains bounded while paging, sorting and selecting all 4201 tracks', async (t) => {
  const f = await fixture(t)
  const view = createBrowseWindow(f.client)
  await view.open({
    providerId: 'p',
    method: 'fetchPlaylistTracksPage',
    args: ['list'],
    paging: { offsetArg: 1, limitArg: 2 }
  })
  assert.equal(f.calls.length, 5, 'ordinary browsing only reads the first display window')
  assert.equal(view.state.value.total, 4201)
  assert.equal(view.state.value.tracks.length, 1000)
  await view.load(3000)
  assert.equal(view.state.value.offset, 2800)
  assert.ok(view.state.value.tracks.length <= 1000)
  assert.equal(view.state.value.tracks[0].id, 'p:2800')
  const saved = view.capture()
  view.dispose()
  assert.equal(view.state.value.tracks.length, 0)
  const restored = createBrowseWindow(f.client)
  const calls = f.calls.length
  await restored.restore(saved.session!, saved.offset, saved.query, saved.groups)
  assert.equal(
    restored.state.value.offset,
    2800,
    'restoration must not move the window backwards on each visit'
  )
  assert.equal(f.calls.length, calls)
  let all = 0,
    maximum = 0
  await restored.produce(async (tracks) => {
    all += tracks.length
    maximum = Math.max(maximum, tracks.length)
  })
  assert.equal(all, 4201)
  assert.equal(maximum, 200)
  let selected = 0
  await produceBrowseSelection(
    { id: saved.session!.id, query: {}, ranges: [[0, 4201]], count: 4201 },
    async (tracks) => {
      selected += tracks.length
    },
    undefined,
    f.client
  )
  assert.equal(selected, 4201)
  await restored.setQuery({ query: 'Track 4200', sort: 'title' })
  assert.equal(restored.state.value.total, 1)
  assert.equal(restored.state.value.tracks[0].id, 'p:4200')
})

test('multipart display spans disk pages and plays every part independently of folding', async (t) => {
  const f = await fixture(t, 1201, true)
  const view = createBrowseWindow(f.client, () => true)
  await view.open({
    providerId: 'p',
    method: 'fetchPlaylistTracksPage',
    args: ['list'],
    paging: { offsetArg: 1, limitArg: 2 }
  })
  assert.equal(view.state.value.rowTotal, 6)
  assert.equal(view.state.value.total, 1201)
  await view.setGroups({ 'video-0': { expanded: true, page: 11 } })
  const rows = view.state.value.rows.filter((row) => row.kind === 'track')
  assert.equal(rows.length, 20)
  assert.equal(rows[0].track.id, 'p:220')
  assert.equal(rows.at(-1)!.track.id, 'p:239')
  let count = 0
  await view.produce(async (tracks) => {
    count += tracks.length
  })
  assert.equal(count, 1201)
})

test('immediate navigation waits for pending snapshot and restores drafts and query handles', async (t) => {
  const f = await fixture(t)
  let resolve!: (value: Record<string, unknown>) => void
  saveBrowsePage(
    'test-pending',
    'epoch',
    ['p'],
    new Promise((value) => {
      resolve = value
    }),
    f.client
  )
  const restore = restoreBrowsePage('test-pending', 'epoch', f.client)
  resolve({
    detail: { sessionId: 'handle', query: 'favorite', offset: 1800 },
    draft: { name: '未保存' },
    scroll: 8312
  })
  const value = (await restore)!
  assert.equal(value.scroll, 8312)
  assert.equal((value.draft as { name: string }).name, '未保存')
  saveBrowsePage('test-pending', 'epoch', ['p'], value, f.client)
  await new Promise((resolve) => setImmediate(resolve))
  await f.service.invalidateProvider('p')
  assert.equal(await restoreBrowsePage('test-pending', 'epoch', f.client), null)
})

test('cached 100000-track display restoration reads only the bounded window', async (t) => {
  const f = await fixture(t, 100000)
  const view = createBrowseWindow(f.client)
  await view.open({
    providerId: 'p',
    method: 'fetchPlaylistTracksPage',
    args: ['list'],
    paging: { offsetArg: 1, limitArg: 2 }
  })
  await view.produce(async () => {})
  const session = view.state.value.session!
  view.dispose()
  const samples: number[] = []
  for (let i = 0; i < 20; i++) {
    const window = createBrowseWindow(f.client)
    const start = performance.now()
    await window.restore(session, 80000 + i * 200)
    samples.push(performance.now() - start)
    assert.equal(window.state.value.tracks.length, 1000)
    window.dispose()
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
  console.log(`BROWSE_CACHED_RESTORE tracks=100000 samples=20 p95_ms=${p95.toFixed(2)}`)
  assert.ok(p95 <= 300, `cached restore exceeded 300 ms: ${p95}`)
  assert.equal(f.calls.length, 500)
})
