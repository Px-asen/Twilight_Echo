import * as files from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreBrowseService } from './service.ts'
import { isCoreRequest, type CoreRequestEnvelope } from '../../shared/coreProtocol.ts'
import type { TrackData } from '../../shared/track.ts'

const track = (index: number): TrackData => ({
  id: `p:${index}`,
  title: `Song ${index}`,
  artist: 'Artist',
  album: 'Album',
  duration: 60,
  size: 1,
  source: 'p',
  filePath: '',
  fileName: '',
  cover: null,
  lyrics: null
})
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-browse-'))
  let serial = 0,
    context = 'account-a:version-1'
  const calls: number[] = []
  const service = new CoreBrowseService({
    files,
    root,
    newId: () => `id-${++serial}`,
    providerContext: () => context,
    callProvider: async (_id, _method, args) => {
      const offset = Number(args[1]),
        limit = Number(args[2])
      calls.push(offset)
      return {
        tracks: Array.from({ length: Math.min(limit, 1201 - offset) }, (_, i) => track(offset + i)),
        total: 1201,
        nextOffset: Math.min(1201, offset + limit),
        hasMore: offset + limit < 1201
      }
    }
  })
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return {
    service,
    root,
    calls,
    context: (value: string) => {
      context = value
    },
    execute: (name: string, payload: unknown, owner = 'window') =>
      service.execute(
        owner,
        {
          kind:
            name === 'browse.page' || name === 'browse.snapshot' || name === 'browse.locate'
              ? 'query'
              : 'command',
          name,
          payload,
          epoch: 'one',
          requestId: 'request'
        } as CoreRequestEnvelope,
        new AbortController().signal
      )
  }
}
test('display sessions persist 200-row pages and complete iteration includes every provider row', async (t) => {
  const f = await fixture(t)
  const session = await f.service.open(
    'window',
    {
      source: {
        providerId: 'p',
        method: 'fetchPlaylistTracksPage',
        args: ['playlist', 0, 200],
        paging: { offsetArg: 1, limitArg: 2 }
      }
    },
    new AbortController().signal
  )
  assert.equal(session.loaded, 200)
  let count = 0
  for (let offset = 0; offset < 1201; offset += 200) {
    const page = await f.service.page(
      'window',
      { id: session.id, offset, complete: true },
      new AbortController().signal
    )
    assert.ok(page.items.length <= 200)
    count += page.items.length
  }
  assert.equal(count, 1201)
  assert.deepEqual(f.calls, [0, 200, 400, 600, 800, 1000, 1200])
  const files = await readdir(join(f.root, 'session-id-1', session.id))
  for (const file of files)
    assert.ok(
      JSON.parse(await readFile(join(f.root, 'session-id-1', session.id, file), 'utf8')).length <=
        200
    )
  const again = await f.service.page(
    'window',
    { id: session.id, offset: 1000 },
    new AbortController().signal
  )
  assert.equal(again.items[0].id, 'p:1000')
  assert.equal(f.calls.length, 7)
  assert.equal(
    JSON.stringify(f.service).includes('Song 1000'),
    false,
    'service metadata does not retain track data'
  )
})
test('query sorting and selection positions cover rows outside the renderer window', async (t) => {
  const f = await fixture(t)
  const session = await f.service.open(
    'window',
    {
      source: {
        providerId: 'p',
        method: 'fetchPlaylistTracksPage',
        args: ['playlist'],
        paging: { offsetArg: 1, limitArg: 2 }
      }
    },
    new AbortController().signal
  )
  const result = await f.service.page(
    'window',
    { id: session.id, query: 'Song 1200', sort: 'title', direction: 'desc' },
    new AbortController().signal
  )
  assert.equal(result.filteredTotal, 1)
  assert.equal(result.items[0].id, 'p:1200')
  assert.deepEqual(result.positions, [1200])
})
test('foreign windows, changed accounts and logout cannot read retained pages or drafts', async (t) => {
  const f = await fixture(t)
  const session = await f.service.open('window', { providerId: 'p' }, new AbortController().signal)
  await f.execute('browse.append', { id: session.id, items: [track(1)] })
  const snapshot = (await f.execute('browse.snapshot.save', {
    providerIds: ['p'],
    value: { sessionId: session.id, draft: { name: 'unsaved edit' }, scroll: 300 }
  })) as { id: string }
  await assert.rejects(f.execute('browse.snapshot', snapshot, 'foreign'), { code: 'FORBIDDEN' })
  assert.equal(
    ((await f.execute('browse.snapshot', snapshot)) as { value: { draft: { name: string } } }).value
      .draft.name,
    'unsaved edit'
  )
  f.context('account-b:version-1')
  await assert.rejects(f.service.page('window', { id: session.id }, new AbortController().signal), {
    code: 'STALE_REVISION'
  })
  await assert.rejects(f.execute('browse.snapshot', snapshot), { code: 'STALE_REVISION' })
  await f.service.invalidateProvider('p')
  assert.deepEqual(await readdir(join(f.root, 'session-id-1')), [])
  f.context('account-a:version-1')
  await assert.rejects(f.execute('browse.snapshot', snapshot), { code: 'STALE_REVISION' })
})
test('browse wire contracts reject traversal, oversized pages and write provider methods', () => {
  const request = (name: string, payload: unknown) => ({
    kind: 'command',
    name,
    payload,
    epoch: 'one',
    requestId: 'request'
  })
  assert.equal(isCoreRequest(request('browse.release', { ids: ['../../private'] })), false)
  assert.equal(
    isCoreRequest(
      request('browse.append', {
        id: 'id-1',
        items: Array.from({ length: 201 }, (_, i) => track(i))
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('browse.open', { source: { providerId: 'p', method: 'logout', args: [] } })
    ),
    false
  )
  assert.equal(isCoreRequest(request('browse.open', { providerId: 'p' })), true)
})

test('disconnect fences a provider that ignores cancellation and cannot resurrect released rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-browse-disconnect-'))
  let resolve!: (value: TrackData[]) => void
  let started!: () => void
  const ready = new Promise<void>((yes) => {
    started = yes
  })
  let serial = 0
  const service = new CoreBrowseService({
    files,
    root,
    newId: () => `id-${++serial}`,
    providerContext: () => 'account',
    callProvider: async () => {
      started()
      return new Promise<TrackData[]>((yes) => {
        resolve = yes
      })
    }
  })
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  const opening = service.open(
    'window',
    { source: { providerId: 'p', method: 'fetchPlaylistTracks', args: ['list'] } },
    new AbortController().signal
  )
  const rejected = assert.rejects(opening)
  await ready
  const closing = service.disconnect('window')
  resolve([track(1)])
  await Promise.all([rejected, closing])
  assert.deepEqual(await readdir(root), [])
})

test('seeded sessions reject complete actions while append is unfinished instead of looping', async (t) => {
  const f = await fixture(t)
  const session = await f.service.open('window', { providerId: 'p' }, new AbortController().signal)
  await f.execute('browse.append', { id: session.id, items: [track(1)], complete: false })
  await assert.rejects(
    f.service.page('window', { id: session.id, complete: true }, new AbortController().signal),
    { code: 'NOT_READY' }
  )
  await f.execute('browse.append', { id: session.id, items: [track(2)], complete: true })
  assert.equal(
    (
      await f.service.page(
        'window',
        { id: session.id, complete: true },
        new AbortController().signal
      )
    ).filteredTotal,
    2
  )
})

test('random ordering remains identical across page reads and includes every track once', async (t) => {
  const f = await fixture(t)
  const session = await f.service.open(
    'window',
    {
      source: {
        providerId: 'p',
        method: 'fetchPlaylistTracksPage',
        args: ['list'],
        paging: { offsetArg: 1, limitArg: 2 }
      }
    },
    new AbortController().signal
  )
  const ids: string[] = []
  for (let offset = 0; offset < 1201; offset += 200) {
    const page = await f.service.page(
      'window',
      { id: session.id, sort: 'random', seed: 42, offset, complete: true },
      new AbortController().signal
    )
    ids.push(...page.items.map((track) => track.id))
  }
  assert.equal(new Set(ids).size, 1201)
  const again = await f.service.page(
    'window',
    { id: session.id, sort: 'random', seed: 42 },
    new AbortController().signal
  )
  assert.deepEqual(
    again.items.map((track) => track.id),
    ids.slice(0, 200)
  )
  assert.notDeepEqual(
    ids.slice(0, 200),
    Array.from({ length: 200 }, (_, index) => `p:${index}`)
  )
})

test('pending draft writes cannot bind data from the old account to a new provider context', async (t) => {
  const f = await fixture(t)
  const contexts = await f.execute('browse.context', { providerIds: ['p'] })
  f.context('new-account:version-2')
  await assert.rejects(
    f.execute('browse.snapshot.save', {
      providerIds: ['p'],
      contexts,
      value: { draft: 'old-account edit' }
    }),
    { code: 'STALE_REVISION' }
  )
  await f.service.disconnect('window')
  const reconnected = await f.execute('browse.open', { providerId: 'p' }) as { id: string }
  assert.ok(reconnected.id, 'an authorized connection can reuse its window identity')
})

test('a replacement Core clears abandoned epoch caches before writing new account data', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'session-old'))
  await writeFile(join(f.root, 'session-old', 'private.json'), '{"draft":"old account"}')
  await writeFile(join(f.root, 'unrelated.txt'), 'keep')
  await f.service.invalidateProvider('p')
  assert.deepEqual(await readdir(f.root), ['unrelated.txt'], 'logout also clears previous-epoch data before the first new browse')
  await f.execute('browse.snapshot.save', { providerIds: ['p'], value: { draft: 'new account' } })
  assert.deepEqual((await readdir(f.root)).sort(), ['session-id-1', 'unrelated.txt'])
})
