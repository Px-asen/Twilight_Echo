import { afterglowTrackPathOf, isAfterglowPlayableSource } from '../../shared/afterglowMode.ts'
import type { TrackData } from '../../shared/track.ts'

export interface ResolvedSource {
  source: string
  /** Absolute epoch ms when the provider URL expires; null when unknown. */
  expiresAt: number | null
}

export interface SourceResolver {
  resolve(track: unknown, signal?: AbortSignal): Promise<ResolvedSource | null>
}

export class SourceAuthorizationError extends Error {
  readonly code = 'SOURCE_ACCESS_DENIED'
}

export interface SourceResolverDependencies {
  resolveNetwork?: (track: TrackData, signal?: AbortSignal) => Promise<ResolvedSource | null>
  callProvider?: (
    providerId: string,
    method: 'getPlaybackUrl',
    args: unknown[],
    options: { signal: AbortSignal; playbackExpiry: true }
  ) => Promise<unknown>
  grants?: {
    resolve(handle: string, kind: 'audio'): { source: string } | Promise<{ source: string }>
  }
  quality?: string | (() => string)
  now?: () => number
  /** Legacy Afterglow only; the independent Core always asks the source owner. */
  reuseResolvedProviderPaths?: boolean
  canUseLocalSource?: (source: string, signal?: AbortSignal) => Promise<boolean>
}

/** SACD selectors belong to the native target, not to its filesystem grant. */
export async function authorizeNativeSource(
  source: string,
  authorize: (source: string) => Promise<string>
): Promise<string> {
  return (await prepareNativeSource(source, authorize))!
}

/** A missing file is recoverable; a refused grant still rejects. */
export async function prepareNativeSource(
  source: string,
  prepare: (source: string) => Promise<string | null>
): Promise<string | null> {
  const local = isAfterglowPlayableSource(source) && !/^https?:\/\//i.test(source)
  const iso = local
    ? /^(.*\.iso)(\?area=(?:stereo|multichannel)&track=[1-9]\d{0,8})$/i.exec(source)
    : null
  const uriTrack = /^(content:\/\/.*)(#twilight-sacd=(?:stereo|multichannel):[1-9]\d*)$/.exec(source)
  const selected = uriTrack ?? iso
  try {
    if (!selected) return await prepare(source)
    const path = await prepare(selected[1])
    return path === null ? null : `${path}${selected[2]}`
  } catch (cause) {
    if (cause instanceof SourceAuthorizationError) throw cause
    throw new SourceAuthorizationError(
      cause instanceof Error ? cause.message : 'Audio source authorization was refused', { cause }
    )
  }
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const PROVIDER_TIMEOUT_MS = 12_000
const UNKNOWN_PROVIDER_TTL_MS = 8 * 60 * 1000

export const isSourceCurrent = (resolved: ResolvedSource, now = Date.now()): boolean =>
  resolved.expiresAt === null || resolved.expiresAt > now

const providerIdOf = (track: unknown): string => {
  if (!track || typeof track !== 'object') return ''
  const record = track as Record<string, unknown>
  if (typeof record.source === 'string' && record.source.trim()) {
    return record.source.trim()
  }
  if (typeof record.id === 'string') {
    if (/^[a-z]:[\\/]/i.test(record.id) || /^[\\/]/.test(record.id)) return ''
    const separator = record.id.indexOf(':')
    if (separator > 0) return record.id.slice(0, separator)
  }
  return ''
}

const normalizeProviderResult = (result: unknown): ResolvedSource | null => {
  if (typeof result === 'string') {
    return { source: result.trim(), expiresAt: null }
  }
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  const streamUrl = typeof record.streamUrl === 'string' ? record.streamUrl.trim() : ''
  if (!streamUrl) return null
  const providerSource =
    record.providerSource && typeof record.providerSource === 'object'
      ? (record.providerSource as Record<string, unknown>)
      : null
  const rawExpiry = providerSource?.expiresAt
  const expiresAt = typeof rawExpiry === 'number' && Number.isFinite(rawExpiry) ? rawExpiry : null
  return { source: streamUrl, expiresAt }
}

const withTimeout = <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.signal.removeEventListener('abort', onCancelled)
      settle()
    }
    const onCancelled = () => finish(() => reject(controller.signal.reason))
    const timer = setTimeout(
      () => controller.abort(new Error('provider resolve timeout')),
      timeoutMs
    )
    timer.unref?.()
    controller.signal.addEventListener('abort', onCancelled, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return operation(controller.signal)
        })
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error))
        )
  })

/**
 * Resolves logical identity using its current source owner. Queue snapshots are
 * not authority for provider URLs or managed cache paths.
 */
export const createSourceResolver = (
  dependencies: SourceResolverDependencies = {}
): SourceResolver => {
  const now = dependencies.now ?? Date.now
  const injectedCallProvider = dependencies.callProvider
  return {
    async resolve(track: unknown, signal?: AbortSignal): Promise<ResolvedSource | null> {
      if (signal?.aborted) return null
      if (!track || typeof track !== 'object') return null
      const record = track as Record<string, unknown>
      if (record.source === 'network' || record.networkSource) {
        const resolved = await dependencies.resolveNetwork?.(track as TrackData, signal)
        if (
          !resolved ||
          signal?.aborted ||
          !isAfterglowPlayableSource(resolved.source) ||
          !isSourceCurrent(resolved, now())
        )
          return null
        return resolved
      }
      const providerId = providerIdOf(track)
      const providerTrack =
        !!providerId && !['local', 'radio', 'podcast'].includes(providerId.toLowerCase())
      // CUE uses the physical file plus cueRange; SACD/other subtracks already
      // carry their logical native target and must not play the container.
      const localPath =
        !record.cueRange && typeof record.subTrack === 'string' && record.subTrack.trim()
          ? record.subTrack.trim()
          : afterglowTrackPathOf(track)
      if (
        (!providerTrack || dependencies.reuseResolvedProviderPaths) &&
        isAfterglowPlayableSource(localPath)
      ) {
        return { source: localPath, expiresAt: null }
      }

      if (!providerTrack || !PROVIDER_ID_PATTERN.test(providerId)) return null

      const options: Record<string, unknown> = {}
      if (providerId === 'ncm') {
        options.quality =
          typeof dependencies.quality === 'function'
            ? dependencies.quality()
            : (dependencies.quality ?? 'auto')
      }
      const callProvider = injectedCallProvider
      if (!callProvider) return null

      try {
        const resolve = async (force: boolean): Promise<ResolvedSource | null> => {
          const result = await withTimeout(
            (signal) =>
              callProvider(
                providerId,
                'getPlaybackUrl',
                [track, { ...options, ...(force ? { force: true } : {}) }],
                {
                  signal,
                  playbackExpiry: true
                }
              ),
            PROVIDER_TIMEOUT_MS,
            signal
          )
          if (signal?.aborted) return null
          const normalized = normalizeProviderResult(result)
          if (!normalized) return null
          if (!isSourceCurrent(normalized, now())) return force ? null : resolve(true)
          // Resolve only issued audio grants. A grant failure is not a reason to
          // retry around the platform's authorization decision.
          let source = normalized.source
          if (source.startsWith('twilight-media:')) {
            try {
              const grant = await dependencies.grants?.resolve(source, 'audio')
              if (!grant) throw new Error('Media audio grant is unavailable')
              source = grant.source
            } catch (cause) {
              throw new SourceAuthorizationError('Media audio grant was refused', { cause })
            }
          }
          if (!isAfterglowPlayableSource(source) || signal?.aborted) return null
          if (
            providerId === 'ncm' &&
            !/^https?:\/\//i.test(source) &&
            dependencies.canUseLocalSource
          ) {
            const usable = await dependencies.canUseLocalSource(source, signal)
            if (signal?.aborted) return null
            // Reuse the existing renderer's one forced account-authorized
            // resolution when a managed NCM cache path has disappeared.
            if (!usable) return force ? null : resolve(true)
          }
          if (!isSourceCurrent(normalized, now())) return force ? null : resolve(true)
          return { source, expiresAt: normalized.expiresAt ?? now() + UNKNOWN_PROVIDER_TTL_MS }
        }
        return await resolve(false)
      } catch (error) {
        if (signal?.aborted) return null
        if (error instanceof SourceAuthorizationError && !dependencies.reuseResolvedProviderPaths)
          throw error
        console.warn(
          `[afterglow] provider ${providerId} could not resolve a playback source:`,
          error instanceof Error ? error.message : String(error)
        )
        return null
      }
    }
  }
}
