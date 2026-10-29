import { randomUUID } from '../../shared/portableCrypto.ts'
import type { CoreApplication } from '../application.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type {
  CoreCommands,
  CoreQueries,
  CoreRequestEnvelope,
  CoreSnapshot,
  CoreClientMessage
} from '../../shared/coreProtocol.ts'
import type { CorePlaylistViewQuery, CorePlaylistViewPage } from '../../shared/corePlaylists.ts'
import type { LibraryPage, LibraryQuery, LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { CoreTrackView } from '../../shared/coreViews.ts'
import type { CoreLyricsContent } from '../../shared/coreLyrics.ts'
import type { TrackData } from '../../shared/track.ts'
import {
  createEmptyRemotePlaybackSnapshot,
  type PlayerRemoteCommand,
  type RemoteBrowseItem,
  type RemoteBrowseRequest,
  type RemoteBrowseResult
} from '../../shared/remoteControl.ts'
import { RemoteCommandError, type RemoteHttpServer } from '../cast/httpServer.ts'
import { RemoteCoreBridge } from './coreBridge.ts'
import type { RemoteMediaResolver } from './media.ts'
import type { RemoteCoreRpcContext, RemoteProviderSession } from '../../shared/remoteCoreBridge.ts'

export interface CoreRemoteOptions {
  server: RemoteHttpServer
  settings: Pick<CoreSettingsRepository, 'read' | 'update'>
  playback: Pick<CorePlaybackSession, 'fromPages' | 'edit' | 'snapshot'>
  playlistRecords(
    query: CorePlaylistViewQuery,
    signal?: AbortSignal
  ): Promise<Omit<CorePlaylistViewPage, 'page'> & { page: LibraryPage }>
  castActive(): boolean
  resolveCover(handle: string | null): Promise<string | null>
  failed(error: unknown): void
  now(): number
  media?: RemoteMediaResolver
  providerSession?(): Promise<RemoteProviderSession>
  resolveTrackLyrics?(
    track: TrackData,
    options?: { allowOnlineFallback?: boolean; signal?: AbortSignal }
  ): Promise<CoreLyricsContent>
}
type TrackToken =
  | { kind: 'library'; id: string; query: LibraryQuery }
  | { kind: 'playlist'; id: string; occurrence: string; query: CorePlaylistViewQuery }
type Token = TrackToken | { kind: 'playlist-list'; id: string }
const browseTrack = (token: string, track: CoreTrackView, index?: number): RemoteBrowseItem => ({
  id: token,
  title: track.title,
  artist: track.artist,
  album: track.album,
  duration: track.duration,
  ...(index === undefined ? {} : { index })
})
const seed = (track: LibraryTrackRecord) => ({
  id: track.id,
  ...(track.source === 'local' ? { localSnapshot: track } : { snapshot: track })
})

/** The existing authenticated HTTP surface is a bounded Core client, not a renderer relay. */
export class CoreRemoteService {
  private readonly options: CoreRemoteOptions
  private application: Pick<CoreApplication, 'connect' | 'disconnect' | 'request'> | null = null
  private readonly clientId = `remote:${randomUUID()}`
  private current: CoreSnapshot | null = null
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >()
  private readonly tokens = new Map<string, Token>()
  private readonly commands = new Set<Promise<unknown>>()
  private readonly bridge: RemoteCoreBridge
  private readonly controller = new AbortController()
  private syncKey = ''
  private syncWork: Promise<unknown> = Promise.resolve()
  private coverRevision: number | null | undefined
  private cover: string | null = null
  private coverGeneration = 0
  private stopped = false
  constructor(options: CoreRemoteOptions) {
    this.options = options
    this.bridge = new RemoteCoreBridge({
      snapshot: () => this.current,
      request: this.request.bind(this),
      playback: options.playback,
      resolveCover: options.resolveCover,
      signal: this.controller.signal,
      failed: options.failed,
      media: options.media,
      providerSession: options.providerSession,
      resolveTrackLyrics: options.resolveTrackLyrics
    })
    options.server.setCommandHandler((command) => this.command(command))
    options.server.setBrowseHandler((request) => this.browse(request))
    options.server.setCoreRpcHandler?.((envelope, principal, context) => this.handleCoreRpc(envelope, principal, context))
  }
  attach(application: Pick<CoreApplication, 'connect' | 'disconnect' | 'request'>): void {
    if (this.application) throw new Error('Remote Core client already attached')
    this.application = application
    application.connect(
      {
        id: this.clientId,
        role: 'remote',
        permissions: ['playback:read', 'playback:write', 'library:read']
      },
      (message) => this.receive(message)
    )
  }
  private receive(message: CoreClientMessage): void {
    if (message.kind === 'response') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      if (message.ok) pending.resolve(message.value)
      else
        pending.reject(
          Object.assign(new Error(message.error.message), { code: message.error.code })
        )
      return
    }
    if (message.kind !== 'state') return
    this.current = message.snapshot
    this.publish()
    if (message.snapshot.phase === 'ready') {
      void this.sync().catch(this.options.failed)
      if (this.coverRevision !== message.snapshot.presentationRevision) {
        this.coverRevision = message.snapshot.presentationRevision
        const generation = ++this.coverGeneration
        void this.request('query', 'player.presentation', {})
          .then(async (value) => {
            const cover = await this.options.resolveCover(value.cover)
            if (generation !== this.coverGeneration || this.stopped) return
            this.cover = cover
            this.publish()
          })
          .catch(this.options.failed)
      }
    }
  }
  private request<K extends keyof CoreQueries>(
    kind: 'query',
    name: K,
    payload: CoreQueries[K]['input'],
    epoch?: string
  ): Promise<CoreQueries[K]['output']>
  private request<K extends keyof CoreCommands>(
    kind: 'command',
    name: K,
    payload: CoreCommands[K],
    epoch?: string
  ): Promise<unknown>
  private request(
    kind: 'query' | 'command',
    name: string,
    payload: unknown,
    epoch?: string
  ): Promise<never> {
    if (!this.application || !this.current || this.stopped)
      return Promise.reject(new RemoteCommandError('core_not_ready'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })
      void this.application!.request(this.clientId, {
        kind,
        name,
        payload,
        requestId,
        epoch: epoch ?? this.current!.epoch
      } as CoreRequestEnvelope).catch((error) => {
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }
  private ready(): CoreSnapshot {
    if (this.stopped || this.current?.phase !== 'ready')
      throw new RemoteCommandError('core_not_ready')
    return this.current
  }
  private token(value: Token): string {
    const id = randomUUID()
    this.tokens.set(id, value)
    if (this.tokens.size > 2048) this.tokens.delete(this.tokens.keys().next().value!)
    return id
  }
  private publish(): void {
    const state = this.current,
      playback = state?.playback,
      track = state?.track
    if (!state) return
    const mode = playback?.playMode
    const wirePlayMode =
      mode === 'repeat'
        ? 'single'
        : mode === 'listLoop'
          ? 'loop'
          : mode === 'shuffle'
            ? 'shuffle'
            : 'sequence'
    this.options.server.updatePlaybackSnapshot(
      createEmptyRemotePlaybackSnapshot({
        state: playback?.state === 'playing' ? 'playing' : track ? 'paused' : 'stopped',
        title: track?.title ?? '',
        artist: track?.artist ?? '',
        album: track?.album ?? '',
        position: playback?.position ?? 0,
        duration: playback?.duration ?? track?.duration ?? 0,
        volume: playback?.volume ?? 1,
        muted: state.mute?.muted ?? false,
        queueIndex: state.queue?.index ?? -1,
        queueLength: state.queue?.total ?? 0,
        queueRevision: state.queue?.revision ?? 0,
        coverUrl: this.cover,
        castTarget: state.cast?.target?.name ?? null,
        isLive: track?.source === 'radio' || (!!track && track.duration <= 0),
        playMode: wirePlayMode,
        updatedAt: this.options.now()
      })
    )
    this.options.server.updateCoreStateEvent?.({
      kind: 'state',
      epoch: state.epoch,
      sequence: state.sequence,
      snapshot: this.projectCoreSnapshotForBridge(state)
    })
  }
  private projectCoreSnapshotForBridge(state: CoreSnapshot): Record<string, unknown> {
    return this.bridge.projectSnapshot(state)
  }
  status() {
    return this.options.server.getStatus()
  }
  sync(force = false): Promise<void> {
    if (this.stopped || this.current?.phase !== 'ready') return Promise.resolve()
    const settings = this.options.settings.read()
    const key = `${settings.remoteControlEnabled}:${settings.remoteControlPort}`
    if (!force && key === this.syncKey)
      return this.syncWork.then(
        () => {},
        () => {}
      )
    this.syncKey = key
    const work = this.syncWork
      .catch(() => {})
      .then(async () => {
        if (this.stopped) return
        if (settings.remoteControlEnabled) {
          // Refresh cached SSE references after a disabled bridge has been cleared.
          this.publish()
          await this.options.server.start(settings.remoteControlPort, { mode: 'full' })
        } else {
          this.tokens.clear()
          this.bridge.clear()
          if (this.options.castActive())
            await this.options.server.start(settings.remoteControlPort, { mode: 'mediaOnly' })
          else await this.options.server.stop()
        }
      })
    this.syncWork = work
    return work
  }
  async setEnabled(enabled: boolean) {
    this.options.settings.update({ remoteControlEnabled: enabled })
    await this.sync(true)
    return this.status()
  }
  rotatePin() {
    this.tokens.clear()
    this.bridge.clear()
    const pin = this.options.server.rotatePin()
    this.publish()
    return { pin, status: this.status() }
  }
  decidePairing(requestId: string, allow: boolean) { return this.options.server.decidePairing(requestId, allow) }
  revokeDevice(id: string) { return this.options.server.revokeDevice(id) }
  async browse(request: RemoteBrowseRequest): Promise<RemoteBrowseResult> {
    const state = this.ready()
    const { offset, limit, query } = request
    if (request.view === 'queue') {
      const queue = state.queue
      if (!queue) return { items: [], total: 0, offset, limit, revision: 0 }
      const page = await this.request('query', 'queue.page', {
        id: queue.id,
        revision: queue.revision,
        offset,
        limit,
        search: query
      })
      return {
        items: page.items
          .filter((item) => item.track)
          .map((item) => browseTrack(item.queueEntryId, item.track!, item.position)),
        total: page.total,
        offset: page.offset,
        limit,
        revision: page.revision
      }
    }
    if (request.view === 'playlists' && !request.playlistId) {
      const page = await this.request('query', 'playlists.catalog', { offset, limit })
      return {
        items: page.items.map((row) => ({
          id: this.token({ kind: 'playlist-list', id: row.id }),
          title: row.name,
          artist: '',
          album: '',
          duration: 0,
          trackCount: row.count
        })),
        total: page.total,
        offset: page.offset,
        limit,
        revision: page.revision
      }
    }
    if (request.view === 'playlists') {
      const playlist = this.tokens.get(request.playlistId!)
      if (playlist?.kind !== 'playlist-list')
        throw new RemoteCommandError('playlist_not_found', 404)
      const read: CorePlaylistViewQuery = {
        id: playlist.id,
        revision: state.playlistsRevision!,
        versionsRevision: state.versionsRevision!,
        offset,
        limit,
        search: query
      }
      const result = await this.request('query', 'playlists.view', read),
        page = result.page
      return {
        items: page.tracks.map((track) =>
          browseTrack(
            this.token({
              kind: 'playlist',
              id: track.id,
              occurrence:
                page.entryIds?.[page.tracks.indexOf(track)] ?? track.queueEntryId ?? track.id,
              query: { ...read, offset: 0, limit: 200 }
            }),
            track
          )
        ),
        total: page.total,
        offset: page.offset,
        limit,
        revision: result.revision
      }
    }
    const read: LibraryQuery = {
      search: query,
      searchLiteral: true,
      sort: 'insertion',
      direction: 'asc'
    }
    const page = await this.request('query', 'library.tracks', { ...read, offset, limit })
    return {
      items: page.tracks.map((track) =>
        browseTrack(this.token({ kind: 'library', id: track.id, query: read }), track)
      ),
      total: page.total,
      offset: page.offset,
      limit,
      revision: page.revision
    }
  }
  command(command: PlayerRemoteCommand): Promise<void> {
    const work = this.dispatchCommand(command)
    this.commands.add(work)
    void work.then(
      () => this.commands.delete(work),
      () => this.commands.delete(work)
    )
    return work
  }
  private async dispatchCommand(command: PlayerRemoteCommand): Promise<void> {
    const state = this.ready()
    try {
      switch (command.action) {
        case 'playPause':
          await this.request('command', 'playback.control', { type: 'toggle-play' })
          return
        case 'play':
          await this.request('command', 'playback.play', {})
          return
        case 'pause':
          await this.request('command', 'playback.pause', {})
          return
        case 'next':
          await this.request('command', 'playback.next', {})
          return
        case 'previous':
          await this.request('command', 'playback.previous', {})
          return
        case 'seek':
          await this.request('command', 'playback.seek', { position: command.positionSeconds })
          return
        case 'setVolume':
          await this.request('command', 'playback.volume', { volume: command.volume })
          return
        case 'setPlayMode':
          await this.request('command', 'playback.mode', {
            mode:
              command.mode === 'single'
                ? 'repeat'
                : command.mode === 'loop'
                  ? 'listLoop'
                  : command.mode === 'shuffle'
                    ? 'shuffle'
                    : 'sequential'
          })
          return
        case 'jumpQueue':
        case 'removeQueue': {
          const queue = state.queue
          if (!queue || queue.revision !== command.revision)
            throw new RemoteCommandError('queue_changed', 409)
          const page = await this.request('query', 'queue.page', {
            id: queue.id,
            revision: queue.revision,
            offset: command.index,
            limit: 1
          })
          const item = page.items[0]
          if (!item || item.position !== command.index)
            throw new RemoteCommandError('queue_item_not_found', 404)
          if (command.action === 'jumpQueue')
            await this.request('command', 'queue.select', {
              id: queue.id,
              revision: queue.revision,
              index: item.position,
              occurrenceId: item.queueEntryId
            })
          else
            await this.request('command', 'queue.edit', {
              id: queue.id,
              revision: queue.revision,
              edit: { kind: 'remove', entryIds: [item.queueEntryId] }
            })
          return
        }
        case 'playTrack':
        case 'enqueueTrack': {
          const token = this.tokens.get(command.id)
          if (!token || token.kind === 'playlist-list')
            throw new RemoteCommandError('track_not_found', 404)
          if (token.kind === 'library') {
            if (command.action === 'playTrack') {
              await this.request('command', 'queue.fromQuery', {
                query: token.query,
                selectedId: token.id
              })
              return
            }
            const queue = state.queue
            if (queue)
              await this.request('command', 'queue.insert', {
                id: queue.id,
                revision: queue.revision,
                items: [{ kind: 'local', id: token.id }]
              })
            else {
              const page = await this.request('query', 'library.byIds', { ids: [token.id] })
              if (!page.tracks.length) throw new RemoteCommandError('track_not_found', 404)
              await this.request('command', 'queue.fromQuery', {
                query: { ids: [token.id] },
                selectedId: token.id,
                play: false
              })
            }
            return
          }
          const signal = this.controller.signal
          if (command.action === 'enqueueTrack') {
            const page = (
              await this.options.playlistRecords(
                { ...token.query, anchorId: token.occurrence },
                signal
              )
            ).page
            const track = page.tracks.find(
              (track, index) =>
                (page.entryIds?.[index] ?? track.queueEntryId ?? track.id) === token.occurrence
            )
            if (!track) throw new RemoteCommandError('track_not_found', 404)
            const queue = state.queue
            if (queue)
              await this.options.playback.edit(queue.id, queue.revision, {
                kind: 'insert',
                items: [{ id: track.id, snapshot: track }]
              })
            else
              await this.options.playback.fromPages(
                async (append) => {
                  await append([seed(track)])
                },
                { play: false },
                signal
              )
            return
          }
          let selected = -1,
            count = 0
          await this.options.playback.fromPages(
            async (append) => {
              let offset = 0,
                revision: number | undefined
              for (;;) {
                const page = (
                  await this.options.playlistRecords(
                    { ...token.query, offset, limit: 200, contentRevision: revision },
                    signal
                  )
                ).page
                revision ??= page.revision
                const rows = page.tracks
                for (let i = 0; i < rows.length; i++)
                  if (
                    (page.entryIds?.[i] ?? rows[i].queueEntryId ?? rows[i].id) === token.occurrence
                  )
                    selected = count + i
                await append(rows.map(seed))
                count += rows.length
                offset += rows.length
                if (!rows.length || offset >= page.total) break
              }
              if (selected < 0) throw new RemoteCommandError('track_not_found', 404)
            },
            {
              selectedIndex: () => selected,
              guard: () => {
                const latest = this.ready()
                if (
                  latest.playlistsRevision !== token.query.revision ||
                  latest.versionsRevision !== token.query.versionsRevision
                )
                  throw new RemoteCommandError('playlist_changed', 409)
              }
            },
            signal
          )
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'STALE_REVISION')
        throw new RemoteCommandError('queue_changed', 409)
      throw error
    }
  }
  handleCoreRpc(raw: Record<string, unknown>, principal?: string, context?: RemoteCoreRpcContext): Promise<Record<string, unknown>> {
    const work = this.bridge.handle(raw, principal, context)
    this.commands.add(work)
    void work.then(
      () => this.commands.delete(work),
      () => this.commands.delete(work)
    )
    return work
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.coverGeneration++
    this.controller.abort(new Error('Core remote shutting down'))
    this.options.server.setCommandHandler(null)
    this.options.server.setBrowseHandler(null)
    this.options.server.setCoreRpcHandler?.(null)
    this.application?.disconnect(this.clientId)
    for (const pending of this.pending.values())
      pending.reject(new RemoteCommandError('core_not_ready'))
    this.pending.clear()
    this.tokens.clear()
    this.bridge.clear()
    await Promise.allSettled([...this.commands])
    await this.syncWork.catch(() => {})
    await this.options.server.stop()
  }
}
