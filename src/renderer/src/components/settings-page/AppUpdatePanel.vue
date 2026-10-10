<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useAppUpdateStore } from '../../stores/useAppUpdateStore.ts'
import { RELEASES_URL } from '../../../../shared/projectUrls.ts'
import type { AppUpdateChannel } from '../../../../shared/appUpdate.ts'

const updates = useAppUpdateStore()
const { state, busy, error, connectionError } = updates
let disconnect: (() => void) | null = null
onMounted(() => {
  disconnect = updates.connect()
})
onBeforeUnmount(() => {
  disconnect?.()
})
const progress = computed(() => state.value.progress)
const canCancel = computed(
  () =>
    !!progress.value.taskId &&
    ['resolving', 'downloading', 'retrying', 'verifying'].includes(progress.value.phase)
)
const canDownload = computed(
  () =>
    state.value.check?.hasUpdate &&
    state.value.check.hasChecksum &&
    !state.value.check.error &&
    state.value.check.latestVersion !== state.value.readyVersion
)
const problem = computed(
  () =>
    error.value ||
    progress.value.error ||
    (state.value.check?.error ? state.value.check.message : '')
)
const status = computed(() =>
  problem.value || connectionError.value
    ? 'error'
    : busy.value
      ? 'busy'
      : state.value.check && !state.value.check.hasUpdate
        ? 'current'
        : 'idle'
)
const title = computed(() => {
  if (state.value.checking) return '正在检查更新…'
  if (error.value) return '更新操作未完成'
  if (connectionError.value && !state.value.check) return '更新服务暂不可用'
  const labels: Record<string, string> = {
    resolving: '正在准备下载…',
    downloading: '正在下载更新…',
    retrying: '正在重试下载…',
    cancelling: '正在取消下载…',
    verifying: '正在校验更新包…',
    installing: '正在准备安装…',
    cancelled: '下载已暂停，可继续下载',
    error: '更新未完成'
  }
  if (labels[progress.value.phase]) return labels[progress.value.phase]
  if (state.value.readyVersion) return `v${state.value.readyVersion} 更新包已就绪`
  if (state.value.check?.error) return '检查更新未完成'
  if (state.value.check?.hasUpdate) return `发现新版本 v${state.value.check.latestVersion}`
  if (state.value.check) return '当前已是最新版本'
  return '软件更新'
})
function bytes(value = 0): string {
  return value > 0
    ? value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`
    : '—'
}
function date(value: string | number): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}
function release(): void {
  void window.api.shell.openExternal(state.value.check?.releaseUrl || RELEASES_URL)
}
function showInstaller(): void {
  const path = progress.value.installerPath
  if (path) void window.api.shell.showItemInFolder(path)
}
async function install(): Promise<void> {
  if (busy.value) return
  if (
    !window.confirm(
      `安装 v${state.value.readyVersion} 前会保存播放状态，随后退出应用并打开安装程序。\n\n安装包已通过 SHA-256 完整性校验。当前 Windows 安装包未签名，系统可能显示 SmartScreen 或 UAC 提示。\n\n确定安装并退出吗？`
    )
  )
    return
  await updates.install()
}
function channel(event: Event): void {
  void updates.preferences({
    channel: (event.target as HTMLSelectElement).value as AppUpdateChannel
  })
}
function interval(event: Event): void {
  void updates.preferences({
    checkIntervalHours: Number((event.target as HTMLSelectElement).value) as 6 | 24 | 72
  })
}
</script>

<template>
  <div data-setting-id="app-update" id="setting-app-update" class="app-update-panel">
    <div class="update-card" :data-status="status" :aria-busy="busy">
      <div class="status-icon">
        <i
          :class="
            busy
              ? 'pi pi-spin pi-spinner'
              : status === 'error'
                ? 'pi pi-exclamation-circle'
                : status === 'current'
                  ? 'pi pi-check'
                  : 'pi pi-sync'
          "
          aria-hidden="true"
        ></i>
      </div>
      <div class="update-copy" aria-live="polite">
        <strong>{{ title }}</strong>
        <span v-if="problem" class="update-error" role="alert">{{ problem }}</span>
        <span v-else-if="connectionError" class="update-error" role="alert">{{
          connectionError
        }}</span>
        <span v-else-if="progress.message && progress.phase !== 'idle'">{{
          progress.message
        }}</span>
        <span v-else-if="!state.check">检查新版本，获取最新功能与修复。</span>
        <span v-if="state.checkedAt">上次检查：{{ date(state.checkedAt) }}</span>
      </div>
      <div
        data-setting-id="app-update-install"
        id="setting-app-update-install"
        class="update-actions"
      >
        <button v-if="canCancel" class="soft-button" type="button" @click="updates.cancel()">
          取消下载
        </button>
        <button
          v-if="state.readyVersion"
          class="brand-soft-button"
          type="button"
          :disabled="busy"
          @click="install"
        >
          安装并退出
        </button>
        <button
          v-if="canDownload"
          class="brand-soft-button"
          type="button"
          :disabled="busy"
          @click="updates.download()"
        >
          {{ ['cancelled', 'error'].includes(progress.phase) ? '重试 / 继续下载' : '下载更新' }}
        </button>
        <button class="brand-soft-button" type="button" :disabled="busy" @click="updates.check()">
          检查更新
        </button>
        <button class="soft-button" type="button" @click="release">
          打开发布页 <i class="pi pi-external-link" aria-hidden="true"></i>
        </button>
        <button
          v-if="state.readyVersion && progress.installerPath"
          class="soft-button"
          type="button"
          :disabled="busy"
          @click="showInstaller"
        >
          打开安装包目录
        </button>
      </div>
    </div>
    <div
      v-if="
        ['downloading', 'retrying', 'cancelling', 'cancelled', 'verifying'].includes(progress.phase)
      "
      class="update-transfer"
    >
      <div class="update-transfer-label">
        <span>{{ bytes(progress.receivedBytes) }} / {{ bytes(progress.totalBytes) }}</span>
        <span v-if="progress.phase === 'downloading' && progress.bytesPerSecond"
          >{{ bytes(progress.bytesPerSecond) }}/s<span v-if="progress.remainingSeconds != null">
            · 约
            {{
              progress.remainingSeconds >= 60
                ? Math.ceil(progress.remainingSeconds / 60) + ' 分钟'
                : progress.remainingSeconds + ' 秒'
            }}</span
          ></span
        >
      </div>
      <progress :value="progress.percent" max="100" aria-label="更新下载进度"></progress>
    </div>
    <p v-if="state.pendingInstallVersion" class="update-hint">
      上次已打开 v{{ state.pendingInstallVersion }}
      安装程序。当前版本尚未确认升级，完成安装后重新启动即可确认。
    </p>
    <p v-if="state.completedVersion" class="update-hint">
      已确认更新至 v{{ state.completedVersion }}。
    </p>
    <details v-if="state.check?.releaseNotes" class="update-notes">
      <summary>
        v{{ state.check.latestVersion }} 更新说明
        <span v-if="state.check.assetSize">· {{ bytes(state.check.assetSize) }}</span>
      </summary>
      <p v-if="state.check.publishedAt" class="update-hint">
        发布时间：{{ date(state.check.publishedAt) }}
      </p>
      <pre>{{ state.check.releaseNotes }}</pre>
    </details>
    <div class="update-preferences setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong id="update-auto-check-label">自动检查更新</strong>
          <span>只提醒新版本，下载和安装由你决定。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          role="switch"
          aria-labelledby="update-auto-check-label"
          :class="{ active: state.preferences.autoCheck, inactive: !state.preferences.autoCheck }"
          :aria-checked="state.preferences.autoCheck"
          :disabled="busy"
          @click="updates.preferences({ autoCheck: !state.preferences.autoCheck })"
        />
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong id="update-interval-label">检查间隔</strong>
          <span id="update-interval-description">{{
            state.preferences.autoCheck
              ? '选择自动检查的频率。'
              : '开启自动检查后可调整；仍可手动检查更新。'
          }}</span>
        </div>
        <select
          class="preview-select"
          aria-labelledby="update-interval-label"
          aria-describedby="update-interval-description"
          :value="state.preferences.checkIntervalHours"
          :disabled="busy || !state.preferences.autoCheck"
          @change="interval"
        >
          <option :value="6">每 6 小时</option>
          <option :value="24">每天</option>
          <option :value="72">每 3 天</option>
        </select>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong id="update-channel-label">更新频道</strong>
          <span id="update-channel-description"
            >稳定版适合日常使用；测试版可能包含尚未稳定的功能。</span
          >
        </div>
        <select
          class="preview-select"
          aria-labelledby="update-channel-label"
          aria-describedby="update-channel-description"
          :value="state.preferences.channel"
          :disabled="busy"
          @change="channel"
        >
          <option value="stable">稳定版</option>
          <option value="preview">测试版（含预发布）</option>
        </select>
      </div>
    </div>
    <div v-if="state.check?.hasUpdate || state.readyVersion" class="update-reminders">
      <button class="soft-button" type="button" :disabled="busy" @click="updates.dismiss('later')">
        明天提醒
      </button>
      <button class="soft-button" type="button" :disabled="busy" @click="updates.dismiss('skip')">
        跳过此版本
      </button>
      <span v-if="state.preferences.skippedVersion"
        >已跳过 v{{ state.preferences.skippedVersion }}；手动检查可恢复提醒。</span
      >
      <span v-else-if="state.preferences.remindAfter > Date.now()"
        >下次提醒不早于 {{ date(state.preferences.remindAfter) }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.app-update-panel {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--te-card-border);
  border-radius: 16px;
  background: var(--te-card-bg);
}
.app-update-panel .update-card {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  padding: 0 0 18px;
  border-bottom: 1px solid var(--te-card-border);
  border-radius: 0;
  background: transparent;
}
.app-update-panel .status-icon {
  color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
.app-update-panel [data-status='error'] .status-icon {
  color: var(--te-settings-text-muted);
  background: var(--te-settings-search-bg);
  border-color: var(--te-card-border);
}
.app-update-panel .update-error {
  color: var(--te-settings-text-muted);
  line-height: 1.65;
}
.app-update-panel .update-copy {
  min-width: 150px;
  flex: 1;
  overflow-wrap: anywhere;
  gap: 5px;
  flex-basis: 240px;
}
.app-update-panel .update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.app-update-panel .update-actions button {
  width: auto;
}
.app-update-panel .brand-soft-button {
  color: var(--te-settings-text);
  background: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
}
.app-update-panel .brand-soft-button:hover {
  background: color-mix(in srgb, var(--te-primary-500) 26%, transparent);
}
.update-transfer-label,
.update-reminders {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  align-items: center;
}
.update-transfer-label {
  justify-content: space-between;
  color: var(--te-settings-text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.update-transfer progress {
  width: 100%;
  height: 8px;
  accent-color: var(--te-primary-500);
}
.update-preferences {
  display: grid;
  gap: 0;
}
.update-preferences .setting-item + .setting-item {
  border-top: 1px solid var(--te-card-border);
}
.update-preferences select:disabled {
  opacity: 0.5;
}
.update-preferences input {
  accent-color: var(--te-primary-500);
}
.update-hint,
.update-reminders span {
  color: var(--te-settings-text-muted);
  font-size: 12px;
  line-height: 1.6;
  margin: 0;
}
.update-notes summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--te-settings-text);
  padding: 10px 0;
}
.update-notes pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow: auto;
  font: inherit;
  font-size: 13px;
  line-height: 1.7;
}
.app-update-panel button:disabled {
  opacity: 0.5;
  cursor: default;
}
.app-update-panel :is(button, select, input, summary):focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
@media (max-width: 640px) {
  .app-update-panel {
    padding: 16px;
  }
  .app-update-panel .update-actions {
    flex-basis: 100%;
    justify-content: flex-start;
  }
}
</style>
