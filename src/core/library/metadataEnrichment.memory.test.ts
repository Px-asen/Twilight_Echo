import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryMetadataEnrichmentQueue } from './metadataEnrichment.ts'
import type { TrackData } from '../../shared/track.ts'

const track = (id: number): TrackData => ({
  id: `local:${id}`,
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  album: '',
  duration: 180,
  filePath: `D:/fixture/${id}.flac`,
  fileName: `${id}.flac`,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local'
})
const retained = (queue: LibraryMetadataEnrichmentQueue) =>
  (queue as unknown as { failures: Map<string, unknown> }).failures.size

test('expired failure records are released while the owner is idle', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const queue = new LibraryMetadataEnrichmentQueue({
    retryBaseMs: 100,
    retryMaxMs: 1000,
    provider: {
      searchSongs: async () => {
        throw Error('offline')
      }
    }
  })
  t.after(() => queue.dispose())
  await queue.enqueue(Array.from({ length: 1000 }, (_, i) => track(i)))
  assert.equal(retained(queue), 1000)
  t.mock.timers.tick(1099)
  assert.equal(retained(queue), 1000)
  t.mock.timers.tick(1)
  assert.equal(retained(queue), 0)
})

test('retry windows keep exponential backoff; an idle expired query starts a fresh retry sequence', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let calls = 0
  const queue = new LibraryMetadataEnrichmentQueue({
    retryBaseMs: 100,
    retryMaxMs: 1000,
    provider: {
      searchSongs: async () => {
        calls++
        throw Error('offline')
      }
    }
  })
  t.after(() => queue.dispose())
  await queue.enqueue([track(0)])
  t.mock.timers.tick(100)
  await queue.enqueue([track(0)])
  t.mock.timers.tick(199)
  await queue.enqueue([track(0)])
  assert.equal(calls, 2)
  t.mock.timers.tick(1)
  await queue.enqueue([track(0)])
  assert.equal(calls, 3)
  t.mock.timers.tick(1400)
  assert.equal(retained(queue), 0)
  await queue.enqueue([track(0)])
  t.mock.timers.tick(99)
  await queue.enqueue([track(0)])
  assert.equal(calls, 4)
  t.mock.timers.tick(1)
  await queue.enqueue([track(0)])
  assert.equal(calls, 5)
})

test('expiry cannot erase the retry history of a request still in flight, and disposal clears the timer', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let fail!: () => void,
    calls = 0
  const queue = new LibraryMetadataEnrichmentQueue({
    retryBaseMs: 100,
    retryMaxMs: 1000,
    provider: {
      searchSongs: async () => {
        if (++calls === 2)
          await new Promise<void>((_, reject) => {
            fail = () => reject(Error('slow offline'))
          })
        throw Error('offline')
      }
    }
  })
  t.after(() => queue.dispose())
  await queue.enqueue([track(0)])
  t.mock.timers.tick(100)
  const pending = queue.enqueue([track(0)])
  t.mock.timers.tick(1000)
  assert.equal(retained(queue), 1)
  fail()
  await pending
  t.mock.timers.tick(100)
  await queue.enqueue([track(0)])
  assert.equal(calls, 2)
  await queue.join()
  queue.dispose()
  t.mock.timers.tick(10_000)
  assert.equal(retained(queue), 0)
})
