<script setup lang="ts">
import { PLAYLIST_EXPORT_FORMATS } from '@renderer/utils/playlistExport.ts'
import type { PlaylistFileFormat } from '@renderer/utils/playlistLifecycle.ts'

const exportFormat = defineModel<PlaylistFileFormat>('exportFormat', { required: true })
defineProps<{ repairPending: boolean }>()
const emit = defineEmits<{
  rename: []
  copy: []
  cover: []
  import: []
  export: []
  repair: []
}>()
</script>

<template>
  <div class="playlist-lifecycle-actions" role="group" aria-label="歌单操作">
    <div class="playlist-action-group">
      <button type="button" title="重命名歌单" aria-label="重命名歌单" @click="emit('rename')">
        <i class="pi pi-pencil" aria-hidden="true"></i>
      </button>
      <button type="button" title="复制歌单" aria-label="复制歌单" @click="emit('copy')">
        <i class="pi pi-copy" aria-hidden="true"></i>
      </button>
      <button type="button" title="设置歌单封面" aria-label="设置歌单封面" @click="emit('cover')">
        <i class="pi pi-image" aria-hidden="true"></i>
      </button>
    </div>
    <div class="playlist-action-group">
      <button
        type="button"
        title="导入 M3U、M3U8 或 PLS"
        aria-label="导入歌单"
        @click="emit('import')"
      >
        <i class="pi pi-file-import" aria-hidden="true"></i>
      </button>
      <div class="playlist-export-controls">
        <label class="playlist-export-format" title="选择导出歌单格式">
          <select v-model="exportFormat" aria-label="导出歌单格式">
            <option
              v-for="option in PLAYLIST_EXPORT_FORMATS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <i class="pi pi-chevron-down" aria-hidden="true"></i>
        </label>
        <button
          type="button"
          :title="`导出 ${exportFormat.toUpperCase()}`"
          :aria-label="`导出 ${exportFormat.toUpperCase()} 歌单`"
          @click="emit('export')"
        >
          <i class="pi pi-download" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div class="playlist-action-group">
      <button
        type="button"
        title="扫描文件夹并批量重新定位缺失文件"
        :aria-label="repairPending ? '正在重新定位缺失文件' : '重新定位缺失文件'"
        :aria-busy="repairPending"
        :disabled="repairPending"
        @click="emit('repair')"
      >
        <i
          :class="repairPending ? 'pi pi-spin pi-spinner' : 'pi pi-map-marker'"
          aria-hidden="true"
        ></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.playlist-lifecycle-actions {
  --playlist-control-size: max(34px, calc(var(--te-font-size-body, 14px) * 2.5));
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
}

.playlist-action-group,
.playlist-export-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.playlist-action-group + .playlist-action-group {
  padding-inline-start: 8px;
  border-inline-start: 1px solid var(--te-card-border);
}

button,
select {
  box-sizing: border-box;
  height: var(--playlist-control-size);
  margin: 0;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-700);
  cursor: pointer;
}

button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--playlist-control-size);
  padding: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 1.14286);
  line-height: 1;
}

.playlist-export-controls {
  gap: 0;
}

.playlist-export-format {
  position: relative;
  display: inline-flex;
  align-items: center;
}

select {
  appearance: none;
  min-width: calc(var(--te-font-size-body, 14px) * 5.5);
  padding: 0 26px 0 10px;
  border-radius: 8px 0 0 8px;
  font-family: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 0.92857);
  font-weight: 600;
}

option {
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
}

.playlist-export-format i {
  position: absolute;
  right: 9px;
  color: var(--te-neutral-500);
  font-size: 10px;
  pointer-events: none;
}

.playlist-export-controls button {
  margin-inline-start: -1px;
  border-radius: 0 8px 8px 0;
}

button:focus-visible,
select:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}

@media (hover: hover) {
  button:hover:not(:disabled),
  select:hover {
    border-color: color-mix(in srgb, var(--te-primary-500) 40%, var(--te-card-border));
    background: var(--te-hover-bg);
    color: var(--te-neutral-900);
  }
}

button:active:not(:disabled) {
  transform: scale(0.97);
  background: var(--te-active-bg);
}

button:disabled {
  cursor: wait;
  opacity: 0.45;
}

:global(html[data-te-motion='reduced']) button:active,
:global(html[data-te-motion='off']) button:active {
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  button:active:not(:disabled) {
    transform: none;
  }
}
</style>
