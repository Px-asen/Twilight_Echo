<script setup lang="ts">
import { computed } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import type { Track } from '@renderer/types/music'
import type { MediaProviderPlaylistSummary } from '@renderer/providers/mediaProvider'
import type { ProviderHomeSection } from '@renderer/components/streaming-page/providerHomeTypes'
import type { ProviderHomePresentation } from '../../../../shared/providerHome'

const props = defineProps<{
  providerLabel: string
  providerColor?: string
  presentation?: ProviderHomePresentation
  supportsDiscovery?: boolean
  isLoggedIn: boolean
  recsLoading: boolean
  recsError: string
  recSections: ProviderHomeSection[]
  recommendPlaylists: MediaProviderPlaylistSummary[]
  currentTrackId?: string | null
}>()

const emit = defineEmits<{
  loadRecommendations: []
  openRecSection: [section: ProviderHomeSection]
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  playTrack: [track: Track, queue: Track[]]
  requestLogin: []
  openDiscovery: []
}>()

const hero = computed(() => props.recSections[0])
const heroLocked = computed(() => hero.value?.requiresLogin === true && !props.isLoggedIn)
const features = computed(() => props.recSections.slice(1, 3))
const tracks = computed(() => hero.value?.tracks.slice(0, 6) ?? [])
const playlists = computed(() => props.recommendPlaylists.slice(0, 12))
const hasContent = computed(() => props.recSections.length > 0 || playlists.value.length > 0)
const locked = computed(() => !props.isLoggedIn && props.presentation?.requiresLogin !== false)
const artwork = computed(() => {
  const seen = new Set<string>()
  const result: Track[] = []
  for (const track of hero.value?.tracks ?? []) {
    if (!track.cover || seen.has(track.cover)) continue
    seen.add(track.cover)
    result.push(track)
    if (result.length === 3) break
  }
  return result
})

function play(section: ProviderHomeSection, track = section.tracks[0]): void {
  if (!track) return
  if (!props.isLoggedIn) {
    emit('requestLogin')
    return
  }
  emit('playTrack', track, section.tracks)
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function count(value: number | undefined): string {
  if (!value) return ''
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿次播放`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万次播放`
  return `${value} 次播放`
}
</script>

<template>
  <div
    class="music-home"
    :style="{ '--provider-accent': providerColor || 'var(--te-primary-500)' }"
    :aria-busy="recsLoading"
  >
    <header class="music-masthead">
      <div>
        <p class="music-eyebrow"><span class="music-dot"></span> {{ providerLabel }} / 发现音乐</p>
        <h1>{{ presentation?.subtitle || '今天，从一首好歌开始。' }}</h1>
      </div>
      <button
        class="music-refresh"
        type="button"
        :disabled="recsLoading"
        @click="emit('loadRecommendations')"
        aria-label="刷新首页推荐"
      >
        <i class="pi pi-refresh" :class="{ 'pi-spin': recsLoading }"></i>
        {{ recsLoading ? '更新中' : '刷新推荐' }}
      </button>
    </header>

    <div v-if="locked" class="music-state">
      <i class="pi pi-headphones"></i>
      <h2>你的音乐，在这里继续</h2>
      <p>登录 {{ providerLabel }}，开启首页推荐。</p>
      <button class="music-primary" type="button" @click="emit('requestLogin')">
        登录 {{ providerLabel }}
      </button>
    </div>

    <div
      v-else-if="recsLoading && !hasContent"
      class="music-skeleton"
      role="status"
      aria-label="正在加载首页推荐"
    >
      <div class="music-skeleton-hero"></div>
      <div class="music-skeleton-card"></div>
      <div class="music-skeleton-card"></div>
      <span class="music-sr-only">正在加载首页推荐</span>
    </div>

    <template v-else>
      <div v-if="recsError" class="music-notice" role="status">
        <i class="pi pi-info-circle"></i><span>{{ recsError }}</span>
        <button type="button" :disabled="recsLoading" @click="emit('loadRecommendations')">
          重新加载
        </button>
      </div>

      <section v-if="hero" class="music-hero" :aria-label="hero.title">
        <div class="music-hero-copy">
          <p class="music-eyebrow">
            {{ hero.eyebrow || 'SELECTED FOR TODAY' }}
            <span>01 / {{ String(recSections.length).padStart(2, '0') }}</span>
          </p>
          <h2>{{ hero.title }}</h2>
          <p class="music-hero-description">
            {{ hero.description || `来自 ${providerLabel} 的音乐精选。` }}
          </p>
          <div class="music-hero-actions">
            <button
              v-if="heroLocked"
              class="music-primary"
              type="button"
              @click="emit('requestLogin')"
            >
              <i class="pi pi-user"></i> 登录查看每日推荐
            </button>
            <button
              v-else-if="hero.tracks.length"
              class="music-primary"
              type="button"
              @click="play(hero)"
            >
              <i class="pi pi-play"></i> 播放全部
            </button>
            <button
              v-else
              class="music-primary"
              type="button"
              :disabled="recsLoading"
              @click="emit('loadRecommendations')"
            >
              <i class="pi pi-refresh"></i> 重新加载
            </button>
            <button
              v-if="hero.tracks.length && !heroLocked"
              class="music-hero-open"
              type="button"
              @click="emit('openRecSection', hero)"
            >
              查看歌曲 <i class="pi pi-arrow-up-right"></i>
            </button>
          </div>
          <p class="music-hero-foot">
            {{
              heroLocked
                ? '登录后，加载属于你的每日推荐'
                : hero.error ||
                  (hero.tracks.length
                    ? `${hero.tracks.length} 首 · ${providerLabel}`
                    : '本次暂无推荐，稍后再来听听')
            }}
          </p>
        </div>
        <div class="music-artwork" aria-hidden="true">
          <span class="music-orbit"></span><span class="music-orbit music-orbit-inner"></span>
          <div
            v-for="(track, index) in artwork"
            :key="track.id"
            class="music-artwork-cover"
            :class="`music-artwork-${index}`"
          >
            <CoverImg
              :cover="track.cover"
              :cover-source="track.coverSource"
              alt=""
              loading="eager"
            />
          </div>
          <div v-if="!artwork.length" class="music-record"><i class="pi pi-headphones"></i></div>
          <span class="music-artwork-caption">PRESS PLAY. FEEL MORE.</span>
        </div>
      </section>

      <div v-if="!isLoggedIn" class="music-login-strip">
        <span>先发现喜欢的音乐，登录后开始收听。</span>
        <button type="button" @click="emit('requestLogin')">
          登录 {{ providerLabel }} <i class="pi pi-arrow-right"></i>
        </button>
      </div>

      <section
        v-if="tracks.length && hero"
        class="music-track-section"
        :aria-label="hero.title + '歌曲速览'"
      >
        <header class="music-section-head">
          <h2>
            先听这几首<span> / {{ hero.eyebrow || 'QUICK LISTEN' }}</span>
          </h2>
          <button type="button" @click="emit('openRecSection', hero)">
            全部歌曲 <i class="pi pi-arrow-right"></i>
          </button>
        </header>
        <div class="music-track-grid">
          <button
            v-for="(track, index) in tracks"
            :key="track.id"
            type="button"
            class="music-track"
            :class="{ 'is-current': currentTrackId === track.id }"
            @click="play(hero, track)"
            :aria-label="`播放 ${track.title} · ${track.artist}`"
          >
            <span class="music-track-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="music-track-cover"
              ><CoverImg
                :cover="track.cover"
                :cover-source="track.coverSource"
                alt=""
                loading="lazy" /><i class="pi pi-play"></i
            ></span>
            <span class="music-track-meta"
              ><strong>{{ track.title }}</strong
              ><span>{{ track.artist }}</span></span
            >
            <span class="music-track-duration">{{ duration(track.duration) }}</span>
          </button>
        </div>
      </section>

      <section v-if="features.length" class="music-features" aria-label="更多音乐推荐">
        <article
          v-for="(section, index) in features"
          :key="section.key"
          class="music-feature"
          :class="{ 'music-feature-alt': index === 1 }"
        >
          <header>
            <div>
              <p class="music-eyebrow">{{ section.eyebrow || 'KEEP EXPLORING' }}</p>
              <h2>{{ section.title }}</h2>
            </div>
            <button
              type="button"
              class="music-feature-play"
              :disabled="!section.tracks.length"
              :aria-label="`播放${section.title}`"
              @click="play(section)"
            >
              <i :class="section.icon"></i>
            </button>
          </header>
          <p class="music-feature-description">{{ section.description }}</p>
          <div
            v-if="section.error || !section.tracks.length"
            class="music-feature-empty"
            role="status"
          >
            <span>{{ section.error || '本次暂无歌曲' }}</span
            ><button type="button" :disabled="recsLoading" @click="emit('loadRecommendations')">
              重试
            </button>
          </div>
          <button
            v-for="(track, position) in section.tracks.slice(0, 3)"
            :key="track.id"
            type="button"
            class="music-feature-track"
            :class="{ 'is-current': currentTrackId === track.id }"
            @click="play(section, track)"
            :aria-label="`播放 ${track.title} · ${track.artist}`"
          >
            <span>{{ String(position + 1).padStart(2, '0') }}</span
            ><span class="music-feature-cover"
              ><CoverImg
                :cover="track.cover"
                :cover-source="track.coverSource"
                alt=""
                loading="lazy" /></span
            ><strong
              >{{ track.title }}<small>{{ track.artist }}</small></strong
            ><i class="pi pi-play"></i>
          </button>
          <button
            v-if="section.tracks.length"
            type="button"
            class="music-feature-more"
            @click="emit('openRecSection', section)"
          >
            查看全部 {{ section.tracks.length }} 首 <i class="pi pi-arrow-up-right"></i>
          </button>
        </article>
      </section>

      <section class="music-playlists" aria-label="精选歌单">
        <header class="music-section-head">
          <h2>把喜欢，听成一张歌单<span> / CURATED PLAYLISTS</span></h2>
          <button v-if="supportsDiscovery" type="button" @click="emit('openDiscovery')">
            发现更多 <i class="pi pi-arrow-right"></i>
          </button>
        </header>
        <div v-if="playlists.length" class="music-playlist-grid">
          <button
            v-for="playlist in playlists"
            :key="playlist.id"
            type="button"
            class="music-playlist"
            @click="emit('openPlaylist', playlist)"
          >
            <span class="music-playlist-art"
              ><CoverImg
                :cover="playlist.coverSmall || playlist.cover"
                :cover-source="playlist.coverSmallSource || playlist.coverSource"
                alt=""
                loading="lazy"
              /><span class="music-playlist-symbol"><i class="pi pi-play"></i></span
              ><span
                v-if="playlist.playCount || playlist.trackCount"
                class="music-playlist-count"
                >{{ count(playlist.playCount) || `${playlist.trackCount} 首` }}</span
              ></span
            >
            <strong>{{ playlist.name }}</strong
            ><small>{{ playlist.creatorName || providerLabel + '精选' }}</small>
          </button>
        </div>
        <div v-else class="music-feature-empty">
          <span>暂时没有推荐歌单</span
          ><button type="button" :disabled="recsLoading" @click="emit('loadRecommendations')">
            重新加载
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped src="./ProviderMusicHome.css"></style>
