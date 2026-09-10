<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PARAMETRIC_EQ_MAX_BANDS,
  PARAMETRIC_EQ_MAX_FREQUENCY,
  PARAMETRIC_EQ_MAX_GAIN,
  PARAMETRIC_EQ_MAX_Q,
  PARAMETRIC_EQ_MIN_FREQUENCY,
  PARAMETRIC_EQ_MIN_GAIN,
  PARAMETRIC_EQ_MIN_Q,
  adjustQByWheel,
  clampEqValue,
  displayBandGain,
  filterUsesGain,
  frequencyToPercent,
  gainToPercent,
  percentToFrequency,
  percentToGain
} from '@renderer/utils/parametricEqInteraction'
import type { EqualizerBand, EqualizerFilterType } from '../../types/settings'

interface BandResponsePath {
  index: number
  path: string
}

interface FilterOption {
  value: EqualizerFilterType
  label: string
  usesGain: boolean
}

type HeadphoneCurveKey = 'source' | 'target' | 'individual' | 'combined' | 'corrected'

const props = defineProps<{
  bands: EqualizerBand[]
  selectedIndex: number
  filterTypes: FilterOption[]
  responseView: 'dsp' | 'headphone'
  responsePath: string
  responseFillPath: string
  spectrumPath: string
  spectrumVisible: boolean
  measuredSourcePath: string
  targetResponsePath: string
  combinedFilterPath: string
  correctedAcousticPath: string
  bandResponsePaths: BandResponsePath[]
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

const surfaceRef = ref<HTMLElement | null>(null)
const hoveredIndex = ref<number | null>(null)
const pointerPosition = ref<{ x: number; y: number } | null>(null)
const drag = ref<{ index: number; pointerId: number; rect: DOMRect } | null>(null)
const bandColors = [
  'var(--te-eq-band-blue, #3b82d6)',
  'var(--te-eq-band-cyan, #1f9db4)',
  'var(--te-eq-band-green, #2f9e6e)',
  'var(--te-eq-band-yellow, #dfa008)',
  'var(--te-eq-band-orange, #e8590c)',
  'var(--te-eq-band-magenta, #d65d8f)',
  'var(--te-eq-band-violet, #7671d8)',
  'var(--te-eq-band-red, #d64545)'
]
const frequencyTicks = [
  20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000, 20000
]
const majorFrequencyTicks = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
const gainTicks = [18, 12, 6, 0, -6, -12, -18]
const filterGlyphs: Record<EqualizerFilterType, string> = {
  peak: '⌁',
  lowShelf: '╰',
  highShelf: '╮',
  bandPass: '∩',
  lowPass: '╲',
  highPass: '╱',
  allPass: '∿',
  notch: '∨'
}

const selectedBand = computed(() => props.bands[props.selectedIndex] ?? null)
const hoveredBand = computed(() =>
  hoveredIndex.value === null ? null : (props.bands[hoveredIndex.value] ?? null)
)
const tooltipBand = computed(() => hoveredBand.value ?? (drag.value ? selectedBand.value : null))
const tooltipIndex = computed(() => hoveredIndex.value ?? (drag.value ? props.selectedIndex : null))
const spectrumFillPath = computed(() =>
  props.spectrumPath ? `${props.spectrumPath} L100,100 L0,100 Z` : ''
)
const selectedResponsePath = computed(
  () => props.bandResponsePaths.find((item) => item.index === props.selectedIndex)?.path ?? ''
)
const selectedResponseFillPath = computed(() =>
  selectedResponsePath.value ? `${selectedResponsePath.value} L100,50 L0,50 Z` : ''
)
const activeBandCount = computed(() => props.bands.filter((band) => band.enabled !== false).length)
const meterTicks = [0, -6, -12, -24, -36, -48, -60]
const peakMeterLevel = computed(() => meterLevel(props.meterPeakDb))
const rmsMeterLevel = computed(() => meterLevel(props.meterRmsDb))

function meterLevel(db: number): number {
  return clampEqValue(((clampEqValue(db, -60, 0) + 60) / 60) * 100, 0, 100)
}

function bandColor(index: number): string {
  return bandColors[index % bandColors.length]
}

function bandFilterLabel(band: EqualizerBand): string {
  return props.filterTypes.find((filter) => filter.value === band.filterType)?.label ?? '峰值'
}

function formatFrequency(frequency: number): string {
  if (frequency >= 1000) return `${(frequency / 1000).toFixed(frequency >= 10000 ? 1 : 2)} kHz`
  return `${Math.round(frequency)} Hz`
}

function formatGain(gain: number): string {
  return `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`
}

function formatTickFrequency(frequency: number): string {
  if (frequency >= 1000) return `${frequency / 1000}k`
  return String(frequency)
}

function filterGlyph(filterType: EqualizerFilterType): string {
  return filterGlyphs[filterType]
}

function knobProgress(value: number, min: number, max: number): string {
  const ratio = (clampEqValue(value, min, max) - min) / (max - min)
  return `${Math.round(ratio * 270 - 135)}deg`
}

function frequencyKnobProgress(frequency: number): string {
  return `${Math.round((frequencyToPercent(frequency) / 100) * 270 - 135)}deg`
}

function nudgeNumeric(field: 'frequency' | 'gain' | 'q', direction: -1 | 1, fine = false): void {
  const band = selectedBand.value
  if (!band) return
  const next =
    field === 'frequency'
      ? clampEqValue(
          band.frequency * (fine ? (direction > 0 ? 1.005 : 0.995) : direction > 0 ? 1.025 : 0.975),
          PARAMETRIC_EQ_MIN_FREQUENCY,
          PARAMETRIC_EQ_MAX_FREQUENCY
        )
      : field === 'gain'
        ? clampEqValue(
            band.gain + direction * (fine ? 0.1 : 0.5),
            PARAMETRIC_EQ_MIN_GAIN,
            PARAMETRIC_EQ_MAX_GAIN
          )
        : clampEqValue(
            band.q * (fine ? (direction > 0 ? 1.01 : 0.99) : direction > 0 ? 1.08 : 0.92),
            PARAMETRIC_EQ_MIN_Q,
            PARAMETRIC_EQ_MAX_Q
          )
  emit('preview', props.selectedIndex, {
    [field]: field === 'frequency' ? Math.round(next) : Math.round(next * 100) / 100
  })
  emit('commit')
}

function eventCoordinates(
  event: PointerEvent | MouseEvent,
  rect: DOMRect
): {
  x: number
  y: number
  frequency: number
  gain: number
} {
  const x = Math.min(
    100,
    Math.max(0, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100)
  )
  const y = Math.min(
    100,
    Math.max(0, ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100)
  )
  return { x, y, frequency: percentToFrequency(x), gain: percentToGain(y) }
}

function updatePointer(event: PointerEvent): void {
  const surface = surfaceRef.value
  if (!surface) return
  const point = eventCoordinates(event, surface.getBoundingClientRect())
  pointerPosition.value = { x: point.x, y: point.y }
  if (!drag.value || drag.value.pointerId !== event.pointerId) return
  const band = props.bands[drag.value.index]
  if (!band) return
  emit('preview', drag.value.index, {
    frequency: point.frequency,
    ...(filterUsesGain(band.filterType) ? { gain: point.gain } : {})
  })
}

function addBand(event: MouseEvent): void {
  if (props.responseView !== 'dsp' || drag.value) return
  if ((event.target as HTMLElement).closest('.parametric-band-handle')) return
  if (hoveredIndex.value !== null) return
  if (props.bands.length >= PARAMETRIC_EQ_MAX_BANDS) return
  const surface = surfaceRef.value
  if (!surface) return
  const point = eventCoordinates(event, surface.getBoundingClientRect())
  emit('add', point.frequency, point.gain)
}

function beginDrag(index: number, event: PointerEvent): void {
  if (props.responseView !== 'dsp') return
  const element = event.currentTarget as HTMLElement
  const surface = surfaceRef.value
  if (!surface) return
  emit('select', index)
  hoveredIndex.value = index
  drag.value = { index, pointerId: event.pointerId, rect: surface.getBoundingClientRect() }
  element.setPointerCapture(event.pointerId)
}

function endDrag(event: PointerEvent): void {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return
  const element = event.currentTarget as HTMLElement
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
  drag.value = null
  emit('commit')
}

function adjustQ(index: number, event: WheelEvent): void {
  const band = props.bands[index]
  if (!band) return
  emit('select', index)
  emit('preview', index, { q: adjustQByWheel(band.q, event.deltaY, event.shiftKey) })
  emit('commit')
}

function resetBandGain(index: number): void {
  const band = props.bands[index]
  if (!band || !filterUsesGain(band.filterType)) return
  emit('select', index)
  emit('preview', index, { gain: 0 })
  emit('commit')
}

function handleBandKeydown(index: number, event: KeyboardEvent): void {
  const band = props.bands[index]
  if (!band) return
  const frequencyDirection = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const gainDirection = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
  if (frequencyDirection === 0 && gainDirection === 0) return
  event.preventDefault()
  emit('select', index)
  const frequency = clampEqValue(
    band.frequency *
      (event.shiftKey
        ? frequencyDirection > 0
          ? 1.005
          : 0.995
        : frequencyDirection > 0
          ? 1.025
          : 0.975),
    PARAMETRIC_EQ_MIN_FREQUENCY,
    PARAMETRIC_EQ_MAX_FREQUENCY
  )
  emit('preview', index, {
    ...(frequencyDirection !== 0 ? { frequency: Math.round(frequency) } : {}),
    ...(gainDirection !== 0 && filterUsesGain(band.filterType)
      ? {
          gain: clampEqValue(
            band.gain + gainDirection * (event.shiftKey ? 0.1 : 0.5),
            PARAMETRIC_EQ_MIN_GAIN,
            PARAMETRIC_EQ_MAX_GAIN
          )
        }
      : {})
  })
  emit('commit')
}

function updateNumeric(field: 'frequency' | 'gain' | 'q', event: Event): void {
  const band = selectedBand.value
  if (!band) return
  emit('preview', props.selectedIndex, {
    [field]: Number((event.target as HTMLInputElement).value)
  })
  emit('commit')
}
</script>

<template>
  <section class="parametric-workspace" data-te-parametric-eq-workspace>
    <header class="parametric-stage-header">
      <div class="stage-brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <small>{{ activeBandCount }} / {{ PARAMETRIC_EQ_MAX_BANDS }}</small>
      </div>
      <div class="stage-actions">
        <div class="stage-status" :class="`is-${statusState}`" :title="error || status">
          <span class="status-dot"></span>
          <span>{{ status }}</span>
        </div>
        <button
          v-if="responseView === 'dsp'"
          type="button"
          class="spectrum-toggle"
          :class="{ active: spectrumVisible }"
          :aria-pressed="spectrumVisible"
          @click="emit('toggle-spectrum')"
        >
          <i class="pi pi-chart-line"></i>
          ANALYZER
        </button>
      </div>
    </header>

    <div
      ref="surfaceRef"
      class="parametric-graph-surface"
      :class="{ disabled: !eqEnabled, dragging: drag }"
      role="application"
      aria-label="参数均衡器频响编辑区"
      @pointermove="updatePointer"
      @pointerleave="pointerPosition = null"
      @click.self="addBand"
    >
      <div
        v-for="frequency in frequencyTicks"
        :key="`frequency-grid-${frequency}`"
        class="frequency-grid-line"
        :class="{ major: majorFrequencyTicks.has(frequency) }"
        :style="{ left: frequencyToPercent(frequency) + '%' }"
      ></div>
      <div
        v-for="gain in gainTicks"
        :key="`gain-grid-${gain}`"
        class="gain-grid-line"
        :class="{ zero: gain === 0 }"
        :style="{ top: gainToPercent(gain) + '%' }"
      ></div>

      <div class="gain-labels" aria-hidden="true">
        <span v-for="gain in gainTicks" :key="gain" :style="{ top: gainToPercent(gain) + '%' }">
          {{ gain > 0 ? '+' + gain : gain }}
        </span>
      </div>
      <div class="frequency-labels" aria-hidden="true">
        <span
          v-for="frequency in frequencyTicks.filter((tick) => majorFrequencyTicks.has(tick))"
          :key="frequency"
          :style="{ left: frequencyToPercent(frequency) + '%' }"
        >
          {{ formatTickFrequency(frequency) }}
        </span>
      </div>

      <div
        v-if="responseView === 'headphone'"
        class="headphone-curve-controls"
        aria-label="耳机频响曲线显示控制"
      >
        <button
          type="button"
          class="curve-control source"
          :class="{ muted: !showMeasuredSource }"
          :aria-pressed="showMeasuredSource"
          @click.stop="emit('toggle-headphone-curve', 'source')"
        >
          <i></i>源频响
        </button>
        <button
          type="button"
          class="curve-control target"
          :class="{ muted: !showTargetResponse }"
          :aria-pressed="showTargetResponse"
          @click.stop="emit('toggle-headphone-curve', 'target')"
        >
          <i></i>目标
        </button>
        <button
          type="button"
          class="curve-control individual"
          :class="{ muted: !showIndividualFilters }"
          :aria-pressed="showIndividualFilters"
          @click.stop="emit('toggle-headphone-curve', 'individual')"
        >
          <i></i>单滤波
        </button>
        <button
          type="button"
          class="curve-control combined"
          :class="{ muted: !showCombinedFilter }"
          :aria-pressed="showCombinedFilter"
          @click.stop="emit('toggle-headphone-curve', 'combined')"
        >
          <i></i>合并滤波
        </button>
        <button
          type="button"
          class="curve-control corrected"
          :class="{ muted: !showCorrectedResponse }"
          :aria-pressed="showCorrectedResponse"
          @click.stop="emit('toggle-headphone-curve', 'corrected')"
        >
          <i></i>滤波结果
        </button>
      </div>

      <svg
        class="parametric-plot"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="spectrumFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--eq-spectrum)" stop-opacity="0.14" />
            <stop offset="100%" stop-color="var(--eq-spectrum)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path
          v-if="responseView === 'dsp' && spectrumVisible && spectrumFillPath"
          class="live-spectrum-fill"
          :d="spectrumFillPath"
        />
        <path
          v-if="responseView === 'dsp' && spectrumVisible && spectrumPath"
          class="live-spectrum-line"
          :d="spectrumPath"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-if="responseView === 'headphone' && showMeasuredSource && measuredSourcePath"
          class="measured-source-line"
          :d="measuredSourcePath"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-if="responseView === 'headphone' && showTargetResponse && targetResponsePath"
          class="target-response-line"
          :d="targetResponsePath"
          vector-effect="non-scaling-stroke"
        />
        <template v-if="responseView === 'headphone' && showIndividualFilters">
          <path
            v-for="item in bandResponsePaths"
            :key="`headphone-band-${item.index}`"
            class="individual-band-line headphone-filter"
            :style="{ '--band-color': bandColor(item.index) }"
            :d="item.path"
            vector-effect="non-scaling-stroke"
          />
        </template>
        <path
          v-if="responseView === 'headphone' && showCombinedFilter && combinedFilterPath"
          class="combined-filter-line"
          :d="combinedFilterPath"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-if="responseView === 'headphone' && showCorrectedResponse && correctedAcousticPath"
          class="corrected-acoustic-line"
          :d="correctedAcousticPath"
          vector-effect="non-scaling-stroke"
        />
        <template v-if="responseView === 'dsp'">
          <path
            v-if="selectedResponseFillPath"
            class="selected-band-fill"
            :style="{ '--selected-band-color': bandColor(selectedIndex) }"
            :d="selectedResponseFillPath"
          />
          <path
            v-for="item in bandResponsePaths"
            :key="item.index"
            class="individual-band-line"
            :class="{ selected: selectedIndex === item.index }"
            :style="{ '--band-color': bandColor(item.index) }"
            :d="item.path"
            vector-effect="non-scaling-stroke"
          />
          <path class="composite-fill" :d="responseFillPath" />
          <path
            class="composite-response-line"
            :d="responsePath"
            vector-effect="non-scaling-stroke"
          />
        </template>
      </svg>

      <template v-if="responseView === 'dsp'">
        <div
          v-if="selectedBand"
          class="selected-band-focus"
          :style="{
            left: frequencyToPercent(selectedBand.frequency) + '%',
            top: gainToPercent(displayBandGain(selectedBand)) + '%',
            '--band-color': bandColor(selectedIndex),
            '--focus-width': Math.max(38, Math.min(240, 150 / Math.sqrt(selectedBand.q))) + 'px'
          }"
          aria-hidden="true"
        ></div>
        <button
          v-for="(band, index) in bands"
          :key="`${index}-${band.filterType}`"
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
          @click.stop="emit('select', index)"
          @pointerenter="hoveredIndex = index"
          @pointerleave="hoveredIndex = null"
          @pointerdown.prevent.stop="beginDrag(index, $event)"
          @pointermove.prevent.stop="updatePointer"
          @pointerup.prevent.stop="endDrag"
          @pointercancel.prevent.stop="endDrag"
          @wheel.prevent.stop="adjustQ(index, $event)"
          @dblclick.prevent.stop="resetBandGain(index)"
          @keydown="handleBandKeydown(index, $event)"
        >
          <span class="handle-index">{{ index + 1 }}</span>
        </button>
      </template>

      <div
        v-if="tooltipBand && tooltipIndex !== null"
        class="band-tooltip"
        :style="{
          left: frequencyToPercent(tooltipBand.frequency) + '%',
          top: gainToPercent(displayBandGain(tooltipBand)) + '%',
          '--band-color': bandColor(tooltipIndex)
        }"
      >
        <strong>{{ bandFilterLabel(tooltipBand) }}</strong>
        <span>{{ formatFrequency(tooltipBand.frequency) }}</span>
        <span>{{ formatGain(displayBandGain(tooltipBand)) }}</span>
        <span>Q {{ tooltipBand.q.toFixed(2) }}</span>
      </div>

      <div
        v-if="pointerPosition && responseView === 'dsp' && !drag"
        class="graph-crosshair"
        :style="{ left: pointerPosition.x + '%', top: pointerPosition.y + '%' }"
        aria-hidden="true"
      ></div>

      <aside class="output-meter" aria-label="输出电平">
        <div class="meter-scale" aria-hidden="true">
          <span
            v-for="tick in meterTicks"
            :key="tick"
            :style="{ top: 100 - meterLevel(tick) + '%' }"
          >
            {{ tick }}
          </span>
        </div>
        <div class="meter-channel" aria-label="左声道">
          <i class="meter-peak" :style="{ transform: `scaleY(${peakMeterLevel / 100})` }"></i>
          <i class="meter-rms" :style="{ transform: `scaleY(${rmsMeterLevel / 100})` }"></i>
        </div>
        <div class="meter-channel" aria-label="右声道">
          <i
            class="meter-peak"
            :style="{ transform: `scaleY(${Math.max(0, peakMeterLevel - 2) / 100})` }"
          ></i>
          <i
            class="meter-rms"
            :style="{ transform: `scaleY(${Math.max(0, rmsMeterLevel - 3) / 100})` }"
          ></i>
        </div>
        <div class="meter-labels" aria-hidden="true"><span>L</span><span>R</span></div>
      </aside>

      <div class="analyzer-footer" aria-hidden="true">
        <template v-if="responseView === 'dsp'">
          <span>拖拽移动节点</span>
          <i></i>
          <span>滚轮调节 Q</span>
          <i></i>
          <span>双击复位增益</span>
          <em>单击空白添加频段</em>
        </template>
        <template v-else>
          <span>R(f) = M(f) + H(f)</span>
          <i></i>
          <span>数字前级不计入声学预计</span>
          <em>预计值，不代表校正后实测</em>
        </template>
      </div>

      <div v-if="bands.length >= PARAMETRIC_EQ_MAX_BANDS" class="band-limit-notice">
        已达到 {{ PARAMETRIC_EQ_MAX_BANDS }} 个频段上限
      </div>
    </div>

    <div
      v-if="selectedBand && responseView === 'dsp'"
      class="floating-band-inspector"
      :style="{ '--band-color': bandColor(selectedIndex) }"
    >
      <div class="inspector-topbar">
        <div class="inspector-identity">
          <button
            type="button"
            class="band-power"
            :class="{ bypassed: selectedBand.enabled === false }"
            :aria-label="selectedBand.enabled === false ? '启用频段' : '旁路频段'"
            @click="emit('toggle', selectedIndex)"
          >
            <i class="pi pi-power-off"></i>
          </button>
          <span class="selected-band-badge">{{ selectedIndex + 1 }}</span>
          <div>
            <small>BAND {{ String(selectedIndex + 1).padStart(2, '0') }}</small>
            <strong>{{ bandFilterLabel(selectedBand) }}</strong>
          </div>
        </div>

        <div class="filter-strip" aria-label="滤波器类型">
          <button
            v-for="filter in filterTypes"
            :key="filter.value"
            type="button"
            :class="{ active: selectedBand.filterType === filter.value }"
            :title="filter.label"
            :aria-label="filter.label"
            :aria-pressed="selectedBand.filterType === filter.value"
            @click="emit('filter', selectedIndex, filter.value)"
          >
            {{ filterGlyph(filter.value) }}
          </button>
        </div>

        <button
          type="button"
          class="delete-band"
          aria-label="删除所选频段"
          @click="emit('delete', selectedIndex)"
        >
          <i class="pi pi-times"></i>
        </button>
      </div>

      <div class="precision-controls">
        <label
          class="precision-control"
          :style="{ '--knob-angle': frequencyKnobProgress(selectedBand.frequency) }"
        >
          <span class="control-label">FREQUENCY</span>
          <div class="knob-shell frequency-knob">
            <button
              type="button"
              aria-label="降低频率"
              @click="nudgeNumeric('frequency', -1, $event.shiftKey)"
            >
              −
            </button>
            <div class="knob-face"><span></span></div>
            <button
              type="button"
              aria-label="提高频率"
              @click="nudgeNumeric('frequency', 1, $event.shiftKey)"
            >
              +
            </button>
          </div>
          <div class="precision-readout">
            <input
              type="number"
              min="20"
              max="20000"
              step="1"
              :value="Math.round(selectedBand.frequency)"
              @change="updateNumeric('frequency', $event)"
            />
            <small>Hz</small>
          </div>
        </label>

        <label
          class="precision-control"
          :class="{ disabled: !filterUsesGain(selectedBand.filterType) }"
          :style="{
            '--knob-angle': knobProgress(
              selectedBand.gain,
              PARAMETRIC_EQ_MIN_GAIN,
              PARAMETRIC_EQ_MAX_GAIN
            )
          }"
        >
          <span class="control-label">GAIN</span>
          <div class="knob-shell gain-knob">
            <button
              type="button"
              aria-label="降低增益"
              :disabled="!filterUsesGain(selectedBand.filterType)"
              @click="nudgeNumeric('gain', -1, $event.shiftKey)"
            >
              −
            </button>
            <div class="knob-face"><span></span></div>
            <button
              type="button"
              aria-label="提高增益"
              :disabled="!filterUsesGain(selectedBand.filterType)"
              @click="nudgeNumeric('gain', 1, $event.shiftKey)"
            >
              +
            </button>
          </div>
          <div class="precision-readout">
            <input
              type="number"
              min="-18"
              max="18"
              step="0.1"
              :value="selectedBand.gain.toFixed(1)"
              :disabled="!filterUsesGain(selectedBand.filterType)"
              @change="updateNumeric('gain', $event)"
            />
            <small>dB</small>
          </div>
        </label>

        <label
          class="precision-control"
          :style="{
            '--knob-angle': knobProgress(selectedBand.q, PARAMETRIC_EQ_MIN_Q, PARAMETRIC_EQ_MAX_Q)
          }"
        >
          <span class="control-label">Q / SLOPE</span>
          <div class="knob-shell q-knob">
            <button
              type="button"
              aria-label="降低 Q 值"
              @click="nudgeNumeric('q', -1, $event.shiftKey)"
            >
              −
            </button>
            <div class="knob-face"><span></span></div>
            <button
              type="button"
              aria-label="提高 Q 值"
              @click="nudgeNumeric('q', 1, $event.shiftKey)"
            >
              +
            </button>
          </div>
          <div class="precision-readout">
            <input
              type="number"
              min="0.1"
              max="20"
              step="0.01"
              :value="selectedBand.q.toFixed(2)"
              @change="updateNumeric('q', $event)"
            />
            <small>Q</small>
          </div>
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ————————————————————————————————————————————————
   Signal · flat instrument palette
   Light: warm paper + ink + a single signal-orange accent.
   Dark: neutral charcoal (no purple cast). No shadows, no gradients.
———————————————————————————————————————————————— */
.parametric-workspace {
  --eq-surface: #f5f4f0;
  --eq-surface-soft: #faf9f6;
  --eq-panel: #efede8;
  --eq-panel-raised: #fbfaf7;
  --eq-text: #1e2022;
  --eq-text-muted: rgba(30, 32, 34, 0.6);
  --eq-text-subtle: rgba(30, 32, 34, 0.38);
  --eq-border: rgba(30, 32, 34, 0.16);
  --eq-border-soft: rgba(30, 32, 34, 0.08);
  --eq-grid: rgba(30, 32, 34, 0.06);
  --eq-grid-major: rgba(30, 32, 34, 0.11);
  --eq-zero-axis: rgba(232, 80, 16, 0.42);
  --eq-response: #22252a;
  --eq-composite: #e85010;
  --eq-accent: #e85010;
  --eq-source: var(--te-info-500);
  --eq-target: var(--te-neutral-500);
  --eq-filter-combined: var(--te-warning-500);
  --eq-corrected: var(--te-success-500);
  --eq-spectrum: rgba(30, 32, 34, 0.38);
  --eq-control-bg: rgba(30, 32, 34, 0.04);
  --eq-tooltip-bg: #fbfaf7;
  --eq-meter: #2f9e6e;
  --eq-handle-on-color: #ffffff;
  --eq-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--eq-text);
  background: var(--eq-surface);
  border: 1px solid var(--eq-border);
  border-radius: 12px;
  overflow: hidden;
}

/* —— Header —— */
.parametric-stage-header {
  min-height: 46px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--eq-border-soft);
  background: var(--eq-surface-soft);
}

.stage-brand,
.stage-actions,
.inspector-identity,
.knob-shell,
.precision-readout {
  display: flex;
  align-items: center;
}

.stage-brand {
  min-width: 0;
  gap: 9px;
}

.brand-mark {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 1px;
  background: var(--eq-accent);
}

.stage-brand strong {
  color: var(--eq-text);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 750;
  letter-spacing: 0.16em;
  white-space: nowrap;
}

.stage-brand strong em {
  color: var(--eq-accent);
  font-style: normal;
}

.stage-brand small {
  color: var(--eq-text-subtle);
  font-family: var(--eq-mono);
  font-size: 7px;
  letter-spacing: 0.1em;
  white-space: nowrap;
}

.stage-actions {
  gap: 8px;
}

.stage-status,
.spectrum-toggle {
  min-height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  border: 1px solid var(--eq-border-soft);
  border-radius: 6px;
  color: var(--eq-text-muted);
  background: transparent;
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
  font-weight: 650;
  letter-spacing: 0.06em;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--eq-meter);
}

.stage-status.is-applying .status-dot,
.stage-status.is-editing .status-dot {
  background: var(--eq-accent);
  animation: statusPulse 0.9s ease-in-out infinite alternate;
}

.stage-status.is-failed .status-dot {
  background: var(--te-danger-soft-fg);
}

.spectrum-toggle {
  appearance: none;
  cursor: pointer;
}

.spectrum-toggle.active {
  border-color: color-mix(in srgb, var(--eq-accent) 45%, transparent);
  color: var(--eq-accent);
  background: color-mix(in srgb, var(--eq-accent) 7%, transparent);
}

/* —— Graph surface —— */
.parametric-graph-surface {
  position: relative;
  height: clamp(420px, 56vh, 600px);
  min-height: 380px;
  overflow: hidden;
  cursor: crosshair;
  touch-action: none;
  user-select: none;
  background: var(--eq-surface);
}

.parametric-graph-surface.disabled .composite-response-line,
.parametric-graph-surface.disabled .composite-fill,
.parametric-graph-surface.disabled .individual-band-line {
  opacity: 0.3;
}

.frequency-grid-line,
.gain-grid-line {
  position: absolute;
  z-index: 1;
  pointer-events: none;
}

.frequency-grid-line {
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--eq-grid);
}

.frequency-grid-line.major {
  background: var(--eq-grid-major);
}

.gain-grid-line {
  left: 0;
  right: 0;
  height: 1px;
  background: var(--eq-grid);
}

.gain-grid-line.zero {
  z-index: 5;
  background: var(--eq-zero-axis);
}

.gain-labels span,
.frequency-labels span {
  position: absolute;
  z-index: 10;
  color: var(--eq-text-subtle);
  font-family: var(--eq-mono);
  font-size: 8px;
  font-weight: 520;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.gain-labels span {
  left: 8px;
  transform: translateY(-50%);
}

.frequency-labels span {
  bottom: 32px;
  transform: translateX(-50%);
}

.frequency-labels span:first-child {
  transform: none;
}

.frequency-labels span:last-child {
  transform: translateX(-100%);
}

/* —— Headphone curve controls —— */
.headphone-curve-controls {
  position: absolute;
  z-index: 15;
  top: 10px;
  left: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: calc(100% - 78px);
}

.curve-control {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 7px;
  appearance: none;
  border: 1px solid var(--eq-border-soft);
  border-radius: 5px;
  color: var(--eq-text-muted);
  background: var(--eq-tooltip-bg);
  cursor: pointer;
  font-family: var(--eq-mono);
  font-size: 8px;
}

.curve-control.muted {
  opacity: 0.38;
}

.curve-control i {
  width: 14px;
  border-top: 2px solid var(--curve-color, var(--eq-text-muted));
}

.curve-control.source {
  --curve-color: var(--eq-source);
}

.curve-control.target {
  --curve-color: var(--eq-target);
}

.curve-control.target i {
  border-top-style: dashed;
}

.curve-control.individual {
  --curve-color: var(--te-eq-band-violet, #7671d8);
}

.curve-control.combined {
  --curve-color: var(--eq-filter-combined);
}

.curve-control.corrected {
  --curve-color: var(--eq-corrected);
}

/* —— Plot —— */
.parametric-plot {
  position: absolute;
  inset: 0;
  z-index: 4;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.parametric-plot path {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.live-spectrum-fill {
  fill: url(#spectrumFill) !important;
  stroke: none !important;
}

.live-spectrum-line {
  stroke: var(--eq-spectrum);
  stroke-width: 0.9px;
  opacity: 0.85;
}

.selected-band-fill {
  fill: var(--selected-band-color) !important;
  stroke: none !important;
  opacity: 0.13;
}

.individual-band-line {
  stroke: var(--band-color);
  stroke-width: 0.9px;
  opacity: 0.3;
  transition:
    opacity 140ms ease,
    stroke-width 140ms ease;
}

.individual-band-line.selected {
  stroke-width: 1.5px;
  opacity: 0.95;
}

.composite-fill {
  fill: var(--eq-composite);
  stroke: none;
  opacity: 0.09;
}

.composite-response-line {
  stroke: var(--eq-response);
  stroke-width: 1.6px;
  opacity: 0.96;
}

.measured-source-line {
  stroke: var(--eq-source);
  stroke-width: 1.25px;
  opacity: 0.88;
}

.target-response-line {
  stroke: var(--eq-target);
  stroke-width: 1.1px;
  stroke-dasharray: 5 4;
}

.individual-band-line.headphone-filter {
  opacity: 0.44;
}

.combined-filter-line {
  stroke: var(--eq-filter-combined);
  stroke-width: 1.5px;
  stroke-dasharray: 2.5 2;
}

.corrected-acoustic-line {
  stroke: var(--eq-corrected);
  stroke-width: 1.9px;
}

/* —— Band handles —— */
.selected-band-focus {
  position: absolute;
  z-index: 6;
  width: var(--focus-width);
  height: 42px;
  transform: translate(-50%, -50%);
  border: 1px solid color-mix(in srgb, var(--band-color) 26%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--band-color) 5%, transparent);
  pointer-events: none;
}

.parametric-band-handle {
  position: absolute;
  z-index: 12;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0;
  transform: translate(-50%, -50%);
  appearance: none;
  border: 1.5px solid var(--band-color);
  border-radius: 50%;
  color: var(--band-color);
  background: var(--eq-panel-raised);
  cursor: grab;
  transition:
    scale 120ms var(--te-ease-soft),
    opacity 120ms ease;
  touch-action: none;
}

.handle-index {
  font-size: 8px;
  font-weight: 750;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.parametric-band-handle:hover,
.parametric-band-handle.hovered,
.parametric-band-handle.selected {
  scale: 1.2;
}

.parametric-band-handle.selected {
  color: var(--eq-handle-on-color);
  background: var(--band-color);
}

.parametric-band-handle.dragging {
  cursor: grabbing;
  transition: none;
}

.parametric-band-handle.bypassed {
  border-style: dashed;
  opacity: 0.42;
}

/* —— Tooltip & crosshair —— */
.band-tooltip {
  position: absolute;
  z-index: 20;
  display: grid;
  grid-template-columns: repeat(3, auto);
  gap: 3px 12px;
  min-width: max-content;
  padding: 7px 10px 8px;
  transform: translate(-50%, calc(-100% - 14px));
  border: 1px solid var(--eq-border);
  border-top: 2px solid var(--band-color);
  border-radius: 6px;
  color: var(--eq-text-muted);
  background: var(--eq-tooltip-bg);
  pointer-events: none;
}

.band-tooltip strong {
  grid-column: 1 / -1;
  color: var(--eq-text);
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
  font-weight: 700;
  letter-spacing: 0.06em;
}

.band-tooltip span {
  font-family: var(--eq-mono);
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
  font-variant-numeric: tabular-nums;
}

.graph-crosshair {
  position: absolute;
  z-index: 6;
  width: 5px;
  height: 5px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--eq-text);
  opacity: 0.5;
  pointer-events: none;
}

.graph-crosshair::before,
.graph-crosshair::after {
  position: absolute;
  content: '';
  background: color-mix(in srgb, var(--eq-text) 14%, transparent);
}

.graph-crosshair::before {
  top: -1200px;
  left: 2px;
  width: 1px;
  height: 2400px;
}

.graph-crosshair::after {
  top: 2px;
  left: -1200px;
  width: 2400px;
  height: 1px;
}

/* —— Output meter —— */
.output-meter {
  position: absolute;
  z-index: 16;
  top: 10px;
  right: 10px;
  bottom: 36px;
  width: 48px;
  display: grid;
  grid-template-columns: 1fr 7px 7px;
  gap: 4px;
  padding-bottom: 13px;
  pointer-events: none;
}

.meter-scale {
  position: relative;
  color: var(--eq-text-subtle);
  font-family: var(--eq-mono);
  font-size: 7px;
}

.meter-scale span {
  position: absolute;
  right: 2px;
  transform: translateY(-50%);
}

.meter-channel {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--eq-border-soft);
  border-radius: 2px;
  background: var(--eq-control-bg);
}

.meter-channel i {
  position: absolute;
  right: 1px;
  bottom: 1px;
  left: 1px;
  height: 100%;
  display: block;
  transform: scaleY(0);
  transform-origin: 50% 100%;
  will-change: transform;
  transition: none;
}

.meter-peak {
  background: var(--eq-meter);
}

.meter-rms {
  right: 3px !important;
  left: 3px !important;
  background: color-mix(in srgb, var(--eq-meter) 55%, transparent);
}

.meter-labels {
  position: absolute;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 5px;
  color: var(--eq-text-subtle);
  font-family: var(--eq-mono);
  font-size: 7px;
}

/* —— Footer hints —— */
.analyzer-footer {
  position: absolute;
  z-index: 14;
  right: 0;
  bottom: 0;
  left: 0;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border-top: 1px solid var(--eq-border-soft);
  color: var(--eq-text-subtle);
  background: var(--eq-surface-soft);
  font-size: 8px;
  letter-spacing: 0.05em;
  pointer-events: none;
}

.analyzer-footer i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--eq-text-subtle);
}

.analyzer-footer em {
  margin-left: 14px;
  color: var(--eq-accent);
  font-style: normal;
}

.band-limit-notice {
  position: absolute;
  right: 12px;
  bottom: 34px;
  z-index: 18;
  padding: 4px 8px;
  border: 1px solid var(--eq-border);
  border-radius: 5px;
  color: var(--te-warning-500);
  background: var(--eq-tooltip-bg);
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
  font-weight: 650;
}

/* —— Inspector (docked flat strip) —— */
.floating-band-inspector {
  border-top: 1px solid var(--eq-border);
  background: var(--eq-surface-soft);
}

.inspector-topbar {
  min-height: 36px;
  display: grid;
  grid-template-columns: minmax(150px, auto) 1fr 30px;
  align-items: center;
  gap: 10px;
  padding: 3px 6px 3px 10px;
  border-bottom: 1px solid var(--eq-border-soft);
}

.inspector-identity {
  min-width: 0;
  gap: 8px;
}

.inspector-identity > div {
  display: grid;
  gap: 1px;
}

.inspector-identity small {
  color: var(--eq-text-subtle);
  font-family: var(--eq-mono);
  font-size: 6px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.inspector-identity strong {
  color: color-mix(in srgb, var(--band-color) 82%, var(--eq-text));
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
  font-weight: 700;
}

.selected-band-badge {
  min-width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--band-color) 62%, transparent);
  border-radius: 4px;
  color: var(--band-color);
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}

.band-power {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--eq-meter) 45%, transparent);
  border-radius: 50%;
  color: var(--eq-meter);
  background: transparent;
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
}

.band-power.bypassed {
  border-color: var(--eq-border);
  color: var(--eq-text-subtle);
}

.filter-strip {
  display: flex;
  justify-content: center;
  gap: 2px;
}

.filter-strip button,
.delete-band {
  width: 26px;
  height: 24px;
  display: grid;
  place-items: center;
  appearance: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--eq-text-subtle);
  background: transparent;
  cursor: pointer;
  font-family: var(--eq-mono);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
}

.filter-strip button:hover {
  color: var(--eq-text);
}

.filter-strip button.active {
  border-color: color-mix(in srgb, var(--band-color) 34%, transparent);
  color: var(--band-color);
  background: color-mix(in srgb, var(--band-color) 8%, transparent);
}

.delete-band:hover {
  border-color: color-mix(in srgb, var(--te-danger-soft-fg) 30%, transparent);
  color: var(--te-danger-soft-fg);
}

/* —— Precision controls —— */
.precision-controls {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 8px 12px 10px;
}

.precision-control {
  min-width: 0;
  display: grid;
  justify-items: center;
  gap: 3px;
  padding: 0 12px;
  border-right: 1px solid var(--eq-border-soft);
}

.precision-control:last-child {
  border-right: 0;
}

.precision-control.disabled {
  opacity: 0.34;
}

.control-label {
  color: var(--eq-text-subtle);
  font-size: 6px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.knob-shell {
  gap: 7px;
}

.knob-shell button {
  width: 17px;
  height: 17px;
  padding: 0;
  appearance: none;
  border: 1px solid transparent;
  border-radius: 50%;
  color: var(--eq-text-subtle);
  background: transparent;
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  line-height: 1;
}

.knob-shell button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--band-color) 30%, transparent);
  color: var(--band-color);
}

.knob-face {
  position: relative;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: conic-gradient(
    from -135deg,
    var(--band-color) 0deg calc(var(--knob-angle) + 135deg),
    var(--eq-border-soft) calc(var(--knob-angle) + 135deg) 270deg,
    transparent 270deg 360deg
  );
}

.knob-face::after {
  position: absolute;
  inset: 3px;
  content: '';
  border: 1px solid var(--eq-border-soft);
  border-radius: 50%;
  background: var(--eq-panel-raised);
}

.knob-face span {
  position: absolute;
  z-index: 1;
  top: 7px;
  left: 50%;
  width: 2px;
  height: 12px;
  transform: translateX(-50%) rotate(var(--knob-angle));
  transform-origin: 50% 12px;
  border-radius: 1px;
  background: var(--band-color);
}

.precision-readout {
  justify-content: center;
  gap: 3px;
}

.precision-readout input {
  width: 56px;
  padding: 0;
  appearance: textfield;
  border: 0;
  outline: none;
  color: var(--eq-text);
  background: transparent;
  font-family: var(--eq-mono);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 620;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.precision-readout input::-webkit-inner-spin-button,
.precision-readout input::-webkit-outer-spin-button {
  appearance: none;
}

.precision-readout small {
  color: var(--eq-text-subtle);
  font-size: 7px;
}

@keyframes statusPulse {
  to {
    opacity: 0.4;
  }
}

/* —— Dark tone: neutral charcoal, ink-white response, same accent —— */
:global(html[data-theme='dark'] .parametric-workspace) {
  --eq-surface: #181a1d;
  --eq-surface-soft: #1c1e22;
  --eq-panel: #202329;
  --eq-panel-raised: #22252b;
  --eq-text: #e8e9e6;
  --eq-text-muted: rgba(232, 233, 230, 0.6);
  --eq-text-subtle: rgba(232, 233, 230, 0.36);
  --eq-border: rgba(255, 255, 255, 0.13);
  --eq-border-soft: rgba(255, 255, 255, 0.07);
  --eq-grid: rgba(255, 255, 255, 0.05);
  --eq-grid-major: rgba(255, 255, 255, 0.09);
  --eq-zero-axis: rgba(255, 122, 31, 0.5);
  --eq-response: #eceee9;
  --eq-composite: #ff7a1f;
  --eq-accent: #ff7a1f;
  --eq-source: color-mix(in srgb, var(--te-info-500) 72%, var(--eq-text));
  --eq-target: color-mix(in srgb, var(--te-neutral-500) 68%, var(--eq-text));
  --eq-filter-combined: color-mix(in srgb, var(--te-warning-500) 76%, var(--eq-text));
  --eq-corrected: color-mix(in srgb, var(--te-success-500) 72%, var(--eq-text));
  --eq-spectrum: rgba(232, 233, 230, 0.4);
  --eq-control-bg: rgba(255, 255, 255, 0.045);
  --eq-tooltip-bg: #22252b;
  --eq-meter: #3cb179;
  --eq-handle-on-color: #ffffff;
}

/* —— pureWhite tone: cooler, pure-paper surfaces —— */
:global(html[data-theme='pureWhite'] .parametric-workspace) {
  --eq-surface: #f7f8fa;
  --eq-surface-soft: #ffffff;
  --eq-panel: #edf0f3;
  --eq-panel-raised: #ffffff;
  --eq-tooltip-bg: #ffffff;
}

:global(html[data-theme='pureWhite'] .parametric-graph-surface) {
  background: var(--eq-surface);
}

:global(html[data-theme='pureWhite'] .knob-face) {
  --eq-panel-raised: #ffffff;
}

:global(html[data-theme='pureWhite'] .output-meter) {
  --eq-control-bg: color-mix(in srgb, var(--eq-text) 3%, transparent);
}

:global(html[data-theme='pureWhite'] .analyzer-footer) {
  background: var(--eq-surface-soft);
}

:global(html[data-theme='pureWhite'] .floating-band-inspector) {
  background: var(--eq-surface-soft);
}

@media (max-width: 900px) {
  .stage-brand small {
    display: none;
  }

  .output-meter {
    width: 40px;
  }
}

@media (max-width: 620px) {
  .parametric-graph-surface {
    height: 400px;
    min-height: 400px;
  }

  .output-meter {
    display: none;
  }

  .analyzer-footer em {
    display: none;
  }

  .inspector-topbar {
    grid-template-columns: 1fr auto;
  }

  .filter-strip {
    grid-column: 1 / -1;
    grid-row: 2;
    padding-bottom: 2px;
  }

  .precision-controls {
    padding-inline: 4px;
  }

  .precision-control {
    padding-inline: 5px;
  }

  .knob-shell {
    gap: 3px;
  }

  .knob-face {
    width: 32px;
    height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .parametric-band-handle,
  .individual-band-line,
  .meter-channel i,
  .status-dot {
    transition: none;
    animation: none;
  }
}
</style>
