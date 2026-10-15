<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDownloadTasks } from '../stores/useDownloadTasks'
import { useMusicStore } from '../stores/useMusicStore'
import { useAppUpdateStore } from '../stores/useAppUpdateStore'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'
import DownloadResultActions from './streaming-page/DownloadResultActions.vue'
import { downloadStatusLabel } from './streaming-page/streamingDownloads'
import type { LoudnessBatchStatus } from '../../../shared/libraryLoudness'

const api = window.api
const props = withDefaults(
  defineProps<{ active: boolean; filter?: 'all' | 'active' | 'attention'; compact?: boolean }>(),
  { filter: 'all', compact: false }
)
const emit = defineEmits<{ library: []; visibleCount: [count: number] }>()
const notices = useAppNoticeStore()
function openLibrary() {
  emit('library')
}
const downloads = useDownloadTasks()
const music = useMusicStore()
const update = useAppUpdateStore()
const scan = music.libraryScanStatus
const enrichment = music.libraryMetadataEnrichmentStatus
const loudness = ref<LoudnessBatchStatus | null>(null)
const actionError = ref('')
const pending = ref(new Set<string>())
const activeStates = [
  'queued',
  'preparing',
  'downloading',
  'running',
  'enriching',
  'paused',
  'cancelling',
  'resolving',
  'retrying',
  'verifying',
  'installing'
]
const labels: Record<string, string> = {
  idle: '待命',
  enriching: '信息补全中',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  cancelling: '正在取消',
  resolving: '准备更新',
  downloading: '正在下载',
  retrying: '正在重试',
  verifying: '校验中',
  ready: '可以安装',
  installing: '正在安装',
  error: '失败'
}
const jobs = computed(() => {
  const result: {
    id: string
    title: string
    state: string
    detail: string
    value?: number
    cancel?: () => Promise<unknown>
    retry?: () => Promise<unknown>
    pause?: () => Promise<unknown>
    resume?: () => Promise<unknown>
  }[] = []
  const s = scan.value
  if (s.state !== 'idle')
    result.push({
      id: 'scan',
      title: '曲库扫描',
      state: s.state,
      detail: s.error || `${s.current} / ${s.total} 个文件`,
      value: s.total ? s.current / s.total : undefined,
      cancel: ['running', 'enriching', 'paused'].includes(s.state)
        ? music.cancelLibraryScan
        : undefined,
      pause: s.state === 'running' ? music.pauseLibraryScan : undefined,
      resume: s.state === 'paused' ? music.resumeLibraryScan : undefined,
      retry: ['failed', 'cancelled'].includes(s.state) ? music.startFullLibraryScan : undefined
    })
  const m = enrichment.value
  if (m.state !== 'idle')
    result.push({
      id: 'metadata',
      title: '曲目信息补全',
      state: m.state === 'completed' && m.failed > 0 ? 'failed' : m.state,
      detail: m.error || `完成 ${m.completed}，失败 ${m.failed}，跳过 ${m.skipped} / ${m.total}`,
      value: m.total ? (m.completed + m.failed + m.skipped) / m.total : undefined,
      cancel:
        m.state === 'enriching' ? async () => music.cancelLibraryMetadataEnrichment() : undefined
    })
  const l = loudness.value
  if (l && l.state !== 'idle')
    result.push({
      id: 'loudness',
      title: '响度分析',
      state: l.state === 'completed' && l.failed > 0 ? 'failed' : l.state,
      detail: `${l.processed} / ${l.total}，失败 ${l.failed} ${l.currentTitle}`,
      value: l.total ? l.processed / l.total : undefined,
      cancel:
        l.state === 'running' && l.jobId
          ? () => window.api.loudnessAnalysis.cancelBatch(l.jobId!)
          : undefined
    })
  const u = update.state.value.progress
  if (u.phase !== 'idle' || update.state.value.checking)
    result.push({
      id: 'update',
      title: '应用更新',
      state: update.state.value.checking ? 'running' : u.phase,
      detail:
        u.error || u.message || (update.state.value.checking ? '正在检查更新' : u.version || ''),
      value: u.totalBytes ? u.receivedBytes / u.totalBytes : undefined,
      cancel: ['resolving', 'downloading', 'retrying', 'verifying'].includes(u.phase)
        ? update.cancel
        : undefined,
      retry: ['error', 'cancelled'].includes(u.phase) ? update.download : undefined
    })
  return result
})
const activeCount = computed(
  () =>
    jobs.value.filter((j) => activeStates.includes(j.state)).length +
    downloads.tasks.value.filter((t) => activeStates.includes(t.status)).length
)
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'error'].includes(state)
const visibleJobs = computed(() =>
  jobs.value.filter(
    (j) =>
      matches(j.state) &&
      // Completed work belongs in the activity history, not a second task summary.
      !(props.compact && j.state === 'completed') &&
      (j.id === 'update' ||
        !terminal(j.state) ||
        (!notices.noticeHistory.value.some((n) => n.dedupeKey === 'task-result:' + j.id) &&
          !notices.clearedTaskResultKeys.value.has('task-result:' + j.id)))
  )
)
const visibleDownloads = computed(() =>
  downloads.tasks.value.filter(
    (t) =>
      matches(t.status) &&
      (!terminal(t.status) ||
        (!notices.noticeHistory.value.some((n) => n.downloadTaskId === t.id) &&
          !notices.clearedTaskResultKeys.value.has('download-result:' + t.id)))
  )
)
function clearCompletedTasks(): void {
  for (const job of jobs.value) {
    if (job.id !== 'update' && terminal(job.state)) {
      notices.clearedTaskResultKeys.value.add('task-result:' + job.id)
    }
  }
  for (const task of downloads.tasks.value) {
    if (terminal(task.status)) {
      notices.clearedTaskResultKeys.value.add('download-result:' + task.id)
    }
  }
}
defineExpose({ clearCompletedTasks })
watch(
  activeCount,
  (count) => {
    notices.activeTaskCount.value = count
  },
  { immediate: true }
)
watch(
  () => visibleJobs.value.length + visibleDownloads.value.length,
  (count) => emit('visibleCount', count),
  { immediate: true }
)
watch(jobs, (current, previous) => {
  for (const job of current) {
    if (job.id === 'update') continue
    const key = 'task-result:' + job.id
    if (!terminal(job.state)) {
      const old = notices.noticeHistory.value.find((n) => n.dedupeKey === key)
      if (old) old.action = undefined
      continue
    }
    const before = previous.find((item) => item.id === job.id)
    if (!before || before.state === job.state) continue
    notices.pushNotice({
      kind: ['failed', 'error'].includes(job.state)
        ? 'error'
        : job.state === 'completed'
          ? 'success'
          : 'info',
      message: job.title + '：' + (labels[job.state] || job.state) + ' · ' + job.detail,
      dedupeKey: key,
      fresh: true,
      presentation: 'center',
      action: job.retry
        ? { label: '重试', run: job.retry }
        : { label: '查看曲库', run: openLibrary }
    })
  }
})
function matches(state: string) {
  return (
    props.filter === 'all' ||
    (props.filter === 'active'
      ? activeStates.includes(state)
      : ['failed', 'error', 'ready'].includes(state))
  )
}
async function run(id: string, action: () => Promise<unknown>) {
  if (pending.value.has(id)) return
  pending.value.add(id)
  actionError.value = ''
  try {
    await action()
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '操作失败，请重试'
    notices.pushNotice({
      kind: 'error',
      message: actionError.value,
      presentation: 'center',
      dedupeKey: 'task-action:' + id
    })
  } finally {
    pending.value.delete(id)
  }
}
let disposed = false
const stops: (() => void)[] = []
onMounted(() => {
  stops.push(downloads.connect(), update.connect())
  const apply = (s: LoudnessBatchStatus) => {
    if (!disposed && (!loudness.value || s.revision >= loudness.value.revision)) loudness.value = s
  }
  stops.push(window.api.loudnessAnalysis.onBatchProgress((e) => apply(e.status)))
  void window.api.loudnessAnalysis
    .getBatch()
    .then((s) => apply(s.status))
    .catch(() => {
      if (!disposed) actionError.value = '响度任务读取失败'
    })
})
onUnmounted(() => {
  disposed = true
  stops.forEach((stop) => stop())
  notices.activeTaskCount.value = 0
})
</script>

<template>
  <section
    v-if="active"
    class="notice-tasks"
    :class="{ 'notice-tasks--compact': compact }"
    aria-label="后台任务"
  >
    <h3 v-if="!compact && (visibleJobs.length || visibleDownloads.length)" class="task-group-title">
      后台任务
    </h3>
    <p
      v-if="
        actionError || downloads.error.value || update.error.value || update.connectionError.value
      "
      class="task-error"
      role="alert"
    >
      {{
        actionError || downloads.error.value || update.error.value || update.connectionError.value
      }}
    </p>
    <button v-if="downloads.error.value" type="button" @click="downloads.refresh">重新读取</button>
    <article class="task-record" v-for="job in visibleJobs" :key="job.id">
      <div class="task-meta">
        <strong>{{ job.title }}</strong
        ><span>{{ labels[job.state] || job.state }}</span>
      </div>
      <p>{{ job.detail }}</p>
      <progress
        v-if="activeStates.includes(job.state)"
        :value="job.value"
        max="1"
        :aria-label="job.title"
      ></progress>
      <div class="task-actions">
        <button v-if="job.id !== 'update'" type="button" @click="openLibrary">查看曲库</button>
        <button v-if="job.pause" :disabled="pending.has(job.id)" @click="run(job.id, job.pause)">
          暂停</button
        ><button v-if="job.resume" :disabled="pending.has(job.id)" @click="run(job.id, job.resume)">
          继续</button
        ><button v-if="job.cancel" :disabled="pending.has(job.id)" @click="run(job.id, job.cancel)">
          取消</button
        ><button v-if="job.retry" :disabled="pending.has(job.id)" @click="run(job.id, job.retry)">
          重试</button
        ><button
          v-if="job.id === 'update' && job.state === 'ready'"
          :disabled="pending.has(job.id)"
          @click="run(job.id, update.install)"
        >
          安装更新
        </button>
      </div>
    </article>
    <article class="task-record" v-for="task in visibleDownloads" :key="task.id">
      <div class="task-meta">
        <strong>{{ task.track.title }}</strong
        ><span>{{ downloadStatusLabel(task) }}</span>
      </div>
      <p>{{ task.track.artist }}</p>
      <progress
        v-if="activeStates.includes(task.status)"
        :value="task.progress"
        max="1"
        aria-label="下载进度"
      ></progress>
      <p v-if="task.error || task.warning">{{ task.error || task.warning }}</p>
      <DownloadResultActions v-if="task.status === 'completed'" :task="task" />
      <div class="task-actions">
        <button
          v-if="activeStates.includes(task.status)"
          :disabled="pending.has(task.id)"
          @click="run(task.id, () => api.providerDownloads.cancel(task.id))"
        >
          取消</button
        ><button
          v-if="['failed', 'cancelled'].includes(task.status)"
          :disabled="pending.has(task.id)"
          @click="run(task.id, () => api.providerDownloads.retry(task.id))"
        >
          重新下载
        </button>
      </div>
    </article>
  </section>
</template>
<style scoped>
.notice-tasks {
  padding: 0 20px;
  min-width: 0;
}
.notice-tasks--compact {
  padding: 0;
}
.notice-tasks--compact .task-record {
  padding: 12px 0;
}
.notice-tasks--compact .task-actions {
  justify-content: flex-start;
  margin-top: 4px;
}
.notice-tasks--compact button {
  background: var(--te-subtle-bg);
  font-weight: 400;
}
.task-group-title {
  margin: 16px 0 0;
  color: var(--te-settings-text-muted, var(--te-text-secondary));
  font-size: 11px;
  font-weight: 500;
}
.task-record {
  padding: 18px 0;
  border-bottom: 1px solid var(--notice-border);
  overflow-wrap: anywhere;
}
.task-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
}
.task-meta strong {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
.task-meta span {
  font-size: 11px;
  color: var(--te-settings-text-muted, var(--te-text-secondary));
}
p {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--te-settings-text-muted, var(--te-text-secondary));
}
.task-error {
  color: var(--te-danger-soft-fg);
}
progress {
  width: 100%;
  height: 5px;
  margin: 4px 0 6px;
  accent-color: var(--te-primary-500);
}
.task-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}
button {
  border: 0;
  border-radius: 7px;
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  color: var(--te-text, var(--te-settings-text));
  min-height: 28px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:hover:enabled {
  background: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
</style>
