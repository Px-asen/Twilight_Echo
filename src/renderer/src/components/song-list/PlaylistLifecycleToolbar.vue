<script setup lang="ts">
import PageActionMenu from '../PageActionMenu.vue'
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
  <PageActionMenu label="管理歌单" :busy="repairPending">
    <button type="button" @click="emit('rename')">
      <i class="pi pi-pencil" aria-hidden="true" />重命名歌单
    </button>
    <button type="button" @click="emit('copy')">
      <i class="pi pi-copy" aria-hidden="true" />复制歌单
    </button>
    <button type="button" @click="emit('cover')">
      <i class="pi pi-image" aria-hidden="true" />设置歌单封面
    </button>
    <button type="button" @click="emit('import')">
      <i class="pi pi-file-import" aria-hidden="true" />导入歌单
    </button>
    <label class="playlist-export-choice"
      >导出格式
      <select v-model="exportFormat" aria-label="导出歌单格式">
        <option v-for="option in PLAYLIST_EXPORT_FORMATS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </label>
    <button type="button" @click="emit('export')">
      <i class="pi pi-download" aria-hidden="true" />导出 {{ exportFormat.toUpperCase() }} 歌单
    </button>
    <button
      type="button"
      :disabled="repairPending"
      :aria-busy="repairPending"
      @click="emit('repair')"
    >
      <i class="pi pi-map-marker" aria-hidden="true" />{{
        repairPending ? '正在重新定位缺失文件' : '重新定位缺失文件'
      }}
    </button>
  </PageActionMenu>
</template>
<style scoped>
.playlist-export-choice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px;
  margin-top: 6px;
  border-top: 1px solid var(--te-card-border);
  color: var(--te-neutral-500);
}
select {
  min-height: 32px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  padding: 4px 8px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-900);
  font: inherit;
}
</style>
