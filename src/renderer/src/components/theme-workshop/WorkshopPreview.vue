<script setup lang="ts">
import { workshopRuntimeAttributes, type WorkshopProject } from '../../../../shared/themeWorkshop'
import {
  themeTokensToCssVariables,
  TWILIGHT_DEFAULT_THEME,
  THEME_MANAGED_DATA_ATTRIBUTES
} from '../../../../shared/theme'
import { mountWorkshopDecorations } from '@renderer/components/theme-workshop/workshopDecorations'
import { computed, ref, shallowRef, watch, nextTick, onBeforeUnmount } from 'vue'
import LocalDashboard from '@renderer/components/LocalDashboard.vue'
import SongList from '@renderer/components/SongList.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import PlayerBar from '@renderer/components/PlayerBar.vue'
import ProviderMusicHome from '@renderer/components/streaming-page/ProviderMusicHome.vue'
import StreamingDetailStage from '@renderer/components/streaming-page/StreamingDetailStage.vue'
import {
  workshopPreviewTracks,
  workshopPreviewSections
} from '@renderer/components/theme-workshop/workshopPreviewData'

const props = defineProps<{
  project: WorkshopProject
  css: string
  tone: string
  surface: string
  width: number
  state: string
}>()
const tracks = computed(() => (props.state === 'empty' ? [] : workshopPreviewTracks))
const frame = ref<HTMLIFrameElement>()
const target = shallowRef<HTMLElement>()
let sheet: HTMLStyleElement | undefined
let cleanupDecorations: (() => void) | undefined
let observer: MutationObserver | undefined

function syncStyles(): void {
  const doc = frame.value?.contentDocument
  if (!doc) return
  doc.querySelectorAll('[data-workshop-host-style]').forEach((node) => node.remove())
  for (const source of document.querySelectorAll('style,link[rel="stylesheet"]')) {
    if (source.id === 'workshop-trial' || source.id === 'twilight-theme-runtime') continue
    const copy = source.cloneNode(true) as HTMLElement
    copy.dataset.workshopHostStyle = ''
    doc.head.insertBefore(copy, sheet ?? null)
  }
}

async function ready(): Promise<void> {
  const doc = frame.value?.contentDocument
  if (!doc) return
  sheet = doc.createElement('style')
  doc.head.append(sheet)
  syncStyles()
  target.value = doc.body
  update()
  observer?.disconnect()
  observer = new MutationObserver(syncStyles)
  observer.observe(document.head, { childList: true })
  await nextTick()
  cleanupDecorations?.()
  cleanupDecorations = mountWorkshopDecorations(doc)
}

function update(): void {
  const doc = frame.value?.contentDocument
  if (!doc || !sheet) return
  doc.documentElement.dataset.theme = props.tone
  const tone = props.tone === 'dark' ? 'dark' : 'pureWhite'
  for (const key of THEME_MANAGED_DATA_ATTRIBUTES) doc.documentElement.removeAttribute(key)
  for (const [key, value] of Object.entries(workshopRuntimeAttributes(props.project)))
    doc.documentElement.setAttribute(key, value)
  const vars = themeTokensToCssVariables(TWILIGHT_DEFAULT_THEME.variants[tone].tokens)
  sheet.textContent =
    'html{' +
    Object.entries(vars)
      .map(([key, value]) => key + ':' + value)
      .join(';') +
    '}\n' +
    props.css
}
watch(() => [props.css, props.tone, props.project], update)
onBeforeUnmount(() => {
  observer?.disconnect()
  cleanupDecorations?.()
})
</script>

<template>
  <div class="workshop-frame-scroll">
    <iframe
      ref="frame"
      title="主题隔离预览"
      sandbox="allow-same-origin"
      src="about:blank"
      :style="{ width: `${width}px`, height: '760px', border: '0' }"
      @load="ready"
    />
    <Teleport v-if="target" :to="target">
      <div class="app-shell" inert :data-workshop-state="state">
        <div class="app-shell-title">
          <TitleBar
            :menu-open="true"
            :glass="false"
            :streaming="false"
            :hide-start="false"
            title-surface="default"
          />
        </div>
        <div class="app-shell-navigation"><SideMenu :open="true" active-key="dashboard" /></div>
        <div class="app-shell-content">
          <main class="main-content menu-open" style="height: 680px; overflow: auto">
            <SongList
              v-if="surface === 'library'"
              category="allSongs"
              :filter="null"
              :has-player="true"
              transition-name="page-down"
              :preview-tracks="tracks"
            />
            <div
              v-else-if="surface === 'streaming' || surface === 'streaming-list'"
              class="streaming-page"
            >
              <div class="streaming-content">
                <ProviderMusicHome
                  class="home-view"
                  v-if="surface === 'streaming'"
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
                    (seconds) =>
                      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                  "
                />
              </div>
            </div>
            <section v-else-if="surface === 'settings'" class="settings-preview-page settings-page">
              <div class="settings-section">
                <h2>外观与控件预览</h2>
                <label>输入框<input value="我的主题" /></label
                ><label>开关<input type="checkbox" checked /></label
                ><label>滑块<input type="range" value="65" /></label
                ><button class="primary-button">主要按钮</button><button>普通按钮</button
                ><select>
                  <option>下拉菜单</option>
                </select>
              </div>
            </section>
            <LocalDashboard v-else :preview-tracks="tracks" />
          </main>
        </div>
        <div class="app-shell-player">
          <PlayerBar
            :glass="false"
            :menu-open="true"
            preview
            :preview-track="workshopPreviewTracks[0]"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.workshop-frame-scroll {
  overflow: auto;
  height: 100%;
  background: var(--te-app-bg);
}
</style>
