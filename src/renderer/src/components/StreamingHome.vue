<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { useBoundedGrid } from '@renderer/composables/useBoundedGrid'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Track } from '../types/music'
import type { MediaProviderPlaylistSummary } from '../providers/mediaProvider'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useResolvedMotionMode } from '../app/useResolvedMotionMode'
import CoverImg from './CoverImg.vue'
import ProviderMusicHome from '@renderer/components/streaming-page/ProviderMusicHome.vue'
import type {
  ProviderHomePresentation,
  ProviderHomeSectionPresentation
} from '../../../shared/providerHome'

interface RecSection extends ProviderHomeSectionPresentation {
  key: string
  title: string
  tracks: Track[]
  icon: string
  error?: string
}

interface CollageCover {
  cover: string
  coverSource: string | null
}

const props = defineProps<{
  providerLabel: string
  providerColor?: string
  presentation?: ProviderHomePresentation
  supportsDiscovery?: boolean
  isLoggedIn: boolean
  recsLoading: boolean
  recsError: string
  recSections: RecSection[]
  recommendPlaylists: MediaProviderPlaylistSummary[]
  currentTrackId?: string | null
}>()

const emit = defineEmits<{
  loadRecommendations: []
  openRecSection: [section: RecSection]
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  playTrack: [track: Track, queue: Track[]]
  requestLogin: []
  openDiscovery: []
}>()
const { setGridElement: shelfGrid, gridStyle: shelfGridStyle } = useBoundedGrid(
  () => props.recommendPlaylists.length
)

// ─── Sections ───────────────────────────────────────────────────────────────

const dailySection = computed(
  () => props.recSections.find((section) => section.key === 'daily') ?? props.recSections[0] ?? null
)
const secondarySections = computed(() =>
  props.recSections.filter((section) => section !== dailySection.value).slice(0, 2)
)
const fmSection = computed(
  () =>
    props.recSections.find((section) => section.key === 'fm') ?? secondarySections.value[0] ?? null
)
const radarSection = computed(
  () =>
    props.recSections.find((section) => section.key === 'radar') ??
    secondarySections.value.find((section) => section !== fmSection.value) ??
    null
)
const heroTitle = computed(() => dailySection.value?.title ?? '为你推荐')
const isDailyHero = computed(() => dailySection.value?.key === 'daily')

const dateLabel = computed(() => {
  const now = new Date()
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${now.getMonth() + 1}月${now.getDate()}日 · ${weekdays[now.getDay()]}`
})

const dayNumber = computed(() => String(new Date().getDate()).padStart(2, '0'))

// ─── Hero cover collage (rotates through daily covers) ─────────────────────

const COLLAGE_SIZE = 3
const ROTATE_INTERVAL_MS = 7000

const dailyCovers = computed((): CollageCover[] => {
  const seen = new Set<string>()
  const covers: CollageCover[] = []
  for (const track of dailySection.value?.tracks ?? []) {
    if (!track.cover || seen.has(track.cover)) continue
    seen.add(track.cover)
    covers.push({ cover: track.cover, coverSource: track.coverSource ?? null })
  }
  return covers
})

const collagePage = ref(0)
const collagePageCount = computed(() =>
  Math.max(1, Math.ceil(dailyCovers.value.length / COLLAGE_SIZE))
)
const collageCovers = computed((): CollageCover[] => {
  const covers = dailyCovers.value
  if (covers.length === 0) return []
  const start = (collagePage.value % collagePageCount.value) * COLLAGE_SIZE
  const slice: CollageCover[] = []
  for (let i = 0; i < Math.min(COLLAGE_SIZE, covers.length); i++) {
    slice.push(covers[(start + i) % covers.length])
  }
  return slice
})

let rotateTimer: ReturnType<typeof setInterval> | null = null

const { settings } = useSettingsStore()
const motionMode = useResolvedMotionMode(computed(() => settings.value.motionPreference))
const heroStage = ref<HTMLElement | null>(null)
const collageHovered = ref(false)
const collageFocused = ref(false)
const collageVisible = ref(true)
const windowVisible = ref(!document.hidden)
const collageMotionAllowed = computed(
  () =>
    motionMode.value === 'full' &&
    windowVisible.value &&
    collageVisible.value &&
    !collageHovered.value &&
    !collageFocused.value
)
let collageObserver: IntersectionObserver | null = null

function syncWindowVisibility(): void {
  windowVisible.value = !document.hidden
}

function startCollageRotation(): void {
  stopCollageRotation()
  if (!collageMotionAllowed.value) return
  if (collagePageCount.value <= 1) return
  rotateTimer = setInterval(() => {
    if (!collageMotionAllowed.value) return
    collagePage.value = (collagePage.value + 1) % collagePageCount.value
  }, ROTATE_INTERVAL_MS)
}

function stopCollageRotation(): void {
  if (rotateTimer) {
    clearInterval(rotateTimer)
    rotateTimer = null
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', syncWindowVisibility)
  startCollageRotation()
})
onBeforeUnmount(() => {
  stopCollageRotation()
  collageObserver?.disconnect()
  document.removeEventListener('visibilitychange', syncWindowVisibility)
})

watch(
  heroStage,
  (element) => {
    collageObserver?.disconnect()
    collageVisible.value = false
    if (!element) return
    collageObserver = new IntersectionObserver(([entry]) => {
      collageVisible.value = entry.isIntersecting
    })
    collageObserver.observe(element)
  },
  { flush: 'post' }
)

watch(collagePageCount, (count) => {
  if (collagePage.value >= count) collagePage.value = 0
  startCollageRotation()
})

watch(collageMotionAllowed, startCollageRotation)

// ─── Daily quick chart ──────────────────────────────────────────────────────

const CHART_LIMIT = 9

const chartTracks = computed(() => (dailySection.value?.tracks ?? []).slice(0, CHART_LIMIT))

function playChartTrack(track: Track): void {
  const queue = dailySection.value?.tracks ?? []
  emit('playTrack', track, queue.length > 0 ? queue : [track])
}

function isPlayingTrack(track: Track): boolean {
  return props.currentTrackId != null && props.currentTrackId === track.id
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Duo cards (FM / radar) ─────────────────────────────────────────────────

function sectionCovers(section: RecSection | null): CollageCover[] {
  const covers: CollageCover[] = []
  const seen = new Set<string>()
  for (const track of section?.tracks ?? []) {
    if (!track.cover || seen.has(track.cover)) continue
    seen.add(track.cover)
    covers.push({ cover: track.cover, coverSource: track.coverSource ?? null })
    if (covers.length >= 3) break
  }
  return covers
}

const fmCovers = computed(() => sectionCovers(fmSection.value))
const radarCovers = computed(() => sectionCovers(radarSection.value))

function openDaily(): void {
  if (dailySection.value) emit('openRecSection', dailySection.value)
}

function playDailyAll(): void {
  const tracks = dailySection.value?.tracks ?? []
  if (tracks.length > 0) {
    emit('playTrack', tracks[0], tracks)
  } else {
    openDaily()
  }
}

function playPersonalizedStream(section: RecSection | null): void {
  if (!section || section.tracks.length === 0) return
  emit('playTrack', section.tracks[0], section.tracks)
}
</script>

<template>
  <ProviderMusicHome
    v-if="presentation"
    v-bind="props"
    @load-recommendations="emit('loadRecommendations')"
    @open-rec-section="emit('openRecSection', $event)"
    @open-playlist="emit('openPlaylist', $event)"
    @play-track="(track, queue) => emit('playTrack', track, queue)"
    @request-login="emit('requestLogin')"
    @open-discovery="emit('openDiscovery')"
  >
    <template v-if="$slots.rankings" #rankings><slot name="rankings" /></template>
  </ProviderMusicHome>
  <div v-else class="home-view">
    <!-- ── Signed-out invite ─────────────────────────────────────────── -->
    <section v-if="!isLoggedIn" class="hero-invite">
      <div class="invite-notes" aria-hidden="true">
        <i class="pi pi-headphones invite-note-icon"></i>
      </div>
      <p class="invite-kicker">{{ providerLabel }}</p>
      <h2 class="invite-title">登录后查看推荐</h2>
      <button type="button" class="invite-cta" @click="emit('requestLogin')">
        <i class="pi pi-user"></i>
        登录 {{ providerLabel }}
      </button>
    </section>

    <!-- ── Loading skeleton ─────────────────────────────────────────── -->
    <div v-else-if="recsLoading" class="home-skeleton" role="status" aria-label="正在加载推荐">
      <div class="sk-hero sk-shimmer"></div>
      <div class="sk-duo">
        <div class="sk-card sk-shimmer"></div>
        <div class="sk-card sk-shimmer"></div>
      </div>
      <div class="sk-tiles">
        <div v-for="i in 6" :key="i" class="sk-tile">
          <div class="sk-tile-cover sk-shimmer"></div>
          <div class="sk-tile-line sk-shimmer"></div>
        </div>
      </div>
    </div>

    <!-- ── Error ─────────────────────────────────────────────────────── -->
    <div v-else-if="recsError" class="home-error" role="alert">
      <span class="home-error-icon"><i class="pi pi-exclamation-triangle"></i></span>
      <p class="home-error-title">推荐加载失败</p>
      <p class="home-error-hint">{{ recsError }}</p>
      <button type="button" class="home-error-retry" @click="emit('loadRecommendations')">
        <i class="pi pi-refresh"></i>
        再试一次
      </button>
    </div>

    <!-- ── Content ───────────────────────────────────────────────────── -->
    <div v-else class="home-flow">
      <div class="home-recommendations">
        <!-- Hero: daily mix -->
        <section v-if="dailySection" class="hero" :aria-label="heroTitle">
          <div class="hero-inner">
            <div class="hero-copy">
              <p class="hero-kicker">
                <span class="hero-kicker-day">{{ isDailyHero ? dayNumber : '荐' }}</span>
                <span class="hero-kicker-meta">
                  <span>{{ isDailyHero ? dateLabel : providerLabel }}</span>
                  <span class="hero-kicker-sub">
                    {{ providerLabel }}
                  </span>
                </span>
              </p>
              <h2 class="hero-title">{{ heroTitle }}</h2>
              <div class="hero-actions">
                <button type="button" class="hero-play" @click="playDailyAll">
                  <PlaybackIcon name="play" />
                  播放全部
                </button>
                <button type="button" class="hero-open" @click="openDaily">
                  查看全部
                  <i class="pi pi-arrow-right"></i>
                </button>
              </div>
            </div>
            <button
              ref="heroStage"
              type="button"
              class="hero-stage"
              :aria-label="`打开${heroTitle}`"
              @click="openDaily"
              @mouseenter="collageHovered = true"
              @mouseleave="collageHovered = false"
              @focusin="collageFocused = true"
              @focusout="collageFocused = false"
            >
              <Transition name="collage">
                <div v-if="collageCovers.length > 0" :key="collagePage" class="hero-collage">
                  <span
                    v-for="(item, index) in collageCovers"
                    :key="`${item.cover}:${index}`"
                    class="hero-collage-card"
                    :class="`hero-collage-card-${index}`"
                  >
                    <CoverImg
                      :cover="item.cover"
                      :cover-source="item.coverSource"
                      class="hero-collage-img"
                      alt=""
                    />
                  </span>
                </div>
                <div v-else key="placeholder" class="hero-collage hero-collage-empty">
                  <span class="hero-collage-card hero-collage-card-0 hero-collage-placeholder">
                    <i class="pi pi-calendar"></i>
                  </span>
                </div>
              </Transition>
            </button>
          </div>
        </section>

        <!-- Duo: FM + radar -->
        <section v-if="fmSection || radarSection" class="duo" aria-label="电台推荐">
          <button
            v-if="fmSection"
            type="button"
            class="duo-card duo-fm"
            @click="playPersonalizedStream(fmSection)"
          >
            <span class="duo-stack" aria-hidden="true">
              <span
                v-for="(item, index) in fmCovers"
                :key="item.cover"
                class="duo-stack-cover"
                :class="`duo-stack-cover-${index}`"
              >
                <CoverImg :cover="item.cover" :cover-source="item.coverSource" alt="" />
              </span>
              <span
                v-if="fmCovers.length === 0"
                class="duo-stack-cover duo-stack-cover-0 duo-stack-empty"
              >
                <i class="pi pi-compass"></i>
              </span>
            </span>
            <span class="duo-copy">
              <span class="duo-name">{{ fmSection.title }}</span>
              <span class="duo-sub">{{ providerLabel }} · 为你持续推荐</span>
            </span>
            <span class="duo-arrow" aria-hidden="true"><i class="pi pi-arrow-right"></i></span>
          </button>

          <button
            v-if="radarSection"
            type="button"
            class="duo-card duo-radar"
            @click="playPersonalizedStream(radarSection)"
          >
            <span class="duo-stack" aria-hidden="true">
              <span
                v-for="(item, index) in radarCovers"
                :key="item.cover"
                class="duo-stack-cover"
                :class="`duo-stack-cover-${index}`"
              >
                <CoverImg :cover="item.cover" :cover-source="item.coverSource" alt="" />
              </span>
              <span
                v-if="radarCovers.length === 0"
                class="duo-stack-cover duo-stack-cover-0 duo-stack-empty"
              >
                <i class="pi pi-send"></i>
              </span>
            </span>
            <span class="duo-copy">
              <span class="duo-name">{{ radarSection.title }}</span>
              <span class="duo-sub">{{ providerLabel }} · 发现更多好音乐</span>
            </span>
            <span class="duo-arrow" aria-hidden="true"><i class="pi pi-arrow-right"></i></span>
          </button>
        </section>
      </div>
      <section v-if="chartTracks.length > 0" class="chart" :aria-label="`${heroTitle}速览`">
        <header class="section-head">
          <div class="section-head-copy">
            <h3>{{ providerLabel }} 为你精选</h3>
            <p>点一首就开始 · 队列自动接上整份推荐</p>
          </div>
          <button type="button" class="section-more" @click="openDaily">
            完整歌单
            <i class="pi pi-chevron-right"></i>
          </button>
        </header>
        <div class="chart-grid">
          <button
            v-for="(track, index) in chartTracks"
            :key="track.id"
            type="button"
            class="chart-row"
            :class="{ 'is-playing': isPlayingTrack(track) }"
            :aria-label="`播放 ${track.title} · ${track.artist}`"
            @click="playChartTrack(track)"
          >
            <span class="chart-index" aria-hidden="true">{{
              String(index + 1).padStart(2, '0')
            }}</span>
            <span class="chart-cover">
              <CoverImg :cover="track.cover" :cover-source="track.coverSource" alt="" />

              <span class="chart-cover-action" aria-hidden="true">
                <span v-if="isPlayingTrack(track)" class="chart-eq"> <i></i><i></i><i></i> </span>
                <PlaybackIcon name="play" v-else />
              </span>
            </span>
            <span class="chart-meta">
              <span class="chart-title" :title="track.title">{{ track.title }}</span>
              <span class="chart-artist" :title="track.artist">{{ track.artist }}</span>
            </span>
            <span class="chart-duration">{{ formatDuration(track.duration) }}</span>
          </button>
        </div>
      </section>

      <!-- Shelf: recommended playlists -->
      <section class="shelf" aria-label="精选歌单">
        <header class="section-head">
          <div class="section-head-copy">
            <h3>{{ providerLabel }} 精选歌单</h3>
            <p>为你挑选 {{ recommendPlaylists.length }} 份歌单</p>
          </div>
        </header>
        <div
          v-if="recommendPlaylists.length > 0"
          :ref="shelfGrid"
          class="shelf-grid"
          :style="shelfGridStyle"
        >
          <button
            v-for="playlist in recommendPlaylists"
            :key="playlist.id"
            type="button"
            class="shelf-tile"
            @click="emit('openPlaylist', playlist)"
          >
            <span class="shelf-cover">
              <CoverImg
                v-if="playlist.coverSmall || playlist.cover"
                :cover="playlist.coverSmall || playlist.cover"
                :cover-source="playlist.coverSmallSource || playlist.coverSource"
                alt=""
              />
              <span v-else class="shelf-cover-empty"><i class="pi pi-list"></i></span>
              <span class="shelf-open" aria-hidden="true"><PlaybackIcon name="play" /></span>
            </span>
            <span class="shelf-name" :title="playlist.name">{{ playlist.name }}</span>
            <span class="shelf-count">{{ playlist.trackCount }} 首</span>
          </button>
        </div>
        <div v-else class="shelf-empty">
          <i class="pi pi-list"></i>
          <span>暂无推荐歌单，稍后再来看看</span>
        </div>
      </section>
    </div>
    <div v-if="$slots.rankings" class="home-rankings"><slot name="rankings" /></div>
  </div>
</template>

<style scoped>
.home-view {
  min-width: 0;
  container-type: inline-size;
  color: var(--te-text);
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body);
}
.home-flow {
  display: flex;
  flex-direction: column;
  gap: var(--te-space-section, 32px);
}
.home-rankings {
  margin-top: var(--te-space-section, 32px);
}
.home-view :is(h1, h2, h3, p) {
  margin: 0;
}
.home-view button {
  font: inherit;
  cursor: pointer;
}
.home-view button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
.hero {
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-card-radius, 12px);
  background: var(--te-card-bg);
}
.home-recommendations {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 20px;
  align-items: stretch;
}
.hero-inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: center;
  height: 100%;
}
.hero-copy {
  min-width: 0;
}
.hero-kicker {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
.hero-kicker-day {
  font-variant-numeric: tabular-nums;
}
.hero-kicker-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.hero-title {
  margin-top: 8px !important;
  font-size: var(--te-type-section-title);
  line-height: 1.3;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.hero-play,
.hero-open,
.invite-cta,
.home-error-retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: var(--te-control-height-md);
  padding: 7px 14px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  font-size: var(--te-type-caption) !important;
  line-height: 1.5;
  font-weight: 500;
}
.hero-play,
.invite-cta {
  background: var(--te-primary-500);
  color: var(--te-control-on-accent);
}
.hero-open,
.home-error-retry {
  background: var(--te-subtle-bg);
  color: var(--te-text);
}
.hero-stage {
  position: relative;
  width: 120px;
  height: 120px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: var(--te-subtle-bg);
  overflow: hidden;
}
.hero-collage {
  position: absolute;
  inset: 0;
}
.hero-collage-card {
  display: block;
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 6px;
  animation: none;
}
.hero-collage-card:not(.hero-collage-card-0) {
  display: none;
}
.hero-collage-img,
.hero-collage-card :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-collage-placeholder {
  display: grid;
  place-items: center;
  color: var(--te-text-secondary);
  background: var(--te-subtle-bg);
}
.collage-enter-active,
.collage-leave-active {
  transition: opacity var(--te-motion-panel) var(--te-ease-out-strong);
}
.collage-enter-from,
.collage-leave-to {
  opacity: 0;
}
.duo {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.duo-card {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  text-align: left;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-card-radius, 12px);
  background: var(--te-card-bg);
  color: inherit;
}
.duo-stack {
  position: relative;
  width: 56px;
  height: 56px;
}
.duo-stack-cover {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  overflow: hidden;
}
.duo-stack-cover:not(.duo-stack-cover-0) {
  display: none;
}
.duo-stack-cover :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.duo-stack-empty {
  display: grid;
  place-items: center;
  background: var(--te-subtle-bg);
  color: var(--te-text-secondary);
}
.duo-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.duo-name {
  font-size: var(--te-type-headline);
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.duo-sub {
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.duo-arrow {
  color: var(--te-text-secondary);
}
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.section-head-copy {
  min-width: 0;
}
.section-head h3 {
  font-size: var(--te-type-section-title);
  font-weight: 600;
  line-height: 1.3;
}
.section-head p {
  margin-top: 4px;
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.section-more {
  min-height: var(--te-control-height-md);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  color: var(--te-text-secondary);
  background: transparent;
  font-size: var(--te-type-caption) !important;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 24px;
}
.chart-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 56px;
  padding: 8px 4px;
  border: 0;
  border-bottom: 1px solid var(--te-card-border);
  border-radius: 0;
  color: inherit;
  background: transparent;
  text-align: left;
}
.chart-row:hover,
.duo-card:hover,
.section-more:hover {
  background: var(--te-subtle-bg);
}
.chart-row.is-playing {
  background: var(--te-subtle-bg);
}
.chart-index {
  width: 20px;
  flex-shrink: 0;
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  font-variant-numeric: tabular-nums;
}
.chart-cover {
  position: relative;
  flex: 0 0 40px;
  height: 40px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--te-subtle-bg);
}
.chart-cover :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.chart-cover-action {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--te-control-fg);
  background: var(--te-card-bg-solid, var(--te-settings-control-bg));
  opacity: 0;
}
.chart-row:is(:hover, :focus-visible, .is-playing) .chart-cover-action {
  opacity: 1;
}
.chart-eq {
  display: flex;
  align-items: center;
  gap: 2px;
}
.chart-eq i {
  width: 2px;
  height: 8px;
  background: currentColor;
}
.chart-eq i:nth-child(2) {
  height: 14px;
}
.chart-meta {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 3px;
}
.chart-title {
  font-size: var(--te-type-body);
  line-height: 1.4;
  font-weight: 500;
}
.chart-artist,
.chart-duration {
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.chart-title,
.chart-artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chart-duration {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.shelf-grid {
  display: grid;
  min-width: 0;
}
.shelf-tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 0;
  text-align: left;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
}
.shelf-cover {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 6px;
  background: var(--te-subtle-bg);
}
.shelf-cover :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.shelf-cover-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--te-text-secondary);
}
.shelf-scrim {
  display: none;
}
.shelf-count {
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.shelf-open {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--te-card-bg-solid, var(--te-settings-control-bg));
  color: var(--te-control-fg);
  opacity: 0;
  transition: opacity var(--te-motion-hover);
}
.shelf-tile:is(:hover, :focus-visible) .shelf-open {
  opacity: 1;
}
.shelf-name {
  width: 100%;
  font-size: var(--te-type-body);
  font-weight: 500;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.shelf-empty,
.hero-invite,
.home-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 0;
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
.invite-title,
.home-error-title {
  color: var(--te-text);
  font-size: var(--te-type-section-title);
  font-weight: 600;
}
.invite-notes,
.home-error-icon {
  display: none;
}
.home-skeleton {
  display: grid;
  gap: 24px;
}
.sk-hero {
  height: 160px;
  max-width: 480px;
}
.sk-duo {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
}
.sk-card {
  height: 80px;
}
.sk-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 200px));
  gap: 20px;
}
.sk-tile-cover {
  aspect-ratio: 1;
}
.sk-tile-line {
  height: 16px;
  margin-top: 8px;
  width: 75%;
}
.sk-shimmer {
  border-radius: 4px;
  background: var(--te-subtle-bg);
}
@container (max-width:720px) {
  .chart-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container (max-width:1119px) {
  .chart-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width:1023px) {
  .home-recommendations {
    grid-template-columns: minmax(0, 1fr);
  }
  .duo {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width:720px) {
  .chart-grid,
  .duo {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container (max-width:500px) {
  .hero {
    padding: 16px;
  }
  .hero-inner {
    grid-template-columns: minmax(0, 1fr) 96px;
    gap: 16px;
  }
  .hero-stage {
    width: 96px;
    height: 96px;
  }
}
@container (max-width:360px) {
  .hero-inner {
    grid-template-columns: minmax(0, 1fr) 80px;
  }
  .hero-stage {
    width: 80px;
    height: 80px;
  }
  .chart-duration {
    display: none;
  }
}
</style>
