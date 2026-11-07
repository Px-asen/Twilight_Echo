<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useSettingsStore } from '../../stores/useSettingsStore.ts'
import type { ListeningSyncStatus } from '../../../../shared/listeningSync.ts'

const core = useCoreConnection()
const { settings, updateSettings } = useSettingsStore()
const status = ref<ListeningSyncStatus | null>(null)
const busy = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let mounted = true

const statusText = computed(() => {
  if (error.value) return error.value
  if (!status.value) return '正在读取同步状态…'
  if (!status.value.available) return '网易云音源未启用，或此设备暂不支持听歌同步。'
  if (!settings.value.ncmListeningSyncEnabled) return '已关闭'
  if (status.value.error) return status.value.error
  if (status.value.pending) return `正在提交 ${status.value.pending} 条听歌记录…`
  const last = status.value.lastSubmitted
  return last
    ? `最近已提交：${last.title} · ${last.seconds} 秒`
    : '已开启，登录后播放的歌曲会在切歌或结束时提交。'
})

async function refresh(): Promise<void> {
  try {
    const next = await core.query('listeningSync.status', {})
    if (mounted) {
      status.value = next
      error.value = ''
    }
  } catch (reason) {
    if (mounted) error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function toggle(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await updateSettings({ ncmListeningSyncEnabled: !settings.value.ncmListeningSyncEnabled })
    await refresh()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => {
    if (!busy.value) void refresh()
  }, 5000)
})
onBeforeUnmount(() => {
  mounted = false
  clearInterval(timer)
})
</script>

<template>
  <div id="setting-ncm-listening-sync" data-setting-id="ncm-listening-sync" class="setting-item">
    <div class="setting-copy">
      <strong>同步听歌记录到网易云</strong>
      <span>将开启后实际收听的歌曲和时长同步至当前网易云账号。本地歌曲需已关联网易云歌曲。</span>
      <span class="setting-substatus" role="status" aria-live="polite">{{ statusText }}</span>
    </div>
    <button
      type="button"
      class="toggle-switch"
      :class="{
        active: settings.ncmListeningSyncEnabled,
        inactive: !settings.ncmListeningSyncEnabled
      }"
      role="switch"
      aria-label="同步听歌记录到网易云"
      :aria-checked="settings.ncmListeningSyncEnabled"
      :disabled="busy || (!status?.available && !settings.ncmListeningSyncEnabled)"
      @click="toggle"
    ></button>
  </div>
</template>
