import { computed, shallowReadonly, shallowRef, triggerRef, watch } from 'vue'
import type { useCoreConnection } from '../coreConnection.ts'
import type {
  CorePlaylistDescriptor,
  CorePlaylistEdit,
  CorePlaylistPageEdit,
  CorePlaylistSubmitItem,
  CorePlaylistSubmitReply,
  CorePlaylistState
} from '../../../../shared/corePlaylists.ts'
import type {
  PlaylistPageProducer,
  PlaylistBatchMoveResult,
  PlaylistImportApplyResult
} from '../../../../shared/playlists.ts'
import type { LibraryMetadata, LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type {
  LocalLibraryScanStatus,
  LocalLibraryScanProgress
} from '../../../../shared/localLibraryScan.ts'
import type { LibrarySelectionSnapshot } from '../../../../shared/librarySelection.ts'
import type {
  CoreLibraryRemovalResult,
  CoreTagPatch
} from '../../../../shared/coreLibraryMaintenance.ts'
import type { PlaylistFileFormat } from '../../../../shared/playlistLifecycle.ts'
import type { Track } from '../../types/music.ts'
import { coreQueueTrackInput } from '../player/corePlayerQueue.ts'
type Client = ReturnType<typeof useCoreConnection>
export type DisplayTrackProducer = PlaylistPageProducer<Track>
export type DisplayMemberProducer = PlaylistPageProducer<{ id: string; track?: Track }>

/** Catalog descriptors and bounded display data; all repositories belong to Core. */
export function createCoreMusicStore(core: Client) {
  const metadata = shallowRef<LibraryMetadata | null>(null),
    catalog = shallowRef<CorePlaylistDescriptor[]>([]),
    state = shallowRef<CorePlaylistState | null>(null),
    failure = shallowRef(''),
    favorites = shallowRef(new Map<string, boolean>())
  let generation = 0
  let catalogEpoch: string | null = null
  const revision = () => {
    const r = core.state.value?.playlistsRevision
    if (r == null) throw new Error('Core 歌单尚未就绪')
    return r
  }
  const trackInput = (track: Track) =>
    coreQueueTrackInput(
      track,
      core.state.value?.network?.revision ?? null,
      core.state.value?.queue ?? undefined
    )
  async function refresh() {
    const current = ++generation
    if (!core.state.value) await core.attach()
    const snapshot = core.state.value
    if (snapshot?.phase !== 'ready') throw new Error('Core 正在初始化，请稍候')
    // A playlist commit can land between state and catalog reads, before its
    // notification reaches this renderer. Restart the read once with fresh state.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [nextMetadata, nextState] = await Promise.all([
          core.query('library.metadata', {}),
          core.query('playlists.state', {})
        ])
        // Track metadata commits do not change playlist membership. Reusing the
        // catalog also keeps consumers from rebuilding unchanged playlist views.
        const catalogChanged =
          catalogEpoch !== snapshot.epoch || state.value?.revision !== nextState.revision
        const items: CorePlaylistDescriptor[] = []
        let offset = 0,
          total = 1
        if (catalogChanged)
          do {
            const page = await core.query('playlists.catalog', {
              revision: nextState.revision,
              offset,
              limit: 200
            })
            items.push(...page.items)
            total = page.total
            offset += page.items.length
            if (!page.items.length && offset < total) throw new Error('歌单目录读取中断')
          } while (offset < total)
        if (current !== generation || core.state.value?.epoch !== snapshot.epoch) return
        metadata.value = Object.freeze(nextMetadata)
        if (catalogChanged) {
          catalog.value = items.map((item) => Object.freeze(item))
          catalogEpoch = snapshot.epoch
        }
        state.value = Object.freeze(nextState)
        failure.value = ''
        return
      } catch (error) {
        // A newer revision already owns the refresh. Its obsolete read failure
        // must not turn a healthy page into a compatibility warning.
        if (current !== generation || core.state.value?.epoch !== snapshot.epoch) return
        if (attempt === 0 && (error as { code?: string } | null)?.code === 'STALE_REVISION')
          continue
        throw error
      }
    }
  }
  const stop = watch(
    () => {
      const s = core.state.value
      return s?.phase === 'ready' ? `${s.epoch}:${s.libraryRevision}:${s.playlistsRevision}` : ''
    },
    (key, previous) => {
      const current = core.state.value
      if (
        !previous ||
        catalogEpoch !== current?.epoch ||
        state.value?.revision !== current?.playlistsRevision
      )
        favorites.value = new Map()
      if (key)
        void refresh().catch((e) => {
          failure.value = e instanceof Error ? e.message : String(e)
        })
    },
    { immediate: true }
  )
  async function edit<T>(edit: CorePlaylistEdit): Promise<T> {
    const result = (await core.command('playlists.edit', { revision: revision(), edit })) as {
      result: T
    }
    await refresh()
    return result.result
  }
  async function submit<T>(
    edit: CorePlaylistPageEdit,
    produce: PlaylistPageProducer<CorePlaylistSubmitItem>,
    signal?: AbortSignal
  ): Promise<T> {
    const stage = (await core.command(
      'playlists.submit',
      { kind: 'begin', revision: revision(), edit },
      signal
    )) as CorePlaylistSubmitReply
    let sequence = stage.sequence,
      committing = false
    try {
      const guard = await produce(async (items) => {
        for (let offset = 0; offset < items.length; offset += 200)
          await core.command(
            'playlists.submit',
            {
              kind: 'append',
              id: stage.id,
              sequence: ++sequence,
              items: items.slice(offset, offset + 200)
            },
            signal
          )
      })
      signal?.throwIfAborted()
      guard?.()
      committing = true
      const reply = (await core.command(
        'playlists.submit',
        { kind: 'commit', id: stage.id, sequence: ++sequence },
        signal
      )) as CorePlaylistSubmitReply
      await refresh()
      return reply.result as T
    } catch (error) {
      if (!committing)
        await core.command('playlists.submit', { kind: 'abort', id: stage.id }).catch(() => {})
      throw error
    }
  }
  const batch =
    <T>(items: readonly T[]): PlaylistPageProducer<T> =>
    async (append) => {
      await append(items)
    }
  const trackPages =
    (produce: DisplayTrackProducer): PlaylistPageProducer<CorePlaylistSubmitItem> =>
    async (append) =>
      produce((items) => append(items.map((track) => ({ input: trackInput(track) }))))
  const idPages =
    (produce: PlaylistPageProducer<string>): PlaylistPageProducer<CorePlaylistSubmitItem> =>
    async (append) =>
      produce((items) => append(items.map((id) => ({ id }))))
  const find = (name: string) => {
    const p = catalog.value.find((p) => p.name === name && p.kind !== 'aggregate')
    if (!p) throw new Error('歌单已不存在')
    return p
  }
  const members = (
    id: string,
    query: Omit<
      import('../../../../shared/corePlaylists.ts').CorePlaylistQueries['playlists.members']['input'],
      'id' | 'revision'
    > = {}
  ) => core.query('playlists.members', { id, revision: revision(), ...query })
  async function queryFavoriteStates(tracks: readonly Track[], signal?: AbortSignal) {
    const result = await core.query(
      'playlists.favorites',
      {
        revision: revision(),
        items: tracks.map(trackInput)
      },
      signal
    )
    signal?.throwIfAborted()
    return result.contains
  }
  async function favoriteStates(tracks: readonly Track[]) {
    const cache = favorites.value
    const epoch = core.state.value?.epoch
    const requestedRevision = revision()
    const values = await queryFavoriteStates(tracks)
    // An older request must not repopulate a cache invalidated by a playlist edit.
    if (
      cache === favorites.value &&
      epoch === core.state.value?.epoch &&
      requestedRevision === core.state.value?.playlistsRevision
    ) {
      let changed = false
      tracks.forEach((track, index) => {
        if (cache.get(track.id) !== values[index]) {
          cache.set(track.id, values[index])
          changed = true
        }
      })
      if (changed) triggerRef(favorites)
    }
    return values
  }
  async function readFavoriteTrackPages(produce: DisplayTrackProducer, signal?: AbortSignal) {
    let count = 0,
      favoriteCount = 0
    const guard = await produce(async (tracks) => {
      for (let o = 0; o < tracks.length; o += 200) {
        signal?.throwIfAborted()
        // Selection summaries do not own display state. Retain only this page.
        const values = await queryFavoriteStates(tracks.slice(o, o + 200), signal)
        count += values.length
        for (const favorite of values) if (favorite) favoriteCount++
      }
    })
    signal?.throwIfAborted()
    guard?.()
    return { count, favoriteCount }
  }
  const scan = computed(() => core.state.value?.scan ?? null)
  const libraryScanStatus = computed<LocalLibraryScanStatus>(() => ({
    jobId: scan.value?.jobId ?? null,
    mode: null,
    state: scan.value?.state === 'interrupted' ? 'paused' : scan.value?.state ?? 'idle',
    current: scan.value?.checkedFiles ?? 0,
    total: scan.value?.checkedFiles ?? 0,
    parsedFileCount: scan.value?.parsedFiles ?? 0,
    skippedUnchanged: Math.max(0, (scan.value?.checkedFiles ?? 0) - (scan.value?.parsedFiles ?? 0)),
    error: scan.value?.error ?? '',
    databaseProgress: scan.value ?? undefined
  }))
  const libraryScanProgress = computed<LocalLibraryScanProgress | null>(() =>
    scan.value && ['running', 'paused'].includes(scan.value.state)
      ? {
          jobId: scan.value.jobId,
          mode: 'full',
          phase: scan.value.phase === 'parsing' ? 'parsing' : 'enumerating',
          current: scan.value.checkedFiles,
          total: scan.value.checkedFiles,
          parsedFileCount: scan.value.parsedFiles,
          skippedUnchanged: Math.max(0, scan.value.checkedFiles - scan.value.parsedFiles)
        }
      : null
  )
  const enrichment = shallowRef<
    import('../../../../shared/coreMetadata.ts').LibraryMetadataEnrichmentStatus | null
  >(null)
  const off = core.subscribe((message) => {
    if (message.kind === 'state')
      void core
        .query('metadata.status', {})
        .then((s) => {
          enrichment.value = s
        })
        .catch(() => {})
  })
  async function selectTracks(tracks: readonly Track[]): Promise<LibrarySelectionSnapshot> {
    const ids = tracks.map((t) => t.id),
      page = await core.query('library.tracks', { ids, limit: 200 })
    return core.command('library.selection.open', {
      query: { ids, contentRevision: page.revision },
      total: page.total,
      ranges: page.total ? [[0, page.total]] : []
    }) as Promise<LibrarySelectionSnapshot>
  }
  async function removeLocalTracks(
    tracks: readonly Track[],
    mode: import('../../../../shared/localLibrary.ts').LocalLibraryRemovalMode
  ): Promise<CoreLibraryRemovalResult> {
    const s = await selectTracks(tracks)
    try {
      return (await core.command('library.remove', {
        selectionId: s.id,
        mode
      })) as CoreLibraryRemovalResult
    } finally {
      await core.command('library.selection.close', { id: s.id })
    }
  }
  return {
    playlists: shallowReadonly(catalog),
    localPlaylists: computed(() => catalog.value.filter((p) => p.kind !== 'aggregate')),
    aggregatePlaylists: computed(() =>
      catalog.value
        .filter((p) => p.kind === 'aggregate')
        .sort(
          (a, b) =>
            String(b.pinnedAt ?? '').localeCompare(String(a.pinnedAt ?? '')) ||
            a.name.localeCompare(b.name, 'zh')
        )
    ),
    libraryRevision: computed(() => core.state.value?.libraryRevision ?? 0),
    playlistsRevision: computed(() => core.state.value?.playlistsRevision ?? 0),
    libraryTrackCount: computed(() => metadata.value?.trackCount ?? 0),
    scannedFolders: computed(() => metadata.value?.folders ?? []),
    excludedTracks: computed(() => metadata.value?.exclusions ?? []),
    libraryCompatibilityError: shallowReadonly(failure),
    libraryScanStatus,
    libraryScanProgress,
    isScanning: computed(() => scan.value?.state === 'running'),
    libraryMetadataEnrichmentStatus: computed(
      () =>
        enrichment.value ?? {
          state: 'idle' as const,
          total: 0,
          queued: 0,
          active: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          error: ''
        }
    ),
    playlistPersistenceStatus: computed(
      () =>
        state.value?.persistence ?? {
          state: 'idle' as const,
          dirty: false,
          failureCount: 0,
          lastError: null
        }
    ),
    playlistPersistenceNotice: computed(() => state.value?.notice ?? null),
    libraryRepairReport: computed(() => state.value?.repair ?? null),
    loadApplicationLibrary: refresh,
    loadLibrary: refresh,
    loadPlaylists: refresh,
    retryLibraryCompatibility: refresh,
    reloadPlaylistsDiscardingChanges: refresh,
    refreshLibraryIndex: refresh,
    handleLibraryChange: refresh,
    getPlaylistMembers: members,
    getPlaylistMembership: async (id: string, ids: string[]) =>
      (await core.query('playlists.membership', { id, revision: revision(), ids })).contains,
    getPlaylistMemberPosition: async (id: string, anchorId: string) =>
      (await members(id, { anchorId, limit: 1 })).anchorIndex ?? -1,
    queryTracks: (query: LibraryQuery) => core.query('library.tracks', query),
    getTracksByIds: (ids: string[], revision?: number) =>
      core.query('library.byIds', { ids, revision }),
    queryCollections: (
      kind: import('../../../../shared/libraryDatabase.ts').LibraryCollectionKind,
      query: LibraryQuery = {}
    ) => core.query('library.collections', { kind, query }),
    createPlaylist: (name: string) => edit<string>({ kind: 'create', name }),
    createAggregatePlaylist: (name: string) =>
      edit<string>({ kind: 'create', name, aggregate: true }),
    renamePlaylist: (id: string, name: string) => edit<boolean>({ kind: 'rename', id, name }),
    copyPlaylist: (id: string, name: string) => edit<string | null>({ kind: 'copy', id, name }),
    deletePlaylist: (id: string) => edit<void>({ kind: 'delete', id }),
    setPlaylistCover: (id: string, cover: string | null) =>
      edit<boolean>({ kind: 'cover', id, cover }),
    setPlaylistPinned: (id: string, pinned: boolean) => edit<boolean>({ kind: 'pin', id, pinned }),
    setPlaylistHiddenSources: (id: string, sources: string[]) =>
      edit<boolean>({ kind: 'hiddenSources', id, sources }),
    setPlaylistVariantPreference: (id: string, anchorId: string, source: string | null) =>
      edit<boolean>({ kind: 'variant', id, anchorId, source }),
    createPlaylistWithTrackPages: (
      name: string,
      produce: DisplayTrackProducer,
      signal?: AbortSignal
    ) => submit<string>({ kind: 'create', name }, trackPages(produce), signal),
    createAggregatePlaylistWithTrackPages: (
      name: string,
      produce: DisplayTrackProducer,
      signal?: AbortSignal
    ) => submit<string>({ kind: 'create', name, aggregate: true }, trackPages(produce), signal),
    addTrackPagesToPlaylistById: (
      id: string,
      produce: DisplayTrackProducer,
      signal?: AbortSignal
    ) => submit<number>({ kind: 'add', id }, trackPages(produce), signal),
    addTrackPagesToExternalPlaylistById: (
      id: string,
      produce: DisplayTrackProducer,
      signal?: AbortSignal
    ) => submit<number>({ kind: 'add', id, external: true }, trackPages(produce), signal),
    addTracksToPlaylistById: (id: string, tracks: Track[]) =>
      submit<number>({ kind: 'add', id }, trackPages(batch(tracks))),
    addTracksToPlaylist: (name: string, tracks: Track[]) =>
      submit<number>({ kind: 'add', id: find(name).id }, trackPages(batch(tracks))),
    addToPlaylist: (name: string, id: string, track?: Track) =>
      submit<number>(
        { kind: 'add', id: find(name).id },
        batch([{ id, input: track ? trackInput(track) : { kind: 'local', id } }])
      ),
    removeFromPlaylist: (name: string, id: string) =>
      edit<number>({ kind: 'remove', id: find(name).id, ids: [id] }),
    removeTracksFromPlaylist: (name: string, ids: Iterable<string>) =>
      submit<number>({ kind: 'remove', id: find(name).id }, idPages(batch([...ids]))),
    removeTracksFromPlaylistById: (id: string, ids: Iterable<string>) =>
      submit<number>({ kind: 'remove', id }, idPages(batch([...ids]))),
    removeTrackIdPagesFromPlaylistById: (
      id: string,
      produce: PlaylistPageProducer<string>,
      signal?: AbortSignal
    ) => submit<number>({ kind: 'remove', id }, idPages(produce), signal),
    reorderPlaylistTracks: (name: string, ids: Iterable<string>, target: number) =>
      submit<boolean>({ kind: 'reorder', id: find(name).id, target }, idPages(batch([...ids]))),
    reorderPlaylistTrackIdPagesById: (
      id: string,
      produce: PlaylistPageProducer<string>,
      target: number,
      signal?: AbortSignal
    ) => submit<boolean>({ kind: 'reorder', id, target }, idPages(produce), signal),
    movePlaylistTracks: (name: string, target: string, ids: Iterable<string>) =>
      submit<PlaylistBatchMoveResult>(
        { kind: 'move', id: find(name).id, targetId: find(target).id },
        idPages(batch([...ids]))
      ),
    movePlaylistMemberPagesById: (
      id: string,
      targetId: string,
      produce: DisplayMemberProducer,
      signal?: AbortSignal
    ) =>
      submit<PlaylistBatchMoveResult>(
        { kind: 'move', id, targetId },
        async (append) =>
          produce((items) =>
            append(
              items.map((item) => ({
                id: item.id,
                ...(item.track ? { input: trackInput(item.track) } : {})
              }))
            )
          ),
        signal
      ),
    getFavoriteTrackStates: favoriteStates,
    isFavoriteTrack: (track: Track) => favorites.value.get(track.id) ?? false,
    readFavoriteTrackPages,
    setFavoriteTracks: (tracks: Track[], favorite: boolean) =>
      submit<number>({ kind: 'favorite', favorite }, trackPages(batch(tracks))),
    setFavoriteTrackPages: (
      produce: DisplayTrackProducer,
      favorite: boolean,
      signal?: AbortSignal
    ) => submit<number>({ kind: 'favorite', favorite }, trackPages(produce), signal),
    exportPlaylistDocumentAsync: async (name: string, format: PlaylistFileFormat) =>
      (await core.query('playlists.export', { id: find(name).id, revision: revision(), format }))
        .contents,
    importPlaylistDocumentAsync: async (name: string, fileName: string, contents: string) => {
      const v = (await core.command('playlists.importDocument', {
        id: find(name).id,
        revision: revision(),
        fileName,
        contents
      })) as { result: PlaylistImportApplyResult }
      await refresh()
      return v.result
    },
    repairPlaylistMissingTracksAsync: (id: string, folder: string) =>
      core.command('playlists.repair', { id, revision: revision(), folder }),
    flushPlaylists: () => core.command('playlists.flush', {}),
    startStartupLibraryScan: () => core.command('scan.start', { mode: 'startup' }),
    startFullLibraryScan: () => core.command('scan.start', { mode: 'full' }),
    scanLibraryDirectories: (
      r: import('../../../../shared/libraryDatabase.ts').LibraryDirectoryScanRequest
    ) =>
      core.command('scan.start', {
        mode: 'full',
        roots: r.directories,
        restoreExcluded: r.reason === 'import'
      }),
    pauseLibraryScan: () => core.command('scan.pause', { jobId: scan.value!.jobId }),
    resumeLibraryScan: () => core.command('scan.resume', { jobId: scan.value!.jobId }),
    cancelLibraryScan: () => core.command('scan.cancel', { jobId: scan.value!.jobId }),
    cancelLibraryMetadataEnrichment: () => core.command('metadata.cancel', {}),
    startLibraryMetadataEnrichment: () => core.command('metadata.start', {}),
    resetLibrary: () =>
      core.command('library.reset', { revision: core.state.value?.libraryRevision ?? 0 }),
    clearExcludedTracks: (paths: string[]) =>
      core.command('library.exclusions.clear', {
        revision: core.state.value?.libraryRevision ?? 0,
        paths
      }),
    restoreExcludedTracks: async (paths: string[]) => {
      await core.command('library.exclusions.clear', {
        revision: core.state.value?.libraryRevision ?? 0,
        paths
      })
      return core.command('scan.start', { mode: 'full', restoreExcluded: true })
    },
    removeLocalTracks,
    removeTrack: (id: string) => removeLocalTracks([{ id } as Track], 'library'),
    selectTracks,
    writeTrackTags: (selectionId: string, patch: CoreTagPatch) =>
      core.command('library.tags.write', { selectionId, patch }),
    dispose() {
      generation++
      stop()
      off()
      favorites.value = new Map()
    }
  }
}
