import type { Ref } from 'vue'

export const VISUALIZATION_UPDATE_INTERVAL_MS = 60 as const

export type NativeVisualizationData = Awaited<
  ReturnType<Window['api']['audioEngine']['getVisualizationData']>
>

/**
 * Only the fields the player bar / equalizer actually render. The full
 * visualizer panel issues its own request with its own point counts, so the
 * store poll carries no oscilloscope or spectrogram payload at all.
 */
export const visualizationOptions = {
  spectrumPoints: 64,
  waveformPoints: 48,
  spectrogramFrames: 0,
  oscilloscopePoints: 0
} as const

export function createInactiveVisualizationData(): NativeVisualizationData {
  return {
    spectrum: Array.from({ length: visualizationOptions.spectrumPoints }, () => 0),
    waveform: Array.from({ length: visualizationOptions.waveformPoints }, () => 0),
    oscilloscope: Array.from({ length: visualizationOptions.oscilloscopePoints }, () => 0),
    peakDb: -120,
    rmsDb: -120,
    lufsMomentary: null,
    spectrogram: [],
    sampleRate: 0,
    maxFrequency: 20000,
    active: false,
    tapStatus: 'stopped',
    reason: ''
  }
}

export interface VisualizationPollingOptions {
  data: Ref<NativeVisualizationData>
  active: Ref<boolean>
  /** Mounted components that read `data`; the poll only runs while this is > 0. */
  consumers: Ref<number>
  setInterval?: (callback: () => void, delayMs: number) => number
  clearInterval?: (handle: number) => void
  fetch?: () => Promise<NativeVisualizationData>
}

export function createVisualizationPolling(options: VisualizationPollingOptions) {
  const schedule =
    options.setInterval ?? ((callback, delayMs) => window.setInterval(callback, delayMs))
  const cancel = options.clearInterval ?? ((handle) => window.clearInterval(handle))
  const fetchData =
    options.fetch ?? (() => window.api.audioEngine.getVisualizationData(visualizationOptions))
  let timer: number | null = null
  let requestInFlight = false
  let pollingGeneration = 0

  async function refresh(): Promise<void> {
    if (requestInFlight) return
    const generation = pollingGeneration
    requestInFlight = true
    try {
      const next = await fetchData()
      if (generation !== pollingGeneration) return
      options.data.value = next
    } catch {
      if (generation !== pollingGeneration) return
      options.data.value = createInactiveVisualizationData()
    } finally {
      requestInFlight = false
    }
  }

  function stop(clearData = false): void {
    pollingGeneration += 1
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    if (clearData) options.data.value = createInactiveVisualizationData()
  }

  function start(): void {
    if (options.active.value) return
    if (options.consumers.value <= 0) return
    if (timer !== null) return
    void refresh()
    timer = schedule(() => void refresh(), VISUALIZATION_UPDATE_INTERVAL_MS)
  }

  /**
   * Consumer handle for components that render `data`. Returns the release
   * function; callers pair it with onMounted / onBeforeUnmount so a hidden
   * player bar or a closed equalizer never keeps the IPC poll alive.
   */
  function acquireConsumer(): () => void {
    let released = false
    options.consumers.value += 1
    return () => {
      if (released) return
      released = true
      options.consumers.value = Math.max(0, options.consumers.value - 1)
    }
  }

  function isPolling(): boolean {
    return timer !== null
  }

  return {
    refresh,
    stop,
    start,
    acquireConsumer,
    isPolling
  }
}
