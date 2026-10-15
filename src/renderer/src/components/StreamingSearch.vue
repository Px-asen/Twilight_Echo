<script setup lang="ts">
import { computed } from 'vue'
import type { Track, TrackArtistRef } from '../types/music'
import type {
  MediaProviderPlaylistSummary,
  MediaProviderArtistSummary
} from '../providers/mediaProvider'
import type { SearchType } from './streaming-page/useStreamingSearch'
import { albumSearchKey, type AlbumSearchItem } from './streaming-page/albumSearch.ts'
import CoverImg from './CoverImg.vue'
import { useBoundedGrid } from '@renderer/composables/useBoundedGrid'

interface PageState {
  first: number
  rows: number
  page: number
  pageCount: number
}

const props = withDefaults(
  defineProps<{
    queryActive?: boolean
    searchSourceLabel?: string
    searchType: SearchType
    searchResults: Track[]
    searchAlbumsResults?: AlbumSearchItem[]
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
  }>(),
  { queryActive: true }
)

const emit = defineEmits<{
  searchTrackClick: [track: Track, event: MouseEvent]
  searchTrackActivate: [track: Track]
  likeTrack: [track: Track, event: MouseEvent]
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  openAlbum: [album: AlbumSearchItem]
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
const resultTypeLabel = computed(
  () => ({ songs: '单曲', albums: '专辑', playlists: '歌单', artists: '歌手' })[props.searchType]
)
const { setGridElement, gridStyle } = useBoundedGrid(() =>
  props.searchType === 'albums'
    ? (props.searchAlbumsResults?.length ?? 0)
    : props.searchType === 'artists'
      ? props.searchArtistsResults.length
      : props.searchPlaylistsResults.length
)

function isSelected(trackId: string): boolean {
  return props.selectedIds?.has(trackId) ?? false
}

function isFavorited(track: Track): boolean {
  return props.isTrackFavorited?.(track) ?? props.isTrackLiked(track.ncmSongId)
}

function favoriteActionLabel(track: Track): string {
  return track.ncmSongId != null
    ? `在网易云${isFavorited(track) ? '取消喜欢' : '喜欢'}`
    : isFavorited(track)
      ? '移出应用收藏'
      : '加入应用收藏'
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
    if (event.repeat) return
    if (event.key === 'Enter') emit('searchTrackActivate', track)
    else emit('searchTrackClick', track, new MouseEvent('click', { ctrlKey: true }))
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
  <div class="search-view" :aria-busy="searchLoading">
    <p v-if="queryActive === false" class="search-start-hint">
      输入关键词，搜索本地音乐或在线音源。
    </p>
    <div v-else class="search-query-results">
      <div class="search-results-summary">
        <h2 class="search-results-heading">{{ resultTypeLabel }}</h2>
        <p
          class="search-results-count"
          :role="!searchLoading && !searchError && searchTotal > 0 ? 'status' : undefined"
        >
          {{ searchSourceLabel ?? '全部音源' }}
          <template v-if="!searchLoading && !searchError">
            · {{ searchTotal }} {{ searchType === 'songs' ? '首' : '项' }}
          </template>
        </p>
      </div>
      <div v-if="searchLoading && searchOffset === 0" class="streaming-placeholder" role="status">
        <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
        <p class="placeholder-title">正在搜索</p>
      </div>
      <div v-else-if="searchError" class="streaming-placeholder error-state" role="alert">
        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
        <p class="placeholder-title">搜索失败</p>
        <p class="placeholder-hint">{{ searchError }}</p>
        <button type="button" class="search-action-btn" @click="emit('retry')">重试</button>
      </div>
      <div
        v-else-if="searchTotal === 0 && !searchLoading"
        class="streaming-placeholder"
        role="status"
      >
        <i class="pi pi-search" aria-hidden="true"></i>
        <p class="placeholder-title">无搜索结果</p>
        <p class="placeholder-hint">换个关键词试试吧</p>
      </div>
      <div v-else class="search-results-content">
        <p v-if="searchLoading" class="search-loading" role="status">正在加载搜索结果…</p>
        <div v-if="searchType === 'songs'" class="detail-content">
          <div class="track-table-wrapper">
            <div v-if="hasSelection" class="selection-toolbar" role="toolbar" aria-label="批量操作">
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
            <table class="track-table" aria-label="搜索歌曲" :aria-rowcount="searchTotal + 1">
              <thead>
                <tr>
                  <th class="col-cover-header" scope="col" aria-label="封面"></th>
                  <th class="col-index" scope="col">#</th>
                  <th class="col-info" scope="col">标题</th>
                  <th class="col-like-header" scope="col" aria-label="收藏"></th>
                  <th class="col-album" scope="col">专辑</th>
                  <th class="col-duration" scope="col">时长</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(track, index) in searchResults"
                  :key="track.id"
                  class="track-row"
                  data-te-interactive
                  tabindex="0"
                  :aria-label="`${track.title} · ${track.artist}，按回车播放，空格选择`"
                  :aria-selected="isSelected(track.id)"
                  :aria-rowindex="searchOffset + index + 2"
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
                    <CoverImg
                      :cover="track.cover"
                      :cover-source="track.coverSource"
                      :identity="track.id"
                      class="cover-img"
                      alt=""
                      loading="lazy"
                    />
                  </td>
                  <td class="col-index">
                    <span v-if="currentTrack?.id === track.id" class="playing-indicator">
                      <i class="pi pi-volume-up" aria-hidden="true"></i>
                    </span>
                    <span v-else>{{ index + 1 + searchOffset }}</span>
                  </td>
                  <td class="col-info">
                    <div class="track-title" :title="track.title">{{ track.title }}</div>
                    <div class="track-artist" :title="track.artist">
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
                      type="button"
                      class="btn-like"
                      :class="{
                        liked: isFavorited(track),
                        loading: likingTracks.has(track.ncmSongId ?? 0)
                      }"
                      :disabled="likingTracks.has(track.ncmSongId ?? 0)"
                      :title="favoriteActionLabel(track)"
                      :aria-label="favoriteActionLabel(track)"
                      :aria-pressed="isFavorited(track)"
                      @click.stop="emit('likeTrack', track, $event)"
                    >
                      <i
                        v-if="likingTracks.has(track.ncmSongId ?? 0)"
                        class="pi pi-spin pi-spinner"
                        style="font-size: calc(var(--te-font-size-body, 14px) * 14 / 14)"
                      ></i>
                      <i
                        v-else
                        :class="isFavorited(track) ? 'pi pi-heart-fill' : 'pi pi-heart'"
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
                    <span v-else :title="track.album">{{ track.album }}</span>
                  </td>
                  <td class="col-duration">{{ formatTime(track.duration) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else-if="searchType === 'albums'" class="rec-sections">
          <div :ref="setGridElement" class="playlist-grid album-search-grid" :style="gridStyle">
            <button
              v-for="album in searchAlbumsResults"
              :key="albumSearchKey(album)"
              type="button"
              class="playlist-grid-card album-search-card"
              data-te-interactive
              @click="emit('openAlbum', album)"
            >
              <CoverImg
                v-if="album.cover || album.coverSmall"
                :cover="album.coverSmall || album.cover"
                :cover-source="album.coverSmallSource || album.coverSource"
                class="playlist-grid-cover"
                alt=""
              />
              <div v-else class="playlist-grid-cover-placeholder">
                <i class="pi pi-headphones" aria-hidden="true"></i>
              </div>
              <div class="playlist-grid-name" :title="album.name">{{ album.name }}</div>
              <div class="album-search-artist" :title="album.artist || '未知艺术家'">
                {{ album.artist || '未知艺术家' }}
              </div>
              <div class="album-search-meta">
                <span>{{ album.trackCount }} 首</span>
                <span class="album-search-source" :title="album.providerName">{{
                  album.providerName
                }}</span>
              </div>
            </button>
          </div>
        </div>
        <div v-else-if="searchType === 'playlists'" class="rec-sections">
          <div :ref="setGridElement" class="playlist-grid" :style="gridStyle">
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
                <i class="pi pi-list" aria-hidden="true"></i>
              </div>
              <div class="playlist-grid-name" :title="playlist.name">{{ playlist.name }}</div>
              <div class="playlist-grid-count">{{ playlist.trackCount }} 首</div>
            </button>
          </div>
        </div>
        <div v-else-if="searchType === 'artists'" class="rec-sections">
          <div :ref="setGridElement" class="playlist-grid" :style="gridStyle">
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
                <i class="pi pi-user" aria-hidden="true"></i>
              </div>
              <div class="playlist-grid-name" :title="artist.name">{{ artist.name }}</div>
              <div class="playlist-grid-count">{{ artist.musicSize ?? 0 }} 首单曲</div>
            </button>
          </div>
        </div>
        <div v-if="searchTotal > pageSize" class="search-paginator">
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
  min-width: 0;
  padding-bottom: 24px;
  color: var(--te-settings-text);
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body);
  line-height: var(--te-type-line-body);
  container: te-streaming-search / inline-size;
}
.search-start-hint {
  margin: 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
}
.search-results-summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-bottom: 12px;
}
.search-results-heading {
  margin: 0;
  color: var(--te-settings-text);
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
  line-height: var(--te-type-line-title);
}
.search-results-count {
  margin: 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
}
.streaming-placeholder {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 24px 0;
  color: var(--te-settings-text-muted);
}
.streaming-placeholder > i {
  font-size: var(--te-type-section-title);
}
.placeholder-title {
  margin: 0;
  color: var(--te-settings-text);
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
}
.placeholder-hint {
  margin: 0;
  font-size: var(--te-type-body);
  overflow-wrap: anywhere;
}
.error-state > i {
  color: var(--te-danger-soft-fg);
}
.search-loading {
  margin: 0 0 12px;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}
.track-table-wrapper {
  min-width: 0;
}
.track-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
}
.track-table th {
  padding: 6px 8px;
  min-height: 36px;
  text-align: left;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
  border-bottom: 1px solid var(--te-card-border);
}
.selection-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 8px;
  border-block: 1px solid var(--te-card-border);
  background: var(--te-subtle-bg);
}
.selection-count {
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
}
.selection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.selection-btn,
.search-action-btn,
.pager-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--te-control-gap);
  min-height: var(--te-control-height-md);
  max-width: 100%;
  border: var(--te-control-border-width) solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  padding: 6px var(--te-control-pad-x-md);
  background: var(--te-subtle-bg);
  color: var(--te-settings-text);
  font: inherit;
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
  line-height: var(--te-type-line-caption);
  cursor: pointer;
}
.selection-btn:hover,
.search-action-btn:hover,
.pager-btn:hover:not(:disabled) {
  background: var(--te-hover-bg);
}
.selection-btn.danger {
  color: var(--te-danger-soft-fg);
}
.selection-btn.ghost {
  background: transparent;
  color: var(--te-settings-text-muted);
}
.track-row {
  cursor: pointer;
  scroll-margin-block: 12px;
  transition: background-color var(--te-motion-hover) var(--te-ease-soft);
}
.track-row td {
  height: 56px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--te-card-border);
  vertical-align: middle;
}
.track-row:hover {
  background: var(--te-library-row-hover);
}
.track-playing {
  background: var(--te-playing-row-bg, var(--te-library-selection-bg));
}
.track-row.track-selected {
  background: var(--te-library-selection-bg);
}
.cover-img {
  display: block;
  width: 40px;
  height: 40px;
  border-radius: var(--te-library-cover-radius);
  object-fit: cover;
  background: var(--te-subtle-bg);
}
.col-cover,
.col-cover-header {
  width: 56px;
}
.col-index {
  width: 36px;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-variant-numeric: tabular-nums;
}
.col-info {
  min-width: 0;
}
.track-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--te-settings-text);
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-medium);
  line-height: 1.35;
}
.track-playing .track-title,
.playing-indicator {
  color: var(--te-primary-500);
}
.track-artist {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
}
.metadata-link {
  max-width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.track-artist .metadata-link {
  display: inline;
}
.metadata-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.col-like,
.col-like-header {
  width: 44px;
  text-align: center;
}
.btn-like {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--te-control-height-md);
  min-height: var(--te-control-height-md);
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
}
.btn-like:hover {
  background: var(--te-hover-bg);
}
.btn-like.liked {
  color: var(--te-danger-soft-fg);
}
.btn-like:disabled {
  cursor: default;
  opacity: 0.5;
}
.col-album {
  width: 25%;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-duration {
  width: max(56px, calc(var(--te-font-size-body) * 4.5));
  text-align: right;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-variant-numeric: tabular-nums;
}
.track-table th.col-duration {
  text-align: right;
}
.playlist-grid {
  display: grid;
  min-width: 0;
}
.playlist-grid-card {
  display: flex;
  min-width: 0;
  width: 100%;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 0;
  border: 0;
  border-radius: var(--te-library-cover-radius);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.playlist-grid-card:hover {
  background: var(--te-hover-bg);
}
.playlist-grid-cover,
.playlist-grid-cover-placeholder {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--te-library-cover-radius);
  object-fit: cover;
  background: var(--te-subtle-bg);
}
.playlist-grid-cover-placeholder {
  display: grid;
  place-items: center;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-page-title);
}
.playlist-grid-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin-top: 4px;
  color: var(--te-settings-text);
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-medium);
  line-height: var(--te-type-line-body);
}
.playlist-grid-count,
.album-search-artist,
.album-search-meta {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-regular);
  line-height: var(--te-type-line-caption);
}
.album-search-artist,
.album-search-source {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.album-search-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}
.album-search-meta > :first-child {
  flex-shrink: 0;
}
.artist-cover {
  border-radius: 50%;
}
.search-paginator {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  margin-top: 24px;
}
.pager-btn:disabled {
  cursor: default;
  opacity: 0.5;
}
.pager-text {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-variant-numeric: tabular-nums;
}
.search-view :is(button, .track-row):focus-visible {
  outline: var(--te-control-focus-width) solid var(--te-control-focus-color);
  outline-offset: var(--te-control-focus-offset);
}
@container te-streaming-search (max-width: 760px) {
  .col-album {
    display: none;
  }
}
@container te-streaming-search (max-width: 420px) {
  .col-index {
    display: none;
  }
  .col-cover,
  .col-cover-header {
    width: 44px;
  }
  .track-row td,
  .track-table th {
    padding-inline: 4px;
  }
  .cover-img {
    width: 32px;
    height: 32px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .track-row {
    transition: none;
  }
}
</style>
