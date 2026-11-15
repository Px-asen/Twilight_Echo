import type { AudioDeviceProfile, AudioDeviceProfilesSnapshot } from './audioDeviceProfiles.ts'
import { normalizeAudioDeviceProfile } from './audioDeviceProfiles.ts'
import type {
  AudioOutputId,
  AudioOutputState,
  OutputConfig,
  OutputConfigApplyStatus
} from './audioEngineTypes.ts'

export interface AudioOutputFallbackNotice {
  id: number
  fromOutput: AudioOutputId
  fromDevice: string
  toOutput: AudioOutputId
  toDevice: string
  reason: string
}

export interface CoreAudioOutput {
  revision: number
  output: AudioOutputState
  config: OutputConfig
  applyStatus: OutputConfigApplyStatus
  exclusiveAutoRelease: boolean
  fallbackNotice?: AudioOutputFallbackNotice | null
}
export interface CoreOutputTestState {
  revision: number
  active: boolean
}
export interface CoreAudioProfiles {
  revision: number
  profiles: AudioDeviceProfilesSnapshot
}
export interface CoreAudioOutputEdit {
  revision: number
  edit:
    | { kind: 'backend'; output: AudioOutputId; device?: string }
    | { kind: 'device'; device: string }
    | { kind: 'exclusive'; enabled: boolean }
    | { kind: 'autoRelease'; enabled: boolean }
    | { kind: 'config'; config: Partial<OutputConfig> }
}
export interface CoreAudioProfileEdit {
  revision: number
  edit: { kind: 'save'; profile: AudioDeviceProfile } | { kind: 'remove' | 'apply'; id: string }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((key) => names.includes(key))
const text = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  !value.includes('\0')
const CONFIG_FIELDS: Record<keyof OutputConfig, true> = {
  playbackPolicy: true,
  continuitySampleRate: true,
  asioOutputChannelStart: true,
  preferredBufferSize: true,
  routingMode: true,
  wasapiExclusivePushMode: true,
  pcmToDsdMode: true,
  dsdMutePreRollFrames: true,
  dsdMutePostRollFrames: true,
  dsdMuteTimeoutFrames: true,
  upmixCenterGain: true,
  upmixLfeGain: true,
  upmixLfeLowpassHz: true,
  upmixSurroundGain: true,
  upmixSideGain: true,
  upmixSurroundDelayMs: true
}

/** Called after the common finite-JSON/byte-budget check. No paths or native method names. */
export function validCoreAudioPayload(name: string, value: Record<string, unknown>): boolean {
  if (name === 'audio.outputTest' || name === 'audio.outputTest.stop') return keys(value, [])
  if (name === 'audio.outputTest.play')
    return (
      keys(value, ['revision', 'exclusive']) &&
      Number.isSafeInteger(value.revision) &&
      Number(value.revision) >= 0 &&
      typeof value.exclusive === 'boolean'
    )
  if (name === 'audio.output' || name === 'audio.profiles') return keys(value, [])
  if (
    !keys(value, ['revision', 'edit']) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !record(value.edit)
  )
    return false
  const edit = value.edit
  if (name === 'audio.profiles.edit') {
    if (edit.kind === 'remove' || edit.kind === 'apply')
      return keys(edit, ['kind', 'id']) && text(edit.id, 128)
    return (
      edit.kind === 'save' &&
      keys(edit, ['kind', 'profile']) &&
      record(edit.profile) &&
      keys(edit.profile, [
        'version',
        'id',
        'name',
        'stableDeviceId',
        'backend',
        'exclusiveMode',
        'outputConfig',
        'volumeCeiling',
        'outputStage',
        'processing',
        'dspSceneId',
        'autoApply'
      ]) &&
      text(edit.profile.id, 128) &&
      text(edit.profile.name, 100) &&
      text(edit.profile.stableDeviceId, 1024) &&
      typeof edit.profile.volumeCeiling === 'number' &&
      edit.profile.volumeCeiling >= 0 &&
      edit.profile.volumeCeiling <= 1 &&
      !!normalizeAudioDeviceProfile(edit.profile)
    )
  }
  switch (edit.kind) {
    case 'backend':
      return (
        keys(edit, ['kind', 'output', 'device']) &&
        ['wasapi', 'asio', 'coreaudio', 'alsa'].includes(String(edit.output)) &&
        (edit.device === undefined || text(edit.device, 512))
      )
    case 'device':
      return keys(edit, ['kind', 'device']) && text(edit.device, 512)
    case 'exclusive':
    case 'autoRelease':
      return keys(edit, ['kind', 'enabled']) && typeof edit.enabled === 'boolean'
    case 'config':
      return (
        keys(edit, ['kind', 'config']) &&
        record(edit.config) &&
        Object.keys(edit.config).every((key) => Object.hasOwn(CONFIG_FIELDS, key)) &&
        Object.entries(edit.config).every(([key, v]) => {
          if (key === 'routingMode')
            return [
              'auto',
              'stereo',
              'stereo-to-5.1',
              'stereo-to-7.1',
              'mono-to-stereo',
              'mono-to-multichannel'
            ].includes(String(v))
          if (key === 'playbackPolicy') return v === 'bit-perfect-first' || v === 'continuity-first'
          if (key === 'continuitySampleRate') return v === 44100 || v === 48000 || v === 96000
          if (key === 'pcmToDsdMode')
            return ['off', 'dsd64', 'dsd128', 'dsd256'].includes(String(v))
          if (key === 'wasapiExclusivePushMode') return typeof v === 'boolean'
          return typeof v === 'number' && Number.isFinite(v)
        })
      )
    default:
      return false
  }
}
