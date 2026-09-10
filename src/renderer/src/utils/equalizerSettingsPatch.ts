import type { AudioProcessingSettings } from '../../../shared/audioEngineTypes.ts'

export function mergeEqualizerPatch(
  current: AudioProcessingSettings,
  patch: Partial<AudioProcessingSettings>
): AudioProcessingSettings {
  const eqTouched =
    patch.eqEnabled === true ||
    (current.eqEnabled &&
      (patch.eqMode !== undefined || patch.eqPreamp !== undefined || patch.eqBands !== undefined))
  return {
    ...current,
    ...patch,
    dspEnabled: patch.dspEnabled ?? (current.dspEnabled || eqTouched),
    eqEnabled: patch.eqEnabled ?? current.eqEnabled
  }
}
