<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ProviderDownloadTaskSnapshot } from '../../../../shared/providerDownloads'
import { useMusicStore } from '../../stores/useMusicStore'
import { normalizePortableLibraryPath } from '../../stores/library/musicStoreData'
const props = defineProps<{ task: ProviderDownloadTaskSnapshot }>()
const music = useMusicStore()
const pending = ref(false)
const error = ref('')
const submitted = ref(false)
const indexed = computed(() =>
  music.tracks.value.some(
    (t) =>
      normalizePortableLibraryPath(t.filePath) ===
      normalizePortableLibraryPath(props.task.targetPath || '')
  )
)
async function act(action: 'play' | 'reveal' | 'add') {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const filePath = await window.api.providerDownloads.result(props.task.id, action === 'add')
    if (action === 'add') submitted.value = true
    if (action === 'reveal') await window.api.shell.showItemInFolder(filePath)
    if (action === 'play') {
      const { usePlayerStore } = await import('../../stores/usePlayerStore')
      const track = music.tracks.value.find(
        (t) => normalizePortableLibraryPath(t.filePath) === normalizePortableLibraryPath(filePath)
      ) ?? {
        id: `download:${props.task.id}`,
        source: 'local',
        title: props.task.track.title,
        artist: props.task.track.artist,
        album: props.task.track.album || '',
        filePath,
        fileName: filePath.split(/[\\/]/).pop() || '',
        duration: 0,
        size: props.task.fileSize || 0,
        cover: null,
        lyrics: null
      }
      await usePlayerStore().playTrack(track, [track])
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败，请重试'
  } finally {
    pending.value = false
  }
}
</script>
<template>
  <div class="download-results">
    <small>{{
      indexed ? '已在曲库' : submitted ? '已提交索引；稍后可在曲库查看' : '尚未在曲库索引中'
    }}</small>
    <div>
      <button type="button" :disabled="pending" @click="act('play')">播放本地文件</button
      ><button type="button" :disabled="pending" @click="act('reveal')">打开目录</button
      ><button
        v-if="!indexed"
        type="button"
        :disabled="pending"
        title="复制到第一个音乐库目录；原文件保留"
        @click="act('add')"
      >
        {{ submitted ? '重新索引' : '加入曲库（复制）' }}
      </button>
    </div>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
<style scoped>
.download-results {
  display: grid;
  gap: 8px;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
.download-results > div {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.download-results small {
  font-size: var(--te-type-caption);
  line-height: 1.5;
}
button {
  font: inherit;
  font-size: var(--te-type-caption);
  cursor: pointer;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  padding: 7px 12px;
  min-height: max(var(--te-control-height-md), 2.5em);
}
button:hover {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
</style>
