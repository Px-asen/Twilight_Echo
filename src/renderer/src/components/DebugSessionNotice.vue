<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { DebugSessionStatus } from '../../../shared/diagnostics.ts'
const session = ref<DebugSessionStatus | null>(null)
const busy = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
async function refresh() {
  try {
    session.value = (await window.api.diagnostics.getStatus()).debug ?? null
  } catch {
    /* Settings owns detailed status errors. */
  }
}
async function finish() {
  if (!session.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await window.api.diagnostics.exportBundle({
      debugSessionId: session.value.id,
      includeCrashes: session.value.captureCrashes,
      stopDebug: true
    })
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 3000)
})
onUnmounted(() => clearInterval(timer))
</script>
<template>
  <aside
    v-if="session && session.state !== 'ended'"
    class="debug-session-notice"
    aria-label="调试会话"
  >
    <span role="status"
      >● {{ session.state === 'active' ? '调试记录中' : '等待重启' }} ·
      {{ Math.max(0, Math.floor((Date.now() - Date.parse(session.startedAt)) / 60000)) }} 分钟 ·
      {{ (session.bytes / 1048576).toFixed(1) }} MiB</span
    >
    <button type="button" :disabled="busy" @click="finish">
      {{ busy ? '正在导出…' : '结束并导出' }}
    </button>
    <small v-if="error" role="alert">{{ error }}</small>
    <small v-else-if="session.warnings.length" role="alert">{{ session.warnings.at(-1) }}</small>
  </aside>
</template>
<style scoped>
.debug-session-notice {
  position: fixed;
  bottom: 108px;
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  max-width: min(440px, calc(100vw - 40px));
  padding: 12px 16px;
  border: 1px solid var(--te-control-focus-color);
  border-radius: 12px;
  background: var(--te-settings-control-bg);
  color: var(--te-settings-text);
  box-shadow: var(--te-settings-shadow);
  font-size: 13px;
}
button {
  color: inherit;
  border: 0;
  background: transparent;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
small {
  flex-basis: 100%;
  overflow-wrap: anywhere;
}
</style>
