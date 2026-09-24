<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  EMPTY_MINI_PLAYER_STATE,
  type MiniPlayerCommand,
  type MiniPlayerStateSnapshot
} from '../../../shared/miniPlayer.ts'
import {
  DEFAULT_DYNAMIC_ISLAND_CONFIG,
  cloneDynamicIslandConfig,
  resolveDynamicIslandLayout,
  type DynamicIslandPresentation
} from '../../../shared/dynamicIsland.ts'
import { useCover } from '../utils/coverLoader'
import {
  createIslandStyle,
  islandCollapseCommitDelayMs,
  resolveIslandAccent
} from './islandPresentation.ts'
import { VISUALIZER_BAR_COUNT, useIslandVisualizer } from './useIslandVisualizer.ts'

const defaultConfig = cloneDynamicIslandConfig(DEFAULT_DYNAMIC_ISLAND_CONFIG)
const state = ref<MiniPlayerStateSnapshot>({ ...EMPTY_MINI_PLAYER_STATE })
const presentation = ref<DynamicIslandPresentation>({
  config: defaultConfig,
  layout: resolveDynamicIslandLayout(defaultConfig)
})
const expanded = ref(false)
const volumeOpen = ref(false)
const muted = ref(state.value.volume <= 0)
const lastVolume = ref(state.value.volume > 0 ? state.value.volume : 0.72)
const coverFailed = ref(false)
const ready = ref(false)
const islandSurface = ref<HTMLElement | null>(null)
let collapseTimer: number | null = null
let collapseCommitTimer: number | null = null
let collapseCommitPending = false
let removeListeners: Array<() => void> = []

const config = computed(() => presentation.value.config)
const components = computed(() => config.value.components)
const visualizer = useIslandVisualizer(
  computed(() => components.value.visualizer),
  (options) => window.api.dynamicIsland.getVisualizationData(options)
)

const islandStyle = computed<Record<string, string>>(() => ({
  ...createIslandStyle(
    config.value,
    presentation.value.layout,
    resolveIslandAccent(config.value, state.value.dominantColor, state.value.track !== null)
  ),
  '--visualizer-energy': config.value.appearance.audioReactive
    ? visualizer.energy.value.toFixed(3)
    : '0'
}))

const coverSrc = useCover(
  computed(() => state.value.track?.cover),
  computed(() => state.value.track?.coverSource)
)
const hasCover = computed(() => Boolean(coverSrc.value) && !coverFailed.value)
const title = computed(() => state.value.track?.title || '暂无播放')
const artist = computed(() => state.value.track?.artist || 'Twilight Echo')
const lyric = computed(() => state.value.currentLyric?.original?.trim() ?? '')
const hasTimedLyric = computed(
  () => lyric.value.length > 0 && state.value.lyrics.some((line) => typeof line.time === 'number')
)
const showExpandedLyric = computed(() => components.value.lyric && hasTimedLyric.value)
const collapsedPrimary = computed(() =>
  components.value.collapsedContent === 'lyric' && hasTimedLyric.value ? lyric.value : title.value
)
const trackLine = computed(() => `${artist.value}/${title.value}`)
const remaining = computed(() => Math.max(0, state.value.duration - state.value.currentTime))
const progress = computed(() => {
  if (!state.value.duration || state.value.duration <= 0) return 0
  return Math.min(100, Math.max(0, (state.value.currentTime / state.value.duration) * 100))
})
const isMuted = computed(() => muted.value || state.value.volume <= 0)
const volumePercent = computed(() => Math.round((muted.value ? 0 : state.value.volume) * 100))
const playerState = computed(() => {
  if (state.value.isPlaying) return 'playing'
  if (state.value.isLoading) return 'loading'
  return state.value.track ? 'ready' : 'idle'
})
const statusText = computed(() => {
  if (state.value.isLoading) return '正在加载'
  if (!state.value.track) return '暂无歌曲'
  return state.value.isPlaying ? '正在播放' : '已暂停'
})
const playLabel = computed(() => (state.value.isPlaying ? '暂停' : '播放'))

function send(command: MiniPlayerCommand): void {
  window.api.dynamicIsland.command(command)
}

function togglePlay(): void {
  if (!state.value.track || state.value.isLoading) return
  send({ type: 'toggle-play' })
}

function seek(value: number): void {
  const next = Math.min(state.value.duration || value, Math.max(0, value))
  state.value = { ...state.value, currentTime: next }
  send({ type: 'seek', value: next })
}

function onSeek(event: Event): void {
  seek(Number((event.target as HTMLInputElement).value))
}

function setVolume(value: number): void {
  const next = Math.min(1, Math.max(0, value))
  state.value = { ...state.value, volume: next }
  send({ type: 'set-volume', value: next })
}

function onVolume(event: Event): void {
  muted.value = false
  setVolume(Number((event.target as HTMLInputElement).value))
}

function toggleMute(): void {
  if (isMuted.value) {
    muted.value = false
    setVolume(lastVolume.value > 0 ? lastVolume.value : 0.72)
    return
  }
  lastVolume.value = state.value.volume
  muted.value = true
  setVolume(0)
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  return `${Math.floor(value / 60)}:${Math.floor(value % 60)
    .toString()
    .padStart(2, '0')}`
}

function syncWindowExpansion(next: boolean): void {
  void window.api.dynamicIsland.setExpanded(next).catch((error) => {
    console.error('[dynamic-island] failed to resize window:', error)
  })
}

function clearCollapseTimer(): void {
  if (collapseTimer === null) return
  window.clearTimeout(collapseTimer)
  collapseTimer = null
}

function clearCollapseCommit(): void {
  collapseCommitPending = false
  if (collapseCommitTimer !== null) {
    window.clearTimeout(collapseCommitTimer)
    collapseCommitTimer = null
  }
}

function commitCollapsedWindow(): void {
  if (!collapseCommitPending || expanded.value) return
  clearCollapseCommit()
  syncWindowExpansion(false)
}

function waitForCollapseTransition(): void {
  clearCollapseCommit()
  collapseCommitPending = true
  // Reduced motion (or motion "off") suppresses transitionend; keep a non-visual fallback.
  collapseCommitTimer = window.setTimeout(
    commitCollapsedWindow,
    islandCollapseCommitDelayMs(config.value)
  )
}

function setExpanded(next: boolean): void {
  clearCollapseTimer()
  if (expanded.value === next) return
  expanded.value = next
  if (next) {
    clearCollapseCommit()
    syncWindowExpansion(true)
    return
  }
  volumeOpen.value = false
  waitForCollapseTransition()
}

function handleIslandTransitionEnd(event: TransitionEvent): void {
  if (
    event.target !== islandSurface.value ||
    expanded.value ||
    (event.propertyName !== 'clip-path' && event.propertyName !== '-webkit-clip-path')
  ) {
    return
  }
  commitCollapsedWindow()
}

function handlePointerEnter(): void {
  if (config.value.behavior.expandTrigger === 'hover') setExpanded(true)
  else clearCollapseTimer()
}

function scheduleCollapse(): void {
  clearCollapseTimer()
  collapseTimer = window.setTimeout(() => {
    collapseTimer = null
    setExpanded(false)
  }, config.value.behavior.collapseDelayMs)
}

function toggleSummary(): void {
  setExpanded(!expanded.value)
}

function toggleVolumeMenu(): void {
  volumeOpen.value = !volumeOpen.value
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  if (volumeOpen.value) {
    volumeOpen.value = false
    return
  }
  setExpanded(false)
}

onMounted(async () => {
  const api = window.api.dynamicIsland
  removeListeners = [
    api.onState((nextState) => {
      state.value = nextState
    }),
    api.onExpanded((nextExpanded) => {
      if (nextExpanded) clearCollapseCommit()
      expanded.value = nextExpanded
    }),
    api.onConfig((nextPresentation) => {
      presentation.value = nextPresentation
    })
  ]
  window.addEventListener('keydown', handleKeydown)
  try {
    const bootstrap = await api.getBootstrap()
    state.value = bootstrap.state
    expanded.value = bootstrap.expanded
    presentation.value = { config: bootstrap.config, layout: bootstrap.layout }
  } catch (error) {
    console.error('[dynamic-island] failed to load bootstrap:', error)
  } finally {
    ready.value = true
  }
})

watch(
  () => state.value.volume,
  (value) => {
    if (value > 0) {
      lastVolume.value = value
      muted.value = false
    } else {
      muted.value = true
    }
  }
)

watch(coverSrc, () => {
  coverFailed.value = false
})

onBeforeUnmount(() => {
  clearCollapseTimer()
  clearCollapseCommit()
  for (const remove of removeListeners) remove()
  removeListeners = []
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <main
    class="dynamic-island-root music-island"
    :class="{ 'is-ready': ready, 'is-playing': state.isPlaying }"
    :data-open="expanded"
    :data-player-state="playerState"
    :data-volume-open="volumeOpen"
    :data-muted="isMuted"
    :data-collapsed-content="components.collapsedContent"
    :style="islandStyle"
  >
    <div
      ref="islandSurface"
      class="island-surface"
      @pointerenter="handlePointerEnter"
      @pointermove="handlePointerEnter"
      @pointerleave="scheduleCollapse"
      @transitionend="handleIslandTransitionEnd"
    >
      <button
        class="island-summary"
        type="button"
        :aria-expanded="expanded"
        aria-controls="dynamic-island-panel"
        aria-label="展开灵动岛"
        @click.stop="toggleSummary"
      >
        <template v-if="components.cover">
          <img
            v-if="hasCover && coverSrc"
            class="island-mini-art"
            :src="coverSrc"
            alt=""
            @error="coverFailed = true"
          />
          <span v-else class="island-mini-art island-art-fallback" aria-hidden="true">♪</span>
        </template>
        <span v-if="components.collapsedContent !== 'artwork'" class="island-summary-copy">
          <span class="island-track-title">{{ collapsedPrimary }}</span>
          <span class="island-track-artist">{{ artist }}</span>
        </span>
        <span
          v-if="components.visualizer"
          class="island-mini-wave"
          data-audio-visualizer="compact"
          aria-hidden="true"
        >
          <i
            v-for="index in VISUALIZER_BAR_COUNT"
            :key="index"
            :style="visualizer.barStyle(index - 1)"
          />
        </span>
      </button>

      <section
        id="dynamic-island-panel"
        class="island-panel island-player-panel"
        aria-label="灵动岛播放器"
      >
        <div class="island-player-heading">
          <span v-if="components.cover" class="island-player-art-shell" aria-hidden="true">
            <img
              v-if="hasCover && coverSrc"
              class="island-player-art"
              :src="coverSrc"
              alt=""
              width="96"
              height="96"
              @error="coverFailed = true"
            />
            <span v-else class="island-player-art island-art-fallback">♪</span>
          </span>
          <div class="island-player-copy" :class="{ 'has-lyric': showExpandedLyric }">
            <p v-if="showExpandedLyric" class="island-player-lyric">{{ lyric }}</p>
            <span>{{ trackLine }}</span>
            <span class="island-player-status" role="status" aria-live="polite">{{
              statusText
            }}</span>
          </div>
          <span
            v-if="components.visualizer"
            class="island-expanded-wave"
            data-audio-visualizer="expanded"
            aria-hidden="true"
          >
            <i
              v-for="index in VISUALIZER_BAR_COUNT"
              :key="index"
              :style="visualizer.barStyle(index - 1)"
            />
          </span>
        </div>

        <div v-if="components.progress" class="island-player-timeline">
          <input
            type="range"
            min="0"
            :max="Math.max(0, state.duration)"
            step="0.1"
            :value="state.currentTime"
            :style="{ '--player-progress': `${progress}%` }"
            aria-label="播放进度"
            :disabled="!state.track || state.duration <= 0"
            @input="onSeek"
          />
          <div v-if="components.time">
            <span>{{ formatTime(state.currentTime) }}</span>
            <span>−{{ formatTime(remaining) }}</span>
          </div>
        </div>

        <div class="island-player-actions">
          <button
            v-if="components.favorite"
            class="island-player-favorite"
            type="button"
            aria-label="收藏"
            :class="{ active: state.favoriteLiked }"
            :disabled="!state.favoriteAvailable || state.favoriteLoading"
            @click.stop="send({ type: 'toggle-favorite' })"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="m12 2.8 2.75 5.57 6.15.9-4.45 4.34 1.05 6.13L12 16.84l-5.5 2.9 1.05-6.13L3.1 9.27l6.15-.9L12 2.8Z"
              />
            </svg>
          </button>
          <button
            v-if="components.skip"
            class="island-player-skip island-player-skip--previous"
            type="button"
            aria-label="上一首"
            @click.stop="send({ type: 'previous' })"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h2v14H5Zm13 0L8 12l10 7V5Z" />
            </svg>
          </button>
          <button
            class="island-player-toggle"
            type="button"
            :aria-label="playLabel"
            @click.stop="togglePlay"
          >
            <svg class="player-icon player-icon--play" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m8 5 11 7-11 7z" />
            </svg>
            <svg class="player-icon player-icon--pause" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 3h6v18H4zm10 0h6v18h-6z" />
            </svg>
          </button>
          <button
            v-if="components.skip"
            class="island-player-skip island-player-skip--next"
            type="button"
            aria-label="下一首"
            @click.stop="send({ type: 'next' })"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17 5h2v14h-2ZM7 5l10 7-10 7V5Z" />
            </svg>
          </button>
          <div v-if="components.volume" class="island-volume-control">
            <button
              class="island-volume-button"
              type="button"
              :aria-label="`调整音量，当前 ${volumePercent}%`"
              aria-controls="dynamic-island-volume-menu"
              :aria-expanded="volumeOpen"
              @click.stop="toggleVolumeMenu"
            >
              <svg
                class="volume-icon volume-icon--on island-output-icon"
                viewBox="0 0 32 32"
                aria-hidden="true"
              >
                <path d="m16 20-6.5 9h13L16 20Z" />
                <path
                  d="M11.6 19.2a6 6 0 1 1 8.8 0M8.5 22.2a10 10 0 1 1 15 0M5.5 25.2a14 14 0 1 1 21 0"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
              <svg
                class="volume-icon volume-icon--muted island-output-icon"
                viewBox="0 0 32 32"
                aria-hidden="true"
              >
                <path d="m16 20-6.5 9h13L16 20Z" />
                <path
                  d="M11.6 19.2a6 6 0 1 1 8.8 0M8.5 22.2a10 10 0 1 1 15 0M5.5 25.2a14 14 0 1 1 21 0M6 6l20 20"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
            <div
              id="dynamic-island-volume-menu"
              class="island-volume-menu"
              role="group"
              aria-label="音量控制"
              @click.stop
            >
              <button
                class="island-volume-mute"
                type="button"
                :aria-label="isMuted ? '取消静音' : '静音'"
                @click.stop="toggleMute"
              >
                <svg v-if="!isMuted" class="volume-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4z" />
                  <path
                    d="M16 8.5a5 5 0 0 1 0 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                </svg>
                <svg v-else class="volume-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4z" />
                  <path
                    d="m17 9 4 4m0-4-4 4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <input
                id="dynamic-island-volume-slider"
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="state.volume"
                :style="{ '--volume-progress': `${volumePercent}%` }"
                aria-label="播放器音量"
                @input="onVolume"
              />
              <output for="dynamic-island-volume-slider">{{ volumePercent }}%</output>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>

<style src="./dynamicIsland.css"></style>
