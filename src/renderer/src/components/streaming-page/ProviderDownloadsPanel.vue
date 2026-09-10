<script setup lang="ts">
import { computed } from 'vue'
import type { ProviderDownloadTaskSnapshot } from '../../../../shared/providerDownloads.ts'
import { downloadStatusLabel, filterActiveDownloadTasks } from './streamingDownloads.ts'

const props = defineProps<{
  show: boolean
  tasks: ProviderDownloadTaskSnapshot[]
}>()

const emit = defineEmits<{
  close: []
  open: []
  retry: [taskId: string]
  cancel: [taskId: string]
}>()

const activeDownloadTasks = computed(() => filterActiveDownloadTasks(props.tasks))

function isRunning(task: ProviderDownloadTaskSnapshot): boolean {
  return task.status === 'queued' || task.status === 'preparing' || task.status === 'downloading'
}

function formatFileSize(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="show" class="provider-download-panel-overlay" @click.self="emit('close')">
        <div class="provider-download-panel" role="dialog" aria-modal="true" aria-label="下载管理">
          <div class="provider-download-panel-header">
            <h3>下载管理</h3>
            <button
              type="button"
              class="provider-download-icon-button"
              aria-label="关闭下载管理"
              @click="emit('close')"
            >
              <i class="pi pi-times"></i>
            </button>
          </div>
          <div v-if="tasks.length === 0" class="provider-download-empty">
            暂无下载任务。在流媒体曲目上右键选择「下载到本地」即可开始。
          </div>
          <div v-else class="provider-download-list">
            <div
              v-for="task in tasks"
              :key="task.id"
              class="provider-download-item"
              :data-status="task.status"
            >
              <div class="provider-download-item-info">
                <strong class="provider-download-title" :title="task.track.title">
                  {{ task.track.title }}
                </strong>
                <span class="provider-download-artist">{{ task.track.artist }}</span>
                <div class="provider-download-meta">
                  <span class="provider-download-badge" :data-status="task.status">
                    {{ downloadStatusLabel(task) }}
                  </span>
                  <small v-if="task.actualQuality" class="provider-download-tag">
                    {{ task.actualQuality }}{{ task.qualityVerified ? ' · 已核验' : ' · 音源报告' }}
                  </small>
                  <small v-if="task.fileSize" class="provider-download-tag">
                    {{ formatFileSize(task.fileSize) }}
                  </small>
                </div>
                <div
                  v-if="isRunning(task)"
                  class="provider-download-progress"
                  role="progressbar"
                  :aria-valuenow="Math.round(task.progress * 100)"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div
                    class="provider-download-progress-fill"
                    :style="{ transform: `scaleX(${Math.max(0, Math.min(1, task.progress))})` }"
                  ></div>
                </div>
                <small
                  v-if="task.actualQuality && task.actualQuality !== task.requestedQuality"
                  class="provider-download-error"
                >
                  请求 {{ task.requestedQuality }}，实际下载为 {{ task.actualQuality }}
                </small>
                <small v-if="task.warning" class="provider-download-warning">{{
                  task.warning
                }}</small>
                <small v-if="task.error" class="provider-download-error">{{ task.error }}</small>
                <small
                  v-if="task.targetPath && task.status === 'completed'"
                  class="provider-download-path"
                  :title="task.targetPath"
                >
                  {{ task.targetPath }}
                </small>
              </div>
              <div class="provider-download-item-actions">
                <button
                  v-if="task.status === 'failed' || task.status === 'cancelled'"
                  type="button"
                  class="provider-download-button"
                  @click="emit('retry', task.id)"
                >
                  重试
                </button>
                <button
                  v-if="task.status !== 'completed' && task.status !== 'cancelled'"
                  type="button"
                  class="provider-download-button subtle"
                  @click="emit('cancel', task.id)"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <button
    v-if="activeDownloadTasks.length > 0 && !show"
    type="button"
    class="provider-download-fab"
    aria-label="打开下载管理"
    @click="emit('open')"
  >
    <i class="pi pi-download"></i>
    <span class="fab-badge">{{ activeDownloadTasks.length }}</span>
  </button>
</template>

<style scoped>
/* Every surface colour resolves from the shared theme tokens, so the panel
   follows the active light or dark palette instead of pinning a dark card that
   inherits the page text colour. The scrim is the one intentional literal:
   modal dimming stays dark in both palettes. */
.provider-download-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
}

.provider-download-panel {
  width: min(560px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-dialog-radius);
  box-shadow: var(--te-glass-shadow);
  overflow: hidden;
}
.provider-download-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--te-card-border);
}

.provider-download-panel-header h3 {
  margin: 0;
  font-size: calc(var(--te-font-size-body) * 15 / 14);
  font-weight: var(--te-text-title);
  color: var(--te-settings-text);
}

.provider-download-icon-button {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--te-card-border);
  border-radius: 50%;
  background: transparent;
  color: var(--te-settings-text-muted);
  cursor: pointer;
  transition:
    background var(--te-motion-hover) ease,
    color var(--te-motion-hover) ease;
}

.provider-download-icon-button:hover {
  background: var(--te-hover-bg);
  color: var(--te-settings-text);
}

.provider-download-empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body) * 13 / 14);
}

.provider-download-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.provider-download-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
}

.provider-download-item + .provider-download-item {
  border-top: 1px solid var(--te-card-border);
}

.provider-download-item-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.provider-download-title {
  font-size: calc(var(--te-font-size-body) * 13 / 14);
  font-weight: var(--te-text-strong);
  color: var(--te-settings-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-download-artist {
  font-size: calc(var(--te-font-size-body) * 12 / 14);
  color: var(--te-settings-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-download-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 1px;
}
.provider-download-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: calc(var(--te-font-size-body) * 11 / 14);
  font-weight: var(--te-text-strong);
  background: var(--te-hover-bg);
  color: var(--te-settings-text-muted);
}

.provider-download-badge[data-status='queued'],
.provider-download-badge[data-status='preparing'] {
  background: var(--te-info-soft-bg);
  color: var(--te-info-soft-fg);
}

.provider-download-badge[data-status='downloading'] {
  background: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
  color: var(--te-primary-500);
}

.provider-download-badge[data-status='completed'] {
  background: var(--te-success-soft-bg);
  color: var(--te-success-soft-fg);
}

.provider-download-badge[data-status='failed'] {
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}

.provider-download-tag {
  font-size: calc(var(--te-font-size-body) * 11 / 14);
  color: var(--te-settings-text-muted);
}
.provider-download-progress {
  margin-top: 3px;
  width: min(320px, 60vw);
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--te-settings-text-muted) 28%, transparent);
  overflow: hidden;
}

.provider-download-progress-fill {
  width: 100%;
  height: 100%;
  background: var(--te-primary-500);
  transform: scaleX(0);
  transform-origin: 0 50%;
  transition: transform var(--te-motion-panel) var(--te-ease-soft);
}

.provider-download-warning {
  font-size: calc(var(--te-font-size-body) * 11 / 14);
  color: var(--te-settings-text-muted);
  word-break: break-word;
}

.provider-download-error {
  font-size: calc(var(--te-font-size-body) * 11 / 14);
  color: var(--te-danger-soft-fg);
  word-break: break-word;
}

.provider-download-path {
  font-size: calc(var(--te-font-size-body) * 11 / 14);
  color: var(--te-settings-text-muted);
  word-break: break-all;
  font-family: monospace;
}

.provider-download-item-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.provider-download-button {
  min-height: 30px;
  padding: 6px 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--te-card-border);
  border-radius: 999px;
  background: var(--te-subtle-bg);
  color: var(--te-settings-text);
  font-size: calc(var(--te-font-size-body) * 12 / 14);
  font-weight: var(--te-text-strong);
  cursor: pointer;
  transition:
    background var(--te-motion-hover) ease,
    color var(--te-motion-hover) ease;
}

.provider-download-button:hover {
  background: var(--te-hover-bg);
}

.provider-download-button.subtle {
  background: transparent;
  color: var(--te-settings-text-muted);
}

.provider-download-button.subtle:hover {
  background: var(--te-hover-bg);
  color: var(--te-settings-text);
}
.provider-download-fab {
  position: fixed;
  bottom: 80px;
  right: 24px;
  z-index: 900;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: var(--te-primary-500);
  color: var(--te-neutral-50);
  box-shadow: var(--te-glass-shadow);
  transition: transform var(--te-motion-hover) var(--te-ease-soft);
}

.provider-download-fab:hover {
  transform: scale(1.05);
}

.fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--te-danger-soft-fg);
  color: var(--te-card-bg);
  font-size: calc(var(--te-font-size-body) * 10 / 14);
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity var(--te-motion-hover) ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}
</style>
