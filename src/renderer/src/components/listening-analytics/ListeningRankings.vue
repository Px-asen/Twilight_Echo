<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, ref } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import type {
  ListeningArtistStat,
  ListeningTrackStat
} from '@renderer/stores/useListeningStatsStore'
import type { Track } from '@renderer/types/music'
import { formatListeningDuration } from '@renderer/components/listening-analytics/listeningAnalyticsData'

const props = defineProps<{
  tracks: Array<ListeningTrackStat & { id: string; resolvedTrack: Track | null }>
  artists: ListeningArtistStat[]
  sort: 'seconds' | 'plays'
  currentTrack: Track | null
  navigableArtists: Set<string>
  canPlayList: boolean
}>()
const emit = defineEmits<{
  'update:sort': [sort: 'seconds' | 'plays']
  play: [track: Track]
  'play-list': []
  'open-artist': [artist: ListeningArtistStat]
}>()
const tab = ref<'tracks' | 'artists'>('tracks')
const expanded = ref(false)
const visibleTracks = computed(() => props.tracks.slice(0, expanded.value ? 10 : 5))
const visibleArtists = computed(() => props.artists.slice(0, expanded.value ? 10 : 5))
const count = computed(() => (tab.value === 'tracks' ? props.tracks.length : props.artists.length))
const leaderValue = computed(() =>
  props.sort === 'seconds' ? props.tracks[0]?.seconds : props.tracks[0]?.plays
)

function share(value: number, max: number | undefined): string {
  return `${max && max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0}%`
}

function isCurrent(track: Track | null): boolean {
  return (
    !!track &&
    track.id === props.currentTrack?.id &&
    (track.source ?? 'local') === (props.currentTrack?.source ?? 'local')
  )
}
</script>

<template>
  <section class="an-panel rankings-panel" aria-labelledby="rankings-title">
    <header class="an-section-head">
      <div>
        <span class="an-eyebrow">02 / ON REPEAT</span>
        <h2 id="rankings-title">反复回响</h2>
      </div>
      <button
        v-if="tab === 'tracks'"
        class="an-icon-button ranking-play-all"
        type="button"
        :disabled="!canPlayList"
        aria-label="播放榜单中可用的曲目"
        title="播放榜单中可用的曲目"
        @click="emit('play-list')"
      >
        <PlaybackIcon name="play" aria-hidden="true" />
      </button>
    </header>
    <div class="ranking-controls">
      <div class="ranking-tabs" aria-label="累计榜单类型">
        <button type="button" :aria-pressed="tab === 'tracks'" @click="tab = 'tracks'">歌曲</button
        ><button type="button" :aria-pressed="tab === 'artists'" @click="tab = 'artists'">
          艺人
        </button>
      </div>
      <label v-if="tab === 'tracks'" class="ranking-sort"
        ><span class="an-sr-only">歌曲榜单排序</span
        ><select
          :value="sort"
          @change="
            emit('update:sort', ($event.target as HTMLSelectElement).value as 'seconds' | 'plays')
          "
        >
          <option value="seconds">按聆听时长</option>
          <option value="plays">按播放次数</option></select
        ><i class="ph ph-caret-down" aria-hidden="true"></i
      ></label>
      <span v-else class="ranking-order-label">按播放次数</span>
    </div>
    <ol v-if="tab === 'tracks'" class="ranking-list" aria-label="歌曲累计排行榜">
      <li
        v-for="(track, index) in visibleTracks"
        :key="track.id"
        :class="{ 'is-leading': index === 0, 'is-current': isCurrent(track.resolvedTrack) }"
      >
        <button
          type="button"
          class="ranking-row"
          :disabled="!track.resolvedTrack"
          :title="
            track.resolvedTrack
              ? `${track.title} · ${track.artist} · ${formatListeningDuration(track.seconds)} · ${track.plays} 次`
              : `${track.title} · 音源暂不可用`
          "
          @click="track.resolvedTrack && emit('play', track.resolvedTrack)"
        >
          <span class="ranking-position">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="ranking-art"
            ><CoverImg
              :cover="track.cover"
              :cover-source="track.coverSource"
              :identity="track.id"
              fallback="./icon.png"
              alt="" /><span
              v-if="track.resolvedTrack"
              class="ranking-play-overlay"
              aria-hidden="true"
              ><i v-if="isCurrent(track.resolvedTrack)" class="ph ph-speaker-high"></i
              ><PlaybackIcon v-else name="play" /></span
          ></span>
          <span class="ranking-meta"
            ><strong>{{ track.title }}</strong
            ><span>{{ track.artist }}</span
            ><span v-if="!track.resolvedTrack" class="ranking-unavailable">音源暂不可用</span
            ><span class="ranking-meter" aria-hidden="true"
              ><i
                :style="{
                  width: share(sort === 'seconds' ? track.seconds : track.plays, leaderValue)
                }"
              ></i></span
          ></span>
          <span class="ranking-value"
            ><strong>{{
              sort === 'seconds'
                ? formatListeningDuration(track.seconds)
                : `${track.plays.toLocaleString('zh-CN')} 次`
            }}</strong
            ><small>{{
              sort === 'seconds'
                ? `${track.plays.toLocaleString('zh-CN')} 次播放`
                : formatListeningDuration(track.seconds)
            }}</small></span
          >
        </button>
      </li>
    </ol>
    <ol v-else class="ranking-list" aria-label="艺人累计排行榜">
      <li
        v-for="(artist, index) in visibleArtists"
        :key="artist.id"
        :class="{ 'is-leading': index === 0 }"
      >
        <button
          class="ranking-row"
          type="button"
          :disabled="!navigableArtists.has(artist.name.trim())"
          :title="`${artist.name} · ${artist.plays} 次 · ${formatListeningDuration(artist.seconds)}${navigableArtists.has(artist.name.trim()) ? '' : ' · 艺人页面暂不可用'}`"
          @click="emit('open-artist', artist)"
        >
          <span class="ranking-position">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="ranking-art artist-art"
            ><CoverImg
              :cover="artist.cover"
              :cover-source="artist.coverSource"
              :identity="artist.id"
              fallback="./icon.png"
              alt=""
          /></span>
          <span class="ranking-meta"
            ><strong>{{ artist.name }}</strong
            ><span>{{ artist.trackCount }} 首作品</span
            ><span class="ranking-meter" aria-hidden="true"
              ><i :style="{ width: share(artist.plays, artists[0]?.plays) }"></i></span
          ></span>
          <span class="ranking-value"
            ><strong>{{ artist.plays.toLocaleString('zh-CN') }} 次</strong
            ><small>{{ formatListeningDuration(artist.seconds) }}</small></span
          >
        </button>
      </li>
    </ol>
    <div v-if="!count" class="ranking-empty">
      <i class="ph ph-music-notes" aria-hidden="true"></i>
      <p>喜欢，会在一次次播放中浮现。</p>
    </div>
    <button
      v-if="count > 5"
      type="button"
      class="ranking-expand"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? '收起榜单' : `展开前 ${count} 名` }}</span
      ><i :class="expanded ? 'ph ph-caret-up' : 'ph ph-caret-down'" aria-hidden="true"></i>
    </button>
    <div class="ranking-footnote">
      <span class="ranking-footnote-line"></span><i class="ph ph-infinity" aria-hidden="true"></i
      ><span>现存记录累计</span><span class="ranking-footnote-line"></span>
    </div>
    <p class="an-scope-note">不随左侧时长范围变化，喜欢不必局限于最近。</p>
  </section>
</template>

<style scoped>
.rankings-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.rankings-panel .ranking-play-all {
  border-radius: 50%;
  background: var(--an-ink);
  color: var(--an-surface);
  border-color: transparent;
}
.rankings-panel .ranking-play-all:hover:not(:disabled) {
  background: var(--an-secondary);
}
.ranking-play-all :is(i, .playback-icon) {
  color: inherit;
}
.ranking-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--an-line);
}
.ranking-tabs {
  display: flex;
  gap: 18px;
}
.ranking-tabs button {
  position: relative;
  padding: 4px 0;
  font-size: 13px;
  color: var(--an-muted);
}
.ranking-tabs button[aria-pressed='true'] {
  color: var(--an-ink);
  font-weight: 650;
}
.ranking-tabs button[aria-pressed='true']::after {
  content: '';
  position: absolute;
  bottom: -15px;
  height: 2px;
  background: var(--an-ink);
  left: 0;
  right: 0;
}
.ranking-sort {
  display: flex;
  align-items: center;
  position: relative;
}
.ranking-sort select {
  appearance: none;
  font: inherit;
  font-size: 12px;
  color: var(--an-secondary);
  border: 0;
  background: transparent;
  padding: 8px 18px 8px 6px;
  cursor: pointer;
}
.ranking-sort select option {
  background: var(--an-surface);
  color: var(--an-ink);
}
.ranking-sort i {
  position: absolute;
  right: 0;
  pointer-events: none;
  font-size: 11px;
  color: var(--an-muted);
}
.ranking-order-label {
  font-size: 12px;
  color: var(--an-muted);
}
.ranking-list {
  list-style: none;
  margin: 14px -10px 0;
  padding: 0;
}
.ranking-list > li {
  border-radius: 10px;
}
.ranking-list > li + li {
  margin-top: 6px;
}
.ranking-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 10px;
  border-radius: 10px;
  text-align: left;
}
.ranking-row:hover:not(:disabled) {
  background: var(--an-soft);
}
.ranking-row:disabled {
  cursor: default;
}
.ranking-position {
  flex-shrink: 0;
  font-size: 12px;
  width: 17px;
  font-variant-numeric: tabular-nums;
  color: var(--an-muted);
}
.is-leading .ranking-position {
  color: var(--an-ink);
  font-weight: 700;
}
.ranking-art {
  width: 46px;
  height: 46px;
  flex: 0 0 46px;
  position: relative;
  border-radius: 7px;
  overflow: hidden;
  box-shadow: 0 2px 5px var(--an-shadow);
}
.ranking-art :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.artist-art {
  border-radius: 50%;
}
.ranking-play-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--an-art-shade);
  color: var(--an-art-ink);
  opacity: 0;
}
.ranking-row:hover .ranking-play-overlay,
.ranking-row:focus-visible .ranking-play-overlay,
.is-current .ranking-play-overlay {
  opacity: 1;
}
.ranking-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ranking-meta > strong {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ranking-meta > span:not(.ranking-meter) {
  font-size: 12px;
  color: var(--an-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ranking-meta .ranking-unavailable {
  font-size: 11px;
}
.ranking-meter {
  height: 3px;
  margin-top: 3px;
  max-width: 140px;
  display: block;
  background: var(--an-soft);
}
.ranking-meter i {
  display: block;
  height: 100%;
  border-radius: 0 2px 2px 0;
  background: var(--an-accent);
}
.ranking-value {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: flex-end;
  max-width: 120px;
}
.ranking-value strong {
  font-size: 12px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}
.ranking-value small {
  font-size: 11px;
  color: var(--an-muted);
}
.ranking-expand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  margin-top: 10px;
  border: 1px solid var(--an-line);
  border-radius: 8px;
  font-size: 12px;
  color: var(--an-secondary);
}
.ranking-expand:hover {
  background: var(--an-soft);
}
.ranking-footnote {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 32px;
  margin-top: auto;
  font-size: 11px;
  color: var(--an-muted);
}
.ranking-footnote i {
  font-size: 16px;
}
.ranking-footnote-line {
  height: 1px;
  background: var(--an-line);
  flex: 1;
}
.rankings-panel > .an-scope-note {
  text-align: center;
}
.ranking-empty {
  padding: 50px 0;
  text-align: center;
  color: var(--an-muted);
}
.ranking-empty > i {
  font-size: 32px;
}
.ranking-empty p {
  font-size: 12px;
}
@container listening-journal (max-width: 420px) {
  .ranking-row {
    gap: 8px;
  }
  .ranking-value {
    max-width: 88px;
  }
  .ranking-value strong {
    font-size: 11px;
  }
  .ranking-art {
    width: 40px;
    height: 40px;
    flex-basis: 40px;
  }
}
@media (forced-colors: active) {
  .ranking-meter i {
    background: Highlight;
  }
}
</style>
