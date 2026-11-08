<script setup lang="ts">
import { createCoreAudioUi } from '@renderer/stores/player/coreAudioUi.ts'
import { useCoreConnection } from '@renderer/stores/coreConnection.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceState } from '../composables/workspaceSession'
import {
  createDspFactoryScene,
  graphHasEnabledProcessing,
  resolveEffectiveTargetSampleRate
} from '../../../shared/dspGraph.ts'
import type {
  DspAsset,
  DspAssetKind,
  DspCorrectionProfile,
  DspFactorySceneTemplateId,
  DspGraphNode,
  DspGraphStatus,
  DspNodeType,
  DspScene,
  DspSceneState,
  Vst3CatalogState
} from '../../../shared/dspGraph.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import DspGraphCanvas from './dsp-rack/DspGraphCanvas.vue'
import DspNodeEditor from './dsp-rack/DspNodeEditor.vue'
import DspScenePane from './dsp-rack/DspScenePane.vue'
import DspSceneRules from './dsp-rack/DspSceneRules.vue'
import DspLibrary from './dsp-rack/DspLibrary.vue'
import DspMonitor from './dsp-rack/DspMonitor.vue'
import DspOutputPanel from './dsp-rack/DspOutputPanel.vue'
import DspAuditionPanel from './dsp-rack/DspAuditionPanel.vue'
import {
  nodeCatalog,
  normalizeNodeEditorParams,
  singletonNodeTypes,
  cloneNodeParams
} from '@renderer/utils/dspNodeParams'
import { cloneDspScene as cloneScene, submitDspSceneDraft } from '@renderer/utils/dspSceneDraft'
import {
  createDspDraftHistory,
  createDspDiagnosticsPoller,
  dspAssetReferences,
  dspSceneRuleSummary,
  moveDspNode,
  normalizeDspSerialOrder
} from '@renderer/utils/dspWorkbench'
import type { DspWorkspaceTab } from '@renderer/utils/dspWorkbench'

const coreAudio = createCoreAudioUi(useCoreConnection())
const props = defineProps<{
  tab?: DspWorkspaceTab
  visible?: boolean
  hostDocument?: Document
  masterBusy?: boolean
}>()
const emit = defineEmits<{
  master: []
  status: [status: DspGraphStatus | null]
  scene: [name: string]
  dirty: [dirty: boolean]
  diagnosticError: [error: string]
  state: [state: DspSceneState]
  navigate: [tab: DspWorkspaceTab]
}>()
const { isPlaying } = usePlayerStore()
const outputStore = useAudioOutputDspStore()
const { audioProcessing, outputInfo } = storeToRefs(outputStore)
const state = ref<DspSceneState | null>(null)
const saved = shallowRef<DspSceneState | null>(null)
const status = shallowRef<DspGraphStatus | null>(null)
const selectedSceneId = ref<string | null>(null)
const selectedNodeId = ref<string | null>(null)
const editor = ref<'node' | 'rules' | 'output'>('node')
const narrowView = ref<'chain' | 'editor'>('chain')
const factoryTemplate = ref<DspFactorySceneTemplateId>('transparent')
const snapshotA = shallowRef<DspScene[] | null>(null)
const busy = ref(false)
const outputBusy = ref(false)
const loading = ref(true)
const message = ref('')
const error = ref('')
const diagnosticsError = ref('')
const assets = ref<DspAsset[]>([])
const vst3Catalog = shallowRef<Vst3CatalogState | null>(null)
const audition = ref<InstanceType<typeof DspAuditionPanel> | null>(null)
const auditionOpen = ref(false)
const auditionMounted = ref(false)
const confirm = (message: string) => (props.hostDocument?.defaultView ?? window).confirm(message)
const scenes = computed(() => state.value?.scenes ?? [])
const selectedScene = computed(
  () => scenes.value.find((scene) => scene.id === selectedSceneId.value) ?? scenes.value[0] ?? null
)
const selectedNode = computed(
  () => selectedScene.value?.graph.nodes.find((node) => node.id === selectedNodeId.value) ?? null
)
const activeSceneId = computed(
  () => status.value?.activeSceneId ?? state.value?.activeSceneId ?? null
)
const savedScenes = computed(() => saved.value?.scenes ?? [])
const activeSavedScene = computed(
  () => savedScenes.value.find((scene) => scene.id === activeSceneId.value) ?? null
)
const selectedRules = computed(() => dspSceneRuleSummary(selectedScene.value))
const serialize = () =>
  JSON.stringify({ scenes: scenes.value, pinnedSceneId: state.value?.pinnedSceneId ?? null })
const savedKey = computed(() =>
  JSON.stringify({ scenes: savedScenes.value, pinnedSceneId: saved.value?.pinnedSceneId ?? null })
)
const dirty = computed(() => !!state.value && serialize() !== savedKey.value)
const history = createDspDraftHistory(serialize())
const workspaceState = useWorkspaceState('dsp-rack', () => ({
  selectedSceneId: selectedSceneId.value,
  selectedNodeId: selectedNodeId.value,
  editor: editor.value,
  narrowView: narrowView.value,
  factoryTemplate: factoryTemplate.value,
  snapshotA: snapshotA.value,
  savedKey: savedKey.value,
  history: history.snapshot(),
  auditionOpen: auditionOpen.value
}))
const historyRevision = ref(0)
const canUndo = computed(() => {
  void historyRevision.value
  return history.canUndo
})
const canRedo = computed(() => {
  void historyRevision.value
  return history.canRedo
})
let historyTimer: ReturnType<typeof setTimeout> | null = null
let gesture = false
let restoring = false
let disposed = false
function cancelHistoryTimer(): void {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = null
}
function checkpoint(): void {
  cancelHistoryTimer()
  history.push(serialize())
  historyRevision.value++
}
function beginGesture(): void {
  checkpoint()
  gesture = true
}
function endGesture(): void {
  gesture = false
  checkpoint()
}
function finishPointerGesture(): void {
  if (gesture) void nextTick(endGesture)
}
watch(
  serialize,
  () => {
    if (restoring || loading.value) return
    cancelHistoryTimer()
    if (!gesture) historyTimer = setTimeout(checkpoint, 450)
  },
  { flush: 'sync' }
)
watch(dirty, (value) => emit('dirty', value))
watch(
  () => props.tab,
  () => {
    message.value = ''
  }
)
function travel(direction: 'undo' | 'redo'): void {
  checkpoint()
  restoring = true
  const next = JSON.parse(direction === 'undo' ? history.undo() : history.redo())
  if (state.value) {
    state.value.scenes = next.scenes
    state.value.pinnedSceneId = next.pinnedSceneId
  }
  restoring = false
  historyRevision.value++
  repairSelection()
}
function repairSelection(): void {
  if (!scenes.value.some((scene) => scene.id === selectedSceneId.value))
    selectedSceneId.value = scenes.value[0]?.id ?? null
  if (!selectedScene.value?.graph.nodes.some((node) => node.id === selectedNodeId.value))
    selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
}
function adopt(next: DspSceneState): void {
  restoring = true
  next.scenes.forEach((scene) => {
    scene.graph.nodes.forEach(normalizeNodeEditorParams)
    normalizeDspSerialOrder(scene.graph.nodes)
  })
  if (!selectedSceneId.value) selectedSceneId.value = next.activeSceneId
  state.value = JSON.parse(JSON.stringify(next))
  saved.value = JSON.parse(JSON.stringify(next))
  repairSelection()
  history.reset(serialize())
  cancelHistoryTimer()
  historyRevision.value++
  restoring = false
  emit('scene', next.scenes.find((scene) => scene.id === next.activeSceneId)?.name ?? '自动匹配')
  emit('state', JSON.parse(JSON.stringify(next)))
}
function selectScene(id: string): void {
  checkpoint()
  selectedSceneId.value = id
  selectedNodeId.value = selectedScene.value?.graph.nodes[0]?.id ?? null
  editor.value = 'node'
}
function selectNode(id: string): void {
  selectedNodeId.value = id
  editor.value = 'node'
  narrowView.value = 'editor'
}
async function focusRuntimeNode(id: string): Promise<void> {
  if (!(await requestLeave())) return
  const active = scenes.value.find((scene) => scene.id === activeSceneId.value)
  if (!active?.graph.nodes.some((node) => node.id === id)) return
  selectScene(active.id)
  selectNode(id)
}
function showEditor(next: 'rules' | 'output'): void {
  editor.value = next
  narrowView.value = 'editor'
}
function addScene(): void {
  if (!state.value) return
  const next = createDspFactoryScene('transparent', `scene-${crypto.randomUUID()}`)
  next.name = `新场景 ${scenes.value.length + 1}`
  state.value.scenes.push(next)
  selectScene(next.id)
  editor.value = 'rules'
  checkpoint()
}
function addFactoryScene(): void {
  if (!state.value) return
  const next = createDspFactoryScene(factoryTemplate.value, `factory-${crypto.randomUUID()}`)
  state.value.scenes.push(next)
  selectScene(next.id)
  checkpoint()
}
function duplicateScene(): void {
  if (!state.value || !selectedScene.value) return
  const next = cloneScene(
    selectedScene.value,
    `scene-${crypto.randomUUID()}`,
    `${selectedScene.value.name} 副本`
  )
  state.value.scenes.push(next)
  selectScene(next.id)
  checkpoint()
}
function removeScene(): void {
  const scene = selectedScene.value
  if (!state.value || !scene || scenes.value.length <= 1) return
  if (!confirm(`删除场景“${scene.name}”？保存后生效。`)) return
  state.value.scenes = scenes.value.filter((item) => item.id !== scene.id)
  if (state.value.pinnedSceneId === scene.id) state.value.pinnedSceneId = null
  repairSelection()
  checkpoint()
}
function addNode(type: DspNodeType): void {
  const scene = selectedScene.value
  const item = nodeCatalog.find((entry) => entry.type === type)
  if (!scene || !item) return
  const existing =
    singletonNodeTypes.has(type) && scene.graph.nodes.find((node) => node.type === type)
  if (existing) {
    selectNode(existing.id)
    return
  }
  const node: DspGraphNode = {
    id: `${type}-${crypto.randomUUID()}`,
    type,
    enabled: type === 'meter',
    ...(type === 'nativePlugin' ? { pluginAbiVersion: 2 as const } : {}),
    params: cloneNodeParams(item.params)
  }
  scene.graph.nodes.push(node)
  normalizeDspSerialOrder(scene.graph.nodes)
  normalizeNodeEditorParams(node)
  selectNode(node.id)
  checkpoint()
}
function removeNode(id: string): void {
  if (!selectedScene.value) return
  selectedScene.value.graph.nodes = selectedScene.value.graph.nodes.filter((node) => node.id !== id)
  repairSelection()
  checkpoint()
}
function moveNode(id: string, destination: string): void {
  if (selectedScene.value && moveDspNode(selectedScene.value.graph.nodes, id, destination))
    checkpoint()
}
function resetNode(): void {
  const node = selectedNode.value
  const defaults = nodeCatalog.find((item) => item.type === node?.type)
  if (!node || !defaults) return
  node.params = cloneNodeParams(defaults.params)
  normalizeNodeEditorParams(node)
  checkpoint()
}
const vst3HelpersNotice = computed(() => {
  const helpers = vst3Catalog.value?.helpers
  if (!/win/i.test(navigator.platform) || helpers?.platformSupported === false)
    return 'VST3 仅支持 Windows x64。'
  if (helpers && (!helpers.scannerPresent || !helpers.hostPresent))
    return '本构建缺少 VST3 扫描或宿主组件。请安装完整 Windows 构建。'
  return ''
})
const poller = createDspDiagnosticsPoller({
  visible: () => !!props.visible && !(props.hostDocument ?? document).hidden,
  playing: () => isPlaying.value,
  read: async () => {
    try {
      const next = await coreAudio.getDspGraphStatus()
      if (disposed) return
      status.value = next
      diagnosticsError.value = ''
      emit('diagnosticError', '')
      emit('status', next)
      emit(
        'scene',
        savedScenes.value.find((scene) => scene.id === next.activeSceneId)?.name ?? '自动匹配'
      )
    } catch (cause) {
      diagnosticsError.value = cause instanceof Error ? cause.message : String(cause)
      status.value = null
      emit('status', null)
      emit('diagnosticError', diagnosticsError.value)
      throw cause
    }
  }
})
function visibilityChanged(): void {
  poller.update()
}
function observeDocument(doc: Document, observe: boolean): void {
  if (observe) {
    doc.addEventListener('visibilitychange', visibilityChanged)
    doc.addEventListener('pointerup', finishPointerGesture, true)
    doc.addEventListener('pointercancel', finishPointerGesture, true)
    doc.defaultView?.addEventListener('blur', finishPointerGesture)
  } else {
    doc.removeEventListener('visibilitychange', visibilityChanged)
    doc.removeEventListener('pointerup', finishPointerGesture, true)
    doc.removeEventListener('pointercancel', finishPointerGesture, true)
    doc.defaultView?.removeEventListener('blur', finishPointerGesture)
  }
}
watch(
  () => props.hostDocument,
  (next, previous) => {
    observeDocument(previous ?? document, false)
    observeDocument(next ?? document, true)
    poller.update()
  }
)
watch(
  () => [props.visible, isPlaying.value],
  () => poller.update()
)
async function run(action: () => Promise<void>): Promise<boolean> {
  if (busy.value || outputBusy.value || loading.value) return false
  busy.value = true
  error.value = ''
  message.value = ''
  checkpoint()
  try {
    await action()
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    busy.value = false
  }
}
async function finishAudition(): Promise<boolean> {
  return (await audition.value?.end()) ?? true
}
async function toggleAudition(event: Event): Promise<void> {
  const details = event.target as HTMLDetailsElement
  if (details.open) {
    auditionMounted.value = true
    auditionOpen.value = true
  } else if (await finishAudition()) {
    auditionOpen.value = false
  } else {
    auditionOpen.value = true
    details.open = true
  }
}
let rateSyncInFlight = false
async function ensureOutputSampleRateSynced(): Promise<void> {
  if (rateSyncInFlight || dirty.value) return
  const unwrap = <T,>(val: T | { value: T } | undefined): T | undefined =>
    val && typeof val === 'object' && 'value' in val ? (val as { value: T }).value : val
  const storeRef = outputStore as unknown as Record<string, unknown>
  const playback = unwrap(
    storeRef.playbackInfo as {
      state?: string
      isDsd?: boolean
      sourceSampleRate?: number
      decodedSampleRate?: number
      actualSampleRate?: number
      outputSampleRate?: number
    }
  )
  const outInfo = outputInfo.value
  const playbackActive =
    playback?.state === 'playing' || playback?.state === 'paused' || isPlaying.value
  if (!playbackActive || outInfo?.isDsd || playback?.isDsd) return
  const outConfig = unwrap(
    storeRef.audioOutputConfig as {
      playbackPolicy?: string
      dsdMuteTimeoutFrames?: number
    }
  )
  if (outConfig?.playbackPolicy === 'continuity-first') return

  const activeScene =
    savedScenes.value.find((scene) => scene.id === activeSceneId.value) ?? selectedScene.value
  const outStage = activeScene?.graph.outputStage ?? state.value?.effectiveGraph?.outputStage
  if (!outStage) return

  const sourceRate = playback?.sourceSampleRate || playback?.decodedSampleRate || 0
  if (sourceRate <= 0) return

  const currentDevice = unwrap(storeRef.audioDevice as string) ?? 'auto'
  const deviceOptions =
    unwrap(storeRef.audioDeviceOptions as Array<{ id: string; sampleRates?: number[] }>) ?? []
  const currentDeviceOption = deviceOptions.find((d) => d.id === currentDevice) ?? deviceOptions[0]
  const bypassed =
    !audioProcessing.value.dspEnabled ||
    audioProcessing.value.directMode ||
    !!state.value?.effectiveBypassReason
  const resolvedTarget = bypassed
    ? 'device'
    : resolveEffectiveTargetSampleRate(outStage, sourceRate, currentDeviceOption?.sampleRates)
  const desiredRate =
    typeof resolvedTarget === 'number' && resolvedTarget > 0 ? resolvedTarget : sourceRate
  const actualRate =
    outInfo?.actualSampleRate ||
    outInfo?.outputSampleRate ||
    playback?.actualSampleRate ||
    playback?.outputSampleRate ||
    0
  const backend =
    unwrap(storeRef.audioOutput as string) ?? outInfo?.actualBackend ?? outInfo?.backend ?? ''
  const isExclusiveOrAsio =
    backend === 'asio' ||
    Boolean(unwrap(storeRef.exclusiveMode as boolean)) ||
    outInfo?.exclusive === true
  if (!isExclusiveOrAsio || desiredRate <= 0 || actualRate <= 0 || actualRate === desiredRate) {
    return
  }

  rateSyncInFlight = true
  try {
    await outputStore.setOutputStage?.(outStage)
    await outputStore.refreshAudioOutputState?.().catch(() => undefined)
    const refreshedPlayback = unwrap(
      storeRef.playbackInfo as {
        actualSampleRate?: number
        outputSampleRate?: number
      }
    )
    const refreshedRate =
      outputInfo.value?.actualSampleRate ||
      outputInfo.value?.outputSampleRate ||
      refreshedPlayback?.actualSampleRate ||
      refreshedPlayback?.outputSampleRate ||
      0
    if (refreshedRate !== desiredRate) {
      if (currentDevice && currentDevice !== 'auto') {
        await outputStore.setAudioDevice?.('auto')
        await outputStore.setAudioDevice?.(currentDevice)
      } else {
        const currentTimeout =
          unwrap(storeRef.audioOutputConfig as { dsdMuteTimeoutFrames?: number })
            ?.dsdMuteTimeoutFrames ?? 4096
        await outputStore.setAudioOutputConfig?.({
          dsdMuteTimeoutFrames: currentTimeout === 4095 ? 4096 : 4095
        })
      }
      await outputStore.refreshAudioOutputState?.().catch(() => undefined)
    }
  } finally {
    rateSyncInFlight = false
  }
}
async function saveScenes(): Promise<boolean> {
  if (!(await finishAudition())) return false
  return run(async () => {
    if (!state.value) return
    const drafts = scenes.value.map((scene) => cloneScene(scene))
    drafts.forEach((scene) => scene.graph.nodes.forEach(normalizeNodeEditorParams))
    let next = await submitDspSceneDraft(coreAudio, drafts, state.value.pinnedSceneId)
    if (
      next.requiresPcmFallback &&
      !next.dsdPcmFallbackApplied &&
      confirm('场景已保存。停止 DSD Direct / DoP 直通并转换为 PCM 以运行 DSP？')
    )
      next = await coreAudio.applyDspScene(next.pinnedSceneId, true)
    adopt(next)
    await refreshSavedAssetReferences()
    if (
      !audioProcessing.value.dspEnabled &&
      !audioProcessing.value.directMode &&
      selectedScene.value &&
      graphHasEnabledProcessing(selectedScene.value.graph)
    ) {
      await outputStore.setAudioProcessing?.({ dspEnabled: true, directMode: false })
    }
    await ensureOutputSampleRateSynced().catch(() => undefined)
    message.value =
      next.requiresPcmFallback && !next.dsdPcmFallbackApplied
        ? '场景已保存；保持 DSD 直通。'
        : '已保存，等待引擎确认。'
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
async function pinScene(pin: string | null): Promise<void> {
  if (!(await requestLeave()) || !(await finishAudition())) return
  await run(async () => {
    const previousPin = saved.value?.pinnedSceneId ?? null
    let next = await coreAudio.applyDspScene(pin)
    if (next.requiresPcmFallback && !next.dsdPcmFallbackApplied) {
      if (confirm('停止 DSD Direct / DoP 直通并转换为 PCM，以应用此场景？'))
        next = await coreAudio.applyDspScene(pin, true)
      else {
        next = await coreAudio.applyDspScene(previousPin)
        message.value = '已取消，保持原场景与 DSD 直通。'
      }
    }
    adopt(next)
    await ensureOutputSampleRateSynced().catch(() => undefined)
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
function discard(): void {
  if (saved.value) adopt(JSON.parse(JSON.stringify(saved.value)))
  message.value = '已还原到上次保存。'
}
const leaveDialog = ref(false)
const dialogRef = ref<HTMLElement | null>(null)
let leaveOpener: HTMLElement | null = null
let resolveLeave: ((answer: boolean) => void) | null = null
let leavePromise: Promise<boolean> | null = null
async function requestLeave(): Promise<boolean> {
  if (busy.value || outputBusy.value || loading.value) return false
  if (!(await finishAudition())) return false
  if (!dirty.value) return true
  if (leavePromise) return leavePromise
  checkpoint()
  leaveOpener = (props.hostDocument ?? document).activeElement as HTMLElement | null
  leaveDialog.value = true
  leavePromise = new Promise<boolean>((resolve) => {
    resolveLeave = resolve
  })
  void nextTick(() => dialogRef.value?.querySelector<HTMLButtonElement>('button')?.focus())
  return leavePromise
}
async function answerLeave(answer: 'save' | 'discard' | 'cancel'): Promise<void> {
  if (answer === 'save' && !(await saveScenes())) return
  if (answer === 'discard') discard()
  leaveDialog.value = false
  resolveLeave?.(answer !== 'cancel')
  resolveLeave = null
  leavePromise = null
  void nextTick(() => {
    if (leaveOpener?.isConnected) leaveOpener.focus()
  })
}
function trapDialog(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !busy.value) {
    event.stopPropagation()
    void answerLeave('cancel')
  }
  if (event.key !== 'Tab') return
  const buttons = [
    ...(dialogRef.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  ]
  const index = buttons.indexOf((props.hostDocument ?? document).activeElement as HTMLButtonElement)
  event.preventDefault()
  buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
}
async function refreshLibrary(): Promise<void> {
  ;[assets.value, vst3Catalog.value] = await Promise.all([
    coreAudio.getDspAssets(),
    coreAudio.getVst3Catalog()
  ])
}
async function refreshSavedAssetReferences(): Promise<void> {
  try {
    assets.value = await coreAudio.getDspAssets()
  } catch (cause) {
    // Persistence has succeeded. A library read failure must not turn a save
    // into a failed navigation decision; the engine still guards asset deletion.
    error.value = `场景已保存，但资料引用未能刷新：${cause instanceof Error ? cause.message : String(cause)}`
  }
}
async function reload(): Promise<void> {
  if (!(await requestLeave())) return
  await run(async () => {
    adopt(await coreAudio.getDspSceneState())
    await refreshLibrary()
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
async function syncFromEngine(): Promise<void> {
  if (!dirty.value) adopt(await coreAudio.getDspSceneState())
}
function applyCorrection(assetId: string, profile: DspCorrectionProfile): void {
  if (selectedNode.value?.type !== 'equalizer') return
  selectedNode.value.enabled = true
  selectedNode.value.params = {
    ...selectedNode.value.params,
    mode: 'parametric',
    preampDb: profile.preampDb,
    bands: profile.bands.map((band) => ({ ...band })),
    correctionAssetId: assetId,
    correctionFormat: profile.format
  }
  checkpoint()
}
async function bindAsset(asset: DspAsset): Promise<void> {
  if (asset.kind === 'correctionProfile') {
    await run(async () =>
      applyCorrection(asset.id, await coreAudio.getDspCorrectionProfile(asset.id))
    )
    return
  }
  const node = selectedNode.value
  if (asset.kind === 'impulseResponse' && node?.type === 'convolver') {
    node.params.impulseResponseAssetId = asset.id
    node.params.impulseResponsePath = ''
  }
  if ((asset.kind === 'vst3Preset' || asset.kind === 'vst3State') && node?.vst3)
    node.vst3 = { ...node.vst3, stateAssetId: asset.id }
  checkpoint()
}
async function importAsset(kind: DspAssetKind): Promise<void> {
  await run(async () => {
    const asset = await coreAudio.importDspAsset(kind)
    if (asset) {
      assets.value = await coreAudio.getDspAssets()
      if (kind === 'impulseResponse' && selectedNode.value?.type === 'convolver') {
        selectedNode.value.params.impulseResponseAssetId = asset.id
        selectedNode.value.params.impulseResponsePath = ''
      }
      if ((kind === 'vst3Preset' || kind === 'vst3State') && selectedNode.value?.vst3)
        selectedNode.value.vst3 = { ...selectedNode.value.vst3, stateAssetId: asset.id }
      checkpoint()
      message.value = `已导入 ${asset.name}。`
    }
  })
}
async function importCorrection(): Promise<void> {
  await run(async () => {
    const imported = await coreAudio.importDspCorrectionProfile()
    if (!imported) return
    assets.value = await coreAudio.getDspAssets()
    if (selectedNode.value?.type === 'equalizer')
      applyCorrection(imported.asset.id, imported.profile)
    message.value = `已导入 ${imported.profile.bands.length} 段校正。`
  })
}
async function selectCorrectionAsset(assetId: string): Promise<void> {
  if (!assetId && selectedNode.value) {
    delete selectedNode.value.params.correctionAssetId
    delete selectedNode.value.params.correctionFormat
    checkpoint()
    return
  }
  await run(async () => applyCorrection(assetId, await coreAudio.getDspCorrectionProfile(assetId)))
}
async function removeAsset(id: string): Promise<void> {
  if (
    dspAssetReferences(scenes.value, id).length ||
    dspAssetReferences(savedScenes.value, id).length ||
    assets.value.find((item) => item.id === id)?.referenceCount
  )
    return
  if (confirm('永久删除此资料？'))
    await run(async () => {
      assets.value = await coreAudio.deleteDspAsset(id)
    })
}
async function exportProfile(): Promise<void> {
  if (await requestLeave())
    await run(async () => {
      await coreAudio.exportDspProfile(selectedScene.value?.name)
    })
}
async function importProfile(): Promise<void> {
  if (!(await requestLeave()) || !confirm('导入将替换全部场景与固定选择，并立即应用。继续？'))
    return
  await run(async () => {
    const imported = await coreAudio.importDspProfile()
    if (!imported) return
    adopt(imported.state)
    await refreshLibrary()
    await poller.refreshAfterCurrent().catch(() => undefined)
  })
}
async function scanVst3(): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await coreAudio.scanVst3Plugins()
  })
}
async function recoverVst3(id: string): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await coreAudio.clearVst3Quarantine(id)
    message.value = '隔离重扫完成；插件需手动重新启用。'
  })
}
async function enableVst3(enabled: boolean): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await coreAudio.setVst3Enabled(enabled)
  })
}
async function addPath(): Promise<void> {
  await run(async () => {
    const path = await coreAudio.selectVst3SearchPath()
    if (path)
      vst3Catalog.value = await coreAudio.setVst3SearchPaths([
        ...new Set([...(vst3Catalog.value?.searchPaths ?? []), path])
      ])
  })
}
async function removePath(path: string): Promise<void> {
  await run(async () => {
    vst3Catalog.value = await coreAudio.setVst3SearchPaths(
      vst3Catalog.value?.searchPaths.filter((item) => item !== path) ?? []
    )
  })
}
function keydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || busy.value || leaveDialog.value || props.tab === 'equalizer') return
  if (!(event.ctrlKey || event.metaKey)) return
  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveScenes()
  } else if (
    !(event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]') &&
    ['z', 'y'].includes(event.key.toLowerCase())
  ) {
    event.preventDefault()
    travel(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo')
  }
}
onMounted(async () => {
  try {
    adopt(await coreAudio.getDspSceneState())
    workspaceState.restore((saved) => {
      selectedSceneId.value = saved.selectedSceneId
      selectedNodeId.value = saved.selectedNodeId
      editor.value = saved.editor
      narrowView.value = saved.narrowView
      factoryTemplate.value = saved.factoryTemplate
      snapshotA.value = saved.snapshotA
      if (saved.savedKey === savedKey.value) history.restore(saved.history)
      repairSelection()
      auditionOpen.value = saved.auditionOpen
      auditionMounted.value = saved.auditionOpen
      historyRevision.value++
    })
    await refreshLibrary()
    await ensureOutputSampleRateSynced().catch(() => undefined)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    observeDocument(props.hostDocument ?? document, true)
    poller.update()
  }
})
onBeforeUnmount(() => {
  disposed = true
  poller.stop()
  cancelHistoryTimer()
  observeDocument(props.hostDocument ?? document, false)
  resolveLeave?.(false)
})
defineExpose({
  requestLeave,
  syncFromEngine,
  finishAudition,
  focusRuntimeNode,
  refreshDiagnostics: poller.refreshAfterCurrent,
  dirty,
  busy: computed(() => busy.value || outputBusy.value),
  loading
})
</script>

<template>
  <section class="dsp-rack-content" :data-tab="tab" @keydown="keydown">
    <div
      v-if="tab !== 'monitor'"
      class="draft-toolbar"
      :class="{ dirty }"
      :inert="outputBusy"
      role="toolbar"
      aria-label="场景草稿"
    >
      <p
        class="draft-status"
        :title="dirty ? '草稿不会改变正在播放的声音，保存后生效' : '所有场景与引擎配置保持一致'"
      >
        <span class="draft-dot" :class="{ dirty }" aria-hidden="true"></span>
        <strong>{{ dirty ? '未保存更改' : '已保存' }}</strong>
      </p>
      <label class="draft-scene" title="正在编辑的场景">
        <span class="draft-scene-label">场景</span>
        <select
          class="compact-scene-select"
          aria-label="正在编辑的场景"
          :value="selectedSceneId"
          :disabled="busy || outputBusy || loading"
          @change="selectScene(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
            {{ scene.name }}{{ scene.id === activeSceneId ? ' · 正在播放' : '' }}
          </option>
        </select>
      </label>
      <div class="toolbar draft-actions">
        <span class="draft-history" role="group" aria-label="撤销与重做"
          ><button
            class="icon-button"
            title="撤销 · Ctrl+Z"
            aria-label="撤销"
            :disabled="!canUndo || busy"
            @click="travel('undo')"
          >
            <i class="pi pi-undo"></i></button
          ><button
            class="icon-button redo"
            title="重做 · Ctrl+Shift+Z"
            aria-label="重做"
            :disabled="!canRedo || busy"
            @click="travel('redo')"
          >
            <i class="pi pi-undo"></i></button
        ></span>
        <button class="ghost-button" :disabled="!dirty || busy" @click="discard">还原</button>
        <details class="profile-menu">
          <summary title="配置包与重新加载" aria-label="更多草稿操作">
            <i class="pi pi-ellipsis-h"></i>
          </summary>
          <div class="menu-panel" role="menu">
            <button role="menuitem" :disabled="busy" @click="reload">
              <i class="pi pi-refresh"></i>重新加载
            </button>
            <button role="menuitem" :disabled="busy" @click="importProfile">
              <i class="pi pi-download"></i>导入配置包
            </button>
            <button role="menuitem" :disabled="busy" @click="exportProfile">
              <i class="pi pi-upload"></i>导出配置包
            </button>
          </div>
        </details>
        <button class="primary-button" :disabled="!dirty || busy || loading" @click="saveScenes">
          <i v-if="busy" class="pi pi-spinner pi-spin"></i>{{ busy ? '处理中…' : '保存更改' }}
        </button>
      </div>
    </div>
    <p v-if="error" class="rack-message error" role="alert">
      <i class="pi pi-exclamation-triangle"></i><span>{{ error }}</span>
    </p>
    <p v-else-if="message" class="rack-message" role="status">
      <i class="pi pi-check-circle"></i><span>{{ message }}</span>
    </p>
    <div v-if="loading" class="rack-loading" role="status">
      <i class="pi pi-spinner pi-spin"></i><span>正在读取音频引擎…</span>
    </div>
    <fieldset
      v-else
      :disabled="busy || outputBusy || leaveDialog"
      :inert="busy || outputBusy || leaveDialog"
      class="rack-fields"
      :aria-busy="busy || outputBusy"
      @pointerdown.capture="beginGesture"
      @change="checkpoint"
    >
      <div v-show="tab === 'chain'" class="rack-layout" :data-narrow-view="narrowView">
        <DspScenePane
          :scenes="scenes"
          :selected-scene-id="selectedSceneId"
          :active-scene-id="activeSceneId"
          :pinned-scene-id="saved?.pinnedSceneId ?? null"
          v-model:factory-template="factoryTemplate"
          @select="selectScene"
          @add="addScene"
          @duplicate="duplicateScene"
          @remove="removeScene"
          @add-factory="addFactoryScene"
        />
        <header class="chain-heading">
          <div class="chain-title">
            <h2>{{ selectedScene?.name }}</h2>
            <p class="chain-flags">
              <span class="scene-flag" :class="{ live: selectedScene?.id === activeSceneId }"
                ><i class="state-dot" aria-hidden="true"></i
                >{{ selectedScene?.id === activeSceneId ? '正在播放' : '未在播放' }}</span
              ><span
                v-if="saved?.pinnedSceneId && saved.pinnedSceneId === selectedScene?.id"
                class="scene-flag pinned"
                >已固定</span
              ><span class="scene-flag">优先级 {{ selectedScene?.priority ?? 0 }}</span
              ><span class="scene-flag quiet">{{
                selectedScene?.id === activeSceneId
                  ? '保存后会重新应用'
                  : '编辑草稿，不改变正在播放的场景'
              }}</span>
            </p>
            <ul class="rule-summary" aria-label="自动匹配条件">
              <li v-for="item in selectedRules" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div class="toolbar chain-pin">
            <button
              :class="{ 'is-pinned': saved?.pinnedSceneId === selectedScene?.id }"
              :disabled="!selectedScene"
              title="忽略自动匹配，始终使用这个场景"
              @click="pinScene(selectedScene!.id)"
            >
              <i class="pi pi-thumbtack"></i
              >{{
                saved?.pinnedSceneId === selectedScene?.id ? '已固定使用' : '固定使用此场景'
              }}</button
            ><button
              :disabled="!saved?.pinnedSceneId"
              title="按设备、后端与格式自动选择场景"
              @click="pinScene(null)"
            >
              <i class="pi pi-sync"></i>恢复自动匹配
            </button>
          </div>
        </header>
        <div class="narrow-tabs segmented" role="group" aria-label="视图">
          <button :aria-pressed="narrowView === 'chain'" @click="narrowView = 'chain'">
            信号链</button
          ><button :aria-pressed="narrowView === 'editor'" @click="narrowView = 'editor'">
            参数
          </button>
        </div>
        <DspGraphCanvas
          :scene="selectedScene"
          :selected-node-id="editor === 'node' ? selectedNodeId : null"
          :busy="busy"
          @select-node="selectNode"
          @add-node="addNode"
          @remove-node="removeNode"
          @move-node="moveNode"
          @rules="showEditor('rules')"
          @output="emit('navigate', 'output')"
        />
        <section class="editor-pane">
          <div class="editor-tools">
            <div class="segmented" role="group" aria-label="检查器内容">
              <button
                :aria-pressed="editor !== 'rules'"
                :disabled="!selectedNode"
                @click="editor = 'node'"
              >
                处理器参数</button
              ><button :aria-pressed="editor === 'rules'" @click="editor = 'rules'">
                场景规则
              </button>
            </div>
            <button
              v-if="editor !== 'rules' && selectedNode"
              class="ghost-button"
              title="恢复此处理器的默认参数"
              @click="resetNode"
            >
              <i class="pi pi-replay"></i>重置参数
            </button>
          </div>
          <DspSceneRules v-if="editor === 'rules' && selectedScene" :model-value="selectedScene" />
          <DspNodeEditor
            v-else
            :scene="selectedScene"
            :node="selectedNode"
            :busy="busy"
            :assets="assets"
            :vst3-catalog="vst3Catalog"
            :vst3-helpers-ready="!vst3HelpersNotice"
            :sample-rate="outputInfo?.actualSampleRate || outputInfo?.outputSampleRate || 48000"
            :host-document="hostDocument"
            @import-asset="importAsset"
            @import-correction-profile="importCorrection"
            @select-correction-asset="selectCorrectionAsset"
            @scan-vst3="scanVst3"
            @recover-vst3="recoverVst3"
          />
          <p v-if="state?.requiresPcmFallback && !state.dsdPcmFallbackApplied" class="notice">
            <i class="pi pi-info-circle"></i>DSD Direct / DoP 保持直通。运行 DSP 需确认转换为 PCM。
          </p>
          <p v-if="state?.directMode || audioProcessing.directMode" class="notice">
            <i class="pi pi-info-circle"></i>Direct 模式正在旁路处理。
          </p>
        </section>
        <details class="audition-section" :open="auditionOpen" @toggle="toggleAudition">
          <summary>
            <span class="audition-copy"
              ><strong>等响度 A / B 对比</strong
              ><small>本地 PCM · 无处理或单 EQ · 自动匹配响度后切换试听</small></span
            ><i class="pi pi-chevron-down audition-chevron" aria-hidden="true"></i>
          </summary>
          <div v-if="auditionMounted" v-show="auditionOpen" class="audition-body">
            <button
              class="ghost-button"
              @click="snapshotA = scenes.map((scene) => cloneScene(scene))"
            >
              <i class="pi pi-camera"></i
              >{{ snapshotA ? '重新记录 A 快照' : '记录 A 快照' }}</button
            ><DspAuditionPanel
              ref="audition"
              :current="state?.effectiveGraph ?? state?.graph"
              :a="snapshotA?.find((scene) => scene.id === selectedScene?.id)?.graph ?? null"
              :b="selectedScene?.graph ?? null"
            />
          </div>
        </details>
      </div>
      <DspLibrary
        v-show="tab === 'library'"
        :assets="assets"
        :catalog="vst3Catalog"
        :scenes="scenes"
        :saved-scenes="savedScenes"
        :selected-node="selectedNode"
        :selected-scene-name="selectedScene?.name ?? ''"
        :notice="vst3HelpersNotice"
        :busy="busy"
        @import-asset="importAsset"
        @import-correction="importCorrection"
        @remove="removeAsset"
        @bind="bindAsset"
        @enable-vst3="enableVst3"
        @add-path="addPath"
        @remove-path="removePath"
        @scan="scanVst3"
        @recover="recoverVst3"
        @chain="emit('navigate', 'chain')"
      />
      <section v-if="tab === 'output'" class="output-page">
        <DspOutputPanel :scene="selectedScene" :status="status" @busy="outputBusy = $event" />
      </section>
      <DspMonitor
        v-if="tab === 'monitor'"
        :status="status"
        :error="diagnosticsError"
        :visible="visible"
        :host-document="hostDocument"
        :scene="activeSavedScene"
        :scene-state="state"
        :asset-count="assets.length"
        :master-busy="busy || !!masterBusy"
        @master="emit('master')"
        @navigate="emit('navigate', $event)"
        @refresh="poller.refreshAfterCurrent().catch(() => undefined)"
      >
        <template #capture
          ><div class="capture-controls">
            <label class="switch-field" title="开启 FFT 频谱采集"
              ><input
                type="checkbox"
                aria-label="开启 FFT 频谱采集"
                :checked="audioProcessing.fftEnabled"
                @change="
                  run(async () => {
                    await outputStore.setAudioProcessing(
                      { fftEnabled: ($event.target as HTMLInputElement).checked },
                      { throwOnError: true }
                    )
                  })
                "
              /><span>FFT</span></label
            ><label class="inline-field" title="FFT 分辨率"
              ><select
                aria-label="FFT 分辨率"
                :value="audioProcessing.fftResolution"
                @change="
                  run(async () => {
                    await outputStore.setAudioProcessing(
                      { fftResolution: Number(($event.target as HTMLSelectElement).value) },
                      { throwOnError: true }
                    )
                  })
                "
              >
                <option
                  v-for="size in [64, 128, 256, 512, 1024, 2048, 4096, 8192]"
                  :key="size"
                  :value="size"
                >
                  {{ size }} 点
                </option>
              </select></label
            >
          </div></template
        >
      </DspMonitor>
    </fieldset>
    <div v-if="leaveDialog" class="draft-dialog-backdrop" @keydown="trapDialog">
      <section
        ref="dialogRef"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsp-draft-title"
        aria-describedby="dsp-draft-description"
        class="draft-dialog"
      >
        <p class="eyebrow">未保存的草稿</p>
        <h2 id="dsp-draft-title">保存效果链更改？</h2>
        <p id="dsp-draft-description">
          保存会更新全部场景，并重新应用当前活动场景；放弃则恢复到上次保存的状态。
        </p>
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <div class="toolbar">
          <button :disabled="busy" @click="answerLeave('cancel')">取消</button
          ><span class="toolbar-spacer"></span
          ><button class="danger-ghost" :disabled="busy" @click="answerLeave('discard')">
            放弃更改</button
          ><button class="primary-button" :disabled="busy" @click="answerLeave('save')">
            {{ busy ? '正在保存…' : '保存更改' }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
