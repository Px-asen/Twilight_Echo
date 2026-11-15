import type {
  AudioOutputFallbackNotice,
  CoreAudioOutput,
  CoreAudioOutputEdit,
  CoreAudioProfileEdit,
  CoreAudioProfiles
} from '../../shared/coreAudio.ts'
import { projectCoreError } from '../projections.ts'
import type {
  AudioOutputState,
  AudioOutputId,
  OutputConfig,
  OutputConfigApplyStatus
} from '../../shared/audioEngineTypes.ts'
import {
  normalizeAudioDeviceProfile,
  type AudioDeviceProfile,
  type AudioDeviceProfilesSnapshot
} from '../../shared/audioDeviceProfiles.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'

export interface CoreOutputEngine {
  getAudioOutputState(): Promise<AudioOutputState>
  getOutputConfig(): OutputConfig
  getOutputConfigApplyStatus(): OutputConfigApplyStatus
  getOutputFallbackNotice?(): AudioOutputFallbackNotice | null
  setAudioOutput(output: AudioOutputId, device?: string): Promise<AudioOutputState>
  setAudioDevice(device: string): Promise<AudioOutputState>
  setExclusiveMode(enabled: boolean): Promise<AudioOutputState>
  setExclusiveAutoRelease(enabled: boolean): Promise<void>
  setOutputConfig(config: Partial<OutputConfig>): Promise<void>
  getDeviceProfiles(): AudioDeviceProfilesSnapshot
  saveDeviceProfile(profile: AudioDeviceProfile): Promise<AudioDeviceProfilesSnapshot>
  deleteDeviceProfile(id: string): Promise<AudioDeviceProfilesSnapshot>
  applyDeviceProfile(id: string): Promise<AudioDeviceProfilesSnapshot>
  quiesceAudioConfiguration(): Promise<void>
  stop(): Promise<void>
}

/** Output, DSP and audition share one configuration lane; transport never does. */
export class CoreAudioOutputService {
  private revision = 0
  private pending = Promise.resolve()
  private readonly options: {
    engine: CoreOutputEngine
    settings: CoreSettingsRepository
    changed(): void
  }
  constructor(options: CoreAudioOutputService['options']) {
    this.options = options
  }
  getRevision(): number {
    return this.revision
  }
  changed(): void {
    this.revision++
    this.options.changed()
  }
  state(): Promise<CoreAudioOutput> {
    return this.serialize(async () => {
      const output = await this.options.engine.getAudioOutputState()
      const fallbackNotice = this.options.engine.getOutputFallbackNotice?.() ?? null
      return structuredClone({
        revision: this.revision,
        output,
        config: this.options.engine.getOutputConfig(),
        applyStatus: this.options.engine.getOutputConfigApplyStatus(),
        exclusiveAutoRelease: this.options.settings.read().audioExclusiveAutoRelease,
        ...(fallbackNotice
          ? {
              fallbackNotice: {
                ...fallbackNotice,
                reason: projectCoreError(fallbackNotice.reason)
              }
            }
          : {})
      })
    })
  }
  profiles(): Promise<CoreAudioProfiles> {
    return this.serialize(async () =>
      structuredClone({
        revision: this.revision,
        profiles: this.options.engine.getDeviceProfiles()
      })
    )
  }
  serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(action)
    this.pending = task.then(
      () => {},
      () => {}
    )
    return task
  }
  run<T>(revision: number, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      signal.throwIfAborted()
      if (revision !== this.revision)
        throw Object.assign(new Error('Output configuration changed; read its current revision'), {
          code: 'STALE_REVISION'
        })
      try {
        return await action()
      } finally {
        this.changed()
      }
    })
  }
  edit(request: CoreAudioOutputEdit, signal: AbortSignal): Promise<void> {
    const engine = this.options.engine
    return this.run(request.revision, signal, async () => {
      const edit = request.edit
      switch (edit.kind) {
        case 'backend':
          await engine.setAudioOutput(edit.output, edit.device)
          break
        case 'device':
          await engine.setAudioDevice(edit.device)
          break
        case 'exclusive':
          await engine.setExclusiveMode(edit.enabled)
          break
        case 'config':
          await engine.setOutputConfig(edit.config)
          break
        case 'autoRelease': {
          const previous = this.options.settings.read().audioExclusiveAutoRelease
          await engine.setExclusiveAutoRelease(edit.enabled)
          try {
            this.options.settings.update({ audioExclusiveAutoRelease: edit.enabled })
          } catch (error) {
            try {
              await engine.setExclusiveAutoRelease(previous)
            } catch {
              await engine.stop()
            }
            throw error
          }
        }
      }
    })
  }
  editProfiles(request: CoreAudioProfileEdit, signal: AbortSignal): Promise<void> {
    const engine = this.options.engine
    return this.run(request.revision, signal, async () => {
      const edit = request.edit
      switch (edit.kind) {
        case 'save': {
          const profile = normalizeAudioDeviceProfile(edit.profile)
          if (!profile) throw new Error('Invalid device profile')
          await engine.saveDeviceProfile(profile)
          break
        }
        case 'remove':
          await engine.deleteDeviceProfile(edit.id)
          break
        case 'apply':
          await engine.applyDeviceProfile(edit.id)
          break
      }
    })
  }
  async flush(): Promise<void> {
    await this.pending
  }
  async shutdown(): Promise<void> {
    await this.pending
    await this.options.engine.quiesceAudioConfiguration()
  }
}
