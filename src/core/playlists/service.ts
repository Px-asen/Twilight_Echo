import type {
  CorePlaylistEdit,
  CorePlaylistPage,
  CorePlaylistEntries,
  CorePlaylistSummary,
  CorePlaylistCatalogPage,
  CorePlaylistDescriptor,
  CorePlaylistMembersPage,
  CorePlaylistQueries,
  CorePlaylistState
} from '../../shared/corePlaylists.ts'
import type { CorePlaylistPageEdit } from '../../shared/corePlaylists.ts'
import type {
  Playlist,
  PlaylistImportApplyResult,
  PlaylistPersistenceNotice,
  PlaylistTrackPageProducer
} from '../../shared/playlists.ts'
import type { TrackData } from '../../shared/track.ts'
import type { LibraryDatabaseApi } from '../../shared/libraryDatabase.ts'
import type { PluginPlaylistImportNotice } from '../../shared/pluginPlaylistImport.ts'
import {
  importSongKey,
  type ImportedPlaylistData,
  type ImportResolution,
  type ImportedPlaylistEntry
} from '../../shared/externalPlaylist.ts'
import type { CoreImportPreviewSave } from '../../shared/coreImports.ts'
import { createPlaylistController } from './controller.ts'
import { resolveLibraryPlaylistImportPaths } from './libraryImport.ts'
import type { PlaylistPersistenceStatus } from './persistence.ts'
import type { PlaylistRuntime } from './ports.ts'
import { isVersionedDataEnvelope } from '../../shared/versionedPersistence.ts'
import { projectCoreTrack } from '../projections.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { searchLocalStreamingPlaylists } from '../../shared/localMusicSearch.ts'
import { CorePlaylistViews, type CorePlaylistViewOptions } from './views.ts'
import type { CorePlaylistViewQuery, CorePlaylistViewPage } from '../../shared/corePlaylists.ts'
import type { CorePlaylistRepairStatus } from '../../shared/corePlaylists.ts'
import type { PlaylistRelocationResult } from '../../shared/playlistLifecycle.ts'
import {
  createPlaylistDocumentWriter,
  type PlaylistFileFormat
} from '../../shared/playlistLifecycle.ts'
import { projectCoreError } from '../projections.ts'
import type { MusicPreferenceState } from '../../shared/musicPreferences.ts'
import { CORE_RECENT_PLAYLIST_ID } from '../../shared/corePlaylists.ts'

export interface CorePlaylistServiceOptions {
  runtime: PlaylistRuntime
  database: Pick<
    LibraryDatabaseApi,
    'lookupTracksByPaths' | 'getTracksByIds' | 'getMetadata' | 'queryTracks' | 'syncPlaylistView'
  > & Partial<Pick<LibraryDatabaseApi, 'queryCollections'>>
  versions: CorePlaylistViewOptions['versions']
  recentHistory?: { getRevision(): number; recentPlaylist(): Playlist }
  /** Only JSON-library mode supplies the complete legacy library snapshot. */
  loadJsonLibrary?: () => Promise<{ revision: number; tracks: TrackData[] }>
  preferencesTrackStates?(tracks: TrackData[]): Promise<Array<MusicPreferenceState | null>>
  findRelocationsInFolder?(
    missing: readonly TrackData[],
    folder: string
  ): Promise<PlaylistRelocationResult>
  changed(): void
}

/** One playlist/favorites owner, sharing mature import, occurrence and CAS semantics. */
export class CorePlaylistService {
  private readonly playlists = { value: [] as Playlist[] }
  private readonly tracks = { value: [] as TrackData[] }
  private readonly trackById = new Map<string, TrackData>()
  private readonly persistence = {
    value: {
      state: 'idle',
      dirty: false,
      failureCount: 0,
      lastError: null
    } as PlaylistPersistenceStatus
  }
  private readonly notice = { value: null as PlaylistPersistenceNotice | null }
  private readonly controller: ReturnType<typeof createPlaylistController>
  private readonly options: CorePlaylistServiceOptions
  private readonly views: CorePlaylistViews
  private committed: Playlist[] = []
  private revision = 0
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false
  private repairWork: Promise<void> | null = null
  private repairStatus: CorePlaylistRepairStatus | null = null
  constructor(options: CorePlaylistServiceOptions) {
    this.options = options
    this.views = new CorePlaylistViews({
      ...options,
      playlist: (id, revision) => {
        if (id === CORE_RECENT_PLAYLIST_ID && options.recentHistory) {
          if (revision !== options.recentHistory.getRevision())
            throw Object.assign(new Error('播放记录已变化，请重新读取'), { code: 'STALE_REVISION' })
          return options.recentHistory.recentPlaylist()
        }
        this.fence(revision)
        const playlist = this.committed.find((p) => p.id === id)
        if (!playlist) throw new Error('歌单已不存在')
        return playlist
      }
    })
    this.controller = createPlaylistController({
      runtime: {
        ...options.runtime,
        repository: {
          load: () => options.runtime.repository.load(),
          save: async (data, revision) => {
            const saved = await options.runtime.repository.save(data, revision)
            if (
              !isVersionedDataEnvelope(saved, (value): value is Playlist[] => Array.isArray(value))
            )
              throw new Error('Playlist repository did not acknowledge its durable revision')
            const shared = this.controller.clonePlaylistSnapshot(saved.data)
            this.committed = shared
            this.revision = saved.revision
            options.changed()
            return { ...saved, data: shared }
          }
        }
      },
      playlists: this.playlists,
      tracks: this.tracks,
      trackById: this.trackById,
      getTracksRevision: () => 0,
      playlistPersistenceStatus: this.persistence,
      playlistPersistenceNotice: this.notice,
      readTrackPresence: async (ids) => {
        if (options.loadJsonLibrary) return null
        const present = new Set<string>()
        for (let offset = 0; offset < ids.length; offset += 200) {
          const page = await options.database.getTracksByIds(ids.slice(offset, offset + 200))
          for (const track of page.tracks) present.add(track.id)
        }
        return present
      },
      findRelocationsInFolder: options.findRelocationsInFolder,
      resolveImportPaths: (paths) =>
        options.loadJsonLibrary
          ? Promise.resolve(null)
          : resolveLibraryPlaylistImportPaths(paths, options.database)
    })
  }
  getRevision(): number {
    return this.revision
  }
  async favorites(revision: number, tracks: TrackData[]) {
    await this.tail.catch(() => undefined)
    this.fence(revision)
    const states = await this.options.preferencesTrackStates?.(tracks)
    this.fence(revision)
    return { revision, contains: tracks.map((track, index) => states?.[index] == null ? this.controller.isFavoriteTrack(track) : states[index] === 'favorite') }
  }
  *sourceTracks(): Iterable<TrackData> {
    for (const playlist of this.committed) {
      yield* Object.values(playlist.trackSnapshots ?? {})
      for (const entry of playlist.imported?.entries ?? []) {
        if (entry.manualBinding) yield entry.manualBinding
        if (entry.resolution.track) yield entry.resolution.track
      }
    }
  }
  /** Membership differs from the version picker's complete cached source list. */
  *librarySourceTracks(): Iterable<TrackData> {
    for (const playlist of this.committed) {
      if (playlist.imported) {
        for (const entry of playlist.imported.entries) {
          const track = entry.manualBinding ?? entry.resolution.track
          if (track) yield track
        }
      } else {
        for (const id of playlist.trackIds) {
          const track = playlist.trackSnapshots?.[id]
          if (track) yield track
        }
      }
    }
  }
  saveTrackPages(
    name: string,
    revision: number,
    produce: PlaylistTrackPageProducer,
    signal?: AbortSignal
  ): Promise<{ id: string; revision: number }> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(revision)
      const id = await this.controller.createPlaylistWithTrackPages(name, produce, signal)
      await this.flush()
      return { id, revision: this.getRevision() }
    })
  }
  editPages(
    revision: number,
    edit: CorePlaylistPageEdit,
    produce: import('../../shared/playlists.ts').PlaylistMemberPageProducer,
    signal?: AbortSignal
  ): Promise<{ revision: number; result: unknown }> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(revision)
      const c = this.controller
      const exactFavoriteIds = new Set<string>()
      const tracks: PlaylistTrackPageProducer = async (append) =>
        produce(async (items) => {
          const resolved = items.map((item) => {
            if (!item.track) throw new Error('歌单添加操作缺少曲目身份')
            return item.track
          })
          if (edit.kind === 'favorite' && edit.favorite) {
            const states = await this.options.preferencesTrackStates?.(resolved)
            resolved.forEach((track, i) => { if (states?.[i] === 'ban' || states?.[i] === 'none') exactFavoriteIds.add(track.id) })
          }
          await append(resolved)
        })
      const ids: import('../../shared/playlists.ts').PlaylistTrackIdPageProducer = async (append) =>
        produce(async (items) => append(items.map((item) => item.id)))
      let result: unknown
      switch (edit.kind) {
        case 'create':
          result = await (edit.aggregate
            ? c.createAggregatePlaylistWithTrackPages(edit.name, tracks, signal)
            : c.createPlaylistWithTrackPages(edit.name, tracks, signal))
          break
        case 'add':
          result = await (edit.external
            ? c.addTrackPagesToExternalPlaylistById(edit.id, tracks, signal)
            : c.addTrackPagesToPlaylistById(edit.id, tracks, signal))
          break
        case 'remove':
          result = await c.removeTrackIdPagesFromPlaylistById(edit.id, ids, signal)
          break
        case 'move':
          result = await c.movePlaylistMemberPagesById(edit.id, edit.targetId, produce, signal)
          break
        case 'reorder':
          result = await c.reorderPlaylistTrackIdPagesById(edit.id, ids, edit.target, signal)
          break
        case 'favorite':
          result = await c.setFavoriteTrackPages(tracks, edit.favorite, signal, exactFavoriteIds)
          break
      }
      await this.flush()
      return { revision: this.revision, result }
    })
  }
  async isFavorite(track: TrackData): Promise<boolean> {
    await this.tail.catch(() => undefined)
    const state = (await this.options.preferencesTrackStates?.([track]))?.[0]
    return state == null ? this.controller.isFavoriteTrack(track) : state === 'favorite'
  }
  toggleFavorite(track: TrackData, assertCurrent: () => void): Promise<boolean> {
    return this.enqueue(async () => {
      assertCurrent()
      const state = (await this.options.preferencesTrackStates?.([track]))?.[0]
      assertCurrent()
      const liked = !(state == null ? this.controller.isFavoriteTrack(track) : state === 'favorite')
      this.controller.setFavoriteTracks([track], liked, liked && state != null ? new Set([track.id]) : undefined)
      await this.flush()
      return liked
    })
  }
  repairSnapshot(): CorePlaylistRepairStatus | null {
    return this.repairStatus ? { ...this.repairStatus } : null
  }
  startRepair(
    id: string,
    revision: number,
    folder: string,
    signal?: AbortSignal
  ): Promise<CorePlaylistRepairStatus> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error('Playlists are shutting down')
      signal?.throwIfAborted()
      this.fence(revision)
      if (this.repairWork)
        throw Object.assign(new Error('A playlist repair is already running'), { code: 'BUSY' })
      const status: CorePlaylistRepairStatus = {
        id: this.options.runtime.newId(),
        playlistId: id,
        state: 'running',
        relocated: 0,
        unresolved: 0,
        ambiguous: 0,
        error: null
      }
      this.repairStatus = status
      this.repairWork = this.controller
        .repairPlaylistMissingTracksAsync(id, folder)
        .then(async (result) => {
          await this.flush()
          status.state = 'completed'
          status.relocated = result.relocations.length
          status.unresolved = result.unresolvedTrackIds.length
          status.ambiguous = result.ambiguousTrackIds.length
        })
        .catch((error) => {
          status.state = 'failed'
          status.error = projectCoreError(error)
        })
        .finally(() => {
          this.repairWork = null
          this.options.changed()
        })
      this.options.changed()
      return { ...status }
    })
  }
  /** Internal source-repair commit; the playback owner supplies a resolved
   * trusted identity. This is not a renderer-uploaded replacement command. */
  replaceTrackReference(
    oldTrackId: string,
    replacement: TrackData,
    revision?: number,
    signal?: AbortSignal
  ): Promise<{ revision: number; count: number }> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      if (revision !== undefined) this.fence(revision)
      const count = this.controller.replacePlaylistTrackReference(oldTrackId, replacement)
      if (count) await this.flush()
      return { revision: this.getRevision(), count }
    })
  }
  view(query: CorePlaylistViewQuery, signal?: AbortSignal): Promise<CorePlaylistViewPage> {
    return this.views.query(query, signal)
  }
  records(query: CorePlaylistViewQuery, signal?: AbortSignal) {
    return this.views.records(query, signal)
  }
  collection(query: CorePlaylistQueries['playlists.collection']['input'], signal?: AbortSignal) {
    this.fence(query.revision)
    return this.views.collection(
      this.committed.filter(playlist => (playlist.kind === 'aggregate') === !!query.aggregate),
      query, signal
    )
  }
  externalIds(): string[] {
    return this.committed.filter((p) => p.imported).map((p) => p.id)
  }
  readExternal(id: string): ImportedPlaylistData | undefined {
    return this.committed.find((p) => p.id === id)?.imported
  }
  applyImportResolutions(
    id: string,
    generation: string,
    updates: Array<{ entryId: string; revision: number; resolution: ImportResolution }>
  ): Promise<void> {
    return this.enqueue(async () => {
      this.controller.applyExternalResolutions(id, generation, updates)
      await this.flush()
    })
  }
  savePreview(preview: Playlist, command: CoreImportPreviewSave, signal?: AbortSignal) {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(command.playlistsRevision)
      const c = this.controller
      let id: string
      if (command.target) {
        const target = this.readExternal(command.target.id)
        if (target?.generation !== command.target.generation)
          throw Object.assign(new Error('歌单在预览期间被修改，请重新读取后更新'), {
            code: 'STALE_REVISION'
          })
        const imported = preview.imported!
        id = c.refreshExternalPlaylist(
          command.target.id,
          {
            name: preview.name,
            source: imported.source,
            songs: imported.entries.map((e) => e.original),
            warnings: [],
            complete: imported.complete,
            total: imported.expectedTotal
          },
          command.target.overwrite
        )
        const saved = this.playlists.value.find((p) => p.id === id)!.imported!
        const buckets = new Map<string, { entries: ImportedPlaylistEntry[]; next: number }>()
        for (const entry of imported.entries) {
          const key = importSongKey(entry.original),
            bucket = buckets.get(key)
          if (bucket) bucket.entries.push(entry)
          else buckets.set(key, { entries: [entry], next: 0 })
        }
        for (const entry of saved.entries) {
          const bucket = buckets.get(importSongKey(entry.original))
          const matched =
            bucket && bucket.next < bucket.entries.length
              ? bucket.entries[bucket.next++]
              : undefined
          if (matched?.manualBinding) c.bindExternalEntry(id, entry.entryId, matched.manualBinding)
          if (matched && (matched.manualBinding || entry.resolution.state === 'pending'))
            c.applyExternalResolution(
              id,
              saved.generation,
              entry.entryId,
              entry.revision + (matched.manualBinding ? 1 : 0),
              matched.resolution
            )
        }
      } else id = c.adoptExternalPlaylist(preview)
      await this.flush()
      return { id, revision: this.getRevision() }
    })
  }
  initialize(): Promise<void> {
    return this.enqueue(async () => {
      await this.controller.loadPlaylists()
      await this.flush()
      const auth = this.controller.getAuthoritativeSnapshot()
      this.committed = auth.length > 0 ? auth : this.controller.clonePlaylistSnapshot()
      this.revision = this.controller.getRevision()
    })
  }
  /** Public read dispatch waits for a just-published preference refresh before using cached pages. */
  async waitForPending(): Promise<void> { await this.tail }
  /** A preference/identity transaction can change the default list outside a playlist gesture. */
  refreshPreferences(): Promise<void> {
    return this.enqueue(async () => {
      await this.flush()
      await this.controller.loadPlaylists()
      const auth = this.controller.getAuthoritativeSnapshot()
      this.committed = auth.length > 0 ? auth : this.controller.clonePlaylistSnapshot()
      this.revision = this.controller.getRevision()
      this.options.changed()
    })
  }
  private fence(revision: number): void {
    if (revision !== this.getRevision())
      throw Object.assign(new Error('Playlists changed; read a fresh page'), {
        code: 'STALE_REVISION'
      })
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Playlists are shutting down'))
    const work = this.tail.catch(() => undefined).then(action)
    this.tail = work
    return work
  }
  list(offset = 0, limit = 200, revision?: number): CorePlaylistPage {
    if (revision !== undefined) this.fence(revision)
    return {
      revision: this.getRevision(),
      total: this.committed.length,
      offset,
      items: this.committed.slice(offset, offset + limit).map(summary)
    }
  }
  catalog(offset = 0, limit = 200, revision?: number): CorePlaylistCatalogPage {
    if (revision !== undefined) this.fence(revision)
    return {
      revision: this.revision,
      total: this.committed.length,
      offset,
      items: this.committed.slice(offset, offset + limit).map(descriptor)
    }
  }
  state(): CorePlaylistState {
    return structuredClone({
      revision: this.revision,
      persistence: this.persistence.value,
      notice: this.notice.value,
      repair: this.repairSnapshot()
    })
  }
  membership(id: string, revision: number, ids: string[]) {
    this.fence(revision)
    const playlist = this.committed.find((playlist) => playlist.id === id)
    if (!playlist) throw new Error('歌单已不存在')
    const members = new Set(
      playlist.imported
        ? playlist.imported.entries.map((entry) => entry.entryId)
        : playlist.trackIds
    )
    return { revision, contains: ids.map((id) => members.has(id)) }
  }
  async members(
    query: CorePlaylistQueries['playlists.members']['input']
  ): Promise<CorePlaylistMembersPage> {
    this.fence(query.revision)
    const playlist = this.committed.find((playlist) => playlist.id === query.id)
    if (!playlist) throw new Error('歌单已不存在')
    const limit = query.limit ?? 200
    let offset = query.offset ?? 0
    if (!playlist.imported) {
      const anchorIndex =
        query.anchorId === undefined ? undefined : playlist.trackIds.indexOf(query.anchorId)
      if (anchorIndex !== undefined && anchorIndex >= 0)
        offset = Math.floor(anchorIndex / limit) * limit
      const page = await this.entries(query.id, query.revision, offset, limit)
      return {
        ...page,
        anchorIndex,
        items: page.items.map((entry, index) => ({ ...entry, position: offset + index }))
      }
    }
    const search = query.search?.trim().toLocaleLowerCase()
    const entries = playlist.imported.entries.filter(
      (entry) =>
        !search ||
        [entry.original.title, entry.original.artist, entry.original.album].some((value) =>
          value?.toLocaleLowerCase().includes(search)
        )
    )
    const sort = query.sort ?? 'playlist'
    if (sort !== 'playlist')
      entries.sort((a, b) =>
        sort === 'duration'
          ? (a.original.duration ?? 0) - (b.original.duration ?? 0)
          : String(a.original[sort] ?? '').localeCompare(String(b.original[sort] ?? ''), 'zh')
      )
    const anchorIndex =
      query.anchorId === undefined
        ? undefined
        : entries.findIndex((entry) => entry.entryId === query.anchorId)
    if (anchorIndex !== undefined && anchorIndex >= 0)
      offset = Math.floor(anchorIndex / limit) * limit
    return {
      revision: query.revision,
      offset,
      total: entries.length,
      anchorIndex,
      items: entries.slice(offset, offset + limit).map((entry) => {
        const { locations: _locations, ...original } = entry.original
        const track = entry.resolution.track
          ? projectCoreTrack(entry.resolution.track, entry.entryId)
          : undefined
        return {
          id: entry.entryId,
          position: entry.position,
          track: track ?? null,
          imported: {
            entryId: entry.entryId,
            position: entry.position,
            revision: entry.revision,
            original,
            resolution: {
              ...entry.resolution,
              track,
              message: entry.resolution.message
                ? projectCoreError(entry.resolution.message)
                : undefined
            },
            manual: !!entry.manualBinding
          }
        }
      })
    }
  }
  async exportDocument(
    id: string,
    revision: number,
    format: PlaylistFileFormat,
    signal?: AbortSignal
  ) {
    this.fence(revision)
    const writer = createPlaylistDocumentWriter(format)
    const versionsRevision = this.options.versions.getRevision()
    let offset = 0,
      total = 1,
      contentRevision: number | undefined
    do {
      const { page } = await this.views.records(
        { id, revision, versionsRevision, contentRevision, offset, limit: 200 },
        signal
      )
      contentRevision = page.revision
      for (const record of page.tracks) writer.append(libraryTrack(record))
      offset += page.tracks.length
      total = page.total
    } while (offset < total)
    this.fence(revision)
    if (this.options.versions.getRevision() !== versionsRevision)
      throw Object.assign(new Error('录音版本偏好已变化，请重新导出'), { code: 'STALE_REVISION' })
    return { revision, contents: writer.finish() }
  }
  importDocument(
    id: string,
    revision: number,
    fileName: string,
    contents: string,
    signal?: AbortSignal
  ) {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(revision)
      const playlist = this.committed.find((playlist) => playlist.id === id)
      if (!playlist) throw new Error('歌单已不存在')
      const result = await this.controller.importPlaylistDocumentAsync(
        playlist.name,
        fileName,
        contents
      )
      await this.flush()
      return { revision: this.revision, result }
    })
  }
  searchLocal(query: string, limit: number, offset: number) {
    const page = searchLocalStreamingPlaylists(
      this.committed.filter((playlist) => playlist.kind !== 'aggregate'),
      query,
      limit,
      offset
    )
    return { items: page.playlists, total: page.total, revision: this.getRevision() }
  }
  async entries(
    id: string,
    revision: number,
    offset = 0,
    limit = 200
  ): Promise<CorePlaylistEntries> {
    this.fence(revision)
    const playlist = this.committed.find((item) => item.id === id)
    if (!playlist) throw new Error('歌单已不存在')
    const configured = playlist.imported
      ? playlist.imported.entries.slice(offset, offset + limit).map((entry) => ({
          id: entry.entryId,
          track: (entry.resolution.track as TrackData) ?? null
        }))
      : playlist.trackIds
          .slice(offset, offset + limit)
          .map((id) => ({ id, track: playlist.trackSnapshots?.[id] ?? null }))
    if (!playlist.imported) {
      const ids = configured.map((item) => item.id)
      const local = this.options.loadJsonLibrary
        ? new Map(
            (await this.options.loadJsonLibrary()).tracks.map((track) => [track.id, track] as const)
          )
        : new Map(
            (ids.length
              ? await this.options.database.getTracksByIds(ids)
              : { tracks: [] }
            ).tracks.map((record) => [record.id, libraryTrack(record)] as const)
          )
      for (const entry of configured) entry.track = local.get(entry.id) ?? entry.track
    }
    this.fence(revision)
    return structuredClone({
      revision,
      offset,
      total: playlist.imported?.entries.length ?? playlist.trackIds.length,
      items: configured.map((entry) => ({
        id: entry.id,
        track: entry.track
          ? projectCoreTrack(entry.track, playlist.imported ? entry.id : undefined)
          : null
      }))
    })
  }
  edit(revision: number, edit: CorePlaylistEdit, signal?: AbortSignal): Promise<unknown> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      this.fence(revision)
      const c = this.controller
      let result: unknown
      switch (edit.kind) {
        case 'importCreate':
          result = c.createExternalPlaylist(edit.document)
          break
        case 'importRefresh':
          result = c.refreshExternalPlaylist(edit.id, edit.document, edit.overwrite)
          break
        case 'importBind':
          result = c.bindExternalEntry(edit.id, edit.entryId, edit.track)
          break
        case 'importRemove':
          result = c.removeExternalEntries(edit.id, edit.entryIds)
          break
        case 'create':
          result = edit.aggregate
            ? c.createAggregatePlaylist(edit.name)
            : c.createPlaylist(edit.name)
          break
        case 'rename':
          result = c.renamePlaylist(edit.id, edit.name)
          break
        case 'copy':
          result = c.copyPlaylist(edit.id, edit.name)
          break
        case 'delete':
          result = c.deletePlaylist(edit.id)
          break
        case 'cover':
          result = c.setPlaylistCover(edit.id, edit.cover)
          break
        case 'pin':
          result = c.setPlaylistPinned(edit.id, edit.pinned)
          break
        case 'hiddenSources':
          result = c.setPlaylistHiddenSources(edit.id, edit.sources)
          break
        case 'variant':
          result = c.setPlaylistVariantPreference(edit.id, edit.anchorId, edit.source)
          break
        case 'add':
          result = c.addTracksToPlaylistById(edit.id, edit.tracks)
          break
        case 'remove':
          result = await c.removeTrackIdPagesFromPlaylistById(
            edit.id,
            async (append) => {
              await append(edit.ids)
            },
            signal
          )
          break
        case 'reorder':
          result = await c.reorderPlaylistTrackIdPagesById(
            edit.id,
            async (append) => {
              await append(edit.ids)
            },
            edit.target,
            signal
          )
          break
        case 'move':
          result = await c.movePlaylistTrackIdPagesById(
            edit.id,
            edit.targetId,
            async (append) => {
              await append(edit.ids)
            },
            signal
          )
          break
        case 'favorite':
          {
            const states = await this.options.preferencesTrackStates?.(edit.tracks)
            const exact = states ? new Set(edit.tracks.filter((_, i) => states[i] === 'ban' || states[i] === 'none').map(t => t.id)) : undefined
            result = c.setFavoriteTracks(edit.tracks, edit.favorite, exact)
          }
          break
      }
      await this.flush()
      this.options.changed()
      return { revision: this.getRevision(), result }
    })
  }
  importFromPlugin(request: PluginPlaylistImportNotice): Promise<PlaylistImportApplyResult[]> {
    return this.enqueue(async () => {
      if (this.options.loadJsonLibrary) {
        this.tracks.value = (await this.options.loadJsonLibrary()).tracks
        this.trackById.clear()
        for (const track of this.tracks.value) this.trackById.set(track.id, track)
      }
      try {
        const result = await this.controller.importPlaylistPathBatchAsync(request.playlists)
        await this.flush()
        this.options.changed()
        return result
      } finally {
        this.tracks.value = []
        this.trackById.clear()
      }
    })
  }
  async flush(): Promise<void> {
    if (!(await this.controller.flushPlaylists()))
      throw new Error(this.persistence.value.lastError ?? 'Playlists could not be saved')
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.repairWork
    await this.views.shutdown()
    await this.tail.catch(() => undefined)
    try {
      await this.flush()
    } finally {
      this.controller.dispose()
    }
  }
}
function summary(playlist: Playlist): CorePlaylistSummary {
  return {
    id: playlist.id,
    name: playlist.name,
    kind: playlist.kind,
    isDefault: playlist.isDefault,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    pinnedAt: playlist.pinnedAt,
    count: playlist.imported?.entries.length ?? playlist.trackIds.length,
    imported: !!playlist.imported
  }
}
function descriptor(playlist: Playlist): CorePlaylistDescriptor {
  const { imported: _imported, ...row } = summary(playlist)
  const imported = playlist.imported
  if (!imported)
    return { ...row, cover: playlist.cover, hiddenSources: playlist.hiddenSources?.slice() }
  const { entries: _entries, ...metadata } = imported
  const counts: NonNullable<CorePlaylistDescriptor['imported']>['counts'] = {}
  for (const entry of imported.entries)
    counts[entry.resolution.state] = (counts[entry.resolution.state] ?? 0) + 1
  return {
    ...row,
    cover: playlist.cover,
    hiddenSources: playlist.hiddenSources?.slice(),
    imported: structuredClone({ ...metadata, counts })
  }
}
