import { onScopeDispose, shallowReadonly, shallowRef, watch } from 'vue'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

/** Query results are disposable projections fenced by the state that requested them.
 * Cancel obsolete reads so slow transports do not retain a queue of stale projections. */
export function createCorePlayerResource<T>(
  key: () => string,
  query: (signal: AbortSignal) => Promise<T>,
  failed: (error: unknown) => void
) {
  const value = shallowRef<T | null>(null)
  const loading = shallowRef(false)
  let generation = 0
  let controller: AbortController | null = null
  let disposed = false
  async function refresh(): Promise<void> {
    if (disposed) return
    const expected = key(),
      request = ++generation
    controller?.abort()
    controller = null
    if (!expected) {
      value.value = null
      loading.value = false
      return
    }
    const active = new AbortController()
    controller = active
    loading.value = true
    try {
      const result = await query(active.signal)
      if (request === generation && expected === key()) value.value = freeze(result)
    } catch (error) {
      if (active.signal.aborted) return
      if (request === generation) failed(error)
      throw error
    } finally {
      if (request === generation) loading.value = false
      if (controller === active) controller = null
    }
  }
  watch(
    key,
    () => {
      void refresh().catch(() => {})
    },
    { immediate: true }
  )
  onScopeDispose(() => {
    disposed = true
    generation++
    controller?.abort()
    controller = null
    loading.value = false
  })
  return { value: shallowReadonly(value), loading: shallowReadonly(loading), refresh }
}
