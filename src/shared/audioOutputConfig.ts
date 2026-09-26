import type { ChannelRoutingMode, OutputConfig } from './audioEngineTypes.ts'

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

export function normalizeChannelRoutingMode(value: unknown): ChannelRoutingMode {
  return value === 'stereo' ||
    value === 'stereo-to-5.1' ||
    value === 'stereo-to-7.1' ||
    value === 'mono-to-stereo' ||
    value === 'mono-to-multichannel'
    ? value
    : 'auto'
}

export function normalizePcmToDsdMode(value: unknown): NonNullable<OutputConfig['pcmToDsdMode']> {
  return value === 'dsd64' || value === 'dsd128' || value === 'dsd256' ? value : 'off'
}

export function normalizeOutputConfig(config?: Partial<OutputConfig>): OutputConfig {
  return {
    ...normalizeContinuityOutputConfig(config ?? {}),
    preferredBufferSize: Number.isFinite(config?.preferredBufferSize)
      ? clampNumber(Math.trunc(config?.preferredBufferSize ?? 0), 0, 2048, 0)
      : 0,
    routingMode: normalizeChannelRoutingMode(config?.routingMode),
    wasapiExclusivePushMode: config?.wasapiExclusivePushMode === true,
    pcmToDsdMode: normalizePcmToDsdMode(config?.pcmToDsdMode),
    dsdMutePreRollFrames: clampNumber(config?.dsdMutePreRollFrames, 0, 4096, 256),
    dsdMutePostRollFrames: clampNumber(config?.dsdMutePostRollFrames, 0, 4096, 256),
    dsdMuteTimeoutFrames: clampNumber(config?.dsdMuteTimeoutFrames, 1, 4096, 4096),
    upmixCenterGain: clampNumber(config?.upmixCenterGain, 0, 2, 0.7071),
    upmixLfeGain: clampNumber(config?.upmixLfeGain, 0, 2, 0.5),
    upmixLfeLowpassHz: clampNumber(config?.upmixLfeLowpassHz, 20, 500, 120),
    upmixSurroundGain: clampNumber(config?.upmixSurroundGain, 0, 2, 0.5),
    upmixSideGain: clampNumber(config?.upmixSideGain, 0, 2, 0.3),
    upmixSurroundDelayMs: clampNumber(config?.upmixSurroundDelayMs, 0, 100, 0)
  }
}

export function normalizeContinuityOutputConfig(value: {
  playbackPolicy?: unknown
  continuitySampleRate?: unknown
}): Pick<OutputConfig, 'playbackPolicy' | 'continuitySampleRate'> {
  return {
    playbackPolicy:
      value.playbackPolicy === 'continuity-first' ? 'continuity-first' : 'bit-perfect-first',
    continuitySampleRate:
      value.continuitySampleRate === 44100 || value.continuitySampleRate === 96000
        ? value.continuitySampleRate
        : 48000
  }
}
