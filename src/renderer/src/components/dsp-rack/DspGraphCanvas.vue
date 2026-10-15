<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import type { DspNodeType, DspScene, DspSceneState } from '../../../../shared/dspGraph.ts'
import { nodeCatalog, nodeLabel } from '@renderer/utils/dspNodeParams'

const scene = defineModel<DspScene | null>('scene')
const nodeTypeToAdd = defineModel<DspNodeType>('nodeTypeToAdd')

defineProps<{
  selectedNodeId: string | null
  busy: boolean
  isPinned: boolean
  snapshotA: boolean
  state: DspSceneState | null
  vst3HelpersNotice: string
  soxrFallbackActive: boolean
}>()

const emit = defineEmits<{
  selectNode: [id: string]
  addNode: []
  removeNode: [id: string]
  moveNode: [id: string, destinationId: string]
  apply: []
  save: []
  togglePin: []
  toggleSnapshot: []
  setOutputTarget: [value: string]
  setOutputQuality: [value: string]
  setOutputDither: [value: string]
}>()

const draggedNodeId = ref<string | null>(null)
const keyboardHintId = useId()
const keyboardStatus = ref('')

function onNodeKeydown(event: KeyboardEvent, id: string): void {
  if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.shiftKey)
    return
  if ((event.key === 'Enter' || event.key === ' ') && !event.altKey) {
    event.preventDefault()
    if (!event.repeat) emit('selectNode', id)
    return
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  const nodes = scene.value?.graph.nodes ?? []
  const index = nodes.findIndex((node) => node.id === id)
  const destination = nodes[index + (event.key === 'ArrowUp' ? -1 : 1)]
  if (!destination) return
  const current = event.currentTarget as HTMLElement
  if (event.altKey) {
    emit('moveNode', id, destination.id)
    keyboardStatus.value = `${nodeLabel(nodes[index].type)}，第 ${index + (event.key === 'ArrowUp' ? 0 : 2)} 个节点`
    void nextTick(() => current.focus({ preventScroll: true }))
  } else {
    const slots = current.parentElement?.parentElement?.children
    const next =
      slots?.[index + (event.key === 'ArrowUp' ? -1 : 1)]?.querySelector<HTMLElement>('.graph-node')
    next?.focus()
  }
}

function onDrop(destinationId: string): void {
  if (draggedNodeId.value) emit('moveNode', draggedNodeId.value, destinationId)
  draggedNodeId.value = null
}
</script>

<template>
  <section class="graph-pane">
    <template v-if="scene">
      <div class="scene-toolbar">
        <label>名称<input v-model="scene.name" maxlength="64" /></label>
        <label>优先级<input v-model.number="scene.priority" type="number" step="1" /></label>
        <label class="switch-field"
          ><input v-model="scene.enabled" type="checkbox" /> 场景启用</label
        >
        <button
          type="button"
          class="icon-text-button"
          :class="{ selected: isPinned }"
          @click="emit('togglePin')"
        >
          <i class="pi pi-thumbtack"></i>{{ isPinned ? '取消固定' : '固定场景' }}
        </button>
        <button type="button" class="icon-text-button" @click="emit('toggleSnapshot')">
          <i class="pi pi-clone"></i>{{ snapshotA ? '恢复 A' : '记录 A' }}
        </button>
        <button type="button" class="primary-button" :disabled="busy" @click="emit('apply')">
          <i class="pi pi-play"></i>应用
        </button>
        <button type="button" class="icon-text-button" :disabled="busy" @click="emit('save')">
          <i class="pi pi-save"></i>保存
        </button>
      </div>

      <div v-if="state?.requiresPcmFallback && !state.dsdPcmFallbackApplied" class="dsd-notice">
        <i class="pi pi-info-circle"></i
        ><span>当前 DSD Direct/DoP 保持直通。应用 DSP 需要明确确认 PCM 回退。</span>
      </div>

      <div v-if="vst3HelpersNotice" class="dsd-notice" role="status">
        <i class="pi pi-exclamation-triangle"></i>
        <span>{{ vst3HelpersNotice }}</span>
      </div>

      <div class="graph-heading">
        <div>
          <h2>串行处理图</h2>
          <span>{{ scene.graph.nodes.length }} 个节点</span>
        </div>
        <div class="node-add">
          <select v-model="nodeTypeToAdd">
            <option v-for="item in nodeCatalog" :key="item.type" :value="item.type">
              {{ item.label }}
            </option></select
          ><button type="button" class="icon-button" title="添加节点" @click="emit('addNode')">
            <i class="pi pi-plus"></i>
          </button>
        </div>
      </div>

      <section class="output-stage">
        <label
          >输出采样率
          <select
            :value="String(scene.graph.outputStage.targetSampleRate)"
            @change="emit('setOutputTarget', ($event.target as HTMLSelectElement).value)"
          >
            <option value="device">跟随设备</option>
            <option value="44100">44.1 kHz</option>
            <option value="48000">48 kHz</option>
            <option value="88200">88.2 kHz</option>
            <option value="96000">96 kHz</option>
            <option value="176400">176.4 kHz</option>
            <option value="192000">192 kHz</option>
          </select>
        </label>
        <label
          >重采样质量
          <select
            :value="scene.graph.outputStage.resamplerQuality"
            @change="emit('setOutputQuality', ($event.target as HTMLSelectElement).value)"
          >
            <option value="native">原生</option>
            <option value="high">高</option>
            <option value="ultra">极高</option>
            <option value="soxrHq">
              SoX HQ{{ soxrFallbackActive ? '（不可用，回退 Ultra）' : '' }}
            </option>
            <option value="soxrVhq">
              SoX VHQ (最高){{ soxrFallbackActive ? '（不可用，回退 Ultra）' : '' }}
            </option>
          </select>
        </label>
        <label
          >抖动处理
          <select
            :value="scene.graph.outputStage.dither"
            @change="emit('setOutputDither', ($event.target as HTMLSelectElement).value)"
          >
            <option value="off">关闭</option>
            <option value="tpdf">TPDF</option>
            <option value="highpassTpdf">High-pass TPDF</option>
            <option value="noiseShaped">Noise-shaped</option>
          </select>
        </label>
        <label class="switch-field"
          ><input v-model="scene.graph.outputStage.safetyClamp" type="checkbox" /> 输出安全保护</label
        >
      </section>

      <p :id="keyboardHintId" class="graph-keyboard-hint">
        Enter 选择节点 · ↑↓ 移动焦点 · Alt + ↑↓ 调整顺序
      </p>
      <p class="graph-keyboard-status" role="status" aria-live="polite">{{ keyboardStatus }}</p>
      <TransitionGroup
        name="dsp-node"
        tag="div"
        class="node-list"
        role="list"
        aria-label="DSP 处理节点"
      >
        <div v-for="node in scene.graph.nodes" :key="node.id" class="dsp-node-slot">
          <article
            draggable="true"
            class="graph-node"
            role="listitem"
            tabindex="0"
            :aria-label="`${nodeLabel(node.type)}${node.id === selectedNodeId ? '，已选择' : ''}${node.enabled ? '' : '，已旁路'}`"
            :aria-describedby="keyboardHintId"
            data-te-interactive
            :class="{ selected: node.id === selectedNodeId, bypassed: !node.enabled }"
            @dragstart="draggedNodeId = node.id"
            @dragend="draggedNodeId = null"
            @keydown="onNodeKeydown($event, node.id)"
            @dragover.prevent
            @drop="onDrop(node.id)"
            @click="emit('selectNode', node.id)"
          >
            <i class="pi pi-bars drag-handle" aria-hidden="true"></i>
            <i
              :class="nodeCatalog.find((item) => item.type === node.type)?.icon ?? 'pi pi-circle'"
            ></i>
            <div>
              <strong>{{ nodeLabel(node.type) }}</strong
              ><small>{{ node.enabled ? '已启用' : '已旁路' }}</small>
            </div>
            <button
              type="button"
              class="icon-button small"
              :title="node.enabled ? '旁路节点' : '启用节点'"
              @click.stop="node.enabled = !node.enabled"
            >
              <i :class="node.enabled ? 'pi pi-eye' : 'pi pi-eye-slash'"></i>
            </button>
            <button
              type="button"
              class="icon-button small danger"
              title="移除节点"
              @click.stop="emit('removeNode', node.id)"
            >
              <i class="pi pi-times"></i>
            </button>
          </article>
        </div>
      </TransitionGroup>
      <p class="v1-note">
        ABI v1 原生插件固定在图末端、输出安全保护之前；仅 ABI v2 节点可参与此排序。
      </p>
    </template>
  </section>
</template>

<style scoped>
.dsp-node-move {
  transition: transform var(--te-motion-hover) var(--te-ease-soft);
}

.graph-keyboard-hint {
  margin: 0 0 12px;
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
}

.graph-keyboard-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}

.graph-node:focus-visible {
  outline: 2px solid var(--te-control-focus-color, var(--te-primary-500));
  outline-offset: -2px;
}

html[data-te-motion='reduced'] .dsp-node-slot {
  transform: none !important;
  transition: none !important;
}
</style>
