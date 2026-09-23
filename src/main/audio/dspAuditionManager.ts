import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { normalizeLocalPath } from '../security/ipcValidation.ts'
import {
  compensatedAuditionGraph,
  matchAuditionLoudness,
  normalizeAuditionGraph,
  DSP_AUDITION_TOLERANCE_LU,
  DSP_AUDITION_CEILING_DB,
  type DspAuditionRequest,
  type DspAuditionResult,
  type DspAuditionMeasurement
} from '../../shared/dspAudition.ts'
import type { DspGraphConfig } from '../../shared/dspGraph.ts'
import type { AudioEngineManager } from '../audioEngineManager.ts'

type Context = Awaited<ReturnType<AudioEngineManager['getAuditionContext']>>
interface Dependencies {
  context: () => Promise<Context>
  apply: (revision: number, key: string | null, graph?: DspGraphConfig) => Promise<number>
  authorize: (source: string) => Promise<string>
  analyze: (source: string, options: string) => Promise<DspAuditionMeasurement>
  cancel: (source: string) => void
  identify?: (source: string) => Promise<string>
}

export class DspAuditionManager {
  private generation = 0
  private source = ''
  private session: {
    request: DspAuditionRequest
    result: DspAuditionResult
    key: string
    revision: number
    fingerprint: string
    original: DspGraphConfig
    changed: boolean
  } | null = null
  private pending = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly dependencies: Dependencies

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
  }

  private identify(source: string): Promise<string> {
    if (this.dependencies.identify) return this.dependencies.identify(source)
    return stat(source).then((value) => {
      if (!value.isFile()) throw new Error('试听源不是本地文件')
      return JSON.stringify([source, value.size, value.mtimeMs])
    })
  }

  async measure(input: DspAuditionRequest): Promise<DspAuditionResult> {
    await this.end()
    const generation = ++this.generation
    const request = structuredClone(input)
    request.source = await this.dependencies.authorize(
      normalizeLocalPath(request.source, '试听音源')
    )
    request.a = normalizeAuditionGraph(request.a)
    request.b = normalizeAuditionGraph(request.b)
    if (
      !Number.isFinite(request.startSeconds) ||
      !Number.isFinite(request.endSeconds) ||
      request.startSeconds < 0 ||
      request.startSeconds > 600 ||
      request.endSeconds - request.startSeconds < 10 ||
      request.endSeconds - request.startSeconds > 60
    )
      throw new Error('请选择 10–60 秒区间，起点不晚于 10 分钟')
    const context = await this.dependencies.context()
    const info = context.info
    if (
      info.source !== request.source ||
      !info.nativePlaybackActive ||
      info.isDsd ||
      !context.applied ||
      info.state === 'stopped' ||
      info.decodedChannels > 2 ||
      info.sourceSampleRate !== info.actualSampleRate ||
      (info.playbackRate ?? 1) !== 1 ||
      info.crossfadeActive
    )
      throw new Error('请先播放同采样率的本地单/双声道 PCM；DSD、重采样、变速和交叉淡化不支持匹配')
    const original = normalizeAuditionGraph(context.graph)
    const fingerprint = await this.identify(request.source)
    this.source = request.source
    const check = async () => {
      const current = await this.dependencies.context()
      if (
        generation !== this.generation ||
        current.key !== context.key ||
        current.revision !== context.revision ||
        fingerprint !== (await this.identify(request.source))
      )
        throw new Error('测量已取消，或音源/配置已改变')
    }
    const analyze = (graph: DspGraphConfig) =>
      this.dependencies.analyze(
        request.source,
        JSON.stringify({
          startSeconds: request.startSeconds,
          endSeconds: request.endSeconds,
          processedGraph: graph
        })
      )
    await check()
    const a = await analyze(request.a)
    await check()
    const b = await analyze(request.b)
    await check()
    const matching = matchAuditionLoudness(a, b)
    const verifiedA = await analyze(compensatedAuditionGraph(request.a, matching.gainA))
    await check()
    const verifiedB = await analyze(compensatedAuditionGraph(request.b, matching.gainB))
    await check()
    if (
      Math.abs(verifiedA.integratedLufs - verifiedB.integratedLufs) > DSP_AUDITION_TOLERANCE_LU ||
      Math.max(verifiedA.truePeakDb, verifiedB.truePeakDb) > DSP_AUDITION_CEILING_DB + 0.01
    )
      throw new Error('补偿后的复测未满足 0.1 LU / −1 dBTP 目标，请换用稳定的非静音区间')
    const result: DspAuditionResult = { id: randomUUID(), a, b, ...matching, selected: null }
    this.session = {
      request,
      result,
      key: context.key,
      revision: context.revision,
      fingerprint,
      original,
      changed: false
    }
    this.timer = setInterval(() => {
      void this.pending
        .then(() => this.checkCurrent())
        .catch(() => this.end().catch(() => undefined))
    }, 500)
    this.timer.unref?.()
    return structuredClone(result)
  }

  private async checkCurrent() {
    const session = this.session
    if (!session) throw new Error('试听会话已结束')
    const context = await this.dependencies.context()
    if (
      !context.applied ||
      context.key !== session.key ||
      context.revision !== session.revision ||
      session.fingerprint !== (await this.identify(session.request.source))
    )
      throw new Error('音源、设备或配置已改变，请重新测量')
    return session
  }

  select(id: string, side: 'a' | 'b'): Promise<DspAuditionResult> {
    const generation = this.generation
    const task = this.pending.then(async () => {
      const session = await this.checkCurrent()
      if (generation !== this.generation || session.result.id !== id || !['a', 'b'].includes(side))
        throw new Error('试听选择已过期')
      const graph = compensatedAuditionGraph(
        session.request[side],
        side === 'a' ? session.result.gainA : session.result.gainB
      )
      session.revision = await this.dependencies.apply(session.revision, session.key, graph)
      session.changed = true
      if (generation !== this.generation) throw new Error('试听已结束')
      session.result.selected = side
      return structuredClone(session.result)
    })
    this.pending = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  async end(): Promise<void> {
    ++this.generation
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.source) this.dependencies.cancel(this.source)
    this.source = ''
    await this.pending
    const session = this.session
    this.session = null
    if (!session?.changed) return
    const context = await this.dependencies.context()
    if (context.revision === session.revision) await this.dependencies.apply(session.revision, null)
  }

  async status(): Promise<DspAuditionResult | null> {
    await this.pending
    try {
      return structuredClone((await this.checkCurrent()).result)
    } catch {
      await this.end()
      return null
    }
  }
}
