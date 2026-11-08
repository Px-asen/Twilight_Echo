import { shallowRef } from 'vue'
import { useCoreConnection } from './coreConnection.ts'
import {
  BROWSE_PAGE_SIZE,
  BROWSE_WINDOW_PAGES,
  type BrowseRowsPage,
  type BrowseQuery,
  type BrowseSession,
  type BrowseSource,
  type BrowseDisplayRow,
  type BrowsePartState,
  type BrowseContext
} from '../../../shared/coreBrowse.ts'
import type { Track } from '../types/music.ts'
import type { TrackData } from '../../../shared/track.ts'
import type { CorePlayerClient } from './player/corePlayerTypes.ts'

type Client = Pick<CorePlayerClient, 'query' | 'command'>
/** Browse persistence is JSON by contract; detach Vue proxies before IPC and
 * freeze the value at capture time instead of retaining mutable editor state. */
export function browseSnapshotValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint')
        throw new Error('浏览状态只能包含可序列化的数据')
      return item
    })
  ) as T
}
export interface BrowseSelection {
  id: string
  query: Omit<BrowseQuery, 'id' | 'offset' | 'limit'>
  ranges?: Array<readonly [number, number]>
  count: number
}
export async function produceBrowseSelection(
  selected: BrowseSelection,
  append: (tracks: Track[]) => Promise<void>,
  signal?: AbortSignal,
  core: Client = useCoreConnection()
): Promise<void> {
  let offset = 0
  for (;;) {
    signal?.throwIfAborted()
    const page = await core.query(
      'browse.page',
      { ...selected.query, id: selected.id, offset, limit: BROWSE_PAGE_SIZE, complete: true },
      signal
    )
    const rows = selected.ranges
      ? page.items.filter((_, index) =>
          selected.ranges!.some(([start, end]) => offset + index >= start && offset + index < end)
        )
      : page.items
    if (rows.length) await append(rows as Track[])
    offset += page.items.length
    if (offset >= page.filteredTotal) return
    if (!page.items.length) throw new Error('浏览分页读取中断')
  }
}
export interface BrowseWindowState {
  session: BrowseSession | null
  offset: number
  total: number
  rowTotal: number
  rows: BrowseDisplayRow[]
  tracks: Track[]
  positions: number[]
  loading: boolean
  error: string
}
/** A single display window, never a complete playlist or selected-track store. */
export function createBrowseWindow(
  core: Client = useCoreConnection(),
  grouped: () => boolean = () => false,
  capacity = BROWSE_WINDOW_PAGES
) {
  const state = shallowRef<BrowseWindowState>({
    session: null,
    offset: 0,
    total: 0,
    rowTotal: 0,
    rows: [],
    tracks: [],
    positions: [],
    loading: false,
    error: ''
  })
  let revision = 0
  let anchor = 0
  let request: AbortController | undefined
  let selection: Omit<BrowseQuery, 'id' | 'offset' | 'limit'> = {}
  let groups: Record<string, BrowsePartState> = {}
  const pages = new Map<number, BrowseRowsPage>()
  function descriptor(session: BrowseSession): BrowseSession {
    const { id, providerId, loaded, total, complete, duration, revision } = session
    return { id, providerId, loaded, total, complete, duration, revision }
  }
  async function load(start = 0): Promise<void> {
    const session = state.value.session
    if (!session) return
    anchor = start
    const version = ++revision
    request?.abort()
    const controller = new AbortController()
    request = controller
    const first = Math.max(0, Math.floor(start / BROWSE_PAGE_SIZE) - 1)
    state.value = { ...state.value, loading: true, error: '' }
    try {
      const wanted = new Set(
        Array.from(
          { length: Math.min(BROWSE_WINDOW_PAGES, Math.max(1, capacity)) },
          (_, i) => first + i
        )
      )
      for (const page of [...pages.keys()]) if (!wanted.has(page)) pages.delete(page)
      const retained = [...pages].sort(([a], [b]) => a - b).flatMap(([, page]) => page.rows)
      state.value = {
        ...state.value,
        offset: first * BROWSE_PAGE_SIZE,
        rows: retained,
        tracks: retained.flatMap((row) => (row.kind === 'track' ? [row.track as Track] : [])),
        positions: retained.flatMap((row) => (row.kind === 'track' ? [row.index] : []))
      }
      for (const page of wanted) {
        if (!pages.has(page)) {
          const input = {
            ...selection,
            id: session.id,
            offset: page * BROWSE_PAGE_SIZE,
            limit: BROWSE_PAGE_SIZE
          }
          let result: BrowseRowsPage
          if (grouped())
            result = await core.query('browse.rows', { ...input, groups }, controller.signal)
          else {
            const data = await core.query('browse.page', input, controller.signal)
            result = {
              ...descriptor(data),
              offset: data.offset,
              totalRows: data.filteredTotal,
              filteredTotal: data.filteredTotal,
              rows: data.items.map((track, index) => ({
                kind: 'track',
                key: track.id,
                track,
                index: data.offset + index,
                grouped: false
              }))
            }
          }
          if (version !== revision) return
          pages.set(page, result)
        }
        const cached = pages.get(page)!
        if ((page + 1) * BROWSE_PAGE_SIZE >= cached.totalRows) {
          for (const next of [...pages.keys()]) if (next > page) pages.delete(next)
          break
        }
      }
      if (version !== revision) return
      const ordered = [...pages].sort(([a], [b]) => a - b)
      const latest = ordered.at(-1)![1]
      const rows = ordered.flatMap(([, page]) => page.rows)
      const trackRows = rows.filter((row) => row.kind === 'track')
      state.value = {
        session: descriptor(latest),
        offset: ordered[0][0] * BROWSE_PAGE_SIZE,
        total: latest.filteredTotal,
        rowTotal: latest.totalRows,
        rows,
        tracks: trackRows.map((row) => row.track) as Track[],
        positions: trackRows.map((row) => row.index),
        loading: false,
        error: ''
      }
    } catch (error) {
      if (controller.signal.aborted) return
      if (version === revision)
        state.value = {
          ...state.value,
          loading: false,
          error: String(error instanceof Error ? error.message : error)
        }
      throw error
    }
  }
  function reset(session: BrowseSession | null = null): void {
    revision++
    request?.abort()
    pages.clear()
    selection = {}
    groups = {}
    anchor = 0
    state.value = {
      session,
      offset: 0,
      total: session?.loaded ?? 0,
      rowTotal: 0,
      rows: [],
      tracks: [],
      positions: [],
      loading: false,
      error: ''
    }
  }
  return {
    state,
    async open(source: BrowseSource): Promise<void> {
      reset()
      const version = revision
      const controller = new AbortController()
      request = controller
      const session = (await core.command(
        'browse.open',
        { source },
        controller.signal
      )) as BrowseSession
      if (version !== revision) {
        await core.command('browse.release', { ids: [session.id] })
        return
      }
      state.value = { ...state.value, session }
      await load()
    },
    async seed(providerId: string, tracks: readonly Track[]): Promise<void> {
      reset()
      const version = revision
      const controller = new AbortController()
      request = controller
      let session = (await core.command(
        'browse.open',
        { providerId },
        controller.signal
      )) as BrowseSession
      try {
        for (let offset = 0; offset < tracks.length; offset += BROWSE_PAGE_SIZE) {
          if (version !== revision) break
          session = (await core.command(
            'browse.append',
            {
              id: session.id,
              items: tracks
                .slice(offset, offset + BROWSE_PAGE_SIZE)
                .map(
                  (track) =>
                    ({
                      ...track,
                      filePath: track.filePath ?? '',
                      fileName: track.fileName ?? '',
                      cover: track.cover ?? null,
                      lyrics: track.lyrics ?? null
                    }) as TrackData
                ),
              complete: offset + BROWSE_PAGE_SIZE >= tracks.length
            },
            controller.signal
          )) as BrowseSession
        }
        if (version !== revision) {
          await core.command('browse.release', { ids: [session.id] })
          return
        }
        state.value = { ...state.value, session }
        await load()
      } catch (error) {
        await core.command('browse.release', { ids: [session.id] }).catch(() => {})
        throw error
      }
    },
    async restore(
      session: BrowseSession,
      offset = 0,
      query: typeof selection = {},
      parts: typeof groups = {}
    ): Promise<void> {
      reset(session)
      selection = query
      groups = parts
      await load(offset)
    },
    async setQuery(query: typeof selection): Promise<void> {
      selection = query
      groups = {}
      pages.clear()
      await load()
    },
    async setGroups(value: typeof groups, offset = state.value.offset): Promise<void> {
      groups = value
      pages.clear()
      await load(offset)
    },
    load,
    reset,
    async completeCount(): Promise<void> {
      const session = state.value.session
      if (!session || session.complete || session.total !== null) return
      const page = await core.query('browse.page', {
        ...selection,
        id: session.id,
        limit: 1,
        complete: true
      })
      if (state.value.session?.id !== session.id) return
      state.value = {
        ...state.value,
        session: descriptor(page),
        total: page.filteredTotal,
        rowTotal: grouped() ? state.value.rowTotal : page.filteredTotal
      }
    },
    get query() {
      return { ...selection }
    },
    capture() {
      return {
        session: state.value.session && descriptor(state.value.session),
        offset: anchor,
        query: { ...selection },
        groups: { ...groups }
      }
    },
    async produce(
      append: (tracks: Track[], offset: number) => Promise<void>,
      ranges?: readonly (readonly [number, number])[],
      signal?: AbortSignal,
      override: Partial<BrowseQuery> = {}
    ): Promise<void> {
      const id = state.value.session?.id
      if (!id) return
      const query = { ...selection, ...override, id, complete: true }
      let offset = 0
      for (;;) {
        signal?.throwIfAborted()
        const page = await core.query(
          'browse.page',
          { ...query, offset, limit: BROWSE_PAGE_SIZE },
          signal
        )
        const selected = ranges
          ? page.items.filter((_, i) =>
              ranges.some(([start, end]) => offset + i >= start && offset + i < end)
            )
          : page.items
        if (selected.length) await append(selected as Track[], offset)
        offset += page.items.length
        if (offset >= page.filteredTotal) break
        if (!page.items.length) throw new Error('浏览分页读取中断')
      }
    },
    locate: async (trackId: string) => {
      const id = state.value.session?.id
      return id
        ? (await core.query('browse.locate', { ...selection, id, trackId, complete: true }))
            .position
        : -1
    },
    dispose() {
      revision++
      request?.abort()
      pages.clear()
      state.value = { ...state.value, tracks: [], rows: [], positions: [] }
    }
  }
}

/** Navigation holds only Core handles. Pending writes are shared with an immediate return. */
const savedPages = new Map<
  string,
  { epoch: string; snapshot: Promise<string>; owned: Promise<string[]> }
>()
async function releaseIds(core: Client, ids: string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 200)
    await core.command('browse.release', { ids: ids.slice(offset, offset + 200) })
}
export function saveBrowsePage(
  key: string,
  epoch: string,
  providerIds: string[],
  value: Record<string, unknown> | Promise<Record<string, unknown>>,
  core: Client = useCoreConnection(),
  contexts?: Promise<BrowseContext[]>
): void {
  const previous = savedPages.get(key)
  const owned = Promise.resolve(value).then((value) =>
    Array.isArray(value.ownedIds)
      ? value.ownedIds.filter((id): id is string => typeof id === 'string')
      : []
  )
  const snapshot = Promise.all([value, contexts])
    .then(([value, contexts]) =>
      core.command('browse.snapshot.save', {
        providerIds,
        value: browseSnapshotValue(value),
        ...(contexts ? { contexts } : {})
      })
    )
    .then((result) => (result as { id: string }).id)
  savedPages.set(key, { epoch, snapshot, owned })
  void snapshot
    .then(async () => {
      if (previous) {
        const retained = new Set(await owned)
        await releaseIds(core, [
          await previous.snapshot,
          ...(await previous.owned).filter((id) => !retained.has(id))
        ])
      }
    })
    .catch(() => {})
}
export async function restoreBrowsePage(
  key: string,
  epoch: string,
  core: Client = useCoreConnection()
): Promise<Record<string, unknown> | null> {
  const saved = savedPages.get(key)
  if (!saved) return null
  if (saved.epoch !== epoch) {
    savedPages.delete(key)
    void Promise.all([saved.snapshot, saved.owned])
      .then(([id, owned]) => releaseIds(core, [id, ...owned]))
      .catch(() => {})
    return null
  }
  try {
    const id = await saved.snapshot
    const value = (await core.query('browse.snapshot', { id })).value
    if (savedPages.get(key) === saved) savedPages.delete(key)
    await core.command('browse.release', { ids: [id] })
    return value
  } catch {
    if (savedPages.get(key) === saved) savedPages.delete(key)
    return null
  }
}
