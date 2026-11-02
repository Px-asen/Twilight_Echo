import type {
  DuplicateCandidate,
  DuplicateDetectionResult
} from '../../shared/duplicateDetection.ts'
import type {
  CoreDuplicatesStatus,
  CoreDuplicateGroup,
  CoreDuplicateItem,
  CoreDuplicatePage,
  CoreDuplicatePageQuery
} from '../../shared/coreDuplicates.ts'
import { detectDuplicates } from './duplicateDetection.ts'
import { projectCoreError } from '../projections.ts'

interface Options {
  readCandidates(
    after: number,
    limit: number,
    revision?: number
  ): Promise<{
    revision: number
    items: DuplicateCandidate[]
    nextCursor: number | null
  }>
  authorizeFile(path: string, signal: AbortSignal): Promise<string>
  hashContent(path: string, signal: AbortSignal): Promise<string>
  pathKey(path: string): string
  fileName(path: string): string
  yieldControl(): Promise<void>
  newId(): string
  changed(): void
  resultIdleTtlMs?: number
}

const DEFAULT_DUPLICATES_IDLE_TTL_MS = 2 * 60_000

/** One read-only inspection, owned by Core rather than the initiating window.
 * Evidence stays private; clients read bounded groups and group members. */
export class CoreDuplicatesService {
  private readonly options: Options
  private status: CoreDuplicatesStatus | null = null
  private result: DuplicateDetectionResult | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private work: Promise<void> | null = null
  private controller: AbortController | null = null
  private stopped = false
  constructor(options: Options) {
    this.options = options
  }
  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
  private scheduleIdleRelease(): void {
    this.clearIdleTimer()
    const ttl = this.options.resultIdleTtlMs ?? DEFAULT_DUPLICATES_IDLE_TTL_MS
    if (ttl <= 0 || this.stopped || !this.result) return
    const timer = setTimeout(() => {
      this.idleTimer = null
      if (this.work || !this.result) return
      this.result = null
    }, ttl)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.idleTimer = timer
  }
  snapshot(): CoreDuplicatesStatus | null {
    return this.status ? { ...this.status } : null
  }
  start(): CoreDuplicatesStatus {
    if (this.stopped) throw new Error('Duplicate inspection is shutting down')
    if (this.work) return this.snapshot()!
    const controller = (this.controller = new AbortController())
    this.clearIdleTimer()
    this.result = null
    this.status = {
      id: this.options.newId(),
      revision: null,
      state: 'loading',
      candidates: 0,
      groups: 0,
      unavailable: 0
    }
    this.work = this.inspect(controller.signal)
      .catch((error) => {
        this.status!.state = controller.signal.aborted ? 'cancelled' : 'failed'
        if (!controller.signal.aborted) this.status!.error = projectCoreError(error)
      })
      .finally(() => {
        this.work = null
        this.controller = null
        this.options.changed()
      })
    this.options.changed()
    return this.snapshot()!
  }
  private async inspect(signal: AbortSignal): Promise<void> {
    const candidates: DuplicateCandidate[] = []
    const ids = new Set<string>()
    let cursor: number | null = 0
    do {
      signal.throwIfAborted()
      const page = await this.options.readCandidates(
        cursor,
        200,
        this.status!.revision ?? undefined
      )
      signal.throwIfAborted()
      this.status!.revision = page.revision
      for (const item of page.items) {
        if (!item.id || !item.filePath || ids.has(item.id)) continue
        ids.add(item.id)
        candidates.push(item)
      }
      this.status!.candidates = candidates.length
      cursor = page.nextCursor
    } while (cursor !== null)
    this.status!.state = 'inspecting'
    this.options.changed()
    const result = await detectDuplicates(candidates, {
      pathKey: this.options.pathKey,
      signal,
      yieldControl: this.options.yieldControl,
      // Hashes are only needed for equal-size candidates. IO and crypto run in
      // the existing low-priority analysis pool, never the playback RPC lane.
      contentHashForPath: async (path) => {
        const authorized = await this.options.authorizeFile(path, signal)
        signal.throwIfAborted()
        return this.options.hashContent(authorized, signal)
      }
    })
    signal.throwIfAborted()
    this.result = result
    this.status!.state = 'completed'
    this.status!.groups = result.groups.length
    this.status!.unavailable = result.contentHashUnavailableIds.length
    this.scheduleIdleRelease()
  }
  async cancel(id: string): Promise<CoreDuplicatesStatus> {
    this.assertId(id)
    this.controller?.abort(new Error('Duplicate inspection cancelled'))
    await this.work
    return this.snapshot()!
  }
  groups(query: CoreDuplicatePageQuery): CoreDuplicatePage<CoreDuplicateGroup> {
    const result = this.completed(query.id)
    const page = this.page(query, result.groups)
    return {
      ...page,
      items: page.items.map((group, i) => ({
        index: page.offset + i,
        kind: group.kind,
        confidence: group.confidence,
        total: group.items.length,
        action: group.confidence === 'exact' ? 'mergeSuggestion' : 'mark'
      }))
    }
  }
  items(query: CoreDuplicatePageQuery & { group: number }): CoreDuplicatePage<CoreDuplicateItem> {
    const group = this.completed(query.id).groups[query.group]
    if (!group) throw new Error('Duplicate group not found')
    const page = this.page(query, group.items)
    return {
      ...page,
      items: page.items.map((item) => {
        const { filePath, contentHash: _hash, audioFingerprint: _fingerprint, ...publicItem } = item
        return { ...publicItem, fileName: this.options.fileName(filePath) }
      })
    }
  }
  unavailable(query: CoreDuplicatePageQuery): CoreDuplicatePage<string> {
    return this.page(query, this.completed(query.id).contentHashUnavailableIds)
  }
  /** Private evidence for Core's inbox, never part of a client snapshot. */
  evidence(id: string): { revision: number; result: DuplicateDetectionResult } {
    const result = this.completed(id)
    return { revision: this.status!.revision!, result }
  }
  private page<T>(query: CoreDuplicatePageQuery, items: T[]): CoreDuplicatePage<T> {
    const offset = query.offset ?? 0,
      limit = query.limit ?? 200
    return {
      id: query.id,
      revision: this.status!.revision!,
      offset,
      total: items.length,
      items: items.slice(offset, offset + limit)
    }
  }
  private assertId(id: string): void {
    if (id !== this.status?.id)
      throw Object.assign(new Error('Duplicate inspection changed'), { code: 'STALE_REVISION' })
  }
  private completed(id: string): DuplicateDetectionResult {
    this.assertId(id)
    if (!this.result) throw new Error('Duplicate inspection is not complete')
    this.scheduleIdleRelease()
    return this.result
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    this.clearIdleTimer()
    this.result = null
    this.controller?.abort(new Error('Core shutting down'))
    await this.work
  }
}
