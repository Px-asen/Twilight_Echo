<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed } from 'vue'
import CoverImg from '../CoverImg.vue'
import type { ProviderInfo } from '../../stores/useProviderStore'
import type { Track } from '../../types/music'
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider'
import type { StreamingPageTab } from '../../app/navigationPages'
import { resolveTimeGreeting } from '../../utils/timeGreeting'

const props = defineProps<{
  providers: ProviderInfo[]
  provider: ProviderInfo | null
  loading: boolean
  loggedIn: boolean
  error: string
  tracks: Track[]
  playlists: MediaProviderPlaylistSummary[]
  sectionTitle: string
  playlistTitle: string
  recent: Track[]
  hero: Track | null
  currentTrackId?: string
  isPlaying: boolean
  pendingPlaylist: string | null
}>()
const emit = defineEmits<{
  'select-provider': [id: string]
  play: [track: Track, queue: Track[]]
  'play-hero': []
  'play-playlist': [playlist: MediaProviderPlaylistSummary]
  reload: []
  login: []
  'open-streaming': [tab: StreamingPageTab]
  'open-plugins': []
  'open-radio': []
  'open-recent': []
  'open-library-settings': []
}>()
const greeting = resolveTimeGreeting(new Date().getHours())
const providerLabel = computed(() =>
  props.provider?.id === 'ncm' ? '网易云音乐' : (props.provider?.name ?? '在线音乐')
)
const supports = (method: string) => props.provider?.supportedMethods.includes(method) === true
const canDiscover = computed(() => supports('fetchDiscoveryPlaylists'))
const canSearch = computed(() => supports('searchSongs'))
const canLibrary = computed(
  () => supports('fetchUserLibrary') && props.provider?.ui?.streamingLibraryTab !== false
)
const needsLogin = computed(() => props.provider?.capabilities.includes('login') && !props.loggedIn)
const hasContent = computed(() => props.tracks.length > 0 || props.playlists.length > 0)
const expectsTracks = computed(() =>
  props.provider?.ui?.streamingSections?.some((section) => supports(section.method))
)
const heroPlaying = computed(() => props.hero?.id === props.currentTrackId && props.isPlaying)
const heroLabel = computed(() => {
  if (props.hero?.id === props.currentTrackId) return props.isPlaying ? '正在播放' : '继续收听'
  return props.recent.some((track) => track.id === props.hero?.id) ? '最近播放' : '推荐歌曲'
})
function primaryAction(): void {
  if (!props.provider) emit('open-plugins')
  else if (canDiscover.value) emit('open-streaming', 'discover')
  else if (needsLogin.value) emit('login')
  else if (canSearch.value) emit('open-streaming', 'search')
  else if (canLibrary.value) emit('open-streaming', 'library')
  else emit('open-radio')
}
const primaryLabel = computed(() => {
  if (!props.provider) return '接入在线音源'
  if (canDiscover.value) return '发现歌单'
  if (needsLogin.value) return `登录 ${providerLabel.value}`
  if (canSearch.value) return '搜索在线音乐'
  if (canLibrary.value) return '打开我的音乐库'
  return '打开电台与播客'
})
</script>

<template>
  <main class="online-home" aria-label="音乐首页">
    <div class="online-home-inner">
      <header class="online-heading">
        <h1>{{ greeting }}</h1>
        <button class="online-text-button" type="button" @click="emit('open-library-settings')">
          <i class="pi pi-folder-plus" aria-hidden="true"></i> 添加本地音乐
        </button>
      </header>

      <section class="online-hero" :class="{ 'has-track': hero }">
        <div class="online-hero-copy">
          <p v-if="hero" class="online-eyebrow">{{ heroLabel }}</p>
          <h2>{{ hero?.title || '在线音乐' }}</h2>
          <p v-if="hero" class="online-hero-description">
            {{ hero.artist }}{{ hero.album ? ' · ' + hero.album : '' }}
          </p>
          <div class="online-actions">
            <button v-if="hero" class="online-primary" type="button" @click="emit('play-hero')">
              <PlaybackIcon :name="heroPlaying ? 'pause' : 'play'" aria-hidden="true" />
              {{ heroPlaying ? '暂停播放' : '开始收听' }}
            </button>
            <button v-else class="online-primary" type="button" @click="primaryAction">
              {{ primaryLabel }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
            </button>
            <button
              v-if="canSearch"
              class="online-secondary"
              type="button"
              @click="emit('open-streaming', 'search')"
            >
              <i class="pi pi-search" aria-hidden="true"></i> 搜一首歌
            </button>
          </div>
        </div>
        <div class="online-record-stage" aria-hidden="true">
          <div class="online-record"><span></span></div>
          <div class="online-record-sleeve">
            <CoverImg
              v-if="hero"
              :cover="hero.cover"
              :cover-source="hero.coverSource"
              :identity="hero.id"
              alt=""
              loading="eager"
              ><template #placeholder><i class="pi pi-headphones"></i></template
            ></CoverImg>
            <template v-else
              ><i class="pi pi-headphones"></i><span>TWILIGHT<br />ECHO</span></template
            >
          </div>
          <span class="online-record-caption">TWILIGHT ECHO / PRESS PLAY</span>
        </div>
      </section>

      <nav class="online-shortcuts" aria-label="探索音乐">
        <button v-if="canDiscover" type="button" @click="emit('open-streaming', 'discover')">
          <i class="pi pi-compass" aria-hidden="true"></i><span><strong>发现歌单</strong></span
          ><i class="pi pi-arrow-up-right" aria-hidden="true"></i>
        </button>
        <button
          v-if="canLibrary"
          type="button"
          @click="needsLogin ? emit('login') : emit('open-streaming', 'library')"
        >
          <i class="pi pi-heart" aria-hidden="true"></i
          ><span><strong>我的在线音乐</strong><small v-if="needsLogin">登录后查看</small></span
          ><i class="pi pi-arrow-up-right" aria-hidden="true"></i>
        </button>
        <button type="button" @click="emit('open-radio')">
          <i class="pi pi-microphone" aria-hidden="true"></i><span><strong>电台与播客</strong></span
          ><i class="pi pi-arrow-up-right" aria-hidden="true"></i>
        </button>
        <button v-if="!canDiscover || !canLibrary" type="button" @click="emit('open-plugins')">
          <i class="pi pi-plus-circle" aria-hidden="true"></i
          ><span><strong>接入更多音源</strong></span
          ><i class="pi pi-arrow-up-right" aria-hidden="true"></i>
        </button>
      </nav>

      <section v-if="recent.length" class="online-section">
        <header class="online-section-heading">
          <h2>最近听过</h2>
          <button class="online-text-button" type="button" @click="emit('open-recent')">
            全部记录 <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </button>
        </header>
        <div class="online-track-grid">
          <button
            v-for="track in recent"
            :key="track.id"
            type="button"
            class="online-track"
            :class="{ 'is-current': currentTrackId === track.id }"
            :aria-label="`${currentTrackId === track.id && isPlaying ? '暂停' : '播放'} ${track.title}`"
            @click="emit('play', track, recent)"
          >
            <span class="online-track-cover"
              ><CoverImg
                :cover="track.cover"
                :cover-source="track.coverSource"
                :identity="track.id"
                alt=""
                ><template #placeholder
                  ><i class="pi pi-headphones" aria-hidden="true"></i></template></CoverImg
            ></span>
            <span class="online-track-info"
              ><strong>{{ track.title }}</strong
              ><small>{{ track.artist }}</small></span
            >
            <PlaybackIcon
              :name="currentTrackId === track.id && isPlaying ? 'pause' : 'play'"
              aria-hidden="true"
            />
          </button>
        </div>
      </section>

      <section v-if="provider" class="online-section online-discovery" :aria-busy="loading">
        <header class="online-section-heading online-source-heading">
          <h2>今天，听什么</h2>
          <div class="online-source-actions">
            <label class="online-source-picker"
              ><span class="online-sr-only">选择在线音源</span
              ><i :class="provider.ui?.icon || 'pi pi-cloud'" aria-hidden="true"></i
              ><select
                :value="provider.id"
                @change="emit('select-provider', ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="source in providers" :key="source.id" :value="source.id">
                  {{ source.id === 'ncm' ? '网易云音乐' : source.name }}
                </option>
              </select></label
            >
            <button
              class="online-icon-button"
              type="button"
              aria-label="刷新在线推荐"
              :disabled="loading"
              @click="emit('reload')"
            >
              <i class="pi pi-refresh" :class="{ 'pi-spin': loading }" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        <span v-if="loading" class="online-sr-only" role="status">{{
          hasContent
            ? `正在刷新 ${providerLabel} 的在线内容`
            : `正在加载 ${providerLabel} 的在线内容`
        }}</span>
        <div v-if="needsLogin && (!loading || hasContent)" class="online-login-strip">
          <span>登录 {{ providerLabel }}，让推荐更懂你。</span
          ><button class="online-text-button" type="button" @click="emit('login')">
            去登录 <i class="pi pi-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
        <div v-if="error" class="online-notice" role="status">
          <span>{{ error }}</span
          ><button
            class="online-text-button"
            type="button"
            :disabled="loading"
            @click="emit('reload')"
          >
            重试
          </button>
        </div>
        <div v-if="loading && !hasContent" class="online-loading-content" aria-hidden="true">
          <div v-if="expectsTracks" class="online-recommendations">
            <span class="online-skeleton-line online-skeleton-heading"></span>
            <div class="online-track-grid">
              <div v-for="index in 6" :key="index" class="online-track">
                <span class="online-track-cover"></span>
                <span class="online-track-info"><span class="online-skeleton-line"></span></span>
              </div>
            </div>
          </div>
          <div class="online-playlists">
            <span class="online-skeleton-line online-skeleton-heading"></span>
            <div class="online-skeleton">
              <div v-for="index in 6" :key="index" class="online-playlist">
                <span class="online-playlist-cover"></span>
                <strong><span class="online-skeleton-line"></span></strong>
                <small><span class="online-skeleton-line"></span></small>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="online-results" :class="{ 'is-refreshing': loading }">
          <div v-if="tracks.length" class="online-recommendations">
            <h3>
              {{ sectionTitle }} <span> / {{ providerLabel }}</span>
            </h3>
            <div class="online-track-grid">
              <button
                v-for="(track, index) in tracks.slice(0, 6)"
                :key="track.id"
                class="online-track"
                :class="{ 'is-current': currentTrackId === track.id }"
                type="button"
                :aria-label="`${currentTrackId === track.id && isPlaying ? '暂停' : '播放'} ${track.title}`"
                @click="emit('play', track, tracks)"
              >
                <span class="online-track-number">{{ String(index + 1).padStart(2, '0') }}</span>
                <span class="online-track-cover"
                  ><CoverImg
                    :cover="track.cover"
                    :cover-source="track.coverSource"
                    :identity="track.id"
                    alt=""
                    ><template #placeholder
                      ><i class="pi pi-headphones" aria-hidden="true"></i></template></CoverImg
                ></span>
                <span class="online-track-info"
                  ><strong>{{ track.title }}</strong
                  ><small>{{ track.artist }}</small></span
                ><PlaybackIcon
                  :name="currentTrackId === track.id && isPlaying ? 'pause' : 'play'"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
          <div v-if="playlists.length" class="online-playlists">
            <header class="online-section-heading">
              <h3>{{ playlistTitle }}</h3>
              <button
                v-if="canDiscover"
                class="online-text-button"
                type="button"
                @click="emit('open-streaming', 'discover')"
              >
                更多歌单 <i class="pi pi-arrow-right" aria-hidden="true"></i>
              </button>
            </header>
            <div class="online-playlist-grid">
              <button
                v-for="playlist in playlists"
                :key="playlist.id"
                class="online-playlist"
                type="button"
                :disabled="
                  !supports('fetchPlaylistTracks') || pendingPlaylist === String(playlist.id)
                "
                :aria-label="`播放歌单 ${playlist.name}`"
                @click="emit('play-playlist', playlist)"
              >
                <span class="online-playlist-cover"
                  ><CoverImg :cover="playlist.cover" :cover-source="playlist.coverSource" alt=""
                    ><template #placeholder
                      ><i class="pi pi-headphones" aria-hidden="true"></i></template></CoverImg
                  ><span class="online-playlist-play"
                    ><i
                      v-if="pendingPlaylist === String(playlist.id)"
                      class="pi pi-spin pi-spinner"
                      aria-hidden="true"
                    ></i
                    ><PlaybackIcon v-else name="play" aria-hidden="true" /></span
                ></span>
                <strong>{{ playlist.name }}</strong
                ><small>{{
                  pendingPlaylist === String(playlist.id)
                    ? '正在准备播放…'
                    : playlist.trackCount
                      ? `${playlist.trackCount} 首歌曲`
                      : providerLabel
                }}</small>
              </button>
            </div>
          </div>
          <div v-if="!tracks.length && !playlists.length" class="online-empty">
            <i class="pi pi-headphones" aria-hidden="true"></i>
            <div>
              <h3>{{ needsLogin ? '登录后查看推荐' : '暂无推荐内容' }}</h3>
              <p>
                {{ needsLogin ? '也可以浏览歌单和电台。' : '可以使用搜索、音乐库或电台。' }}
              </p>
            </div>
            <button class="online-secondary" type="button" @click="primaryAction">
              {{ primaryLabel }}
            </button>
          </div>
        </div>
      </section>
      <div v-else-if="error" class="online-notice" role="status">{{ error }}</div>
      <footer class="online-footer">
        <button class="online-text-button" type="button" @click="emit('open-plugins')">
          管理音源 <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
        </button>
      </footer>
    </div>
  </main>
</template>

<style scoped src="./OnlineHome.css"></style>
