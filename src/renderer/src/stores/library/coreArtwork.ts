import { useCoreConnection, type createCoreConnectionStore } from '../coreConnection.ts'

type Client = Pick<ReturnType<typeof createCoreConnectionStore>, 'state' | 'attach' | 'query'>
type Waiting = { resolve(value: string | null): void; reject(error: unknown): void }

/** One page of requested artwork at a time; cache contains display grants only. */
export function createCoreArtwork(core: Client, revision: () => number | null) {
  const cache = new Map<string, string | null>()
  const pending = new Map<string, Waiting[]>()
  let current = '',
    pumping = false
  const epoch = () => (core.state.value?.phase === 'ready' ? core.state.value.epoch : '')
  const key = () => (epoch() ? `${epoch()}:${revision()}` : '')
  function sync() {
    const next = key()
    if (next !== current) {
      cache.clear()
      current = next
    }
    return next
  }
  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      if (!key()) await core.attach()
      while (pending.size) {
        const expected = sync(),
          ids = [...pending.keys()].slice(0, 200)
        const waiting = ids.map((id) => ({ id, requests: pending.get(id)! }))
        for (const id of ids) pending.delete(id)
        try {
          const page = await core.query('library.artwork', {
            ids,
            ...(revision() === null ? {} : { revision: revision()! })
          })
          const results = new Map(page.items.map((item) => [item.id, item.cover]))
          const active = expected === key()
          for (const item of waiting) {
            const cover = active ? (results.get(item.id) ?? null) : null
            if (active) {
              cache.delete(item.id)
              cache.set(item.id, cover)
              if (cache.size > 512) cache.delete(cache.keys().next().value!)
            }
            for (const request of item.requests) request.resolve(cover)
          }
        } catch (error) {
          for (const item of waiting) for (const request of item.requests) request.reject(error)
        }
      }
    } catch (error) {
      for (const requests of pending.values()) for (const request of requests) request.reject(error)
      pending.clear()
    } finally {
      pumping = false
    }
  }
  return {
    epoch,
    key,
    read(id: string, refresh = false): Promise<string | null> {
      sync()
      if (refresh) cache.delete(id)
      if (cache.has(id)) return Promise.resolve(cache.get(id)!)
      return new Promise((resolve, reject) => {
        const waiting = pending.get(id) ?? []
        waiting.push({ resolve, reject })
        pending.set(id, waiting)
        queueMicrotask(() => {
          void pump()
        })
      })
    },
    clear() {
      cache.clear()
    },
    get cachedCount() {
      return cache.size
    }
  }
}

let singleton: ReturnType<typeof createCoreArtwork> | undefined
function artwork() {
  const core = useCoreConnection()
  return (singleton ??= createCoreArtwork(core, () => core.state.value?.libraryRevision ?? null))
}
export const coreArtworkKey = () => artwork().key()
export const coreArtworkEpoch = () => artwork().epoch()
export const readCoreArtwork = (id: string, refresh = false) => artwork().read(id, refresh)
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    singleton = undefined
  })
