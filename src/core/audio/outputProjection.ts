import type { OutputInfo, OutputDiagnostics } from '../../shared/audioEngineTypes.ts'
import { projectCoreError } from '../projections.ts'

const fields = [
  'exclusive', 'outputReleased', 'supportsOutputPerfect', 'sourceExact', 'outputPerfect', 'pcmPassthrough', 'resampled',
  'providerImplementation', 'perfectReason', 'outputSampleRate', 'outputBitDepth', 'outputChannels', 'outputSampleFormat',
  'backend', 'actualBackend', 'deviceName', 'actualDeviceName', 'actualDeviceId', 'driverName', 'actualDriverName', 'driverVersion',
  'actualDriverVersion', 'actualOutputFormat', 'actualSampleRate', 'actualBitDepth', 'actualChannels', 'accessMode', 'devicePathKind',
  'perfectReasonCode', 'capabilityReason', 'driverDopCapable', 'driverNativeDsdCapable', 'driverDopCarrierSampleRates',
  'driverDopCarrierFormats', 'driverNativeDsdSampleRates', 'nativeDsdRuntimeState', 'nativeDsdRequestedRate', 'nativeDsdActualRate',
  'nativeDsdChannels', 'nativeDsdExplicitlyCapable', 'nativeDsdAdvertisedSampleRates', 'nativeDsdRuntimeReason', 'bufferSizeFrames',
  'latencyFrames', 'latencyMs', 'channelRoutingMode', 'deviceRecovered', 'recoveryCount', 'isDsd', 'dsdMode', 'dsdRate',
  'actualDsdRate', 'dsdRatePolicy', 'dsdConversion', 'dsdConversionReason'
] as const satisfies readonly (keyof OutputInfo)[]
const diagnostics = [
  'decodeHealthAvailable', 'decodeStreamToken', 'decodeRunning', 'decodeEof', 'decodeStopRequested', 'decodeBufferedFrames',
  'decodeProducedFrames', 'decodeLastProgressAgeMs', 'decodeStage', 'liveRenderState', 'liveRenderedFrames', 'liveRenderCallbackCount',
  'sessionUnderrunCount', 'asioHelperCallbackCount', 'asioHelperUnderrunCount', 'asioHelperBufferDropCount', 'sessionBufferDropCount',
  'sessionRecoveryCount', 'lifetimeUnderrunCount', 'lifetimeBufferDropCount', 'lifetimeRecoveryCount', 'driverRestartCount', 'deviceLostCount',
  'driverXrunCount', 'dsdIdleFrameCount', 'dsdShortReadCount', 'dsdTransport', 'dsdSourceBitOrder', 'dsdSourcePacking', 'requestedWireFormat',
  'wireLittleEndian', 'dopRuntimeEvidence', 'quirkRegistryState', 'quirkFingerprint', 'quirkApplied', 'dsdMuteState', 'dsdMuteTransition',
  'dsdMutePreRollFrames', 'dsdMutePostRollFrames', 'dsdMuteTimeoutFrames', 'dsdMuteFallback', 'firstBufferSummary', 'processArchitecture',
  'asioBuildEnabled', 'asioEnvironmentDisabled', 'asioRegisteredDriverCount32', 'asioRegisteredDriverCount64', 'asioLoadableDriverCount64', 'asioLoadableDriverCount32', 'asioHelperArchitecture',
  'dsdRouteOverrideActive', 'dsdRouteBackend', 'dsdRouteDevice', 'dsdRouteFallbackReason', 'lastError'
] as const satisfies readonly (keyof OutputDiagnostics)[]

const scalar = (value: unknown): unknown => typeof value === 'string' ? projectCoreError(value) : value
/** Diagnostics are queried separately from player state. Native plugin graphs,
 * paths and extension payloads never hitchhike on this display projection. */
export function projectCoreOutput(info: OutputInfo): Omit<OutputInfo, 'nativeDsp'> {
  const result = Object.fromEntries(fields.map((key) => [key, Array.isArray(info[key])
    ? (info[key] as unknown[]).slice(0, 256).map(scalar) : scalar(info[key])])) as Pick<OutputInfo, typeof fields[number]>
  return {
    ...result,
    conversionInfo: {
      sampleFormatConverted: info.conversionInfo.sampleFormatConverted,
      sampleRateConverted: info.conversionInfo.sampleRateConverted,
      channelLayoutConverted: info.conversionInfo.channelLayoutConverted,
      source: info.conversionInfo.source
    },
    latencyInfo: { bufferLatencyMs: info.latencyInfo.bufferLatencyMs, outputLatencyMs: info.latencyInfo.outputLatencyMs, totalLatencyMs: info.latencyInfo.totalLatencyMs },
    diagnostics: Object.fromEntries(diagnostics.map((key) => [key, scalar(info.diagnostics[key])])) as unknown as OutputDiagnostics
  }
}
