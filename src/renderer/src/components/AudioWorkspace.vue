<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref } from 'vue'
import type { AudioWorkspaceTab } from '../app/useAppNavigation'
import { useAudioOutputDspStore } from '../stores/useAudioOutputDspStore'
import { useDspEditorWindow } from '../composables/useDspEditorWindow'
import AppBackgroundLayer from './AppBackgroundLayer.vue'

const EqualizerPage = defineAsyncComponent(() => import('./EqualizerPage.vue'))
const DspRackPage = defineAsyncComponent(() => import('./DspRackPage.vue'))
const props = defineProps<{ tab: AudioWorkspaceTab; active?: boolean }>()
const emit = defineEmits<{
  switchTab: [tab: AudioWorkspaceTab]
  detachedChange: [detached: boolean]
}>()
const detachedTab = ref<AudioWorkspaceTab>(props.tab)
const tab = computed(() => (props.active === false ? detachedTab.value : props.tab))
const editorWindow = useDspEditorWindow((detached) => {
  if (!detached && props.active === false && !disposed) emit('switchTab', detachedTab.value)
  emit('detachedChange', detached)
})
const portalTarget = editorWindow.target
const audioStore = useAudioOutputDspStore()
const pageRef = ref<{
  requestLeave: () => Promise<boolean>
  refreshFromEngine?: () => Promise<void>
} | null>(null)
const leavePending = ref(false)
const dspPending = ref(false)
const errorMessage = ref('')
const dspEnabled = computed(() => audioStore.audioProcessing.dspEnabled)
const busy = computed(() => leavePending.value || dspPending.value)
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

async function requestLeave(): Promise<boolean> {
  if (busy.value || !pageRef.value) return false
  leavePending.value = true
  errorMessage.value = ''
  try {
    return (await pageRef.value.requestLeave()) && !disposed
  } catch (error) {
    errorMessage.value = `暂时无法离开：${error instanceof Error ? error.message : String(error)}`
    return false
  } finally {
    leavePending.value = false
  }
}

async function requestTabChange(tab: AudioWorkspaceTab): Promise<void> {
  if (tab === (props.active === false ? detachedTab.value : props.tab)) return
  const initialTab = props.active === false ? detachedTab.value : props.tab
  if (
    !(await requestLeave()) ||
    (props.active === false ? detachedTab.value : props.tab) !== initialTab
  )
    return
  detachedTab.value = tab
  if (props.active !== false) emit('switchTab', tab)
  await nextTick()
  if (!disposed)
    (portalTarget.value?.ownerDocument ?? document)
      .getElementById(`audio-workspace-tab-${tab}`)
      ?.focus({ preventScroll: true })
}

function onTabKeydown(event: KeyboardEvent): void {
  let target: AudioWorkspaceTab
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    target = tab.value === 'equalizer' ? 'effects' : 'equalizer'
  else if (event.key === 'Home') target = 'equalizer'
  else if (event.key === 'End') target = 'effects'
  else return
  event.preventDefault()
  void requestTabChange(target)
}

async function toggleDsp(): Promise<void> {
  // Commit pending EQ changes or resolve a scene draft before the engine update.
  if (!(await requestLeave())) return
  dspPending.value = true
  errorMessage.value = ''
  try {
    await audioStore.setAudioProcessing({ dspEnabled: !dspEnabled.value }, { throwOnError: true })
    if (!disposed && tab.value === 'effects') await pageRef.value?.refreshFromEngine?.()
  } catch (error) {
    errorMessage.value = `应用 DSP 状态失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    dspPending.value = false
  }
}

function openEditorWindow(): void {
  detachedTab.value = tab.value
  errorMessage.value = ''
  try {
    editorWindow.open()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

defineExpose({
  requestLeave: () => (portalTarget.value ? Promise.resolve(true) : requestLeave()),
  focusEditorWindow: editorWindow.focus,
  showEditorTab: async (requestedTab: AudioWorkspaceTab) => {
    await requestTabChange(requestedTab)
    editorWindow.focus()
  }
})
</script>

<template>
  <section v-if="portalTarget && props.active !== false" class="audio-window-placeholder">
    <h1>DSP</h1>
    <p>调节已在独立窗口中打开。你可以继续浏览音乐。</p>
    <div>
      <button type="button" @click="editorWindow.focus">显示 DSP 窗口</button>
      <button type="button" @click="editorWindow.dock">移回主窗口</button>
    </div>
  </section>
  <Teleport :to="portalTarget ?? 'body'" :disabled="!portalTarget">
    <main
      v-show="props.active !== false || portalTarget"
      class="audio-workspace"
      aria-labelledby="audio-workspace-title"
    >
      <AppBackgroundLayer page="app" embedded reading />
      <header class="audio-workspace-header">
        <div class="audio-workspace-heading">
          <h1 id="audio-workspace-title">DSP</h1>
          <div class="audio-workspace-actions">
            <button
              v-if="portalTarget"
              type="button"
              class="audio-window-button"
              @click="editorWindow.dock"
            >
              <i class="pi pi-window-minimize" aria-hidden="true"></i>移回主窗口
            </button>
            <button
              v-else
              type="button"
              class="audio-window-button"
              :disabled="busy"
              @click="openEditorWindow"
            >
              <i class="pi pi-window-maximize" aria-hidden="true"></i>在独立窗口调节
            </button>
            <div class="audio-workspace-power">
              <span id="audio-workspace-power-label">总 DSP</span>
              <button
                type="button"
                class="audio-workspace-power-switch"
                role="switch"
                aria-labelledby="audio-workspace-power-label"
                aria-describedby="audio-workspace-status"
                :aria-checked="dspEnabled"
                :disabled="busy"
                @click="toggleDsp"
              >
                {{ dspPending ? '正在应用…' : dspEnabled ? '已开启' : '已关闭' }}
              </button>
            </div>
          </div>
        </div>
        <p id="audio-workspace-status" class="audio-workspace-status" aria-live="polite">
          {{
            dspEnabled
              ? 'DSP 已开启，可在下方调整均衡器和效果链。'
              : 'DSP 已关闭，均衡器和效果链的调整暂不影响播放声音。'
          }}
        </p>
        <p v-if="errorMessage" class="audio-workspace-error" role="alert">{{ errorMessage }}</p>
        <div class="audio-workspace-tabs" role="tablist" aria-label="音频处理">
          <button
            id="audio-workspace-tab-equalizer"
            type="button"
            role="tab"
            aria-controls="audio-workspace-panel"
            :aria-selected="tab === 'equalizer'"
            :tabindex="tab === 'equalizer' ? 0 : -1"
            :aria-disabled="busy"
            @click="requestTabChange('equalizer')"
            @keydown="onTabKeydown"
          >
            均衡器
          </button>
          <button
            id="audio-workspace-tab-effects"
            type="button"
            role="tab"
            aria-controls="audio-workspace-panel"
            :aria-selected="tab === 'effects'"
            :tabindex="tab === 'effects' ? 0 : -1"
            :aria-disabled="busy"
            @click="requestTabChange('effects')"
            @keydown="onTabKeydown"
          >
            效果链
          </button>
        </div>
      </header>
      <div
        id="audio-workspace-panel"
        class="audio-workspace-body"
        role="tabpanel"
        :aria-labelledby="`audio-workspace-tab-${tab}`"
        :aria-busy="busy"
        :inert="busy"
      >
        <EqualizerPage
          v-if="tab === 'equalizer'"
          ref="pageRef"
          embedded
          :navigation-locked="busy"
        />
        <DspRackPage v-else ref="pageRef" embedded />
      </div>
    </main>
  </Teleport>
</template>

<style scoped>
.audio-workspace {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  padding: calc(var(--te-titlebar-inset, 40px) + var(--te-page-top, 32px))
    var(--te-page-inset, 32px) 0;
  overflow: hidden;
  background-color: var(--te-app-bg);
  color: var(--te-text-primary, var(--te-settings-text));
}

.audio-workspace > .app-background-layer {
  display: block;
}

.audio-workspace-header {
  flex: 0 0 auto;
  min-width: 0;
}

.audio-workspace-heading,
.audio-workspace-power,
.audio-workspace-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.audio-workspace-heading {
  justify-content: space-between;
  flex-wrap: wrap;
}

.audio-workspace-heading h1 {
  margin: 0;
  font-size: var(--te-type-page-title);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.audio-workspace-power {
  font-size: var(--te-type-caption);
}

.audio-workspace-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.audio-window-button,
.audio-window-placeholder button {
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--te-control-border);
  border-radius: var(--te-control-radius-sm, 6px);
  background: var(--te-control-bg);
  color: var(--te-control-fg);
  font: inherit;
  font-size: var(--te-type-body);
  cursor: pointer;
}

.audio-window-button i {
  margin-right: 8px;
}
.audio-window-placeholder {
  box-sizing: border-box;
  min-height: 100dvh;
  padding: calc(var(--te-titlebar-inset, 40px) + 24px) var(--te-page-inset, 32px);
  background: var(--te-app-bg);
  color: var(--te-text-primary);
}
.audio-window-placeholder h1 {
  margin: 0 0 12px;
  font-size: var(--te-type-page-title);
}
.audio-window-placeholder p {
  margin: 0 0 20px;
  color: var(--te-settings-text-muted);
}
.audio-window-placeholder > div {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.audio-workspace-power-switch {
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--te-control-border);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.audio-workspace-power-switch[aria-checked='true'] {
  background: var(--te-control-bg);
  color: var(--te-control-fg);
}

.audio-workspace-status {
  margin: 8px 0 12px;
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  line-height: 1.5;
}

.audio-workspace-error {
  margin: 0 0 12px;
  color: var(--te-danger-soft-fg);
  font-size: var(--te-type-caption);
}

.audio-workspace-tabs {
  display: flex;
  gap: 24px;
  border-bottom: 1px solid var(--te-control-border);
}

.audio-workspace-tabs button {
  min-height: 36px;
  padding: 6px 0 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--te-settings-text-muted);
  font: inherit;
  font-size: var(--te-type-body);
  cursor: pointer;
}

.audio-workspace-tabs button[aria-selected='true'] {
  border-bottom-color: currentColor;
  color: var(--te-text-primary, var(--te-settings-text));
  font-weight: 600;
}

.audio-workspace-header button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}

.audio-workspace-header button:disabled,
.audio-workspace-header button[aria-disabled='true'] {
  cursor: default;
  opacity: 0.55;
}

.audio-workspace-body {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

@media (max-width: 720px) {
  .audio-workspace {
    padding-inline: var(--te-page-inset, 16px);
  }
  .audio-workspace-heading {
    gap: 12px;
  }
}
</style>
