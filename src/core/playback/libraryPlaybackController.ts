import {
  LIBRARY_MAX_PAGE_SIZE,
  LIBRARY_PAGE_SIZE,
  libraryQueueResumeMode,
  type LibraryQuery,
  type LibraryQueuePage,
  type LibraryQueueEdit,
  type LibraryQueueInsertItem,
  type LibraryQueueSnapshot,
  type LibraryQueuePlaybackWindow
} from '../../shared/libraryDatabase.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import type { TrackData as Track } from '../../shared/track.ts'
import type { PlayMode } from '../../shared/audioEngineTypes.ts'
import { libraryQueueTrack } from './libraryTrack.ts'
import { LibraryQueueSource, type LibraryQueueApi } from './libraryQueueSource.ts'
import { buildLibraryQueuePages, type LibraryQueueSeedProducer } from './libraryQueueBuild.ts'
import type { CoreQueueSourceReplacement } from '../../shared/coreSourceRecovery.ts'

/** How many unplayable occurrences a queue start may skip before it fails. */
const LIBRARY_MAX_START_SKIPS = 5

/** Raised by the start handoff when the first occurrence has no playable
 * source, so stagePages can step on instead of failing the whole start. */
export class LibraryStartUnavailable extends Error {
  constructor(message = 'No playable source for the starting occurrence') {
    super(message)
    this.name = 'LibraryStartUnavailable'
  }
}

/** The producer awaits each append before requesting its next bounded page. */
export type LibraryQueuePageProducer = (
  append: (items: readonly LibraryQueueInsertItem[]) => Promise<void>
) => Promise<unknown>

export interface LibraryQueuePageOptions {
  signal?: AbortSignal
  /** Synchronous source/selection fence, including the final publication. */
  guard?: () => void
}

/** Owns the database cursor, not a second full queue. Cursor changes and their
 * detail reads share one bounded lane; detach fences every outstanding action. */
export interface CoreCell<T> {
  value: T
}
export type CoreCellFactory = <T>(value: T) => CoreCell<T>

export function createLibraryPlaybackController(
  api: LibraryQueueApi,
  cell: CoreCellFactory = (value) => ({ value })
) {
  const source = new LibraryQueueSource(api)
  const active = cell(false)
  const window = cell<LibraryQueuePlaybackWindow | null>(null)
  const snapshot = cell<LibraryQueueSnapshot | null>(null)
  const contentRevision = cell(0)
  const busy = cell(false)
  let epoch = 0
  let pending = 0
  let tail: Promise<unknown> = Promise.resolve()

  function detach(): void {
    epoch++
    active.value = false
    window.value = null
    snapshot.value = null
    source.detach()
  }

  function run<T>(
    action: (isCurrent: () => boolean) => Promise<T>,
    requireActive = true
  ): Promise<T | null> {
    if (pending >= 8) return Promise.reject(new Error('播放队列操作过多，请稍后重试'))
    const generation = epoch
    const isCurrent = () => generation === epoch && active.value === requireActive
    pending++
    busy.value = true
    const result = tail
      .then(() => (isCurrent() ? action(isCurrent) : null))
      .finally(() => {
        pending--
        busy.value = pending > 0
      })
    tail = result.catch(() => {})
    return result
  }

  const windowOptions = (mode: PlayMode) => ({
    repeat: mode === 'repeat',
    wrap: mode === 'listLoop' || mode === 'shuffle'
  })

  /** The same command lane can prepare an array/empty source without exposing
   * it as active. The player completes its native handoff, then calls activate
   * as its final synchronous step. Failure leaves the old source untouched. */
  function stagePages(
    produce: LibraryQueueSeedProducer,
    start: {
      id?: string
      contentRevision: number
      order: 'original' | 'shuffle'
      selectedIndex?: number | (() => number)
    },
    mode: PlayMode,
    adopt: (
      result: LibraryQueuePlaybackWindow,
      activate: () => void,
      retain: () => void
    ) => Promise<void>,
    options: LibraryQueuePageOptions = {}
  ) {
    const generation = epoch
    start = { ...start }
    return run(async (isCurrent) => {
      if (!api.buildQueue) throw new Error('数据库流式队列尚未接入')
      let ready: LibraryQueueSnapshot | undefined
      let adopted = false,
        retained = false,
        accepting = true
      const check = () => {
        if (!accepting || !isCurrent()) throw new Error('播放来源已变化，队列构建已中断')
        if (options.signal?.aborted) throw new Error('队列构建已取消')
        if (contentRevision.value > start.contentRevision)
          throw new Error('曲库已变化，未切换播放来源')
        options.guard?.()
      }
      try {
        ready = await buildLibraryQueuePages(
          { buildQueue: (command) => api.buildQueue!(command), deleteQueue: api.deleteQueue },
          produce,
          start,
          { ...options, guard: check }
        )
        check()
        const restored = await source.restore(ready.id)
        check()
        if (!restored || restored.revision !== ready.revision)
          throw new Error('暂存队列已变化，未切换播放来源')
        if (!restored.total) return null
        // Bind the logical mode before exposing this queue to native/session
        // owners. The stream already froze its order; this does not reshuffle.
        const bound =
          ready.playMode === mode
            ? { queue: ready }
            : await source.edit({
                kind: 'mode',
                mode: mode === 'heart' ? 'sequential' : mode
              })
        check()
        if (!bound) throw new Error('暂存队列已变化，未切换播放来源')
        ready = bound.queue
        const result = await source.playbackWindow(windowOptions(mode))
        check()
        if (result && result.libraryRevision !== start.contentRevision)
          throw new Error('曲库已变化，未切换播放来源')
        // Unlike query playback, conversion must not skip a hole and silently
        // replace the occurrence that is already playing/paused.
        if (!result || result.items[0]?.queueEntryId !== ready.selectedEntryId)
          throw new Error('未能读取原选中歌曲，未切换播放来源')
        // The starting occurrence may be a library row whose provider no longer
        // serves a source (removed upload, region lock, dead radio entry). The
        // whole queue start must not fail for it: step to the next occurrence
        // and let the same start handoff run again on the new window.
        let current = result
        const activate = () => {
          check()
          adopted = true
          active.value = true
          publish(current)
        }
        const retainSeed = () => {
          // A successful/unknown native handoff may already reference this
          // seed. A later source fence must not delete it as unused. Existing
          // reference-aware GC owns retirement after that point.
          retained = true
        }
        for (let skipped = 0; ; skipped++) {
          try {
            await adopt(current, activate, retainSeed)
            break
          } catch (error) {
            if (!(error instanceof LibraryStartUnavailable) || skipped >= LIBRARY_MAX_START_SKIPS)
              throw error
            check()
            const stepped = await commit({ kind: 'step', direction: 1, wrap: false })
            check()
            if (!stepped || stepped.reachedEnd)
              throw new Error('队列中没有可解析音源的歌曲，未切换播放来源')
            const next = await readSelection(mode, isCurrent)
            check()
            if (!next) throw new Error('未能读取下一首歌曲，未切换播放来源')
            current = next
          }
        }
        if (!adopted) throw new Error('队列尚未接管，未切换播放来源')
        return current
      } finally {
        accepting = false
        if (!adopted) {
          if (generation === epoch && !active.value) source.detach()
          if (ready && !retained) await api.deleteQueue(ready.id, ready.revision).catch(() => {})
        }
      }
    }, false)
  }

  async function readSelection(mode: PlayMode, isCurrent: () => boolean) {
    const result = await source.playbackWindow(windowOptions(mode))
    return isCurrent() ? result : null
  }

  function publish(result: LibraryQueuePlaybackWindow | null) {
    if (result) {
      window.value = result
      snapshot.value = result.queue
      contentRevision.value = Math.max(contentRevision.value, result.libraryRevision)
    }
    return result
  }

  type ExpectedQueue = Pick<LibraryQueueSnapshot, 'id' | 'revision'>
  function assertExpected(expected?: ExpectedQueue): void {
    const queue = source.state.queue
    if (expected && (queue?.id !== expected.id || queue.revision !== expected.revision))
      throw new Error('播放队列已变化，请刷新后重试')
  }

  async function commit(edit: LibraryQueueEdit, options?: { recordUndo?: boolean }) {
    const generation = epoch
    const result = await source.edit(edit, options)
    if (result && generation === epoch && active.value) snapshot.value = result.queue
    return result
  }

  async function firstPlayable(mode: PlayMode, isCurrent: () => boolean, check?: () => void) {
    let result = await readSelection(mode, isCurrent)
    check?.()
    const selected = source.state.queue
    if (!result && isCurrent() && selected?.selectedEntryId) {
      const page = await source.loadPage(Math.floor(selected.index / LIBRARY_PAGE_SIZE))
      check?.()
      if (!page || !isCurrent()) return null
      if (page.items[selected.index % LIBRARY_PAGE_SIZE]?.track) {
        // A library revision fence can invalidate a multi-page read while the
        // selected track is still valid. Never skip it as though it were a hole.
        result = await readSelection(mode, isCurrent)
        if (!result && isCurrent()) throw new Error('曲库正在更新，请重试读取播放队列')
        check?.()
        return publish(result)
      }
      // A frozen queue can retain holes after a library deletion. SQL skips
      // them without reading arbitrary numbers of detail pages.
      const next = await commit({ kind: 'step', direction: 1, wrap: true })
      check?.()
      if (next && !next.reachedEnd && isCurrent()) result = await readSelection(mode, isCurrent)
    }
    if (!result && isCurrent()) throw new Error('播放队列中没有可用的本地歌曲')
    check?.()
    return publish(result)
  }

  function create(
    query: LibraryQuery,
    selectedId: string | undefined,
    mode: PlayMode,
    randomStart = false
  ) {
    if (pending >= 8) return Promise.reject(new Error('播放队列操作过多，请稍后重试'))
    detach()
    active.value = true
    return run(async (isCurrent) => {
      const created = await source.create(query, selectedId)
      if (!created || !isCurrent()) return null
      snapshot.value = created
      if (randomStart && !selectedId && created.total > 1) {
        const index = Math.floor(Math.random() * created.total)
        const page = await source.loadPage(Math.floor(index / LIBRARY_PAGE_SIZE))
        if (!page || !isCurrent()) return null
        const entry = page.items[index % LIBRARY_PAGE_SIZE]
        if (!entry) throw new Error('未能读取随机播放起点')
        await commit({ kind: 'select', entryId: entry.queueEntryId })
        if (!isCurrent()) return null
      }
      await commit({ kind: 'mode', mode: mode === 'heart' ? 'sequential' : mode })
      return isCurrent() ? firstPlayable(mode, isCurrent) : null
    })
  }

  function restore(
    reference: LibraryPlaybackQueueReference,
    mode: PlayMode,
    canRestore: () => boolean,
    applySavedMode = false
  ) {
    if (pending >= 8) return Promise.reject(new Error('播放队列操作过多，请稍后重试'))
    detach()
    active.value = true
    const generation = epoch
    return run(async (ownsSource) => {
      const isCurrent = () => ownsSource() && canRestore()
      const restored = await source.restore(reference.id)
      if (!restored || !isCurrent()) {
        if (ownsSource()) detach()
        return null
      }
      snapshot.value = restored
      // Crash resume follows the durable queue, including its mode. Explicit
      // named-session restore may apply the user's saved mode as a new edit.
      mode = applySavedMode ? mode : libraryQueueResumeMode(restored, mode)
      if (applySavedMode)
        await commit({ kind: 'mode', mode: mode === 'heart' ? 'sequential' : mode })
      if (!isCurrent()) {
        if (ownsSource()) detach()
        return null
      }
      const result = await firstPlayable(mode, isCurrent)
      if (!isCurrent()) {
        if (ownsSource()) detach()
        return null
      }
      return result
    }).catch((error) => {
      if (generation === epoch) detach()
      throw error
    })
  }

  /** Live engine adoption is stricter than crash resume: never reorder, skip a
   * hole, or select an older cursor. The engine must keep its exact occurrence. */
  function adoptLive(
    reference: LibraryPlaybackQueueReference,
    mode: PlayMode,
    canAdopt: () => boolean
  ) {
    if (pending >= 8) return Promise.reject(new Error('播放队列操作过多，请稍后重试'))
    detach()
    active.value = true
    const generation = epoch
    return run(async (ownsSource) => {
      const current = () => ownsSource() && canAdopt()
      const queue = await source.restore(reference.id)
      if (!current()) {
        if (ownsSource()) detach()
        return null
      }
      if (
        !queue ||
        queue.revision !== reference.revision ||
        queue.index !== reference.index ||
        queue.selectedEntryId !== reference.entryId ||
        (queue.playMode !== undefined && queue.playMode !== mode)
      )
        throw new Error('后台播放队列已变化，未接管原生播放')
      const result = await readSelection(mode, current)
      if (!current()) {
        if (ownsSource()) detach()
        return null
      }
      if (
        !result ||
        result.queue.revision !== reference.revision ||
        result.items[0]?.position !== reference.index ||
        result.items[0]?.queueEntryId !== reference.entryId ||
        !result.items[0]?.track
      )
        throw new Error('无法读取后台正在播放的歌曲，未接管原生播放')
      return publish(result)
    }).catch((error) => {
      if (generation === epoch) detach()
      throw error
    })
  }

  /** Attach SQL after a confirmed native Stop. A deleted selected track remains
   * a hole: restoring the interface must not move the cursor or start playback. */
  function adoptStopped(
    reference: LibraryPlaybackQueueReference,
    mode: PlayMode,
    canAdopt: () => boolean
  ) {
    if (pending >= 8) return Promise.reject(new Error('播放队列操作过多，请稍后重试'))
    detach()
    active.value = true
    const generation = epoch
    return run(async (ownsSource) => {
      const current = () => ownsSource() && canAdopt()
      const queue = await source.restore(reference.id)
      if (!current()) return null
      if (
        !queue ||
        queue.revision !== reference.revision ||
        queue.index !== reference.index ||
        queue.selectedEntryId !== reference.entryId ||
        libraryQueueResumeMode(queue, mode) !== mode
      )
        throw new Error('后台播放队列已变化，请重新读取恢复状态')
      const page = await source.loadPage(Math.floor(queue.index / LIBRARY_PAGE_SIZE))
      if (!current()) return null
      const row = page?.items[queue.index % LIBRARY_PAGE_SIZE]
      if (!page || row?.queueEntryId !== reference.entryId)
        throw new Error('无法读取后台播放队列，请重试')
      return publish({
        queue,
        libraryRevision: page.libraryRevision,
        lastPlayablePosition: page.lastPlayablePosition,
        items: [row]
      })
    })
      .then((result) => {
        if (!result && generation === epoch) detach()
        return result
      })
      .catch((error) => {
        if (generation === epoch) detach()
        throw error
      })
  }

  function navigate(direction: 1 | -1, wrap: boolean, mode: PlayMode) {
    return run(async (isCurrent) => {
      const result = await commit({ kind: 'step', direction, wrap })
      if (!result || !isCurrent()) return null
      if (result.reachedEnd) return { reachedEnd: true, window: null }
      return { reachedEnd: false, window: publish(await readSelection(mode, isCurrent)) }
    })
  }

  function select(index: number, mode: PlayMode) {
    if (!Number.isSafeInteger(index) || index < 0) return Promise.resolve(null)
    return run(async (isCurrent) => {
      if (!source.state.queue || index >= source.state.queue.total) return null
      const page = await source.loadPage(Math.floor(index / LIBRARY_PAGE_SIZE))
      const entry = page?.items[index % LIBRARY_PAGE_SIZE]
      if (!entry?.track || !isCurrent()) return null
      await commit({ kind: 'select', entryId: entry.queueEntryId })
      return isCurrent() ? publish(await readSelection(mode, isCurrent)) : null
    })
  }

  function selectEntry(entryId: string, expected: ExpectedQueue, mode: PlayMode) {
    return run(async (isCurrent) => {
      assertExpected(expected)
      await commit({ kind: 'select', entryId })
      return isCurrent() ? firstPlayable(mode, isCurrent) : null
    })
  }

  function acceptNative(
    entryId: string,
    expected: { id: string; revision: number },
    mode: PlayMode
  ) {
    return run(async (isCurrent) => {
      const previous = window.value
      if (
        !previous ||
        previous.queue.id !== expected.id ||
        previous.queue.revision !== expected.revision ||
        !previous.items.some((entry) => entry.queueEntryId === entryId && entry.track)
      )
        return null
      await commit({ kind: 'select', entryId })
      return isCurrent() ? publish(await readSelection(mode, isCurrent)) : null
    })
  }

  function edit(
    edit: LibraryQueueEdit,
    mode: PlayMode,
    expected?: ExpectedQueue,
    options?: { recordUndo?: boolean }
  ) {
    return run(async (isCurrent) => {
      assertExpected(expected)
      const items =
        edit.kind === 'insert' ? (edit.items ?? edit.trackIds?.map((id) => ({ id }))) : undefined
      if (edit.kind === 'insert' && items && items.length > LIBRARY_MAX_PAGE_SIZE) {
        // One command owns the lane for all batches; cursor/edit commands cannot
        // interleave, and a detach or unknown reply stops the remaining writes.
        let inserted = 0
        const batches = Array.from(
          { length: Math.ceil(items.length / LIBRARY_MAX_PAGE_SIZE) },
          (_, index) => index * LIBRARY_MAX_PAGE_SIZE
        )
        if (edit.afterEntryId && !edit.beforeEntryId) batches.reverse()
        try {
          for (const offset of batches) {
            if (!isCurrent()) return null
            const batch = items.slice(offset, offset + LIBRARY_MAX_PAGE_SIZE)
            const result = await commit(
              {
                kind: 'insert',
                items: batch,
                ...(edit.afterEntryId ? { afterEntryId: edit.afterEntryId } : {}),
                ...(edit.beforeEntryId ? { beforeEntryId: edit.beforeEntryId } : {})
              },
              options
            )
            if (!result || !isCurrent()) return null
            inserted += batch.length
          }
        } catch (error) {
          throw new Error(
            `已确认添加 ${inserted} 首；后续批次中断，请刷新队列后检查：${error instanceof Error ? error.message : String(error)}`
          )
        }
      } else await commit(edit, options)
      if (!isCurrent()) return null
      if (!source.state.queue?.total) {
        window.value = null
        return null
      }
      return firstPlayable(mode, isCurrent)
    })
  }
  function extend(items: LibraryQueueInsertItem[], mode: PlayMode) {
    return run(async (isCurrent) => {
      const result = await source.extend(items)
      if (!result || !isCurrent()) return null
      snapshot.value = result.queue
      return publish(await readSelection(mode, isCurrent))
    })
  }

  function undo(mode: PlayMode, expected?: ExpectedQueue) {
    return run(async (isCurrent) => {
      assertExpected(expected)
      const result = await source.undo(source.state.queue?.revision)
      if (!result || !isCurrent()) return null
      if (!source.state.queue?.total) {
        window.value = null
        return null
      }
      return firstPlayable(result.queue.playMode ?? mode, isCurrent)
    })
  }

  /** One player command owns the lane from the first source read to the last
   * insertion. No full selection array, array-source fallback or action replay. */
  function appendPages(
    produce: LibraryQueuePageProducer,
    mode: PlayMode,
    options: LibraryQueuePageOptions = {}
  ) {
    return run(async (isCurrent) => {
      let inserted = 0
      let accepting = true,
        failed = false,
        failure: unknown
      const state: { inFlight: Promise<void> | null } = { inFlight: null }
      const reject = (error: unknown): never => {
        if (!failed) {
          failed = true
          failure = error
        }
        throw failure
      }
      const check = () => {
        if (failed) throw failure
        if (options.signal?.aborted) throw new Error('队列添加已取消')
        if (!isCurrent()) throw new Error('播放来源已变化')
        options.guard?.()
      }
      const append = (items: readonly LibraryQueueInsertItem[]): Promise<void> => {
        let request: Promise<void>
        try {
          check()
          if (!accepting) throw new Error('队列数据源已关闭')
          if (state.inFlight) throw new Error('请等待上一批队列添加完成')
          if (!Array.isArray(items) || items.length > LIBRARY_PAGE_SIZE)
            throw new Error('每批最多添加 200 首')
          if (!items.length) return Promise.resolve()
          const batch = [...items]
          request = (async () => {
            const result = await commit({ kind: 'insert', items: batch })
            if (!result) throw new Error('播放来源已变化')
            // An acknowledged write remains confirmed even if cancellation or
            // a producer failure arrived while its reply was in flight.
            inserted += batch.length
            check()
          })().catch(reject)
          state.inFlight = request
          void request.then(
            () => {
              if (state.inFlight === request) state.inFlight = null
            },
            () => {
              if (state.inFlight === request) state.inFlight = null
            }
          )
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
          request = Promise.reject(failure)
          // A producer that forgets to await append must not release the lane
          // early or cause an unhandled rejection; the command reports it.
          void request.catch(() => {})
        }
        return request
      }
      try {
        try {
          check()
          await produce(append)
          if (state.inFlight) throw new Error('请等待每批队列添加完成后结束数据源')
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
        } finally {
          accepting = false
          // Join already-issued writes, including when the producer throws or
          // returns early. No later command can overtake an uncertain append.
          await state.inFlight?.catch(() => {})
        }
        check()
        const result = source.state.queue?.total
          ? await firstPlayable(mode, isCurrent, check)
          : null
        check()
        return { inserted, window: result }
      } catch (error) {
        throw new Error(
          `已确认添加 ${inserted} 首；后续批次中断，请刷新队列后检查：${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  }

  function refresh(mode: PlayMode) {
    return run(async (isCurrent) => {
      const refreshed = await source.refresh()
      if (!isCurrent() || !refreshed) return null
      snapshot.value = refreshed
      if (!refreshed.total) {
        window.value = null
        return null
      }
      return isCurrent() ? firstPlayable(refreshed.playMode ?? mode, isCurrent) : null
    })
  }

  function editPositions(
    action: { kind: 'remove'; index: number } | { kind: 'move'; from: number; to: number },
    mode: PlayMode
  ) {
    const expected = reference()
    return run(async (isCurrent) => {
      const queue = source.state.queue
      if (!expected || queue?.id !== expected.id || queue.revision !== expected.revision)
        throw new Error('播放队列已变化，请重新选择操作项')
      if (
        action.kind === 'move' &&
        (!Number.isSafeInteger(action.to) ||
          action.to < 0 ||
          action.to >= queue.total ||
          action.from === action.to)
      )
        return null
      const at = async (index: number) => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= queue.total) return null
        const page = await source.loadPage(Math.floor(index / LIBRARY_PAGE_SIZE))
        return page?.items[index % LIBRARY_PAGE_SIZE] ?? null
      }
      const from = await at(action.kind === 'remove' ? action.index : action.from)
      if (!from || !isCurrent()) return null
      let edit: LibraryQueueEdit = { kind: 'remove', entryIds: [from.queueEntryId] }
      if (action.kind === 'move') {
        const target = await at(action.to > action.from ? action.to + 1 : action.to)
        if (!isCurrent()) return null
        edit = {
          kind: 'move',
          entryId: from.queueEntryId,
          beforeEntryId: target?.queueEntryId ?? null
        }
      }
      await commit(edit)
      if (!isCurrent()) return null
      if (!source.state.queue?.total) {
        window.value = null
        return null
      }
      return firstPlayable(mode, isCurrent)
    })
  }

  /**
   * Visit a database queue one bounded detail page at a time. Callers that
   * need to materialize a document (for example, a JSON playlist) can stream
   * each page without ever replacing the renderer's queue with the complete
   * database membership. The normal playback command lane owns the visit, so
   * an edit cannot interleave between pages; detaching the source fences the
   * visit and returns null instead of publishing a partial result.
   */
  function forEachPage(
    visit: (page: LibraryQueuePage) => void | Promise<void>
  ): Promise<{ queue: LibraryQueueSnapshot; visited: number; tracks: number } | null> {
    return run(async (isCurrent) => {
      const expected = source.state.queue
      if (!expected) return null
      let visited = 0
      let tracks = 0
      let libraryRevision: number | null = null
      for (let pageNumber = 0; pageNumber * LIBRARY_PAGE_SIZE < expected.total; pageNumber++) {
        const page = await source.loadPage(pageNumber)
        if (
          !page ||
          !isCurrent() ||
          source.state.queue?.id !== expected.id ||
          source.state.queue.revision !== expected.revision ||
          page.revision !== expected.revision ||
          page.total !== expected.total ||
          (libraryRevision !== null &&
            source.state.libraryRevision !== null &&
            source.state.libraryRevision !== libraryRevision)
        )
          return null
        if (libraryRevision === null) libraryRevision = page.libraryRevision
        else if (page.libraryRevision !== libraryRevision) return null
        visited++
        tracks += page.items.reduce((count, item) => count + (item.track ? 1 : 0), 0)
        await visit(page)
      }
      if (
        !isCurrent() ||
        source.state.queue?.id !== expected.id ||
        source.state.queue.revision !== expected.revision ||
        source.state.libraryRevision !== libraryRevision
      )
        return null
      return { queue: { ...expected }, visited, tracks }
    })
  }

  function reference(): LibraryPlaybackQueueReference | null {
    const queue = active.value ? window.value?.queue : null
    return queue?.selectedEntryId
      ? {
          id: queue.id,
          revision: queue.revision,
          entryId: queue.selectedEntryId,
          index: queue.index
        }
      : null
  }

  function track(result = window.value): Track | null {
    const entry = result?.items[0]
    return entry?.track ? libraryQueueTrack(entry.track, entry.queueEntryId) : null
  }

  /** Called inside the player's existing native mutation lane. It does not
   * modify the cursor and never interprets the legacy queue as this window. */
  async function playbackWindow(current: Track, mode: PlayMode) {
    const generation = epoch
    if (!active.value || current.queueEntryId !== reference()?.entryId) return null
    const result = await source.playbackWindow(windowOptions(mode))
    if (
      generation !== epoch ||
      !active.value ||
      !result ||
      result.queue.selectedEntryId !== current.queueEntryId ||
      result.items[0]?.track?.id !== current.id
    )
      return null
    return publish(result)
  }

  /** Called in the session's commit lane, including inside stagePages' adopt
   * callback. Do not enqueue on run(): that callback already owns its lane. */
  async function replaceSource(command: CoreQueueSourceReplacement, mode: PlayMode) {
    const generation = epoch
    const repaired = await source.replaceSource(command)
    if (!repaired || generation !== epoch) throw new Error('Playback source detached during repair')
    const result = await source.playbackWindow(windowOptions(mode))
    if (!result || generation !== epoch) throw new Error('Cannot read the repaired playback window')
    publish(result)
    return result
  }

  return {
    active,
    window,
    snapshot,
    contentRevision,
    busy,
    create,
    restore,
    adoptLive,
    adoptStopped,
    navigate,
    select,
    selectEntry,
    acceptNative,
    edit,
    extend,
    appendPages,
    stagePages,
    undo,
    canUndo: () => source.canUndo,
    undoLabel: () => source.undoLabel,
    editPositions,
    refresh,
    reference,
    track,
    playbackWindow,
    replaceSource,
    forEachPage,
    detach,
    invalidateLibrary: (revision: number) => {
      source.invalidateLibrary(revision)
      contentRevision.value = Math.max(contentRevision.value, revision)
    },
    loadPage: (page: number) => source.loadPage(page),
    get diagnostics() {
      return source.state
    },
    dispose: () => {
      detach()
      source.dispose()
    }
  }
}
