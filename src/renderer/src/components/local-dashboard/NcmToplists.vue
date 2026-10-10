<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, onScopeDispose, ref, watch } from 'vue'
import CoverImg from '../CoverImg.vue'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useEscapeToClose, useFocusTrap } from '@renderer/app/useDismissLayer'
import type { MediaProviderToplistSummary } from '@renderer/providers/mediaProvider'
import type { Track } from '@renderer/types/music'
import { friendlyStreamingError } from '../streaming-page/friendlyStreamingError'
import { useNcmToplists } from './useNcmToplists'

const emit = defineEmits<{ login: [] }>()
const providerStore = useProviderStore()
const player = usePlayerStore()
const { currentTrack, isPlaying } = player
const {
  available,
  charts,
  featured,
  loading,
  error,
  selected,
  tracks,
  detailLoading,
  detailError,
  reload,
  open,
  close
} = useNcmToplists(providerStore)
const expanded = ref(false)
const visibleCharts = computed(() => (expanded.value ? charts.value : featured.value))
const dialog = ref<HTMLElement | null>(null)
const dialogOpen = computed(() => selected.value !== null)
const actionError = ref('')
const pendingPlay = ref(false)
let actionRevision = 0
onScopeDispose(() => {
  actionRevision += 1
})

function closeDialog(): void {
  actionRevision += 1
  pendingPlay.value = false
  actionError.value = ''
  close()
}
useEscapeToClose(dialogOpen, closeDialog)
useFocusTrap(dialog, dialogOpen)
watch(
  available,
  () => {
    actionRevision += 1
    pendingPlay.value = false
    expanded.value = false
    actionError.value = ''
  },
  { flush: 'sync' }
)

function playing(track: Track): boolean {
  return currentTrack.value?.id === track.id && isPlaying.value
}
function duration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}
function updated(chart: MediaProviderToplistSummary): string {
  if (chart.updateFrequency) return chart.updateFrequency
  if (!chart.updatedAt) return '网易云音乐'
  const date = new Date(chart.updatedAt)
  return Number.isNaN(date.getTime())
    ? '网易云音乐'
    : `${date.getMonth() + 1}月${date.getDate()}日更新`
}

async function play(track: Track, queue = tracks.value, replaceQueue = false): Promise<void> {
  const request = ++actionRevision
  actionError.value = ''
  pendingPlay.value = true
  try {
    if (!replaceQueue && currentTrack.value?.id === track.id) {
      player.togglePlay()
      return
    }
    const state = await providerStore.checkLogin('ncm')
    if (request !== actionRevision || !available.value || !dialogOpen.value) return
    if (!state.loggedIn) {
      closeDialog()
      emit('login')
      return
    }
    player.playTrack(track, queue)
  } catch (cause) {
    if (request === actionRevision)
      actionError.value = friendlyStreamingError(cause, '暂时无法播放，请稍后重试')
  } finally {
    if (request === actionRevision) pendingPlay.value = false
  }
}

function playAll(): void {
  if (tracks.value[0]) void play(tracks.value[0], tracks.value, true)
}

async function openChart(chart: MediaProviderToplistSummary, autoplay = false): Promise<void> {
  const request = ++actionRevision
  actionError.value = ''
  pendingPlay.value = false
  const queue = await open(chart)
  if (request === actionRevision && autoplay && queue?.length) await play(queue[0], queue, true)
}
</script>

<template>
  <section v-if="available" class="ncm-toplists" aria-label="网易云排行榜" :aria-busy="loading">
    <header class="toplists-heading">
      <div class="toplists-heading-copy">
        <span class="toplists-eyebrow"
          ><i class="ph ph-chart-line-up" aria-hidden="true"></i> NETEASE CLOUD MUSIC</span
        >
        <h2>网易云排行榜</h2>
        <p>听见此刻，正在流行的好音乐。</p>
      </div>
      <div class="toplists-heading-actions">
        <button
          class="toplists-icon-button"
          type="button"
          :disabled="loading"
          aria-label="刷新网易云排行榜"
          @click="reload()"
        >
          <i :class="loading ? 'ph ph-hourglass' : 'ph ph-arrow-clockwise'" aria-hidden="true"></i>
        </button>
        <button
          v-if="charts.length > featured.length"
          class="toplists-text-button"
          type="button"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起榜单' : '全部榜单' }}
          <i :class="expanded ? 'ph ph-caret-up' : 'ph ph-arrow-up-right'" aria-hidden="true"></i>
        </button>
      </div>
    </header>

    <div v-if="error" class="toplists-notice" role="status">
      <span>{{ error }}</span
      ><button class="toplists-text-button" type="button" :disabled="loading" @click="reload()">
        重试
      </button>
    </div>
    <span v-if="loading" class="toplists-sr-only" role="status">{{
      charts.length ? '正在刷新排行榜' : '正在加载排行榜'
    }}</span>
    <div v-if="loading && !charts.length" class="toplists-grid" aria-hidden="true">
      <div v-for="index in 4" :key="index" class="toplist-card toplist-skeleton">
        <div class="toplist-card-heading">
          <span class="toplist-art"></span
          ><span class="toplist-heading-copy"><span></span><span></span></span>
        </div>
        <div v-for="rank in 3" :key="rank" class="toplist-skeleton-line"></div>
      </div>
    </div>
    <div v-else-if="charts.length" class="toplists-grid">
      <article v-for="chart in visibleCharts" :key="chart.id" class="toplist-card">
        <button
          class="toplist-card-heading"
          type="button"
          :aria-label="`查看${chart.name}`"
          @click="openChart(chart)"
        >
          <span class="toplist-art"
            ><CoverImg
              :cover="chart.coverSmall || chart.cover"
              :cover-source="chart.coverSmallSource || chart.coverSource"
              :identity="`ncm-chart:${chart.id}`"
              alt=""
              ><template #placeholder
                ><i class="ph ph-chart-bar" aria-hidden="true"></i></template></CoverImg
          ></span>
          <span class="toplist-heading-copy"
            ><strong :title="chart.name">{{ chart.name }}</strong
            ><small>{{ updated(chart) }}</small></span
          >
          <i class="ph ph-arrow-up-right toplist-open-icon" aria-hidden="true"></i>
        </button>
        <ol
          v-if="chart.previewTracks.length"
          class="toplist-preview"
          :aria-label="`${chart.name}前三首`"
        >
          <li v-for="(track, index) in chart.previewTracks" :key="index">
            <span class="toplist-rank" :class="{ 'is-first': index === 0 }">{{
              String(index + 1).padStart(2, '0')
            }}</span>
            <span class="toplist-preview-copy"
              ><strong :title="track.title">{{ track.title }}</strong
              ><small :title="track.artist">{{ track.artist }}</small></span
            >
          </li>
        </ol>
        <p v-else class="toplist-description">
          {{ chart.description || '打开榜单，发现更多好音乐。' }}
        </p>
        <footer class="toplist-card-footer">
          <span>{{ chart.trackCount ? `${chart.trackCount} 首歌曲` : '精选榜单' }}</span>
          <button
            class="toplist-play-button"
            type="button"
            :aria-label="`播放${chart.name}`"
            @click="openChart(chart, true)"
          >
            <PlaybackIcon name="play" aria-hidden="true" /><span>播放榜单</span>
          </button>
        </footer>
      </article>
    </div>
    <div v-else-if="!error" class="toplists-empty" role="status">
      暂时没有榜单，稍后再来看看。<button
        class="toplists-text-button"
        type="button"
        @click="reload()"
      >
        重新加载
      </button>
    </div>

    <Teleport to="body">
      <div v-if="selected" class="toplists-backdrop" @click.self="closeDialog">
        <section
          ref="dialog"
          class="toplists-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="toplists-dialog-title"
          tabindex="-1"
        >
          <header class="toplists-dialog-heading">
            <span class="toplists-dialog-cover"
              ><CoverImg :cover="selected.cover" :cover-source="selected.coverSource" alt=""
                ><template #placeholder
                  ><i class="ph ph-chart-bar" aria-hidden="true"></i></template></CoverImg
            ></span>
            <div class="toplists-dialog-copy">
              <span class="toplists-eyebrow">网易云排行榜 · {{ updated(selected) }}</span>
              <h2 id="toplists-dialog-title">{{ selected.name }}</h2>
              <p>{{ selected.description || '跟着榜单，发现好音乐。' }}</p>
            </div>
            <button
              class="toplists-icon-button toplists-close"
              type="button"
              aria-label="关闭排行榜"
              @click="closeDialog"
            >
              <i class="ph ph-x" aria-hidden="true"></i>
            </button>
          </header>
          <div class="toplists-dialog-toolbar">
            <span>{{ tracks.length ? `共 ${tracks.length} 首歌曲` : '榜单歌曲' }}</span
            ><button
              class="toplist-play-button"
              type="button"
              :disabled="!tracks.length || detailLoading || pendingPlay"
              @click="playAll"
            >
              <i v-if="pendingPlay" class="ph ph-hourglass" aria-hidden="true"></i
              ><PlaybackIcon v-else name="play" aria-hidden="true" />{{
                pendingPlay ? '正在准备…' : '播放全部'
              }}
            </button>
          </div>
          <div v-if="detailError || actionError" class="toplists-notice" role="status">
            <span>{{ actionError || detailError }}</span
            ><button
              v-if="detailError"
              class="toplists-text-button"
              type="button"
              :disabled="detailLoading"
              @click="openChart(selected)"
            >
              重试
            </button>
          </div>
          <div class="toplists-song-list" :aria-busy="detailLoading">
            <div v-if="detailLoading" class="toplists-detail-loading" role="status">
              <i class="ph ph-hourglass" aria-hidden="true"></i> 正在加载榜单歌曲…
            </div>
            <ol v-else aria-label="榜单歌曲">
              <li v-for="(track, index) in tracks" :key="track.id">
                <button
                  class="toplist-song"
                  :class="{ 'is-current': currentTrack?.id === track.id }"
                  type="button"
                  :disabled="pendingPlay"
                  :aria-label="`${playing(track) ? '暂停' : '播放'} ${track.title}`"
                  @click="play(track)"
                >
                  <span class="toplist-rank" :class="{ 'is-first': index < 3 }">{{
                    String(index + 1).padStart(2, '0')
                  }}</span>
                  <span class="toplist-song-cover"
                    ><CoverImg
                      :cover="track.coverSmall || track.cover"
                      :cover-source="track.coverSmallSource || track.coverSource"
                      :identity="track.id"
                      alt=""
                      ><template #placeholder
                        ><i class="ph ph-music-note" aria-hidden="true"></i></template></CoverImg
                  ></span>
                  <span class="toplist-preview-copy"
                    ><strong :title="track.title">{{ track.title }}</strong
                    ><small :title="track.artist">{{ track.artist }}</small></span
                  >
                  <span class="toplist-song-duration">{{ duration(track.duration) }}</span
                  ><PlaybackIcon :name="playing(track) ? 'pause' : 'play'" aria-hidden="true" />
                </button>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped src="./NcmToplists.css"></style>
