import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { VisualizationData, VisualizationOptions } from '../../../shared/audioEngineTypes.ts'

export const VISUALIZER_BAR_COUNT = 6
export const VISUALIZER_POLL_INTERVAL_MS = 50
export const VISUALIZER_IDLE_POLL_INTERVAL_MS = 250

const VISUALIZER_OPTIONS: VisualizationOptions = {
  // Keep enough FFT bins for the logarithmic six-band reduction to preserve
  // bass, midrange, and treble independently. The main process returns only
  // the precomputed bars to this renderer.
  spectrumPoints: 256,
  waveformPoints: 16,
  spectrogramFrames: 0,
  oscilloscopePoints: 0,
  visualizerBarCount: VISUALIZER_BAR_COUNT
}

type VisualizerSampler = (options: VisualizationOptions) => Promise<VisualizationData>

function emptyBars(): number[] {
  return Array.from({ length: VISUALIZER_BAR_COUNT }, () => 0)
}

/**
 * Poll the native audio tap for the island's bars. Polling only runs while the
 * visualizer is enabled and the window is visible, and drops to an idle rate
 * whenever the tap reports no live audio.
 */
export function useIslandVisualizer(enabled: Ref<boolean>, sample: VisualizerSampler) {
  const bars = ref<number[]>(emptyBars())
  const energy = computed(() => {
    const meanSquare =
      bars.value.reduce((total, value) => total + value * value, 0) / bars.value.length
    return Math.min(1, Math.sqrt(meanSquare))
  })

  let timer: number | null = null
  let requestInFlight = false
  let generation = 0
  let active = false

  function setBars(values: readonly number[] = []): void {
    bars.value = Array.from({ length: VISUALIZER_BAR_COUNT }, (_, index) => {
      const value = values[index]
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
    })
  }

  async function refresh(): Promise<boolean> {
    if (requestInFlight) return active
    const requestGeneration = generation
    requestInFlight = true
    try {
      const frame = await sample(VISUALIZER_OPTIONS)
      if (requestGeneration !== generation) return false
      // synthetic-fallback is intentionally never rendered as live audio.
      active = frame.active && frame.tapStatus === 'active'
      setBars(active ? frame.visualizerBars : [])
      return active
    } catch {
      if (requestGeneration === generation) {
        active = false
        setBars()
      }
      return false
    } finally {
      requestInFlight = false
    }
  }

  function schedule(delayMs = 0): void {
    if (timer !== null) return
    const scheduledGeneration = generation
    timer = window.setTimeout(async () => {
      timer = null
      const live = await refresh()
      if (scheduledGeneration === generation) {
        schedule(live ? VISUALIZER_POLL_INTERVAL_MS : VISUALIZER_IDLE_POLL_INTERVAL_MS)
      }
    }, delayMs)
  }

  function stop(): void {
    generation += 1
    active = false
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    setBars()
  }

  function sync(): void {
    if (enabled.value && document.visibilityState !== 'hidden') schedule()
    else stop()
  }

  /** Map a native 0..1 FFT amplitude onto a GPU-scaled bar; never invents motion. */
  function barStyle(index: number): Record<'--visualizer-level' | '--visualizer-opacity', string> {
    const level = Math.pow(bars.value[index] ?? 0, 0.58)
    return {
      '--visualizer-level': level.toFixed(3),
      '--visualizer-opacity': (0.24 + level * 0.76).toFixed(3)
    }
  }

  watch(enabled, sync)
  onMounted(() => {
    document.addEventListener('visibilitychange', sync)
    sync()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', sync)
    stop()
  })

  return { energy, barStyle }
}
