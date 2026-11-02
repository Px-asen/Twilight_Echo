import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createCoreListeningStats } from './coreListeningStats.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreStatisticsOverview } from '../../../shared/coreStatistics.ts'
import { isCoreRequest } from '../../../shared/coreProtocol.ts'

function assertValidPage(payload: unknown): void {
  assert.equal(isCoreRequest({
    kind: 'query', name: 'statistics.tracks', payload, requestId: 'rankings', epoch: 'first'
  }), true)
}

const rows = Array.from({ length: 450 }, (_, index) => ({
  id: `track-${index}`, title: `Track ${index}`, artist: 'Artist', cover: null, sourceIds: [],
  seconds: 10, plays: 1, lastPlayed: 0, skips: 0, completions: 0, track: null
}))

const stateAt = (epoch = 'first', revision = 3) =>
  ({ epoch, phase: 'ready', statisticsRevision: revision }) as CoreSnapshot
const summary = (revision = 3): CoreStatisticsOverview => ({
  revision, trackCount: 450, days: { '2026-10-23': 4500 },
  persistence: { dirty: false, failureCount: 0, error: null },
  recorded: { seconds: 4500, plays: 450, trackCount: 450, formats: [] },
  artists: [], history: { mode: 'sqlite', ready: true, pending: false, revision: 1, error: '' }
})
const tick = () => new Promise<void>((done) => setImmediate(done))

test('statistics projection uses bounded ranking pages and exact all-history totals; snapshots are immutable', async () => {
  const state = shallowRef<CoreSnapshot | null>(stateAt())
  const queries: unknown[] = [], clears: unknown[] = []
  const projection = createCoreListeningStats({
    state, overview: async () => summary(),
    page: async (query) => {
      assertValidPage(query)
      queries.push(query)
      const offset = query.offset ?? 0
      return { revision: 3, total: 450, offset, items: rows.slice(offset, offset + query.limit!) }
    },
    clear: async (...args) => { clears.push(args) }
  })
  await projection.ensure()
  assert.deepEqual(queries, [
    ...['recent', 'plays', 'seconds'].map((sort) => ({ sort, revision: 3, limit: 128 })),
    ...['recent', 'plays', 'seconds'].map((sort) => ({ sort, revision: 3, offset: 128, limit: 72 }))
  ])
  for (const sort of ['recent', 'plays', 'seconds'] as const)
    assert.deepEqual(projection.windows.value[sort].map(row => row.id), rows.slice(0, 200).map(row => row.id))
  assert.equal(projection.overview.value?.recorded.trackCount, 450)
  assert.throws(() => { projection.overview.value!.days['2026-10-23'] = 0 }, TypeError)
  await projection.clear(null, 2)
  assert.deepEqual(clears, [[null, 2]], 'preview revision is forwarded unchanged, not silently replaced')
  projection.dispose()
  assert.equal(clears.length, 1)
})

test('a new profile loads empty rankings through valid Core requests without querying extra pages', async () => {
  const queries: unknown[] = []
  const projection = createCoreListeningStats({
    state: shallowRef<CoreSnapshot | null>(stateAt()),
    overview: async () => ({ ...summary(), trackCount: 0 }),
    page: async (query) => {
      assertValidPage(query)
      queries.push(query)
      return { revision: 3, total: 0, offset: 0, items: [] }
    },
    clear: async () => {}
  })
  await projection.ensure()
  assert.equal(projection.error.value, '')
  assert.equal(projection.ready.value, true)
  assert.deepEqual(projection.windows.value, { recent: [], plays: [], seconds: [] })
  assert.equal(queries.length, 3)
  projection.dispose()
})

test('epoch changes cancel old reads without cancelling Core work or publishing stale results', async () => {
  const state = shallowRef<CoreSnapshot | null>(stateAt())
  const requests: Array<{ signal: AbortSignal; resolve(value: CoreStatisticsOverview): void }> = []
  const projection = createCoreListeningStats({ state,
    overview: (signal) => new Promise((resolve) => { requests.push({ signal, resolve }) }),
    page: async (query) => ({ revision: query.revision!, total: 0, offset: 0, items: [] }),
    clear: async () => { throw Error('no writes expected') }
  })
  state.value = stateAt('second', 4)
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve(summary(4))
  await tick()
  requests[0].resolve(summary(3))
  await tick()
  assert.equal(projection.overview.value?.revision, 4)
  projection.dispose()
  assert.equal(requests[1].signal.aborted, true)
})

test('history refresh failures invalidate the old ready fence and explicit retry restores it', async () => {
  let fail = false, revision = 1
  const projection = createCoreListeningStats({
    state: shallowRef<CoreSnapshot | null>(stateAt()),
    overview: async () => {
      if (fail) throw new Error('history unavailable')
      const value = summary()
      value.history.revision = revision
      return value
    },
    page: async () => ({ revision: 3, total: 0, offset: 0, items: [] }),
    clear: async () => { throw new Error('unexpected write') }
  })
  await projection.ensure()
  assert.equal(projection.history.value.ready, true)
  fail = true
  const refreshing = projection.refresh()
  assert.equal(projection.history.value.pending, true)
  await assert.rejects(refreshing, /history unavailable/)
  assert.equal(projection.history.value.pending, false)
  assert.equal(projection.history.value.ready, false)
  assert.equal(projection.history.value.error, 'history unavailable')
  assert.equal(projection.overview.value?.history.revision, 1, 'old presentation remains available')
  fail = false
  revision = 2
  await projection.refresh()
  assert.equal(projection.history.value.ready, true)
  assert.equal(projection.history.value.revision, 2)
  assert.equal(projection.history.value.error, '')
  projection.dispose()
})

test('stale history reads refresh once per fence without replaying writes or looping on an unchanged revision', async () => {
  let reads = 0, revision = 1
  const state = shallowRef<CoreSnapshot | null>(stateAt())
  const projection = createCoreListeningStats({
    state,
    overview: async () => {
      reads++
      const value = summary()
      value.history.revision = revision
      return value
    },
    page: async () => ({ revision: 3, total: 0, offset: 0, items: [] }),
    clear: async () => { throw new Error('unexpected write') }
  })
  const stale = Object.assign(new Error('history changed'), { code: 'STALE_HISTORY_REVISION' })
  await projection.ensure()
  assert.equal(projection.recoverHistory(1, new Error('database unavailable')), false)
  assert.equal(reads, 1)
  revision = 2
  assert.equal(projection.recoverHistory(1, stale), true)
  assert.equal(projection.recoverHistory(1, stale), false, 'concurrent reads share recovery')
  await projection.ensure()
  assert.equal(projection.history.value.revision, 2)
  assert.equal(reads, 2)
  assert.equal(projection.recoverHistory(1, stale), false, 'an old failure cannot restart recovery')
  assert.equal(projection.recoverHistory(2, stale), true)
  await projection.ensure()
  assert.equal(projection.recoverHistory(2, stale), false, 'an unchanged fence must stop retrying')
  assert.equal(projection.recoverHistory(1, stale), false, 'a late older failure cannot restart recovery')
  assert.equal(reads, 3)
  state.value = stateAt('second')
  await projection.ensure()
  assert.equal(projection.recoverHistory(2, stale), true, 'a new Core epoch has its own fence')
  await projection.ensure()
  projection.dispose()
})
