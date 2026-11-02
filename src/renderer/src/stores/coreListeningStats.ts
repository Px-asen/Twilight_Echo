import { computed, shallowReadonly, shallowRef, watch, type ShallowRef } from 'vue'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { CoreStatisticsOverview, CoreStatisticsPage, CoreStatisticsQuery, CoreStatisticsTrackView } from '../../../shared/coreStatistics.ts'
import type { ListeningStatsClearRange } from '../../../shared/listeningStatsHistory.ts'

/** Bounded ranking windows are views; totals, artists and clearing use the full Core repository. */
export function createCoreListeningStats(options: {
  state: Readonly<ShallowRef<CoreSnapshot | null>>
  overview(signal: AbortSignal): Promise<CoreStatisticsOverview>
  page(query: CoreStatisticsQuery, signal: AbortSignal): Promise<CoreStatisticsPage>
  clear(range: ListeningStatsClearRange, revision: number): Promise<unknown>
}) {
  const overview = shallowRef<CoreStatisticsOverview | null>(null)
  const windows = shallowRef<Record<'recent' | 'plays' | 'seconds', CoreStatisticsTrackView[]>>({ recent: [], plays: [], seconds: [] })
  const error = shallowRef('')
  const pending = shallowRef(false)
  let active: AbortController | null = null
  let work: Promise<void> | null = null
  let disposed = false
  let historyRecovery: { epoch: string; revision: number } | null = null
  const key = () => {
    const state = options.state.value
    return state?.phase === 'ready' && state.statisticsRevision !== null
      ? `${state.epoch}:${state.statisticsRevision}` : ''
  }
  function refresh(): Promise<void> {
    active?.abort()
    const expected = key()
    if (!expected || disposed) {
      pending.value = false
      overview.value = null
      windows.value = { recent: [], plays: [], seconds: [] }
      return Promise.resolve()
    }
    const request = active = new AbortController()
    pending.value = true
    const task = (async () => {
      try {
        const summary = await options.overview(request.signal)
        const sorts = ['recent', 'plays', 'seconds'] as const
        const pages = await Promise.all(sorts.map(async (sort) => {
          const query = { sort, revision: summary.revision }
          const first = await options.page({ ...query, limit: 128 }, request.signal)
          if (first.total <= 128) return first.items
          const next = await options.page({ ...query, offset: 128, limit: 72 }, request.signal)
          return [...first.items, ...next.items]
        }))
        if (request.signal.aborted || key() !== expected || disposed) return
        overview.value = freeze(summary)
        windows.value = freeze({ recent: pages[0], plays: pages[1], seconds: pages[2] })
        error.value = ''
      } catch (failure) {
        if (!request.signal.aborted && key() === expected && !disposed) {
          error.value = failure instanceof Error ? failure.message : String(failure)
          throw failure
        }
      }
    })().finally(() => {
      if (work === task) work = null
      if (active === request) pending.value = false
    })
    work = task
    return task
  }
  const stop = watch(key, () => { void refresh().catch(() => {}) }, { immediate: true, flush: 'sync' })
  return {
    overview: shallowReadonly(overview), windows: shallowReadonly(windows), error: shallowReadonly(error),
    history: computed<CoreStatisticsOverview['history']>(() => {
      const history = overview.value?.history
      return {
        mode: history?.mode ?? null,
        ready: !!history?.ready && !error.value,
        pending: pending.value || !!history?.pending,
        revision: history?.revision ?? null,
        error: error.value || history?.error || ''
      }
    }),
    ready: computed(() => overview.value !== null && !error.value),
    async ensure() {
      await (work ?? (overview.value ? Promise.resolve() : refresh()))
      if (error.value) throw new Error(error.value)
    },
    refresh,
    recoverHistory(revision: number | undefined, failure: unknown): boolean {
      if (
        disposed || !key() || revision === undefined ||
        (failure as { code?: unknown } | null)?.code !== 'STALE_HISTORY_REVISION'
      ) return false
      const epoch = options.state.value!.epoch
      if (historyRecovery?.epoch === epoch && revision <= historyRecovery.revision) return false
      // Concurrent page failures share one refresh. Never loop if Core returns
      // the same fence, and never replay a selection or playback command.
      historyRecovery = { epoch, revision }
      void refresh().catch(() => {})
      return true
    },
    async clear(range: ListeningStatsClearRange, revision?: number): Promise<boolean> {
      if (!overview.value) throw new Error('聆听统计尚未就绪')
      await options.clear(range, revision ?? overview.value.revision)
      await refresh()
      return !overview.value?.persistence.dirty
    },
    dispose() { disposed = true; active?.abort(); stop() }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
