<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue'
import { useAppNoticeStore, type AppNoticeKind } from '../stores/useAppNoticeStore'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer'
import { useDownloadTasks } from '../stores/useDownloadTasks'
const TaskCenter = defineAsyncComponent(() => import('./TaskCenter.vue'))
const DownloadResultActions = defineAsyncComponent(
  () => import('./streaming-page/DownloadResultActions.vue')
)

const emit = defineEmits<{ library: [] }>()
const props = defineProps<{ historyTarget?: HTMLElement | null; historyEmbedded?: boolean }>()
const embeddedHistory = computed(() => props.historyEmbedded === true || !!props.historyTarget)

const {
  notices,
  noticeHistory,
  centerOpen: historyOpen,
  activeTaskCount,
  doNotDisturb,
  setDoNotDisturb,
  dismissNotice,
  pauseNotice,
  resumeNotice,
  markHistoryRead,
  clearHistory,
  pendingActions,
  runNoticeAction
} = useAppNoticeStore()
const historyPanel = ref<HTMLElement | null>(null)
const filter = ref<'all' | 'active' | 'attention'>('all')
const showAllHistory = ref(false)
const visibleTaskCount = ref(0)
const taskCenter = ref<InstanceType<typeof TaskCenter> | null>(null)
function clearRecords(): void {
  clearHistory()
  taskCenter.value?.clearCompletedTasks()
}
const pointerOpened = ref(true)
const panelOrigin = ref('right top')
const downloads = useDownloadTasks()
const history = computed(() =>
  [...noticeHistory.value]
    .reverse()
    .filter(
      (notice) =>
        filter.value !== 'active' &&
        (filter.value === 'all' ||
          notice.kind === 'error' ||
          notice.kind === 'warning' ||
          !!notice.action)
    )
)
const displayedHistory = computed(() =>
  embeddedHistory.value && !showAllHistory.value ? history.value.slice(0, 3) : history.value
)
watch(filter, () => {
  showAllHistory.value = false
})
const downloadResults = computed(
  () =>
    new Map(
      downloads.tasks.value
        .filter((task) => task.status === 'completed')
        .map((task) => [task.id, task])
    )
)
const emptyLabel = computed(() =>
  filter.value === 'active'
    ? '暂无进行中的任务'
    : filter.value === 'attention'
      ? '暂无需要处理的内容'
      : '暂无任务和通知'
)
function openLibrary(): void {
  closeHistory()
  emit('library')
}
const intents: Record<AppNoticeKind, { label: string; icon: string }> = {
  info: { label: '提示', icon: 'pi-info-circle' },
  success: { label: '已完成', icon: 'pi-check-circle' },
  warning: { label: '请留意', icon: 'pi-exclamation-triangle' },
  error: { label: '需要处理', icon: 'pi-exclamation-circle' }
}
let historyTrigger: HTMLElement | null = null
function closeHistory(restoreFocus = true): void {
  historyOpen.value = false
  if (restoreFocus && historyTrigger?.isConnected) historyTrigger.focus()
}
async function toggleHistory(event?: MouseEvent): Promise<void> {
  if (historyOpen.value) return closeHistory()
  historyTrigger =
    event?.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : (document.activeElement as HTMLElement | null)
  pointerOpened.value = !event || event.detail !== 0
  historyOpen.value = true
  markHistoryRead(history.value.map((notice) => notice.id))
  await nextTick()
  if (historyPanel.value && historyTrigger) {
    const panel = historyPanel.value.getBoundingClientRect()
    const trigger = historyTrigger.getBoundingClientRect()
    panelOrigin.value =
      Math.max(16, Math.min(panel.width - 16, trigger.left + trigger.width / 2 - panel.left)) +
      'px top'
  }
  historyPanel.value?.focus()
}
function dismissOutside(event: PointerEvent): void {
  const target = event.target
  if (
    historyOpen.value &&
    !embeddedHistory.value &&
    target instanceof Node &&
    !historyPanel.value?.contains(target) &&
    !historyTrigger?.contains(target)
  )
    closeHistory(false)
}
function focusOut(event: FocusEvent, id: number): void {
  if (
    event.relatedTarget instanceof Node &&
    (event.currentTarget as HTMLElement).contains(event.relatedTarget)
  )
    return
  resumeNotice(id, 'focus')
}
function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
watch([historyOpen, displayedHistory, () => props.historyTarget], () => {
  if (historyOpen.value && (!embeddedHistory.value || props.historyTarget))
    markHistoryRead(
      displayedHistory.value.filter((notice) => !notice.read).map((notice) => notice.id)
    )
})
watch(historyOpen, (open) => {
  if (!open) showAllHistory.value = false
})
watch([historyOpen, notices], () => {
  for (const notice of notices.value) {
    if (historyOpen.value) {
      pauseNotice(notice.id, 'history')
      resumeNotice(notice.id, 'pointer')
      resumeNotice(notice.id, 'focus')
    } else resumeNotice(notice.id, 'history')
  }
})
const floatingHistoryOpen = computed(() => historyOpen.value && !embeddedHistory.value)
useEscapeToClose(floatingHistoryOpen, closeHistory)
useFocusTrap(historyPanel, floatingHistoryOpen)
onMounted(() => document.addEventListener('pointerdown', dismissOutside))
onBeforeUnmount(() => {
  historyOpen.value = false
  document.removeEventListener('pointerdown', dismissOutside)
  for (const notice of notices.value) {
    for (const reason of ['pointer', 'focus', 'history']) resumeNotice(notice.id, reason)
  }
})
defineExpose({ historyOpen, toggleHistory })
</script>

<template>
  <TransitionGroup
    v-show="!historyOpen && !doNotDisturb"
    tag="div"
    name="app-notice"
    class="app-notice-host"
    aria-relevant="additions text"
  >
    <div
      v-for="notice in notices"
      :key="notice.id"
      class="app-notice"
      :class="`notice-${notice.kind}`"
      :role="notice.kind === 'error' ? 'alert' : 'status'"
      @mouseenter="pauseNotice(notice.id, 'pointer')"
      @mouseleave="resumeNotice(notice.id, 'pointer')"
      @focusin="pauseNotice(notice.id, 'focus')"
      @focusout="focusOut($event, notice.id)"
    >
      <span class="notice-symbol"
        ><i class="pi" :class="intents[notice.kind].icon" aria-hidden="true"></i
      ></span>
      <div class="notice-content">
        <span class="notice-label">{{ intents[notice.kind].label }}</span>
        <p class="notice-message">{{ notice.message }}</p>
        <button
          v-if="notice.action"
          type="button"
          class="notice-action"
          :disabled="pendingActions.has(notice.id)"
          @click="runNoticeAction(notice.id)"
        >
          {{ notice.action.label }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
      <button
        type="button"
        class="notice-icon-button"
        aria-label="关闭通知"
        @click="dismissNotice(notice.id)"
      >
        <i class="pi pi-times" aria-hidden="true"></i>
      </button>
    </div>
  </TransitionGroup>
  <Teleport :to="historyTarget ?? 'body'" :disabled="!historyTarget">
    <Transition name="notice-panel" :css="pointerOpened && !embeddedHistory">
      <section
        v-show="historyOpen && (!embeddedHistory || historyTarget)"
        id="app-notice-history"
        ref="historyPanel"
        class="notice-history"
        :class="{ 'notice-history--embedded': embeddedHistory }"
        :style="{ transformOrigin: panelOrigin }"
        :tabindex="embeddedHistory ? undefined : -1"
        :role="embeddedHistory ? 'region' : 'dialog'"
        :aria-modal="embeddedHistory ? undefined : false"
        aria-labelledby="notice-history-title"
      >
        <header class="notice-history-header">
          <div>
            <h2 id="notice-history-title">{{ embeddedHistory ? '活动' : '任务与通知' }}</h2>
            <p v-if="activeTaskCount">{{ activeTaskCount }} 项任务进行中</p>
          </div>
          <div class="notice-header-actions">
            <button
              type="button"
              role="switch"
              class="notice-icon-button notice-dnd-toggle"
              aria-label="勿扰模式"
              :title="doNotDisturb ? '关闭勿扰模式' : '开启勿扰模式，通知仍会保留'"
              :aria-checked="doNotDisturb"
              @click="setDoNotDisturb(!doNotDisturb)"
            >
              <i class="pi pi-moon" aria-hidden="true"></i>
            </button>
            <button
              v-if="!embeddedHistory"
              type="button"
              class="notice-icon-button"
              aria-label="关闭任务与通知"
              @click="closeHistory()"
            >
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        <div class="notice-filters" role="group" aria-label="筛选任务与通知">
          <button
            v-for="item in [
              { value: 'all', label: '全部' },
              { value: 'active', label: '进行中' },
              { value: 'attention', label: '需处理' }
            ] as const"
            :key="item.value"
            type="button"
            :aria-pressed="filter === item.value"
            @click="filter = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="notice-history-body">
          <TaskCenter
            ref="taskCenter"
            :active="historyOpen"
            :filter="filter"
            :compact="embeddedHistory"
            @visible-count="visibleTaskCount = $event"
            @library="openLibrary"
          />
          <Transition name="notice-empty">
            <div v-if="!history.length && !visibleTaskCount" class="notice-empty">
              <span class="notice-empty-symbol"><i class="pi pi-bell" aria-hidden="true"></i></span>
              <h3>{{ emptyLabel }}</h3>
              <p v-if="filter === 'all'">新的通知会出现在这里</p>
            </div>
          </Transition>
          <h3 v-if="history.length && visibleTaskCount" class="notice-group-title">通知记录</h3>
          <TransitionGroup tag="div" name="notice-record" class="notice-records">
            <article
              v-for="notice in displayedHistory"
              :key="notice.id"
              class="notice-record"
              :class="`notice-${notice.kind}`"
            >
              <span class="notice-symbol"
                ><i class="pi" :class="intents[notice.kind].icon" aria-hidden="true"></i
              ></span>
              <div class="notice-content">
                <div class="notice-record-meta">
                  <span class="notice-label">{{ intents[notice.kind].label }}</span
                  ><time :datetime="new Date(notice.createdAt).toISOString()">{{
                    timeLabel(notice.createdAt)
                  }}</time>
                </div>
                <p class="notice-message">{{ notice.message }}</p>
                <button
                  v-if="notice.action"
                  type="button"
                  class="notice-action"
                  :disabled="pendingActions.has(notice.id)"
                  @click="runNoticeAction(notice.id)"
                >
                  {{ notice.action.label }} <i class="pi pi-arrow-right" aria-hidden="true"></i>
                </button>
                <DownloadResultActions
                  v-if="notice.downloadTaskId && downloadResults.has(notice.downloadTaskId)"
                  :task="downloadResults.get(notice.downloadTaskId)!"
                />
              </div>
            </article>
          </TransitionGroup>
        </div>
        <footer v-if="!embeddedHistory || history.length" class="notice-history-footer">
          <button
            v-if="embeddedHistory && history.length > 3"
            type="button"
            class="notice-history-more"
            :aria-expanded="showAllHistory"
            @click="showAllHistory = !showAllHistory"
          >
            {{ showAllHistory ? '收起记录' : `查看全部 ${history.length} 条` }}
          </button>
          <span v-else>{{ embeddedHistory ? `${history.length} 条记录` : '最近 50 条记录' }}</span>
          <button
            type="button"
            class="notice-clear"
            :disabled="!noticeHistory.length && !visibleTaskCount"
            @click="clearRecords"
          >
            清空记录
          </button>
        </footer>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-notice-host,
.notice-history {
  --notice-accent: var(--te-primary-500, #7c4dff);
  --notice-surface: var(--te-surface, var(--te-app-bg, #fff));
  --notice-text: var(--te-text, var(--color-text, #172033));
  --notice-muted: var(--te-settings-text-muted, var(--te-text-secondary, #626b78));
  --notice-border: color-mix(in srgb, var(--te-border, #9ca3af) 28%, transparent);
  position: fixed;
  top: calc(var(--te-titlebar-inset, 35px) + 12px);
  right: 16px;
  z-index: 12000;
  width: min(392px, calc(100vw - 32px));
  color: var(--notice-text);
  font-family: var(--te-font-sans, sans-serif);
}
.app-notice-host {
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
  max-height: calc(100dvh - var(--te-titlebar-inset, 35px) - 32px);
  overflow-y: auto;
  padding: 4px;
  right: 12px;
  width: min(400px, calc(100vw - 24px));
}
.app-notice,
.notice-record {
  --notice-intent: var(--notice-accent);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  box-sizing: border-box;
}
.notice-success {
  --notice-intent: var(--te-success-500, #20c65e);
}
.notice-warning {
  --notice-intent: var(--te-warning-500, #f59e0b);
}
.notice-error {
  --notice-intent: var(--te-danger-500, #e25565);
}
.app-notice {
  pointer-events: auto;
  padding: 16px;
  border: 1px solid var(--notice-border);
  border-radius: max(12px, var(--te-toast-radius, 8px));
  background: color-mix(in srgb, var(--notice-surface) 96%, transparent);
  box-shadow:
    0 3px 12px #0000000a,
    0 1px 3px #00000005;
  backdrop-filter: blur(20px);
}
.notice-symbol {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 10px;
  color: var(--notice-intent);
  background: color-mix(in srgb, var(--notice-intent) 11%, transparent);
  font-size: 16px;
}
.notice-content {
  flex: 1;
  min-width: 0;
}
.notice-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
}
.notice-message {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.notice-icon-button,
.notice-action,
.notice-clear {
  font: inherit;
  cursor: pointer;
  border: 0;
  transition:
    background 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}
.notice-icon-button {
  display: grid;
  place-items: center;
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--notice-muted);
  background: transparent;
  font-size: 12px;
}
.notice-icon-button:hover {
  background: color-mix(in srgb, var(--notice-text) 7%, transparent);
  color: var(--notice-text);
}
.notice-icon-button:active,
.notice-action:active,
.notice-clear:active {
  transform: scale(0.95);
}
.notice-action {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
  padding: 6px 10px;
  max-width: 100%;
  overflow-wrap: anywhere;
  text-align: left;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--notice-text);
  background: color-mix(in srgb, var(--notice-intent) 10%, transparent);
}
.notice-action .pi {
  font-size: 10px;
}
.notice-action:hover {
  background: color-mix(in srgb, var(--notice-intent) 18%, transparent);
}
button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
.notice-history {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-height: min(620px, calc(100dvh - var(--te-titlebar-inset, 35px) - 28px));
  border: 1px solid var(--notice-border);
  border-radius: 18px;
  background: color-mix(in srgb, var(--notice-surface) 96%, transparent);
  box-shadow:
    0 24px 70px #00000021,
    0 4px 14px #0000000a;
  backdrop-filter: blur(28px);
  overflow: hidden;
  outline: none;
}
.notice-history.notice-history--embedded {
  --notice-text: var(--te-material-ink, var(--te-text, #172033));
  position: relative;
  inset: auto;
  z-index: auto;
  width: 100%;
  max-height: none;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  overflow: visible;
  font-size: var(--te-type-body, 15px);
  line-height: 1.5;
}
.notice-history--embedded .notice-history-header {
  padding: 0 0 12px;
  align-items: flex-start;
  border: 0;
}
.notice-history--embedded .notice-history-body {
  overflow: visible;
}
.notice-history--embedded .notice-history-footer {
  padding: 8px 0 0;
  border: 0;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: var(--te-type-caption, 13px);
}
.notice-history--embedded .notice-history-header h2 {
  font-size: var(--te-type-headline, 17px);
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: normal;
}
.notice-history--embedded .notice-filters {
  padding: 0 0 8px;
  border: 0;
  gap: 4px;
}
.notice-history--embedded .notice-filters button {
  min-height: var(--te-control-height-md, 34px);
  padding: 6px 10px;
  color: var(--notice-muted);
  border-radius: var(--te-control-radius-sm, 8px);
  font-size: var(--te-type-caption, 13px);
  line-height: 1.5;
}
.notice-history--embedded .notice-filters button[aria-pressed='true'] {
  background: var(--te-subtle-bg);
  color: var(--notice-text);
  font-weight: 500;
}
.notice-history--embedded .notice-records {
  padding: 0;
}
.notice-history--embedded .notice-group-title {
  margin-inline: 0;
  font-size: var(--te-type-caption, 13px);
  line-height: 1.5;
}
.notice-history--embedded .notice-record {
  padding: 12px 0;
  gap: 10px;
}
.notice-history--embedded .notice-symbol {
  width: 22px;
  height: 22px;
  flex-basis: 22px;
  background: transparent;
  font-size: 17px;
}
.notice-history--embedded .notice-record-meta {
  justify-content: flex-start;
  min-height: 20px;
  align-items: center;
}
.notice-history--embedded :is(.notice-record time, .notice-label, .notice-history-header p) {
  font-size: var(--te-type-caption, 13px);
  line-height: 1.5;
}
.notice-history--embedded .notice-message {
  margin: 4px 0 0;
  font-size: var(--te-type-caption, 13px);
  line-height: 1.55;
  font-weight: 400;
}
.notice-history--embedded .notice-action {
  min-height: var(--te-control-height-md, 34px);
  margin-top: 4px;
  padding: 4px 0;
  background: transparent;
  color: var(--notice-muted);
  font-weight: 400;
  font-size: var(--te-type-caption, 13px);
}
.notice-history-more {
  min-height: 28px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--notice-muted);
  font: inherit;
  cursor: pointer;
}
.notice-history--embedded .notice-empty {
  min-height: 0;
  align-items: flex-start;
  padding: 12px 0;
}
.notice-history--embedded .notice-empty-symbol {
  display: none;
}
.notice-history--embedded .notice-empty h3 {
  margin-top: 0;
  font-size: var(--te-type-caption, 13px);
}
.notice-history--embedded .notice-empty p {
  font-size: var(--te-type-caption, 13px);
}
.notice-history--embedded :is(.notice-clear, .notice-history-more) {
  min-height: var(--te-control-height-md, 34px);
  font-size: var(--te-type-caption, 13px);
  line-height: 1.5;
}
.notice-history--embedded :deep(.task-record) {
  padding: 12px 0;
}
.notice-history--embedded :deep(.task-meta strong),
.notice-history--embedded :deep(.task-meta span),
.notice-history--embedded :deep(.task-group-title),
.notice-history--embedded :deep(.task-record p),
.notice-history--embedded :deep(.task-actions button) {
  font-size: var(--te-type-caption, 13px);
  line-height: 1.5;
}
.notice-history--embedded :deep(.task-actions button) {
  min-height: var(--te-control-height-md, 34px);
}
.notice-history--embedded .notice-icon-button {
  min-width: max(var(--te-control-height-md, 34px), 1.5em);
  min-height: max(var(--te-control-height-md, 34px), 1.5em);
  font-size: var(--te-type-icon, 16px);
}
.notice-history-header {
  flex-shrink: 0;
  gap: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--notice-border);
}
.notice-header-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}
.notice-dnd-toggle[aria-checked='true'] {
  color: var(--notice-accent);
  background: color-mix(in srgb, var(--notice-accent) 12%, transparent);
}
.notice-history-header h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.notice-history-header p {
  margin: 7px 0 0;
  font-size: 11px;
  color: var(--notice-muted);
}
.notice-history-body {
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  min-height: 0;
  scrollbar-width: thin;
}
.notice-records {
  position: relative;
  padding: 0 12px;
}
.notice-record {
  padding: 18px 8px;
  border-bottom: 1px solid var(--notice-border);
}
.notice-record:last-child {
  border-bottom: 0;
}
.notice-record-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.notice-record time {
  font-size: 10px;
  color: var(--notice-muted);
  font-variant-numeric: tabular-nums;
}
.notice-history-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--notice-border);
  font-size: 10px;
  color: var(--notice-muted);
}
.notice-clear {
  padding: 5px 7px;
  margin-right: -7px;
  border-radius: 6px;
  background: transparent;
  color: var(--notice-text);
  font-size: 11px;
}
.notice-clear:hover:enabled {
  background: color-mix(in srgb, var(--notice-text) 6%, transparent);
}
.notice-clear:disabled {
  cursor: default;
  opacity: 0.35;
}
.notice-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 240px;
}
.notice-empty-symbol {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 20px;
  font-size: 23px;
  background: color-mix(in srgb, var(--notice-accent) 7%, transparent);
  color: var(--notice-accent);
}
.notice-empty h3 {
  margin: 18px 0 0;
  font-size: 14px;
  font-weight: 500;
}
.notice-empty p {
  margin: 8px 0 0;
  color: var(--notice-muted);
  font-size: 12px;
}
.app-notice-enter-active,
.app-notice-move {
  transition:
    opacity var(--te-toast-motion-duration, 300ms) ease,
    transform var(--te-toast-motion-duration, 300ms) cubic-bezier(0.22, 1, 0.36, 1);
}
.app-notice-leave-active {
  position: absolute;
  right: 4px;
  width: calc(100% - 8px);
  transition:
    opacity 160ms ease,
    transform 180ms ease;
}
.app-notice-enter-from {
  opacity: 0;
  transform: translateY(-12px) scale(0.97);
}
.app-notice-leave-to {
  opacity: 0;
  transform: translateX(18px) scale(0.98);
}
.notice-panel-enter-active {
  transition:
    opacity 200ms ease,
    transform 360ms cubic-bezier(0.22, 1, 0.36, 1);
}
.notice-panel-leave-active {
  transition:
    opacity 140ms ease,
    transform 180ms cubic-bezier(0.4, 0, 1, 1);
  pointer-events: none;
}
.notice-panel-enter-from,
.notice-panel-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.96);
}
.notice-record-enter-active,
.notice-record-move {
  transition:
    opacity 220ms ease,
    transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.notice-record-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.notice-record-leave-active {
  position: absolute;
  width: calc(100% - 24px);
  transition: opacity 120ms ease;
}
.notice-record-leave-to {
  opacity: 0;
}
.notice-empty-enter-active {
  transition:
    opacity 240ms ease 100ms,
    transform 300ms ease 100ms;
}
.notice-empty-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
:global(html[data-te-motion='reduced'] .notice-history),
:global(html[data-te-motion='reduced'] .app-notice),
:global(html[data-te-motion='reduced'] .notice-record),
:global(html[data-te-motion='reduced'] .notice-empty) {
  transition-property: opacity, color, background-color !important;
  transition-duration: 120ms !important;
  transition-timing-function: var(--te-ease-out-strong) !important;
  transition-delay: 0ms !important;
  transform: none !important;
}
:global(body.te-no-blur .notice-history),
:global(body.te-no-blur .app-notice) {
  backdrop-filter: none;
  background: var(--notice-surface);
}
/* Keep filters and task controls within the existing dropdown surface. */
.notice-filters {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--notice-border);
}
.notice-filters button {
  border: 0;
  border-radius: 7px;
  min-height: 28px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--notice-text);
  background: transparent;
  cursor: pointer;
}
.notice-filters button:hover,
.notice-filters button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--notice-accent) 12%, transparent);
}
.notice-filters button[aria-pressed='true'] {
  font-weight: 600;
}
.notice-group-title {
  margin: 16px 20px 0;
  color: var(--notice-muted);
  font-size: 11px;
  font-weight: 500;
}
.notice-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.notice-record-meta {
  flex-wrap: wrap;
  gap: 4px 12px;
}
.notice-record time {
  flex-shrink: 0;
}
.notice-icon-button {
  flex-basis: 32px;
  width: 32px;
  height: 32px;
}
.notice-clear {
  min-height: 28px;
}
:global(html[data-te-motion='off'] .notice-history),
:global(html[data-te-motion='off'] .app-notice),
:global(html[data-te-motion='off'] .notice-record),
:global(html[data-te-motion='off'] .notice-empty) {
  transition: none !important;
  transform: none !important;
}
@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    .notice-history,
    .app-notice,
    .notice-record,
    .notice-empty {
      transition-property: opacity !important;
      transition-duration: 120ms !important;
      transform: none !important;
    }
  }
}
@media (max-height: 420px) {
  .notice-history-header {
    padding-block: 12px;
  }
  .notice-history-header p {
    display: none;
  }
  .notice-dnd,
  .notice-filters,
  .notice-history-footer {
    padding-block: 8px;
  }
  .notice-dnd-copy p {
    display: none;
  }
  .notice-empty {
    min-height: 100px;
    padding: 16px;
  }
}
</style>
