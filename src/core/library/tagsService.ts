import type { TrackData } from '../../shared/track.ts'
import type { LibraryQueueSeedItem } from '../../shared/libraryQueueBuild.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import { toPlaybackQueueSnapshot } from '../playback/queueSnapshots.ts'
import {
  validMusicTagsPayload,
  type MusicTagsDatabaseApi, type MusicTagsToken, type MusicTagsListQuery,
  type MusicTagsEntityQuery, type MusicTagsMembersQuery, type MusicTagsCreate,
  type MusicTagsRename, type MusicTagsDelete, type MusicTagsMemberSet,
  type MusicTagsPlay, type MusicTagsPlayResult
} from '../../shared/musicTags.ts'

interface Options {
  database: MusicTagsDatabaseApi; playback: Pick<CorePlaybackSession, 'fromPages'>
  now(): number; changed(): void
}
type Restore = (track: TrackData, signal: AbortSignal) => Promise<TrackData>
const stale = () => Object.assign(new Error('标签或音乐库已变化，请刷新后重试'), { code: 'STALE_REVISION' })
const sameToken = (a: MusicTagsToken, b: MusicTagsToken) => Object.keys(a).every(k => a[k as keyof MusicTagsToken] === b[k as keyof MusicTagsToken])

/** Pages go directly into the existing hidden SQLite queue builder, never through Renderer arrays. */
export class CoreMusicTagsService {
  private readonly options: Options
  private token: MusicTagsToken | null = null
  constructor(options: Options) { this.options = options }
  getRevision() { return this.token?.tagsRevision ?? null }
  getLinkRevision() { return this.token?.linkRevision ?? null }
  getToken(): MusicTagsToken | null { return this.token ? { ...this.token } : null }
  /** An older RPC reply cannot undo a durable event delivered while it was in flight. */
  observe(token: MusicTagsToken) {
    const next = this.token ? {
      tagsRevision: Math.max(this.token.tagsRevision, token.tagsRevision),
      catalogRevision: Math.max(this.token.catalogRevision, token.catalogRevision),
      contentRevision: Math.max(this.token.contentRevision, token.contentRevision),
      linkRevision: Math.max(this.token.linkRevision, token.linkRevision)
    } : { ...token }
    if (this.token && sameToken(this.token, next)) return
    this.token = next; this.options.changed()
  }
  async state() { const token = await this.options.database.tagsState(); this.observe(token); return token }
  async list(query: MusicTagsListQuery) { const page = await this.options.database.tagsList(query); this.observe(page.token); return page }
  async entity(query: MusicTagsEntityQuery) { const page = await this.options.database.tagsEntity(query); this.observe(page.token); return page }
  async members(query: MusicTagsMembersQuery) { const page = await this.options.database.tagsMembers(query); this.observe(page.token); return page }
  async recordings(query: MusicTagsMembersQuery) { const page = await this.options.database.tagsRecordings(query); this.observe(page.token); return page }
  async create(input: MusicTagsCreate) { const result = await this.options.database.tagsCreate(input, this.options.now()); this.observe(result.token); return result }
  async rename(input: MusicTagsRename) { const result = await this.options.database.tagsRename(input, this.options.now()); this.observe(result.token); return result }
  async delete(input: MusicTagsDelete) { const result = await this.options.database.tagsDelete(input); this.observe(result.token); return result }
  async memberSet(input: MusicTagsMemberSet) { const result = await this.options.database.tagsMemberSet(input, this.options.now()); this.observe(result.token); return result }
  async play(request: MusicTagsPlay, signal: AbortSignal, restore?: Restore, playback = this.options.playback): Promise<MusicTagsPlayResult> {
    if (!validMusicTagsPayload('tags.play', request)) throw new Error('无效的标签播放请求')
    const frozen = { ...request.token }
    const guard = () => {
      signal.throwIfAborted()
      // A newly received token may be ahead of our last event; the first state
      // read verifies it. Once verified, any later revision makes it obsolete.
      if (this.token && Object.keys(frozen).some(k => this.token![k as keyof MusicTagsToken] > frozen[k as keyof MusicTagsToken])) throw stale()
    }
    const check = async () => {
      signal.throwIfAborted()
      const current = await this.state()
      if (!sameToken(current, frozen)) throw stale()
      guard()
    }
    let total = 0, selectedIndex = 0, found = request.sourceId === undefined
    await playback.fromPages(async append => {
      // Capture the playback intent before any database await, so a slower tag
      // read cannot supersede a newer explicit play command.
      await check()
      let offset = 0
      do {
        guard()
        const page = await this.options.database.tagsPlaybackPage({ tagId: request.tagId, token: frozen, offset, limit: 100 })
        signal.throwIfAborted(); this.observe(page.token); guard()
        if (!sameToken(page.token, frozen) || page.offset !== offset || (offset > 0 && page.total !== total)) throw stale()
        total = page.total
        if (total === 0) throw new Error('此标签暂无库内歌曲，请先导入歌曲或保存平台歌曲')
        if (page.items.length === 0 || page.items.length > 100 || offset + page.items.length > total) throw new Error('标签播放分页不完整，请刷新后重试')
        const items: LibraryQueueSeedItem[] = []
        for (const [index, item] of page.items.entries()) {
          guard()
          if (request.sourceId === item.sourceId) { selectedIndex = offset + index; found = true }
          if (!restore) throw Object.assign(new Error('标签播放缺少来源授权'), { code: 'FORBIDDEN' })
          const track = await restore(item.track, signal)
          guard()
          // A frozen collection is not permission to rematch by name outside its source scope.
          const snapshot: LibraryTrackRecord = { ...toPlaybackQueueSnapshot({ ...track, sourceSelection: 'explicit' }) }
          items.push({ id: snapshot.id, ...(snapshot.source === 'local' ? { localSnapshot: snapshot } : { snapshot }) })
        }
        await append(items)
        guard(); offset += page.items.length
      } while (offset < total)
      if (!found) throw stale()
      await check()
    }, { selectedIndex: () => selectedIndex, guard, beforeAdopt: async () => { await check() } }, signal)
    return { total, selectedIndex }
  }
}
