import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import type { LibraryQueuePage, LibraryQueueSnapshot } from '../../../../shared/libraryDatabase.ts'
import { LIBRARY_PAGE_SIZE } from '../../../../shared/libraryDatabase.ts'
import {
  LIBRARY_QUEUE_MAX_SCROLL_HEIGHT,
  libraryQueueScrollGeometry,
  useLibraryQueueViewport
} from './useLibraryQueueViewport.ts'

Object.assign(globalThis, {
  getComputedStyle: () => ({ paddingTop: '0px', paddingBottom: '0px' })
})

function queue(total = 300_000): LibraryQueueSnapshot {
  return {
    id: 'queue',
    total,
    index: 0,
    revision: 0,
    selectedEntryId: 'entry:0',
    order: 'original'
  }
}

function page(
  snapshot: LibraryQueueSnapshot,
  index: number,
  libraryRevision = 1
): LibraryQueuePage {
  const offset = index * LIBRARY_PAGE_SIZE
  return {
    total: snapshot.total,
    offset,
    revision: snapshot.revision,
    libraryRevision,
    items: Array.from({ length: Math.min(LIBRARY_PAGE_SIZE, snapshot.total - offset) }, (_, i) => ({
      queueEntryId: `entry:${offset + i}`,
      position: offset + i,
      track: {
        id: `track:${Math.floor((offset + i) / 2)}`,
        filePath: `D:/Music/${offset + i}.flac`,
        title: `Song ${offset + i}`,
        artist: 'Artist',
        lyrics: 'not retained by the drawer'
      }
    }))
  }
}

async function settle() {
  await nextTick()
  await new Promise((resolve) => setImmediate(resolve))
  await nextTick()
}

function fixture(
  t: test.TestContext,
  read?: (index: number) => Promise<LibraryQueuePage | null>,
  total = 300_000
) {
  const snapshot = shallowRef<LibraryQueueSnapshot | null>(queue(total)),
    contentRevision = ref(1)
  const reads: number[] = []
  const scope = effectScope()
  const view = scope.run(() =>
    useLibraryQueueViewport({
      snapshot,
      contentRevision,
      readPage: async (index) => {
        reads.push(index)
        return read ? read(index) : page(snapshot.value!, index, contentRevision.value)
      }
    })
  )!
  const container = { clientHeight: 324, scrollTop: 0 } as HTMLElement
  view.containerRef.value = container
  t.after(() => scope.stop())
  return {
    snapshot,
    contentRevision,
    reads,
    view,
    scope,
    scroll(index: number) {
      view.scrollToIndex(index)
    }
  }
}

test('scaled queue geometry reaches 300k and multi-million CUE tails below browser height limits', () => {
  for (const total of [0, 5, 300_000, 5_000_000]) {
    const initial = libraryQueueScrollGeometry(total, 324, 0)
    assert.ok(initial.height <= LIBRARY_QUEUE_MAX_SCROLL_HEIGHT)
    const bottom = libraryQueueScrollGeometry(total, 324, initial.height)
    assert.equal(bottom.range.end, total)
    assert.ok(bottom.range.end - bottom.range.start <= 18)
    if (total > 6) {
      assert.ok(bottom.range.start < total - 1)
      // The final row's bottom coincides with the viewport bottom in physical space.
      assert.ok(
        Math.abs(bottom.translateY + (total - bottom.range.start) * 54 - initial.height) < 0.01
      )
    }
  }
  assert.equal(libraryQueueScrollGeometry(200, 324, 1080).scale, 1)
})

test('300k deep scrolling holds only visible lightweight pages and preserves duplicate occurrence identity', async (t) => {
  const f = fixture(t)
  await settle()
  for (const index of [199, 30_000, 120_199, 299_999, 0]) {
    f.scroll(index)
    await settle()
    const rows = f.view.visibleItems.value
    assert.ok(rows.some((row) => row.index === index && row.state === 'ready'))
    assert.ok(rows.length <= 18)
    assert.ok(f.view.diagnostics.value.pages <= 2)
    assert.ok(f.view.diagnostics.value.rows <= 400)
    assert.ok(rows.every((row) => !('track' in row) && !('lyrics' in row)))
  }
  const [first, second] = f.view.visibleItems.value
  assert.equal(first.id, second.id)
  assert.notEqual(first.queueEntryId, second.queueEntryId)
  assert.ok(f.reads.length < 12)
})

test('unchanged playback snapshots preserve loaded rows, page reads and the manual scroll position', async (t) => {
  const f = fixture(t)
  await settle()
  f.scroll(30_000)
  await settle()
  const rows = f.view.visibleItems.value
  const reads = f.reads.length
  const scrollTop = f.view.containerRef.value!.scrollTop
  for (let tick = 0; tick < 12; tick++) {
    // Each Core progress event arrives as a fresh snapshot object.
    f.snapshot.value = { ...f.snapshot.value! }
    assert.ok(f.view.visibleItems.value.every((row) => row.state === 'ready'))
    await settle()
    assert.equal(f.reads.length, reads)
    assert.equal(f.view.containerRef.value!.scrollTop, scrollTop)
    assert.equal(f.view.visibleItems.value[0], rows[0])
  }
})

test('cursor-only changes locate the new track without invalidating its already loaded page', async (t) => {
  const f = fixture(t, undefined, 1057)
  await settle()
  const rows = f.view.visibleItems.value
  const reads = f.reads.length
  f.snapshot.value = { ...f.snapshot.value!, index: 3, selectedEntryId: 'entry:3' }
  await settle()
  assert.equal(f.reads.length, reads)
  assert.ok(f.view.visibleItems.value.includes(rows[3]))
  assert.ok(f.view.visibleItems.value.every((row) => row.state === 'ready'))
})

test('progress snapshots do not cancel pending page reads or retry failed requests', async (t) => {
  let reject!: (error: Error) => void
  const f = fixture(
    t,
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  for (let tick = 0; tick < 12; tick++) {
    f.snapshot.value = { ...f.snapshot.value! }
    await nextTick()
  }
  assert.equal(f.reads.length, 1)
  reject(new Error('database unavailable'))
  await settle()
  f.snapshot.value = { ...f.snapshot.value! }
  await settle()
  assert.equal(f.reads.length, 1)
  assert.equal(f.view.error.value, 'database unavailable')
})

test('rapid scroll applies backpressure instead of enqueueing every intermediate page', async (t) => {
  const releases: Array<() => void> = []
  const f = fixture(
    t,
    (index) => new Promise((resolve) => releases.push(() => resolve(page(queue(), index))))
  )
  f.scroll(30_000)
  await nextTick()
  for (let index = 40_000; index < 250_000; index += 3000) {
    f.scroll(index)
    await nextTick()
  }
  f.scroll(299_999)
  await nextTick()
  assert.equal(f.reads.length, 2)
  assert.equal(f.view.diagnostics.value.activeReads, 2)
  releases[0]()
  releases[1]()
  await settle()
  assert.deepEqual(f.reads, [0, 149, 1499])
  releases[2]()
  await settle()
  assert.ok(f.view.visibleItems.value.some((row) => row.index === 299_999 && row.state === 'ready'))
  assert.equal(f.view.diagnostics.value.pages, 1)
})

test('loading is not missing and a failed page waits for explicit retry', async (t) => {
  let reject!: (reason: Error) => void
  const f = fixture(
    t,
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  assert.ok(f.view.visibleItems.value.every((row) => row.state === 'loading'))
  reject(new Error('worker unavailable'))
  await settle()
  assert.equal(f.view.error.value, 'worker unavailable')
  assert.equal(f.reads.length, 1)
  assert.ok(f.view.visibleItems.value.every((row) => row.state === 'loading'))
  f.view.retry()
  assert.equal(f.reads.length, 2)
  reject(new Error('still unavailable'))
  await settle()
})

test('only a returned SQL hole becomes a removable missing row', async (t) => {
  const f = fixture(t, async (index) => {
    const result = page(queue(), index)
    result.items[0].track = null
    return result
  })
  await settle()
  assert.equal(f.view.visibleItems.value[0].state, 'missing')
  assert.equal(f.view.visibleItems.value[0].queueEntryId, 'entry:0')
  assert.equal(f.view.visibleItems.value[1].state, 'ready')
})

test('queue/content revisions fence late pages while keeping reads bounded across replacements', async (t) => {
  const pending: Array<{ result: LibraryQueuePage; release: () => void }> = []
  const f = fixture(t, (index) => {
    // First request starts before fixture returns.
    const result = page(
      pending.length === 0 ? queue() : f.snapshot.value!,
      index,
      pending.length === 0 ? 1 : f.contentRevision.value
    )
    return new Promise((resolve) => pending.push({ result, release: () => resolve(result) }))
  })
  f.snapshot.value = { ...queue(), id: 'replacement', revision: 4 }
  f.contentRevision.value = 8
  assert.equal(f.reads.length, 2)
  pending[0].release()
  pending[1].release()
  await settle()
  assert.equal(f.view.diagnostics.value.pages, 0)
  assert.equal(f.reads.length, 3)
  pending[2].release()
  await settle()
  assert.ok(
    f.view.visibleItems.value.every(
      (row) => row.queueId === 'replacement' && row.revision === 4 && row.state === 'ready'
    )
  )
  assert.equal(f.view.error.value, '')
})

test('an older-than-observed library response stops with a retry error rather than spinning', async (t) => {
  const f = fixture(t, async (index) => page(queue(), index, 0))
  await settle()
  assert.match(f.view.error.value, /曲库正在更新/)
  assert.equal(f.reads.length, 1)
  assert.equal(f.view.diagnostics.value.pages, 0)
})

test('switching source with the same numeric cursor locates its own current row', async (t) => {
  const f = fixture(t)
  await settle()
  f.scroll(250_000)
  await settle()
  f.snapshot.value = { ...queue(), id: 'new-source' }
  await settle()
  assert.ok(f.view.visibleItems.value.some((row) => row.index === 0))
})

test('dispose ignores late success and failures without starting another read', async (t) => {
  let release!: (value: LibraryQueuePage) => void
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  f.scope.stop()
  release(page(queue(), 0))
  await settle()
  assert.equal(f.view.diagnostics.value.pages, 0)
  assert.equal(f.reads.length, 1)
})
