<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Track } from '@renderer/types/music.ts'
import { getSongListVirtualRange } from '@renderer/components/song-list/songListVirtualWindow.ts'
import {
  buildLibraryLoudnessPlan,
  type LoudnessAlbum
} from '@renderer/components/library-loudness/libraryLoudnessPlan.ts'
import { useLibraryLoudness } from '@renderer/components/library-loudness/useLibraryLoudness.ts'
import { loudnessGainValues } from '../../../../shared/libraryLoudness.ts'
import type { LoudnessAnalysisResult } from '../../../../shared/audioEngineTypes.ts'

const props = defineProps<{
  libraryTracks: Track[]
  selectedTracks: Track[] | null
  albums: LoudnessAlbum[]
  restoreFocus?: HTMLElement | null
}>()
const emit = defineEmits<{ close: [] }>()
const mode = ref<'track' | 'album'>('track')
const libraryIndex = computed(() => new Map(props.libraryTracks.map((track) => [track.id, track])))
const selection = computed(() =>
  props.selectedTracks === null
    ? props.libraryTracks
    : props.selectedTracks.map((track) => libraryIndex.value.get(track.id) ?? track)
)
const plan = computed(() => buildLibraryLoudnessPlan(selection.value, props.albums, mode.value))
const groups = computed(() => plan.value.groups)
const {
  status,
  items,
  results,
  error,
  busy,
  loading,
  running,
  retryGroups,
  start,
  cancel,
  clear,
  reload,
  retryAction
} = useLibraryLoudness(groups, window.api.loudnessAnalysis)
const dialog = ref<HTMLDialogElement | null>(null)
const grid = ref<HTMLElement | null>(null)
const trackMode = ref<HTMLInputElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(360)
const selectedRow = ref(0)
const ROW_HEIGHT = 64
let previousFocus: HTMLElement | null = null
let observer: ResizeObserver | undefined

const rows = computed(() => {
  const rows: {
    id: string
    groupId: string
    title: string
    member: number | null
    count: number
  }[] = []
  for (const group of groups.value) {
    rows.push({
      id: group.id,
      groupId: group.id,
      title: group.title,
      member: null,
      count: group.tracks.length
    })
    if (group.mode === 'album') {
      for (let member = 0; member < group.tracks.length; member++) {
        rows.push({
          id: `${group.id}:${member}`,
          groupId: group.id,
          title: group.tracks[member].title || group.tracks[member].id,
          member,
          count: 1
        })
      }
    }
  }
  return rows
})
const range = computed(() =>
  getSongListVirtualRange({
    trackCount: rows.value.length,
    scrollTop: scrollTop.value,
    viewportHeight: viewportHeight.value,
    tableOffsetTop: 0,
    rowHeight: ROW_HEIGHT,
    overscanRows: 4
  })
)
const visibleRows = computed(() => {
  const visible: ((typeof rows.value)[number] & {
    index: number
    measurement: LoudnessAnalysisResult | undefined
    gains: ReturnType<typeof loudnessGainValues> | null
    state: string
    reason: string
  })[] = []
  for (let index = range.value.start; index < range.value.end; index++) {
    const row = rows.value[index]
    const result = results.value.get(row.groupId)
    const item = items.value.get(row.groupId)
    const measurement = row.member === null ? result?.measurement : result?.tracks?.[row.member]
    let state = measurement ? '已分析' : '未分析'
    let reason = result?.reason || ''
    if (item?.state === 'failed') {
      state = '分析失败'
      reason = item.reason || reason
    } else if (item && running.value) {
      if (item.state === 'queued') state = '等待分析'
      if (item.state === 'analyzing') state = '正在分析'
    } else if (
      !measurement &&
      (item?.state === 'cancelled' ||
        (status.value.state === 'cancelled' &&
          item &&
          ['queued', 'analyzing'].includes(item.state)))
    )
      state = '已取消'
    if (result?.status === 'unavailable') state = '不可用'
    if (measurement && item?.state === 'cached') state = '已缓存'
    const gains = measurement ? loudnessGainValues(measurement) : null
    visible.push({ ...row, index, measurement, gains, state, reason })
  }
  return visible
})
const progressText = computed(() => {
  const labels = {
    idle: '尚未开始',
    running: '分析中',
    cancelling: '正在取消',
    completed: '任务完成',
    cancelled: '已取消'
  }
  return `${labels[status.value.state]} · ${status.value.processed} / ${status.value.total} 组${status.value.failed ? ` · ${status.value.failed} 组失败` : ''}`
})

function onGridKey(event: KeyboardEvent): void {
  let next = selectedRow.value
  if (event.key === 'ArrowDown') next++
  else if (event.key === 'ArrowUp') next--
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = rows.value.length - 1
  else if (event.key === 'PageDown')
    next += Math.max(1, Math.floor(viewportHeight.value / ROW_HEIGHT))
  else if (event.key === 'PageUp')
    next -= Math.max(1, Math.floor(viewportHeight.value / ROW_HEIGHT))
  else return
  event.preventDefault()
  selectedRow.value = Math.max(0, Math.min(rows.value.length - 1, next))
  const top = selectedRow.value * ROW_HEIGHT
  if (grid.value) {
    if (top < grid.value.scrollTop) grid.value.scrollTop = top
    else if (top + ROW_HEIGHT > grid.value.scrollTop + viewportHeight.value)
      grid.value.scrollTop = top + ROW_HEIGHT - viewportHeight.value
    scrollTop.value = grid.value.scrollTop
  }
}

watch(rows, () => {
  selectedRow.value = 0
  scrollTop.value = 0
  if (grid.value) grid.value.scrollTop = 0
})
onMounted(async () => {
  previousFocus =
    props.restoreFocus ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  dialog.value?.showModal()
  await nextTick()
  trackMode.value?.focus()
  observer = new ResizeObserver(() => {
    viewportHeight.value = grid.value?.clientHeight || 360
  })
  if (grid.value) observer.observe(grid.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  dialog.value?.close()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <dialog
    ref="dialog"
    class="loudness-dialog"
    aria-labelledby="loudness-title"
    @cancel.prevent="emit('close')"
  >
    <header>
      <div>
        <h2 id="loudness-title">批量响度分析</h2>
        <p>测量选中的本地音乐，将结果保存在曲库。</p>
      </div>
      <button type="button" aria-label="关闭响度分析" @click="emit('close')">
        <i class="pi pi-times" aria-hidden="true"></i>
      </button>
    </header>
    <div class="loudness-options">
      <fieldset>
        <legend>分析范围</legend>
        <label
          ><input
            ref="trackMode"
            v-model="mode"
            type="radio"
            value="track"
            name="loudness-mode"
          />曲目 Track</label
        >
        <label
          ><input v-model="mode" type="radio" value="album" name="loudness-mode" />完整专辑
          Album</label
        >
      </fieldset>
      <span
        >{{ plan.trackCount.toLocaleString() }} 首 · {{ groups.length.toLocaleString() }} 组</span
      >
    </div>
    <p class="scope-note">
      {{
        mode === 'album'
          ? '包含当前曲库中这些专辑的全部歌曲，按碟号和曲序测量。'
          : '每首独立测量；CUE 只分析对应的实际文件区间。'
      }}<span v-if="plan.skipped"> 已跳过 {{ plan.skipped }} 首非本地或无专辑归属的歌曲。</span>
    </p>
    <div v-if="error || plan.error" class="loudness-error" role="alert">
      <span>{{ error || plan.error }}</span>
      <button v-if="error" type="button" :disabled="busy" @click="retryAction">重试操作</button>
    </div>
    <div class="loudness-progress" role="status" aria-live="polite">
      <span>{{ progressText }}</span
      ><span v-if="status.currentTitle" class="current-title">{{ status.currentTitle }}</span>
      <progress
        :value="status.processed"
        :max="Math.max(1, status.total)"
        aria-label="响度分析进度"
      ></progress>
    </div>
    <div class="loudness-head" aria-hidden="true">
      <span>曲目 / 专辑</span><span>LUFS</span><span>dBTP</span><span>RG2 · dB</span
      ><span>R128 · dB</span>
    </div>
    <div
      ref="grid"
      class="loudness-results"
      role="grid"
      tabindex="0"
      aria-label="响度测量结果，使用方向键浏览"
      :aria-rowcount="rows.length"
      :aria-colcount="5"
      :aria-busy="loading"
      :aria-activedescendant="
        selectedRow >= range.start && selectedRow < range.end
          ? `loudness-row-${selectedRow}`
          : undefined
      "
      @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
      @keydown="onGridKey"
    >
      <p v-if="!rows.length" class="empty">{{ plan.error || '此范围没有可分析的本地歌曲。' }}</p>
      <div :style="{ height: `${range.start * ROW_HEIGHT}px` }" aria-hidden="true"></div>
      <div
        v-for="row in visibleRows"
        :id="`loudness-row-${row.index}`"
        :key="row.id"
        class="loudness-row"
        data-te-interactive
        :class="{ member: row.member !== null, selected: selectedRow === row.index }"
        role="row"
        :aria-rowindex="row.index + 1"
        :aria-selected="selectedRow === row.index"
        @click="selectedRow = row.index"
      >
        <div class="result-name" role="gridcell" :title="row.reason || row.title">
          <strong
            >{{ row.member === null && mode === 'album' ? '专辑 · ' : '' }}{{ row.title }}</strong
          >
          <small
            >{{ row.reason || row.state
            }}{{ row.member === null && mode === 'album' ? ` · ${row.count} 首` : '' }}</small
          >
        </div>
        <span
          role="gridcell"
          :aria-label="`综合响度 ${row.measurement?.integratedLufs.toFixed(2) ?? '未分析'} LUFS`"
          >{{ row.measurement?.integratedLufs.toFixed(2) ?? '—' }}</span
        >
        <span
          role="gridcell"
          :aria-label="`真峰值 ${row.measurement?.truePeakDb.toFixed(2) ?? '未分析'} dBTP`"
          >{{ row.measurement?.truePeakDb.toFixed(2) ?? '—' }}</span
        >
        <span
          role="gridcell"
          :aria-label="`ReplayGain 2 增益 ${row.gains?.replayGain2Db.toFixed(2) ?? '未分析'} dB`"
          >{{ row.gains?.replayGain2Db.toFixed(2) ?? '—' }}</span
        >
        <span
          role="gridcell"
          :aria-label="`R128 增益 ${row.gains?.r128Db.toFixed(2) ?? '未分析'} dB`"
          :title="row.gains ? `Q7.8: ${row.gains.r128Q78}` : undefined"
          >{{ row.gains?.r128Db.toFixed(2) ?? '—' }}</span
        >
      </div>
      <div
        :style="{ height: `${Math.max(0, rows.length - range.end) * ROW_HEIGHT}px` }"
        aria-hidden="true"
      ></div>
    </div>
    <details>
      <summary>数值与缓存说明</summary>
      <p>
        LUFS 为综合响度，dBTP 为真峰值。ReplayGain 2 以 −18 LUFS 为参考；R128 以 −23 LUFS 为参考，其
        Q7.8 整数是增益 dB × 256 后取整。专辑按所有曲目的测量门限合并，真峰值取最高值。
      </p>
      <p>
        曲目与专辑分别缓存。专辑记录包含各曲目的测量结果；文件、CUE
        区间或专辑成员变化后须重新分析。清理只作用于当前模式和范围。
      </p>
    </details>
    <footer>
      <span>{{ loading ? '正在核对结果…' : '关闭后任务继续，可从库管理重新打开。' }}</span>
      <div class="loudness-actions">
        <button type="button" :disabled="busy || loading" @click="reload">刷新结果</button>
        <button type="button" :disabled="busy || running || !groups.length" @click="clear">
          清理此范围结果
        </button>
        <button
          v-if="retryGroups.length"
          type="button"
          :disabled="busy || running"
          @click="start(true)"
        >
          重试未完成项
        </button>
        <button
          v-if="running"
          type="button"
          :disabled="busy || status.state === 'cancelling'"
          @click="cancel"
        >
          {{ status.state === 'cancelling' ? '正在取消…' : '取消分析' }}
        </button>
        <button
          v-else
          type="button"
          class="primary"
          :disabled="busy || !groups.length || !!plan.error"
          @click="start()"
        >
          开始分析
        </button>
      </div>
    </footer>
  </dialog>
</template>

<style scoped>
.loudness-dialog {
  width: min(920px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  padding: 24px;
  border: 1px solid var(--border-color, #d5d2dd);
  border-radius: 18px;
  background: var(--bg-primary, #faf9fc);
  color: var(--text-primary, #28252e);
  font-size: var(--te-font-size-body, 14px);
  overflow: auto;
  box-shadow: 0 20px 80px #0003;
}
.loudness-dialog::backdrop {
  background: #0006;
}
header,
.loudness-options,
.loudness-actions,
.loudness-error,
.loudness-progress {
  display: flex;
  align-items: center;
  gap: 12px;
}
header {
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}
h2 {
  font-size: 1.4em;
  margin: 0 0 6px;
}
p {
  margin: 0;
  color: var(--text-secondary, #736c7e);
  line-height: 1.6;
}
button {
  font: inherit;
  border: 1px solid var(--border-color, #d5d2dd);
  color: inherit;
  background: var(--bg-secondary, #f0eef5);
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--accent-color, #6958cb);
  outline-offset: 3px;
}
button.primary {
  background: var(--accent-color, #6958cb);
  color: #fff;
  border-color: transparent;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  gap: 18px;
}
legend {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
input {
  accent-color: var(--accent-color, #6958cb);
}
.loudness-options {
  justify-content: space-between;
  flex-wrap: wrap;
}
.scope-note {
  margin: 10px 0 16px;
  font-size: 0.9em;
}
.loudness-error {
  padding: 10px;
  margin-bottom: 12px;
  background: color-mix(in srgb, #d94646 12%, transparent);
  border-radius: 8px;
}
.loudness-progress {
  flex-wrap: wrap;
  font-size: 0.9em;
  margin-bottom: 14px;
}
.current-title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-secondary, #736c7e);
}
progress {
  width: 100%;
  height: 6px;
  accent-color: var(--accent-color, #6958cb);
}
.loudness-head,
.loudness-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) repeat(4, 86px);
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}
.loudness-head {
  height: 36px;
  font-size: 0.85em;
  color: var(--text-secondary, #736c7e);
}
.loudness-results {
  height: min(360px, 40vh);
  min-height: 128px;
  overflow: auto;
  border: 1px solid var(--border-color, #d5d2dd);
  border-radius: 10px;
  scrollbar-gutter: stable;
}
.loudness-results:focus-visible {
  outline: 2px solid var(--accent-color, #6958cb);
  outline-offset: 2px;
}
.loudness-row {
  height: 64px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border-color, #d5d2dd);
  font-variant-numeric: tabular-nums;
}
.loudness-row.selected {
  background: color-mix(in srgb, var(--accent-color, #6958cb) 8%, transparent);
}
.loudness-row.member .result-name {
  padding-left: 16px;
}
.result-name {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.result-name strong,
.result-name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.result-name strong {
  font-weight: 500;
}
.result-name small {
  color: var(--text-secondary, #736c7e);
  font-size: 0.82em;
}
.empty {
  padding: 32px 16px;
  text-align: center;
}
details {
  margin-top: 14px;
  font-size: 0.86em;
  color: var(--text-secondary, #736c7e);
}
summary {
  cursor: pointer;
}
details p {
  margin-top: 8px;
}
footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  flex-wrap: wrap;
}
footer > span {
  font-size: 0.82em;
  color: var(--text-secondary, #736c7e);
}
.loudness-actions {
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 720px) {
  .loudness-dialog {
    padding: 16px;
    width: calc(100vw - 32px);
  }
  .loudness-head,
  .loudness-row {
    grid-template-columns: minmax(120px, 1fr) repeat(4, 60px);
    gap: 4px;
    font-size: 0.82em;
    padding: 0 8px;
  }
}
</style>
