<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { provideWorkspaceSession } from '../composables/workspaceSession'
import DspRackPage from './DspRackPage.vue'
import DspSignalOverview from './dsp-rack/DspSignalOverview.vue'
import AppBackgroundLayer from './AppBackgroundLayer.vue'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { dspApplyLabel, dspWorkspaceTabs, type DspWorkspaceTab } from '@renderer/utils/dspWorkbench'
import type { DspGraphStatus, DspSceneState } from '../../../shared/dspGraph.ts'
import {
  dspEditorDocumentVisible,
  useDspEditorWindow
} from '@renderer/composables/useDspEditorWindow'
const EqualizerPage = defineAsyncComponent(() => import('./EqualizerPage.vue'))
const props = defineProps<{ active: boolean; initialTab: DspWorkspaceTab }>()
const emit = defineEmits<{ suspendReady: [ready: boolean] }>()
const workspaceSession = provideWorkspaceSession('audio')
const rack = ref<InstanceType<typeof DspRackPage> | null>(null)
const equalizer = ref<InstanceType<typeof EqualizerPage> | null>(null)
const tab = ref<DspWorkspaceTab>(props.initialTab)
const status = ref<DspGraphStatus | null>(null)
const sceneState = ref<DspSceneState | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const sceneName = ref('自动匹配')
const error = ref('')
const diagnosticsError = ref('')
const dirty = ref(false)
const masterBusy = ref(false)
const switching = ref(false)
const signalDialog = ref<HTMLDialogElement | null>(null)
const signalButton = ref<HTMLButtonElement | null>(null)
const signalOpen = ref(false)
const workspaceState = () => ({
  tab: tab.value,
  initialTab: props.initialTab,
  scrollTop: contentRef.value?.scrollTop ?? 0
})
workspaceSession.register('workspace', workspaceState)
const suspendedWorkspace = workspaceSession.read<ReturnType<typeof workspaceState>>('workspace')
if (suspendedWorkspace?.initialTab === props.initialTab) tab.value = suspendedWorkspace.tab
watch(
  contentRef,
  (element) => {
    if (element && suspendedWorkspace) element.scrollTop = suspendedWorkspace.scrollTop
  },
  { flush: 'post' }
)
const { audioProcessing, audioEngineReady, dspGraphStatus } = storeToRefs(useAudioOutputDspStore())
const outputStore = useAudioOutputDspStore()
const effectiveStatus = computed(() => status.value ?? dspGraphStatus?.value ?? null)
const detached = ref(false)
const editorWindow = useDspEditorWindow((value) => {
  detached.value = value
})
const { target } = editorWindow
const hostDocument = computed(() => target.value?.ownerDocument ?? document)
const visible = computed(() => (detached.value ? dspEditorDocumentVisible.value : props.active))
const processingBypassed = computed(
  () => audioProcessing.value.directMode || !audioProcessing.value.dspEnabled
)
const eqLive = computed(() => !processingBypassed.value && audioProcessing.value.eqEnabled)
const applyLabel = computed(() => dspApplyLabel(effectiveStatus.value))
const engineLabel = computed(() =>
  !audioEngineReady.value
    ? '引擎未连接'
    : audioProcessing.value.directMode
      ? 'Direct 直通'
      : audioProcessing.value.dspEnabled
        ? applyLabel.value
        : 'DSP 已旁路'
)
const clipCount = computed(
  () =>
    effectiveStatus.value?.meter?.clipCount ??
    effectiveStatus.value?.nodes.reduce((sum, node) => sum + (node.clipCount ?? 0), 0) ??
    0
)
const engineError = computed(
  () =>
    error.value ||
    diagnosticsError.value ||
    effectiveStatus.value?.applyError ||
    effectiveStatus.value?.compileError ||
    ''
)
const engineTone = computed(() => {
  if (!audioEngineReady.value) return 'offline'
  if (effectiveStatus.value?.applyState === 'failed') return 'error'
  if (processingBypassed.value) return 'bypassed'
  return applyLabel.value === '已生效' ? 'live' : 'pending'
})
function openSignal(): void {
  signalDialog.value?.showModal()
  signalOpen.value = true
}
function closeSignal(): void {
  signalDialog.value?.close()
}
function signalClosed(): void {
  signalOpen.value = false
  signalButton.value?.focus({ preventScroll: true })
}
async function navigateSignal(next: DspWorkspaceTab): Promise<void> {
  closeSignal()
  await selectTab(next)
}
watch([visible, detached], () => closeSignal())
async function prepareLeave(): Promise<boolean> {
  if (tab.value === 'equalizer' && equalizer.value && !(await equalizer.value.requestLeave()))
    return false
  return (await rack.value?.requestLeave()) ?? true
}
async function requestLeave(): Promise<boolean> {
  if (switching.value || masterBusy.value) return false
  return prepareLeave()
}
async function selectTab(next: DspWorkspaceTab): Promise<void> {
  if (next === tab.value || switching.value || masterBusy.value) return
  switching.value = true
  try {
    if ((next === 'equalizer' || tab.value === 'equalizer') && !(await prepareLeave())) return
    if (!(await rack.value?.finishAudition())) return
    if (tab.value === 'equalizer') await rack.value?.syncFromEngine()
    tab.value = next
    await nextTick()
    contentRef.value?.scrollTo({ top: 0 })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    switching.value = false
  }
}
async function focusNode(id: string): Promise<void> {
  closeSignal()
  await selectTab('chain')
  if (tab.value === 'chain') await rack.value?.focusRuntimeNode(id)
}
watch(
  () => props.initialTab,
  (next) => void selectTab(next)
)
async function toggleMaster(): Promise<void> {
  if (masterBusy.value || switching.value) return
  masterBusy.value = true
  error.value = ''
  try {
    if (!(await prepareLeave())) return
    await outputStore.setAudioProcessing(
      { dspEnabled: !audioProcessing.value.dspEnabled },
      { throwOnError: true }
    )
    await rack.value?.syncFromEngine()
    await rack.value?.refreshDiagnostics()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    masterBusy.value = false
  }
}
function popout(): void {
  closeSignal()
  try {
    editorWindow.open()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
async function leave(): Promise<boolean> {
  if (!(await requestLeave())) return false
  if (detached.value) await editorWindow.dock()
  return true
}
let closingWindow = false
function beforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value || equalizer.value?.busy) {
    event.preventDefault()
    event.returnValue = ''
    if (closingWindow) return
    closingWindow = true
    void leave()
      .then((allowed) => {
        if (allowed) window.api.window.close()
      })
      .finally(() => {
        closingWindow = false
      })
  }
}
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
defineExpose({ requestLeave: leave })
watch(
  [
    () => props.active,
    detached,
    masterBusy,
    switching,
    () => rack.value?.busy,
    () => rack.value?.loading,
    () => equalizer.value?.busy
  ],
  () =>
    emit(
      'suspendReady',
      !props.active &&
        !detached.value &&
        !masterBusy.value &&
        !switching.value &&
        !rack.value?.busy &&
        !rack.value?.loading &&
        !equalizer.value?.busy
    ),
  { immediate: true, flush: 'sync' }
)
</script>

<template>
  <div class="audio-workspace-host" :class="{ detached }">
    <div v-if="detached && active" class="detached-placeholder">
      <span class="placeholder-mark"><i class="pi pi-window-maximize"></i></span>
      <h2>DSP 工作台已在独立窗口中打开</h2>
      <p>草稿、试听与监测都在独立窗口中继续运行；收回后保持不变。</p>
      <div class="toolbar">
        <button @click="editorWindow.focus">显示窗口</button
        ><button class="primary-button" @click="editorWindow.dock">收回主窗口</button>
      </div>
    </div>
    <Teleport :to="target ?? 'body'" :disabled="!target">
      <main
        v-show="active || detached"
        class="audio-workspace"
        :class="{ 'is-detached': detached }"
        :data-engine-tone="engineTone"
        data-testid="audio-workspace"
      >
        <AppBackgroundLayer
          :key="detached ? 'window-background' : 'main-background'"
          page="app"
          embedded
          reading
        />
        <header class="workspace-header">
          <nav class="workspace-tabs" aria-label="DSP 工作台">
            <button
              v-for="item in dspWorkspaceTabs"
              :key="item.id"
              :data-mode="item.mode"
              :title="item.hint"
              :aria-current="tab === item.id ? 'page' : undefined"
              :disabled="switching || rack?.busy || equalizer?.busy"
              @click="selectTab(item.id)"
            >
              <span class="tab-label">{{ item.label }}</span
              ><span
                v-if="item.id === 'equalizer'"
                class="tab-live"
                :class="{ on: eqLive }"
                aria-hidden="true"
              ></span
              ><span
                v-if="(item.id === 'chain' || item.id === 'output') && dirty"
                class="unsaved-mark"
                aria-label="未保存"
              ></span>
            </button>
          </nav>
          <div class="workspace-actions">
            <button
              class="workspace-power"
              :class="{ enabled: !processingBypassed }"
              role="switch"
              :aria-checked="audioProcessing.dspEnabled"
              aria-label="DSP 总开关"
              :disabled="
                masterBusy ||
                switching ||
                rack?.busy ||
                equalizer?.busy ||
                audioProcessing.directMode
              "
              :title="audioProcessing.directMode ? 'Direct 正在旁路 DSP' : '切换 DSP 总开关'"
              @click="toggleMaster"
            >
              <span class="power-switch" aria-hidden="true"><i></i></span>
              <span class="power-copy"><strong>DSP</strong></span>
            </button>
            <button
              ref="signalButton"
              class="workspace-signal-button"
              :aria-expanded="signalOpen"
              aria-controls="dsp-signal-dialog"
              aria-haspopup="dialog"
              @click="openSignal"
            >
              <i class="pi pi-share-alt" aria-hidden="true"></i><span>信号路径</span>
            </button>
            <button
              class="workspace-popout"
              :title="detached ? '收回主窗口' : '在独立窗口中调节'"
              @click="detached ? editorWindow.dock() : popout()"
            >
              <i :class="detached ? 'pi pi-window-minimize' : 'pi pi-external-link'"></i
              ><span class="action-label">{{ detached ? '收回' : '弹出窗口' }}</span>
            </button>
          </div>
        </header>
        <div class="workspace-status" aria-label="音频链路摘要">
          <span class="engine-state" :data-tone="engineTone"
            ><i class="state-dot" aria-hidden="true"></i>{{ engineLabel }}</span
          >
          <DspSignalOverview
            compact
            :status="effectiveStatus"
            :scene-state="sceneState"
            :scene-name="sceneName"
            :disabled="switching || masterBusy || !!rack?.busy || !!equalizer?.busy"
            @node="focusNode"
            @output="selectTab('output')"
            @navigate="selectTab"
          />
          <span v-if="clipCount > 0" class="workspace-clip-warning" role="status"
            ><i class="pi pi-exclamation-triangle" aria-hidden="true"></i
            >{{ clipCount }} 次削波</span
          >
          <span class="status-revision" title="引擎确认的版本 / 请求的版本"
            >ACK {{ effectiveStatus?.appliedRevision ?? effectiveStatus?.revision ?? '—' }} /
            {{ effectiveStatus?.requestedRevision ?? effectiveStatus?.revision ?? '—' }}</span
          >
        </div>
        <dialog
          id="dsp-signal-dialog"
          ref="signalDialog"
          class="signal-dialog"
          aria-labelledby="signal-dialog-title"
          @close="signalClosed"
          @click.self="closeSignal"
        >
          <div class="signal-drawer">
            <header class="signal-drawer-heading">
              <div>
                <p class="page-kicker">从音源到耳畔</p>
                <h2 id="signal-dialog-title">信号路径</h2>
              </div>
              <button class="icon-button" aria-label="关闭信号路径" autofocus @click="closeSignal">
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </header>
            <div class="signal-drawer-body">
              <DspSignalOverview
                :status="effectiveStatus"
                :scene-state="sceneState"
                :scene-name="sceneName"
                :disabled="switching || masterBusy || !!rack?.busy || !!equalizer?.busy"
                @node="focusNode"
                @output="navigateSignal('output')"
                @navigate="navigateSignal"
              />
            </div>
          </div>
        </dialog>
        <div ref="contentRef" class="workspace-content" :data-workspace-tab="tab">
          <div class="workspace-page" :data-tab="tab">
            <p v-if="engineError" class="rack-message error" role="alert">
              <i class="pi pi-exclamation-triangle"></i><span>{{ engineError }}</span>
            </p>
            <div
              v-if="['equalizer', 'chain', 'output'].includes(tab) && processingBypassed"
              class="live-eq-context"
              role="note"
            >
              <i class="pi pi-info-circle" aria-hidden="true"></i
              ><span>{{
                audioProcessing.directMode
                  ? 'Direct 正在旁路音效，退出直通后才能听到调整。'
                  : 'DSP 总开关已旁路：可以继续编辑，开启后才会处理音频。'
              }}</span
              ><button
                v-if="!audioProcessing.directMode"
                class="ghost-button"
                :disabled="masterBusy || switching || equalizer?.busy"
                @click="toggleMaster"
              >
                开启 DSP
              </button>
            </div>
            <EqualizerPage
              v-if="tab === 'equalizer'"
              ref="equalizer"
              embedded
              :visible="visible"
              :host-document="hostDocument"
              :active-scene-id="status?.activeSceneId"
            />
            <DspRackPage
              ref="rack"
              v-show="tab !== 'equalizer'"
              :tab="tab"
              :visible="visible"
              :host-document="hostDocument"
              :master-busy="masterBusy"
              @diagnostic-error="diagnosticsError = $event"
              @status="status = $event"
              @scene="sceneName = $event"
              @state="sceneState = $event"
              @dirty="dirty = $event"
              @navigate="selectTab"
              @master="toggleMaster"
            />
          </div>
        </div>
      </main>
    </Teleport>
  </div>
</template>

<style src="./dsp-rack/DspWorkbench.css"></style>
