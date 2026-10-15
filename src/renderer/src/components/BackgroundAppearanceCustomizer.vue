<script setup lang="ts">
import { appearanceEditorOpen } from '../composables/appearanceEditorState.ts'
import { useBackgroundAppearanceEditor } from '../composables/useBackgroundAppearanceEditor.ts'
import CardAppearanceSettings from './settings-page/CardAppearanceSettings.vue'
import LiquidGlassSettings from './settings-page/LiquidGlassSettings.vue'
import EditableRangeValue from './EditableRangeValue.vue'
import AppearanceWindowPreview from './AppearanceWindowPreview.vue'
import AppearancePopover from './AppearancePopover.vue'
import AppearanceSurfaceInspector from './AppearanceSurfaceInspector.vue'
import { APPEARANCE_PARTS, type AppearancePart } from './appearanceParts'
import { useAppearanceHistory } from '../composables/useAppearanceHistory'
import type { AppearanceHistoryActions } from './appearanceEditor'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEscapeToClose } from '../app/useDismissLayer'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useThemeStore } from '../stores/useThemeStore'
import {
  BUILT_IN_THEME_PRESETS,
  THEME_TOKEN_DEFINITIONS,
  getBuiltInThemePreset,
  resolveThemeProfileTokens,
  type BuiltInThemePresetId
} from '../../../shared/theme'
import { parseStudioColor } from './theme-studio/themeVisualControls'
import { fontFamilyOptions } from './settings-page/types'
import { normalizeAppFontFamily } from '../../../shared/appFont'
import { normalizeAppearanceLayers } from '../../../shared/appearanceLayers'
import type { NavigationPageDefinition } from '../app/navigationPages'
const props = withDefaults(
  defineProps<{
    embedded?: boolean
    externalPanel?: boolean
    active?: boolean
    controlsOnly?: boolean
    externalTone?: 'pureWhite' | 'dark'
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
    embedded: false,
    externalPanel: false,
    externalToolbar: false
  }
)
const emit = defineEmits<{
  focusSetting: [id: 'global-font' | 'player-bar' | 'appearance-theme' | 'appearance-surfaces']
  workspaceSelected: [part: AppearancePart]
  draftChange: [dirty: boolean]
  editTheme: [region: string]
  toneChange: [tone: 'pureWhite' | 'dark']
}>()
const selectedRegion = ref('background')
const characterPart = ref<AppearancePart>('overview')
const characterBackground = computed(
  () => characterPart.value === 'inner-panel' || characterPart.value === 'background'
)
const characterBody = ref<HTMLElement>()
const characterPreview = ref<InstanceType<typeof AppearanceWindowPreview>>()
const inspectorCollapsed = ref(false)
const layerImporting = ref(false)
const partInfo = computed(() => APPEARANCE_PARTS.find((part) => part.id === characterPart.value)!)
const characterBusy = computed(
  () => state.saving || busy.value || layerImporting.value || props.commitBusy
)
function focusPart(id: AppearancePart): void {
  if (characterBusy.value) return
  if (id === 'navigation' && characterPreview.value?.navigationExpanded === false)
    characterPreview.value.toggleNavigation()
  characterPart.value = id === 'background' ? 'inner-panel' : id
  inspectorCollapsed.value = false
  detailedOpen.value = false
  quickOpen.value = false
  emit('workspaceSelected', characterPart.value)
}
async function returnToWindow(): Promise<void> {
  if (characterBusy.value) return
  const previous = characterPart.value
  focusPart('overview')
  await nextTick()
  dialogRef.value?.querySelector<HTMLButtonElement>(`[data-part="${previous}"]`)?.focus()
}
useEscapeToClose(
  () =>
    props.active &&
    props.characterEditor &&
    characterPart.value !== 'overview' &&
    !detailedOpen.value &&
    !props.externalPanel &&
    !props.themePanelOpen,
  () => void returnToWindow()
)
function openMore(part: AppearancePart): void {
  selectedRegion.value = part === 'inner-panel' ? 'background' : part
  moreSettings()
}
const quickOpen = ref(false)
const quickAnchor = ref<HTMLElement | null>(null)
const quickTab = ref<'color' | 'image' | 'material' | 'theme' | 'font' | 'player'>('color')
const detailedOpen = ref(props.controlsOnly)
const quickError = ref('')
const windowRatio = ref(window.innerWidth / Math.max(1, window.innerHeight))
const centerRef = ref<HTMLElement>()
const previewWidth = ref(0)
let stageObserver: ResizeObserver | undefined
const stageStyle = computed(() => ({
  '--appearance-window-ratio': String(windowRatio.value),
  '--appearance-preview-width': previewWidth.value ? `${previewWidth.value}px` : '100%'
}))
function resizeStage(): void {
  windowRatio.value = window.innerWidth / Math.max(1, window.innerHeight)
  const rect = centerRef.value?.getBoundingClientRect()
  if (rect)
    previewWidth.value = Math.max(
      0,
      Math.floor(Math.min(1000, rect.width, rect.height * windowRatio.value))
    )
}
onMounted(() => {
  if (props.embedded) {
    window.addEventListener('resize', resizeStage)
    stageObserver = new ResizeObserver(resizeStage)
    if (centerRef.value) stageObserver.observe(centerRef.value)
    resizeStage()
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeStage)
  stageObserver?.disconnect()
})
useEscapeToClose(
  () =>
    props.active &&
    props.embedded &&
    !props.controlsOnly &&
    detailedOpen.value &&
    !props.externalPanel,
  () => {
    detailedOpen.value = false
  }
)
watch(
  () => props.active,
  (active) => {
    if (!active) quickOpen.value = false
  }
)
const { settings, updateSettings } = useSettingsStore()
const themeStore = useThemeStore()
const currentPartColor = computed(() => {
  const tokenId =
    characterPart.value === 'navigation'
      ? 'navigation.surface'
      : characterPart.value === 'player-bar'
        ? 'playback.control.surface'
        : 'surface.app'
  const definition = THEME_TOKEN_DEFINITIONS.find((entry) => entry.id === tokenId)
  if (!definition) return undefined
  const previewTone = tone.value === 'dark' ? 'dark' : 'pureWhite'
  const selection = themeStore.activeTheme.value
  const profile =
    selection.kind === 'builtin'
      ? getBuiltInThemePreset(selection.id)
      : themeStore.activeProfile.value
  const value =
    resolveThemeProfileTokens(profile, previewTone)[tokenId] ??
    (document.documentElement.dataset.theme === previewTone
      ? themeStore.effectiveVariables.value[definition.cssVariable]
      : undefined) ??
    (selection.kind === 'plugin' ? undefined : definition.defaults[previewTone])
  if (!value) return undefined
  return parseStudioColor(value)?.hex
})
const quickColors = [
  '#17191b',
  '#252a30',
  '#28332f',
  '#313044',
  '#f5f3ee',
  '#e5e9ed',
  '#dfe9e2',
  '#e7e2ee'
]
const selectedThemeId = computed(() =>
  themeStore.activeTheme.value.kind === 'builtin' ? themeStore.activeTheme.value.id : ''
)
const quickColor = computed(() =>
  selectedRegion.value === 'card'
    ? state.draft.cardAppearance[tone.value].backgroundColor
    : activeBackground.value[tone.value]
)
function changeQuickColor(color: string): void {
  if (selectedRegion.value === 'card') {
    state.draft.surfaceMaterial = 'standard'
    state.draft.cardAppearance.enabled = true
    state.draft.cardAppearance[tone.value].backgroundColor = color
  } else {
    editableBackground()[tone.value] = color
    clearInnerBackgroundOverride()
  }
}
async function chooseTheme(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  if (hasChanges.value) {
    select.value = selectedThemeId.value
    quickError.value = '先应用当前背景与材质更改，再切换主题。'
    return
  }
  try {
    const preset = BUILT_IN_THEME_PRESETS.find((item) => item.id === select.value)
    if (!preset) return
    await themeStore.setActive({ kind: 'builtin', id: preset.id as BuiltInThemePresetId })
    tone.value = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    quickError.value = ''
  } catch {
    quickError.value = '主题未能应用，请重试。'
  }
}
async function changeQuickSetting(patch: Parameters<typeof updateSettings>[0]): Promise<void> {
  try {
    await updateSettings(patch)
    if (patch.theme && patch.theme !== 'system')
      tone.value = patch.theme === 'dark' ? 'dark' : 'light'
    quickError.value = ''
  } catch {
    quickError.value = '更改未能保存，请重试。'
  }
}
function moreSettings(): void {
  quickOpen.value = false
  if (
    props.themeTools &&
    selectedRegion.value !== 'background' &&
    selectedRegion.value !== 'card'
  ) {
    emit('editTheme', selectedRegion.value)
    return
  }
  detailedOpen.value = true
  if (
    selectedRegion.value === 'global-font' ||
    selectedRegion.value === 'player-bar' ||
    selectedRegion.value === 'appearance-theme'
  )
    emit('focusSetting', selectedRegion.value)
  else {
    emit('workspaceSelected', characterPart.value)
    area.value =
      selectedRegion.value === 'background'
        ? 'background'
        : props.characterEditor && selectedRegion.value === 'card'
          ? 'advanced'
          : 'material'
  }
}
const orbitGroups = [
  { id: 'background', label: '背景', detail: '图片与颜色', icon: 'pi pi-image', position: 'left' },
  {
    id: 'navigation',
    label: '侧边栏',
    detail: '轮廓与材质',
    icon: 'pi pi-bars',
    position: 'bottom'
  },
  {
    id: 'material',
    label: '界面材质',
    detail: '标题栏与卡片',
    icon: 'pi pi-clone',
    position: 'right'
  },
  {
    id: 'global-font',
    label: '文字',
    detail: '字体与排版',
    icon: 'pi pi-language',
    position: 'right'
  },
  {
    id: 'appearance-theme',
    label: '主题',
    detail: '整体配色',
    icon: 'pi pi-palette',
    position: 'left'
  },
  {
    id: 'player-bar',
    label: '播放栏',
    detail: '布局与控件',
    icon: 'pi pi-play-circle',
    position: 'bottom'
  }
]
function selectRegion(id: string, event?: MouseEvent): void {
  if (props.characterEditor) {
    focusPart(id as AppearancePart)
    return
  }
  selectedRegion.value = id
  quickError.value = ''
  detailedOpen.value = false
  emit('workspaceSelected', characterPart.value)
  // Quick background controls always edit the shared background, not a previous search target.
  target.value = 'global'
  area.value = id === 'background' ? 'background' : 'material'
  quickTab.value =
    id === 'background'
      ? 'color'
      : id === 'global-font'
        ? 'font'
        : id === 'player-bar'
          ? 'player'
          : id === 'appearance-theme'
            ? 'theme'
            : 'material'
  quickAnchor.value =
    (event?.currentTarget as HTMLElement) ??
    dialogRef.value?.querySelector<HTMLElement>('.appearance-orbit-center') ??
    null
  quickOpen.value = true
}
function selectDetailedArea(value: typeof area.value): void {
  area.value = value
  detailedOpen.value = true
}
const {
  state,
  area,
  hasChanges,
  hasConflict,
  dialogRef,
  bodyRef,
  fileInput,
  target,
  previewPage,
  tone,
  setTone,
  importing,
  imagePaletteNotice,
  matching,
  busy,
  advancedOpen,
  pageOptions,
  materials,
  activeBackground,
  inherited,
  effect,
  activeMaterial,
  previewStyle,
  editableBackground,
  setEffect,
  setInheritance,
  chooseImage,
  importImage: importBackgroundImage,
  removeImage,
  resetCurrent,
  selectMaterial,
  useTransparentRecipe,
  fullPreview,
  cancel: cancelDraft,
  save: saveDraft,
  ranges
} = useBackgroundAppearanceEditor({ embedded: props.embedded })
const hasBackgroundImage = computed(
  () => activeBackground.value.kind === 'image' && !!activeBackground.value.image
)
function clearInnerBackgroundOverride(
  selectedTone = tone.value,
  selectedTarget = target.value
): void {
  if (selectedTarget !== 'global') return
  const layers = normalizeAppearanceLayers(state.draft.appearanceLayers)
  if (!layers.scopes['inner-panel'][selectedTone].body.enabled) return
  layers.scopes['inner-panel'][selectedTone].body.enabled = false
  state.draft.appearanceLayers = layers
}
function backgroundInputChanged(event: Event): void {
  if (event.target instanceof HTMLInputElement && !characterBusy.value)
    clearInnerBackgroundOverride()
}
function setBackgroundKind(kind: 'color' | 'image'): void {
  if (characterBusy.value) return
  editableBackground().kind = kind
  clearInnerBackgroundOverride()
}
function chooseCharacterBackgroundImage(): void {
  if (characterBusy.value) return
  target.value = 'global'
  chooseImage()
}
async function importImage(event: Event): Promise<void> {
  const hasFile = !!(event.target as HTMLInputElement).files?.length
  const selectedTarget = target.value
  const selectedTone = tone.value
  await importBackgroundImage(event)
  if (hasFile && selectedTarget === 'global' && !state.error)
    clearInnerBackgroundOverride(selectedTone, selectedTarget)
}
const history = useAppearanceHistory(
  () => state.draft,
  (draft) => {
    state.draft = draft
  }
)
// The character editor owns the daily appearance draft; empty history never changes its task.
const themeHistorySelected = computed(() => !props.characterEditor && props.themePanelOpen)
const canUndoSelected = computed(() =>
  themeHistorySelected.value ? props.themeHistory?.canUndo : history.canUndo.value
)
const canRedoSelected = computed(() =>
  themeHistorySelected.value ? props.themeHistory?.canRedo : history.canRedo.value
)
const historyScope = computed(() => (themeHistorySelected.value ? '主题' : '外观'))
function undoAppearance(): void {
  if (themeHistorySelected.value) void props.themeHistory?.undo()
  else history.undo()
}
function redoAppearance(): void {
  if (themeHistorySelected.value) void props.themeHistory?.redo()
  else history.redo()
}
function resetAdjustableAppearance(): void {
  const radii = {
    light: state.draft.cardAppearance.light.borderRadius,
    dark: state.draft.cardAppearance.dark.borderRadius
  }
  resetCurrent()
  state.draft.cardAppearance.light.borderRadius = radii.light
  state.draft.cardAppearance.dark.borderRadius = radii.dark
}
function characterKeydown(event: KeyboardEvent): void {
  if (
    !props.characterEditor ||
    !props.active ||
    event.defaultPrevented ||
    characterBusy.value ||
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== 'z' ||
    (event.target as HTMLElement).closest?.(
      'input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"],[contenteditable=""]'
    )
  )
    return
  event.preventDefault()
  if (event.shiftKey) redoAppearance()
  else undoAppearance()
}
onMounted(() => window.addEventListener('keydown', characterKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', characterKeydown))
async function cancel(): Promise<void> {
  if (layerImporting.value || importing.value) return
  await cancelDraft()
  history.reset()
}
async function save(): Promise<void> {
  if (layerImporting.value) return
  await saveDraft()
  if (!hasChanges.value) history.reset()
}
async function prepareLeave(): Promise<boolean> {
  if (state.saving || importing.value || layerImporting.value) return false
  if (hasChanges.value) {
    if (!window.confirm('放弃尚未应用的外观调整？')) return false
    await cancel()
  }
  return true
}
async function apply(): Promise<boolean> {
  if (state.saving || importing.value || layerImporting.value || hasConflict.value) return false
  if (hasChanges.value) await save()
  return !state.error && !hasChanges.value
}
watch(
  () => props.externalTone,
  (value) => {
    if (value) tone.value = value === 'dark' ? 'dark' : 'light'
  },
  { immediate: true }
)
defineExpose({
  prepareLeave,
  apply,
  cancel,
  canUndo: history.canUndo,
  canRedo: history.canRedo,
  undo: history.undo,
  redo: history.redo,
  resetView: returnToWindow,
  preview: characterPreview,
  previewPart: characterPart,
  previewBusy: computed(() => state.saving || importing.value || layerImporting.value),
  collapse: async () => {
    if (layerImporting.value) return false
    if (detailedOpen.value) {
      detailedOpen.value = false
      return true
    }
    if (props.characterEditor && characterPart.value !== 'overview') {
      await returnToWindow()
      return true
    }
    return false
  },
  setTone: (value: 'pureWhite' | 'dark') => {
    if (layerImporting.value) return
    setTone(value === 'dark' ? 'dark' : 'light')
  },
  reset: resetAdjustableAppearance,
  hasChanges,
  previewDraft: computed(() => state.draft),
  tone
})
watch(hasChanges, (dirty) => emit('draftChange', dirty), { immediate: true })
watch(tone, (value) => emit('toneChange', value === 'dark' ? 'dark' : 'pureWhite'))
</script>
<template>
  <Teleport to="body" :disabled="embedded">
    <div
      v-if="embedded || appearanceEditorOpen"
      v-show="!state.fullWindow"
      class="appearance-editor-backdrop"
      :class="{
        'appearance-editor-backdrop--embedded': embedded,
        'appearance-editor-backdrop--controls': controlsOnly
      }"
    >
      <section
        :ref="
          (element) => {
            dialogRef = element as HTMLElement | null
          }
        "
        class="appearance-editor"
        :id="embedded ? 'appearance-workspace' : undefined"
        :role="embedded ? 'region' : 'dialog'"
        :aria-modal="embedded ? undefined : true"
        :class="{
          'appearance-editor--embedded': embedded,
          'appearance-editor--character': characterEditor,
          'appearance-editor--external-toolbar': externalToolbar
        }"
        :aria-labelledby="
          characterEditor ? undefined : embedded ? 'appearance-workspace-title' : 'appearance-title'
        "
        :aria-label="characterEditor ? '外观部件编辑器' : undefined"
        tabindex="-1"
      >
        <header v-if="!embedded" class="appearance-editor-header">
          <div>
            <h2 id="appearance-title">背景与界面材质</h2>
            <p>搭配你的背景，预览满意后保存。</p>
          </div>
          <button
            type="button"
            class="appearance-icon-button"
            aria-label="取消并关闭"
            :disabled="state.saving || busy"
            @click="cancel"
          >
            <i class="pi pi-times" />
          </button>
        </header>
        <div v-if="characterEditor" class="appearance-character-workspace">
          <div
            ref="characterBody"
            class="appearance-character-body"
            :class="{ 'is-focused': characterPart !== 'overview' }"
          >
            <div class="appearance-character-canvas">
              <div v-if="!externalToolbar" class="appearance-character-heading">
                <div>
                  <button
                    v-if="characterPart !== 'overview'"
                    class="appearance-return"
                    @click="returnToWindow"
                  >
                    <i class="pi pi-arrow-left" aria-hidden="true" />返回整窗
                  </button>
                  <h3 v-else id="appearance-workspace-title">窗口预览</h3>
                  <span v-if="characterPart !== 'overview'">{{ partInfo.label }}预览</span>
                </div>
                <div class="appearance-zoom-tools" aria-label="部件预览缩放">
                  <small>滚轮缩放 · 拖动平移</small>
                  <button
                    type="button"
                    data-preview-layer-toggle
                    aria-label="3D 叠层展示"
                    :aria-pressed="characterPreview?.layeredView ?? false"
                    :disabled="characterBusy"
                    @click="characterPreview?.setLayeredView(!characterPreview?.layeredView)"
                  >
                    <i class="pi pi-box" aria-hidden="true" />3D
                  </button>
                  <label v-if="characterPreview?.layeredView" class="appearance-layer-spacing">
                    <span>展开</span>
                    <input
                      type="range"
                      min="0"
                      max="80"
                      step="1"
                      aria-label="3D 层间距"
                      :value="characterPreview.layerSpacing"
                      :aria-valuetext="
                        characterPreview.layerSpacing === 0
                          ? '合拢'
                          : `${Math.round((characterPreview.layerSpacing / 80) * 100)}% 展开`
                      "
                      :disabled="characterBusy"
                      @input="
                        characterPreview?.setLayerSpacing(
                          Number(($event.target as HTMLInputElement).value)
                        )
                      "
                    />
                  </label>
                  <button
                    v-if="characterPart === 'navigation'"
                    type="button"
                    data-preview-navigation-toggle
                    :aria-expanded="characterPreview?.navigationExpanded"
                    :disabled="characterBusy"
                    @click="characterPreview?.toggleNavigation()"
                  >
                    {{ characterPreview?.navigationExpanded ? '收起侧边栏' : '展开侧边栏' }}
                  </button>
                  <button aria-label="缩小部件" @click="characterPreview?.zoomOut()">
                    <i class="pi pi-minus" aria-hidden="true" /></button
                  ><button aria-label="放大部件" @click="characterPreview?.zoomIn()">
                    <i class="pi pi-plus" aria-hidden="true" /></button
                  ><button @click="characterPreview?.fitPart()">适合部件</button>
                </div>
              </div>
              <div class="appearance-character-viewport">
                <AppearanceWindowPreview
                  :pages="pages"
                  ref="characterPreview"
                  :draft="state.draft"
                  :tone="tone"
                  :page="previewPage"
                  :focused-region="characterPart"
                  :active="active && !state.fullWindow"
                  :theme-editing="themeDirty && !hasChanges"
                  @region="selectRegion"
                >
                  <template #context-tools>
                    <AppearanceSurfaceInspector
                      horizontal
                      :pages="pages"
                      v-if="
                        active && !state.fullWindow && characterPart !== 'overview' && !detailedOpen
                      "
                      v-model:collapsed="inspectorCollapsed"
                      :draft="state.draft"
                      :tone="tone"
                      :glass-tone="characterPreview?.glassTone"
                      :part="characterPart"
                      :current-color="currentPartColor"
                      :player-mode="state.draft.playerBar?.mode ?? settings.playerBar.mode"
                      :busy="characterBusy"
                      @update:draft="state.draft = $event"
                      @importing-change="layerImporting = $event"
                      @image="chooseCharacterBackgroundImage"
                      @more="openMore"
                    />
                  </template>
                </AppearanceWindowPreview>
              </div>
            </div>
          </div>
          <p class="appearance-character-hint" role="status">
            {{
              characterPart === 'overview'
                ? partInfo.description
                : '调整只改变预览，应用后保存。按 Esc 返回整窗。'
            }}
          </p>
        </div>
        <Teleport :to="characterBody || 'body'" :disabled="!characterEditor || !characterBody">
          <div
            v-show="!characterEditor || detailedOpen"
            class="appearance-editor-layout"
            :class="{ 'appearance-character-advanced': characterEditor }"
          >
            <div
              v-if="embedded && !controlsOnly && !characterEditor"
              class="appearance-orbit"
              :style="stageStyle"
              aria-label="外观工作台"
            >
              <div class="appearance-orbit-toolbar">
                <div>
                  <h3 id="appearance-workspace-title">窗口预览</h3>
                  <p>等比例预览 · 示例歌曲与默认信息</p>
                </div>
                <div
                  v-if="!compactToolbar"
                  class="appearance-segment"
                  role="group"
                  aria-label="编辑与预览主题"
                >
                  <button
                    v-for="mode in ['light', 'dark'] as const"
                    :key="mode"
                    type="button"
                    :aria-pressed="tone === mode"
                    @click="setTone(mode)"
                  >
                    {{ mode === 'light' ? '浅色' : '深色' }}
                  </button>
                </div>
              </div>
              <div ref="centerRef" class="appearance-orbit-center">
                <div
                  class="appearance-mini-window appearance-real-window"
                  :style="previewStyle"
                  :data-preview-material="state.draft.surfaceMaterial"
                >
                  <AppearanceWindowPreview
                    :pages="pages"
                    :draft="state.draft"
                    :tone="tone"
                    :page="previewPage"
                    :theme-editing="themeDirty && !hasChanges"
                    @region="selectRegion"
                  />
                </div>
              </div>
              <div class="appearance-tools" role="group" aria-label="窗口外观工具">
                <div
                  v-for="position in ['left', 'right', 'bottom']"
                  :key="position"
                  class="appearance-orbit-options"
                >
                  <button
                    v-for="item in orbitGroups.filter((group) => group.position === position)"
                    :key="item.id"
                    type="button"
                    class="appearance-orbit-option"
                    :aria-pressed="quickOpen && selectedRegion === item.id"
                    @click="selectRegion(item.id, $event)"
                    :aria-label="item.label"
                    :title="item.label"
                  >
                    <i :class="item.icon" aria-hidden="true" /><span>{{ item.label }}</span>
                  </button>
                </div>
              </div>
              <p class="appearance-preview-hint">也可以直接点击预览中的区域</p>
            </div>
            <aside v-else-if="!controlsOnly && !characterEditor" class="appearance-preview-panel">
              <div v-if="embedded" class="appearance-workspace-heading">
                <div>
                  <h3 id="appearance-workspace-title">你的界面</h3>
                  <p>选择背景，搭配属于你的外观。</p>
                </div>
                <span role="status">{{ hasChanges ? '尚未应用' : '当前外观' }}</span>
              </div>
              <div class="appearance-preview-toolbar">
                <select v-model="previewPage" aria-label="预览页面">
                  <option v-for="page in pageOptions" :key="page.value" :value="page.value">
                    {{ page.label }}
                  </option>
                </select>
                <div class="appearance-segment" role="group" aria-label="编辑与预览主题">
                  <button
                    v-for="mode in ['light', 'dark'] as const"
                    :key="mode"
                    type="button"
                    :aria-pressed="tone === mode"
                    @click="setTone(mode)"
                  >
                    {{ mode === 'light' ? '浅色' : '深色' }}
                  </button>
                </div>
              </div>
              <div
                class="appearance-mini-window"
                :style="previewStyle"
                :data-preview-material="state.draft.surfaceMaterial"
              >
                <div class="app-background-layer app-background-layer--preview" aria-hidden="true">
                  <div class="app-background-image" />
                  <div class="app-background-dim" />
                </div>
                <button
                  v-if="embedded"
                  type="button"
                  class="appearance-mini-title appearance-preview-region"
                  aria-label="调整标题栏材质"
                  @click="area = 'material'"
                >
                  Twilight Echo <span><i class="pi pi-search" /><i class="pi pi-cog" /></span>
                </button>
                <div v-else class="appearance-mini-title">Twilight Echo <span>⌕ ⚙</span></div>
                <div class="appearance-mini-body">
                  <button
                    v-if="embedded"
                    type="button"
                    class="appearance-mini-sidebar appearance-preview-region"
                    aria-label="调整侧边栏材质"
                    @click="area = 'material'"
                  >
                    <strong><i class="pi pi-home" />主页</strong
                    ><span><i class="pi pi-search" />搜索</span
                    ><span><i class="pi pi-headphones" />音乐库</span
                    ><span><i class="pi pi-heart" />我的收藏</span>
                  </button>
                  <nav v-else class="appearance-mini-sidebar">
                    <strong>♫ 本地音乐</strong><span>♧ 歌手</span><span>◉ 专辑</span
                    ><span>♡ 我的收藏</span>
                  </nav>
                  <div class="appearance-mini-content">
                    <h3>{{ pageOptions.find((page) => page.value === previewPage)?.label }}</h3>
                    <template v-if="previewPage === 'settings'"
                      ><div class="appearance-mini-card">外观设置<small>文字与背景预览</small></div>
                      <div class="appearance-mini-card">
                        播放设置<small>保留清晰的操作反馈</small>
                      </div></template
                    ><template v-else-if="previewPage === 'player'"
                      ><div class="appearance-mini-cover">♫</div>
                      <strong>夜航星</strong>
                      <p>在夜色中听见回响</p></template
                    ><template v-else
                      ><div
                        v-for="(title, index) in embedded
                          ? ['夜航星', 'MASAYUME CHASING']
                          : ['夜航星', 'MASAYUME CHASING', '如诗一般的形容你']"
                        :key="title"
                        class="appearance-mini-track"
                      >
                        <span
                          class="appearance-mini-art"
                          :style="{ background: ['#566b8a', '#936373', '#4e827b'][index] }"
                          >♫</span
                        ><span
                          ><strong>{{ title }}</strong
                          ><small>{{ ['未知歌手', 'BoA', '周杰伦'][index] }}</small></span
                        ><small>03:40</small>
                      </div>
                      <div class="appearance-mini-card">
                        我的歌单 <small>卡片外观预览</small>
                      </div></template
                    >
                  </div>
                </div>
                <div class="appearance-mini-player">
                  <template v-if="embedded"
                    ><span><i class="pi pi-headphones" /> 夜航星</span
                    ><button
                      type="button"
                      class="appearance-preview-region"
                      aria-label="调整播放条布局"
                      @click="emit('focusSetting', 'player-bar')"
                    >
                      <i class="pi pi-step-backward" /><i class="pi pi-play-circle" /><i
                        class="pi pi-step-forward"
                      /></button
                    ><i class="pi pi-list"
                  /></template>
                  <template v-else
                    ><span>♫ 夜航星</span><strong>⏮ ▶ ⏭</strong><span>☷</span></template
                  >
                </div>
              </div>
              <p class="appearance-preview-hint">
                {{
                  state.draft.surfaceMaterial === 'transparent'
                    ? '背景上保留文字、封面和操作反馈；菜单与弹窗保留底板。'
                    : embedded
                      ? '点击标题栏、侧边栏或播放条，调整对应区域。'
                      : '缩略图展示主要搭配，全窗口预览可查看实际界面。'
                }}
              </p>
              <button
                type="button"
                class="appearance-recipe"
                :disabled="state.saving || busy"
                @click="useTransparentRecipe"
              >
                <i class="pi pi-eye" /> {{ matching ? '正在分析图片…' : '图片通透推荐搭配' }}
              </button>
              <button
                v-if="embedded"
                type="button"
                class="appearance-workspace-text-link"
                @click="emit('focusSetting', 'global-font')"
              >
                <i class="pi pi-align-left" />文字与排版<i class="pi pi-arrow-right" />
              </button>
            </aside>
            <div
              :ref="
                (element) => {
                  bodyRef = element as HTMLElement | null
                }
              "
              class="appearance-editor-controls"
              v-show="!externalPanel && (controlsOnly || !embedded || detailedOpen)"
            >
              <nav class="appearance-section-links" aria-label="详细属性">
                <strong v-if="characterEditor">{{ partInfo.label }}设置</strong>
                <button
                  v-for="item in characterEditor
                    ? characterBackground
                      ? (['background', 'advanced'] as const)
                      : []
                    : (['background', 'material', 'advanced'] as const)"
                  :key="item"
                  :data-appearance-area="item"
                  type="button"
                  :aria-pressed="area === item"
                  @click="selectDetailedArea(item)"
                >
                  {{ { background: '背景', material: '材质', advanced: '细节' }[item] }}
                </button>
                <button
                  v-if="embedded && !controlsOnly"
                  type="button"
                  :aria-label="characterEditor ? '返回部件属性' : '关闭背景详细设置'"
                  @click="detailedOpen = false"
                >
                  <i class="pi pi-times" aria-hidden="true" />
                </button>
              </nav>
              <fieldset v-if="characterEditor && characterPart === 'card'" :disabled="state.saving">
                <CardAppearanceSettings v-model="state.draft" :tone="tone" @update:tone="setTone" />
              </fieldset>
              <section
                :id="embedded ? 'workspace-background' : 'appearance-background'"
                v-show="
                  (!characterEditor || characterBackground) && (!embedded || area === 'background')
                "
                class="appearance-control-section"
                @input.capture="backgroundInputChanged"
              >
                <h3>背景</h3>
                <p class="appearance-section-description">
                  图片、颜色和文字搭配。当前编辑{{ tone === 'light' ? '浅色' : '深色' }}模式。
                </p>
                <label class="appearance-field"
                  >应用范围<select v-model="target" aria-label="背景应用范围">
                    <option value="global">统一背景</option>
                    <option v-for="page in pageOptions" :key="page.value" :value="page.value">
                      {{ page.label }}单独覆盖
                    </option>
                  </select></label
                >
                <label v-if="target !== 'global'" class="appearance-checkbox"
                  ><input
                    type="checkbox"
                    :checked="inherited"
                    :disabled="state.saving"
                    @change="setInheritance"
                  />继承统一背景</label
                >
                <fieldset :disabled="inherited || state.saving || importing">
                  <div class="appearance-segment">
                    <button
                      v-for="kind in ['color', 'image'] as const"
                      :key="kind"
                      type="button"
                      :aria-pressed="activeBackground.kind === kind"
                      @click="setBackgroundKind(kind)"
                    >
                      {{ kind === 'color' ? '纯色' : '图片' }}
                    </button>
                  </div>
                  <label class="appearance-color-field"
                    >{{ activeBackground.kind === 'image' ? '图片回退底色' : '背景颜色'
                    }}<input
                      type="color"
                      :value="activeBackground[tone]"
                      @input="
                        editableBackground()[tone] = ($event.target as HTMLInputElement).value
                      "
                    /><code>{{ activeBackground[tone] }}</code></label
                  >
                  <div v-if="activeBackground.kind === 'image'" class="appearance-image-actions">
                    <button type="button" @click="chooseImage">
                      <span
                        v-if="embedded"
                        class="appearance-image-thumbnail"
                        :style="{
                          backgroundImage: previewStyle['--appearance-image'],
                          backgroundColor: activeBackground[tone]
                        }"
                        aria-hidden="true"
                        ><i v-if="!activeBackground.image" class="pi pi-plus"
                      /></span>
                      <i class="pi pi-image" />{{
                        activeBackground.image ? '更换图片' : '选择图片'
                      }}</button
                    ><button type="button" :disabled="!activeBackground.image" @click="removeImage">
                      移除</button
                    ><small>JPG / PNG / WebP · 最大 20MB</small>
                  </div>
                  <div
                    v-for="field in (hasBackgroundImage
                      ? embedded
                        ? ['blur', 'dim']
                        : ['blur', 'dim', 'brightness', 'scale']
                      : []) as Array<'blur' | 'dim' | 'brightness' | 'scale'>"
                    :key="field"
                    class="appearance-slider"
                  >
                    <label :for="`${embedded ? 'workspace' : 'background'}-${field}`">{{
                      ranges[field].label
                    }}</label
                    ><EditableRangeValue
                      :value="effect[field]"
                      v-bind="ranges[field]"
                      :aria-label="ranges[field].label"
                      @change="setEffect(field, $event)"
                    /><input
                      :id="`${embedded ? 'workspace' : 'background'}-${field}`"
                      type="range"
                      v-bind="ranges[field]"
                      :value="effect[field]"
                      @input="setEffect(field, Number(($event.target as HTMLInputElement).value))"
                    />
                  </div>
                  <div class="appearance-field">
                    文字明暗
                    <div class="appearance-segment">
                      <button
                        v-for="text in ['theme', 'light', 'dark'] as const"
                        :key="text"
                        type="button"
                        :aria-pressed="effect.textTone === text"
                        @click="setEffect('textTone', text)"
                      >
                        {{
                          text === 'theme' && activeBackground.imagePalette
                            ? '自动'
                            : { theme: '跟随主题', light: '浅色', dark: '深色' }[text]
                        }}
                      </button>
                    </div>
                  </div>
                </fieldset>
              </section>
              <section
                :id="embedded ? 'workspace-material' : 'appearance-material'"
                v-show="!characterEditor && (!embedded || area === 'material')"
                class="appearance-control-section"
              >
                <h3>界面材质</h3>
                <p class="appearance-section-description">用于主界面，菜单和弹窗始终保持可读。</p>
                <div class="appearance-material-options">
                  <button
                    v-for="material in materials"
                    :key="material.value"
                    type="button"
                    :aria-pressed="activeMaterial === material.value"
                    :disabled="state.saving"
                    @click="selectMaterial(material.value)"
                  >
                    <i :class="material.icon" />{{ material.label }}
                  </button>
                </div>
              </section>
              <section
                :id="embedded ? 'workspace-advanced' : 'appearance-advanced'"
                v-show="
                  (!characterEditor || characterBackground) && (!embedded || area === 'advanced')
                "
                class="appearance-control-section"
              >
                <button
                  type="button"
                  class="appearance-advanced-trigger"
                  :aria-expanded="advancedOpen"
                  @click="advancedOpen = !advancedOpen"
                >
                  <h3>高级设置</h3>
                  <i :class="advancedOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" />
                </button>
                <div v-if="advancedOpen">
                  <fieldset v-if="hasBackgroundImage" :disabled="inherited || state.saving">
                    <div
                      v-for="field in (embedded
                        ? ['brightness', 'scale', 'positionX', 'positionY']
                        : ['positionX', 'positionY']) as Array<
                        'brightness' | 'scale' | 'positionX' | 'positionY'
                      >"
                      :key="field"
                      class="appearance-slider"
                    >
                      <label :for="`${embedded ? 'workspace' : 'background'}-${field}`">{{
                        ranges[field].label
                      }}</label
                      ><EditableRangeValue
                        :value="effect[field]"
                        v-bind="ranges[field]"
                        @change="setEffect(field, $event)"
                      /><input
                        :id="`${embedded ? 'workspace' : 'background'}-${field}`"
                        type="range"
                        v-bind="ranges[field]"
                        :value="effect[field]"
                        @input="setEffect(field, Number(($event.target as HTMLInputElement).value))"
                      />
                    </div>
                  </fieldset>
                  <fieldset v-if="!characterEditor" :disabled="state.saving">
                    <CardAppearanceSettings
                      v-model="state.draft"
                      :tone="tone"
                      @update:tone="setTone"
                    /><LiquidGlassSettings
                      v-model="state.draft"
                      :tone="tone"
                      @update:tone="setTone"
                    />
                  </fieldset>
                </div>
              </section>
            </div>
          </div>
        </Teleport>
        <p v-if="imagePaletteNotice" class="appearance-character-hint" role="status">
          {{ imagePaletteNotice }}
        </p>
        <p v-if="state.error" class="appearance-error" role="alert">{{ state.error }}</p>
        <footer v-if="characterEditor" class="appearance-character-footer">
          <div class="appearance-history-buttons">
            <button
              :disabled="characterBusy || !canUndoSelected"
              :aria-label="`撤销${historyScope}调整`"
              :title="`撤销${historyScope}调整`"
              @click="undoAppearance"
            >
              <i class="pi pi-undo" aria-hidden="true" /></button
            ><button
              :disabled="characterBusy || !canRedoSelected"
              :aria-label="`重做${historyScope}调整`"
              :title="`重做${historyScope}调整`"
              @click="redoAppearance"
            >
              <i class="pi pi-refresh" aria-hidden="true" /></button
            ><button
              class="appearance-full-preview"
              aria-label="全窗口预览"
              title="全窗口预览"
              :disabled="characterBusy"
              @click="fullPreview(true)"
            >
              <i class="pi pi-window-maximize" aria-hidden="true" /><span>全窗口预览</span>
            </button>
          </div>
          <div class="appearance-part-tools">
            <nav aria-label="预览范围" class="appearance-part-group">
              <button
                data-part="overview"
                title="整窗"
                :aria-pressed="characterPart === 'overview'"
                :disabled="characterBusy"
                @click="focusPart('overview')"
              >
                <i class="pi pi-desktop" aria-hidden="true" /><span>整窗</span>
              </button>
            </nav>
            <nav aria-label="选择外观部件" class="appearance-part-group">
              <button
                v-for="part in APPEARANCE_PARTS.filter(
                  (item) => !['overview', 'global-font', 'appearance-theme'].includes(item.id)
                )"
                :key="part.id"
                :data-part="part.id"
                :title="part.label"
                :aria-pressed="characterPart === part.id"
                :disabled="characterBusy"
                @click="focusPart(part.id)"
              >
                <i :class="part.icon" aria-hidden="true" /><span>{{ part.label }}</span>
              </button>
            </nav>
            <nav aria-label="主题样式" class="appearance-part-group appearance-part-group--theme">
              <button
                v-for="part in APPEARANCE_PARTS.filter((item) =>
                  ['global-font', 'appearance-theme'].includes(item.id)
                )"
                :key="part.id"
                :data-part="part.id"
                :title="part.label"
                :aria-pressed="characterPart === part.id"
                :disabled="characterBusy"
                @click="focusPart(part.id)"
              >
                <i :class="part.icon" aria-hidden="true" /><span>{{ part.label }}</span>
              </button>
            </nav>
          </div>
          <span role="status">{{
            characterBusy
              ? '正在处理…'
              : hasChanges || themeDirty
                ? '有未应用的调整'
                : '当前外观已保存'
          }}</span>
          <div>
            <button
              :disabled="characterBusy || (!hasChanges && !themeDirty)"
              @click="discard ? discard() : cancel()"
            >
              放弃调整</button
            ><button
              class="appearance-save"
              :disabled="characterBusy || hasConflict || (!hasChanges && !themeDirty)"
              @click="commit ? commit() : save()"
            >
              {{ characterBusy ? '应用中…' : '应用外观' }}
            </button>
          </div>
        </footer>
        <footer v-else-if="!controlsOnly" class="appearance-editor-footer">
          <button
            type="button"
            :disabled="state.saving || importing"
            @click="resetAdjustableAppearance"
          >
            恢复当前项默认</button
          ><button type="button" :disabled="state.saving || busy" @click="fullPreview(true)">
            全窗口预览</button
          ><span /><button
            type="button"
            :disabled="state.saving || importing || (embedded && !hasChanges && !themeDirty)"
            @click="discard ? discard() : cancel()"
          >
            {{ embedded ? '放弃调整' : '取消' }}</button
          ><button
            type="button"
            class="appearance-save"
            :disabled="
              state.saving || importing || hasConflict || (embedded && !hasChanges && !themeDirty)
            "
            @click="commit ? commit() : save()"
          >
            {{
              importing
                ? '导入中…'
                : state.saving
                  ? '保存中…'
                  : embedded
                    ? '应用外观'
                    : '保存并使用'
            }}
          </button>
        </footer>
        <input
          :ref="
            (element) => {
              fileInput = element as HTMLInputElement | null
            }
          "
          type="file"
          accept="image/jpeg,image/png,image/webp"
          class="appearance-file-input"
          @change="importImage"
        />
      </section>
    </div>
  </Teleport>
  <AppearancePopover
    v-if="embedded && !controlsOnly && !characterEditor"
    :open="quickOpen && !state.fullWindow"
    :anchor="quickAnchor"
    :label="`${orbitGroups.find((item) => item.id === selectedRegion)?.label ?? '卡片'}外观`"
    @close="quickOpen = false"
  >
    <div class="appearance-quick-heading">
      <strong>{{
        orbitGroups.find((item) => item.id === selectedRegion)?.label ?? '内容卡片'
      }}</strong
      ><span>{{
        quickTab === 'font' || quickTab === 'player' || quickTab === 'theme'
          ? '即时生效'
          : tone === 'dark'
            ? '深色外观'
            : '浅色外观'
      }}</span>
    </div>
    <div
      v-if="quickTab !== 'font' && quickTab !== 'player'"
      class="appearance-quick-tabs"
      role="group"
      aria-label="外观选项"
    >
      <button
        v-for="tab in ['color', 'image', 'material', 'theme'] as const"
        :key="tab"
        type="button"
        :aria-pressed="quickTab === tab"
        @click="quickTab = tab"
      >
        {{ { color: '颜色', image: '图片', material: '材质', theme: '主题' }[tab] }}
      </button>
    </div>
    <div v-if="quickTab === 'color'" class="appearance-quick-body">
      <span class="appearance-quick-scope">{{
        selectedRegion === 'card' ? '内容卡片颜色' : '统一背景颜色'
      }}</span>
      <div class="appearance-quick-swatches" role="group" aria-label="颜色">
        <button
          v-for="color in quickColors"
          :key="color"
          type="button"
          :style="{ backgroundColor: color }"
          :aria-label="`选择颜色 ${color}`"
          :aria-pressed="quickColor === color"
          :disabled="state.saving || importing"
          @click="changeQuickColor(color)"
        >
          <i v-if="quickColor === color" class="pi pi-check" />
        </button>
      </div>
      <label class="appearance-quick-row"
        >自定颜色<input
          type="color"
          :value="quickColor"
          :disabled="state.saving || importing"
          @input="changeQuickColor(($event.target as HTMLInputElement).value)"
      /></label>
    </div>
    <div v-else-if="quickTab === 'image'" class="appearance-quick-body">
      <button
        type="button"
        class="appearance-quick-image"
        :disabled="state.saving || importing"
        @click="chooseImage"
      >
        <span :style="{ backgroundImage: previewStyle['--appearance-image'] }"
          ><i v-if="!activeBackground.image" class="pi pi-image" /></span
        >{{ importing ? '导入中…' : activeBackground.image ? '更换背景图片' : '选择背景图片' }}
      </button>
      <label
        v-for="field in hasBackgroundImage ? (['blur', 'dim'] as const) : []"
        :key="field"
        class="appearance-quick-slider"
        ><span>{{ ranges[field].label }}</span
        ><input
          type="range"
          v-bind="ranges[field]"
          :value="effect[field]"
          :disabled="state.saving || importing"
          @input="setEffect(field, Number(($event.target as HTMLInputElement).value))"
      /></label>
    </div>
    <div v-else-if="quickTab === 'material'" class="appearance-quick-body">
      <span class="appearance-quick-scope">应用到整个界面</span>
      <div class="appearance-quick-materials">
        <button
          v-for="material in materials"
          :key="material.value"
          type="button"
          :aria-pressed="activeMaterial === material.value"
          :disabled="state.saving || importing"
          @click="selectMaterial(material.value)"
        >
          {{ material.label }}<i v-if="activeMaterial === material.value" class="pi pi-check" />
        </button>
      </div>
    </div>
    <div v-else-if="quickTab === 'theme'" class="appearance-quick-body">
      <p v-if="characterEditor">主题在「主题选择」页面切换。</p>
      <label v-else class="appearance-quick-row"
        >主题<select
          :value="selectedThemeId"
          :disabled="state.saving || importing"
          @change="chooseTheme"
        >
          <option v-if="!selectedThemeId" value="" disabled>当前自定主题</option>
          <option v-for="theme in BUILT_IN_THEME_PRESETS" :key="theme.id" :value="theme.id">
            {{ theme.name }}
          </option>
        </select></label
      >
      <div class="appearance-quick-tabs" role="group" aria-label="界面深浅色">
        <button
          v-for="mode in ['pureWhite', 'dark', 'system'] as const"
          :key="mode"
          type="button"
          :aria-pressed="settings.theme === mode"
          @click="changeQuickSetting({ theme: mode })"
        >
          {{ { pureWhite: '浅色', dark: '深色', system: '跟随系统' }[mode] }}
        </button>
      </div>
    </div>
    <div v-else-if="quickTab === 'font'" class="appearance-quick-body">
      <label class="appearance-quick-row"
        >字体<select
          :value="settings.fontFamily"
          @change="
            changeQuickSetting({
              fontFamily: normalizeAppFontFamily(($event.target as HTMLSelectElement).value)
            })
          "
        >
          <option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select></label
      >
    </div>
    <div v-else class="appearance-quick-body">
      <div class="appearance-quick-materials">
        <button
          v-for="mode in ['standard', 'compact', 'mini'] as const"
          :key="mode"
          type="button"
          :aria-pressed="settings.playerBar.mode === mode"
          @click="changeQuickSetting({ playerBar: { ...settings.playerBar, mode } })"
        >
          {{ { standard: '标准播放栏', compact: '紧凑播放栏', mini: '迷你播放栏' }[mode]
          }}<i v-if="settings.playerBar.mode === mode" class="pi pi-check" />
        </button>
      </div>
    </div>
    <p v-if="quickError || state.error" class="appearance-quick-error" role="alert">
      {{ quickError || state.error }}
    </p>
    <div v-if="hasChanges" class="appearance-quick-save">
      <button type="button" :disabled="state.saving || importing" @click="cancel">放弃调整</button
      ><button type="button" :disabled="state.saving || importing || hasConflict" @click="save">
        {{ state.saving ? '保存中…' : '应用外观' }}
      </button>
    </div>
    <button type="button" class="appearance-quick-more" @click="moreSettings">
      更多设置<i class="pi pi-arrow-right" />
    </button>
  </AppearancePopover>
  <Teleport to="body">
    <div
      v-if="(embedded || appearanceEditorOpen) && state.fullWindow"
      class="appearance-full-preview-toolbar"
      role="region"
      aria-label="临时外观预览"
    >
      <span>外观预览 · 尚未保存</span
      ><button type="button" :disabled="state.saving" @click="fullPreview(false)">返回编辑</button
      ><button type="button" :disabled="state.saving" @click="cancel">取消</button
      ><button type="button" class="appearance-save" :disabled="state.saving" @click="save">
        {{ state.saving ? '保存中…' : '保存并使用' }}
      </button>
    </div>
  </Teleport>
</template>
<style src="./settings-page/BackgroundAppearanceCustomizer.css" />
