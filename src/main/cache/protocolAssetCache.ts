import { readFile } from 'fs/promises'

const DEFAULT_MAX_CACHE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_CACHE_ENTRIES = 192
type ProtocolAssetBytes = NonSharedBuffer
export type { ProtocolAssetBytes }

interface ProtocolAssetCacheOptions {
  maxBytes?: number
  maxEntries?: number
  read?: (path: string) => Promise<ProtocolAssetBytes>
}

/** Cache owns its bytes and pending reads. Limits apply to retained data, not HTTP response size. */
export function createProtocolAssetCache(options: ProtocolAssetCacheOptions = {}) {
  const cached = new Map<string, ProtocolAssetBytes>()
  const pending = new Map<string, Promise<ProtocolAssetBytes | null>>()
  const read = options.read ?? readFile
  let totalBytes = 0
  let generation = 0
  let maxBytes = budget(options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES)
  const maxEntries = budget(options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES)

  function evictOverflow(): void {
    while (totalBytes > maxBytes || cached.size > maxEntries) {
      const oldest = cached.keys().next().value
      if (oldest === undefined) break
      totalBytes -= cached.get(oldest)!.byteLength
      cached.delete(oldest)
    }
  }

  async function readPath(path: string): Promise<ProtocolAssetBytes | null> {
    const hit = cached.get(path)
    if (hit) {
      cached.delete(path)
      cached.set(path, hit)
      return hit
    }
    let request = pending.get(path)
    if (!request) {
      const startedGeneration = generation
      request = read(path)
        .then((bytes) => {
          // Oversized responses are served once without evicting useful small assets.
          if (startedGeneration === generation && bytes.byteLength <= maxBytes && maxEntries > 0) {
            cached.set(path, bytes)
            totalBytes += bytes.byteLength
            evictOverflow()
          }
          return bytes
        })
        .catch(() => null)
        .finally(() => {
          if (pending.get(path) === request) pending.delete(path)
        })
      pending.set(path, request)
    }
    return request
  }

  return {
    async read(...paths: string[]): Promise<ProtocolAssetBytes | null> {
      for (const path of paths) {
        const bytes = await readPath(path)
        if (bytes) return bytes
      }
      return null
    },
    clear() {
      generation++
      cached.clear()
      pending.clear()
      totalBytes = 0
    },
    setMaxBytes(bytes: number) {
      maxBytes = budget(bytes)
      evictOverflow()
    },
    stats() {
      return { cachedBytes: totalBytes, cachedEntries: cached.size, pendingReads: pending.size }
    }
  }
}

function budget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid cache budget')
  return value
}

const cache = createProtocolAssetCache()

/** The existing protocol entry point shares one process-local, bounded LRU. */
export const readCachedProtocolFile = cache.read
export const clearProtocolAssetCache = cache.clear

export function resetProtocolAssetCacheForTests(): void {
  cache.clear()
  cache.setMaxBytes(DEFAULT_MAX_CACHE_BYTES)
}

export const setProtocolAssetCacheMaxBytesForTests = cache.setMaxBytes
