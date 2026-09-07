import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import type { DspGraphNode } from '../../../shared/dspGraph.ts'
import { setVst3Parameter, vst3ParameterValue } from './vst3Parameters.ts'

test('VST3 edits preserve the parameter table and unrelated values', () => {
  const node = reactive<DspGraphNode>({
    id: 'effect',
    type: 'vst3Plugin',
    enabled: true,
    params: { parameters: Object.fromEntries(Array.from({ length: 2048 }, (_, id) => [id, 0.25])) }
  })
  const parameters = node.params.parameters
  setVst3Parameter(node, 7, '0.85')
  assert.equal(node.params.parameters, parameters)
  assert.equal(vst3ParameterValue(node, 7, 0), 0.85)
  assert.equal(vst3ParameterValue(node, 2047, 0), 0.25)
  setVst3Parameter(node, 7, 'invalid')
  assert.equal(vst3ParameterValue(node, 7, 0), 0.85)
  setVst3Parameter(node, 7, 2)
  assert.equal(vst3ParameterValue(node, 7, 0), 1)
})

test('VST3 edits initialize a missing parameter table without discarding the node settings', () => {
  const node: DspGraphNode = {
    id: 'effect',
    type: 'vst3Plugin',
    enabled: true,
    params: { catalogId: 'module' }
  }
  setVst3Parameter(node, 0, -1)
  assert.deepEqual(node.params, { catalogId: 'module', parameters: { '0': 0 } })
})
