import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { baseParse, NodeTypes, type ElementNode, type TemplateChildNode } from '@vue/compiler-dom'
import { computed, effectScope, nextTick, ref, shallowRef, watch } from 'vue'
import * as graph from '../../../../shared/dspGraph.ts'
import * as params from '../../utils/dspNodeParams.ts'
import * as draft from '../../utils/dspSceneDraft.ts'
import * as workbench from '../../utils/dspWorkbench.ts'

const source = readFileSync(new URL('../DspRackPage.vue', import.meta.url), 'utf8')
const script = stripTypeScriptTypes(
  source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
).replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

test('signal codec uses runtime and public format without private playback paths', () => {
  const source = readFileSync(new URL('./DspSignalOverview.vue', import.meta.url), 'utf8')
  const codec = source.match(/const sourceCodec = computed\(\(\) => \{[\s\S]*?\n\}\)/)![0]
  const evaluate = (
    track: Record<string, unknown>,
    playback: Record<string, unknown> = {},
    output: Record<string, unknown> = {}
  ) =>
    runInNewContext(`${codec}; sourceCodec.value`, {
      computed: (read: () => unknown) => ({
        get value() {
          return read()
        }
      }),
      currentTrack: { value: track },
      playbackInfo: { value: playback },
      outputInfo: { value: output }
    })
  assert.equal(evaluate({ format: ' flac ' }), 'FLAC')
  assert.equal(evaluate({ format: 'SACD ISO' }), 'SACD ISO')
  assert.equal(evaluate({ format: 'ALAC' }, { codec: 'unknown' }), 'ALAC')
  assert.equal(evaluate({ format: 'FLAC' }, { codec: 'Opus' }), 'OPUS')
  assert.equal(evaluate({}, { isDsd: true, dsdMode: 'dop' }), 'DSD DoP')
  assert.equal(evaluate({ filePath: 'private.flac' }), 'PCM')
  assert.equal(evaluate({ format: '未知' }), 'PCM')
})

test('workbench templates compile, including multi-action event handlers', () => {
  for (const file of [
    '../AudioWorkspace.vue',
    '../DspRackPage.vue',
    '../EqualizerPage.vue',
    '../settings-page/DspSettingsSection.vue',
    './DspGraphCanvas.vue',
    './DspNodeEditor.vue',
    './DspDraftEqualizer.vue',
    './DspScenePane.vue',
    './DspSceneRules.vue',
    './DspLibrary.vue',
    './DspMonitor.vue',
    './DspSignalOverview.vue',
    './DspOutputPanel.vue'
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const parsed = parse(source, { filename: file })
    assert.deepEqual(parsed.errors, [], file)
    const result = compileTemplate({
      filename: file,
      id: 'dsp-workbench',
      source: parsed.descriptor.template!.content,
      compilerOptions: { expressionPlugins: ['typescript'] }
    })
    assert.deepEqual(result.errors, [], file)
  }
})

test('the settings equalizer entry remains outside the master-bypassed controls and only navigates', () => {
  const source = readFileSync(
    new URL('../settings-page/DspSettingsSection.vue', import.meta.url),
    'utf8'
  )
  const template = baseParse(parse(source).descriptor.template!.content)
  const entries: string[] = []
  function visit(children: TemplateChildNode[], ancestors: ElementNode[]): void {
    for (const node of children) {
      if (node.type !== NodeTypes.ELEMENT) continue
      const click = node.props.find(
        (prop) =>
          prop.type === NodeTypes.DIRECTIVE &&
          prop.name === 'on' &&
          prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
          prop.arg.content === 'click'
      )
      if (
        click?.type === NodeTypes.DIRECTIVE &&
        click.exp?.type === NodeTypes.SIMPLE_EXPRESSION &&
        click.exp.content === 'openEqualizerFromDsp' &&
        ancestors.some((element) =>
          element.props.some(
            (prop) =>
              prop.type === NodeTypes.ATTRIBUTE &&
              prop.name === 'class' &&
              prop.value?.content === 'dsp-actions'
          )
        )
      ) {
        entries.push(click.exp.content)
        assert.ok(
          ![...ancestors, node].some((element) =>
            element.props.some(
              (prop) =>
                (prop.type === NodeTypes.ATTRIBUTE && ['inert', 'disabled'].includes(prop.name)) ||
                (prop.type === NodeTypes.DIRECTIVE &&
                  prop.name === 'bind' &&
                  prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
                  ['inert', 'disabled'].includes(prop.arg.content))
            )
          ),
          `${click.exp.content} is blocked by the master switch`
        )
      }
      visit(node.children, [...ancestors, node])
    }
  }
  visit(template.children, [])
  assert.deepEqual(entries, ['openEqualizerFromDsp'])
  const emitted: string[] = []
  const handlers = entries
    .map((name) => source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))![0])
    .join('\n')
  runInNewContext(
    `${stripTypeScriptTypes(handlers)}\n${entries.map((name) => `${name}()`).join(';')}`,
    {
      emit: (event: string) => emitted.push(event)
    }
  )
  assert.deepEqual(emitted, ['openEqualizer'])
})

test('VST3 settings load through Core without the removed audio bridge', async () => {
  const source = readFileSync(
    new URL('../settings-page/DspSettingsSection.vue', import.meta.url),
    'utf8'
  )
  const handler = source.match(/async function refreshVst3Catalog\(\): Promise<void> \{[\s\S]*?\n\}/)![0]
  const catalog = { enabled: true, entries: [], searchPaths: [] }
  const context = {
    window: { api: {} },
    coreAudio: { getVst3Catalog: async () => catalog },
    vst3Catalog: ref(null),
    vst3Error: ref('previous error'),
    vst3ErrorMessage: String
  }
  await runInNewContext(`${stripTypeScriptTypes(handler)}\nrefreshVst3Catalog()`, context)
  assert.deepEqual(context.vst3Catalog.value, catalog)
  assert.equal(context.vst3Error.value, '')
})

function setup() {
  const one = graph.createDspFactoryScene('headphoneCorrection', 'one')
  const two = graph.createDspFactoryScene('roomCorrection', 'two')
  let persisted: graph.DspSceneState = {
    scenes: [one, two],
    activeSceneId: 'one',
    pinnedSceneId: null,
    graph: one.graph,
    requiresPcmFallback: false,
    dsdPcmFallbackApplied: false
  }
  let fail = false,
    failAssets = false,
    failDiagnostics = false,
    confirm = false,
    saves = 0,
    deletes = 0,
    imports = 0
  const pins: Array<[string | null, boolean]> = []
  const mounted: Array<() => Promise<void>> = [],
    unmounted: Array<() => void> = []
  const scope = effectScope()
  const documentListeners = new Map<string, Set<() => void>>()
  const api = {
    getDspSceneState: async () => plain(persisted),
    setDspScenes: async (scenes: graph.DspScene[], pin: string | null) => {
      saves++
      if (fail) throw Error('engine rejected draft')
      persisted = { ...persisted, scenes: plain(scenes), pinnedSceneId: pin }
      return plain(persisted)
    },
    applyDspScene: async (pin: string | null, consent = false) => {
      pins.push([pin, consent])
      persisted = {
        ...persisted,
        pinnedSceneId: pin,
        activeSceneId: pin ?? 'one',
        dsdPcmFallbackApplied: consent
      }
      return plain(persisted)
    },
    getDspGraphStatus: async () => {
      if (failDiagnostics) throw Error('diagnostics unavailable')
      return {
        revision: 4,
        requestedRevision: 5,
        appliedRevision: 4,
        applyState: 'pending',
        nodes: [],
        activeSceneId: persisted.activeSceneId
      }
    },
    getDspAssets: async () => {
      if (failAssets) throw Error('asset library unavailable')
      return []
    },
    getVst3Catalog: async () => ({ enabled: false, entries: [], searchPaths: [] }),
    deleteDspAsset: async () => {
      deletes++
      return []
    },
    importDspProfile: async () => {
      imports++
      return null
    },
    audition: { end: async () => {} }
  }
  const context: Record<string, any> = {
    ...graph,
    ...params,
    ...draft,
    ...workbench,
    cloneScene: draft.cloneDspScene,
    computed,
    ref,
    shallowRef,
    watch,
    nextTick,
    crypto: { randomUUID },
    navigator: { platform: 'Win32' },
    document: {
      hidden: true,
      addEventListener(name: string, callback: () => void, capture = false) {
        const key = `${name}:${capture}`
        if (!documentListeners.has(key)) documentListeners.set(key, new Set())
        documentListeners.get(key)!.add(callback)
      },
      removeEventListener(name: string, callback: () => void, capture = false) {
        documentListeners.get(`${name}:${capture}`)?.delete(callback)
      },
      activeElement: null
    },
    window: { api: { audioEngine: api }, confirm: () => confirm }, createCoreAudioUi: () => api, useCoreConnection: () => ({}),
    setTimeout,
    clearTimeout,
    defineProps: () => ({ tab: 'chain', visible: false }),
    defineEmits: () => () => {},
    defineExpose() {},
    onMounted: (callback: () => Promise<void>) => mounted.push(callback),
    onBeforeUnmount: (callback: () => void) => unmounted.push(callback),
    usePlayerStore: () => ({ isPlaying: ref(false) }),
    useAudioOutputDspStore: () => ({}),
    storeToRefs: () => ({
      audioProcessing: ref({ dspEnabled: false }),
      outputInfo: ref({ actualSampleRate: 48000 })
    })
  }
  scope.run(() =>
    runInNewContext(
      script +
        `\nglobalThis.controller = { state, saved, selectedScene, selectedNode, selectedSceneId, dirty, history, leaveDialog, error, busy, status, diagnosticsError, poller, selectScene, selectNode, focusRuntimeNode, addNode, removeNode, moveNode, resetNode, checkpoint, beginGesture, endGesture, travel, saveScenes, pinScene, requestLeave, answerLeave, removeAsset, bindAsset, importProfile, discard, reload }`,
      context
    )
  )
  return {
    controller: context.controller,
    mount: async () => {
      for (const callback of mounted) await callback()
    },
    stop: () => {
      for (const callback of unmounted) callback()
      scope.stop()
    },
    dispatchDocument: (name: string) => {
      documentListeners.get(`${name}:true`)?.forEach((callback) => callback())
    },
    hasDocumentListener: (name: string) => !!documentListeners.get(`${name}:true`)?.size,
    setFail: (value: boolean) => {
      fail = value
    },
    setAssetFailure: (value: boolean) => {
      failAssets = value
    },
    setDiagnosticsFailure: (value: boolean) => {
      failDiagnostics = value
    },
    setConfirm: (value: boolean) => {
      confirm = value
    },
    dsd: () => {
      persisted.requiresPcmFallback = true
    },
    get persisted() {
      return persisted
    },
    get saves() {
      return saves
    },
    get deletes() {
      return deletes
    },
    get imports() {
      return imports
    },
    pins
  }
}

test('captured pointer endings checkpoint after final updates and release separate gestures', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    const initial = c.selectedScene.value.name
    assert.equal(fixture.hasDocumentListener('pointerup'), true)
    c.beginGesture()
    c.selectedScene.value.name = 'curve preview'
    fixture.dispatchDocument('pointerup')
    c.selectedScene.value.name = 'curve final'
    await nextTick()
    assert.equal(c.history.canUndo, true)
    c.beginGesture()
    c.selectedScene.value.name = 'second adjustment'
    fixture.dispatchDocument('pointercancel')
    await nextTick()
    c.travel('undo')
    assert.equal(c.selectedScene.value.name, 'curve final')
    c.travel('undo')
    assert.equal(c.selectedScene.value.name, initial)
  } finally {
    fixture.stop()
  }
  assert.equal(fixture.hasDocumentListener('pointerup'), false)
  assert.equal(fixture.hasDocumentListener('pointercancel'), false)
})

test('a post-save library failure does not invalidate persistence or block the leave decision', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    c.selectedScene.value.name = 'Saved successfully'
    const leaving = c.requestLeave()
    await settle()
    fixture.setAssetFailure(true)
    await c.answerLeave('save')
    assert.equal(await leaving, true)
    assert.equal(c.dirty.value, false)
    assert.equal(fixture.persisted.scenes[0].name, 'Saved successfully')
    assert.match(c.error.value, /场景已保存.*资料引用/)
  } finally {
    fixture.stop()
  }
})

test('failed diagnostics clear stale acknowledgements and recover without writing scene drafts', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    await c.poller.refresh()
    assert.equal(c.status.value.revision, 4)
    fixture.setDiagnosticsFailure(true)
    await assert.rejects(c.poller.refresh(), /diagnostics unavailable/)
    assert.equal(c.status.value, null)
    assert.match(c.diagnosticsError.value, /unavailable/)
    fixture.setDiagnosticsFailure(false)
    await c.poller.refresh()
    assert.equal(c.status.value.revision, 4)
    assert.equal(c.diagnosticsError.value, '')
    assert.equal(fixture.saves, 0)
  } finally {
    fixture.stop()
  }
})

test('controller opens read-only, supports all 17 nodes and enforces singleton defaults', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    assert.equal(fixture.saves, 0)
    assert.equal(c.dirty.value, false)
    for (const item of params.nodeCatalog) {
      c.addNode(item.type)
      assert.equal(c.selectedNode.value.type, item.type)
      c.resetNode()
    }
    assert.equal(
      new Set(c.selectedScene.value.graph.nodes.map((node: graph.DspGraphNode) => node.type)).size,
      17
    )
    const count = c.selectedScene.value.graph.nodes.length
    c.addNode('compressor')
    assert.equal(c.selectedScene.value.graph.nodes.length, count)
    c.addNode('vst3Plugin')
    assert.equal(c.selectedScene.value.graph.nodes.length, count + 1)
    assert.equal(fixture.saves, 0)
  } finally {
    fixture.stop()
  }
})

test('runtime chain shortcuts select the active scene and protect unrelated scene drafts', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    const activeNode = c.selectedScene.value.graph.nodes[0]
    c.selectScene('two')
    await c.focusRuntimeNode(activeNode.id)
    assert.equal(c.selectedSceneId.value, 'one')
    assert.equal(c.selectedNode.value.id, activeNode.id)
    c.selectScene('two')
    c.selectedScene.value.name = 'Unfinished room correction'
    const navigating = c.focusRuntimeNode(activeNode.id)
    await settle()
    assert.equal(c.leaveDialog.value, true)
    await c.answerLeave('cancel')
    await navigating
    assert.equal(c.selectedSceneId.value, 'two')
    assert.equal(c.selectedScene.value.name, 'Unfinished room correction')
    assert.equal(fixture.saves, 0)
  } finally {
    fixture.stop()
  }
})

test('one gesture is one undo step; rejected saves keep drafts and the leave decision open', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller,
      initial = c.selectedScene.value.name
    c.beginGesture()
    c.selectedScene.value.name = 'drag 1'
    c.selectedScene.value.name = 'drag end'
    c.endGesture()
    c.travel('undo')
    assert.equal(c.selectedScene.value.name, initial)
    c.travel('redo')
    assert.equal(c.selectedScene.value.name, 'drag end')
    const cancelled = c.requestLeave()
    await settle()
    assert.equal(c.leaveDialog.value, true)
    await c.answerLeave('cancel')
    assert.equal(await cancelled, false)
    const leaving = c.requestLeave()
    await settle()
    fixture.setFail(true)
    await c.answerLeave('save')
    assert.equal(c.leaveDialog.value, true)
    assert.equal(c.dirty.value, true)
    assert.match(c.error.value, /engine rejected/)
    assert.equal(c.selectedScene.value.name, 'drag end')
    fixture.setFail(false)
    await c.answerLeave('save')
    assert.equal(await leaving, true)
    assert.equal(c.dirty.value, false)
    assert.equal(fixture.persisted.pinnedSceneId, null)
  } finally {
    fixture.stop()
  }
})

test('save does not pin the edited scene; pin/automatic and DSD cancellation preserve their contracts', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    c.selectScene('two')
    c.selectedScene.value.name = 'Speakers edited'
    assert.equal(await c.saveScenes(), true)
    assert.equal(fixture.persisted.activeSceneId, 'one')
    assert.equal(fixture.persisted.pinnedSceneId, null)
    await c.pinScene('two')
    assert.equal(fixture.persisted.pinnedSceneId, 'two')
    await c.pinScene(null)
    assert.equal(fixture.persisted.pinnedSceneId, null)
    fixture.dsd()
    fixture.setConfirm(false)
    await c.pinScene('two')
    assert.deepEqual(fixture.pins.slice(-2), [
      ['two', false],
      [null, false]
    ])
    assert.equal(fixture.persisted.dsdPcmFallbackApplied, false)
    fixture.setConfirm(true)
    await c.pinScene('two')
    assert.deepEqual(fixture.pins.at(-1), ['two', true])
  } finally {
    fixture.stop()
  }
})

test('both saved and draft references protect managed assets, even after draft unbinding', async () => {
  const fixture = setup()
  try {
    await fixture.mount()
    const c = fixture.controller
    c.addNode('convolver')
    await c.bindAsset({ id: 'ir', kind: 'impulseResponse' })
    fixture.setConfirm(true)
    await c.removeAsset('ir')
    assert.equal(fixture.deletes, 0)
    await c.saveScenes()
    delete c.selectedNode.value.params.impulseResponseAssetId
    await c.removeAsset('ir')
    assert.equal(fixture.deletes, 0)
    await c.saveScenes()
    await c.removeAsset('ir')
    assert.equal(fixture.deletes, 1)
  } finally {
    fixture.stop()
  }
})

test(
  'configuration import resolves draft state and requires replacement consent',
  { timeout: 5000 },
  async () => {
    const fixture = setup()
    try {
      await fixture.mount()
      const c = fixture.controller
      c.selectedScene.value.name = 'unsaved'
      const importing = c.importProfile()
      await settle()
      await c.answerLeave('cancel')
      await importing
      assert.equal(fixture.imports, 0)
      const declined = c.importProfile()
      await settle()
      await c.answerLeave('discard')
      await declined
      assert.equal(fixture.imports, 0)
      fixture.setConfirm(true)
      await c.importProfile()
      assert.equal(fixture.imports, 1)
    } finally {
      fixture.stop()
    }
  }
)
