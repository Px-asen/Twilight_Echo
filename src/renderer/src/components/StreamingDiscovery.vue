<script setup lang="ts">
import { computed } from 'vue'
import { useBoundedGrid } from '@renderer/composables/useBoundedGrid'
import type {
  MediaProviderPlaylistCatalogue,
  MediaProviderPlaylistSummary
} from '../providers/mediaProvider'
import type { DiscoveryOrder } from './streaming-page/useStreamingDiscovery'
import type { PageState } from './streaming-page/types'
import CoverImg from './CoverImg.vue'
import SettingsDisclosure from './settings-page/SettingsDisclosure.vue'

const props = defineProps<{
  providerLabel: string
  supportsSort?: boolean
  supportsCategories: boolean
  supportsHighQuality: boolean
  catalogue: MediaProviderPlaylistCatalogue | null
  catalogueLoading: boolean
  catalogueError: string
  selectedTag: string
  order: DiscoveryOrder
  highQuality: boolean
  panelExpanded: boolean
  playlists: MediaProviderPlaylistSummary[]
  total: number
  offset: number
  hasMore: boolean
  listLoading: boolean
  listError: string
  loadingMore: boolean
}>()

const emit = defineEmits<{
  selectTag: [name: string]
  setOrder: [order: DiscoveryOrder]
  toggleHighQuality: []
  togglePanel: []
  pageChange: [event: PageState]
  loadMore: []
  openPlaylist: [playlist: MediaProviderPlaylistSummary]
  retry: []
}>()

const pageSize = 30

// ─── Masthead copy ──────────────────────────────────────────────────────────

const headline = computed(() => {
  if (props.highQuality) return '精品歌单'
  return props.selectedTag === '全部' ? '全部歌单' : props.selectedTag
})

const totalLabel = computed(() => props.total.toLocaleString('zh-Hans-CN'))

const subline = computed(() => {
  if (props.listLoading && props.playlists.length === 0) return '正在为你整理歌单…'
  if (props.listError && props.playlists.length === 0) return '加载遇到了一点问题'
  if (props.total > 0) {
    if (props.highQuality) return `${props.providerLabel} 精选 · 共 ${totalLabel.value} 张`
    if (props.supportsSort === false) return `共 ${totalLabel.value} 张歌单`
    return `共 ${totalLabel.value} 张歌单 · 按${props.order === 'hot' ? '最热' : '最新'}排列`
  }
  return '按分类浏览歌单'
})

// ─── Channel rail ───────────────────────────────────────────────────────────

const railTags = computed(() => {
  const hot = props.catalogue?.hotTags ?? []
  const tags = ['全部', ...hot.filter((tag) => tag !== '全部')]
  return tags.slice(0, 13)
})

const isSelectedTagInRail = computed(() => railTags.value.includes(props.selectedTag))

// ─── Mosaic ─────────────────────────────────────────────────────────────────

const { setGridElement: playlistGrid, gridStyle: playlistGridStyle } = useBoundedGrid(
  () => props.playlists.length || 10
)

// ─── Pagination ─────────────────────────────────────────────────────────────

const currentPage = computed(() => Math.floor(props.offset / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / pageSize)))
const showPaginator = computed(
  () =>
    !props.highQuality &&
    !props.listLoading &&
    props.playlists.length > 0 &&
    (props.total > pageSize || (props.total === 0 && (props.hasMore || props.offset > 0)))
)

function formatPlayCount(playCount: number | undefined): string {
  if (typeof playCount !== 'number' || !Number.isFinite(playCount) || playCount <= 0) return ''
  if (playCount >= 100_000_000) return `${(playCount / 100_000_000).toFixed(1)} 亿`
  if (playCount >= 10_000) return `${Math.round(playCount / 10_000)} 万`
  return String(playCount)
}

function emitPage(nextOffset: number): void {
  const first = Math.max(0, nextOffset)
  emit('pageChange', { first, rows: pageSize })
}
</script>

<template>
  <div class="disc" :aria-busy="listLoading || loadingMore">
    <!-- ── Masthead ──────────────────────────────────────────────────── -->
    <header class="disc-masthead">
      <div class="disc-masthead-copy">
        <p class="disc-kicker">{{ providerLabel }} · 发现歌单</p>
        <Transition name="disc-headline" mode="out-in">
          <h1 :key="headline" class="disc-title">{{ headline }}</h1>
        </Transition>
        <p class="disc-sub">{{ subline }}</p>
      </div>

      <div class="disc-tools">
        <div
          v-if="!highQuality && supportsSort !== false"
          class="disc-order"
          role="group"
          aria-label="排序方式"
        >
          <button
            type="button"
            class="disc-order-btn"
            data-te-interactive
            :class="{ active: order === 'hot' }"
            :aria-pressed="order === 'hot'"
            @click="emit('setOrder', 'hot')"
          >
            最热
          </button>
          <button
            type="button"
            class="disc-order-btn"
            data-te-interactive
            :class="{ active: order === 'new' }"
            :aria-pressed="order === 'new'"
            @click="emit('setOrder', 'new')"
          >
            最新
          </button>
        </div>
        <button
          v-if="supportsHighQuality"
          type="button"
          class="disc-hq"
          data-te-interactive
          :class="{ active: highQuality }"
          :aria-pressed="highQuality"
          @click="emit('toggleHighQuality')"
        >
          <i class="pi pi-crown"></i>
          <span>精品</span>
        </button>
      </div>
    </header>

    <!-- ── Channel rail ─────────────────────────────────────────────── -->
    <nav v-if="supportsCategories" class="disc-rail" role="group" aria-label="热门歌单标签">
      <button
        v-for="tag in railTags"
        :key="tag"
        type="button"
        class="disc-chip"
        data-te-interactive
        :aria-pressed="selectedTag === tag && !highQuality"
        :class="{ active: selectedTag === tag && !highQuality }"
        @click="emit('selectTag', tag)"
      >
        {{ tag }}
      </button>
      <button
        v-if="!isSelectedTagInRail"
        type="button"
        class="disc-chip active"
        data-te-interactive
        @click="emit('togglePanel')"
      >
        {{ selectedTag }}
      </button>
      <button
        type="button"
        class="disc-chip disc-chip-more"
        aria-controls="discovery-categories"
        data-te-interactive
        :class="{ open: panelExpanded }"
        :aria-expanded="panelExpanded"
        @click="emit('togglePanel')"
      >
        <span>全部分类</span>
        <i class="pi pi-chevron-down disc-chip-caret"></i>
      </button>
    </nav>

    <!-- ── Category atlas ───────────────────────────────────────────── -->
    <SettingsDisclosure
      :open="panelExpanded"
      tag="section"
      boundary=".disc"
      trigger-selector='[aria-controls="discovery-categories"]'
      id="discovery-categories"
      class="disc-atlas"
      aria-label="全部歌单分类"
    >
      <div v-if="catalogueLoading" class="disc-atlas-status">
        <i class="pi pi-spin pi-spinner"></i>
        <span>正在加载分类…</span>
      </div>
      <div v-else-if="catalogueError" class="disc-atlas-status">
        <span>{{ catalogueError }}</span>
        <button type="button" class="disc-ghost-btn" data-te-interactive @click="emit('retry')">
          重试
        </button>
      </div>
      <template v-else>
        <div v-for="group in catalogue?.groups ?? []" :key="group.id" class="disc-atlas-group">
          <p class="disc-atlas-name">{{ group.name }}</p>
          <div class="disc-atlas-tags">
            <button
              v-for="tag in group.tags"
              :key="tag.name"
              type="button"
              class="disc-atlas-chip"
              data-te-interactive
              :class="{ active: selectedTag === tag.name, hot: tag.hot }"
              :aria-pressed="selectedTag === tag.name"
              @click="emit('selectTag', tag.name)"
            >
              {{ tag.name }}
            </button>
          </div>
        </div>
      </template>
    </SettingsDisclosure>

    <!-- ── Skeleton ─────────────────────────────────────────────────── -->
    <div
      v-if="listLoading && playlists.length === 0"
      :ref="playlistGrid"
      class="disc-mosaic"
      :style="playlistGridStyle"
      role="status"
      aria-label="正在加载歌单"
    >
      <div v-for="i in 10" :key="i" class="disc-sk-tile">
        <div class="disc-sk-cover disc-shimmer"></div>
        <div class="disc-sk-line disc-shimmer"></div>
        <div class="disc-sk-line disc-sk-line-short disc-shimmer"></div>
      </div>
    </div>

    <!-- ── Error ────────────────────────────────────────────────────── -->
    <div v-else-if="listError && playlists.length === 0" class="disc-state" role="alert">
      <span class="disc-state-icon"><i class="pi pi-exclamation-triangle"></i></span>
      <p class="disc-state-title">歌单加载失败</p>
      <p class="disc-state-hint">{{ listError }}</p>
      <button type="button" class="disc-ink-btn" data-te-interactive @click="emit('retry')">
        <i class="pi pi-refresh"></i>
        再试一次
      </button>
    </div>

    <!-- ── Empty ────────────────────────────────────────────────────── -->
    <div v-else-if="playlists.length === 0" class="disc-state">
      <span class="disc-state-icon"><i class="pi pi-inbox"></i></span>
      <p class="disc-state-title">暂无歌单</p>
      <p class="disc-state-hint">尝试其他分类，或稍后重新加载</p>
    </div>

    <!-- ── Mosaic wall ──────────────────────────────────────────────── -->
    <div v-else class="disc-results" :class="{ 'is-refreshing': listLoading }">
      <p v-if="listError" class="disc-atlas-status" role="status">
        {{ listError }}
        <button type="button" class="disc-ghost-btn" @click="emit('retry')">重试</button>
      </p>
      <div :ref="playlistGrid" class="disc-mosaic" :style="playlistGridStyle">
        <article
          v-for="playlist in playlists"
          :key="playlist.id"
          class="disc-card"
          data-te-interactive
          role="button"
          tabindex="0"
          :aria-label="`打开歌单 ${playlist.name}`"
          @click="emit('openPlaylist', playlist)"
          @keydown.enter.self.prevent="emit('openPlaylist', playlist)"
          @keydown.space.self.prevent="emit('openPlaylist', playlist)"
        >
          <div class="disc-card-media">
            <CoverImg
              v-if="playlist.coverSmall || playlist.cover"
              :cover="playlist.coverSmall || playlist.cover"
              :cover-source="playlist.coverSmallSource || playlist.coverSource"
              class="disc-card-img"
              alt=""
            />
            <span v-else class="disc-card-empty"><i class="pi pi-list"></i></span>
            <span v-if="formatPlayCount(playlist.playCount)" class="disc-card-plays">
              <i class="pi pi-headphones"></i>
              {{ formatPlayCount(playlist.playCount) }}
            </span>
            <span class="disc-card-go" aria-hidden="true">
              <i class="pi pi-arrow-up-right"></i>
            </span>
          </div>
          <p class="disc-card-name" :title="playlist.name">{{ playlist.name }}</p>
          <p class="disc-card-meta">
            {{ playlist.trackCount }} 首{{
              playlist.creatorName ? ` · ${playlist.creatorName}` : ''
            }}
            <span v-if="formatPlayCount(playlist.playCount)">
              · {{ formatPlayCount(playlist.playCount) }} 次播放</span
            >
          </p>
        </article>
      </div>

      <!-- ── Footer: pager / load more ──────────────────────────────── -->
      <footer v-if="showPaginator" class="disc-pager">
        <button
          type="button"
          class="disc-pager-btn"
          data-te-interactive
          aria-label="上一页"
          :disabled="offset <= 0"
          @click="emitPage(offset - pageSize)"
        >
          <i class="pi pi-arrow-left"></i>
        </button>
        <span class="disc-pager-text">
          第 <em>{{ currentPage }}</em> 页<span v-if="total > 0"> · 共 {{ pageCount }} 页</span>
        </span>
        <button
          type="button"
          class="disc-pager-btn"
          data-te-interactive
          aria-label="下一页"
          :disabled="!hasMore"
          @click="emitPage(offset + pageSize)"
        >
          <i class="pi pi-arrow-right"></i>
        </button>
      </footer>

      <footer v-else-if="highQuality && hasMore" class="disc-pager">
        <button
          type="button"
          class="disc-more-btn"
          data-te-interactive
          :disabled="loadingMore"
          @click="emit('loadMore')"
        >
          <i v-if="loadingMore" class="pi pi-spin pi-spinner"></i>
          <span>{{ loadingMore ? '正在加载…' : '继续发掘精品' }}</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.disc {
  min-width: 0;
  container-type: inline-size;
  color: var(--te-text);
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body);
}
.disc :is(h1, p) {
  margin: 0;
}
.disc button {
  font: inherit;
  cursor: pointer;
}
.disc button:disabled {
  opacity: 0.5;
  cursor: default;
}
.disc :is(button, [role='button']):focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
.disc-masthead {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px 24px;
  margin-bottom: 16px;
}
.disc-masthead-copy {
  min-width: 0;
}
.disc-kicker,
.disc-sub {
  color: var(--te-text-secondary);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
.disc-title {
  font-size: var(--te-type-section-title);
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
  margin: 4px 0 !important;
}
.disc-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.disc-order {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.disc-order-btn,
.disc-hq,
.disc-chip,
.disc-atlas-chip,
.disc-ghost-btn,
.disc-ink-btn,
.disc-more-btn,
.disc-pager-btn {
  min-height: var(--te-control-height-md);
  border: 0;
  border-radius: var(--te-control-radius-sm);
  padding: 7px 12px;
  font-size: var(--te-type-caption) !important;
  font-weight: 400;
  line-height: 1.5;
  color: var(--te-text-secondary);
  background: transparent;
}
.disc-order-btn.active,
.disc-hq.active,
.disc-chip.active,
.disc-atlas-chip.active {
  color: var(--te-text);
  background: var(--te-subtle-bg);
  font-weight: 500;
}
.disc
  :is(
    .disc-order-btn,
    .disc-hq,
    .disc-chip,
    .disc-atlas-chip,
    .disc-ghost-btn,
    .disc-pager-btn
  ):hover:enabled {
  color: var(--te-text);
  background: var(--te-subtle-bg);
}
.disc-hq,
.disc-chip-more {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.disc-rail {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 0 16px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--te-card-border);
}
.disc-chip-caret {
  font-size: 0.8em;
}
.disc-atlas {
  margin: 0 0 24px;
  padding: 0 0 16px;
  border-bottom: 1px solid var(--te-card-border);
}
.disc-atlas-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
  padding: 12px 0;
}
.disc-atlas-group {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
  padding: 8px 0;
}
.disc-atlas-name {
  font-size: var(--te-type-caption);
  line-height: 1.5;
  font-weight: 500;
  padding-top: 7px;
}
.disc-atlas-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.disc-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 24px 0;
}
.disc-state-icon {
  display: none;
}
.disc-state-title {
  font-size: var(--te-type-headline);
  font-weight: 600;
  line-height: 1.4;
}
.disc-state-hint {
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.disc-ink-btn,
.disc-more-btn {
  color: var(--te-text);
  background: var(--te-subtle-bg);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.disc-mosaic {
  display: grid;
  min-width: 0;
}
.disc-card {
  min-width: 0;
  cursor: pointer;
  border-radius: 0;
}
.disc-card-media {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 6px;
  background: var(--te-subtle-bg);
  transition: filter var(--te-motion-hover);
}
.disc-card:is(:hover, :focus-visible) .disc-card-media {
  filter: brightness(0.96);
}
.disc-card-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.disc-card-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--te-text-secondary);
}
.disc-card-plays {
  display: none;
}
.disc-card-go {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--te-card-bg-solid, var(--te-settings-control-bg));
  color: var(--te-control-fg);
  opacity: 0;
  transition: opacity var(--te-motion-hover);
}
.disc-card:is(:hover, :focus-visible) .disc-card-go {
  opacity: 1;
}
.disc-card-name {
  margin-top: 8px !important;
  font-size: var(--te-type-body);
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.disc-card-meta {
  margin-top: 4px !important;
  font-size: var(--te-type-caption);
  line-height: 1.5;
  color: var(--te-text-secondary);
  overflow-wrap: anywhere;
}
.disc-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  margin-top: 24px;
}
.disc-pager-text {
  font-size: var(--te-type-caption);
  color: var(--te-text-secondary);
  line-height: 1.5;
}
.disc-pager-text em {
  font-style: normal;
  font-variant-numeric: tabular-nums;
}
.disc-sk-cover {
  width: 100%;
  aspect-ratio: 1;
  background: var(--te-subtle-bg);
  border-radius: 6px;
}
.disc-sk-line {
  height: 16px;
  margin-top: 8px;
  width: 80%;
  background: var(--te-subtle-bg);
  border-radius: 4px;
}
.disc-sk-line-short {
  width: 55%;
}
@container (max-width:480px) {
  .disc-atlas-group {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}
</style>
