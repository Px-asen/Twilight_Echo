<script setup lang="ts">
import { computed, onMounted, ref, nextTick, watch } from 'vue'
import { useLyricsFontPicker } from '@renderer/composables/useLyricsFontPicker'
import AppearancePopover from '../AppearancePopover.vue'
import CardAppearanceSettings from './CardAppearanceSettings.vue'
import LiquidGlassSettings from './LiquidGlassSettings.vue'
import ExperienceSettings from './ExperienceSettings.vue'
import {
  cloneAppearance,
  type AppearanceDraft,
  type AppearancePreset
} from '../../../../shared/appAppearance'
import {
  appearanceSettingsTarget,
  type AppearanceSettingsPanel
} from '../appearanceSettingsTargets'
import type { AppearancePart } from '../appearanceParts'
import type { ThemeStudioDomain } from '../theme-studio/useThemeStudioEditor'
import MiniPlayerSettingsSection from './MiniPlayerSettingsSection.vue'
import ThemeControlsSettings from './ThemeControlsSettings.vue'
import BackgroundAppearanceCustomizer from '../BackgroundAppearanceCustomizer.vue'
import FontRenderingSettings from './FontRenderingSettings.vue'
import WindowTransparencySettings from './WindowTransparencySettings.vue'
import SettingsGroup from './SettingsGroup.vue'
import PlayerBarSettings from './PlayerBarSettings.vue'
import PlayerBarLayoutSettings from './PlayerBarLayoutSettings.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  fontFamilyOptions,
  uiDensityOptions,
  motionPreferenceOptions,
  type BooleanSettingKey,
  type SettingsSearchEntry
} from './types.ts'
import { normalizeAppFontFamily } from '../../../../shared/appFont.ts'
import { DEFAULT_NOW_PLAYING_FLUID_SETTINGS } from '../../../../shared/appSettings.ts'
import type { AppSettings, UiDensity } from '../../types/settings'
import type { AppearanceHistoryActions } from '../appearanceEditor'
import type { NavigationPageDefinition } from '../../app/navigationPages'

const emit = defineEmits<{
  draftChange: [dirty: boolean]
  editTheme: [region: string, domain?: ThemeStudioDomain]
  toneChange: [tone: 'pureWhite' | 'dark']
  workspaceSelected: [part: string]
}>()
const props = withDefaults(
  defineProps<{
    active?: boolean
    integrated?: boolean
    inlinePanel?: string
    tone?: 'pureWhite' | 'dark'
    externalToolbar?: boolean
    compactToolbar?: boolean
    themeTools?: boolean
    themeDirty?: boolean
    characterEditor?: boolean
    commitBusy?: boolean
    themePanelOpen?: boolean
    themeHistory?: AppearanceHistoryActions
    commit?: () => Promise<void>
    discard?: () => Promise<void>
    pages?: NavigationPageDefinition[]
  }>(),
  {
    active: true,
    externalToolbar: false
  }
)

const { settings, updateSettings, lastSettingsError: settingsError } = useSettingsStore()
const sectionRef = ref<HTMLElement>()
const panelRef = ref<HTMLElement>()
const activePanel = ref<AppearanceSettingsPanel | 'none'>('none')
const panelAnchor = ref<HTMLElement | null>(null)
const panelTheme = ref<Record<string, string>>({})
const backgroundEditor = ref<InstanceType<typeof BackgroundAppearanceCustomizer>>()
const draft = computed({
  get: () => backgroundEditor.value?.previewDraft ?? cloneAppearance(settings.value),
  set: (value: AppearanceDraft) => backgroundEditor.value?.replaceDraft(value)
})
const playerBar = computed({
  get: () => draft.value.playerBar ?? settings.value.playerBar,
  set: (value) => {
    draft.value = { ...draft.value, playerBar: value }
  }
})
const colorMode = computed({
  get: () => backgroundEditor.value?.colorMode ?? settings.value.theme,
  set: (value) => backgroundEditor.value?.setColorMode(value)
})
const previewTone = computed(() => (props.tone === 'dark' ? 'dark' : 'light'))
const panelLabels: Record<AppearanceSettingsPanel, string> = {
  'appearance-theme': '配色',
  'appearance-surfaces': '全局材质',
  'global-font': '文字',
  'player-bar': '播放栏',
  'player-page': '播放页',
  'outer-panel': '外框',
  controls: '控件',
  navigation: '侧边栏',
  material: '标题栏',
  card: '卡片',
  general: '其他外观设置'
}
const themeLinks = computed<{ label: string; domain: ThemeStudioDomain; part?: AppearancePart }[]>(
  () => {
    switch (activePanel.value) {
      case 'global-font':
        return [{ label: '主题字体、字号与歌词样式', domain: 'typography' }]
      case 'appearance-theme':
        return [{ label: '主题配色、背景与自动明暗切换', domain: 'personalization' }]
      case 'navigation':
        return [{ label: '图标、侧栏样式与标志', domain: 'navigation' }]
      case 'material':
        return [
          { label: '标题栏图标', domain: 'navigation' },
          { label: '窗口按钮配色', domain: 'shell' }
        ]
      case 'player-bar':
        return [
          { label: '播放页、封面与均衡器外观', domain: 'player' },
          { label: '小窗与桌面歌词主题默认值', domain: 'windows' }
        ]
      case 'player-page':
        return [{ label: '播放页布局、背景、封面与歌词外观', domain: 'player', part: 'player-page' }]
      case 'card':
        return [{ label: '歌曲列表间距、选中样式与标题底色', domain: 'library' }]
      case 'controls':
        return [
          { label: '控件与设置页配色', domain: 'shell' },
          { label: '其他外观参数', domain: 'advanced' }
        ]
      case 'outer-panel':
        return [{ label: '窗口与设置页配色', domain: 'shell' }]
      default:
        return [
          { label: '动画节奏', domain: 'motion' },
          { label: '小窗与桌面歌词主题默认值', domain: 'windows', part: 'player-bar' },
          { label: '主题名称与历史版本', domain: 'presets', part: 'appearance-theme' },
          { label: '其他外观参数', domain: 'advanced', part: 'controls' }
        ]
    }
  }
)
function selectWorkspace(part: string): void {
  activePanel.value = 'none'
  emit('workspaceSelected', part)
}
function closePanel(): void {
  activePanel.value = 'none'
}
async function showPanel(panel: AppearanceSettingsPanel): Promise<void> {
  if (backgroundEditor.value?.previewBusy || props.commitBusy) return
  const part: AppearancePart =
    panel === 'general' ? 'overview' : panel === 'appearance-surfaces' ? 'controls' : panel
  backgroundEditor.value?.focusPart(part)
  const style = sectionRef.value && getComputedStyle(sectionRef.value)
  if (style)
    panelTheme.value = Object.fromEntries(
      [
        '--appearance-edit-menu',
        '--appearance-edit-text',
        '--appearance-edit-muted',
        '--appearance-edit-field',
        '--appearance-edit-line',
        '--appearance-edit-hover',
        '--te-font-sans',
        '--te-font-size-body'
      ].map((key) => [key, style.getPropertyValue(key)])
    )
  panelAnchor.value =
    sectionRef.value?.querySelector<HTMLElement>(`[data-part="${part}"]`) ??
    sectionRef.value ??
    null
  activePanel.value = panel
  await nextTick()
}
watch(
  () => props.inlinePanel,
  (value) => {
    if (value !== undefined)
      activePanel.value = (value || 'none') as AppearanceSettingsPanel | 'none'
  },
  { immediate: true }
)
watch(
  () => props.active,
  (active) => {
    if (!active) closePanel()
  }
)
async function reveal(entry: SettingsSearchEntry): Promise<void> {
  const destination = appearanceSettingsTarget(entry)
  if (destination.panel) await showPanel(destination.panel)
  else if (destination.area) backgroundEditor.value?.revealArea(destination.area, destination.part)
  await nextTick()
}
function findSetting(entry: SettingsSearchEntry): HTMLElement | undefined {
  const root = activePanel.value === 'none' ? sectionRef.value : panelRef.value
  if (!root) return
  const destination = appearanceSettingsTarget(entry)
  for (const id of [
    destination.settingId,
    entry.id,
    destination.fallbackId,
    entry.fallbackId,
    entry.disclosureId
  ]) {
    if (!id) continue
    const target = root.querySelector<HTMLElement>(
      `[data-setting-id="${CSS.escape(id)}"],#${CSS.escape(id)}`
    )
    if (target && target.checkVisibility() && !target.closest('[inert]')) return target
  }
  if (entry.appearanceArea === 'background')
    return root.querySelector<HTMLElement>('#workspace-' + destination.area) ?? root
  return root
}
function editTheme(domain: ThemeStudioDomain, part?: AppearancePart): void {
  emit('editTheme', part ?? backgroundEditor.value?.previewPart ?? 'overview', domain)
}
function setFontFamily(event: Event): void {
  const fontFamily = normalizeAppFontFamily((event.target as HTMLSelectElement).value)
  if (settings.value.fontFamily !== fontFamily)
    void updateSettings({ fontFamily }).catch(() => undefined)
}
function setUiDensity(uiDensity: UiDensity): void {
  if (settings.value.uiDensity !== uiDensity)
    void updateSettings({ uiDensity }).catch(() => undefined)
}
function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>).catch(
    () => undefined
  )
}
function updateLyricsLayoutField(
  key: 'coverSize' | 'coverGap' | 'lyricsMaxWidth' | 'translationSpacing',
  event: Event
): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  void updateSettings({
    lyricsAppearance: {
      ...settings.value.lyricsAppearance,
      [key]: value
    }
  }).catch(() => undefined)
}
const effectivePlayerPageBgMode = computed<'blur' | 'fluid' | 'solid' | 'image'>(() => {
  const pageBg = backgroundEditor.value?.previewDraft?.appBackground?.pages?.player
  if (pageBg && !pageBg.inherit && pageBg.kind === 'image') return 'image'
  if (pageBg && !pageBg.inherit && pageBg.kind === 'color') return 'solid'
  return settings.value.nowPlayingBackground
})
const fluidSpeed = computed(
  () => settings.value.nowPlayingFluid?.speed ?? DEFAULT_NOW_PLAYING_FLUID_SETTINGS.speed
)
const fluidAudioReactive = computed(
  () =>
    settings.value.nowPlayingFluid?.audioReactive ??
    DEFAULT_NOW_PLAYING_FLUID_SETTINGS.audioReactive
)
function updateFluidSpeed(event: Event): void {
  const speed = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(speed)) return
  void updateSettings({
    nowPlayingFluid: {
      speed,
      audioReactive: fluidAudioReactive.value
    }
  }).catch(() => undefined)
}
function toggleFluidAudioReactive(): void {
  void updateSettings({
    nowPlayingFluid: {
      speed: fluidSpeed.value,
      audioReactive: !fluidAudioReactive.value
    }
  }).catch(() => undefined)
}
const { installed, load: loadFonts } = useLyricsFontPicker()
onMounted(loadFonts)
const customLocalFont = computed(() =>
  settings.value.fontFamily.startsWith('local:') ? settings.value.fontFamily.slice(6) : ''
)
function setCustomFontFamily(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  const fontFamily = raw ? normalizeAppFontFamily(`local:${raw}`) : 'system'
  if (settings.value.fontFamily !== fontFamily)
    void updateSettings({ fontFamily }).catch(() => undefined)
}
defineExpose({
  suspend: () => backgroundEditor.value?.suspend(),
  reveal,
  findSetting,
  showPanel,
  prepareLeave: () => backgroundEditor.value?.prepareLeave() ?? true,
  apply: () => backgroundEditor.value?.apply() ?? true,
  cancel: () => backgroundEditor.value?.cancel(),
  resetView: () => backgroundEditor.value?.resetView(),
  preview: computed(() => backgroundEditor.value?.preview),
  previewPart: computed(() => backgroundEditor.value?.previewPart ?? 'overview'),
  previewBusy: computed(() => backgroundEditor.value?.previewBusy ?? false),
  collapse: async () => {
    if (activePanel.value !== 'none') {
      closePanel()
      return true
    }
    return backgroundEditor.value?.collapse() ?? false
  },
  setTone: (value: 'pureWhite' | 'dark') => backgroundEditor.value?.setTone(value),
  reset: () => backgroundEditor.value?.reset(),
  hasChanges: computed(() => backgroundEditor.value?.hasChanges ?? false),
  previewDraft: computed(() => backgroundEditor.value?.previewDraft)
})
</script>

<template>
  <section
    ref="sectionRef"
    id="appearance-details"
    class="appearance-settings-section preview-section"
  >
    <BackgroundAppearanceCustomizer
      ref="backgroundEditor"
      :pages="pages"
      embedded
      :controls-only="inlinePanel !== undefined"
      :external-tone="tone"
      :external-toolbar="externalToolbar"
      :compact-toolbar="compactToolbar"
      :theme-tools="themeTools"
      :theme-dirty="themeDirty"
      :character-editor="characterEditor"
      :commit-busy="commitBusy"
      :theme-panel-open="themePanelOpen"
      :theme-history="themeHistory"
      :commit="commit"
      :discard="discard"
      :active="active"
      :external-panel="activePanel !== 'none'"
      @focus-setting="showPanel"
      @workspace-selected="selectWorkspace"
      @draft-change="emit('draftChange', $event)"
      @edit-theme="editTheme('personalization', $event as AppearancePart)"
      @tone-change="emit('toneChange', $event)"
    />
    <component
      :is="inlinePanel !== undefined ? 'div' : AppearancePopover"
      v-if="activePanel !== 'none'"
      v-bind="
        inlinePanel === undefined
          ? { open: active, anchor: panelAnchor, label: panelLabels[activePanel], wide: true }
          : {}
      "
      @close="closePanel"
    >
      <section
        ref="panelRef"
        class="settings-preview-page appearance-properties-panel"
        :style="panelTheme"
        data-appearance-properties
      >
        <header>
          <strong>{{ panelLabels[activePanel] }}</strong>
          <button type="button" aria-label="关闭详细设置" @click="closePanel">
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </header>
        <p v-if="settingsError" class="appearance-error" role="alert">{{ settingsError }}</p>
        <template v-if="activePanel === 'appearance-theme'">
          <ThemeControlsSettings integrated palette-only v-model:color-mode="colorMode" />
          <p class="appearance-immediate-note">
            强调色与封面取色立即生效；深浅色随“应用外观”保存。
          </p>
          <div data-setting-id="cover-theme" class="setting-item">
            <strong>封面主题色</strong>
            <button
              type="button"
              class="toggle-switch"
              role="switch"
              aria-label="封面主题色"
              :class="{ active: settings.useCoverTheme }"
              :aria-checked="settings.useCoverTheme"
              @click="toggleSetting('useCoverTheme')"
            />
          </div>
        </template>
        <template v-if="activePanel === 'global-font'">
          <p class="appearance-immediate-note">界面字体与文字渲染立即生效。</p>
          <div data-setting-id="global-font" class="setting-item">
            <strong>界面字体</strong>
            <select
              class="preview-select wide"
              aria-label="界面字体"
              :value="settings.fontFamily"
              @change="setFontFamily"
            >
              <option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
              <optgroup label="系统已安装字体">
                <option
                  v-if="customLocalFont && !installed.includes(customLocalFont)"
                  :value="`local:${customLocalFont}`"
                >
                  {{ customLocalFont }}
                </option>
                <option v-for="family in installed" :key="family" :value="`local:${family}`">
                  {{ family }}
                </option>
              </optgroup>
            </select>
          </div>
          <div data-setting-id="global-font-custom" class="setting-item">
            <strong>本机字体名称</strong>
            <input
              type="text"
              class="preview-select wide"
              aria-label="本机字体名称"
              maxlength="96"
              placeholder="例如 Microsoft YaHei UI"
              :value="customLocalFont"
              @change="setCustomFontFamily"
            />
          </div>
          <FontRenderingSettings />
        </template>
        <template v-if="activePanel === 'general'">
          <p class="appearance-immediate-note">以下选项立即保存；完整界面需重启后生效。</p>
          <div data-setting-id="ui-density" class="setting-item">
            <strong>界面密度</strong>
            <div class="segmented-control density">
              <button
                v-for="option in uiDensityOptions"
                :key="option.value"
                type="button"
                :aria-pressed="settings.uiDensity === option.value"
                :class="{ active: settings.uiDensity === option.value }"
                @click="setUiDensity(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <div data-setting-id="motion" class="setting-item">
            <strong>界面动画</strong>
            <select
              class="preview-select wide"
              aria-label="界面动画"
              :value="settings.motionPreference"
              @change="
                updateSettings({
                  motionPreference: ($event.target as HTMLSelectElement)
                    .value as AppSettings['motionPreference']
                }).catch(() => undefined)
              "
            >
              <option
                v-for="option in motionPreferenceOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </div>
          <ExperienceSettings />
        </template>
        <template v-if="activePanel === 'outer-panel'">
          <p class="appearance-immediate-note">系统窗口效果立即保存；窗口透明开关需重启后生效。</p>
          <WindowTransparencySettings />
        </template>
        <template v-if="activePanel === 'appearance-surfaces' || activePanel === 'card'">
          <div data-setting-id="global-material" class="setting-item">
            <strong>全局材质</strong>
            <select
              class="preview-select"
              aria-label="全局材质"
              :value="backgroundEditor?.activeMaterial"
              @change="
                backgroundEditor?.selectMaterial(
                  ($event.target as HTMLSelectElement).value as AppearancePreset
                )
              "
            >
              <option
                v-for="option in backgroundEditor?.materials"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </div>
          <fieldset :disabled="commitBusy || backgroundEditor?.previewBusy">
            <CardAppearanceSettings
              v-if="activePanel === 'card'"
              v-model="draft"
              :tone="previewTone"
              @update:tone="backgroundEditor?.setTone($event === 'dark' ? 'dark' : 'pureWhite')"
            />
            <SettingsGroup
              id="workspace-liquid-glass"
              title="液态玻璃细节"
              summary="高光、折射与各区域覆盖"
            >
              <LiquidGlassSettings
                v-model="draft"
                :tone="previewTone"
                @update:tone="backgroundEditor?.setTone($event === 'dark' ? 'dark' : 'pureWhite')"
              />
            </SettingsGroup>
          </fieldset>
        </template>
        <template v-if="activePanel === 'player-bar'">
          <fieldset :disabled="commitBusy || backgroundEditor?.previewBusy">
            <SettingsGroup
              id="player-bar"
              title="形态与显示"
              summary="全局、播放页与自动隐藏"
              initially-open
            >
              <PlayerBarSettings v-model="playerBar" :busy="commitBusy" />
              <div data-setting-id="compact-visualizer" class="setting-item">
                <strong>歌词页底部动态频谱</strong>
                <button
                  type="button"
                  class="toggle-switch"
                  role="switch"
                  aria-label="歌词页底部动态频谱"
                  :aria-checked="playerBar.compactVisualizerEnabled"
                  :class="{ active: playerBar.compactVisualizerEnabled }"
                  @click="
                    playerBar = {
                      ...playerBar,
                      compactVisualizerEnabled: !playerBar.compactVisualizerEnabled
                    }
                  "
                />
              </div>
            </SettingsGroup>
            <SettingsGroup
              id="player-bar-layout-details"
              title="按钮编排"
              summary="分别调整每种形态，不切换当前形态"
            >
              <PlayerBarLayoutSettings v-model="playerBar" :busy="commitBusy" />
            </SettingsGroup>
          </fieldset>
          <SettingsGroup
            id="workspace-mini-player"
            title="迷你播放器"
            summary="独立窗口的外观与布局 · 立即生效"
          >
            <MiniPlayerSettingsSection />
          </SettingsGroup>
        </template>
        <template v-if="activePanel === 'player-page'">
          <p class="appearance-immediate-note">
            播放页默认使用基于专辑封面感知色彩的流体光影背景，也可切换为模糊封面、纯色底色或自选背景图片。
          </p>
          <div data-setting-id="player-page-background" class="setting-item">
            <strong>播放页背景模式</strong>
            <select
              class="preview-select"
              aria-label="播放页背景模式"
              :value="effectivePlayerPageBgMode"
              @change="
                backgroundEditor?.setPlayerPageBackgroundMode(
                  ($event.target as HTMLSelectElement).value as 'blur' | 'fluid' | 'solid' | 'image'
                )
              "
            >
              <option value="fluid">流体光影（默认）</option>
              <option value="blur">模糊封面</option>
              <option value="solid">纯色底色</option>
              <option value="image">自选背景图片</option>
            </select>
          </div>
          <template v-if="effectivePlayerPageBgMode === 'fluid'">
            <div data-setting-id="player-page-fluid-speed" class="setting-item">
              <strong>流光速度（{{ fluidSpeed.toFixed(2) }}×）</strong>
              <input
                type="range"
                min="0.25"
                max="2.5"
                step="0.05"
                aria-label="流光速度"
                :value="fluidSpeed"
                @input="updateFluidSpeed"
              />
            </div>
            <div data-setting-id="player-page-fluid-reactive" class="setting-item">
              <strong>低频节拍律动</strong>
              <button
                type="button"
                class="toggle-switch"
                role="switch"
                aria-label="低频节拍律动"
                :aria-checked="fluidAudioReactive"
                :class="{ active: fluidAudioReactive }"
                @click="toggleFluidAudioReactive"
              />
            </div>
          </template>
          <div class="setting-item">
            <strong>播放页自选图片</strong>
            <button
              type="button"
              class="secondary-btn"
              :disabled="commitBusy || backgroundEditor?.previewBusy"
              @click="backgroundEditor?.choosePlayerBackgroundImage()"
            >
              {{
                !backgroundEditor?.previewDraft?.appBackground?.pages?.player?.inherit &&
                backgroundEditor?.previewDraft?.appBackground?.pages?.player?.kind === 'image' &&
                backgroundEditor?.previewDraft?.appBackground?.pages?.player?.image
                  ? '更换图片'
                  : '选择图片'
              }}
            </button>
          </div>
          <div class="setting-item">
            <strong>播放页封面大小（{{ settings.lyricsAppearance.coverSize }}%）</strong>
            <input
              type="range"
              min="60"
              max="100"
              step="2"
              aria-label="播放页封面大小"
              :value="settings.lyricsAppearance.coverSize"
              @input="updateLyricsLayoutField('coverSize', $event)"
            />
          </div>
          <div class="setting-item">
            <strong>封面与歌词间距（{{ settings.lyricsAppearance.coverGap }}px）</strong>
            <input
              type="range"
              min="16"
              max="96"
              step="2"
              aria-label="封面与歌词间距"
              :value="settings.lyricsAppearance.coverGap"
              @input="updateLyricsLayoutField('coverGap', $event)"
            />
          </div>
          <div class="setting-item">
            <strong>歌词区域宽度（{{ settings.lyricsAppearance.lyricsMaxWidth }}px）</strong>
            <input
              type="range"
              min="520"
              max="1120"
              step="10"
              aria-label="歌词区域宽度"
              :value="settings.lyricsAppearance.lyricsMaxWidth"
              @input="updateLyricsLayoutField('lyricsMaxWidth', $event)"
            />
          </div>
          <div class="setting-item">
            <strong>原词与译文行距（{{ settings.lyricsAppearance.translationSpacing }}px）</strong>
            <input
              type="range"
              min="2"
              max="24"
              step="1"
              aria-label="原词与译文行距"
              :value="settings.lyricsAppearance.translationSpacing"
              @input="updateLyricsLayoutField('translationSpacing', $event)"
            />
          </div>
          <div data-setting-id="compact-visualizer" class="setting-item">
            <strong>歌词页底部动态频谱</strong>
            <button
              type="button"
              class="toggle-switch"
              role="switch"
              aria-label="歌词页底部动态频谱"
              :aria-checked="playerBar.compactVisualizerEnabled"
              :class="{ active: playerBar.compactVisualizerEnabled }"
              @click="
                playerBar = {
                  ...playerBar,
                  compactVisualizerEnabled: !playerBar.compactVisualizerEnabled
                }
              "
            />
          </div>
        </template>
        <div v-if="themeLinks.length" class="appearance-theme-links">
          <button
            v-for="link in themeLinks"
            :key="link.domain"
            type="button"
            :disabled="commitBusy || backgroundEditor?.previewBusy"
            :data-theme-domain="link.domain"
            @click="editTheme(link.domain, link.part)"
          >
            {{ link.label }}<i class="pi pi-arrow-right" aria-hidden="true" />
          </button>
        </div>
      </section>
    </component>
  </section>
</template>
<style scoped>
.appearance-settings-section {
  height: 100%;
  min-height: 0;
}
.appearance-properties-panel {
  --te-type-body: calc(var(--te-font-size-body, 14px) * 15 / 14);
  --te-type-caption: calc(var(--te-font-size-body, 14px) * 13 / 14);
  --te-settings-text: var(--appearance-edit-text, #292b30);
  --te-settings-text-muted: var(--appearance-edit-muted, #6c7077);
  --te-settings-control-bg: var(--appearance-edit-field, #fff);
  --te-settings-control-border: var(--appearance-edit-line, #d7d9dd);
  --te-settings-backplate: var(--appearance-edit-menu, #f7f7f8);
  position: static;
  inset: auto;
  z-index: auto;
  width: auto;
  padding: 0;
  overflow: visible;
  color: var(--te-settings-text);
  font-size: var(--te-type-body, 14px);
}
.appearance-properties-panel > header {
  position: sticky;
  top: -16px;
  z-index: 3;
  padding: 8px 0;
  background: var(--te-material-solid, var(--te-settings-backplate));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.appearance-properties-panel > header button {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.appearance-immediate-note {
  margin: 8px 0 12px;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption, 13px);
  line-height: 1.6;
}
.appearance-properties-panel :deep(.setting-item) {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 0;
}
.appearance-properties-panel :deep(.setting-copy) {
  flex: 1 1 180px;
  min-width: 0;
}
.appearance-properties-panel :deep(select),
.appearance-properties-panel :deep(input[type='text']) {
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.appearance-properties-panel :deep(.section-block) {
  margin-top: 0;
}
.appearance-properties-panel :deep(.settings-group) {
  border: 0;
  border-top: 1px solid var(--te-settings-control-border);
  border-radius: 0;
  background: transparent;
}
.appearance-properties-panel :deep(.settings-group-trigger) {
  padding: 14px 0;
}
.appearance-properties-panel :deep(.settings-group-content) {
  padding: 0 0 12px;
  border-top: 0;
}
.appearance-properties-panel :deep(.settings-accordion-trigger.setting-item) {
  flex-direction: row;
  align-items: center;
  flex-wrap: nowrap;
}
.appearance-properties-panel :deep(.settings-accordion-trigger i) {
  border: 0;
  background: transparent;
  color: var(--te-settings-text-muted);
}
.appearance-properties-panel :deep(.range-pill) {
  max-width: 100%;
  flex-wrap: wrap;
}
.appearance-properties-panel :deep(.range-input) {
  min-width: 48px;
}
.appearance-properties-panel fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.appearance-theme-links {
  display: grid;
  gap: 4px;
  padding-top: 12px;
  margin-top: 8px;
  border-top: 1px solid var(--te-settings-control-border);
}
.appearance-theme-links button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  padding: 10px 8px;
  color: inherit;
  font: inherit;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.appearance-theme-links button:hover {
  background: var(--appearance-edit-hover, #8881);
}
@media (max-width: 600px) {
  .appearance-properties-panel :deep(.setting-item) {
    flex-direction: column;
    align-items: stretch;
  }
  .appearance-properties-panel :deep(.setting-copy) {
    flex-basis: auto;
  }
  .appearance-properties-panel :deep(.segmented-control) {
    flex-wrap: wrap;
  }
}
</style>
