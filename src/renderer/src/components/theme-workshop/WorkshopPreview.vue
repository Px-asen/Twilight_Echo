<script setup lang="ts">
import { workshopRuntimeAttributes, type WorkshopProject } from '../../../../shared/themeWorkshop'
import {
  themeTokensToCssVariables,
  TWILIGHT_DEFAULT_THEME,
  THEME_MANAGED_DATA_ATTRIBUTES
} from '../../../../shared/theme'
import { mountWorkshopDecorations } from '@renderer/components/theme-workshop/workshopDecorations'
import { computed, ref, shallowRef, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import WorkshopCanvasOverlay from '@renderer/components/theme-workshop/WorkshopCanvasOverlay.vue'
import {
  workshopCanvasBoxes,
  type WorkshopCanvasBox
} from '@renderer/components/theme-workshop/workshopCanvas'
import { inspectWorkshopPreview } from '@renderer/components/theme-workshop/workshopPreviewDiagnostics'
import type { WorkshopSurface, WorkshopLayer } from '../../../../shared/themeWorkshopLayers.ts'
import type { WorkshopDiagnostic } from '../../../../shared/themeWorkshopDiagnostics.ts'
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
  selected?: string
  canvasEditing?: boolean
  zoom?: number
}>()
const emit = defineEmits<{
  select: [id: string, surface: WorkshopSurface]
  region: [group: string]
  edit: [id: string, surface: WorkshopSurface, patch: Partial<WorkshopLayer>]
  gesture: [action: 'begin' | 'end' | 'cancel']
}>()
const tracks = computed(() => (props.state === 'empty' ? [] : workshopPreviewTracks))
const frame = ref<HTMLIFrameElement>()
const target = shallowRef<HTMLElement>()
let sheet: HTMLStyleElement | undefined
let cleanupDecorations: (() => void) | undefined
let observer: MutationObserver | undefined
let resizeObserver: ResizeObserver | undefined
let boxFrame = 0
const boxes = shallowRef<WorkshopCanvasBox[]>([])
const height = 760
const zoom = computed(() => props.zoom ?? 1)
function refreshBoxes(): void {
  cancelAnimationFrame(boxFrame)
  boxFrame = requestAnimationFrame(() => {
    const doc = frame.value?.contentDocument
    if (doc)
      boxes.value = workshopCanvasBoxes(
        doc,
        props.project,
        props.tone === 'dark' ? 'dark' : 'pureWhite'
      )
  })
}
function region(x: number, y: number): void {
  const doc = frame.value?.contentDocument
  if (!doc) return
  for (const [selector, group] of [
    ['.app-shell-player', '播放栏'],
    ['.app-shell-navigation', '导航'],
    ['.settings-preview-page', '配色'],
    ['.song-list', '列表'],
    ['.app-shell-content', '卡片']
  ] as const) {
    const rect = doc.querySelector(selector)?.getBoundingClientRect()
    if (
      rect &&
      rect.width &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    ) {
      emit('region', group)
      return
    }
  }
  emit('region', '背景')
}
async function inspect(): Promise<WorkshopDiagnostic[]> {
  await nextTick()
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
  refreshBoxes()
  const doc = frame.value?.contentDocument
  return doc ? inspectWorkshopPreview(doc) : []
}
function highlight(selector: string): void {
  const target = frame.value?.contentDocument?.querySelector<HTMLElement>(selector)
  if (!target) return
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const original = target.style.outline
  target.style.outline = '2px solid #087f79'
  setTimeout(() => {
    target.style.outline = original
  }, 1500)
}
defineExpose({ inspect, highlight })

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
  if (sheet?.ownerDocument === doc && target.value === doc.body) return
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
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(refreshBoxes)
  resizeObserver.observe(doc.body)
  doc.addEventListener('scroll', refreshBoxes, { capture: true })
  refreshBoxes()
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
  refreshBoxes()
}
watch(
  () => [props.css, props.tone, props.project, props.state, props.surface, props.width],
  async () => {
    update()
    await nextTick()
    refreshBoxes()
  }
)
onMounted(() => {
  if (!target.value) void ready()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  cleanupDecorations?.()
  resizeObserver?.disconnect()
  cancelAnimationFrame(boxFrame)
  frame.value?.contentDocument?.removeEventListener('scroll', refreshBoxes, true)
})
</script>

<template>
  <div class="workshop-frame-scroll">
    <div
      :style="{ width: width * zoom + 'px', height: height * zoom + 'px', position: 'relative' }"
    >
      <div
        :style="{
          width: width + 'px',
          height: height + 'px',
          transform: `scale(${zoom})`,
          transformOrigin: 'top left'
        }"
      >
        <iframe
          ref="frame"
          title="主题隔离预览"
          sandbox="allow-same-origin"
          src="about:blank"
          :style="{ width: `${width}px`, height: '760px', border: '0' }"
          @load="ready"
        />
        <WorkshopCanvasOverlay
          :boxes="boxes"
          :project="project"
          :tone="tone === 'dark' ? 'dark' : 'pureWhite'"
          :width="width"
          :height="height"
          :selected="selected ?? ''"
          :enabled="canvasEditing ?? true"
          @select="(id, region) => emit('select', id, region)"
          @region="region"
          @edit="(id, region, patch) => emit('edit', id, region, patch)"
          @gesture="emit('gesture', $event)"
        />
      </div>
    </div>
    <Teleport v-if="target" :to="target">
      <div class="app-shell" :data-workshop-state="state">
        <div class="app-shell-title" inert>
          <TitleBar
            preview
            :immersive="surface === 'player'"
            :menu-open="true"
            :glass="false"
            :streaming="false"
            title-surface="default"
          />
        </div>
        <div class="app-shell-navigation" inert>
          <SideMenu :open="true" active-key="local-home" />
        </div>
        <div class="app-shell-content">
          <main
            class="main-content menu-open"
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
        <div class="app-shell-player" inert>
          <PlayerBar
            :glass="false"
            :menu-open="true"
            preview
            :preview-track="workshopPreviewTracks[0]"
            :preview-state="state"
            :data-workshop-state="state"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.workshop-frame-scroll {
  overflow: auto;
  flex: 1;
  min-height: 0;
  background: var(--te-app-bg);
}
</style>
