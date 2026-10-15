<script setup lang="ts">
/** Optical refraction is reserved for the floating playback controls. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  DEFAULT_LIQUID_GLASS_LIGHT,
  LIQUID_GLASS_PLAYBAR_FILTER_ID,
  LIQUID_GLASS_PLAYBAR_SELECTOR,
  LIQUID_GLASS_TUNING_CHANGED_EVENT,
  resolveAberrationBlur,
  resolveChannelScales
} from '../../../shared/liquidGlass.ts'
import {
  displacementScaleForRadius,
  getDisplacementMapUrl,
  measureSurfaceGeometry,
  NOMINAL_PLAYBAR_GEOMETRY,
  type DisplacementGeometry
} from '../utils/liquidGlassDisplacement.ts'
import { glassRasterDensity, observeDevicePixelRatio } from '../utils/glassRasterDensity.ts'
import { createFrameCoalescer } from '../utils/liquidGlassPointer.ts'

const props = defineProps<{
  active: boolean
  targetDocument?: Document
  theme?: typeof DEFAULT_LIQUID_GLASS_LIGHT
}>()
const surfaceDocument = (): Document => props.targetDocument ?? document
const playbarMapUrl = ref('')
const playbarGeometry = ref<DisplacementGeometry>(NOMINAL_PLAYBAR_GEOMETRY)
const displacementScale = ref(DEFAULT_LIQUID_GLASS_LIGHT.displacementScale)
const aberrationIntensity = ref(DEFAULT_LIQUID_GLASS_LIGHT.aberrationIntensity)
const channelScales = computed(() =>
  resolveChannelScales(
    displacementScaleForRadius(playbarGeometry.value.radius, displacementScale.value / 100),
    aberrationIntensity.value
  )
)
const aberrationBlur = computed(() => resolveAberrationBlur(aberrationIntensity.value))
let geometryObserver: ResizeObserver | null = null
let mountObserver: MutationObserver | null = null
let target: Element | null = null
let stopObservingPixelRatio: (() => void) | null = null

function syncFilterInputs(): void {
  if (!props.active) return
  if (props.theme) {
    displacementScale.value = props.theme.displacementScale
    aberrationIntensity.value = props.theme.aberrationIntensity
    return
  }
  const doc = surfaceDocument()
  const style = doc.defaultView!.getComputedStyle(doc.documentElement)
  const number = (name: string, fallback: number): number => {
    const value = Number.parseFloat(style.getPropertyValue(name))
    return Number.isFinite(value) ? value : fallback
  }
  displacementScale.value = number(
    '--te-lg-displacement',
    DEFAULT_LIQUID_GLASS_LIGHT.displacementScale
  )
  aberrationIntensity.value = number(
    '--te-lg-aberration',
    DEFAULT_LIQUID_GLASS_LIGHT.aberrationIntensity
  )
}

function ensureMaps(): void {
  if (!props.active) return
  const surface = surfaceDocument().querySelector(LIQUID_GLASS_PLAYBAR_SELECTOR)
  if (surface !== target) {
    if (target) geometryObserver?.unobserve(target)
    target = surface
    if (target) geometryObserver?.observe(target)
  }
  const geometry = target && measureSurfaceGeometry(target)
  if (!geometry) {
    playbarMapUrl.value = ''
    return
  }
  playbarGeometry.value = geometry
  playbarMapUrl.value = getDisplacementMapUrl(geometry, glassRasterDensity(window.devicePixelRatio))
}

// Resize storms share one trailing update; raster generation is also memoized.
const geometryFrames = createFrameCoalescer<void>(ensureMaps, { minIntervalMs: 120 })
function affectsPlaybar(node: Node): boolean {
  return (
    node instanceof Element &&
    (node === target || node.matches('.player-bar') || Boolean(node.querySelector('.player-bar')))
  )
}
function clearObservers(): void {
  geometryObserver?.disconnect()
  geometryObserver = null
  mountObserver?.disconnect()
  mountObserver = null
  target = null
  geometryFrames.cancel()
  stopObservingPixelRatio?.()
  stopObservingPixelRatio = null
}
function syncActive(): void {
  clearObservers()
  if (!props.active) {
    playbarMapUrl.value = ''
    return
  }
  geometryObserver = new ResizeObserver(() => geometryFrames.schedule(undefined))
  // Observe only the player host, so unrelated list/lyric mutations do no work.
  mountObserver = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === 'attributes'
          ? record.target instanceof Element && record.target.matches('.player-bar')
          : [...record.addedNodes, ...record.removedNodes].some(affectsPlaybar)
      )
    ) {
      geometryFrames.schedule(undefined)
    }
  })
  const doc = surfaceDocument()
  mountObserver.observe(doc.querySelector('.app-shell-player') ?? doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  })
  stopObservingPixelRatio = observeDevicePixelRatio(
    () => geometryFrames.schedule(undefined),
    window
  )
  syncFilterInputs()
  ensureMaps()
}
function onTuningChanged(): void {
  syncFilterInputs()
  if (props.active) geometryFrames.schedule(undefined)
}
onMounted(() => {
  syncActive()
  window.addEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, onTuningChanged)
})
onBeforeUnmount(() => {
  clearObservers()
  window.removeEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, onTuningChanged)
})
watch(() => props.active, syncActive, { flush: 'post' })
watch(() => props.targetDocument, syncActive, { flush: 'post' })
watch(() => props.theme, onTuningChanged, { deep: true, flush: 'post' })
</script>

<template>
  <svg v-if="props.active" class="liquid-glass-defs" aria-hidden="true" focusable="false">
    <defs>
      <filter
        :id="LIQUID_GLASS_PLAYBAR_FILTER_ID"
        x="-35%"
        y="-35%"
        width="170%"
        height="170%"
        color-interpolation-filters="sRGB"
      >
        <feImage
          x="0"
          y="0"
          width="100%"
          height="100%"
          result="MAP"
          preserveAspectRatio="none"
          :href="playbarMapUrl"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.red"
          xChannelSelector="R"
          yChannelSelector="B"
          result="RED_DISPLACED"
        />
        <feColorMatrix
          in="RED_DISPLACED"
          type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="RED_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.green"
          xChannelSelector="R"
          yChannelSelector="B"
          result="GREEN_DISPLACED"
        />
        <feColorMatrix
          in="GREEN_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="GREEN_CHANNEL"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="MAP"
          :scale="channelScales.blue"
          xChannelSelector="R"
          yChannelSelector="B"
          result="BLUE_DISPLACED"
        />
        <feColorMatrix
          in="BLUE_DISPLACED"
          type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0"
          result="BLUE_CHANNEL"
        />
        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
        <feGaussianBlur in="RGB_COMBINED" :stdDeviation="aberrationBlur" result="REFRACTED" />

        <!-- Playback controls use transmission only, without edge reflections. -->
      </filter>
    </defs>
  </svg>
</template>

<style scoped>
/* Definitions only — must occupy no space and never intercept input. */
.liquid-glass-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>
