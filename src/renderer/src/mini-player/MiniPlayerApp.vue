<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  EMPTY_MINI_PLAYER_STATE,
  cloneMiniPlayerSettings,
  cloneMiniPlayerThemeProfile,
  nextMiniPlayerSizePreset,
  type MiniPlayerCommand,
  type MiniPlayerSettingsPatch,
  type MiniPlayerStateSnapshot,
  type MiniPlayerWindowSize
} from '../../../shared/miniPlayer.ts'
import MiniGlyph from './MiniGlyph.vue'
import PlaybackModeIcon from '../components/icons/PlaybackModeIcon.vue'
import ThemeIcon from '../components/ThemeIcon.vue'
import { observeMiniPlayerThemeIcons } from '../app/themeIconRuntime'
import DEFAULT_TRACK_COVER from '../assets/images/default-track-cover-light.png'
import '../assets/default-track-cover.css'
import MiniPlayerCustomizer from './MiniPlayerCustomizer.vue'
import ScrollingText from './ScrollingText.vue'
import {
  buildMiniPlayerCssVariables,
  resolveMiniPlayerLayout,
  resolveMiniPlayerVisibility
} from './presentation'
import { resolveMiniPlayerStyle } from './styles'
import { useMiniPlayerCustomizationDraft } from './useMiniPlayerCustomizationDraft'
import { useMotionPreference } from '../app/useMotionPreference'
import { useResolvedMotionMode } from '../app/useResolvedMotionMode'
import { useCover } from '../utils/coverLoader'
import { extractAverageColor } from '../utils/colorExtractor'
import { useSmoothedValue } from '../utils/useSmoothedValue'
import type { MotionPreference } from '../../../shared/motion.ts'
import { estimateMiniPlayerTime } from '../../../shared/miniPlayerClock.ts'

const VOLUME_STEP = 0.05
const VOLUME_HUD_MS = 1100
const DRAG_THRESHOLD_PX = 3
const REMAINING_TIME_STORAGE_KEY = 'te-mini-player-remaining-time'
/** The customizer panel needs this much room, with a preview column beside it; smaller forms grow while it is open. */
const CUSTOMIZER_MIN_SIZE: MiniPlayerWindowSize = { width: 520, height: 340 }

const state = ref<MiniPlayerStateSnapshot>({ ...EMPTY_MINI_PLAYER_STATE })
const clockNow = ref(Date.now())
let receivedAtMs = clockNow.value
let clockTimer: ReturnType<typeof setInterval> | null = null
const playbackTime = computed(() =>
  estimateMiniPlayerTime(state.value, clockNow.value, receivedAtMs)
)
watch(
  state,
  () => {
    receivedAtMs = Date.now()
    clockNow.value = receivedAtMs
  },
  { flush: 'sync' }
)
const ready = ref(false)
const bootstrapError = ref('')
const coverFailed = ref(false)
const coverSurfaceColor = ref<string | null>(null)
const customizerOpen = ref(false)
const customizerLayout = ref(false)
const customizerOpening = ref(false)
const artworkElement = ref<HTMLElement | null>(null)
let customizerGeneration = 0
let artworkAnimation: Animation | null = null
const hovered = ref(false)
const dragging = ref(false)
const volumeHudVisible = ref(false)
const showRemaining = ref(readRemainingPreference())
const viewportWidth = ref(Math.max(1, window.innerWidth))
const viewportHeight = ref(Math.max(1, window.innerHeight))
const motionPreference = ref<MotionPreference>('system')
useMotionPreference(motionPreference)
const motionMode = useResolvedMotionMode(motionPreference)
watch(
  motionMode,
  () => {
    artworkAnimation?.cancel()
    artworkAnimation = null
  },
  { flush: 'sync' }
)

let volumeBeforeMute = 0.6
let volumeHudTimer: ReturnType<typeof setTimeout> | null = null
let sizeBeforeCustomizer: MiniPlayerWindowSize | null = null
let dragOrigin: { pointerX: number; pointerY: number; windowX: number; windowY: number } | null =
  null
let dragMoved = false
let dragFrame = 0
let pendingMove: { x: number; y: number } | null = null

const customization = useMiniPlayerCustomizationDraft({
  initial: cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS),
  persist: async (settings) => await window.api.miniPlayer.updateSettings(settings)
})
const { settings } = customization

const activeProfile = computed(
  () => settings.value.profiles[settings.value.activeStyleId] ?? customization.activeProfile.value
)
const activeStyle = computed(() => resolveMiniPlayerStyle(settings.value.activeStyleId))
const hasTrack = computed(() => Boolean(state.value.track))
const rawProgressPercent = computed(() =>
  state.value.duration > 0
    ? Math.min(100, Math.max(0, (playbackTime.value / state.value.duration) * 100))
    : 0
)
// Snapshot pushes are stepped; glide between them like the main PlayerBar.
const progressPercent = useSmoothedValue(rawProgressPercent, { tau: 160, snapThreshold: 2.5 })
const progressStyle = computed<CSSProperties>(() => ({
  '--mini-progress': `${Math.min(100, Math.max(0, progressPercent.value)) / 100}`
}))
const resolvedLayout = computed(() =>
  resolveMiniPlayerLayout(
    viewportWidth.value,
    viewportHeight.value,
    activeProfile.value.layout.preference
  )
)
const isCompact = computed(() => resolvedLayout.value === 'compact')
const showsInlineVolume = computed(() => resolvedLayout.value === 'wide')
// The larger forms set the title as a two-line headline instead of a marquee.
const wrapsTitle = computed(
  () => resolvedLayout.value === 'wide' || resolvedLayout.value === 'poster'
)
const showsFavorite = computed(() => !isCompact.value && state.value.favoriteAvailable)
const resolvedVisibility = computed(() =>
  resolveMiniPlayerVisibility(activeProfile.value.visibility, resolvedLayout.value)
)
const styleVariables = computed(
  () =>
    ({
      ...activeStyle.value.tokens,
      ...buildMiniPlayerCssVariables(
        activeProfile.value,
        state.value.dominantColor,
        state.value.volume * 100,
        coverSurfaceColor.value
      )
    }) as CSSProperties
)
const styleClasses = computed(() => [
  activeStyle.value.className,
  {
    'is-ready': ready.value,
    'is-playing': state.value.isPlaying,
    'is-empty': !hasTrack.value,
    // Empty larger forms keep their tools out; the strip would lose its message.
    'is-hovered': hovered.value || (!hasTrack.value && !isCompact.value),
    'is-dragging': dragging.value,
    'is-position-locked': settings.value.positionLocked,
    'is-artwork-hidden': !resolvedVisibility.value.artwork,
    'is-cover-mode': activeProfile.value.background.kind === 'cover',
    'has-cover-background': hasCoverBackground.value,
    'is-customizing': customizerLayout.value,
    'is-volume-hud': volumeHudVisible.value
  }
])
// cover:// / background:// handles and expired twilight-media grants cannot be
// painted directly in this window — materialize / re-grant through the same
// loader the main window uses (IPC getCover + coverSource re-grant).
const coverSrc = useCover(
  computed(() => state.value.track?.cover),
  computed(() => state.value.track?.coverSource)
)
const hasCover = computed(() => Boolean(coverSrc.value) && !coverFailed.value)
const hasCoverBackground = computed(
  () => activeProfile.value.background.kind === 'cover' && hasCover.value
)
const backgroundSourceStyle = computed<CSSProperties>(() => {
  const background = activeProfile.value.background
  const fallback = { backgroundColor: background.fallbackColor }

  if (background.kind === 'solid') return { backgroundColor: background.solidColor }
  if (background.kind === 'gradient') {
    return {
      ...fallback,
      backgroundImage: `linear-gradient(${background.gradientAngle}deg, ${background.gradientStart}, ${background.gradientEnd})`
    }
  }
  if (background.kind === 'cover') {
    return hasCover.value && coverSrc.value
      ? { backgroundImage: cssBackgroundUrl(coverSrc.value) }
      : {}
  }
  if (background.kind === 'image' && background.imageUrl) {
    return { ...fallback, backgroundImage: cssBackgroundUrl(background.imageUrl) }
  }
  return fallback
})
const trackKey = computed(() => state.value.track?.id ?? 'empty')
const backgroundSourceKey = computed(() =>
  hasCoverBackground.value ? `cover:${trackKey.value}:${coverSrc.value}` : 'background'
)
const trackTitle = computed(() => state.value.track?.title || '此刻安静')
const trackArtist = computed(() => state.value.track?.artist || '在主窗口挑一首歌开始')
const trackQuality = computed(() => {
  const track = state.value.track
  if (!track) return { label: '', spec: '', isHiRes: false }
  const format = (track.format ?? '').trim().toUpperCase()
  const sampleRate =
    typeof track.sampleRate === 'number' && track.sampleRate > 0
      ? track.sampleRate >= 1000
        ? `${(track.sampleRate / 1000).toFixed(track.sampleRate % 1000 === 0 ? 0 : 1)}kHz`
        : `${track.sampleRate}Hz`
      : ''
  const bitDepth =
    typeof track.bitDepth === 'number' && track.bitDepth > 0 ? `${track.bitDepth}bit` : ''
  const spec = [format, bitDepth, sampleRate].filter(Boolean).join(' · ')
  const lossless = /^(flac|alac|wav|aiff|aif|ape|dsf|dff|tta|wv|m4a)$/i.test(format)
  const isHiRes = (track.bitDepth ?? 0) >= 24 || (track.sampleRate ?? 0) >= 96000
  return {
    label: isHiRes ? 'Hi-Res' : lossless ? 'Lossless' : '',
    spec,
    isHiRes
  }
})
const queuePositionText = computed(() =>
  state.value.queueLength > 0 && state.value.queueIndex >= 0
    ? `${state.value.queueIndex + 1} / ${state.value.queueLength}`
    : ''
)
const kickerText = computed(() => {
  if (!hasTrack.value) return 'Twilight Echo'
  const album = resolvedVisibility.value.album ? state.value.track?.album || '' : ''
  const queue = resolvedVisibility.value.queuePosition ? queuePositionText.value : ''
  return [album, queue].filter(Boolean).join('  ·  ')
})
const playModeTitle = computed(() => {
  if (state.value.playMode === 'heart') return '心动模式'
  if (state.value.playMode === 'listLoop') return '列表循环'
  if (state.value.playMode === 'repeat') return '单曲循环'
  if (state.value.playMode === 'shuffle') return '随机播放'
  return '顺序播放'
})
const volumePercent = computed(() => Math.round(state.value.volume * 100))
const volumeIcon = computed(() => {
  if (state.value.volume <= 0.001) return 'ph ph-speaker-simple-x'
  if (state.value.volume < 0.34) return 'ph ph-speaker-simple-none'
  if (state.value.volume < 0.67) return 'ph ph-speaker-simple-low'
  return 'ph ph-speaker-simple-high'
})
const nextFormLabel = computed(
  () =>
    nextMiniPlayerSizePreset({
      width: settings.value.windowWidth,
      height: settings.value.windowHeight
    }).label
)
const elapsedText = computed(() => formatTime(playbackTime.value))
const trailingTimeText = computed(() =>
  showRemaining.value && state.value.duration > 0
    ? `-${formatTime(Math.max(0, state.value.duration - playbackTime.value))}`
    : formatTime(state.value.duration)
)

function cssBackgroundUrl(value: string): string {
  return `url(${JSON.stringify(value)})`
}

function sendCommand(command: MiniPlayerCommand): void {
  window.api.miniPlayer.command(command)
}

function togglePlay(): void {
  if (!hasTrack.value || state.value.isLoading) return
  sendCommand({ type: 'toggle-play' })
}

function toggleFavorite(): void {
  if (!state.value.favoriteAvailable || state.value.favoriteLoading) return
  state.value = { ...state.value, favoriteLiked: !state.value.favoriteLiked }
  sendCommand({ type: 'toggle-favorite' })
}

function seekTo(value: number): void {
  if (!hasTrack.value) return
  const time = Math.min(state.value.duration || value, Math.max(0, value))
  state.value = { ...state.value, currentTime: time, capturedAtMs: Date.now() }
  sendCommand({ type: 'seek', value: time })
}

function onProgressInput(event: Event): void {
  seekTo(Number((event.target as HTMLInputElement).value))
}

function setVolume(value: number, options: { hud?: boolean } = {}): void {
  const volume = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
  state.value = { ...state.value, volume }
  sendCommand({ type: 'set-volume', value: volume })
  if (options.hud) flashVolumeHud()
}

function onVolumeInput(event: Event): void {
  setVolume(Number((event.target as HTMLInputElement).value))
}

function toggleMute(hud = !showsInlineVolume.value): void {
  if (state.value.volume > 0.001) {
    volumeBeforeMute = state.value.volume
    setVolume(0, { hud })
  } else {
    setVolume(volumeBeforeMute > 0.001 ? volumeBeforeMute : 0.6, { hud })
  }
}

function flashVolumeHud(): void {
  volumeHudVisible.value = true
  if (volumeHudTimer) clearTimeout(volumeHudTimer)
  volumeHudTimer = setTimeout(() => {
    volumeHudTimer = null
    volumeHudVisible.value = false
  }, VOLUME_HUD_MS)
}

function onWheel(event: WheelEvent): void {
  if (customizerOpen.value || event.deltaY === 0) return
  const target = event.target
  if (target instanceof Element && target.closest('.mini-customizer')) return
  setVolume(state.value.volume + (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP), { hud: true })
}

function readRemainingPreference(): boolean {
  try {
    return window.localStorage.getItem(REMAINING_TIME_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function toggleRemainingTime(): void {
  showRemaining.value = !showRemaining.value
  try {
    window.localStorage.setItem(REMAINING_TIME_STORAGE_KEY, showRemaining.value ? '1' : '0')
  } catch {
    // Per-window convenience only; the toggle still works for this session.
  }
}

async function updateWindowSettings(patch: MiniPlayerSettingsPatch): Promise<boolean> {
  customization.replaceSettings({ ...settings.value, ...patch })
  try {
    await customization.flush()
    return true
  } catch (error) {
    console.error('[mini-player] Failed to update window settings:', error)
    return false
  }
}

function togglePositionLock(): void {
  void updateWindowSettings({ positionLocked: !settings.value.positionLocked })
}

function toggleAlwaysOnTop(): void {
  void updateWindowSettings({ alwaysOnTop: !settings.value.alwaysOnTop })
}

function cycleForm(): void {
  const preset = nextMiniPlayerSizePreset({
    width: settings.value.windowWidth,
    height: settings.value.windowHeight
  })
  const styleId = settings.value.activeStyleId
  const profile = settings.value.profiles[styleId]
  // A pinned layout would keep the old arrangement inside the new window shape.
  const profiles =
    profile && profile.layout.preference !== 'auto'
      ? {
          ...settings.value.profiles,
          [styleId]: {
            ...cloneMiniPlayerThemeProfile(profile),
            layout: { preference: 'auto' as const }
          }
        }
      : settings.value.profiles
  void updateWindowSettings({
    windowWidth: preset.width,
    windowHeight: preset.height,
    profiles
  })
}

async function animateCustomizerArtwork(
  before: DOMRect | undefined,
  generation: number
): Promise<void> {
  await nextTick()
  if (generation !== customizerGeneration) return
  const artwork = artworkElement.value
  artworkAnimation?.cancel()
  artworkAnimation = null
  if (!artwork || !before || motionMode.value === 'off') return
  const after = artwork.getBoundingClientRect()
  if (!after.width || !after.height || !before.width || !before.height) return
  const targetTransform = getComputedStyle(artwork).transform
  const dx = before.left + before.width / 2 - after.left - after.width / 2
  const dy = before.top + before.height / 2 - after.top - after.height / 2
  const reduced = motionMode.value === 'reduced'
  const animation = artwork.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          {
            transform: `translate(${dx}px, ${dy}px) scale(${before.width / after.width}, ${before.height / after.height}) ${targetTransform === 'none' ? '' : targetTransform}`
          },
          { transform: targetTransform }
        ],
    { duration: reduced ? 120 : 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
  )
  artworkAnimation = animation
  void animation.finished
    .then(() => {
      if (artworkAnimation === animation) artworkAnimation = null
    })
    .catch(() => undefined)
}

async function openCustomizer(): Promise<void> {
  if (customizerOpen.value) {
    customizerGeneration++
    return
  }
  if (customizerOpening.value) return
  const generation = ++customizerGeneration
  const before = artworkElement.value?.getBoundingClientRect()
  customizerOpening.value = true
  if (!customizerLayout.value) customization.beginSession()
  const { windowWidth, windowHeight } = settings.value
  if (windowWidth < CUSTOMIZER_MIN_SIZE.width || windowHeight < CUSTOMIZER_MIN_SIZE.height) {
    sizeBeforeCustomizer ??= { width: windowWidth, height: windowHeight }
    await updateWindowSettings({
      windowWidth: Math.max(windowWidth, CUSTOMIZER_MIN_SIZE.width),
      windowHeight: Math.max(windowHeight, CUSTOMIZER_MIN_SIZE.height)
    })
  }
  if (generation !== customizerGeneration) return
  customizerOpening.value = false
  customizerLayout.value = true
  customizerOpen.value = true
  await animateCustomizerArtwork(before, generation)
}

async function closeCustomizer(action: 'save' | 'undo' = 'save'): Promise<void> {
  const generation = ++customizerGeneration
  try {
    if (action === 'undo') await customization.undoSession()
    else await customization.flush()
    if (generation !== customizerGeneration) return
    customizerOpening.value = false
    customizerOpen.value = false
    if (!customizerLayout.value) await finishCustomizerLeave()
  } catch {
    // The editor stays open so its inline persistence error remains actionable.
    if (generation !== customizerGeneration) return
    customizerOpening.value = false
    customizerLayout.value = true
    customizerOpen.value = true
  }
}

async function finishCustomizerLeave(): Promise<void> {
  if (customizerOpen.value || customizerOpening.value) return
  const generation = customizerGeneration
  const before = artworkElement.value?.getBoundingClientRect()
  if (sizeBeforeCustomizer) {
    const previous = sizeBeforeCustomizer
    const restored = await updateWindowSettings({
      windowWidth: previous.width,
      windowHeight: previous.height
    })
    if (generation !== customizerGeneration) return
    if (!restored) {
      customizerLayout.value = true
      customizerOpen.value = true
      return
    }
    sizeBeforeCustomizer = null
  }
  customizerLayout.value = false
  if (generation === customizerGeneration) await animateCustomizerArtwork(before, generation)
}

async function pickBackgroundImage(): Promise<string | null> {
  return await window.api.miniPlayer.chooseBackgroundImage()
}

async function minimizeWindow(): Promise<void> {
  try {
    await customization.flush()
    window.api.miniPlayer.minimize()
  } catch {
    // Keep the window visible when the latest customization could not be saved.
  }
}

async function returnToMainWindow(): Promise<void> {
  try {
    await customization.flush()
    window.api.miniPlayer.returnToMain()
  } catch {
    // Keep the window visible when the latest customization could not be saved.
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function updateViewportSize(): void {
  viewportWidth.value = Math.max(1, window.innerWidth)
  viewportHeight.value = Math.max(1, window.innerHeight)
}

function flushMove(): void {
  dragFrame = 0
  if (!pendingMove) return
  window.api.miniPlayer.moveTo(pendingMove.x, pendingMove.y)
  pendingMove = null
}

// The window moves itself: an `app-region: drag` surface would be reported to
// Windows as caption area and swallow every hover the controls reveal on.
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || settings.value.positionLocked || customizerOpen.value) return
  const target = event.target
  if (target instanceof Element && target.closest('button, input, label, [data-mini-interactive]'))
    return
  dragOrigin = {
    pointerX: event.screenX,
    pointerY: event.screenY,
    windowX: window.screenX,
    windowY: window.screenY
  }
  dragMoved = false
  const root = event.currentTarget
  if (root instanceof Element) {
    try {
      root.setPointerCapture(event.pointerId)
    } catch {
      dragOrigin = null
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!dragOrigin) return
  const deltaX = event.screenX - dragOrigin.pointerX
  const deltaY = event.screenY - dragOrigin.pointerY
  if (!dragMoved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return
  dragMoved = true
  dragging.value = true
  pendingMove = { x: dragOrigin.windowX + deltaX, y: dragOrigin.windowY + deltaY }
  if (dragFrame === 0) dragFrame = requestAnimationFrame(flushMove)
}

function endDrag(): void {
  if (!dragOrigin) return
  dragOrigin = null
  dragging.value = false
  if (dragFrame !== 0) cancelAnimationFrame(dragFrame)
  flushMove()
  if (dragMoved) window.api.miniPlayer.moveEnd()
  dragMoved = false
}

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (customizerOpen.value || customizerOpening.value) await closeCustomizer()
    else await returnToMainWindow()
    return
  }

  const target = event.target as HTMLElement | null
  if (target?.tagName === 'INPUT' || customizerOpen.value) return
  const withModifier = event.ctrlKey || event.metaKey

  switch (event.key) {
    case ' ':
      event.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      event.preventDefault()
      if (withModifier) sendCommand({ type: 'previous' })
      else seekTo(playbackTime.value - 5)
      break
    case 'ArrowRight':
      event.preventDefault()
      if (withModifier) sendCommand({ type: 'next' })
      else seekTo(playbackTime.value + 5)
      break
    case 'ArrowUp':
      event.preventDefault()
      setVolume(state.value.volume + VOLUME_STEP, { hud: true })
      break
    case 'ArrowDown':
      event.preventDefault()
      setVolume(state.value.volume - VOLUME_STEP, { hud: true })
      break
    case 'm':
    case 'M':
      event.preventDefault()
      toggleMute(true)
      break
    case 'l':
    case 'L':
      event.preventDefault()
      toggleFavorite()
      break
  }
}

let removeStateListener: (() => void) | null = null
let removeSettingsListener: (() => void) | null = null
let removeMotionPreferenceListener: (() => void) | null = null
let removeThemeIconListener: (() => void) | null = null

onMounted(async () => {
  removeThemeIconListener = observeMiniPlayerThemeIcons()
  clockTimer = setInterval(() => {
    clockNow.value = Date.now()
  }, 50)
  removeStateListener = window.api.miniPlayer.onState((nextState) => {
    state.value = nextState
  })
  removeSettingsListener = window.api.miniPlayer.onSettings((nextSettings) => {
    customization.acceptConfirmed(nextSettings)
  })
  removeMotionPreferenceListener = window.api.miniPlayer.onMotionPreference((nextPreference) => {
    motionPreference.value = nextPreference
  })
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('resize', updateViewportSize)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', endDrag)
  document.addEventListener('pointercancel', endDrag)
  updateViewportSize()

  await loadBootstrap()
})

async function loadBootstrap(): Promise<void> {
  bootstrapError.value = ''
  try {
    const bootstrap = await window.api.miniPlayer.getBootstrap()
    state.value = bootstrap.state
    customization.acceptConfirmed(bootstrap.settings)
    motionPreference.value = bootstrap.motionPreference
  } catch (error) {
    console.error('[mini-player] Failed to load initial state:', error)
    bootstrapError.value = error instanceof Error ? error.message : String(error)
  } finally {
    requestAnimationFrame(() => {
      ready.value = true
    })
  }
}

watch(coverSrc, (source, _previous, onCleanup) => {
  coverFailed.value = false
  coverSurfaceColor.value = null
  if (!source) return
  let active = true
  onCleanup(() => {
    active = false
  })
  void extractAverageColor(source).then((color) => {
    if (active) coverSurfaceColor.value = color
  })
})

onBeforeUnmount(() => {
  customizerGeneration++
  artworkAnimation?.cancel()
  artworkAnimation = null
  if (clockTimer !== null) clearInterval(clockTimer)
  if (volumeHudTimer) clearTimeout(volumeHudTimer)
  if (dragFrame !== 0) cancelAnimationFrame(dragFrame)
  const pendingFlush = customization.flush()
  customization.dispose()
  void pendingFlush.catch(() => undefined)
  removeStateListener?.()
  removeSettingsListener?.()
  removeMotionPreferenceListener?.()
  removeThemeIconListener?.()
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updateViewportSize)
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', endDrag)
  document.removeEventListener('pointercancel', endDrag)
})
</script>

<template>
  <main
    v-if="settings.profiles[settings.activeStyleId]"
    class="mini-player-root"
    :class="styleClasses"
    :style="styleVariables"
    :data-layout="resolvedLayout"
    :data-theme-profile="settings.activeStyleId"
    @pointerenter="hovered = true"
    @pointerleave="hovered = false"
    @pointerdown="onPointerDown"
    @wheel.passive="onWheel"
  >
    <div class="mini-window-fill" aria-hidden="true"></div>
    <section class="mini-player-surface">
      <Transition name="mini-backdrop-fade">
        <div
          :key="backgroundSourceKey"
          class="mini-background-source"
          :style="backgroundSourceStyle"
          aria-hidden="true"
        ></div>
      </Transition>
      <div class="mini-background-overlay" aria-hidden="true"></div>
      <div class="mini-grain" aria-hidden="true"></div>

      <div v-if="bootstrapError" class="mini-bootstrap-error" role="alert">
        <p>迷你播放器加载失败：{{ bootstrapError }}</p>
        <div class="mini-bootstrap-actions">
          <button type="button" @click="loadBootstrap">重试</button>
          <button type="button" @click="returnToMainWindow">回主窗口</button>
        </div>
      </div>

      <div
        v-if="resolvedVisibility.artwork"
        ref="artworkElement"
        class="mini-artwork-wrap"
        title="双击返回完整播放器"
        @dblclick="returnToMainWindow"
      >
        <Transition name="mini-art-swap">
          <img
            :key="`art:${trackKey}:${coverSrc}`"
            :src="hasCover ? coverSrc || DEFAULT_TRACK_COVER : DEFAULT_TRACK_COVER"
            class="mini-artwork"
            :class="{ 'default-track-cover': !hasCover }"
            alt="专辑封面"
            draggable="false"
            @error="coverFailed = true"
          />
        </Transition>
        <span class="mini-artwork-sheen" aria-hidden="true"></span>
      </div>

      <div class="mini-info" :inert="customizerLayout">
        <div v-if="!isCompact" class="mini-kicker">
          <span
            v-if="resolvedVisibility.equalizer && hasTrack"
            class="mini-equalizer"
            :class="{ active: state.isPlaying }"
            aria-hidden="true"
          >
            <span></span><span></span><span></span>
          </span>
          <span
            v-if="trackQuality.label"
            class="mini-quality-badge"
            :class="{ 'is-hires': trackQuality.isHiRes }"
            :title="trackQuality.spec"
          >
            {{ trackQuality.label }}
          </span>
          <span class="mini-kicker-text" :title="kickerText">{{ kickerText }}</span>
        </div>
        <Transition name="mini-meta-swap" mode="out-in">
          <div :key="`meta:${trackKey}`" class="mini-track-meta">
            <div class="mini-track-text">
              <h1 class="mini-title" :title="trackTitle">
                <span v-if="wrapsTitle" class="mini-title-lines">{{ trackTitle }}</span>
                <ScrollingText v-else :text="trackTitle" />
              </h1>
              <p class="mini-artist" :title="trackArtist"><ScrollingText :text="trackArtist" /></p>
            </div>
            <button
              v-if="showsFavorite"
              type="button"
              class="mini-icon-button favorite-button"
              :class="{ 'is-active': state.favoriteLiked }"
              :title="state.favoriteLiked ? '取消收藏' : '收藏'"
              :aria-label="state.favoriteLiked ? '取消收藏' : '收藏'"
              :aria-pressed="state.favoriteLiked"
              :disabled="state.favoriteLoading"
              @click="toggleFavorite"
            >
              <ThemeIcon
                :icon-slot="state.favoriteLiked ? 'playback.favoriteActive' : 'playback.favorite'"
                ><i :class="state.favoriteLiked ? 'ph-fill ph-heart' : 'ph ph-heart'"></i
              ></ThemeIcon>
            </button>
          </div>
        </Transition>
      </div>

      <div
        class="mini-progress"
        :inert="customizerLayout"
        :class="{ 'without-time': !resolvedVisibility.time, 'is-disabled': !hasTrack }"
        :style="progressStyle"
      >
        <span v-if="resolvedVisibility.time" class="mini-time elapsed">{{ elapsedText }}</span>
        <div class="mini-progress-rail">
          <div class="mini-progress-track" aria-hidden="true">
            <div class="mini-progress-fill"></div>
          </div>
          <span class="mini-progress-thumb" aria-hidden="true"></span>
          <input
            type="range"
            class="mini-range mini-progress-range"
            min="0"
            :max="state.duration || 1"
            step="0.1"
            :value="playbackTime"
            aria-label="播放进度"
            :aria-valuetext="`${elapsedText} / ${formatTime(state.duration)}`"
            :disabled="!hasTrack"
            @input="onProgressInput"
          />
        </div>
        <button
          v-if="resolvedVisibility.time"
          type="button"
          class="mini-time trailing"
          :title="showRemaining ? '显示总时长' : '显示剩余时间'"
          :aria-label="showRemaining ? '显示总时长' : '显示剩余时间'"
          @click="toggleRemainingTime"
        >
          {{ trailingTimeText }}
        </button>
      </div>

      <footer class="mini-controls" :inert="customizerLayout">
        <div v-if="!isCompact" class="mini-controls-side left">
          <button
            v-if="resolvedVisibility.playMode"
            type="button"
            class="mini-icon-button mode-button"
            :class="{ 'is-active': state.playMode !== 'sequential' }"
            :title="playModeTitle"
            :aria-label="`播放模式：${playModeTitle}`"
            :disabled="!hasTrack"
            @click="sendCommand({ type: 'cycle-play-mode' })"
          >
            <PlaybackModeIcon :mode="state.playMode" variant="font" />
          </button>
        </div>

        <div class="mini-transport">
          <button
            type="button"
            class="mini-transport-button"
            title="上一首"
            aria-label="上一首"
            :disabled="!hasTrack"
            @click="sendCommand({ type: 'previous' })"
          >
            <MiniGlyph name="previous" />
          </button>
          <button
            type="button"
            class="mini-play-button"
            :class="{ 'is-playing': state.isPlaying }"
            :title="state.isPlaying ? '暂停' : '播放'"
            :aria-label="state.isPlaying ? '暂停' : '播放'"
            :disabled="!hasTrack || state.isLoading"
            @click="togglePlay"
          >
            <i v-if="state.isLoading" class="pi pi-spin pi-spinner"></i>
            <MiniGlyph v-else :name="state.isPlaying ? 'pause' : 'play'" />
          </button>
          <button
            type="button"
            class="mini-transport-button"
            title="下一首"
            aria-label="下一首"
            :disabled="!hasTrack"
            @click="sendCommand({ type: 'next' })"
          >
            <MiniGlyph name="next" />
          </button>
        </div>

        <div v-if="!isCompact" class="mini-controls-side right">
          <div
            v-if="resolvedVisibility.volume"
            class="mini-volume"
            :class="{ 'has-slider': showsInlineVolume }"
          >
            <input
              v-if="showsInlineVolume"
              type="range"
              class="mini-range mini-volume-range"
              min="0"
              max="1"
              step="0.01"
              :value="state.volume"
              aria-label="音量"
              @input="onVolumeInput"
            />
            <button
              type="button"
              class="mini-icon-button volume-button"
              :title="`音量 ${volumePercent}%（滚轮调节）`"
              :aria-label="state.volume > 0.001 ? '静音' : '取消静音'"
              @click="toggleMute()"
            >
              <ThemeIcon :icon-slot="state.volume <= 0.001 ? 'playback.muted' : 'playback.volume'"
                ><i :class="volumeIcon"></i
              ></ThemeIcon>
            </button>
          </div>
        </div>
      </footer>

      <nav class="mini-tools" aria-label="窗口">
        <button
          type="button"
          class="mini-tool-button tool-customize"
          :class="{ 'is-active': customizerOpen }"
          title="自定义外观"
          aria-label="自定义外观"
          @click="openCustomizer"
        >
          <i class="ph ph-sliders-horizontal"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button"
          :title="`切换形态：${nextFormLabel}`"
          :aria-label="`切换到${nextFormLabel}形态`"
          @click="cycleForm"
        >
          <i class="ph ph-layout"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button"
          :class="{ 'is-active': settings.alwaysOnTop }"
          :title="settings.alwaysOnTop ? '取消置顶' : '窗口置顶'"
          :aria-pressed="settings.alwaysOnTop"
          @click="toggleAlwaysOnTop"
        >
          <i :class="settings.alwaysOnTop ? 'ph-fill ph-push-pin' : 'ph ph-push-pin'"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button tool-lock"
          :class="{ 'is-active': settings.positionLocked }"
          :title="settings.positionLocked ? '解锁位置' : '锁定位置'"
          :aria-pressed="settings.positionLocked"
          @click="togglePositionLock"
        >
          <i :class="settings.positionLocked ? 'ph ph-lock-simple' : 'ph ph-lock-simple-open'"></i>
        </button>
        <span class="mini-tools-divider" aria-hidden="true"></span>
        <button
          type="button"
          class="mini-tool-button"
          title="最小化"
          aria-label="最小化"
          @click="minimizeWindow"
        >
          <i class="ph ph-minus"></i>
        </button>
        <button
          type="button"
          class="mini-tool-button"
          data-te-back-button="icon"
          title="返回完整播放器"
          aria-label="返回完整播放器"
          @click="returnToMainWindow"
        >
          <i class="ph ph-arrows-out-simple"></i>
        </button>
      </nav>

      <Transition name="mini-hud">
        <div v-if="volumeHudVisible" class="mini-volume-hud" role="status" aria-live="polite">
          <i :class="volumeIcon" aria-hidden="true"></i>
          <span class="mini-volume-hud-track" :style="{ '--mini-hud-level': state.volume }">
            <span></span>
          </span>
          <span class="mini-volume-hud-value">{{ volumePercent }}</span>
        </div>
      </Transition>

      <Transition name="mini-customizer-panel" @after-leave="finishCustomizerLeave">
        <MiniPlayerCustomizer
          v-if="customizerOpen"
          :settings="settings"
          mode="overlay"
          :saving="customization.saving.value"
          :error="customization.error.value"
          :pick-background-image="pickBackgroundImage"
          @update:settings="customization.replaceSettings"
          @undo="closeCustomizer('undo')"
          @reset="customization.resetActiveTheme"
          @flush="customization.flush"
          @close="closeCustomizer"
        />
      </Transition>
    </section>
  </main>
</template>

<style src="./MiniPlayer.css"></style>
