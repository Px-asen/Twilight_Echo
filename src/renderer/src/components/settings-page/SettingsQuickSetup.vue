<script setup lang="ts">
import { ref, watch } from 'vue'
import SettingsDisclosure from './SettingsDisclosure.vue'

defineProps<{ folderCount: number; deviceName: string; themeName: string }>()
const emit = defineEmits<{ navigate: [id: string] }>()
const storageKey = 'twilight-echo:settings-quick-setup:collapsed'
function initiallyOpen(): boolean {
  try {
    return localStorage.getItem(storageKey) !== 'true'
  } catch {
    return true
  }
}
const open = ref(initiallyOpen())
watch(open, (value) => {
  try {
    localStorage.setItem(storageKey, String(!value))
  } catch {
    // This optional view preference must never prevent configuring the player.
  }
})
</script>

<template>
  <aside class="settings-quick-setup settings-section" aria-label="快速配置">
    <button
      type="button"
      class="settings-group-trigger"
      :aria-expanded="open"
      aria-controls="settings-quick-setup-content"
      @click="open = !open"
    >
      <span class="settings-group-copy">
        <span class="settings-group-title">快速配置</span>
        <span class="settings-group-summary">按需要调整，默认配置即可开始听歌。</span>
      </span>
      <span class="settings-quick-setup-toggle">{{ open ? '收起' : '展开' }}</span>
      <i class="pi pi-chevron-down" :class="{ rotated: open }" aria-hidden="true" />
    </button>
    <SettingsDisclosure id="settings-quick-setup-content" :open="open" keep-mounted>
      <p class="settings-group-description">各项均可按需配置；只在线听歌时，可以跳过本地文件夹。</p>
      <div class="settings-quick-setup-actions">
        <button
          type="button"
          class="settings-quick-setup-action"
          @click="emit('navigate', 'library-folders')"
        >
          <i class="pi pi-folder-open" aria-hidden="true" />
          <span
            ><strong>添加本地音乐</strong><small>已添加 {{ folderCount }} 个文件夹</small></span
          >
          <i class="pi pi-arrow-right" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="settings-quick-setup-action"
          @click="emit('navigate', 'audio-device')"
        >
          <i class="pi pi-volume-up" aria-hidden="true" />
          <span
            ><strong>选择声音输出</strong><small>{{ deviceName }}</small></span
          >
          <i class="pi pi-arrow-right" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="settings-quick-setup-action"
          @click="emit('navigate', 'color-mode')"
        >
          <i class="pi pi-palette" aria-hidden="true" />
          <span
            ><strong>调整主题</strong><small>{{ themeName }}</small></span
          >
          <i class="pi pi-arrow-right" aria-hidden="true" />
        </button>
      </div>
    </SettingsDisclosure>
  </aside>
</template>
