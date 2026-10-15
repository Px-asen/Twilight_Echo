const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')
const vue = require('vue')
const { parse, compileScript, compileStyle, compileTemplate } = require('@vue/compiler-sfc')
const graphModule = require('../../../shared/dspGraph.ts')
const paramsModule = require('../utils/dspNodeParams.ts')
const draftModule = require('../utils/dspSceneDraft.ts')

const filename = join(__dirname, 'DspRackPage.vue')
const source = readFileSync(filename, 'utf8')
const parsed = parse(source, { filename })
assert.deepEqual(parsed.errors, [])
const script = compileScript(parsed.descriptor, { id: 'rack-draft' })
const code = ts.transpileModule(script.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const copy = (value) => JSON.parse(JSON.stringify(value))

function sceneState() {
  const first = graphModule.createDspFactoryScene('transparent', 'first')
  const second = graphModule.createDspFactoryScene('transparent', 'second')
  second.graph.nodes.push({
    id: 'legacy-matrix',
    type: 'channelMatrix',
    enabled: false,
    params: { layout: 'legacy', matrix: [] }
  })
  return {
    scenes: [first, second],
    pinnedSceneId: null,
    activeSceneId: first.id,
    graph: first.graph,
    requiresPcmFallback: false,
    dsdPcmFallbackApplied: false
  }
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function fixture() {
  let engineState = sceneState()
  const mounted = []
  const unmounted = []
  const calls = { read: 0, save: 0, apply: 0, import: 0, diagnostics: 0 }
  const mainDocument = { hidden: false }
  let diagnosticsPoll = () => {}
  const api = {
    async getDspSceneState() {
      calls.read++
      return copy(engineState)
    },
    async getDspGraphStatus() {
      calls.diagnostics++
      return { nodes: [], applyState: 'applied' }
    },
    async getDspAssets() {
      return []
    },
    async getVst3Catalog() {
      return { entries: [] }
    },
    async setDspScenes(scenes, pinnedSceneId) {
      calls.save++
      engineState = { ...engineState, scenes: copy(scenes), pinnedSceneId }
      engineState.activeSceneId = pinnedSceneId ?? scenes[0].id
      engineState.graph = engineState.scenes.find(
        (scene) => scene.id === engineState.activeSceneId
      ).graph
      return copy(engineState)
    },
    async applyDspScene() {
      calls.apply++
      return copy(engineState)
    },
    async importDspProfile() {
      calls.import++
      return { state: copy(engineState) }
    },
    async importDspAsset() {
      return null
    }
  }
  const exports = {}
  vm.runInNewContext(code, {
    exports,
    Error,
    navigator: { platform: 'Win32' },
    document: mainDocument,
    window: {
      api: { audioEngine: api },
      confirm: () => false,
      setInterval: (callback) => {
        diagnosticsPoll = callback
        return 1
      },
      clearInterval() {}
    },
    require(id) {
      if (id === 'vue')
        return {
          ...vue,
          onMounted: (callback) => mounted.push(callback),
          onBeforeUnmount: (callback) => unmounted.push(callback)
        }
      if (id === '../../../shared/dspGraph.ts') return graphModule
      if (id === '@renderer/utils/dspNodeParams') return paramsModule
      if (id === '@renderer/utils/dspSceneDraft') return draftModule
      if (id.endsWith('.vue')) return { default: {} }
      throw new Error(`Unexpected fixture dependency: ${id}`)
    }
  })
  let exposed
  const rack = exports.default.setup(
    { embedded: true },
    {
      expose: (value) => {
        exposed = value
      }
    }
  )
  return {
    rack,
    api,
    calls,
    mainDocument,
    async pollDiagnostics() {
      diagnosticsPoll()
      await Promise.resolve()
    },
    exposed,
    replaceEngine(next) {
      engineState = copy(next)
    },
    async mount() {
      await Promise.all(mounted.map((callback) => callback()))
    },
    dispose() {
      unmounted.forEach((callback) => callback())
    }
  }
}

test('detached effects keep refreshing while the main window is hidden and stop when the editor is hidden', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.mainDocument.hidden = true
    const editorDocument = { hidden: false }
    view.rack.rackRoot.value = { ownerDocument: editorDocument }
    const before = view.calls.diagnostics
    await view.pollDiagnostics()
    assert.equal(view.calls.diagnostics, before + 1)
    editorDocument.hidden = true
    await view.pollDiagnostics()
    assert.equal(view.calls.diagnostics, before + 1)
    view.rack.rackRoot.value = { ownerDocument: view.mainDocument }
    await view.pollDiagnostics()
    assert.equal(view.calls.diagnostics, before + 1)
  } finally {
    view.dispose()
  }
})

test('DSP workspace exposes an async leave guard and blocks the initial load without saving', async () => {
  const view = fixture()
  try {
    const leave = view.exposed.requestLeave()
    assert.equal(typeof leave.then, 'function')
    assert.equal(await leave, false)
    assert.match(view.rack.message.value, /正在读取/)
    assert.equal(view.calls.save, 0)
    await view.mount()
    assert.equal(await view.exposed.requestLeave(), true)
  } finally {
    view.dispose()
  }
})

test('normalizing legacy scene parameters and selecting scenes does not create a false draft', async () => {
  const view = fixture()
  try {
    await view.mount()
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    view.rack.selectScene('second')
    view.rack.selectNode('legacy-matrix')
    assert.equal(view.rack.selectedNode.value.params.layout, 'stereo')
    assert.equal(view.rack.selectedNode.value.params.matrix.length, 4)
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    assert.equal(await view.exposed.requestLeave(), true)
    view.rack.state.value.activeSceneId = 'second'
    view.rack.state.value.requiresPcmFallback = true
    assert.equal(
      view.rack.hasUnsavedChanges.value,
      false,
      'runtime state is outside the editable baseline'
    )
  } finally {
    view.dispose()
  }
})

test('nested graph and pin edits block leaving and importing until an explicit save or restore', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.rack.selectedScene.value.graph.nodes[0].enabled =
      !view.rack.selectedScene.value.graph.nodes[0].enabled
    assert.equal(view.rack.hasUnsavedChanges.value, true)
    assert.equal(await view.exposed.requestLeave(), false)
    assert.match(view.rack.message.value, /保存更改.*还原更改/)
    await view.rack.importProfile()
    assert.equal(view.calls.import, 0)
    assert.equal(view.calls.save, 0, 'guarding a switch never autosaves')
    await view.rack.saveScenes()
    assert.equal(view.calls.save, 1)
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    assert.equal(await view.exposed.requestLeave(), true)
    view.rack.togglePin()
    assert.equal(view.rack.hasUnsavedChanges.value, true)
    assert.equal(await view.exposed.requestLeave(), false)
  } finally {
    view.dispose()
  }
})

test('a pending or rejected save cannot discard the draft; a successful retry refreshes its baseline', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.rack.selectedScene.value.name = 'Keep this draft'
    const save = view.api.setDspScenes
    const gate = deferred()
    view.api.setDspScenes = () => gate.promise
    const pending = view.rack.saveScenes()
    assert.equal(await view.exposed.requestLeave(), false)
    assert.match(view.rack.message.value, /正在处理/)
    gate.resolve(Promise.reject(new Error('engine rejected draft')))
    await pending
    assert.equal(view.rack.hasUnsavedChanges.value, true)
    assert.equal(view.rack.selectedScene.value.name, 'Keep this draft')
    assert.match(view.rack.message.value, /engine rejected draft/)
    assert.equal(await view.exposed.requestLeave(), false)
    view.api.setDspScenes = save
    view.api.getDspGraphStatus = async () => {
      throw new Error('diagnostics offline')
    }
    await view.rack.saveScenes()
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    assert.match(view.rack.message.value, /已保存/)
    assert.equal(await view.exposed.requestLeave(), true)
  } finally {
    view.dispose()
  }
})

test('restore reads the latest engine configuration and preserves the draft when that read fails', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.rack.toggleSnapshot()
    view.rack.selectedScene.value.name = 'Unsaved local draft'
    const read = view.api.getDspSceneState
    view.api.getDspSceneState = async () => {
      throw new Error('engine offline')
    }
    await view.rack.restoreChanges()
    assert.equal(view.rack.selectedScene.value.name, 'Unsaved local draft')
    assert.equal(view.rack.hasUnsavedChanges.value, true)
    assert.equal(await view.exposed.requestLeave(), false)
    const latest = sceneState()
    latest.scenes[0].name = 'Latest EQ workspace state'
    latest.scenes[0].graph.nodes.push({
      id: 'new-eq',
      type: 'equalizer',
      enabled: true,
      params: { preampDb: -4, bands: [] }
    })
    view.replaceEngine(latest)
    const gate = deferred()
    view.api.getDspSceneState = () => gate.promise
    const restoring = view.rack.restoreChanges()
    assert.equal(await view.exposed.requestLeave(), false)
    gate.resolve(await read())
    await restoring
    assert.equal(view.rack.selectedScene.value.name, 'Latest EQ workspace state')
    assert.equal(view.rack.selectedScene.value.graph.nodes.at(-1).params.preampDb, -4)
    assert.equal(view.rack.snapshotA.value, null)
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    assert.equal(await view.exposed.requestLeave(), true)
    assert.equal(view.calls.save, 0, 'restore never persists the discarded local draft')
  } finally {
    view.dispose()
  }
})

test('applying the selected draft records the returned canonical state even when DSD PCM is declined', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.rack.selectScene('second')
    view.rack.selectedScene.value.name = 'Second scene draft'
    const save = view.api.setDspScenes
    view.api.setDspScenes = async (...args) => ({
      ...(await save(...args)),
      requiresPcmFallback: true,
      dsdPcmFallbackApplied: false
    })
    await view.rack.applySelectedScene()
    assert.equal(view.rack.state.value.pinnedSceneId, 'second')
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    assert.equal(view.calls.apply, 0)
    assert.equal(await view.exposed.requestLeave(), true)
    assert.match(view.rack.message.value, /未应用/)
  } finally {
    view.dispose()
  }
})

test('engine refresh preserves scene and node selection after a master DSP change and refuses dirty replacement', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.rack.selectScene('second')
    view.rack.selectNode('legacy-matrix')
    const latest = sceneState()
    latest.scenes[1].name = 'Engine master DSP changed'
    view.replaceEngine(latest)
    await view.exposed.refreshFromEngine()
    assert.equal(view.rack.selectedSceneId.value, 'second')
    assert.equal(view.rack.selectedNodeId.value, 'legacy-matrix')
    assert.equal(view.rack.selectedScene.value.name, 'Engine master DSP changed')
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    view.rack.selectedScene.value.name = 'Unsaved local name'
    const reads = view.calls.read
    await view.exposed.refreshFromEngine()
    assert.equal(view.calls.read, reads, 'a dirty refresh never fetches a replacement state')
    assert.equal(view.rack.selectedScene.value.name, 'Unsaved local name')
    assert.match(view.rack.message.value, /保存更改.*还原更改/)
  } finally {
    view.dispose()
  }
})

test('a newly mounted effects workspace reads EQ changes saved while its tab was unmounted', async () => {
  const view = fixture()
  try {
    const latest = sceneState()
    latest.scenes[0].graph.nodes.push({
      id: 'eq-from-other-tab',
      type: 'equalizer',
      enabled: true,
      params: { preampDb: -7, bands: [] }
    })
    view.replaceEngine(latest)
    await view.mount()
    assert.equal(view.rack.selectedScene.value.graph.nodes.at(-1).params.preampDb, -7)
    assert.equal(view.rack.hasUnsavedChanges.value, false)
    assert.equal(await view.exposed.requestLeave(), true)
  } finally {
    view.dispose()
  }
})

test('native asset import blocks workspace departure until the resulting node draft can be reviewed', async () => {
  const view = fixture()
  try {
    await view.mount()
    view.rack.selectedScene.value.graph.nodes.push({
      id: 'ir',
      type: 'convolver',
      enabled: true,
      params: {}
    })
    view.rack.selectNode('ir')
    await view.rack.saveScenes()
    const gate = deferred()
    view.api.importDspAsset = () => gate.promise
    const importing = view.rack.importAsset('impulseResponse')
    assert.equal(await view.exposed.requestLeave(), false)
    gate.resolve({ id: 'new-ir' })
    await importing
    assert.equal(view.rack.selectedNode.value.params.impulseResponseAssetId, 'new-ir')
    assert.equal(view.rack.hasUnsavedChanges.value, true)
    assert.equal(await view.exposed.requestLeave(), false)
  } finally {
    view.dispose()
  }
})

test('the embedded page template and scoped styles compile and retain public equalizer theme hooks', () => {
  const template = compileTemplate({
    source: parsed.descriptor.template.content,
    filename,
    id: 'rack-draft'
  })
  assert.deepEqual(template.errors, [])
  const style = compileStyle({
    source: parsed.descriptor.styles[0].content,
    filename,
    id: 'rack-draft',
    scoped: true
  })
  assert.deepEqual(style.errors, [])
  assert.match(style.code, /\.dsp-rack-page\.embedded/)
  for (const hook of ['panel', 'button', 'slider'])
    assert.ok(style.code.includes(`data-te-equalizer-${hook}`))
})
