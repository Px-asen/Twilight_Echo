import {
  audioRecoveryBusy,
  type AudioRecoveryKind,
  type AudioRecoveryState
} from '../../shared/audioRecovery.ts'
import { projectCoreError } from '../projections.ts'
import type { CoreAudioOutputService } from './outputService.ts'
import type { CorePlaybackSession } from '../playback/session.ts'

interface RecoveryEngine {
  canRestartAudioEngine(): boolean
  restartAudioEngine(maintenance?: () => Promise<void>): Promise<void>
  getAudioServiceFailure?(): string | null
}

/** A recovery job outlives the settings panel and owns its configuration/transport barriers. */
export class CoreAudioRecoveryService {
  private phase: AudioRecoveryState['phase'] = 'idle'
  private kind: AudioRecoveryKind | null = null
  private error: string | null = null
  private work: Promise<void> | null = null
  private closing = false
  private readonly confirmation = new AbortController()
  private readonly options: {
    engine: RecoveryEngine
    playback: Pick<CorePlaybackSession, 'recoverAudio'>
    configuration: Pick<CoreAudioOutputService, 'serialize' | 'changed'>
    windows: boolean
    confirmWindowsRestart(signal: AbortSignal): Promise<boolean>
    restartWindowsServices(): Promise<void>
    restoreStartup?(): Promise<void>
    changed(): void
  }
  constructor(options: CoreAudioRecoveryService['options']) {
    this.options = options
  }

  state(): AudioRecoveryState {
    const failure = this.unavailableReason()
    const failed = Boolean(failure) && !audioRecoveryBusy({ phase: this.phase })
    return {
      phase: failed ? 'failed' : this.phase,
      kind: this.kind,
      engineAvailable: this.options.engine.canRestartAudioEngine(),
      windowsServicesAvailable: this.options.windows,
      error: failed ? projectCoreError(failure) : this.error
    }
  }

  unavailableReason(): string | null {
    return this.options.engine.getAudioServiceFailure?.() || null
  }

  isUnavailableError(error: unknown): boolean {
    const reason = this.unavailableReason()
    if (!reason || !(error instanceof Error)) return false
    return (
      (error as { code?: string }).code === 'AUDIO_SERVICE_UNAVAILABLE' ||
      error.message.includes(reason) ||
      error.message.includes('Audio engine is restarting')
    )
  }

  start(kind: AudioRecoveryKind): AudioRecoveryState {
    if (this.closing) throw new Error('Audio recovery is shutting down')
    if (audioRecoveryBusy(this.state())) return this.state()
    if (!this.options.engine.canRestartAudioEngine())
      throw new Error('Audio recovery requires the isolated audio engine')
    if (kind === 'windows-services' && !this.options.windows)
      throw new Error('Windows audio services are only available on Windows')
    this.kind = kind
    this.error = null
    this.setPhase(kind === 'windows-services' ? 'confirming' : 'restarting-engine')
    this.work = this.run(kind)
      .catch((error: unknown) => {
        this.error = projectCoreError(error)
        this.setPhase((error as { code?: string })?.code === 'CANCELLED' ? 'cancelled' : 'failed')
      })
      .finally(() => { this.work = null })
    return this.state()
  }

  private setPhase(phase: AudioRecoveryState['phase']): void {
    this.phase = phase
    this.options.changed()
  }

  private async run(kind: AudioRecoveryKind): Promise<void> {
    if (kind === 'windows-services') {
      const confirmed = await this.options.confirmWindowsRestart(this.confirmation.signal)
      if (!confirmed || this.closing) {
        this.setPhase('cancelled')
        return
      }
    }
    if (this.closing) {
      this.setPhase('cancelled')
      return
    }
    try {
      await this.options.playback.recoverAudio(
        () =>
          this.options.engine.restartAudioEngine(
            kind === 'windows-services'
              ? async () => {
                  this.setPhase('restarting-services')
                  await this.options.restartWindowsServices()
                  this.setPhase('restarting-engine')
                }
              : undefined
          ),
        {
          serialize: action => this.options.configuration.serialize(action),
          restored: this.options.restoreStartup
        }
      )
    } finally {
      this.options.configuration.changed()
    }
    this.setPhase('succeeded')
  }

  async shutdown(): Promise<void> {
    this.closing = true
    this.confirmation.abort()
    await this.work
  }
}
