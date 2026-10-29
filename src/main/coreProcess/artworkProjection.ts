import type { CorePlayerPresentation } from '../../shared/coreSystemPlayer.ts'

export interface ArtworkPlatform {
  normalizeCachedCover(handle: string): Promise<string>
  migrateBase64Cover(data: string): string | null
  grant(source: string, expiresAt?: number): string
  resolve(handle: string): { source: string; expiresAt?: number }
  retainMetadata?(source: string, signal: AbortSignal): Promise<void>
}

/** Re-issue session grants here; presentation clients never receive durable CDN URLs. */
export function createArtworkProjection(platform: ArtworkPlatform) {
  return async (
    input: {
      cover: string | null
      coverSource: string | null
      imageExpiresAt?: number
      retainMetadata?: boolean
    },
    signal: AbortSignal
  ): Promise<Pick<CorePlayerPresentation, 'cover' | 'coverSource'>> => {
    signal.throwIfAborted()
    const handle = input.cover?.trim()
    let cover: string | null = null
    if (handle?.startsWith('cover://')) {
      cover = await platform.normalizeCachedCover(handle.split(/[?#]/, 1)[0])
    } else if (handle?.startsWith('data:image/')) {
      cover = platform.migrateBase64Cover(handle)
    } else if (/^https?:\/\//i.test(input.coverSource ?? '')) {
      cover = platform.grant(input.coverSource!, input.imageExpiresAt)
    } else if (/^https?:\/\//i.test(handle ?? '')) {
      cover = platform.grant(handle!, input.imageExpiresAt)
    } else if (handle?.startsWith('twilight-media://image/')) {
      const original = platform.resolve(handle)
      const deadlines = [original.expiresAt, input.imageExpiresAt].filter(
        (v): v is number => v !== undefined
      )
      cover = platform.grant(original.source, deadlines.length ? Math.min(...deadlines) : undefined)
    }
    signal.throwIfAborted()
    if (
      input.retainMetadata &&
      cover?.startsWith('twilight-media://image/') &&
      platform.retainMetadata
    ) {
      const original = platform.resolve(cover)
      if (original.expiresAt === undefined && input.imageExpiresAt === undefined) {
        try {
          await platform.retainMetadata(original.source, signal)
        } catch {
          // A disk/network failure must not discard an otherwise usable grant.
          signal.throwIfAborted()
        }
      }
    }
    signal.throwIfAborted()
    return { cover, coverSource: null }
  }
}

/** Resolve client-submitted queue artwork handles back to durable Core snapshot
 * fields (`cover://` or `coverSource`). Unknown or expiring grants degrade to null. */
export function createQueueCoverResolver(
  platform: Pick<ArtworkPlatform, 'normalizeCachedCover' | 'migrateBase64Cover' | 'resolve'>
) {
  return async (
    input: { covers: readonly string[] },
    signal: AbortSignal
  ): Promise<Record<string, { cover: string | null; coverSource: string | null }>> => {
    signal.throwIfAborted()
    const resolved: Record<string, { cover: string | null; coverSource: string | null }> = {}
    for (const raw of new Set(input.covers)) {
      signal.throwIfAborted()
      const handle = raw.trim()
      if (!handle) continue
      let cover: string | null = null
      let coverSource: string | null = null
      if (handle.startsWith('cover://')) {
        try {
          cover = await platform.normalizeCachedCover(handle.split(/[?#]/, 1)[0])
        } catch {
          cover = null
        }
      } else if (handle.startsWith('data:image/')) {
        cover = platform.migrateBase64Cover(handle)
      } else if (handle.startsWith('twilight-media://image/')) {
        try {
          const original = platform.resolve(handle)
          if (original.expiresAt === undefined && /^https?:\/\//i.test(original.source)) {
            coverSource = original.source
          }
        } catch {
          // Expired or revoked image grants must not fail queue/playlist submission.
        }
      }
      resolved[raw] = { cover, coverSource }
    }
    signal.throwIfAborted()
    return resolved
  }
}
