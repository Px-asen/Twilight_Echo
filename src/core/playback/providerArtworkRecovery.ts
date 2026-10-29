import type { TrackData } from '../../shared/track.ts'
import { getNcmSongId } from '../../shared/ncmTrack.ts'

export interface ProviderTrackIdentity {
  providerId: string
  trackId: string | number | null
}

export interface ProviderArtworkRecoveryRuntime {
  supportedMethods(providerId: string): readonly string[]
  callProvider(
    providerId: string,
    method: 'searchSongs',
    args: unknown[],
    signal?: AbortSignal
  ): Promise<unknown>
}

const NON_SEARCH_PROVIDERS = new Set(['local', 'network', 'radio', 'podcast'])

export function providerTrackIdentity(track: TrackData): ProviderTrackIdentity | null {
  const path = /^[a-zA-Z]:[\\/]/.test(track.id) || /^[\\/]/.test(track.id)
  const providerId = (track.source || (!path ? track.id.split(':')[0] : '')).trim().toLowerCase()
  if (!providerId || providerId === 'local' || (!track.source && !track.id.includes(':')))
    return null
  const prefix = `${providerId}:`
  return {
    providerId,
    trackId:
      providerId === 'ncm'
        ? getNcmSongId(track)
        : track.id.startsWith(prefix)
          ? track.id.slice(prefix.length).trim() || null
          : null
  }
}

export function isRecoverableProviderTrack(
  track: TrackData,
  supportedMethods: (providerId: string) => readonly string[]
): boolean {
  const provider = providerTrackIdentity(track)
  if (!provider || NON_SEARCH_PROVIDERS.has(provider.providerId)) return false
  if (!track.title?.trim()) return false
  return supportedMethods(provider.providerId).includes('searchSongs')
}

export async function recoverProviderTrackArtwork(
  track: TrackData,
  runtime: ProviderArtworkRecoveryRuntime,
  signal: AbortSignal
): Promise<{ cover: string | null; coverSource: string | null } | null> {
  const provider = providerTrackIdentity(track)
  if (!provider || NON_SEARCH_PROVIDERS.has(provider.providerId)) return null
  if (!track.title?.trim() || !runtime.supportedMethods(provider.providerId).includes('searchSongs'))
    return null

  const query = [track.title, track.artist].filter(Boolean).join(' ').trim()
  if (!query) return null

  const result = await runtime.callProvider(
    provider.providerId,
    'searchSongs',
    [query, 20, 0],
    signal
  )
  signal.throwIfAborted()

  const items = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { items?: unknown[] }).items)
      ? (result as { items: unknown[] }).items
      : []

  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<TrackData> & {
      coverSmall?: string | null
      coverSmallSource?: string | null
    }
    const sameId =
      candidate.id === track.id ||
      (provider.providerId === 'ncm' &&
        provider.trackId != null &&
        getNcmSongId(candidate as TrackData) === Number(provider.trackId))
    const sameSource =
      !candidate.source || candidate.source.trim().toLowerCase() === provider.providerId
    if (!sameId || !sameSource) continue

    const cover =
      (typeof candidate.cover === 'string' && candidate.cover.trim()) ||
      (typeof candidate.coverSmall === 'string' && candidate.coverSmall.trim()) ||
      null
    const coverSource =
      (typeof candidate.coverSource === 'string' && candidate.coverSource.trim()) ||
      (typeof candidate.coverSmallSource === 'string' && candidate.coverSmallSource.trim()) ||
      null
    if (cover || coverSource) {
      return { cover, coverSource }
    }
  }
  return null
}
