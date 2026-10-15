<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { EQ_DISPLAY_RANGES, gainTicksForRange } from '@renderer/utils/eqViewport'
import { useEqSpectrum } from '@renderer/composables/useEqSpectrum'
import EqAnalyzerControls from '@renderer/components/equalizer/EqAnalyzerControls.vue'
import NativeContextMenu from '@renderer/components/NativeContextMenu.vue'
import type { EqDisplayRange } from '@renderer/utils/eqViewport'
import {
  eqBandsInBox,
  groupEqBandPatches,
  selectEqBands
} from '@renderer/utils/parametricEqSelection'
import type { EqBandPatch, EqSelectionBox } from '@renderer/utils/parametricEqSelection'
import ParametricEqBandInspector from '@renderer/components/equalizer/ParametricEqBandInspector.vue'
import {
  PARAMETRIC_EQ_MAX_BANDS,
  PARAMETRIC_EQ_MIN_FREQUENCY,
  PARAMETRIC_EQ_MAX_FREQUENCY,
  adjustQByWheel,
  clampEqValue,
  displayBandGain,
  filterUsesGain,
  frequencyToPercent,
  gainToPercent,
  percentToFrequency,
  percentToGain
} from '@renderer/utils/parametricEqInteraction'
import { createEqWheelCommit, nudgeEqParameter } from '@renderer/utils/parametricEqKnob'
import {
  constrainEqInspector,
  placeEqInspector,
  placeEqTooltip
} from '@renderer/utils/parametricEqLayout'
import type { EqualizerBand, EqualizerFilterType } from '@renderer/types/settings'

type HeadphoneCurveKey = 'source' | 'target' | 'individual' | 'combined' | 'corrected'
const props = defineProps<{
  bands: EqualizerBand[]
  selectedIndex: number
  selectedIndices?: number[]
  clipboardBusy?: boolean
  clipboardMessage?: string
  clipboardFailed?: boolean
  displayRangeDb: EqDisplayRange
  filterTypes: { value: EqualizerFilterType; label: string; usesGain: boolean }[]
  responseView: 'dsp' | 'headphone'
  responsePath: string
  spectrumLevels: Float32Array | null
  spectrumVisible: boolean
  spectrumFrozen?: boolean
  measuredSourcePath: string
  targetResponsePath: string
  combinedFilterPath: string
  correctedAcousticPath: string
  bandResponsePaths: { index: number; path: string }[]
  showMeasuredSource: boolean
  showTargetResponse: boolean
  showIndividualFilters: boolean
  showCombinedFilter: boolean
  showCorrectedResponse: boolean
  eqEnabled: boolean
  meterPeakDb: number
  meterRmsDb: number
  status: string
  statusState: string
  error: string
}>()
const emit = defineEmits<{
  'update:displayRangeDb': [range: EqDisplayRange]
  select: [index: number, indices: number[]]
  copy: [all: boolean]
  paste: []
  add: [frequency: number, gain: number]
  'preview-bands': [changes: EqBandPatch[]]
  commit: []
  delete: [index: number]
  toggle: [index: number]
  filter: [index: number, filterType: EqualizerFilterType]
  'toggle-spectrum': []
  'update:spectrumFrozen': [frozen: boolean]
  'toggle-headphone-curve': [curve: HeadphoneCurveKey]
}>()
const workspaceRef = ref<HTMLElement | null>(null)
const surfaceRef = ref<HTMLElement | null>(null)
const inspectorHost = ref<HTMLElement | null>(null)
const inspectorRef = ref<InstanceType<typeof ParametricEqBandInspector> | null>(null)
const hoveredIndex = ref<number | null>(null)
const inspectorOpen = ref(true)
const contextMenuOpen = ref(false)
const contextMenuOnBand = ref(false)
const pointerPosition = shallowRef<{ x: number; y: number } | null>(null)
const drag = shallowRef<{
  index: number
  pointerId: number
  rect: DOMRect
  changed: boolean
  bands: EqualizerBand[]
  indices: number[]
  lastX: number
  lastY: number
  deltaX: number
  deltaY: number
} | null>(null)
const boxDrag = shallowRef<{
  pointerId: number
  rect: DOMRect
  startX: number
  startY: number
  box: EqSelectionBox
  original: number[]
  primary: number
  additive: boolean
  moved: boolean
} | null>(null)
let suppressBackgroundClick = false
let backgroundCreated = false
let selectionAnchor = props.selectedIndex
let inspectorGesture: { bands: EqualizerBand[]; indices: number[]; index: number } | null = null
const frozenInspector = shallowRef<{ left: number; top: number } | null>(null)
const manualInspector = shallowRef<{ left: number; top: number } | null>(null)
const inspectorDrag = shallowRef<{
  pointerId: number
  target: HTMLElement
  clientX: number
  clientY: number
  left: number
  top: number
  scale: number
  moved: boolean
  original: { left: number; top: number } | null
} | null>(null)
const geometry = shallowRef({
  width: 1000,
  height: 500,
  left: 24,
  top: 76,
  panelWidth: 460,
  panelHeight: 142
})
const compact = ref(false)
const spectrumGradientId = `eq-spectrum-${useId()}`
const spectrum = useEqSpectrum({
  document: () => workspaceRef.value?.ownerDocument ?? document,
  levels: () => props.spectrumLevels,
  visible: () => props.spectrumVisible && props.responseView === 'dsp',
  frozen: () => props.spectrumFrozen === true
})
const { peakHold, range: spectrumRange, speed: spectrumSpeed, resetPeaks } = spectrum
let resizeObserver: ResizeObserver | null = null
let wheelQ: { index: number; value: number } | null = null
const wheelCommit = createEqWheelCommit(() => {
  wheelQ = null
  emit('commit')
})
const bandColors = [
  'var(--te-eq-band-blue, #3b9edb)',
  'var(--te-eq-band-cyan, #20b9c7)',
  'var(--te-eq-band-green, #25ae81)',
  'var(--te-eq-band-yellow, #d4b32d)',
  'var(--te-eq-band-orange, #ec8545)',
  'var(--te-eq-band-magenta, #d55dda)',
  'var(--te-eq-band-violet, #9380e7)',
  'var(--te-eq-band-red, #e45b67)'
]
const frequencyTicks = [
  20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000, 20000
]
const majorFrequencyTicks = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
const labeledFrequencies = frequencyTicks.filter((frequency) => majorFrequencyTicks.has(frequency))
const gainTicks = computed(() => gainTicksForRange(props.displayRangeDb))
function gainY(gain: number): number {
  return gainToPercent(gain, props.displayRangeDb)
}
function changeDisplayRange(event: Event): void {
  finishInteraction()
  emit('update:displayRangeDb', Number((event.target as HTMLSelectElement).value) as EqDisplayRange)
}
const meterTicks = [0, -12, -24, -36, -48, -60]
const selectedBand = computed(() => props.bands[props.selectedIndex] ?? null)
const selectedIndices = computed(() =>
  (props.selectedIndices ?? (selectedBand.value ? [props.selectedIndex] : [])).filter(
    (index) => props.bands[index]
  )
)
const selectedSet = computed(() => new Set(selectedIndices.value))
const activeBandCount = computed(() => props.bands.filter((band) => band.enabled !== false).length)
const showInspector = computed(
  () =>
    inspectorOpen.value &&
    selectedBand.value &&
    props.responseView === 'dsp' &&
    !boxDrag.value?.moved
)
const tooltipIndex = computed(() => drag.value?.index ?? hoveredIndex.value)
const tooltipBand = computed(() =>
  tooltipIndex.value === null ? null : props.bands[tooltipIndex.value]
)
const responseLayers = computed(() =>
  props.bandResponsePaths.map((item) => ({
    ...item,
    fill: `${item.path} L100,50 L0,50 Z`,
    bypassed: props.responseView === 'dsp' && props.bands[item.index]?.enabled === false
  }))
)
const headphoneControls = computed<{ key: HeadphoneCurveKey; label: string; visible: boolean }[]>(
  () => [
    { key: 'source', label: '源频响', visible: props.showMeasuredSource },
    { key: 'target', label: '目标', visible: props.showTargetResponse },
    { key: 'individual', label: '单滤波', visible: props.showIndividualFilters },
    { key: 'combined', label: '合并滤波', visible: props.showCombinedFilter },
    { key: 'corrected', label: '滤波结果', visible: props.showCorrectedResponse }
  ]
)
function currentInspectorPlacement() {
  const bounds = geometry.value
  if (manualInspector.value)
    return constrainEqInspector(
      bounds,
      { width: bounds.panelWidth, height: bounds.panelHeight },
      manualInspector.value
    )
  const band = selectedBand.value
  return placeEqInspector(
    bounds,
    band
      ? {
          x: (frequencyToPercent(band.frequency) * bounds.width) / 100,
          y: (gainY(displayBandGain(band)) * bounds.height) / 100
        }
      : { x: 0, y: 0 },
    { width: bounds.panelWidth, height: bounds.panelHeight }
  )
}
const inspectorPosition = computed(() => {
  const placement = frozenInspector.value ?? currentInspectorPlacement()
  return {
    left: `${geometry.value.left}px`,
    top: `${geometry.value.top}px`,
    transform: `translate3d(${placement.left}px, ${placement.top}px, 0)`
  }
})
const tooltipStyle = computed(() => {
  const band = tooltipBand.value
  if (!band) return {}
  const bounds = geometry.value
  const placement = placeEqTooltip(bounds, {
    x: (frequencyToPercent(band.frequency) * bounds.width) / 100,
    y: (gainY(displayBandGain(band)) * bounds.height) / 100
  })
  return {
    left: `${placement.left}px`,
    top: `${placement.top}px`,
    width: `${placement.width}px`,
    '--band-color': bandColor(tooltipIndex.value ?? 0)
  }
})
function bandColor(index: number): string {
  return `color-mix(in srgb, ${bandColors[index % bandColors.length]} 88%, var(--eq-text))`
}
function formatFrequency(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`
}
function formatGain(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
}
function meterLevel(value: number): number {
  return clampEqValue((value + 60) / 60, 0, 1)
}
function measure(): void {
  const root = workspaceRef.value
  const surface = surfaceRef.value
  if (!root || !surface) return
  const rootRect = root.getBoundingClientRect()
  const rect = surface.getBoundingClientRect()
  const scale = rect.width / surface.clientWidth
  const panel = inspectorHost.value
  compact.value = root.clientWidth < 800
  geometry.value = {
    width: surface.clientWidth,
    height: surface.clientHeight,
    left: (rect.left - rootRect.left) / scale - root.clientLeft,
    top: (rect.top - rootRect.top) / scale - root.clientTop,
    panelWidth: panel?.offsetWidth || 460,
    panelHeight: panel?.offsetHeight || 142
  }
  if (compact.value) endInspectorDrag()
  if (!compact.value && manualInspector.value) manualInspector.value = currentInspectorPlacement()
}
function isInspectorControl(event: Event): boolean {
  return !!(event.target as Element).closest(
    'button, input, select, textarea, .eq-parameter-knob, .filter-select, [contenteditable="true"]'
  )
}
function beginInspectorDrag(event: PointerEvent): void {
  if (event.button !== 0 || compact.value || inspectorDrag.value || isInspectorControl(event))
    return
  event.preventDefault()
  event.stopPropagation()
  finishInteraction()
  const surface = surfaceRef.value!
  const panelRect = inspectorHost.value!.getBoundingClientRect()
  const rect = surface.getBoundingClientRect()
  const scale = rect.width / surface.clientWidth
  const position = {
    left: (panelRect.left - rect.left) / scale,
    top: (panelRect.top - rect.top) / scale
  }
  const target = event.currentTarget as HTMLElement
  inspectorDrag.value = {
    pointerId: event.pointerId,
    target,
    clientX: event.clientX,
    clientY: event.clientY,
    ...position,
    scale,
    moved: false,
    original: manualInspector.value
  }
  manualInspector.value = position
  target.focus({ preventScroll: true })
  target.setPointerCapture(event.pointerId)
}
function moveInspector(event: PointerEvent): void {
  const gesture = inspectorDrag.value
  if (!gesture || event.pointerId !== gesture.pointerId) return
  event.preventDefault()
  event.stopPropagation()
  if (event.clientX !== gesture.clientX || event.clientY !== gesture.clientY) gesture.moved = true
  const bounds = geometry.value
  manualInspector.value = constrainEqInspector(
    bounds,
    { width: bounds.panelWidth, height: bounds.panelHeight },
    {
      left: gesture.left + (event.clientX - gesture.clientX) / gesture.scale,
      top: gesture.top + (event.clientY - gesture.clientY) / gesture.scale
    }
  )
}
function endInspectorDrag(event?: PointerEvent): void {
  const gesture = inspectorDrag.value
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return
  if (event?.type === 'pointercancel' || !gesture.moved) manualInspector.value = gesture.original
  inspectorDrag.value = null
  if (gesture.target.hasPointerCapture(gesture.pointerId))
    gesture.target.releasePointerCapture(gesture.pointerId)
}
function resetInspectorPosition(event?: MouseEvent): void {
  if (event && (compact.value || isInspectorControl(event))) return
  event?.preventDefault()
  event?.stopPropagation()
  endInspectorDrag()
  manualInspector.value = null
  frozenInspector.value = null
}
function handleInspectorKey(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (inspectorDrag.value) {
      manualInspector.value = inspectorDrag.value.original
      endInspectorDrag()
    } else closeInspector()
    return
  }
  if (event.key === 'Home' || event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    resetInspectorPosition()
    return
  }
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
  }
  const direction = directions[event.key]
  if (!direction) return
  event.preventDefault()
  event.stopPropagation()
  finishInteraction()
  const position = currentInspectorPlacement(),
    step = event.shiftKey ? 1 : 10
  const bounds = geometry.value
  manualInspector.value = constrainEqInspector(
    bounds,
    { width: bounds.panelWidth, height: bounds.panelHeight },
    { left: position.left + direction[0] * step, top: position.top + direction[1] * step }
  )
}
function freezeInspector(active: boolean): void {
  if (!active) {
    frozenInspector.value = null
    return
  }
  if (!frozenInspector.value) frozenInspector.value = currentInspectorPlacement()
}
function eventCoordinates(event: MouseEvent, rect: DOMRect) {
  const x = clampEqValue(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
  const y = clampEqValue(((event.clientY - rect.top) / rect.height) * 100, 0, 100)
  return { x, y, frequency: percentToFrequency(x), gain: percentToGain(y, props.displayRangeDb) }
}
function finishInteraction(): void {
  endInspectorDrag()
  finishDrag()
  const box = boxDrag.value
  if (box) {
    suppressBackgroundClick = box.moved
    boxDrag.value = null
    if (surfaceRef.value?.hasPointerCapture(box.pointerId))
      surfaceRef.value.releasePointerCapture(box.pointerId)
  }
  wheelCommit.flush()
  inspectorRef.value?.finishInteraction()
}
function selectBand(index: number, event?: MouseEvent): number[] {
  finishInteraction()
  const selection = selectEqBands(props.bands, selectedIndices.value, index, selectionAnchor, {
    toggle: event?.ctrlKey === true || event?.metaKey === true,
    range: event?.shiftKey === true
  })
  if (!event?.shiftKey) selectionAnchor = selection.primary
  emit('select', selection.primary, selection.indices)
  inspectorOpen.value = true
  return selection.indices
}
function selectAllBands(): void {
  finishInteraction()
  const indices = props.bands.map((_band, index) => index)
  selectionAnchor = indices[0] ?? -1
  emit('select', selectionAnchor, indices)
  inspectorOpen.value = true
}
function openContextMenu(index: number | null): void {
  if (props.responseView !== 'dsp' || props.clipboardBusy) return
  finishInteraction()
  if (index !== null) selectBand(index)
  contextMenuOnBand.value = index !== null
  contextMenuOpen.value = true
}
function handleContextMenuKey(index: number | null, event: KeyboardEvent): boolean {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false
  event.preventDefault()
  event.stopPropagation()
  openContextMenu(index)
  return true
}
function resetSelectedGain(): void {
  finishInteraction()
  const changes = selectedIndices.value
    .filter((index) => filterUsesGain(props.bands[index].filterType))
    .map((index) => ({ index, patch: { gain: 0 } }))
  if (!changes.length) return
  emit('preview-bands', changes)
  emit('commit')
}
function addBand(event: MouseEvent): void {
  if (props.responseView !== 'dsp' || drag.value || props.bands.length >= PARAMETRIC_EQ_MAX_BANDS)
    return
  const surface = surfaceRef.value
  if (!surface) return
  finishInteraction()
  const point = eventCoordinates(event, surface.getBoundingClientRect())
  emit('add', point.frequency, point.gain)
  inspectorOpen.value = true
}
function clickBackground(event: MouseEvent): void {
  if (suppressBackgroundClick) {
    suppressBackgroundClick = false
    return
  }
  if (event.detail > 1 || props.responseView !== 'dsp') return
  backgroundCreated = false
  finishInteraction()
  if (selectedIndices.value.length && !event.ctrlKey && !event.metaKey) {
    emit('select', -1, [])
    inspectorOpen.value = false
  } else {
    addBand(event)
    backgroundCreated = true
  }
}
function doubleClickBackground(event: MouseEvent): void {
  if (!backgroundCreated) addBand(event)
}
function beginBox(event: PointerEvent): void {
  if (event.button !== 0 || props.responseView !== 'dsp' || !surfaceRef.value) return
  finishInteraction()
  suppressBackgroundClick = false
  const rect = surfaceRef.value.getBoundingClientRect()
  const point = eventCoordinates(event, rect)
  boxDrag.value = {
    pointerId: event.pointerId,
    rect,
    startX: point.x,
    startY: point.y,
    box: { left: point.x, right: point.x, top: point.y, bottom: point.y },
    original: [...selectedIndices.value],
    primary: props.selectedIndex,
    additive: event.ctrlKey || event.metaKey || event.shiftKey,
    moved: false
  }
  surfaceRef.value.focus({ preventScroll: true })
  surfaceRef.value.setPointerCapture(event.pointerId)
}
function endBox(event: PointerEvent): void {
  const current = boxDrag.value
  if (!current || current.pointerId !== event.pointerId) return
  suppressBackgroundClick = current.moved
  boxDrag.value = null
  if (event.type === 'pointercancel') emit('select', current.primary, current.original)
  else if (current.moved) selectionAnchor = props.selectedIndex
  if (surfaceRef.value?.hasPointerCapture(event.pointerId))
    surfaceRef.value.releasePointerCapture(event.pointerId)
}
function beginDrag(index: number, event: PointerEvent): void {
  if (props.responseView !== 'dsp' || event.button !== 0 || drag.value || !surfaceRef.value) return
  const indices = selectBand(index, event)
  if (!indices.includes(index)) return
  const element = event.currentTarget as HTMLElement
  element.focus({ preventScroll: true })
  hoveredIndex.value = index
  const rect = surfaceRef.value.getBoundingClientRect()
  const point = eventCoordinates(event, rect)
  drag.value = {
    index,
    pointerId: event.pointerId,
    rect,
    changed: false,
    bands: props.bands.map((band) => ({ ...band })),
    indices,
    lastX: point.x,
    lastY: point.y,
    deltaX: 0,
    deltaY: 0
  }
  element.setPointerCapture(event.pointerId)
  freezeInspector(true)
}
function updatePointer(event: PointerEvent): void {
  if (!surfaceRef.value) return
  const selection = boxDrag.value
  if (selection?.pointerId === event.pointerId) {
    const point = eventCoordinates(event, selection.rect)
    const moved =
      Math.hypot(
        ((point.x - selection.startX) * selection.rect.width) / 100,
        ((point.y - selection.startY) * selection.rect.height) / 100
      ) >= 3
    if (!selection.moved && !moved) return
    const box = {
      left: Math.min(selection.startX, point.x),
      right: Math.max(selection.startX, point.x),
      top: Math.min(selection.startY, point.y),
      bottom: Math.max(selection.startY, point.y)
    }
    boxDrag.value = { ...selection, box, moved: true }
    const found = eqBandsInBox(props.bands, box, props.displayRangeDb)
    const indices = selection.additive ? [...new Set([...selection.original, ...found])] : found
    emit(
      'select',
      indices.includes(selection.primary) ? selection.primary : (indices.at(-1) ?? -1),
      indices
    )
    return
  }
  const current = drag.value
  const point = eventCoordinates(event, current?.rect ?? surfaceRef.value.getBoundingClientRect())
  pointerPosition.value = { x: point.x, y: point.y }
  if (!current || current.pointerId !== event.pointerId) return
  if (point.x === current.lastX && point.y === current.lastY) return
  const band = current.bands[current.index]
  const fine = event.shiftKey ? 0.1 : 1
  current.deltaX += (point.x - current.lastX) * fine
  current.deltaY += (point.y - current.lastY) * fine
  current.lastX = point.x
  current.lastY = point.y
  current.changed = true
  emit(
    'preview-bands',
    groupEqBandPatches(current.bands, current.indices, current.index, {
      frequency:
        band.frequency *
        (PARAMETRIC_EQ_MAX_FREQUENCY / PARAMETRIC_EQ_MIN_FREQUENCY) ** (current.deltaX / 100),
      ...(filterUsesGain(band.filterType)
        ? { gain: band.gain - (current.deltaY * props.displayRangeDb) / 50 }
        : {})
    })
  )
}
function endDrag(event: PointerEvent): void {
  const current = drag.value
  if (!current || current.pointerId !== event.pointerId) return
  finishDrag()
}
function finishDrag(): void {
  const current = drag.value
  if (!current) return
  drag.value = null
  const element =
    surfaceRef.value?.querySelectorAll<HTMLElement>('.parametric-band-handle')[current.index]
  if (element?.hasPointerCapture(current.pointerId))
    element.releasePointerCapture(current.pointerId)
  freezeInspector(false)
  if (current.changed) emit('commit')
}
function adjustQ(index: number, event: WheelEvent): void {
  const band = props.bands[index]
  if (!band || event.deltaY === 0 || drag.value) return
  if (index !== props.selectedIndex) selectBand(index)
  inspectorOpen.value = true
  const q = adjustQByWheel(
    wheelQ?.index === index ? wheelQ.value : band.q,
    event.deltaY,
    event.shiftKey
  )
  wheelQ = { index, value: q }
  const changes = previewBand(index, { q })
  wheelQ.value = changes.find((change) => change.index === index)?.patch.q ?? q
  wheelCommit.schedule()
}
function previewBand(index: number, patch: Partial<EqualizerBand>): EqBandPatch[] {
  const gesture = inspectorGesture
  const indices = selectedSet.value.has(index) ? selectedIndices.value : [index]
  const changes = groupEqBandPatches(
    gesture?.bands ?? props.bands,
    gesture?.indices ?? indices,
    gesture?.index ?? index,
    patch
  )
  emit('preview-bands', changes)
  return changes
}
function inspectorInteraction(active: boolean): void {
  if (active && !inspectorGesture)
    inspectorGesture = {
      bands: props.bands.map((band) => ({ ...band })),
      indices: [...selectedIndices.value],
      index: props.selectedIndex
    }
  if (!active) inspectorGesture = null
  freezeInspector(active)
}
function resetBandGain(index: number, event: MouseEvent): void {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  const band = props.bands[index]
  if (!band || !filterUsesGain(band.filterType)) return
  const indices = selectBand(index)
  emit(
    'preview-bands',
    indices
      .filter((index) => filterUsesGain(props.bands[index].filterType))
      .map((index) => ({ index, patch: { gain: 0 } }))
  )
  emit('commit')
}
function handleBandKeydown(index: number, event: KeyboardEvent): void {
  if (handleContextMenuKey(index, event)) return
  const band = props.bands[index]
  if (!band) return
  if (event.key === 'Escape') {
    finishInteraction()
    emit('select', -1, [])
    inspectorOpen.value = false
    event.stopPropagation()
    return
  }
  const field = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'frequency' : 'gain'
  const direction =
    event.key === 'ArrowRight' || event.key === 'ArrowUp'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? -1
        : 0
  if (!direction || (field === 'gain' && !filterUsesGain(band.filterType))) return
  event.preventDefault()
  event.stopPropagation()
  selectBand(index)
  previewBand(index, {
    [field]: nudgeEqParameter(field, band[field], direction, event.shiftKey)
  })
  emit('commit')
}
function closeInspector(): void {
  endInspectorDrag()
  inspectorOpen.value = false
  surfaceRef.value
    ?.querySelector<HTMLElement>('.parametric-band-handle.selected')
    ?.focus({ preventScroll: true })
}
onMounted(() => {
  resizeObserver = new ResizeObserver(measure)
  if (workspaceRef.value) resizeObserver.observe(workspaceRef.value)
  if (surfaceRef.value) resizeObserver.observe(surfaceRef.value)
  if (inspectorHost.value) resizeObserver.observe(inspectorHost.value)
  measure()
})
watch(inspectorHost, (panel, previous) => {
  if (previous) resizeObserver?.unobserve(previous)
  if (panel) resizeObserver?.observe(panel)
  void nextTick(measure)
})
watch(
  () => props.responseView,
  () => {
    finishInteraction()
    hoveredIndex.value = null
    contextMenuOpen.value = false
  }
)
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  finishInteraction()
})
defineExpose({ finishInteraction })
</script>

<template>
  <section
    ref="workspaceRef"
    class="parametric-workspace"
    data-te-material="content"
    :class="{ compact }"
    aria-label="参数均衡器"
    data-te-parametric-eq-workspace
  >
    <header class="parametric-stage-header">
      <h3 class="stage-title">参数均衡器</h3>
      <div class="stage-commands"><slot name="commands"></slot></div>
    </header>
    <div class="parametric-graph-frame" :class="{ bypassed: !eqEnabled }">
      <div class="graph-heading">
        <span>{{ activeBandCount }} / {{ PARAMETRIC_EQ_MAX_BANDS }} 频段</span
        ><span v-if="!eqEnabled" class="bypass-label">EQ 已旁路</span>
        <div v-if="responseView === 'dsp'" class="band-clipboard-actions">
          <button
            type="button"
            title="复制所选频段（Ctrl/⌘+C）"
            :disabled="clipboardBusy || !selectedIndices.length"
            @click="emit('copy', false)"
          >
            复制
          </button>
          <button
            type="button"
            title="粘贴频段（Ctrl/⌘+V）"
            :disabled="clipboardBusy || bands.length >= PARAMETRIC_EQ_MAX_BANDS"
            @click="emit('paste')"
          >
            粘贴
          </button>
        </div>
        <label class="graph-range"
          ><select
            aria-label="增益显示范围"
            :value="displayRangeDb"
            :disabled="!!drag"
            @change="changeDisplayRange"
          >
            <option v-for="range in EQ_DISPLAY_RANGES" :key="range" :value="range">
              ±{{ range }} dB
            </option>
          </select></label
        >
      </div>
      <div
        ref="surfaceRef"
        class="parametric-graph-surface"
        :class="{ dragging: drag, selecting: boxDrag?.moved }"
        role="application"
        aria-label="参数均衡器频响编辑区"
        tabindex="0"
        @pointerdown.self="beginBox"
        @pointermove="updatePointer"
        @pointerup="endBox"
        @pointercancel="endBox"
        @lostpointercapture="endBox"
        @pointerleave="pointerPosition = null"
        @click.self="clickBackground"
        @dblclick.self.prevent="doubleClickBackground"
        @contextmenu.self.prevent="openContextMenu(null)"
        @keydown.self="handleContextMenuKey(null, $event)"
      >
        <div
          v-for="frequency in frequencyTicks"
          :key="`f-${frequency}`"
          class="frequency-grid-line"
          :class="{ major: majorFrequencyTicks.has(frequency) }"
          :style="{ left: frequencyToPercent(frequency) + '%' }"
        ></div>
        <div
          v-for="gain in gainTicks"
          :key="`g-${gain}`"
          class="gain-grid-line"
          :class="{ zero: gain === 0 }"
          :style="{ top: gainY(gain) + '%' }"
        ></div>
        <div class="gain-labels" aria-hidden="true">
          <span
            v-for="gain in gainTicks"
            :key="gain"
            :class="{ zero: gain === 0 }"
            :style="{ top: gainY(gain) + '%' }"
            >{{ gain > 0 ? '+' + gain : gain }}</span
          >
        </div>
        <div class="frequency-labels" aria-hidden="true">
          <span
            v-for="frequency in labeledFrequencies"
            :key="frequency"
            :style="{ left: frequencyToPercent(frequency) + '%' }"
            >{{ frequency >= 1000 ? frequency / 1000 + 'k' : frequency }}</span
          >
        </div>
        <div
          v-if="responseView === 'headphone'"
          class="headphone-curve-controls"
          aria-label="耳机频响曲线显示控制"
        >
          <button
            v-for="control in headphoneControls"
            :key="control.key"
            type="button"
            class="curve-control"
            :class="[control.key, { muted: !control.visible }]"
            :aria-pressed="control.visible"
            @click.stop="emit('toggle-headphone-curve', control.key)"
          >
            <i></i>{{ control.label }}
          </button>
        </div>
        <div
          v-if="responseView === 'dsp' && spectrumVisible"
          class="spectrum-scale"
          aria-label="频谱 dB 刻度"
        >
          <span style="top: 12%">+10 dB</span>
          <span style="top: 55%">{{ 10 - spectrumRange / 2 }} dB</span>
          <span style="top: 98%">{{ 10 - spectrumRange }} dB</span>
        </div>
        <svg
          class="parametric-plot"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient :id="spectrumGradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--eq-spectrum)" stop-opacity="0.10" />
              <stop offset="100%" stop-color="var(--eq-spectrum)" stop-opacity="0.01" />
            </linearGradient>
          </defs>
          <path
            v-show="responseView === 'dsp' && spectrumVisible"
            :ref="spectrum.fillRef"
            class="live-spectrum-fill"
            :fill="`url(#${spectrumGradientId})`"
          />
          <path
            v-show="responseView === 'dsp' && spectrumVisible"
            :ref="spectrum.lineRef"
            class="live-spectrum-line"
            vector-effect="non-scaling-stroke"
          />
          <path
            v-show="responseView === 'dsp' && spectrumVisible && peakHold"
            :ref="spectrum.peakRef"
            class="spectrum-peak-line"
            vector-effect="non-scaling-stroke"
          />
          <template v-if="responseView === 'dsp'">
            <template v-for="item in responseLayers" :key="item.index">
              <path
                v-if="!item.bypassed"
                class="individual-band-fill"
                :class="{ selected: selectedSet.has(item.index) }"
                :style="{ '--band-color': bandColor(item.index) }"
                :d="item.fill"
              />
              <path
                class="individual-band-line"
                :class="{ selected: selectedSet.has(item.index), bypassed: item.bypassed }"
                :style="{ '--band-color': bandColor(item.index) }"
                :d="item.path"
                vector-effect="non-scaling-stroke"
              />
            </template>
            <path
              class="composite-response-line"
              :d="responsePath"
              vector-effect="non-scaling-stroke"
            />
          </template>
          <template v-else>
            <path
              v-if="showMeasuredSource && measuredSourcePath"
              class="measured-source-line"
              :d="measuredSourcePath"
              vector-effect="non-scaling-stroke"
            />
            <path
              v-if="showTargetResponse && targetResponsePath"
              class="target-response-line"
              :d="targetResponsePath"
              vector-effect="non-scaling-stroke"
            />
            <template v-if="showIndividualFilters">
              <path
                v-for="item in bandResponsePaths"
                :key="item.index"
                class="individual-band-line headphone-filter"
                :style="{ '--band-color': bandColor(item.index) }"
                :d="item.path"
                vector-effect="non-scaling-stroke"
              />
            </template>
            <path
              v-if="showCombinedFilter && combinedFilterPath"
              class="combined-filter-line"
              :d="combinedFilterPath"
              vector-effect="non-scaling-stroke"
            />
            <path
              v-if="showCorrectedResponse && correctedAcousticPath"
              class="corrected-acoustic-line"
              :d="correctedAcousticPath"
              vector-effect="non-scaling-stroke"
            />
          </template>
        </svg>
        <div
          v-if="boxDrag?.moved"
          class="band-selection-box"
          :style="{
            left: boxDrag.box.left + '%',
            top: boxDrag.box.top + '%',
            width: boxDrag.box.right - boxDrag.box.left + '%',
            height: boxDrag.box.bottom - boxDrag.box.top + '%'
          }"
          aria-hidden="true"
        ></div>
        <template v-if="responseView === 'dsp'">
          <button
            v-for="(band, index) in bands"
            :key="index"
            type="button"
            class="parametric-band-handle"
            :class="{
              selected: selectedSet.has(index),
              hovered: hoveredIndex === index,
              bypassed: band.enabled === false,
              dragging: drag?.indices.includes(index),
              'outside-range': Math.abs(displayBandGain(band)) > displayRangeDb
            }"
            :style="{
              left: frequencyToPercent(band.frequency) + '%',
              top: gainY(displayBandGain(band)) + '%',
              '--band-color': bandColor(index)
            }"
            :aria-label="`频段 ${index + 1}，${formatFrequency(band.frequency)}，${formatGain(displayBandGain(band))}，Q ${band.q.toFixed(2)}`"
            :aria-pressed="selectedSet.has(index)"
            @click.stop="$event.detail === 0 && selectBand(index, $event)"
            @pointerenter="hoveredIndex = index"
            @pointerleave="hoveredIndex = null"
            @pointerdown.prevent.stop="beginDrag(index, $event)"
            @pointermove.prevent.stop="updatePointer"
            @pointerup.prevent.stop="endDrag"
            @pointercancel.stop="endDrag"
            @lostpointercapture="endDrag"
            @wheel.prevent.stop="adjustQ(index, $event)"
            @dblclick.prevent.stop="resetBandGain(index, $event)"
            @keydown="handleBandKeydown(index, $event)"
            @contextmenu.prevent.stop="openContextMenu(index)"
          >
            <span class="handle-index">{{
              Math.abs(displayBandGain(band)) > displayRangeDb
                ? displayBandGain(band) > 0
                  ? '↑'
                  : '↓'
                : index + 1
            }}</span>
          </button>
          <div v-if="bands.length === 0" class="graph-empty">
            <strong>从一个频段开始</strong><span>单击画布添加 · 拖动节点调节频率与增益</span>
          </div>
        </template>
        <div
          v-if="tooltipBand && tooltipIndex !== null && responseView === 'dsp'"
          class="band-tooltip"
          :style="tooltipStyle"
        >
          <strong
            ><i></i
            >{{ filterTypes.find((filter) => filter.value === tooltipBand?.filterType)?.label
            }}<small>频段 {{ tooltipIndex + 1 }}</small></strong
          >
          <div>
            <span>{{ formatFrequency(tooltipBand.frequency) }}</span
            ><span>{{ formatGain(displayBandGain(tooltipBand)) }}</span
            ><span>Q {{ tooltipBand.q.toFixed(2) }}</span>
          </div>
        </div>
        <div
          v-if="pointerPosition && responseView === 'dsp' && !drag && hoveredIndex === null"
          class="graph-crosshair"
          :style="{ left: pointerPosition.x + '%', top: pointerPosition.y + '%' }"
          aria-hidden="true"
        ></div>
      </div>
      <aside class="output-meter" aria-label="输出峰值与均方根电平">
        <div class="meter-scale" aria-hidden="true">
          <span
            v-for="tick in meterTicks"
            :key="tick"
            :style="{ top: (1 - meterLevel(tick)) * 100 + '%' }"
            >{{ tick }}</span
          >
        </div>
        <div
          class="meter-channel"
          aria-label="Peak 峰值"
          :title="`Peak ${formatGain(meterPeakDb)}`"
        >
          <i
            class="meter-peak"
            :class="{ clipping: meterPeakDb >= -1 }"
            :style="{ transform: `scaleY(${meterLevel(meterPeakDb)})` }"
          ></i>
        </div>
        <div class="meter-channel" aria-label="RMS 均方根" :title="`RMS ${formatGain(meterRmsDb)}`">
          <i class="meter-rms" :style="{ transform: `scaleY(${meterLevel(meterRmsDb)})` }"></i>
        </div>
        <div class="meter-labels" aria-hidden="true"><span>Peak</span><span>RMS</span></div>
      </aside>
      <div class="graph-hint">
        <template v-if="responseView === 'dsp'"
          >拖动节点 · Ctrl/⌘ 多选 · Shift 连选 · 拖空白框选<span
            v-if="bands.length >= PARAMETRIC_EQ_MAX_BANDS"
            >已达到 32 个频段上限</span
          ><span v-else>{{
            selectedIndices.length
              ? `已选 ${selectedIndices.length} · 双击空白添加`
              : '单击空白添加频段'
          }}</span></template
        ><template v-else
          >R(f) = M(f) + H(f)<span>数字前级不计入声学预计 · 预计值，非实测</span></template
        >
      </div>
    </div>
    <div
      v-if="showInspector && selectedBand"
      ref="inspectorHost"
      class="floating-band-inspector"
      :class="{ moving: inspectorDrag, movable: !compact }"
      :style="{ ...inspectorPosition, '--band-color': bandColor(selectedIndex) }"
      :tabindex="compact ? undefined : 0"
      role="group"
      aria-label="频段面板"
      :aria-description="compact ? undefined : '拖动空白区域移动，双击复位，方向键微调'"
      @pointerdown="beginInspectorDrag"
      @pointermove="moveInspector"
      @pointerup="endInspectorDrag"
      @pointercancel="endInspectorDrag"
      @lostpointercapture="endInspectorDrag"
      @dblclick="resetInspectorPosition"
      @keydown.self="handleInspectorKey"
    >
      <ParametricEqBandInspector
        ref="inspectorRef"
        :key="selectedIndex"
        :band="selectedBand"
        :index="selectedIndex"
        :selection-count="selectedIndices.length"
        :selection-enabled="selectedIndices.some((index) => bands[index].enabled !== false)"
        :filter-types="filterTypes"
        :movable="!compact"
        @preview="previewBand"
        @commit="emit('commit')"
        @toggle="emit('toggle', $event)"
        @delete="emit('delete', $event)"
        @filter="(index, type) => emit('filter', index, type)"
        @close="closeInspector"
        @interaction="inspectorInteraction"
      />
    </div>
    <footer class="analyzer-footer">
      <button
        v-if="responseView === 'dsp'"
        type="button"
        class="spectrum-toggle"
        :class="{ active: spectrumVisible }"
        :aria-pressed="spectrumVisible"
        @click="emit('toggle-spectrum')"
      >
        <i class="pi pi-chart-line"></i><span>分析器</span
        ><small>{{ spectrumVisible ? '开' : '关' }}</small>
      </button>
      <EqAnalyzerControls
        v-if="responseView === 'dsp' && spectrumVisible"
        :frozen="spectrumFrozen === true"
        v-model:peak-hold="peakHold"
        v-model:range="spectrumRange"
        v-model:speed="spectrumSpeed"
        @update:frozen="emit('update:spectrumFrozen', $event)"
        @reset-peaks="resetPeaks"
      />
      <slot name="footer"></slot>
      <div class="stage-status" :class="`is-${statusState}`" :title="error || status" role="status">
        <span class="status-dot"></span><span>{{ status }}</span>
      </div>
    </footer>
    <div v-if="error" class="eq-apply-error" role="alert">{{ error }}</div>
    <div
      v-if="clipboardMessage"
      class="clipboard-feedback"
      :class="{ failed: clipboardFailed }"
      :role="clipboardFailed ? 'alert' : 'status'"
    >
      {{ clipboardMessage }}
    </div>
    <NativeContextMenu v-if="contextMenuOpen" @close="contextMenuOpen = false">
      <button
        v-if="contextMenuOnBand"
        type="button"
        :disabled="clipboardBusy || !selectedIndices.length"
        @click="emit('copy', false)"
      >
        复制所选频段
      </button>
      <button type="button" :disabled="clipboardBusy || !bands.length" @click="emit('copy', true)">
        复制全部频段
      </button>
      <button
        type="button"
        :disabled="clipboardBusy || bands.length >= PARAMETRIC_EQ_MAX_BANDS"
        @click="emit('paste')"
      >
        粘贴频段
      </button>
      <button type="button" :disabled="!bands.length" @click="selectAllBands">全选频段</button>
      <template v-if="contextMenuOnBand">
        <div class="menu-item">
          滤波类型
          <div class="submenu">
            <button
              v-for="filter in filterTypes"
              :key="filter.value"
              type="button"
              @click="emit('filter', selectedIndex, filter.value)"
            >
              {{ filter.label }}
            </button>
          </div>
        </div>
        <button
          type="button"
          :disabled="!selectedIndices.some((index) => filterUsesGain(bands[index].filterType))"
          @click="resetSelectedGain"
        >
          重置所选增益
        </button>
        <button type="button" @click="emit('toggle', selectedIndex)">
          {{
            selectedIndices.some((index) => bands[index].enabled !== false)
              ? '旁路所选频段'
              : '启用所选频段'
          }}
        </button>
        <button type="button" @click="emit('delete', selectedIndex)">删除所选频段</button>
      </template>
    </NativeContextMenu>
  </section>
</template>

<style scoped>
.parametric-workspace {
  --eq-surface: var(--te-app-bg);
  --eq-panel: var(--te-settings-search-bg);
  --eq-panel-raised: var(--te-settings-control-bg);
  --eq-text: var(--te-settings-text);
  --eq-text-muted: var(--te-settings-text-muted);
  --eq-text-subtle: var(--te-settings-text-muted);
  --eq-border: var(--te-settings-control-border);
  --eq-border-soft: var(--te-settings-control-border);
  --eq-grid: color-mix(in srgb, var(--eq-text) 5%, transparent);
  --eq-grid-major: color-mix(in srgb, var(--eq-text) 9%, transparent);
  --eq-zero-axis: color-mix(in srgb, var(--eq-text) 24%, transparent);
  --eq-response: #927000;
  --eq-spectrum: #636572;
  --eq-control-bg: var(--te-control-bg-hover);
  --eq-shadow: transparent;
  --eq-highlight: #ffffff;
  --eq-knob-track: var(--te-settings-control-border);
  --eq-knob-edge: var(--te-settings-control-border);
  --eq-meter: #419b66;
  --eq-source: var(--te-info-500);
  --eq-target: var(--eq-text-subtle);
  --eq-filter-combined: var(--eq-response);
  --eq-corrected: var(--te-success-500);
  --eq-color-scheme: light;
  --eq-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border: 0;
  border-radius: 0;
  color: var(--eq-text);
  background: var(--te-material-background, transparent);
  box-shadow: none;
  container: eq-workspace / inline-size;
  isolation: isolate;
}
.parametric-stage-header {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 54px;
  flex-shrink: 0;
  padding: 0;
  border-radius: 0;
  border-bottom: 1px solid var(--eq-border-soft);
  background: transparent;
  z-index: 40;
}
.stage-title {
  margin: 0;
  flex-shrink: 0;
  color: var(--eq-text);
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-strong);
}
.stage-commands {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 12px;
}
.parametric-graph-frame {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 300px;
  padding: 38px 94px 60px 28px;
  overflow: hidden;
  background: transparent;
}
.graph-heading {
  position: absolute;
  inset: 12px 68px auto 22px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--eq-text-subtle);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.graph-range {
  margin-left: auto;
  color: var(--eq-response);
  font-family: var(--eq-mono);
}
.band-clipboard-actions {
  display: flex;
  gap: 4px;
  pointer-events: auto;
}
.band-clipboard-actions button {
  padding: 3px 8px;
  color: var(--eq-text-muted);
  background: var(--eq-panel);
  border: 1px solid var(--eq-border-soft);
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.band-clipboard-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.band-clipboard-actions button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.graph-range select {
  pointer-events: auto;
  background: var(--eq-panel);
  color: var(--eq-response);
  border: 1px solid var(--eq-border-soft);
  border-radius: 4px;
  padding: 3px 5px;
  font: inherit;
  cursor: pointer;
}
.graph-range select:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.parametric-band-handle.outside-range {
  border-style: dashed;
}
.bypass-label {
  padding: 2px 6px;
  border: 1px solid var(--eq-border-soft);
  border-radius: 3px;
}
.band-selection-box {
  position: absolute;
  border: 1px solid var(--eq-response);
  background: color-mix(in srgb, var(--eq-response) 12%, transparent);
  box-sizing: border-box;
  pointer-events: none;
  z-index: 12;
}
.parametric-graph-surface:focus-visible {
  outline: 1px solid var(--te-control-focus-color);
  outline-offset: 4px;
}
.parametric-graph-surface.selecting {
  cursor: crosshair;
}
.parametric-graph-surface {
  position: relative;
  flex: 1;
  min-width: 0;
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}
.frequency-grid-line,
.gain-grid-line {
  position: absolute;
  pointer-events: none;
  background: var(--eq-grid);
}
.frequency-grid-line {
  top: 0;
  bottom: 0;
  width: 1px;
}
.frequency-grid-line.major {
  background: var(--eq-grid-major);
}
.gain-grid-line {
  left: 0;
  right: 0;
  height: 1px;
}
.gain-grid-line.zero {
  background: var(--eq-zero-axis);
}
.gain-labels span,
.frequency-labels span {
  position: absolute;
  font-family: var(--eq-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--eq-text-subtle);
  pointer-events: none;
}
.gain-labels span {
  left: calc(100% + 12px);
  transform: translateY(-50%);
}
.gain-labels span.zero {
  color: var(--eq-response);
}
.frequency-labels span {
  top: calc(100% + 14px);
  transform: translateX(-50%);
}
.frequency-labels span:first-child {
  transform: none;
}
.frequency-labels span:last-child {
  transform: translateX(-100%);
}
.parametric-plot {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: hidden;
}
.parametric-plot path {
  stroke-linecap: round;
  stroke-linejoin: round;
}
.spectrum-scale {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}
.spectrum-scale span {
  position: absolute;
  left: 4px;
  transform: translateY(-50%);
  color: var(--eq-text-subtle);
  font: 9px var(--eq-mono);
}
.spectrum-peak-line {
  fill: none;
  stroke: var(--eq-spectrum);
  stroke-width: 1;
  stroke-dasharray: 4 3;
  opacity: 0.65;
}
.live-spectrum-line {
  fill: none;
  stroke: var(--eq-spectrum);
  stroke-width: 1px;
  opacity: 0.78;
}
.individual-band-fill {
  fill: var(--band-color);
  opacity: 0.16;
}
.individual-band-fill.selected {
  opacity: 0.31;
}
.individual-band-line {
  fill: none;
  stroke: var(--band-color);
  stroke-width: 1px;
  opacity: 0.63;
}
.individual-band-line.selected {
  stroke-width: 1.4px;
  opacity: 1;
}
.individual-band-line.bypassed {
  opacity: 0.28;
  stroke-dasharray: 4 5;
}
.composite-response-line {
  fill: none;
  stroke: var(--eq-response);
  stroke-width: 2px;
}
.bypassed .composite-response-line,
.bypassed .individual-band-line {
  opacity: 0.4;
}
.bypassed .individual-band-fill {
  opacity: 0.075;
}
.measured-source-line {
  fill: none;
  stroke: var(--eq-source);
  stroke-width: 1.4px;
}
.target-response-line {
  fill: none;
  stroke: var(--eq-target);
  stroke-width: 1px;
  stroke-dasharray: 5 4;
}
.combined-filter-line {
  fill: none;
  stroke: var(--eq-filter-combined);
  stroke-width: 1.8px;
}
.corrected-acoustic-line {
  fill: none;
  stroke: var(--eq-corrected);
  stroke-width: 1.8px;
}
.headphone-filter {
  opacity: 0.6;
}
.parametric-band-handle {
  position: absolute;
  z-index: 5;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  transition: none;
  touch-action: none;
  cursor: grab;
}
.parametric-band-handle::before {
  content: '';
  position: absolute;
  inset: 8px;
  border: 1.5px solid var(--band-color);
  border-radius: 50%;
  background: var(--band-color);
  box-shadow: none;
}
.parametric-band-handle.selected::before,
.parametric-band-handle.hovered::before {
  inset: 6px;
  outline: 1px solid var(--band-color);
  outline-offset: 3px;
}
.parametric-band-handle.selected::before {
  background: color-mix(in srgb, var(--band-color) 62%, var(--eq-surface));
}
.parametric-band-handle.bypassed::before {
  border-style: dashed;
  background: var(--eq-surface);
  opacity: 0.65;
}
.handle-index {
  position: relative;
  color: var(--eq-highlight);
  font-family: var(--eq-mono);
  font-size: 8px;
  opacity: 0;
}
.selected .handle-index,
.hovered .handle-index {
  opacity: 1;
}
.parametric-band-handle.dragging {
  cursor: grabbing;
}
.parametric-band-handle:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.band-tooltip {
  position: absolute;
  z-index: 35;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid var(--eq-border);
  border-radius: 8px;
  background: var(--eq-panel-raised);
  box-shadow: none;
  pointer-events: none;
}
.band-tooltip strong {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 550;
}
.band-tooltip strong i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--band-color);
}
.band-tooltip small {
  margin-left: auto;
  color: var(--eq-text-subtle);
  font-size: 9px;
  font-weight: 400;
}
.band-tooltip div {
  display: flex;
  justify-content: space-between;
  margin-top: 7px;
  gap: 8px;
  font-family: var(--eq-mono);
  color: var(--eq-text-muted);
  font-size: 10px;
}
.graph-crosshair {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 1px solid var(--eq-text-subtle);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.graph-empty {
  position: absolute;
  top: 28%;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  pointer-events: none;
}
.graph-empty strong {
  font-weight: 450;
  font-size: 17px;
  color: var(--eq-text-muted);
}
.graph-empty span {
  font-size: 11px;
  color: var(--eq-text-subtle);
}
.floating-band-inspector {
  position: absolute;
  z-index: 30;
  width: 460px;
  max-width: calc(100% - 24px);
}
.floating-band-inspector.moving {
  will-change: transform;
}
.floating-band-inspector.moving :deep(.band-inspector) {
  cursor: grabbing;
}
.floating-band-inspector:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
  border-radius: 8px;
}
.output-meter {
  position: absolute;
  top: 38px;
  right: 12px;
  bottom: 60px;
  width: 37px;
  display: grid;
  grid-template-columns: 1fr 5px 5px;
  gap: 4px;
}
.meter-scale {
  position: relative;
  font-family: var(--eq-mono);
  font-size: 8px;
  color: var(--eq-text-subtle);
}
.meter-scale span {
  position: absolute;
  right: 2px;
  transform: translateY(-50%);
}
.meter-channel {
  position: relative;
  overflow: hidden;
  background: var(--eq-control-bg);
  border-radius: 1px;
}
.meter-channel i {
  position: absolute;
  inset: 0;
  transform-origin: bottom;
}
.meter-peak {
  background: var(--eq-meter);
}
.meter-peak.clipping {
  background: var(--eq-response);
}
.meter-rms {
  background: color-mix(in srgb, var(--eq-meter) 72%, var(--eq-surface));
}
.meter-labels {
  position: absolute;
  top: calc(100% + 14px);
  right: 0;
  display: flex;
  gap: 4px;
  color: var(--eq-text-subtle);
  font-family: var(--eq-mono);
  font-size: 8px;
}
.graph-hint {
  position: absolute;
  bottom: 12px;
  left: 24px;
  right: 24px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 9px;
  color: var(--eq-text-subtle);
  pointer-events: none;
}
.headphone-curve-controls {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 15;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.curve-control {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid var(--eq-border-soft);
  border-radius: 5px;
  background: var(--eq-panel-raised);
  color: var(--eq-text-muted);
  font-size: 10px;
  cursor: pointer;
}
.curve-control i {
  width: 10px;
  border-top: 2px solid var(--curve-color);
}
.curve-control.source {
  --curve-color: var(--eq-source);
}
.curve-control.target {
  --curve-color: var(--eq-target);
}
.curve-control.individual {
  --curve-color: var(--te-primary-400);
}
.curve-control.combined {
  --curve-color: var(--eq-filter-combined);
}
.curve-control.corrected {
  --curve-color: var(--eq-corrected);
}
.curve-control.muted {
  opacity: 0.45;
}
.analyzer-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  min-height: 42px;
  flex-shrink: 0;
  padding: 0 14px;
  border-top: 1px solid var(--eq-border-soft);
  border-radius: 0;
  background: transparent;
  z-index: 40;
}
.spectrum-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--eq-text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.spectrum-toggle small {
  color: var(--eq-text-subtle);
  font-size: 9px;
}
.spectrum-toggle.active i,
.spectrum-toggle.active small {
  color: var(--eq-response);
}
.stage-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--eq-text-subtle);
  font-size: 10px;
  white-space: nowrap;
}
.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--eq-meter);
}
.is-applying .status-dot,
.is-editing .status-dot {
  background: var(--eq-response);
}
.is-failed .status-dot {
  background: var(--te-danger-soft-fg);
}
.eq-apply-error {
  padding: 8px 14px;
  color: var(--te-danger-soft-fg);
  font-size: 11px;
}
.clipboard-feedback {
  padding: 6px 14px;
  color: var(--eq-text-muted);
  font-size: 11px;
}
.clipboard-feedback.failed {
  color: var(--te-danger-soft-fg);
}
.spectrum-toggle:focus-visible,
.curve-control:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
:global(html[data-theme='dark'] .parametric-workspace) {
  --eq-grid: color-mix(in srgb, var(--eq-text) 3%, transparent);
  --eq-grid-major: color-mix(in srgb, var(--eq-text) 6%, transparent);
  --eq-response: #f2d34f;
  --eq-spectrum: #d4ccd9;
  --eq-meter: #9bc445;
  --eq-color-scheme: dark;
}
.compact .parametric-stage-header {
  gap: 12px;
  padding-inline: 0;
  flex-wrap: wrap;
  padding-block: 10px;
}
.compact .stage-commands {
  gap: 8px;
}
.compact .parametric-graph-frame {
  min-height: 270px;
  padding: 32px 80px 54px 22px;
}
.compact .output-meter {
  top: 32px;
  bottom: 54px;
}
.compact .floating-band-inspector {
  position: relative;
  left: auto !important;
  top: auto !important;
  transform: none !important;
  align-self: center;
  flex-shrink: 0;
  margin: 0 12px 14px;
}
.compact .analyzer-footer {
  padding-block: 6px;
  gap: 6px 12px;
}
.compact .graph-hint span {
  display: none;
}
@container eq-workspace (max-width: 520px) {
  .stage-title {
    font-size: var(--te-type-caption);
  }
  .parametric-graph-frame {
    padding-right: 52px;
  }
  .output-meter {
    display: none;
  }
  .frequency-labels span:nth-child(even) {
    display: none;
  }
  .stage-status {
    font-size: 9px;
  }
}
@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    .parametric-workspace *,
    .parametric-workspace *::before {
      animation: none !important;
      transition: none !important;
    }
  }
}
</style>
