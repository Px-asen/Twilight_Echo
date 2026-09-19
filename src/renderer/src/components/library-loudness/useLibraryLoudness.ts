import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  triggerRef,
  watch,
  type Ref
} from 'vue'
import {
  idleLoudnessBatchStatus,
  type LibraryLoudnessApi,
  type LibraryLoudnessResult,
  type LoudnessBatchItem,
  type LoudnessBatchProgress,
  type LoudnessBatchSnapshot,
  type LoudnessInputGroup
} from '../../../../shared/libraryLoudness.ts'

export function useLibraryLoudness(groups: Ref<LoudnessInputGroup[]>, api: LibraryLoudnessApi) {
  const status = ref(idleLoudnessBatchStatus())
  const items = shallowRef(new Map<string, LoudnessBatchItem>())
  const results = shallowRef(new Map<string, LibraryLoudnessResult>())
  const error = ref('')
  const busy = ref(false)
  const loading = ref(false)
  const running = computed(() => ['running', 'cancelling'].includes(status.value.state))
  const groupIndex = computed(() => new Map(groups.value.map((group) => [group.id, group])))
  const retryGroups = computed(() =>
    running.value
      ? []
      : groups.value.filter((group) => {
          const state = items.value.get(group.id)?.state
          return (
            state === 'failed' ||
            state === 'cancelled' ||
            (status.value.state === 'cancelled' && (state === 'queued' || state === 'analyzing'))
          )
        })
  )
  let disposed = false
  let epoch = 0
  let requestId = 0
  let unsubscribe: (() => void) | undefined
  let failedAction: (() => Promise<void>) | undefined
  const latestQueries = new Map<string, number>()

  function applySnapshot(snapshot: LoudnessBatchSnapshot): void {
    if (disposed) return
    if (snapshot.status.revision < status.value.revision) {
      if (snapshot.status.jobId === status.value.jobId) {
        for (const item of snapshot.items)
          if (!items.value.has(item.id)) items.value.set(item.id, item)
        triggerRef(items)
      }
      return
    }
    status.value = snapshot.status
    items.value = new Map(snapshot.items.map((item) => [item.id, item]))
  }

  async function query(batch: LoudnessInputGroup[]): Promise<void> {
    const queryEpoch = epoch
    const id = ++requestId
    for (const group of batch) latestQueries.set(group.id, id)
    const values = await api.getResults(batch)
    if (disposed || queryEpoch !== epoch) return
    for (const result of values) {
      if (latestQueries.get(result.id) === id) results.value.set(result.id, result)
    }
    triggerRef(results)
  }

  async function refresh(): Promise<void> {
    const queryEpoch = ++epoch
    latestQueries.clear()
    results.value = new Map()
    loading.value = true
    const planned = groups.value
    try {
      for (let offset = 0; offset < planned.length; offset += 100) {
        if (disposed || queryEpoch !== epoch) return
        await query(planned.slice(offset, offset + 100))
      }
    } finally {
      if (queryEpoch === epoch) loading.value = false
    }
  }

  function progress(event: LoudnessBatchProgress): void {
    if (disposed || event.status.revision < status.value.revision) return
    if (event.status.jobId !== status.value.jobId) items.value = new Map()
    status.value = event.status
    if (!event.item) return
    items.value.set(event.item.id, event.item)
    triggerRef(items)
    if (event.item.state === 'analyzing' || event.item.state === 'failed') {
      latestQueries.set(event.item.id, ++requestId)
      results.value.delete(event.item.id)
      triggerRef(results)
    }
    const group = groupIndex.value.get(event.item.id)
    if (group && ['completed', 'cached'].includes(event.item.state)) {
      void query([group]).catch((reason) => {
        if (!disposed) error.value = errorText(reason)
      })
    }
  }

  async function action(operation: () => Promise<void>): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
      await operation()
      failedAction = undefined
    } catch (reason) {
      if (!disposed) {
        error.value = errorText(reason)
        failedAction = operation
      }
    } finally {
      busy.value = false
    }
  }

  const start = (retry = false) =>
    action(async () => {
      const planned = retry ? retryGroups.value : groups.value
      if (planned.length) applySnapshot(await api.startBatch(planned))
    })
  const cancel = () =>
    action(async () => {
      if (status.value.jobId) await api.cancelBatch(status.value.jobId)
      applySnapshot(await api.getBatch())
    })
  const clear = () =>
    action(async () => {
      await api.clearResults(groups.value.map((group) => group.id))
      items.value = new Map()
      await refresh()
    })
  const reload = async () => {
    error.value = ''
    try {
      applySnapshot(await api.getBatch())
      await refresh()
    } catch (reason) {
      if (!disposed) {
        error.value = errorText(reason)
        failedAction = undefined
      }
    }
  }
  const retryAction = () => (failedAction ? action(failedAction) : reload())

  watch(groups, () => {
    void refresh().catch((reason) => {
      if (!disposed) error.value = errorText(reason)
    })
  })
  onMounted(() => {
    unsubscribe = api.onBatchProgress(progress)
    void reload()
  })
  onBeforeUnmount(() => {
    disposed = true
    epoch++
    unsubscribe?.()
  })
  return {
    status,
    items,
    results,
    error,
    busy,
    loading,
    running,
    retryGroups,
    start,
    cancel,
    clear,
    reload,
    retryAction
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
