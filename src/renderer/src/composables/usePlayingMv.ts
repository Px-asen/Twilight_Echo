import {
  computed,
  onScopeDispose,
  readonly,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type DeepReadonly,
  type Ref,
  type ShallowRef
} from 'vue'
import {
  MEDIA_PROVIDER_MV_QUALITIES,
  MEDIA_PROVIDER_MV_SOURCES,
  type MediaProviderMvQuality,
  type MediaProviderMvSource,
  type MediaProviderMvStream
} from '../../../shared/providerMv.ts'
import type { CorePlayerTrack } from '../stores/player/corePlayerTypes.ts'
import type { CorePlayerMvResult } from '../../../shared/coreSystemPlayer.ts'

export type PlayingMvDisplayMode = 'ambient' | 'cinema'

export interface PendingMvPlaybackRequest {
  readonly id: number
  readonly trackId: string
  readonly requestedAt: number
}

const STORAGE_KEY_ENABLED = 'twilight.nowPlaying.mv.enabled'
const STORAGE_KEY_DISPLAY_MODE = 'twilight.nowPlaying.mv.displayMode'
const STORAGE_KEY_QUALITY = 'twilight.nowPlaying.mv.quality'
const STORAGE_KEY_SOURCE = 'twilight.nowPlaying.mv.source'
const STORAGE_KEY_OFFSETS = 'twilight.nowPlaying.mv.offsets'
const MAX_STORED_OFFSETS = 64
const MIN_MV_OFFSET_SECONDS = -15
const MAX_MV_OFFSET_SECONDS = 15
const PENDING_MV_REQUEST_TTL_MS = 15_000

export const MV_CINEMA_BOTTOM_TRIGGER_PX = 48
export const MV_CINEMA_EDGE_SNAP_PX = 8
export const MV_CINEMA_CHROME_HIDE_DELAY_MS = 1600

const MV_CINEMA_HOVER_HOLD_SELECTOR =
  '.title-bar, .player-bar:not(.player-bar-compact-visualizer), .player-bar.player-bar-compact-visualizer > :not(.compact-visualizer), .volume-drawer, .playlist-panel, .visualizer-toggle-button, .playback-time, .mv-cinema-meta-pill, .player-appearance-menu, #app-notice-history, .experience-flyout-panel'
const MV_CINEMA_MODAL_HOLD_SELECTOR =
  '.player-panel-dismiss, .player-appearance-menu, #app-notice-history, .experience-flyout, .settings-overlay-root--active'

export function isCinemaOverlayElementVisible(el: Element): boolean {
  let current: Element | null = el
  while (current) {
    if (
      current.getAttribute?.('aria-hidden') === 'true' ||
      current.hasAttribute?.('hidden')
    ) {
      return false
    }
    const htmlLike = current as Partial<HTMLElement>
    if (
      htmlLike.hidden ||
      htmlLike.style?.display === 'none' ||
      htmlLike.style?.visibility === 'hidden'
    ) {
      return false
    }
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(current)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity || '1') === 0
      ) {
        return false
      }
    }
    current = current.parentElement ?? null
  }
  return true
}

/**
 * Reveal pure MV cinema chrome only when the pointer moves downward into the
 * bottom touch zone (or reaches the literal bottom edge of the viewport).
 */
export function shouldRevealMvCinemaChrome(
  pointerY: number,
  prevPointerY: number | null,
  viewportHeight: number,
  triggerPx = MV_CINEMA_BOTTOM_TRIGGER_PX
): boolean {
  if (!Number.isFinite(pointerY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return false
  }
  const distanceFromBottom = viewportHeight - pointerY
  if (distanceFromBottom > triggerPx || distanceFromBottom < -8) return false
  if (distanceFromBottom <= MV_CINEMA_EDGE_SNAP_PX) return true
  return prevPointerY !== null && Number.isFinite(prevPointerY) && pointerY > prevPointerY
}

let nextMvPlaybackRequestId = 0
const pendingMvPlaybackRequestRef = shallowRef<PendingMvPlaybackRequest | null>(null)

export const pendingMvPlaybackRequest: DeepReadonly<ShallowRef<PendingMvPlaybackRequest | null>> =
  readonly(pendingMvPlaybackRequestRef)

export function requestMvPlayback(trackId: string): PendingMvPlaybackRequest | null {
  const trimmed = trackId.trim()
  if (!trimmed) return null
  const request: PendingMvPlaybackRequest = {
    id: ++nextMvPlaybackRequestId,
    trackId: trimmed,
    requestedAt: Date.now()
  }
  pendingMvPlaybackRequestRef.value = request
  return request
}

export function clearPendingMvPlaybackRequest(requestId?: number): void {
  if (requestId === undefined || pendingMvPlaybackRequestRef.value?.id === requestId) {
    pendingMvPlaybackRequestRef.value = null
  }
}

function readStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage quota or restricted context errors
  }
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  const raw = readStorage(key)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

function readStoredDisplayMode(): PlayingMvDisplayMode {
  return readStorage(STORAGE_KEY_DISPLAY_MODE) === 'cinema' ? 'cinema' : 'ambient'
}

function readStoredQuality(): MediaProviderMvQuality {
  const raw = readStorage(STORAGE_KEY_QUALITY) as MediaProviderMvQuality | null
  return raw && (MEDIA_PROVIDER_MV_QUALITIES as readonly string[]).includes(raw) ? raw : 'auto'
}

function readStoredSource(): MediaProviderMvSource {
  const raw = readStorage(STORAGE_KEY_SOURCE) as MediaProviderMvSource | null
  if (raw && (MEDIA_PROVIDER_MV_SOURCES as readonly string[]).includes(raw)) {
    return raw === 'ncm' ? 'ncm' : 'bili'
  }
  return 'bili'
}

function readStoredOffsets(): Record<string, number> {
  const raw = readStorage(STORAGE_KEY_OFFSETS)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const cleaned: Record<string, number> = {}
    for (const [trackId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        trackId &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= MIN_MV_OFFSET_SECONDS &&
        value <= MAX_MV_OFFSET_SECONDS &&
        value !== 0
      ) {
        cleaned[trackId] = Math.round(value * 10) / 10
      }
    }
    return cleaned
  } catch {
    return {}
  }
}

export interface UsePlayingMvOptions {
  currentTrack: ComputedRef<CorePlayerTrack | null> | Ref<CorePlayerTrack | null>
  surfaceActive: ComputedRef<boolean> | Ref<boolean>
  exclusiveMode: ComputedRef<boolean> | Ref<boolean>
  castTargetName: ComputedRef<string | null> | Ref<string | null>
  queryCurrentTrackMv: (
    options?: {
      quality?: MediaProviderMvQuality
      source?: MediaProviderMvSource
      force?: boolean
    },
    signal?: AbortSignal
  ) => Promise<CorePlayerMvResult | null>
  setAudioSuppressed: (suppressed: boolean) => Promise<unknown>
  onNotice?: (message: string) => void
}

export function usePlayingMv(options: UsePlayingMvOptions) {
  const mvEnabled = ref<boolean>(readStoredBoolean(STORAGE_KEY_ENABLED, true))
  const mvDisplayMode = ref<PlayingMvDisplayMode>(readStoredDisplayMode())
  const mvQuality = ref<MediaProviderMvQuality>(readStoredQuality())
  const mvSource = ref<MediaProviderMvSource>(readStoredSource())
  const mvOriginalAudioWanted = ref(false)
  const mvOffsets = ref<Record<string, number>>(readStoredOffsets())

  const mvLoading = ref(false)
  const mvAvailable = ref(false)
  const mvStream = shallowRef<MediaProviderMvStream | null>(null)
  const mvVideoReady = ref(false)

  let activeRequest: AbortController | null = null
  let activeOccurrenceKey = ''
  let retriedOccurrenceKey = ''
  let fallbackOccurrenceKey = ''
  let appliedSuppression = false
  let suppressionChain: Promise<void> = Promise.resolve()

  const currentOccurrenceKey = computed(() => {
    const track = options.currentTrack.value
    if (!track) return ''
    return `${track.id}\0${track.queueEntryId ?? ''}`
  })

  const mvOffsetSeconds = computed(() => {
    const id = options.currentTrack.value?.id
    if (!id) return 0
    return mvOffsets.value[id] ?? 0
  })

  const mvAudioSwitchBlockedReason = computed<string | null>(() => {
    if (options.castTargetName.value) {
      return '当前正在远程投屏，暂不支持切换 MV 原声'
    }
    if (options.exclusiveMode.value) {
      return '独占音频模式下声卡由原生引擎独占，请先关闭独占模式再开启 MV 原声'
    }
    return null
  })

  const mvOriginalAudioActive = computed(
    () =>
      mvOriginalAudioWanted.value &&
      mvAudioSwitchBlockedReason.value === null &&
      options.surfaceActive.value &&
      mvEnabled.value &&
      mvAvailable.value &&
      mvStream.value !== null &&
      mvVideoReady.value
  )

  const mvAmbientActive = computed(
    () =>
      options.surfaceActive.value &&
      mvEnabled.value &&
      mvAvailable.value &&
      mvStream.value !== null &&
      mvVideoReady.value &&
      mvDisplayMode.value === 'ambient'
  )

  const mvCinemaActive = computed(
    () =>
      options.surfaceActive.value &&
      mvEnabled.value &&
      mvAvailable.value &&
      mvStream.value !== null &&
      mvVideoReady.value &&
      mvDisplayMode.value === 'cinema'
  )

  const mvQualityBadge = computed(() => {
    const stream = mvStream.value
    if (!stream) return ''
    if (stream.quality === '4K' || (stream.height && stream.height >= 2000)) return '4K'
    if (stream.quality === '1080p' || (stream.height && stream.height >= 1080)) return '1080P'
    if (stream.quality === '720p' || (stream.height && stream.height >= 720)) return '720P'
    if (stream.quality === '480p' || (stream.height && stream.height >= 480)) return '480P'
    return ''
  })

  const mvProviderLabel = computed(() => {
    const providerId = mvStream.value?.providerId?.toLowerCase()
    if (providerId === 'bili') return 'B站'
    if (providerId === 'ncm') return '网易云'
    return ''
  })

  function syncAudioSuppression(target: boolean): void {
    if (appliedSuppression === target) return
    appliedSuppression = target
    suppressionChain = suppressionChain
      .catch(() => undefined)
      .then(async () => {
        await options.setAudioSuppressed(target)
      })
      .catch(() => {
        if (target) {
          appliedSuppression = false
          mvOriginalAudioWanted.value = false
        }
      })
  }

  watch(
    mvOriginalAudioActive,
    (active) => {
      syncAudioSuppression(active)
    },
    { immediate: true }
  )

  watch(mvAudioSwitchBlockedReason, (reason) => {
    if (reason && mvOriginalAudioWanted.value) {
      mvOriginalAudioWanted.value = false
      options.onNotice?.(reason)
    }
  })

  function cancelPendingLoad(): void {
    activeRequest?.abort()
    activeRequest = null
    mvLoading.value = false
  }

  function clearResolvedStream(): void {
    cancelPendingLoad()
    mvAvailable.value = false
    mvStream.value = null
    mvVideoReady.value = false
  }

  function setMvDisplayMode(mode: PlayingMvDisplayMode): void {
    mvDisplayMode.value = mode
    writeStorage(STORAGE_KEY_DISPLAY_MODE, mode)
  }

  function consumeMatchingPendingRequest(trackId: string, available: boolean): void {
    const req = pendingMvPlaybackRequestRef.value
    if (!req) return
    if (Date.now() - req.requestedAt > PENDING_MV_REQUEST_TTL_MS) {
      clearPendingMvPlaybackRequest(req.id)
      return
    }
    if (req.trackId !== trackId) return
    clearPendingMvPlaybackRequest(req.id)
    if (available) {
      if (!mvEnabled.value) {
        mvEnabled.value = true
        writeStorage(STORAGE_KEY_ENABLED, 'true')
      }
      setMvDisplayMode('cinema')
    } else {
      setMvDisplayMode('ambient')
      options.onNotice?.('当前歌曲暂无可用 MV')
    }
  }

  async function fetchCurrentMv(
    force = false,
    sourceOverride?: MediaProviderMvSource
  ): Promise<void> {
    const track = options.currentTrack.value
    const occurrenceKey = currentOccurrenceKey.value
    if (!track || !occurrenceKey || !options.surfaceActive.value) {
      if (!track) {
        activeOccurrenceKey = ''
        clearResolvedStream()
      }
      return
    }
    if (track.source === 'radio' || track.source === 'podcast') {
      activeOccurrenceKey = occurrenceKey
      clearResolvedStream()
      consumeMatchingPendingRequest(track.id, false)
      return
    }

    cancelPendingLoad()
    const controller = new AbortController()
    activeRequest = controller
    const occurrenceChanged = activeOccurrenceKey !== occurrenceKey
    activeOccurrenceKey = occurrenceKey
    if (occurrenceChanged) {
      mvAvailable.value = false
      mvStream.value = null
      mvVideoReady.value = false
    } else if (force) {
      mvVideoReady.value = false
    }
    mvLoading.value = true

    const requestedSource: MediaProviderMvSource =
      sourceOverride ?? (mvSource.value === 'ncm' ? 'ncm' : 'bili')
    try {
      const result = await options.queryCurrentTrackMv(
        {
          quality: mvQuality.value,
          source: requestedSource,
          ...(force ? { force: true } : {})
        },
        controller.signal
      )
      if (controller.signal.aborted || currentOccurrenceKey.value !== occurrenceKey) return
      const matchesCurrent =
        result?.current?.trackId === track.id &&
        (result.current.occurrenceId ?? null) === (track.queueEntryId ?? null)
      if (matchesCurrent && result?.available && result.stream) {
        if (mvStream.value?.url !== result.stream.url) {
          mvVideoReady.value = false
        }
        mvStream.value = result.stream
        mvAvailable.value = true
      } else {
        mvStream.value = null
        mvAvailable.value = false
        mvVideoReady.value = false
      }
      consumeMatchingPendingRequest(track.id, mvAvailable.value)
    } catch {
      if (controller.signal.aborted || currentOccurrenceKey.value !== occurrenceKey) return
      mvStream.value = null
      mvAvailable.value = false
      mvVideoReady.value = false
      consumeMatchingPendingRequest(track.id, false)
    } finally {
      if (activeRequest === controller) {
        activeRequest = null
        mvLoading.value = false
      }
    }
  }

  watch(
    [currentOccurrenceKey, () => options.surfaceActive.value, mvQuality, mvSource],
    (
      [occurrenceKey, active, quality, source],
      [prevOccurrenceKey, prevActive, prevQuality, prevSource]
    ) => {
      if (!occurrenceKey) {
        activeOccurrenceKey = ''
        retriedOccurrenceKey = ''
        fallbackOccurrenceKey = ''
        clearResolvedStream()
        return
      }
      if (!active) {
        cancelPendingLoad()
        return
      }
      const needReload =
        occurrenceKey !== activeOccurrenceKey ||
        occurrenceKey !== prevOccurrenceKey ||
        !prevActive ||
        quality !== prevQuality ||
        source !== prevSource
      if (needReload) {
        if (occurrenceKey !== prevOccurrenceKey || source !== prevSource || quality !== prevQuality) {
          retriedOccurrenceKey = ''
          fallbackOccurrenceKey = ''
        }
        void fetchCurrentMv(false)
      }
    },
    { immediate: true }
  )

  watch(
    pendingMvPlaybackRequestRef,
    (req) => {
      if (!req) return
      if (Date.now() - req.requestedAt > PENDING_MV_REQUEST_TTL_MS) {
        clearPendingMvPlaybackRequest(req.id)
        return
      }
      if (!mvEnabled.value) {
        mvEnabled.value = true
        writeStorage(STORAGE_KEY_ENABLED, 'true')
      }
      setMvDisplayMode('cinema')
      if (!options.surfaceActive.value) return
      const track = options.currentTrack.value
      if (!track || track.id !== req.trackId) return
      if (activeOccurrenceKey !== currentOccurrenceKey.value || mvLoading.value) return
      if (mvAvailable.value && mvStream.value !== null) {
        clearPendingMvPlaybackRequest(req.id)
        return
      }
      void fetchCurrentMv(false)
    },
    { immediate: true }
  )

  function toggleMvEnabled(): void {
    const next = !mvEnabled.value
    mvEnabled.value = next
    writeStorage(STORAGE_KEY_ENABLED, String(next))
    if (!next) {
      mvVideoReady.value = false
      if (mvDisplayMode.value === 'cinema') {
        mvDisplayMode.value = 'ambient'
        writeStorage(STORAGE_KEY_DISPLAY_MODE, 'ambient')
      }
    } else if (options.surfaceActive.value && !mvStream.value && !mvLoading.value) {
      void fetchCurrentMv(false)
    }
  }

  function playMvCinema(): void {
    if (!mvEnabled.value) {
      mvEnabled.value = true
      writeStorage(STORAGE_KEY_ENABLED, 'true')
    }
    setMvDisplayMode('cinema')
    if (options.surfaceActive.value && !mvStream.value && !mvLoading.value) {
      void fetchCurrentMv(false)
    }
  }

  function toggleMvCinemaMode(): void {
    setMvDisplayMode(mvDisplayMode.value === 'cinema' ? 'ambient' : 'cinema')
  }

  function toggleMvOriginalAudio(): void {
    if (!mvOriginalAudioWanted.value) {
      const blocked = mvAudioSwitchBlockedReason.value
      if (blocked) {
        options.onNotice?.(blocked)
        return
      }
      if (!mvEnabled.value) {
        mvEnabled.value = true
        writeStorage(STORAGE_KEY_ENABLED, 'true')
      }
      mvOriginalAudioWanted.value = true
    } else {
      mvOriginalAudioWanted.value = false
    }
  }

  function setMvQuality(quality: MediaProviderMvQuality): void {
    if (mvQuality.value === quality) return
    mvQuality.value = quality
    writeStorage(STORAGE_KEY_QUALITY, quality)
  }

  function setMvSource(source: MediaProviderMvSource): void {
    const normalized: MediaProviderMvSource = source === 'ncm' ? 'ncm' : 'bili'
    if (mvSource.value === normalized) return
    mvSource.value = normalized
    writeStorage(STORAGE_KEY_SOURCE, normalized)
  }

  function cycleMvSource(): MediaProviderMvSource {
    const next: MediaProviderMvSource = mvSource.value === 'ncm' ? 'bili' : 'ncm'
    setMvSource(next)
    return next
  }

  function adjustMvOffsetSeconds(delta: number): void {
    const id = options.currentTrack.value?.id
    if (!id) return
    const current = mvOffsets.value[id] ?? 0
    const next = Math.max(
      MIN_MV_OFFSET_SECONDS,
      Math.min(MAX_MV_OFFSET_SECONDS, Math.round((current + delta) * 10) / 10)
    )
    const copy = { ...mvOffsets.value }
    delete copy[id]
    if (next !== 0) {
      const keys = Object.keys(copy)
      while (keys.length >= MAX_STORED_OFFSETS) {
        const oldest = keys.shift()
        if (oldest) delete copy[oldest]
      }
      copy[id] = next
    }
    mvOffsets.value = copy
    writeStorage(STORAGE_KEY_OFFSETS, JSON.stringify(copy))
  }

  function resetMvOffsetSeconds(): void {
    const id = options.currentTrack.value?.id
    if (!id || !(id in mvOffsets.value)) return
    const copy = { ...mvOffsets.value }
    delete copy[id]
    mvOffsets.value = copy
    writeStorage(STORAGE_KEY_OFFSETS, JSON.stringify(copy))
  }

  function handleMvReady(): void {
    if (mvStream.value && mvEnabled.value) {
      mvVideoReady.value = true
    }
  }

  function handleMvStreamError(): void {
    mvVideoReady.value = false
    const occurrenceKey = currentOccurrenceKey.value
    if (!occurrenceKey || !options.surfaceActive.value) return
    if (retriedOccurrenceKey !== occurrenceKey) {
      retriedOccurrenceKey = occurrenceKey
      void fetchCurrentMv(true)
      return
    }
    const currentProvider = mvStream.value?.providerId?.toLowerCase()
    const trackSource = options.currentTrack.value?.source
    if (
      fallbackOccurrenceKey !== occurrenceKey &&
      currentProvider === 'bili' &&
      trackSource !== 'bili'
    ) {
      fallbackOccurrenceKey = occurrenceKey
      void fetchCurrentMv(true, 'ncm')
      return
    }
    mvStream.value = null
    mvAvailable.value = false
  }

  function refreshMv(): void {
    const occurrenceKey = currentOccurrenceKey.value
    if (!occurrenceKey) return
    retriedOccurrenceKey = occurrenceKey
    void fetchCurrentMv(true)
  }

  const mvCinemaChromeRevealed = ref(false)
  let lastCinemaPointerY: number | null = null
  let cinemaPointerOnChrome = false
  let cinemaPointerButtonsDown = false
  let cinemaHideTimer: ReturnType<typeof setTimeout> | null = null
  let cinemaListening = false

  function updateCinemaChromeDomAttr(state: 'hidden' | 'revealed' | null): void {
    if (typeof document === 'undefined' || !document.documentElement) return
    if (state === null) {
      delete document.documentElement.dataset.teMvCinemaChrome
    } else {
      document.documentElement.dataset.teMvCinemaChrome = state
    }
  }

  function clearCinemaChromeHideTimer(): void {
    if (cinemaHideTimer !== null) {
      clearTimeout(cinemaHideTimer)
      cinemaHideTimer = null
    }
  }

  function hasOpenCinemaOverlay(): boolean {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return false
    }
    const matches = document.querySelectorAll(MV_CINEMA_MODAL_HOLD_SELECTOR)
    for (const el of matches) {
      if (isCinemaOverlayElementVisible(el)) return true
    }
    return false
  }

  function holdsCinemaChromeOpen(): boolean {
    return cinemaPointerOnChrome || cinemaPointerButtonsDown || hasOpenCinemaOverlay()
  }

  function scheduleCinemaChromeHide(restart = false): void {
    if (!mvCinemaActive.value || !mvCinemaChromeRevealed.value || holdsCinemaChromeOpen()) return
    if (restart) {
      clearCinemaChromeHideTimer()
    } else if (cinemaHideTimer !== null) {
      return
    }
    cinemaHideTimer = setTimeout(() => {
      cinemaHideTimer = null
      if (!mvCinemaActive.value) return
      if (holdsCinemaChromeOpen()) {
        scheduleCinemaChromeHide(false)
        return
      }
      mvCinemaChromeRevealed.value = false
      updateCinemaChromeDomAttr('hidden')
    }, MV_CINEMA_CHROME_HIDE_DELAY_MS)
  }

  function notifyMvCinemaPointer(
    clientY: number,
    viewportHeight: number,
    onChrome = false,
    buttonsDown = false
  ): void {
    if (!mvCinemaActive.value) return
    const prevY = lastCinemaPointerY
    lastCinemaPointerY = clientY
    cinemaPointerOnChrome = onChrome
    cinemaPointerButtonsDown = buttonsDown
    const inBottomTrigger =
      Number.isFinite(viewportHeight) &&
      viewportHeight > 0 &&
      viewportHeight - clientY <= MV_CINEMA_BOTTOM_TRIGGER_PX

    if (!mvCinemaChromeRevealed.value) {
      if (shouldRevealMvCinemaChrome(clientY, prevY, viewportHeight)) {
        clearCinemaChromeHideTimer()
        mvCinemaChromeRevealed.value = true
        updateCinemaChromeDomAttr('revealed')
        if (!holdsCinemaChromeOpen()) {
          scheduleCinemaChromeHide(true)
        }
      }
      return
    }

    if (holdsCinemaChromeOpen()) {
      clearCinemaChromeHideTimer()
    } else {
      scheduleCinemaChromeHide(inBottomTrigger)
    }
  }

  function onCinemaPointerMove(event: PointerEvent): void {
    if (!mvCinemaActive.value) return
    if (typeof document !== 'undefined' && document.hidden) return
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0
    const matchedChrome =
      typeof Element !== 'undefined' && event.target instanceof Element
        ? event.target.closest(MV_CINEMA_HOVER_HOLD_SELECTOR)
        : null
    const onChrome = matchedChrome !== null && isCinemaOverlayElementVisible(matchedChrome)
    notifyMvCinemaPointer(event.clientY, vh, onChrome, event.buttons > 0)
  }

  function recheckCinemaChromeAfterInteraction(): void {
    if (!mvCinemaActive.value) return
    cinemaPointerButtonsDown = false
    queueMicrotask(() => {
      if (mvCinemaActive.value && mvCinemaChromeRevealed.value && !holdsCinemaChromeOpen()) {
        scheduleCinemaChromeHide(false)
      }
    })
  }

  function onCinemaPointerLeaveOrBlur(): void {
    if (!mvCinemaActive.value) return
    cinemaPointerOnChrome = false
    cinemaPointerButtonsDown = false
    lastCinemaPointerY = null
    scheduleCinemaChromeHide(false)
  }

  function startCinemaChromeListeners(): void {
    if (cinemaListening || typeof window === 'undefined') return
    cinemaListening = true
    window.addEventListener('pointermove', onCinemaPointerMove, { passive: true })
    window.addEventListener('pointerup', recheckCinemaChromeAfterInteraction, { passive: true })
    window.addEventListener('pointercancel', recheckCinemaChromeAfterInteraction, { passive: true })
    window.addEventListener('click', recheckCinemaChromeAfterInteraction, { passive: true })
    window.addEventListener('blur', onCinemaPointerLeaveOrBlur)
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerleave', onCinemaPointerLeaveOrBlur)
    }
  }

  function stopCinemaChromeListeners(): void {
    if (!cinemaListening || typeof window === 'undefined') return
    cinemaListening = false
    window.removeEventListener('pointermove', onCinemaPointerMove)
    window.removeEventListener('pointerup', recheckCinemaChromeAfterInteraction)
    window.removeEventListener('pointercancel', recheckCinemaChromeAfterInteraction)
    window.removeEventListener('click', recheckCinemaChromeAfterInteraction)
    window.removeEventListener('blur', onCinemaPointerLeaveOrBlur)
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerleave', onCinemaPointerLeaveOrBlur)
    }
  }

  watch(
    mvCinemaActive,
    (active) => {
      clearCinemaChromeHideTimer()
      lastCinemaPointerY = null
      cinemaPointerOnChrome = false
      cinemaPointerButtonsDown = false
      if (active) {
        mvCinemaChromeRevealed.value = false
        updateCinemaChromeDomAttr('hidden')
        startCinemaChromeListeners()
        return
      }
      stopCinemaChromeListeners()
      mvCinemaChromeRevealed.value = false
      updateCinemaChromeDomAttr(null)
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    stopCinemaChromeListeners()
    clearCinemaChromeHideTimer()
    updateCinemaChromeDomAttr(null)
    cancelPendingLoad()
    mvVideoReady.value = false
    if (appliedSuppression) {
      syncAudioSuppression(false)
    }
  })

  return {
    mvEnabled,
    mvDisplayMode,
    mvQuality,
    mvSource,
    mvLoading,
    mvAvailable,
    mvStream,
    mvVideoReady,
    mvOffsetSeconds,
    mvOriginalAudioWanted,
    mvOriginalAudioActive,
    mvAmbientActive,
    mvCinemaActive,
    mvCinemaChromeRevealed,
    mvQualityBadge,
    mvProviderLabel,
    mvAudioSwitchBlockedReason,
    toggleMvEnabled,
    playMvCinema,
    setMvDisplayMode,
    toggleMvCinemaMode,
    toggleMvOriginalAudio,
    setMvQuality,
    setMvSource,
    cycleMvSource,
    adjustMvOffsetSeconds,
    resetMvOffsetSeconds,
    handleMvReady,
    handleMvStreamError,
    refreshMv,
    notifyMvCinemaPointer
  }
}
