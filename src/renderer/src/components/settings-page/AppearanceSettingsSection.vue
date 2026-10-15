<script setup lang="ts">
import { computed, onMounted, ref, nextTick, watch } from 'vue'
import { useEscapeToClose, useFocusTrap } from '../../app/useDismissLayer'
import { useLyricsFontPicker } from '@renderer/composables/useLyricsFontPicker'
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
  type BooleanSettingKey,
  type SettingsSearchEntry
} from './types.ts'
import { normalizeAppFontFamily } from '../../../../shared/appFont.ts'
import type { AppSettings, UiDensity } from '../../types/settings'
import type { AppearanceHistoryActions } from '../appearanceEditor'
import type { NavigationPageDefinition } from '../../app/navigationPages'

const emit = defineEmits<{
  openThemeStudio: []
  openThemeWorkshop: []
  focusSetting: [id: 'global-font' | 'player-bar' | 'appearance-theme' | 'appearance-surfaces']
  draftChange: [dirty: boolean]
  editTheme: [region: string]
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

const { settings, updateSettings } = useSettingsStore()
const sectionRef = ref<HTMLElement>()
const activePanel = ref('none')
function selectWorkspace(part: string): void {
  activePanel.value = 'none'
  emit('workspaceSelected', part)
}
watch(
  () => props.inlinePanel,
  (value) => {
    if (value !== undefined) activePanel.value = value || 'none'
  },
  { immediate: true }
)
const drawerRef = ref<HTMLElement | null>(null)
useEscapeToClose(
  () => props.active && props.inlinePanel === undefined && activePanel.value !== 'none',
  () => {
    activePanel.value = 'none'
  }
)
useFocusTrap(
  drawerRef,
  () => props.active && props.inlinePanel === undefined && activePanel.value !== 'none'
)
async function reveal(entry: SettingsSearchEntry): Promise<void> {
  if (entry.appearanceArea) activePanel.value = 'none'
  else {
    const element =
      (entry.id
        ? sectionRef.value?.querySelector(`[data-setting-id="${CSS.escape(entry.id)}"]`)
        : null) ??
      (entry.fallbackId
        ? sectionRef.value?.querySelector(`[data-setting-id="${CSS.escape(entry.fallbackId)}"]`)
        : null) ??
      (entry.disclosureId
        ? sectionRef.value?.querySelector(`#${CSS.escape(entry.disclosureId)}`)
        : null)
    const panel = element?.closest(
      '#appearance-theme, #appearance-surfaces, #appearance-typography, #player-bar, #mini-player'
    )
    activePanel.value =
      panel?.id === 'appearance-typography'
        ? 'global-font'
        : panel?.id === 'mini-player'
          ? 'player-bar'
          : (panel?.id ?? '')
  }
  await nextTick()
}
const backgroundEditor = ref<InstanceType<typeof BackgroundAppearanceCustomizer>>()
defineExpose({
  reveal,
  prepareLeave: () => backgroundEditor.value?.prepareLeave() ?? true,
  apply: () => backgroundEditor.value?.apply() ?? true,
  cancel: () => backgroundEditor.value?.cancel(),
  resetView: () => backgroundEditor.value?.resetView(),
  preview: computed(() => backgroundEditor.value?.preview),
  previewPart: computed(() => backgroundEditor.value?.previewPart ?? 'overview'),
  previewBusy: computed(() => backgroundEditor.value?.previewBusy ?? false),
  collapse: async () => {
    if (activePanel.value !== 'none') {
      activePanel.value = 'none'
      return true
    }
    return backgroundEditor.value?.collapse() ?? false
  },
  setTone: (value: 'pureWhite' | 'dark') => backgroundEditor.value?.setTone(value),
  reset: () => backgroundEditor.value?.reset(),
  hasChanges: computed(() => backgroundEditor.value?.hasChanges ?? false),
  previewDraft: computed(() => backgroundEditor.value?.previewDraft)
})
const { installed, load: loadFonts } = useLyricsFontPicker()
onMounted(loadFonts)

function setFontFamily(event: Event): void {
  const fontFamily = normalizeAppFontFamily((event.target as HTMLSelectElement).value)
  if (settings.value.fontFamily === fontFamily) return
  void updateSettings({ fontFamily })
}

function setUiDensity(density: UiDensity): void {
  if (settings.value.uiDensity === density) return
  void updateSettings({ uiDensity: density })
}

function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>)
}
</script>

<template>
  <section
    ref="sectionRef"
    id="appearance-details"
    class="appearance-settings-section preview-section"
    :class="{ 'appearance-settings-section--inline': inlinePanel !== undefined }"
  >
    <div class="section-title-row">
      <i class="pi pi-palette"></i>
      <h2>外观</h2>
    </div>

    <p class="settings-section-description">从背景开始，搭配主题、文字与播放器。</p>
    <BackgroundAppearanceCustomizer
      :pages="pages"
      ref="backgroundEditor"
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
      @focus-setting="activePanel = $event"
      @workspace-selected="selectWorkspace"
      @draft-change="emit('draftChange', $event)"
      @edit-theme="emit('editTheme', $event)"
      @tone-change="emit('toneChange', $event)"
    />
    <div
      v-if="inlinePanel === undefined"
      v-show="activePanel !== 'none'"
      class="appearance-details-shield"
      @click="activePanel = 'none'"
      aria-hidden="true"
    />
    <aside
      v-show="activePanel !== 'none'"
      ref="drawerRef"
      class="appearance-details-drawer"
      :role="inlinePanel === undefined ? 'dialog' : 'region'"
      aria-label="详细外观设置"
      :aria-modal="inlinePanel === undefined ? true : undefined"
      tabindex="-1"
    >
      <header v-if="inlinePanel === undefined">
        <strong>详细设置</strong
        ><button type="button" aria-label="关闭详细设置" @click="activePanel = 'none'">
          <i class="pi pi-times" aria-hidden="true" />
        </button>
      </header>
      <div class="appearance-details-body">
        <div
          v-show="activePanel === 'appearance-theme'"
          id="appearance-theme"
          class="section-block"
        >
          <h3>主题与配色</h3>
          <div class="setting-list">
            <ThemeControlsSettings
              :integrated="integrated"
              @open-theme-studio="emit('openThemeStudio')"
              @open-theme-workshop="emit('openThemeWorkshop')"
            />
          </div>
        </div>
        <div
          v-show="activePanel === 'appearance-surfaces'"
          id="appearance-surfaces"
          class="section-block"
        >
          <h3>背景与材质</h3>
          <div class="setting-list">
            <div data-setting-id="cover-theme" id="setting-cover-theme" class="setting-item">
              <div class="setting-copy">
                <strong>封面主题色</strong>
                <span>播放页和底栏使用当前专辑封面提取的主题色。</span>
              </div>
              <button
                type="button"
                aria-label="封面主题色"
                class="toggle-switch"
                :class="{ active: settings.useCoverTheme, inactive: !settings.useCoverTheme }"
                role="switch"
                :aria-checked="settings.useCoverTheme"
                @click="toggleSetting('useCoverTheme')"
              ></button>
            </div>
            <WindowTransparencySettings />
          </div>
        </div>
        <div
          v-show="activePanel === 'global-font'"
          id="appearance-typography"
          class="section-block"
        >
          <h3>文字与排版</h3>
          <div class="setting-list">
            <div data-setting-id="global-font" id="setting-global-font" class="setting-item">
              <div class="setting-copy">
                <strong>界面字体</strong>
                <span>更换界面的正文、标题与圆体字体；“默认”跟随当前主题自带的字体。</span>
              </div>
              <select
                class="preview-select wide"
                :value="settings.fontFamily"
                @change="setFontFamily"
              >
                <option
                  v-for="option in fontFamilyOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
                <optgroup label="系统已安装字体">
                  <option v-for="family in installed" :key="family" :value="`local:${family}`">
                    {{ family }}
                  </option>
                </optgroup>
              </select>
            </div>
            <hr />
            <FontRenderingSettings />
            <hr />
            <div data-setting-id="ui-density" id="setting-ui-density" class="setting-item">
              <div class="setting-copy">
                <strong>界面密度</strong>
                <span>控制列表项的间距与信息密度。</span>
              </div>
              <div class="segmented-control density">
                <button
                  v-for="option in uiDensityOptions"
                  :key="option.value"
                  type="button"
                  :class="{ active: settings.uiDensity === option.value }"
                  @click="setUiDensity(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <SettingsGroup
          v-show="activePanel === 'player-bar'"
          id="player-bar"
          title="播放条"
          :summary="
            '形态：' +
            { standard: '标准', mini: '迷你', compact: '紧凑' }[settings.playerBar.mode] +
            ' · ' +
            { visible: '常显', autoHide: '自动隐藏', hidden: '完全隐藏' }[
              settings.playerBar.visibility
            ]
          "
          initially-open
        >
          <div class="setting-list">
            <PlayerBarSettings />
            <div
              data-setting-id="compact-visualizer"
              id="setting-compact-visualizer"
              class="setting-item"
            >
              <div class="setting-copy">
                <strong>歌词页底部动态频谱</strong
                ><span>显示播放条上的动态频谱；关闭时停止频谱数据轮询。</span>
              </div>
              <button
                type="button"
                class="toggle-switch"
                role="switch"
                aria-label="歌词页底部动态频谱"
                :aria-checked="settings.playerBar.compactVisualizerEnabled"
                :class="{ active: settings.playerBar.compactVisualizerEnabled }"
                @click="
                  updateSettings({
                    playerBar: {
                      ...settings.playerBar,
                      compactVisualizerEnabled: !settings.playerBar.compactVisualizerEnabled
                    }
                  })
                "
              />
            </div>
            <PlayerBarLayoutSettings />
          </div>
        </SettingsGroup>
        <MiniPlayerSettingsSection v-show="activePanel === 'player-bar'" />
      </div>
    </aside>
  </section>
</template>
<style scoped>
.appearance-settings-section {
  height: 100%;
  min-height: 0;
}
.appearance-details-shield {
  position: fixed;
  inset: var(--te-titlebar-inset, 40px) 0 0;
  z-index: 2149;
  background: #00000014;
}
.appearance-details-drawer {
  position: fixed;
  inset: calc(var(--te-titlebar-inset, 40px) + 16px) 20px 20px auto;
  z-index: 2150;
  width: min(540px, calc(100vw - 40px));
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--te-settings-backplate);
  border: 1px solid color-mix(in srgb, var(--te-settings-text) 10%, transparent);
  border-radius: 18px;
  box-shadow: 0 16px 50px #0004;
}
.appearance-details-drawer > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  flex-shrink: 0;
  font-size: var(--te-type-caption);
}
.appearance-details-drawer > header button {
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  width: 32px;
  height: 32px;
  cursor: pointer;
}
.appearance-details-body {
  overflow: auto;
  scrollbar-width: none;
  min-height: 0;
  padding: 0 20px 20px;
}
.appearance-details-body::-webkit-scrollbar {
  display: none;
}
.appearance-details-body :deep(.section-block) {
  margin-top: 0;
  padding-top: 0;
}
.appearance-settings-section--inline {
  height: auto;
}
.appearance-settings-section--inline > .section-title-row,
.appearance-settings-section--inline > .settings-section-description {
  display: none;
}
.appearance-settings-section--inline .appearance-details-drawer {
  position: static;
  width: 100%;
  box-shadow: none;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.appearance-settings-section--inline .appearance-details-body {
  padding: 0;
  overflow: visible;
}
.appearance-settings-section--inline :deep(.appearance-editor-backdrop--controls),
.appearance-settings-section--inline :deep(.appearance-editor--embedded),
.appearance-settings-section--inline :deep(.appearance-editor-layout),
.appearance-settings-section--inline :deep(.appearance-editor-controls) {
  position: static;
  display: block;
  width: 100%;
  height: auto;
  min-height: 0;
  max-height: none;
  overflow: visible;
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}
</style>
