import { computed } from 'vue'
import type { CorePlayerClient } from './corePlayerTypes.ts'
import { createCorePlayerResource } from './corePlayerResource.ts'
import type {
  AudioOutputId,
  AudioProcessingSettings,
  OutputConfig
} from '../../../../shared/audioEngineTypes.ts'
import type { CoreAudioOutputEdit } from '../../../../shared/coreAudio.ts'
import type { CoreDspEdit } from '../../../../shared/coreDsp.ts'
import { deviceOptionsForOutput } from '../../../../shared/audioDeviceRouting.ts'
import {
  DEFAULT_DSP_OUTPUT_STAGE,
  DEFAULT_DSP_STEREO_IMAGE,
  extractStereoImageFromGraph,
  type DspOutputStageConfig,
  type DspStereoImageConfig
} from '../../../../shared/dspGraph.ts'

const emptyProcessing: AudioProcessingSettings = {
  dspEnabled: false,
  directMode: false,
  clipGuard: true,
  fftEnabled: true,
  fftResolution: 8192,
  highResolution: true,
  dsdToPcm: false,
  dsdOutputMode: 'auto',
  dsdRatePolicy: 'pcm-fallback',
  dsdRoute: {
    enabled: false,
    backend: '',
    device: '',
    applyToPcmToDsd: true,
    strictPassthrough: false
  },
  sacdProgramMode: 'auto',
  eqEnabled: false,
  eqMode: 'graphic',
  eqPreamp: 0,
  eqBands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency) => ({
    frequency,
    gain: 0,
    q: 1,
    filterType: 'peak'
  })),
  volumeNormalization: 'off',
  replayGainPreamp: 0,
  replayGainFallback: 0,
  replayGainClip: true,
  convolverEnabled: false,
  convolverIrPath: '',
  crossfeedEnabled: false,
  crossfeedStrength: 0,
  crossfeedDelayMs: 0.35,
  crossfeedCutoffHz: 700,
  gapless: true,
  crossfadeSeconds: 0
}
export function createCorePlayerAudio(core: CorePlayerClient, failed: (error: unknown) => void) {
  const key = () =>
    core.state.value?.settingsRevision == null
      ? ''
      : `${core.state.value.epoch}:${core.state.value.audioRevision}:${core.state.value.settingsRevision}`
  const output = createCorePlayerResource(
    key,
    (signal) => core.query('audio.output', {}, signal),
    failed
  )
  const dsp = createCorePlayerResource(key, (signal) => core.query('audio.dsp', {}, signal), failed)
  const dspStatus = createCorePlayerResource(
    key,
    (signal) => core.query('audio.dsp.status', {}, signal),
    failed
  )
  const diagnostics = createCorePlayerResource(
    () => {
      const state = core.state.value
      return state?.phase === 'ready'
        ? `${state.epoch}:${state.audioRevision}:${state.playback?.position}:${state.playback?.state}`
        : ''
    },
    (signal) => core.query('playback.diagnostics', {}, signal),
    failed
  )
  const audioProcessing = computed(() => dsp.value.value?.processing ?? emptyProcessing)
  const audioOutputConfig = computed(
    () =>
      output.value.value?.config ?? {
        preferredBufferSize: 0,
        routingMode: 'auto' as const,
        wasapiExclusivePushMode: false
      }
  )
  const audioOutputConfigApplyStatus = computed(
    () =>
      output.value.value?.applyStatus ?? {
        requestedRevision: 0,
        appliedRevision: 0,
        failedRevision: 0,
        state: 'idle' as const,
        error: '',
        generation: 0
      }
  )
  const exclusiveMode = computed(() => output.value.value?.output.exclusiveMode ?? false)
  const audioOutput = computed(() => output.value.value?.output.output ?? 'wasapi')
  const audioDevice = computed(() => output.value.value?.output.device ?? '')
  const audioOutputOptions = computed(() => output.value.value?.output.outputOptions ?? [])
  const audioDeviceOptions = computed(() => output.value.value?.output.deviceOptions ?? [])
  const audioOutputDeviceOptions = computed(() =>
    deviceOptionsForOutput(audioOutput.value, audioDeviceOptions.value)
  )
  const graph = computed(
    () =>
      dsp.value.value?.scenes.graph ??
      dsp.value.value?.scenes.scenes.find((scene) => scene.id === 'default')?.graph
  )
  const dspOutputStage = computed(() => graph.value?.outputStage ?? DEFAULT_DSP_OUTPUT_STAGE)
  const dspStereoImage = computed(() => {
    if (!graph.value) return DEFAULT_DSP_STEREO_IMAGE
    try {
      return extractStereoImageFromGraph(structuredClone(graph.value))
    } catch {
      return extractStereoImageFromGraph(JSON.parse(JSON.stringify(graph.value)))
    }
  })
  async function editOutput(edit: CoreAudioOutputEdit['edit']): Promise<void> {
    if (!output.value.value) await output.refresh()
    await core.command('audio.output.edit', { revision: output.value.value!.revision, edit })
    await output.refresh()
  }
  async function editDsp(edit: CoreDspEdit['edit']): Promise<void> {
    if (!dsp.value.value) await dsp.refresh()
    await core.command('audio.dsp.edit', { revision: dsp.value.value!.revision, edit })
    await dsp.refresh()
  }
  const setAudioProcessing = async (
    settings: Partial<AudioProcessingSettings>,
    _options?: { throwOnError?: boolean }
  ) => editDsp({ kind: 'processing', settings })
  return {
    audioProcessing,
    audioOutputConfig,
    audioOutputConfigApplyStatus,
    exclusiveMode,
    audioOutput,
    audioDevice,
    audioOutputOptions,
    audioDeviceOptions,
    audioOutputDeviceOptions,
    dspOutputStage,
    dspStereoImage,
    outputInfo: computed(() => diagnostics.value.value),
    dspGraphStatus: computed(() => dspStatus.value.value),
    refreshDspGraphStatus: dspStatus.refresh,
    refreshAudioOutputState: () => Promise.all([output.refresh(), dsp.refresh(), dspStatus.refresh(), diagnostics.refresh()]).then(() => {}),
    toggleExclusiveMode: () => editOutput({ kind: 'exclusive', enabled: !exclusiveMode.value }),
    setExclusiveAutoRelease: (enabled: boolean) => editOutput({ kind: 'autoRelease', enabled }),
    setAudioOutput: (output: AudioOutputId, device?: string) =>
      editOutput({ kind: 'backend', output, ...(device ? { device } : {}) }),
    setAudioDevice: (device: string) => editOutput({ kind: 'device', device }),
    setAudioOutputConfig: (config: Partial<OutputConfig>) => editOutput({ kind: 'config', config }),
    setAudioProcessing,
    // Legacy UI callback requests a fresh projection; it cannot publish authoritative settings.
    applyAudioProcessingState: (_settings: AudioProcessingSettings) => dsp.refresh(),
    setOutputStage: (settings: Partial<DspOutputStageConfig>) =>
      editDsp({ kind: 'outputStage', settings }),
    setStereoImage: (settings: Partial<DspStereoImageConfig>) =>
      editDsp({ kind: 'stereoImage', settings }),
    toggleDspEnabled: () => setAudioProcessing({ dspEnabled: !audioProcessing.value.dspEnabled }),
    toggleEqEnabled: () => setAudioProcessing({ eqEnabled: !audioProcessing.value.eqEnabled }),
    toggleCrossfeed: () =>
      setAudioProcessing({ crossfeedEnabled: !audioProcessing.value.crossfeedEnabled }),
    toggleGapless: () => setAudioProcessing({ gapless: !audioProcessing.value.gapless }),
    setReplayGainMode: (volumeNormalization: AudioProcessingSettings['volumeNormalization']) =>
      setAudioProcessing({ volumeNormalization }),
    setCrossfeedStrength: (crossfeedStrength: number) => setAudioProcessing({ crossfeedStrength }),
    clearImpulseResponse: () =>
      setAudioProcessing({ convolverEnabled: false, convolverIrPath: '' }),
    selectImpulseResponse: async () => {
      if (!dsp.value.value) await dsp.refresh()
      await core.command('audio.dsp.import', {
        revision: dsp.value.value!.revision,
        kind: 'impulsePath'
      })
      await dsp.refresh()
    }
  }
}
