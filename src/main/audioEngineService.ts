import { createServicePort } from './services/servicePort.ts'
import { initializeUtilityDiagnostics } from './diagnostics/utility.ts'
import { observeDiagnosticOperation } from './diagnostics/observation.ts'
import { writeDiagnostic } from './diagnostics/logger.ts'
import { debugCaptureContext, onDebugCaptureChange } from './diagnostics/debugContext.ts'
import { recordNativeStartup } from './diagnostics/startupEvidence.ts'
import { summarizeDiagnosticArguments } from './diagnostics/sanitize.ts'
import type { DiagnosticContext } from '../shared/diagnostics.ts'
import {
  describeNativeBindingFailure,
  loadNativeBindingWithDiagnostics
} from './audio/nativeBinding.ts'
import type { NativeAudioBinding } from './audio/audioEngineTypes.ts'
import { AudioBridgeRuntime, type BridgeHostOptions } from './audio/bridgeRuntime.ts'
import type { BridgePeer } from '../shared/audioBridge.ts'
import {
  createAudioServiceCapabilities,
  REQUIRED_AUDIO_SERVICE_DSP_METHODS,
  type AudioServiceCapabilities
} from '../shared/audioServiceContract.ts'

type AudioServiceRequest = {
  diagnosticContext?: DiagnosticContext
  kind: 'request'
  requestId: string
  method: string
  args: unknown[]
}

type AudioServiceMessage = AudioServiceRequest | { kind: 'ping'; requestId: string }

type AudioServiceResponse = {
  kind: 'response'
  requestId: string
  ok: boolean
  value?: unknown
  error?: string
}

function stopNativeAudioSafely(): boolean {
  if (!native) return false
  try {
    void bridgeRuntime?.close()
    native.Stop()
    const rawInfo = native.GetPlaybackInfo?.()
    const info = typeof rawInfo === 'string' ? JSON.parse(rawInfo) : rawInfo
    return info?.state === 'stopped'
  } catch {
    return false
  }
}

const servicePort = createServicePort<
  AudioServiceMessage,
  | AudioServiceResponse
  | { kind: 'pong'; requestId: string }
  | { kind: 'ready'; capabilities: AudioServiceCapabilities }
  | { kind: 'fatal'; error: string }
>({
  supervise: (raw, reply) => {
    const message = raw as { requestId: string }
    reply({
      kind: 'supervisor:audio-stopped',
      requestId: message.requestId,
      stopped: stopNativeAudioSafely()
    })
  },
  onClose: (source) => {
    stopNativeAudioSafely()
    if (source === 'parent') process.exit(0)
  }
})

process.once('SIGTERM', () => {
  stopNativeAudioSafely()
  process.exit(0)
})
process.once('disconnect', () => {
  stopNativeAudioSafely()
  process.exit(0)
})
process.once('exit', () => {
  stopNativeAudioSafely()
})
initializeUtilityDiagnostics('twilight-audio-engine')
const nativeLoad = loadNativeBindingWithDiagnostics()
const native = nativeLoad.binding
const configureNativeDiagnostics = () => {
  const context = debugCaptureContext()
  const set = (
    native as unknown as { SetDebugCapture?: (id: string, directory: string) => void } | null
  )?.SetDebugCapture
  if (set) set(context?.id ?? '', context?.directory ?? '')
  else if (context)
    writeDiagnostic(
      'audio.native',
      'debug-mode.unsupported',
      { reason: 'Native engine requires an update to support live debug capture' },
      'warn'
    )
}
configureNativeDiagnostics()
onDebugCaptureChange(configureNativeDiagnostics)
const bridgeRuntime = native ? new AudioBridgeRuntime(native) : null
const bridgeMethods: Partial<Record<string, (...args: any[]) => unknown>> = {
  BridgeStatus: () => bridgeRuntime!.state(),
  BridgeSourceTimeline: () => bridgeRuntime!.sourceTimeline(),
  BridgeBindAutoMix: (requestJson: string) => {
    if (!native?.BindBridgeAutoMixSelection) throw new Error('请更新原生引擎以绑定同步组 AutoMix')
    return native.BindBridgeAutoMixSelection(requestJson)
  },
  BridgeAutoMixMode: (mode: string) => {
    const setMode = (native as unknown as { SetBridgeAutoMixMode?: (mode: string) => unknown })
      .SetBridgeAutoMixMode
    if (!setMode) throw new Error('请更新原生引擎以设置同步组 AutoMix')
    return setMode(mode)
  },
  BridgeQueueControl: (owned: boolean, current = '', next = '') => {
    const control = (
      native as unknown as {
        SetBridgeQueueControl?: (owned: boolean, current: string, next: string) => unknown
      }
    ).SetBridgeQueueControl
    if (!control) throw new Error('请更新原生引擎以使用同步组连续播放')
    return control(owned, current, next)
  },
  BridgeHostStart: (options: BridgeHostOptions) => bridgeRuntime!.startHost(options),
  BridgeHostStop: () => bridgeRuntime!.stopHost(),
  BridgeConnect: (peer: BridgePeer) => bridgeRuntime!.connectPeer(peer),
  BridgeDisconnect: () => bridgeRuntime!.disconnectPeer(),
  BridgePrepareTimed: (adaptive = false, holdMedia = false) =>
    bridgeRuntime!.prepareTimedPlayback(adaptive, holdMedia),
  BridgeReleaseTimedMedia: (epoch: number) => bridgeRuntime!.releaseTimedMedia(epoch),
  BridgeArmTimed: (startAtCoreMs: number, mediaFrame = 0, synchronize = false) =>
    bridgeRuntime!.armTimedPlayback(startAtCoreMs, mediaFrame, synchronize),
  BridgeCancelTimed: () => bridgeRuntime!.cancelTimedPlayback(),
  BridgeSetTimedCorrection: (ppm: number) => bridgeRuntime!.setTimedCorrection(ppm),
  BridgeQuarantine: () => bridgeRuntime!.quarantine(),
  BridgeShutdown: () => bridgeRuntime!.close()
}
const nativeMethods = native
  ? Object.getOwnPropertyNames(native).filter(
      (method) => typeof native[method as keyof NativeAudioBinding] === 'function'
    )
  : []
const missingDspMethods = REQUIRED_AUDIO_SERVICE_DSP_METHODS.filter(
  (method) => typeof native?.[method] !== 'function'
)
const nativeContractError = !native
  ? describeNativeBindingFailure(nativeLoad)
  : missingDspMethods.length > 0
    ? `native audio binding is missing required DSP methods: ${missingDspMethods.join(', ')}`
    : ''

if (nativeContractError) {
  servicePort.postMessage({ kind: 'fatal', error: nativeContractError })
} else {
  servicePort.postMessage({
    kind: 'ready',
    capabilities: {
      ...createAudioServiceCapabilities([...nativeMethods, ...Object.keys(bridgeMethods)]),
      nativeRuntime: nativeLoad.runtime
    }
  })
}

servicePort.on('message', (message) => {
  if (message.kind === 'ping') {
    servicePort.postMessage({ kind: 'pong', requestId: message.requestId })
    return
  }
  if (message.kind !== 'request') return
  // Pairing credentials and TLS private keys stay off the diagnostics argument
  // stream. These are private process commands, not public remote RPC methods.
  if (Object.hasOwn(bridgeMethods, message.method)) {
    void handleRequest(message)
    return
  }
  void observeDiagnosticOperation(
    'audio.native',
    String(message.method),
    () => handleRequest(message),
    message.args,
    { ...message.diagnosticContext, requestId: message.requestId }
  )
})

const POLLED_NATIVE_METHODS =
  /^(?:Get(?:PlaybackInfo|VisualizationData|SpectrumData|DspGraphStatus|DspPluginStatus|ConvolverInfo|UpcomingTrack)|EnumerateDevices|BridgeStatus|BridgeSourceTimeline)$/

async function handleRequest(message: AudioServiceRequest): Promise<void> {
  if (!POLLED_NATIVE_METHODS.test(message.method))
    recordNativeStartup('native.request.start', {
      method: message.method,
      requestId: message.requestId,
      context: message.diagnosticContext,
      arguments: message.method.startsWith('Bridge')
        ? []
        : summarizeDiagnosticArguments(message.args, message.method)
    })
  if (!native || nativeContractError) {
    writeDiagnostic('audio.native', 'binding.unavailable', { error: nativeContractError }, 'error')
    post({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: nativeContractError || '未加载 twilight_audio_node.node'
    })
    return
  }
  try {
    ;(
      native as NativeAudioBinding & { SetDiagnosticContext?: (json: string) => void }
    ).SetDiagnosticContext?.(
      JSON.stringify({ ...message.diagnosticContext, requestId: message.requestId })
    )
    if (
      message.method === 'AnalyzeBpm' ||
      message.method === 'AnalyzeLoudness' ||
      message.method === 'AnalyzeAutoMix'
    ) {
      throw new Error(`${String(message.method)} must use the isolated audio analysis service`)
    }
    const bridgeMethod = bridgeMethods[message.method]
    const method = bridgeMethod ?? native[message.method as keyof NativeAudioBinding]
    if (typeof method !== 'function') {
      throw new Error(`原生音频服务不支持方法：${String(message.method)}`)
    }
    const args = bridgeMethod
      ? message.args
      : bridgeRuntime!.beforeCall(message.method, message.args)
    const value = await (method as (...args: unknown[]) => unknown)(...args)
    if (!POLLED_NATIVE_METHODS.test(message.method))
      recordNativeStartup('native.request.complete', {
        method: message.method,
        requestId: message.requestId
      })
    bridgeRuntime?.afterCall(message.method)
    post({ kind: 'response', requestId: message.requestId, ok: true, value })
  } catch (error) {
    try {
      bridgeRuntime?.callFailed(message.method)
    } catch {
      /* The original native failure remains authoritative. */
    }
    writeDiagnostic('audio.native', 'call.failed', { method: message.method, error }, 'error')
    post({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    ;(
      native as NativeAudioBinding & { SetDiagnosticContext?: (json: string) => void }
    ).SetDiagnosticContext?.('{}')
  }
}

function post(message: AudioServiceResponse): void {
  servicePort.postMessage(message)
}
