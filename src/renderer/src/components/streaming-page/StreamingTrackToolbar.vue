<script setup lang="ts">
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
</script>

<template>
  <div class="track-tools" role="region" aria-label="歌单检索与排序">
    <label class="track-search">
      <i class="pi pi-search" aria-hidden="true"></i>
      <input
        :value="query"
        placeholder="在歌单中搜索"
        aria-label="搜索当前歌单的歌曲、歌手或专辑"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      />
      <button
        v-if="query"
        type="button"
        aria-label="清除歌单搜索"
        @click="emit('update:query', '')"
      >
        <i class="pi pi-times" aria-hidden="true"></i>
      </button>
    </label>
    <span class="track-count" aria-live="polite"
      >{{ count }}<span v-if="count !== total"> / {{ total }}</span> 首</span
    >
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
      <span class="tool-divider"></span>
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
        title="刷新歌单"
        aria-label="刷新歌单"
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
  padding: 12px;
  border: 1px solid var(--stage-line);
  border-radius: 14px;
  background: var(--stage-paper-raised);
  color: var(--stage-ink-soft);
}
.track-search {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 180px;
  min-width: 140px;
  padding-left: 10px;
}
.track-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: none;
  color: var(--stage-ink);
  background: transparent;
  font: inherit;
}
.track-search:focus-within {
  color: var(--stage-accent);
}
.track-count {
  font-size: 0.8em;
  color: var(--stage-ink-soft);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.track-tool-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
button,
select {
  height: 34px;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
button {
  width: 34px;
  flex-shrink: 0;
}
select {
  max-width: 120px;
  padding: 0 8px;
  background: var(--stage-paper);
  color: var(--stage-ink);
}
button:hover:enabled {
  color: var(--stage-accent);
  background: var(--stage-accent-soft);
}
button:active:enabled {
  transform: scale(0.97);
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
.track-search:focus-within {
  outline: 2px solid var(--stage-accent);
  outline-offset: 3px;
  border-radius: 8px;
}
.tool-divider {
  height: 16px;
  width: 1px;
  background: var(--stage-line-strong);
  margin: 0 4px;
}
@media (max-width: 900px) {
  .track-tool-actions {
    margin-left: auto;
  }
}
</style>
