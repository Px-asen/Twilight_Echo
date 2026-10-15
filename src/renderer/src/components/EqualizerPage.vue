<script setup lang="ts">
import type { EqDisplayRange } from '@renderer/utils/eqViewport'
import { mergeEqualizerPatch } from '@renderer/utils/equalizerSettingsPatch'
import { useEqualizerHistory } from '@renderer/composables/useEqualizerHistory'
import type { EqSnapshot } from '@renderer/composables/useEqualizerHistory'
import { groupEqBandPatches } from '@renderer/utils/parametricEqSelection'
import type { EqBandPatch } from '@renderer/utils/parametricEqSelection'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useBackHandler } from '@renderer/app/useBackStack.ts'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import EqHistoryControls from '@renderer/components/equalizer/EqHistoryControls.vue'
import ParametricEqWorkspace from '@renderer/components/equalizer/ParametricEqWorkspace.vue'
import OpraEqPanel from '@renderer/components/equalizer/OpraEqPanel.vue'
import FrequencyResponseChart from '@renderer/components/equalizer/FrequencyResponseChart.vue'
import FrequencyResponseToolbar from '@renderer/components/equalizer/FrequencyResponseToolbar.vue'
import GraphicEqPanel from '@renderer/components/equalizer/GraphicEqPanel.vue'
import {
  EQ_RESPONSE_DEFAULT_SAMPLE_RATE,
  computeAutoPreampDb,
  computeBandResponse,
  computeCompositeResponse,
  computeEstimatedSourceDeviation,
  isBandActive
} from '@renderer/utils/eqResponse'
import {
  GRAPH_MAX_FREQUENCY,
  GRAPH_MIN_FREQUENCY,
  builtInEqPresets,
  clampNumber,
  cloneBands,
  defaultEqBands,
  filterTypes,
  gainToY,
  normalizeAudioProcessing,
  patchBand,
  responseToPath,
  tabs
} from '@renderer/utils/equalizerPageLogic'
import { computeFrequencyResponseComparison } from '../../../shared/frequencyResponse.ts'
import type { ImportedFrequencyResponse } from '../../../shared/frequencyResponse.ts'
import {
  createParametricBand,
  projectSpectrumLevels
} from '@renderer/utils/parametricEqInteraction'
import type {
  AppSettings,
  AudioEqPreset,
  AudioProcessingSettings,
  EqualizerBand,
  EqualizerFilterType,
  EqMode,
  HeadphoneCompensationSettings
} from '@renderer/types/settings'
import type { DspSceneState } from '../../../shared/dspGraph.ts'

type EqualizerTab = EqMode
type ResponseView = 'dsp' | 'headphone'
type HeadphoneCurveKey = 'source' | 'target' | 'individual' | 'combined' | 'corrected'
type EqApplyFeedback = 'idle' | 'editing' | 'applying' | 'applied' | 'failed'
type OpraProfile = Awaited<ReturnType<typeof window.api.opra.search>>[number]
type OpraCatalogStatus = Awaited<ReturnType<typeof window.api.opra.getStatus>>

const props = withDefaults(defineProps<{ embedded?: boolean; navigationLocked?: boolean }>(), {
  embedded: false,
  navigationLocked: false
})
const audioOutputDspStore = useAudioOutputDspStore()
const editorRoot = ref<HTMLElement | null>(null)
const playerStore = usePlayerStore()
const { audioProcessing, outputInfo, audioEngineReady } = storeToRefs(audioOutputDspStore)
const { visualizationData, isPlaying, acquireVisualizationConsumer } = playerStore
const { setAudioProcessing } = audioOutputDspStore
// The spectrum overlay and level meters read visualizationData while this page
// is open; the store poll only runs while at least one consumer holds a handle.
let releaseVisualizationConsumer: (() => void) | null = null
let visualizationConsumerPoints = 0

const autoPreampStorageKey = 'twilight-echo:eq-auto-preamp:v1'
const manualPreampStorageKey = 'twilight-echo:eq-manual-preamp:v1'
let manualPreampBeforeAuto: number | null = null

const activeTab = ref<EqualizerTab>('graphic')
const autoPreampEnabled = ref(false)
const appSettings = ref<AppSettings | null>(null)
const presetName = ref('')
const saving = ref(false)
const presetMenuOpen = ref(false)
const filterMenuOpen = ref(false)
const selectedBandIndex = ref(0)
const selectedBandIndices = shallowRef<number[]>([0])
const eqApplyFeedback = ref<EqApplyFeedback>('idle')
const eqApplyError = ref('')
const clipboardBusy = ref(false)
const clipboardMessage = ref('')
const clipboardFailed = ref(false)
let equalizerMounted = true
const parametricWorkspaceRef = ref<InstanceType<typeof ParametricEqWorkspace> | null>(null)
const spectrumVisible = ref(true)
const spectrumFrozen = ref(false)
const spectrumLevels = shallowRef<Float32Array | null>(null)
const opraQuery = ref('')
const opraResults = ref<OpraProfile[]>([])
const opraStatus = ref<OpraCatalogStatus | null>(null)
const opraSearching = ref(false)
const opraRefreshing = ref(false)
const opraApplyingEqId = ref('')
const opraSaving = ref(false)
const opraError = ref('')
let pendingBandFrame = 0
let pendingBandWindow: Window | null = null
const pendingBandPatches = new Map<number, Partial<EqualizerBand>>()
let pendingPreamp: number | null = null
let commitChain: Promise<void> = Promise.resolve()
let applyFeedbackTimer: number | null = null
let spectrumPollingMounted = false
const eqHistory = useEqualizerHistory(audioProcessing.value, applyEqualizerSnapshot)
const { activeSlot, busy: historyBusy, canUndo, canRedo } = eqHistory
const historyLoading = ref(true)

const userPresets = computed(() => appSettings.value?.audioEqPresets ?? [])
const headphoneCompensation = computed<HeadphoneCompensationSettings>(
  () =>
    appSettings.value?.headphoneCompensation ?? {
      enabled: false,
      productId: '',
      productName: '',
      vendorName: '',
      eqId: '',
      author: '',
      details: '',
      link: '',
      preampDb: 0,
      bands: []
    }
)
const opraCompensationEnabled = computed(
  () => headphoneCompensation.value.enabled && headphoneCompensation.value.bands.length > 0
)

// The engine stacks OPRA compensation on top of the manual EQ (see
// buildEffectiveAudioProcessingSettings). Mirror that here so the plotted
// curve keeps reflecting OPRA even after the manual EQ is reset.
const displayEqMode = computed<EqMode>(() =>
  opraCompensationEnabled.value ? 'parametric' : audioProcessing.value.eqMode
)
const displayEqPreamp = computed(() =>
  opraCompensationEnabled.value
    ? audioProcessing.value.eqPreamp + headphoneCompensation.value.preampDb
    : audioProcessing.value.eqPreamp
)
const displayEqBands = computed(() =>
  opraCompensationEnabled.value
    ? [
        ...cloneBands(headphoneCompensation.value.bands),
        ...cloneBands(audioProcessing.value.eqBands)
      ]
    : audioProcessing.value.eqBands
)
const selectedBand = computed(() => audioProcessing.value.eqBands[selectedBandIndex.value] ?? null)
const eqApplyStatusText = computed(() => {
  if (eqApplyFeedback.value === 'editing') return '正在编辑'
  if (eqApplyFeedback.value === 'applying') return '正在同步 DSP'
  if (eqApplyFeedback.value === 'applied') return 'DSP 已同步'
  if (eqApplyFeedback.value === 'failed') return 'DSP 同步失败'
  if (!audioProcessing.value.eqEnabled) return '均衡器已旁路'
  return audioEngineReady.value ? 'DSP 就绪' : '音频引擎未就绪'
})

const responseView = ref<ResponseView>('dsp')
const displayRangeDb = ref<EqDisplayRange>(12)
function plotResponse(response: { frequency: number; db: number }[]): string {
  return responseToPath(
    response,
    activeTab.value === 'parametric' ? displayRangeDb.value : 18,
    activeTab.value !== 'parametric'
  )
}
const importedFrequencyResponse = ref<ImportedFrequencyResponse | null>(null)
const frequencyResponseImporting = ref(false)
const frequencyResponseError = ref('')
const showManualResponse = ref(true)
const showOpraResponse = ref(true)
const showOpraEstimatedDeviation = ref(true)
const showMeasuredSource = ref(true)
const showTargetResponse = ref(true)
const showIndividualFilters = ref(true)
const showCombinedFilter = ref(true)
const showCorrectedResponse = ref(true)

// Display reference rate: use the actual device output rate when known so the
// plotted curve matches the coefficients the engine builds for that rate.
const responseSampleRate = computed(() => {
  const info = outputInfo.value
  const rate = info?.actualSampleRate || info?.outputSampleRate || 0
  return rate > 0 ? rate : EQ_RESPONSE_DEFAULT_SAMPLE_RATE
})

const responseOptions = computed(() => ({
  sampleRate: responseSampleRate.value,
  pointCount: 257,
  minFrequency: GRAPH_MIN_FREQUENCY,
  maxFrequency: GRAPH_MAX_FREQUENCY
}))

// Exact RBJ biquad responses (same math as ParametricEqProcessor.cpp). Keep
// each processing contribution separate while retaining the effective total.
const manualResponsePath = computed(() =>
  plotResponse(
    computeCompositeResponse(audioProcessing.value.eqBands, audioProcessing.value.eqPreamp, {
      ...responseOptions.value,
      mode: audioProcessing.value.eqMode
    })
  )
)
const opraResponsePath = computed(() =>
  opraCompensationEnabled.value
    ? plotResponse(
        computeCompositeResponse(
          headphoneCompensation.value.bands,
          headphoneCompensation.value.preampDb,
          { ...responseOptions.value, mode: 'parametric' }
        )
      )
    : ''
)
const opraEstimatedDeviationPath = computed(() =>
  opraCompensationEnabled.value
    ? plotResponse(
        computeEstimatedSourceDeviation(headphoneCompensation.value.bands, responseOptions.value)
      )
    : ''
)
const effectiveDspResponse = computed(() =>
  computeCompositeResponse(displayEqBands.value, displayEqPreamp.value, {
    ...responseOptions.value,
    mode: displayEqMode.value
  })
)
const responsePath = computed(() => plotResponse(effectiveDspResponse.value))
const acousticDspResponse = computed(() =>
  computeCompositeResponse(displayEqBands.value, 0, {
    ...responseOptions.value,
    mode: displayEqMode.value
  })
)
// The imported source and target remain absolute curves. The filter response is
// an acoustic estimate only: digital preamp is excluded before adding H(f) to M(f).
const frequencyResponseComparison = computed(() => {
  const imported = importedFrequencyResponse.value
  if (!imported) return null
  return computeFrequencyResponseComparison(
    imported,
    acousticDspResponse.value,
    acousticDspResponse.value.map((point) => point.frequency)
  )
})
const measuredSourcePath = computed(() =>
  frequencyResponseComparison.value ? plotResponse(frequencyResponseComparison.value.source) : ''
)
const targetResponsePath = computed(() =>
  frequencyResponseComparison.value ? plotResponse(frequencyResponseComparison.value.target) : ''
)
const combinedFilterPath = computed(() =>
  frequencyResponseComparison.value
    ? plotResponse(frequencyResponseComparison.value.combinedFilter)
    : ''
)
const correctedAcousticPath = computed(() =>
  frequencyResponseComparison.value ? plotResponse(frequencyResponseComparison.value.corrected) : ''
)
const responseFillPath = computed(() => {
  if (!responsePath.value) return ''
  const zero = gainToY(0).toFixed(2)
  return `${responsePath.value} L100,${zero} L0,${zero} Z`
})

// Preserve the source band index so interactive control points, colors, and
// curves stay aligned even when inactive bands are omitted from processing.
function computeBandResponsePaths(
  bands: readonly EqualizerBand[],
  mode: EqMode,
  includeBypassed = false
): { index: number; path: string }[] {
  const sampleRate = responseSampleRate.value
  const paths: { index: number; path: string }[] = []
  bands.forEach((band, index) => {
    if (!isBandActive(band, mode) && !(includeBypassed && band.enabled === false)) return
    paths.push({
      index,
      path: plotResponse(
        computeBandResponse(includeBypassed ? { ...band, enabled: true } : band, {
          sampleRate,
          mode,
          pointCount: 97,
          minFrequency: GRAPH_MIN_FREQUENCY,
          maxFrequency: GRAPH_MAX_FREQUENCY
        })
      )
    })
  })
  return paths
}

const bandResponsePaths = computed(() =>
  computeBandResponsePaths(audioProcessing.value.eqBands, audioProcessing.value.eqMode, true)
)
const headphoneBandResponsePaths = computed(() =>
  computeBandResponsePaths(displayEqBands.value, displayEqMode.value)
)

// Auto gain compensation target: offset the highest boost of the band-only
// response by a 0.5 dB safety margin, clamped to the preamp slider range.
const autoPreampTargetDb = computed(() =>
  computeAutoPreampDb(audioProcessing.value.eqBands, {
    sampleRate: responseSampleRate.value,
    mode: audioProcessing.value.eqMode,
    minFrequency: GRAPH_MIN_FREQUENCY,
    maxFrequency: GRAPH_MAX_FREQUENCY,
    marginDb: 0.5,
    minPreampDb: -24,
    maxPreampDb: 24
  })
)

function loadAutoPreampPreference(): void {
  try {
    autoPreampEnabled.value = globalThis.localStorage?.getItem(autoPreampStorageKey) === '1'
    const saved = globalThis.localStorage?.getItem(manualPreampStorageKey)
    const value = saved?.trim() ? Number(saved) : NaN
    manualPreampBeforeAuto =
      autoPreampEnabled.value && Number.isFinite(value) && value >= -24 && value <= 24
        ? value
        : null
  } catch {
    // A blocked localStorage must not break the equalizer page.
  }
}

function saveAutoPreampPreference(enabled: boolean): void {
  try {
    if (enabled && manualPreampBeforeAuto !== null)
      globalThis.localStorage?.setItem(manualPreampStorageKey, String(manualPreampBeforeAuto))
    else globalThis.localStorage?.removeItem(manualPreampStorageKey)
    globalThis.localStorage?.setItem(autoPreampStorageKey, enabled ? '1' : '0')
  } catch {
    // Persisting the toggle is best-effort only.
  }
}

async function toggleAutoPreamp(): Promise<void> {
  finishParametricEdits()
  commitChain = commitChain.then(async () => {
    const enabled = !autoPreampEnabled.value
    const previousManual = manualPreampBeforeAuto
    if (enabled) manualPreampBeforeAuto = audioProcessing.value.eqPreamp
    const preamp = enabled
      ? autoPreampTargetDb.value
      : (manualPreampBeforeAuto ?? audioProcessing.value.eqPreamp)
    autoPreampEnabled.value = enabled
    await runEqApply(() => updateAudioProcessing({ eqPreamp: preamp }))
    if (autoPreampEnabled.value !== enabled) return
    if (eqApplyFeedback.value === 'applied') {
      if (!enabled) manualPreampBeforeAuto = null
      saveAutoPreampPreference(enabled)
    } else {
      autoPreampEnabled.value = !enabled
      manualPreampBeforeAuto = previousManual
    }
  })
  await commitChain
}

async function applyAutoPreamp(): Promise<void> {
  if (!autoPreampEnabled.value) return
  commitChain = commitChain.then(async () => {
    if (!autoPreampEnabled.value) return
    const target = autoPreampTargetDb.value
    if (Math.abs(audioProcessing.value.eqPreamp - target) < 0.05) return
    await runEqApply(() => updateAudioProcessing({ eqPreamp: target }))
  })
  await commitChain
}

async function loadAppSettings(): Promise<void> {
  try {
    const settings = await window.api.settings.get()
    appSettings.value = {
      ...settings,
      audioProcessing: normalizeAudioProcessing(settings.audioProcessing),
      audioEqPresets: settings.audioEqPresets.map((preset) => ({
        ...preset,
        eqBands: normalizeAudioProcessing({ eqMode: preset.eqMode, eqBands: preset.eqBands })
          .eqBands
      }))
    }
    appSettings.value.headphoneCompensation = {
      ...settings.headphoneCompensation,
      bands: cloneBands(settings.headphoneCompensation?.bands ?? [])
    }
    audioOutputDspStore.applyAudioProcessingState(appSettings.value.audioProcessing)
    const dspState = await window.api.audioEngine.getDspSceneState()
    applyActiveSceneEqToEditor(dspState)
    if (audioProcessing.value.eqMode === 'parametric') {
      activeTab.value = 'parametric'
    }
  } catch (err) {
    console.error('读取均衡器设置失败：', err)
  }
}

function applyActiveSceneEqToEditor(dspState: DspSceneState): void {
  // The scene EQ node holds the effective (OPRA-stacked) bands; never fold
  // those into the manual editor state or the next manual edit would persist
  // OPRA bands as user EQ and the engine would apply them twice.
  if (opraCompensationEnabled.value) return
  const scene = dspState.scenes.find((item) => item.id === dspState.activeSceneId)
  const node = scene?.graph.nodes.find((item) => item.type === 'equalizer')
  if (!node) return
  const params = node.params
  const settings = normalizeAudioProcessing({
    ...audioProcessing.value,
    // A bypassed engine node does not change either user power switch.
    eqEnabled: audioProcessing.value.dspEnabled ? node.enabled : audioProcessing.value.eqEnabled,
    eqMode: params.mode === 'parametric' ? 'parametric' : 'graphic',
    eqPreamp: typeof params.preampDb === 'number' ? params.preampDb : 0,
    eqBands: Array.isArray(params.bands) ? (params.bands as EqualizerBand[]) : []
  })
  audioOutputDspStore.applyAudioProcessingState(settings)
  if (appSettings.value) appSettings.value.audioProcessing = settings
}

async function syncActiveSceneEq(nextSettings: AudioProcessingSettings): Promise<void> {
  const dspState = await window.api.audioEngine.getDspSceneState()
  const scene = dspState.scenes.find((item) => item.id === dspState.activeSceneId)
  const node = scene?.graph.nodes.find((item) => item.type === 'equalizer')
  if (!node) return
  // OPRA contributes to the equalizer node but must not override the user's EQ
  // bypass. Preserve its parameters while disabled so re-enabling EQ restores
  // the same stacked response without continuing to process audio in bypass.
  node.enabled = nextSettings.dspEnabled && nextSettings.eqEnabled
  node.params = {
    ...node.params,
    mode: opraCompensationEnabled.value ? 'parametric' : nextSettings.eqMode,
    preampDb: opraCompensationEnabled.value
      ? nextSettings.eqPreamp + headphoneCompensation.value.preampDb
      : nextSettings.eqPreamp,
    bands: opraCompensationEnabled.value
      ? [...cloneBands(headphoneCompensation.value.bands), ...cloneBands(nextSettings.eqBands)]
      : nextSettings.eqBands
  }
  await window.api.audioEngine.setDspScenes(dspState.scenes, dspState.pinnedSceneId)
}

async function updateAudioProcessing(patch: Partial<AudioProcessingSettings>): Promise<void> {
  const nextSettings = normalizeAudioProcessing(mergeEqualizerPatch(audioProcessing.value, patch))
  // Auto gain compensation follows band/mode edits in the same engine update
  // so the compensated preamp reaches the DSP scene without a second apply.
  if (autoPreampEnabled.value && patch.eqPreamp === undefined) {
    nextSettings.eqPreamp = computeAutoPreampDb(nextSettings.eqBands, {
      sampleRate: responseSampleRate.value,
      mode: nextSettings.eqMode,
      minFrequency: GRAPH_MIN_FREQUENCY,
      maxFrequency: GRAPH_MAX_FREQUENCY,
      marginDb: 0.5,
      minPreampDb: -24,
      maxPreampDb: 24
    })
  }
  await eqHistory.commit(nextSettings)
}

async function applyEqualizerSnapshot(snapshot: EqSnapshot): Promise<void> {
  const nextSettings = normalizeAudioProcessing(
    mergeEqualizerPatch(audioProcessing.value, snapshot)
  )
  await setAudioProcessing(nextSettings, { throwOnError: true })
  await syncActiveSceneEq(nextSettings)
  activeTab.value = nextSettings.eqMode
  const indices = selectedBandIndices.value.filter((index) => nextSettings.eqBands[index])
  selectBand(
    indices.includes(selectedBandIndex.value) ? selectedBandIndex.value : (indices.at(-1) ?? -1),
    indices
  )
  if (appSettings.value) {
    appSettings.value = {
      ...appSettings.value,
      audioProcessing: nextSettings
    }
  }
}

async function updateEqBand(index: number, patch: Partial<EqualizerBand>): Promise<void> {
  finishParametricEdits()
  await commitChain
  if (!audioProcessing.value.eqBands[index]) return
  let bands = audioProcessing.value.eqBands
  const changes = groupEqBandPatches(bands, editedBandIndices(index), index, patch)
  for (const change of changes)
    bands = patchBand(bands, change.index, change.patch, audioProcessing.value.eqMode)
  await runEqApply(() => updateAudioProcessing({ eqBands: bands }))
}

function clearApplyFeedbackTimer(): void {
  if (applyFeedbackTimer === null) return
  window.clearTimeout(applyFeedbackTimer)
  applyFeedbackTimer = null
}

async function runEqApply(action: () => Promise<void>): Promise<void> {
  clearApplyFeedbackTimer()
  eqApplyFeedback.value = 'applying'
  eqApplyError.value = ''
  try {
    await action()
    eqApplyFeedback.value = 'applied'
    applyFeedbackTimer = window.setTimeout(() => {
      eqApplyFeedback.value = 'idle'
      applyFeedbackTimer = null
    }, 1400)
  } catch (error) {
    eqApplyFeedback.value = 'failed'
    eqApplyError.value = error instanceof Error ? error.message : String(error)
  }
}

// Apply the staged edit to renderer state only. The engine apply is deferred to
// commit so a gesture issues one round trip instead of one per input event;
// concurrent applies resolve out of order and can strand the UI (and the DSP
// scene) on an earlier value than the one the user dragged to.
function flushStagedEdit(): void {
  if (pendingBandPatches.size === 0 && pendingPreamp === null) return
  let bands = audioProcessing.value.eqBands
  for (const [index, patch] of pendingBandPatches) {
    bands = patchBand(bands, index, patch, audioProcessing.value.eqMode)
  }
  const preamp = pendingPreamp ?? audioProcessing.value.eqPreamp
  pendingBandPatches.clear()
  pendingPreamp = null
  audioOutputDspStore.applyAudioProcessingState({
    ...audioProcessing.value,
    eqPreamp: preamp,
    eqBands: bands
  })
  if (appSettings.value) {
    appSettings.value = { ...appSettings.value, audioProcessing: audioProcessing.value }
  }
}

function scheduleStagedFlush(): void {
  eqApplyFeedback.value = 'editing'
  if (pendingBandFrame !== 0) return
  pendingBandWindow = editorRoot.value?.ownerDocument.defaultView ?? window
  pendingBandFrame = pendingBandWindow.requestAnimationFrame(() => {
    pendingBandFrame = 0
    pendingBandWindow = null
    flushStagedEdit()
  })
}

function stageBandPatch(index: number, patch: Partial<EqualizerBand>): void {
  stageBandPatches([{ index, patch }])
}

function stageBandPatches(changes: EqBandPatch[]): void {
  for (const { index, patch } of changes) {
    if (!audioProcessing.value.eqBands[index]) continue
    pendingBandPatches.set(index, { ...pendingBandPatches.get(index), ...patch })
  }
  scheduleStagedFlush()
}

function stagePreamp(value: number): void {
  if (autoPreampEnabled.value) {
    autoPreampEnabled.value = false
    manualPreampBeforeAuto = null
    saveAutoPreampPreference(false)
  }
  pendingPreamp = clampNumber(value, -24, 24, audioProcessing.value.eqPreamp)
  scheduleStagedFlush()
}

function updatePreampInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const value = input.valueAsNumber
  if (!Number.isFinite(value)) {
    input.value = audioProcessing.value.eqPreamp.toFixed(1)
    return
  }
  const preamp = clampNumber(value, -24, 24, audioProcessing.value.eqPreamp)
  input.value = preamp.toFixed(1)
  if (!autoPreampEnabled.value && preamp === audioProcessing.value.eqPreamp) return
  stagePreamp(preamp)
  void commitStagedBands()
}

async function commitStagedBands(): Promise<void> {
  if (pendingBandFrame !== 0) {
    ;(pendingBandWindow ?? window).cancelAnimationFrame(pendingBandFrame)
    pendingBandFrame = 0
    pendingBandWindow = null
  }
  flushStagedEdit()
  // Snapshot the staged bands now, before any in-flight commit's response can
  // overwrite the shared state. Reading them inside the chained thunk would pick
  // up the earlier engine response and silently drop this gesture's edit.
  const preamp = autoPreampEnabled.value ? undefined : audioProcessing.value.eqPreamp
  const bands = cloneBands(audioProcessing.value.eqBands)
  // Serialize commits. setAudioProcessing assigns the engine response straight
  // onto the shared state, so a slow earlier response landing after a faster
  // later one would overwrite the newer edit in both the UI and the DSP scene.
  commitChain = commitChain
    .then(async () => {
      await runEqApply(() => updateAudioProcessing({ eqBands: bands, eqPreamp: preamp }))
    })
    // Never leave the chain rejected: a settled failure would make every later
    // slider release reject without ever reaching the engine.
    .catch((error) => {
      eqApplyFeedback.value = 'failed'
      eqApplyError.value = error instanceof Error ? error.message : String(error)
    })
  await commitChain
}

async function runHistoryCommand(action: 'undo' | 'redo' | 'A' | 'B' | 'copy'): Promise<void> {
  finishParametricEdits()
  await commitChain
  await runEqApply(async () => {
    if (action === 'undo' || action === 'redo') await eqHistory.travel(action)
    else if (action === 'copy') await eqHistory.copyToOther()
    else await eqHistory.switchSlot(action)
  })
}

async function addBand(frequency: number, gain: number): Promise<void> {
  finishParametricEdits()
  await commitChain
  if (audioProcessing.value.eqBands.length >= 32) return
  const bands = [
    ...cloneBands(audioProcessing.value.eqBands),
    createParametricBand(frequency, gain)
  ]
  await runEqApply(() => updateAudioProcessing({ eqMode: 'parametric', eqBands: bands }))
  if (eqApplyFeedback.value === 'applied') selectBand(bands.length - 1)
}

function editedBandIndices(index: number): number[] {
  return activeTab.value === 'parametric' && selectedBandIndices.value.includes(index)
    ? selectedBandIndices.value
    : [index]
}

async function deleteBand(index = selectedBandIndex.value): Promise<void> {
  finishParametricEdits()
  await commitChain
  if (!audioProcessing.value.eqBands[index]) return
  const removed = new Set(editedBandIndices(index))
  const bands = audioProcessing.value.eqBands.filter((_band, index) => !removed.has(index))
  await runEqApply(() => updateAudioProcessing({ eqBands: bands }))
  if (eqApplyFeedback.value === 'applied')
    selectBand(Math.min(Math.min(...removed), bands.length - 1))
}

async function toggleBandEnabled(index = selectedBandIndex.value): Promise<void> {
  finishParametricEdits()
  await commitChain
  if (!audioProcessing.value.eqBands[index]) return
  const indices = editedBandIndices(index)
  const enabled = !indices.some((index) => audioProcessing.value.eqBands[index].enabled !== false)
  await updateEqBand(index, { enabled })
}

async function copyBands(all = false): Promise<void> {
  if (clipboardBusy.value || activeTab.value !== 'parametric' || responseView.value !== 'dsp')
    return
  clipboardBusy.value = true
  clipboardMessage.value = ''
  clipboardFailed.value = false
  try {
    finishParametricEdits()
    await commitChain
    if (!equalizerMounted || activeTab.value !== 'parametric' || responseView.value !== 'dsp')
      return
    const selected = new Set(selectedBandIndices.value)
    const bands = cloneBands(
      audioProcessing.value.eqBands.filter((_band, index) => all || selected.has(index))
    )
    if (!bands.length) return
    await window.api.window.copyEqBands(bands)
    clipboardMessage.value = `已复制 ${bands.length} 个频段`
  } catch (error) {
    clipboardFailed.value = true
    clipboardMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    clipboardBusy.value = false
  }
}

async function pasteBands(): Promise<void> {
  if (clipboardBusy.value || activeTab.value !== 'parametric' || responseView.value !== 'dsp')
    return
  clipboardBusy.value = true
  clipboardMessage.value = ''
  clipboardFailed.value = false
  try {
    finishParametricEdits()
    await commitChain
    if (!equalizerMounted || activeTab.value !== 'parametric' || responseView.value !== 'dsp')
      return
    const incoming = await window.api.window.pasteEqBands()
    if (!equalizerMounted || activeTab.value !== 'parametric' || responseView.value !== 'dsp')
      return
    const first = audioProcessing.value.eqBands.length
    if (first + incoming.length > 32)
      throw new Error(`最多支持 32 个频段：当前 ${first} 个，待粘贴 ${incoming.length} 个`)
    const bands = [...cloneBands(audioProcessing.value.eqBands), ...cloneBands(incoming)]
    await runEqApply(() => updateAudioProcessing({ eqMode: 'parametric', eqBands: bands }))
    if (eqApplyFeedback.value === 'applied') {
      selectBand(
        first,
        incoming.map((_band, index) => first + index)
      )
      clipboardMessage.value = `已粘贴 ${incoming.length} 个频段`
    }
  } catch (error) {
    clipboardFailed.value = true
    clipboardMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    clipboardBusy.value = false
  }
}

function blockWhileApplying(event: Event): void {
  if (!historyBusy.value && !clipboardBusy.value) return
  if (event instanceof KeyboardEvent && event.key === 'Tab') return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onEqualizerKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('input, select, textarea, [contenteditable="true"]')) return
  if (historyBusy.value || historyLoading.value || clipboardBusy.value) return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (key === 'z' || key === 'y') {
      event.preventDefault()
      event.stopPropagation()
      void runHistoryCommand(key === 'y' || event.shiftKey ? 'redo' : 'undo')
    } else if (key === 'a' && activeTab.value === 'parametric') {
      event.preventDefault()
      event.stopPropagation()
      const indices = audioProcessing.value.eqBands.map((_band, index) => index)
      selectBand(indices[0] ?? -1, indices)
    } else if (
      activeTab.value === 'parametric' &&
      responseView.value === 'dsp' &&
      (key === 'v' || (key === 'c' && selectedBandIndices.value.length))
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (key === 'c') void copyBands()
      else void pasteBands()
    }
    return
  }
  if (activeTab.value !== 'parametric') return
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedBand.value) {
    event.preventDefault()
    void deleteBand()
  }
  if (!event.altKey && event.key.toLowerCase() === 'b' && selectedBand.value) {
    event.preventDefault()
    void toggleBandEnabled()
  }
}

function updateSpectrumPolling(): void {
  if (!spectrumVisible.value || responseView.value !== 'dsp' || activeTab.value !== 'parametric')
    spectrumFrozen.value = false
  const shouldPoll =
    spectrumPollingMounted &&
    activeTab.value === 'parametric' &&
    responseView.value === 'dsp' &&
    spectrumVisible.value &&
    !spectrumFrozen.value &&
    isPlaying.value
  if (!shouldPoll) {
    if (!spectrumFrozen.value) spectrumLevels.value = null
  }
  // Spectrum and meters share a single native sample, also consumed by the bar.
  const points =
    spectrumPollingMounted && activeTab.value === 'parametric' ? (shouldPoll ? 2048 : 64) : 0
  if (points === visualizationConsumerPoints) return
  releaseVisualizationConsumer?.()
  releaseVisualizationConsumer = points
    ? acquireVisualizationConsumer({ spectrumPoints: points })
    : null
  visualizationConsumerPoints = points
}

function updateSpectrumFromSample(data: typeof visualizationData.value): void {
  if (visualizationConsumerPoints !== 2048 || spectrumFrozen.value) return
  spectrumLevels.value =
    data.active && data.spectrum.length >= 2
      ? projectSpectrumLevels(data.spectrum, data.sampleRate || responseSampleRate.value)
      : null
}
watch([visualizationData, responseSampleRate], ([data]) => updateSpectrumFromSample(data))

async function importFrequencyResponse(): Promise<void> {
  if (frequencyResponseImporting.value) return
  frequencyResponseImporting.value = true
  frequencyResponseError.value = ''
  try {
    const imported = await window.api.audioEngine.importFrequencyResponse()
    if (!imported) return
    importedFrequencyResponse.value = imported
    responseView.value = 'headphone'
  } catch (err) {
    frequencyResponseError.value = err instanceof Error ? err.message : String(err)
  } finally {
    frequencyResponseImporting.value = false
  }
}

function clearFrequencyResponse(): void {
  importedFrequencyResponse.value = null
  frequencyResponseError.value = ''
  responseView.value = 'dsp'
}

function toggleHeadphoneCurve(curve: HeadphoneCurveKey): void {
  const visibility = {
    source: showMeasuredSource,
    target: showTargetResponse,
    individual: showIndividualFilters,
    combined: showCombinedFilter,
    corrected: showCorrectedResponse
  }
  visibility[curve].value = !visibility[curve].value
}

async function loadOpraStatus(): Promise<void> {
  try {
    opraStatus.value = await window.api.opra.getStatus()
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  }
}

async function searchOpraProfiles(query: string): Promise<void> {
  const trimmed = query.trim()
  if (!trimmed) {
    opraResults.value = []
    return
  }
  opraSearching.value = true
  opraError.value = ''
  try {
    opraResults.value = await window.api.opra.search(trimmed)
    opraStatus.value = await window.api.opra.getStatus()
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraSearching.value = false
  }
}

async function refreshOpraCatalog(): Promise<void> {
  opraRefreshing.value = true
  opraError.value = ''
  try {
    opraStatus.value = await window.api.opra.refresh()
    await searchOpraProfiles(opraQuery.value)
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraRefreshing.value = false
  }
}

async function applyOpraProfile(profile: OpraProfile): Promise<void> {
  if (!profile.applicable || opraApplyingEqId.value || opraSaving.value) return
  opraApplyingEqId.value = profile.eqId
  opraError.value = ''
  try {
    const fullProfile = (await window.api.opra.getProfile(profile.eqId)) ?? profile
    if (!fullProfile.applicable) {
      opraError.value = `该 profile 包含暂不支持的滤波器：${fullProfile.unsupportedBandTypes.join(', ')}`
      return
    }
    const savedSettings = await window.api.settings.update({
      headphoneCompensation: {
        enabled: true,
        productId: fullProfile.productId,
        productName: fullProfile.productName,
        vendorName: fullProfile.vendorName,
        eqId: fullProfile.eqId,
        author: fullProfile.author,
        details: fullProfile.details,
        link: fullProfile.link,
        preampDb: fullProfile.preampDb,
        bands: cloneBands(fullProfile.bands)
      }
    })
    appSettings.value = { ...appSettings.value, ...savedSettings }
    await syncActiveSceneEq(audioProcessing.value)
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraApplyingEqId.value = ''
  }
}

async function disableOpraCompensation(): Promise<void> {
  if (!appSettings.value || opraSaving.value || opraApplyingEqId.value) return
  opraSaving.value = true
  opraError.value = ''
  try {
    const savedSettings = await window.api.settings.update({
      headphoneCompensation: {
        ...headphoneCompensation.value,
        enabled: false
      }
    })
    // Explicitly construct a new object to guarantee Vue reactivity triggers
    appSettings.value = {
      ...appSettings.value,
      ...savedSettings,
      headphoneCompensation: {
        ...headphoneCompensation.value,
        enabled: false
      }
    }
    await syncActiveSceneEq(audioProcessing.value)
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraSaving.value = false
  }
}

async function applyEqPreset(preset: AudioEqPreset): Promise<void> {
  finishParametricEdits()
  await commitChain
  activeTab.value = preset.eqMode
  await runEqApply(() =>
    updateAudioProcessing({
      eqMode: preset.eqMode,
      eqPreamp: preset.eqPreamp,
      eqBands: cloneBands(preset.eqBands)
    })
  )
  presetMenuOpen.value = false
}

async function saveEqPreset(): Promise<void> {
  finishParametricEdits()
  await commitChain
  const name =
    presetName.value.trim() ||
    `自定义 ${new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    })}`
  if (!name || !appSettings.value || saving.value) return
  saving.value = true
  try {
    const nextPreset: AudioEqPreset = {
      id: `custom-${Date.now()}`,
      name,
      eqMode: audioProcessing.value.eqMode,
      eqPreamp: audioProcessing.value.eqPreamp,
      eqBands: cloneBands(audioProcessing.value.eqBands)
    }
    appSettings.value = await window.api.settings.update({
      audioEqPresets: [...userPresets.value, nextPreset]
    })
    presetName.value = ''
    presetMenuOpen.value = true
  } catch (err) {
    console.error('保存均衡器预设失败：', err)
  } finally {
    saving.value = false
  }
}

function saveAsCurrentPreset(): void {
  void saveEqPreset()
}

async function switchTab(tab: EqualizerTab): Promise<void> {
  if (props.navigationLocked) return
  finishParametricEdits()
  await commitChain
  activeTab.value = tab
  presetMenuOpen.value = false
  filterMenuOpen.value = false
  if (tab === 'graphic' || tab === 'parametric') {
    await runEqApply(() => updateAudioProcessing({ eqMode: tab }))
  }
}

// 参数均衡是页面内部的一层：标题栏返回键先退回图形标签，再退出均衡器页
// （页面层由 App.vue 按页面旗标注冊）。
useBackHandler(
  computed(() => activeTab.value === 'parametric'),
  () => switchTab('graphic'),
  '返回图形'
)

function openAdvancedSettings(index = selectedBandIndex.value): void {
  selectBand(Math.min(Math.max(index, 0), audioProcessing.value.eqBands.length - 1))
  activeTab.value = 'parametric'
  presetMenuOpen.value = false
  filterMenuOpen.value = false
  void runEqApply(() => updateAudioProcessing({ eqMode: 'parametric' }))
}

async function resetEqualizer(): Promise<void> {
  finishParametricEdits()
  await commitChain
  await runEqApply(() =>
    updateAudioProcessing({
      eqEnabled: false,
      eqMode: activeTab.value === 'parametric' ? 'parametric' : 'graphic',
      eqPreamp: 0,
      eqBands: cloneBands(defaultEqBands)
    })
  )
}

function togglePresetMenu(): void {
  presetMenuOpen.value = !presetMenuOpen.value
  if (presetMenuOpen.value) filterMenuOpen.value = false
}

async function selectFilterType(filterType: EqualizerFilterType): Promise<void> {
  filterMenuOpen.value = false
  await updateEqBand(selectedBandIndex.value, { filterType })
}

function selectFilterForBand(index: number, filterType: EqualizerFilterType): void {
  selectedBandIndex.value = index
  void selectFilterType(filterType)
}

function finishParametricEdits(): void {
  parametricWorkspaceRef.value?.finishInteraction()
  if (pendingBandFrame !== 0) void commitStagedBands()
}

async function requestLeave(): Promise<boolean> {
  if (
    historyLoading.value ||
    historyBusy.value ||
    clipboardBusy.value ||
    opraApplyingEqId.value ||
    opraSaving.value
  )
    return false
  finishParametricEdits()
  // A preview can already have flushed to the renderer without its final
  // pointer-up commit. Finish that edit before unmounting the audio editor.
  if (eqApplyFeedback.value === 'editing') await commitStagedBands()
  await commitChain
  return eqApplyFeedback.value !== 'failed'
}

defineExpose({ requestLeave })

async function toggleParametricEq(): Promise<void> {
  finishParametricEdits()
  await commitChain
  await runEqApply(() => updateAudioProcessing({ eqEnabled: !audioProcessing.value.eqEnabled }))
}

function selectBand(index: number, indices: number[] = [index]): void {
  const valid = indices.filter((index) => audioProcessing.value.eqBands[index])
  selectedBandIndex.value = valid.includes(index) ? index : (valid.at(-1) ?? -1)
  selectedBandIndices.value = valid
  filterMenuOpen.value = false
}

onMounted(() => {
  spectrumPollingMounted = true
  loadAutoPreampPreference()
  void loadAppSettings().then(() => {
    eqHistory.reset(audioProcessing.value)
    historyLoading.value = false
  })
  void loadOpraStatus()
  updateSpectrumPolling()
})

onBeforeUnmount(() => {
  equalizerMounted = false
  spectrumPollingMounted = false
  updateSpectrumPolling()
  releaseVisualizationConsumer?.()
  releaseVisualizationConsumer = null
  clearApplyFeedbackTimer()
  if (pendingBandFrame !== 0) (pendingBandWindow ?? window).cancelAnimationFrame(pendingBandFrame)
})

// Keep the compensated preamp in sync when bands change through paths that
// bypass updateAudioProcessing (preset apply on load, external scene edits).
watch(autoPreampTargetDb, () => {
  if (
    !autoPreampEnabled.value ||
    historyLoading.value ||
    historyBusy.value ||
    eqApplyFeedback.value === 'editing' ||
    eqApplyFeedback.value === 'applying'
  )
    return
  void applyAutoPreamp()
})

watch([activeTab, spectrumVisible, responseView, isPlaying, spectrumFrozen], updateSpectrumPolling)
</script>

<template>
  <div
    ref="editorRoot"
    class="eq-page"
    :class="{ 'is-parametric': activeTab === 'parametric', 'is-embedded': props.embedded }"
    @keydown="onEqualizerKeydown"
  >
    <div
      class="eq-container"
      :inert="historyLoading"
      :aria-busy="historyBusy || historyLoading || clipboardBusy"
      @click.capture="blockWhileApplying"
      @pointerdown.capture="blockWhileApplying"
      @keydown.capture="blockWhileApplying"
      @wheel.capture="blockWhileApplying"
      @contextmenu.capture="blockWhileApplying"
    >
      <nav class="eq-mode-tabs" aria-label="均衡器模式">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="nav-item"
          :aria-pressed="activeTab === tab.key"
          :class="{ active: activeTab === tab.key }"
          @click="switchTab(tab.key)"
        >
          {{ tab.key === 'graphic' ? '图形' : '参数' }}
        </button>
      </nav>

      <main class="eq-content">
        <!-- Toolbar for Presets across Graphic and Parametric -->
        <div v-if="activeTab !== 'parametric'" class="eq-toolbar-modern">
          <EqHistoryControls
            :active-slot="activeSlot"
            :can-undo="canUndo"
            :can-redo="canRedo"
            @command="runHistoryCommand"
          />
          <div class="preset-menu-anchor">
            <button type="button" class="eq-command preset-menu-button" @click="togglePresetMenu">
              选择预设 <i class="pi pi-chevron-down"></i>
            </button>
            <div v-if="presetMenuOpen" class="preset-menu" data-te-material="popover">
              <div class="preset-menu-section">
                <span class="preset-menu-title">内置预设</span>
                <button
                  v-for="preset in builtInEqPresets"
                  :key="preset.id"
                  type="button"
                  class="preset-menu-item"
                  @click="applyEqPreset(preset)"
                >
                  {{ preset.name }}
                </button>
              </div>
              <div class="preset-menu-section">
                <span class="preset-menu-title">自定义预设</span>
                <button
                  v-for="preset in userPresets"
                  :key="preset.id"
                  type="button"
                  class="preset-menu-item"
                  @click="applyEqPreset(preset)"
                >
                  {{ preset.name }}
                </button>
                <span v-if="userPresets.length === 0" class="preset-empty">暂无自定义预设</span>
              </div>
              <div class="preset-create">
                <input v-model="presetName" type="text" placeholder="新建预设名称" />
                <button
                  type="button"
                  :disabled="saving || !presetName.trim()"
                  @click="saveEqPreset"
                >
                  新建
                </button>
              </div>
            </div>
          </div>
          <button
            v-if="activeTab === 'graphic'"
            type="button"
            class="eq-command"
            @click="openAdvancedSettings()"
          >
            高级设置
          </button>
          <button v-else type="button" class="eq-command" @click="switchTab('graphic')">
            返回图形
          </button>
          <button
            type="button"
            class="eq-command auto-preamp-toggle"
            :class="{ active: autoPreampEnabled }"
            :aria-pressed="autoPreampEnabled"
            title="根据当前曲线的最大增益自动下调前置放大，预留 0.5 dB 余量"
            @click="toggleAutoPreamp"
          >
            <i :class="autoPreampEnabled ? 'pi pi-check-circle' : 'pi pi-circle'"></i>
            自动增益补偿
          </button>
          <button type="button" class="eq-command soft" @click="resetEqualizer">重置</button>
          <button type="button" class="eq-command" :disabled="saving" @click="saveAsCurrentPreset">
            另存为
          </button>
        </div>

        <div v-if="activeTab === 'graphic'" class="tab-pane active">
          <header class="eq-header">
            <div class="eq-title">
              <h2>均衡曲线</h2>
              <p>{{ audioProcessing.eqBands.length }} 个频段 · {{ eqApplyStatusText }}</p>
            </div>
            <button
              type="button"
              class="master-switch"
              role="switch"
              aria-label="启用均衡器"
              :aria-checked="audioProcessing.eqEnabled"
              :class="{ off: !audioProcessing.eqEnabled }"
              @click="toggleParametricEq()"
            >
              {{ audioProcessing.eqEnabled ? '已启用' : '已关闭' }}
            </button>
          </header>

          <p v-if="eqApplyError" class="eq-apply-error" role="alert">{{ eqApplyError }}</p>

          <GraphicEqPanel
            :preamp="audioProcessing.eqPreamp"
            :bands="audioProcessing.eqBands"
            :auto-preamp-enabled="autoPreampEnabled"
            @preview-preamp="stagePreamp"
            @preview-band="stageBandPatch"
            @commit="commitStagedBands"
            @advanced="openAdvancedSettings"
          />

          <FrequencyResponseChart
            :bands="audioProcessing.eqBands"
            :response-view="responseView"
            :imported-frequency-response="importedFrequencyResponse"
            :importing="frequencyResponseImporting"
            :error="frequencyResponseError"
            :opra-compensation-enabled="opraCompensationEnabled"
            :manual-response-path="manualResponsePath"
            :opra-response-path="opraResponsePath"
            :opra-estimated-deviation-path="opraEstimatedDeviationPath"
            :response-path="responsePath"
            :response-fill-path="responseFillPath"
            :measured-source-path="measuredSourcePath"
            :target-response-path="targetResponsePath"
            :combined-filter-path="combinedFilterPath"
            :corrected-acoustic-path="correctedAcousticPath"
            :band-response-paths="
              responseView === 'headphone' ? headphoneBandResponsePaths : bandResponsePaths
            "
            :show-manual-response="showManualResponse"
            :show-opra-response="showOpraResponse"
            :show-opra-estimated-deviation="showOpraEstimatedDeviation"
            :show-measured-source="showMeasuredSource"
            :show-target-response="showTargetResponse"
            :show-individual-filters="showIndividualFilters"
            :show-combined-filter="showCombinedFilter"
            :show-corrected-response="showCorrectedResponse"
            @update:response-view="responseView = $event"
            @toggle-manual="showManualResponse = !showManualResponse"
            @toggle-opra="showOpraResponse = !showOpraResponse"
            @toggle-estimated-deviation="showOpraEstimatedDeviation = !showOpraEstimatedDeviation"
            @toggle-headphone-curve="toggleHeadphoneCurve"
            @import="importFrequencyResponse"
            @clear="clearFrequencyResponse"
          />

          <OpraEqPanel
            :compensation="headphoneCompensation"
            :status="opraStatus"
            :searching="opraSearching"
            :refreshing="opraRefreshing"
            :applying-eq-id="opraApplyingEqId"
            :saving="opraSaving"
            :results="opraResults"
            :error="opraError"
            :query="opraQuery"
            @update:query="opraQuery = $event"
            @search="searchOpraProfiles"
            @select="applyOpraProfile"
            @clear="disableOpraCompensation"
            @refresh="refreshOpraCatalog"
          />
        </div>

        <div v-else-if="activeTab === 'parametric'" class="tab-pane active parametric-pane">
          <ParametricEqWorkspace
            ref="parametricWorkspaceRef"
            :bands="audioProcessing.eqBands"
            :selected-index="selectedBandIndex"
            :selected-indices="selectedBandIndices"
            :clipboard-busy="clipboardBusy"
            :clipboard-message="clipboardMessage"
            :clipboard-failed="clipboardFailed"
            v-model:display-range-db="displayRangeDb"
            :filter-types="filterTypes"
            :response-view="responseView"
            :response-path="responsePath"
            :spectrum-levels="spectrumLevels"
            :spectrum-visible="spectrumVisible"
            v-model:spectrum-frozen="spectrumFrozen"
            :measured-source-path="measuredSourcePath"
            :target-response-path="targetResponsePath"
            :combined-filter-path="combinedFilterPath"
            :corrected-acoustic-path="correctedAcousticPath"
            :band-response-paths="
              responseView === 'headphone' ? headphoneBandResponsePaths : bandResponsePaths
            "
            :show-measured-source="showMeasuredSource"
            :show-target-response="showTargetResponse"
            :show-individual-filters="showIndividualFilters"
            :show-combined-filter="showCombinedFilter"
            :show-corrected-response="showCorrectedResponse"
            :eq-enabled="audioProcessing.eqEnabled"
            :meter-peak-db="visualizationData.peakDb"
            :meter-rms-db="visualizationData.rmsDb"
            :status="eqApplyStatusText"
            :status-state="eqApplyFeedback"
            :error="eqApplyError"
            @select="selectBand"
            @copy="copyBands"
            @paste="pasteBands"
            @add="addBand"
            @preview-bands="stageBandPatches"
            @commit="commitStagedBands"
            @delete="deleteBand"
            @toggle="toggleBandEnabled"
            @filter="selectFilterForBand"
            @toggle-spectrum="spectrumVisible = !spectrumVisible"
            @toggle-headphone-curve="toggleHeadphoneCurve"
          >
            <template #commands>
              <EqHistoryControls
                :active-slot="activeSlot"
                :can-undo="canUndo"
                :can-redo="canRedo"
                @command="runHistoryCommand"
              />

              <div class="instrument-presets">
                <div class="preset-menu-anchor">
                  <button
                    type="button"
                    class="eq-command preset-menu-button"
                    @click="togglePresetMenu"
                  >
                    选择预设 <i class="pi pi-chevron-down"></i>
                  </button>
                  <div v-if="presetMenuOpen" class="preset-menu" data-te-material="popover">
                    <div class="preset-menu-section">
                      <span class="preset-menu-title">内置预设</span>
                      <button
                        v-for="preset in builtInEqPresets"
                        :key="preset.id"
                        type="button"
                        class="preset-menu-item"
                        @click="applyEqPreset(preset)"
                      >
                        {{ preset.name }}
                      </button>
                    </div>
                    <div class="preset-menu-section">
                      <span class="preset-menu-title">自定义预设</span>
                      <button
                        v-for="preset in userPresets"
                        :key="preset.id"
                        type="button"
                        class="preset-menu-item"
                        @click="applyEqPreset(preset)"
                      >
                        {{ preset.name }}
                      </button>
                      <span v-if="userPresets.length === 0" class="preset-empty"
                        >暂无自定义预设</span
                      >
                    </div>
                    <div class="preset-create">
                      <input v-model="presetName" type="text" placeholder="新建预设名称" />
                      <button
                        type="button"
                        :disabled="saving || !presetName.trim()"
                        @click="saveEqPreset"
                      >
                        新建
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <button
                type="button"
                class="instrument-power"
                :class="{ active: audioProcessing.eqEnabled }"
                :aria-pressed="audioProcessing.eqEnabled"
                aria-label="启用均衡器"
                @click="toggleParametricEq"
              >
                <i class="pi pi-power-off"></i
                ><span>{{ audioProcessing.eqEnabled ? '已启用' : '已旁路' }}</span>
              </button>
              <details class="instrument-more">
                <summary aria-label="均衡器更多操作" title="更多操作">
                  <i class="pi pi-ellipsis-h"></i>
                </summary>
                <div class="instrument-more-menu">
                  <button type="button" :disabled="saving" @click="saveAsCurrentPreset">
                    另存为预设
                  </button>
                  <button type="button" @click="resetEqualizer">重置均衡器</button>
                </div>
              </details>
            </template>
            <template #footer>
              <FrequencyResponseToolbar
                compact
                :response-view="responseView"
                :imported-frequency-response="importedFrequencyResponse"
                :importing="frequencyResponseImporting"
                :error="frequencyResponseError"
                @update:response-view="responseView = $event"
                @import="importFrequencyResponse"
                @clear="clearFrequencyResponse"
              />
              <button
                type="button"
                class="instrument-auto-preamp"
                :class="{ active: autoPreampEnabled }"
                :aria-pressed="autoPreampEnabled"
                title="根据当前曲线自动下调前级，预留 0.5 dB 余量"
                @click="toggleAutoPreamp"
              >
                <i :class="autoPreampEnabled ? 'pi pi-check-circle' : 'pi pi-circle'"></i>自动补偿
              </button>
              <label class="instrument-preamp" title="前置放大，手动修改会关闭自动补偿">
                <input
                  type="number"
                  min="-24"
                  max="24"
                  step="0.1"
                  :value="audioProcessing.eqPreamp.toFixed(1)"
                  aria-label="前级增益"
                  @change="updatePreampInput"
                  @keydown.enter.prevent="updatePreampInput"
                />
                <small>dB</small>
              </label>
            </template>
          </ParametricEqWorkspace>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.eq-page {
  position: fixed;
  inset: 0;
  /* Above the sidebar (1000) and player bar (1002); below the title bar (9999). */
  z-index: 2000;
  overflow: hidden;
  background-color: var(--te-app-bg);
  background-image: var(--te-app-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}

.eq-toolbar-modern {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 16px;
  border-bottom: 1px solid var(--te-card-border);
  margin-bottom: 0;
  flex-wrap: wrap;
}

.eq-command {
  min-height: var(--te-control-height-md);
  background: transparent;
  border: 1px solid var(--te-card-border);
  padding: 6px 12px;
  border-radius: var(--te-control-radius-sm);
  font-size: var(--te-type-body);
  font-weight: var(--te-type-weight-medium);
  color: var(--te-neutral-900);
  cursor: pointer;
  transition:
    background-color 0.2s var(--te-ease-soft),
    border-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
  display: flex;
  align-items: center;
  gap: 8px;
}

.eq-command:hover:not(:disabled) {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}

.eq-command.soft {
  background: transparent;
  border-color: transparent;
}
.eq-command.soft:hover {
  background: rgba(15, 23, 42, 0.04);
  color: var(--te-neutral-900);
}

.eq-command:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.auto-preamp-toggle.active {
  background: var(--te-active-bg);
  color: var(--te-neutral-900);
}

.preset-menu-anchor {
  position: relative;
}

.preset-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  background: var(--te-material-background);
  color: var(--te-material-ink);
  backdrop-filter: var(--te-material-filter);
  border: 1px solid var(--te-material-border);
  border-radius: 16px;
  box-shadow: var(--te-material-shadow);
  padding: 12px;
  width: 240px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.preset-menu-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preset-menu-title {
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-control-fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0 8px 4px;
}

.preset-menu-item {
  background: transparent;
  border: none;
  padding: 8px;
  text-align: left;
  font-size: var(--te-type-caption);
  font-weight: 600;
  color: var(--te-control-fg);
  border-radius: 8px;
  cursor: pointer;
  transition:
    background-color 0.2s var(--te-ease-soft),
    color 0.2s var(--te-ease-soft);
}

.preset-menu-item:hover {
  background: var(--te-control-bg-hover);
  color: var(--te-control-fg);
}

.preset-empty {
  font-size: var(--te-type-caption);
  color: var(--te-control-fg-muted);
  padding: 4px 8px;
}

.preset-create {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--te-control-border);
}

.preset-create input {
  flex: 1;
  background: var(--te-control-bg);
  color: var(--te-control-fg);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: var(--te-type-caption);
  outline: none;
  transition:
    background-color 0.2s var(--te-ease-soft),
    border-color 0.2s var(--te-ease-soft);
  width: 100%;
}

.preset-create input:focus {
  background: var(--te-control-bg);
  border-color: var(--te-control-focus-color);
}

.preset-create button {
  background: var(--te-control-accent);
  color: var(--te-control-on-accent);
  border: none;
  border-radius: 8px;
  padding: 0 12px;
  font-size: var(--te-type-caption);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.preset-create button:hover:not(:disabled) {
  background: var(--te-primary-600);
}
.preset-create button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* One flat editor surface, within the secondary DSP workspace. */
.eq-container {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: transparent;
}
.eq-mode-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  padding: calc(var(--te-titlebar-inset, 40px) + var(--te-page-top, 32px))
    var(--te-page-inset, 32px) 0;
}
.eq-mode-tabs .nav-item {
  min-height: 34px;
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-neutral-500);
  font: inherit;
  font-size: var(--te-type-body);
  cursor: pointer;
}
.eq-mode-tabs .nav-item:hover {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}
.eq-mode-tabs .nav-item.active {
  border-color: var(--te-card-border);
  background: var(--te-subtle-bg);
  color: var(--te-neutral-900);
  font-weight: var(--te-type-weight-medium);
}
.eq-content {
  flex: 1;
  padding: 20px var(--te-page-inset, 32px) var(--te-page-bottom, 32px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
  min-width: 0;
}
.tab-pane {
  display: none;
  flex-direction: column;
  gap: 24px;
  animation: none;
}
.tab-pane.active {
  display: flex;
}

.eq-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
}
.eq-title h2 {
  font-size: var(--te-type-section-title);
  font-weight: var(--te-type-weight-strong);
  letter-spacing: normal;
  margin-bottom: 6px;
}
.eq-title p {
  color: var(--te-neutral-500);
  font-size: var(--te-type-body);
  font-weight: 500;
}

.master-switch {
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--te-control-border);
  border-radius: 6px;
  background: transparent;
  color: var(--te-neutral-900);
  font: inherit;
  font-size: var(--te-type-caption);
  cursor: pointer;
}
.master-switch[aria-checked='true'] {
  background: var(--te-subtle-bg);
}
.master-switch:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}

/* Detailed SVG Chart Area */
.parametric-pane {
  gap: 10px;
}

.parametric-page-header {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 2px;
}

.parametric-page-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 13px;
}

.parametric-eyebrow,
.parametric-toolbar-label,
.parametric-context-status {
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-strong);
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.parametric-eyebrow {
  flex: 0 0 auto;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--te-primary-500) 24%, var(--te-card-border));
  border-radius: 5px;
  color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500) 7%, transparent);
}

.parametric-page-title h1 {
  margin: 0 0 2px;
  font-size: var(--te-type-headline);
  font-weight: 760;
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.parametric-page-title p {
  overflow: hidden;
  color: var(--te-neutral-500);
  font-size: var(--te-type-caption);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parametric-context-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--te-neutral-500);
  font-variant-numeric: tabular-nums;
}

.context-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--te-success-500);
  box-shadow: 0 0 8px color-mix(in srgb, var(--te-success-500) 62%, transparent);
}

/* Parametric Specific Styles */
.band-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px 20px;
  background: var(--te-glass-bg);
  border-radius: 16px;
  border: 1px solid var(--te-glass-border);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.02);
}
.band-tab {
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid var(--te-card-border);
  background: var(--te-card-bg);
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-neutral-500);
  cursor: pointer;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft);
}
.band-tab:hover {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}
.band-tab.active {
  background: var(--te-active-bg);
  color: var(--te-primary-500);
  border-color: var(--te-active-bg);
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.15);
}

.parameter-card {
  background: var(--te-glass-bg);
  border-radius: 20px;
  padding: 30px;
  border: 1px solid var(--te-glass-border);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
}
.param-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.param-group label {
  font-size: var(--te-type-caption);
  font-weight: var(--te-type-weight-strong);
  color: var(--te-neutral-500);
}
.param-group input,
.param-group select {
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  padding: 12px 16px;
  border-radius: 12px;
  font-family: inherit;
  font-size: var(--te-type-body);
  font-weight: 600;
  color: var(--te-neutral-900);
  outline: none;
  width: 100%;
}
.param-group input:focus,
.param-group select:focus {
  border-color: var(--te-control-focus-color);
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
  box-shadow: none;
}

.square-card {
  background: var(--te-glass-bg);
  border-radius: 20px;
  padding: 40px;
  border: 1px solid var(--te-glass-border);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
}
.square-card i {
  font-size: calc(var(--te-font-size-body, 14px) * 48 / 14);
  color: var(--te-primary-500);
  background: #fff; /* keep-white: icon circle */
  width: 100px;
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  box-shadow: 0 16px 32px rgba(15, 23, 42, 0.05);
  margin-bottom: 24px;
}
.square-card h2 {
  font-size: var(--te-type-page-title);
  font-weight: var(--te-type-weight-strong);
  margin-bottom: 12px;
}
.square-card p {
  color: var(--te-neutral-500);
  max-width: 400px;
  line-height: 1.6;
}

@media (max-width: 900px) {
  .parametric-page-title p {
    max-width: 44vw;
  }
}

@media (max-width: 620px) {
  .parametric-pane {
    gap: 8px;
  }

  .parametric-page-header {
    align-items: flex-start;
  }

  .parametric-eyebrow,
  .parametric-context-status,
  .parametric-toolbar-label {
    display: none;
  }

  .parametric-page-title h1 {
    font-size: var(--te-type-body);
  }

  .parametric-page-title p {
    max-width: none;
    white-space: normal;
  }
}

:global(html[data-te-equalizer-panel] .eq-page .band-selector),
:global(html[data-te-equalizer-panel] .eq-page .parameter-card),
:global(html[data-te-equalizer-panel] .eq-page .square-card) {
  border-color: var(--te-equalizer-panel-border);
  border-radius: var(--te-equalizer-panel-radius);
  background: var(--te-equalizer-panel-bg);
}

:global(html[data-te-equalizer-panel='tinted'] .eq-page .band-selector),
:global(html[data-te-equalizer-panel='tinted'] .eq-page .parameter-card),
:global(html[data-te-equalizer-panel='tinted'] .eq-page .square-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 82%, var(--te-primary-500));
}

:global(html[data-te-equalizer-panel='glass'] .eq-page .band-selector),
:global(html[data-te-equalizer-panel='glass'] .eq-page .parameter-card),
:global(html[data-te-equalizer-panel='glass'] .eq-page .square-card) {
  background: color-mix(in srgb, var(--te-equalizer-panel-bg) 68%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
}

:global(html[data-te-equalizer-button] .eq-page .eq-command),
:global(html[data-te-equalizer-button] .eq-page .band-tab) {
  border-radius: var(--te-equalizer-button-radius);
}

:global(html[data-te-equalizer-button='soft'] .eq-page .eq-command),
:global(html[data-te-equalizer-button='soft'] .eq-page .band-tab) {
  border-color: transparent;
  background: var(--te-equalizer-button-bg);
  color: var(--te-control-fg);
}

:global(html[data-te-equalizer-button='outline'] .eq-page .eq-command),
:global(html[data-te-equalizer-button='outline'] .eq-page .band-tab) {
  border-color: var(--te-equalizer-panel-border);
  background: transparent;
}

:global(html[data-te-equalizer-button='solid'] .eq-page .eq-command),
:global(html[data-te-equalizer-button='solid'] .eq-page .band-tab) {
  border-color: var(--te-primary-500);
  background: var(--te-primary-500);
  color: var(--te-control-on-accent);
}

:global(html[data-te-equalizer-knob] .eq-page .toggle-thumb) {
  width: var(--te-equalizer-knob-size);
  height: var(--te-equalizer-knob-size);
}

:global(html[data-te-equalizer-knob] .eq-page .toggle-thumb::after) {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  background: var(--te-primary-500);
  transform: translate(-50%, -50%);
}

:global(html[data-te-equalizer-knob='line'] .eq-page .toggle-thumb::after) {
  width: 8px;
  height: 2px;
  border-radius: 1px;
}

:global(html[data-te-equalizer-knob='dot'] .eq-page .toggle-thumb::after) {
  width: 4px;
  height: 4px;
  border-radius: 50%;
}

/* The parametric view is a flat instrument surface that follows the page theme. */
.parametric-pane {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.parametric-page-header {
  min-height: 38px;
  padding: 0 2px;
}

.parametric-eyebrow {
  border-color: color-mix(in srgb, var(--te-neutral-900) 14%, transparent);
  border-radius: 4px;
  color: var(--te-neutral-700);
  background: transparent;
}

.parametric-page-title h1 {
  color: var(--te-neutral-900);
}

.parametric-page-title p,
.parametric-context-status {
  color: var(--te-neutral-500);
}

:global(html[data-theme='pureWhite'] .parametric-pane) {
  background: transparent;
}

:global(html[data-theme='pureWhite'] .parametric-page-title h1) {
  color: var(--te-neutral-900);
}

.eq-page.is-parametric:not(.is-embedded) .eq-container {
  background: var(--te-app-bg);
  backdrop-filter: none;
}
.eq-page.is-parametric .eq-content {
  min-width: 0;
  min-height: 0;
  padding: 48px 14px 14px;
  gap: 0;
  overflow-y: auto;
}
.eq-page.is-parametric .parametric-pane {
  flex: 1;
  min-height: 0;
  gap: 0;
  animation: none;
}
.instrument-mode-switch {
  display: flex;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--eq-border-soft);
  border-radius: 6px;
  flex-shrink: 0;
}
.instrument-mode-switch button,
.instrument-power,
.instrument-auto-preamp,
.instrument-more button {
  border: 0;
  background: transparent;
  color: var(--eq-text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.instrument-mode-switch button {
  padding: 5px 10px;
  border-radius: 4px;
}
.instrument-mode-switch button.active {
  background: var(--eq-control-bg);
  color: var(--eq-text);
}
.instrument-presets {
  display: flex;
  justify-content: center;
  flex: 1;
  min-width: 0;
}
.instrument-presets .eq-command {
  border: 0;
  border-radius: 5px;
  padding: 6px 12px;
  background: transparent;
  color: var(--eq-text-muted);
  box-shadow: none;
  font-size: 11px;
}
.instrument-presets .preset-menu {
  width: 280px;
  max-width: calc(100vw - 48px);
  background: var(--eq-panel-raised);
  border-color: var(--eq-border);
  box-shadow: 0 12px 32px var(--eq-shadow);
  color: var(--eq-text);
}
.instrument-presets .preset-menu-item {
  color: var(--eq-text);
}
.instrument-presets .preset-menu-title,
.instrument-presets .preset-empty {
  color: var(--eq-text-subtle);
}
.instrument-presets .preset-menu-item:hover {
  color: var(--eq-response);
  background: var(--eq-control-bg);
}
.instrument-presets .preset-create {
  border-color: var(--eq-border-soft);
}
.instrument-presets .preset-create input {
  background: var(--eq-control-bg);
  color: var(--eq-text);
  border-color: var(--eq-border);
}
.instrument-presets .preset-create button {
  background: var(--eq-control-bg);
  color: var(--eq-response);
}
.instrument-power {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  white-space: nowrap;
}
.instrument-power.active i {
  color: var(--eq-response);
}
.instrument-more {
  position: relative;
  color: var(--eq-text-muted);
}
.instrument-more summary {
  display: grid;
  place-items: center;
  width: 26px;
  height: 28px;
  border-radius: 4px;
  cursor: pointer;
  list-style: none;
}
.instrument-more summary::-webkit-details-marker {
  display: none;
}
.instrument-more-menu {
  position: absolute;
  z-index: 50;
  top: calc(100% + 8px);
  right: 0;
  display: flex;
  flex-direction: column;
  width: 150px;
  padding: 5px;
  border: 1px solid var(--eq-border);
  border-radius: 8px;
  background: var(--eq-panel-raised);
  box-shadow: 0 10px 24px var(--eq-shadow);
}
.instrument-more-menu button {
  padding: 10px 12px;
  text-align: left;
  border-radius: 4px;
}
.instrument-more-menu button:hover {
  background: var(--eq-control-bg);
  color: var(--eq-response);
}
.instrument-auto-preamp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 0;
  white-space: nowrap;
}
.instrument-auto-preamp.active i {
  color: var(--eq-response);
}
.instrument-preamp {
  color: var(--eq-text-muted);
  font-family: var(--eq-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.instrument-preamp small {
  font-size: 9px;
  color: var(--eq-text-subtle);
}
.instrument-preamp input {
  width: 54px;
  padding: 3px 4px;
  border: 1px solid var(--eq-border-soft);
  border-radius: 4px;
  color: inherit;
  background: var(--eq-panel);
  font: inherit;
  text-align: right;
  appearance: textfield;
}
.instrument-preamp input::-webkit-inner-spin-button,
.instrument-preamp input::-webkit-outer-spin-button {
  appearance: none;
}
.instrument-preamp input:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.instrument-mode-switch button:focus-visible,
.instrument-power:focus-visible,
.instrument-auto-preamp:focus-visible,
.instrument-more summary:focus-visible,
.instrument-more button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}
@media (max-width: 820px) {
  .eq-page.is-parametric .eq-content {
    padding-inline: 8px;
    padding-bottom: 8px;
  }
  .eq-page.is-parametric .parametric-pane {
    min-height: 560px;
  }
  .instrument-power span {
    display: none;
  }
  .instrument-presets .preset-menu {
    left: auto;
    right: 0;
  }
}

/* Responsive fixes selected from PR #115; desktop styling stays in the rules above. */
@media (max-width: 820px) {
  .eq-page.is-parametric .eq-content {
    padding-inline: 8px;
  }
  .eq-page.is-parametric .parametric-pane {
    min-height: 560px;
  }
  .instrument-power span {
    display: none;
  }
  .instrument-presets .preset-menu {
    left: auto;
    right: 0;
  }
}
@media (max-width: 620px) {
  .eq-page:not(.is-parametric) .eq-container {
    flex-direction: column;
  }
  .eq-sidebar {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    padding: var(--te-page-top, 55px) var(--te-page-gutter, 16px) 12px;
    border-right: 0;
    border-bottom: 1px solid var(--te-glass-border);
  }
  .eq-sidebar .nav-item {
    flex-shrink: 0;
  }
  .eq-page:not(.is-parametric) .eq-content {
    padding-top: 20px;
  }
}

@media (max-width: 900px) {
  .eq-content {
    padding-bottom: var(--te-page-bottom, 32px);
  }
}

.eq-page.is-embedded {
  position: relative;
  inset: auto;
  z-index: auto;
  height: 100%;
  min-height: 0;
  background: transparent;
}
.eq-page.is-embedded .eq-mode-tabs {
  padding: 0;
}
.eq-page.is-embedded .eq-content {
  padding: 12px 0 24px;
  gap: 16px;
}
.eq-page.is-embedded .eq-toolbar-modern {
  margin-bottom: 0;
  gap: 8px;
}
.eq-page.is-embedded .eq-header {
  margin-bottom: 16px;
}
.eq-page.is-embedded :deep(.chart-card) {
  border-radius: 8px;
}
.eq-page.is-embedded :deep(.svg-container) {
  height: clamp(120px, 18vh, 160px);
}
.eq-page.is-embedded :deep(.sliders-board) {
  --te-graphic-slider-height: clamp(112px, 18vh, 148px);
  padding: 16px 8px;
  border-radius: 8px;
}
.eq-page.is-embedded :deep(.slider-column) {
  gap: 12px;
}
.eq-page.is-embedded :deep(.opra-panel) {
  border-radius: 8px;
}
.eq-page.is-embedded.is-parametric .eq-content {
  padding: 16px 0 24px;
}
.eq-apply-error {
  color: var(--te-danger-soft-fg);
  font-size: var(--te-type-body);
}
</style>
