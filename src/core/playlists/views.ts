import type { CorePlaylistViewQuery, CorePlaylistViewPage, CorePlaylistQueries } from '../../shared/corePlaylists.ts'
import type { LibraryDatabaseApi, LibraryQuery, LibraryPage } from '../../shared/libraryDatabase.ts'
import type { Playlist } from '../../shared/playlists.ts'
import type { MusicVersionsDocument } from '../../shared/musicVersions.ts'
import type { TrackData } from '../../shared/track.ts'
import { createAggregatePlaylistModel } from '../../shared/aggregatePlaylistView.ts'
import { createPlaylistTrackResolver } from './trackResolver.ts'
import { createLibraryPlaylistView } from './sqlView.ts'
import { projectCoreTrack } from '../projections.ts'
import type { PlaylistRuntime } from './ports.ts'

export interface CorePlaylistViewOptions {
  database: Pick<LibraryDatabaseApi, 'syncPlaylistView' | 'queryTracks'> & Partial<Pick<LibraryDatabaseApi, 'queryCollections'>>
  playlist(id: string, revision: number): Playlist
  versions: {
    getRevision(): number
    snapshot(): MusicVersionsDocument
    readonlySnapshot?(): Readonly<MusicVersionsDocument>
  }
  runtime: PlaylistRuntime
  loadJsonLibrary?: () => Promise<{ revision: number; tracks: TrackData[] }>
}

/** One bounded SQL lease shared by Core readers, never uploaded by a renderer.
 * Reading and lease replacement share a lane; playback controls do not. */
export class CorePlaylistViews {
  private readonly owners = new Map<string, ReturnType<typeof createLibraryPlaylistView>>()
  private readonly options: CorePlaylistViewOptions
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(options: CorePlaylistViewOptions) {
    this.options = options
  }
  private owner(id: string) {
    let owner = this.owners.get(id)
    if (!owner) {
      owner = createLibraryPlaylistView(this.options.database, this.options.runtime.newId)
      this.owners.set(id, owner)
    }
    return owner
  }
  query(query: CorePlaylistViewQuery, signal?: AbortSignal): Promise<CorePlaylistViewPage> {
    return this.records(query, signal).then((result) => ({
      ...result,
      page: {
        ...result.page,
        definitionIds: result.page.entryIds?.map(entryId => {
          const playlist = this.options.playlist(query.id, query.revision)
          return playlist.imported ? entryId : playlist.trackIds[Number(entryId)]
        }),
        tracks: result.page.tracks.map((track) => projectCoreTrack(track))
      }
    }))
  }
  /** Core-only rows, for document export. Public clients always use query(). */
  records(
    query: CorePlaylistViewQuery,
    signal?: AbortSignal
  ): Promise<Omit<CorePlaylistViewPage, 'page'> & { page: LibraryPage }> {
    if (this.stopped) return Promise.reject(new Error('Playlist views are shutting down'))
    const work = this.tail
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted()
        const playlist = this.options.playlist(query.id, query.revision)
        const owner = this.owner(`${query.id}:${!!query.preserveSources}`)
        const revision = this.options.versions.getRevision()
        const fence = () => {
          this.options.playlist(query.id, query.revision)
          if (this.options.versions.getRevision() !== query.versionsRevision)
            throw Object.assign(new Error('录音版本偏好已变化，请重新读取'), {
              code: 'STALE_REVISION'
            })
          signal?.throwIfAborted()
        }
        fence()
        let page: LibraryPage
        if (this.options.loadJsonLibrary) {
          const library = await this.options.loadJsonLibrary()
          if (query.contentRevision !== undefined && query.contentRevision !== library.revision)
            throw Object.assign(new Error('曲库已变化，请重新读取'), { code: 'STALE_REVISION' })
          page = this.jsonPage(playlist, query, library)
        } else {
          await owner.setPlaylist(playlist, {
            revision,
            versions: (
              this.options.versions.readonlySnapshot?.() ?? this.options.versions.snapshot()
            ).tracks.versions,
            preserveSources: playlist.kind === 'aggregate' || query.preserveSources
          })
          fence()
          const state = owner.state.value
          if (state.error || !state.id) throw new Error(state.error || '歌单视图尚未就绪')
          const request: LibraryQuery = {
            ...query.query,
            playlistView: state.id,
            sort: query.query?.sort ?? 'playlist',
            contentRevision: query.contentRevision ?? query.query?.contentRevision,
            offset: query.offset ?? query.query?.offset,
            limit: query.limit ?? query.query?.limit ?? 200,
            search: query.search ?? query.query?.search,
            anchorId: query.anchorId ?? query.query?.anchorId,
            ...(playlist.kind === 'aggregate'
              ? {
                  aggregate: {
                    hiddenSources: query.includeHiddenSources ? [] : playlist.hiddenSources,
                    variantPreferences: playlist.variantPreferences,
                    variantRow: query.variantRow,
                    sourceCounts: query.sourceCounts
                  }
                }
              : {})
          }
          try {
            page = await this.options.database.queryTracks(request)
          } catch (error) {
            owner.recover(state.id, error)
            throw error
          }
        }
        fence()
        return {
          viewId: owner.state.value.id ?? '',
          revision: query.revision,
          versionsRevision: query.versionsRevision,
          page
        }
      })
    this.tail = work
    return work
  }
  collection(playlists: Playlist[], query: CorePlaylistQueries['playlists.collection']['input'], signal?: AbortSignal) {
    const work = this.tail.catch(() => undefined).then(async () => {
      signal?.throwIfAborted()
      if (this.options.versions.getRevision() !== query.versionsRevision)
        throw Object.assign(new Error('录音版本偏好已变化，请重新读取'), {code:'STALE_REVISION'})
      const owner = this.owner(`catalog:${!!query.aggregate}`)
      await owner.setCatalog(playlists, {
        revision: query.versionsRevision,
        versions: (
          this.options.versions.readonlySnapshot?.() ?? this.options.versions.snapshot()
        ).tracks.versions,
        preserveSources: query.aggregate
      })
      const id = owner.state.value.id
      if (!id || owner.state.value.error) throw new Error(owner.state.value.error || '歌单目录尚未就绪')
      if (!this.options.database.queryCollections) throw new Error('曲库目录查询不可用')
      const page = await this.options.database.queryCollections('playlists',{...query.query,playlistView:id})
      signal?.throwIfAborted()
      return page
    })
    this.tail = work
    return work
  }
  private jsonPage(
    playlist: Playlist,
    query: CorePlaylistViewQuery,
    library: { revision: number; tracks: TrackData[] }
  ): LibraryPage {
    const resolver = createPlaylistTrackResolver({
      tracks: { value: library.tracks },
      trackById: new Map(library.tracks.map((t) => [t.id, t])),
      getTracksRevision: () => library.revision,
      runtime: this.options.runtime
    })
    const aggregate = createAggregatePlaylistModel(this.options.runtime.identity)
    const preserve = playlist.kind === 'aggregate' || query.preserveSources
    const members = playlist.imported
      ? resolver
          .resolvePlaylistTracks(playlist, preserve)
          .map((track) => ({ track, entryId: track.queueEntryId! }))
      : playlist.trackIds.flatMap((id, index) =>
          resolver
            .resolvePlaylistTracks({ ...playlist, trackIds: [id] }, preserve)
            .map((track) => ({ track, entryId: String(index) }))
        )
    const tracks = members.map((member) => member.track)
    const search = query.search?.trim().toLowerCase()
    const matches = (track: TrackData) =>
      !search || `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(search)
    let selected = tracks,
      entryIds: string[] | undefined,
      metadata: LibraryPage['aggregate']
    if (playlist.kind === 'aggregate') {
      const rows = aggregate.buildAggregateRows({
        tracks,
        hiddenSources: playlist.hiddenSources,
        variantPreferences: playlist.variantPreferences
      })
      const indexed = rows.map((row, index) => ({ row, id: String(index) }))
      const filtered = indexed.filter(({ row }) => matches(row.selectedVariant.track))
      metadata = { rowCount: rows.length, memberCount: tracks.length, rows: [] }
      if (query.sourceCounts) {
        const sources = aggregate.collectAggregateSources(tracks, playlist.hiddenSources)
        return {
          tracks: [],
          total: sources.length,
          offset: query.offset ?? 0,
          revision: library.revision,
          versions: {},
          aggregate: {
            ...metadata,
            sources: sources.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 200))
          }
        }
      }
      if (query.variantRow !== undefined) {
        const row = indexed.find((row) => row.id === query.variantRow)?.row
        selected = row?.visibleVariants.map((v) => v.track) ?? []
        const available = new Map<TrackData, { entries: string[]; next: number }>()
        for (const member of members) {
          const bucket = available.get(member.track)
          if (bucket) bucket.entries.push(member.entryId)
          else available.set(member.track, { entries: [member.entryId], next: 0 })
        }
        entryIds = selected.map((track) => {
          const bucket = available.get(track)!
          return bucket.entries[bucket.next++]!
        })
      } else {
        selected = filtered.map(({ row }) => row.selectedVariant.track)
        entryIds = filtered.map(({ id }) => id)
        metadata.rows = filtered.map(({ row, id }) => ({
          rowId: id,
          anchorTrackId: row.anchorTrackId,
          variantCount: row.allVariants.length,
          visibleVariantCount: row.visibleVariants.length,
          variantPinned: row.variantPinned,
          preferenceUnavailable: row.preferenceUnavailable
        }))
      }
    } else {
      const filtered = members.filter(({ track }) => matches(track))
      selected = filtered.map(({ track }) => track)
      entryIds = filtered.map(({ entryId }) => entryId)
    }
    let offset = query.offset ?? 0
    const limit = query.limit ?? 200
    const anchorIndex =
      query.anchorId !== undefined ? selected.findIndex((t) => t.id === query.anchorId) : undefined
    if (anchorIndex !== undefined && anchorIndex >= 0)
      offset = Math.floor(anchorIndex / limit) * limit
    return {
      tracks: selected.slice(offset, offset + limit).map((t) => ({ ...t })),
      total: selected.length,
      offset,
      revision: library.revision,
      versions: {},
      totalDuration: selected.reduce((sum, t) => sum + t.duration, 0),
      anchorIndex,
      ...(entryIds ? { entryIds: entryIds.slice(offset, offset + limit) } : {}),
      ...(metadata
        ? { aggregate: { ...metadata, rows: metadata.rows.slice(offset, offset + limit) } }
        : {})
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.tail.catch(() => undefined)
    await Promise.all([...this.owners.values()].map(owner => owner.dispose()))
    this.owners.clear()
  }
}
