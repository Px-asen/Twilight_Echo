<script setup lang="ts">
import { defineAsyncComponent, computed } from 'vue'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import OnlineHome from './OnlineHome.vue'
import { useThemeStore } from '@renderer/stores/useThemeStore'
import type { StreamingPageTab } from '@renderer/app/navigationPages'

const OnlineDashboard = defineAsyncComponent(() => import('./OnlineDashboard.vue'))
defineProps<{ preview?: boolean }>()

const LocalDashboard = defineAsyncComponent(() => import('@renderer/components/LocalDashboard.vue'))
const ArchiveDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/ArchiveDashboard.vue')
)
const NightHarborDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/NightHarborDashboard.vue')
)
const SoundFieldDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/SoundFieldDashboard.vue')
)
const { presetLayout } = useThemeStore()
const { tracks } = useMusicStore()
const player = usePlayerStore()
const previewTracks = computed(() => tracks.value.slice(-6).reverse())

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
  'open-streaming': [tab: StreamingPageTab]
  'open-plugins': []
  'open-radio': []
  login: [providerId: string]
}>()
</script>

<template>
  <div class="local-home-layout">
    <OnlineHome
      v-if="
        preview && !['aurora-reference', 'obsidian-glass', 'paper-light'].includes(presetLayout)
      "
      :providers="[]"
      :provider="null"
      :loading="false"
      :logged-in="false"
      error=""
      :tracks="[]"
      :playlists="[]"
      section-title=""
      playlist-title=""
      :recent="[]"
      :local-tracks="previewTracks"
      :local-count="tracks.length"
      :hero="player.currentTrack.value ?? previewTracks[0] ?? null"
      :current-track-id="player.currentTrack.value?.id"
      :is-playing="player.isPlaying.value"
      :pending-playlist="null"
    />
    <OnlineDashboard
      v-else-if="
        !preview && !['aurora-reference', 'obsidian-glass', 'paper-light'].includes(presetLayout)
      "
      @select-view="(category, filter) => emit('select-view', category, filter)"
      @open-library-settings="emit('open-library-settings')"
      @open-streaming="emit('open-streaming', $event)"
      @open-plugins="emit('open-plugins')"
      @open-radio="emit('open-radio')"
      @login="emit('login', $event)"
    />
    <component
      v-else
      :is="
        presetLayout === 'aurora-reference'
          ? ArchiveDashboard
          : presetLayout === 'obsidian-glass'
            ? NightHarborDashboard
            : presetLayout === 'paper-light'
              ? SoundFieldDashboard
              : LocalDashboard
      "
      @select-view="
        (category: string, filter: string | null) => emit('select-view', category, filter)
      "
      @open-library-settings="emit('open-library-settings')"
    />
  </div>
</template>

<style scoped>
.local-home-layout {
  --te-home-titlebar-clearance: var(--te-titlebar-inset, 35px);
  width: 100%;
  height: 100%;
  min-width: 0;
}
/* Custom shells already place content below their titlebar grid row. */
:global(html[data-te-shell-layout='custom']) .local-home-layout {
  --te-home-titlebar-clearance: 0px;
}
</style>
