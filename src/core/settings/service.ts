import type { AppSettings } from '../../shared/appSettings.ts'
import {
  CORE_SPECIALIZED_SETTINGS,
  type CoreSettingsEdit,
  type CoreSettingsPaths,
  type CoreSettingsState
} from '../../shared/coreSettings.ts'
import { effectiveAutoMixMode } from '../../shared/twilightAutoMix.ts'
import type { CoreSettingsRepository } from '../persistence/settingsRepository.ts'
import type { CoreSettingsImportEffects } from './importEffects.ts'

export interface CoreSettingsServiceOptions {
  repository: CoreSettingsRepository
  authorizePaths(paths: CoreSettingsPaths, signal: AbortSignal): Promise<CoreSettingsPaths>
  configureLibrary(previous: AppSettings | null, next: AppSettings): Promise<void>
  serialize<T>(action: () => Promise<T>): Promise<T>
  schedule(callback: () => void, milliseconds: number): () => void
  failed(error: unknown): void
  importEffects?: CoreSettingsImportEffects
  audio: {
    setAutoMixMode(mode: AppSettings['autoMixMode']): Promise<boolean>
    invalidateAutoMixSource(): void
    stop(): Promise<void>
    getAudioServiceFailure?(): string | null
  }
}

/** One writer for preferences; output/DSP transactions use the same repository. */
export class CoreSettingsService {
  private pending: Promise<unknown> = Promise.resolve()
  private pendingVolume: number | null = null
  private cancelVolumeTimer: (() => void) | null = null
  private readonly options: CoreSettingsServiceOptions
  constructor(options: CoreSettingsServiceOptions) {
    this.options = options
  }

  getRevision(): number {
    return this.options.repository.getRevision()
  }
  state(): CoreSettingsState {
    return {
      revision: this.options.repository.getRevision(),
      settings: this.options.repository.read()
    }
  }
  async initialize(options: { audio?: boolean } = {}): Promise<void> {
    await this.options.configureLibrary(null, this.options.repository.read())
    if (options.audio !== false) await this.restoreAudio()
  }
  async restoreAudio(): Promise<void> {
    const mode = effectiveAutoMixMode(this.options.repository.read().autoMixMode)
    if (mode !== 'off' && !(await this.options.audio.setAutoMixMode(mode))) {
      const reason = this.options.audio.getAudioServiceFailure?.()
      if (reason) throw Object.assign(new Error(reason), { code: 'AUDIO_SERVICE_UNAVAILABLE' })
      throw new Error('音频引擎未能恢复 AutoMix 模式')
    }
  }
  /** Same 350 ms debounce/rounding as the existing main-owned volume preference. */
  rememberVolume(volume: number): void {
    this.pendingVolume = Math.min(1, Math.max(0, Math.round(volume * 1000) / 1000))
    this.cancelVolumeTimer?.()
    this.cancelVolumeTimer = this.options.schedule(() => {
      this.cancelVolumeTimer = null
      try {
        this.persistVolume()
      } catch (error) {
        this.options.failed(error)
      }
    }, 350)
  }
  private persistVolume(): void {
    const volume = this.pendingVolume
    if (volume === null) return
    if (Math.abs(volume - this.options.repository.read().softwareVolume) >= 0.0005)
      this.options.repository.update({ softwareVolume: volume })
    this.pendingVolume = null
  }
  edit(request: CoreSettingsEdit, signal: AbortSignal): Promise<CoreSettingsState> {
    return this.applyEdit(request, signal, false)
  }
  /** Other Core owners commit preferences in the same lane, using its current revision. */
  editOwned(patch: CoreSettingsEdit['patch']): Promise<CoreSettingsState> {
    return this.applyEdit({ revision: 0, patch }, new AbortController().signal, true)
  }
  private applyEdit(
    request: CoreSettingsEdit,
    signal: AbortSignal,
    owned: boolean
  ): Promise<CoreSettingsState> {
    const work = this.pending.then(() =>
      this.options.serialize(async () => {
        const repository = this.options.repository
        if (owned) request = { ...request, revision: repository.getRevision() }
        const check = () => {
          signal.throwIfAborted()
          if (request.revision !== repository.getRevision())
            throw Object.assign(new Error('Settings changed; read their current revision'), {
              code: 'STALE_REVISION'
            })
        }
        check()
        const previous = repository.read()
        for (const key of Object.keys(request.patch)) {
          if (
            !Object.hasOwn(previous, key) ||
            (CORE_SPECIALIZED_SETTINGS as readonly string[]).includes(key)
          )
            throw new Error(`Use the domain command for setting: ${key}`)
        }
        let patch = { ...request.patch }
        const normalized = repository.normalize(patch)
        const paths: CoreSettingsPaths = {}
        if (Object.hasOwn(patch, 'libraryFolders')) paths.libraryFolders = normalized.libraryFolders
        if (Object.hasOwn(patch, 'downloadFolder')) paths.downloadFolder = normalized.downloadFolder
        if (Object.hasOwn(patch, 'cachePath') || Object.hasOwn(patch, 'musicCachePath'))
          paths.musicCachePath = normalized.musicCachePath
        if (Object.keys(paths).length) {
          const authorized = await this.options.authorizePaths(paths, signal)
          patch = { ...patch, ...authorized }
          if (authorized.musicCachePath !== undefined) patch.cachePath = authorized.musicCachePath
        }
        check()
        const next = repository.normalize(patch)
        const autoMixChanged = next.autoMixMode !== previous.autoMixMode
        if (autoMixChanged) {
          const accepted = await this.options.audio.setAutoMixMode(
            effectiveAutoMixMode(next.autoMixMode)
          )
          if (!accepted) throw new Error('音频引擎未能应用 AutoMix 模式')
        }
        try {
          // Recheck after an ACK: a volume/profile commit may have advanced the repository.
          check()
          repository.update(patch)
        } catch (error) {
          if (autoMixChanged) {
            try {
              if (
                !(await this.options.audio.setAutoMixMode(
                  effectiveAutoMixMode(previous.autoMixMode)
                ))
              )
                throw new Error('AutoMix rollback failed')
            } catch {
              await this.options.audio.stop()
            }
          }
          throw error
        }
        if (Object.hasOwn(patch, 'autoMixStemMode') || Object.hasOwn(patch, 'autoMixStemDevice'))
          this.options.audio.invalidateAutoMixSource()
        if (Object.hasOwn(patch, 'libraryFolders') || Object.hasOwn(patch, 'watchLibrary'))
          await this.options.configureLibrary(previous, repository.read())
        return this.state()
      })
    )
    this.pending = work.catch(() => {})
    return work
  }
  /** Internal backup entry point. Ordinary clients still use the domain-specific commands. */
  restore(
    revision: number,
    candidate: AppSettings,
    signal: AbortSignal
  ): Promise<CoreSettingsState> {
    const work = this.pending.then(() =>
      this.options.serialize(async () => {
        const repository = this.options.repository
        const effects = this.options.importEffects
        if (!effects) throw new Error('Settings import is not configured')
        const check = () => {
          signal.throwIfAborted()
          if (revision !== repository.getRevision())
            throw Object.assign(new Error('Settings changed; read their current revision'), {
              code: 'STALE_REVISION'
            })
        }
        check()
        const previous = repository.read()
        let next = repository.normalize(candidate)
        const paths = await this.options.authorizePaths(
          {
            libraryFolders: next.libraryFolders,
            downloadFolder: next.downloadFolder,
            musicCachePath: next.musicCachePath
          },
          signal
        )
        next = repository.normalize({ ...next, ...paths, cachePath: paths.musicCachePath })
        next = await effects.prepare(next, signal)
        check()
        // Once accepted, complete the owned transactions even if the caller disconnects.
        // Output/DSP own their ACK, persistence and rollback; an uncertain write is never replayed.
        try {
          const applied = await effects.apply(previous, next)
          repository.update({ ...next, ...applied })
        } catch (error) {
          await effects.rollback(previous)
          throw error
        }
        this.options.audio.invalidateAutoMixSource()
        await this.options.configureLibrary(previous, repository.read())
        return this.state()
      })
    )
    this.pending = work.catch(() => {})
    return work
  }
  async flush(): Promise<void> {
    await this.pending
    this.cancelVolumeTimer?.()
    this.cancelVolumeTimer = null
    this.persistVolume()
  }
}
