import type { CoreSleepTimerConfigure } from '../../shared/coreSleepTimer.ts'
import type { SleepTimerState } from '../../shared/sleepTimer.ts'

/** Portable host timers share Core ownership; the OS alarm only asks Core to check its clock. */
export class ScheduledPauseTimer {
  private value: SleepTimerState | null = null
  private generation = 0
  private checking = false
  private interval: ReturnType<typeof setInterval> | null = null
  private active = false
  private nativeArmed = false
  private readonly options: {
    now(): number
    monotonic(): number
    bootId(): string
    setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>
    clearInterval(timer: ReturnType<typeof setInterval>): void
    read(): { state: string; volume: number; duration?: number }
    pause(current: () => boolean): Promise<void>
    armTrackEnd(enabled: boolean): Promise<boolean>
    changed(): void
    failed(error: unknown): void
  }
  constructor(options: ScheduledPauseTimer['options']) { this.options = options }

  state(): SleepTimerState | null { return this.value ? { ...this.value } : null }
  waiting(): boolean { return this.value?.waitingForTrackEnd === true }
  private due(state: SleepTimerState): boolean {
    const schedule = state.schedule!
    return (schedule.clock === 'elapsed' ? this.options.monotonic() : this.options.now()) >= schedule.deadlineMs
  }
  restore(state: SleepTimerState): void {
    if (state.active && !state.triggered && state.schedule?.bootId === this.options.bootId() && !this.due(state))
      this.value = { ...state }
  }
  activate(): void { this.active = true; this.schedule() }
  private schedule(): void {
    if (this.interval) this.options.clearInterval(this.interval)
    this.interval = this.active && this.value
      ? this.options.setInterval(() => { void this.check() }, 1000) : null
  }
  async configure(request: CoreSleepTimerConfigure): Promise<void> {
    if (!request.schedule || !request.endsAt || !this.options.bootId() || request.schedule.bootId !== this.options.bootId())
      throw new Error('Sleep timer clock no longer belongs to this device boot')
    await this.cancel(false)
    this.value = { mode: 'minutes', endsAt: request.endsAt, fadeSeconds: 0, active: true, triggered: false,
      action: 'pause', schedule: { ...request.schedule }, finishCurrentTrack: request.finishCurrentTrack === true }
    this.schedule()
    this.options.changed()
    await this.check()
  }
  async cancel(publish = true): Promise<void> {
    ++this.generation
    this.value = null
    this.schedule()
    await this.disarm()
    if (publish) this.options.changed()
  }
  /** User pause/skip while waiting completes the timer; the command cannot start a successor. */
  async consumeTransport(name: string): Promise<boolean> {
    if (!this.value?.triggered) return false
    if (['playback.pause', 'playback.stop', 'playback.next', 'playback.previous', 'queue.replace', 'queue.select'].includes(name)) {
      await this.finish(this.generation)
      return true
    }
    if (name === 'playback.play') await this.cancel()
    return false
  }
  async check(): Promise<void> {
    if (!this.active || !this.value || this.checking) return
    if (!this.value.triggered && !this.due(this.value)) return
    this.checking = true
    const generation = this.generation
    try {
      const info = this.options.read()
      if (this.waiting()) {
        if (!['playing', 'buffering'].includes(info.state)) await this.finish(generation)
        return
      }
      const finishTrack = this.value.finishCurrentTrack && ['playing', 'buffering'].includes(info.state) && (info.duration ?? 0) > 0
      this.value = { ...this.value, active: false, triggered: true }
      this.options.changed()
      if (finishTrack) this.nativeArmed = true
      if (finishTrack && await this.options.armTrackEnd(true)) {
        if (generation !== this.generation) return
        this.value = { ...this.value!, waitingForTrackEnd: true }
        this.options.changed()
      } else await this.finish(generation)
    } catch (error) {
      this.options.failed(error)
      if (generation === this.generation) {
        try { await this.finish(generation) } catch (failure) { this.options.failed(failure) }
      }
    } finally { this.checking = false }
  }
  private async finish(generation: number): Promise<void> {
    const current = () => generation === this.generation && this.value !== null
    await this.options.pause(current)
    if (!current()) return
    await this.disarm()
    if (!current()) return
    this.value = null
    ++this.generation
    this.schedule()
    this.options.changed()
  }
  async shutdown(): Promise<void> {
    this.active = false
    this.schedule()
    if (this.value?.triggered) await this.finish(this.generation)
    await this.disarm()
  }
  private async disarm(): Promise<void> {
    if (!this.nativeArmed) return
    await this.options.armTrackEnd(false)
    this.nativeArmed = false
  }
}
