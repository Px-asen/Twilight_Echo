import { LIBRARY_PAGE_SIZE, type LibraryQueueSnapshot } from '../../shared/libraryDatabase.ts'
import type {
  LibraryQueueBuildApi,
  LibraryQueueBuildCommand
} from '../../shared/libraryQueueBuild.ts'
import type { LibraryQueueApi } from './libraryQueueSource.ts'
import type { LibraryQueuePageOptions } from './libraryPlaybackController.ts'

type Item = Extract<LibraryQueueBuildCommand, { kind: 'append' }>['items'][number]
export type LibraryQueueSeedProducer = (
  append: (items: readonly Item[]) => Promise<void>
) => Promise<unknown>
export type LibraryQueueSeedPage = Item[]
/** Pulls the next seed page, or null once the source is exhausted. Shared by
 * the one-shot producer and by a background drain that keeps appending after
 * the first page is already playing. */
export type LibraryQueueSeedBatch = () => Promise<LibraryQueueSeedPage | null>

/** Construct a hidden seed without touching the live source. One page in
 * flight, once-only writes and a final guard also cover producer mistakes. */
export async function buildLibraryQueuePages(
  api: LibraryQueueBuildApi & Pick<LibraryQueueApi, 'deleteQueue'>,
  produce: LibraryQueueSeedProducer,
  start: {
    id?: string
    contentRevision: number
    order: 'original' | 'shuffle'
    selectedIndex?: number | (() => number)
  },
  options: LibraryQueuePageOptions = {}
): Promise<LibraryQueueSnapshot> {
  start = { ...start }
  const id = start.id ?? crypto.randomUUID()
  let accepting = false,
    failed = false,
    failure: unknown
  let sequence = 0,
    total = 0
  let ready: LibraryQueueSnapshot | undefined
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
    if (options.signal?.aborted) throw new Error('队列构建已取消')
    options.guard?.()
  }
  const append = (items: readonly Item[]): Promise<void> => {
    let request: Promise<void>
    try {
      check()
      if (!accepting) throw new Error('队列数据源已关闭')
      if (state.inFlight) throw new Error('请等待上一批队列构建完成')
      if (!Array.isArray(items) || items.length > LIBRARY_PAGE_SIZE)
        throw new Error('每批最多构建 200 首')
      if (!items.length) return Promise.resolve()
      const batch = structuredClone([...items])
      request = (async () => {
        const reply = await api.buildQueue({
          kind: 'append',
          id,
          sequence: ++sequence,
          items: batch
        })
        if (
          reply.kind !== 'building' ||
          reply.id !== id ||
          reply.sequence !== sequence ||
          reply.total !== total + batch.length
        )
          throw new Error('队列批次回复无效，请重新开始，不要重放批次')
        total = reply.total
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
      void request.catch(() => {})
    }
    return request
  }
  check()
  try {
    const opened = await api.buildQueue({
      kind: 'begin',
      id,
      contentRevision: start.contentRevision,
      order: start.order
    })
    if (
      opened.kind !== 'building' ||
      opened.id !== id ||
      opened.sequence !== 0 ||
      opened.total !== 0
    )
      throw new Error('队列构建回复无效')
    check()
    accepting = true
    try {
      await produce(append)
      if (state.inFlight) throw new Error('请等待每批队列构建完成后结束数据源')
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    } finally {
      accepting = false
      await state.inFlight?.catch(() => {})
    }
    check()
    const selectedIndex =
      (typeof start.selectedIndex === 'function' ? start.selectedIndex() : start.selectedIndex) ??
      (total ? 0 : -1)
    const reply = await api.buildQueue({ kind: 'commit', id, sequence: ++sequence, selectedIndex })
    if (reply.kind === 'ready') ready = reply.queue
    check()
    if (
      reply.kind !== 'ready' ||
      reply.id !== id ||
      reply.queue.total !== total ||
      reply.queue.index !== selectedIndex ||
      reply.queue.order !== start.order
    )
      throw new Error('队列发布回复无效，未切换播放来源')
    return reply.queue
  } catch (error) {
    if (ready) await api.deleteQueue(ready.id, ready.revision).catch(() => {})
    else await api.buildQueue({ kind: 'abort', id }).catch(() => {})
    throw error
  } finally {
    accepting = false
  }
}
