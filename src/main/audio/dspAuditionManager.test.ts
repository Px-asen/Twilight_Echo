import test from 'node:test'
import assert from 'node:assert/strict'
import { DspAuditionManager } from './dspAuditionManager.ts'
import { createDspAuditionHandlers } from './dspAuditionIpc.ts'
import { DEFAULT_DSP_OUTPUT_STAGE, type DspGraphConfig } from '../../shared/dspGraph.ts'
import type { AudioEngineManager } from '../audioEngineManager.ts'

const graph: DspGraphConfig = {
  version: 2,
  nodes: [],
  outputStage: { ...DEFAULT_DSP_OUTPUT_STAGE }
}
const source = process.platform === 'win32' ? 'C:\\music\\song.wav' : '/music/song.wav'
const request = { source, startSeconds: 0, endSeconds: 12, a: graph, b: graph }
function fixture() {
  let revision = 1
  let key = 'source/device'
  let fingerprint = 'original'
  const applied: Array<DspGraphConfig | undefined> = []
  const measured: string[] = []
  const context = async () =>
    ({
      revision,
      key,
      applied: true,
      graph,
      info: {
        source,
        nativePlaybackActive: true,
        isDsd: false,
        state: 'playing',
        decodedChannels: 2,
        actualChannels: 2,
        actualOutputFormat: 'float32',
        sourceSampleRate: 48000,
        actualSampleRate: 48000,
        playbackRate: 1,
        position: 7
      }
    }) as Awaited<ReturnType<AudioEngineManager['getAuditionContext']>>
  let waitAnalysis: (() => Promise<void>) | null = null
  let waitApply: (() => Promise<void>) | null = null
  const manager = new DspAuditionManager({
    context,
    authorize: async (value) => value,
    identify: async () => fingerprint,
    cancel: () => undefined,
    analyze: async (_source, options) => {
      measured.push(options)
      await waitAnalysis?.()
      return { integratedLufs: -20, truePeakDb: -10, processingVersion: 1 }
    },
    apply: async (expected, _key, value) => {
      assert.equal(expected, revision)
      applied.push(value)
      await waitApply?.()
      return ++revision
    }
  })
  return {
    manager,
    applied,
    measured,
    waitApply: (fn: () => Promise<void>) => {
      waitApply = fn
    },
    change: () => {
      revision++
      key = 'changed'
    },
    changeFile: () => {
      fingerprint = 'edited'
    },
    wait: (fn: () => Promise<void>) => {
      waitAnalysis = fn
    }
  }
}

test('processed measurements are frozen, switching waits for ACK, exit restores without persisting scenes', async () => {
  const f = fixture()
  const result = await f.manager.measure(request)
  assert.equal(f.measured.length, 4)
  assert.ok(f.measured.every((value) => JSON.parse(value).processedGraph))
  const selected = await f.manager.select(result.id, 'b')
  assert.equal(selected.selected, 'b')
  assert.equal(f.applied.length, 1)
  await f.manager.end()
  assert.equal(f.applied.length, 2)
  assert.equal(f.applied[1], undefined)
  assert.equal(graph.nodes.length, 0)
})

test('exit waits for a late DSP ACK and a new measurement cannot overtake restoration', async () => {
  const f = fixture()
  const result = await f.manager.measure(request)
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.waitApply(async () => {
    entered()
    await blocked
  })
  const selecting = f.manager.select(result.id, 'a')
  await started
  const rejected = assert.rejects(selecting, /结束/)
  const ending = f.manager.end()
  const next = f.manager.measure(request)
  assert.equal(f.measured.length, 4)
  release()
  await rejected
  await ending
  const nextResult = await next
  assert.notEqual(nextResult.id, result.id)
  assert.deepEqual(
    f.applied.map((value) => !!value),
    [true, false]
  )
  await f.manager.end()
})

test('simultaneous measurements keep only the newest request and reject short intervals', async () => {
  const f = fixture()
  const first = f.manager.measure(request)
  const second = f.manager.measure(request)
  await assert.rejects(first, /取消/)
  await second
  assert.equal(f.measured.length, 4)
  await assert.rejects(f.manager.measure({ ...request, endSeconds: 3 }), /10–60/)
  await f.manager.end()
})

test('external revisions and changed sources invalidate selection without restoring over newer configuration', async () => {
  const f = fixture()
  const result = await f.manager.measure(request)
  await f.manager.select(result.id, 'a')
  f.change()
  await assert.rejects(f.manager.select(result.id, 'b'), /改变/)
  await f.manager.end()
  assert.equal(f.applied.length, 1)
  const g = fixture()
  const next = await g.manager.measure(request)
  g.changeFile()
  await assert.rejects(g.manager.select(next.id, 'a'), /改变/)
  await g.manager.end()
})

test('cancel fences late analysis and IPC checks sender before analysis', async () => {
  const f = fixture()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const block = new Promise<void>((resolve) => {
    release = resolve
  })
  f.wait(async () => {
    entered()
    await block
  })
  const task = f.manager.measure(request)
  await started
  await f.manager.end()
  release()
  await assert.rejects(task, /取消/)
  assert.equal(f.applied.length, 0)
  const ipc = createDspAuditionHandlers(f.manager, () => {
    throw new Error('untrusted sender')
  })
  await assert.rejects(ipc.measure({}, request), /untrusted/)
  await assert.rejects(ipc.end({}), /untrusted/)
})
