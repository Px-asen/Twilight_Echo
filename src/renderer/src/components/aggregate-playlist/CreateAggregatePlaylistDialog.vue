<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AnimatedInput from '../AnimatedInput.vue'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer.ts'
import { useMusicStore } from '../../stores/useMusicStore'
import type { Track } from '../../types/music'

/**
 * 「新建聚合歌单并加入」对话框。本地页和流媒体页的右键子菜单共用同一个实现，
 * 免得两边各自维护一份输入框、查重提示和写入路径。
 */
const props = defineProps<{
  show: boolean
  /** 创建后立即加入的曲目；为空就只建一个空歌单。 */
  tracks: Track[]
}>()

const emit = defineEmits<{
  close: []
  created: [playlistId: string, addedCount: number]
}>()

const { createAggregatePlaylist, addTracksToPlaylistById } = useMusicStore()

const name = ref('')
const error = ref('')
const dialogRef = ref<HTMLElement | null>(null)

watch(
  () => props.show,
  (show) => {
    if (!show) return
    name.value = ''
    error.value = ''
  }
)

const trackLabel = computed(() =>
  props.tracks.length > 1 ? `，并加入 ${props.tracks.length} 首歌曲` : ''
)

function close(): void {
  emit('close')
}

function confirm(): void {
  const trimmed = name.value.trim()
  if (!trimmed) {
    error.value = '请输入聚合歌单名称'
    return
  }
  try {
    const playlistId = createAggregatePlaylist(trimmed)
    const added = props.tracks.length > 0 ? addTracksToPlaylistById(playlistId, props.tracks) : 0
    emit('created', playlistId, added)
    close()
  } catch (createError) {
    error.value = createError instanceof Error ? createError.message : '创建聚合歌单失败'
  }
}

useEscapeToClose(
  () => props.show,
  () => close()
)
useFocusTrap(dialogRef, () => props.show)
</script>

<template>
  <Teleport to="body">
    <Transition name="aggregate-dialog">
      <div v-if="show" class="create-aggregate-overlay" @click.self="close()">
        <div
          ref="dialogRef"
          class="create-aggregate-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="新建聚合歌单"
          @click.stop
        >
          <h3 class="create-aggregate-title">新建聚合歌单{{ trackLabel }}</h3>
          <AnimatedInput
            v-model="name"
            type="text"
            class="create-aggregate-input"
            placeholder="聚合歌单名称"
            aria-label="聚合歌单名称"
            animate
            @keydown.enter="confirm()"
          />
          <p v-if="error" class="create-aggregate-error" role="alert">{{ error }}</p>
          <div class="create-aggregate-actions">
            <button type="button" class="create-aggregate-btn" @click="close()">取消</button>
            <button
              type="button"
              class="create-aggregate-btn create-aggregate-btn-primary"
              @click="confirm()"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.aggregate-dialog-enter-active,
.aggregate-dialog-leave-active {
  transition: opacity var(--te-motion-panel) var(--te-ease-soft);
}

.aggregate-dialog-enter-active .create-aggregate-dialog,
.aggregate-dialog-leave-active .create-aggregate-dialog {
  transition: transform var(--te-motion-panel) var(--te-ease-soft);
}

.aggregate-dialog-leave-active,
.aggregate-dialog-leave-active .create-aggregate-dialog {
  transition-duration: var(--te-motion-hover);
  pointer-events: none;
}

.aggregate-dialog-enter-from,
.aggregate-dialog-leave-to {
  opacity: 0;
}

.aggregate-dialog-enter-from .create-aggregate-dialog,
.aggregate-dialog-leave-to .create-aggregate-dialog {
  transform: scale(0.97);
}

html[data-te-motion='reduced'] .create-aggregate-overlay {
  transition: opacity 120ms var(--te-ease-soft) !important;
}

html[data-te-motion='reduced'] .create-aggregate-dialog,
html[data-te-motion='off'] .create-aggregate-dialog {
  transform: none !important;
}

html[data-te-motion='off'] .create-aggregate-overlay {
  opacity: 1 !important;
}

.create-aggregate-overlay {
  position: fixed;
  inset: 0;
  z-index: 4200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--te-neutral-900) 44%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.create-aggregate-dialog {
  width: min(400px, calc(100vw - 48px));
  padding: 22px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-dialog-radius, 18px);
  background: var(--te-card-bg);
  box-shadow: var(--te-card-hover-shadow, var(--te-card-shadow));
  color: var(--te-neutral-900);
  font-family: var(--te-font-sans);
}

.create-aggregate-title {
  margin: 0 0 16px;
  font-size: calc(var(--te-font-size-body, 14px) * 16 / 14);
  font-weight: 700;
}

.create-aggregate-input {
  width: 100%;
}

.create-aggregate-error {
  margin: 10px 0 0;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
  color: var(--te-danger-soft-fg);
}

.create-aggregate-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

.create-aggregate-btn {
  height: 34px;
  padding: 0 18px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-radius-global);
  background: transparent;
  color: var(--te-neutral-900);
  font: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.18s,
    border-color 0.18s;
}

.create-aggregate-btn:hover {
  background: var(--te-hover-bg);
}

.create-aggregate-btn:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}

.create-aggregate-btn-primary {
  border-color: transparent;
  background: var(--te-primary-500);
  color: var(--te-neutral-50);
}

.create-aggregate-btn-primary:hover {
  background: color-mix(in srgb, var(--te-primary-500) 86%, var(--te-neutral-900));
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .create-aggregate-overlay {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
