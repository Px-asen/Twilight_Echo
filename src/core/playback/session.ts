import type { CoreCastService } from '../cast/service.ts'
import type { CoreAbLoopCommand, CoreAbLoopState } from '../../shared/coreAbLoop.ts'
import { DEFAULT_SOFTWARE_VOLUME } from '../../shared/audioProcessingOptions.ts'
import type { CoreSystemPlaybackAction } from '../../shared/coreSystemPlayer.ts'
import type { CoreSleepTimer } from './sleepService.ts'
import type { CastSample } from '../cast/castBackend.ts'
import type { CoreCastStart } from '../../shared/coreCast.ts'
import type {
  AudioEnginePlayResult,
  AudioEngineQueueItem,
  BpmAnalysisResult,
  PlaybackInfo,
  PlayMode
} from '../../shared/audioEngineTypes.ts'
import type { CoreCommands, CoreQueueReference } from '../../shared/coreProtocol.ts'
import type {
  LibraryQuery,
  LibraryTrackRecord,
  LibraryQueueEdit,
  LibraryQueuePlaybackWindow,
  LibraryQueueSnapshot
} from '../../shared/libraryDatabase.ts'
import { libraryQueueResumeMode } from '../../shared/libraryDatabase.ts'
import type { PlaybackResumeMode } from '../../shared/appSettings.ts'
import type { PlaybackSessionData } from '../../shared/playbackSession.ts'
import type { TrackData } from '../../shared/track.ts'
import type { NativeQueueSelection } from '../../shared/nativeQueue.ts'
import { createLibraryPlaybackController } from './libraryPlaybackController.ts'
import type { LibraryQueueApi } from './libraryQueueSource.ts'
import {
  LibraryNativeQueueMaintainer,
  type LibraryNativeQueueEngine
} from './libraryNativeQueueMaintainer.ts'
import { nativeQueueItem } from './nativeQueueMaintainer.ts'
import { authorizeNativeSource, isSourceCurrent, type SourceResolver } from './sourceResolver.ts'
import { projectCoreError, projectCorePlayback, projectCoreTrack } from '../projections.ts'
import type { CorePlaybackView, CoreTrackView } from '../../shared/coreViews.ts'
import { libraryQueueTrack } from './libraryTrack.ts'
import { toPlaybackQueueSnapshot } from './queueSnapshots.ts'
import type { LibraryQueueSeedProducer } from './libraryQueueBuild.ts'
import { importLegacyQueue } from './legacyQueueImport.ts'
import type { CoreQueueImportApi } from '../../shared/coreQueueImport.ts'
import type { LibraryPlaybackQueueReference } from '../../shared/playbackSession.ts'
import type { NamedQueueSession } from '../../shared/queueWorkspace.ts'
import type {
  QueueSessionRestoreResult,
  QueueSessionRestoreOutcome
} from '../workspace/restoration.ts'
import type { CoreQueueRestoreApi, CoreQueueRestoreCommand } from '../../shared/coreQueueRestore.ts'
import { PersonalizedQueue, type PersonalizedProviders } from './personalizedQueue.ts'
import type { CorePersonalizedStart, CorePersonalizedState } from '../../shared/corePersonalized.ts'
import { shuffleArray } from '../../shared/shuffleArray.ts'
import { HeartQueue, type HeartProviders } from './heartQueue.ts'
import { automaticPlaybackMask, type AutomaticPlaybackAllowed } from './automaticPlayback.ts'
import type { ZoneQueueFence } from '../../shared/coreZones.ts'
import type { PreparedPlaybackSource, PlaybackSourceRecovery } from './sourceRecovery.ts'
import type { SourceResources } from './sourceResources.ts'
import type {
  CoreHeartState,
  CoreLikedPlayback,
  CoreHeartQueueApi
} from '../../shared/coreHeart.ts'

interface HeartSelection {
  native: NativeQueueSelection | null
  reference: LibraryPlaybackQueueReference
  track: TrackData
}
interface LoadContext {
  selection?: { expected: { id: string; revision: number }; native: NativeQueueSelection | null }
  adopt?: () => void
  prepare?: () => void | Promise<void>
  owner?: ReturnType<typeof createLibraryPlaybackController>
  recover?: TrackData
  allowRecovery?: boolean
  prepared?: PreparedPlaybackSource
  resourcesHeld?: boolean
  automatic?: boolean
  automaticOrigin?: string
}

export interface CorePlaybackEngine extends LibraryNativeQueueEngine {
  /** An opt-in coordinated engine can revoke pending output deadlines now,
   * before this session's serialized mutation lane becomes available. */
  interrupt?(preparingOnly?: boolean): void
  start(): Promise<void>
  getAudioServiceFailure?(): string | null
  play(source: string, position?: number, requested?: () => boolean): Promise<AudioEnginePlayResult>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(position: number): Promise<void>
  seekConfirmed?(position: number): Promise<void>
  setLoopRangeConfirmed?(start: number, end: number): Promise<boolean>
  setVolume(volume: number): Promise<void>
  setPlaybackRate(rate: number): Promise<void>
  setPlayMode(mode: PlayMode): Promise<void>
  loadQueue(items: AudioEngineQueueItem[], startIndex?: number): Promise<void>
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}
export interface CoreSessionRepository {
  load(): Promise<{ revision: number; data: PlaybackSessionData<TrackData> | null } | null>
  save(
    session: PlaybackSessionData<TrackData>,
    expectedRevision: number
  ): Promise<{ revision: number }>
  clear(expectedRevision: number): Promise<{ revision: number }>
}
export interface CorePlaybackSessionOptions {
  engine: CorePlaybackEngine
  cast?: CoreCastService
  queues: LibraryQueueApi &
    CoreQueueImportApi &
    CoreHeartQueueApi & {
      restoreNamedPlaybackQueue: CoreQueueRestoreApi['restoreNamedPlaybackQueue']
      /** Desktop-only capability; embedded and legacy callers need not provide it. */
      clonePlaybackQueue?(reference: LibraryPlaybackQueueReference): Promise<LibraryQueuePlaybackWindow['queue']>
      libraryRevision(): Promise<number>
      readNeighbor(
        id: string,
        revision: number,
        index: number,
        direction: 1 | -1,
        wrap: boolean
      ): Promise<LibraryQueuePlaybackWindow['items'][number] | null>
    }
  resolver: SourceResolver
  sources?: PlaybackSourceRecovery
  resources?: SourceResources
  authorize(source: string): Promise<string>
  repository: CoreSessionRepository
  resumeMode(): PlaybackResumeMode
  legacyImportScope?: string
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
  changed(): void
  observePlayback?(track: TrackData | null, info: PlaybackInfo): void
  playbackStarted?(): void
  playbackSeeked?(info: PlaybackInfo): void
  runTransport?<T>(action: () => Promise<T>): Promise<T>
  sleepTimer?: Pick<CoreSleepTimer, 'persisted' | 'restore' | 'interrupt' | 'triggered'>
  setNativeSleepGain?(gain: number): Promise<void>
  naturalBoundary?(event: 'trackEnd' | 'queueEnd', occurredAt: number): void
  occurrenceRebound?(previous: TrackData, current: TrackData): void
  podcastPlaybackRate?(): number
  personalized?: PersonalizedProviders
  heart?: HeartProviders
  automaticPlaybackAllowed?: AutomaticPlaybackAllowed
  /** Main must terminate the audio service if Core cannot confirm silence. */
  fatal(error: Error): void
}

/** One logical SQL cursor and one bounded native window, independent of every UI client. */
export class CorePlaybackSession {
  private controller: ReturnType<typeof createLibraryPlaybackController>
  private maintainer: LibraryNativeQueueMaintainer | null = null
  private mapping: number[] = []
  private info: PlaybackInfo | null = null
  private currentTrack: TrackData | null = null
  private mode: PlayMode = 'sequential'
  private error: string | null = null
  private startupAudioError: string | null = null
  private intent = 0
  private preview = new AbortController()
  private mutation: Promise<unknown> = Promise.resolve()
  private observed: { info: PlaybackInfo; token: string } | null = null
  private observing: Promise<void> | null = null
  private initialized = false
  private restored = false
  private uncertain = false
  private revision = 0
  private lastSavedAt = 0
  private persistence: Promise<void> = Promise.resolve()
  private scheduledSave: Promise<void> | null = null
  private stopped = false
  private committing = false
  private recoveringAudio = false
  private sourceBarrier: Promise<void> | null = null
  private castBoundaryRevision: number | null = null
  private sleepReset: Promise<void> = Promise.resolve()
  private castSleepVolume: number | null = null
  private abLoop: CoreAbLoopState = {
    revision: 0,
    occurrenceId: null,
    a: null,
    b: null,
    mode: 'off'
  }
  private muted = false
  private lastAudibleVolume = DEFAULT_SOFTWARE_VOLUME
  private loadingIntent: number | null = null
  private requestedState: 'playing' | 'paused' | 'stopped' | null = null
  private modeControls: Promise<void> = Promise.resolve()
  private streamBuffering = false
  private streamUnderruns = 0
  private stopBufferingTimer: (() => void) | null = null
  private readonly personalized: PersonalizedQueue | null
  private readonly heart: HeartQueue | null
  private heartBase: ReturnType<typeof createLibraryPlaybackController> | null = null
  private detachedHeartTrack = false
  private heartTransition = false
  private automaticEnd: string | null = null
  private readonly listen = (info: PlaybackInfo) => {
    if (this.outputClaim) return
    if (this.options.cast?.active()) return
    this.observed = { info, token: info.queueToken ?? this.options.engine.getQueueToken() }
    this.drainObservation()
  }
  private readonly crash = (event: { reason?: string }) => {
    this.revoke()
    this.resetAbLoopState()
    this.uncertain = true
    this.error = event?.reason ?? 'Audio service exited; playback remains stopped'
    if (this.options.cast?.active()) {
      void this.commit(() => this.failStopped(new Error(this.error!))).catch(() => {})
    }
    if (this.info) this.info = { ...this.info, state: 'stopped' }
    this.publish()
  }
  private readonly audioReady = (event: { outputRouteSynced?: boolean }) => {
    if (!event?.outputRouteSynced || !this.startupAudioError) return
    if (this.error === this.startupAudioError) {
      this.error = null
      this.uncertain = false
    }
    this.startupAudioError = null
    this.publish()
  }
  private readonly options: CorePlaybackSessionOptions
  private outputClaim: { id: string; silence(): Promise<void> } | null = null
  assertIndependent(): void {
    if (this.outputClaim) throw Object.assign(new Error('此输出已加入同步组；请使用组控制或先解除编组'), { code: 'BUSY' })
  }
  /** The registry owns the lease. Pause drains the independent session's pending
   * work before physical audio may be driven by the single shared session. */
  async claimOutput(id: string, silence: () => Promise<void>): Promise<void> {
    if (this.outputClaim?.id === id) { this.outputClaim.silence = silence; return }
    this.assertIndependent()
    const pausing = this.pause()
    this.outputClaim = { id, silence }
    await pausing // An unconfirmed stop retains the lease until explicit recovery.
    this.restored = true; this.observed = null
    this.publish()
  }
  releaseOutput(id: string): void {
    if (this.outputClaim?.id !== id) return
    this.outputClaim = null; this.restored = true; this.observed = null
    if (this.info) this.info = { ...this.info, state: 'paused', nativePlaybackActive: false }
    this.publish()
  }
  constructor(options: CorePlaybackSessionOptions) {
    this.options = options
    this.controller = createLibraryPlaybackController(options.queues)
    this.personalized = options.personalized
      ? new PersonalizedQueue({
          ...options.personalized,
          automaticPlaybackAllowed: options.automaticPlaybackAllowed,
          queue: () => {
            const queue = this.controller.snapshot.value
            return queue
              ? {
                  id: queue.id,
                  revision: queue.revision,
                  total: queue.total,
                  index: queue.index,
                  occurrenceId: queue.selectedEntryId
                }
              : null
          },
          append: (id, tracks, current) => this.extendPersonalized(id, tracks, current),
          now: options.now,
          changed: () => this.publish()
        })
      : null
    this.heart = options.heart
      ? new HeartQueue({
          ...options.heart,
          automaticPlaybackAllowed: options.automaticPlaybackAllowed,
          queue: () => this.queueReference(),
          track: () => this.currentTrack,
          append: (id, tracks, current) => this.extendPersonalized(id, tracks, current),
          now: options.now,
          changed: () => this.publish()
        })
      : null
  }
  private queueReference(): CoreQueueReference | null {
    const queue = this.controller.snapshot.value
    return queue
      ? {
          id: queue.id,
          revision: queue.revision,
          total: queue.total,
          index: queue.index,
          occurrenceId: queue.selectedEntryId,
          canUndo: queue.canUndo ?? false,
          undoLabel: queue.undoLabel ?? null
        }
      : null
  }
  private publish(): void {
    this.observeStreamBuffering()
    const awake = !this.options.sleepTimer?.triggered()
    this.personalized?.observe(
      awake && !this.uncertain && !this.restored && this.info?.state === 'playing'
    )
    this.heart?.observe(
      awake &&
        !this.heartTransition &&
        !this.uncertain &&
        !this.restored &&
        this.info?.state === 'playing'
    )
    if (this.info)
      this.options.observePlayback?.(this.currentTrack, { ...this.info, playMode: this.mode })
    this.options.changed()
  }
  private resetStreamBuffering(): void {
    this.stopBufferingTimer?.()
    this.stopBufferingTimer = null
    this.streamBuffering = false
    this.streamUnderruns = 0
  }
  private observeStreamBuffering(): void {
    const track = this.currentTrack,
      info = this.info
    if (
      !track ||
      !info ||
      this.options.cast?.active() ||
      this.restored ||
      this.uncertain ||
      (track.source !== 'radio' &&
        track.source !== 'podcast' &&
        !/^https?:\/\//i.test(track.filePath || '') &&
        !/^https?:\/\//i.test(track.streamUrl || ''))
    ) {
      this.resetStreamBuffering()
      return
    }
    const underruns = Number(
      info.diagnostics?.sessionUnderrunCount ??
        info.outputInfo?.diagnostics?.sessionUnderrunCount ??
        0
    )
    if (info.state !== 'playing' || (this.requestedState && this.requestedState !== 'playing')) {
      this.resetStreamBuffering()
    } else if (underruns > this.streamUnderruns) {
      this.streamBuffering = true
      this.stopBufferingTimer?.()
      this.stopBufferingTimer = this.options.schedule(() => {
        this.stopBufferingTimer = null
        this.streamBuffering = false
        this.publish()
      }, 1500)
    }
    if (Number.isFinite(underruns) && underruns >= 0) this.streamUnderruns = underruns
  }

  /** Metadata publication never reloads native playback or changes its occurrence. */
  applyBpm(track: TrackData, analysis: BpmAnalysisResult): void {
    const current = this.currentTrack
    if (current && current.filePath === track.filePath) {
      this.currentTrack = { ...current, bpmAnalysis: analysis }
      this.publish()
    }
  }

  clearBpm(): void {
    if (this.currentTrack?.bpmAnalysis) {
      this.currentTrack = { ...this.currentTrack, bpmAnalysis: undefined }
      this.publish()
    }
  }
  private acceptCast(sample: CastSample, source = this.info?.source ?? ''): void {
    if (!this.info) return
    this.info = {
      ...this.info,
      ...sample,
      source,
      playbackRate: 1,
      duration: sample.duration || this.currentTrack?.duration || 0,
      volume: this.castSleepVolume ?? sample.volume ?? this.info.volume,
      queueIndex: this.controller.reference()?.index ?? 0,
      queueToken: undefined,
      queueRevision: undefined,
      naturalBoundaries: this.info.naturalBoundaries ?? {
        trackSerial: 0,
        queueSerial: 0,
        trackTimeMs: 0,
        queueTimeMs: 0
      },
      upcomingQueueIndex: -1,
      upcomingTrack: null,
      nativePlaybackActive: false,
      outputBackend: 'cast',
      codec: '',
      bitrate: 0,
      sourceSampleRate: 0,
      sourceChannels: 0,
      sourceBitDepth: 0,
      decodedSampleRate: 0,
      decodedBitDepth: 0,
      decodedChannels: 0,
      decodedSampleFormat: '',
      actualSampleRate: 0,
      actualBitDepth: 0,
      actualChannels: 0,
      outputPerfect: false,
      sourceExact: false,
      pcmPassthrough: false,
      gaplessActive: false,
      preloadReady: false,
      crossfadeActive: false,
      crossfadeSeconds: 0,
      isDsd: false,
      dsdMode: '',
      dsdRate: 0
    }
  }
  async startCast(command: CoreCastStart, signal?: AbortSignal): Promise<void> {
    const cast = this.options.cast
    if (!cast) throw new Error('Cast runtime unavailable')
    cast.assertDevice(command.deviceId, command.revision)
    this.assertReference(command.queue)
    if (this.controller.reference()?.entryId !== command.queue.occurrenceId)
      throw Object.assign(new Error('Cast occurrence changed'), { code: 'STALE_REVISION' })
    if (this.currentTrack) cast.assertTrack(this.currentTrack)
    const intent = this.beginPreparation()
    let position = 0
    try {
      await this.transport(async () => {
        this.guard(intent, signal)
        await this.nativeSelection()
        this.assertReference(command.queue)
        if (!this.currentTrack || this.currentTrack.queueEntryId !== command.queue.occurrenceId)
          throw Object.assign(new Error('Cast occurrence changed'), { code: 'STALE_REVISION' })
        cast.assertTrack(this.currentTrack)
        cast.assertDevice(command.deviceId, command.revision)
        if (cast.state().phase === 'ready') this.acceptCast(await cast.read())
        position = this.info?.position ?? 0
        await this.clearAbLoop()
        // Silence the local output before the first remote LOAD. There is never
        // a nativeStarted surrogate for a remote receiver.
        await this.options.engine.stop()
        if ((await this.options.engine.getPlaybackInfo()).state !== 'stopped')
          throw new Error('Native Stop was not acknowledged')
        this.guard(intent, signal)
        await cast.select(command.deviceId, command.revision)
        this.restored = true
        if (this.info) this.info = { ...this.info, state: 'paused', nativePlaybackActive: false }
        this.publish()
      })
      const base = this.controller.window.value!
      await this.load(
        this.detachedHeartTrack ? this.detachedWindow(base) : base,
        intent,
        true,
        position,
        signal
      )
    } catch (error) {
      if (intent === this.intent && !this.uncertain) {
        await this.commit(() => this.failStopped(error))
        this.publish()
      }
      throw error
    } finally {
      this.finishPreparation(intent)
    }
  }
  async endCast(revision: number): Promise<void> {
    const cast = this.options.cast
    if (!cast) throw new Error('Cast runtime unavailable')
    cast.assertRevision(revision)
    const intent = this.revoke()
    await this.transport(async () => {
      this.guard(intent)
      try {
        if (cast.state().phase === 'ready') this.acceptCast(await cast.read())
        const position = this.info?.position ?? 0
        await this.clearAbLoop()
        await cast.end()
        this.restored = true
        this.uncertain = false
        this.info = {
          ...(await this.options.engine.getPlaybackInfo()),
          state: 'paused',
          position,
          duration: this.currentTrack?.duration ?? 0,
          nativePlaybackActive: false
        }
      } catch (error) {
        await this.failStopped(error)
        throw error
      } finally {
        this.publish()
      }
    })
    await this.flush()
  }
  observeCast(sample: CastSample, revision: number): void {
    const intent = this.intent
    void this.commit(async () => {
      if (
        this.stopped ||
        intent !== this.intent ||
        !this.options.cast?.active() ||
        this.uncertain ||
        this.restored ||
        revision !== this.options.cast.state().revision
      )
        return false
      const previous = this.info
      const duration = sample.duration || this.currentTrack?.duration || 0
      const ended =
        sample.ended &&
        previous?.state === 'playing' &&
        duration > 0 &&
        Math.max(sample.position, previous.position) >= duration - 2
      const loopAtEnd =
        ended &&
        this.abLoop.mode === 'soft' &&
        this.abLoop.b !== null &&
        duration + 0.02 >= this.abLoop.b
      this.acceptCast(
        ended
          ? { ...sample, position: duration, ...(loopAtEnd ? { state: 'playing' as const } : {}) }
          : sample
      )
      if (await this.enforceAbLoop(intent)) {
        this.publish()
        return false
      }
      if (ended && this.castBoundaryRevision !== revision && this.info) {
        const boundaries = this.info.naturalBoundaries!
        this.info.naturalBoundaries = {
          ...boundaries,
          trackSerial: boundaries.trackSerial + 1,
          trackTimeMs: this.options.now()
        }
        this.options.naturalBoundary?.('trackEnd', this.options.now())
        const queue = this.queueReference()
        if (queue && queue.index === queue.total - 1 && this.mode !== 'repeat')
          this.options.naturalBoundary?.('queueEnd', this.options.now())
      }
      this.publish()
      if (this.options.now() - this.lastSavedAt >= 5000) this.scheduleSave()
      if (ended && this.castBoundaryRevision !== revision) {
        this.castBoundaryRevision = revision
        return true
      }
      return false
    })
      .then(async (advance) => {
        if (advance && intent === this.intent) await this.advanceCast()
      })
      .catch((error) => {
        if (intent === this.intent) this.castFailed(error, revision)
      })
  }
  castFailed(error: Error, revision: number): void {
    const intent = this.intent
    void this.commit(async () => {
      if (
        this.stopped ||
        intent !== this.intent ||
        !this.options.cast?.active() ||
        revision !== this.options.cast.state().revision
      )
        return
      this.revoke()
      await this.failStopped(error)
      this.publish()
    }).catch(() => {}) // failStopped already reports an unconfirmed Stop to main.
  }
  private async advanceCast(): Promise<void> {
    if (this.automaticQueue()) return this.navigateAutomatic(1, undefined, true)
    const intent = this.beginPreparation(),
      signal = this.preview.signal
    try {
      let reference = this.controller.reference()
      if (!reference) return
      if (this.mode === 'repeat' && this.currentTrack) {
        const base = this.controller.window.value!
        return await this.load(
          this.detachedHeartTrack ? this.detachedWindow(base) : base,
          intent,
          true,
          0,
          signal
        )
      }
      const next = () =>
        this.detachedHeartTrack
          ? this.options.queues
              .readQueue(reference!.id, 0, 1, { expectedRevision: reference!.revision })
              .then((page) => page.items[0] ?? null)
          : this.options.queues.readNeighbor(
              reference!.id,
              reference!.revision,
              reference!.index,
              1,
              this.mode === 'listLoop' || this.mode === 'shuffle'
            )
      let target = await next()
      if (!target && (this.personalized?.state() || this.heart?.state().active)) {
        await (this.personalized?.state() ? this.personalized.refill() : this.heart!.refill())
        this.guard(intent, signal)
        reference = this.controller.reference()!
        target = await next()
      }
      this.guard(intent, signal)
      if (target?.track)
        return await this.load(this.targetWindow(target), intent, true, 0, signal, {
          selection: { expected: reference, native: null }
        })
      await this.stop()
    } catch (error) {
      if (intent === this.intent && !this.uncertain) {
        await this.commit(() => this.failStopped(error))
        this.publish()
      }
    } finally {
      this.finishPreparation(intent)
    }
  }
  async initialize(): Promise<void> {
    try {
      await this.options.engine.start()
    } catch (error) {
      if ((error as { code?: string })?.code !== 'AUDIO_SERVICE_UNAVAILABLE') throw error
      this.startupAudioError = errorText(error)
      this.error = this.startupAudioError
      this.uncertain = true
    }
    this.info = await this.options.engine.getPlaybackInfo()
    if (this.info.volume > 0) this.lastAudibleVolume = this.info.volume
    const saved = await this.options.repository.load()
    this.revision = saved?.revision ?? 0
    if (saved?.data && this.options.resumeMode() !== 'off') {
      try {
      const session = saved.data
      this.options.sleepTimer?.restore(session.sleepTimer)
      let position = session.position
      this.mode = session.playMode ?? 'sequential'
      if (session.libraryQueue) {
        let window: LibraryQueuePlaybackWindow | null
        if (session.detachedHeartTrack && session.heart && this.heart) {
          const queue = await this.options.queues.getQueue(session.libraryQueue.id)
          window = await this.controller.adoptStopped(
            {
              id: queue.id,
              revision: queue.revision,
              index: queue.index,
              entryId: queue.selectedEntryId!
            },
            libraryQueueResumeMode(queue, this.mode),
            () => !this.stopped
          )
          await this.updateTrack(session.track)
        } else {
          window = await this.controller.restore(
            session.libraryQueue,
            this.mode,
            () => !this.stopped
          )
          await this.updateTrack(this.controller.track(window))
        }
        if (window) this.mode = libraryQueueResumeMode(window.queue, this.mode)
      } else {
        const imported = await importLegacyQueue({
          api: this.options.queues,
          session,
          sessionRevision: this.revision,
          libraryRevision: await this.options.queues.libraryRevision(),
          scope: this.options.legacyImportScope
        })
        position = imported.position
        const queue = imported.queue
        const window = await this.controller.restore(
          {
            id: queue.id,
            revision: queue.revision,
            index: queue.index,
            entryId: queue.selectedEntryId!
          },
          this.mode,
          () => !this.stopped,
          true
        )
        await this.updateTrack(this.controller.track(window))
      }
      if (this.currentTrack) {
        if (
          session.heart &&
          session.heart.queueId === this.controller.reference()?.id &&
          this.heart
        ) {
          if (session.heart.baseQueue) {
            const base = createLibraryPlaybackController(this.options.queues)
            try {
              const queue = await this.options.queues.getQueue(session.heart.baseQueue.id)
              const window = await base.adoptStopped(
                {
                  id: queue.id,
                  revision: queue.revision,
                  index: queue.index,
                  entryId: queue.selectedEntryId!
                },
                libraryQueueResumeMode(queue, 'sequential'),
                () => !this.stopped
              )
              if (!window) throw new Error('Heart base queue is unavailable')
              this.heartBase = base
              this.mode = 'heart'
            } catch (error) {
              base.dispose()
              throw error
            }
          }
          this.heart.attach(session.heart)
          if (session.detachedHeartTrack) {
            this.detachedHeartTrack = true
            await this.updateTrack(session.track)
          }
        }
        if (
          session.personalizedStream &&
          session.personalizedStream.queueId === this.controller.reference()?.id
        )
          this.personalized?.attach(session.personalizedStream)
        this.restored = true
        this.info = {
          ...this.info,
          state: 'paused',
          position: this.options.resumeMode() === 'trackAndPosition' ? position : 0,
          duration: this.currentTrack.duration
        }
      }
      } catch (error) {
        this.controller.dispose()
        this.controller = createLibraryPlaybackController(this.options.queues)
        this.clearHeart()
        this.personalized?.stop()
        await this.updateTrack(null)
        this.currentTrack = null
        this.restored = false
        this.detachedHeartTrack = false
        this.heartBase = null
        this.mode = 'sequential'
        this.error = errorText(error)
      }
    }
    this.initialized = true
    this.options.engine.on('playback-info', this.listen)
    this.options.engine.on('playback-sample', this.listen)
    this.options.engine.on('audio-service-crash', this.crash)
    this.options.engine.on('audio-service-ready', this.audioReady)
    if (this.startupAudioError && this.info)
      this.info = { ...this.info, state: 'stopped', nativePlaybackActive: false }
    if (this.startupAudioError && this.options.engine.getAudioServiceFailure?.() === null)
      this.audioReady({ outputRouteSynced: true })
    if (saved?.data && !saved.data.libraryQueue && this.currentTrack) {
      // Publish the reference before ready. Old versioned files/backups remain
      // available; a failed save retries via the completed import's read path.
      await this.flush()
    }
    this.publish()
  }
  snapshot(): {
    playback: CorePlaybackView | null
    track: CoreTrackView | null
    queue: CoreQueueReference | null
    error: string | null
    personalized: CorePersonalizedState | null
    heart: CoreHeartState | null
    abLoop: CoreAbLoopState
    mute: { muted: boolean; userVolume: number; lastAudibleVolume: number }
    loading: boolean
    isStreamBuffering: boolean
  } {
    const queue = this.controller.snapshot.value
    return {
      abLoop: { ...this.abLoop },
      loading: this.loadingIntent !== null,
      isStreamBuffering: this.streamBuffering,
      mute: {
        muted: this.muted,
        userVolume: this.info?.volume ?? 0,
        lastAudibleVolume: this.lastAudibleVolume
      },
      playback: this.info ? projectCorePlayback({ ...this.info, playMode: this.mode }) : null,
      // Transient URLs/authorization belong to the resolver, never the public snapshot.
      track: this.currentTrack
        ? projectCoreTrack(this.currentTrack, this.currentTrack.queueEntryId)
        : null,
      queue: queue
        ? {
            id: queue.id,
            revision: queue.revision,
            total: queue.total,
            index: queue.index,
            occurrenceId: queue.selectedEntryId,
            canUndo: queue.canUndo ?? false,
            undoLabel: queue.undoLabel ?? null
          }
        : null,
      error: this.error ? projectCoreError(this.error) : null,
      personalized: this.personalized?.state() ?? null,
      heart: this.heart
        ? { ...this.heart.state(), ...(this.detachedHeartTrack ? { available: false } : {}) }
        : null
    }
  }
  private drainObservation(): void {
    if (this.observing || this.stopped || this.committing) return
    if (!this.observed) return
    // Observations, SQL cursor edits and native handoffs have one owner/lane.
    // Consume only the latest sample once per turn so transport can cut in.
    let advance = false
    const intent = this.intent
    this.observing = this.commit(async () => {
      const intent = this.intent
      const observed = this.observed
      this.observed = null
      if (
        !observed ||
        this.options.cast?.active() ||
        this.restored ||
        this.uncertain ||
        observed.token !== this.options.engine.getQueueToken()
      )
        return
      const info = await this.options.engine.getPlaybackInfo()
      await this.acceptNative(info)
      if (observed.token !== this.options.engine.getQueueToken()) return
      this.info = info
      const looped = await this.enforceAbLoop(intent)
      const end = this.options.engine.getPlaybackEnd()
      if (
        !looped &&
        this.automaticQueue() &&
        info.state === 'stopped' &&
        end &&
        !this.options.sleepTimer?.triggered()
      ) {
        const key = `${end.intent}:${end.selection.queueToken}:${end.selection.index}`
        if (this.automaticEnd !== key) {
          this.automaticEnd = key
          advance = true
        }
      }
      this.publish()
      if (this.options.now() - this.lastSavedAt >= 5000) this.scheduleSave()
      void this.maintainer?.tick()
    })
      .then(async () => {
        if (advance && intent === this.intent) await this.navigateAutomatic(1, undefined, true)
      })
      .catch(async (error) => {
        this.revoke()
        try {
          await this.commit(() => this.failStopped(error))
        } catch (fatal) {
          this.error = errorText(fatal)
        } // failStopped already notified the supervisor.
        this.publish()
      })
      .finally(() => {
        this.observing = null
        if (this.observed) this.drainObservation()
      })
  }
  private async acceptNative(info: PlaybackInfo): Promise<void> {
    const entry = this.options.engine.getQueueSnapshot()[info.queueIndex]
    const index = this.mapping[info.queueIndex]
    const reference = this.controller.reference()
    if (!reference || !entry?.queueEntryId || index === undefined || info.source !== entry.source)
      return
    if (this.detachedHeartTrack && entry.queueEntryId === this.currentTrack?.queueEntryId) return
    if (this.detachedHeartTrack) {
      const window = await this.controller.selectEntry(entry.queueEntryId, reference, this.mode)
      if (!window || window.queue.index !== index) throw new Error('Heart exit successor changed')
      this.detachedHeartTrack = false
      await this.updateTrack(this.controller.track(window))
      return
    }
    if (reference.entryId !== entry.queueEntryId) {
      const result = await this.controller.acceptNative(entry.queueEntryId, reference, this.mode)
      if (!result || result.queue.index !== index)
        throw new Error('Native occurrence no longer matches the logical queue')
      const previous = this.currentTrack
      await this.updateTrack(this.controller.track(result))
      await this.applyTrackRate(previous, this.currentTrack)
    } else if (this.currentTrack?.id !== entry.id) {
      // A natural repeat can commit a new source for the same occurrence.
      const selected = this.controller.track()
      if (selected?.id !== entry.id) throw new Error('Native source identity differs from SQL')
      const previous = this.currentTrack
      await this.updateTrack(selected)
      await this.applyTrackRate(previous, selected)
    }
  }
  private interruptSleep(): void {
    const reset = this.options.sleepTimer?.interrupt()
    if (!reset) return
    this.sleepReset = Promise.all([this.sleepReset.catch(() => {}), reset]).then(() => {})
    void this.sleepReset.catch((error) => this.options.fatal(error))
  }
  private revoke(interruptSleep = true): number {
    if (interruptSleep) this.interruptSleep()
    this.intent++
    this.options.engine.interrupt?.(true)
    const wasLoading = this.loadingIntent !== null
    this.loadingIntent = null
    this.requestedState = null
    this.preview.abort(new Error('Playback intent superseded'))
    this.preview = new AbortController()
    this.options.cast?.cancelPending()
    // stop() aborts provider previews immediately and drains dispatched mutations.
    const drain = this.maintainer?.stop()
    this.maintainer = null
    if (drain) this.mutation = Promise.all([this.mutation.catch(() => {}), drain])
    if (wasLoading) this.publish()
    return this.intent
  }
  private beginPreparation(play = true): number {
    this.assertAudioAvailable()
    const intent = this.revoke()
    this.loadingIntent = intent
    this.requestedState = play ? 'playing' : 'paused'
    this.publish()
    return intent
  }
  private finishPreparation(intent: number): void {
    if (intent !== this.intent) return
    this.loadingIntent = null
    this.requestedState = null
    this.publish()
  }
  private commit<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(async () => {
      await this.sleepReset
      this.committing = true
      try {
        return await operation()
      } finally {
        this.committing = false
        this.drainObservation()
      }
    })
    this.mutation = result.catch(() => {})
    return result
  }
  private guard(intent: number, signal?: AbortSignal): void {
    if (this.stopped || intent !== this.intent || signal?.aborted)
      throw Object.assign(new Error('Playback request superseded'), { code: 'CANCELLED' })
  }
  private transport<T>(action: () => Promise<T>): Promise<T> {
    this.assertIndependent()
    if (this.recoveringAudio) return Promise.reject(audioRecoveryInProgress())
    return this.commit(() =>
      this.options.runTransport ? this.options.runTransport(action) : action()
    )
  }
  private async resolve(window: LibraryQueuePlaybackWindow, intent: number, signal?: AbortSignal) {
    this.guard(intent, signal)
    const entry = window.items[0]
    const track = entry?.track ? libraryQueueTrack(entry.track, entry.queueEntryId) : null
    if (!track) throw new Error('Selected queue occurrence is not playable')
    const current = signal ? AbortSignal.any([this.preview.signal, signal]) : this.preview.signal
    let prepared: PreparedPlaybackSource
    try {
      prepared = await this.prepareSource(track, current)
    } catch (error) {
      this.guard(intent, signal)
      throw error
    }
    this.guard(intent, signal)
    return prepared
  }
  private async prepareSource(
    track: TrackData,
    signal?: AbortSignal
  ): Promise<PreparedPlaybackSource> {
    if (this.options.sources) return this.options.sources.prepare(track, signal)
    const resolved = await this.options.resolver.resolve(track, signal)
    signal?.throwIfAborted()
    if (!resolved) throw new Error('Unable to resolve the selected audio source')
    const source = await authorizeNativeSource(resolved.source, this.options.authorize)
    signal?.throwIfAborted()
    if (!isSourceCurrent(resolved, this.options.now()))
      throw new Error('Audio source expired before playback')
    return { track, resolved: { ...resolved, source } }
  }
  /** The native commit lane owns this write and the controller cache adoption.
   * No provider IO or recursive controller command is allowed in this stage. */
  private async repairSource(
    owner: ReturnType<typeof createLibraryPlaybackController>,
    window: LibraryQueuePlaybackWindow,
    occurrenceId: string,
    prepared: PreparedPlaybackSource
  ): Promise<void> {
    prepared.confirm?.()
    const row = window.items.find((item) => item.queueEntryId === occurrenceId)
    if (!row?.track) throw new Error('Source repair occurrence is unavailable')
    if (row.track.id === prepared.track.id) return
    const queue = owner.diagnostics.queue
    if (
      !queue?.selectedEntryId ||
      queue.id !== window.queue.id ||
      queue.revision !== window.queue.revision
    )
      throw new Error('Playback queue changed during source preparation')
    const previous = libraryQueueTrack(row.track, occurrenceId)
    const snapshot = { ...toPlaybackQueueSnapshot(prepared.track) }
    if (
      this.detachedHeartTrack &&
      window.queue.index === -1 &&
      occurrenceId === this.currentTrack?.queueEntryId
    ) {
      // Heart exit owns this finishing occurrence in the durable session, not
      // as a row in the restored base queue. Never replace a base membership.
      window.items = window.items.map((item) =>
        item === row ? { ...item, track: snapshot } : item
      )
      await this.options.sources?.repaired?.(previous, prepared.track)
      return
    }
    const repaired = await owner.replaceSource(
      {
        queue: {
          id: queue.id,
          revision: queue.revision,
          index: queue.index,
          entryId: queue.selectedEntryId
        },
        contentRevision: window.libraryRevision,
        occurrenceId,
        expectedTrackId: previous.id,
        replacement: {
          id: snapshot.id,
          ...(snapshot.source === 'local' ? { localSnapshot: snapshot } : { snapshot })
        }
      },
      this.mode
    )
    window.queue = { ...window.queue, revision: repaired.queue.revision }
    window.items = window.items.map((item) => (item === row ? { ...item, track: snapshot } : item))
    await this.options.sources?.repaired?.(previous, prepared.track)
  }
  private async load(
    window: LibraryQueuePlaybackWindow,
    intent: number,
    play: boolean,
    position = 0,
    signal?: AbortSignal,
    context: LoadContext = {}
  ): Promise<void> {
    this.guard(intent, signal)
    this.loadingIntent = intent
    this.requestedState = play ? 'playing' : 'paused'
    this.publish()
    try {
      if (this.sourceBarrier) await this.sourceBarrier
      const run = () => {
        this.guard(intent, signal)
        return this.loadSource(window, intent, play, position, signal, context)
      }
      await (this.options.resources && !context.resourcesHeld ? this.options.resources.use(run) : run())
    } finally {
      this.finishPreparation(intent)
    }
  }
  private async loadSource(
    window: LibraryQueuePlaybackWindow,
    intent: number,
    play: boolean,
    position = 0,
    signal?: AbortSignal,
    context: LoadContext = {}
  ): Promise<void> {
    let { selection, adopt, prepare } = context
    const owner = context.owner ?? this.controller,
      staged = !!prepare
    let prepared = context.prepared ?? (context.recover
      ? await this.recoverSource(context.recover, intent, signal)
      : await this.resolve(window, intent, signal))
    for (let attempt = 0; ; attempt++) {
      const { track, resolved } = prepared
      if (context.automatic) {
        const [allowed] = await automaticPlaybackMask(
          [track],
          this.options.automaticPlaybackAllowed,
          signal
        )
        this.guard(intent, signal)
        if (!allowed) throw new AutomaticPlaybackRejected()
      }
      try {
        await this.transport(async () => {
          this.guard(intent, signal)
          if (context.automatic && selection) {
            const reference = this.controller.reference()
            if (
              reference?.id !== selection.expected.id ||
              reference.entryId !== context.automaticOrigin
            )
              throw Object.assign(new Error('Automatic playback occurrence changed'), {
                code: 'STALE_REVISION'
              })
            // A background recommendation append may finish during source IO.
            // It keeps the selected occurrence and frozen order, so rebase only
            // its revision; edits/selections revoke this playback intent.
            selection.expected = reference
            window.queue = { ...window.queue, revision: reference.revision }
          }
          if (selection) this.assertReference(selection.expected)
          if (selection?.native) await this.fenceNative(selection.native)
          this.guard(intent, signal)
          if (context.prepared) {
            prepared.confirm?.()
            if (!isSourceCurrent(resolved, this.options.now()))
              throw new Error('Audio source expired before playback')
          }
          await prepare?.()
          try {
            this.guard(intent, signal)
            prepared.confirm?.()
            if (!isSourceCurrent(resolved, this.options.now()))
              throw new Error('Audio source expired before playback')
            await this.observeDepartingTrack(track)
            await this.repairSource(owner, window, track.queueEntryId!, prepared)
            if (selection)
              selection.expected = { ...selection.expected, revision: window.queue.revision }
            this.guard(intent, signal)
            prepared.confirm?.()
            if (!isSourceCurrent(resolved, this.options.now()))
              throw new Error('Audio source expired before playback')
            await this.clearAbLoop()
            if (!this.options.cast?.active()) {
              await this.options.engine.loadQueue(
                [
                  nativeQueueItem(
                    track,
                    resolved.source,
                    window.queue.index,
                    window.queue.index === window.lastPlayablePosition
                  )
                ],
                0
              )
            }
            // A prepared candidate is never public while a provider is resolving.
            // Once LoadQueue is acknowledged (or unknown), retain its identity so
            // an immediate Pause cannot expose a cursor belonging to the old queue.
            adopt?.()
            this.mapping = [window.queue.index]
            const previousTrack = this.currentTrack
            await this.updateTrack(track)
            this.restored = false
            this.uncertain = false
            if (selection) {
              const selected = await this.controller.selectEntry(
                track.queueEntryId!,
                selection.expected,
                this.mode
              )
              if (!selected || selected.items[0]?.queueEntryId !== track.queueEntryId)
                throw new Error('SQL did not confirm the selected native occurrence')
              this.detachedHeartTrack = false
            }
            this.guard(intent, signal)
            if (this.options.cast?.active()) {
              const sample = await this.options.cast.load(
                resolved.source,
                track,
                track.source === 'radio' ? 0 : position,
                play,
                signal ? AbortSignal.any([this.preview.signal, signal]) : this.preview.signal
              )
              this.acceptCast(sample, resolved.source)
              if (play) this.options.playbackStarted?.()
            } else {
              await this.applyTrackRate(previousTrack, track)
              await this.options.engine.setPlayMode(
                this.mode === 'repeat' && !this.automaticQueue() ? 'repeat' : 'sequential'
              )
              if (play) {
                const result = await this.options.engine.play(
                  resolved.source,
                  position,
                  () =>
                    intent === this.intent &&
                    !signal?.aborted &&
                    isSourceCurrent(resolved, this.options.now())
                )
                if (!result.nativeStarted || result.superseded) throw nativeStartFailure(result)
                this.options.playbackStarted?.()
              }
              this.info = await this.options.engine.getPlaybackInfo()
            }
            this.error = null
          } catch (error) {
            // No automatic replay of a possibly committed load/play/SQL mutation.
            adopt?.()
            await this.updateTrack(track)
            await this.failStopped(error)
            throw error
          } finally {
            this.publish()
          }
        })
        break
      } catch (error) {
        this.guard(intent, signal)
        if (
          !(error instanceof NativeSourceRejected) ||
          attempt > 0 ||
          context.allowRecovery === false ||
          !this.options.sources?.recover
        )
          throw error
        // A negative native ACK plus confirmed Stop permits a new source, not
        // replay of an unknown Play/Load/SQL write. Search stays outside the lane.
        prepared = await this.recoverSource(track, intent, signal)
        const base = owner.window.value
        if (!base) throw new Error('Playback queue detached during source recovery')
        window = this.detachedHeartTrack ? this.detachedWindow(base) : base
        selection = undefined
        adopt = undefined
        prepare = undefined
      }
    }
    this.guard(intent, signal)
    if (!staged) this.startMaintenance()
    await this.flush()
  }
  private async recoverSource(track: TrackData, intent: number, signal?: AbortSignal) {
    try {
      const prepared = await this.options.sources!.recover!(
        track,
        signal ? AbortSignal.any([this.preview.signal, signal]) : this.preview.signal
      )
      this.guard(intent, signal)
      return prepared
    } catch (error) {
      this.guard(intent, signal)
      throw error
    }
  }
  private startMaintenance(): void {
    if (this.outputClaim) return
    if (this.options.sleepTimer?.triggered()) return
    if (this.options.cast?.active()) {
      this.options.cast.resumeSampling()
      return
    }
    // Recommendations stay in a one-item native window. A preloaded successor
    // could start after a new ban without giving Core a preference-read boundary.
    if (this.automaticQueue()) return
    if (
      !this.controller.reference() ||
      this.uncertain ||
      this.restored ||
      this.sourceBarrier ||
      this.maintainer?.isActive()
    )
      return
    const intent = this.intent
    this.maintainer = new LibraryNativeQueueMaintainer({
      engine: this.options.engine,
      resources: this.options.resources,
      nativeQueueIndices: this.mapping,
      resolver: this.options.resolver,
      authorize: this.options.authorize,
      prepareSource: (track, signal) => this.prepareSource(track, signal),
      commitSource: async ({ window }, occurrenceId, prepared) => {
        await this.repairSource(this.controller, window, occurrenceId, prepared)
      },
      onCommitError: (error) => this.failStopped(error),
      now: this.options.now,
      readWindow: (_index, entryId, current) =>
        this.commit(async () => {
          if (!current() || intent !== this.intent) return null
          const reference = this.controller.reference()
          if (this.detachedHeartTrack) {
            if (entryId === this.currentTrack?.queueEntryId)
              return { window: this.detachedWindow(this.controller.window.value!), mode: this.mode }
            if (!reference) return null
            const selected = await this.controller.selectEntry(entryId, reference, this.mode)
            if (!selected || !current()) return null
            this.detachedHeartTrack = false
            await this.updateTrack(this.controller.track(selected))
          } else if (reference?.entryId !== entryId && reference) {
            const changed = await this.controller.acceptNative(entryId, reference, this.mode)
            if (!changed || !current()) return null
            await this.updateTrack(this.controller.track(changed))
          }
          const window = this.currentTrack
            ? await this.controller.playbackWindow(this.currentTrack, this.mode)
            : null
          return window && current()
            ? { window, mode: this.mode === 'heart' ? 'sequential' : this.mode }
            : null
        }),
      allowDetachedCurrent: () => this.detachedHeartTrack,
      mayContinueAfterEnd: () => !this.options.sleepTimer?.triggered(),
      validateWindow: async ({ window }) => {
        const queue = await this.options.queues.getQueue(window.queue.id)
        const expected = this.detachedHeartTrack
          ? this.controller.window.value!.queue
          : window.queue
        return (
          queue.revision === expected.revision &&
          queue.index === expected.index &&
          queue.selectedEntryId === expected.selectedEntryId
        )
      },
      commit: (operation, current) =>
        this.commit(async () => {
          if (current() && intent === this.intent) await operation()
        }),
      onMappingChanged: (mapping) => {
        this.mapping = mapping
      },
      onPlaybackAdvanced: async (info, _index, occurrenceId, prepared) => {
        if (this.detachedHeartTrack && prepared && occurrenceId === this.currentTrack?.queueEntryId)
          await this.updateTrack(prepared)
        await this.acceptNative(info)
        this.info = info
        this.publish()
        this.scheduleSave()
      },
      onError: (message) => {
        this.error = message
        this.publish()
      }
    })
    void this.maintainer.start()
  }
  async fromQuery(
    query: LibraryQuery,
    selectedId: string | undefined,
    play = true,
    signal?: AbortSignal,
    options: { position?: number; randomStart?: boolean; playMode?: PlayMode; prepareOnly?: boolean } = {}
  ): Promise<void> {
    const intent = this.beginPreparation(play)
    // Prepare on a separate candidate; do not orphan the current cursor during slow queries.
    const candidate = createLibraryPlaybackController(this.options.queues)
    let adopted = false
    try {
      const requestedMode = options.playMode ?? this.mode
      const nextMode = requestedMode === 'heart' ? 'sequential' : requestedMode
      const window = await candidate.create(query, selectedId, nextMode, options.randomStart)
      this.guard(intent, signal)
      if (!window) throw new Error('No playable queue entries')
      const previous = this.controller
      // Additional disconnected Zones may prepare a SQL queue without decoding
      // or opening a DAC. Existing fromQuery callers keep native-load semantics.
      if (options.prepareOnly) {
        if (play) throw new Error('Prepared queue cannot start playback')
        await this.transport(async () => {
          this.guard(intent, signal)
          await this.options.cast?.stop()
          await this.options.engine.pause()
          const info = await this.options.engine.getPlaybackInfo()
          if (info.state === 'playing') throw new Error('Native Pause was not acknowledged')
          await this.observeDepartingTrack(candidate.track(window))
          await this.clearAbLoop()
          this.guard(intent, signal)
          this.controller = candidate; this.clearHeart(); this.mode = nextMode
          adopted = true; previous.dispose()
          await this.updateTrack(candidate.track(window))
          this.restored = true; this.uncertain = false; this.error = null
          this.info = { ...info, state: 'paused', position: options.position ?? 0, duration: this.currentTrack?.duration ?? 0 }
          this.publish()
        })
        await this.flush()
        return
      }
      await this.load(window, intent, play, options.position ?? 0, signal, {
        adopt: () => {
          if (adopted) return
          this.controller = candidate
          this.clearHeart()
          this.mode = nextMode
          adopted = true
          previous.dispose()
        },
        owner: candidate
      })
    } finally {
      if (!adopted) candidate.dispose()
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  /** Internal source-owner entry point. Public clients submit identities, never arbitrary tracks. */
  async fromPages(
    produce: LibraryQueueSeedProducer,
    options: {
      selectedIndex?: number | (() => number)
      position?: number
      mode?: PlayMode
      play?: boolean
      guard?: () => void
      beforeAdopt?: (playing: boolean) => Promise<void>
      onAdopt?: () => void
    } = {},
    signal?: AbortSignal
  ): Promise<void> {
    const intent = this.beginPreparation(options.play !== false)
    return this.stagePages(produce, options, intent, signal)
  }
  private async stagePages(
    produce: LibraryQueueSeedProducer,
    options: {
      selectedIndex?: number | (() => number)
      position?: number
      mode?: PlayMode
      play?: boolean
      guard?: () => void
      preserveOccurrenceIds?: boolean
      order?: 'original' | 'shuffle'
      beforeAdopt?: (playing: boolean) => Promise<void>
      onAdopt?: () => void
      preparedSource?: PreparedPlaybackSource
      automatic?: boolean
    },
    intent: number,
    signal?: AbortSignal
  ): Promise<void> {
    const candidate = createLibraryPlaybackController({
      ...this.options.queues,
      ...(options.preserveOccurrenceIds
        ? {
            buildQueue: (command) =>
              this.options.queues.restoreNamedPlaybackQueue({
                ...command,
                ...(command.kind === 'begin' ? { playMode: options.mode ?? this.mode } : {})
              } as CoreQueueRestoreCommand)
          }
        : {})
    })
    const mode = options.mode ?? (this.mode === 'heart' ? 'sequential' : this.mode)
    let adopted = false
    try {
      const revision = await this.options.queues.libraryRevision()
      this.guard(intent, signal)
      const result = await candidate.stagePages(
        produce,
        {
          ...(options.preserveOccurrenceIds ? { id: `core-restore-${crypto.randomUUID()}` } : {}),
          contentRevision: revision,
          selectedIndex: options.selectedIndex,
          order: options.order ?? (mode === 'shuffle' ? 'shuffle' : 'original')
        },
        mode,
        async (window, activate, retain) => {
          const previous = this.controller
          const adopt = () => {
            if (adopted) return
            options.guard?.()
            // LoadQueue may already have committed when an intent is superseded.
            // Retain that source; no automatic playback or write replay follows.
            retain()
            activate()
            this.controller = candidate
            this.clearHeart()
            this.mode = mode
            adopted = true
            previous.dispose()
            options.onAdopt?.()
          }
          if (options.play === false) {
            await this.transport(async () => {
              this.guard(intent, signal)
              options.guard?.()
              await this.options.cast?.stop()
              await this.options.engine.pause()
              const info = await this.options.engine.getPlaybackInfo()
              if (info.state === 'playing') throw new Error('Native Pause was not acknowledged')
              await this.observeDepartingTrack(candidate.track(window))
              await options.beforeAdopt?.(false)
              await this.clearAbLoop()
              this.guard(intent, signal)
              adopt()
              await this.updateTrack(candidate.track(window))
              this.restored = true
              this.uncertain = false
              this.info = {
                ...(this.options.cast?.active() ? this.info! : info),
                state: 'paused',
                position: options.position ?? 0,
                duration: this.currentTrack?.duration ?? 0
              }
              this.error = null
              this.publish()
            })
            await this.flush()
          } else {
            await this.load(window, intent, true, options.position ?? 0, signal, {
              automatic: options.automatic,
              prepare: async () => {
                await options.beforeAdopt?.(true)
                adopt()
              },
              owner: candidate,
              ...(options.preparedSource ? {
                prepared: {
                  ...options.preparedSource,
                  track: { ...options.preparedSource.track, queueEntryId: window.items[0]?.queueEntryId }
                },
                resourcesHeld: true,
                allowRecovery: false
              } : {})
            })
          }
        },
        {
          signal,
          guard: () => {
            this.guard(intent, signal)
            options.guard?.()
          }
        }
      )
      if (!result) throw new Error('No playable queue entries')
    } finally {
      if (!adopted) candidate.dispose()
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  /** Named restore is a playback intent from the first source read onward.
   * Pause/Stop cancel slow preparation; an empty result leaves the live queue. */
  async restoreNamedSession(
    session: NamedQueueSession,
    resolveEntries: (signal: AbortSignal) => Promise<QueueSessionRestoreResult>,
    guard: () => void,
    play = false,
    signal?: AbortSignal
  ): Promise<QueueSessionRestoreOutcome> {
    const intent = this.beginPreparation(play)
    const initialReference = this.controller.reference()
    const current = () => {
      this.guard(intent, signal)
      guard()
    }
    const beforeAdopt = async (playing: boolean) => {
      const native = await this.nativeSelection()
      current()
      const reference = this.controller.reference()
      if (
        reference?.id !== initialReference?.id ||
        reference?.revision !== initialReference?.revision ||
        reference?.entryId !== initialReference?.entryId
      )
        throw Object.assign(new Error('队列选中项已变化，已取消恢复'), { code: 'STALE_REVISION' })
      if (playing && native) await this.fenceNative(native)
      current()
    }
    try {
      current()
      if (!session.libraryQueue) {
        const result = await resolveEntries(
          signal ? AbortSignal.any([signal, this.preview.signal]) : this.preview.signal
        )
        current()
        if (!result.queue.length) throw new Error('会话中的资源均不可用，当前队列未改变')
        const originalPositions = new Map(
          result.original.map((track, index) => [track.queueEntryId!, index])
        )
        await this.stagePages(
          async (append) => {
            for (let offset = 0; offset < result.queue.length; offset += 200) {
              current()
              await append(
                result.queue.slice(offset, offset + 200).map((track) => {
                  const snapshot: LibraryTrackRecord = { ...toPlaybackQueueSnapshot(track) }
                  return {
                    id: track.id,
                    occurrenceId: track.queueEntryId!,
                    originalPosition: originalPositions.get(track.queueEntryId!)!,
                    ...(snapshot.source === 'local' ? { localSnapshot: snapshot } : { snapshot })
                  }
                })
              )
            }
          },
          {
            selectedIndex: result.index,
            position: result.position,
            mode: session.playMode,
            play,
            preserveOccurrenceIds: true,
            guard: current,
            beforeAdopt
          },
          intent,
          signal
        )
        return { restored: result.queue.length, missing: result.missing, deferred: result.deferred }
      }
      const candidate = createLibraryPlaybackController(this.options.queues)
      let adopted = false
      try {
        // Deliberately restore the current shared cursor/revision, not the saved
        // cursor. The saved mode is an explicit edit of that durable queue.
        const window = await candidate.restore(
          session.libraryQueue,
          session.playMode,
          () => {
            current()
            return true
          },
          true
        )
        current()
        if (!window) throw new Error('数据库队列已删除或没有可用资源，当前队列未改变')
        const previous = this.controller
        const adopt = () => {
          current()
          this.controller = candidate
          this.clearHeart()
          this.mode = session.playMode
          adopted = true
          previous.dispose()
        }
        const prepare = async (playing: boolean) => {
          await beforeAdopt(playing)
          const latest = await this.options.queues.getQueue(window.queue.id)
          current()
          if (latest.revision !== window.queue.revision)
            throw Object.assign(new Error('共享播放队列已变化，请重新选择会话'), {
              code: 'STALE_REVISION'
            })
        }
        if (play)
          await this.load(window, intent, true, session.position, signal, {
            prepare: async () => {
              await prepare(true)
              adopt()
            },
            owner: candidate
          })
        else {
          await this.transport(async () => {
            current()
            await this.options.cast?.stop()
            await this.options.engine.pause()
            const info = await this.options.engine.getPlaybackInfo()
            if (info.state === 'playing') throw new Error('Native Pause was not acknowledged')
            await prepare(false)
            current()
            adopt()
            await this.clearAbLoop()
            await this.updateTrack(candidate.track(window))
            this.restored = true
            this.uncertain = false
            this.info = {
              ...(this.options.cast?.active() ? this.info! : info),
              state: 'paused',
              position: session.position,
              duration: this.currentTrack?.duration ?? 0
            }
            this.error = null
            this.publish()
          })
          await this.flush()
        }
        return { restored: window.queue.total, missing: [], deferred: 0 }
      } finally {
        if (!adopted) candidate.dispose()
      }
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  fromTrack(
    track: TrackData | ((signal: AbortSignal) => Promise<TrackData>),
    position = 0,
    play = true,
    signal?: AbortSignal,
    guard?: () => void
  ): Promise<void> {
    const intent = this.beginPreparation(play)
    const preparation = signal
      ? AbortSignal.any([this.preview.signal, signal])
      : this.preview.signal
    const immediate = typeof track === 'function' ? null : { ...toPlaybackQueueSnapshot(track) }
    return this.stagePages(
      async (append) => {
        const snapshot: LibraryTrackRecord = immediate ?? {
          ...toPlaybackQueueSnapshot(
            await (track as (signal: AbortSignal) => Promise<TrackData>)(preparation)
          )
        }
        this.guard(intent, signal)
        await append([
          {
            id: snapshot.id,
            ...(snapshot.source === 'local' ? { localSnapshot: snapshot } : { snapshot })
          }
        ])
      },
      { position, play, guard },
      intent,
      signal
    )
  }
  /** New unified operation: all source IO completes before staging one chosen
   * queue. Preparation failures never mutate the live queue; native commit
   * failures are not reasons to try another source. */
  async fromUnifiedTrack<T>(
    select: (
      signal: AbortSignal,
      prepare: (track: TrackData) => Promise<PreparedPlaybackSource>
    ) => Promise<{ prepared: PreparedPlaybackSource | null; result: T }>,
    signal?: AbortSignal,
    beforeAdopt?: () => Promise<void>
  ): Promise<T> {
    const intent = this.beginPreparation()
    const current = signal ? AbortSignal.any([this.preview.signal, signal]) : this.preview.signal
    const run = async () => {
      this.guard(intent, signal)
      const selection = await select(current, async (track) => {
        this.guard(intent, signal)
        const prepared = await this.prepareSource({ ...track, sourceSelection: 'explicit' }, current)
        this.guard(intent, signal)
        prepared.confirm?.()
        if (!isSourceCurrent(prepared.resolved, this.options.now()))
          throw new Error('Audio source expired before playback')
        return prepared
      })
      this.guard(intent, signal)
      if (!selection.prepared) return selection.result
      const prepared = selection.prepared
      const snapshot: LibraryTrackRecord = { ...toPlaybackQueueSnapshot(prepared.track) }
      await this.stagePages(async (append) => {
        await append([{ id: snapshot.id,
          ...(snapshot.source === 'local' ? { localSnapshot: snapshot } : { snapshot }) }])
      }, {
        preparedSource: prepared,
        beforeAdopt: async () => {
          await beforeAdopt?.()
          this.guard(intent, signal)
          prepared.confirm?.()
          if (!isSourceCurrent(prepared.resolved, this.options.now()))
            throw new Error('Audio source expired before playback')
        }
      }, intent, signal)
      return selection.result
    }
    try {
      // Cache maintenance may itself be waiting for source read leases.
      // Wait for its session barrier before acquiring this operation's lease.
      if (this.sourceBarrier) await this.sourceBarrier
      this.guard(intent, signal)
      return await (this.options.resources ? this.options.resources.use(run) : run())
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  private async applyTrackRate(previous: TrackData | null, track: TrackData | null): Promise<void> {
    if (this.options.cast?.active()) return
    if (track?.source === 'podcast')
      await this.options.engine.setPlaybackRate(this.options.podcastPlaybackRate?.() ?? 1)
    else if (previous?.source === 'podcast') await this.options.engine.setPlaybackRate(1)
  }
  async setRate(rate: number): Promise<void> {
    this.assertIndependent()
    if (this.options.cast?.active()) {
      if (rate !== 1) throw new Error('Cast does not support changing playback speed')
      return
    }
    await this.commit(async () => {
      await this.options.engine.setPlaybackRate(rate)
      const info = await this.options.engine.getPlaybackInfo()
      this.info =
        this.restored && this.info ? { ...this.info, playbackRate: info.playbackRate } : info
    })
    this.publish()
  }
  private resetAbLoopState(occurrenceId = this.currentTrack?.queueEntryId ?? null): void {
    if (
      this.abLoop.occurrenceId === occurrenceId &&
      this.abLoop.a === null &&
      this.abLoop.b === null
    )
      return
    this.abLoop = {
      revision: this.abLoop.revision + 1,
      occurrenceId,
      a: null,
      b: null,
      mode: 'off'
    }
  }
  private async clearAbLoop(): Promise<void> {
    const active = this.abLoop.a !== null || this.abLoop.b !== null
    this.resetAbLoopState()
    if (active && !this.options.cast?.active())
      await this.options.engine.setLoopRangeConfirmed?.(-1, -1)
  }
  private async updateTrack(track: TrackData | null): Promise<void> {
    if (track?.queueEntryId !== this.currentTrack?.queueEntryId) {
      this.resetStreamBuffering()
      await this.clearAbLoop()
      this.resetAbLoopState(track?.queueEntryId ?? null)
    }
    this.currentTrack = track
  }
  private abLoopLive(): boolean {
    const track = this.currentTrack
    return (
      !!track &&
      (track.source === 'radio' ||
        (track.duration <= 0 && !!(track.streamUrl || /^https?:\/\//i.test(track.filePath || ''))))
    )
  }
  async configureAbLoop(command: CoreAbLoopCommand): Promise<CoreAbLoopState> {
    const intent = this.intent
    return this.transport(async () => {
      this.guard(intent)
      await this.nativeSelection()
      this.guard(intent)
      if (
        command.revision !== this.abLoop.revision ||
        command.occurrenceId !== this.currentTrack?.queueEntryId
      )
        throw Object.assign(new Error('A-B loop occurrence or revision changed'), {
          code: 'STALE_REVISION'
        })
      let action = command.action
      if (action === 'toggle')
        action =
          this.abLoopLive() || this.abLoop.b !== null ? 'clear' : this.abLoop.a === null ? 'a' : 'b'
      if (action !== 'clear' && this.abLoopLive()) return { ...this.abLoop }
      let a = this.abLoop.a,
        b = this.abLoop.b
      const time = command.position ?? this.info?.position ?? 0
      const position = Math.max(0, Number.isFinite(time) ? time : 0)
      if (action === 'clear') {
        a = null
        b = null
      } else if (action === 'a') {
        a = position
        if (b !== null && b <= a) b = null
      } else {
        a ??= 0
        if (position > a) b = position
      }
      if (a === this.abLoop.a && b === this.abLoop.b) return { ...this.abLoop }
      try {
        const valid = a !== null && b !== null && b > a
        const native =
          !this.options.cast?.active() &&
          !this.restored &&
          (await this.options.engine.setLoopRangeConfirmed?.(valid ? a! : -1, valid ? b! : -1))
        this.abLoop = {
          revision: this.abLoop.revision + 1,
          occurrenceId: command.occurrenceId,
          a,
          b,
          mode: valid ? (native ? 'native' : 'soft') : a === null ? 'off' : 'pending'
        }
        this.publish()
        return { ...this.abLoop }
      } catch (error) {
        await this.failStopped(error)
        this.publish()
        throw error
      }
    })
  }
  private async enforceAbLoop(intent: number): Promise<boolean> {
    const loop = this.abLoop
    if (
      this.stopped ||
      intent !== this.intent ||
      this.restored ||
      this.uncertain ||
      loop.mode !== 'soft' ||
      loop.a === null ||
      loop.b === null ||
      loop.occurrenceId !== this.currentTrack?.queueEntryId ||
      this.info?.state !== 'playing' ||
      this.info.position + 0.02 < loop.b ||
      this.abLoopLive()
    )
      return false
    const seek = async () => {
      if (intent !== this.intent || this.abLoop !== loop) return false
      if (this.options.cast?.active())
        this.acceptCast(await this.options.cast.control('seek', loop.a!))
      else {
        if (!this.options.engine.seekConfirmed)
          throw new Error('Confirmed native Seek is unavailable')
        await this.options.engine.seekConfirmed(loop.a!)
        this.info = await this.options.engine.getPlaybackInfo()
      }
      return true
    }
    return this.options.runTransport ? this.options.runTransport(seek) : seek()
  }
  async play(position?: number, signal?: AbortSignal): Promise<void> {
    const intent = this.beginPreparation()
    try {
      await this.playIntent(intent, position, signal)
    } finally {
      this.finishPreparation(intent)
    }
  }
  /** A library rescan changes content/access paths, not queue order or native playback. */
  invalidateLibrary(revision: number): void {
    this.controller.invalidateLibrary(revision)
    this.heartBase?.invalidateLibrary(revision)
  }
  private async playIntent(intent: number, position?: number, signal?: AbortSignal): Promise<void> {
    const reference = this.controller.reference()
    if (!reference || !this.currentTrack) throw new Error('No track selected')
    let base = this.controller.window.value
    if (!base) throw new Error('No playback window')
    if (!this.detachedHeartTrack && base.libraryRevision < this.controller.contentRevision.value) {
      base = await this.controller.playbackWindow(this.currentTrack, this.mode)
      this.guard(intent, signal)
      if (!base) throw new Error('Selected queue occurrence is not playable')
    }
    // Maintenance may already have refreshed the logical window while keeping
    // the open decoder on its original grant. Reopen only on explicit Play.
    const selected = this.controller.track(base)
    const sourceChanged = !this.detachedHeartTrack &&
      (selected?.filePath !== this.currentTrack.filePath || selected?.subTrack !== this.currentTrack.subTrack)
    const window = this.detachedHeartTrack ? this.detachedWindow(base) : base
    const start = position ?? this.info?.position ?? 0
    if (this.options.cast?.active()) {
      if (this.restored || this.uncertain || sourceChanged || this.options.cast.state().phase !== 'ready')
        return this.load(window, intent, true, start, signal)
      await this.transport(async () => {
        this.guard(intent, signal)
        try {
          if (position !== undefined && this.currentTrack?.source !== 'radio')
            await this.options.cast!.control('seek', position)
          this.acceptCast(await this.options.cast!.control('play'))
          if (position !== undefined) this.options.playbackStarted?.()
        } catch (error) {
          await this.failStopped(error)
          throw error
        }
      })
      this.publish()
      return
    }
    if (this.restored || this.uncertain || sourceChanged || !this.options.engine.getQueueToken())
      return this.load(window, intent, true, start, signal)
    try {
      await this.transport(async () => {
        this.guard(intent, signal)
        const source = this.options.engine.getQueueSnapshot()[this.info?.queueIndex ?? 0]?.source
        if (!source) throw new Error('Native occurrence unavailable')
        try {
          const result = await this.options.engine.play(
            source,
            start,
            () => intent === this.intent && !signal?.aborted
          )
          if (!result.nativeStarted || result.superseded) throw nativeStartFailure(result)
          if (position !== undefined) this.options.playbackStarted?.()
          this.info = await this.options.engine.getPlaybackInfo()
        } catch (error) {
          await this.failStopped(error)
          throw error
        }
      })
    } catch (error) {
      this.guard(intent, signal)
      if (!(error instanceof NativeSourceRejected) || !this.options.sources?.recover) throw error
      return this.load(window, intent, true, start, signal, {
        recover: this.currentTrack!,
        allowRecovery: false
      })
    }
    this.startMaintenance()
    this.publish()
  }
  async pause(): Promise<void> {
    if (this.outputClaim) return this.outputClaim.silence()
    this.options.engine.interrupt?.()
    const intent = this.revoke()
    this.requestedState = 'paused'
    try {
      await this.pauseTransport()
    } finally {
      this.finishPreparation(intent)
    }
  }
  private async pauseTransport(): Promise<void> {
    await this.transport(async () => {
      try {
        if (this.options.cast?.active()) {
          if (this.options.cast.state().phase === 'ready')
            this.acceptCast(await this.options.cast.control('pause'))
          else {
            await this.options.cast.stop()
            if (this.info) this.info = { ...this.info, state: 'paused' }
          }
        } else {
          await this.options.engine.pause()
          if (!this.restored && !this.options.cast?.active())
            this.info = await this.options.engine.getPlaybackInfo()
          if (this.info?.state === 'playing') throw new Error('Native Pause was not acknowledged')
        }
      } catch (error) {
        await this.failStopped(error)
        throw error
      } finally {
        this.publish()
      }
    })
    this.publish()
    await this.flush()
  }
  async stop(): Promise<void> {
    if (this.outputClaim) return this.outputClaim.silence()
    this.options.engine.interrupt?.()
    const intent = this.revoke()
    this.requestedState = 'stopped'
    try {
      await this.stopTransport()
    } finally {
      this.finishPreparation(intent)
    }
  }
  private assertAudioAvailable(): void {
    this.assertIndependent()
    if (this.recoveringAudio) throw audioRecoveryInProgress()
  }

  /** Revoke prepared sources; preserve the logical cursor and resume position without autoplay. */
  async recoverAudio(restart: () => Promise<void>, configuration?: {
    serialize<T>(action: () => Promise<T>): Promise<T>
    restored?(): Promise<void>
  }): Promise<void> {
    this.assertAudioAvailable()
    if (this.options.cast?.active())
      throw new Error('Stop casting before restarting the local audio engine')
    this.recoveringAudio = true
    const intent = this.revoke()
    this.resetAbLoopState()
    this.restored = true
    try {
      const restore = () => this.commit(() => {
        const recover = async () => {
          try {
            await restart()
            this.uncertain = false
            this.error = null
          } catch (error) {
            this.uncertain = true
            this.error = errorText(error)
            throw error
          } finally {
            // The engine's ready/poll events describe an empty stopped native
            // pipeline. They must not replace the logical track's saved position.
            this.observed = null
            if (this.info) this.info = { ...this.info, state: 'stopped', nativePlaybackActive: false }
            this.publish()
          }
        }
        return this.options.runTransport ? this.options.runTransport(recover) : recover()
      })
      // Preserve configuration -> transport lock ordering, but keep playback
      // blocked while deferred startup owners acquire configuration afterwards.
      await (configuration ? configuration.serialize(restore) : restore())
      await configuration?.restored?.()
    } catch (error) {
      this.uncertain = true
      this.error = errorText(error)
      this.publish()
      throw error
    } finally {
      this.recoveringAudio = false
      this.finishPreparation(intent)
      await this.flush()
    }
  }
  private async stopTransport(current = () => true): Promise<void> {
    await this.transport(async () => {
      if (!current()) return
      try {
        await this.clearAbLoop()
        await this.options.cast?.stop()
        await this.options.engine.stop()
        if (this.options.cast?.active() && this.info)
          this.info = { ...this.info, state: 'stopped', position: 0 }
        else this.info = await this.options.engine.getPlaybackInfo()
        if (this.info!.state !== 'stopped') throw new Error('Native Stop was not acknowledged')
        this.restored = true
      } catch (error) {
        await this.failStopped(error)
        throw error
      } finally {
        this.publish()
      }
    })
    this.publish()
    await this.flush()
  }
  quiesceForSleep(): Promise<void> {
    this.revoke(false)
    return this.mutation.then(() => {})
  }
  stopForSleep(current: () => boolean): Promise<void> {
    if (this.outputClaim) return current() ? this.outputClaim.silence() : Promise.resolve()
    return this.stopTransport(current)
  }
  resumeAfterSleep(): void {
    this.startMaintenance()
  }
  async setSleepTimerGain(gain: number): Promise<void> {
    if (this.outputClaim) { if (gain < 1) await this.outputClaim.silence(); return }
    if (this.options.cast?.active()) {
      if (this.options.cast.state().phase === 'ready') {
        this.castSleepVolume ??= this.info?.volume ?? 1
        await this.options.cast.control('volume', this.castSleepVolume * gain)
      }
      if (gain === 1) this.castSleepVolume = null
    } else {
      if (!this.options.setNativeSleepGain) throw new Error('Native sleep gain unavailable')
      await this.options.setNativeSleepGain(gain)
    }
  }
  async seek(position: number): Promise<void> {
    this.assertIndependent()
    this.options.engine.interrupt?.()
    const intent = this.revoke()
    await this.commit(async () => {
      this.guard(intent)
      if (this.restored && this.info) this.info = { ...this.info, position }
      else if (this.options.cast?.active()) {
        if (this.currentTrack?.source === 'radio') throw new Error('Live radio cannot seek')
        try {
          if (this.options.playbackSeeked) {
            this.acceptCast(await this.options.cast.read())
            this.guard(intent)
            if (this.info) this.options.observePlayback?.(this.currentTrack, { ...this.info, playMode: this.mode })
          }
          this.acceptCast(await this.options.cast.control('seek', position))
        } catch (error) {
          await this.failStopped(error)
          this.publish()
          throw error
        }
      } else {
        if (this.options.playbackSeeked) {
          await this.nativeSelection()
          this.guard(intent)
        }
        await this.options.engine.seek(position)
        this.info = await this.options.engine.getPlaybackInfo()
      }
      if (this.info) this.options.playbackSeeked?.(this.info)
    })
    this.startMaintenance()
    this.publish()
  }
  private automaticQueue(): boolean {
    const heart = this.heart?.persisted()
    return !!(
      this.options.automaticPlaybackAllowed &&
      (this.personalized?.state() ||
        (heart?.baseQueue && heart.queueId === this.controller.reference()?.id))
    )
  }
  /** A recommendation skip is not an explicit selection of a named song.
   * Inspect at most 100 existing occurrences and request at most one refill. */
  private async navigateAutomatic(
    direction: 1 | -1,
    signal?: AbortSignal,
    natural = false
  ): Promise<void> {
    const intent = this.beginPreparation()
    const current = AbortSignal.any([this.preview.signal, ...(signal ? [signal] : [])])
    try {
      const selection = await this.commit(async () => {
        this.guard(intent, current)
        const native = await this.nativeSelection()
        return { native, reference: this.controller.reference() }
      })
      let reference = selection.reference
      if (!reference) return
      let cursor = reference.index,
        budget = 100
      const visited = new Set<string>()
      if (!(natural && this.mode === 'repeat')) visited.add(reference.entryId)
      for (let pass = 0; pass < 2 && budget > 0; pass++) {
        const candidates: LibraryQueuePlaybackWindow['items'] = []
        if (pass === 0 && natural && this.mode === 'repeat') {
          const row = this.controller.window.value?.items[0]
          if (row?.track) {
            candidates.push(row)
            visited.add(row.queueEntryId)
            budget--
          }
        }
        while (budget > 0) {
          const row = await this.options.queues.readNeighbor(
            reference.id,
            reference.revision,
            cursor,
            direction,
            !natural || this.mode === 'listLoop' || this.mode === 'shuffle'
          )
          this.guard(intent, current)
          if (!row?.track || visited.has(row.queueEntryId)) break
          visited.add(row.queueEntryId)
          cursor = row.position
          budget--
          candidates.push(row)
        }
        const mask = await automaticPlaybackMask(
          candidates.map((row) => libraryQueueTrack(row.track!, row.queueEntryId)),
          this.options.automaticPlaybackAllowed,
          current
        )
        this.guard(intent, current)
        for (let index = 0; index < candidates.length; index++) {
          if (!mask[index]) continue
          try {
            await this.load(this.targetWindow(candidates[index]), intent, true, 0, current, {
              selection: { expected: reference, native: selection.native },
              automatic: true,
              automaticOrigin: reference.entryId
            })
            return
          } catch (error) {
            if (!(error instanceof AutomaticPlaybackRejected)) throw error
            // A ban changed while resolving this source. It never reached native.
          }
        }
        if (pass || direction < 0 || !budget) break
        const owner = this.personalized?.state() ? this.personalized : this.heart
        const added = await owner?.refill()
        this.guard(intent, current)
        reference = this.controller.reference()!
        if (!added) break
      }
      this.error = 'No available tracks for automatic playback'
      this.publish()
      await this.flush()
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  async navigate(direction: 1 | -1, signal?: AbortSignal): Promise<void> {
    if (this.automaticQueue()) return this.navigateAutomatic(direction, signal)
    const intent = this.beginPreparation()
    try {
      const selection = await this.commit(async () => {
        this.guard(intent, signal)
        const native = await this.nativeSelection()
        return { native, reference: this.controller.reference() }
      })
      const { reference, native } = selection
      if (!reference) return
      const target = await this.options.queues.readNeighbor(
        reference.id,
        reference.revision,
        reference.index,
        direction,
        true
      )
      this.guard(intent, signal)
      if (target?.track)
        await this.load(this.targetWindow(target), intent, true, 0, signal, {
          selection: { expected: reference, native }
        })
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  async select(request: CoreCommands['queue.select'], signal?: AbortSignal): Promise<void> {
    this.assertReference(request)
    const intent = this.beginPreparation()
    try {
      const native = await this.commit(async () => {
        this.guard(intent, signal)
        const native = await this.nativeSelection()
        this.assertReference(request)
        return native
      })
      const page = await this.options.queues.readQueue(request.id, request.index, 1, {
        expectedRevision: request.revision
      })
      this.guard(intent, signal)
      if (page.items[0]?.queueEntryId !== request.occurrenceId)
        throw Object.assign(new Error('Queue occurrence changed'), { code: 'STALE_REVISION' })
      const target = page.items[0]
      if (target.track)
        await this.load(this.targetWindow(target), intent, true, 0, signal, {
          selection: { expected: request, native }
        })
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  /** Read only this session's current SQL queue, including an emptied queue. */
  async queuePage(id: string, revision: number, offset: number, limit = 100) {
    const assert = () => {
      const queue = this.snapshot().queue
      if (queue?.id !== id || queue.revision !== revision)
        throw Object.assign(new Error('Playback queue changed; refresh its revision'), { code: 'STALE_REVISION' })
    }
    assert()
    const page = await this.options.queues.readQueue(id, offset, limit, { expectedRevision: revision })
    assert()
    return { ...page, items: page.items.map(item => ({
      position: item.position, queueEntryId: item.queueEntryId, logicalQueueEnd: item.logicalQueueEnd,
      track: item.track ? projectCoreTrack(item.track, item.queueEntryId) : null
    })) }
  }
  private assertReference(expected: { id: string; revision: number }): void {
    const reference = this.controller.reference()
    if (!reference || reference.id !== expected.id || reference.revision !== expected.revision)
      throw Object.assign(new Error('Playback queue changed; refresh its revision'), {
        code: 'STALE_REVISION'
      })
  }
  private targetWindow(
    target: LibraryQueuePlaybackWindow['items'][number]
  ): LibraryQueuePlaybackWindow {
    const window = this.controller.window.value
    if (!window) throw new Error('No active queue window')
    return {
      ...window,
      queue: { ...window.queue, index: target.position, selectedEntryId: target.queueEntryId },
      items: [target]
    }
  }
  private async observeDepartingTrack(nextTrack: TrackData | null): Promise<void> {
    const current = this.currentTrack
    if (
      !current ||
      (current.id === nextTrack?.id && current.queueEntryId === nextTrack?.queueEntryId)
    )
      return
    if (!this.restored && !this.uncertain) {
      if (this.options.cast?.active()) {
        if (this.options.cast.state().phase === 'ready')
          this.acceptCast(await this.options.cast.read())
      } else if (this.options.engine.getQueueToken()) {
        const info = await this.options.engine.getPlaybackInfo()
        const active = this.options.engine.getQueueSnapshot()[info.queueIndex]
        if (
          active &&
          active.id === current.id &&
          (!active.queueEntryId || active.queueEntryId === current.queueEntryId)
        ) {
          this.info = info
        }
      }
    }
    if (this.info)
      this.options.observePlayback?.(current, { ...this.info, playMode: this.mode })
  }
  private async nativeSelection(): Promise<NativeQueueSelection | null> {
    if (this.outputClaim) return null
    if (
      this.options.cast?.active() ||
      this.restored ||
      this.uncertain ||
      !this.options.engine.getQueueToken()
    )
      return null
    const info = await this.options.engine.getPlaybackInfo()
    await this.acceptNative(info)
    this.info = info
    this.options.observePlayback?.(this.currentTrack, { ...this.info, playMode: this.mode })
    const item = this.options.engine.getQueueSnapshot()[info.queueIndex]
    return item
      ? {
          queueToken: this.options.engine.getQueueToken(),
          index: info.queueIndex,
          id: item.id,
          source: item.source
        }
      : null
  }
  private async fenceNative(expected: NativeQueueSelection): Promise<void> {
    const current = this.options.engine.getQueueSnapshot()[expected.index]
    let guarded: Awaited<ReturnType<CorePlaybackEngine['rebindQueue']>>
    try {
      guarded = current
        ? await this.options.engine.rebindQueue({
            expected,
            items: [{ ...current, logicalQueueEnd: false }],
            startIndex: 0,
            playMode: 'sequential'
          })
        : null
    } catch (error) {
      await this.failStopped(error)
      throw error
    }
    if (!guarded)
      throw Object.assign(new Error('Playback occurrence advanced during source resolution'), {
        code: 'STALE_REVISION'
      })
    this.mapping = [this.detachedHeartTrack ? -1 : this.controller.reference()!.index]
  }
  private async failStopped(error: unknown): Promise<void> {
    this.uncertain = true
    this.error = errorText(error)
    this.resetAbLoopState()
    try {
      await this.options.cast?.stop()
      await this.options.engine.stop()
      const stopped = await this.options.engine.getPlaybackInfo()
      if (stopped.state !== 'stopped') throw new Error('Native Stop was not acknowledged')
      this.info =
        this.options.cast?.active() && this.info ? { ...this.info, state: 'stopped' } : stopped
    } catch (stopError) {
      const fatal = new Error(`Cannot confirm audio stopped: ${errorText(stopError)}`)
      this.options.fatal(fatal)
      throw fatal
    }
  }
  async edit(
    id: string,
    revision: number,
    edit: LibraryQueueEdit,
    nextMode = this.mode
  ): Promise<void> {
    this.assertIndependent()
    // Empty queues still own their revision and undo history, without a selected occurrence.
    const assertQueue = () => {
      const queue = this.controller.active.value ? this.controller.snapshot.value : null
      if (!queue || queue.id !== id || queue.revision !== revision)
        throw Object.assign(new Error('Playback queue changed; refresh its revision'), {
          code: 'STALE_REVISION'
        })
    }
    assertQueue()
    if (edit.kind !== 'mode') {
      this.personalized?.stop()
      if (this.mode === 'heart') {
        this.clearHeart()
        this.mode = nextMode = 'sequential'
      }
    }
    const intent = this.revoke()
    try {
      await this.commit(async () => {
        this.guard(intent)
        const native = await this.nativeSelection()
        assertQueue()
        if (native) await this.fenceNative(native)
        this.guard(intent)
        const previous = this.currentTrack
        try {
          const result =
            edit.kind === 'undo'
              ? await this.controller.undo(nextMode, { id, revision })
              : await this.controller.edit(edit, nextMode, { id, revision })
          const selected = this.controller.track(result)
          this.mode = nextMode
          if (!selected) this.detachedHeartTrack = false
          if (!this.detachedHeartTrack) await this.updateTrack(selected)
          if (
            !this.detachedHeartTrack &&
            (selected?.queueEntryId !== previous?.queueEntryId || !selected)
          ) {
            // Preserve queue-edit semantics: removing/replacing the selection
            // chooses a paused row, never implicitly starts its audio.
            await this.options.cast?.stop()
            await this.options.engine.stop()
            if (!selected) {
              await this.options.engine.loadQueue([], 0)
              this.mapping = []
            }
            this.info = {
              ...(this.options.cast?.active()
                ? this.info!
                : await this.options.engine.getPlaybackInfo()),
              state: selected ? 'paused' : 'stopped',
              position: 0,
              duration: selected?.duration ?? 0
            }
            this.restored = true
          }
        } catch (error) {
          await this.failStopped(error)
          throw error
        }
      })
      this.publish()
      await this.flush()
    } finally {
      if (intent === this.intent) this.startMaintenance()
    }
  }
  async setMode(mode: PlayMode, signal?: AbortSignal): Promise<void> {
    if (mode === this.mode) return
    if (mode === 'heart') return this.enterHeart(signal)
    if (this.mode === 'heart') {
      await this.exitHeart(signal)
      if (mode === 'sequential') return
    }
    const reference = this.controller.reference()
    if (reference) await this.edit(reference.id, reference.revision, { kind: 'mode', mode }, mode)
    else {
      this.mode = mode
      this.publish()
    }
  }
  /** Explicit read recovery after an unknown SQL/native result. It never
   * replays the failed edit or resumes audio. */
  async refresh(): Promise<void> {
    this.assertIndependent()
    this.revoke()
    await this.transport(async () => {
      await this.clearAbLoop()
      await this.options.cast?.stop()
      await this.options.engine.stop()
      const info = await this.options.engine.getPlaybackInfo()
      if (info.state !== 'stopped') {
        const error = new Error('Native Stop was not acknowledged')
        this.options.fatal(error)
        throw error
      }
      const window = await this.controller.refresh(this.mode)
      await this.updateTrack(this.controller.track(window))
      if (window && this.mode !== 'heart')
        this.mode = libraryQueueResumeMode(window.queue, this.mode)
      this.detachedHeartTrack = false
      this.info = {
        ...(this.options.cast?.active() ? this.info! : info),
        state: this.currentTrack ? 'paused' : 'stopped',
        position: 0,
        duration: this.currentTrack?.duration ?? 0
      }
      this.restored = true
      this.uncertain = false
      this.error = null
      this.personalized?.recover()
      this.heart?.recover()
    })
    this.publish()
    await this.flush()
  }
  async setVolume(volume: number): Promise<void> {
    this.assertIndependent()
    this.interruptSleep()
    await this.transport(async () => {
      await this.setUserVolume(volume)
    })
  }
  /** System clients submit intent; Core chooses from current or pending state. */
  async control(
    action: Exclude<CoreSystemPlaybackAction, { type: 'toggle-favorite' }>,
    signal?: AbortSignal
  ): Promise<void> {
    switch (action.type) {
      case 'toggle-play':
        return (this.requestedState ?? this.info?.state) === 'playing'
          ? this.pause()
          : this.play(undefined, signal)
      case 'play':
        return this.play(undefined, signal)
      case 'pause':
        return this.pause()
      case 'stop':
        return this.stop()
      case 'previous':
        return this.navigate(-1, signal)
      case 'next':
        return this.navigate(1, signal)
      case 'seek':
        return this.seek(action.value)
      case 'set-volume':
        return this.setVolume(action.value)
      case 'queue-jump':
        return this.select(action, signal)
      case 'volume-step':
        this.interruptSleep()
        return this.transport(async () => {
          const delta = action.direction === 'volumeUp' ? 0.05 : -0.05
          const volume = Math.min(
            1,
            Math.max(0, Math.round(((this.info?.volume ?? 0) + delta) * 100) / 100)
          )
          await this.setUserVolume(volume)
        })
      case 'set-play-mode':
      case 'cycle-play-mode': {
        const work = this.modeControls.then(async () => {
          signal?.throwIfAborted()
          const modes: PlayMode[] = ['sequential', 'listLoop', 'repeat', 'shuffle']
          if (this.heart?.state().available) modes.push('heart')
          const mode =
            action.type === 'set-play-mode'
              ? action.value
              : modes[(modes.indexOf(this.mode) + 1) % modes.length]
          await this.setMode(mode, signal)
        })
        this.modeControls = work.catch(() => {})
        return work
      }
    }
  }
  private async setUserVolume(volume: number): Promise<void> {
    await this.applyVolume(volume)
    if (this.info && this.info.volume > 0) {
      this.muted = false
      this.lastAudibleVolume = this.info.volume
    }
    this.publish()
  }
  async configureMute(muted?: boolean): Promise<void> {
    this.assertIndependent()
    this.interruptSleep()
    await this.transport(async () => {
      const volume = this.info?.volume ?? 0
      const next = muted ?? (!this.muted && volume > 0)
      if (next && volume > 0) this.lastAudibleVolume = volume
      await this.applyVolume(next ? 0 : Math.max(0.01, this.lastAudibleVolume))
      this.muted = next
      if (this.info && this.info.volume > 0) this.lastAudibleVolume = this.info.volume
      this.publish()
    })
  }
  private async applyVolume(volume: number): Promise<void> {
    if (this.options.cast?.active()) {
      try {
        this.acceptCast(await this.options.cast!.control('volume', volume))
      } catch (error) {
        await this.failStopped(error)
        this.publish()
        throw error
      }
      return
    }
    await this.options.engine.setVolume(volume)
    const actual = await this.options.engine.getPlaybackInfo()
    this.info = this.restored && this.info ? { ...this.info, volume: actual.volume } : actual
  }
  private clearHeart(): void {
    this.heart?.stop()
    this.heartBase?.dispose()
    this.heartBase = null
    this.detachedHeartTrack = false
  }
  private detachedWindow(base: LibraryQueuePlaybackWindow): LibraryQueuePlaybackWindow {
    const track = this.currentTrack!
    return {
      ...base,
      queue: { ...base.queue, index: -1, selectedEntryId: track.queueEntryId! },
      items: [
        { position: -1, queueEntryId: track.queueEntryId!, track: { ...track } },
        base.items[0]
      ]
    }
  }
  async startLiked(command: CoreLikedPlayback, signal?: AbortSignal): Promise<void> {
    const owner = this.heart
    if (!owner) throw new Error('NCM provider runtime unavailable')
    const intent = this.beginPreparation(command.play !== false)
    const current = AbortSignal.any([this.preview.signal, ...(signal ? [signal] : [])])
    try {
      const liked = await owner.liked(current, command.selectedId)
      await this.stagePages(
        liked.produce,
        {
          mode: command.shuffle ? 'shuffle' : this.mode === 'heart' ? 'sequential' : this.mode,
          order: command.shuffle ? 'shuffle' : 'original',
          selectedIndex: liked.selectedIndex,
          play: command.play,
          onAdopt: () =>
            owner.attach({
              queueId: this.controller.reference()!.id,
              likedPlaylistId: liked.playlistId
            })
        },
        intent,
        current
      )
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  private async enterHeart(signal?: AbortSignal): Promise<void> {
    const owner = this.heart,
      context = owner?.persisted()
    if (!owner?.state().available || !context || this.detachedHeartTrack)
      throw new Error('Heart mode requires the NCM liked playlist context')
    const intent = this.beginPreparation(this.info?.state === 'playing')
    const current = AbortSignal.any([this.preview.signal, ...(signal ? [signal] : [])])
    try {
      const selection = await this.commit(async () => {
        this.guard(intent, current)
        const native = await this.nativeSelection()
        return { native, reference: this.controller.reference()!, track: this.currentTrack! }
      })
      const batch = await owner.fetch(context.likedPlaylistId, selection.track, current)
      this.guard(intent, current)
      const seen = new Set([selection.track.id])
      const additions = batch.filter((track) => !seen.has(track.id) && !!seen.add(track.id))
      if (!additions.length) {
        if (this.mode !== 'sequential')
          await this.restoreHeartBase(
            this.controller,
            context.likedPlaylistId,
            selection,
            intent,
            current
          )
        return
      }
      await this.switchHeartQueue(
        async (append) => {
          await append(
            [selection.track, ...additions].map((track, index) => ({
              id: track.id,
              occurrenceId: index ? crypto.randomUUID() : track.queueEntryId!,
              snapshot: { ...toPlaybackQueueSnapshot(track), filePath: '', streamUrl: null }
            }))
          )
        },
        () => 0,
        intent,
        current,
        selection,
        (previous) => {
          this.heartBase = previous
          this.mode = 'heart'
          owner.attach({
            queueId: this.controller.reference()!.id,
            likedPlaylistId: context.likedPlaylistId,
            baseQueue: selection.reference
          })
        }
      )
    } finally {
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  private async exitHeart(signal?: AbortSignal): Promise<void> {
    const base = this.heartBase,
      context = this.heart?.persisted()
    if (!base || !context?.baseQueue) throw new Error('Heart base queue unavailable')
    this.heartTransition = true
    this.heart!.attach(context)
    const intent = this.revoke()
    const current = AbortSignal.any([this.preview.signal, ...(signal ? [signal] : [])])
    try {
      const selection = await this.commit(async () => {
        this.guard(intent, current)
        const native = await this.nativeSelection()
        return { native, reference: this.controller.reference()!, track: this.currentTrack! }
      })
      await this.restoreHeartBase(base, context.likedPlaylistId, selection, intent, current)
    } finally {
      this.heartTransition = false
      if (intent === this.intent) this.startMaintenance()
    }
  }
  private async restoreHeartBase(
    base: ReturnType<typeof createLibraryPlaybackController>,
    likedPlaylistId: number,
    selection: HeartSelection,
    intent: number,
    signal: AbortSignal
  ): Promise<void> {
    const restored = await this.options.queues.restoreHeartBaseQueue(
      base.reference()!,
      selection.track.id
    )
    this.guard(intent, signal)
    await this.switchHeartQueue(
      restored.queue,
      () => 0,
      intent,
      signal,
      selection,
      (previous) => {
        previous.dispose()
        this.heartBase = null
        if (base !== previous) base.dispose()
        this.mode = 'sequential'
        this.heart!.attach({ queueId: this.controller.reference()!.id, likedPlaylistId })
        this.detachedHeartTrack = !restored.matched
      }
    )
  }

  /** A queue-only handoff. Source IO and hidden construction never occupy the transport lane. */
  private async switchHeartQueue(
    produce: LibraryQueueSeedProducer | LibraryQueueSnapshot,
    selectedIndex: () => number,
    intent: number,
    signal: AbortSignal,
    selection: HeartSelection,
    onAdopt: (previous: ReturnType<typeof createLibraryPlaybackController>) => void
  ): Promise<void> {
    const candidate = createLibraryPlaybackController({
      ...this.options.queues,
      buildQueue: (command) =>
        this.options.queues.restoreNamedPlaybackQueue({
          ...command,
          ...(command.kind === 'begin' ? { playMode: 'sequential' } : {})
        } as CoreQueueRestoreCommand)
    })
    let adopted = false,
      dispatched = false
    const handoff = async (
      window: LibraryQueuePlaybackWindow,
      activate: () => void,
      retain: () => void
    ) => {
      await this.commit(async () => {
        this.guard(intent, signal)
        await this.nativeSelection()
        this.guard(intent, signal)
        this.assertReference(selection.reference)
        if (this.controller.reference()?.entryId !== selection.reference.entryId)
          throw Object.assign(new Error('Heart seed advanced during recommendation lookup'), {
            code: 'STALE_REVISION'
          })
        const previous = this.controller
        const adopt = async () => {
          if (adopted) return
          activate()
          this.controller = candidate
          adopted = true
          onAdopt(previous)
          await this.updateTrack(
            this.detachedHeartTrack ? selection.track : candidate.track(window)
          )
          if (
            this.currentTrack &&
            this.currentTrack.id === selection.track.id &&
            this.currentTrack.queueEntryId !== selection.track.queueEntryId
          )
            this.options.occurrenceRebound?.(selection.track, this.currentTrack)
          this.mapping = [this.detachedHeartTrack ? -1 : window.queue.index]
        }
        if (selection.native) {
          const native = this.options.engine.getQueueSnapshot()[selection.native.index]
          const detached = window.items[0].track?.id !== selection.track.id
          const entryId = detached ? selection.track.queueEntryId : window.items[0].queueEntryId
          retain()
          dispatched = true
          let result
          try {
            result = await this.options.engine.rebindQueue({
              expected: selection.native,
              items: [{ ...native, queueEntryId: entryId, logicalQueueEnd: false }],
              startIndex: 0,
              playMode: 'sequential'
            })
          } catch (error) {
            await adopt()
            try {
              await this.failStopped(error)
            } finally {
              this.publish()
            }
            throw error
          }
          if (!result)
            throw Object.assign(new Error('Native occurrence changed before heart handoff'), {
              code: 'STALE_REVISION'
            })
        }
        // Pause can have revoked the intent while rebind was dispatched. Its
        // command is next in this lane; first publish the acknowledged identity.
        dispatched = true
        retain()
        await adopt()
        if (!this.restored && !this.options.cast?.active())
          this.info = await this.options.engine.getPlaybackInfo()
        this.publish()
      })
    }
    try {
      if (typeof produce === 'function') {
        await candidate.stagePages(
          produce,
          {
            id: `core-restore-${crypto.randomUUID()}`,
            contentRevision: await this.options.queues.libraryRevision(),
            order: 'original',
            selectedIndex
          },
          'sequential',
          handoff,
          {
            guard: () => {
              if (!dispatched) this.guard(intent, signal)
            }
          }
        )
      } else {
        const reference = {
          id: produce.id,
          revision: produce.revision,
          index: produce.index,
          entryId: produce.selectedEntryId!
        }
        const window = await candidate.adoptStopped(
          reference,
          'sequential',
          () => intent === this.intent && !signal.aborted
        )
        this.guard(intent, signal)
        if (!window) throw new Error('Heart base queue changed before adoption')
        await handoff(
          window,
          () => {},
          () => {}
        )
      }
      await this.flush()
    } finally {
      if (!adopted) candidate.dispose()
    }
  }
  async refillHeart(expected: { id: string; revision: number }): Promise<number> {
    this.assertReference(expected)
    if (!this.heart?.state().active) throw new Error('No active heart queue')
    return this.heart.refill(true)
  }
  async startPersonalized(command: CorePersonalizedStart, signal?: AbortSignal): Promise<void> {
    const owner = this.personalized
    if (!owner) throw new Error('Personalized provider runtime is unavailable')
    const intent = this.beginPreparation(command.play !== false)
    try {
      await this.startPersonalizedIntent(owner, command, intent, signal)
    } finally {
      this.finishPreparation(intent)
    }
  }
  private async startPersonalizedIntent(
    owner: PersonalizedQueue,
    command: CorePersonalizedStart,
    intent: number,
    signal?: AbortSignal
  ): Promise<void> {
    const current = AbortSignal.any([this.preview.signal, ...(signal ? [signal] : [])])
    const tracks = await owner.initial(command.providerId, command.key, current, command.selectedId)
    this.guard(intent, current)
    const selected = command.selectedId
      ? tracks.find((track) => track.id === command.selectedId)
      : tracks[0]
    if (!selected) throw new Error('Selected recommendation is unavailable')
    const ordered = [selected, ...shuffleArray(tracks.filter((track) => track !== selected))]
    const originalPositions = new Map(tracks.map((track, index) => [track.id, index]))
    await this.stagePages(
      async (append) => {
        for (let offset = 0; offset < ordered.length; offset += 200)
          await append(
            ordered.slice(offset, offset + 200).map((track) => ({
              id: track.id,
              snapshot: { ...track },
              originalPosition: originalPositions.get(track.id)!
            }))
          )
      },
      {
        mode: 'shuffle',
        play: command.play !== false,
        automatic: !command.selectedId,
        onAdopt: () =>
          owner.attach({
            providerId: command.providerId,
            key: command.key,
            queueId: this.controller.reference()!.id
          })
      },
      intent,
      current
    )
  }
  async refillPersonalized(expected: { id: string; revision: number }): Promise<number> {
    this.assertReference(expected)
    if (!this.personalized?.state()) throw new Error('No active personalized stream')
    return this.personalized.refill(true)
  }
  private async extendPersonalized(
    id: string,
    tracks: TrackData[],
    current: () => boolean
  ): Promise<number> {
    let added = 0
    for (let offset = 0; offset < tracks.length; offset += 200) {
      await this.commit(async () => {
        if (!current() || this.controller.reference()?.id !== id) return
        await this.nativeSelection()
        if (!current() || this.controller.reference()?.id !== id) return
        const previous = this.controller.snapshot.value!.total
        try {
          const window = await this.controller.extend(
            tracks
              .slice(offset, offset + 200)
              .map((track) => ({ id: track.id, snapshot: { ...track } })),
            this.mode
          )
          if (!window) throw new Error('Automatic queue extension was not acknowledged')
          added += window.queue.total - previous
          await this.updateTrack(this.controller.track(window))
          this.publish()
        } catch (error) {
          await this.failStopped(error)
          throw error
        }
      })
      if (!current()) break
    }
    if (added) {
      void this.maintainer?.tick()
      await this.flush()
    }
    return added
  }
  /** Invalidate prepared sources and pin every acknowledged native resource.
   * Filesystem IO stays outside the transport lane, so Pause/Stop remain usable. */
  async maintainSources<T>(action: (sources: readonly string[]) => Promise<T>): Promise<T> {
    if (this.outputClaim) return action([]) // Shared owner supplies the active physical sources.
    const resume = this.maintainer?.isActive()
    const intent = this.revoke()
    let release!: () => void
    this.sourceBarrier = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const sources = await this.commit(async () => {
        const actual = await this.options.engine.getPlaybackInfo()
        return [...this.options.engine.getQueueSnapshot().map((item) => item.source), actual.source]
      })
      return await action(sources)
    } finally {
      this.sourceBarrier = null
      release()
      if (this.info?.state === 'playing' || (intent === this.intent && resume))
        this.startMaintenance()
    }
  }
  private scheduleSave(): void {
    if (this.scheduledSave) return
    this.scheduledSave = this.flush()
      .catch((error) => {
        this.error = errorText(error)
        this.publish()
      })
      .finally(() => {
        this.scheduledSave = null
      })
  }
  captureWorkspace(): Promise<{
    reference: LibraryPlaybackQueueReference
    position: number
    mode: PlayMode
  }> {
    return this.commit(async () => {
      if (this.uncertain || this.stopped) throw new Error('Playback selection is unavailable')
      await this.nativeSelection()
      if (this.options.cast?.state().phase === 'ready')
        this.acceptCast(await this.options.cast.read())
      const reference = this.controller.reference()
      if (!reference || !this.info) throw new Error('No active queue to save')
      this.publish()
      return {
        reference,
        position: this.detachedHeartTrack ? 0 : Math.max(0, this.info.position),
        mode: this.mode
      }
    })
  }
  private assertHandoffQueue(expected: ZoneQueueFence | null): void {
    const actual = this.controller.snapshot.value
    if (actual?.id !== expected?.id || actual?.revision !== expected?.revision || actual?.selectedEntryId !== expected?.occurrenceId)
      throw Object.assign(new Error('会话队列已变化，请刷新后重新接力'), { code: 'STALE_REVISION' })
  }
  /** Pause and capture one finite session. A later user intent cancels its use by
   * the receiver, including during slow SQL/provider IO. No rollback autoplay. */
  async captureHandoff(expected: ZoneQueueFence, signal: AbortSignal, claim?: { id: string; silence(): Promise<void> }) {
    signal.throwIfAborted()
    this.assertIndependent()
    this.assertHandoffQueue(expected)
    if (this.options.cast?.active() || this.mode === 'heart' || this.personalized?.state())
      throw new Error('请先结束投放或动态推荐，普通曲库队列才可接力')
    if (this.currentTrack?.source === 'radio') throw new Error('直播电台不支持位置接力')
    const paused = this.pause()
    // Reserve the output before SQL IO; Pause/Stop now revoke the group creation.
    if (claim) this.outputClaim = claim
    const intent = this.intent, sourceSignal = this.preview.signal
    await paused
    this.guard(intent, signal)
    const capture = await this.captureWorkspace()
    const validate = () => { this.guard(intent, signal); this.assertHandoffQueue(expected) }
    validate()
    return { ...capture, signal: sourceSignal, validate }
  }
  /** Adopt a separate SQL cursor while paused and persist before optional Play.
   * Existing target DSP/volume stay attached to its own output. */
  async receiveHandoff(
    expected: ZoneQueueFence | null,
    source: () => ReturnType<CorePlaybackSession['captureHandoff']>,
    resume: boolean,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.options.queues.clonePlaybackQueue) throw new Error('此 Core 不支持会话接力')
    if (this.options.cast?.active()) throw new Error('请先结束目标会话的投放')
    this.assertHandoffQueue(expected)
    const intent = this.beginPreparation(false)
    const candidate = createLibraryPlaybackController(this.options.queues)
    let adopted = false
    let cloned: LibraryQueuePlaybackWindow['queue'] | undefined
    try {
      await this.commit(async () => {
        this.guard(intent, signal)
        await this.nativeSelection()
        this.assertHandoffQueue(expected)
      })
      this.guard(intent, signal)
      const capture = await source()
      const combined = AbortSignal.any([signal, capture.signal])
      const current = () => { this.guard(intent, combined); capture.validate() }
      current()
      cloned = await this.options.queues.clonePlaybackQueue(capture.reference)
      current()
      const window = await candidate.adoptStopped({ id: cloned.id, revision: cloned.revision,
        index: cloned.index, entryId: cloned.selectedEntryId! }, capture.mode, () => { current(); return true })
      current()
      if (!window || !candidate.track(window)) throw new Error('接力队列的当前曲目不可用')
      await this.transport(async () => {
        current(); this.assertHandoffQueue(expected)
        let info: PlaybackInfo
        try {
          await this.options.engine.pause()
          info = await this.options.engine.getPlaybackInfo()
          if (info.state === 'playing') throw new Error('Native Pause was not acknowledged')
        } catch (error) { await this.failStopped(error); throw error }
        await this.observeDepartingTrack(candidate.track(window))
        await this.clearAbLoop()
        current()
        const previous = this.controller
        this.controller = candidate; adopted = true; previous.dispose()
        this.clearHeart(); this.personalized?.stop(); this.mode = capture.mode
        await this.updateTrack(candidate.track(window))
        this.restored = true; this.uncertain = false; this.error = null
        this.info = { ...info, state: 'paused', position: capture.position, duration: this.currentTrack?.duration ?? 0 }
        this.publish()
      })
      await this.flush()
      current()
      if (resume) await this.load(window, intent, true, capture.position, combined)
    } finally {
      if (!adopted) {
        candidate.dispose()
        if (cloned) await this.options.queues.deleteQueue(cloned.id, cloned.revision).catch(() => {})
      }
      this.finishPreparation(intent)
      if (intent === this.intent) this.startMaintenance()
    }
  }
  flush(): Promise<void> {
    const capture = this.commit(async () => {
      if (!this.initialized || this.stopped || !this.info || this.uncertain) return undefined
      if (this.options.resumeMode() === 'off' || !this.currentTrack) return null
      const reference = this.controller.reference()
      if (!reference) return null
      return structuredClone({
        version: 1 as const,
        savedAt: new Date(this.options.now()).toISOString(),
        mode: this.options.resumeMode(),
        playMode: this.mode,
        track: this.currentTrack,
        position:
          this.options.resumeMode() === 'trackAndPosition' ? Math.max(0, this.info.position) : 0,
        libraryQueue: reference,
        personalizedStream: this.personalized?.persisted(),
        heart: this.heart?.persisted(),
        ...(this.detachedHeartTrack ? { detachedHeartTrack: true as const } : {}),
        ...(this.options.sleepTimer?.persisted()
          ? { sleepTimer: this.options.sleepTimer.persisted() }
          : {})
      })
    })
    const save = this.persistence.then(async () => {
      const session = await capture
      if (session === undefined) return
      if (session === null) {
        const saved = await this.options.repository.clear(this.revision)
        this.lastSavedAt = this.options.now()
        this.revision = saved.revision
        return
      }
      const saved = await this.options.repository.save(session, this.revision)
      this.revision = saved.revision
      this.lastSavedAt = this.options.now()
    })
    // A failed write remains visible to its caller, but does not poison explicit retry.
    this.persistence = save.catch(() => {})
    return save
  }
  /** audioTerminated is internal: the owner must first confirm physical process
   * exit. It permits durable cleanup after a fatal engine stop, not a mute shortcut. */
  async shutdown(options: { audioTerminated?: boolean } = {}): Promise<void> {
    if (this.stopped) return
    await this.personalized?.shutdown()
    this.options.engine.off('playback-info', this.listen)
    this.options.engine.off('playback-sample', this.listen)
    this.options.engine.off('audio-service-crash', this.crash)
    this.options.engine.off('audio-service-ready', this.audioReady)
    await this.heart?.shutdown()
    this.revoke()
    await this.mutation
    await this.observing
    if (!options.audioTerminated && !this.restored && !this.uncertain) {
      if (this.options.cast?.active()) this.acceptCast(await this.options.cast.read())
      else this.info = await this.options.engine.getPlaybackInfo()
    }
    this.publish()
    await this.flush()
    if (options.audioTerminated) this.resetAbLoopState()
    else await this.clearAbLoop()
    this.stopped = true
    await this.options.cast?.shutdown()
    if (!options.audioTerminated) await this.options.engine.stop()
    this.resetStreamBuffering()
    this.controller.dispose()
    this.heartBase?.dispose()
  }
}

function audioRecoveryInProgress(): Error {
  return Object.assign(new Error('Audio recovery is in progress; wait before playing'), { code: 'BUSY' })
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function nativeStartFailure(result: AudioEnginePlayResult): Error {
  const message = result.fallbackReason
    ? `Native playback did not start: ${result.fallbackReason}`
    : 'Native playback did not start'
  return result.superseded ? new Error(message) : new NativeSourceRejected(message)
}
class NativeSourceRejected extends Error {}
class AutomaticPlaybackRejected extends Error {
  constructor() {
    super('Track is excluded from automatic playback')
  }
}
