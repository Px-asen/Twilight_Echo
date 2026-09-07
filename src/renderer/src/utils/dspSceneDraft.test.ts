import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import { createDspFactoryScene, type DspSceneState } from '../../../shared/dspGraph.ts'
import { cloneDspScene, submitDspSceneDraft } from './dspSceneDraft.ts'

function draft() {
  const scene = createDspFactoryScene('transparent', 'draft')
  scene.rules.deviceIds = ['speakers']
  scene.graph.nodes.push({
    id: 'effect',
    type: 'vst3Plugin',
    enabled: true,
    vst3: { catalogId: 'plugin', classId: 'class', stateAssetId: 'preset' },
    params: { parameters: { '7': 0.75 } }
  })
  return reactive([scene])
}

test('saving reactive DSP drafts submits cloneable VST3 parameters and state references', async () => {
  const scenes = draft()
  assert.throws(() => structuredClone(scenes), { name: 'DataCloneError' })
  const saved = { scenes: [] } as unknown as DspSceneState
  const result = await submitDspSceneDraft(
    {
      async setDspScenes(payload, pin) {
        assert.equal(pin, 'draft')
        saved.scenes = structuredClone(payload)
        return saved
      }
    },
    scenes,
    'draft'
  )
  assert.equal(result, saved)
  assert.deepEqual(saved.scenes, JSON.parse(JSON.stringify(scenes)))
  scenes[0].graph.nodes.at(-1)!.params.parameters = { '7': 0.1 }
  assert.deepEqual(saved.scenes[0].graph.nodes.at(-1)!.params.parameters, { '7': 0.75 })
})

test('applying a draft submits its parameters and selected scene in one transaction', async () => {
  const scenes = draft()
  const calls: string[] = []
  const applied = { scenes } as DspSceneState
  let finishSave!: (state: DspSceneState) => void
  const pending = submitDspSceneDraft(
    {
      setDspScenes(payload, pin) {
        assert.equal(pin, 'draft')
        assert.deepEqual(structuredClone(payload), JSON.parse(JSON.stringify(scenes)))
        calls.push('save')
        return new Promise((resolve) => {
          finishSave = resolve
        })
      }
    },
    scenes,
    null,
    'draft'
  )
  assert.deepEqual(calls, ['save'])
  finishSave(applied)
  assert.equal(await pending, applied)
  assert.deepEqual(calls, ['save'])
})

test('failed persistence does not apply stale parameters or discard the draft', async () => {
  const scenes = draft()
  await assert.rejects(
    submitDspSceneDraft(
      {
        async setDspScenes() {
          throw new Error('save failed')
        }
      },
      scenes,
      null,
      'draft'
    ),
    /save failed/
  )
  assert.deepEqual(scenes[0].graph.nodes.at(-1)!.params.parameters, { '7': 0.75 })
})

test('applying a DSD draft returns the PCM confirmation requirement without a second submit', async () => {
  const state = { requiresPcmFallback: true, dsdPcmFallbackApplied: false } as DspSceneState
  let calls = 0
  const result = await submitDspSceneDraft(
    {
      async setDspScenes(_scenes, pin) {
        calls += 1
        assert.equal(pin, 'draft')
        return state
      }
    },
    draft(),
    'another-scene',
    'draft'
  )
  assert.equal(calls, 1)
  assert.equal(result.requiresPcmFallback, true)
  assert.equal(result.dsdPcmFallbackApplied, false)
})

test('scene copies and A snapshots isolate nested rules and VST3 state', () => {
  const scene = draft()[0]
  const snapshot = cloneDspScene(scene, 'copy', 'Copy')
  scene.rules.deviceIds!.push('headphones')
  scene.graph.nodes.at(-1)!.vst3!.stateAssetId = 'replacement'
  scene.graph.nodes.at(-1)!.params.parameters = { '7': 0.1 }
  assert.equal(snapshot.id, 'copy')
  assert.equal(snapshot.name, 'Copy')
  assert.deepEqual(snapshot.rules.deviceIds, ['speakers'])
  assert.equal(snapshot.graph.nodes.at(-1)!.vst3!.stateAssetId, 'preset')
  assert.deepEqual(snapshot.graph.nodes.at(-1)!.params.parameters, { '7': 0.75 })
  assert.deepEqual(structuredClone(snapshot), snapshot)
})
