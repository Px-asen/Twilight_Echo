<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import type { DuplicateDetectionResult } from '../../../shared/duplicateDetection.ts'
import type {
  LocalLibraryTagOperationResult,
  LocalLibraryTagPatch
} from '../../../shared/localLibraryTags.ts'
import type { Track } from '@renderer/types/music'
import {
  hasTagPatch,
  successfulTagPaths,
  summarizeTagWriteResults,
  tagPatchFromForm,
  tagWritePathKey,
  toDuplicateReviewGroups,
  validateTagCoverFile,
  type DuplicateReviewGroup
} from '@renderer/utils/localLibraryTagManagement.ts'

const props = withDefaults(
  defineProps<{
    tracks: Track[]
    currentTracks?: Track[]
    initialView?: 'edit' | 'duplicates'
  }>(),
  { initialView: 'edit' }
)

const emit = defineEmits<{
  close: []
  applied: [filePaths: string[], patch: LocalLibraryTagPatch]
}>()

const activeView = ref<'edit' | 'duplicates'>(props.initialView)
const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
let focusRestoreTarget: HTMLElement | null = null
const busy = ref(false)
const coverError = ref('')
const operationError = ref('')
const operationResults = shallowRef<LocalLibraryTagOperationResult[]>([])
const duplicateResult = shallowRef<DuplicateDetectionResult | null>(null)
const previewTracks = shallowRef<Track[]>([])
const previewPatch = shallowRef<LocalLibraryTagPatch | null>(null)
const previewPage = ref(0)
const resultsPage = ref(0)
const duplicatePage = ref(0)
const tagFieldLabels: Record<keyof LocalLibraryTagPatch, string> = {
  title: '标题',
  artist: '歌手',
  album: '专辑',
  albumArtist: '专辑歌手',
  track: '曲目号',
  disc: '碟号',
  year: '年份',
  genre: '流派',
  coverData: '封面'
}
const previewRows = computed(() =>
  previewTracks.value.slice(previewPage.value * 50, (previewPage.value + 1) * 50)
)
const resultRows = computed(() =>
  operationResults.value.slice(resultsPage.value * 50, (resultsPage.value + 1) * 50)
)
const duplicateRows = computed(() => {
  const rows: Array<{
    key: string
    label: string
    track: DuplicateReviewGroup['group']['items'][number]
  }> = []
  for (const [groupIndex, review] of reviewGroups.value.entries())
    for (const track of review.group.items)
      rows.push({
        key: `${review.group.kind}:${review.group.key}:${track.id}`,
        label: `第 ${groupIndex + 1} 组 · ${review.label}`,
        track
      })
  return rows
})
const visibleDuplicates = computed(() =>
  duplicateRows.value.slice(duplicatePage.value * 50, (duplicatePage.value + 1) * 50)
)
const duplicateError = ref('')
const form = ref({
  title: undefined as string | undefined,
  artist: undefined as string | undefined,
  album: undefined as string | undefined,
  albumArtist: undefined as string | undefined,
  track: null as number | null,
  disc: null as number | null,
  year: null as number | null,
  genre: undefined as string | undefined,
  coverData: undefined as Uint8Array | undefined,
  coverName: ''
})

const selectedLocalTracks = computed(() => props.tracks.filter((track) => track.filePath))
const summary = computed(() => summarizeTagWriteResults(operationResults.value))
const reviewGroups = computed<DuplicateReviewGroup[]>(() =>
  duplicateResult.value ? toDuplicateReviewGroups(duplicateResult.value) : []
)
const hasPatch = computed(() => hasTagPatch(toPatch()))
const canWrite = computed(
  () => !busy.value && selectedLocalTracks.value.length > 0 && hasPatch.value && !coverError.value
)
watch(
  form,
  () => {
    previewPatch.value = null
  },
  { deep: true }
)
watch(
  () => props.tracks,
  () => {
    previewPatch.value = null
  }
)
watch(
  () => props.currentTracks,
  () => {
    if (duplicateResult.value) {
      duplicateResult.value = null
      duplicateError.value = '曲库已变化，请重新检查。'
      duplicatePage.value = 0
    }
  }
)

function currentTargets(targets: Track[]): Track[] {
  if (!props.currentTracks) return targets
  const current = new Map(props.currentTracks.map((track) => [track.id, track]))
  return targets.filter((track) => current.get(track.id) === track)
}

function preparePreview(failedOnly = false): void {
  if (!canWrite.value) return
  const failed = new Set(
    operationResults.value
      .filter((item) => item.status !== 'success')
      .map((item) => tagWritePathKey(item.filePath))
  )
  const targets = failedOnly
    ? selectedLocalTracks.value.filter((track) => failed.has(tagWritePathKey(track.filePath)))
    : selectedLocalTracks.value
  if (currentTargets(targets).length !== targets.length) {
    operationError.value = '曲库数据已变化，请关闭编辑器并重新选择歌曲。'
    return
  }
  if (targets.some((track) => track.subTrack || track.cueRange)) {
    operationError.value = 'CUE 或容器子曲目共享源文件，请编辑原文件标签后重新扫描。'
    return
  }
  const paths = new Map(targets.map((track) => [tagWritePathKey(track.filePath), track]))
  if (paths.size > 1000) {
    operationError.value = '每次最多写入 1000 个文件，请缩小选择范围。'
    return
  }
  operationError.value = ''
  previewTracks.value = [...paths.values()]
  previewPatch.value = toPatch()
  previewPage.value = 0
}

function beforeValue(track: Track, key: string): string {
  if (key === 'coverData') return track.cover || track.coverSource ? '已有封面' : '无封面'
  if (key === 'track') return String(track.trackNumber ?? '未记录')
  if (key === 'disc') return String(track.discNumber ?? '未记录')
  return String((track as unknown as Record<string, unknown>)[key] ?? '未记录')
}

watch(
  () => props.tracks,
  (tracks) => {
    if (tracks.length !== 1) {
      form.value.title = undefined
      form.value.artist = undefined
      form.value.album = undefined
      form.value.albumArtist = undefined
      form.value.genre = undefined
      return
    }
    const [track] = tracks
    form.value.title = track.title
    form.value.artist = track.artist
    form.value.album = track.album
    form.value.albumArtist = track.albumArtist ?? ''
    form.value.genre = track.genre ?? ''
  },
  { immediate: true }
)

function toPatch(): LocalLibraryTagPatch {
  return tagPatchFromForm({
    title: form.value.title,
    artist: form.value.artist,
    album: form.value.album,
    albumArtist: form.value.albumArtist,
    track: form.value.track ?? undefined,
    disc: form.value.disc ?? undefined,
    year: form.value.year ?? undefined,
    genre: form.value.genre,
    coverData: form.value.coverData
  })
}

async function onCoverInput(event: Event): Promise<void> {
  coverError.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const validation = validateTagCoverFile(file)
  if (validation) {
    form.value.coverData = undefined
    form.value.coverName = ''
    coverError.value = validation
    input.value = ''
    return
  }
  try {
    form.value.coverData = new Uint8Array(await file.arrayBuffer())
    form.value.coverName = file.name
  } catch {
    form.value.coverData = undefined
    form.value.coverName = ''
    coverError.value = '无法读取封面文件'
  }
}

async function submitTagWrite(): Promise<void> {
  const patch = previewPatch.value
  const targets = previewTracks.value
  if (!patch || !hasTagPatch(patch) || targets.length === 0 || busy.value) return
  if (currentTargets(targets).length !== targets.length) {
    previewPatch.value = null
    operationError.value = '曲库数据已变化，请重新选择并预览。'
    return
  }
  busy.value = true
  operationError.value = ''
  operationResults.value = []
  try {
    const result = await window.api.library.writeTags({
      items: targets.map((track) => ({ filePath: track.filePath, ...patch }))
    })
    operationResults.value = result.items
    resultsPage.value = 0
    const currentPaths = new Set(
      currentTargets(targets).map((track) => tagWritePathKey(track.filePath))
    )
    const successful = successfulTagPaths(result.items).filter((path) =>
      currentPaths.has(tagWritePathKey(path))
    )
    if (successful.length > 0) emit('applied', successful, patch)
    if (currentPaths.size !== targets.length)
      operationError.value =
        '文件写入已返回；曲库期间发生变化，请后台重扫刷新，未覆盖新的曲库标签。'
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : '标签写入失败'
  } finally {
    busy.value = false
    previewPatch.value = null
  }
}

async function restoreFromJournal(): Promise<void> {
  if (busy.value) return
  busy.value = true
  operationError.value = ''
  try {
    const result = await window.api.library.restoreTags({ fromJournal: true })
    operationResults.value = result.items
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : '无法从恢复日志还原标签'
  } finally {
    busy.value = false
  }
}

async function loadDuplicates(): Promise<void> {
  if (busy.value) return
  busy.value = true
  duplicateError.value = ''
  const snapshot = props.currentTracks ?? props.tracks
  try {
    const result = await window.api.library.detectDuplicates()
    if (snapshot !== (props.currentTracks ?? props.tracks)) {
      duplicateResult.value = null
      duplicateError.value = '曲库已变化，请重新检查。'
    } else {
      duplicateResult.value = result
      duplicatePage.value = 0
    }
  } catch (error) {
    duplicateError.value = error instanceof Error ? error.message : '重复歌曲检查失败'
  } finally {
    busy.value = false
  }
}

function switchView(view: 'edit' | 'duplicates'): void {
  activeView.value = view
  if (view === 'duplicates' && !duplicateResult.value) void loadDuplicates()
}

function focusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  return [
    ...dialogRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ].filter((element) => !element.hasAttribute('hidden') && element.getClientRects().length > 0)
}

function restoreTriggerFocus(): void {
  const target = focusRestoreTarget
  focusRestoreTarget = null
  if (target?.isConnected) target.focus()
}

function requestClose(): void {
  if (busy.value) return
  emit('close')
  void nextTick(restoreTriggerFocus)
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = focusableElements()
  if (focusable.length === 0) {
    event.preventDefault()
    return
  }
  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
  const nextIndex = event.shiftKey
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex === -1 || currentIndex === focusable.length - 1
      ? 0
      : currentIndex + 1
  event.preventDefault()
  focusable[nextIndex].focus()
}

function onTabKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const nextView = activeView.value === 'edit' ? 'duplicates' : 'edit'
  switchView(nextView)
  void nextTick(() => document.getElementById(`tag-manager-${nextView}-tab`)?.focus())
}

onMounted(() => {
  const activeElement = document.activeElement
  focusRestoreTarget = activeElement instanceof HTMLElement ? activeElement : null
  void nextTick(() => closeButtonRef.value?.focus())
  if (activeView.value === 'duplicates') void loadDuplicates()
})
</script>

<template>
  <section
    ref="dialogRef"
    class="tag-manager"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tag-manager-title"
    @keydown="onDialogKeydown"
  >
    <header class="tag-manager-header">
      <div>
        <h3 id="tag-manager-title">标签与重复歌曲</h3>
        <p>{{ selectedLocalTracks.length }} 首本地歌曲已选中</p>
      </div>
      <button
        ref="closeButtonRef"
        type="button"
        class="tag-icon-button"
        aria-label="关闭标签管理"
        title="关闭"
        :disabled="busy"
        @click="requestClose"
      >
        <i class="pi pi-times"></i>
      </button>
    </header>

    <div class="tag-manager-tabs" role="tablist" aria-label="标签管理视图">
      <button
        type="button"
        id="tag-manager-edit-tab"
        role="tab"
        aria-controls="tag-manager-edit-panel"
        :aria-selected="activeView === 'edit'"
        :tabindex="activeView === 'edit' ? 0 : -1"
        @click="switchView('edit')"
        @keydown="onTabKeydown"
      >
        编辑标签
      </button>
      <button
        type="button"
        id="tag-manager-duplicates-tab"
        role="tab"
        aria-controls="tag-manager-duplicates-panel"
        :aria-selected="activeView === 'duplicates'"
        :tabindex="activeView === 'duplicates' ? 0 : -1"
        @click="switchView('duplicates')"
        @keydown="onTabKeydown"
      >
        重复检查
      </button>
    </div>

    <p class="tag-manager-live" aria-live="polite" aria-atomic="true">
      <template v-if="busy">正在处理，请勿关闭此窗口。</template>
      <template v-else-if="operationError">{{ operationError }}</template>
      <template v-else-if="operationResults.length">
        已成功 {{ summary.successCount }} 项；失败 {{ summary.failedCount }} 项；已回滚
        {{ summary.rolledBackCount }} 项；未执行 {{ summary.notAttemptedCount }} 项。
      </template>
    </p>

    <form
      v-if="activeView === 'edit'"
      id="tag-manager-edit-panel"
      class="tag-editor"
      role="tabpanel"
      aria-labelledby="tag-manager-edit-tab"
      @submit.prevent="preparePreview()"
    >
      <p class="tag-help">批量写入只会覆盖填写的字段。每次写入都先创建可恢复备份。</p>
      <fieldset class="tag-form-grid" :disabled="busy">
        <label>标题<input v-model="form.title" maxlength="1024" /></label>
        <label>歌手<input v-model="form.artist" maxlength="1024" /></label>
        <label>专辑<input v-model="form.album" maxlength="1024" /></label>
        <label>专辑歌手<input v-model="form.albumArtist" maxlength="1024" /></label>
        <label>曲目号<input v-model.number="form.track" type="number" min="1" max="9999" /></label>
        <label>碟号<input v-model.number="form.disc" type="number" min="1" max="9999" /></label>
        <label>年份<input v-model.number="form.year" type="number" min="1" max="9999" /></label>
        <label>流派<input v-model="form.genre" maxlength="1024" /></label>
        <label class="tag-cover-input"
          >封面
          <input accept="image/png,image/jpeg" type="file" @change="onCoverInput" />
          <span v-if="form.coverName">{{ form.coverName }}</span>
        </label>
      </fieldset>
      <p v-if="coverError" class="tag-field-error" role="alert">{{ coverError }}</p>
      <div class="tag-actions">
        <button
          type="button"
          class="tag-secondary-button"
          :disabled="busy"
          @click="restoreFromJournal"
        >
          从恢复日志还原
        </button>
        <button type="submit" class="tag-primary-button" :disabled="!canWrite" :aria-busy="busy">
          {{ busy ? '正在写入' : `预览 ${selectedLocalTracks.length} 首的修改` }}
        </button>
        <button
          v-if="summary.failedCount || summary.rolledBackCount || summary.notAttemptedCount"
          type="button"
          :disabled="busy"
          @click="preparePreview(true)"
        >
          预览失败项并重试
        </button>
      </div>
      <section v-if="previewPatch" class="tag-preview" aria-label="标签修改预览">
        <p>请核对前后值。未填写的字段保持原值，封面写入后请后台重扫刷新。</p>
        <article v-for="track in previewRows" :key="track.filePath">
          <strong>{{ track.filePath }}</strong>
          <p v-for="(value, field) in previewPatch" :key="field">
            {{ tagFieldLabels[field] }}：{{ beforeValue(track, field) }} →
            {{ field === 'coverData' ? form.coverName : value }}
          </p>
        </article>
        <button type="button" :disabled="previewPage === 0 || busy" @click="previewPage--">
          上一页预览
        </button>
        <span>第 {{ previewPage + 1 }} 页 · {{ previewTracks.length }} 个文件</span>
        <button
          type="button"
          :disabled="(previewPage + 1) * 50 >= previewTracks.length || busy"
          @click="previewPage++"
        >
          下一页预览
        </button>
        <button type="button" class="tag-primary-button" :disabled="busy" @click="submitTagWrite">
          确认写入 {{ previewTracks.length }} 个文件
        </button>
      </section>
    </form>

    <section
      v-else
      id="tag-manager-duplicates-panel"
      class="duplicate-review"
      role="tabpanel"
      aria-labelledby="tag-manager-duplicates-tab"
    >
      <div class="tag-actions">
        <p>仅展示建议，不会删除文件、合并条目或修改标签。</p>
        <button type="button" class="tag-secondary-button" :disabled="busy" @click="loadDuplicates">
          重新检查
        </button>
      </div>
      <p v-if="duplicateError" class="tag-field-error" role="alert">{{ duplicateError }}</p>
      <p v-else-if="busy" class="tag-help">正在读取本地音乐库并计算重复项。</p>
      <p v-else-if="duplicateResult && reviewGroups.length === 0" class="tag-help">
        未发现需要复核的重复歌曲。
      </p>
      <div v-else class="duplicate-groups">
        <article v-for="review in visibleDuplicates" :key="review.key" class="duplicate-group">
          <header>
            <strong>{{ review.label }}</strong>
          </header>
          <p>{{ review.track.title || review.track.filePath }}</p>
          <small>{{ review.track.artist }} · {{ review.track.filePath }}</small>
        </article>
        <button :disabled="duplicatePage === 0" @click="duplicatePage--">上一页</button>
        <span>{{ duplicateRows.length }} 个候选 · 第 {{ duplicatePage + 1 }} 页</span>
        <button
          :disabled="(duplicatePage + 1) * 50 >= duplicateRows.length"
          @click="duplicatePage++"
        >
          下一页
        </button>
      </div>
    </section>

    <details v-if="operationResults.length" class="tag-operation-details">
      <summary>查看逐项结果</summary>
      <ul>
        <li
          v-for="result in resultRows"
          :key="`${result.filePath}:${result.status}`"
          :class="`tag-result-${result.status}`"
        >
          <strong>{{ result.status }}</strong
          ><span :title="result.filePath">{{ result.filePath }}</span
          ><small v-if="result.message">{{ result.message }}</small>
        </li>
      </ul>
      <button :disabled="resultsPage === 0" @click="resultsPage--">上一页结果</button>
      <button :disabled="(resultsPage + 1) * 50 >= operationResults.length" @click="resultsPage++">
        下一页结果
      </button>
    </details>
  </section>
</template>

<style scoped>
.tag-manager {
  width: min(760px, calc(100vw - 32px));
  max-height: min(780px, calc(100vh - 48px));
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--te-glass-border, #dce0e8);
  border-radius: 8px;
  background: var(--te-glass-bg-strong, #fff);
  color: var(--te-neutral-900, #1b1b1b);
  box-shadow: 0 24px 64px rgba(24, 28, 42, 0.28);
}
.tag-manager-header,
.tag-actions,
.duplicate-group header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.tag-manager-header h3 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
}
.tag-manager-header p,
.tag-help,
.tag-manager-live,
.duplicate-group header span {
  color: var(--te-neutral-600, #657084);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.tag-manager-header p {
  margin: 4px 0 0;
}
.tag-icon-button {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.tag-icon-button:hover {
  background: rgba(0, 0, 0, 0.07);
}
.tag-manager-tabs {
  display: flex;
  gap: 4px;
  margin: 18px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.22);
}
.tag-manager-tabs button {
  border: 0;
  padding: 8px 10px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}
.tag-manager-tabs button[aria-selected='true'] {
  color: var(--te-primary-600, #6345d5);
  border-bottom: 2px solid currentColor;
  font-weight: 700;
}
.tag-manager-live {
  min-height: 18px;
  margin: 8px 0;
}
.tag-editor {
  display: grid;
  gap: 12px;
}
.tag-form-grid {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.tag-preview {
  overflow-wrap: anywhere;
}
.tag-form-grid label {
  display: grid;
  gap: 5px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
}
.tag-form-grid input {
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 4px;
  padding: 6px 8px;
  font: inherit;
}
.tag-cover-input {
  grid-column: 1 / -1;
}
.tag-cover-input span {
  color: var(--te-neutral-600, #657084);
  font-weight: 400;
}
.tag-field-error {
  margin: 0;
  color: #b42318;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.tag-actions {
  margin-top: 8px;
}
.tag-actions p {
  margin: 0;
  color: var(--te-neutral-600, #657084);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.tag-primary-button,
.tag-secondary-button {
  min-height: 36px;
  border-radius: 5px;
  padding: 7px 12px;
  font: inherit;
  cursor: pointer;
}
.tag-primary-button {
  border: 1px solid #6845de;
  background: #6845de;
  color: #fff;
}
.tag-secondary-button {
  border: 1px solid rgba(104, 69, 222, 0.36);
  background: transparent;
  color: #5635bb;
}
.tag-primary-button:disabled,
.tag-secondary-button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.duplicate-groups {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}
.duplicate-group {
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 6px;
  padding: 12px;
}
.duplicate-group header strong {
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
}
.duplicate-group ul,
.tag-operation-details ul {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.duplicate-group li {
  display: grid;
  gap: 2px;
  padding-top: 6px;
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}
.duplicate-group small,
.tag-operation-details small {
  overflow: hidden;
  color: var(--te-neutral-600, #657084);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.duplicate-suggestion {
  margin: 10px 0 0;
  color: #875a00;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.tag-operation-details {
  margin-top: 16px;
}
.tag-operation-details summary {
  cursor: pointer;
  font-weight: 600;
}
.tag-operation-details li {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
}
.tag-operation-details span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-operation-details small {
  grid-column: 2;
}
.tag-result-success strong {
  color: #18794e;
}
.tag-result-failed strong,
.tag-result-rolledBack strong {
  color: #b42318;
}
.tag-result-notAttempted strong {
  color: #875a00;
}
@media (max-width: 560px) {
  .tag-form-grid {
    grid-template-columns: 1fr;
  }
  .tag-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .tag-actions button {
    width: 100%;
  }
}
</style>
