import { app, globalShortcut, type BrowserWindow } from 'electron'
import { join } from 'path'
import type { PlaybackInfo } from '../audio/audioEngineTypes.ts'
import { runtime } from '../core/runtime.ts'
import {
  AFTERGLOW_RESTORE_ACCELERATOR,
  AFTERGLOW_RESTORE_ACCELERATORS,
  isAfterglowPlayableSource,
  parseAfterglowRendererSnapshot,
  resolveAfterglowEngineMapping,
  type AfterglowAutoEntry,
  type AfterglowModePhase,
  type AfterglowModeStatus,
  type AfterglowRendererSnapshot,
  type AfterglowRestoreState,
  type AfterglowTransportCommand
} from '../../shared/afterglowMode.ts'
import { saveWindowState } from './windowState.ts'
import { playbackSessionService } from './playbackSessionService.ts'
import {
  buildRestoreState,
  buildStoppedLibraryRestoreState,
  applyAfterglowEngineState,
  getAfterglowEngineMapping,
  refreshAfterglowPresentationNow,
  setAfterglowEngineMapping,
  startAfterglowPresentation,
  stopAfterglowPresentation
} from './afterglowSnapshot.ts'
import {
  createAfterglowAnchorWindow,
  destroyAfterglowAnchorWindow,
  getAfterglowAnchorHandle
} from './afterglowAnchorWindow.ts'
import {
  dispatchRendererFreeTransport,
  enqueueRendererFreeTransport,
  rendererFreePlayModes
} from './rendererFreePlayback.ts'
import { AfterglowQueueCore } from './afterglowQueueCore.ts'
import { AfterglowLibraryQueueCore } from './afterglowLibraryQueueCore.ts'
import { createAfterglowSourceResolver } from './afterglowSourceResolver.ts'
import { navigateAfterglowLibraryQueue } from './afterglowLibraryTransport.ts'
import type { AfterglowLibraryNavigation } from './afterglowLibraryTransport.ts'
import {
  changeAfterglowLibraryMode,
  reconcileAfterglowLibraryMode
} from './afterglowLibraryMode.ts'
import type {
  AfterglowLibraryModeOptions,
  AfterglowLibraryModePending
} from './afterglowLibraryMode.ts'
import { resolveAuthorizedAudioSource } from '../security/localPaths.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'
import { LIBRARY_PAGE_SIZE } from '../../shared/libraryDatabase.ts'
import { sleepTimerService } from '../sleepTimer.ts'
import { SleepTimerShutdown } from '../sleepTimerShutdown.ts'
import { getCoreAfterglowMode, dispatchCoreAfterglowTransport } from './coreAfterglowRuntime.ts'

export type AfterglowEntryMode = 'manual' | 'minimize' | 'hide'

export const afterglowRestoreReadyTimeoutMs = 15_000
const AFTERGLOW_UI_DESTROY_DELAY_MS = 80
/** Windowed (online) queues stop at their last loaded entry; bring the UI back. */
const AFTERGLOW_WINDOWED_AUTO_RESTORE_DELAY_MS = 6_000
const AFTERGLOW_QUEUE_REFERENCE_OWNER = 'afterglow'

const fallbackMediaKeys: Array<[string, AfterglowTransportCommand]> = [
  ['MediaPlayPause', { type: 'toggle-play' }],
  ['MediaPreviousTrack', { type: 'previous' }],
  ['MediaNextTrack', { type: 'next' }],
  ['MediaStop', { type: 'stop' }]
]

class AfterglowModeService {
  private phase: AfterglowModePhase = 'inactive'
  private error: string | null = null
  private generation = 0
  private entryCompletion: Promise<AfterglowModeStatus> | null = null
  private restoreCompletion: Promise<AfterglowModeStatus> | null = null
  private readonly ownedShortcuts = new Set<string>()
  private restoreAccelerator: string | null = null
  private uiDestroyTimer: ReturnType<typeof setTimeout> | null = null
  private entryMode: AfterglowEntryMode | null = null
  private miniPlayerWasOpen = false
  private desktopLyricsWasVisible = false
  private resolveAdopt: (() => void) | null = null
  private adoptPromise: Promise<void> | null = null
  private adoptCompleted = false
  /** Queue snapshot the renderer handed over just before it unloaded. */
  private rendererSnapshot: AfterglowRendererSnapshot | null = null
  /** True when the native queue is only a current+next window (online queues). */
  private windowedQueue = false
  private autoRestoreTimer: ReturnType<typeof setTimeout> | null = null
  private autoRestoreAt = 0
  private autoRestoreListener: ((info: PlaybackInfo) => void) | null = null
  /** Online (windowed) queue maintenance; null when the engine lacks hot update. */
  private queueCore: AfterglowQueueCore | AfterglowLibraryQueueCore | null = null
  private queueCoreTick: (() => void) | null = null
  private queueCoreUnbind: (() => void) | null = null
  private queueCoreDrain: Promise<void> = Promise.resolve()
  private queueCoreGeneration = 0
  private transportMutationDrain: Promise<void> = Promise.resolve()
  /** Stop/pause/play/seek revoke older queued SQL controls, not volume changes. */
  private libraryControlRevision = 0
  private libraryControlPreview: AbortController | null = null
  private sleepShutdown: SleepTimerShutdown | null = null
  private releaseSleepShutdown: (() => void) | null = null
  private sleepHandoff: {
    triggerRevision: number
    startedAt: number
    volume: number
    completion: Promise<boolean>
  } | null = null
  private pendingLibraryMode: AfterglowLibraryModePending | null = null
  private stoppedLibraryRecovery: {
    engine: NonNullable<typeof runtime.audioEngineManager>
    revision: number
  } | null = null
  private libraryModeRecovery: Promise<void> | null = null
  private queueCoreResume: {
    snapshot: AfterglowRendererSnapshot
    queueLength: number
    loadQueueItem?: (index: number) => Promise<unknown | null>
  } | null = null
  /** Protects a database queue while the renderer is unloaded. */
  private afterglowLibraryQueueId: string | null = null
  private queueReferenceGeneration = 0

  private async setAfterglowLibraryQueueReference(
    id: string | null,
    required: boolean
  ): Promise<void> {
    const generation = ++this.queueReferenceGeneration
    const database = runtime.libraryDatabase?.database
    if (!database) {
      if (id) throw new Error('afterglow_requires_library_database')
      return
    }
    try {
      // Keep the candidate locally before awaiting the IPC reply. A lost reply
      // can still mean that SQLite committed the protection; failure cleanup
      // must therefore attempt to release that candidate as well.
      if (id) this.afterglowLibraryQueueId = id
      await database.syncLibraryQueueReferences(AFTERGLOW_QUEUE_REFERENCE_OWNER, id ? [id] : [])
      if (generation === this.queueReferenceGeneration) this.afterglowLibraryQueueId = id
    } catch (error) {
      if (required) throw error
      console.warn('[afterglow] failed to release the library queue reference:', error)
    }
  }

  private releaseAfterglowLibraryQueueReference(): void {
    if (!this.afterglowLibraryQueueId) return
    void this.setAfterglowLibraryQueueReference(null, false)
  }

  private async prepareLibraryQueueSnapshot(
    snapshot: AfterglowRendererSnapshot,
    engineQueue: readonly { id?: string; source?: string; queueEntryId?: string }[],
    isCurrent: () => boolean
  ) {
    const reference = snapshot.libraryQueue
    const database = runtime.libraryDatabase?.database
    if (!reference || !database) throw new Error('afterglow_requires_library_database')
    const queue = await database.getLibraryQueue(reference.id)
    if (!isCurrent()) throw new Error('afterglow_entry_cancelled')
    if (
      queue.revision !== reference.revision ||
      queue.index !== reference.index ||
      queue.selectedEntryId !== reference.entryId
    )
      throw new Error('afterglow_library_queue_changed')
    const mapping = snapshot.nativeQueueIndices
    if (
      !mapping ||
      mapping.length !== engineQueue.length ||
      mapping.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= queue.total)
    )
      throw new Error('afterglow_requires_mappable_current_track')
    // The incoming native window can straddle the *previous* page after EOF.
    // Verify supplied positions against exact occurrences, one bounded page
    // at a time; do not accumulate every native entry's Track detail.
    for (const pageNumber of new Set(
      mapping.map((index) => Math.floor(index / LIBRARY_PAGE_SIZE))
    )) {
      const page = await database.readLibraryQueue(
        reference.id,
        pageNumber * LIBRARY_PAGE_SIZE,
        LIBRARY_PAGE_SIZE,
        { expectedRevision: reference.revision }
      )
      if (!isCurrent()) throw new Error('afterglow_entry_cancelled')
      for (let native = 0; native < mapping.length; native++) {
        const index = mapping[native]
        if (Math.floor(index / LIBRARY_PAGE_SIZE) !== pageNumber) continue
        const entry = page.items[index % LIBRARY_PAGE_SIZE]
        if (
          !entry?.track ||
          entry.queueEntryId !== engineQueue[native].queueEntryId ||
          entry.track.id !== engineQueue[native].id
        )
          throw new Error('afterglow_requires_mappable_current_track')
      }
    }
    const loadQueueItem = async (index: number): Promise<unknown | null> => {
      const current = playbackSessionService.getCachedSession()?.libraryQueue
      if (!current || current.id !== reference.id) return null
      const page = await database.readLibraryQueue(reference.id, index, 1, {
        expectedRevision: current.revision
      })
      const item = page.items[0]
      return item?.track ? { ...item.track, queueEntryId: item.queueEntryId } : null
    }
    return { queue, mapping: [...mapping], loadQueueItem }
  }

  getStatus(): AfterglowModeStatus {
    return {
      phase: this.phase,
      active: this.phase !== 'inactive',
      restoreAccelerator: this.restoreAccelerator ?? AFTERGLOW_RESTORE_ACCELERATOR,
      error: this.error
    }
  }

  isActive(): boolean {
    return this.phase !== 'inactive'
  }

  enter(entryMode: AfterglowEntryMode = 'manual'): Promise<AfterglowModeStatus> {
    if (this.entryCompletion) return this.entryCompletion
    if (this.isActive()) return Promise.resolve(this.getStatus())
    const generation = ++this.generation
    this.phase = 'entering'
    this.entryMode = entryMode
    this.error = null
    const completion = this.performEntry(entryMode, generation).catch(async (error) => {
      if (!this.isCurrentEntry(generation)) return this.getStatus()
      try {
        await this.sleepShutdown?.cancel()
      } catch (cleanupError) {
        writeDiagnostic(
          'afterglow',
          'sleep-handoff.cleanup-failed',
          {
            message: String(cleanupError)
          },
          'warn'
        )
      }
      this.releaseSleepTimerShutdown()
      return this.fail(error instanceof Error ? error.message : String(error))
    })
    this.entryCompletion = completion
    void completion.then(() => {
      if (this.entryCompletion === completion) this.entryCompletion = null
    })
    return completion
  }

  private isCurrentEntry(generation: number): boolean {
    return generation === this.generation && (this.phase === 'entering' || this.phase === 'active')
  }

  /** Stores the renderer's pre-unload queue snapshot (memory only). */
  setRendererSnapshot(payload: unknown): boolean | Promise<boolean> {
    const snapshot = parseAfterglowRendererSnapshot(payload)
    if (!snapshot) return false
    const handoff = snapshot.sleepShutdown
    if (handoff) {
      // Acceptance is synchronous; only the gain/volume ACKs are asynchronous.
      // A subsequent getState therefore resolves a lost invoke reply safely.
      if (this.phase !== 'active' || !this.sleepShutdown || handoff.startedAt > Date.now())
        return false
      if (this.sleepHandoff?.triggerRevision === handoff.triggerRevision) {
        return this.sleepHandoff.startedAt === handoff.startedAt &&
          this.sleepHandoff.volume === handoff.volume
          ? this.sleepHandoff.completion
          : false
      }
      const state = sleepTimerService.snapshot()
      if (
        !state?.triggered ||
        state.triggerRevision !== handoff.triggerRevision ||
        state.shutdownOwner === 'main' ||
        this.sleepShutdown.isActive() ||
        !sleepTimerService.transferShutdown(handoff.triggerRevision)
      )
        return false
      const completion = this.sleepShutdown.adopt(state, handoff).then(() => true)
      this.sleepHandoff = { ...handoff, completion }
      this.rendererSnapshot = snapshot
      return completion
    }
    this.rendererSnapshot = snapshot
    return true
  }

  /**
   * Starts renderer-free online queue maintenance for a windowed native queue.
   * Older engines without the queueHotUpdate capability keep the v0 window
   * behavior (play what was loaded, then auto-restore the UI).
   */
  private async startQueueCore(
    snapshot: AfterglowRendererSnapshot,
    mapping: number[],
    logicalCurrent: number,
    queueLength = snapshot.queue.length,
    loadQueueItem?: (index: number) => Promise<unknown | null>
  ): Promise<void> {
    const generation = this.generation
    const stopped = this.stopQueueCore()
    const coreGeneration = this.queueCoreGeneration
    await stopped
    if (
      generation !== this.generation ||
      this.phase !== 'active' ||
      this.sleepShutdown?.isActive() ||
      coreGeneration !== this.queueCoreGeneration
    )
      return
    const manager = runtime.audioEngineManager
    if (!manager) return
    if (snapshot.libraryQueue) {
      const library = runtime.libraryDatabase
      if (!library) return
      const database = library.database
      const sleepTriggerRevision = sleepTimerService.getTriggerRevision()
      const core = new AfterglowLibraryQueueCore({
        engine: manager,
        nativeQueueIndices: mapping,
        resolver: createAfterglowSourceResolver(),
        authorize: resolveAuthorizedAudioSource,
        mayContinueAfterEnd: () => sleepTimerService.getTriggerRevision() === sleepTriggerRevision,
        readWindow: async (index, entryId, current) => {
          const info = await manager.getPlaybackInfo()
          if (
            !current() ||
            getAfterglowEngineMapping()?.[info.queueIndex] !== index ||
            manager.getQueueSnapshot()[info.queueIndex]?.queueEntryId !== entryId
          )
            return null
          await applyAfterglowEngineState(info, false, current)
          if (!current()) return null
          const session = playbackSessionService.getCachedSession()
          const reference = session?.libraryQueue
          if (!reference || reference.index !== index || reference.entryId !== entryId) return null
          const mode = session.playMode ?? 'sequential'
          const window = await database.readLibraryQueuePlaybackWindow(
            reference.id,
            reference.revision,
            index,
            mode === 'listLoop' || mode === 'shuffle'
          )
          return { window, mode }
        },
        validateWindow: async (plan) => {
          const actual = await database.readLibraryQueuePlaybackWindow(
            plan.window.queue.id,
            plan.window.queue.revision,
            plan.window.queue.index,
            plan.mode === 'listLoop' || plan.mode === 'shuffle'
          )
          return (
            actual.libraryRevision === plan.window.libraryRevision &&
            actual.queue.selectedEntryId === plan.window.queue.selectedEntryId &&
            actual.queue.index === plan.window.queue.index &&
            playbackSessionService.getCachedSession()?.playMode === plan.mode
          )
        },
        commit: (operation, current) =>
          enqueueRendererFreeTransport(async () => {
            if (!current()) return
            stopAfterglowPresentation()
            try {
              // Fence pending old-index presentation work before replacing the map.
              try {
                await playbackSessionService.flush()
              } catch (error) {
                console.warn(
                  '[afterglow] session persistence unavailable before maintenance:',
                  error
                )
              }
              if (current()) await operation()
            } finally {
              if (current()) startAfterglowPresentation()
            }
          }),
        onMappingChanged: setAfterglowEngineMapping,
        onPlaybackAdvanced: (info, index, entryId) =>
          playbackSessionService.applyEngineState(info, {
            force: true,
            logicalIndex: index,
            entryId,
            nativeEntries: manager.getQueueSnapshot().map((item, nativeIndex) => ({
              id: item.id,
              queueEntryId: item.queueEntryId,
              index: core.getMapping()[nativeIndex]
            }))
          }),
        onError: (message) => {
          if (generation === this.generation && this.phase === 'active') this.error = message
          writeDiagnostic('afterglow', 'queue-core.error', { message }, 'warn')
        },
        onHealthy: () => {
          if (generation === this.generation && this.phase === 'active' && this.queueCore === core)
            this.error = null
        }
      })
      this.queueCoreResume = { snapshot, queueLength, loadQueueItem }
      this.queueCore = core
      const tick = (): void => {
        void core.tick()
      }
      this.queueCoreTick = tick
      manager.on('playback-info', tick)
      library.on('changed', tick)
      // playback-info omits time-only ticks; expiring URLs still need maintenance.
      const timer = setInterval(tick, 15_000)
      timer.unref?.()
      this.queueCoreUnbind = () => {
        clearInterval(timer)
        library.off('changed', tick)
      }
      void core.start()
      return
    }
    const capability = await manager.getQueueHotUpdateCapabilityAsync()
    writeDiagnostic(
      'afterglow',
      'queue-core.capability',
      {
        available: capability !== null,
        queueLength,
        nativeQueueLength: mapping.length,
        windowed: this.windowedQueue
      },
      'info'
    )
    if (
      generation !== this.generation ||
      coreGeneration !== this.queueCoreGeneration ||
      this.phase !== 'active' ||
      !capability?.append ||
      !capability.updateSource
    ) {
      return
    }
    const core = new AfterglowQueueCore({
      queue: snapshot.queue,
      queueLength,
      loadQueueItem,
      currentLogicalIndex: logicalCurrent,
      nativeQueueIndices: mapping,
      engine: manager,
      resolver: createAfterglowSourceResolver(),
      onMappingChanged: (next) => {
        setAfterglowEngineMapping([...next])
        writeDiagnostic(
          'afterglow',
          'queue-core.mapping',
          { length: next.length, lastLogicalIndex: next.at(-1) ?? -1 },
          'info'
        )
      },
      onError: (message) => {
        writeDiagnostic('afterglow', 'queue-core.error', { message }, 'warn')
        console.warn('[afterglow] queue core:', message)
      }
    })
    this.queueCoreResume = { snapshot, queueLength, loadQueueItem }
    this.queueCore = core
    const tick = (): void => {
      void core.tick()
    }
    this.queueCoreTick = tick
    manager.on('playback-info', tick)
    writeDiagnostic(
      'afterglow',
      'queue-core.start',
      {
        queueLength: snapshot.queue.length,
        nativeQueueLength: mapping.length,
        mappingStart: mapping[0] ?? -1
      },
      'info'
    )
    void core.start()
  }

  private stopQueueCore(): Promise<void> {
    this.queueCoreGeneration++
    const manager = runtime.audioEngineManager
    if (manager && this.queueCoreTick) manager.off('playback-info', this.queueCoreTick)
    this.queueCoreTick = null
    this.queueCoreUnbind?.()
    this.queueCoreUnbind = null
    const core = this.queueCore
    this.queueCore = null
    if (!core) return this.queueCoreDrain
    const generation = this.generation
    this.queueCoreDrain = core.stop().then(() => {
      if (
        generation === this.generation &&
        this.queueCore === null &&
        (this.phase === 'active' || this.phase === 'restoring')
      )
        setAfterglowEngineMapping(core.getMapping())
    })
    return this.queueCoreDrain
  }

  /**
   * Restores the UI when playback stops for any reason (queue end, failed
   * online URL, user stop). The timer is cancelled if a new track starts first.
   */
  private bindWindowedAutoRestore(): void {
    this.unbindWindowedAutoRestore()
    // A failed sleep stop remains an explicit transport error, not an automatic
    // restore/retry loop. Successful shutdown binds the normal grace afterwards.
    if (this.sleepShutdown?.isActive()) return
    const manager = runtime.audioEngineManager
    if (!manager) return
    const listener = (info: PlaybackInfo): void => {
      if (this.phase !== 'active') return
      if (playbackSessionService.getCachedSession()?.libraryQueue && !manager.getQueueToken()) {
        this.unbindWindowedAutoRestore()
        return
      }
      if (info.state === 'playing') {
        // A short stopped blip between tracks must not tear the UI back in.
        if (this.autoRestoreTimer) {
          clearTimeout(this.autoRestoreTimer)
          this.autoRestoreTimer = null
          this.autoRestoreAt = 0
        }
        return
      }
      if (info.state !== 'stopped') return
      const recoveryDeadline =
        this.queueCore instanceof AfterglowLibraryQueueCore
          ? this.queueCore.getPlaybackEndRecoveryDeadline()
          : null
      const now = Date.now()
      const restoreAt = Math.max(
        now + AFTERGLOW_WINDOWED_AUTO_RESTORE_DELAY_MS,
        recoveryDeadline ?? 0
      )
      // A stop during EOF recovery shortens its grace. Repeated stopped
      // notifications must neither extend the deadline nor reset this timer.
      if (this.autoRestoreTimer) {
        if (this.autoRestoreAt <= restoreAt) return
        clearTimeout(this.autoRestoreTimer)
      }
      this.autoRestoreAt = restoreAt
      // Queue end, a failed online URL and an intentional stop all land here.
      // Restoring the UI is always better than leaving an invisible stopped
      // player, and the user can immediately press play again.
      console.info('[afterglow] playback stopped; restoring the UI')
      this.autoRestoreTimer = setTimeout(() => {
        this.autoRestoreTimer = null
        this.autoRestoreAt = 0
        if (
          this.phase === 'active' &&
          (!playbackSessionService.getCachedSession()?.libraryQueue || manager.getQueueToken())
        )
          void restoreAfterglowMode()
      }, restoreAt - now)
      this.autoRestoreTimer.unref?.()
    }
    this.autoRestoreListener = listener
    manager.on('playback-info', listener)
    void manager
      .getPlaybackInfo()
      .then((info) => {
        if (this.autoRestoreListener === listener) listener(info)
      })
      .catch((error) => {
        writeDiagnostic('afterglow', 'auto-restore.read-error', { message: String(error) }, 'warn')
      })
  }

  private unbindWindowedAutoRestore(): void {
    if (this.autoRestoreTimer) {
      clearTimeout(this.autoRestoreTimer)
      this.autoRestoreTimer = null
    }
    this.autoRestoreAt = 0
    const manager = runtime.audioEngineManager
    if (manager && this.autoRestoreListener) {
      manager.off('playback-info', this.autoRestoreListener)
    }
    this.autoRestoreListener = null
  }

  private bindSleepTimerShutdown(): void {
    const manager = runtime.audioEngineManager
    if (!manager || this.sleepShutdown) return
    const report = (error: unknown) => {
      if (this.phase !== 'inactive') this.error = String(error)
      writeDiagnostic('afterglow', 'sleep-shutdown.error', { message: String(error) }, 'warn')
    }
    const shutdown = new SleepTimerShutdown({
      getPlaybackInfo: () => manager.getPlaybackInfo(),
      setGain: (gain) => manager.setSleepTimerGain(gain),
      setUserVolume: (volume, current) =>
        dispatchRendererFreeTransport(
          { type: 'set-volume', volume },
          {
            isCurrent: () => current() && this.isActive() && runtime.audioEngineManager === manager,
            beforeTransport: () => this.transportMutationDrain
          }
        ),
      quiesce: () => {
        this.cancelLibraryControlPreview()
        this.unbindWindowedAutoRestore()
        return Promise.all([this.stopQueueCore(), this.transportMutationDrain]).then(() => {})
      },
      stop: (current) =>
        dispatchRendererFreeTransport(
          { type: 'stop' },
          {
            isCurrent: () => current() && this.isActive() && runtime.audioEngineManager === manager,
            beforeTransport: () => this.transportMutationDrain
          }
        ),
      onStopped: () => {
        if (this.phase === 'active' && this.sleepShutdown === shutdown)
          this.bindWindowedAutoRestore()
      },
      onError: report
    })
    this.sleepShutdown = shutdown
    this.releaseSleepShutdown = sleepTimerService.claimShutdown({
      trigger: (state) => shutdown.begin(state),
      update: (state) => {
        playbackSessionService.syncSleepTimer(state)
        if (!state?.triggered) {
          const wasActive = shutdown.isActive()
          void shutdown
            .cancel()
            .then(() => {
              if (wasActive && this.phase === 'active' && this.sleepShutdown === shutdown) {
                this.resumeQueueMaintenance()
                this.bindWindowedAutoRestore()
              }
            })
            .catch(report)
        }
      }
    })
  }

  private releaseSleepTimerShutdown(): void {
    this.releaseSleepShutdown?.()
    this.releaseSleepShutdown = null
    this.sleepShutdown = null
    this.sleepHandoff = null
  }

  /** The first queue snapshot is not a running-fade handoff. Ask again after
   * claiming trigger execution so no new renderer fade can start in the gap. */
  private async settleRendererSleepShutdownHandoff(): Promise<boolean> {
    if (!sleepTimerService.snapshot()?.triggered || this.sleepShutdown?.isActive()) {
      await this.sleepHandoff?.completion
      return true
    }
    try {
      await playbackSessionService.flushFromRenderer({ includeQueue: true })
      await this.sleepHandoff?.completion
      return true
    } catch (error) {
      // The flush reply can be lost after main accepted the execution. It must
      // neither restart the old fade nor strand an already-owned native gain.
      if (this.sleepHandoff || this.sleepShutdown?.isActive()) {
        // The outer renderer flush can time out while adoption still awaits a
        // gain or preference ACK. Ownership alone is not the teardown barrier.
        await this.sleepHandoff?.completion
        writeDiagnostic(
          'afterglow',
          'sleep-handoff.flush-reply-lost',
          { message: String(error) },
          'warn'
        )
        return true
      }
      writeDiagnostic('afterglow', 'sleep-handoff.failed', { message: String(error) }, 'warn')
      return false
    }
  }

  private async performEntry(
    entryMode: AfterglowEntryMode,
    generation: number
  ): Promise<AfterglowModeStatus> {
    const rejection = await this.evaluateEntryRejection(entryMode)
    if (rejection) return this.fail(rejection)
    if (!this.isCurrentEntry(generation)) return this.getStatus()

    const manager = runtime.audioEngineManager
    if (!manager) return this.fail('afterglow_requires_native_engine')

    try {
      await playbackSessionService.flushFromRenderer({ includeQueue: true })
    } catch (error) {
      console.warn('[afterglow] renderer session flush failed:', error)
      // The memory handoff is the contract that matters. Disk persistence is
      // best-effort: a locked/corrupt playback-session file must not make the
      // UI permanently un-unloadable.
      if (!this.rendererSnapshot) return this.fail('afterglow_renderer_flush_failed')
    }
    if (!this.isCurrentEntry(generation)) return this.getStatus()

    const snapshot = this.rendererSnapshot
    if (!snapshot || (snapshot.queue.length === 0 && !snapshot.libraryQueue)) {
      return this.fail('afterglow_requires_renderer_snapshot')
    }
    const engineQueue = manager.getQueueSnapshot()
    if (engineQueue.length === 0) {
      return this.fail(
        `afterglow_requires_fully_delegated_queue:0/${snapshot.libraryQueue ? 1 : snapshot.queue.length}`
      )
    }
    let effectiveSnapshot = snapshot
    let queueLength = snapshot.queue.length
    let loadQueueItem: ((index: number) => Promise<unknown | null>) | undefined
    let mapping: number[]
    if (snapshot.libraryQueue) {
      try {
        const prepared = await this.prepareLibraryQueueSnapshot(snapshot, engineQueue, () =>
          this.isCurrentEntry(generation)
        )
        if (!this.isCurrentEntry(generation)) return this.getStatus()
        await this.setAfterglowLibraryQueueReference(prepared.queue.id, true)
        if (!this.isCurrentEntry(generation)) return this.getStatus()
        effectiveSnapshot = snapshot
        queueLength = prepared.queue.total
        mapping = prepared.mapping
        loadQueueItem = prepared.loadQueueItem
      } catch (error) {
        if (!this.isCurrentEntry(generation)) return this.getStatus()
        return this.fail(error instanceof Error ? error.message : String(error))
      }
    } else {
      try {
        await this.setAfterglowLibraryQueueReference(null, true)
      } catch (error) {
        return this.fail(error instanceof Error ? error.message : String(error))
      }
      if (engineQueue.length > snapshot.queue.length) {
        return this.fail(
          `afterglow_requires_fully_delegated_queue:${engineQueue.length}/${snapshot.queue.length}`
        )
      }
      mapping = resolveAfterglowEngineMapping(
        snapshot.queue,
        engineQueue,
        snapshot.nativeQueueIndices
      )
    }
    if (engineQueue.length > queueLength) {
      return this.fail(
        `afterglow_requires_fully_delegated_queue:${engineQueue.length}/${queueLength}`
      )
    }
    const info = await manager.getPlaybackInfo()
    if (!this.isCurrentEntry(generation)) return this.getStatus()
    const logicalCurrent = mapping[info.queueIndex]
    if (!(logicalCurrent >= 0)) {
      console.warn('[afterglow] current native entry could not be mapped', {
        engineIndex: info.queueIndex,
        mapping
      })
      return this.fail('afterglow_requires_mappable_current_track')
    }
    // A windowed queue keeps playing only until its loaded entries run out; the
    // service restores the UI automatically when that happens.
    this.windowedQueue = engineQueue.length !== queueLength
    setAfterglowEngineMapping(mapping)

    await playbackSessionService.adoptRendererSnapshot(snapshot)
    if (!this.isCurrentEntry(generation)) return this.getStatus()

    await applyAfterglowEngineState(info, true, () => this.isCurrentEntry(generation))
    try {
      await playbackSessionService.flush()
    } catch (error) {
      // Persistence is best-effort for Afterglow; the in-memory snapshot is
      // what the restore handoff uses.
      console.warn('[afterglow] session flush failed (non-fatal):', error)
    }
    if (!this.isCurrentEntry(generation)) return this.getStatus()

    if (!this.registerRestoreShortcut() && entryMode === 'manual') {
      return this.fail('afterglow_restore_shortcut_unavailable')
    }
    this.registerFallbackMediaKeys()

    const { createTray } = await import('../integrations/shortcutsTray.ts')
    createTray()
    if (!this.isCurrentEntry(generation)) return this.getStatus()

    this.miniPlayerWasOpen = Boolean(
      runtime.miniPlayerWindow && !runtime.miniPlayerWindow.isDestroyed()
    )
    this.desktopLyricsWasVisible = Boolean(
      runtime.desktopLyricsWindow && !runtime.desktopLyricsWindow.isDestroyed()
    )

    const anchor = createAfterglowAnchorWindow({
      showInTaskbar: entryMode === 'minimize',
      onRestore: () => {
        void restoreAfterglowMode()
      }
    })
    if (anchor) {
      const smtc = await import('../integrations/windowsSmtc.ts')
      smtc.rebindWindowsSmtc(getAfterglowAnchorHandle())
    }
    if (!this.isCurrentEntry(generation)) return this.getStatus()

    this.phase = 'active'
    this.bindSleepTimerShutdown()
    if (!(await this.settleRendererSleepShutdownHandoff())) {
      throw new Error('afterglow_sleep_shutdown_handoff_failed')
    }
    if (!this.isCurrentEntry(generation)) return this.getStatus()
    startAfterglowPresentation()
    void this.startQueueCore(effectiveSnapshot, mapping, logicalCurrent, queueLength, loadQueueItem)
    this.bindWindowedAutoRestore()
    this.saveMainWindowBounds()

    this.uiDestroyTimer = setTimeout(() => {
      this.uiDestroyTimer = null
      if (this.isCurrentEntry(generation)) void this.destroyAllUiWindows(generation)
    }, AFTERGLOW_UI_DESTROY_DELAY_MS)
    this.uiDestroyTimer.unref?.()

    return this.getStatus()
  }

  private async evaluateEntryRejection(entryMode: AfterglowEntryMode): Promise<string | null> {
    const manager = runtime.audioEngineManager
    if (!manager) return 'afterglow_requires_native_engine'

    if (entryMode !== 'manual') {
      const window = runtime.mainWindow
      if (!window || window.isDestroyed() || (window.isVisible() && !window.isMinimized())) {
        return 'afterglow_requires_minimized_or_hidden_window'
      }
    }

    let info
    try {
      info = await manager.getPlaybackInfo()
    } catch {
      return 'afterglow_requires_native_engine'
    }
    if (!info.source) return 'afterglow_requires_active_track'
    if (info.state !== 'playing' && info.state !== 'paused') {
      return 'afterglow_requires_active_playback'
    }
    if (info.nativePlaybackActive !== true) {
      return 'afterglow_requires_native_playback'
    }
    // The native queue is what keeps playing; the renderer's Track.streamUrl may
    // still be a twilight-media grant even when main resolved it to a local cache
    // file, so validate the sources the engine actually holds.
    const engineQueue = manager.getQueueSnapshot()
    if (engineQueue.length === 0) {
      return 'afterglow_requires_fully_delegated_queue:0/0'
    }
    const nonLocalIndex = engineQueue.findIndex((item) => !isAfterglowPlayableSource(item.source))
    if (nonLocalIndex >= 0) {
      const scheme =
        /^[a-z][a-z\d+.-]*:/i.exec(engineQueue[nonLocalIndex]?.source ?? '')?.[0] ?? 'unknown'
      console.warn('[afterglow] engine queue entry is not a local file', {
        index: nonLocalIndex,
        scheme
      })
      return `afterglow_requires_fully_local_queue:${nonLocalIndex}`
    }
    return null
  }

  private saveMainWindowBounds(): void {
    const window = runtime.mainWindow
    if (!window || window.isDestroyed()) return
    try {
      const bounds = window.getNormalBounds()
      saveWindowState(join(app.getPath('userData'), 'window-state.json'), {
        width: bounds.width,
        height: bounds.height,
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen()
      })
    } catch (error) {
      console.warn('[afterglow] unable to save window size:', error)
    }
  }

  private async destroyAllUiWindows(generation: number): Promise<void> {
    if (!this.isCurrentEntry(generation)) return
    try {
      const [{ destroyDesktopLyrics }, { destroyDynamicIsland }, { destroyTrayPlayerWindow }] =
        await Promise.all([
          import('../integrations/desktopLyrics.ts'),
          import('../integrations/dynamicIsland.ts'),
          import('../integrations/trayPlayer.ts')
        ])
      if (!this.isCurrentEntry(generation)) return
      destroyDesktopLyrics()
      destroyDynamicIsland()
      destroyTrayPlayerWindow()
      const miniPlayer = runtime.miniPlayerWindow
      if (miniPlayer && !miniPlayer.isDestroyed()) miniPlayer.destroy()
      runtime.miniPlayerWindow = null
    } catch (error) {
      console.warn('[afterglow] auxiliary window cleanup was incomplete:', error)
    }
    if (!this.isCurrentEntry(generation)) return

    const window = runtime.mainWindow
    if (window && !window.isDestroyed()) {
      const { setMainWindowAfterglowUnloading } = await import('./window.ts')
      setMainWindowAfterglowUnloading(true)
      try {
        window.destroy()
      } catch (error) {
        setMainWindowAfterglowUnloading(false)
        throw error
      }
      runtime.mainWindow = null
      // `closed` normally consumes the flag; keep it from leaking into a later
      // window if the event never reaches this listener.
      setTimeout(() => setMainWindowAfterglowUnloading(false), 1_000).unref?.()
    }
    if (!this.isCurrentEntry(generation)) return
    refreshAfterglowPresentationNow()
  }

  private registerRestoreShortcut(): boolean {
    for (const accelerator of AFTERGLOW_RESTORE_ACCELERATORS) {
      try {
        if (globalShortcut.isRegistered(accelerator)) continue
        if (
          globalShortcut.register(accelerator, () => {
            void restoreAfterglowMode()
          })
        ) {
          this.restoreAccelerator = accelerator
          this.ownedShortcuts.add(accelerator)
          return true
        }
      } catch {
        // Try the next candidate; one inaccessible accelerator must not strand
        // the session without a restore key.
      }
    }
    return false
  }

  private registerFallbackMediaKeys(): void {
    for (const [accelerator, command] of fallbackMediaKeys) {
      try {
        if (globalShortcut.isRegistered(accelerator)) continue
        if (
          globalShortcut.register(accelerator, () => {
            void dispatchAfterglowTransport(command)
          })
        ) {
          this.ownedShortcuts.add(accelerator)
        }
      } catch {
        // Media keys are best effort; the dedicated shortcut and tray still restore.
      }
    }
  }

  private unregisterOwnedShortcuts(): void {
    for (const accelerator of this.ownedShortcuts) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        // Ignore: the accelerator may already be gone after a service restart.
      }
    }
    this.ownedShortcuts.clear()
    this.restoreAccelerator = null
  }

  async restore(): Promise<AfterglowModeStatus> {
    if (this.phase === 'inactive') {
      const window = runtime.mainWindow
      if (window && !window.isDestroyed()) {
        window.show()
        if (window.isMinimized()) window.restore()
        window.focus()
      }
      return this.getStatus()
    }
    if (this.entryCompletion) {
      // Entry unloads the UI on a timer. Wait for it to settle so restore never
      // races the teardown and creates a second main window.
      await this.entryCompletion
      if (!this.isActive()) return this.getStatus()
    }
    if (this.phase === 'restoring') return this.restoreCompletion ?? this.getStatus()

    ++this.generation
    this.phase = 'restoring'
    this.cancelLibraryControlPreview()
    this.error = null
    this.adoptCompleted = false
    this.stoppedLibraryRecovery = null
    const queueCoreStopped = this.stopQueueCore()
    const sleepShutdownFinished = this.sleepShutdown?.finish() ?? Promise.resolve()
    this.unbindWindowedAutoRestore()
    if (this.uiDestroyTimer) {
      clearTimeout(this.uiDestroyTimer)
      this.uiDestroyTimer = null
    }
    let resolveRestore!: (status: AfterglowModeStatus) => void
    const completion = new Promise<AfterglowModeStatus>((resolve) => {
      resolveRestore = resolve
    })
    this.restoreCompletion = completion
    const finish = (status: AfterglowModeStatus): AfterglowModeStatus => {
      resolveRestore(status)
      if (this.restoreCompletion === completion) this.restoreCompletion = null
      return status
    }

    try {
      await sleepShutdownFinished
    } catch (error) {
      return finish(this.failWindowRestore(String(error)))
    }

    try {
      await queueCoreStopped
      await this.transportMutationDrain
      stopAfterglowPresentation()
      const manager = runtime.audioEngineManager
      if (manager?.getQueueToken()) {
        try {
          await this.reconcilePendingLibraryMode(manager)
        } catch (error) {
          if (manager.getQueueToken()) throw error
          // Reconciliation's final native handoff can itself lose its reply.
          // Continue this explicit restore through the same stopped recovery.
        }
      }
      if (
        manager &&
        playbackSessionService.getCachedSession()?.libraryQueue &&
        !manager.getQueueToken()
      ) {
        const revision = await manager.stopForQueueRecovery()
        this.stoppedLibraryRecovery = { engine: manager, revision }
        // SQL's current snapshot is read by getRestoreState, never replayed.
        // Native authority has deliberately been retired instead of guessed.
        this.pendingLibraryMode = null
      } else {
        await playbackSessionService.flush()
        if (manager) {
          const info = await manager.getPlaybackInfo()
          await applyAfterglowEngineState(info, true)
        }
        await playbackSessionService.flush()
      }
    } catch (error) {
      if (
        this.stoppedLibraryRecovery ||
        (playbackSessionService.getCachedSession()?.libraryQueue &&
          !runtime.audioEngineManager?.getQueueToken())
      )
        return finish(
          this.failWindowRestore(error instanceof Error ? error.message : String(error))
        )
      console.warn('[afterglow] failed to persist state before restore:', error)
    }
    stopAfterglowPresentation()
    this.unregisterOwnedShortcuts()

    let window: BrowserWindow | null = null
    try {
      const { createWindow } = await import('./window.ts')
      window = createWindow({ afterglowRestore: true })
      const ready = await this.waitForWindowReady(window)
      if (!ready || window.isDestroyed()) {
        await this.destroyRestoreWindow(window)
        return finish(this.failWindowRestore('afterglow_restore_window_unavailable'))
      }
      window.show()
      window.focus()

      if (process.platform === 'win32') {
        const smtc = await import('../integrations/windowsSmtc.ts')
        smtc.rebindWindowsSmtc(window.getNativeWindowHandle())
      }
      destroyAfterglowAnchorWindow()

      await this.waitForRendererAdopt(window)
      if (!this.adoptCompleted) {
        await this.destroyRestoreWindow(window)
        return finish(this.failWindowRestore('afterglow_restore_window_timeout'))
      }
      if (window.isDestroyed()) {
        return finish(this.failWindowRestore('afterglow_restore_window_closed'))
      }
      // A minutes timer can fire while the new renderer is mounting. Keep main
      // as shutdown owner until adoption, then drain that late trigger too.
      await this.sleepShutdown?.finish()
      this.releaseSleepTimerShutdown()
      await this.setAfterglowLibraryQueueReference(null, false)
      this.rendererSnapshot = null
      this.stoppedLibraryRecovery = null
      this.queueCoreResume = null
      playbackSessionService.clearRuntimeSnapshot()
      this.windowedQueue = false
      setAfterglowEngineMapping(null)
      this.phase = 'inactive'
      this.entryMode = null
      await this.restoreAuxiliaryWindows()
      runtime.refreshTrayMenu?.(true)
      return finish(this.getStatus())
    } catch (error) {
      // Destroy before rebinding SMTC/taskbar: the closed handler would
      // otherwise tear down the anchor-bound session that failWindowRestore
      // is about to recreate.
      await this.destroyRestoreWindow(window)
      const status = this.failWindowRestore(error instanceof Error ? error.message : String(error))
      return finish(status)
    }
  }

  /**
   * Removes a main window that failed to restore without letting its `closed`
   * handler tear down the tray/SMTC surfaces that keep Afterglow controllable.
   */
  private async destroyRestoreWindow(window: BrowserWindow | null): Promise<void> {
    if (!window || window.isDestroyed()) return
    try {
      const { setMainWindowAfterglowUnloading } = await import('./window.ts')
      setMainWindowAfterglowUnloading(true)
      window.destroy()
    } catch (error) {
      console.warn('[afterglow] failed to clean up restore window:', error)
    }
  }

  private waitForWindowReady(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed()) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const cleanup = (): void => {
        settled = true
        clearTimeout(timer)
        window.removeListener('ready-to-show', handleReady)
        window.removeListener('closed', handleClosed)
      }
      const handleReady = (): void => {
        if (settled) return
        cleanup()
        resolve(true)
      }
      const handleClosed = (): void => {
        if (settled) return
        cleanup()
        resolve(false)
      }
      const timer = setTimeout(() => {
        if (settled) return
        cleanup()
        resolve(false)
      }, afterglowRestoreReadyTimeoutMs)
      timer.unref?.()
      window.once('ready-to-show', handleReady)
      window.once('closed', handleClosed)
    })
  }

  /**
   * The renderer adopts live engine state as soon as it mounts, then reports
   * completion. A bounded wait keeps a renderer that never reports from leaving
   * the service stuck in `restoring` forever.
   */
  private waitForRendererAdopt(window: BrowserWindow): Promise<void> {
    if (window.isDestroyed() || this.adoptCompleted) return Promise.resolve()
    const promise = new Promise<void>((resolve) => {
      this.resolveAdopt = resolve
    })
    this.adoptPromise = promise
    const settle = (): void => {
      this.resolveAdopt?.()
      this.resolveAdopt = null
      this.adoptPromise = null
    }
    const handleClosed = (): void => settle()
    window.once('closed', handleClosed)
    const timer = setTimeout(() => {
      if (this.adoptPromise !== promise) return
      console.warn('[afterglow] renderer did not confirm restore adoption in time')
      settle()
    }, afterglowRestoreReadyTimeoutMs)
    timer.unref?.()
    return promise.finally(() => {
      clearTimeout(timer)
      window.removeListener('closed', handleClosed)
      this.adoptPromise = null
      this.resolveAdopt = null
    })
  }

  /** Called by the recreated renderer once it has adopted the live state. */
  notifyRendererAdoptComplete(): void {
    if (this.phase !== 'restoring') return
    this.adoptCompleted = true
    this.resolveAdopt?.()
    this.resolveAdopt = null
    this.adoptPromise = null
  }

  private failWindowRestore(message: string): AfterglowModeStatus {
    this.phase = 'active'
    this.error = message
    this.registerRestoreShortcut()
    this.registerFallbackMediaKeys()
    createAfterglowAnchorWindow({
      showInTaskbar: this.entryMode === 'minimize',
      onRestore: () => {
        void restoreAfterglowMode()
      }
    })
    if (process.platform === 'win32') {
      void import('../integrations/windowsSmtc.ts').then((smtc) =>
        smtc.rebindWindowsSmtc(getAfterglowAnchorHandle())
      )
    }
    if (!this.pendingLibraryMode) startAfterglowPresentation()
    const resume = this.queueCoreResume
    const mapping = getAfterglowEngineMapping()
    const session = playbackSessionService.getCachedSession()
    if (
      !this.pendingLibraryMode &&
      (!session?.libraryQueue || runtime.audioEngineManager?.getQueueToken()) &&
      resume &&
      mapping?.length
    )
      void this.startQueueCore(
        resume.snapshot,
        mapping,
        session?.libraryQueue?.index ?? session?.queueIndex ?? mapping[0],
        resume.queueLength,
        resume.loadQueueItem
      )
    this.bindWindowedAutoRestore()
    console.warn('[afterglow] window restore failed:', message)
    return this.getStatus()
  }

  private fail(message: string): AfterglowModeStatus {
    ++this.generation
    this.rendererSnapshot = null
    this.pendingLibraryMode = null
    this.stoppedLibraryRecovery = null
    this.queueCoreResume = null
    this.releaseAfterglowLibraryQueueReference()
    playbackSessionService.clearRuntimeSnapshot()
    this.windowedQueue = false
    void this.stopQueueCore()
    this.unbindWindowedAutoRestore()
    setAfterglowEngineMapping(null)
    this.unregisterOwnedShortcuts()
    destroyAfterglowAnchorWindow()
    stopAfterglowPresentation()
    if (this.uiDestroyTimer) {
      clearTimeout(this.uiDestroyTimer)
      this.uiDestroyTimer = null
    }
    this.phase = 'inactive'
    this.entryMode = null
    this.error = message
    return this.getStatus()
  }

  private async restoreAuxiliaryWindows(): Promise<void> {
    try {
      if (this.desktopLyricsWasVisible && runtime.appSettings.desktopLyrics.enabled) {
        const { showDesktopLyrics } = await import('../integrations/desktopLyrics.ts')
        showDesktopLyrics()
      }
      if (this.miniPlayerWasOpen) {
        const { showMiniPlayer } = await import('../integrations/miniPlayer.ts')
        showMiniPlayer()
      }
    } catch (error) {
      console.warn('[afterglow] auxiliary window restore failed:', error)
    } finally {
      this.miniPlayerWasOpen = false
      this.desktopLyricsWasVisible = false
    }
  }

  async getRestoreState(): Promise<AfterglowRestoreState | null> {
    if (!this.isActive()) return null
    const read = async (): Promise<AfterglowRestoreState | null> => {
      if (!this.isActive()) return null
      if (this.phase === 'restoring') await this.sleepShutdown?.finish()
      await this.transportMutationDrain
      const recovery = this.stoppedLibraryRecovery
      if (recovery) {
        const generation = this.generation
        return buildStoppedLibraryRestoreState(
          () =>
            this.phase === 'restoring' &&
            generation === this.generation &&
            recovery.engine === runtime.audioEngineManager &&
            recovery.engine.isQueueRecoveryCurrent(recovery.revision)
        )
      }
      const manager = runtime.audioEngineManager
      const recovering = this.pendingLibraryMode !== null
      if (manager) await this.reconcilePendingLibraryMode(manager)
      if (recovering && this.phase === 'active') this.resumeQueueMaintenance()
      return buildRestoreState()
    }
    // Restore already revoked the active generation and must not wait behind
    // a cancelled provider preview still occupying the ordinary command lane.
    return this.phase === 'active' ? enqueueRendererFreeTransport(read) : read()
  }

  dispatch(command: AfterglowTransportCommand): Promise<void> {
    if (this.phase !== 'active') return Promise.resolve()
    const generation = this.generation
    const playbackIntent = [
      'play',
      'pause',
      'toggle-play',
      'stop',
      'next',
      'previous',
      'seek',
      'seek-by',
      'set-play-mode',
      'cycle-play-mode'
    ].includes(command.type)
    const suspendsContinuation =
      !!playbackSessionService.getCachedSession()?.libraryQueue && playbackIntent
    const sleepDrain = playbackIntent ? this.sleepShutdown?.cancel() : undefined
    if (
      suspendsContinuation &&
      ['play', 'pause', 'toggle-play', 'stop', 'seek', 'seek-by'].includes(command.type)
    )
      this.cancelLibraryControlPreview()
    const controlRevision = this.libraryControlRevision
    const isCurrent = () =>
      generation === this.generation &&
      this.phase === 'active' &&
      (!playbackIntent || controlRevision === this.libraryControlRevision)
    // Cancel provider previews when the user asks, not when their command
    // eventually reaches the shared lane. Already dispatched work is drained.
    const drain = suspendsContinuation ? this.stopQueueCore() : Promise.resolve()
    return dispatchRendererFreeTransport(command, {
      beforeTransport: () => Promise.all([drain, sleepDrain]).then(() => {}),
      isCurrent,
      navigateLibrary: (direction, engine) =>
        this.navigateLibraryQueue(direction, engine, generation, controlRevision),
      changeLibraryMode: (mode, engine) =>
        this.controlLibraryQueue(engine, generation, controlRevision, (options) => {
          const modes = rendererFreePlayModes()
          const previous = playbackSessionService.getCachedSession()?.playMode ?? 'sequential'
          const next = mode ?? modes[(modes.indexOf(previous) + 1) % modes.length] ?? 'sequential'
          return changeAfterglowLibraryMode(next, options)
        })
    })
      .catch((error) => {
        if (isCurrent()) this.error = error instanceof Error ? error.message : String(error)
        if (isCurrent()) console.warn('[afterglow] renderer-free command failed:', error)
      })
      .finally(() => {
        if (
          suspendsContinuation &&
          !['next', 'previous', 'set-play-mode', 'cycle-play-mode'].includes(command.type) &&
          isCurrent()
        )
          this.resumeQueueMaintenance()
      })
  }

  private async navigateLibraryQueue(
    direction: 1 | -1,
    engine: NonNullable<typeof runtime.audioEngineManager>,
    generation: number,
    controlRevision: number
  ): Promise<boolean> {
    return this.controlLibraryQueue(engine, generation, controlRevision, (options) =>
      navigateAfterglowLibraryQueue(direction, options)
    )
  }

  private async reconcilePendingLibraryMode(
    engine: NonNullable<typeof runtime.audioEngineManager>
  ): Promise<void> {
    if (this.libraryModeRecovery) return this.libraryModeRecovery
    const pending = this.pendingLibraryMode
    if (!pending) return
    const database = runtime.libraryDatabase?.database
    if (!database) throw new Error('afterglow_requires_library_database')
    const operation = reconcileAfterglowLibraryMode(pending, {
      engine,
      database,
      session: playbackSessionService,
      setMapping: setAfterglowEngineMapping,
      setPending: (next) => {
        this.pendingLibraryMode = next
      }
    }).then(() => {})
    this.libraryModeRecovery = operation
    const clear = () => {
      if (this.libraryModeRecovery === operation) this.libraryModeRecovery = null
    }
    void operation.then(clear, clear)
    this.transportMutationDrain = operation.catch(() => {})
    await operation
  }

  private resumeQueueMaintenance(): void {
    if (this.phase !== 'active' || this.pendingLibraryMode || this.sleepShutdown?.isActive()) return
    const engine = runtime.audioEngineManager
    const mapping = getAfterglowEngineMapping()
    const resume = this.queueCoreResume
    const session = playbackSessionService.getCachedSession()
    if (session?.libraryQueue && !engine?.getQueueToken()) return
    startAfterglowPresentation()
    if (engine?.getQueueToken() && resume && mapping?.length)
      void this.startQueueCore(
        resume.snapshot,
        mapping,
        session?.libraryQueue?.index ?? mapping[0],
        resume.queueLength,
        resume.loadQueueItem
      )
  }

  /** One control owner fences background/presentation work for both navigation
   * and logical mode/order transactions. Unknown SQL outcomes stay suspended
   * until a later command or restore can read their checkpoint. */
  private async controlLibraryQueue(
    engine: NonNullable<typeof runtime.audioEngineManager>,
    generation: number,
    controlRevision: number,
    operation: (options: AfterglowLibraryNavigation & AfterglowLibraryModeOptions) => Promise<void>
  ): Promise<boolean> {
    if (!playbackSessionService.getCachedSession()?.libraryQueue) return false
    const isCurrent = () =>
      generation === this.generation &&
      this.phase === 'active' &&
      controlRevision === this.libraryControlRevision
    await this.stopQueueCore()
    if (!isCurrent()) return true
    stopAfterglowPresentation()
    try {
      try {
        await playbackSessionService.flush()
      } catch (error) {
        // Live navigation owns the memory/SQL cursor. A session-file failure
        // must not disable transport; the forced sync below still validates
        // the actual database and native occurrence before any command.
        console.warn('[afterglow] session persistence unavailable before navigation:', error)
      }
      if (!isCurrent()) return true
      await this.reconcilePendingLibraryMode(engine)
      if (!isCurrent()) return true
      const info = await engine.getPlaybackInfo()
      if (!isCurrent()) return true
      await applyAfterglowEngineState(info, true, isCurrent)
      if (!isCurrent()) return true
      const database = runtime.libraryDatabase?.database
      if (!database) throw new Error('afterglow_requires_library_database')
      const preview = new AbortController()
      this.libraryControlPreview = preview
      try {
        await operation({
          engine,
          database,
          session: playbackSessionService,
          resolver: createAfterglowSourceResolver(),
          authorize: resolveAuthorizedAudioSource,
          isCurrent,
          previewSignal: preview.signal,
          setMapping: setAfterglowEngineMapping,
          setPending: (next) => {
            this.pendingLibraryMode = next
          },
          mutate: (operation) => {
            // Once dispatched, a control owns its whole handoff even if the next
            // user intent revokes its preview. Never release the lane mid-mutation.
            this.libraryControlPreview = null
            const mutation = operation()
            this.transportMutationDrain = mutation.catch(() => {})
            return mutation
          }
        })
      } finally {
        if (this.libraryControlPreview === preview) this.libraryControlPreview = null
      }
      if (isCurrent()) this.error = null
    } finally {
      if (isCurrent()) this.resumeQueueMaintenance()
    }
    return true
  }

  private cancelLibraryControlPreview(): void {
    this.libraryControlRevision++
    this.libraryControlPreview?.abort(new Error('afterglow_control_cancelled'))
    this.libraryControlPreview = null
  }

  handleMainWindowMinimized(): void {
    const auto = runtime.appSettings.afterglowAutoEntry
    if (auto === 'minimize' || auto === 'minimizeOrHide') void this.enter('minimize')
  }

  handleMainWindowHidden(): void {
    const auto = runtime.appSettings.afterglowAutoEntry
    if (auto === 'hide' || auto === 'minimizeOrHide') void this.enter('hide')
  }

  /** Settings panel helper: is automatic entry enabled at all? */
  autoEntryEnabled(value: AfterglowAutoEntry = runtime.appSettings.afterglowAutoEntry): boolean {
    return value !== 'off'
  }

  /**
   * `applyRuntimeSettings` re-registers every global shortcut (and unregisters
   * all first). While Afterglow is active that would remove the only keyboard
   * way back, so the service re-asserts its own registrations afterwards.
   */
  reassertShortcuts(): void {
    if (!this.isActive()) return
    // `applyRuntimeSettings` calls globalShortcut.unregisterAll(), so the set is
    // stale even though it still lists our accelerators. Clear it to force a
    // fresh registration of the restore escape hatch.
    this.ownedShortcuts.clear()
    this.restoreAccelerator = null
    this.registerRestoreShortcut()
    this.registerFallbackMediaKeys()
  }

  /** Releases everything the mode owns during application shutdown. */
  shutdown(): void {
    ++this.generation
    this.cancelLibraryControlPreview()
    void this.sleepShutdown
      ?.cancel()
      .catch((error) => console.warn('[afterglow] sleep gain reset failed:', error))
    this.releaseSleepTimerShutdown()
    this.rendererSnapshot = null
    this.pendingLibraryMode = null
    this.stoppedLibraryRecovery = null
    this.queueCoreResume = null
    this.releaseAfterglowLibraryQueueReference()
    playbackSessionService.clearRuntimeSnapshot()
    this.windowedQueue = false
    void this.stopQueueCore()
    this.unbindWindowedAutoRestore()
    setAfterglowEngineMapping(null)
    this.resolveAdopt?.()
    this.resolveAdopt = null
    this.adoptPromise = null
    this.adoptCompleted = false
    this.unregisterOwnedShortcuts()
    destroyAfterglowAnchorWindow()
    stopAfterglowPresentation()
    if (this.uiDestroyTimer) {
      clearTimeout(this.uiDestroyTimer)
      this.uiDestroyTimer = null
    }
    this.phase = 'inactive'
  }
}

const afterglowModeService = new AfterglowModeService()

export const getAfterglowModeStatus = (): AfterglowModeStatus =>
  getCoreAfterglowMode()?.getStatus() ?? afterglowModeService.getStatus()
export const isAfterglowModeActive = (): boolean =>
  getCoreAfterglowMode()?.getStatus().active ?? afterglowModeService.isActive()
export const enterAfterglowMode = (): Promise<AfterglowModeStatus> =>
  (getCoreAfterglowMode() ?? afterglowModeService).enter('manual')
export const restoreAfterglowMode = (): Promise<AfterglowModeStatus> =>
  (getCoreAfterglowMode() ?? afterglowModeService).restore()
export const getAfterglowRestoreState = (): Promise<AfterglowRestoreState | null> =>
  getCoreAfterglowMode() ? Promise.resolve(null) : afterglowModeService.getRestoreState()
export const notifyAfterglowRendererAdoptComplete = (): void => {
  if (!getCoreAfterglowMode()) afterglowModeService.notifyRendererAdoptComplete()
}
export const dispatchAfterglowTransport = (command: AfterglowTransportCommand): Promise<void> =>
  getCoreAfterglowMode()
    ? dispatchCoreAfterglowTransport(command)
    : afterglowModeService.dispatch(command)
export const handleMainWindowMinimized = (): void => {
  const core = getCoreAfterglowMode()
  if (!core) return afterglowModeService.handleMainWindowMinimized()
  if (['minimize', 'minimizeOrHide'].includes(runtime.appSettings.afterglowAutoEntry))
    void core.enter('minimize')
}
export const handleMainWindowHidden = (): void => {
  const core = getCoreAfterglowMode()
  if (!core) return afterglowModeService.handleMainWindowHidden()
  if (['hide', 'minimizeOrHide'].includes(runtime.appSettings.afterglowAutoEntry))
    void core.enter('hide')
}
export const shutdownAfterglowMode = (): void => {
  const core = getCoreAfterglowMode()
  if (core) {
    core.shutdown()
    destroyAfterglowAnchorWindow()
  } else afterglowModeService.shutdown()
}
export const reassertAfterglowShortcuts = (): void =>
  (getCoreAfterglowMode() ?? afterglowModeService).reassertShortcuts()
export const publishAfterglowRendererSnapshot = (payload: unknown): boolean | Promise<boolean> =>
  getCoreAfterglowMode() ? false : afterglowModeService.setRendererSnapshot(payload)
