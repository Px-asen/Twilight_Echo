import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./ParametricEqWorkspace.vue', import.meta.url), 'utf8')
const inspector = readFileSync(new URL('./ParametricEqBandInspector.vue', import.meta.url), 'utf8')
const knob = readFileSync(new URL('./EqParameterKnob.vue', import.meta.url), 'utf8')

test('graph keeps direct manipulation and one coordinate surface for paths and nodes', () => {
  assert.match(source, /ref="surfaceRef"/)
  assert.match(source, /@click\.self="addBand"/)
  assert.match(source, /setPointerCapture\(event\.pointerId\)/)
  assert.match(source, /@pointermove\.prevent\.stop="updatePointer"/)
  assert.match(source, /@wheel\.prevent\.stop="adjustQ\(index, \$event\)"/)
  assert.match(source, /frequencyToPercent\(band\.frequency\)/)
  assert.match(source, /gainToPercent\(displayBandGain\(band\)\)/)
  assert.match(source, /wheelCommit\.schedule\(\)/)
})

test('precision controls use actual pointer gestures, bounded numeric input and gain semantics', () => {
  assert.match(inspector, /field === 'gain' && !filterUsesGain\(band\.filterType\)/)
  assert.match(knob, /role="slider"/)
  assert.match(knob, /:aria-valuenow="displayedValue"/)
  assert.match(knob, /@pointercancel\.stop="endDrag"/)
  assert.match(knob, /@lostpointercapture="endDrag"/)
  assert.match(knob, /@change="updateNumeric"/)
  assert.match(knob, /Number\.isFinite\(input\.valueAsNumber\)/)
  assert.match(knob, /createEqKnobGesture/)
  assert.match(knob, /createEqWheelCommit/)
})

test('closing the inspector is separate from deleting a band, and finishes pending edits', () => {
  assert.match(inspector, /aria-label="收起频段面板"/)
  assert.match(inspector, /aria-label="删除所选频段"/)
  assert.match(inspector, /if \(action === 'close'\) emit\('close'\)/)
  assert.match(inspector, /emit\('delete', props\.index\)/)
  assert.match(inspector, /knob\.finishInteraction\(\)/)
  assert.match(source, /@close="closeInspector"/)
  assert.match(source, /:key="selectedIndex"/)
})

test('headphone view retains five independent categories and its non-measured semantics', () => {
  for (const key of ['source', 'target', 'individual', 'combined', 'corrected']) {
    assert.match(source, new RegExp(`key: '${key}'`))
  }
  assert.match(source, /:aria-pressed="control\.visible"/)
  assert.match(source, /emit\('toggle-headphone-curve', control\.key\)/)
  for (const name of [
    'measured-source-line',
    'target-response-line',
    'individual-band-line headphone-filter',
    'combined-filter-line',
    'corrected-acoustic-line'
  ]) {
    assert.ok(source.includes(`class="${name}"`))
  }
  assert.match(source, /R\(f\) = M\(f\) \+ H\(f\)/)
  assert.match(source, /数字前级不计入声学预计/)
})

test('bands remain individually colored and bypassed bands are excluded from filled response areas', () => {
  assert.match(source, /class="individual-band-fill"/)
  assert.match(source, /v-if="!item\.bypassed"/)
  assert.match(source, /class="composite-response-line"/)
  assert.match(source, /stroke: var\(--eq-response\)/)
  assert.match(source, /stroke-dasharray:/)
  assert.match(source, /eq-spectrum-\$\{useId\(\)\}/)
})

test('layout follows the theme and uses measured geometry with a compact dock', () => {
  assert.match(source, /html\[data-theme='dark'\] \.parametric-workspace/)
  assert.match(source, /--eq-color-scheme: light/)
  assert.match(source, /--eq-color-scheme: dark/)
  assert.match(source, /root\.clientWidth < 800/)
  assert.match(source, /placeEqInspector/)
  assert.match(source, /placeEqTooltip/)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /prefers-reduced-motion: reduce/)
  assert.match(source, /\.compact \.floating-band-inspector/)
})

test('native meter values are labeled Peak and RMS without simulated stereo offsets', () => {
  assert.match(source, /aria-label="Peak 峰值"/)
  assert.match(source, /aria-label="RMS 均方根"/)
  assert.match(source, /meterLevel\(meterPeakDb\)/)
  assert.match(source, /meterLevel\(meterRmsDb\)/)
  assert.doesNotMatch(source, /aria-label="[左右]声道"/)
  assert.match(source, /role="status"/)
  assert.match(source, /role="alert"/)
})
