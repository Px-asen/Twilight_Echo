export type SleepTimerMode = 'minutes' | 'trackEnd' | 'queueEnd'

export interface SleepTimerSettings {
  defaultMinutes: number
  fadeSeconds: number
}

export interface SleepTimerState {
  mode: SleepTimerMode
  endsAt: number | null
  fadeSeconds: number
  active: boolean
  triggered: boolean
  /** Main-assigned identity of a fired timer; never persisted as an armed timer. */
  triggerRevision?: number
  /** Authority executing the fade; clients only project this state. */
  shutdownOwner?: 'main' | 'core'
  /** Optional portable-host schedule. Older desktop timers keep their original semantics. */
  action?: 'pause'
  schedule?: SleepTimerSchedule
  finishCurrentTrack?: boolean
  waitingForTrackEnd?: boolean
}

export interface SleepTimerSchedule {
  id: string
  clock: 'elapsed' | 'local'
  deadlineMs: number
  bootId: string
  localDate?: string
  hour?: number
  minute?: number
}

export interface SleepTimerShutdownHandoff {
  triggerRevision: number
  startedAt: number
  volume: number
}

export function isSleepTimerShutdownHandoff(value: unknown): value is SleepTimerShutdownHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Number.isSafeInteger(record.triggerRevision) &&
    (record.triggerRevision as number) > 0 &&
    Number.isSafeInteger(record.startedAt) &&
    (record.startedAt as number) > 0 &&
    typeof record.volume === 'number' &&
    Number.isFinite(record.volume) &&
    record.volume >= 0 &&
    record.volume <= 1
  )
}

/** Runtime guard for IPC and persisted playback sessions. */
export function isSleepTimerState(value: unknown): value is SleepTimerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  if (state.action !== undefined) {
    const schedule = state.schedule as Partial<SleepTimerSchedule> | undefined
    if (state.action !== 'pause' || state.mode !== 'minutes' || !schedule || typeof schedule !== 'object' ||
        typeof schedule.id !== 'string' || !schedule.id || typeof schedule.bootId !== 'string' || !schedule.bootId ||
        !['elapsed', 'local'].includes(String(schedule.clock)) || !Number.isSafeInteger(schedule.deadlineMs) ||
        Number(schedule.deadlineMs) <= 0 || typeof state.finishCurrentTrack !== 'boolean' ||
        (state.waitingForTrackEnd !== undefined && typeof state.waitingForTrackEnd !== 'boolean')) return false
    if (schedule.clock === 'local' && (typeof schedule.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(schedule.localDate) ||
        !Number.isInteger(schedule.hour) || Number(schedule.hour) < 0 || Number(schedule.hour) > 23 ||
        !Number.isInteger(schedule.minute) || Number(schedule.minute) < 0 || Number(schedule.minute) > 59)) return false
  }
  if (
    (state.mode !== 'minutes' && state.mode !== 'trackEnd' && state.mode !== 'queueEnd') ||
    typeof state.active !== 'boolean' ||
    typeof state.triggered !== 'boolean' ||
    typeof state.fadeSeconds !== 'number' ||
    !Number.isInteger(state.fadeSeconds) ||
    state.fadeSeconds < 0 ||
    state.fadeSeconds > 120
  ) {
    return false
  }
  if (state.mode === 'minutes') {
    if (
      !(typeof state.endsAt === 'number' && Number.isSafeInteger(state.endsAt) && state.endsAt > 0)
    ) {
      return false
    }
  } else if (state.endsAt !== null) {
    return false
  }
  if (
    state.triggerRevision !== undefined &&
    (!Number.isSafeInteger(state.triggerRevision) ||
      (state.triggerRevision as number) <= 0 ||
      state.active ||
      !state.triggered)
  )
    return false
  if (
    state.shutdownOwner !== undefined &&
    (!['main', 'core'].includes(String(state.shutdownOwner)) || state.triggerRevision === undefined)
  )
    return false

  // A timer is either armed or has fired. A cancelled timer is represented by
  // null, never by an inert state object. Keeping this invariant at the wire
  // boundary prevents a persisted terminal state from being re-armed.
  return state.active !== state.triggered
}

/** Validates an armed state at a clock boundary such as IPC or session restore. */
export function isActiveSleepTimerState(
  value: unknown,
  now = Date.now()
): value is SleepTimerState {
  if (!isSleepTimerState(value) || !value.active || value.triggered) return false
  return value.mode !== 'minutes' || (value.endsAt !== null && value.endsAt > now)
}

export const DEFAULT_SLEEP_TIMER_SETTINGS: SleepTimerSettings = {
  defaultMinutes: 30,
  fadeSeconds: 10
}

export function createSleepTimerState(
  mode: SleepTimerMode,
  now: number,
  settings: SleepTimerSettings,
  minutes = settings.defaultMinutes
): SleepTimerState {
  const normalizedMinutes = Math.max(1, Math.min(720, Math.trunc(minutes)))
  return {
    mode,
    endsAt: mode === 'minutes' ? now + normalizedMinutes * 60_000 : null,
    fadeSeconds: Math.max(0, Math.min(120, Math.trunc(settings.fadeSeconds))),
    active: true,
    triggered: false
  }
}

export function shouldTriggerSleepTimer(
  state: SleepTimerState,
  now: number,
  event: 'tick' | 'trackEnd' | 'queueEnd'
): boolean {
  if (!state.active || state.triggered) return false
  if (state.mode === 'minutes') return event === 'tick' && (state.endsAt ?? Infinity) <= now
  return state.mode === 'trackEnd' ? event === 'trackEnd' : event === 'queueEnd'
}

export function remainingSleepTimerSeconds(state: SleepTimerState, now: number): number | null {
  if (!state.active || state.endsAt === null) return null
  return Math.max(0, Math.ceil((state.endsAt - now) / 1000))
}
