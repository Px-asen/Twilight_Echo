import { runtime } from '../core/runtime'
import { getCoverCacheDir, resizeCoverImageBytes } from '../library/coverCache.ts'
import { createRemoteCoverCache } from './remoteCoverCache.ts'
import { createMetadataArtworkCache } from './metadataArtworkCache.ts'

/** Protocol requests and Core maintenance must use the same writer lifetime. */
const transient = createRemoteCoverCache(
  () => (runtime.appSettings.cachePolicy.cover ? getCoverCacheDir() : null),
  { resize: resizeCoverImageBytes }
)

export const metadataArtworkCache = createMetadataArtworkCache(
  () => (runtime.appSettings.cachePolicy.cover ? getCoverCacheDir() : null),
  { resize: resizeCoverImageBytes, fetch: (source, init) => globalThis.fetch(source, init) }
)

// A single maintenance boundary fences both stores, including in-flight fetches.
export const mediaCoverCache = {
  generation: transient.generation,
  write: transient.write,
  resize: resizeCoverImageBytes,
  read: async (source: string) =>
    (await metadataArtworkCache.read(source)) ?? transient.read(source),
  maintain: <T>(action: () => Promise<T>) =>
    transient.maintain(() => metadataArtworkCache.maintain(action))
}
