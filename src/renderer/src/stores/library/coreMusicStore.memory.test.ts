import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, nextTick } from 'vue'
import { coreLibraryFixture } from '../coreLibraryTestFixture.ts'
import { createCoreMusicStore } from './coreMusicStore.ts'
import type { Track } from '../../types/music.ts'

const track = (id: string): Track => ({
  id,
  title: id,
  artist: 'Memory',
  album: 'Fixture',
  duration: 180,
  size: 1,
  source: 'local'
})

test('large selection summaries retain no new display favorites and preserve ordinary reactive queries', async (t) => {
  const f = await coreLibraryFixture(t)
  const store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadApplicationLibrary()
  const query = f.core.query
  let calls = 0,
    liked = true
  f.core.query = async (name, payload, signal) => {
    if (name !== 'playlists.favorites') return query(name, payload, signal)
    const items = (payload as { items: unknown[] }).items
    assert.ok(items.length <= 200)
    calls++
    return { revision: 1, contains: items.map(() => liked) } as never
  }
  const visible = track('visible'),
    favorite = computed(() => store.isFavoriteTrack(visible))
  assert.equal(favorite.value, false)
  await store.getFavoriteTrackStates([visible])
  assert.equal(favorite.value, true)
  const summary = await store.readFavoriteTrackPages(async (append) => {
    for (let offset = 0; offset < 10_000; offset += 200)
      await append(Array.from({ length: 200 }, (_, i) => track(`bulk:${offset + i}`)))
  })
  assert.deepEqual(summary, { count: 10_000, favoriteCount: 10_000 })
  assert.equal(calls, 51)
  assert.equal(store.isFavoriteTrack(track('bulk:0')), false)
  assert.equal(store.isFavoriteTrack(track('bulk:9999')), false)
  assert.equal(favorite.value, true)
  liked = false
  await store.getFavoriteTrackStates([visible])
  assert.equal(favorite.value, false)
})

test('selection cancellation during its last page rejects rather than publishing a completed summary', async (t) => {
  const f = await coreLibraryFixture(t),
    store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadApplicationLibrary()
  const query = f.core.query,
    controller = new AbortController()
  f.core.query = async (name, payload, signal) => {
    if (name !== 'playlists.favorites') return query(name, payload, signal)
    assert.equal(signal, controller.signal)
    controller.abort()
    return { revision: 1, contains: [true] } as never
  }
  await assert.rejects(
    store.readFavoriteTrackPages(async (append) => append([track('cancelled')]), controller.signal),
    { name: 'AbortError' }
  )
  assert.equal(store.isFavoriteTrack(track('cancelled')), false)
})

test('an old favorite response cannot repopulate state after a revision change or disposal', async (t) => {
  const f = await coreLibraryFixture(t),
    store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadApplicationLibrary()
  const query = f.core.query
  let release!: () => void
  let held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.core.query = async (name, payload, signal) => {
    if (name !== 'playlists.favorites') return query(name, payload, signal)
    await held
    return { revision: 1, contains: [true] } as never
  }
  const pending = store.getFavoriteTrackStates([track('old')])
  f.publish({ playlistsRevision: f.state.value.playlistsRevision! + 1 })
  await nextTick()
  release()
  assert.deepEqual(await pending, [true])
  assert.equal(store.isFavoriteTrack(track('old')), false)
  held = new Promise<void>((resolve) => {
    release = resolve
  })
  const disposed = store.getFavoriteTrackStates([track('disposed')])
  store.dispose()
  release()
  await disposed
  assert.equal(store.isFavoriteTrack(track('disposed')), false)
})
