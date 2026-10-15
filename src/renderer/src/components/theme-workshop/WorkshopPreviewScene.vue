<script setup lang="ts">
import { computed, onMounted, onUpdated, ref } from 'vue'
import LocalDashboard from '../LocalDashboard.vue'
import SongList from '../SongList.vue'
import TitleBar from '../TitleBar.vue'
import SideMenu from '../SideMenu.vue'
import PlayerBar from '../PlayerBar.vue'
import ProviderMusicHome from '../streaming-page/ProviderMusicHome.vue'
import StreamingDetailStage from '../streaming-page/StreamingDetailStage.vue'
import { workshopPreviewTracks, workshopPreviewSections } from './workshopPreviewData'
import {
  applyAppearanceReferenceMasks,
  clearAppearanceReferenceMasks
} from '../appearanceReferenceMasks'
import { cloneAppearance, type AppearanceDraft } from '../../../../shared/appAppearance'
import { normalizePlayerBarSettings, type PlayerBarMode } from '../../../../shared/playerBar'
import type { PlayerBarLayoutSettings } from '../../../../shared/playerBarLayout'
import type { NavigationPagePreferences } from '../../../../shared/navigationPages'
import type { NavigationPageDefinition } from '../../app/navigationPages'
import { useSettingsStore } from '../../stores/useSettingsStore'

const props = withDefaults(
  defineProps<{
    surface: string
    state: string
    navigationExpanded?: boolean
    navigationGlass?: boolean
    playerGlass?: boolean
    playerMode?: PlayerBarMode
    playerLayout?: PlayerBarLayoutSettings
    navigationPages?: NavigationPagePreferences
    appearance?: AppearanceDraft
    pages?: NavigationPageDefinition[]
    referenceMasks?: boolean
  }>(),
  { navigationExpanded: true, referenceMasks: false }
)
const scene = ref<HTMLElement>()
const tracks = computed(() => (props.state === 'empty' ? [] : workshopPreviewTracks))
const { settings } = useSettingsStore()
const playerAppearance = computed(() => {
  if (!props.appearance && !props.playerLayout) return undefined
  const appearance = props.appearance ?? cloneAppearance(settings.value)
  return props.playerLayout
    ? {
        ...appearance,
        playerBar: normalizePlayerBarSettings({
          ...appearance.playerBar,
          layout: props.playerLayout
        })
      }
    : appearance
})
let masked = false
function syncMasks(): void {
  if (props.referenceMasks) {
    applyAppearanceReferenceMasks(scene.value)
    masked = true
  } else if (masked) {
    clearAppearanceReferenceMasks(scene.value)
    masked = false
  }
}
onMounted(syncMasks)
onUpdated(syncMasks)
defineExpose({ scene })
</script>

<template>
  <div
    ref="scene"
    class="app-shell appearance-preview-scene"
    :data-workshop-surface="surface"
    :data-workshop-state="state"
    :data-preview-navigation="navigationExpanded ? 'expanded' : 'collapsed'"
  >
    <div class="appearance-window-background" aria-hidden="true">
      <div class="app-background-image" />
      <div class="app-background-dim" />
    </div>
    <div class="app-shell-title" data-preview-module="material" inert>
      <TitleBar
        preview
        :immersive="surface === 'player'"
        :menu-open="navigationExpanded"
        :glass="false"
        :liquid-material="navigationGlass"
        :streaming="false"
        title-surface="default"
      />
    </div>
    <div
      v-show="navigationExpanded"
      class="app-shell-navigation"
      data-preview-module="navigation"
      inert
    >
      <SideMenu
        :open="navigationExpanded"
        active-key="local-home"
        :preview="appearance !== undefined"
        :pages="pages"
        :preview-preferences="navigationPages"
        :liquid-material="navigationGlass"
      />
    </div>
    <div class="app-shell-content" data-preview-module="background">
      <main
        class="main-content"
        :class="{ 'menu-open': navigationExpanded }"
        :inert="surface !== 'settings'"
        style="height: 100%; min-height: 0; overflow: auto"
        :data-workshop-state="state"
      >
        <SongList
          v-if="surface === 'library'"
          category="allSongs"
          :filter="null"
          :has-player="true"
          transition-name="page-down"
          :preview-tracks="tracks"
          :data-workshop-state="state"
        />
        <div
          v-else-if="surface === 'streaming' || surface === 'streaming-list'"
          class="streaming-page"
        >
          <div class="streaming-content" :data-workshop-state="state">
            <ProviderMusicHome
              v-if="surface === 'streaming'"
              class="home-view"
              provider-label="主题预览"
              :is-logged-in="true"
              :recs-loading="state === 'loading'"
              recs-error=""
              :rec-sections="state === 'empty' ? [] : workshopPreviewSections"
              :recommend-playlists="[]"
            />
            <StreamingDetailStage
              v-else
              kind="playlist"
              title="主题预览歌单"
              track-count-label="48 首"
              :tracks="tracks"
              :loading="state === 'loading'"
              :is-selected="(id) => state === 'selected' && id === 'workshop-preview:1'"
              :is-track-liked="() => false"
              :is-liking="() => false"
              :format-time="
                (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
              "
            />
          </div>
        </div>
        <section
          v-else-if="surface === 'settings'"
          class="settings-preview-page settings-page"
          :data-workshop-state="state"
        >
          <div class="settings-section">
            <h2>外观与控件预览</h2>
            <label>输入框<input value="我的主题" /></label
            ><label>开关<input type="checkbox" checked /></label
            ><label>滑块<input type="range" value="65" /></label
            ><button class="primary-button">主要按钮</button><button>普通按钮</button
            ><button disabled>禁用按钮</button
            ><select>
              <option>下拉菜单</option>
            </select>
          </div>
        </section>
        <section v-else-if="surface === 'player'" class="settings-preview-page">
          <h2>播放栏与歌曲信息</h2>
          <p>检查封面、标题、进度和播放按钮。画布不会操作真实播放。</p>
        </section>
        <LocalDashboard v-else :preview-tracks="tracks" :data-workshop-state="state" />
      </main>
    </div>
    <div class="app-shell-player" data-preview-module="player-bar" inert>
      <PlayerBar
        :glass="false"
        :liquid-material="playerGlass"
        :mode="playerMode"
        :menu-open="navigationExpanded"
        :left-navigation-open="navigationExpanded"
        preview
        :preview-track="workshopPreviewTracks[0]"
        :preview-state="state"
        :preview-appearance="playerAppearance"
        :data-workshop-state="state"
      />
    </div>
  </div>
</template>

<style src="../appearanceReferenceMasks.css" />
<style scoped>
.appearance-window-background {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}
</style>
