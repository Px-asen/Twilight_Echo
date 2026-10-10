<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import {
  getMostListenedTracks,
  getTopArtists,
  getTopTracks,
  useListeningStatsStore,
  type ListeningArtistStat
} from '@renderer/stores/useListeningStatsStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { createUnifiedRecentTrackResolver } from '@renderer/utils/unifiedRecentTracks'
import CoverImg from '@renderer/components/CoverImg.vue'
import ListeningRhythm from '@renderer/components/listening-analytics/ListeningRhythm.vue'
import ListeningRankings from '@renderer/components/listening-analytics/ListeningRankings.vue'
import ListeningFootprint from '@renderer/components/listening-analytics/ListeningFootprint.vue'
import ListeningStatsClearDialog from '@renderer/components/listening-analytics/ListeningStatsClearDialog.vue'
import type { ListeningStatsClearRange } from '@renderer/stores/listeningStatsHistory'
import {
  formatListeningDuration,
  listeningDurationParts,
  summarizeRecordedTracks,
  utcDayKey
} from '@renderer/components/listening-analytics/listeningAnalyticsData'
import type { Track } from '@renderer/types/music'

const emit = defineEmits<{
  (event: 'select-view', category: string, filter: string | null): void
  (event: 'open-artist', request: { name: string; providerId: string }): void
}>()

const { tracks: libraryTracks, artists: libraryArtists } = useMusicStore()
const { listeningStats, persistenceStatus, clearListeningStats } = useListeningStatsStore()
const { currentTrack, playTrack } = usePlayerStore()
const now = ref(new Date())
const sort = ref<'seconds' | 'plays'>('seconds')
const showFormatTable = ref(false)
const showClearDialog = ref(false)
const clearingStats = ref(false)
const clearNotice = ref('')
const clearActivity = computed(() => ({ ...listeningStats.value }))
let dayTimer: ReturnType<typeof setInterval> | undefined

function refreshDay(): void {
  const next = new Date()
  if (utcDayKey(next) !== utcDayKey(now.value)) now.value = next
}

onMounted(() => {
  dayTimer = setInterval(refreshDay, 60_000)
  document.addEventListener('visibilitychange', refreshDay)
})
onBeforeUnmount(() => {
  clearInterval(dayTimer)
  document.removeEventListener('visibilitychange', refreshDay)
})

const activity = computed(() => ({ days: listeningStats.value.days }))
const recorded = computed(() => summarizeRecordedTracks(listeningStats.value.tracks))
const totalDuration = computed(() => listeningDurationParts(recorded.value.seconds))
const hasHistory = computed(() => {
  if (recorded.value.trackCount > 0) return true
  for (const seconds of Object.values(listeningStats.value.days)) {
    if (Number.isFinite(seconds) && seconds > 0) return true
  }
  return false
})
const mostListened = computed(() => getMostListenedTracks(10))
const resolveTrack = computed(() => createUnifiedRecentTrackResolver(libraryTracks.value))
const favorite = computed(() => {
  const stat = mostListened.value[0]
  if (!stat) return null
  const track = resolveTrack.value(stat)
  return {
    ...stat,
    resolvedTrack: track,
    cover: track?.cover ?? stat.cover,
    coverSource: track?.coverSource ?? stat.coverSource
  }
})
const rankedTracks = computed(() =>
  (sort.value === 'seconds' ? mostListened.value : getTopTracks(10)).map((stat) => {
    const track = resolveTrack.value(stat)
    return {
      ...stat,
      resolvedTrack: track,
      cover: track?.cover ?? stat.cover,
      coverSource: track?.coverSource ?? stat.coverSource
    }
  })
)
const rankedArtists = computed(() => getTopArtists(10))
const localArtistNames = computed(() => new Set(libraryArtists.value.map((artist) => artist.name)))
const artistProviders = computed(() => {
  const providers = new Map<string, string>()
  for (const id in listeningStats.value.tracks) {
    const stat = listeningStats.value.tracks[id]
    const name = stat.artist.trim()
    if (providers.has(name)) continue
    const provider = stat.sourceIds?.find(
      (entry) => entry.source && entry.source !== 'local'
    )?.source
    if (provider) providers.set(name, provider)
  }
  return providers
})
const navigableArtists = computed(() => {
  const names = new Set(localArtistNames.value)
  for (const name of artistProviders.value.keys()) names.add(name)
  return names
})
const playableRanking = computed(() => {
  const tracks: Track[] = []
  for (const entry of rankedTracks.value) if (entry.resolvedTrack) tracks.push(entry.resolvedTrack)
  return tracks
})

function playDashboardTrack(track: Track): void {
  const sourceIndex =
    track.source && track.source !== 'local'
      ? -1
      : libraryTracks.value.findIndex((item) => item.id === track.id)
  if (sourceIndex < 0) {
    playTrack(track, [track])
    return
  }
  const end = Math.min(libraryTracks.value.length, Math.max(0, sourceIndex - 100) + 200)
  playTrack(track, libraryTracks.value.slice(Math.max(0, end - 200), end))
}

function playRanking(): void {
  const tracks = playableRanking.value
  if (tracks.length) playTrack(tracks[0], tracks)
}

function openArtist(artist: ListeningArtistStat): void {
  const name = artist.name.trim()
  if (localArtistNames.value.has(name)) {
    emit('select-view', 'artists', `artist:${name}`)
    return
  }
  const providerId = artistProviders.value.get(name)
  if (providerId) emit('open-artist', { name, providerId })
}

async function clearStats(range: ListeningStatsClearRange): Promise<void> {
  if (clearingStats.value) return
  clearingStats.value = true
  try {
    const saved = await clearListeningStats(range)
    showClearDialog.value = false
    clearNotice.value = !saved
      ? '记录已清除，保存失败，应用会自动重试。'
      : range
        ? `已清除 ${range.startDay} 至 ${range.endDay} 的每日记录及对应曲目明细。`
        : '已清除全部统计数据。'
  } finally {
    clearingStats.value = false
  }
}
</script>

<template>
  <main class="analytics-page" aria-label="统计仪表盘">
    <div class="analytics-journal">
      <header class="journal-header">
        <div>
          <h1>听歌统计<span class="journal-title-dot">.</span></h1>
        </div>
        <div class="journal-header-tools">
          <div class="journal-edition">
            <span>{{ now.getUTCFullYear() }}</span>
            <time :datetime="utcDayKey(now)"
              >{{ String(now.getUTCMonth() + 1).padStart(2, '0') }} /
              {{ String(now.getUTCDate()).padStart(2, '0') }}</time
            >
            <small><i class="ph ph-hard-drives" aria-hidden="true"></i> 记录保存在本机</small>
          </div>
          <button
            type="button"
            class="an-button journal-clear"
            :disabled="!hasHistory"
            @click="showClearDialog = true"
          >
            <i class="ph ph-trash" aria-hidden="true"></i> 清除数据
          </button>
        </div>
      </header>

      <p
        v-if="persistenceStatus.dirty && persistenceStatus.failureCount > 0"
        class="journal-notice"
        role="status"
      >
        <i class="ph ph-warning-circle" aria-hidden="true"></i>
        统计数据的更改暂未保存，应用会自动重试。请暂时不要关闭应用。
      </p>
      <p
        v-if="clearNotice && persistenceStatus.failureCount === 0"
        class="journal-notice"
        role="status"
      >
        {{ clearNotice }}
      </p>

      <section v-if="!hasHistory" class="journal-empty" aria-labelledby="journal-empty-title">
        <div class="empty-record" aria-hidden="true">
          <span><i class="ph ph-music-note"></i></span>
        </div>
        <h2 id="journal-empty-title">暂无听歌记录</h2>
        <button
          type="button"
          class="an-button an-button-primary"
          @click="emit('select-view', 'allSongs', null)"
        >
          <PlaybackIcon name="play" aria-hidden="true" /> 去音乐库，听一首
        </button>
        <span class="empty-note">不需要打卡，也没有目标。只管享受音乐。</span>
      </section>

      <template v-else>
        <section class="journal-hero" aria-label="现存聆听记录累计">
          <div class="hero-listening">
            <span class="hero-caption"
              ><i class="ph ph-headphones" aria-hidden="true"></i> 与音乐相处了</span
            >
            <div class="hero-duration" :aria-label="formatListeningDuration(recorded.seconds)">
              <strong>{{ totalDuration.value }}</strong
              ><span>{{ totalDuration.unit }}</span>
            </div>
            <div class="hero-totals">
              <div>
                <strong>{{ recorded.plays.toLocaleString('zh-CN') }}</strong
                ><span>次播放</span>
              </div>
              <span class="hero-divider"></span>
              <div>
                <strong>{{ recorded.trackCount.toLocaleString('zh-CN') }}</strong
                ><span>首留下回响</span>
              </div>
              <span class="hero-record-scope">现存记录累计</span>
            </div>
          </div>
          <div v-if="favorite" class="hero-favorite">
            <div class="favorite-artwork" aria-hidden="true">
              <span class="favorite-vinyl"><span></span></span>
              <div class="favorite-sleeve">
                <CoverImg
                  :cover="favorite.cover"
                  :cover-source="favorite.coverSource"
                  :identity="favorite.id"
                  fallback="./icon.png"
                  alt=""
                />
              </div>
            </div>
            <div class="favorite-copy">
              <span class="an-eyebrow">ON REPEAT / 01</span>
              <span class="favorite-caption">播放最多</span>
              <h2 :title="favorite.title">{{ favorite.title }}</h2>
              <p :title="favorite.artist">{{ favorite.artist }}</p>
              <button
                v-if="favorite.resolvedTrack"
                type="button"
                class="favorite-play"
                :aria-label="`再听一次 ${favorite.title}`"
                @click="playDashboardTrack(favorite.resolvedTrack)"
              >
                <PlaybackIcon name="play" aria-hidden="true" /> 再听一次
                <span>{{ formatListeningDuration(favorite.seconds) }}</span>
              </button>
              <span v-else class="favorite-unavailable">音源暂不可用 · 回响仍在</span>
            </div>
          </div>
          <div v-else class="hero-quiet">
            <i class="ph ph-waveform" aria-hidden="true"></i><span>下一首喜欢的歌，正在路上。</span>
          </div>
        </section>

        <div class="analytics-content-grid">
          <div class="analytics-left-stack">
            <ListeningRhythm :activity="activity" :now="now" />
            <section class="an-panel formats-panel" aria-labelledby="formats-title">
              <header class="an-section-head">
                <div>
                  <span class="an-eyebrow">THE SOUND COLLECTION</span>
                  <h2 id="formats-title">声音的形状</h2>
                </div>
                <button
                  type="button"
                  class="an-icon-button"
                  :aria-expanded="showFormatTable"
                  aria-controls="formats-table"
                  :aria-label="showFormatTable ? '收起格式数据表' : '查看格式数据表'"
                  @click="showFormatTable = !showFormatTable"
                >
                  <i class="ph ph-table" aria-hidden="true"></i>
                </button>
              </header>
              <div class="format-bars" role="list" aria-label="已记录曲目的格式分布">
                <div
                  v-for="format in recorded.formats"
                  :key="format.key"
                  class="format-row"
                  role="listitem"
                  tabindex="0"
                  :aria-label="`${format.label}，${format.count} 首，占 ${format.percent.toFixed(1)}%`"
                  :title="`${format.label} · ${format.count} 首 · ${format.percent.toFixed(1)}%`"
                >
                  <span>{{ format.label }}</span
                  ><span class="format-track" aria-hidden="true"
                    ><i :style="{ width: `${format.percent}%` }"></i></span
                  ><strong>{{ format.count }}<small> 首</small></strong>
                </div>
              </div>
              <p v-if="!recorded.formats.length" class="an-scope-note">还没有可统计的曲目格式</p>
              <div v-if="showFormatTable" id="formats-table" class="an-table-scroll">
                <table>
                  <caption>
                    已记录曲目的格式分布
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">格式</th>
                      <th scope="col">曲目数</th>
                      <th scope="col">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="format in recorded.formats" :key="format.key">
                      <td>{{ format.label }}</td>
                      <td>{{ format.count }}</td>
                      <td>{{ format.percent.toFixed(1) }}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="an-scope-note">按已听曲目快照计数，不代表实际输出音质。</p>
            </section>
          </div>
          <ListeningRankings
            :tracks="rankedTracks"
            :artists="rankedArtists"
            :sort="sort"
            :current-track="currentTrack"
            :navigable-artists="navigableArtists"
            :can-play-list="playableRanking.length > 0"
            @update:sort="sort = $event"
            @play="playDashboardTrack"
            @play-list="playRanking"
            @open-artist="openArtist"
          />
        </div>
        <ListeningFootprint :activity="activity" :now="now" />
      </template>
      <footer class="journal-footer">
        <p>
          汇总本机各音源的聆听记录 · 每日时长保留 730 天，曲目记录最多 10,000 首。<br />累计榜单不随时长范围变化；记录可能因保留策略而不完整。
        </p>
      </footer>
    </div>
    <NativeDialogTransition>
      <ListeningStatsClearDialog
        v-if="showClearDialog"
        :stats="clearActivity"
        :now="now"
        :busy="clearingStats"
        @close="showClearDialog = false"
        @clear="clearStats"
      />
    </NativeDialogTransition>
  </main>
</template>

<style src="./ListeningAnalyticsPage.css"></style>
