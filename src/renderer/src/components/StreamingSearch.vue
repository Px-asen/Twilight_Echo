<script setup lang="ts">
import type { Track, TrackArtistRef } from '../types/music'
import type {
  MediaProviderPlaylistSummary,
  MediaProviderArtistSummary
} from '../providers/mediaProvider'
import type { SearchType } from './streaming-page/useStreamingSearch'
import CoverImg from './CoverImg.vue'

interface PageState {
  first: number
  rows: number
  page: number
  pageCount: number
}

const props = defineProps<{
  searchType: SearchType
  searchResults: Track[]
  searchPlaylistsResults: MediaProviderPlaylistSummary[]
  searchArtistsResults: MediaProviderArtistSummary[]
  searchTotal: number
  searchOffset: number
  searchLoading: boolean
  searchError: string
  currentTrack: Track | null
  trackActivationMode: 'singleClick' | 'doubleClick'
  likingTracks: Set<number>
  isTrackLiked: (id: number | undefined) => boolean
  formatTime: (time: number) => string
  selectedIds?: Set<string>
  hasSelection?: boolean
  selectedCount?: number
  selectionAllFavorited?: boolean
  favoriteLabel?: string
  isTrackFavorited?: (track: Track) => boolean
  canAddToPlaylist?: boolean
  canOpenTrackArtist?: (track: Track, artist?: TrackArtistRef) => boolean
  canOpenTrackAlbum?: (track: Track) => boolean
}>()

const emit = defineEmits<{
  searchTrackClick: [track: Track, event: MouseEvent]
  searchTrackActivate: [track: Track]
  likeTrack: [track: Track, event: MouseEvent]
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  openArtist: [artist: MediaProviderArtistSummary]
  openTrackArtist: [track: Track, artist?: TrackArtistRef]
  openTrackAlbum: [track: Track]
  pageChange: [event: PageState]
  retry: []
  batchFavorite: []
  batchAddToPlaylist: []
  batchDelete: []
  clearSelection: []
  trackContextMenu: [track: Track, index: number, event: MouseEvent]
}>()

const pageSize = 30

function isSelected(trackId: string): boolean {
  return props.selectedIds?.has(trackId) ?? false
}

function emitPage(first: number): void {
  if (props.searchLoading) return
  const lastPageOffset = Math.max(0, Math.ceil(props.searchTotal / pageSize) - 1) * pageSize
  const normalizedFirst = Math.max(
    0,
    Math.min(Math.floor(first / pageSize) * pageSize, lastPageOffset)
  )
  emit('pageChange', {
    first: normalizedFirst,
    rows: pageSize,
    page: Math.floor(normalizedFirst / pageSize),
    pageCount: Math.max(1, Math.ceil(props.searchTotal / pageSize))
  })
}

function onTrackKeydown(event: KeyboardEvent, track: Track): void {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) emit('searchTrackActivate', track)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopPropagation()
    const row = event.currentTarget as HTMLElement
    const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling
    if (next instanceof HTMLElement) next.focus()
  }
}
</script>

<template>
  <div class="search-view">
    <div v-if="searchLoading && searchOffset === 0" class="streaming-placeholder">
      <i
        class="pi pi-spin pi-spinner"
        style="font-size: calc(var(--te-font-size-body, 14px) * 40 / 14); color: #999"
      ></i>
      <p class="placeholder-title">正在搜索</p>
    </div>
    <div v-else-if="searchError" class="streaming-placeholder">
      <i
        class="pi pi-exclamation-triangle"
        style="font-size: calc(var(--te-font-size-body, 14px) * 40 / 14); color: #e74c3c"
      ></i>
      <p class="placeholder-title">搜索失败</p>
      <p class="placeholder-hint">{{ searchError }}</p>
      <button type="button" class="search-action-btn" @click="emit('retry')">重试</button>
    </div>
    <div v-else-if="searchTotal === 0 && !searchLoading" class="streaming-placeholder">
      <i
        class="pi pi-search"
        style="font-size: calc(var(--te-font-size-body, 14px) * 40 / 14); color: #ccc"
      ></i>
      <p class="placeholder-title">无搜索结果</p>
      <p class="placeholder-hint">换个关键词试试吧</p>
    </div>
    <div v-else class="search-results-content">
      <div v-if="searchType === 'songs'" class="detail-content">
        <div class="track-table-wrapper">
          <div v-if="hasSelection" class="selection-toolbar">
            <span class="selection-count">已选择 {{ selectedCount }} 首</span>
            <div class="selection-actions">
              <button type="button" class="selection-btn" @click="emit('batchFavorite')">
                <i :class="selectionAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
                <span>{{
                  favoriteLabel ?? (selectionAllFavorited ? '移出应用收藏' : '加入应用收藏')
                }}</span>
              </button>
              <button
                v-if="canAddToPlaylist"
                type="button"
                class="selection-btn"
                @click="emit('batchAddToPlaylist')"
              >
                <i class="pi pi-list"></i>
                <span>添加到歌单</span>
              </button>
              <button type="button" class="selection-btn danger" @click="emit('batchDelete')">
                <i class="pi pi-trash"></i>
                <span>删除</span>
              </button>
              <button type="button" class="selection-btn ghost" @click="emit('clearSelection')">
                <i class="pi pi-times"></i>
                <span>取消</span>
              </button>
            </div>
          </div>
          <table class="track-table">
            <thead>
              <tr>
                <th class="col-cover-header"></th>
                <th class="col-index">#</th>
                <th class="col-info">标题</th>
                <th class="col-like-header"></th>
                <th class="col-album">专辑</th>
                <th class="col-duration">时长</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(track, index) in searchResults"
                :key="track.id"
                class="track-row"
                data-te-interactive
                tabindex="0"
                :aria-label="`${track.title} · ${track.artist}，按回车播放`"
                @keydown="onTrackKeydown($event, track)"
                :class="{
                  'track-playing': currentTrack?.id === track.id,
                  'track-selected': isSelected(track.id)
                }"
                @click="emit('searchTrackClick', track, $event)"
                @dblclick="
                  trackActivationMode === 'doubleClick' && emit('searchTrackClick', track, $event)
                "
                @contextmenu.prevent="emit('trackContextMenu', track, index, $event)"
              >
                <td class="col-cover">
                  <img v-if="track.cover" :src="track.cover" class="cover-img" alt="cover" />
                  <div v-else class="cover-placeholder">
                    <i
                      class="pi pi-wave-pulse"
                      style="font-size: calc(var(--te-font-size-body, 14px) * 18 / 14); color: #bbb"
                    ></i>
                  </div>
                </td>
                <td class="col-index">
                  <span v-if="currentTrack?.id === track.id" class="playing-indicator">
                    <i
                      class="pi pi-volume-up"
                      style="
                        font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
                        color: #1a73e8;
                      "
                    ></i>
                  </span>
                  <span v-else>{{ index + 1 + searchOffset }}</span>
                </td>
                <td class="col-info">
                  <div class="track-title">{{ track.title }}</div>
                  <div class="track-artist">
                    <template v-if="track.artists?.length">
                      <template v-for="(artist, artistIndex) in track.artists" :key="artistIndex">
                        <span v-if="artistIndex > 0"> / </span>
                        <button
                          v-if="canOpenTrackArtist?.(track, artist)"
                          type="button"
                          class="metadata-link"
                          :title="`查看歌手：${artist.name}`"
                          @click.stop="emit('openTrackArtist', track, artist)"
                          @dblclick.stop
                        >
                          {{ artist.name }}
                        </button>
                        <span v-else>{{ artist.name }}</span>
                      </template>
                    </template>
                    <button
                      v-else-if="canOpenTrackArtist?.(track)"
                      type="button"
                      class="metadata-link"
                      :title="`查看歌手：${track.artist}`"
                      @click.stop="emit('openTrackArtist', track)"
                      @dblclick.stop
                    >
                      {{ track.artist }}
                    </button>
                    <span v-else>{{ track.artist }}</span>
                  </div>
                </td>
                <td class="col-like">
                  <button
                    class="btn-like"
                    :class="{
                      liked: isTrackFavorited?.(track) ?? isTrackLiked(track.ncmSongId),
                      loading: likingTracks.has(track.ncmSongId ?? 0)
                    }"
                    :disabled="likingTracks.has(track.ncmSongId ?? 0)"
                    :title="
                      track.ncmSongId != null
                        ? isTrackLiked(track.ncmSongId)
                          ? '在网易云取消喜欢'
                          : '在网易云喜欢'
                        : isTrackFavorited?.(track)
                          ? '移出应用收藏'
                          : '加入应用收藏'
                    "
                    @click.stop="emit('likeTrack', track, $event)"
                  >
                    <i
                      v-if="likingTracks.has(track.ncmSongId ?? 0)"
                      class="pi pi-spin pi-spinner"
                      style="font-size: calc(var(--te-font-size-body, 14px) * 14 / 14)"
                    ></i>
                    <i
                      v-else
                      :class="isTrackLiked(track.ncmSongId) ? 'pi pi-heart-fill' : 'pi pi-heart'"
                      style="font-size: calc(var(--te-font-size-body, 14px) * 14 / 14)"
                    ></i>
                  </button>
                </td>
                <td class="col-album">
                  <button
                    v-if="canOpenTrackAlbum?.(track)"
                    type="button"
                    class="metadata-link"
                    :title="`查看专辑：${track.album}`"
                    @click.stop="emit('openTrackAlbum', track)"
                    @dblclick.stop
                  >
                    {{ track.album }}
                  </button>
                  <span v-else>{{ track.album }}</span>
                </td>
                <td class="col-duration">{{ formatTime(track.duration) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="searchTotal > 30" class="search-paginator">
          <button
            type="button"
            class="pager-btn"
            :disabled="searchLoading || searchOffset <= 0"
            @click="emitPage(searchOffset - pageSize)"
          >
            上一页
          </button>
          <span class="pager-text">
            {{ Math.floor(searchOffset / pageSize) + 1 }} /
            {{ Math.ceil(searchTotal / pageSize) }}
          </span>
          <button
            type="button"
            class="pager-btn"
            :disabled="searchLoading || searchOffset + pageSize >= searchTotal"
            @click="emitPage(searchOffset + pageSize)"
          >
            下一页
          </button>
        </div>
      </div>
      <div v-else-if="searchType === 'playlists'" class="rec-sections">
        <div class="playlist-grid">
          <button
            v-for="playlist in searchPlaylistsResults"
            :key="playlist.id"
            type="button"
            class="playlist-grid-card"
            data-te-interactive
            @click="emit('openPlaylist', playlist)"
          >
            <CoverImg
              v-if="playlist.cover || playlist.coverSmall"
              :cover="playlist.coverSmall || playlist.cover"
              :cover-source="playlist.coverSmallSource || playlist.coverSource"
              class="playlist-grid-cover"
              alt=""
            />
            <div v-else class="playlist-grid-cover-placeholder">
              <i
                class="pi pi-list"
                style="font-size: calc(var(--te-font-size-body, 14px) * 28 / 14); color: #bbb"
              ></i>
            </div>
            <div class="playlist-grid-name">{{ playlist.name }}</div>
            <div class="playlist-grid-count">{{ playlist.trackCount }} 首</div>
          </button>
        </div>
        <div v-if="searchTotal > 30" class="search-paginator">
          <button
            type="button"
            class="pager-btn"
            :disabled="searchLoading || searchOffset <= 0"
            @click="emitPage(searchOffset - pageSize)"
          >
            上一页
          </button>
          <span class="pager-text">
            {{ Math.floor(searchOffset / pageSize) + 1 }} /
            {{ Math.ceil(searchTotal / pageSize) }}
          </span>
          <button
            type="button"
            class="pager-btn"
            :disabled="searchLoading || searchOffset + pageSize >= searchTotal"
            @click="emitPage(searchOffset + pageSize)"
          >
            下一页
          </button>
        </div>
      </div>
      <div v-else-if="searchType === 'artists'" class="rec-sections">
        <div class="playlist-grid">
          <button
            v-for="artist in searchArtistsResults"
            :key="artist.id"
            type="button"
            class="playlist-grid-card artist-card"
            data-te-interactive
            @click="emit('openArtist', artist)"
          >
            <CoverImg
              v-if="artist.picUrl"
              :cover="artist.picUrl"
              :cover-source="artist.picUrlSource"
              class="playlist-grid-cover artist-cover"
              alt=""
            />
            <div v-else class="playlist-grid-cover-placeholder artist-cover">
              <i
                class="pi pi-user"
                style="font-size: calc(var(--te-font-size-body, 14px) * 28 / 14); color: #bbb"
              ></i>
            </div>
            <div class="playlist-grid-name">{{ artist.name }}</div>
            <div class="playlist-grid-count">{{ artist.musicSize ?? 0 }} 首单曲</div>
          </button>
        </div>
        <div v-if="searchTotal > 30" class="search-paginator">
          <button
            type="button"
            class="pager-btn"
            :disabled="searchLoading || searchOffset <= 0"
            @click="emitPage(searchOffset - pageSize)"
          >
            上一页
          </button>
          <span class="pager-text">
            {{ Math.floor(searchOffset / pageSize) + 1 }} /
            {{ Math.ceil(searchTotal / pageSize) }}
          </span>
          <button
            type="button"
            class="pager-btn"
            :disabled="searchLoading || searchOffset + pageSize >= searchTotal"
            @click="emitPage(searchOffset + pageSize)"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  padding-bottom: 32px;
}

.streaming-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  border-radius: 20px;
  background: var(--te-glass-bg);
  border: 1px solid rgba(255, 255, 255, 0.58);
  box-shadow: 0 20px 70px rgba(86, 70, 160, 0.12);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
}

.placeholder-title {
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
  font-weight: 600;
  color: var(--te-neutral-900);
  margin-top: 16px;
}

.placeholder-hint {
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  color: #999;
  margin-top: 8px;
  margin-bottom: 24px;
}

.search-results-content {
  animation: fadeIn 0.3s ease-out;
}

.track-table-wrapper {
  overflow-x: auto;
  overflow-y: hidden;
  border-radius: 12px;
  border: 1px solid #eef1f6;
  background: var(--te-card-bg);
  box-shadow: 0 14px 32px rgba(34, 42, 68, 0.07);
}

.track-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

.track-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.track-table th {
  height: 36px;
  padding: 0 12px;
  text-align: left;
  color: rgba(82, 90, 122, 0.54);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 700;
  letter-spacing: 0;
  background: #fbfcff;
  border-bottom: 1px solid #eef1f6;
}

.selection-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 10px;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(124, 77, 255, 0.08);
  border: 1px solid rgba(124, 77, 255, 0.18);
}

.selection-count {
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  color: var(--te-neutral-800, #333);
  white-space: nowrap;
}

.selection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.selection-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--te-control-gap);
  min-height: var(--te-control-height-sm);
  border: none;
  border-radius: var(--te-control-radius-sm);
  padding: 0 var(--te-control-pad-x-sm);
  font-size: var(--te-control-font-size-sm);
  font-weight: var(--te-control-font-weight);
  cursor: pointer;
  color: var(--te-neutral-800, #333);
  background: rgba(255, 255, 255, 0.55);
}

.selection-btn:hover {
  background: rgba(255, 255, 255, 0.85);
}

.selection-btn.danger {
  color: #b91c1c;
}

.selection-btn.ghost {
  background: transparent;
  color: var(--te-neutral-600, #666);
}

.track-row.track-selected {
  background: rgba(124, 77, 255, 0.12) !important;
}

.track-row {
  cursor: pointer;
  transition:
    background 0.18s,
    box-shadow 0.18s;
}

.track-row td {
  padding: 10px 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  color: rgba(54, 62, 96, 0.74);
  border-bottom: 1px solid #f0f2f7;
  vertical-align: middle;
}

.track-row:hover {
  background: #faf8ff;
  box-shadow: inset 3px 0 0 rgba(124, 77, 255, 0.28);
}

.track-playing {
  background: #f5f1ff !important;
}

.cover-img,
.cover-placeholder {
  width: 36px;
  min-width: 36px;
  max-width: 36px;
  height: 36px;
  min-height: 36px;
  max-height: 36px;
  border-radius: 8px;
}

.cover-img {
  display: block;
  object-fit: cover;
}

.cover-placeholder {
  background: #f3f0ff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.col-cover,
.col-cover-header {
  width: 60px;
}

.col-cover-header {
  color: #888;
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14) !important;
  text-align: left;
  padding-left: 12px !important;
}

.col-index {
  width: 40px;
  color: rgba(82, 90, 122, 0.58) !important;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14) !important;
}

.col-info {
  width: auto;
  line-height: 1.4;
}

.track-title {
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 800;
  color: #222744;
}

.track-playing .track-title {
  color: var(--te-primary-500);
}

.track-artist {
  margin-top: 2px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: rgba(82, 90, 122, 0.58);
}

.track-artist .metadata-link {
  display: inline;
}

.col-like,
.col-like-header {
  width: 44px;
  text-align: center;
}

.col-like-header {
  padding: 0 !important;
}

.btn-like {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: rgba(124, 77, 255, 0.32);
  cursor: pointer;
  transition:
    color 0.2s,
    background 0.2s,
    transform 0.15s;
}

.btn-like:hover {
  background: rgba(232, 67, 147, 0.12);
  color: #e84393;
  transform: scale(1.15);
}

.btn-like.liked {
  color: #e84393;
}

.btn-like.loading,
.btn-like:disabled {
  pointer-events: none;
  opacity: 0.6;
}

.col-album {
  width: 180px;
  color: rgba(82, 90, 122, 0.58) !important;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14) !important;
}

.col-duration {
  width: 80px;
  color: rgba(82, 90, 122, 0.58) !important;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14) !important;
}

.playing-indicator {
  display: flex;
  align-items: center;
}

.rec-sections {
  padding: 0;
}

.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 18px;
  margin-top: 0;
}

@media (max-width: 900px) {
  .playlist-grid {
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 12px 10px;
  }

  .playlist-grid-card {
    padding: 9px;
  }

  .playlist-grid-name {
    margin-top: 9px;
    font-size: calc(var(--te-font-size-body, 14px) * 12.5 / 14);
  }

  .playlist-grid-count {
    margin-top: 3px;
    font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  }
}

@media (max-width: 640px) {
  .playlist-grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px 8px;
  }

  .playlist-grid-card {
    padding: 7px;
  }

  .playlist-grid-name {
    margin-top: 7px;
    font-size: calc(var(--te-font-size-body, 14px) * 11.5 / 14);
  }

  .playlist-grid-count {
    margin-top: 2px;
    font-size: calc(var(--te-font-size-body, 14px) * 10.5 / 14);
  }
}

.playlist-grid-card {
  cursor: pointer;
  font: inherit;
  text-align: left;
  padding: 12px;
  border-radius: 8px;
  background: var(--te-card-bg);
  border: 1px solid #eef1f6;
  box-shadow: 0 14px 32px rgba(34, 42, 68, 0.07);
  transition:
    transform 0.26s var(--te-ease-soft),
    box-shadow 0.26s;
}

.playlist-grid-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 18px 38px rgba(34, 42, 68, 0.1);
}

.playlist-grid-cover {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 8px;
  object-fit: cover;
  box-shadow: 0 18px 32px rgba(86, 70, 160, 0.14);
}

.playlist-grid-cover-placeholder {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 8px;
  background: #f3f0ff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.playlist-grid-name {
  margin-top: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 800;
  color: #242946;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-grid-count {
  margin-top: 4px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: rgba(82, 90, 122, 0.62);
  font-weight: 750;
}

.artist-card {
  text-align: center;
}

.artist-cover {
  border-radius: 50% !important;
}

.search-paginator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 24px;
}

.search-action-btn,
.pager-btn {
  min-height: var(--te-control-height-md);
  padding: 0 var(--te-control-pad-x-md);
  border: var(--te-control-border-width) solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-card-bg);
  color: rgba(52, 61, 87, 0.86);
  font-size: var(--te-control-font-size-sm);
  font-weight: var(--te-control-font-weight-bold);
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(86, 70, 160, 0.08);
  transition:
    transform var(--te-motion-hover) var(--te-ease-soft),
    box-shadow var(--te-motion-hover),
    opacity var(--te-motion-hover);
}

.search-action-btn:hover,
.pager-btn:hover:not(:disabled) {
  background: #f7f5ff;
  transform: translateY(-1px);
}

.pager-btn:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.pager-text {
  min-width: 72px;
  text-align: center;
  color: rgba(80, 88, 116, 0.64);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

:global(html[data-theme='dark'] .search-view .streaming-placeholder),
:global(html[data-theme='dark'] .search-view .playlist-grid-card),
:global(html[data-theme='dark'] .search-view .search-action-btn),
:global(html[data-theme='dark'] .search-view .pager-btn) {
  background: var(--te-card-bg);
  border-color: var(--te-card-border);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.24);
}

:global(html[data-theme='dark'] .search-view .playlist-grid-card:hover) {
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.34);
}

:global(html[data-theme='dark'] .search-view .playlist-grid-cover-placeholder) {
  background: #242016;
  color: var(--te-primary-400);
}

:global(html[data-theme='dark'] .search-view .pager-btn:hover:not(:disabled)),
:global(html[data-theme='dark'] .search-view .search-action-btn:hover) {
  background: rgba(245, 158, 11, 0.1);
  color: var(--te-primary-400);
}
</style>
