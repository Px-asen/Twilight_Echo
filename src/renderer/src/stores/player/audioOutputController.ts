import type { Ref } from 'vue'
import type {
  AudioOutputId,
  AudioProcessingSettings,
  OutputConfig,
  OutputConfigApplyStatus
} from '../../types/settings'
import {
  extractStereoImageFromGraph,
  mergeDspOutputStage,
  mergeDspStereoImage,
  type DspOutputStageConfig,
  type DspStereoImageConfig
} from '../../../../shared/dspGraph.ts'
import { cloneAudioProcessingSettings } from '../../utils/playerAudioSettings.ts'

type AudioEngineApi = typeof window.api.audioEngine
export type NativeOutputState = Awaited<ReturnType<AudioEngineApi['setAudioOutput']>>

export interface AudioOutputControllerOptions {
  exclusiveMode: Ref<boolean>
  audioProcessing: Ref<AudioProcessingSettings>
  audioOutputConfig: Ref<OutputConfig>
  audioOutputConfigApplyStatus: Ref<OutputConfigApplyStatus>
  dspOutputStage: Ref<DspOutputStageConfig>
  dspStereoImage: Ref<DspStereoImageConfig>
  getAudioEngineApi: () => AudioEngineApi
  applyAudioOutputState: (state: NativeOutputState) => void
  setAudioEngineError: (error: string | null) => void
  scheduleCrossfadeIfNeeded: () => void
  refreshPlaybackInfo: () => Promise<void>
  persistAudioProcessingFallback: (
    nextSettings: AudioProcessingSettings,
    reason: unknown
  ) => Promise<void>
}

export function createAudioOutputController(options: AudioOutputControllerOptions) {
  const { exclusiveMode, audioProcessing, audioOutputConfig, audioOutputConfigApplyStatus } =
    options
  const { dspOutputStage, dspStereoImage } = options

  function mergeAudioProcessingPatch(
    patch: Partial<AudioProcessingSettings>
  ): AudioProcessingSettings {
    return cloneAudioProcessingSettings({
      ...audioProcessing.value,
      ...patch,
      eqBands: patch.eqBands ?? audioProcessing.value.eqBands
    })
  }

  async function refreshSceneGraphState(): Promise<void> {
    const sceneState = await options.getAudioEngineApi().getDspSceneState()
    const defaultScene = sceneState?.scenes?.find((scene) => scene.id === 'default')
    const graph = sceneState?.graph ?? defaultScene?.graph
    if (graph?.outputStage) {
      dspOutputStage.value = mergeDspOutputStage(graph.outputStage, {})
    }
    if (graph) {
      dspStereoImage.value = extractStereoImageFromGraph(graph)
    }
  }

  async function toggleExclusiveMode(): Promise<void> {
    const next = !exclusiveMode.value
    try {
      options.applyAudioOutputState(await options.getAudioEngineApi().setExclusiveMode(next))
    } catch (err) {
      options.setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to toggle exclusive mode:', err)
    }
  }

  async function setAudioOutput(output: AudioOutputId, device?: string): Promise<void> {
    try {
      options.applyAudioOutputState(
        await options.getAudioEngineApi().setAudioOutput(output, device)
      )
    } catch (err) {
      options.setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to switch audio output:', err)
    }
  }

  async function setAudioDevice(device: string): Promise<void> {
    try {
      options.applyAudioOutputState(await options.getAudioEngineApi().setAudioDevice(device))
    } catch (err) {
      options.setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to switch audio device:', err)
    }
  }

  async function setAudioOutputConfig(config: Partial<OutputConfig>): Promise<void> {
    if (audioOutputConfigApplyStatus.value.state === 'pending') return
    const api = options.getAudioEngineApi()
    audioOutputConfigApplyStatus.value = {
      ...audioOutputConfigApplyStatus.value,
      requestedRevision: audioOutputConfigApplyStatus.value.requestedRevision + 1,
      state: 'pending',
      error: ''
    }
    try {
      audioOutputConfig.value = await api.setOutputConfig({
        ...audioOutputConfig.value,
        ...config
      })
      audioOutputConfigApplyStatus.value = await api.getOutputConfigApplyStatus()
      await options.refreshPlaybackInfo()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      options.setAudioEngineError(errorMessage)
      audioOutputConfigApplyStatus.value = {
        ...audioOutputConfigApplyStatus.value,
        failedRevision: audioOutputConfigApplyStatus.value.requestedRevision,
        state: 'failed',
        error: errorMessage
      }
      console.error('[音频引擎] 更新输出配置失败:', err)
    }
  }

  async function setAudioProcessing(settings: Partial<AudioProcessingSettings>): Promise<void> {
    const api = options.getAudioEngineApi()
    const nextSettings = mergeAudioProcessingPatch(settings)
    const previousSettings = cloneAudioProcessingSettings(audioProcessing.value)
    try {
      audioProcessing.value = cloneAudioProcessingSettings(
        await api.setAudioProcessing(nextSettings)
      )
      // Classic processing rewrites the default graph but must keep sample-rate lock;
      // re-sync output stage from scene state after apply.
      try {
        await refreshSceneGraphState()
      } catch {
        // Scene state is optional for older bridges; processing still applied.
      }
      await options.refreshPlaybackInfo()
      options.scheduleCrossfadeIfNeeded()
    } catch (err) {
      audioProcessing.value = previousSettings
      options.setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[audio-engine] Failed to update audio processing settings:', err)
    }
  }

  /**
   * Replace the renderer-side audio processing snapshot without touching the
   * engine. The equalizer page must use this instead of reassigning a
   * storeToRefs value, which would detach the DSP store from this store's
   * live ref and freeze the EQ UI while the engine still processes changes.
   */
  function applyAudioProcessingState(processing: AudioProcessingSettings): void {
    audioProcessing.value = cloneAudioProcessingSettings(processing)
  }

  /**
   * Patch default-scene graph.outputStage (sample-rate lock / resampler / dither).
   * Does not invent OutputConfig fields — rate lock lives only on the DSP graph.
   */
  async function setOutputStage(partial: Partial<DspOutputStageConfig>): Promise<void> {
    const api = options.getAudioEngineApi()
    const next = mergeDspOutputStage(dspOutputStage.value, partial)
    dspOutputStage.value = next
    try {
      const state = await api.setOutputStage(partial)
      const defaultScene = state?.scenes?.find((scene) => scene.id === 'default')
      if (state?.graph?.outputStage) {
        dspOutputStage.value = mergeDspOutputStage(state.graph.outputStage, {})
      } else if (defaultScene?.graph?.outputStage) {
        dspOutputStage.value = mergeDspOutputStage(defaultScene.graph.outputStage, {})
      }
      await options.refreshPlaybackInfo()
    } catch (err) {
      options.setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[音频引擎] 更新输出采样率锁失败:', err)
      try {
        await refreshSceneGraphState()
      } catch {
        // keep optimistic value if scene state is unavailable
      }
    }
  }

  /**
   * Patch default-scene stereoField balance/width + channelStrip polarity.
   * Graph-only; not classic audioProcessing fields.
   */
  async function setStereoImage(partial: Partial<DspStereoImageConfig>): Promise<void> {
    const api = options.getAudioEngineApi()
    dspStereoImage.value = mergeDspStereoImage(dspStereoImage.value, partial)
    try {
      const state = await api.setStereoImage(partial)
      const defaultScene = state?.scenes?.find((scene) => scene.id === 'default')
      const graph = defaultScene?.graph ?? state?.graph
      if (graph) {
        dspStereoImage.value = extractStereoImageFromGraph(graph)
      }
      await options.refreshPlaybackInfo()
    } catch (err) {
      options.setAudioEngineError(err instanceof Error ? err.message : String(err))
      console.error('[音频引擎] 更新平衡/相位失败:', err)
      try {
        await refreshSceneGraphState()
      } catch {
        // keep optimistic value
      }
    }
  }

  async function toggleDspEnabled(): Promise<void> {
    await setAudioProcessing({ dspEnabled: !audioProcessing.value.dspEnabled })
  }

  async function toggleEqEnabled(): Promise<void> {
    await setAudioProcessing({ eqEnabled: !audioProcessing.value.eqEnabled })
  }

  async function toggleCrossfeed(): Promise<void> {
    await setAudioProcessing({
      crossfeedEnabled: !audioProcessing.value.crossfeedEnabled,
      crossfeedStrength:
        !audioProcessing.value.crossfeedEnabled && audioProcessing.value.crossfeedStrength <= 0
          ? 0.35
          : audioProcessing.value.crossfeedStrength
    })
  }

  async function toggleGapless(): Promise<void> {
    await setAudioProcessing({ gapless: !audioProcessing.value.gapless })
  }

  async function setReplayGainMode(
    mode: AudioProcessingSettings['volumeNormalization']
  ): Promise<void> {
    await setAudioProcessing({ volumeNormalization: mode })
  }

  async function setCrossfeedStrength(strength: number): Promise<void> {
    await setAudioProcessing({
      crossfeedEnabled: strength > 0,
      crossfeedStrength: Math.min(1, Math.max(0, strength))
    })
  }

  async function selectImpulseResponse(): Promise<void> {
    const api = options.getAudioEngineApi()
    try {
      const path = await api.selectImpulseResponse()
      if (!path) return
      const nextSettings = mergeAudioProcessingPatch({
        convolverEnabled: true,
        convolverIrPath: path
      })
      audioProcessing.value = nextSettings
      await api.loadImpulseResponse(path)
      audioProcessing.value = cloneAudioProcessingSettings(await api.getAudioProcessing())
      await options.refreshPlaybackInfo()
    } catch (err) {
      console.error('[音频引擎] 加载卷积脉冲响应失败:', err)
      await options.persistAudioProcessingFallback(audioProcessing.value, err)
    }
  }

  async function clearImpulseResponse(): Promise<void> {
    const api = options.getAudioEngineApi()
    const nextSettings = mergeAudioProcessingPatch({
      convolverEnabled: false,
      convolverIrPath: ''
    })
    audioProcessing.value = nextSettings
    try {
      await api.unloadImpulseResponse()
      audioProcessing.value = cloneAudioProcessingSettings(await api.getAudioProcessing())
      await options.refreshPlaybackInfo()
    } catch (err) {
      console.error('[音频引擎] 卸载卷积脉冲响应失败:', err)
      await options.persistAudioProcessingFallback(nextSettings, err)
    }
  }

  return {
    toggleExclusiveMode,
    setAudioOutput,
    setAudioDevice,
    setAudioOutputConfig,
    setAudioProcessing,
    applyAudioProcessingState,
    setOutputStage,
    setStereoImage,
    toggleDspEnabled,
    toggleEqEnabled,
    toggleCrossfeed,
    toggleGapless,
    setReplayGainMode,
    setCrossfeedStrength,
    selectImpulseResponse,
    clearImpulseResponse
  }
}
