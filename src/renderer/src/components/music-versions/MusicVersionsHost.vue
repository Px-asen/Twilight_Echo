<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Track } from '@renderer/types/music'
import type { VersionScope } from '@renderer/utils/musicVersions.ts'
import { versionSourceKey } from '@renderer/utils/trackSourceIdentity.ts'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore.ts'
import MusicVersionsPanel from '@renderer/components/music-versions/MusicVersionsPanel.vue'

const props = withDefaults(
  defineProps<{
    initialTrack?: Track
    initialScope?: VersionScope
    embedded?: boolean
    restoreFocus?: HTMLElement | null
  }>(),
  { initialScope: 'tracks', embedded: false }
)
const emit = defineEmits<{ close: [] }>()
const music = useMusicStore()
const dialog = ref<HTMLDialogElement | null>(null)
const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
const tracks = computed(() => {
  const result = new Map(music.tracks.value.map((track) => [versionSourceKey(track), track]))
  for (const playlist of music.playlists.value)
    for (const track of Object.values(playlist.trackSnapshots ?? {})) {
      const key = versionSourceKey(track)
      if (!result.has(key)) result.set(key, track)
    }
  if (props.initialTrack) result.set(versionSourceKey(props.initialTrack), props.initialTrack)
  return [...result.values()]
})
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => {
  dialog.value?.close()
  ;(props.restoreFocus ?? trigger)?.focus()
})
function play(selected: Track[]): void {
  if (selected.length) usePlayerStore().playTrack(selected[0], selected)
}
</script>

<template>
  <MusicVersionsPanel
    v-if="embedded"
    :tracks="tracks"
    :initial-track="initialTrack"
    :initial-scope="initialScope"
    @close="emit('close')"
    @play="play"
  />
  <dialog
    v-else
    ref="dialog"
    class="music-versions-dialog"
    aria-label="歌曲与专辑版本管理"
    @cancel.prevent="emit('close')"
  >
    <MusicVersionsPanel
      :tracks="tracks"
      :initial-track="initialTrack"
      :initial-scope="initialScope"
      @close="emit('close')"
      @play="play"
    />
  </dialog>
</template>

<style scoped>
.music-versions-dialog {
  width: min(1000px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  overflow: auto;
}
.music-versions-dialog::backdrop {
  background: color-mix(in srgb, var(--te-neutral-900) 35%, transparent);
}
</style>
