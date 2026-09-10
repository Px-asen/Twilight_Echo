<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider.ts'
import type { QueueLocalPlaylistRow } from './useQueueAddToPlaylist.ts'
import AnimatedInput from '../AnimatedInput.vue'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer.ts'

/** Remote playlist section state; null for local-only tracks. */
export interface QueueAddToPlaylistProviderView {
  name: string
  /** The provider accepts library writes, so its playlists can be listed. */
  writable: boolean
  canCreate: boolean
  playlists: MediaProviderPlaylistSummary[]
  loading: boolean
  error: string
}

const props = defineProps<{
  open: boolean
  targetLabel: string
  localPlaylists: QueueLocalPlaylistRow[]
  provider: QueueAddToPlaylistProviderView | null
  errorMessage: string
  busyTarget: string | null
  createScope: 'local' | 'provider' | null
  newPlaylistName: string
}>()

const emit = defineEmits<{
  'update:newPlaylistName': [value: string]
  close: []
  startCreate: [scope: 'local' | 'provider']
  cancelCreate: []
  confirmCreate: []
  reloadProvider: []
  addLocal: [name: string]
  addProvider: [playlist: MediaProviderPlaylistSummary]
}>()

const dialogRef = ref<HTMLElement | null>(null)
const busy = computed(() => props.busyTarget !== null)
const newName = computed({
  get: () => props.newPlaylistName,
  set: (value: string) => emit('update:newPlaylistName', value)
})
const createTitle = computed(() =>
  props.createScope === 'provider' ? `新建${props.provider?.name ?? ''}歌单` : '新建本地歌单'
)

function close(): void {
  if (busy.value) return
  emit('close')
}

useEscapeToClose(() => props.open, close)
useFocusTrap(dialogRef, () => props.open)
</script>

<template>
  <Teleport to="body">
    <Transition name="queue-playlist-fade">
      <div v-if="open" class="queue-playlist-overlay" @click.self="close">
        <div
          ref="dialogRef"
          class="queue-playlist-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="添加到歌单"
        >
          <h3>添加到歌单</h3>
          <p class="queue-playlist-target">{{ targetLabel }}</p>

          <form
            v-if="createScope"
            class="queue-playlist-create"
            @submit.prevent="emit('confirmCreate')"
          >
            <label class="queue-playlist-create-label" for="queue-playlist-new-name">
              {{ createTitle }}
            </label>
            <AnimatedInput
              id="queue-playlist-new-name"
              v-model="newName"
              type="text"
              class="queue-playlist-name-input"
              maxlength="80"
              placeholder="请输入歌单名称"
              :disabled="busy"
              autofocus
              animate
            />
            <div class="queue-playlist-create-actions">
              <button type="button" :disabled="busy" @click="emit('cancelCreate')">取消</button>
              <button type="submit" class="primary" :disabled="busy || !newPlaylistName.trim()">
                {{ busy ? '创建中…' : '创建并添加' }}
              </button>
            </div>
          </form>

          <section class="queue-playlist-section">
            <h4>本地歌单</h4>
            <button
              type="button"
              class="queue-playlist-item create"
              :disabled="busy"
              @click="emit('startCreate', 'local')"
            >
              <i class="pi pi-plus" aria-hidden="true"></i>
              <span><strong>新建歌单并添加</strong></span>
            </button>
            <button
              v-for="playlist in localPlaylists"
              :key="playlist.id"
              type="button"
              class="queue-playlist-item"
              :disabled="busy || playlist.contains"
              :aria-label="`添加到歌单 ${playlist.name}`"
              @click="emit('addLocal', playlist.name)"
            >
              <i class="pi pi-list" aria-hidden="true"></i>
              <span>
                <strong>{{ playlist.name }}</strong>
                <small>{{ playlist.contains ? '已在歌单中' : `${playlist.trackCount} 首` }}</small>
              </span>
            </button>
            <p v-if="localPlaylists.length === 0" class="queue-playlist-hint">
              还没有本地歌单，新建一个吧
            </p>
          </section>

          <section v-if="provider" class="queue-playlist-section">
            <h4>{{ provider.name }}</h4>
            <p v-if="!provider.writable" class="queue-playlist-hint">该来源暂不支持写入云端歌单</p>
            <template v-else>
              <p v-if="provider.loading" class="queue-playlist-hint">
                <i class="pi pi-spinner pi-spin" aria-hidden="true"></i>
                正在读取云端歌单…
              </p>
              <template v-else>
                <p v-if="provider.error" class="queue-playlist-error">
                  {{ provider.error }}
                  <button
                    type="button"
                    class="queue-playlist-retry"
                    @click="emit('reloadProvider')"
                  >
                    重试
                  </button>
                </p>
                <button
                  v-if="provider.canCreate"
                  type="button"
                  class="queue-playlist-item create"
                  :disabled="busy"
                  @click="emit('startCreate', 'provider')"
                >
                  <i class="pi pi-plus" aria-hidden="true"></i>
                  <span><strong>新建云端歌单并添加</strong></span>
                </button>
                <button
                  v-for="playlist in provider.playlists"
                  :key="playlist.id"
                  type="button"
                  class="queue-playlist-item"
                  :disabled="busy"
                  :aria-label="`添加到${provider.name}歌单 ${playlist.name}`"
                  @click="emit('addProvider', playlist)"
                >
                  <img v-if="playlist.cover" :src="playlist.cover" alt="" />
                  <i
                    v-else-if="busyTarget === `provider:${playlist.id}`"
                    class="pi pi-spinner pi-spin"
                    aria-hidden="true"
                  ></i>
                  <i v-else class="pi pi-cloud" aria-hidden="true"></i>
                  <span>
                    <strong>{{ playlist.name }}</strong>
                    <small>{{ playlist.trackCount ?? 0 }} 首</small>
                  </span>
                </button>
                <p
                  v-if="!provider.error && provider.playlists.length === 0"
                  class="queue-playlist-hint"
                >
                  暂无自建歌单，可先新建一个
                </p>
              </template>
            </template>
          </section>

          <p v-if="errorMessage" class="queue-playlist-error">{{ errorMessage }}</p>
          <div class="queue-playlist-actions">
            <button type="button" :disabled="busy" @click="close">关闭</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.queue-playlist-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.queue-playlist-dialog {
  width: min(420px, 100%);
  max-height: min(78vh, 640px);
  overflow: auto;
  padding: 22px;
  border-radius: 20px;
  background: var(--te-card-bg, #fff);
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.25));
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.22);
}

.queue-playlist-dialog h3 {
  margin: 0 0 6px;
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
  font-weight: 800;
  color: var(--te-neutral-900, #0f172a);
}

.queue-playlist-target {
  margin: 0 0 14px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: var(--te-neutral-500, #64748b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-playlist-section {
  margin-bottom: 14px;
}

.queue-playlist-section h4 {
  margin: 0 0 8px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--te-neutral-500, #64748b);
}

.queue-playlist-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.28));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
  /* `--te-neutral-900` is the only body-text neutral the dark palette defines
     (it inverts to near-white there); `--te-neutral-800` exists in no theme and
     silently fell back to a light-mode slate on the dark card. */
  color: var(--te-neutral-900, #0f172a);
  text-align: left;
  cursor: pointer;
}

.queue-playlist-item.create {
  border-style: dashed;
  color: var(--te-primary-500, #6366f1);
}

.queue-playlist-item img,
.queue-playlist-item > i {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  object-fit: cover;
  background: rgba(var(--te-primary-rgb, 99, 102, 241), 0.1);
}

.queue-playlist-item span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.queue-playlist-item strong {
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-playlist-item small {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: var(--te-neutral-500, #64748b);
}

.queue-playlist-item:hover:not(:disabled) {
  border-color: rgba(var(--te-primary-rgb, 99, 102, 241), 0.4);
  background: rgba(var(--te-primary-rgb, 99, 102, 241), 0.08);
}

.queue-playlist-item:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.queue-playlist-hint {
  margin: 0 0 8px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: var(--te-neutral-500, #64748b);
}

.queue-playlist-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: var(--te-danger-soft-fg, #b91c1c);
}

.queue-playlist-retry {
  border: 0;
  background: none;
  padding: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
  color: var(--te-primary-500, #6366f1);
  cursor: pointer;
}

.queue-playlist-create {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.28));
  border-radius: 14px;
  background: var(--te-subtle-bg, #f8fafc);
}

.queue-playlist-create-label {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
  color: var(--te-neutral-500, #64748b);
}

.queue-playlist-name-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.35));
  border-radius: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  background: var(--te-card-bg, #fff);
  color: var(--te-neutral-900, #0f172a);
  --ai-placeholder: var(--te-neutral-500, #64748b);
}

.queue-playlist-create-actions,
.queue-playlist-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.queue-playlist-actions {
  margin-top: 16px;
}

.queue-playlist-create-actions button,
.queue-playlist-actions button {
  padding: 9px 16px;
  border: 1px solid var(--te-card-border, rgba(148, 163, 184, 0.35));
  border-radius: 999px;
  background: var(--te-subtle-bg, #f8fafc);
  color: var(--te-neutral-700, #334155);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 700;
  cursor: pointer;
}

.queue-playlist-create-actions button.primary {
  border-color: transparent;
  background: var(--te-primary-500, #6366f1);
  color: #fff;
}

.queue-playlist-create-actions button:disabled,
.queue-playlist-actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.queue-playlist-fade-enter-active,
.queue-playlist-fade-leave-active {
  transition: opacity 0.18s ease;
}

.queue-playlist-fade-enter-from,
.queue-playlist-fade-leave-to {
  opacity: 0;
}
</style>
