import { defineStore } from 'pinia'
import { usePlayerStore } from './usePlayerStore'

// Output routing and DSP controls are exposed independently from queue state.
// Forward the player store's refs directly so components that read them via
// storeToRefs retain the live two-way binding; wrapping these in computed()
// would re-create the refs at setup time and freeze consumers (equalizer page,
// settings panels, dashboards) while the engine keeps processing changes.
export const useAudioOutputDspStore = defineStore('audio-output-dsp', () => {
  const player = usePlayerStore()

  return {
    audioEngineReady: player.audioEngineReady,
    audioEngineError: player.audioEngineError,
    audioEngineRecoveryNotice: player.audioEngineRecoveryNotice,
    exclusiveMode: player.exclusiveMode,
    audioOutput: player.audioOutput,
    audioDevice: player.audioDevice,
    audioOutputOptions: player.audioOutputOptions,
    audioDeviceOptions: player.audioDeviceOptions,
    // Narrowed to the selected backend; the DSD route picker uses the merged list.
    audioOutputDeviceOptions: player.audioOutputDeviceOptions,
    audioProcessing: player.audioProcessing,
    audioOutputConfig: player.audioOutputConfig,
    audioOutputConfigApplyStatus: player.audioOutputConfigApplyStatus,
    dspOutputStage: player.dspOutputStage,
    dspGraphStatus: player.dspGraphStatus,
    dspStereoImage: player.dspStereoImage,
    playbackInfo: player.playbackInfo,
    outputInfo: player.outputInfo,
    loudnormStatus: player.loudnormStatus,
    loudnormStatusSource: player.loudnormStatusSource,
    toggleExclusiveMode: player.toggleExclusiveMode,
    setExclusiveAutoRelease: player.setExclusiveAutoRelease,
    setAudioOutput: player.setAudioOutput,
    setAudioDevice: player.setAudioDevice,
    setAudioOutputConfig: player.setAudioOutputConfig,
    refreshAudioOutputState: player.refreshAudioOutputState,
    dismissAudioEngineRecoveryNotice: player.dismissAudioEngineRecoveryNotice,
    setAudioProcessing: player.setAudioProcessing,
    applyAudioProcessingState: player.applyAudioProcessingState,
    setOutputStage: player.setOutputStage,
    setStereoImage: player.setStereoImage,
    toggleDspEnabled: player.toggleDspEnabled,
    toggleEqEnabled: player.toggleEqEnabled,
    toggleCrossfeed: player.toggleCrossfeed,
    toggleGapless: player.toggleGapless,
    setReplayGainMode: player.setReplayGainMode,
    setCrossfeedStrength: player.setCrossfeedStrength,
    selectImpulseResponse: player.selectImpulseResponse,
    clearImpulseResponse: player.clearImpulseResponse,
    clearBpmAnalysisFromPlaybackState: player.clearBpmAnalysisFromPlaybackState
  }
})
