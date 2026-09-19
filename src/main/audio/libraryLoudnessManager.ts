import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  idleLoudnessBatchStatus,
  isLoudnessGroupMeasurement,
  LIBRARY_LOUDNESS_ALGORITHM_VERSION,
  type LibraryLoudnessResult,
  type LoudnessBatchItem,
  type LoudnessBatchProgress,
  type LoudnessBatchSnapshot,
  type LoudnessGroupMeasurement,
  type LoudnessInputGroup
} from '../../shared/libraryLoudness.ts'
import { loudnessDigest, type LibraryLoudnessCache } from './libraryLoudnessCache.ts'

interface LibraryLoudnessManagerOptions {
  cache: Pick<LibraryLoudnessCache, 'get' | 'set' | 'clear'>
  authorizePath: (path: string) => Promise<string>
  analyze: (group: LoudnessInputGroup) => Promise<LoudnessGroupMeasurement>
  cancelWork: () => void
  onProgress?: (progress: LoudnessBatchProgress) => void
}

export class LibraryLoudnessManager {
  private readonly options: LibraryLoudnessManagerOptions
  private status = idleLoudnessBatchStatus()
  private items: LoudnessBatchItem[] = []
  private task: Promise<void> | null = null

  constructor(options: LibraryLoudnessManagerOptions) {
    this.options = options
  }

  snapshot(): LoudnessBatchSnapshot {
    return { status: { ...this.status }, items: this.items.map((item) => ({ ...item })) }
  }

  start(groups: LoudnessInputGroup[]): LoudnessBatchSnapshot {
    if (this.active()) throw new Error('已有响度分析任务，请等待完成或先取消')
    this.status = {
      ...idleLoudnessBatchStatus(),
      revision: this.status.revision,
      jobId: randomUUID(),
      state: 'running',
      total: groups.length
    }
    this.items = groups.map((group) => ({
      id: group.id,
      title: group.title,
      trackCount: group.tracks.length,
      state: 'queued'
    }))
    this.publish()
    this.task = this.run(groups)
    return this.snapshot()
  }

  async cancel(jobId = this.status.jobId): Promise<void> {
    if (jobId !== this.status.jobId || !this.active()) return
    this.status.state = 'cancelling'
    this.publish()
    this.options.cancelWork()
    await this.task
  }

  async results(groups: LoudnessInputGroup[]): Promise<LibraryLoudnessResult[]> {
    const results: LibraryLoudnessResult[] = []
    for (const group of groups) {
      try {
        const { fingerprint } = await this.identify(group)
        const measured = this.options.cache.get(group.id, fingerprint)
        results.push(
          measured
            ? {
                id: group.id,
                status: 'measured',
                measurement: group.mode === 'album' ? measured.album! : measured.tracks[0],
                tracks: measured.tracks
              }
            : { id: group.id, status: 'missing' }
        )
      } catch (error) {
        results.push({ id: group.id, status: 'unavailable', reason: message(error) })
      }
    }
    return results
  }

  clear(ids: string[]): void {
    if (this.active()) throw new Error('请先完成或取消当前分析，再清理结果')
    this.options.cache.clear(ids)
  }

  private active(): boolean {
    return this.status.state === 'running' || this.status.state === 'cancelling'
  }

  private async run(groups: LoudnessInputGroup[]): Promise<void> {
    for (let index = 0; index < groups.length && this.status.state === 'running'; index++) {
      const group = groups[index]
      const item = this.items[index]
      item.state = 'analyzing'
      this.status.currentTitle = item.title
      this.publish(item)
      try {
        const before = await this.identify(group)
        if (this.status.state !== 'running') break
        const cached = this.options.cache.get(group.id, before.fingerprint)
        if (cached) item.state = 'cached'
        else {
          const measurement = await this.options.analyze(before.group)
          if (this.status.state !== 'running') break
          if (
            !isLoudnessGroupMeasurement(measurement) ||
            measurement.tracks.length !== group.tracks.length ||
            (group.mode === 'album' && !measurement.album)
          )
            throw new Error('专辑或曲目测量不完整')
          const after = await this.identify(group)
          if (this.status.state !== 'running') break
          if (before.fingerprint !== after.fingerprint)
            throw new Error('分析期间源文件已变化，请重新分析')
          this.options.cache.set(group.id, before.fingerprint, measurement)
          item.state = 'completed'
        }
      } catch (error) {
        if (this.status.state !== 'running') break
        item.state = 'failed'
        item.reason = message(error)
        this.status.failed++
      }
      this.status.processed++
      this.publish(item)
    }
    if (this.status.state === 'cancelling') {
      for (const item of this.items) {
        if (item.state === 'queued' || item.state === 'analyzing') item.state = 'cancelled'
      }
      this.status.state = 'cancelled'
    } else this.status.state = 'completed'
    this.status.currentTitle = ''
    this.publish()
  }

  private async identify(group: LoudnessInputGroup): Promise<{
    group: LoudnessInputGroup
    fingerprint: string
  }> {
    const identities: unknown[] = []
    const tracks: LoudnessInputGroup['tracks'] = []
    for (const track of group.tracks) {
      if (track.subTrack && !track.cueRange) throw new Error('此容器子曲目尚不支持独立响度分析')
      const filePath = await this.options.authorizePath(track.filePath)
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('音频文件不可用')
      tracks.push({ ...track, filePath })
      identities.push([
        track.id,
        filePath,
        info.size,
        info.mtimeMs,
        track.cueRange?.startSeconds ?? 0,
        track.cueRange?.endSeconds ?? 0
      ])
    }
    return {
      group: { ...group, tracks },
      fingerprint: loudnessDigest(
        JSON.stringify([LIBRARY_LOUDNESS_ALGORITHM_VERSION, group.mode, identities])
      )
    }
  }

  private publish(item?: LoudnessBatchItem): void {
    this.status.revision++
    this.options.onProgress?.({
      status: { ...this.status },
      ...(item ? { item: { ...item } } : {})
    })
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024)
}
