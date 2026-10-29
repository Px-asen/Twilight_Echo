<script setup lang="ts">
import { createCoreAudioUi } from '@renderer/stores/player/coreAudioUi.ts'
import { useCoreConnection } from '@renderer/stores/coreConnection.ts'
import type { EqDisplayRange } from '@renderer/utils/eqViewport'
import { mergeEqualizerPatch } from '@renderer/utils/equalizerSettingsPatch'
import { useEqualizerHistory } from '@renderer/composables/useEqualizerHistory'
import type { EqSnapshot } from '@renderer/composables/useEqualizerHistory'
import { groupEqBandPatches } from '@renderer/utils/parametricEqSelection'
import type { EqBandPatch } from '@renderer/utils/parametricEqSelection'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useBackHandler } from '@renderer/app/useBackStack.ts'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import EqBandTable from '@renderer/components/equalizer/EqBandTable.vue'
import EqHistoryControls from '@renderer/components/equalizer/EqHistoryControls.vue'
import ParametricEqWorkspace from '@renderer/components/equalizer/ParametricEqWorkspace.vue'
import OpraEqPanel from '@renderer/components/equalizer/OpraEqPanel.vue'
import FrequencyResponseChart from '@renderer/components/equalizer/FrequencyResponseChart.vue'
import FrequencyResponseToolbar from '@renderer/components/equalizer/FrequencyResponseToolbar.vue'
import GraphicEqPanel from '@renderer/components/equalizer/GraphicEqPanel.vue'
import {
  EQ_RESPONSE_DEFAULT_SAMPLE_RATE,
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
import type { OpraProfile, OpraCatalogStatus } from '../../../shared/coreOpra.ts'

const core = useCoreConnection()
const coreAudio = createCoreAudioUi(core)
const props = defineProps<{
  embedded?: boolean
  visible?: boolean
  hostDocument?: Document
  activeSceneId?: string | null
}>()

type EqualizerTab = EqMode
type ResponseView = 'dsp' | 'headphone'
type HeadphoneCurveKey = 'source' | 'target' | 'individual' | 'combined' | 'corrected'
type EqApplyFeedback = 'idle' | 'editing' | 'applying' | 'applied' | 'failed'
const audioOutputDspStore = useAudioOutputDspStore()
const playerStore = usePlayerStore()
const {
  audioProcessing: projectedAudioProcessing,
  outputInfo,
  audioEngineReady
} = storeToRefs(audioOutputDspStore)
function structuredClone<T>(value: T): T {
  const raw = toRaw(value)
  try {
    return globalThis.structuredClone(raw)
  } catch {
    return JSON.parse(JSON.stringify(raw)) as T
  }
}

// prettier-ignore
const audioProcessing = ref<AudioProcessingSettings>(structuredClone(projectedAudioProcessing.value))
const { visualizationData, isPlaying, acquireVisualizationConsumer } = playerStore
const { setAudioProcessing } = audioOutputDspStore
// The spectrum overlay and level meters read visualizationData while this page
// is open; the store poll only runs while at least one consumer holds a handle.
let releaseVisualizationConsumer: (() => void) | null = null
let visualizationConsumerPoints = 0

const activeTab = ref<EqualizerTab>('graphic')
const autoPreampEnabled = ref(false)
const appSettings = ref<AppSettings | null>(null)
const presetName = ref('')
const presetError = ref('')
const editingPresetKey = ref('')
const editingPresetName = ref('')
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
const opraError = ref('')
let pendingBandFrame = 0
const pendingBandPatches = new Map<number, Partial<EqualizerBand>>()
let pendingPreamp: number | null = null
let commitChain: Promise<void> = Promise.resolve()
let activeEqApply: Promise<void> = Promise.resolve()
let applyFeedbackTimer: number | null = null
let spectrumPollingMounted = false
const eqHistory = useEqualizerHistory(audioProcessing.value, applyEqualizerSnapshot)
const { activeSlot, busy: historyBusy, canUndo, canRedo } = eqHistory
const historyLoading = ref(true)

const builtInPresets = computed<AudioEqPreset[]>(
  () => appSettings.value?.audioEqBuiltInPresets ?? builtInEqPresets
)
const hasCustomBuiltInPresets = computed(() =>
  Array.isArray(appSettings.value?.audioEqBuiltInPresets)
)
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

async function loadAutoPreampPreference(): Promise<void> {
  const dsp = await core.query('audio.dsp', {})
  autoPreampEnabled.value = dsp.autoPreamp?.enabled ?? false
  if (appSettings.value && dsp.headphoneCompensation) {
    appSettings.value = {
      ...appSettings.value,
      headphoneCompensation: {
        ...dsp.headphoneCompensation,
        bands: cloneBands(dsp.headphoneCompensation.bands ?? [])
      }
    }
  }
}

async function toggleAutoPreamp(): Promise<void> {
  finishParametricEdits()
  commitChain = commitChain.then(async () => {
    await runEqApply(async () => {
      const state = await core.query('audio.dsp', {})
      await core.command('audio.dsp.edit', {
        revision: state.revision,
        edit: { kind: 'autoPreamp', enabled: !autoPreampEnabled.value }
      })
      await refreshEqualizerProjection()
    })
  })
  await commitChain
}

async function refreshEqualizerProjection(): Promise<void> {
  await audioOutputDspStore.refreshAudioOutputState()
  audioProcessing.value = structuredClone(projectedAudioProcessing.value)
  await loadAutoPreampPreference()
}

let loadedSceneId: string | null = null
async function loadAppSettings(): Promise<void> {
  try {
    const settings = await window.api.settings.get()
    appSettings.value = {
      ...settings,
      audioProcessing: normalizeAudioProcessing(settings.audioProcessing),
      audioEqBuiltInPresets: Array.isArray(settings.audioEqBuiltInPresets)
        ? settings.audioEqBuiltInPresets.map((preset) => ({
            ...preset,
            eqBands: normalizeAudioProcessing({ eqMode: preset.eqMode, eqBands: preset.eqBands })
              .eqBands
          }))
        : null,
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
    // Clone the raw snapshot: the reactive store copy is a proxy and
    // structuredClone rejects proxies.
    audioProcessing.value = structuredClone(toRaw(appSettings.value).audioProcessing)
    const dspState = await coreAudio.getDspSceneState()
    applyActiveSceneEqToEditor(dspState)
    if (audioProcessing.value.eqMode === 'parametric') {
      activeTab.value = 'parametric'
    }
  } catch (err) {
    console.error('读取均衡器设置失败：', err instanceof Error ? err.stack : err)
  }
}

function applyActiveSceneEqToEditor(dspState: DspSceneState): void {
  loadedSceneId = dspState.activeSceneId
  // The scene EQ node holds the effective (OPRA-stacked) bands; never fold
  // those into the manual editor state or the next manual edit would persist
  // OPRA bands as user EQ and the engine would apply them twice.
  if (opraCompensationEnabled.value) return
  const scene = dspState.scenes.find((item) => item.id === dspState.activeSceneId)
  if (!scene) return
  const node = scene.graph.nodes.find((item) => item.type === 'equalizer')
  const params = node?.params ?? {}
  const settings = normalizeAudioProcessing({
    ...audioProcessing.value,
    dspEnabled: audioProcessing.value.dspEnabled,
    // The legacy default graph encodes the master gate into node.enabled.
    // Opening an editor while master-bypassed must not erase the EQ toggle.
    eqEnabled:
      scene.id === 'default' && !audioProcessing.value.dspEnabled
        ? audioProcessing.value.eqEnabled
        : (node?.enabled ?? false),
    eqMode: !node || params.mode === 'parametric' ? 'parametric' : 'graphic',
    eqPreamp: typeof params.preampDb === 'number' ? params.preampDb : 0,
    eqBands: Array.isArray(params.bands) ? (params.bands as EqualizerBand[]) : []
  })
  // normalizeAudioProcessing may reuse band arrays verbatim; those can be
  // reactive proxies, which structuredClone rejects. The settings payload is
  // plain JSON data, so a JSON round-trip is an exact deep copy here.
  audioProcessing.value = JSON.parse(JSON.stringify(settings))
  if (appSettings.value) appSettings.value.audioProcessing = settings
}

async function updateAudioProcessing(patch: Partial<AudioProcessingSettings>): Promise<void> {
  const nextSettings = normalizeAudioProcessing(mergeEqualizerPatch(audioProcessing.value, patch))
  // Keep an explicit gain edit manual even if an earlier Core reply re-enabled auto gain.
  if (patch.eqPreamp !== undefined) autoPreampEnabled.value = false
  await eqHistory.commit(nextSettings)
}

async function applyEqualizerSnapshot(snapshot: EqSnapshot): Promise<void> {
  if (props.embedded && loadedSceneId) {
    const current = await coreAudio.getDspSceneState()
    if (current.activeSceneId !== loadedSceneId)
      throw new Error('活动场景已改变，请等待均衡器重新载入后再调节。')
  }
  const edit: Partial<AudioProcessingSettings> = {
    ...snapshot,
    eqBands: cloneBands(snapshot.eqBands)
  }
  if (autoPreampEnabled.value) delete edit.eqPreamp
  await setAudioProcessing(edit, { throwOnError: true })
  await refreshEqualizerProjection()
  activeTab.value = audioProcessing.value.eqMode
  const indices = selectedBandIndices.value.filter((index) => audioProcessing.value.eqBands[index])
  selectBand(
    indices.includes(selectedBandIndex.value) ? selectedBandIndex.value : (indices.at(-1) ?? -1),
    indices
  )
  if (appSettings.value) {
    appSettings.value = {
      ...appSettings.value,
      audioProcessing: structuredClone(audioProcessing.value)
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
  const pending = (async () => {
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
  })()
  activeEqApply = pending
  await pending
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
  audioProcessing.value = {
    ...audioProcessing.value,
    eqPreamp: preamp,
    eqBands: bands
  }
  if (appSettings.value) {
    appSettings.value = { ...appSettings.value, audioProcessing: audioProcessing.value }
  }
}

function scheduleStagedFlush(): void {
  eqApplyFeedback.value = 'editing'
  if (pendingBandFrame !== 0) return
  pendingBandFrame = window.requestAnimationFrame(() => {
    pendingBandFrame = 0
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
    window.cancelAnimationFrame(pendingBandFrame)
    pendingBandFrame = 0
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
  if (!historyBusy.value && !clipboardBusy.value && !opraApplyingEqId.value) return
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
    props.visible !== false &&
    !(props.hostDocument ?? document).hidden &&
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
    spectrumPollingMounted &&
    props.visible !== false &&
    !(props.hostDocument ?? document).hidden &&
    activeTab.value === 'parametric'
      ? shouldPoll
        ? 2048
        : 64
      : 0
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
    const imported = await coreAudio.importFrequencyResponse()
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
    opraStatus.value = await core.query('opra.status', {})
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
    opraResults.value = await core.query('opra.search', { query: trimmed })
    opraStatus.value = await core.query('opra.status', {})
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
    opraStatus.value = (await core.command('opra.refresh', {})) as OpraCatalogStatus
    await searchOpraProfiles(opraQuery.value)
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraRefreshing.value = false
  }
}

async function applyOpraProfile(profile: OpraProfile): Promise<void> {
  if (!profile.applicable || opraApplyingEqId.value) return
  opraApplyingEqId.value = profile.eqId
  opraError.value = ''
  try {
    finishParametricEdits()
    await commitChain
    const fullProfile = (await core.query('opra.profile', { id: profile.eqId })) ?? profile
    if (!fullProfile.applicable) {
      opraError.value = `该 profile 包含暂不支持的滤波器：${fullProfile.unsupportedBandTypes.join(', ')}`
      return
    }
    const nextCompensation: HeadphoneCompensationSettings = {
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
    const dsp = await core.query('audio.dsp', {})
    await core.command('audio.dsp.edit', {
      revision: dsp.revision,
      edit: {
        kind: 'headphoneCompensation',
        settings: nextCompensation
      }
    })
    if (appSettings.value) {
      appSettings.value = { ...appSettings.value, headphoneCompensation: nextCompensation }
    }
    await refreshEqualizerProjection()
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraApplyingEqId.value = ''
  }
}

async function disableOpraCompensation(): Promise<void> {
  if (!appSettings.value || opraApplyingEqId.value) return
  opraApplyingEqId.value = '__disable__'
  opraError.value = ''
  try {
    finishParametricEdits()
    await commitChain
    const nextCompensation: HeadphoneCompensationSettings = {
      ...headphoneCompensation.value,
      enabled: false,
      bands: cloneBands(headphoneCompensation.value.bands)
    }
    const dsp = await core.query('audio.dsp', {})
    await core.command('audio.dsp.edit', {
      revision: dsp.revision,
      edit: {
        kind: 'headphoneCompensation',
        settings: nextCompensation
      }
    })
    appSettings.value = { ...appSettings.value, headphoneCompensation: nextCompensation }
    await refreshEqualizerProjection()
  } catch (err) {
    opraError.value = err instanceof Error ? err.message : String(err)
  } finally {
    opraApplyingEqId.value = ''
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
  presetError.value = ''
  try {
    const baseId = `custom-${Date.now()}`
    let nextId = baseId
    let suffix = 1
    while (userPresets.value.some((preset) => preset.id === nextId)) {
      nextId = `${baseId}-${suffix++}`
    }
    const nextPreset: AudioEqPreset = {
      id: nextId,
      name,
      eqMode: audioProcessing.value.eqMode,
      eqPreamp: audioProcessing.value.eqPreamp,
      eqBands: cloneBands(audioProcessing.value.eqBands)
    }
    appSettings.value = await window.api.settings.update({
      // contextBridge clones arguments before preload runs. Copy every band's
      // fields, including those belonging to previously saved reactive presets.
      audioEqPresets: [
        ...userPresets.value.map((preset) => ({ ...preset, eqBands: cloneBands(preset.eqBands) })),
        nextPreset
      ]
    })
    presetName.value = ''
    presetMenuOpen.value = true
  } catch (err) {
    presetError.value = `保存预设失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

function saveAsCurrentPreset(): void {
  void saveEqPreset()
}

function cloneEqPresets(presets: AudioEqPreset[]): AudioEqPreset[] {
  return presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    eqMode: preset.eqMode,
    eqPreamp: preset.eqPreamp,
    eqBands: cloneBands(preset.eqBands)
  }))
}

function startRenameEqPreset(scope: 'builtin' | 'custom', preset: AudioEqPreset): void {
  editingPresetKey.value = `${scope}:${preset.id}`
  editingPresetName.value = preset.name
  presetError.value = ''
}

function cancelRenameEqPreset(): void {
  editingPresetKey.value = ''
  editingPresetName.value = ''
}

async function renameEqPreset(
  scope: 'builtin' | 'custom',
  presetId: string,
  nextRawName = editingPresetName.value
): Promise<void> {
  const name = nextRawName.trim().slice(0, 40)
  if (!name) {
    presetError.value = '预设名称不能为空'
    return
  }
  if (!appSettings.value || saving.value) return
  const source = scope === 'builtin' ? builtInPresets.value : userPresets.value
  if (!source.some((preset) => preset.id === presetId)) {
    cancelRenameEqPreset()
    return
  }
  saving.value = true
  presetError.value = ''
  try {
    const nextPresets = cloneEqPresets(source).map((preset) =>
      preset.id === presetId ? { ...preset, name } : preset
    )
    appSettings.value = await window.api.settings.update(
      scope === 'builtin' ? { audioEqBuiltInPresets: nextPresets } : { audioEqPresets: nextPresets }
    )
    editingPresetKey.value = ''
    editingPresetName.value = ''
    presetMenuOpen.value = true
  } catch (err) {
    presetError.value = `修改预设失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

async function updateEqPreset(scope: 'builtin' | 'custom', presetId: string): Promise<void> {
  finishParametricEdits()
  await commitChain
  if (!appSettings.value || saving.value) return
  const source = scope === 'builtin' ? builtInPresets.value : userPresets.value
  if (!source.some((preset) => preset.id === presetId)) return
  const activeEditKey = `${scope}:${presetId}`
  const pendingName =
    editingPresetKey.value === activeEditKey ? editingPresetName.value.trim().slice(0, 40) : ''
  saving.value = true
  presetError.value = ''
  try {
    const nextPresets = cloneEqPresets(source).map((preset) =>
      preset.id === presetId
        ? {
            ...preset,
            name: pendingName || preset.name,
            eqMode: audioProcessing.value.eqMode,
            eqPreamp: audioProcessing.value.eqPreamp,
            eqBands: cloneBands(audioProcessing.value.eqBands)
          }
        : preset
    )
    appSettings.value = await window.api.settings.update(
      scope === 'builtin' ? { audioEqBuiltInPresets: nextPresets } : { audioEqPresets: nextPresets }
    )
    if (editingPresetKey.value === activeEditKey) {
      editingPresetKey.value = ''
      editingPresetName.value = ''
    }
    presetMenuOpen.value = true
  } catch (err) {
    presetError.value = `修改预设失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

async function deleteEqPreset(scope: 'builtin' | 'custom', presetId: string): Promise<void> {
  if (!appSettings.value || saving.value) return
  const source = scope === 'builtin' ? builtInPresets.value : userPresets.value
  const filtered = source.filter((preset) => preset.id !== presetId)
  if (filtered.length === source.length) return
  saving.value = true
  presetError.value = ''
  try {
    const nextPresets = cloneEqPresets(filtered)
    appSettings.value = await window.api.settings.update(
      scope === 'builtin' ? { audioEqBuiltInPresets: nextPresets } : { audioEqPresets: nextPresets }
    )
    if (editingPresetKey.value === `${scope}:${presetId}`) {
      editingPresetKey.value = ''
      editingPresetName.value = ''
    }
    presetMenuOpen.value = true
  } catch (err) {
    presetError.value = `删除预设失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

async function restoreBuiltInEqPresets(): Promise<void> {
  if (!appSettings.value || saving.value) return
  saving.value = true
  presetError.value = ''
  try {
    appSettings.value = await window.api.settings.update({
      audioEqBuiltInPresets: null
    })
    if (editingPresetKey.value.startsWith('builtin:')) {
      editingPresetKey.value = ''
      editingPresetName.value = ''
    }
    presetMenuOpen.value = true
  } catch (err) {
    presetError.value = `恢复默认预设失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

async function switchTab(tab: EqualizerTab): Promise<void> {
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
  computed(() => !props.embedded && activeTab.value === 'parametric'),
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
  if (presetMenuOpen.value) {
    filterMenuOpen.value = false
  } else {
    cancelRenameEqPreset()
  }
}

function onEqualizerPointerDown(event: PointerEvent): void {
  if (!presetMenuOpen.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.preset-menu-anchor')) return
  presetMenuOpen.value = false
  cancelRenameEqPreset()
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

watch(
  () => props.activeSceneId,
  async (sceneId) => {
    if (!props.embedded || !sceneId || !loadedSceneId || sceneId === loadedSceneId) return
    historyLoading.value = true
    finishParametricEdits()
    await commitChain
    await activeEqApply
    await loadAppSettings()
    eqHistory.reset(audioProcessing.value)
    historyLoading.value = false
  }
)

onMounted(() => {
  spectrumPollingMounted = true
  void loadAutoPreampPreference()
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
  if (pendingBandFrame !== 0) window.cancelAnimationFrame(pendingBandFrame)
})

watch(projectedAudioProcessing, (value) => {
  if (eqApplyFeedback.value !== 'editing' && eqApplyFeedback.value !== 'applying')
    audioProcessing.value = structuredClone(value)
})

watch(
  [
    activeTab,
    spectrumVisible,
    responseView,
    isPlaying,
    spectrumFrozen,
    () => props.visible,
    () => props.hostDocument
  ],
  updateSpectrumPolling
)
watch(
  () => props.hostDocument,
  (next, previous) => {
    previous?.removeEventListener('visibilitychange', updateSpectrumPolling)
    ;(next ?? document).addEventListener('visibilitychange', updateSpectrumPolling)
  }
)
onMounted(() =>
  (props.hostDocument ?? document).addEventListener('visibilitychange', updateSpectrumPolling)
)
onBeforeUnmount(() =>
  (props.hostDocument ?? document).removeEventListener('visibilitychange', updateSpectrumPolling)
)
defineExpose({
  busy: computed(
    () =>
      historyLoading.value || historyBusy.value || clipboardBusy.value || !!opraApplyingEqId.value
  ),
  requestLeave: async () => {
    finishParametricEdits()
    await commitChain
    await activeEqApply
    return (
      !historyLoading.value &&
      !clipboardBusy.value &&
      !opraApplyingEqId.value &&
      eqApplyFeedback.value !== 'failed'
    )
  }
})
</script>

<template>
  <div
    class="eq-page"
    :class="{ 'is-parametric': activeTab === 'parametric', 'eq-embedded': embedded }"
    @keydown="onEqualizerKeydown"
    @pointerdown="onEqualizerPointerDown"
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
      <aside v-if="activeTab !== 'parametric' && !embedded" class="eq-sidebar">
        <div
          v-for="tab in tabs"
          :key="tab.key"
          class="nav-item"
          data-te-interactive
          role="button"
          tabindex="0"
          :aria-pressed="activeTab === tab.key"
          :class="{ active: activeTab === tab.key }"
          @click="switchTab(tab.key)"
          @keydown.enter.prevent="switchTab(tab.key)"
          @keydown.space.prevent="switchTab(tab.key)"
        >
          <i :class="tab.icon"></i>
          <div class="nav-info">
            <span>{{ tab.label }}</span
            ><small>{{ tab.desc }}</small>
          </div>
        </div>
      </aside>

      <main class="eq-content">
        <p v-if="presetError" class="preset-error" role="alert">{{ presetError }}</p>
        <!-- Toolbar for Presets across Graphic and Parametric -->
        <div v-if="activeTab !== 'parametric'" class="eq-toolbar-modern">
          <div v-if="embedded" class="instrument-mode-switch" aria-label="均衡器模式">
            <button type="button" class="active" :aria-pressed="true">图形</button>
            <button type="button" :aria-pressed="false" @click="openAdvancedSettings()">
              参数
            </button>
          </div>
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
            <div v-if="presetMenuOpen" class="preset-menu">
              <div class="preset-menu-section">
                <div class="preset-section-header">
                  <span class="preset-menu-title">内置预设</span>
                  <button
                    v-if="hasCustomBuiltInPresets"
                    type="button"
                    class="preset-restore-btn"
                    :disabled="saving"
                    title="恢复默认内置预设"
                    @click.stop="restoreBuiltInEqPresets"
                  >
                    恢复默认
                  </button>
                </div>
                <div v-for="preset in builtInPresets" :key="preset.id" class="preset-menu-row">
                  <template v-if="editingPresetKey === `builtin:${preset.id}`">
                    <input
                      v-model="editingPresetName"
                      type="text"
                      class="preset-rename-input"
                      maxlength="40"
                      aria-label="预设名称"
                      @keydown.enter.prevent="renameEqPreset('builtin', preset.id)"
                      @keydown.esc.stop.prevent="cancelRenameEqPreset"
                    />
                    <div class="preset-item-actions is-editing">
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving || !editingPresetName.trim()"
                        title="保存名称"
                        aria-label="保存名称"
                        @click.stop="renameEqPreset('builtin', preset.id)"
                      >
                        <i class="pi pi-check"></i>
                      </button>
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving"
                        title="取消重命名"
                        aria-label="取消重命名"
                        @click.stop="cancelRenameEqPreset"
                      >
                        <i class="pi pi-times"></i>
                      </button>
                    </div>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="preset-menu-item"
                      :title="preset.name"
                      @click="applyEqPreset(preset)"
                    >
                      {{ preset.name }}
                    </button>
                    <div class="preset-item-actions">
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving"
                        title="将当前均衡器参数更新到此预设"
                        aria-label="更新预设参数"
                        @click.stop="updateEqPreset('builtin', preset.id)"
                      >
                        <i class="pi pi-sync"></i>
                      </button>
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving"
                        title="重命名预设"
                        aria-label="重命名预设"
                        @click.stop="startRenameEqPreset('builtin', preset)"
                      >
                        <i class="pi pi-pencil"></i>
                      </button>
                      <button
                        type="button"
                        class="preset-action-btn is-danger"
                        :disabled="saving"
                        title="删除预设"
                        aria-label="删除预设"
                        @click.stop="deleteEqPreset('builtin', preset.id)"
                      >
                        <i class="pi pi-trash"></i>
                      </button>
                    </div>
                  </template>
                </div>
                <span v-if="builtInPresets.length === 0" class="preset-empty">暂无内置预设</span>
              </div>
              <div class="preset-menu-section">
                <div class="preset-section-header">
                  <span class="preset-menu-title">自定义预设</span>
                </div>
                <div v-for="preset in userPresets" :key="preset.id" class="preset-menu-row">
                  <template v-if="editingPresetKey === `custom:${preset.id}`">
                    <input
                      v-model="editingPresetName"
                      type="text"
                      class="preset-rename-input"
                      maxlength="40"
                      aria-label="预设名称"
                      @keydown.enter.prevent="renameEqPreset('custom', preset.id)"
                      @keydown.esc.stop.prevent="cancelRenameEqPreset"
                    />
                    <div class="preset-item-actions is-editing">
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving || !editingPresetName.trim()"
                        title="保存名称"
                        aria-label="保存名称"
                        @click.stop="renameEqPreset('custom', preset.id)"
                      >
                        <i class="pi pi-check"></i>
                      </button>
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving"
                        title="取消重命名"
                        aria-label="取消重命名"
                        @click.stop="cancelRenameEqPreset"
                      >
                        <i class="pi pi-times"></i>
                      </button>
                    </div>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="preset-menu-item"
                      :title="preset.name"
                      @click="applyEqPreset(preset)"
                    >
                      {{ preset.name }}
                    </button>
                    <div class="preset-item-actions">
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving"
                        title="将当前均衡器参数更新到此预设"
                        aria-label="更新预设参数"
                        @click.stop="updateEqPreset('custom', preset.id)"
                      >
                        <i class="pi pi-sync"></i>
                      </button>
                      <button
                        type="button"
                        class="preset-action-btn"
                        :disabled="saving"
                        title="重命名预设"
                        aria-label="重命名预设"
                        @click.stop="startRenameEqPreset('custom', preset)"
                      >
                        <i class="pi pi-pencil"></i>
                      </button>
                      <button
                        type="button"
                        class="preset-action-btn is-danger"
                        :disabled="saving"
                        title="删除预设"
                        aria-label="删除预设"
                        @click.stop="deleteEqPreset('custom', preset.id)"
                      >
                        <i class="pi pi-trash"></i>
                      </button>
                    </div>
                  </template>
                </div>
                <span v-if="userPresets.length === 0" class="preset-empty">暂无自定义预设</span>
              </div>
              <div class="preset-create">
                <input
                  v-model="presetName"
                  type="text"
                  maxlength="40"
                  placeholder="新建预设名称"
                  @keydown.enter.prevent="saveEqPreset"
                />
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
            v-if="activeTab === 'graphic' && !embedded"
            type="button"
            class="eq-command"
            @click="openAdvancedSettings()"
          >
            高级设置
          </button>
          <button
            v-else-if="activeTab !== 'graphic'"
            type="button"
            class="eq-command"
            @click="switchTab('graphic')"
          >
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
          <!-- The workbench hides the page header, so its EQ switch moves into the toolbar. -->
          <div
            v-if="embedded"
            class="master-switch toolbar-master-switch"
            data-te-interactive
            role="switch"
            tabindex="0"
            aria-label="启用均衡器"
            :aria-checked="audioProcessing.eqEnabled"
            :class="{ off: !audioProcessing.eqEnabled }"
            @click="toggleParametricEq()"
            @keydown.enter.prevent="toggleParametricEq()"
            @keydown.space.prevent="toggleParametricEq()"
          >
            {{ audioProcessing.eqEnabled ? '已启用' : '已关闭' }}
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </div>
        </div>

        <div v-if="activeTab === 'graphic'" class="tab-pane active">
          <header v-if="!embedded" class="eq-header">
            <div class="eq-title">
              <h1>图形均衡器</h1>
              <p>调整此面板会改变最终输出。</p>
            </div>
            <div
              class="master-switch"
              data-te-interactive
              role="switch"
              tabindex="0"
              aria-label="启用均衡器"
              :aria-checked="audioProcessing.eqEnabled"
              :class="{ off: !audioProcessing.eqEnabled }"
              @click="toggleParametricEq()"
              @keydown.enter.prevent="toggleParametricEq()"
              @keydown.space.prevent="toggleParametricEq()"
            >
              {{ audioProcessing.eqEnabled ? '已启用' : '已关闭' }}
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </div>
          </header>

          <OpraEqPanel
            v-if="!embedded"
            :compensation="headphoneCompensation"
            :status="opraStatus"
            :searching="opraSearching"
            :refreshing="opraRefreshing"
            :applying-eq-id="opraApplyingEqId"
            :results="opraResults"
            :error="opraError"
            :query="opraQuery"
            @update:query="opraQuery = $event"
            @search="searchOpraProfiles"
            @select="applyOpraProfile"
            @clear="disableOpraCompensation"
            @refresh="refreshOpraCatalog"
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

          <GraphicEqPanel
            :preamp="audioProcessing.eqPreamp"
            :bands="audioProcessing.eqBands"
            :auto-preamp-enabled="autoPreampEnabled"
            @preview-preamp="stagePreamp"
            @preview-band="stageBandPatch"
            @commit="commitStagedBands"
            @advanced="openAdvancedSettings"
          />
        </div>

        <div v-else-if="activeTab === 'parametric'" class="tab-pane active parametric-pane">
          <ParametricEqWorkspace
            ref="parametricWorkspaceRef"
            :docked-inspector="embedded"
            :host-document="hostDocument"
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
              <div class="instrument-mode-switch" aria-label="均衡器模式">
                <button type="button" :aria-pressed="false" @click="switchTab('graphic')">
                  图形
                </button>
                <button type="button" class="active" :aria-pressed="true">参数</button>
              </div>
              <div class="instrument-presets">
                <div class="preset-menu-anchor">
                  <button
                    type="button"
                    class="eq-command preset-menu-button"
                    @click="togglePresetMenu"
                  >
                    选择预设 <i class="pi pi-chevron-down"></i>
                  </button>
                  <div v-if="presetMenuOpen" class="preset-menu">
                    <div class="preset-menu-section">
                      <div class="preset-section-header">
                        <span class="preset-menu-title">内置预设</span>
                        <button
                          v-if="hasCustomBuiltInPresets"
                          type="button"
                          class="preset-restore-btn"
                          :disabled="saving"
                          title="恢复默认内置预设"
                          @click.stop="restoreBuiltInEqPresets"
                        >
                          恢复默认
                        </button>
                      </div>
                      <div
                        v-for="preset in builtInPresets"
                        :key="preset.id"
                        class="preset-menu-row"
                      >
                        <template v-if="editingPresetKey === `builtin:${preset.id}`">
                          <input
                            v-model="editingPresetName"
                            type="text"
                            class="preset-rename-input"
                            maxlength="40"
                            aria-label="预设名称"
                            @keydown.enter.prevent="renameEqPreset('builtin', preset.id)"
                            @keydown.esc.stop.prevent="cancelRenameEqPreset"
                          />
                          <div class="preset-item-actions is-editing">
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving || !editingPresetName.trim()"
                              title="保存名称"
                              aria-label="保存名称"
                              @click.stop="renameEqPreset('builtin', preset.id)"
                            >
                              <i class="pi pi-check"></i>
                            </button>
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving"
                              title="取消重命名"
                              aria-label="取消重命名"
                              @click.stop="cancelRenameEqPreset"
                            >
                              <i class="pi pi-times"></i>
                            </button>
                          </div>
                        </template>
                        <template v-else>
                          <button
                            type="button"
                            class="preset-menu-item"
                            :title="preset.name"
                            @click="applyEqPreset(preset)"
                          >
                            {{ preset.name }}
                          </button>
                          <div class="preset-item-actions">
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving"
                              title="将当前均衡器参数更新到此预设"
                              aria-label="更新预设参数"
                              @click.stop="updateEqPreset('builtin', preset.id)"
                            >
                              <i class="pi pi-sync"></i>
                            </button>
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving"
                              title="重命名预设"
                              aria-label="重命名预设"
                              @click.stop="startRenameEqPreset('builtin', preset)"
                            >
                              <i class="pi pi-pencil"></i>
                            </button>
                            <button
                              type="button"
                              class="preset-action-btn is-danger"
                              :disabled="saving"
                              title="删除预设"
                              aria-label="删除预设"
                              @click.stop="deleteEqPreset('builtin', preset.id)"
                            >
                              <i class="pi pi-trash"></i>
                            </button>
                          </div>
                        </template>
                      </div>
                      <span v-if="builtInPresets.length === 0" class="preset-empty"
                        >暂无内置预设</span
                      >
                    </div>
                    <div class="preset-menu-section">
                      <div class="preset-section-header">
                        <span class="preset-menu-title">自定义预设</span>
                      </div>
                      <div v-for="preset in userPresets" :key="preset.id" class="preset-menu-row">
                        <template v-if="editingPresetKey === `custom:${preset.id}`">
                          <input
                            v-model="editingPresetName"
                            type="text"
                            class="preset-rename-input"
                            maxlength="40"
                            aria-label="预设名称"
                            @keydown.enter.prevent="renameEqPreset('custom', preset.id)"
                            @keydown.esc.stop.prevent="cancelRenameEqPreset"
                          />
                          <div class="preset-item-actions is-editing">
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving || !editingPresetName.trim()"
                              title="保存名称"
                              aria-label="保存名称"
                              @click.stop="renameEqPreset('custom', preset.id)"
                            >
                              <i class="pi pi-check"></i>
                            </button>
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving"
                              title="取消重命名"
                              aria-label="取消重命名"
                              @click.stop="cancelRenameEqPreset"
                            >
                              <i class="pi pi-times"></i>
                            </button>
                          </div>
                        </template>
                        <template v-else>
                          <button
                            type="button"
                            class="preset-menu-item"
                            :title="preset.name"
                            @click="applyEqPreset(preset)"
                          >
                            {{ preset.name }}
                          </button>
                          <div class="preset-item-actions">
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving"
                              title="将当前均衡器参数更新到此预设"
                              aria-label="更新预设参数"
                              @click.stop="updateEqPreset('custom', preset.id)"
                            >
                              <i class="pi pi-sync"></i>
                            </button>
                            <button
                              type="button"
                              class="preset-action-btn"
                              :disabled="saving"
                              title="重命名预设"
                              aria-label="重命名预设"
                              @click.stop="startRenameEqPreset('custom', preset)"
                            >
                              <i class="pi pi-pencil"></i>
                            </button>
                            <button
                              type="button"
                              class="preset-action-btn is-danger"
                              :disabled="saving"
                              title="删除预设"
                              aria-label="删除预设"
                              @click.stop="deleteEqPreset('custom', preset.id)"
                            >
                              <i class="pi pi-trash"></i>
                            </button>
                          </div>
                        </template>
                      </div>
                      <span v-if="userPresets.length === 0" class="preset-empty"
                        >暂无自定义预设</span
                      >
                    </div>
                    <div class="preset-create">
                      <input
                        v-model="presetName"
                        type="text"
                        maxlength="40"
                        placeholder="新建预设名称"
                        @keydown.enter.prevent="saveEqPreset"
                      />
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
                <span>前级</span>
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
          <EqBandTable
            v-if="embedded"
            :bands="audioProcessing.eqBands"
            :selected-indices="selectedBandIndices"
            caption="手动 EQ 频段 · 不含 OPRA 补偿"
            @select="selectBand"
            @patch="
              (index, patch) => {
                stageBandPatch(index, patch)
                void commitStagedBands()
              }
            "
            @remove="deleteBand"
          />
        </div>
        <details v-if="embedded" class="workbench-opra">
          <summary>
            耳机补偿 · OPRA
            <span v-if="opraCompensationEnabled">{{ headphoneCompensation.productName }}</span>
          </summary>
          <OpraEqPanel
            :compensation="headphoneCompensation"
            :status="opraStatus"
            :searching="opraSearching"
            :refreshing="opraRefreshing"
            :applying-eq-id="opraApplyingEqId"
            :results="opraResults"
            :error="opraError"
            :query="opraQuery"
            @update:query="opraQuery = $event"
            @search="searchOpraProfiles"
            @select="applyOpraProfile"
            @clear="disableOpraCompensation"
            @refresh="refreshOpraCatalog"
          />
        </details>
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
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
}

:global(html[data-theme='dark'] .eq-page) {
  background-color: var(--te-app-bg);
  background-image: var(--te-app-bg-image);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}

.eq-toolbar-modern {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 20px 0;
  border-bottom: 1px solid rgba(15, 23, 42, 0.06);
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.preset-error {
  margin: 0 0 12px;
  color: var(--te-danger-soft-fg);
  overflow-wrap: anywhere;
}

.eq-command {
  background: var(--te-glass-bg);
  border: 1px solid var(--te-glass-border);
  padding: 8px 16px;
  border-radius: 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  color: var(--te-neutral-700);
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
  background: var(--te-card-bg);
  border-color: var(--te-primary-400);
  color: var(--te-primary-500);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.1);
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
  background: rgba(var(--te-primary-rgb), 0.1);
  border-color: var(--te-primary-400);
  color: var(--te-primary-500);
}

.preset-menu-anchor {
  position: relative;
}

.preset-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  background: var(--te-glass-bg-strong);
  backdrop-filter: blur(20px);
  border: 1px solid var(--te-glass-border);
  border-radius: 16px;
  box-shadow: 0 10px 40px rgba(15, 23, 42, 0.14);
  padding: 12px;
  width: 296px;
  max-width: calc(100vw - 32px);
  max-height: min(440px, calc(100vh - 160px));
  overflow-y: auto;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.preset-menu-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preset-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 4px;
}

.preset-menu-title {
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 700;
  color: var(--te-neutral-400);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.preset-restore-btn {
  background: transparent;
  border: none;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 600;
  color: var(--te-primary-500);
  cursor: pointer;
  transition:
    background-color 0.18s var(--te-ease-soft),
    color 0.18s var(--te-ease-soft);
}

.preset-restore-btn:hover:not(:disabled) {
  background: var(--te-primary-50);
  color: var(--te-primary-600);
}

.preset-restore-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.preset-menu-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  padding-right: 4px;
  transition: background-color 0.2s var(--te-ease-soft);
}

.preset-menu-row:hover,
.preset-menu-row:focus-within {
  background: var(--te-primary-50);
}

.preset-menu-item {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  border: none;
  padding: 7px 8px;
  text-align: left;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  color: var(--te-neutral-700);
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.2s var(--te-ease-soft);
}

.preset-menu-row:hover .preset-menu-item,
.preset-menu-item:focus-visible {
  color: var(--te-primary-600);
}

.preset-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.preset-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--te-neutral-400);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  cursor: pointer;
  transition:
    background-color 0.18s var(--te-ease-soft),
    color 0.18s var(--te-ease-soft);
}

.preset-menu-row:hover .preset-action-btn,
.preset-item-actions.is-editing .preset-action-btn {
  color: var(--te-neutral-600);
}

.preset-action-btn:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.07);
  color: var(--te-primary-600);
}

.preset-action-btn.is-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}

.preset-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.preset-rename-input {
  flex: 1;
  min-width: 0;
  background: var(--te-card-bg);
  color: var(--te-neutral-800);
  border: 1px solid var(--te-primary-400);
  border-radius: 7px;
  padding: 5px 8px;
  margin: 3px 0 3px 4px;
  font-size: calc(var(--te-font-size-body, 14px) * 12.5 / 14);
  font-weight: 500;
  outline: none;
}

.preset-empty {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: var(--te-neutral-400);
  padding: 4px 8px;
}

.preset-create {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--te-glass-border);
}

.preset-create input {
  flex: 1;
  background: rgba(15, 23, 42, 0.04);
  color: var(--te-neutral-800);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  outline: none;
  transition:
    background-color 0.2s var(--te-ease-soft),
    border-color 0.2s var(--te-ease-soft);
  width: 100%;
}

.preset-create input:focus {
  background: var(--te-card-bg);
  border-color: var(--te-primary-400);
}

.preset-create button {
  background: var(--te-primary-500);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 0 12px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
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

.eq-container {
  width: 100%;
  height: 100%;
  margin: 0;
  max-width: none;
  background: var(--te-glass-bg);
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  border: none;
  border-radius: 0;
  box-shadow: none;
  display: flex;
  overflow: hidden;
}

/* Sidebar Navigation */
.eq-sidebar {
  width: 240px;
  background: var(--te-glass-bg);
  border-right: 1px solid var(--te-glass-border);
  padding: 90px 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 16px;
  cursor: pointer;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft);
  color: var(--te-neutral-500);
}
.nav-item:hover {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}
.nav-item.active {
  background: var(--te-active-bg);
  color: var(--te-primary-500);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
  border: 1px solid var(--te-card-border);
}
.nav-item i {
  font-size: 1.2rem;
  background: var(--te-subtle-bg);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  transition:
    background-color var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft),
    border-color var(--te-motion-hover) var(--te-ease-soft);
}
.nav-item.active i {
  background: rgba(var(--te-primary-rgb), 0.1);
  color: var(--te-primary-500);
}
.nav-info {
  display: flex;
  flex-direction: column;
}
.nav-info span {
  font-weight: 700;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}
.nav-info small {
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 500;
  opacity: 0.7;
}

/* Content Area */
.eq-content {
  flex: 1;
  padding: 40px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 30px;
  min-height: 0;
  min-width: 0;
}
.tab-pane {
  display: none;
  flex-direction: column;
  gap: 30px;
  animation: fadeIn 0.4s var(--te-ease-soft);
}
.tab-pane.active {
  display: flex;
}
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.eq-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
}
.eq-title h1 {
  font-size: calc(var(--te-font-size-body, 14px) * 28 / 14);
  font-weight: 800;
  letter-spacing: -0.5px;
  margin-bottom: 6px;
}
.eq-title p {
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 500;
}

.master-switch {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--te-card-bg);
  padding: 8px 16px 8px 20px;
  border-radius: 999px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
  border: 1px solid var(--te-card-border);
  font-weight: 700;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  color: var(--te-primary-500);
  cursor: pointer;
  transition: color 0.2s;
}
.master-switch.off {
  color: var(--te-neutral-500);
}
.toggle-track {
  width: 36px;
  height: 20px;
  background: var(--dsp-text, var(--te-neutral-900));
  border-radius: 999px;
  position: relative;
  transition: background 0.2s;
}
.master-switch.off .toggle-track {
  background: var(--dsp-line-strong, rgba(15, 23, 42, 0.16));
}
.toggle-thumb {
  width: 16px;
  height: 16px;
  background: var(--dsp-surface-solid, #fff); /* keep-white: toggle knob */
  border-radius: 50%;
  position: absolute;
  top: 2px;
  right: 2px;
  box-shadow: none;
  transition:
    right 0.2s,
    left 0.2s;
}
.master-switch.off .toggle-thumb {
  right: auto;
  left: 2px;
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
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
  font-weight: 800;
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
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
  font-weight: 760;
  line-height: 1.15;
  letter-spacing: -0.02em;
}

.parametric-page-title p {
  overflow: hidden;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
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
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 700;
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
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
  color: var(--te-neutral-500);
}
.param-group input,
.param-group select {
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  padding: 12px 16px;
  border-radius: 12px;
  font-family: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 600;
  color: var(--te-neutral-900);
  outline: none;
  width: 100%;
}
.param-group input:focus,
.param-group select:focus {
  border-color: var(--te-primary-500);
  box-shadow: 0 0 0 3px rgba(var(--te-primary-rgb), 0.1);
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
  font-size: calc(var(--te-font-size-body, 14px) * 24 / 14);
  font-weight: 800;
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
    font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
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
  color: var(--te-neutral-50);
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

.eq-page.is-parametric .eq-container {
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
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
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
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
}
.instrument-presets .preset-menu {
  width: 304px;
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
.instrument-presets .preset-restore-btn {
  color: var(--eq-response);
}
.instrument-presets .preset-restore-btn:hover:not(:disabled) {
  background: var(--eq-control-bg);
  color: var(--eq-response);
}
.instrument-presets .preset-menu-row:hover,
.instrument-presets .preset-menu-row:focus-within {
  background: var(--eq-control-bg);
}
.instrument-presets .preset-menu-row:hover .preset-menu-item,
.instrument-presets .preset-menu-item:focus-visible {
  color: var(--eq-response);
}
.instrument-presets .preset-action-btn {
  color: var(--eq-text-subtle);
}
.instrument-presets .preset-menu-row:hover .preset-action-btn,
.instrument-presets .preset-item-actions.is-editing .preset-action-btn {
  color: var(--eq-text-muted);
}
.instrument-presets .preset-action-btn:hover:not(:disabled) {
  background: var(--eq-panel);
  color: var(--eq-response);
}
.instrument-presets .preset-action-btn.is-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.16);
  color: #f87171;
}
.instrument-presets .preset-rename-input {
  background: var(--eq-control-bg);
  color: var(--eq-text);
  border-color: var(--eq-response);
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--eq-text-muted);
  font-family: var(--eq-mono);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.instrument-preamp span {
  font-family: var(--te-font-sans);
  color: var(--eq-text-subtle);
}
.instrument-preamp small {
  font-size: calc(var(--te-font-size-body, 14px) * 9 / 14);
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
  outline: 2px solid var(--eq-response);
  outline-offset: 2px;
}
.instrument-mode-switch button:focus-visible,
.instrument-power:focus-visible,
.instrument-auto-preamp:focus-visible,
.instrument-more summary:focus-visible,
.instrument-more button:focus-visible {
  outline: 2px solid var(--eq-response);
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
    padding-bottom: max(40px, calc(var(--te-playbar-bottom-clearance, 0px) + 16px));
  }
}
</style>

<style scoped>
/* Embedded views share the workbench's materials; standalone EQ is unchanged. */
.eq-page.eq-embedded {
  position: relative;
  inset: auto;
  z-index: auto;
  height: auto;
  overflow: visible;
  color: var(--dsp-text);
  background: transparent;
  backdrop-filter: none;
  font-family: var(--te-font-sans);
  font-size: var(--dsp-t14);
  line-height: 1.5;
}
.eq-page.eq-embedded .eq-container {
  height: auto;
  min-height: 0;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
}
.eq-page.eq-embedded .eq-content {
  min-width: 0;
  padding: 0;
  overflow: visible;
  gap: 0;
  border: 1px solid var(--dsp-line);
  border-radius: var(--dsp-radius);
  background: var(--dsp-surface);
}
.eq-page.eq-embedded .tab-pane {
  gap: 0;
  animation: none;
}
.eq-page.eq-embedded .parametric-pane {
  gap: 0;
}
.eq-embedded .parametric-pane > :deep(.parametric-workspace) {
  --eq-surface: var(--dsp-surface-solid);
  --eq-surface-end: var(--dsp-surface-solid);
  --eq-panel: var(--dsp-sunken);
  --eq-panel-raised: var(--dsp-raised);
  --eq-text: var(--dsp-text);
  --eq-text-muted: var(--dsp-muted);
  --eq-text-subtle: var(--dsp-muted);
  --eq-border: var(--dsp-line-strong);
  --eq-border-soft: var(--dsp-line);
  --eq-grid: color-mix(in srgb, var(--dsp-text) 4%, transparent);
  --eq-grid-major: var(--dsp-line);
  --eq-zero-axis: var(--dsp-line-strong);
  --eq-response: var(--dsp-signal);
  --eq-spectrum: var(--dsp-muted);
  --eq-control-bg: var(--dsp-hover);
  --eq-shadow: transparent;
  --eq-highlight: var(--dsp-raised);
  --eq-knob-light: var(--dsp-surface-solid);
  --eq-knob-dark: var(--dsp-hover);
  --eq-knob-track: var(--dsp-line-strong);
  --eq-knob-edge: var(--dsp-line-strong);
  --eq-meter: var(--dsp-good);
  --eq-color-scheme: var(--te-image-color-scheme, normal);
  flex: none;
  min-height: 490px;
  border-radius: 0;
  border: 0;
  box-shadow: none;
}
.eq-embedded :deep(.parametric-stage-header) {
  padding: 10px 18px;
  min-height: 48px;
  background: var(--dsp-sunken);
  border-bottom: 1px solid var(--dsp-line);
  gap: 12px;
}
.eq-embedded :deep(.stage-commands) {
  gap: 10px;
}
.eq-embedded :deep(.parametric-graph-frame) {
  min-height: 340px;
  background: var(--dsp-surface);
}
.eq-embedded :deep(.analyzer-footer) {
  padding: 8px 18px;
  min-height: 44px;
  background: var(--dsp-sunken);
  border-top: 1px solid var(--dsp-line);
}
.eq-embedded :deep(.analyzer-footer > .response-view-toolbar) {
  padding-left: 12px;
  border-left: 1px solid var(--dsp-line);
}
.eq-embedded :deep(.analyzer-footer > .instrument-auto-preamp) {
  padding-left: 12px;
  border-left: 1px solid var(--dsp-line);
}
.eq-embedded :deep(.floating-band-inspector .band-inspector) {
  background: transparent;
}
.eq-embedded
  :deep(
    :is(
      .graph-heading,
      .gain-labels,
      .frequency-labels,
      .spectrum-scale,
      .stage-status,
      .spectrum-toggle,
      .spectrum-toggle small,
      .knob-caption,
      .graph-hint,
      .band-state,
      .band-number,
      .filter-select
    )
  ) {
  font-size: var(--dsp-t12);
}
.eq-embedded :deep(.eq-history-controls) {
  font-size: var(--dsp-t12);
}
.eq-embedded .eq-toolbar-modern {
  margin-bottom: 0;
  padding: 12px 18px;
  border: 0;
  border-bottom: 1px solid var(--dsp-line);
  border-radius: 0;
  background: var(--dsp-sunken);
}
.eq-embedded
  :is(
    .eq-command,
    .preset-menu-button,
    .instrument-mode-switch,
    .instrument-more,
    .instrument-power,
    .instrument-auto-preamp
  ) {
  box-shadow: none;
  font-weight: 500;
}
.eq-embedded .eq-command {
  border-color: transparent;
  background: var(--dsp-hover);
  color: var(--dsp-text);
}
.eq-embedded .eq-command:hover:not(:disabled) {
  border-color: var(--dsp-line-strong);
  background: var(--dsp-press);
  box-shadow: none;
  color: var(--dsp-text);
}
.eq-embedded .instrument-mode-switch {
  background: var(--dsp-hover);
  border: 0;
}
.eq-embedded .instrument-mode-switch button {
  color: var(--dsp-muted);
  font-size: var(--dsp-t12);
}
.eq-embedded .instrument-mode-switch button.active {
  color: var(--dsp-text);
  background: var(--dsp-raised);
  box-shadow: var(--dsp-thumb);
}
.eq-embedded .instrument-power.active {
  background: var(--dsp-accent-soft);
  color: var(--dsp-accent-text);
}
.eq-embedded .instrument-preamp {
  color: var(--dsp-muted);
  font-size: var(--dsp-t12);
}
.eq-embedded .preset-menu,
.eq-embedded .instrument-more-menu {
  background: var(--dsp-dialog);
  border-color: var(--dsp-line);
  box-shadow: var(--dsp-shadow-lift);
}
.eq-embedded .preset-menu-title {
  font-size: var(--dsp-t12);
  color: var(--dsp-muted);
}
.eq-embedded .preset-menu-item {
  color: var(--dsp-text);
}
.eq-embedded .preset-menu-row:hover,
.eq-embedded .preset-menu-row:focus-within {
  background: var(--dsp-hover);
}
.eq-embedded .preset-menu-row:hover .preset-menu-item,
.eq-embedded .preset-menu-item:focus-visible {
  color: var(--dsp-accent-text);
}
.eq-embedded .preset-action-btn {
  color: var(--dsp-muted);
}
.eq-embedded .preset-menu-row:hover .preset-action-btn,
.eq-embedded .preset-item-actions.is-editing .preset-action-btn {
  color: var(--dsp-text);
}
.eq-embedded .preset-action-btn:hover:not(:disabled) {
  background: var(--dsp-press);
  color: var(--dsp-accent-text);
}
.eq-embedded .preset-action-btn.is-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.16);
  color: #ef4444;
}
.eq-embedded .preset-restore-btn {
  color: var(--dsp-accent-text);
}
.eq-embedded .preset-restore-btn:hover:not(:disabled) {
  background: var(--dsp-hover);
}
.eq-embedded .preset-rename-input {
  background: var(--dsp-hover);
  color: var(--dsp-text);
  border-color: var(--dsp-line-strong);
}
.eq-embedded .preset-create {
  border-color: var(--dsp-line);
}
.eq-embedded .preset-create input {
  background: var(--dsp-hover);
  color: var(--dsp-text);
  border-color: var(--dsp-line);
}
.eq-embedded :deep(:is(.chart-card, .sliders-board)) {
  margin: 0;
  border: 0;
  border-bottom: 1px solid var(--dsp-line);
  border-radius: 0;
  background: var(--dsp-surface);
  box-shadow: none;
}
.eq-embedded .parametric-pane > .eq-band-table-scroll {
  max-height: 248px;
  overflow-y: auto;
  padding: 0 20px 12px;
  border: 0;
  border-top: 1px solid var(--dsp-line);
  border-radius: 0;
  background: var(--dsp-surface);
}
.eq-embedded .eq-band-table-scroll :deep(caption) {
  padding: 10px 0 8px;
  color: var(--dsp-faint);
  font-size: var(--dsp-t11);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.eq-embedded .eq-band-table-scroll :deep(thead th) {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 7px 8px;
  background: var(--dsp-surface);
  color: var(--dsp-muted);
  font-size: var(--dsp-t11);
  font-weight: 600;
  white-space: nowrap;
}
.eq-embedded .eq-band-table-scroll :deep(tbody th),
.eq-embedded .eq-band-table-scroll :deep(tbody td) {
  padding: 6px 8px;
}
.eq-embedded .eq-band-table-scroll :deep(input[type='checkbox']) {
  appearance: none;
  position: relative;
  display: inline-block;
  width: 28px;
  height: 16px;
  margin: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsp-line-strong);
  vertical-align: middle;
  cursor: pointer;
}
.eq-embedded .eq-band-table-scroll :deep(input[type='checkbox']::before) {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--dsp-surface-solid);
  transition: transform 160ms ease;
}
.eq-embedded .eq-band-table-scroll :deep(input[type='checkbox']:checked) {
  background: var(--dsp-text);
}
.eq-embedded .eq-band-table-scroll :deep(input[type='checkbox']:checked::before) {
  transform: translateX(12px);
}
.eq-embedded .eq-band-table-scroll :deep(:is(input:not([type='checkbox']), select)) {
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid var(--dsp-line);
  border-radius: var(--dsp-radius-xs);
  background: var(--dsp-field);
  color: var(--dsp-text);
  font-size: var(--dsp-t12);
  font-weight: 500;
  outline: none;
}
.eq-embedded .eq-band-table-scroll :deep(:is(input, select):focus-visible) {
  border-color: var(--dsp-accent);
  box-shadow: 0 0 0 3px var(--dsp-accent-soft);
}
.eq-embedded .eq-band-table-scroll :deep(.icon-button) {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--dsp-radius-xs);
  background: transparent;
  color: var(--dsp-muted);
}
.eq-embedded .eq-band-table-scroll :deep(.icon-button:hover:not(:disabled)) {
  background: var(--dsp-hover);
  color: var(--dsp-bad-text);
}
.eq-embedded .toolbar-master-switch {
  margin-left: auto;
  padding: 6px 10px;
  font-size: var(--dsp-t12);
}
.workbench-opra {
  border: 0;
  border-top: 1px solid var(--dsp-line);
  border-radius: 0;
  background: var(--dsp-surface);
  overflow: hidden;
}
.workbench-opra > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 22px;
  font-size: var(--dsp-t13);
  font-weight: 600;
  cursor: pointer;
}
.workbench-opra > summary::after {
  content: '⌄';
  margin-left: auto;
  color: var(--dsp-muted);
}
.workbench-opra > summary:hover {
  background: var(--dsp-hover);
}
.workbench-opra > summary span {
  color: var(--dsp-muted);
  font-size: var(--dsp-t12);
  font-weight: 400;
}
.workbench-opra > :deep(.opra-panel) {
  border: 0;
  border-top: 1px solid var(--dsp-line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.workbench-opra :deep(.opra-header) {
  background: transparent;
}
@container dsp-workbench (max-width: 959px) {
  .eq-embedded .parametric-pane > :deep(.parametric-workspace) {
    min-height: 460px;
  }
}
</style>
