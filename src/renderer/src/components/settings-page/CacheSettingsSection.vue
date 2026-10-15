<script setup lang="ts">
import SettingsGroup from './SettingsGroup.vue'
import type { MusicCachePolicySettings, StreamingAudioCachePolicy } from '../../types/settings'

defineProps<{
  activeCachePath: string
  cachePolicy: MusicCachePolicySettings
  streamingAudioCachePolicyOptions: readonly {
    value: StreamingAudioCachePolicy
    label: string
  }[]
  formattedBpmAnalysisCacheSize: string
  clearingBpmAnalysisCache: boolean
  formattedLoudnessAnalysisCacheSize: string
  clearingLoudnessAnalysisCache: boolean
  formattedCacheSize: string
  clearingCache: boolean
}>()

const emit = defineEmits<{
  chooseCacheFolder: []
  resetCacheFolder: []
  toggleCacheArtifact: [key: keyof MusicCachePolicySettings]
  setStreamingAudioCachePolicy: [event: Event]
  confirmClearBpmAnalysisCache: []
  confirmClearLoudnessAnalysisCache: []
  confirmClearCache: []
}>()
</script>

<template>
  <div id="cache" class="section-block">
    <h3>缓存与空间</h3>
    <div class="setting-list">
      <div
        data-setting-id="cache-directory"
        id="setting-cache-directory"
        class="setting-item top-align"
      >
        <div class="setting-copy">
          <strong>缓存目录</strong>
          <span>保存图片、歌词、在线资源和可复用的流媒体缓存；用户固定的离线下载独立保留。</span>
        </div>
        <div class="path-control">
          <input readonly aria-label="缓存目录" :value="activeCachePath || '未设置'" />
          <button type="button" class="soft-button" @click="emit('chooseCacheFolder')">
            选择文件夹
          </button>
          <button type="button" class="muted-button" @click="emit('resetCacheFolder')">
            恢复默认
          </button>
        </div>
      </div>
      <div data-setting-id="cache-usage" id="setting-cache-usage" class="setting-item">
        <div class="setting-copy">
          <strong>缓存占用</strong>
          <span
            >当前估算：<b>{{ formattedCacheSize }}</b></span
          >
        </div>
        <button
          class="danger-soft-button solid-hover"
          type="button"
          :disabled="clearingCache"
          @click="emit('confirmClearCache')"
        >
          <i class="pi pi-trash"></i>
          {{ clearingCache ? '清理中…' : '清理缓存' }}
        </button>
      </div>
    </div>
    <SettingsGroup
      id="cache-details"
      title="缓存策略与分析数据"
      description="需要节省空间或重新分析歌曲时展开；关闭缓存不会删除已下载的音乐文件。"
      :attention="
        clearingBpmAnalysisCache || clearingLoudnessAnalysisCache ? '正在清理分析缓存…' : ''
      "
      :summary="
        'BPM ' + formattedBpmAnalysisCacheSize + ' · 响度 ' + formattedLoudnessAnalysisCacheSize
      "
      ><div class="setting-list">
        <div data-setting-id="cache-cover" id="setting-cache-cover" class="setting-item">
          <div class="setting-copy">
            <strong>封面缓存</strong>
            <span>允许本地库和 Provider 复用已获取的专辑封面。</span>
          </div>
          <button
            type="button"
            aria-label="封面缓存"
            class="toggle-switch"
            :class="{ active: cachePolicy.cover, inactive: !cachePolicy.cover }"
            role="switch"
            :aria-checked="cachePolicy.cover"
            @click="emit('toggleCacheArtifact', 'cover')"
          ></button>
        </div>
        <hr />
        <div data-setting-id="cache-lyrics" id="setting-cache-lyrics" class="setting-item">
          <div class="setting-copy">
            <strong>歌词缓存</strong>
            <span>缓存 LRC、翻译歌词和 Provider 返回的歌词增强结果。</span>
          </div>
          <button
            type="button"
            aria-label="歌词缓存"
            class="toggle-switch"
            :class="{ active: cachePolicy.lyrics, inactive: !cachePolicy.lyrics }"
            role="switch"
            :aria-checked="cachePolicy.lyrics"
            @click="emit('toggleCacheArtifact', 'lyrics')"
          ></button>
        </div>
        <hr />
        <div data-setting-id="cache-metadata" id="setting-cache-metadata" class="setting-item">
          <div class="setting-copy">
            <strong>歌曲信息缓存</strong>
            <span>缓存在线匹配得到的艺人、专辑和曲目信息，不覆盖本地文件身份。</span>
          </div>
          <button
            type="button"
            aria-label="歌曲信息缓存"
            class="toggle-switch"
            :class="{ active: cachePolicy.metadata, inactive: !cachePolicy.metadata }"
            role="switch"
            :aria-checked="cachePolicy.metadata"
            @click="emit('toggleCacheArtifact', 'metadata')"
          ></button>
        </div>
        <hr />
        <div data-setting-id="cache-audio" id="setting-cache-audio" class="setting-item">
          <div class="setting-copy">
            <strong>流媒体音频缓存</strong>
            <span>仅在插件和平台规则允许时缓存音频；关闭后 Provider 请求不会落盘音频。</span>
          </div>
          <select
            class="preview-select compact-select"
            aria-label="流媒体音频缓存"
            :value="cachePolicy.streamingAudio"
            @change="emit('setStreamingAudioCachePolicy', $event)"
          >
            <option
              v-for="option in streamingAudioCachePolicyOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
        <hr />
        <div data-setting-id="cache-bpm" id="setting-cache-bpm" class="setting-item">
          <div class="setting-copy">
            <strong>BPM 分析缓存</strong>
            <span
              >当前估算：<b>{{ formattedBpmAnalysisCacheSize }}</b></span
            >
          </div>
          <button
            class="danger-soft-button solid-hover"
            type="button"
            :disabled="clearingBpmAnalysisCache"
            @click="emit('confirmClearBpmAnalysisCache')"
          >
            <i class="pi pi-trash"></i>
            {{ clearingBpmAnalysisCache ? '清理中…' : '清理 BPM 缓存' }}
          </button>
        </div>
        <hr />
        <div data-setting-id="cache-loudness" id="setting-cache-loudness" class="setting-item">
          <div class="setting-copy">
            <strong>Loudnorm / 响度分析缓存</strong>
            <span
              >当前估算：<b>{{ formattedLoudnessAnalysisCacheSize }}</b> · 上限 512 条，命中
              identity 跳过重测</span
            >
          </div>
          <button
            class="danger-soft-button solid-hover"
            type="button"
            :disabled="clearingLoudnessAnalysisCache"
            @click="emit('confirmClearLoudnessAnalysisCache')"
          >
            <i class="pi pi-trash"></i>
            {{ clearingLoudnessAnalysisCache ? '清理中…' : '清理响度缓存' }}
          </button>
        </div>
      </div></SettingsGroup
    >
  </div>
</template>
