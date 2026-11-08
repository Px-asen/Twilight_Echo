<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import TrackInfoDialog from '@renderer/components/TrackInfoDialog.vue'
import EntityMetadataPanel from '../music-metadata/EntityMetadataPanel.vue'
import type { EntityMetadataContext } from '../music-metadata/entityMetadataView.ts'
import { computed, nextTick, shallowRef, watch } from 'vue'
import { useStreamingTrackLocator } from './useStreamingTrackLocator.ts'
import StreamingTrackToolbar from '@renderer/components/streaming-page/StreamingTrackToolbar.vue'
import type {
  StreamingTrackSort,
  StreamingSortDirection
} from '@renderer/components/streaming-page/streamingTrackView'
import type { Track, TrackArtistRef } from '../../types/music'
import type { BrowseDisplayRow, BrowsePartState } from '../../../../shared/coreBrowse.ts'
import CoverImg from '../CoverImg.vue'
import { trackRowKeyAction } from '../song-list/trackRowKeyboard'
import ExplicitBadge from '../ExplicitBadge.vue'
import { useProgressiveList } from './useProgressiveList.ts'
import {
  buildMediaPartRows,
  MEDIA_PART_PAGE_SIZE,
  type PartGroup,
  type PartGroupState
} from './mediaPartRows'

export type DetailStageKind =
  | 'liked'
  | 'playlist'
  | 'album'
  | 'rec'
  | 'artist'
  | 'user_list'
  | 'user_playlists'
  | 'recent'
  | 'ranking'
  | string

const props = withDefaults(
  defineProps<{
    kind: DetailStageKind
    title: string
    isExplicit?: boolean
    cover?: string | null
    coverSource?: string | null
    description?: string
    intro?: string
    metadataTarget?: EntityMetadataContext | null
    icon?: string
    trackCountLabel: string
    tracks: Track[]
    browseRows?: BrowseDisplayRow[]
    browseOffset?: number
    browseTotal?: number
    duration?: number
    query?: string
    sort?: StreamingTrackSort
    direction?: StreamingSortDirection
    totalTracks?: number
    refreshing?: boolean
    currentTrackId?: string | null
    trackActivationMode?: 'singleClick' | 'doubleClick'
    isExternal?: boolean
    showTrackLikes?: boolean
    favoriteProviderLabel?: string
    loading?: boolean
    showFollow?: boolean
    followLabel?: string
    followIcon?: string
    followActive?: boolean
    followLoading?: boolean
    followError?: string
    showPlayActions?: boolean
    hasSelection?: boolean
    selectedCount?: number
    selectionAllFavorited?: boolean
    favoriteLabel?: string
    canAddToPlaylist?: boolean
    canRemoveFromPlaylist?: boolean
    isSelected: (id: string) => boolean
    isTrackLiked: (track: Track) => boolean
    isLiking: (track: Track) => boolean
    formatTime: (seconds: number) => string
    likedFooter?: {
      paged?: boolean
      loadingMore?: boolean
      hasMore?: boolean
      loadMoreError?: string
      total?: number | null
      loaded?: number
    } | null
  }>(),
  {
    query: '',
    sort: 'default',
    direction: 'asc',
    totalTracks: undefined,
    cover: null,
    coverSource: null,
    description: '',
    intro: '',
    icon: 'pi pi-list',
    trackActivationMode: 'singleClick',
    isExternal: false,
    showTrackLikes: false,
    favoriteProviderLabel: '网易云',
    loading: false,
    showFollow: false,
    followLabel: '关注',
    followIcon: 'pi pi-user-plus',
    followActive: false,
    followLoading: false,
    followError: '',
    showPlayActions: true,
    hasSelection: false,
    selectedCount: 0,
    selectionAllFavorited: false,
    canAddToPlaylist: false,
    canRemoveFromPlaylist: false,
    likedFooter: null
  }
)

const emit = defineEmits<{
  'update:query': [value: string]
  'update:sort': [value: StreamingTrackSort]
  'update:direction': [value: StreamingSortDirection]
  refresh: []
  openArtist: [track: Track, artist: TrackArtistRef]
  openAlbum: [track: Track]
  playAll: []
  shufflePlay: []
  playTrack: [track: Track, index: number, event?: MouseEvent]
  trackClick: [track: Track, index: number, event: MouseEvent]
  likeTrack: [track: Track, event: MouseEvent]
  follow: []
  batchFavorite: []
  batchAddToPlaylist: []
  batchDelete: []
  clearSelection: []
  loadAllLiked: []
  loadMoreLiked: []
  trackContextMenu: [track: Track, index: number, event: MouseEvent]
  browseRange: [start: number, end: number]
  browseGroups: [groups: Record<string, BrowsePartState>]
}>()

function trackArtists(track: Track): TrackArtistRef[] {
  if (track.artists?.length) return track.artists
  return track.artist
    .split(/\s+\/\s+/)
    .map((name) => ({ name: name.trim() }))
    .filter((artist) => artist.name)
}

const kindLabel = computed(() => {
  switch (props.kind) {
    case 'liked':
      return '收藏'
    case 'playlist':
      return '歌单'
    case 'album':
      return '专辑'
    case 'rec':
      return '推荐'
    case 'artist':
      return '艺人'
    case 'recent':
      return '最近'
    case 'ranking':
      return '排行'
    case 'user_list':
      return '社交'
    case 'user_playlists':
      return '歌单集'
    default:
      return '列表'
  }
})

const totalDurationLabel = computed(() => {
  const total = props.duration ?? props.tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0)
  if (!total) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `约 ${hours} 小时 ${minutes} 分`
  return `约 ${minutes} 分钟`
})

const canPlay = computed(() => !props.loading && (props.totalTracks ?? props.tracks.length) > 0)

const emptyMessage = computed(() => {
  switch (props.kind) {
    case 'recent':
      return '还没有播放记录'
    case 'ranking':
      return '还没有听歌排行'
    case 'liked':
      return '收藏夹还是空的'
    case 'rec':
      return '暂时没有推荐曲目'
    default:
      return '这里还没有可播放的曲目'
  }
})

const partState = shallowRef<Record<string, PartGroupState>>({})
const stageRef = shallowRef<HTMLElement | null>(null)
const displayRows = computed(() => props.browseRows
  ? props.browseRows.map(row => row.kind === 'track' ? row : { ...row, group: {
    ...row.group, tracks: [{ track: row.group.representative, index: 0 }]
  } })
  : buildMediaPartRows(props.tracks, partState.value, !!props.query.trim()))
const {
  visibleItems: visibleRows,
  paddingTop,
  totalHeight,
  listRef,
  scrollContainer,
  itemBounds,
  scrollToIndex
} = useProgressiveList(() => displayRows.value, {
  total: () => props.browseTotal ?? displayRows.value.length,
  offset: () => props.browseOffset ?? 0,
  onRange: (start, end) => { if (props.browseRows) emit('browseRange', start, end) }
})

async function toggleParts(group: PartGroup, expanded: boolean): Promise<void> {
  partState.value = {
    ...partState.value,
    [group.id]: { expanded, page: partState.value[group.id]?.page ?? 0 }
  }
  if (props.browseRows) emit('browseGroups', partState.value)
  if (!expanded) {
    await revealPartHeader(group)
  }
}

async function changePartPage(group: PartGroup, page: number): Promise<void> {
  partState.value = { ...partState.value, [group.id]: { expanded: true, page } }
  if (props.browseRows) emit('browseGroups', partState.value)
  await revealPartHeader(group)
}

async function revealPartHeader(group: PartGroup): Promise<void> {
  await nextTick()
  // Keep the video's header visible when a page replaces twenty rows above the pager.
  scrollToIndex(
    (props.browseOffset ?? 0) + displayRows.value.findIndex((row) => row.kind === 'group' && row.group.id === group.id)
  )
  await nextTick()
  // Paging can unmount the focused footer in the virtual window. Return focus
  // to the disclosure so keyboard users can continue into the new part list.
  stageRef.value
    ?.querySelector<HTMLButtonElement>(`[data-part-group="${CSS.escape(group.id)}"]`)
    ?.focus({ preventScroll: true })
}

watch(
  () => [props.kind, props.title, props.query, props.sort, props.direction],
  () => {
    partState.value = {}
  }
)

watch(
  () => [props.query, props.sort, props.direction],
  () => scrollToIndex(0),
  { flush: 'post' }
)

useStreamingTrackLocator({ scrollContainer, itemBounds }, props, (id) =>
  { const index = displayRows.value.findIndex((row) => row.kind === 'track' && row.track.id === id); return index < 0 ? -1 : (props.browseOffset ?? 0) + index }
)

function onRowActivate(track: Track, index: number, event: MouseEvent): void {
  if (event.detail > 1) return
  emit('trackClick', track, index, event)
}

function onRowKeydown(event: KeyboardEvent, track: Track, index: number): void {
  const action = trackRowKeyAction(event)
  if (action === 'play') emit('playTrack', track, index)
  if (action === 'select')
    emit('trackClick', track, index, new MouseEvent('click', { ctrlKey: true }))
}

function onRowDblClick(track: Track, index: number, event: MouseEvent): void {
  event.preventDefault()
  if (props.trackActivationMode !== 'doubleClick') return
  emit('playTrack', track, index, event)
}

function onPlayRow(track: Track, index: number, event: MouseEvent): void {
  event.stopPropagation()
  emit('playTrack', track, index)
}

function onLike(track: Track, event: MouseEvent): void {
  event.stopPropagation()
  emit('likeTrack', track, event)
}

function onContextMenu(track: Track, index: number, event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  emit('trackContextMenu', track, index, event)
}

function shuffleAndPlay(): void {
  if (!canPlay.value) return
  emit('shufflePlay')
}

function loadNextTracks(): void {
  if (props.likedFooter?.paged) emit('loadMoreLiked')
  else emit('loadAllLiked')
}
const infoTrack = shallowRef<Track | null>(null)
</script>

<template>
  <Teleport to="body">
    <NativeDialogTransition>
      <TrackInfoDialog v-if="infoTrack" :track="infoTrack" @close="infoTrack = null" />
    </NativeDialogTransition>
  </Teleport>
  <section ref="stageRef" class="detail-stage" :data-kind="kind">
    <header class="stage-hero">
      <div class="stage-cover-frame">
        <CoverImg
          v-if="cover"
          :cover="cover"
          :cover-source="coverSource"
          class="stage-cover"
          alt="cover"
        />
        <div v-else class="stage-cover stage-cover-fallback" aria-hidden="true">
          <i :class="icon"></i>
        </div>
        <span class="stage-cover-ring" aria-hidden="true"></span>
      </div>

      <div class="stage-copy">
        <div class="stage-kicker">
          <span class="stage-kicker-mark" aria-hidden="true"></span>
          <span class="stage-kicker-text">{{ kindLabel }}</span>
          <span v-if="trackCountLabel" class="stage-kicker-meta">{{ trackCountLabel }}</span>
        </div>

        <div class="stage-title-row">
          <h2 class="stage-title">{{ title }}</h2>
          <ExplicitBadge v-if="kind === 'album' && isExplicit" />
        </div>

        <p v-if="description" class="stage-desc">{{ description }}</p>
        <p v-if="intro && !metadataTarget" class="stage-intro">{{ intro }}</p>

        <div class="stage-meta-row">
          <span v-if="totalDurationLabel" class="stage-chip">{{ totalDurationLabel }}</span>
          <span v-if="totalTracks ?? tracks.length" class="stage-chip muted">{{ totalTracks ?? tracks.length }} 首在列</span>
        </div>

        <div class="stage-actions">
          <button
            v-if="showFollow"
            type="button"
            class="stage-btn stage-btn-primary"
            :class="{ active: followActive }"
            :disabled="followLoading"
            @click="emit('follow')"
          >
            <i :class="followIcon"></i>
            <span>{{ followLabel }}</span>
          </button>

          <template v-else-if="showPlayActions">
            <button
              type="button"
              class="stage-btn stage-btn-primary"
              :disabled="!canPlay"
              @click="emit('playAll')"
            >
              <PlaybackIcon name="play" />
              <span>{{
                likedFooter?.paged && likedFooter.hasMore ? '播放已加载' : '播放全部'
              }}</span>
            </button>
            <button
              type="button"
              class="stage-btn stage-btn-ghost"
              :disabled="!canPlay"
              title="随机播放"
              @click="shuffleAndPlay"
            >
              <i class="pi pi-arrow-right-arrow-left"></i>
              <span>随机</span>
            </button>
          </template>
        </div>

        <p v-if="followError" class="stage-follow-error">{{ followError }}</p>
      </div>
    </header>

    <EntityMetadataPanel v-if="metadataTarget" :target="metadataTarget" :fallback-intro="intro" />

    <StreamingTrackToolbar
      v-if="showPlayActions && !showFollow"
      :query="query"
      :sort="sort"
      :direction="direction"
      :count="totalTracks ?? tracks.length"
      :total="totalTracks ?? tracks.length"
      :refreshing="refreshing"
      @update:query="emit('update:query', $event)"
      @update:sort="emit('update:sort', $event)"
      @update:direction="emit('update:direction', $event)"
      @refresh="emit('refresh')"
    />
    <div v-if="likedFooter?.hasMore" class="stage-footer" role="status">
      <span class="stage-footer-msg">
        搜索与排序范围：已加载 {{ likedFooter.loaded
        }}{{ likedFooter.total != null ? ` / ${likedFooter.total}` : '' }} 首
      </span>
      <button
        type="button"
        class="stage-mini-btn"
        :disabled="likedFooter.loadingMore"
        @click="loadNextTracks"
      >
        {{ likedFooter.loadingMore ? '正在加载' : likedFooter.paged ? '加载更多' : '加载全部' }}
      </button>
      <span v-if="likedFooter.loadMoreError" class="stage-footer-msg">{{
        likedFooter.loadMoreError
      }}</span>
    </div>
    <div
      v-if="!loading && (totalTracks ?? tracks.length) === 0 && showPlayActions && !showFollow"
      class="stage-empty"
    >
      <i class="pi pi-wave-pulse" aria-hidden="true"></i>
      <p>{{ query ? '没有匹配的歌曲，试试其他关键词' : emptyMessage }}</p>
    </div>

    <!-- Loading skeleton -->
    <div
      v-if="loading && (totalTracks ?? tracks.length) === 0"
      class="stage-list stage-list-skeleton"
      :class="{ 'no-like': isExternal && !showTrackLikes }"
      aria-live="polite"
    >
      <div class="stage-list-head">
        <span class="col-index">#</span>
        <span class="col-title">曲目</span>
        <span v-if="!isExternal || showTrackLikes" class="col-like"></span>
        <span class="col-album">专辑</span>
        <span class="col-time">时长</span>
      </div>
      <div v-for="i in 8" :key="i" class="stage-row skeleton-row">
        <div class="col-index"><span class="sk sk-num"></span></div>
        <div class="col-title">
          <span class="sk sk-cover"></span>
          <span class="sk-copy">
            <span class="sk sk-line wide"></span>
            <span class="sk sk-line narrow"></span>
          </span>
        </div>
        <div v-if="!isExternal || showTrackLikes" class="col-like"></div>
        <div class="col-album"><span class="sk sk-line mid"></span></div>
        <div class="col-time"><span class="sk sk-line short"></span></div>
      </div>
    </div>

    <!-- Track list -->
    <div
      v-else-if="(browseTotal ?? tracks.length) > 0"
      class="stage-list"
      :class="{ 'no-like': isExternal && !showTrackLikes }"
    >
      <div v-if="hasSelection" class="stage-selection" role="toolbar" aria-label="批量操作">
        <div class="stage-selection-left">
          <span class="stage-selection-dot" aria-hidden="true"></span>
          <span>已选 {{ selectedCount }} 首</span>
        </div>
        <div class="stage-selection-actions">
          <button type="button" class="stage-mini-btn" @click="emit('batchFavorite')">
            <i :class="selectionAllFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
            <span>{{
              favoriteLabel ?? (selectionAllFavorited ? '移出应用收藏' : '加入应用收藏')
            }}</span>
          </button>
          <button
            v-if="canAddToPlaylist"
            type="button"
            class="stage-mini-btn"
            @click="emit('batchAddToPlaylist')"
          >
            <i class="pi pi-list"></i>
            <span>添加到歌单</span>
          </button>
          <button type="button" class="stage-mini-btn danger" @click="emit('batchDelete')">
            <i class="pi pi-minus-circle"></i>
            <span>{{ canRemoveFromPlaylist ? '从歌单移除' : '移除' }}</span>
          </button>
          <button type="button" class="stage-mini-btn ghost" @click="emit('clearSelection')">
            <i class="pi pi-times"></i>
            <span>取消</span>
          </button>
        </div>
      </div>

      <div class="stage-list-head" aria-hidden="true">
        <span class="col-index">#</span>
        <span class="col-title">曲目</span>
        <span v-if="!isExternal || showTrackLikes" class="col-like"></span>
        <span class="col-album">专辑</span>
        <span class="col-time">时长</span>
      </div>

      <ul :ref="listRef" class="stage-rows" role="list" :style="{ height: `${totalHeight}px` }">
        <template v-for="(row, index) in visibleRows" :key="row.key">
          <li
            v-if="row.kind === 'group'"
            class="part-video-row"
            :class="{ expanded: row.expanded }"
            :style="index === 0 ? { marginTop: `${paddingTop}px` } : undefined"
          >
            <CoverImg
              :cover="row.group.tracks[0].track.cover"
              :cover-source="row.group.tracks[0].track.coverSource"
              class="part-video-cover"
              alt=""
            />
            <button
              type="button"
              class="part-disclosure"
              :data-part-group="row.group.id"
              :aria-expanded="row.expanded"
              :aria-label="`${row.expanded ? '收起' : '展开'} ${row.group.title} 的 ${row.group.count} 个分P`"
              @click="toggleParts(row.group, !row.expanded)"
            >
              <span class="part-video-title" :title="row.group.title">{{ row.group.title }}</span>
              <span class="part-video-meta">
                <span class="part-count">{{ row.group.count }} P</span>
                <span class="part-toggle-label">{{ row.expanded ? '收起分P' : '展开分P' }}</span>
                <i class="pi pi-chevron-down part-chevron" aria-hidden="true"></i>
                <span
                  v-if="row.group.playing ?? row.group.tracks.some(({ track }) => track.id === currentTrackId)"
                  class="part-now-playing"
                  >正在播放</span
                >
              </span>
            </button>
            <span class="part-video-artist" :title="row.group.tracks[0].track.artist">{{
              row.group.tracks[0].track.artist
            }}</span>
          </li>
          <li
            v-else-if="row.kind === 'pager'"
            class="part-pager"
            :style="index === 0 ? { marginTop: `${paddingTop}px` } : undefined"
          >
            <span class="part-range" role="status">
              {{ row.page * MEDIA_PART_PAGE_SIZE + 1 }}–{{
                Math.min((row.page + 1) * MEDIA_PART_PAGE_SIZE, (row.group.total ?? row.group.tracks.length))
              }}
              / {{ (row.group.total ?? row.group.tracks.length) }} P{{ query ? ' 匹配' : '' }}
            </span>
            <nav
              v-if="row.pageCount > 1"
              class="part-pagination"
              :aria-label="`${row.group.title} 分P分页`"
            >
              <button
                type="button"
                :disabled="row.page === 0"
                aria-label="上一页分P"
                @click="changePartPage(row.group, row.page - 1)"
              >
                <i class="pi pi-chevron-left" aria-hidden="true"></i>
              </button>
              <select
                :value="row.page"
                aria-label="选择分P页码"
                @change="
                  changePartPage(row.group, Number(($event.target as HTMLSelectElement).value))
                "
              >
                <option v-for="page in row.pageCount" :key="page" :value="page - 1">
                  {{ page }} / {{ row.pageCount }}
                </option>
              </select>
              <button
                type="button"
                :disabled="row.page === row.pageCount - 1"
                aria-label="下一页分P"
                @click="changePartPage(row.group, row.page + 1)"
              >
                <i class="pi pi-chevron-right" aria-hidden="true"></i>
              </button>
            </nav>
            <button type="button" class="part-collapse" @click="toggleParts(row.group, false)">
              收起<i class="pi pi-chevron-up" aria-hidden="true"></i>
            </button>
          </li>
          <li
            v-else
            class="stage-row"
            :data-part-index="row.grouped ? row.track.mediaPart?.index : undefined"
            data-te-interactive
            :class="{
              playing: currentTrackId === row.track.id,
              selected: isSelected(row.track.id),
              'part-track': row.grouped
            }"
            :style="index === 0 ? { marginTop: `${paddingTop}px` } : undefined"
            role="listitem"
            tabindex="0"
            :aria-label="`${row.track.title} · ${row.track.artist}，按回车播放，空格选择`"
            @keydown="onRowKeydown($event, row.track, row.index)"
            @click="onRowActivate(row.track, row.index, $event)"
            @dblclick="onRowDblClick(row.track, row.index, $event)"
            @contextmenu="onContextMenu(row.track, row.index, $event)"
          >
            <div class="col-index">
              <button
                v-if="currentTrackId === row.track.id"
                type="button"
                class="row-play-btn playing"
                title="正在播放"
                @click="onPlayRow(row.track, row.index, $event)"
              >
                <span class="eq-bars" aria-hidden="true"> <i></i><i></i><i></i> </span>
              </button>
              <button
                v-else
                type="button"
                class="row-play-btn"
                :aria-label="`播放 ${row.track.title}`"
                @click="onPlayRow(row.track, row.index, $event)"
              >
                <span class="row-index-num">{{
                  row.grouped
                    ? `P${row.track.mediaPart?.index}`
                    : String(row.index + 1).padStart(2, '0')
                }}</span>
                <PlaybackIcon name="play" class="row-play-icon" />
              </button>
            </div>

            <div class="col-title">
              <CoverImg
                v-if="!row.grouped"
                :cover="row.track.cover"
                :cover-source="row.track.coverSource"
                class="row-cover"
                alt=""
              />

              <div class="row-copy">
                <button
                  type="button"
                  class="row-title metadata-link"
                  :title="row.track.title"
                  @click.stop="infoTrack = row.track"
                  @dblclick.stop
                >
                  {{ row.grouped ? row.track.mediaPart?.title : row.track.title }}
                </button>
                <div v-if="!row.grouped" class="row-artists">
                  <template
                    v-for="(artist, artistIndex) in trackArtists(row.track)"
                    :key="artistIndex"
                  >
                    <span v-if="artistIndex > 0" class="row-artist-separator" aria-hidden="true"
                      >/</span
                    >
                    <button
                      type="button"
                      class="row-artist metadata-link"
                      :title="artist.name"
                      @click.stop="emit('openArtist', row.track, artist)"
                      @dblclick.stop
                    >
                      {{ artist.name }}
                    </button>
                  </template>
                  <span v-if="!row.track.artist.trim() && !row.track.artists?.length"
                    >未知艺人</span
                  >
                </div>
              </div>
            </div>

            <div v-if="!isExternal || showTrackLikes" class="col-like">
              <button
                type="button"
                class="row-like"
                :class="{
                  liked: isTrackLiked(row.track),
                  loading: isLiking(row.track)
                }"
                :disabled="isLiking(row.track)"
                :title="`在${favoriteProviderLabel}${isTrackLiked(row.track) ? '取消' : ''}${isExternal ? '收藏' : '喜欢'}`"
                :aria-label="`在${favoriteProviderLabel}${isTrackLiked(row.track) ? '取消' : ''}${isExternal ? '收藏' : '喜欢'}`"
                :aria-pressed="isTrackLiked(row.track)"
                @click="onLike(row.track, $event)"
              >
                <i v-if="isLiking(row.track)" class="pi pi-spin pi-spinner"></i>
                <i v-else :class="isTrackLiked(row.track) ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
              </button>
            </div>

            <div class="col-album" :title="row.track.album || ''">
              <button
                type="button"
                class="metadata-link"
                @click.stop="emit('openAlbum', row.track)"
                @dblclick.stop
              >
                {{ row.track.album || '—' }}
              </button>
            </div>

            <div class="col-time">
              {{ formatTime(row.track.duration) }}
            </div>
          </li>
        </template>
      </ul>

      <div v-if="likedFooter" class="stage-footer">
        <span v-if="likedFooter.loadingMore" class="stage-footer-msg">
          <i class="pi pi-spin pi-spinner"></i>
          正在加载更多
        </span>
        <button
          v-else-if="likedFooter.loadMoreError"
          type="button"
          class="stage-mini-btn"
          @click="emit('loadMoreLiked')"
        >
          <i class="pi pi-refresh"></i>
          <span>继续加载</span>
        </button>
        <button
          v-else-if="likedFooter.hasMore && likedFooter.paged"
          type="button"
          class="stage-mini-btn"
          @click="emit('loadMoreLiked')"
        >
          加载更多
        </button>
        <span v-else-if="likedFooter.hasMore" class="stage-footer-msg"> 继续向下滚动加载更多 </span>
        <span v-else-if="(likedFooter.loaded ?? 0) > 0" class="stage-footer-msg"> 已加载全部 </span>
      </div>
    </div>
  </section>
</template>

<style scoped src="./StreamingDetailStage.css"></style>
<style scoped src="./MediaPartRows.css"></style>
