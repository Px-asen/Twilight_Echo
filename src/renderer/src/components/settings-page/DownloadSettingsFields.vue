<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { downloadTrackName, type DownloadNaming } from '../../../../shared/downloadPreferences.ts'

const { settings, updateSettings } = useSettingsStore()
const preferences = computed(() => settings.value.downloadPreferences)
const preview = computed(
  () =>
    downloadTrackName({ artist: '歌手', title: '歌曲名' }, preferences.value.naming) ??
    '音源提供的文件名'
)
</script>

<template>
  <div class="download-options">
    <div data-setting-id="download-naming" id="setting-download-naming" class="setting-item">
      <div class="setting-copy">
        <strong>下载文件命名</strong><span>名称示例：{{ preview }}（文件后缀由音源决定）</span>
      </div>
      <select
        class="preview-select"
        :value="preferences.naming"
        aria-label="下载文件命名格式"
        @change="
          updateSettings({
            downloadPreferences: {
              ...preferences,
              naming: ($event.target as HTMLSelectElement).value as DownloadNaming
            }
          })
        "
      >
        <option value="provider">跟随音源</option>
        <option value="artist-title">歌手 - 歌曲名</option>
        <option value="title-artist">歌曲名 - 歌手</option>
        <option value="title">歌曲名</option>
      </select>
    </div>
    <div data-setting-id="download-metadata" id="setting-download-metadata" class="setting-item">
      <div class="setting-copy">
        <strong>内嵌歌曲信息与封面</strong><span>保留已有封面，补充标题、歌手、专辑和可用歌词</span>
      </div>
      <button
        type="button"
        class="toggle-switch"
        role="switch"
        aria-label="内嵌歌曲信息与封面"
        :class="{ active: preferences.embedMetadata, inactive: !preferences.embedMetadata }"
        :aria-checked="preferences.embedMetadata"
        @click="
          updateSettings({
            downloadPreferences: {
              ...preferences,
              embedMetadata: !preferences.embedMetadata
            }
          })
        "
      />
    </div>
    <div data-setting-id="download-lyrics" id="setting-download-lyrics" class="setting-item">
      <div class="setting-copy">
        <strong>同时保存歌词文件</strong><span>与歌曲同名；音源有逐字歌词时一并保留</span>
      </div>
      <button
        type="button"
        class="toggle-switch"
        role="switch"
        aria-label="同时保存歌词文件"
        :class="{ active: preferences.saveLyrics, inactive: !preferences.saveLyrics }"
        :aria-checked="preferences.saveLyrics"
        @click="
          updateSettings({
            downloadPreferences: {
              ...preferences,
              saveLyrics: !preferences.saveLyrics
            }
          })
        "
      />
    </div>
  </div>
</template>

<style scoped>
.download-options {
  display: grid;
  padding-top: 12px;
  border-top: 1px solid var(--te-card-border);
  margin-top: 12px;
}
</style>
