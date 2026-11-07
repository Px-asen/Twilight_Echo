<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useMusicStore } from '../../stores/useMusicStore'
import MotionTransition from '../MotionTransition.vue'
import type { PageMotionName } from '../../app/motion/policy'

const ExternalPlaylistImportDialog = defineAsyncComponent(
  () => import('../ExternalPlaylistImportDialog.vue')
)
const ImportedPlaylistDetail = defineAsyncComponent(() => import('../ImportedPlaylistDetail.vue'))
const SongList = defineAsyncComponent(() => import('@renderer/components/SongList.vue'))
const AggregatePlaylistPage = defineAsyncComponent(
  () => import('@renderer/components/aggregate-playlist/AggregatePlaylistPage.vue')
)
const PlaylistLibraryPage = defineAsyncComponent(() => import('./PlaylistLibraryPage.vue'))

const props = defineProps<{
  category: string
  filter: string | null
  hasPlayer: boolean
  transitionName: PageMotionName
  returnFromDetail: () => void
}>()
const music = useMusicStore()
const showImport = ref(false)
const importedPlaylistId = computed(() =>
  props.category === 'playlists' && props.filter?.startsWith('external-playlist:')
    ? props.filter.slice('external-playlist:'.length)
    : null
)
const importedPlaylist = computed(() =>
  importedPlaylistId.value
    ? music.playlists.value.find(
        (playlist) => playlist.imported && playlist.id === importedPlaylistId.value
      )
    : undefined
)
const showImportedDetail = computed(() => !!importedPlaylist.value)
const showAggregateDetail = computed(() => props.category === 'aggregate' && !!props.filter)
const showPlaylistDetail = computed(
  () => props.category === 'playlists' && props.filter?.startsWith('playlist:') === true
)
const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  customizeAppearance: []
}>()
</script>

<template>
  <section class="application-playlists-page">
    <div class="playlist-content">
      <MotionTransition :name="transitionName" snapshot wait-for-enter>
        <PlaylistLibraryPage
          v-if="!showImportedDetail && !showAggregateDetail && !showPlaylistDetail"
          @select-view="(category, filter) => emit('selectView', category, filter)"
          @import-external="showImport = true"
        />
        <ImportedPlaylistDetail
          v-else-if="showImportedDetail && importedPlaylist"
          :playlist-id="importedPlaylist.id"
          @back="emit('selectView', 'playlists', null)"
          @navigate="(id) => emit('selectView', 'playlists', `external-playlist:${id}`)"
        />
        <AggregatePlaylistPage
          v-else-if="showAggregateDetail"
          :has-player="hasPlayer"
          surface="local"
          :initial-playlist-id="filter"
          :navigate-playlist="(id) => emit('selectView', 'aggregate', id)"
          :return-from-detail="() => emit('selectView', 'playlists', null)"
        />
        <SongList
          v-else
          category="playlists"
          :filter="filter"
          :has-player="hasPlayer"
          :transition-name="transitionName"
          :return-from-detail="returnFromDetail"
          @select-view="(category, filter) => emit('selectView', category, filter)"
          @customize-appearance="emit('customizeAppearance')"
        />
      </MotionTransition>
    </div>
    <ExternalPlaylistImportDialog
      :show="showImport"
      @close="showImport = false"
      @imported="(id) => emit('selectView', 'playlists', `external-playlist:${id}`)"
    />
  </section>
</template>

<style scoped>
.playlist-content {
  position: relative;
  display: grid;
}
.playlist-content > * {
  grid-area: 1 / 1;
  min-width: 0;
}
.application-playlists-page {
  display: flex;
  width: 100%;
  height: 100vh;
  min-height: 0;
  flex-direction: column;
}
.playlist-content {
  flex: 1;
  min-height: 0;
}
.playlist-content :deep(.song-list),
.playlist-content :deep(.aggregate-page) {
  height: 100% !important;
  padding-top: 24px;
}
.playlist-content :deep(.song-list) {
  background: transparent;
}
.playlist-content :deep(.aggregate-page) {
  padding-inline: min(4.4vw, 48px);
}
:global(html[data-theme='pureWhite'] .application-playlists-page) {
  background: var(--te-card-bg);
}
:global(html[data-te-shell-layout='custom'] .application-playlists-page) {
  height: 100%;
}
</style>
