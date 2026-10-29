import { randomUUID } from '../../shared/portableCrypto.ts'
import {
  isCoreRequest,
  type CoreCommands,
  type CoreQueries,
  type CoreSnapshot
} from '../../shared/coreProtocol.ts'
import { CORE_PLAYBACK_FIELDS, type CoreTrackView } from '../../shared/coreViews.ts'
import type { CoreLyricsContent } from '../../shared/coreLyrics.ts'
import type { EntityMetadataDetail } from '../../shared/entityMetadata.ts'
import { buildLyricLines } from '../../shared/lyrics/lyricLineBuilder.ts'
import type { CatalogTrackReferences } from '../../shared/musicCatalog.ts'
import type { MusicArtwork } from '../../shared/musicArtwork.ts'
import {
  REMOTE_CORE_ARTWORK_LIMIT,
  REMOTE_CORE_COMMANDS,
  REMOTE_CORE_LOCAL_ZONE,
  REMOTE_CORE_PAGE_LIMIT,
  REMOTE_CORE_PROTOCOL_RANGE,
  REMOTE_CORE_QUERIES,
  type RemoteCoreRpcContext,
  type RemoteProviderSession
} from '../../shared/remoteCoreBridge.ts'
import { REMOTE_STREAM_FORMATS } from '../../shared/remoteMedia.ts'
import type { TrackData } from '../../shared/track.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type { RemoteMediaResolver } from './media.ts'

interface CoreRequest {
  <K extends keyof CoreQueries>(
    kind: 'query',
    name: K,
    payload: CoreQueries[K]['input'],
    epoch?: string
  ): Promise<CoreQueries[K]['output']>
  <K extends keyof CoreCommands>(
    kind: 'command',
    name: K,
    payload: CoreCommands[K],
    epoch?: string
  ): Promise<unknown>
}
interface Options {
  snapshot(): CoreSnapshot | null
  request: CoreRequest
  playback: Pick<CorePlaybackSession, 'fromPages'>
  resolveCover(handle: string | null): Promise<string | null>
  signal: AbortSignal
  failed(error: unknown): void
  media?: RemoteMediaResolver
  providerSession?(): Promise<RemoteProviderSession>
  resolveTrackLyrics?(
    track: TrackData,
    options?: { allowOnlineFallback?: boolean; signal?: AbortSignal }
  ): Promise<CoreLyricsContent>
}

export interface RemoteLyricsLineView {
  timeMs: number
  text: string
  translation?: string
}

export interface RemoteLyricsView {
  trackId: string
  source: string
  synced: boolean
  lines: RemoteLyricsLineView[]
}

export function projectRemoteLyricsView(
  trackId: string,
  content: CoreLyricsContent | null | undefined
): RemoteLyricsView {
  const effective = content?.effective
  const original = typeof effective?.original === 'string' ? effective.original.trim() : ''
  const translation = typeof effective?.translation === 'string' ? effective.translation.trim() : ''
  if (!original && !translation) {
    return { trackId, source: 'none', synced: false, lines: [] }
  }
  const built = buildLyricLines(
    original || null,
    translation || null,
    effective?.romanization ?? null
  ).filter((line) => line.text.trim().length > 0 || (line.translation?.trim().length ?? 0) > 0)
  if (built.length === 0) {
    return { trackId, source: 'none', synced: false, lines: [] }
  }
  const synced = built.some((line) => line.timed && line.time != null)
  const offsetMs = Math.round((content?.offsetSeconds ?? 0) * 1000)
  const rawSource = effective?.originalSource ?? effective?.translationSource ?? 'embedded'
  const source = rawSource === 'manual' ? 'imported' : rawSource
  const lines: RemoteLyricsLineView[] = built.map((line, index) => {
    const timeMs =
      synced && line.time != null ? Math.max(0, Math.round(line.time * 1000) + offsetMs) : index * 4000
    const trimmedTranslation = line.translation?.trim()
    return {
      timeMs,
      text: line.text,
      ...(trimmedTranslation ? { translation: trimmedTranslation } : {})
    }
  })
  return { trackId, source, synced, lines }
}
interface Envelope {
  requestId: string
  commandId?: string
  epoch: string
  expectedRevision?: number | null
  kind: 'query' | 'command'
  name: string
  payload: Record<string, unknown>
}
interface TrackReference {
  id: string
  provider: string
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const only = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key))
const error = (code: string, message: string) => Object.assign(new Error(message), { code })
const invalid = () => error('INVALID_REQUEST', '远程请求参数无效')
const messages: Record<string, string> = {
  NOT_READY: '桌面 Core 尚未就绪',
  STALE_EPOCH: '桌面 Core 已重启，请重新读取状态',
  STALE_REVISION: '队列或曲库已变化，请刷新后重新选择',
  FORBIDDEN: '此远程连接没有该操作权限',
  INVALID_REQUEST: '远程请求参数无效',
  BUSY: '桌面正在处理其他请求，请稍后重试',
  CANCELLED: '操作已取消',
  OUTCOME_UNKNOWN: '此操作已提交，请读取最新状态，不要自动重放',
  NOT_FOUND: '曲目或资料已不存在，请刷新后重新选择',
  PERMISSION_EXPIRED: '音源访问权限已失效',
  UNSUPPORTED_CAPABILITY: '此远程连接暂不支持该音源或操作',
  SOURCE_CHANGED: '电脑上的音频文件已更换，请重新选择歌曲',
  UNSUPPORTED_PROTOCOL: '手机与电脑的远程协议版本不兼容，请将两端更新到最新版本',
  WRONG_TARGET: '此请求是发给另一台电脑的，请重新选择电脑',
  UNKNOWN_ZONE: '这台电脑没有所选的播放区域',
  FAILED: '桌面操作失败，请检查桌面状态'
}

/** Network adaptation only. Queue ownership, source lookup and metadata policy stay in Core. */
export class RemoteCoreBridge {
  private readonly options: Options
  private epoch: string | null = null
  private readonly references = new Map<string, TrackReference>()
  private readonly referenceIds = new Map<string, string>()
  private readonly seenCommands = new Set<string>()
  private active = 0

  constructor(options: Options) {
    this.options = options
  }

  clear(): void {
    this.references.clear()
    this.referenceIds.clear()
    this.seenCommands.clear()
  }

  private observe(state: CoreSnapshot): void {
    if (this.epoch === state.epoch) return
    this.clear()
    this.epoch = state.epoch
  }

  private ready(epoch?: string): CoreSnapshot {
    const state = this.options.snapshot()
    if (this.options.signal.aborted || !state || state.phase !== 'ready')
      throw error('NOT_READY', messages.NOT_READY)
    this.observe(state)
    if (epoch !== undefined && epoch !== state.epoch)
      throw error('STALE_EPOCH', messages.STALE_EPOCH)
    return state
  }

  private reference(track: Pick<CoreTrackView, 'id' | 'source'>): string {
    const provider = track.source || 'local'
    const key = JSON.stringify([provider, track.id])
    const existing = this.referenceIds.get(key)
    if (existing) return existing
    const id = `remote-track:${randomUUID()}`
    this.references.set(id, { id: track.id, provider })
    this.referenceIds.set(key, id)
    if (this.references.size > 4096) {
      const oldest = this.references.keys().next().value!
      const value = this.references.get(oldest)!
      this.references.delete(oldest)
      this.referenceIds.delete(JSON.stringify([value.provider, value.id]))
    }
    return id
  }

  /** Legacy Track IDs can be host paths. Compatibility IDs are bounded session references;
   * catalog entity/source IDs remain the durable references for new library clients. */
  private track(
    track: CoreTrackView,
    catalog?: CatalogTrackReferences | null,
    withReference = true
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ...(withReference ? { id: this.reference(track), referenceScope: 'session' } : {}),
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      artists: (track.artists ?? []).map((artist) => artist.name),
      source: /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(track.source ?? '') ? track.source : undefined,
      ncmSongId: track.ncmSongId == null ? undefined : String(track.ncmSongId),
      queueEntryId: track.queueEntryId,
      ...(catalog ? { catalog } : {})
    }
    for (const key of [
      'size',
      'format',
      'sampleRate',
      'bitrate',
      'bitDepth',
      'discNumber',
      'trackNumber',
      'releaseDate',
      'albumArtist',
      'addedAt',
      'bpm',
      'isrc'
    ] as const)
      if (track[key] != null) result[key] = track[key]
    if (track.genre != null) result.genre = track.genre
    return result
  }

  projectSnapshot(state: CoreSnapshot): Record<string, unknown> {
    this.observe(state)
    const mode = state.playback?.playMode
    const playback: Record<string, unknown> | null = state.playback
      ? Object.fromEntries(
          CORE_PLAYBACK_FIELDS.filter(
            (key) => !['renderPerformance', 'autoMixReason'].includes(key)
          ).map((key) => [key, state.playback![key]])
        )
      : null
    if (playback) {
      playback.playMode =
        mode === 'repeat'
          ? 'single'
          : mode === 'listLoop'
            ? 'loop'
            : mode === 'shuffle'
              ? 'shuffle'
              : mode === 'heart'
                ? 'heart'
                : 'sequence'
      const upcoming = state.playback?.upcomingTrack
      playback.upcomingTrack = upcoming
        ? {
            id: this.reference({ ...upcoming, source: undefined }),
            queueEntryId: upcoming.queueEntryId,
            title: upcoming.title,
            artist: upcoming.artist,
            album: upcoming.album,
            duration: upcoming.duration
          }
        : null
      for (const field of ['gaplessBlockedReason', 'crossfadeBlockedReason'])
        if (playback[field]) playback[field] = '当前播放配置不支持此功能'
    }
    return {
      protocolVersion: state.protocolVersion,
      epoch: state.epoch,
      sequence: state.sequence,
      phase: state.phase,
      playback,
      track: state.track ? this.track(state.track) : null,
      queue: state.queue,
      error: state.error ? messages.FAILED : null,
      isStreamBuffering: state.isStreamBuffering,
      loading: state.loading,
      migrationRequired: state.migrationRequired,
      mute: state.mute,
      libraryRevision: state.libraryRevision,
      catalogRevision: state.catalogRevision,
      entityMetadataRevision: state.entityMetadataRevision,
      presentationRevision: state.presentationRevision,
      playlistsRevision: state.playlistsRevision,
      versionsRevision: state.versionsRevision,
      audioRevision: state.audioRevision,
      settingsRevision: state.settingsRevision,
      lyricsRevision: state.lyricsRevision,
      lyricsContentRevision: state.lyricsContentRevision
    }
  }

  private envelope(raw: Record<string, unknown>, context?: RemoteCoreRpcContext): Envelope {
    if (
      !only(raw, [
        'protocolVersion',
        'targetId',
        'zoneId',
        'requestId',
        'commandId',
        'epoch',
        'expectedRevision',
        'kind',
        'name',
        'payload'
      ]) ||
      !text(raw.requestId) ||
      !text(raw.epoch) ||
      !text(raw.name) ||
      (raw.kind !== 'query' && raw.kind !== 'command') ||
      !record(raw.payload) ||
      (raw.protocolVersion !== undefined && !uint(raw.protocolVersion)) ||
      (raw.targetId !== undefined && !text(raw.targetId)) ||
      (raw.zoneId !== undefined && !text(raw.zoneId)) ||
      (raw.commandId != null && !text(raw.commandId)) ||
      (raw.expectedRevision != null && !uint(raw.expectedRevision))
    )
      throw invalid()
    // Clients from before negotiation send no version and speak version 1.
    const version = (raw.protocolVersion as number | undefined) ?? 1
    if (version < REMOTE_CORE_PROTOCOL_RANGE.min || version > REMOTE_CORE_PROTOCOL_RANGE.max)
      throw error('UNSUPPORTED_PROTOCOL', messages.UNSUPPORTED_PROTOCOL)
    if (raw.targetId !== undefined && raw.targetId !== context?.serverId)
      throw error('WRONG_TARGET', messages.WRONG_TARGET)
    if (raw.zoneId !== undefined && raw.zoneId !== REMOTE_CORE_LOCAL_ZONE)
      throw error('UNKNOWN_ZONE', messages.UNKNOWN_ZONE)
    return raw as unknown as Envelope
  }

  async handle(raw: Record<string, unknown>, principal?: string, context?: RemoteCoreRpcContext): Promise<Record<string, unknown>> {
    const requestId = typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : ''
    let entered = false
    try {
      const env = this.envelope(raw, context)
      const names: readonly string[] =
        env.kind === 'query' ? REMOTE_CORE_QUERIES : REMOTE_CORE_COMMANDS
      if (!names.includes(env.name)) throw error('FORBIDDEN', messages.FORBIDDEN)
      const bootstrap =
        env.kind === 'query' && ['core.getSnapshot', 'state.snapshot'].includes(env.name)
      this.ready(bootstrap ? undefined : env.epoch)
      if (this.active >= 8) throw error('BUSY', messages.BUSY)
      this.active++
      entered = true
      if (env.kind === 'command') {
        const key = env.commandId ?? env.requestId
        if (this.seenCommands.has(key)) throw error('OUTCOME_UNKNOWN', messages.OUTCOME_UNKNOWN)
        // Reserve before awaiting: simultaneous retries must never execute a mutation twice.
        this.seenCommands.add(key)
        if (this.seenCommands.size > 1024)
          this.seenCommands.delete(this.seenCommands.values().next().value!)
        await this.command(env)
        return {
          kind: 'response',
          requestId,
          epoch: this.ready(env.epoch).epoch,
          ok: true,
          value: { snapshot: this.projectSnapshot(this.ready(env.epoch)) }
        }
      }
      const value = await this.query(env, principal, context)
      const state = this.ready(bootstrap ? undefined : env.epoch)
      return { kind: 'response', requestId, epoch: state.epoch, ok: true, value }
    } catch (cause) {
      const candidate = (cause as { code?: string })?.code ?? 'FAILED'
      const code = Object.hasOwn(messages, candidate) ? candidate : 'FAILED'
      if (code === 'FAILED') this.options.failed(cause)
      return {
        kind: 'response',
        requestId,
        epoch: this.options.snapshot()?.epoch ?? 'epoch-unavailable',
        ok: false,
        error: { code, message: messages[code] }
      }
    } finally {
      if (entered) this.active--
    }
  }

  private page(
    payload: Record<string, unknown>,
    fallback = 100
  ): { offset: number; limit: number } {
    if (
      (payload.offset !== undefined && !uint(payload.offset)) ||
      (payload.limit !== undefined &&
        (!uint(payload.limit) || payload.limit < 1 || payload.limit > REMOTE_CORE_PAGE_LIMIT))
    )
      throw invalid()
    return {
      offset: (payload.offset as number | undefined) ?? 0,
      limit: (payload.limit as number | undefined) ?? fallback
    }
  }

  private validate<K extends keyof CoreQueries>(
    name: K,
    payload: unknown,
    epoch: string
  ): asserts payload is CoreQueries[K]['input'] {
    if (!isCoreRequest({ kind: 'query', name, payload, requestId: 'remote-validation', epoch }))
      throw invalid()
  }

  private queue(env: Envelope, requireRevision: boolean) {
    const state = this.ready(env.epoch),
      queue = state.queue
    const payload = env.payload
    const revisions = [env.expectedRevision, payload.expectedRevision, payload.revision].filter(
      (value) => value != null
    )
    if (
      (requireRevision && !revisions.length) ||
      revisions.some((value) => !uint(value)) ||
      revisions.some((value) => value !== revisions[0])
    )
      throw invalid()
    if (payload.id !== undefined && !text(payload.id)) throw invalid()
    if (
      (payload.id !== undefined && payload.id !== 'default' && payload.id !== queue?.id) ||
      (revisions.length && revisions[0] !== (queue?.revision ?? 0))
    )
      throw error('STALE_REVISION', messages.STALE_REVISION)
    return queue
  }

  private async query(env: Envelope, principal?: string, context?: RemoteCoreRpcContext): Promise<unknown> {
    const p = env.payload,
      epoch = this.ready().epoch
    switch (env.name) {
      case 'providers.session': {
        if (!only(p, ['providerId']) || !text(p.providerId)) throw invalid()
        if (!principal || context?.encrypted !== true) throw error('FORBIDDEN', messages.FORBIDDEN)
        if (p.providerId !== 'ncm' || !this.options.providerSession)
          throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
        try {
          const session = await this.options.providerSession()
          // Project this response explicitly: no profile, settings, or other provider secrets.
          return session.loggedIn
            ? { providerId: 'ncm', loggedIn: true, cookie: session.cookie }
            : { providerId: 'ncm', loggedIn: false }
        } catch {
          // Keyring/provider errors may contain credentials. Neither the reply nor failed()
          // receives the original exception.
          throw error('FAILED', '读取电脑登录态失败')
        }
      }
      case 'library.info':
        if (!only(p, [])) throw invalid()
        if (!this.options.media) throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
        return { libraryId: this.options.media.libraryId, streamFormats: [...REMOTE_STREAM_FORMATS] }
      case 'lyrics.current': {
        if (!only(p, ['trackId']) || (p.trackId !== undefined && !text(p.trackId))) throw invalid()
        const state = this.ready(env.epoch)
        const currentTrackId = state.track ? this.reference(state.track) : null
        if (state.track && (p.trackId === undefined || p.trackId === currentTrackId)) {
          const content = await this.options.request('query', 'lyrics.current', {}, epoch)
          const projected = projectRemoteLyricsView(currentTrackId!, content)
          if (projected.lines.length > 0 || !this.options.resolveTrackLyrics) return projected
          const resolvedTrack = await this.resolveCurrentTrackRecord(state.track)
          const fallback = await this.options.resolveTrackLyrics(resolvedTrack, {
            allowOnlineFallback: true,
            signal: this.options.signal
          })
          return projectRemoteLyricsView(currentTrackId!, fallback)
        }
        if (p.trackId !== undefined && this.options.media && this.options.resolveTrackLyrics) {
          const ref = this.references.get(p.trackId)
          if (ref && ref.provider === 'local') {
            const resolvedTrack = await this.options.media.resolveTrack({
              libraryId: this.options.media.libraryId,
              sourceId: ref.id
            })
            const content = await this.options.resolveTrackLyrics(resolvedTrack, {
              allowOnlineFallback: true,
              signal: this.options.signal
            })
            return projectRemoteLyricsView(p.trackId, content)
          }
        }
        return { trackId: p.trackId ?? '', source: 'none', synced: false, lines: [] }
      }
      case 'lyrics.fetchOnline': {
        if (
          !only(p, ['trackId', 'url']) ||
          (p.trackId !== undefined && !text(p.trackId)) ||
          (p.url !== undefined && typeof p.url !== 'string')
        )
          throw invalid()
        if (p.url !== undefined) throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
        if (!this.options.resolveTrackLyrics)
          throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
        const state = this.ready(env.epoch)
        if (!state.track) throw error('NOT_FOUND', messages.NOT_FOUND)
        const trackId = this.reference(state.track)
        if (p.trackId !== undefined && p.trackId !== trackId)
          throw error('NOT_FOUND', messages.NOT_FOUND)
        const resolvedTrack = await this.resolveCurrentTrackRecord(state.track)
        const resolved = await this.options.resolveTrackLyrics(resolvedTrack, {
          allowOnlineFallback: true,
          signal: this.options.signal
        })
        const projected = projectRemoteLyricsView(trackId, resolved)
        if (projected.lines.length === 0) throw error('NOT_FOUND', messages.NOT_FOUND)
        return projected
      }
      case 'media.resolve':
        if (!only(p, ['libraryId', 'sourceId', 'sourceVersion']) || !text(p.libraryId) ||
          !text(p.sourceId) || (p.sourceVersion !== undefined && !text(p.sourceVersion, 256))) throw invalid()
        if (!principal) throw error('FORBIDDEN', messages.FORBIDDEN)
        if (!this.options.media) throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
        return this.options.media.resolve({ libraryId: p.libraryId, sourceId: p.sourceId,
          sourceVersion: p.sourceVersion as string | undefined }, principal)
      case 'media.lyrics': {
        if (!only(p, ['libraryId', 'sourceId']) || !text(p.libraryId) || !text(p.sourceId))
          throw invalid()
        if (!principal) throw error('FORBIDDEN', messages.FORBIDDEN)
        if (!this.options.media || !this.options.resolveTrackLyrics)
          throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
        const track = await this.options.media.resolveTrack({
          libraryId: p.libraryId,
          sourceId: p.sourceId
        })
        const content = await this.options.resolveTrackLyrics(track, {
          allowOnlineFallback: true,
          signal: this.options.signal
        })
        return projectRemoteLyricsView(p.sourceId, content)
      }
      case 'core.getSnapshot':
      case 'state.snapshot':
        if (!only(p, [])) throw invalid()
        return this.projectSnapshot(this.ready())
      case 'playback.getQueueWindow':
      case 'queue.page': {
        if (
          !only(p, ['id', 'revision', 'offset', 'limit', 'search']) ||
          (p.search !== undefined && (typeof p.search !== 'string' || p.search.length > 512))
        )
          throw invalid()
        const { offset, limit } = this.page(p, 50),
          queue = this.queue(env, false)
        if (!queue)
          return {
            queueId: 'default',
            revision: 0,
            total: 0,
            offset,
            limit,
            currentIndex: -1,
            currentOccurrenceId: null,
            items: []
          }
        const page = await this.options.request(
          'query',
          'queue.page',
          {
            id: queue.id,
            revision: queue.revision,
            offset,
            limit,
            ...(typeof p.search === 'string' ? { search: p.search } : {})
          },
          epoch
        )
        return {
          queueId: queue.id,
          revision: page.revision,
          total: page.total,
          offset: page.offset,
          limit,
          currentIndex: queue.index,
          currentOccurrenceId: queue.occurrenceId,
          items: page.items.map((item) => ({
            occurrenceId: item.queueEntryId,
            index: item.position,
            track: item.track ? this.track(item.track) : null
          }))
        }
      }
      case 'search.songs': {
        const query = p.query ?? ''
        if (
          !only(p, ['query', 'offset', 'limit']) ||
          typeof query !== 'string' ||
          query.length > 512 ||
          query.includes('\0')
        )
          throw invalid()
        const page = await this.options.request(
          'query',
          'library.tracks',
          {
            search: query,
            searchLiteral: true,
            sort: 'insertion',
            direction: 'asc',
            ...this.page(p)
          },
          epoch
        )
        return {
          query,
          total: page.total,
          revision: page.revision,
          offset: page.offset,
          items: page.tracks.map((track, index) => this.track(track, page.catalog?.tracks[index]))
        }
      }
      case 'playlists.list': {
        if (!only(p, ['offset', 'limit'])) throw invalid()
        const page = await this.options.request('query', 'playlists.catalog', this.page(p), epoch)
        return page.items.map((row) => ({
          id: row.id,
          name: row.name,
          trackIds: [],
          trackCount: row.count,
          updatedAtMs: 0
        }))
      }
      case 'catalog.query':
        this.validate('catalog.query', p, epoch)
        if (p.scope === 'all') throw error('FORBIDDEN', messages.FORBIDDEN)
        return this.options.request('query', 'catalog.query', { ...p, scope: 'library' }, epoch)
      case 'catalog.detail':
        this.validate('catalog.detail', p, epoch)
        return this.options.request('query', 'catalog.detail', p, epoch)
      case 'catalog.sources': {
        this.validate('catalog.sources', p, epoch)
        const page = await this.options.request('query', 'catalog.sources', p, epoch)
        return {
          revision: page.revision,
          total: page.total,
          offset: page.offset,
          items: page.items.map((item) => ({
            id: item.id,
            provider: item.provider,
            recordingId: item.recordingId,
            releaseId: item.releaseId,
            availability: item.availability,
            inLibrary: item.inLibrary,
            preferred: item.preferred,
            track: this.sourceTrack(item.track)
          }))
        }
      }
      case 'metadata.entity.detail': {
        this.validate('metadata.entity.detail', p, epoch)
        const detail = await this.options.request('query', 'metadata.entity.detail', p, epoch)
        return this.metadata(detail)
      }
      case 'library.artwork': {
        this.validate('library.artwork', p, epoch)
        if (p.ids.length > REMOTE_CORE_ARTWORK_LIMIT) throw invalid()
        const ids = p.ids.map((id) => {
          const ref = this.references.get(id)
          if (!ref || ref.provider !== 'local') throw error('NOT_FOUND', messages.NOT_FOUND)
          return ref.id
        })
        const page = await this.options.request('query', 'library.artwork', { ...p, ids }, epoch)
        return {
          revision: page.revision,
          items: await Promise.all(
            page.items.map(async (item) => ({
              id: this.reference({ id: item.id, source: 'local' }),
              cover: await this.options.resolveCover(item.cover)
            }))
          )
        }
      }
      default:
        throw invalid()
    }
  }

  private sourceTrack(track: Omit<CoreTrackView, 'id' | 'queueEntryId' | 'subTrack'>) {
    return this.track({ ...track, id: '' }, undefined, false)
  }

  private async resolveCurrentTrackRecord(track: CoreTrackView): Promise<TrackData> {
    if (this.options.media && (!track.source || track.source === 'local')) {
      try {
        return await this.options.media.resolveTrack({
          libraryId: this.options.media.libraryId,
          sourceId: track.id
        })
      } catch {
        // Fall through to TrackView-projected metadata when the track is not in the local catalog.
      }
    }
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      ...(track.artists ? { artists: track.artists } : {}),
      album: track.album,
      ...(track.albumId ? { albumId: track.albumId } : {}),
      filePath: track.id,
      fileName: track.title,
      duration: track.duration,
      size: track.size ?? 0,
      cover: null,
      lyrics: null,
      source: track.source ?? 'local',
      ...(track.ncmSongId != null ? { ncmSongId: track.ncmSongId } : {})
    }
  }

  private async metadata(detail: EntityMetadataDetail) {
    const images: Array<Omit<MusicArtwork, 'handle'> & { dataUrl: string }> = []
    for (const image of (detail.artwork ?? []).slice(0, REMOTE_CORE_ARTWORK_LIMIT)) {
      const dataUrl = await this.options.resolveCover(image.handle)
      if (dataUrl)
        images.push({
          scope: image.scope,
          targetRef: image.targetRef,
          dataUrl,
          sourceReleaseId: image.sourceReleaseId,
          attribution: image.attribution,
          usage: image.usage
        })
    }
    return {
      entityId: detail.entityId,
      targetId: detail.targetId,
      revision: detail.revision,
      name: detail.name,
      introduction: detail.introduction
        ? {
            value: detail.introduction.value,
            language: detail.introduction.language,
            origin: detail.introduction.origin,
            attribution: detail.introduction.attribution
          }
        : null,
      manualArtwork: detail.manualArtwork
        ? {
            dataUrl: await this.options.resolveCover(detail.manualArtwork.dataUrl)
          }
        : null,
      facts: detail.facts.map((fact) => ({
        field: fact.field,
        value: fact.value,
        language: fact.language,
        sourceLanguage: fact.sourceLanguage,
        rendering: fact.rendering,
        attribution: fact.attribution,
        usage: fact.usage,
        sourceProvider: fact.sourceProvider
      })),
      artwork: images,
      artworkOverride: detail.artworkOverride
    }
  }

  private async command(env: Envelope): Promise<void> {
    const p = env.payload
    if (env.name === 'playback.replaceQueue') return this.replaceQueue(env)
    if (env.name === 'playback.selectQueueIndex') {
      if (
        !only(p, ['id', 'revision', 'index', 'occurrenceId']) ||
        !uint(p.index) ||
        !text(p.occurrenceId)
      )
        throw invalid()
      const queue = this.queue(env, true)
      if (!queue || p.index >= queue.total) throw error('NOT_FOUND', messages.NOT_FOUND)
      await this.options.request(
        'command',
        'queue.select',
        { id: queue.id, revision: queue.revision, index: p.index, occurrenceId: p.occurrenceId },
        env.epoch
      )
      return
    }
    const name =
      env.name === 'playback.setVolume'
        ? 'playback.volume'
        : env.name === 'playback.setPlayMode'
          ? 'playback.mode'
          : env.name
    const mode =
      p.mode === 'single'
        ? 'repeat'
        : p.mode === 'loop'
          ? 'listLoop'
          : p.mode === 'sequence'
            ? 'sequential'
            : p.mode
    const payload = name === 'playback.mode' ? { ...p, mode } : p
    const raw = { kind: 'command', name, payload, requestId: env.requestId, epoch: env.epoch }
    if (!isCoreRequest(raw) || raw.kind !== 'command') throw invalid()
    await this.options.request('command', raw.name, raw.payload, env.epoch)
  }

  private async replaceQueue(env: Envelope): Promise<void> {
    const p = env.payload
    if (
      !only(p, ['id', 'revision', 'expectedRevision', 'tracks', 'startIndex', 'play']) ||
      !Array.isArray(p.tracks) ||
      !p.tracks.length ||
      p.tracks.length > REMOTE_CORE_PAGE_LIMIT ||
      (p.startIndex !== undefined && !uint(p.startIndex)) ||
      (p.play !== undefined && typeof p.play !== 'boolean')
    )
      throw invalid()
    const startIndex = (p.startIndex as number | undefined) ?? 0
    if (startIndex >= p.tracks.length) throw invalid()
    const original = this.queue(env, true)
    const guard = () => {
      const current = this.ready(env.epoch).queue
      if (current?.id !== original?.id || current?.revision !== original?.revision)
        throw error('STALE_REVISION', messages.STALE_REVISION)
    }
    // Ignore every client-supplied title, URI and source hint. Only issued references are accepted.
    const ids = p.tracks.map((track) => {
      if (!record(track) || !text(track.id)) throw invalid()
      const ref = this.references.get(track.id)
      if (!ref) throw error('NOT_FOUND', messages.NOT_FOUND)
      if (ref.provider !== 'local')
        throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
      return ref.id
    })
    const page = await this.options.request(
      'query',
      'library.byIds',
      { ids: [...new Set(ids)] },
      env.epoch
    )
    const records = new Map(page.tracks.map((track) => [track.id, track]))
    for (const id of ids) {
      const track = records.get(id)
      if (!track) throw error('NOT_FOUND', messages.NOT_FOUND)
      if (track.source && track.source !== 'local')
        throw error('UNSUPPORTED_CAPABILITY', messages.UNSUPPORTED_CAPABILITY)
    }
    guard()
    await this.options.playback.fromPages(
      async (append) => {
        guard()
        await append(ids.map((id) => ({ id })))
      },
      {
        selectedIndex: startIndex,
        play: p.play !== false,
        guard,
        beforeAdopt: async () => guard()
      },
      this.options.signal
    )
  }
}
