import assert from 'node:assert/strict'
import test from 'node:test'
import type { TrackData } from '../../shared/track.ts'
import type { PreparedPlaybackSource } from './sourceRecovery.ts'
import { createSourcePrefetchQueue } from './sourcePrefetch.ts'

const track = (id: string): TrackData => ({ id, queueEntryId: `entry-${id}` }) as unknown as TrackData
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

function fixture(options: { failure?: (id: string) => boolean; ttl?: number } = {}) {
  const reads: string[] = []
  const now = { value: 1_000 }
  const queue = createSourcePrefetchQueue({
    key: (value) => `${value.queueEntryId}:${value.id}`,
    now: () => now.value,
    gapMs: 0,
    prepare: async (value) => {
      reads.push(value.id)
      if (options.failure?.(value.id)) throw new Error('Unable to resolve the selected audio source')
      return {
        track: value,
        resolved: {
          source: `https://audio.test/${value.id}`,
          expiresAt: now.value + (options.ttl ?? 60_000)
        }
      } as PreparedPlaybackSource
    }
  })
  return { queue, reads, now }
}

test('warms every occurrence ahead of the cursor and hands a warm source out once', async () => {
  const f = fixture()
  f.queue.schedule([track('a'), track('b'), track('c')])
  await settle()
  assert.deepEqual(f.reads, ['a', 'b', 'c'])
  assert.equal(f.queue.size(), 3)

  const warm = f.queue.take(track('a'))
  assert.equal(warm?.resolved.source, 'https://audio.test/a')
  assert.equal(f.queue.take(track('a')), null)
})

test('drops warm occurrences that left the window so a finished track is released', async () => {
  const f = fixture()
  f.queue.schedule([track('a'), track('b'), track('c')])
  await settle()
  assert.equal(f.queue.size(), 3)

  // Playback advanced: the previous occurrence is gone, a new successor is warm.
  f.queue.schedule([track('b'), track('c'), track('d')])
  await settle()
  assert.equal(f.queue.take(track('a')), null)
  assert.equal(f.queue.size(), 3)
  assert.deepEqual(f.reads, ['a', 'b', 'c', 'd'])
})

test('never hands back a source that expired while it waited', async () => {
  const f = fixture({ ttl: 0 })
  f.queue.schedule([track('a')])
  await settle()
  assert.equal(f.queue.take(track('a')), null)
})

test('stops a batch after two consecutive provider failures', async () => {
  const f = fixture({ failure: () => true })
  f.queue.schedule([track('a'), track('b'), track('c'), track('d')])
  await settle()
  assert.deepEqual(f.reads, ['a', 'b'])
  assert.equal(f.queue.size(), 0)
})

test('a newer schedule cancels the batch it replaced', async () => {
  const reads: string[] = []
  let release: (() => void) | null = null
  const queue = createSourcePrefetchQueue({
    key: (value) => value.id,
    now: () => 1_000,
    gapMs: 0,
    prepare: (value) =>
      new Promise<PreparedPlaybackSource>((resolve, reject) => {
        reads.push(value.id)
        if (value.id === 'a') {
          release = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          return
        }
        resolve({
          track: value,
          resolved: { source: `https://audio.test/${value.id}`, expiresAt: 61_000 }
        } as PreparedPlaybackSource)
      })
  })
  queue.schedule([track('a')])
  await new Promise<void>((resolve) => setImmediate(resolve))
  queue.schedule([track('c')])
  await settle()
  release?.()
  await settle()
  assert.equal(queue.take(track('a')), null)
  assert.equal(queue.take(track('c'))?.resolved.source, 'https://audio.test/c')
})
