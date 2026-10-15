<script setup lang="ts">
import CoverImg from './CoverImg.vue'
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed } from 'vue'
import type { NcmCloudSelectedFile } from '../../../shared/ncmCloud.ts'
import type { NcmCloudSong, NcmCloudTransferTask } from '../stores/useNcmStore.ts'

const props = defineProps<{
  songs: NcmCloudSong[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string
  selectedFiles: NcmCloudSelectedFile[]
  transferTasks: Record<string, NcmCloudTransferTask>
  currentTrackId?: string | null
}>()

const emit = defineEmits<{
  refresh: []
  loadMore: []
  chooseFiles: []
  upload: [handle: string]
  removeSelected: [handle: string]
  play: [song: NcmCloudSong]
  playAll: []
  download: [song: NcmCloudSong]
  cancel: [transferId: string]
}>()

const tasks = computed(() => Object.values(props.transferTasks))
const visibleTasks = computed(() =>
  tasks.value
    .filter(
      (task) =>
        task.kind === 'download' || !props.selectedFiles.some((file) => file.handle === task.handle)
    )
    .reverse()
    .slice(0, 8)
)

function isActive(task?: NcmCloudTransferTask): boolean {
  return !!task && !['completed', 'failed', 'cancelled'].includes(task.stage)
}

function preferredTask(
  predicate: (task: NcmCloudTransferTask) => boolean
): NcmCloudTransferTask | undefined {
  const matches = tasks.value.filter(predicate)
  return matches.find(isActive) ?? matches.at(-1)
}

function taskForHandle(handle: string): NcmCloudTransferTask | undefined {
  return preferredTask((task) => task.kind === 'upload' && task.handle === handle)
}

function taskForSong(song: NcmCloudSong): NcmCloudTransferTask | undefined {
  return preferredTask(
    (task) => task.kind === 'download' && String(task.cloudSongId) === String(song.cloudSongId)
  )
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知大小'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024
    unit = units[index]
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${unit}`
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

function formatDate(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '添加时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(timestamp))
}

function progressLabel(task: NcmCloudTransferTask): string {
  if (task.percent != null) {
    return `${task.message} · ${task.percent}% · ${formatBytes(task.bytesTransferred)} / ${formatBytes(task.bytesTotal)}`
  }
  return `${task.message} · ${formatBytes(task.bytesTransferred)}`
}

function onSongKeydown(event: KeyboardEvent, song: NcmCloudSong): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) emit('play', song)
}
</script>

<template>
  <section class="cloud-panel" aria-labelledby="ncm-cloud-title" :aria-busy="loading">
    <div class="cloud-header">
      <div>
        <span class="cloud-kicker">网易云音乐</span>
        <h2 id="ncm-cloud-title">我的音乐云盘</h2>
        <p>{{ total }} 首云盘歌曲</p>
      </div>
      <div class="cloud-header-actions">
        <button
          type="button"
          class="cloud-button secondary"
          :disabled="loading || loadingMore"
          :aria-busy="loading"
          @click="emit('refresh')"
        >
          <i :class="loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'"></i>
          {{ loading ? '正在刷新…' : '刷新' }}
        </button>
        <button type="button" class="cloud-button primary" @click="emit('chooseFiles')">
          <i class="pi pi-upload"></i>
          选择音频
        </button>
      </div>
    </div>

    <div v-if="error && songs.length > 0 && !loading" class="cloud-inline-error" role="alert">
      <p>{{ error }}</p>
      <button type="button" class="cloud-button secondary" @click="emit('refresh')">重试</button>
    </div>
    <p v-if="loading && songs.length > 0" class="cloud-loading" role="status">正在刷新云盘歌曲…</p>

    <div v-if="selectedFiles.length > 0" class="upload-queue">
      <div class="queue-heading">
        <div>
          <h3>待上传文件</h3>
          <p>一次最多选择 20 个音频文件。</p>
        </div>
      </div>
      <article v-for="file in selectedFiles" :key="file.handle" class="transfer-row">
        <span class="transfer-icon"><i class="pi pi-file"></i></span>
        <div class="transfer-copy">
          <strong :title="file.name">{{ file.name }}</strong>
          <span>{{ (file.format || '音频').toUpperCase() }} · {{ formatBytes(file.size) }}</span>
          <div v-if="taskForHandle(file.handle)" class="progress-copy">
            <progress
              class="progress-track"
              max="100"
              :value="taskForHandle(file.handle)?.percent ?? undefined"
              :aria-label="`${file.name}：${progressLabel(taskForHandle(file.handle)!)}`"
            ></progress>
            <small>{{ progressLabel(taskForHandle(file.handle)!) }}</small>
            <small v-if="taskForHandle(file.handle)?.error" class="task-error" role="alert">
              {{ taskForHandle(file.handle)?.error }}
            </small>
          </div>
        </div>
        <div class="transfer-actions">
          <button
            v-if="isActive(taskForHandle(file.handle))"
            type="button"
            class="icon-button danger"
            title="取消上传"
            :aria-label="`取消上传 ${file.name}`"
            @click="emit('cancel', taskForHandle(file.handle)!.transferId)"
          >
            <i class="pi pi-times"></i>
          </button>
          <template v-else>
            <button
              type="button"
              class="icon-button"
              title="移除"
              :aria-label="`移除待上传文件 ${file.name}`"
              @click="emit('removeSelected', file.handle)"
            >
              <i class="pi pi-trash"></i>
            </button>
            <button
              type="button"
              class="cloud-button compact primary"
              @click="emit('upload', file.handle)"
            >
              上传
            </button>
          </template>
        </div>
      </article>
    </div>

    <div
      v-if="error && songs.length === 0 && !loading"
      class="cloud-state error-state"
      role="alert"
    >
      <i class="pi pi-exclamation-triangle"></i>
      <strong>云盘加载失败</strong>
      <p>{{ error }}</p>
      <button type="button" class="cloud-button primary" @click="emit('refresh')">重试</button>
    </div>

    <div v-else-if="loading && songs.length === 0" class="cloud-state" role="status">
      <i class="pi pi-spin pi-spinner"></i>
      <strong>正在加载云盘歌曲</strong>
      <p>正在从网易云音乐读取当前账号的云盘数据。</p>
    </div>

    <div v-else-if="songs.length === 0" class="cloud-state" role="status">
      <i class="pi pi-cloud"></i>
      <strong>云盘暂时为空</strong>
      <p>选择本地音频上传到云盘，随时播放或下载。</p>
      <button type="button" class="cloud-button primary" @click="emit('chooseFiles')">
        选择音频
      </button>
    </div>

    <template v-else>
      <div class="song-toolbar">
        <div>
          <strong>云盘歌曲</strong>
          <span>已加载 {{ songs.length }} / {{ total }}</span>
        </div>
        <button type="button" class="cloud-button primary" @click="emit('playAll')">
          <PlaybackIcon name="play" />
          播放全部
        </button>
      </div>

      <div class="cloud-song-list">
        <article
          v-for="song in songs"
          :key="String(song.cloudSongId)"
          class="cloud-song"
          :class="{ playing: song.track.id === currentTrackId }"
          tabindex="0"
          role="group"
          :aria-label="`${song.track.title} · ${song.track.artist || '未知艺术家'}，按回车播放`"
          @click="emit('play', song)"
          @keydown="onSongKeydown($event, song)"
        >
          <button
            type="button"
            class="song-cover"
            :aria-label="`播放 ${song.track.title}`"
            @click.stop="emit('play', song)"
          >
            <CoverImg
              :cover="song.track.cover"
              :cover-source="song.track.coverSource"
              :identity="song.track.id"
              alt=""
              loading="lazy"
            />
            <span class="cover-play"><PlaybackIcon name="play" /></span>
          </button>
          <span class="song-main">
            <strong :title="song.track.title">{{ song.track.title }}</strong>
            <small
              :title="`${song.track.artist || '未知艺术家'} · ${song.track.album || '未知专辑'}`"
              >{{ song.track.artist || '未知艺术家' }} · {{ song.track.album || '未知专辑' }}</small
            >
            <small class="song-file" :title="song.fileName">{{ song.fileName }}</small>
          </span>
          <span class="song-meta">
            <small>{{ (song.track.format || 'audio').toUpperCase() }}</small>
            <small>{{ formatBytes(song.track.size) }}</small>
          </span>
          <span class="song-meta secondary-meta">
            <small>{{ formatDuration(song.track.duration) }}</small>
            <small>{{ formatDate(song.addTime) }}</small>
          </span>
          <span class="song-actions">
            <button
              v-if="isActive(taskForSong(song))"
              type="button"
              class="icon-button danger"
              title="取消下载"
              :aria-label="`取消下载 ${song.track.title}`"
              @click.stop="emit('cancel', taskForSong(song)!.transferId)"
            >
              <i class="pi pi-times"></i>
            </button>
            <button
              v-else
              type="button"
              class="icon-button"
              title="下载"
              :aria-label="`下载 ${song.track.title}`"
              @click.stop="emit('download', song)"
            >
              <i class="pi pi-download"></i>
            </button>
          </span>
          <progress
            v-if="taskForSong(song)"
            class="song-progress"
            max="100"
            :value="taskForSong(song)?.percent ?? undefined"
            :aria-label="`${song.track.title}：${progressLabel(taskForSong(song)!)}`"
          ></progress>
        </article>
      </div>

      <button
        v-if="hasMore"
        type="button"
        class="load-more"
        :disabled="loadingMore || loading"
        :aria-busy="loadingMore"
        @click="emit('loadMore')"
      >
        <i v-if="loadingMore" class="pi pi-spin pi-spinner"></i>
        {{ loadingMore ? '正在加载' : '加载更多' }}
      </button>
    </template>

    <div v-if="visibleTasks.length > 0" class="recent-transfers">
      <h3>最近传输</h3>
      <article v-for="task in visibleTasks" :key="task.transferId" class="recent-transfer">
        <i :class="task.kind === 'upload' ? 'pi pi-upload' : 'pi pi-download'"></i>
        <div>
          <strong :title="task.fileName">{{ task.fileName }}</strong>
          <small
            :class="{ 'task-error': task.stage === 'failed' }"
            :role="task.stage === 'failed' ? 'alert' : undefined"
          >
            {{ task.error || progressLabel(task) }}
          </small>
        </div>
        <button
          v-if="isActive(task)"
          type="button"
          class="icon-button danger"
          title="取消传输"
          :aria-label="`取消传输 ${task.fileName}`"
          @click="emit('cancel', task.transferId)"
        >
          <i class="pi pi-times"></i>
        </button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.cloud-panel {
  min-width: 0;
  color: var(--te-settings-text);
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body);
  line-height: var(--te-type-line-body);
  container: te-ncm-cloud / inline-size;
}
.cloud-header,
.song-toolbar,
.queue-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
}
.cloud-header > div:first-child {
  min-width: 0;
}
.cloud-kicker {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}
.cloud-header h2 {
  margin: 4px 0 8px;
  color: var(--te-settings-text);
  font-size: var(--te-type-page-title);
  font-weight: var(--te-type-weight-strong);
  line-height: var(--te-type-line-title);
  overflow-wrap: anywhere;
}
.cloud-header p,
.queue-heading p {
  margin: 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  overflow-wrap: anywhere;
}
.cloud-header-actions,
.transfer-actions,
.song-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.cloud-button,
.icon-button,
.load-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--te-control-gap);
  min-height: var(--te-control-height-md);
  max-width: 100%;
  padding: 6px var(--te-control-pad-x-md);
  border: var(--te-control-border-width) solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-subtle-bg);
  color: var(--te-settings-text);
  font: inherit;
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-medium);
  line-height: var(--te-type-line-caption);
  cursor: pointer;
  transition: background-color var(--te-motion-hover) var(--te-ease-soft);
}
.song-toolbar .cloud-button.primary {
  color: var(--te-control-on-accent);
  background: var(--te-control-accent);
  border-color: transparent;
}
.cloud-button:hover:not(:disabled),
.load-more:hover:not(:disabled),
.icon-button:hover:not(:disabled) {
  background: var(--te-hover-bg);
}
.song-toolbar .cloud-button.primary:hover:not(:disabled) {
  background: var(--te-primary-600);
}
.cloud-button:disabled,
.load-more:disabled {
  cursor: default;
  opacity: 0.5;
}
.upload-queue,
.recent-transfers {
  margin-top: 24px;
  border-top: 1px solid var(--te-card-border);
  padding-top: 16px;
}
.queue-heading h3,
.recent-transfers h3 {
  margin: 0 0 8px;
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
}
.transfer-row,
.recent-transfer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--te-card-border);
}
.queue-heading + .transfer-row {
  margin-top: 12px;
}
.transfer-icon {
  display: grid;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: var(--te-control-radius-sm);
  color: var(--te-settings-text-muted);
  background: var(--te-subtle-bg);
}
.transfer-copy,
.recent-transfer > div {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.transfer-copy strong,
.recent-transfer strong {
  overflow: hidden;
  color: var(--te-settings-text);
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transfer-copy > span,
.recent-transfer small,
.progress-copy small {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  overflow-wrap: anywhere;
}
.progress-copy {
  min-width: 0;
}
.progress-track,
.song-progress {
  appearance: none;
  display: block;
  width: 100%;
  height: 4px;
  border: 0;
  border-radius: 0;
  overflow: hidden;
  color: var(--te-primary-500);
  accent-color: var(--te-primary-500);
  background: var(--te-subtle-bg);
}
.progress-track {
  max-width: 420px;
  margin-block: 4px;
}
progress::-webkit-progress-bar {
  background: var(--te-subtle-bg);
}
progress::-webkit-progress-value {
  background: var(--te-primary-500);
}
.icon-button {
  width: max(34px, calc(var(--te-font-size-body) * 2));
  padding: 6px;
  flex-shrink: 0;
}
.icon-button.danger,
.progress-copy .task-error,
.recent-transfer .task-error {
  color: var(--te-danger-soft-fg);
}
.cloud-state {
  display: flex;
  margin-top: 24px;
  padding: 24px 0;
  align-items: flex-start;
  gap: 12px;
  flex-direction: column;
  color: var(--te-settings-text-muted);
}
.cloud-state > i {
  font-size: var(--te-type-section-title);
}
.cloud-state strong {
  color: var(--te-settings-text);
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
}
.cloud-state p {
  max-width: 64ch;
  margin: 0;
  font-size: var(--te-type-body);
  overflow-wrap: anywhere;
}
.error-state > i,
.cloud-inline-error {
  color: var(--te-danger-soft-fg);
}
.cloud-inline-error {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-top: 16px;
  font-size: var(--te-type-caption);
}
.cloud-inline-error p {
  margin: 0;
  overflow-wrap: anywhere;
}
.cloud-loading {
  margin: 16px 0 0;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}
.song-toolbar {
  margin: 24px 0 12px;
}
.song-toolbar > div {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.song-toolbar strong {
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
}
.song-toolbar span {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}
.cloud-song-list {
  display: flex;
  flex-direction: column;
}
.cloud-song {
  position: relative;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 100px 112px max(
      34px,
      calc(var(--te-font-size-body) * 2)
    );
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px;
  border-bottom: 1px solid var(--te-card-border);
  border-radius: var(--te-library-selection-radius);
  cursor: pointer;
  scroll-margin-block: 12px;
  transition: background-color var(--te-motion-hover) var(--te-ease-soft);
}
.cloud-song:hover {
  background: var(--te-library-row-hover);
}
.cloud-song.playing {
  background: var(--te-playing-row-bg, var(--te-library-selection-bg));
}
.cloud-song.playing .song-main strong {
  color: var(--te-primary-500);
}
.song-cover {
  position: relative;
  display: grid;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  place-items: center;
  border-radius: var(--te-library-cover-radius);
  background: var(--te-subtle-bg);
  cursor: pointer;
}
.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
.cover-play {
  position: absolute;
  right: 2px;
  bottom: 2px;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: var(--te-control-radius-sm);
  color: var(--te-settings-text);
  background: var(--te-card-bg);
  font-size: 16px;
  opacity: 0;
}
.cloud-song:hover .cover-play,
.song-cover:focus-visible .cover-play,
.cloud-song.playing .cover-play {
  opacity: 1;
}
.song-main,
.song-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.song-main strong,
.song-main small,
.song-meta small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.song-main strong {
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-medium);
  line-height: 1.35;
}
.song-main small,
.song-meta small {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
}
.song-progress {
  position: absolute;
  right: 8px;
  bottom: 0;
  left: 8px;
  width: calc(100% - 16px);
  height: 3px;
}
.load-more {
  margin-top: 16px;
}
.recent-transfer > i {
  color: var(--te-settings-text-muted);
}
.cloud-panel :is(button, .cloud-song):focus-visible {
  outline: var(--te-control-focus-width) solid var(--te-control-focus-color);
  outline-offset: var(--te-control-focus-offset);
}
@container te-ncm-cloud (max-width: 900px) {
  .cloud-song {
    grid-template-columns: 40px minmax(0, 1fr) 100px max(34px, calc(var(--te-font-size-body) * 2));
  }
  .secondary-meta {
    display: none;
  }
}
@container te-ncm-cloud (max-width: 680px) {
  .cloud-header,
  .song-toolbar,
  .queue-heading {
    align-items: flex-start;
  }
  .cloud-header-actions {
    width: 100%;
  }
  .transfer-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .cloud-song {
    grid-template-columns: 40px minmax(0, 1fr) max(34px, calc(var(--te-font-size-body) * 2));
    gap: 8px;
  }
  .song-meta {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cloud-panel * {
    transition: none;
  }
}
</style>
