import { shallowRef } from 'vue'
import { useCoreConnection } from '../coreConnection.ts'
import type { LibraryQuery, LibraryCollectionKind } from '../../../../shared/libraryDatabase.ts'
import type { CorePlaylistDescriptor } from '../../../../shared/corePlaylists.ts'
import type { CoreLibraryPage } from '../../../../shared/coreViews.ts'
import { CORE_RECENT_PLAYLIST_ID } from '../../../../shared/corePlaylists.ts'
export interface CoreLibraryReadApi {
  queryTracks(
    query?: LibraryQuery,
    options?: { includeHiddenSources?: boolean }
  ): Promise<CoreLibraryPage>
}
export function createCoreLibraryApi(core = useCoreConnection()) {
  const views = new Map<string, { id: string; preserveSources?: boolean }>()
  const revision = (id?: string) => {
    const s = core.state.value
    const revision = id === CORE_RECENT_PLAYLIST_ID ? s?.statisticsRevision : s?.playlistsRevision
    if (revision == null || s?.versionsRevision == null)
      throw new Error('Core 歌单尚未就绪')
    return { revision, versionsRevision: s.versionsRevision }
  }
  async function readView(
    id: string,
    query: LibraryQuery = {},
    preserveSources?: boolean,
    includeHiddenSources?: boolean
  ) {
    const { playlistView: _view, aggregate, ...scope } = query
    const result = await core.query('playlists.view', {
      id,
      ...revision(id),
      query: scope,
      preserveSources,
      includeHiddenSources,
      variantRow: aggregate?.variantRow,
      sourceCounts: aggregate?.sourceCounts
    })
    views.set(result.viewId, { id, preserveSources })
    return result
  }
  return {
    queryTracks: async (
      query: LibraryQuery = {},
      options: { includeHiddenSources?: boolean } = {}
    ) => {
      const view = query.playlistView ? views.get(query.playlistView) : undefined
      return view
        ? (await readView(view.id, query, view.preserveSources, options.includeHiddenSources)).page
        : core.query('library.tracks', query)
    },
    queryCollections: (kind: LibraryCollectionKind, query: LibraryQuery = {}) => {
      const { playlistView: _view, ...scope } = query
      return kind === 'playlists'
        ? core.query('playlists.collection', {
            ...revision(),
            aggregate: query.playlistView === 'core:aggregate-catalog',
            query: scope
          })
        : core.query('library.collections', { kind, query })
    },
    getMetadata: () => core.query('library.metadata', {}),
    getTracksByIds: (ids: string[], revision?: number) =>
      core.query('library.byIds', { ids, revision }),
    lookupTracksByPaths: (paths: string[], revision?: number) =>
      core.query('library.paths.lookup', { paths, revision }),
    createPlaylistView() {
      const state = shallowRef({
        id: null as string | null,
        pending: false,
        error: '',
        generation: 0
      })
      let current: Pick<CorePlaylistDescriptor, 'id'> | null = null,
        preserveSources = false,
        disposed = false
      async function setPlaylist(
        playlist: Pick<CorePlaylistDescriptor, 'id'> | null,
        options?: { preserveSources?: boolean }
      ) {
        const generation = state.value.generation + 1
        const retainedId = playlist?.id === current?.id ? state.value.id : null
        current = playlist
        preserveSources = !!options?.preserveSources
        state.value = { id: retainedId, pending: !!playlist, error: '', generation }
        if (!playlist) return
        try {
          const result = await readView(playlist.id, { limit: 1 }, preserveSources)
          if (!disposed && state.value.generation === generation)
            state.value = { id: result.viewId, pending: false, error: '', generation }
        } catch (error) {
          if (!disposed && state.value.generation === generation)
            state.value = {
              id: null,
              pending: false,
              error: error instanceof Error ? error.message : String(error),
              generation
            }
        }
      }
      return {
        state,
        setPlaylist,
        setCatalog: (
          playlists: CorePlaylistDescriptor[] | null,
          options?: { preserveSources?: boolean }
        ) => {
          state.value = {
            id: playlists
              ? options?.preserveSources
                ? 'core:aggregate-catalog'
                : 'core:catalog'
              : null,
            pending: false,
            error: '',
            generation: state.value.generation + 1
          }
          return Promise.resolve()
        },
        retry: () => setPlaylist(current, { preserveSources }),
        recover: (id: string, _error: unknown) => {
          if (
            state.value.id !== id ||
            !/Playlist view expired|Music library database process (?:exited|is unavailable)/i.test(
              String(_error)
            )
          )
            return false
          void setPlaylist(current, { preserveSources })
          return true
        },
        dispose: () => {
          disposed = true
          state.value = { ...state.value, id: null, generation: state.value.generation + 1 }
          return Promise.resolve()
        }
      }
    }
  }
}
let singleton: ReturnType<typeof createCoreLibraryApi> | undefined
export const useCoreLibraryApi = () => (singleton ??= createCoreLibraryApi())
