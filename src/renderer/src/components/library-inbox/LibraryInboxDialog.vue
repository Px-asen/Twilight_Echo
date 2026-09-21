<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Track } from '@renderer/types/music'
import { normalizePortableLibraryPath } from '@renderer/stores/library/musicStoreData.ts'
import LocalLibraryTagManager from '@renderer/components/LocalLibraryTagManager.vue'
import { useEscapeToClose, useFocusTrap } from '@renderer/app/useDismissLayer.ts'
import type { LocalLibraryTagPatch } from '../../../../shared/localLibraryTags.ts'
import type { DuplicateDetectionResult } from '../../../../shared/duplicateDetection.ts'
import {
  buildInboxIssues,
  currentInboxTracks,
  inboxLabels,
  inboxStatus,
  INBOX_PAGE_SIZE,
  INBOX_STORAGE_KEY,
  parseInboxDecisions,
  serializeInboxDecisions,
  type InboxDecision,
  type InboxKind,
  type InboxStatus
} from '@renderer/components/library-inbox/libraryInbox.ts'

const props = defineProps<{
  tracks: Track[]
  rescan: () => Promise<unknown>
  scanning: boolean
  restoreFocus?: HTMLElement | null
}>()
const emit = defineEmits<{
  close: []
  applied: [paths: string[], patch: LocalLibraryTagPatch]
}>()
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const decisions = shallowRef(new Map<string, InboxDecision>())
const duplicates = shallowRef<DuplicateDetectionResult | null>(null)
const selection = shallowRef(new Set<string>())
const editTracks = shallowRef<Track[]>([])
const kind = ref<InboxKind | ''>('')
const status = ref<InboxStatus>('pending')
const page = ref(0)
const error = ref('')
const notice = ref('')
const detecting = ref(false)
const rescanning = ref(false)
const mounted = ref(false)
const focusRestoreTarget =
  props.restoreFocus ??
  (document.activeElement instanceof HTMLElement ? document.activeElement : null)
let generation = 0
let disposed = false
try {
  decisions.value = parseInboxDecisions(localStorage.getItem(INBOX_STORAGE_KEY))
} catch {
  error.value = '无法读取整理记录，本次显示为待处理；可重新标记。'
}
const issues = computed(() => buildInboxIssues(props.tracks, duplicates.value))
const issueIndex = computed(() => new Map(issues.value.map((issue) => [issue.key, issue])))
const counts = computed(() => {
  const result = { cover: 0, tags: 0, enrichment: 0, duplicate: 0 }
  for (const issue of issues.value)
    if (inboxStatus(issue, decisions.value) === status.value) result[issue.kind]++
  return result
})
const filtered = computed(() =>
  issues.value.filter(
    (issue) =>
      (!kind.value || issue.kind === kind.value) &&
      inboxStatus(issue, decisions.value) === status.value
  )
)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / INBOX_PAGE_SIZE)))
const visible = computed(() =>
  filtered.value.slice(page.value * INBOX_PAGE_SIZE, (page.value + 1) * INBOX_PAGE_SIZE)
)
const chosen = computed(() => {
  const result = new Map<string, Track>()
  for (const key of selection.value) {
    const issue = issueIndex.value.get(key)
    if (issue) result.set(issue.track.id, issue.track)
  }
  return [...result.values()]
})
watch([kind, status], () => {
  page.value = 0
  selection.value = new Set()
})
watch(pageCount, (count) => {
  page.value = Math.min(page.value, count - 1)
})
watch(page, () => {
  void nextTick(() => {
    if (list.value) list.value.scrollTop = 0
  })
})
watch(
  () => props.tracks,
  () => {
    generation++
    duplicates.value = null
    selection.value = new Set()
    notice.value = '曲库已更新，问题已刷新；重复结果需重新检查。'
  }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
  focusRestoreTarget?.focus()
})
onMounted(() => {
  mounted.value = true
})
useFocusTrap(root, () => mounted.value && editTracks.value.length === 0)
useEscapeToClose(
  () => true,
  () => {
    if (editTracks.value.length === 0) emit('close')
  }
)

function toggle(key: string): void {
  const next = new Set(selection.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selection.value = next
}
function selectPage(): void {
  const next = new Set(selection.value)
  for (const issue of visible.value) next.add(issue.key)
  selection.value = next
}
function mark(nextStatus: InboxStatus): void {
  const next = new Map(decisions.value)
  for (const key of selection.value) {
    const issue = issueIndex.value.get(key)
    if (!issue) continue
    next.delete(issue.key)
    if (nextStatus !== 'pending')
      next.set(issue.key, { fingerprint: issue.fingerprint, status: nextStatus })
  }
  try {
    const raw = serializeInboxDecisions(next)
    localStorage.setItem(INBOX_STORAGE_KEY, raw)
    decisions.value = parseInboxDecisions(raw)
    selection.value = new Set()
    error.value = ''
    notice.value = '整理状态已保存；标记已处理不会修改歌曲或文件。'
  } catch {
    error.value = '整理状态保存失败，请释放本地存储空间后重试。'
  }
}
async function detect(): Promise<void> {
  if (detecting.value) return
  const request = ++generation
  detecting.value = true
  error.value = ''
  try {
    const result = await window.api.library.detectDuplicates()
    if (request !== generation || disposed) return
    duplicates.value = result
    notice.value = result.contentHashUnavailableIds.length
      ? `${result.contentHashUnavailableIds.length} 个文件无法读取完整 hash；其余证据仍可复核。`
      : `检查完成，发现 ${result.groups.length} 组候选。`
    kind.value = 'duplicate'
  } catch (cause) {
    if (request === generation && !disposed)
      error.value = cause instanceof Error ? cause.message : '重复检查失败，请重试。'
  } finally {
    detecting.value = false
  }
}
async function requestRescan(): Promise<void> {
  rescanning.value = true
  error.value = ''
  try {
    await props.rescan()
    notice.value = '重扫已返回；后台补全进度可在设置的曲库管理查看。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '后台重扫失败，请重试。'
  } finally {
    rescanning.value = false
  }
}
function applied(paths: string[], patch: LocalLibraryTagPatch): void {
  const current = new Set(
    currentInboxTracks(editTracks.value, props.tracks).map((track) =>
      normalizePortableLibraryPath(track.filePath)
    )
  )
  const accepted = paths.filter((path) => current.has(normalizePortableLibraryPath(path)))
  if (accepted.length) emit('applied', accepted, patch)
  notice.value = '已显示逐文件结果；封面与其他文件标签可通过显式后台重扫刷新。'
}
</script>

<template>
  <div class="inbox-overlay">
    <section
      v-show="editTracks.length === 0"
      ref="root"
      class="inbox-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="inbox-title"
    >
      <header>
        <div>
          <h2 id="inbox-title">曲库整理收件箱</h2>
          <p>基于已加载曲库；已处理和忽略仅保存复核状态。</p>
        </div>
        <button @click="emit('close')">关闭</button>
      </header>
      <div class="inbox-controls">
        <label
          >问题
          <select v-model="kind">
            <option value="">全部</option>
            <option v-for="(label, value) in inboxLabels" :key="value" :value="value">
              {{ label }} · {{ counts[value] }}
            </option>
          </select></label
        >
        <label
          >状态
          <select v-model="status">
            <option value="pending">待处理</option>
            <option value="ignored">已忽略</option>
            <option value="done">已处理</option>
          </select></label
        >
        <button :disabled="detecting" @click="detect">
          {{ detecting ? '检查中…' : '检查疑似重复' }}
        </button>
        <button :disabled="rescanning || scanning" @click="requestRescan">
          {{ rescanning || scanning ? '重扫中…' : '全库后台重扫与补全' }}
        </button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <p role="status">{{ notice }}</p>
      <div class="inbox-controls">
        <button @click="selectPage">选择本页</button
        ><button @click="selection = new Set()">清空选择</button>
        <span>{{ chosen.length }} 首已选</span>
        <button :disabled="!chosen.length" @click="editTracks = chosen">预览并编辑标签</button>
        <button :disabled="!chosen.length" @click="mark('ignored')">忽略</button>
        <button :disabled="!chosen.length" @click="mark('done')">标记已处理</button>
        <button :disabled="!chosen.length" @click="mark('pending')">重新打开</button>
      </div>
      <p v-if="!visible.length">
        {{
          kind === 'duplicate' && !duplicates
            ? '点击“检查疑似重复”开始只读复核。'
            : '当前筛选没有待展示的问题。'
        }}
      </p>
      <ul ref="list" class="inbox-list">
        <li v-for="issue in visible" :key="issue.key" class="inbox-row">
          <label
            ><input
              type="checkbox"
              :checked="selection.has(issue.key)"
              @change="toggle(issue.key)"
            /><strong>{{ issue.track.title || issue.track.fileName }}</strong> ·
            {{ inboxLabels[issue.kind] }}</label
          >
          <p>{{ issue.track.artist }} · {{ issue.track.album }} · {{ issue.reason }}</p>
          <small
            >{{ issue.track.filePath
            }}{{ issue.track.subTrack ? ` · ${issue.track.subTrack}` : '' }}</small
          >
        </li>
      </ul>
      <footer>
        <button :disabled="page === 0" @click="page--">上一页</button
        ><span>第 {{ page + 1 }} / {{ pageCount }} 页 · {{ filtered.length }} 项</span
        ><button :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
      </footer>
    </section>
    <LocalLibraryTagManager
      v-if="editTracks.length"
      :tracks="editTracks"
      :current-tracks="tracks"
      @close="editTracks = []"
      @applied="applied"
    />
  </div>
</template>

<style scoped>
.inbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--te-neutral-900) 35%, transparent);
}
.inbox-dialog {
  width: min(960px, calc(100vw - 32px));
  height: min(780px, calc(100vh - 48px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: var(--te-font-size-body, 14px);
  padding: 20px;
  border-radius: 12px;
  background: var(--te-glass-bg-strong);
  color: var(--te-neutral-900);
  border: 1px solid var(--te-glass-border);
}
header,
footer,
.inbox-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
header,
footer {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
}
p,
small {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
}
.inbox-controls {
  margin: 12px 0;
}
button,
select {
  font: inherit;
  color: inherit;
  background: var(--te-glass-bg);
  border: 1px solid var(--te-glass-border);
  border-radius: 6px;
  padding: 7px 10px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.inbox-list {
  flex: 1;
  min-height: 80px;
  overflow: auto;
  list-style: none;
  padding: 0;
}
.inbox-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--te-glass-border);
}
.inbox-row p {
  margin: 5px 0;
}
input {
  margin-right: 8px;
}
</style>
