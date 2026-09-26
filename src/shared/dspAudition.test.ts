import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compensatedAuditionGraph,
  matchAuditionLoudness,
  normalizeAuditionGraph
} from './dspAudition.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, type DspGraphConfig } from './dspGraph.ts'

test('matching only attenuates and respects the common true peak ceiling', () => {
  const result = matchAuditionLoudness(
    { integratedLufs: -14, truePeakDb: -0.2, processingVersion: 1 },
    { integratedLufs: -20, truePeakDb: -0.5, processingVersion: 1 }
  )
  assert.equal(result.targetLufs, -20.5)
  assert.equal(result.gainA, -6.5)
  assert.equal(result.gainB, -0.5)
  assert.throws(
    () =>
      matchAuditionLoudness(
        { integratedLufs: -14, truePeakDb: -2, processingVersion: 0 },
        { integratedLufs: -20, truePeakDb: -2, processingVersion: 1 }
      ),
    /处理后/
  )
})

test('audition rejects unsupported graphs and compensation never mutates the scene', () => {
  const graph: DspGraphConfig = {
    version: 2,
    nodes: [],
    outputStage: { ...DEFAULT_DSP_OUTPUT_STAGE }
  }
  const result = compensatedAuditionGraph(graph, -6)
  assert.equal(
    normalizeAuditionGraph({
      ...graph,
      nodes: [{ id: 'meter', type: 'meter', enabled: true, params: {} }]
    }).nodes.length,
    0
  )
  assert.equal(graph.nodes.length, 0)
  assert.equal(result.nodes[0].params.preampDb, -6)
  assert.throws(() => compensatedAuditionGraph(graph, -25), /补偿/)
  assert.throws(
    () =>
      normalizeAuditionGraph({
        ...graph,
        nodes: [{ id: 'x', type: 'compressor', enabled: true, params: {} }]
      }),
    /仅支持/
  )
  assert.throws(
    () =>
      normalizeAuditionGraph({ ...graph, outputStage: { ...graph.outputStage, dither: 'tpdf' } }),
    /抖动/
  )
})
