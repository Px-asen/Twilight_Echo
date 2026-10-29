import type { PlayMode, AudioEngineQueueItem } from '../../shared/audioEngineTypes.ts'
import type { LibraryQueuePlaybackWindow } from '../../shared/libraryDatabase.ts'
import type { SourceResolver, ResolvedSource } from './sourceResolver.ts'
import { authorizeNativeSource, isSourceCurrent } from './sourceResolver.ts'
import { nativeQueueItem } from './nativeQueueMaintainer.ts'
import type { PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import type { TrackData } from '../../shared/track.ts'
import type { PreparedPlaybackSource } from './sourceRecovery.ts'
import { libraryQueueTrack } from './libraryTrack.ts'
import type { SourceResources } from './sourceResources.ts'

const END_RECOVERY_BUDGET_MS = 30_000

export interface LibraryNativeQueueEngine {
  getPlaybackInfo(): Promise<PlaybackInfo>
  getQueueSnapshot(): readonly AudioEngineQueueItem[]
  getQueueToken(): string
  rebindQueue(
    request: import('../../shared/nativeQueue.ts').NativeQueueRebind
  ): Promise<import('../../shared/nativeQueue.ts').NativeQueueCommit | null>
  getPlaybackEnd(): {
    selection: import('../../shared/nativeQueue.ts').NativeQueueSelection
    intent: number
  } | null
  continueAfterPlaybackEnd(request: {
    expected: {
      selection: import('../../shared/nativeQueue.ts').NativeQueueSelection
      intent: number
    }
    item: AudioEngineQueueItem
    playMode: 'sequential' | 'repeat'
    isCurrent(): boolean
    onSelected(): void
  }): Promise<boolean>
}

export interface LibraryWindowPlan {
  window: LibraryQueuePlaybackWindow
  mode: PlayMode
}

export interface LibraryNativeQueueMaintainerOptions {
  engine: LibraryNativeQueueEngine
  resources?: SourceResources
  nativeQueueIndices: readonly number[]
  /** Synchronizes the actual occurrence before reading at most current + next. */
  readWindow: (
    index: number,
    entryId: string,
    isCurrent: () => boolean
  ) => Promise<LibraryWindowPlan | null>
  validateWindow: (plan: LibraryWindowPlan) => Promise<boolean>
  resolver: SourceResolver
  authorize: (source: string) => Promise<string>
  prepareSource?: (track: TrackData, signal: AbortSignal) => Promise<PreparedPlaybackSource>
  /** Runs only after native/SQL validation in the short commit lane. */
  commitSource?: (
    plan: LibraryWindowPlan,
    occurrenceId: string,
    prepared: PreparedPlaybackSource
  ) => Promise<void>
  onCommitError?: (error: unknown) => Promise<void>
  /** Only the short commit stage enters the shared transport lane. */
  commit: (operation: () => Promise<void>, isCurrent: () => boolean) => Promise<void>
  /** Reports acknowledged native mutations, including those drained by stop(). */
  onMappingChanged: (mapping: number[]) => void
  onPlaybackAdvanced: (
    info: PlaybackInfo,
    index: number,
    entryId: string,
    prepared?: TrackData
  ) => Promise<void>
  mayContinueAfterEnd?: () => boolean
  /** A heart recommendation may finish before the restored base queue starts. */
  allowDetachedCurrent?: () => boolean
  onError: (message: string) => void
  onHealthy?: () => void
  now?: () => number
}

/** SQL owns order and EOF policy. Native owns only current + successor.
 * Rebind preserves the open decoder. Only a guarded natural-end continuation
 * may open the SQL successor after a slow source missed native EOF.
 * Provider reads stay outside the transport lane and are cancelled by epoch.
 */
export class LibraryNativeQueueMaintainer {
  private readonly options: LibraryNativeQueueMaintainerOptions
  private mapping: number[]
  private active = false
  private generation = 0
  private pending: Promise<void> | null = null
  private requested = false
  private engineDrain: Promise<void> = Promise.resolve()
  // One successor cache and one retry slot, independent of traversal length.
  private source: { key: string; prepared: PreparedPlaybackSource; refreshAfter: number } | null =
    null
  private retry: { key: string; after: number } | null = null
  private rejected: string | null = null
  private hasEndTarget = false
  private endRecovery: { key: string; deadline: number } | null = null
  private sourceReads = new AbortController()

  constructor(options: LibraryNativeQueueMaintainerOptions) {
    this.options = options
    this.mapping = [...options.nativeQueueIndices]
  }

  getMapping(): number[] {
    return [...this.mapping]
  }
  isActive(): boolean {
    return this.active
  }

  getPlaybackEndRecoveryDeadline(): number | null {
    const end = this.options.engine.getPlaybackEnd()
    if (
      !this.active ||
      !this.hasEndTarget ||
      !end ||
      this.options.mayContinueAfterEnd?.() === false
    )
      return null
    const key = `${end.intent}:${end.selection.queueToken}:${end.selection.index}`
    if (this.endRecovery?.key !== key)
      this.endRecovery = {
        key,
        deadline: (this.options.now ?? Date.now)() + END_RECOVERY_BUDGET_MS
      }
    return this.endRecovery.deadline
  }

  start(): Promise<void> {
    if (!this.active) {
      this.active = true
      this.generation++
      this.sourceReads = new AbortController()
    }
    return this.tick()
  }

  stop(): Promise<void> {
    this.active = false
    this.generation++
    this.sourceReads.abort()
    this.pending = null
    this.requested = false
    return this.engineDrain
  }

  tick(): Promise<void> {
    if (!this.active) return Promise.resolve()
    this.requested = true
    if (this.pending) return this.pending
    const generation = this.generation
    const current = () => this.active && generation === this.generation
    const run = Promise.resolve().then(async () => {
      try {
        while (current() && this.requested) {
          this.requested = false
          const maintain = () => (current() ? this.maintain(current) : Promise.resolve())
          if (this.options.resources) await this.options.resources.use(maintain)
          else await maintain()
        }
      } catch (error) {
        if (current()) this.options.onError(error instanceof Error ? error.message : String(error))
      }
    })
    this.pending = run
    void run.finally(() => {
      if (this.pending === run) this.pending = null
    })
    return run
  }

  private async maintain(current: () => boolean): Promise<void> {
    const { engine } = this.options
    const info = await engine.getPlaybackInfo()
    if (!current()) return
    const token = engine.getQueueToken()
    const native = engine.getQueueSnapshot()
    const item = native[info.queueIndex]
    const index = this.mapping[info.queueIndex]
    if (
      !token ||
      !item?.queueEntryId ||
      native.length !== this.mapping.length ||
      !Number.isSafeInteger(index) ||
      (index < 0 && !(index === -1 && this.options.allowDetachedCurrent?.()))
    )
      throw new Error('afterglow_requires_mappable_current_track')
    if (info.state !== 'stopped' && info.source !== item.source)
      throw new Error('afterglow_requires_mappable_current_track')
    const plan = await this.options.readWindow(index, item.queueEntryId, current)
    if (!current() || !plan) return
    const { window, mode } = plan
    const lastPlayablePosition = window.lastPlayablePosition ?? window.queue.total - 1
    const row = window.items[0]
    if (
      window.queue.index !== index ||
      window.queue.selectedEntryId !== item.queueEntryId ||
      row?.position !== index ||
      row.queueEntryId !== item.queueEntryId ||
      (row.track && row.track.id !== item.id)
    )
      throw new Error('afterglow_library_queue_changed')
    if (mode === 'heart') throw new Error('afterglow_requires_renderer_play_mode')
    const next = mode === 'repeat' ? undefined : window.items[1]
    const repeat =
      mode === 'repeat' || ((mode === 'shuffle' || mode === 'listLoop') && !next && !!row.track)
    const nativeMode = repeat ? 'repeat' : 'sequential'
    const endTarget = repeat ? row : next
    this.hasEndTarget = !!endTarget?.track
    // A refused lookahead handoff may still be recovered once the exact
    // occurrence naturally stops. Never use a reload fallback while playing.
    const end = engine.getPlaybackEnd()
    if (info.state === 'stopped' && end && !endTarget?.track) return
    if (info.state === 'stopped' && end && endTarget?.track) {
      const deadline = this.getPlaybackEndRecoveryDeadline()
      if (!deadline || (this.options.now ?? Date.now)() >= deadline) return
      const key = `${endTarget.queueEntryId}:${window.libraryRevision}`
      if (this.retry?.key === key && (this.options.now ?? Date.now)() < this.retry.after) return
      const cached = this.source?.key === key ? this.source.prepared : null
      let prepared: PreparedPlaybackSource
      try {
        prepared =
          cached && isSourceCurrent(cached.resolved, (this.options.now ?? Date.now)())
            ? cached
            : await this.prepare(libraryQueueTrack(endTarget.track, endTarget.queueEntryId))
        if (!current()) return
      } catch (error) {
        if (!current()) return
        this.retry = { key, after: (this.options.now ?? Date.now)() + 30_000 }
        throw error
      }
      if (!current()) return
      const { resolved } = prepared
      const target = nativeQueueItem(
        prepared.track,
        resolved.source,
        endTarget.position,
        mode !== 'repeat' && endTarget.position === lastPlayablePosition
      )
      await this.options.commit(async () => {
        if (!current() || !(await this.options.validateWindow(plan)) || !current()) return
        if ((this.options.now ?? Date.now)() >= deadline) return
        this.requireFreshSource(key, resolved, endTarget.position)
        let selected = false
        const mutation = (async () => {
          try {
            prepared.confirm?.()
            await this.options.commitSource?.(plan, endTarget.queueEntryId, prepared)
            if (!current()) return
            prepared.confirm?.()
            this.requireFreshSource(key, resolved, endTarget.position)
            const advanced = await engine.continueAfterPlaybackEnd({
              expected: end,
              item: target,
              playMode: nativeMode,
              isCurrent: () =>
                current() &&
                this.options.mayContinueAfterEnd?.() !== false &&
                (this.options.now ?? Date.now)() < deadline &&
                isSourceCurrent(resolved, (this.options.now ?? Date.now)()),
              onSelected: () => {
                selected = true
                this.mapping = [endTarget.position]
                this.options.onMappingChanged(this.getMapping())
              }
            })
            if (!advanced && endTarget.track?.id !== prepared.track.id)
              throw new Error('Native EOF rejected the repaired source identity')
            if (advanced && current()) {
              this.source = null
              this.retry = null
              this.rejected = null
              this.endRecovery = null
              this.requested = true
            } else if (current() && !isSourceCurrent(resolved, (this.options.now ?? Date.now)())) {
              this.options.onError(this.expiredSourceError(key, endTarget.position).message)
            }
          } finally {
            if (selected && engine.getQueueToken()) {
              const actual = await engine.getPlaybackInfo()
              if (
                actual.queueIndex === 0 &&
                engine.getQueueSnapshot()[0]?.queueEntryId === endTarget.queueEntryId
              )
                await this.options.onPlaybackAdvanced(
                  actual,
                  endTarget.position,
                  endTarget.queueEntryId,
                  prepared.track
                )
            }
          }
        })().catch(async (error) => {
          // Includes lost native/SQL replies. An explicit restore must reconcile
          // authority; a timer must not replay a possibly completed handoff.
          if (current()) {
            this.options.onError(error instanceof Error ? error.message : String(error))
            this.active = false
          }
          await this.options.onCommitError?.(error)
          throw error
        })
        this.engineDrain = mutation.catch(() => {})
        await mutation
      }, current)
      return
    }
    const attemptKey = `${token}:${info.queueIndex}:${window.queue.revision}:${window.libraryRevision}:${nativeMode}`
    // A refused/unsupported conditional handoff is not a reason to replay the
    // same request every timer tick. A new cursor/revision can try again.
    if (this.rejected === attemptKey) return
    const nextKey = next ? `${next.queueEntryId}:${window.libraryRevision}` : ''
    if (this.source?.key !== nextKey) this.source = null
    if (this.retry?.key !== nextKey) this.retry = null

    const apply = async (
      items: AudioEngineQueueItem[],
      mapping: number[],
      prepared?: PreparedPlaybackSource
    ): Promise<boolean> => {
      let changed = false
      await this.options.commit(async () => {
        if (!current()) return
        const valid = await this.options.validateWindow(plan)
        if (!current() || !valid || engine.getQueueToken() !== token) return
        const latest = await engine.getPlaybackInfo()
        if (
          !current() ||
          engine.getQueueToken() !== token ||
          latest.queueIndex !== info.queueIndex ||
          latest.source !== info.source
        )
          return
        // Source resolution can finish after EOF. Let the next pass use the
        // explicit end authority instead of rebinding an already stopped window.
        if (latest.state === 'stopped' && engine.getPlaybackEnd()) {
          this.requested = true
          return
        }
        if (prepared) this.requireFreshSource(nextKey, prepared.resolved, next!.position)
        // A dispatched rebind must be drained even if stop/restore arrives now.
        const mutation = (async () => {
          prepared?.confirm?.()
          if (prepared) await this.options.commitSource?.(plan, next!.queueEntryId, prepared)
          if (!current()) return
          prepared?.confirm?.()
          if (prepared) this.requireFreshSource(nextKey, prepared.resolved, next!.position)
          const result = await engine.rebindQueue({
            expected: {
              queueToken: token,
              index: info.queueIndex,
              id: item.id,
              source: item.source
            },
            items,
            startIndex: 0,
            playMode: nativeMode
          })
          if (!result) {
            if (prepared && next!.track?.id !== prepared.track.id)
              throw new Error('Native handoff rejected the repaired source identity')
            if (current()) {
              this.rejected = attemptKey
              this.options.onError('afterglow_library_queue_changed')
            }
            return
          }
          this.rejected = null
          this.mapping = mapping
          changed = true
          // Revocation cancels previews, not a native mutation already dispatched.
          // stop() drains this commit before the session's next transport/load;
          // publish its acknowledged mapping so a new maintainer inherits it.
          this.options.onMappingChanged(this.getMapping())
        })().catch(async (error) => {
          // Unknown native outcomes must not be replayed by a later tick.
          if (current()) {
            this.active = false
            this.options.onError(error instanceof Error ? error.message : String(error))
          }
          await this.options.onCommitError?.(error)
          throw error
        })
        this.engineDrain = mutation.catch(() => {})
        await mutation
      }, current)
      return changed
    }

    // Prune consumed rows and revoke a wrong successor/mode before slow URL
    // resolution. A looping native sub-window must never stand in for SQL EOF.
    const residentNext = native[info.queueIndex + 1]
    const expectedNext =
      next?.track && residentNext
        ? nativeQueueItem(
            libraryQueueTrack(next.track, next.queueEntryId),
            residentNext.source,
            next.position,
            next.position === lastPlayablePosition
          )
        : null
    const reusable =
      !!expectedNext &&
      (!this.source ||
        isSourceCurrent(this.source.prepared.resolved, (this.options.now ?? Date.now)())) &&
      residentNext.queueEntryId === next!.queueEntryId &&
      this.mapping[info.queueIndex + 1] === next!.position &&
      JSON.stringify(
        nativeQueueItem(
          residentNext,
          residentNext.source,
          next!.position,
          residentNext.logicalQueueEnd
        )
      ) === JSON.stringify(expectedNext)
    const base = [
      { ...item, logicalQueueEnd: mode !== 'repeat' && index === lastPlayablePosition },
      ...(reusable ? [residentNext] : [])
    ]
    const baseMap = [index, ...(reusable ? [next!.position] : [])]
    if (
      info.queueIndex !== 0 ||
      native.length !== base.length ||
      info.playMode !== nativeMode ||
      native.some(
        (entry, i) =>
          entry.queueEntryId !== base[i]?.queueEntryId ||
          entry.logicalQueueEnd !== base[i]?.logicalQueueEnd
      )
    ) {
      if (await apply(base, baseMap, reusable ? this.source?.prepared : undefined))
        this.requested = true
      return
    }
    if (!next?.track) {
      this.options.onHealthy?.()
      return
    }
    const now = (this.options.now ?? Date.now)()
    const cached = this.source
    if (
      cached &&
      isSourceCurrent(cached.prepared.resolved, now) &&
      (cached.prepared.resolved.expiresAt === null ||
        cached.prepared.resolved.expiresAt - now > 120_000 ||
        now < cached.refreshAfter)
    ) {
      this.options.onHealthy?.()
      return
    }
    if (this.retry && now < this.retry.after) return
    let prepared: PreparedPlaybackSource
    try {
      prepared = await this.prepare(libraryQueueTrack(next.track, next.queueEntryId))
    } catch (error) {
      if (!current()) return
      this.retry = { key: nextKey, after: (this.options.now ?? Date.now)() + 30_000 }
      throw error
    }
    if (!current()) return
    const { resolved } = prepared
    this.requireFreshSource(nextKey, resolved, next.position)
    const target = nativeQueueItem(
      prepared.track,
      resolved.source,
      next.position,
      next.position === lastPlayablePosition
    )
    if (!reusable || JSON.stringify(expectedNext) !== JSON.stringify(target)) {
      if (!(await apply([base[0], target], [index, next.position], prepared)) || !current()) {
        if (current() && this.requested) this.rememberSource(nextKey, prepared)
        return
      }
    }
    this.retry = null
    this.rememberSource(nextKey, prepared)
    this.options.onHealthy?.()
  }

  private expiredSourceError(key: string, position: number): Error {
    this.retry = { key, after: (this.options.now ?? Date.now)() + 30_000 }
    return new Error(`afterglow_core_source_expired:${position}`)
  }

  private requireFreshSource(key: string, resolved: ResolvedSource, position: number): void {
    if (isSourceCurrent(resolved, (this.options.now ?? Date.now)())) return
    throw this.expiredSourceError(key, position)
  }

  private async prepare(track: TrackData): Promise<PreparedPlaybackSource> {
    if (this.options.prepareSource)
      return this.options.prepareSource(track, this.sourceReads.signal)
    const resolved = await this.options.resolver.resolve(track, this.sourceReads.signal)
    this.sourceReads.signal.throwIfAborted()
    if (!resolved) throw new Error('afterglow_core_source_unavailable')
    return {
      track,
      resolved: {
        ...resolved,
        source: await authorizeNativeSource(resolved.source, this.options.authorize)
      }
    }
  }

  private rememberSource(key: string, prepared: PreparedPlaybackSource): void {
    const { resolved } = prepared
    const resolvedAt = (this.options.now ?? Date.now)()
    this.source = {
      key,
      prepared,
      refreshAfter:
        resolvedAt +
        Math.min(30_000, Math.max(1_000, ((resolved.expiresAt ?? Infinity) - resolvedAt) / 2))
    }
  }
}
