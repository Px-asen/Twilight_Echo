<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WorkshopLayersPanel from '@renderer/components/theme-workshop/WorkshopLayersPanel.vue'
import WorkshopAssetsPanel from '@renderer/components/theme-workshop/WorkshopAssetsPanel.vue'
import WorkshopModesPanel from '@renderer/components/theme-workshop/WorkshopModesPanel.vue'
import WorkshopPreview from '@renderer/components/theme-workshop/WorkshopPreview.vue'
import WorkshopControl from '@renderer/components/theme-workshop/WorkshopControl.vue'
import WorkshopProjectPanel from '@renderer/components/theme-workshop/WorkshopProjectPanel.vue'
import WorkshopParameterDesigner from '@renderer/components/theme-workshop/WorkshopParameterDesigner.vue'
import WorkshopDiagnosticsPanel from '@renderer/components/theme-workshop/WorkshopDiagnosticsPanel.vue'
import WorkshopOnboarding from '@renderer/components/theme-workshop/WorkshopOnboarding.vue'
import WorkshopDeleteDialog from './WorkshopDeleteDialog.vue'
import NativeDialogTransition from '../NativeDialogTransition.vue'
import ThemeAppearanceControl from '@renderer/components/theme-studio/ThemeAppearanceControl.vue'
import { parseStudioColor, studioColorValue } from '../theme-studio/themeVisualControls'
import type { AppearanceAction, AppearanceEditorState } from '../appearanceEditor'
import type { AppearancePart } from '../appearanceParts'
import type {
  AppearanceWorkshopPreviewAdapter,
  AppearanceWorkshopPreviewModel
} from '../appearanceWorkshopPreview'
import { useThemeWorkshopEditor } from '@renderer/components/theme-workshop/useThemeWorkshopEditor'
import { useWorkshopDiagnostics } from '@renderer/components/theme-workshop/useWorkshopDiagnostics'
import { createWorkshopTrial } from '@renderer/components/theme-workshop/workshopTrial'
import {
  WORKSHOP_PREVIEW_SURFACES,
  WORKSHOP_PREVIEW_STATES,
  WORKSHOP_SIMPLE_GROUPS,
  WORKSHOP_SIMPLE_TOKENS,
  workshopTokenGroup
} from '@renderer/components/theme-workshop/workshopCatalog'
import {
  workshopEditor,
  type WorkshopAsset,
  type WorkshopProject,
  type ThemeEditorControl
} from '../../../../shared/themeWorkshop.ts'
import { workshopControlKey } from '../../../../shared/themeEditor.ts'
import {
  repairWorkshopDiagnostic,
  replaceWorkshopAsset
} from '../../../../shared/themeWorkshopEditing.ts'
import {
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  THEME_ACCENT_PALETTES,
  createThemeAccentTokenOverrides,
  type ThemeTone,
  type ThemeTokenDefinition
} from '../../../../shared/theme.ts'
import type { WorkshopSurface, WorkshopLayer } from '../../../../shared/themeWorkshopLayers.ts'
import type { WorkshopDiagnostic } from '../../../../shared/themeWorkshopDiagnostics.ts'
import { useThemeStore } from '@renderer/stores/useThemeStore'
import { useExtensionRegistry } from '@renderer/extensions/registry'
import { useEscapeToClose } from '../../app/useDismissLayer'

const api = window.api.themeWorkshop
const props = withDefaults(
  defineProps<{
    embedded?: boolean
    active?: boolean
    unified?: boolean
    controlsOnly?: boolean
    contextual?: boolean
    compact?: boolean
    part?: AppearancePart
    previewAdapter?: AppearanceWorkshopPreviewAdapter
    initialProjectId?: string
    initialSourceKey?: string
    initialGroup?: string
    startCreating?: boolean
  }>(),
  {
    active: true
  }
)
const editor = useThemeWorkshopEditor(api)
const {
  projects,
  sources,
  draft,
  candidate,
  previewProject,
  generation,
  busy,
  error,
  notice,
  saveState,
  savedAt,
  cursor,
  historyLength,
  change,
  persist,
  adopt,
  select,
  create,
  duplicate,
  saveCopy,
  remove,
  undo,
  run
} = editor
const metadataBuffer = ref<{ name: string; author: string; version: string; description: string }>()
const mode = ref<'simple' | 'professional'>('simple')
const tone = ref<ThemeTone>('pureWhite')
const group = ref(props.initialGroup ?? '项目')
const contextualMode = computed(() => !!(props.controlsOnly && (props.contextual || props.compact)))
const contextPopup = ref<HTMLElement>()
const contextColorAnchor = ref<HTMLElement>()
const contextMaterialAnchor = ref<HTMLElement>()
const contextMoreAnchor = ref<HTMLElement>()
const contextOpen = ref(false)
const contextTool = ref('more')
const contextPosition = ref<Record<string, string>>({})
const contextColor = ref('')
let contextAnchor: HTMLElement | undefined
let contextFrame = 0
let contextResizeObserver: ResizeObserver | undefined
let contextOpenRevision = 0
let pendingCreate = false
let initializing = true
const controlsBusy = computed(() => busy.value || (contextualMode.value && checking.value))
const contextGroup = computed(
  () =>
    ({
      background: '背景',
      navigation: '导航',
      material: '导航',
      'player-bar': '播放栏',
      card: '卡片',
      'global-font': '字体',
      'appearance-theme': '配色',
      overview: '配色'
    })[props.part ?? 'appearance-theme']
)
const contextTitle = computed(
  () =>
    (
      ({
        color: '颜色',
        layers: '图层与蒙版',
        images: '图片参数',
        assets: '素材库',
        project: '项目与版本',
        diagnostics: '检查与发布',
        preview: '预览选项',
        create: '新建项目',
        more: '其他调整'
      }) as Record<string, string>
    )[contextTool.value] ?? group.value
)
function positionContext(): void {
  if (!contextOpen.value || !contextPopup.value || !contextAnchor) return
  const anchor = contextAnchor.getBoundingClientRect()
  const panel = contextPopup.value.getBoundingClientRect()
  const left = Math.max(12, Math.min(innerWidth - panel.width - 12, anchor.left))
  const below = anchor.bottom + 8
  const top =
    below + panel.height <= innerHeight - 12
      ? below
      : Math.max(54, Math.min(anchor.top - panel.height - 8, innerHeight - panel.height - 12))
  contextPosition.value = { left: `${left}px`, top: `${top}px` }
}
function scheduleContextPosition(): void {
  if (!contextOpen.value || contextFrame) return
  contextFrame = requestAnimationFrame(() => {
    contextFrame = 0
    positionContext()
  })
}
function cancelCreateRequest(): void {
  pendingCreate = false
  contextOpenRevision++
}
function closeTools(restoreFocus = false, preserveCreate = false): void {
  contextOpenRevision++
  if (!preserveCreate) pendingCreate = false
  if (contextPopup.value?.matches(':popover-open')) contextPopup.value.hidePopover()
  contextOpen.value = false
  contextResizeObserver?.disconnect()
  cancelAnimationFrame(contextFrame)
  contextFrame = 0
  if (restoreFocus && contextAnchor?.isConnected) contextAnchor.focus({ preventScroll: true })
}
useEscapeToClose(
  () => contextOpen.value,
  () => closeTools(true)
)
function toggleContext(event: ToggleEvent): void {
  contextOpen.value = event.newState === 'open'
  contextResizeObserver?.disconnect()
  cancelAnimationFrame(contextFrame)
  contextFrame = 0
  if (contextOpen.value && contextPopup.value) {
    contextResizeObserver ??= new ResizeObserver(scheduleContextPosition)
    contextResizeObserver.observe(contextPopup.value)
    scheduleContextPosition()
  }
}
async function openTools(tool = 'more'): Promise<void> {
  if (!contextualMode.value || disposed) return
  const aliases: Record<string, string> = {
    项目: 'project',
    素材库: 'assets',
    图层与蒙版: 'layers',
    配色: 'color'
  }
  const requestedTool = aliases[tool] ?? tool
  if (requestedTool === 'create') pendingCreate = true
  if (!props.active || busy.value || initializing) return
  if (checking.value && requestedTool !== 'diagnostics' && requestedTool !== 'more') return
  if (
    requestedTool === 'create' &&
    contextTool.value === 'create' &&
    contextPopup.value?.matches(':popover-open')
  ) {
    pendingCreate = false
    return
  }
  if (requestedTool !== 'create') pendingCreate = false
  const revision = ++contextOpenRevision
  contextTool.value = requestedTool
  const target = (
    { project: '项目', assets: '素材库', layers: '图层与蒙版' } as Record<string, string>
  )[contextTool.value]
  if (target) selectGroup(target)
  else if (!['diagnostics', 'preview', 'create'].includes(contextTool.value))
    selectGroup(contextGroup.value)
  if (contextTool.value === 'create') startProjectGuide()
  contextAnchor =
    contextTool.value === 'color'
      ? (contextColorAnchor.value ?? contextMoreAnchor.value)
      : ['layers', 'images', 'assets'].includes(contextTool.value)
        ? (contextMaterialAnchor.value?.querySelector<HTMLElement>(
            'select:not(:disabled),button:not(:disabled)'
          ) ?? contextMoreAnchor.value)
        : contextMoreAnchor.value
  await nextTick()
  if (
    disposed ||
    revision !== contextOpenRevision ||
    !props.active ||
    busy.value ||
    (checking.value && requestedTool !== 'diagnostics' && requestedTool !== 'more')
  )
    return
  const element = contextPopup.value
  if (!element) return
  if (!element.matches(':popover-open')) element.showPopover()
  if (requestedTool === 'create') pendingCreate = false
  contextOpen.value = true
  positionContext()
  ;[
    ...element.querySelectorAll<HTMLElement>(
      'input:not(:disabled),select:not(:disabled),button:not(:disabled):not([data-workshop-context-close])'
    )
  ]
    .find(
      (control) =>
        control.getClientRects().length > 0 &&
        getComputedStyle(control).visibility !== 'hidden' &&
        !control.closest('details:not([open]),[inert]')
    )
    ?.focus({ preventScroll: true })
}
function toggleTools(): void {
  if (contextOpen.value) closeTools(true)
  else void openTools(checking.value ? 'diagnostics' : 'more')
}
let disposed = false
const search = ref('')
const projectSearch = ref('')
const modifiedOnly = ref(false)
const surface = ref('dashboard')
const previewState = ref('normal')
const editTarget = ref<'local' | 'streaming'>('local')
const width = ref(1180)
const zoom = ref(0.65)
const appliedProjectSignature = ref('')
const projectSignature = computed(() => JSON.stringify(draft.value))
const canvasEditing = ref(true)
const selectedLayer = ref('')
const layerSurface = ref<WorkshopSurface>('app')
const guide = ref(true)
const guideStep = ref(0)
const creating = ref(false)
function startProjectGuide(): void {
  guide.value = true
  creating.value = true
  guideStep.value = 0
}
function closeProjectGuide(): void {
  cancelCreateRequest()
  guide.value = false
  creating.value = false
}
function selectGroup(name: string): void {
  group.value = name
  search.value = ''
}
function confirmRemove(): void {
  deleteProjectName.value = null
  void run(remove)
}
const trial = ref(false)
const deleteProjectName = ref<string | null>(null)
const page = ref<HTMLElement>()
const preview = ref<InstanceType<typeof WorkshopPreview>>()
const code = ref<HTMLTextAreaElement>()
const sourceCode = ref<HTMLTextAreaElement>()
const sourceDetails = ref<HTMLDetailsElement>()
const metadataProblems = ref<WorkshopDiagnostic[]>([])
const designerProblem = ref('')
const sharedPreviewWarning = ref('')
async function inspectPreview(): Promise<WorkshopDiagnostic[]> {
  if (!props.controlsOnly) return preview.value?.inspect() ?? []
  const unavailable = (): WorkshopDiagnostic[] => {
    sharedPreviewWarning.value = '共享预览尚未就绪，画布检查尚未完成。'
    if (checking.value) diagnostics.cancel()
    return [
      {
        id: 'preview.unavailable',
        code: 'preview.unavailable',
        severity: 'warning',
        message: sharedPreviewWarning.value,
        location: { kind: 'preview' }
      }
    ]
  }
  if (!props.active || !props.previewAdapter) return unavailable()
  try {
    const items = await props.previewAdapter.inspect()
    sharedPreviewWarning.value = ''
    return items
  } catch {
    return unavailable()
  }
}
const diagnostics = useWorkshopDiagnostics(previewProject, generation, candidate, inspectPreview)
const {
  css,
  validProject,
  previewValid,
  report,
  checking,
  progress,
  stale,
  scene,
  previewP95,
  bufferProblems
} = diagnostics
watch([metadataProblems, designerProblem], () => {
  bufferProblems.value = [
    ...metadataProblems.value,
    ...(designerProblem.value
      ? [
          {
            id: 'editor.buffer',
            code: 'editor.buffer',
            severity: 'error' as const,
            message: designerProblem.value,
            location: { kind: 'control' as const }
          }
        ]
      : [])
  ]
})
const trialRuntime = createWorkshopTrial(document, () => {
  trial.value = false
})
const canFinish = computed(
  () => !!draft.value && previewValid.value && !report.value.errors && !candidate.value
)
const activeScene = computed(
  () =>
    scene.value ?? {
      tone: tone.value,
      surface: surface.value,
      width: width.value,
      state: previewState.value
    }
)
const previewModel = computed<AppearanceWorkshopPreviewModel>(() => ({
  css: css.value,
  project: validProject.value,
  scene: activeScene.value,
  selectedLayer: selectedLayer.value,
  canvasEditing: canvasEditing.value && !checking.value && !busy.value && props.active,
  checking: checking.value
}))
const groups = computed(() =>
  [
    ...WORKSHOP_SIMPLE_GROUPS,
    ...(mode.value === 'professional'
      ? [
          '标准外观',
          ...new Set(workshopEditor(draft.value!)?.controls.map((control) => control.group) ?? []),
          '参数设计器',
          '高级 CSS'
        ]
      : [])
  ].filter((name, index, all) => all.indexOf(name) === index)
)
const visibleProjects = computed(() =>
  projects.value.filter((project) =>
    `${project.name} ${project.author}`.toLowerCase().includes(projectSearch.value.toLowerCase())
  )
)
function key(control: ThemeEditorControl): string {
  return workshopControlKey(control, draft.value?.unlinked, editTarget.value)
}
function value(control: ThemeEditorControl): string {
  return draft.value?.values[tone.value][key(control)] ?? control.defaults[tone.value]
}
function tokenValue(token: ThemeTokenDefinition): string {
  return (
    draft.value?.tokens[tone.value][token.id] ??
    draft.value?.base.structured?.variants[tone.value]?.tokens?.[token.id] ??
    TWILIGHT_DEFAULT_THEME.variants[tone.value].tokens[token.id]
  )
}
function pausedToken(token: ThemeTokenDefinition): boolean {
  return token.group === 'shape' || token.group === 'layout' || /radius/i.test(token.id)
}
function pausedControl(control: ThemeEditorControl): boolean {
  const token = control.token && THEME_TOKEN_DEFINITIONS.find((entry) => entry.id === control.token)
  return !!(token && pausedToken(token)) || /radius|圆角/i.test(`${control.id} ${control.label}`)
}
const contextColorTokens = computed(() =>
  THEME_TOKEN_DEFINITIONS.filter((token) => {
    if (token.kind !== 'color') return false
    if (props.part === 'navigation') return token.surface === 'navigation'
    if (props.part === 'player-bar') return token.surface === 'playerBar'
    if (props.part === 'card') return token.surface === 'card'
    if (props.part === 'background')
      return token.id === 'surface.app' || token.surface === 'app-background'
    if (props.part === 'material' || props.part === 'global-font')
      return ['color.neutral.900', 'color.neutral.700'].includes(token.id)
    return WORKSHOP_SIMPLE_TOKENS.has(token.id) && workshopTokenGroup(token) === '配色'
  })
)
const contextColorControls = computed(() =>
  (draft.value ? (workshopEditor(draft.value)?.controls ?? []) : []).filter(
    (control) =>
      control.type === 'color' &&
      (props.part === 'material'
        ? /title-bar|标题栏/.test(`${control.selector ?? ''} ${control.group}`)
        : control.group === contextGroup.value || contextGroup.value === '配色')
  )
)
const contextColors = computed(() => [
  ...contextColorControls.value.map((control) => ({
    id: `control:${control.id}`,
    label: control.label,
    value: value(control)
  })),
  ...contextColorTokens.value.map((token) => ({
    id: `token:${token.id}`,
    label:
      props.part === 'material' || props.part === 'global-font'
        ? `共用${token.label}`
        : token.label,
    value: tokenValue(token)
  }))
])
watch(
  contextColors,
  (options) => {
    if (!options.some((option) => option.id === contextColor.value))
      contextColor.value = options[0]?.id ?? ''
  },
  { immediate: true }
)
const contextColorValue = computed(
  () =>
    contextColors.value.find((option) => option.id === contextColor.value)?.value ?? 'transparent'
)
const directColor = computed(() => parseStudioColor(contextColorValue.value))
const contextImageControl = computed(() =>
  (draft.value ? (workshopEditor(draft.value)?.controls ?? []) : []).find(
    (control) =>
      control.type === 'image' &&
      !pausedControl(control) &&
      (props.part === 'material'
        ? /title-bar|标题栏/.test(`${control.selector ?? ''} ${control.group}`)
        : control.group === contextGroup.value ||
          (props.part === 'navigation' && control.slot?.startsWith('navigation.')))
  )
)
const contextMaterialControl = computed(() =>
  (draft.value ? (workshopEditor(draft.value)?.controls ?? []) : []).find(
    (control) =>
      control.type === 'select' &&
      !pausedControl(control) &&
      /material|材质/i.test(`${control.id} ${control.label}`) &&
      (props.part === 'material'
        ? /title-bar|标题栏/.test(`${control.selector ?? ''} ${control.group}`)
        : control.group === contextGroup.value)
  )
)
const contextImageSelection = computed(() => {
  const control = contextImageControl.value
  if (!control || value(control) === 'none') return 'none'
  return (
    draft.value?.assets?.find(
      (asset) => asset.type === 'image' && value(control).includes(asset.dataUrl)
    )?.id ?? 'current'
  )
})
function setDirectColor(hex: string): void {
  if (controlsBusy.value || !directColor.value) return
  const raw = studioColorValue({ ...directColor.value, hex })
  if (contextColor.value.startsWith('token:')) setToken(contextColor.value.slice(6), raw)
  else {
    const control = contextColorControls.value.find(
      (entry) => `control:${entry.id}` === contextColor.value
    )
    if (control) setValue(control, raw, true)
  }
}
function setContextImage(id: string): void {
  const control = contextImageControl.value
  if (!control || controlsBusy.value) return
  const asset = draft.value?.assets?.find((entry) => entry.type === 'image' && entry.id === id)
  if (id === 'none') setValue(control, 'none')
  else if (asset) setValue(control, `url('${asset.dataUrl}')`)
}
const controls = computed(() =>
  (draft.value ? (workshopEditor(draft.value)?.controls ?? []) : []).filter(
    (control) =>
      (search.value ||
        (contextualMode.value && ['color', 'images'].includes(contextTool.value)) ||
        control.group === group.value ||
        (group.value === '配色' && control.type === 'color')) &&
      `${control.label} ${control.id} ${control.group} ${control.description ?? ''}`
        .toLowerCase()
        .includes(search.value.toLowerCase()) &&
      (!modifiedOnly.value || draft.value?.values[tone.value][key(control)] !== undefined) &&
      (!contextualMode.value ||
        (!pausedControl(control) &&
          (contextTool.value === 'color'
            ? contextColor.value === `control:${control.id}`
            : contextTool.value === 'images'
              ? control.type === 'image'
              : true)))
  )
)
const tokens = computed(() =>
  (contextualMode.value && contextTool.value === 'color'
    ? contextColorTokens.value
    : THEME_TOKEN_DEFINITIONS
  ).filter(
    (token) =>
      ((contextualMode.value && contextTool.value === 'color') ||
        mode.value === 'professional' ||
        WORKSHOP_SIMPLE_TOKENS.has(token.id)) &&
      (search.value ||
        (contextualMode.value && ['color', 'images'].includes(contextTool.value)) ||
        group.value === '标准外观' ||
        workshopTokenGroup(token) === group.value) &&
      `${token.id} ${token.label}`.toLowerCase().includes(search.value.toLowerCase()) &&
      (!modifiedOnly.value || draft.value?.tokens[tone.value][token.id] !== undefined) &&
      (!contextualMode.value ||
        (!pausedToken(token) &&
          (contextTool.value === 'color'
            ? contextColor.value === `token:${token.id}`
            : contextTool.value === 'images'
              ? /image|background.*(?:url|picture)/i.test(token.id)
              : true)))
  )
)
const modeDomain = computed(
  () => ({ 导航: 'navigation', 列表: 'library', 播放栏: 'player' })[group.value]
)
const saveLabel = computed(() =>
  bufferProblems.value.length
    ? '输入尚未保存'
    : { saved: '已保存', pending: '待保存', saving: '保存中…', failed: '保存失败' }[saveState.value]
)
let releaseSession: (() => void) | undefined

function gesture(action: 'begin' | 'end' | 'cancel'): void {
  if (action === 'begin') {
    if (!controlsBusy.value) editor.beginGesture()
  } else editor.endGesture(action === 'cancel')
}
function replace(next: WorkshopProject): void {
  if (controlsBusy.value) return
  change((project) => Object.assign(project, next), true)
}
function chooseLayer(id: string, region: WorkshopSurface): void {
  selectedLayer.value = id
  layerSurface.value = region
  group.value = '图层与蒙版'
  if (contextualMode.value) contextTool.value = 'layers'
  const target = WORKSHOP_PREVIEW_SURFACES.find((entry) => entry.layer === region)
  if (target) surface.value = target.id
}
function editLayer(id: string, region: WorkshopSurface, patch: Partial<WorkshopLayer>): void {
  if (controlsBusy.value) return
  change((project) => {
    const layer = project.layers?.[tone.value]?.[region]?.find((entry) => entry.id === id)
    if (layer) Object.assign(layer, patch)
  }, true)
}
function setValue(control: ThemeEditorControl, raw: string, continuous = false): void {
  if (controlsBusy.value) return
  change((project) => {
    project.values[tone.value][key(control)] = raw
  }, continuous)
}
function toggleLink(control: ThemeEditorControl): void {
  if (controlsBusy.value) return
  change((project) => {
    project.unlinked = { ...project.unlinked }
    if (project.unlinked[control.id]) {
      for (const currentTone of ['pureWhite', 'dark'] as const) {
        project.values[currentTone][control.id] =
          project.values[currentTone][`${control.id}.${editTarget.value}`] ??
          control.defaults[currentTone]
        delete project.values[currentTone][`${control.id}.local`]
        delete project.values[currentTone][`${control.id}.streaming`]
      }
      delete project.unlinked[control.id]
    } else {
      for (const currentTone of ['pureWhite', 'dark'] as const)
        for (const target of ['local', 'streaming'])
          project.values[currentTone][`${control.id}.${target}`] =
            project.values[currentTone][control.id] ?? control.defaults[currentTone]
      project.unlinked[control.id] = true
    }
  })
}
async function importAsset(type: 'image' | 'font', control?: ThemeEditorControl): Promise<void> {
  const asset = await api.importAsset(type)
  if (!asset) return
  change((project) => {
    project.assets = [...(project.assets ?? []), asset]
    if (control) project.values[tone.value][key(control)] = `url('${asset.dataUrl}')`
  })
}
async function replaceAsset(asset: WorkshopAsset): Promise<void> {
  const replacement = await api.importAsset(asset.type)
  if (replacement && draft.value)
    change((project) =>
      Object.assign(project, replaceWorkshopAsset(project, asset.id, replacement))
    )
}
function resetGroup(): void {
  if (controlsBusy.value) return
  const tokenIds = tokens.value.map((token) => token.id)
  const controlIds = controls.value.map((control) => key(control))
  change((project) => {
    for (const id of tokenIds) delete project.tokens[tone.value][id]
    for (const id of controlIds) delete project.values[tone.value][id]
  })
}
function copyTone(): void {
  if (controlsBusy.value) return
  const other = tone.value === 'dark' ? 'pureWhite' : 'dark'
  change((project) => {
    for (const token of tokens.value) {
      if (project.tokens[tone.value][token.id] === undefined) delete project.tokens[other][token.id]
      else project.tokens[other][token.id] = project.tokens[tone.value][token.id]
    }
    for (const control of controls.value) project.values[other][key(control)] = value(control)
    if (group.value === '图层与蒙版' && project.layers)
      project.layers[other] = JSON.parse(JSON.stringify(project.layers[tone.value]))
  })
  notice.value = `已将当前分组从${tone.value === 'dark' ? '深色复制到浅色' : '浅色复制到深色'}，可撤销`
}
function setToken(id: string, raw?: string): void {
  if (controlsBusy.value) return
  change((project) => {
    if (raw === undefined) delete project.tokens[tone.value][id]
    else project.tokens[tone.value][id] = raw
  }, raw !== undefined)
}
function resetControl(control: ThemeEditorControl): void {
  if (!controlsBusy.value)
    change((project) => {
      delete project.values[tone.value][key(control)]
    })
}
function setField(key: 'name' | 'author' | 'version' | 'description', raw: string): void {
  if (!controlsBusy.value)
    change((project) => {
      project[key] = raw
    }, true)
}
function setCss(raw: string): void {
  if (!controlsBusy.value)
    change((project) => {
      project.css = raw
    }, true)
}
function repair(item: WorkshopDiagnostic): void {
  if (!controlsBusy.value)
    change((project) => Object.assign(project, repairWorkshopDiagnostic(project, item)))
}
async function locate(item: WorkshopDiagnostic): Promise<void> {
  if (controlsBusy.value) return
  const location = item.location
  search.value = ''
  modifiedOnly.value = false
  if (location.tone) tone.value = location.tone
  if (location.width) width.value = location.width
  if (location.state) previewState.value = location.state
  if (location.surface && WORKSHOP_PREVIEW_SURFACES.some((entry) => entry.id === location.surface))
    surface.value = location.surface
  let selector = ''
  if (location.kind === 'control') {
    const control = workshopEditor(draft.value!)?.controls.find(
      (entry) =>
        entry.id === location.id || entry.id === location.id?.replace(/\.(local|streaming)$/, '')
    )
    group.value = control?.group ?? '参数设计器'
    mode.value = 'professional'
    selector = `[data-workshop-control="${CSS.escape(control?.id ?? '')}"]`
  }
  if (location.kind === 'token') {
    group.value = '标准外观'
    mode.value = 'professional'
    selector = `[data-studio-setting="${CSS.escape(location.id ?? '')}"]`
  }
  if (location.kind === 'css') {
    mode.value = 'professional'
    group.value = '高级 CSS'
  }
  if (location.kind === 'project') {
    group.value = '项目'
    selector = `[data-workshop-field="${CSS.escape(location.id ?? '')}"]`
  }
  if (location.kind === 'asset') {
    group.value = '素材库'
    selector = `[data-workshop-asset="${CSS.escape(location.id ?? '')}"]`
  }
  if (location.kind === 'layer') chooseLayer(location.id ?? '', location.surface as WorkshopSurface)
  if (location.kind === 'layout' || location.kind === 'mode') group.value = '布局与模式'
  if (contextualMode.value && location.kind !== 'preview') {
    const targetGroup = group.value
    const tool =
      ({ project: 'project', asset: 'assets', layer: 'layers' } as Record<string, string>)[
        location.kind
      ] ?? 'more'
    await openTools(tool)
    if (!['project', 'asset', 'layer'].includes(location.kind)) group.value = targetGroup
  }
  await nextTick()
  if (selector) {
    const element = page.value?.querySelector<HTMLElement>(selector)
    element?.scrollIntoView({ block: 'nearest' })
    element?.focus()
  }
  if (location.kind === 'preview' && location.id) {
    if (props.controlsOnly) props.previewAdapter?.highlight(location.id)
    else preview.value?.highlight(location.id)
  }
  if (location.kind === 'css') {
    if (location.source === 'base' && sourceDetails.value) sourceDetails.value.open = true
    const target = location.source === 'base' ? sourceCode.value : code.value
    if (!target) return
    const offset =
      target.value
        .split('\n')
        .slice(0, (location.line ?? 1) - 1)
        .reduce((count, line) => count + line.length + 1, 0) +
      (location.column ?? 1) -
      1
    target.focus()
    target.setSelectionRange(offset, offset + 1)
  }
}
async function preflight(): Promise<void> {
  await diagnostics.flush()
  if (!canFinish.value)
    throw new Error(candidate.value ? '请先采用或取消基础主题候选版本' : '请先修复检测中的错误')
  await persist()
  const result = await api.preflight(draft.value!.id, draft.value!.revision)
  if (result.errors)
    throw new Error(result.diagnostics.find((item) => item.severity === 'error')!.message)
}
async function apply(): Promise<void> {
  await preflight()
  const result = await api.apply(draft.value!.id, draft.value!.revision)
  await useExtensionRegistry().syncExtensions()
  trialRuntime.stop()
  await useThemeStore().setActive({
    kind: 'plugin',
    pluginId: result.pluginId,
    themeId: result.themeId
  })
  projects.value = await api.list()
  adopt(result.project)
  appliedProjectSignature.value = projectSignature.value
  notice.value = '主题已应用，停用工坊后仍可使用'
}
async function exportProject(format: 'project' | 'tep'): Promise<void> {
  if (format === 'tep') await preflight()
  else await persist()
  const path = await api.exportProject(draft.value!.id, format, draft.value!.revision)
  if (path) notice.value = `已导出：${path}`
}
function checkFull(): void {
  if (controlsBusy.value) return
  void diagnostics.fullCheck().catch((cause) => {
    error.value = String(cause)
  })
}
async function toggleTrial(): Promise<void> {
  if (trial.value) {
    trialRuntime.stop()
    return
  }
  await diagnostics.flush()
  if (!previewValid.value || report.value.errors || !validProject.value)
    throw new Error('请先修复检测中的错误，再整窗试用')
  trialRuntime.start(validProject.value, css.value, tone.value)
  trial.value = true
}
function step(index: number): void {
  guideStep.value = index
  creating.value = index === 0
  if (index === 1) group.value = '配色'
  if (index === 2) group.value = '卡片'
  if (index === 3) {
    tone.value = 'dark'
    void diagnostics.fullCheck().catch((cause) => {
      error.value = String(cause)
    })
  }
  if (index === 4) group.value = '项目'
}
async function createTemplate(template: string): Promise<void> {
  await create(template)
  creating.value = false
  guideStep.value = 1
  group.value = '背景'
}
function adoptCandidate(): void {
  if (!candidate.value) return
  const base = candidate.value
  change((project) => {
    project.base = base
  })
  candidate.value = undefined
}
function keydown(event: KeyboardEvent): void {
  if (!props.active || event.defaultPrevented) return
  if (event.key === 'Escape') {
    editor.endGesture(true)
    trialRuntime.stop()
  }
  if (
    !(event.ctrlKey || event.metaKey) ||
    (event.target as HTMLElement).matches('input,textarea,select,[contenteditable]')
  )
    return
  if (controlsBusy.value) return
  if (event.key.toLowerCase() === 'z') {
    if (props.unified) return
    event.preventDefault()
    undo(event.shiftKey ? 1 : -1)
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    void run(persist)
  }
}
watch([css, tone, validProject], () => {
  if (trial.value && validProject.value)
    trialRuntime.update(validProject.value, css.value, tone.value)
})
watch([surface, previewState, width, tone], diagnostics.scheduleRuntime)
watch(() => props.previewAdapter, diagnostics.scheduleRuntime)
watch(mode, () => {
  if (mode.value === 'simple' && !WORKSHOP_SIMPLE_GROUPS.includes(group.value)) group.value = '配色'
  search.value = ''
})
watch(
  () => draft.value?.id,
  () => {
    cancelCreateRequest()
    metadataProblems.value = []
    designerProblem.value = ''
    bufferProblems.value = []
    metadataBuffer.value = undefined
    selectedLayer.value = ''
    layerSurface.value = 'app'
  }
)
onMounted(() => {
  window.addEventListener('resize', scheduleContextPosition)
  document.addEventListener('visibilitychange', syncDiagnosticsActivity)
  syncDiagnosticsActivity()
  mode.value =
    props.unified ||
    contextualMode.value ||
    localStorage.getItem('twilight:workshop:mode') === 'professional'
      ? 'professional'
      : 'simple'
  guide.value = !props.unified && localStorage.getItem('twilight:workshop:guide') !== 'hidden'
  releaseSession = editor.bindLifecycle(trialRuntime.stop, () => !bufferProblems.value.length)
  window.addEventListener('keydown', keydown, true)
  void run(async () => {
    await editor.initialize()
    if (disposed) return
    if (props.initialSourceKey) {
      const source = sources.value.find(
        (entry) => `${entry.pluginId}:${entry.themeId}` === props.initialSourceKey
      )
      if (!source) throw new Error('来源主题已不可用，请重新选择主题。')
      await create('', source)
    } else if (props.initialProjectId) {
      await selectKey(props.initialProjectId)
    }
    if (!disposed && props.startCreating) startProjectGuide()
  }).then(async () => {
    initializing = false
    if (disposed || error.value) {
      cancelCreateRequest()
      return
    }
    if ((props.startCreating && contextualMode.value) || pendingCreate) await openTools('create')
  })
})
watch(mode, () => localStorage.setItem('twilight:workshop:mode', mode.value))
watch(guide, () =>
  localStorage.setItem('twilight:workshop:guide', guide.value ? 'visible' : 'hidden')
)
watch(
  () => [draft.value?.name, draft.value?.author, draft.value?.version, draft.value?.description],
  () => {
    if (!draft.value || !metadataBuffer.value) return
    metadataBuffer.value = {
      name: bufferProblems.value.some((item) => item.location.id === 'name')
        ? metadataBuffer.value.name
        : draft.value.name,
      author: draft.value.author,
      version: bufferProblems.value.some((item) => item.location.id === 'version')
        ? metadataBuffer.value.version
        : draft.value.version,
      description: draft.value.description
    }
  }
)
onBeforeUnmount(() => {
  disposed = true
  cancelCreateRequest()
  releaseSession?.()
  window.removeEventListener('keydown', keydown, true)
  window.removeEventListener('resize', scheduleContextPosition)
  document.removeEventListener('visibilitychange', syncDiagnosticsActivity)
  contextResizeObserver?.disconnect()
  cancelAnimationFrame(contextFrame)
  trialRuntime.stop()
})
async function prepareLeave(): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  try {
    editor.endGesture()
    await persist()
    trialRuntime.stop()
    trial.value = false
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    busy.value = false
  }
}
async function selectKey(id: string): Promise<void> {
  cancelCreateRequest()
  const previousBusy = busy.value
  busy.value = true
  try {
    const project = projects.value.find((entry) => entry.id === id)
    if (project) await select(project)
    else throw new Error('主题项目已不可用，请重新选择。')
  } finally {
    busy.value = previousBusy
  }
}
async function importProject(): Promise<void> {
  await persist()
  const project = await api.importProject()
  if (project) {
    projects.value = [project, ...projects.value]
    adopt(project)
  }
}
const state = computed<AppearanceEditorState>(() => ({
  key: draft.value ? `workshop:${draft.value.id}` : 'workshop:new',
  tone: tone.value,
  busy: busy.value || checking.value,
  canUndo: cursor.value > 0,
  canRedo: cursor.value < historyLength.value - 1,
  canReset:
    !!draft.value &&
    !['项目', '素材库', '图层与蒙版', '参数设计器', '高级 CSS'].includes(group.value),
  canExport: !!draft.value,
  canApply: canFinish.value,
  status: saveLabel.value,
  trial: trial.value,
  error: error.value,
  dirty: !!draft.value && appliedProjectSignature.value !== projectSignature.value
}))
async function perform(action: AppearanceAction): Promise<void> {
  if (action === 'create' && contextualMode.value) {
    await openTools('create')
    return
  }
  if (state.value.busy) return
  if (action === 'create') {
    startProjectGuide()
    return
  }
  if (action === 'undo') {
    undo(-1)
    return
  }
  if (action === 'redo') {
    undo(1)
    return
  }
  if (action === 'reset') {
    resetGroup()
    return
  }
  const operation = {
    duplicate,
    import: importProject,
    export: () => exportProject('project'),
    'export-plugin': () => exportProject('tep'),
    apply,
    save: persist,
    trial: toggleTrial
  }[action]
  if (operation) await run(operation)
}
function setTone(value: ThemeTone): void {
  if (!checking.value) tone.value = value
}
watch(
  () => props.initialGroup,
  (value) => {
    if (value) {
      mode.value = 'professional'
      selectGroup(value)
    }
  }
)
watch(group, (value) => emit('groupChange', value))
const emit = defineEmits<{ groupChange: [group: string] }>()
const customGroups = computed(() =>
  [...new Set(workshopEditor(draft.value!)?.controls.map((control) => control.group) ?? [])].filter(
    (name) => !WORKSHOP_SIMPLE_GROUPS.includes(name)
  )
)
defineExpose({
  prepareLeave,
  state,
  projects,
  customGroups,
  perform,
  selectKey,
  setTone,
  previewModel,
  chooseLayer,
  editLayer,
  gesture,
  openTools,
  closeTools,
  selectGroup
})
watch(
  () => props.part,
  () => {
    if (contextualMode.value) closeTools(false, true)
  }
)
function syncDiagnosticsActivity(): void {
  if (
    !props.active ||
    document.hidden ||
    document.documentElement.dataset.teVisibility === 'hidden'
  ) {
    closeTools(false, true)
    diagnostics.pause()
    trialRuntime.stop()
    trial.value = false
  } else diagnostics.resume()
}
watch(() => props.active, syncDiagnosticsActivity, { immediate: true })
watch(() => [props.initialProjectId, props.initialSourceKey], cancelCreateRequest)
watch(
  [() => props.active, busy, checking],
  () => {
    if (pendingCreate && !initializing) void openTools('create')
  },
  { flush: 'post' }
)
</script>

<template>
  <section
    ref="page"
    class="workshop-page"
    :class="{
      'workshop-page--embedded': embedded,
      'workshop-page--controls-only': controlsOnly,
      'workshop-page--contextual': contextualMode
    }"
  >
    <div
      v-if="contextualMode"
      class="workshop-context-bar"
      role="toolbar"
      aria-label="选中部件调整"
    >
      <div class="workshop-context-color">
        <input
          v-if="directColor"
          ref="contextColorAnchor"
          type="color"
          data-workshop-direct-color
          :value="directColor.hex"
          :disabled="controlsBusy || !draft"
          :aria-label="
            (contextColors.find((option) => option.id === contextColor)?.label ?? '部件') + '颜色'
          "
          :title="
            (contextColors.find((option) => option.id === contextColor)?.label ?? '颜色') +
            ' · ' +
            directColor.opacity +
            '%不透明度'
          "
          @input="setDirectColor(($event.target as HTMLInputElement).value)"
        />
        <span v-else class="workshop-context-unavailable">自定义颜色</span>
        <select
          v-model="contextColor"
          class="workshop-context-color-object"
          aria-label="当前颜色对象"
          :disabled="controlsBusy || !draft || !contextColors.length"
          :title="contextColors.find((option) => option.id === contextColor)?.label"
        >
          <option v-for="option in contextColors" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
      </div>
      <div ref="contextMaterialAnchor" class="workshop-context-material">
        <select
          v-if="contextMaterialControl"
          :value="value(contextMaterialControl)"
          :aria-label="contextMaterialControl.label"
          :title="contextMaterialControl.label"
          :disabled="controlsBusy || !draft"
          data-workshop-direct-material
          @change="setValue(contextMaterialControl, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in contextMaterialControl.options" :key="option" :value="option">
            {{ option }}
          </option>
        </select>
        <template v-else-if="contextImageControl">
          <select
            :value="contextImageSelection"
            :aria-label="contextImageControl.label + '素材'"
            :title="contextImageControl.label"
            :disabled="controlsBusy || !draft"
            data-workshop-direct-image
            @change="setContextImage(($event.target as HTMLSelectElement).value)"
          >
            <option value="none">无图片</option>
            <option v-if="contextImageSelection === 'current'" value="current" disabled>
              当前图片
            </option>
            <option
              v-for="asset in (draft?.assets ?? []).filter((entry) => entry.type === 'image')"
              :key="asset.id"
              :value="asset.id"
            >
              {{ asset.name }}
            </option>
          </select>
          <button
            :disabled="controlsBusy || !draft"
            :aria-label="'导入' + contextImageControl.label"
            :title="'导入' + contextImageControl.label"
            data-workshop-direct-import
            @click="run(() => importAsset('image', contextImageControl))"
          >
            ＋
          </button>
        </template>
        <span v-else class="workshop-context-unavailable">无独立材质参数</span>
      </div>
      <button
        ref="contextMoreAnchor"
        :disabled="busy"
        aria-haspopup="dialog"
        :aria-expanded="contextOpen"
        @click="toggleTools"
      >
        {{ checking ? '检查中…' : '更多' }}
      </button>
    </div>
    <header v-if="!unified && !contextualMode" class="workshop-header">
      <div v-if="!embedded">
        <small>THEME PLUGIN WORKSHOP</small>
        <h1>主题插件工坊</h1>
      </div>
      <div class="workshop-mode-switch" aria-label="编辑模式">
        <button :aria-pressed="mode === 'simple'" @click="mode = 'simple'">简单模式</button
        ><button :aria-pressed="mode === 'professional'" @click="mode = 'professional'">
          专业模式
        </button>
      </div>
      <button @click="guide = !guide">{{ guide ? '收起引导' : '制作引导' }}</button
      ><button :disabled="busy" @click="startProjectGuide">＋ 新建</button
      ><button
        :disabled="busy"
        @click="
          run(async () => {
            await persist()
            const project = await api.importProject()
            if (project) {
              projects = [project, ...projects]
              adopt(project)
            }
          })
        "
      >
        导入项目
      </button>
    </header>
    <p v-if="error" role="alert" class="workshop-error">
      {{ error
      }}<template v-if="saveState === 'failed'"
        ><button @click="run(editor.reload)">重新加载</button
        ><button @click="run(saveCopy)">另存副本</button
        ><button @click="run(persist)">重试保存</button></template
      >
    </p>
    <p v-if="notice" role="status" class="workshop-notice">{{ notice }}</p>
    <WorkshopOnboarding
      v-if="!contextualMode && (guide || !draft)"
      :step="guideStep"
      :has-project="!!draft"
      :busy="busy"
      :creating="creating"
      @step="step"
      @create="run(() => createTemplate($event))"
      @close="closeProjectGuide"
    />
    <div v-if="!unified && !contextualMode" class="workshop-project-toolbar">
      <input v-model="projectSearch" aria-label="搜索项目" placeholder="搜索项目…" /><select
        aria-label="项目"
        :value="draft?.id ?? ''"
        :disabled="busy"
        @change="
          run(() =>
            select(
              projects.find((project) => project.id === ($event.target as HTMLSelectElement).value)!
            )
          )
        "
      >
        <option disabled value="">选择项目</option>
        <option v-for="project in visibleProjects" :key="project.id" :value="project.id">
          {{ project.name }}
        </option></select
      ><select
        aria-label="从插件创建"
        value=""
        :disabled="busy"
        @change="run(() => create('', sources[Number(($event.target as HTMLSelectElement).value)]))"
      >
        <option disabled value="">定制已安装主题…</option>
        <option
          v-for="(source, index) in sources"
          :key="`${source.pluginId}:${source.themeId}`"
          :value="index"
        >
          {{ source.name }} · {{ source.version }}
        </option>
      </select>
      <template v-if="draft"
        ><span
          role="status"
          :class="['workshop-save-state', saveState]"
          :title="savedAt ? '最近保存：' + savedAt : ''"
          >{{ saveLabel }}</span
        ><button :disabled="busy || cursor <= 0" @click="undo(-1)">撤销</button
        ><button :disabled="busy || cursor >= historyLength - 1" @click="undo(1)">重做</button
        ><button :disabled="busy" @click="run(persist)">保存</button
        ><button :disabled="busy || (!trial && !canFinish)" @click="run(toggleTrial)">
          {{ trial ? '退出试用（Esc）' : '整窗试用' }}</button
        ><button class="workshop-primary" :disabled="busy || !canFinish" @click="run(apply)">
          应用主题
        </button></template
      >
    </div>
    <div
      v-if="draft || contextualMode"
      ref="contextPopup"
      class="workshop-workspace"
      :popover="contextualMode ? 'auto' : undefined"
      :role="contextualMode ? 'dialog' : undefined"
      :aria-label="contextualMode ? contextTitle : undefined"
      :style="contextualMode ? contextPosition : undefined"
      @toggle="toggleContext"
    >
      <div v-if="contextualMode" class="workshop-context-heading">
        <h2>{{ contextTitle }}</h2>
        <button data-workshop-context-close aria-label="关闭调整" @click="closeTools(true)">
          关闭
        </button>
      </div>
      <div
        v-if="contextualMode && ['layers', 'images', 'assets'].includes(contextTool)"
        class="workshop-context-tabs"
        aria-label="图片与材质工具"
      >
        <button
          :disabled="controlsBusy"
          :aria-pressed="contextTool === 'layers'"
          @click="openTools('layers')"
        >
          图层
        </button>
        <button
          :disabled="controlsBusy"
          :aria-pressed="contextTool === 'images'"
          @click="openTools('images')"
        >
          图片参数
        </button>
        <button
          :disabled="controlsBusy"
          :aria-pressed="contextTool === 'assets'"
          @click="openTools('assets')"
        >
          素材库
        </button>
      </div>
      <template v-if="contextualMode && ['more', 'project'].includes(contextTool)">
        <details class="workshop-context-files">
          <summary>项目与文件</summary>
          <div class="workshop-context-actions">
            <label
              >项目<select
                aria-label="项目"
                :value="draft?.id ?? ''"
                :disabled="controlsBusy"
                @change="run(() => selectKey(($event.target as HTMLSelectElement).value))"
              >
                <option disabled value="">选择项目</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">
                  {{ project.name }}
                </option>
              </select></label
            >
            <label
              >来源<select
                aria-label="从插件创建"
                value=""
                :disabled="controlsBusy"
                @change="
                  run(() => create('', sources[Number(($event.target as HTMLSelectElement).value)]))
                "
              >
                <option disabled value="">定制已安装主题…</option>
                <option
                  v-for="(source, index) in sources"
                  :key="`${source.pluginId}:${source.themeId}`"
                  :value="index"
                >
                  {{ source.name }} · {{ source.version }}
                </option>
              </select></label
            >
            <div class="workshop-context-action-row">
              <button :disabled="controlsBusy" @click="openTools('create')">新建项目</button>
              <button :disabled="controlsBusy" @click="run(importProject)">导入项目</button>
              <button :disabled="controlsBusy || !draft" @click="openTools('project')">
                项目与版本
              </button>
              <button :disabled="controlsBusy || !draft" @click="openTools('assets')">
                素材库
              </button>
              <button :disabled="controlsBusy || !draft" @click="run(persist)">保存</button>
              <button
                :disabled="controlsBusy || !draft"
                @click="run(() => exportProject('project'))"
              >
                导出项目
              </button>
              <button
                :disabled="controlsBusy || !canFinish"
                @click="run(() => exportProject('tep'))"
              >
                导出 .tep
              </button>
            </div>
          </div>
        </details>
        <div v-if="draft" class="workshop-context-action-row">
          <button :disabled="busy" @click="openTools('diagnostics')">检查与发布</button>
          <button :disabled="controlsBusy" @click="openTools('preview')">预览选项</button>
        </div>
        <label v-if="contextTool === 'more' && draft" class="workshop-context-group"
          >调整分组
          <select
            :value="group"
            :disabled="controlsBusy"
            aria-label="调整分组"
            @change="selectGroup(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="name in groups" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </template>
      <WorkshopOnboarding
        v-if="contextualMode && (contextTool === 'create' || !draft)"
        :step="guideStep"
        :has-project="!!draft"
        :busy="controlsBusy"
        :creating="creating"
        @step="step"
        @create="run(() => createTemplate($event))"
        @close="draft ? openTools('project') : closeTools(true)"
      />
      <nav v-if="!unified && !contextualMode" aria-label="编辑区域">
        <button
          v-for="name in groups"
          :key="name"
          :class="{ active: group === name }"
          :aria-current="group === name ? 'page' : undefined"
          @click="selectGroup(name)"
        >
          {{ name }}
        </button>
      </nav>
      <main v-if="!controlsOnly && draft" class="workshop-preview">
        <div class="workshop-toolbar">
          <select v-if="!unified" v-model="tone" :disabled="checking" aria-label="深浅色">
            <option value="pureWhite">浅色</option>
            <option value="dark">深色</option></select
          ><select v-model="surface" :disabled="checking" aria-label="页面">
            <option v-for="entry in WORKSHOP_PREVIEW_SURFACES" :key="entry.id" :value="entry.id">
              {{ entry.label }}
            </option></select
          ><select v-model="width" :disabled="checking" aria-label="预览宽度">
            <option v-for="size in [640, 760, 1180, 1600]" :key="size" :value="size">
              {{ size }} px
            </option></select
          ><select v-model="previewState" :disabled="checking" aria-label="预览状态">
            <option
              v-for="previewStatus in WORKSHOP_PREVIEW_STATES"
              :key="previewStatus.id"
              :value="previewStatus.id"
            >
              {{ previewStatus.label }}
            </option></select
          ><select v-model="zoom" aria-label="预览缩放">
            <option :value="0.5">50%</option>
            <option :value="0.65">65%</option>
            <option :value="0.8">80%</option>
            <option :value="1">100%</option></select
          ><button :aria-pressed="canvasEditing" @click="canvasEditing = !canvasEditing">
            {{ canvasEditing ? '画布编辑' : '体验控件' }}
          </button>
        </div>
        <WorkshopPreview
          v-if="validProject"
          ref="preview"
          :css="css"
          :project="validProject"
          :tone="activeScene.tone"
          :surface="activeScene.surface"
          :width="activeScene.width"
          :state="activeScene.state"
          :zoom="zoom"
          :selected="selectedLayer"
          :canvas-editing="canvasEditing && !checking && !busy"
          @select="chooseLayer"
          @region="group = $event"
          @edit="editLayer"
          @gesture="gesture"
        />
        <div v-else class="workshop-empty">正在准备预览；有错误时请先修复。</div>
        <small class="workshop-preview-metric"
          >预览更新 p95：{{ previewP95 === null ? '—' : previewP95.toFixed(1) + ' ms'
          }}<span v-if="candidate"> · 来源候选预览</span></small
        >
      </main>
      <aside
        v-if="draft"
        class="workshop-properties"
        :class="{
          'workshop-properties--tools': contextualMode,
          'workshop-properties--single-color': contextualMode && contextTool === 'color'
        }"
      >
        <details
          v-if="controlsOnly && (!contextualMode || contextTool === 'preview')"
          :open="contextualMode ? true : undefined"
          class="workshop-shared-preview-options"
        >
          <summary>预览选项</summary>
          <div class="workshop-shared-preview-fields">
            <label>
              页面
              <select v-model="surface" :disabled="busy || checking" aria-label="页面">
                <option
                  v-for="entry in WORKSHOP_PREVIEW_SURFACES"
                  :key="entry.id"
                  :value="entry.id"
                >
                  {{ entry.label }}
                </option>
              </select>
            </label>
            <label>
              宽度
              <select v-model="width" :disabled="busy || checking" aria-label="预览宽度">
                <option v-for="size in [640, 760, 1180, 1600]" :key="size" :value="size">
                  {{ size }} px
                </option>
              </select>
            </label>
            <label>
              状态
              <select v-model="previewState" :disabled="busy || checking" aria-label="预览状态">
                <option
                  v-for="previewStatus in WORKSHOP_PREVIEW_STATES"
                  :key="previewStatus.id"
                  :value="previewStatus.id"
                >
                  {{ previewStatus.label }}
                </option>
              </select>
            </label>
            <button
              :disabled="busy || checking"
              :aria-pressed="canvasEditing"
              @click="canvasEditing = !canvasEditing"
            >
              {{ canvasEditing ? '画布编辑' : '体验控件' }}
            </button>
          </div>
        </details>
        <div v-if="!contextualMode" class="workshop-properties-heading">
          <h2>{{ search ? '搜索结果' : group }}</h2>
          <span>{{ tone === 'dark' ? '深色' : '浅色' }}</span>
        </div>
        <div v-if="contextualMode && contextTool === 'color'" class="workshop-context-color-choice">
          <label
            >颜色对象<select v-model="contextColor" :disabled="controlsBusy" aria-label="颜色对象">
              <option v-for="option in contextColors" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select></label
          >
        </div>
        <div
          v-show="
            !contextualMode ||
            (!['diagnostics', 'preview'].includes(contextTool) &&
              !(contextTool === 'create' && creating))
          "
        >
          <WorkshopProjectPanel
            v-if="group === '项目'"
            :key="draft.id"
            :project="draft"
            :busy="controlsBusy"
            :candidate="candidate"
            :can-finish="canFinish"
            :buffer="metadataBuffer"
            @buffer="metadataBuffer = $event"
            @field="setField"
            @problems="metadataProblems = $event"
            @duplicate="run(duplicate)"
            @remove="deleteProjectName = draft?.name ?? ''"
            @restore="
              run(async () => {
                await persist()
                adopt(await api.restoreApplied(draft!.id))
              })
            "
            @export="run(() => exportProject($event))"
            @update="
              run(async () => {
                await persist()
                candidate = await api.updateBase(draft!.id)
              })
            "
            @adopt="adoptCandidate"
            @cancel="candidate = undefined"
          />
          <WorkshopLayersPanel
            v-else-if="group === '图层与蒙版'"
            :project="draft"
            :tone="tone"
            :selection="selectedLayer"
            :region="layerSurface"
            :busy="controlsBusy"
            @change="replace"
            @select="chooseLayer"
            @gesture="gesture"
          />
          <WorkshopAssetsPanel
            v-else-if="group === '素材库'"
            :project="draft"
            :busy="controlsBusy"
            @change="replace"
            @import="run(() => importAsset($event))"
            @replace="run(() => replaceAsset($event))"
          />
          <p v-else-if="contextualMode && group === '布局与模式'" class="workshop-hint">
            结构调整暂时收起；现有布局和模式仍保存在项目中。
          </p>
          <WorkshopModesPanel
            v-else-if="group === '布局与模式'"
            :project="draft"
            :busy="controlsBusy"
            @change="replace"
          />
          <template v-else-if="group === '高级 CSS'"
            ><p class="workshop-hint">
              样式在来源和参数之后应用。输入错误仍保存为草稿，预览保留最近有效版本。
            </p>
            <textarea
              ref="code"
              class="workshop-code"
              aria-label="高级 CSS"
              :disabled="controlsBusy"
              spellcheck="false"
              :value="draft.css"
              @input="setCss(($event.target as HTMLTextAreaElement).value)" />
            <details ref="sourceDetails">
              <summary>查看来源 CSS（只读）</summary>
              <textarea
                ref="sourceCode"
                aria-label="来源 CSS"
                class="workshop-code"
                readonly
                :value="draft.base.css"
              /></details
          ></template>
          <template v-else-if="group !== '参数设计器'"
            ><input
              v-if="!contextualMode || contextTool !== 'color'"
              v-model="search"
              aria-label="搜索参数"
              placeholder="搜索全部参数…"
            /><label v-if="!contextualMode || contextTool !== 'color'" class="workshop-checkbox"
              ><input v-model="modifiedOnly" type="checkbox" />仅查看修改项</label
            >
            <div class="workshop-inline">
              <button
                v-if="!contextualMode || contextTool !== 'color'"
                :disabled="controlsBusy"
                @click="resetGroup"
              >
                恢复{{
                  contextualMode && contextTool === 'color' ? '当前颜色' : '当前分组'
                }}</button
              ><button :disabled="controlsBusy" @click="copyTone">
                {{ tone === 'dark' ? '深色 → 浅色' : '浅色 → 深色' }}
              </button>
            </div>
            <select
              v-if="controls.some((control) => draft!.unlinked?.[control.id])"
              v-model="editTarget"
              aria-label="编辑页面"
            >
              <option value="local">本地</option>
              <option value="streaming">流媒体</option>
            </select>
            <div
              v-if="group === '配色' && !search && (!contextualMode || contextTool !== 'color')"
              class="workshop-palette"
            >
              <button
                v-for="color in THEME_ACCENT_PALETTES[tone]"
                :key="color.id"
                :disabled="controlsBusy"
                :style="{ background: color.value }"
                :aria-label="'使用' + color.label + '主题色'"
                :title="color.label"
                @click="
                  change((project) =>
                    Object.assign(
                      project.tokens[tone],
                      createThemeAccentTokenOverrides(
                        color.value,
                        tone,
                        project.tokens[tone]['surface.app'] ??
                          TWILIGHT_DEFAULT_THEME.variants[tone].tokens['surface.app']
                      )
                    )
                  )
                "
              />
            </div>
            <WorkshopModesPanel
              v-if="modeDomain && !search && !contextualMode"
              :project="draft"
              :busy="controlsBusy"
              :domain="modeDomain"
              @change="replace"
            />
            <WorkshopControl
              v-for="control in controls"
              :key="control.id"
              :control="control"
              :value="value(control)"
              :modified="draft.values[tone][key(control)] !== undefined"
              :busy="controlsBusy"
              :assets="draft.assets ?? []"
              :unlinked="draft.unlinked?.[control.id]"
              @change="(value, continuous) => setValue(control, value, continuous)"
              @reset="resetControl(control)"
              @image="run(() => importAsset('image', control))"
              @link="toggleLink(control)"
              @gesture="gesture"
            />
            <ThemeAppearanceControl
              v-for="token in tokens"
              :key="token.id"
              :definition="token"
              :value="
                draft.tokens[tone][token.id] ??
                draft.base.structured?.variants[tone]?.tokens?.[token.id] ??
                TWILIGHT_DEFAULT_THEME.variants[tone].tokens[token.id]
              "
              source="主题"
              :disabled="controlsBusy"
              :modified="draft.tokens[tone][token.id] !== undefined"
              @change="setToken(token.id, $event)"
              @reset="setToken(token.id)"
            />
            <p
              v-if="!controls.length && !tokens.length && (!modeDomain || contextualMode)"
              class="workshop-hint"
            >
              {{
                contextualMode && contextTool === 'images'
                  ? '当前主题没有独立图片参数，可在素材库导入图片并添加到图层。'
                  : '没有匹配参数。可清空搜索，或新增参数。'
              }}
            </p>
          </template>
          <KeepAlive :max="1"
            ><WorkshopParameterDesigner
              v-if="group === '参数设计器'"
              :key="draft.id"
              :project="draft"
              :busy="controlsBusy"
              @change="(project) => !controlsBusy && change((next) => Object.assign(next, project))"
              @problem="designerProblem = $event"
          /></KeepAlive>
        </div>
      </aside>
      <div
        v-if="contextualMode && draft && contextTool === 'diagnostics'"
        class="workshop-context-publish"
      >
        <WorkshopDiagnosticsPanel
          :report="report"
          :checking="checking"
          :progress="progress"
          :stale="stale"
          :preview-valid="previewValid"
          @locate="locate"
          @repair="repair"
          @check="checkFull"
          @cancel="diagnostics.cancel"
        />
        <div class="workshop-context-action-row">
          <button :disabled="controlsBusy || (!trial && !canFinish)" @click="run(toggleTrial)">
            {{ trial ? '退出试用（Esc）' : '整窗试用' }}
          </button>
          <button :disabled="controlsBusy || !canFinish" @click="run(apply)">应用主题</button>
          <button :disabled="controlsBusy" @click="run(() => exportProject('project'))">
            导出项目
          </button>
          <button :disabled="controlsBusy || !canFinish" @click="run(() => exportProject('tep'))">
            导出独立 .tep
          </button>
        </div>
      </div>
    </div>
    <p v-if="controlsOnly && sharedPreviewWarning" class="workshop-hint" role="status">
      {{ sharedPreviewWarning }}
    </p>
    <WorkshopDiagnosticsPanel
      v-if="draft && !contextualMode"
      :report="report"
      :checking="checking"
      :progress="progress"
      :stale="stale"
      :preview-valid="previewValid"
      @locate="locate"
      @repair="repair"
      @check="checkFull"
      @cancel="diagnostics.cancel"
    />
    <NativeDialogTransition>
      <WorkshopDeleteDialog
        v-if="deleteProjectName !== null"
        :name="deleteProjectName"
        @close="deleteProjectName = null"
        @confirm="confirmRemove"
      />
    </NativeDialogTransition>
  </section>
</template>
<style src="./ThemeWorkshopPage.css"></style>
