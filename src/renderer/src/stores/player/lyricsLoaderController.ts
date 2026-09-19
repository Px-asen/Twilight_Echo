import type { Ref } from 'vue'
import type { Track } from '../../types/music'
import type { AppSettings } from '../../types/settings'
import { hasLyricContent } from '../../utils/lyrics.ts'
import { LYRICS_RETRY_DELAYS_MS } from '../../utils/playerConstants.ts'
import { getTrackSource } from '../../utils/playerTrackUtils.ts'
import {
  eligibleForAml,
  resolveLyricsWithSources,
  shouldLoadAutomaticOriginal,
  type LyricResolverSource
} from '../../utils/lyricSourceResolution.ts'
import { resolverLyricsInput } from '../../utils/managedLyricsSource.ts'
import { useLyricsManagement } from '../lyricsManagement.ts'
import { syncPluginProviders, useMediaProviders } from '../../providers'
import { getNcmSongId } from '../../providers/ncmTrack.ts'

export interface LyricsLoadState {
  trackId: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed'
}

interface ActiveLyricsLoad {
  signature: string
  generation: number
  activation: number
  controller: AbortController
  promise: Promise<void>
}

const automaticLyricsBaselines = new Map<string, Track>()
const activeLyricsLoads = new Map<string, ActiveLyricsLoad>()
const lyricsLoadGenerationByTrackId = new Map<string, number>()
const lyricsRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lyricsRetryAttemptsByTrackId = new Map<string, number>()
let lyricsTrackActivation = 0

// Baselines hold full track clones (potentially with full lyric payloads), so
// they must stay bounded to a small ring around the active track. Generation
// counters are tiny but had no deletion path at all, so they share the cap.
const AUTOMATIC_LYRICS_BASELINE_LIMIT = 8
const LYRICS_TRACK_COUNTER_LIMIT = 32

function pruneMapToLimit<V>(map: Map<string, V>, activeTrackId: string, limit: number): void {
  for (const key of map.keys()) {
    if (map.size <= limit) break
    if (key === activeTrackId) continue
    map.delete(key)
  }
}

function pruneLyricsTrackMemory(activeTrackId: string): void {
  pruneMapToLimit(automaticLyricsBaselines, activeTrackId, AUTOMATIC_LYRICS_BASELINE_LIMIT)
  pruneMapToLimit(lyricsLoadGenerationByTrackId, activeTrackId, LYRICS_TRACK_COUNTER_LIMIT)
  pruneMapToLimit(lyricsRetryAttemptsByTrackId, activeTrackId, LYRICS_TRACK_COUNTER_LIMIT)
}

export function getLyricsLoaderMemoryUsage(): {
  baselines: number
  generations: number
  retryAttempts: number
} {
  return {
    baselines: automaticLyricsBaselines.size,
    generations: lyricsLoadGenerationByTrackId.size,
    retryAttempts: lyricsRetryAttemptsByTrackId.size
  }
}

function getAmlSongId(track: Track): number {
  const direct = getNcmSongId(track)
  if (direct != null && (track.source === 'ncm' || track.id.startsWith('ncm:'))) return direct
  return Number(track.metadataMatch?.trackId)
}

export interface LyricsLoaderOptions {
  currentTrack: Ref<Track | null>
  lyricsLoadState: Ref<LyricsLoadState>
  getAppSettings: () => Ref<AppSettings>
  patchTrackInQueues: (updatedTrack: Track) => void
  getLyricsManagement: typeof useLyricsManagement
}

export function createLyricsLoader(options: LyricsLoaderOptions) {
  function clearLyricsRetryTimer(trackId: string): void {
    const timer = lyricsRetryTimers.get(trackId)
    if (timer != null) clearTimeout(timer)
    lyricsRetryTimers.delete(trackId)
  }

  function clearLyricsRetryTimersExcept(activeTrackId: string): void {
    for (const trackId of lyricsRetryTimers.keys()) {
      if (trackId !== activeTrackId) clearLyricsRetryTimer(trackId)
    }
  }

  function abortInactiveLyricsLoads(activeTrackId: string): void {
    for (const [trackId, request] of activeLyricsLoads) {
      if (trackId !== activeTrackId) request.controller.abort()
    }
  }

  function scheduleCurrentLyricsRetry(trackId: string, activation: number): void {
    if (options.currentTrack.value?.id !== trackId || lyricsTrackActivation !== activation) return
    const attempt = lyricsRetryAttemptsByTrackId.get(trackId) ?? 0
    const delay = LYRICS_RETRY_DELAYS_MS[attempt]
    if (delay == null) return

    lyricsRetryAttemptsByTrackId.set(trackId, attempt + 1)
    clearLyricsRetryTimer(trackId)
    lyricsRetryTimers.set(
      trackId,
      setTimeout(() => {
        lyricsRetryTimers.delete(trackId)
        if (
          options.currentTrack.value?.id !== trackId ||
          lyricsTrackActivation !== activation ||
          hasLyricContent(options.currentTrack.value.lyrics)
        ) {
          return
        }
        void ensureCurrentTrackLyricsLoaded(options.currentTrack.value, true, true)
      }, delay)
    )
  }

  function commitResolvedLyrics(
    triggerTrack: Track,
    resolverTrack: Track,
    resolved: {
      lyrics: string | null
      translatedLyrics: string | null
      romanizedLyrics: string | null
      lyricsSource: Track['lyricsSource']
      translatedLyricsSource: Track['translatedLyricsSource']
      romanizedLyricsSource: Track['romanizedLyricsSource']
    }
  ): void {
    if (options.currentTrack.value?.id !== triggerTrack.id) return
    const existing = options.currentTrack.value
    const nextLyrics = resolved.lyrics ?? ''
    if (
      !nextLyrics &&
      typeof existing?.lyrics === 'string' &&
      existing.lyrics.length > 0 &&
      existing.id === triggerTrack.id
    ) {
      return
    }
    const updatedTrack = {
      ...resolverTrack,
      ...existing,
      lyrics: nextLyrics,
      translatedLyrics: resolved.translatedLyrics,
      romanizedLyrics: resolved.romanizedLyrics,
      lyricsSource: resolved.lyricsSource,
      translatedLyricsSource: resolved.translatedLyricsSource,
      romanizedLyricsSource: resolved.romanizedLyricsSource
    }
    options.currentTrack.value = updatedTrack
    options.patchTrackInQueues(updatedTrack)
  }

  async function ensureCurrentTrackLyricsLoaded(
    triggerTrack: Track | null = options.currentTrack.value,
    allowProviderLookup = true,
    forceReload = false
  ): Promise<void> {
    const fallbackTrack = options.currentTrack.value
    if (!triggerTrack && fallbackTrack) triggerTrack = fallbackTrack
    if (!triggerTrack || options.currentTrack.value?.id !== triggerTrack.id) {
      return
    }
    const activation = lyricsTrackActivation
    const lyricsManagement = options.getLyricsManagement()
    try {
      await lyricsManagement.ensureLoaded()
    } catch {
      // The optional management document must never prevent automatic resolution.
    }
    if (options.currentTrack.value?.id !== triggerTrack.id || lyricsTrackActivation !== activation)
      return

    const override = lyricsManagement.entryFor(triggerTrack.id)
    const requestedSource = override?.source ?? 'auto'
    const layerSource = (
      key: 'originalSelection' | 'translationSelection' | 'romanizationSelection'
    ): LyricResolverSource | 'manual' => {
      const selection = override?.[key]
      if (selection === 'local' || selection === 'provider' || selection === 'manual') {
        return selection
      }
      if (selection === 'amll') return 'amll'
      if (
        requestedSource === 'local' ||
        requestedSource === 'amll' ||
        requestedSource === 'provider'
      )
        return requestedSource
      return 'automatic'
    }
    const originalLayerSource = layerSource('originalSelection')
    const translationLayerSource = layerSource('translationSelection')
    const romanizationLayerSource = layerSource('romanizationSelection')
    const resolverOriginalSource: LyricResolverSource =
      originalLayerSource === 'manual' ? 'automatic' : originalLayerSource
    const resolverTranslationSource: LyricResolverSource =
      translationLayerSource === 'manual' ? 'automatic' : translationLayerSource
    const resolverRomanizationSource: LyricResolverSource =
      romanizationLayerSource === 'manual' ? 'automatic' : romanizationLayerSource
    const sourceSelectionSignature = `${requestedSource}:${originalLayerSource}:${translationLayerSource}:${romanizationLayerSource}`

    const requestSignature = `${sourceSelectionSignature}:${allowProviderLookup ? 'provider' : 'local'}`
    const existingRequest = activeLyricsLoads.get(triggerTrack.id)
    if (
      !forceReload &&
      existingRequest?.signature === requestSignature &&
      existingRequest.activation === activation
    ) {
      await existingRequest.promise
      return
    }
    existingRequest?.controller.abort()

    const previousGeneration = lyricsLoadGenerationByTrackId.get(triggerTrack.id) ?? 0
    const loadGeneration = previousGeneration + 1
    lyricsLoadGenerationByTrackId.set(triggerTrack.id, loadGeneration)
    clearLyricsRetryTimer(triggerTrack.id)
    options.lyricsLoadState.value = { trackId: triggerTrack.id, status: 'loading' }

    const request: ActiveLyricsLoad = {
      signature: requestSignature,
      generation: loadGeneration,
      activation,
      controller: new AbortController(),
      promise: Promise.resolve()
    }
    const isCurrentRequest = (): boolean =>
      activeLyricsLoads.get(triggerTrack.id) === request &&
      lyricsLoadGenerationByTrackId.get(triggerTrack.id) === request.generation &&
      lyricsTrackActivation === request.activation &&
      options.currentTrack.value?.id === triggerTrack.id &&
      !request.controller.signal.aborted
    const completeIfCurrent = (status: 'ready' | 'empty' = 'ready'): void => {
      if (isCurrentRequest()) {
        clearLyricsRetryTimer(triggerTrack.id)
        lyricsRetryAttemptsByTrackId.delete(triggerTrack.id)
        options.lyricsLoadState.value = { trackId: triggerTrack.id, status }
      }
    }

    const run = async (): Promise<void> => {
      if (requestedSource === 'manual') {
        if (
          options.currentTrack.value?.id === triggerTrack.id &&
          options.currentTrack.value.lyrics == null &&
          options.currentTrack.value.translatedLyrics == null &&
          options.currentTrack.value.romanizedLyrics == null
        ) {
          commitResolvedLyrics(triggerTrack, triggerTrack, {
            lyrics: '',
            translatedLyrics: null,
            romanizedLyrics: null,
            lyricsSource: null,
            translatedLyricsSource: null,
            romanizedLyricsSource: null
          })
        }
        completeIfCurrent('empty')
        return
      }

      if (
        (requestedSource !== 'auto' ||
          originalLayerSource === 'local' ||
          originalLayerSource === 'amll' ||
          originalLayerSource === 'provider' ||
          translationLayerSource === 'local' ||
          translationLayerSource === 'amll' ||
          translationLayerSource === 'provider' ||
          romanizationLayerSource === 'local' ||
          romanizationLayerSource === 'amll' ||
          romanizationLayerSource === 'provider') &&
        !automaticLyricsBaselines.has(triggerTrack.id)
      ) {
        automaticLyricsBaselines.set(triggerTrack.id, { ...triggerTrack })
      }
      const resolverTrack = resolverLyricsInput(
        triggerTrack,
        automaticLyricsBaselines.get(triggerTrack.id),
        requestedSource
      )

      const hasOriginal = hasLyricContent(resolverTrack.lyrics)

      const source = getTrackSource(resolverTrack)
      const canLoadLocalLyrics =
        source === 'local' &&
        (resolverOriginalSource === 'local' ||
          (resolverOriginalSource === 'automatic' &&
            shouldLoadAutomaticOriginal(resolverTrack, 'local'))) &&
        !!resolverTrack.dir &&
        !!resolverTrack.fileName
      const canLoadLocalAuxiliaryLyrics =
        source === 'local' &&
        !!resolverTrack.dir &&
        !!resolverTrack.fileName &&
        (resolverTranslationSource === 'local' ||
          (resolverTranslationSource === 'automatic' &&
            !hasLyricContent(resolverTrack.translatedLyrics)) ||
          resolverRomanizationSource === 'local' ||
          (resolverRomanizationSource === 'automatic' &&
            !hasLyricContent(resolverTrack.romanizedLyrics)))
      const canLoadProviderLyrics =
        allowProviderLookup &&
        (resolverOriginalSource === 'provider' ||
          resolverTranslationSource === 'provider' ||
          (resolverOriginalSource === 'automatic' &&
            shouldLoadAutomaticOriginal(resolverTrack, 'provider')) ||
          (resolverTranslationSource === 'automatic' &&
            !hasLyricContent(resolverTrack.translatedLyrics)))
      const canLoadAmlLyrics =
        eligibleForAml(resolverTrack) &&
        (resolverOriginalSource === 'amll' ||
          resolverTranslationSource === 'amll' ||
          (resolverOriginalSource === 'automatic' &&
            shouldLoadAutomaticOriginal(resolverTrack, 'amll')))
      const canLoadOnlineLyrics =
        resolverOriginalSource === 'automatic' &&
        options.getAppSettings().value?.onlineLyricsFallback === true &&
        !!resolverTrack.title?.trim() &&
        !!resolverTrack.artist?.trim() &&
        !hasOriginal

      if (
        !canLoadLocalLyrics &&
        !canLoadLocalAuxiliaryLyrics &&
        !canLoadAmlLyrics &&
        !canLoadProviderLyrics &&
        !canLoadOnlineLyrics
      ) {
        commitResolvedLyrics(triggerTrack, resolverTrack, {
          lyrics: hasOriginal ? resolverTrack.lyrics! : '',
          translatedLyrics: resolverTrack.translatedLyrics ?? null,
          romanizedLyrics: resolverTrack.romanizedLyrics ?? null,
          lyricsSource: resolverTrack.lyricsSource ?? (hasOriginal ? 'embedded' : null),
          translatedLyricsSource: resolverTrack.translatedLyricsSource ?? null,
          romanizedLyricsSource: resolverTrack.romanizedLyricsSource ?? null
        })
        completeIfCurrent(
          hasOriginal ||
            hasLyricContent(resolverTrack.translatedLyrics) ||
            hasLyricContent(resolverTrack.romanizedLyrics)
            ? 'ready'
            : 'empty'
        )
        return
      }

      let resolved: Awaited<ReturnType<typeof resolveLyricsWithSources>>
      try {
        resolved = await resolveLyricsWithSources({
          track: resolverTrack,
          originalSource: resolverOriginalSource,
          translationSource: resolverTranslationSource,
          romanizationSource: resolverRomanizationSource,
          loadLocalLyrics: canLoadLocalLyrics
            ? () =>
                window.api.data
                  .getLyrics(resolverTrack.dir!, resolverTrack.fileName, resolverTrack.filePath)
                  .catch(() => null)
            : undefined,
          loadLocalTranslatedLyrics: canLoadLocalAuxiliaryLyrics
            ? () =>
                window.api.data
                  .getTranslatedLyrics(
                    resolverTrack.dir!,
                    resolverTrack.fileName,
                    resolverTrack.filePath
                  )
                  .catch(() => null)
            : undefined,
          loadLocalRomanizedLyrics: canLoadLocalAuxiliaryLyrics
            ? () =>
                window.api.data
                  .getRomanizedLyrics(
                    resolverTrack.dir!,
                    resolverTrack.fileName,
                    resolverTrack.filePath
                  )
                  .catch(() => null)
            : undefined,
          loadProviderLyrics: canLoadProviderLyrics
            ? async () => {
                await syncPluginProviders()
                return useMediaProviders().resolveLyrics(resolverTrack, {
                  signal: request.controller.signal
                })
              }
            : undefined,
          loadAmlTtml: canLoadAmlLyrics
            ? () => window.api.data.getAmlTtml(getAmlSongId(resolverTrack))
            : undefined,
          loadOnlineLyrics: canLoadOnlineLyrics
            ? async () => {
                const result = await window.api.data.searchOnlineLyrics({
                  title: resolverTrack.title,
                  artist: resolverTrack.artist,
                  album: resolverTrack.album || undefined,
                  durationSeconds:
                    typeof resolverTrack.duration === 'number' &&
                    Number.isFinite(resolverTrack.duration)
                      ? resolverTrack.duration
                      : undefined
                })
                return result.best?.syncedLyrics ?? result.best?.plainLyrics ?? null
              }
            : undefined,
          loadOnlineTranslation: canLoadOnlineLyrics
            ? async () => {
                await syncPluginProviders()
                const lyrics = await useMediaProviders().resolveLyrics(resolverTrack)
                return lyrics?.translatedLyrics ?? null
              }
            : undefined
        })
      } catch {
        resolved = {
          lyrics: resolverTrack.lyrics ?? null,
          translatedLyrics: resolverTrack.translatedLyrics ?? null,
          romanizedLyrics: resolverTrack.romanizedLyrics ?? null,
          lyricsSource: resolverTrack.lyricsSource ?? (hasOriginal ? 'embedded' : null),
          translatedLyricsSource: resolverTrack.translatedLyricsSource ?? null,
          romanizedLyricsSource: resolverTrack.romanizedLyricsSource ?? null,
          failure: 'provider'
        }
      }

      const currentOverride = lyricsManagement.entryFor(triggerTrack.id)
      const currentRequestedSource = currentOverride?.source ?? 'auto'
      const currentLayerSource = (
        key: 'originalSelection' | 'translationSelection' | 'romanizationSelection'
      ): LyricResolverSource | 'manual' => {
        const selection = currentOverride?.[key]
        if (
          selection === 'local' ||
          selection === 'amll' ||
          selection === 'provider' ||
          selection === 'manual'
        ) {
          return selection
        }
        if (
          currentRequestedSource === 'local' ||
          currentRequestedSource === 'amll' ||
          currentRequestedSource === 'provider'
        ) {
          return currentRequestedSource
        }
        return 'automatic'
      }
      if (
        `${currentRequestedSource}:${currentLayerSource('originalSelection')}:${currentLayerSource('translationSelection')}:${currentLayerSource('romanizationSelection')}` !==
        sourceSelectionSignature
      ) {
        completeIfCurrent()
        return
      }
      if (
        resolved.failure &&
        !hasLyricContent(resolved.lyrics) &&
        !hasLyricContent(resolved.translatedLyrics) &&
        !hasLyricContent(resolved.romanizedLyrics)
      ) {
        if (isCurrentRequest()) {
          options.lyricsLoadState.value = { trackId: triggerTrack.id, status: 'failed' }
          scheduleCurrentLyricsRetry(triggerTrack.id, request.activation)
        }
        return
      }
      commitResolvedLyrics(triggerTrack, resolverTrack, resolved)
      completeIfCurrent(
        hasLyricContent(resolved.lyrics) ||
          hasLyricContent(resolved.translatedLyrics) ||
          hasLyricContent(resolved.romanizedLyrics)
          ? 'ready'
          : 'empty'
      )
    }

    request.promise = Promise.resolve().then(run)
    activeLyricsLoads.set(triggerTrack.id, request)
    try {
      await request.promise
    } finally {
      if (activeLyricsLoads.get(triggerTrack.id) === request) {
        activeLyricsLoads.delete(triggerTrack.id)
      }
    }
  }

  function retryCurrentTrackLyricsIfNeeded(forceReload = false): void {
    const track = options.currentTrack.value
    if (!track) return
    const loading =
      options.lyricsLoadState.value.trackId === track.id &&
      options.lyricsLoadState.value.status === 'loading'
    const failed =
      options.lyricsLoadState.value.trackId === track.id &&
      options.lyricsLoadState.value.status === 'failed'
    if (!hasLyricContent(track.lyrics) || loading) {
      void ensureCurrentTrackLyricsLoaded(track, true, forceReload)
      return
    }
    if (failed) {
      void ensureCurrentTrackLyricsLoaded(track, true, forceReload)
    }
  }

  function onTrackChanged(trackId: string, previousTrackId: string): void {
    if (trackId === previousTrackId) return
    lyricsTrackActivation += 1
    abortInactiveLyricsLoads(trackId)
    clearLyricsRetryTimersExcept(trackId)
    pruneLyricsTrackMemory(trackId)
    if (!trackId) {
      options.lyricsLoadState.value = { trackId: '', status: 'idle' }
      return
    }
    lyricsRetryAttemptsByTrackId.delete(trackId)
    options.lyricsLoadState.value = {
      trackId,
      status: hasLyricContent(options.currentTrack.value?.lyrics) ? 'ready' : 'loading'
    }
  }

  function deleteLyricsBaseline(trackId: string): void {
    automaticLyricsBaselines.delete(trackId)
  }

  function clearLyricsBaselines(): void {
    automaticLyricsBaselines.clear()
  }

  return {
    ensureCurrentTrackLyricsLoaded,
    commitResolvedLyrics,
    retryCurrentTrackLyricsIfNeeded,
    onTrackChanged,
    deleteLyricsBaseline,
    clearLyricsBaselines
  }
}
