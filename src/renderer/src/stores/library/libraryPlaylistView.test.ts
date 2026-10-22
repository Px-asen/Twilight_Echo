import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { reactive, watch } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  LibraryPlaylistViewSync,
  LibraryPlaylistViewSyncResult
} from '../../../../shared/libraryDatabase.ts'
import { createLibraryPlaylistView } from './libraryPlaylistView.ts'
import { createLibraryTrackPages } from './libraryTrackPages.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import type { Playlist } from './musicStoreTypes.ts'
import { toPlaylistTrackSnapshot } from './musicStoreData.ts'
import { reconcileImportEntries } from '../../../../shared/externalPlaylist.ts'

const preferences = { revision: 1, versions: [] }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('ordinary and imported uploads inspect only one member window before the first append', async (t) => {
  for (const imported of [false, true]) {
    await t.test(imported ? 'imported members' : 'ordinary members', async () => {
      const trackIds = Array.from({ length: 605 }, (_, index) => String(index))
      let inspected = 0,
        count = 0
      const sizes: number[] = []
      const playlist: Playlist = { id: 'bounded', name: 'Bounded', createdAt: '', trackIds }
      if (imported) {
        let serial = 0
        const entries = reconcileImportEntries(
          [],
          trackIds.map((title) => ({ title })),
          () => String(serial++)
        )
        playlist.imported = {
          version: 1,
          source: { kind: 'file', label: 'Import' },
          entries: new Proxy(entries, {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) inspected++
              return Reflect.get(target, key, receiver)
            }
          }),
          complete: true,
          importedAt: '',
          generation: 'one',
          membershipRevision: 0
        }
      } else {
        playlist.trackSnapshots = new Proxy({}, {
          get() {
            inspected++
            return undefined
          }
        })
      }
      const owner = createLibraryPlaylistView({
        syncPlaylistView: async (request) => {
          if (request.kind === 'begin' || request.kind === 'drop')
            return { id: request.id, sequence: 0, count: 0, committed: false }
          if (request.kind === 'append') {
            if (!sizes.length) assert.equal(inspected, 200)
            sizes.push(request.entries.length)
            count += request.entries.length
          }
          return {
            id: request.id,
            sequence: request.sequence,
            count,
            committed: request.kind === 'commit'
          }
        }
      }, () => 'bounded-view')
      try {
        await owner.setPlaylist(playlist, preferences)
        assert.equal(owner.state.value.error, '')
        assert.deepEqual(sizes, [200, 200, 200, 5])
        assert.equal(inspected, 605)
      } finally {
        await owner.dispose()
      }
    })
  }
})

function fixture(t: TestContext) {
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: Array.from({ length: 605 }, (_, i) => ({
      id: String(i),
      filePath: `D:/Music/${i}.flac`,
      title: `月光 ${i}`,
      artist: '周杰伦',
      duration: i
    }))
  })
  const playlist: Playlist = {
    id: 'playlist',
    name: '收藏',
    createdAt: '',
    trackIds: [...Array.from({ length: 605 }, (_, i) => String(i)), '600', 'ncm:7', 'missing'],
    trackSnapshots: {
      'ncm:7': libraryTrack({
        id: 'ncm:7',
        filePath: '',
        title: 'Remote',
        source: 'ncm',
        lyrics: 'heavy',
        streamUrl: 'https://expired',
        extension: { heavy: 'large' }
      })
    }
  }
  const calls: LibraryPlaylistViewSync[] = []
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      calls.push(structuredClone(request))
      return db.syncPlaylistView(request)
    }
  })
  t.after(async () => {
    await owner.dispose()
    db.close()
  })
  return { db, playlist, calls, owner }
}

test('one upload owner publishes bounded definitions, compact remote snapshots and complete mixed queries', async (t) => {
  const { db, playlist, calls, owner } = fixture(t)
  await owner.setPlaylist(playlist, preferences)
  const id = owner.state.value.id!
  assert.ok(id)
  assert.equal(owner.state.value.pending, false)
  const batches = calls.filter((call) => call.kind === 'append')
  assert.deepEqual(
    batches.map((call) => call.entries.length),
    [200, 200, 200, 8]
  )
  const remote = batches.at(-1)!.entries.find((entry) => entry.id === 'ncm:7')!.snapshot!
  assert.equal(remote.lyrics, null)
  assert.equal(remote.streamUrl, undefined)
  assert.equal(remote.extension, undefined)
  const page = db.queryTracks({ playlistView: id, sort: 'playlist', offset: 600 })
  assert.equal(page.total, 607)
  assert.deepEqual(page.entryIds, ['600', '601', '602', '603', '604', '605', '606'])
  assert.equal(page.tracks.at(-1)?.source, 'ncm')
  const queue = db.createLibraryQueue(
    { playlistView: id, playlistEntryId: '605', sort: 'playlist' },
    '600'
  )
  assert.equal(queue.total, 607)
  assert.equal(queue.index, 605)
  assert.equal(db.readLibraryQueue(queue.id, 605).items[0].track?.id, '600')
  const uploads = calls.length
  const renamed = { ...playlist, name: 'Renamed', cover: 'cover://new' }
  await owner.setPlaylist(renamed, preferences)
  assert.equal(calls.length, uploads, 'renaming/cover changes do not reupload membership')
  db.patchTracks([{ id: '600', expectedVersion: page.versions['600'], patch: { title: 'Edited' } }])
  assert.equal(db.queryTracks({ playlistView: id, search: 'Edited' }).total, 2)
  assert.equal(calls.length, uploads, 'content edits refresh projection without a second upload')
  await owner.dispose()
  assert.throws(() => db.queryTracks({ playlistView: id }), /expired/)
  assert.equal(db.readLibraryQueue(queue.id, 606).items[0].track?.source, 'ncm')
})

test('membership/preferences changes replace the lease; expired/restarted views rebuild but ordinary errors do not', async (t) => {
  const { db, playlist, calls, owner } = fixture(t)
  await owner.setPlaylist(playlist, preferences)
  const first = owner.state.value.id!
  db.syncPlaylistView({ kind: 'drop', id: first })
  assert.equal(owner.recover(first, new Error('SQLite disk full')), false)
  assert.equal(owner.recover('stale', new Error('Playlist view expired')), false)
  assert.equal(owner.recover(first, new Error('Playlist view expired; rebuild')), true)
  await owner.setPlaylist(playlist, preferences)
  const recovered = owner.state.value.id!
  assert.notEqual(recovered, first)
  assert.equal(db.queryTracks({ playlistView: recovered }).total, 607)
  await owner.setPlaylist(playlist, { revision: 2, versions: [] })
  assert.notEqual(owner.state.value.id, recovered)
  assert.ok(calls.some((call) => call.kind === 'drop' && call.id === recovered))
  await owner.setPlaylist(
    { ...playlist, trackIds: ['604', 'ncm:7'] },
    { revision: 2, versions: [] }
  )
  assert.equal(db.queryTracks({ playlistView: owner.state.value.id! }).total, 2)
  await owner.setPlaylist(null, preferences)
  assert.equal(owner.state.value.id, null)
  assert.equal(owner.state.value.error, '')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
test('supersession keeps one RPC in flight and never publishes an old or uncertain commit', async () => {
  const pending: Array<
    { request: LibraryPlaylistViewSync } & ReturnType<
      typeof deferred<LibraryPlaylistViewSyncResult>
    >
  > = []
  let active = 0,
    peak = 0,
    serial = 0
  const owner = createLibraryPlaylistView(
    {
      syncPlaylistView: (request) => {
        active++
        peak = Math.max(peak, active)
        const wait = deferred<LibraryPlaylistViewSyncResult>()
        pending.push({ request, ...wait })
        return wait.promise.finally(() => active--)
      }
    },
    () => `view-${++serial}`
  )
  const playlist = { id: 'one', trackIds: ['one'] }
  const finish = async (sequence = 0, count = 0, committed = false) => {
    const call = pending.shift()!
    assert.ok(call)
    call.resolve({ id: call.request.id, sequence, count, committed })
    await tick()
    return call.request
  }
  const task = owner.setPlaylist(playlist, preferences)
  await tick()
  assert.equal((await finish()).kind, 'begin')
  assert.equal((await finish(1, 1)).kind, 'append')
  assert.equal(pending[0].request.kind, 'commit')
  void owner.setPlaylist({ id: 'two', trackIds: ['two'] }, preferences)
  assert.equal(owner.state.value.id, null)
  assert.equal((await finish(2, 1, true)).kind, 'commit')
  assert.equal((await finish()).kind, 'drop')
  assert.equal((await finish()).kind, 'begin')
  assert.equal((await finish(1, 1)).kind, 'append')
  assert.equal((await finish(2, 1, true)).kind, 'commit')
  await task
  assert.equal(owner.state.value.id, 'view-2')
  const disposing = owner.dispose()
  assert.equal((await finish()).kind, 'drop')
  await disposing
  assert.equal(peak, 1)
  assert.equal(owner.state.value.id, null)
})

test('a lost commit reply is dropped, not replayed; explicit retry allocates a fresh identity', async (t) => {
  const { db, playlist } = fixture(t)
  let fault = true,
    commitCount = 0
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      const result = db.syncPlaylistView(request)
      if (request.kind === 'commit') {
        commitCount++
        if (fault) {
          fault = false
          throw new Error('commit reply lost')
        }
      }
      return result
    }
  })
  t.after(() => owner.dispose())
  await owner.setPlaylist(playlist, preferences)
  assert.equal(owner.state.value.id, null)
  assert.match(owner.state.value.error, /reply lost/)
  assert.equal(commitCount, 1)
  await owner.retry()
  assert.equal(db.queryTracks({ playlistView: owner.state.value.id! }).total, 607)
  assert.equal(commitCount, 2)
})

test('page windows follow a rebuilt owner and keep late old reads out of the new playlist', async (t) => {
  const { db, playlist, owner } = fixture(t)
  const late = deferred<ReturnType<LibraryDatabase['queryTracks']>>()
  let first = true
  const pages = createLibraryTrackPages({
    queryTracks: async (query) => {
      const page = db.queryTracks(query)
      if (first) {
        first = false
        return late.promise
      }
      return page
    }
  })
  const stop = watch(
    () => owner.state.value.id,
    (id) => {
      pages.setQuery(id ? { playlistView: id, sort: 'playlist' } : null)
    },
    { flush: 'sync' }
  )
  t.after(() => {
    stop()
    pages.dispose()
  })
  await owner.setPlaylist(playlist, preferences)
  const old = owner.state.value.id!
  const oldPage = db.queryTracks({ playlistView: old })
  await owner.setPlaylist({ ...playlist, trackIds: ['ncm:7'] }, preferences)
  for (let i = 0; i < 30 && pages.state.value.loading; i++) await tick()
  assert.equal(pages.state.value.page?.tracks[0].id, 'ncm:7')
  late.resolve(oldPage)
  await tick()
  assert.equal(pages.state.value.page?.total, 1)
  assert.equal(pages.cacheState.cachedPages, 1)
})

test('unmount waits for an outstanding upload and drops even a begin whose reply was lost', async () => {
  const begin = deferred<LibraryPlaylistViewSyncResult>(),
    calls: LibraryPlaylistViewSync[] = []
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      calls.push(request)
      if (request.kind === 'begin') return begin.promise
      assert.equal(request.kind, 'drop')
      return { id: request.id, sequence: 0, count: 0, committed: false }
    }
  })
  const upload = owner.setPlaylist({ id: 'p', trackIds: ['one'] }, preferences)
  await tick()
  const disposing = owner.dispose()
  assert.equal(calls.length, 1)
  begin.reject(new Error('begin reply lost'))
  await Promise.all([upload, disposing])
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['begin', 'drop']
  )
  assert.equal(calls[0].id, calls[1].id)
  assert.equal(owner.state.value.id, null)
  assert.equal(owner.state.value.error, '')
})

test('failed release retains its obligation and does not allocate more views before explicit retry succeeds', async (t) => {
  const { db, playlist } = fixture(t)
  const calls: LibraryPlaylistViewSync[] = []
  let failDrop = true
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      calls.push(request)
      if (request.kind === 'drop' && failDrop) throw new Error('drop transport failure')
      return db.syncPlaylistView(request)
    }
  })
  await owner.setPlaylist(playlist, preferences)
  const first = owner.state.value.id!
  await owner.setPlaylist({ ...playlist, trackIds: ['0'] }, preferences)
  assert.equal(owner.state.value.id, null)
  assert.match(owner.state.value.error, /drop transport failure/)
  assert.equal(calls.filter((call) => call.kind === 'begin').length, 1)
  failDrop = false
  await owner.retry()
  assert.ok(calls.some((call) => call.kind === 'drop' && call.id === first))
  assert.equal(calls.filter((call) => call.kind === 'begin').length, 2)
  assert.equal(db.queryTracks({ playlistView: owner.state.value.id! }).total, 1)
  await owner.dispose()
})

test('a failed superseded upload cannot replace the latest definition with an old error', async (t) => {
  const { db, playlist } = fixture(t)
  const blocked = deferred<LibraryPlaylistViewSyncResult>()
  let first = true
  const owner = createLibraryPlaylistView({
    syncPlaylistView: async (request) => {
      if (request.kind === 'append' && first) {
        first = false
        return blocked.promise
      }
      return db.syncPlaylistView(request)
    }
  })
  const upload = owner.setPlaylist(playlist, preferences)
  await tick()
  void owner.setPlaylist({ ...playlist, trackIds: ['604'] }, preferences)
  blocked.reject(new Error('old upload failed'))
  await upload
  for (let i = 0; i < 30 && owner.state.value.pending; i++) await tick()
  assert.equal(owner.state.value.error, '')
  assert.equal(db.queryTracks({ playlistView: owner.state.value.id! }).tracks[0].id, '604')
  await owner.dispose()
})

test('reactive network routing nested in playlist snapshots crosses the structured-clone IPC boundary', async (t) => {
  const { db, playlist, owner } = fixture(t)
  const network = reactive(
    libraryTrack({
      id: 'network:file',
      filePath: '',
      source: 'network',
      title: 'Remote',
      networkSource: {
        profileId: 'nas',
        entry: {
          id: 'file',
          profileId: 'nas',
          name: 'song.flac',
          kind: 'audio',
          path: '/song.flac'
        }
      }
    })
  )
  await owner.setPlaylist(
    {
      ...playlist,
      trackIds: [network.id],
      trackSnapshots: { [network.id]: toPlaylistTrackSnapshot(network) }
    },
    preferences
  )
  assert.equal(owner.state.value.error, '')
  const page = db.queryTracks({ playlistView: owner.state.value.id! })
  assert.equal(page.total, 1)
  assert.deepEqual(page.tracks[0].networkSource, {
    profileId: 'nas',
    entry: { id: 'file', profileId: 'nas', name: 'song.flac', kind: 'audio', path: '/song.flac' }
  })
})
