import { createHash, randomUUID } from 'node:crypto'
import { diagnosticContext, withDiagnosticContext, writeDiagnostic } from '../diagnostics/logger.ts'
import type { DiagnosticLevel } from '../../shared/diagnostics.ts'

export type RemoteMediaKind = 'audio' | 'image'
export type RemoteImageDisplaySize = 'sm' | 'grid' | 'md'

export interface RemoteMediaGrant {
  source: string
  kind: RemoteMediaKind
  /** Expiring metadata images bypass durable/browser caches. */
  expiresAt?: number
}

export interface RemoteMediaGrantServiceOptions {
  now?: () => number
  createToken?: () => string
  /** Use a stable source-derived image token so Chromium can reuse its cache. */
  deterministicImageTokens?: boolean
}

export interface RemoteMediaRequestHandlerOptions {
  imageCache?: {
    generation?: () => number
    read: (source: string) => Promise<Response | null>
    write: (
      source: string,
      type: string,
      bytes: Uint8Array,
      generation?: number
    ) => Promise<{ bytes: Uint8Array; contentType: string } | void | null>
    resize?: (
      bytes: Uint8Array,
      mime: string,
      maxWidth?: number,
      quality?: number
    ) => { bytes: Uint8Array; mime: string } | null
  }
  grants?: RemoteMediaGrantService
  fetch: (source: string, init: RequestInit) => Promise<Response>
}

interface StoredGrant extends RemoteMediaGrant {
  lastAccessAt: number
}

const AUDIO_IDLE_TTL_MS = 30 * 60 * 1000
const IMAGE_IDLE_TTL_MS = 24 * 60 * 60 * 1000
const GRANT_SWEEP_BATCH = 64
const MAX_IMAGE_RESPONSE_BYTES = 25 * 1024 * 1024
const MAX_AUDIO_RESPONSE_BYTES = 1024 * 1024 * 1024
const MAX_RESIZED_DERIVATIVE_ENTRIES = 192
const MAX_RESIZED_DERIVATIVE_BYTES = 2 * 1024 * 1024
// Provider CDNs (especially NetEase album art) routinely 302 to edge hosts.
// Follow a short, credential-free hop chain instead of failing every cover load.
const MAX_REMOTE_MEDIA_REDIRECTS = 5

export function upstreamFetchUrlForRemoteMedia(source: string, kind: RemoteMediaKind): string {
  if (kind !== 'image') return source
  try {
    const url = new URL(source)
    if (
      url.hostname.toLowerCase().endsWith('.music.126.net') &&
      !url.searchParams.has('param') &&
      !url.searchParams.has('thumbnail')
    ) {
      url.searchParams.set('param', '500y500')
      return url.toString()
    }
  } catch {
    // Keep original source if URL parsing fails.
  }
  return source
}

function imageResizeBudget(
  size: RemoteImageDisplaySize | undefined
): { width: number; quality: number } | null {
  if (size === 'sm') return { width: 128, quality: 80 }
  if (size === 'grid') return { width: 256, quality: 82 }
  return null
}

export class RemoteMediaGrantService {
  private readonly grants = new Map<string, StoredGrant>()
  private readonly now: () => number
  private readonly createToken: () => string
  private readonly deterministicImageTokens: boolean
  private sweep: MapIterator<[string, StoredGrant]> | null = null

  constructor(options: RemoteMediaGrantServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.createToken = options.createToken ?? randomUUID
    this.deterministicImageTokens =
      options.deterministicImageTokens ?? options.createToken === undefined
  }

  grant(source: string, kind: RemoteMediaKind, expiresAt?: number): string {
    const normalized = normalizeRemoteMediaSource(source)
    if (expiresAt !== undefined && (kind !== 'image' || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()))
      throw new Error('Remote image permission has expired')
    this.pruneExpired(this.now())
    const token =
      kind === 'image' && this.deterministicImageTokens
        ? deterministicImageToken(expiresAt === undefined ? normalized : JSON.stringify([normalized, expiresAt]))
        : this.createToken()
    if (!token || /[/?#]/.test(token)) throw new Error('Remote media grant token is invalid')
    this.grants.set(token, { source: normalized, kind, lastAccessAt: this.now(), ...(expiresAt === undefined ? {} : { expiresAt }) })
    const handle = `twilight-media://${kind}/${token}`
    writeDiagnostic(
      'media.remote',
      'grant.issued',
      { source: normalized, handleUrl: handle, kind },
      'debug'
    )
    return handle
  }

  resolve(url: string, expectedKind?: RemoteMediaKind): RemoteMediaGrant {
    const { token, kind } = parseGrantToken(url)
    const grant = this.grants.get(token)
    if (!grant) throw new Error('Remote media grant is unknown')
    if (grant.kind !== kind) throw new Error('Remote media grant kind is not authorized')
    if (expectedKind && grant.kind !== expectedKind) {
      throw new Error('Remote media grant kind is not authorized')
    }
    if (this.now() - grant.lastAccessAt > ttlFor(grant.kind) || (grant.expiresAt !== undefined && this.now() >= grant.expiresAt)) {
      this.grants.delete(token)
      throw new Error('Remote media grant has expired')
    }
    grant.lastAccessAt = this.now()
    return { source: grant.source, kind: grant.kind, ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) }
  }

  revokeAll(): void {
    this.grants.clear()
    this.sweep = null
  }

  /** Retire untouched grants incrementally; never evict a still-valid handle.
   * No timer or full-library sweep is needed on the playback/request path. */
  private pruneExpired(now: number): void {
    this.sweep ??= this.grants.entries()
    for (let i = 0; i < GRANT_SWEEP_BATCH; i++) {
      const next = this.sweep.next()
      if (next.done) {
        this.sweep = null
        return
      }
      const [token, grant] = next.value
      if (now - grant.lastAccessAt > ttlFor(grant.kind) || (grant.expiresAt !== undefined && now >= grant.expiresAt)) this.grants.delete(token)
    }
  }
}

export const remoteMediaGrants = new RemoteMediaGrantService()

export function createRemoteMediaRequestHandler(
  options: RemoteMediaRequestHandlerOptions
): (request: Request) => Promise<Response> {
  const grants = options.grants ?? remoteMediaGrants
  const resizedDerivatives = new Map<
    string,
    { bytes: Uint8Array; contentType: string; cacheControl: string | null }
  >()
  let resizedDerivativeBytes = 0
  let resizedDerivativeGeneration: number | undefined

  type CanonicalImageOutcome =
    | {
        kind: 'failure'
        status: number
        reason: string
        message: string
        error?: unknown
      }
    | {
        kind: 'uncached'
        status: number
        headers: Headers
        bytes: Uint8Array
        skipReason: string
      }
    | {
        kind: 'cached'
        status: number
        headers: Headers
        bytes: Uint8Array
        storedBytesReplaced: boolean
      }

  interface InFlightCanonicalImage {
    controller: AbortController
    generation: number | undefined
    waiters: number
    settled: boolean
    promise: Promise<CanonicalImageOutcome>
  }

  const inFlightCanonicalImages = new Map<string, InFlightCanonicalImage>()

  const syncDerivativeGeneration = (generation: number | undefined): void => {
    if (generation !== resizedDerivativeGeneration) {
      resizedDerivatives.clear()
      resizedDerivativeBytes = 0
      resizedDerivativeGeneration = generation
    }
  }

  const cacheResizedDerivative = (
    key: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string | null
  ): void => {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESIZED_DERIVATIVE_BYTES) return
    const existing = resizedDerivatives.get(key)
    if (existing) {
      resizedDerivativeBytes -= existing.bytes.byteLength
      resizedDerivatives.delete(key)
    }
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    resizedDerivatives.set(key, { bytes: copy, contentType, cacheControl })
    resizedDerivativeBytes += copy.byteLength
    while (
      resizedDerivatives.size > MAX_RESIZED_DERIVATIVE_ENTRIES ||
      resizedDerivativeBytes > MAX_RESIZED_DERIVATIVE_BYTES
    ) {
      const oldest = resizedDerivatives.keys().next().value
      if (oldest === undefined) break
      const evicted = resizedDerivatives.get(oldest)
      if (evicted) resizedDerivativeBytes -= evicted.bytes.byteLength
      resizedDerivatives.delete(oldest)
    }
  }

  const startCanonicalImageFetch = (
    singleflightKey: string,
    grant: RemoteMediaGrant,
    cacheGeneration: number | undefined,
    record: MediaDiagnostic
  ): InFlightCanonicalImage => {
    const controller = new AbortController()
    const entry: InFlightCanonicalImage = {
      controller,
      generation: cacheGeneration,
      waiters: 0,
      settled: false,
      promise: Promise.resolve({
        kind: 'failure',
        status: 502,
        reason: 'uninitialized',
        message: 'Remote media request failed'
      })
    }

    const run = async (): Promise<CanonicalImageOutcome> => {
      let upstream: Response
      try {
        const upstreamUrl = upstreamFetchUrlForRemoteMedia(grant.source, grant.kind)
        upstream = await fetchRemoteMediaWithRedirects(
          options.fetch,
          upstreamUrl,
          {
            method: 'GET',
            signal: controller.signal,
            headers: buildUpstreamRequestHeaders(grant.source, grant.kind, null)
          },
          record
        )
      } catch (error) {
        controller.signal.throwIfAborted()
        return {
          kind: 'failure',
          status: 502,
          reason: 'upstream-fetch',
          message: 'Remote media request failed',
          error
        }
      }

      if (!upstream.ok && upstream.status !== 206) {
        await cancelRemoteMediaBody(upstream)
        return {
          kind: 'failure',
          status: 502,
          reason: 'upstream-status',
          message: 'Remote media request failed'
        }
      }
      if (!isExpectedMediaType(upstream.headers.get('content-type'), grant.kind)) {
        await cancelRemoteMediaBody(upstream)
        return {
          kind: 'failure',
          status: 415,
          reason: 'content-type',
          message: 'Remote media type is not authorized'
        }
      }
      const maximumBytes = maxResponseBytesFor(grant.kind)
      const contentLength = parseContentLength(upstream.headers.get('content-length'))
      if (contentLength !== null && contentLength > maximumBytes) {
        await cancelRemoteMediaBody(upstream)
        return {
          kind: 'failure',
          status: 413,
          reason: 'content-length',
          message: 'Remote media response is too large'
        }
      }

      const baseHeaders = filteredResponseHeaders(upstream.headers)
      const shouldWriteCache =
        upstream.status === 200 &&
        !/no-store|no-cache|private|max-age\s*=\s*0(?:\D|$)/i.test(
          upstream.headers.get('cache-control') ?? ''
        )

      try {
        const bodyResponse = new Response(
          limitResponseBody(upstream.body, maximumBytes, record, controller.signal)
        )
        const bytes = new Uint8Array(await bodyResponse.arrayBuffer())
        controller.signal.throwIfAborted()
        if (!shouldWriteCache) {
          return {
            kind: 'uncached',
            status: upstream.status,
            headers: baseHeaders,
            bytes,
            skipReason: 'response-policy'
          }
        }
        const stored = await options.imageCache!.write(
          grant.source,
          upstream.headers.get('content-type') ?? '',
          bytes,
          cacheGeneration
        )
        const canonicalBytes = stored && stored.bytes.byteLength > 0 ? stored.bytes : bytes
        const headers = new Headers(baseHeaders)
        if (stored?.contentType) {
          headers.set('Content-Type', stored.contentType)
        }
        const storedBytesReplaced = Boolean(
          stored && stored.bytes.byteLength > 0 && stored.bytes !== bytes
        )
        if (storedBytesReplaced) {
          headers.delete('Content-Length')
        }
        return {
          kind: 'cached',
          status: upstream.status,
          headers,
          bytes: canonicalBytes,
          storedBytesReplaced
        }
      } catch (error) {
        controller.signal.throwIfAborted()
        return {
          kind: 'failure',
          status: 502,
          reason: 'body-or-cache-write',
          message: 'Remote image response failed',
          error
        }
      }
    }

    entry.promise = run().finally(() => {
      entry.settled = true
      if (inFlightCanonicalImages.get(singleflightKey) === entry) {
        inFlightCanonicalImages.delete(singleflightKey)
      }
    })
    entry.promise.catch(() => {})
    inFlightCanonicalImages.set(singleflightKey, entry)
    return entry
  }

  const awaitCanonicalImage = (
    singleflightKey: string,
    entry: InFlightCanonicalImage,
    signal: AbortSignal
  ): Promise<CanonicalImageOutcome> => {
    signal.throwIfAborted()
    entry.waiters += 1
    let detached = false
    return new Promise<CanonicalImageOutcome>((resolve, reject) => {
      const detach = () => {
        if (detached) return
        detached = true
        signal.removeEventListener('abort', onAbort)
        entry.waiters = Math.max(0, entry.waiters - 1)
        if (entry.waiters === 0 && !entry.settled) {
          if (inFlightCanonicalImages.get(singleflightKey) === entry) {
            inFlightCanonicalImages.delete(singleflightKey)
          }
          entry.controller.abort(signal.reason)
        }
      }
      const onAbort = () => {
        detach()
        try {
          signal.throwIfAborted()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        } catch (error) {
          reject(error)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      entry.promise.then(
        (outcome) => {
          if (detached) return
          detached = true
          signal.removeEventListener('abort', onAbort)
          entry.waiters = Math.max(0, entry.waiters - 1)
          resolve(outcome)
        },
        (error) => {
          if (detached) return
          detached = true
          signal.removeEventListener('abort', onAbort)
          entry.waiters = Math.max(0, entry.waiters - 1)
          reject(error)
        }
      )
    })
  }

  return (request) =>
    withDiagnosticContext({ requestId: randomUUID() }, async () => {
      request.signal.throwIfAborted()
      const started = performance.now()
      const context = { ...diagnosticContext() }
      let source: string | undefined = undefined
      const record: MediaDiagnostic = (event, details = {}, level = 'debug') => {
        writeDiagnostic(
          'media.remote',
          event,
          {
            handleUrl: request.url,
            source,
            method: request.method,
            durationMs: performance.now() - started,
            ...details
          },
          level,
          context
        )
      }
      record('request.start')
      const fail = (status: number, reason: string, message: string, error?: unknown) => {
        record(
          'request.failed',
          { status, reason, ...(error === undefined ? {} : { error }) },
          'warn'
        )
        return failedRemoteMediaResponse(status, message)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return fail(405, 'method', 'Method not allowed')
      }

      let grant: RemoteMediaGrant
      let requestedImageSize: RemoteImageDisplaySize | undefined
      try {
        grant = grants.resolve(request.url)
        if (grant.kind === 'image') {
          requestedImageSize = parseGrantToken(request.url).imageSize
        }
      } catch (error) {
        return fail(403, 'authorization', 'Remote media authorization failed', error)
      }
      source = grant.source
      record('authorization.complete', { kind: grant.kind })

      const range = request.headers.get('range')
      if (range && !isSingleByteRange(range)) {
        return fail(416, 'range', 'Requested range is not supported')
      }

      const cacheable =
        grant.kind === 'image' &&
        request.method === 'GET' &&
        !range &&
        grant.expiresAt === undefined
      const cacheGeneration = options.imageCache?.generation?.()
      syncDerivativeGeneration(cacheGeneration)
      const resizeBudget = options.imageCache?.resize
        ? imageResizeBudget(requestedImageSize)
        : null
      const derivativeKey =
        cacheable && resizeBudget ? `${grant.source}?size=${requestedImageSize}` : null

      const serveCachedImage = async (cached: Response): Promise<Response> => {
        const noStore = grant.expiresAt !== undefined
        if (!resizeBudget || !options.imageCache?.resize) {
          record('response.ready', { status: cached.status, fromCache: true })
          if (!noStore) return cached
          const headers = new Headers(cached.headers)
          headers.set('Cache-Control', 'no-store')
          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers
          })
        }
        const rawBytes = new Uint8Array(await cached.arrayBuffer())
        request.signal.throwIfAborted()
        let outBytes: Uint8Array = rawBytes
        const headers = new Headers(cached.headers)
        if (noStore) headers.set('Cache-Control', 'no-store')
        try {
          const resized = options.imageCache.resize(
            rawBytes,
            cached.headers.get('content-type') ?? 'image/jpeg',
            resizeBudget.width,
            resizeBudget.quality
          )
          if (resized && resized.bytes.byteLength > 0) {
            outBytes = resized.bytes
            const contentType = resized.mime.split(';', 1)[0].trim() || resized.mime
            headers.set('Content-Type', contentType)
            headers.delete('Content-Length')
            if (derivativeKey && !noStore) {
              cacheResizedDerivative(
                derivativeKey,
                outBytes,
                contentType,
                headers.get('Cache-Control')
              )
            }
          }
        } catch {
          // Serve cached canonical bytes if resizing fails.
        }
        record('response.ready', { status: cached.status, fromCache: true })
        return new Response(outBytes as BodyInit, { status: cached.status, headers })
      }

      const serveCanonicalOutcome = (
        outcome: CanonicalImageOutcome,
        entryGeneration: number | undefined
      ): Response => {
        if (outcome.kind === 'failure') {
          return fail(outcome.status, outcome.reason, outcome.message, outcome.error)
        }
        if (outcome.kind === 'uncached') {
          record('cache.write.skipped', { reason: outcome.skipReason })
          let outBytes: Uint8Array = outcome.bytes
          const headers = new Headers(outcome.headers)
          if (options.imageCache?.resize && outcome.status === 200) {
            try {
              const resized = options.imageCache.resize(
                outcome.bytes,
                outcome.headers.get('content-type') ?? '',
                resizeBudget?.width,
                resizeBudget?.quality
              )
              if (resized && resized.bytes.byteLength > 0) {
                outBytes = resized.bytes
                headers.set('Content-Type', resized.mime.split(';', 1)[0].trim() || resized.mime)
                headers.delete('Content-Length')
              }
            } catch {
              // Keep original bytes when downscaling fails.
            }
          }
          record('response.ready', {
            status: outcome.status,
            fromCache: false,
            bytes: outBytes.byteLength
          })
          return new Response(outBytes as BodyInit, { status: outcome.status, headers })
        }

        const currentGeneration = options.imageCache?.generation?.()
        syncDerivativeGeneration(currentGeneration)
        const sameGeneration = currentGeneration === entryGeneration
        if (sameGeneration && derivativeKey) {
          const cachedDerivative = resizedDerivatives.get(derivativeKey)
          if (cachedDerivative) {
            resizedDerivatives.delete(derivativeKey)
            resizedDerivatives.set(derivativeKey, cachedDerivative)
            const headers = new Headers({ 'Content-Type': cachedDerivative.contentType })
            if (cachedDerivative.cacheControl) {
              headers.set('Cache-Control', cachedDerivative.cacheControl)
            }
            record('response.ready', {
              status: outcome.status,
              fromCache: false,
              bytes: cachedDerivative.bytes.byteLength
            })
            return new Response(cachedDerivative.bytes as BodyInit, {
              status: outcome.status,
              headers
            })
          }
        }

        let outBytes = outcome.bytes
        const headers = new Headers(outcome.headers)
        let downscaled = false
        if (resizeBudget && options.imageCache?.resize) {
          try {
            const resized = options.imageCache.resize(
              outBytes,
              headers.get('content-type') ?? 'image/jpeg',
              resizeBudget.width,
              resizeBudget.quality
            )
            if (resized && resized.bytes.byteLength > 0) {
              outBytes = resized.bytes
              downscaled = true
              const contentType = resized.mime.split(';', 1)[0].trim() || resized.mime
              headers.set('Content-Type', contentType)
              if (sameGeneration && derivativeKey) {
                cacheResizedDerivative(
                  derivativeKey,
                  outBytes,
                  contentType,
                  headers.get('Cache-Control')
                )
              }
            }
          } catch {
            // Keep canonical stored bytes when secondary downscale fails.
          }
        }
        if (downscaled || outcome.storedBytesReplaced) {
          headers.delete('Content-Length')
        }
        record('response.ready', {
          status: outcome.status,
          fromCache: false,
          bytes: outBytes.byteLength
        })
        return new Response(outBytes as BodyInit, { status: outcome.status, headers })
      }

      if (cacheable && options.imageCache) {
        if (derivativeKey) {
          const cachedDerivative = resizedDerivatives.get(derivativeKey)
          if (cachedDerivative) {
            resizedDerivatives.delete(derivativeKey)
            resizedDerivatives.set(derivativeKey, cachedDerivative)
            const headers = new Headers({ 'Content-Type': cachedDerivative.contentType })
            if (cachedDerivative.cacheControl) {
              headers.set('Cache-Control', cachedDerivative.cacheControl)
            }
            record('cache.lookup', { hit: true, size: requestedImageSize })
            record('response.ready', { status: 200, fromCache: true })
            return new Response(cachedDerivative.bytes as BodyInit, { status: 200, headers })
          }
        }

        const singleflightKey =
          cacheGeneration === undefined ? grant.source : `${cacheGeneration}\0${grant.source}`
        let inFlight = inFlightCanonicalImages.get(singleflightKey)
        if (inFlight) {
          record('cache.lookup', { hit: false, coalesced: true })
          const outcome = await awaitCanonicalImage(singleflightKey, inFlight, request.signal)
          return serveCanonicalOutcome(outcome, inFlight.generation)
        }

        try {
          const cached = await options.imageCache.read(grant.source)
          if (request.signal.aborted) {
            await cancelRemoteMediaBody(cached)
            request.signal.throwIfAborted()
          }
          record('cache.lookup', { hit: Boolean(cached) })
          if (cached) {
            return await serveCachedImage(cached)
          }
        } catch (error) {
          record('cache.read.failed', { error }, 'warn')
          throw error
        }

        inFlight = inFlightCanonicalImages.get(singleflightKey)
        if (!inFlight) {
          inFlight = startCanonicalImageFetch(singleflightKey, grant, cacheGeneration, record)
        }
        const outcome = await awaitCanonicalImage(singleflightKey, inFlight, request.signal)
        return serveCanonicalOutcome(outcome, inFlight.generation)
      }

      let upstream: Response
      try {
        const upstreamUrl = upstreamFetchUrlForRemoteMedia(grant.source, grant.kind)
        upstream = await fetchRemoteMediaWithRedirects(
          options.fetch,
          upstreamUrl,
          {
            method: request.method,
            signal: request.signal,
            headers: buildUpstreamRequestHeaders(grant.source, grant.kind, range)
          },
          record
        )
      } catch (error) {
        request.signal.throwIfAborted()
        return fail(502, 'upstream-fetch', 'Remote media request failed', error)
      }

      if (!upstream.ok && upstream.status !== 206) {
        await cancelRemoteMediaBody(upstream)
        return fail(502, 'upstream-status', 'Remote media request failed')
      }
      if (grant.expiresAt !== undefined) {
        try {
          grants.resolve(request.url, 'image')
        } catch {
          await cancelRemoteMediaBody(upstream)
          return fail(403, 'authorization-expired', 'Remote image permission has expired')
        }
      }
      if (!isExpectedMediaType(upstream.headers.get('content-type'), grant.kind)) {
        await cancelRemoteMediaBody(upstream)
        return fail(415, 'content-type', 'Remote media type is not authorized')
      }

      const maximumBytes = maxResponseBytesFor(grant.kind)
      const contentLength = parseContentLength(upstream.headers.get('content-length'))
      if (contentLength !== null && contentLength > maximumBytes) {
        await cancelRemoteMediaBody(upstream)
        return fail(413, 'content-length', 'Remote media response is too large')
      }

      const response = new Response(
        limitResponseBody(upstream.body, maximumBytes, record, request.signal),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: filteredResponseHeaders(upstream.headers)
        }
      )
      if (grant.expiresAt !== undefined) response.headers.set('Cache-Control', 'no-store')
      if (cacheable) {
        record('cache.write.skipped', {
          reason: options.imageCache ? 'response-policy' : 'unconfigured'
        })
      }
      if (
        options.imageCache?.resize &&
        grant.kind === 'image' &&
        request.method === 'GET' &&
        !range &&
        upstream.status === 200
      ) {
        try {
          const bytes = new Uint8Array(await response.arrayBuffer())
          request.signal.throwIfAborted()
          let outBytes: Uint8Array = bytes
          const headers = new Headers(response.headers)
          try {
            const resized = options.imageCache.resize(
              bytes,
              upstream.headers.get('content-type') ?? '',
              resizeBudget?.width,
              resizeBudget?.quality
            )
            if (resized && resized.bytes.byteLength > 0) {
              outBytes = resized.bytes
              headers.set('Content-Type', resized.mime.split(';', 1)[0].trim() || resized.mime)
              headers.delete('Content-Length')
            }
          } catch {
            // Keep original bytes when downscaling fails.
          }
          record('response.ready', {
            status: response.status,
            fromCache: false,
            bytes: outBytes.byteLength
          })
          return new Response(outBytes as BodyInit, { status: response.status, headers })
        } catch (error) {
          request.signal.throwIfAborted()
          return fail(502, 'body-or-cache-write', 'Remote image response failed', error)
        }
      }
      record('response.ready', { status: response.status, fromCache: false })
      return response
    })
}

type MediaDiagnostic = (
  event: string,
  details?: Record<string, unknown>,
  level?: DiagnosticLevel
) => void

export function protectProviderMedia<T>(
  value: T,
  method: string,
  grants: RemoteMediaGrantService = remoteMediaGrants
): T {
  if (typeof value === 'string') {
    return (method === 'getPlaybackUrl' ? grantIfRemote(value, 'audio', grants) : value) as T
  }
  return protectValue(value, method, grants) as T
}

/**
 * Issue (or re-issue) an image grant for a durable remote cover URL.
 * Used when the renderer restores a track whose previous twilight-media token
 * is no longer in the main-process grant map.
 */
export function grantRemoteImageUrl(
  source: string,
  grants: RemoteMediaGrantService = remoteMediaGrants
): string {
  const normalized = normalizeProviderRemoteUrl(source)
  if (!normalized) throw new Error('Remote image source is invalid')
  return grants.grant(normalized, 'image')
}

function protectValue(value: unknown, method: string, grants: RemoteMediaGrantService): unknown {
  if (Array.isArray(value)) return value.map((entry) => protectValue(entry, method, grants))
  if (!value || typeof value !== 'object') return value

  const protectedValue: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && isImageField(key, method)) {
      const normalized = normalizeProviderRemoteUrl(entry)
      if (normalized) {
        protectedValue[key] = grants.grant(normalized, 'image')
        // Keep a durable origin so session restore / listening stats can re-grant
        // after the in-memory twilight-media token is gone.
        const sourceKey = durableImageSourceKey(key)
        if (sourceKey && protectedValue[sourceKey] === undefined) {
          protectedValue[sourceKey] = normalized
        }
      } else {
        protectedValue[key] = entry
      }
    } else if (typeof entry === 'string' && isAudioField(key)) {
      protectedValue[key] = grantIfRemote(entry, 'audio', grants)
    } else {
      protectedValue[key] = protectValue(entry, method, grants)
    }
  }
  return protectedValue
}

/**
 * Sibling field names that store the original http(s) image URL alongside a
 * twilight-media grant. Only `cover` drives LocalDashboard + PlayerBar.
 */
function durableImageSourceKey(key: string): string | null {
  if (key === 'cover' || key === 'coverUrl') return 'coverSource'
  if (key === 'coverSmall') return 'coverSmallSource'
  if (key === 'picUrl') return 'picUrlSource'
  if (key === 'picUrlSmall') return 'picUrlSmallSource'
  if (key === 'avatarUrl') return 'avatarUrlSource'
  if (key === 'avatarUrlSmall') return 'avatarUrlSmallSource'
  return null
}

function deterministicImageToken(source: string): string {
  return `img-${createHash('sha256').update(source).digest('hex').slice(0, 48)}`
}

function isImageField(key: string, method: string): boolean {
  return (
    key === 'cover' ||
    key === 'coverUrl' ||
    key === 'coverSmall' ||
    key === 'imageUrl' ||
    key === 'picUrl' ||
    key === 'picUrlSmall' ||
    key === 'avatarUrl' ||
    key === 'avatarUrlSmall' ||
    key === 'coverImgUrl' ||
    key === 'blurPicUrl' ||
    (key === 'url' && method === 'getQrImage')
  )
}

function isAudioField(key: string): boolean {
  return key === 'streamUrl' || key === 'audioUrl'
}

function grantIfRemote(
  source: string,
  kind: RemoteMediaKind,
  grants: RemoteMediaGrantService
): string {
  const normalized = normalizeProviderRemoteUrl(source)
  return normalized ? grants.grant(normalized, kind) : source
}

/**
 * Accepts absolute http(s) URLs and protocol-relative `//host/path` values that
 * NetEase (and some other providers) return for cover/stream assets.
 */
function normalizeProviderRemoteUrl(source: string): string | null {
  if (typeof source !== 'string') return null
  const trimmed = source.trim()
  if (!trimmed) return null
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  if (!/^https?:\/\//i.test(candidate)) return null
  try {
    return normalizeRemoteMediaSource(candidate)
  } catch {
    return null
  }
}

/**
 * NetEase (and many CDNs) reject bare Electron net.fetch without a browser-like
 * UA/Referer. Missing headers yield 403 HTML, which then fails the image
 * content-type gate and leaves PlayerBar/LocalDashboard with a broken <img>.
 */
function buildUpstreamRequestHeaders(
  source: string,
  kind: RemoteMediaKind,
  range: string | null
): Record<string, string> {
  // Return a plain object so Electron net.fetch always receives string headers.
  // Passing a WHATWG Headers instance can drop fields under some Electron builds.
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: kind === 'image' ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' : '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
  const referer = refererForRemoteMediaSource(source)
  if (referer) headers.Referer = referer
  if (range) headers.Range = range
  return headers
}

function refererForRemoteMediaSource(source: string): string | null {
  try {
    const host = new URL(source).hostname.toLowerCase()
    if (
      host === 'music.163.com' ||
      host.endsWith('.music.163.com') ||
      host.endsWith('.126.net') ||
      host.endsWith('.163.com')
    ) {
      return 'https://music.163.com/'
    }
  } catch {
    // ignore parse failures
  }
  return null
}

async function fetchRemoteMediaWithRedirects(
  fetchImpl: RemoteMediaRequestHandlerOptions['fetch'],
  source: string,
  init: { method: string; headers?: HeadersInit; signal: AbortSignal },
  record: MediaDiagnostic
): Promise<Response> {
  let current = source
  const baseHeaders = headersInitToRecord(init.headers)
  for (let hop = 0; hop <= MAX_REMOTE_MEDIA_REDIRECTS; hop += 1) {
    init.signal.throwIfAborted()
    // Refresh Referer for each hop so edge hosts still look browser-like.
    const hopHeaders: Record<string, string> = { ...baseHeaders }
    const hopReferer = refererForRemoteMediaSource(current)
    if (hopReferer) hopHeaders.Referer = hopReferer
    record('upstream.request.start', { hop, address: current })
    const response = await fetchImpl(current, {
      method: init.method,
      signal: init.signal,
      headers: hopHeaders,
      credentials: 'omit',
      redirect: 'manual'
    })
    record(
      'upstream.response.headers',
      {
        hop,
        address: current,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: parseContentLength(response.headers.get('content-length'))
      },
      response.status >= 400 ? 'warn' : 'debug'
    )
    if (init.signal.aborted) {
      await cancelRemoteMediaBody(response)
      init.signal.throwIfAborted()
    }
    if (response.status < 300 || response.status >= 400) return response
    try {
      if (hop === MAX_REMOTE_MEDIA_REDIRECTS) {
        throw new Error('Remote media redirect limit exceeded')
      }
      const location = response.headers.get('location')
      if (!location) throw new Error('Remote media redirect is missing a location')
      let next: string
      try {
        next = normalizeRemoteMediaSource(new URL(location, current).toString())
      } catch {
        throw new Error('Remote media redirect target is not authorized')
      }
      record('upstream.redirect', {
        hop,
        address: current,
        targetUrl: next,
        status: response.status
      })
      current = next
    } finally {
      // Release redirects even when the location or hop limit is rejected.
      await cancelRemoteMediaBody(response)
    }
  }
  throw new Error('Remote media redirect limit exceeded')
}

async function cancelRemoteMediaBody(response: Response | null): Promise<void> {
  try {
    await response?.body?.cancel()
  } catch {
    // Disposal must not replace the original network or authorization error.
  }
}

function headersInitToRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (typeof key === 'string' && typeof value === 'string') result[key] = value
    }
    return result
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

function normalizeRemoteMediaSource(source: string): string {
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw new Error('Remote media source is invalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Remote media source protocol is not authorized')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Remote media source must not include credentials')
  }
  return parsed.toString()
}

function parseGrantToken(url: string): {
  token: string
  kind: RemoteMediaKind
  imageSize?: RemoteImageDisplaySize
} {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Remote media grant URL is invalid')
  }
  const token = parsed.pathname.replace(/^\/+/, '')
  const kind = parsed.hostname
  if (
    parsed.protocol !== 'twilight-media:' ||
    (kind !== 'audio' && kind !== 'image') ||
    !token ||
    token.includes('/') ||
    parsed.hash
  ) {
    throw new Error('Remote media grant URL is invalid')
  }
  let imageSize: RemoteImageDisplaySize | undefined
  if (parsed.search) {
    if (kind !== 'image') {
      throw new Error('Remote media grant URL is invalid')
    }
    const size = parsed.searchParams.get('size')
    if (
      parsed.searchParams.size !== 1 ||
      (size !== 'sm' && size !== 'grid' && size !== 'md')
    ) {
      throw new Error('Remote media grant URL is invalid')
    }
    imageSize = size
  }
  return { token, kind, ...(imageSize ? { imageSize } : {}) }
}

function ttlFor(kind: RemoteMediaKind): number {
  return kind === 'audio' ? AUDIO_IDLE_TTL_MS : IMAGE_IDLE_TTL_MS
}

function isSingleByteRange(value: string): boolean {
  return /^bytes=(?:\d+-\d*|\d*-\d+)$/i.test(value)
}

function isExpectedMediaType(contentType: string | null, kind: RemoteMediaKind): boolean {
  // NetEase occasionally emits `image/jpg; charset=UTF-8` — strip params first.
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (kind === 'image') {
    // Some CDNs omit content-type, serve covers as generic binary, or use the
    // non-standard `image/jpg` subtype (still starts with image/).
    return (
      !normalized ||
      normalized.startsWith('image/') ||
      normalized === 'application/octet-stream' ||
      normalized === 'binary/octet-stream'
    )
  }
  // NetEase stream edges often omit Content-Type, label FLAC/MP3 as
  // application/octet-stream, or mis-tag AAC as video/mp4 / application/mp4.
  return (
    !normalized ||
    normalized.startsWith('audio/') ||
    normalized === 'application/ogg' ||
    normalized === 'application/octet-stream' ||
    normalized === 'binary/octet-stream' ||
    normalized === 'application/mp4' ||
    normalized === 'video/mp4' ||
    normalized === 'application/x-mpegurl' ||
    normalized === 'application/vnd.apple.mpegurl'
  )
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function maxResponseBytesFor(kind: RemoteMediaKind): number {
  return kind === 'audio' ? MAX_AUDIO_RESPONSE_BYTES : MAX_IMAGE_RESPONSE_BYTES
}

function filteredResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers()
  for (const name of [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type'
  ]) {
    const value = headers.get(name)
    if (value) filtered.set(name, value)
  }
  // Allow renderer canvas sampling (cover theme) and CORS-mode <img> loads.
  // Origins stay opaque tokens; no credentials are ever forwarded upstream.
  filtered.set('Access-Control-Allow-Origin', '*')
  filtered.set('Access-Control-Allow-Methods', 'GET, HEAD')
  return filtered
}

function limitResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  record: MediaDiagnostic,
  signal: AbortSignal
): ReadableStream<Uint8Array> | null {
  if (!body) {
    record('body.complete', { bytes: 0 })
    return null
  }
  const reader = body.getReader()
  let bytesRead = 0
  let settled = false
  let onAbort: () => void
  const cleanup = () => signal.removeEventListener('abort', onAbort)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        record('body.cancelled', { bytes: bytesRead }, 'debug')
        controller.error(signal.reason)
        void reader.cancel(signal.reason).catch(() => {})
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    },
    async pull(controller) {
      try {
        const next = await reader.read()
        if (settled) return
        if (next.done) {
          settled = true
          cleanup()
          record('body.complete', { bytes: bytesRead })
          controller.close()
          return
        }
        bytesRead += next.value.byteLength
        if (bytesRead > maximumBytes) {
          await reader.cancel('Remote media response exceeded its size limit')
          throw new Error('Remote media response exceeded its size limit')
        }
        controller.enqueue(next.value)
      } catch (error) {
        if (settled) return
        settled = true
        cleanup()
        record('body.failed', { bytes: bytesRead, maximumBytes, error }, 'warn')
        controller.error(error)
      }
    },
    cancel(reason) {
      if (settled) return
      settled = true
      cleanup()
      record('body.cancelled', { bytes: bytesRead }, 'debug')
      return reader.cancel(reason)
    }
  })
}

function failedRemoteMediaResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD'
    }
  })
}
