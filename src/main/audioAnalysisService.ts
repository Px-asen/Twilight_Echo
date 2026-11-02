import { createServicePort } from './services/servicePort.ts'
import { initializeUtilityDiagnostics } from './diagnostics/utility.ts'
import { observeDiagnosticOperation } from './diagnostics/observation.ts'
import { writeDiagnostic } from './diagnostics/logger.ts'
import {
  AUDIO_ANALYSIS_PROTOCOL_VERSION,
  type AudioAnalysisWorkerMessage,
  type AudioAnalysisWorkerRequest
} from '../shared/audioAnalysisContract.ts'
import {
  describeNativeBindingFailure,
  loadNativeBindingWithDiagnostics
} from './audio/nativeBinding.ts'
import type { NativeAudioBinding } from './audio/audioEngineTypes.ts'
import { prepareDownloadedMetadata } from '../core/downloads/downloadMetadata.ts'
import type { DownloadMetadataRequest } from '../shared/coreDownloadMetadata.ts'
import { runLibraryTagWorker } from '../core/library/tagWorker.ts'
import type { LibraryTagWorkerRequest } from '../shared/coreLibraryMaintenance.ts'
import { contentHash } from './library/duplicateDetection.ts'
import type { CastPcmSegmentRequest } from '../shared/castPcmSegment.ts'

const servicePort = createServicePort<AudioAnalysisWorkerRequest, AudioAnalysisWorkerMessage>()
initializeUtilityDiagnostics('twilight-audio-analysis')
const nativeLoad = loadNativeBindingWithDiagnostics()
const native = nativeLoad.binding
const missingMethods = (['AnalyzeBpm', 'AnalyzeLoudness'] as const).filter(
  (method) => typeof native?.[method] !== 'function'
)
const startupError = !native
  ? describeNativeBindingFailure(nativeLoad)
  : missingMethods.length > 0
    ? `native audio analysis binding is missing methods: ${missingMethods.join(', ')}`
    : ''

servicePort.postMessage({
  kind: 'ready',
  protocolVersion: AUDIO_ANALYSIS_PROTOCOL_VERSION,
  analyses: [
    'download-metadata',
    'library-tags',
    'content-hash',
    ...(startupError
      ? []
      : ([
          'bpm',
          'loudness',
          'loudness-batch',
          'dsp-audition',
          ...(typeof native?.GetMetadata === 'function' ? ['metadata' as const] : []),
          ...(typeof native?.AnalyzeAutoMix === 'function' ? ['automix' as const] : []),
          ...(typeof native?.RenderPcmSegment === 'function' ? ['cast-pcm-segment' as const] : [])
        ] as const))
  ]
})

servicePort.on('message', (message) => {
  if (message.kind !== 'request') return
  observeDiagnosticOperation('audio.analysis', message.analysis, () => handleRequest(message), [], {
    requestId: message.requestId,
    ...(message as any).diagnosticContext
  })
})

async function handleRequest(message: AudioAnalysisWorkerRequest): Promise<void> {
  try {
    if (message.analysis === 'content-hash') {
      const value = await contentHash(message.source)
      servicePort.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
      return
    }
    if (message.analysis === 'library-tags') {
      const value = await runLibraryTagWorker(
        message.source,
        JSON.parse(message.optionsJson) as LibraryTagWorkerRequest
      )
      servicePort.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
      return
    }
    if (message.analysis === 'download-metadata') {
      const request = JSON.parse(message.optionsJson) as DownloadMetadataRequest
      const value = await prepareDownloadedMetadata({
        partPath: message.source,
        targetPath: request.targetPath,
        track: request.track,
        preferences: request.preferences,
        signal: new AbortController().signal,
        getLyrics: async () => {
          if (request.lyricFailure) throw new Error('Lyrics unavailable')
          return request.lyrics
        },
        fetchCover: async () => {
          if (request.coverFailure) throw new Error('Cover unavailable')
          return request.cover
            ? {
                bytes: new Uint8Array(Buffer.from(request.cover.base64, 'base64')),
                mime: request.cover.mime
              }
            : null
        }
      })
      servicePort.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
      return
    }
    if (!native || startupError)
      throw new Error(startupError || 'native audio analysis binding unavailable')
    if (message.analysis === 'cast-pcm-segment') {
      if (!native.RenderPcmSegment) throw new Error('Native CUE Cast renderer unavailable')
      const request = JSON.parse(message.optionsJson) as CastPcmSegmentRequest
      native.RenderPcmSegment(message.source, request.outputPath, request.startSeconds,
        request.endSeconds, request.virtualPregapSeconds)
      servicePort.postMessage({ kind: 'response', requestId: message.requestId, ok: true })
      return
    }
    const method: keyof NativeAudioBinding =
      message.analysis === 'metadata'
        ? 'GetMetadata'
        : message.analysis === 'bpm'
          ? 'AnalyzeBpm'
          : message.analysis === 'automix'
            ? 'AnalyzeAutoMix'
            : 'AnalyzeLoudness'
    const target = native[method]
    if (typeof target !== 'function') throw new Error(`native method unavailable: ${method}`)
    const value = (target as (source: string, optionsJson: string) => unknown)(
      message.source,
      message.optionsJson
    )
    servicePort.postMessage({ kind: 'response', requestId: message.requestId, ok: true, value })
  } catch (error) {
    writeDiagnostic(
      'audio.analysis',
      'analysis.failed',
      { error, analysis: message.analysis },
      'error'
    )
    servicePort.postMessage({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
