import assert from 'node:assert/strict'
import test from 'node:test'
import { DspOrchestrator, type DspOrchestratorHost } from './dspOrchestrator.ts'
import { createDefaultPlaybackInfo } from './audioEngineHelpers.ts'
import type { DspStatePayload } from '../../shared/audioServiceContract.ts'
import { compensatedAuditionGraph } from '../../shared/dspAudition.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, type DspGraphConfig } from '../../shared/dspGraph.ts'

test('temporary audition graphs use DSP revisions and leave saved processing and position untouched', async () => {
  const info = createDefaultPlaybackInfo('wasapi', 'auto', false, {
    routingMode: 'auto',
    preferredBufferSize: 0
  })
  info.position = 42
  const payloads: DspStatePayload[] = []
  let staleAck = false
  let continuity = false
  const host = {
    getPlaybackInfo: () => info,
    getDevice: () => 'auto',
    getOutput: () => 'wasapi',
    getOutputConfig: () => ({
      playbackPolicy: continuity ? 'continuity-first' : 'bit-perfect-first',
      continuitySampleRate: 96000
    }),
    getNative: () => ({}),
    setLastNativeError: () => undefined,
    getAudioServiceBinding: () => ({
      applyDspState: async (revision: number, payload: DspStatePayload) => {
        payloads.push(payload)
        return {
          revision: staleAck ? revision - 1 : revision,
          activeSceneId: null,
          totalLatencyFrames: 0,
          totalTailFrames: 0,
          nodes: [],
          compileState: 'ready'
        }
      }
    })
  } as unknown as DspOrchestratorHost
  const dsp = new DspOrchestrator(
    host,
    { audioProcessing: { dspEnabled: false, directMode: true } },
    {}
  )
  const before = structuredClone(dsp.processing)
  const scenes = structuredClone(dsp.dspScenes)
  const graph = compensatedAuditionGraph(
    { version: 2, nodes: [], outputStage: DEFAULT_DSP_OUTPUT_STAGE },
    -6
  )
  assert.equal((await dsp.applyNativeDspGraph('test audition', graph)).applyState, 'applied')
  assert.equal(payloads[0].processing.dspEnabled, true)
  assert.equal(payloads[0].processing.directMode, false)
  assert.equal((payloads[0].graph as DspGraphConfig).nodes[0].params.preampDb, -6)
  assert.equal(
    (payloads[0].graph as unknown as { auditionTransition: boolean }).auditionTransition,
    true
  )
  assert.deepEqual(dsp.processing, before)
  assert.deepEqual(dsp.dspScenes, scenes)
  assert.equal(info.position, 42)
  await dsp.applyNativeDspGraph('restore')
  assert.deepEqual((payloads[1].graph as DspGraphConfig).nodes, [])
  assert.equal(payloads[1].processing.dspEnabled, false)
  continuity = true
  await dsp.applyNativeDspGraph('continuous output')
  assert.equal((payloads[2].graph as DspGraphConfig).outputStage.targetSampleRate, 96000)
  assert.deepEqual(dsp.dspScenes, scenes)
  continuity = false
  staleAck = true
  const status = await dsp.applyNativeDspGraph('stale ACK', graph)
  assert.equal(status.applyState, 'failed')
  assert.match(status.applyError ?? '', /ACK revision mismatch/)
})
