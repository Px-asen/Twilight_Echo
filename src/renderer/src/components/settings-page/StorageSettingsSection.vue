<script setup lang="ts">
import { useSettingsStore } from '../../stores/useSettingsStore'
import DownloadSettingsFields from './DownloadSettingsFields.vue'

const { settings } = useSettingsStore()

defineProps<{
  storageAttention?: string
  chooseDownloadFolder: () => void
  resetDownloadFolder: () => void
}>()
</script>

<template>
  <section id="storage" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-download" aria-hidden="true" />
      <h2>下载与缓存</h2>
    </div>
    <p class="settings-section-description">
      下载位置与文件命名，缓存目录、缓存类型与空间清理。
    </p>
    <p v-if="storageAttention" class="storage-attention-banner" role="status">
      {{ storageAttention }}
    </p>
    <div class="section-block">
      <h3>下载到本地</h3>
      <div class="setting-list">
        <div
          data-setting-id="download-directory"
          id="setting-download-directory"
          class="setting-item top-align"
        >
          <div class="setting-copy">
            <strong>下载目录</strong>
            <span>
              流媒体「下载到本地」的保存位置；留空时沿用第一个扫描文件夹。选在扫描文件夹之外时，下载完成的文件不会自动进入媒体库。
            </span>
          </div>
          <div class="path-control">
            <input
              readonly
              aria-label="下载目录"
              :value="settings.downloadFolder || '跟随扫描文件夹'"
            />
            <button type="button" class="soft-button" @click="chooseDownloadFolder">
              选择文件夹
            </button>
            <button
              v-if="settings.downloadFolder"
              type="button"
              class="muted-button"
              @click="resetDownloadFolder"
            >
              清除
            </button>
          </div>
        </div>
        <DownloadSettingsFields />
      </div>
    </div>
    <slot />
  </section>
</template>
