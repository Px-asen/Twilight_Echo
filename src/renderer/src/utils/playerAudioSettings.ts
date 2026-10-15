import { DEFAULT_SOFTWARE_VOLUME } from '../../../shared/audioProcessingOptions.ts'
import type { AudioProcessingSettings } from '../types/settings.ts'

export function cloneAudioProcessingSettings<T extends AudioProcessingSettings>(settings: T): T {
  const legacy = settings as T & {
    autoMix?: { enabled: boolean; allowIntelligentSkip: boolean; maxTransitionSeconds: number }
  }
  return {
    ...settings,
    dsdRoute: { ...settings.dsdRoute },
    ...(legacy.autoMix ? { autoMix: { ...legacy.autoMix } } : {}),
    eqBands: settings.eqBands.map((band) => ({ ...band }))
  }
}

export function clampSoftwareVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SOFTWARE_VOLUME
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000))
}
