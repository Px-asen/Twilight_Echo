import type { AudioOutputId, OutputConfig, PlaybackInfo } from '../../shared/audioEngineTypes.ts'
import {
  MAX_AUDIO_DEVICE_PROFILES,
  matchAudioDeviceProfile,
  normalizeAudioDeviceProfileSettings,
  normalizeDeviceProfileProcessing,
  stableAudioDeviceId,
  type AudioDeviceProfile,
  type AudioDeviceProfileSettings,
  type AudioDeviceProfilesSnapshot,
  type DeviceProfileProcessing
} from '../../shared/audioDeviceProfiles.ts'
import type { OutputRouter } from './outputRouter.ts'
import type { DspOrchestrator } from './dspOrchestrator.ts'

export interface DeviceProfileCommit {
  audioDeviceProfiles: AudioDeviceProfileSettings
  audioOutput: AudioOutputId
  audioDevice: string
  audioExclusiveMode: boolean
  audioOutputConfig: OutputConfig
  processing: DeviceProfileProcessing
  dspPinnedSceneId: string | null
  softwareVolume: number
}

export class DeviceProfiles {
  settings: AudioDeviceProfileSettings
  private generation = 0
  private phase: AudioDeviceProfilesSnapshot['phase'] = 'idle'
  private error = ''
  private presentDevices = new Set<string>()
  private readonly router: OutputRouter
  private readonly dsp: DspOrchestrator
  private readonly playbackInfo: () => PlaybackInfo
  private readonly persist: (commit: DeviceProfileCommit) => void
  private readonly changed: () => void

  constructor(
    router: OutputRouter,
    dsp: DspOrchestrator,
    playbackInfo: () => PlaybackInfo,
    persist: (commit: DeviceProfileCommit) => void,
    changed: () => void,
    settings?: AudioDeviceProfileSettings
  ) {
    this.router = router
    this.dsp = dsp
    this.playbackInfo = playbackInfo
    this.persist = persist
    this.changed = changed
    this.settings = normalizeAudioDeviceProfileSettings(settings)
    this.dsp.outputStageOverride = this.settings.outputStageOverride
    this.presentDevices = this.deviceIdentities()
  }

  invalidatePending(): void {
    this.generation += 1
  }

  snapshot(): AudioDeviceProfilesSnapshot {
    const devices = this.router.getAudioDeviceOptions()
    const sceneState = this.dsp.getDspSceneState()
    const deviceId =
      this.router.device === 'auto'
        ? this.playbackInfo().outputInfo.actualDeviceId
        : this.router.device
    const currentDevice = devices.find((device) => device.id === deviceId)
    const current: AudioDeviceProfile = {
      version: 1,
      id: 'current',
      name: currentDevice?.label || '当前输出',
      stableDeviceId: currentDevice ? stableAudioDeviceId(currentDevice) : '',
      backend: this.router.output,
      exclusiveMode: this.router.exclusiveMode,
      outputConfig: this.router.getOutputConfig(),
      volumeCeiling: this.settings.volumeCeiling,
      outputStage: { ...sceneState.graph.outputStage },
      processing: normalizeDeviceProfileProcessing(this.dsp.getAudioProcessing()),
      dspSceneId: sceneState.pinnedSceneId ?? sceneState.activeSceneId,
      autoApply: false
    }
    const unavailable: Record<string, string> = {}
    for (const profile of this.settings.profiles) {
      const reason = this.unavailableReason(profile)
      if (reason) unavailable[profile.id] = reason
    }
    return {
      ...this.settings,
      current,
      devices,
      scenes: sceneState.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
      unavailable,
      phase: this.phase,
      error: this.error
    }
  }

  save(profile: AudioDeviceProfile): AudioDeviceProfilesSnapshot {
    const previous = this.settings
    const exists = previous.profiles.some((entry) => entry.id === profile.id)
    if (!exists && previous.profiles.length >= MAX_AUDIO_DEVICE_PROFILES)
      throw new Error('设备档案最多保存 64 项')
    const profiles = exists
      ? previous.profiles.map((entry) => (entry.id === profile.id ? profile : entry))
      : [...previous.profiles, profile]
    this.replaceSettings({
      ...previous,
      profiles,
      activeProfileId: previous.activeProfileId === profile.id ? null : previous.activeProfileId
    })
    this.presentDevices = this.deviceIdentities()
    return this.snapshot()
  }

  remove(id: string): AudioDeviceProfilesSnapshot {
    this.replaceSettings({
      ...this.settings,
      profiles: this.settings.profiles.filter((profile) => profile.id !== id),
      activeProfileId: this.settings.activeProfileId === id ? null : this.settings.activeProfileId
    })
    return this.snapshot()
  }

  async apply(id: string): Promise<AudioDeviceProfilesSnapshot> {
    const generation = ++this.generation
    return this.router.serializeConfiguration(async () => {
      const assertCurrent = () => {
        if (generation !== this.generation) throw new Error('设备档案切换已被更新的选择替代')
      }
      assertCurrent()
      const profile = this.settings.profiles.find((entry) => entry.id === id)
      if (!profile) throw new Error('设备档案不存在')
      const reason = this.unavailableReason(profile)
      if (reason) throw new Error(reason)
      const target = matchAudioDeviceProfile(profile, this.router.getAudioDeviceOptions())[0]
      const previous = this.settings
      const previousCommit = this.createCommit(previous)
      const previousProcessing = this.dsp.getAudioProcessing()
      const previousPinned = this.dsp.dspPinnedSceneId
      const previousStage = this.dsp.outputStageOverride
      const nextSettings: AudioDeviceProfileSettings = {
        ...previous,
        activeProfileId: id,
        volumeCeiling: profile.volumeCeiling,
        outputStageOverride: profile.outputStage
      }
      this.phase = 'applying'
      this.error = ''
      this.changed()
      try {
        await this.router.runOutputRouteTransaction({
          context: 'device-profile',
          nextOutput: profile.backend,
          nextDevice: target.id,
          nextExclusiveMode: profile.exclusiveMode,
          nextConfig: profile.outputConfig,
          errorCode: 'audio.device_profile_failed',
          errorMessage: '设备档案应用失败',
          cacheReason: 'device-profile',
          expectedActualDeviceId: target.id,
          volumeCeiling: profile.volumeCeiling,
          acceptsDsdRoute: (info) => this.acceptsDsdRoute(profile, target.id, info),
          assertCurrent,
          applyProcessing: async () => {
            await this.dsp.applyProfileConfiguration(
              { ...profile.processing, dsdToPcm: profile.processing.dsdOutputMode === 'pcm' },
              profile.dspSceneId,
              profile.outputStage
            )
          },
          rollbackProcessing: async () => {
            await this.dsp.applyProfileConfiguration(
              previousProcessing,
              previousPinned,
              previousStage
            )
          },
          commit: () => {
            assertCurrent()
            const reason = this.unavailableReason(profile)
            if (reason) throw new Error(reason)
            this.persist(this.createCommit(nextSettings))
          },
          rollbackCommit: () => {
            this.persist(previousCommit)
            this.settings = previous
          }
        })
        this.settings = nextSettings
        this.phase = 'applied'
      } catch (error) {
        this.settings = previous
        this.dsp.processing = previousProcessing
        this.dsp.dspPinnedSceneId = previousPinned
        this.dsp.outputStageOverride = previousStage
        this.phase = 'failed'
        this.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.changed()
      }
      return this.snapshot()
    })
  }

  customized(): void {
    if (
      !this.settings.activeProfileId &&
      this.settings.outputStageOverride === this.dsp.outputStageOverride
    )
      return
    this.replaceSettings({
      ...this.settings,
      activeProfileId: null,
      outputStageOverride: this.dsp.outputStageOverride
    })
  }

  devicesChanged(): void {
    const present = this.deviceIdentities()
    const candidates = this.settings.profiles.filter(
      (profile) =>
        profile.autoApply &&
        present.has(`${profile.backend}:${profile.stableDeviceId}`) &&
        !this.presentDevices.has(`${profile.backend}:${profile.stableDeviceId}`)
    )
    this.presentDevices = present
    this.changed()
    if (!candidates.length) return
    if (candidates.length !== 1) {
      this.phase = 'failed'
      this.error = '多个设备档案同时匹配，请手动选择要应用的档案'
      this.changed()
      return
    }
    void this.apply(candidates[0].id).catch((error) => {
      this.phase = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.changed()
    })
  }

  private deviceIdentities(): Set<string> {
    const devices = this.router.getAudioDeviceOptions()
    const result = new Set<string>()
    for (const profile of this.settings.profiles) {
      if (matchAudioDeviceProfile(profile, devices).length === 1)
        result.add(`${profile.backend}:${profile.stableDeviceId}`)
    }
    return result
  }

  private unavailableReason(profile: AudioDeviceProfile): string {
    if (!this.router.getAudioOutputOptions().some((option) => option.id === profile.backend))
      return '当前平台不支持该档案的输出后端'
    const matches = matchAudioDeviceProfile(profile, this.router.getAudioDeviceOptions())
    if (matches.length === 0) return '绑定设备未连接，当前输出保持不变'
    if (matches.length !== 1) return '稳定设备 ID 对应多个设备，无法自动选择'
    if (profile.dspSceneId && !this.dsp.dspScenes.some((scene) => scene.id === profile.dspSceneId))
      return '引用的 DSP 场景已删除，请编辑档案重新选择'
    if (profile.processing.dsdRoute.enabled && profile.processing.dsdRoute.device) {
      const route = profile.processing.dsdRoute
      if (!this.router.getAudioDeviceOptions().some((device) => device.id === route.device))
        return 'DSD 独立路由设备未连接'
    }
    return ''
  }

  private acceptsDsdRoute(
    profile: AudioDeviceProfile,
    primaryDevice: string,
    info: PlaybackInfo
  ): boolean {
    const output = info.outputInfo
    const diagnostic = output.diagnostics
    if (!diagnostic.dsdRouteOverrideActive || !output.actualDeviceId) return false
    if (
      !output.isDsd &&
      (!profile.outputConfig.pcmToDsdMode ||
        profile.outputConfig.pcmToDsdMode === 'off' ||
        !profile.processing.dsdRoute.applyToPcmToDsd)
    )
      return false
    if (
      diagnostic.dsdRouteBackend !== output.actualBackend ||
      diagnostic.dsdRouteDevice !== output.actualDeviceId
    )
      return false
    if (
      this.router.getAudioDeviceOptions().filter((device) => device.id === output.actualDeviceId)
        .length !== 1
    )
      return false
    const route = profile.processing.dsdRoute
    if (!route.enabled)
      return (
        output.isDsd &&
        profile.processing.dsdOutputMode !== 'pcm' &&
        output.actualBackend === 'asio'
      )
    const primaryBackend = profile.exclusiveMode ? `${profile.backend}-exclusive` : profile.backend
    return (
      output.actualBackend === (route.backend || primaryBackend) &&
      output.actualDeviceId === (route.device || primaryDevice)
    )
  }

  private replaceSettings(settings: AudioDeviceProfileSettings): void {
    this.persist(this.createCommit(settings))
    this.settings = settings
    this.changed()
  }

  private createCommit(settings: AudioDeviceProfileSettings): DeviceProfileCommit {
    return {
      audioDeviceProfiles: settings,
      audioOutput: this.router.output,
      audioDevice: this.router.device,
      audioExclusiveMode: this.router.exclusiveMode,
      audioOutputConfig: this.router.getOutputConfig(),
      processing: normalizeDeviceProfileProcessing(this.dsp.getAudioProcessing()),
      dspPinnedSceneId: this.dsp.dspPinnedSceneId,
      softwareVolume: Math.min(this.playbackInfo().volume, settings.volumeCeiling)
    }
  }
}
