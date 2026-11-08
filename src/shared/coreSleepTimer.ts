import type { SleepTimerMode, SleepTimerState, SleepTimerSchedule } from './sleepTimer.ts'

export interface CoreSleepTimerState {
  revision: number
  timer: SleepTimerState | null
}
export interface CoreSleepTimerConfigure {
  revision: number
  mode: SleepTimerMode
  minutes?: number
  action?: 'pause'
  endsAt?: number
  schedule?: SleepTimerSchedule
  finishCurrentTrack?: boolean
}
