import { createServicePort } from './services/servicePort.ts'
import { initializeUtilityDiagnostics } from './diagnostics/utility.ts'
import { observeDiagnosticOperation } from './diagnostics/observation.ts'
import { writeDiagnostic } from './diagnostics/logger.ts'
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
const bridgeRuntime = native ? new AudioBridgeRuntime(native) : null
const bridgeMethods: Partial<Record<string, (...args: any[]) => unknown>> = {
  BridgeStatus: () => bridgeRuntime!.state(),
  BridgeHostStart: (options: BridgeHostOptions) => bridgeRuntime!.startHost(options),
  BridgeHostStop: () => bridgeRuntime!.stopHost(),
  BridgeConnect: (peer: BridgePeer) => bridgeRuntime!.connectPeer(peer),
  BridgeDisconnect: () => bridgeRuntime!.disconnectPeer(),
  BridgePrepareTimed: (adaptive = false) => bridgeRuntime!.prepareTimedPlayback(adaptive),
  BridgeArmTimed: (startAtCoreMs: number, mediaFrame = 0, synchronize = false) => bridgeRuntime!.armTimedPlayback(startAtCoreMs, mediaFrame, synchronize),
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
  if (Object.hasOwn(bridgeMethods, message.method)) { void handleRequest(message); return }
  void observeDiagnosticOperation(
    'audio.native',
    String(message.method),
    () => handleRequest(message),
    message.args,
    { ...message.diagnosticContext, requestId: message.requestId }
  )
})

async function handleRequest(message: AudioServiceRequest): Promise<void> {
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
    const args = bridgeMethod ? message.args : bridgeRuntime!.beforeCall(message.method, message.args)
    const value = await (method as (...args: unknown[]) => unknown)(...args)
    post({ kind: 'response', requestId: message.requestId, ok: true, value })
  } catch (error) {
    try { bridgeRuntime?.callFailed(message.method) } catch { /* The original native failure remains authoritative. */ }
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
