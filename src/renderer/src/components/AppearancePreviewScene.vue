<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TitleBar from './TitleBar.vue'
import SideMenu from './SideMenu.vue'
import SidebarBookmark from './SidebarBookmark.vue'
import OnlineHome from './local-dashboard/OnlineHome.vue'
import PlayerBar from './PlayerBar.vue'
import { workshopPreviewTracks } from './theme-workshop/workshopPreviewData'
import type { AppearanceDraft } from '../../../shared/appAppearance'
import type { PlayerBarMode } from '../../../shared/playerBar'
import type { PlayerBarLayoutSettings } from '../../../shared/playerBarLayout'
import type { NavigationPagePreferences } from '../../../shared/navigationPages'
import type { NavigationPageDefinition } from '../app/navigationPages'
import { applyAppearanceReferenceMasks } from './appearanceReferenceMasks'

defineProps<{
  navigationGlass: boolean
  playerGlass: boolean
  playerMode: PlayerBarMode
  navigationExpanded: boolean
  navigationPages: NavigationPagePreferences
  playerLayout: PlayerBarLayoutSettings
  appearance: AppearanceDraft
  pages?: NavigationPageDefinition[]
}>()
const scene = ref<HTMLElement>()
// These are inert local examples, never a provider lookup or a personal library.
const sampleTracks = workshopPreviewTracks
  .slice(0, 12)
  .map((track) => ({ ...track, source: 'local' }))
// Pass the display component its own static data, without mounting the online
// dashboard's provider/account lifecycle. New local sections use the same props
// when the shared home component gains them.
const homePreview = {
  providers: [],
  provider: null,
  loading: false,
  loggedIn: false,
  error: '',
  tracks: [],
  localTracks: sampleTracks.slice(0, 6),
  localCount: sampleTracks.length,
  playlists: [],
  sectionTitle: '示例歌曲',
  playlistTitle: '示例歌单',
  recent: sampleTracks.slice(0, 6),
  hero: sampleTracks[0],
  isPlaying: false,
  pendingPlaylist: null
}
onMounted(() => {
  applyAppearanceReferenceMasks(scene.value)
})
</script>

<template>
  <div
    ref="scene"
    class="app-shell appearance-preview-scene"
    :data-preview-navigation="navigationExpanded ? 'expanded' : 'collapsed'"
    inert
    aria-hidden="true"
  >
    <div class="appearance-window-background">
      <div class="app-background-image" />
      <div class="app-background-dim" />
    </div>
    <div class="app-shell-title" data-preview-module="material">
      <TitleBar
        preview
        :menu-open="navigationExpanded"
        :glass="false"
        :liquid-material="navigationGlass"
      />
    </div>
    <div
      v-show="navigationExpanded"
      class="app-shell-navigation navigation-temporary"
      data-preview-module="navigation"
    >
      <SideMenu
        preview
        :open="navigationExpanded"
        active-key="local-home"
        :pages="pages"
        :preview-preferences="navigationPages"
        :liquid-material="navigationGlass"
      />
    </div>
    <SidebarBookmark
      :open="navigationExpanded"
      :liquid-material="navigationGlass"
      data-preview-module="navigation"
    />
    <div class="app-shell-content" data-preview-module="background">
      <main class="main-content" :class="{ 'menu-open': navigationExpanded }">
        <OnlineHome v-bind="homePreview" />
      </main>
    </div>
    <div class="app-shell-player" data-preview-module="player-bar">
      <PlayerBar
        preview
        :mode="playerMode"
        :left-navigation-open="navigationExpanded"
        :glass="false"
        :preview-track="sampleTracks[0]"
        preview-state="idle"
        :preview-appearance="appearance"
      />
    </div>
  </div>
</template>

<style src="./appearanceReferenceMasks.css" />
