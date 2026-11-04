import type { CorePlaybackSession } from '../playback/session.ts'
import { toPlaybackQueueSnapshot } from '../playback/queueSnapshots.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { LibraryQueueSeedItem } from '../../shared/libraryQueueBuild.ts'
import type { TrackData } from '../../shared/track.ts'
import {
  sameFocusState,
  sameFocusToken,
  validMusicFocusPayload,
  type MusicFocusDatabaseApi,
  type MusicFocusState,
  type MusicFocusPageQuery,
  type MusicFocusFacetsQuery,
  type MusicFocusSavedListQuery,
  type MusicFocusCreate,
  type MusicFocusRename,
  type MusicFocusUpdate,
  type MusicFocusDelete,
  type MusicFocusPlay,
  type MusicFocusPlayResult,
  type MusicFocusPlayStatus,
  type MusicFocusPlayStatusQuery
} from '../../shared/musicFocus.ts'

interface Options {
  database: MusicFocusDatabaseApi
  playback: Pick<CorePlaybackSession, 'fromPages'>
  ensureHistory(): Promise<void>
  platformContexts(): Record<string, string>
  now(): number
  changed(): void
}
type Restore = (track: TrackData, signal: AbortSignal) => Promise<TrackData>
const stale = () =>
  Object.assign(new Error('筛选、资料或音乐库已变化，请重新查询'), { code: 'STALE_REVISION' })
const contextKey = (context: Record<string, string>) =>
  JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)))
const stateKeys: Array<keyof MusicFocusState> = [
  'savedRevision',
  'catalogRevision',
  'contentRevision',
  'genresRevision',
  'metadataRevision',
  'ratingsRevision',
  'preferencesRevision',
  'tagsRevision',
  'linkRevision',
  'historyRevision'
]
interface RequestIdentity {
  requestId: string
  epoch: string
  owner: string
}
const receiptKey = (request: RequestIdentity) =>
  JSON.stringify([request.epoch, request.owner, request.requestId])

/** SQLite owns the query; Core owns authorization, current contexts and queue adoption. */
export class CoreMusicFocusService {
  private readonly options: Options
  private current: MusicFocusState | null = null
  private readonly receipts = new Map<string, MusicFocusPlayStatus>()
  constructor(options: Options) {
    this.options = options
  }
  getRevision() {
    return this.current?.savedRevision ?? null
  }
  getHistoryRevision() {
    return this.current?.historyRevision ?? null
  }
  observe(state: MusicFocusState) {
    const next = Object.fromEntries(
      stateKeys.map((key) => [key, Math.max(this.current?.[key] ?? 0, state[key])])
    ) as unknown as MusicFocusState
    if (this.current && sameFocusState(this.current, next)) return
    this.current = next
    this.options.changed()
  }
  async state() {
    const state = await this.options.database.focusState()
    this.observe(state)
    return state
  }
  async query(query: MusicFocusPageQuery) {
    await this.options.ensureHistory()
    const context = { ...this.options.platformContexts() }
    const page = await this.options.database.focusQuery(query, { platformContexts: context })
    this.guardRead(context, page.token)
    this.observe(page.token)
    return page
  }
  async facets(query: MusicFocusFacetsQuery) {
    await this.options.ensureHistory()
    const context = { ...this.options.platformContexts() }
    const page = await this.options.database.focusFacets(query, { platformContexts: context })
    this.guardRead(context, page.token)
    this.observe(page.token)
    return page
  }
  private guardRead(
    context: Record<string, string>,
    token: import('../../shared/musicFocus.ts').MusicFocusToken
  ) {
    if (
      contextKey(context) !== contextKey(this.options.platformContexts()) ||
      (token.expiresAt !== null && this.options.now() >= token.expiresAt) ||
      (this.current && stateKeys.some((key) => token[key] < this.current![key]))
    )
      throw stale()
  }
  async savedList(query: MusicFocusSavedListQuery) {
    const page = await this.options.database.focusSavedList(query)
    await this.state()
    return page
  }
  async savedCreate(input: MusicFocusCreate) {
    const result = await this.options.database.focusSavedCreate(input, this.options.now())
    await this.state()
    return result
  }
  async savedRename(input: MusicFocusRename) {
    const result = await this.options.database.focusSavedRename(input, this.options.now())
    await this.state()
    return result
  }
  async savedUpdate(input: MusicFocusUpdate) {
    const result = await this.options.database.focusSavedUpdate(input, this.options.now())
    await this.state()
    return result
  }
  async savedDelete(input: MusicFocusDelete) {
    const result = await this.options.database.focusSavedDelete(input)
    await this.state()
    return result
  }
  playStatus(input: MusicFocusPlayStatusQuery, owner: string, epoch: string): MusicFocusPlayStatus {
    if (input.epoch !== epoch) return { status: 'unknown' }
    return structuredClone(
      this.receipts.get(receiptKey({ ...input, owner })) ?? { status: 'unknown' }
    )
  }
  async play(
    input: MusicFocusPlay,
    signal: AbortSignal,
    restore?: Restore,
    identity?: RequestIdentity,
    playback = this.options.playback
  ): Promise<MusicFocusPlayResult> {
    if (!validMusicFocusPayload('focus.play', input)) throw new Error('无效的 Focus 播放请求')
    const key = identity ? receiptKey(identity) : null
    if (key) {
      if (this.receipts.has(key))
        throw Object.assign(new Error('播放请求已提交，请查询本次结果'), {
          code: 'OUTCOME_UNKNOWN'
        })
      if (this.receipts.size >= 1024) {
        // Never evict an in-flight operation: its final adoption must remain queryable.
        const retired = [...this.receipts].find(
          ([, r]) =>
            r.status !== 'pending' && !(r.status === 'committed' && r.playback === 'pending')
        )
        if (!retired) throw Object.assign(new Error('播放回执容量已满'), { code: 'BUSY' })
        this.receipts.delete(retired[0])
      }
      this.receipts.set(key, { status: 'pending' })
    }
    const request = structuredClone(input)
    const context = contextKey(this.options.platformContexts())
    const guard = () => {
      signal.throwIfAborted()
      if (
        context !== contextKey(this.options.platformContexts()) ||
        (request.token.expiresAt !== null && this.options.now() >= request.token.expiresAt) ||
        (this.current && !sameFocusState(this.current, request.token))
      )
        throw stale()
    }
    const check = async () => {
      signal.throwIfAborted()
      await this.options.ensureHistory()
      // Query verifies frozen asOf, query identity, current use context and expiry
      // in the same snapshot as all revisions, not just a query-less state read.
      const page = await this.options.database.focusQuery(
        { query: request.query, token: request.token, limit: 1 },
        { platformContexts: this.options.platformContexts() }
      )
      this.observe(page.token)
      if (!sameFocusToken(request.token, page.token)) throw stale()
      guard()
    }
    let total = 0,
      selectedIndex = 0,
      found = request.sourceId === undefined
    let committed = false
    // Capture playback intent before the first await (including history hydration).
    try {
      await playback.fromPages(
        async (append) => {
          await check()
          let offset = 0
          do {
            guard()
            const page = await this.options.database.focusPlaybackPage(
              {
                query: request.query,
                token: request.token,
                offset,
                limit: 100,
                ...(request.sourceId ? { anchorSourceId: request.sourceId } : {})
              },
              { platformContexts: this.options.platformContexts() }
            )
            this.observe(page.token)
            guard()
            if (
              !sameFocusToken(page.token, request.token) ||
              page.offset !== offset ||
              (offset > 0 && page.total !== total)
            )
              throw stale()
            total = page.total
            if (!total) throw new Error('当前结果没有可播放的库内歌曲')
            if (!page.items.length || page.items.length > 100 || offset + page.items.length > total)
              throw new Error('Focus 播放分页不完整，请重新查询')
            const items: LibraryQueueSeedItem[] = []
            for (const [index, item] of page.items.entries()) {
              guard()
              if (request.sourceId === item.sourceId) {
                found = true
                selectedIndex = offset + index
              }
              if (!restore) throw Object.assign(new Error('缺少来源授权'), { code: 'FORBIDDEN' })
              const track = await restore(item.track, signal)
              guard()
              const snapshot: LibraryTrackRecord = {
                ...toPlaybackQueueSnapshot({ ...track, sourceSelection: 'explicit' })
              }
              items.push({
                id: snapshot.id,
                ...(snapshot.source === 'local' ? { localSnapshot: snapshot } : { snapshot })
              })
            }
            await append(items)
            guard()
            offset += page.items.length
          } while (offset < total)
          if (!found) throw stale()
          await check()
        },
        {
          selectedIndex: () => selectedIndex,
          guard,
          beforeAdopt: async () => {
            await check()
          },
          onAdopt: () => {
            committed = true
            if (key)
              this.receipts.set(key, {
                status: 'committed',
                result: { total, selectedIndex },
                playback: 'pending'
              })
          }
        },
        signal
      )
      const result = { total, selectedIndex }
      if (key) this.receipts.set(key, { status: 'committed', result, playback: 'confirmed' })
      return result
    } catch (error) {
      if (key)
        this.receipts.set(
          key,
          committed
            ? { status: 'committed', result: { total, selectedIndex }, playback: 'failed' }
            : { status: 'not_committed' }
        )
      throw error
    }
  }
}
