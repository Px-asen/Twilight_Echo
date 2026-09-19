import { computed, ref, type Ref } from 'vue'
import type {
  AudioOutputId,
  AudioOutputOption,
  AudioDeviceOption,
  AudioProcessingSettings
} from '@renderer/types/settings'
import { deviceOptionsForOutput } from '../../../../shared/audioDeviceRouting.ts'
import {
  extractStereoImageFromGraph,
  mergeDspOutputStage,
  type DspOutputStageConfig,
  type DspStereoImageConfig
} from '../../../../shared/dspGraph.ts'
import {
  DEFAULT_AUDIO_DEVICE_OPTION,
  getFallbackAudioOutput,
  getFallbackAudioOutputOptions,
  normalizeAudioDeviceOptions,
  normalizeAudioOutputOptions
} from '@renderer/stores/player/audioOutputNormalize.ts'
type AudioOutputState = Awaited<ReturnType<typeof window.api.audioEngine.getAudioOutputState>>

export function createAudioOutputState(options: {
  audioProcessing: Ref<AudioProcessingSettings>
  dspOutputStage: Ref<DspOutputStageConfig>
  dspStereoImage: Ref<DspStereoImageConfig>
  audioEngineReady: Ref<boolean>
  setAudioEngineError: (message: string | null) => void
}) {
  const { audioProcessing, dspOutputStage, dspStereoImage, audioEngineReady, setAudioEngineError } =
    options
  const exclusiveMode = ref(false)
  const audioOutput = ref<AudioOutputId>(getFallbackAudioOutput())
  const audioDevice = ref('auto')
  const audioOutputOptions = ref<AudioOutputOption[]>(getFallbackAudioOutputOptions())
  const audioDeviceOptions = ref<AudioDeviceOption[]>([DEFAULT_AUDIO_DEVICE_OPTION])
  const audioOutputDeviceOptions = computed(() =>
    deviceOptionsForOutput(audioOutput.value, audioDeviceOptions.value)
  )

  function applyAudioOutputState(state: AudioOutputState): void {
    exclusiveMode.value = state.exclusiveMode
    audioOutput.value = state.output
    audioDevice.value = state.device
    audioOutputOptions.value = normalizeAudioOutputOptions(state.outputOptions, state.output)
    audioDeviceOptions.value = normalizeAudioDeviceOptions(
      state.deviceOptions,
      state.device,
      state.output
    )
  }

  let audioEngineStateRequest: Promise<void> | null = null
  let audioEngineStateRefreshQueued = false

  async function refreshAudioOutputState(): Promise<void> {
    if (audioEngineStateRequest) {
      audioEngineStateRefreshQueued = true
      return audioEngineStateRequest
    }
    const api = window.api?.audioEngine
    if (!api) return

    audioEngineStateRequest = (async () => {
      audioEngineStateRefreshQueued = false
      try {
        const [outputState, processingSettings, sceneState] = await Promise.all([
          api.getAudioOutputState(),
          api.getAudioProcessing(),
          api.getDspSceneState?.() ?? Promise.resolve(null)
        ])
        applyAudioOutputState(outputState)
        audioProcessing.value = processingSettings
        if (sceneState) {
          const defaultScene = sceneState.scenes?.find((scene) => scene.id === 'default')
          const graph = sceneState.graph ?? defaultScene?.graph
          if (graph?.outputStage) {
            dspOutputStage.value = mergeDspOutputStage(graph.outputStage, {})
          }
          if (graph) {
            dspStereoImage.value = extractStereoImageFromGraph(graph)
          }
        }
        audioEngineReady.value = true
        setAudioEngineError(null)
      } catch (err) {
        audioEngineReady.value = false
        console.warn('[audio-engine] Failed to refresh audio output state:', err)
      } finally {
        audioEngineStateRequest = null
      }
    })()

    await audioEngineStateRequest
    if (audioEngineStateRefreshQueued) {
      await refreshAudioOutputState()
    }
  }

  return {
    exclusiveMode,
    audioOutput,
    audioDevice,
    audioOutputOptions,
    audioDeviceOptions,
    audioOutputDeviceOptions,
    applyAudioOutputState,
    refreshAudioOutputState
  }
}
