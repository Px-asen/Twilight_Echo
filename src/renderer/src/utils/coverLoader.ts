/**
 * Cover image loader.
 *
 * Track.cover stores a lightweight handle:
 * - `cover://<hash>.jpg` — local disk cache (must be materialized for display)
 * - `data:` — legacy embedded library covers
 * - `twilight-media://image/<token>` — in-memory remote-media grant (session-scoped)
 * - `http(s):` — rare pass-through when protection did not rewrite the field
 *
 * Remote provider covers are protected in main with a grant *and* a durable
 * `coverSource` (http/https). After process restart the grant map is empty, so
 * display paths re-issue a grant from `coverSource` before setting <img src>.
 *
 * IMPORTANT: never put raw `cover://` / `background://` into <img src> long-term.
 * Chromium's custom-protocol image cache can keep painting the first decoded
 * bitmap across track switches after a cold start (remount / navigation fixes
 * it). Materialize local handles to `data:` via IPC so each distinct cover is a
 * unique, cache-safe src.
 */

import { ref, type Ref, watch, type ComputedRef } from 'vue'
import { clearDominantColorCache } from './colorExtractor.ts'
import { recordCoverDiagnostic } from './coverDiagnostics.ts'

const remoteCoverGrantCache = new Map<string, string>()
const remoteCoverGrantInflight = new Map<string, Promise<string | null>>()
const localCoverDataCache = new Map<string, string>()
const localCoverDataInflight = new Map<string, Promise<string | null>>()

const LOCAL_COVER_DATA_CACHE_LIMIT = 128
// Conservatively count UTF-16 storage; entry count alone does not bound large art.
const LOCAL_COVER_DATA_CACHE_BYTES = 16 * 1024 * 1024
let localCoverDataBytes = 0
let localCoverGeneration = 0
let remoteCoverGeneration = 0

/** Insert a materialized cover while keeping the renderer cache bounded. */
function cacheLocalCoverData(handle: string, dataUrl: string): void {
  const previous = localCoverDataCache.get(handle)
  if (previous) localCoverDataBytes -= previous.length * 2
  localCoverDataCache.delete(handle)
  const bytes = dataUrl.length * 2
  if (bytes > LOCAL_COVER_DATA_CACHE_BYTES) return
  localCoverDataCache.set(handle, dataUrl)
  localCoverDataBytes += bytes
  while (
    localCoverDataCache.size > LOCAL_COVER_DATA_CACHE_LIMIT ||
    localCoverDataBytes > LOCAL_COVER_DATA_CACHE_BYTES
  ) {
    const oldest = localCoverDataCache.keys().next().value
    if (typeof oldest !== 'string') break
    localCoverDataBytes -= localCoverDataCache.get(oldest)!.length * 2
    localCoverDataCache.delete(oldest)
  }
}

function isTwilightMediaImageHandle(handle: string): boolean {
  return /^twilight-media:\/\/image\//i.test(handle.trim())
}

function isDurableRemoteCoverSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim())
}

function isProtocolLocalCoverHandle(handle: string): boolean {
  return /^cover:/i.test(handle) || /^background:/i.test(handle)
}

function isDisplayableCoverHandle(handle: string): boolean {
  // Protocol-local handles are NOT immediately safe for <img> after cold start —
  // they must be materialized first. data/blob/twilight-media can paint now.
  return /^data:/i.test(handle) || /^blob:/i.test(handle) || isTwilightMediaImageHandle(handle)
}

function bareLocalCoverHandle(handle: string): string {
  // Drop fragment/query cache-bust suffixes before IPC / disk lookup.
  return handle.trim().split(/[?#]/, 1)[0]
}

export type CoverDisplaySize = 'sm' | 'md'

function localCoverCacheKey(bare: string, size?: CoverDisplaySize): string {
  return size === 'sm' ? `${bare}?size=sm` : bare
}

/** Synchronous first paint for virtualized cards whose artwork is already resolved. */
export function readCachedCover(
  handle: string | null | undefined,
  durableSource?: string | null,
  size?: CoverDisplaySize
): string | null {
  const trimmed = typeof handle === 'string' ? handle.trim() : ''
  if (trimmed && isProtocolLocalCoverHandle(trimmed)) {
    const bare = bareLocalCoverHandle(trimmed)
    const key = localCoverCacheKey(bare, size)
    const cached = localCoverDataCache.get(key)
    if (!cached) return null
    localCoverDataCache.delete(key)
    localCoverDataCache.set(key, cached)
    return cached
  }
  if (/^(data|blob):/i.test(trimmed)) return trimmed
  const source =
    typeof durableSource === 'string' && isDurableRemoteCoverSource(durableSource)
      ? durableSource.trim()
      : isDurableRemoteCoverSource(trimmed)
        ? trimmed
        : null
  if (source) return remoteCoverGrantCache.get(source) ?? null
  return trimmed || null
}

/**
 * Resolve a cover handle to a displayable image src.
 * - `null` / empty → returns null (or re-grants from durableSource when present)
 * - `cover://` / `background://` → materialized `data:` (avoids protocol cache stickiness)
 * - `data:` / `blob:` → returned as-is
 * - durable `coverSource` (http/https) when no local handle → re-granted twilight-media
 * - bare http(s) `cover` (legacy stats) → re-granted for CSP
 * - live `twilight-media:` without durable origin → returned as-is
 */
export async function resolveCover(
  handle: string | null | undefined,
  durableSource?: string | null,
  size?: CoverDisplaySize
): Promise<string | null> {
  const source =
    typeof durableSource === 'string' && isDurableRemoteCoverSource(durableSource)
      ? durableSource.trim()
      : null

  const trimmedHandle = typeof handle === 'string' && handle.trim() ? handle.trim() : null

  // Local disk art always wins over durable remote origin. Provider enrichment
  // may attach coverSource while the track still has a correct cover:// handle;
  // preferring remote after restart made playbar/home art sticky or wrong.
  if (trimmedHandle && isProtocolLocalCoverHandle(trimmedHandle)) {
    const materialized = await materializeLocalCoverForDisplay(trimmedHandle, size)
    if (materialized) return materialized
    // Last resort: raw protocol URL (may stick in Chromium — prefer materialize).
    return bareLocalCoverHandle(trimmedHandle)
  }

  if (trimmedHandle && (/^data:/i.test(trimmedHandle) || /^blob:/i.test(trimmedHandle))) {
    return trimmedHandle
  }

  // Prefer durable origin for remote-only rows (session restore / listening stats).
  if (source) {
    const granted = await grantRemoteCoverForDisplay(source)
    if (granted) return granted
    if (trimmedHandle && isTwilightMediaImageHandle(trimmedHandle)) {
      return trimmedHandle
    }
    return null
  }

  if (!trimmedHandle) return null

  if (isDurableRemoteCoverSource(trimmedHandle)) {
    const granted = await grantRemoteCoverForDisplay(trimmedHandle)
    if (granted) return granted
    return null
  }

  if (isTwilightMediaImageHandle(trimmedHandle)) {
    return trimmedHandle
  }

  return trimmedHandle
}

async function materializeLocalCoverForDisplay(
  handle: string,
  size?: CoverDisplaySize
): Promise<string | null> {
  const bare = bareLocalCoverHandle(handle)
  if (!bare) return null
  const cacheKey = localCoverCacheKey(bare, size)

  const cached = localCoverDataCache.get(cacheKey)
  if (cached) {
    localCoverDataCache.delete(cacheKey)
    localCoverDataCache.set(cacheKey, cached)
    return cached
  }

  const inflight = localCoverDataInflight.get(cacheKey)
  if (inflight) return inflight
  const generation = localCoverGeneration

  const request = (async () => {
    try {
      const api = (
        globalThis as {
          window?: {
            api?: {
              data?: {
                getCover?: (
                  src: string,
                  size?: CoverDisplaySize
                ) => Promise<string | Uint8Array | null>
              }
            }
          }
        }
      ).window?.api?.data
      if (api?.getCover) {
        const response =
          size === 'sm' ? await api.getCover(bare, 'sm') : await api.getCover(bare)
        if (typeof response === 'string' && response.startsWith('data:')) {
          const dataUrl = response
          if (generation === localCoverGeneration) cacheLocalCoverData(cacheKey, dataUrl)
          return dataUrl
        }
        const materialized = await coverBytesToDataUrl(response, bare)
        if (materialized) {
          if (generation === localCoverGeneration) cacheLocalCoverData(cacheKey, materialized)
          return materialized
        }
      }

      // Fallback when IPC is unavailable (tests / early boot): fetch protocol.
      if (typeof fetch === 'function') {
        const response = await fetch(bare)
        if (!response.ok) return null
        const blob = await response.blob()
        const dataUrl = await blobToDataUrl(blob)
        if (dataUrl) {
          if (generation === localCoverGeneration) cacheLocalCoverData(cacheKey, dataUrl)
          return dataUrl
        }
      }
      return null
    } catch {
      return null
    } finally {
      if (generation === localCoverGeneration) localCoverDataInflight.delete(cacheKey)
    }
  })()

  localCoverDataInflight.set(cacheKey, request)
  return request
}

function sniffCoverBytesMime(bytes: Uint8Array, handle: string): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  const extension = handle.split(/[?#]/, 1)[0].toLowerCase()
  return extension.endsWith('.png')
    ? 'image/png'
    : extension.endsWith('.webp')
      ? 'image/webp'
      : extension.endsWith('.gif')
        ? 'image/gif'
        : 'image/jpeg'
}

async function coverBytesToDataUrl(value: unknown, handle: string): Promise<string | null> {
  let bytes: Uint8Array | null = null
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (!bytes || bytes.byteLength === 0) return null
  const type = sniffCoverBytesMime(bytes, handle)
  return blobToDataUrl(new Blob([bytes as unknown as BlobPart], { type }))
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

async function grantRemoteCoverForDisplay(source: string): Promise<string | null> {
  const normalized = source.trim()
  if (!normalized) return null
  return ensureCachedRemoteGrant(normalized)
}

/** Drop a single origin from the grant cache so the next resolve re-issues a token. */
export function invalidateRemoteCoverGrant(source: string): void {
  const normalized = source.trim()
  if (!normalized) return
  remoteCoverGrantCache.delete(normalized)
  remoteCoverGrantInflight.delete(normalized)
}

async function ensureCachedRemoteGrant(source: string): Promise<string | null> {
  const normalized = source.trim()
  if (!normalized) return null
  const existing = remoteCoverGrantCache.get(normalized)
  if (existing) return existing

  const inflight = remoteCoverGrantInflight.get(normalized)
  if (inflight) return inflight
  const generation = remoteCoverGeneration

  const request = (async () => {
    try {
      const api = (
        globalThis as {
          window?: { api?: { data?: { grantRemoteCover?: (src: string) => Promise<string> } } }
        }
      ).window?.api?.data
      if (!api?.grantRemoteCover) {
        recordCoverDiagnostic('grant.unavailable', null, normalized, {}, 'warn')
        return null
      }
      const granted = await api.grantRemoteCover(normalized)
      if (typeof granted === 'string' && granted.trim()) {
        const token = granted.trim()
        if (generation === remoteCoverGeneration) remoteCoverGrantCache.set(normalized, token)
        if (remoteCoverGrantCache.size > 256) {
          const first = remoteCoverGrantCache.keys().next().value
          if (first) remoteCoverGrantCache.delete(first)
        }
        return token
      }
      recordCoverDiagnostic('grant.empty', null, normalized, {}, 'warn')
      return null
    } catch {
      recordCoverDiagnostic('grant.failed', null, normalized, {}, 'warn')
      return null
    } finally {
      if (generation === remoteCoverGeneration) remoteCoverGrantInflight.delete(normalized)
    }
  })()

  remoteCoverGrantInflight.set(normalized, request)
  return request
}

/** Clear re-grant cache (tests / after clear-cache). */
export function clearRemoteCoverGrantCache(): void {
  remoteCoverGeneration += 1
  remoteCoverGrantCache.clear()
  remoteCoverGrantInflight.clear()
}

export function clearLocalCoverDataCache(): void {
  localCoverGeneration += 1
  localCoverDataCache.clear()
  localCoverDataBytes = 0
  localCoverDataInflight.clear()
}

/**
 * Vue composable: reactively resolve a cover handle (and optional durable origin).
 * Returns a ref that updates when either input changes.
 * Never leaves a previous track's art painted while the next cover resolves.
 */
export function useCover(
  handleRef: ComputedRef<string | null | undefined> | Ref<string | null | undefined>,
  sourceRef?: ComputedRef<string | null | undefined> | Ref<string | null | undefined>
): Ref<string | null> {
  const resolved = ref<string | null>(null)
  let requestId = 0

  watch(
    () => [handleRef.value, sourceRef?.value] as const,
    ([handle, source], previous) => {
      const id = ++requestId
      const trimmed = typeof handle === 'string' && handle.trim() ? handle.trim() : null
      const inputsChanged = !previous || previous[0] !== handle || previous[1] !== source

      // Always clear on input change so Chromium cannot keep the previous bitmap
      // while async materialize / re-grant runs (protocol-local handles included).
      if (inputsChanged) {
        resolved.value = null
      }

      // Only paint handles that are safe without async work.
      if (trimmed && isDisplayableCoverHandle(trimmed) && !isProtocolLocalCoverHandle(trimmed)) {
        resolved.value = trimmed
      }

      void resolveCover(handle, source).then((next) => {
        if (id !== requestId) return
        resolved.value = next
      })
    },
    { immediate: true }
  )

  return resolved
}

/** Clear local + remote cover display caches. */
export function clearCoverCache(): void {
  clearDominantColorCache()
  clearRemoteCoverGrantCache()
  clearLocalCoverDataCache()
}
