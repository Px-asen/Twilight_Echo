<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import ParametricEqBandInspector from '@renderer/components/equalizer/ParametricEqBandInspector.vue'
import {
  PARAMETRIC_EQ_MAX_BANDS,
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
import { placeEqInspector, placeEqTooltip } from '@renderer/utils/parametricEqLayout'
import type { EqualizerBand, EqualizerFilterType } from '@renderer/types/settings'

type HeadphoneCurveKey = 'source' | 'target' | 'individual' | 'combined' | 'corrected'
const props = defineProps<{
  bands: EqualizerBand[]
  selectedIndex: number
  filterTypes: { value: EqualizerFilterType; label: string; usesGain: boolean }[]
  responseView: 'dsp' | 'headphone'
  responsePath: string
  spectrumPath: string
  spectrumVisible: boolean
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
  select: [index: number]
  add: [frequency: number, gain: number]
  preview: [index: number, patch: Partial<EqualizerBand>]
  commit: []
  delete: [index: number]
  toggle: [index: number]
  filter: [index: number, filterType: EqualizerFilterType]
  'toggle-spectrum': []
  'toggle-headphone-curve': [curve: HeadphoneCurveKey]
}>()
const workspaceRef = ref<HTMLElement | null>(null)
const surfaceRef = ref<HTMLElement | null>(null)
const inspectorHost = ref<HTMLElement | null>(null)
const inspectorRef = ref<InstanceType<typeof ParametricEqBandInspector> | null>(null)
const hoveredIndex = ref<number | null>(null)
const inspectorOpen = ref(true)
const pointerPosition = shallowRef<{ x: number; y: number } | null>(null)
const drag = shallowRef<{
  index: number
  pointerId: number
  rect: DOMRect
  changed: boolean
} | null>(null)
const frozenInspector = shallowRef<{ left: number; top: number } | null>(null)
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
const gainTicks = [18, 12, 6, 0, -6, -12, -18]
const meterTicks = [0, -12, -24, -36, -48, -60]
const selectedBand = computed(() => props.bands[props.selectedIndex] ?? null)
const activeBandCount = computed(() => props.bands.filter((band) => band.enabled !== false).length)
const showInspector = computed(
  () => inspectorOpen.value && selectedBand.value && props.responseView === 'dsp'
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
const spectrumFillPath = computed(() =>
  props.spectrumPath ? `${props.spectrumPath} L100,100 L0,100 Z` : ''
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
  const band = selectedBand.value
  return placeEqInspector(
    bounds,
    band
      ? {
          x: (frequencyToPercent(band.frequency) * bounds.width) / 100,
          y: (gainToPercent(displayBandGain(band)) * bounds.height) / 100
        }
      : { x: 0, y: 0 },
    { width: bounds.panelWidth, height: bounds.panelHeight }
  )
}
const inspectorPosition = computed(() => {
  const placement = frozenInspector.value ?? currentInspectorPlacement()
  return {
    left: `${geometry.value.left + placement.left}px`,
    top: `${geometry.value.top + placement.top}px`
  }
})
const tooltipStyle = computed(() => {
  const band = tooltipBand.value
  if (!band) return {}
  const bounds = geometry.value
  const placement = placeEqTooltip(bounds, {
    x: (frequencyToPercent(band.frequency) * bounds.width) / 100,
    y: (gainToPercent(displayBandGain(band)) * bounds.height) / 100
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
  return { x, y, frequency: percentToFrequency(x), gain: percentToGain(y) }
}
function finishInteraction(): void {
  wheelCommit.flush()
  inspectorRef.value?.finishInteraction()
}
function selectBand(index: number): void {
  finishInteraction()
  emit('select', index)
  inspectorOpen.value = true
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
function beginDrag(index: number, event: PointerEvent): void {
  if (props.responseView !== 'dsp' || event.button !== 0 || drag.value || !surfaceRef.value) return
  selectBand(index)
  const element = event.currentTarget as HTMLElement
  element.focus({ preventScroll: true })
  hoveredIndex.value = index
  drag.value = {
    index,
    pointerId: event.pointerId,
    rect: surfaceRef.value.getBoundingClientRect(),
    changed: false
  }
  element.setPointerCapture(event.pointerId)
  freezeInspector(true)
}
function updatePointer(event: PointerEvent): void {
  if (!surfaceRef.value) return
  const current = drag.value
  const point = eventCoordinates(event, current?.rect ?? surfaceRef.value.getBoundingClientRect())
  pointerPosition.value = { x: point.x, y: point.y }
  if (!current || current.pointerId !== event.pointerId) return
  const band = props.bands[current.index]
  if (!band) return
  current.changed = true
  emit('preview', current.index, {
    frequency: point.frequency,
    ...(filterUsesGain(band.filterType) ? { gain: point.gain } : {})
  })
}
function endDrag(event: PointerEvent): void {
  const current = drag.value
  if (!current || current.pointerId !== event.pointerId) return
  drag.value = null
  const element = event.currentTarget as HTMLElement
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
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
  emit('preview', index, { q })
  wheelCommit.schedule()
}
function resetBandGain(index: number): void {
  const band = props.bands[index]
  if (!band || !filterUsesGain(band.filterType)) return
  selectBand(index)
  emit('preview', index, { gain: 0 })
  emit('commit')
}
function handleBandKeydown(index: number, event: KeyboardEvent): void {
  const band = props.bands[index]
  if (!band) return
  if (event.key === 'Escape') {
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
  emit('preview', index, {
    [field]: nudgeEqParameter(field, band[field], direction, event.shiftKey)
  })
  emit('commit')
}
function closeInspector(): void {
  inspectorOpen.value = false
  surfaceRef.value
    ?.querySelector<HTMLElement>('.parametric-band-handle.selected')
    ?.focus({ preventScroll: true })
}
onMounted(() => {
  resizeObserver = new ResizeObserver(measure)
  if (workspaceRef.value) resizeObserver.observe(workspaceRef.value)
  if (surfaceRef.value) resizeObserver.observe(surfaceRef.value)
  measure()
})
watch(showInspector, () => {
  void nextTick(measure)
})
watch(
  () => props.responseView,
  () => {
    finishInteraction()
    hoveredIndex.value = null
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
    :class="{ compact }"
    aria-label="参数均衡器"
    data-te-parametric-eq-workspace
  >
    <header class="parametric-stage-header">
      <div class="stage-brand">
        <span class="brand-symbol" aria-hidden="true">∿</span>
        <div>
          <strong>Twilight <em>EQ</em></strong
          ><small>PARAMETRIC EQUALIZER</small>
        </div>
      </div>
      <div class="stage-commands"><slot name="commands"></slot></div>
    </header>
    <div class="parametric-graph-frame" :class="{ bypassed: !eqEnabled }">
      <div class="graph-heading">
        <span>{{ activeBandCount }} / {{ PARAMETRIC_EQ_MAX_BANDS }} 频段</span
        ><span v-if="!eqEnabled" class="bypass-label">EQ 已旁路</span
        ><span class="graph-range">±18 dB</span>
      </div>
      <div
        ref="surfaceRef"
        class="parametric-graph-surface"
        :class="{ dragging: drag }"
        role="application"
        aria-label="参数均衡器频响编辑区"
        @pointermove="updatePointer"
        @pointerleave="pointerPosition = null"
        @click.self="addBand"
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
          :style="{ top: gainToPercent(gain) + '%' }"
        ></div>
        <div class="gain-labels" aria-hidden="true">
          <span
            v-for="gain in gainTicks"
            :key="gain"
            :class="{ zero: gain === 0 }"
            :style="{ top: gainToPercent(gain) + '%' }"
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
        <svg
          class="parametric-plot"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient :id="spectrumGradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--eq-spectrum)" stop-opacity="0.26" />
              <stop offset="100%" stop-color="var(--eq-spectrum)" stop-opacity="0.025" />
            </linearGradient>
          </defs>
          <path
            v-if="responseView === 'dsp' && spectrumVisible && spectrumFillPath"
            class="live-spectrum-fill"
            :d="spectrumFillPath"
            :fill="`url(#${spectrumGradientId})`"
          />
          <path
            v-if="responseView === 'dsp' && spectrumVisible && spectrumPath"
            class="live-spectrum-line"
            :d="spectrumPath"
            vector-effect="non-scaling-stroke"
          />
          <template v-if="responseView === 'dsp'">
            <template v-for="item in responseLayers" :key="item.index">
              <path
                v-if="!item.bypassed"
                class="individual-band-fill"
                :class="{ selected: selectedIndex === item.index }"
                :style="{ '--band-color': bandColor(item.index) }"
                :d="item.fill"
              />
              <path
                class="individual-band-line"
                :class="{ selected: selectedIndex === item.index, bypassed: item.bypassed }"
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
        <template v-if="responseView === 'dsp'">
          <button
            v-for="(band, index) in bands"
            :key="index"
            type="button"
            class="parametric-band-handle"
            :class="{
              selected: selectedIndex === index,
              hovered: hoveredIndex === index,
              bypassed: band.enabled === false,
              dragging: drag?.index === index
            }"
            :style="{
              left: frequencyToPercent(band.frequency) + '%',
              top: gainToPercent(displayBandGain(band)) + '%',
              '--band-color': bandColor(index)
            }"
            :aria-label="`频段 ${index + 1}，${formatFrequency(band.frequency)}，${formatGain(displayBandGain(band))}，Q ${band.q.toFixed(2)}`"
            :aria-pressed="selectedIndex === index"
            @click.stop="selectBand(index)"
            @pointerenter="hoveredIndex = index"
            @pointerleave="hoveredIndex = null"
            @pointerdown.prevent.stop="beginDrag(index, $event)"
            @pointermove.prevent.stop="updatePointer"
            @pointerup.prevent.stop="endDrag"
            @pointercancel.stop="endDrag"
            @lostpointercapture="endDrag"
            @wheel.prevent.stop="adjustQ(index, $event)"
            @dblclick.prevent.stop="resetBandGain(index)"
            @keydown="handleBandKeydown(index, $event)"
          >
            <span class="handle-index">{{ index + 1 }}</span>
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
          >拖动节点 · 滚轮调 Q · 双击复位增益<span v-if="bands.length >= PARAMETRIC_EQ_MAX_BANDS"
            >已达到 32 个频段上限</span
          ><span v-else>单击空白添加频段</span></template
        ><template v-else
          >R(f) = M(f) + H(f)<span>数字前级不计入声学预计 · 预计值，非实测</span></template
        >
      </div>
    </div>
    <div
      v-if="showInspector && selectedBand"
      ref="inspectorHost"
      class="floating-band-inspector"
      :style="{ ...inspectorPosition, '--band-color': bandColor(selectedIndex) }"
    >
      <ParametricEqBandInspector
        ref="inspectorRef"
        :key="selectedIndex"
        :band="selectedBand"
        :index="selectedIndex"
        :filter-types="filterTypes"
        @preview="(index, patch) => emit('preview', index, patch)"
        @commit="emit('commit')"
        @toggle="emit('toggle', $event)"
        @delete="emit('delete', $event)"
        @filter="(index, type) => emit('filter', index, type)"
        @close="closeInspector"
        @interaction="freezeInspector"
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
      <slot name="footer"></slot>
      <div class="stage-status" :class="`is-${statusState}`" :title="error || status" role="status">
        <span class="status-dot"></span><span>{{ status }}</span>
      </div>
    </footer>
    <div v-if="error" class="eq-apply-error" role="alert">{{ error }}</div>
  </section>
</template>

<style scoped>
.parametric-workspace {
  --eq-surface: #f4f3f0;
  --eq-surface-end: #eae8ee;
  --eq-panel: #e9e8e6;
  --eq-panel-raised: #fdfcfa;
  --eq-text: #29282e;
  --eq-text-muted: color-mix(in srgb, var(--eq-text) 74%, transparent);
  --eq-text-subtle: color-mix(in srgb, var(--eq-text) 68%, transparent);
  --eq-border: color-mix(in srgb, var(--eq-text) 20%, transparent);
  --eq-border-soft: color-mix(in srgb, var(--eq-text) 10%, transparent);
  --eq-grid: color-mix(in srgb, var(--eq-text) 5%, transparent);
  --eq-grid-major: color-mix(in srgb, var(--eq-text) 9%, transparent);
  --eq-zero-axis: color-mix(in srgb, var(--eq-text) 24%, transparent);
  --eq-response: #927000;
  --eq-spectrum: #636572;
  --eq-control-bg: color-mix(in srgb, var(--eq-text) 6%, transparent);
  --eq-shadow: rgba(35, 27, 43, 0.2);
  --eq-highlight: #ffffff;
  --eq-knob-light: var(--eq-panel-raised);
  --eq-knob-dark: #d4d3d6;
  --eq-knob-track: color-mix(in srgb, var(--eq-text) 22%, transparent);
  --eq-knob-edge: color-mix(in srgb, var(--eq-text) 32%, transparent);
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
  border: 1px solid var(--eq-border);
  border-radius: 14px;
  color: var(--eq-text);
  background: var(--eq-surface);
  box-shadow: 0 10px 34px var(--eq-shadow);
  container: eq-workspace / inline-size;
  isolation: isolate;
}
.parametric-stage-header {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 54px;
  flex-shrink: 0;
  padding: 0 18px;
  border-radius: 14px 14px 0 0;
  border-bottom: 1px solid var(--eq-border-soft);
  background: linear-gradient(180deg, var(--eq-panel-raised), var(--eq-surface));
  z-index: 40;
}
.stage-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.brand-symbol {
  font-size: 32px;
  font-weight: 300;
  color: var(--eq-response);
}
.stage-brand strong {
  font-size: 18px;
  font-weight: 550;
  letter-spacing: -0.04em;
}
.stage-brand em {
  color: var(--eq-response);
  font-style: normal;
  font-weight: 650;
}
.stage-brand small {
  display: block;
  margin-top: 2px;
  font-size: 7px;
  letter-spacing: 0.16em;
  color: var(--eq-text-subtle);
}
.stage-commands {
  display: flex;
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
  background:
    radial-gradient(ellipse at 50% 85%, var(--eq-surface-end), transparent 80%), var(--eq-surface);
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
.bypass-label {
  padding: 2px 6px;
  border: 1px solid var(--eq-border-soft);
  border-radius: 3px;
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
.live-spectrum-line {
  fill: none;
  stroke: var(--eq-spectrum);
  stroke-width: 0.8px;
  opacity: 0.64;
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
  border: 1.5px solid color-mix(in srgb, var(--band-color) 30%, var(--eq-highlight));
  border-radius: 50%;
  background: var(--band-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--band-color) 12%, transparent);
}
.parametric-band-handle.selected::before,
.parametric-band-handle.hovered::before {
  inset: 6px;
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--band-color) 22%, transparent),
    0 0 12px color-mix(in srgb, var(--band-color) 36%, transparent);
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
  outline: 2px solid var(--band-color);
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
  box-shadow: 0 4px 16px var(--eq-shadow);
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
  border-radius: 0 0 14px 14px;
  background: var(--eq-panel);
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
.spectrum-toggle:focus-visible,
.curve-control:focus-visible {
  outline: 2px solid var(--eq-response);
  outline-offset: 3px;
}
:global(html[data-theme='dark'] .parametric-workspace) {
  --eq-surface: #19181d;
  --eq-surface-end: #34303a;
  --eq-panel: #211f26;
  --eq-panel-raised: #35323c;
  --eq-text: #eeeaf2;
  --eq-text-muted: color-mix(in srgb, var(--eq-text) 76%, transparent);
  --eq-text-subtle: color-mix(in srgb, var(--eq-text) 62%, transparent);
  --eq-grid: color-mix(in srgb, var(--eq-text) 3%, transparent);
  --eq-grid-major: color-mix(in srgb, var(--eq-text) 6%, transparent);
  --eq-response: #f2d34f;
  --eq-spectrum: #d4ccd9;
  --eq-shadow: rgba(0, 0, 0, 0.38);
  --eq-highlight: #f9f5ff;
  --eq-knob-light: #44414b;
  --eq-knob-dark: #25242b;
  --eq-knob-edge: color-mix(in srgb, var(--eq-text) 30%, transparent);
  --eq-meter: #9bc445;
  --eq-color-scheme: dark;
}
.compact .parametric-stage-header {
  gap: 12px;
  padding-inline: 12px;
  flex-wrap: wrap;
  padding-block: 10px;
}
.compact .stage-brand strong {
  font-size: 16px;
}
.compact .stage-brand small {
  display: none;
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
  .stage-brand {
    display: none;
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
  .parametric-workspace *,
  .parametric-workspace *::before {
    animation: none !important;
    transition: none !important;
  }
}
</style>
