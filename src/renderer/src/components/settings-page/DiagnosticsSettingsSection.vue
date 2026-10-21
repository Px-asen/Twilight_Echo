<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { DiagnosticStatus } from '../../../../shared/diagnostics.ts'

const status = ref<DiagnosticStatus | null>(null)
const busy = ref('')
const note = ref('')
const message = ref('')
const failed = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  try {
    status.value = await window.api.diagnostics.getStatus()
  } catch (error) {
    failed.value = true
    message.value = error instanceof Error ? error.message : String(error)
  }
}
async function run(action: string, fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = action
  failed.value = false
  message.value = ''
  try {
    await fn()
    await refresh()
  } catch (error) {
    failed.value = true
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = ''
  }
}
function mark() {
  void run('mark', async () => {
    await window.api.diagnostics.markProblem(note.value)
    message.value = '已记下问题时间，相关运行记录会保留在诊断包中。'
    note.value = ''
  })
}
function exportBundle() {
  void run('export', async () => {
    const result = await window.api.diagnostics.exportBundle()
    if (result.filePath) message.value = `诊断包已导出：${result.filePath}`
  })
}
function clear() {
  void run('clear', async () => {
    await window.api.diagnostics.clearHistory()
    message.value = '历史日志已清理，当前运行记录会继续保存。'
  })
}
function openDirectory() {
  void run('directory', () => window.api.diagnostics.openDirectory())
}
onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 10000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div id="application-diagnostics" class="section-block">
    <h3>上报问题</h3>
    <p class="diagnostic-description">
      运行日志会自动保存在本机。遇到问题后可以记下时间，并导出诊断包用于排查。
    </p>
    <div class="setting-list">
      <div class="setting-item">
        <div class="setting-copy">
          <strong>{{ status?.error ? '日志保存遇到问题' : '详细日志已开启' }}</strong>
          <span v-if="status"
            >已使用 {{ (status.bytes / 1048576).toFixed(1) }} MiB · 最多 256 MiB · 保留最近 7
            天</span
          >
          <span v-else>正在读取日志状态…</span>
          <small v-if="status?.error" class="diagnostic-error" role="alert">{{
            status.error
          }}</small>
          <small
            v-for="warning in status?.warnings ?? []"
            :key="warning"
            class="diagnostic-warning"
            role="alert"
            >{{ warning }}</small
          >
          <small v-if="status?.droppedEvents" class="diagnostic-warning"
            >有 {{ status.droppedEvents }} 条记录因容量或写入限制未保存，诊断包中会注明。</small
          >
        </div>
        <button type="button" class="soft-button" :disabled="Boolean(busy)" @click="openDirectory">
          <i class="pi pi-folder-open" aria-hidden="true"></i>
          打开日志目录
        </button>
      </div>
      <hr />
      <div class="setting-item top-align">
        <div class="diagnostic-form" :aria-busy="Boolean(busy)">
          <label class="setting-copy" for="diagnostic-problem-note">
            <strong>问题说明（可选）</strong>
            <span id="diagnostic-problem-help"
              >例如“切到下一首后没有声音”，无需填写歌曲地址或账号信息。</span
            >
          </label>
          <textarea
            id="diagnostic-problem-note"
            v-model="note"
            class="diagnostic-note"
            rows="3"
            maxlength="1024"
            placeholder="描述刚刚发生的问题"
            aria-describedby="diagnostic-problem-help"
            :disabled="Boolean(busy)"
          />
          <div class="diagnostic-actions">
            <div class="inline-controls">
              <button type="button" class="soft-button" :disabled="Boolean(busy)" @click="mark">
                <i class="pi pi-flag" aria-hidden="true"></i>
                标记刚刚发生的问题
              </button>
              <button
                type="button"
                class="brand-soft-button"
                :disabled="Boolean(busy)"
                @click="exportBundle"
              >
                <i
                  class="pi"
                  :class="busy === 'export' ? 'pi-spinner pi-spin' : 'pi-download'"
                  aria-hidden="true"
                ></i>
                {{ busy === 'export' ? '正在导出诊断包…' : '导出完整诊断包' }}
              </button>
            </div>
            <button
              type="button"
              class="soft-button diagnostic-clear"
              :disabled="Boolean(busy)"
              @click="clear"
            >
              <i class="pi pi-trash" aria-hidden="true"></i>
              清理历史日志
            </button>
          </div>
          <p
            v-if="message"
            class="diagnostic-feedback"
            :class="{ 'diagnostic-error': failed }"
            role="status"
            aria-live="polite"
          >
            <i
              class="pi"
              :class="failed ? 'pi-exclamation-circle' : 'pi-check-circle'"
              aria-hidden="true"
            ></i>
            <span>{{ message }}</span>
          </p>
          <p class="diagnostic-privacy">
            <i class="pi pi-shield" aria-hidden="true"></i>
            <span>诊断包不包含音频内容、密码或完整歌曲地址。日志不会自动上传。</span>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagnostic-description,
.diagnostic-feedback,
.diagnostic-privacy {
  color: var(--te-settings-text-muted);
  font-size: var(--te-setting-description-size, calc(var(--te-font-size-body, 14px) * 13 / 14));
  font-weight: 400;
  line-height: 1.65;
}

.diagnostic-description {
  margin: 0 0 8px;
}

.diagnostic-form {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 12px;
}

.diagnostic-note {
  box-sizing: border-box;
  width: 100%;
  min-height: 88px;
  padding: 12px 14px;
  resize: vertical;
  border: 1px solid var(--te-settings-control-border);
  border-radius: var(--te-control-radius-md, 10px);
  background: var(--te-settings-control-bg);
  color: var(--te-settings-text);
  font: inherit;
  font-size: var(--te-setting-description-size, calc(var(--te-font-size-body, 14px) * 13 / 14));
  line-height: 1.65;
}

.diagnostic-note::placeholder {
  color: var(--te-settings-text-muted);
  opacity: 1;
}

.diagnostic-note:focus-visible {
  border-color: var(--te-control-focus-color);
  outline: var(--te-control-focus-width, 2px) solid var(--te-control-focus-color);
  outline-offset: var(--te-control-focus-offset, 2px);
}

.diagnostic-note:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.diagnostic-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.diagnostic-actions .inline-controls {
  justify-content: flex-start;
  gap: 8px;
}

.diagnostic-clear {
  margin-inline-start: auto;
}

.diagnostic-feedback,
.diagnostic-privacy {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  overflow-wrap: anywhere;
}

.diagnostic-feedback {
  color: var(--te-success-soft-fg);
}

.diagnostic-feedback i,
.diagnostic-privacy i {
  flex: 0 0 auto;
  line-height: inherit;
}

.diagnostic-warning {
  color: var(--te-warning-soft-fg);
}

.diagnostic-error {
  color: var(--te-danger-soft-fg);
}

@media (max-width: 600px) {
  .diagnostic-actions,
  .diagnostic-actions .inline-controls {
    align-items: stretch;
    flex-direction: column;
    width: 100%;
  }

  .diagnostic-clear {
    margin-inline-start: 0;
  }
}
</style>
