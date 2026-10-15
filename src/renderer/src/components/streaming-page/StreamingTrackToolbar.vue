<script setup lang="ts">
import { ref } from 'vue'
import type {
  StreamingTrackSort,
  StreamingSortDirection
} from '@renderer/components/streaming-page/streamingTrackView'

defineProps<{
  query: string
  sort: StreamingTrackSort
  direction: StreamingSortDirection
  count: number
  total: number
  refreshing?: boolean
  canLocate: boolean
}>()
const emit = defineEmits<{
  'update:query': [value: string]
  'update:sort': [value: StreamingTrackSort]
  'update:direction': [value: StreamingSortDirection]
  refresh: []
  locate: []
}>()
const searchInput = ref<HTMLInputElement | null>(null)
function clearQuery(): void {
  emit('update:query', '')
  searchInput.value?.focus()
}
</script>

<template>
  <div class="track-tools" role="region" aria-label="歌单检索与排序">
    <label class="track-search">
      <i class="pi pi-search" aria-hidden="true"></i>
      <input
        ref="searchInput"
        type="search"
        :value="query"
        placeholder="在歌单中搜索"
        aria-label="搜索当前歌单的歌曲、歌手或专辑"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
      <button v-if="query" type="button" aria-label="清除歌单搜索" @click="clearQuery">
        <i class="pi pi-times" aria-hidden="true"></i>
      </button>
    </label>
    <span class="track-count" aria-live="polite"
      >{{ count }}<span v-if="count !== total"> / {{ total }}</span> 首</span
    >
    <span v-if="refreshing" class="tool-status" role="status">正在刷新…</span>
    <div class="track-tool-actions">
      <select
        :value="sort"
        aria-label="歌单排序方式"
        @change="
          emit('update:sort', ($event.target as HTMLSelectElement).value as StreamingTrackSort)
        "
      >
        <option value="default">默认顺序</option>
        <option value="title">歌曲名称</option>
        <option value="artist">歌手</option>
        <option value="album">专辑</option>
        <option value="duration">时长</option>
      </select>
      <button
        type="button"
        :disabled="sort === 'default'"
        :title="direction === 'asc' ? '升序，点击切换降序' : '降序，点击切换升序'"
        :aria-label="direction === 'asc' ? '切换降序' : '切换升序'"
        @click="emit('update:direction', direction === 'asc' ? 'desc' : 'asc')"
      >
        <i
          :class="direction === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down'"
          aria-hidden="true"
        ></i>
      </button>
      <span class="tool-divider" aria-hidden="true"></span>
      <button
        type="button"
        :disabled="!canLocate"
        title="定位正在播放的歌曲（清除搜索）"
        aria-label="定位正在播放的歌曲"
        @click="emit('locate')"
      >
        <i class="pi pi-map-marker" aria-hidden="true"></i>
      </button>
      <button
        type="button"
        :disabled="refreshing"
        :title="refreshing ? '正在刷新歌单…' : '刷新歌单'"
        :aria-label="refreshing ? '正在刷新歌单…' : '刷新歌单'"
        :aria-busy="refreshing"
        @click="emit('refresh')"
      >
        <i :class="['pi pi-refresh', { 'pi-spin': refreshing }]" aria-hidden="true"></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.track-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
  color: var(--te-settings-text-muted);
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body);
  line-height: var(--te-type-line-body);
}
.track-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 240px;
  min-width: 0;
  max-width: 420px;
  min-height: var(--te-control-height-field);
  padding: 6px 12px;
  border: 1px solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-subtle-bg);
}
.track-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: none;
  color: var(--te-settings-text);
  background: transparent;
  font: inherit;
}
.track-search input::-webkit-search-cancel-button {
  -webkit-appearance: none;
}
.track-count,
.tool-status {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  font-variant-numeric: tabular-nums;
}
.track-tool-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
button,
select {
  min-height: var(--te-control-height-md);
  max-width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  color: var(--te-settings-text);
  background: var(--te-subtle-bg);
  font: inherit;
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
  cursor: pointer;
}
button {
  width: max(34px, calc(var(--te-font-size-body) * 2));
  flex-shrink: 0;
}
.track-search button {
  border: 0;
  background: transparent;
}
button:hover:enabled {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
.track-search:focus-within {
  outline: var(--te-control-focus-width) solid var(--te-control-focus-color);
  outline-offset: var(--te-control-focus-offset);
}
.tool-divider {
  height: 20px;
  width: 1px;
  background: var(--te-card-border);
  margin-inline: 4px;
}
</style>
