import type { DspGraphNode, DspGraphStatus, DspScene } from '../../../shared/dspGraph.ts'

export type DspWorkspaceTab = 'equalizer' | 'chain' | 'library' | 'monitor' | 'output'
/**
 * How a workspace surface reaches the engine. `live` edits apply immediately,
 * `draft` edits wait for an explicit save, `status` and `assets` never alter
 * the signal on their own.
 */
export type DspWorkspaceMode = 'status' | 'live' | 'draft' | 'assets'
export const dspWorkspaceTabs: {
  id: DspWorkspaceTab
  label: string
  icon: string
  mode: DspWorkspaceMode
  hint: string
}[] = [
  {
    id: 'monitor',
    label: '总览',
    icon: 'pi pi-wave-pulse',
    mode: 'status',
    hint: '信号、响度与链路健康'
  },
  {
    id: 'equalizer',
    label: '均衡器',
    icon: 'pi pi-sliders-h',
    mode: 'live',
    hint: '实时生效 · 耳机校正与音色'
  },
  {
    id: 'chain',
    label: '效果链',
    icon: 'pi pi-sitemap',
    mode: 'draft',
    hint: '场景草稿 · 保存后生效'
  },
  {
    id: 'output',
    label: '输出',
    icon: 'pi pi-microchip',
    mode: 'draft',
    hint: '采样率、抖动与设备缓冲'
  },
  {
    id: 'library',
    label: '资料库',
    icon: 'pi pi-box',
    mode: 'assets',
    hint: '脉冲响应、校正文件与 VST3'
  }
]

function compactRate(rate: number): string {
  return `${Number((rate / 1000).toFixed(1))}k`
}

/** Human-readable conditions under which automatic matching selects a scene. */
export function dspSceneRuleSummary(scene: DspScene | null | undefined): string[] {
  if (!scene) return []
  if (!scene.enabled) return ['不参与自动匹配']
  const rules = scene.rules ?? {}
  const summary: string[] = []
  if (rules.deviceIds?.length) summary.push(`${rules.deviceIds.length} 个指定设备`)
  if (rules.backends?.length) summary.push(rules.backends.join(' / '))
  if (rules.channelLayouts?.length) summary.push(rules.channelLayouts.join(' / '))
  if (rules.sourceKinds?.length)
    summary.push(rules.sourceKinds.map((kind) => kind.toUpperCase()).join(' / '))
  const min = rules.minSampleRate
  const max = rules.maxSampleRate
  if (min && max) summary.push(`${compactRate(min)}–${compactRate(max)} Hz`)
  else if (min) summary.push(`≥ ${compactRate(min)} Hz`)
  else if (max) summary.push(`≤ ${compactRate(max)} Hz`)
  return summary.length ? summary : ['任意设备与格式']
}

export function dspApplyLabel(status: DspGraphStatus | null): string {
  if (!status) return '等待引擎'
  if (status.applyState === 'failed') return '应用失败'
  if (
    status.applyState === 'applied' &&
    status.requestedRevision !== undefined &&
    status.appliedRevision === status.requestedRevision &&
    status.revision === status.appliedRevision
  )
    return '已生效'
  return status.applyState === 'idle' ? '待命' : '等待引擎确认'
}

export function dspAssetReferences(scenes: DspScene[], assetId: string): string[] {
  return scenes
    .filter((scene) =>
      scene.graph.nodes.some(
        (node) =>
          node.params.impulseResponseAssetId === assetId ||
          node.params.correctionAssetId === assetId ||
          node.vst3?.stateAssetId === assetId
      )
    )
    .map((scene) => scene.name)
}

export function moveDspNode(nodes: DspGraphNode[], id: string, destinationId: string): boolean {
  const from = nodes.findIndex((node) => node.id === id)
  const to = nodes.findIndex((node) => node.id === destinationId)
  if (from < 0 || to < 0 || from === to) return false
  // ABI v1 is appended by the native host, not reordered within the v2 chain.
  if (
    [nodes[from], nodes[to]].some(
      (node) => node.type === 'nativePlugin' && node.pluginAbiVersion === 1
    )
  )
    return false
  const [node] = nodes.splice(from, 1)
  nodes.splice(to, 0, node)
  return true
}

export function normalizeDspSerialOrder(nodes: DspGraphNode[]): void {
  const fixed = (node: DspGraphNode) => node.type === 'nativePlugin' && node.pluginAbiVersion === 1
  nodes.splice(0, nodes.length, ...nodes.filter((node) => !fixed(node)), ...nodes.filter(fixed))
}

/** A bounded, serializable draft history. UI gestures decide when to checkpoint. */
export function createDspDraftHistory(initial: string) {
  let entries = [initial]
  let cursor = 0
  return {
    get canUndo() {
      return cursor > 0
    },
    get canRedo() {
      return cursor < entries.length - 1
    },
    reset(value: string) {
      entries = [value]
      cursor = 0
    },
    snapshot: () => ({ entries: [...entries], cursor }),
    restore(value: { entries: string[]; cursor: number }) {
      entries = [...value.entries]
      cursor = value.cursor
    },
    push(value: string) {
      if (entries[cursor] === value) return
      entries = entries.slice(0, cursor + 1)
      entries.push(value)
      if (entries.length > 80) entries.shift()
      cursor = entries.length - 1
    },
    undo() {
      if (cursor > 0) cursor--
      return entries[cursor]
    },
    redo() {
      if (cursor < entries.length - 1) cursor++
      return entries[cursor]
    }
  }
}

/** One in-flight diagnostic request; hiding cancels the next scheduled request. */
export function createDspDiagnosticsPoller(options: {
  read: () => Promise<void>
  visible: () => boolean
  playing: () => boolean
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}) {
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let stopped = true
  let generation = 0
  const clear = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const refresh = (): Promise<void> => {
    if (running) return running
    running = options.read().finally(() => {
      running = null
    })
    return running
  }
  async function tick(current: number): Promise<void> {
    clear()
    if (stopped || !options.visible()) return
    try {
      await refresh()
    } catch {
      /* The reader owns visible error feedback. */
    }
    if (!stopped && current === generation && options.visible())
      timer = schedule(() => void tick(current), options.playing() ? 250 : 1500)
  }
  return {
    refresh,
    async refreshAfterCurrent(): Promise<void> {
      // A read started before a write cannot acknowledge that write.
      if (running) await running.catch(() => undefined)
      return refresh()
    },
    update() {
      stopped = false
      generation++
      clear()
      if (options.visible()) void tick(generation)
    },
    stop() {
      stopped = true
      generation++
      clear()
    }
  }
}
