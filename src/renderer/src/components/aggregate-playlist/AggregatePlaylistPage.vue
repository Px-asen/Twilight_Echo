<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AnimatedInput from '../AnimatedInput.vue'
import CreateAggregatePlaylistDialog from './CreateAggregatePlaylistDialog.vue'
import CoverImg from '../CoverImg.vue'
import ThemeIcon from '../ThemeIcon.vue'
import LibraryPager from '../song-list/LibraryPager.vue'
import { createLibraryAggregatePlaylist } from '../../stores/library/libraryAggregatePlaylist'
import { musicVersionRevision } from '../../stores/musicVersions'
import type { LibraryPlaylistSourceSummary } from '../../../../shared/libraryDatabase'
import type { CorePlaylistDescriptor as Playlist } from '../../../../shared/corePlaylists'
import { useCoreLibraryApi } from '../../stores/library/coreLibraryApi'
import { formatDuration } from '../song-list/formatDuration'
import { useSongListVirtualScroll } from '../song-list/useSongListVirtualScroll'
import { useSongListGridRendering } from '../song-list/useSongListGridRendering'
import { trackRowKeyAction } from '../song-list/trackRowKeyboard'
import { useLocatePlayingTrack } from '../song-list/useLocatePlayingTrack'
import { useBackHandler } from '../../app/useBackStack.ts'
import { useMusicStore } from '../../stores/useMusicStore'
import { usePlayerStore } from '../../stores/usePlayerStore'
import { useProviderStore } from '../../stores/useProviderStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { toggleHiddenSource } from '../../utils/aggregatePlaylistView.ts'
import type { Track } from '../../types/music'

const props = withDefaults(
  defineProps<{
    hasPlayer: boolean
    /** 本地视图和流媒体页各挂一个实例，只用于外壳留白的细微差别。 */
    surface?: 'local' | 'streaming'
    /**
     * 流媒体页内嵌的实例在流媒体页切去后台（v-show）时依然存活；此时不
     * 应向全局返回栈注册，让位给真正可见的页面。本地实例总是 v-if 挂载，
     * 不需要关心。
     */
    active?: boolean
    initialPlaylistId?: string | null
    navigatePlaylist?: (id: string) => void
    returnFromDetail?: () => void
  }>(),
  { surface: 'local', active: true }
)

const {
  aggregatePlaylists,
  deletePlaylist,
  setPlaylistPinned,
  setPlaylistHiddenSources,
  setPlaylistVariantPreference,
  removeTracksFromPlaylistById
} = useMusicStore()
const musicStore = useMusicStore()
const playerStore = usePlayerStore()
const { currentTrack } = playerStore
const settingsStore = useSettingsStore()
const providerStore = useProviderStore()

// ─── 视图状态：网格 ↔ 详情，组件自管，两个实例互不干扰 ────────────────────
const activePlaylistId = ref<string | null>(props.initialPlaylistId ?? null)
watch(
  () => props.initialPlaylistId,
  (id) => {
    activePlaylistId.value = id ?? null
  }
)
const searchQuery = ref('')
const pendingDeleteId = ref<string | null>(null)
const showCreateDialog = ref(false)
const actionError = ref('')

const activePlaylist = computed(
  () => aggregatePlaylists.value.find((playlist) => playlist.id === activePlaylistId.value) ?? null
)

// 歌单被别处删掉时不要卡在一个空详情页里。
watch(activePlaylist, (playlist) => {
  if (activePlaylistId.value && !playlist) activePlaylistId.value = null
})
const database = createLibraryAggregatePlaylist(useCoreLibraryApi())
const databasePage = database.pageState,
  databaseSources = database.sourceState,
  databaseVariants = database.variantState,
  databaseCards = database.cardState
const databaseMenu = database.menu,
  databaseAction = database.action
const databaseEnabled = computed(() => props.active)
const databasePending = computed(() => props.active && database.busy.value)
const databaseError = database.error
watch(
  () => ({
    enabled: databaseEnabled.value,
    playlist: activePlaylist.value,
    playlists: aggregatePlaylists.value,
    search: searchQuery.value,
    revision: musicStore.playlistsRevision.value,
    hidden: activePlaylist.value?.hiddenSources,
  }),
  (value) => database.setInput(value),
  { immediate: true, flush: 'sync' }
)
watch(
  [() => database.detailState.value.id, () => database.catalogState.value.id],
  database.refreshQueries,
  { flush: 'sync' }
)
watch(musicStore.libraryRevision, (revision) => {
  if (databaseEnabled.value) database.invalidate(revision)
})
watch(musicVersionRevision, () => database.invalidate())
onUnmounted(() => database.dispose())
function retryDatabase(): void {
  database.retry()
}
type PlaylistCard = Pick<Playlist, 'id' | 'name' | 'cover' | 'pinnedAt'> & {
  trackCount?: number
  sourceSummary?: LibraryPlaylistSourceSummary
}
const playlistPins = computed(
  () => new Map(aggregatePlaylists.value.map((playlist) => [playlist.id, playlist.pinnedAt]))
)
const gridPlaylists = computed<PlaylistCard[]>(() => {
  return database.cardPages.value.flatMap((page) =>
    page.items.map((item) => ({ ...item, pinnedAt: playlistPins.value.get(item.id) }))
  )
})

/** 虚拟滚动跑在"每行当前选定音源"上，行数据再按 trackId 映射回来。 */
const displayTracks = computed<Track[]>(() => database.pages.value.flatMap((page) => page.tracks))

const sourceFilters = computed(() => databaseSources.value.page?.aggregate?.sources ?? [])

const detailStatsText = computed(() => {
  if (!databasePage.value.page) return '正在读取聚合歌单…'
  const visible = databasePage.value.page.aggregate?.rowCount ?? 0
  const total = databasePage.value.page.aggregate?.memberCount ?? 0
  const sourceCount =
    databaseSources.value.total === null
      ? null
      : Math.max(
          0,
          (databaseSources.value.total ?? 0) -
            new Set(activePlaylist.value?.hiddenSources ?? []).size
        )
  const parts = [`${visible} 首`]
  if (total !== visible) parts.push(`已隐藏 ${total - visible} 首`)
  if (sourceCount !== null) parts.push(`${sourceCount} 个音源`)
  return parts.join(' · ')
})

const tableTrackCount = computed(() => databasePage.value.total ?? 0)
const showGrid = computed(() => !activePlaylist.value)
const {
  containerRef,
  tbodyRef,
  rowHeight,
  visibleRange,
  totalHeight,
  paddingTop,
  onScroll,
  scrollTop,
  viewportHeight,
  scrollToTrack,
  updateViewportHeight
} = useSongListVirtualScroll({
  displayTracks,
  itemCount: tableTrackCount,
  restoreReady: computed(() =>
    showGrid.value ? databaseCards.value.total !== null : databasePage.value.total !== null
  ),
  viewKey: computed(() =>
    JSON.stringify([
      'aggregate',
      props.surface,
      activePlaylistId.value,
      searchQuery.value,
      activePlaylist.value?.hiddenSources,
      musicStore.playlistsRevision.value
    ])
  ),
  resetSources: [],
  shouldResetOnSearch: computed(() => !!activePlaylist.value),
  debouncedSearchQuery: searchQuery
})
const visibleTracks = computed(() =>
  Array.from(
    { length: visibleRange.value.end - visibleRange.value.start },
    (_, index) => database.trackAt(visibleRange.value.start + index)
  )
)
watch(
  [visibleRange, databaseEnabled, () => databasePage.value.total],
  ([range, enabled, total]) => {
    if (enabled && activePlaylist.value && total !== null) database.setRange(range.start, range.end)
  },
  { flush: 'post' }
)
const {
  visibleGridSlots,
  gridDataRange,
  gridPaddingTop,
  gridPaddingBottom,
  gridRowStride,
  gridRowGap,
  showPlaylistCreateCard
} = useSongListGridRendering<PlaylistCard>({
  category: () => 'playlists',
  filter: () => null,
  transitionName: () => 'page-down',
  debouncedSearchQuery: computed(() => ''),
  currentGridItems: gridPlaylists,
  serverFiltered: databaseEnabled,
  itemCount: computed(() => databaseCards.value.total ?? 0),
  itemAt(index) {
    const item = database.cardAt(index)
    return item ? { ...item, pinnedAt: playlistPins.value.get(item.id) } : undefined
  },
  showGrid,
  updateViewportHeight,
  containerRef,
  scrollTop,
  viewportHeight
})
watch(
  [gridDataRange, databaseEnabled, () => databaseCards.value.total],
  ([range, enabled, total]) => {
    if (enabled && showGrid.value && total !== null) database.setCardRange(range.start, range.end)
  },
  { flush: 'post' }
)
// 这两个只在模板里以 ref="…" 字符串出现，vue-tsc 不把那当使用（SongList 同样处理）。
void containerRef.value
void tbodyRef.value

let locateViewport: import('../../utils/scrollToTopButton').ScrollViewport | undefined
useLocatePlayingTrack({
  containerRef,
  tbodyRef,
  displayTracks,
  currentTrack,
  enabled: computed(() => props.active && !!activePlaylist.value),
  rowHeight,
  playingRowSelector: '.is-playing',
  database: { enabled: databaseEnabled, query: database.query, read: useCoreLibraryApi().queryTracks,
    locate: (id, viewport) => { locateViewport = viewport; database.locate(id) } }
})
watch(
  () => databasePage.value.page,
  (page) => {
    if (page && page.anchorIndex !== undefined && page.anchorIndex >= 0)
      void nextTick(() => { scrollToTrack(page.anchorIndex!, locateViewport); locateViewport = undefined })
  },
  { flush: 'post' }
)

// ─── 音源展示 ──────────────────────────────────────────────────────────────
function sourceLabel(source: string): string {
  if (source === 'local') return '本地音乐'
  if (source === 'radio') return '电台'
  if (source === 'network') return '网络源'
  return providerStore.providers.value.find((provider) => provider.id === source)?.name ?? source
}

function sourceIcon(source: string): string {
  if (source === 'local') return 'pi pi-desktop'
  if (source === 'radio') return 'pi pi-wifi'
  if (source === 'network') return 'pi pi-server'
  return (
    providerStore.providers.value.find((provider) => provider.id === source)?.ui?.icon ||
    'pi pi-cloud'
  )
}

function playlistSourceSummary(playlist: PlaylistCard): string {
  if (playlist.sourceSummary) {
    const summary = playlist.sourceSummary,
      sources = [
        ...(summary.local ? [{ source: 'local', count: summary.local }] : []),
        ...summary.providers
      ]
    const label = sources.map((item) => `${sourceLabel(item.source)} ${item.count}`).join(' · ')
    return summary.additionalProviders
      ? `${label} · 另 ${summary.additionalProviders} 个音源`
      : label
  }
  return ''
}

// ─── 网格操作 ──────────────────────────────────────────────────────────────
function openPlaylist(playlistId: string): void {
  if (props.navigatePlaylist) props.navigatePlaylist(playlistId)
  else activePlaylistId.value = playlistId
  searchQuery.value = ''
  pendingDeleteId.value = null
}

function backToGrid(): void {
  if (props.returnFromDetail) props.returnFromDetail()
  else activePlaylistId.value = null
  database.closeVariants()
}

// 歌单详情 → 标题栏返回按钮回到网格；取代了原来详情头部的页内返回按钮。
useBackHandler(
  computed(() => props.active && activePlaylistId.value !== null),
  backToGrid,
  '返回聚合歌单列表'
)

async function togglePinned(playlistId: string, pinned: boolean, event: Event): Promise<void> {
  event.stopPropagation()
  await setPlaylistPinned(playlistId, !pinned)
}

/** 删除很难撤销，所以要点两次：第一下把按钮切成确认态。 */
async function requestDelete(playlistId: string, event: Event): Promise<void> {
  event.stopPropagation()
  if (pendingDeleteId.value !== playlistId) {
    pendingDeleteId.value = playlistId
    return
  }
  pendingDeleteId.value = null
  if (activePlaylistId.value === playlistId) activePlaylistId.value = null
  await deletePlaylist(playlistId)
}

function openCreateDialog(): void {
  showCreateDialog.value = true
}

function closeCreateDialog(): void {
  showCreateDialog.value = false
}

// ─── 详情操作 ──────────────────────────────────────────────────────────────
async function toggleSourceVisibility(source: string): Promise<void> {
  const playlist = activePlaylist.value
  if (!props.active || !playlist) return
  if (databaseSources.value.total === null) return
  const next = toggleHiddenSource(playlist.hiddenSources ?? [], source)
  // 全部音源都隐藏等于一个空歌单，拦下来并说明原因。
  if (new Set(next).size >= (databaseSources.value.total ?? 0)) {
    actionError.value = '至少要保留一个显示的音源'
    return
  }
  actionError.value = ''
  await setPlaylistHiddenSources(playlist.id, next)
}

function rowFor(track: Track) {
  const row = database.rowFor(track)?.meta
  return row ? { ...row, selectedVariant: { source: track.source ?? 'local' } } : undefined
}

function toggleVariantMenu(track: Track, event: Event): void {
  event.stopPropagation()
  database.openVariants(track)
}

async function chooseVariant(track: Track, source: string, event: Event): Promise<void> {
  event.stopPropagation()
  const playlist = activePlaylist.value
  database.closeVariants()
  const row = rowFor(track)
  if (!playlist || !row) return
  database.closeVariants()
  // 再点当前音源就是取消这一行的显式选择，回到默认优先级。
  await setPlaylistVariantPreference(
    playlist.id,
    row.anchorTrackId,
    row.selectedVariant.source === source && row.variantPinned ? null : source
  )
}

function closeOverlays(): void {
  database.closeVariants()
  pendingDeleteId.value = null
}

// 点页面别处收起浮层。挂在 window 上而不是根容器的 @click 上——根容器是布局，
// 不是点击目标，给它挂交互语义会连带惹上 hover 动效那套约定。
onMounted(() => {
  window.addEventListener('click', closeOverlays)
})

onUnmounted(() => {
  window.removeEventListener('click', closeOverlays)
})

function playRow(track: Track): void {
  if (!props.active) return
  const query = database.playbackQuery(track)
  if (query)
    void playerStore.playLibraryQuery(query, track.id, {
      onQueryFailure: (error) => database.recoverPlayback(query.playlistView!, error)
    })
}

function onRowClick(track: Track): void {
  if (settingsStore.settings.value.trackActivationMode === 'doubleClick') return
  playRow(track)
}

function onRowDoubleClick(track: Track): void {
  if (settingsStore.settings.value.trackActivationMode !== 'doubleClick') return
  playRow(track)
}

function onRowKeydown(track: Track, event: KeyboardEvent): void {
  if (trackRowKeyAction(event, false) === 'play') playRow(track)
}

async function removeRow(track: Track, event: Event): Promise<void> {
  event.stopPropagation()
  if (!props.active || !activePlaylist.value) return
  const result = await database.removalIds(track)
  if (result) await removeTracksFromPlaylistById(result.playlistId, result.ids)
}

function rowNumber(index: number): number {
  return visibleRange.value.start + index + 1
}
function variantMenuOpen(track: Track): boolean {
  return (
    databaseMenu.value?.rowId === database.rowFor(track)?.meta.rowId &&
    databaseMenu.value?.revision === database.rowFor(track)?.page.revision
  )
}
function rowVariants() {
  return (databaseVariants.value.page?.tracks ?? []).map((track) => ({
    source: track.source ?? 'local',
    track
  }))
}
function playAll(): void {
  if (!props.active) return
  const query = database.playbackQuery()
  if (query)
    void playerStore.playLibraryQuery(query, undefined, {
      onQueryFailure: (error) => database.recoverPlayback(query.playlistView!, error)
    })
}
</script>

<template>
  <div
    class="aggregate-page"
    :class="[`aggregate-surface-${props.surface}`, { 'has-player': props.hasPlayer }]"
  >
    <!-- ── 网格视图 ───────────────────────────────────────────────────── -->
    <template v-if="!activePlaylist">
      <header class="aggregate-header">
        <div class="aggregate-heading">
          <h2 class="aggregate-title">聚合歌单</h2>
          <p class="aggregate-subtitle">
            把本地和各流媒体的歌收进同一个歌单，同一首歌的多个音源合并成一行
          </p>
        </div>
        <button type="button" class="aggregate-primary-action" @click="openCreateDialog()">
          <i class="pi pi-plus"></i>
          <span>新建聚合歌单</span>
        </button>
      </header>

      <p v-if="databaseError" class="aggregate-notice" role="alert">
        {{ databaseError }} <button type="button" @click="retryDatabase">重试</button>
      </p>
      <p v-else-if="databasePending" class="aggregate-notice" role="status">正在读取聚合歌单…</p>
      <div ref="containerRef" class="aggregate-grid-scroller" @scroll="onScroll">
        <div
          v-if="databaseCards.total !== null"
          class="aggregate-grid card-grid"
        >
          <div
            v-if="gridPaddingTop > 0"
            class="aggregate-grid-spacer"
            :style="{ height: `${gridPaddingTop}px` }"
            aria-hidden="true"
          ></div>
          <button
            type="button"
            v-if="showPlaylistCreateCard"
            class="aggregate-card aggregate-create-card"
            data-te-interactive
            @click="openCreateDialog()"
          >
            <div class="aggregate-cover aggregate-cover-create">
              <ThemeIcon class="aggregate-cover-icon" icon-slot="library.add" />
            </div>
            <div class="aggregate-card-name">新建聚合歌单</div>
            <div class="aggregate-card-meta">跨音源收歌</div>
            <div class="aggregate-card-sources" aria-hidden="true">&nbsp;</div>
          </button>

          <template
            v-for="{ item: playlist, index } in visibleGridSlots"
            :key="playlist?.id ?? `slot:${index}`"
          >
            <div
              v-if="!playlist"
              class="aggregate-card-placeholder"
              :style="{ height: `${Math.max(1, gridRowStride - gridRowGap)}px` }"
              aria-hidden="true"
            ></div>
            <div
              v-else
              class="aggregate-card"
              role="button"
              tabindex="0"
              data-te-interactive
              :class="{ 'is-pinned': !!playlist.pinnedAt }"
              @click="openPlaylist(playlist.id)"
              @keydown.enter.prevent="openPlaylist(playlist.id)"
              @keydown.space.prevent="openPlaylist(playlist.id)"
            >
              <CoverImg
                v-if="playlist.cover"
                :cover="playlist.cover"
                class="aggregate-cover"
                alt="聚合歌单封面"
                loading="lazy"
              />
              <div v-else class="aggregate-cover aggregate-cover-placeholder">
                <i class="pi pi-sitemap aggregate-cover-icon"></i>
              </div>

              <div class="aggregate-card-name">
                <i v-if="playlist.pinnedAt" class="pi pi-thumbtack aggregate-pin-mark"></i>
                {{ playlist.name }}
              </div>
              <div class="aggregate-card-meta">
                {{ playlist.trackCount ?? 0 }} 首
              </div>
              <div class="aggregate-card-sources">
                {{ playlistSourceSummary(playlist) || '\u00a0' }}
              </div>

              <div class="aggregate-card-actions">
                <button
                  type="button"
                  class="aggregate-card-btn"
                  data-te-interactive
                  :title="playlist.pinnedAt ? '取消置顶' : '置顶'"
                  :aria-label="playlist.pinnedAt ? '取消置顶' : '置顶'"
                  @click="togglePinned(playlist.id, !!playlist.pinnedAt, $event)"
                >
                  <i class="pi pi-thumbtack"></i>
                </button>
                <button
                  type="button"
                  class="aggregate-card-btn aggregate-card-btn-danger"
                  data-te-interactive
                  :class="{ 'is-confirming': pendingDeleteId === playlist.id }"
                  :title="pendingDeleteId === playlist.id ? '再点一次确认删除' : '删除聚合歌单'"
                  :aria-label="
                    pendingDeleteId === playlist.id ? '再点一次确认删除' : '删除聚合歌单'
                  "
                  @click="requestDelete(playlist.id, $event)"
                >
                  <i class="pi pi-trash"></i>
                  <span v-if="pendingDeleteId === playlist.id">确认</span>
                </button>
              </div>
            </div>
          </template>
          <div
            v-if="gridPaddingBottom > 0"
            class="aggregate-grid-spacer"
            :style="{ height: `${gridPaddingBottom}px` }"
            aria-hidden="true"
          ></div>
        </div>
      </div>

      <p
        v-if="
          !databasePending &&
          !databaseError &&
          (databaseEnabled ? databaseCards.total === 0 : gridPlaylists.length === 0)
        "
        class="aggregate-empty"
      >
        还没有聚合歌单。新建一个之后，在本地或流媒体页右键任意歌曲就能加进来。
      </p>
    </template>

    <!-- ── 详情视图 ───────────────────────────────────────────────────── -->
    <template v-else>
      <header class="aggregate-header aggregate-detail-header">
        <div class="aggregate-heading">
          <h2 class="aggregate-title">
            <i v-if="activePlaylist.pinnedAt" class="pi pi-thumbtack aggregate-pin-mark"></i>
            {{ activePlaylist.name }}
          </h2>
          <p class="aggregate-subtitle">{{ detailStatsText }}</p>
        </div>
        <div class="aggregate-detail-tools">
          <button
            type="button"
            class="aggregate-primary-action"
            :disabled="databasePending || !!databaseError"
            @click="playAll"
          >
            播放全部
          </button>
          <AnimatedInput
            v-model="searchQuery"
            type="text"
            class="aggregate-search"
            placeholder="在聚合歌单内搜索"
            aria-label="在聚合歌单内搜索"
          />
          <button
            type="button"
            class="aggregate-card-btn"
            :title="activePlaylist.pinnedAt ? '取消置顶' : '置顶'"
            @click="togglePinned(activePlaylist.id, !!activePlaylist.pinnedAt, $event)"
          >
            <i class="pi pi-thumbtack"></i>
          </button>
        </div>
      </header>

      <div v-if="sourceFilters.length > 0" class="aggregate-source-filters" aria-label="音源筛选">
        <button
          v-for="item in sourceFilters"
          :key="item.source"
          type="button"
          class="aggregate-source-chip"
          data-te-interactive
          :class="{ 'is-hidden': item.hidden }"
          :aria-pressed="!item.hidden"
          :title="
            item.hidden ? `显示 ${sourceLabel(item.source)}` : `隐藏 ${sourceLabel(item.source)}`
          "
          @click.stop="toggleSourceVisibility(item.source)"
        >
          <i :class="item.hidden ? 'pi pi-eye-slash' : sourceIcon(item.source)"></i>
          <span>{{ sourceLabel(item.source) }}</span>
          <span class="aggregate-source-count">{{ item.count }}</span>
        </button>
      </div>

      <LibraryPager
        v-if="databaseEnabled && (databaseSources.total ?? 0) > 200"
        label="音源筛选"
        :page="databaseSources.requestedPage"
        :total="databaseSources.total"
        :loading="databaseSources.loading"
        @page="database.goToSourcePage"
      />
      <p v-if="databaseEnabled && databaseSources.error" class="aggregate-notice" role="alert">
        {{ databaseSources.error }}
        <button type="button" @click="database.retrySources">重试音源</button>
      </p>

      <p v-if="actionError" class="aggregate-notice" role="alert">{{ actionError }}</p>
      <p v-if="databaseEnabled && databaseAction.error" class="aggregate-notice" role="alert">
        {{ databaseAction.error }}
      </p>
      <p v-if="databaseError" class="aggregate-notice" role="alert">
        {{ databaseError }} <button type="button" @click="retryDatabase">重试</button>
      </p>
      <p v-else-if="databasePending" class="aggregate-notice" role="status">正在读取聚合歌单…</p>

      <div ref="containerRef" class="aggregate-table-wrapper" @scroll="onScroll">
        <table class="aggregate-table">
          <thead>
            <tr>
              <th class="col-index">#</th>
              <th class="col-cover"></th>
              <th class="col-info">标题</th>
              <th class="col-source">音源</th>
              <th class="col-album">专辑</th>
              <th class="col-duration">时长</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody
            ref="tbodyRef"
            :style="{ height: totalHeight + 'px', position: 'relative', display: 'block' }"
          >
            <tr class="aggregate-spacer" :style="{ height: paddingTop + 'px' }" aria-hidden="true">
              <td colspan="7"></td>
            </tr>
            <template
              v-for="(track, index) in visibleTracks"
              :key="
                track
                  ? databaseEnabled
                    ? database.rowFor(track)?.meta.rowId
                    : track.id
                  : `slot:${visibleRange.start + index}`
              "
            >
              <tr
                v-if="!track"
                class="aggregate-row aggregate-row-placeholder"
                :style="{ height: rowHeight + 'px', display: 'flex' }"
                aria-hidden="true"
              >
                <td class="col-index">{{ rowNumber(index) }}</td>
                <td class="col-info">{{ databaseError ? '读取失败，请重试' : '正在读取…' }}</td>
              </tr>
              <tr
                v-else
                class="aggregate-row"
                data-te-interactive
                tabindex="0"
                :aria-label="`${track.title} · ${track.artist}，按回车播放`"
                :aria-current="currentTrack?.id === track.id ? 'true' : undefined"
                :class="{ 'is-playing': currentTrack?.id === track.id }"
                :style="{ height: rowHeight + 'px', display: 'flex' }"
                @click="onRowClick(track)"
                @keydown="onRowKeydown(track, $event)"
                @dblclick="onRowDoubleClick(track)"
                @contextmenu.prevent.stop="toggleVariantMenu(track, $event)"
              >
                <td class="col-index">
                  <ThemeIcon
                    v-if="currentTrack?.id === track.id"
                    icon-slot="library.playing"
                    class="aggregate-playing-icon"
                  />
                  <span v-else>{{ rowNumber(Number(index)) }}</span>
                </td>
                <td class="col-cover">
                  <CoverImg
                    :identity="track.id"
                    :core-track-id="track.id"
                    class="aggregate-row-cover"
                    alt=""
                    loading="lazy"
                  />
                </td>
                <td class="col-info">
                  <span class="aggregate-row-title">{{ track.title }}</span>
                  <span class="aggregate-row-artist">{{ track.artist }}</span>
                  <span v-if="rowFor(track)?.preferenceUnavailable" class="aggregate-row-artist"
                    >偏好来源未载入，请选择音源</span
                  >
                </td>
                <td class="col-source">
                  <template v-if="rowFor(track)">
                    <button
                      type="button"
                      class="aggregate-variant-btn"
                      data-te-interactive
                      :class="{ 'is-pinned': rowFor(track)!.variantPinned }"
                      :title="
                        rowFor(track)!.visibleVariantCount > 1
                          ? '切换这一行使用的音源'
                          : sourceLabel(rowFor(track)!.selectedVariant.source)
                      "
                      @click="toggleVariantMenu(track, $event)"
                    >
                      <i :class="sourceIcon(rowFor(track)!.selectedVariant.source)"></i>
                      <span>{{ sourceLabel(rowFor(track)!.selectedVariant.source) }}</span>
                      <i
                        v-if="rowFor(track)!.visibleVariantCount > 1"
                        class="pi pi-angle-down aggregate-variant-caret"
                      ></i>
                    </button>
                    <div v-if="variantMenuOpen(track)" class="aggregate-variant-menu" @click.stop>
                      <button
                        v-for="(variant, variantIndex) in rowVariants()"
                        :key="`${variant.track.id}:${variantIndex}`"
                        type="button"
                        class="aggregate-variant-option"
                        data-te-interactive
                        :class="{
                          'is-selected': variant.source === rowFor(track)!.selectedVariant.source
                        }"
                        @click="chooseVariant(track, variant.source, $event)"
                      >
                        <i :class="sourceIcon(variant.source)"></i>
                        <span>{{ sourceLabel(variant.source) }}</span>
                        <span
                          v-if="
                            variant.track.format &&
                            ['flac', 'alac', 'wav', 'ape', 'aiff', 'dsf', 'dff'].includes(
                              variant.track.format.toLowerCase()
                            )
                          "
                          class="aggregate-variant-tag"
                          >无损</span
                        >
                        <i
                          v-if="variant.source === rowFor(track)!.selectedVariant.source"
                          class="pi pi-check aggregate-variant-check"
                        ></i>
                      </button>
                      <template v-if="databaseEnabled">
                        <p v-if="databaseVariants.loading" role="status">正在读取音源…</p>
                        <p v-if="databaseVariants.error" role="alert">
                          {{ databaseVariants.error }}
                          <button type="button" @click="database.retryVariants">重试</button>
                        </p>
                        <LibraryPager
                          v-if="(databaseVariants.total ?? 0) > 200"
                          label="录音音源"
                          :page="databaseVariants.requestedPage"
                          :total="databaseVariants.total"
                          :loading="databaseVariants.loading"
                          @page="database.goToVariantPage"
                        />
                      </template>
                    </div>
                  </template>
                </td>
                <td class="col-album">{{ track.album }}</td>
                <td class="col-duration">{{ formatDuration(track.duration) }}</td>
                <td class="col-actions">
                  <button
                    type="button"
                    class="aggregate-row-remove"
                    data-te-interactive
                    title="从聚合歌单移除（含这首歌的全部音源）"
                    aria-label="从聚合歌单移除"
                    :disabled="databaseEnabled && databaseAction.pending"
                    @click="removeRow(track, $event)"
                  >
                    <i class="pi pi-times"></i>
                  </button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <p
          v-if="!databasePending && !databaseError && tableTrackCount === 0"
          class="aggregate-empty"
        >
          {{
            (databasePage.page?.aggregate?.memberCount ?? 0) === 0
              ? '这个聚合歌单还是空的。在本地或流媒体页右键歌曲，选“添加到聚合歌单”。'
              : '当前筛选下没有可显示的歌曲，试试取消隐藏某个音源。'
          }}
        </p>
      </div>
    </template>

    <!-- ── 新建对话框 ─────────────────────────────────────────────────── -->
    <CreateAggregatePlaylistDialog
      :show="showCreateDialog"
      :tracks="[]"
      @close="closeCreateDialog"
      @created="openPlaylist($event)"
    />
  </div>
</template>

<style scoped src="./AggregatePlaylistPage.css"></style>
