import assert from 'node:assert/strict'
import test from 'node:test'
import { createLogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import type { TrackData } from '../../shared/track.ts'
import { createPlaybackSourceRecovery, type PreparedPlaybackSource } from './sourceRecovery.ts'
import { createSourcePrefetchQueue } from './sourcePrefetch.ts'

const track = (id: string): TrackData =>
  ({ id, source: 'ncm', title: id, artist: 'Artist', queueEntryId: `entry-${id}` }) as unknown as TrackData
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
  const gate: { abort?: () => void } = {}
  const queue = createSourcePrefetchQueue({
    key: (value) => value.id,
    now: () => 1_000,
    gapMs: 0,
    prepare: (value) =>
      new Promise<PreparedPlaybackSource>((resolve, reject) => {
        reads.push(value.id)
        if (value.id === 'a') {
          gate.abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
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
  gate.abort?.()
  await settle()
  assert.equal(queue.take(track('a')), null)
  assert.equal(queue.take(track('c'))?.resolved.source, 'https://audio.test/c')
})

test('retained entries prepared via source recovery keep confirm valid across batch aborts and drop when versionsRevision changes', async () => {
  let revision = 0
  const recovery = createPlaybackSourceRecovery({
    resolver: {
      resolve: async (value) => ({
        source: `https://audio.test/${(value as TrackData).id}`,
        expiresAt: 61_000
      })
    },
    authorize: async (source) => source,
    identity: createLogicalTrackModel(() => undefined),
    versionsRevision: () => revision,
    search: async () => ({ items: [], logicalItems: [], health: {}, total: 0 }),
    now: () => 1_000
  })
  const queue = createSourcePrefetchQueue({
    key: (value) => `${value.queueEntryId}:${value.id}`,
    now: () => 1_000,
    gapMs: 0,
    prepare: (value, signal) => recovery.prepare(value, signal, { allowFallbackSearch: false })
  })
  queue.schedule([track('a'), track('b'), track('c')])
  await settle()
  assert.equal(queue.size(), 3)

  // Rescheduling aborts the previous batch AbortController while keeping 'b' and 'c'.
  queue.schedule([track('b'), track('c'), track('d')])
  await settle()
  const warmB = queue.take(track('b'))
  assert.ok(warmB)
  assert.doesNotThrow(() => warmB.confirm?.())

  // Changing recording preferences invalidates remaining warm entries on take().
  revision++
  assert.equal(queue.take(track('c')), null)
  assert.equal(queue.take(track('d')), null)
})

test('retain releases pins on take, window prune, stale replacement, and clear', async () => {
  const pinned = new Set<string>()
  const released: string[] = []
  let now = 1_000
  let ttl = 60_000
  const queue = createSourcePrefetchQueue({
    key: (value) => `${value.queueEntryId}:${value.id}`,
    now: () => now,
    gapMs: 0,
    retain: (prepared) => {
      const source = prepared.resolved.source
      pinned.add(source)
      return () => {
        pinned.delete(source)
        released.push(source)
      }
    },
    prepare: async (value) => ({
      track: value,
      resolved: {
        source: `https://audio.test/${value.id}`,
        expiresAt: now + ttl
      }
    })
  })
  queue.schedule([track('a'), track('b'), track('c')])
  await settle()
  assert.deepEqual([...pinned].sort(), [
    'https://audio.test/a',
    'https://audio.test/b',
    'https://audio.test/c'
  ])

  // take() releases the pin immediately.
  assert.ok(queue.take(track('a')))
  assert.equal(pinned.has('https://audio.test/a'), false)

  // Window pruning releases 'b' when it leaves the window.
  queue.schedule([track('c'), track('d')])
  await settle()
  assert.equal(pinned.has('https://audio.test/b'), false)
  assert.deepEqual([...pinned].sort(), ['https://audio.test/c', 'https://audio.test/d'])

  // Expiry releases on take() without returning the expired source.
  now += ttl + 1
  ttl = 60_000
  assert.equal(queue.take(track('c')), null)
  assert.equal(pinned.has('https://audio.test/c'), false)

  // clear() releases remaining pins.
  queue.clear()
  assert.deepEqual([...pinned], [])
  assert.ok(released.includes('https://audio.test/d'))
})

test('seed adopts warm entries without starting a batch and cancel aborts in-flight reads while keeping warm entries', async () => {
  const reads: string[] = []
  let abortedCount = 0
  const queue = createSourcePrefetchQueue({
    key: (value) => `${value.queueEntryId}:${value.id}`,
    now: () => 1_000,
    gapMs: 0,
    prepare: (value, signal) =>
      new Promise<PreparedPlaybackSource>((_resolve, reject) => {
        reads.push(value.id)
        signal.addEventListener(
          'abort',
          () => {
            abortedCount++
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          },
          { once: true }
        )
      })
  })
  queue.seed({
    track: track('a'),
    resolved: { source: 'https://audio.test/a', expiresAt: 61_000 }
  })
  assert.deepEqual(reads, [])
  assert.equal(queue.size(), 1)

  queue.schedule([track('a'), track('b')])
  await settle()
  assert.deepEqual(reads, ['b'])

  queue.cancel()
  await settle()
  assert.equal(abortedCount, 1)
  assert.equal(queue.take(track('a'))?.resolved.source, 'https://audio.test/a')
  assert.equal(queue.take(track('b')), null)
})
