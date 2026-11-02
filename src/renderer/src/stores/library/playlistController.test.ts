import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ref, shallowRef } from 'vue'
import type { TrackData as Track } from '../../../../shared/track.ts'
import type {
  Playlist,
  PlaylistPersistenceNotice,
  PlaylistTrackIdPageProducer,
  PlaylistTrackPageProducer
} from './musicStoreTypes.ts'
import type { PlaylistPersistenceStatus } from '../playlistPersistence.ts'
import { emptyMusicVersions } from '../../../../shared/musicVersions.ts'
import { editMusicVersions } from '../../utils/musicVersions.ts'
import type { CoreSnapshot } from '../../../../shared/coreProtocol.ts'
import { createPlaylistController } from './playlistController.ts'
import { PersistentDataRevisionConflictError } from '../../../../shared/versionedPersistence.ts'
import {
  getMusicVersions,
  loadMusicVersions,
  previewMusicVersionEdit,
  saveMusicVersions
} from '../musicVersions.ts'
import { versionSourceKey } from '../../utils/trackSourceIdentity.ts'

function track(id: number): Track {
  return {
    id: String(id),
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    filePath: `D:/Music/${id}.flac`,
    fileName: `${id}.flac`,
    duration: 180,
    size: 1000,
    cover: null,
    lyrics: null,
    source: 'local'
  }
}

function fixture(
  inputTracks: Track[],
  resolveImportPaths?: Parameters<typeof createPlaylistController>[0]['resolveImportPaths'],
  getTracksRevision = () => 0
) {
  const playlists = shallowRef<Playlist[]>([])
  const controller = createPlaylistController({
    playlists,
    tracks: shallowRef(inputTracks),
    trackById: new Map(inputTracks.map((item) => [item.id, item])),
    getTracksRevision,
    playlistPersistenceStatus: ref<PlaylistPersistenceStatus>({
      state: 'idle',
      dirty: false,
      failureCount: 0,
      lastError: null
    }),
    playlistPersistenceNotice: ref<PlaylistPersistenceNotice | null>(null),
    resolveImportPaths
  })
  return { controller, playlists }
}

function readySnapshot(): CoreSnapshot {
  return {
    protocolVersion: 1,
    epoch: 'versions-test-epoch',
    sequence: 0,
    phase: 'ready',
    playback: null,
    track: null,
    queue: null,
    error: null,
    migrationRequired: false,
    loading: false,
    isStreamBuffering: false,
    presentationRevision: null,
    pluginsRevision: null,
    libraryRevision: null,
    abLoop: null,
    mute: null,
    modelPack: null,
    cloudTransfers: null,
    inbox: null,
    libraryLoudness: null,
    loudness: null,
    scan: null,
    statisticsRevision: null,
    playlistsRevision: null,
    versionsRevision: 0,
    audioRevision: null,
    settingsRevision: null,
    sleepTimer: null,
    bookmarksRevision: null,
    lyricsRevision: null,
    lyricsContentRevision: null,
    workspaceRevision: null,
    workspaceContentRevision: null,
    streams: null,
    cast: null,
    network: null,
    downloads: null,
    personalized: null,
    heart: null
  }
}

/**
 * A minimal in-memory Core bridge serving the versions protocol. The migrated
 * music-version store reads through the Core connection, so the local
 * controller tests back it with this deterministic fake instead of a bridge.
 */
function versionsCoreBridge() {
  let doc = emptyMusicVersions()
  let versionsRevision = 1
  const epoch = 'versions-test-epoch'
  const listeners = new Set<(event: { connectionId: string; message: unknown }) => void>()
  let connectionId: string | null = null
  const snapshot = () => ({
    ...readySnapshot(),
    sequence: versionsRevision,
    versionsRevision
  })
  const emitState = () => {
    for (const listener of listeners)
      listener({
        connectionId: connectionId ?? 'conn',
        message: { kind: 'state', epoch, sequence: versionsRevision, snapshot: snapshot() }
      })
  }
  const applyEdit = (edit: {
    scope: 'tracks' | 'albums'
    operation: 'split'
    keys: string[]
    label: string
  }) => {
    doc = editMusicVersions(doc, edit.scope, edit.operation, edit.keys, edit.label)
    versionsRevision += 1
    emitState()
  }
  return {
    connect: async () => {
      connectionId = 'conn'
      return { ok: true as const, value: { connectionId, snapshot: snapshot() } }
    },
    request: async (_id: string, request: { name: string; payload: Record<string, unknown> }) => {
      if (request.name === 'versions.edit') {
        applyEdit(request.payload as {
          scope: 'tracks' | 'albums'
          operation: 'split'
          keys: string[]
          label: string
        })
        return { ok: true as const, value: null }
      }
      if (request.name !== 'versions.page') throw new Error('unexpected core query ' + request.name)
      const scope = request.payload.scope as 'tracks' | 'albums'
      const kind = request.payload.kind as 'versions' | 'families'
      const list = doc[scope][kind]
      const offset = Number(request.payload.offset ?? 0)
      const limit = Number(request.payload.limit ?? 128)
      return {
        ok: true as const,
        value: { revision: versionsRevision, offset, total: list.length, items: list.slice(offset, offset + limit) }
      }
    },
    cancel: async () => ({ ok: true as const, value: undefined }),
    disconnect: async () => ({ ok: true as const, value: undefined }),
    onMessage: (listener: (event: { connectionId: string; message: unknown }) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onStatus: () => () => {},
    applyEdit
  }
}

let sharedVersionsBridge: ReturnType<typeof versionsCoreBridge> | null = null
function versionsCoreApi() {
  return (sharedVersionsBridge ??= versionsCoreBridge())
}

function mockWindow(t: TestContext, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
}

test('batch preserves matching, order, duplicates, empty results and existing playlist identity', async (t) => {
  const writes: Playlist[][] = []
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  mockWindow(t, {
    api: {
      data: {
        savePlaylists: async (snapshot: Playlist[]) => {
          writes.push(snapshot)
        }
      },
      core: versionsCoreApi()
    }
  } as unknown as Window & typeof globalThis)
  const { controller, playlists } = fixture([track(1), track(2)])
  playlists.value = [{ id: 'existing', name: 'Mix', trackIds: ['1'], createdAt: '2026-01-01' }]
  const results = controller.importPlaylistPathBatch([
    { name: ' Mix ', paths: [track(2).filePath, track(1).filePath, track(2).filePath] },
    { name: 'Missing', paths: ['D:/Music/missing.flac'] },
    { name: 'Relative', paths: ['1.flac'] }
  ])
  assert.equal(results[0].playlistId, 'existing')
  assert.equal(results[0].importedCount, 3)
  assert.equal(results[1].unresolvedEntries, 1)
  assert.deepEqual(
    playlists.value.map((p) => p.trackIds),
    [['1', '2'], [], ['1']]
  )
  assert.equal(await controller.flushPlaylists(), true)
  assert.equal(writes.length, 1)
  const document = controller.importPlaylistDocument(
    'Document',
    'mix.m3u8',
    '#EXTM3U\nD:/Music/2.flac\n1.flac'
  )
  assert.equal(document.importedCount, 2)
  assert.deepEqual(playlists.value.at(-1)?.trackIds, ['2', '1'])
  await controller.flushPlaylists()
})

test('async imports do not consult an incomplete renderer library and commit the whole batch once', async (t) => {
  const writes: Playlist[][] = []
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  mockWindow(t, {
    api: {
      data: {
        savePlaylists: async (snapshot: Playlist[]) => {
          writes.push(snapshot)
        }
      },
      core: versionsCoreApi()
    }
  })
  const { controller, playlists } = fixture([], async (paths) => {
    assert.deepEqual(paths, ['100.flac', 'missing.flac', '100.flac', 'D:/Music/200.flac'])
    return [track(100), null, track(100), track(200)]
  })
  const results = await controller.importPlaylistPathBatchAsync([
    { name: ' One ', paths: ['100.flac', 'missing.flac', '100.flac'] },
    { name: 'Two', paths: ['D:/Music/200.flac'] }
  ])
  assert.deepEqual(
    results.map(({ importedCount, unresolvedEntries }) => ({ importedCount, unresolvedEntries })),
    [
      { importedCount: 2, unresolvedEntries: 1 },
      { importedCount: 1, unresolvedEntries: 0 }
    ]
  )
  assert.deepEqual(
    playlists.value.map((p) => p.trackIds),
    [['100'], ['200']]
  )
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('async import errors and invalid names leave all playlists and persistence untouched', async (t) => {
  let reads = 0,
    writes = 0
  mockWindow(t, {
    api: {
      data: {
        savePlaylists: async () => {
          writes++
        }
      }
    }
  })
  const { controller, playlists } = fixture([track(1)], async () => {
    reads++
    throw new Error('database revision changed')
  })
  playlists.value = [{ id: 'existing', name: 'Mix', trackIds: ['1'], createdAt: '2026-01-01' }]
  const original = structuredClone(playlists.value)
  await assert.rejects(
    controller.importPlaylistPathBatchAsync([
      { name: 'Valid', paths: ['1.flac'] },
      { name: '', paths: ['1.flac'] }
    ]),
    /不能为空/
  )
  assert.equal(reads, 0)
  await assert.rejects(
    controller.importPlaylistDocumentAsync('Mix', 'mix.m3u8', '1.flac'),
    /revision changed/
  )
  assert.equal(reads, 1)
  assert.deepEqual(playlists.value, original)
  await controller.flushPlaylists()
  assert.equal(writes, 0)
})

for (const edit of ['rename', 'delete', 'add'] as const)
  test(`async import preserves current playlist identity and edits: ${edit}`, async (t) => {
    t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
    mockWindow(t, { api: { data: { savePlaylists: async () => {} } } })
    let release!: (tracks: Array<Track | null>) => void
    const pending = new Promise<Array<Track | null>>((resolve) => {
      release = resolve
    })
    const { controller, playlists } = fixture([], async () => pending)
    playlists.value = [{ id: 'existing', name: 'Mix', trackIds: ['1'], createdAt: '2026-01-01' }]
    const importing = controller.importPlaylistDocumentAsync(
      'Mix',
      'mix.pls',
      '[playlist]\nFile1=2.flac\nNumberOfEntries=1'
    )
    if (edit === 'rename') controller.renamePlaylist('existing', 'Renamed')
    else if (edit === 'delete') controller.deletePlaylist('existing')
    else controller.addTracksToPlaylist('Mix', [track(3)])
    release([track(2)])
    if (edit === 'add') {
      assert.equal((await importing).playlistId, 'existing')
      assert.deepEqual(playlists.value[0].trackIds, ['1', '3', '2'])
    } else {
      await assert.rejects(importing, /重命名或删除/)
      assert.equal(
        playlists.value.some((p) => p.name === 'Mix'),
        false
      )
    }
    await controller.flushPlaylists()
  })

test('explicit JSON mode retains synchronous path matching through the async entry point', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  mockWindow(t, { api: { data: { savePlaylists: async () => {} } } })
  const { controller, playlists } = fixture([track(1)], async () => null)
  const result = await controller.importPlaylistDocumentAsync(
    'JSON',
    'mix.m3u8',
    '1.flac\nmissing.flac'
  )
  assert.equal(result.importedCount, 1)
  assert.equal(result.unresolvedEntries, 1)
  assert.deepEqual(playlists.value[0].trackIds, ['1'])
  await controller.flushPlaylists()
})

test('validates the entire batch before changing any playlist', () => {
  const { controller, playlists } = fixture([track(1)])
  assert.throws(
    () =>
      controller.importPlaylistPathBatch([
        { name: 'Valid', paths: [track(1).filePath] },
        { name: 'x'.repeat(81), paths: [track(1).filePath] }
      ]),
    /80/
  )
  assert.deepEqual(playlists.value, [])
})

test('large batches build one library index and clone only the transaction endpoints', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  mockWindow(t, { api: { data: { savePlaylists: async () => {} } } })
  const clones = t.mock.method(globalThis, 'structuredClone')
  const library = Array.from({ length: 10_000 }, (_, i) => track(i))
  let pathReads = 0
  Object.defineProperty(library.at(-1)!, 'filePath', {
    get: () => {
      pathReads++
      return 'D:/Music/9999.flac'
    }
  })
  const { controller } = fixture(library)
  const paths = library.slice(0, 1000).map((item) => item.filePath)
  const start = performance.now()
  const results = controller.importPlaylistPathBatch(
    Array.from({ length: 100 }, (_, i) => ({
      name: `Playlist ${i}`,
      paths
    }))
  )
  t.diagnostic(
    `100 playlists × 1000 paths, 10000 library tracks: ${Math.round(performance.now() - start)} ms`
  )
  assert.equal(results.length, 100)
  assert.ok(results.every((result) => result.importedCount === 1000))
  assert.equal(pathReads, 1)
  assert.equal(clones.mock.callCount(), 0)
  await controller.flushPlaylists()
})

test('batched persistence replays its delta across a revision conflict', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const concurrent: Playlist = {
    id: 'other',
    name: 'Other window',
    trackIds: ['9'],
    createdAt: '2026-01-01'
  }
  let saved: Playlist[] = []
  let attempts = 0
  mockWindow(t, {
    api: {
      data: {
        savePlaylists: async (snapshot: Playlist[], revision: number) => {
          if (++attempts === 1) {
            throw new PersistentDataRevisionConflictError(
              {
                version: 2,
                revision: 1,
                savedAt: '',
                data: [concurrent]
              },
              revision
            )
          }
          assert.equal(revision, 1)
          saved = snapshot
          return { version: 2, revision: 2, savedAt: '', data: snapshot }
        }
      }
    }
  } as unknown as Window & typeof globalThis)
  const { controller } = fixture([track(1), track(2)])
  controller.importPlaylistPathBatch([
    { name: 'One', paths: [track(1).filePath] },
    { name: 'Two', paths: [track(2).filePath] }
  ])
  assert.equal(await controller.flushPlaylists(), true)
  assert.deepEqual(saved.map((p) => p.name).sort(), ['One', 'Other window', 'Two'])
})

async function streamingFixture(t: TestContext, getTracksRevision?: () => number) {
  t.mock.method(globalThis, 'setTimeout', (() => 0) as unknown as typeof setTimeout)
  const writes: Playlist[][] = []
  mockWindow(t, {
    api: {
      data: {
        savePlaylists: async (snapshot: Playlist[]) => {
          writes.push(snapshot)
        }
      },
      core: versionsCoreApi()
    }
  })
  // The versions store loads through the Core bridge asynchronously; settle
  // it before the test captures a revision guard.
  await loadMusicVersions()
  return { ...fixture([], undefined, getTracksRevision), writes }
}

test('streamed playlist stages compact pages and publishes/clones only the transaction endpoints', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  const clones = t.mock.method(globalThis, 'structuredClone')
  const pageSizes: number[] = []
  const id = await controller.createPlaylistWithTrackPages('Stream', async (append) => {
    for (let offset = 0; offset < 10_005; offset += 200) {
      const page = Array.from({ length: Math.min(200, 10_005 - offset) }, (_, i) => ({
        ...track(offset + i),
        lyrics: 'heavy lyrics',
        streamUrl: 'https://temporary.example/audio',
        cueRange: { startSeconds: i, endSeconds: i + 1, pregapSeconds: 0 },
        cueSheetPath: 'D:/Music/disc.cue'
      }))
      pageSizes.push(page.length)
      await append(page)
      assert.deepEqual(playlists.value, [], 'no empty or partial playlist becomes visible')
      assert.equal(clones.mock.callCount(), 0, 'no growing prefix reaches the persistence owner')
      // The final document must own compact copies, not references to source pages.
      page[0].title = 'mutated after append'
    }
  })
  assert.equal(pageSizes.length, 51)
  assert.equal(clones.mock.callCount(), 0)
  const playlist = playlists.value[0]
  assert.equal(playlist.id, id)
  assert.equal(playlist.trackIds.length, 10_005)
  assert.equal(playlist.trackSnapshots!['0'].title, 'Song 0')
  assert.equal(playlist.trackSnapshots!['0'].lyrics, null)
  assert.deepEqual(playlist.trackSnapshots!['200'].cueRange, {
    startSeconds: 0,
    endSeconds: 1,
    pregapSeconds: 0
  })
  assert.equal(playlist.trackSnapshots!['200'].cueSheetPath, 'D:/Music/disc.cue')
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0].trackIds.length, 10_005)
})

test('aggregate creation streams one compact document without an empty shell or name-space collision', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [{ id: 'ordinary', name: 'Mix', trackIds: [], createdAt: '' }]
  const clones = t.mock.method(globalThis, 'structuredClone')
  let pages = 0
  const id = await controller.createAggregatePlaylistWithTrackPages('  Mix  ', async (append) => {
    for (let offset = 0; offset < 10_005; offset += 200) {
      const page = Array.from({ length: Math.min(200, 10_005 - offset) }, (_, i) => ({
        ...track(offset + i),
        lyrics: 'heavy',
        cueRange: { startSeconds: 0, endSeconds: 1, pregapSeconds: 0 }
      }))
      await append(page)
      pages++
      page[0].title = 'changed after append'
      assert.equal(playlists.value.length, 1)
      assert.equal(clones.mock.callCount(), 0)
    }
  })
  const aggregate = playlists.value.find((playlist) => playlist.id === id)!
  assert.equal(pages, 51)
  assert.equal(clones.mock.callCount(), 0)
  assert.equal(aggregate.kind, 'aggregate')
  assert.equal(aggregate.trackIds.length, 10_005)
  assert.equal(aggregate.trackSnapshots!['0'].title, 'Song 0')
  assert.equal(aggregate.trackSnapshots!['0'].lyrics, null)
  assert.deepEqual(aggregate.trackSnapshots!['0'].cueRange, {
    startSeconds: 0,
    endSeconds: 1,
    pregapSeconds: 0
  })
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('aggregate streamed creation reuses its own existing ID and preserves live settings', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  playlists.value = [
    { id: 'aggregate', name: 'Mix', kind: 'aggregate', trackIds: ['1'], createdAt: '' }
  ]
  const id = await controller.createAggregatePlaylistWithTrackPages('Mix', async (append) => {
    await append([track(1), track(2)])
    controller.renamePlaylist('aggregate', 'Renamed')
    controller.setPlaylistPinned('aggregate', true)
    controller.setPlaylistHiddenSources('aggregate', ['demo'])
  })
  assert.equal(id, 'aggregate')
  assert.equal(playlists.value.length, 1)
  assert.deepEqual(playlists.value[0].trackIds, ['1', '2'])
  assert.equal(playlists.value[0].name, 'Renamed')
  assert.ok(playlists.value[0].pinnedAt)
  assert.deepEqual(playlists.value[0].hiddenSources, ['demo'])
  await controller.flushPlaylists()
})

for (const failure of ['read', 'abort', 'guard', 'swallowed', 'collision', 'metadata'] as const) {
  test(`aggregate creation ${failure} does not publish a staged prefix`, async (t) => {
    const { controller, playlists, writes } = await streamingFixture(t)
    const abort = new AbortController()
    await assert.rejects(
      controller.createAggregatePlaylistWithTrackPages(
        'Mix',
        async (append) => {
          await append([track(1)])
          if (failure === 'read') throw new Error('source failed')
          if (failure === 'abort') abort.abort()
          if (failure === 'guard')
            return () => {
              throw new Error('changed')
            }
          if (failure === 'swallowed') await append([null as unknown as Track]).catch(() => {})
          if (failure === 'metadata') await append([{ ...track(2), source: 'playlist-import' }])
          if (failure === 'collision')
            playlists.value = [
              { id: 'new', name: 'Mix', kind: 'aggregate', trackIds: [], createdAt: '' }
            ]
          return undefined
        },
        abort.signal
      )
    )
    assert.ok(playlists.value.every((playlist) => !playlist.trackIds.length))
    await controller.flushPlaylists()
    assert.equal(writes.length, 0)
  })
}

test('streaming append rebases once on live membership, order and presentation edits', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  playlists.value = [
    {
      id: 'existing',
      name: 'Mix',
      trackIds: ['1', '2', '6'],
      trackSnapshots: { '1': track(1), '2': track(2), '6': track(6) },
      createdAt: ''
    }
  ]
  const added = await controller.addTrackPagesToPlaylistById('existing', async (append) => {
    await append([track(1), track(3), track(3)])
    controller.removeTracksFromPlaylistById('existing', ['1'])
    controller.addTracksToPlaylistById('existing', [track(4)])
    controller.addTracksToPlaylistById('existing', [{ ...track(3), title: 'Concurrent snapshot' }])
    controller.reorderPlaylistTracks('Mix', ['6'], 0)
    controller.renamePlaylist('existing', 'Renamed')
    controller.setPlaylistCover('existing', 'cover://edited')
    await append([track(5)])
  })
  assert.equal(added, 1)
  assert.deepEqual(playlists.value[0].trackIds, ['6', '2', '4', '3', '5'])
  assert.equal(playlists.value[0].name, 'Renamed')
  assert.equal(playlists.value[0].cover, 'cover://edited')
  assert.equal(playlists.value[0].trackSnapshots!['1'], undefined)
  assert.equal(playlists.value[0].trackSnapshots!['3'].title, 'Concurrent snapshot')
  await controller.flushPlaylists()
})

for (const existing of [false, true]) {
  for (const failure of ['read', 'abort', 'guard', 'oversize', 'swallowed'] as const) {
    test(`streaming ${failure} leaves ${existing ? 'existing' : 'new'} playlist unpublished`, async (t) => {
      const { controller, playlists, writes } = await streamingFixture(t)
      if (existing)
        playlists.value = [{ id: 'existing', name: 'Mix', trackIds: ['1'], createdAt: '' }]
      const before = structuredClone(playlists.value)
      const cancellation = new AbortController()
      await assert.rejects(
        controller.createPlaylistWithTrackPages(
          'Mix',
          async (append) => {
            await append([track(2)])
            if (failure === 'read') throw new Error('source failed')
            if (failure === 'abort') cancellation.abort()
            if (failure === 'guard')
              return () => {
                throw new Error('late source changed')
              }
            if (failure === 'oversize')
              await append(Array.from({ length: 201 }, (_, i) => track(i)))
            if (failure === 'swallowed') await append([null as unknown as Track]).catch(() => {})
            return undefined
          },
          cancellation.signal
        )
      )
      assert.deepEqual(playlists.value, before)
      await controller.flushPlaylists()
      assert.equal(writes.length, 0)
    })
  }
}

test('pre-abort skips source and late appends cannot alter a completed document', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  const cancellation = new AbortController()
  cancellation.abort()
  await assert.rejects(
    controller.createPlaylistWithTrackPages(
      'Mix',
      async () => {
        assert.fail('aborted source must not run')
      },
      cancellation.signal
    ),
    /取消/
  )
  let late!: (page: readonly Track[]) => Promise<void>
  await controller.createPlaylistWithTrackPages('Mix', async (append) => {
    late = append
    await append([track(1)])
  })
  await assert.rejects(late([track(2)]), /关闭/)
  assert.deepEqual(playlists.value[0].trackIds, ['1'])
  await controller.flushPlaylists()
})

for (const change of ['delete', 'kind', 'imported', 'collision'] as const) {
  test(`streaming target fence rejects ${change} without retargeting`, async (t) => {
    const { controller, playlists } = await streamingFixture(t)
    if (change !== 'collision')
      playlists.value = [{ id: 'existing', name: 'Mix', trackIds: ['1'], createdAt: '' }]
    await assert.rejects(
      controller.createPlaylistWithTrackPages('Mix', async (append) => {
        await append([track(2)])
        if (change === 'delete')
          playlists.value = [{ id: 'replacement', name: 'Mix', trackIds: ['9'], createdAt: '' }]
        if (change === 'kind') playlists.value[0].kind = 'aggregate'
        if (change === 'imported') playlists.value[0].imported = {} as Playlist['imported']
        if (change === 'collision')
          playlists.value = [{ id: 'other', name: 'Mix', trackIds: ['9'], createdAt: '' }]
      }),
      /删除|类型|同名/
    )
    assert.ok(playlists.value.every((p) => !p.trackIds.includes('2')))
  })
}

test('aggregate streaming preserves settings and imported streams create independent occurrences', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [
    {
      id: 'aggregate',
      name: 'Mix',
      kind: 'aggregate',
      trackIds: [],
      hiddenSources: ['demo'],
      createdAt: ''
    }
  ]
  assert.equal(
    await controller.addTrackPagesToPlaylistById('aggregate', async (append) => {
      await append([track(1), { ...track(2), id: 'demo:remote', source: 'demo' }])
    }),
    2
  )
  assert.equal(playlists.value[0].kind, 'aggregate')
  assert.deepEqual(playlists.value[0].hiddenSources, ['demo'])
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
  const importedId = controller.createExternalPlaylist({
    name: 'Imported',
    songs: [],
    source: { kind: 'file', label: 'mix.csv' },
    complete: true,
    warnings: []
  })
  assert.equal(
    await controller.addTrackPagesToPlaylistById(importedId, async (append) => {
      await append([track(1), track(1)])
    }),
    2
  )
  const imported = playlists.value.find((playlist) => playlist.id === importedId)!
  assert.deepEqual(imported.trackIds, [])
  assert.equal(new Set(imported.imported!.entries.map((entry) => entry.entryId)).size, 2)
  await controller.flushPlaylists()
})

test('streamed commit uses the existing authoritative CAS merge', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  const original: Playlist = {
    id: 'existing',
    name: 'Mix',
    isDefault: true,
    trackIds: ['1'],
    createdAt: ''
  }
  let attempts = 0
  let saved: Playlist[] = []
  window.api.data.loadPlaylists = async () => ({
    version: 2,
    revision: 1,
    savedAt: '',
    data: [original]
  })
  window.api.data.savePlaylists = async (snapshot, revision) => {
    if (++attempts === 1)
      throw new PersistentDataRevisionConflictError(
        {
          version: 2,
          revision: 2,
          savedAt: '',
          data: [{ ...original, name: 'Remote', trackIds: ['9'] }]
        },
        revision
      )
    assert.equal(revision, 2)
    saved = snapshot as Playlist[]
    return { version: 2, revision: 3, savedAt: '', data: snapshot }
  }
  await controller.loadPlaylists()
  await controller.addTrackPagesToPlaylistById('existing', async (append) => {
    await append([track(1), track(2)])
    await append([track(3)])
  })
  assert.equal(await controller.flushPlaylists(), true)
  assert.equal(attempts, 2)
  assert.deepEqual(saved[0].trackIds, ['9', '2', '3'])
  assert.equal(saved[0].name, 'Remote')
  assert.deepEqual(playlists.value[0].trackIds, saved[0].trackIds)
})

function playlistRecord(id: string, ids: number[], extra: Partial<Playlist> = {}): Playlist {
  return {
    id,
    name: id,
    trackIds: ids.map(String),
    trackSnapshots: Object.fromEntries(ids.map((id) => [String(id), track(id)])),
    createdAt: '',
    ...extra
  }
}

test('favorite pages stage 10005 compact tracks with no shell, growing clones or early persistence', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  const clones = t.mock.method(globalThis, 'structuredClone')
  let pages = 0
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      for (let offset = 0; offset < 10_005; offset += 200) {
        const page = Array.from({ length: Math.min(200, 10_005 - offset) }, (_, i) => ({
          ...track(offset + i),
          lyrics: 'heavy lyrics',
          cueRange: { startSeconds: i, endSeconds: i + 1, pregapSeconds: 0 }
        }))
        await append(page)
        pages++
        page[0].title = 'mutated after append'
        assert.equal(playlists.value.length, 0)
        assert.equal(clones.mock.callCount(), 0)
        assert.equal(writes.length, 0)
      }
    }, true),
    10_005
  )
  assert.equal(pages, 51)
  assert.equal(clones.mock.callCount(), 0)
  assert.equal(playlists.value[0].isDefault, true)
  assert.equal(playlists.value[0].trackIds.length, 10_005)
  assert.equal(playlists.value[0].trackSnapshots!['0'].title, 'Song 0')
  assert.equal(playlists.value[0].trackSnapshots!['0'].lyrics, null)
  assert.deepEqual(playlists.value[0].trackSnapshots!['200'].cueRange, {
    startSeconds: 0,
    endSeconds: 1,
    pregapSeconds: 0
  })
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('favorite page add/query/remove preserve the synchronous recording, remote-ID and CUE/SACD rules', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  const legacy = fixture([])
  const local = track(1)
  const remote = { ...local, id: 'ncm:10', filePath: 'ncm:10', source: 'ncm' }
  const namesake = { ...remote, id: 'ncm:11', filePath: 'ncm:11' }
  const cue: Track = {
    ...track(2),
    cueRange: { startSeconds: 60, endSeconds: 120, pregapSeconds: 0 },
    cueSheetPath: 'D:/disc.cue',
    cueEncoding: 'utf-8'
  }
  const sacd = { ...track(3), subTrack: '2' }
  const pages = [[remote], [local, namesake], [cue, sacd, remote]]
  const expected = legacy.controller.setFavoriteTracks(pages.flat(), true)
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      for (const page of pages) await append(page)
    }, true),
    expected
  )
  assert.deepEqual(playlists.value[0].trackIds, legacy.playlists.value[0].trackIds)
  assert.deepEqual(playlists.value[0].trackSnapshots, legacy.playlists.value[0].trackSnapshots)
  assert.deepEqual(
    await controller.readFavoriteTrackPages(async (append) => {
      await append([local, remote, namesake])
      await append([cue, sacd, track(4), remote])
    }),
    { count: 7, favoriteCount: 6 }
  )
  const removed = legacy.controller.setFavoriteTracks([remote], false)
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      await append([remote])
    }, false),
    removed
  )
  assert.deepEqual(playlists.value[0].trackIds, legacy.playlists.value[0].trackIds)
  assert.ok(playlists.value[0].trackIds.includes(namesake.id))
  await controller.flushPlaylists()
  await legacy.controller.flushPlaylists()
})

test('favorite append preserves concurrent removals and snapshots, and rechecks new recording duplicates once at commit', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  playlists.value = [playlistRecord('favorite', [1], { isDefault: true })]
  const alias = { ...track(3), id: 'ncm:300', filePath: 'ncm:300', source: 'ncm' }
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      await append([track(1), track(2), track(3)])
      controller.removeTracksFromPlaylistById('favorite', ['1'])
      controller.addTracksToPlaylistById('favorite', [
        { ...track(2), title: 'Concurrent snapshot' },
        alias,
        track(4)
      ])
      controller.reorderPlaylistTracks('favorite', ['4'], 0)
      controller.renamePlaylist('favorite', 'Renamed favorite')
      controller.setPlaylistCover('favorite', 'cover://edited')
      await append([track(5)])
    }, true),
    1
  )
  assert.deepEqual(playlists.value[0].trackIds, ['4', '2', alias.id, '5'])
  assert.equal(playlists.value[0].trackSnapshots!['2'].title, 'Concurrent snapshot')
  assert.equal(playlists.value[0].name, 'Renamed favorite')
  assert.equal(playlists.value[0].cover, 'cover://edited')
  await controller.flushPlaylists()
})

test('unfavorite removes every captured compatible membership but preserves new and same-titled neighbours', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  const local = track(1)
  const remote = { ...local, id: 'ncm:10', filePath: 'ncm:10', source: 'ncm' }
  const namesake = { ...remote, id: 'ncm:11', filePath: 'ncm:11' }
  playlists.value = [playlistRecord('favorite', [1, 2], { isDefault: true })]
  controller.addTracksToPlaylistById('favorite', [remote, namesake])
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      await append([remote, remote])
      controller.addTracksToPlaylistById('favorite', [track(3)])
      controller.reorderPlaylistTracks('favorite', ['3'], 0)
      await append([track(2)])
    }, false),
    3
  )
  assert.deepEqual(playlists.value[0].trackIds, ['3', namesake.id])
  assert.deepEqual(Object.keys(playlists.value[0].trackSnapshots!), ['3', namesake.id])
  await controller.flushPlaylists()
})

test('favorite state reads every page instead of inferring full selection from its loaded prefix', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [
    playlistRecord(
      'favorite',
      Array.from({ length: 200 }, (_, i) => i),
      { isDefault: true }
    )
  ]
  let pages = 0
  const summary = await controller.readFavoriteTrackPages(async (append) => {
    for (let offset = 0; offset < 605; offset += 200) {
      await append(Array.from({ length: Math.min(200, 605 - offset) }, (_, i) => track(offset + i)))
      pages++
    }
    controller.renamePlaylist('favorite', 'Renamed')
    controller.reorderPlaylistTracks('Renamed', ['199'], 0)
  })
  assert.deepEqual(summary, { count: 605, favoriteCount: 200 })
  assert.equal(pages, 4)
  await controller.flushPlaylists()
  assert.equal(writes.length, 1, 'only the concurrent rename writes')
  await assert.rejects(
    controller.readFavoriteTrackPages(async (append) => {
      await append([track(600)])
      controller.addFavoriteTrack(track(600))
    }),
    /收藏状态已变化/
  )
  await controller.flushPlaylists()
})

test('manual recording splits are honored and a late version/library change rejects favorite publication', async (t) => {
  let raw: string | null = null
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        raw = value
      }
    }
  })
  t.after(() => {
    raw = null
    loadMusicVersions()
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  loadMusicVersions()
  let revision = 0
  const { controller, playlists } = await streamingFixture(t, () => revision)
  const local = track(1),
    remote = { ...local, id: 'ncm:10', source: 'ncm', filePath: 'ncm:10' }
  playlists.value = [playlistRecord('favorite', [1], { isDefault: true })]
  const before = getMusicVersions()
  const { after } = previewMusicVersionEdit('tracks', 'split', [versionSourceKey(remote)], 'Live')
  await saveMusicVersions(after, before)
  // Settle the client projection so the recording index sees the split.
  await loadMusicVersions()
  assert.deepEqual(
    await controller.readFavoriteTrackPages(async (append) => {
      await append([remote])
    }),
    { count: 1, favoriteCount: 0 }
  )
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      await append([remote])
    }, true),
    1
  )
  for (const change of ['library', 'version']) {
    await assert.rejects(
      controller.setFavoriteTrackPages(async (append) => {
        await append([track(2)])
        // The capture happened before produce ran; a change landing now is a
        // late conflict and must invalidate the in-flight publication.
        if (change === 'library') {
          revision++
          return
        }
        const current = getMusicVersions()
        const { after } = previewMusicVersionEdit(
          'tracks',
          'split',
          [versionSourceKey(local)],
          'Studio'
        )
        await saveMusicVersions(after, current)
        await loadMusicVersions()
      }, true),
      /曲库或录音版本已变化/
    )
    assert.deepEqual(playlists.value[0].trackIds, ['1', remote.id])
  }
  await controller.flushPlaylists()
})

test('ID-page removal preserves latest unselected order, metadata and additions with one endpoint save', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [playlistRecord('source', [1, 2, 3, 4])]
  assert.equal(
    await controller.removeTrackIdPagesFromPlaylistById('source', async (append) => {
      await append(['1', '3', '3', 'unknown'])
      assert.deepEqual(playlists.value[0].trackIds, ['1', '2', '3', '4'])
      controller.addTracksToPlaylistById('source', [track(5)])
      controller.reorderPlaylistTracks('source', ['4'], 0)
      controller.renamePlaylist('source', 'Renamed')
      controller.setPlaylistCover('source', 'cover://edited')
      await append(['playback-id-not-definition-id'])
    }),
    2
  )
  assert.deepEqual(playlists.value[0].trackIds, ['4', '2', '5'])
  assert.deepEqual(Object.keys(playlists.value[0].trackSnapshots!), ['2', '4', '5'])
  assert.equal(playlists.value[0].name, 'Renamed')
  assert.equal(playlists.value[0].cover, 'cover://edited')
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('ID-page move publishes both records together using current source order/snapshots without resurrecting removed members', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [
    playlistRecord('source', [1, 2, 3, 4]),
    playlistRecord('target', [3, 9], { kind: 'aggregate', hiddenSources: ['demo'] })
  ]
  assert.deepEqual(
    await controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(['4', '1', '3'])
      assert.deepEqual(
        playlists.value.map((p) => p.trackIds),
        [
          ['1', '2', '3', '4'],
          ['3', '9']
        ]
      )
      controller.removeTracksFromPlaylistById('source', ['4'])
      controller.addTracksToPlaylistById('source', [track(5)])
      controller.addTracksToPlaylistById('target', [track(6)])
      controller.reorderPlaylistTracks('source', ['3'], 0)
      playlists.value[0].trackSnapshots!['1'] = {
        ...track(1),
        title: 'Edited snapshot',
        cueRange: { startSeconds: 10, endSeconds: 40, pregapSeconds: 0 }
      }
      controller.renamePlaylist('source', 'Renamed')
      await append(['1', 'missing', '5'])
    }),
    { moved: 1, sourceRemoved: 2 }
  )
  assert.deepEqual(
    playlists.value.map((p) => p.trackIds),
    [
      ['2', '5'],
      ['3', '9', '6', '1']
    ]
  )
  assert.equal(playlists.value[1].trackSnapshots!['1'].title, 'Edited snapshot')
  assert.deepEqual(playlists.value[1].trackSnapshots!['1'].cueRange, {
    startSeconds: 10,
    endSeconds: 40,
    pregapSeconds: 0
  })
  assert.deepEqual(playlists.value[1].hiddenSources, ['demo'])
  assert.equal(playlists.value[0].name, 'Renamed')
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
  assert.deepEqual(
    writes[0].map((p) => p.trackIds),
    [
      ['2', '5'],
      ['3', '9', '6', '1']
    ]
  )
})

test('ID-page reorder matches legacy boundaries while keeping a stable drop anchor under concurrent edits', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  const legacy = fixture([])
  for (const targetIndex of [-10, 0, 2, 4, 8, 99]) {
    playlists.value = [playlistRecord('source', [1, 2, 3, 4, 5, 6])]
    legacy.playlists.value = structuredClone(playlists.value)
    const expected = legacy.controller.reorderPlaylistTracks('source', ['4', '2', '2'], targetIndex)
    assert.equal(
      await controller.reorderPlaylistTrackIdPagesById(
        'source',
        async (append) => {
          await append(['4', '2', '2'])
        },
        targetIndex
      ),
      expected
    )
    assert.deepEqual(playlists.value[0].trackIds, legacy.playlists.value[0].trackIds)
    await controller.flushPlaylists()
    await legacy.controller.flushPlaylists()
  }
  playlists.value = [playlistRecord('source', [1, 2, 3, 4, 5, 6])]
  assert.equal(
    await controller.reorderPlaylistTrackIdPagesById(
      'source',
      async (append) => {
        await append(['4', '3'])
        controller.reorderPlaylistTracks('source', ['6'], 0)
        controller.addTracksToPlaylistById('source', [track(7)])
        controller.reorderPlaylistTracks('source', ['7'], 0)
        controller.removeTracksFromPlaylistById('source', ['5'])
      },
      4
    ),
    true
  )
  assert.deepEqual(playlists.value[0].trackIds, ['7', '3', '4', '6', '1', '2'])
  await controller.flushPlaylists()
})

for (const action of ['remove', 'move', 'reorder'] as const) {
  for (const failure of ['read', 'abort', 'guard', 'swallowed', 'oversize'] as const) {
    test(`ID-page ${action} ${failure} leaves both playlists and persistence untouched`, async (t) => {
      const { controller, playlists, writes } = await streamingFixture(t)
      playlists.value = [playlistRecord('source', [1, 2, 3]), playlistRecord('target', [4])]
      const before = structuredClone(playlists.value),
        abort = new AbortController()
      const produce: PlaylistTrackIdPageProducer = async (append) => {
        await append(['1', '2'])
        if (failure === 'read') throw new Error('source failed')
        if (failure === 'abort') abort.abort()
        if (failure === 'guard')
          return () => {
            throw new Error('source changed')
          }
        if (failure === 'swallowed') await append([null as unknown as string]).catch(() => {})
        if (failure === 'oversize') await append(Array.from({ length: 201 }, () => '1'))
        return undefined
      }
      await assert.rejects(
        action === 'remove'
          ? controller.removeTrackIdPagesFromPlaylistById('source', produce, abort.signal)
          : action === 'move'
            ? controller.movePlaylistTrackIdPagesById('source', 'target', produce, abort.signal)
            : controller.reorderPlaylistTrackIdPagesById('source', produce, 3, abort.signal)
      )
      assert.deepEqual(playlists.value, before)
      await controller.flushPlaylists()
      assert.equal(writes.length, 0)
    })
  }
}

for (const favorite of [false, true]) {
  for (const failure of ['read', 'abort', 'guard', 'swallowed'] as const) {
    test(`favorite ${favorite} ${failure} never publishes staged pages`, async (t) => {
      const { controller, playlists, writes } = await streamingFixture(t)
      playlists.value = [playlistRecord('favorite', [1], { isDefault: true })]
      const before = structuredClone(playlists.value),
        abort = new AbortController()
      const produce: PlaylistTrackPageProducer = async (append) => {
        await append([track(1), track(2)])
        if (failure === 'read') throw new Error('source failed')
        if (failure === 'abort') abort.abort()
        if (failure === 'guard')
          return () => {
            throw new Error('source changed')
          }
        await append([null as unknown as Track]).catch(() => {})
        return undefined
      }
      await assert.rejects(controller.setFavoriteTrackPages(produce, favorite, abort.signal))
      assert.deepEqual(playlists.value, before)
      await controller.flushPlaylists()
      assert.equal(writes.length, 0)
    })
  }
}

test('late ID appends and pre-aborted sources cannot change a committed playlist', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [playlistRecord('source', [1, 2, 3])]
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    controller.removeTrackIdPagesFromPlaylistById(
      'source',
      async () => {
        assert.fail('pre-aborted source ran')
      },
      abort.signal
    ),
    /取消/
  )
  let late!: (page: readonly string[]) => Promise<void>
  assert.equal(
    await controller.removeTrackIdPagesFromPlaylistById('source', async (append) => {
      late = append
      await append(['1'])
    }),
    1
  )
  await assert.rejects(late(['2']), /关闭/)
  assert.deepEqual(playlists.value[0].trackIds, ['2', '3'])
  await controller.flushPlaylists()
  assert.equal(writes.length, 1)
})

test('streaming membership targets are ID-bound and type-fenced without retargeting', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  playlists.value = [playlistRecord('source', [1, 2]), playlistRecord('target', [])]
  await assert.rejects(
    controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(['1'])
      playlists.value[1] = playlistRecord('replacement', [], { name: 'target' })
    }),
    /删除或类型/
  )
  assert.deepEqual(playlists.value[0].trackIds, ['1', '2'])
  await assert.rejects(
    controller.removeTrackIdPagesFromPlaylistById('source', async (append) => {
      await append(['1'])
      playlists.value[0].kind = 'aggregate'
    }),
    /删除或类型/
  )
  await controller.flushPlaylists()
  assert.equal(writes.length, 0)
})

test('two-playlist streamed move uses the existing CAS owner and merges remote order/settings/additions', async (t) => {
  const { controller, playlists } = await streamingFixture(t)
  const base = [
    playlistRecord('source', [1, 2, 3], { isDefault: true }),
    playlistRecord('target', [4])
  ]
  window.api.data.loadPlaylists = async () => ({ version: 2, revision: 1, savedAt: '', data: base })
  let attempts = 0,
    saved: Playlist[] = []
  window.api.data.savePlaylists = async (data, revision) => {
    if (++attempts === 1)
      throw new PersistentDataRevisionConflictError(
        {
          version: 2,
          revision: 2,
          savedAt: '',
          data: [
            playlistRecord('source', [2, 3, 1, 9], { isDefault: true, name: 'Remote source' }),
            playlistRecord('target', [4, 5], { cover: 'cover://remote' })
          ]
        },
        revision
      )
    assert.equal(revision, 2)
    saved = data as Playlist[]
    return { version: 2, revision: 3, savedAt: '', data }
  }
  await controller.loadPlaylists()
  assert.deepEqual(
    await controller.movePlaylistTrackIdPagesById('source', 'target', async (append) => {
      await append(['3', '1'])
    }),
    { moved: 2, sourceRemoved: 2 }
  )
  assert.equal(await controller.flushPlaylists(), true)
  assert.equal(attempts, 2)
  assert.deepEqual(
    saved.map((playlist) => playlist.trackIds),
    [
      ['2', '9'],
      ['4', '5', '1', '3']
    ]
  )
  assert.equal(saved[0].name, 'Remote source')
  assert.equal(saved[1].cover, 'cover://remote')
  assert.deepEqual(playlists.value, saved)
})

test('empty/no-op favorite and ID streams publish nothing; favorite target replacement never retargets by name', async (t) => {
  const { controller, playlists, writes } = await streamingFixture(t)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    controller.setFavoriteTrackPages(
      async () => {
        assert.fail('pre-aborted favorite source ran')
      },
      true,
      abort.signal
    ),
    /取消/
  )
  assert.equal(await controller.setFavoriteTrackPages(async () => {}, true), 0)
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      await append([track(1)])
    }, false),
    0
  )
  assert.deepEqual(
    await controller.readFavoriteTrackPages(async (append) => {
      await append([track(1)])
    }),
    { count: 1, favoriteCount: 0 }
  )
  assert.deepEqual(playlists.value, [])
  playlists.value = [playlistRecord('favorite', [1], { isDefault: true })]
  assert.equal(
    await controller.setFavoriteTrackPages(async (append) => {
      await append([track(1)])
    }, true),
    0
  )
  assert.equal(
    await controller.removeTrackIdPagesFromPlaylistById('favorite', async (append) => {
      await append(['missing'])
    }),
    0
  )
  await assert.rejects(
    controller.setFavoriteTrackPages(async (append) => {
      await append([track(2)])
      playlists.value = [playlistRecord('replacement', [3], { name: 'favorite', isDefault: true })]
    }, true),
    /收藏歌单已删除或类型/
  )
  assert.deepEqual(playlists.value[0].trackIds, ['3'])
  await controller.flushPlaylists()
  assert.equal(writes.length, 0)
})
