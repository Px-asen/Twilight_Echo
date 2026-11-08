import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import { createCorePlayerResource } from './corePlayerResource.ts'
import { createCorePlaybackBookmarks } from '../playbackBookmarks.ts'
import { createCoreLyricsManagement } from '../lyricsManagement.ts'
import { coreSnapshot } from '../coreTestFixtures.ts'
import type { CorePlayerClient } from './corePlayerTypes.ts'

const tick = async () => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('rapid projection changes cancel obsolete reads without cancelling another resource', async (t) => {
  const scope = effectScope()
  t.after(() => scope.stop())
  const key = ref('0')
  const pending = new Map<AbortSignal, (value: string) => void>()
  const failures: unknown[] = []
  let cancelled = 0
  const query = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const abort = () => {
        pending.delete(signal)
        cancelled++
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      pending.set(signal, (value) => {
        pending.delete(signal)
        signal.removeEventListener('abort', abort)
        resolve(value)
      })
    })
  const resources = scope.run(() => ({
    changing: createCorePlayerResource(
      () => key.value,
      query,
      (error) => failures.push(error)
    ),
    independent: createCorePlayerResource(
      () => 'independent',
      query,
      (error) => failures.push(error)
    )
  }))!
  const independentSignal = [...pending.keys()][1]
  for (let index = 1; index <= 1000; index++) {
    key.value = String(index)
    await tick()
    assert.equal(pending.size, 2, 'only the current read of each resource remains pending')
    assert.equal(independentSignal.aborted, false)
  }
  assert.equal(cancelled, 1000)
  const currentSignal = [...pending.keys()].find((signal) => signal !== independentSignal)!
  pending.get(currentSignal)!('latest')
  pending.get(independentSignal)!('independent')
  await tick()
  assert.equal(resources.changing.value.value, 'latest')
  assert.equal(resources.independent.value.value, 'independent')
  assert.deepEqual(failures, [])

  key.value = ''
  await tick()
  assert.equal(resources.changing.value.value, null)
  key.value = 'reopened'
  await tick()
  assert.equal(pending.size, 1)
  scope.stop()
  await tick()
  assert.equal(pending.size, 0)
  assert.equal(resources.changing.loading.value, false)
  await resources.changing.refresh()
  assert.equal(pending.size, 0)
  assert.deepEqual(failures, [])
})

test('superseded manual refreshes settle quietly while current query failures remain visible', async (t) => {
  const scope = effectScope()
  t.after(() => scope.stop())
  const failures: unknown[] = []
  const pending: Array<{ signal: AbortSignal; reject(error: Error): void }> = []
  const resource = scope.run(() =>
    createCorePlayerResource(
      () => 'ready',
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          pending.push({ signal, reject })
        }),
      (error) => failures.push(error)
    )
  )!
  const first = resource.refresh()
  const second = resource.refresh()
  await first
  assert.equal(pending[1].signal.aborted, true)
  const failure = new Error('transport unavailable')
  pending[2].reject(failure)
  await assert.rejects(second, failure)
  assert.deepEqual(failures, [failure])
  assert.equal(resource.loading.value, false)
})

test('disposing bookmark menus cancels the pending page and reopening loads the catalog', async () => {
  const state = shallowRef(coreSnapshot({ bookmarksRevision: 1 }))
  const calls: string[] = []
  let pageSignal: AbortSignal | undefined
  let holdPage = true
  const core: Pick<CorePlayerClient, 'state' | 'attach' | 'query'> = {
    state,
    attach: async () => state.value,
    query: async (name, _payload, signal) => {
      signal?.throwIfAborted()
      calls.push(name)
      if (name === 'bookmarks.state') return { revision: 1, longTrackResumeSeconds: 1200 } as never
      pageSignal = signal
      if (holdPage)
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      return {
        revision: 1,
        total: 1,
        offset: 0,
        items: [{ id: 'bookmark', trackId: 'track', positionSeconds: 30, kind: 'resume' }]
      } as never
    }
  }
  const closed = createCorePlaybackBookmarks(core)
  await tick()
  assert.equal(pageSignal?.aborted, false)
  closed.dispose()
  await tick()
  assert.equal(pageSignal?.aborted, true)
  assert.deepEqual(calls, ['bookmarks.state', 'bookmarks.page'])
  assert.equal(closed.error.value, null)
  holdPage = false
  const reopened = createCorePlaybackBookmarks(core)
  try {
    await tick()
    await reopened.ensureLoaded()
    assert.equal(reopened.resumeBookmarkFor({ id: 'track' })?.id, 'bookmark')
  } finally {
    reopened.dispose()
  }
})

test('disposing lyrics management cancels the first read before fetching content', async () => {
  const state = shallowRef(coreSnapshot({ lyricsRevision: 1, lyricsContentRevision: 1 }))
  const calls: string[] = []
  let currentSignal: AbortSignal | undefined
  const core: Pick<CorePlayerClient, 'state' | 'attach' | 'query' | 'command'> = {
    state,
    attach: async () => state.value,
    command: async () => undefined,
    query: async (name, _payload, signal) => {
      signal?.throwIfAborted()
      calls.push(name)
      currentSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
      return null as never
    }
  }
  const store = createCoreLyricsManagement(core)
  await tick()
  store.dispose()
  await tick()
  assert.equal(currentSignal?.aborted, true)
  assert.deepEqual(calls, ['lyrics.state'])
  assert.equal(store.error.value, null)
})
