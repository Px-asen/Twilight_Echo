import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test, { type TestContext } from 'node:test'
import ts from 'typescript'
import { computed, nextTick, ref, reactive, watch } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import { createLibraryStorageState } from '../../stores/library/libraryStorageState.ts'
import { createLibraryAggregatePlaylist } from '../../stores/library/libraryAggregatePlaylist.ts'
import { createCoreLibraryApi } from '../../stores/library/coreLibraryApi.ts'
import { libraryTrack } from '../../../../core/playback/libraryTrack.ts'
import { coreLibraryPage } from '../../stores/coreTestFixtures.ts'
import { toSourceVariant } from '../../utils/logicalTrackModel.ts'
import {
  buildAggregateRows,
  collectAggregateSources,
  resolveAggregateQueue,
  toggleHiddenSource
} from '../../utils/aggregatePlaylistView.ts'
import type { Track } from '../../types/music.ts'
import type { Playlist } from '../../stores/library/musicStoreTypes.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick()
  assert.ok(check(), 'production aggregate setup did not settle')
}
function fixture(t: TestContext, mode: 'sqlite' | 'json' | 'unavailable' = 'sqlite') {
  const db = new LibraryDatabase(':memory:')
  const records = Array.from({ length: 405 }, (_, i) =>
    libraryTrack({
      id: `local${i}`,
      filePath: `D:/Music/${i}.flac`,
      title: `Song ${i}`,
      artist: 'Artist',
      album: 'Album',
      duration: 180,
      source: 'local'
    })
  )
  const remote = libraryTrack({
    id: 'ncm:7',
    filePath: '',
    title: 'Song 0',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    source: 'ncm'
  })
  db.replaceDocument({ version: 2, revision: 0, tracks: records, folders: [], exclusions: [] })
  const playlist: Playlist = {
    id: 'mix',
    name: 'Mix',
    kind: 'aggregate',
    createdAt: '',
    trackIds: ['missing', 'ncm:7', ...records.map((track) => track.id)],
    trackSnapshots: { 'ncm:7': remote }
  }
  const lists = ref<Playlist[]>([playlist]),
    playlistsRevision = ref(1),
    libraryRevision = ref(db.getMetadata().revision),
    props = reactive({ hasPlayer: false, active: true, initialPlaylistId: 'mix' })
  let legacyReads = 0,
    queryCalls = 0
  const queues: ReturnType<typeof db.createLibraryQueue>[] = [],
    arrayCalls: string[][] = [],
    removed: string[][] = []
  const mounts: Array<() => void> = [],
    unmounts: Array<() => void> = [],
    stops: Array<() => void> = []
  let change: ((value: { kind: string; revision: number }) => void) | undefined
  const source = readFileSync(
    new URL('./AggregatePlaylistPage.vue', import.meta.url),
    'utf8'
  ).match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('aggregate.ts', source, ts.ScriptTarget.Latest, true)
  const body = ast.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(ast))
    .join('\n')
  const patch = (id: string, value: Partial<Playlist>) => {
    lists.value = lists.value.map((item) => (item.id === id ? { ...item, ...value } : item))
    playlistsRevision.value++
    core.state.value = { ...core.state.value, playlistsRevision: playlistsRevision.value }
  }
  const viewIds = new Map<string, { id: string; playlist: Playlist }>()
  let nextView = 0
  const ensureView = async (playlist: Playlist, preserveSources: boolean) => {
    const key = `${playlist.id}:${preserveSources}`
    const existing = viewIds.get(key)
    if (existing) return existing.id
    const id = `core-view-${++nextView}`
    await db.syncPlaylistView({ kind: 'begin', id, versions: [], preserveSources })
    const entries = playlist.trackIds.map((trackId) => ({
      id: trackId,
      snapshot: playlist.trackSnapshots?.[trackId]
        ? { ...playlist.trackSnapshots[trackId] }
        : undefined
    }))
    for (let offset = 0; offset < entries.length; offset += 200)
      await db.syncPlaylistView({
        kind: 'append',
        id,
        sequence: offset / 200 + 1,
        entries: entries.slice(offset, offset + 200)
      })
    await db.syncPlaylistView({
      kind: 'commit',
      id,
      sequence: Math.ceil(entries.length / 200) + 1
    })
    viewIds.set(key, { id, playlist })
    return id
  }
  let catalogViewId: string | null = null
  const ensureCatalog = async () => {
    if (catalogViewId) return catalogViewId
    const id = `core-catalog-${++nextView}`
    await db.syncPlaylistView({
      kind: 'begin',
      id,
      versions: [],
      preserveSources: true,
      catalog: true
    })
    for (let offset = 0; offset < lists.value.length; offset += 200)
      await db.syncPlaylistView({
        kind: 'groups',
        id,
        sequence: offset / 200 + 1,
        groups: lists.value.slice(offset, offset + 200).map(({ id, name, cover, isDefault }) => ({
          id,
          name,
          cover,
          isDefault
        }))
      })
    const entries = lists.value.flatMap((playlist) =>
      playlist.trackIds.map((trackId) => ({
        id: trackId,
        collectionId: playlist.id,
        snapshot: playlist.trackSnapshots?.[trackId]
          ? { ...playlist.trackSnapshots[trackId] }
          : undefined
      }))
    )
    let sequence = Math.ceil(lists.value.length / 200) + 1
    for (let offset = 0; offset < entries.length; offset += 200)
      await db.syncPlaylistView({
        kind: 'append',
        id,
        sequence: sequence++,
        entries: entries.slice(offset, offset + 200)
      })
    await db.syncPlaylistView({ kind: 'commit', id, sequence })
    catalogViewId = id
    return id
  }
  const core = {
    state: ref({ playlistsRevision: playlistsRevision.value, versionsRevision: 1 }),
    query: async (name: string, payload: any) => {
      queryCalls++
      if (name === 'library.metadata') return db.getMetadata()
      if (name === 'playlists.collection')
        return db.queryCollections('playlists', {
          ...payload.query,
          playlistView: await ensureCatalog(),
          contentRevision: db.getMetadata().revision
        })
      if (name !== 'playlists.view') throw new Error(`unsupported Core query ${name}`)
      const playlist = lists.value.find((item) => item.id === payload.id)
      if (!playlist) throw new Error('playlist missing')
      const id = await ensureView(playlist, payload.preserveSources === true)
      const result = db.queryTracks({
        ...payload.query,
        playlistView: id,
        contentRevision: payload.query?.contentRevision ?? db.getMetadata().revision,
        aggregate:
          playlist.kind === 'aggregate'
            ? {
                hiddenSources: payload.includeHiddenSources ? [] : playlist.hiddenSources,
                variantPreferences: playlist.variantPreferences,
                ...(payload.variantRow !== undefined ? { variantRow: payload.variantRow } : {}),
                ...(payload.sourceCounts ? { sourceCounts: true } : {})
              }
            : undefined
      })
      return {
        viewId: id,
        revision: payload.revision,
        versionsRevision: payload.versionsRevision,
        page: {
          ...coreLibraryPage(result),
          definitionIds: result.tracks.map((track) => track.id)
        }
      }
    }
  }
  const coreLibrary = createCoreLibraryApi(core as never)
  const entry = runInNewContext(
    ts.transpileModule(
      body +
        '\n({ database, databasePage, databaseSources, databaseVariants, databaseCards, databaseEnabled, databasePending, databaseError, activePlaylist, gridPlaylists, displayTracks, sourceFilters, detailStatsText, rowFor, rowVariants, playRow, playAll, removeRow, chooseVariant, toggleVariantMenu, toggleSourceVisibility, actionError, openPlaylist, backToGrid, searchQuery, rowNumber, visibleRange, visibleTracks, tableTrackCount, totalHeight, retryDatabase})',
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
    ).outputText,
    {
      computed,
      nextTick,
      ref,
      Error,
      useLocatePlayingTrack() {},
      watch: (...args: Parameters<typeof watch>) => {
        const stop = watch(...args)
        stops.push(stop)
        return stop
      },
      onMounted: (callback: () => void) => mounts.push(callback),
      onUnmounted: (callback: () => void) => unmounts.push(callback),
      defineProps: () => props,
      withDefaults: (value: unknown) => value,
      useMusicStore: () => ({
        aggregatePlaylists: lists,
        playlistsRevision,
        libraryRevision,
        deletePlaylist: () => {},
        setPlaylistPinned: () => {},
        setPlaylistHiddenSources: (id: string, hiddenSources: string[]) =>
          patch(id, { hiddenSources }),
        setPlaylistVariantPreference: (id: string, anchor: string, source: string | null) => {
          const preferences = { ...lists.value.find((item) => item.id === id)!.variantPreferences }
          if (source) preferences[anchor] = source
          else delete preferences[anchor]
          patch(id, { variantPreferences: preferences })
        },
        getPlaylistTracksById: () => {
          legacyReads++
          assert.equal(mode, 'json', 'full playlist resolver in SQLite')
          return [remote, ...records]
        },
        removeTracksFromPlaylistById: (_id: string, ids: string[]) => {
          removed.push(ids)
        }
      }),
      usePlayerStore: () => ({
        currentTrack: ref(null),
        playTrack: (_track: Track, tracks: Track[]) => {
          arrayCalls.push(tracks.map((item) => item.id))
        },
        playLibraryQuery: async (
          query: Parameters<typeof db.createLibraryQueue>[0],
          selected?: string
        ) => {
          const result = db.queryTracks(query)
          const entry = query.playlistEntryId ? Number(query.playlistEntryId) : 0
          const selectedIndex = selected?.startsWith('local') ? Number(selected.slice(5)) : 0
          queues.push({
            total: result.total,
            index: Number.isFinite(selectedIndex)
              ? selectedIndex
              : Number.isFinite(entry) && entry > 0
                ? entry - 1
                : 0
          } as ReturnType<typeof db.createLibraryQueue>)
        }
      }),
      useSettingsStore: () => ({ settings: ref({ trackActivationMode: 'singleClick' }) }),
      useProviderStore: () => ({ providers: ref([]) }),
      useBackHandler: () => {},
      getMusicVersions: () => ({ tracks: { versions: [] } }),
      musicVersionRevision: ref(0),
      createLibraryStorageState,
      createLibraryAggregatePlaylist,
      useCoreLibraryApi: () => coreLibrary,
      toSourceVariant,
      buildAggregateRows,
      collectAggregateSources,
      resolveAggregateQueue,
      toggleHiddenSource,
      useSongListVirtualScroll: ({ displayTracks }: { displayTracks: unknown }) => ({
        containerRef: ref(null),
        tbodyRef: ref(null),
        rowHeight: ref(52),
        visibleRange: ref({ start: 0, end: 20 }),
        scrollTop: ref(0),
        viewportHeight: ref(720),
        updateViewportHeight() {},
        scrollToTrack() {},
        visibleTracks: displayTracks,
        totalHeight: ref(0),
        paddingTop: ref(0),
        onScroll: () => {}
      }),
      useSongListGridRendering: ({
        currentGridItems
      }: {
        currentGridItems: { value: unknown[] }
      }) => ({
        visibleGridSlots: computed(() =>
          currentGridItems.value.map((item, index) => ({ item, index }))
        ),
        gridDataRange: ref({ start: 0, end: 20 }),
        gridPaddingTop: ref(0),
        gridPaddingBottom: ref(0),
        gridRowStride: ref(260),
        gridRowGap: ref(16),
        showPlaylistCreateCard: ref(true)
      }),
      window: {
        addEventListener() {},
        removeEventListener() {},
        api: {
          library: {
            getStorageMode: async () => {
              if (mode === 'unavailable') throw new Error('database discovery unavailable')
              return mode
            },
            onChanged: (callback: typeof change) => {
              change = callback
              return () => {
                change = undefined
              }
            },
            database: {
              syncPlaylistView: async (request: Parameters<typeof db.syncPlaylistView>[0]) =>
                db.syncPlaylistView(request),
              queryTracks: async (query: Parameters<typeof db.queryTracks>[0]) => {
                queryCalls++
                return db.queryTracks(query)
              },
              queryCollections: async (
                kind: Parameters<typeof db.queryCollections>[0],
                query: Parameters<typeof db.queryCollections>[1]
              ) => db.queryCollections(kind, query),
              getMetadata: async () => db.getMetadata()
            }
          }
        }
      }
    }
  )
  for (const mount of mounts) mount()
  t.after(async () => {
    for (const stop of stops) stop()
    for (const unmount of unmounts) unmount()
    await tick()
    db.close()
  })
  return {
    entry,
    db,
    props,
    records,
    lists,
    queues,
    arrayCalls,
    removed,
    change: () => {
      libraryRevision.value = db.getMetadata().revision
      change?.({ kind: 'database', revision: db.getMetadata().revision })
    },
    get legacyReads() {
      return legacyReads
    },
    get queryCalls() {
      return queryCalls
    }
  }
}
const event = { stopPropagation() {} }

test('production aggregate events play a complete query from deep pages, preserve source choices and remove all variants', async (t) => {
  const f = fixture(t),
    { entry } = f
  await until(() => !!entry.databasePage.value.page && !!entry.databaseSources.value.page)
  assert.equal(f.legacyReads, 0)
  assert.equal(entry.displayTracks.value.length, 200)
  assert.equal(entry.detailStatsText.value, '405 首 · 已隐藏 1 首 · 2 个音源')
  const track = entry.displayTracks.value[0]
  entry.toggleVariantMenu(track, event)
  await until(() => !!entry.databaseVariants.value.page)
  assert.equal(entry.rowVariants(track).length, 2)
  entry.chooseVariant(track, 'ncm', event)
  await until(() => entry.displayTracks.value[0]?.id === 'ncm:7')
  assert.equal(entry.rowFor(entry.displayTracks.value[0]).variantPinned, true)
  await until(() => !entry.databasePending.value)
  entry.playRow(entry.displayTracks.value[0])
  assert.equal(f.queues.at(-1)!.total, 405)
  await entry.removeRow(entry.displayTracks.value[0], event)
  assert.deepEqual([...f.removed[0]].sort(), ['local0', 'ncm:7'])
  entry.visibleRange.value = { start: 397, end: 405 }
  await until(() => !entry.databasePending.value && entry.visibleTracks.value[7]?.id === 'local404')
  assert.equal(entry.rowNumber(0), 398)
  assert.equal(entry.rowNumber(7), 405)
  assert.ok(entry.database.rowFor(entry.visibleTracks.value[7]))
  entry.playRow(entry.visibleTracks.value[7])
  assert.equal(f.queues.at(-1)!.index, 404)
  assert.equal(entry.tableTrackCount.value, 405)
  entry.playAll()
  assert.equal(f.queues.at(-1)!.total, 405)
  assert.equal(f.arrayCalls.length, 0)
  await entry.toggleSourceVisibility('ncm')
  await until(() => !entry.databasePending.value && !entry.databaseSources.value.loading)
  assert.equal(
    entry.sourceFilters.value.find((item: { source: string }) => item.source === 'ncm').hidden,
    true
  )
  entry.toggleSourceVisibility('local')
  assert.match(entry.actionError.value, /至少要保留/)
  entry.backToGrid()
  await until(() => !!entry.databaseCards.value.page)
  assert.equal(entry.gridPlaylists.value[0].trackCount, 406)
})
test('a background aggregate instance releases reads and cannot play via the array path; scans refresh only active instances', async (t) => {
  const f = fixture(t),
    { entry } = f
  await until(() => !!entry.databasePage.value.page && !!entry.databaseSources.value.page)
  const previous = entry.displayTracks.value[0]
  f.props.active = false
  await until(() => entry.database.detailState.value.id === null)
  const before = f.queryCalls
  f.change()
  entry.playRow(previous)
  entry.playAll()
  await tick()
  assert.equal(f.queryCalls, before)
  assert.equal(f.arrayCalls.length, 0)
  assert.equal(f.queues.length, 0)
  f.props.active = true
  await until(() => !!entry.databasePage.value.page)
  const page = entry.databasePage.value.page
  f.db.patchTracks([
    { id: 'local0', expectedVersion: page.versions.local0, patch: { title: 'Changed' } }
  ])
  f.change()
  await until(() =>
    entry.databasePage.value.page?.tracks.some(
      (track: Track) => track.id === 'local0' && track.title === 'Changed'
    )
  )
})
