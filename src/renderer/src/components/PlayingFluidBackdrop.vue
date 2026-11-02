<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePlayerStore } from '../stores/usePlayerStore'
import { AppleMusicFluidRenderer } from '../utils/appleMusicFluidRenderer.ts'
import { extractLowFrequencyEnergy, FluidPhaseIntegrator } from '../utils/fluidAudioReactivity.ts'
import { createFallbackFluidCover, masterFluidCover } from '../utils/fluidCoverMastering.ts'

const props = withDefaults(
  defineProps<{
    coverUrl?: string | null
    fallbackColor?: string
    playing?: boolean
    motionMode?: 'full' | 'reduced' | 'off'
    speed?: number
    audioReactive?: boolean
    preview?: boolean
  }>(),
  {
    coverUrl: null,
    fallbackColor: '#3567b5',
    playing: false,
    motionMode: 'full',
    speed: 1,
    audioReactive: true,
    preview: false
  }
)

type PlayerStoreHandle = ReturnType<typeof usePlayerStore>
let playerStore: PlayerStoreHandle | null = null
try {
  playerStore = usePlayerStore()
} catch {
  playerStore = null
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const tone = ref<'dark' | 'light'>('dark')
const domMotion = ref<'full' | 'reduced' | 'off'>('full')
const tempoMultiplier = ref(1)
const docHidden = ref(typeof document !== 'undefined' ? document.hidden : false)

const effectiveMotion = computed<'full' | 'reduced' | 'off'>(() => {
  if (props.motionMode === 'off' || domMotion.value === 'off') return 'off'
  if (props.motionMode === 'reduced' || domMotion.value === 'reduced') return 'reduced'
  return 'full'
})

const shouldAnimate = computed(
  () => !props.preview && effectiveMotion.value === 'full' && !docHidden.value
)

const shouldAcquireAudio = computed(
  () =>
    shouldAnimate.value &&
    props.playing &&
    props.audioReactive !== false &&
    playerStore !== null &&
    typeof playerStore.acquireVisualizationConsumer === 'function'
)

let renderer: AppleMusicFluidRenderer | null = null
const phaseIntegrator = new FluidPhaseIntegrator(0.65, props.playing)
let resizeObserver: ResizeObserver | null = null
let htmlObserver: MutationObserver | null = null
let releaseVisualization: (() => void) | null = null
let coverAbort: AbortController | null = null
let rafId: number | null = null
let lastStepMs = 0
let lastDrawMs = 0
let hasFirstCover = false
let lastAppliedCoverKey = ''
let disposed = false

function readDocumentEnvironment(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const rawTheme = root.dataset.theme
  tone.value = rawTheme === 'light' || rawTheme === 'pureWhite' ? 'light' : 'dark'

  const rawMotion = root.dataset.teMotion
  domMotion.value = rawMotion === 'off' ? 'off' : rawMotion === 'reduced' ? 'reduced' : 'full'

  const rawTempo = getComputedStyle(root).getPropertyValue('--te-playback-fluid-tempo').trim()
  if (rawTempo) {
    const parsed = Number.parseFloat(rawTempo)
    if (Number.isFinite(parsed) && parsed > 0) {
      const seconds = rawTempo.endsWith('ms') ? parsed / 1000 : parsed
      tempoMultiplier.value = Math.min(3, Math.max(0.35, 18 / seconds))
      return
    }
  }
  tempoMultiplier.value = 1
}

function readLowFrequencyEnergy(): number {
  if (!shouldAcquireAudio.value || !playerStore?.visualizationData?.value) return 0
  const viz = playerStore.visualizationData.value
  return extractLowFrequencyEnergy(viz.spectrum, viz.sampleRate)
}

function renderNow(nowMs = performance.now()): void {
  if (!renderer || disposed) return
  const state = phaseIntegrator.getState()
  try {
    renderer.render(
      {
        phase: state.phase,
        swell: state.swell,
        tone: tone.value
      },
      nowMs
    )
  } catch (err) {
    console.error('[PlayingFluidBackdrop] render error:', err)
  }
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  lastStepMs = 0
  lastDrawMs = 0
}

function tick(nowMs: number): void {
  rafId = null
  if (disposed || !renderer || !shouldAnimate.value) return

  const dtSeconds = lastStepMs > 0 ? (nowMs - lastStepMs) / 1000 : 1 / 60
  lastStepMs = nowMs

  const state = phaseIntegrator.step({
    dtSeconds,
    playing: Boolean(props.playing),
    speedMultiplier: props.speed ?? 1,
    tempoMultiplier: tempoMultiplier.value,
    lowFreqEnergy: readLowFrequencyEnergy(),
    audioReactive: props.audioReactive !== false
  })

  const frameBudgetMs =
    props.playing || renderer.isTransitioning() || state.playFactor > 0.24 ? 1000 / 45 : 1000 / 24

  if (lastDrawMs === 0 || nowMs - lastDrawMs >= frameBudgetMs) {
    lastDrawMs = nowMs
    renderer.render(
      {
        phase: state.phase,
        swell: state.swell,
        tone: tone.value
      },
      nowMs
    )
  }

  rafId = requestAnimationFrame(tick)
}

function syncLoop(): void {
  if (disposed || !renderer) return
  if (shouldAnimate.value) {
    if (rafId === null) {
      lastStepMs = performance.now()
      lastDrawMs = 0
      renderNow(lastStepMs)
      rafId = requestAnimationFrame(tick)
    }
  } else {
    stopLoop()
    renderNow()
  }
}

function syncCanvasSize(): void {
  const canvas = canvasEl.value
  if (!canvas || !renderer) return
  const rect = canvas.getBoundingClientRect()
  const width = rect.width > 0 ? rect.width : canvas.clientWidth || 320
  const height = rect.height > 0 ? rect.height : canvas.clientHeight || 240
  renderer.resize(width, height, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  renderNow()
}

async function applyCover(): Promise<void> {
  const cleanUrl = (props.coverUrl ?? '').trim()
  const key = cleanUrl
    ? `${cleanUrl}::${tone.value}`
    : `fallback::${props.fallbackColor}::${tone.value}`
  if (key === lastAppliedCoverKey && hasFirstCover) return
  lastAppliedCoverKey = key

  coverAbort?.abort()
  const controller = new AbortController()
  coverAbort = controller

  const mastered = await masterFluidCover(cleanUrl || null, {
    tone: tone.value,
    fallbackAccentHex: props.fallbackColor,
    signal: controller.signal
  })
  if (disposed || controller.signal.aborted || !renderer) return

  const immediate = !hasFirstCover || props.preview || effectiveMotion.value !== 'full'
  hasFirstCover = true
  renderer.setCover(mastered, immediate)
  renderNow()
  syncLoop()
}

function onVisibilityChange(): void {
  docHidden.value = document.hidden
}

watch(
  shouldAcquireAudio,
  (active) => {
    releaseVisualization?.()
    releaseVisualization = null
    if (active && playerStore) {
      releaseVisualization = playerStore.acquireVisualizationConsumer({
        spectrumPoints: 64,
        waveformPoints: 0
      })
    }
  },
  { immediate: true }
)

watch([() => props.coverUrl, () => props.fallbackColor, tone], () => {
  void applyCover()
})

watch([shouldAnimate, () => props.playing, () => props.speed, tone], () => {
  syncLoop()
})

onMounted(() => {
  const canvas = canvasEl.value
  if (!canvas) return

  readDocumentEnvironment()
  renderer = new AppleMusicFluidRenderer(canvas, {
    maxRenderScale: props.preview ? 0.95 : 1.35,
    transitionDurationMs: 1100
  })
  renderer.setCover(createFallbackFluidCover(props.fallbackColor, tone.value), true)
  syncCanvasSize()

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      syncCanvasSize()
    })
    resizeObserver.observe(canvas)
  }

  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    htmlObserver = new MutationObserver(() => {
      readDocumentEnvironment()
      renderNow()
      syncLoop()
    })
    htmlObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-te-motion', 'style']
    })
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  void applyCover()
  syncLoop()
})

onBeforeUnmount(() => {
  disposed = true
  stopLoop()
  coverAbort?.abort()
  coverAbort = null
  releaseVisualization?.()
  releaseVisualization = null
  resizeObserver?.disconnect()
  resizeObserver = null
  htmlObserver?.disconnect()
  htmlObserver = null
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <canvas ref="canvasEl" class="playing-fluid-canvas" aria-hidden="true" />
</template>

<style scoped>
.playing-fluid-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  contain: strict;
}
</style>
