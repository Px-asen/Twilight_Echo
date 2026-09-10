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
    <label class="download-option">
      <span
        ><strong>下载文件命名</strong><small>{{ preview }}.m4a</small></span
      >
      <select
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
    </label>
    <label class="download-option">
      <span
        ><strong>内嵌歌曲信息与封面</strong
        ><small>保留已有封面，补充标题、歌手、专辑和可用歌词</small></span
      >
      <input
        type="checkbox"
        :checked="preferences.embedMetadata"
        @change="
          updateSettings({
            downloadPreferences: {
              ...preferences,
              embedMetadata: ($event.target as HTMLInputElement).checked
            }
          })
        "
      />
    </label>
    <label class="download-option">
      <span
        ><strong>同时保存歌词文件</strong><small>与歌曲同名；音源有逐字歌词时一并保留</small></span
      >
      <input
        type="checkbox"
        :checked="preferences.saveLyrics"
        @change="
          updateSettings({
            downloadPreferences: {
              ...preferences,
              saveLyrics: ($event.target as HTMLInputElement).checked
            }
          })
        "
      />
    </label>
  </div>
</template>

<style scoped>
.download-options {
  display: grid;
  gap: 20px;
  padding: 20px 0 4px;
  border-top: 1px solid var(--te-settings-control-border, var(--te-card-border));
  margin-top: 20px;
}
.download-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  color: var(--te-settings-text);
}
.download-option span {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.download-option strong {
  font-weight: 600;
}
.download-option small {
  opacity: 0.65;
  line-height: 1.5;
}
select {
  padding: 9px 12px;
  border: 1px solid var(--te-settings-control-border, var(--te-card-border));
  border-radius: 10px;
  background: var(--te-card-bg);
  color: inherit;
  max-width: 45%;
}
input {
  accent-color: var(--te-primary-500);
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  cursor: pointer;
}
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 4px;
}
</style>
