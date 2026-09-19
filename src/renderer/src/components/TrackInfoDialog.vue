<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEscapeToClose } from '@renderer/app/useDismissLayer'
import type { Track } from '@renderer/types/music'
import CoverImg from '@renderer/components/CoverImg.vue'

defineProps<{ track: Track }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
onMounted(() => dialog.value?.showModal())
useEscapeToClose(
  () => true,
  () => emit('close')
)
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="track-info-dialog"
      aria-labelledby="track-info-title"
      @close="emit('close')"
      @cancel.prevent="emit('close')"
    >
      <button
        type="button"
        class="track-info-close"
        aria-label="关闭歌曲信息"
        @click.stop="emit('close')"
      >
        ×
      </button>
      <CoverImg
        :cover="track.cover"
        :cover-source="track.coverSource"
        class="track-info-cover"
        alt=""
      />
      <h2 id="track-info-title">{{ track.title }}</h2>
      <dl>
        <dt>艺人</dt>
        <dd>{{ track.artist || '未知艺人' }}</dd>
        <dt>专辑</dt>
        <dd>{{ track.album || '未知专辑' }}</dd>
        <dt>时长</dt>
        <dd>
          {{ Math.floor(track.duration / 60) }}:{{
            String(Math.floor(track.duration % 60)).padStart(2, '0')
          }}
        </dd>
        <dt>来源</dt>
        <dd>{{ track.source || 'local' }}</dd>
      </dl>
    </dialog>
  </Teleport>
</template>

<style scoped>
.track-info-dialog {
  -webkit-app-region: no-drag;
  position: fixed;
  width: min(420px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  padding: 28px;
  border: 1px solid var(--te-card-border);
  border-radius: 20px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg, Canvas);
}
.track-info-dialog::backdrop {
  background: color-mix(in srgb, var(--te-neutral-900) 35%, transparent);
}
.track-info-close {
  position: absolute;
  top: 8px;
  right: 12px;
  font: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 24 / 14);
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.track-info-cover {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: 12px;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
h2 {
  overflow-wrap: anywhere;
}
</style>
