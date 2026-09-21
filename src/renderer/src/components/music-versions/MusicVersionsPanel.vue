<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { Track } from '@renderer/types/music'
import {
  editMusicVersions,
  type MusicVersionsDocument,
  type VersionOperation,
  type VersionScope
} from '@renderer/utils/musicVersions.ts'
import {
  getMusicVersions,
  loadMusicVersions,
  musicVersionError,
  saveMusicVersions
} from '@renderer/stores/musicVersions.ts'
import {
  buildVersionCatalog,
  versionDescriptions,
  resolvePreferredVersion
} from '@renderer/components/music-versions/versionCatalog.ts'

const props = withDefaults(
  defineProps<{ tracks: Track[]; initialScope?: VersionScope; initialTrack?: Track }>(),
  { initialScope: 'tracks' }
)
const emit = defineEmits<{ close: []; play: [tracks: Track[]] }>()
const scope = ref<VersionScope>(props.initialScope)
const query = ref('')
const label = ref('')
const selection = shallowRef(new Set<string>())
const page = ref(0)
const previewPage = ref(0)
const preview = shallowRef<{
  before: MusicVersionsDocument
  after: MusicVersionsDocument
  operation: string
} | null>(null)
const error = ref('')
const notice = ref('')
const detailsKey = ref<string | null>(null)
const detailPage = ref(0)
const relatedKeys = shallowRef<Set<string> | null>(null)
const document = computed(() => getMusicVersions())
const catalog = computed(() => buildVersionCatalog(props.tracks, scope.value))
const rows = computed(() => {
  const map = new Map(catalog.value.map((item) => [item.key, item]))
  for (const version of document.value[scope.value].versions)
    for (const key of version.sources) {
      if (!map.has(key))
        map.set(key, { key, title: version.label, artist: '此来源未载入', source: key, tracks: [] })
    }
  return [...map.values()]
})
const descriptions = computed(() => versionDescriptions(document.value, scope.value))
const filtered = computed(() => {
  const text = query.value.trim().toLowerCase()
  return rows.value.filter(
    (item) =>
      (!relatedKeys.value || relatedKeys.value.has(item.key)) &&
      (!text ||
        `${item.title} ${item.artist} ${item.source} ${descriptions.value.get(item.key)}`
          .toLowerCase()
          .includes(text))
  )
})
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 50)))
const visible = computed(() => filtered.value.slice(page.value * 50, (page.value + 1) * 50))
const changes = computed(() => {
  if (!preview.value) return []
  const { before, after } = preview.value
  const oldDescriptions = versionDescriptions(before, scope.value),
    nextDescriptions = versionDescriptions(after, scope.value)
  return rows.value
    .map((item) => ({
      item,
      before: oldDescriptions.get(item.key) ?? '自动匹配 · 无人工覆盖',
      after: nextDescriptions.get(item.key) ?? '自动匹配 · 无人工覆盖'
    }))
    .filter((item) => item.before !== item.after || selection.value.has(item.item.key))
})
const visibleChanges = computed(() =>
  changes.value.slice(previewPage.value * 50, (previewPage.value + 1) * 50)
)
const details = computed(() => rows.value.find((item) => item.key === detailsKey.value))
const visibleDetails = computed(
  () => details.value?.tracks.slice(detailPage.value * 50, (detailPage.value + 1) * 50) ?? []
)
const operations: Array<{ value: VersionOperation; label: string }> = [
  { value: 'sources', label: '关联为同版本的多个来源' },
  { value: 'family', label: '关联为不同版本' },
  { value: 'split', label: '拆分所选来源' },
  { value: 'reset', label: '撤回所选人工关系' },
  { value: 'label', label: '修改版本标签' },
  { value: 'prefer-source', label: '设为偏好来源' },
  { value: 'prefer-version', label: '设为偏好版本' },
  { value: 'clear-preference', label: '清除偏好' }
]
watch(scope, () => {
  relatedKeys.value = null
  selection.value = new Set()
  preview.value = null
  detailsKey.value = null
  page.value = 0
})
watch(query, () => {
  page.value = 0
})
watch(pages, (value) => {
  page.value = Math.min(page.value, value - 1)
})
watch(
  () => props.tracks,
  () => {
    preview.value = null
    notice.value = '来源列表已刷新，请重新预览尚未保存的修改。'
  }
)
if (props.initialTrack) {
  const item = catalog.value.find((entry) =>
    entry.tracks.some((track) => track.id === props.initialTrack!.id)
  )
  if (item) {
    selection.value = new Set([item.key])
    query.value = item.title
  }
}
function clearSelection(): void {
  selection.value = new Set()
  preview.value = null
}
function showRelated(key: string): void {
  const domain = document.value[scope.value]
  const version = domain.versions.find((item) => item.sources.includes(key))
  const family = version && domain.families.find((item) => item.versions.includes(version.id))
  const ids = new Set(family?.versions ?? (version ? [version.id] : []))
  relatedKeys.value = new Set(
    domain.versions.filter((item) => ids.has(item.id)).flatMap((item) => item.sources)
  )
  relatedKeys.value.add(key)
  query.value = ''
  page.value = 0
}
function showDetails(key: string): void {
  detailsKey.value = key
  detailPage.value = 0
}
function toggle(key: string): void {
  const next = new Set(selection.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selection.value = next
  preview.value = null
}
function prepare(operation: VersionOperation, name: string): void {
  try {
    error.value = ''
    const before = document.value
    preview.value = {
      before,
      after: editMusicVersions(before, scope.value, operation, [...selection.value], label.value),
      operation: name
    }
    previewPage.value = 0
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法预览版本操作'
  }
}
function commit(): void {
  if (!preview.value) return
  try {
    saveMusicVersions(preview.value.after, preview.value.before)
    preview.value = null
    error.value = ''
    notice.value = '版本关系已保存；原收藏、歌单条目和文件保持完整。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
  }
}
function playPreferred(): void {
  try {
    if (selection.value.size !== 1) throw new Error('请选择一个来源作为版本选择起点')
    emit(
      'play',
      resolvePreferredVersion(document.value, scope.value, [...selection.value][0], catalog.value)
    )
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法播放偏好版本'
  }
}
</script>

<template>
  <section class="versions-panel" aria-label="歌曲与专辑版本管理">
    <header>
      <h2>歌曲与专辑版本</h2>
      <button @click="emit('close')">返回</button>
    </header>
    <p>同录音的多个来源可归入同一版本；现场、重制等不同版本保持独立。关联不会合并文件。</p>
    <p v-if="musicVersionError" role="alert">
      {{ musicVersionError }} <button @click="loadMusicVersions">重新读取</button>
    </p>
    <div class="version-tools">
      <label
        >范围
        <select v-model="scope">
          <option value="tracks">歌曲版本</option>
          <option value="albums">专辑版本</option>
        </select></label
      >
      <label>搜索 <input v-model="query" placeholder="歌曲、专辑、来源或版本标签" /></label>
      <label
        >版本标签
        <input v-model="label" maxlength="100" placeholder="例如：录音室版、现场版、2024 重制版"
      /></label>
      <button @click="clearSelection">清空选择</button><span>{{ selection.size }} 项已选</span>
      <button v-if="relatedKeys" @click="relatedKeys = null">显示全部来源</button>
    </div>
    <div class="version-tools">
      <button
        v-for="operation in operations"
        :key="operation.value"
        :disabled="!selection.size || !!musicVersionError"
        @click="prepare(operation.value, operation.label)"
      >
        {{ operation.label }}</button
      ><button :disabled="selection.size !== 1" @click="playPreferred">播放偏好版本</button>
    </div>
    <p role="alert">{{ error }}</p>
    <p role="status">{{ notice }}</p>
    <section v-if="preview" class="version-preview" aria-label="关系修改预览">
      <strong>{{ preview.operation }} · 影响 {{ changes.length }} 个来源</strong>
      <article v-for="change in visibleChanges" :key="change.item.key">
        <b>{{ change.item.title }} · {{ change.item.source }}</b>
        <p>{{ change.before }} → {{ change.after }}</p>
      </article>
      <button :disabled="previewPage === 0" @click="previewPage--">上一页预览</button
      ><button :disabled="(previewPage + 1) * 50 >= changes.length" @click="previewPage++">
        下一页预览
      </button>
      <button @click="commit">确认保存关系</button><button @click="preview = null">取消预览</button>
    </section>
    <ul class="version-list">
      <li v-for="item in visible" :key="item.key">
        <label
          ><input
            type="checkbox"
            :checked="selection.has(item.key)"
            @change="toggle(item.key)"
          /><strong>{{ item.title || '未命名' }}</strong> · {{ item.artist }}</label
        >
        <p>
          {{ item.source }} ·
          {{
            item.tracks.length
              ? `${item.tracks.length} 首已载入，播放时检查资源`
              : '未载入，人工关系保留'
          }}
        </p>
        <p>{{ descriptions.get(item.key) ?? '自动匹配 · 无人工覆盖' }}</p>
        <button @click="showRelated(item.key)">查看关联版本</button>
        <button @click="showDetails(item.key)">查看来源与曲序</button>
      </li>
    </ul>
    <p v-if="!filtered.length">
      没有匹配的来源。可在歌曲信息中打开此面板，或先加载对应歌单/搜索结果。
    </p>
    <footer>
      <button :disabled="page === 0" @click="page--">上一页</button
      ><span>{{ page + 1 }} / {{ pages }} 页 · {{ filtered.length }} 个来源</span
      ><button :disabled="page + 1 >= pages" @click="page++">下一页</button>
    </footer>
    <section v-if="details" aria-label="来源曲序">
      <h3>{{ details.title }} · 原始曲序</h3>
      <p v-if="!details.tracks.length">来源未载入：{{ details.key }}</p>
      <ol>
        <li v-for="track in visibleDetails" :key="track.id">
          {{ track.discNumber ?? 1 }}-{{ track.trackNumber ?? '—' }} · {{ track.title }} ·
          {{ track.duration }}s · {{ track.format || '格式待解析' }}
          <p>{{ track.source || 'local' }} · {{ track.id }}</p>
        </li>
      </ol>
      <button :disabled="detailPage === 0" @click="detailPage--">上一页曲目</button
      ><button :disabled="(detailPage + 1) * 50 >= details.tracks.length" @click="detailPage++">
        下一页曲目</button
      ><button @click="detailsKey = null">收起曲序</button>
    </section>
  </section>
</template>

<style scoped>
.versions-panel {
  color: var(--te-neutral-900);
  padding: 20px;
  font-size: var(--te-font-size-body, 14px);
}
header,
footer,
.version-tools {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
header,
footer {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
}
button,
input,
select {
  font: inherit;
  color: inherit;
  background: var(--te-glass-bg);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  padding: 7px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
p {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
  margin: 7px 0;
}
.version-list {
  padding: 0;
  list-style: none;
  max-height: 360px;
  overflow: auto;
}
.version-list li,
.version-preview article {
  padding: 10px 0;
  border-bottom: 1px solid var(--te-card-border);
}
.version-preview {
  max-height: 300px;
  overflow: auto;
  border: 1px solid var(--te-card-border);
  padding: 12px;
}
[role='alert'] {
  color: var(--te-warning-500);
}
input[type='checkbox'] {
  margin-right: 8px;
}
</style>
