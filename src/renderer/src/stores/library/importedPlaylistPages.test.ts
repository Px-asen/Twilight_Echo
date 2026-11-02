import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ref, shallowRef } from 'vue'
import type { TrackData as Track } from '../../../../shared/track.ts'
import type {
  Playlist,
  PlaylistPersistenceNotice,
  PlaylistTrackPageProducer
} from './musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../playlistPersistence.ts'
import { createPlaylistController } from './playlistController.ts'
import { externalEntryForTrack, withExternalMembership } from './externalPlaylistMembership.ts'
import { replayExternalPlaylist } from './externalPlaylistReplay.ts'
import { externalRefreshGeneration } from '../../../../shared/externalPlaylist.ts'
import { slimPlaylistLegacySnapshots } from './musicStoreData.ts'
import { PersistentDataRevisionConflictError } from '../../../../shared/versionedPersistence.ts'

function track(i: number): Track {
  return {
    id: `t${i}`,
    title: `Song ${i}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:/music/${i}.flac`,
    fileName: `${i}.flac`,
    duration: 180,
    size: 1,
    cover: null,
    lyrics: 'heavy',
    source: 'local'
  }
}
function imported(id: string, count = 3): Playlist {
  return {
    id,
    name: id,
    trackIds: [],
    createdAt: '',
    imported: {
      version: 1,
      source: { kind: 'file', label: 'mix.csv' },
      complete: true,
      importedAt: '',
      generation: `${id}:refresh`,
      membershipRevision: 0,
      entries: Array.from({ length: count }, (_, i) => ({
        ...externalEntryForTrack(track(i), i),
        entryId: `${id}:e${i}`
      }))
    }
  }
}
async function fixture(t: TestContext, records: Playlist[]) {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const playlists = shallowRef<Playlist[]>([]),
    status = ref<PlaylistPersistenceStatus>({
      state: 'idle',
      dirty: false,
      failureCount: 0,
      lastError: null
    })
  const base = [
    { id: 'favorites', name: 'Favorites', isDefault: true, trackIds: [], createdAt: '' },
    ...records
  ]
  const writes: Playlist[][] = []
  let authority = structuredClone(base),
    revision = 1
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        data: {
          loadPlaylists: async () => ({
            version: 2,
            revision,
            savedAt: '',
            data: structuredClone(authority)
          }),
          savePlaylists: async (data: Playlist[], expected: number) => {
            if (expected !== revision)
              throw new PersistentDataRevisionConflictError(
                { version: 2, revision, savedAt: '', data: structuredClone(authority) },
                expected
              )
            writes.push(structuredClone(data))
            authority = structuredClone(data)
            revision++
            return { version: 2, revision, savedAt: '', data: structuredClone(data) }
          }
        }
      }
    }
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const controller = createPlaylistController({
    playlists,
    tracks: shallowRef([]),
    trackById: new Map(),
    getTracksRevision: () => 0,
    playlistPersistenceStatus: status,
    playlistPersistenceNotice: ref<PlaylistPersistenceNotice | null>(null)
  })
  await controller.loadPlaylists()
  return {
    controller,
    playlists,
    status,
    writes,
    get: (id: string) => playlists.value.find((playlist) => playlist.id === id)!,
    getAuthority: () => authority,
    remote: (edit: (data: Playlist[]) => void) => {
      edit(authority)
      revision++
    }
  }
}

test('imported append stages 10005 compact occurrences in 51 pages and clones only transaction endpoints', async (t) => {
  const { controller, get, writes } = await fixture(t, [imported('imported', 0)])
  const clones = t.mock.method(globalThis, 'structuredClone')
  let pages = 0
  assert.equal(
    await controller.addTrackPagesToPlaylistById('imported', async (append) => {
      for (let offset = 0; offset < 10_005; offset += 200) {
        const page = Array.from({ length: Math.min(200, 10_005 - offset) }, (_, i) => ({
          ...track(offset + i),
          cueRange: { startSeconds: i, endSeconds: i + 1, pregapSeconds: 0 },
          cueEncoding: 'utf-8' as const
        }))
        await append(page)
        pages++
        page[0].title = 'mutated'
        assert.equal(get('imported').imported!.entries.length, 0)
        assert.equal(clones.mock.callCount(), 0)
      }
    }),
    10_005
  )
  assert.equal(pages, 51)
  assert.equal(clones.mock.callCount(), 0)
  const data = get('imported').imported!
  assert.equal(data.entries[0].manualBinding!.title, 'Song 0')
  assert.equal(data.entries[0].manualBinding!.lyrics, null)
  assert.equal(data.entries[200].resolution.track!.cueEncoding, 'utf-8')
  assert.deepEqual(data.entries[200].resolution.track!.cueRange, {
    startSeconds: 0,
    endSeconds: 1,
    pregapSeconds: 0
  })
  assert.equal(new Set(data.entries.map((entry) => entry.entryId)).size, 10_005)
  assert.equal(data.refreshGeneration, 'imported:refresh')
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('append preserves concurrent occurrence removal, duplicate additions, binding and presentation edits', async (t) => {
  const { controller, get } = await fixture(t, [imported('imported')])
  const generation = get('imported').imported!.generation
  assert.equal(
    await controller.addTrackPagesToPlaylistById('imported', async (append) => {
      await append([track(4), track(4)])
      controller.bindExternalEntry('imported', 'imported:e0', track(99))
      controller.removeExternalEntries('imported', ['imported:e1'])
      controller.addTracksToPlaylistById('imported', [track(5)])
      controller.renamePlaylist('imported', 'Renamed')
      controller.setPlaylistCover('imported', 'cover://edited')
    }),
    2
  )
  const data = get('imported').imported!
  assert.deepEqual(
    data.entries.map((entry) => entry.manualBinding?.id),
    ['t99', 't2', 't5', 't4', 't4']
  )
  assert.deepEqual(
    data.entries.map((entry) => entry.position),
    [0, 1, 2, 3, 4]
  )
  assert.equal(data.entries[0].revision, 1)
  assert.equal(get('imported').cover, 'cover://edited')
  assert.equal(get('imported').name, 'Renamed')
  assert.equal(externalRefreshGeneration(data), generation)
  assert.equal(
    controller.applyExternalResolution('imported', generation, 'imported:e2', 0, {
      state: 'missing'
    }),
    false
  )
  await controller.flushPlaylists()
})

for (const failure of ['read', 'abort', 'guard', 'swallowed', 'refresh'] as const) {
  test(`imported append ${failure} never publishes a partial document`, async (t) => {
    const { controller, get, writes } = await fixture(t, [imported('imported')])
    const before = structuredClone(get('imported')),
      abort = new AbortController()
    const produce: PlaylistTrackPageProducer = async (append) => {
      await append([track(4)])
      if (failure === 'read') throw new Error('source failed')
      if (failure === 'abort') abort.abort()
      if (failure === 'guard')
        return () => {
          throw new Error('late source changed')
        }
      if (failure === 'swallowed') await append(null as unknown as Track[]).catch(() => {})
      if (failure === 'refresh')
        controller.refreshExternalPlaylist(
          'imported',
          {
            name: 'Updated',
            songs: [{ title: 'Fresh' }],
            source: { kind: 'file', label: 'mix.csv' },
            complete: true,
            warnings: []
          },
          true
        )
      return undefined
    }
    await assert.rejects(controller.addTrackPagesToPlaylistById('imported', produce, abort.signal))
    if (failure !== 'refresh') assert.deepEqual(get('imported'), before)
    else
      assert.deepEqual(
        get('imported').imported!.entries.map((entry) => entry.original.title),
        ['Fresh']
      )
    await controller.flushPlaylists()
    assert.equal(writes.length, failure === 'refresh' ? 1 : 0)
  })
}

test('imported remove/reorder use entry IDs, not duplicate resolved track IDs', async (t) => {
  const record = imported('imported')
  record.imported!.entries[1] = {
    ...record.imported!.entries[0],
    entryId: 'duplicate',
    position: 1
  }
  const { controller, get } = await fixture(t, [record])
  assert.equal(
    await controller.removeTrackIdPagesFromPlaylistById('imported', async (append) => {
      await append(['t0'])
    }),
    0
  )
  assert.equal(
    await controller.reorderPlaylistTrackIdPagesById(
      'imported',
      async (append) => {
        await append(['duplicate'])
      },
      0
    ),
    true
  )
  assert.deepEqual(
    get('imported').imported!.entries.map((entry) => entry.entryId),
    ['duplicate', 'imported:e0', 'imported:e2']
  )
  assert.equal(
    await controller.removeTrackIdPagesFromPlaylistById('imported', async (append) => {
      await append(['duplicate'])
    }),
    1
  )
  assert.deepEqual(
    get('imported').imported!.entries.map((entry) => entry.entryId),
    ['imported:e0', 'imported:e2']
  )
  assert.deepEqual(
    get('imported').imported!.entries.map((entry) => entry.position),
    [0, 1]
  )
  await controller.flushPlaylists()
})

test('imported-to-imported move preserves unavailable metadata and manual choices as independent occurrences', async (t) => {
  const record = imported('source')
  record.imported!.entries[1] = {
    ...record.imported!.entries[1],
    manualBinding: undefined,
    resolution: { state: 'missing', message: 'unavailable' }
  }
  const { controller, get, writes } = await fixture(t, [record, imported('target', 0)])
  assert.deepEqual(
    await controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(['source:e1', 'source:e0', 'source:e0'])
      controller.bindExternalEntry('source', 'source:e0', track(99))
    }),
    { moved: 2, sourceRemoved: 2 }
  )
  assert.deepEqual(
    get('source').imported!.entries.map((entry) => entry.entryId),
    ['source:e2']
  )
  const entries = get('target').imported!.entries
  assert.equal(entries[0].manualBinding!.id, 't99')
  assert.equal(entries[0].revision, 1)
  assert.equal(entries[1].resolution.state, 'missing')
  assert.equal(entries[1].original.title, 'Song 1')
  assert.ok(entries.every((entry) => !entry.entryId.startsWith('source:')))
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('ordinary/imported transfers use exact bounded fallback snapshots and never move unresolved metadata into ordinary IDs', async (t) => {
  const ordinary: Playlist = { id: 'ordinary', name: 'Ordinary', trackIds: ['t7'], createdAt: '' }
  const { controller, get } = await fixture(t, [ordinary, imported('imported', 0)])
  assert.deepEqual(
    await controller.movePlaylistMemberPagesById('ordinary', 'imported', async (append) => {
      await append([{ id: 't7', track: { ...track(7), subTrack: '2' } }])
    }),
    { moved: 1, sourceRemoved: 1 }
  )
  const entryId = get('imported').imported!.entries[0].entryId
  assert.equal(get('imported').imported!.entries[0].resolution.track!.subTrack, '2')
  assert.deepEqual(
    await controller.movePlaylistTrackIdPagesById('imported', 'ordinary', async (append) => {
      await append([entryId])
    }),
    { moved: 1, sourceRemoved: 1 }
  )
  assert.deepEqual(get('ordinary').trackIds, ['t7'])
  assert.equal(get('ordinary').trackSnapshots!.t7.subTrack, '2')
  controller.refreshExternalPlaylist(
    'imported',
    {
      name: 'Missing',
      songs: [{ title: 'Unresolved' }],
      source: { kind: 'file', label: 'mix.csv' },
      complete: true,
      warnings: []
    },
    true
  )
  const missingId = get('imported').imported!.entries[0].entryId
  await assert.rejects(
    controller.movePlaylistTrackIdPagesById('imported', 'ordinary', async (append) => {
      await append([missingId])
    }),
    /尚未匹配/
  )
  assert.equal(get('imported').imported!.entries.length, 1)
  await controller.flushPlaylists()
})

test('transient editing never persists or removes committed source members before explicit save', async (t) => {
  const { controller, get, writes } = await fixture(t, [imported('saved', 1)])
  // loadPlaylists only receives persistent authority in the app; create the preview now.
  const previewId = controller.createExternalPlaylist(
    {
      name: 'Preview',
      songs: [],
      source: { kind: 'file', label: 'mix.csv' },
      complete: true,
      warnings: []
    },
    true
  )
  await controller.addTrackPagesToPlaylistById(previewId, async (append) => {
    await append([track(1), track(1)])
  })
  const ids = get(previewId).imported!.entries.map((entry) => entry.entryId)
  await controller.removeTrackIdPagesFromPlaylistById(previewId, async (append) => {
    await append([ids[0]])
  })
  await controller.flushPlaylists()
  assert.equal(writes.length, 0)
  await assert.rejects(
    controller.movePlaylistTrackIdPagesById(previewId, 'saved', async (append) => {
      await append([ids[1]])
    }),
    /请先保存/
  )
  await assert.rejects(
    controller.movePlaylistTrackIdPagesById('saved', previewId, async (append) => {
      await append(['saved:e0'])
    }),
    /请先保存/
  )
  assert.equal(get('saved').imported!.entries.length, 1)
  controller.saveExternalPlaylist(previewId)
  assert.equal(await controller.flushPlaylists(), true)
  assert.equal(writes.length, 1)
})

test('occurrence delta CAS merge retains remote additions/removals/order and newer manual choices', () => {
  const base = imported('imported').imported!
  const local = withExternalMembership(base, [
    base.entries[1],
    base.entries[2],
    externalEntryForTrack(track(4), 2)
  ])
  const current = withExternalMembership(base, [
    base.entries[2],
    base.entries[0],
    externalEntryForTrack(track(5), 2)
  ])
  current.entries[0] = {
    ...current.entries[0],
    revision: 2,
    manualBinding: track(99),
    resolution: { state: 'local', track: track(99) }
  }
  const merged = replayExternalPlaylist(base, local, current)
  assert.deepEqual(
    merged.entries.map((entry) => entry.manualBinding?.id),
    ['t99', 't5', 't4']
  )
  assert.equal(merged.entries[0].revision, 2)
  assert.deepEqual(
    merged.entries.map((entry) => entry.position),
    [0, 1, 2]
  )
  assert.equal(merged.membershipRevision, 2)
  assert.equal(externalRefreshGeneration(merged), base.generation)
})

test('the persistence owner commits both imported move deltas onto concurrent membership and binding edits', async (t) => {
  const { controller, get, remote, getAuthority, writes, status } = await fixture(t, [
    imported('source'),
    imported('target', 0)
  ])
  await controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
    await append(['source:e1'])
  })
  remote((data) => {
    const source = data.find((item) => item.id === 'source')!
    const latest = source.imported!.entries[2]
    source.imported = withExternalMembership(source.imported!, [
      {
        ...latest,
        revision: 1,
        manualBinding: track(99),
        resolution: { state: 'local', track: track(99) }
      },
      source.imported!.entries[1],
      externalEntryForTrack(track(8), 2)
    ])
    const target = data.find((item) => item.id === 'target')!
    target.name = 'Remote name'
    target.imported = withExternalMembership(target.imported!, [externalEntryForTrack(track(9), 0)])
  })
  assert.equal(await controller.flushPlaylists(), true)
  assert.equal(status.value.dirty, false)
  assert.equal(writes.length, 1)
  assert.deepEqual(
    get('source').imported!.entries.map((entry) => entry.manualBinding?.id),
    ['t99', 't8']
  )
  assert.deepEqual(
    get('target').imported!.entries.map((entry) => entry.manualBinding?.id),
    ['t9', 't1']
  )
  assert.equal(get('target').name, 'Remote name')
  assert.deepEqual(getAuthority(), writes[0])
  assert.equal(get('source').imported!.entries[0].revision, 1)
})

test('reordering never replays an unchanged old resolution and manual choices survive membership generations', () => {
  const base = imported('imported').imported!
  const reordered = withExternalMembership(base, [
    base.entries[2],
    base.entries[0],
    base.entries[1]
  ])
  const current = structuredClone(base)
  current.entries[2].resolution = { state: 'missing', message: 'new result' }
  assert.equal(
    replayExternalPlaylist(base, reordered, current).entries[0].resolution.state,
    'missing'
  )
  const bound = structuredClone(base)
  bound.entries[0] = {
    ...bound.entries[0],
    revision: 1,
    manualBinding: track(99),
    resolution: { state: 'pending' }
  }
  const appended = withExternalMembership(base, [
    ...base.entries,
    externalEntryForTrack(track(4), 3)
  ])
  const merged = replayExternalPlaylist(base, bound, appended)
  assert.equal(merged.entries[0].manualBinding!.id, 't99')
  assert.equal(merged.entries.length, 4)
  const refreshed = { ...appended, generation: 'new-refresh', refreshGeneration: 'new-refresh' }
  refreshed.entries[0] = { ...refreshed.entries[0], original: { title: 'Refreshed metadata' } }
  assert.equal(replayExternalPlaylist(base, bound, refreshed).entries[0].manualBinding!.id, 't99')
  assert.equal(
    replayExternalPlaylist(base, bound, refreshed).entries[0].original.title,
    'Refreshed metadata'
  )
})

test('a debounced membership transaction cannot carry old matching results into another job generation', () => {
  const base = imported('imported').imported!
  const local = withExternalMembership(base, [...base.entries, externalEntryForTrack(track(4), 3)])
  local.entries[0] = { ...local.entries[0], resolution: { state: 'missing', message: 'old job' } }
  const current = withExternalMembership(base, [
    ...base.entries,
    externalEntryForTrack(track(5), 3)
  ])
  current.entries[0] = { ...current.entries[0], resolution: { state: 'local', track: track(99) } }
  const merged = replayExternalPlaylist(base, local, current)
  assert.equal(merged.entries.length, 5)
  assert.equal(merged.entries[0].resolution.track!.id, 't99')
})

test('local and CAS capacity failures cannot publish or persist half of a move', async (t) => {
  const target = imported('target', 19_999)
  const source: Playlist = {
    id: 'source',
    name: 'Source',
    trackIds: ['t20001', 't20002'],
    trackSnapshots: { t20001: track(20001), t20002: track(20002) },
    createdAt: ''
  }
  const { controller, get, writes, remote, status } = await fixture(t, [source, target])
  await assert.rejects(
    controller.addTrackPagesToPlaylistById('target', async (append) => {
      await append([track(20001), track(20002)])
    }),
    /20,000/
  )
  await assert.rejects(
    controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(source.trackIds)
    }),
    /20,000/
  )
  assert.deepEqual(get('source').trackIds, source.trackIds)
  assert.equal(get('target').imported!.entries.length, 19_999)
  assert.equal(writes.length, 0)
  await controller.addTrackPagesToPlaylistById('target', async (append) => {
    await append([track(20001)])
  })
  remote((data) => {
    const playlist = data.find((item) => item.id === 'target')!
    playlist.imported = withExternalMembership(playlist.imported!, [
      ...playlist.imported!.entries,
      externalEntryForTrack(track(20002), 19_999)
    ])
  })
  assert.equal(await controller.flushPlaylists(), false)
  assert.equal(status.value.canRetry, false)
  assert.equal(writes.length, 0)
})

test('recovery read fences later local gestures and preserves their pending state', async (t) => {
  const { controller, get, remote, status } = await fixture(t, [imported('target', 0)])
  await controller.addTrackPagesToPlaylistById('target', async (append) => {
    await append([track(1)])
  })
  remote((data) => {
    data.find((item) => item.id === 'target')!.imported!.generation = 'remote-refresh'
  })
  assert.equal(await controller.flushPlaylists(), false)
  const read = window.api.data.loadPlaylists
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  window.api.data.loadPlaylists = async () => {
    const result = await read()
    await gate
    return result
  }
  const restoring = controller.reloadPlaylistsDiscardingChanges()
  controller.renamePlaylist('target', 'Later rename')
  release()
  await assert.rejects(restoring, /读取期间歌单又有变化/)
  assert.equal(get('target').name, 'Later rename')
  assert.equal(get('target').imported!.entries.length, 1)
  assert.equal(status.value.dirty, true)
})

for (const remoteChange of ['refresh', 'delete', 'type'] as const) {
  test(`remote ${remoteChange} rejects a two-record move atomically, stops retries and supports explicit recovery`, async (t) => {
    const source: Playlist = {
      id: 'source',
      name: 'Source',
      trackIds: ['t7'],
      trackSnapshots: { t7: track(7) },
      createdAt: ''
    }
    const { controller, playlists, get, status, writes, remote, getAuthority } = await fixture(t, [
      source,
      imported('target', 0)
    ])
    await controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(['t7'])
    })
    remote((data) => {
      const target = data.find((playlist) => playlist.id === 'target')!
      if (remoteChange === 'refresh')
        target.imported = {
          ...imported('target', 1).imported!,
          generation: 'remote-refresh',
          refreshGeneration: 'remote-refresh'
        }
      if (remoteChange === 'delete') data.splice(data.indexOf(target), 1)
      if (remoteChange === 'type') delete target.imported
    })
    assert.equal(await controller.flushPlaylists(), false)
    assert.equal(status.value.canRetry, false)
    assert.equal(status.value.dirty, true)
    assert.deepEqual(getAuthority().find((playlist) => playlist.id === 'source')!.trackIds, ['t7'])
    assert.equal(writes.length, 0)
    assert.equal(await controller.flushPlaylists(), false)
    // A failed authority read cannot discard the user's optimistic intent.
    const read = window.api.data.loadPlaylists
    window.api.data.loadPlaylists = async () => {
      throw new Error('read failed')
    }
    await assert.rejects(controller.reloadPlaylistsDiscardingChanges(), /read failed/)
    assert.deepEqual(get('source').trackIds, [])
    for (const invalid of [null, [null], [{ id: 'bad' }]]) {
      window.api.data.loadPlaylists = (async () => invalid) as typeof read
      await assert.rejects(controller.reloadPlaylistsDiscardingChanges(), /未读取到有效歌单/)
      assert.deepEqual(get('source').trackIds, [])
      assert.equal(status.value.canRetry, false)
    }
    window.api.data.loadPlaylists = read
    await controller.reloadPlaylistsDiscardingChanges()
    assert.deepEqual(get('source').trackIds, ['t7'])
    assert.equal(status.value.dirty, false)
    assert.deepEqual(
      playlists.value,
      structuredClone(getAuthority()).map(slimPlaylistLegacySnapshots)
    )
    controller.renamePlaylist('source', 'Recovered')
    assert.equal(await controller.flushPlaylists(), true)
    assert.equal(writes.length, 1)
  })
}
