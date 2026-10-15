<script setup lang="ts">
import './settings-page/SettingsPage.css'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue'
import AppearanceSettingsSection from './settings-page/AppearanceSettingsSection.vue'
import AppearanceWindowPreview from './AppearanceWindowPreview.vue'
import AppearanceThemeSelection from './AppearanceThemeSelection.vue'
import { APPEARANCE_PARTS, resolveAppearancePart, type AppearancePart } from './appearanceParts'
import { useEscapeToClose } from '../app/useDismissLayer'
import {
  APPEARANCE_CATEGORIES,
  type AppearanceAction,
  type AppearanceCategory
} from './appearanceEditor'
import {
  BUILT_IN_THEME_PRESETS,
  TWILIGHT_DEFAULT_THEME_ID,
  getBuiltInThemePreset,
  isBuiltInThemePresetId,
  type ThemeSelection,
  type ThemeTone
} from '../../../shared/theme'
import { cloneAppearance } from '../../../shared/appAppearance'
import type { WorkshopProjectSummary } from '../../../shared/themeWorkshop'
import type { AppearanceWorkshopPreviewAdapter } from './appearanceWorkshopPreview'
import { useThemeStore } from '../stores/useThemeStore'
import { getPluginThemeKey } from '../extensions/themeSelection'
import { useExtensionRegistry } from '../extensions/registry'
import { provideSettingsDisclosures } from './settings-page/settingsDisclosureRegistry.ts'
import {
  SETTINGS_SEARCH_INDEX,
  settingsDisclosurePath,
  type SettingsSearchEntry
} from './settings-page/types.ts'
import type {
  AppearanceWorkspaceTab,
  SettingsNavigationTarget,
  ThemeStudioDomain
} from '../app/useAppNavigation.ts'
import { useBackHandler } from '../app/useBackStack'
import { scrollMotionBehavior } from '../app/scrollMotion.ts'
import { useSettingsStore } from '../stores/useSettingsStore'
import { readThemeStudioRecovery } from './theme-studio/themeStudioRecovery'
import type { NavigationPageDefinition } from '../app/navigationPages'
import { usePageDock, type PageDockAction } from '../app/pageDock'

const props = withDefaults(
  defineProps<{
    navigationTarget?: SettingsNavigationTarget
    active?: boolean
    initialDomain?: ThemeStudioDomain
    pages?: NavigationPageDefinition[]
  }>(),
  { active: true }
)
const emit = defineEmits<{
  back: []
  tabChange: [tab: AppearanceWorkspaceTab]
  domainChange: [domain: ThemeStudioDomain]
  openPlugins: []
}>()
const ThemeStudioPage = defineAsyncComponent(() => import('./ThemeStudioPage.vue'))
const ThemeWorkshopPage = defineAsyncComponent(
  () => import('./theme-workshop/ThemeWorkshopPage.vue')
)
const recovery = readThemeStudioRecovery()
const workspaceView = ref<'selection' | 'customize'>(recovery ? 'customize' : 'selection')
const selectionPage = ref<InstanceType<typeof AppearanceThemeSelection>>()
const tab = ref<AppearanceWorkspaceTab>(recovery ? 'studio' : 'adjust')
const loaded = ref(false)
const applying = ref(false)
const switching = ref(false)
const studio = ref<InstanceType<typeof ThemeStudioPage>>()
const workshop = ref<InstanceType<typeof ThemeWorkshopPage>>()
const appearanceSection = ref<InstanceType<typeof AppearanceSettingsSection>>()
const preview = ref<InstanceType<typeof AppearanceWindowPreview>>()
const pageRef = ref<HTMLElement | null>(null)
const creationModeButton = ref<HTMLButtonElement>()
const themeOptions = ref<HTMLDetailsElement>()
const themeOptionsOpen = ref(false)
const selected = ref(recovery?.selectedKey ?? 'preset:builtin:twilight-echo-default')
const category = ref('color')
const selectedPart = ref<AppearancePart>('overview')
const editorEpoch = ref(0)
const sourceToCustomize = ref<string>()
const startCreating = ref(false)
const sourceError = ref('')
const savedProjects = ref<WorkshopProjectSummary[]>([])
const dailyTone = ref<ThemeTone>(
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'pureWhite'
)
const pendingCreatorTone = ref<ThemeTone | undefined>(recovery?.tone)
const { settings, loadSettings } = useSettingsStore()
const themeStore = useThemeStore()
const disclosures = provideSettingsDisclosures()
const { uiContributions, themeContributions } = useExtensionRegistry()
const workshopEnabled = computed(() =>
  uiContributions.value.some(
    (item) =>
      item.pluginId === 'com.twilightecho.tool.theme-workshop' && item.id === 'theme-workshop'
  )
)
const currentEditor = computed(() =>
  tab.value === 'studio' ? studio.value : tab.value === 'workshop' ? workshop.value : undefined
)
const editorState = computed(() => currentEditor.value?.state)
const busy = computed(
  () =>
    !loaded.value ||
    switching.value ||
    applying.value ||
    selectionPage.value?.busy ||
    (tab.value === 'adjust' && appearanceSection.value?.previewBusy) ||
    (tab.value !== 'adjust' &&
      !(tab.value === 'workshop' && !workshopEnabled.value) &&
      (!editorState.value || editorState.value.busy))
)
function activeThemeKey(): string {
  const active = themeStore.activeTheme.value
  return active.kind === 'builtin'
    ? 'preset:' + active.id
    : active.kind === 'user'
      ? 'profile:' + active.id
      : 'plugin:' + active.pluginId + ':' + active.themeId
}
const sourceKey = computed(() =>
  tab.value === 'adjust' ? activeThemeKey() : (editorState.value?.key ?? selected.value)
)
const currentThemeName = computed(
  () =>
    BUILT_IN_THEME_PRESETS.find((item) => 'preset:' + item.id === sourceKey.value)?.name ??
    themeStore.profiles.value.find((item) => 'profile:' + item.id === sourceKey.value)?.name ??
    themeContributions.value.find((item) => 'plugin:' + getPluginThemeKey(item) === sourceKey.value)
      ?.name ??
    projects.value.find((item) => 'workshop:' + item.id === sourceKey.value)?.name ??
    '当前主题'
)
const tone = computed(() => editorState.value?.tone ?? dailyTone.value)
const projects = computed(() => workshop.value?.projects ?? savedProjects.value)
const creationDraft = computed(() =>
  cloneAppearance({
    ...settings.value,
    appearanceLayers: themeStore.effectiveThemeLayers?.value ?? settings.value.appearanceLayers
  })
)
const activePreview = computed(() =>
  tab.value === 'adjust' ? appearanceSection.value?.preview : preview.value
)
const activePreviewPart = computed(() =>
  tab.value === 'adjust' ? (appearanceSection.value?.previewPart ?? 'overview') : selectedPart.value
)
const workshopPreview = computed(() => workshop.value?.previewModel)
const workshopPreviewAdapter: AppearanceWorkshopPreviewAdapter = {
  async inspect() {
    if (!preview.value) throw new Error('共享预览尚未就绪')
    return await preview.value.inspectWorkshop()
  },
  highlight(selector) {
    preview.value?.highlightWorkshop(selector)
  }
}
const deletableProfile = computed(() =>
  sourceKey.value.startsWith('profile:')
    ? themeStore.profiles.value.find((profile) => 'profile:' + profile.id === sourceKey.value)
    : undefined
)
function resetPreview(): void {
  if (tab.value === 'adjust') void appearanceSection.value?.resetView()
  else selectedPart.value = 'overview'
}
async function showSelection(): Promise<boolean> {
  if (busy.value) return false
  if (workspaceView.value === 'selection') return true
  switching.value = true
  try {
    if (!(await prepareLeave())) return false
    tab.value = 'adjust'
    workspaceView.value = 'selection'
    setThemeOptions(false)
    emit('tabChange', 'adjust')
    return true
  } finally {
    switching.value = false
  }
}
function showCustomize(): void {
  if (busy.value) return
  workspaceView.value = 'customize'
}
const categories = computed<AppearanceCategory[]>(() => {
  if (tab.value === 'adjust') return []
  return [
    ...APPEARANCE_CATEGORIES.filter((item) =>
      tab.value === 'studio' ? item.studio : item.workshop
    ),
    ...(tab.value === 'workshop'
      ? (workshop.value?.customGroups ?? []).map((name) => ({
          id: 'custom:' + name,
          label: name,
          workshop: name
        }))
      : [])
  ]
})
const selectedCategory = computed(
  () => categories.value.find((item) => item.id === category.value) ?? categories.value[0]
)
const creatorPartInfo = computed(() =>
  APPEARANCE_PARTS.find((part) => part.id === selectedPart.value)
)
const creatorToolsRequested = ref(false)
const creatorContextVisible = computed(
  () =>
    selectedPart.value !== 'overview' ||
    creatorToolsRequested.value ||
    (tab.value === 'workshop' && !workshopEnabled.value)
)
const partCategory: Partial<Record<AppearancePart, string>> = {
  'inner-panel': 'background',
  background: 'background',
  navigation: 'navigation',
  material: 'material',
  'player-bar': 'player',
  card: 'material',
  'global-font': 'font',
  'appearance-theme': 'color'
}
function chooseCategory(value: string): void {
  category.value = value
  if (value === 'navigation' && preview.value?.navigationExpanded === false)
    preview.value.toggleNavigation()
  if (partCategory[selectedPart.value] === value) return
  selectedPart.value =
    (Object.entries(partCategory).find(([, group]) => group === value)?.[0] as
      | AppearancePart
      | undefined) ?? 'overview'
}
function selectCreatorPart(part: AppearancePart): void {
  if (busy.value) return
  if (part === 'navigation' && preview.value?.navigationExpanded === false)
    preview.value.toggleNavigation()
  creatorToolsRequested.value = false
  selectedPart.value = resolveAppearancePart(part)
  if (partCategory[selectedPart.value]) category.value = partCategory[selectedPart.value]!
}
function focusCreatorProperties(): void {
  if (tab.value === 'adjust') return
  if (busy.value) {
    pendingCreatorFocus = { tab: tab.value, epoch: editorEpoch.value }
    return
  }
  pageRef.value
    ?.querySelector<HTMLElement>('[data-appearance-context] :is(button, input, select)')
    ?.focus({ preventScroll: true })
}
async function openContextTools(tool = 'project'): Promise<void> {
  if (busy.value || tab.value === 'adjust') return
  creatorToolsRequested.value = true
  setThemeOptions(false)
  await nextTick()
  if (tab.value === 'studio') await studio.value?.openTools()
  else await workshop.value?.openTools(tool)
}
async function openCategory(value: string): Promise<void> {
  chooseCategory(value)
  await openContextTools('more')
  if (tab.value === 'workshop' && selectedCategory.value?.workshop)
    workshop.value?.selectGroup(selectedCategory.value.workshop)
}
function togglePreviewView(): void {
  if (busy.value || !activePreview.value) return
  activePreview.value.setLayeredView(!activePreview.value.layeredView)
}
async function prepareLeave(): Promise<boolean> {
  if (applying.value) return false
  if (tab.value === 'adjust') return (await appearanceSection.value?.prepareLeave()) ?? true
  if (tab.value === 'workshop' && !workshopEnabled.value && !workshop.value) return true
  return (await currentEditor.value?.prepareLeave()) ?? false
}
function setThemeOptions(open: boolean, focus = false): void {
  if (themeOptions.value) themeOptions.value.open = open
  themeOptionsOpen.value = open
  if (focus) themeOptions.value?.querySelector('summary')?.focus({ preventScroll: true })
}
function themeOptionsFocusOut(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && !themeOptions.value?.contains(event.relatedTarget))
    setThemeOptions(false)
}
function dismissThemeOptions(event: PointerEvent): void {
  if (
    themeOptionsOpen.value &&
    event.target instanceof Node &&
    !themeOptions.value?.contains(event.target)
  )
    setThemeOptions(false)
}
async function enterCreator(
  region?: string,
  workspace: 'studio' | 'workshop' = 'studio'
): Promise<boolean> {
  if (busy.value) return false
  workspaceView.value = 'customize'
  if (tab.value !== 'adjust') {
    if (region) selectCreatorPart(region as AppearancePart)
    return true
  }
  switching.value = true
  sourceError.value = ''
  try {
    if (!(await prepareLeave())) return false
    selected.value =
      workspace === 'studio' ? activeThemeKey() : 'workshop:' + (projects.value[0]?.id ?? 'new')
    sourceToCustomize.value = undefined
    startCreating.value = workspace === 'workshop' && selected.value === 'workshop:new'
    pendingCreatorTone.value = dailyTone.value
    tab.value = workspace
    editorEpoch.value++
    category.value =
      workspace === 'workshop'
        ? 'theme'
        : region
          ? (partCategory[region as AppearancePart] ?? 'color')
          : 'color'
    selectedPart.value = resolveAppearancePart(
      (region as AppearancePart | undefined) ??
        (workspace === 'studio' ? 'appearance-theme' : 'overview')
    )
    creatorToolsRequested.value = false
    emit('tabChange', workspace)
    await nextTick()
    focusCreatorProperties()
    return true
  } finally {
    switching.value = false
  }
}
async function returnToAdjust(): Promise<boolean> {
  if (switching.value || applying.value) return false
  if (tab.value === 'adjust') return true
  switching.value = true
  sourceError.value = ''
  try {
    if (!(await prepareLeave())) return false
    tab.value = 'adjust'
    selectedPart.value = 'overview'
    creatorToolsRequested.value = false
    emit('tabChange', 'adjust')
    await nextTick()
    if (themeOptionsOpen.value) creationModeButton.value?.focus({ preventScroll: true })
    else themeOptions.value?.querySelector('summary')?.focus({ preventScroll: true })
    return true
  } finally {
    switching.value = false
  }
}
function installedSelection(key: string): ThemeSelection {
  const preset = BUILT_IN_THEME_PRESETS.find((item) => 'preset:' + item.id === key)
  if (preset && isBuiltInThemePresetId(preset.id)) return { kind: 'builtin', id: preset.id }
  const profile = themeStore.profiles.value.find((item) => 'profile:' + item.id === key)
  if (profile) return { kind: 'user', id: profile.id }
  const contribution = themeContributions.value.find(
    (item) => 'plugin:' + getPluginThemeKey(item) === key
  )
  if (contribution)
    return { kind: 'plugin', pluginId: contribution.pluginId, themeId: contribution.id }
  throw new Error('所选主题已不可用，请选择另一个主题。')
}
async function selectSource(key: string, customize?: string): Promise<boolean> {
  if (
    switching.value ||
    applying.value ||
    !loaded.value ||
    (tab.value === 'adjust' && appearanceSection.value?.previewBusy)
  )
    return false
  if (key === sourceKey.value && !customize) return true
  switching.value = true
  sourceError.value = ''
  try {
    if (!(await prepareLeave())) return false
    if (tab.value === 'adjust' && !key.startsWith('workshop:')) {
      await themeStore.setActive(installedSelection(key))
      return true
    }
    const next: AppearanceWorkspaceTab = key.startsWith('workshop:') ? 'workshop' : 'studio'
    workspaceView.value = 'customize'
    if (next === tab.value && next === 'studio') {
      await studio.value?.selectKey(key)
      selected.value = key
    } else if (next === tab.value && next === 'workshop' && key !== 'workshop:new' && !customize) {
      await workshop.value?.selectKey(key.slice('workshop:'.length))
      selected.value = key
    } else if (next === tab.value && next === 'workshop' && key === 'workshop:new' && !customize) {
      await workshop.value?.perform('create')
    } else {
      selected.value = key
      sourceToCustomize.value = customize
      startCreating.value = key === 'workshop:new' && !customize
      pendingCreatorTone.value = tone.value
      tab.value = next
      editorEpoch.value++
    }
    if (!categories.value.some((item) => item.id === category.value)) category.value = 'theme'
    if (next === 'workshop') {
      selectedPart.value = key === 'workshop:new' ? 'appearance-theme' : 'overview'
      creatorToolsRequested.value = key === 'workshop:new'
    }
    emit('tabChange', next)
    return true
  } catch (cause) {
    sourceError.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    switching.value = false
  }
}
async function openWorkshop(): Promise<boolean> {
  if (tab.value === 'workshop') return true
  return tab.value === 'adjust'
    ? await enterCreator(undefined, 'workshop')
    : await selectSource('workshop:' + (projects.value[0]?.id ?? 'new'))
}
async function openThemeEditor(workspace: 'studio' | 'workshop'): Promise<void> {
  const entered =
    workspace === 'workshop'
      ? await openWorkshop()
      : tab.value === 'workshop'
        ? true
        : await enterCreator()
  if (!entered) return
  setThemeOptions(false)
  await nextTick()
  focusCreatorProperties()
}
async function perform(action: AppearanceAction): Promise<void> {
  if (busy.value || tab.value === 'adjust') return
  sourceError.value = ''
  if (action === 'duplicate' && sourceKey.value.startsWith('plugin:')) {
    await selectSource('workshop:new', sourceKey.value.slice('plugin:'.length))
    return
  }
  applying.value = true
  try {
    // A creation command only touches its theme/project store. Daily settings
    // have their own apply path and never participate in a partial joint save.
    await currentEditor.value?.perform(action)
    if (editorState.value?.error) sourceError.value = editorState.value.error
  } catch (cause) {
    sourceError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    applying.value = false
  }
}
async function performThemeOption(action: AppearanceAction): Promise<void> {
  await perform(action)
  setThemeOptions(false, true)
}
async function leaveCreationForManagement(): Promise<boolean> {
  if (!(await prepareLeave())) return false
  // prepareLeave releases the creation preview and recovery session. Once
  // approved, unmount it even if the following store operation later fails.
  if (tab.value !== 'adjust') {
    tab.value = 'adjust'
    selectedPart.value = 'overview'
    emit('tabChange', 'adjust')
    await nextTick()
  }
  return true
}
async function createAppearance(): Promise<void> {
  if (busy.value) return
  switching.value = true
  sourceError.value = ''
  let saved = false
  let newProfileId: string | undefined
  try {
    if (!(await leaveCreationForManagement())) return
    let name = '新主题'
    for (
      let number = 2;
      themeStore.profiles.value.some((profile) => profile.name === name);
      number++
    )
      name = `新主题 ${number}`
    const profile = themeStore.createProfile(name, getBuiltInThemePreset(TWILIGHT_DEFAULT_THEME_ID))
    newProfileId = profile.id
    const snapshot = await themeStore.saveProfile(profile)
    if (!snapshot.data.profiles.some((item) => item.id === profile.id))
      throw new Error('新主题未能保存，请重试。')
    saved = true
    await themeStore.setActive({ kind: 'user', id: profile.id })
    selected.value = 'profile:' + profile.id
    pendingCreatorTone.value = dailyTone.value
    category.value = 'color'
    selectedPart.value = 'appearance-theme'
    creatorToolsRequested.value = false
    tab.value = 'studio'
    workspaceView.value = 'customize'
    editorEpoch.value++
    setThemeOptions(false)
    emit('tabChange', 'studio')
    await nextTick()
    focusCreatorProperties()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    // Saving accepts the persisted snapshot before applying its runtime styles.
    // An application error after that point must not imply the file was lost.
    const persisted = saved || themeStore.profiles.value.some((item) => item.id === newProfileId)
    sourceError.value = persisted
      ? '新主题已保存，后续应用未完成；可从列表重新选择。' + message
      : message
  } finally {
    switching.value = false
  }
}
async function deleteAppearance(): Promise<void> {
  if (busy.value || !deletableProfile.value) return
  const profile = deletableProfile.value
  if (!window.confirm(`删除主题“${profile.name}”？此操作不能撤销。`)) return
  switching.value = true
  sourceError.value = ''
  try {
    if (!(await leaveCreationForManagement())) return
    // The repository protects built-ins and only falls back to the default
    // when deleting the active user profile. Other active choices survive.
    await themeStore.deleteProfile(profile.id)
    selected.value = activeThemeKey()
    setThemeOptions(false)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    sourceError.value = themeStore.profiles.value.some((item) => item.id === profile.id)
      ? message
      : '主题已删除，显示刷新未完成。' + message
  } finally {
    switching.value = false
  }
}
async function discardTheme(): Promise<void> {
  if (busy.value || tab.value !== 'studio') return
  if (!window.confirm('放弃尚未应用的主题制作修改？')) return
  await studio.value?.discard()
  await selectSource(activeThemeKey())
}
async function requestClose(): Promise<void> {
  if (themeOptionsOpen.value) {
    setThemeOptions(false, true)
    return
  }
  if (tab.value !== 'adjust') {
    await returnToAdjust()
    return
  }
  if (await appearanceSection.value?.collapse()) return
  if (workspaceView.value === 'customize') {
    await showSelection()
    return
  }
  if (switching.value || applying.value) return
  switching.value = true
  try {
    if (await prepareLeave()) emit('back')
  } finally {
    switching.value = false
  }
}
async function requestLeave(): Promise<boolean> {
  if (busy.value) return false
  switching.value = true
  try {
    return await prepareLeave()
  } finally {
    switching.value = false
  }
}
usePageDock(
  'appearance',
  () =>
    workspaceView.value === 'selection'
      ? [
          {
            id: 'new-theme',
            label: '新建主题',
            icon: 'navigation.appearance',
            disabled: busy.value,
            run: createAppearance
          },
          {
            id: 'sync-themes',
            label: '同步主题',
            icon: 'navigation.home',
            disabled: busy.value,
            run: () => selectionPage.value?.refresh(true)
          }
        ]
      : [
          {
            id: 'preview-tone',
            label: tone.value === 'dark' ? '深色预览' : '浅色预览',
            icon: tone.value === 'dark' ? 'navigation.night' : 'navigation.day',
            pressed: tone.value === 'dark',
            disabled: busy.value,
            run: () => setTone(tone.value === 'dark' ? 'pureWhite' : 'dark')
          },
          {
            id: 'preview-3d',
            label: activePreview.value?.layeredView ? '2D 预览' : '3D 预览',
            icon: 'navigation.layers',
            pressed: activePreview.value?.layeredView ?? false,
            disabled: busy.value || !activePreview.value,
            run: togglePreviewView
          },
          ...((tab.value === 'adjust'
            ? [
                {
                  id: 'reset-preview',
                  label: '重置预览',
                  icon: 'navigation.home',
                  disabled: busy.value,
                  run: resetPreview
                }
              ]
            : [
                {
                  id: 'undo-theme',
                  label: '撤销主题',
                  icon: 'navigation.back',
                  disabled: busy.value || !editorState.value?.canUndo,
                  run: () => perform('undo')
                },
                {
                  id: 'redo-theme',
                  label: '重做主题',
                  icon: 'navigation.expand',
                  disabled: busy.value || !editorState.value?.canRedo,
                  run: () => perform('redo')
                },
                {
                  id: 'apply-theme',
                  label: '应用主题',
                  icon: 'library.selected',
                  disabled: busy.value || !editorState.value?.canApply,
                  run: () => perform('apply')
                }
              ]) satisfies PageDockAction[])
        ],
  () => props.active
)
async function creatorEscape(): Promise<void> {
  if (themeOptionsOpen.value) setThemeOptions(false, true)
  else if (tab.value === 'adjust') await requestClose()
  else if (tab.value === 'studio' && selectedPart.value !== 'overview') {
    selectedPart.value = 'overview'
    creatorToolsRequested.value = false
    await nextTick()
    pageRef.value?.querySelector<HTMLButtonElement>('[data-creator-part="overview"]')?.focus()
  } else await returnToAdjust()
}
useEscapeToClose(
  () =>
    props.active &&
    (themeOptionsOpen.value || tab.value !== 'adjust' || workspaceView.value === 'customize'),
  () => void creatorEscape()
)
async function setTone(value: ThemeTone): Promise<void> {
  if (tab.value === 'adjust') {
    dailyTone.value = value
    appearanceSection.value?.setTone(value)
  } else if (editorState.value?.tone !== value) await currentEditor.value?.setTone(value)
}
function onStudioDomain(value: ThemeStudioDomain): void {
  if (selectedCategory.value?.studio !== value)
    chooseCategory(APPEARANCE_CATEGORIES.find((item) => item.studio === value)?.id ?? 'theme')
  emit('domainChange', value)
}
function onWorkshopGroup(value: string): void {
  chooseCategory(categories.value.find((item) => item.workshop === value)?.id ?? 'theme')
}
function themeKeydown(event: KeyboardEvent): void {
  if (
    tab.value === 'adjust' ||
    !props.active ||
    busy.value ||
    event.defaultPrevented ||
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== 'z' ||
    (event.target as HTMLElement).closest?.(
      'input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"],[contenteditable=""]'
    )
  )
    return
  event.preventDefault()
  void perform(event.shiftKey ? 'redo' : 'undo')
}
useBackHandler(
  computed(() => props.active),
  () => void requestClose(),
  '返回'
)
defineExpose({ requestClose, requestLeave })
let revision = 0
let disposed = false
let highlightTimer: ReturnType<typeof setTimeout> | undefined
let pendingSearchFocus: { element: HTMLElement; revision: number } | undefined
let pendingCreatorFocus: { tab: AppearanceWorkspaceTab; epoch: number } | undefined
watch(
  busy,
  (value) => {
    if (value) return
    const creator = pendingCreatorFocus
    pendingCreatorFocus = undefined
    if (
      !pendingSearchFocus &&
      creator &&
      !disposed &&
      creator.tab === tab.value &&
      creator.epoch === editorEpoch.value
    )
      focusCreatorProperties()
    if (!pendingSearchFocus) return
    const pending = pendingSearchFocus
    pendingSearchFocus = undefined
    if (!disposed && pending.revision === revision && pending.element.isConnected)
      scrollToElement(pending.element, true)
  },
  { flush: 'post' }
)
function scrollToElement(element: HTMLElement, focus = false): void {
  const page = pageRef.value
  if (!page) return
  const scroller = element.closest<HTMLElement>('.appearance-details-body') ?? page
  const top =
    element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    20
  scroller.scrollTo({ top: Math.max(0, top), behavior: scrollMotionBehavior('smooth', focus) })
  if (focus) {
    const control = element.querySelector<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled)'
    )
    if (control) control.focus({ preventScroll: true })
    else {
      element.tabIndex = -1
      element.focus({ preventScroll: true })
    }
  }
}
async function revealEntry(entry: SettingsSearchEntry): Promise<void> {
  if (entry.id === 'plugin-theme' || entry.id === 'theme-workshop') {
    if (!(await showSelection())) return
    await nextTick()
    const element = pageRef.value?.querySelector<HTMLElement>('#appearance-theme-selection')
    pageRef.value?.querySelector('.search-target-flash')?.classList.remove('search-target-flash')
    element?.classList.add('search-target-flash')
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => element?.classList.remove('search-target-flash'), 1800)
    pageRef.value?.querySelector<HTMLInputElement>('[aria-label="搜索主题"]')?.focus()
    return
  }
  workspaceView.value = 'customize'
  const taskEntry = ['plugin-theme', 'theme-studio', 'theme-workshop'].includes(entry.id ?? '')
  if (tab.value !== 'adjust' && !(await returnToAdjust())) return
  setThemeOptions(entry.id === 'theme-studio')
  await nextTick()
  const current = ++revision
  pendingSearchFocus = undefined
  if (!taskEntry) {
    await appearanceSection.value?.reveal(entry)
    for (const id of settingsDisclosurePath(entry)) {
      if (disposed || current !== revision) return
      await disclosures.reveal(id)
    }
  }
  await nextTick()
  if (disposed || current !== revision || !pageRef.value) return
  const page = pageRef.value
  if (entry.appearanceArea) {
    page
      .querySelector<HTMLButtonElement>(
        '.appearance-section-links button[data-appearance-area="' + entry.appearanceArea + '"]'
      )
      ?.click()
    await nextTick()
    const section = page.querySelector<HTMLElement>('#workspace-' + entry.appearanceArea)
    if (section) scrollToElement(section, true)
    return
  }
  const element =
    (entry.id
      ? page.querySelector<HTMLElement>(
          '[data-setting-id="' +
            CSS.escape(entry.id === 'theme-workshop' ? 'plugin-theme' : entry.id) +
            '"]'
        )
      : null) ??
    (entry.disclosureId
      ? page.querySelector<HTMLElement>('#' + CSS.escape(entry.disclosureId))
      : null)
  if (!element) return
  page.querySelector('.search-target-flash')?.classList.remove('search-target-flash')
  element.classList.add('search-target-flash')
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => element.classList.remove('search-target-flash'), 1800)
  scrollToElement(element, true)
  if (taskEntry && busy.value) pendingSearchFocus = { element, revision: current }
}
async function focusSetting(
  id: 'global-font' | 'player-bar' | 'appearance-theme' | 'appearance-surfaces'
): Promise<void> {
  const entry = SETTINGS_SEARCH_INDEX.find(
    (item) => item.id === (id === 'player-bar' ? 'player-bar-layout' : id)
  )
  if (entry) await revealEntry(entry)
}
async function applyTarget(): Promise<void> {
  if (!loaded.value) return
  const target = props.navigationTarget
  const nextView =
    target?.appearanceTab === 'studio' ||
    target?.appearanceTab === 'workshop' ||
    (target?.entry && !['plugin-theme', 'theme-workshop'].includes(target.entry.id ?? ''))
      ? 'customize'
      : target?.entry
        ? 'selection'
        : workspaceView.value
  if (target?.appearanceTab === 'studio') {
    if (!(await (tab.value === 'workshop' ? selectSource(activeThemeKey()) : enterCreator())))
      return
    setThemeOptions(false)
    chooseCategory(
      (props.initialDomain &&
        APPEARANCE_CATEGORIES.find((item) => item.studio === props.initialDomain)?.id) ||
        'color'
    )
  } else if (target?.appearanceTab === 'workshop') {
    if (!(await openWorkshop())) return
    setThemeOptions(false)
  } else if (tab.value !== 'adjust' && !(await returnToAdjust())) return
  if (nextView === 'selection') {
    if (!(await showSelection())) return
  } else workspaceView.value = 'customize'
  if (target?.entry) await revealEntry(target.entry)
}
watch(() => props.navigationTarget, applyTarget, { flush: 'post' })
watch(
  () => props.active,
  async (active) => {
    if (!active) setThemeOptions(false)
    else await syncActiveTheme()
  }
)
async function syncActiveTheme(): Promise<void> {
  if (
    props.active &&
    loaded.value &&
    tab.value === 'studio' &&
    !applying.value &&
    !switching.value &&
    !editorState.value?.dirty
  )
    await studio.value?.selectKey(activeThemeKey())
}
watch(themeStore.activeTheme, syncActiveTheme)
watch(
  () => editorState.value && !editorState.value.busy,
  async (ready) => {
    if (!ready || !pendingCreatorTone.value) return
    const value = pendingCreatorTone.value
    pendingCreatorTone.value = undefined
    if (editorState.value?.tone !== value) await currentEditor.value?.setTone(value)
  },
  { flush: 'post' }
)
watch(
  () => workshop.value?.projects,
  (value) => {
    if (value) savedProjects.value = value
  }
)
watch(workshopEnabled, async (enabled) => {
  if (!enabled) return
  try {
    savedProjects.value = await window.api.themeWorkshop.list()
  } catch (cause) {
    sourceError.value = cause instanceof Error ? cause.message : String(cause)
  }
})
onMounted(async () => {
  window.addEventListener('keydown', themeKeydown)
  window.addEventListener('pointerdown', dismissThemeOptions)
  try {
    await Promise.all([loadSettings(), themeStore.load()])
    if (workshopEnabled.value) {
      try {
        savedProjects.value = await window.api.themeWorkshop.list()
      } catch (cause) {
        sourceError.value =
          '主题插件工坊暂时不可用。' + (cause instanceof Error ? cause.message : String(cause))
      }
    }
    if (disposed) return
    const target = props.navigationTarget
    if (recovery) {
      workspaceView.value = 'customize'
      tab.value = 'studio'
      selected.value = recovery.selectedKey
    } else if (target?.appearanceTab === 'studio' || target?.appearanceTab === 'workshop') {
      workspaceView.value = 'customize'
      tab.value = target.appearanceTab
      selected.value =
        tab.value === 'workshop'
          ? 'workshop:' + (savedProjects.value[0]?.id ?? 'new')
          : activeThemeKey()
      category.value =
        tab.value === 'workshop'
          ? 'theme'
          : (props.initialDomain &&
              APPEARANCE_CATEGORIES.find((item) => item.studio === props.initialDomain)?.id) ||
            'color'
    } else tab.value = 'adjust'
    if (target?.entry && target.entry.id !== 'plugin-theme') workspaceView.value = 'customize'
    loaded.value = true
    emit('tabChange', tab.value)
    if (target?.entry && !recovery) {
      await nextTick()
      await revealEntry(target.entry)
    }
  } catch (cause) {
    sourceError.value = cause instanceof Error ? cause.message : String(cause)
  }
})
onBeforeUnmount(() => {
  disposed = true
  ++revision
  clearTimeout(highlightTimer)
  window.removeEventListener('keydown', themeKeydown)
  window.removeEventListener('pointerdown', dismissThemeOptions)
})
</script>

<template>
  <main
    ref="pageRef"
    class="settings-preview-page appearance-page"
    :data-appearance-workspace="workspaceView"
    aria-label="外观"
  >
    <header class="appearance-page-topline">
      <h1 class="appearance-page-title">外观</h1>
      <nav class="appearance-workspace-pages" aria-label="外观页面">
        <button
          id="appearance-selection-tab"
          type="button"
          :aria-current="workspaceView === 'selection' ? 'page' : undefined"
          :disabled="busy"
          @click="showSelection"
        >
          主题选择
        </button>
        <button
          id="appearance-customize-tab"
          type="button"
          :aria-current="workspaceView === 'customize' ? 'page' : undefined"
          :disabled="busy"
          @click="showCustomize"
        >
          自定义主题
        </button>
      </nav>
      <div class="appearance-page-header">
        <button
          v-if="workspaceView === 'customize' && tab !== 'adjust'"
          class="appearance-return"
          type="button"
          aria-label="返回外观调整"
          :disabled="busy"
          @click="returnToAdjust"
        >
          <i class="pi pi-arrow-left" aria-hidden="true" /><span>返回外观</span>
        </button>
        <span
          v-if="workspaceView === 'customize'"
          class="appearance-current-theme"
          aria-label="当前主题"
          >{{ currentThemeName }}</span
        >
        <details
          v-if="workspaceView === 'customize'"
          ref="themeOptions"
          class="appearance-theme-tools"
          @toggle="themeOptionsOpen = ($event.target as HTMLDetailsElement).open"
          @focusout="themeOptionsFocusOut"
        >
          <summary aria-label="主题选项" title="主题选项">
            <i class="pi pi-ellipsis-h" aria-hidden="true" />
          </summary>
          <div class="appearance-theme-options" aria-label="当前主题选项">
            <button
              ref="creationModeButton"
              data-setting-id="theme-studio"
              type="button"
              :aria-current="tab === 'studio' ? 'page' : undefined"
              :disabled="busy"
              @click="openThemeEditor('studio')"
            >
              自定义当前主题
            </button>
            <button type="button" :disabled="busy" @click="openThemeEditor('workshop')">
              主题插件工坊 <span class="appearance-beta">BETA</span>
            </button>
            <button
              v-if="tab !== 'adjust'"
              type="button"
              :disabled="busy"
              @click="openContextTools()"
            >
              {{ tab === 'workshop' ? '素材与项目' : '其他主题属性' }}
            </button>
            <label v-if="tab !== 'adjust'" class="appearance-category-tools">
              <span>其他分类</span>
              <select
                aria-label="主题制作分类"
                :value="selectedCategory?.id"
                :disabled="busy"
                @change="openCategory(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="item in categories" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </label>
            <div v-if="tab !== 'adjust'" class="appearance-management-actions">
              <button
                type="button"
                :disabled="busy || (sourceKey.startsWith('plugin:') && !workshopEnabled)"
                @click="performThemeOption('duplicate')"
              >
                创建副本
              </button>
              <button type="button" :disabled="busy" @click="performThemeOption('import')">
                导入{{ tab === 'workshop' ? '项目' : '主题' }}
              </button>
              <button
                type="button"
                :disabled="busy || !editorState?.canExport"
                @click="performThemeOption('export')"
              >
                导出{{ tab === 'workshop' ? '项目' : '主题' }}
              </button>
              <button
                v-if="tab === 'workshop'"
                type="button"
                :disabled="busy || !editorState?.canApply"
                @click="performThemeOption('export-plugin')"
              >
                导出插件
              </button>
            </div>
            <div class="appearance-compact-view-tools">
              <button
                v-if="activePreview?.layeredView"
                type="button"
                :disabled="busy"
                @click="activePreview?.focusCameraZoom"
              >
                相机缩放
              </button>
              <button
                v-if="activePreview?.layeredView"
                type="button"
                :disabled="busy"
                @click="activePreview?.setLayeredView(false)"
              >
                返回 2D
              </button>
              <button
                type="button"
                :disabled="busy || !activePreview"
                @click="activePreview?.fitPart"
              >
                {{ activePreviewPart === 'overview' ? '适合整窗' : '适合部件' }}
              </button>
              <button
                v-if="activePreviewPart !== 'overview'"
                type="button"
                :disabled="busy"
                @click="resetPreview"
              >
                返回整窗
              </button>
              <button
                type="button"
                :disabled="busy || !activePreview"
                @click="activePreview?.zoomOut"
              >
                缩小预览
              </button>
              <button
                type="button"
                :disabled="busy || !activePreview"
                @click="activePreview?.zoomIn"
              >
                放大预览
              </button>
              <button
                v-if="activePreviewPart === 'navigation'"
                type="button"
                data-preview-navigation-toggle
                :aria-expanded="activePreview?.navigationExpanded !== false"
                :disabled="busy"
                @click="activePreview?.toggleNavigation"
              >
                {{ activePreview?.navigationExpanded === false ? '展开侧边栏' : '收起侧边栏' }}
              </button>
              <label v-if="activePreview?.layeredView" class="appearance-layer-spacing">
                <span>展开</span
                ><input
                  type="range"
                  min="0"
                  max="80"
                  step="1"
                  aria-label="3D 层间距"
                  :value="activePreview.layerSpacing"
                  :disabled="busy"
                  @input="
                    activePreview?.setLayerSpacing(
                      Number(($event.target as HTMLInputElement).value)
                    )
                  "
                />
              </label>
            </div>
          </div>
        </details>
      </div>
    </header>
    <p v-if="sourceError" class="studio-message error" role="alert">{{ sourceError }}</p>
    <p v-if="!loaded && !sourceError" class="appearance-loading" role="status">正在准备外观…</p>
    <AppearanceThemeSelection
      v-if="loaded && workspaceView === 'selection'"
      ref="selectionPage"
      :selected="sourceKey"
      :disabled="busy"
      :projects="projects"
      :workshop-enabled="workshopEnabled"
      @select="selectSource"
      @create="createAppearance"
      @delete="deleteAppearance"
      @customize="openThemeEditor('studio')"
    />
    <div
      v-else-if="loaded && tab === 'adjust'"
      id="appearance-customization"
      class="appearance-workbench"
      role="tabpanel"
      aria-labelledby="appearance-customize-tab"
    >
      <AppearanceSettingsSection
        :pages="pages"
        ref="appearanceSection"
        integrated
        compact-toolbar
        theme-tools
        character-editor
        external-toolbar
        :commit-busy="busy"
        :active="active"
        :tone="dailyTone"
        @focus-setting="focusSetting"
        @edit-theme="enterCreator"
        @tone-change="dailyTone = $event"
      />
    </div>
    <section v-else-if="loaded" class="appearance-creation-workspace" aria-label="主题制作工作区">
      <div class="appearance-creation-layout">
        <div
          class="appearance-creation-canvas"
          role="region"
          :aria-label="
            selectedPart === 'overview' ? '整窗预览' : (creatorPartInfo?.label ?? '主题') + '预览'
          "
        >
          <AppearanceWindowPreview
            :pages="pages"
            ref="preview"
            :draft="creationDraft"
            :tone="tone === 'dark' ? 'dark' : 'light'"
            page="local"
            theme-editing
            :workshop-model="tab === 'workshop' ? workshopPreview : undefined"
            :focused-region="selectedPart"
            :active="active"
            @region="selectCreatorPart"
            @workshop-layer-select="(id, surface) => workshop?.chooseLayer(id, surface)"
            @workshop-layer-edit="(id, surface, patch) => workshop?.editLayer(id, surface, patch)"
            @workshop-gesture="workshop?.gesture($event)"
          >
            <template #context-tools>
              <div
                class="appearance-context-tools"
                data-appearance-context
                v-show="creatorContextVisible"
                :inert="switching || applying"
                :aria-busy="switching || applying"
                aria-label="选中对象的主题属性"
              >
                <ThemeStudioPage
                  v-if="tab === 'studio'"
                  :key="editorEpoch"
                  ref="studio"
                  embedded
                  unified
                  controls-only
                  contextual
                  :part="selectedPart"
                  :active="active && !switching && !applying"
                  :initial-key="selected"
                  :initial-domain="selectedCategory?.studio"
                  @domain-change="onStudioDomain"
                />
                <ThemeWorkshopPage
                  v-else-if="workshopEnabled"
                  :key="editorEpoch"
                  ref="workshop"
                  embedded
                  unified
                  controls-only
                  contextual
                  :part="selectedPart"
                  :preview-adapter="workshopPreviewAdapter"
                  :active="active && !switching && !applying"
                  :initial-project-id="
                    selected === 'workshop:new' ? undefined : selected.slice('workshop:'.length)
                  "
                  :initial-source-key="sourceToCustomize"
                  :initial-group="selectedCategory?.workshop"
                  :start-creating="startCreating"
                  @group-change="onWorkshopGroup"
                />
                <div v-else class="appearance-workshop-empty">
                  <h2>启用主题插件工坊</h2>
                  <p>启用后可编辑图层、素材和自定义参数，并导出主题插件。</p>
                  <button @click="emit('openPlugins')">打开插件管理</button>
                </div>
              </div>
            </template>
          </AppearanceWindowPreview>
        </div>
      </div>
      <footer class="appearance-creation-actions" aria-label="主题制作操作">
        <div>
          <button
            aria-label="撤销主题"
            title="撤销主题"
            :disabled="busy || !editorState?.canUndo"
            @click="perform('undo')"
          >
            <i class="pi pi-undo" aria-hidden="true" />
          </button>
          <button
            aria-label="重做主题"
            title="重做主题"
            :disabled="busy || !editorState?.canRedo"
            @click="perform('redo')"
          >
            <i class="pi pi-refresh" aria-hidden="true" />
          </button>
          <button :disabled="busy || !editorState?.canReset" @click="perform('reset')">
            恢复本分类
          </button>
        </div>
        <nav class="appearance-creation-parts" aria-label="主题预览对象">
          <button
            v-for="part in APPEARANCE_PARTS"
            :key="part.id"
            type="button"
            :data-creator-part="part.id"
            :title="part.label"
            :aria-pressed="selectedPart === part.id"
            :disabled="busy"
            @click="selectCreatorPart(part.id)"
          >
            <i :class="part.icon" aria-hidden="true" />{{ part.label }}
          </button>
        </nav>
        <span role="status">{{
          editorState?.status ?? (workshopEnabled ? '正在准备主题…' : '插件工坊未启用')
        }}</span>
        <div>
          <template v-if="tab === 'workshop'">
            <button :disabled="busy || !editorState?.canExport" @click="perform('save')">
              保存项目
            </button>
            <button
              :disabled="busy || (!editorState?.trial && !editorState?.canApply)"
              @click="perform('trial')"
            >
              {{ editorState?.trial ? '退出试用' : '整窗试用' }}
            </button>
          </template>
          <button
            v-if="tab === 'studio'"
            :disabled="busy || !editorState?.hasUnsavedChanges"
            @click="discardTheme"
          >
            放弃主题修改
          </button>
          <button
            class="appearance-command-primary"
            :disabled="busy || !editorState?.canApply"
            @click="perform('apply')"
          >
            应用主题
          </button>
        </div>
      </footer>
    </section>
  </main>
</template>
<style scoped>
.appearance-page {
  --appearance-canvas-text: var(--te-settings-background-text, var(--te-control-fg));
  --appearance-canvas-muted: var(--te-settings-background-muted, var(--te-control-fg-muted));
  --appearance-edit-text: var(--te-control-fg);
  --appearance-edit-muted: var(--te-control-fg-muted);
  --appearance-edit-hover: var(--te-control-bg-hover);
  --appearance-edit-active: var(--te-control-bg-active);
  --appearance-edit-field: var(--te-control-bg);
  --appearance-edit-line: var(--te-control-border);
  --appearance-edit-menu: var(--te-control-bg);
  --appearance-edit-primary: var(--te-control-accent);
  --appearance-edit-on-primary: var(--te-control-on-accent);
  --appearance-edit-focus: var(--te-control-focus-color);
  --te-editor-panel: var(--appearance-edit-menu);
  --te-editor-panel-radius: 10px;
  --te-editor-panel-padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
  padding: var(--te-page-top, 24px) var(--te-page-gutter, 24px) 8px;
  color: var(--appearance-edit-text);
  font-size: var(--te-type-body);
}
.appearance-page[data-appearance-workspace='customize'] {
  --appearance-edit-text: #24272c;
  --appearance-edit-muted: #565c66;
  --appearance-edit-hover: #eceff3;
  --appearance-edit-active: #e3e7ec;
  --appearance-edit-field: #fff;
  --appearance-edit-line: #858d99;
  --appearance-edit-menu: #f8f9fb;
  --appearance-edit-primary: #3d4652;
  --appearance-edit-on-primary: #fff;
  --appearance-edit-focus: #43566d;
  --te-settings-text: var(--appearance-edit-text);
  --te-settings-text-muted: var(--appearance-edit-muted);
  --te-settings-control-bg: var(--appearance-edit-field);
  --te-settings-control-border: var(--appearance-edit-line);
  --te-hover-bg: var(--appearance-edit-hover);
  --te-neutral-900: var(--appearance-edit-text);
  --te-neutral-700: var(--appearance-edit-text);
  --te-neutral-500: var(--appearance-edit-muted);
  --te-neutral-300: var(--appearance-edit-line);
}
:global(html[data-theme='dark'] .appearance-page[data-appearance-workspace='customize']) {
  --appearance-edit-text: #f0f2f5;
  --appearance-edit-muted: #b9c0ca;
  --appearance-edit-hover: #343941;
  --appearance-edit-active: #424b56;
  --appearance-edit-field: #26292f;
  --appearance-edit-line: #707b8a;
  --appearance-edit-menu: #272b31;
  --appearance-edit-primary: #d9e0e9;
  --appearance-edit-on-primary: #20252c;
  --appearance-edit-focus: #c5d2e5;
}
.appearance-page-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  gap: 16px;
  min-width: 0;
}
.appearance-workspace-pages {
  display: flex;
  gap: 4px;
  margin-right: auto;
  min-width: 0;
}
.appearance-current-theme {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--appearance-canvas-muted);
}
.appearance-page-title {
  margin: 0;
  flex-shrink: 0;
  font-size: var(--te-type-page-title);
  font-weight: var(--te-type-weight-strong);
  line-height: var(--te-type-line-title);
}
.appearance-page-header {
  flex: 0 1 auto;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
  min-height: max(var(--te-control-height-md, 34px), calc(var(--te-type-body) * 1.5 + 8px));
  white-space: nowrap;
}
.appearance-page .settings-page-title {
  margin: 0 8px 0 0;
  font-size: var(--te-type-section-title);
  font-weight: var(--te-control-font-weight-strong, 600);
  color: var(--appearance-canvas-text);
}
.appearance-document-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
}
.appearance-document-actions button,
.appearance-fit-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 32px;
}
.appearance-return {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.appearance-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.appearance-source-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--appearance-edit-muted);
  flex: 0 1 220px;
}
.appearance-source-picker select {
  width: 100%;
  min-width: 64px;
}
.appearance-category-tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 8px;
  color: var(--appearance-edit-muted);
}
.appearance-category-tools select {
  width: 100%;
}
.appearance-page button:not(.appearance-window-region),
.appearance-page select,
.appearance-theme-tools > summary {
  box-sizing: border-box;
  min-height: max(var(--te-control-height-md, 34px), calc(var(--te-type-body) * 1.4 + 8px));
  padding: 0 8px;
  border: 0;
  border-radius: var(--te-control-radius-sm, 8px);
  background: transparent;
  box-shadow: none;
  color: var(--appearance-canvas-text);
  font: inherit;
  font-weight: var(--te-control-font-weight, 500);
  line-height: 1.4;
}
.appearance-page select {
  color: var(--appearance-edit-text);
  border: 1px solid var(--appearance-edit-line);
  background: var(--appearance-edit-field);
}
.appearance-page button:not(.appearance-window-region),
.appearance-theme-tools > summary {
  cursor: pointer;
}
.appearance-page button:not(.appearance-window-region):not(:disabled):hover,
.appearance-theme-tools > summary:hover {
  background: var(--appearance-edit-hover);
  color: var(--appearance-edit-text);
}
.appearance-page button:not(.appearance-window-region):disabled,
.appearance-page select:disabled {
  opacity: 0.45;
  cursor: default;
}
.appearance-page button:not(.appearance-window-region)[aria-current='page'],
.appearance-page button:not(.appearance-window-region)[aria-pressed='true'] {
  background: var(--appearance-edit-active);
  color: var(--appearance-edit-text);
}
.appearance-page :is(button:not(.appearance-window-region), select, summary, h2):focus-visible {
  outline: var(--te-control-focus-width, 2px) solid var(--appearance-edit-focus);
  outline-offset: var(--te-control-focus-offset, 2px);
}
.appearance-creation-parts button {
  position: relative;
  min-height: 30px;
  border-radius: var(--te-control-radius-sm, 8px);
  color: var(--appearance-edit-text);
}
.appearance-creation-parts button[aria-pressed='true'] {
  background: var(--appearance-edit-active);
  color: var(--appearance-edit-text);
  font-weight: var(--te-control-font-weight-strong, 600);
}
.appearance-creation-parts button[aria-pressed='true']::after {
  position: absolute;
  bottom: 0;
  left: calc(50% - 9px);
  width: 18px;
  height: 2px;
  background: var(--appearance-edit-focus);
  content: '';
}
.appearance-workbench {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
}
.appearance-page :deep(#appearance-details) {
  flex: 1 1 0;
  height: auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none;
  backdrop-filter: none;
}
.appearance-page :deep(.appearance-character-footer) {
  --te-settings-text: var(--appearance-canvas-text);
  --te-settings-text-muted: var(--appearance-canvas-muted);
  --editor-text: var(--appearance-canvas-text);
  color: var(--appearance-canvas-text);
}
.appearance-page :deep(#appearance-details > .section-title-row),
.appearance-page :deep(#appearance-details > .settings-section-description) {
  display: none;
}
.appearance-creation-workspace {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
}
.appearance-creation-parts button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.appearance-theme-options small {
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
  margin-left: 3px;
}
.appearance-category-label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.appearance-theme-tools {
  position: relative;
  flex-shrink: 0;
}
.appearance-theme-tools > summary {
  display: flex;
  align-items: center;
  color: var(--appearance-canvas-muted);
  list-style: none;
  gap: 5px;
}
.appearance-theme-tools > summary > i {
  display: inline;
}
.appearance-theme-tools > summary::-webkit-details-marker {
  display: none;
}
.appearance-theme-tools > summary::after {
  content: none;
}
.appearance-compact-view-tools {
  display: flex;
  flex-direction: column;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--appearance-edit-line);
}
.appearance-theme-options {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: 208px;
  max-width: calc(100vw - 24px);
  max-height: min(300px, calc(100vh - 100px));
  overflow: auto;
  padding: 4px;
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--appearance-edit-menu);
  box-shadow: 0 6px 20px #0002;
}
.appearance-theme-tools:not([open]) > .appearance-theme-options {
  display: none;
}
.appearance-theme-options button {
  width: 100%;
  text-align: left;
}
.appearance-management-actions {
  display: flex;
  flex-direction: column;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--appearance-edit-line);
}
.appearance-creation-layout {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  gap: 8px;
}
.appearance-creation-canvas {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 6px;
}
.appearance-layer-spacing {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--te-type-caption);
  color: var(--appearance-edit-muted);
}
.appearance-layer-spacing input[type='range'] {
  width: 64px;
  min-width: 0;
  accent-color: var(--appearance-edit-text);
}
.appearance-creation-canvas :deep(.appearance-window-preview) {
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  width: 100%;
}
.appearance-creation-parts {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  justify-content: safe center;
  scrollbar-width: thin;
  gap: 4px;
}
.appearance-creation-parts button {
  padding: 0 8px;
  flex-shrink: 0;
}
.appearance-context-tools {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  flex: 0 0 auto;
  width: min(400px, 100%);
  max-width: 100%;
  position: relative;
  z-index: 4;
  overflow: visible;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.appearance-context-tools :deep(.theme-studio-page) {
  flex: 0 0 auto;
  height: auto;
  width: 100%;
  min-height: 0;
  overflow: visible;
  background: transparent;
}
.appearance-context-tools :deep(.theme-studio-workspace) {
  display: block;
  min-height: 0;
}
.appearance-context-tools :deep(.theme-editor-pane) {
  min-width: 0;
  width: 100%;
  overflow: visible;
  padding: 0;
  border: 0;
  background: transparent;
}
.appearance-context-tools :deep(.studio-personalization-grid),
.appearance-context-tools :deep(.studio-appearance-group),
.appearance-context-tools :deep(.studio-layout-grid) {
  grid-template-columns: minmax(0, 1fr);
}
.appearance-context-tools :deep(.palette-grid) {
  grid-template-columns: repeat(auto-fit, minmax(26px, 1fr));
}
.appearance-context-tools :deep(.workshop-page--embedded) {
  flex: 0 0 auto;
  height: auto;
  width: 100%;
  min-height: 0;
  padding: 0;
  overflow: visible;
  background: transparent;
}
.appearance-creation-actions {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  min-width: 0;
  white-space: nowrap;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
  flex-shrink: 0;
}
.appearance-creation-actions > div {
  display: flex;
  flex-shrink: 0;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
}
.appearance-creation-actions > span {
  color: var(--appearance-edit-muted);
  font-size: var(--te-type-caption);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.appearance-page .appearance-creation-actions button {
  font-size: var(--te-type-toolbar);
  min-height: max(var(--te-control-height-md, 34px), calc(var(--te-type-toolbar) * 1.4 + 8px));
}
@media (max-width: 1100px) {
  .appearance-creation-actions > span[role='status'] {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
}
.appearance-page .appearance-command-primary {
  padding: 0 12px;
  background: var(--appearance-edit-primary);
  color: var(--appearance-edit-on-primary);
  font-weight: var(--te-control-font-weight-strong, 600);
}
.appearance-page .appearance-command-primary:not(:disabled):hover {
  background: color-mix(in srgb, var(--appearance-edit-primary) 88%, var(--appearance-edit-text));
}
.appearance-workshop-empty {
  padding: 28px 12px;
}
.appearance-loading {
  color: var(--appearance-edit-muted);
  font: inherit;
}
@media (max-width: 1040px) {
  .appearance-page-header {
    gap: 6px;
  }
  .appearance-document-actions span,
  .appearance-fit-preview span,
  .appearance-theme-tools > summary > span,
  .appearance-theme-tools > summary::after {
    display: none;
  }
  .appearance-theme-tools > summary > i {
    display: inline;
  }
  .appearance-source-picker {
    flex-basis: 180px;
  }
}
@media (max-width: 760px) {
  .appearance-page-header {
    gap: 4px;
  }
  .appearance-source-picker {
    flex: 1 1 100px;
  }
  .appearance-page-header > .appearance-return span {
    display: none;
  }
  .appearance-compact-view-tools {
    display: flex;
    flex-direction: column;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--appearance-edit-line);
  }
  .appearance-compact-view-tools .appearance-layer-spacing {
    padding: 8px;
  }
  .appearance-compact-view-tools input {
    flex: 1;
  }
}
@media (max-width: 680px) {
  .appearance-page-topline {
    flex-wrap: wrap;
    gap: 8px;
  }
  .appearance-workspace-pages {
    order: 3;
    flex: 1 1 100%;
  }
  .appearance-page-header {
    margin-left: auto;
    max-width: calc(100% - 64px);
  }
  .appearance-current-theme {
    max-width: 140px;
  }
  .appearance-page {
    gap: 12px;
    padding: var(--te-page-top, 16px) var(--te-page-gutter, 16px) 8px;
  }
  .appearance-category-label {
    flex: 0 1 180px;
  }
  .appearance-category-picker {
    flex: 1;
    min-width: 0;
  }
  .appearance-creation-layout {
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  .appearance-creation-canvas {
    min-height: 280px;
    flex: 1 0 280px;
  }
}
</style>
