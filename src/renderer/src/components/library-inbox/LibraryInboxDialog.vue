<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch
} from 'vue'
import type { Track } from '@renderer/types/music'
import LocalLibraryTagManager from '@renderer/components/LocalLibraryTagManager.vue'
import IdentityReviewInbox from '../music-metadata/IdentityReviewInbox.vue'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import { useEscapeToClose, useFocusTrap } from '@renderer/app/useDismissLayer.ts'
import { useCoreConnection } from '@renderer/stores/coreConnection.ts'

const GenreWorkspacePanel = defineAsyncComponent(
  () => import('../music-genres/GenreWorkspacePanel.vue')
)
const LibraryHealthPanel = defineAsyncComponent(() => import('./LibraryHealthPanel.vue'))
const MusicVersionsHost = defineAsyncComponent(
  () => import('../music-versions/MusicVersionsHost.vue')
)
import type {
  CoreInboxPage,
  CoreInboxState,
  InboxKind,
  InboxStatus
} from '../../../../shared/coreInbox.ts'
import type { CoreDuplicatesStatus } from '../../../../shared/coreDuplicates.ts'
import type { LibrarySelectionRequest } from '../../../../shared/librarySelection.ts'
import { inboxLabels, INBOX_PAGE_SIZE } from '@renderer/components/library-inbox/libraryInbox.ts'

const props = defineProps<{
  tracks: Track[]
  rescan: () => Promise<unknown>
  scanning: boolean
  restoreFocus?: HTMLElement | null
}>()
const emit = defineEmits<{
  close: []
  applied: [trackIds: string[]]
}>()
const core = useCoreConnection()
const section = ref<'health' | 'files' | 'metadata' | 'genres' | 'versions'>('health')
const toolsMenu = ref<HTMLDetailsElement | null>(null)
const optionalFiles = ref(false)
const filesLoading = ref(false)
const root = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
const inboxState = shallowRef<CoreInboxState | null>(null)
const inboxPage = shallowRef<CoreInboxPage | null>(null)
const selection = shallowRef(new Set<string>())
const selectedTracks = shallowRef(new Map<string, Track>())
const inspectedKey = ref<string | null>(null)
const editTracks = shallowRef<Track[]>([])
const editSelection = shallowRef<LibrarySelectionRequest | undefined>()
const kind = ref<InboxKind | ''>('enrichment')
const status = ref<InboxStatus>('pending')
const page = ref(0)
const error = ref('')
const notice = ref('')
const detecting = ref(false)
const rescanning = ref(false)
const marking = ref(false)
const mounted = ref(false)
const coreAttached = ref(false)
let generation = 0
let pageRequest = 0
let refreshRequest = 0
let disposed = false
const issues = computed(() =>
  (inboxPage.value?.items ?? []).map((item) => ({ ...item, key: String(item.index) }))
)
const issueIndex = computed(() => new Map(issues.value.map((issue) => [issue.key, issue])))
const counts = computed(
  () => inboxState.value?.counts[status.value] ?? { cover: 0, tags: 0, enrichment: 0, duplicate: 0 }
)
const totalFileCount = computed(
  () => counts.value.cover + counts.value.tags + counts.value.enrichment + counts.value.duplicate
)
const filtered = computed(() => inboxPage.value?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value / INBOX_PAGE_SIZE)))
const visible = computed(() => issues.value)
const inspectedIssue = computed(() => {
  if (inspectedKey.value && issueIndex.value.has(inspectedKey.value)) {
    return issueIndex.value.get(inspectedKey.value) ?? null
  }
  const firstSelected = [...selection.value].find((k) => issueIndex.value.has(k))
  if (firstSelected) return issueIndex.value.get(firstSelected) ?? null
  return null
})
watch(
  () => core.state.value?.libraryRevision,
  (revision, previous) => {
    if (inboxState.value && revision != null && previous != null && revision !== previous)
      void refreshInbox('曲库已更新，问题已刷新；重复结果需重新检查。').catch(showReadError)
  }
)
const chosen = computed(() => {
  return [...selectedTracks.value.values()]
})
watch([kind, status], () => {
  inboxPage.value = null
  page.value = 0
  selection.value = new Set()
  selectedTracks.value = new Map()
  inspectedKey.value = null
  void loadPage().catch(showReadError)
})
watch(pageCount, (count) => {
  page.value = Math.min(page.value, count - 1)
})
watch(page, () => {
  void nextTick(() => {
    if (list.value) list.value.scrollTop = 0
  })
  void loadPage().catch(showReadError)
})
watch(
  () => props.tracks,
  () => {
    generation++
    selection.value = new Set()
    selectedTracks.value = new Map()
    inspectedKey.value = null
    if (inboxState.value)
      void refreshInbox('曲库已更新，问题已刷新；重复结果需重新检查。').catch(showReadError)
  }
)
onBeforeUnmount(() => {
  disposed = true
  generation++
  pageRequest++
  refreshRequest++
})
onMounted(() => {
  mounted.value = true
  void core
    .attach()
    .then(() => {
      if (disposed) return
      coreAttached.value = true
      if (section.value === 'files') void openFiles()
    })
    .catch((cause) => {
      error.value = cause instanceof Error ? cause.message : '整理收件箱读取失败'
    })
})
useFocusTrap(root, () => mounted.value && editTracks.value.length === 0)
watch(section, (value) => {
  if (value === 'files' && coreAttached.value) void openFiles()
})
useEscapeToClose(
  () => true,
  () => {
    if (toolsMenu.value?.open) toolsMenu.value.open = false
    else if (editTracks.value.length === 0) emit('close')
  }
)

function navigate(value: typeof section.value) {
  section.value = value
  if (toolsMenu.value) toolsMenu.value.open = false
}
function showReadError(cause: unknown) {
  if (!disposed) error.value = cause instanceof Error ? cause.message : '文件整理列表读取失败'
}
async function openFiles() {
  if (inboxState.value || filesLoading.value) return
  filesLoading.value = true
  try {
    await refreshInbox()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文件整理列表读取失败'
  } finally {
    filesLoading.value = false
  }
}
function toggleOptionalFiles(event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  if (open === optionalFiles.value) return
  optionalFiles.value = open
  kind.value = optionalFiles.value ? '' : 'enrichment'
  status.value = 'pending'
}
function toggle(key: string): void {
  const next = new Set(selection.value)
  const tracks = new Map(selectedTracks.value)
  if (next.has(key)) {
    next.delete(key)
    tracks.delete(key)
  } else {
    const issue = issueIndex.value.get(key)
    if (!issue) return
    next.add(key)
    tracks.set(key, { ...issue.track, source: issue.track.source ?? 'local' } as Track)
    inspectedKey.value = key
  }
  selection.value = next
  selectedTracks.value = tracks
}
function selectPage(): void {
  const next = new Set(selection.value)
  const tracks = new Map(selectedTracks.value)
  for (const issue of visible.value) {
    next.add(issue.key)
    tracks.set(issue.key, { ...issue.track, source: issue.track.source ?? 'local' } as Track)
  }
  selection.value = next
  selectedTracks.value = tracks
}
function clearSelection(): void {
  selection.value = new Set()
  selectedTracks.value = new Map()
}
function closeTagEditor(): void {
  editTracks.value = []
  editSelection.value = undefined
}
function mark(nextStatus: InboxStatus): void {
  const state = inboxState.value
  if (!state || !selection.value.size) return
  const indexes = [...selection.value].map(Number)
  marking.value = true
  void (async () => {
    let revision = state.revision
    for (let offset = 0; offset < indexes.length; offset += 128) {
      const next = (await core.command('library.inbox.mark', {
        id: state.id,
        revision,
        indexes: indexes.slice(offset, offset + 128),
        status: nextStatus
      })) as CoreInboxState
      revision = next.revision
      inboxState.value = next
    }
    await loadPage()
  })()
    .then(() => {
      selection.value = new Set()
      selectedTracks.value = new Map()
      error.value = ''
      notice.value = '整理状态已保存；标记已处理不会修改歌曲或文件。'
    })
    .catch((cause) => {
      error.value = cause instanceof Error ? cause.message : '整理状态保存失败，请重试。'
    })
    .finally(() => {
      marking.value = false
    })
}
async function detect(): Promise<void> {
  if (detecting.value) return
  const request = ++generation
  detecting.value = true
  error.value = ''
  try {
    const started = (await core.command('library.duplicates.start', {})) as CoreDuplicatesStatus
    let result = await core.query('library.duplicates.status', {})
    while (
      result &&
      result.id === started.id &&
      !['completed', 'failed', 'cancelled'].includes(result.state)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      result = await core.query('library.duplicates.status', {})
    }
    if (!result || result.id !== started.id || result.state !== 'completed')
      throw new Error(result?.error || '重复歌曲检查未完成')
    if (request !== generation || disposed) return
    inboxState.value = (await core.command('library.inbox.refresh', {
      duplicatesId: started.id
    })) as CoreInboxState
    await loadPage()
    notice.value = result.unavailable
      ? `${result.unavailable} 个文件无法读取完整 hash；其余证据仍可复核。`
      : `检查完成，发现 ${result.groups} 组候选。`
    kind.value = 'duplicate'
  } catch (cause) {
    if (request === generation && !disposed)
      error.value = cause instanceof Error ? cause.message : '重复检查失败，请重试。'
  } finally {
    detecting.value = false
  }
}
async function refreshInbox(message?: string): Promise<void> {
  const request = ++refreshRequest
  pageRequest++
  const next = (await core.command('library.inbox.refresh', {})) as CoreInboxState
  if (disposed || request !== refreshRequest) return
  inboxState.value = next
  await loadPage()
  if (message && !disposed && request === refreshRequest) notice.value = message
}
async function loadPage(): Promise<void> {
  const state = inboxState.value
  if (!state || disposed) return
  const request = ++pageRequest
  try {
    const result = await core.query('library.inbox.page', {
      id: state.id,
      revision: state.revision,
      ...(kind.value ? { kind: kind.value } : {}),
      status: status.value,
      offset: page.value * INBOX_PAGE_SIZE,
      limit: INBOX_PAGE_SIZE
    })
    if (disposed || request !== pageRequest) return
    inboxPage.value = result
    inboxState.value = result.state
    error.value = ''
  } catch (cause) {
    if (!disposed && request === pageRequest) throw cause
  }
}
function editSelected(): void {
  const tracks = chosen.value
  if (!tracks.length || !inboxState.value) return
  editTracks.value = tracks
  editSelection.value = {
    query: {
      ids: tracks.map((track) => track.id),
      contentRevision: inboxState.value.libraryRevision,
      sort: 'insertion'
    },
    total: tracks.length,
    ranges: tracks.length ? [[0, tracks.length]] : []
  }
}
function editHealthTrack(track: CoreTrackView, revision: number): void {
  editTracks.value = [{ ...track, source: track.source ?? 'local' } as Track]
  editSelection.value = {
    query: { ids: [track.id], contentRevision: revision, sort: 'insertion' },
    total: 1,
    ranges: [[0, 1]]
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
function applied(trackIds: string[]): void {
  if (trackIds.length) emit('applied', trackIds)
  notice.value = '已显示逐文件结果；封面与其他文件标签可通过显式后台重扫刷新。'
}
</script>

<template>
  <div class="inbox-overlay">
    <section
      v-show="editTracks.length === 0"
      ref="root"
      class="inbox-dialog"
      :class="{
        'is-workspace':
          ['metadata', 'genres', 'versions'].includes(section) ||
          (section === 'files' && (optionalFiles || visible.length))
      }"
      data-dialog-panel
      role="dialog"
      aria-modal="true"
      aria-labelledby="inbox-title"
    >
      <header class="workbench-header">
        <div class="workbench-title-group">
          <h2 id="inbox-title">音乐库整理</h2>
          <p v-if="section === 'genres'">流派映射与层级</p>
          <p v-else-if="section === 'versions'">播放版本管理</p>
          <p v-else-if="section === 'metadata'">音乐资料复核记录</p>
        </div>
        <button type="button" class="close-btn" @click="emit('close')">关闭</button>
      </header>

      <div class="workbench-body">
        <div class="inbox-controls nav-group" role="group" aria-label="整理范围">
          <button type="button" :aria-pressed="section === 'health'" @click="navigate('health')">
            需要你决定
          </button>
          <button type="button" :aria-pressed="section === 'files'" @click="navigate('files')">
            文件问题
          </button>
          <details ref="toolsMenu" class="tools-menu">
            <summary>更多工具</summary>
            <div class="tools-list">
              <button
                type="button"
                :aria-pressed="section === 'metadata'"
                @click="navigate('metadata')"
              >
                音乐资料复核
              </button>
              <button
                type="button"
                :aria-pressed="section === 'genres'"
                @click="navigate('genres')"
              >
                流派映射与层级
              </button>
              <button
                type="button"
                :aria-pressed="section === 'versions'"
                @click="navigate('versions')"
              >
                播放版本管理
              </button>
            </div>
          </details>
        </div>

        <p v-if="!coreAttached" class="status-note" :role="error ? 'alert' : 'status'">
          {{ error || '正在读取音乐库…' }}
        </p>
        <div v-else class="workbench-main">
          <LibraryHealthPanel
            v-if="section === 'health'"
            @navigate="navigate"
            @edit="editHealthTrack"
          />
          <IdentityReviewInbox v-else-if="section === 'metadata'" />
          <div v-else-if="section === 'genres'" class="embedded-pane">
            <GenreWorkspacePanel />
          </div>
          <div v-else-if="section === 'versions'" class="embedded-pane">
            <MusicVersionsHost embedded @close="navigate('files')" />
          </div>
          <div v-else class="files-workspace">
            <details class="optional-files" :open="optionalFiles" @toggle="toggleOptionalFiles">
              <summary>可选整理</summary>
              <div class="sidebar-subfilters">
                <div class="filter-block">
                  <label class="filter-label"
                    >问题
                    <select v-model="kind" :disabled="marking">
                      <option value="">全部整理项 · {{ totalFileCount }}</option>
                      <option v-for="(label, value) in inboxLabels" :key="value" :value="value">
                        {{ label }} · {{ counts[value] }}
                      </option>
                    </select></label
                  >
                  <label class="filter-label"
                    >状态
                    <select v-model="status" :disabled="marking">
                      <option value="pending">待处理</option>
                      <option value="ignored">已忽略</option>
                      <option value="done">已处理</option>
                    </select></label
                  >
                </div>
                <div class="sidebar-actions">
                  <button type="button" :disabled="detecting" @click="detect">
                    {{ detecting ? '检查中…' : '检查疑似重复' }}
                  </button>
                  <button type="button" :disabled="rescanning || scanning" @click="requestRescan">
                    {{ rescanning || scanning ? '重扫中…' : '全库后台重扫与补全' }}
                  </button>
                </div>
              </div>
            </details>

            <p v-if="filesLoading" role="status" class="status-note">正在读取文件资料…</p>
            <div
              class="files-workbench-grid"
              :class="{ 'has-selection': inspectedKey || chosen.length }"
            >
              <div class="files-list-column">
                <p v-if="error" role="alert" class="alert-note">
                  {{ error }}
                  <button
                    type="button"
                    :disabled="filesLoading"
                    @click="inboxState ? loadPage().catch(showReadError) : openFiles()"
                  >
                    重新读取
                  </button>
                </p>
                <p v-if="notice" role="status" class="status-note">{{ notice }}</p>
                <div v-if="visible.length" class="inbox-controls batch-bar">
                  <button type="button" :disabled="marking" @click="selectPage">选择本页</button
                  ><button type="button" :disabled="marking" @click="clearSelection">
                    清空选择
                  </button>
                  <span class="selection-badge">{{ chosen.length }} 首已选</span>
                </div>
                <p v-if="!filesLoading && !error && !visible.length" class="empty-note">
                  {{
                    kind === 'duplicate' && !inboxPage
                      ? '点击“检查疑似重复”开始只读复核。'
                      : optionalFiles
                        ? '当前筛选没有待展示的整理项。'
                        : '没有待确认的文件资料。封面和标签可在“可选整理”中按需补充。'
                  }}
                </p>
                <ul ref="list" class="inbox-list">
                  <li
                    v-for="issue in visible"
                    :key="issue.key"
                    class="inbox-row"
                    data-te-interactive
                    :class="{ 'is-inspected': inspectedIssue?.key === issue.key }"
                    @click="inspectedKey = issue.key"
                  >
                    <label class="row-check-label" @click.stop
                      ><input
                        type="checkbox"
                        :disabled="marking"
                        :checked="selection.has(issue.key)"
                        @change="toggle(issue.key)"
                      /><strong>{{ issue.track.title || issue.track.id }}</strong> ·
                      <span class="issue-kind-pill">{{ inboxLabels[issue.kind] }}</span></label
                    >
                    <p>{{ issue.track.artist }} · {{ issue.track.album }} · {{ issue.reason }}</p>
                    <small>{{ issue.track.id }}</small>
                  </li>
                </ul>
                <footer v-if="filtered" class="list-footer">
                  <button type="button" :disabled="page === 0" @click="page--">上一页</button
                  ><span>第 {{ page + 1 }} / {{ pageCount }} 页 · {{ filtered }} 项</span
                  ><button type="button" :disabled="page + 1 >= pageCount" @click="page++">
                    下一页
                  </button>
                </footer>
              </div>

              <aside
                v-if="inspectedKey || chosen.length"
                class="files-evidence-column"
                aria-label="所选问题证据与操作"
              >
                <div class="evidence-card">
                  <h3>所选条目</h3>
                  <dl class="evidence-dl">
                    <div>
                      <dt>发生了什么</dt>
                      <dd v-if="inspectedIssue">
                        {{ inspectedIssue.track.title || inspectedIssue.track.id }}（{{
                          inboxLabels[inspectedIssue.kind]
                        }}）
                      </dd>
                      <dd v-else>请从左侧列表勾选或点击要核对的曲目</dd>
                    </div>
                    <div v-if="inspectedIssue">
                      <dt>依据是什么</dt>
                      <dd>
                        {{ inspectedIssue.reason }} · 艺人：{{
                          inspectedIssue.track.artist || '未知'
                        }}
                        · 专辑：{{ inspectedIssue.track.album || '未知' }}
                      </dd>
                    </div>
                    <div>
                      <dt>操作范围与影响</dt>
                      <dd>
                        当前明确选择 <strong>{{ chosen.length }}</strong> 首曲目（本页共
                        {{
                          visible.length
                        }}
                        项）。标记“已处理”或“忽略”仅保存复核状态，不会修改歌曲或音频文件；编辑标签会在写入前展示逐文件预览。
                      </dd>
                    </div>
                  </dl>
                  <div class="inbox-controls evidence-actions">
                    <button
                      type="button"
                      class="primary-btn"
                      :disabled="marking || !chosen.length"
                      @click="editSelected"
                    >
                      预览并编辑标签
                    </button>
                    <button
                      type="button"
                      :disabled="marking || !chosen.length"
                      @click="mark('done')"
                    >
                      标记已处理
                    </button>
                    <button
                      type="button"
                      :disabled="marking || !chosen.length"
                      @click="mark('ignored')"
                    >
                      忽略
                    </button>
                    <button
                      type="button"
                      :disabled="marking || !chosen.length"
                      @click="mark('pending')"
                    >
                      重新打开
                    </button>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </section>
    <LocalLibraryTagManager
      v-if="editTracks.length"
      :tracks="editTracks"
      :selection="editSelection"
      :current-tracks="tracks"
      @close="closeTagEditor"
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
  background: color-mix(in srgb, var(--te-neutral-900) 40%, transparent);
  backdrop-filter: blur(4px);
}
.inbox-dialog {
  width: min(820px, calc(100vw - 32px));
  max-height: min(840px, calc(100dvh - 40px));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: var(--te-font-size-body, 14px);
  padding: 20px 24px;
  border-radius: 14px;
  background: var(--te-glass-bg-strong, var(--te-card-bg, Canvas));
  color: var(--te-neutral-900);
  border: 1px solid var(--te-glass-border, var(--te-card-border));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.3);
}
.inbox-dialog.is-workspace {
  width: min(1180px, calc(100vw - 32px));
  height: min(840px, calc(100dvh - 40px));
}
.workbench-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  flex-shrink: 0;
}
.workbench-title-group h2 {
  margin: 0 0 4px;
  font-size: calc(var(--te-font-size-body, 14px) * 21 / 14);
}
.workbench-title-group p {
  margin: 0;
  font-size: 12.5px;
  color: var(--te-neutral-500);
}
.workbench-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.inbox-controls.nav-group {
  display: flex;
  align-items: center;
  gap: 20px;
  margin: 0;
  border-bottom: 1px solid var(--te-card-border);
}
.nav-group > button {
  text-align: left;
  padding: 10px 0;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--te-neutral-500);
  font-weight: 500;
}
.nav-group > button[aria-pressed='true'] {
  color: var(--te-neutral-900);
  background: transparent;
  border-color: var(--te-primary-500);
}
.tools-menu {
  position: relative;
  margin-left: auto;
  font-size: 13px;
}
summary {
  cursor: pointer;
  color: var(--te-neutral-500);
}
.tools-menu > summary {
  padding: 10px 0;
}
.tools-list {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 3;
  display: grid;
  gap: 4px;
  min-width: 180px;
  padding: 6px;
  border: 1px solid var(--te-card-border);
  border-radius: 9px;
  background: var(--te-card-bg, Canvas);
  box-shadow: 0 10px 30px rgb(0 0 0 / 18%);
}
.tools-list button {
  border: 0;
  text-align: left;
  background: transparent;
}
.tools-list button:hover {
  background: var(--te-hover-bg);
}
.files-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.optional-files {
  margin-bottom: 16px;
  font-size: 13px;
  flex-shrink: 0;
}
.sidebar-subfilters {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--te-glass-border, var(--te-card-border));
}
.filter-block {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.filter-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--te-neutral-500);
}
.sidebar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.workbench-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.embedded-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}
.files-workbench-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
  flex: 1;
  min-height: 0;
}
.files-workbench-grid.has-selection {
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.9fr);
}
.files-list-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.files-evidence-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.evidence-card {
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--te-glass-border, var(--te-card-border));
  background: color-mix(in srgb, var(--te-neutral-500) 5%, transparent);
}
.evidence-card h3 {
  margin: 0 0 12px;
  font-size: 1em;
  color: var(--te-neutral-900);
}
.evidence-dl {
  margin: 0 0 14px;
  display: grid;
  gap: 10px;
}
.evidence-dl dt {
  font-size: 12px;
  font-weight: 600;
  color: var(--te-primary-600);
  margin-bottom: 2px;
}
.evidence-dl dd {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--te-neutral-700, var(--te-neutral-900));
}
.evidence-actions {
  margin: 0;
}
.list-footer,
.inbox-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.list-footer {
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid var(--te-glass-border, var(--te-card-border));
}
p,
small {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
}
.status-note,
.alert-note {
  margin: 0 0 6px;
  font-size: 12.5px;
}
.alert-note {
  color: var(--te-danger, #d9534f);
}
.batch-bar {
  margin: 6px 0 10px;
}
.selection-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
button,
select {
  font: inherit;
  font-size: 12.5px;
  color: inherit;
  background: var(--te-glass-bg, var(--te-card-bg, transparent));
  border: 1px solid var(--te-glass-border, var(--te-card-border));
  border-radius: 6px;
  padding: 6px 10px;
}
button {
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}
.primary-btn {
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 45%, var(--te-card-border));
  font-weight: 600;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
summary:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
button[aria-pressed='true'] {
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 15%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 45%, var(--te-card-border));
  font-weight: 600;
}
.inbox-list {
  flex: 1;
  min-height: 80px;
  overflow: auto;
  list-style: none;
  padding: 0;
  margin: 0;
}
.inbox-row {
  padding: 10px 12px;
  border-radius: 8px;
  border-bottom: 1px solid var(--te-glass-border, var(--te-card-border));
  cursor: pointer;
}
.inbox-row:hover,
.inbox-row.is-inspected {
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
}
.inbox-row p {
  margin: 4px 0;
  font-size: 12.5px;
}
.issue-kind-pill {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
input[type='checkbox'] {
  margin-right: 8px;
}
@media (max-width: 900px) {
  .files-workbench-grid.has-selection {
    grid-template-columns: minmax(0, 1fr);
  }
  .files-workspace {
    overflow-y: auto;
  }
  .files-workbench-grid.has-selection {
    flex: none;
  }
  .files-workbench-grid.has-selection .inbox-list {
    max-height: 300px;
  }
}
@media (max-width: 520px) {
  .inbox-dialog,
  .inbox-dialog.is-workspace {
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 20px);
    padding: 18px 16px;
  }
  .nav-group {
    gap: 14px;
    font-size: 13px;
  }
}
</style>
