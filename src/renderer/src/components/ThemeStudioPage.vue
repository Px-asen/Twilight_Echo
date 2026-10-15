<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { APPEARANCE_PARTS, resolveAppearancePart, type AppearancePart } from './appearanceParts'
import { THEME_TOKEN_DEFINITIONS } from '../../../shared/theme'
import {
  isStudioTokenEditable,
  parseStudioColor,
  studioColorValue
} from './theme-studio/themeVisualControls'
import type { AppearanceAction, AppearanceEditorState } from './appearanceEditor'
import ThemeAppearanceControl from '@renderer/components/theme-studio/ThemeAppearanceControl.vue'
import {
  useThemeStudioEditor,
  type ThemeStudioDomain
} from '@renderer/components/theme-studio/useThemeStudioEditor'
import { useBackHandlerWhileMounted } from '@renderer/app/useBackStack'
import { useEscapeToClose } from '@renderer/app/useDismissLayer'
import AppearancePopover from './AppearancePopover.vue'
import EditableRangeValue from './EditableRangeValue.vue'
import AppearanceLayerSettings from './AppearanceLayerSettings.vue'
import ThemeIconSettings, { type ThemeIconGroup } from './theme-studio/ThemeIconSettings.vue'
import { cloneAppearance } from '../../../shared/appAppearance'
import { appearanceLayerScope, normalizeAppearanceLayers } from '../../../shared/appearanceLayers'
import { useSettingsStore } from '../stores/useSettingsStore'
import SongList from '@renderer/components/SongList.vue'
import EqualizerPage from '@renderer/components/EqualizerPage.vue'
import LocalHome from '@renderer/components/local-dashboard/LocalHome.vue'
import PlayerBar from '@renderer/components/PlayerBar.vue'
import PlayingMusic from '@renderer/components/PlayingMusic.vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import TitleBar from '@renderer/components/TitleBar.vue'

const props = defineProps<{
  initialDomain?: ThemeStudioDomain
  initialKey?: string
  embedded?: boolean
  unified?: boolean
  settingsOnly?: boolean
  controlsOnly?: boolean
  contextual?: boolean
  part?: AppearancePart
  active?: boolean
}>()
const emit = defineEmits<{ back: []; domainChange: [domain: ThemeStudioDomain] }>()

const {
  BUILT_IN_THEME_FONTS,
  BUILT_IN_THEME_PRESETS,
  accentPalette,
  activeDomain,
  activeKey,
  activeModes,
  appearanceGroups: allAppearanceGroups,
  applyAccentPalette,
  applyBackgroundPalette,
  applySelected,
  assetSource,
  backgroundBindings,
  backgroundPalette,
  canRedo,
  canUndo,
  changeName,
  closeStudio: closeEditorStudio,
  prepareLeave: prepareEditorLeave,
  contrastWarnings,
  deleteSelected,
  domain,
  domains,
  draft,
  editorPaneRef,
  duplicateSelected,
  exportTheme,
  filteredStudioHits: allStudioHits,
  fontAssets,
  fontBindings,
  fontSelection,
  fontSource,
  getBuiltInThemePreset,
  getPluginThemeKey,
  historyLabel,
  imageAssets,
  iconImporting,
  importIconAsset,
  importAsset,
  importTheme,
  isDirty,
  isUnsavedDraft,
  jumpToSearchHit,
  localError,
  notice,
  persistedHistory,
  playerLayouts,
  presetPreviewStyle,
  previewCanvasStyle,
  previewNavigationOpen,
  previewSurface,
  previewSurfaces,
  previewViewportRef,
  previewViewportStyle,
  profiles,
  redo,
  removeOverride,
  resetAll,
  resetGroup: resetEditorGroup,
  resolveThemeProfileModes,
  restoreVersion,
  scheduleTime,
  selectedKey,
  selectedIconSlot,
  selectIconSlot,
  selectedPluginTheme,
  selectThemeKey,
  selectKey: selectEditorKey,
  ready,
  setPlayerLayout,
  setTone: setEditorTone,
  setIconBinding,
  sourceFor,
  tokenHint,
  tokenUnavailable,
  studioSearchQuery,
  themeContributions,
  themeStore,
  toggleWindowInheritance,
  tone,
  undo,
  updateAppearanceMode,
  updateAppearanceLayers,
  updateArtworkMode,
  updateAssetBinding,
  updateEqualizerMode,
  updateFontSlot,
  updateIconFamily,
  updateLibraryMode,
  updateNavigationMode,
  updatePlayerMode,
  updateScheduleTime,
  updateToken,
  updateTypographyMode,
  updateVisibility,
  updateWindowBoolean,
  updateWindowNumber,
  updateWindowText,
  valueFor,
  valueForId,
  visibilityOptions,
  visibilityValue,
  windowDefaultValue
} = useThemeStudioEditor({
  initialDomain: props.initialDomain,
  initialKey: props.initialKey,
  editable: props.unified,
  iconContext: () => `${props.part ?? 'appearance-theme'}:${props.active !== false}`,
  onBack: () => emit('back')
})
const toolsOpen = ref(false)
const toolsTrigger = ref<HTMLButtonElement>()
const contextBar = ref<HTMLElement>()
const popoverTheme = ref<Record<string, string>>({})
const contextualMode = computed(() => props.controlsOnly && props.contextual)
const contextPart = computed(() => props.part ?? 'appearance-theme')
const layerSettingsOpen = ref(false)
const layerImporting = ref(false)
const iconSettingsOpen = ref(false)
const iconSettingsTrigger = ref<HTMLButtonElement>()
const iconSettingsPanel = ref<HTMLElement>()
const iconGroup = computed<ThemeIconGroup>(() =>
  contextPart.value === 'player-bar'
    ? 'playback'
    : contextPart.value === 'material'
      ? 'titlebar'
      : 'navigation'
)
const contextHasIcons = computed(() =>
  ['navigation', 'material', 'player-bar'].includes(contextPart.value)
)
async function prepareLeave(): Promise<boolean> {
  return !layerImporting.value && !iconImporting.value && (await prepareEditorLeave())
}
async function closeStudio(): Promise<void> {
  if (!layerImporting.value && !iconImporting.value) await closeEditorStudio()
}
async function selectKey(key: string): Promise<void> {
  if (!layerImporting.value && !iconImporting.value) await selectEditorKey(key)
}
async function setTone(value: Parameters<typeof setEditorTone>[0]): Promise<void> {
  if (!layerImporting.value && !iconImporting.value) await setEditorTone(value)
}
function closeLayerSettings(): void {
  if (!layerImporting.value) layerSettingsOpen.value = false
}
const layerScope = computed(() => appearanceLayerScope(contextPart.value))
const layerSettingsLabel = computed(() =>
  layerScope.value === 'controls' ? '颜色与效果' : '背景皮肤'
)
const layerOnly = computed(() =>
  ['inner-panel', 'outer-panel', 'controls'].includes(contextPart.value)
)
const { settings: applicationSettings } = useSettingsStore()
const layerDraft = computed(() =>
  cloneAppearance({
    ...applicationSettings.value,
    appearanceLayers: normalizeAppearanceLayers(
      draft.value?.appearanceLayers ?? applicationSettings.value.appearanceLayers
    )
  })
)
watch(contextPart, () => {
  layerSettingsOpen.value = false
  iconSettingsOpen.value = false
})
const contextInfo = computed(
  () => APPEARANCE_PARTS.find((entry) => entry.id === resolveAppearancePart(contextPart.value))!
)
const contextTokenId = computed(() => {
  switch (contextPart.value) {
    case 'navigation':
      return 'navigation.surface'
    case 'card':
      return 'surface.card'
    case 'player-bar':
      return 'playback.control.surface'
    case 'global-font':
      return 'typography.chromeText'
    case 'appearance-theme':
      return 'color.primary.500'
    default:
      return 'surface.app'
  }
})
const contextDefinition = computed(
  () => THEME_TOKEN_DEFINITIONS.find((entry) => entry.id === contextTokenId.value)!
)
const contextColor = computed(() => parseStudioColor(valueForId(contextTokenId.value)))
const contextColorLabel = computed(() =>
  contextPart.value === 'material' ? '标题栏颜色（共享背景）' : `${contextInfo.value.label}颜色`
)
const contextAdjustment = computed(() => {
  const id =
    contextPart.value === 'background' || contextPart.value === 'material'
      ? 'background.overlayOpacity'
      : contextPart.value === 'card'
        ? 'material.cardBlur'
        : contextPart.value === 'global-font'
          ? 'typography.bodySize'
          : undefined
  if (id) {
    const definition = THEME_TOKEN_DEFINITIONS.find((entry) => entry.id === id)!
    return {
      definition,
      label:
        id === 'background.overlayOpacity'
          ? '遮罩浓度'
          : id === 'material.cardBlur'
            ? '背景模糊'
            : '正文字号',
      min: definition.min ?? 0,
      max: definition.max ?? 100,
      suffix: definition.unit ?? '',
      value: parseFloat(valueForId(id))
    }
  }
  if (['navigation', 'player-bar'].includes(contextPart.value) && contextColor.value)
    return {
      definition: contextDefinition.value,
      label: '底色不透明度',
      min: 0,
      max: 100,
      suffix: '%',
      value: contextColor.value.opacity
    }
  return undefined
})
function setContextAdjustment(value: number): void {
  const field = contextAdjustment.value
  if (!field || !draft.value || state.value.busy || tokenUnavailable(field.definition)) return
  updateToken(
    field.definition,
    field.definition.kind === 'color'
      ? studioColorValue({ hex: contextColor.value!.hex, opacity: value })
      : `${value}${field.suffix}`
  )
}
const contextCardBlur = computed(() => parseFloat(valueForId('material.cardBlur')))
function setContextCardBlur(event: Event): void {
  if (state.value.busy || !draft.value) return
  updateToken(
    THEME_TOKEN_DEFINITIONS.find((entry) => entry.id === 'material.cardBlur')!,
    `${(event.target as HTMLSelectElement).value}px`
  )
}
const appearanceGroups = computed(() =>
  allAppearanceGroups.value
    .map((group) => ({
      ...group,
      items: group.items.filter((entry) => isStudioTokenEditable(entry.id))
    }))
    .filter((group) => group.items.length)
)
const filteredStudioHits = computed(() =>
  allStudioHits.value.filter((hit) =>
    hit.kind === 'token' ? isStudioTokenEditable(hit.id) : hit.id !== 'navigation.iconScale'
  )
)
function resetGroup(): void {
  resetEditorGroup({ preserveStructure: true })
}
function setContextColor(event: Event): void {
  if (state.value.busy || !draft.value || tokenUnavailable(contextDefinition.value)) return
  const hex = (event.target as HTMLInputElement).value
  if (contextPart.value === 'appearance-theme') applyAccentPalette(hex)
  else
    updateToken(
      contextDefinition.value,
      studioColorValue({ hex, opacity: contextColor.value?.opacity ?? 100 })
    )
}
function resetContextColor(): void {
  if (!state.value.busy && draft.value) removeOverride(contextDefinition.value)
}
async function openTools(): Promise<void> {
  await nextTick()
  if (state.value.busy || props.active === false) return
  captureEditorTheme()
  iconSettingsOpen.value = false
  toolsOpen.value = true
}
function captureEditorTheme(): void {
  if (contextBar.value) {
    const style = getComputedStyle(contextBar.value)
    popoverTheme.value = Object.fromEntries(
      [
        '--te-editor-panel',
        '--te-settings-text',
        '--te-settings-text-muted',
        '--te-settings-control-bg',
        '--te-settings-control-border',
        '--te-hover-bg',
        '--te-editor-accent',
        '--te-control-focus-color',
        '--te-primary-500',
        '--te-primary-400',
        '--te-primary-rgb',
        '--te-font-sans',
        '--te-font-size-body',
        '--te-control-font-size',
        '--te-control-height-md',
        '--appearance-edit-text',
        '--appearance-edit-muted',
        '--appearance-edit-field',
        '--appearance-edit-line',
        '--appearance-edit-menu',
        '--appearance-edit-hover'
      ].map((key) => [key, style.getPropertyValue(key)])
    )
  }
}
async function openIconSettings(): Promise<void> {
  if (state.value.busy || props.active === false || !contextHasIcons.value) return
  captureEditorTheme()
  toolsOpen.value = false
  layerSettingsOpen.value = false
  iconSettingsOpen.value = true
  await nextTick()
  if (iconSettingsOpen.value)
    iconSettingsPanel.value
      ?.querySelector<HTMLSelectElement>('select')
      ?.focus({ preventScroll: true })
}
function closeIconSettings(): void {
  if (!iconImporting.value) iconSettingsOpen.value = false
}
function toggleContextTools(): void {
  if (toolsOpen.value) closeContextTools()
  else void openTools()
}
function closeContextTools(restoreFocus = false): void {
  toolsOpen.value = false
  if (restoreFocus) void nextTick(() => toolsTrigger.value?.focus({ preventScroll: true }))
}
useEscapeToClose(
  () => props.active !== false && contextualMode.value && toolsOpen.value,
  () => closeContextTools(true)
)
async function openContextMaterial(): Promise<void> {
  domain.value =
    contextPart.value === 'card'
      ? 'advanced'
      : contextPart.value === 'global-font'
        ? 'typography'
        : 'shell'
  await openTools()
}
watch(
  () => props.part,
  () => {
    toolsOpen.value = false
  }
)
watch(
  () => props.active,
  (active) => {
    if (active === false) {
      toolsOpen.value = false
      iconSettingsOpen.value = false
    }
  }
)
watch(domain, (value) => emit('domainChange', value), { flush: 'sync' })

// 标题栏返回键必须走 closeStudio：有未应用的修改时它需要弹确认，不能由
// App 层按页面旗标直接关闭，本页因此不注册 App 层基础层。
if (!props.embedded) useBackHandlerWhileMounted(() => void closeStudio())
const state = computed<AppearanceEditorState>(() => ({
  key: selectedKey.value,
  tone: tone.value,
  busy: !ready.value || themeStore.saving.value || layerImporting.value || iconImporting.value,
  canUndo: canUndo.value,
  canRedo: canRedo.value,
  canReset: !!draft.value && domain.value !== 'presets',
  canExport: !!draft.value && !isUnsavedDraft.value,
  canApply: ready.value && !iconImporting.value,
  status:
    layerImporting.value || iconImporting.value
      ? '正在导入图片'
      : themeStore.saving.value
        ? '正在保存'
        : isDirty.value
          ? '有未保存的修改'
          : '正在预览',
  dirty: isDirty.value || selectedKey.value !== activeKey.value,
  hasUnsavedChanges: isDirty.value,
  error: localError.value || themeStore.error.value
}))
async function perform(action: AppearanceAction): Promise<void> {
  if (state.value.busy) return
  switch (action) {
    case 'undo':
      undo()
      break
    case 'redo':
      redo()
      break
    case 'reset':
      resetGroup()
      break
    case 'duplicate':
      await duplicateSelected()
      break
    case 'import':
      await importTheme()
      break
    case 'export':
      await exportTheme()
      break
    case 'apply':
      await applySelected()
      break
  }
}
async function chooseTheme(key: string, customize = false): Promise<void> {
  if (selectedKey.value === key && !customize) return
  if (!(await prepareLeave())) return
  await selectKey(key)
  if (customize) await duplicateSelected()
}
async function discard(): Promise<void> {
  if (layerImporting.value || iconImporting.value) return
  const key = profiles.value.some((profile) => `profile:${profile.id}` === selectedKey.value)
    ? selectedKey.value
    : selectedKey.value.startsWith('profile:')
      ? activeKey.value
      : selectedKey.value
  await selectKey(key)
}
defineExpose({ prepareLeave, state, perform, selectKey, setTone, discard, openTools })
watch(
  () => props.initialDomain,
  (value) => {
    if (value) domain.value = value
  }
)
void previewViewportRef.value
void editorPaneRef.value
</script>

<template>
  <div
    class="theme-studio-page"
    :class="{
      'theme-studio-page--embedded': embedded,
      'theme-studio-page--controls': controlsOnly,
      'theme-studio-page--contextual': contextualMode
    }"
    data-te-surface="theme-studio"
  >
    <header v-if="!unified" class="theme-studio-header">
      <div>
        <h1 v-if="!embedded">主题工作室</h1>
        <span role="status"
          >{{ themeStore.saving.value ? '正在保存' : isDirty ? '有未保存的修改' : '正在预览' }} ·
          {{ tone === 'dark' ? '深色配色' : '浅色配色' }}</span
        >
      </div>
      <label class="theme-profile-picker">
        <span>主题</span>
        <select :value="selectedKey" aria-label="当前主题" @change="selectThemeKey">
          <optgroup label="内置主题">
            <option
              v-for="preset in BUILT_IN_THEME_PRESETS"
              :key="preset.id"
              :value="`preset:${preset.id}`"
            >
              {{ preset.name }}{{ activeKey === `preset:${preset.id}` ? ' · 已应用' : '' }}
            </option>
          </optgroup>
          <option v-if="draft && isUnsavedDraft" :value="`profile:${draft.id}`">
            {{ draft.name }} · 未保存
          </option>
          <optgroup v-if="profiles.length" label="个人主题">
            <option v-for="profile in profiles" :key="profile.id" :value="`profile:${profile.id}`">
              {{ profile.name }}{{ activeKey === `profile:${profile.id}` ? ' · 已应用' : '' }}
            </option>
          </optgroup>
          <optgroup v-if="themeContributions.length" label="插件主题">
            <option
              v-for="theme in themeContributions"
              :key="getPluginThemeKey(theme)"
              :value="`plugin:${getPluginThemeKey(theme)}`"
            >
              {{ theme.name
              }}{{ activeKey === `plugin:${getPluginThemeKey(theme)}` ? ' · 已应用' : '' }}
            </option>
          </optgroup>
        </select>
      </label>
      <div class="theme-studio-actions">
        <div class="studio-segment" aria-label="配色模式">
          <button
            type="button"
            title="浅色配色"
            aria-label="浅色配色"
            :class="{ active: tone === 'pureWhite' }"
            :aria-pressed="tone === 'pureWhite'"
            @click="setTone('pureWhite')"
          >
            <i class="ph ph-sun"></i>
          </button>
          <button
            type="button"
            title="深色配色"
            aria-label="深色配色"
            :class="{ active: tone === 'dark' }"
            :aria-pressed="tone === 'dark'"
            @click="setTone('dark')"
          >
            <i class="ph ph-moon"></i>
          </button>
        </div>
        <button
          type="button"
          class="studio-icon-button"
          title="重置本分类"
          aria-label="重置本分类"
          :disabled="!draft || domain === 'presets'"
          @click="resetGroup"
        >
          <i class="ph ph-arrow-u-up-left"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="重置整个主题"
          aria-label="重置整个主题"
          :disabled="!draft"
          @click="resetAll"
        >
          <i class="ph ph-broom"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="撤销"
          aria-label="撤销"
          :disabled="!canUndo"
          @click="undo"
        >
          <i class="ph ph-arrow-counter-clockwise"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="重做"
          aria-label="重做"
          :disabled="!canRedo"
          @click="redo"
        >
          <i class="ph ph-arrow-clockwise"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="导入主题"
          aria-label="导入主题"
          @click="importTheme"
        >
          <i class="ph ph-download-simple"></i>
        </button>
        <button
          type="button"
          class="studio-icon-button"
          title="创建副本"
          aria-label="创建副本"
          @click="duplicateSelected"
        >
          <i class="ph ph-copy"></i>
        </button>
        <button
          type="button"
          class="studio-command primary"
          :disabled="themeStore.saving.value"
          @click="applySelected"
        >
          <i :class="themeStore.saving.value ? 'pi pi-spin pi-spinner' : 'ph ph-check'"></i
          ><span>{{ draft ? '保存并应用' : '应用主题' }}</span>
        </button>
      </div>
    </header>
    <p v-if="localError || themeStore.error.value" class="studio-message error" role="alert">
      {{ localError || themeStore.error.value }}
    </p>
    <div
      v-if="contextualMode"
      ref="contextBar"
      class="studio-context-bar"
      :aria-label="`${contextInfo.label}主题属性`"
      tabindex="-1"
      @focus="toolsTrigger?.focus({ preventScroll: true })"
    >
      <fieldset v-if="!layerOnly" :disabled="state.busy || !draft" class="studio-context-colors">
        <label class="studio-context-color">
          <span>自选色</span>
          <input
            type="color"
            :aria-label="contextColorLabel"
            :title="tokenHint(contextDefinition) || contextColorLabel"
            :value="contextColor?.hex ?? '#000000'"
            :disabled="!contextColor || tokenUnavailable(contextDefinition)"
            @input="setContextColor"
          />
        </label>
      </fieldset>
      <fieldset :disabled="state.busy || !draft" class="studio-context-material">
        <template v-if="contextPart === 'background' || contextPart === 'material'">
          <label
            ><span>背景</span
            ><select
              aria-label="选中背景样式"
              :value="activeModes.appearance?.backgroundTreatment"
              @change="updateAppearanceMode('backgroundTreatment', $event)"
            >
              <option value="solid">实色</option>
              <option value="gradient">双色渐变</option>
              <option value="cover-blur">封面模糊</option>
              <option value="image">本地图片</option>
            </select></label
          >
          <template v-if="activeModes.appearance?.backgroundTreatment === 'image'">
            <select
              aria-label="主题背景图片"
              :value="draft?.assetBindings?.appBackground ?? ''"
              @change="updateAssetBinding('appBackground', $event)"
            >
              <option value="">未选择图片</option>
              <option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">
                {{ asset.path }}
              </option>
            </select>
            <button type="button" @click="importAsset('image')">选择图片</button>
          </template>
        </template>
        <label v-else-if="contextPart === 'appearance-theme'"
          ><span>来源</span
          ><select
            aria-label="主题色来源"
            :value="activeModes.appearance?.accentSource"
            @change="updateAppearanceMode('accentSource', $event)"
          >
            <option value="fixed">固定颜色</option>
            <option value="cover">当前封面</option>
          </select></label
        >
        <label v-else-if="contextPart === 'navigation'"
          ><span>导航</span
          ><select
            aria-label="选中导航样式"
            :value="activeModes.navigation?.style"
            @change="updateNavigationMode('style', $event)"
          >
            <option value="expanded">展开</option>
            <option value="compact">紧凑</option>
            <option value="rail">图标栏</option>
          </select></label
        >
        <label v-else-if="contextPart === 'player-bar'"
          ><span>按钮</span
          ><select
            aria-label="选中播放按钮样式"
            :value="activeModes.player?.controls"
            @change="updatePlayerMode('controls', $event)"
          >
            <option value="standard">标准</option>
            <option value="pro">增强</option>
          </select></label
        >
        <label v-else-if="contextPart === 'card'"
          ><span>材质</span
          ><select
            aria-label="选中卡片模糊材质"
            :value="contextCardBlur"
            @change="setContextCardBlur"
          >
            <option value="0">无模糊</option>
            <option value="20">模糊</option>
            <option v-if="contextCardBlur !== 0 && contextCardBlur !== 20" :value="contextCardBlur">
              {{ contextCardBlur }}px 模糊
            </option>
          </select></label
        >
        <button v-else type="button" @click="openContextMaterial">
          {{ contextPart === 'global-font' ? '字体参数' : '材质参数' }}
        </button>
      </fieldset>
      <button
        ref="toolsTrigger"
        type="button"
        class="studio-context-more"
        :disabled="state.busy"
        :aria-expanded="toolsOpen"
        aria-controls="studio-context-tools"
        @click="toggleContextTools"
      >
        更多<i class="ph ph-caret-down" aria-hidden="true" />
      </button>
      <button
        v-if="contextHasIcons"
        ref="iconSettingsTrigger"
        type="button"
        class="studio-context-icons"
        :disabled="state.busy || !draft"
        :aria-expanded="iconSettingsOpen"
        aria-controls="studio-context-icons"
        @click="openIconSettings"
      >
        图标
      </button>
      <AppearancePopover
        v-if="iconSettingsOpen"
        :open="iconSettingsOpen && props.active !== false"
        :anchor="iconSettingsTrigger ?? null"
        label="图标设置"
        @close="closeIconSettings"
      >
        <div
          id="studio-context-icons"
          ref="iconSettingsPanel"
          class="studio-icon-popup"
          :style="popoverTheme"
        >
          <ThemeIconSettings
            :profile="draft"
            :selection="selectedIconSlot"
            :initial-group="iconGroup"
            :busy="state.busy"
            :importing="iconImporting"
            @select="selectIconSlot"
            @import="importIconAsset"
            @bind="setIconBinding"
          />
          <p v-if="localError" class="studio-icon-error" role="alert">{{ localError }}</p>
        </div>
      </AppearancePopover>
      <button
        v-if="layerScope"
        :disabled="state.busy || !draft"
        :aria-expanded="layerSettingsOpen"
        @click="layerSettingsOpen = !layerSettingsOpen"
      >
        {{ layerSettingsLabel }}
      </button>
      <AppearancePopover
        v-if="layerSettingsOpen && layerScope"
        :open="layerSettingsOpen"
        :anchor="contextBar ?? null"
        :label="contextInfo.label + layerSettingsLabel"
        @close="closeLayerSettings"
      >
        <AppearanceLayerSettings
          :draft="layerDraft"
          :scope="layerScope"
          :tone="tone === 'dark' ? 'dark' : 'light'"
          :busy="state.busy || !draft"
          @update:draft="updateAppearanceLayers($event.appearanceLayers)"
          @importing-change="layerImporting = $event"
        />
      </AppearancePopover>
      <fieldset
        v-if="contextAdjustment"
        :disabled="state.busy || !draft || tokenUnavailable(contextAdjustment.definition)"
        class="studio-context-adjustment"
      >
        <label :for="`studio-context-${contextAdjustment.definition.id}`">{{
          contextAdjustment.label
        }}</label>
        <input
          :id="`studio-context-${contextAdjustment.definition.id}`"
          type="range"
          :min="contextAdjustment.min"
          :max="contextAdjustment.max"
          :value="contextAdjustment.value"
          :aria-label="contextAdjustment.label"
          @input="setContextAdjustment(Number(($event.target as HTMLInputElement).value))"
        />
        <EditableRangeValue
          :value="contextAdjustment.value"
          :min="contextAdjustment.min"
          :max="contextAdjustment.max"
          :suffix="contextAdjustment.suffix"
          :aria-label="`${contextAdjustment.label}数值`"
          :disabled="state.busy || !draft || tokenUnavailable(contextAdjustment.definition)"
          @change="setContextAdjustment"
        />
      </fieldset>
    </div>
    <component
      :is="contextualMode ? AppearancePopover : 'div'"
      v-if="!contextualMode || toolsOpen"
      v-bind="
        contextualMode
          ? {
              open: props.active !== false && toolsOpen,
              anchor: contextBar ?? null,
              label: `${contextInfo.label}更多调节`
            }
          : { class: 'studio-tools-container' }
      "
      @close="closeContextTools(false)"
    >
      <div
        v-if="!contextualMode || toolsOpen"
        :id="contextualMode ? 'studio-context-tools' : undefined"
        class="theme-studio-workspace"
        :class="{
          'studio-context-popup': contextualMode,
          'theme-studio-page--controls': contextualMode,
          'theme-studio-page--contextual': contextualMode
        }"
        :style="contextualMode ? popoverTheme : undefined"
        :inert="contextualMode && state.busy"
      >
        <button
          v-if="contextualMode && draft?.overrides[tone][contextTokenId] != null"
          type="button"
          class="studio-context-reset-color"
          :disabled="state.busy"
          @click="resetContextColor"
        >
          颜色跟随主题
        </button>
        <aside v-if="!unified" class="theme-library-pane" aria-label="外观分类">
          <div class="pane-heading">
            <strong>外观分类</strong>
          </div>
          <label class="studio-search">
            <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
            <input
              v-model="studioSearchQuery"
              type="search"
              placeholder="搜索颜色、材质、字体…"
              aria-label="搜索主题设置"
            />
          </label>
          <div v-if="filteredStudioHits.length" class="studio-search-hits" aria-label="搜索结果">
            <button
              v-for="hit in filteredStudioHits"
              :key="`${hit.kind}:${hit.id}`"
              type="button"
              @click="jumpToSearchHit(hit)"
            >
              <strong>{{ hit.title }}</strong>
              <small>{{ domains.find((item) => item.id === hit.domain)?.label }}</small>
            </button>
          </div>
          <p v-else-if="studioSearchQuery.trim()" class="studio-control-hint" role="status">
            没有找到相关设置
          </p>
          <nav class="theme-domain-list">
            <button
              v-for="item in domains"
              :key="item.id"
              type="button"
              :class="{ active: domain === item.id }"
              :aria-current="domain === item.id ? 'page' : undefined"
              @click="domain = item.id"
            >
              <i :class="item.icon"></i><span>{{ item.label }}</span>
            </button>
          </nav>
        </aside>

        <main v-if="!controlsOnly" class="theme-preview-pane">
          <slot v-if="settingsOnly" name="settings-preview" />
          <template v-else>
            <div class="preview-toolbar">
              <div>
                <strong>实时预览</strong><span>{{ activeDomain.label }}</span>
              </div>
              <div class="studio-segment preview-surface-switcher" aria-label="预览页面">
                <button
                  v-for="surface in previewSurfaces"
                  :key="surface.id"
                  type="button"
                  :class="{ active: previewSurface === surface.id }"
                  :aria-pressed="previewSurface === surface.id"
                  @click="previewSurface = surface.id"
                >
                  <i :class="surface.icon"></i
                  ><span>{{
                    domain === 'library' && surface.id === 'dashboard' ? '歌曲列表' : surface.label
                  }}</span>
                </button>
              </div>
            </div>

            <section
              ref="previewViewportRef"
              class="theme-preview-stage live-preview-viewport"
              :style="previewViewportStyle"
            >
              <div class="live-preview-canvas" :style="previewCanvasStyle" inert aria-hidden="true">
                <TitleBar
                  preview
                  :immersive="previewSurface === 'player'"
                  :menu-open="previewNavigationOpen"
                  :streaming="false"
                  title-surface="default"
                />
                <SideMenu
                  v-if="previewSurface === 'dashboard'"
                  :open="previewNavigationOpen"
                  active-key="local-home"
                />
                <div
                  v-if="previewSurface === 'dashboard'"
                  class="main-content live-preview-app"
                  :class="{ 'menu-open': previewNavigationOpen }"
                >
                  <SongList
                    v-if="domain === 'library'"
                    category="allSongs"
                    :filter="null"
                    :has-player="true"
                    transition-name="page-down"
                  /><LocalHome v-else preview />
                </div>
                <PlayingMusic v-else-if="previewSurface === 'player'" />
                <EqualizerPage v-else />
                <PlayerBar
                  v-if="previewSurface !== 'equalizer'"
                  :glass="previewSurface === 'player'"
                  :menu-open="previewNavigationOpen"
                  preview
                />
              </div>
            </section>
          </template>
        </main>

        <aside
          v-if="!unified || active !== false"
          ref="editorPaneRef"
          class="theme-editor-pane"
          aria-label="主题编辑器"
        >
          <div v-show="!settingsOnly">
            <div class="pane-heading">
              <strong>{{ activeDomain.label }}</strong>
              <div>
                <button
                  v-if="!unified"
                  type="button"
                  class="studio-icon-button"
                  title="导出主题"
                  aria-label="导出主题"
                  :disabled="!draft || isUnsavedDraft"
                  @click="exportTheme"
                >
                  <i class="ph ph-upload-simple"></i>
                </button>
                <button
                  v-if="!unified || domain === 'presets'"
                  type="button"
                  class="studio-icon-button danger"
                  title="删除主题"
                  aria-label="删除主题"
                  :disabled="!draft || isUnsavedDraft"
                  @click="deleteSelected"
                >
                  <i class="ph ph-trash"></i>
                </button>
              </div>
            </div>

            <section v-if="domain === 'presets'" class="preset-gallery-section">
              <div class="control-section-heading">
                <span>内置主题</span>
              </div>
              <div class="preset-gallery" aria-label="内置主题预设">
                <article
                  v-for="preset in BUILT_IN_THEME_PRESETS"
                  :key="preset.id"
                  class="preset-gallery-item"
                  :class="{
                    selected: selectedKey === `preset:${preset.id}`,
                    active: activeKey === `preset:${preset.id}`
                  }"
                >
                  <button
                    type="button"
                    class="preset-preview-command"
                    :aria-pressed="selectedKey === `preset:${preset.id}`"
                    @click="chooseTheme(`preset:${preset.id}`)"
                  >
                    <span
                      class="preset-thumbnail"
                      :style="presetPreviewStyle(preset)"
                      :data-layout="resolveThemeProfileModes(preset).player?.layout"
                      aria-hidden="true"
                    >
                      <i></i><i></i><i></i><i></i>
                    </span>
                    <span class="preset-copy">
                      <strong>{{ preset.name }}</strong>
                      <small>{{ preset.description }}</small>
                    </span>
                  </button>
                  <div class="preset-item-actions">
                    <span v-if="activeKey === `preset:${preset.id}`">当前使用</span>
                    <button
                      type="button"
                      :title="'自定义' + preset.name"
                      :aria-label="'自定义' + preset.name"
                      @click="chooseTheme(`preset:${preset.id}`, true)"
                    >
                      <i class="ph ph-copy"></i>
                    </button>
                  </div>
                </article>
              </div>

              <div class="control-section-heading user-profile-heading">
                <span>个人主题</span><small>{{ profiles.length }} / 32</small>
              </div>
              <div v-if="profiles.length" class="preset-gallery user-profile-gallery">
                <article
                  v-for="profile in profiles"
                  :key="profile.id"
                  class="preset-gallery-item"
                  :class="{
                    selected: selectedKey === `profile:${profile.id}`,
                    active: activeKey === `profile:${profile.id}`
                  }"
                >
                  <button
                    type="button"
                    class="preset-preview-command"
                    :aria-pressed="selectedKey === `profile:${profile.id}`"
                    @click="chooseTheme(`profile:${profile.id}`)"
                  >
                    <span
                      class="preset-thumbnail"
                      :style="presetPreviewStyle(profile)"
                      :data-layout="resolveThemeProfileModes(profile).player?.layout"
                      aria-hidden="true"
                    >
                      <i></i><i></i><i></i><i></i>
                    </span>
                    <span class="preset-copy">
                      <strong>{{ profile.name }}</strong>
                      <small>
                        {{
                          profile.source?.kind === 'builtin-preset'
                            ? `基于 ${getBuiltInThemePreset(profile.source.presetId)?.name ?? '内置主题'}`
                            : profile.description || '个人主题'
                        }}
                      </small>
                    </span>
                  </button>
                  <div class="preset-item-actions">
                    <span v-if="activeKey === `profile:${profile.id}`">当前使用</span>
                    <time>{{ new Date(profile.updatedAt).toLocaleDateString('zh-CN') }}</time>
                  </div>
                </article>
              </div>
              <p v-else class="preset-empty-state">尚未创建个人主题</p>

              <section v-if="draft" class="profile-history-section">
                <div class="control-section-heading">
                  <span>之前保存的版本</span><small>最近 8 次</small>
                </div>
                <div v-if="persistedHistory.length" class="profile-history-list">
                  <div v-for="entry in persistedHistory" :key="entry.savedAt">
                    <span>
                      <strong>{{ entry.profile.name }}</strong>
                      <time>{{ historyLabel(entry) }}</time>
                    </span>
                    <button
                      type="button"
                      title="恢复此版本"
                      aria-label="恢复此版本"
                      @click="restoreVersion(entry)"
                    >
                      <i class="ph ph-clock-counter-clockwise"></i>
                    </button>
                  </div>
                </div>
                <p v-else class="preset-empty-state">保存修改后会在此保留可恢复版本</p>
              </section>
            </section>

            <input
              v-if="draft && (!unified ? domain !== 'presets' : domain === 'presets')"
              class="theme-name-input"
              :value="draft.name"
              maxlength="80"
              aria-label="主题名称"
              @change="changeName"
            />
            <div v-else-if="!draft && domain !== 'presets'" class="read-only-theme">
              <div>
                <strong>{{ selectedPluginTheme ? '插件主题' : '内置主题' }}</strong>
              </div>
              <button type="button" class="studio-command primary" @click="duplicateSelected">
                开始自定义
              </button>
            </div>

            <section v-if="domain === 'personalization'" class="studio-control-section">
              <div class="control-section-heading">
                <span>配色与背景</span><small>主题 · {{ tone === 'dark' ? '深色' : '浅色' }}</small>
              </div>
              <label class="studio-setting-row">
                <span>主题色</span>
                <select
                  data-studio-setting="appearance.accentSource"
                  :value="activeModes.appearance?.accentSource"
                  :disabled="!draft"
                  @change="updateAppearanceMode('accentSource', $event)"
                >
                  <option value="fixed">固定颜色</option>
                  <option value="cover">当前封面</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>背景样式</span>
                <select
                  data-studio-setting="appearance.backgroundTreatment"
                  :value="activeModes.appearance?.backgroundTreatment"
                  :disabled="!draft"
                  @change="updateAppearanceMode('backgroundTreatment', $event)"
                >
                  <option value="solid">实色</option>
                  <option value="gradient">双色渐变</option>
                  <option value="cover-blur">封面模糊</option>
                  <option value="image">本地图片</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>自动切换深浅色</span>
                <select
                  data-studio-setting="appearance.toneScheduling"
                  :value="activeModes.appearance?.toneScheduling"
                  :disabled="!draft"
                  @change="updateAppearanceMode('toneScheduling', $event)"
                >
                  <option value="manual">手动</option>
                  <option value="system">跟随系统</option>
                  <option value="timed">定时时段</option>
                </select>
              </label>
              <div
                v-if="activeModes.appearance?.toneScheduling === 'timed'"
                class="schedule-time-grid"
              >
                <label>
                  <span>浅色开始</span>
                  <input
                    type="time"
                    :value="scheduleTime('lightStartMinutes')"
                    :disabled="!draft"
                    @change="updateScheduleTime('lightStartMinutes', $event)"
                  />
                </label>
                <label>
                  <span>深色开始</span>
                  <input
                    type="time"
                    :value="scheduleTime('darkStartMinutes')"
                    :disabled="!draft"
                    @change="updateScheduleTime('darkStartMinutes', $event)"
                  />
                </label>
              </div>
              <label class="studio-setting-row">
                <span>文字可读性</span>
                <select
                  data-studio-setting="appearance.contrastGuard"
                  :value="activeModes.appearance?.contrastGuard"
                  :disabled="!draft"
                  @change="updateAppearanceMode('contrastGuard', $event)"
                >
                  <option value="off">关闭</option>
                  <option value="warn">提示文字不清晰</option>
                  <option value="enforce">自动提高可读性</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>背景特效</span>
                <select
                  data-studio-setting="appearance.effectsMode"
                  :value="activeModes.appearance?.effectsMode"
                  :disabled="!draft"
                  @change="updateAppearanceMode('effectsMode', $event)"
                >
                  <option value="full">完整特效</option>
                  <option value="reduced">关闭特效</option>
                </select>
              </label>
            </section>

            <details
              v-if="domain === 'personalization'"
              class="palette-editor"
              data-studio-setting="palettes"
              :open="!controlsOnly"
            >
              <summary class="studio-palette-summary">配色预设</summary>
              <div class="control-section-heading">
                <span>精选强调色</span><small>{{ accentPalette.length }} 色</small>
              </div>
              <div class="palette-grid" aria-label="精选强调色色板">
                <button
                  v-for="entry in accentPalette"
                  :key="entry.id"
                  type="button"
                  :class="{ active: valueForId('color.primary.500') === entry.value }"
                  :aria-pressed="valueForId('color.primary.500') === entry.value"
                  :style="{ '--swatch-color': entry.value }"
                  :title="entry.label"
                  :aria-label="entry.label"
                  :disabled="!draft"
                  @click="applyAccentPalette(entry.value)"
                ></button>
              </div>
              <div class="control-section-heading background-palette-heading">
                <span>精选背景色</span><small>{{ backgroundPalette.length }} 色</small>
              </div>
              <div class="palette-grid" aria-label="精选背景色色板">
                <button
                  v-for="entry in backgroundPalette"
                  :key="entry.id"
                  type="button"
                  :class="{ active: valueForId('surface.app') === entry.value }"
                  :aria-pressed="valueForId('surface.app') === entry.value"
                  :style="{ '--swatch-color': entry.value }"
                  :title="entry.label"
                  :aria-label="entry.label"
                  :disabled="!draft"
                  @click="applyBackgroundPalette(entry.value)"
                ></button>
              </div>
            </details>

            <section v-if="domain === 'navigation'" class="studio-control-section">
              <div class="control-section-heading">
                <span>图标与侧边栏</span>
              </div>
              <label class="studio-setting-row">
                <span>图标样式</span>
                <select
                  data-studio-setting="icons.family"
                  :value="activeModes.icons?.family"
                  :disabled="!draft"
                  @change="updateIconFamily"
                >
                  <option value="outline">描边</option>
                  <option value="rounded">圆润粗线</option>
                  <option value="filled">填充</option>
                </select>
              </label>
              <ThemeIconSettings
                :profile="draft"
                :selection="selectedIconSlot"
                initial-group="all"
                :busy="state.busy"
                :importing="iconImporting"
                @select="selectIconSlot"
                @import="importIconAsset"
                @bind="setIconBinding"
              />
              <label class="studio-setting-row">
                <span>侧边栏样式</span>
                <select
                  data-studio-setting="navigation.style"
                  :value="activeModes.navigation?.style"
                  :disabled="!draft"
                  @change="updateNavigationMode('style', $event)"
                >
                  <option value="expanded">展开</option>
                  <option value="compact">紧凑</option>
                  <option value="rail">图标栏</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>显示播放器标志</span>
                <input
                  data-studio-setting="navigation.logo"
                  type="checkbox"
                  :checked="activeModes.navigation?.logo === 'show'"
                  :disabled="!draft"
                  @change="updateNavigationMode('logo', $event)"
                />
              </label>
            </section>

            <section v-if="domain === 'library'" class="studio-control-section">
              <div class="control-section-heading">
                <span>歌曲列表</span>
              </div>
              <label class="studio-setting-row">
                <span>歌曲列表间距</span>
                <select
                  data-studio-setting="library.density"
                  :value="activeModes.library?.density"
                  :disabled="!draft"
                  @change="updateLibraryMode('density', $event)"
                >
                  <option value="comfortable">舒适</option>
                  <option value="compact">紧凑</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>歌曲选中样式</span>
                <select
                  data-studio-setting="library.selection"
                  :value="activeModes.library?.selection"
                  :disabled="!draft"
                  @change="updateLibraryMode('selection', $event)"
                >
                  <option value="fill">填充</option>
                  <option value="stroke">描边</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>显示标题底色</span>
                <input
                  data-studio-setting="library.titleOverlay"
                  type="checkbox"
                  :checked="activeModes.library?.titleOverlay === 'on'"
                  :disabled="!draft"
                  @change="updateLibraryMode('titleOverlay', $event)"
                />
              </label>
            </section>

            <section
              v-if="domain === 'player'"
              class="studio-control-section player-layout-section"
            >
              <div class="control-section-heading">
                <span>播放器布局</span>
              </div>
              <div
                class="layout-gallery"
                aria-label="播放器布局"
                data-studio-setting="player.layout"
                tabindex="-1"
              >
                <button
                  v-for="layout in playerLayouts"
                  :key="layout.id"
                  type="button"
                  class="layout-choice"
                  :class="{ active: activeModes.player?.layout === layout.id }"
                  :aria-pressed="activeModes.player?.layout === layout.id"
                  :disabled="!draft"
                  @click="setPlayerLayout(layout.id)"
                >
                  <span class="layout-thumbnail" :data-layout="layout.id" aria-hidden="true">
                    <i></i><i></i><i></i>
                  </span>
                  <span>{{ layout.label }}</span>
                </button>
              </div>
            </section>

            <section v-if="domain === 'player'" class="studio-control-section">
              <div class="control-section-heading">
                <span>播放按钮与封面</span>
              </div>
              <label class="studio-setting-row">
                <span>播放按钮样式</span>
                <select
                  data-studio-setting="player.controls"
                  :value="activeModes.player?.controls"
                  :disabled="!draft"
                  @change="updatePlayerMode('controls', $event)"
                >
                  <option value="standard">标准</option>
                  <option value="pro">增强</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>歌曲标题对齐</span>
                <select
                  data-studio-setting="player.titleAlign"
                  :value="activeModes.player?.titleAlign"
                  :disabled="!draft"
                  @change="updatePlayerMode('titleAlign', $event)"
                >
                  <option value="left">左对齐</option>
                  <option value="center">居中</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>播放进度条样式</span>
                <select
                  data-studio-setting="player.progress"
                  :value="activeModes.player?.progress"
                  :disabled="!draft"
                  @change="updatePlayerMode('progress', $event)"
                >
                  <option value="line">直线无滑块</option>
                  <option value="ring">空心圆</option>
                  <option value="solid">实心圆</option>
                  <option value="spectrum">频谱</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>切歌时的封面动画</span>
                <select
                  data-studio-setting="artwork.transition"
                  :value="activeModes.artwork?.transition"
                  :disabled="!draft"
                  @change="updateArtworkMode('transition', $event)"
                >
                  <option value="fade">淡入</option>
                  <option value="slide">滑入</option>
                  <option value="none">无过渡</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>显示封面阴影</span>
                <input
                  data-studio-setting="artwork.shadow"
                  type="checkbox"
                  :checked="activeModes.artwork?.shadow === 'on'"
                  :disabled="!draft"
                  @change="updateArtworkMode('shadow', $event)"
                />
              </label>
            </section>

            <section v-if="domain === 'player'" class="studio-control-section">
              <div class="control-section-heading">
                <span>均衡器外观</span>
              </div>
              <label class="studio-setting-row">
                <span>均衡器背景</span>
                <select
                  data-studio-setting="equalizer.panel"
                  :value="activeModes.equalizer?.panel"
                  :disabled="!draft"
                  @change="updateEqualizerMode('panel', $event)"
                >
                  <option value="neutral">素色</option>
                  <option value="tinted">主题色</option>
                  <option value="glass">玻璃</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>均衡器滑块形状</span>
                <select
                  data-studio-setting="equalizer.slider"
                  :value="activeModes.equalizer?.slider"
                  :disabled="!draft"
                  @change="updateEqualizerMode('slider', $event)"
                >
                  <option value="ring">空心环</option>
                  <option value="solid">实心圆</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>旋钮标记</span>
                <select
                  data-studio-setting="equalizer.knob"
                  :value="activeModes.equalizer?.knob"
                  :disabled="!draft"
                  @change="updateEqualizerMode('knob', $event)"
                >
                  <option value="line">线形</option>
                  <option value="dot">圆点</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>频谱样式</span>
                <select
                  data-studio-setting="equalizer.spectrum"
                  :value="activeModes.equalizer?.spectrum"
                  :disabled="!draft"
                  @change="updateEqualizerMode('spectrum', $event)"
                >
                  <option value="bars">柱形</option>
                  <option value="line">线形</option>
                  <option value="area">填充曲线</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>均衡器按钮样式</span>
                <select
                  data-studio-setting="equalizer.button"
                  :value="activeModes.equalizer?.button"
                  :disabled="!draft"
                  @change="updateEqualizerMode('button', $event)"
                >
                  <option value="soft">柔和</option>
                  <option value="outline">描边</option>
                  <option value="solid">填充</option>
                </select>
              </label>
            </section>

            <section
              v-if="domain === 'player'"
              class="studio-control-section"
              data-studio-setting="visibility"
              tabindex="-1"
            >
              <div class="control-section-heading"><span>显示哪些内容</span></div>
              <div class="visibility-grid">
                <label v-for="option in visibilityOptions" :key="option.id">
                  <span>{{ option.label }}</span>
                  <input
                    type="checkbox"
                    :checked="visibilityValue(option.id)"
                    :disabled="!draft"
                    @change="updateVisibility(option.id, $event)"
                  />
                </label>
              </div>
            </section>

            <section v-if="domain === 'typography'" class="studio-control-section">
              <div class="control-section-heading"><span>文字样式</span></div>
              <label class="studio-setting-row">
                <span>英文标题大小写</span>
                <select
                  data-studio-setting="typography.titleCase"
                  :value="activeModes.typography?.titleCase"
                  :disabled="!draft"
                  @change="updateTypographyMode('titleCase', $event)"
                >
                  <option value="preserve">保留原样</option>
                  <option value="uppercase">大写显示</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>歌词使用主题色</span>
                <select
                  data-studio-setting="typography.lyricAccent"
                  :value="activeModes.typography?.lyricAccent"
                  :disabled="!draft"
                  @change="updateTypographyMode('lyricAccent', $event)"
                >
                  <option value="off">关闭</option>
                  <option value="accent">开启</option>
                </select>
              </label>
              <label class="studio-setting-row">
                <span>主题色文字</span>
                <select
                  data-studio-setting="typography.titleColor"
                  :value="activeModes.typography?.titleColor"
                  :disabled="!draft"
                  @change="updateTypographyMode('titleColor', $event)"
                >
                  <option value="off">关闭</option>
                  <option value="track">曲目标题</option>
                  <option value="artist-album">艺术家与专辑</option>
                </select>
              </label>
            </section>

            <section v-if="domain === 'typography'" class="font-library-editor">
              <div class="asset-editor-heading">
                <span>选择字体</span>
                <button
                  type="button"
                  title="添加 WOFF2 字体文件"
                  :disabled="!draft"
                  @click="importAsset('font')"
                >
                  <i class="ph ph-file-plus"></i><span>添加字体</span>
                </button>
              </div>
              <label
                v-for="binding in fontBindings"
                :key="binding.key"
                :data-studio-setting="binding.tokenId"
              >
                <span
                  >{{ binding.label }}<small>{{ fontSource(binding) }}</small></span
                >
                <select
                  :value="fontSelection(binding)"
                  :disabled="!draft"
                  @change="updateFontSlot(binding, $event)"
                >
                  <option value="custom" disabled>当前字体</option>
                  <optgroup label="内置字体">
                    <option
                      v-for="font in BUILT_IN_THEME_FONTS"
                      :key="font.id"
                      :value="`builtin:${font.id}`"
                    >
                      {{ font.label }}
                    </option>
                  </optgroup>
                  <optgroup v-if="fontAssets.length" label="已添加的字体">
                    <option
                      v-for="asset in fontAssets"
                      :key="asset.id"
                      :value="`asset:${asset.id}`"
                    >
                      {{ asset.path }}
                    </option>
                  </optgroup>
                </select>
              </label>
            </section>

            <div v-if="domain === 'windows'" class="window-default-grid">
              <section class="studio-control-section">
                <div class="control-section-heading">
                  <span>迷你播放器</span>
                </div>
                <label class="studio-setting-row studio-follow-theme">
                  <span
                    >跟随当前主题<small>{{
                      themeStore.snapshot.value?.data.windowInheritance.miniPlayer
                        ? '已开启'
                        : '正在使用小窗自己的外观'
                    }}</small></span
                  >
                  <input
                    type="checkbox"
                    :checked="themeStore.snapshot.value?.data.windowInheritance.miniPlayer"
                    :disabled="themeStore.saving.value"
                    @change="toggleWindowInheritance('miniPlayer')"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>背景颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('miniPlayer', 'surfaceColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('miniPlayer', 'surfaceColor', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>按钮与进度条颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('miniPlayer', 'accentColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('miniPlayer', 'accentColor', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>文字颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('miniPlayer', 'primaryTextColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('miniPlayer', 'primaryTextColor', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>字体</span>
                  <select
                    :value="String(windowDefaultValue('miniPlayer', 'fontFamily'))"
                    :disabled="!draft"
                    @change="updateWindowText('miniPlayer', 'fontFamily', $event)"
                  >
                    <option
                      v-if="
                        !BUILT_IN_THEME_FONTS.some(
                          (font) => font.value === windowDefaultValue('miniPlayer', 'fontFamily')
                        )
                      "
                      :value="String(windowDefaultValue('miniPlayer', 'fontFamily'))"
                    >
                      当前主题字体
                    </option>
                    <option v-for="font in BUILT_IN_THEME_FONTS" :key="font.id" :value="font.value">
                      {{ font.label }}
                    </option>
                  </select>
                </label>
                <label class="studio-setting-row window-range-row">
                  <span
                    >背景不透明度<small
                      >{{ windowDefaultValue('miniPlayer', 'surfaceOpacity') }}%</small
                    ></span
                  >
                  <input
                    type="range"
                    min="40"
                    max="100"
                    :value="Number(windowDefaultValue('miniPlayer', 'surfaceOpacity'))"
                    :disabled="!draft"
                    @input="updateWindowNumber('miniPlayer', 'surfaceOpacity', $event)"
                  />
                </label>
                <label class="studio-setting-row window-range-row">
                  <span
                    >玻璃模糊<small
                      >{{ windowDefaultValue('miniPlayer', 'glassBlur') }}px</small
                    ></span
                  >
                  <input
                    type="range"
                    min="0"
                    max="40"
                    :value="Number(windowDefaultValue('miniPlayer', 'glassBlur'))"
                    :disabled="!draft"
                    @input="updateWindowNumber('miniPlayer', 'glassBlur', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>边框颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('miniPlayer', 'borderColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('miniPlayer', 'borderColor', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>阴影颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('miniPlayer', 'shadowColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('miniPlayer', 'shadowColor', $event)"
                  />
                </label>
                <label class="studio-setting-row window-range-row">
                  <span
                    >阴影强度<small
                      >{{ windowDefaultValue('miniPlayer', 'shadowStrength') }}%</small
                    ></span
                  >
                  <input
                    type="range"
                    min="0"
                    max="100"
                    :value="Number(windowDefaultValue('miniPlayer', 'shadowStrength'))"
                    :disabled="!draft"
                    @input="updateWindowNumber('miniPlayer', 'shadowStrength', $event)"
                  />
                </label>
              </section>

              <section class="studio-control-section">
                <div class="control-section-heading">
                  <span>桌面歌词</span>
                </div>
                <label class="studio-setting-row studio-follow-theme">
                  <span
                    >跟随当前主题<small>{{
                      themeStore.snapshot.value?.data.windowInheritance.desktopLyrics
                        ? '已开启'
                        : '正在使用桌面歌词自己的外观'
                    }}</small></span
                  >
                  <input
                    type="checkbox"
                    :checked="themeStore.snapshot.value?.data.windowInheritance.desktopLyrics"
                    :disabled="themeStore.saving.value"
                    @change="toggleWindowInheritance('desktopLyrics')"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>其他歌词颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('desktopLyrics', 'color'))"
                    :disabled="!draft"
                    @input="updateWindowText('desktopLyrics', 'color', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>当前歌词颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('desktopLyrics', 'highlightColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('desktopLyrics', 'highlightColor', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>背景颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('desktopLyrics', 'backgroundColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('desktopLyrics', 'backgroundColor', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>字体</span>
                  <select
                    :value="String(windowDefaultValue('desktopLyrics', 'fontFamily'))"
                    :disabled="!draft"
                    @change="updateWindowText('desktopLyrics', 'fontFamily', $event)"
                  >
                    <option
                      v-if="
                        ![
                          'follow',
                          'system',
                          'MiSans',
                          'Microsoft YaHei UI',
                          'lxgw',
                          'sarasa'
                        ].includes(String(windowDefaultValue('desktopLyrics', 'fontFamily')))
                      "
                      :value="String(windowDefaultValue('desktopLyrics', 'fontFamily'))"
                    >
                      当前主题字体
                    </option>
                    <option value="follow">跟随播放器</option>
                    <option value="system">系统字体</option>
                    <option value="MiSans">MiSans</option>
                    <option value="Microsoft YaHei UI">微软雅黑</option>
                    <option value="lxgw">霞鹜文楷</option>
                    <option value="sarasa">更纱黑体</option>
                  </select>
                </label>
                <label class="studio-setting-row window-range-row">
                  <span
                    >字号<small
                      >{{ windowDefaultValue('desktopLyrics', 'fontSize') }}px</small
                    ></span
                  >
                  <input
                    type="range"
                    min="12"
                    max="80"
                    :value="Number(windowDefaultValue('desktopLyrics', 'fontSize'))"
                    :disabled="!draft"
                    @input="updateWindowNumber('desktopLyrics', 'fontSize', $event)"
                  />
                </label>
                <label class="studio-setting-row window-range-row">
                  <span
                    >背景不透明度<small
                      >{{ windowDefaultValue('desktopLyrics', 'backgroundOpacity') }}%</small
                    ></span
                  >
                  <input
                    type="range"
                    min="0"
                    max="100"
                    :value="Number(windowDefaultValue('desktopLyrics', 'backgroundOpacity'))"
                    :disabled="!draft"
                    @input="updateWindowNumber('desktopLyrics', 'backgroundOpacity', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>显示文字阴影</span>
                  <input
                    type="checkbox"
                    :checked="Boolean(windowDefaultValue('desktopLyrics', 'shadow'))"
                    :disabled="!draft"
                    @change="updateWindowBoolean('desktopLyrics', 'shadow', $event)"
                  />
                </label>
                <label class="studio-setting-row">
                  <span>阴影颜色</span>
                  <input
                    type="color"
                    :value="String(windowDefaultValue('desktopLyrics', 'shadowColor'))"
                    :disabled="!draft"
                    @input="updateWindowText('desktopLyrics', 'shadowColor', $event)"
                  />
                </label>
                <label class="studio-setting-row window-range-row">
                  <span
                    >阴影模糊<small
                      >{{ windowDefaultValue('desktopLyrics', 'shadowBlur') }}px</small
                    ></span
                  >
                  <input
                    type="range"
                    min="0"
                    max="30"
                    :value="Number(windowDefaultValue('desktopLyrics', 'shadowBlur'))"
                    :disabled="!draft"
                    @input="updateWindowNumber('desktopLyrics', 'shadowBlur', $event)"
                  />
                </label>
              </section>
            </div>

            <section
              v-if="
                domain === 'personalization' &&
                activeModes.appearance?.backgroundTreatment === 'image'
              "
              class="asset-editor"
            >
              <div class="asset-editor-heading">
                <span>背景图片</span>
                <button type="button" :disabled="!draft" @click="importAsset('image')">
                  <i class="ph ph-image-square"></i><span>导入图片</span>
                </button>
              </div>
              <label v-for="binding in backgroundBindings" :key="binding.key">
                <span
                  >{{ binding.label }}<small>{{ assetSource(binding.key) }}</small></span
                >
                <select
                  :value="draft?.assetBindings?.[binding.key] ?? ''"
                  :disabled="!draft"
                  @change="updateAssetBinding(binding.key, $event)"
                >
                  <option value="">
                    {{ binding.key === 'appBackground' ? '未选择图片' : '跟随全局背景' }}
                  </option>
                  <option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">
                    {{ asset.path }}
                  </option>
                </select>
              </label>
            </section>

            <div v-if="domain !== 'presets'" :key="domain" class="studio-appearance-list">
              <details
                v-for="(group, index) in appearanceGroups"
                :key="group.name"
                class="studio-appearance-group"
                :open="(!controlsOnly && index === 0) || Boolean(studioSearchQuery.trim())"
              >
                <summary>
                  <i class="ph ph-caret-right" aria-hidden="true"></i
                  ><strong>{{ group.name }}</strong
                  ><span>{{ group.items.length }} 项</span>
                </summary>
                <ThemeAppearanceControl
                  v-for="definition in group.items"
                  :key="definition.id"
                  :definition="definition"
                  :value="valueFor(definition)"
                  :source="sourceFor(definition)"
                  :disabled="!draft"
                  :unavailable="tokenUnavailable(definition)"
                  :modified="draft?.overrides[tone][definition.id] != null"
                  :hint="tokenHint(definition)"
                  @change="updateToken(definition, $event)"
                  @reset="removeOverride(definition)"
                />
              </details>
            </div>

            <section
              v-if="contrastWarnings.length && activeModes.appearance?.contrastGuard !== 'off'"
              class="contrast-warning"
              role="status"
            >
              <div><i class="ph ph-warning"></i><strong>部分文字可能不易看清</strong></div>
              <p v-for="warning in contrastWarnings" :key="warning.label">
                {{ warning.label }}的颜色太接近
              </p>
            </section>

            <section
              v-if="selectedPluginTheme?.compatibilityNotes?.length"
              class="contrast-warning"
              role="status"
            >
              <div><i class="ph ph-warning"></i><strong>主题兼容提示</strong></div>
              <p v-for="note in selectedPluginTheme.compatibilityNotes" :key="note">{{ note }}</p>
            </section>

            <p v-if="notice" class="studio-message" role="status">{{ notice }}</p>
          </div>
          <slot name="appearance-settings" />
        </aside>
      </div>
    </component>
  </div>
</template>

<style src="./theme-studio/ThemeStudioPage.css"></style>
