import type { TrackData } from '../../shared/track.ts'
import type { LogicalTrackModel } from '../../shared/logicalTrackModel.ts'
import type { UnifiedSearchResult } from '../../shared/unifiedMusicSearch.ts'
import { getTrackSource } from '../../shared/trackSourceIdentity.ts'
import { createPlaybackFallback } from '../../shared/playbackFallback.ts'
import { findProviderRematchCandidate } from '../../shared/libraryRepair.ts'
import { recordingVersionHint } from '../../shared/recordingIdentity.ts'
import {
  prepareNativeSource,
  isSourceCurrent,
  type ResolvedSource,
  type SourceResolver
} from './sourceResolver.ts'

export interface PreparedPlaybackSource {
  track: TrackData
  resolved: ResolvedSource
  /** Recording preferences may change while a provider is resolving. */
  confirm?(): void
}

export interface PlaybackSourceRecovery {
  prepare(
    track: TrackData,
    signal?: AbortSignal,
    options?: { allowFallbackSearch?: boolean }
  ): Promise<PreparedPlaybackSource>
  /** Only after native has explicitly rejected a source and Stop is confirmed. */
  recover?(track: TrackData, signal?: AbortSignal): Promise<PreparedPlaybackSource>
  repaired?(previous: TrackData, replacement: TrackData): Promise<void>
}

interface Options {
  resolver: SourceResolver
  authorize(source: string): Promise<string | null>
  identity: LogicalTrackModel
  versionsRevision(): number
  search(query: string, signal?: AbortSignal): Promise<UnifiedSearchResult>
  repaired?: PlaybackSourceRecovery['repaired']
  now(): number
}

/** Source IO has no queue or transport writes. Only the session can commit the
 * resulting identity, after its native/SQL occurrence fences are satisfied. */
export function createPlaybackSourceRecovery(options: Options): PlaybackSourceRecovery {
  const fallback = createPlaybackFallback(options.identity)
  async function prepareInternal(
    track: TrackData,
    signal?: AbortSignal,
    skipOriginal = false,
    allowFallbackSearch = true
  ): Promise<PreparedPlaybackSource> {
    const revision = options.versionsRevision()
    const confirmRevision = () => {
      if (options.versionsRevision() !== revision)
        throw Object.assign(new Error('Recording preferences changed during source resolution'), {
          code: 'STALE_REVISION'
        })
    }
    const guard = () => {
      signal?.throwIfAborted()
      confirmRevision()
    }
    // Authorization errors are not source failures. In particular, never
    // search for another path around a refused platform/media grant.
    const resolve = async (candidate: TrackData): Promise<PreparedPlaybackSource | null> => {
      guard()
      const resolved = await options.resolver.resolve(candidate, signal)
      guard()
      if (!resolved || !isSourceCurrent(resolved, options.now())) return null
      const source = await prepareNativeSource(resolved.source, options.authorize)
      guard()
      if (source === null || !isSourceCurrent(resolved, options.now())) return null
      return { track: candidate, resolved: { ...resolved, source }, confirm: confirmRevision }
    }
    if (!skipOriginal) {
      const original = await resolve(track)
      if (original) return original
    }
    const failedSource = getTrackSource(track)
    if (
      !allowFallbackSearch ||
      track.sourceSelection === 'explicit' ||
      ['radio', 'podcast'].includes(failedSource) ||
      options.identity.preferredSourceKey(track)
    )
      throw new Error('Unable to resolve the selected audio source')
    const found = await options.search(
      [track.title, track.artist].filter(Boolean).join(' '),
      signal
    )
    guard()
    const candidates = found.items
      .filter((item) => item.providerAvailable)
      .map((item) => item.track)
      .filter(
        (candidate) =>
          candidate.id !== track.id &&
          (failedSource !== 'local' || getTrackSource(candidate) !== 'local')
      )
    const reliability = Object.fromEntries(
      Object.entries(found.health).map(([id, health]) => [
        id,
        health.playbackUrlSuccessRate ?? health.successRate ?? 1
      ])
    )
    // Keep the mature variant ranking before metadata rematching. Both reads
    // are bounded by the unified search result, not by a complete queue/library.
    const variant = fallback.findPlaybackFallbackTrack({
      failedTrack: track,
      candidates,
      unavailableSources: [failedSource],
      sourceReliability: reliability
    })
    const key = options.identity.getRecordingTrackKey(track)
    const rematch = findProviderRematchCandidate(
      track,
      candidates.filter((candidate) => {
        const candidateKey = options.identity.getRecordingTrackKey(candidate)
        return key.startsWith('version:') || candidateKey.startsWith('version:')
          ? options.identity.canShareTrackIdentity(track, candidate)
          : recordingVersionHint(track) === recordingVersionHint(candidate)
      })
    )
    const tried = new Set<string>()
    for (const candidate of [variant, rematch]) {
      if (!candidate || tried.has(candidate.id)) continue
      tried.add(candidate.id)
      const prepared = await resolve({ ...candidate, queueEntryId: track.queueEntryId })
      if (prepared) return prepared
    }
    throw new Error('Unable to resolve the selected audio source or a matching replacement')
  }
  return {
    repaired: options.repaired,
    prepare: (track, signal, prepareOptions) =>
      prepareInternal(track, signal, false, prepareOptions?.allowFallbackSearch !== false),
    recover: (track, signal) => prepareInternal(track, signal, true, true)
  }
}
