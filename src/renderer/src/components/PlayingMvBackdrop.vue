<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MediaProviderMvStream } from '../../../shared/providerMv.ts'
import type { PlaybackClockSnapshot } from '../utils/playbackSessionClock.ts'
import type { PlayingMvDisplayMode } from '../composables/usePlayingMv.ts'

const props = defineProps<{
  active: boolean
  mvEnabled: boolean
  displayMode: PlayingMvDisplayMode
  chromeRevealed?: boolean
  stream: MediaProviderMvStream | null
  playing: boolean
  originalAudio: boolean
  volume: number
  muted: boolean
  playbackRate: number
  clockSnapshot: PlaybackClockSnapshot
  estimatePosition: (at?: number) => number
  offsetSeconds: number
  trackTitle: string
  trackArtist: string
  qualityBadge: string
  sourceBadge?: string
  activeLyricText: string
  activeLyricTranslation: string
}>()

const emit = defineEmits<{
  ready: []
  streamError: []
  exitCinema: []
}>()

const videoEl = ref<HTMLVideoElement | null>(null)
const companionAudioEl = ref<HTMLVideoElement | null>(null)
const videoReady = ref(false)
const documentHidden = ref(typeof document !== 'undefined' ? document.hidden : false)

let syncTimer: ReturnType<typeof setInterval> | null = null

const shouldLoadMedia = computed(() =>
  Boolean(props.active && props.mvEnabled && props.stream?.url)
)

const effectiveVideoSrc = computed(() => (shouldLoadMedia.value ? (props.stream?.url ?? '') : ''))

const usesSeparateAudioTrack = computed(() =>
  Boolean(shouldLoadMedia.value && props.originalAudio && props.stream?.audioUrl)
)

const effectiveAudioSrc = computed(() =>
  usesSeparateAudioTrack.value ? (props.stream?.audioUrl ?? '') : ''
)

const shouldRunPlayback = computed(
  () =>
    shouldLoadMedia.value &&
    videoReady.value &&
    props.playing &&
    (!documentHidden.value || props.originalAudio)
)

const isVisible = computed(
  () =>
    shouldLoadMedia.value &&
    videoReady.value &&
    (!documentHidden.value || props.originalAudio)
)

const isCinemaMode = computed(() => isVisible.value && props.displayMode === 'cinema')

function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1
  return Math.min(4, Math.max(0.25, rate))
}

function clampVolume(vol: number): number {
  if (!Number.isFinite(vol)) return 1
  return Math.min(1, Math.max(0, vol))
}

function computeTargetTime(mediaDuration: number): { target: number; pastEnd: boolean } {
  const raw = Math.max(0, props.estimatePosition() + props.offsetSeconds)
  if (Number.isFinite(mediaDuration) && mediaDuration > 0.25) {
    if (raw >= mediaDuration - 0.08) {
      return { target: Math.max(0, mediaDuration - 0.1), pastEnd: true }
    }
    return { target: raw, pastEnd: false }
  }
  return { target: raw, pastEnd: false }
}

function applyAudioRouting(): void {
  const video = videoEl.value
  const audio = companionAudioEl.value
  const audibleVolume = props.muted ? 0 : clampVolume(props.volume)
  if (video) {
    if (props.originalAudio && !usesSeparateAudioTrack.value) {
      video.muted = props.muted || audibleVolume === 0
      video.volume = audibleVolume
    } else {
      video.muted = true
      video.volume = 0
    }
  }
  if (audio) {
    if (usesSeparateAudioTrack.value) {
      audio.muted = props.muted || audibleVolume === 0
      audio.volume = audibleVolume
    } else {
      audio.muted = true
      audio.volume = 0
      if (!audio.paused) audio.pause()
    }
  }
}

function syncMediaPlayback(forceSeek = false): void {
  const video = videoEl.value
  if (!video || !shouldLoadMedia.value) return

  applyAudioRouting()
  const baseRate = clampRate(props.playbackRate)
  const { target, pastEnd } = computeTargetTime(video.duration)
  const audio = usesSeparateAudioTrack.value ? companionAudioEl.value : null

  if (pastEnd) {
    if (!video.paused) video.pause()
    if (audio && !audio.paused) audio.pause()
    if (Math.abs(video.currentTime - target) > 0.25) {
      try {
        video.currentTime = target
      } catch {
        // Ignore seek before readyState
      }
    }
    return
  }

  if (props.originalAudio) {
    // When MV original soundtrack is audible, avoid rate micro-warble on the audio source.
    if (audio && audio.readyState >= 1) {
      const audioDrift = target - audio.currentTime
      if (forceSeek || Math.abs(audioDrift) > 1.35) {
        try {
          audio.currentTime = target
        } catch {
          // Ignore seek errors on unbuffered range
        }
      }
      if (Math.abs(audio.playbackRate - baseRate) > 0.005) {
        audio.playbackRate = baseRate
      }
      const avDrift = audio.currentTime - video.currentTime
      if (forceSeek || Math.abs(avDrift) > 0.45) {
        try {
          video.currentTime = audio.currentTime
        } catch {
          // Ignore seek errors
        }
        video.playbackRate = baseRate
      } else if (shouldRunPlayback.value && Math.abs(avDrift) > 0.08) {
        const nudged = Math.min(
          baseRate * 1.06,
          Math.max(baseRate * 0.94, baseRate + avDrift * 0.22)
        )
        video.playbackRate = Math.round(nudged * 1000) / 1000
      } else if (Math.abs(video.playbackRate - baseRate) > 0.005) {
        video.playbackRate = baseRate
      }
    } else {
      const drift = target - video.currentTime
      if (forceSeek || Math.abs(drift) > 1.35) {
        try {
          video.currentTime = target
        } catch {
          // Ignore seek errors
        }
      }
      if (Math.abs(video.playbackRate - baseRate) > 0.005) {
        video.playbackRate = baseRate
      }
    }
  } else {
    // Muted background MV: tightly follow the Hi-Fi presentation clock with gentle rate catch-up.
    const drift = target - video.currentTime
    if (forceSeek || Math.abs(drift) > 0.45) {
      try {
        video.currentTime = target
      } catch {
        // Ignore seek errors
      }
      video.playbackRate = baseRate
    } else if (shouldRunPlayback.value && Math.abs(drift) > 0.09) {
      const nudged = Math.min(baseRate * 1.08, Math.max(baseRate * 0.92, baseRate + drift * 0.25))
      video.playbackRate = Math.round(nudged * 1000) / 1000
    } else if (Math.abs(video.playbackRate - baseRate) > 0.005) {
      video.playbackRate = baseRate
    }
  }

  if (shouldRunPlayback.value) {
    if (video.paused && video.readyState >= 2) {
      void video.play().catch(() => undefined)
    }
    if (audio && audio.paused && audio.readyState >= 2) {
      void audio.play().catch(() => undefined)
    }
  } else {
    if (!video.paused) video.pause()
    if (audio && !audio.paused) audio.pause()
  }
}

function updateSyncTimer(): void {
  if (shouldRunPlayback.value) {
    if (syncTimer === null) {
      syncTimer = setInterval(() => {
        syncMediaPlayback(false)
      }, 600)
    }
  } else if (syncTimer !== null) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

function releaseMediaElements(): void {
  if (syncTimer !== null) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  const video = videoEl.value
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  const audio = companionAudioEl.value
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
}

function onVideoLoadedMetadata(): void {
  const video = videoEl.value
  if (!video || !shouldLoadMedia.value) return
  applyAudioRouting()
  const { target } = computeTargetTime(video.duration)
  if (target > 0.05) {
    try {
      video.currentTime = target
    } catch {
      // Ignore pre-buffer seek error
    }
  }
}

function onVideoReady(): void {
  if (!shouldLoadMedia.value) return
  if (!videoReady.value) {
    videoReady.value = true
    emit('ready')
  }
  syncMediaPlayback(false)
  updateSyncTimer()
}

function onAudioLoadedMetadata(): void {
  const audio = companionAudioEl.value
  if (!audio || !usesSeparateAudioTrack.value) return
  applyAudioRouting()
  const { target } = computeTargetTime(audio.duration)
  try {
    audio.currentTime = target
  } catch {
    // Ignore pre-buffer seek error
  }
  if (shouldRunPlayback.value) {
    void audio.play().catch(() => undefined)
  }
}

function onMediaError(): void {
  if (!shouldLoadMedia.value) return
  videoReady.value = false
  updateSyncTimer()
  emit('streamError')
}

function onVisibilityChange(): void {
  documentHidden.value = document.hidden
  if (!documentHidden.value && videoReady.value) {
    syncMediaPlayback(true)
  } else {
    syncMediaPlayback(false)
  }
  updateSyncTimer()
}

watch(effectiveVideoSrc, (src, prevSrc) => {
  if (src === prevSrc) return
  videoReady.value = false
  updateSyncTimer()
  if (!src) {
    void nextTick(() => releaseMediaElements())
  }
})

watch(effectiveAudioSrc, (src, prevSrc) => {
  if (src === prevSrc) return
  if (!src && companionAudioEl.value) {
    companionAudioEl.value.pause()
    companionAudioEl.value.removeAttribute('src')
    companionAudioEl.value.load()
  }
})

watch(
  [
    () => props.clockSnapshot,
    () => props.playing,
    () => props.originalAudio,
    () => props.offsetSeconds,
    () => props.playbackRate
  ],
  ([, , nextOriginal, nextOffset], [, , prevOriginal, prevOffset]) => {
    if (!videoReady.value) return
    const forceSeek = nextOriginal !== prevOriginal || nextOffset !== prevOffset
    syncMediaPlayback(forceSeek)
    updateSyncTimer()
  }
)

watch([() => props.volume, () => props.muted], () => {
  applyAudioRouting()
})

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  releaseMediaElements()
})
</script>

<template>
  <div
    class="playing-mv-backdrop"
    :class="{
      'playing-mv-backdrop--visible': isVisible,
      'playing-mv-backdrop--cinema': isCinemaMode
    }"
    :aria-hidden="!isCinemaMode"
  >
    <video
      v-if="effectiveVideoSrc"
      ref="videoEl"
      class="playing-mv-video"
      :src="effectiveVideoSrc"
      playsinline
      preload="auto"
      disablepictureinpicture
      @loadedmetadata="onVideoLoadedMetadata"
      @loadeddata="onVideoReady"
      @canplay="onVideoReady"
      @error="onMediaError"
    />
    <video
      v-if="effectiveAudioSrc"
      ref="companionAudioEl"
      class="playing-mv-audio"
      :src="effectiveAudioSrc"
      playsinline
      preload="auto"
      disablepictureinpicture
      @loadedmetadata="onAudioLoadedMetadata"
      @canplay="syncMediaPlayback(false)"
      @error="onMediaError"
    />
    <div class="playing-mv-scrim" aria-hidden="true" />

    <Transition name="mv-cinema-dock-fade">
      <div
        v-if="isCinemaMode"
        class="playing-mv-cinema-dock"
        :class="{ 'playing-mv-cinema-dock--chrome-revealed': chromeRevealed }"
      >
        <div v-if="activeLyricText" class="mv-cinema-lyric-card" aria-live="polite">
          <p class="mv-cinema-lyric-primary">{{ activeLyricText }}</p>
          <p v-if="activeLyricTranslation" class="mv-cinema-lyric-translation">
            {{ activeLyricTranslation }}
          </p>
        </div>
        <div v-else class="mv-cinema-spacer" aria-hidden="true" />

        <div class="mv-cinema-meta-pill">
          <div class="mv-cinema-meta-text">
            <span class="mv-cinema-title">{{ trackTitle }}</span>
            <span v-if="trackArtist" class="mv-cinema-divider" aria-hidden="true">·</span>
            <span v-if="trackArtist" class="mv-cinema-artist">{{ trackArtist }}</span>
          </div>
          <span v-if="sourceBadge" class="mv-cinema-quality">{{ sourceBadge }}</span>
          <span v-if="qualityBadge" class="mv-cinema-quality">{{ qualityBadge }}</span>
          <button
            type="button"
            class="mv-cinema-exit-btn"
            title="退出纯享画面，返回封面与歌词"
            @click.stop="emit('exitCinema')"
          >
            <i class="ph ph-corners-in" aria-hidden="true"></i>
            <span>返回歌词</span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.playing-mv-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity 480ms var(--te-ease-out-strong);
}

.playing-mv-backdrop--visible {
  opacity: 1;
}

.playing-mv-backdrop--cinema {
  z-index: 1;
  background-color: black;
}

.playing-mv-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  opacity: 0.24;
  filter: none;
  transition: opacity 420ms var(--te-ease-out-strong);
  will-change: opacity;
}

.playing-mv-backdrop--cinema .playing-mv-video {
  object-fit: contain;
  opacity: 1;
}

.playing-mv-audio {
  display: none;
}

.playing-mv-scrim {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: color-mix(in srgb, black 16%, transparent);
  transition: background-color 420ms var(--te-ease-out-strong);
}

:global(html[data-te-player-text-tone='dark'] .playing-mv-backdrop:not(.playing-mv-backdrop--cinema) .playing-mv-scrim) {
  background: color-mix(in srgb, white 16%, transparent);
}

.playing-mv-backdrop--cinema .playing-mv-scrim {
  opacity: 0;
}

.playing-mv-cinema-dock {
  position: absolute;
  left: 42px;
  right: 42px;
  bottom: 28px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  pointer-events: none;
  transition: bottom 240ms var(--te-ease-out-strong);
}

.playing-mv-cinema-dock--chrome-revealed {
  bottom: max(112px, min(144px, calc(var(--te-playbar-bottom-clearance, 96px) + 20px)));
}

.mv-cinema-spacer {
  flex: 1;
}

.mv-cinema-lyric-card {
  max-width: min(680px, 64vw);
  padding: 14px 20px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, white 14%, transparent);
  background: color-mix(in srgb, black 54%, transparent);
  backdrop-filter: blur(18px) saturate(130%);
  -webkit-backdrop-filter: blur(18px) saturate(130%);
  pointer-events: auto;
}

.mv-cinema-lyric-primary {
  margin: 0;
  color: white;
  font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
  font-weight: 650;
  line-height: 1.38;
  letter-spacing: -0.01em;
}

.mv-cinema-lyric-translation {
  margin: 4px 0 0;
  color: color-mix(in srgb, white 74%, transparent);
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 450;
  line-height: 1.36;
}

.mv-cinema-meta-pill {
  flex-shrink: 0;
  max-width: min(520px, 90vw);
  min-height: 42px;
  padding: 6px 8px 6px 16px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, white 14%, transparent);
  background: color-mix(in srgb, black 54%, transparent);
  backdrop-filter: blur(18px) saturate(130%);
  -webkit-backdrop-filter: blur(18px) saturate(130%);
  color: color-mix(in srgb, white 90%, transparent);
  display: inline-flex;
  align-items: center;
  gap: 10px;
  opacity: 0;
  visibility: hidden;
  transform: translate3d(0, 10px, 0);
  pointer-events: none;
  transition:
    opacity 220ms var(--te-ease-out-strong),
    transform 220ms var(--te-ease-out-strong),
    visibility 0s 220ms;
}

.playing-mv-cinema-dock--chrome-revealed .mv-cinema-meta-pill {
  opacity: 1;
  visibility: visible;
  transform: translate3d(0, 0, 0);
  pointer-events: auto;
  transition:
    opacity 220ms var(--te-ease-out-strong),
    transform 220ms var(--te-ease-out-strong),
    visibility 0s;
}

.mv-cinema-meta-text {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
}

.mv-cinema-title {
  font-weight: 600;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.mv-cinema-divider {
  color: color-mix(in srgb, white 48%, transparent);
  flex-shrink: 0;
}

.mv-cinema-artist {
  color: color-mix(in srgb, white 72%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}

.mv-cinema-quality {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, white 18%, transparent);
  background: color-mix(in srgb, white 10%, transparent);
  color: color-mix(in srgb, white 86%, transparent);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.mv-cinema-exit-btn {
  flex-shrink: 0;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, white 18%, transparent);
  background: color-mix(in srgb, white 12%, transparent);
  color: white;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 550;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition:
    background-color var(--te-motion-hover) ease,
    border-color var(--te-motion-hover) ease;
}

.mv-cinema-exit-btn:hover {
  background: color-mix(in srgb, white 22%, transparent);
  border-color: color-mix(in srgb, white 28%, transparent);
}

.mv-cinema-exit-btn:focus-visible {
  outline: 2px solid white;
  outline-offset: 2px;
}

.mv-cinema-dock-fade-enter-active,
.mv-cinema-dock-fade-leave-active {
  transition:
    opacity 260ms var(--te-ease-out-strong),
    transform 260ms var(--te-ease-out-strong);
}

.mv-cinema-dock-fade-enter-from,
.mv-cinema-dock-fade-leave-to {
  opacity: 0;
  transform: translate3d(0, 10px, 0);
}

:global(html[data-te-motion='reduced'] .playing-mv-backdrop),
:global(html[data-te-motion='reduced'] .playing-mv-video),
:global(html[data-te-motion='reduced'] .playing-mv-scrim),
:global(html[data-te-motion='reduced'] .playing-mv-cinema-dock),
:global(html[data-te-motion='reduced'] .mv-cinema-meta-pill),
:global(html[data-te-motion='reduced'] .mv-cinema-dock-fade-enter-active),
:global(html[data-te-motion='reduced'] .mv-cinema-dock-fade-leave-active) {
  transition-duration: 120ms !important;
}

:global(html[data-te-motion='reduced'] .mv-cinema-meta-pill),
:global(html[data-te-motion='reduced'] .mv-cinema-dock-fade-enter-from),
:global(html[data-te-motion='reduced'] .mv-cinema-dock-fade-leave-to) {
  transform: none;
}

:global(html[data-te-motion='off'] .playing-mv-backdrop),
:global(html[data-te-motion='off'] .playing-mv-video),
:global(html[data-te-motion='off'] .playing-mv-scrim),
:global(html[data-te-motion='off'] .playing-mv-cinema-dock),
:global(html[data-te-motion='off'] .mv-cinema-meta-pill),
:global(html[data-te-motion='off'] .mv-cinema-dock-fade-enter-active),
:global(html[data-te-motion='off'] .mv-cinema-dock-fade-leave-active) {
  transition: none !important;
}

@media (max-width: 860px) {
  .playing-mv-cinema-dock {
    left: 16px;
    right: 16px;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .mv-cinema-lyric-card {
    max-width: 100%;
  }
}
</style>
