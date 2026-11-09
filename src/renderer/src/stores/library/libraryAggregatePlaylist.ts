import { computed, shallowRef, toRaw } from 'vue'
import { LIBRARY_PAGE_SIZE, type LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { createCoreLibraryApi } from './coreLibraryApi.ts'
import type { CoreLibraryPage as LibraryPage } from '../../../../shared/coreViews.ts'
import { createLibraryTrackPages } from './libraryTrackPages.ts'
import { createLibraryCollectionWindow } from './libraryCollectionWindow.ts'
import { createLibraryTrackWindow } from './libraryTrackWindow.ts'
import { libraryTrack } from '../../utils/libraryQueuePlayback.ts'
import type { CorePlaylistDescriptor as Playlist } from '../../../../shared/corePlaylists.ts'
import type { Track } from '../../types/music.ts'

export type AggregateRowMetadata = NonNullable<LibraryPage['aggregate']>['rows'][number]
type Input = {
  enabled: boolean
  playlist: Playlist | null
  playlists: Playlist[]
  search: string
  revision: number
}

export function createLibraryAggregatePlaylist(api: ReturnType<typeof createCoreLibraryApi>) {
  // All detail, menu, source, catalog and deletion reads share two transport
  // slots, including late responses from a previous selection.
  let activeReads = 0
  const waiting: Array<() => void> = []
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (activeReads < 2) {
        activeReads++
        resolve()
      } else waiting.push(resolve)
    })
    try {
      if (disposed) throw new Error('聚合歌单已关闭')
      return await operation()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else activeReads--
    }
  }
  const detail = api.createPlaylistView(),
    catalog = api.createPlaylistView()
  const input = shallowRef<Input>({
    enabled: false,
    playlist: null,
    playlists: [],
    search: '',
    revision: 0
  })
  const mapPage = (page: LibraryPage) => ({
    ...page,
    tracks: page.tracks.map((record) => ({ ...libraryTrack(record) }))
  })
  const queryTracks = async (
    query?: LibraryQuery,
    options?: { includeHiddenSources?: boolean }
  ) => {
    try {
      return mapPage(await read(() => api.queryTracks(query, options)))
    } catch (error) {
      if (query?.playlistView) detail.recover(query.playlistView, error)
      throw error
    }
  }
  const pages = createLibraryTrackWindow({ queryTracks }, 9),
    sources = createLibraryTrackPages({ queryTracks }, 1),
    variants = createLibraryTrackPages({ queryTracks }, 1)
  const cards = createLibraryCollectionWindow({
    queryCollections: async (kind, query) => {
      try {
        return await read(() => api.queryCollections(kind, query))
      } catch (error) {
        if (query?.playlistView) catalog.recover(query.playlistView, error)
        throw error
      }
    }
  })
  const query = computed<LibraryQuery | null>(() =>
    input.value.enabled && input.value.playlist && detail.state.value.id
      ? {
          playlistView: detail.state.value.id,
          sort: 'playlist',
          search: input.value.search,
          aggregate: {}
        }
      : null
  )
  const menu = shallowRef<{ rowId: string; generation: number; revision: number } | null>(null)
  let detailIntent = '',
    detailScopeIntent = '',
    catalogIntent = '',
    detailLeaseIntent = ''
  let pageQuery = '',
    sourceQuery = '',
    cardQuery = '',
    generation = 0,
    disposed = false,
    removing = false
  const action = shallowRef({ pending: false, error: '' })
  function updateQueries(): void {
    const next = query.value,
      key = JSON.stringify(next)
    const intent = JSON.stringify([
      input.value.enabled,
      input.value.playlist?.id,
      input.value.search,
      input.value.playlist?.hiddenSources,
      input.value.revision
    ])
    const scopeIntent = JSON.stringify([
      input.value.enabled,
      input.value.playlist?.id,
      input.value.search,
      input.value.playlist?.hiddenSources
    ])
    if (key !== pageQuery || intent !== detailIntent) {
      pageQuery = key
      const preservePosition =
        !!input.value.playlist && input.value.enabled && scopeIntent === detailScopeIntent
      detailIntent = intent
      detailScopeIntent = scopeIntent
      pages.setQuery(next, preservePosition)
      closeVariants()
      generation++
      action.value = { pending: false, error: '' }
    }
    const source = next
      ? {
          ...next,
          search: undefined,
          aggregate: { hiddenSources: next.aggregate!.hiddenSources, sourceCounts: true }
        }
      : null
    // Core can retain the same view handle when playlist preferences change.
    // Source counts and visibility still belong to the new configuration.
    const sourceKey = JSON.stringify([
      source,
      input.value.revision,
      input.value.playlist?.hiddenSources
    ])
    if (sourceKey !== sourceQuery) {
      sourceQuery = sourceKey
      sources.setQuery(source)
    }
    const grid =
      input.value.enabled && !input.value.playlist && catalog.state.value.id
        ? {
            playlistView: catalog.state.value.id,
            collectionOrder: input.value.playlists.map((playlist) => playlist.id)
          }
        : null
    const gridKey = JSON.stringify(grid)
    const gridIntent = JSON.stringify([input.value.enabled, !!input.value.playlist])
    if (gridKey !== cardQuery || gridIntent !== catalogIntent) {
      cardQuery = gridKey
      const preservePosition =
        input.value.enabled && !input.value.playlist && gridIntent === catalogIntent
      catalogIntent = gridIntent
      cards.setQuery(grid ? 'playlists' : null, grid ?? {}, preservePosition)
    }
  }
  // The component subscribes to these lease refs and calls refreshQueries.
  // Keep this controller independently testable without a component scope.
  function closeVariants(): void {
    menu.value = null
    variants.setQuery(null)
  }
  function currentRow(
    track: Track
  ): { meta: AggregateRowMetadata; entryId: string; page: LibraryPage } | null {
    const page = pages.pageForTrack(toRaw(track) as unknown as LibraryPage['tracks'][number]),
      index = page?.tracks.indexOf(toRaw(track) as unknown as LibraryPage['tracks'][number]) ?? -1
    const meta = page?.aggregate?.rows[index],
      entryId = page?.entryIds?.[index]
    return index >= 0 && meta && entryId !== undefined ? { meta, entryId, page: page! } : null
  }
  const busy = computed(
    () =>
      input.value.enabled &&
      (input.value.playlist
        ? detail.state.value.pending || pages.state.value.loading
        : catalog.state.value.pending || cards.state.value.loading)
  )
  const error = computed(() =>
    input.value.playlist
      ? detail.state.value.error || pages.state.value.error
      : catalog.state.value.error || cards.state.value.error
  )
  return {
    detailState: detail.state,
    catalogState: catalog.state,
    pageState: pages.state,
    pages: pages.pages,
    trackAt: pages.trackAt,
    cardAt: cards.itemAt,
    cardPages: cards.pages,
    setRange(start: number, end: number) {
      pages.setRange(start, end)
      if (
        menu.value &&
        !pages.pages.value.some(
          (page) =>
            page.revision === menu.value!.revision &&
            page.aggregate?.rows.some((row) => row.rowId === menu.value!.rowId)
        )
      )
        closeVariants()
    },
    setCardRange: cards.setRange,
    sourceState: sources.state,
    variantState: variants.state,
    cardState: cards.state,
    menu,
    action,
    query,
    busy,
    error,
    get readState() {
      return {
        active: activeReads,
        waiting: waiting.length,
        cachedDetailPages: pages.cacheState.cachedPages + variants.cacheState.cachedPages,
        cachedTracks: pages.cacheState.cachedTracks + variants.cacheState.cachedTracks,
        cachedCollectionPages: cards.cacheState.cachedPages,
        cachedSummaries: cards.cacheState.cachedItems
      }
    },
    refreshQueries: updateQueries,
    setInput(value: Input): void {
      if (disposed) return
      const previous = input.value
      input.value = value
      if (
        previous.enabled !== value.enabled ||
        previous.playlist?.id !== value.playlist?.id ||
        previous.revision !== value.revision ||
        previous.playlist !== value.playlist
      )
        generation++
      const leaseIntent = JSON.stringify([
        value.enabled,
        value.playlist?.id,
        value.revision
      ])
      if (leaseIntent !== detailLeaseIntent) {
        detailLeaseIntent = leaseIntent
        void detail.setPlaylist(value.enabled ? value.playlist : null, {
          preserveSources: true
        })
      }
      void catalog.setCatalog(value.enabled && !value.playlist ? value.playlists : null, {
        preserveSources: true
      })
      updateQueries()
    },
    retry(): void {
      if (input.value.playlist && detail.state.value.error) void detail.retry()
      else if (!input.value.playlist && catalog.state.value.error) void catalog.retry()
      else if (input.value.playlist) pages.retry()
      else cards.retry()
    },
    invalidate(revision?: number): void {
      generation++
      action.value = { pending: false, error: '' }
      if (query.value) {
        pages.invalidate(revision)
        sources.invalidate(revision)
        closeVariants()
      } else if (input.value.enabled) cards.invalidate(revision)
    },
    goToPage: (page: number) => {
      generation++
      action.value = { pending: false, error: '' }
      closeVariants()
      pages.setRange(page * LIBRARY_PAGE_SIZE, (page + 1) * LIBRARY_PAGE_SIZE)
    },
    goToSourcePage: sources.goToPage,
    goToCardPage: (page: number) =>
      cards.setRange(page * LIBRARY_PAGE_SIZE, (page + 1) * LIBRARY_PAGE_SIZE),
    openVariants(track: Track): void {
      const row = currentRow(track),
        page = row?.page
      if (!row || !query.value || !page) return
      if (menu.value?.rowId === row.meta.rowId) {
        closeVariants()
        return
      }
      menu.value = {
        rowId: row.meta.rowId,
        generation: pages.state.value.generation,
        revision: page.revision
      }
      variants.setQuery({
        ...query.value,
        search: undefined,
        contentRevision: page.revision,
        aggregate: { ...query.value.aggregate, variantRow: row.meta.rowId }
      })
    },
    closeVariants,
    goToVariantPage: variants.goToPage,
    retryVariants: variants.retry,
    retrySources: sources.retry,
    rowFor: currentRow,
    locate: pages.locate,
    playbackQuery(track?: Track): LibraryQuery | null {
      const row = track ? currentRow(track) : null,
        page = row?.page ?? pages.state.value.page,
        next = query.value
      if (!next || !page || busy.value || error.value) return null
      if (track && !row) return null
      if (row?.meta.preferenceUnavailable) {
        action.value = {
          pending: false,
          error: '偏好来源未载入，请明确选择音源，或在歌曲信息中修改偏好'
        }
        return null
      }
      return {
        ...next,
        contentRevision: page.revision,
        ...(row ? { playlistEntryId: row.entryId } : {})
      }
    },
    recoverPlayback(id: string, error: unknown): void {
      if (detail.recover(id, error))
        action.value = { pending: false, error: '正在重新读取聚合歌单，完成后请重新播放' }
    },
    async removalIds(track: Track): Promise<{ playlistId: string; ids: string[] } | null> {
      if (removing) return null
      const row = currentRow(track),
        page = row?.page,
        next = query.value,
        playlist = input.value.playlist
      if (!row || !page || !next || !playlist) return null
      const captured = generation,
        options = JSON.stringify(playlist.hiddenSources),
        revision = input.value.revision
      const valid = () =>
        !disposed &&
        generation === captured &&
        input.value.enabled &&
        input.value.playlist?.id === playlist.id &&
        input.value.revision === revision &&
        JSON.stringify(input.value.playlist.hiddenSources) === options
      removing = true
      action.value = { pending: true, error: '' }
      try {
        const result = new Set<string>()
        for (let offset = 0; ; offset += LIBRARY_PAGE_SIZE) {
          const part = await queryTracks({
            ...next,
            search: undefined,
            contentRevision: page.revision,
            offset,
            limit: LIBRARY_PAGE_SIZE,
            aggregate: { variantRow: row.meta.rowId }
          }, { includeHiddenSources: true })
          if (!valid()) throw new Error('聚合歌单在移除期间发生变化，请重试')
          if (part.definitionIds?.length !== part.tracks.length)
            throw new Error('无效的录音成员分页')
          for (const id of part.definitionIds) result.add(id)
          if (offset + part.tracks.length >= part.total) break
          if (!part.tracks.length) throw new Error('录音成员分页未前进')
        }
        const metadata = await read(() => api.getMetadata())
        if (!valid() || metadata.revision !== page.revision)
          throw new Error('曲库在移除期间发生变化，请重试')
        return { playlistId: playlist.id, ids: [...result] }
      } catch (error) {
        if (!disposed && generation === captured)
          action.value = {
            pending: false,
            error: error instanceof Error ? error.message : String(error)
          }
        return null
      } finally {
        removing = false
        if (!disposed && generation === captured) action.value = { ...action.value, pending: false }
      }
    },
    dispose(): void {
      disposed = true
      generation++
      pages.dispose()
      sources.dispose()
      variants.dispose()
      cards.dispose()
      void detail.dispose()
      void catalog.dispose()
    }
  }
}
