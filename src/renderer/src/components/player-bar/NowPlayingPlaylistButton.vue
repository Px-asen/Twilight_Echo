<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '@renderer/types/music.ts'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { useAppNoticeStore } from '@renderer/stores/useAppNoticeStore'
import { useMediaProviders, syncPluginProviders } from '@renderer/providers'
import { useQueueAddToPlaylist } from '@renderer/components/player-bar/useQueueAddToPlaylist.ts'
import QueueAddToPlaylistDialog from '@renderer/components/player-bar/QueueAddToPlaylistDialog.vue'

const props = defineProps<{ track: Track }>()
const queue = computed(() => [props.track])
const { localPlaylists, addTracksToPlaylist, createPlaylistWithTracks } = useMusicStore()
const mediaProviders = useMediaProviders()
const { pushNotice } = useAppNoticeStore()
const queueAddToPlaylist = useQueueAddToPlaylist({
  queue,
  playlists: localPlaylists,
  mediaProviders,
  addTracksToPlaylist,
  createPlaylistWithTracks,
  notify: (notice) => {
    pushNotice({ kind: notice.kind, message: notice.message })
  },
  syncProviders: async () => {
    if (typeof window !== 'undefined' && window.api?.providers) await syncPluginProviders()
  }
})

const queueAddToPlaylistProvider = computed(() =>
  queueAddToPlaylist.providerId.value === null
    ? null
    : {
        name: queueAddToPlaylist.providerName.value,
        writable: queueAddToPlaylist.providerWritable.value,
        canCreate: queueAddToPlaylist.providerCanCreate.value,
        playlists: queueAddToPlaylist.providerPlaylists.value,
        loading: queueAddToPlaylist.providerLoading.value,
        error: queueAddToPlaylist.providerError.value
      }
)
</script>
<template>
  <button
    type="button"
    class="now-playing-playlist-button"
    aria-label="添加到歌单"
    title="添加到歌单"
    @click="queueAddToPlaylist.openForTrack(track)"
  >
    <i class="pi pi-plus" aria-hidden="true"></i>
    添加到歌单
  </button>
  <QueueAddToPlaylistDialog
    :open="queueAddToPlaylist.open.value"
    :target-label="queueAddToPlaylist.targetLabel.value"
    :local-playlists="queueAddToPlaylist.localPlaylists.value"
    :provider="queueAddToPlaylistProvider"
    :error-message="queueAddToPlaylist.errorMessage.value"
    :busy-target="queueAddToPlaylist.busyTarget.value"
    :create-scope="queueAddToPlaylist.createScope.value"
    :new-playlist-name="queueAddToPlaylist.newPlaylistName.value"
    @update:new-playlist-name="queueAddToPlaylist.newPlaylistName.value = $event"
    @close="queueAddToPlaylist.close"
    @start-create="queueAddToPlaylist.startCreate"
    @cancel-create="queueAddToPlaylist.cancelCreate"
    @confirm-create="queueAddToPlaylist.confirmCreate"
    @reload-provider="queueAddToPlaylist.reloadProviderPlaylists"
    @add-local="queueAddToPlaylist.addToLocalPlaylist"
    @add-provider="queueAddToPlaylist.addToProviderPlaylist"
  />
</template>
<style scoped>
.now-playing-playlist-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 14px;
  border: 1px solid currentColor;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.now-playing-playlist-button:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
</style>
