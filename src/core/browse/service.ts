import { join } from '../../shared/portablePath.ts'
import { PortableBuffer } from '../../shared/portableBytes.ts'
import type { TwilightMediaProviderMethod } from '../../shared/mediaProviderMethods.ts'
import type { CoreRequestEnvelope } from '../../shared/coreProtocol.ts'
import {
  BROWSE_PAGE_SIZE,
  BROWSE_READ_METHODS,
  validBrowsePayload,
  type BrowsePage,
  type BrowseQuery,
  type BrowseSession,
  type BrowseSnapshot,
  type BrowseSource,
  type BrowseRowsQuery,
  type BrowseRowsPage,
  type BrowseDisplayRow,
  type BrowsePartGroup
} from '../../shared/coreBrowse.ts'
import type { TrackData } from '../../shared/track.ts'

interface SessionRecord extends BrowseSession {
  owner: string
  context: string
  source?: BrowseSource
  cursor: number
  index?: { key: string; count: number }
  projection?: { key: string; count: number; tracks: number }
}
interface IndexedTrack {
  position: number
  id: string
  group?: { id: string; title: string; count: number }
}
interface ProjectedGroup {
  id: string
  title: string
  count: number
  total: number
  position: number
  playing: boolean
}
type ProjectedRow =
  | { kind: 'track'; position: number; index: number; grouped: boolean }
  | { kind: 'group'; group: ProjectedGroup; expanded: boolean }
  | { kind: 'pager'; group: ProjectedGroup; page: number; pageCount: number }
interface SnapshotRecord {
  id: string
  owner: string
  contexts: Record<string, string>
}
export interface CoreBrowseFiles {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean }[]>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
  writeFile(path: string, value: string, options: { encoding: 'utf8'; mode: number }): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  rename(from: string, to: string): Promise<void>
}
export interface CoreBrowseOptions {
  files: CoreBrowseFiles
  root: string
  newId(): string
  providerContext(providerId: string): string
  callProvider(
    providerId: string,
    method: TwilightMediaProviderMethod,
    args: unknown[],
    options: { signal: AbortSignal }
  ): Promise<unknown>
}
const failure = (message: string, code = 'STALE_REVISION') =>
  Object.assign(new Error(message), { code })
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** Private display sessions use filesystem capabilities supplied by the host. Only session
 * descriptors remain resident; track pages and navigation drafts live on disk. */
export class CoreBrowseService {
  private readonly options: CoreBrowseOptions
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly snapshots = new Map<string, SnapshotRecord>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly inflight = new Map<string, AbortController>()
  private readonly invalidations = new Map<string, number>()
  private stopped = false
  private readonly directory: string
  private preparation: Promise<void> | undefined
  constructor(options: CoreBrowseOptions) {
    this.options = options
    // A process-owned directory prevents a new Core from adopting stale handles.
    this.directory = join(options.root, `session-${this.id()}`)
  }
  private prepare(): Promise<void> {
    return (this.preparation ??= (async () => {
      await this.options.files.mkdir(this.options.root, { recursive: true })
      // Core replacement joins all old hosts before this instance starts.
      // Abandoned epoch caches cannot be reopened and must not retain account data.
      for (const entry of await this.options.files.readdir(this.options.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^session-[a-zA-Z0-9_-]{1,128}$/.test(entry.name)) continue
        const directory = join(this.options.root, entry.name)
        if (directory !== this.directory) await this.options.files.rm(directory, { recursive: true, force: true })
      }
    })())
  }
  private id(): string {
    const id = this.options.newId()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw failure('Invalid browse identifier', 'INVALID_REQUEST')
    return id
  }
  private context(providerId: string): string {
    return `${this.options.providerContext(providerId)}:${this.invalidations.get(providerId) ?? 0}`
  }
  private check(record: SessionRecord | SnapshotRecord, owner: string): void {
    if (this.stopped) throw failure('Browse session is closed', 'NOT_READY')
    if (('contexts' in record ? this.snapshots : this.sessions).get(record.id) !== record)
      throw failure('浏览会话已过期，请重新打开页面')
    if (record.owner !== owner)
      throw failure('Browse session belongs to another window', 'FORBIDDEN')
    const contexts =
      'contexts' in record ? record.contexts : { [record.providerId]: record.context }
    if (Object.entries(contexts).some(([id, context]) => context !== this.context(id)))
      throw failure('浏览账号或来源已改变，请重新打开页面')
  }
  private session(id: string, owner: string): SessionRecord {
    const session = this.sessions.get(id)
    if (!session) throw failure('浏览会话已过期，请重新打开页面')
    this.check(session, owner)
    return session
  }
  private view(session: SessionRecord): BrowseSession {
    const { id, providerId, loaded, total, complete, duration, revision } = session
    return { id, providerId, loaded, total, complete, duration, revision }
  }
  private async write(id: string, name: string, value: unknown): Promise<void> {
    await this.prepare()
    const dir = join(this.directory, id)
    const text = JSON.stringify(value)
    if (PortableBuffer.byteLength(text, 'utf8') > 8 * 1024 * 1024)
      throw failure('Browse page exceeds its byte budget', 'INVALID_REQUEST')
    await this.options.files.mkdir(dir, { recursive: true })
    const path = join(dir, name + '.json'),
      temporary = path + '.tmp'
    await this.options.files.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await this.options.files.rename(temporary, path)
  }
  private async read<T>(id: string, name: string): Promise<T> {
    return JSON.parse(await this.options.files.readFile(join(this.directory, id, name + '.json'), 'utf8')) as T
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.tails.set(id, result)
    void result
      .finally(() => {
        if (this.tails.get(id) === result) this.tails.delete(id)
      })
      .catch(() => {})
    return result
  }
  async open(
    owner: string,
    input: { source?: BrowseSource; providerId?: string },
    signal: AbortSignal
  ): Promise<BrowseSession> {
    signal.throwIfAborted()
    if (this.stopped)
      throw failure('Browse window is closed', 'NOT_READY')
    const providerId = input.source?.providerId ?? input.providerId!
    const session: SessionRecord = {
      id: this.id(),
      owner,
      providerId,
      context: this.context(providerId),
      source: input.source,
      cursor: 0,
      loaded: 0,
      total: null,
      complete: !input.source,
      duration: 0,
      revision: 0
    }
    this.sessions.set(session.id, session)
    try {
      await this.serial(session.id, async () => {
        this.check(session, owner)
        if (input.source) await this.load(session, owner, signal)
      })
      return this.view(session)
    } catch (error) {
      this.sessions.delete(session.id)
      await this.options.files.rm(join(this.directory, session.id), { recursive: true, force: true })
      throw error
    }
  }
  private async append(
    session: SessionRecord,
    items: TrackData[],
    signal: AbortSignal
  ): Promise<void> {
    let cursor = 0
    while (cursor < items.length) {
      signal.throwIfAborted()
      this.check(session, session.owner)
      const pageIndex = Math.floor(session.loaded / BROWSE_PAGE_SIZE)
      const count = session.loaded % BROWSE_PAGE_SIZE
      const page = count ? await this.read<TrackData[]>(session.id, String(pageIndex)) : []
      const slice = items.slice(cursor, cursor + BROWSE_PAGE_SIZE - count)
      page.push(...slice)
      await this.write(session.id, String(pageIndex), page)
      this.check(session, session.owner)
      session.loaded += slice.length
      session.duration += slice.reduce((sum, track) => sum + (Number(track.duration) || 0), 0)
      cursor += slice.length
    }
    session.revision++
  }
  private async load(session: SessionRecord, owner: string, signal: AbortSignal): Promise<void> {
    this.check(session, owner)
    const source = session.source
    if (!source || session.complete) return
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
    this.inflight.set(session.id, controller)
    try {
      const args = [...source.args]
      if (source.paging) {
        args[source.paging.offsetArg] = session.cursor
        args[source.paging.limitArg] = BROWSE_PAGE_SIZE
      }
      if (!BROWSE_READ_METHODS.includes(source.method))
        throw failure('Unsupported browse source', 'INVALID_REQUEST')
      const result = await this.options.callProvider(source.providerId, source.method, args, {
        signal: controller.signal
      })
      controller.signal.throwIfAborted()
      this.check(session, owner)
      const data = result as {
        tracks?: TrackData[]
        items?: TrackData[]
        total?: number | null
        hasMore?: boolean
        nextOffset?: number
      }
      const items = Array.isArray(result) ? result : (data?.tracks ?? data?.items)
      if (!Array.isArray(items) || items.some((item) => !item || typeof item.id !== 'string'))
        throw failure('Provider returned an invalid browse page', 'FAILED')
      const nextCursor = data?.nextOffset ?? session.cursor + items.length
      const complete =
        !source.paging ||
        data.hasMore === false ||
        (data.hasMore === undefined && items.length < BROWSE_PAGE_SIZE)
      if (!complete && (!Number.isSafeInteger(nextCursor) || nextCursor <= session.cursor))
        throw failure('Provider browse cursor did not advance', 'FAILED')
      await this.append(session, items, controller.signal)
      session.cursor = nextCursor
      session.complete = complete
      session.total = complete ? session.loaded : typeof data.total === 'number' ? data.total : null
    } finally {
      signal.removeEventListener('abort', abort)
      if (this.inflight.get(session.id) === controller) this.inflight.delete(session.id)
    }
  }
  private async rawPage(
    session: SessionRecord,
    offset: number,
    limit: number
  ): Promise<TrackData[]> {
    const items: TrackData[] = []
    for (let position = offset; position < Math.min(session.loaded, offset + limit); ) {
      const rows = await this.read<TrackData[]>(
        session.id,
        String(Math.floor(position / BROWSE_PAGE_SIZE))
      )
      const slice = rows.slice(
        position % BROWSE_PAGE_SIZE,
        Math.min(rows.length, (position % BROWSE_PAGE_SIZE) + limit - items.length)
      )
      items.push(...slice)
      position += slice.length
      if (!slice.length) throw failure('Browse page is incomplete', 'FAILED')
    }
    return items
  }
  private async index(
    session: SessionRecord,
    query: BrowseQuery,
    signal: AbortSignal
  ): Promise<number> {
    const key = JSON.stringify([
      session.revision,
      query.query?.trim().toLocaleLowerCase() ?? '',
      query.sort ?? 'default',
      query.direction ?? 'asc',
      query.seed
    ])
    if (session.index?.key === key) return session.index.count
    const terms = query.query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? []
    const entries: Array<IndexedTrack & { key: string | number }> = []
    for (let start = 0; start < session.loaded; start += BROWSE_PAGE_SIZE) {
      signal.throwIfAborted()
      this.check(session, session.owner)
      const rows = await this.rawPage(session, start, BROWSE_PAGE_SIZE)
      rows.forEach((track, i) => {
        const search = `${track.title}\n${track.artist}\n${track.album ?? ''}`.toLocaleLowerCase()
        if (!terms.every((term) => search.includes(term))) return
        const part = track.mediaPart
        entries.push({
          position: start + i,
          id: track.id,
          ...(part?.groupId && part.count > 1
            ? { group: { id: part.groupId, title: part.groupTitle, count: part.count } }
            : {}),
          key:
            query.sort === 'duration'
              ? Number(track.duration) || 0
              : query.sort && query.sort !== 'default' && query.sort !== 'random'
                ? (track[query.sort] ?? '')
                : start + i
        })
      })
    }
    if (query.sort === 'random') {
      let seed = query.seed ?? 1
      for (let i = entries.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const j = Math.floor((seed / 0x100000000) * (i + 1))
        ;[entries[i], entries[j]] = [entries[j], entries[i]]
      }
    } else if (query.sort && query.sort !== 'default') {
      const sign = query.direction === 'desc' ? -1 : 1
      entries.sort(
        (a, b) =>
          sign *
            (typeof a.key === 'number' && typeof b.key === 'number'
              ? a.key - b.key
              : collator.compare(String(a.key), String(b.key))) || a.position - b.position
      )
    }
    for (let start = 0; start < entries.length; start += BROWSE_PAGE_SIZE) {
      signal.throwIfAborted()
      this.check(session, session.owner)
      await this.write(
        session.id,
        `query-${start / BROWSE_PAGE_SIZE}`,
        entries.slice(start, start + BROWSE_PAGE_SIZE).map(({ key: _key, ...entry }) => entry)
      )
    }
    this.check(session, session.owner)
    session.index = { key, count: entries.length }
    return entries.length
  }
  private async indexPage(
    session: SessionRecord,
    offset: number,
    limit: number
  ): Promise<IndexedTrack[]> {
    const items: IndexedTrack[] = []
    for (let position = offset; position < Math.min(session.index!.count, offset + limit); ) {
      const rows = await this.read<IndexedTrack[]>(
        session.id,
        `query-${Math.floor(position / BROWSE_PAGE_SIZE)}`
      )
      const slice = rows.slice(
        position % BROWSE_PAGE_SIZE,
        Math.min(rows.length, (position % BROWSE_PAGE_SIZE) + limit - items.length)
      )
      if (!slice.length) throw failure('Browse index is incomplete', 'FAILED')
      items.push(...slice)
      position += slice.length
    }
    return items
  }
  async page(owner: string, query: BrowseQuery, signal: AbortSignal): Promise<BrowsePage> {
    return this.serial(query.id, async () => {
      const session = this.session(query.id, owner)
      const offset = query.offset ?? 0,
        limit = query.limit ?? BROWSE_PAGE_SIZE
      const full =
        query.complete || !!query.query?.trim() || (query.sort && query.sort !== 'default')
      while (session.source && !session.complete && (full || session.loaded < offset + limit))
        await this.load(session, owner, signal)
      if (full && !session.complete) throw failure('浏览内容仍在写入，请稍后重试', 'NOT_READY')
      signal.throwIfAborted()
      this.check(session, owner)
      if (!query.query?.trim() && (!query.sort || query.sort === 'default'))
        return {
          ...this.view(session),
          offset,
          filteredTotal: session.total ?? session.loaded,
          items: await this.rawPage(session, offset, limit),
          positions: Array.from(
            { length: Math.max(0, Math.min(limit, session.loaded - offset)) },
            (_, i) => offset + i
          )
        }
      const count = await this.index(session, query, signal)
      const selected = await this.indexPage(session, offset, limit)
      const items = await this.tracksAt(
        session,
        selected.map((item) => item.position),
        signal
      )
      this.check(session, owner)
      return {
        ...this.view(session),
        offset,
        filteredTotal: count,
        items,
        positions: selected.map((item) => item.position)
      }
    })
  }
  private async tracksAt(
    session: SessionRecord,
    positions: number[],
    signal: AbortSignal
  ): Promise<TrackData[]> {
    const pages = new Map<number, TrackData[]>()
    const result: TrackData[] = []
    for (const position of positions) {
      signal.throwIfAborted()
      const page = Math.floor(position / BROWSE_PAGE_SIZE)
      let items = pages.get(page)
      if (!items) {
        items = await this.rawPage(session, page * BROWSE_PAGE_SIZE, BROWSE_PAGE_SIZE)
        if (pages.size >= 5) pages.delete(pages.keys().next().value!)
        pages.set(page, items)
      }
      result.push(items[position % BROWSE_PAGE_SIZE])
    }
    return result
  }
  async rows(owner: string, query: BrowseRowsQuery, signal: AbortSignal): Promise<BrowseRowsPage> {
    return this.serial(query.id, async () => {
      const session = this.session(query.id, owner)
      while (session.source && !session.complete) await this.load(session, owner, signal)
      if (!session.complete) throw failure('浏览内容仍在写入，请稍后重试', 'NOT_READY')
      const count = await this.index(session, query, signal)
      const projectionKey = JSON.stringify([
        session.index!.key,
        query.groups ?? {},
        query.currentTrackId
      ])
      if (session.projection?.key !== projectionKey) {
        type Group = {
          id: string
          title: string
          count: number
          entries: Array<{ position: number; index: number }>
          playing: boolean
        }
        type Row =
          | { kind: 'track'; position: number; index: number; grouped: boolean }
          | { kind: 'group'; group: Group; expanded: boolean }
          | { kind: 'pager'; group: Group; page: number; pageCount: number }
        const groups = new Map<string, Group>()
        const order: Array<Group | { position: number; index: number }> = []
        for (let start = 0; start < count; start += BROWSE_PAGE_SIZE) {
          signal.throwIfAborted()
          const entries = await this.indexPage(session, start, BROWSE_PAGE_SIZE)
          entries.forEach((entry, i) => {
            if (!entry.group) {
              order.push({ position: entry.position, index: start + i })
              return
            }
            let group = groups.get(entry.group.id)
            if (!group) {
              group = { ...entry.group, entries: [], playing: false }
              groups.set(group.id, group)
              order.push(group)
            }
            group.entries.push({ position: entry.position, index: start + i })
            if (entry.id === query.currentTrackId) group.playing = true
          })
        }
        const projected: Row[] = []
        for (const entry of order) {
          if ('position' in entry) {
            projected.push({ kind: 'track', ...entry, grouped: false })
            continue
          }
          const expanded = query.groups?.[entry.id]?.expanded ?? !!query.query?.trim()
          projected.push({ kind: 'group', group: entry, expanded })
          if (!expanded) continue
          const pageCount = Math.ceil(entry.entries.length / 20)
          const page = Math.min(query.groups?.[entry.id]?.page ?? 0, pageCount - 1)
          projected.push(
            ...entry.entries
              .slice(page * 20, (page + 1) * 20)
              .map((item) => ({ kind: 'track' as const, ...item, grouped: true }))
          )
          projected.push({ kind: 'pager', group: entry, page, pageCount })
        }
        for (let start = 0; start < projected.length; start += BROWSE_PAGE_SIZE) {
          signal.throwIfAborted()
          this.check(session, owner)
          await this.write(
            session.id,
            `rows-${start / BROWSE_PAGE_SIZE}`,
            projected.slice(start, start + BROWSE_PAGE_SIZE).map((row) => {
              if (row.kind === 'track') return row
              return {
                ...row,
                group: {
                  id: row.group.id,
                  title: row.group.title,
                  count: row.group.count,
                  total: row.group.entries.length,
                  position: row.group.entries[0].position,
                  playing: row.group.playing
                }
              }
            })
          )
        }
        session.projection = { key: projectionKey, count: projected.length, tracks: count }
      }
      const offset = query.offset ?? 0,
        limit = query.limit ?? BROWSE_PAGE_SIZE
      const projected: ProjectedRow[] = []
      for (let position = offset; position < Math.min(session.projection.count, offset + limit); ) {
        const page = await this.read<ProjectedRow[]>(
          session.id,
          `rows-${Math.floor(position / BROWSE_PAGE_SIZE)}`
        )
        const slice = page.slice(
          position % BROWSE_PAGE_SIZE,
          Math.min(page.length, (position % BROWSE_PAGE_SIZE) + limit - projected.length)
        )
        if (!slice.length) throw failure('Browse display index is incomplete', 'FAILED')
        projected.push(...slice)
        position += slice.length
      }
      const rows: BrowseDisplayRow[] = []
      const tracks = await this.tracksAt(
        session,
        projected.map((row) => (row.kind === 'track' ? row.position : row.group.position)),
        signal
      )
      for (const [i, row] of projected.entries()) {
        signal.throwIfAborted()
        if (row.kind === 'track') {
          const track = tracks[i]
          rows.push({ kind: 'track', key: track.id, track, index: row.index, grouped: row.grouped })
        } else {
          const group: BrowsePartGroup = {
            id: row.group.id,
            title: row.group.title,
            count: row.group.count,
            total: row.group.total,
            playing: row.group.playing,
            representative: tracks[i]
          }
          rows.push(
            row.kind === 'group'
              ? { kind: 'group', key: `group:${group.id}`, group, expanded: row.expanded }
              : {
                  kind: 'pager',
                  key: `pager:${group.id}`,
                  group,
                  page: row.page,
                  pageCount: row.pageCount
                }
          )
        }
      }
      this.check(session, owner)
      return {
        ...this.view(session),
        offset,
        totalRows: session.projection.count,
        filteredTotal: count,
        rows
      }
    })
  }
  async invalidateProvider(providerId: string): Promise<void> {
    await this.prepare()
    this.invalidations.set(providerId, (this.invalidations.get(providerId) ?? 0) + 1)
    const ids = [...this.sessions.values()]
      .filter((session) => session.providerId === providerId)
      .map((session) => session.id)
    ids.push(
      ...[...this.snapshots.values()]
        .filter((snapshot) => providerId in snapshot.contexts)
        .map((snapshot) => snapshot.id)
    )
    await this.remove(ids)
  }
  async disconnect(owner: string): Promise<void> {
    // CoreApplication cancels the disconnected client's requests. Retire its
    // handles without retaining every closed window ID for the process lifetime;
    // a later authorized connection may reuse its identity with fresh handles.
    const ids = [...this.sessions.values()]
      .filter((session) => session.owner === owner)
      .map((session) => session.id)
    ids.push(
      ...[...this.snapshots.values()]
        .filter((snapshot) => snapshot.owner === owner)
        .map((snapshot) => snapshot.id)
    )
    await this.remove(ids)
  }
  private async remove(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.inflight.get(id)?.abort()
      this.sessions.delete(id)
      this.snapshots.delete(id)
    }
    await Promise.all(
      ids.map((id) =>
        this.serial(id, () => this.options.files.rm(join(this.directory, id), { recursive: true, force: true }))
      )
    )
  }
  async execute(
    owner: string,
    request: CoreRequestEnvelope,
    signal: AbortSignal
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (this.stopped)
      throw failure('Browse window is closed', 'NOT_READY')
    if (!validBrowsePayload(request.name, request.payload))
      throw failure('Invalid browse request', 'INVALID_REQUEST')
    switch (request.name) {
      case 'browse.open':
        return this.open(owner, request.payload, signal)
      case 'browse.page':
        return this.page(owner, request.payload, signal)
      case 'browse.rows':
        return this.rows(owner, request.payload, signal)
      case 'browse.context':
        return request.payload.providerIds.map((providerId) => ({
          providerId,
          token: this.context(providerId)
        }))
      case 'browse.append':
        return this.serial(request.payload.id, async () => {
          const session = this.session(request.payload.id, owner)
          if (session.source)
            throw failure('Provider sessions cannot accept renderer data', 'FORBIDDEN')
          await this.append(session, request.payload.items, signal)
          session.complete = request.payload.complete !== false
          session.total = session.complete ? session.loaded : null
          return this.view(session)
        })
      case 'browse.release': {
        for (const id of request.payload.ids) {
          const record = this.sessions.get(id) ?? this.snapshots.get(id)
          if (record && record.owner !== owner) throw failure('Foreign browse session', 'FORBIDDEN')
        }
        return this.remove(request.payload.ids)
      }
      case 'browse.snapshot.save': {
        if (
          request.payload.contexts?.some(
            (context) => context.token !== this.context(context.providerId)
          )
        )
          throw failure('浏览账号或来源已改变，请重新打开页面')
        const id = request.payload.id ?? this.id()
        if (request.payload.id) {
          const old = this.snapshots.get(id)
          if (!old) throw failure('Browse snapshot expired')
          this.check(old, owner)
        }
        const record = {
          id,
          owner,
          contexts: Object.fromEntries(
            request.payload.providerIds.map((provider) => [provider, this.context(provider)])
          )
        }
        this.snapshots.set(id, record)
        await this.serial(id, async () => {
          this.check(record, owner)
          signal.throwIfAborted()
          await this.write(id, 'state', request.payload.value)
          signal.throwIfAborted()
          this.check(record, owner)
        })
        return { id }
      }
      case 'browse.snapshot': {
        const record = this.snapshots.get(request.payload.id)
        if (!record) throw failure('Browse snapshot expired')
        this.check(record, owner)
        await this.tails.get(record.id)
        const value = await this.read<Record<string, unknown>>(record.id, 'state')
        this.check(record, owner)
        return { id: record.id, value } satisfies BrowseSnapshot
      }
      case 'browse.locate': {
        const query = request.payload
        for (let offset = 0; ; offset += BROWSE_PAGE_SIZE) {
          const page = await this.page(
            owner,
            { ...query, offset, limit: BROWSE_PAGE_SIZE, complete: true },
            signal
          )
          const index = page.items.findIndex((track) => track.id === query.trackId)
          if (index >= 0) return { position: offset + index }
          if (offset + page.items.length >= page.filteredTotal) return { position: -1 }
        }
      }
    }
    throw failure('Unsupported browse operation', 'INVALID_REQUEST')
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    for (const controller of this.inflight.values()) controller.abort()
    await Promise.allSettled([...this.tails.values()])
    if (this.preparation) await this.preparation
    this.sessions.clear()
    this.snapshots.clear()
    await this.options.files.rm(this.directory, { recursive: true, force: true })
  }
}
