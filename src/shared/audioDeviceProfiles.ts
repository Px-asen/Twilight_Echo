import type {
  AudioDeviceOption,
  AudioOutputId,
  AudioProcessingSettings,
  OutputConfig
} from './audioEngineTypes.ts'
import { normalizeOutputConfig } from './audioOutputConfig.ts'
import { normalizeDsdRouteSettings } from './audioProcessingOptions.ts'
import { normalizeDspOutputStage, type DspOutputStageConfig } from './dspGraph.ts'
import { deviceOptionsForOutput } from './audioDeviceRouting.ts'

export const AUDIO_DEVICE_PROFILE_VERSION = 1
export const MAX_AUDIO_DEVICE_PROFILES = 64

export type DeviceProfileProcessing = Pick<
  AudioProcessingSettings,
  | 'dspEnabled'
  | 'directMode'
  | 'dsdOutputMode'
  | 'dsdRatePolicy'
  | 'dsdRoute'
  | 'sacdProgramMode'
  | 'eqEnabled'
  | 'convolverEnabled'
  | 'crossfeedEnabled'
  | 'crossfeedStrength'
  | 'volumeNormalization'
>

export interface AudioDeviceProfile {
  version: 1
  id: string
  name: string
  stableDeviceId: string
  backend: AudioOutputId
  exclusiveMode: boolean
  outputConfig: OutputConfig
  volumeCeiling: number
  outputStage: DspOutputStageConfig
  processing: DeviceProfileProcessing
  dspSceneId: string | null
  autoApply: boolean
}

export interface AudioDeviceProfileSettings {
  version: 1
  profiles: AudioDeviceProfile[]
  activeProfileId: string | null
  volumeCeiling: number
  outputStageOverride: DspOutputStageConfig | null
}

export interface AudioDeviceProfilesSnapshot extends AudioDeviceProfileSettings {
  current: AudioDeviceProfile
  devices: AudioDeviceOption[]
  scenes: Array<{ id: string; name: string }>
  unavailable: Record<string, string>
  phase: 'idle' | 'applying' | 'applied' | 'failed'
  error: string
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}

export function stableAudioDeviceId(device: AudioDeviceOption): string {
  if (/^(auto|default|system)$/i.test(device.id)) return ''
  return device.platformStableId?.trim() || device.id
}

export function normalizeDeviceProfileProcessing(value: unknown): DeviceProfileProcessing {
  const raw = (value ?? {}) as Partial<DeviceProfileProcessing>
  return {
    dspEnabled: raw.dspEnabled === true && raw.directMode !== true,
    directMode: raw.directMode === true,
    eqEnabled: raw.eqEnabled === true,
    convolverEnabled: raw.convolverEnabled === true,
    crossfeedEnabled: raw.crossfeedEnabled === true,
    crossfeedStrength: volume(raw.crossfeedStrength, 0),
    volumeNormalization:
      raw.volumeNormalization === 'track' ||
      raw.volumeNormalization === 'album' ||
      raw.volumeNormalization === 'loudnorm'
        ? raw.volumeNormalization
        : 'off',
    dsdOutputMode: ['auto', 'native', 'dop', 'pcm'].includes(raw.dsdOutputMode ?? '')
      ? raw.dsdOutputMode!
      : 'auto',
    dsdRatePolicy:
      raw.dsdRatePolicy === 'downrate' || raw.dsdRatePolicy === 'exact'
        ? raw.dsdRatePolicy
        : 'pcm-fallback',
    dsdRoute: normalizeDsdRouteSettings(raw.dsdRoute),
    sacdProgramMode:
      raw.sacdProgramMode === 'stereo' || raw.sacdProgramMode === 'multichannel'
        ? raw.sacdProgramMode
        : 'auto'
  }
}

export function normalizeAudioDeviceProfile(value: unknown): AudioDeviceProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AudioDeviceProfile>
  const id = text(raw.id, 128)
  const name = text(raw.name, 100)
  const stableDeviceId = text(raw.stableDeviceId, 1024)
  if (
    raw.version !== 1 ||
    !id ||
    !name ||
    !stableDeviceId ||
    /^(auto|default|system)$/i.test(stableDeviceId)
  )
    return null
  if (!['wasapi', 'asio', 'coreaudio', 'alsa'].includes(raw.backend ?? '')) return null
  return {
    version: 1,
    id,
    name,
    stableDeviceId,
    backend: raw.backend!,
    exclusiveMode:
      (raw.backend === 'wasapi' || raw.backend === 'coreaudio') && raw.exclusiveMode === true,
    outputConfig: normalizeOutputConfig(raw.outputConfig),
    volumeCeiling: volume(raw.volumeCeiling, 0.7),
    outputStage: normalizeDspOutputStage(raw.outputStage),
    processing: normalizeDeviceProfileProcessing(raw.processing),
    dspSceneId: text(raw.dspSceneId, 128) || null,
    autoApply: raw.autoApply === true
  }
}

export function normalizeAudioDeviceProfileSettings(value?: unknown): AudioDeviceProfileSettings {
  const raw = (value ?? {}) as Partial<AudioDeviceProfileSettings>
  const profiles: AudioDeviceProfile[] = []
  const ids = new Set<string>()
  if (raw.version === 1 && Array.isArray(raw.profiles)) {
    for (const value of raw.profiles.slice(0, MAX_AUDIO_DEVICE_PROFILES)) {
      const profile = normalizeAudioDeviceProfile(value)
      if (!profile || ids.has(profile.id)) continue
      ids.add(profile.id)
      profiles.push(profile)
    }
  }
  return {
    version: 1,
    profiles,
    activeProfileId:
      typeof raw.activeProfileId === 'string' && ids.has(raw.activeProfileId)
        ? raw.activeProfileId
        : null,
    volumeCeiling: volume(raw.volumeCeiling, 1),
    outputStageOverride: raw.outputStageOverride
      ? normalizeDspOutputStage(raw.outputStageOverride)
      : null
  }
}

export function matchAudioDeviceProfile(
  profile: AudioDeviceProfile,
  devices: readonly AudioDeviceOption[]
): AudioDeviceOption[] {
  return deviceOptionsForOutput(profile.backend, devices).filter(
    (device) => stableAudioDeviceId(device) === profile.stableDeviceId
  )
}
