<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch
} from 'vue'
import AppearancePreviewScene from './AppearancePreviewScene.vue'
import AppearanceViewAngleControl from './AppearanceViewAngleControl.vue'
import { createAppearanceSkinOverflow, mountAppearanceLayers } from '../app/appearanceLayersRuntime'
import LiquidGlassDefs from './LiquidGlassDefs.vue'
import {
  backgroundCssVariables,
  cardCssVariables,
  resolveBackgroundAppearance,
  resolveBackgroundPalette,
  resolveBackgroundTextTone,
  cloneAppearance,
  type AppearanceDraft,
  type AppearanceTone
} from '../../../shared/appAppearance'
import {
  liquidGlassCssVariables,
  liquidGlassExpandedCssVariables,
  liquidGlassHomeCardCssVariables,
  resolveLiquidGlassTone
} from '../../../shared/liquidGlass'
import {
  themeTokensToCssVariables,
  TWILIGHT_DEFAULT_THEME,
  THEME_MANAGED_DATA_ATTRIBUTES
} from '../../../shared/theme'
import type { AppearanceWorkshopPreviewModel } from './appearanceWorkshopPreview'
import WorkshopCanvasOverlay from './theme-workshop/WorkshopCanvasOverlay.vue'
import { mountWorkshopDecorations } from './theme-workshop/workshopDecorations'
import { workshopCanvasBoxes, type WorkshopCanvasBox } from './theme-workshop/workshopCanvas'
import { inspectWorkshopPreview } from './theme-workshop/workshopPreviewDiagnostics'
import { workshopRuntimeAttributes } from '../../../shared/themeWorkshop'
import type { WorkshopLayer, WorkshopSurface } from '../../../shared/themeWorkshopLayers'
import { useSettingsStore } from '../stores/useSettingsStore'
import { normalizeNavigationPagePreferences } from '../../../shared/navigationPages'
import { normalizePlayerBarLayout } from '../../../shared/playerBarLayout'
import type { NavigationPageDefinition } from '../app/navigationPages'
import type { AppBackgroundPage } from '../../../shared/appSettings'
import { APPEARANCE_PARTS, resolveAppearancePart, type AppearancePart } from './appearanceParts'
import { createEditorViewport } from '../editor/createEditorViewport'
import {
  createAppearanceLayerView,
  projectAppearanceLayers,
  normalizeAppearanceLayerAngles,
  appearanceBackgroundForegroundCss,
  appearanceLayerRotation,
  appearancePartTransform,
  APPEARANCE_LAYER_ORDER,
  APPEARANCE_LAYER_DEFAULT_ANGLES,
  type AppearanceLayerAngles,
  type AppearanceLayer,
  type AppearanceLayerProjection,
  type AppearanceLayerTilt
} from '../editor/appearanceLayerView'
import { measureAppearanceSurfaces, type AppearanceSurface } from '../editor/appearanceSurfaces'
import { createEditorParallax } from '../editor/createEditorParallax'
import { createEditorTransition } from '../editor/createEditorTransition'
import { uiMotionFor, type UiMotionHandle } from '../app/uiMotion'
import { mountBackgroundImageFallback } from '../app/backgroundImageFallback'
import {
  measureEditorNodes,
  editorContextRects,
  sameEditorRect,
  sameEditorSize,
  type EditorCamera,
  type EditorRect,
  type EditorNode,
  type EditorPoint,
  type EditorNodeDefinition
} from '../editor/viewportGeometry'

const WorkshopPreviewScene = defineAsyncComponent(
  () => import('./theme-workshop/WorkshopPreviewScene.vue')
)
const props = defineProps<{
  draft: AppearanceDraft
  tone: AppearanceTone
  page: AppBackgroundPage
  themeEditing?: boolean
  focusedRegion?: AppearancePart
  active?: boolean
  occlusions?: HTMLElement[]
  pages?: NavigationPageDefinition[]
  workshopModel?: AppearanceWorkshopPreviewModel
}>()
const emit = defineEmits<{
  region: [region: AppearancePart, event: MouseEvent]
  workshopLayerSelect: [id: string, surface: WorkshopSurface]
  workshopLayerEdit: [id: string, surface: WorkshopSurface, patch: Partial<WorkshopLayer>]
  workshopGesture: [action: 'begin' | 'end' | 'cancel']
}>()
const host = ref<HTMLElement>()
const world = ref<HTMLElement>()
const cameraControls = ref<InstanceType<typeof AppearanceViewAngleControl>>()
const contextTools = ref<HTMLElement>()
let contextToolsObserver: ResizeObserver | undefined
let contextToolsSize = { width: 0, height: 0 }
let canvasSize = { width: 0, height: 0 }
// Commands publish the target once; animation frames paint the actual ruler directly.
const cameraZoom = ref(1)
const frame = ref<HTMLIFrameElement>()
let controlLayers: ReturnType<typeof mountAppearanceLayers> | undefined
const target = shallowRef<HTMLElement>()
const viewport = shallowRef({ width: window.innerWidth, height: window.innerHeight })
const animated = ref(true)
const documentVisible = ref(!document.hidden)
const revealed = ref(false)
// Start with the content visible. Navigation remains a real overlay and can be
// opened explicitly from its editing controls without shrinking the source UI.
const navigationExpanded = ref(false)
const layeredView = ref(false)
const layeredPresentation = ref(false)
const layerTransitioning = ref(false)
const viewAngles = ref<AppearanceLayerAngles>({ ...APPEARANCE_LAYER_DEFAULT_ANGLES })
const layerSpacing = ref(56)
const navigationBehind = ref(false)
const renderedWorkshop = shallowRef<AppearanceWorkshopPreviewModel>()
let committedWorkshop: AppearanceWorkshopPreviewModel | undefined
let mirroredWorkshop: AppearanceWorkshopPreviewModel | undefined
const workshopBoxes = shallowRef<WorkshopCanvasBox[]>([])
let cleanupDecorations: (() => void) | undefined
let highlightTimer: ReturnType<typeof setTimeout> | undefined
let restoreHighlight: (() => void) | undefined
let scrollDocument: Document | undefined
const previewTone = computed(() =>
  props.workshopModel?.scene.tone === 'dark' ? 'dark' : props.workshopModel ? 'light' : props.tone
)
const workshopInteraction = computed(
  () =>
    !!renderedWorkshop.value?.project &&
    renderedWorkshop.value.scene.surface === 'settings' &&
    !renderedWorkshop.value.canvasEditing &&
    !renderedWorkshop.value.checking &&
    !layeredPresentation.value
)
const layerPolygons = shallowRef<{ id: string; points: EditorPoint[] }[]>([])
const keyboardRegion = ref<RegionId>()
let nativeNodes: (EditorNode & { pose?: string })[] = []
const surfaceHits = shallowRef<AppearanceSurface[]>([])
let preferredSurface: AppearanceSurface | undefined
let layerView: ReturnType<typeof createAppearanceLayerView> | undefined
let layerReveal: UiMotionHandle | undefined
let layerTilt: AppearanceLayerTilt = { x: 0, y: 0 }
let layerProgress = 0
let transitionStartProgress = 0
let transitionStartTilt: AppearanceLayerTilt = { x: 0, y: 0 }
let layerProjection: AppearanceLayerProjection | undefined
let pointerBounds: DOMRect | undefined
let pointerInside = false
// Keep floating tools clear of the complete pitch axis and the yaw ruler's
// top edge, including their labels and an 8px gap. These are layout insets,
// shared with CSS below; camera frames never measure the small controls.
const layeredToolsGutter = { left: 132, bottom: 130 } as const
const regionElements = new Map<string, HTMLElement>()
const regionWorld = ref<HTMLElement>()
const regionFit = ref<HTMLElement>()
const regionLayers: Record<string, AppearanceLayer> = {
  'inner-panel': 'content',
  'outer-panel': 'outer',
  controls: 'content',
  background: 'content',
  card: 'content',
  navigation: 'navigation',
  'player-bar': 'player',
  material: 'title'
}
const selectedOutline = ref<SVGPolygonElement>()
const layerContextPath = ref<SVGPathElement>()
const keyboardOutline = ref<SVGPolygonElement>()
let sceneRevision = 0
const loadingPhase = ref('outline')
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
const mirrorStyle = document.createElement('div').style
const contextColor = ref('var(--te-app-bg)')
const adaptiveGlassTone = ref(document.documentElement.dataset.teLiquidGlassAdaptiveTone)
const glassTone = computed(() =>
  resolveLiquidGlassTone(previewTone.value, props.draft.liquidGlass, adaptiveGlassTone.value)
)
type RegionId = AppearancePart
const selectedRegion = computed(() => resolveAppearancePart(props.focusedRegion ?? 'overview'))
const definitions = APPEARANCE_PARTS.flatMap((part) =>
  part.preview ? [{ id: part.id as RegionId, ...part.preview }] : []
) satisfies EditorNodeDefinition<RegionId>[]
const regions = shallowRef<{ id: RegionId; label: string; rect: EditorRect }[]>([])
function renderCamera(value: EditorCamera): void {
  // Camera frames never invalidate Vue's component tree or trigger a source-layout measurement.
  if (world.value)
    world.value.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.scale})`
  if (host.value) host.value.dataset.cameraScale = String(value.scale)
  paintCameraZoom(value)
  paintContextTools(value)
}
const engine = createEditorViewport({
  clock: {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle)
  },
  render: renderCamera,
  motion: (running) => {
    if (world.value) world.value.style.willChange = running ? 'transform' : ''
  }
})
function getCameraZoom() {
  const { zoom, camera, goal, pending } = engine.snapshot()
  return { zoom, scale: camera.scale, targetScale: goal.scale, pending }
}
function paintCameraZoom(camera: EditorCamera): void {
  if (!cameraControls.value) return
  const { zoom, targetScale } = getCameraZoom()
  const actualZoom = camera.scale / (targetScale / zoom)
  cameraControls.value?.paintZoom(actualZoom)
}
function syncCameraZoom(): void {
  cameraZoom.value = engine.snapshot().zoom
}
function zoomCameraBy(factor: number, anchor?: EditorPoint): void {
  cancelParallax()
  engine.zoomBy(factor, anchor)
  syncCameraZoom()
}
function setCameraZoom(value: number): void {
  if (!Number.isFinite(value)) return
  zoomCameraBy(Math.max(0.35, Math.min(4, value)) / engine.snapshot().zoom)
}
function fitCamera(): void {
  cancelParallax()
  engine.fit()
  syncCameraZoom()
}
function panCameraBy(delta: EditorPoint): void {
  cancelParallax()
  engine.panBy(delta)
  syncCameraZoom()
}
function focusCameraZoom(): void {
  void nextTick().then(() => cameraControls.value?.focusZoom())
}
watch(
  cameraControls,
  (controls) => {
    if (controls) paintCameraZoom(engine.snapshot().camera)
  },
  { flush: 'post' }
)
const focusedPart = computed(() =>
  regions.value.some((region) => region.id === selectedRegion.value) &&
  selectedRegion.value !== 'inner-panel'
    ? selectedRegion.value
    : undefined
)
const contextTarget = shallowRef<EditorRect>()
const contextRegion = ref<AppearancePart>()
watch(
  focusedPart,
  (part) => {
    if (part) contextRegion.value = part
  },
  { immediate: true }
)
watch(
  () => regions.value.find((region) => region.id === focusedPart.value)?.rect,
  (rect) => {
    // Retain the previous opening while its context fades back in on returning to the whole scene.
    if (rect) contextTarget.value = rect
  },
  { immediate: true }
)
const contextRects = computed(() =>
  contextTarget.value ? editorContextRects(viewport.value, contextTarget.value) : []
)
function rectStyle(rect: EditorRect): Record<string, string> {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
}
const contextPanels = computed(() => contextRects.value.map(rectStyle))
const regionViews = computed(() =>
  [
    ...regions.value
      .filter((region) => region.id !== 'card' && region.id !== 'controls')
      .map((region) => ({
        ...region,
        key: region.id,
        nativeRect: nativeNodes.find((node) => node.id === region.id)?.rect,
        surface: undefined as AppearanceSurface | undefined
      })),
    ...surfaceHits.value
      .filter((surface) => surface.interactive !== false)
      .filter(
        (surface) =>
          layeredPresentation.value ||
          (surface.pose !== 'chrome-controls' && surface.pose !== 'player-controls')
      )
      .filter(
        (surface) =>
          surface.id !== 'navigation' ||
          !sameEditorRect(
            surface.rect,
            nativeNodes.find((node) => node.id === 'navigation')?.rect ?? surface.rect
          )
      )
      .map((surface, index) => ({
        id: surface.id,
        key: `${surface.id}:${index}`,
        label:
          surface.id === 'card'
            ? '调整内容卡片'
            : surface.id === 'navigation'
              ? '调整侧边栏材质'
              : '调整控件材质',
        rect: surface.rect,
        nativeRect: surface.rect,
        surface
      }))
  ]
    .filter((region) => region.id !== 'navigation' || !navigationBehind.value)
    .map((region) => {
      const native = layeredPresentation.value ? region.nativeRect : undefined
      return {
        ...region,
        isTarget:
          !region.surface ||
          sameEditorRect(
            region.rect,
            nativeNodes.find((node) => node.id === region.id)?.rect ?? region.rect
          ),
        style: {
          ...rectStyle(native ?? region.rect),
          zIndex:
            region.id === 'controls' || region.id === 'card'
              ? '2'
              : String(APPEARANCE_LAYER_ORDER.indexOf(regionLayers[region.id])),
          '--appearance-region-pose': native
            ? appearancePartTransform(region.surface?.pose ?? region.id, layerPose().spacing)
            : 'none'
        }
      }
    })
)
const selectedPolygon = computed(() =>
  layerPolygons.value
    .find((polygon) => polygon.id === selectedRegion.value && polygon.id !== 'inner-panel')
    ?.points.map((point) => `${point.x},${point.y}`)
    .join(' ')
)
function contextPath(points?: EditorPoint[]): string {
  if (!points?.length) return ''
  // Offset each convex edge by the same 10px clearance used in the 2D mask.
  const normals = points.map((point, index) => {
    const next = points[(index + 1) % points.length]
    const x = next.y - point.y,
      y = point.x - next.x
    const length = Math.hypot(x, y) || 1
    return { x: x / length, y: y / length }
  })
  const hole = points.map((point, index) => {
    const previous = normals[(index + points.length - 1) % points.length]
    const next = normals[index]
    const distance = 10 / Math.max(0.01, 1 + previous.x * next.x + previous.y * next.y)
    return `${point.x + (previous.x + next.x) * distance},${point.y + (previous.y + next.y) * distance}`
  })
  const bounds = layerProjection?.nodes.map((node) => node.rect) ?? []
  const left = Math.min(0, ...bounds.map((rect) => rect.left))
  const top = Math.min(0, ...bounds.map((rect) => rect.top))
  const right = Math.max(viewport.value.width, ...bounds.map((rect) => rect.left + rect.width))
  const bottom = Math.max(viewport.value.height, ...bounds.map((rect) => rect.top + rect.height))
  return `M${left},${top} H${right} V${bottom} H${left} Z M${hole.join(' L')} Z`
}
const selectedContextPath = computed(() =>
  contextPath(layerPolygons.value.find((polygon) => polygon.id === contextRegion.value)?.points)
)
const keyboardPolygon = computed(() =>
  layerPolygons.value
    .find((polygon) => polygon.id === keyboardRegion.value)
    ?.points.map((point) => `${point.x},${point.y}`)
    .join(' ')
)
function setRegionElement(id: string, element: unknown): void {
  if (element instanceof HTMLElement) regionElements.set(id, element)
  else regionElements.delete(id)
}
function paintLayerProjection(): void {
  if (!layeredPresentation.value || !previewIsActive() || !layerProjection) return
  // The browser projects real source rectangles for hit testing. Updating two
  // cached transforms avoids repainting five clip paths on every pointer frame.
  const pose = layerPose()
  if (regionWorld.value)
    regionWorld.value.style.transform = appearanceLayerRotation(pose.tilt, pose.angles)
  if (regionFit.value)
    regionFit.value.style.transform = `translate(${layerProjection.fit.x}px, ${layerProjection.fit.y}px) scale(${layerProjection.fit.scale})`
  for (const [id, element] of regionElements) {
    const transform = appearancePartTransform(
      element.dataset.pose ?? element.dataset.region ?? id,
      pose.spacing
    )
    if (element.style.getPropertyValue('--appearance-region-pose') !== transform)
      element.style.setProperty('--appearance-region-pose', transform)
  }
  for (const [outline, id] of [
    [selectedOutline.value, selectedRegion.value],
    [keyboardOutline.value, keyboardRegion.value]
  ] as const) {
    const points = layerProjection.polygons
      .find((item) => item.id === id)
      ?.points.map((point) => `${point.x},${point.y}`)
      .join(' ')
    if (outline && points && outline.getAttribute('points') !== points)
      outline.setAttribute('points', points)
  }
  const path = contextPath(
    layerProjection.polygons.find((item) => item.id === contextRegion.value)?.points
  )
  if (layerContextPath.value && layerContextPath.value.getAttribute('d') !== path)
    layerContextPath.value.setAttribute('d', path)
  paintContextTools(engine.snapshot().camera)
}
function paintContextTools(camera: EditorCamera): void {
  const element = contextTools.value
  if (!element || !contextToolsSize.width || !canvasSize.width || !revealed.value) return
  const { width, height } = contextToolsSize
  const padding = 8
  const leftEdge = layeredPresentation.value ? layeredToolsGutter.left : padding
  const bottomEdge =
    canvasSize.height - (layeredPresentation.value ? layeredToolsGutter.bottom : padding)
  const maxX = Math.max(leftEdge, canvasSize.width - width - padding)
  const maxY = Math.max(padding, bottomEdge - height)
  const node = (layeredPresentation.value ? layerProjection?.nodes : nativeNodes)?.find(
    (item) => item.id === selectedRegion.value
  )
  let x = maxX,
    y = padding
  if (node && node.id !== 'inner-panel') {
    const rect = {
      left: camera.x + node.rect.left * camera.scale,
      top: camera.y + node.rect.top * camera.scale,
      width: node.rect.width * camera.scale,
      height: node.rect.height * camera.scale
    }
    const candidates = [
      { x: rect.left, y: rect.top + rect.height + padding },
      { x: rect.left, y: rect.top - height - padding },
      { x: rect.left + rect.width + padding, y: rect.top },
      { x: rect.left - width - padding, y: rect.top }
    ].map((position) => {
      const x = Math.max(leftEdge, Math.min(maxX, position.x))
      const y = Math.max(padding, Math.min(maxY, position.y))
      const overlap =
        Math.max(0, Math.min(x + width, rect.left + rect.width) - Math.max(x, rect.left)) *
        Math.max(0, Math.min(y + height, rect.top + rect.height) - Math.max(y, rect.top))
      return { x, y, score: overlap + Math.hypot(x - position.x, y - position.y) }
    })
    candidates.sort((a, b) => a.score - b.score)
    ;({ x, y } = candidates[0])
  }
  const transform = `translate(${x}px, ${y}px)`
  if (element.style.transform !== transform) element.style.transform = transform
  if (element.style.visibility !== 'visible') element.style.visibility = 'visible'
}
watch(contextTools, (element, previous) => {
  if (previous) contextToolsObserver?.unobserve(previous)
  contextToolsSize = { width: 0, height: 0 }
  if (!element) return
  contextToolsObserver ??= new ResizeObserver((entries) => {
    const entry = entries.find((item) => item.target === contextTools.value)
    if (!entry) return
    const box = entry.borderBoxSize[0]
    contextToolsSize = {
      width: box?.inlineSize ?? entry.contentRect.width,
      height: box?.blockSize ?? entry.contentRect.height
    }
    paintContextTools(engine.snapshot().camera)
  })
  contextToolsObserver.observe(element)
})
watch(
  [revealed, selectedRegion, layeredPresentation],
  () => void nextTick().then(() => paintContextTools(engine.snapshot().camera))
)
const parallax = createEditorParallax({
  clock: {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle)
  },
  render(tilt) {
    layerTilt = tilt
    if (
      !layeredPresentation.value ||
      layerTransitioning.value ||
      !previewIsActive() ||
      !layerView?.element
    )
      return
    layerProjection = layerView.setTilt(tilt)
    paintLayerProjection()
  }
})
parallax.setActive(false)
function displayedTilt(): AppearanceLayerTilt {
  if (!layerTransitioning.value) return layerTilt
  const fraction = layeredView.value
    ? (1 - layerProgress) / Math.max(0.001, 1 - transitionStartProgress)
    : layerProgress / Math.max(0.001, transitionStartProgress)
  const weight = Math.max(0, Math.min(1, fraction))
  return { x: transitionStartTilt.x * weight, y: transitionStartTilt.y * weight }
}
function layerPose() {
  return {
    angles: { x: viewAngles.value.x * layerProgress, y: viewAngles.value.y * layerProgress },
    spacing: layerSpacing.value * layerProgress,
    tilt: displayedTilt()
  }
}
const layerTransition = createEditorTransition({
  clock: {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle)
  },
  render(progress) {
    layerProgress = progress
    if (!previewIsActive() || !layeredPresentation.value) return
    if (layerView?.element) {
      layerProjection = layerView.setPose(layerPose())
      paintLayerProjection()
    }
    if (progress === 0 && !layeredView.value) {
      finishLayeredPresentation()
    }
  },
  motion(running) {
    layerTransitioning.value = running
    syncParallaxActivity()
  }
})
function syncParallaxActivity(): void {
  parallax.setActive(
    layeredView.value &&
      !layerTransitioning.value &&
      previewIsActive() &&
      animated.value &&
      revealed.value
  )
}
function followPointer(event: PointerEvent, entering = false): void {
  if (event.pointerType === 'touch' || !layeredView.value || !animated.value) return
  if (!previewIsActive() || !revealed.value) return
  pointerBounds ??= host.value?.getBoundingClientRect()
  if (!insideCanvas(event)) {
    pointerLeave()
    return
  }
  if (pointerOverTools(event)) {
    cancelParallax()
    return
  }
  if (!pointerBounds) return
  const point = {
    x: ((event.clientX - pointerBounds.left) / pointerBounds.width) * 2 - 1,
    y: ((event.clientY - pointerBounds.top) / pointerBounds.height) * 2 - 1
  }
  const entry = entering || !pointerInside
  pointerInside = true
  if (entry) parallax.enter(point)
  else parallax.setPointer(point)
}
function insideCanvas(event: PointerEvent): boolean {
  return !!(
    pointerBounds &&
    Number.isFinite(event.clientX) &&
    Number.isFinite(event.clientY) &&
    event.clientX >= pointerBounds.left &&
    event.clientX <= pointerBounds.right &&
    event.clientY >= pointerBounds.top &&
    event.clientY <= pointerBounds.bottom
  )
}
function pointerOverTools(event: PointerEvent): boolean {
  const target = event.target
  const controls = cameraControls.value?.$el
  return (
    target instanceof Node &&
    !!(
      contextTools.value?.contains(target) ||
      (controls instanceof HTMLElement && controls.contains(target))
    )
  )
}
function cancelParallax(): void {
  pointerInside = false
  parallax.reset(false)
}
function invalidatePointerBounds(): void {
  pointerBounds = undefined
  cancelParallax()
}
function pointerEnter(event: PointerEvent): void {
  pointerBounds = host.value?.getBoundingClientRect()
  followPointer(event, true)
}
function pointerLeave(): void {
  pointerInside = false
  parallax.reset()
}
watch([keyboardRegion, selectedRegion], () => void nextTick().then(paintLayerProjection))
function regionFocus(id: RegionId, event: FocusEvent): void {
  keyboardRegion.value = (event.target as HTMLElement).matches(':focus-visible') ? id : undefined
}
const hostStyle = computed(() => ({
  aspectRatio: `${viewport.value.width} / ${viewport.value.height}`,
  '--appearance-tools-left-clearance': `${layeredToolsGutter.left}px`,
  '--appearance-tools-bottom-clearance': `${layeredToolsGutter.bottom}px`,
  '--appearance-selection-color': previewTone.value === 'dark' ? '#dedede' : '#4d5056',
  '--appearance-focus-color': previewTone.value === 'dark' ? '#f1f2f4' : '#24262a'
}))
const dragging = ref(false)
let gesture: { id: number; x: number; y: number; startX: number; startY: number } | undefined
let suppressClickUntil = 0
function pointerDown(event: PointerEvent): void {
  if (event.defaultPrevented || event.button !== 0 || !previewIsActive() || !revealed.value) return
  cancelParallax()
  gesture = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY
  }
}
function pointerMove(event: PointerEvent): void {
  if (gesture && !insideCanvas(event)) pointerLeave()
  if (!gesture) {
    followPointer(event)
    return
  }
  if (!gesture || gesture.id !== event.pointerId) return
  if (
    !dragging.value &&
    Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 4
  )
    return
  dragging.value = true
  host.value?.setPointerCapture(event.pointerId)
  panCameraBy({ x: event.clientX - gesture.x, y: event.clientY - gesture.y })
  gesture.x = event.clientX
  gesture.y = event.clientY
  event.preventDefault()
}
function pointerUp(event: PointerEvent): void {
  if (event.type === 'pointercancel') {
    if (!gesture || gesture.id === event.pointerId) cancelPointerInteraction()
    return
  }
  if (!gesture || gesture.id !== event.pointerId) return
  const wasDragging = dragging.value
  endGesture()
  // A release can arrive before lostpointercapture. Do not restart parallax
  // from that last drag coordinate after the capture was already cancelled.
  if (wasDragging) cancelParallax()
  else followPointer(event)
}
function endGesture(): void {
  const previous = gesture
  if (dragging.value) suppressClickUntil = performance.now() + 160
  gesture = undefined
  dragging.value = false
  if (previous && host.value?.hasPointerCapture(previous.id))
    host.value.releasePointerCapture(previous.id)
}
function lostPointerCapture(event: PointerEvent): void {
  if (gesture?.id !== event.pointerId) return
  cancelPointerInteraction()
}
function cancelPointerInteraction(): void {
  endGesture()
  cancelParallax()
}
function zoomWheel(event: WheelEvent): void {
  const rect = host.value?.getBoundingClientRect()
  if (!rect || !previewIsActive() || !revealed.value) return
  zoomCameraBy(Math.exp(-Math.max(-160, Math.min(160, event.deltaY)) * 0.002), {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  })
}
function viewportKeydown(event: KeyboardEvent): void {
  if (event.target instanceof Node && contextTools.value?.contains(event.target)) return
  if (!previewIsActive() || !revealed.value) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === '+' || event.key === '=') zoomCameraBy(1.25)
  else if (event.key === '-') zoomCameraBy(0.8)
  else if (event.key === '0') fitCamera()
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
    panCameraBy({
      x: event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0,
      y: event.key === 'ArrowUp' ? 32 : event.key === 'ArrowDown' ? -32 : 0
    })
  else return
  event.preventDefault()
}
function selectRegion(region: RegionId, event: MouseEvent, surface?: AppearanceSurface): void {
  event.stopPropagation()
  if (!previewIsActive() || !revealed.value || performance.now() < suppressClickUntil) return
  if (surface && surface.id !== 'navigation') {
    preferredSurface = surface
    nativeNodes = nativeNodes.map((node) =>
      node.id === surface.id ? { ...node, rect: surface.rect, pose: surface.pose } : node
    )
    presentScene()
    engine.focus(region)
  }
  // A second inner-background click releases focus without discarding the draft.
  const selected =
    region === 'inner-panel' && selectedRegion.value === 'inner-panel' ? 'overview' : region
  emit('region', selected, event)
  if (selected === 'overview' && event.detail) host.value?.focus({ preventScroll: true })
}
function resetFocus(event: MouseEvent): void {
  if (
    props.focusedRegion !== undefined &&
    previewIsActive() &&
    revealed.value &&
    performance.now() >= suppressClickUntil
  )
    emit('region', 'overview', event)
}
watch(
  selectedRegion,
  (id) => {
    updatePresentationFocus()
    if (layeredPresentation.value) presentScene()
    engine.focus(id)
    syncCameraZoom()
  },
  { immediate: true }
)
watch(layeredPresentation, scheduleMeasure, { flush: 'post' })
function setLayeredView(value: boolean): void {
  if (layeredView.value === value) return
  endGesture()
  pointerInside = false
  transitionStartTilt = displayedTilt()
  transitionStartProgress = layerProgress
  layeredView.value = value
  if (value) layeredPresentation.value = true
  updatePresentationFocus()
  presentScene()
  layerTransition.setAnimated(animated.value)
  layerTransition.setActive(previewIsActive())
  layerTransition.setTarget(value ? 1 : 0)
  // A reversal before the first frame already has zero progress, so the
  // transition publishes no changed value to release its static presentation.
  if (!value && layerProgress === 0) finishLayeredPresentation()
  syncParallaxActivity()
}
function finishLayeredPresentation(): void {
  if (!layeredPresentation.value || layeredView.value || layerProgress !== 0) return
  layeredPresentation.value = false
  if (regionWorld.value) regionWorld.value.style.transform = ''
  if (regionFit.value) regionFit.value.style.transform = ''
  clearLayerView()
  updatePresentationFocus()
  presentScene()
}
function setViewAngles(value: AppearanceLayerAngles): void {
  cancelParallax()
  viewAngles.value = normalizeAppearanceLayerAngles(value)
  if (!layeredPresentation.value || !previewIsActive() || !layerView?.element) return
  layerProjection = layerView.setPose(layerPose())
  paintLayerProjection()
}
function setLayerSpacing(value: number): void {
  if (!Number.isFinite(value)) return
  layerSpacing.value = Math.round(Math.max(0, Math.min(80, value)))
  if (layeredView.value) presentScene()
}
defineExpose({
  inspectWorkshop,
  highlightWorkshop,
  zoomIn: () => zoomCameraBy(1.25),
  zoomOut: () => zoomCameraBy(0.8),
  fitPart: fitCamera,
  cameraZoom,
  setCameraZoom,
  getCameraZoom,
  focusCameraZoom,
  glassTone,
  navigationExpanded,
  layeredView,
  layerSpacing,
  viewAngles,
  layerTransitioning,
  setLayeredView,
  setViewAngles,
  setLayerSpacing,
  toggleNavigation: () => {
    navigationExpanded.value = !navigationExpanded.value
  }
})
const worldStyle = computed(() => ({
  width: `${viewport.value.width}px`,
  height: `${viewport.value.height}px`
}))
const { settings } = useSettingsStore()
const playerSettings = computed(() => props.draft.playerBar ?? settings.value.playerBar)
const navigationSettings = computed(
  () => props.draft.navigationPages ?? settings.value.navigationPages
)
const previewDocument = computed(() => target.value?.ownerDocument)
const navigationGlass = computed(
  () =>
    !props.workshopModel &&
    props.draft.surfaceMaterial !== 'transparent' &&
    (props.draft.surfaceMaterial === 'liquidGlass' || props.draft.liquidGlass.navigationEnabled)
)
const playerGlass = computed(
  () =>
    !props.workshopModel &&
    props.active !== false &&
    documentVisible.value &&
    props.draft.surfaceMaterial !== 'transparent' &&
    playerSettings.value.mode === 'standard' &&
    (props.draft.surfaceMaterial === 'liquidGlass' || props.draft.liquidGlass.playbarEnabled)
)
const sceneModel = shallowRef({
  navigationExpanded: navigationExpanded.value,
  navigationGlass: navigationGlass.value,
  playerGlass: playerGlass.value,
  playerMode: playerSettings.value.mode,
  navigationPages: normalizeNavigationPagePreferences(navigationSettings.value),
  playerLayout: normalizePlayerBarLayout(playerSettings.value.layout),
  appearance: cloneAppearance({ ...props.draft, playerBar: playerSettings.value }),
  pages: props.pages?.map((page) => ({ ...page, target: { ...page.target } }))
})
function updateSceneModel(): void {
  // Commit a detached scene snapshot once per visible update. Camera frames never
  // invalidate the native component tree; hidden drafts wait for the next reveal.
  const previous = sceneModel.value
  const navigationPages = normalizeNavigationPagePreferences(navigationSettings.value)
  const playerLayout = normalizePlayerBarLayout(playerSettings.value.layout)
  const appearance = cloneAppearance({ ...props.draft, playerBar: playerSettings.value })
  const pages = props.pages?.map((page) => ({ ...page, target: { ...page.target } }))
  const next = {
    navigationExpanded: navigationExpanded.value,
    navigationGlass: navigationGlass.value,
    playerGlass: playerGlass.value,
    playerMode: playerSettings.value.mode,
    navigationPages:
      JSON.stringify(navigationPages) === JSON.stringify(previous.navigationPages)
        ? previous.navigationPages
        : navigationPages,
    playerLayout:
      JSON.stringify(playerLayout) === JSON.stringify(previous.playerLayout)
        ? previous.playerLayout
        : playerLayout,
    appearance:
      JSON.stringify(appearance) === JSON.stringify(previous.appearance)
        ? previous.appearance
        : appearance,
    pages: JSON.stringify(pages) === JSON.stringify(previous.pages) ? previous.pages : pages
  }
  if ((Object.keys(next) as (keyof typeof next)[]).some((key) => next[key] !== previous[key]))
    sceneModel.value = next
}
let sheet: HTMLStyleElement | undefined
let resizeObserver: ResizeObserver | undefined
let stylesObserver: MutationObserver | undefined
let rootObserver: MutationObserver | undefined
let paintObserver: MutationObserver | undefined
let backgroundFallback: ReturnType<typeof mountBackgroundImageFallback> | undefined
let backgroundFallbackElement: HTMLElement | undefined
let observedPaintScene: HTMLElement | undefined
let acknowledgeNativePaint: (() => void) | undefined
let refreshFrame = 0
let stylesFrame = 0
let updateFrame = 0
let measureFrame = 0
const styleCopies = new Map<Element, { copy: HTMLElement; signature: string }>()
let disposed = false
let sceneReady = false
let resumePending = false
let introGate = false
let introTimer: ReturnType<typeof setTimeout> | undefined
let introHandles: UiMotionHandle[] = []

function previewIsActive(): boolean {
  return (
    !disposed &&
    props.active !== false &&
    !document.hidden &&
    document.documentElement.dataset.teVisibility !== 'hidden'
  )
}
function revealScene(): void {
  if (!sceneReady || !introGate || revealed.value || disposed) return
  revealed.value = true
  syncParallaxActivity()
  loadingPhase.value = 'revealing'
  void nextTick().then(async () => {
    if (disposed || !world.value) return
    if (!previewIsActive()) {
      loadingPhase.value = 'ready'
      return
    }
    const handle = uiMotionFor(document).control(world.value, 'reveal')
    introHandles.push(handle)
    await handle.finished
    if (!disposed) {
      for (const effect of introHandles) effect.cancel()
      introHandles = []
      loadingPhase.value = 'ready'
    }
  })
}
function finishIntro(): void {
  clearTimeout(introTimer)
  introTimer = undefined
  introGate = true
  for (const handle of introHandles) handle.cancel()
  introHandles = []
  revealScene()
}
function startIntro(): void {
  if (!host.value) return
  if (!previewIsActive()) {
    finishIntro()
    return
  }
  const motion = uiMotionFor(document)
  const edgeColor = 'var(--te-settings-text)'
  const outline = motion.edge(host.value, {
    edges: 'all',
    radius: 10,
    duration: 340,
    color: edgeColor
  })
  introHandles.push(outline)
  void outline.finished.then(() => {
    const mode = document.documentElement.dataset.teMotion
    if (!revealed.value && (mode === 'off' || mode === 'reduced' || document.hidden)) finishIntro()
  })
  const title = document.querySelector<HTMLElement>('.title-bar')
  if (outline.enabled && title)
    introHandles.push(
      motion.edge(title, {
        edges: 'bottom',
        radius: 0,
        duration: 340,
        color: edgeColor
      })
    )
  if (!outline.enabled) introGate = true
  else
    introTimer = setTimeout(() => {
      introTimer = undefined
      introGate = true
      loadingPhase.value = 'waiting'
      revealScene()
    }, 120)
  revealScene()
}
function cancelScheduledWork(): void {
  cancelAnimationFrame(refreshFrame)
  cancelAnimationFrame(stylesFrame)
  cancelAnimationFrame(updateFrame)
  cancelAnimationFrame(measureFrame)
  refreshFrame = stylesFrame = updateFrame = measureFrame = 0
}
function activityChanged(): void {
  documentVisible.value =
    !document.hidden && document.documentElement.dataset.teVisibility !== 'hidden'
  const active = previewIsActive()
  layerTransition.setActive(active)
  syncParallaxActivity()
  if (active) {
    // Publish one camera only after the latest hidden edits have reached the
    // scene and its bounds. Activating first would animate from stale geometry.
    engine.setActive(false)
    resumePending = true
    syncStyles()
    void nextTick().then(measure)
  } else {
    engine.setActive(false)
    resumePending = false
    cancelScheduledWork()
    clearLayerView()
    cleanupDecorations?.()
    cleanupDecorations = undefined
    finishIntro()
    cancelPointerInteraction()
  }
}

function scheduleMeasure(): void {
  if (measureFrame || !previewIsActive()) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0
    measure()
  })
}
function measure(): void {
  if (!previewIsActive()) return
  const sourceSize = props.workshopModel
    ? { width: props.workshopModel.scene.width, height: 760 }
    : { width: window.innerWidth, height: window.innerHeight }
  if (!sameEditorSize(viewport.value, sourceSize)) viewport.value = sourceSize
  const rect = host.value?.getBoundingClientRect()
  pointerBounds = rect
  // Floating properties belong to the editor UI, never to the source scene or
  // camera bounds. All focused objects share the full canvas center.
  if (rect) {
    canvasSize = { width: rect.width, height: rect.height }
    // Keep the whole 3D assembly clear of the angle and camera controls.
    // Floating inspectors remain overlays and do not change the camera's fit.
    engine.resize(
      canvasSize,
      layeredPresentation.value
        ? [
            { left: 0, top: 0, width: 76, height: canvasSize.height },
            { left: 0, top: canvasSize.height - 116, width: canvasSize.width, height: 116 }
          ]
        : []
    )
    paintContextTools(engine.snapshot().camera)
  }
  refreshRegions()
}
function workshopCommitted(): boolean {
  const expected = props.workshopModel
  const actual = committedWorkshop
  const scene = frame.value?.contentDocument?.querySelector<HTMLElement>(
    '.appearance-preview-scene'
  )
  return (
    !!expected?.project &&
    actual?.project === expected.project &&
    actual.css === expected.css &&
    actual.scene.surface === expected.scene.surface &&
    actual.scene.state === expected.scene.state &&
    actual.scene.tone === expected.scene.tone &&
    actual.scene.width === expected.scene.width &&
    scene?.dataset.workshopSurface === expected.scene.surface &&
    scene.dataset.workshopState === expected.scene.state
  )
}
async function inspectWorkshop() {
  if (!previewIsActive()) throw new Error('共享预览不可见，画布检查尚未完成')
  await nextTick()
  // Async scene imports and mirrored styles may arrive after the editor model.
  // Bound readiness to the visible scene, including when RAF is suspended.
  await new Promise<void>((resolve, reject) => {
    let tick = 0
    const deadline = setTimeout(() => finish(new Error('共享预览尚未就绪，画布检查尚未完成')), 1500)
    const finish = (error?: Error): void => {
      clearTimeout(deadline)
      cancelAnimationFrame(tick)
      document.removeEventListener('visibilitychange', checkVisibility)
      if (error) reject(error)
      else resolve()
    }
    const checkVisibility = (): void => {
      if (!previewIsActive()) finish(new Error('共享预览不可见，画布检查尚未完成'))
    }
    const check = (): void => {
      if (!previewIsActive()) return finish(new Error('共享预览不可见，画布检查尚未完成'))
      const doc = frame.value?.contentDocument
      const scene = doc?.querySelector<HTMLElement>('.appearance-preview-scene')
      const model = props.workshopModel
      if (
        workshopCommitted() &&
        model?.project &&
        scene?.dataset.workshopState === model.scene.state &&
        renderedWorkshop.value?.css === model.css &&
        doc?.documentElement.dataset.theme === model.scene.tone &&
        viewport.value.width === model.scene.width
      )
        return finish()
      tick = requestAnimationFrame(check)
    }
    document.addEventListener('visibilitychange', checkVisibility)
    tick = requestAnimationFrame(check)
  })
  const doc = frame.value?.contentDocument
  const scene = doc?.querySelector<HTMLElement>('.appearance-preview-scene')
  if (
    !previewIsActive() ||
    !workshopCommitted() ||
    !doc ||
    !scene ||
    !renderedWorkshop.value?.project ||
    renderedWorkshop.value.css !== props.workshopModel?.css ||
    scene.dataset.workshopState !== renderedWorkshop.value.scene.state
  )
    throw new Error('共享预览尚未就绪，画布检查尚未完成')
  const visibility = scene.style.visibility
  const focus = scene.dataset.previewFocus
  try {
    // Inspect the source synchronously without painting it over the 3D display.
    // Display-only fading must not turn a theme's contrast check into a false pass.
    scene.style.visibility = 'visible'
    scene.dataset.previewFocus = 'overview'
    return inspectWorkshopPreview(doc, scene)
  } finally {
    scene.style.visibility = visibility
    if (focus === undefined) delete scene.dataset.previewFocus
    else scene.dataset.previewFocus = focus
  }
}
function highlightWorkshop(selector: string): void {
  const doc = frame.value?.contentDocument
  const node = doc?.querySelector<HTMLElement>(selector)
  if (!node || !previewIsActive()) return
  setLayeredView(false)
  restoreHighlight?.()
  node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const outline = node.style.outline
  node.style.outline = `2px solid ${previewTone.value === 'dark' ? '#dedede' : '#4d5056'}`
  clearTimeout(highlightTimer)
  restoreHighlight = () => {
    if (node.isConnected) node.style.outline = outline
  }
  highlightTimer = setTimeout(() => {
    restoreHighlight?.()
    restoreHighlight = undefined
  }, 1500)
}
function workshopRegion(x: number, y: number): void {
  const hit = [...nativeNodes]
    .reverse()
    .find(
      (node) =>
        node.id !== 'inner-panel' &&
        x >= node.rect.left &&
        x <= node.rect.left + node.rect.width &&
        y >= node.rect.top &&
        y <= node.rect.top + node.rect.height
    )
  emit('region', (hit?.id ?? 'overview') as AppearancePart, new MouseEvent('click'))
}
function clearLayerView(): void {
  parallax.setActive(false)
  layerProjection = undefined
  layerReveal?.cancel()
  layerReveal = undefined
  layerView?.clear()
  if (layerPolygons.value.length) layerPolygons.value = []
  const scene = frame.value?.contentDocument?.querySelector<HTMLElement>(
    '.appearance-preview-scene'
  )
  if (scene?.style.visibility) scene.style.visibility = ''
}
function observeNativePaint(scene: HTMLElement): void {
  if (observedPaintScene === scene) return
  paintObserver?.disconnect()
  observedPaintScene = scene
  let signatures = new WeakMap<HTMLElement, string>()
  const iconSignature = (): string =>
    [...scene.querySelectorAll('[data-theme-icon-slot]')].map((icon) => icon.outerHTML).join('\n')
  let iconsSnapshot = ''
  const signature = (element: HTMLElement): string => {
    const scope = element.getAttribute('data-te-appearance-skin')
    if (!scope) return ''
    return [
      scope,
      ...[...element.style]
        .filter((name) => name.startsWith('--te-skin-'))
        .sort()
        .map((name) => `${name}:${element.style.getPropertyValue(name)}`)
    ].join('\n')
  }
  acknowledgeNativePaint = () => {
    iconsSnapshot = iconSignature()
    signatures = new WeakMap()
    for (const element of [
      scene,
      ...scene.querySelectorAll<HTMLElement>('[data-te-appearance-skin]')
    ])
      signatures.set(element, signature(element))
  }
  acknowledgeNativePaint()
  paintObserver = new MutationObserver((records) => {
    let changed = false
    let iconsChanged = false
    for (const record of records) {
      const target = record.target as Element
      const icon = target.closest?.('[data-theme-icon-slot]')
      if (icon && scene.contains(icon)) iconsChanged = true
      if (record.type === 'childList')
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType !== 1) continue
          const element = node as Element
          if (
            element.matches('[data-theme-icon-slot]') ||
            element.querySelector('[data-theme-icon-slot]')
          )
            iconsChanged = true
        }
    }
    for (const element of new Set(
      records
        .filter(
          (record) =>
            record.attributeName === 'style' || record.attributeName === 'data-te-appearance-skin'
        )
        .map((record) => record.target as HTMLElement)
    )) {
      if (!scene.contains(element)) continue
      const next = signature(element)
      if ((signatures.get(element) ?? '') === next) continue
      signatures.set(element, next)
      changed = true
    }
    if (iconsChanged) {
      const next = iconSignature()
      if (iconsSnapshot !== next) {
        iconsSnapshot = next
        changed = true
      }
    }
    // Image decoding can complete after the draft's static clone was built.
    // Icon bindings can also change native DOM without changing any CSS token.
    // Rebind only these native paints; camera frames never scan or clone.
    if (changed && previewIsActive() && layeredPresentation.value) {
      sceneRevision++
      // The normal model/style refresh already includes its Vue DOM changes.
      // Asynchronous image-only changes arrive without one and need a rebind.
      if (!refreshFrame && !updateFrame && !stylesFrame) presentScene()
    }
  })
  paintObserver.observe(scene, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: [
      'style',
      'data-te-appearance-skin',
      'data-theme-icon-slot',
      'data-theme-icon-custom',
      'class',
      'src',
      'href',
      'xlink:href',
      'visibility'
    ]
  })
}
function updatePresentationFocus(): void {
  const scene = frame.value?.contentDocument?.querySelector<HTMLElement>(
    '.appearance-preview-scene'
  )
  if (!scene || !previewIsActive()) return
  const selected = selectedRegion.value
  const focus = nativeNodes.find((node) => node.id === selected)?.rect
  const navigation = nativeNodes.find((node) => node.id === 'navigation')?.rect
  const behind = !!(
    !layeredPresentation.value &&
    // Title and player already paint above navigation; only content can be
    // obscured by it. Overlap alone must not hide an unobstructed sidebar.
    (selected === 'card' || selected === 'controls') &&
    focus &&
    navigation &&
    focus.left < navigation.left + navigation.width &&
    focus.left + focus.width > navigation.left &&
    focus.top < navigation.top + navigation.height &&
    focus.top + focus.height > navigation.top
  )
  navigationBehind.value = behind
  if (scene.dataset.previewFocus !== selected) scene.dataset.previewFocus = selected
  const relief = behind ? 'behind' : 'normal'
  if (scene.dataset.previewNavigationLayer !== relief) scene.dataset.previewNavigationLayer = relief
}
function presentScene(): void {
  const doc = frame.value?.contentDocument
  const scene = doc?.querySelector<HTMLElement>('.appearance-preview-scene')
  if (!doc || !scene || !previewIsActive()) return
  let presented = nativeNodes
  if (layeredPresentation.value) {
    layerView ??= createAppearanceLayerView(doc)
    const previousElement = layerView.element
    const view = layerView.sync({
      scene,
      size: viewport.value,
      nodes: nativeNodes,
      ...layerPose(),
      selected: selectedRegion.value,
      skinOverflow: createAppearanceSkinOverflow,
      revision: sceneRevision
    })
    if (layerView.element !== previousElement) acknowledgeNativePaint?.()
    presented = view.nodes
    layerProjection = view
    layerPolygons.value = view.polygons
    syncParallaxActivity()
    void nextTick().then(paintLayerProjection)
    if (layerView.element && layerView.element !== previousElement) {
      layerReveal?.cancel()
      // A draft refresh must stay visible during slider gestures. Reveal only
      // when entering the layered view, never restart it for each revision.
      // The unfold already animates the sheets. A second opacity reveal makes
      // transparent materials flash against the stage during each 2D/3D entry.
      layerReveal = undefined
    }
    if (scene.style.visibility !== 'hidden') scene.style.visibility = 'hidden'
    navigationBehind.value = false
    if (scene.dataset.previewNavigationLayer !== 'normal')
      scene.dataset.previewNavigationLayer = 'normal'
  } else clearLayerView()
  if (
    regions.value.length !== presented.length ||
    regions.value.some(
      (region, index) =>
        region.id !== presented[index].id || !sameEditorRect(region.rect, presented[index].rect)
    )
  )
    regions.value = presented.map((node) => ({
      id: node.id as RegionId,
      label: definitions.find((item) => item.id === node.id)!.label,
      rect: node.rect
    }))
  if (resumePending && !sceneReady) engine.setActive(true)
  // The camera travels to the final fit while the cached layers unfold.
  const cameraNodes = layeredView.value
    ? projectAppearanceLayers(
        viewport.value,
        nativeNodes,
        layerSpacing.value,
        undefined,
        viewAngles.value
      ).nodes
    : nativeNodes
  // In 3D selection identifies a material, not an instruction to magnify a
  // thin caption/player strip and cut away the rest of the assembly.
  engine.setScene(
    viewport.value,
    layeredView.value
      ? cameraNodes.map((node) => ({ ...node, focus: 'scene' as const }))
      : cameraNodes
  )
  if (resumePending) {
    resumePending = false
    engine.setActive(true)
  }
}
function refreshRegions(): void {
  if (!previewIsActive() || refreshFrame) return
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0
    if (!previewIsActive()) return
    const doc = frame.value?.contentDocument
    if (!doc) return
    const wallpaper = doc.querySelector<HTMLElement>(
      'body > .appearance-preview-scene > .appearance-window-background'
    )
    if (wallpaper !== backgroundFallbackElement) {
      backgroundFallback?.dispose()
      backgroundFallbackElement = wallpaper ?? undefined
      backgroundFallback = wallpaper
        ? mountBackgroundImageFallback(wallpaper, () => {
            sceneRevision++
            refreshRegions()
          })
        : undefined
    }
    backgroundFallback?.refresh()
    if (renderedWorkshop.value?.project && doc.querySelector('.appearance-preview-scene')) {
      cleanupDecorations ??= mountWorkshopDecorations(doc)
      workshopBoxes.value = workshopCanvasBoxes(
        doc,
        renderedWorkshop.value.project,
        renderedWorkshop.value.scene.tone
      )
    } else if (workshopBoxes.value.length) workshopBoxes.value = []
    const player = doc.querySelector('.player-bar-shell')?.getBoundingClientRect()
    const shell = doc.querySelector<HTMLElement>('.app-shell')
    if (player && shell) {
      // Match App's overlay: only the scrollable contents clear the player.
      // Derive clearance from this draft's real bar, not the host's saved mode.
      const clearance = `${Math.max(0, Math.ceil(viewport.value.height - player.top))}px`
      for (const [name, value] of Object.entries({
        '--te-side-menu-bottom': '0px',
        '--te-side-menu-tools-clearance': '0px',
        '--te-playbar-bottom-clearance': clearance
      })) {
        if (shell.style.getPropertyValue(name) !== value) shell.style.setProperty(name, value)
      }
    }
    const measured: (EditorNode & { pose?: string })[] = measureEditorNodes(doc, definitions)
    const sceneForHits = doc.querySelector<HTMLElement>('.appearance-preview-scene')
    surfaceHits.value = sceneForHits ? measureAppearanceSurfaces(sceneForHits, viewport.value) : []
    for (const id of ['card', 'controls'] as const) {
      const surface =
        surfaceHits.value.find(
          (item) => item.id === id && item.element === preferredSurface?.element
        ) ?? surfaceHits.value.find((item) => item.id === id)
      const node = measured.find((item) => item.id === id)
      if (surface && node) Object.assign(node, { rect: surface.rect, pose: surface.pose })
    }
    if (
      nativeNodes.length !== measured.length ||
      nativeNodes.some(
        (node, index) =>
          node.id !== measured[index].id ||
          node.pose !== measured[index].pose ||
          !sameEditorRect(node.rect, measured[index].rect)
      )
    )
      nativeNodes = measured
    const scene = doc.querySelector<HTMLElement>('.appearance-preview-scene')
    if (
      mirroredWorkshop?.project === renderedWorkshop.value?.project &&
      scene?.dataset.workshopSurface === mirroredWorkshop?.scene.surface &&
      scene?.dataset.workshopState === mirroredWorkshop?.scene.state
    )
      committedWorkshop = mirroredWorkshop
    if (scene) observeNativePaint(scene)
    updatePresentationFocus()
    presentScene()
    if (measured.length) {
      sceneReady = true
      revealScene()
    }
  })
}
function update(): void {
  if (!previewIsActive()) return
  const doc = frame.value?.contentDocument
  if (!doc || !sheet) return
  // This transaction already rebuilds the static scene after Vue commits.
  // Observe again at that boundary, so a resumed player's icon replacement
  // cannot race the normal model refresh into a second native clone.
  paintObserver?.disconnect()
  observedPaintScene = undefined
  acknowledgeNativePaint = undefined
  sceneRevision++
  committedWorkshop = undefined
  const wasWorkshop = !!renderedWorkshop.value
  renderedWorkshop.value = props.workshopModel
  if (!props.workshopModel && cleanupDecorations) {
    cleanupDecorations()
    cleanupDecorations = undefined
  }
  if (
    wasWorkshop ||
    props.workshopModel ||
    !sameEditorSize(viewport.value, { width: window.innerWidth, height: window.innerHeight })
  )
    measure()
  updateSceneModel()
  const root = doc.documentElement
  const previewTheme = previewTone.value === 'dark' ? 'dark' : 'pureWhite'
  adaptiveGlassTone.value = document.documentElement.dataset.teLiquidGlassAdaptiveTone
  const mode = document.documentElement.dataset.teMotion
  animated.value = mode === 'full' || (!mode && !motionPreference.matches)
  syncParallaxActivity()
  engine.setAnimated(animated.value)
  layerTransition.setAnimated(animated.value)
  const glass = props.draft.liquidGlass
  const functional = props.draft.surfaceMaterial === 'transparent'
  const resolvedBackground = resolveBackgroundAppearance(
    props.draft.appBackground,
    props.page,
    props.tone
  )
  const customBackground = !props.themeEditing && resolvedBackground.customBackground
  const attributes = new Map(
    [...document.documentElement.attributes].map((attribute) => [attribute.name, attribute.value])
  )
  for (const page of ['app', 'local', 'streaming', 'settings', 'player']) {
    const name = `data-te-${page}-image-fallback-tone`
    const localState = root.getAttribute(name)
    if (localState) attributes.set(name, localState)
    else attributes.delete(name)
  }
  for (const [name, value] of Object.entries({
    'data-theme': previewTheme,
    'data-te-surface-material': props.draft.surfaceMaterial,
    'data-te-navigation-liquid-glass': navigationGlass.value ? 'on' : 'off',
    'data-te-playbar-liquid-glass':
      (props.draft.surfaceMaterial === 'liquidGlass' || glass.playbarEnabled) && !functional
        ? 'on'
        : 'off',
    'data-te-home-liquid-glass': 'off',
    'data-te-liquid-glass-coverage': 'functional',
    'data-te-app-custom-background': customBackground ? 'on' : 'off',
    'data-te-local-custom-background': customBackground ? 'on' : 'off',
    'data-te-card-custom':
      !props.themeEditing &&
      props.draft.cardAppearance.enabled &&
      props.draft.surfaceMaterial === 'standard'
        ? 'on'
        : 'off'
  }))
    attributes.set(name, value)
  if (props.workshopModel?.project) {
    for (const name of THEME_MANAGED_DATA_ATTRIBUTES) attributes.delete(name)
    for (const [name, value] of Object.entries(
      workshopRuntimeAttributes(props.workshopModel.project)
    ))
      attributes.set(name, value)
    attributes.set('data-theme', previewTheme)
  }
  const { background } = resolvedBackground
  const backgroundVars = backgroundCssVariables(
    customBackground ? background : { ...background, kind: 'theme' },
    props.tone
  )
  if (!props.workshopModel) {
    attributes.set(
      'data-te-local-text-tone',
      customBackground ? resolveBackgroundTextTone(background, props.tone) : 'theme'
    )
    attributes.set(
      'data-te-local-image-palette',
      customBackground && resolveBackgroundPalette(background, props.tone) ? 'on' : 'off'
    )
    attributes.set(
      'data-te-local-text-tone-source',
      !customBackground
        ? 'theme'
        : resolvedBackground.effect.textTone !== 'theme'
          ? 'manual'
          : resolveBackgroundPalette(background, props.tone)
            ? 'auto'
            : 'theme'
    )
  }
  if (!customBackground) {
    backgroundVars['--appearance-color'] = 'var(--te-local-bg, var(--te-app-bg))'
    backgroundVars['--appearance-image'] = 'var(--te-local-bg-image, var(--te-app-bg-image, none))'
  }
  const vars: Record<string, string> = props.workshopModel
    ? {
        ...themeTokensToCssVariables(TWILIGHT_DEFAULT_THEME.variants[previewTheme].tokens),
        '--appearance-color': 'var(--te-local-bg, var(--te-app-bg))',
        '--appearance-image': 'var(--te-app-bg-image, none)'
      }
    : {
        ...(document.documentElement.dataset.theme === previewTheme
          ? {}
          : themeTokensToCssVariables(
              TWILIGHT_DEFAULT_THEME.variants[props.tone === 'dark' ? 'dark' : 'pureWhite'].tokens
            )),
        ...backgroundVars,
        // The scene uses the real local-page foreground and control selectors,
        // independent of the host page and its confirmed background.
        ...Object.fromEntries(
          Object.entries(backgroundVars).map(([name, value]) => [
            `--te-local-background-${name.slice('--appearance-'.length)}`,
            value
          ])
        ),
        ...liquidGlassCssVariables(glass[glassTone.value]),
        ...liquidGlassExpandedCssVariables(glass[glassTone.value]),
        ...liquidGlassHomeCardCssVariables(glass.homeCards[props.tone]),
        ...(!props.themeEditing &&
        props.draft.cardAppearance.enabled &&
        props.draft.surfaceMaterial === 'standard'
          ? cardCssVariables(props.draft.cardAppearance[props.tone])
          : {}),
        ...(customBackground && resolvedBackground.colorOverride
          ? {
              '--te-app-bg': backgroundVars['--appearance-color'],
              '--te-local-bg': backgroundVars['--appearance-color']
            }
          : {})
      }
  if (!props.workshopModel && !customBackground) {
    for (const page of ['app', 'local'] as const) {
      const color = TWILIGHT_DEFAULT_THEME.variants[previewTheme].tokens[`surface.${page}`]
      const sameTone = document.documentElement.dataset.theme === previewTheme
      vars[`--te-${page}-bg`] = sameTone ? `var(--te-theme-${page}-bg, ${color})` : color
      vars[`--te-${page}-bg-image`] = sameTone
        ? `var(--te-theme-${page}-bg-image, var(--te-theme-background-image, none))`
        : 'none'
    }
  }
  // Filter overridden host variables before mirroring, avoiding a live style write/remove cycle.
  mirrorStyle.cssText = attributes.get('style') ?? ''
  if (props.workshopModel)
    for (const name of [...Array(mirrorStyle.length)].map((_, index) => mirrorStyle.item(index)))
      if (name.startsWith('--te-') || name.startsWith('--appearance-'))
        mirrorStyle.removeProperty(name)
  for (const key of Object.keys(vars)) mirrorStyle.removeProperty(key)
  // The scene owns window paint, including the separate planes in 3D.
  // Merge this with mirrored styles so updates never write/remove it twice.
  mirrorStyle.setProperty('background', 'transparent', 'important')
  if (mirrorStyle.cssText) attributes.set('style', mirrorStyle.cssText)
  else attributes.delete('style')
  for (const attribute of [...root.attributes])
    if (!attributes.has(attribute.name)) root.removeAttribute(attribute.name)
  for (const [name, value] of attributes)
    if (root.getAttribute(name) !== value) root.setAttribute(name, value)
  const bodyClasses = [
    ...new Set(
      [...document.body.classList]
        .filter(
          (name) =>
            !['te-settings-surface', 'te-streaming-surface', 'te-local-surface'].includes(name)
        )
        .concat(
          props.workshopModel?.scene.surface.startsWith('streaming')
            ? 'te-streaming-surface'
            : props.workshopModel?.scene.surface === 'settings'
              ? 'te-settings-surface'
              : 'te-local-surface'
        )
    )
  ].join(' ')
  if (doc.body.className !== bodyClasses) doc.body.className = bodyClasses
  if (
    doc.body.style.getPropertyValue('background') !== 'transparent' ||
    doc.body.style.getPropertyPriority('background') !== 'important'
  )
    doc.body.style.setProperty('background', 'transparent', 'important')
  const css = `:root{${Object.entries(vars)
    .map(([key, value]) => `${key}:${value}${props.workshopModel ? '' : '!important'}`)
    .join(';')}}
    html,body{margin:0;width:100%;height:100%;overflow:hidden;pointer-events:${props.workshopModel ? 'auto' : 'none'}}
    html:root body::before,html:root body::after{content:none!important;display:none!important}
    *,*::before,*::after{animation:none!important;transition:none!important}
    .app-shell{height:100%;isolation:isolate}.app-shell::after{border:0}.appearance-window-background{position:absolute;inset:0;z-index:-2;overflow:hidden;background:var(--appearance-color)}
    body > .appearance-preview-scene > .appearance-window-background{z-index:-2}
    /* Only an explicit full-window skin moves the legacy wallpaper behind the
       rounded inner surface. Its default full-window geometry stays compatible. */
    .app-shell[data-te-appearance-skin="outer-panel"] > .appearance-window-background{clip-path:inset(var(--te-window-content-top) var(--te-window-surface-inset) var(--te-window-content-bottom) round var(--te-window-inner-radius))!important}
    .appearance-window-background .app-background-image{position:absolute;inset:calc(-3 * var(--appearance-blur));background-image:var(--appearance-image);background-size:cover;background-position:var(--appearance-position);filter:blur(var(--appearance-blur)) brightness(var(--appearance-brightness));transform:scale(var(--appearance-scale))}
    .appearance-window-background .app-background-dim{position:absolute;inset:0;background:rgba(0,0,0,var(--appearance-dim))}
    ${!props.workshopModel && !customBackground ? 'html .appearance-window-background{background:transparent}html .appearance-window-background > :is(.app-background-image,.app-background-dim){display:none}' : ''}
    .app-shell-title{position:relative;z-index:2100}.app-shell-navigation{position:relative;z-index:1900}.app-shell-player{position:relative;z-index:2000}
    body > .appearance-preview-scene[data-preview-navigation-layer="behind"] > .app-shell-navigation{z-index:0!important}
    ${appearanceBackgroundForegroundCss('body > .appearance-preview-scene')}
    .appearance-layer-view [data-preview-focus="inner-panel"] [data-appearance-layer="content"]::after{content:"";display:block;position:absolute;inset:0;pointer-events:none;border-radius:var(--te-window-outer-radius,10px);outline:1px solid color-mix(in srgb,var(--te-neutral-900) 28%,transparent);outline-offset:-1px}
    ${props.workshopModel?.css ?? ''}`
  if (sheet.textContent !== css) sheet.textContent = css
  mirroredWorkshop = props.workshopModel
  contextColor.value = props.workshopModel
    ? doc.defaultView?.getComputedStyle(root).getPropertyValue('--te-app-bg').trim() ||
      'var(--te-app-bg)'
    : (vars['--te-app-bg'] ?? 'var(--te-app-bg)')
  void nextTick().then(() => {
    if (disposed) return
    // Reuse App's shell geometry too; component CSS alone cannot reproduce the
    // live grid, content box and viewport overlays for every theme.
    const appScopes =
      document
        .querySelector('.app-shell')
        ?.getAttributeNames()
        .filter((name) => name.startsWith('data-v-')) ?? []
    for (const element of doc.querySelectorAll(
      '.app-shell,.app-shell-title,.app-shell-navigation,.app-shell-content,.app-shell-player,.main-content,.title-bar,.side-menu,.player-bar-shell,.dashboard-wrapper'
    )) {
      for (const attribute of appScopes)
        if (!element.hasAttribute(attribute)) element.setAttribute(attribute, '')
    }
    refreshRegions()
  })
}
function syncStyles(): void {
  if (!previewIsActive()) return
  const doc = frame.value?.contentDocument
  if (!doc) return
  const sources = [...document.head.querySelectorAll('style,link[rel="stylesheet"]')].filter(
    (source) =>
      !source.hasAttribute('data-appearance-layers') &&
      (!props.workshopModel || !['workshop-trial', 'twilight-theme-runtime'].includes(source.id))
  )
  for (const [source, entry] of styleCopies) {
    if (!sources.includes(source)) {
      entry.copy.remove()
      styleCopies.delete(source)
    }
  }
  for (const source of sources) {
    const signature = source.outerHTML
    let entry = styleCopies.get(source)
    if (entry?.signature === signature) continue
    const copy = source.cloneNode(true) as HTMLElement
    copy.dataset.appearanceHostStyle = ''
    copy.addEventListener('load', refreshRegions, { once: true })
    if (entry) entry.copy.replaceWith(copy)
    else doc.head.insertBefore(copy, sheet ?? null)
    entry = { copy, signature }
    styleCopies.set(source, entry)
  }
  update()
}
function scheduleStyles(): void {
  if (stylesFrame || !previewIsActive()) return
  stylesFrame = requestAnimationFrame(() => {
    stylesFrame = 0
    syncStyles()
  })
}
function scheduleUpdate(): void {
  if (updateFrame || !previewIsActive()) return
  updateFrame = requestAnimationFrame(() => {
    updateFrame = 0
    update()
  })
}
function ready(): void {
  const doc = frame.value?.contentDocument
  if (!doc || target.value === doc.body || disposed) return
  paintObserver?.disconnect()
  observedPaintScene = undefined
  acknowledgeNativePaint = undefined
  controlLayers?.dispose()
  controlLayers = mountAppearanceLayers(doc)
  controlLayers.update(props.draft.appearanceLayers, props.tone)
  sheet = doc.createElement('style')
  sheet.dataset.appearancePreviewVars = ''
  doc.head.append(sheet)
  target.value = doc.body
  scrollDocument?.removeEventListener('scroll', refreshRegions, true)
  scrollDocument = doc
  doc.addEventListener('scroll', refreshRegions, true)
  syncStyles()
}
watch(() => [props.draft, props.tone, props.page, props.themeEditing], scheduleUpdate, {
  deep: true,
  flush: 'post'
})
watch(
  () => [props.draft.appearanceLayers, props.tone, props.active],
  () => {
    controlLayers?.update(props.draft.appearanceLayers, props.tone)
    controlLayers?.setActive(props.active !== false)
  },
  { deep: true, flush: 'post' }
)
watch(
  [
    () => props.workshopModel?.css,
    () => props.workshopModel?.project,
    () => props.workshopModel?.scene
  ],
  scheduleStyles,
  { flush: 'post' }
)
watch(
  [
    () => props.workshopModel?.selectedLayer,
    () => props.workshopModel?.canvasEditing,
    () => props.workshopModel?.checking
  ],
  () => {
    if (previewIsActive()) renderedWorkshop.value = props.workshopModel
  },
  { flush: 'post' }
)
watch(navigationExpanded, scheduleUpdate)
watch(() => playerSettings.value.mode, scheduleUpdate, { flush: 'post' })
watch(() => [navigationSettings.value, playerSettings.value.layout, props.pages], scheduleUpdate, {
  deep: true,
  flush: 'post'
})
watch(() => props.active, activityChanged, { immediate: true })
const scrollbarPresentationClasses = new Set([
  'te-auto-scrollbar',
  'is-scrollbar-near',
  'is-scrollbar-active'
])
function rootChangeAffectsPreview(record: MutationRecord): boolean {
  const name = record.attributeName
  if (!name || name === 'data-te-visibility') return false
  const value = document.documentElement.getAttribute(name)
  if (record.oldValue === value) return false
  if (name !== 'class') return true
  const contentClasses = (classes: string | null) =>
    (classes ?? '')
      .split(/\s+/)
      .filter((token) => token && !scrollbarPresentationClasses.has(token))
      .join(' ')
  // Only transient scrollbar affordances are omitted. Unknown theme/plugin
  // classes and every changed public data/style attribute still mirror.
  return contentClasses(record.oldValue) !== contentClasses(value)
}
onMounted(() => {
  startIntro()
  ready()
  measure()
  // Updating the source aspect ratio can resize this observed host. Leave the
  // observer delivery before committing those layout changes.
  resizeObserver = new ResizeObserver(scheduleMeasure)
  if (host.value) resizeObserver.observe(host.value)
  window.addEventListener('resize', measure)
  window.addEventListener('blur', cancelPointerInteraction)
  window.addEventListener('scroll', invalidatePointerBounds, true)
  document.addEventListener('visibilitychange', activityChanged)
  motionPreference.addEventListener('change', scheduleUpdate)
  stylesObserver = new MutationObserver(scheduleStyles)
  stylesObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  rootObserver = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === 'data-te-visibility')) activityChanged()
    if (records.some(rootChangeAffectsPreview)) scheduleUpdate()
  })
  rootObserver.observe(document.documentElement, { attributes: true, attributeOldValue: true })
})
onBeforeUnmount(() => {
  controlLayers?.dispose()
  backgroundFallback?.dispose()
  disposed = true
  endGesture()
  finishIntro()
  engine.dispose()
  layerTransition.dispose()
  parallax.dispose()
  regionElements.clear()
  layerReveal?.cancel()
  layerView?.dispose()
  cleanupDecorations?.()
  restoreHighlight?.()
  clearTimeout(highlightTimer)
  scrollDocument?.removeEventListener('scroll', refreshRegions, true)
  window.removeEventListener('resize', measure)
  window.removeEventListener('blur', cancelPointerInteraction)
  window.removeEventListener('scroll', invalidatePointerBounds, true)
  document.removeEventListener('visibilitychange', activityChanged)
  motionPreference.removeEventListener('change', scheduleUpdate)
  resizeObserver?.disconnect()
  contextToolsObserver?.disconnect()
  stylesObserver?.disconnect()
  rootObserver?.disconnect()
  paintObserver?.disconnect()
  observedPaintScene = undefined
  acknowledgeNativePaint = undefined
  cancelScheduledWork()
  styleCopies.clear()
})
</script>

<template>
  <div
    ref="host"
    class="appearance-window-preview"
    :style="hostStyle"
    :data-source-width="viewport.width"
    :data-source-height="viewport.height"
    :data-glass-tone="glassTone"
    :data-loading-phase="loadingPhase"
    :data-preview-view="layeredPresentation ? 'layered' : 'flat'"
    :data-focused-region="selectedRegion"
    :data-view-transition="layerTransitioning ? 'running' : 'idle'"
    :data-navigation-relief="navigationBehind ? 'behind' : 'normal'"
    :aria-busy="!revealed"
    :class="{ 'is-dragging': dragging, 'has-motion': animated }"
    tabindex="0"
    role="group"
    aria-label="外观画布，滚轮缩放，拖动平移，按 0 适合部件"
    @wheel.prevent="zoomWheel"
    @pointerdown="pointerDown"
    @pointermove.stop="pointerMove"
    @pointerenter="pointerEnter"
    @pointerleave="pointerLeave"
    @pointerup="pointerUp"
    @pointercancel="pointerUp"
    @lostpointercapture="lostPointerCapture"
    @keydown="viewportKeydown"
    @click="resetFocus"
  >
    <div v-if="!revealed" class="appearance-preview-placeholder" aria-hidden="true" />
    <div
      ref="world"
      class="appearance-editor-world"
      :class="{ 'is-available': revealed }"
      :style="worldStyle"
      :inert="!revealed"
    >
      <iframe
        ref="frame"
        title="真实窗口等比例预览（示例信息）"
        sandbox="allow-same-origin"
        src="about:blank"
        :tabindex="workshopInteraction ? 0 : -1"
        :aria-hidden="!workshopInteraction"
        :style="{ pointerEvents: workshopInteraction ? 'auto' : 'none' }"
        @load="ready"
      />
      <WorkshopCanvasOverlay
        v-if="renderedWorkshop?.project && !layeredPresentation"
        :boxes="workshopBoxes"
        :project="renderedWorkshop.project"
        :tone="renderedWorkshop.scene.tone"
        :width="viewport.width"
        :height="viewport.height"
        :selected="renderedWorkshop.selectedLayer"
        :enabled="renderedWorkshop.canvasEditing && active !== false && documentVisible"
        @select="(id, surface) => emit('workshopLayerSelect', id, surface)"
        @edit="(id, surface, patch) => emit('workshopLayerEdit', id, surface, patch)"
        @gesture="emit('workshopGesture', $event)"
        @region="workshopRegion"
        @click.stop
      />
      <div
        class="appearance-editor-context"
        :class="{ 'is-active': !!focusedPart }"
        aria-hidden="true"
        :style="{ '--appearance-context-color': contextColor }"
      >
        <svg v-if="layeredPresentation" :viewBox="`0 0 ${viewport.width} ${viewport.height}`">
          <path ref="layerContextPath" :d="selectedContextPath" fill-rule="evenodd" />
        </svg>
        <template v-else>
          <div v-for="(panel, index) in contextPanels" :key="index" :style="panel" />
        </template>
      </div>
      <svg
        v-if="layeredPresentation && (selectedPolygon || keyboardPolygon)"
        class="appearance-layer-selection"
        :viewBox="`0 0 ${viewport.width} ${viewport.height}`"
        aria-hidden="true"
      >
        <polygon v-if="selectedPolygon" ref="selectedOutline" :points="selectedPolygon" />
        <polygon
          v-if="keyboardPolygon"
          ref="keyboardOutline"
          class="is-keyboard-focus"
          :points="keyboardPolygon"
        />
      </svg>
      <div
        ref="regionFit"
        class="appearance-region-fit"
        :class="{ 'is-layered': layeredPresentation }"
      >
        <div ref="regionWorld" class="appearance-region-world">
          <button
            v-for="region in workshopInteraction
              ? []
              : selectedRegion === 'inner-panel'
                ? regionViews.filter((item) => item.id === 'inner-panel')
                : regionViews"
            :key="region.key"
            :ref="(element) => setRegionElement(region.key, element)"
            type="button"
            class="appearance-window-region"
            :data-region="region.id"
            :data-pose="region.surface?.pose"
            :style="region.style"
            :aria-pressed="region.id === selectedRegion && region.isTarget"
            :class="{
              'is-selected':
                region.id === selectedRegion && region.isTarget && selectedRegion !== 'inner-panel'
            }"
            :aria-label="region.label"
            :title="region.label"
            @click="selectRegion(region.id, $event, region.surface)"
            @focus="regionFocus(region.id, $event)"
            @blur="keyboardRegion = undefined"
          />
        </div>
      </div>
    </div>
    <div
      v-if="$slots['context-tools']"
      ref="contextTools"
      class="appearance-context-tools"
      data-appearance-floating-tools
      @pointerenter="cancelParallax"
      @focusin="cancelParallax"
      @click.stop
      @pointerdown.stop
      @pointermove.stop
      @pointerup.stop
      @pointercancel.stop
      @wheel.stop
    >
      <slot name="context-tools" :region="selectedRegion" :layered="layeredPresentation" />
    </div>
    <AppearanceViewAngleControl
      v-if="layeredPresentation"
      ref="cameraControls"
      class="appearance-view-angle-controls"
      :model-value="viewAngles"
      :disabled="layerTransitioning || !layeredView"
      @pointerenter="cancelParallax"
      @focusin="cancelParallax"
      @update:model-value="setViewAngles"
      @update:zoom="setCameraZoom"
      @restore="setLayeredView(false)"
    />
    <Teleport v-if="target" :to="target">
      <LiquidGlassDefs
        :active="playerGlass"
        :target-document="previewDocument"
        :theme="draft.liquidGlass[glassTone]"
      />
      <WorkshopPreviewScene
        v-if="renderedWorkshop?.project"
        v-bind="sceneModel"
        :surface="renderedWorkshop.scene.surface"
        :state="renderedWorkshop.scene.state"
        reference-masks
        @vue:mounted="scheduleUpdate"
      />
      <AppearancePreviewScene v-else v-bind="sceneModel" />
    </Teleport>
  </div>
</template>

<style scoped>
.appearance-window-preview {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 0;
  border-radius: 10px;
  background: transparent;
  isolation: isolate;
}
iframe {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  border: 0;
  transform-origin: top left;
  pointer-events: none;
}
.appearance-editor-world {
  position: absolute;
  inset: 0 auto auto 0;
  transform-origin: top left;
  visibility: hidden;
}
.appearance-editor-world.is-available {
  visibility: visible;
}
[data-preview-view='flat'] .appearance-editor-world {
  border-radius: var(--te-window-outer-radius, 10px);
  overflow: hidden;
}
[data-focused-region='inner-panel'][data-preview-view='flat'] .appearance-editor-world::after {
  content: '';
  display: block;
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: var(--te-window-outer-radius, 10px);
  outline: 1px solid color-mix(in srgb, var(--appearance-selection-color) 28%, transparent);
  outline-offset: -1px;
}
.appearance-window-preview.is-dragging .appearance-editor-world {
  will-change: transform;
}
.appearance-preview-placeholder {
  position: absolute;
  inset: 12px;
  border-radius: 10px;
  background: var(--te-subtle-bg, rgb(127 127 127 / 6%));
  pointer-events: none;
}
.appearance-editor-context {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
}
.appearance-editor-context.is-active {
  opacity: 0.6;
}
.has-motion .appearance-editor-context {
  transition: opacity 180ms ease-out;
}
.appearance-window-preview[data-focused-region='inner-panel'] .appearance-editor-context {
  opacity: 0;
  transition: none;
}
.appearance-editor-context > div {
  position: absolute;
  background: var(--appearance-context-color);
}
.appearance-editor-context > svg {
  width: 100%;
  height: 100%;
  overflow: visible;
  fill: var(--appearance-context-color);
}
.appearance-window-preview {
  cursor: grab;
  touch-action: none;
}
.appearance-window-preview.is-dragging,
.appearance-window-preview.is-dragging button {
  cursor: grabbing;
}
.appearance-window-preview:focus-visible {
  outline: 2px solid var(--te-settings-text);
  outline-offset: -3px;
}
.appearance-window-region {
  position: absolute;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent !important;
  border-radius: 6px;
  transform: var(--appearance-region-pose, none) !important;
  box-shadow: none !important;
}
.appearance-window-region::before,
.appearance-window-region::after {
  content: none !important;
  display: none !important;
}
.appearance-window-region:hover {
  outline: 1px solid color-mix(in srgb, var(--te-settings-text) 35%, transparent);
  outline-offset: -1px;
}
.appearance-window-region[data-region='inner-panel']:hover:not(:focus-visible) {
  outline: none;
}
.appearance-layer-selection {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5;
}
.appearance-region-fit,
.appearance-region-world {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
  transform-style: preserve-3d;
}
.appearance-region-fit {
  transform-origin: 0 0;
  transform-style: flat;
}
.appearance-region-world {
  transform-origin: 50% 50% 0;
}
.appearance-region-world > .appearance-window-region {
  pointer-events: auto;
}
.appearance-view-angle-controls {
  --appearance-ruler-drop: 8px;
  inset: 24px 24px calc(18px - var(--appearance-ruler-drop));
  z-index: 4;
}
.appearance-context-tools {
  position: absolute;
  inset: 0 auto auto 0;
  z-index: 6;
  width: max-content;
  max-width: calc(100% - 16px);
  max-height: calc(100% - 16px);
  overflow: auto;
  visibility: hidden;
}
[data-preview-view='layered'] .appearance-context-tools {
  max-width: calc(100% - var(--appearance-tools-left-clearance) - 8px);
  max-height: calc(100% - var(--appearance-tools-bottom-clearance) - 8px);
}
.appearance-layer-selection polygon.is-keyboard-focus {
  stroke: var(--appearance-focus-color);
  stroke-width: 3;
  stroke-opacity: 1;
}
.appearance-layer-selection polygon {
  fill: none;
  stroke: var(--appearance-selection-color);
  stroke-width: 1;
  stroke-opacity: 0.58;
  vector-effect: non-scaling-stroke;
}
[data-preview-view='layered'] .appearance-window-region.is-selected {
  outline: none;
}
.appearance-window-region.is-selected {
  background: transparent !important;
  border: 0;
  box-shadow: none;
  outline: 2px solid color-mix(in srgb, var(--appearance-selection-color) 70%, transparent);
  outline-offset: -2px;
}
.appearance-window-region:focus-visible {
  outline: 3px solid var(--appearance-focus-color);
  outline-offset: -5px;
}
</style>
