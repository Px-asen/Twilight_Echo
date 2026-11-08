import type { CoreSleepTimerConfigure, CoreSleepTimerState } from '../../shared/coreSleepTimer.ts'
import {
  createSleepTimerState,
  isActiveSleepTimerState,
  type SleepTimerSettings,
  type SleepTimerState
} from '../../shared/sleepTimer.ts'
import { SleepTimerService } from './sleepTimer.ts'
import { SleepTimerShutdown } from './sleepShutdown.ts'
import { ScheduledPauseTimer } from './scheduledPause.ts'

/** One clock and fade for every client; there is no window ownership handoff. */
export class CoreSleepTimer {
  private revision = 0
  private active = false
  private restored: SleepTimerState | null = null
  private pending = Promise.resolve()
  private readonly persistence = new Set<Promise<void>>()
  private readonly timer: SleepTimerService
  private readonly fade: SleepTimerShutdown
  private readonly scheduledPause?: ScheduledPauseTimer
  private readonly options: {
    settings(): SleepTimerSettings
    now(): number
    monotonic?(): number
    bootId?(): string
    scheduledPauseOnly?: boolean
    timers: {
      setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>
      clearInterval(timer: ReturnType<typeof setInterval>): void
      setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
      clearTimeout(timer: ReturnType<typeof setTimeout>): void
    }
    playback: {
      read(): { state: string; volume: number; duration?: number }
      quiesce(): Promise<void>
      setGain(gain: number): Promise<void>
      stop(current: () => boolean): Promise<void>
      pause?(current: () => boolean): Promise<void>
      armTrackEnd?(enabled: boolean): Promise<boolean>
      resumeMaintenance(): void
      persist(): Promise<void>
    }
    changed(): void
    failed(error: unknown): void
  }
  constructor(options: CoreSleepTimer['options']) {
    this.options = options
    const changed = () => {
      if (!this.active) return
      this.revision++
      options.changed()
      const write = options.playback.persist()
      this.persistence.add(write)
      void write.catch(options.failed).finally(() => this.persistence.delete(write))
    }
    if (options.playback.pause && options.playback.armTrackEnd && options.monotonic && options.bootId) {
      this.scheduledPause = new ScheduledPauseTimer({ now: options.now, monotonic: options.monotonic,
        bootId: options.bootId, setInterval: options.timers.setInterval, clearInterval: options.timers.clearInterval,
        read: options.playback.read, pause: options.playback.pause, armTrackEnd: options.playback.armTrackEnd,
        changed, failed: options.failed })
    }
    this.fade = new SleepTimerShutdown({
      getPlaybackInfo: async () => options.playback.read(),
      quiesce: () => options.playback.quiesce(),
      setGain: (gain) => options.playback.setGain(gain),
      stop: (current) => options.playback.stop(current),
      onStopped: () => options.changed(),
      onError: (error) => options.failed(error),
      now: options.now,
      setTimeout: options.timers.setTimeout,
      clearTimeout: options.timers.clearTimeout
    })
    this.timer = new SleepTimerService({
      owner: 'core',
      now: options.now,
      setInterval: options.timers.setInterval,
      clearInterval: options.timers.clearInterval,
      publish: () => {
        if (!this.active) return
        this.revision++
        options.changed()
        const write = options.playback.persist()
        this.persistence.add(write)
        void write.catch(options.failed).finally(() => this.persistence.delete(write))
      }
    })
    this.timer.claimShutdown({ trigger: (state) => this.fade.begin(state), update: () => {} })
  }
  state(): CoreSleepTimerState {
    return { revision: this.revision, timer: this.scheduledPause?.state() ?? (this.active ? this.timer.snapshot() : this.restored) }
  }
  persisted(): SleepTimerState | undefined {
    const timer = this.state().timer
    return timer?.active ? { ...timer } : undefined
  }
  restore(state: SleepTimerState | undefined): void {
    if (state?.action === 'pause') { this.scheduledPause?.restore(state); return }
    if (this.options.scheduledPauseOnly) return
    this.restored = isActiveSleepTimerState(state, this.options.now()) ? { ...state } : null
  }
  activate(): void {
    this.active = true
    this.scheduledPause?.activate()
    if (isActiveSleepTimerState(this.restored, this.options.now()))
      this.timer.configure(this.restored)
    this.restored = null
  }
  private run<T>(revision: number, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const work = this.pending.then(async () => {
      signal.throwIfAborted()
      if (revision !== this.revision)
        throw Object.assign(new Error('Sleep timer changed'), { code: 'STALE_REVISION' })
      return action()
    })
    this.pending = work.then(
      () => {},
      () => {}
    )
    return work
  }
  configure(request: CoreSleepTimerConfigure, signal: AbortSignal): Promise<void> {
    return this.run(request.revision, signal, async () => {
      if (this.options.scheduledPauseOnly && request.action !== 'pause')
        throw Object.assign(new Error('This host supports scheduled pause timers'), { code: 'UNSUPPORTED_CAPABILITY' })
      if (request.action === 'pause') {
        if (!this.scheduledPause) throw new Error('Scheduled pause is unavailable on this host')
        this.timer.cancel()
        await this.fade.cancel()
        await this.scheduledPause.configure(request)
        await this.flushPersistence()
        return
      }
      if (this.scheduledPause?.state()) await this.scheduledPause.cancel()
      await this.fade.cancel()
      this.timer.configure(
        createSleepTimerState(
          request.mode,
          this.options.now(),
          this.options.settings(),
          request.minutes
        )
      )
      this.options.playback.resumeMaintenance()
      await this.flushPersistence()
    })
  }
  cancel(revision: number, signal: AbortSignal): Promise<void> {
    return this.run(revision, signal, async () => {
      if (this.scheduledPause?.state()) await this.scheduledPause.cancel()
      this.timer.cancel()
      await this.fade.cancel()
      this.options.playback.resumeMaintenance()
      await this.flushPersistence()
    })
  }
  /** Called synchronously by a new transport intent; an armed timer stays armed. */
  interrupt(): Promise<void> {
    if (!this.timer.snapshot()?.triggered) return Promise.resolve()
    this.timer.cancel()
    return this.fade.cancel()
  }
  triggered(): boolean {
    return this.scheduledPause?.state()?.triggered === true || this.timer.snapshot()?.triggered === true
  }
  checkDue(): Promise<void> { return this.scheduledPause?.check() ?? Promise.resolve() }
  consumeTransport(name: string): Promise<boolean> {
    return this.scheduledPause?.consumeTransport(name) ?? Promise.resolve(false)
  }
  boundary(event: 'trackEnd' | 'queueEnd', occurredAt?: number): void {
    if (this.active) this.timer.boundary(event, occurredAt)
  }
  private async flushPersistence(): Promise<void> {
    await Promise.all([...this.persistence])
  }
  async flush(): Promise<void> {
    await this.pending
    await this.flushPersistence()
  }
  async shutdown(): Promise<void> {
    await this.pending
    await this.scheduledPause?.shutdown()
    this.active = false
    this.restored = this.timer.snapshot()
    this.timer.cancel()
    // A fired timer must reach Stop before temporary gain can return to unity.
    await this.fade.finish()
    await this.flush()
  }
}
