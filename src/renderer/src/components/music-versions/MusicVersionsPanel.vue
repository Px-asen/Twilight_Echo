<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useCoreLibraryApi } from '../../stores/library/coreLibraryApi.ts'
import type { Track } from '@renderer/types/music'
import { libraryTrack } from '@renderer/utils/libraryQueuePlayback.ts'
import {
  type MusicVersionsDocument,
  type VersionOperation,
  type VersionScope
} from '@renderer/utils/musicVersions.ts'
import {
  getMusicVersions,
  loadMusicVersions,
  musicVersionError,
  previewMusicVersionEdit,
  saveMusicVersions
} from '@renderer/stores/musicVersions.ts'
import {
  buildVersionCatalog,
  localAlbumIdFromVersionKey,
  queryCoreVersionCatalog,
  resolvePreferredSourceKey,
  versionDescriptions,
  resolvePreferredVersion
} from '@renderer/components/music-versions/versionCatalog.ts'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'

const props = withDefaults(
  defineProps<{
    tracks: Track[]
    initialScope?: VersionScope
    initialTrack?: Track
    sqliteMode?: boolean
  }>(),
  { initialScope: 'tracks', sqliteMode: false }
)
const emit = defineEmits<{
  close: []
  play: [tracks: Track[]]
  playQuery: [query: LibraryQuery, selectedId: string]
}>()
const core = useCoreConnection(),
  libraryApi = useCoreLibraryApi()
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
const externalCatalog = computed(() => buildVersionCatalog(
  props.sqliteMode ? props.tracks.filter(track => track.source && track.source !== 'local') : props.tracks,
  scope.value
))
const databasePage = shallowRef<{
  items: ReturnType<typeof buildVersionCatalog>
  total: number
  revision: number
  offset: number
} | null>(null)
const databaseTotal = ref(0)
const databaseLoaded = ref(false)
const databaseLoading = ref(false)
const databaseError = ref('')
let databaseGeneration = 0
const databaseDetails = shallowRef<Track[]>([])
const databaseDetailTotal = ref(0)
const databaseDetailLoading = ref(false)
let detailGeneration = 0
const tailRows = computed(() => {
  const map = new Map(externalCatalog.value.map((item) => [item.key, item]))
  for (const version of document.value[scope.value].versions)
    for (const key of version.sources) {
      const isLocal =
        scope.value === 'tracks' ? key.startsWith('["local",') : key.startsWith('["album","local",')
      const searchText = query.value.trim().toLowerCase()
      const savedMatch = `${version.label} ${key} ${descriptions.value.get(key) ?? ''}`
        .toLowerCase()
        .includes(searchText)
      if (
        !map.has(key) &&
        (!props.sqliteMode || !isLocal || relatedKeys.value?.has(key) || (searchText && savedMatch))
      )
        map.set(key, { key, title: version.label, artist: '此来源未载入', source: key, tracks: [] })
    }
  return [...map.values()]
})
const rows = computed(() => {
  const map = new Map(databasePage.value?.items.map((item) => [item.key, item]) ?? [])
  for (const item of tailRows.value) if (!map.has(item.key)) map.set(item.key, item)
  return [...map.values()]
})
const descriptions = computed(() => versionDescriptions(document.value, scope.value))
const matchesQuery = (item: (typeof rows.value)[number], text: string): boolean =>
  !text ||
  `${item.title} ${item.artist} ${item.source} ${descriptions.value.get(item.key)}`
    .toLowerCase()
    .includes(text)
const filtered = computed(() => {
  const text = query.value.trim().toLowerCase()
  return rows.value.filter(
    (item) => (!relatedKeys.value || relatedKeys.value.has(item.key)) && matchesQuery(item, text)
  )
})
const filteredTail = computed(() => {
  const text = query.value.trim().toLowerCase()
  const pageKeys = new Set(databasePage.value?.items.map((item) => item.key) ?? [])
  return tailRows.value.filter(
    (item) =>
      !pageKeys.has(item.key) &&
      (!relatedKeys.value || relatedKeys.value.has(item.key)) &&
      matchesQuery(item, text)
  )
})
const pages = computed(() =>
  Math.max(
    1,
    Math.ceil(
      (props.sqliteMode ? databaseTotal.value + filteredTail.value.length : filtered.value.length) /
        50
    )
  )
)
const visible = computed(() => {
  if (!props.sqliteMode) return filtered.value.slice(page.value * 50, (page.value + 1) * 50)
  const start = page.value * 50
  const databaseCount = Math.max(0, Math.min(start + 50, databaseTotal.value) - start)
  const databaseItems = databasePage.value?.items ?? []
  const tailStart = Math.max(0, start - databaseTotal.value)
  const tailCount = 50 - databaseCount
  return [...databaseItems, ...filteredTail.value.slice(tailStart, tailStart + tailCount)]
})
const changes = computed(() => {
  if (!preview.value) return []
  const { before, after } = preview.value
  const oldDescriptions = versionDescriptions(before, scope.value),
    nextDescriptions = versionDescriptions(after, scope.value)
  const known = new Map(rows.value.map((item) => [item.key, item]))
  const keys = new Set([...oldDescriptions.keys(), ...nextDescriptions.keys(), ...selection.value])
  return [...keys]
    .map((key) => ({
      item: known.get(key) ?? {
        key,
        title:
          after[scope.value].versions.find((version) => version.sources.includes(key))?.label ??
          key,
        artist: '来源',
        source: key,
        tracks: []
      },
      before: oldDescriptions.get(key) ?? '自动匹配 · 无人工覆盖',
      after: nextDescriptions.get(key) ?? '自动匹配 · 无人工覆盖'
    }))
    .filter((item) => item.before !== item.after || selection.value.has(item.item.key))
})
const visibleChanges = computed(() =>
  changes.value.slice(previewPage.value * 50, (previewPage.value + 1) * 50)
)
const details = shallowRef<(typeof rows.value)[number] | null>(null)
const visibleDetails = computed(() =>
  details.value?.albumId && props.sqliteMode
    ? databaseDetails.value
    : (details.value?.tracks.slice(detailPage.value * 50, (detailPage.value + 1) * 50) ?? [])
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
})
watch(
  [scope, query],
  () => {
    databaseGeneration++
    detailGeneration++
    preview.value = null
    details.value = null
    detailsKey.value = null
    page.value = 0
    databasePage.value = null
    databaseTotal.value = 0
    databaseLoaded.value = false
    databaseError.value = ''
  },
  { flush: 'sync' }
)
watch([() => props.sqliteMode, scope, query, page], () => void loadDatabasePage(), {
  immediate: true,
  flush: 'sync'
})
watch([() => props.sqliteMode, detailPage, detailsKey], () => void loadDatabaseDetails(), {
  flush: 'sync'
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
  const track = props.initialTrack
  query.value = scope.value === 'tracks' ? track.title : track.album
  void core
    .query('versions.catalog', { scope: scope.value, trackId: track.id, limit: 1 })
    .then((page) => {
      if (page.items[0]) selection.value = new Set([page.items[0].key])
    })
    .catch((cause) => {
      error.value = String(cause)
    })
}
async function loadDatabasePage(): Promise<void> {
  const generation = ++databaseGeneration
  if (!props.sqliteMode) {
    databasePage.value = null
    databaseTotal.value = 0
    databaseLoaded.value = false
    databaseLoading.value = false
    databaseError.value = ''
    return
  }
  const offset = page.value * 50
  if (databaseLoaded.value && offset >= databaseTotal.value) {
    databasePage.value = null
    databaseLoading.value = false
    databaseError.value = ''
    return
  }
  databaseLoading.value = true
  databaseError.value = ''
  try {
    const result = await queryCoreVersionCatalog(core, scope.value, {
      ...(query.value.trim() ? { search: query.value.trim() } : {}),
      offset,
      limit: 50
    })
    if (generation !== databaseGeneration) return
    if (
      result.offset !== offset ||
      result.items.length > 50 ||
      !Number.isSafeInteger(result.total) ||
      result.total < 0 ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 0
    )
      throw new Error('数据库返回了无效的版本分页')
    databasePage.value = result
    databaseTotal.value = result.total
    databaseLoaded.value = true
    const lastPage = Math.max(0, Math.ceil(result.total / 50) - 1)
    if (offset > 0 && offset >= result.total) {
      page.value = lastPage
      return
    }
  } catch (cause) {
    if (generation === databaseGeneration)
      databaseError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (generation === databaseGeneration) databaseLoading.value = false
  }
}

async function loadDatabaseDetails(): Promise<void> {
  const generation = ++detailGeneration
  const item = details.value
  if (!props.sqliteMode || !item?.albumId) {
    databaseDetails.value = []
    databaseDetailTotal.value = item?.tracks.length ?? 0
    databaseDetailLoading.value = false
    return
  }
  databaseDetailLoading.value = true
  try {
    const result = await libraryApi.queryTracks({
      albumId: item.albumId,
      sort: 'trackNumber',
      direction: 'asc',
      offset: detailPage.value * 50,
      limit: 50
    })
    if (generation !== detailGeneration) return
    databaseDetails.value = result.tracks.map(libraryTrack)
    databaseDetailTotal.value = result.total
  } catch (cause) {
    if (generation === detailGeneration)
      databaseError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (generation === detailGeneration) databaseDetailLoading.value = false
  }
}

function retryDatabaseRead(): void {
  databaseError.value = ''
  if (details.value?.albumId) void loadDatabaseDetails()
  else {
    databaseLoaded.value = false
    void loadDatabasePage()
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
  details.value = rows.value.find((item) => item.key === key) ?? null
  detailPage.value = 0
  databaseDetails.value = []
  detailsKey.value = key
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
    preview.value = {
      ...previewMusicVersionEdit(scope.value, operation, [...selection.value], label.value),
      operation: name
    }
    previewPage.value = 0
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法预览版本操作'
  }
}
async function commit(): Promise<void> {
  if (!preview.value) return
  try {
    await saveMusicVersions(preview.value.after, preview.value.before)
    preview.value = null
    error.value = ''
    notice.value = '版本关系已保存；原收藏、歌单条目和文件保持完整。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
  }
}
async function playPreferred(): Promise<void> {
  try {
    if (selection.value.size !== 1) throw new Error('请选择一个来源作为版本选择起点')
    const startKey = [...selection.value][0]
    const sourceKey = resolvePreferredSourceKey(document.value, scope.value, startKey)
    const sourceItem = rows.value.find((item) => item.key === sourceKey)
    if (!props.sqliteMode) {
      emit('play', resolvePreferredVersion(document.value, scope.value, startKey, rows.value))
      error.value = ''
      return
    }
    if (scope.value === 'albums') {
      const albumId = sourceItem?.albumId ?? localAlbumIdFromVersionKey(sourceKey)
      if (albumId) {
        const query: LibraryQuery = {
          albumId,
          sort: 'trackNumber',
          direction: 'asc'
        }
        const first = await libraryApi.queryTracks({
          ...query,
          offset: 0,
          limit: 1
        })
        const selected = first.tracks[0]
        if (!selected) throw new Error('专辑已不在曲库中')
        emit('playQuery', query, selected.id)
      } else if (sourceItem?.tracks.length) {
        emit('play', resolvePreferredVersion(document.value, scope.value, startKey, rows.value))
      } else throw new Error('偏好专辑尚未载入，请搜索该专辑后重试')
    } else {
      const track =
        sourceItem?.tracks[0] ??
        (await core.query('versions.catalog', { scope: 'tracks', key: sourceKey, limit: 1 }))
          .items[0]?.track
      if (!track) throw new Error('偏好来源已不在曲库中，关系仍保留，可重新关联其他来源')
      if ((track.source ?? 'local') === 'local') emit('playQuery', { ids: [track.id] }, track.id)
      else emit('play', [track])
    }
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
    <p v-if="databaseError" role="alert">
      {{ databaseError }} <button @click="retryDatabaseRead">重新读取</button>
    </p>
    <p v-if="databaseLoading" role="status">正在读取数据库分页...</p>
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
            item.trackCount || item.tracks.length
              ? `${item.trackCount ?? item.tracks.length} 首，按需读取曲目`
              : '未载入，人工关系保留'
          }}
        </p>
        <p>{{ descriptions.get(item.key) ?? '自动匹配 · 无人工覆盖' }}</p>
        <button @click="showRelated(item.key)">查看关联版本</button>
        <button @click="showDetails(item.key)">查看来源与曲序</button>
      </li>
    </ul>
    <p
      v-if="
        props.sqliteMode
          ? databaseLoaded && !databaseTotal && !filteredTail.length
          : !filtered.length
      "
    >
      没有匹配的来源。可在歌曲信息中打开此面板，或先加载对应歌单/搜索结果。
    </p>
    <footer>
      <button :disabled="page === 0" @click="page--">上一页</button
      ><span
        >{{ page + 1 }} / {{ pages }} 页 ·
        {{ props.sqliteMode ? databaseTotal + filteredTail.length : filtered.length }} 个来源</span
      ><button :disabled="page + 1 >= pages" @click="page++">下一页</button>
    </footer>
    <section v-if="details" aria-label="来源曲序">
      <h3>{{ details.title }} · 原始曲序</h3>
      <p v-if="databaseDetailLoading" role="status">正在读取曲目...</p>
      <p v-else-if="!databaseDetailTotal">来源未载入：{{ details.key }}</p>
      <ol>
        <li v-for="track in visibleDetails" :key="track.id">
          {{ track.discNumber ?? 1 }}-{{ track.trackNumber ?? '—' }} · {{ track.title }} ·
          {{ track.duration }}s · {{ track.format || '格式待解析' }}
          <p>{{ track.source || 'local' }} · {{ track.id }}</p>
        </li>
      </ol>
      <button :disabled="detailPage === 0" @click="detailPage--">上一页曲目</button
      ><button :disabled="(detailPage + 1) * 50 >= databaseDetailTotal" @click="detailPage++">
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
  padding: 0;
  margin-right: 8px;
}
</style>
