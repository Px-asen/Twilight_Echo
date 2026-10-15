<script setup lang="ts">
import { defineAsyncComponent, computed, ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import { useEscapeToClose } from '@renderer/app/useDismissLayer'
import type { Track } from '@renderer/types/music'
import CoverImg from '@renderer/components/CoverImg.vue'
import LocalLibraryTagManager from '@renderer/components/LocalLibraryTagManager.vue'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { selectLocalLibraryActionTracks } from '@renderer/utils/localTrackRemovalPolicy.ts'
import type { LocalLibraryTagPatch } from '../../../shared/localLibraryTags.ts'

const props = defineProps<{ track: Track }>()
const editing = ref(false)
const versions = ref(false)
const MusicVersionsHost = defineAsyncComponent(
  () => import('@renderer/components/music-versions/MusicVersionsHost.vue')
)
const editableTracks = computed(() => {
  const track = props.track
  const id = typeof track.id === 'string' ? track.id : ''
  const source = track.source
  const mayBeLocal =
    source === 'local' ||
    (!source && (/^[a-zA-Z]:[\\/]/.test(id) || /^[\\/]/.test(id) || !id.includes(':')))
  return mayBeLocal ? selectLocalLibraryActionTracks([track]) : []
})
function applyTags(paths: string[], patch: LocalLibraryTagPatch): void {
  useMusicStore().applyLocalTagWrite(paths, patch)
}
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const tagManager = ref<{ requestClose: () => void } | null>(null)
useNativeDialog(dialog)
useEscapeToClose(
  () => !editing.value && !versions.value,
  () => emit('close')
)

function onCancel(): void {
  if (versions.value) versions.value = false
  else if (editing.value) tagManager.value?.requestClose()
  else emit('close')
}

function onEditingEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented || !editing.value) return
  // Repeated native close requests can become non-cancelable in Chromium.
  event.preventDefault()
  tagManager.value?.requestClose()
}
</script>

<template>
  <dialog
    ref="dialog"
    class="track-info-dialog"
    data-te-material="dialog"
    :class="{ 'is-editing': editing || versions }"
    :aria-labelledby="editing ? 'tag-manager-title' : versions ? undefined : 'track-info-title'"
    :aria-label="versions ? '歌曲与专辑版本' : undefined"
    @close="emit('close')"
    @cancel.prevent="onCancel"
    @keydown.esc="onEditingEscape"
  >
    <MusicVersionsHost v-if="versions" embedded :initial-track="track" @close="versions = false" />
    <LocalLibraryTagManager
      v-else-if="editing"
      ref="tagManager"
      :tracks="editableTracks"
      @close="editing = false"
      @applied="applyTags"
    />
    <template v-else>
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
      <button
        v-if="editableTracks.length"
        type="button"
        class="track-info-edit"
        @click="editing = true"
      >
        编辑歌曲信息
      </button>
      <button type="button" class="track-info-edit" @click="versions = true">歌曲与专辑版本</button>
    </template>
  </dialog>
</template>

<style scoped>
.track-info-dialog {
  -webkit-app-region: no-drag;
  position: fixed;
  width: min(420px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  box-sizing: border-box;
  margin: auto;
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--te-material-border, var(--te-card-border));
  border-radius: var(--te-dialog-radius);
  color: var(--te-material-ink, var(--te-neutral-900));
  background: var(--te-material-background, var(--te-card-bg));
  box-shadow: var(--te-material-shadow, none);
  font-size: var(--te-font-size-body, 14px);
}
.track-info-dialog::backdrop {
  background: var(--te-material-scrim, var(--te-dialog-backdrop));
}
.track-info-dialog.is-editing {
  width: min(900px, calc(100vw - 48px));
  padding: 0;
}
.track-info-edit {
  min-height: 36px;
  padding: 8px 14px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-hover-bg);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.track-info-close {
  position: absolute;
  top: 8px;
  right: 12px;
  width: 32px;
  height: 32px;
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
  margin: 0 24px 12px 0;
  font-size: var(--te-type-section-title, 20px);
  font-weight: 600;
  overflow-wrap: anywhere;
}
button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
</style>
