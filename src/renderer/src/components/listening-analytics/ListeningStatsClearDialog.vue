<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import type { ListeningStats } from '@renderer/stores/useListeningStatsStore'
import {
  isListeningStatsClearRange,
  previewListeningStatsClear,
  type ListeningStatsClearRange
} from '@renderer/stores/listeningStatsHistory'
import {
  formatListeningDuration,
  utcDayKey
} from '@renderer/components/listening-analytics/listeningAnalyticsData'

const props = defineProps<{ stats: ListeningStats; now: Date; busy?: boolean }>()
const emit = defineEmits<{ close: []; clear: [range: ListeningStatsClearRange] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const cancel = ref<HTMLButtonElement | null>(null)
const preset = ref('7')
const today = computed(() => utcDayKey(props.now))
const customStart = ref(utcDayKey(new Date(props.now.getTime() - 6 * 86_400_000)))
const customEnd = ref(today.value)

const range = computed<ListeningStatsClearRange>(() => {
  if (preset.value === 'all') return null
  if (preset.value === 'custom') return { startDay: customStart.value, endDay: customEnd.value }
  return {
    startDay: utcDayKey(new Date(props.now.getTime() - (Number(preset.value) - 1) * 86_400_000)),
    endDay: today.value
  }
})
const error = computed(() => {
  if (!isListeningStatsClearRange(range.value)) return '请选择有效日期，开始日期不能晚于结束日期。'
  if (range.value && range.value.endDay > today.value) return '结束日期不能晚于今天。'
  return ''
})
const preview = computed(() =>
  error.value ? null : previewListeningStatsClear(props.stats, range.value)
)
const canClear = computed(() =>
  Boolean(preview.value && (preview.value.dayCount > 0 || preview.value.trackCount > 0))
)

useNativeDialog(dialog)
onMounted(() => {
  cancel.value?.focus()
})

function onBackdropClick(event: MouseEvent): void {
  const element = dialog.value
  if (!element || event.target !== element) return
  const rect = element.getBoundingClientRect()
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    emit('close')
  }
}

function confirm(): void {
  if (canClear.value) emit('clear', range.value)
}
</script>

<template>
  <dialog
    ref="dialog"
    class="stats-clear-dialog"
    aria-labelledby="stats-clear-title"
    aria-describedby="stats-clear-description"
    @cancel.prevent="emit('close')"
    @click="onBackdropClick"
  >
    <header class="stats-clear-heading">
      <div>
        <h2 id="stats-clear-title">清除统计数据</h2>
        <p id="stats-clear-description">清理本机的聆听记录，清除后无法恢复。</p>
      </div>
      <button type="button" aria-label="关闭清除统计数据" @click="emit('close')">
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </header>
    <form @submit.prevent="confirm">
      <label class="stats-clear-field">
        <span>清除范围</span>
        <select v-model="preset" aria-label="清除范围">
          <option value="1">今天</option>
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
          <option value="custom">自定义日期</option>
          <option value="all">全部数据</option>
        </select>
      </label>
      <div v-if="preset === 'custom'" class="stats-clear-dates">
        <label class="stats-clear-field">
          <span>开始日期</span>
          <input v-model="customStart" type="date" :max="today" required aria-label="开始日期" />
        </label>
        <label class="stats-clear-field">
          <span>结束日期</span>
          <input v-model="customEnd" type="date" :max="today" required aria-label="结束日期" />
        </label>
      </div>
      <p class="stats-clear-scope">
        {{
          range
            ? `${range.startDay} 至 ${range.endDay}（含首尾日期）`
            : '全部每日记录和曲目累计统计'
        }}
        <span>日期与仪表盘一致，按 UTC 日划分。</span>
      </p>
      <p v-if="error" class="stats-clear-error" role="alert">{{ error }}</p>
      <div v-else-if="preview" class="stats-clear-preview" role="status" aria-live="polite">
        <span
          >将清除 <strong>{{ preview.dayCount }}</strong> 个日期的时长记录</span
        >
        <span
          >每日时长合计 <strong>{{ formatListeningDuration(preview.seconds) }}</strong></span
        >
        <span
          >更新 <strong>{{ preview.trackCount }}</strong> 首曲目的累计统计</span
        >
        <p v-if="!canClear">此范围没有可清除的记录。</p>
      </div>
      <p v-if="preview?.hasUndatedTracks" class="stats-clear-legacy">
        部分累计曲目记录没有每日明细，按日期清除会保留这部分数据。要一起删除，请选择“全部数据”。
      </p>
      <p class="stats-clear-note">音乐文件、收藏和歌单不受影响。正在播放的音乐会继续产生新记录。</p>
      <footer class="stats-clear-actions">
        <button ref="cancel" type="button" class="an-button" @click="emit('close')">取消</button>
        <button type="submit" class="an-button stats-clear-confirm" :disabled="!canClear || busy">
          <i class="ph ph-trash" aria-hidden="true"></i>
          {{ preset === 'all' ? '确认清除全部数据' : '确认清除' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.stats-clear-dialog {
  width: min(500px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  overflow: auto;
  margin: auto;
  padding: 28px;
  border: 1px solid var(--an-line);
  border-radius: 20px;
  background: var(--an-surface);
  color: var(--an-ink);
  box-shadow: 0 24px 80px var(--an-shadow);
}
.stats-clear-dialog::backdrop {
  background: var(--te-overlay-bg, rgba(0, 0, 0, 0.45));
}
.stats-clear-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.stats-clear-heading h2 {
  margin: 0 0 8px;
  font-size: 20px;
}
.stats-clear-heading p,
.stats-clear-scope,
.stats-clear-note,
.stats-clear-legacy {
  margin: 0;
  color: var(--an-muted);
  font-size: 12px;
  line-height: 1.7;
}
.stats-clear-heading button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 8px;
}
.stats-clear-heading button:hover {
  background: var(--an-soft);
}
.stats-clear-field {
  display: grid;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  font-weight: 550;
}
.stats-clear-field :is(select, input) {
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 10px;
  border: 1px solid var(--an-line);
  border-radius: 8px;
  background: var(--an-soft);
  color: var(--an-ink);
  font: inherit;
}
.stats-clear-field :is(select, input):focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.stats-clear-dates {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.stats-clear-scope {
  margin: 12px 0 16px;
}
.stats-clear-scope span {
  display: block;
}
.stats-clear-preview {
  display: grid;
  gap: 8px;
  padding: 16px;
  border-radius: 12px;
  background: var(--an-soft);
  color: var(--an-secondary);
  font-size: 13px;
}
.stats-clear-preview strong {
  color: var(--an-ink);
  font-variant-numeric: tabular-nums;
}
.stats-clear-preview p {
  margin: 4px 0 0;
  color: var(--an-muted);
}
.stats-clear-error,
.stats-clear-legacy {
  padding: 12px;
  border-radius: 8px;
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}
.stats-clear-error {
  font-size: 13px;
}
.stats-clear-legacy {
  margin-top: 12px;
}
.stats-clear-note {
  margin-top: 16px;
}
.stats-clear-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}
.stats-clear-confirm {
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}
.stats-clear-confirm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--te-danger-soft-fg) 12%, var(--te-danger-soft-bg));
}
.stats-clear-confirm:disabled {
  opacity: 0.45;
}
@media (max-width: 400px) {
  .stats-clear-dialog {
    padding: 20px;
  }
  .stats-clear-dates {
    grid-template-columns: 1fr;
  }
}
</style>
