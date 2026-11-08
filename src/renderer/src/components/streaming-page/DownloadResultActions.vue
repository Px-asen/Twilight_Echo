<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { CoreDownloadTask } from '../../../../shared/coreDownloads.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
const props = defineProps<{ task: CoreDownloadTask }>()
const core = useCoreConnection()
const pending = ref(false)
const error = ref('')
const submitted = ref(false)
const indexState = ref<'checking' | 'indexed' | 'missing' | 'unknown'>('checking')
const indexError = ref('')
const indexed = computed(() => indexState.value === 'indexed')
let indexRequest = 0
async function refreshIndexedTrack() {
  const request = ++indexRequest
  indexError.value = ''
  try {
    const result = await core.query('downloads.indexed', { id: props.task.id })
    if (request !== indexRequest) return
    indexState.value = result.indexed ? 'indexed' : 'missing'
  } catch (cause) {
    if (request !== indexRequest) return
    indexError.value = cause instanceof Error ? cause.message : String(cause)
    indexState.value = 'unknown'
  }
}
watch([
  () => props.task.id, () => core.state.value?.epoch, () => core.state.value?.libraryRevision
], ([id, epoch], [previousId, previousEpoch]) => {
  if (id !== previousId || epoch !== previousEpoch) {
    indexState.value = 'checking'
    submitted.value = false
  }
  void refreshIndexedTrack()
}, { immediate: true })
onBeforeUnmount(() => {
  indexRequest++
})
const indexLabel = computed(() => {
  if (indexState.value === 'checking') return '正在检查曲库…'
  if (indexed.value) return '已在曲库'
  if (indexState.value === 'unknown') return '无法确认曲库状态'
  return submitted.value ? '已提交索引；稍后可在曲库查看' : '尚未在曲库索引中'
})
async function act(action: 'play' | 'reveal' | 'add') {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    if (action === 'play') await core.command('downloads.play', { id: props.task.id })
    else if (action === 'reveal') await core.command('downloads.reveal', { id: props.task.id })
    else {
      await core.command('downloads.result', { id: props.task.id, addToLibrary: true })
      submitted.value = true
      await refreshIndexedTrack()
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
    <small>{{ indexLabel }}</small>
    <small v-if="indexError" role="alert">{{ indexError }}</small>
    <div>
      <button type="button" :disabled="pending" @click="act('play')">播放本地文件</button
      ><button type="button" :disabled="pending" @click="act('reveal')">打开目录</button
      ><button
        v-if="indexState === 'missing'"
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
button {
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  padding: 7px 12px;
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
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
</style>
