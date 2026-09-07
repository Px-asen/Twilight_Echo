<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Track } from '@renderer/types/music'
import SoundFieldArtwork from '@renderer/components/local-dashboard/SoundFieldArtwork.vue'

const props = defineProps<{
  summary: { tracks: number; albums: number; artists: number; totalSeconds: number }
  featured: Track | null
  recent: Track[]
  added: Track[]
  albums: Array<{
    key: string
    name: string
    artist: string
    cover: string | null
    coverSource?: string | null
    identity?: string
    trackCount: number
  }>
  isPlaying: boolean
  currentTrackId: string | null
  currentTime: number
  duration: number
}>()
const emit = defineEmits<{
  play: [track: Track]
  shuffle: []
  seek: [position: number]
  previous: []
  next: []
  'open-album': [index: number]
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
}>()

const activity = ref<'recent' | 'added'>(props.recent.length ? 'recent' : 'added')
const albumPage = ref(0)
const trackPage = ref(0)
const selectedTracks = computed(() => (activity.value === 'recent' ? props.recent : props.added))
const trackPageCount = computed(() => Math.max(1, Math.ceil(selectedTracks.value.length / 5)))
const currentTrackPage = computed(() => Math.min(trackPage.value, trackPageCount.value - 1))
const visibleTracks = computed(() =>
  selectedTracks.value.slice(currentTrackPage.value * 5, currentTrackPage.value * 5 + 5)
)
const albumPageCount = computed(() => Math.max(1, Math.ceil(props.albums.length / 4)))
const currentAlbumPage = computed(() => Math.min(albumPage.value, albumPageCount.value - 1))
const visibleAlbums = computed(() =>
  props.albums.slice(currentAlbumPage.value * 4, currentAlbumPage.value * 4 + 4)
)
const featuredIsCurrent = computed(
  () => !!props.currentTrackId && props.featured?.id === props.currentTrackId
)
const featuredIsPlaying = computed(() => featuredIsCurrent.value && props.isPlaying)
const featuredStatus = computed(() => {
  if (featuredIsPlaying.value) return '正在播放'
  if (featuredIsCurrent.value) return '已暂停'
  return props.recent.some((track) => track.id === props.featured?.id) ? '继续收听' : '今日开场'
})
const progress = computed(() =>
  props.duration > 0 ? Math.min(1, Math.max(0, props.currentTime / props.duration)) : 0
)
const collectionTime = computed(() => {
  const hours = props.summary.totalSeconds / 3600
  return {
    value: Math.round(hours >= 1 ? hours : props.summary.totalSeconds / 60).toLocaleString('zh-CN'),
    unit: hours >= 1 ? '小时音乐' : '分钟音乐'
  }
})
const quality = computed(() => {
  const track = props.featured
  return [
    track?.format?.split('/')[0].toUpperCase(),
    track?.bitDepth ? `${track.bitDepth} BIT` : '',
    track?.sampleRate ? `${Number((track.sampleRate / 1000).toFixed(1))} kHz` : ''
  ].filter(Boolean)
})

watch(activity, () => {
  trackPage.value = 0
})

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

function selectTab(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  activity.value =
    event.key === 'Home'
      ? 'recent'
      : event.key === 'End'
        ? 'added'
        : activity.value === 'recent'
          ? 'added'
          : 'recent'
  const group = (event.currentTarget as HTMLElement).parentElement
  group?.querySelector<HTMLButtonElement>(`#sf-tab-${activity.value}`)?.focus()
}

function openActivity(): void {
  emit('select-view', activity.value === 'recent' ? 'recent' : 'allSongs', null)
}

function seekFromInput(event: Event): void {
  emit('seek', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <main class="sound-field dashboard-wrapper">
    <div class="sf-layout">
      <section class="sf-session" aria-label="当前聆听">
        <div class="sf-session-top">
          <span class="sf-station"
            ><i class="ph ph-waveform" aria-hidden="true"></i> ECHO / 04</span
          >
          <span class="sf-on-air" :class="{ 'is-playing': featuredIsPlaying }">
            <span></span>{{ featured ? featuredStatus : '待播放' }}
          </span>
        </div>
        <div class="sf-session-main">
          <div class="sf-cover-mount">
            <SoundFieldArtwork
              class="sf-current-art"
              :cover="featured?.cover"
              :cover-source="featured?.coverSource"
              :identity="featured?.id"
              :title="featured?.title || '声'"
              eager
            />
            <span class="sf-cover-corner" aria-hidden="true"></span>
          </div>
          <div class="sf-session-copy">
            <p class="sf-kicker">{{ featured ? 'NOW IN FOCUS' : 'YOUR FIRST SESSION' }}</p>
            <h2 :title="featured?.title">{{ featured?.title || '下一首，属于你。' }}</h2>
            <p class="sf-current-artist" :title="featured?.artist">
              {{ featured?.artist || '从一首喜欢的音乐开始' }}
            </p>
            <p v-if="featured" class="sf-current-album" :title="featured.album">
              <i class="ph ph-disc" aria-hidden="true"></i
              ><span>{{ featured.album || '未知专辑' }}</span>
            </p>
            <div v-if="quality.length" class="sf-quality" aria-label="音频规格">
              <span v-for="item in quality" :key="item">{{ item }}</span>
            </div>
            <div v-if="featured" class="sf-transport">
              <div
                class="sf-progress"
                :class="{ 'is-disabled': !featuredIsCurrent || duration <= 0 }"
              >
                <span class="sf-progress-line" aria-hidden="true"
                  ><span :style="{ transform: 'scaleX(' + progress + ')' }"></span
                ></span>
                <input
                  type="range"
                  min="0"
                  :max="duration || featured.duration || 1"
                  step="1"
                  :value="currentTime"
                  :disabled="!featuredIsCurrent || duration <= 0"
                  aria-label="播放进度"
                  :aria-valuetext="
                    formatTime(currentTime) + ' / ' + formatTime(duration || featured.duration)
                  "
                  @input="seekFromInput"
                />
              </div>
              <div class="sf-time">
                <span>{{ formatTime(currentTime) }}</span
                ><span>{{ formatTime(duration || featured.duration) }}</span>
              </div>
              <div class="sf-transport-buttons">
                <button
                  type="button"
                  class="sf-icon-button"
                  title="上一首"
                  aria-label="上一首"
                  :disabled="!featuredIsCurrent"
                  @click="emit('previous')"
                >
                  <i class="ph ph-skip-back" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="sf-play-button"
                  :title="featuredIsPlaying ? '暂停' : '播放'"
                  :aria-label="featuredIsPlaying ? '暂停' : '播放'"
                  @click="emit('play', featured)"
                >
                  <i
                    :class="featuredIsPlaying ? 'ph ph-pause' : 'ph ph-play'"
                    aria-hidden="true"
                  ></i>
                </button>
                <button
                  type="button"
                  class="sf-icon-button"
                  title="下一首"
                  aria-label="下一首"
                  :disabled="!featuredIsCurrent"
                  @click="emit('next')"
                >
                  <i class="ph ph-skip-forward" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <button
              v-else
              type="button"
              class="sf-add-music"
              @click="emit('open-library-settings')"
            >
              <i class="ph ph-folder-simple-plus" aria-hidden="true"></i>添加音乐
            </button>
          </div>
        </div>
        <div class="sf-session-bottom">
          <span class="sf-session-caption"
            >A LITTLE LESS NOISE.<br /><strong>A LITTLE MORE MUSIC.</strong></span
          >
          <i class="ph ph-headphones" aria-hidden="true"></i>
        </div>
      </section>

      <div class="sf-content">
        <header class="sf-masthead">
          <div class="sf-title-group">
            <p class="sf-kicker">TWILIGHT ECHO / PERSONAL AUDIO</p>
            <h1>
              声场<span class="sf-title-mark" aria-hidden="true"
                ><i class="ph ph-asterisk"></i></span
              ><span class="sf-title-en">Sound<br />Field</span>
            </h1>
          </div>
          <button v-if="summary.tracks" type="button" class="sf-shuffle" @click="emit('shuffle')">
            <i class="ph ph-shuffle" aria-hidden="true"></i><span>随心播放</span>
          </button>
          <button v-else type="button" class="sf-shuffle" @click="emit('open-library-settings')">
            <i class="ph ph-plus" aria-hidden="true"></i><span>添加音乐</span>
          </button>
        </header>

        <section class="sf-albums" aria-labelledby="sf-albums-title">
          <div class="sf-section-head">
            <div class="sf-section-title">
              <span class="sf-index">01</span>
              <h2 id="sf-albums-title">专辑选辑</h2>
              <span class="sf-section-en">THE ALBUM EDIT</span>
            </div>
            <div class="sf-section-actions">
              <div v-if="albumPageCount > 1" class="sf-pagination">
                <button
                  type="button"
                  title="上一组专辑"
                  aria-label="上一组专辑"
                  :disabled="currentAlbumPage === 0"
                  @click="albumPage = currentAlbumPage - 1"
                >
                  <i class="ph ph-arrow-left" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  title="下一组专辑"
                  aria-label="下一组专辑"
                  :disabled="currentAlbumPage === albumPageCount - 1"
                  @click="albumPage = currentAlbumPage + 1"
                >
                  <i class="ph ph-arrow-right" aria-hidden="true"></i>
                </button>
              </div>
              <button
                type="button"
                class="sf-text-link"
                @click="emit('select-view', 'albums', null)"
              >
                全部专辑<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div v-if="visibleAlbums.length" class="sf-album-grid">
            <button
              v-for="(album, index) in visibleAlbums"
              :key="album.key"
              type="button"
              class="sf-album"
              :aria-label="'打开专辑：' + album.name + '，' + album.artist"
              @click="emit('open-album', currentAlbumPage * 4 + index)"
            >
              <div class="sf-album-art">
                <SoundFieldArtwork
                  :cover="album.cover"
                  :cover-source="album.coverSource"
                  :identity="album.identity"
                  :title="album.name"
                /><span class="sf-album-open" aria-hidden="true"
                  ><i class="ph ph-arrow-up-right"></i
                ></span>
              </div>
              <div class="sf-album-meta">
                <span>{{ String(currentAlbumPage * 4 + index + 1).padStart(2, '0') }}</span
                ><span>{{ album.trackCount }} TRACKS</span>
              </div>
              <strong :title="album.name">{{ album.name }}</strong
              ><small :title="album.artist">{{ album.artist }}</small>
            </button>
          </div>
          <div v-else class="sf-empty-albums">
            <i class="ph ph-disc" aria-hidden="true"></i>
            <div>
              <h3>留一个位置，给喜欢的专辑。</h3>
              <p>你的音乐收藏，从这里开始。</p>
            </div>
            <button type="button" class="sf-text-link" @click="emit('open-library-settings')">
              添加音乐<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
            </button>
          </div>
        </section>

        <section class="sf-activity" aria-labelledby="sf-activity-title">
          <div class="sf-section-head">
            <div class="sf-section-title">
              <span class="sf-index">02</span>
              <h2 id="sf-activity-title">聆听轨迹</h2>
              <span class="sf-section-en">ON REPEAT</span>
            </div>
            <button type="button" class="sf-text-link" @click="openActivity">
              查看全部<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
            </button>
          </div>
          <div class="sf-activity-toolbar">
            <div class="sf-tabs" role="tablist" aria-label="曲目来源">
              <button
                id="sf-tab-recent"
                type="button"
                role="tab"
                :aria-selected="activity === 'recent'"
                aria-controls="sf-track-panel"
                :tabindex="activity === 'recent' ? 0 : -1"
                @click="activity = 'recent'"
                @keydown="selectTab"
              >
                最近收听<span>{{ recent.length }}</span>
              </button>
              <button
                id="sf-tab-added"
                type="button"
                role="tab"
                :aria-selected="activity === 'added'"
                aria-controls="sf-track-panel"
                :tabindex="activity === 'added' ? 0 : -1"
                @click="activity = 'added'"
                @keydown="selectTab"
              >
                新近入库<span>{{ added.length }}</span>
              </button>
            </div>
            <span class="sf-list-caption">YOUR DAILY ROTATION</span>
          </div>
          <div
            id="sf-track-panel"
            class="sf-track-panel"
            role="tabpanel"
            :aria-labelledby="'sf-tab-' + activity"
            tabindex="0"
          >
            <div v-if="visibleTracks.length" class="sf-track-list">
              <div class="sf-track-labels" aria-hidden="true">
                <span>#</span><span>曲目 / 艺术家</span><span>专辑</span><span>时长</span
                ><span></span>
              </div>
              <button
                v-for="(track, index) in visibleTracks"
                :key="track.id"
                type="button"
                class="sf-track"
                :class="{ 'is-current': track.id === currentTrackId }"
                :aria-label="
                  (track.id === currentTrackId && isPlaying ? '暂停：' : '播放：') +
                  track.title +
                  '，' +
                  track.artist
                "
                @click="emit('play', track)"
              >
                <span class="sf-track-index"
                  ><i
                    v-if="track.id === currentTrackId && isPlaying"
                    class="ph ph-waveform"
                    aria-hidden="true"
                  ></i
                  ><template v-else>{{
                    String(currentTrackPage * 5 + index + 1).padStart(2, '0')
                  }}</template></span
                >
                <span class="sf-track-identity"
                  ><SoundFieldArtwork
                    :cover="track.cover"
                    :cover-source="track.coverSource"
                    :identity="track.id"
                    :title="track.title"
                  /><span
                    ><strong :title="track.title">{{ track.title }}</strong
                    ><small :title="track.artist">{{ track.artist }}</small></span
                  ></span
                >
                <span class="sf-track-album" :title="track.album">{{
                  track.album || '未知专辑'
                }}</span>
                <span class="sf-track-duration">{{ formatTime(track.duration) }}</span>
                <i
                  :class="track.id === currentTrackId && isPlaying ? 'ph ph-pause' : 'ph ph-play'"
                  class="sf-track-action"
                  aria-hidden="true"
                ></i>
              </button>
            </div>
            <div v-else class="sf-empty-tracks">
              <i class="ph ph-headphones" aria-hidden="true"></i>
              <p>{{ activity === 'recent' ? '还没有收听记录' : '音乐库里还没有曲目' }}</p>
              <button
                v-if="summary.tracks"
                type="button"
                class="sf-text-link"
                @click="emit('shuffle')"
              >
                开始聆听<i class="ph ph-arrow-up-right" aria-hidden="true"></i></button
              ><button
                v-else
                type="button"
                class="sf-text-link"
                @click="emit('open-library-settings')"
              >
                添加音乐<i class="ph ph-arrow-up-right" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div v-if="trackPageCount > 1" class="sf-track-paging">
            <span aria-live="polite"
              >{{ String(currentTrackPage + 1).padStart(2, '0') }} /
              {{ String(trackPageCount).padStart(2, '0') }}</span
            >
            <div class="sf-pagination">
              <button
                type="button"
                title="上一页曲目"
                aria-label="上一页曲目"
                :disabled="currentTrackPage === 0"
                @click="trackPage = currentTrackPage - 1"
              >
                <i class="ph ph-arrow-left" aria-hidden="true"></i></button
              ><button
                type="button"
                title="下一页曲目"
                aria-label="下一页曲目"
                :disabled="currentTrackPage === trackPageCount - 1"
                @click="trackPage = currentTrackPage + 1"
              >
                <i class="ph ph-arrow-right" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </section>

        <footer class="sf-collection" aria-label="音乐库一览">
          <div class="sf-collection-label">
            <i class="ph ph-stack" aria-hidden="true"></i
            ><span>你的音乐宇宙<small>THE COLLECTION</small></span>
          </div>
          <button type="button" @click="emit('select-view', 'allSongs', null)">
            <strong>{{ summary.tracks.toLocaleString('zh-CN') }}</strong
            ><span>首曲目<i class="ph ph-arrow-up-right" aria-hidden="true"></i></span>
          </button>
          <button type="button" @click="emit('select-view', 'albums', null)">
            <strong>{{ summary.albums.toLocaleString('zh-CN') }}</strong
            ><span>张专辑<i class="ph ph-arrow-up-right" aria-hidden="true"></i></span>
          </button>
          <button type="button" @click="emit('select-view', 'artists', null)">
            <strong>{{ summary.artists.toLocaleString('zh-CN') }}</strong
            ><span>位艺术家<i class="ph ph-arrow-up-right" aria-hidden="true"></i></span>
          </button>
          <div class="sf-collection-duration">
            <strong>{{ collectionTime.value }}</strong
            ><span>{{ collectionTime.unit }}</span>
          </div>
        </footer>
      </div>
    </div>
  </main>
</template>

<style scoped src="./SoundFieldHome.css"></style>
