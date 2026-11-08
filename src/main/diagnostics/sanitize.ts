import '../../adapters-node/index.ts'
import {
  sanitizeDiagnosticText as sanitizeText,
  sanitizeDiagnosticValue as sanitizeValue,
  summarizeDiagnosticArguments as summarizeArguments,
  type DiagnosticSanitizeOptions
} from '../../core/audio/diagnosticSanitize.ts'
import { debugCaptureContext } from './debugContext.ts'
export {
  diagnosticFingerprint,
  summarizeDiagnosticAddress
} from '../../core/audio/diagnosticSanitize.ts'
export type { DiagnosticSanitizeOptions }
export const sanitizeDiagnosticText = (value: string, options: DiagnosticSanitizeOptions = {}) =>
  sanitizeText(value, { preserveLocalPaths: Boolean(debugCaptureContext()), ...options })
export const sanitizeDiagnosticValue = (value: unknown, options: DiagnosticSanitizeOptions = {}) =>
  sanitizeValue(value, { preserveLocalPaths: Boolean(debugCaptureContext()), ...options })

export function summarizeDiagnosticArguments(args: unknown[], method = ''): unknown[] {
  if (!debugCaptureContext()) return summarizeArguments(args)
  const summary = summarizeArguments(args)
  // Select documented scalar fields. A known method never grants permission
  // to serialize its entire request, plugin state, or arbitrary extension data.
  const fields = (value: unknown, names: string[]) => {
    let input = value
    if (typeof input === 'string' && input.length <= 65536) {
      try {
        input = JSON.parse(input)
      } catch {
        return { invalidJson: true }
      }
    }
    const result: Record<string, unknown> = {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name)
      if (
        descriptor &&
        'value' in descriptor &&
        ['string', 'number', 'boolean'].includes(typeof descriptor.value)
      )
        result[name] = sanitizeDiagnosticValue(descriptor.value)
    }
    return result
  }
  if (
    /^(SetOutputBackend|SetOutputDevice|LoadImpulseResponse|ScanVst3Module|Play|GetMetadata|AnalyzeBpm|AnalyzeLoudness)$/.test(
      method
    )
  ) {
    if (typeof args[0] === 'string') summary[0] = sanitizeDiagnosticValue(args[0])
  } else if (method === 'SetOutputConfig') {
    summary[0] = fields(args[0], [
      'playbackPolicy',
      'continuitySampleRate',
      'preferredBufferSize',
      'asioOutputChannelStart',
      'routingMode',
      'wasapiExclusivePushMode',
      'pcmToDsdMode',
      'dsdMutePreRollFrames',
      'dsdMutePostRollFrames',
      'dsdMuteTimeoutFrames',
      'upmixCenterGain',
      'upmixLfeGain',
      'upmixLfeLowpassHz',
      'upmixSurroundGain',
      'upmixSideGain',
      'upmixSurroundDelayMs'
    ])
  } else if (method === 'ApplyDspState') {
    summary[1] = fields(args[1], [
      'revision',
      'sceneId',
      'graphUpdateMode',
      'bypassReason',
      'requiresPcmFallback',
      'dsdPcmFallbackApplied'
    ])
  } else if (method === 'SetDspGraph') {
    summary[0] = fields(args[0], ['version'])
  }
  return summary
}
